// Orchestrates the feature tour build. generate() is pure apart from reading
// the screenshots folder; the CLI in ../build.mjs does the writing.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildModel } from "./model.mjs";
import { buildShotList } from "./shots.mjs";
import { assemble } from "./site.mjs";
import { renderFeaturePage, renderIndex, renderTour } from "./render.mjs";
import { sidecarName } from "./screenshots.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const toolDir = path.resolve(here, "..");
export const repoRoot = path.resolve(toolDir, "..", "..");

export const DEFAULTS = {
  catalog: path.join(repoRoot, "portal", "lib", "lab-builder", "features.json"),
  overlay: path.join(toolDir, "overlay.json"),
  shotList: path.join(repoRoot, "tools", "screenshot-capture", "feature-shots.json"),
  screenshotsDir: path.join(repoRoot, "docs", "feature-tour", "screenshots"),
  assetsDir: path.join(toolDir, "site", "assets"),
  out: path.join(repoRoot, "_site"),
};

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function serializeShotList(shotList) {
  return `${JSON.stringify(shotList, null, 2)}\n`;
}

export function generate({ catalog, overlay, screenshotsDir }) {
  const model = buildModel(catalog, overlay);
  const shotList = buildShotList(catalog, model, overlay);
  const site = assemble(model, shotList, screenshotsDir);
  const pages = new Map();
  pages.set("index.html", renderIndex(site));
  pages.set("tour.html", renderTour(site));
  for (const feature of site.features) pages.set(`features/${feature.id}.html`, renderFeaturePage(site, feature));
  pages.set("data/features.json", `${JSON.stringify({ features: site.features, totals: site.totals }, null, 2)}\n`);
  return { model, shotList, site, pages };
}

export function writeSite({ site, pages }, { out, assetsDir, screenshotsDir }) {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(path.join(out, "assets"), { recursive: true });
  for (const [rel, content] of pages) {
    const file = path.join(out, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  for (const name of fs.readdirSync(assetsDir)) {
    fs.copyFileSync(path.join(assetsDir, name), path.join(out, "assets", name));
  }
  fs.writeFileSync(path.join(out, ".nojekyll"), "");
  fs.mkdirSync(path.join(out, "screenshots"), { recursive: true });
  for (const feature of site.features) {
    for (const shot of feature.shots) {
      if (shot.status !== "ready") continue;
      fs.copyFileSync(path.join(screenshotsDir, shot.filename), path.join(out, "screenshots", shot.filename));
      const sidecar = path.join(screenshotsDir, sidecarName(shot.filename));
      if (fs.existsSync(sidecar)) fs.copyFileSync(sidecar, path.join(out, "screenshots", sidecarName(shot.filename)));
    }
  }
}
