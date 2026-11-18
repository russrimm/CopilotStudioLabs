/**
 * Placeholder-picture detection for the portal.
 *
 * A placeholder is any picture that stands in for a screenshot without being one: the neutral "Screenshot pending"
 * image, and the captioned filler pictures older scripts wrote into labs/. File size never decides it. The one
 * implementation lives in tools/screenshot-capture/placeholder-detect.mjs so the Local Capture Companion, which
 * cannot import from portal/, runs exactly the same checks; this module is the portal's import path for it.
 *
 *   detectPlaceholder(bytesOrPath)  ->  { placeholder, reason, confidence, label?, sha256? }
 *
 * The signals (marker, known hash, layout signature, pending image) and how to add a new known placeholder are
 * documented in docs/lab-builder.md section 6 and at the top of the tools file.
 */

export {
  KNOWN_PLACEHOLDER_SHA256,
  MAX_PLACEHOLDER_BYTES,
  PLACEHOLDER_MARKER,
  PLACEHOLDER_MESSAGE,
  PLACEHOLDER_REASONS,
  detectPlaceholder,
  detectPlaceholderLayout,
  isPlaceholder,
  isPlaceholderImage,
} from "../../../tools/screenshot-capture/placeholder-detect.mjs";
