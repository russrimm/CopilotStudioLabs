// Detects which feature screenshots exist. A shot counts as captured only when
// the file is a real image of plausible size, the same bar capture.js applies
// when it verifies a save, so a stub never replaces the pending placeholder.

import fs from "node:fs";
import path from "node:path";

export const MIN_IMAGE_BYTES = 5 * 1024;
export const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function hasSignature(bytes, ext) {
  if (ext === ".png") return PNG_SIGNATURE.every((b, i) => bytes[i] === b);
  if (ext === ".jpg" || ext === ".jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (ext === ".webp") return bytes.slice(0, 4).toString("latin1") === "RIFF" && bytes.slice(8, 12).toString("latin1") === "WEBP";
  return false;
}

export function pngSize(bytes) {
  if (bytes.length < 24 || !PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

export function sidecarName(filename) {
  return `${filename.replace(/\.[^.]+$/, "")}.callouts.json`;
}

function isRect(r) {
  return (
    r &&
    ["x", "y", "w", "h"].every((k) => typeof r[k] === "number" && Number.isFinite(r[k])) &&
    r.w > 0 &&
    r.h > 0 &&
    r.x >= 0 &&
    r.y >= 0 &&
    r.x + r.w <= 1.0001 &&
    r.y + r.h <= 1.0001
  );
}

export function readSidecar(dir, filename) {
  const file = path.join(dir, sidecarName(filename));
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || !Array.isArray(parsed.callouts)) return null;
    const rects = new Map();
    for (const c of parsed.callouts) {
      if (Number.isInteger(c?.n) && isRect(c.rect)) rects.set(c.n, { x: c.rect.x, y: c.rect.y, w: c.rect.w, h: c.rect.h });
    }
    return rects;
  } catch {
    return null;
  }
}

export function inspectScreenshot(dir, filename) {
  const ext = path.extname(filename).toLowerCase();
  const file = path.join(dir, filename);
  if (!IMAGE_EXTENSIONS.has(ext) || path.basename(filename) !== filename) {
    return { status: "pending", reason: "invalid-filename" };
  }
  if (!fs.existsSync(file)) return { status: "pending", reason: "missing" };
  const bytes = fs.readFileSync(file);
  if (bytes.length < MIN_IMAGE_BYTES) return { status: "pending", reason: "too-small", bytes: bytes.length };
  if (!hasSignature(bytes, ext)) return { status: "pending", reason: "not-an-image", bytes: bytes.length };
  const size = ext === ".png" ? pngSize(bytes) : null;
  return {
    status: "ready",
    bytes: bytes.length,
    width: size?.width ?? null,
    height: size?.height ?? null,
    rects: readSidecar(dir, filename),
  };
}
