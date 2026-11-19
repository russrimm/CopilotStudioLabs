#!/usr/bin/env node
// One-off repair for generated labs built while placeholder pictures counted as captured screenshots.
//
//   node tools/lab-builder/repair-placeholders.mjs --dry-run            report only, change nothing
//   node tools/lab-builder/repair-placeholders.mjs --apply              repair every affected lab
//   node tools/lab-builder/repair-placeholders.mjs --apply --lab=<id>   repair one lab
//   node tools/lab-builder/repair-placeholders.mjs --dry-run --json     machine-readable report
//
// Where the labs live: --root=<folder>, otherwise the portal's own rules (LAB_BUILDER_OUTPUT_DIR, then
// ${PORTAL_STORAGE_ROOT}/generated-labs, then generated-labs/ in this repository).
//
// For each affected lab, every filler picture in assets/ (a copy of a known placeholder, a stamped placeholder, or a
// picture matching the placeholder layout) is replaced with the standard "Screenshot pending" image, its slot becomes
// a pending slot in screenshots/shots.json and learn-state.json, and index.html, the topic documents, and the manifest
// summary are regenerated. Real captures are never touched, and a lab with nothing to repair is not written. The portal
// runs the same repair on its own the next time a lab is opened, listed, or exported; this tool does it up front.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const portalLib = path.resolve(here, "../../portal/lib");

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;

if (flag("help") || flag("h") || flag("dry-run") === flag("apply")) {
  console.error("Usage: node tools/lab-builder/repair-placeholders.mjs (--dry-run | --apply) [--lab=<id>] [--root=<folder>] [--json]");
  process.exit(flag("help") || flag("h") ? 0 : 2);
}

const { resolveGeneratedLabsDir } = await import(pathToFileURL(path.join(portalLib, "storage-config.js")).href);
const { repairLabPlaceholders } = await import(pathToFileURL(path.join(portalLib, "lab-builder/lab-screenshots.js")).href);

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

const report = { root, mode: dryRun ? "dry-run" : "apply", labs: [], totals: { labs: labs.length, affected: 0, placeholders: 0, slots: 0, repaired: 0, errors: 0 } };
for (const labId of labs) {
  const result = repairLabPlaceholders(path.join(root, labId), { labId, dryRun });
  if (!result.placeholders.length && !result.error) continue;
  report.labs.push({ labId, placeholders: result.placeholders.length, slots: result.slots.length, repaired: result.changed, busy: Boolean(result.busy), error: result.error || null, files: result.placeholders.map((p) => p.filename) });
  report.totals.affected += 1;
  report.totals.placeholders += result.placeholders.length;
  report.totals.slots += result.slots.length;
  if (result.changed) report.totals.repaired += 1;
  if (result.error) report.totals.errors += 1;
}

if (flag("json")) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  console.log(`Generated labs in ${root}: ${report.totals.labs} checked, ${report.totals.affected} with placeholder pictures (${dryRun ? "dry run, nothing changed" : "apply"}).`);
  for (const lab of report.labs) {
    const state = lab.error ? `ERROR ${lab.error}` : lab.repaired ? "repaired" : lab.busy ? "another process is repairing it" : dryRun ? "would repair" : "unchanged";
    console.log(`  ${lab.labId}: ${lab.placeholders} placeholder picture(s), ${lab.slots} slot(s) back to pending: ${state}`);
  }
  console.log(`Total: ${report.totals.placeholders} placeholder picture(s), ${report.totals.slots} slot(s)${dryRun ? "" : `, ${report.totals.repaired} lab(s) repaired`}.`);
}
process.exit(report.totals.errors ? 1 : 0);
