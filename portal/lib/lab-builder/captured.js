/**
 * Captured screenshots from the feature tour and the Screenshot Center.
 *
 * Every real screenshot lives in one shared library under the same filename the
 * lab builder's catalog uses for that slot. A generated lab uses a captured
 * image when one exists there and keeps the "Screenshot pending" placeholder
 * when it does not, so capturing never needs a code or Markdown edit.
 *
 * The library resolves in this order:
 *   1. `FEATURE_TOUR_SCREENSHOTS_DIR` (exclusive; for previews and tests)
 *   2. `${PORTAL_STORAGE_ROOT}/screenshots` (persistent, mirrored to Azure Blob)
 *   3. the baked `docs/feature-tour/screenshots` (the committed fallback)
 * Reads search every location, best first, so an image captured once serves
 * every lab; writes go to the first (see `capturedScreenshotsDir`).
 */

import fs from "node:fs";
import path from "node:path";

import { resolveCapturedScreenshotsDir, resolveCapturedScreenshotsSearchDirs } from "../storage-config.js";
import { MIN_CAPTURED_BYTES } from "./slots.js";

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpe?g|webp)$/i;
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The folder new captures are written to (persistent when configured, otherwise the baked folder). */
export function capturedScreenshotsDir(env = process.env) {
  return resolveCapturedScreenshotsDir(env);
}

/** Every folder a captured image may be read from, best first. */
export function capturedScreenshotsDirs(env = process.env) {
  return resolveCapturedScreenshotsSearchDirs(env);
}

function hasSignature(bytes, ext) {
  if (ext === ".png") return PNG.every((b, i) => bytes[i] === b);
  if (ext === ".jpg" || ext === ".jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP";
}

function asDirList(dir) {
  return (Array.isArray(dir) ? dir : [dir]).filter(Boolean);
}

/**
 * The captured image for a slot filename, or null when it is missing, a stub
 * smaller than a real screenshot, or not an image of its claimed type. `dir`
 * is one folder or a list searched in order.
 */
export function capturedImage(dir, filename) {
  if (!SAFE_NAME.test(String(filename)) || String(filename).includes("..")) return null;
  for (const candidate of asDirList(dir)) {
    const file = path.join(candidate, filename);
    try {
      const bytes = fs.readFileSync(file);
      if (bytes.length < MIN_CAPTURED_BYTES || !hasSignature(bytes, path.extname(filename).toLowerCase())) continue;
      return { file, size: bytes.length, dir: candidate };
    } catch {
      // Try the next location.
    }
  }
  return null;
}

/**
 * Resolve a real captured screenshot for a specific generated lab:
 *   1. `generated-labs/<labId>/assets/<filename>` when a real image (>= 5 KB) exists there
 *   2. The shared library (persistent folder first, then the baked `docs/feature-tour/screenshots`)
 *   3. `null` when only the "Screenshot pending" placeholder or nothing is present
 */
export function resolveLabScreenshot(labDir, filename, { capturedDir = capturedScreenshotsDirs() } = {}) {
  if (!SAFE_NAME.test(String(filename)) || String(filename).includes("..")) return null;
  if (labDir) {
    const perLab = capturedImage(path.join(path.resolve(labDir), "assets"), filename);
    if (perLab) return { ...perLab, source: "lab" };
  }
  if (capturedDir) {
    const shared = capturedImage(capturedDir, filename);
    if (shared) return { ...shared, source: "shared" };
  }
  return null;
}
