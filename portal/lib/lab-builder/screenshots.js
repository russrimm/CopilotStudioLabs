/**
 * Screenshot handling for generated labs.
 *
 * Copilot Studio sits behind an interactive sign-in, so the builder cannot
 * capture fresh screenshots on demand. Instead it does two things:
 *
 *  1. Reuses real screenshots already committed in this repo (`reuseScreenshots`
 *     in the feature catalog) by copying them into the generated lab's assets
 *     folder and emitting markdown image references.
 *  2. Emits a `shots.json` capture manifest for every remaining screenshot so
 *     the learner (or an author) can run `tools/screenshot-capture` against
 *     their own tenant and fill the gaps automatically.
 */

import fs from "node:fs";
import path from "node:path";

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
  const usedFilenames = new Set();

  for (const feature of plan.features) {
    const reused = [];
    const capture = [];

    for (const ref of feature.reuseScreenshots || []) {
      if (!isSafeName(ref.lab) || !isSafeName(ref.file)) continue;
      const assetsRoot = path.resolve(labsDir, ref.lab, "assets");
      const source = path.resolve(assetsRoot, ref.file);
      if (!isInside(assetsRoot, source) || !fs.existsSync(source)) continue;

      const filename = uniqueFilename(ref.file, feature.id, usedFilenames);

      copies.push({ source, filename });
      reused.push({
        filename,
        caption: ref.caption || feature.name,
        credit: `Reused from lab \`${ref.lab}\``,
      });
    }

    for (const shot of feature.screenshots || []) {
      if (!isSafeName(shot.filename)) continue;
      const filename = uniqueFilename(shot.filename, feature.id, usedFilenames);

      const entry = {
        id: `${feature.id}-${path.basename(filename, path.extname(filename))}`,
        filename,
        section: shot.section || "agents",
        labSection: `Step ${feature.order} - ${feature.name}`,
        instructions: shot.instructions || [`Capture the ${feature.name} experience.`],
      };
      if (shot.url) entry.url = shot.url;
      if (shot.viewport) entry.viewport = shot.viewport;

      shots.push(entry);
      capture.push({ filename, caption: shot.caption || feature.name, instructions: entry.instructions });
    }

    byFeature.set(feature.id, { reused, capture });
  }

  return { byFeature, copies, shots };
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
