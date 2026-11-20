/**
 * Topics a person added from Microsoft Learn (a search result or a pasted link).
 *
 * They live in one small JSON file next to the topic caches, so they survive a restart and show up in the
 * Topics step the next time, next to the topics Learn discovery found. A saved topic has the same shape as a
 * discovered one, so it builds into a lab exactly the same way. Every entry is validated when read: a damaged or
 * tampered file is ignored entry by entry, never trusted.
 *
 * This module imports nothing from the catalog, so the topic registry can read it without an import cycle.
 */

import fs from "node:fs";
import path from "node:path";

import { resolvePortalDataDir } from "../storage-config.js";
import { listHash, validateSnapshot, writeJsonAtomic } from "./topic-snapshot.js";

export const MAX_USER_TOPICS = 100;
export const USER_TOPICS_SCHEMA_VERSION = 1;

/** Where the file lives: next to the topic caches unless a deployment names it. */
export function userTopicsPath(env = process.env) {
  return env.LAB_BUILDER_USER_TOPICS || path.join(resolvePortalDataDir(env), "lab-builder", "user-topics.json");
}

/** True when one saved topic is a well-formed `new` topic with a Learn address. */
function validEntry(entry) {
  if (!entry || typeof entry !== "object" || entry.status !== "new" || entry.userAdded !== true) return false;
  const snapshot = {
    schemaVersion: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    source: "user-topics",
    topics: [entry],
    catalog: [],
    pageHashes: {},
  };
  snapshot.listHash = listHash(snapshot);
  return validateSnapshot(snapshot).length === 0;
}

/** The saved topics that pass validation, oldest first. A missing or unreadable file is an empty list. */
export function readUserTopics(file) {
  if (!file) return [];
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  const entries = Array.isArray(parsed?.topics) ? parsed.topics : [];
  const seen = new Set();
  const kept = [];
  for (const entry of entries) {
    if (!validEntry(entry) || seen.has(entry.id)) continue;
    seen.add(entry.id);
    kept.push(entry);
    if (kept.length >= MAX_USER_TOPICS) break;
  }
  return kept;
}

/** Save the list. Throws when it is over the limit so a full list never silently drops a topic. */
export function writeUserTopics(file, topics) {
  if (topics.length > MAX_USER_TOPICS) throw new Error(`You can keep up to ${MAX_USER_TOPICS} topics of your own. Remove one first.`);
  writeJsonAtomic(file, { schemaVersion: USER_TOPICS_SCHEMA_VERSION, topics });
}
