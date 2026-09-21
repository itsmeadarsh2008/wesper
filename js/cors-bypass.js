// Global CORS bypass for all environments.
// All environments route proxied traffic through the same-origin /cors-proxy/
// route (Vite dev server, or the host's _redirects rule in production), so the
// browser only ever talks to its own origin. Production additionally falls back
// to a chain of public CORS proxies when the origin route is unavailable, and a
// dead proxy is skipped while a working one is remembered in localStorage.

const CORS_PROXY_PREFIX = '/cors-proxy/';
const PROXY_STORAGE_KEY = 'mono-cors-proxy-index';
const PROXY_DEAD_KEY = 'mono-cors-proxy-dead';
// Optional self-hosted proxy. When set (any HTTPS url), it becomes the first
// entry of the proxy chain — public proxies are only used as a fallback. Set
// it once from the console:
//   localStorage.setItem('mono-cors-proxy-custom', 'https://your-proxy.example/cors/')
// A deployable Cloudflare Worker is in cors-proxy-worker.js.
const CUSTOM_PROXY_KEY = 'mono-cors-proxy-custom';
// A proxy is quarantined for this long after it fails twice in a row. Public
// proxies often stay broken (403s / DNS death) for hours, so the quarantine
// is deliberately long; a working proxy is remembered anyway on success.
const PROXY_DEAD_COOLDOWN_MS = 2 * 60 * 60 * 1000;

// Public proxy fallback chain (production only). Ordered by preference.
const PROXY_TEMPLATES = [
    (encoded) => `https://corsproxy.io/proxy?url=${encoded}`,
    (encoded) => `https://api.allorigins.win/raw?url=${encoded}`,
    (encoded) => `https://cors-proxy.htmldriven.com/?url=${encoded}`,
];

// A self-hosted proxy configured by the user becomes the first entry of the
// chain (index 0), so every proxied request tries it before the public ones.
// Existing quarantine/remembered-index state self-corrects on the next probe.
const customProxyTemplate = getCustomProxyTemplate();
if (customProxyTemplate) {
    PROXY_TEMPLATES.unshift(customProxyTemplate);
}

// A custom self-hosted proxy (set via localStorage) is prepended to the chain
// so every proxied request tries it first. It never needs CORS itself because
// browsers request it through the same-origin /cors-proxy/ route in dev and the
// same-origin rule on hosted deploys.
function getCustomProxyTemplate() {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    try {
        const url = window.localStorage.getItem(CUSTOM_PROXY_KEY);
        if (!url || !/^https?:\/\//i.test(String(url))) return null;
        const normalized = String(url).replace(/\/+$/, '');
        return (encoded) => `${normalized}?url=${encoded}`;
    } catch {
        return null;
    }
}

// Hosts that need proxying. This Set is used by rewriteUrl/needsProxy and can
// grow at runtime — addProxyHost() registers unknown stream hosts on the fly so
// new CDNs (from user-configured addons) are proxied without a redeploy.
const NEEDS_PROXY_HOSTS = new Set([
    'resources.tidal.com',
    'sp-ad-fa.audio.tidal.com',
    'lgf.audio.tidal.com',
    'audio.tidal.com',
    'hifi-two.spotisaver.net',
    'hifi.geeked.wtf',
    'maus.qqdl.site',
    'vogel.qqdl.site',
    'katze.qqdl.site',
    'hund.qqdl.site',
    'wolf.qqdl.site',
    'monochrome-api.samidy.com',
    'tidal.kinoplus.online',
    'lyricsplus.binimum.org',
    'lyricsplus.atomix.one',
    'lyricsplus-seven.vercel.app',
    'lyrics-plus-backend.vercel.app',
    'storage.lyrics-api.binimum.org',
    'sheets.artistgrid.cx',
    'trends.artistgrid.cx',
    'tracker.israeli.ovh',
    'www.youtube.com',
    'youtube.com',
]);

// Hosts that support CORS natively (never need proxy)
// NOTE: translate.googleapis.com serves Access-Control-Allow-Origin: * on
// success and is fetched directly by the am-lyrics component for both
// translation (dt=t) and romanization/pronunciation (dt=rm). Routing it
// through the proxy chain breaks both features: the same-origin
// /cors-proxy/ route does not exist on Appwrite Sites (400/404 from the
// Appwrite router), and the public fallbacks reject Google (corsproxy.io
// 403s, allorigins 520s). Keep it direct.
const CORS_SUPPORTED_HOSTS = new Set([
    'translate.googleapis.com',
    'translate.google.com',
    'sgp.cloud.appwrite.io',
    'cloud.appwrite.io',
    'fra.cloud.appwrite.io',
    'nyc.cloud.appwrite.io',
    'lon.cloud.appwrite.io',
    'auth.tidal.com',
    'api.tidal.com',
    'openapi.tidal.com',
    'triton.squid.wtf',
    'arran.monochrome.tf',
    'eu-central.monochrome.tf',
    'ohio-1.monochrome.tf',
    'us-west.monochrome.tf',
    'manifest.tidal.com',
]);

// Media manifest hosts send Access-Control-Allow-Origin: * on every region
// (im-fa/eu-fa/us-fa/ne-fa.manifest.tidal.com), so DASH/MPD manifests are
// fetched directly instead of through the (flaky) CORS proxy chain. Segment
// hosts (sp-ad-fa.audio.tidal.com etc.) do NOT send CORS headers and stay
// proxied. `manifest.tidal.com` is listed above for exact-match hosts.
function isTidalManifestHost(host) {
    return host === 'manifest.tidal.com' || host.endsWith('.manifest.tidal.com');
}

function isLocalBrowserDev() {
    if (typeof window === 'undefined' || !window.location) return false;
    const host = window.location.hostname;
    return host === 'localhost' || host === '127.0.0.1';
}

// Returns the index of the currently active public proxy, or 0 by default.
function getActiveProxyIndex() {
    if (typeof window === 'undefined' || !window.localStorage) return 0;
    try {
        const idx = parseInt(window.localStorage.getItem(PROXY_STORAGE_KEY), 10);
        if (Number.isInteger(idx) && idx >= 0 && idx < PROXY_TEMPLATES.length) return idx;
    } catch {
        /* ignore storage errors */
    }
    return 0;
}

// Remembers a proxy that actually worked so later requests skip the dead ones.
function setActiveProxyIndex(idx) {
    if (idx == null || idx >= PROXY_TEMPLATES.length) return;
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
        window.localStorage.setItem(PROXY_STORAGE_KEY, String(idx));
    } catch {
        /* ignore storage errors */
    }
}

// ---- dead-proxy quarantine -------------------------------------------------
// Public proxies die often. Once a template fails repeatedly it is quarantined
// so every later request (fetch wrapper, XHR rewrite, image loader) skips it
// and starts from a proxy that actually responds.

function readDeadProxies() {
    if (typeof window === 'undefined' || !window.localStorage) return {};
    try {
        const raw = window.localStorage.getItem(PROXY_DEAD_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function writeDeadProxies(dead) {
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
        window.localStorage.setItem(PROXY_DEAD_KEY, JSON.stringify(dead));
    } catch {
        /* ignore storage errors */
    }
}

function markProxyDead(idx) {
    if (idx == null || idx < 0 || idx >= PROXY_TEMPLATES.length) return;
    const dead = readDeadProxies();
    dead[idx] = Date.now() + PROXY_DEAD_COOLDOWN_MS;
    writeDeadProxies(dead);
    console.warn(
        `[CORS Bypass] Public CORS proxy #${idx} marked dead (${PROXY_DEAD_COOLDOWN_MS / 60000} min quarantine).`
    );
}

function markProxyAlive(idx) {
    if (idx == null || idx < 0 || idx >= PROXY_TEMPLATES.length) return;
    const dead = readDeadProxies();
    if (dead[idx] == null) return;
    delete dead[idx];
    writeDeadProxies(dead);
}

function isProxyDead(idx) {
    const until = readDeadProxies()[idx];
    if (!until) return false;
    if (until <= Date.now()) {
        const dead = readDeadProxies();
        delete dead[idx];
        writeDeadProxies(dead);
        return false;
    }
    return true;
}

// First live proxy index, starting from the remembered active one. Falls back
// to 0 when every proxy is quarantined (quarantine entries are time-bounded).
function firstLiveProxyIndex() {
    const start = getActiveProxyIndex();
    for (let i = 0; i < PROXY_TEMPLATES.length; i++) {
        const idx = (start + i) % PROXY_TEMPLATES.length;
        if (!isProxyDead(idx)) return idx;
    }
    return 0;
}

// Failure bookkeeping per session — two consecutive failures quarantine a proxy.
const proxyFailureCounts = new Map();

function noteProxyFailure(idx) {
    const count = (proxyFailureCounts.get(idx) || 0) + 1;
    proxyFailureCounts.set(idx, count);
    if (count >= 2) {
        markProxyDead(idx);
        proxyFailureCounts.delete(idx);
    }
}

function noteProxySuccess(idx) {
    proxyFailureCounts.delete(idx);
    markProxyAlive(idx);
}

function sanitizeHost(hostname) {
    const host = String(hostname || '')
        .toLowerCase()
        .trim();
    return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host) ? host : null;
}

// Registers an unknown remote host so future requests to it are proxied.
function addProxyHost(hostname) {
    const host = sanitizeHost(hostname);
    if (!host || host === window.location.hostname || CORS_SUPPORTED_HOSTS.has(host)) return false;
    if (isTidalManifestHost(host)) return false;
    if (NEEDS_PROXY_HOSTS.has(host)) return true;
    NEEDS_PROXY_HOSTS.add(host);
    return true;
}

function needsProxy(hostname) {
    const host = hostname.toLowerCase();
    if (host === window.location.hostname) return false;
    if (CORS_SUPPORTED_HOSTS.has(host)) return false;
    if (isTidalManifestHost(host)) return false;
    if (host.endsWith('.cloud.appwrite.io')) return false;
    if (host.endsWith('.monochrome.tf')) return false;
    if (NEEDS_PROXY_HOSTS.has(host)) return true;
    return false;
}

function encodeUrl(url) {
    return encodeURIComponent(new URL(url, window.location.href).toString());
}

// Plain rewrite used by XHR: special routes + public proxy in production
// (dash.js segments keep the long-standing, proven behavior).
function rewriteUrl(rawUrl) {
    if (typeof rawUrl !== 'string') return rawUrl;

    try {
        const parsed = new URL(rawUrl, window.location.href);
        if (!/^https?:$/i.test(parsed.protocol)) return rawUrl;
        if (parsed.origin === window.location.origin) return rawUrl;

        // Special routes (always rewrite, works in both dev and prod)
        if (parsed.pathname.startsWith('/artistgrid-api/') || parsed.pathname.startsWith('/tracker-api/')) {
            return `${parsed.pathname}${parsed.search}`;
        }

        if (!needsProxy(parsed.hostname)) {
            return rawUrl;
        }

        if (isLocalBrowserDev()) {
            return `${CORS_PROXY_PREFIX}${encodeURIComponent(parsed.toString())}`;
        }

        return PROXY_TEMPLATES[firstLiveProxyIndex()](encodeUrl(parsed.toString()));
    } catch {
        return rawUrl;
    }
}

// Same-origin variant used by fetch: dev Vite /cors-proxy/, or the host's
// _redirects rule in production. When the origin route is unavailable the
// fetch wrapper falls back to the public proxy chain.
function rewriteUrlSameOrigin(rawUrl) {
    if (typeof rawUrl !== 'string') return rawUrl;

    try {
        const parsed = new URL(rawUrl, window.location.href);
        if (!/^https?:$/i.test(parsed.protocol)) return rawUrl;
        if (parsed.origin === window.location.origin) return rawUrl;
        if (parsed.pathname.startsWith('/artistgrid-api/') || parsed.pathname.startsWith('/tracker-api/')) {
            return `${parsed.pathname}${parsed.search}`;
        }
        if (!needsProxy(parsed.hostname)) {
            return rawUrl;
        }
        return `${CORS_PROXY_PREFIX}${encodeURIComponent(parsed.toString())}`;
    } catch {
        return rawUrl;
    }
}

function proxiedUrl(originalUrl, proxyIndex) {
    return PROXY_TEMPLATES[proxyIndex](encodeUrl(originalUrl));
}

// Set once the same-origin /cors-proxy/ route proves unavailable (Vite/Netlify
// style hosts always have it; Appwrite static hosting does not).
let originRouteBroken = false;

// Image loading cannot use the fetch wrapper (``<img>` elements with
// crossOrigin don't return a Response), so the proxy chain is walked manually.
// Same-origin route first (when available), then each live public proxy; a
// failure advances to the next template and feeds the quarantine.
function buildImageCandidates(src) {
    const candidates = [];
    if (!isLocalBrowserDev() && !originRouteBroken) {
        candidates.push({ type: 'origin', url: `${CORS_PROXY_PREFIX}${encodeURIComponent(src)}` });
    }
    if (!isLocalBrowserDev()) {
        const startIndex = firstLiveProxyIndex();
        for (let i = 0; i < PROXY_TEMPLATES.length; i++) {
            const idx = (startIndex + i) % PROXY_TEMPLATES.length;
            if (isProxyDead(idx)) continue;
            candidates.push({ type: 'proxy', index: idx, url: PROXY_TEMPLATES[idx](encodeUrl(src)) });
        }
        // Even a fully quarantined chain keeps one candidate: quarantine
        // entries are time-bounded, and a momentarily unresponsive proxy may
        // still answer — better a slow attempt than a hard failure.
        if (candidates.length === 0) {
            const idx = firstLiveProxyIndex();
            candidates.push({ type: 'proxy', index: idx, url: PROXY_TEMPLATES[idx](encodeUrl(src)) });
        }
    }
    return candidates;
}

// Loads an image through the CORS proxy chain. Resolves the loaded
// HTMLImageElement (crossOrigin set, ready for canvas work) or rejects when
// every candidate failed.
function loadImageWithCorsBypass(src, timeoutMs = 12000) {
    if (typeof window === 'undefined' || !window.Image) {
        return Promise.reject(new Error('Image loading unavailable'));
    }
    if (isLocalBrowserDev()) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error(`Failed to load image: ${src}`));
            img.src = `${CORS_PROXY_PREFIX}${encodeURIComponent(src)}`;
        });
    }

    const candidates = buildImageCandidates(src);
    return candidates
        .reduce(
            (chain, candidate) => {
                return chain.catch(() => {
                    const attempt = () =>
                        new Promise((resolve, reject) => {
                            const img = new Image();
                            const timer = setTimeout(() => {
                                img.onload = null;
                                img.onerror = null;
                                reject(new Error(`Image load timed out: ${src}`));
                            }, timeoutMs);
                            img.crossOrigin = 'anonymous';
                            img.onload = () => {
                                clearTimeout(timer);
                                resolve(img);
                            };
                            img.onerror = () => {
                                clearTimeout(timer);
                                reject(new Error(`Failed to load image: ${src}`));
                            };
                            img.src = candidate.url;
                        });

                    return attempt().then(
                        (img) => {
                            if (candidate.type === 'origin') {
                                originRouteBroken = false;
                            } else {
                                noteProxySuccess(candidate.index);
                                if (candidate.index !== firstLiveProxyIndex()) setActiveProxyIndex(candidate.index);
                            }
                            return img;
                        },
                        (error) => {
                            if (candidate.type === 'origin') {
                                originRouteBroken = true;
                            } else {
                                noteProxyFailure(candidate.index);
                            }
                            throw error;
                        }
                    );
                });
            },
            Promise.reject(new Error('No proxy candidates'))
        )
        .catch((error) => {
            throw new Error(`Failed to load image through CORS proxies: ${error.message}`);
        });
}

// Sync helper for code that writes an <img src> directly: returns the URL of
// the preferred live proxy (or the same-origin route when available).
function rewriteImageUrl(src) {
    if (typeof src !== 'string' || !/^https?:/i.test(src)) return src;
    if (!originRouteBroken) {
        return `${CORS_PROXY_PREFIX}${encodeURIComponent(src)}`;
    }
    const liveIndex = firstLiveProxyIndex();
    return PROXY_TEMPLATES[liveIndex](encodeUrl(src));
}

function installGlobalCorsBypass() {
    if (typeof window === 'undefined') return;
    window.__corsBypass = window.__corsBypass || { addProxyHost };
    window.__corsBypass.loadImageWithCorsBypass = loadImageWithCorsBypass;
    window.__corsBypass.rewriteImageUrl = rewriteImageUrl;
    window.__corsBypass.rewriteUrl = rewriteUrl;
    if (window.__globalCorsBypassInstalled) return;
    window.__globalCorsBypassInstalled = true;

    if (isLocalBrowserDev()) {
        console.log('[CORS Bypass] Local dev mode — routing through Vite proxy.');
    } else {
        console.log(`[CORS Bypass] Production mode — public CORS proxy #${firstLiveProxyIndex()}.`);
    }

    if (!window.__originalFetch && typeof window.fetch === 'function') {
        window.__originalFetch = window.fetch.bind(window);

        window.fetch = async (input, init) => {
            const originalUrl = typeof input === 'string' ? input : input.url;
            const rewrittenUrl = rewriteUrlSameOrigin(originalUrl);

            if (rewrittenUrl === originalUrl) {
                return window.__originalFetch(input, init);
            }

            const buildRequest = (url) =>
                typeof input === 'string' ? url : new Request(url, init === undefined ? input : init);

            // Same-origin /cors-proxy/ attempt (Vite in dev, _redirects in prod).
            // Once it's proven unavailable (404 / HTML shell), skip it for the
            // rest of the session so every proxied fetch doesn't re-probe it.
            let lastError = null;
            if (!originRouteBroken) {
                try {
                    const res = await window.__originalFetch(buildRequest(rewrittenUrl), init);
                    if (res.ok && !String(res.headers.get('content-type') || '').startsWith('text/html')) {
                        return res;
                    }
                    originRouteBroken = true;
                    lastError = new Error(`same-origin proxy unavailable (HTTP ${res.status})`);
                } catch (error) {
                    lastError = error;
                }
            }

            // Local dev: the Vite proxy is the only route — no fallback chain.
            if (isLocalBrowserDev()) {
                throw lastError;
            }

            // Production fallback: try the active public proxy first, then the
            // remaining chain in order. A successful retry becomes the default
            // and failures feed the quarantine.
            const startIndex = firstLiveProxyIndex();
            for (let i = 0; i < PROXY_TEMPLATES.length; i++) {
                const idx = (startIndex + i) % PROXY_TEMPLATES.length;
                try {
                    const res = await window.__originalFetch(buildRequest(proxiedUrl(originalUrl, idx)), init);
                    if (res.ok) {
                        noteProxySuccess(idx);
                        if (idx !== startIndex) setActiveProxyIndex(idx);
                        return res;
                    }
                    noteProxyFailure(idx);
                    lastError = new Error(`CORS proxy #${idx} rejected with HTTP ${res.status}`);
                } catch (error) {
                    noteProxyFailure(idx);
                    lastError = error;
                }
            }
            throw lastError || new Error('All CORS proxies failed');
        };
    }

    if (!window.__originalXHROpen && typeof XMLHttpRequest !== 'undefined') {
        window.__originalXHROpen = XMLHttpRequest.prototype.open;

        XMLHttpRequest.prototype.open = function (method, url, ...rest) {
            const rewrittenUrl = rewriteUrl(typeof url === 'string' ? url : String(url));
            return window.__originalXHROpen.call(this, method, rewrittenUrl, ...rest);
        };
    }
}

installGlobalCorsBypass();
