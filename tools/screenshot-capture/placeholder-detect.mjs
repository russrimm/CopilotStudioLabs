// Placeholder-picture detection, shared by the portal and the Local Capture Companion.
//
// A "placeholder" is a picture that stands in for a screenshot without being one:
//   - the neutral "Screenshot pending" image the lab builder writes into every empty slot
//   - captioned filler pictures from scripts/make_placeholders.py (a blue header bar that reads
//     "PLACEHOLDER SCREENSHOT" inside a thin frame) and scripts/generate-lab4-screenshots.py
//     (a dark "Lab 04 Reference" mock-up with a "Replace with actual UI capture" footer)
// None of them may ever count as a captured screenshot, however many bytes they weigh, so the file size
// is never part of the decision. Four independent signals decide, strongest first:
//   1. marker  a PNG tEXt chunk `Software=cslabs-placeholder`, which both generator scripts now write
//   2. hash    the SHA-256 of every placeholder file known to have been committed (KNOWN_PLACEHOLDER_SHA256)
//   3. layout  a structural signature that also catches regenerated variants (see analyzeLightHeader and
//              analyzeBandedMock below; the signatures are described in docs/lab-builder.md section 6)
//   4. pending the neutral pending image, matched by hash
//
// This file is standalone on purpose: it imports only Node built-ins so the companion download can ship it
// without the portal. The portal reaches it through portal/lib/lab-builder/placeholder-detect.js.
//
// To teach it a new placeholder file: run `node tools/screenshot-capture/placeholder-detect.mjs <file>` to get
// the SHA-256, add it to KNOWN_PLACEHOLDER_SHA256, and add the file to the fixtures in
// portal/test/placeholder-detect.test.js. Stamp files from a new generator with the marker instead.

import crypto from "node:crypto";
import fs from "node:fs";
import zlib from "node:zlib";
import { pathToFileURL } from "node:url";

/** What a person sees when a placeholder is refused. */
export const PLACEHOLDER_MESSAGE = "This is a placeholder picture, not a screenshot of the product.";

/** The PNG tEXt entry every placeholder generator stamps, so detection is exact for new files. */
export const PLACEHOLDER_MARKER = Object.freeze({ keyword: "Software", value: "cslabs-placeholder" });

export const PLACEHOLDER_REASONS = Object.freeze({
  marker: "marker",
  knownHash: "known-hash",
  pendingImage: "pending-image",
  lightHeader: "light-header-signature",
  bandedMock: "banded-mock-signature",
});

/** A generated placeholder is small and flat; a file bigger than this is never read for the marker or the hash. */
export const MAX_PLACEHOLDER_BYTES = 256 * 1024;
/** The layout check only decodes small, modest-sized PNGs: flat generated pictures are both, real screenshots rarely are. */
const MAX_LAYOUT_BYTES = 128 * 1024;
const MAX_PIXELS = 1_500_000;

const PENDING = PLACEHOLDER_REASONS.pendingImage;
const KNOWN = PLACEHOLDER_REASONS.knownHash;

/**
 * SHA-256 of every placeholder file known to have been committed or generated, with where it came from.
 * Every entry is a picture that must never count as a real screenshot.
 */
export const KNOWN_PLACEHOLDER_SHA256 = Object.freeze({
  // The neutral "Screenshot pending" image (tools/lab-builder/make-pending-placeholder.mjs).
  "1be866b32104910f4f855e00e570d42735d388b0c3313ad548eda8a70d006843": [PENDING, "portal/lib/lab-builder/assets/screenshot-pending.png"],
  // scripts/make_placeholders.py: blue header bar, "PLACEHOLDER SCREENSHOT".
  "a5e7d267bbcaa69cc53d37de0a6679529a67ff17b2554098293c6f0169d3c8c5": [KNOWN, "labs/02-conversational-design-fundamentals/assets/question-entity-node.png"],
  "f3fb8ef38c8380d713d73dfc2172b06b71d6d5c90390dbcc437b1d184b5a27b0": [KNOWN, "labs/02-conversational-design-fundamentals/assets/topics-overview.png"],
  "de01313da4471bb6750c1aafd6af74f4e0338bad0852e312d068c97beda09fa5": [KNOWN, "labs/02-conversational-design-fundamentals/assets/trigger-phrases.png"],
  "8353ca0f077a30ed6a99b212d3733352115d79e81f72d6a34aab52a9a9a24bf5": [KNOWN, "labs/12-content-moderation-responsible-ai/assets/content-moderation-level.png"],
  "5911a3f331c2471e9ec313b887c6592840d79178ca75443ce63e73b0ef03526b": [KNOWN, "labs/12-content-moderation-responsible-ai/assets/generative-ai-settings.png"],
  "3d2148093a01381b57a3e827198b1988b83b64206f0ed8b7bb9d16aaf4971d2d": [KNOWN, "labs/12-content-moderation-responsible-ai/assets/test-guardrail-response.png"],
  "b7c12354a88c06281b53ea90d2fe55fbc3d1a1b9e09ff8d4aa1dbb47ae1d0b9d": [KNOWN, "labs/34-authentication-end-user-signin/assets/entra-auth-config.png (removed)"],
  "601d3630fd86e731146f11709d265e0df91e469247eba4183f5cb9ade45fc2dd": [KNOWN, "labs/34-authentication-end-user-signin/assets/security-authentication-page.png (removed)"],
  "1ec4e75b84bf7a33a648fd568a85e9e0138a54283e11369e084846f324ee4297": [KNOWN, "labs/34-authentication-end-user-signin/assets/test-signin-prompt.png (removed)"],
  "d4ea4f7e14a0c6d3f59c4ee7b3d41d2d34b66db10e73eb9956b9989eb36bde3f": [KNOWN, "labs/35-dlp-governance-policies/assets/connector-classification.png (removed)"],
  "5a146cbc03cfbcc80840270099e85244532520b9d8fedbfffb2a9440af20ee2f": [KNOWN, "labs/35-dlp-governance-policies/assets/policy-applied-environment.png (removed)"],
  "cda800b076caed29a5b4fca8a6c44285e3788cd4d26d584cfc6de5cfdceeb5db": [KNOWN, "labs/35-dlp-governance-policies/assets/ppac-dlp-policies.png (removed)"],
  // scripts/generate-lab4-screenshots.py: dark "Lab 04 Reference" mock-ups.
  "b0272cdb97c0f11446f5da237df120fc0e824c65751e78bf7d64fe6994475790": [KNOWN, "labs/06-energy-weather-agent/assets/topic-add-from-blank.png"],
  "ab496f918167f863e843fe5f2f398286bbe0606f45ad4d660495e315d5513a33": [KNOWN, "adaptive-card-json-editor.png (removed Lab 06 mock-up)"],
  "31c8c9ba0989e8b0875e8af7e4fe09840f90c56255f52b973d5cde4bbe523c6a": [KNOWN, "adaptive-card-output-mapping.png (removed Lab 06 mock-up)"],
  "deea6f37323ec37786257f344293067232564097510c040acb14803b705310c1": [KNOWN, "adaptive-card-preview.png (removed Lab 06 mock-up)"],
  "de508cf88907a0cc683d5e58d72c9101aad7c417f66680338ff0f30bc485e209": [KNOWN, "connected-agent-config.png (removed Lab 06 mock-up)"],
  "869aae85164681bf34e683f0c50b67ee651cd71acd50f9206d92cce99c0272ba": [KNOWN, "connected-agent-sharing-enabled.png (removed Lab 06 mock-up)"],
  "90d29377dc79efc252ae387507ac11d60d25480abb5628659b4083b550f89694": [KNOWN, "eval-test-methods.png (removed Lab 06 mock-up)"],
  "6419a45374de761dc27bb9768f8abf1576807aa9b1b4e1dedbc6c36460cf7960": [KNOWN, "evaluation-results.png (removed Lab 06 mock-up)"],
  "09158024d0e2e22d2ff4371732327a2e3f0f570d771d4e30f9435469f104e138": [KNOWN, "flow-agent-trigger.png (removed Lab 06 mock-up)"],
  "355357a67f15c6ed0ce270ff0a6ba1e236ba4b1faa229e3323f63ea18f3337d3": [KNOWN, "flow-state-summary-canvas.png (removed Lab 06 mock-up)"],
  "31ed47626de7b1c0de33323a135341f41166829a9fadf5c235af57a1e6d480a8": [KNOWN, "global-variables-list.png (removed Lab 06 mock-up)"],
  "881ec5583f78cc00aaa5972f8e51c4eadb31b95be64408d0db26f0d2ac517101": [KNOWN, "mcp-tool-discovery.png (removed Lab 06 mock-up)"],
  "b946d1632aa24c14ad417d065f6a3851de27943881fc72144e171bb99daa5eac": [KNOWN, "model-selection-comparison.png (removed Lab 06 mock-up)"],
  "0baa99691d2ca9bd36254ec4f401902ee3061fa7e85a570d460949285ba14b12": [KNOWN, "state-fips-switch-powerfx.png (removed Lab 06 mock-up)"],
  "b6ffeabea5114545000aa84a5a45efa23ff6cf7656ce8884c0b505c826616049": [KNOWN, "tool-county-demographics-inputs.png (removed Lab 06 mock-up)"],
  "fee8a86a0e172576c3bc8a691923bd99713f4b29902e33e296240a6323bab3ff": [KNOWN, "tool-county-demographics-test.png (removed Lab 06 mock-up)"],
  "816b79620f43c68cb4b1eb8edfceda39b2137dad78664526076fbaffa10a6b4f": [KNOWN, "variable-picker-in-url.png (removed Lab 06 mock-up)"],
});

const NEGATIVE = Object.freeze({ placeholder: false, reason: null, confidence: 0 });
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const CACHE_LIMIT = 2000;
const bySha = new Map();
const byPath = new Map();

function remember(cache, key, value) {
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(key, value);
  return value;
}

function sha256Hex(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

// ── PNG access ─────────────────────────────────────────────────────────────

function readChunks(bytes) {
  const chunks = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length + 4;
    if (end > bytes.length) return null;
    chunks.push({ type, start, length });
    offset = end;
    if (type === "IEND") break;
  }
  return chunks;
}

function hasMarker(bytes, chunks) {
  for (const chunk of chunks) {
    if (chunk.type !== "tEXt" || chunk.length > 1024) continue;
    const text = bytes.toString("latin1", chunk.start, chunk.start + chunk.length);
    const nul = text.indexOf("\0");
    if (nul < 1) continue;
    if (text.slice(0, nul) === PLACEHOLDER_MARKER.keyword && text.slice(nul + 1).trim().toLowerCase().startsWith(PLACEHOLDER_MARKER.value)) return true;
  }
  return false;
}

const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

/** Decode an 8-bit, non-interlaced PNG into a coarse grid of packed 0xRRGGBB colors, or null for any other layout. */
function decodeGrid(bytes, chunks) {
  const ihdr = chunks[0];
  if (!ihdr || ihdr.type !== "IHDR" || ihdr.length !== 13) return null;
  const width = bytes.readUInt32BE(ihdr.start);
  const height = bytes.readUInt32BE(ihdr.start + 4);
  const bitDepth = bytes[ihdr.start + 8];
  const colorType = bytes[ihdr.start + 9];
  const interlace = bytes[ihdr.start + 12];
  const channels = CHANNELS[colorType];
  if (!channels || bitDepth !== 8 || interlace !== 0 || width < 64 || height < 64 || width * height > MAX_PIXELS) return null;

  const stride = width * channels;
  const expected = height * (stride + 1);
  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(chunks.filter((c) => c.type === "IDAT").map((c) => bytes.subarray(c.start, c.start + c.length))), { maxOutputLength: expected + 64 });
  } catch {
    return null;
  }
  if (raw.length < expected) return null;

  // Typed-array writes wrap modulo 256, which is exactly the PNG filter arithmetic.
  const px = Buffer.allocUnsafe(height * stride);
  for (let y = 0; y < height; y += 1) {
    const src = y * (stride + 1) + 1;
    const filter = raw[src - 1];
    const dst = y * stride;
    const up = dst - stride;
    if (filter === 0 || (y === 0 && filter === 2)) {
      raw.copy(px, dst, src, src + stride);
    } else if (filter === 1) {
      for (let i = 0; i < stride; i += 1) px[dst + i] = raw[src + i] + (i >= channels ? px[dst + i - channels] : 0);
    } else if (filter === 2) {
      for (let i = 0; i < stride; i += 1) px[dst + i] = raw[src + i] + px[up + i];
    } else if (filter === 3) {
      for (let i = 0; i < stride; i += 1) px[dst + i] = raw[src + i] + (((i >= channels ? px[dst + i - channels] : 0) + (y > 0 ? px[up + i] : 0)) >> 1);
    } else if (filter === 4) {
      for (let i = 0; i < stride; i += 1) {
        const a = i >= channels ? px[dst + i - channels] : 0;
        const b = y > 0 ? px[up + i] : 0;
        const c = i >= channels && y > 0 ? px[up + i - channels] : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        px[dst + i] = raw[src + i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
    } else return null;
  }

  const step = Math.max(1, Math.floor(Math.min(width, height) / 300));
  const gw = Math.ceil(width / step);
  const gh = Math.ceil(height / step);
  const cells = new Int32Array(gw * gh);
  const gray = channels <= 2;
  for (let gy = 0; gy < gh; gy += 1) {
    for (let gx = 0; gx < gw; gx += 1) {
      const at = Math.min(height - 1, gy * step) * stride + Math.min(width - 1, gx * step) * channels;
      cells[gy * gw + gx] = gray ? px[at] * 0x010101 : (px[at] << 16) | (px[at + 1] << 8) | px[at + 2];
    }
  }
  return { gw, gh, cells };
}

// ── Layout signatures ──────────────────────────────────────────────────────

const red = (c) => (c >> 16) & 0xff;
const green = (c) => (c >> 8) & 0xff;
const blue = (c) => c & 0xff;
const minChannel = (c) => Math.min(red(c), green(c), blue(c));
const spread = (c) => Math.max(red(c), green(c), blue(c)) - minChannel(c);

function topColors(cells, count) {
  const tally = new Map();
  for (let i = 0; i < cells.length; i += 1) tally.set(cells[i], (tally.get(cells[i]) || 0) + 1);
  return [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, count);
}

function fractionOf(cells, gw, row, from, to, color) {
  let n = 0;
  for (let x = from; x < to; x += 1) if (cells[row * gw + x] === color) n += 1;
  return n / Math.max(1, to - from);
}

/** The color a line of cells is made of when at least `min` of them agree, else null. */
function lineColor(cells, gw, { vertical, at, from, to, min = 0.9 }) {
  const tally = new Map();
  for (let i = from; i < to; i += 1) {
    const value = vertical ? cells[i * gw + at] : cells[at * gw + i];
    tally.set(value, (tally.get(value) || 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [value, count] of tally) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return bestCount / Math.max(1, to - from) >= min ? best : null;
}

/**
 * scripts/make_placeholders.py: a saturated header bar across the top (about 6 to 11 percent of the height),
 * a flat pale body below it, a thin frame of one other color down the left and right sides and along the
 * bottom, and a few centered glyphs. Real pages almost never combine all three: a flat pale body, a solid
 * saturated full-width bar, and a frame.
 */
function analyzeLightHeader({ gw, gh, cells }) {
  const total = cells.length;
  const tops = topColors(cells, 8);
  const [body, bodyCount] = tops[0];
  if (bodyCount / total < 0.75 || minChannel(body) < 200) return null;
  const bar = tops.slice(1).find(([c, n]) => spread(c) >= 80 && n / total >= 0.04 && n / total <= 0.2);
  if (!bar) return null;
  const accent = bar[0];

  const from = Math.floor(gw * 0.03);
  const to = Math.ceil(gw * 0.97);
  let best = { start: -1, length: 0 };
  let run = { start: -1, length: 0 };
  for (let y = 0; y < gh; y += 1) {
    if (fractionOf(cells, gw, y, from, to, accent) >= 0.7) {
      if (run.length === 0) run.start = y;
      run.length += 1;
      if (run.length > best.length) best = { ...run };
    } else {
      run = { start: -1, length: 0 };
    }
  }
  const end = best.start + best.length;
  if (best.start > gh * 0.04 || end < gh * 0.06 || end > gh * 0.16 || best.length < gh * 0.05) return null;

  let outside = 0;
  let below = 0;
  for (let y = 0; y < gh; y += 1) {
    const inBar = y >= best.start && y < end;
    for (let x = 0; x < gw; x += 1) {
      const c = cells[y * gw + x];
      if (!inBar && c === accent) outside += 1;
      if (y >= end && c === body) below += 1;
    }
  }
  if (outside > total * 0.01 || below / Math.max(1, (gh - end) * gw) < 0.85) return null;

  const edge = Math.max(2, Math.ceil(gw * 0.04));
  const rows = [Math.floor(gh * 0.15), Math.floor(gh * 0.92)];
  const cols = [Math.floor(gw * 0.1), Math.floor(gw * 0.9)];
  let frame = null;
  for (let c = 0; c < edge && frame === null; c += 1) {
    const left = lineColor(cells, gw, { vertical: true, at: c, from: rows[0], to: rows[1] });
    if (left !== null && left !== body && left !== accent) frame = left;
  }
  if (frame === null) return null;
  const sideFound = (positions, vertical, range) => positions.some((at) => lineColor(cells, gw, { vertical, at, from: range[0], to: range[1] }) === frame);
  const right = sideFound(Array.from({ length: edge }, (_, i) => gw - 1 - i), true, rows);
  const bottom = sideFound(Array.from({ length: Math.max(2, Math.ceil(gh * 0.04)) }, (_, i) => gh - 1 - i), false, cols);
  if (!right || !bottom) return null;

  // Centered glyph: whatever is left in the body (icon outline and captions) sits in the middle.
  const margin = Math.max(edge, Math.ceil(gw * 0.05));
  let minX = gw;
  let maxX = -1;
  for (let y = end + margin; y < gh - margin; y += 1) {
    for (let x = margin; x < gw - margin; x += 1) {
      const c = cells[y * gw + x];
      if (c === body || c === accent || c === frame) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
  }
  const centered = maxX >= minX && Math.abs((minX + maxX) / 2 - gw / 2) <= gw * 0.12 && maxX - minX <= gw * 0.8;
  return { family: "light-header", centered };
}

function columnBands(cells, gw, gh, x) {
  const segments = [];
  for (let y = 0; y < gh; y += 1) {
    const color = cells[y * gw + x];
    const last = segments[segments.length - 1];
    if (last && last.color === color) last.length += 1;
    else segments.push({ color, length: 1 });
  }
  // Absorb one-row separators and anti-aliasing so a border line does not split a band.
  const merged = [];
  for (const segment of segments) {
    const last = merged[merged.length - 1];
    if (last && (segment.length <= 1 || last.color === segment.color)) last.length += segment.length;
    else merged.push({ ...segment });
  }
  return merged;
}

function rowIsFlat(cells, gw, y) {
  const tally = new Map();
  for (let x = 0; x < gw; x += 1) tally.set(cells[y * gw + x], (tally.get(cells[y * gw + x]) || 0) + 1);
  let top = 0;
  for (const n of tally.values()) if (n > top) top = n;
  return top / gw >= 0.88;
}

/**
 * scripts/generate-lab4-screenshots.py: a flat top bar, a second flat bar beneath it, a flat body, and a footer bar
 * in the same color as the top bar, so a column near either edge reads bar, bar, body, bar. Nearly every row is a
 * single color apart from a few text runs. A real page has no full-width footer that matches its header.
 */
function analyzeBandedMock({ gw, gh, cells }) {
  const columns = [Math.max(1, Math.round(gw * 0.004)), gw - 1 - Math.max(1, Math.round(gw * 0.004))];
  const shapes = columns.map((x) => columnBands(cells, gw, gh, x));
  const inRange = (length, low, high) => length >= gh * low && length <= gh * high;
  for (const bands of shapes) {
    if (bands.length !== 4) return null;
    const [top, second, body, footer] = bands;
    if (top.color !== footer.color || second.color === top.color || body.color === top.color || body.color === second.color) return null;
    if (!inRange(top.length, 0.03, 0.1) || !inRange(second.length, 0.03, 0.1) || !inRange(footer.length, 0.03, 0.1) || body.length < gh * 0.6) return null;
  }
  if (shapes[0].map((b) => b.color).join() !== shapes[1].map((b) => b.color).join()) return null;
  let flat = 0;
  for (let y = 0; y < gh; y += 1) if (rowIsFlat(cells, gw, y)) flat += 1;
  return flat >= gh * 0.8 ? { family: "banded-mock" } : null;
}

// ── Public API ─────────────────────────────────────────────────────────────

function positive(reason, confidence, sha256, label = null) {
  return Object.freeze({ placeholder: true, reason, confidence, label, sha256 });
}

function classifyBytes(bytes, structural) {
  if (bytes.length < 8 || bytes.length > MAX_PLACEHOLDER_BYTES || !PNG_MAGIC.every((b, i) => bytes[i] === b)) return NEGATIVE;
  const sha256 = sha256Hex(bytes);
  const cached = bySha.get(sha256 + (structural ? "" : ":exact"));
  if (cached) return cached;
  const store = (result) => remember(bySha, sha256 + (structural ? "" : ":exact"), result);

  const known = KNOWN_PLACEHOLDER_SHA256[sha256];
  if (known) return store(positive(known[0], 1, sha256, known[1]));
  const chunks = readChunks(bytes);
  if (!chunks) return store(Object.freeze({ ...NEGATIVE, sha256 }));
  if (hasMarker(bytes, chunks)) return store(positive(PLACEHOLDER_REASONS.marker, 1, sha256));
  if (structural && bytes.length <= MAX_LAYOUT_BYTES) {
    const grid = decodeGrid(bytes, chunks);
    if (grid) {
      const light = analyzeLightHeader(grid);
      if (light) return store(positive(PLACEHOLDER_REASONS.lightHeader, light.centered ? 0.95 : 0.85, sha256));
      if (analyzeBandedMock(grid)) return store(positive(PLACEHOLDER_REASONS.bandedMock, 0.9, sha256));
    }
  }
  return store(Object.freeze({ ...NEGATIVE, sha256 }));
}

/**
 * Whether a picture is a placeholder rather than a real screenshot.
 *
 * @param {Buffer|Uint8Array|string} input image bytes, or the path of an image file
 * @param {{structural?: boolean}} [options] `structural: false` limits the check to the marker and the known hashes
 * @returns {{placeholder: boolean, reason: string|null, confidence: number, label?: string|null, sha256?: string}}
 *   `reason` is one of PLACEHOLDER_REASONS when `placeholder` is true. `confidence` is how sure the detector is that
 *   the picture is a placeholder: 1 for a marker or a known hash, 0.85 to 0.95 for a layout match, 0 otherwise.
 */
export function detectPlaceholder(input, { structural = true } = {}) {
  if (typeof input === "string") {
    let stat;
    try {
      stat = fs.statSync(input);
    } catch {
      return NEGATIVE;
    }
    if (!stat.isFile() || stat.size > MAX_PLACEHOLDER_BYTES) return NEGATIVE;
    const key = `${input}|${structural}`;
    const seen = byPath.get(key);
    if (seen && seen.size === stat.size && seen.mtimeMs === stat.mtimeMs) return seen.result;
    let bytes;
    try {
      bytes = fs.readFileSync(input);
    } catch {
      return NEGATIVE;
    }
    const result = classifyBytes(bytes, structural);
    remember(byPath, key, { size: stat.size, mtimeMs: stat.mtimeMs, result });
    return result;
  }
  if (input instanceof Uint8Array) {
    return classifyBytes(Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength), structural);
  }
  return NEGATIVE;
}

export { detectPlaceholder as isPlaceholderImage };

/** Boolean shortcut for `detectPlaceholder(input).placeholder`. */
export function isPlaceholder(input, options) {
  return detectPlaceholder(input, options).placeholder;
}

/** The layout signature alone (no marker, no hash): "light-header", "banded-mock", or null. Exposed for tests and tuning. */
export function detectPlaceholderLayout(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_LAYOUT_BYTES || !PNG_MAGIC.every((b, i) => bytes[i] === b)) return null;
  const chunks = readChunks(bytes);
  const grid = chunks && decodeGrid(bytes, chunks);
  if (!grid) return null;
  return analyzeLightHeader(grid)?.family || analyzeBandedMock(grid)?.family || null;
}

// `node tools/screenshot-capture/placeholder-detect.mjs <image>...` prints the verdict and SHA-256 of each file.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const file of process.argv.slice(2)) {
    let sha256 = null;
    let layout = null;
    try {
      const bytes = fs.readFileSync(file);
      sha256 = sha256Hex(bytes);
      layout = detectPlaceholderLayout(bytes);
    } catch {
      /* reported as unreadable below */
    }
    console.log(JSON.stringify({ file, sha256, layout, ...detectPlaceholder(file) }));
  }
}
