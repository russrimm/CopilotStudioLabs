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
      const source = path.join(labsDir, ref.lab, "assets", ref.file);
      if (!fs.existsSync(source)) continue;

      let filename = ref.file;
      if (usedFilenames.has(filename)) {
        const ext = path.extname(filename);
        filename = `${path.basename(filename, ext)}-${feature.id}${ext}`;
      }
      usedFilenames.add(filename);

      copies.push({ source, filename });
      reused.push({
        filename,
        caption: ref.caption || feature.name,
        credit: `Reused from lab \`${ref.lab}\``,
      });
    }

    for (const shot of feature.screenshots || []) {
      let filename = shot.filename;
      if (usedFilenames.has(filename)) {
        const ext = path.extname(filename);
        filename = `${path.basename(filename, ext)}-${feature.id}${ext}`;
      }
      usedFilenames.add(filename);

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
  for (const copy of copies) {
    try {
      fs.copyFileSync(copy.source, path.join(assetsDir, copy.filename));
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
