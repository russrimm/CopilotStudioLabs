#!/usr/bin/env node
// Import a ZIP of screenshots into the shared library (the ZIP that "Export shared screenshots" or export-screenshots.mjs wrote).
//
//   node tools/lab-builder/import-screenshots.mjs --dry-run --zip=shared.zip     report only, change nothing
//   node tools/lab-builder/import-screenshots.mjs --apply --zip=shared.zip       import every picture that passes its checks
//   node tools/lab-builder/import-screenshots.mjs --apply --zip=shared.zip --replace   also replace pictures the library already has
//   node tools/lab-builder/import-screenshots.mjs --dry-run --zip=shared.zip --json    machine-readable report
//
// Where things live: --library=<folder> picks the library folder, otherwise the portal's own rules (FEATURE_TOUR_SCREENSHOTS_DIR,
// then ${PORTAL_STORAGE_ROOT}/screenshots, then the per-user folder). --data=<folder> picks the portal data folder that holds the
// saved checks (PORTAL_DATA_DIR, then ${PORTAL_STORAGE_ROOT}/data, then portal/data).
//
// Every picture goes through the same checks as an upload: it must be a shared screenshot name, a real PNG, JPEG, or WebP of a
// sensible size, not blank, and not a placeholder. A picture the library already has is skipped unless you pass --replace (the
// old one is kept as a backup). Every picture that was skipped or rejected is listed with a plain reason. The tool does the same
// thing as "Import screenshots" in the Screenshot Center.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const portalLib = path.resolve(here, "../../portal/lib");

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;

if (flag("help") || flag("h") || flag("dry-run") === flag("apply") || (!flag("help") && !flag("h") && !value("zip"))) {
  console.error("Usage: node tools/lab-builder/import-screenshots.mjs (--dry-run | --apply) --zip=<file.zip> [--replace] [--library=<folder>] [--data=<folder>] [--json]");
  process.exit(flag("help") || flag("h") ? 0 : 2);
}

if (value("library")) process.env.FEATURE_TOUR_SCREENSHOTS_DIR = path.resolve(value("library"));
if (value("data")) process.env.PORTAL_DATA_DIR = path.resolve(value("data"));

const zipFile = path.resolve(value("zip"));
if (!fs.existsSync(zipFile) || !fs.statSync(zipFile).isFile()) {
  console.error(`No ZIP file at ${zipFile}.`);
  process.exit(2);
}

const { resolvePortalDataDir } = await import(pathToFileURL(path.join(portalLib, "storage-config.js")).href);
const { capturedScreenshotsDir, capturedScreenshotsDirs } = await import(pathToFileURL(path.join(portalLib, "lab-builder/captured.js")).href);
const { createScreenshotStore } = await import(pathToFileURL(path.join(portalLib, "capture/screenshot-store.js")).href);
const { MAX_IMPORT_ZIP_BYTES, importLibraryZip } = await import(pathToFileURL(path.join(portalLib, "capture/library-transfer.js")).href);

if (fs.statSync(zipFile).size > MAX_IMPORT_ZIP_BYTES) {
  console.error(`The ZIP is larger than ${Math.round(MAX_IMPORT_ZIP_BYTES / 1048576)} MB.`);
  process.exit(2);
}

const dryRun = flag("dry-run");
const store = createScreenshotStore({
  generatedRoot: path.resolve(here, "../../generated-labs"),
  captureDir: path.join(resolvePortalDataDir(), "capture"),
  capturedDirs: () => ({ primary: capturedScreenshotsDir(), search: capturedScreenshotsDirs() }),
});

const result = importLibraryZip(store, fs.readFileSync(zipFile), { replace: flag("replace"), dryRun });
if (result.status !== 200) {
  console.error(result.body.error || `The import failed (${result.status}).`);
  process.exit(1);
}
const report = { library: capturedScreenshotsDir(), zip: zipFile, ...result.body };

if (flag("json")) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  console.log(`Shared library: ${report.library}`);
  console.log(`${report.message}${dryRun ? " (dry run, nothing changed)" : ""}`);
  for (const row of [...report.imported, ...report.replaced]) console.log(`  + ${row.filename}`);
  for (const row of report.needsReview) console.log(`  ? ${row.filename}: ${row.message}`);
  for (const row of report.skipped) console.log(`  - ${row.filename}: ${row.message}`);
  for (const row of report.rejected) console.log(`  x ${row.filename}: ${row.message}`);
  if (report.ignored.length) console.log(`  Ignored (not a picture name): ${report.ignored.join(", ")}`);
  if (dryRun && report.counts.imported + report.counts.replaced) console.log("Run again with --apply to import them.");
}
process.exit(0);
