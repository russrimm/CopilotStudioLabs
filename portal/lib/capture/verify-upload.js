/**
 * Strict server-side validation for every screenshot that reaches the portal,
 * whether the Local Capture Companion uploaded it or a person pasted it.
 *
 * The image bytes decide everything: format comes from magic bytes (never the
 * Content-Type header or the file name), size, dimensions, blank-page detection,
 * and the file name allowlist all run here. Evidence the companion reports
 * (final address, title, visible text) can only add failures or warnings.
 */

import { isValidScreenshotFilename } from "../lab-builder/lab-screenshots.js";
import {
  EVIDENCE_VERSION,
  IMAGE_LIMITS,
  OLD_COMPANION_MESSAGE,
  isSignInUrl,
  sanitizeEvidence,
  scoreLabels,
  summarizeVerification,
  verifyImage,
} from "../../../tools/screenshot-capture/image-verify.mjs";

export { EVIDENCE_VERSION, IMAGE_LIMITS, OLD_COMPANION_MESSAGE, isSignInUrl, sanitizeEvidence, scoreLabels, summarizeVerification };

/** Largest image body the portal accepts (PNG, JPEG, or WebP). */
export const MAX_UPLOAD_BYTES = IMAGE_LIMITS.maxBytes;

const UPLOAD_EXTENSIONS = /\.(?:png|jpe?g|webp)$/i;

/** A slot filename the portal will write: the lab builder's rules, minus GIF, at most 128 characters. */
export function isSafeUploadFilename(name) {
  const value = String(name ?? "");
  return value.length <= 128 && isValidScreenshotFilename(value) && UPLOAD_EXTENSIONS.test(value) && !/[\\/\0]/.test(value);
}

/**
 * Verify one upload.
 *
 * @returns {{ok: boolean, level: "pass"|"warn"|"fail", reasons: Array<{code: string, level: string, message: string}>, format: string|null, width: number|null, height: number|null, bytes: number, sha256: string|null, analysis: object|null, labels: object|null, evidence: object|null}}
 */
export function verifyUpload({ bytes, filename, evidence = null, expectedLabels = [], expect = null, requireEvidence = false, requireRedaction = false, requireProof = false, productLabel = "", expectHarness = null, limits } = {}) {
  if (!isSafeUploadFilename(filename)) {
    return {
      ok: false,
      level: "fail",
      reasons: [{ code: "bad-filename", level: "fail", message: "The file name is not a valid screenshot name (letters, digits, dot, dash, and underscore; PNG, JPEG, or WebP)." }],
      format: null,
      width: null,
      height: null,
      bytes: Buffer.isBuffer(bytes) ? bytes.length : 0,
      sha256: null,
      analysis: null,
      labels: null,
      evidence: null,
    };
  }
  return verifyImage(bytes, { filename, evidence, expectedLabels, expect, requireEvidence, requireRedaction, requireProof, productLabel, expectHarness, limits });
}
