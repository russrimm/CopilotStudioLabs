#!/usr/bin/env node
// Export the shared screenshot library to a ZIP, to move it to another computer (for example from this PC to Azure).
//
//   node tools/lab-builder/export-screenshots.mjs --dry-run                       list what would be exported, write nothing
//   node tools/lab-builder/export-screenshots.mjs --apply --out=shared.zip        write the ZIP
//   node tools/lab-builder/export-screenshots.mjs --dry-run --json                machine-readable report
//
// Where things live: --library=<folder> picks the library folder, otherwise the portal's own rules (FEATURE_TOUR_SCREENSHOTS_DIR,
// then ${PORTAL_STORAGE_ROOT}/screenshots, then the per-user folder, for example %LOCALAPPDATA%\CopilotStudioLabsPortal\screenshots
// on Windows). --data=<folder> picks the portal data folder that holds the saved checks (PORTAL_DATA_DIR, then
// ${PORTAL_STORAGE_ROOT}/data, then portal/data).
//
// The ZIP holds each picture plus manifest.json: its SHA-256, a trimmed copy of its saved check (no addresses, page titles, or
// capture steps), and its "Mark as accurate" date. It does the same thing as "Export shared screenshots" in the Screenshot Center.
// Pictures were masked when they were captured, but look at them before you share the ZIP: they should show no account names,
// email addresses, or customer data.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const portalLib = path.resolve(here, "../../portal/lib");

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;

if (flag("help") || flag("h") || flag("dry-run") === flag("apply")) {
  console.error("Usage: node tools/lab-builder/export-screenshots.mjs (--dry-run | --apply --out=<file.zip>) [--library=<folder>] [--data=<folder>] [--json]");
  process.exit(flag("help") || flag("h") ? 0 : 2);
}
if (flag("apply") && !value("out")) {
  console.error("--apply needs --out=<file.zip>.");
  process.exit(2);
}

if (value("library")) process.env.FEATURE_TOUR_SCREENSHOTS_DIR = path.resolve(value("library"));
if (value("data")) process.env.PORTAL_DATA_DIR = path.resolve(value("data"));

const { resolvePortalDataDir } = await import(pathToFileURL(path.join(portalLib, "storage-config.js")).href);
const { capturedScreenshotsDir, capturedScreenshotsDirs } = await import(pathToFileURL(path.join(portalLib, "lab-builder/captured.js")).href);
const { createScreenshotStore } = await import(pathToFileURL(path.join(portalLib, "capture/screenshot-store.js")).href);
const { EXPORT_WARNING, buildLibraryExport } = await import(pathToFileURL(path.join(portalLib, "capture/library-transfer.js")).href);

const dryRun = flag("dry-run");
const store = createScreenshotStore({
  generatedRoot: path.resolve(here, "../../generated-labs"),
  captureDir: path.join(resolvePortalDataDir(), "capture"),
  capturedDirs: () => ({ primary: capturedScreenshotsDir(), search: capturedScreenshotsDirs() }),
});

const pictures = store.libraryPictures();
const report = {
  library: capturedScreenshotsDir(),
  mode: dryRun ? "dry-run" : "apply",
  pictures: pictures.map((p) => ({ filename: p.filename, bytes: p.bytes.length, sha256: p.sha256, confirmed: Boolean(p.confirmedAt) })),
  out: null,
  warning: EXPORT_WARNING,
};

if (!dryRun) {
  const { buffer } = await buildLibraryExport(store);
  const out = path.resolve(value("out"));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const temp = `${out}.${process.pid}.tmp`;
  fs.writeFileSync(temp, buffer);
  fs.renameSync(temp, out);
  report.out = out;
}

if (flag("json")) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  console.log(`Shared library: ${report.library}`);
  console.log(`${pictures.length} picture${pictures.length === 1 ? "" : "s"} ${dryRun ? "would be exported (dry run, nothing written)" : `exported to ${report.out}`}.`);
  for (const p of report.pictures) console.log(`  ${p.filename} (${Math.round(p.bytes / 1024)} KB)${p.confirmed ? ", marked accurate" : ""}`);
  console.log(EXPORT_WARNING);
  if (dryRun && pictures.length) console.log("Run again with --apply --out=<file.zip> to write the ZIP.");
}
process.exit(0);
