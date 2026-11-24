/**
 * Screenshot handling for generated labs.
 *
 * Copilot Studio sits behind an interactive sign-in, so the builder cannot
 * capture fresh screenshots on demand. Instead it does two things:
 *
 *  1. Reuses real screenshots already committed in this repo (`reuseScreenshots`
 *     in the feature catalog) by copying them into the generated lab's assets
 *     folder and emitting markdown image references. A placeholder picture is
 *     never reused: its slot stays a pending slot (see placeholder-detect.js).
 *  2. Gives every remaining screenshot a slot: a neutral "Screenshot pending"
 *     image at its final filename, alt text and a caption already written, and a
 *     `shots.json` entry plus `SHOTLIST.md` line for `tools/screenshot-capture`.
 *     The capture tool treats the tiny placeholder as missing and writes the real
 *     image over it, so the lab's Markdown never has to change.
 */

import fs from "node:fs";
import path from "node:path";

import { PLACEHOLDER_PATH, derivedSlotsForTopic, describeSlot, slotNeedFor, slotsForFeature } from "./slots.js";
import { capturedImage, capturedScreenshotsDirs } from "./captured.js";
import { isPlaceholder } from "./placeholder-detect.js";
import { reusePictureVerdict } from "./picture-guard.js";
import { combinedHarnessStatement, harnessGapMessage, harnessLabel, labHarnessStatement } from "../../../tools/screenshot-capture/harness.mjs";
import { featureLabHarness } from "./lab-harness.js";
import { moduleHarnessRecord } from "./harness-parts.js";
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** True when `child` resolves to a location strictly inside `root`. */
function isInside(root, child) {
  const rel = path.relative(root, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** A bare file name: no separators, no traversal, no leading dot. */
function isSafeName(name) {
  return typeof name === "string" && SAFE_SEGMENT.test(name) && !name.includes("..");
}

/** Return `filename`, or a feature-suffixed variant, that is not yet in `used`; reserves the result. */
function uniqueFilename(filename, featureId, used) {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let candidate = filename;
  for (let n = 0; used.has(candidate); n += 1) {
    candidate = `${base}-${featureId}${n ? `-${n + 1}` : ""}${ext}`;
  }
  used.add(candidate);
  return candidate;
}

/**
 * Build the screenshot plan for a lab.
 *
 * @param {object} plan planner output
 * @param {object} opts
 * @param {string} opts.labsDir absolute path to the repo `labs/` folder
 * @param {string} [opts.capturedDir] folder of captured feature-tour screenshots (default docs/feature-tour/screenshots)
 * @returns {{ byFeature: Map<string, {reused: Array, capture: Array}>, copies: Array, shots: Array, placeholders: Array }}
 *   `shots` lists every slot; a slot with a captured image has status "captured" and is copied
 *   instead of getting a placeholder, any other slot has status "pending".
 */
export function planScreenshots(plan, { labsDir, capturedDir = capturedScreenshotsDirs(), stepsByFeature = null }) {
  const byFeature = new Map();
  const copies = [];
  const shots = [];
  const placeholders = [];
  const usedFilenames = new Set();

  for (const feature of plan.features) {
    const reused = [];
    const capture = [];
    let figure = 0;

    const sectionNum = feature.prerequisite
      ? (feature.recapOrder ?? feature.order)
      : (feature.stepOrder ?? feature.order);
    const sectionLabel =
      feature.stepLabel || (feature.prerequisite ? `Recap ${sectionNum}` : `Step ${sectionNum}`);

    // A committed picture that only stands in for a screenshot (a placeholder) is never copied in as a real
    // capture. Its slot stays pending at the same file name, so it can still be captured later.
    const demoted = [];

    for (const ref of feature.reuseScreenshots || []) {
      if (!isSafeName(ref.lab) || !isSafeName(ref.file)) continue;
      const assetsRoot = path.resolve(labsDir, ref.lab, "assets");
      const source = path.resolve(assetsRoot, ref.file);
      if (!isInside(assetsRoot, source) || !fs.existsSync(source)) continue;

      const caption = String(ref.caption || feature.name).replace(/\.$/, "");
      // The hand-written labs were written in the Classic (Standard) experience, so their pictures are never reused in a lab for another
      // harness: the slot stays pending and is taken in the lab's own harness.
      const reuseNeed = slotNeedFor(feature, { filename: ref.file }, { labHarness: featureLabHarness(plan, feature) });
      if (reuseNeed.id && reuseNeed.id !== "standard") {
        demoted.push({ filename: ref.file, caption, instructions: [`Capture ${caption}.`] });
        continue;
      }
      if (isPlaceholder(source)) {
        demoted.push({ filename: ref.file, caption, instructions: [`Capture ${caption}.`] });
        continue;
      }

      const filename = uniqueFilename(ref.file, feature.id, usedFilenames);

      copies.push({ source, filename });
      figure += 1;
      reused.push({
        filename,
        caption,
        // The reused caption is already a description of the screen.
        alt: `${caption}.`,
        figure: `${sectionNum}.${figure}`,
        credit: `Reused from lab \`${ref.lab}\``,
      });
    }

    const own = slotsForFeature(feature);
    const slots = own.length ? own : derivedSlotsForTopic(feature, stepsByFeature?.get?.(feature.id));
    for (const shot of [...demoted, ...slots]) {
      if (!isSafeName(shot.filename)) continue;
      const filename = uniqueFilename(shot.filename, feature.id, usedFilenames);
      const described = describeSlot(feature, shot);
      figure += 1;
      // The lab's harness decides which picture this slot needs: a Standard (Classic) lab only ever shows Standard (Classic) pictures. In a lab
      // that covers both harnesses it is the harness of the part the slot sits in (a shared topic is taken in the first harness).
      const need = slotNeedFor(feature, shot, { labHarness: featureLabHarness(plan, feature) });
      // A real screenshot captured for this slot is used as is, unless the capture platform says it looks like the wrong screen;
      // every other slot keeps the placeholder. A picture of a slot that needs a harness is read under that harness's name only, so a
      // picture of the other harness (or one from before harnesses were recorded) is never copied in.
      const found = capturedImage(capturedDir, shot.filename, { harness: need.id });
      const reuse = found ? reusePictureVerdict(found.file) : { ok: true };
      const captured = found && reuse.ok !== false ? found : null;

      const entry = {
        // capture.js selects shots by numeric id (--only, --range, --from).
        id: shots.length + 1,
        slot: `${feature.id}-${path.basename(filename, path.extname(filename))}`,
        feature: feature.id,
        filename,
        section: shot.section || "agents",
        labSection: `${sectionLabel} - ${feature.name}`,
        instructions: shot.instructions || [`Capture the ${feature.name} experience.`],
        // What the finished image shows, written now so the lab is accessible
        // before the capture tool fills the image in.
        alt: described.alt,
        caption: described.caption,
        kind: described.kind,
        figure: `${sectionNum}.${figure}`,
        status: captured ? "captured" : "pending",
        // A lab that covers two harnesses: the harness of the section this picture sits in (see harness-parts.js).
        ...(plan.harnessParts ? moduleHarnessRecord(plan.harnessParts, feature) : {}),
      };
      if (need.id) {
        // A shared slot of a combined lab keeps `harness: null` (the section's own harness, see harness-parts.js); the harness its picture is taken
        // in is `captureHarness`. Every other slot's `harness` is the harness it is taken in.
        if (entry.harnessScope === "shared") entry.captureHarness = need.id;
        else entry.harness = need.id;
        entry.harnessLabel = harnessLabel(need.id);
        if (need.gap) entry.harnessGapNote = harnessGapMessage(need.gap);
      }
      if (shot.url) entry.url = shot.url;
      if (shot.product) entry.product = shot.product;
      if (shot.viewport) entry.viewport = shot.viewport;

      shots.push(entry);
      if (captured) copies.push({ source: captured.file, filename, captured: true });
      else placeholders.push({ filename });
      capture.push({
        filename,
        caption: described.caption,
        alt: described.alt,
        kind: described.kind,
        figure: entry.figure,
        instructions: entry.instructions,
        pending: !captured,
      });
    }

    byFeature.set(feature.id, { reused, capture });
  }

  return { byFeature, copies, shots, placeholders };
}

/**
 * Write the neutral "Screenshot pending" image at every pending slot's final
 * filename. The capture tool treats a file this small as missing, so it replaces
 * the placeholder in place and the lab's Markdown never has to change.
 */
export function writePlaceholders(placeholders, assetsDir) {
  if (!placeholders.length) return 0;
  fs.mkdirSync(assetsDir, { recursive: true });
  const root = path.resolve(assetsDir);
  let count = 0;
  for (const { filename } of placeholders) {
    const target = path.resolve(root, filename);
    if (!isSafeName(filename) || !isInside(root, target) || fs.existsSync(target)) continue;
    fs.copyFileSync(PLACEHOLDER_PATH, target);
    count += 1;
  }
  return count;
}

/** Copy reused screenshots into the generated lab's assets folder. */
export function copyScreenshots(copies, assetsDir) {
  if (!copies.length) return 0;
  fs.mkdirSync(assetsDir, { recursive: true });
  let count = 0;
  const root = path.resolve(assetsDir);
  for (const copy of copies) {
    const target = path.resolve(root, copy.filename);
    if (!isSafeName(copy.filename) || !isInside(root, target)) continue;
    // Never copy a placeholder picture in as if it were a screenshot.
    if (isPlaceholder(copy.source)) continue;
    try {
      fs.copyFileSync(copy.source, target);
      count += 1;
    } catch {
      /* skip unreadable source */
    }
  }
  return count;
}

/**
 * Build the `shots.json` manifest consumed by tools/screenshot-capture/capture.js.
 */
export function buildShotsManifest(plan, shots) {
  return {
    lab: plan.slug,
    assetsDir: "assets",
    startUrl: "https://copilotstudio.microsoft.com/",
    // The harness every Copilot Studio picture of this lab is taken in (null for a lab with no Copilot Studio part). A lab that covers both
    // harnesses has none: each picture carries the harness of its part.
    ...(plan.harness ? { harness: plan.harness, harnessLabel: harnessLabel(plan.harness), harnessSource: plan.harnessSource || null } : {}),
    ...(plan.harnessParts ? { harnessMode: "both", harnesses: [...plan.harnessParts.order] } : {}),
    shots,
  };
}

/**
 * The author-facing shot list. Capture instructions are for whoever takes the
 * screenshots, not for the learner, so they live here and in `shots.json`
 * rather than in the lab.
 */
export function buildShotList(plan, allShots) {
  const shots = allShots.filter((shot) => shot.status !== "captured");
  const done = allShots.length - shots.length;
  const lines = [
    `# Shot list: ${plan.title}`,
    "",
    ...(plan.harness ? [`**${labHarnessStatement(plan.harness)}**`, ""] : plan.harnessParts ? [`**${combinedHarnessStatement(plan.harnessParts.order)}**`, ""] : []),
    `${shots.length} screenshot${shots.length === 1 ? "" : "s"} still to capture${done ? ` (${done} already captured and copied in from the feature tour)` : ""}. Each one is already in the lab as a "Screenshot pending" placeholder with its alt text and caption written, so capturing it never requires editing \`index.md\`.`,
    "",
    "Run the capture tool against this lab's manifest, then confirm nothing is left pending:",
    "",
    "```bash",
    "node tools/screenshot-capture/capture.js --manifest=<path-to-this-lab>/shots.json --missing",
    "node tools/screenshot-capture/verify-shots.js",
    "```",
    "",
    "Capture each image at the final filename. Keep the alt text accurate: if the real screen differs from the description, update `alt` in `shots.json` and the matching image in `index.md` together.",
    "",
  ];
  for (const shot of shots) {
    lines.push(
      `## Figure ${shot.figure}: ${shot.caption}`,
      "",
      `- **File:** \`assets/${shot.filename}\``,
      ...(shot.harnessLabel ? [`- **Harness:** ${shot.harnessLabel}`] : []),
      ...(shot.harnessGapNote ? [`- **Harness gap:** ${shot.harnessGapNote}`] : []),
      `- **Lab section:** ${shot.labSection}`,
      `- **Type:** ${shot.kind}`,
      `- **Alt text:** ${shot.alt}`,
      "- **How to capture:**",
      ...shot.instructions.map((line) => `  - ${line}`),
      "",
    );
  }
  return lines.join("\n").trimEnd() + "\n";
}
