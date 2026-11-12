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
 *   - Redirects are followed by hand, up to `MAX_REDIRECTS`, and the final URL is
 *     recorded. Learn moves pages constantly; a 301 to a live page is a healthy
 *     link, not a broken one. Every hop must still be a public host, so a
 *     redirect cannot steer the server at an internal address.
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

/** Redirect hops the checker follows by hand before giving up. */
export const MAX_REDIRECTS = 5;

function isPrivateIPv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/**
 * Whether a URL's host is one a public search result could legitimately point
 * at. Rejects loopback, private, link-local, and other internal destinations
 * (IP literals and obviously internal names) so a crafted result or redirect
 * cannot make the server probe its own network.
 *
 * This is a syntactic check: a public name that resolves to a private address
 * (DNS rebinding) needs connection-level enforcement, which `fetch` does not
 * expose. Run the builder where egress to internal ranges is blocked as well.
 */
export function isPublicUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) return false;
  if (host.includes(":")) {
    const mapped = /^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(host);
    if (mapped) {
      if (mapped[1]) return !isPrivateIPv4(mapped[1]);
      const hi = parseInt(mapped[2], 16);
      const lo = parseInt(mapped[3], 16);
      return !isPrivateIPv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return !(host === "::" || host === "::1" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host));
  }
  if (isPrivateIPv4(host)) return false;
  if (/^\d+$/.test(host) || /^0x/i.test(host)) return false;
  if (!host.includes(".")) return false;
  return !/(^|\.)(localhost|local|internal|localdomain|home|lan|corp|intranet)$/.test(host);
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

/** Status codes a vendor site uses to turn away automated clients. */
export const BOT_BLOCK_STATUSES = Object.freeze([401, 403, 429]);

/**
 * Bucket one check result for a link on a vendor (non-Learn) site.
 *
 * Adds `unverifiable` to `classify()`'s buckets: many vendor sites answer an
 * automated request with 401, 403, or 429 while serving the same page to a
 * browser. That is the site refusing the checker, not the page being gone, so
 * the citation is kept. 404, 410, and 5xx are still `broken`.
 */
export function classifyThirdParty(record) {
  if (BOT_BLOCK_STATUSES.includes(record?.status)) return "unverifiable";
  return classify(record);
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

    const refused = (error) => ({ url, status: 0, ok: false, error, checkedAt: new Date().toISOString() });
    if (!isPublicUrl(url)) return refused("refused: URL does not point at a public host");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // GET, not HEAD: some Learn endpoints reject HEAD. The body is never read.
      // Redirects are followed by hand so every hop is checked against the same
      // public-host rule as the first request.
      let current = url;
      for (let hop = 0; ; hop += 1) {
        const res = await fetchImpl(current, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: { "user-agent": USER_AGENT },
        });
        const location = res.status >= 300 && res.status < 400 ? res.headers?.get?.("location") : null;
        if (!location) {
          return {
            url,
            status: res.status,
            ok: res.ok,
            finalUrl: res.url || current,
            checkedAt: new Date().toISOString(),
          };
        }
        if (hop >= MAX_REDIRECTS) return refused(`refused: more than ${MAX_REDIRECTS} redirects`);
        let next;
        try {
          next = new URL(location, current).href;
        } catch {
          return refused("refused: malformed redirect");
        }
        if (!isPublicUrl(next)) return refused("refused: redirect to a non-public host");
        current = next;
      }
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
 *
 * URLs in `thirdPartyUrls` are bucketed with `classifyThirdParty()`, so a vendor
 * site that turns the checker away is counted as `unverifiable`, not `broken`.
 */
export function summarize(
  records,
  { enabled = true, timeoutMs = DEFAULT_TIMEOUT_MS, concurrency = DEFAULT_CONCURRENCY, thirdPartyUrls } = {},
) {
  const all = [...(records?.values?.() || records || [])];
  const counts = { ok: 0, broken: 0, unreachable: 0, unverifiable: 0 };
  for (const record of all) {
    counts[thirdPartyUrls?.has?.(record.url) ? classifyThirdParty(record) : classify(record)] += 1;
  }

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
