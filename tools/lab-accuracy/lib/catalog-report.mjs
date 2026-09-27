// The lab builder's feature catalog, as seen by the monthly audit (issue #42).
//
// `portal/lib/lab-builder/features.json` holds the curated click-by-click steps
// that generated labs fall back to whenever a step list cannot be read off a
// live documentation page. Those steps age like any other documentation, so the
// monthly job checks the catalog the same way it checks the hand-written labs:
// every documentation link must still resolve, and every feature's
// `lastVerified` date must be recent enough to trust. Vendor pages cited in
// `thirdPartySources` (issue #39) are checked under the same third-party rules
// as lab links, and under the lab builder's own rules for reading them.
//
// Pure functions live here so check-catalog.mjs, report-status.mjs, and
// build-issue.mjs share one definition of "needs a maintainer".

import path from "node:path";
import { pathToFileURL } from "node:url";

import { repoRoot } from "./labs.mjs";
import { classifyThirdParty } from "./reference-links.mjs";

const builderLib = (file) => pathToFileURL(path.join(repoRoot, "portal", "lib", "lab-builder", file)).href;
const { freshnessProblems } = await import(builderLib("catalog.js"));
// vendor-docs.js loads sanitize-html only when it parses a page, which this
// audit never does, so importing it needs none of the portal's dependencies.
const { vendorUrlProblem, MAX_REDIRECTS, DEFAULT_MAX_BYTES } = await import(builderLib("vendor-docs.js"));

export const DEFAULT_CATALOG_MAX_AGE_DAYS = 180;
export const CATALOG_PATH = path.join(repoRoot, "portal", "lib", "lab-builder", "features.json");
export const RE_VERIFY_DOC = "docs/lab-builder.md#extending-the-catalog";

const DAY_MS = 86400000;
const LINK_TIMEOUT_MS = 15000;
const USER_AGENT = "copilot-studio-lab-accuracy/1.0 (+monthly-catalog-check)";
// The content types the lab builder's vendor reader accepts (vendor-docs.js).
const READABLE_TYPES = new Set(["text/html", "text/plain"]);

/**
 * How old a feature's `lastVerified` may be before the audit asks for a
 * re-review: `--max-age-days=N` (or `--max-age-days N`), then the
 * `CATALOG_MAX_AGE_DAYS` environment variable, then 180 days.
 */
export function catalogMaxAgeDays(argv = [], env = process.env) {
  const index = argv.findIndex((arg) => arg === "--max-age-days" || arg.startsWith("--max-age-days="));
  const fromArgs = index === -1 ? undefined : argv[index].includes("=") ? argv[index].split("=", 2)[1] : argv[index + 1];
  for (const candidate of [fromArgs, env.CATALOG_MAX_AGE_DAYS]) {
    const value = Number(candidate);
    if (candidate !== undefined && candidate !== "" && Number.isFinite(value) && value > 0) return value;
  }
  return DEFAULT_CATALOG_MAX_AGE_DAYS;
}

/** Host + locale-free path, so `/en-us/` insertion is not mistaken for a move. */
export function comparablePath(url) {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.replace(/^\/[a-z]{2}-[a-z]{2}(?=\/)/i, "");
    return (parsed.host + pathname).replace(/\/+$/, "").toLowerCase();
  } catch {
    return null;
  }
}

/** The vendor pages a feature cites (issue #39): its thirdPartySources urls. */
export function vendorLinks(feature) {
  if (!Array.isArray(feature?.thirdPartySources)) return [];
  return [...new Set(feature.thirdPartySources.map((source) => source?.url).filter((url) => typeof url === "string" && url))];
}

/**
 * The Microsoft Learn URLs the audit checks for one feature: its docUrls, plus
 * verifiedAgainst when that is not one of its vendor pages.
 */
export function featureLinks(feature) {
  const links = [...(feature?.docUrls || [])];
  const verified = feature?.verifiedAgainst;
  if (typeof verified === "string" && verified && !vendorLinks(feature).includes(verified)) links.push(verified);
  return [...new Set(links)];
}

/**
 * Check one vendor URL under the lab builder's own reading rules.
 *
 * The builder only ever reads a vendor page from a host on the catalog's
 * `vendorHosts`, over HTTPS, following redirects by hand and re-checking every
 * hop, and only when the page is text. A link that breaks one of those rules
 * fails every build that cites it, whatever a browser would show, so this
 * checker applies the same rules and reports a breach as `refused` rather than
 * following it. It never reads the body.
 *
 * Returns `{ url, status, ok, finalUrl?, error?, refused? }`. A refusal has
 * status 0, so the third-party rules would call it unreachable; `refused`
 * keeps it apart, because retrying next month will not fix it.
 */
export function createVendorLinkChecker({ allowedHosts, fetchImpl = fetch, timeoutMs = LINK_TIMEOUT_MS, maxRedirects = MAX_REDIRECTS, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const hosts = new Set([...(allowedHosts || [])].map((host) => String(host).toLowerCase()));
  return async function checkVendorLink(url) {
    const refuse = (error, extra = {}) => ({ url, status: 0, ok: false, refused: true, error, ...extra });
    const first = vendorUrlProblem(url, hosts);
    if (first) return refuse(`not requested: ${first}`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let current = url;
      for (let hop = 0; ; hop += 1) {
        const res = await fetchImpl(current, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: { "user-agent": USER_AGENT, accept: "text/html, text/plain;q=0.9" },
        });
        await res.body?.cancel().catch(() => {});

        if (res.status >= 300 && res.status < 400) {
          const location = res.headers.get("location");
          if (!location) return refuse(`HTTP ${res.status} from ${current} named no redirect target`, { finalUrl: current });
          if (hop >= maxRedirects) return refuse(`more than ${maxRedirects} redirects`, { finalUrl: current });
          let next;
          try {
            next = new URL(location, current).href;
          } catch {
            return refuse(`malformed redirect from ${current}`, { finalUrl: current });
          }
          const problem = vendorUrlProblem(next, hosts);
          if (problem) return refuse(`redirects to ${next}, and ${problem}`, { finalUrl: next });
          current = next;
          continue;
        }

        if (!res.ok) return { url, status: res.status, ok: false, finalUrl: current };

        const type = String(res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
        if (!READABLE_TYPES.has(type)) return refuse(`content type is ${type || "missing"}, not text/html or text/plain`, { finalUrl: current, httpStatus: res.status });
        const declared = Number(res.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > maxBytes) {
          return refuse(`response is larger than the builder's ${maxBytes}-byte limit`, { finalUrl: current, httpStatus: res.status });
        }
        return { url, status: res.status, ok: true, finalUrl: current };
      }
    } catch (error) {
      return { url, status: 0, ok: false, error: controller.signal.aborted ? "timeout" : error.message };
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Whole days since `lastVerified`, or null when the date is unusable.
 * Validity itself is judged by `freshnessProblems`, shared with validateCatalog().
 */
export function verificationAgeDays(lastVerified, now = Date.now()) {
  if (typeof lastVerified !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(lastVerified)) return null;
  const at = Date.parse(`${lastVerified}T00:00:00Z`);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.floor((now - at) / DAY_MS));
}

/**
 * Turn one feature and the link results for its URLs into a report record.
 *
 * Microsoft Learn links: HTTP 4xx/5xx are broken and status 0 (timeout, DNS) is
 * unreachable, the same split check-accuracy.mjs uses. A redirect to a
 * different page is recorded but is not a failure: the link still works, it
 * just is not canonical any more.
 *
 * Vendor links follow the third-party rules in reference-links.mjs: HTTP 401,
 * 403, and 429 are `unverifiable` (a site turning away an automated client),
 * not broken. A link the builder would refuse to read is `refused`. Vendor
 * redirects are not listed: versioned "latest" paths redirect by design, and
 * every hop has already been checked against the allowlist.
 */
export function analyzeFeature(feature, resultsByUrl, { now = Date.now(), maxAgeDays = DEFAULT_CATALOG_MAX_AGE_DAYS } = {}) {
  const lookup = (url) => resultsByUrl.get(url) || { url, status: 0, ok: false, error: "not checked" };
  const learn = featureLinks(feature).map(lookup);
  const vendor = vendorLinks(feature).map((url) => ({ ...lookup(url), party: "third" }));
  const vendorVerdict = (record) => (record.refused ? "refused" : classifyThirdParty(record));
  const ageDays = verificationAgeDays(feature?.lastVerified, now);
  const verificationProblems = freshnessProblems(feature, now);

  return {
    id: feature?.id ?? null,
    name: feature?.name ?? null,
    lastVerified: feature?.lastVerified ?? null,
    verifiedAgainst: feature?.verifiedAgainst ?? null,
    ageDays,
    stale: ageDays !== null && ageDays > maxAgeDays,
    verificationProblems,
    linkCount: learn.length + vendor.length,
    vendorLinkCount: vendor.length,
    brokenLinks: [...learn.filter((r) => r.status >= 400), ...vendor.filter((r) => vendorVerdict(r) === "broken")],
    unreachableLinks: [...learn.filter((r) => r.status === 0), ...vendor.filter((r) => vendorVerdict(r) === "unreachable")],
    refusedLinks: vendor.filter((r) => vendorVerdict(r) === "refused"),
    unverifiableLinks: vendor.filter((r) => vendorVerdict(r) === "unverifiable"),
    redirectedLinks: learn
      .filter((r) => r.ok && r.finalUrl && comparablePath(r.finalUrl) !== comparablePath(r.url))
      .map((r) => ({ url: r.url, finalUrl: r.finalUrl })),
  };
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Check a catalog and build the `out/catalog.json` report.
 *
 * Each distinct URL is requested once however many features cite it.
 * `checkLink(url)` checks Microsoft Learn links and `checkVendorLink(url)`
 * checks vendor links; both resolve to `{ url, status, ok, finalUrl?, error? }`.
 * Without a `checkVendorLink`, vendor links are checked under the lab builder's
 * rules against the catalog's own `vendorHosts`.
 */
export async function buildCatalogReport(
  catalog,
  { checkLink, checkVendorLink, now = Date.now(), maxAgeDays = DEFAULT_CATALOG_MAX_AGE_DAYS, concurrency = 6, catalogPath = null } = {},
) {
  const features = Array.isArray(catalog?.features) ? catalog.features : [];
  const vendorCheck =
    checkVendorLink || createVendorLinkChecker({ allowedHosts: (catalog?.vendorHosts || []).map((entry) => entry?.host) });
  const learnUrls = [...new Set(features.flatMap(featureLinks))];
  const vendorUrls = [...new Set(features.flatMap(vendorLinks))].filter((url) => !learnUrls.includes(url));
  const checked = await mapWithConcurrency(
    [...learnUrls.map((url) => [url, checkLink]), ...vendorUrls.map((url) => [url, vendorCheck])],
    concurrency,
    ([url, check]) => check(url),
  );
  const resultsByUrl = new Map(checked.map((result) => [result.url, result]));

  const records = features.map((feature) => analyzeFeature(feature, resultsByUrl, { now, maxAgeDays }));
  const oldest = records
    .filter((r) => r.ageDays !== null)
    .sort((a, b) => b.ageDays - a.ageDays)[0];
  const total = (key) => records.reduce((sum, r) => sum + r[key].length, 0);

  return {
    generatedAt: new Date(now).toISOString(),
    catalogPath,
    maxAgeDays,
    summary: {
      features: records.length,
      links: learnUrls.length + vendorUrls.length,
      vendorLinks: vendorUrls.length,
      brokenLinks: total("brokenLinks"),
      unreachableLinks: total("unreachableLinks"),
      refusedLinks: total("refusedLinks"),
      unverifiableLinks: total("unverifiableLinks"),
      redirectedLinks: total("redirectedLinks"),
      staleFeatures: records.filter((r) => r.stale).length,
      unverifiedFeatures: records.filter((r) => r.verificationProblems.length > 0).length,
      oldestVerification: oldest ? { id: oldest.id, lastVerified: oldest.lastVerified, ageDays: oldest.ageDays } : null,
    },
    features: records,
  };
}

export function isCatalogReport(report) {
  const counts = ["features", "brokenLinks", "unreachableLinks", "refusedLinks", "staleFeatures", "unverifiedFeatures"];
  return Boolean(
    report
      && Array.isArray(report.features)
      && report.summary
      && counts.every((key) => Number.isFinite(report.summary[key]))
      && Number.isFinite(report.maxAgeDays)
      && report.features.length === report.summary.features
      && report.features.every(
        (feature) => Array.isArray(feature.brokenLinks)
          && Array.isArray(feature.unreachableLinks)
          && Array.isArray(feature.refusedLinks)
          && Array.isArray(feature.verificationProblems)
          && typeof feature.stale === "boolean",
      ),
  );
}

/**
 * True when the catalog needs a maintainer. Fails closed: a missing or
 * malformed report counts, and so does an empty catalog, because an audit that
 * checked nothing has not shown that anything is fine.
 */
export function catalogNeedsAction(report) {
  if (!isCatalogReport(report) || report.summary.features === 0) return true;
  return Boolean(
    report.summary.brokenLinks
      || report.summary.unreachableLinks
      || report.summary.refusedLinks
      || report.summary.staleFeatures
      || report.summary.unverifiedFeatures,
  );
}

function details(lines, summary, items, { open = false } = {}) {
  lines.push("");
  lines.push(`<details${open ? " open" : ""}><summary>${summary}</summary>`);
  lines.push("");
  lines.push(...items);
  lines.push("");
  lines.push("</details>");
}

/** The "🧭 Lab-builder catalog" section of the tracking issue, as Markdown lines. */
export function renderCatalogSection(report) {
  const lines = ["### 🧭 Lab-builder catalog"];
  if (!isCatalogReport(report)) {
    lines.push("- ⚠️ No valid catalog report was produced.");
    return lines;
  }

  const { summary } = report;
  const oldest = summary.oldestVerification;
  lines.push(`- Features checked: **${summary.features}** · documentation links: **${summary.links ?? "?"}** (vendor: **${summary.vendorLinks ?? 0}**)`);
  lines.push(
    `- Broken links: **${summary.brokenLinks}** · temporarily unreachable: **${summary.unreachableLinks}** · refused by the builder's vendor rules: **${summary.refusedLinks}** · ` +
      `unverifiable (HTTP 401/403/429): **${summary.unverifiableLinks ?? 0}** · redirected: **${summary.redirectedLinks ?? 0}**`,
  );
  lines.push(
    `- Stale (\`lastVerified\` older than ${report.maxAgeDays} days): **${summary.staleFeatures}** · missing or invalid verification: **${summary.unverifiedFeatures}**` +
      (oldest ? ` · oldest: \`${oldest.id}\` (${oldest.lastVerified}, ${oldest.ageDays} days)` : ""),
  );
  if (summary.features === 0) lines.push("- ⚠️ The catalog report lists no features.");

  const broken = report.features.filter((f) => f.brokenLinks.length);
  if (broken.length) {
    details(lines, "Broken catalog links", broken.flatMap((f) => f.brokenLinks.map((l) => `- \`${f.id}\` → ${l.url} (HTTP ${l.status})`)), { open: true });
  }

  const refused = report.features.filter((f) => f.refusedLinks.length);
  if (refused.length) {
    details(
      lines,
      "Vendor links the lab builder would refuse to read",
      [
        ...refused.flatMap((f) => f.refusedLinks.map((l) => `- \`${f.id}\` → ${l.url} (${l.error || "refused"})`)),
        "",
        "Every build that cites one of these stops at the `vendor-docs-unavailable` blocker. Replace the link, or add its destination host to `vendorHosts` only if that host is itself a trustworthy source.",
      ],
      { open: true },
    );
  }

  const stale = report.features.filter((f) => f.stale);
  if (stale.length) {
    details(
      lines,
      "Features due for re-verification",
      [
        ...stale.map((f) => `- \`${f.id}\` — last verified ${f.lastVerified} (${f.ageDays} days ago) against ${f.verifiedAgainst}`),
        "",
        `Re-read each page, correct any steps that drifted, then update \`lastVerified\`. The procedure is in \`${RE_VERIFY_DOC}\`.`,
      ],
      { open: true },
    );
  }

  const unverified = report.features.filter((f) => f.verificationProblems.length);
  if (unverified.length) {
    details(lines, "Features with missing or invalid verification metadata", unverified.flatMap((f) => f.verificationProblems.map((p) => `- ${p}`)), { open: true });
  }

  const unreachable = report.features.filter((f) => f.unreachableLinks.length);
  if (unreachable.length) {
    details(lines, "Catalog links that could not be checked", unreachable.flatMap((f) => f.unreachableLinks.map((l) => `- \`${f.id}\` → ${l.url} (${l.error || "network error"})`)));
  }

  const unverifiable = report.features.filter((f) => f.unverifiableLinks?.length);
  if (unverifiable.length) {
    details(
      lines,
      "Vendor links a site refused to check (HTTP 401/403/429, no action required)",
      [
        ...unverifiable.flatMap((f) => f.unverifiableLinks.map((l) => `- \`${f.id}\` → ${l.url} (HTTP ${l.status})`)),
        "",
        "Many vendor sites turn away automated clients while serving the page to a browser. Open these in a browser when the feature is next re-verified.",
      ],
    );
  }

  const redirected = report.features.filter((f) => f.redirectedLinks?.length);
  if (redirected.length) {
    details(
      lines,
      "Catalog links that redirect (no action required)",
      [
        ...redirected.flatMap((f) => f.redirectedLinks.map((l) => `- \`${f.id}\` → ${l.url} now lands on ${l.finalUrl}`)),
        "",
        "The links still work. Point the catalog at the destination the next time the feature is re-verified, because a moved page often means the feature changed.",
      ],
    );
  }

  return lines;
}
