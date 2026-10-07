//js/artist-signature.js
// Artist signatures via the artist-signature package installed straight from
// GitHub. Direct mode: live Wikimedia Commons + MusicBrainz lookup, no API
// server needed (safe to call from the browser).
import { findLiveRecords } from '@artist-signatures/direct';

const memoryCache = new Map(); // normalized name -> signature record | null
const inflight = new Map(); // normalized name -> Promise
const STORAGE_KEY = 'wesper-artist-signature-v1';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const STORAGE_MAX_ENTRIES = 300;

function normalizeKey(name) {
    return String(name || '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

function readStored(key) {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return undefined;
        const all = JSON.parse(raw);
        const entry = all[key];
        if (!entry) return undefined;
        if (Date.now() - entry.at > CACHE_TTL_MS) return undefined;
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

// Best-ranked signature for an artist name, or null when none is servable.
// The Direct lookup already sorts redistributable + vector formats first.
export async function getArtistSignature(name) {
    const key = normalizeKey(name);
    if (!key) return null;
    if (memoryCache.has(key)) return memoryCache.get(key);
    const stored = readStored(key);
    if (stored !== undefined) {
        memoryCache.set(key, stored);
        return stored;
    }
    if (inflight.has(key)) return inflight.get(key);

    const pending = (async () => {
        try {
            const result = await findLiveRecords(name, { maxCandidates: 15, maxFilesImported: 3 });
            const record = result?.items?.[0]?.record || null;
            const value =
                record?.asset?.url != null
                    ? {
                          url: record.asset.url,
                          format: record.asset.format || null,
                          width: record.asset.width ?? null,
                          height: record.asset.height ?? null,
                      }
                    : null;
            memoryCache.set(key, value);
            writeStored(key, value);
            return value;
        } catch (error) {
            console.warn('[ArtistSignature] lookup failed:', error?.message || error);
            return null;
        } finally {
            inflight.delete(key);
        }
    })();
    inflight.set(key, pending);
    return pending;
}

// Replaces the artist-page title text with the handwritten signature image.
// Falls back to (keeps) the plain name when no signature exists or the
// lookup fails. Never throws. `isCurrent` guards against stale renders.
export async function renderArtistSignature(nameEl, artistName, isCurrent) {
    if (!nameEl || !artistName) return;
    try {
        const signature = await getArtistSignature(artistName);
        if (!signature) return;
        if (typeof isCurrent === 'function' && !isCurrent()) return;

        const img = document.createElement('img');
        img.className = 'artist-signature-img';
        img.src = signature.url;
        img.alt = artistName;
        img.decoding = 'async';
        img.onerror = () => {
            if (typeof isCurrent === 'function' && !isCurrent()) return;
            nameEl.classList.remove('has-signature');
            nameEl.textContent = artistName;
        };

        nameEl.innerHTML = '';
        nameEl.setAttribute('aria-label', artistName);
        nameEl.title = artistName;
        nameEl.classList.remove('long-title', 'very-long-title');
        nameEl.classList.add('has-signature');
        nameEl.appendChild(img);
    } catch {
        /* keep the plain artist name */
    }
}
