#!/usr/bin/env node
/**
 * Export every topic and sub-topic the Lab Builder offers for the products you choose.
 *
 *   node tools/lab-builder/export-topics.mjs --products copilot-studio,sharepoint-ai --harness standard
 *   node tools/lab-builder/export-topics.mjs --format markdown --out topics.md
 *   node tools/lab-builder/export-topics.mjs --format json --out -        write to standard output
 *
 * It is the same export as the "Export All Topics" button in Step 6 of the wizard (and POST
 * /api/lab-builder/topics/export): every topic and sub-topic at every level, as CSV (UTF-8 with a
 * byte order mark, so Excel opens it), Markdown, or JSON. The topic list comes from the committed
 * Microsoft Learn snapshot (or the newer runtime cache when one exists); nothing is fetched.
 *
 * Flags:
 *   --products <a,b>        product ids (default copilot-studio)
 *   --harness <id>          the Copilot Studio harness (default standard)
 *   --industry <id>         vertical, only used for the "Recommended" columns
 *   --departments <a,b>     departments, only used for the "Recommended" columns
 *   --format <csv|markdown|json>   default csv
 *   --out <file|->          where to write (default: a descriptive file name in the current folder)
 *   --selected <a,b>        topic ids to mark in "Selected in my lab"
 *   --exclude-subtopics <a,b>  sub-topic ids to mark as not selected
 *   --help
 */

import fs from "node:fs";
import path from "node:path";

const lib = (name) => import(new URL(`../../portal/lib/lab-builder/${name}`, import.meta.url));

const { buildTopicExport, exportFileName, normalizeExportRequest, serialize } = await lib("topic-export.js");
const { loadBest, topicConfig } = await lib("topic-store.js");

const args = process.argv.slice(2);
const FLAGS = new Set(["products", "harness", "industry", "departments", "format", "out", "selected", "exclude-subtopics", "help"]);

function parse(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument "${token}".`);
    const eq = token.indexOf("=");
    const key = eq > -1 ? token.slice(2, eq) : token.slice(2);
    if (!FLAGS.has(key)) throw new Error(`Unknown flag --${key}. Run with --help.`);
    if (key === "help") {
      out.help = true;
      continue;
    }
    const value = eq > -1 ? token.slice(eq + 1) : argv[(i += 1)];
    if (value === undefined || (eq === -1 && value.startsWith("--") && value !== "--")) throw new Error(`--${key} needs a value.`);
    out[key] = value;
  }
  return out;
}

const list = (text) => String(text || "").split(",").map((part) => part.trim()).filter(Boolean);

let flags;
try {
  flags = parse(args);
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
if (flags.help) {
  console.log(`Export every topic and sub-topic for the chosen products.

Usage:
  node tools/lab-builder/export-topics.mjs [flags]

Flags:
  --products <a,b>           product ids (default copilot-studio)
  --harness <id>             the Copilot Studio harness (default standard)
  --industry <id>            vertical, only used for the "Recommended" columns
  --departments <a,b>        departments, only used for the "Recommended" columns
  --format <csv|markdown|json>  default csv (UTF-8 with a byte order mark, so Excel opens it)
  --out <file|->             where to write (default: a descriptive file name in the current folder)
  --selected <a,b>           topic ids to mark in "Selected in my lab"
  --exclude-subtopics <a,b>  sub-topic ids to mark as not selected
  --help                     show this message`);
  process.exit(0);
}

try {
  const request = normalizeExportRequest({
    products: flags.products === undefined ? undefined : list(flags.products),
    harness: flags.harness,
    industry: flags.industry,
    departments: list(flags.departments),
    format: flags.format || "csv",
    selectedIds: list(flags.selected),
    excludedSubtopics: list(flags["exclude-subtopics"]),
  });
  if (request.format === "dataset") throw new Error("format must be one of csv, markdown, json.");
  const best = loadBest(topicConfig());
  const learn = { topics: best?.snapshot?.topics || [], checks: best?.snapshot?.catalog || [], updatedWindowDays: 30 };
  const dataset = buildTopicExport({ ...request, learn });
  const text = serialize(request.format, dataset, { selectedIds: request.selection.selectedIds, excludedSubtopics: request.selection.excludedSubtopics });
  if (flags.out === "-") {
    process.stdout.write(text);
  } else {
    const file = path.resolve(flags.out || exportFileName(dataset, request.format));
    fs.writeFileSync(file, text, "utf8");
    console.error(`${dataset.scope.text}\nWrote ${path.relative(process.cwd(), file) || file}`);
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
