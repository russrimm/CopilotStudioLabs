// A small, dependency-free picture fingerprint, so two screenshots can be compared by what they LOOK like, not by their bytes.
//
// Two captures of the same page are never byte-for-byte equal (an animation frame, a blinking caret, a clock), so a SHA-256 cannot
// tell that two slots hold the same screen. This reads the pixels of a PNG (the format the companion and the browser produce),
// averages them into a coarse grid of brightness cells, and keeps two 256-bit hashes of that grid:
//
//   d  a "difference hash": for each cell, is it brighter than the cell to its right? It follows the layout and the edges.
//   a  an "average hash": for each cell, is it brighter than the picture's own average? It follows the large light and dark areas.
//
// Two pictures are NEAR-IDENTICAL when both hashes are close (see `distance` and `NEAR_DISTANCE`). Text that changes inside a
// page (a name, a date, a list item) moves a few cells; a different page moves many.
//
// What this cannot do: it does not read text, and it cannot decode JPEG or WebP (those pictures get no fingerprint and are compared
// by SHA-256 only). Nothing here keeps a picture or any pixel: the result is 128 hex characters.

import zlib from "node:zlib";

export const FINGERPRINT_VERSION = 1;

const COLS = 17;
const ROWS = 16;
const BITS = 256;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const MAX_PIXELS = 25_000_000;

/**
 * How far apart two pictures may be and still count as "the same screen": the larger of the two hash distances, out of 256 bits.
 * Chosen on real captures: the same page taken at different moments (an animation frame, a different list, a masked name) is 0 to
 * 9 bits apart; the closest two DIFFERENT screens found (two tabs of one settings dialog) are 17 bits apart; screens of different
 * pages are 28 bits and more apart. A near-identical pair is a reason to look, never proof by itself (see picture-integrity.js).
 */
export const NEAR_DISTANCE = 12;

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Read the chunks of a PNG. Returns null when it is not a well-formed, non-interlaced PNG this module can decode. */
function readChunks(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 33 || !PNG_MAGIC.every((value, i) => bytes[i] === value)) return null;
  const chunks = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > bytes.length) return null;
    chunks.push({ type, start: offset + 8, length });
    offset = end;
    if (type === "IEND") break;
  }
  const ihdr = chunks[0];
  if (!ihdr || ihdr.type !== "IHDR" || ihdr.length !== 13) return null;
  return {
    chunks,
    width: bytes.readUInt32BE(ihdr.start),
    height: bytes.readUInt32BE(ihdr.start + 4),
    bitDepth: bytes[ihdr.start + 8],
    colorType: bytes[ihdr.start + 9],
    interlace: bytes[ihdr.start + 12],
  };
}

/**
 * The average brightness (0 to 255) of each cell of a `COLS` by `ROWS` grid laid over the picture, row by row; null when the
 * picture cannot be decoded here (JPEG, WebP, an interlaced or 16-bit-per-sample or very large PNG).
 */
export function brightnessGrid(bytes, { cols = COLS, rows = ROWS } = {}) {
  const info = readChunks(bytes);
  if (!info) return null;
  const { width, height, bitDepth, colorType, interlace } = info;
  const channels = CHANNELS[colorType];
  if (!channels || interlace !== 0 || bitDepth !== 8 || width < 1 || height < 1 || width * height > MAX_PIXELS) return null;
  const stride = width * channels;
  const expected = height * (stride + 1);
  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(info.chunks.filter((c) => c.type === "IDAT").map((c) => bytes.subarray(c.start, c.start + c.length))), { maxOutputLength: expected + 64 });
  } catch {
    return null;
  }
  if (raw.length < expected) return null;
  let palette = null;
  if (colorType === 3) {
    const plte = info.chunks.find((c) => c.type === "PLTE");
    if (!plte || plte.length % 3 !== 0) return null;
    palette = new Float64Array((plte.length / 3) * 1);
    for (let i = 0; i < palette.length; i += 1) {
      const at = plte.start + i * 3;
      palette[i] = (bytes[at] * 299 + bytes[at + 1] * 587 + bytes[at + 2] * 114) / 1000;
    }
  }

  const sums = new Float64Array(cols * rows);
  const counts = new Float64Array(cols * rows);
  const colOf = new Uint16Array(width);
  for (let x = 0; x < width; x += 1) colOf[x] = Math.min(cols - 1, Math.floor((x * cols) / width));
  let prev = Buffer.alloc(stride);
  let row = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const base = y * (stride + 1);
    const filter = raw[base];
    for (let i = 0; i < stride; i += 1) {
      const x = raw[base + 1 + i];
      const a = i >= channels ? row[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let value;
      if (filter === 0) value = x;
      else if (filter === 1) value = x + a;
      else if (filter === 2) value = x + b;
      else if (filter === 3) value = x + ((a + b) >> 1);
      else if (filter === 4) value = x + paeth(a, b, c);
      else return null;
      row[i] = value & 0xff;
    }
    const cellRow = Math.min(rows - 1, Math.floor((y * rows) / height)) * cols;
    for (let x = 0; x < width; x += 1) {
      const at = x * channels;
      let luma;
      if (colorType === 2 || colorType === 6) luma = (row[at] * 299 + row[at + 1] * 587 + row[at + 2] * 114) / 1000;
      else if (colorType === 3) luma = palette[row[at]] ?? 0;
      else luma = row[at];
      const cell = cellRow + colOf[x];
      sums[cell] += luma;
      counts[cell] += 1;
    }
    [prev, row] = [row, prev];
  }
  const grid = new Float64Array(cols * rows);
  for (let i = 0; i < grid.length; i += 1) grid[i] = counts[i] ? sums[i] / counts[i] : 0;
  return grid;
}

function packBits(bits) {
  let hex = "";
  for (let i = 0; i < bits.length; i += 4) hex += ((bits[i] << 3) | (bits[i + 1] << 2) | (bits[i + 2] << 1) | bits[i + 3]).toString(16);
  return hex;
}

/**
 * The fingerprint of a picture: `{v, w, h, d, a}` (two 64-character hex strings), or null when it cannot be decoded here.
 * @param {Buffer} bytes
 */
export function fingerprintPicture(bytes) {
  const info = readChunks(bytes);
  const grid = info ? brightnessGrid(bytes) : null;
  if (!grid) return null;
  // A difference of under one brightness step is a rounding wobble, not an edge.
  const EDGE = 0.75;
  const d = [];
  for (let r = 0; r < ROWS; r += 1) for (let c = 0; c < COLS - 1; c += 1) d.push(grid[r * COLS + c] - grid[r * COLS + c + 1] > EDGE ? 1 : 0);
  let total = 0;
  const cells = [];
  for (let r = 0; r < ROWS; r += 1) for (let c = 0; c < COLS - 1; c += 1) {
    const value = grid[r * COLS + c];
    cells.push(value);
    total += value;
  }
  const mean = total / cells.length;
  const a = cells.map((value) => (value > mean + 2 ? 1 : 0));
  return { v: FINGERPRINT_VERSION, w: info.width, h: info.height, d: packBits(d), a: packBits(a) };
}

/** Whether a stored value is a fingerprint this module can compare. */
export function isFingerprint(value) {
  return Boolean(value && typeof value === "object" && value.v === FINGERPRINT_VERSION && /^[0-9a-f]{64}$/.test(String(value.d)) && /^[0-9a-f]{64}$/.test(String(value.a)));
}

const wordCache = new Map();
const WORD_CACHE_MAX = 20000;

/**
 * The fewest edge cells a picture needs before its look says anything. The 47 real pictures it was tuned on have 25 to 82 (a typical
 * page about 55); a nearly flat page (a blank or loading screen, a page of one white card) has too little structure to tell two screens
 * apart, so only identical bytes (SHA-256) count for those.
 */
export const MIN_STRUCTURE_BITS = 16;

/** A 64-character hex hash as eight 32-bit words, so comparing two hashes is a few operations (the same hash is read many times). */
function wordsOf(hex) {
  let words = wordCache.get(hex);
  if (words) return words;
  words = new Uint32Array(8);
  for (let i = 0; i < 8; i += 1) words[i] = parseInt(hex.slice(i * 8, i * 8 + 8), 16) >>> 0;
  if (wordCache.size >= WORD_CACHE_MAX) wordCache.clear();
  wordCache.set(hex, words);
  return words;
}

function popcount(value) {
  let v = value - ((value >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function hamming(x, y) {
  const a = wordsOf(x);
  const b = wordsOf(y);
  let bits = 0;
  for (let i = 0; i < 8; i += 1) bits += popcount((a[i] ^ b[i]) >>> 0);
  return bits;
}

/**
 * How different two pictures look: the larger of the two hash distances (0 to 256), or null when either has no fingerprint, the two
 * pictures have different shapes (a wide window and a narrow one are never the same screen), or either is too flat to compare by look.
 */
export function distance(first, second) {
  if (!isFingerprint(first) || !isFingerprint(second)) return null;
  const ratio = (value) => (value.h ? value.w / value.h : 0);
  if (Math.abs(ratio(first) - ratio(second)) > 0.05) return null;
  const structure = (value) => Array.from(wordsOf(value.d)).reduce((bits, word) => bits + popcount(word), 0);
  if (structure(first) < MIN_STRUCTURE_BITS || structure(second) < MIN_STRUCTURE_BITS) return null;
  return Math.max(hamming(first.d, second.d), hamming(first.a, second.a));
}

/** Whether two fingerprints are the same screen for every practical purpose (`NEAR_DISTANCE`). */
export const looksSame = (first, second, limit = NEAR_DISTANCE) => {
  const gap = distance(first, second);
  return gap !== null && gap <= limit;
};

/** The size of the grid and the hash, for the report. */
export const FINGERPRINT_BITS = BITS;
