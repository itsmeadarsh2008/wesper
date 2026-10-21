// WASM ALAC bridge: plays Apple Lossless streams in browsers that cannot
// decode ALAC natively (Chrome, Firefox, Edge — only Safari/WebKit ships an
// ALAC decoder). Uses @audio/decode-aac, whose ALAC path is a pure-JS port of
// Apple's reference decoder, bit-exact at 16–32 bits. The decoded PCM is
// repacked as a 32-bit float WAV blob so the native <audio> element, the Web
// Audio graph (EQ / visualizer / ReplayGain) and every existing player
// binding keep working unchanged.
//
// float32 keeps 24-bit content bit-exact and Chrome plays float WAV fine.

import { canBrowserDecode } from './eclipse.js';

const ALAC_CODEC_RE = /^(alac|apple\s*lossless)$/i;
let latestBlobUrl = null;
let decodeModulePromise = null;

// True when the resolved stream is ALAC and this browser cannot decode it,
// i.e. only when the bridge is strictly needed (Safari keeps the native path).
export function needsWasmAlacDecode(streamInfo, streamUrl) {
    if (!streamUrl || typeof streamUrl !== 'string' || streamUrl.startsWith('blob:')) return false;
    const codec = String(streamInfo?.codec || streamInfo?.format || '').toLowerCase();
    if (!ALAC_CODEC_RE.test(codec)) return false;
    return !canBrowserDecode('alac');
}

// Export access normalized defensively: the package has no "type": "module",
// so bundler interop may surface the functions on .default instead of the
// module namespace.
// Export access normalized defensively: the package has no "type": "module",
// so bundler interop may surface `decode` as the default export, inside a
// default namespace, or flat — all three shapes handled.
async function loadDecoderModule() {
    if (!decodeModulePromise) {
        decodeModulePromise = import('@audio/decode-aac').then((mod) => {
            const decode =
                typeof mod?.decode === 'function'
                    ? mod.decode
                    : typeof mod?.default === 'function'
                      ? mod.default
                      : mod?.default?.decode;
            const decoder = typeof mod?.decoder === 'function' ? mod.decoder : mod?.default?.decoder;
            return { decode, decoder };
        });
    }
    try {
        const mod = await decodeModulePromise;
        if (typeof mod.decode !== 'function' || typeof mod.decoder !== 'function') {
            throw new Error('ALAC decoder surfaced neither decode() nor decoder()');
        }
        return mod;
    } catch (error) {
        decodeModulePromise = null;
        throw error;
    }
}

// Fragmented fMP4 (`moof`/`mdat` chains) bypasses the library's static-table
// demuxer, so raw frames are extracted here and fed through its manual
// `decoder({ alac })` path.
async function decodeFragmentedAlac(bytes, decoderFactory) {
    const { demuxFragmentedAlac } = await import('./alac-fmp4-demuxer.js');
    const { cookie, frames } = demuxFragmentedAlac(bytes);
    const dec = await decoderFactory({ alac: cookie });
    try {
        const channels = [];
        let sampleRate = 0;
        const BATCH = 256;
        for (let i = 0; i < frames.length; i += BATCH) {
            const out = dec.decode(frames.slice(i, i + BATCH));
            if (!out.channelData?.length) continue;
            if (!sampleRate) sampleRate = out.sampleRate;
            while (channels.length < out.channelData.length) channels.push([]);
            for (let ch = 0; ch < out.channelData.length; ch += 1) channels[ch].push(out.channelData[ch]);
        }
        if (!sampleRate) throw new Error('ALAC decoder returned no samples');
        return { channelData: channels.map((parts) => joinFloat32(parts)), sampleRate };
    } finally {
        dec.free();
    }
}

function joinFloat32(parts) {
    let total = 0;
    for (const part of parts) total += part.length;
    const out = new Float32Array(total);
    let off = 0;
    for (const part of parts) {
        out.set(part, off);
        off += part.length;
    }
    return out;
}

function interleaveF32(channelData) {
    const channels = channelData.length;
    let frames = channelData[0]?.length || 0;
    for (const ch of channelData) frames = Math.min(frames, ch.length);
    const out = new Float32Array(frames * channels);
    for (let ch = 0; ch < channels; ch++) {
        const data = channelData[ch];
        let idx = ch;
        for (let i = 0; i < frames; i++) {
            out[idx] = data[i];
            idx += channels;
        }
    }
    return { interleaved: out, channels, frames };
}

function float32WavHeader(channels, sampleRate, dataBytes) {
    const blockAlign = channels * 4;
    const buf = new ArrayBuffer(44);
    const view = new DataView(buf);
    const ascii = (offset, text) => {
        for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
    };
    ascii(0, 'RIFF');
    view.setUint32(4, 36 + dataBytes, true);
    ascii(8, 'WAVE');
    ascii(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 3, true); // WAVE_FORMAT_IEEE_FLOAT
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 32, true);
    ascii(36, 'data');
    view.setUint32(40, dataBytes, true);
    return new Uint8Array(buf);
}

// Fetches the ALAC media URL, decodes the whole file and returns a blob:
// URL for a 32-bit float WAV. The blob of the previous decode is revoked on
// the next call so long sessions never accumulate float buffers.
export async function decodeAlacToPlayableUrl(streamUrl) {
    const res = await fetch(streamUrl);
    if (!res.ok) throw new Error(`ALAC source unavailable (HTTP ${res.status})`);
    const bytes = new Uint8Array(await res.arrayBuffer());

    const { decode, decoder } = await loadDecoderModule();
    let decoded;
    try {
        decoded = await decode(bytes);
    } catch (error) {
        if (!/No AAC\/ALAC audio track/i.test(String(error?.message || ''))) throw error;
        decoded = await decodeFragmentedAlac(bytes, decoder);
    }
    const sampleRate = Number(decoded.sampleRate) || 44100;
    if (!decoded.channelData?.length || !decoded.channelData[0].length) {
        throw new Error('ALAC decoder returned no samples');
    }

    const { interleaved, channels, frames } = interleaveF32(decoded.channelData);
    const header = float32WavHeader(channels, sampleRate, frames * channels * 4);

    if (latestBlobUrl) URL.revokeObjectURL(latestBlobUrl);
    latestBlobUrl = URL.createObjectURL(new Blob([header, interleaved.buffer], { type: 'audio/wav' }));
    return latestBlobUrl;
}

export function forgetWasmAlacBlob() {
    if (latestBlobUrl) URL.revokeObjectURL(latestBlobUrl);
    latestBlobUrl = null;
}
