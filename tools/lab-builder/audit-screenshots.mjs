#!/usr/bin/env node
// Audit every screenshot the portal can show, and say which ones look like the WRONG screen. Read-only: it never writes,
// moves, or deletes a picture. It writes a plain Markdown report, a JSON file, and an HTML contact sheet to a folder OUTSIDE this
// repository (real pictures can show names and account details, so they never belong in the repository).
//
//   node tools/lab-builder/audit-screenshots.mjs --out=<folder outside the repo>              library and every lab
//   node tools/lab-builder/audit-screenshots.mjs --library --out=<folder>                     the shared library only
//   node tools/lab-builder/audit-screenshots.mjs --labs --out=<folder>                        every lab's own pictures only
//   node tools/lab-builder/audit-screenshots.mjs --json                                       the JSON on standard output
//   node tools/lab-builder/audit-screenshots.mjs --report=<file.md> [--json-file=<file>] [--html=<file>]
//
// Where things live (the same rules as share-lab-screenshots.mjs): --root=<generated-labs folder>, --library-dir=<folder>
// (the shared library), --data=<portal data folder> (its saved checks). Without them the portal's own rules apply
// (LAB_BUILDER_OUTPUT_DIR, FEATURE_TOUR_SCREENSHOTS_DIR, PORTAL_STORAGE_ROOT, then this repository).
//
// For every picture it reports: SHA-256, a perceptual fingerprint, clusters of identical and near-identical pictures under
// different slots, the screen the slot expects, what the saved check says the computer did, and these flags:
//   DUPLICATE_ACROSS_SLOTS  the same bytes under slots that cannot all be right
//   NEAR_DUPLICATE          a picture that looks the same (fingerprint distance <= 12 of 256) under different slots
//   LANDING_PAGE            a start page (or the agent's main tab) for a slot that describes something deeper
//   SIGNED_OUT_OR_MARKETING a sign-in cue was recorded, or no account control was found on the page
//   WRONG_PRODUCT           the page address is not one of the slot's product's pages
//   POSSIBLE_IDENTITY       masking was not applied, or a start page an older companion could not mask
// It does not read text in a picture (there is no OCR): it cannot see a name, a greeting, an account chip, or a list of recent
// chats. See docs/lab-builder.md.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const portalLib = path.resolve(repoRoot, "portal/lib");

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;

if (flag("help") || flag("h")) {
  console.error("Usage: node tools/lab-builder/audit-screenshots.mjs [--library] [--labs] [--lab=<id>] [--root=<folder>] [--library-dir=<folder>] [--data=<folder>] [--out=<folder> | --report=<file.md> --json-file=<file> --html=<file>] [--json]");
  process.exit(0);
}

const libraryDir = value("library-dir");
if (libraryDir) process.env.FEATURE_TOUR_SCREENSHOTS_DIR = path.resolve(libraryDir);

const { resolveGeneratedLabsDir, resolvePortalDataDir } = await import(pathToFileURL(path.join(portalLib, "storage-config.js")).href);
const { capturedScreenshotsDir, capturedScreenshotsDirs } = await import(pathToFileURL(path.join(portalLib, "lab-builder/captured.js")).href);
const { createPictureScanner } = await import(pathToFileURL(path.join(portalLib, "capture/picture-inventory.js")).href);
const { buildAuditReport, renderMarkdown, renderContactSheet } = await import(pathToFileURL(path.join(portalLib, "capture/picture-audit-report.js")).href);

const onlyLibrary = flag("library") && !flag("labs");
const onlyLabs = flag("labs") && !flag("library");
const only = value("lab");
const root = path.resolve(value("root") || resolveGeneratedLabsDir());
const dataDir = path.resolve(value("data") || resolvePortalDataDir());
const captureDir = path.join(dataDir, "capture");

// Pictures can show real names and accounts: never write the report into this repository.
const outDir = value("out") ? path.resolve(value("out")) : null;
const targets = { md: value("report"), json: value("json-file"), html: value("html") };
if (outDir) {
  targets.md ||= path.join(outDir, "audit.md");
  targets.json ||= path.join(outDir, "audit.json");
  targets.html ||= path.join(outDir, "contact-sheet.html");
}
for (const [kind, file] of Object.entries(targets)) {
  if (!file) continue;
  const rel = path.relative(repoRoot, path.resolve(file));
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
    console.error(`Refusing to write the ${kind} report inside this repository (${path.resolve(file)}). Real pictures can show names and account details: choose a folder outside it.`);
    process.exit(2);
  }
}

const library = libraryDir ? path.resolve(libraryDir) : null;
const scanner = createPictureScanner({
  generatedRoot: root,
  captureDir,
  capturedDirs: () => (library ? { primary: library, search: [library] } : { primary: capturedScreenshotsDir(), search: capturedScreenshotsDirs() }),
});

let labIds = null;
if (onlyLibrary) labIds = [];
else if (only) labIds = [only];
const result = scanner.scan({ library: !onlyLabs, labIds });
const report = buildAuditReport(result, { root, library: library || capturedScreenshotsDir(), captureDir, mode: onlyLibrary ? "library" : onlyLabs ? "labs" : "library and labs" });

if (flag("json") && !targets.json) {
  process.stdout.write(`${JSON.stringify(report.json, null, 2)}\n`);
} else {
  for (const [kind, file] of Object.entries(targets)) {
    if (!file) continue;
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    const body = kind === "md" ? renderMarkdown(report) : kind === "json" ? `${JSON.stringify(report.json, null, 2)}\n` : renderContactSheet(report);
    fs.writeFileSync(path.resolve(file), body);
    console.log(`Wrote ${kind === "md" ? "the report" : kind === "json" ? "the JSON" : "the contact sheet"}: ${path.resolve(file)}`);
  }
  const c = report.json.counts;
  console.log(`${c.pictures} pictures checked (${report.json.distinct} distinct). ${c.total} flagged: ${c.definite} definite, ${c.probable} probable.`);
  for (const [code, n] of Object.entries(c.byFlag).sort()) console.log(`  ${code}: ${n}`);
  if (!Object.values(targets).some(Boolean)) console.log("Add --out=<folder outside the repository> to write the report and the contact sheet.");
}
