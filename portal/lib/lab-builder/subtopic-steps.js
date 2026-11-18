/**
 * Step derivation for sub-topics.
 *
 * A topic with sub-topics keeps its single outline entry. Each sub-topic the
 * lab includes is read from its own Microsoft Learn article, the same way the
 * topic itself is (`deriveSteps`), and becomes a headed section inside the
 * topic's module. A sub-topic the lab excludes is never fetched, so nothing
 * about it can reach the lab, its citations, or its documents.
 */

import { fetchDocPage } from "./learn-mcp.js";
import { canonicalLearnPageKey } from "./learn-citations.js";
import { deriveSteps } from "./steps.js";
import { subtopicPlaceholderStep, subtopicToFeature } from "./topic-feature.js";

/**
 * Remove an excluded sub-topic's article from a module's grounding. A live search can return the page of a
 * sub-topic the lab leaves out; it must not appear as a citation or as the "From the docs" quote.
 */
export function dropExcludedSources(grounding, feature) {
  const left = (feature?.learnTopic?.subtopicChoices || []).filter((choice) => !choice.included);
  if (!grounding || !left.length) return grounding;
  const keys = new Set(left.map((choice) => canonicalLearnPageKey(choice.url)).filter(Boolean));
  const keep = (item) => !keys.has(canonicalLearnPageKey(item?.url));
  const sources = (grounding.sources || []).filter(keep);
  const results = (grounding.results || []).filter(keep);
  return {
    ...grounding,
    sources,
    results,
    grounded: sources.length > 0,
    learnVerified: Boolean(grounding.learnVerified) && results.length > 0,
  };
}

/**
 * Read the steps of every sub-topic the feature includes.
 *
 * Always resolves. A sub-topic whose article cannot be read, or has no usable procedure, keeps a single
 * `[Unverified]` step that points at its article, so the lab never claims more than it read.
 *
 * @param {object|null} session an open Learn MCP session, or one that is not ok
 * @param {object} feature a plan feature (its `learnTopic.subtopics` are the included ones)
 * @param {{fetchPage?: Function}} [options]
 * @returns {Promise<Array<{id:string, title:string, url:string, summary?:string, minutes?:number, source:string, steps:string[], reason:string|null, fetchedAt:string|null, sectionHeading:string|null, confidence:number|null}>>}
 */
export async function deriveSubtopicSteps(session, feature, { fetchPage = fetchDocPage } = {}) {
  const records = [];
  for (const sub of feature?.learnTopic?.subtopics || []) {
    const base = {
      id: sub.id,
      title: sub.title,
      url: sub.url,
      ...(sub.summary ? { summary: sub.summary } : {}),
      ...(sub.minutes ? { minutes: sub.minutes } : {}),
    };
    const fallback = (reason) => ({
      ...base,
      source: "catalog-fallback",
      steps: [subtopicPlaceholderStep(sub.title)],
      reason,
      fetchedAt: null,
      sectionHeading: null,
      confidence: null,
    });
    if (!session?.ok) {
      records.push(fallback("learn-unavailable"));
      continue;
    }
    const page = await fetchPage(session, sub.url);
    if (page.error) {
      records.push(fallback("fetch-failed"));
      continue;
    }
    const result = deriveSteps(page.markdown, subtopicToFeature(sub), sub.url);
    if (!result.ok) {
      records.push(fallback(result.reason));
      continue;
    }
    records.push({
      ...base,
      source: "doc-derived",
      steps: result.steps,
      reason: null,
      fetchedAt: page.fetchedAt,
      sectionHeading: result.heading || null,
      confidence: Number(result.score.toFixed(3)),
    });
  }
  return records;
}

/**
 * Attach sub-topic records to a module's step record.
 *
 * When the module's own article gave no procedure but a sub-topic's did, the module counts as read from the
 * documentation (its procedures are in the sub-topic sections) instead of falling back to curated placeholder steps.
 */
export function attachSubtopicSteps(record, subtopicRecords) {
  if (!subtopicRecords?.length) return record;
  const read = subtopicRecords.filter((sub) => sub.source === "doc-derived");
  const base = { ...record, subtopics: subtopicRecords };
  const ownStepsRead = record?.source === "doc-derived" || record?.source === "llm-verified";
  if (ownStepsRead || !read.length) return base;
  return {
    ...base,
    source: "doc-derived",
    reason: null,
    steps: [],
    stepsInSubtopics: true,
    canonicalVerified: true,
    url: read[0].url,
    fetchedAt: read[0].fetchedAt,
    sectionHeading: read[0].sectionHeading,
    confidence: read[0].confidence,
    sources: read.map((sub) => sub.url),
  };
}
