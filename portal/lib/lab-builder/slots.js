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
import { stepLeadSentence } from "./sub-steps.js";

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
    kind: meta?.kind || (SLOT_KINDS.includes(slot.kind) ? slot.kind : "ui-location"),
    caption: meta?.caption || plain(slot.caption || fallback),
    alt: meta?.alt || slot.alt || `${fallback}.`,
    curated: Boolean(meta),
  };
}

const STEP_LINK = /\[([^\]]+)\]\([^)]*\)/g;

/** One step as plain words for a capture instruction: no emphasis, no link targets, cut at a word. */
function stepWords(step, max = 170) {
  // Only the step's own sentence: a capture instruction points at the screen, not at the step's list of choices.
  const text = plain(stepLeadSentence(step).replace(STEP_LINK, "$1")).replace(/^\[Unverified\]\s*/, "");
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 60 ? cut.lastIndexOf(" ") : max).replace(/[\s,;:(-]+$/, "")}`;
}

/**
 * Slots for a topic that came from Microsoft Learn and has none in the catalog: where its procedure starts and
 * what it ends on, written from the steps read from its article. Nothing is guessed about the screen itself,
 * so the instructions point at the lab's own first and last step. Empty when no procedure could be read.
 *
 * @param {object} feature
 * @param {{source?: string, steps?: string[]}|null} derived the step record for the feature
 */
export function derivedSlotsForTopic(feature, derived) {
  if (!feature?.learnTopic || slotsForFeature(feature).length) return [];
  const steps = Array.isArray(derived?.steps) ? derived.steps : [];
  if (derived?.source !== "doc-derived" || steps.length < 2) return [];
  const title = plain(feature.name);
  const product = productOf(feature) === "copilot-studio" ? {} : { product: productOf(feature) };
  return [
    {
      filename: `${feature.id}-start.png`,
      section: "learn",
      ...product,
      kind: "ui-location",
      caption: `Where "${title}" starts`,
      alt: `The screen where the "${title}" procedure starts, with the control named in its first step visible.`,
      instructions: [`Follow step 1 of this module: ${stepWords(steps[0])}`, "Stop on the screen it opens and capture it."],
    },
    {
      filename: `${feature.id}-result.png`,
      section: "learn",
      ...product,
      kind: "after",
      caption: `The result of "${title}"`,
      alt: `The screen after the last step of "${title}", showing the result of the procedure.`,
      instructions: ["Complete every numbered step of this module.", `Capture the screen after the last step: ${stepWords(steps[steps.length - 1])}`],
    },
  ];
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
