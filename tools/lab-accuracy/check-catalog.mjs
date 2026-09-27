// Monthly check of the lab builder's feature catalog (issue #42).
//
// Reads portal/lib/lab-builder/features.json and, for every feature:
//   1. requests each docUrl and its verifiedAgainst page once, the same way
//      check-accuracy.mjs checks lab links (GET, redirects followed, 15 s timeout);
//   2. flags a lastVerified date older than the threshold (default 180 days,
//      --max-age-days=N or CATALOG_MAX_AGE_DAYS);
//   3. re-applies the catalog's own freshness rules, so a missing or invalid
//      lastVerified/verifiedAgainst is reported even if CI was bypassed.
//
// Writes out/catalog.json. Exit code is 0 unless --strict is passed and the
// catalog needs a maintainer, so the workflow stays informational by default.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { writeReport, repoRoot } from "./lib/labs.mjs";
import {
  CATALOG_PATH,
  buildCatalogReport,
  catalogMaxAgeDays,
  catalogNeedsAction,
} from "./lib/catalog-report.mjs";

const LINK_TIMEOUT_MS = 15000;
const LINK_CONCURRENCY = 6;

export async function checkLink(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LINK_TIMEOUT_MS);
  try {
    // Some Learn endpoints reject HEAD, so use GET but discard the body.
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": "copilot-studio-lab-accuracy/1.0 (+monthly-catalog-check)" },
    });
    await res.body?.cancel().catch(() => {});
    return { url, status: res.status, ok: res.ok, finalUrl: res.url };
  } catch (error) {
    return { url, status: 0, ok: false, error: error.name === "AbortError" ? "timeout" : error.message };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const strict = args.includes("--strict");
  const catalogPath = process.env.LAB_CATALOG_PATH ? path.resolve(process.env.LAB_CATALOG_PATH) : CATALOG_PATH;
  const maxAgeDays = catalogMaxAgeDays(args);

  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  const report = await buildCatalogReport(catalog, {
    checkLink,
    maxAgeDays,
    concurrency: LINK_CONCURRENCY,
    catalogPath: path.relative(repoRoot, catalogPath).split(path.sep).join("/"),
  });

  for (const feature of report.features) {
    const bits = [];
    if (feature.brokenLinks.length) bits.push(`${feature.brokenLinks.length} broken link(s)`);
    if (feature.unreachableLinks.length) bits.push(`${feature.unreachableLinks.length} unreachable`);
    if (feature.stale) bits.push(`stale (verified ${feature.lastVerified}, ${feature.ageDays} days ago)`);
    if (feature.verificationProblems.length) bits.push("invalid verification metadata");
    console.log(`• ${feature.id}: ${bits.join(", ") || `OK (verified ${feature.lastVerified})`}`);
  }

  const target = writeReport("catalog.json", report);
  const { summary } = report;
  console.log(`\nCatalog report written to ${target}`);
  console.log(
    `Summary: ${summary.features} feature(s), ${summary.links} link(s): ${summary.brokenLinks} broken, ` +
      `${summary.unreachableLinks} unreachable, ${summary.redirectedLinks} redirected; ` +
      `${summary.staleFeatures} stale (> ${maxAgeDays} days), ${summary.unverifiedFeatures} with invalid verification metadata`,
  );

  if (strict && catalogNeedsAction(report)) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
