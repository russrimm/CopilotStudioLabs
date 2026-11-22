/**
 * Microsoft Learn MCP client.
 *
 * Minimal streamable-HTTP JSON-RPC client for the public Microsoft Learn MCP
 * server (https://learn.microsoft.com/api/mcp). No authentication is required.
 *
 * The server responds with `text/event-stream` framing even for single
 * request/response pairs, so responses are parsed out of SSE `data:` lines.
 *
 * Every call degrades gracefully: if the server is unreachable, slow, or
 * changes shape, the functions return an empty result set and the lab
 * generator falls back to the curated `docUrls` in the feature catalog.
 *
 * Many people share one portal, so this client is also a good neighbor to
 * Microsoft Learn: at most LAB_BUILDER_LEARN_MAX_CONCURRENT requests are in
 * flight at once (default 6), identical lookups made at the same moment share
 * one request, a retry honors Retry-After, and the cache holds at most
 * LAB_BUILDER_LEARN_CACHE_MAX entries (default 500).
 */

import { rankResults, DEFAULT_FLOOR, MAX_SOURCES } from "./relevance.js";
import { dedupeLearnSources } from "./learn-citations.js";

const DEFAULT_ENDPOINT = process.env.LEARN_MCP_URL || "https://learn.microsoft.com/api/mcp";
const DEFAULT_TIMEOUT_MS = Number(process.env.LEARN_MCP_TIMEOUT_MS || 30000);
const PROTOCOL_VERSION = "2025-06-18";

const CACHE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_CACHE_MAX_ENTRIES = 500;
const DEFAULT_MAX_CONCURRENT = 6;
const RETRY_BASE_MS = 250;
const MAX_RETRY_DELAY_MS = 10000;
const cache = new Map();
// One entry per cache key that has a network call under way, so identical misses at the same time share that one call.
const flights = new Map();

/** A positive whole number from the environment, read at the time it is needed so a deployment (or a test) can change it. */
function positiveIntEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

/** Store a value. The map keeps insertion order, so re-adding a key moves it to the back and the front is always the oldest. */
function cacheSet(key, value) {
  cache.delete(key);
  cache.set(key, { at: Date.now(), value });
  const max = positiveIntEnv("LAB_BUILDER_LEARN_CACHE_MAX", DEFAULT_CACHE_MAX_ENTRIES);
  while (cache.size > max) cache.delete(cache.keys().next().value);
}

// ── Outgoing request limit: a FIFO semaphore shared by everything in this process ────────────────

let activeRequests = 0;
const queuedRequests = [];

function drainRequestQueue() {
  while (queuedRequests.length && activeRequests < positiveIntEnv("LAB_BUILDER_LEARN_MAX_CONCURRENT", DEFAULT_MAX_CONCURRENT)) {
    activeRequests += 1;
    queuedRequests.shift().grant(makeRelease());
  }
}

function makeRelease() {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeRequests -= 1;
    drainRequestQueue();
  };
}

/** Wait for a free slot (first come, first served). A caller that is cancelled while waiting leaves the line. */
function acquireRequestSlot(signal) {
  if (signal?.aborted) return Promise.reject(abortError(signal.reason));
  if (!queuedRequests.length && activeRequests < positiveIntEnv("LAB_BUILDER_LEARN_MAX_CONCURRENT", DEFAULT_MAX_CONCURRENT)) {
    activeRequests += 1;
    return Promise.resolve(makeRelease());
  }
  return new Promise((resolve, reject) => {
    const waiter = {
      grant(release) {
        signal?.removeEventListener("abort", onAbort);
        resolve(release);
      },
    };
    const onAbort = () => {
      const index = queuedRequests.indexOf(waiter);
      if (index !== -1) queuedRequests.splice(index, 1);
      reject(abortError(signal.reason));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    queuedRequests.push(waiter);
  });
}

/** How many Learn requests are in flight and how many wait for a slot. For tests and diagnostics. */
export function learnRequestStats() {
  return { active: activeRequests, queued: queuedRequests.length };
}

// ── Single flight: identical cache misses at the same moment make one network call ────────────────

/** Resolve or reject with `promise`, but give up as soon as `signal` aborts. */
function untilAborted(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * Run `start` once for `key` however many callers ask at the same time; every caller gets its result. A flight is
 * forgotten the moment it ends, so a failure is never remembered and the next caller starts a fresh one. When the caller
 * that started a flight is cancelled, the others (who were not) start a new flight instead of inheriting the cancellation.
 */
async function singleFlight(key, signal, start) {
  for (;;) {
    if (signal?.aborted) throw abortError(signal.reason);
    let flight = flights.get(key);
    const leader = !flight;
    if (leader) {
      flight = Promise.resolve()
        .then(start)
        .finally(() => {
          if (flights.get(key) === flight) flights.delete(key);
        });
      flights.set(key, flight);
    }
    try {
      return await untilAborted(flight, signal);
    } catch (err) {
      if (!leader && err?.name === "AbortError" && !signal?.aborted) continue;
      throw err;
    }
  }
}

/** Pull JSON-RPC payloads out of an SSE or plain-JSON response body. */
function parseRpcBody(body) {
  const trimmed = body.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [];
    }
  }

  const messages = [];
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      messages.push(JSON.parse(payload));
    } catch {
      /* ignore malformed frames */
    }
  }
  return messages;
}

function abortError(reason = "Operation cancelled") {
  return new DOMException(String(reason), "AbortError");
}

function wait(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError(signal.reason));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal.reason));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Milliseconds a Retry-After header asks for (seconds, or an HTTP date); NaN when it is missing or unreadable. */
export function parseRetryAfterMs(value, now = Date.now()) {
  const text = String(value ?? "").trim();
  if (!text) return Number.NaN;
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  return Number.isNaN(at) ? Number.NaN : Math.max(0, at - now);
}

/**
 * How long to wait before retry number `attempt` (1 is the first retry): exponential backoff with jitter, never shorter
 * than the server asked for, never longer than ten seconds.
 */
export function retryDelayMs(attempt, retryAfterMs = Number.NaN, random = Math.random) {
  const backoff = RETRY_BASE_MS * 2 ** (attempt - 1);
  const asked = Number.isFinite(retryAfterMs) ? retryAfterMs : 0;
  const base = Math.min(MAX_RETRY_DELAY_MS, Math.max(backoff, asked));
  return Math.min(MAX_RETRY_DELAY_MS, Math.round(base + random() * base * 0.25));
}

async function rpc(endpoint, sessionId, body, timeoutMs, signal) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (signal?.aborted) throw abortError(signal.reason);
    try {
      return await rpcOnce(endpoint, sessionId, body, timeoutMs, signal);
    } catch (err) {
      lastError = err;
      if (signal?.aborted || (!err.retryable && err.name !== "AbortError") || attempt === 2) throw err;
      // The wait happens with no request slot held, so a server that says "later" does not stall other callers.
      await wait(retryDelayMs(attempt, err.retryAfterMs), signal);
    }
  }
  throw lastError;
}

async function rpcOnce(endpoint, sessionId, body, timeoutMs, signal) {
  const release = await acquireRequestSlot(signal);
  try {
    return await sendRpc(endpoint, sessionId, body, timeoutMs, signal);
  } finally {
    release();
  }
}

async function sendRpc(endpoint, sessionId, body, timeoutMs, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("Microsoft Learn request timed out"), timeoutMs);
  const cancel = () => controller.abort(signal.reason || "Operation cancelled");
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL_VERSION,
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;

    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await res.text();
    if (!res.ok) {
      const error = new Error(`Learn MCP responded ${res.status}: ${text.slice(0, 200)}`);
      error.retryable = res.status === 429 || res.status >= 500;
      if (res.status === 429 || res.status === 503) error.retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
      throw error;
    }
    return {
      sessionId: res.headers.get("mcp-session-id") || sessionId || null,
      messages: parseRpcBody(text),
    };
  } catch (err) {
    if (signal?.aborted) throw abortError(signal.reason);
    if (controller.signal.aborted) {
      const timeoutError = new Error(String(controller.signal.reason || "Microsoft Learn request timed out"));
      timeoutError.retryable = true;
      throw timeoutError;
    }
    if (err instanceof TypeError) err.retryable = true;
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}

function firstResult(messages, id) {
  const match = messages.find((m) => m && m.id === id);
  if (!match) return null;
  if (match.error) throw new Error(match.error.message || "Learn MCP returned an error");
  return match.result ?? null;
}

/**
 * Open an MCP session and return a `call(toolName, args)` helper.
 * Returns null when the handshake fails.
 */
export async function connect({ endpoint = DEFAULT_ENDPOINT, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  let sessionId = null;
  let nextId = 1;

  try {
    const init = await rpc(
      endpoint,
      null,
      {
        jsonrpc: "2.0",
        id: nextId++,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "copilot-studio-labs-lab-builder", version: "1.0.0" },
        },
      },
      timeoutMs,
      signal,
    );
    sessionId = init.sessionId;
    if (!firstResult(init.messages, 1)) {
      throw new Error("Learn MCP returned a malformed initialize response");
    }
  } catch (err) {
    if (signal?.aborted) throw err;
    return { ok: false, error: err.message, endpoint, call: async () => null };
  }

  return {
    ok: true,
    endpoint,
    sessionId,
    signal,
    async call(name, args) {
      const id = nextId++;
      const res = await rpc(
        endpoint,
        sessionId,
        { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } },
        timeoutMs,
        signal,
      );
      return firstResult(res.messages, id);
    },
  };
}

/** Normalize an MCP tool result into plain text chunks. */
function toTextChunks(result) {
  if (!result) return [];
  const content = Array.isArray(result.content) ? result.content : [];
  return content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text);
}

const URL_RE = /https?:\/\/[^\s)"'\]}<>]+/g;

/**
 * Turn a Learn search text chunk into { title, url, excerpt } records.
 * The server returns either a JSON array or markdown-ish text depending on
 * the query, so both shapes are handled.
 */
function parseSearchChunk(text) {
  const trimmed = text.trim();

  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      const items = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.results)
        ? parsed.results
        : Array.isArray(parsed?.value)
        ? parsed.value
        : [parsed];
      return items
        .map((item) => ({
          title: String(item.title || item.name || "").trim(),
          url: String(item.contentUrl || item.url || item.link || "").trim(),
          excerpt: String(item.content || item.excerpt || item.snippet || "").trim(),
        }))
        .filter((item) => item.url || item.excerpt);
    } catch {
      /* fall through to text parsing */
    }
  }

  const urls = trimmed.match(URL_RE) || [];
  const titleMatch = trimmed.match(/^#{0,6}\s*(.+)$/m);
  return [
    {
      title: titleMatch ? titleMatch[1].trim().slice(0, 160) : "",
      url: urls[0] || "",
      excerpt: trimmed,
    },
  ].filter((item) => item.url || item.excerpt);
}

function dedupeByUrl(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = (item.url || item.title || item.excerpt).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * Search Microsoft Learn for a single query.
 * @returns {Promise<Array<{title:string,url:string,excerpt:string}>>}
 */
export async function searchDocs(session, query, { limit = 6 } = {}) {
  if (!session?.ok) return [];

  const cacheKey = `search:${session.endpoint}:${query}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached.slice(0, limit);

  try {
    const items = await singleFlight(cacheKey, session.signal, async () => {
      const result = await session.call("microsoft_docs_search", { query });
      const found = dedupeByUrl(toTextChunks(result).flatMap(parseSearchChunk))
        .filter((item) => item.excerpt && item.excerpt.length > 40);
      cacheSet(cacheKey, found);
      return found;
    });
    return items.slice(0, limit);
  } catch (err) {
    if (err.name === "AbortError") throw err;
    return [];
  }
}

/**
 * Fetch a full Learn page as markdown, with enough context to tell the
 * difference between "the page was empty" and "the fetch failed".
 *
 * `fetchDoc` cannot express that distinction — it returns "" for both — and the
 * step-derivation path needs it, because a transient fetch failure is worth
 * retrying and an unparseable page is not.
 *
 * Always resolves. Never throws except on caller cancellation.
 *
 * @returns {Promise<{markdown:string, url:string, fetchedAt:string|null, error:string|null}>}
 */
export async function fetchDocPage(session, url, { bypassCache = false } = {}) {
  if (!session?.ok) return { markdown: "", url, fetchedAt: null, error: "Microsoft Learn session is not connected" };
  if (!url) return { markdown: "", url, fetchedAt: null, error: "No documentation URL was supplied" };

  const cacheKey = `page:${session.endpoint}:${url}`;
  if (!bypassCache) {
    const cached = cacheGet(cacheKey);
    if (cached !== undefined) return cached;
  }

  // A failed read is never cached: a transient MCP error must not outlive the
  // retry the blocker flow offers for it. It is not remembered as a flight
  // either, so the next caller after it ends tries again. `bypassCache` skips
  // the cache but still shares a read that is already under way: that read is
  // as fresh as a new one would be.
  return singleFlight(cacheKey, session.signal, async () => {
    let page;
    try {
      const result = await session.call("microsoft_docs_fetch", { url });
      page = { markdown: toTextChunks(result).join("\n\n"), url, fetchedAt: new Date().toISOString(), error: null };
    } catch (err) {
      if (err.name === "AbortError") throw err;
      page = { markdown: "", url, fetchedAt: null, error: err.message || String(err) };
    }
    if (!page.error) cacheSet(cacheKey, page);
    return page;
  });
}

/**
 * Fetch a full Learn page as markdown.
 *
 * @returns {Promise<string>} markdown, or "" on failure
 */
export async function fetchDoc(session, url) {
  const page = await fetchDocPage(session, url);
  return page.markdown;
}

/**
 * Gather grounding material for one catalog feature.
 * Always resolves; falls back to the feature's curated docUrls.
 *
 * Search results are scored before they are cited (see `relevance.js`), because
 * `microsoft_docs_search` spans every Microsoft product and its own ranking has
 * no idea which one this lab is about. Results below the relevance floor are
 * reported in `dropped` rather than discarded silently, so a reviewer can see
 * what the filter refused.
 *
 * The empty case has a deliberate order:
 *   1. cite the search results that clear the floor
 *   2. if none do, cite the curated `docUrls`, which are on-target by construction
 *   3. only if those are empty too is the module ungrounded
 *
 * Step 2 is the point. A noisy search is not a reason to stop and ask a human —
 * raising `modules-ungrounded` every time Learn returned something off-topic
 * would prompt constantly and teach people to click through the prompt, which
 * costs more than it protects. `grounded` therefore means "this module has
 * citations at all"; `learnVerified` is the narrower claim that they came from
 * live search, and that is the one the lab's header is allowed to make.
 *
 * @returns {Promise<{featureId:string, results:Array, sources:Array, grounded:boolean,
 *                    learnVerified:boolean, relevance:object}>}
 */
export async function groundFeature(session, feature, { perQuery = 4, floor = DEFAULT_FLOOR } = {}) {
  // The fallback names the product, because an unscoped "Copilot Studio X" is
  // exactly the query shape that pulls in Fabric and Power Automate pages.
  const queries = feature.learnQueries?.length
    ? feature.learnQueries
    : [`Microsoft Copilot Studio ${feature.name}`];
  const collected = [];

  for (const query of queries) {
    const items = await searchDocs(session, query, { limit: perQuery });
    collected.push(...items);
  }

  const { kept, dropped } = rankResults(dedupeByUrl(collected), feature, { floor });

  const learnSources = kept
    .filter((item) => item.url)
    .map((item) => ({ title: item.title || item.url, url: item.url, excerpt: item.excerpt }));

  // Curated links top up the list rather than replacing it: they are on-target
  // by construction, and they are the same pages `steps.js` reads.
  const fallbackSources = (feature.docUrls || []).map((url) => ({ title: url, url }));
  const sources = dedupeLearnSources([...learnSources, ...fallbackSources], { maxItems: MAX_SOURCES }).map(
    ({ title, url }) => ({ title, url }),
  );

  return {
    featureId: feature.id,
    results: kept.slice(0, 8),
    sources,
    grounded: sources.length > 0,
    learnVerified: learnSources.length > 0,
    relevance: {
      floor,
      considered: kept.length + dropped.length,
      kept: kept.length,
      droppedAsIrrelevant: dropped.map((item) => ({ url: item.url, relevance: item.relevance })),
    },
  };
}

export const LEARN_MCP_ENDPOINT = DEFAULT_ENDPOINT;
