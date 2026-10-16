// Ground-truth stream metadata reader.
//
// The addon's quality *label* is a text string that can be missing, vague or
// wrong ("Tidal · Hi-Res FLAC · 24-bit / 44.1 kHz" carries no bitrate at all).
// This module reads the actual media files instead:
//   - HLS:     the manifest (#EXT-X-STREAM-INF BANDWIDTH, or first segment's
//              byte size ÷ its #EXTINF duration) + the init segment's audio
//              sample entry (moov → stsd → fLaC/mp4a/Opus fields).
//   - DASH:    the MPD's best audio Representation (@bandwidth,
//              @audioSamplingRate) + its Initialization segment when exposed.
//   - direct:  a Range probe for the file size ÷ track duration, plus a moov
//              parse if the head of the file is an mp4 container.
//
// Everything is best-effort and never throws; every function resolves to {}
// when a property cannot be determined. Fetching happens through
// window.__corsBypass.rewriteUrl so proxied hosts (sp-ad-fa.audio.tidal.com)
// work exactly like the rest of the app.

const HEAD_PROBE_BYTES = 262144; // 256 KB — enough for any init segment / moov

const STREAM_SPEC_CACHE = new Map();
const STREAM_SPEC_CACHE_LIMIT = 64;

const readU8 = (bytes, off) => bytes[off];
const readU16 = (bytes, off) => (bytes[off] << 8) | bytes[off + 1];
const readU32 = (bytes, off) =>
    ((bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]) >>> 0;

function typeString(bytes, off) {
    return String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
}

// Visits top-level ISO-BMFF boxes inside [start, end). Handles the compact
// 4-byte size, size === 0 (box extends to end) and size === 1 (64-bit largesize).
function walkBoxes(bytes, start, end, onBox) {
    let p = start;
    while (p + 8 <= end) {
        let size = readU32(bytes, p);
        if (size === 1) {
            if (p + 16 > end) break;
            const hi = readU32(bytes, p + 8);
            const lo = readU32(bytes, p + 12);
            size = hi * 0x100000000 + lo;
        } else if (size === 0) {
            size = end - p;
        }
        if (size < 8 || p + size > end) break;
        if (onBox(typeString(bytes, p + 4), p, p + size) === false) return;
        p += size;
    }
}

// Recursively collects box start offsets of the given type anywhere in the
// buffer. Only known container types are descended into; anything else (or a
// malformed size-0 box that swallows the rest of the buffer) is left alone, so
// recursion is bounded by real box nesting.
const BOX_CONTAINERS = new Set([
    'moov',
    'trak',
    'mdia',
    'minf',
    'stbl',
    'dinf',
    'edts',
    'mvex',
    'udta',
    'mfra',
    'mooof',
    'traf',
    'skip',
    'free',
]);
function collectBoxes(bytes, start, end, targetType, out = []) {
    walkBoxes(bytes, start, end, (type, boxStart, boxEnd) => {
        if (type === targetType) {
            out.push(boxStart);
            return;
        }
        if (BOX_CONTAINERS.has(type) && boxEnd - boxStart > 8) {
            collectBoxes(bytes, boxStart + 8, boxEnd, targetType, out);
        }
    });
    return out;
}

// Reads the first audio sample entry's codec spec from a moov box.
//
// Two AudioSampleEntry layouts exist in the wild: the ISO 14496-12 layout
// (8 reserved bytes after data_reference_index; channelcount at +24,
// samplesize at +26, samplerate at +32 — used by Tidal's HLS muxer) and the
// QuickTime variant (version/revision/vendor instead; channelcount +16,
// samplesize +18, samplerate +24). Both are tried, plausibility-checked.
export function readAudioSpecFromMoov(bytes) {
    for (const stsdStart of collectBoxes(bytes, 0, bytes.length, 'stsd')) {
        const count = readU32(bytes, stsdStart + 12);
        for (let i = 0; i < count; i += 1) {
            const entryStart = stsdStart + 16 + i * 8;
            if (entryStart + 8 > bytes.length) break;
            const entryType = typeString(bytes, entryStart + 4);
            if (entryType === 'fLaC' || entryType === 'mp4a') {
                const codec = entryType === 'fLaC' ? 'FLAC' : 'AAC';
                const readSpec = (channelOff, sizeOff, rateOff) => {
                    const channelCount = readU16(bytes, entryStart + channelOff);
                    const sampleSize = readU16(bytes, entryStart + sizeOff);
                    const sampleRate = readU32(bytes, entryStart + rateOff) >>> 16;
                    if (!(sampleRate >= 8000 && sampleRate <= 768000)) return null;
                    return {
                        codec,
                        sampleRate,
                        // AAC has no bit depth: the sample entry's samplesize
                        // field is a nominal 16 per the format spec, not real
                        // data. Only FLAC (fLaC) carries a meaningful value.
                        bitDepth: codec === 'FLAC' ? (sampleSize > 1 ? sampleSize : null) : null,
                        channels: channelCount > 0 ? channelCount : null,
                    };
                };
                const spec = readSpec(24, 26, 32) || readSpec(16, 18, 24);
                if (spec) return spec;
            } else if (entryType === 'Opus') {
                const channelCount = readU8(bytes, entryStart + 9);
                const sampleRate = readU32(bytes, entryStart + 10);
                if (sampleRate > 0) {
                    return {
                        codec: 'Opus',
                        sampleRate,
                        bitDepth: null,
                        channels: channelCount > 0 ? channelCount : null,
                    };
                }
            }
        }
    }
    return {};
}

// Extracts the raw 34-byte FLAC STREAMINFO block from the dfLa box of an
// fLaC init segment, or null when absent. Layout: dfLa box → 4-byte fullbox
// flags → metadata block header (last/type/length) → STREAMINFO body.
export function extractFlacStreamInfo(bytes) {
    const dfLaOffsets = [];
    const search = (start, end) => {
        let idx = start;
        while (idx < end - 4) {
            const found = bytes.indexOf(0x64, idx);
            if (found === -1 || found > end - 4) break;
            if (found >= 4 && typeString(bytes, found) === 'dfLa' && readU32(bytes, found - 4) >= 8) {
                dfLaOffsets.push(found - 4);
                idx = found + 4;
            } else {
                idx = found + 1;
            }
        }
    };
    search(0, bytes.length);

    for (const dfLaStart of dfLaOffsets) {
        const dfLaSize = readU32(bytes, dfLaStart);
        const payloadStart = dfLaStart + 8;
        const payloadEnd = Math.min(dfLaStart + dfLaSize, bytes.length);
        const headerStart = payloadStart + 4; // fullbox version/flags
        if (headerStart + 4 > payloadEnd) continue;
        const blockType = readU8(bytes, headerStart) & 0x7f;
        const blockLength =
            (readU8(bytes, headerStart + 1) << 16) |
            (readU8(bytes, headerStart + 2) << 8) |
            readU8(bytes, headerStart + 3);
        if (blockType === 0 && blockLength === 34 && headerStart + 4 + 34 <= payloadEnd) {
            return bytes.slice(headerStart + 4, headerStart + 4 + 34);
        }
    }
    return null;
}

// Decodes a 34-byte FLAC STREAMINFO body into the real codec spec. This is
// the authoritative ground truth for FLAC: the fLaC sample entry often has a
// zero samplerate (Tidal's muxer writes none), while STREAMINFO always
// carries the true rate/channels/bit depth. Layout:
//   10-12 sample rate (20 bits), 12-13 channels-1 (3 bits) + bps-1 (5 bits)
export function decodeFlacStreamInfo(streamInfo) {
    if (!streamInfo || streamInfo.length < 34) return null;
    const b = streamInfo;
    const sampleRate = (b[10] << 12) | (b[11] << 4) | (b[12] >> 4);
    const channels = ((b[12] & 0x0e) >> 1) + 1;
    const bitDepth = (((b[12] & 0x01) << 4) | (b[13] >> 4)) + 1;
    if (!(sampleRate >= 8000 && sampleRate <= 768000)) return null;
    return {
        codec: 'FLAC',
        sampleRate,
        bitDepth: bitDepth >= 8 && bitDepth <= 32 ? bitDepth : null,
        channels: channels >= 1 && channels <= 8 ? channels : null,
    };
}

// Extracts and decodes the FLAC STREAMINFO from an fLaC init segment, or null.
export function extractFlacSpec(bytes) {
    if (!bytes) return null;
    return decodeFlacStreamInfo(extractFlacStreamInfo(bytes));
}

// Total PCM samples from a 34-byte FLAC STREAMINFO body (bits 108-143).
// Arithmetic, not bitwise ops: the 36-bit field exceeds 32-bit range.
// Combined with the decoded sample rate this is the exact audio duration,
// so size ÷ duration is the true average bitrate — no estimation.
export function decodeFlacTotalSamples(streamInfo) {
    if (!streamInfo || streamInfo.length < 34) return null;
    const b = streamInfo;
    const total = (b[13] & 0x0f) * 0x100000000 + b[14] * 0x1000000 + b[15] * 0x10000 + b[16] * 0x100 + b[17];
    return Number.isSafeInteger(total) && total > 0 ? total : null;
}

// True when the buffer starts with a raw .flac file whose first metadata
// block is STREAMINFO with a 34-byte body (magic + header + body = 42 bytes).
export function isRawFlacHead(bytes) {
    if (!bytes || bytes.length < 42) return false;
    if (typeString(bytes, 0) !== 'fLaC') return false;
    if ((readU8(bytes, 4) & 0x7f) !== 0) return false;
    const length = (readU8(bytes, 5) << 16) | (readU8(bytes, 6) << 8) | readU8(bytes, 7);
    return length === 34;
}

function resolveUri(uri, baseUrl) {
    try {
        return new URL(uri, baseUrl).toString();
    } catch {
        return uri;
    }
}

export async function proxiedFetch(url, init) {
    const rewritten = window.__corsBypass?.rewriteUrl ? window.__corsBypass.rewriteUrl(url) : url;
    return fetch(rewritten, init);
}

async function fetchHeadBytes(url, maxBytes = HEAD_PROBE_BYTES) {
    const res = await proxiedFetch(url, { headers: { Range: `bytes=0-${maxBytes - 1}` } });
    if (!res.ok && res.status !== 206) return null;
    const reader = res.body?.getReader();
    if (!reader) return null;
    try {
        const chunks = [];
        let total = 0;
        while (total < maxBytes) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            total += value.byteLength;
        }
        await reader.cancel().catch(() => {});
        const out = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            out.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return total > 0 ? out : null;
    } catch {
        return null;
    }
}

// Parses a master or media HLS playlist. Returns {} on malformed input.
export function parseHlsManifest(text, baseUrl) {
    const segments = [];
    const variants = [];
    let initUri = null;
    let currentVariantBandwidth = null;

    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line.startsWith('#EXT-X-STREAM-INF')) {
            const bw = line.match(/BANDWIDTH=(\d+)/i);
            currentVariantBandwidth = bw ? parseInt(bw[1], 10) : null;
        } else if (line.startsWith('#EXT-X-MAP')) {
            const uri = line.match(/URI="([^"]+)"/i);
            if (uri) initUri = uri[1];
        } else if (line.startsWith('#EXTINF')) {
            const dur = parseFloat(line.replace('#EXTINF:', '').split(',')[0]);
            segments.push({ duration: Number.isFinite(dur) && dur > 0 ? dur : null });
        } else if (line && !line.startsWith('#')) {
            if (currentVariantBandwidth != null) {
                variants.push({ bandwidth: currentVariantBandwidth, uri: resolveUri(line, baseUrl) });
                currentVariantBandwidth = null;
            } else if (segments.length > 0 && !segments[segments.length - 1].uri) {
                segments[segments.length - 1].uri = resolveUri(line, baseUrl);
            }
        }
    }

    if (initUri) initUri = resolveUri(initUri, baseUrl);
    return { segments, variants, initUri };
}

const plausible = {
    sampleRate: (v) => Number.isInteger(v) && v >= 8000 && v <= 768000,
    bitDepth: (v) => Number.isInteger(v) && v >= 1 && v <= 32,
    bitrateKbps: (v) => Number.isFinite(v) && v >= 8 && v <= 10000,
    channels: (v) => Number.isInteger(v) && v >= 1 && v <= 32,
};

function pickPlausible(meta) {
    const out = {};
    for (const [key, test] of Object.entries(plausible)) {
        if (meta[key] != null && test(meta[key])) out[key] = meta[key];
    }
    return out;
}

// Resolves a media playlist (following the first variant) and reads the real
// stream spec: bitrate from BANDWIDTH or first segment size ÷ EXTINF, and the
// codec fields from the init segment's audio sample entry.
async function inspectHls(manifestUrl) {
    const manifestRes = await proxiedFetch(manifestUrl);
    if (!manifestRes.ok) return {};
    const manifestText = await manifestRes.text();
    let playlist = parseHlsManifest(manifestText, manifestUrl);
    if (!playlist.variants.length && !playlist.segments.length) return {};

    // Follow the first variant down one level when this is a master playlist.
    if (playlist.variants.length > 0) {
        const variant = playlist.variants[0];
        const variantRes = await proxiedFetch(variant.uri);
        if (!variantRes.ok) return {};
        const child = parseHlsManifest(await variantRes.text(), variant.uri);
        if (child.segments.length > 0) playlist = child;
        if (variant.bandwidth) playlist.bandwidth = variant.bandwidth;
        if (!playlist.initUri) playlist.initUri = child.initUri;
    }

    const meta = {};

    if (playlist.bandwidth) {
        meta.bitrateKbps = Math.round(playlist.bandwidth / 1000);
    } else if (playlist.segments.length > 0) {
        // No declared bandwidth: average over the first few segments instead
        // of sampling just one, so VBR swings don't skew the figure.
        const sample = playlist.segments.filter((seg) => seg.uri && seg.duration).slice(0, 3);
        const sizes = await Promise.all(
            sample.map(async (seg) => {
                try {
                    const segRes = await proxiedFetch(seg.uri);
                    if (!segRes.ok) return null;
                    const size = (await segRes.arrayBuffer()).byteLength;
                    return size > 0 ? { size, duration: seg.duration } : null;
                } catch {
                    return null;
                }
            })
        );
        const valid = sizes.filter(Boolean);
        if (valid.length > 0) {
            const bytes = valid.reduce((sum, seg) => sum + seg.size, 0);
            const secs = valid.reduce((sum, seg) => sum + seg.duration, 0);
            if (secs > 0) meta.bitrateKbps = Math.round((bytes * 8) / secs / 1000);
        }
    }

    if (playlist.initUri) {
        const initBytes = await fetchHeadBytes(playlist.initUri);
        if (initBytes) {
            // FLAC truth: STREAMINFO beats the sample entry — Tidal's fLaC
            // entry carries a zero samplerate field, so the moov alone can
            // report nothing (or a wrong rate) for these streams.
            const flacSpec = extractFlacSpec(initBytes);
            if (flacSpec) {
                Object.assign(meta, pickPlausible(flacSpec));
            } else {
                const spec = readAudioSpecFromMoov(initBytes);
                Object.assign(meta, pickPlausible(spec));
            }
        }
    }

    return pickPlausible(meta);
}

// Parses a DASH MPD manifest. Returns the best audio representation's specs:
// bitrate from @bandwidth, sample rate from @audioSamplingRate, plus a
// resolvable init-segment URL when the manifest provides one. Returns null
// on malformed input. Pure function (no network) for testability.
export function parseDashManifest(text, baseUrl) {
    if (!text || typeof text !== 'string') return null;
    let doc;
    try {
        doc = new DOMParser().parseFromString(text, 'application/xml');
    } catch {
        return null;
    }
    if (!doc || doc.getElementsByTagName('parsererror').length > 0) return null;

    const textOf = (el, tag) => {
        const n = el.getElementsByTagName(tag)[0];
        return n?.textContent?.trim() || null;
    };

    const mpdBase = textOf(doc.documentElement, 'BaseURL');
    let best = null;

    const adaptationSets = Array.from(doc.getElementsByTagName('AdaptationSet'));
    for (const set of adaptationSets) {
        const mime = (set.getAttribute('mimeType') || '').toLowerCase();
        const contentType = (set.getAttribute('contentType') || '').toLowerCase();
        const codecs = (set.getAttribute('codecs') || '').toLowerCase();
        const isAudio =
            contentType === 'audio' || mime.startsWith('audio/') || /(mp4a|fLaC|flac|opus|ec-3|ac-4)/.test(codecs);
        if (!isAudio) continue;

        const setRate = parseInt(String(set.getAttribute('audioSamplingRate') || '').split(/\s+/)[0], 10);
        const period = set.parentNode;
        const periodBase = period?.getElementsByTagName
            ? (() => {
                  // Only direct-child BaseURL, not nested ones.
                  for (const child of period.children || []) {
                      if (child.tagName === 'BaseURL') return child.textContent?.trim() || null;
                  }
                  return null;
              })()
            : null;
        let setBase = null;
        for (const child of set.children || []) {
            if (child.tagName === 'BaseURL') {
                setBase = child.textContent?.trim() || null;
                break;
            }
        }
        const template = set.getElementsByTagName('SegmentTemplate')[0];
        const templateInit = template?.getAttribute('initialization') || null;

        const representations = Array.from(set.getElementsByTagName('Representation'));
        for (const rep of representations) {
            const bandwidth = parseInt(rep.getAttribute('bandwidth') || '0', 10);
            if (!Number.isFinite(bandwidth) || bandwidth <= 0) continue;
            const rateRaw = String(rep.getAttribute('audioSamplingRate') || '').split(/\s+/)[0];
            const sampleRate = parseInt(rateRaw, 10) || (Number.isInteger(setRate) ? setRate : null);

            let repBase = null;
            for (const child of rep.children || []) {
                if (child.tagName === 'BaseURL') {
                    repBase = child.textContent?.trim() || null;
                    break;
                }
            }
            const base = repBase || setBase || periodBase || mpdBase || baseUrl;

            // Explicit Initialization element wins; otherwise try a
            // SegmentTemplate pattern without time/number placeholders.
            let initUri = null;
            for (const child of rep.children || []) {
                if (child.tagName === 'Initialization' && child.getAttribute('sourceURL')) {
                    initUri = child.getAttribute('sourceURL');
                    break;
                }
            }
            let repTemplateInit = templateInit;
            if (!initUri) {
                const repTemplate = rep.getElementsByTagName('SegmentTemplate')[0];
                if (repTemplate?.getAttribute('initialization')) {
                    repTemplateInit = repTemplate.getAttribute('initialization');
                }
            }
            if (!initUri && repTemplateInit && !/\$(Number|Time)\$/i.test(repTemplateInit)) {
                initUri = repTemplateInit
                    .replace(/\$RepresentationID\$/g, rep.getAttribute('id') || '')
                    .replace(/\$Bandwidth\$/g, String(bandwidth));
            }
            if (initUri && base) {
                try {
                    initUri = new URL(initUri, base).toString();
                } catch {
                    initUri = null;
                }
            } else if (initUri && !base) {
                initUri = null;
            }

            if (!best || bandwidth > best.bandwidth) {
                best = {
                    bandwidth,
                    sampleRate: Number.isInteger(sampleRate) ? sampleRate : null,
                    initUri,
                };
            }
        }
    }

    return best;
}

// DASH path: specs from the MPD's audio Representation (bandwidth,
// audioSamplingRate) plus the init segment's real codec fields when the
// manifest exposes an Initialization URL.
async function inspectDash(manifestUrl) {
    const meta = {};

    let manifestText;
    try {
        const manifestRes = await proxiedFetch(manifestUrl);
        if (!manifestRes.ok) return {};
        manifestText = await manifestRes.text();
    } catch {
        return {};
    }

    const best = parseDashManifest(manifestText, manifestUrl);
    if (!best) return {};

    if (best.bandwidth > 0) {
        meta.bitrateKbps = Math.round(best.bandwidth / 1000);
    }
    if (best.sampleRate) {
        meta.sampleRate = best.sampleRate;
    }

    if (best.initUri) {
        const initBytes = await fetchHeadBytes(best.initUri);
        if (initBytes) {
            // Same ground-truth order as HLS: FLAC STREAMINFO first.
            const flacSpec = extractFlacSpec(initBytes);
            if (flacSpec) {
                Object.assign(meta, pickPlausible(flacSpec));
            } else {
                Object.assign(meta, pickPlausible(readAudioSpecFromMoov(initBytes)));
            }
            // MPD-declared rate wins ties: init segments can carry zeroed fields.
            if (best.sampleRate) meta.sampleRate = best.sampleRate;
        }
    }

    return pickPlausible(meta);
}
// Direct-file path: probe the exact total byte size via Content-Range and
// derive the true average bitrate. Duration prefers the exact FLAC
// STREAMINFO sample count (raw .flac files), then the track duration; the
// sample spec comes from STREAMINFO or the mp4 moov as available.
async function inspectDirect(url, durationSeconds) {
    const meta = {};
    let exactDurationSec = 0;

    const headBytes = await fetchHeadBytes(url);
    if (headBytes) {
        if (isRawFlacHead(headBytes)) {
            const body = headBytes.slice(8, 42);
            const spec = decodeFlacStreamInfo(body);
            Object.assign(meta, pickPlausible(spec));
            const totalSamples = decodeFlacTotalSamples(body);
            if (totalSamples && spec?.sampleRate) {
                exactDurationSec = totalSamples / spec.sampleRate;
            }
        } else {
            const spec = readAudioSpecFromMoov(headBytes);
            Object.assign(meta, pickPlausible(spec));
        }
    }

    const durationSec = exactDurationSec > 0 ? exactDurationSec : durationSeconds;
    if (durationSec && durationSec > 0) {
        try {
            const res = await proxiedFetch(url, { headers: { Range: 'bytes=0-0' } });
            const total = res.headers.get('content-range')?.match(/\/(\d+)\s*$/);
            if (total) {
                const size = parseInt(total[1], 10);
                if (size > 0) meta.bitrateKbps = Math.round((size * 8) / durationSec / 1000);
            } else {
                res.body?.cancel().catch(() => {});
            }
        } catch {
            /* best-effort */
        }
    }

    return pickPlausible(meta);
}

// Public entry point: returns a promise of { sampleRate, bitDepth, bitrateKbps,
// channels, codec } — only fields that were actually read from the media. Never
// rejects. Results are cached per URL.
export async function inspectStreamMetadata(streamUrl, options = {}) {
    if (!streamUrl || typeof streamUrl !== 'string') return {};

    if (STREAM_SPEC_CACHE.has(streamUrl)) {
        return STREAM_SPEC_CACHE.get(streamUrl);
    }

    let meta;
    try {
        if (options.isDash || /\.mpd(\?|#|$)/i.test(streamUrl)) {
            meta = await inspectDash(streamUrl);
        } else if (options.isHls) {
            meta = await inspectHls(streamUrl);
        } else {
            meta = await inspectDirect(streamUrl, options.duration);
        }
    } catch {
        meta = {};
    }

    if (Object.keys(meta).length > 0) {
        if (STREAM_SPEC_CACHE.size >= STREAM_SPEC_CACHE_LIMIT)
            STREAM_SPEC_CACHE.delete(STREAM_SPEC_CACHE.keys().next().value);
        STREAM_SPEC_CACHE.set(streamUrl, meta);
    }
    return meta;
}
