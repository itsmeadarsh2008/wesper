//js/apple-motion.js
// Apple Music motion artwork resolver — fully public endpoints, no API key.
//
// 1. iTunes Search API (CORS-open) resolves a track to its Apple Music page.
// 2. The public album page embeds videoArtwork.motionDetailSquare with an
//    HLS motion URL + poster template (fetched via the app CORS proxy when
//    the direct request is blocked; mvod segments are CORS-open).
// Results cached in memory + localStorage (30 days, cap 200).

import { getTrackArtists } from './utils.js';
import { hifiVisualSettings } from './storage.js';

const ITUNES_SEARCH_URL = 'https://itunes.apple.com/search';
const MEM_CACHE = new Map(); // trackKey -> { url, poster } | null
const INFLIGHT = new Map(); // trackKey -> Promise
const STORAGE_KEY = 'wesper-apple-motion-v2';
const STORAGE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const STORAGE_MAX_ENTRIES = 200;

export function appleMotionTrackKey(track) {
    if (!track) return '';
    if (track.id) return `id:${track.id}`;
    const title = String(track.title || '').trim();
    const artist = getTrackArtists(track);
    if (!title) return '';
    return `${title}::${artist}`.toLowerCase();
}

function normalizeName(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/\s*\([^)]*\)\s*/g, ' ')
        .replace(/\s*\[[^\]]*\]\s*/g, ' ')
        .replace(/[^a-z0-9\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function artistTokens(track) {
    const raw = getTrackArtists(track);
    return raw
        .split(/[,;&/]+|\s+feat\.?\s+|\s+ft\.?\s+|\s+x\s+/i)
        .map((part) => normalizeName(part))
        .filter(Boolean);
}

function scoreCandidate(candidate, track) {
    if (!candidate || typeof candidate !== 'object') return -1;
    const wantTitle = normalizeName(track.title);
    const gotTitle = normalizeName(candidate.trackName);
    if (!wantTitle || !gotTitle || wantTitle !== gotTitle) return -1;

    const wantArtists = artistTokens(track);
    const gotArtist = normalizeName(candidate.artistName);
    const artistHit = wantArtists.some((a) => gotArtist.includes(a) || a.split(' ').some((w) => gotArtist.includes(w)));
    if (!artistHit) return -1;

    let score = 10;
    const wantAlbum = normalizeName(track.album?.title);
    const gotAlbum = normalizeName(candidate.collectionName);
    if (wantAlbum && gotAlbum && (gotAlbum.includes(wantAlbum) || wantAlbum.includes(gotAlbum))) {
        score += 5;
    }
    // Prefer the original over remixes/live editions when titles tie.
    if (!/remix|live|acoustic|sped up|slowed|instrumental|karaoke/i.test(candidate.trackName || '')) {
        score += 1;
    }
    return score;
}

async function searchItunes(track, timeoutMs = 10000) {
    const title = String(track.title || '').trim();
    const artists = artistTokens(track);
    if (!title) return [];
    const query = `${title} ${artists[0] || ''}`.trim();
    const url = `${ITUNES_SEARCH_URL}?term=${encodeURIComponent(query)}&entity=song&limit=12&country=US&lang=en_us`;
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.results) ? data.results : [];
}

function pickBestCandidate(results, track) {
    let best = null;
    let bestScore = -1;
    for (const candidate of results) {
        const score = scoreCandidate(candidate, track);
        if (score > bestScore) {
            bestScore = score;
            best = candidate;
        }
    }
    return bestScore > 0 ? best : null;
}

async function fetchApplePageHtml(pageUrl, timeoutMs = 15000) {
    try {
        const direct = await fetch(pageUrl, { signal: AbortSignal.timeout(timeoutMs) });
        if (direct.ok) return await direct.text();
    } catch {
        // Blocked (no ACAO on web pages) — fall through to the app proxy.
    }
    try {
        const rewrite = window.__corsBypass?.rewriteUrl?.(pageUrl);
        if (rewrite && rewrite !== pageUrl) {
            const proxied = await fetch(rewrite, { signal: AbortSignal.timeout(timeoutMs) });
            if (proxied.ok) {
                const text = await proxied.text();
                // A proxy error page (HTML shell) is not the album page.
                if (text.includes('motionDetailSquare') || text.includes('videoArtwork')) return text;
            }
        }
    } catch {
        /* fall through to null */
    }
    return null;
}

// The page embeds videoArtwork.dictionary.motionDetailSquare with a
// previewFrame url template and the HLS motion video URL.
export function extractAppleMotionArt(html) {
    if (!html || typeof html !== 'string') return null;
    const anchor = html.indexOf('motionDetailSquare');
    if (anchor === -1) return null;
    const window = html.slice(anchor, anchor + 8000);
    const videoMatch = /"video"\s*:\s*"([^"]+\.m3u8[^"]*)"/.exec(window);
    if (!videoMatch) return null;
    const url = videoMatch[1].replace(/\\\//g, '/');
    if (!/^https:\/\//i.test(url)) return null;

    let poster = null;
    const posterMatch = /"url"\s*:\s*"([^"]+)"/.exec(window);
    if (posterMatch) {
        poster = posterMatch[1].replace(/\\\//g, '/').replace('{w}x{h}', '1080x1080').replace('{f}', 'jpg');
        if (!/^https:\/\//i.test(poster)) poster = null;
    }
    return { url, poster };
}

function readStored(key) {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return undefined;
        const all = JSON.parse(raw);
        const entry = all[key];
        if (!entry) return undefined;
        if (Date.now() - entry.at > STORAGE_TTL_MS) return undefined;
        return entry.value;
    } catch {
        return undefined;
    }
}

function writeStored(key, value) {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        const all = raw ? JSON.parse(raw) : {};
        all[key] = { at: Date.now(), value };
        const keys = Object.keys(all);
        if (keys.length > STORAGE_MAX_ENTRIES) {
            keys.sort((a, b) => all[a].at - all[b].at);
            for (const old of keys.slice(0, keys.length - STORAGE_MAX_ENTRIES)) delete all[old];
        }
        localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
    } catch {
        /* storage unavailable or full: memory cache still applies */
    }
}

// Best Apple motion artwork for a track: { url (HLS), poster } or null.
// Gated on the Prefer Video Cover setting so misses are never cached while
// the feature is off (enabling it later must take effect immediately).
export async function getAppleMotionArt(track) {
    if (!hifiVisualSettings.prefersVideoCover()) return null;
    const key = appleMotionTrackKey(track);
    if (!key) return null;
    if (MEM_CACHE.has(key)) return MEM_CACHE.get(key);
    const stored = readStored(key);
    if (stored !== undefined) {
        MEM_CACHE.set(key, stored);
        return stored;
    }
    if (INFLIGHT.has(key)) return INFLIGHT.get(key);

    const pending = (async () => {
        try {
            const results = await searchItunes(track);
            const best = pickBestCandidate(results, track);
            if (!best) return null;
            const pageUrl = best.trackViewUrl || best.collectionViewUrl;
            if (!pageUrl) return null;
            const html = await fetchApplePageHtml(pageUrl);
            const art = html ? extractAppleMotionArt(html) : null;
            const value = art && art.url ? art : null;
            MEM_CACHE.set(key, value);
            writeStored(key, value);
            return value;
        } catch (error) {
            console.warn('[AppleMotion] lookup failed:', error?.message || error);
            return null;
        } finally {
            INFLIGHT.delete(key);
        }
    })();
    INFLIGHT.set(key, pending);
    return pending;
}
