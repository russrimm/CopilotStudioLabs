/**
 * Screenshot slots: where a generated lab shows a screenshot, and the alt text
 * and caption that go with it.
 *
 * A slot's definition (filename, section, capture instructions) comes from the
 * feature catalog. Features the catalog gives none, such as the Microsoft
 * Copilot harness features, take their slots from the feature tour overlay
 * (tools/feature-tour/overlay.json) when that file is present, so the lab
 * builder and the feature tour capture the same shots. The alt text, caption,
 * and kind for every slot live in screenshot-slots.json.
 *
 * Alt text is written before the screenshot exists, so a lab is accessible the
 * moment it is generated and the capture tool can fill the image in later
 * without anyone editing the lab.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getProduct, productOf } from "./products.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SLOTS_PATH = path.join(__dirname, "screenshot-slots.json");
const OVERLAY_PATH = path.resolve(__dirname, "../../../tools/feature-tour/overlay.json");

export const PLACEHOLDER_PATH = path.join(__dirname, "assets", "screenshot-pending.png");
/** Same bar as tools/screenshot-capture: smaller than this is a stub, so the shot is still pending. */
export const MIN_CAPTURED_BYTES = 5 * 1024;
export const SLOT_KINDS = ["ui-location", "dialog", "settings", "before", "after", "test-result", "error-state"];

let cachedMeta = null;
let cachedOverlay;

export function getSlotMeta() {
  if (!cachedMeta) cachedMeta = JSON.parse(fs.readFileSync(SLOTS_PATH, "utf8")).slots || {};
  return cachedMeta;
}

function overlayShots() {
  if (cachedOverlay === undefined) {
    try {
      cachedOverlay = JSON.parse(fs.readFileSync(OVERLAY_PATH, "utf8")).shots || {};
    } catch {
      cachedOverlay = {};
    }
  }
  return cachedOverlay;
}

/** The slots a feature carries: its own, or the feature tour's when it has none. */
export function slotsForFeature(feature) {
  if (feature?.screenshots?.length) return feature.screenshots;
  return overlayShots()[feature?.id] || [];
}

/** Remove Markdown emphasis so instruction text reads as plain words. */
function plain(text) {
  return String(text).replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Alt text, caption, and kind for a slot. Falls back to wording derived from
 * the slot's own caption or first instruction so a lab never ships an image
 * with no description, though validateScreenshotSlots() keeps the curated entry
 * required for every slot in the shipped catalog.
 */
export function describeSlot(feature, slot) {
  const meta = getSlotMeta()[slot.filename];
  const fallback = plain(slot.caption || slot.instructions?.[0] || `${feature.name} in ${getProduct(productOf(feature))?.shortName || "the product"}`).replace(/\.$/, "");
  return {
    kind: meta?.kind || "ui-location",
    caption: meta?.caption || plain(slot.caption || fallback),
    alt: meta?.alt || `${fallback}.`,
    curated: Boolean(meta),
  };
}

const NAME_LIKE = /\.(?:png|jpe?g|gif|webp|svg)\b/i;
const LEADING_FILLER = /^(?:an?\s+|the\s+)?(?:screenshot|screen shot|image|picture|photo|graphic|icon)(?:\s+(?:of|showing|that shows))?\b/i;
const COLOR_ONLY = /\b(?:red|green|yellow|orange|purple|pink)\b/i;
const GENERIC = new Set(["image", "img", "screenshot", "screen", "picture", "photo", "figure", "diagram", "click here", "here"]);

/**
 * Problems with one alt text, for a non-decorative image. An empty alt is only
 * correct for a purely decorative image, which a lab screenshot never is.
 */
export function altProblems(alt) {
  const text = String(alt ?? "").trim();
  if (!text) return ["alt text is empty"];
  const problems = [];
  const words = text.split(/\s+/).length;
  if (GENERIC.has(text.toLowerCase())) problems.push("alt text is generic");
  if (words < 4) problems.push("alt text is too short to say what the image shows");
  if (text.length > 250) problems.push("alt text is longer than 250 characters; move detail into the caption");
  if (LEADING_FILLER.test(text)) problems.push('alt text should not start with "Screenshot of" or "Image of"');
  if (NAME_LIKE.test(text)) problems.push("alt text looks like a file name");
  if (COLOR_ONLY.test(text)) problems.push("alt text names a color; describe the text or state instead");
  return problems;
}

/**
 * Check every slot in the catalog (and in the feature tour overlay, when
 * present) against screenshot-slots.json.
 *
 * @param {{features: object[], meta?: object, overlay?: object}} input
 */
export function validateScreenshotSlots({ features, meta = getSlotMeta(), overlay = overlayShots() }) {
  const problems = [];
  const seen = new Set();
  const all = [];
  for (const feature of features) {
    for (const slot of feature.screenshots || []) all.push([feature.id, slot]);
  }
  for (const [featureId, slots] of Object.entries(overlay)) {
    for (const slot of slots) all.push([featureId, slot]);
  }

  for (const [featureId, slot] of all) {
    seen.add(slot.filename);
    const entry = meta[slot.filename];
    if (!entry) {
      problems.push(`${featureId}: slot ${slot.filename} has no entry in screenshot-slots.json`);
      continue;
    }
    if (!SLOT_KINDS.includes(entry.kind)) problems.push(`${slot.filename}: kind must be one of ${SLOT_KINDS.join(", ")}`);
    if (!entry.caption?.trim()) problems.push(`${slot.filename}: needs a caption`);
    for (const problem of altProblems(entry.alt)) problems.push(`${slot.filename}: ${problem}`);
    if (entry.alt && entry.caption && entry.alt.trim() === entry.caption.trim()) {
      problems.push(`${slot.filename}: alt text repeats the caption; say more about what the image shows`);
    }
  }
  for (const filename of Object.keys(meta)) {
    if (!seen.has(filename)) problems.push(`screenshot-slots.json: ${filename} matches no slot`);
  }
  return problems;
}
