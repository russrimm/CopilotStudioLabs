#!/usr/bin/env node
/**
 * Emoji inventory: lists every emoji in the text files of a folder and says which ones people can see.
 *
 *   node tools/lab-builder/find-emoji.mjs                   count per bucket for the whole repository
 *   node tools/lab-builder/find-emoji.mjs --list            every hit: file, line, symbol, bucket, visible or internal
 *   node tools/lab-builder/find-emoji.mjs --visible         only the hits people can see (fix these)
 *   node tools/lab-builder/find-emoji.mjs --json            the full result as JSON
 *   node tools/lab-builder/find-emoji.mjs --dir portal      scan another folder (git-tracked files when it is a checkout)
 *   node tools/lab-builder/find-emoji.mjs --bucket portal-ui --list
 *   node tools/lab-builder/find-emoji.mjs --fail            exit 1 when an in-scope visible hit remains
 *
 * "Emoji" means the Unicode property Extended_Pictographic, written as the symbol or as an escape (\u0000 style or an HTML entity), plus emoji sequences (variation selector 16, joiners,
 * skin tones, flags, keycaps), less the legal marks and checkbox glyphs the product keeps (see plain-text.js). The
 * status glyphs the product also treats as emoji (check and cross marks such as the heavy check mark) are listed too.
 *
 * Buckets say where a hit lives (the portal screens, the generated lab templates, data people see, notification text,
 * server messages) or why it is left alone (hand-written labs, docs prose, companion and scripts, tests, vendor files).
 * A hit on a comment line or a developer log line is "internal": nothing a person reads.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const { emojiMatches, escapedEmojiMatches, symbolSuggestion } = await import(
  pathToFileURL(path.join(REPO_ROOT, "portal", "lib", "lab-builder", "plain-text.js")).href
);

const BINARY = /\.(png|jpe?g|gif|ico|zip|pptx|docx|pdf|woff2?|ttf|otf|xlsx|webp|mp4|svg|lock)$/i;
const SKIP_DIRS = new Set(["node_modules", ".git", ".copilot", "dist", "coverage"]);

// Buckets are checked in order; the first match wins. `scope` says whether this task removes the hit.
const BUCKETS = [
  { name: "vendor", scope: "left", test: (p) => /(^|\/)vendor\//.test(p) || /\.min\.js$/.test(p), why: "third-party library code" },
  { name: "hand-written-labs", scope: "left", test: (p) => p.startsWith("labs/"), why: "the hand-written labs are not changed" },
  { name: "energy-genius", scope: "left", test: (p) => p.startsWith("Energy Genius/"), why: "topic files are out of scope" },
  { name: "workflows", scope: "left", test: (p) => p.startsWith(".github/"), why: "workflow files are out of scope" },
  { name: "scripts-and-cli", scope: "left", test: (p) => /^(scripts|setup\.js|edit_labs\.py|validate_labs\.py)/.test(p), why: "scripts and CLI output are out of scope" },
  { name: "companion", scope: "left", test: (p) => p.startsWith("tools/screenshot-capture/"), why: "the companion's console banners are out of scope" },
  { name: "lab-accuracy-tooling", scope: "left", test: (p) => p.startsWith("tools/lab-accuracy/"), why: "developer tooling reports, not shown to learners" },
  { name: "validation-fixtures", scope: "left", test: (p) => p === "tools/lab-builder/lib/office-matrix.mjs", why: "inputs that deliberately exercise Unicode handling in the Office validator" },
  { name: "tests", scope: "tests", test: (p) => /(^|\/)test\//.test(p) || /\.test\.(m?js)$/.test(p), why: "test files assert the plain text" },
  { name: "docs", scope: "docs", test: (p) => p.startsWith("docs/") || /(^|\/)README\.md$/.test(p) || /\.md$/.test(p) && !p.startsWith("portal/"), why: "documentation prose" },
  { name: "notification-text", scope: "fix", test: (p) => /^portal\/lib\/(approvals|mailer)\.js$/.test(p), why: "email and Teams card text" },
  { name: "portal-ui", scope: "fix", test: (p) => p.startsWith("portal/public/"), why: "the portal screens" },
  { name: "ui-data", scope: "fix", test: (p) => /^portal\/lib\/[^/]+\.json$/.test(p) || /^portal\/lib\/(use-cases)\//.test(p), why: "data the portal shows (cards, picklists)" },
  { name: "generated-output", scope: "fix", test: (p) => p.startsWith("portal/lib/lab-builder/") || p.startsWith("tools/lab-builder/") || p.startsWith("tools/feature-tour/") || p.startsWith("tools/lab-pdf/"), why: "templates and data that make labs, exports, decks and guides" },
  { name: "server-text", scope: "fix", test: (p) => p.startsWith("portal/"), why: "text the server sends to the browser or writes to exports" },
];

function parseArgs(argv) {
  const args = { dir: REPO_ROOT, json: false, list: false, visible: false, fail: false, bucket: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--dir") args.dir = path.resolve(argv[(i += 1)] || ".");
    else if (token === "--json") args.json = true;
    else if (token === "--list") args.list = true;
    else if (token === "--visible") { args.list = true; args.visible = true; }
    else if (token === "--fail") args.fail = true;
    else if (token === "--bucket") args.bucket = argv[(i += 1)] || null;
    else if (token === "--help" || token === "-h") args.help = true;
  }
  return args;
}

function listFiles(dir) {
  try {
    const out = execFileSync("git", ["-C", dir, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] });
    const root = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
    const rel = path.relative(root, dir).split(path.sep).join("/");
    const files = out.split("\0").filter(Boolean).filter((f) => !rel || f === rel || f.startsWith(`${rel}/`));
    return files.map((f) => ({ abs: path.join(root, f), rel: rel ? path.posix.relative(rel, f) : f, repoRel: f }));
  } catch {
    const files = [];
    const walk = (current) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const abs = path.join(current, entry.name);
        if (entry.isDirectory()) walk(abs);
        else {
          const rel = path.relative(dir, abs).split(path.sep).join("/");
          files.push({ abs, rel, repoRel: rel });
        }
      }
    };
    walk(dir);
    return files;
  }
}

function bucketFor(repoRel) {
  return BUCKETS.find((bucket) => bucket.test(repoRel)) || { name: "other", scope: "left", why: "not part of the product" };
}

// A line is internal when it is a comment or a developer log line; anything else can reach a person.
function lineKind(line, index, previous = []) {
  const text = line.trim();
  if (/^(\/\/|\/\*|\*|<!--|#(?!\w+;)|--\s)/.test(text)) return "comment";
  if (/\b(console\.(log|warn|error|info|debug)|process\.(stdout|stderr)\.write|logger\.\w+)\s*\(/.test(line)) return "log";
  // A string on a line of its own inside a console call that began a few lines up.
  if (previous.some((earlier, back) => /\bconsole\.(log|warn|error|info|debug)\(\s*$/.test(earlier) && !previous.slice(0, back).some((l) => /\)\s*;?\s*$/.test(l) && !/\+\s*$/.test(l) && !/,\s*$/.test(l)))) return "log";
  const before = line.slice(0, index);
  if (/(^|[^:"'`\\])\/\/[^"'`]*$/.test(before)) return "comment";
  return "text";
}

function scanFile(file) {
  if (BINARY.test(file.rel)) return [];
  let text;
  try {
    text = fs.readFileSync(file.abs, "utf8");
  } catch {
    return [];
  }
  if (text.includes("\0")) return [];
  const bucket = bucketFor(file.repoRel);
  const hits = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, lineIndex) => {
    for (const match of [...emojiMatches(line), ...escapedEmojiMatches(line)]) {
      const kind = lineKind(line, match.index, lines.slice(Math.max(0, lineIndex - 4), lineIndex).reverse());
      hits.push({
        file: file.repoRel,
        line: lineIndex + 1,
        column: match.index + 1,
        symbol: match.symbol,
        codePoints: [...match.symbol].map((ch) => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`).join(" "),
        name: symbolSuggestion(match.symbol).name,
        suggestion: symbolSuggestion(match.symbol).words,
        bucket: bucket.name,
        scope: bucket.scope,
        kind,
        userVisible: kind === "text" && bucket.scope !== "left",
        text: line.trim().slice(0, 140),
      });
    }
  });
  return hits;
}

function summarize(hits) {
  const buckets = {};
  for (const hit of hits) {
    const entry = (buckets[hit.bucket] ||= { total: 0, visible: 0, internal: 0, scope: hit.scope });
    entry.total += 1;
    if (hit.userVisible) entry.visible += 1;
    else entry.internal += 1;
  }
  const symbols = {};
  for (const hit of hits) {
    if (hit.scope !== "fix") continue;
    const entry = (symbols[hit.symbol] ||= { symbol: hit.symbol, name: hit.name, count: 0, replacement: hit.suggestion });
    entry.count += 1;
  }
  const files = {};
  for (const hit of hits) files[hit.file] = (files[hit.file] || 0) + 1;
  return { buckets, symbols: Object.values(symbols).sort((a, b) => b.count - a.count), files };
}

export function findEmoji(dir = REPO_ROOT) {
  return listFiles(dir).flatMap(scanFile);
}

export { BUCKETS, summarize };

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: node tools/lab-builder/find-emoji.mjs [--dir <folder>] [--list|--visible|--json] [--bucket <name>] [--fail]");
    process.exit(0);
  }

  let hits = findEmoji(args.dir);
  if (args.bucket) hits = hits.filter((hit) => hit.bucket === args.bucket);
  const summary = summarize(hits);

  if (args.json) {
    console.log(JSON.stringify({ total: hits.length, buckets: summary.buckets, symbols: summary.symbols, hits }, null, 2));
  } else if (args.list) {
    for (const hit of hits.filter((h) => !args.visible || h.userVisible)) {
      const flag = hit.userVisible ? "VISIBLE " : "internal";
      console.log(`${hit.file}:${hit.line}:${hit.column}  ${hit.symbol}  ${hit.codePoints}  [${hit.bucket}/${flag}]  ${hit.text}`);
    }
  } else {
    const rows = Object.entries(summary.buckets).sort((a, b) => b[1].total - a[1].total);
    console.log("bucket".padEnd(24), "total".padStart(6), "visible".padStart(8), "internal".padStart(9), " scope  reason");
    for (const [name, entry] of rows) {
      const reason = BUCKETS.find((b) => b.name === name)?.why || "";
      console.log(name.padEnd(24), String(entry.total).padStart(6), String(entry.visible).padStart(8), String(entry.internal).padStart(9), ` ${entry.scope.padEnd(6)} ${reason}`);
    }
    const inScope = hits.filter((h) => h.scope === "fix");
    console.log(`\nIn scope (portal screens and generated output): ${inScope.length} hits, ${inScope.filter((h) => h.userVisible).length} visible, ${inScope.filter((h) => !h.userVisible).length} internal.`);
    if (summary.symbols.length) {
      console.log("\nSymbols in scope:");
      for (const s of summary.symbols) console.log(`  ${String(s.count).padStart(4)}  ${s.symbol}  ${s.name}  ->  ${JSON.stringify(s.replacement)}`);
    }
  }

  if (args.fail && hits.some((h) => h.scope === "fix" && h.userVisible)) process.exit(1);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main();
