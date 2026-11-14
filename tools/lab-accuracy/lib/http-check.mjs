// Polite, deduplicated HTTP link checking for lab-accuracy tools.
//
// Microsoft Learn (`learn.microsoft.com`) enforces burst rate limits and
// returns HTTP 429 when many documentation URLs are requested concurrently.
// Treating HTTP 429 or transient 5xx gateway errors as broken links causes
// false-positive CI failures while saying nothing about whether a page exists.
//
// This module provides:
//   1. Run-wide URL deduplication (completed + in-flight), so URLs shared
//      across multiple labs or catalog entries are requested once.
//   2. Polite per-host concurrency and request pacing for Microsoft Learn,
//      plus host-wide Retry-After cooldowns when throttling occurs.
//   3. Bounded retries with Retry-After support and exponential backoff +
//      jitter for transient HTTP statuses (408, 425, 429, 502, 503, 504) and
//      transient network/timeout failures.
//   4. First-party link classification that separates genuine broken pages
//      (404, 410, 500, etc.) from transient/rate-limited responses.

import { FIRST_PARTY_HOSTS } from "./labs.mjs";

/** HTTP statuses that indicate temporary throttling or gateway unavailability rather than a missing page. */
export const TRANSIENT_HTTP_STATUSES = Object.freeze([408, 425, 429, 502, 503, 504]);

export const DEFAULT_LINK_TIMEOUT_MS = 15000;
export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_BASE_DELAY_MS = 400;
export const DEFAULT_MAX_DELAY_MS = 5000;
export const DEFAULT_MAX_RETRY_AFTER_MS = 10000;
export const DEFAULT_LEARN_CONCURRENCY = 2;
export const DEFAULT_LEARN_MIN_INTERVAL_MS = 150;

export function isTransientHttpStatus(status) {
  return TRANSIENT_HTTP_STATUSES.includes(status);
}

/** Human-readable reason for a link that could not be verified. */
export function describeUnreachable(record) {
  if (record?.error) return record.error;
  if (record?.status === 429) return "HTTP 429 (rate limited)";
  if (isTransientHttpStatus(record?.status)) return `HTTP ${record.status} (transient)`;
  return "network error";
}

/**
 * Classify a first-party (Microsoft Learn) link check record.
 *
 *   `ok`          2xx/3xx resolved cleanly
 *   `unreachable` network error/timeout (status 0) or persistent transient
 *                 throttling/gateway status (408, 425, 429, 502, 503, 504)
 *   `broken`      definitive error from origin (e.g. 400, 404, 410, 500)
 */
export function classifyFirstPartyLink(record) {
  if (!record?.status || isTransientHttpStatus(record.status)) return "unreachable";
  if (record.status >= 400) return "broken";
  return record.ok === false ? "broken" : "ok";
}

/**
 * Parse a `Retry-After` header (seconds or HTTP-date) into a bounded delay in ms.
 * Returns `null` when the header is absent or invalid.
 */
export function parseRetryAfterMs(headerValue, { now = Date.now(), maxMs = DEFAULT_MAX_RETRY_AFTER_MS } = {}) {
  if (headerValue === null || headerValue === undefined) return null;
  const raw = String(headerValue).trim();
  if (!raw) return null;

  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const ms = Math.ceil(Number(raw) * 1000);
    return Math.min(Math.max(0, ms), maxMs);
  }

  const parsedDate = Date.parse(raw);
  if (!Number.isNaN(parsedDate)) {
    const delta = parsedDate - now;
    return Math.min(Math.max(0, delta), maxMs);
  }

  return null;
}

export function computeBackoffMs(
  attempt,
  {
    retryAfterMs = null,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    maxRetryAfterMs = DEFAULT_MAX_RETRY_AFTER_MS,
    random = Math.random,
  } = {},
) {
  if (retryAfterMs !== null && Number.isFinite(retryAfterMs)) {
    const clamped = Math.min(Math.max(0, retryAfterMs), maxRetryAfterMs);
    const jitter = Math.round(Math.min(250, clamped * 0.1) * random());
    return Math.min(maxRetryAfterMs, clamped + jitter);
  }
  const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt));
  const factor = 0.5 + 0.5 * random();
  return Math.max(1, Math.round(exp * factor));
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractHostname(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Per-host concurrency, spacing, and Retry-After cooldown gate.
 */
export function createHostGate({
  hostConcurrency = {},
  defaultHostConcurrency = Infinity,
  minHostIntervalMs = {},
  defaultMinIntervalMs = 0,
  now = Date.now,
  sleep = defaultSleep,
} = {}) {
  const states = new Map();

  function getState(host) {
    let state = states.get(host);
    if (!state) {
      const limit = hostConcurrency[host] ?? defaultHostConcurrency;
      const minInterval = minHostIntervalMs[host] ?? defaultMinIntervalMs;
      state = {
        active: 0,
        limit: Number.isFinite(limit) && limit > 0 ? limit : Infinity,
        minInterval: Number.isFinite(minInterval) && minInterval > 0 ? minInterval : 0,
        nextAllowedAt: 0,
        cooldownUntil: 0,
        queue: [],
      };
      states.set(host, state);
    }
    return state;
  }

  async function acquireSlot(state) {
    if (state.active >= state.limit) {
      await new Promise((resolve) => state.queue.push(resolve));
    }
    state.active += 1;
  }

  function releaseSlot(state) {
    state.active = Math.max(0, state.active - 1);
    const next = state.queue.shift();
    if (next) next();
  }

  async function waitTurn(state) {
    const current = now();
    const scheduled = Math.max(current, state.nextAllowedAt, state.cooldownUntil);
    if (state.minInterval > 0) {
      state.nextAllowedAt = scheduled + state.minInterval;
    }
    if (scheduled > current) {
      await sleep(scheduled - current);
    }
  }

  return {
    async run(host, fn) {
      if (!host) return fn();
      const state = getState(host);
      await acquireSlot(state);
      try {
        await waitTurn(state);
        return await fn();
      } finally {
        releaseSlot(state);
      }
    },
    noteCooldown(host, delayMs) {
      if (!host || !Number.isFinite(delayMs) || delayMs <= 0) return;
      const state = getState(host);
      state.cooldownUntil = Math.max(state.cooldownUntil, now() + delayMs);
    },
  };
}

/**
 * Create a polite, deduplicated HTTP link checker.
 *
 * Calling the returned `checkLink(url)` multiple times with the same URL
 * reuses the in-flight or cached check result and returns a shallow copy.
 * Inspect `checkLink.stats()` for `{ uniqueChecked, totalCalls, retries }`.
 */
export function createPoliteLinkChecker({
  timeoutMs = DEFAULT_LINK_TIMEOUT_MS,
  userAgent = "copilot-studio-lab-accuracy/1.0 (+monthly-link-check)",
  fetchImpl = fetch,
  sleep = defaultSleep,
  random = Math.random,
  now = Date.now,
  maxRetries = DEFAULT_MAX_RETRIES,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
  maxRetryAfterMs = DEFAULT_MAX_RETRY_AFTER_MS,
  dedupe = true,
  hostConcurrency,
  minHostIntervalMs,
} = {}) {
  const defaultLearnLimits = Object.fromEntries(FIRST_PARTY_HOSTS.map((h) => [h, DEFAULT_LEARN_CONCURRENCY]));
  const defaultLearnIntervals = Object.fromEntries(FIRST_PARTY_HOSTS.map((h) => [h, DEFAULT_LEARN_MIN_INTERVAL_MS]));

  const gate = createHostGate({
    hostConcurrency: { ...defaultLearnLimits, ...(hostConcurrency || {}) },
    minHostIntervalMs: { ...defaultLearnIntervals, ...(minHostIntervalMs || {}) },
    now,
    sleep,
  });

  const cache = new Map();
  const inFlight = new Map();
  let totalCalls = 0;
  let retries = 0;

  async function fetchOnce(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // Some Learn endpoints reject HEAD, so use GET and discard the body.
      const res = await fetchImpl(url, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: { "user-agent": userAgent },
      });
      await res.body?.cancel?.().catch(() => {});
      const retryAfterMs = isTransientHttpStatus(res.status)
        ? parseRetryAfterMs(res.headers?.get?.("retry-after"), { now: now(), maxMs: maxRetryAfterMs })
        : null;
      return {
        url,
        status: res.status,
        ok: res.ok,
        finalUrl: res.url || url,
        retryAfterMs,
      };
    } catch (error) {
      return {
        url,
        status: 0,
        ok: false,
        error: error?.name === "AbortError" ? "timeout" : String(error?.message || error),
        retryAfterMs: null,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async function checkWithRetries(url) {
    const host = extractHostname(url);
    let last = null;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (attempt > 0) retries += 1;
      last = await gate.run(host, () => fetchOnce(url));

      const shouldRetry = !last.ok && (last.status === 0 || isTransientHttpStatus(last.status));
      if (!shouldRetry || attempt >= maxRetries) break;

      const waitMs = computeBackoffMs(attempt, {
        retryAfterMs: last.retryAfterMs,
        baseDelayMs,
        maxDelayMs,
        maxRetryAfterMs,
        random,
      });
      if (last.status === 429 || last.retryAfterMs !== null) {
        gate.noteCooldown(host, waitMs);
      }
      await sleep(waitMs);
    }

    const { retryAfterMs: _unused, ...record } = last;
    if (!record.ok && isTransientHttpStatus(record.status)) {
      return {
        ...record,
        transient: true,
        ...(record.status === 429 ? { rateLimited: true } : {}),
        error: describeUnreachable(record),
      };
    }
    return record;
  }

  async function checkLink(url) {
    totalCalls += 1;
    const key = String(url);
    if (!dedupe) {
      return checkWithRetries(key);
    }
    if (cache.has(key)) {
      return { ...cache.get(key) };
    }
    let pending = inFlight.get(key);
    if (!pending) {
      pending = checkWithRetries(key)
        .then((record) => {
          cache.set(key, record);
          inFlight.delete(key);
          return record;
        })
        .catch((err) => {
          inFlight.delete(key);
          throw err;
        });
      inFlight.set(key, pending);
    }
    const resolved = await pending;
    return { ...resolved };
  }

  checkLink.stats = () => ({
    uniqueChecked: cache.size,
    totalCalls,
    retries,
  });

  checkLink.cache = cache;

  return checkLink;
}
