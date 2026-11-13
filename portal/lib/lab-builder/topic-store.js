/**
 * Persistence, freshness, and failure handling for the Microsoft Learn topic list.
 *
 * Where the list comes from, newest first:
 *   1. the runtime cache (written by a successful refresh; never committed)
 *   2. `learn-topics.snapshot.json`, the committed baseline
 *   3. nothing: the wizard then shows only the static catalog
 *
 * Every layer is validated before use, so a damaged or tampered file is
 * ignored rather than trusted. A refresh that fails never touches the cache.
 * This module imports nothing from the catalog, so the catalog can ask it for
 * discovered topics without an import cycle; the network lives in the injected
 * `discover` function.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { readSnapshot, validateSnapshot, writeJsonAtomic, listHash } from "./topic-snapshot.js";
import { topicToFeature } from "./topic-feature.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORTAL_ROOT = path.resolve(__dirname, "..", "..");

export const DAY_MS = 86400000;

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** All settings come from the environment so a deployment can move or tune them without code changes. */
export function topicConfig(env = process.env) {
  return {
    cachePath: env.LAB_BUILDER_TOPICS_CACHE || path.join(PORTAL_ROOT, "data", "lab-builder", "topics-cache.json"),
    snapshotPath: env.LAB_BUILDER_TOPICS_SNAPSHOT || path.join(__dirname, "learn-topics.snapshot.json"),
    ttlMs: positiveInt(env.LAB_BUILDER_TOPICS_TTL_MS, DAY_MS),
    disabled: /^(1|true|yes|on)$/i.test(env.LAB_BUILDER_TOPICS_DISABLED || ""),
    autoRefresh: /^(1|true|yes|on)$/i.test(env.LAB_BUILDER_TOPICS_AUTO_REFRESH || ""),
    autoRefreshMs: positiveInt(env.LAB_BUILDER_TOPICS_REFRESH_MS, DAY_MS),
    minRefreshIntervalMs: positiveInt(env.LAB_BUILDER_TOPICS_MIN_REFRESH_MS, 60000),
    breakerFailures: positiveInt(env.LAB_BUILDER_TOPICS_BREAKER_FAILURES, 3),
    breakerCooldownMs: positiveInt(env.LAB_BUILDER_TOPICS_BREAKER_COOLDOWN_MS, 15 * 60000),
    updatedWindowDays: positiveInt(env.LAB_BUILDER_TOPICS_UPDATED_DAYS, 30),
  };
}

/** The newest valid snapshot between the runtime cache and the committed baseline. */
export function loadBest({ cachePath, snapshotPath }) {
  const candidates = [
    { source: "cache", snapshot: readSnapshot(cachePath) },
    { source: "snapshot", snapshot: readSnapshot(snapshotPath) },
  ].filter((entry) => entry.snapshot);
  candidates.sort((a, b) => Date.parse(b.snapshot.generatedAt) - Date.parse(a.snapshot.generatedAt));
  return candidates[0] || null;
}

// ── Registry: lets the catalog resolve a discovered topic id to a feature ────
let loaded = null;
let override;

function current() {
  if (override !== undefined) return override;
  if (!loaded) loaded = { value: loadBest(topicConfig()) };
  return loaded.value;
}

/** Tests and the service use this to set or clear the in-memory view. Pass undefined to reload from disk. */
export function setTopicSource(entry) {
  override = entry;
  loaded = null;
}

/** Forget what was loaded so the next lookup reads the files again. */
export function resetTopicSource() {
  override = undefined;
  loaded = null;
}

/** Topics found on Learn that the static catalog does not cover. */
export function getNewTopics() {
  return (current()?.snapshot.topics || []).filter((topic) => topic.status === "new");
}

/** The feature for a discovered topic id, or null. Only topics that are new on Learn resolve. */
export function getDynamicFeature(id) {
  if (typeof id !== "string" || !id.startsWith("learn-")) return null;
  const topic = getNewTopics().find((entry) => entry.id === id);
  return topic ? topicToFeature(topic) : null;
}

export function countNewTopics() {
  return getNewTopics().length;
}

// ── Service ──────────────────────────────────────────────────────────────────

/**
 * @param {object} options
 * @param {(ctx:{previous:object|null, signal?:AbortSignal}) => Promise<object>} options.discover
 *   builds a snapshot; throwing means the refresh failed
 * @param {ReturnType<typeof topicConfig>} [options.config]
 * @param {() => number} [options.now]
 */
export function createTopicService({ discover, config = topicConfig(), now = Date.now }) {
  let entry = null;
  let started = false;
  let inflight = null;
  let failures = 0;
  let openUntil = 0;
  let lastAttemptAt = 0;
  let lastError = null;
  let timer = null;

  function ensureLoaded() {
    if (!started) {
      started = true;
      entry = loadBest(config);
    }
    return entry;
  }

  const ageMs = () => (ensureLoaded() ? Math.max(0, now() - Date.parse(entry.snapshot.generatedAt)) : null);
  const breakerOpen = () => now() < openUntil;

  /** What the API reports: the list, where it came from, and how fresh it is. */
  function view() {
    const best = ensureLoaded();
    const age = ageMs();
    return {
      source: best ? best.source : "catalog",
      snapshot: best ? best.snapshot : null,
      refreshedAt: best ? best.snapshot.generatedAt : null,
      ageMs: age,
      stale: best ? age > config.ttlMs : true,
      refreshing: Boolean(inflight),
      offline: Boolean(lastError) && (!best || best.source !== "cache" || age > config.ttlMs),
      disabled: config.disabled,
      lastError,
      circuitOpen: breakerOpen(),
      retryAfterSec: breakerOpen() ? Math.ceil((openUntil - now()) / 1000) : 0,
    };
  }

  async function run({ signal } = {}) {
    lastAttemptAt = now();
    try {
      const previous = ensureLoaded()?.snapshot || null;
      const snapshot = await discover({ previous, signal });
      const problems = validateSnapshot(snapshot);
      if (problems.length) throw new Error(`Discovery produced an invalid snapshot: ${problems.slice(0, 3).join("; ")}`);
      const changed = !previous || previous.listHash !== snapshot.listHash;
      writeJsonAtomic(config.cachePath, snapshot);
      entry = { source: "cache", snapshot };
      setTopicSource(entry);
      failures = 0;
      lastError = null;
      return { ok: true, changed, refreshedAt: snapshot.generatedAt, topics: snapshot.topics.length, partial: Boolean(snapshot.partial) };
    } catch (err) {
      if (err?.name === "AbortError") throw err;
      failures += 1;
      lastError = { message: String(err?.message || err).slice(0, 300), at: new Date(now()).toISOString() };
      if (failures >= config.breakerFailures) openUntil = now() + config.breakerCooldownMs;
      return { ok: false, reason: "failed", error: lastError.message };
    }
  }

  /**
   * Refresh from Microsoft Learn. One refresh runs at a time; callers during a
   * refresh share its result. Disabled, too-soon, and circuit-open refreshes
   * return a reason instead of calling the network.
   */
  function refresh(options = {}) {
    if (config.disabled) return Promise.resolve({ ok: false, reason: "disabled", error: "Refreshing from Microsoft Learn is turned off on this server." });
    if (inflight) return inflight;
    if (breakerOpen()) {
      return Promise.resolve({
        ok: false,
        reason: "circuit-open",
        retryAfterSec: Math.ceil((openUntil - now()) / 1000),
        error: "Microsoft Learn has failed repeatedly, so refreshing is paused. The last good list is still in use.",
      });
    }
    const wait = lastAttemptAt + config.minRefreshIntervalMs - now();
    if (wait > 0) {
      return Promise.resolve({ ok: false, reason: "too-soon", retryAfterSec: Math.ceil(wait / 1000), error: "A refresh just ran. Try again in a moment." });
    }
    inflight = run(options).finally(() => {
      inflight = null;
    });
    return inflight;
  }

  /** Stale-while-revalidate: serve what we have and refresh in the background when it has aged out. */
  function revalidateIfStale() {
    if (config.disabled || inflight || breakerOpen()) return false;
    if (!view().stale) return false;
    if (lastAttemptAt + config.minRefreshIntervalMs > now()) return false;
    refresh().catch(() => {});
    return true;
  }

  function startAutoRefresh() {
    if (timer || config.disabled || !config.autoRefresh) return false;
    timer = setInterval(() => {
      if (view().stale) refresh().catch(() => {});
    }, config.autoRefreshMs);
    timer.unref?.();
    return true;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { view, refresh, revalidateIfStale, startAutoRefresh, stop, config };
}

export { listHash };
