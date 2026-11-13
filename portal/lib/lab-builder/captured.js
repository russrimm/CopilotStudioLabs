/**
 * Captured screenshots from the feature tour.
 *
 * tools/screenshot-capture writes every real screenshot to
 * docs/feature-tour/screenshots, whatever the product, under the same filename
 * the lab builder's catalog uses for that slot. A generated lab uses a captured
 * image when one exists there and keeps the "Screenshot pending" placeholder
 * when it does not, so capturing never needs a code or Markdown edit.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MIN_CAPTURED_BYTES } from "./slots.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = path.resolve(__dirname, "../../../docs/feature-tour/screenshots");
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpe?g|webp)$/i;
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The folder captured screenshots live in. FEATURE_TOUR_SCREENSHOTS_DIR overrides it (for previews and tests). */
export function capturedScreenshotsDir(env = process.env) {
  return env.FEATURE_TOUR_SCREENSHOTS_DIR ? path.resolve(env.FEATURE_TOUR_SCREENSHOTS_DIR) : DEFAULT_DIR;
}

function hasSignature(bytes, ext) {
  if (ext === ".png") return PNG.every((b, i) => bytes[i] === b);
  if (ext === ".jpg" || ext === ".jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP";
}

/**
 * The captured image for a slot filename, or null when it is missing, a stub
 * smaller than a real screenshot, or not an image of its claimed type.
 */
export function capturedImage(dir, filename) {
  if (!SAFE_NAME.test(String(filename)) || String(filename).includes("..")) return null;
  const file = path.join(dir, filename);
  try {
    const bytes = fs.readFileSync(file);
    if (bytes.length < MIN_CAPTURED_BYTES || !hasSignature(bytes, path.extname(filename).toLowerCase())) return null;
    return { file, size: bytes.length };
  } catch {
    return null;
  }
}
