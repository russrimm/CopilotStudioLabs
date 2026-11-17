// Builds small PNG, JPEG, and WebP fixtures for the capture tests. No dependencies.

import zlib from "node:zlib";

const CRC = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * An RGB PNG.
 *  - "noise":  every pixel differs (a busy screenshot)
 *  - "blank":  one color, not compressible below 5 KB (a page that never loaded)
 *  - "mostly": about 98% one color
 *  - "ui":     white page with noisy bands, comfortably under the blank limits
 */
export function makePng({ width = 320, height = 200, mode = "noise", seed = 1, extraChunks = [], trailing = null } = {}) {
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
  const rows = [];
  const noiseRows = mode === "mostly" ? Math.max(1, Math.ceil(height * 0.02)) : height;
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3, 0xff);
    row[0] = 0;
    const busy = mode === "noise" || (mode === "mostly" && y < noiseRows) || (mode === "ui" && y % 4 === 0);
    if (busy) for (let i = 1; i < row.length; i += 1) row[i] = rand() & 0xff;
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.concat(rows);
  const idat = zlib.deflateSync(raw, mode === "blank" || mode === "mostly" ? { level: 1, strategy: zlib.constants.Z_HUFFMAN_ONLY } : {});
  return Buffer.concat([
    PNG_MAGIC,
    pngChunk("IHDR", ihdr),
    ...extraChunks,
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
    ...(trailing ? [trailing] : []),
  ]);
}

/** A minimal JPEG: valid header with the given size, then filler bytes and an end marker. */
export function makeJpeg({ width = 320, height = 200, bytes = 9000 } = {}) {
  const sof = Buffer.alloc(19);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3;
  const filler = Buffer.alloc(bytes);
  let s = 7;
  for (let i = 0; i < filler.length; i += 1) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    filler[i] = (s >> 16) & 0xfe;
  }
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xda]), filler, Buffer.from([0xff, 0xd9])]);
}

/** A minimal WebP container (VP8X header) padded to a realistic size. */
export function makeWebp({ width = 320, height = 200, bytes = 9000 } = {}) {
  const vp8x = Buffer.alloc(18);
  vp8x.write("VP8X", 0, "latin1");
  vp8x.writeUInt32LE(10, 4);
  vp8x.writeUIntLE(width - 1, 12, 3);
  vp8x.writeUIntLE(height - 1, 15, 3);
  const data = Buffer.alloc(bytes);
  let s = 11;
  for (let i = 0; i < data.length; i += 1) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    data[i] = (s >> 16) & 0xff;
  }
  const padChunk = Buffer.concat([Buffer.from("VP8 ", "latin1"), Buffer.alloc(4), data]);
  padChunk.writeUInt32LE(data.length, 4);
  const body = Buffer.concat([Buffer.from("WEBP", "latin1"), vp8x, padChunk]);
  const header = Buffer.alloc(8);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}
