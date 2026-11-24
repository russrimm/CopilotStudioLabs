/**
 * The "Screenshot to add" card.
 *
 * A picture that has not been captured yet used to show as a loud grey "SCREENSHOT PENDING" image. In the
 * portal preview and in the standalone HTML a pending picture is now a small, calm card instead: what the
 * picture should show (its alt text) and the steps that produce it (the slot's instructions from shots.json).
 * The Markdown, Word, and PowerPoint files keep the neutral placeholder picture, because those formats cannot
 * run the check that tells a capture from a placeholder when the lab is opened.
 *
 * The check lives with the caller, which already decides pending from the file on disk each time a lab is read;
 * this module only reads the slot details and draws the card.
 */

import fs from "node:fs";
import path from "node:path";

import { harnessLabel } from "../../../tools/screenshot-capture/harness.mjs";
import { withShotHarness } from "./lab-harness.js";

const MAX_STEPS = 6;

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** `**bold**` and `` `code` `` in a slot instruction, as escaped HTML. */
function inline(value) {
  return escapeHtml(value)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

/** The slot details for every picture of a lab, by file name. Empty when the lab has no shot list. */
export function loadShotSlots(labDir) {
  const slots = new Map();
  for (const rel of ["shots.json", path.join("screenshots", "shots.json")]) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(labDir, rel), "utf8"));
    } catch {
      continue;
    }
    // The harness each picture needs is worked out from the lab's harness, so a lab saved before it was recorded gets it too.
    if (rel !== "shots.json" && parsed && typeof parsed === "object") withShotHarness(parsed);
    for (const shot of Array.isArray(parsed?.shots) ? parsed.shots : []) {
      const name = typeof shot?.filename === "string" ? shot.filename : "";
      if (!name || slots.has(name)) continue;
      slots.set(name, {
        alt: typeof shot.alt === "string" ? shot.alt : "",
        caption: typeof shot.caption === "string" ? shot.caption : "",
        figure: typeof shot.figure === "string" ? shot.figure : "",
        harness: typeof shot.harness === "string" ? shot.harness : "",
        instructions: (Array.isArray(shot.instructions) ? shot.instructions : []).filter((x) => typeof x === "string" && x.trim()).slice(0, MAX_STEPS),
      });
    }
    if (slots.size) break;
  }
  return slots;
}

/**
 * The card for one pending picture.
 * @param {string} filename the picture's file name (kept as data-shot so tests and tools can find it)
 * @param {{alt?: string, caption?: string, figure?: string, harness?: string, instructions?: string[]}|null} slot
 * @param {string} [altText] the alt text from the Markdown, used when there is no slot
 */
export function pendingShotCardHtml(filename, slot, altText = "") {
  const shows = (slot?.alt || altText || "").trim();
  const steps = slot?.instructions || [];
  const figure = slot?.figure ? ` <span class="lab-shot-card-figure">Figure ${escapeHtml(slot.figure)}</span>` : "";
  const label = shows ? `Screenshot to add: ${shows}` : "Screenshot to add";
  // The harness the picture must be taken in, in words (a product with no harnesses has none).
  const harness = slot?.harness ? harnessLabel(slot.harness) : "";
  return (
    `<figure class="shot-pending lab-shot-card" data-shot="${escapeHtml(filename)}" role="group" aria-label="${escapeHtml(label)}">` +
    `<span class="lab-shot-card-label"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><path d="M4 7a2 2 0 0 1 2-2h2.2l1.2-1.5h5.2L15.8 5H18a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="1.6"/></svg> Screenshot to add${figure}</span>` +
    (harness ? `<span class="lab-shot-card-harness"><strong>Harness:</strong> ${escapeHtml(harness)}</span>` : "") +
    (shows ? `<span class="lab-shot-card-shows"><strong>It should show:</strong> ${inline(shows)}</span>` : "") +
    (steps.length
      ? `<span class="lab-shot-card-how"><strong>How to capture it:</strong></span><ol class="lab-shot-card-steps">${steps.map((step) => `<li>${inline(step)}</li>`).join("")}</ol>`
      : "") +
    `</figure>`
  );
}

const WRAPPED_IMG = /<p>\s*(<img\b[^>]*>)\s*<\/p>/gi;
const IMG = /<img\b[^>]*>/gi;

/**
 * Replace each pending picture in rendered HTML with its card.
 * @param {string} html
 * @param {(tag: string) => ({filename: string, slot: object|null, alt: string}|null)} pendingFor
 *   returns the details when the picture the tag points at is still pending, otherwise null (the tag stays)
 */
export function replacePendingPictures(html, pendingFor) {
  const swap = (tag) => {
    const found = pendingFor(tag);
    return found ? pendingShotCardHtml(found.filename, found.slot, found.alt) : null;
  };
  return String(html)
    .replace(WRAPPED_IMG, (whole, tag) => swap(tag) ?? whole)
    .replace(IMG, (tag) => swap(tag) ?? tag);
}

/** The alt text of an `<img>` tag, unescaped for the entities this app writes. */
export function altOfTag(tag) {
  const match = /\balt="([^"]*)"/i.exec(tag);
  return match ? match[1].replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&") : "";
}

/** Card styles; a block of CSS that works in the portal preview and in the standalone lab (custom properties have fallbacks). */
export const PENDING_SHOT_CSS = `
.lab-shot-card {
  display: block;
  margin: 14px 0;
  padding: 14px 16px;
  border: 1px dashed var(--border-strong, #5b6b8c);
  border-radius: 10px;
  background: var(--surface-muted, #f8fafc);
  color: var(--text, #1f2937);
  font-size: 0.95rem;
  line-height: 1.55;
  break-inside: avoid;
  page-break-inside: avoid;
}
.lab-shot-card > span { display: block; }
.lab-shot-card-label {
  display: flex !important;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
  font-weight: 600;
  color: var(--text-muted, #526077);
}
.lab-shot-card-figure { font-weight: 400; margin-left: 6px; }
.lab-shot-card-how { margin-top: 8px; }
.lab-shot-card-steps { margin: 4px 0 0; padding-left: 22px; }
.lab-shot-card-steps li { margin: 2px 0; }
`;
