// Orchestrates the feature tour build. generate() is pure apart from reading
// the screenshots folder; the CLI in ../build.mjs does the writing.
//
// Each product has its own model, shot list, and site. Copilot Studio is the
// site root (its URLs have not changed); every other product lives under
// <product-id>/ and shares the assets/ and screenshots/ folders at the root.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TOUR_PRODUCT, buildModel } from "./model.mjs";
import { buildShotList } from "./shots.mjs";
import { assemble } from "./site.mjs";
import { renderFeaturePage, renderIndex, renderTour } from "./render.mjs";
import { sidecarName } from "./screenshots.mjs";
import { labIdFor, manifestFileName, productIds, readCaptureConfig, validateCaptureConfig } from "./products.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const toolDir = path.resolve(here, "..");
export const repoRoot = path.resolve(toolDir, "..", "..");

export const DEFAULTS = {
  catalog: path.join(repoRoot, "portal", "lib", "lab-builder", "features.json"),
  overlay: path.join(toolDir, "overlay.json"),
  shotList: path.join(repoRoot, "tools", "screenshot-capture", "feature-shots.json"),
  shotListDir: path.join(repoRoot, "tools", "screenshot-capture"),
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

/** Where a product's pages live inside the site: "" for Copilot Studio, "<id>/" for the rest. */
export function sitePathFor(product) {
  return product === TOUR_PRODUCT ? "" : `${product}/`;
}

export function generate({ catalog, overlay, screenshotsDir, config = readCaptureConfig() }) {
  const present = new Set(catalog.features.map((f) => f.product ?? TOUR_PRODUCT));
  present.add(TOUR_PRODUCT);
  const sectionsByProduct = {};
  for (const f of catalog.features) {
    const p = f.product ?? TOUR_PRODUCT;
    (sectionsByProduct[p] ??= new Set());
    for (const s of f.screenshots ?? []) sectionsByProduct[p].add(s.section);
  }
  const problems = validateCaptureConfig(config, {
    products: [...present],
    sectionsByProduct: Object.fromEntries(Object.entries(sectionsByProduct).map(([k, v]) => [k, [...v]])),
  });
  if (problems.length) throw new Error(problems.join("\n"));

  const ids = productIds(config).filter((id) => present.has(id));
  const links = ids.map((id) => ({ id, label: config.products[id].label, href: `${sitePathFor(id)}index.html` }));

  const products = ids.map((id) => {
    const model = buildModel(catalog, overlay, id, config.products[id].label);
    model.products = links;
    model.siteBase = id === TOUR_PRODUCT ? "" : "../";
    const shotList = buildShotList(catalog, model, overlay, config);
    const site = assemble(model, shotList, screenshotsDir, { shotsPrefix: model.siteBase });
    return { id, label: config.products[id].label, sitePath: sitePathFor(id), manifest: manifestFileName(id), lab: labIdFor(id), model, shotList, site };
  });

  const pages = new Map();
  for (const p of products) {
    pages.set(`${p.sitePath}index.html`, renderIndex(p.site));
    pages.set(`${p.sitePath}tour.html`, renderTour(p.site));
    for (const feature of p.site.features) pages.set(`${p.sitePath}features/${feature.id}.html`, renderFeaturePage(p.site, feature));
    pages.set(`${p.sitePath}data/features.json`, `${JSON.stringify({ features: p.site.features, totals: p.site.totals }, null, 2)}\n`);
  }

  // Top-level model, shotList, and site stay the Copilot Studio ones so existing callers keep working.
  const main = products.find((p) => p.id === TOUR_PRODUCT);
  return { model: main.model, shotList: main.shotList, site: main.site, pages, products };
}

/** Every product's manifest as file name to serialized content. */
export function serializeShotLists(result) {
  return new Map(result.products.map((p) => [p.manifest, serializeShotList(p.shotList)]));
}

export function writeSite({ products, pages }, { out, assetsDir, screenshotsDir }) {
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
  for (const { site } of products) {
    for (const feature of site.features) {
      for (const shot of feature.shots) {
        if (shot.status !== "ready") continue;
        fs.copyFileSync(path.join(screenshotsDir, shot.filename), path.join(out, "screenshots", shot.filename));
        const sidecar = path.join(screenshotsDir, sidecarName(shot.filename));
        if (fs.existsSync(sidecar)) fs.copyFileSync(sidecar, path.join(out, "screenshots", sidecarName(shot.filename)));
      }
    }
  }
}
