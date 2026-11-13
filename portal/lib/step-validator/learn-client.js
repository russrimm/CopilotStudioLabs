/**
 * Microsoft Learn access for step validation.
 *
 * A thin, defensive layer over `lab-builder/learn-mcp.js` (the portal's existing
 * Learn MCP client, reused as-is for the handshake, JSON-RPC/SSE transport,
 * timeouts, and retry on transient errors). This layer adds what a long
 * validation run needs:
 *
 *   - a TTL cache (memory, plus an optional disk directory shared across runs)
 *   - a minimum interval between network calls and a total call budget
 *   - a circuit breaker, so an outage ends the run quickly instead of timing out
 *     on every claim
 *   - failures that stay failures. `searchDocs()` in learn-mcp.js returns [] on
 *     error, which would look like "no documentation found"; this client calls
 *     the search tool directly so the runner can report `unable`, never a
 *     false pass.
 *
 * Everything returned is untrusted data: only Microsoft Learn URLs are accepted,
 * sizes are capped, and callers treat the text as strings to search and display.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect, fetchDocPage, LEARN_MCP_ENDPOINT } from "../lab-builder/learn-mcp.js";
import { isLearnUrl, sanitizeExcerpt } from "./text.js";

const MAX_PAGE_CHARS = 400_000;
const MAX_RESULTS = 12;
const MAX_EXCERPT_CHARS = 4000;

function intFromEnv(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

const sleepMs = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Operation canceled", "AbortError"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Operation canceled", "AbortError"));
      },
      { once: true },
    );
  });

/** Pull { title, url, excerpt } records out of a search tool result. */
export function parseSearchResult(result) {
  if (!result) throw new Error("Learn MCP returned no result for microsoft_docs_search");
  const blocks = Array.isArray(result.content) ? result.content : [];
  if (result.isError) {
    const detail = blocks
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join(" ")
      .slice(0, 200);
    throw new Error(`microsoft_docs_search reported an error${detail ? `: ${detail}` : ""}`);
  }
  const out = [];
  for (const block of blocks) {
    if (block?.type !== "text" || typeof block.text !== "string") continue;
    const text = block.text.trim();
    let items = null;
    if (text.startsWith("[") || text.startsWith("{")) {
      try {
        const parsed = JSON.parse(text);
        items = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.results) ? parsed.results : [parsed];
      } catch {
        items = null;
      }
    }
    if (!items) {
      const url = text.match(/https:\/\/learn\.microsoft\.com\/[^\s)"'\]}<>]+/)?.[0];
      if (url) items = [{ title: "", url, content: text }];
      else continue;
    }
    for (const item of items) {
      const url = String(item?.contentUrl || item?.url || item?.link || "").trim();
      if (!isLearnUrl(url)) continue;
      out.push({
        title: sanitizeExcerpt(item.title || item.name || url, 200),
        url,
        excerpt: String(item.content || item.excerpt || item.snippet || "").slice(0, MAX_EXCERPT_CHARS),
      });
      if (out.length >= MAX_RESULTS) return out;
    }
  }
  return out;
}

/**
 * @param {object} [options]
 * @param {Function} [options.connectFn] injectable for tests; defaults to learn-mcp.js connect()
 * @param {Function} [options.fetchPageFn] injectable for tests; defaults to learn-mcp.js fetchDocPage()
 */
export function createLearnClient({
  connectFn = connect,
  fetchPageFn = fetchDocPage,
  endpoint = LEARN_MCP_ENDPOINT,
  signal,
  minIntervalMs = intFromEnv(process.env.STEP_VALIDATION_MIN_INTERVAL_MS, 250),
  maxCalls = intFromEnv(process.env.STEP_VALIDATION_MAX_CALLS, 2500),
  breakerThreshold = 5,
  cacheTtlMs = intFromEnv(process.env.STEP_VALIDATION_CACHE_TTL_MS, 24 * 60 * 60 * 1000),
  cacheDir = process.env.STEP_VALIDATION_CACHE_DIR || null,
  timeoutMs,
  now = Date.now,
  sleep = sleepMs,
} = {}) {
  const memory = new Map();
  const stats = { calls: 0, cacheHits: 0, failures: 0, searches: 0, pages: 0 };
  let sessionPromise = null;
  let consecutiveFailures = 0;
  let circuitOpen = false;
  let lastCallAt = 0;
  let lastError = null;
  let queue = Promise.resolve();

  const diskPath = (key) =>
    cacheDir ? join(cacheDir, `${createHash("sha1").update(key).digest("hex")}.json`) : null;

  function cacheGet(key) {
    const hit = memory.get(key);
    if (hit && now() - hit.at <= cacheTtlMs) return hit.value;
    const file = diskPath(key);
    if (!file) return undefined;
    try {
      const stored = JSON.parse(readFileSync(file, "utf8"));
      if (stored?.key === key && now() - stored.at <= cacheTtlMs) {
        memory.set(key, { at: stored.at, value: stored.value });
        return stored.value;
      }
    } catch {
      /* a missing or unreadable cache file is a miss */
    }
    return undefined;
  }

  function cacheSet(key, value) {
    const at = now();
    memory.set(key, { at, value });
    const file = diskPath(key);
    if (!file) return;
    try {
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(file, JSON.stringify({ at, key, value }));
    } catch {
      /* the cache is best effort */
    }
  }

  function getSession() {
    sessionPromise ??= connectFn({ endpoint, signal, ...(timeoutMs ? { timeoutMs } : {}) });
    return sessionPromise;
  }

  /**
   * Run one network call: serialized, spaced, budgeted, and counted against the breaker.
   * A failed page fetch can mean one retired page rather than an outage, so only
   * searches and handshakes (`breaker: true`) can open the circuit.
   */
  function networkCall(fn, { breaker = true } = {}) {
    const run = queue.then(async () => {
      if (signal?.aborted) throw new DOMException("Operation canceled", "AbortError");
      if (circuitOpen) return { ok: false, code: "circuit-open", error: lastError || "Microsoft Learn is unavailable" };
      if (stats.calls >= maxCalls) {
        return { ok: false, code: "budget", error: `Call budget of ${maxCalls} reached` };
      }
      const wait = lastCallAt + minIntervalMs - now();
      if (wait > 0) await sleep(wait, signal);
      lastCallAt = now();
      stats.calls += 1;
      try {
        const value = await fn();
        consecutiveFailures = 0;
        return { ok: true, value };
      } catch (err) {
        if (err?.name === "AbortError") throw err;
        stats.failures += 1;
        lastError = err?.message || String(err);
        if (breaker) {
          consecutiveFailures += 1;
          if (consecutiveFailures >= breakerThreshold) circuitOpen = true;
        }
        return { ok: false, code: "error", error: lastError };
      }
    });
    queue = run.catch(() => {});
    return run;
  }

  async function search(query) {
    const key = `search:${endpoint}:${query}`;
    const cached = cacheGet(key);
    if (cached) {
      stats.cacheHits += 1;
      return { ok: true, results: cached, cached: true };
    }
    const outcome = await networkCall(async () => {
      const session = await getSession();
      if (!session?.ok) throw new Error(session?.error || "Could not connect to Microsoft Learn");
      return parseSearchResult(await session.call("microsoft_docs_search", { query }));
    });
    if (!outcome.ok) return outcome;
    stats.searches += 1;
    cacheSet(key, outcome.value);
    return { ok: true, results: outcome.value, cached: false };
  }

  async function fetchPage(url) {
    if (!isLearnUrl(url)) return { ok: false, code: "blocked-url", error: "Only learn.microsoft.com pages can be fetched" };
    const key = `page:${endpoint}:${url}`;
    const cached = cacheGet(key);
    if (cached) {
      stats.cacheHits += 1;
      return { ok: true, url, markdown: cached, cached: true };
    }
    const outcome = await networkCall(async () => {
      const session = await getSession();
      if (!session?.ok) throw new Error(session?.error || "Could not connect to Microsoft Learn");
      const page = await fetchPageFn(session, url);
      if (page.error) throw new Error(page.error);
      if (!page.markdown.trim()) throw new Error("Microsoft Learn returned an empty page");
      return page.markdown.slice(0, MAX_PAGE_CHARS);
    }, { breaker: false });
    if (!outcome.ok) return outcome;
    stats.pages += 1;
    cacheSet(key, outcome.value);
    return { ok: true, url, markdown: outcome.value, cached: false };
  }

  return {
    endpoint,
    search,
    fetchPage,
    status: () => ({ ...stats, circuitOpen, lastError, maxCalls, endpoint }),
  };
}
