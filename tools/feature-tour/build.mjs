#!/usr/bin/env node
// Builds the Copilot Studio feature tour site from the lab builder catalog.
//
//   node tools/feature-tour/build.mjs            write feature-shots.json and _site/
//   node tools/feature-tour/build.mjs --check    fail if feature-shots.json is stale
//   node tools/feature-tour/build.mjs --out=dir  write the site somewhere else
//   node tools/feature-tour/build.mjs --shots-only  only refresh feature-shots.json

import fs from "node:fs";
import path from "node:path";
import { DEFAULTS, generate, readJson, serializeShotList, writeSite } from "./lib/build.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);

if (flag("--help") || flag("-h")) {
  console.log(`Usage: node tools/feature-tour/build.mjs [--check] [--shots-only] [--out=<dir>]

  (default)      Write tools/screenshot-capture/feature-shots.json and the site in _site/.
  --check        Exit 1 if feature-shots.json is out of date with features.json and overlay.json.
  --shots-only   Refresh feature-shots.json without writing the site.
  --out=<dir>    Site output folder (default: _site).`);
  process.exit(0);
}

const out = path.resolve(value("--out") ?? DEFAULTS.out);
const catalog = readJson(DEFAULTS.catalog);
const overlay = readJson(DEFAULTS.overlay);

let result;
try {
  result = generate({ catalog, overlay, screenshotsDir: DEFAULTS.screenshotsDir });
} catch (error) {
  console.error(`feature-tour: ${error.message}`);
  process.exit(1);
}

const expected = serializeShotList(result.shotList);

if (flag("--check")) {
  // A Windows checkout can convert line endings; the content is what matters.
  const actual = fs.existsSync(DEFAULTS.shotList) ? fs.readFileSync(DEFAULTS.shotList, "utf8").replace(/\r\n/g, "\n") : "";
  if (actual !== expected) {
    console.error(
      "feature-tour: tools/screenshot-capture/feature-shots.json is out of date with portal/lib/lab-builder/features.json or tools/feature-tour/overlay.json.\nRun: npm run feature-tour:build   and commit the result.",
    );
    process.exit(1);
  }
  console.log(`feature-tour: up to date (${result.site.totals.features} features, ${result.site.totals.shots} shots).`);
  process.exit(0);
}

fs.writeFileSync(DEFAULTS.shotList, expected);
console.log(`Wrote ${path.relative(process.cwd(), DEFAULTS.shotList)} (${result.shotList.shots.length} shots).`);

if (!flag("--shots-only")) {
  writeSite(result, { out, assetsDir: DEFAULTS.assetsDir, screenshotsDir: DEFAULTS.screenshotsDir });
  const t = result.site.totals;
  console.log(`Wrote site to ${path.relative(process.cwd(), out) || "."}: ${t.features} features, ${t.shotsReady} of ${t.shots} screenshots captured.`);
}
