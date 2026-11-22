#!/usr/bin/env node
// Move pictures that look like the WRONG screen to the kept pictures list ("Move pictures that look wrong to the kept pictures list"
// in the Screenshot Center), from the shared library and from every lab's own pictures.
//
//   node tools/lab-builder/quarantine-screenshots.mjs --dry-run                 say what would move; change nothing (the default)
//   node tools/lab-builder/quarantine-screenshots.mjs --apply                   move every picture that is clearly wrong
//   node tools/lab-builder/quarantine-screenshots.mjs --apply --include-probable  also move the ones that only need a glance
//   node tools/lab-builder/quarantine-screenshots.mjs --apply --lab=<id>        the shared library and one lab
//   node tools/lab-builder/quarantine-screenshots.mjs --dry-run --report=<file> write the plain report (outside this repository)
//   node tools/lab-builder/quarantine-screenshots.mjs --dry-run --json          the result as JSON
//
// Where things live (the same rules as share-lab-screenshots.mjs): --root=<generated-labs folder>, --library-dir=<folder> (the shared
// library), --data=<portal data folder> (its saved checks and confirmations); the kept pictures list follows the library folder.
//
// Every picture is first saved in the kept pictures list (with its saved check, its Keep this one mark, and its callouts) and only then
// removed from where it was; its screenshot slot goes back to pending, and labs show the Screenshot to add card. Kept pictures can be
// restored in the Screenshot Center (Advanced > Shared screenshot library > Kept pictures) for 90 days. A picture a person marked Keep
// this one is never moved. Run audit-screenshots.mjs first to see why each picture is flagged. Nothing moves without --apply.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const portalLib = path.resolve(repoRoot, "portal/lib");

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;

if (flag("help") || flag("h") || (flag("apply") && flag("dry-run"))) {
  console.error("Usage: node tools/lab-builder/quarantine-screenshots.mjs [--dry-run | --apply] [--include-probable] [--lab=<id>] [--root=<folder>] [--library-dir=<folder>] [--data=<folder>] [--report=<file>] [--json]");
  process.exit(flag("help") || flag("h") ? 0 : 2);
}

const libraryDir = value("library-dir");
if (libraryDir) process.env.FEATURE_TOUR_SCREENSHOTS_DIR = path.resolve(libraryDir);

const { resolveGeneratedLabsDir, resolvePortalDataDir } = await import(pathToFileURL(path.join(portalLib, "storage-config.js")).href);
const { capturedScreenshotsDir, capturedScreenshotsDirs } = await import(pathToFileURL(path.join(portalLib, "lab-builder/captured.js")).href);
const { createScreenshotStore } = await import(pathToFileURL(path.join(portalLib, "capture/screenshot-store.js")).href);

const apply = flag("apply");
const root = path.resolve(value("root") || resolveGeneratedLabsDir());
const dataDir = path.resolve(value("data") || resolvePortalDataDir());
const only = value("lab");
const reportFile = value("report");

if (!fs.existsSync(root)) {
  console.error(`No generated labs folder at ${root}.`);
  process.exit(2);
}
if (reportFile) {
  const rel = path.relative(repoRoot, path.resolve(reportFile));
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
    console.error(`Refusing to write the report inside this repository (${path.resolve(reportFile)}). Choose a folder outside it.`);
    process.exit(2);
  }
}

const library = libraryDir ? path.resolve(libraryDir) : null;
const store = createScreenshotStore({
  generatedRoot: root,
  captureDir: path.join(dataDir, "capture"),
  capturedDirs: () => (library ? { primary: library, search: [library] } : { primary: capturedScreenshotsDir(), search: capturedScreenshotsDirs() }),
});

const result = store.quarantineWrongPictures({ dryRun: !apply, includeProbable: flag("include-probable"), labId: only });
if (result.status !== 200) {
  console.error(result.body?.error || `The request failed (${result.status}).`);
  process.exit(2);
}
const body = result.body;
// Labs that show a moved shared picture are rebuilt in the background; wait for it so the run leaves everything consistent.
if (apply) await store.flushLibrary().catch(() => {});

const summary = {
  mode: apply ? "apply" : "dry-run",
  library: library || capturedScreenshotsDir(),
  root,
  counts: body.counts,
  moved: body.moved,
  failed: body.failed || [],
  notMoved: body.notMoved,
  pictures: body.pictures.map(({ scope, labId, filename, level, reason, derived }) => ({ scope, labId, filename, level, reason, derived })),
};

if (reportFile) {
  fs.mkdirSync(path.dirname(path.resolve(reportFile)), { recursive: true });
  fs.writeFileSync(path.resolve(reportFile), `# Pictures that look wrong\n\n${apply ? "Applied" : "Dry run (nothing was changed)"}.\n\n${body.report}\n`);
  console.error(`Wrote the report: ${path.resolve(reportFile)}`);
}
if (flag("json")) {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} else {
  console.log(`Shared library: ${summary.library}`);
  console.log(`Generated labs: ${root}`);
  console.log(body.report);
  if (!apply && body.counts.pictures) console.log("Run again with --apply to move them. They are kept for 90 days and can be restored.");
}
process.exit(body.failed?.length ? 1 : 0);
