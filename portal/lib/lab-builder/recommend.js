/**
 * Topic recommendations for the guided lab builder.
 *
 * Answers one question the wizard keeps asking: given the vertical, the
 * departments, the level, and the harness, which topics belong in the lab and
 * why? Everything is deterministic and explainable: each selected topic carries
 * the reasons it was chosen, and nothing is dropped, so every topic that applies
 * to the harness stays selectable or deselectable.
 *
 * The level is the single source of truth. Only topics taught at the chosen
 * level are listed. A lower-level topic that a selected topic genuinely depends
 * on is never mixed into that list: it appears in `prerequisites`, a separate
 * group the learner can deselect, and the lab teaches it as a short recap.
 * Learn-discovered topics whose level cannot be resolved appear in
 * `levelUnknown` and are never recommended.
 *
 * Time is guidance only. The totals here are estimates, never limits.
 */

import { getFeatures, getHarnesses, expandPrereqs } from "./catalog.js";
import { getConcepts, getRecommendations, notApplicableReason } from "./concepts.js";
import { DIFFICULTY_BY_LEVEL, formatDuration } from "./planner.js";
import { getIndustries, getRoles } from "../scenarios.js";
import { topicToFeature } from "./topic-feature.js";
import { UNCATEGORIZED } from "./topic-snapshot.js";
import { atLevel, isLevel, levelName, PREREQ_RECAP_MINUTES } from "./levels.js";

export const DEFAULT_HARNESS = "standard";
const LEVELS = [100, 200, 300];
const DAY_MS = 86400000;

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
 * @param {object} [learn]                  what Microsoft Learn discovery found; omit for the static catalog alone
 * @param {object[]} [learn.topics]         discovered topics (only those new to the catalog are offered)
 * @param {object[]} [learn.checks]         catalog freshness checks, for Updated and Docs moved flags
 * @param {number} [learn.now]              clock for the Updated window
 * @param {number} [learn.updatedWindowDays]
 * @returns {object} concepts with their topics, plus totals and warnings
 */
export function recommend(answers = {}, learn = {}) {
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

  // Topics found on Microsoft Learn that the catalog does not cover. They are offered, never pre-selected.
  const learnNow = learn.now ?? Date.now();
  const updatedWithin = (learn.updatedWindowDays ?? 30) * DAY_MS;
  const isRecent = (day) => Boolean(day) && learnNow - Date.parse(`${day}T00:00:00Z`) <= updatedWithin;
  const dynamicByConcept = new Map();
  const dynamicTopics = new Map();
  for (const topic of learn.topics || []) {
    if (topic.status !== "new" || features.has(topic.id)) continue;
    features.set(topic.id, topicToFeature(topic));
    dynamicTopics.set(topic.id, topic);
    const concept = getConcepts().some((c) => c.id === topic.conceptId) ? topic.conceptId : UNCATEGORIZED;
    if (!dynamicByConcept.has(concept)) dynamicByConcept.set(concept, []);
    dynamicByConcept.get(concept).push(topic.id);
  }
  const checks = new Map((learn.checks || []).map((c) => [c.featureId, c]));
  const applies = (id) => features.get(id)?.harness?.includes(harness);

  // Why each topic is recommended. Insertion order is the display order of reasons.
  const reasons = new Map();
  for (const id of recs.levels?.[String(level)] || []) {
    if (applies(id)) addReason(reasons, id, `Recommended for level ${level} ${DIFFICULTY_BY_LEVEL[level]}`);
  }
  const inLevel = (id) => atLevel(features.get(id), level);
  const levelUnknown = (id) => features.has(id) && !isLevel(features.get(id).level);
  // Industry and department picks only apply to topics taught at the chosen level.
  const boost = (group, key, label) => {
    const entry = recs[group]?.[key];
    for (const id of entry?.topics || []) {
      if (applies(id) && inLevel(id)) addReason(reasons, id, `Recommended for ${label}: ${entry.why}`);
    }
  };
  if (industry) boost("verticals", industry.id, industry.name);
  for (const id of departments) boost("departments", id, roleCatalog.find((r) => r.id === id).name);

  const explicit = Array.isArray(answers.selected);
  let chosen;
  // A saved or hand-built selection can name topics from other levels. They are
  // not listed here, and they come back only as prerequisites when a topic at
  // this level needs them.
  const offLevel = [];
  if (explicit) {
    chosen = toIdList(answers.selected, "selected").filter((id) => {
      const known = features.has(id);
      if (!known) warnings.push(`Unknown topic "${id}" was ignored.`);
      if (known && !inLevel(id) && !levelUnknown(id)) {
        offLevel.push(id);
        return false;
      }
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
  const neededBy = new Map([...requiredBy].map(([id, names]) => [id, [...names]]));
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
  const topicRow = (id) => {
    const f = features.get(id);
    const discovered = dynamicTopics.get(id);
    const check = checks.get(id);
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
      source: discovered ? "learn" : "catalog",
      // `estimated` marks a Learn topic whose level came from the docs rubric rather than the snapshot.
      levelBasis: f.levelBasis || "declared",
      // `new` topics come from Learn and are not in the catalog; `updated` and `stale` flag a catalog topic whose docs changed or moved.
      learn: discovered
        ? { status: "new", url: discovered.urls[0], lastSeen: discovered.lastSeen, updated: isRecent(discovered.changedAt) }
        : check?.status === "stale"
        ? { status: "stale", missing: check.missing }
        : check?.status === "updated" && isRecent(check.changedAt)
        ? { status: "updated", changedAt: check.changedAt }
        : null,
    };
  };
  const makeRow = (concept, ids, extra = {}) => {
    const topics = ids.filter((id) => (applies(id) || selectedIds.has(id)) && inLevel(id)).map(topicRow);
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
        : concept.features
            .filter((id) => inLevel(id))
            .map((id) => ({ id, name: features.get(id).name, harnesses: features.get(id).harness })),
      topics,
      selectedCount: topics.filter((t) => t.selected).length,
      minutes,
      ...extra,
    };
  };
  // A concept with no topic at this level is left out when the harness has topics for it at other levels:
  // listing it would only point at content the learner did not ask for. A concept the harness cannot
  // teach at any level stays as a muted row, so the gap is still explained.
  const conceptRows = getConcepts()
    .map((concept) => ({
      concept,
      row: makeRow(concept, [...concept.features, ...(dynamicByConcept.get(concept.id) || [])]),
      applicableElsewhere: [...concept.features, ...(dynamicByConcept.get(concept.id) || [])].some(applies),
    }))
    .filter(({ row, applicableElsewhere }) => row.topics.length || !applicableElsewhere)
    .map(({ row }) => row);

  // Discovered topics that match no concept yet still get a home, so none is hidden.
  const loose = (dynamicByConcept.get(UNCATEGORIZED) || []).filter((id) => (applies(id) || selectedIds.has(id)) && inLevel(id));
  if (loose.length) {
    conceptRows.push(
      makeRow(
        {
          id: UNCATEGORIZED,
          name: "New from Learn: not yet grouped",
          summary: "Topics found on Microsoft Learn that do not match a concept yet. They are unreviewed, so check each against its article.",
          order: 999,
          features: [],
        },
        loose,
      ),
    );
  }

  // Lower-level topics that a selected topic needs, kept apart from the topics at this level.
  const lowerLevel = (id) => isLevel(features.get(id)?.level) && features.get(id).level < level;
  const prerequisiteIds = new Set([...neededBy.keys()].filter(lowerLevel));
  const warned = new Map(dependencyWarnings.map((w) => [w.id, w.dependents]));
  const prerequisiteRows = [...prerequisiteIds]
    .map((id) => {
      const f = features.get(id);
      const needers = neededBy.get(id) || warned.get(id) || [];
      return {
        id,
        name: f.name,
        summary: f.summary,
        level: f.level,
        minutes: Math.min(f.minutes, PREREQ_RECAP_MINUTES),
        fullMinutes: f.minutes,
        selected: selectedIds.has(id),
        neededBy: needers,
        reason: `Needed by ${needers.join(", ")}. Included as a short Level ${f.level} recap, not a full module.`,
      };
    })
    .sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));
  const prerequisiteSelected = prerequisiteRows.filter((p) => p.selected);

  const unknownRows = [...dynamicTopics.keys()]
    .filter((id) => levelUnknown(id) && (applies(id) || selectedIds.has(id)))
    .map(topicRow);

  const levelMinutes =
    conceptRows.reduce((sum, c) => sum + c.minutes, 0) + unknownRows.filter((t) => t.selected).reduce((sum, t) => sum + t.minutes, 0);
  const totalMinutes = levelMinutes + prerequisiteSelected.reduce((sum, p) => sum + p.minutes, 0);
  const selectedTopicIds = [
    ...conceptRows.flatMap((c) => c.topics.filter((t) => t.selected).map((t) => t.id)),
    ...unknownRows.filter((t) => t.selected).map((t) => t.id),
  ];
  const listed = conceptRows.reduce((sum, c) => sum + c.topics.length, 0);
  return {
    answers: { industry: industry?.id || null, departments, level, harness },
    concepts: conceptRows,
    prerequisites: {
      topics: prerequisiteRows,
      selectedIds: prerequisiteSelected.map((p) => p.id),
      selectedCount: prerequisiteSelected.length,
      minutes: prerequisiteSelected.reduce((sum, p) => sum + p.minutes, 0),
    },
    levelUnknown: {
      topics: unknownRows,
      selectedCount: unknownRows.filter((t) => t.selected).length,
    },
    filter: {
      level,
      label: levelName(level),
      shown: listed,
      // Topics from other levels the request named; the wizard tells the learner they were dropped.
      droppedSelections: offLevel
        .filter((id) => !selectedIds.has(id))
        .map((id) => ({ id, name: features.get(id).name, level: features.get(id).level })),
    },
    selectedIds: selectedTopicIds,
    totals: {
      selectedCount: selectedTopicIds.length,
      prerequisiteCount: prerequisiteSelected.length,
      minutes: totalMinutes,
      duration: formatDuration(totalMinutes),
      isEstimate: true,
    },
    dependencyWarnings,
    warnings,
  };
}
