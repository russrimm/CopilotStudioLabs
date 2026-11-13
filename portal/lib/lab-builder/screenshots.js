/**
 * Screenshot handling for generated labs.
 *
 * Copilot Studio sits behind an interactive sign-in, so the builder cannot
 * capture fresh screenshots on demand. Instead it does two things:
 *
 *  1. Reuses real screenshots already committed in this repo (`reuseScreenshots`
 *     in the feature catalog) by copying them into the generated lab's assets
 *     folder and emitting markdown image references.
 *  2. Gives every remaining screenshot a slot: a neutral "Screenshot pending"
 *     image at its final filename, alt text and a caption already written, and a
 *     `shots.json` entry plus `SHOTLIST.md` line for `tools/screenshot-capture`.
 *     The capture tool treats the tiny placeholder as missing and writes the real
 *     image over it, so the lab's Markdown never has to change.
 */

import fs from "node:fs";
import path from "node:path";

import { PLACEHOLDER_PATH, describeSlot, slotsForFeature } from "./slots.js";
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
 * @returns {{ byFeature: Map<string, {reused: Array, capture: Array}>, copies: Array, shots: Array }}
 */
export function planScreenshots(plan, { labsDir }) {
  const byFeature = new Map();
  const copies = [];
  const shots = [];
  const placeholders = [];
  const usedFilenames = new Set();

  for (const feature of plan.features) {
    const reused = [];
    const capture = [];
    let figure = 0;

    for (const ref of feature.reuseScreenshots || []) {
      if (!isSafeName(ref.lab) || !isSafeName(ref.file)) continue;
      const assetsRoot = path.resolve(labsDir, ref.lab, "assets");
      const source = path.resolve(assetsRoot, ref.file);
      if (!isInside(assetsRoot, source) || !fs.existsSync(source)) continue;

      const filename = uniqueFilename(ref.file, feature.id, usedFilenames);
      const caption = String(ref.caption || feature.name).replace(/\.$/, "");

      copies.push({ source, filename });
      figure += 1;
      reused.push({
        filename,
        caption,
        // The reused caption is already a description of the screen.
        alt: `${caption}.`,
        figure: `${feature.order}.${figure}`,
        credit: `Reused from lab \`${ref.lab}\``,
      });
    }

    for (const shot of slotsForFeature(feature)) {
      if (!isSafeName(shot.filename)) continue;
      const filename = uniqueFilename(shot.filename, feature.id, usedFilenames);
      const described = describeSlot(feature, shot);
      figure += 1;

      const entry = {
        // capture.js selects shots by numeric id (--only, --range, --from).
        id: shots.length + 1,
        slot: `${feature.id}-${path.basename(filename, path.extname(filename))}`,
        feature: feature.id,
        filename,
        section: shot.section || "agents",
        labSection: `Step ${feature.order} - ${feature.name}`,
        instructions: shot.instructions || [`Capture the ${feature.name} experience.`],
        // What the finished image shows, written now so the lab is accessible
        // before the capture tool fills the image in.
        alt: described.alt,
        caption: described.caption,
        kind: described.kind,
        figure: `${feature.order}.${figure}`,
        status: "pending",
      };
      if (shot.url) entry.url = shot.url;
      if (shot.viewport) entry.viewport = shot.viewport;

      shots.push(entry);
      placeholders.push({ filename });
      capture.push({
        filename,
        caption: described.caption,
        alt: described.alt,
        kind: described.kind,
        figure: entry.figure,
        instructions: entry.instructions,
        pending: true,
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
    shots,
  };
}

/**
 * The author-facing shot list. Capture instructions are for whoever takes the
 * screenshots, not for the learner, so they live here and in `shots.json`
 * rather than in the lab.
 */
export function buildShotList(plan, shots) {
  const lines = [
    `# Shot list: ${plan.title}`,
    "",
    `${shots.length} screenshot${shots.length === 1 ? "" : "s"} still to capture. Each one is already in the lab as a "Screenshot pending" placeholder with its alt text and caption written, so capturing it never requires editing \`index.md\`.`,
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
