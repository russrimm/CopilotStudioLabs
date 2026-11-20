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

import { resolvePortalDataDir } from "../storage-config.js";
import { listHash, readSnapshot, validateSnapshot, writeJsonAtomic } from "./topic-snapshot.js";
import { consolidateSnapshot, resolveTopicAlias } from "./topic-consolidate.js";
import { topicToFeature } from "./topic-feature.js";
import { buildSubtopicIndex } from "./subtopics.js";
import { DEFAULT_PRODUCT, getProducts } from "./products.js";
import { MAX_USER_TOPICS, readUserTopics, writeUserTopics } from "./user-topics.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DAY_MS = 86400000;

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** All settings come from the environment so a deployment can move or tune them without code changes. */
export function topicConfig(env = process.env) {
  const cachePath = env.LAB_BUILDER_TOPICS_CACHE || path.join(resolvePortalDataDir(env), "lab-builder", "topics-cache.json");
  const snapshotPath = env.LAB_BUILDER_TOPICS_SNAPSHOT || path.join(__dirname, "learn-topics.snapshot.json");
  return {
    cachePath,
    snapshotPath,
    userTopicsPath: env.LAB_BUILDER_USER_TOPICS || path.join(path.dirname(cachePath), "user-topics.json"),
    // Every other product keeps its own cache and committed snapshot next to the Copilot Studio ones unless a folder is named.
    ...(env.LAB_BUILDER_TOPICS_PRODUCT_CACHE_DIR ? { productCacheDir: env.LAB_BUILDER_TOPICS_PRODUCT_CACHE_DIR } : {}),
    ...(env.LAB_BUILDER_TOPICS_PRODUCT_SNAPSHOT_DIR ? { productSnapshotDir: env.LAB_BUILDER_TOPICS_PRODUCT_SNAPSHOT_DIR } : {}),
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
    { source: "cache", snapshot: consolidateSnapshot(readSnapshot(cachePath)) },
    { source: "snapshot", snapshot: consolidateSnapshot(readSnapshot(snapshotPath)) },
  ].filter((entry) => entry.snapshot);
  candidates.sort((a, b) => Date.parse(b.snapshot.generatedAt) - Date.parse(a.snapshot.generatedAt));
  return candidates[0] || null;
}

// ── Registry: lets the catalog resolve a discovered topic id to a feature ────
let loaded = null;
let override;
let loadedExtras = null;
let overrideExtras;
let loadedUser = null;
let overrideUser;

/** Where a product's own cache and committed snapshot live. Copilot Studio keeps the original file names. */
export function productPaths(config, product = DEFAULT_PRODUCT) {
  if (product === DEFAULT_PRODUCT) return { cachePath: config.cachePath, snapshotPath: config.snapshotPath };
  return {
    cachePath: path.join(config.productCacheDir || path.dirname(config.cachePath), `topics-cache-${product}.json`),
    snapshotPath: path.join(config.productSnapshotDir || path.dirname(config.snapshotPath), `learn-topics.${product}.snapshot.json`),
  };
}

/** The products other than Copilot Studio, in display order. */
export function otherProductIds() {
  return getProducts().map((p) => p.id).filter((id) => id !== DEFAULT_PRODUCT);
}

/** Each other product's newest valid snapshot (cache or committed), for the products that have one. */
export function loadProductsBest(config) {
  const found = new Map();
  for (const product of otherProductIds()) {
    const best = loadBest(productPaths(config, product));
    if (best) found.set(product, best);
  }
  return found;
}

function current() {
  if (override !== undefined) return override;
  if (!loaded) loaded = { value: loadBest(topicConfig()) };
  return loaded.value;
}

function currentExtras() {
  if (overrideExtras !== undefined) return overrideExtras;
  // A test that injects the Copilot Studio list gets no product snapshots unless it injects those too.
  if (override !== undefined) return new Map();
  if (!loadedExtras) loadedExtras = { value: loadProductsBest(topicConfig()) };
  return loadedExtras.value;
}

/** The topics a person added from Microsoft Learn (see user-topics.js). */
function currentUserTopics() {
  if (overrideUser !== undefined) return overrideUser;
  // A test that injects the Copilot Studio list sees no saved topics unless it injects those too.
  if (override !== undefined) return [];
  if (!loadedUser) loadedUser = { value: readUserTopics(topicConfig().userTopicsPath) };
  return loadedUser.value;
}

/** Set the saved topics in memory (the service does after every change). Pass undefined to read the file again. */
export function setUserTopicsSource(list) {
  overrideUser = list;
  loadedUser = null;
}

/** The saved topics, for the API and for tests. */
export function getUserTopics() {
  return currentUserTopics();
}

/** Every topic of every list: Copilot Studio first, then the other products, then the ones a person added. */
function allTopics() {
  return [
    ...(current()?.snapshot?.topics || []),
    ...[...currentExtras().values()].flatMap((entry) => entry.snapshot?.topics || []),
    ...currentUserTopics(),
  ];
}

/** Tests and the service use this to set or clear the in-memory view. Pass undefined to reload from disk. */
export function setTopicSource(entry) {
  override =
    entry && entry.snapshot
      ? { ...entry, snapshot: consolidateSnapshot(entry.snapshot, { syncCatalogCoverage: false }) }
      : entry;
  loaded = null;
}

/** Set or clear one other product's in-memory list (the service calls this after a refresh). */
export function setProductTopicSource(product, entry) {
  const next = new Map(currentExtras());
  if (entry?.snapshot) next.set(product, { ...entry, snapshot: consolidateSnapshot(entry.snapshot, { syncCatalogCoverage: false }) });
  else next.delete(product);
  overrideExtras = next;
}

/** Forget what was loaded so the next lookup reads the files again. */
export function resetTopicSource() {
  override = undefined;
  loaded = null;
  overrideExtras = undefined;
  loadedExtras = null;
  overrideUser = undefined;
  loadedUser = null;
}

/** Topics found on Learn that the static catalog does not cover. */
export function getNewTopics() {
  return allTopics().filter((topic) => topic.status === "new");
}

/** Resolve a merged or catalog-covered `learn-*` topic id to its canonical id. */
export function resolveLearnedTopicId(id, { harness = null, allowCoveredFeature = false } = {}) {
  return resolveTopicAlias(id, {
    topics: allTopics(),
    harness,
    allowCoveredFeature,
  });
}

/** The feature for a discovered topic id (including merged companion subtopic ids), or null. */
export function getDynamicFeature(id, { excludedSubtopics = null } = {}) {
  if (typeof id !== "string" || !id.startsWith("learn-")) return null;
  const resolvedId = resolveLearnedTopicId(id);
  if (!resolvedId) return null;
  const topic = getNewTopics().find((entry) => entry.id === resolvedId);
  return topic ? topicToFeature(topic, { excludedSubtopics }) : null;
}

/** Every sub-topic of every discovered topic, by id: what a request may name in `excludedSubtopics`. */
export function getSubtopicIndex() {
  return buildSubtopicIndex(getNewTopics());
}

export function countNewTopics() {
  return getNewTopics().length;
}

// ── Service ──────────────────────────────────────────────────────────────────

/**
 * @param {object} options
 * @param {(ctx:{previous:object|null, signal?:AbortSignal, product?:string}) => Promise<object>} options.discover
 *   builds a snapshot (for `product` when it is not Copilot Studio); throwing means the refresh failed
 * @param {ReturnType<typeof topicConfig>} [options.config]
 * @param {() => number} [options.now]
 */
export function createTopicService({ discover, config = topicConfig(), now = Date.now }) {
  // One state per product: its loaded list, any refresh in flight, and its last attempt and error.
  const states = new Map();
  let failures = 0;
  let openUntil = 0;
  let timer = null;

  function stateFor(product = DEFAULT_PRODUCT) {
    if (!states.has(product)) states.set(product, { entry: null, started: false, inflight: null, lastAttemptAt: 0, lastError: null });
    return states.get(product);
  }

  function ensureLoaded(product = DEFAULT_PRODUCT) {
    const state = stateFor(product);
    if (!state.started) {
      state.started = true;
      state.entry = loadBest(productPaths(config, product));
    }
    return state.entry;
  }

  const ageMs = (product) => (ensureLoaded(product) ? Math.max(0, now() - Date.parse(stateFor(product).entry.snapshot.generatedAt)) : null);
  const breakerOpen = () => now() < openUntil;

  /** What the API reports for one product: the list, where it came from, and how fresh it is. */
  function view(product = DEFAULT_PRODUCT) {
    const best = ensureLoaded(product);
    const state = stateFor(product);
    const age = ageMs(product);
    return {
      product,
      source: best ? best.source : "catalog",
      snapshot: best ? best.snapshot : null,
      refreshedAt: best ? best.snapshot.generatedAt : null,
      ageMs: age,
      stale: best ? age > config.ttlMs : true,
      refreshing: Boolean(state.inflight),
      offline: Boolean(state.lastError) && (!best || best.source !== "cache" || age > config.ttlMs),
      disabled: config.disabled,
      lastError: state.lastError,
      circuitOpen: breakerOpen(),
      retryAfterSec: breakerOpen() ? Math.ceil((openUntil - now()) / 1000) : 0,
    };
  }

  /** The view of every product that has a list, Copilot Studio first. */
  function views() {
    return [view(DEFAULT_PRODUCT), ...otherProductIds().map((product) => view(product)).filter((v) => v.snapshot)];
  }

  async function run({ signal, product = DEFAULT_PRODUCT } = {}) {
    const state = stateFor(product);
    state.lastAttemptAt = now();
    try {
      const previous = ensureLoaded(product)?.snapshot || null;
      const snapshot = await discover({ previous, signal, ...(product === DEFAULT_PRODUCT ? {} : { product }) });
      const problems = validateSnapshot(snapshot);
      if (problems.length) throw new Error(`Discovery produced an invalid snapshot: ${problems.slice(0, 3).join("; ")}`);
      const changed = !previous || previous.listHash !== snapshot.listHash;
      writeJsonAtomic(productPaths(config, product).cachePath, snapshot);
      state.entry = { source: "cache", snapshot };
      if (product === DEFAULT_PRODUCT) setTopicSource(state.entry);
      else setProductTopicSource(product, state.entry);
      failures = 0;
      state.lastError = null;
      return { ok: true, changed, refreshedAt: snapshot.generatedAt, topics: snapshot.topics.length, partial: Boolean(snapshot.partial) };
    } catch (err) {
      if (err?.name === "AbortError") throw err;
      failures += 1;
      state.lastError = { message: String(err?.message || err).slice(0, 300), at: new Date(now()).toISOString() };
      if (failures >= config.breakerFailures) openUntil = now() + config.breakerCooldownMs;
      return { ok: false, reason: "failed", error: state.lastError.message };
    }
  }

  /**
   * Refresh from Microsoft Learn (`product` defaults to Copilot Studio). One refresh per product runs at a time;
   * callers during a refresh share its result. Disabled, too-soon, and circuit-open refreshes
   * return a reason instead of calling the network.
   */
  function refresh(options = {}) {
    const product = options.product || DEFAULT_PRODUCT;
    const state = stateFor(product);
    if (config.disabled) return Promise.resolve({ ok: false, reason: "disabled", error: "Refreshing from Microsoft Learn is turned off on this server." });
    if (state.inflight) return state.inflight;
    if (breakerOpen()) {
      return Promise.resolve({
        ok: false,
        reason: "circuit-open",
        retryAfterSec: Math.ceil((openUntil - now()) / 1000),
        error: "Microsoft Learn has failed repeatedly, so refreshing is paused. The last good list is still in use.",
      });
    }
    const wait = state.lastAttemptAt + config.minRefreshIntervalMs - now();
    if (wait > 0) {
      return Promise.resolve({ ok: false, reason: "too-soon", retryAfterSec: Math.ceil(wait / 1000), error: "A refresh just ran. Try again in a moment." });
    }
    state.inflight = run({ ...options, product }).finally(() => {
      state.inflight = null;
    });
    return state.inflight;
  }

  /** Stale-while-revalidate: serve what we have and refresh in the background when it has aged out. */
  function revalidateIfStale() {
    const state = stateFor(DEFAULT_PRODUCT);
    if (config.disabled || state.inflight || breakerOpen()) return false;
    if (!view().stale) return false;
    if (state.lastAttemptAt + config.minRefreshIntervalMs > now()) return false;
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

  /** The topics a person added from Microsoft Learn: the file when one is configured, otherwise memory only. */
  let memoryUserTopics = [];
  function userTopics() {
    return config.userTopicsPath ? readUserTopics(config.userTopicsPath) : memoryUserTopics;
  }

  function saveUserTopics(list) {
    if (config.userTopicsPath) writeUserTopics(config.userTopicsPath, list);
    else memoryUserTopics = list;
    setUserTopicsSource(list);
  }

  /** Save one topic. Returns false when it is already saved (the same id). */
  function addUserTopic(topic) {
    const list = userTopics();
    if (list.some((entry) => entry.id === topic.id)) return false;
    if (list.length >= MAX_USER_TOPICS) throw new Error(`You can keep up to ${MAX_USER_TOPICS} topics of your own. Remove one first.`);
    saveUserTopics([...list, topic]);
    return true;
  }

  /** Remove a saved topic. Returns false when there was none with that id. */
  function removeUserTopic(id) {
    const list = userTopics();
    if (!list.some((entry) => entry.id === id)) return false;
    saveUserTopics(list.filter((entry) => entry.id !== id));
    return true;
  }

  return { view, views, refresh, revalidateIfStale, startAutoRefresh, stop, config, userTopics, addUserTopic, removeUserTopic };
}

export { listHash };
