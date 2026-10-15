import { modernSettings } from './ModernSettings.js';
import { qualityBadgeSettings, coverArtSizeSettings, trackDateSettings } from './storage.js';
import { METADATA_STRINGS } from './METADATA_STRINGS.js';
import {
    SVG_ATMOS,
    SVG_APPLE,
    SVG_PLAY,
    SVG_PAUSE,
    SVG_PLAY_MINI,
    SVG_PAUSE_MINI,
    SVG_VOLUME,
    SVG_MUTE,
    SVG_DOWNLOAD,
    SVG_MENU,
    SVG_HEART,
    SVG_CLOSE,
    SVG_BIN,
    SVG_MIX,
} from './icons.js';

export const QUALITY = 'HI_RES_LOSSLESS';

export const REPEAT_MODE = {
    OFF: 0,
    ALL: 1,
    ONE: 2,
};

export const AUDIO_QUALITIES = {
    DOLBY_ATMOS: 'DOLBY_ATMOS',
    HI_RES_LOSSLESS: 'HI_RES_LOSSLESS',
    LOSSLESS: 'LOSSLESS',
    HIGH: 'HIGH',
    LOW: 'LOW',
};

export const QUALITY_PRIORITY = ['DOLBY_ATMOS', 'HI_RES_LOSSLESS', 'LOSSLESS', 'HIGH', 'LOW'];

export const QUALITY_TOKENS = {
    DOLBY_ATMOS: ['DOLBY_ATMOS', 'ATMOS', 'AC4', 'EAC3', 'JOC', 'AC-4', 'EC-3'],
    HI_RES_LOSSLESS: [
        'HI_RES_LOSSLESS',
        'HIRES_LOSSLESS',
        'HIRESLOSSLESS',
        'HIFI_PLUS',
        'HI_RES_FLAC',
        'HI_RES',
        'HIRES',
        'MASTER',
        'MASTER_QUALITY',
        'MQA',
        '24BIT',
    ],
    LOSSLESS: ['LOSSLESS', 'HIFI', 'FLAC', 'ALAC'],
    HIGH: ['HIGH', 'HIGH_QUALITY', '320', 'HQ'],
    LOW: ['LOW', 'LOW_QUALITY', '96', 'MOBILE'],
};

export const RATE_LIMIT_ERROR_MESSAGE = 'Too Many Requests. Please wait a moment and try again.';

export {
    SVG_PLAY,
    SVG_PAUSE,
    SVG_PLAY_MINI,
    SVG_PAUSE_MINI,
    SVG_VOLUME,
    SVG_MUTE,
    SVG_DOWNLOAD,
    SVG_MENU,
    SVG_HEART,
    SVG_CLOSE,
    SVG_BIN,
    SVG_MIX,
};

export const formatTime = (seconds) => {
    if (isNaN(seconds)) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
};

export const getTrackYearDisplay = (track) => {
    const useAlbumYear = trackDateSettings.useAlbumYear();
    const releaseDate = useAlbumYear
        ? track?.album?.releaseDate || track?.streamStartDate
        : track?.streamStartDate || track?.album?.releaseDate;
    if (!releaseDate) return '';
    const date = new Date(releaseDate);
    return isNaN(date.getTime()) ? '' : ` • ${date.getFullYear()}`;
};

export const createPlaceholder = (text, isLoading = false) => {
    return `<div class="placeholder-text ${isLoading ? 'loading' : ''}">${text}</div>`;
};

export const trackDataStore = new WeakMap();
export const coverCache = new Map();

/**
 * Resizes an image Blob to a specific square dimension using a canvas.
 */
async function resizeImageBlob(blob, size) {
    if (!blob) return null;
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = size;
            canvas.height = size;
            const ctx = canvas.getContext('2d', { alpha: false });
            if (ctx) {
                ctx.imageSmoothingEnabled = true;
                ctx.imageSmoothingQuality = 'high';
                ctx.drawImage(img, 0, 0, size, size);
            }
            canvas.toBlob(
                (resized) => {
                    URL.revokeObjectURL(img.src);
                    if (resized) resolve(resized);
                    else reject(new Error('Resize failed'));
                },
                'image/jpeg',
                0.85
            );
        };
        img.onerror = (err) => {
            URL.revokeObjectURL(img.src);
            reject(err);
        };
        img.src = URL.createObjectURL(blob);
    });
}

/**
 * Fetches and caches cover art as a Blob
 */
export async function getCoverBlob(api, coverId) {
    if (!coverId) return null;

    let sizeStr = coverArtSizeSettings.getSize();
    if (sizeStr.includes('x')) {
        sizeStr = sizeStr.split('x')[0];
    }

    let requestedSize = parseInt(sizeStr, 10);
    if (isNaN(requestedSize) || requestedSize <= 0) requestedSize = 1280;

    const cacheKey = `${coverId}-${requestedSize}`;
    if (coverCache.has(cacheKey)) return coverCache.get(cacheKey);

    // Tidal supported sizes
    const supportedSizes = [80, 160, 320, 640, 1280];
    let fetchSize = 1280;

    const bestSize = supportedSizes.find((s) => s >= requestedSize);
    if (bestSize) {
        fetchSize = bestSize;
    }

    const fetchWithProxy = async (url) => {
        try {
            const proxyUrl = `/proxy?url=${encodeURIComponent(url)}`;
            const response = await fetch(proxyUrl);
            if (response.ok) return await response.blob();
        } catch (e) {
            console.warn('Proxy fetch failed:', e);
        }
        return null;
    };

    let blob = null;
    try {
        const url = api.getCoverUrl(coverId, fetchSize.toString());
        const response = await fetch(url);
        if (response.ok) {
            blob = await response.blob();
        } else {
            blob = await fetchWithProxy(url);
        }
    } catch {
        const url = api.getCoverUrl(coverId, fetchSize.toString());
        blob = await fetchWithProxy(url);
    }

    if (blob) {
        if (fetchSize !== requestedSize) {
            try {
                blob = await resizeImageBlob(blob, requestedSize);
            } catch (e) {
                console.warn('Failed to resize cover art, using original size:', e);
            }
        }
        coverCache.set(cacheKey, blob);
        return blob;
    }
    return null;
}

/**
 * Returns a comma-separated string of all primary and featured artists,
 * with any featured artists parsed from the title (feat./with).
 */
export function getFullArtistString(track) {
    const knownArtists =
        Array.isArray(track.artists) && track.artists.length > 0
            ? track.artists.map((a) => (typeof a === 'string' ? a : a.name) || '').filter(Boolean)
            : track.artist?.name
              ? [track.artist.name]
              : [];

    const featPattern = /\(\s*(?:feat\.?|ft\.?|with)\s+(.+?)\s*\)/gi;
    const allFeatArtists = [...(track.title?.matchAll(featPattern) ?? [])].flatMap((m) =>
        m[1]
            .split(/\s*[,&]\s*/)
            .map((a) => a.trim())
            .filter(Boolean)
    );

    const result = [...new Set([...knownArtists, ...allFeatArtists])].join(', ');
    return result || METADATA_STRINGS.DEFAULT_ARTIST;
}

/**
 * Returns the track's cover ID from various possible locations in the object.
 */
export function getTrackCoverId(track) {
    return (
        track.album?.cover ||
        track.cover ||
        track.image ||
        track.album?.coverId ||
        track.coverId ||
        track.album?.image ||
        null
    );
}

export const sanitizeForFilename = (value) => {
    if (!value) return 'Unknown';
    return value
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/\s+/g, ' ')
        .trim();
};

/**
 * Detects actual audio format from blob signature
 * @param {Blob} blob - Audio blob to analyze
 * @returns {Promise<string>} - Extension: 'flac', 'm4a', or fallback based on mime
 */
export const getExtensionFromBlob = async (blob) => {
    const buffer = await blob.slice(0, 12).arrayBuffer();
    const view = new DataView(buffer);

    // Check for FLAC signature: "fLaC" (0x66 0x4C 0x61 0x43)
    if (
        view.byteLength >= 4 &&
        view.getUint8(0) === 0x66 && // f
        view.getUint8(1) === 0x4c && // L
        view.getUint8(2) === 0x61 && // a
        view.getUint8(3) === 0x43 // C
    ) {
        return 'flac';
    }

    // Check for MP4/M4A signature: "ftyp" at offset 4
    if (
        view.byteLength >= 8 &&
        view.getUint8(4) === 0x66 && // f
        view.getUint8(5) === 0x74 && // t
        view.getUint8(6) === 0x79 && // y
        view.getUint8(7) === 0x70 // p
    ) {
        return 'm4a';
    }

    // Fallback to MIME type
    const mime = blob.type;
    if (mime === 'audio/flac') return 'flac';
    if (mime === 'audio/mp4' || mime === 'audio/x-m4a') return 'm4a';

    // Default fallback
    return 'flac';
};

export const getExtensionForQuality = (quality) => {
    switch (quality) {
        case 'LOW':
        case 'HIGH':
            return 'm4a';
        default:
            return 'flac';
    }
};

export const buildTrackFilename = (track, quality, extension = null) => {
    const template = modernSettings.filenameTemplate;
    const ext = extension || getExtensionForQuality(quality);

    const artistName = track.artist?.name || track.artists?.[0]?.name || 'Unknown Artist';

    const data = {
        discNumber: getTrackDiscNumber(track) || 1,
        trackNumber: track.trackNumber,
        artist: artistName,
        title: getTrackTitle(track),
        album: track.album?.title,
    };

    return formatTemplate(template, data) + '.' + ext;
};

/**
 * Converts a value to a positive integer.
 * @param {*} value - The value to convert to a positive integer.
 * @returns {number|null} The parsed positive integer, or null if the value is not a finite positive number.
 */
export function toPositiveInt(value) {
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Extracts the disc number from a track object by checking multiple possible property names.
 * @param {Object} track - The track object to extract the disc number from.
 * @returns {number|null} The disc number as a positive integer, or null if no valid disc number is found.
 */
export function getTrackDiscNumber(track) {
    const candidates = [
        track?.volumeNumber,
        track?.discNumber,
        track?.mediaNumber,
        track?.media_number,
        track?.volume,
        track?.disc,
        track?.volume?.number,
        track?.disc?.number,
        track?.media?.number,
        track?.disc,
        track?.disc_no,
        track?.discNo,
        track?.disc_number,
        track?.mediaMetadata?.discNumber,
    ];

    for (const candidate of candidates) {
        const parsed = toPositiveInt(candidate);
        if (parsed) return parsed;
    }
    return null;
}

const sanitizeToken = (value) => {
    if (!value) return '';
    return value
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '_');
};

export const normalizeQualityToken = (value) => {
    if (!value) return null;

    // Strip bracket-wrapped provider prefixes, e.g. "[Qobuz] HI_RES_LOSSLESS"
    const unwrapped = String(value)
        .replace(/^\s*\[[^\]]*\]\s*/, '')
        .trim();
    const token = sanitizeToken(unwrapped);
    if (!token) return null;

    for (const [quality, aliases] of Object.entries(QUALITY_TOKENS)) {
        if (aliases.includes(token)) {
            return quality;
        }
    }

    // Fallback: match known markers inside richer strings,
    // e.g. "FLAC 24-bit 192 kHz" → HI_RES_LOSSLESS
    if (/ATMOS|DOLBY/.test(token)) return 'DOLBY_ATMOS';
    if (/HI_RES|HIRES|MASTER|MQA|24_BIT|24BIT|_192|192KHZ/.test(token)) return 'HI_RES_LOSSLESS';
    if (/LOSSLESS|FLAC|ALAC|HIFI/.test(token)) return 'LOSSLESS';
    if (/HIGH|HQ|_320/.test(token)) return 'HIGH';
    if (/LOW|_96/.test(token)) return 'LOW';
    return null;
};

const parseQualityStringSpec = (source) => {
    if (!source) return { bitDepth: null, sampleRate: null };

    const quality = String(source);
    const bitDepthMatch = quality.match(/(\d+)\s*(?:-|_)?\s*bit(s)?/i) || quality.match(/(\d+)\s*bit/i);
    const sampleRateMatch =
        quality.match(/([\d.]+)\s*kHz/i) ||
        quality.match(/([\d.]+)\s*khz/i) ||
        quality.match(/([\d.]+)\s*k/i) ||
        quality.match(/([\d.]+)\s*hz/i);

    return {
        bitDepth: bitDepthMatch ? parseInt(bitDepthMatch[1], 10) : null,
        sampleRate: sampleRateMatch
            ? Math.round(parseFloat(sampleRateMatch[1]) * (sampleRateMatch[0].toLowerCase().includes('khz') ? 1000 : 1))
            : null,
    };
};

export const createQualityBadgeHTML = (track, adaptiveQuality = null) => {
    if (!qualityBadgeSettings.isEnabled()) return '';

    const quality = adaptiveQuality || deriveTrackQuality(track);
    if (quality === 'DOLBY_ATMOS') {
        return `<span class="quality-badge quality-atmos" title="Dolby Atmos">${SVG_ATMOS(12)}Atmos</span>`;
    } else if (quality === 'HI_RES_LOSSLESS') {
        return '<span class="quality-badge quality-hires" title="Hi-Res Lossless">HD</span>';
    } else if (quality === 'LOSSLESS') {
        return '<span class="quality-badge quality-lossless" title="Lossless">HIFI</span>';
    }
    return '';
};

const hiresLabelHtml = () =>
    `<span class="fs-quality-tag fs-quality-hires" title="Hi-Res Lossless">${SVG_APPLE(21)}<span>HI-RES LOSSLESS</span></span>`;

export const createFullscreenQualityHTML = (track) => {
    if (!track) return '';

    const streamInfo = track.streamInfo && typeof track.streamInfo === 'object' ? track.streamInfo : {};

    // Derive quality from track
    const quality = deriveTrackQuality(track);

    const streamSpec = parseQualityStringSpec(
        streamInfo.quality ||
            streamInfo.streamQuality ||
            streamInfo.audioQuality ||
            track.audioQuality ||
            track.streamedQuality
    );

    // Prefer the actual stream specs, then fall back to the track/album metadata.
    const bitDepth = toPositiveInt(
        streamInfo.bitDepth ?? track.bitDepth ?? streamSpec.bitDepth ?? track.album?.bitDepth
    );
    const sampleRate = toPositiveInt(
        streamInfo.sampleRate ?? track.sampleRate ?? streamSpec.sampleRate ?? track.album?.sampleRate
    );

    // Format sample rate as kHz
    let sampleRateStr = null;
    if (sampleRate) {
        const kHz = sampleRate / 1000;
        sampleRateStr = `${Number.isInteger(kHz) ? kHz : kHz.toFixed(1)} kHz`;
    }

    // Format bit depth
    let bitDepthStr = null;
    if (bitDepth) {
        bitDepthStr = `${bitDepth}-bit`;
    }

    // Actual codec reported by the addon (AAC, Opus, MP3, …) — this is the
    // exact answer to "what am I listening to", preferred over container names.
    const codec = extractCodecFromMime(
        streamInfo.codec ??
            track.codec ??
            streamInfo.mimeType ??
            track.mimeType ??
            streamInfo.format ??
            track.format ??
            streamInfo.mediaType ??
            track.mediaType
    );

    // Container format reported by the addon (MP4, WEBM, FLAC, …). Wrapper
    // tokens (HLS/ADAPTIVE/DASH) are not real formats and are skipped.
    const rawFormat = String(
        streamInfo.format ?? track.format ?? streamInfo.mediaType ?? track.mediaType ?? ''
    ).toUpperCase();
    const containerFormat = rawFormat && !/UNKNOWN|AUDIO|HLS|ADAPTIVE|DASH/i.test(rawFormat) ? rawFormat : null;

    const formatStr = codec || containerFormat || null;

    // Exact bitrate when the addon reports it (e.g. 128 → "128 kbps")
    const bitrateKbps = toPositiveInt(streamInfo.bitrateKbps ?? track.bitrateKbps);
    const bitrateStr = bitrateKbps ? `${bitrateKbps} kbps` : null;

    // Lossy codecs/containers can never carry a lossless label.
    // Also consider explicit bitrates ≤ 320 as lossy even when the addon
    // wraps the stream as HLS/DASH (codec extraction returns null for wrappers).
    const lossyCodec = codec ? isLossyCodec(codec) : false;
    const lossyContainer = isLossyContainer(
        streamInfo.format ?? track.format ?? streamInfo.mediaType ?? track.mediaType
    );
    const lossy = lossyCodec || lossyContainer || (bitrateKbps != null && bitrateKbps <= 320);

    // Lossy streams have no real bit depth: the sample entry's samplesize
    // is a nominal 16 for AAC/Opus/MP3. Drop any bit depth claim so the
    // readout never shows "16-bit" next to a lossy codec.
    if (lossy) {
        bitDepthStr = null;
    }

    // For lossy 320kbps the 44.1 kHz readout is redundant — hide it so
    // the display reads "HIGH · AAC · 320 KBPS" instead of
    // "HIGH · 44.1 kHz · AAC · 320 kbps".
    if (lossy && bitrateKbps === 320 && sampleRate === 44100) {
        sampleRateStr = null;
    }

    // Determine quality label and logo (TIDAL-style caps with marks)
    let labelHtml;

    if (quality === 'DOLBY_ATMOS') {
        // For Dolby Atmos, logo + caps label (the badge already shows "Atmos" and title may have it)
        labelHtml = `<span class="fs-quality-tag" title="Dolby Atmos">${SVG_ATMOS(16)}<span>DOLBY ATMOS</span></span>`;
    } else if (lossy) {
        // Lossy format overrides any lossless claim
        labelHtml = 'HIGH';
    } else if (quality === 'HI_RES_LOSSLESS') {
        labelHtml = hiresLabelHtml();
    } else if (quality === 'LOSSLESS') {
        labelHtml = `<span class="fs-quality-tag fs-quality-lossless" title="Lossless">${SVG_APPLE(21)}<span>LOSSLESS</span></span>`;
    } else if (quality === 'HIGH') {
        labelHtml = 'HIGH';
    } else if (quality === 'LOW') {
        labelHtml = 'LOW';
    } else {
        // Unknown quality - try to infer from bit depth and sample rate
        if (bitDepth && sampleRate) {
            if (bitDepth >= 24 && sampleRate > 48000) {
                labelHtml = hiresLabelHtml();
            } else if (bitDepth >= 24 || sampleRate > 44100) {
                labelHtml = `<span class="fs-quality-tag fs-quality-lossless" title="Lossless">${SVG_APPLE(21)}<span>LOSSLESS</span></span>`;
            } else {
                labelHtml = `<span class="fs-quality-tag fs-quality-lossless" title="Lossless">${SVG_APPLE(21)}<span>LOSSLESS</span></span>`;
            }
        } else if (bitDepth) {
            labelHtml =
                bitDepth >= 24
                    ? hiresLabelHtml()
                    : `<span class="fs-quality-tag fs-quality-lossless" title="Lossless">${SVG_APPLE(21)}<span>LOSSLESS</span></span>`;
        } else if (sampleRate) {
            labelHtml =
                sampleRate > 48000
                    ? hiresLabelHtml()
                    : `<span class="fs-quality-tag fs-quality-lossless" title="Lossless">${SVG_APPLE(21)}<span>LOSSLESS</span></span>`;
        } else {
            // Default to Lossless if we can't determine
            labelHtml = `<span class="fs-quality-tag fs-quality-lossless" title="Lossless">${SVG_APPLE(21)}<span>LOSSLESS</span></span>`;
        }
    }

    // Build the display string
    const parts = [];

    // Add quality label with logo (only if not empty)
    if (labelHtml) {
        parts.push(labelHtml);
    }

    // Add bit depth
    if (bitDepthStr) {
        parts.push(bitDepthStr);
    }

    // Add sample rate
    if (sampleRateStr) {
        parts.push(sampleRateStr);
    }

    // Add container format / codec
    if (formatStr) {
        parts.push(formatStr);
    }

    // Add exact bitrate
    if (bitrateStr) {
        parts.push(bitrateStr);
    }

    // Filter out empty parts
    const validParts = parts.filter((part) => part);
    if (validParts.length === 0) return '';

    // Join with dots, but handle leading dot issue for logo-only case
    let result = validParts.join(' · ');

    // If result starts with ' · ' (dot-space), remove it
    if (result.startsWith(' · ')) {
        result = result.substring(3);
    }
    // If result ends with ' · ', remove it
    if (result.endsWith(' · ')) {
        result = result.substring(0, result.length - 3);
    }
    return result.trim();
};

export const deriveQualityFromTags = (rawTags) => {
    if (!Array.isArray(rawTags)) return null;

    const candidates = [];
    for (const tag of rawTags) {
        if (typeof tag !== 'string') continue;
        const normalized = normalizeQualityToken(tag);
        if (normalized && !candidates.includes(normalized)) {
            candidates.push(normalized);
        }
    }

    return pickBestQuality(candidates);
};

export const pickBestQuality = (candidates) => {
    let best = null;
    let bestRank = Infinity;

    for (const candidate of candidates) {
        if (!candidate) continue;
        const rank = QUALITY_PRIORITY.indexOf(candidate);
        const currentRank = rank === -1 ? Infinity : rank;

        if (currentRank < bestRank) {
            best = candidate;
            bestRank = currentRank;
        }
    }

    return best;
};

const LOSSY_CONTAINERS = new Set([
    'aac',
    'm4a',
    'mp3',
    'mpeg',
    'mp4',
    'ogg',
    'oga',
    'opus',
    'vorbis',
    'wma',
    'ac3',
    'eac3',
    'dts',
    'webm',
]);

export const isLossyContainer = (format) => {
    const f = String(format || '').toLowerCase();
    if (!f || /flac|alac|ape|pcm|dsd/i.test(f)) return false;
    const token = f.split(/[\s\-_/.]/)[0];
    return LOSSY_CONTAINERS.has(token);
};

// Resolve a display codec (AAC, Opus, MP3, …) from a codec id, mime type or
// format string. Wrapper tokens like "hls" / "adaptive" / "dash" are NOT codecs
// and resolve to null so they never leak into the exact-quality readout.
export const extractCodecFromMime = (value) => {
    const source = String(value || '');
    if (!source) return null;

    // Strip wrapper/container markers that carry no codec info.
    if (/^(hls|adaptive|dash|mpeg-dash|audio)$/i.test(source.trim())) return null;

    const codecMatch = source.match(/codecs?="?([^"',;]+)/i);
    const token = (codecMatch && codecMatch[1]) || source;
    const t = token.trim().toLowerCase();

    if (t.includes('flac')) return 'FLAC';
    if (t.includes('alac')) return 'ALAC';
    if (t.includes('opus')) return 'Opus';
    if (t.includes('mp4a') || t.includes('aac')) return 'AAC';
    if (t.includes('mp3')) return 'MP3';
    if (t.includes('vorbis')) return 'Vorbis';
    if (t.includes('ac-3') || t.includes('eac3') || t.includes('ec-3')) return 'E-AC3';
    if (t.includes('pcm')) return 'PCM';

    const firstToken = source.split(/[\s\-_/.]/)[0].toLowerCase();
    if (LOSSY_CONTAINERS.has(firstToken) || /^(flac|alac|aac)$/.test(firstToken)) {
        return firstToken === 'mp4' ? 'AAC' : firstToken.toUpperCase();
    }
    return null;
};

export const isLossyCodec = (codec) => {
    const c = String(codec || '').toLowerCase();
    if (!c || /flac|alac|ape|pcm|wav|dsd/i.test(c)) return false;
    return /aac|m4a|ac-?3|mp3|mpeg|opus|vorbis|ogg|wma|silk|amr/i.test(c);
};

export const deriveTrackQuality = (track) => {
    if (!track) return null;

    const streamInfo = track.streamInfo && typeof track.streamInfo === 'object' ? track.streamInfo : {};
    const streamSpec = parseQualityStringSpec(
        streamInfo.quality ||
            streamInfo.streamQuality ||
            streamInfo.audioQuality ||
            track.audioQuality ||
            track.streamedQuality
    );

    // Dolby Atmos is a format marker, not a bit-depth/sample-rate claim —
    // it wins over any specs, and Atmos is legitimately delivered lossy (AAC).
    const atmosFromModes =
        Array.isArray(track.audioModes) && track.audioModes.some((mode) => /ATMOS|DOLBY/i.test(String(mode)));
    const atmosFromTokens =
        normalizeQualityToken(streamInfo.audioQuality) === 'DOLBY_ATMOS' ||
        normalizeQualityToken(track.audioQuality) === 'DOLBY_ATMOS' ||
        normalizeQualityToken(streamInfo.streamQuality) === 'DOLBY_ATMOS' ||
        normalizeQualityToken(track.streamedQuality) === 'DOLBY_ATMOS' ||
        normalizeQualityToken(streamInfo.audioMode) === 'DOLBY_ATMOS' ||
        normalizeQualityToken(track.audioMode) === 'DOLBY_ATMOS' ||
        deriveQualityFromTags(track.mediaMetadata?.tags) === 'DOLBY_ATMOS' ||
        deriveQualityFromTags(track.album?.mediaMetadata?.tags) === 'DOLBY_ATMOS';
    if (atmosFromModes || atmosFromTokens) return 'DOLBY_ATMOS';

    const streamCodec = extractCodecFromMime(
        streamInfo.codec != null
            ? streamInfo.codec
            : streamInfo.mimeType != null
              ? streamInfo.mimeType
              : streamInfo.format != null
                ? streamInfo.format
                : streamInfo.mediaType != null
                  ? streamInfo.mediaType
                  : (track.codec ?? track.mimeType ?? track.format ?? track.mediaType)
    );

    // A lossy container (AAC, MP3, …) can never be lossless, no matter what
    // the provider's quality label claims — clamp it to at most HIGH.
    const lossy =
        isLossyCodec(streamCodec) ||
        isLossyContainer(streamInfo.format || track.format || streamInfo.mediaType || track.mediaType);

    // Prefer the actual stream specs when known — these are exact numbers
    // reported by the addon and more truthful than provider quality labels.
    const bitDepth = toPositiveInt(
        streamInfo.bitDepth ?? track.bitDepth ?? streamSpec.bitDepth ?? track.album?.bitDepth
    );
    const sampleRate = toPositiveInt(
        streamInfo.sampleRate ?? track.sampleRate ?? streamSpec.sampleRate ?? track.album?.sampleRate
    );
    if (bitDepth || sampleRate) {
        if (lossy) return 'HIGH';
        if (bitDepth >= 24 || sampleRate > 48000) return 'HI_RES_LOSSLESS';
        return 'LOSSLESS';
    }

    const candidates = [
        deriveQualityFromTags(track.mediaMetadata?.tags),
        deriveQualityFromTags(track.album?.mediaMetadata?.tags),
        normalizeQualityToken(streamInfo.audioQuality),
        normalizeQualityToken(track.audioQuality),
        normalizeQualityToken(streamInfo.streamQuality),
        normalizeQualityToken(track.streamedQuality),
    ];

    const best = pickBestQuality(candidates);
    if (lossy && (best === 'HI_RES_LOSSLESS' || best === 'LOSSLESS')) return 'HIGH';
    return best;
};

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const hasExplicitContent = (item) => {
    return item?.explicit === true || item?.explicitLyrics === true;
};

export const isTrackUnavailable = (track) => {
    if (!track) return true;
    if (track.isLocal) return false;
    // AllowStreaming false or StreamReady false usually mean unavailable
    // title === 'Unavailable' is also a strong indicator from the user's example
    return track.allowStreaming === false || track.streamReady === false || track.title === 'Unavailable';
};

export const debounce = (func, wait) => {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
};

export const escapeHtml = (unsafe) => {
    if (typeof unsafe !== 'string') return unsafe;
    return unsafe
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
};

export const getTrackTitle = (track, { fallback = 'Unknown Title' } = {}) => {
    if (!track?.title) return fallback;
    return track?.version ? `${track.title} (${track.version})` : track.title;
};

export const getTrackArtists = (track = {}, { fallback = 'Unknown Artist' } = {}) => {
    if (track?.artists?.length) {
        return track.artists.map((artist) => artist?.name).join(', ');
    }

    if (track?.artist) {
        return typeof track.artist === 'string' ? track.artist : track.artist.name || fallback;
    }

    return fallback;
};

export const getTrackArtistsHTML = (track = {}, { fallback = 'Unknown Artist' } = {}) => {
    const artists = track?.artists?.length
        ? track.artists
        : track?.artist
          ? [typeof track.artist === 'string' ? { name: track.artist } : track.artist]
          : [];

    if (artists.length) {
        return artists
            .map((artist) => {
                const escapedName = escapeHtml(artist.name || 'Unknown Artist');
                const escapedId = escapeHtml(artist.id || '');
                // Check if this is a tracker/unreleased track
                const isTracker = track.isTracker || (track.id && String(track.id).startsWith('tracker-'));
                if (isTracker && track.trackerInfo?.sheetId) {
                    const escapedSheetId = escapeHtml(track.trackerInfo.sheetId);
                    // For tracker tracks, link to the tracker artist page
                    return `<span class="artist-link tracker-artist-link" data-tracker-sheet-id="${escapedSheetId}">${escapedName}</span>`;
                }
                // For normal tracks, use the artist ID
                return `<span class="artist-link" data-artist-id="${escapedId}" data-artist-name="${escapedName}">${escapedName}</span>`;
            })
            .join(', ');
    }

    return fallback;
};

export const formatTemplate = (template, data) => {
    let result = template;
    result = result.replace(/\{discNumber\}/g, String(data.discNumber || 1));
    result = result.replace(/\{trackNumber\}/g, data.trackNumber ? String(data.trackNumber).padStart(2, '0') : '00');
    result = result.replace(/\{artist\}/g, sanitizeForFilename(data.artist || 'Unknown Artist'));
    result = result.replace(/\{title\}/g, sanitizeForFilename(data.title || 'Unknown Title'));
    result = result.replace(/\{album\}/g, sanitizeForFilename(data.album || 'Unknown Album'));
    result = result.replace(/\{albumArtist\}/g, sanitizeForFilename(data.albumArtist || 'Unknown Artist'));
    result = result.replace(/\{albumTitle\}/g, sanitizeForFilename(data.albumTitle || 'Unknown Album'));
    result = result.replace(/\{year\}/g, data.year || 'Unknown');
    return result;
};

export const calculateTotalDuration = (tracks) => {
    if (!Array.isArray(tracks) || tracks.length === 0) return 0;
    return tracks.reduce((total, track) => total + (track.duration || 0), 0);
};

export const formatDuration = (seconds) => {
    if (!seconds || isNaN(seconds)) return '0 min';

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    if (hours > 0) {
        return `${hours} hr ${minutes} min`;
    }
    return `${minutes} min`;
};

/**
 * Positions a menu element relative to a point or an anchor rectangle,
 * ensuring it stays within the viewport and becomes scrollable if too tall.
 * @param {HTMLElement} menu - The menu element to position
 * @param {number} x - X coordinate (clientX)
 * @param {number} y - Y coordinate (clientY)
 * @param {DOMRect} [anchorRect] - Optional anchor element rectangle
 */
export function positionMenu(menu, x, y, anchorRect = null) {
    // Temporarily show to measure dimensions
    menu.style.visibility = 'hidden';
    menu.style.display = 'block';
    menu.style.maxHeight = '';
    menu.style.overflowY = '';

    const menuWidth = menu.offsetWidth;
    const menuHeight = menu.offsetHeight;
    const windowWidth = window.innerWidth;
    const windowHeight = window.innerHeight;

    let left = x;
    let top = y;

    if (anchorRect) {
        // Adjust horizontal position if it overflows right
        if (left + menuWidth > windowWidth - 10) {
            left = Math.max(10, anchorRect.right - menuWidth);
        }
        // Adjust vertical position if it overflows bottom
        if (top + menuHeight > windowHeight - 10) {
            top = Math.max(10, anchorRect.top - menuHeight - 5);
        }
    } else {
        // Adjust horizontal position if it overflows right
        if (left + menuWidth > windowWidth - 10) {
            left = Math.max(10, windowWidth - menuWidth - 10);
        }
        // Adjust vertical position if it overflows bottom
        if (top + menuHeight > windowHeight - 10) {
            top = Math.max(10, y - menuHeight);
        }
    }

    // Final checks to ensure it's not off-screen at the top or left
    if (left < 10) left = 10;
    if (top < 10) top = 10;

    // If it's still too tall for the viewport, make it scrollable
    // We measure again because max-height might be needed
    const currentMenuHeight = menu.offsetHeight;
    if (top + currentMenuHeight > windowHeight - 10) {
        menu.style.maxHeight = `${windowHeight - top - 10}px`;
        menu.style.overflowY = 'auto';
    }

    menu.style.top = `${top}px`;
    menu.style.left = `${left}px`;
    menu.style.visibility = 'visible';
}

export const getShareUrl = (path) => {
    const configuredBase = String(window.__SHARE_BASE_URL__ || '').trim();
    const origin = window.location.origin;
    const isLocalOrigin =
        !origin || origin.includes('localhost') || origin.includes('127.0.0.1') || origin.startsWith('file:');
    const baseUrl = configuredBase || (isLocalOrigin ? 'https://monochrome.plus' : origin);
    const safePath = path.startsWith('/') ? path : `/${path}`;
    return `${baseUrl}${safePath}`;
};

export const createTimeoutSignal = (timeoutMs = 8000) => {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        return AbortSignal.timeout(timeoutMs);
    }

    const controller = new AbortController();
    setTimeout(() => {
        if (!controller.signal.aborted) {
            controller.abort();
        }
    }, timeoutMs);
    return controller.signal;
};

export const copyTextToClipboard = async (text) => {
    const value = String(text ?? '');
    if (!value) return false;

    if (navigator?.clipboard?.writeText) {
        try {
            await navigator.clipboard.writeText(value);
            return true;
        } catch {
            // Fall through to legacy method
        }
    }

    try {
        const textarea = document.createElement('textarea');
        textarea.value = value;
        textarea.setAttribute('readonly', 'true');
        textarea.style.position = 'fixed';
        textarea.style.top = '-1000px';
        textarea.style.left = '-1000px';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        const copied = document.execCommand('copy');
        document.body.removeChild(textarea);
        return !!copied;
    } catch {
        return false;
    }
};

export const shareOrCopy = async ({ title = '', text = '', url = '' } = {}) => {
    const shareData = {};
    if (title) shareData.title = title;
    if (text) shareData.text = text;
    if (url) shareData.url = url;

    if (navigator?.share && Object.keys(shareData).length > 0) {
        try {
            await navigator.share(shareData);
            return 'shared';
        } catch (error) {
            if (error?.name === 'AbortError') {
                return 'cancelled';
            }
        }
    }

    const copied = await copyTextToClipboard(url || text || title);
    return copied ? 'copied' : 'failed';
};

/**
 * Derives a quality token from a Shaka Player variant track.
 * @param {shaka.extern.Variant} variant
 * @returns {string} One of AUDIO_QUALITIES
 */
export function deriveQualityFromShakaVariant(variant) {
    if (!variant) return null;
    const codecs = (variant.codecs || '').toLowerCase();

    // Check for Atmos
    if (codecs.includes('ec-3') || codecs.includes('ac-3') || codecs.includes('ac4')) {
        return AUDIO_QUALITIES.DOLBY_ATMOS;
    }

    // Check for Hi-Res
    if (codecs.includes('flac') || codecs.includes('alac')) {
        return AUDIO_QUALITIES.HI_RES_LOSSLESS;
    }

    // Fallback based on bandwidth if known
    if (variant.bandwidth > 1000000) return AUDIO_QUALITIES.LOSSLESS;
    if (variant.bandwidth > 250000) return AUDIO_QUALITIES.HIGH;
    return AUDIO_QUALITIES.LOW;
}
