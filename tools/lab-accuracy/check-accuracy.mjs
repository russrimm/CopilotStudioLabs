// Monthly accuracy check for every lab.
//
// For each lab it:
//   1. Validates that every reference link still resolves: Microsoft Learn
//      links (first-party) and every other cited link (third-party), counted
//      apart. Only a broken Microsoft Learn link is critical for --strict; a
//      broken third-party link is a warning here and an action item in the
//      monthly issue. Hosts in link-policy.json are skipped with their reason.
//   2. Queries the Microsoft Learn MCP server for the lab's primary topic and
//      records whether current authoritative docs still cover it (drift signal).
//
// Writes out/accuracy.json. Exit code is 0 unless --strict is passed and there
// are critical findings (broken links), so the workflow stays informational by
// default and can still gate when desired.
//
// --drift-baseline=<file> tags each drift warning as `acknowledged` (already
// triaged and listed in the baseline) or `unexpected`, lists baseline entries
// that no longer drift, and exits 1 on unexpected drift or when MCP is down.

import { loadAllLabs, writeReport } from "./lib/labs.mjs";
import { LearnMcpClient } from "./lib/mcp-client.mjs";
import {
  addReferenceCounts,
  checkThirdPartyLinks,
  emptyReferenceSummary,
  loadLinkPolicy,
  referenceSummaryLines,
} from "./lib/reference-links.mjs";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const strict = args.includes("--strict");
const skipMcp = args.includes("--no-mcp");
const driftBaselinePath = args.find((arg) => arg.startsWith("--drift-baseline="))?.split("=", 2)[1];
const LINK_TIMEOUT_MS = 15000;
const LINK_CONCURRENCY = 6;
const DRIFT_CONFIRM_ATTEMPTS = 3;
const RANKING_DRIFT_NOTE =
  "No exact cited Learn page appeared in the current top search results. The links still resolve; review search ranking and product relevance before changing documentation.";

async function checkLink(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LINK_TIMEOUT_MS);
  try {
    // Some Learn endpoints reject HEAD, so use GET but discard the body.
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": "copilot-studio-lab-accuracy/1.0 (+monthly-link-check)" },
    });
    // The body is never read; release the connection instead of holding it open.
    await res.body?.cancel().catch(() => {});
    return { url, status: res.status, ok: res.ok, finalUrl: res.url };
  } catch (error) {
    return { url, status: 0, ok: false, error: error.name === "AbortError" ? "timeout" : error.message };
  } finally {
    clearTimeout(timer);
  }
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

function buildSearchQuery(lab) {
  const product = lab.products[0] || "Microsoft Copilot Studio";
  const focus = lab.tags.slice(0, 3).join(", ");
  return focus ? `${product}: ${focus}` : `${product}: ${lab.title}`;
}

/**
 * Search Learn for a lab's topic and report whether any result is a page the
 * lab cites.
 *
 * Learn search is not deterministic: the same query can rank a cited page
 * first on one call and leave it out entirely on the next. A single miss
 * therefore proves nothing, and treating it as drift made the PR gate fail at
 * random. Drift is only reported when the cited pages are missing from every
 * attempt; the first attempt that finds one wins.
 */
export async function searchForCitedDocs(search, query, learnLinks, { attempts = DRIFT_CONFIRM_ATTEMPTS } = {}) {
  const referenced = new Set(learnLinks.map((u) => safePath(u)).filter(Boolean));
  const covers = (results) => results.some((r) => r.url && referenced.has(safePath(r.url)));

  let first = null;
  const maxAttempts = referenced.size > 0 ? Math.max(1, attempts) : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const results = await search(query);
    first ??= results;
    if (covers(results)) return { results, overlap: true, attempts: attempt };
  }
  return { results: first, overlap: false, attempts: maxAttempts };
}

export function unexpectedDriftLabs(report, baseline) {
  const known = new Set(baseline?.knownLabWarnings || []);
  return report.labs
    .filter((lab) => {
      if (!lab.mcp?.note) return false;
      return lab.mcp.note !== RANKING_DRIFT_NOTE || !known.has(lab.name);
    })
    .map((lab) => lab.name);
}

/** Parse and validate a drift baseline. Throws on a malformed file. */
export function parseDriftBaseline(baseline) {
  if (
    !baseline
    || !Array.isArray(baseline.knownLabWarnings)
    || baseline.knownLabWarnings.some((name) => typeof name !== "string")
  ) {
    throw new Error("Drift baseline must contain a knownLabWarnings string array");
  }
  if (
    baseline.reasons !== undefined
    && (
      typeof baseline.reasons !== "object"
      || baseline.reasons === null
      || Array.isArray(baseline.reasons)
      || Object.values(baseline.reasons).some((reason) => typeof reason !== "string")
    )
  ) {
    throw new Error("Drift baseline reasons must map a lab name to a string");
  }
  return {
    verifiedAt: typeof baseline.verifiedAt === "string" ? baseline.verifiedAt : null,
    knownLabWarnings: baseline.knownLabWarnings,
    reasons: baseline.reasons || {},
  };
}

/**
 * Whole days between a baseline's verifiedAt date and `now`; null when the date
 * is missing, invalid, or in the future. A future date is almost always a typo,
 * and treating it as "verified today" would switch the staleness check off
 * until the date had come and gone, so it counts as undated instead. A day of
 * slack allows for time zones.
 */
export function baselineAgeDays(verifiedAt, now) {
  const verified = Date.parse(verifiedAt ?? "");
  const current = Date.parse(now ?? "");
  if (Number.isNaN(verified) || Number.isNaN(current)) return null;
  if (verified - current > 86400000) return null;
  return Math.max(0, Math.floor((current - verified) / 86400000));
}

/**
 * Tag each drifting lab as `acknowledged` (a ranking warning the baseline
 * already covers) or `unexpected` (anything else, including MCP query
 * failures), and list baseline entries that no longer drift so they can be
 * removed. Mutates `report.labs[].mcp.drift` and fills in the summary.
 */
export function applyDriftBaseline(report, baseline) {
  const unexpected = new Set(unexpectedDriftLabs(report, baseline));
  const known = new Set(baseline.knownLabWarnings);
  let acknowledged = 0;

  for (const lab of report.labs) {
    if (!lab.mcp?.note) {
      if (lab.mcp) lab.mcp.drift = null;
      continue;
    }
    lab.mcp.drift = unexpected.has(lab.name) ? "unexpected" : "acknowledged";
    if (lab.mcp.drift === "acknowledged") {
      acknowledged += 1;
      lab.mcp.baselineReason = baseline.reasons[lab.name] || null;
    }
  }

  // Only claim an entry has cleared when this run actually queried Learn for it.
  const resolved = report.labs
    .filter((lab) => known.has(lab.name) && lab.mcp?.query && !lab.mcp.note)
    .map((lab) => lab.name);

  report.summary.acknowledgedDriftWarnings = acknowledged;
  report.summary.unexpectedDriftWarnings = unexpected.size;
  report.summary.resolvedBaselineEntries = resolved;
  report.summary.driftBaseline = {
    verifiedAt: baseline.verifiedAt,
    ageDays: baselineAgeDays(baseline.verifiedAt, report.generatedAt),
    entries: baseline.knownLabWarnings.length,
  };
  return [...unexpected];
}

async function main() {
  const driftBaseline = driftBaselinePath
    ? parseDriftBaseline(JSON.parse(readFileSync(driftBaselinePath, "utf8")))
    : null;

  const labs = loadAllLabs();
  const report = {
    generatedAt: new Date().toISOString(),
    mcpEndpoint: process.env.MS_LEARN_MCP_URL || "https://learn.microsoft.com/api/mcp",
    summary: {
      labs: labs.length,
      brokenLinks: 0,
      unreachableLinks: 0,
      mcpDriftWarnings: 0,
      unexpectedDriftWarnings: 0,
      acknowledgedDriftWarnings: 0,
      resolvedBaselineEntries: [],
      driftBaseline: null,
      mcpUnavailable: false,
    },
    labs: [],
  };

  let mcp = null;
  if (!skipMcp) {
    try {
      mcp = new LearnMcpClient();
      await mcp.initialize();
    } catch (error) {
      console.warn(`MS Learn MCP unavailable: ${error.message}`);
      report.summary.mcpUnavailable = true;
      mcp = null;
    }
  }

  // Third-party links (issue #39): checked with their own rules, counted apart
  // from Microsoft Learn, and never part of the --strict gate.
  const linkPolicy = loadLinkPolicy();
  report.summary.references = emptyReferenceSummary();
  const thirdPartyWarnings = [];

  for (const lab of labs) {
    const linkResults = (await mapWithConcurrency(lab.learnLinks, LINK_CONCURRENCY, checkLink)).map((result) => ({
      ...result,
      party: "first",
    }));
    // HTTP 4xx/5xx are definite breakages; status 0 means a transient network
    // error (timeout, DNS) that we surface as "unreachable" rather than broken.
    const broken = linkResults.filter((r) => r.status >= 400);
    const unreachable = linkResults.filter((r) => r.status === 0);
    report.summary.brokenLinks += broken.length;
    report.summary.unreachableLinks += unreachable.length;

    const thirdParty = await checkThirdPartyLinks(lab.referenceLinks, {
      policy: linkPolicy,
      check: (urls) => mapWithConcurrency(urls, LINK_CONCURRENCY, checkLink),
    });
    addReferenceCounts(report.summary.references, {
      firstParty: { checked: lab.learnLinks.length, broken: broken.length, unreachable: unreachable.length },
      thirdParty,
    });
    for (const link of [...thirdParty.broken, ...thirdParty.unreachable]) {
      thirdPartyWarnings.push({ lab, link });
    }

    const labRecord = {
      name: lab.name,
      title: lab.title,
      indexPath: lab.indexPath,
      learnLinkCount: lab.learnLinks.length,
      brokenLinks: broken,
      unreachableLinks: unreachable,
      thirdPartyLinkCount: thirdParty.checked + thirdParty.skipped.length,
      thirdPartyLinks: {
        broken: thirdParty.broken,
        unreachable: thirdParty.unreachable,
        unverifiable: thirdParty.unverifiable,
        skipped: thirdParty.skipped,
      },
      mcp: { query: null, topResults: [], coversReferencedDocs: null, note: null },
    };

    if (mcp) {
      const query = buildSearchQuery(lab);
      labRecord.mcp.query = query;
      try {
        const lookup = await searchForCitedDocs((q) => mcp.search(q), query, lab.learnLinks);
        labRecord.mcp.topResults = lookup.results.slice(0, 5);
        labRecord.mcp.searchAttempts = lookup.attempts;
        // Drift signal: do any current top docs share a host/path with the
        // lab's referenced Learn links? If the lab cites Learn docs but none
        // appear in fresh search results, flag for a human review.
        if (lab.learnLinks.length > 0) {
          labRecord.mcp.coversReferencedDocs = lookup.overlap;
          if (!lookup.overlap) {
            labRecord.mcp.note = RANKING_DRIFT_NOTE;
            report.summary.mcpDriftWarnings += 1;
          }
        }
      } catch (error) {
        labRecord.mcp.note = `MCP query failed: ${error.message}`;
      }
    }

    report.labs.push(labRecord);
    const status = broken.length ? `${broken.length} broken link(s)` : "links OK";
    console.log(`• ${lab.name}: ${status}${labRecord.mcp.note ? " | drift: yes" : ""}`);
  }

  const unexpectedDrift = driftBaseline
    ? applyDriftBaseline(report, driftBaseline)
    : unexpectedDriftLabs(report, null);
  report.summary.unexpectedDriftWarnings = unexpectedDrift.length;
  const target = writeReport("accuracy.json", report);
  console.log(`\nAccuracy report written to ${target}`);
  console.log(
    `Summary: ${report.summary.brokenLinks} broken link(s), ${report.summary.unreachableLinks} unreachable, ` +
      `${report.summary.mcpDriftWarnings} drift warning(s)` +
      (driftBaseline
        ? `, ${unexpectedDrift.length} new versus baseline, ${report.summary.acknowledgedDriftWarnings} acknowledged`
        : "") +
      (report.summary.mcpUnavailable ? " (MCP unavailable)" : ""),
  );

  for (const line of referenceSummaryLines(report.summary.references, thirdPartyWarnings)) console.log(line);

  if (
    (strict && report.summary.brokenLinks > 0)
    || (driftBaseline && (report.summary.mcpUnavailable || unexpectedDrift.length > 0))
  ) {
    process.exit(1);
  }
}

export function safePath(url) {
  try {
    const u = new URL(url);
    const pathname = u.pathname.replace(/^\/[a-z]{2}-[a-z]{2}(?=\/)/i, "");
    return (u.host + pathname).replace(/\/+$/, "").toLowerCase();
  } catch {
    return null;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
