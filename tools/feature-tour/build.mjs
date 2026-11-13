#!/usr/bin/env node
// Builds the Microsoft AI Training Generator feature tour site and the capture shot lists
// from the lab builder catalog, one shot list and one site section per product.
//
//   node tools/feature-tour/build.mjs            write every feature-shots*.json and _site/
//   node tools/feature-tour/build.mjs --check    fail if any feature-shots*.json is stale
//   node tools/feature-tour/build.mjs --out=dir  write the site somewhere else
//   node tools/feature-tour/build.mjs --shots-only  only refresh the feature-shots*.json files

import fs from "node:fs";
import path from "node:path";
import { DEFAULTS, generate, readJson, serializeShotLists, writeSite } from "./lib/build.mjs";
import { isFeatureManifestName } from "./lib/products.mjs";
import { readCatalogFile } from "../../portal/lib/lab-builder/catalog-source.js";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);

if (flag("--help") || flag("-h")) {
  console.log(`Usage: node tools/feature-tour/build.mjs [--check] [--shots-only] [--product=<id>] [--out=<dir>]

  (default)      Write tools/screenshot-capture/feature-shots*.json (one per product) and the site in _site/.
  --check        Exit 1 if any feature-shots*.json is out of date with the catalog, overlay.json, or capture-products.json.
  --shots-only   Refresh the shot lists without writing the site.
  --product=<id> Limit --check and --shots-only to one product.
  --out=<dir>    Site output folder (default: _site).
  --screenshots=<dir>  Read screenshots from another folder (for previews and tests).`);
  process.exit(0);
}

const out = path.resolve(value("--out") ?? DEFAULTS.out);
const screenshotsDir = path.resolve(value("--screenshots") ?? DEFAULTS.screenshotsDir);
const shotListDir = path.resolve(value("--shot-list-dir") ?? DEFAULTS.shotListDir);
const catalog = readCatalogFile(DEFAULTS.catalog);
const overlay = readJson(DEFAULTS.overlay);
const only = value("--product");

let result;
try {
  result = generate({ catalog, overlay, screenshotsDir });
} catch (error) {
  console.error(`feature-tour: ${error.message}`);
  process.exit(1);
}

if (only && !result.products.some((p) => p.id === only)) {
  console.error(`feature-tour: unknown product "${only}". Products: ${result.products.map((p) => p.id).join(", ")}.`);
  process.exit(1);
}
const selected = result.products.filter((p) => !only || p.id === only);
const expected = serializeShotLists(result);

if (flag("--check")) {
  const problems = [];
  for (const p of selected) {
    const file = path.join(shotListDir, p.manifest);
    // A Windows checkout can convert line endings; the content is what matters.
    const actual = fs.existsSync(file) ? fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n") : null;
    if (actual === null) problems.push(`tools/screenshot-capture/${p.manifest} is missing.`);
    else if (actual !== expected.get(p.manifest)) problems.push(`tools/screenshot-capture/${p.manifest} is out of date.`);
  }
  if (!only) {
    for (const name of fs.existsSync(shotListDir) ? fs.readdirSync(shotListDir) : []) {
      if (isFeatureManifestName(name) && !expected.has(name)) problems.push(`tools/screenshot-capture/${name} does not belong to any product. Delete it.`);
    }
  }
  if (problems.length) {
    console.error(
      `feature-tour: ${problems.join("\nfeature-tour: ")}\nThe shot lists are generated from portal/lib/lab-builder (features.json and catalog/*.json), tools/feature-tour/overlay.json, and tools/feature-tour/capture-products.json.\nRun: npm run feature-tour:build   and commit the result.`,
    );
    process.exit(1);
  }
  const features = selected.reduce((n, p) => n + p.site.totals.features, 0);
  const shots = selected.reduce((n, p) => n + p.site.totals.shots, 0);
  console.log(`feature-tour: up to date (${selected.length} product${selected.length === 1 ? "" : "s"}, ${features} features, ${shots} shots).`);
  process.exit(0);
}

fs.mkdirSync(shotListDir, { recursive: true });
for (const p of selected) {
  const file = path.join(shotListDir, p.manifest);
  fs.writeFileSync(file, expected.get(p.manifest));
  console.log(`Wrote ${path.relative(process.cwd(), file)} (${p.shotList.shots.length} shots).`);
}

if (!flag("--shots-only")) {
  writeSite(result, { out, assetsDir: DEFAULTS.assetsDir, screenshotsDir });
  const t = result.products.reduce(
    (sum, p) => ({ features: sum.features + p.site.totals.features, shots: sum.shots + p.site.totals.shots, ready: sum.ready + p.site.totals.shotsReady }),
    { features: 0, shots: 0, ready: 0 },
  );
  console.log(`Wrote site to ${path.relative(process.cwd(), out) || "."}: ${result.products.length} products, ${t.features} features, ${t.ready} of ${t.shots} screenshots captured.`);
}
