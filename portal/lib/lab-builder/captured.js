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
 *   3. the per-user folder (`%LOCALAPPDATA%\CopilotStudioLabsPortal\screenshots` on Windows and its macOS and Linux
 *      equivalents), outside the repository and outside OneDrive
 *   4. the baked `docs/feature-tour/screenshots` (the committed fallback, never written to)
 * Reads search every location, best first, so an image captured once serves
 * every lab; writes go to the first (see `capturedScreenshotsDir`).
 */

import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

import { isSpecificHarness, normalizeHarness, taggedName } from "../../../tools/screenshot-capture/harness.mjs";
import { resolveCapturedScreenshotsDir, resolveCapturedScreenshotsSearchDirs } from "../storage-config.js";
import { reusePictureVerdict } from "./picture-guard.js";
import { isPlaceholder } from "./placeholder-detect.js";
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
 * Whether `bytes` are a real screenshot of the type `ext` names: at least the minimum size, the right image format,
 * and not a placeholder picture. The size alone never proves it, because the generated placeholders weigh about 20 KB.
 */
export function isRealScreenshotBytes(bytes, ext) {
  return bytes.length >= MIN_CAPTURED_BYTES && hasSignature(bytes, ext) && !isPlaceholder(bytes);
}

/**
 * The captured image for a slot filename, or null when it is missing, a stub
 * smaller than a real screenshot, a placeholder picture, or not an image of its
 * claimed type. `dir` is one folder or a list searched in order.
 *
 * `harness`: a picture of a slot that needs a harness is saved under a name that carries it (see `taggedName`), so a
 * Standard (Classic) picture and a Microsoft Copilot picture can never stand in for each other. With a harness only the tagged
 * name is read; a file with the plain name is a picture from before harnesses were recorded and is never used for that slot.
 * Without one, the name is read as it is.
 */
export function capturedImage(dir, filename, { harness = null } = {}) {
  if (!SAFE_NAME.test(String(filename)) || String(filename).includes("..")) return null;
  const name = isSpecificHarness(harness) ? taggedName(filename, harness) : filename;
  for (const candidate of asDirList(dir)) {
    const file = path.join(candidate, name);
    try {
      const bytes = fs.readFileSync(file);
      if (!isRealScreenshotBytes(bytes, path.extname(name).toLowerCase())) continue;
      return { file, size: bytes.length, dir: candidate, name };
    } catch {
      // Try the next location.
    }
  }
  return null;
}

// ── Which harness a lab's own picture shows ────────────────────────────────

const sha256OfFile = (file) => {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
};

const recordsCache = new Map();

/** A lab's saved picture checks (`screenshots/verification.json`), re-read only when the file changed. */
function readLabRecords(labDir) {
  const file = path.join(path.resolve(labDir), "screenshots", "verification.json");
  try {
    const info = fs.statSync(file);
    const key = `${info.size}:${info.mtimeMs}`;
    const hit = recordsCache.get(file);
    if (hit && hit.key === key) return hit.shots;
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const shots = raw && typeof raw.shots === "object" && raw.shots ? raw.shots : {};
    if (recordsCache.size > 200) recordsCache.clear();
    recordsCache.set(file, { key, shots });
    return shots;
  } catch {
    return {};
  }
}

/**
 * The harness a lab's own picture was taken in, or null when nothing was recorded for these exact bytes. Two things prove it: the
 * picture's saved check carries a harness stamp and belongs to these bytes, or the picture is the very picture the shared library holds
 * under the harness's name. A stamp never follows a picture that was replaced by hand.
 */
export function labPictureHarness(labDir, filename, { capturedDir = null, need = null } = {}) {
  const file = path.join(path.resolve(labDir), "assets", filename);
  const record = readLabRecords(labDir)[filename];
  const stamped = normalizeHarness(record?.harness?.id);
  if (stamped && record?.sha256 && record.sha256 === sha256OfFile(file)) return stamped;
  if (capturedDir && isSpecificHarness(need)) {
    const shared = capturedImage(capturedDir, filename, { harness: need });
    if (shared && sha256OfFile(shared.file) === sha256OfFile(file)) return normalizeHarness(need);
  }
  return null;
}

let labSlotHarnessResolver = null;

/** The lab builder registers how a lab's slot is looked up (its needed harness), so a lookup that is given no harness can still find it. */
export function setLabSlotHarnessResolver(fn) {
  labSlotHarnessResolver = typeof fn === "function" ? fn : null;
}

function inferSlotHarness(labDir, filename) {
  try {
    return labDir && labSlotHarnessResolver ? normalizeHarness(labSlotHarnessResolver(path.resolve(labDir), filename)) : null;
  } catch {
    return null;
  }
}

/**
 * The shared library's picture for one slot of a lab: read under the harness the lab's slot needs (looked up from the lab's own shot
 * list unless given), so the other harness's picture, or one from before harnesses were recorded, is never found.
 */
export function sharedImageForSlot(labDir, filename, { capturedDir = capturedScreenshotsDirs(), harness = undefined } = {}) {
  const need = harness === undefined ? inferSlotHarness(labDir, filename) : normalizeHarness(harness);
  return capturedImage(capturedDir, filename, { harness: need });
}

/**
 * Resolve a real captured screenshot for a specific generated lab:
 *   1. `generated-labs/<labId>/assets/<filename>` when a real image (>= 5 KB, not a placeholder) exists there
 *   2. The shared library (persistent folder first, then the baked `docs/feature-tour/screenshots`)
 *   3. `null` when only a placeholder (the "Screenshot pending" image or a captioned filler picture) or nothing is present
 *
 * A slot that needs a harness (`harness`, or looked up from the lab's own shot list) is never filled by a picture of the other harness:
 * a lab picture stamped with another harness is ignored, and the library is read under the harness's name only. A lab picture with no
 * stamp (made before harnesses were recorded) is still returned, with `harness: null`, so the lab keeps showing it until a person says
 * which harness it shows; the Screenshot Center lists it as "Harness not recorded".
 */
export function resolveLabScreenshot(labDir, filename, { capturedDir = capturedScreenshotsDirs(), harness = undefined } = {}) {
  if (!SAFE_NAME.test(String(filename)) || String(filename).includes("..")) return null;
  const need = harness === undefined ? inferSlotHarness(labDir, filename) : normalizeHarness(harness);
  if (labDir) {
    const perLab = capturedImage(path.join(path.resolve(labDir), "assets"), filename);
    if (perLab) {
      const has = isSpecificHarness(need) ? labPictureHarness(labDir, filename, { capturedDir, need }) : null;
      if (!(isSpecificHarness(need) && has && has !== need)) return { ...perLab, source: "lab", harness: has };
    }
  }
  if (capturedDir) {
    const shared = capturedImage(capturedDir, filename, { harness: need });
    // A shared picture the portal knows shows the wrong screen is not shown in a lab (it stays pending), so one bad picture never spreads.
    if (shared && reusePictureVerdict(shared.file, { forDisplay: true }).ok !== false) return { ...shared, source: "shared", harness: isSpecificHarness(need) ? need : null };
  }
  return null;
}
