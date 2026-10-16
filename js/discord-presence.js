import { discordPresenceStorage } from './storage.js';
import { deriveTrackQuality, extractCodecFromMime, isLossyCodec, isLossyContainer, toPositiveInt } from './utils.js';

const BRIDGE_URLS = ['/api/discord', 'http://127.0.0.1:37710/api/discord'];
const FETCH_TIMEOUT_MS = 3000;
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 30000];
const POLL_INTERVAL_MS = 15000;

const QUALITY_LABELS = {
    DOLBY_ATMOS: 'Dolby Atmos',
    HI_RES_LOSSLESS: 'HI-RES LOSSLESS',
    LOSSLESS: 'LOSSLESS',
    HIGH: 'HIGH',
    LOW: 'LOW',
};

function formatSampleRate(sampleRate) {
    const rate = toPositiveInt(sampleRate);
    if (!rate) return null;
    if (rate >= 1000) return `${(rate / 1000).toFixed(rate % 1000 === 0 ? 0 : 1)} kHz`;
    return `${rate} Hz`;
}

// Mirrors createFullscreenQualityHTML so the Discord presence reads exactly
// like the fullscreen quality line (label · bit depth · sample rate · codec · bitrate).
export function buildQualitySummary(track) {
    if (!track) return null;

    const bitDepth = toPositiveInt(track.bitDepth || track.album?.bitDepth);
    const sampleRate = formatSampleRate(track.sampleRate || track.album?.sampleRate);

    const codec = extractCodecFromMime(track.codec || track.mimeType || track.format || track.mediaType);
    const rawFormat = String(track.format || track.mediaType || '').toUpperCase();
    const containerFormat = rawFormat && !/UNKNOWN|AUDIO|HLS|ADAPTIVE|DASH/i.test(rawFormat) ? rawFormat : null;
    const formatStr = codec || containerFormat || null;

    const lossy = codec ? isLossyCodec(codec) : isLossyContainer(track.format || track.mediaType);
    const bitrateStr = toPositiveInt(track.bitrateKbps) ? `${track.bitrateKbps} kbps` : null;

    const qualityToken = deriveTrackQuality(track);
    let qualityLabel;
    if (qualityToken === 'DOLBY_ATMOS') {
        qualityLabel = 'Dolby Atmos';
    } else if (lossy) {
        qualityLabel = 'HIGH';
    } else if (QUALITY_LABELS[qualityToken]) {
        qualityLabel = QUALITY_LABELS[qualityToken];
    } else if (bitDepth || sampleRate) {
        const rate = toPositiveInt(track.sampleRate || track.album?.sampleRate);
        if (bitDepth >= 24 && rate > 48000) {
            qualityLabel = 'HI-RES LOSSLESS';
        } else if (bitDepth || rate) {
            qualityLabel = 'LOSSLESS';
        } else {
            qualityLabel = 'LOSSLESS';
        }
    } else {
        qualityLabel = 'LOSSLESS';
    }

    const parts = [qualityLabel];
    if (bitDepth) parts.push(`${bitDepth}-bit`);
    if (sampleRate) parts.push(sampleRate);
    if (formatStr) parts.push(formatStr);
    if (bitrateStr) parts.push(bitrateStr);

    const validParts = parts.filter((part) => part && typeof part === 'string' && part.trim());
    return validParts.length ? validParts.join(' \u00b7 ') : null;
}

function getTrackArtist(track) {
    if (!track) return 'Unknown Artist';
    const artists = Array.isArray(track.artists)
        ? track.artists.map((artist) => (typeof artist === 'string' ? artist : artist?.name || null)).filter(Boolean)
        : [];
    if (artists.length) return artists.join(', ');
    if (track.artist?.name) return track.artist.name;
    if (typeof track.artist === 'string') return track.artist;
    return 'Unknown Artist';
}

function getTrackAlbum(track) {
    return track?.album?.title || track?.albumTitle || null;
}

function resolveCoverUrl(track, api) {
    if (!track || !api || typeof api.getCoverUrl !== 'function') return null;
    try {
        const cover = track.album?.cover || track.albumCover || null;
        if (!cover) return null;
        const url = api.getCoverUrl(cover);
        if (typeof url === 'string' && /^https?:\/\//i.test(url)) return url;
    } catch {
        return null;
    }
    return null;
}

export class DiscordPresence {
    constructor() {
        this.bridgeBase = null;
        this.enabled = false;
        this.disposed = false;
        this.retryDelayIndex = 0;
        this.reconnectTimer = null;
        this.pollTimer = null;
        this.pendingActivity = null;
        this.onStatusChange = null;
        this.clientId = null;
        this.api = null;
        this.status = 'disabled';
        this.connected = false;
        this.fetchSeq = 0;
    }

    setStatus(status) {
        this.status = status;
        if (typeof this.onStatusChange === 'function') {
            try {
                this.onStatusChange(status);
            } catch {
                // status observers must never break presence
            }
        }
    }

    setApi(api) {
        this.api = api;
    }

    isActive() {
        return this.enabled && !!this.bridgeBase && this.connected;
    }

    async _bridgeFetch(path, options) {
        const seq = ++this.fetchSeq;
        for (const base of BRIDGE_URLS) {
            if (seq !== this.fetchSeq) return null;
            try {
                const res = await fetch(`${base}${path}`, {
                    ...options,
                    cache: 'no-store',
                    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
                });
                if (!res.ok) continue;
                return { base, data: await res.json() };
            } catch {
                // try next bridge location
            }
        }
        return null;
    }

    async _bridgeConnect(clientId) {
        const seq = ++this.fetchSeq;
        for (const base of BRIDGE_URLS) {
            if (seq !== this.fetchSeq) return null;
            try {
                const res = await fetch(`${base}/connect`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ clientId }),
                    cache: 'no-store',
                    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
                });
                if (res.status === 503) {
                    return { base, connected: false };
                }
                if (res.ok) {
                    return { base, connected: true };
                }
            } catch {
                // try next bridge location
            }
        }
        return null;
    }

    async connect() {
        if (this.disposed) return;
        const clientId = discordPresenceStorage.getClientId();
        if (!clientId) {
            this.setStatus('no-client-id');
            return;
        }
        this.enabled = true;
        this.clientId = clientId;
        if (this.connected) return;

        this.setStatus('connecting');
        const found = await this._bridgeConnect(clientId);
        if (!found) {
            this.bridgeBase = null;
            this.connected = false;
            this.setStatus('no-bridge');
            this.scheduleReconnect();
            this.startPolling();
            return;
        }

        this.bridgeBase = found.base;
        this.retryDelayIndex = 0;
        if (found.connected) {
            this.connected = true;
            this.setStatus('connected');
            this.flushPendingActivity();
        } else {
            this.connected = false;
            this.setStatus('offline');
            this.scheduleReconnect();
        }
        this.startPolling();
    }

    disconnect() {
        this.enabled = false;
        this.connected = false;
        this.bridgeBase = null;
        this.clientId = null;
        this.clearReconnectTimer();
        this.stopPolling();
        this.setStatus('disabled');
    }

    flushPendingActivity() {
        if (this.isActive() && this.pendingActivity) {
            this.sendActivity(this.pendingActivity);
        }
    }

    setTrack(track) {
        if (!track) return;
        const title = track.title || track.name || 'Unknown Track';
        const artist = getTrackArtist(track);
        const album = getTrackAlbum(track);
        const quality = buildQualitySummary(track);
        const coverUrl = resolveCoverUrl(track, this.api);

        const trackKey = `${title}\u0000${artist}\u0000${album}\u0000${quality || ''}`;
        const existing = this.pendingActivity;
        const now = Date.now();
        const durationMs =
            track.duration && toPositiveInt(track.duration) ? toPositiveInt(track.duration) * 1000 : null;

        const activity = {
            type: 2,
            details: title,
            state: [artist, quality].filter(Boolean).join(' \u00b7 '),
            timestamps: {},
            assets: {},
        };
        if (album) activity.assets.large_text = album;
        if (coverUrl) {
            activity.assets.large_image = coverUrl;
            if (album) activity.assets.small_text = album;
        }

        // Keep the original timestamps for updates of the same playing track
        // (e.g. quality metadata arriving late), but restart the progress
        // after a pause using the remaining time so the slider stays honest.
        if (existing && existing._trackKey === trackKey && !existing._paused && existing.timestamps?.start) {
            activity.timestamps.start = existing.timestamps.start;
            if (existing.timestamps.end) {
                activity.timestamps.end = existing.timestamps.end;
            }
        } else {
            let remainingMs = durationMs;
            if (existing && existing._trackKey === trackKey && existing._paused && existing._remainingMs) {
                remainingMs = existing._remainingMs;
            }
            activity.timestamps.start = now;
            if (durationMs !== null) {
                activity.timestamps.end = now + remainingMs;
            }
        }
        activity._trackKey = trackKey;
        if (durationMs !== null && activity.timestamps.end) {
            activity.secrets = { end: String(activity.timestamps.end) };
        }

        this.pendingActivity = activity;

        if (this.isActive()) {
            this.sendActivity(activity);
        }
    }

    setPaused() {
        if (!this.pendingActivity) return;
        const now = Date.now();
        const remainingMs =
            this.pendingActivity.timestamps?.end && this.pendingActivity.timestamps.end > now
                ? this.pendingActivity.timestamps.end - now
                : null;
        this.pendingActivity = {
            ...this.pendingActivity,
            _trackKey: this.pendingActivity._trackKey,
            _paused: true,
            _remainingMs: remainingMs,
            timestamps: { ...this.pendingActivity.timestamps },
        };
        if (this.isActive()) {
            this.sendActivity(this.pendingActivity);
        }
    }

    clear() {
        this.pendingActivity = null;
        if (this.isActive()) {
            this.sendClear();
        }
    }

    sendActivity(activity) {
        const payload = {
            type: activity.type,
            details: activity.details,
            state: activity.state,
            timestamps: activity.timestamps,
            assets: Object.keys(activity.assets || {}).length ? activity.assets : undefined,
            secrets: activity.secrets,
        };
        return this._postActivity(payload).catch(() => {});
    }

    sendClear() {
        return this._postActivity(null).catch(() => {});
    }

    async _postActivity(activity) {
        if (!this.bridgeBase) return;
        try {
            const res = await fetch(`${this.bridgeBase}/activity`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ clientId: this.clientId, activity }),
                cache: 'no-store',
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            });
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                if (res.status === 503) {
                    this.connected = false;
                    this.setStatus('offline');
                    this.scheduleReconnect();
                }
                throw new Error(body.error || `Bridge error ${res.status}`);
            }
        } catch {
            this.connected = false;
            this.setStatus('offline');
            this.scheduleReconnect();
        }
    }

    startPolling() {
        if (this.pollTimer || !this.enabled || this.disposed) return;
        this.pollTimer = setInterval(() => {
            if (!this.enabled || this.disposed) {
                this.stopPolling();
                return;
            }
            this.poll().catch(() => {});
        }, POLL_INTERVAL_MS);
    }

    stopPolling() {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
    }

    async poll() {
        if (!this.enabled || this.disposed) return;
        const found = await this._bridgeFetch('/status');
        if (!found) {
            this.bridgeBase = null;
            this.connected = false;
            if (this.status !== 'no-bridge') {
                this.setStatus('no-bridge');
                this.scheduleReconnect();
            }
            return;
        }
        this.bridgeBase = found.base;
        const wasConnected = this.connected;
        this.connected = !!(found.data && found.data.connected);
        if (this.connected && !wasConnected) {
            this.retryDelayIndex = 0;
            this.setStatus('connected');
            this.flushPendingActivity();
        } else if (!this.connected && wasConnected) {
            this.setStatus('offline');
        } else if (!this.connected && this.status === 'connecting') {
            this.setStatus('offline');
        }
    }

    clearReconnectTimer() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    scheduleReconnect() {
        if (!this.enabled || this.disposed) return;
        const delay = RECONNECT_DELAYS_MS[this.retryDelayIndex] || RECONNECT_DELAYS_MS[RECONNECT_DELAYS_MS.length - 1];
        this.retryDelayIndex = Math.min(this.retryDelayIndex + 1, RECONNECT_DELAYS_MS.length - 1);
        this.clearReconnectTimer();
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.enabled && !this.disposed) {
                this.connect().catch(() => {});
            }
        }, delay);
    }

    destroy() {
        this.disposed = true;
        this.clearReconnectTimer();
        this.stopPolling();
    }
}
