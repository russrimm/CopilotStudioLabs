#!/usr/bin/env node
/**
 * Connector names: check the curated table against Microsoft Learn, and add connectors to it.
 *
 *   node tools/lab-builder/verify-connector-names.mjs                    check every entry (nothing is written)
 *   node tools/lab-builder/verify-connector-names.mjs --write            also stamp today's date on the entries that match
 *   node tools/lab-builder/verify-connector-names.mjs --add shared_x,shared_y=learn-slug [--write]
 *   node tools/lab-builder/verify-connector-names.mjs --only shared_x,shared_y
 *
 * The display name of a connector is the title of its Microsoft Learn reference page
 * (https://learn.microsoft.com/connectors/<slug>/). A check reads that page through the public Learn MCP server (the same
 * reader the lab builder uses: capped concurrency, one page at a time here, a short pause between pages) and compares its
 * first heading with the table. `--add` reads the page and records that heading as the display name, with the page and the
 * date, so a name is never typed by hand. A page that cannot be read is reported and left alone.
 *
 * Exit code: 0 all match, 1 a mismatch or a rejected add, 2 a page could not be read.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const LIB = path.join(REPO_ROOT, "portal", "lib", "lab-builder");
const { CONNECTORS_DATA_PATH, LEARN_CONNECTORS_BASE } = await import(pathToFileURL(path.join(LIB, "connector-names.js")).href);
const { connect, fetchDocPage } = await import(pathToFileURL(path.join(LIB, "learn-mcp.js")).href);
const { connectorPageTitle } = await import(pathToFileURL(path.join(LIB, "connector-names-live.js")).href);

const PAUSE_MS = 250;

function parseArgs(argv) {
  const args = { write: false, add: [], only: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--write") args.write = true;
    else if (token === "--add") args.add.push(...String(argv[(i += 1)] || "").split(",").filter(Boolean));
    else if (token === "--only") args.only = String(argv[(i += 1)] || "").split(",").filter(Boolean);
    else if (token === "--help" || token === "-h") args.help = true;
  }
  return args;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readTable() {
  return JSON.parse(fs.readFileSync(CONNECTORS_DATA_PATH, "utf8"));
}

function writeTable(table) {
  table.connectors.sort((a, b) => a.apiName.localeCompare(b.apiName));
  fs.writeFileSync(CONNECTORS_DATA_PATH, `${JSON.stringify(table, null, 2)}\n`, "utf8");
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log("Usage: node tools/lab-builder/verify-connector-names.mjs [--write] [--add shared_x[=learn-slug],...] [--only shared_x,...]");
  process.exit(0);
}

const table = readTable();
const today = new Date().toLocaleDateString("en-CA");
const session = await connect();
if (!session.ok) {
  console.error(`Microsoft Learn could not be reached (${session.error}). Nothing was checked.`);
  process.exit(2);
}

let mismatches = 0;
let unreadable = 0;

async function titleFor(url) {
  const page = await fetchDocPage(session, url);
  if (page.error) return { error: page.error };
  const title = connectorPageTitle(page.markdown);
  return title ? { title } : { error: "the page is not a connector reference page" };
}

for (const spec of args.add) {
  const [apiName, slugOverride] = spec.split("=");
  if (!/^shared_[a-z0-9]+(?:[_-][a-z0-9]+)*$/.test(apiName)) {
    console.error(`Skipped "${spec}": an API name looks like shared_<name>.`);
    mismatches += 1;
    continue;
  }
  if (table.connectors.some((entry) => entry.apiName === apiName)) {
    console.log(`= ${apiName} is already in the table`);
    continue;
  }
  const slug = slugOverride || apiName.slice("shared_".length);
  const learnUrl = `${LEARN_CONNECTORS_BASE}${slug}/`;
  const result = await titleFor(learnUrl);
  await sleep(PAUSE_MS);
  if (result.error) {
    console.error(`? ${apiName}: ${learnUrl} could not be read (${result.error}); not added`);
    unreadable += 1;
    continue;
  }
  const entry = { apiName, displayName: result.title, ...(slug !== apiName.slice("shared_".length) ? { learnSlug: slug } : {}), learnUrl, verifiedAt: today };
  table.connectors.push(entry);
  console.log(`+ ${apiName} -> ${result.title}`);
}

if (!args.add.length || args.only) {
  const wanted = args.only ? new Set(args.only) : null;
  for (const entry of table.connectors) {
    if (wanted && !wanted.has(entry.apiName)) continue;
    const result = await titleFor(entry.learnUrl);
    await sleep(PAUSE_MS);
    if (result.error) {
      console.error(`? ${entry.apiName}: ${entry.learnUrl} could not be read (${result.error})`);
      unreadable += 1;
    } else if (result.title !== entry.displayName) {
      console.error(`! ${entry.apiName}: the table says "${entry.displayName}" but Learn says "${result.title}" (${entry.learnUrl})`);
      mismatches += 1;
    } else {
      if (args.write) entry.verifiedAt = today;
      console.log(`ok ${entry.apiName}: ${entry.displayName}`);
    }
  }
}

if (args.write || args.add.length) {
  if (args.add.length || !mismatches) writeTable(table);
  else console.error("Not written: fix the mismatches first.");
}
process.exit(mismatches ? 1 : unreadable ? 2 : 0);
