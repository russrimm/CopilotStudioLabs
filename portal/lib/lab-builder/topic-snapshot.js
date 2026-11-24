/**
 * The shape of the Microsoft Learn topic snapshot, and the checks that keep a
 * tampered or half-written file from reaching the wizard.
 *
 * The same shape is used for the committed baseline
 * (`learn-topics.snapshot.json`) and for the runtime cache, so one validator
 * guards both.
 */

import fs from "node:fs";
import { createHash } from "node:crypto";

import { normalizeLearnUrl, topicId, MAX_TITLE, MAX_SUMMARY } from "./topic-sanitize.js";
import { plainTextDeep } from "./plain-text.js";

export const SNAPSHOT_SCHEMA_VERSION = 1;
export const DEFAULT_HARNESS_IDS = ["standard", "microsoft-copilot", "customer-conversation"];
export const UNCATEGORIZED = "uncategorized";
export const MAX_TOPICS = 1000;
// A merged topic keeps every companion Learn page as a sub-topic. This bound only guards a tampered file:
// consolidation never reaches it, because a group larger than the bound is split into several topics, not truncated.
export const MAX_SUBTOPICS = 60;
export const MAX_URLS = MAX_SUBTOPICS + 1;
export const SUBTOPIC_LEVELS = [100, 200, 300];

const ID = /^learn-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HASH = /^[0-9a-f]{16}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const STAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;
export const AVAILABILITY_VALUES = ["ga", "preview", "retired"];
const TOPIC_STATUS = ["covered", "new"];
const CHECK_STATUS = ["current", "updated", "stale", "unknown"];

/**
 * Check a parsed snapshot. Returns human-readable problems; an empty array
 * means the snapshot is safe to use.
 */
export function validateSnapshot(snapshot, { harnessIds = DEFAULT_HARNESS_IDS } = {}) {
  const problems = [];
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return ["snapshot must be an object"];
  if (snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) problems.push(`schemaVersion must be ${SNAPSHOT_SCHEMA_VERSION}`);
  if (typeof snapshot.generatedAt !== "string" || !STAMP.test(snapshot.generatedAt) || Number.isNaN(Date.parse(snapshot.generatedAt))) {
    problems.push("generatedAt must be an ISO timestamp in UTC");
  }
  if (!Array.isArray(snapshot.topics)) return [...problems, "topics must be an array"];
  if (snapshot.topics.length > MAX_TOPICS) return [...problems, `topics may hold at most ${MAX_TOPICS} entries`];

  const seen = new Set();
  snapshot.topics.forEach((topic, position) => {
    const label = `topics[${position}]`;
    if (!topic || typeof topic !== "object") {
      problems.push(`${label}: must be an object`);
      return;
    }
    if (typeof topic.id !== "string" || !ID.test(topic.id) || topic.id.length > 80) problems.push(`${label}: id must be a learn- slug of at most 80 characters`);
    else if (seen.has(topic.id)) problems.push(`${label}: duplicate id ${topic.id}`);
    else seen.add(topic.id);
    if (typeof topic.title !== "string" || !topic.title.trim() || topic.title.length > MAX_TITLE) problems.push(`${label}: title must be 1-${MAX_TITLE} characters`);
    if (typeof topic.summary !== "string" || topic.summary.length > MAX_SUMMARY) problems.push(`${label}: summary must be at most ${MAX_SUMMARY} characters`);
    if (!Array.isArray(topic.urls) || !topic.urls.length || topic.urls.length > MAX_URLS) problems.push(`${label}: urls must list 1-${MAX_URLS} Learn URLs`);
    else if (topic.urls.some((url) => normalizeLearnUrl(url) !== url)) problems.push(`${label}: every url must be a canonical https learn.microsoft.com URL`);
    else if (typeof topic.id === "string" && topic.id.length <= 80 && topicId(topic.urls[0]) !== topic.id) problems.push(`${label}: id does not match its first url`);
    if (topic.subtopics !== undefined) {
      if (!Array.isArray(topic.subtopics) || !topic.subtopics.length || topic.subtopics.length > MAX_SUBTOPICS) {
        problems.push(`${label}: subtopics must list 1-${MAX_SUBTOPICS} merged Learn pages`);
      } else {
        topic.subtopics.forEach((sub, subIdx) => {
          const subLabel = `${label}.subtopics[${subIdx}]`;
          if (!sub || typeof sub !== "object" || Array.isArray(sub)) {
            problems.push(`${subLabel}: must be an object`);
            return;
          }
          if (typeof sub.url !== "string" || normalizeLearnUrl(sub.url) !== sub.url) {
            problems.push(`${subLabel}: url must be a canonical https learn.microsoft.com URL`);
          } else if (Array.isArray(topic.urls) && !topic.urls.includes(sub.url)) {
            problems.push(`${subLabel}: url must also appear in topic.urls`);
          } else if (typeof sub.id !== "string" || topicId(sub.url) !== sub.id) {
            problems.push(`${subLabel}: id must match topicId(url)`);
          }
          if (typeof sub.title !== "string" || !sub.title.trim() || sub.title.length > MAX_TITLE) {
            problems.push(`${subLabel}: title must be 1-${MAX_TITLE} characters`);
          }
          if (sub.summary !== undefined && (typeof sub.summary !== "string" || sub.summary.length > MAX_SUMMARY)) {
            problems.push(`${subLabel}: summary must be at most ${MAX_SUMMARY} characters`);
          }
          if (sub.level !== undefined && !SUBTOPIC_LEVELS.includes(sub.level)) {
            problems.push(`${subLabel}: level must be 100, 200, or 300 when present`);
          }
          if (sub.availability !== undefined && !AVAILABILITY_VALUES.includes(sub.availability)) {
            problems.push(`${subLabel}: availability must be ga, preview, or retired when present`);
          }
        });
      }
    }
    // A topic of a product without harnesses (it names its `product`) has no harnesses; a Copilot Studio topic must name at least one.
    const harnessless = typeof topic.product === "string" && topic.product !== "copilot-studio";
    if (!Array.isArray(topic.harnesses) || (!harnessless && !topic.harnesses.length) || topic.harnesses.some((h) => !harnessIds.includes(h))) {
      problems.push(`${label}: harnesses must name known harnesses`);
    }
    if (topic.product !== undefined && !/^[a-z][a-z0-9-]*$/.test(String(topic.product))) problems.push(`${label}: product must be a slug`);
    if (typeof topic.conceptId !== "string" || !/^[a-z][a-z0-9-]*$/.test(topic.conceptId)) problems.push(`${label}: conceptId must be a slug`);
    if (topic.availability !== null && !AVAILABILITY_VALUES.includes(topic.availability)) problems.push(`${label}: availability must be ga, preview, retired, or null`);
    if (!TOPIC_STATUS.includes(topic.status)) problems.push(`${label}: status must be covered or new`);
    if (!Array.isArray(topic.featureIds) || topic.featureIds.some((id) => typeof id !== "string")) problems.push(`${label}: featureIds must be an array of strings`);
    if (![100, 200, 300].includes(topic.level)) problems.push(`${label}: level must be 100, 200, or 300`);
    if (typeof topic.contentHash !== "string" || !HASH.test(topic.contentHash)) problems.push(`${label}: contentHash must be 16 hex characters`);
    for (const field of ["firstSeen", "lastSeen"]) {
      if (typeof topic[field] !== "string" || !DAY.test(topic[field])) problems.push(`${label}: ${field} must be YYYY-MM-DD`);
    }
    if (topic.changedAt !== null && (typeof topic.changedAt !== "string" || !DAY.test(topic.changedAt))) problems.push(`${label}: changedAt must be YYYY-MM-DD or null`);
  });

  if (!Array.isArray(snapshot.catalog)) problems.push("catalog must be an array");
  else {
    snapshot.catalog.forEach((check, position) => {
      const label = `catalog[${position}]`;
      if (!check || typeof check.featureId !== "string") problems.push(`${label}: featureId is required`);
      if (!CHECK_STATUS.includes(check?.status)) problems.push(`${label}: status must be one of ${CHECK_STATUS.join(", ")}`);
      if (check?.contentHash !== null && !HASH.test(String(check?.contentHash))) problems.push(`${label}: contentHash must be 16 hex characters or null`);
      if (check?.changedAt !== null && !DAY.test(String(check?.changedAt))) problems.push(`${label}: changedAt must be YYYY-MM-DD or null`);
      if (!Array.isArray(check?.missing) || check.missing.some((url) => normalizeLearnUrl(url) !== url)) problems.push(`${label}: missing must list canonical Learn URLs`);
    });
  }
  if (snapshot.pageHashes !== undefined) {
    const entries = Object.entries(snapshot.pageHashes || {});
    if (typeof snapshot.pageHashes !== "object" || Array.isArray(snapshot.pageHashes) || entries.length > 2000) problems.push("pageHashes must be an object of at most 2000 entries");
    else if (entries.some(([url, hash]) => normalizeLearnUrl(url) !== url || !HASH.test(String(hash)))) problems.push("pageHashes must map canonical Learn URLs to 16 hex characters");
  }
  if (typeof snapshot.listHash !== "string" || !HASH.test(snapshot.listHash)) problems.push("listHash must be 16 hex characters");
  else if (!problems.length && snapshot.listHash !== listHash(snapshot)) problems.push("listHash does not match the topics");
  return problems;
}

/**
 * Hash of what a reviewer would see change: the topics and catalog checks, not
 * the timestamps. A refresh that finds nothing new produces the same hash, so
 * it can be told apart from one that changed the list.
 */
export function listHash(snapshot) {
  const stable = {
    topics: (snapshot.topics || []).map(({ lastSeen: _lastSeen, ...topic }) => topic),
    catalog: snapshot.catalog || [],
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex").slice(0, 16);
}

/**
 * Covered, new, and stale counts per harness: the numbers the refresh CLI and
 * the pull request description report.
 *
 * @param {object} snapshot
 * @param {Array<{id:string, harness?:string[]}>} features catalog features, for the harness of a stale entry
 */
export function summarize(snapshot, features = []) {
  const harnessOf = new Map(features.map((f) => [f.id, f.harness || []]));
  const counts = {};
  const bucket = (harness) => (counts[harness] ||= { covered: 0, new: 0, stale: 0, updated: 0 });
  for (const topic of snapshot.topics || []) {
    for (const harness of topic.harnesses) {
      bucket(harness)[topic.status] += 1;
      if (topic.changedAt && topic.changedAt === snapshot.generatedAt?.slice(0, 10)) bucket(harness).updated += 1;
    }
  }
  for (const check of snapshot.catalog || []) {
    if (check.status !== "stale") continue;
    for (const harness of harnessOf.get(check.featureId) || []) bucket(harness).stale += 1;
  }
  return counts;
}

/** Read and validate a snapshot file. Returns null when it is missing or invalid. */
export function readSnapshot(file, options) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    // A snapshot saved from Learn text may carry check marks or other symbols; what is read and shown is plain text.
    return validateSnapshot(parsed, options).length ? null : plainTextDeep(parsed);
  } catch {
    return null;
  }
}

/** Write JSON through a uniquely named temp file so a crash or a second writer never leaves a half-written snapshot. */
export { writeJsonAtomic } from "../concurrency/atomic-file.js";
