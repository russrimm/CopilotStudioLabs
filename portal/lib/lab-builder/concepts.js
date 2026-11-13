/**
 * The concept layer: ideas a lab teaches, mapped to the catalog features that
 * teach them on each harness.
 *
 * A concept (Instructions, Knowledge, Skills, ...) is the same idea on every
 * harness. Each catalog feature belongs to exactly one concept, and the
 * feature's own `harness` tag says where it applies. That is how "Skills" can
 * list a prompt-tool feature for the Standard harness and a skills feature for
 * the Microsoft Copilot harness, and how a concept can say it has no
 * equivalent on a harness instead of silently disappearing.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateCoverage } from "./coverage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONCEPTS_PATH = path.join(__dirname, "concepts.json");
const RECOMMENDATIONS_PATH = path.join(__dirname, "recommendations.json");

let cachedConcepts = null;
let cachedRecommendations = null;
let cachedKnownGaps = null;

export function getConcepts() {
  if (!cachedConcepts) {
    const raw = JSON.parse(fs.readFileSync(CONCEPTS_PATH, "utf8"));
    cachedConcepts = [...(raw.concepts || [])].sort((a, b) => a.order - b.order);
  }
  return cachedConcepts;
}

/** `concept:harness` cells still waiting for a variant; the list in concepts.json may only shrink. */
export function getKnownCoverageGaps() {
  if (!cachedKnownGaps) {
    cachedKnownGaps = [...(JSON.parse(fs.readFileSync(CONCEPTS_PATH, "utf8")).knownGaps || [])];
  }
  return cachedKnownGaps;
}

export function getRecommendations() {
  if (!cachedRecommendations) {
    cachedRecommendations = JSON.parse(fs.readFileSync(RECOMMENDATIONS_PATH, "utf8"));
  }
  return cachedRecommendations;
}

/** The concept a feature belongs to, or null. */
export function getConceptForFeature(featureId) {
  return getConcepts().find((concept) => concept.features.includes(featureId)) || null;
}

/** Why a concept has nothing for a harness, or null when it has at least one feature. */
export function notApplicableReason(concept, harnessId, features) {
  const has = concept.features.some((id) => features.get(id)?.harness?.includes(harnessId));
  if (has) return null;
  return concept.notApplicable?.[harnessId] || "No topic for this concept is available on this harness yet.";
}

/**
 * Check the concept layer and the recommendations against the feature list.
 * Returns human-readable problems; an empty array means consistent.
 *
 * @param {{concepts: object[], recommendations: object, features: object[], harnesses: object[]}} input
 */
export function validateConcepts({ concepts, recommendations, features, harnesses = [], knownGaps = [] }) {
  const problems = [];
  const byId = new Map(features.map((f) => [f.id, f]));
  const harnessIds = new Set(harnesses.map((h) => h.id));
  const owner = new Map();
  const seen = new Set();

  for (const concept of concepts) {
    const label = `concept ${concept.id}`;
    if (typeof concept.id !== "string" || !/^[a-z][a-z0-9-]*$/.test(concept.id)) problems.push(`${label}: id must be a lower-case slug`);
    if (seen.has(concept.id)) problems.push(`${label}: duplicate concept id`);
    seen.add(concept.id);
    if (!concept.name?.trim()) problems.push(`${label}: needs a name`);
    if (!concept.summary?.trim()) problems.push(`${label}: needs a summary`);
    if (!Number.isFinite(concept.order)) problems.push(`${label}: needs a numeric order`);
    if (!Array.isArray(concept.features) || !concept.features.length) {
      problems.push(`${label}: must list at least one feature`);
      continue;
    }
    for (const id of concept.features) {
      if (!byId.has(id)) problems.push(`${label}: unknown feature "${id}"`);
      else if (owner.has(id)) problems.push(`${id}: listed under both ${owner.get(id)} and ${concept.id}`);
      else owner.set(id, concept.id);
    }
    for (const [harness, reason] of Object.entries(concept.notApplicable || {})) {
      if (harnessIds.size && !harnessIds.has(harness)) problems.push(`${label}: notApplicable names unknown harness "${harness}"`);
      if (typeof reason !== "string" || !reason.trim()) problems.push(`${label}: notApplicable.${harness} needs a reason`);
      const applies = concept.features.some((id) => byId.get(id)?.harness?.includes(harness));
      if (applies) problems.push(`${label}: says it is not applicable to ${harness}, but a feature for it exists`);
    }
  }
  for (const f of features) {
    if (!owner.has(f.id)) problems.push(`${f.id}: does not belong to any concept`);
  }

  problems.push(...validateCoverage({ concepts, features, harnesses, knownGaps }));

  const known = (id, where) => {
    if (!byId.has(id)) problems.push(`recommendations ${where}: unknown feature "${id}"`);
  };
  for (const [level, ids] of Object.entries(recommendations?.levels || {})) {
    if (![100, 200, 300].includes(Number(level))) problems.push(`recommendations levels: "${level}" must be 100, 200, or 300`);
    ids.forEach((id) => known(id, `levels.${level}`));
  }
  for (const group of ["verticals", "departments"]) {
    for (const [key, entry] of Object.entries(recommendations?.[group] || {})) {
      if (!entry.why?.trim()) problems.push(`recommendations ${group}.${key}: needs a why`);
      (entry.topics || []).forEach((id) => known(id, `${group}.${key}`));
    }
  }
  return problems;
}
