/**
 * Maps a use case pattern onto the feature catalog.
 *
 * A pattern lists the capabilities it needs. Each capability names the catalog
 * features that teach it, so this module derives everything a use case claims
 * from the catalog: the lab topics, the level, the harness, which features are
 * preview or third-party, and the Microsoft Learn links. It also checks the
 * harness-differences data, so a use case is never built on a feature the
 * chosen harness does not support. Nothing here invents a capability: a
 * pattern that names an unknown feature, the wrong product, or a retired or
 * unsupported feature does not resolve, and the generator leaves it out.
 */

import { getFeatures, getHarnesses } from "../lab-builder/catalog.js";
import { getConceptForFeature } from "../lab-builder/concepts.js";
import { defaultDifferencesFor, getDifference } from "../lab-builder/differences.js";
import { extractFeatureLearnLinks } from "../lab-builder/learn-citations.js";
import { LEVEL_LABELS } from "../lab-builder/levels.js";
import { getProduct, productHasHarnesses, productOf } from "../lab-builder/products.js";
import { COPILOT_STUDIO, getUseCaseData } from "./data.js";

const UNSUPPORTED = new Set(["not-supported", "planned"]);
const AVAILABILITY_LABELS = { supported: "Supported", preview: "Preview", planned: "Planned", "not-supported": "Not supported", unknown: "Not confirmed in Microsoft Learn" };

let featureIndex = null;
const resolved = new Map();

function features() {
  if (!featureIndex) {
    const list = getFeatures();
    featureIndex = { byId: new Map(list.map((f) => [f.id, f])), order: new Map(list.map((f, i) => [f.id, i])) };
  }
  return featureIndex;
}

/** The static catalog's features only, so a use case never depends on a Learn refresh. */
export function catalogFeature(id) {
  return features().byId.get(id) || null;
}

export function harnessName(id) {
  return getHarnesses().find((h) => h.id === id)?.name || id;
}

function problemsFor(pattern, data) {
  const problems = [];
  const label = `pattern ${pattern.id}`;
  const product = getProduct(pattern.product);
  if (!product) return [`${label}: unknown product "${pattern.product}"`];
  const hasHarnesses = productHasHarnesses(pattern.product);
  const harness = hasHarnesses ? pattern.harness : null;
  if (hasHarnesses && !getHarnesses().some((h) => h.id === harness && (h.product || COPILOT_STUDIO) === pattern.product)) {
    problems.push(`${label}: harness "${pattern.harness}" is not a ${product.shortName} harness`);
  }
  if (!hasHarnesses && pattern.harness) problems.push(`${label}: ${product.shortName} has no harnesses`);

  const baseIds = data.bases[pattern.product]?.[hasHarnesses ? harness : "default"] || [];
  if (!baseIds.length) problems.push(`${label}: no base feature for ${pattern.product}${harness ? ` on ${harness}` : ""}`);

  const caps = [];
  for (const id of pattern.needs || []) {
    const cap = data.capabilities[id];
    if (!cap) problems.push(`${label}: unknown capability "${id}"`);
    else if (cap.product !== pattern.product) problems.push(`${label}: capability ${id} belongs to ${cap.product}, not ${pattern.product}`);
    else caps.push({ id, ...cap });
  }

  const featureIds = [...new Set([...baseIds, ...caps.flatMap((cap) => cap.features)])];
  for (const id of featureIds) {
    const feature = catalogFeature(id);
    if (!feature) {
      problems.push(`${label}: catalog has no feature "${id}"`);
      continue;
    }
    if (productOf(feature) !== pattern.product) problems.push(`${label}: feature ${id} belongs to ${productOf(feature)}`);
    if (feature.availability === "retired") problems.push(`${label}: feature ${id} is retired`);
    if (hasHarnesses && !(feature.harness || []).includes(harness)) problems.push(`${label}: feature ${id} is not available on the ${harness} harness`);
    if (hasHarnesses) {
      const concept = getConceptForFeature(id);
      const entry = concept ? getDifference(concept.id)?.harnesses?.[harness] : null;
      if (entry && UNSUPPORTED.has(entry.availability)) {
        problems.push(`${label}: ${id} is ${AVAILABILITY_LABELS[entry.availability].toLowerCase()} on the ${harness} harness`);
      }
    }
  }
  return problems;
}

/**
 * A pattern's catalog facts: its capabilities, its features in catalog order,
 * the level (the highest feature level), and any problems. Cached per pattern.
 *
 * @returns {{ok: boolean, problems: string[], capabilities: object[], baseIds: string[], features: object[], level: number|null, harness: string|null}}
 */
export function resolvePattern(pattern) {
  if (resolved.has(pattern.id)) return resolved.get(pattern.id);
  const data = getUseCaseData();
  const problems = problemsFor(pattern, data);
  const hasHarnesses = productHasHarnesses(pattern.product);
  const harness = hasHarnesses ? pattern.harness : null;
  let result = { ok: false, problems, capabilities: [], baseIds: [], features: [], level: null, harness };
  if (!problems.length) {
    const baseIds = data.bases[pattern.product][hasHarnesses ? harness : "default"];
    const capabilities = pattern.needs.map((id) => ({ id, ...data.capabilities[id] }));
    const ids = [...new Set([...baseIds, ...capabilities.flatMap((cap) => cap.features)])];
    const { order } = features();
    const list = ids.map(catalogFeature).sort((a, b) => order.get(a.id) - order.get(b.id));
    result = {
      ok: true,
      problems,
      capabilities,
      baseIds,
      features: list,
      level: Math.max(...list.map((f) => f.level)),
      harness,
    };
  }
  resolved.set(pattern.id, result);
  return result;
}

export function levelLabel(level) {
  return LEVEL_LABELS[level] || "Unknown";
}

/** Learn links for a use case: the first link of each distinctive feature, then of the base features, at most `limit`. */
export function learnLinksFor(resolvedPattern, limit = 3) {
  const { capabilities, baseIds, features: list } = resolvedPattern;
  const byId = new Map(list.map((f) => [f.id, f]));
  const distinctive = capabilities.filter((cap) => cap.kind !== "setup").flatMap((cap) => cap.features);
  const ordered = [...new Set([...distinctive, ...capabilities.flatMap((cap) => cap.features), ...baseIds])].map((id) => byId.get(id)).filter(Boolean);
  const links = ordered.map((f) => extractFeatureLearnLinks(f));
  const out = [];
  const seen = new Set();
  for (const position of [0, 1]) {
    for (const featureLinks of links) {
      const link = featureLinks[position];
      if (link && !seen.has(link.url) && out.length < limit) {
        seen.add(link.url);
        out.push({ url: link.url, title: link.title });
      }
    }
  }
  return out;
}

/** "Workflows: the Standard harness uses Agent flow; the Microsoft Copilot harness uses Workflow (Supported)" notes from the harness-differences data. */
export function harnessNotesFor(resolvedPattern, limit = 2) {
  const { harness, capabilities, features: list } = resolvedPattern;
  if (!harness) return [];
  const order = [...capabilities.filter((cap) => cap.forcesCopilotStudio), ...capabilities].flatMap((cap) => cap.features);
  const notes = [];
  const seen = new Set();
  for (const id of [...new Set(order)]) {
    if (!list.some((f) => f.id === id)) continue;
    const concept = getConceptForFeature(id);
    const record = concept ? getDifference(concept.id) : null;
    if (!record || seen.has(record.concept)) continue;
    seen.add(record.concept);
    for (const other of defaultDifferencesFor(harness)) {
      const entry = record.harnesses?.[other];
      const own = record.harnesses?.[harness];
      if (!entry || !own || (entry.term === own.term && entry.availability === own.availability)) continue;
      if (entry.term === own.term) {
        notes.push(`${record.title}: the ${harnessName(other)} has the same "${entry.term}" (${AVAILABILITY_LABELS[entry.availability] || entry.availability}).`);
      } else {
        notes.push(
          `${record.title}: the ${harnessName(harness)} uses "${own.term}"; the ${harnessName(other)} uses "${entry.term}" (${AVAILABILITY_LABELS[entry.availability] || entry.availability}).`,
        );
      }
      if (notes.length >= limit) return notes;
    }
  }
  return notes;
}
