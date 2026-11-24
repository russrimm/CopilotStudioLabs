// Strict, dependency-free checks for a captured or pasted screenshot. The same
// rules run twice: on the Local Capture Companion before it uploads, and on the
// portal before anything is saved (portal/lib/capture/verify-upload.js wraps this).
//
// Trust model: the image bytes are the only thing the checks believe. Evidence
// that the companion reports (page address, title, visible text) can add a
// failure or a warning, never remove one, and never chooses a file name or a
// destination.

import crypto from "node:crypto";
import zlib from "node:zlib";

import { cleanExpectedLabels, labelIsVisible, visibleWordSet } from "./labels.mjs";
import { PLACEHOLDER_MESSAGE, detectPlaceholder } from "./placeholder-detect.mjs";
import { assessLanding } from "./targets.mjs";
import { HARNESS_LABELS, HARNESS_MIN_COMPANION, isSpecificHarness, normalizeHarness, sanitizeHarnessProof } from "./harness.mjs";

export const IMAGE_LIMITS = Object.freeze({
  maxBytes: 8 * 1024 * 1024,
  minBytes: 5 * 1024,
  minWidth: 200,
  minHeight: 120,
  maxWidth: 10000,
  maxHeight: 10000,
  maxPixels: 25_000_000,
  blankFail: 0.995,
  blankWarn: 0.97,
});

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const SIGN_IN_HOSTS = [
  "login.microsoftonline.com",
  "login.microsoftonline.us",
  "login.microsoft.com",
  "login.live.com",
  "login.windows.net",
  "sts.windows.net",
  "aadcdn.msftauth.net",
  "aadcdn.msauth.net",
];
const SIGN_IN_TITLE_RE = /^\s*(?:sign in(?: to your account)?|pick an account|sign in to your microsoft account|stay signed in\??)\s*$/i;
const SIGN_IN_TEXT_RES = [
  /sign in to your account/i,
  /pick an account/i,
  /stay signed in\?/i,
  /enter password/i,
  /can.?t access your account\?/i,
  /use another account/i,
];
const MARKUP_RE = /<\s*(?:script|svg|html|iframe|\?xml)\b/i;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes, start, end) {
  let c = 0xffffffff;
  for (let i = start; i < end; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function sha256Hex(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/** "png", "jpeg", "webp", or null: decided from the first bytes, never from a file name or Content-Type. */
export function detectImageFormat(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12) return null;
  if (PNG_MAGIC.every((b, i) => bytes[i] === b)) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  return null;
}

/** The file extension a format is allowed to carry. */
export function extensionsForFormat(format) {
  return format === "png" ? [".png"] : format === "jpeg" ? [".jpg", ".jpeg"] : format === "webp" ? [".webp"] : [];
}

function reason(code, level, message) {
  return { code, level, message };
}

// ── PNG ────────────────────────────────────────────────────────────────────

function readPng(bytes) {
  const chunks = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > bytes.length) return { error: "The PNG is cut off: a data block runs past the end of the file." };
    if (crc32(bytes, offset + 4, offset + 8 + length) !== bytes.readUInt32BE(offset + 8 + length)) {
      return { error: `The PNG is corrupt: the ${type} block fails its checksum.` };
    }
    chunks.push({ type, start: offset + 8, length });
    offset = end;
    if (type === "IEND") break;
  }
  const ihdr = chunks[0];
  if (!ihdr || ihdr.type !== "IHDR" || ihdr.length !== 13) return { error: "The PNG header is missing or malformed." };
  const info = {
    width: bytes.readUInt32BE(ihdr.start),
    height: bytes.readUInt32BE(ihdr.start + 4),
    bitDepth: bytes[ihdr.start + 8],
    colorType: bytes[ihdr.start + 9],
    interlace: bytes[ihdr.start + 12],
    chunks,
    hasEnd: chunks.some((c) => c.type === "IEND"),
    trailingBytes: Math.max(0, bytes.length - offset),
  };
  return { info };
}

const PNG_CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const PNG_DEPTHS = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Sample the pixels of a non-interlaced PNG and report how uniform the picture is. Returns null when it cannot be decoded. */
function samplePng(bytes, info) {
  const channels = PNG_CHANNELS[info.colorType];
  if (!channels || !PNG_DEPTHS[info.colorType].includes(info.bitDepth) || info.interlace !== 0) return null;
  const { width, height, bitDepth, colorType } = info;
  const bitsPerPixel = channels * bitDepth;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const expected = height * (stride + 1);

  const idat = Buffer.concat(info.chunks.filter((c) => c.type === "IDAT").map((c) => bytes.subarray(c.start, c.start + c.length)));
  let raw;
  try {
    raw = zlib.inflateSync(idat, { maxOutputLength: expected + 64 });
  } catch {
    return { corrupt: true };
  }
  if (raw.length < expected) return { corrupt: true };

  const stepY = Math.max(1, Math.ceil(height / 500));
  const stepX = Math.max(1, Math.ceil(width / 500));
  const counts = new Map();
  let sampled = 0;
  let prev = Buffer.alloc(stride);
  let row = Buffer.alloc(stride);
  const quant = (v) => v >> 3;

  for (let y = 0; y < height; y += 1) {
    const base = y * (stride + 1);
    const filter = raw[base];
    for (let i = 0; i < stride; i += 1) {
      const x = raw[base + 1 + i];
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let value;
      if (filter === 0) value = x;
      else if (filter === 1) value = x + a;
      else if (filter === 2) value = x + b;
      else if (filter === 3) value = x + ((a + b) >> 1);
      else if (filter === 4) value = x + paeth(a, b, c);
      else return { corrupt: true };
      row[i] = value & 0xff;
    }
    if (y % stepY === 0) {
      for (let x = 0; x < width; x += stepX) {
        let key;
        if (bitDepth < 8) {
          const bitOffset = x * bitDepth;
          key = (row[bitOffset >> 3] >> (8 - bitDepth - (bitOffset & 7))) & ((1 << bitDepth) - 1);
        } else {
          const unit = bitDepth === 16 ? 2 : 1;
          const at = x * channels * unit;
          if (colorType === 2 || colorType === 6) {
            key = (quant(row[at]) << 10) | (quant(row[at + unit]) << 5) | quant(row[at + 2 * unit]);
          } else {
            key = quant(row[at]);
          }
          if (colorType === 3) key = row[at];
        }
        const seen = counts.get(key);
        if (seen !== undefined) counts.set(key, seen + 1);
        else if (counts.size < 5000) counts.set(key, 1);
        sampled += 1;
      }
    }
    [prev, row] = [row, prev];
  }
  let top = 0;
  for (const n of counts.values()) if (n > top) top = n;
  return { sampled, distinctColors: counts.size, dominantFraction: sampled ? top / sampled : 1 };
}

// ── JPEG and WebP ──────────────────────────────────────────────────────────

function readJpeg(bytes) {
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = bytes[i + 1];
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break;
    const length = bytes.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 9 > bytes.length) break;
      return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
    }
    i += 2 + length;
  }
  return null;
}

function readWebp(bytes) {
  const kind = bytes.toString("latin1", 12, 16);
  if (kind === "VP8 " && bytes.length >= 30) {
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  if (kind === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    const b = bytes.readUInt32LE(21);
    return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
  }
  if (kind === "VP8X" && bytes.length >= 30) {
    return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
  }
  return null;
}

// ── Evidence from the companion ────────────────────────────────────────────

/** Whether an address is a Microsoft interactive sign-in page. */
export function isSignInUrl(rawUrl) {
  const value = String(rawUrl || "").trim();
  if (!value) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (SIGN_IN_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return true;
    return /\/oauth2\/(?:v2\.0\/)?authorize/i.test(url.pathname);
  } catch {
    return SIGN_IN_HOSTS.some((h) => value.toLowerCase().includes(h));
  }
}

function cleanText(value, max) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Keep the origin and path only: query strings and fragments can carry tokens. */
function safeUrl(value) {
  const text = String(value ?? "").trim().slice(0, 2048);
  if (!text) return "";
  try {
    const url = new URL(text);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return cleanText(text.split(/[?#]/)[0], 200);
  }
}

/** What the setup that ran for a shot reports: step names and outcomes, never page text or addresses. */
export function sanitizeSetupEvidence(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const word = (value, max) => cleanText(value, max);
  return {
    source: word(raw.source, 40),
    steps: (Array.isArray(raw.steps) ? raw.steps : []).slice(0, 16).map((s) => ({
      id: word(s?.id, 24),
      action: word(s?.action, 24),
      status: ["ok", "skipped", "failed"].includes(s?.status) ? s.status : "failed",
      strategy: word(s?.strategy, 24),
      tier: Number.isInteger(s?.tier) ? Math.max(0, Math.min(3, s.tier)) : 0,
      note: word(s?.note, 120),
    })),
    summary: (Array.isArray(raw.summary) ? raw.summary : []).slice(0, 10).map((s) => word(s, 120)).filter(Boolean),
    limitedBy: raw.limitedBy === "practice-agent" ? "practice-agent" : null,
    skipped: (Array.isArray(raw.skipped) ? raw.skipped : []).slice(0, 6).map((s) => word(s, 120)).filter(Boolean),
    practice: raw.practice && typeof raw.practice === "object" ? { name: word(raw.practice.name, 80), reused: raw.practice.reused === true } : null,
    // A recipe that judged its own screen and was not satisfied (or cannot judge it): the picture is kept for a person to check.
    review: raw.review && typeof raw.review === "object" && /^[a-z-]{1,30}$/.test(String(raw.review.code || "")) ? { code: String(raw.review.code), message: word(raw.review.message, 240) } : null,
  };
}

/** What the companion reports about a page from this version on: the page's own signals, and what masking found. Older companions report no `version`. */
export const EVIDENCE_VERSION = 2;

/** The one plain sentence a person reads when a picture arrives without the newer evidence. */
export const OLD_COMPANION_MESSAGE = "Update your Local Capture Companion. Older versions cannot prove the screen, so their pictures are saved for review.";

/** A sign-in call to action as a button or link label: the page offers to sign in, it is not showing a signed-in person. */
const SIGN_IN_ITEM_RE = /^(?:sign in|log in|sign in now)$/i;

/** Bound and clean the evidence the companion reports before anything reads it. */
export function sanitizeEvidence(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const textItems = Array.isArray(raw.visibleText)
    ? raw.visibleText
    : typeof raw.visibleText === "string"
    ? raw.visibleText.split(/\n+/)
    : [];
  const redaction = raw.redaction && typeof raw.redaction === "object" ? raw.redaction : null;
  const count = (value, max = 10000) => (Number.isFinite(Number(value)) ? Math.max(0, Math.min(max, Number(value))) : null);
  const signals = raw.signals && typeof raw.signals === "object" && !Array.isArray(raw.signals) ? raw.signals : null;
  return {
    version: Number.isInteger(raw.version) ? Math.max(1, Math.min(99, raw.version)) : 1,
    finalUrl: safeUrl(raw.finalUrl),
    title: cleanText(raw.title, 200),
    visibleText: textItems.slice(0, 300).map((t) => cleanText(t, 120)).filter(Boolean),
    redaction: redaction
      ? {
          applied: redaction.applied === true,
          masked: Number.isFinite(Number(redaction.masked)) ? Math.max(0, Math.min(10000, Number(redaction.masked))) : 0,
          // Newer companions also say how many account controls and list-type regions (Recent, History) the page had, and how many were hidden.
          controls: count(redaction.controls),
          lists: count(redaction.lists, 200),
          listsMasked: count(redaction.listsMasked, 200),
        }
      : null,
    signals: signals
      ? {
          signInVisible: typeof signals.signInVisible === "boolean" ? signals.signInVisible : null,
          accountControl: typeof signals.accountControl === "boolean" ? signals.accountControl : null,
        }
      : null,
    capturedAt: cleanText(raw.capturedAt, 40),
    // What the companion proved about the harness the page was in (see harness.mjs): absent from an older companion, and never trusted unless it is complete.
    harness: sanitizeHarnessProof(raw.harness),
    executedSteps: Number.isFinite(Number(raw.executedSteps)) ? Math.max(0, Math.min(1000, Number(raw.executedSteps))) : null,
    mode: ["auto", "guided", "legacy", "autonomous"].includes(raw.mode) ? raw.mode : null,
    setup: sanitizeSetupEvidence(raw.setup),
    routeSteps: (Array.isArray(raw.routeSteps) ? raw.routeSteps : []).slice(0, 14).map((step) => ({
      action: cleanText(step?.action, 24),
      label: cleanText(step?.label, 80),
      found: step?.found === true,
      ok: step?.ok === true,
      urlBefore: cleanText(String(step?.urlBefore ?? "").split(/[?#]/)[0], 200),
      urlAfter: cleanText(String(step?.urlAfter ?? "").split(/[?#]/)[0], 200),
      note: cleanText(step?.note, 80),
    })),
  };
}

/**
 * Share of the expected UI labels that appear in the visible text. Labels are cleaned first (typos fixed, stop
 * words, placeholders, and sentences dropped) and matched without caring about case, punctuation, plurals, or a
 * one-letter typo, so a label like "Start building form scratch" still matches a screen that says "Start building
 * from scratch".
 */
export function scoreLabels(expectedLabels, visibleText) {
  const expected = cleanExpectedLabels(expectedLabels, { max: 40 });
  if (!expected.length || !Array.isArray(visibleText) || !visibleText.length) return null;
  const words = visibleWordSet(visibleText);
  const matched = expected.filter((label) => labelIsVisible(label, words));
  return { expected: expected.length, matched: matched.length, score: Math.round((matched.length / expected.length) * 100) / 100, missing: expected.filter((l) => !matched.includes(l)).slice(0, 10) };
}

// ── The check ──────────────────────────────────────────────────────────────

/**
 * Verify image bytes and optional capture evidence.
 *
 * @param {Buffer} bytes
 * @param {object} [options]
 * @param {string} [options.filename] the slot filename; its extension must match the bytes
 * @param {object} [options.evidence] what the companion saw (address, title, visible text)
 * @param {string[]} [options.expectedLabels] UI labels the shot should show (a soft hint when the address matches `expect`)
 * @param {{family: string, scope?: string, paths?: string[], host?: string, label?: string, strict?: boolean}} [options.expect] the screen the plan expects; its address is the main signal
 * @param {boolean} [options.requireEvidence] warn when the page address was not reported
 * @param {boolean} [options.requireProof] the picture is a capture that must prove its screen: a missing landmark, an address that names only the product, or a companion that cannot report the newer evidence is "needs review", never accepted by itself
 * @param {string} [options.productLabel] the product's name, for the sentence "You are not signed in to ..."
 * @param {Partial<typeof IMAGE_LIMITS>} [options.limits]
 * @returns {{ok: boolean, level: "pass"|"warn"|"fail", reasons: Array<{code: string, level: "fail"|"warn", message: string}>, format: string|null, width: number|null, height: number|null, bytes: number, sha256: string|null, analysis: object|null, labels: object|null, evidence: object|null}}
 */
export function verifyImage(bytes, options = {}) {
  const limits = { ...IMAGE_LIMITS, ...(options.limits || {}) };
  const reasons = [];
  const result = {
    ok: false,
    level: "fail",
    reasons,
    format: null,
    width: null,
    height: null,
    bytes: Buffer.isBuffer(bytes) ? bytes.length : 0,
    sha256: null,
    analysis: null,
    labels: null,
    landing: null,
    evidence: null,
  };
  const finish = () => {
    result.level = reasons.some((r) => r.level === "fail") ? "fail" : reasons.length ? "warn" : "pass";
    result.ok = result.level !== "fail";
    return result;
  };

  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    reasons.push(reason("empty", "fail", "No image data was received."));
    return finish();
  }
  if (bytes.length > limits.maxBytes) {
    reasons.push(reason("too-large", "fail", `The image is ${(bytes.length / 1048576).toFixed(1)} MB; the limit is ${Math.round(limits.maxBytes / 1048576)} MB.`));
    return finish();
  }
  const format = detectImageFormat(bytes);
  if (!format) {
    reasons.push(reason("bad-signature", "fail", "The file is not a PNG, JPEG, or WebP image. Its content does not match any supported image type."));
    return finish();
  }
  result.format = format;
  result.sha256 = sha256Hex(bytes);

  const filename = String(options.filename || "");
  if (filename) {
    const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
    if (!extensionsForFormat(format).includes(ext)) {
      reasons.push(reason("extension-mismatch", "fail", `The file content is ${format.toUpperCase()} but the slot name ends in ${ext || "no extension"}. Save it with the matching file type.`));
      return finish();
    }
  }
  // A generated placeholder (the pending image, or a captioned filler picture) is never a screenshot, however big it is.
  if (detectPlaceholder(bytes).placeholder) {
    reasons.push(reason("placeholder", "fail", PLACEHOLDER_MESSAGE));
    return finish();
  }
  if (bytes.length < limits.minBytes) {
    reasons.push(reason("too-small", "fail", `The image is only ${bytes.length} bytes; a real screenshot is at least ${limits.minBytes} bytes. A placeholder does not count.`));
    return finish();
  }

  let dims = null;
  if (format === "png") {
    const parsed = readPng(bytes);
    if (parsed.error) {
      reasons.push(reason("corrupt", "fail", parsed.error));
      return finish();
    }
    const { info } = parsed;
    dims = { width: info.width, height: info.height };
    if (!info.hasEnd) reasons.push(reason("truncated", "fail", "The PNG is cut off before its end marker."));
    if (info.trailingBytes > 0) reasons.push(reason("trailing-data", "fail", "The PNG has extra data after its end marker."));
    for (const chunk of info.chunks) {
      if (/^(?:tEXt|iTXt|zTXt)$/.test(chunk.type) && MARKUP_RE.test(bytes.toString("latin1", chunk.start, chunk.start + Math.min(chunk.length, 4096)))) {
        reasons.push(reason("embedded-markup", "fail", "The image carries embedded script or markup."));
        break;
      }
    }
    result.width = info.width;
    result.height = info.height;
    if (info.width * info.height <= limits.maxPixels && info.width >= 1 && info.height >= 1) {
      const sample = reasons.some((r) => r.level === "fail") ? null : samplePng(bytes, info);
      if (sample?.corrupt) {
        reasons.push(reason("corrupt", "fail", "The PNG image data is corrupt or cut off."));
      } else if (sample) {
        result.analysis = { sampled: sample.sampled, distinctColors: sample.distinctColors, dominantFraction: Math.round(sample.dominantFraction * 10000) / 10000 };
      } else if (!reasons.length) {
        reasons.push(reason("not-analyzed", "warn", "This PNG uses an interlaced or uncommon layout, so the blank-page check was skipped."));
      }
    }
  } else if (format === "jpeg") {
    dims = readJpeg(bytes);
    if (!dims) {
      reasons.push(reason("corrupt", "fail", "The JPEG header is missing or malformed."));
      return finish();
    }
    const tail = bytes.subarray(Math.max(0, bytes.length - 64));
    if (tail.lastIndexOf(Buffer.from([0xff, 0xd9])) === -1) reasons.push(reason("truncated", "warn", "The JPEG may be cut off before its end marker."));
  } else {
    dims = readWebp(bytes);
    if (!dims) {
      reasons.push(reason("corrupt", "fail", "The WebP header is missing or malformed."));
      return finish();
    }
    if (bytes.readUInt32LE(4) + 8 !== bytes.length) reasons.push(reason("truncated", "warn", "The WebP size does not match its header; it may be cut off."));
  }

  result.width = dims.width;
  result.height = dims.height;
  if (dims.width < limits.minWidth || dims.height < limits.minHeight) {
    reasons.push(reason("dimensions-small", "fail", `The image is ${dims.width} x ${dims.height} pixels; the minimum is ${limits.minWidth} x ${limits.minHeight}.`));
  }
  if (dims.width > limits.maxWidth || dims.height > limits.maxHeight || dims.width * dims.height > limits.maxPixels) {
    reasons.push(reason("dimensions-large", "fail", `The image is ${dims.width} x ${dims.height} pixels; the maximum is ${limits.maxWidth} x ${limits.maxHeight} and ${Math.round(limits.maxPixels / 1e6)} megapixels.`));
  }

  if (result.analysis) {
    if (result.analysis.dominantFraction >= limits.blankFail) {
      reasons.push(reason("blank", "fail", "The image is blank or a single color. The page probably did not finish loading."));
    } else if (result.analysis.dominantFraction >= limits.blankWarn) {
      reasons.push(reason("near-uniform", "warn", "The image is almost one color. Check that the page finished loading."));
    }
  } else if (format !== "png") {
    const bitsPerPixel = (bytes.length * 8) / Math.max(1, dims.width * dims.height);
    result.analysis = { bitsPerPixel: Math.round(bitsPerPixel * 1000) / 1000 };
    if (bitsPerPixel < 0.06) reasons.push(reason("blank", "fail", "The image compresses to almost nothing, so it is blank or a single color."));
    else if (bitsPerPixel < 0.16) reasons.push(reason("near-uniform", "warn", "The image is almost one color. Check that the page finished loading."));
  }

  const evidence = sanitizeEvidence(options.evidence);
  result.evidence = evidence;
  if (evidence) {
    if (evidence.finalUrl) {
      if (isSignInUrl(evidence.finalUrl)) {
        reasons.push(reason("sign-in-page", "fail", "The page was a Microsoft sign-in page, not the product. Sign in once in the companion window, then retake the shot."));
      } else if (!/^https?:/i.test(evidence.finalUrl)) {
        reasons.push(reason("not-a-web-page", "fail", "The browser was not on a web page when the shot was taken."));
      }
    } else if (options.requireEvidence) {
      reasons.push(reason("no-page-address", "warn", "The companion did not report which page the screenshot shows."));
    }
    if (SIGN_IN_TITLE_RE.test(evidence.title) && !reasons.some((r) => r.code === "sign-in-page")) {
      reasons.push(reason("sign-in-page", "fail", "The page title says this is a sign-in page, not the product."));
    }
    const signInHits = SIGN_IN_TEXT_RES.filter((re) => evidence.visibleText.some((line) => re.test(line))).length;
    if (signInHits >= 2 && !reasons.some((r) => r.code === "sign-in-page")) {
      reasons.push(reason("sign-in-page", "fail", "The visible text looks like a sign-in page, not the product."));
    }
    // The product's own public page: a Sign in button and no account menu. The product is not showing a signed-in person.
    if (!reasons.some((r) => r.code === "sign-in-page") && signedOutCue(evidence)) {
      reasons.push(reason("signed-out-page", "fail", `You are not signed in to ${cleanText(options.productLabel, 80) || "the product"}. The page shows a Sign in button and no account menu. Sign in once in the companion window, then retake the shot.`));
    }
    result.labels = scoreLabels(options.expectedLabels, evidence.visibleText);
    const landing = assessLanding(evidence.finalUrl, options.expect);
    result.landing = landing;
    const signIn = reasons.some((r) => r.code === "sign-in-page" || r.code === "signed-out-page");
    if (landing.state === "mismatch" && !signIn) {
      reasons.push(reason("wrong-screen", "warn", `This is ${landing.page}, not ${landing.expected}. Retake it with “Retake guided”, or check the agent address in Capture settings.`));
    }
    if (result.labels) {
      const { expected, matched } = result.labels;
      // The address is the main signal. When it matches the screen the plan expects, labels are only a hint, unless the capture has to
      // prove the screen (`requireProof`: a companion's picture is saved as captured only when its landmarks show); when it does not
      // match, the wrong-screen message already says what is wrong. A person who set the screen up themselves (guided) vouches for it.
      const proof = Boolean(options.requireProof) && evidence.mode !== "guided";
      result.labels.soft = landing.state === "match" && !proof;
      if ((landing.state === "unknown" || proof) && (matched === 0 || (expected >= 3 && result.labels.score < 0.34)) && !signIn) {
        const missing = result.labels.missing.slice(0, 3).join(", ");
        reasons.push(reason("labels-missing", "warn", `Only ${matched} of ${expected} expected UI labels are visible${missing ? ` (missing: ${missing})` : ""}. Check that the screen is the one the lab describes.`));
      }
    } else if (options.requireProof && evidence.mode !== "guided" && !signIn && !provesScreenByRoute(landing, options.expect) && !provesScreenBySteps(evidence)) {
      // No expected label could be matched, the address names only a product or a start page, and the computer did not choose anything
      // inside the page: nothing proves which screen this is.
      reasons.push(reason("screen-unproven", "warn", "Nothing on the page proves this is the screen the lab describes: no expected label was visible, and the address only names the product. Check the picture."));
    }
    if (options.requireRedaction && !(evidence.redaction && evidence.redaction.applied)) {
      reasons.push(reason("not-redacted", "warn", "The companion did not report masking account details. Check the screenshot for names and email addresses."));
    }
    if (evidence.redaction && evidence.redaction.applied && Number(evidence.redaction.lists) > Number(evidence.redaction.listsMasked || 0)) {
      reasons.push(reason("list-not-masked", "warn", "This page lists recent items or chats, and the list was not hidden. Check the screenshot for names and titles."));
    }
    if (options.requireProof && evidence.version < EVIDENCE_VERSION) reasons.push(reason("old-companion", "warn", OLD_COMPANION_MESSAGE));
    // The harness the page was proven to be in. Only a companion's picture is judged (`requireProof`): the portal says which harness the slot
    // needs (`expectHarness`), an older companion proves none (saved for review), and a picture taken in the other harness is never saved.
    const wantedHarness = normalizeHarness(options.expectHarness);
    if (options.requireProof && isSpecificHarness(wantedHarness)) {
      if (!evidence.harness) {
        reasons.push(reason("harness-unproven", "warn", `The companion did not prove which harness this picture was taken in, so it is saved for review. Update your Local Capture Companion to ${HARNESS_MIN_COMPANION} or newer.`));
      } else if (evidence.harness.id !== wantedHarness) {
        reasons.push(reason("wrong-harness", "fail", `This picture was taken in the ${HARNESS_LABELS[evidence.harness.id]}, but this screenshot needs the ${HARNESS_LABELS[wantedHarness]}, so it was not saved.`));
      }
    }
    if (evidence.setup?.limitedBy === "practice-agent") {
      reasons.push(reason("needs-practice-agent", "warn", "This shows the screen as far as the computer could take it without a practice agent. Allow a practice agent, then retake it, to capture the final state."));
    }
    if (evidence.setup?.review?.message) reasons.push(reason("recipe-review", "warn", evidence.setup.review.message));
  } else if (options.requireEvidence) {
    reasons.push(reason("no-evidence", "warn", options.requireProof ? OLD_COMPANION_MESSAGE : "The companion did not report what the page showed."));
  }

  return finish();
}

/** Whether the page offers a Sign in button and shows no account: the companion's own reading when it has one, the labels and masking count otherwise. */
export function signedOutCue(evidence) {
  if (!evidence) return false;
  const signals = evidence.signals;
  const signInVisible = signals && typeof signals.signInVisible === "boolean" ? signals.signInVisible : evidence.visibleText.some((line) => SIGN_IN_ITEM_RE.test(line));
  if (!signInVisible) return false;
  if (signals && typeof signals.accountControl === "boolean") return signals.accountControl === false;
  const controls = evidence.redaction ? (Number.isFinite(evidence.redaction.controls) ? evidence.redaction.controls : evidence.redaction.masked) : null;
  return controls === 0;
}

/** An address proves a screen only when it names that screen: a Copilot Studio page of its own, not "somewhere on this host" and not the agent's default page. */
function provesScreenByRoute(landing, expect) {
  if (!expect || landing?.state !== "match" || expect.strict === false) return false;
  if (expect.family !== "copilot-studio") return false;
  const paths = Array.isArray(expect.paths) ? expect.paths : [];
  if (!paths.length) return false;
  return expect.scope === "environment" || !paths.includes("overview");
}

const PASSIVE_STEP_ACTIONS = new Set(["screenshot", "verify", "wait-for"]);

/**
 * Whether the computer chose something inside the page (a tab, a menu, a dialog, a question) and each choice was confirmed by what the page
 * then showed. The setup steps and the route steps both only pass when their expected evidence is on the page, so a start page that was
 * photographed with nothing chosen (no step at all) never counts.
 */
function provesScreenBySteps(evidence) {
  const setup = Array.isArray(evidence.setup?.steps) ? evidence.setup.steps : [];
  if (setup.some((step) => step.status === "ok" && !PASSIVE_STEP_ACTIONS.has(step.action)) && !setup.some((step) => step.status === "failed")) return true;
  const route = Array.isArray(evidence.routeSteps) ? evidence.routeSteps : [];
  return route.some((step) => step.ok && step.found && !step.urlBefore && !PASSIVE_STEP_ACTIONS.has(step.action));
}

/** A short, storable summary of a verification result (no bytes, no evidence text). */
export function summarizeVerification(result, extra = {}) {
  return {
    ok: result.ok,
    level: result.level,
    reasons: result.reasons.map((r) => ({ code: r.code, level: r.level, message: r.message })),
    format: result.format,
    width: result.width,
    height: result.height,
    bytes: result.bytes,
    sha256: result.sha256,
    analysis: result.analysis,
    labels: result.labels,
    landing: result.landing ? { state: result.landing.state, page: result.landing.page, expected: result.landing.expected } : null,
    capture: result.evidence?.mode ? { mode: result.evidence.mode, steps: result.evidence.routeSteps || [], setup: result.evidence.setup || null } : null,
    finalUrl: result.evidence?.finalUrl || null,
    pageTitle: result.evidence?.title || null,
    redaction: result.evidence?.redaction || null,
    // What the companion could say about the page (see EVIDENCE_VERSION): the version, and the sign-in and account signals it read.
    ...(result.evidence ? { evidenceVersion: result.evidence.version || 1, ...(result.evidence.signals ? { signals: result.evidence.signals } : {}) } : {}),
    // The harness the companion proved the page was in (a complete proof only). Named apart from `harness`, which is the picture's saved stamp.
    ...(result.evidence?.harness?.id ? { harnessSeen: { id: result.evidence.harness.id, ...(result.evidence.harness.wanted ? { wanted: result.evidence.harness.wanted } : {}) } } : {}),
    checkedAt: new Date().toISOString(),
    ...extra,
  };
}
