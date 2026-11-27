#!/usr/bin/env node
// Move STAGED pictures (the ones waiting for review) that were taken in the WRONG harness to the kept pictures list: for every lab and for the
// shared library, a picture waiting for review whose screenshot needs one harness (Standard (Classic), Microsoft Copilot) but that was taken in
// another. The harness is read the way the Screenshot Center reads it: the companion's proof (the tabs it read from the page), else the shape
// of the address the picture was taken on (/agents/<id> is a Microsoft Copilot agent page, /bots/<id> a Standard one).
//
//   node tools/lab-builder/quarantine-wrong-harness.mjs --dry-run --root=<generated-labs> --data=<portal data> --library-dir=<library>
//                                                                        say what would move; change nothing (the default)
//   node tools/lab-builder/quarantine-wrong-harness.mjs --apply ...      move them (a separate, deliberate step)
//   node tools/lab-builder/quarantine-wrong-harness.mjs --apply --lab=<id>   the shared library and one lab
//   node tools/lab-builder/quarantine-wrong-harness.mjs --dry-run --report=<file>   write the plain report (outside this repository)
//   node tools/lab-builder/quarantine-wrong-harness.mjs --dry-run --json            the result as JSON
//
// Where things live (the same rules as quarantine-screenshots.mjs): --root=<generated-labs folder>, --library-dir=<folder> (the shared
// library), --data=<portal data folder> (its saved checks and the staged pictures); the kept pictures list follows the library folder.
//
// Every picture is first saved in the kept pictures list (with its saved check and its callouts, reason wrong-harness), read back and compared with
// the staged bytes, and only then cleared from the staging folder; its screenshot goes back to what it was before the picture was staged (the
// picture already in place, if any, is not touched). A picture that only lacks a proof of its harness (harness-unproven) is never moved: a person
// looks at it and accepts it, or not. Nothing moves without --apply.

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
  console.error("Usage: node tools/lab-builder/quarantine-wrong-harness.mjs [--dry-run | --apply] [--lab=<id>] [--root=<folder>] [--library-dir=<folder>] [--data=<folder>] [--report=<file>] [--json]");
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

const result = store.quarantineWrongHarnessStaged({ dryRun: !apply, labId: only });
if (result.status !== 200) {
  console.error(result.body?.error || `The request failed (${result.status}).`);
  process.exit(2);
}
const body = result.body;

const summary = {
  mode: apply ? "apply" : "dry-run",
  library: library || capturedScreenshotsDir(),
  root,
  counts: body.counts,
  moved: body.moved,
  failed: body.failed || [],
  notMoved: body.notMoved,
  pictures: body.pictures.map(({ scope, labId, filename, harness, pictureHarness, harnessSource, reason }) => ({ scope, labId, filename, needs: harness, shows: pictureHarness, read: harnessSource, reason })),
};

if (reportFile) {
  fs.mkdirSync(path.dirname(path.resolve(reportFile)), { recursive: true });
  fs.writeFileSync(path.resolve(reportFile), `# Staged pictures taken in the wrong harness\n\n${apply ? "Applied" : "Dry run (nothing was changed)"}.\n\n${body.report}\n`);
  console.error(`Wrote the report: ${path.resolve(reportFile)}`);
}
if (flag("json")) {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} else {
  console.log(`Shared library: ${summary.library}`);
  console.log(`Generated labs: ${root}`);
  console.log(body.report);
  if (!apply && body.counts.pictures) console.log("Run again with --apply to move them. They are kept for 90 days.");
}
process.exit(body.failed?.length ? 1 : 0);
