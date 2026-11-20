#!/usr/bin/env node
/**
 * Lab gate CLI: scores finished labs for gaps a teacher would hit.
 *
 *   node tools/lab-builder/lab-gate.mjs                       every lab under labs/ and generated-labs/
 *   node tools/lab-builder/lab-gate.mjs path/to/lab path/to/root
 *   node tools/lab-builder/lab-gate.mjs --all --json
 *   node tools/lab-builder/lab-gate.mjs generated-labs --fail-on gap
 *
 * A path is either one lab folder (it has an index.md) or a folder of lab folders. Nothing is written and nothing
 * is fetched. Exit code 0 unless --fail-on gap is given and any lab has a gap (then 1).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const LIB = path.join(REPO_ROOT, "portal", "lib", "lab-builder");
const { scanLabDirectory, formatGateReport } = await import(pathToFileURL(path.join(LIB, "lab-gate.js")).href);

function parseArgs(argv) {
  const args = { paths: [], json: false, all: false, failOn: null };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--json") args.json = true;
    else if (token === "--all") args.all = true;
    else if (token === "--fail-on") args.failOn = argv[(i += 1)];
    else if (token.startsWith("--fail-on=")) args.failOn = token.slice("--fail-on=".length);
    else if (token === "--help" || token === "-h") args.help = true;
    else if (!token.startsWith("--")) args.paths.push(token);
  }
  return args;
}

function labFolders(target) {
  const dir = path.resolve(target);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  if (fs.existsSync(path.join(dir, "index.md"))) return [dir];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, "index.md")))
    .map((entry) => path.join(dir, entry.name));
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log("Usage: node tools/lab-builder/lab-gate.mjs [lab-or-folder...] [--all] [--json] [--fail-on gap]");
  process.exit(0);
}
if (args.failOn && args.failOn !== "gap") {
  console.error('--fail-on accepts only "gap".');
  process.exit(1);
}

const targets = args.paths.length ? args.paths : [path.join(REPO_ROOT, "labs"), path.join(REPO_ROOT, "generated-labs")];
const folders = targets.flatMap(labFolders);
if (!folders.length) {
  console.error("No labs found. Pass a lab folder or a folder of labs.");
  process.exit(1);
}

const results = folders.map((folder) => scanLabDirectory(folder));
if (args.json) {
  console.log(JSON.stringify({ labs: results.length, results }, null, 2));
} else {
  for (const result of results) console.log(`${formatGateReport(result, { all: args.all })}\n`);
  const sum = (key) => results.reduce((total, result) => total + result.totals[key], 0);
  const grades = results.reduce((acc, result) => ({ ...acc, [result.grade]: (acc[result.grade] || 0) + 1 }), {});
  console.log(
    `${results.length} lab(s): ${Object.entries(grades)
      .map(([grade, n]) => `${n} ${grade}`)
      .join(", ")}. ${sum("gaps")} gap(s), ${sum("pendingPictures")} pending picture(s), ${sum("cutOffSteps")} cut-off step(s), ` +
      `${sum("unverifiedLines") + sum("notConfirmedLines")} line(s) flagged as not confirmed.`,
  );
}
if (args.failOn === "gap" && results.some((result) => result.totals.gaps > 0)) process.exit(1);
