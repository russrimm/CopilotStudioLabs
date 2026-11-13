/**
 * Harness differences: the expandable "How this differs on the <other>
 * harness" learning points a generated lab carries.
 *
 * `harness-differences.json` holds one curated record per concept, grounded on
 * Microsoft Learn. This module loads and validates those records and renders
 * them as accessible `<details>` blocks. Nothing is fetched at build time, so a
 * lab never quotes fetched text as a difference: every sentence was written and
 * reviewed against the pages in the record's `sources`.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getConceptForFeature } from "./concepts.js";
import { productHasHarnesses, productOf } from "./products.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIFFERENCES_PATH = path.join(__dirname, "harness-differences.json");

export const DIFFERENCE_AVAILABILITY = ["supported", "preview", "planned", "not-supported", "unknown"];
export const DIFFERENCE_CONFIDENCE = ["documented", "partly-documented", "uncertain"];

const AVAILABILITY_LABELS = {
  supported: "Supported",
  preview: "Preview",
  planned: "Planned, not yet available",
  "not-supported": "Not supported",
  unknown: "Not confirmed in Microsoft Learn",
};

/** The harness each harness is compared with by default. Customer Conversation compares with both. */
const COUNTERPARTS = {
  standard: ["microsoft-copilot"],
  "microsoft-copilot": ["standard"],
  "customer-conversation": ["standard", "microsoft-copilot"],
};

const LEARN_HOST = "learn.microsoft.com";
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
// "GitHub Copilot harness" is the earlier name; our own content never uses it.
const FORBIDDEN_NAME = /github copilot harness/i;
// A small guard for the US English rule; extend it when a new slip is found.
const NON_US_SPELLING = /\b(?:behaviour|colour|organis(?:e|ation)|practis(?:e|ed|ing)|catalogue|centre|licence|favour(?:ite)?|customis(?:e|ation)|recognis(?:e|ed)|analys(?:e|ed))\b/i;

let cached = null;

export function getDifferences() {
  if (!cached) {
    cached = JSON.parse(fs.readFileSync(DIFFERENCES_PATH, "utf8")).differences || [];
  }
  return cached;
}

export function getDifference(conceptId) {
  return getDifferences().find((record) => record.concept === conceptId) || null;
}

export function defaultDifferencesFor(labHarness) {
  return [...(COUNTERPARTS[labHarness] || [])];
}

function texts(record) {
  const out = [record.title, record.uncertainNote];
  for (const h of Object.values(record.harnesses || {})) out.push(h.term, h.summary, h.where, ...(h.limits || []));
  for (const s of record.sources || []) out.push(s.title);
  return out.filter((t) => typeof t === "string");
}

/**
 * Problems with the difference records, as human-readable strings.
 *
 * @param {{records: object[], concepts: object[], harnesses: object[], now?: number}} input
 */
export function validateDifferences({ records, concepts, harnesses, now = Date.now() }) {
  const problems = [];
  const conceptIds = new Set(concepts.map((c) => c.id));
  const harnessIds = new Set(harnesses.map((h) => h.id));
  const seen = new Set();

  for (const record of records) {
    const label = `difference ${record.concept}`;
    if (!conceptIds.has(record.concept)) problems.push(`${label}: unknown concept`);
    if (seen.has(record.concept)) problems.push(`${label}: duplicate record`);
    seen.add(record.concept);
    if (!record.title?.trim()) problems.push(`${label}: needs a title`);
    if (!DIFFERENCE_CONFIDENCE.includes(record.confidence)) {
      problems.push(`${label}: confidence must be one of ${DIFFERENCE_CONFIDENCE.join(", ")}`);
    }
    if (record.confidence !== "documented" && !record.uncertainNote?.trim()) {
      problems.push(`${label}: ${record.confidence} records need an uncertainNote`);
    }

    const present = Object.keys(record.harnesses || {});
    if (present.length < 2) problems.push(`${label}: describe at least two harnesses`);
    for (const id of present) {
      const h = record.harnesses[id];
      if (!harnessIds.has(id)) problems.push(`${label}: unknown harness "${id}"`);
      if (!h.term?.trim()) problems.push(`${label}: ${id} needs a term`);
      if (!h.summary?.trim()) problems.push(`${label}: ${id} needs a summary`);
      if (!DIFFERENCE_AVAILABILITY.includes(h.availability)) {
        problems.push(`${label}: ${id} availability must be one of ${DIFFERENCE_AVAILABILITY.join(", ")}`);
      }
      if (h.availability === "unknown" && record.confidence === "documented") {
        problems.push(`${label}: ${id} is unknown, so the record cannot be marked documented`);
      }
    }

    const urls = [];
    if (!record.sources?.length) problems.push(`${label}: needs at least one Microsoft Learn source`);
    for (const source of record.sources || []) {
      let url = null;
      try {
        url = new URL(String(source.url));
      } catch {
        /* reported below */
      }
      if (!url || url.protocol !== "https:" || url.hostname !== LEARN_HOST) {
        problems.push(`${label}: source "${source.url}" must be an https URL on ${LEARN_HOST}`);
      } else urls.push(source.url);
      if (!source.title?.trim() || /^https?:\/\//i.test(source.title)) problems.push(`${label}: each source needs a descriptive title`);
    }
    if (!urls.includes(record.verifiedAgainst)) problems.push(`${label}: verifiedAgainst must be one of its sources`);

    const day = record.lastVerified;
    const dayMs = typeof day === "string" && ISO_DAY.test(day) ? Date.parse(`${day}T00:00:00Z`) : NaN;
    if (Number.isNaN(dayMs) || new Date(dayMs).toISOString().slice(0, 10) !== day) {
      problems.push(`${label}: lastVerified must be a valid YYYY-MM-DD date`);
    } else if (dayMs > now + 86400000) {
      problems.push(`${label}: lastVerified is in the future`);
    }

    for (const text of texts(record)) {
      if (FORBIDDEN_NAME.test(text)) problems.push(`${label}: use "Microsoft Copilot harness", not the earlier name`);
      if (NON_US_SPELLING.test(text)) problems.push(`${label}: use US English ("${text.match(NON_US_SPELLING)[0]}")`);
    }
  }
  return problems;
}

function harnessName(harnesses, id) {
  return harnesses.find((h) => h.id === id)?.name || id;
}

/** One `<details>` block comparing the lab's harness with another. Returns markdown lines. */
export function renderDifferenceBlock({ record, concept, labHarness, otherHarness, harnesses, clean }) {
  const lab = record.harnesses[labHarness];
  const other = record.harnesses[otherHarness];
  if (!other) return [];
  const labName = harnessName(harnesses, labHarness);
  const otherName = harnessName(harnesses, otherHarness);
  const label = (h) => (h.where ? ` Where: ${clean(h.where)}` : "");

  const lines = [
    "<details>",
    `<summary>How this differs on the ${otherName}</summary>`,
    "",
    `**Same goal.** ${clean(concept.summary)}`,
    "",
  ];
  if (lab) lines.push(`**In this lab (${labName}).** ${clean(lab.term)}: ${clean(lab.summary)}${label(lab)}`, "");
  lines.push(`**On the ${otherName}.** ${clean(other.term)}: ${clean(other.summary)}${label(other)}`, "");

  if (lab && lab.term !== other.term) {
    lines.push(
      `**Terminology.** The ${labName} calls this "${clean(lab.term)}". The ${otherName} calls it "${clean(other.term)}".`,
      "",
    );
  }
  lines.push(`**Availability on the ${otherName}.** ${AVAILABILITY_LABELS[other.availability]}.`, "");

  if (other.limits?.length) {
    lines.push(`**Limits and gaps on the ${otherName}.**`, "", ...other.limits.map((l) => `- ${clean(l)}`), "");
  }
  if (record.confidence !== "documented" && record.uncertainNote) {
    lines.push(`**Not confirmed in Microsoft Learn.** ${clean(record.uncertainNote)}`, "");
  }
  const sources = record.sources.map((s) => `[${clean(s.title)}](${s.url})`).join("; ");
  lines.push(`**Sources (checked ${record.lastVerified}).** ${sources}`, "", "</details>");
  return lines;
}

/**
 * Difference blocks for a plan, keyed by the feature section that carries them.
 * Each concept appears once, on its first module in the lab, so a lab that
 * covers three knowledge modules explains the knowledge differences once.
 *
 * @returns {{ byFeature: Map<string, string[]>, concepts: string[], uncertain: string[], harnesses: string[] }}
 */
export function buildDifferenceBlocks(plan, { harnesses, clean = (t) => String(t), concepts } = {}) {
  // An omitted harness is Standard (older plans); a plan for products without harnesses sets it to null.
  const labHarness = plan.harness === undefined ? "standard" : plan.harness;
  const targets = labHarness ? (plan.differencesFor || []).filter((id) => id !== labHarness) : [];
  const byFeature = new Map();
  const shown = [];
  const uncertain = [];
  if (!targets.length) return { byFeature, concepts: shown, uncertain, harnesses: [] };

  const seen = new Set();
  for (const feature of plan.features) {
    // A difference record compares harnesses, so it only fits a feature of a product that has them.
    if (!productHasHarnesses(productOf(feature))) continue;
    const concept = (concepts || []).find((c) => c.features.includes(feature.id)) || getConceptForFeature(feature.id);
    if (!concept || seen.has(concept.id)) continue;
    const record = getDifference(concept.id);
    if (!record) continue;
    seen.add(concept.id);
    const lines = [];
    for (const otherHarness of targets) {
      const block = renderDifferenceBlock({ record, concept, labHarness, otherHarness, harnesses, clean });
      if (block.length) lines.push("", ...block);
    }
    if (!lines.length) continue;
    byFeature.set(feature.id, lines);
    shown.push(concept.id);
    if (record.confidence !== "documented") uncertain.push(concept.id);
  }
  return { byFeature, concepts: shown, uncertain, harnesses: targets };
}
