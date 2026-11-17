#!/usr/bin/env node
// Looks for bad expected-label data in the lab catalog and the feature tour shot lists: labels the screenshot
// checks cannot use (a placeholder, a sentence, only stop words, a generic word) and words that look like a typo
// of a word used much more often elsewhere ("form" next to "scratch"). Labels come from bold text in lab steps, from
// callouts, and from shot instructions, and a wrong one makes a correct screenshot look wrong.
//
//   node scan-labels.mjs            print a report (exit 1 when something unusable or suspicious is found)
//   node scan-labels.mjs --json     the same as JSON
//
// It never edits a file: a label that is fixed at its source is a decision for a person. Typos that come from
// Microsoft Learn text itself are corrected when labels are used (see KNOWN_TYPOS in labels.mjs).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { cleanExpectedLabel, normalizeText, tokenize } from "./labels.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const BOLD = /\*\*([^*]{1,80})\*\*/g;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Every label-like string with where it came from. */
export function collectLabels({ root = repoRoot } = {}) {
  const out = [];
  const add = (label, where) => {
    const text = String(label ?? "").trim();
    if (text) out.push({ label: text, where });
  };
  const boldIn = (lines, where) => {
    for (const line of Array.isArray(lines) ? lines : []) for (const m of String(line).matchAll(BOLD)) add(m[1], where);
  };

  const features = readJson(path.join(root, "portal", "lib", "lab-builder", "features.json"));
  for (const feature of features?.features || []) boldIn(feature.steps, `features.json ${feature.id} steps`);

  const catalogDir = path.join(root, "portal", "lib", "lab-builder", "catalog");
  if (fs.existsSync(catalogDir)) {
    for (const name of fs.readdirSync(catalogDir).filter((n) => n.endsWith(".json"))) {
      const data = readJson(path.join(catalogDir, name));
      for (const feature of data?.features || []) boldIn(feature.steps, `catalog/${name} ${feature.id} steps`);
    }
  }

  const overlay = readJson(path.join(root, "tools", "feature-tour", "overlay.json"));
  for (const [feature, shots] of Object.entries(overlay?.shots || {})) {
    for (const shot of shots) {
      for (const c of shot.callouts || []) add(c.text || c.label, `overlay.json ${feature} ${shot.filename} callout`);
      boldIn(shot.instructions, `overlay.json ${feature} ${shot.filename} instructions`);
    }
  }

  const toolDir = path.join(root, "tools", "screenshot-capture");
  for (const name of fs.readdirSync(toolDir).filter((n) => /^feature-shots.*\.json$/.test(n))) {
    const data = readJson(path.join(toolDir, name));
    for (const shot of data?.shots || []) {
      for (const c of shot.callouts || []) add(c.text || c.label, `${name} ${shot.filename} callout`);
      boldIn(shot.instructions, `${name} ${shot.filename} instructions`);
      boldIn(shot.setup, `${name} ${shot.filename} setup`);
    }
  }
  return out;
}

/** The report: labels that cannot be used, labels that were corrected, and words that look like typos. */
export function scanLabels(entries) {
  const frequency = new Map();
  for (const { label } of entries) for (const token of tokenize(label)) frequency.set(token, (frequency.get(token) || 0) + 1);

  const unusable = [];
  const corrected = [];
  const suspicious = [];
  const seen = new Set();
  for (const { label, where } of entries) {
    const key = `${normalizeText(label)}|${where}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const cleaned = cleanExpectedLabel(label);
    if (cleaned === null) {
      unusable.push({ label, where });
      continue;
    }
    if (normalizeText(cleaned) !== normalizeText(label)) corrected.push({ label, as: cleaned, where });
    for (const token of tokenize(label)) {
      if (token.length < 4 || frequency.get(token) > 1) continue;
      // The mistake people make while typing: two neighboring letters swapped ("form" for "from").
      const likely = [...frequency].find(([word, count]) => count >= 4 && word !== token && swappedLetters(token, word));
      if (likely) suspicious.push({ label, word: token, looksLike: likely[0], where });
    }
  }
  return { total: entries.length, unusable, corrected, suspicious };
}

function swappedLetters(a, b) {
  if (a.length !== b.length) return false;
  const diff = [];
  for (let i = 0; i < a.length && diff.length < 3; i += 1) if (a[i] !== b[i]) diff.push(i);
  return diff.length === 2 && diff[1] === diff[0] + 1 && a[diff[0]] === b[diff[1]] && a[diff[1]] === b[diff[0]];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const report = scanLabels(collectLabels());
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Scanned ${report.total} labels.`);
    console.log(`  Unusable as a check (dropped when used): ${report.unusable.length}`);
    for (const item of report.unusable.slice(0, 40)) console.log(`    "${item.label}"  (${item.where})`);
    console.log(`  Corrected when used: ${report.corrected.length}`);
    for (const item of report.corrected.slice(0, 40)) console.log(`    "${item.label}" -> "${item.as}"  (${item.where})`);
    console.log(`  Words that look like a typo: ${report.suspicious.length}`);
    for (const item of report.suspicious.slice(0, 40)) console.log(`    "${item.word}" looks like "${item.looksLike}" in "${item.label}"  (${item.where})`);
  }
  process.exit(report.suspicious.length || report.corrected.length ? 1 : 0);
}
