/**
 * Liveness checking for the URLs a generated lab is about to embed.
 *
 * The lab builder harvests citations from a live Microsoft Learn search and
 * writes them straight into the lab. `validateLabDir()` never looks at them —
 * it resolves *image* references and explicitly skips anything with an `http:`
 * scheme — so a build could report "18 passed, 0 failed" while embedding a URL
 * that 404s. Issue #41 is that gap.
 *
 * The approach here is deliberately the same one `tools/lab-accuracy/check-accuracy.mjs`
 * already uses for the monthly audit, rather than a third independent flavour:
 *
 *   - GET rather than HEAD, with the body discarded. Some Learn endpoints
 *     reject HEAD outright, so a HEAD-based checker reports phantom breakage.
 *   - Redirects are followed, and the final URL is recorded. Learn moves pages
 *     constantly; a 301 to a live page is a healthy link, not a broken one.
 *   - HTTP >= 400 and status 0 are *not* the same thing and never collapse into
 *     one bucket. 4xx/5xx is the origin telling us the page is gone. Status 0 is
 *     our own timeout, DNS failure, or proxy — evidence about the network, not
 *     about the page. Treating a flaky corporate proxy as a dead citation would
 *     strip good references out of labs.
 *
 * What differs from the monthly audit is the timeout, and for a reason. That job
 * runs unattended once a month and can afford 15s per URL. This one runs while a
 * human waits for a lab, and every URL is paid for in wall-clock time, so the
 * budget is shorter and the concurrency higher. A slow-but-alive page therefore
 * lands in `unreachable`, which by design keeps its citation.
 *
 * URLs are untrusted input: they arrive from a public search. Nothing here
 * executes them. Anything that is not a parseable http(s) URL is rejected before
 * a request is made, so a `javascript:` or `file:` entry can never be fetched.
 */

/** Per-URL budget. Short: a human is waiting for this build. */
export const DEFAULT_TIMEOUT_MS = Number(process.env.LAB_BUILDER_LINK_TIMEOUT_MS || 8000);

/** Requests in flight. These are cheap and mostly latency, so wider than the MCP limit. */
export const DEFAULT_CONCURRENCY = 8;

const USER_AGENT = "copilot-studio-lab-builder/1.0 (+generation-link-check)";

/**
 * Whether link checking runs at all.
 *
 * On by default — an unverified citation is the defect. The opt-out exists so
 * the test suite stays hermetic (`npm test` sets it) and so an air-gapped build
 * can still produce a lab. When it is off the lab says so rather than implying
 * a check that never happened.
 */
export function linkCheckEnabled(env = process.env) {
  return String(env.LAB_BUILDER_LINK_CHECK || "").toLowerCase() !== "off";
}

/** A URL we are willing to put a request to. Guards the fetch, not just the parse. */
export function isCheckableUrl(value) {
  try {
    const parsed = new URL(String(value));
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Bucket one check result.
 *
 *   `ok`          the origin served it (after redirects)
 *   `broken`      the origin says it is gone — 4xx/5xx
 *   `unreachable` we never got an answer — timeout, DNS, proxy, offline
 *
 * `unreachable` is not a weaker `broken`; it is a statement about our network
 * rather than about the page, and the callers act on it differently.
 */
export function classify(record) {
  if (record?.status >= 400) return "broken";
  if (!record?.status) return "unreachable";
  return record.ok ? "ok" : "broken";
}

/**
 * Build a single-URL checker.
 *
 * `fetchImpl` is injectable so tests can exercise 404 and timeout handling
 * without a network, and so a caller can supply an agent with a proxy.
 */
export function createLinkChecker({ timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  return async function checkLink(url) {
    if (!isCheckableUrl(url)) {
      return { url, status: 0, ok: false, error: "unsupported URL scheme", checkedAt: new Date().toISOString() };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // GET, not HEAD: some Learn endpoints reject HEAD. The body is never read.
      const res = await fetchImpl(url, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: { "user-agent": USER_AGENT },
      });
      return {
        url,
        status: res.status,
        ok: res.ok,
        finalUrl: res.url || url,
        checkedAt: new Date().toISOString(),
      };
    } catch (error) {
      return {
        url,
        status: 0,
        ok: false,
        error: error?.name === "AbortError" ? "timeout" : String(error?.message || error),
        checkedAt: new Date().toISOString(),
      };
    } finally {
      clearTimeout(timer);
    }
  };
}

async function mapWithConcurrency(items, limit, fn, signal) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      if (signal?.aborted) throw new DOMException(String(signal.reason || "Operation cancelled"), "AbortError");
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Check a list of URLs, once each.
 *
 * The cache is per call and keyed on the URL, which matters more than it looks:
 * a five-module lab commonly cites the same overview page from three modules,
 * and the catalog's `docUrls` overlap with what search returns. Deduplicating
 * first is most of the reason this stays cheap enough to run on every build.
 *
 * @returns {Promise<Map<string, object>>} url -> check record
 */
export async function verifyUrls(urls, { concurrency = DEFAULT_CONCURRENCY, checkLink, signal, cache } = {}) {
  const check = checkLink || createLinkChecker();
  const results = cache instanceof Map ? cache : new Map();

  const pending = [...new Set((urls || []).filter(Boolean).map(String))].filter((url) => !results.has(url));
  const checked = await mapWithConcurrency(pending, concurrency, (url) => check(url), signal);
  for (const record of checked) results.set(record.url, record);

  return results;
}

/**
 * Summarize a set of check records for the manifest.
 *
 * `verifiedAt` is the moment the build stopped believing its citations on faith.
 * It is null when nothing was checked, because a timestamp on an unchecked lab
 * is worse than no timestamp: it reads as assurance that was never earned.
 */
export function summarize(records, { enabled = true, timeoutMs = DEFAULT_TIMEOUT_MS, concurrency = DEFAULT_CONCURRENCY } = {}) {
  const all = [...(records?.values?.() || records || [])];
  const counts = { ok: 0, broken: 0, unreachable: 0 };
  for (const record of all) counts[classify(record)] += 1;

  return {
    enabled,
    verifiedAt: enabled && all.length ? new Date().toISOString() : null,
    checked: all.length,
    ...counts,
    timeoutMs,
    concurrency,
  };
}

/**
 * Split one module's citations by what the check found.
 *
 * `broken` links are removed from the lab; `unreachable` ones are kept. That
 * asymmetry is the whole point of preserving the distinction: we drop a citation
 * only when the origin told us it is gone, never because our own network had a
 * bad minute.
 *
 * @returns {{kept:Array, dropped:Array, unreachable:Array}}
 */
export function partitionSources(sources = [], records) {
  const kept = [];
  const dropped = [];
  const unreachable = [];

  for (const source of sources) {
    const record = records?.get?.(source?.url);
    if (!record) {
      kept.push({ ...source, linkStatus: null });
      continue;
    }

    const verdict = classify(record);
    const annotated = {
      ...source,
      linkStatus: record.status,
      linkChecked: verdict,
      ...(record.finalUrl && record.finalUrl !== source.url ? { finalUrl: record.finalUrl } : {}),
      ...(record.error ? { linkError: record.error } : {}),
    };

    if (verdict === "broken") dropped.push(annotated);
    else {
      kept.push(annotated);
      if (verdict === "unreachable") unreachable.push(annotated);
    }
  }

  return { kept, dropped, unreachable };
}
