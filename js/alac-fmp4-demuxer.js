// Minimal ISO-BMFF sampler for fragmented MP4 fragments carrying one ALAC
// track (the shape Apple-music-backed addons emit: `ftyp`/`moov` carrying an
// `alac` sample entry + `mvex`, then a stream of `moof`/`mdat` fragments).
// The generic @audio/decode-aac auto path walks the *static* sample table and
// bails when samples live in fragments ("No AAC/ALAC audio track in MP4"), so
// we extract the cookie here and feed the decoder raw access units through
// its `decoder({ alac })` API.

function boxHeader(data, off) {
    let size = Math.floor(
        ((data[off] << 24) | (data[off + 1] << 16) | (data[off + 2] << 8) | data[off + 3]) & 0xffffffff
    );
    if (size < 0) size += 0x100000000;
    let header = 8;
    if (size === 1) {
        size =
            (data[off + 8] * 0x1000000 + data[off + 9] * 0x10000 + data[off + 10] * 0x100 + data[off + 11]) *
                0x100000000 +
            (((data[off + 12] << 24) | (data[off + 13] << 16) | (data[off + 14] << 8) | data[off + 15]) & 0xffffffff);
        header = 16;
    }
    if (size === 0) size = data.length - off;
    const type = String.fromCharCode(
        data[off + header - 4],
        data[off + header - 3],
        data[off + header - 2],
        data[off + header - 1]
    );
    return { type, size, header };
}

function iterateBoxes(data, start, end, visit) {
    let off = start;
    while (off + 8 <= Math.min(end, data.length)) {
        const { type, size, header } = boxHeader(data, off);
        if (size < 8 || off + size > Math.min(end, data.length) + 8) break;
        visit(type, off + header, off + size, off);
        off += size;
    }
}

const u32 = (d, o) => Math.floor(((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) & 0xffffffff);
const s32 = (d, o) => (d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3] | 0;

// ALAC magic cookie from the stsd sample entry: entry fourcc 'alac' with a
// child 'alac' box whose body is version/flags(4) + ALACSpecificConfig(24).
function findAlacCookie(data) {
    let cookie = null;
    let timescale = 44100;
    iterateBoxes(data, 0, data.length, (type, body, end, _off) => {
        if (type !== 'moov') return;
        const walk = (from, to) => {
            iterateBoxes(data, from, to, (ct, cb, ce, cOff) => {
                if (ct === 'trak') {
                    walk(cb, ce);
                } else if (ct === 'mdia') {
                    walk(cb, ce);
                } else if (ct === 'minf') {
                    walk(cb, ce);
                } else if (ct === 'stbl') {
                    walk(cb, ce);
                } else if (ct === 'stsd') {
                    // stsd body: version/flags(4) + entry_count(4) + entries.
                    const entryCount = u32(data, cb + 4);
                    let entry = cb + 8;
                    for (let i = 0; i < entryCount; i += 1) {
                        if (entry + 8 > ce) break;
                        const { size, type: entryType } = {
                            size: u32(data, entry),
                            type: String.fromCharCode(
                                data[entry + 4],
                                data[entry + 5],
                                data[entry + 6],
                                data[entry + 7]
                            ),
                        };
                        if (size < 8 || entry + size > ce) break;
                        if (entryType === 'alac') {
                            // Sound sample descriptors differ between ISO
                            // (16 bytes of reserved/version fields) and
                            // QuickTime layouts, so scan for the child 'alac'
                            // config box at any 4-byte-aligned position. The
                            // child box carries version/flags(4) + the 24-byte
                            // ALACSpecificConfig.
                            for (let probe = entry + 8; probe + 8 <= entry + size; probe += 4) {
                                const probeSize = u32(data, probe - 4);
                                const isAlacFourcc =
                                    data[probe] === 0x61 &&
                                    data[probe + 1] === 0x6c &&
                                    data[probe + 2] === 0x61 &&
                                    data[probe + 3] === 0x63;
                                if (isAlacFourcc && probeSize >= 28 && probe - 4 + probeSize <= entry + size) {
                                    if (!cookie) cookie = data.slice(probe + 8, probe - 4 + probeSize);
                                    break;
                                }
                            }
                        }
                        entry += size;
                    }
                } else if (ct === 'mdhd') {
                    const version = data[cOff + 8];
                    timescale = version ? u32(data, cb + 20) : u32(data, cb + 12);
                }
            });
        };
        walk(body, end);
    });
    return { cookie, timescale };
}

// Walk every moof/traf/tfhd/trun and emit sample slice views.
function collectFragmentSamples(data, defaultSampleSize) {
    const frames = [];
    iterateBoxes(data, 0, data.length, (type, body, end, off) => {
        const flushRun = (baseOffset, dataOffsetAbs, sizes) => {
            let ptr = dataOffsetAbs;
            for (const n of sizes) {
                if (n <= 0) continue;
                frames.push(data.subarray(ptr, ptr + n));
                ptr += n;
            }
        };

        if (type === 'moof') {
            let baseIsMoof = false;
            let baseOffset = 0;
            let defSize = defaultSampleSize;
            const runs = [];
            iterateBoxes(data, body, end, (ft, fb, fe, _fOff) => {
                if (ft === 'traf') {
                    iterateBoxes(data, fb, fe, (tt, tb, _te) => {
                        if (tt === 'tfhd') {
                            const flags = u32(data, tb);
                            if (flags & 0x020000) baseIsMoof = true;
                            else if (flags & 0x01)
                                baseOffset = Math.floor(
                                    ((data[tb + 4] << 24) | (data[tb + 5] << 16) | (data[tb + 6] << 8) | data[tb + 7]) &
                                        0xffffffff
                                );
                            // structure_after_tfhd(): optional fields in this
                            // order; default_sample_duration may be irrelevant
                            // to byte layout but sits before default_sample_size.
                            let p = tb + 4 + (flags & 0x01 ? 8 : 0) + (flags & 0x02 ? 2 : 0);
                            if (flags & 0x08) p += 4;
                            if (flags & 0x10) defSize = u32(data, p);
                        } else if (tt === 'trun') {
                            const flags = u32(data, tb);
                            const count = u32(data, tb + 4);
                            let p = tb + 8;
                            let dataOffset = null;
                            if (flags & 0x1) {
                                dataOffset = s32(data, p);
                                p += 4;
                            }
                            if (flags & 0x4) p += 4;
                            const sizes = [];
                            for (let i = 0; i < count; i += 1) {
                                if (flags & 0x100) p += 4;
                                if (flags & 0x200) {
                                    sizes.push(u32(data, p));
                                    p += 4;
                                }
                                if (flags & 0x400) p += 4;
                                if (flags & 0x800) p += 4;
                                if (!(flags & 0x200)) sizes.push(defSize);
                            }
                            runs.push({ dataOffset, sizes });
                        }
                    });
                }
            });

            if (!runs.length) return;
            const origin = baseIsMoof ? off : baseOffset;
            for (const run of runs) {
                const offsetAbs =
                    run.dataOffset == null
                        ? baseOffset || origin
                        : origin + (baseIsMoof ? Math.max(0, run.dataOffset) : run.dataOffset);
                flushRun(origin, offsetAbs, run.sizes);
            }
        }
    });

    return frames;
}

/**
 * Extracts every raw ALAC frame plus the decoder cookie from a fragmented
 * (or static-table) M4A. Throws when no `alac` sample entry exists so the
 * caller can fall back to the library's own decode path.
 */
export function demuxFragmentedAlac(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const { cookie, timescale } = findAlacCookie(data);
    if (!cookie) throw new Error('No ALAC sample entry in MP4');
    const frames = collectFragmentSamples(data);
    const payloadBytes = frames.reduce((n, f) => n + f.length, 0);
    if (!frames.length) throw new Error('No ALAC fragments found in MP4');
    return { cookie, frames, timescale, payloadBytes };
}
