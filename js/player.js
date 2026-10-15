//js/player.js
import { MediaPlayer } from 'dashjs';
import {
    REPEAT_MODE,
    formatTime,
    getTrackArtists,
    getTrackTitle,
    getTrackArtistsHTML,
    getTrackYearDisplay,
    createQualityBadgeHTML,
    createFullscreenQualityHTML,
    escapeHtml,
    deriveTrackQuality,
    deriveQualityFromShakaVariant,
} from './utils.js';
import { isFirefox, isIos, isSafari } from './platform-detection.js';
import { SVG_CLOCK, SVG_ATMOS } from './icons.js';
import { showNotification } from './downloads.js';
import {
    queueManager,
    replayGainSettings,
    trackDateSettings,
    exponentialVolumeSettings,
    audioEffectsSettings,
    playbackBehaviorSettings,
    performanceModeSettings,
    audioProcessingSettings,
    recentActivityManager,
} from './storage.js';
import { audioContextManager } from './audio-context.js';
import { inspectStreamMetadata } from './stream-inspector.js';

function isHlsStreamUrl(streamUrl) {
    if (!streamUrl) return false;
    try {
        const pathname = new URL(streamUrl, window.location.href).pathname.toLowerCase();
        return pathname.endsWith('.m3u8') || (/\/dash(?:\/|$)/.test(pathname) && !pathname.endsWith('.mpd'));
    } catch {
        const normalized = String(streamUrl).toLowerCase();
        return normalized.includes('.m3u8') || /\/dash(?:\/|$)/.test(normalized);
    }
}

export class Player {
    constructor(audioElement, api, quality = 'HI_RES_LOSSLESS') {
        Player.instance = this;
        this.audio = audioElement;
        this.api = api;
        this.quality = quality;
        this.queue = [];
        this.shuffledQueue = [];
        this.originalQueueBeforeShuffle = [];
        this.currentQueueIndex = -1;
        this._howlerSound = null;
        this._howlerMonitorInterval = null;
        this._howlerBridgeTarget = null;
        this._howlerDurationHint = 0;
        this._howlerLastPosition = 0;
        this._howlerLastProgressAt = 0;
        this._howlerRecoveryAttempts = 0;
        this._queueNavigationInProgress = false; // prevent fast consecutive skip calls from jumping ahead
        this.shuffleActive = false;
        this.repeatMode = REPEAT_MODE.OFF;
        this.preloadCache = new Map();
        this.preloadAbortController = null;
        this._streamUrlInflight = new Map();
        this._prefetchInflight = new Map();
        this._currentTrackWarmupAbortController = null;
        this._backgroundPreloadTimer = null;
        this._nextStreamResolution = null;
        this.currentTrack = null;
        this.currentRgValues = null;
        this.userVolume = 1; // Always full volume
        this.video = document.getElementById('video-player');
        this.isFallbackRetry = false;
        this._playbackMonitorTimer = null;
        this._gaplessTransitionInProgress = false;
        this._advanceInFlight = false;
        this._advanceLockTimer = null;
        this._transitionState = 'idle';
        this._preloadFailureCounts = new Map();
        this._streamLoadRetries = new Map();
        this._atmosUnsupportedInBrowser = false;
        this._atmosSupportChecked = false;
        this._atmosSupported = false;

        // Sleep timer properties
        this.sleepTimer = null;
        this.sleepTimerEndTime = null;
        this.sleepTimerInterval = null;

        this.shakaInitialized = false;
        this.shakaPlayer = null;
        this.hlsInitialized = false;
        this.hlsPlayer = null;

        // Initialize dash.js player for better DASH streaming
        this.dashPlayer = MediaPlayer().create();
        this.dashPlayer.updateSettings({
            streaming: {
                buffer: {
                    fastSwitchEnabled: true,
                },
                // Manifest/segment requests travel through the CORS proxy chain
                // on hosted deploys, which is slower than a direct CDN hit —
                // give them a generous timeout and several retries so a slow
                // or flaky proxy doesn't kill high-quality playback.
                fragmentRequestTimeout: 20000,
                manifestRequestTimeout: 20000,
                retryAttempts: {
                    MPD: 3,
                    MediaSegment: 5,
                    InitializationSegment: 5,
                    XLinkExpansion: 3,
                },
            },
        });
        this.dashInitialized = false;

        this._titleMarqueeResizeRaf = null;
        this._titleMarqueeTickerRaf = null;

        this.loadQueueState();
        this.setupMediaSession();

        window.addEventListener('beforeunload', () => {
            this.saveQueueState();
        });

        window.addEventListener('resize', () => {
            if (this._titleMarqueeResizeRaf) {
                cancelAnimationFrame(this._titleMarqueeResizeRaf);
            }

            this._titleMarqueeResizeRaf = requestAnimationFrame(() => {
                this._titleMarqueeResizeRaf = null;
                this._updateNowPlayingTitleMarquee();
            });
        });

        // Handle visibility change - AudioContext can get suspended when tab is hidden
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                if (!this.audio.paused || this._wasPlayingBeforeHidden) {
                    // Ensure audio context is resumed when user returns to the app
                    if (!audioContextManager.isReady()) {
                        audioContextManager.init(this.audio);
                    }
                    audioContextManager.resume();

                    // Restart playback monitor in case it was throttled
                    if (!this.audio.paused) {
                        this.stopPlaybackMonitor();
                        this.startPlaybackMonitor();
                    }
                }
            }
        });

        // Set up initial audio event listeners
        this._setupAudioEventListeners();
    }

    get activeElement() {
        return this.currentTrack?.type === 'video' ? this.video : this.audio;
    }

    async init() {
        // Apply audio effects when track is ready
        this.audio.addEventListener('canplay', () => {
            this.applyAudioEffects();
        });
        if (this.video) {
            this.video.addEventListener('canplay', () => {
                this.applyAudioEffects();
            });
        }

        // Initialize Shaka player
        const shaka = await import('shaka-player');
        shaka.polyfill.installAll();
        if (shaka.Player.isBrowserSupported()) {
            this.shakaPlayer = new shaka.Player();
            await this.shakaPlayer.attach(this.audio);
            this.shakaPlayer.configure({
                streaming: {
                    // The addon HLS segments travel through a CORS relay on
                    // hosted builds. Keep a deep safety buffer so a slow
                    // segment response does not become an audible dropout.
                    bufferingGoal: 60,
                    rebufferingGoal: 10,
                    bufferBehind: 60,
                    retryParameters: {
                        timeout: 20000,
                        stallTimeout: 5000,
                        maxAttempts: 5,
                        baseDelay: 250,
                        backoffFactor: 1.5,
                        fuzzFactor: 0.5,
                    },
                    gapDetectionThreshold: 0.5,
                    gapJumpTimerTime: 0.5,
                    stallEnabled: true,
                    stallThreshold: 0.5,
                    stallSkip: 0,
                },
                abr: {
                    enabled: true,
                    defaultBandwidthEstimate: 100000,
                    switchInterval: 1,
                    bandwidthDowngradeTarget: 0.8,
                    restrictToElementSize: false,
                },
                mediaSource: {
                    codecSwitchingStrategy: 'smooth',
                },
            });

            this.shakaPlayer.addEventListener('adaptation', this.updateAdaptiveQualityBadge.bind(this));
            this.shakaPlayer.addEventListener('variantchanged', this.updateAdaptiveQualityBadge.bind(this));

            this.shakaInitialized = false;

            // Monitor and bridge different codec groups (e.g. AAC to FLAC)
            setInterval(this.evaluateCrossCodecAbr.bind(this), 3000);
        } else {
            console.error('Browser not supported for Shaka Player');
        }

        this.loadQueueState();
        this.setupMediaSession();
    }

    async _loadWithHls(streamUrl, startTime = 0) {
        const module = await import('hls.js');
        const Hls = module.default || module;

        if (this.hlsPlayer) {
            this.hlsPlayer.destroy();
            this.hlsPlayer = null;
            this.hlsInitialized = false;
        }

        // Safari/iOS can play HLS natively. Other browsers use hls.js/MSE.
        if (!Hls.isSupported()) {
            if (this.audio.canPlayType('application/vnd.apple.mpegurl')) {
                this.audio.src = streamUrl;
                this.audio.load();
                await this.audio.play();
                if (startTime > 0) this.audio.currentTime = startTime;
                return;
            }
            throw new Error('HLS is not supported by this browser');
        }

        const hls = new Hls({
            // Firefox can expose MSE while failing to infer the codec from an
            // audio-only fMP4 init segment. The reference addon serves FLAC
            // HLS without a CODECS attribute, so provide the codec explicitly.
            // Running the remuxer on the main thread also avoids Firefox
            // worker/MediaSource timing issues with high sample-rate FLAC.
            defaultAudioCodec: 'flac',
            enableWorker: false,
            autoStartLoad: true,
            startFragPrefetch: true,
            maxBufferLength: 60,
            maxMaxBufferLength: 120,
            backBufferLength: 60,
            lowLatencyMode: false,
            fragLoadingTimeOut: 20000,
            fragLoadingMaxRetry: 5,
            fragLoadingRetryDelay: 250,
            fragLoadingMaxRetryTimeout: 5000,
            manifestLoadingMaxRetry: 4,
            manifestLoadingRetryDelay: 250,
            manifestLoadingMaxRetryTimeout: 5000,
        });

        this.hlsPlayer = hls;
        this.hlsInitialized = true;
        hls.attachMedia(this.audio);

        await new Promise((resolve, reject) => {
            let settled = false;
            const finish = (error) => {
                if (settled) return;
                settled = true;
                hls.off(Hls.Events.MANIFEST_PARSED, onManifest);
                hls.off(Hls.Events.ERROR, onError);
                if (error) reject(error);
                else resolve();
            };
            const onManifest = () => finish();
            const onError = (_, data) => {
                if (!data?.fatal) return;
                if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
                    hls.startLoad();
                    return;
                }
                if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !hls._monoMediaRecoveryAttempted) {
                    hls._monoMediaRecoveryAttempted = true;
                    console.warn('[HLS] Recovering Firefox/media decoder error once:', data.details);
                    hls.recoverMediaError();
                    return;
                }
                finish(new Error(`HLS ${data.details || 'fatal playback error'}`));
            };
            hls.on(Hls.Events.MANIFEST_PARSED, onManifest);
            hls.on(Hls.Events.ERROR, onError);
            hls.loadSource(streamUrl);
        });

        if (startTime > 0) this.audio.currentTime = startTime;
        await this.audio.play();
    }

    _cleanupHls() {
        if (!this.hlsPlayer) return;
        try {
            this.hlsPlayer.destroy();
        } catch {
            /* ignore */
        }
        this.hlsPlayer = null;
        this.hlsInitialized = false;
    }

    updateAdaptiveQualityBadge() {
        if (!this.shakaPlayer || !this.currentTrack) return;
        const variant = this.shakaPlayer.getVariantTracks().find((t) => t.active);
        if (!variant) return;

        const quality = deriveQualityFromShakaVariant(variant);
        const titleEl = document.querySelector('.now-playing-bar .title');
        if (titleEl) {
            const trackTitle = getTrackTitle(this.currentTrack);
            const badge = createQualityBadgeHTML(this.currentTrack, quality);
            titleEl.innerHTML = `${escapeHtml(trackTitle)} ${badge}`;
        }
    }

    evaluateCrossCodecAbr() {
        if (!this.shakaPlayer || !this.shakaInitialized) return;
        const variants = this.shakaPlayer.getVariantTracks();
        if (!variants || variants.length === 0) return;

        const stats = this.shakaPlayer.getStats();
        const bandwidth = stats.estimatedBandwidth;

        const activeVariant = variants.find((v) => v.active);
        if (!activeVariant) return;

        // Find the best variant based on estimated bandwidth
        const bestVariant =
            variants.filter((v) => v.bandwidth <= bandwidth * 0.9).sort((a, b) => b.bandwidth - a.bandwidth)[0] ||
            variants[0];

        if (bestVariant && bestVariant.id !== activeVariant.id) {
            // Bridge codec groups if possible (e.g. from AAC/MP4 to FLAC/ALAC)
            const isHighRes = bestVariant.codecs.includes('flac') || bestVariant.codecs.includes('alac');
            const currentIsHighRes = activeVariant.codecs.includes('flac') || activeVariant.codecs.includes('alac');

            if (isHighRes && !currentIsHighRes && bandwidth > bestVariant.bandwidth * 1.2) {
                console.log('[ABR] Bridging to high-fidelity variant:', bestVariant.id);
                this.shakaPlayer.selectVariantTrack(bestVariant, false);
            }
        }
    }

    /**
     * Set up essential event listeners on the main audio element
     * Called initially and after gapless audio swap
     */
    _setupAudioEventListeners() {
        this.audio.addEventListener('play', () => {
            this.startPlaybackMonitor();
        });

        this.audio.addEventListener('pause', () => {
            this.stopPlaybackMonitor();
            this._gaplessTransitionInProgress = false;
            this._setAdvanceInFlight(false);
        });

        this.audio.addEventListener('emptied', () => {
            this.stopPlaybackMonitor();
            this._gaplessTransitionInProgress = false;
            this._setAdvanceInFlight(false);
        });

        this.audio.addEventListener('ended', () => {
            this.handleTrackEnded();
        });

        // Re-initialize audio context with new audio element if needed
        if (audioContextManager.isReady()) {
            audioContextManager.init(this.audio);
        }
    }

    startPlaybackMonitor() {
        if (this._playbackMonitorTimer) return;

        const run = () => {
            this._playbackMonitorTimer = null;

            if (this.audio.paused || !this.currentTrack) {
                return;
            }

            const current = this.audio.currentTime || 0;
            const duration = this.audio.duration || 0;

            if (duration > 0) {
                const percent = Math.min(100, Math.max(0, (current / duration) * 100));

                const progressFill = document.getElementById('progress-fill');
                const currentTimeEl = document.getElementById('current-time');
                const totalDurationEl = document.getElementById('total-duration');
                const fsProgressFill = document.getElementById('fs-progress-fill');
                const fsCurrentTimeEl = document.getElementById('fs-current-time');
                const fsTotalDurationEl = document.getElementById('fs-total-duration');

                if (progressFill) progressFill.style.width = `${percent}%`;
                if (currentTimeEl) currentTimeEl.textContent = formatTime(current);
                if (totalDurationEl) totalDurationEl.textContent = formatTime(duration);

                if (fsProgressFill) fsProgressFill.style.width = `${percent}%`;
                if (fsCurrentTimeEl) fsCurrentTimeEl.textContent = formatTime(current);
                if (fsTotalDurationEl) fsTotalDurationEl.textContent = formatTime(duration);
            }

            const shouldAdvanceGapless =
                playbackBehaviorSettings.isGaplessEnabled() &&
                this.repeatMode !== REPEAT_MODE.ONE &&
                !this._gaplessTransitionInProgress &&
                this._canStartTransition();

            if (shouldAdvanceGapless) {
                const duration = this.audio.duration;
                const hasDuration = Number.isFinite(duration) && duration > 0;

                if (hasDuration) {
                    const remaining = duration - this.audio.currentTime;
                    if (remaining <= 3 && remaining > 0.2) {
                        // Resolve metadata only while the current track is
                        // still playing. Audio remains untouched until the
                        // handoff, so upcoming tracks are not preloaded.
                        this._resolveNextStreamUrl().catch(() => {});
                    }
                    if (remaining <= 0.2 && remaining >= -0.08 && !this._advanceInFlight) {
                        this._setTransitionState('preparing');
                        this._setAdvanceInFlight(true);
                        this._gaplessTransitionInProgress = true;
                        // The track is ending even though Howler won't fire
                        // onend (we advance early) - let history/status
                        // listeners record it. handleTrackEnded's guards keep
                        // this from double-advancing.
                        try {
                            this.audio.dispatchEvent(new Event('ended'));
                        } catch {
                            /* ignore */
                        }
                        this.playNext();
                        return;
                    }
                }
            }

            const interval = document.visibilityState === 'hidden' ? 500 : 80;
            this._playbackMonitorTimer = setTimeout(run, interval);
        };

        this._playbackMonitorTimer = setTimeout(run, 80);
    }

    stopPlaybackMonitor() {
        if (!this._playbackMonitorTimer) return;
        clearTimeout(this._playbackMonitorTimer);
        this._playbackMonitorTimer = null;
    }

    _setTransitionState(nextState) {
        this._transitionState = nextState;
    }

    _canStartTransition() {
        return this._transitionState === 'idle';
    }

    _setAdvanceInFlight(active) {
        if (this._advanceLockTimer) {
            clearTimeout(this._advanceLockTimer);
            this._advanceLockTimer = null;
        }

        this._advanceInFlight = Boolean(active);
        if (!this._advanceInFlight) {
            return;
        }

        // Recover from stale navigation locks so playback cannot remain stuck.
        this._advanceLockTimer = setTimeout(() => {
            if (!this._advanceInFlight) return;
            console.warn('[Playback] Advance lock timed out; resetting transition guards');
            this._advanceInFlight = false;
            this._gaplessTransitionInProgress = false;
            this._queueNavigationInProgress = false;
            this._setTransitionState('idle');
            this._advanceLockTimer = null;
        }, 6000);
    }

    _supportsDolbyAtmosWebPlayback() {
        if (this._atmosSupportChecked) {
            return this._atmosSupported;
        }

        try {
            const probe = document.createElement('audio');
            const checks = [
                'audio/mp4; codecs="ec-3"',
                'audio/mp4; codecs="ac-3"',
                'audio/mp4; codecs="mp4a.40.2,ec-3"',
            ];
            this._atmosSupported = checks.some((codec) => {
                const result = probe.canPlayType(codec);
                return result === 'probably' || result === 'maybe';
            });
        } catch {
            this._atmosSupported = false;
        }

        this._atmosSupportChecked = true;
        return this._atmosSupported;
    }

    // Detect Atmos (E-AC3-JOC / AC-4) from the stream the addon resolved.
    // Matches codec fields, format strings, MIME types and URL tokens. Addons
    // report codecs under many shapes ("ec-3", "eac3", "ac-3", "ddplus",
    // "audio/mp4; codecs=\"ec-3\""), so every field is probed — a miss means
    // the browser tries to decode Dolby and hard-fails at the element.
    _isAtmosStream(streamInfo, streamUrl) {
        if (!streamInfo) return false;
        const source = [
            streamInfo.format,
            streamInfo.quality,
            streamInfo.streamQuality,
            streamInfo.audioQuality,
            streamInfo.audioMode,
            streamInfo.mediaType,
            streamInfo.mimeType,
            streamInfo.codec,
            streamInfo.fileCodec,
            streamInfo.codecs,
            streamInfo.containerFormat,
            streamInfo.encoding,
            streamInfo.playlistUrl,
            streamInfo.manifestUrl,
            streamInfo.masterPlaylistUrl,
            typeof streamUrl === 'string' ? streamUrl : '',
        ]
            .filter(Boolean)
            .join(' ');
        return /(?:eac-?3|ec-?3|\beac3\b|\bac-?3\b|\bac3\b|dd\s*\+|ddplus|joc|ac-?4|atmos|dolby)/i.test(source);
    }

    _getEffectivePlaybackQuality(requestedQuality = this.quality) {
        if (requestedQuality === 'DOLBY_ATMOS' && !this._supportsDolbyAtmosWebPlayback()) {
            this._atmosUnsupportedInBrowser = true;
            return 'HI_RES_LOSSLESS';
        }

        return requestedQuality;
    }

    async _resolveStreamUrlWithRetry(track, maxAttempts = 3, initialDelayMs = 220) {
        if (!track || track.id === undefined || track.id === null) return null;
        if (this.preloadCache.has(track.id)) {
            const cached = this.preloadCache.get(track.id);
            if (typeof cached === 'string') return cached;
            return cached?.url;
        }

        const effectiveQuality = this._getEffectivePlaybackQuality(this.quality);

        const inflightKey = `${track.id}:${effectiveQuality}`;
        if (this._streamUrlInflight.has(inflightKey)) {
            return this._streamUrlInflight.get(inflightKey);
        }

        const resolvePromise = (async () => {
            let lastError = null;
            let delayMs = initialDelayMs;

            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                try {
                    const streamInfo = await this.api.getStreamUrl(track.id, effectiveQuality, null, track);
                    // Extract URL from the stream info object
                    let streamUrl = streamInfo;
                    if (typeof streamInfo === 'object' && streamInfo.url) {
                        streamUrl = streamInfo.url;
                    }
                    if (streamUrl) {
                        this.preloadCache.set(track.id, {
                            url: streamUrl,
                            info: streamInfo && typeof streamInfo === 'object' ? streamInfo : null,
                        });
                        this._preloadFailureCounts.delete(String(track.id));
                        return streamUrl;
                    }
                    lastError = new Error('Empty stream URL');
                } catch (error) {
                    lastError = error;
                }

                if (attempt < maxAttempts) {
                    await new Promise((resolve) => setTimeout(resolve, delayMs));
                    delayMs = Math.min(1300, Math.round(delayMs * 2));
                }
            }

            const failureKey = String(track.id);
            this._preloadFailureCounts.set(failureKey, (this._preloadFailureCounts.get(failureKey) || 0) + 1);
            throw lastError || new Error(`Failed to resolve stream URL for track ${track.id}`);
        })();

        this._streamUrlInflight.set(inflightKey, resolvePromise);

        try {
            return await resolvePromise;
        } finally {
            if (this._streamUrlInflight.get(inflightKey) === resolvePromise) {
                this._streamUrlInflight.delete(inflightKey);
            }
        }
    }

    _warmupStream() {
        // Preloading is disabled — never fetch audio ahead of playback.
        return Promise.resolve();
    }

    _warmupCurrentTrack() {
        // Preloading is disabled — do not warm the browser cache before play.
    }

    scheduleBackgroundPreload(delayMs = 250) {
        // Resolve only the next signed URL. No audio or media segments are
        // fetched ahead of playback.
        if (this._backgroundPreloadTimer) clearTimeout(this._backgroundPreloadTimer);
        this._backgroundPreloadTimer = setTimeout(
            () => {
                this._backgroundPreloadTimer = null;
                this._resolveNextStreamUrl().catch(() => {});
            },
            Math.max(0, delayMs)
        );
    }

    async _resolveNextStreamUrl() {
        const currentQueue = this.shuffleActive ? this.shuffledQueue : this.queue;
        const nextIndex = this.currentQueueIndex + 1 < currentQueue.length ? this.currentQueueIndex + 1 : 0;
        const nextTrack =
            this.repeatMode === REPEAT_MODE.ALL ? currentQueue[nextIndex] : currentQueue[this.currentQueueIndex + 1];
        if (!nextTrack || nextTrack.isLocal || nextTrack.isTracker || nextTrack.isPodcast) return null;

        const resolutionKey = `${nextTrack.id}:${this._getEffectivePlaybackQuality(this.quality)}`;
        if (this._nextStreamResolution === resolutionKey) return null;
        this._nextStreamResolution = resolutionKey;

        try {
            return await this._resolveStreamUrlWithRetry(nextTrack, 1, 0);
        } finally {
            if (this._nextStreamResolution === resolutionKey) this._nextStreamResolution = null;
        }
    }

    _updateTrackInfoUI(track) {
        const trackTitle = getTrackTitle(track);
        const trackArtistsHTML = getTrackArtistsHTML(track);
        const yearDisplay = getTrackYearDisplay(track);

        const coverEl = document.querySelector('.now-playing-bar .cover');
        const titleEl = document.querySelector('.now-playing-bar .title');
        const albumEl = document.querySelector('.now-playing-bar .album');
        const artistEl = document.querySelector('.now-playing-bar .artist');

        if (coverEl) coverEl.src = this.api.getCoverUrl(track.album?.cover);
        this._updateLyricsMobileBackground(track);
        if (titleEl) {
            const titleMarkup = `${escapeHtml(trackTitle)} ${createQualityBadgeHTML(track)}`;
            titleEl.dataset.titleText = String(trackTitle || '');
            titleEl.dataset.titleMarkup = titleMarkup;
            this._updateNowPlayingTitleMarquee();
            setTimeout(() => this._updateNowPlayingTitleMarquee(), 80);
        }
        if (albumEl) {
            const albumTitle = track.album?.title || '';
            if (albumTitle && albumTitle !== trackTitle) {
                albumEl.textContent = albumTitle;
                albumEl.style.display = 'block';
            } else {
                albumEl.textContent = '';
                albumEl.style.display = 'none';
            }
        }
        if (artistEl) artistEl.innerHTML = trackArtistsHTML + yearDisplay;

        if (!yearDisplay && track.album?.id) {
            this.loadAlbumYear(track, trackArtistsHTML, artistEl);
        }

        const mixBtn = document.getElementById('now-playing-mix-btn');
        if (mixBtn) {
            mixBtn.style.display = track.mixes && track.mixes.TRACK_MIX ? 'flex' : 'none';
        }

        const totalDurationEl = document.getElementById('total-duration');
        const progressFill = document.getElementById('progress-fill');
        const currentTimeEl = document.getElementById('current-time');

        if (totalDurationEl) totalDurationEl.textContent = formatTime(track.duration);
        if (progressFill) progressFill.style.width = '0%';
        if (currentTimeEl) currentTimeEl.textContent = formatTime(0);

        document.title = `${trackTitle} • ${getTrackArtists(track)}`;
        this.updatePlayingTrackIndicator();
    }

    _updateNowPlayingTitleMarquee() {
        const titleEl = document.querySelector('.now-playing-bar .title');
        if (!titleEl) return;

        const titleMarkup = titleEl.dataset.titleMarkup || '';
        const titleText = (titleEl.dataset.titleText || '').trim();
        if (!titleMarkup) return;

        titleEl.classList.remove('marquee-active');

        const shouldMarquee = titleText.length >= 20;
        if (!shouldMarquee) {
            titleEl.innerHTML = `<span class="title-marquee-content">${titleMarkup}</span>`;
            return;
        }

        titleEl.classList.add('marquee-active');
        titleEl.innerHTML = `<marquee class="title-marquee-tag" behavior="scroll" direction="left" scrollamount="3" scrolldelay="30" loop="-1">${titleMarkup}</marquee>`;
    }

    _updateLyricsMobileBackground(track) {
        const sidePanel = document.getElementById('side-panel');
        if (!sidePanel) return;

        const coverId = track?.album?.cover;
        if (!coverId) {
            sidePanel.style.removeProperty('--lyrics-mobile-bg-image');
            return;
        }

        const coverUrl = this.api.getCoverUrl(coverId, '640');
        sidePanel.style.setProperty('--lyrics-mobile-bg-image', `url("${coverUrl}")`);
    }

    handleTrackEnded() {
        if (this._gaplessTransitionInProgress || this._advanceInFlight || !this._canStartTransition()) {
            return;
        }
        this._setTransitionState('swap');
        this._setAdvanceInFlight(true);
        this.playNext();
    }

    setVolume(volume = null) {
        if (typeof volume === 'number' && Number.isFinite(volume)) {
            this.userVolume = Math.max(0, Math.min(1, volume));
            localStorage.setItem('volume', String(this.userVolume));
        }
        this.applyReplayGain();
    }

    applyReplayGain() {
        const mode = replayGainSettings.getMode(); // 'off', 'track', 'album'
        let gainDb = 0;
        let peak = 1.0;

        if (mode !== 'off' && this.currentRgValues) {
            const { trackReplayGain, trackPeakAmplitude, albumReplayGain, albumPeakAmplitude } = this.currentRgValues;

            if (mode === 'album' && albumReplayGain !== undefined) {
                gainDb = albumReplayGain;
                peak = albumPeakAmplitude || 1.0;
            } else if (trackReplayGain !== undefined) {
                gainDb = trackReplayGain;
                peak = trackPeakAmplitude || 1.0;
            }

            // Apply Pre-Amp
            gainDb += replayGainSettings.getPreamp();
        }

        // Convert dB to linear scale: 10^(dB/20)
        let scale = Math.pow(10, gainDb / 20);

        // Peak protection (prevent clipping)
        if (scale * peak > 1.0) {
            scale = 1.0 / peak;
        }

        // Apply exponential volume curve if enabled
        const curvedVolume = exponentialVolumeSettings.applyCurve(this.userVolume);

        // Calculate effective volume
        const effectiveVolume = curvedVolume * scale;

        const el = this.activeElement || this.audio;

        // Pure mode: bit-perfect path. No ReplayGain, pre-amp, or volume
        // curve — the linear user volume goes straight to the element (and
        // Howler's own node). At 100% the decoded samples pass through
        // untouched; anything lower is honest user attenuation.
        if (audioProcessingSettings.isPure()) {
            const linear = Math.max(0, Math.min(1, this.userVolume));
            if (this._howlerSound) {
                try {
                    this._howlerSound.volume(linear);
                    this._howlerSound.mute(Boolean(el.muted));
                } catch {
                    /* ignore */
                }
            }
            if (audioContextManager.isReady()) {
                audioContextManager.setVolume(1.0);
            }
            el.volume = linear;
            return;
        }

        // Apply to the Howler sound when it's the active playback engine — it
        // uses its own HTML5 audio node, so element/graph volume wouldn't reach it.
        if (this._howlerSound) {
            try {
                this._howlerSound.volume(effectiveVolume);
                this._howlerSound.mute(Boolean(el.muted));
            } catch {
                /* ignore */
            }
        }

        // Apply to audio element and/or Web Audio graph
        const isApple = isIos || isSafari;

        if (audioContextManager.isReady() && !isApple) {
            // If Web Audio is active, we apply volume there for better compatibility
            // Especially on Linux where audio.volume might not affect the Web Audio graph
            el.volume = 1.0;
            audioContextManager.setVolume(effectiveVolume);
        } else {
            // Safari bypasses WebAudio for HLS, so we MUST set el.volume directly to reflect ReplayGain
            if (audioContextManager.isReady()) {
                audioContextManager.setVolume(1.0); // Reset graph gain if it somehow routes
            }
            el.volume = Math.max(0, Math.min(1, effectiveVolume));
        }
    }

    applyAudioEffects() {
        const speed = audioEffectsSettings.getSpeed();
        if (this.audio.playbackRate !== speed) {
            this.audio.playbackRate = speed;
        }
    }

    setPlaybackSpeed(speed) {
        const validSpeed = Math.max(0.01, Math.min(100, parseFloat(speed) || 1.0));
        audioEffectsSettings.setSpeed(validSpeed);
        this.applyAudioEffects();
    }

    loadQueueState() {
        const savedState = queueManager.getQueue();
        if (savedState) {
            this.queue = savedState.queue || [];
            this.shuffledQueue = savedState.shuffledQueue || [];
            this.originalQueueBeforeShuffle = savedState.originalQueueBeforeShuffle || [];
            this.currentQueueIndex = savedState.currentQueueIndex ?? -1;
            this.shuffleActive = savedState.shuffleActive || false;
            this.repeatMode = savedState.repeatMode !== undefined ? savedState.repeatMode : REPEAT_MODE.OFF;

            // Restore current track if queue exists and index is valid
            const currentQueue = this.shuffleActive ? this.shuffledQueue : this.queue;
            if (this.currentQueueIndex >= 0 && this.currentQueueIndex < currentQueue.length) {
                this.currentTrack = currentQueue[this.currentQueueIndex];

                // Restore UI
                const track = this.currentTrack;
                const trackTitle = getTrackTitle(track);
                const trackArtistsHTML = getTrackArtistsHTML(track);
                const yearDisplay = getTrackYearDisplay(track);

                const coverEl = document.querySelector('.now-playing-bar .cover');
                const titleEl = document.querySelector('.now-playing-bar .title');
                const albumEl = document.querySelector('.now-playing-bar .album');
                const artistEl = document.querySelector('.now-playing-bar .artist');

                if (coverEl) coverEl.src = this.api.getCoverUrl(track.album?.cover);
                this._updateLyricsMobileBackground(track);
                if (titleEl) {
                    const qualityBadge = createQualityBadgeHTML(track);
                    titleEl.innerHTML = `${escapeHtml(trackTitle)} ${qualityBadge}`;
                }
                if (albumEl) {
                    const albumTitle = track.album?.title || '';
                    if (albumTitle && albumTitle !== trackTitle) {
                        albumEl.textContent = albumTitle;
                        albumEl.style.display = 'block';
                    } else {
                        albumEl.textContent = '';
                        albumEl.style.display = 'none';
                    }
                }
                if (artistEl) artistEl.innerHTML = trackArtistsHTML + yearDisplay;

                // Fetch album release date in background if missing
                if (!yearDisplay && track.album?.id) {
                    this.loadAlbumYear(track, trackArtistsHTML, artistEl);
                }

                const mixBtn = document.getElementById('now-playing-mix-btn');
                if (mixBtn) {
                    mixBtn.style.display = track.mixes && track.mixes.TRACK_MIX ? 'flex' : 'none';
                }
                const totalDurationEl = document.getElementById('total-duration');
                if (totalDurationEl) totalDurationEl.textContent = formatTime(track.duration);
                document.title = `${trackTitle} • ${getTrackArtists(track)}`;

                this.updatePlayingTrackIndicator();
                this.updateMediaSession(track);
            }
        }
    }

    saveQueueState() {
        queueManager.saveQueue({
            queue: this.queue,
            shuffledQueue: this.shuffledQueue,
            originalQueueBeforeShuffle: this.originalQueueBeforeShuffle,
            currentQueueIndex: this.currentQueueIndex,
            shuffleActive: this.shuffleActive,
            repeatMode: this.repeatMode,
        });

        if (window.renderQueueFunction) {
            window.renderQueueFunction();
        }
    }

    setupMediaSession() {
        if (!('mediaSession' in navigator)) return;

        navigator.mediaSession.setActionHandler('play', async () => {
            // Initialize and resume audio context first (required for iOS lock screen)
            // Must happen before audio.play() or audio won't route through Web Audio
            if (!audioContextManager.isReady()) {
                audioContextManager.init(this.audio);
                this.applyReplayGain();
            }
            await audioContextManager.resume();

            try {
                await this.audio.play();
            } catch (e) {
                console.error('MediaSession play failed:', e);
                // If play fails, try to handle it like a regular play/pause
                this.handlePlayPause();
            }
        });

        navigator.mediaSession.setActionHandler('pause', () => {
            this.audio.pause();
        });

        navigator.mediaSession.setActionHandler('previoustrack', async () => {
            // Ensure audio context is active for iOS lock screen controls
            if (!audioContextManager.isReady()) {
                audioContextManager.init(this.audio);
                this.applyReplayGain();
            }
            await audioContextManager.resume();
            this.playPrev();
        });

        navigator.mediaSession.setActionHandler('nexttrack', async () => {
            // Ensure audio context is active for iOS lock screen controls
            if (!audioContextManager.isReady()) {
                audioContextManager.init(this.audio);
                this.applyReplayGain();
            }
            await audioContextManager.resume();
            this.playNext();
        });

        navigator.mediaSession.setActionHandler('seekbackward', (details) => {
            const skipTime = details.seekOffset || 10;
            this.seekBackward(skipTime);
        });

        navigator.mediaSession.setActionHandler('seekforward', (details) => {
            const skipTime = details.seekOffset || 10;
            this.seekForward(skipTime);
        });

        navigator.mediaSession.setActionHandler('seekto', (details) => {
            if (details.seekTime !== undefined) {
                this.audio.currentTime = Math.max(0, details.seekTime);
                this.updateMediaSessionPositionState();
            }
        });

        navigator.mediaSession.setActionHandler('stop', () => {
            this.audio.pause();
            this.audio.currentTime = 0;
            this.updateMediaSessionPlaybackState();
        });
    }

    setQuality(quality) {
        this.quality = quality;
    }

    async preloadNextTracks() {
        return this._resolveNextStreamUrl();
    }

    /**
     * Optimize the queue for performance mode
     * Clears old cached tracks to free memory in extreme mode
     */
    optimizeQueue() {
        const mode = performanceModeSettings.getMode();
        const maxCacheSize = mode === 'extreme' ? 10 : mode === 'performance' ? 20 : 50;

        // Keep only recent tracks in cache
        if (this.preloadCache.size > maxCacheSize) {
            const entriesToRemove = this.preloadCache.size - maxCacheSize;
            let removed = 0;
            for (const key of this.preloadCache.keys()) {
                if (removed >= entriesToRemove) break;
                // Don't remove the current track
                if (this.currentTrack && key === this.currentTrack.id) continue;
                this.preloadCache.delete(key);
                removed++;
            }
        }
    }

    /**
     * Clear all cached preloaded tracks
     */
    clearPreloadCache() {
        if (this.preloadAbortController) {
            this.preloadAbortController.abort();
        }
        if (this._currentTrackWarmupAbortController) {
            this._currentTrackWarmupAbortController.abort();
        }
        if (this._backgroundPreloadTimer) {
            clearTimeout(this._backgroundPreloadTimer);
            this._backgroundPreloadTimer = null;
        }
        this._streamUrlInflight.clear();
        this._prefetchInflight.clear();
        this._nextStreamResolution = null;
        this.preloadCache.clear();
    }

    async playTrackFromQueue(startTime = 0, recursiveCount = 0) {
        this._queueNavigationInProgress = false;

        // Token for de-duplicating concurrent play requests (double clicks,
        // repeated billboard resolution, etc.). A stale run must not start
        // another audio instance or skip tracks after a newer play began.
        this._playSequence = (this._playSequence || 0) + 1;
        const playSequence = this._playSequence;
        const isStalePlay = () => playSequence !== this._playSequence;

        const currentQueue = this.shuffleActive ? this.shuffledQueue : this.queue;
        if (this.currentQueueIndex < 0 || this.currentQueueIndex >= currentQueue.length) {
            return;
        }

        this._gaplessTransitionInProgress = false;
        this._setTransitionState('idle');

        const track = currentQueue[this.currentQueueIndex];
        const trackTitle = getTrackTitle(track);

        if (track.isUnavailable) {
            console.warn(`Attempted to play unavailable track: ${trackTitle}. Skipping...`);
            this.playNext(recursiveCount + 1);
            return;
        }

        // Check if track is blocked
        const { contentBlockingSettings } = await import('./storage.js');
        if (contentBlockingSettings.shouldHideTrack(track)) {
            console.warn(`Attempted to play blocked track: ${trackTitle}. Skipping...`);
            this.playNext(recursiveCount + 1);
            return;
        }

        this.saveQueueState();
        this.currentTrack = track;
        recentActivityManager.addTrack(track);

        // UI Updates
        const trackArtistsHTML = getTrackArtistsHTML(track);
        const yearDisplay = getTrackYearDisplay(track);

        const coverEl = document.querySelector('.now-playing-bar .cover');
        if (coverEl) coverEl.src = this.api.getCoverUrl(track.album?.cover);

        this._updateLyricsMobileBackground(track);

        const titleEl = document.querySelector('.now-playing-bar .title');
        if (titleEl) {
            titleEl.innerHTML = `${escapeHtml(trackTitle)} ${createQualityBadgeHTML(track)}`;
        }

        const albumEl = document.querySelector('.now-playing-bar .album');
        if (albumEl) {
            const albumTitle = track.album?.title || '';
            if (albumTitle && albumTitle !== trackTitle) {
                albumEl.textContent = albumTitle;
                albumEl.style.display = 'block';
            } else {
                albumEl.textContent = '';
                albumEl.style.display = 'none';
            }
        }

        const artistEl = document.querySelector('.now-playing-bar .artist');
        if (artistEl) artistEl.innerHTML = trackArtistsHTML + yearDisplay;

        // Fetch album release date in background if missing
        if (!yearDisplay && track.album?.id) {
            this.loadAlbumYear(track, trackArtistsHTML, artistEl);
        }

        const mixBtn = document.getElementById('now-playing-mix-btn');
        if (mixBtn) {
            mixBtn.style.display = track.mixes && track.mixes.TRACK_MIX ? 'flex' : 'none';
        }
        document.title = `${trackTitle} • ${getTrackArtists(track)}`;

        // Reset mini-player progress UI to avoid stale 100% state when switching tracks
        const progressFill = document.getElementById('progress-fill');
        const currentTimeEl = document.getElementById('current-time');
        const totalDurationEl = document.getElementById('total-duration');

        if (progressFill) progressFill.style.width = '0%';
        if (currentTimeEl) currentTimeEl.textContent = formatTime(0);
        if (totalDurationEl) {
            totalDurationEl.textContent =
                Number.isFinite(track.duration) && track.duration > 0 ? formatTime(track.duration) : '0:00';
        }

        this.updatePlayingTrackIndicator();
        this.updateMediaSession(track);
        this.updateMediaSessionPlaybackState();
        this.updateNativeWindow(track);

        try {
            // Notify the UI that the track is loading so the play button can
            // show a buffering state until actual playback begins.
            try {
                this.audio.dispatchEvent(new Event('loadstart'));
            } catch {
                /* ignore */
            }

            let streamUrl;
            let streamInfo = null;

            const isTracker = track.isTracker || (track.id && String(track.id).startsWith('tracker-'));
            const isPodcast = track.isPodcast || (track.id && String(track.id).startsWith('podcast_'));

            if (!track.isLocal && !isTracker && !isPodcast) {
                const effectiveQuality = this._getEffectivePlaybackQuality(this.quality);

                // Cache-first playback path: instantly reuse preloaded URL when available.
                const cachedStream = this.preloadCache.get(track.id);
                if (cachedStream) {
                    if (typeof cachedStream === 'string') {
                        streamUrl = cachedStream;
                    } else if (typeof cachedStream === 'object' && cachedStream.url) {
                        streamUrl = cachedStream.url;
                        streamInfo = cachedStream.info || null;
                    }
                } else {
                    // Get stream URL from API (optimized for high-fidelity)
                    try {
                        streamInfo = await this.api.getStreamUrl(track.id, effectiveQuality, null, track);
                        streamUrl = streamInfo;
                        if (typeof streamInfo === 'object' && streamInfo.url) {
                            streamUrl = streamInfo.url;
                        }
                    } catch (e) {
                        console.warn(`Failed to get stream URL for track ${trackTitle}:`, e);
                        throw e;
                    }
                }

                // Store stream quality metadata on track for UI display —
                // applied on every path so the fullscreen quality readout is exact.
                if (streamInfo && typeof streamInfo === 'object' && streamInfo.url) {
                    track.streamInfo = { ...streamInfo };
                    if (streamInfo.bitDepth != null) track.bitDepth = streamInfo.bitDepth;
                    if (streamInfo.sampleRate != null) track.sampleRate = streamInfo.sampleRate;
                    if (streamInfo.audioQuality) track.audioQuality = streamInfo.audioQuality;
                    if (streamInfo.audioMode) track.audioMode = streamInfo.audioMode;
                    if (streamInfo.format) track.format = streamInfo.format;
                    if (streamInfo.codec) track.codec = streamInfo.codec;
                    if (streamInfo.containerFormat) track.containerFormat = streamInfo.containerFormat;
                    if (streamInfo.mediaType) track.mediaType = streamInfo.mediaType;
                    if (streamInfo.mimeType) track.mimeType = streamInfo.mimeType;
                    if (streamInfo.bitrateKbps) track.bitrateKbps = streamInfo.bitrateKbps;
                    track.streamedQuality = effectiveQuality;

                    // Fullscreen may have opened before the signed stream was
                    // resolved. Refresh its exact quality readout now that the
                    // addon has supplied the actual codec and stream specs.
                    const fullscreenQuality = document.getElementById('fullscreen-track-quality');
                    if (fullscreenQuality) {
                        fullscreenQuality.innerHTML = createFullscreenQualityHTML(track);
                    }

                    // Notify listeners (e.g. Discord Rich Presence) that the
                    // track's real quality metadata is now available.
                    document.dispatchEvent(new CustomEvent('wesper:track-quality-updated'));
                }
            } else if (track.isLocal && track.file) {
                streamUrl = URL.createObjectURL(track.file);
            } else {
                streamUrl = track.audioUrl || track.remoteUrl;
            }

            if (!streamUrl) {
                throw new Error('No stream URL available');
            }

            // A newer play request superseded this one while we were fetching
            // the stream — abort instead of starting a second audio instance.
            if (isStalePlay()) return;

            // Dolby Atmos (E-AC3-JOC/AC-4) can't be decoded by most browsers.
            // There is no fallback tier to play here — the stream is Atmos and
            // this browser simply can't render it, so refuse honestly instead
            // of silently downgrading or hanging in buffering.
            if (streamInfo && this._isAtmosStream(streamInfo, streamUrl) && !this._supportsDolbyAtmosWebPlayback()) {
                console.warn(`[Dolby Atmos] Cannot play "${trackTitle}" — this browser can't decode E-AC3/AC-4.`);
                showNotification('Cannot Play Dolby Audio', 4000);
                try {
                    this.audio.dispatchEvent(new Event('error'));
                } catch {
                    /* ignore */
                }
                this.api.clearStreamCache?.(track.id);
                this.preloadCache.delete(track.id);
                if (recursiveCount < currentQueue.length) {
                    setTimeout(() => this.playNext(recursiveCount + 1), 800);
                }
                return;
            }

            // Prime the browser cache with the head of the stream the moment we
            // know the URL. Howler's html5 audio element (and any cached-start
            // path below) then reads the first chunk from disk cache instead of
            // the network, cutting perceived buffering to near zero. Non-blocking.
            if (typeof streamUrl === 'string' && !streamUrl.startsWith('blob:')) {
                this._warmupCurrentTrack(streamUrl);
            }

            // Handle DASH/HLS streams via dash.js or Shaka Player, use Howler for regular files
            const isDash =
                (typeof streamUrl === 'string' && streamUrl.includes('.mpd')) ||
                (typeof streamUrl === 'string' && streamUrl.startsWith('blob:')) ||
                (streamInfo && String(streamInfo.mediaType || '').toUpperCase() === 'DASH');
            const isHls =
                (typeof streamUrl === 'string' && isHlsStreamUrl(streamUrl)) ||
                (streamInfo && String(streamInfo.mediaType || '').toUpperCase() === 'HLS') ||
                (streamInfo && /mpegurl|apple\.mpegurl/i.test(String(streamInfo.mimeType || '')));
            const isAdaptive = isDash || isHls;
            let isCrossOriginRegularFile = false;
            if (!isAdaptive && typeof streamUrl === 'string' && !streamUrl.startsWith('blob:')) {
                try {
                    isCrossOriginRegularFile =
                        new URL(streamUrl, window.location.href).origin !== window.location.origin;
                } catch {
                    /* Keep native playback for malformed/non-URL sources. */
                }
            }

            // Ground truth from the media files themselves: the addon's quality
            // label is text that can be missing, vague or wrong (it carries no
            // bitrate at all for Tidal FLAC). Probe the actual stream and
            // override the displayed specs with what the file really is.
            // Non-blocking — playback is never delayed by the inspection.
            if (typeof streamUrl === 'string' && !streamUrl.startsWith('blob:')) {
                const inspectedTrack = track;
                inspectStreamMetadata(streamUrl, {
                    isHls,
                    isDash,
                    duration: Number(track.duration) || 0,
                })
                    .then((real) => {
                        if (isStalePlay() || this.currentTrack !== inspectedTrack) return;
                        if (Object.keys(real).length === 0) return;
                        let changed = false;
                        if (real.sampleRate && real.sampleRate !== inspectedTrack.sampleRate) {
                            inspectedTrack.sampleRate = real.sampleRate;
                            inspectedTrack.streamInfo = { ...inspectedTrack.streamInfo, sampleRate: real.sampleRate };
                            changed = true;
                        }
                        if (real.bitDepth && real.bitDepth !== inspectedTrack.bitDepth) {
                            inspectedTrack.bitDepth = real.bitDepth;
                            inspectedTrack.streamInfo = { ...inspectedTrack.streamInfo, bitDepth: real.bitDepth };
                            changed = true;
                        }
                        if (real.bitrateKbps && real.bitrateKbps !== inspectedTrack.bitrateKbps) {
                            inspectedTrack.bitrateKbps = real.bitrateKbps;
                            inspectedTrack.streamInfo = { ...inspectedTrack.streamInfo, bitrateKbps: real.bitrateKbps };
                            changed = true;
                        }
                        if (!changed) return;
                        const fullscreenQuality = document.getElementById('fullscreen-track-quality');
                        if (fullscreenQuality) {
                            fullscreenQuality.innerHTML = createFullscreenQualityHTML(inspectedTrack);
                        }
                        document.dispatchEvent(new CustomEvent('wesper:track-quality-updated'));
                    })
                    .catch(() => {
                        /* inspection is best-effort */
                    });
            }

            if (isAdaptive) {
                if (!audioContextManager.isReady()) {
                    audioContextManager.init(this.audio);
                }
                if (audioContextManager.isReady()) {
                    await audioContextManager.resume();
                    this.applyReplayGain();
                }

                // Switching to adaptive stream - clean up Howler first to restore native audio methods
                this._cleanupHowler();

                // Use dash.js for DASH streams, hls.js for HLS
                if (isDash) {
                    this._cleanupHls();
                    // Use dash.js for DASH streams
                    try {
                        if (this.dashInitialized) {
                            this.dashPlayer.reset();
                        }
                        this.dashPlayer.initialize(this.audio, streamUrl, true);
                        this.dashInitialized = true;

                        if (startTime > 0) {
                            this.dashPlayer.seek(startTime);
                        }
                    } catch (dashError) {
                        console.error('dash.js load failed, falling back to Howler:', dashError);
                        await this.loadWithHowler(streamUrl, startTime);
                    }
                } else {
                    // Use hls.js for HLS streams. It keeps a larger rolling
                    // buffer and retries relay-backed media segments without
                    // involving the DASH engine.
                    if (this.dashInitialized) {
                        this.dashPlayer.reset();
                        this.dashInitialized = false;
                    }

                    try {
                        this._cleanupHls();
                        await this._loadWithHls(streamUrl, startTime);
                    } catch (hlsError) {
                        // Firefox may report MSE support while rejecting the
                        // FLAC fMP4 init segment at high sample rates. Keep
                        // the track playable by retrying the same recording at
                        // standard lossless before normal error handling skips.
                        const isFirefoxHiResFailure =
                            isFirefox &&
                            this._getEffectivePlaybackQuality(this.quality) === 'HI_RES_LOSSLESS' &&
                            /codec|media|buffer|fragment|source|unsupported|decode/i.test(
                                String(hlsError?.message || hlsError)
                            );
                        if (isFirefoxHiResFailure) {
                            try {
                                console.warn(
                                    '[HLS] Firefox rejected Hi-Res FLAC; retrying standard Lossless:',
                                    hlsError
                                );
                                this.api.clearStreamCache?.(track.id);
                                const fallbackInfo = await this.api.getStreamUrl(track.id, 'LOSSLESS', null, track);
                                const fallbackUrl =
                                    typeof fallbackInfo === 'object' && fallbackInfo.url
                                        ? fallbackInfo.url
                                        : fallbackInfo;
                                if (fallbackUrl && isHlsStreamUrl(fallbackUrl)) {
                                    streamUrl = fallbackUrl;
                                    streamInfo = fallbackInfo;
                                    track.streamedQuality = 'LOSSLESS';
                                    await this._loadWithHls(fallbackUrl, startTime);
                                    showNotification('Firefox playback uses standard Lossless for this track.', 3500);
                                } else {
                                    throw hlsError;
                                }
                            } catch (fallbackError) {
                                console.warn('[HLS] Firefox Lossless fallback failed:', fallbackError);
                                throw hlsError;
                            }
                        } else {
                            console.error('hls.js load failed, falling back to Shaka:', hlsError);
                            if (!this.shakaPlayer) await this.init();
                            if (!this.shakaPlayer) throw hlsError;
                            await this.shakaPlayer.load(streamUrl, null, 'application/x-mpegURL');
                            this.shakaInitialized = true;
                            await this.audio.play();
                        }
                    }
                }
            } else {
                // Use the native audio element + Web Audio graph for regular
                // same-origin files. Cross-origin files use Howler's HTML5
                // element directly: MediaElementSource can legally report
                // playback while outputting silence when the CDN omits CORS.
                // HLS/DASH still use their manifest engines above.
                if (this.shakaInitialized && this.shakaPlayer) {
                    await this.shakaPlayer.unload();
                    this.shakaInitialized = false;
                }
                this._cleanupHls();
                if (this.dashInitialized) {
                    this.dashPlayer.reset();
                    this.dashInitialized = false;
                }
                if (isCrossOriginRegularFile) {
                    await this.loadWithHowler(streamUrl, startTime);
                } else {
                    await this.loadWithNativeAudio(streamUrl, startTime);
                }
            }

            // Post-playback tasks
            this.scheduleBackgroundPreload(200);
            this._setAdvanceInFlight(false);
        } catch (error) {
            // A newer play request superseded this one — ignore errors (and
            // don't auto-skip) for the stale run.
            if (isStalePlay()) return;

            console.error(`Could not play track: ${trackTitle}`, error);
            this._gaplessTransitionInProgress = false;
            this._setAdvanceInFlight(false);

            // Clear the buffering state so the play button doesn't spin forever.
            try {
                this.audio.dispatchEvent(new Event('error'));
            } catch {
                /* ignore */
            }

            // Clear cached stream data so the track can be retried later
            this.api.clearStreamCache(track.id);
            this.preloadCache.delete(track.id);

            // Skip to next track on unexpected error
            if (recursiveCount < currentQueue.length) {
                setTimeout(() => this.playNext(recursiveCount + 1), 1000);
            }
        }
    }

    playAtIndex(index) {
        const currentQueue = this.shuffleActive ? this.shuffledQueue : this.queue;
        if (index >= 0 && index < currentQueue.length) {
            this._setAdvanceInFlight(false);
            this.currentQueueIndex = index;
            this.playTrackFromQueue(0, 0);
        }
    }

    playNext(recursiveCount = 0) {
        if (recursiveCount === 0) {
            if (this._queueNavigationInProgress) {
                return;
            }
            this._queueNavigationInProgress = true;
            this._setAdvanceInFlight(true);
        }

        const currentQueue = this.shuffleActive ? this.shuffledQueue : this.queue;
        const isLastTrack = this.currentQueueIndex >= currentQueue.length - 1;

        if (recursiveCount > currentQueue.length) {
            console.error('All tracks in queue are unavailable or blocked.');
            this._cleanupHowler();
            this.audio.pause();
            this._gaplessTransitionInProgress = false;
            this._setAdvanceInFlight(false);
            this._queueNavigationInProgress = false;
            return;
        }

        // Import blocking settings dynamically
        import('./storage.js')
            .then(({ contentBlockingSettings }) => {
                if (
                    this.repeatMode === REPEAT_MODE.ONE &&
                    !currentQueue[this.currentQueueIndex]?.isUnavailable &&
                    !contentBlockingSettings.shouldHideTrack(currentQueue[this.currentQueueIndex])
                ) {
                    this._gaplessTransitionInProgress = false;
                    this.playTrackFromQueue(0, recursiveCount);
                    return;
                }

                if (!isLastTrack) {
                    this.currentQueueIndex++;
                    const track = currentQueue[this.currentQueueIndex];
                    // Skip unavailable and blocked tracks
                    if (track?.isUnavailable || contentBlockingSettings.shouldHideTrack(track)) {
                        return this.playNext(recursiveCount + 1);
                    }
                } else if (this.repeatMode === REPEAT_MODE.ALL) {
                    this.currentQueueIndex = 0;
                    const track = currentQueue[this.currentQueueIndex];
                    // Skip unavailable and blocked tracks
                    if (track?.isUnavailable || contentBlockingSettings.shouldHideTrack(track)) {
                        return this.playNext(recursiveCount + 1);
                    }
                } else {
                    this._gaplessTransitionInProgress = false;
                    this._setAdvanceInFlight(false);
                    this._setTransitionState('idle');
                    if (recursiveCount === 0) this._queueNavigationInProgress = false;
                    return;
                }

                this._gaplessTransitionInProgress = false;
                this.playTrackFromQueue(0, recursiveCount);
            })
            .catch((error) => {
                console.warn('[Playback] Failed to evaluate next track transition:', error);
                this._gaplessTransitionInProgress = false;
                this._setAdvanceInFlight(false);
                this._setTransitionState('idle');
                if (recursiveCount === 0) this._queueNavigationInProgress = false;
            });
    }

    playPrev(recursiveCount = 0) {
        if (recursiveCount === 0) {
            if (this._queueNavigationInProgress) {
                return;
            }
            this._queueNavigationInProgress = true;
        }

        this._setAdvanceInFlight(false);
        this._gaplessTransitionInProgress = false;
        if (this.audio.currentTime > 3) {
            this.audio.currentTime = 0;
            this.updateMediaSessionPositionState();
            if (recursiveCount === 0) this._queueNavigationInProgress = false;
        } else if (this.currentQueueIndex > 0) {
            this.currentQueueIndex--;
            // Skip unavailable and blocked tracks
            const currentQueue = this.shuffleActive ? this.shuffledQueue : this.queue;

            if (recursiveCount > currentQueue.length) {
                console.error('All tracks in queue are unavailable or blocked.');
                this.audio.pause();
                if (recursiveCount === 0) this._queueNavigationInProgress = false;
                return;
            }

            import('./storage.js')
                .then(({ contentBlockingSettings }) => {
                    const track = currentQueue[this.currentQueueIndex];
                    if (track?.isUnavailable || contentBlockingSettings.shouldHideTrack(track)) {
                        return this.playPrev(recursiveCount + 1);
                    }
                    this.playTrackFromQueue(0, recursiveCount);
                })
                .catch((error) => {
                    console.warn('[Playback] Failed to evaluate previous track transition:', error);
                    if (recursiveCount === 0) this._queueNavigationInProgress = false;
                });
        } else if (recursiveCount === 0) {
            this._queueNavigationInProgress = false;
        }
    }

    handlePlayPause() {
        // If Howler is active, use it directly instead of going through the audio element
        if (this._howlerSound) {
            if (this._howlerSound.playing()) {
                this._howlerSound.pause();
                this.stopPlaybackMonitor();
                this.saveQueueState();
            } else {
                this._howlerSound.play();
                this._howlerPlaybackMonitor();
                this.startPlaybackMonitor();
            }
            this.updateMediaSessionPlaybackState();
            return;
        }

        if (!this.audio.src || this.audio.error) {
            if (this.currentTrack) {
                this.playTrackFromQueue(0, 0);
            }
            return;
        }

        if (this.audio.paused) {
            this.audio.play().catch((e) => {
                if (e.name === 'NotAllowedError' || e.name === 'AbortError') return;
                console.error('Play failed, reloading track:', e);
                if (this.currentTrack) {
                    this.playTrackFromQueue(0, 0);
                }
            });
        } else {
            this.audio.pause();
            this.saveQueueState();
        }
    }

    seekBackward(seconds = 10) {
        const newTime = Math.max(0, this.audio.currentTime - seconds);
        this.audio.currentTime = newTime;
        this.updateMediaSessionPositionState();
    }

    seekForward(seconds = 10) {
        const duration = this.audio.duration || 0;
        const newTime = Math.min(duration, this.audio.currentTime + seconds);
        this.audio.currentTime = newTime;
        this.updateMediaSessionPositionState();
    }

    toggleShuffle() {
        this.shuffleActive = !this.shuffleActive;

        if (this.shuffleActive) {
            this.originalQueueBeforeShuffle = [...this.queue];
            const currentTrack = this.queue[this.currentQueueIndex];

            const tracksToShuffle = [...this.queue];
            if (currentTrack && this.currentQueueIndex >= 0) {
                tracksToShuffle.splice(this.currentQueueIndex, 1);
            }

            const smartShuffled = this._buildIntelligentShuffle(tracksToShuffle, currentTrack);

            if (currentTrack) {
                this.shuffledQueue = [currentTrack, ...smartShuffled];
                this.currentQueueIndex = 0;
            } else {
                this.shuffledQueue = smartShuffled;
                this.currentQueueIndex = -1;
            }
        } else {
            const currentTrack = this.shuffledQueue[this.currentQueueIndex];
            this.queue = [...this.originalQueueBeforeShuffle];
            this.currentQueueIndex = this.queue.findIndex((t) => t.id === currentTrack?.id);
        }

        this.preloadCache.clear();
        this.scheduleBackgroundPreload(120);
        this.saveQueueState();
    }

    _getShuffleArtistKey(track) {
        return String(getTrackArtists(track) || '')
            .toLowerCase()
            .trim();
    }

    _getShuffleAlbumKey(track) {
        return String(track?.album?.id || track?.album?.title || '')
            .toLowerCase()
            .trim();
    }

    _buildIntelligentShuffle(tracks, currentTrack = null) {
        const remaining = Array.isArray(tracks) ? [...tracks] : [];
        if (remaining.length <= 1) return remaining;

        const result = [];
        let lastArtist = this._getShuffleArtistKey(currentTrack);
        let lastAlbum = this._getShuffleAlbumKey(currentTrack);
        const recentArtists = [];

        while (remaining.length) {
            let bestIndex = 0;
            let bestScore = -Infinity;

            for (let i = 0; i < remaining.length; i++) {
                const candidate = remaining[i];
                const artist = this._getShuffleArtistKey(candidate);
                const album = this._getShuffleAlbumKey(candidate);
                let score = Math.random() * 10;

                if (artist && artist === lastArtist) score -= 100;
                if (album && lastAlbum && album === lastAlbum) score -= 45;
                if (artist && recentArtists.includes(artist)) score -= 22;

                if (score > bestScore) {
                    bestScore = score;
                    bestIndex = i;
                }
            }

            const [picked] = remaining.splice(bestIndex, 1);
            result.push(picked);

            lastArtist = this._getShuffleArtistKey(picked);
            lastAlbum = this._getShuffleAlbumKey(picked);
            if (lastArtist) {
                recentArtists.push(lastArtist);
                if (recentArtists.length > 2) recentArtists.shift();
            }
        }

        return result;
    }

    toggleRepeat() {
        this.repeatMode = (this.repeatMode + 1) % 3;
        this.saveQueueState();
        return this.repeatMode;
    }

    setQueue(tracks, startIndex = 0) {
        this.queue = tracks;
        this.currentQueueIndex = startIndex;
        this.shuffleActive = false;
        this.preloadCache.clear();
        this.saveQueueState();
    }

    addToQueue(trackOrTracks) {
        const tracks = Array.isArray(trackOrTracks) ? trackOrTracks : [trackOrTracks];
        this.queue.push(...tracks);

        if (this.shuffleActive) {
            this.shuffledQueue.push(...tracks);
            this.originalQueueBeforeShuffle.push(...tracks);
        }

        if (!this.currentTrack || this.currentQueueIndex === -1) {
            this.currentQueueIndex = this.getCurrentQueue().length - tracks.length;
            this.playTrackFromQueue(0, 0);
        }
        this.saveQueueState();
    }

    addNextToQueue(trackOrTracks) {
        const tracks = Array.isArray(trackOrTracks) ? trackOrTracks : [trackOrTracks];
        const currentQueue = this.shuffleActive ? this.shuffledQueue : this.queue;
        const insertIndex = this.currentQueueIndex + 1;

        // Insert after current track
        currentQueue.splice(insertIndex, 0, ...tracks);

        // If we are shuffling, we might want to also add it to the original queue for consistency,
        // though syncing that is tricky. The standard logic often just appends to the active queue view.
        if (this.shuffleActive) {
            this.originalQueueBeforeShuffle.push(...tracks); // Sync original queue
        }

        this.saveQueueState();
        this.scheduleBackgroundPreload(120); // Update preload since next track changed
    }

    removeFromQueue(index) {
        const currentQueue = this.shuffleActive ? this.shuffledQueue : this.queue;

        // If removing current track
        if (index === this.currentQueueIndex) {
            // If playing, we might want to stop or just let it finish?
            // For now, let's just remove it.
            // If it's the last track, playback will stop naturally or we handle it?
        }

        if (index < this.currentQueueIndex) {
            this.currentQueueIndex--;
        }

        const removedTrack = currentQueue.splice(index, 1)[0];

        if (this.shuffleActive) {
            // Also remove from original queue
            const originalIndex = this.originalQueueBeforeShuffle.findIndex((t) => t.id === removedTrack.id); // Simple ID check
            if (originalIndex !== -1) {
                this.originalQueueBeforeShuffle.splice(originalIndex, 1);
            }
        }

        this.saveQueueState();
        this.scheduleBackgroundPreload(120);
    }

    clearQueue() {
        if (this.currentTrack) {
            this.queue = [this.currentTrack];

            if (this.shuffleActive) {
                this.shuffledQueue = [this.currentTrack];
                this.originalQueueBeforeShuffle = [this.currentTrack];
            } else {
                this.shuffledQueue = [];
                this.originalQueueBeforeShuffle = [];
            }
            this.currentQueueIndex = 0;
        } else {
            this.queue = [];
            this.shuffledQueue = [];
            this.originalQueueBeforeShuffle = [];
            this.currentQueueIndex = -1;
        }

        this.preloadCache.clear();
        this.saveQueueState();
    }

    moveInQueue(fromIndex, toIndex) {
        const currentQueue = this.shuffleActive ? this.shuffledQueue : this.queue;

        if (fromIndex < 0 || fromIndex >= currentQueue.length) return;
        if (toIndex < 0 || toIndex >= currentQueue.length) return;

        const [track] = currentQueue.splice(fromIndex, 1);
        currentQueue.splice(toIndex, 0, track);

        if (this.currentQueueIndex === fromIndex) {
            this.currentQueueIndex = toIndex;
        } else if (fromIndex < this.currentQueueIndex && toIndex >= this.currentQueueIndex) {
            this.currentQueueIndex--;
        } else if (fromIndex > this.currentQueueIndex && toIndex <= this.currentQueueIndex) {
            this.currentQueueIndex++;
        }
        this.saveQueueState();
    }

    getCurrentQueue() {
        return this.shuffleActive ? this.shuffledQueue : this.queue;
    }

    getNextTrack() {
        const currentQueue = this.getCurrentQueue();
        if (this.currentQueueIndex === -1 || currentQueue.length === 0) return null;

        const nextIndex = this.currentQueueIndex + 1;
        if (nextIndex < currentQueue.length) {
            return currentQueue[nextIndex];
        } else if (this.repeatMode === REPEAT_MODE.ALL) {
            return currentQueue[0];
        }
        return null;
    }

    loadAlbumYear(track, trackArtistsHTML, artistEl) {
        if (!trackDateSettings.useAlbumYear()) return;

        this.api
            .getAlbum(track.album.id)
            .then(({ album }) => {
                if (album?.releaseDate && this.currentTrack?.id === track.id) {
                    track.album.releaseDate = album.releaseDate;
                    const year = new Date(album.releaseDate).getFullYear();
                    if (!isNaN(year) && artistEl) {
                        artistEl.innerHTML = `${trackArtistsHTML} • ${year}`;
                    }
                }
            })
            .catch(() => {});
    }

    updatePlayingTrackIndicator() {
        const currentTrack = this.getCurrentQueue()[this.currentQueueIndex];
        let activeTrackElement = this._activeTrackElement || null;
        if (activeTrackElement) {
            const stillInDom = document.body.contains(activeTrackElement);
            const sameTrack = currentTrack && activeTrackElement.dataset.trackId == currentTrack.id;
            if (!stillInDom || !sameTrack) {
                activeTrackElement = null;
                this._activeTrackElement = null;
            }
        }

        document.querySelectorAll('.track-item').forEach((item) => {
            const isPlaying = activeTrackElement
                ? item === activeTrackElement
                : currentTrack && item.dataset.trackId == currentTrack.id;
            item.classList.toggle('playing', Boolean(isPlaying));
        });

        document.querySelectorAll('.queue-track-item').forEach((item) => {
            const index = parseInt(item.dataset.queueIndex);
            item.classList.toggle('playing', index === this.currentQueueIndex);
        });
    }

    _applyMediaSessionMetadata(track, metadata, refreshDelays = [0, 220, 900]) {
        if (!('mediaSession' in navigator)) return;
        const delays = Array.isArray(refreshDelays) && refreshDelays.length ? refreshDelays : [0];

        for (const delay of delays) {
            const run = () => {
                if (this.currentTrack !== track) return;
                try {
                    navigator.mediaSession.metadata = new MediaMetadata(metadata);
                } catch {
                    /* ignore */
                }
            };

            if (!delay) {
                run();
            } else {
                setTimeout(run, delay);
            }
        }
    }

    updateMediaSession(track) {
        if (!('mediaSession' in navigator)) return;

        // Force a refresh for picky Bluetooth systems by clearing metadata first
        navigator.mediaSession.metadata = null;

        const coverId = track.album?.cover;
        const trackTitle = getTrackTitle(track);
        const artist = getTrackArtists(track) || 'Unknown Artist';
        const album = track.album?.title || 'Unknown Album';
        const artworkUrl = this._resolveMediaSessionArtworkUrl(track, coverId);

        const baseMetadata = {
            title: trackTitle || 'Unknown Title',
            artist,
            album,
            artwork: artworkUrl
                ? [
                      { src: artworkUrl, sizes: '96x96', type: 'image/jpeg' },
                      { src: artworkUrl, sizes: '192x192', type: 'image/jpeg' },
                      { src: artworkUrl, sizes: '320x320', type: 'image/jpeg' },
                      { src: artworkUrl, sizes: '512x512', type: 'image/jpeg' },
                  ]
                : undefined,
        };

        // Some Linux web integrations read metadata once and may miss later updates.
        this._applyMediaSessionMetadata(track, baseMetadata);

        this.updateMediaSessionPlaybackState();
        this.updateMediaSessionPositionState();

        // Fetch cover art as a blob so the OS media overlay can display it.
        // Direct CDN URLs (resources.tidal.com, static.qobuz.com) are cross-origin
        // and browsers won't let the OS read them for the lock-screen / media widget.
        // We load via an <img> (which bypasses CORS), paint to canvas, and extract a blob.
        if (artworkUrl) {
            this._loadMediaSessionArtwork(track, trackTitle, artist, album, artworkUrl);
        }
    }

    _resolveMediaSessionArtworkUrl(track, coverId) {
        const toAbsolute = (value) => {
            if (!value || typeof value !== 'string') return null;
            if (value.startsWith('blob:') || value.startsWith('data:')) return value;
            try {
                return new URL(value, `${window.location.origin}/`).href;
            } catch {
                return value;
            }
        };

        const candidates = [];

        if (coverId) {
            candidates.push(this.api.getCoverUrl(coverId, '480'));
        }

        if (track?.artwork) {
            candidates.push(track.artwork);
        }

        if (track?.album?.cover && track.album.cover !== coverId) {
            candidates.push(this.api.getCoverUrl(track.album.cover, '480'));
        }

        const uiCover = document.querySelector('.now-playing-bar .cover')?.getAttribute('src');
        if (uiCover) {
            candidates.push(uiCover);
        }

        candidates.push('assets/appicon.png');

        for (const candidate of candidates) {
            const absolute = toAbsolute(candidate);
            if (absolute) return absolute;
        }

        return null;
    }

    async _loadMediaSessionArtwork(track, trackTitle, artist, album, coverUrl) {
        let url = coverUrl;
        if (typeof coverUrl === 'string' && /^https?:/i.test(coverUrl)) {
            try {
                const img = await window.__corsBypass?.loadImageWithCorsBypass(coverUrl);
                if (img) {
                    this._applyMediaSessionArtworkFromImage(track, img, trackTitle, artist, album, coverUrl);
                    return;
                }
            } catch {
                /* fall through to legacy loading below */
            }
            if (window.location.hostname === 'localhost') {
                url = `/cors-proxy/${encodeURIComponent(coverUrl)}`;
            } else if (window.location.hostname !== 'localhost') {
                url = `https://corsproxy.io/proxy?url=${encodeURIComponent(coverUrl)}`;
            }
        }

        const img = new Image();
        if (typeof coverUrl === 'string' && /^https?:/i.test(coverUrl)) {
            img.crossOrigin = 'anonymous';
        }
        img.onload = () => {
            if (this.currentTrack !== track) return;
            this._applyMediaSessionArtworkFromImage(track, img, trackTitle, artist, album, coverUrl);
        };
        img.onerror = () => {
            this._fallbackMediaSessionArtwork(track, trackTitle, artist, album, coverUrl);
        };
        img.src = url;
    }

    _applyMediaSessionArtworkFromImage(track, img, trackTitle, artist, album, coverUrl) {
        if (this.currentTrack !== track) return;
        try {
            const canvas = document.createElement('canvas');
            const size = 256;
            canvas.width = size;
            canvas.height = size;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, size, size);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.86);
            this._applyMediaSessionMetadata(track, {
                title: trackTitle || 'Unknown Title',
                artist,
                album,
                artwork: [
                    { src: dataUrl, sizes: `${size}x${size}`, type: 'image/jpeg' },
                    { src: coverUrl, sizes: '480x480', type: 'image/jpeg' },
                ],
            });
        } catch {
            // Canvas tainted by CORS – fall back to direct URL
            this._applyMediaSessionMetadata(track, {
                title: trackTitle || 'Unknown Title',
                artist,
                album,
                artwork: [{ src: coverUrl, sizes: '480x480', type: 'image/jpeg' }],
            });
        }
    }

    // If crossOrigin='anonymous' is rejected, retry without it (direct URL fallback)
    _fallbackMediaSessionArtwork(track, trackTitle, artist, album, coverUrl) {
        if (this.currentTrack !== track) return;
        this._applyMediaSessionMetadata(track, {
            title: trackTitle || 'Unknown Title',
            artist,
            album,
            artwork: [{ src: coverUrl, sizes: '480x480', type: 'image/jpeg' }],
        });
    }

    updateMediaSessionPlaybackState() {
        if (!('mediaSession' in navigator)) return;
        navigator.mediaSession.playbackState = this.audio.paused ? 'paused' : 'playing';
    }

    updateMediaSessionPositionState() {
        if (!('mediaSession' in navigator)) return;
        if (!('setPositionState' in navigator.mediaSession)) return;

        const duration = this.audio.duration;

        if (!duration || isNaN(duration) || !isFinite(duration)) {
            return;
        }

        try {
            navigator.mediaSession.setPositionState({
                duration: duration,
                playbackRate: this.audio.playbackRate || 1,
                position: Math.min(this.audio.currentTime, duration),
            });
        } catch (error) {
            console.log('Failed to update Media Session position:', error);
        }
    }

    // Sleep Timer Methods
    setSleepTimer(minutes) {
        this.clearSleepTimer(); // Clear any existing timer

        this.sleepTimerEndTime = Date.now() + minutes * 60 * 1000;

        this.sleepTimer = setTimeout(
            () => {
                this.audio.pause();
                this.clearSleepTimer();
                this.updateSleepTimerUI();
            },
            minutes * 60 * 1000
        );

        // Update UI every second
        this.sleepTimerInterval = setInterval(() => {
            this.updateSleepTimerUI();
        }, 1000);

        this.updateSleepTimerUI();
    }

    clearSleepTimer() {
        if (this.sleepTimer) {
            clearTimeout(this.sleepTimer);
            this.sleepTimer = null;
        }
        if (this.sleepTimerInterval) {
            clearInterval(this.sleepTimerInterval);
            this.sleepTimerInterval = null;
        }
        this.sleepTimerEndTime = null;
        this.updateSleepTimerUI();
    }

    getSleepTimerRemaining() {
        if (!this.sleepTimerEndTime) return null;
        const remaining = Math.max(0, this.sleepTimerEndTime - Date.now());
        return Math.ceil(remaining / 1000); // Return seconds remaining
    }

    isSleepTimerActive() {
        return this.sleepTimer !== null;
    }

    updateSleepTimerUI() {
        const timerBtn = document.getElementById('sleep-timer-btn');
        const timerBtnDesktop = document.getElementById('sleep-timer-btn-desktop');

        const updateBtn = (btn) => {
            if (!btn) return;
            if (this.isSleepTimerActive()) {
                const remaining = this.getSleepTimerRemaining();
                if (remaining > 0) {
                    const minutes = Math.floor(remaining / 60);
                    const seconds = remaining % 60;
                    btn.innerHTML = `<span style="font-size: 12px; font-weight: bold;">${minutes}:${seconds.toString().padStart(2, '0')}</span>`;
                    btn.title = `Sleep Timer: ${minutes}:${seconds.toString().padStart(2, '0')} remaining`;
                    btn.classList.add('active');
                    btn.style.color = 'var(--primary)';
                } else {
                    btn.innerHTML = `
                        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <circle cx="12" cy="12" r="10"/>
                            <polyline points="12,6 12,12 16,14"/>
                        </svg>
                    `;
                    btn.title = 'Sleep Timer';
                    btn.classList.remove('active');
                    btn.style.color = '';
                }
            } else {
                btn.innerHTML = `
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="12" cy="12" r="10"/>
                        <polyline points="12,6 12,12 16,14"/>
                    </svg>
                `;
                btn.title = 'Sleep Timer';
                btn.classList.remove('active');
                btn.style.color = '';
            }
        };

        updateBtn(timerBtn);
        updateBtn(timerBtnDesktop);
    }

    async updateNativeWindow(track) {
        const trackTitle = getTrackTitle(track);
        const artist = getTrackArtists(track);
        document.title = `${trackTitle} • ${artist}`;
    }

    // Teardown the Howler bridge and restore native audio element methods
    _teardownHowlerBridge() {
        if (!this._howlerBridgeTarget) return;

        // Restore native methods by deleting the overridden instance properties
        // This lets the prototype's native implementations show through again
        try {
            delete this.audio.play;
            delete this.audio.pause;
        } catch {
            /* ignore */
        }

        // Restore native property descriptors
        try {
            delete this.audio.currentTime;
        } catch {
            /* ignore */
        }
        try {
            delete this.audio.duration;
        } catch {
            /* ignore */
        }
        try {
            delete this.audio.paused;
        } catch {
            /* ignore */
        }

        this._howlerBridgeTarget = null;
    }

    // Cleanly stop and unload the current Howler sound with a quick fade to prevent jitter/clicks
    _cleanupHowler() {
        this._stopHowlerMonitor();

        const sound = this._howlerSound;
        if (!sound) return;

        // Detach event handlers to prevent callbacks firing during teardown
        sound.off('onend');
        sound.off('onplay');
        sound.off('onpause');
        sound.off('onstop');

        // Quick fade out to prevent click/pop artifacts. Keep the window very
        // short so a superseding load never has both sounds audible at once.
        try {
            const currentVolume = sound.volume();
            if (sound.playing() && currentVolume > 0) {
                sound.fade(currentVolume, 0, 30);
                // Schedule unload after fade completes
                setTimeout(() => {
                    try {
                        sound.unload();
                    } catch {
                        /* ignore */
                    }
                }, 50);
            } else {
                sound.stop();
                sound.unload();
            }
        } catch {
            try {
                sound.unload();
            } catch {
                /* ignore */
            }
        }

        this._howlerSound = null;
        this._howlerDurationHint = 0;
        this._howlerLastPosition = 0;
        this._howlerLastProgressAt = 0;
        this._howlerRecoveryAttempts = 0;
        this._teardownHowlerBridge();
    }

    // Howler-based audio playback for better streaming support
    async loadWithNativeAudio(streamUrl, startTime = 0) {
        this._cleanupHowler();
        this.audio.pause();
        this.audio.preload = 'auto';
        this.audio.src = streamUrl;
        this.audio.load();

        if (startTime > 0) {
            await new Promise((resolve) => {
                if (this.audio.readyState >= HTMLMediaElement.HAVE_METADATA) {
                    resolve();
                    return;
                }
                this.audio.addEventListener('loadedmetadata', resolve, { once: true });
            });
            this.audio.currentTime = startTime;
        }

        if (!audioContextManager.isReady()) {
            audioContextManager.init(this.audio);
        }
        await audioContextManager.resume();
        this.applyReplayGain();
        await this.audio.play();
        this.startPlaybackMonitor();
        return this.audio;
    }

    async loadWithHowler(streamUrl, startTime = 0) {
        const { Howl, Howler } = await import('howler');

        // Allow more concurrent html5 elements for seamless transitions on heavy queues.
        if (typeof Howler.html5PoolSize === 'number' && Howler.html5PoolSize < 20) {
            Howler.html5PoolSize = 20;
        }

        // Start html5 audio as soon as the browser has buffered enough data to
        // begin playback ('canplay') instead of waiting for 'canplaythrough'.
        // 'canplaythrough' only fires once the whole file (or a very large
        // chunk) is buffered, which makes lossless/Hi-Res tracks take seconds
        // to start. 'canplay' gives near-instant start while the browser keeps
        // streaming the rest in the background.
        Howler._canPlayEvent = 'canplay';

        // Clean up previous Howler sound with fade to prevent jitter
        this._cleanupHowler();

        // Create new Howl with HTML5 mode for streaming
        this._howlerSound = new Howl({
            src: [streamUrl],
            html5: true, // Force HTML5 Audio for streaming large files
            preload: true,
            autoplay: true,
            pool: 1,
            volume: this.userVolume,
            mute: Boolean(this.audio.muted),
            format: ['flac', 'mp3', 'aac', 'ogg', 'wav', 'm4a'],
            xhr: {
                withCredentials: false,
            },
            onload: () => {
                console.log('[Howler] Audio loaded successfully');
                if (this._howlerSound) {
                    this._howlerDurationHint = this._howlerSound.duration() || 0;
                }
                // Notify the app that a new track started loading so playback
                // listeners reset their per-track state.
                try {
                    this.audio.dispatchEvent(new Event('loadstart'));
                } catch {
                    /* ignore */
                }
            },
            onloaderror: (id, error) => {
                console.error('[Howler] Load error:', error);
                const failedSound = this._howlerSound;
                if (!failedSound) return;

                // Clear the buffering state so the play button stops spinning.
                try {
                    this.audio.dispatchEvent(new Event('error'));
                } catch {
                    /* ignore */
                }

                // If this sound is still the active one and never started
                // playing (e.g. a cached stream URL was invalidated server-side
                // before its nominal expiry, or the browser can't decode the
                // format), recover or skip to the next track instead of hanging.
                setTimeout(async () => {
                    if (this._howlerSound !== failedSound || failedSound.playing()) return;

                    const track = this.currentTrack;
                    if (track && !track.isLocal && !this._streamLoadRetries?.get(String(track.id))) {
                        (this._streamLoadRetries ||= new Map()).set(String(track.id), true);
                        try {
                            const pos = typeof failedSound.seek === 'function' ? failedSound.seek() : 0;
                            this._cleanupHowler();
                            await this._recoverWithFreshStream(Math.max(0, pos || 0));
                            return;
                        } catch (err) {
                            console.warn('[Howler] Fresh stream retry failed:', err);
                        }
                    }

                    this._cleanupHowler();
                    this.playNext(1);
                }, 400);
            },
            onplayerror: (id, error) => {
                console.error('[Howler] Play error:', error);
                // Autoplay was blocked because play() ran outside a user
                // gesture (e.g. after an async stream resolution). Retry once
                // on the next user interaction — media playback is then allowed.
                if (/user interaction|NotAllowedError|autoplay/i.test(String(error?.message || error))) {
                    const retryPlay = () => {
                        document.removeEventListener('pointerdown', retryPlay);
                        document.removeEventListener('keydown', retryPlay);
                        if (this._howlerSound && !this._howlerSound.playing()) {
                            this._howlerSound.play();
                        }
                    };
                    document.addEventListener('pointerdown', retryPlay, { once: true });
                    document.addEventListener('keydown', retryPlay, { once: true });
                }
            },
            onend: () => {
                this._stopHowlerMonitor();
                // Forward the ended event through the main audio element so
                // recently-played history and status listeners see the track
                // finish. handleTrackEnded is guarded against double-advance
                // (the element's own 'ended' listener calls it too).
                try {
                    this.audio.dispatchEvent(new Event('ended'));
                } catch {
                    /* ignore */
                }
                this.handleTrackEnded();
            },
            onplay: () => {
                try {
                    this.audio.dispatchEvent(new Event('play'));
                    this.audio.dispatchEvent(new Event('playing'));
                } catch {
                    /* ignore */
                }
                this._syncHowlerToAudio();
                this._howlerPlaybackMonitor();
                this.startPlaybackMonitor();
                this._warmupCurrentTrack(streamUrl);
                this.scheduleBackgroundPreload(150);
            },
            onpause: () => {
                try {
                    this.audio.dispatchEvent(new Event('pause'));
                } catch {
                    /* ignore */
                }
                this._syncHowlerToAudio();
                this.stopPlaybackMonitor();
            },
            onstop: () => {
                try {
                    this.audio.dispatchEvent(new Event('pause'));
                } catch {
                    /* ignore */
                }
                this._syncHowlerToAudio();
                this.stopPlaybackMonitor();
            },
        });

        // Seek to start position if needed
        if (startTime > 0) {
            this._howlerSound.seek(startTime);
        }

        // Play
        this._howlerSound.play();

        // Reflect ReplayGain scaling and the user's volume on the new sound.
        this.applyReplayGain();

        // Setup bridge to sync Howler state to audio element for UI
        this._setupHowlerBridge();

        return this._howlerSound;
    }

    // Sync Howler state to audio element for UI compatibility
    _syncHowlerToAudio() {
        if (!this._howlerSound) return;

        // Keep metadata hint fresh for UIs relying on element duration reads.
        const duration = this._howlerSound.duration();
        if (Number.isFinite(duration) && duration > 0) {
            this._howlerDurationHint = duration;
        }

        // Update media session position state (does NOT write to audio element
        // to avoid recursive calls through the Howler bridge setter)
        this.updateMediaSessionPositionState();
    }

    // Monitor Howler playback and sync to audio element
    _howlerPlaybackMonitor() {
        if (!this._howlerSound || this._howlerMonitorInterval) return;

        this._howlerLastProgressAt = Date.now();
        this._howlerMonitorInterval = setInterval(() => {
            if (this._howlerSound && this._howlerSound.playing()) {
                // Forward real playback progress through the main audio element
                // so app listeners (recently-played history, status heartbeat,
                // progress UI, lyrics) see timeupdate events during Howler
                // playback.
                try {
                    this.audio.dispatchEvent(new Event('timeupdate'));
                } catch {
                    /* ignore */
                }

                const pos = this._howlerSound.seek();
                const duration = this._howlerDurationHint || this._howlerSound.duration() || 0;
                const hasPosition = typeof pos === 'number' && Number.isFinite(pos);

                if (hasPosition) {
                    if (pos > this._howlerLastPosition + 0.05) {
                        this._howlerLastProgressAt = Date.now();
                        this._howlerRecoveryAttempts = 0;
                    } else {
                        const stalledMs = Date.now() - this._howlerLastProgressAt;
                        const nearEnd = duration > 0 && pos >= duration - 1.2;

                        // Detect preview/sample stall: stuck near 30s with no progress
                        const isPreviewStall = pos >= 28 && pos <= 35 && stalledMs > 1800;

                        if (isPreviewStall && this._howlerRecoveryAttempts < 2) {
                            // Likely a preview/sample URL - try fresh stream URL
                            this._howlerRecoveryAttempts += 1;
                            this._howlerLastProgressAt = Date.now();
                            console.warn(
                                `[Howler] Detected preview stall at ${pos.toFixed(1)}s, attempting fresh stream recovery (attempt ${this._howlerRecoveryAttempts})`
                            );
                            this._recoverWithFreshStream(pos);
                        } else if (isPreviewStall && this._howlerRecoveryAttempts >= 2) {
                            // Fresh-stream recovery didn't help. Some addons
                            // serve previews that never progress — but a slow
                            // source must not be skipped either. Keep waiting.
                            console.warn('[Howler] Preview stall recovery failed, keeping wait');
                            this._howlerLastProgressAt = Date.now();
                        } else if (stalledMs > 1800 && !nearEnd && this._howlerRecoveryAttempts < 8) {
                            // Regular buffering stall - try reload
                            this._howlerRecoveryAttempts += 1;
                            this._howlerLastProgressAt = Date.now();
                            const node = this._howlerSound._sounds?.[0]?._node;
                            try {
                                if (node && typeof node.load === 'function' && node.readyState < 3) {
                                    node.load();
                                }
                                if (typeof pos === 'number' && pos > 0.25) {
                                    this._howlerSound.seek(Math.max(0, pos - 0.12));
                                }
                                this._howlerSound.play();
                            } catch (error) {
                                console.warn('[Howler] Playback recovery attempt failed:', error);
                            }
                        } else if (stalledMs > 12000 && !nearEnd) {
                            // Sources can buffer very slowly (addon relays,
                            // slow CDNs). Never skip on a slow load — the audio
                            // element resumes on its own once data arrives.
                            console.warn('[Howler] Audio still buffering, keeping wait');
                            this._howlerLastProgressAt = Date.now();
                        }
                    }
                    this._howlerLastPosition = pos;
                }
                this._syncHowlerToAudio();
            } else {
                this._stopHowlerMonitor();
            }
        }, 250);
    }

    async _recoverWithFreshStream(currentPosition) {
        if (!this.currentTrack) return;

        try {
            // Clear cached stream URL for this track to force fresh fetch
            const trackId = this.currentTrack.id;
            const effectiveQuality = this._getEffectivePlaybackQuality(this.quality);
            const cacheKey = `stream_${trackId}_${effectiveQuality}`;
            if (this.api?.tidalAPI?.streamCache) {
                this.api.tidalAPI.streamCache.delete(cacheKey);
                this.api.tidalAPI.forgetStreamUrl?.(trackId, effectiveQuality);
            } else if (this.api?.streamCache) {
                this.api.streamCache.delete(cacheKey);
            }
            this.preloadCache.delete(trackId);

            // Also clear the track lookup cache to get fresh playback info
            if (this.api?.tidalAPI?.cache) {
                try {
                    const { audioProcessingSettings } = await import('./storage.js');
                    const pureSuffix = audioProcessingSettings.isPure() ? 'pure' : 'norm';
                    await this.api.tidalAPI.cache.delete('track', `${trackId}_${effectiveQuality}_${pureSuffix}`);
                } catch {
                    /* ignore */
                }
            }

            // Re-fetch stream URL
            const streamInfo = await this.api.getStreamUrl(trackId, effectiveQuality, null, this.currentTrack);
            let newUrl = streamInfo;
            if (typeof streamInfo === 'object' && streamInfo.url) {
                newUrl = streamInfo.url;
            }

            if (!newUrl) {
                console.warn('[Howler] Fresh stream URL fetch returned empty');
                return;
            }

            // Reload Howler with fresh URL
            await this.loadWithHowler(newUrl, Math.max(0, currentPosition - 0.5));
        } catch (error) {
            console.warn('[Howler] Fresh stream recovery failed:', error);
        }
    }

    // Stop Howler monitor
    _stopHowlerMonitor() {
        if (this._howlerMonitorInterval) {
            clearInterval(this._howlerMonitorInterval);
            this._howlerMonitorInterval = null;
        }
    }

    // Override audio methods when using Howler
    _setupHowlerBridge() {
        if (!this._howlerSound || this._howlerBridgeTarget === this.audio) return;

        const self = this;
        this._howlerBridgeTarget = this.audio;

        // Resolve native accessors from prototype chain once.
        const resolveDescriptor = (obj, key) => {
            let target = obj;
            while (target) {
                const desc = Object.getOwnPropertyDescriptor(target, key);
                if (desc) return desc;
                target = Object.getPrototypeOf(target);
            }
            return null;
        };

        const mediaProto = Object.getPrototypeOf(this.audio);
        const nativeCurrentTime = resolveDescriptor(mediaProto, 'currentTime');
        const nativeDuration = resolveDescriptor(mediaProto, 'duration');
        const nativePaused = resolveDescriptor(mediaProto, 'paused');

        // Override pause
        this.audio.pause = function () {
            if (self._howlerSound) {
                self._howlerSound.pause();
                self._syncHowlerToAudio();
            }
            return Promise.resolve();
        };

        // Override play
        this.audio.play = function () {
            if (self._howlerSound) {
                self._howlerSound.play();
                self._syncHowlerToAudio();
            }
            return Promise.resolve();
        };

        // Bridge media properties through Howler without writing read-only element props.
        Object.defineProperty(this.audio, 'currentTime', {
            configurable: true,
            enumerable: true,
            get() {
                if (self._howlerSound) {
                    const pos = self._howlerSound.seek();
                    return typeof pos === 'number' ? pos : 0;
                }
                return nativeCurrentTime?.get ? nativeCurrentTime.get.call(this) : 0;
            },
            set(val) {
                if (self._howlerSound) {
                    self._howlerSound.seek(Math.max(0, Number(val) || 0));
                    self._syncHowlerToAudio();
                    return;
                }
                if (nativeCurrentTime?.set) {
                    nativeCurrentTime.set.call(this, val);
                }
            },
        });

        Object.defineProperty(this.audio, 'duration', {
            configurable: true,
            enumerable: true,
            get() {
                if (self._howlerSound) {
                    return self._howlerDurationHint || self._howlerSound.duration() || 0;
                }
                return nativeDuration?.get ? nativeDuration.get.call(this) : 0;
            },
        });

        Object.defineProperty(this.audio, 'paused', {
            configurable: true,
            enumerable: true,
            get() {
                if (self._howlerSound) {
                    return !self._howlerSound.playing();
                }
                return nativePaused?.get ? nativePaused.get.call(this) : true;
            },
        });
    }
}
