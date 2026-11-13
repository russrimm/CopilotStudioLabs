#!/usr/bin/env node
/**
 * Refresh the committed Microsoft Learn topic snapshot.
 *
 *   node tools/lab-builder/refresh-topics.mjs            refresh and write the snapshot if topics changed
 *   node tools/lab-builder/refresh-topics.mjs --check    discover and report, write nothing
 *   node tools/lab-builder/refresh-topics.mjs --out <file> --summary <file>
 *
 * The snapshot is only rewritten when the topic list changed, so a scheduled
 * run that finds nothing new leaves the working tree clean and opens no pull
 * request. When GITHUB_OUTPUT is set the result is published as `changed`.
 * A run that cannot reach Microsoft Learn exits non-zero and writes nothing.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const lib = (name) => import(new URL(`../../portal/lib/lab-builder/${name}`, import.meta.url));

const { discoverFromLearn } = await lib("topic-service.js");
const { readSnapshot, summarize, validateSnapshot, writeJsonAtomic } = await lib("topic-snapshot.js");
const { getFeatures } = await lib("catalog.js");

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const snapshotPath = path.resolve(option("--out") || path.join(root, "portal", "lib", "lab-builder", "learn-topics.snapshot.json"));
const summaryPath = option("--summary");
const check = flag("--check");

function summaryMarkdown(snapshot, previous, changed) {
  const counts = summarize(snapshot, getFeatures());
  const names = { standard: "Standard", "microsoft-copilot": "Microsoft Copilot harness", "customer-conversation": "Customer Conversation" };
  const rows = Object.entries(counts).map(([id, c]) => `| ${names[id] || id} | ${c.covered} | ${c.new} | ${c.stale} | ${c.updated} |`);
  const before = new Set((previous?.topics || []).map((t) => t.id));
  const added = snapshot.topics.filter((t) => t.status === "new" && !before.has(t.id));
  const stale = snapshot.catalog.filter((c) => c.status === "stale");
  const updated = snapshot.catalog.filter((c) => c.status === "updated" && c.changedAt === snapshot.generatedAt.slice(0, 10));
  return [
    `Microsoft Learn topic snapshot generated ${snapshot.generatedAt} (${changed ? "changed" : "no change"}${snapshot.partial ? `, partial: ${snapshot.partialReason}` : ""}).`,
    "",
    "| Harness | Covered | New | Stale | Updated |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...rows,
    "",
    `${snapshot.topics.length} topics, ${snapshot.stats.calls} Learn MCP calls.`,
    ...(added.length ? ["", "New topics since the last snapshot:", ...added.slice(0, 40).map((t) => `- ${t.title} (${t.urls[0]})`)] : []),
    ...(stale.length ? ["", "Catalog features whose documentation pages are gone:", ...stale.map((c) => `- ${c.featureId}: ${c.missing.join(", ")}`)] : []),
    ...(updated.length ? ["", "Catalog features whose documentation changed:", ...updated.map((c) => `- ${c.featureId}`)] : []),
    "",
  ].join("\n");
}

const previous = readSnapshot(snapshotPath);
let snapshot;
try {
  snapshot = await discoverFromLearn({ previous, onProgress: (message) => console.error(`[refresh-topics] ${message}`) });
} catch (err) {
  console.error(`[refresh-topics] ${err.message}`);
  process.exit(1);
}

const problems = validateSnapshot(snapshot);
if (problems.length) {
  console.error(`[refresh-topics] The discovered snapshot is invalid, so nothing was written:\n- ${problems.slice(0, 10).join("\n- ")}`);
  process.exit(1);
}
if (snapshot.partial && !flag("--allow-partial")) {
  console.error(`[refresh-topics] The run was cut short (${snapshot.partialReason}), so nothing was written. Raise the limits or pass --allow-partial.`);
  process.exit(1);
}

const changed = !previous || previous.listHash !== snapshot.listHash;
const markdown = summaryMarkdown(snapshot, previous, changed);
console.log(markdown);

if (summaryPath) fs.writeFileSync(path.resolve(summaryPath), markdown, "utf8");
if (changed && !check) {
  writeJsonAtomic(snapshotPath, snapshot);
  console.error(`[refresh-topics] Wrote ${path.relative(root, snapshotPath)}`);
}
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed && !check}\n`);
