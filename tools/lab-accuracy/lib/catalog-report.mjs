// The lab builder's feature catalog, as seen by the monthly audit (issue #42).
//
// `portal/lib/lab-builder/features.json` holds the curated click-by-click steps
// that generated labs fall back to whenever a step list cannot be read off a
// live documentation page. Those steps age like any other documentation, so the
// monthly job checks the catalog the same way it checks the hand-written labs:
// every documentation link must still resolve, and every feature's
// `lastVerified` date must be recent enough to trust.
//
// Pure functions live here so check-catalog.mjs, report-status.mjs, and
// build-issue.mjs share one definition of "needs a maintainer".

import path from "node:path";
import { pathToFileURL } from "node:url";

import { repoRoot } from "./labs.mjs";

const { freshnessProblems } = await import(
  pathToFileURL(path.join(repoRoot, "portal", "lib", "lab-builder", "catalog.js")).href
);

export const DEFAULT_CATALOG_MAX_AGE_DAYS = 180;
export const CATALOG_PATH = path.join(repoRoot, "portal", "lib", "lab-builder", "features.json");
export const RE_VERIFY_DOC = "docs/lab-builder.md#extending-the-catalog";

const DAY_MS = 86400000;

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

/** Every URL the audit checks for one feature: its docUrls plus verifiedAgainst. */
export function featureLinks(feature) {
  const links = [...(feature?.docUrls || [])];
  if (typeof feature?.verifiedAgainst === "string" && feature.verifiedAgainst) links.push(feature.verifiedAgainst);
  return [...new Set(links)];
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
 * HTTP 4xx/5xx are broken; status 0 (timeout, DNS) is unreachable, the same
 * split check-accuracy.mjs uses. A redirect to a different page is recorded but
 * is not a failure: the link still works, it just is not canonical any more.
 */
export function analyzeFeature(feature, resultsByUrl, { now = Date.now(), maxAgeDays = DEFAULT_CATALOG_MAX_AGE_DAYS } = {}) {
  const results = featureLinks(feature).map((url) => resultsByUrl.get(url) || { url, status: 0, ok: false, error: "not checked" });
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
    linkCount: results.length,
    brokenLinks: results.filter((r) => r.status >= 400),
    unreachableLinks: results.filter((r) => r.status === 0),
    redirectedLinks: results
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
 * `checkLink(url)` must resolve to `{ url, status, ok, finalUrl?, error? }`.
 */
export async function buildCatalogReport(catalog, { checkLink, now = Date.now(), maxAgeDays = DEFAULT_CATALOG_MAX_AGE_DAYS, concurrency = 6, catalogPath = null } = {}) {
  const features = Array.isArray(catalog?.features) ? catalog.features : [];
  const urls = [...new Set(features.flatMap(featureLinks))];
  const checked = await mapWithConcurrency(urls, concurrency, (url) => checkLink(url));
  const resultsByUrl = new Map(checked.map((result) => [result.url, result]));

  const records = features.map((feature) => analyzeFeature(feature, resultsByUrl, { now, maxAgeDays }));
  const oldest = records
    .filter((r) => r.ageDays !== null)
    .sort((a, b) => b.ageDays - a.ageDays)[0];

  return {
    generatedAt: new Date(now).toISOString(),
    catalogPath,
    maxAgeDays,
    summary: {
      features: records.length,
      links: urls.length,
      brokenLinks: records.reduce((sum, r) => sum + r.brokenLinks.length, 0),
      unreachableLinks: records.reduce((sum, r) => sum + r.unreachableLinks.length, 0),
      redirectedLinks: records.reduce((sum, r) => sum + r.redirectedLinks.length, 0),
      staleFeatures: records.filter((r) => r.stale).length,
      unverifiedFeatures: records.filter((r) => r.verificationProblems.length > 0).length,
      oldestVerification: oldest ? { id: oldest.id, lastVerified: oldest.lastVerified, ageDays: oldest.ageDays } : null,
    },
    features: records,
  };
}

export function isCatalogReport(report) {
  const counts = ["features", "brokenLinks", "unreachableLinks", "staleFeatures", "unverifiedFeatures"];
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
  lines.push(`- Features checked: **${summary.features}** · documentation links: **${summary.links ?? "?"}**`);
  lines.push(
    `- Broken links: **${summary.brokenLinks}** · temporarily unreachable: **${summary.unreachableLinks}** · redirected: **${summary.redirectedLinks ?? 0}**`,
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
