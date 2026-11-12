/**
 * Small in-memory sliding-window rate limiter.
 *
 * Matches the single-instance model used elsewhere in the portal (MSAL token
 * cache, email limiter). Behind several instances each keeps its own window, so
 * the effective ceiling is per instance; use a shared store if that matters.
 */

const MAX_TRACKED_KEYS = 1024;

/**
 * @param {object} opts
 * @param {number} opts.windowMs window length in milliseconds
 * @param {number} opts.max      hits allowed per key inside the window
 * @param {() => number} [opts.now] clock, injectable for tests
 * @returns {(key: string) => {allowed: boolean, retryAfterSec?: number}}
 */
export function createRateLimiter({ windowMs, max, now = Date.now }) {
  const hits = new Map();

  return function check(key) {
    const t = now();
    const cutoff = t - windowMs;
    const recent = (hits.get(key) || []).filter((stamp) => stamp > cutoff);
    if (recent.length >= max) {
      hits.set(key, recent);
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((recent[0] + windowMs - t) / 1000)) };
    }
    recent.push(t);
    hits.set(key, recent);

    if (hits.size > MAX_TRACKED_KEYS) {
      for (const [k, v] of hits) {
        const kept = v.filter((stamp) => stamp > cutoff);
        if (kept.length === 0) hits.delete(k);
        else hits.set(k, kept);
      }
    }
    return { allowed: true };
  };
}

/** Parse a positive integer env value, falling back when absent or invalid. */
export function positiveIntFromEnv(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
