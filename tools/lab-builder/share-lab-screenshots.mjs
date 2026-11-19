#!/usr/bin/env node
// Share the screenshots generated labs already have with every lab ("capture once, reuse everywhere").
//
//   node tools/lab-builder/share-lab-screenshots.mjs --dry-run            report only, change nothing
//   node tools/lab-builder/share-lab-screenshots.mjs --apply              share every eligible picture of every lab
//   node tools/lab-builder/share-lab-screenshots.mjs --apply --lab=<id>   share one lab's pictures
//   node tools/lab-builder/share-lab-screenshots.mjs --dry-run --json     machine-readable report
//
// Where things live: --root=<generated-labs folder>, otherwise the portal's own rules (LAB_BUILDER_OUTPUT_DIR, then
// ${PORTAL_STORAGE_ROOT}/generated-labs, then generated-labs/ in this repository). The shared library is
// FEATURE_TOUR_SCREENSHOTS_DIR, else ${PORTAL_STORAGE_ROOT}/screenshots, else docs/feature-tour/screenshots; --library=<folder>
// picks another one. The portal's data folder (its saved checks and confirmations) follows PORTAL_STORAGE_ROOT too.
//
// A picture is shared only when it is a shared slot (a feature tour shot, never a lab-specific one), a real screenshot
// (not a placeholder), its saved check passed or was accepted by a person, and account details were proven hidden. The
// library is never overwritten: a slot that already has a picture is skipped. Every skipped picture is listed with a plain
// reason. The tool does the same thing as "Share this lab's captured screenshots" in the Screenshot Center.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const portalLib = path.resolve(here, "../../portal/lib");

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;

if (flag("help") || flag("h") || flag("dry-run") === flag("apply")) {
  console.error("Usage: node tools/lab-builder/share-lab-screenshots.mjs (--dry-run | --apply) [--lab=<id>] [--root=<folder>] [--library=<folder>] [--json]");
  process.exit(flag("help") || flag("h") ? 0 : 2);
}

const library = value("library");
if (library) process.env.FEATURE_TOUR_SCREENSHOTS_DIR = path.resolve(library);

const { resolveGeneratedLabsDir, resolvePortalDataDir } = await import(pathToFileURL(path.join(portalLib, "storage-config.js")).href);
const { capturedScreenshotsDir, capturedScreenshotsDirs } = await import(pathToFileURL(path.join(portalLib, "lab-builder/captured.js")).href);
const { createScreenshotStore } = await import(pathToFileURL(path.join(portalLib, "capture/screenshot-store.js")).href);

const dryRun = flag("dry-run");
const root = path.resolve(value("root") || resolveGeneratedLabsDir());
const only = value("lab");

if (!fs.existsSync(root)) {
  console.error(`No generated labs folder at ${root}.`);
  process.exit(2);
}

const labs = fs
  .readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && (!only || entry.name === only) && fs.existsSync(path.join(root, entry.name, "manifest.json")))
  .map((entry) => entry.name)
  .sort();
if (only && !labs.length) {
  console.error(`No generated lab named "${only}" in ${root}.`);
  process.exit(2);
}

const store = createScreenshotStore({
  generatedRoot: root,
  captureDir: path.join(resolvePortalDataDir(), "capture"),
  capturedDirs: () => ({ primary: capturedScreenshotsDir(), search: capturedScreenshotsDirs() }),
});

const report = {
  root,
  library: capturedScreenshotsDir(),
  mode: dryRun ? "dry-run" : "apply",
  labs: [],
  totals: { labs: labs.length, promoted: 0, alreadyShared: 0, skipped: 0, errors: 0 },
};
for (const labId of labs) {
  try {
    const result = store.shareLabPictures(labId, { dryRun, withState: false });
    if (result.status !== 200) throw new Error(result.body?.error || `status ${result.status}`);
    const { promoted, alreadyShared, skipped, counts } = result.body;
    report.labs.push({ labId, promoted, alreadyShared, skipped, noPicture: counts.noPicture, error: null });
    report.totals.promoted += promoted.length;
    report.totals.alreadyShared += alreadyShared.length;
    report.totals.skipped += skipped.length;
  } catch (err) {
    report.labs.push({ labId, promoted: [], alreadyShared: [], skipped: [], noPicture: 0, error: err.message });
    report.totals.errors += 1;
  }
}

if (flag("json")) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  console.log(`Shared library: ${report.library}`);
  console.log(`Generated labs in ${root}: ${report.totals.labs} checked (${dryRun ? "dry run, nothing changed" : "apply"}).`);
  for (const lab of report.labs) {
    if (lab.error) {
      console.log(`  ${lab.labId}: ERROR ${lab.error}`);
      continue;
    }
    if (!lab.promoted.length && !lab.alreadyShared.length && !lab.skipped.length) continue;
    console.log(`  ${lab.labId}: ${lab.promoted.length} ${dryRun ? "would be shared" : "shared"}, ${lab.alreadyShared.length} already in the library, ${lab.skipped.length} skipped`);
    for (const file of lab.promoted) console.log(`      + ${file}`);
    for (const item of lab.skipped) console.log(`      - ${item.filename}: ${item.message}`);
  }
  console.log(`Total: ${report.totals.promoted} ${dryRun ? "would be shared" : "shared"}, ${report.totals.alreadyShared} already in the library, ${report.totals.skipped} skipped.`);
  if (dryRun && report.totals.promoted) console.log("Run again with --apply to share them.");
}
process.exit(report.totals.errors ? 1 : 0);
