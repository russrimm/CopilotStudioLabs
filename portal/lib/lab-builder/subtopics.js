/**
 * Sub-topics: the companion Microsoft Learn pages that consolidation merges
 * under one primary topic (see topic-consolidate.js).
 *
 * A sub-topic is a real selection option. By default every sub-topic of a
 * selected topic is included, which is what a topic always meant before they
 * could be chosen one by one. A learner (or an API client) can leave some out
 * with `excludedSubtopics`; an excluded sub-topic contributes nothing to the
 * lab: no grounding page, no steps, no time, no per-topic document, no export.
 *
 * Reviewed catalog topics have no sub-topics of their own. Their related
 * items (prerequisites, dependents, and the same idea on another harness) are
 * separate topics, described by `relatedTopics()` in recommend.js.
 *
 * Kept free of imports from catalog.js and topic-store.js so both can use it.
 */

import { resolveTopicLevel } from "./levels.js";

/** Minutes a topic takes when all of its Learn pages are read. */
export const TOPIC_BASE_MINUTES = 20;
/** Pages beyond this many each add a flat share instead of shrinking everyone's share. */
const SHARED_PAGES = 5;
/** The most ids a request may list in `excludedSubtopics`. */
export const MAX_EXCLUDED_SUBTOPICS = 5000;

/** Minutes for one page of a topic that has `total` sub-topics. */
function pageMinutes(total) {
  return TOPIC_BASE_MINUTES / Math.min(1 + total, SHARED_PAGES);
}

/** Estimated minutes for one sub-topic. */
export function subtopicMinutes(total) {
  return Math.max(1, Math.round(pageMinutes(total)));
}

/**
 * Estimated minutes for a topic with `total` sub-topics of which `included` are kept.
 * All of them included is the same 20 minutes a topic has always been estimated at (up to four sub-topics).
 */
export function topicMinutes(total, included) {
  if (!total) return TOPIC_BASE_MINUTES;
  return Math.max(5, Math.round(pageMinutes(total) * (1 + included)));
}

/**
 * Every sub-topic of every topic, by id.
 *
 * @param {object[]} topics snapshot topics (only `status: "new"` topics carry sub-topics)
 * @returns {Map<string, {id:string, parentId:string, title:string, url:string}>}
 */
export function buildSubtopicIndex(topics = []) {
  const index = new Map();
  for (const topic of topics) {
    if (topic?.status !== "new") continue;
    for (const sub of topic.subtopics || []) {
      if (sub && typeof sub.id === "string" && !index.has(sub.id)) {
        index.set(sub.id, { id: sub.id, parentId: topic.id, title: sub.title, url: sub.url });
      }
    }
  }
  return index;
}

/**
 * Validate the `excludedSubtopics` of a request: an array of known sub-topic ids.
 * Returns the unique ids in a stable order; an unknown id is rejected, never ignored.
 *
 * @param {unknown} value
 * @param {Map<string, object>} index from `buildSubtopicIndex`
 * @returns {string[]}
 */
export function normalizeExcludedSubtopics(value, index) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("excludedSubtopics must be an array of sub-topic ids.");
  if (value.length > MAX_EXCLUDED_SUBTOPICS) {
    throw new Error(`excludedSubtopics may contain at most ${MAX_EXCLUDED_SUBTOPICS} items.`);
  }
  if (value.some((id) => typeof id !== "string" || !id.trim())) {
    throw new Error("excludedSubtopics must contain only non-empty strings.");
  }
  const ids = [...new Set(value.map((id) => id.trim()))];
  const unknown = ids.filter((id) => !index.has(id));
  if (unknown.length) {
    throw new Error(
      `Unknown sub-topic id(s): ${unknown.slice(0, 10).join(", ")}${unknown.length > 10 ? `, and ${unknown.length - 10} more` : ""}. ` +
        "A sub-topic id is the id of a merged Microsoft Learn page listed under a topic.",
    );
  }
  return ids.sort();
}

/**
 * The sub-topics of a discovered topic as the API and the wizard show them: every one, with whether it is included.
 *
 * @param {object} topic a snapshot topic
 * @param {Set<string>|null} excluded ids left out of the lab
 */
export function describeSubtopics(topic, excluded = null) {
  const subs = (topic?.subtopics || []).filter((sub) => sub && typeof sub.url === "string");
  const minutes = subtopicMinutes(subs.length);
  return subs.map((sub) => {
    const { level, basis } = resolveTopicLevel({ level: sub.level, urls: [sub.url], title: sub.title });
    return {
      id: sub.id,
      title: sub.title,
      url: sub.url,
      ...(sub.summary ? { summary: sub.summary } : {}),
      level,
      levelBasis: basis,
      availability: sub.availability || null,
      minutes,
      included: !excluded?.has(sub.id),
    };
  });
}
