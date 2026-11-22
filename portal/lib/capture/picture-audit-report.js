/**
 * Turns a picture scan (picture-inventory.js) into the files the audit tool writes: a JSON summary, a plain Markdown report, and an
 * HTML contact sheet. The files hold file names, slots, counts, and reasons. The contact sheet shows the pictures by pointing at
 * the files where they are (a file address), so nothing is copied; open it only on the computer that has them.
 */

import { FLAGS, FLAG_ORDER, DEPTH_WORDS } from "./picture-integrity.js";
import { NEAR_DISTANCE } from "../../../tools/screenshot-capture/fingerprint.mjs";
import { pathToFileURL } from "node:url";

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const cell = (value) => String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

const FLAG_MEANING = Object.freeze({
  [FLAGS.DUPLICATE_ACROSS_SLOTS]: "The same picture (identical bytes) under slots that cannot all be right.",
  [FLAGS.NEAR_DUPLICATE]: `A picture that looks the same (fingerprint distance of ${NEAR_DISTANCE} or less out of 256) under different slots.`,
  [FLAGS.LANDING_PAGE]: "A start page (or the agent's main tab) for a slot that describes a deeper screen.",
  [FLAGS.SIGNED_OUT_OR_MARKETING]: "A sign-in cue was recorded, or no account control was found on the page.",
  [FLAGS.WRONG_PRODUCT]: "The page address is not one of the slot's product's pages.",
  [FLAGS.POSSIBLE_IDENTITY]: "Masking was not applied, or a start page an older companion could not mask.",
});

export const CANNOT_DETECT = Object.freeze([
  "Text in a picture. There is no OCR, so a name, a greeting, an account chip, a license chip, an email address, or a list of recent chats is never seen directly. POSSIBLE_IDENTITY only says the evidence suggests one may be there.",
  "A signed-out page, unless the saved check recorded a sign-in cue or found no account control. Checks saved by older companions do not say what the page showed.",
  "Two slots that truly show the same screen. They are listed as probable, never as definite, when the saved steps show the computer went deeper than the start page.",
  "Pictures with no saved check (put in by hand) can only be compared with other pictures; their start-page and sign-in evidence is unknown.",
]);

function recordSummary(record) {
  if (!record) return null;
  return {
    state: record.state || null,
    level: record.level || null,
    source: record.source || null,
    captureMode: record.capture?.mode || null,
    setupSource: record.capture?.setup?.source || null,
    acceptedAt: record.acceptedAt || record.checkedAt || null,
    jobId: record.jobId || null,
    companionVersion: record.companionVersion || null,
    evidenceVersion: record.evidenceVersion || null,
    finalPage: record.finalUrl ? String(record.finalUrl).replace(/^https?:\/\//, "").replace(/\?.*$/, "") : null,
    landing: record.landing ? { state: record.landing.state, page: record.landing.page, expected: record.landing.expected } : null,
    labels: record.labels ? { matched: record.labels.matched, expected: record.labels.expected, soft: record.labels.soft === true } : null,
    redaction: record.redaction ? { applied: record.redaction.applied === true, masked: record.redaction.masked ?? null } : null,
    reasons: (record.reasons || []).map((r) => r.code),
  };
}

/**
 * @param {{scannedAt: string, counts: object, items: object[]}} scan
 * @param {{root: string, library: string, captureDir: string, mode: string}} where
 */
export function buildAuditReport(scan, where) {
  const pictures = scan.items.map((item) => ({
    scope: item.scope,
    labId: item.labId,
    labTitle: item.labTitle || null,
    filename: item.filename,
    label: item.label,
    product: item.product,
    section: item.section,
    sha256: item.sha256,
    fingerprint: item.fingerprint ? { d: item.fingerprint.d, a: item.fingerprint.a, width: item.fingerprint.w, height: item.fingerprint.h } : null,
    bytes: item.bytes,
    writable: item.writable,
    confirmed: item.confirmed,
    expects: item.depth ? { depth: item.depth, words: DEPTH_WORDS[item.depth] || item.depth } : null,
    reach: item.reach,
    reachWhy: item.reachWhy,
    cluster: item.cluster,
    level: item.level,
    flags: item.flags.map((f) => ({ code: f.code, level: f.level, message: f.message, others: (f.others || []).map((o) => o.filename) })),
    record: recordSummary(item.record),
    file: item.file,
  }));
  const clusters = new Map();
  for (const p of pictures) {
    if (!p.cluster) continue;
    if (!clusters.has(p.cluster)) clusters.set(p.cluster, []);
    clusters.get(p.cluster).push(p);
  }
  const clusterList = [...clusters.entries()].map(([id, members]) => ({
    id,
    slots: [...new Set(members.map((m) => m.filename))].sort(),
    identical: new Set(members.map((m) => m.sha256)).size === 1,
    pictures: members.length,
    members: members.map((m) => ({ scope: m.scope, labId: m.labId, filename: m.filename, level: m.level })),
  }));
  const distinct = new Set(pictures.map((p) => p.sha256)).size;
  return {
    where,
    scan,
    json: {
      generatedAt: scan.scannedAt,
      mode: where.mode,
      nearDistance: NEAR_DISTANCE,
      counts: scan.counts,
      distinct,
      clusters: clusterList,
      pictures,
      cannotDetect: CANNOT_DETECT,
    },
  };
}

function describeOwner(p) {
  return p.scope === "library" ? "shared library" : `lab ${p.labId}`;
}

/** The plain Markdown report. */
export function renderMarkdown(report) {
  const { json, where } = report;
  const c = json.counts;
  const lines = [];
  lines.push("# Screenshot audit", "");
  lines.push(`Generated ${json.generatedAt}. Scope: ${json.mode}. Read-only: nothing was changed.`, "");
  lines.push(`- Shared library: ${where.library}`, `- Generated labs: ${where.root}`, "");
  lines.push("## Summary", "");
  lines.push(`${c.pictures} pictures checked, ${json.distinct} distinct images. ${c.total} flagged (${c.definite} definite, ${c.probable} probable).`, "");
  lines.push("| Flag | Pictures | Meaning |", "| --- | ---: | --- |");
  for (const code of FLAG_ORDER) lines.push(`| ${code} | ${c.byFlag[code] || 0} | ${FLAG_MEANING[code]} |`);
  lines.push("");
  const library = json.pictures.filter((p) => p.scope === "library");
  const libFlagged = library.filter((p) => p.level);
  lines.push(`Shared library: ${library.length} pictures, ${new Set(library.map((p) => p.sha256)).size} distinct, ${libFlagged.length} flagged.`, "");

  lines.push("## What this cannot detect", "");
  for (const item of json.cannotDetect) lines.push(`- ${item}`);
  lines.push("");

  lines.push("## Clusters of identical and near-identical pictures under different slots", "");
  if (!json.clusters.length) lines.push("None.", "");
  for (const cluster of json.clusters) {
    lines.push(`### ${cluster.id}: ${cluster.slots.length} slots, ${cluster.identical ? "identical bytes" : "near-identical"}`, "");
    lines.push(`Slots: ${cluster.slots.join(", ")}`, "");
  }

  lines.push("## Flagged pictures", "");
  const flagged = json.pictures.filter((p) => p.level).sort((a, b) => (a.level === b.level ? a.filename.localeCompare(b.filename) : a.level === "definite" ? -1 : 1));
  if (!flagged.length) lines.push("None.", "");
  else {
    lines.push("| Level | Where | Slot | Flags | Expects | Reached | Why |", "| --- | --- | --- | --- | --- | --- | --- |");
    for (const p of flagged) lines.push(`| ${p.level} | ${cell(describeOwner(p))} | ${cell(p.filename)} | ${p.flags.map((f) => f.code).join(", ")} | ${cell(p.expects?.words || "unknown")} | ${p.reach} | ${cell(p.flags[0]?.message)} |`);
    lines.push("");
  }

  lines.push("## What the saved checks say", "");
  lines.push("| Where | Slot | Image | Source | Mode | Date | Companion | Final page | Labels | Masked |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const p of json.pictures.filter((x) => x.record)) {
    const r = p.record;
    lines.push(`| ${cell(describeOwner(p))} | ${cell(p.filename)} | ${p.sha256.slice(0, 8)} | ${r.source || ""} | ${r.captureMode || ""} | ${String(r.acceptedAt || "").slice(0, 10)} | ${r.companionVersion || "not stored"} | ${cell(r.finalPage || "")} | ${r.labels ? `${r.labels.matched}/${r.labels.expected}${r.labels.soft ? " (soft)" : ""}` : ""} | ${r.redaction ? (r.redaction.applied ? r.redaction.masked : "not applied") : ""} |`);
  }
  lines.push("");
  const unchecked = json.pictures.filter((p) => !p.record);
  if (unchecked.length) lines.push(`${unchecked.length} pictures have no saved check of their own (copies and pictures put in by hand).`, "");
  return `${lines.join("\n")}\n`;
}

/** The HTML contact sheet: thumbnails grouped by cluster, with slot names and flags. Pictures are shown from where they are. */
export function renderContactSheet(report) {
  const { json } = report;
  const img = (p) => (p.file ? `<img loading="lazy" alt="" src="${esc(pathToFileURL(p.file).href)}">` : "");
  const card = (p) =>
    `<figure class="card ${p.level || "ok"}">${img(p)}<figcaption><strong>${esc(p.filename)}</strong><br><span>${esc(describeOwner(p))}</span>${p.level ? `<br><em>${esc(p.level)}: ${esc(p.flags.map((f) => f.code).join(", "))}</em><br><small>${esc(p.flags[0]?.message || "")}</small>` : ""}</figcaption></figure>`;
  const sections = [];
  for (const cluster of json.clusters) {
    const members = json.pictures.filter((p) => p.cluster === cluster.id);
    sections.push(`<section><h2>${esc(cluster.id)}: ${cluster.slots.length} slots, ${cluster.identical ? "identical" : "near-identical"}</h2><div class="grid">${members.map(card).join("")}</div></section>`);
  }
  const single = json.pictures.filter((p) => !p.cluster && p.level);
  if (single.length) sections.push(`<section><h2>Flagged on their own</h2><div class="grid">${single.map(card).join("")}</div></section>`);
  const rest = json.pictures.filter((p) => !p.cluster && !p.level);
  if (rest.length) sections.push(`<section><details><summary>${rest.length} pictures not flagged</summary><div class="grid">${rest.map(card).join("")}</div></details></section>`);
  return `<!doctype html>
<html lang="en-US"><head><meta charset="utf-8"><title>Screenshot audit contact sheet</title>
<style>
body{font:14px/1.4 "Segoe UI",Arial,sans-serif;margin:24px;color:#1b1b1b;background:#fff}
h1{font-size:20px}h2{font-size:16px;margin:24px 0 8px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px}
.card{margin:0;border:1px solid #c8c8c8;border-radius:6px;padding:8px;background:#fafafa}
.card img{width:100%;height:auto;border:1px solid #ddd;display:block}
.card.definite{border-color:#a4262c;background:#fdf3f4}.card.probable{border-color:#8a5a00;background:#fffaf0}
figcaption{margin-top:6px;word-break:break-word}small{color:#444}
</style></head><body>
<h1>Screenshot audit contact sheet</h1>
<p>${esc(json.counts.pictures)} pictures, ${esc(json.distinct)} distinct images, ${esc(json.counts.definite)} definite, ${esc(json.counts.probable)} probable. Pictures are shown from where they are stored; this page copies nothing. Do not share it: real pictures can show names and account details.</p>
${sections.join("\n")}
</body></html>
`;
}
