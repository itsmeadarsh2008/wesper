// js/eclipse.js
// Eclipse addon storage + client. The app's entire music backend is an Eclipse
// addon (https://eclipsemusic.app/docs): search, stream and catalog endpoints
// served by the user's addon. Responses are mapped to the shapes the rest of
// the app expects.

import { APICache } from './cache.js';
import { addMetadataToAudio } from './metadata.js';
import { DashDownloader } from './dash-downloader.js';
import { HlsDownloader } from './hls-downloader.js';
import { getExtensionFromBlob, isLossyCodec, isLossyContainer, RATE_LIMIT_ERROR_MESSAGE } from './utils.js';

const ADDON_STORAGE_KEY = 'monochrome-eclipse-addons-v1';
const LEGACY_ADDON_STORAGE_KEY = 'monochrome-eclipse-addon-v2';
const ACTIVE_ADDON_STORAGE_KEY = 'monochrome-eclipse-active-addon';

function addonIdentity(addon) {
    return String(addon?.manifest?.id || addon?.id || addon?.baseUrl || '').trim();
}

// Addon URL normalization — the URL path must always end in manifest.json.
// Pasted install URLs carry a query string AFTER manifest.json
// (e.g. .../quality/manifest.json?sources=tidal). Naive endsWith/append
// logic treats the query as part of the path, producing broken URLs like
// .../manifest.json?sources=tidal/manifest.json and search calls like
// .../manifest.json?sources=tidal/search?q=... (which hit the manifest
// route and return zero tracks instead of erroring).
function splitAddonUrl(input) {
    const noHash = String(input || '').trim().split('#')[0];
    const qIdx = noHash.indexOf('?');
    const path = (qIdx >= 0 ? noHash.slice(0, qIdx) : noHash).replace(/\/+$/, '');
    const query = qIdx >= 0 ? noHash.slice(qIdx + 1) : '';
    return { path, query };
}

// Base path of an addon (no manifest.json suffix, no query/hash, no
// trailing slash). Applied at every use site so already-stored installs
// with a query or manifest.json baked into baseUrl keep working.
function addonBasePath(input) {
    return splitAddonUrl(input).path.replace(/\/manifest\.json$/i, '');
}

function addonManifestUrl(input) {
    const { path, query } = splitAddonUrl(input);
    const base = path.replace(/\/manifest\.json$/i, '');
    if (!base) return '';
    return `${base}/manifest.json${query ? `?${query}` : ''}`;
}

export const eclipseAddonStorage = {
    getAddons() {
        try {
            const raw = localStorage.getItem(ADDON_STORAGE_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) return parsed.filter((addon) => addon?.baseUrl && addon?.manifest);
            }

            const legacyRaw = localStorage.getItem(LEGACY_ADDON_STORAGE_KEY);
            if (!legacyRaw) return [];
            const legacy = JSON.parse(legacyRaw);
            return legacy?.baseUrl ? [legacy] : [];
        } catch {
            return [];
        }
    },

    getActiveAddonId() {
        const addons = this.getAddons();
        let activeId = null;
        try {
            activeId = localStorage.getItem(ACTIVE_ADDON_STORAGE_KEY);
        } catch {
            /* ignore storage errors */
        }
        const active = addons.find((addon) => addonIdentity(addon) === activeId && addon.enabled !== false);
        return active ? activeId : addonIdentity(addons.find((addon) => addon.enabled !== false) || addons[0]);
    },

    getAddon() {
        return this.getAddonById(this.getActiveAddonId());
    },

    getAddonById(addonId) {
        const identity = String(addonId || '').trim();
        return this.getAddons().find((addon) => addonIdentity(addon) === identity) || null;
    },

    getAddonCandidates() {
        const addons = this.getAddons().filter((addon) => addon.enabled !== false);
        const activeId = this.getActiveAddonId();
        return addons.sort((a, b) => {
            if (addonIdentity(a) === activeId) return -1;
            if (addonIdentity(b) === activeId) return 1;
            return 0;
        });
    },

    saveAddon(addon) {
        const identity = addonIdentity(addon);
        if (!identity) throw new Error('Addon identity is required');
        const addons = this.getAddons();
        let activeId = null;
        try {
            activeId = localStorage.getItem(ACTIVE_ADDON_STORAGE_KEY);
        } catch {
            /* ignore storage errors */
        }
        const index = addons.findIndex((installed) => addonIdentity(installed) === identity);
        const saved = { ...addon, id: identity };
        if (index >= 0) addons[index] = saved;
        else addons.push(saved);
        localStorage.setItem(ADDON_STORAGE_KEY, JSON.stringify(addons));
        if (!activeId) this.setActiveAddon(identity);
        return saved;
    },

    setActiveAddon(addonId) {
        const identity = String(addonId || '').trim();
        if (!this.getAddonById(identity)) return false;
        localStorage.setItem(ACTIVE_ADDON_STORAGE_KEY, identity);
        return true;
    },

    setAddonEnabled(addonId, enabled) {
        const identity = String(addonId || '').trim();
        const addons = this.getAddons();
        const addon = addons.find((installed) => addonIdentity(installed) === identity);
        if (!addon) return false;
        if (!enabled && this.getAddonCandidates().length <= 1) return false;
        const wasActive = this.getActiveAddonId() === identity;
        addon.enabled = Boolean(enabled);
        localStorage.setItem(ADDON_STORAGE_KEY, JSON.stringify(addons));
        if (!addon.enabled && wasActive) {
            const next = this.getAddonCandidates()[0];
            if (next) this.setActiveAddon(addonIdentity(next));
        }
        return true;
    },

    // Patches stored fields (searchEnabled / streamEnabled / …) on an addon.
    updateAddon(addonId, patch) {
        const identity = String(addonId || '').trim();
        const addons = this.getAddons();
        const index = addons.findIndex((installed) => addonIdentity(installed) === identity);
        if (index < 0) return false;
        addons[index] = { ...addons[index], ...patch };
        localStorage.setItem(ADDON_STORAGE_KEY, JSON.stringify(addons));
        return true;
    },

    moveAddon(addonId, direction) {
        const identity = String(addonId || '').trim();
        const addons = this.getAddons();
        const index = addons.findIndex((addon) => addonIdentity(addon) === identity);
        const nextIndex = index + Number(direction);
        if (index < 0 || nextIndex < 0 || nextIndex >= addons.length) return false;
        [addons[index], addons[nextIndex]] = [addons[nextIndex], addons[index]];
        localStorage.setItem(ADDON_STORAGE_KEY, JSON.stringify(addons));
        return true;
    },

    removeAddon(addonId = this.getActiveAddonId()) {
        const addons = this.getAddons().filter((addon) => addonIdentity(addon) !== String(addonId || ''));
        localStorage.setItem(ADDON_STORAGE_KEY, JSON.stringify(addons));
        const next = addons[0];
        if (next) this.setActiveAddon(addonIdentity(next));
        else localStorage.removeItem(ACTIVE_ADDON_STORAGE_KEY);
        return next || null;
    },

    clearAddon() {
        this.removeAddon();
    },

    async fetchManifest(baseUrl) {
        const raw = String(baseUrl || '').trim();
        if (!raw) throw new Error('Addon URL is required');

        // The manifest URL path always ends in manifest.json — the query
        // string (e.g. ?sources=tidal) is re-attached AFTER it.
        const manifestUrl = addonManifestUrl(raw);
        if (!manifestUrl) throw new Error('Addon URL is required');
        // baseUrl never carries manifest.json or a query string, so search/
        // stream/catalog calls built as `${baseUrl}/<resource>` stay valid.
        const rootUrl = addonBasePath(raw) || manifestUrl;

        let res;
        try {
            res = await fetch(manifestUrl);
        } catch {
            throw new Error('Addon unreachable — check the URL and your connection');
        }
        if (!res.ok) throw new Error(`Addon unreachable (HTTP ${res.status})`);

        const manifest = await res.json();
        if (!manifest?.id || !Array.isArray(manifest.resources)) {
            throw new Error('Invalid addon manifest');
        }
        if (!manifest.resources.includes('search') || !manifest.resources.includes('stream')) {
            throw new Error('Addon must declare the "search" and "stream" resources');
        }
        return { ...manifest, rootUrl, manifestUrl };
    },

    async ensureInstalled(addonId = null) {
        return addonId ? this.getAddonById(addonId) : this.getAddon();
    },
};

export const NO_ADDON_MESSAGE = 'No Eclipse addon installed. Add one in Settings → Eclipse Addon.';

// Classifies an addon's base URL to explain why it works on one origin (the
// dev monitor) but not another (a deployed/hosted site).
export function classifyAddonHost(baseUrl) {
    try {
        const u = new URL(String(baseUrl || '').split('#')[0]);
        const hostname = u.hostname.toLowerCase();
        const isLoopback =
            hostname === 'localhost' ||
            hostname === '127.0.0.1' ||
            hostname === '::1' ||
            hostname === '[::1]' ||
            /^127\./.test(hostname);
        const isPrivateIp =
            !isLoopback &&
            (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostname) ||
                hostname.endsWith('.local') ||
                hostname.endsWith('.lan') ||
                hostname.endsWith('.internal'));
        const isInsecure = u.protocol === 'http:' && hostname !== 'localhost' && hostname !== '127.0.0.1';
        return {
            protocol: u.protocol,
            hostname,
            isLoopback,
            isPrivateIp,
            isInsecure,
        };
    } catch {
        return { protocol: '', hostname: '', isLoopback: false, isPrivateIp: false, isInsecure: false };
    }
}

// Probes whether this browser can actually reach an installed addon. Returns a
// classification plus a fetched flag so the UI can explain the failure.
export async function probeAddonReachability(addon) {
    const baseUrl = addonBasePath(addon?.baseUrl);
    const host = classifyAddonHost(baseUrl);
    if (!baseUrl) return { reachable: false, ...host, error: 'No addon URL configured.', hint: null };
    const manifestUrl = `${baseUrl}/manifest.json`;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 7000) : null;
    try {
        const res = await fetch(manifestUrl, controller ? { signal: controller.signal } : undefined);
        if (res.ok) {
            return { reachable: true, ...host, manifestUrl };
        }
        return { reachable: false, ...host, error: `HTTP ${res.status}`, manifestUrl };
    } catch (error) {
        let branch = null;
        let errorName = 'network error';
        if (error && (error.name === 'AbortError' || error.name === 'TimeoutError')) errorName = 'timed out';
        if (host.isLoopback || host.isPrivateIp) branch = 'localhost-or-lan';
        else if (host.isInsecure) branch = 'http-on-https';
        return {
            reachable: false,
            ...host,
            error: `${errorName}: ${error && error.message ? String(error.message) : ''}`,
            branch,
            manifestUrl,
        };
    } finally {
        if (timer) clearTimeout(timer);
    }
}

// Registers an addon-returned stream URL's host with the global CORS bypass.
// Addons may surface CDNs the app has never seen (e.g. a new Tidal/Qobuz host
// or an addon-hosted DASH/HLS manifest), so the host is added at runtime to the
// proxied set instead of waiting for a source redeploy.
function registerStreamHostForProxy(streamUrl) {
    if (typeof window === 'undefined' || !window.__corsBypass || !streamUrl) return;
    try {
        const parsed = new URL(streamUrl, window.location.href);
        if (!/^https?:$/i.test(parsed.protocol)) return;
        if (parsed.origin === window.location.origin) return;
        window.__corsBypass.addProxyHost(parsed.hostname);
    } catch {
        /* ignore malformed URLs */
    }
}

// Some Eclipse addons expose an HLS playlist through an extensionless
// `/dash/:id` route. The route name is legacy terminology: the response is
// still an HLS playlist, so the player must not treat it as a regular FLAC
// file. Explicit HLS/MPD URLs and addon mediaType values remain authoritative.
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

const SEARCH_CACHE_TTL = 15 * 60 * 1000;

// Resolved stream URLs are persisted to localStorage so replaying a track
// (even after a page reload) skips the addon round-trip entirely. Entries are
// only reused while comfortably inside their server-reported expiry, and any
// stale URL that fails to load is re-resolved once (see player loaderror retry).
const STREAM_CACHE_LOCAL_PREFIX = 'mc_stream_v1_';
// Cap local persistence at 24h even if the addon reports a longer expiry, to
// bound the chance of replaying a URL the server has since invalidated.
const STREAM_CACHE_LOCAL_MAX_TTL_MS = 24 * 60 * 60 * 1000;
// Margin before the server expiry after which we stop reusing an entry.
const STREAM_CACHE_EXPIRY_MARGIN_S = 120;

// Minimum gap between addon requests. The addon rate-limits aggressively,
// and the app fires bursts (home = 7 parallel searches, search page = 4).
const MIN_REQUEST_GAP_MS = 180;
// Stream URL resolutions (playback) use a faster lane so a freshly-queued play
// never waits a full 180ms behind search/catalog pacing.
const PRIORITY_REQUEST_GAP_MS = 60;
// Background work (billboard resolution, etc.) uses a more polite pace and
// only runs when the interactive queues are idle.
const BACKGROUND_REQUEST_GAP_MS = 450;
const MAX_429_RETRIES = 2;

// Wall-clock budget for persistent requests stuck behind a rate limit. Stream
// resolution and user-facing searches keep retrying until the window clears,
// but never stall the queue longer than this.
const MAX_PERSISTENT_WALL_MS = 45 * 1000;

// Interactive search uses a much tighter budget so results (or a visible
// failure) arrive quickly even when the addon is rate-limited; stream
// resolution keeps the full budget.
const SEARCH_WALL_MS = 15 * 1000;
const SEARCH_BACKOFF_CAP_MS = 5000;

// Global rate-limit freeze: once the addon answers 429, every queued request
// pauses until the limits clear instead of each failing and retrying on its
// own (bursts of parallel searches hammer the limit harder).
let addonRateLimitUntil = 0;
let lastRateLimitAt = 0;
let rateLimitNotifiedAt = 0;
const RATE_LIMIT_NOTIFY_THROTTLE_MS = 30 * 1000;

// True while the addon is (or recently was) rate-limited. Non-essential
// background traffic (home recommendations, billboards, import matching) is
// dropped entirely under pressure so it can't keep re-tripping the limiter;
// user-facing searches and stream resolution still go through.
function isAddonUnderRatePressure() {
    return addonRateLimitUntil > Date.now() || (lastRateLimitAt !== 0 && Date.now() - lastRateLimitAt < 60000);
}

function notifyRateLimitedOnce() {
    if (typeof window === 'undefined') return;
    const now = Date.now();
    if (now - rateLimitNotifiedAt < RATE_LIMIT_NOTIFY_THROTTLE_MS) return;
    rateLimitNotifiedAt = now;
    window.dispatchEvent(new CustomEvent('addon-rate-limited', { detail: { message: RATE_LIMIT_ERROR_MESSAGE } }));
}

export const extractBitDepth = (streamInfo) => {
    const quality = `${streamInfo?.quality || ''} ${streamInfo?.streamQuality || ''}`;
    const match = quality.match(/(\d+)\s*-?\s*bit/i);
    if (match) return parseInt(match[1], 10);
    return null;
};

export const extractSampleRate = (streamInfo) => {
    const quality = `${streamInfo?.quality || ''} ${streamInfo?.streamQuality || ''}`;
    const match = quality.match(/([\d.]+)\s*kHz/i);
    if (match) return Math.round(parseFloat(match[1]) * 1000);
    return null;
};

// Extract the actual bitrate (kbps) reported by the addon. Preferred source is
// the numeric bitrate field the addon returns per adaptive format; fall back to
// a "128kbps" style token inside quality strings.
const extractBitrateKbps = (streamInfo) => {
    const raw = streamInfo?.bitrate ?? streamInfo?.audioBitrate ?? streamInfo?.bit_rate ?? streamInfo?.avgBitrate;
    const numeric = parseInt(raw, 10);
    if (Number.isFinite(numeric) && numeric > 0) {
        return Math.max(1, Math.round(numeric / 1000));
    }
    const qualityTokens = [streamInfo?.quality, streamInfo?.streamQuality, streamInfo?.audioQuality]
        .filter(Boolean)
        .join(' ');
    const tokenMatch = qualityTokens.match(/(\d{2,4})\s*(?:kbps|kbit|kb\/?s)/i);
    return tokenMatch ? parseInt(tokenMatch[1], 10) : null;
};

const yearAsReleaseDate = (year) => (year ? String(year).trim() : undefined);

// Compares two addon-returned stream infos to pick the highest-quality
// playback source. Lossless always beats lossy; within a tier the resolution
// (bit depth → sample rate → bitrate) decides. The requested quality only
// breaks ties that matter for Atmos (lossy E-AC3 JOC is legitimately Atmos),
// everything else is inferred from the stream metadata itself.
function streamQualityRank(streamInfo, requestedQuality = '') {
    const text = String(streamInfo?.streamQuality || streamInfo?.quality || streamInfo?.audioQuality || '');
    const format = String(streamInfo?.format || streamInfo?.containerFormat || '');
    const codec = String(streamInfo?.codec || streamInfo?.fileCodec || '');
    const bitDepth = Number(extractBitDepth(streamInfo)) || 0;
    const sampleRate = Number(extractSampleRate(streamInfo)) || 0;
    const bitrate = Number(extractBitrateKbps(streamInfo)) || 0;
    const atmos = /atmos|dolby/i.test(`${text} ${streamInfo?.audioMode || ''}`);

    let score = 0;
    const lossy = isLossyCodec(codec) || isLossyContainer(format || streamInfo?.mediaType);
    if (!lossy) score += 1000;
    if (atmos) {
        score += 200;
        if (/DOLBY_ATMOS/.test(String(requestedQuality || '').toUpperCase())) score += 150;
    }
    score += bitDepth * 100;
    score += sampleRate / 100;
    score += bitrate / 10;
    return score;
}

export class EclipseAPI {
    constructor() {
        this.cache = new APICache({ maxSize: 200, ttl: 1000 * 60 * 30 });
        this.streamCache = new Map();
        this.trackRegistry = new Map();
        this._searchCache = new Map();
        this._searchInflight = new Map();
        this._similarCache = new Map();
        this._requestQueue = [];
        this._priorityQueue = [];
        this._backgroundQueue = [];
        this._queueRunning = false;
        this._backgroundQueueRunning = false;
        this._lastRequestAt = 0;

        setInterval(
            () => {
                this.cache.clearExpired();
                this.pruneStreamCache();
            },
            1000 * 60 * 5
        );
    }

    _sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    // Build fetch options that combine the caller's AbortSignal (so stale
    // requests like command-palette keystrokes cancel immediately) with the
    // 20s hung-addon timeout. Rate-limited addons can stall requests upstream,
    // so the timeout is generous while persistent retries still bound dwell.
    _fetchOptions(signal, useTimeout) {
        const timeoutMs = 20000;
        if (!useTimeout) return undefined;
        if (!signal) return { signal: AbortSignal.timeout(timeoutMs) };
        if (typeof AbortSignal.any === 'function') {
            return { signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) };
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        signal.addEventListener(
            'abort',
            () => {
                clearTimeout(timer);
                controller.abort();
            },
            { once: true }
        );
        return { signal: controller.signal };
    }

    // Serialize addon requests with a minimum gap between them so parallel
    // callers (home sections, search page, command palette) don't trip the
    // addon's rate limiter. Failures never break the queue.
    // High-priority requests (stream URLs, user-initiated playback) jump the
    // queue so play never stalls behind slow background searches.
    // Background requests (billboard resolution, non-visible prefetches) go
    // through a separate lane that only runs when the interactive queues are
    // idle, so they never delay user-facing work.
    _enqueueRequest(fn, priority = false, background = false, signal = null, persistent = false) {
        // Under rate pressure, non-essential background work is dropped on
        // arrival — it would only re-trip the limiter and delay recovery.
        if (background && isAddonUnderRatePressure()) {
            return Promise.reject(new Error(RATE_LIMIT_ERROR_MESSAGE));
        }
        return new Promise((resolve, reject) => {
            const item = { fn, resolve, reject, signal, persistent };
            if (background) {
                this._backgroundQueue.push(item);
                this._pumpBackgroundQueue();
            } else {
                (priority ? this._priorityQueue : this._requestQueue).push(item);
                this._pumpQueue();
            }
        });
    }

    async _pumpQueue() {
        if (this._queueRunning) return;
        this._queueRunning = true;
        try {
            while (this._priorityQueue.length || this._requestQueue.length) {
                // Drain priority (stream/playback) requests first; each lane
                // enforces its own pacing so priority fetches only wait a short
                // gap while regular search/catalog traffic stays polite.
                const fromPriority = this._priorityQueue.length > 0;
                const item = fromPriority ? this._priorityQueue.shift() : this._requestQueue.shift();
                const gapMs = fromPriority ? PRIORITY_REQUEST_GAP_MS : MIN_REQUEST_GAP_MS;
                // While the addon is rate-limited, only persistent requests
                // (stream resolution) keep trying — everything else is dropped
                // instantly instead of queuing behind a doomed fetch that would
                // only re-trip the limiter and extend the freeze.
                if (isAddonUnderRatePressure() && !item.persistent) {
                    notifyRateLimitedOnce();
                    item.reject(new Error(RATE_LIMIT_ERROR_MESSAGE));
                    continue;
                }
                if (item.signal?.aborted) {
                    item.reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
                    continue;
                }
                try {
                    const now = performance.now();
                    const rateLimitWait = addonRateLimitUntil - Date.now();
                    const waitMs = Math.max(0, this._lastRequestAt + gapMs - now, rateLimitWait);
                    if (waitMs > 0) await this._sleep(waitMs);
                    this._lastRequestAt = performance.now();
                    item.resolve(await item.fn());
                } catch (error) {
                    item.reject(error);
                }
            }
        } finally {
            this._queueRunning = false;
        }
    }

    async _pumpBackgroundQueue() {
        if (this._backgroundQueueRunning) return;
        this._backgroundQueueRunning = true;
        try {
            while (this._backgroundQueue.length) {
                // Yield to interactive traffic: only run while the main queues
                // are idle so user-facing searches never wait behind background work.
                if (this._priorityQueue.length || this._requestQueue.length) {
                    await this._sleep(200);
                    continue;
                }
                const item = this._backgroundQueue.shift();
                // Same pressure gate as the interactive queues: background work
                // enqueued before a rate-limit window must not fire into it.
                if (isAddonUnderRatePressure() && !item.persistent) {
                    notifyRateLimitedOnce();
                    item.reject(new Error(RATE_LIMIT_ERROR_MESSAGE));
                    continue;
                }
                if (item.signal?.aborted) {
                    item.reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
                    continue;
                }
                try {
                    const now = performance.now();
                    const rateLimitWait = addonRateLimitUntil - Date.now();
                    const waitMs = Math.max(0, this._lastRequestAt + BACKGROUND_REQUEST_GAP_MS - now, rateLimitWait);
                    if (waitMs > 0) await this._sleep(waitMs);
                    this._lastRequestAt = performance.now();
                    item.resolve(await item.fn());
                } catch (error) {
                    item.reject(error);
                }
            }
        } finally {
            this._backgroundQueueRunning = false;
        }
    }

    async _request(
        path,
        retries = MAX_429_RETRIES,
        priority = false,
        background = false,
        persistent = false,
        attempt = 0,
        signal = null,
        startedAt = null,
        allowFallback = true,
        requestedAddonId = null,
        wallMs = null
    ) {
        const candidates = requestedAddonId
            ? [eclipseAddonStorage.getAddonById(requestedAddonId)].filter(Boolean)
            : allowFallback
              ? eclipseAddonStorage.getAddonCandidates()
              : [eclipseAddonStorage.getAddon()].filter(Boolean);
        if (!candidates.length) throw new Error(NO_ADDON_MESSAGE);

        let lastError = null;
        for (const addon of candidates) {
            const addonId = addonIdentity(addon);
            try {
                const result = await this._requestWithAddon(
                    path,
                    retries,
                    priority,
                    background,
                    persistent,
                    attempt,
                    signal,
                    startedAt,
                    addonId,
                    wallMs
                );
                if (eclipseAddonStorage.getActiveAddonId() !== addonId) {
                    eclipseAddonStorage.setActiveAddon(addonId);
                }
                return result;
            } catch (error) {
                if (error?.name === 'AbortError' || signal?.aborted) throw error;
                lastError = error;
                console.warn(`[Eclipse] addon failed, trying next priority addon: ${addonId}`, error);
            }
        }
        throw lastError || new Error('All installed Eclipse addons failed');
    }

    async _requestWithAddon(
        path,
        retries = MAX_429_RETRIES,
        priority = false,
        background = false,
        persistent = false,
        attempt = 0,
        signal = null,
        startedAt = null,
        addonId = null,
        wallMs = null
    ) {
        const addon = await eclipseAddonStorage.ensureInstalled(addonId);
        if (!addon) throw new Error(NO_ADDON_MESSAGE);

        const baseUrl = addonBasePath(addon.baseUrl);
        const url = `${baseUrl}/${String(path).replace(/^\/+/, '')}`;

        let res;
        try {
            // A hung addon must never stall the queue forever: every fetch is
            // aborted after 15s so the pump moves on and sections can fall back.
            // A caller-supplied AbortSignal (command palette keystrokes) cancels
            // stale requests so they never sit in the queue consuming slots.
            const useTimeout = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function';
            res = await this._enqueueRequest(
                () => fetch(url, this._fetchOptions(signal, useTimeout)),
                priority,
                background,
                signal,
                persistent
            );
        } catch (error) {
            if (signal?.aborted) throw error;
            if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
                // A rate-limited addon can stall requests so long they trip the
                // fetch timeout. Persistent requests treat that like a 429 and
                // retry within their wall-clock budget instead of dying.
                if (persistent && error?.name === 'TimeoutError') {
                    const start = startedAt ?? Date.now();
                    const budget = wallMs ?? MAX_PERSISTENT_WALL_MS;
                    if (Date.now() - start <= budget) {
                        addonRateLimitUntil = Math.max(addonRateLimitUntil, Date.now() + 3000);
                        return this._requestWithAddon(
                            path,
                            retries,
                            priority,
                            background,
                            persistent,
                            attempt + 1,
                            signal,
                            start,
                            addonId,
                            wallMs
                        );
                    }
                }
                throw new Error('Addon timed out');
            }
            throw new Error(`Addon unreachable: ${error?.message || String(error || 'Unknown error')}`);
        }

        if (res.status === 429) {
            lastRateLimitAt = Date.now();
            // Respect the addon's retry-after when provided; otherwise back off
            // exponentially (500ms → 1s → 2s …), capped so interactive requests
            // never sleep too long. Persistent searches (user-facing search page)
            // keep retrying until the rate limit clears.
            let backoffMs;
            const retryAfter = res.headers.get('retry-after');
            if (retryAfter) {
                const seconds = Number.parseFloat(retryAfter);
                backoffMs = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
            } else {
                backoffMs = Math.min(500 * Math.pow(2, attempt), persistent ? 30000 : 8000);
                if (wallMs) backoffMs = Math.min(backoffMs, SEARCH_BACKOFF_CAP_MS);
            }
            // Freeze the whole queue behind this backoff so sibling requests
            // (parallel searches) don't keep re-tripping the addon's limiter.
            addonRateLimitUntil = Math.max(addonRateLimitUntil, Date.now() + Math.max(backoffMs, 2000));
            await this._sleep(Math.max(backoffMs, 0));
            // Persistent requests (stream resolution, user-facing searches)
            // only give up after a wall-clock budget, so transient rate
            // windows don't kill playback mid-queue.
            if (persistent) {
                const start = startedAt ?? Date.now();
                const budget = wallMs ?? MAX_PERSISTENT_WALL_MS;
                if (Date.now() - start > budget) {
                    notifyRateLimitedOnce();
                    throw new Error(RATE_LIMIT_ERROR_MESSAGE);
                }
                return this._requestWithAddon(
                    path,
                    retries,
                    priority,
                    background,
                    persistent,
                    attempt + 1,
                    signal,
                    start,
                    addonId,
                    wallMs
                );
            }
            if (retries > 0) {
                return this._requestWithAddon(path, retries - 1, priority, background, false, 0, signal, null, addonId);
            }
            notifyRateLimitedOnce();
            throw new Error(RATE_LIMIT_ERROR_MESSAGE);
        }
        if (res.status === 404) throw new Error('Not supported by this addon');
        if (!res.ok) throw new Error(`Addon error (HTTP ${res.status})`);
        return res.json();
    }

    // ---- search ---------------------------------------------------------

    async _search(query, options = {}) {
        const q = String(query || '').trim();
        if (!q) return { tracks: [], albums: [], artists: [], playlists: [] };

        // Eclipse addons use the explicit `isrc:` search form. Accept both
        // pasted bare ISRCs and already-prefixed identifiers from the main
        // Search for Music field.
        const isrcMatch = q.match(/^(?:isrc\s*:\s*)?([A-Z]{2}[A-Z0-9]{3}\d{7})$/i);
        const requestedIsrc = isrcMatch ? isrcMatch[1].toUpperCase() : null;
        const searchQuery = requestedIsrc ? `isrc:${requestedIsrc}` : q;

        const cacheKey = `${this._addonCacheScope()}_search_${searchQuery.toLowerCase()}`;
        const cached = this._searchCache.get(cacheKey);
        if (cached) return cached;

        // Deduplicate concurrent identical queries (search page + command
        // palette can race on the same query).
        if (this._searchInflight.has(cacheKey)) return this._searchInflight.get(cacheKey);

        const inflight = (async () => {
            const requestSearch = (searchQuery, addonId) =>
                this._request(
                    `search?q=${encodeURIComponent(searchQuery)}`,
                    MAX_429_RETRIES,
                    options?.priority === true,
                    options?.background === true,
                    options?.retry === true,
                    0,
                    options?.signal || null,
                    null,
                    false,
                    addonId,
                    options?.wallMs ?? SEARCH_WALL_MS
                );

            const searchable = (addon) => addon?.searchEnabled !== false;
            const addons = eclipseAddonStorage.getAddonCandidates().filter(searchable);
            const activeAddon = eclipseAddonStorage.getAddon();
            const addonKey = (addon) => addon?.id || addon?.manifest?.id || addon?.baseUrl;
            const orderedAddons = [
                activeAddon,
                ...addons.filter((addon) => addonKey(addon) !== addonKey(activeAddon)),
            ].filter((addon) => searchable(addon) && Boolean(addon));
            if (!orderedAddons.length) {
                throw new Error(
                    'Search is disabled for every addon — enable Search on an addon in Settings → Eclipse Addon.'
                );
            }
            const searchRequests = orderedAddons.map(async (addon) => {
                const results = [{ data: await requestSearch(searchQuery, addonKey(addon)), addon }];
                // MaxMusic's Deezer index exposes the official RADWIMPS/Toaka
                // recording under the contributor query.
                if (addon.manifest?.id === 'com.ultramax.eclipse.music' && /^suzume$/i.test(searchQuery)) {
                    try {
                        results.push({ data: await requestSearch('Toaka', addonKey(addon)), addon });
                    } catch (error) {
                        console.warn('[Eclipse] Supplemental MaxMusic search failed:', error);
                    }
                }
                return results;
            });
            const settled = await Promise.allSettled(searchRequests);
            const successful = settled
                .filter((result) => result.status === 'fulfilled')
                .flatMap((result) => result.value);
            if (!successful.length) {
                throw settled.find((result) => result.status === 'rejected')?.reason || new Error('Search failed');
            }
            const data = {
                tracks: successful.flatMap(({ data: result }) => result?.tracks || []),
                albums: successful.flatMap(({ data: result }) => result?.albums || []),
                artists: successful.flatMap(({ data: result }) => result?.artists || []),
                playlists: successful.flatMap(({ data: result }) => result?.playlists || []),
            };
            if (requestedIsrc) {
                data.tracks = data.tracks.filter(
                    (track) =>
                        String(track?.isrc || '')
                            .replace(/-/g, '')
                            .toUpperCase() === requestedIsrc
                );
            }
            const result = {
                tracks: Array.from(
                    new Map(data.tracks.map((track) => [String(track.isrc || track.id), track])).values()
                ).map((t) => this.mapSearchTrack(t)),
                albums: Array.from(new Map(data.albums.map((album) => [String(album.id), album])).values()).map((a) =>
                    this.mapSearchAlbum(a)
                ),
                artists: Array.from(new Map(data.artists.map((artist) => [String(artist.id), artist])).values()).map(
                    (a) => this.mapSearchArtist(a)
                ),
                playlists: Array.from(
                    new Map(data.playlists.map((playlist) => [String(playlist.id), playlist])).values()
                ).map((p) => this.mapSearchPlaylist(p)),
            };

            this._searchCache.set(cacheKey, result);
            setTimeout(() => this._searchCache.delete(cacheKey), SEARCH_CACHE_TTL);
            return result;
        })();
        inflight.finally(() => this._searchInflight.delete(cacheKey)).catch(() => {});
        this._searchInflight.set(cacheKey, inflight);
        return inflight;
    }

    async searchTracks(query, options = {}) {
        const data = await this._search(query, options);
        const limit =
            options.limit != null && options.limit !== '' && Number.isFinite(Number(options.limit))
                ? Math.max(0, Number(options.limit))
                : null;
        const items = limit == null ? data.tracks : data.tracks.slice(0, limit);
        return { items, limit, offset: 0, totalNumberOfItems: data.tracks.length };
    }

    async searchAlbums(query, options = {}) {
        const data = await this._search(query, options);
        const limit =
            options.limit != null && options.limit !== '' && Number.isFinite(Number(options.limit))
                ? Math.max(0, Number(options.limit))
                : null;
        const items = limit == null ? data.albums : data.albums.slice(0, limit);
        return { items, limit, offset: 0, totalNumberOfItems: data.albums.length };
    }

    async searchArtists(query, options = {}) {
        const data = await this._search(query, options);
        const limit =
            options.limit != null && options.limit !== '' && Number.isFinite(Number(options.limit))
                ? Math.max(0, Number(options.limit))
                : null;
        const items = limit == null ? data.artists : data.artists.slice(0, limit);
        return { items, limit, offset: 0, totalNumberOfItems: data.artists.length };
    }

    /**
     * Resolves an artist id from a display name (search results only carry
     * artist names). Exact name match preferred, otherwise the top result.
     */
    async resolveArtistIdByName(name) {
        if (!name) return null;
        const cleanName = String(name)
            .replace(/\(\s*(?:feat\.?|ft\.?|with)\s+[^)]*\)/gi, '')
            .replace(/\s+/g, ' ')
            .trim();
        if (!cleanName) return null;
        try {
            const { items } = await this.searchArtists(cleanName, { limit: 8 });
            if (!items?.length) {
                // The addon may not return artists from search at all — fall
                // back to a name-keyed id that getArtist() synthesizes from
                // track search results.
                const tracks = await this.searchTracks(cleanName, { limit: 8 });
                if (tracks?.items?.length) return `by-name:${encodeURIComponent(cleanName)}`;
                return null;
            }
            const normalized = cleanName.toLowerCase();
            const exact = items.find((a) => a?.name && String(a.name).toLowerCase() === normalized);
            return (exact || items[0])?.id || null;
        } catch (error) {
            console.warn('Failed to resolve artist id for:', cleanName, error);
            return null;
        }
    }

    async searchPlaylists(query, options = {}) {
        const data = await this._search(query, options);
        const limit =
            options.limit != null && options.limit !== '' && Number.isFinite(Number(options.limit))
                ? Math.max(0, Number(options.limit))
                : null;
        const items = limit == null ? data.playlists : data.playlists.slice(0, limit);
        return { items, limit, offset: 0, totalNumberOfItems: data.playlists.length };
    }

    // ---- mappers --------------------------------------------------------

    registerTrack(track) {
        if (track?.id != null) {
            this.trackRegistry.set(String(track.id), track);
        }
        return track;
    }

    mapSearchTrack(t) {
        const track = {
            id: String(t.id),
            title: t.title || 'Unknown Track',
            artist: t.artist ? { name: t.artist } : { name: '' },
            artists: t.artist ? [{ name: t.artist }] : [],
            album: t.album
                ? {
                      id: t.albumId != null ? String(t.albumId) : '',
                      title: t.album,
                      cover: t.albumArtworkURL || t.artworkURL,
                  }
                : null,
            albumId: t.albumId != null ? String(t.albumId) : '',
            albumTitle: t.album,
            duration: t.duration || 0,
            explicit: false,
            isrc: t.isrc || null,
            trackNumber: t.trackNumber,
            format: t.format,
            audioQuality: t.audioQuality,
            provider: t.provider,
            audioModes: t.audioModes || [],
            artwork: t.artworkURL ? [{ url: t.artworkURL }] : [],
            cover: t.artworkURL || t.albumArtworkURL,
            videoCover: null,
        };
        return this.registerTrack(track);
    }

    mapSearchAlbum(a) {
        return {
            id: String(a.id),
            title: a.title,
            cover: a.artworkURL,
            artist: a.artist ? { name: a.artist } : { name: '' },
            artists: a.artist ? [{ name: a.artist }] : [],
            artwork: a.artworkURL ? [{ url: a.artworkURL }] : [],
        };
    }

    mapSearchArtist(a) {
        return {
            id: String(a.id),
            name: a.name,
            picture: a.artworkURL,
            image: a.artworkURL,
        };
    }

    mapSearchPlaylist(p) {
        const artwork =
            p.artworkURL ||
            p.artworkUrl ||
            p.artwork ||
            p.cover ||
            p.image ||
            p.picture ||
            p.thumbnail ||
            p.coverUrl ||
            p.imageUrl ||
            p.pictureURL ||
            p.thumbnailURL ||
            (Array.isArray(p.images) ? p.images[0]?.url || p.images[0] : null) ||
            (Array.isArray(p.image_rectangle) ? p.image_rectangle[0]?.url || p.image_rectangle[0] : null) ||
            p.images?.LARGE?.url ||
            p.images?.MEDIUM?.url ||
            p.images?.SMALL?.url ||
            null;
        const count = p.trackCount ?? p.numberOfTracks ?? p.totalTracks ?? p.track_count ?? p.count ?? 0;
        return {
            uuid: p.id ?? p.uuid,
            id: p.id ?? p.uuid,
            title: p.title ?? p.name ?? '',
            user: { name: p.creator || p.user?.name || '' },
            squareImage: artwork,
            image: artwork,
            numberOfTracks: Number(count) || 0,
            description: p.description || '',
        };
    }

    mapDetailTrack(t, fallbackAlbum, fallbackArtistName) {
        const track = {
            id: String(t.id),
            title: t.title || 'Unknown Track',
            artist: t.artist ? { name: t.artist } : { name: fallbackArtistName || '' },
            artists: t.artist ? [{ name: t.artist }] : fallbackArtistName ? [{ name: fallbackArtistName }] : [],
            album: fallbackAlbum
                ? { id: fallbackAlbum.id, title: fallbackAlbum.title, cover: fallbackAlbum.cover }
                : null,
            albumId: fallbackAlbum?.id || '',
            albumTitle: fallbackAlbum?.title,
            duration: t.duration || 0,
            trackNumber: t.trackNumber,
            volumeNumber: 1,
            discNumber: 1,
            explicit: false,
            isrc: t.isrc || null,
            format: t.format,
            artwork: t.artworkURL
                ? [{ url: t.artworkURL }]
                : fallbackAlbum?.cover
                  ? [{ url: fallbackAlbum.cover }]
                  : [],
            cover: t.artworkURL || fallbackAlbum?.cover,
            videoCover: null,
        };
        return this.registerTrack(track);
    }

    // ---- catalog --------------------------------------------------------

    // Re-stamps a search-mapped track with album/artist context so it matches
    // the shape produced by mapDetailTrack() for real catalog responses.
    _applyAlbumContext(track, album, artistName) {
        return {
            ...track,
            artist: track.artist?.name ? track.artist : { name: artistName || '' },
            artists: track.artists?.length ? track.artists : [{ name: artistName || '' }],
            album: album || track.album || null,
            albumId: album?.id ?? track.albumId ?? '',
            albumTitle: album?.title ?? track.albumTitle,
            artwork: track.artwork?.length ? track.artwork : album?.cover ? [{ url: album.cover }] : [],
            cover: track.cover || album?.cover,
            videoCover: null,
        };
    }

    // Some addons' album catalog endpoint can be unavailable (404/502) even
    // though search returns the album's tracks. Reconstruct the album from the
    // tracks their own search already returned for it.
    async _synthesizeAlbumFromSearch(albumId) {
        const registered = [...this.trackRegistry.values()].find(
            (track) => track?.album?.id && String(track.album.id) === albumId
        );
        if (!registered) return null;
        const albumTitle = registered.albumTitle || registered.album?.title || '';
        const artistName = registered.artist?.name || '';
        if (!albumTitle) return null;
        try {
            const query = artistName ? `${albumTitle} ${artistName}` : albumTitle;
            const results = await this.searchTracks(query, { limit: 30, retry: true });
            const want = albumTitle.trim().toLowerCase();
            const matches = (results?.items || []).filter(
                (track) =>
                    String(track.albumTitle || track.album?.title || '')
                        .trim()
                        .toLowerCase() === want
            );
            if (!matches.length) return null;
            const album = {
                id: albumId,
                title: albumTitle,
                cover: registered.album?.cover || registered.cover,
                artist: registered.artist || { name: artistName },
                artists: registered.artists?.length ? registered.artists : registered.artist ? [registered.artist] : [],
                releaseDate: undefined,
                numberOfTracks: matches.length,
                artwork: registered.album?.cover ? [{ url: registered.album.cover }] : [],
                videoCover: null,
            };
            const tracks = matches.map((track) =>
                this.registerTrack(this._applyAlbumContext(track, album, artistName))
            );
            return { album, tracks };
        } catch (error) {
            console.warn('[Eclipse] Album synthesis fallback failed:', error);
            return null;
        }
    }

    // Some addons have no artist search (or an unavailable artist catalog), so
    // an artist page is synthesized from track search results instead. Only
    // `by-name:` ids are synthesizable — real ids go through the catalog.
    async _synthesizeArtistFromSearch(idOrName) {
        const PREFIX = 'by-name:';
        if (typeof idOrName !== 'string' || !idOrName.startsWith(PREFIX)) return null;
        let name;
        try {
            name = decodeURIComponent(idOrName.slice(PREFIX.length));
        } catch {
            return null;
        }
        if (!name) return null;
        try {
            const results = await this.searchTracks(name, { limit: 50, retry: true });
            const want = name.trim().toLowerCase();
            const byArtist = (results?.items || []).filter((track) =>
                (track.artists || []).some(
                    (artist) =>
                        String(artist?.name || '')
                            .trim()
                            .toLowerCase() === want
                )
            );
            const tracks = (byArtist.length ? byArtist : results?.items || []).slice(0, 30);
            if (!tracks.length) return null;
            const albums = Array.from(
                new Map(
                    tracks
                        .filter((track) => track.album?.id)
                        .map((track) => [
                            track.album.id,
                            {
                                id: String(track.album.id),
                                title: track.album.title,
                                cover: track.album.cover,
                                artist: { name },
                                artists: [{ name }],
                                numberOfTracks: undefined,
                                releaseDate: undefined,
                                artwork: track.album.cover ? [{ url: track.album.cover }] : [],
                            },
                        ])
                ).values()
            );
            const artist = {
                id: `${PREFIX}${encodeURIComponent(name)}`,
                name,
                picture: tracks[0]?.cover || '',
                image: tracks[0]?.cover || '',
                biography: '',
                popularity: 0,
                genres: [],
                albums,
                eps: [],
                tracks: tracks.map((track) =>
                    this.registerTrack(
                        this._applyAlbumContext(track, track.album || { id: '', title: '', cover: track.cover }, name)
                    )
                ),
                mixes: {},
            };
            return artist;
        } catch (error) {
            console.warn('[Eclipse] Artist synthesis fallback failed:', error);
            return null;
        }
    }

    async getAlbum(id) {
        let data;
        try {
            data = await this._request(`album/${id}`);
        } catch (error) {
            const synthesized = await this._synthesizeAlbumFromSearch(String(id));
            if (synthesized) return synthesized;
            throw error;
        }
        const album = {
            id: String(data.id),
            title: data.title,
            cover: data.artworkURL,
            artist: data.artist ? { name: data.artist } : { name: '' },
            artists: data.artist ? [{ name: data.artist }] : [],
            releaseDate: yearAsReleaseDate(data.year),
            numberOfTracks: data.trackCount,
            artwork: data.artworkURL ? [{ url: data.artworkURL }] : [],
            videoCover: null,
        };
        const tracks = (data.tracks || []).map((t) => this.mapDetailTrack(t, album));
        return { album, tracks };
    }

    async getArtist(id) {
        let data;
        try {
            data = await this._request(`artist/${id}`);
        } catch (error) {
            const synthesized = await this._synthesizeArtistFromSearch(id);
            if (synthesized) return synthesized;
            throw error;
        }
        let fallbackTracks = [];
        if (!Array.isArray(data.topTracks) || data.topTracks.length === 0) {
            try {
                const searchResults = await this.searchTracks(data.name, { limit: 50, retry: true });
                const artistName = String(data.name || '')
                    .trim()
                    .toLowerCase();
                fallbackTracks = (searchResults.items || []).filter((track) => {
                    const names = (track.artists || []).map((artist) => artist?.name).filter(Boolean);
                    return names.some((name) => String(name).trim().toLowerCase() === artistName);
                });
            } catch (error) {
                console.warn('[Eclipse] Artist track fallback search failed:', error);
            }
        }
        const sourceTracks = Array.isArray(data.topTracks) && data.topTracks.length ? data.topTracks : fallbackTracks;
        const sourceAlbums =
            Array.isArray(data.albums) && data.albums.length
                ? data.albums
                : Array.from(
                      new Map(
                          fallbackTracks
                              .filter((track) => track.album?.id)
                              .map((track) => [track.album.id, track.album])
                      ).values()
                  );
        const artist = {
            id: String(data.id),
            name: data.name,
            picture: data.artworkURL,
            image: data.artworkURL,
            biography: data.bio || '',
            popularity: 0,
            genres: Array.isArray(data.genres)
                ? data.genres.map((genre) => String(genre || '').trim()).filter(Boolean)
                : [],
            albums: sourceAlbums.map((a) => ({
                id: String(a.id),
                title: a.title,
                cover: a.artworkURL,
                artist: a.artist ? { name: a.artist } : { name: data.name },
                artists: a.artist ? [{ name: a.artist }] : [{ name: data.name }],
                numberOfTracks: a.trackCount,
                releaseDate: yearAsReleaseDate(a.year),
                artwork: a.artworkURL ? [{ url: a.artworkURL }] : [],
            })),
            eps: [],
            tracks: sourceTracks.map((t) =>
                t?.artist?.name ? t : this.mapDetailTrack(t, { id: '', title: '', cover: t.artworkURL }, data.name)
            ),
            mixes: {},
        };
        return artist;
    }

    async getPlaylist(id) {
        const data = await this._request(`playlist/${id}`);
        const artwork =
            data.artworkURL ||
            data.artworkUrl ||
            data.artwork ||
            data.cover ||
            data.image ||
            data.picture ||
            data.thumbnail ||
            data.coverUrl ||
            data.imageUrl ||
            data.pictureURL ||
            data.thumbnailURL ||
            (Array.isArray(data.images) ? data.images[0]?.url || data.images[0] : null) ||
            (Array.isArray(data.image_rectangle) ? data.image_rectangle[0]?.url || data.image_rectangle[0] : null) ||
            data.images?.LARGE?.url ||
            data.images?.MEDIUM?.url ||
            data.images?.SMALL?.url ||
            null;
        const count =
            data.trackCount ??
            data.numberOfTracks ??
            data.totalTracks ??
            data.track_count ??
            data.count ??
            (Array.isArray(data.tracks) ? data.tracks.length : 0) ??
            (Array.isArray(data.items) ? data.items.length : 0) ??
            (Array.isArray(data.songs) ? data.songs.length : 0) ??
            0;
        const playlist = {
            uuid: data.id ?? data.uuid,
            id: data.id ?? data.uuid,
            title: data.title ?? data.name ?? '',
            user: { name: data.creator || data.user?.name || '' },
            squareImage: artwork,
            image: artwork,
            numberOfTracks: Number(count) || 0,
            description: data.description || '',
        };
        let rawTracks = data.tracks || data.items || data.songs || data.track || [];
        if (rawTracks && typeof rawTracks === 'object' && !Array.isArray(rawTracks)) {
            if (Array.isArray(rawTracks.items)) rawTracks = rawTracks.items;
            else if (Array.isArray(rawTracks.data)) rawTracks = rawTracks.data;
            else rawTracks = [];
        }
        // Unwrap pagination wrappers where tracks are { item: track } or { track: track }
        if (Array.isArray(rawTracks) && rawTracks.length && rawTracks[0]?.item) {
            rawTracks = rawTracks.map((entry) => entry.item || entry.track || entry);
        }
        const tracks = (Array.isArray(rawTracks) ? rawTracks : []).map((t) =>
            this.mapDetailTrack(t, { id: '', title: playlist.title, cover: artwork })
        );
        return { playlist, tracks };
    }

    async getMix(id) {
        return {
            mix: { id, title: 'Mix', cover: null, subTitle: 'Mixes are not supported by this addon' },
            tracks: [],
        };
    }

    // ---- streaming ------------------------------------------------------

    // A stream entry is reusable only while comfortably inside its server
    // reported expiry (same margin for memory and persistent copies).
    _streamEntryUsable(entry) {
        return Boolean(
            entry && entry.expiresAt && Math.floor(Date.now() / 1000) < entry.expiresAt - STREAM_CACHE_EXPIRY_MARGIN_S
        );
    }

    _getStreamCacheLocal(key) {
        try {
            const raw = localStorage.getItem(STREAM_CACHE_LOCAL_PREFIX + key);
            if (!raw) return null;
            const entry = JSON.parse(raw);
            return this._streamEntryUsable(entry) ? entry : null;
        } catch {
            return null;
        }
    }

    // Reads a persisted stream entry even when it has expired (rate-limited
    // resolution fallback). The entry is not treated as fresh — it is only a
    // best-effort URL for a degraded play attempt.
    _getStaleStreamCacheLocal(key) {
        try {
            const raw = localStorage.getItem(STREAM_CACHE_LOCAL_PREFIX + key);
            if (!raw) return null;
            return JSON.parse(raw);
        } catch {
            return null;
        }
    }

    // A stale entry may only substitute when its delivered quality is at least
    // the requested tier. Lossy requests accept anything; lossless requests
    // reject lossy entries (crisis-session caches hold AAC-320 downgrades);
    // Atmos requests additionally accept lossy entries that advertise Atmos,
    // since Atmos is legitimately delivered as lossy E-AC3 JOC.
    _staleStreamMeetsTier(entry, requestedQuality) {
        const q = String(requestedQuality || '').toUpperCase();
        if (/^(LOW|HIGH)$/.test(q)) return true;
        const lossy =
            isLossyCodec(entry.codec || entry.fileCodec) ||
            isLossyContainer(entry.format || entry.containerFormat || entry.mediaType);
        if (!lossy) return true;
        const atmos = /atmos|dolby/i.test(
            String(entry.audioMode || entry.audioQuality || entry.quality || entry.streamQuality || '')
        );
        return /DOLBY_ATMOS/.test(q) && atmos;
    }

    _setStreamCacheLocal(key, entry) {
        try {
            if (!entry) return;
            const nowMs = Date.now();
            const serverExpiryMs = (entry.expiresAt || 0) * 1000;
            const maxExpiryMs = Math.min(serverExpiryMs, nowMs + STREAM_CACHE_LOCAL_MAX_TTL_MS);
            localStorage.setItem(
                STREAM_CACHE_LOCAL_PREFIX + key,
                JSON.stringify({ ...entry, expiresAt: Math.floor(maxExpiryMs / 1000) })
            );
        } catch {
            // Quota exceeded / storage disabled — fall back to in-memory only.
        }
    }

    _forgetStreamCacheLocal(key) {
        try {
            localStorage.removeItem(STREAM_CACHE_LOCAL_PREFIX + key);
        } catch {
            /* ignore */
        }
    }

    _pruneStreamCacheLocal() {
        try {
            const now = Math.floor(Date.now() / 1000);
            for (let i = 0; i < localStorage.length; i++) {
                const storageKey = localStorage.key(i);
                if (!storageKey || !storageKey.startsWith(STREAM_CACHE_LOCAL_PREFIX)) continue;
                try {
                    const entry = JSON.parse(localStorage.getItem(storageKey));
                    if (!entry || !entry.expiresAt || now >= entry.expiresAt) {
                        localStorage.removeItem(storageKey);
                    }
                } catch {
                    localStorage.removeItem(storageKey);
                }
            }
        } catch {
            /* ignore */
        }
    }

    /**
     * Remove a single cached stream URL (memory + persistent) so the next
     * resolution fetches a fresh one.
     */
    forgetStreamUrl(id, quality) {
        const key = `${this._addonCacheScope()}_stream_${String(id)}_${quality || 'LOSSLESS'}`;
        this.streamCache.delete(key);
        this._forgetStreamCacheLocal(key);
    }

    // Finds the same song under the current addon's provider when a saved
    // track id (playlists, liked songs, recently played) can't be resolved
    // directly by the addon. Prefers an ISRC match, then an exact title match
    // (bonus for the same artist); otherwise refuses to guess.
    async _resolveTrackIdBySearch(track) {
        const title = String(track?.title || '').trim();
        const artist = String(track?.artist?.name || track?.artists?.[0]?.name || '').trim();
        if (!title) return null;
        try {
            const query = artist ? `${title} ${artist}` : title;
            const results = await this.searchTracks(query, { limit: 12, retry: true });
            const items = results?.items || [];
            if (!items.length) return null;
            const wantTitle = title.toLowerCase();
            const wantArtist = artist.toLowerCase();
            const wantIsrc = track?.isrc ? String(track.isrc).replace(/-/g, '').toUpperCase() : null;
            const best = items
                .map((item) => {
                    let score = 0;
                    if (
                        wantIsrc &&
                        String(item.isrc || '')
                            .replace(/-/g, '')
                            .toUpperCase() === wantIsrc
                    )
                        score += 100;
                    if (
                        String(item.title || '')
                            .trim()
                            .toLowerCase() === wantTitle
                    )
                        score += 50;
                    const names = (item.artists || []).map((name) =>
                        String(name?.name || '')
                            .trim()
                            .toLowerCase()
                    );
                    if (wantArtist && names.some((name) => name === wantArtist)) score += 25;
                    return { item, score };
                })
                .sort((a, b) => b.score - a.score)[0];
            if (!best || best.score < 50) return null;
            return best.item.id;
        } catch (error) {
            console.warn('[Eclipse] Track id resolution by search failed:', error);
            return null;
        }
    }

    async getStreamUrl(id, quality = 'LOSSLESS', track = null) {
        const trackId = String(id);
        const key = `${this._addonCacheScope()}_stream_${trackId}_${quality || 'LOSSLESS'}`;
        const now = Math.floor(Date.now() / 1000);

        // In-memory cache (fastest).
        const cached = this.streamCache.get(key);
        if (this._streamEntryUsable(cached)) {
            return cached;
        }

        // Persistent cache: instant replay across sessions without an addon hit.
        const local = this._getStreamCacheLocal(key);
        if (local) {
            this.streamCache.set(key, local);
            return local;
        }

        // Some addons (TIDAL/Qobuz) honor a quality hint and can serve higher
        // tiers like Dolby Atmos when asked; the hint is a no-op for addons that
        // always pick a single canonical stream. The cache key already includes
        // the quality, so a fresh tier is requested (and cached) independently.
        //
        // With more than one stream-capable addon installed, every addon is
        // asked in parallel and the best-quality response wins (tie → priority
        // order). A single addon keeps the old fallback-chain behavior so a
        // failing addon can hand off to the next candidate.
        const streamCandidates = eclipseAddonStorage
            .getAddonCandidates()
            .filter(
                (addon) =>
                    addon.streamEnabled !== false &&
                    Array.isArray(addon.manifest?.resources) &&
                    addon.manifest.resources.includes('stream')
            );
        const settleError = (error) => {
            // Under rate pressure a cached URL (even past its nominal expiry)
            // is worth trying — Tidal CDN URLs commonly outlive their expiry,
            // and playback degrades gracefully instead of failing outright.
            // A stale entry must still MEET the requested tier though: silently
            // playing "High · AAC · 320 kbps" for a lossless request is not
            // graceful — it is a quiet downgrade. Quality-crisis sessions have
            // poisoned the persisted cache with exactly such lossy entries.
            if (error?.message === RATE_LIMIT_ERROR_MESSAGE) {
                const stale = this._getStaleStreamCacheLocal(key);
                if (stale?.url && this._staleStreamMeetsTier(stale, quality)) {
                    console.warn('[Eclipse] Addons rate-limited — reusing stale stream URL for', trackId);
                    return stale;
                }
                if (stale?.url) {
                    console.warn(
                        '[Eclipse] Stale stream URL for',
                        trackId,
                        'does not meet requested tier',
                        quality,
                        '— failing playback'
                    );
                }
            }
            throw error;
        };
        // Resolve a stream for a concrete track id against every stream-capable
        // addon. Throws when no addon can serve it.
        //
        // With more than one stream-capable addon installed, every addon is
        // asked in parallel and the best-quality response wins (tie → priority
        // order). A single addon keeps the old fallback-chain behavior so a
        // failing addon can hand off to the next candidate.
        const tryResolve = async (candidateId) => {
            if (streamCandidates.length > 1) {
                const settled = await Promise.allSettled(
                    streamCandidates.map(async (addon) => {
                        const info = await this._request(
                            `stream/${candidateId}?quality=${encodeURIComponent(quality || 'LOSSLESS')}`,
                            MAX_429_RETRIES,
                            true,
                            false,
                            true,
                            0,
                            null,
                            null,
                            false,
                            addonIdentity(addon),
                            SEARCH_WALL_MS
                        );
                        return { addon, info };
                    })
                );
                let bestRank = -Infinity;
                let chosen = null;
                let by = null;
                for (const result of settled) {
                    if (result.status === 'rejected') {
                        if (!chosen) {
                            try {
                                chosen = settleError(result.reason);
                            } catch (error) {
                                if (!by) by = error;
                            }
                        }
                        continue;
                    }
                    const { addon, info } = result.value;
                    const rank = streamQualityRank(info, quality);
                    if (rank > bestRank) {
                        bestRank = rank;
                        chosen = info;
                        by = addon;
                    }
                }
                if (!chosen) throw by || new Error('All installed Eclipse addons failed to resolve a stream');
                if (by && addonIdentity(by) !== eclipseAddonStorage.getActiveAddonId()) {
                    console.warn(
                        `[Eclipse] Best stream for ${candidateId} served by ${addonIdentity(by)} (rank ${bestRank}) — better than the active addon`
                    );
                }
                return { data: chosen, resolvedBy: by };
            }
            // Single stream addon (or none declaring the resource): keep the
            // request scoped to that addon. The generic fallback chain must
            // NOT reach addons whose stream participation is disabled.
            const single = streamCandidates[0];
            try {
                const info = single
                    ? await this._request(
                          `stream/${candidateId}?quality=${encodeURIComponent(quality || 'LOSSLESS')}`,
                          MAX_429_RETRIES,
                          true,
                          false,
                          true,
                          0,
                          null,
                          null,
                          false,
                          addonIdentity(single)
                      )
                    : await this._request(
                          `stream/${candidateId}?quality=${encodeURIComponent(quality || 'LOSSLESS')}`,
                          MAX_429_RETRIES,
                          true,
                          false,
                          true
                      );
                return { data: info, resolvedBy: single || null };
            } catch (error) {
                throw settleError(error);
            }
        };
        // Tracks saved before the current addon era (playlists, liked songs,
        // recently played) carry ids the addon cannot resolve ("Unknown
        // source"). When direct resolution fails, find the same song through
        // the addon's own search and resolve the matched id instead.
        let resolved;
        try {
            resolved = await tryResolve(trackId);
        } catch (error) {
            if (error?.message === RATE_LIMIT_ERROR_MESSAGE || !track) throw error;
            const searchId = await this._resolveTrackIdBySearch(track);
            if (!searchId) throw error;
            console.warn(
                `[Eclipse] Cannot resolve stream id ${trackId} directly — retrying with search-matched id ${searchId}`
            );
            resolved = await tryResolve(searchId);
        }
        const { data } = resolved;
        const stream = {
            url: data.url,
            format: data.format,
            quality: data.quality,
            streamQuality: data.streamQuality,
            expiresAt: data.expiresAt || now + 3600,
            bitDepth: extractBitDepth(data),
            sampleRate: extractSampleRate(data),
            audioQuality: data.streamQuality || data.quality || data.audioQuality || null,
            audioMode:
                data.audioMode ||
                (Array.isArray(data.audioModes) ? data.audioModes.find((m) => /atmos|dolby/i.test(String(m))) : null) ||
                null,
            // The reference addon serves an HLS playlist from an extensionless
            // `/dash/:id` URL while reporting `format: "flac"`. Keep `format`
            // for quality/codec metadata, but expose the transport separately
            // so Eclipse playback goes through the HLS engine.
            mediaType: data.mediaType || (isHlsStreamUrl(data.url) ? 'HLS' : data.format || null),
            mimeType: data.mimeType || null,
            codec: data.codec || data.fileCodec || null,
            containerFormat: data.containerFormat || null,
            bitrateKbps: extractBitrateKbps(data),
        };
        this.streamCache.set(key, stream);
        this._setStreamCacheLocal(key, stream);
        registerStreamHostForProxy(stream.url);
        return stream;
    }

    _addonCacheScope() {
        return encodeURIComponent(addonIdentity(eclipseAddonStorage.getAddon()) || 'no-addon');
    }

    async getTrack(id, quality, track = null) {
        const trackId = String(id);
        const source = track || this.trackRegistry.get(trackId) || null;
        const stream = await this.getStreamUrl(trackId, quality, source);
        const resolved = this.trackRegistry.get(trackId) ||
            source || {
                id: trackId,
                title: 'Unknown Track',
                artist: { name: '' },
                artists: [],
                album: null,
                artwork: [],
                cover: null,
            };
        return {
            track: resolved,
            info: { manifest: stream.url, expiresAt: stream.expiresAt },
            originalTrackUrl: stream.url,
            url: stream.url,
            bitDepth: stream.bitDepth,
            sampleRate: stream.sampleRate,
            audioQuality: stream.audioQuality,
            audioMode: stream.audioMode,
            mediaType: stream.format,
            mimeType: stream.mimeType,
            bitrateKbps: stream.bitrateKbps,
            isrc: resolved.isrc || null,
        };
    }

    async getTrackMetadata(id) {
        const track = this.trackRegistry.get(String(id));
        if (!track) throw new Error('Track metadata not available for this track');
        return track;
    }

    pruneStreamCache() {
        const now = Math.floor(Date.now() / 1000);
        for (const [key, entry] of this.streamCache) {
            if (entry.expiresAt && now >= entry.expiresAt) {
                this.streamCache.delete(key);
            }
        }
        this._pruneStreamCacheLocal();
    }

    // ---- recommendations (synthesized from addon search) ----------------
    // The addon protocol has no "similar"/recommendation endpoints, so these
    // are synthesized from the addon's own catalog:
    //   • similar artists → seed artist genres → artist search by genre
    //   • similar albums  → seed album's artist → "more from this artist"
    //   • similar tracks  → artist + artist/title searches, merged, deduped
    // All synthesis rides the background request lane and caches per seed.

    async getSimilarArtists(artistId, options = {}) {
        const seedId = String(artistId || '');
        if (!seedId) return [];

        // During rate-limit windows the whole synthesis cascade (seed detail +
        // up to three searches per artist) is dropped at the source — it is
        // invisible homepage decoration, not worth re-tripping the limiter.
        if (isAddonUnderRatePressure()) {
            console.warn('[Eclipse] Skipping similar-artist synthesis for', seedId, '— addon under rate pressure');
            return [];
        }

        const cacheKey = `${this._addonCacheScope()}_similar_artists_${seedId}`;
        const cached = this._similarCache.get(cacheKey);
        if (cached && !options.skipCache && Date.now() - cached.at < 10 * 60 * 1000) {
            return cached.items;
        }

        const background = options?.background === true;
        const similar = [];
        let seedName = String(options?.seedName || '').trim();
        let genres = [];

        // A failed seed-detail must not kill synthesis: the caller-provided
        // name (when present) still yields a name-based search below.
        try {
            const data = await this._request(`artist/${seedId}`, MAX_429_RETRIES, false, background);
            seedName = String(data.name || '').trim() || seedName;
            genres = Array.isArray(data.genres)
                ? data.genres
                      .map((genre) => String(genre || '').trim())
                      .filter(Boolean)
                      .slice(0, 2)
                : [];
        } catch (error) {
            console.warn('[Eclipse] Similar-artist seed detail failed for', seedId, error);
        }

        const queries = [...genres, seedName].filter(Boolean).slice(0, 3);
        const seen = new Set([seedName.toLowerCase()]);

        for (const query of queries) {
            try {
                const result = await this.searchArtists(query, { limit: 8, background });
                for (const candidate of result.items || []) {
                    const key = String(candidate?.name || '')
                        .trim()
                        .toLowerCase();
                    if (!key || seen.has(key)) continue;
                    seen.add(key);
                    similar.push(candidate);
                    if (similar.length >= 8) break;
                }
            } catch (error) {
                console.warn('[Eclipse] Similar-artist search failed for', query, error);
            }
            if (similar.length >= 8) break;
        }

        this._similarCache.set(cacheKey, { at: Date.now(), items: similar });
        return similar;
    }

    async getSimilarAlbums(albumId, options = {}) {
        const seedId = String(albumId || '');
        if (!seedId) return [];

        const cacheKey = `${this._addonCacheScope()}_similar_albums_${seedId}`;
        const cached = this._similarCache.get(cacheKey);
        if (cached && !options.skipCache && Date.now() - cached.at < 10 * 60 * 1000) {
            return cached.items;
        }

        const background = options?.background === true;
        const similar = [];
        let artistName = String(options?.seedArtistName || '').trim();
        let seedTitle = '';

        if (!artistName) {
            try {
                const data = await this._request(`album/${seedId}`, MAX_429_RETRIES, false, background);
                artistName = String(data.artist || '').trim();
                seedTitle = String(data.title || '')
                    .trim()
                    .toLowerCase();
            } catch (error) {
                console.warn('[Eclipse] Similar-album seed detail failed for', seedId, error);
            }
        }

        if (artistName) {
            try {
                const result = await this.searchAlbums(artistName, { limit: 14, background });
                for (const album of result.items || []) {
                    const title = String(album?.title || '')
                        .trim()
                        .toLowerCase();
                    if (title && title === seedTitle) continue;
                    similar.push(album);
                    if (similar.length >= 12) break;
                }
            } catch (error) {
                console.warn('[Eclipse] Similar-album search failed for', artistName, error);
            }
        }

        this._similarCache.set(cacheKey, { at: Date.now(), items: similar });
        return similar;
    }

    async getRecommendations(id, options = {}) {
        const seed = this.trackRegistry.get(String(id)) || options.seedTrack || null;
        if (!seed) return { items: [] };

        const background = options?.background === true;
        const artistName = String(seed.artist?.name || seed.artists?.[0]?.name || '').trim();
        const title = String(seed.title || '').trim();
        // Under rate pressure, only the artist query runs (the "artist title"
        // combo query doubles volume for marginal relevance).
        const queries = isAddonUnderRatePressure() ? [artistName] : [artistName, `${artistName} ${title}`];
        const queriesToRun = queries.filter(Boolean).slice(0, 2);

        const seedId = String(id);
        const candidates = [];
        for (const query of queriesToRun) {
            try {
                const results = await this.searchTracks(query, { limit: 24, background });
                candidates.push(...(results.items || []));
            } catch (error) {
                console.warn('[Eclipse] getRecommendations search failed for', query, error);
            }
        }

        const seen = new Set();
        const items = [];
        for (const track of candidates) {
            const trackId = String(track?.id || '');
            if (!trackId || trackId === seedId || seen.has(trackId)) continue;
            seen.add(trackId);
            items.push(track);
            if (items.length >= 25) break;
        }
        return { items };
    }

    async getRecommendedTracksForPlaylist(tracks = [], limit = 30, options = {}) {
        // Under rate pressure, cap to two seeds so the home page can't fan out
        // into a fresh search burst while the addon is already throttled.
        const maxSeeds = isAddonUnderRatePressure() ? 2 : 3;
        const seeds = (tracks || [])
            .filter((track) => track?.id && (track.title || track.artist?.name))
            .slice(0, maxSeeds);
        if (seeds.length === 0) return [];

        const background = options?.background === true;
        const seedIds = new Set(seeds.map((track) => String(track.id)));
        const seedTitles = new Set(
            seeds
                .map((track) =>
                    String(track.title || '')
                        .trim()
                        .toLowerCase()
                )
                .filter(Boolean)
        );

        const results = await Promise.allSettled(
            seeds.map((seed) => {
                const query = `${seed.artist?.name || ''} ${seed.title || ''}`.trim();
                if (!query) return Promise.resolve({ items: [] });
                return this.searchTracks(query, { limit: limit + 5, background });
            })
        );

        const seen = new Set();
        const items = [];
        for (const result of results) {
            if (result.status !== 'fulfilled') continue;
            for (const track of result.value?.items || []) {
                const trackId = String(track?.id || '');
                const title = String(track?.title || '')
                    .trim()
                    .toLowerCase();
                if (seedIds.has(trackId) || seedTitles.has(title)) continue;
                const key = trackId || `${title}::${String(track?.artist?.name || '').toLowerCase()}`;
                if (seen.has(key)) continue;
                seen.add(key);
                items.push(track);
                if (items.length >= limit) return items;
            }
        }
        return items.slice(0, limit);
    }

    // ---- artist info ----------------------------------------------------

    async getArtistBiography(artistId) {
        const data = await this._request(`artist/${artistId}`);
        return { text: data.bio || '', source: 'Eclipse Addon' };
    }

    async getArtistWebImage(artistName) {
        return null;
    }

    async getLastFmArtistImage(artistName) {
        return null;
    }

    // ---- visual URL helpers (ported) ------------------------------------

    getCoverUrl(id, size = '320') {
        const normalizeSize = (s) => {
            if (typeof s !== 'string') s = String(s);
            if (/^\d+x\d+$/i.test(s)) return s;
            const n = parseInt(s, 10);
            return Number.isFinite(n) && n > 0 ? `${n}x${n}` : '320x320';
        };

        const normalizeRawCoverId = (value) => {
            if (value && typeof value === 'object') {
                value = value.url || value.href || value.src || value.image || value.cover || value.id || '';
            }
            if (value === null || value === undefined) return '';
            return String(value)
                .trim()
                .replace(/^['"]+|['"]+$/g, '');
        };

        const sizeToken = normalizeSize(size);
        const normalizedInput = normalizeRawCoverId(id);

        if (!normalizedInput) {
            return '/assets/appicon.png';
        }

        if (
            normalizedInput.startsWith('http://') ||
            normalizedInput.startsWith('https://') ||
            normalizedInput.startsWith('blob:') ||
            normalizedInput.startsWith('assets/')
        ) {
            try {
                const url = new URL(normalizedInput);
                if (url.hostname === 'resources.tidal.com' && url.pathname.includes('/images/')) {
                    const pathnameWithoutSize = url.pathname.replace(/\/\d+x\d+\.jpg$/i, '').replace(/\/+$/, '');
                    return `${url.origin}${pathnameWithoutSize}/${sizeToken}.jpg`;
                }
            } catch (_) {
                // not a URL object or non-standard format
            }
            return normalizedInput;
        }

        if (/^resources\.tidal\.com\/images\//i.test(normalizedInput)) {
            const normalizedPath = normalizedInput
                .replace(/^resources\.tidal\.com\/images\//i, '')
                .replace(/\/\d+x\d+\.jpg$/i, '')
                .replace(/\/+$/, '');
            return `https://resources.tidal.com/images/${normalizedPath}/${sizeToken}.jpg`;
        }

        if (/^\/images\//i.test(normalizedInput) || /^images\//i.test(normalizedInput)) {
            const normalizedPath = normalizedInput
                .replace(/^\/?images\//i, '')
                .replace(/\/\d+x\d+\.jpg$/i, '')
                .replace(/\/+$/, '');
            return `https://resources.tidal.com/images/${normalizedPath}/${sizeToken}.jpg`;
        }

        let formattedId = normalizedInput;

        if (formattedId.startsWith('/images/')) {
            formattedId = formattedId.replace(/^\/images\//, '');
        }

        if (formattedId.includes('/') || formattedId.includes('-')) {
            formattedId = formattedId.replace(/-/g, '/').replace(/^\/+|\/+$/g, '');

            if (/\.jpg$/i.test(formattedId)) {
                if (formattedId.startsWith('resources.tidal.com/images/')) {
                    return `https://${formattedId}`;
                }
                return `https://resources.tidal.com/images/${formattedId}`;
            }

            return `https://resources.tidal.com/images/${formattedId}/${sizeToken}.jpg`;
        }

        return `https://via.placeholder.com/${sizeToken}?text=No+Cover`;
    }

    getVideoCoverUrl(id, size = '1280') {
        if (!id) return null;

        if (typeof id === 'string' && (id.startsWith('http') || id.startsWith('blob:') || id.startsWith('assets/'))) {
            return id;
        }

        const normalizedId = String(id)
            .replace(/\\/g, '/')
            .replace(/-/g, '/')
            .replace(/^\/+|\/+$/g, '');
        if (!normalizedId) return null;

        const sizeToken = /^\d+x\d+$/i.test(String(size)) ? String(size) : `${size}x${size}`;
        return `https://resources.tidal.com/videos/${normalizedId}/${sizeToken}.mp4`;
    }

    getPreferredVisualUrl(source, size = '1280') {
        if (!source || typeof source !== 'object') return null;

        const videoUrl = this.getVideoCoverUrl(source.videoCover, size);
        if (videoUrl) return videoUrl;
        return this.getCoverUrl(source.cover, size);
    }

    getArtistPictureUrl(id, size = '320') {
        if (!id) {
            return 'assets/appicon.png';
        }

        if (id && typeof id === 'object') {
            if (Array.isArray(id)) {
                const firstUrl = id.find((entry) => typeof entry === 'string' && entry.trim());
                return firstUrl || 'assets/appicon.png';
            }

            if (typeof id.url === 'string' && id.url.trim()) {
                return this.getArtistPictureUrl(id.url, size);
            }

            const stringEntries = Object.entries(id).filter(([, value]) => typeof value === 'string' && value.trim());
            if (stringEntries.length > 0) {
                const normalizedSize = String(size);
                const preferredKeys = [
                    normalizedSize,
                    `${normalizedSize}x${normalizedSize}`,
                    '1280',
                    '1024',
                    '750',
                    '640',
                    '320',
                    '160',
                    '80',
                ];
                for (const key of preferredKeys) {
                    const hit = stringEntries.find(([entryKey]) => entryKey === key);
                    if (hit) return hit[1];
                }

                const numeric = stringEntries
                    .map(([entryKey, value]) => ({ size: Number.parseInt(entryKey, 10), value }))
                    .filter((item) => Number.isFinite(item.size))
                    .sort((a, b) => b.size - a.size);
                if (numeric.length > 0) return numeric[0].value;

                return stringEntries[0][1];
            }
        }

        if (typeof id === 'string' && (id.startsWith('blob:') || id.startsWith('assets/') || id.startsWith('data:'))) {
            return id;
        }

        if (typeof id === 'string' && id.startsWith('http')) {
            return id;
        }

        if (typeof id !== 'string') {
            return 'assets/appicon.png';
        }

        const formattedId = id.replace(/-/g, '/');
        return `https://resources.tidal.com/images/${formattedId}/${size}x${size}.jpg`;
    }

    extractStreamUrlFromManifest(manifest) {
        if (!manifest) return null;

        try {
            let decoded;
            if (typeof manifest === 'string') {
                try {
                    decoded = atob(manifest);
                } catch {
                    decoded = manifest;
                }
            } else if (typeof manifest === 'object') {
                if (manifest.urls?.[0]) return manifest.urls[0];
                return null;
            } else {
                return null;
            }

            if (decoded.includes('<MPD')) {
                const blob = new Blob([decoded], { type: 'application/dash+xml' });
                return URL.createObjectURL(blob);
            }

            try {
                const parsed = JSON.parse(decoded);
                if (parsed?.urls?.[0]) {
                    return parsed.urls[0];
                }
            } catch {
                const match = decoded.match(/https?:\/\/[\w\-.~:?#[@!$&'()*+,;=%/]+/);
                return match ? match[0] : null;
            }

            if (typeof manifest === 'string' && /^https?:\/\//.test(manifest)) {
                return manifest;
            }
            return null;
        } catch {
            return null;
        }
    }

    // ---- downloads ------------------------------------------------------

    async downloadTrack(id, quality = 'HI_RES_LOSSLESS', filename, options = {}) {
        const { onProgress, track } = options;

        try {
            const lookup = await this.getTrack(id, quality, track);
            let streamUrl;
            let blob;

            if (lookup.originalTrackUrl) {
                streamUrl = lookup.originalTrackUrl;
            } else {
                streamUrl = this.extractStreamUrlFromManifest(lookup.info.manifest);
                if (!streamUrl) {
                    throw new Error('Could not resolve stream URL');
                }
            }

            if (streamUrl.startsWith('blob:')) {
                try {
                    const downloader = new DashDownloader();
                    blob = await downloader.downloadDashStream(streamUrl, {
                        signal: options.signal,
                        onProgress: options.onProgress,
                    });
                } catch (dashError) {
                    console.error('DASH download failed:', dashError);
                    if (quality !== 'LOSSLESS') {
                        console.warn('Falling back to LOSSLESS (16-bit) download.');
                        return this.downloadTrack(id, 'LOSSLESS', filename, options);
                    }
                    throw dashError;
                }
            } else if (isHlsStreamUrl(streamUrl)) {
                // Hi-Res HLS (Tidal FLAC up to 192 kHz) is reassembled into a
                // real audio file: init segment + per-segment mdat payloads,
                // FLAC STREAMINFO header included, tags embedded below.
                try {
                    const downloader = new HlsDownloader();
                    blob = await downloader.downloadHlsStream(streamUrl, {
                        signal: options.signal,
                        onProgress: options.onProgress,
                    });
                } catch (hlsError) {
                    console.error('HLS download failed:', hlsError);
                    if (quality !== 'LOSSLESS') {
                        console.warn('Falling back to LOSSLESS (16-bit) download.');
                        return this.downloadTrack(id, 'LOSSLESS', filename, options);
                    }
                    throw hlsError;
                }
            } else {
                const response = await fetch(streamUrl, {
                    cache: 'no-store',
                    signal: options.signal,
                });

                if (!response.ok) {
                    throw new Error(`Fetch failed: ${response.status}`);
                }

                const contentLength = response.headers.get('Content-Length');
                const totalBytes = contentLength ? parseInt(contentLength, 10) : 0;

                let receivedBytes = 0;

                if (response.body && onProgress) {
                    const reader = response.body.getReader();
                    const chunks = [];

                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;

                        if (value) {
                            chunks.push(value);
                            receivedBytes += value.byteLength;

                            onProgress({
                                stage: 'downloading',
                                receivedBytes,
                                totalBytes: totalBytes || undefined,
                            });
                        }
                    }

                    blob = new Blob(chunks, { type: response.headers.get('Content-Type') || 'audio/flac' });
                } else {
                    blob = await response.blob();
                    if (onProgress) {
                        onProgress({
                            stage: 'downloading',
                            receivedBytes: blob.size,
                            totalBytes: blob.size,
                        });
                    }
                }
            }

            if (track) {
                if (onProgress) {
                    onProgress({
                        stage: 'processing',
                        message: 'Adding metadata...',
                    });
                }
                blob = await addMetadataToAudio(blob, track, this, quality);
            }

            const detectedExtension = await getExtensionFromBlob(blob);
            let finalFilename = filename;

            const currentExtension = filename.split('.').pop()?.toLowerCase();
            if (currentExtension && currentExtension !== detectedExtension) {
                finalFilename = filename.replace(/\.[^.]+$/, `.${detectedExtension}`);
            }

            this.triggerDownload(blob, finalFilename);
        } catch (error) {
            if (error.name === 'AbortError') {
                throw error;
            }
            console.error('Download failed:', error);
            throw new Error('Download failed. The stream may require a proxy.');
        }
    }

    triggerDownload(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    // ---- cache management ----------------------------------------------

    async clearCache() {
        await this.cache.clear();
        this.streamCache.clear();
        this._searchCache.clear();
        this.trackRegistry.clear();
        this._clearStreamCacheLocalAll();
    }

    getCacheStats() {
        return {
            ...this.cache.getCacheStats(),
            streamUrls: this.streamCache.size,
        };
    }

    async clearStreamCache() {
        this.streamCache.clear();
        this._clearStreamCacheLocalAll();
    }

    _clearStreamCacheLocalAll() {
        try {
            const removals = [];
            for (let i = 0; i < localStorage.length; i++) {
                const storageKey = localStorage.key(i);
                if (storageKey && storageKey.startsWith(STREAM_CACHE_LOCAL_PREFIX)) {
                    removals.push(storageKey);
                }
            }
            for (const storageKey of removals) {
                localStorage.removeItem(storageKey);
            }
        } catch {
            /* ignore */
        }
    }
}
