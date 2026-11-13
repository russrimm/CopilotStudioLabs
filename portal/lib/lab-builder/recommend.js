/**
 * Topic recommendations for the guided lab builder.
 *
 * Answers one question the wizard keeps asking: given the vertical, the
 * departments, the level, and the harness, which topics belong in the lab and
 * why? Everything is deterministic and explainable: each selected topic carries
 * the reasons it was chosen, and nothing is dropped, so every topic that applies
 * to the harness stays selectable or deselectable.
 *
 * Time is guidance only. The totals here are estimates, never limits.
 */

import { getFeatures, getHarnesses, expandPrereqs } from "./catalog.js";
import { getConcepts, getRecommendations, notApplicableReason } from "./concepts.js";
import { DIFFICULTY_BY_LEVEL, formatDuration } from "./planner.js";
import { getIndustries, getRoles } from "../scenarios.js";

export const DEFAULT_HARNESS = "standard";
const LEVELS = [100, 200, 300];

function toLevel(value) {
  if (value === undefined || value === null || value === "") return 100;
  const level = Number(value);
  if (!LEVELS.includes(level)) throw new Error("level must be 100, 200, or 300.");
  return level;
}

function toIdList(value, name) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string")) {
    throw new Error(`${name} must be an array of strings.`);
  }
  return [...new Set(value.map((id) => id.trim()).filter(Boolean))];
}

function addReason(reasons, id, reason) {
  if (!reasons.has(id)) reasons.set(id, []);
  if (!reasons.get(id).includes(reason)) reasons.get(id).push(reason);
}

/**
 * @param {object} answers
 * @param {string} [answers.industry]       industry id (the vertical)
 * @param {string[]} [answers.departments]  role ids
 * @param {number} [answers.level]          100, 200, or 300
 * @param {string} [answers.harness]        harness id; defaults to the Standard harness
 * @param {string[]} [answers.selected]     the learner's own selection; replaces the recommendation
 * @returns {object} concepts with their topics, plus totals and warnings
 */
export function recommend(answers = {}) {
  const warnings = [];
  const harnesses = getHarnesses();
  const harness = answers.harness || DEFAULT_HARNESS;
  if (!harnesses.some((h) => h.id === harness)) throw new Error(`Unknown harness "${harness}".`);
  const level = toLevel(answers.level);

  const industry = getIndustries().find((i) => i.id === answers.industry) || null;
  if (answers.industry && !industry) warnings.push(`Unknown industry "${answers.industry}"; using a cross-industry lab.`);

  const roleCatalog = getRoles();
  const departments = toIdList(answers.departments, "departments").filter((id) => {
    const known = roleCatalog.some((r) => r.id === id);
    if (!known) warnings.push(`Unknown department "${id}" was ignored.`);
    return known;
  });

  const recs = getRecommendations();
  const features = new Map(getFeatures().map((f) => [f.id, f]));
  const applies = (id) => features.get(id)?.harness?.includes(harness);

  // Why each topic is recommended. Insertion order is the display order of reasons.
  const reasons = new Map();
  for (const id of recs.levels?.[String(level)] || []) {
    if (applies(id)) addReason(reasons, id, `Recommended for level ${level} ${DIFFICULTY_BY_LEVEL[level]}`);
  }
  const boost = (group, key, label) => {
    const entry = recs[group]?.[key];
    for (const id of entry?.topics || []) {
      if (applies(id) && features.get(id).level <= level) addReason(reasons, id, `Recommended for ${label}: ${entry.why}`);
    }
  };
  if (industry) boost("verticals", industry.id, industry.name);
  for (const id of departments) boost("departments", id, roleCatalog.find((r) => r.id === id).name);

  const explicit = Array.isArray(answers.selected);
  let chosen;
  if (explicit) {
    chosen = toIdList(answers.selected, "selected").filter((id) => {
      const known = features.has(id);
      if (!known) warnings.push(`Unknown topic "${id}" was ignored.`);
      return known;
    });
  } else {
    chosen = [...reasons.keys()];
  }
  const chosenSet = new Set(chosen);

  // Prerequisites join the lab automatically so it stands on its own. They are
  // listed with the topic that needs them. A prerequisite the learner turned off
  // (`excluded`) stays off and only produces a warning: the lab then assumes
  // learners have already done it.
  const excluded = new Set(toIdList(answers.excluded, "excluded"));
  for (const id of excluded) chosenSet.delete(id);
  const requiredBy = new Map();
  for (const id of chosenSet) {
    for (const pre of expandPrereqs([id])) {
      if (pre !== id && !chosenSet.has(pre)) {
        if (!requiredBy.has(pre)) requiredBy.set(pre, []);
        requiredBy.get(pre).push(features.get(id).name);
      }
    }
  }
  const dependencyWarnings = [];
  for (const pre of [...requiredBy.keys()]) {
    if (!excluded.has(pre)) continue;
    const dependents = requiredBy.get(pre);
    requiredBy.delete(pre);
    dependencyWarnings.push({
      id: pre,
      name: features.get(pre).name,
      dependents,
      message: `${features.get(pre).name} is a prerequisite for ${dependents.join(", ")}. Without it the lab assumes learners have already done it.`,
    });
  }
  for (const [pre, names] of requiredBy) {
    addReason(reasons, pre, `Required by ${names.join(", ")}`);
  }

  const selectedIds = new Set([...chosenSet, ...requiredBy.keys()]);
  const conceptRows = getConcepts().map((concept) => {
    const topics = concept.features
      .filter((id) => applies(id) || selectedIds.has(id))
      .map((id) => {
        const f = features.get(id);
        return {
          id,
          name: f.name,
          summary: f.summary,
          level: f.level,
          minutes: f.minutes,
          availability: f.availability || null,
          harnessNote: f.harnessNote || null,
          harnesses: f.harness,
          selected: selectedIds.has(id),
          required: requiredBy.has(id) && !chosenSet.has(id),
          reasons: reasons.get(id) || [],
        };
      });
    const minutes = topics.filter((t) => t.selected).reduce((sum, t) => sum + t.minutes, 0);
    return {
      id: concept.id,
      name: concept.name,
      summary: concept.summary,
      order: concept.order,
      notApplicable: topics.length ? null : notApplicableReason(concept, harness, features),
      // True when the concept has no topic only because none is written yet, not because the harness lacks the idea.
      notYetAvailable: !topics.length && !concept.notApplicable?.[harness],
      otherHarnessTopics: topics.length
        ? []
        : concept.features.map((id) => ({ id, name: features.get(id).name, harnesses: features.get(id).harness })),
      topics,
      selectedCount: topics.filter((t) => t.selected).length,
      minutes,
    };
  });

  const totalMinutes = conceptRows.reduce((sum, c) => sum + c.minutes, 0);
  return {
    answers: { industry: industry?.id || null, departments, level, harness },
    concepts: conceptRows,
    selectedIds: conceptRows.flatMap((c) => c.topics.filter((t) => t.selected).map((t) => t.id)),
    totals: {
      selectedCount: conceptRows.reduce((sum, c) => sum + c.selectedCount, 0),
      minutes: totalMinutes,
      duration: formatDuration(totalMinutes),
      isEstimate: true,
    },
    dependencyWarnings,
    warnings,
  };
}
