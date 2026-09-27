// Third-party reference links: the link policy, the checker, and the counts.
//
// Microsoft Learn links have always been checked. Everything else a lab cites
// — vendor docs, GitHub samples, npm packages, standards bodies — was invisible
// to the audit until issue #39. This module checks those too, with rules that
// fit sites nobody here controls:
//
//   - HTTP 401, 403, and 429 are `unverifiable`, not broken. Many vendor sites
//     turn away automated clients while serving the same page to a browser.
//   - 404, 410, other 4xx, and 5xx are `broken`; status 0 is `unreachable`.
//   - Hosts in link-policy.json are `skipped`, and every skip carries a reason.
//
// Gating is deliberately different from Learn: a broken third-party link never
// fails a pull request (a vendor outage must not block unrelated work) but it
// does make the monthly issue ask for a maintainer.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FIRST_PARTY_HOSTS } from "./labs.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const LINK_POLICY_PATH = path.join(__dirname, "..", "link-policy.json");

/** Status codes a site uses to turn away an automated client. */
export const BOT_BLOCK_STATUSES = Object.freeze([401, 403, 429]);

const HOST = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

/** Parse and validate link-policy.json. Throws on anything malformed, so a typo cannot widen the skip list. */
export function parseLinkPolicy(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.skip)) {
    throw new Error("Link policy must contain a skip array");
  }
  const seen = new Set();
  const skip = raw.skip.map((entry, index) => {
    const host = typeof entry?.host === "string" ? entry.host : "";
    if (!HOST.test(host)) throw new Error(`Link policy skip[${index}]: "${host}" is not a host name or *.suffix`);
    if (FIRST_PARTY_HOSTS.includes(host) || FIRST_PARTY_HOSTS.some((first) => host.startsWith("*.") && first.endsWith(host.slice(1)))) {
      throw new Error(`Link policy skip[${index}]: ${host} would skip first-party links`);
    }
    if (typeof entry.reason !== "string" || !entry.reason.trim()) {
      throw new Error(`Link policy skip[${index}]: ${host} needs a reason`);
    }
    if (seen.has(host)) throw new Error(`Link policy: duplicate host ${host}`);
    seen.add(host);
    return { host, reason: entry.reason.trim() };
  });
  return { reviewedAt: typeof raw.reviewedAt === "string" ? raw.reviewedAt : null, skip };
}

export function loadLinkPolicy(file = LINK_POLICY_PATH) {
  return parseLinkPolicy(JSON.parse(fs.readFileSync(file, "utf8")));
}

/** The policy entry that skips a host, or null. `*.example` matches `a.example`, not `example`. */
export function policySkip(policy, host) {
  const name = String(host || "").toLowerCase();
  return (
    policy?.skip?.find((entry) => (entry.host.startsWith("*.") ? name.endsWith(entry.host.slice(1)) : name === entry.host)) ||
    null
  );
}

/** Bucket one third-party check result. */
export function classifyThirdParty(record) {
  if (!record?.status) return "unreachable";
  if (BOT_BLOCK_STATUSES.includes(record.status)) return "unverifiable";
  if (record.status >= 400) return "broken";
  return "ok";
}

export function emptyReferenceSummary() {
  return {
    firstParty: { checked: 0, broken: 0, unreachable: 0 },
    thirdParty: { checked: 0, broken: 0, unreachable: 0, unverifiable: 0, skipped: 0 },
  };
}

/**
 * Check one lab's third-party links.
 *
 * @param {Array<{url,host,party}>} links from parseReferenceLinks()
 * @param {{policy:object, check:(urls:string[])=>Promise<object[]>}} options
 *   `check` requests each URL and returns `{url, status, finalUrl?, error?}`
 */
export async function checkThirdPartyLinks(links, { policy, check }) {
  const third = (links || []).filter((link) => link.party === "third");
  const skipped = [];
  const toCheck = [];
  for (const link of third) {
    const entry = policySkip(policy, link.host);
    if (entry) skipped.push({ url: link.url, host: link.host, party: "third", reason: entry.reason });
    else toCheck.push(link);
  }

  const results = toCheck.length ? await check(toCheck.map((link) => link.url)) : [];
  const out = { checked: toCheck.length, broken: [], unreachable: [], unverifiable: [], skipped };
  results.forEach((record, index) => {
    const verdict = classifyThirdParty(record);
    if (verdict === "ok") return;
    out[verdict].push({ ...record, host: toCheck[index].host, party: "third" });
  });
  return out;
}

/** Add one lab's counts to the report summary. */
export function addReferenceCounts(summary, { firstParty, thirdParty }) {
  summary.firstParty.checked += firstParty.checked;
  summary.firstParty.broken += firstParty.broken;
  summary.firstParty.unreachable += firstParty.unreachable;
  summary.thirdParty.checked += thirdParty.checked;
  summary.thirdParty.broken += thirdParty.broken.length;
  summary.thirdParty.unreachable += thirdParty.unreachable.length;
  summary.thirdParty.unverifiable += thirdParty.unverifiable.length;
  summary.thirdParty.skipped += thirdParty.skipped.length;
}

/**
 * Console lines for the end of a run: the split counts, then one warning per
 * broken or unreachable third-party link. Under GitHub Actions each warning is
 * an annotation on the lab file, so a pull request shows it without failing.
 *
 * @param {Array<{lab:{indexPath:string,name:string}, link:object}>} warnings
 */
export function referenceSummaryLines(references, warnings = [], env = process.env) {
  const first = references.firstParty;
  const third = references.thirdParty;
  const lines = [
    `References: Microsoft Learn ${first.checked} checked (${first.broken} broken, ${first.unreachable} unreachable); ` +
      `third-party ${third.checked} checked (${third.broken} broken, ${third.unreachable} unreachable, ` +
      `${third.unverifiable} unverifiable), ${third.skipped} skipped by link-policy.json`,
  ];
  for (const { lab, link } of warnings) {
    const what = link.status ? `returned HTTP ${link.status}` : `could not be reached (${link.error || "network error"})`;
    const message =
      `Third-party link ${link.url} ${what}. This does not fail the pull request; the monthly accuracy audit tracks it until the lab is fixed.`;
    lines.push(env.GITHUB_ACTIONS === "true" ? `::warning file=${lab.indexPath}::${message}` : `⚠ ${lab.name}: ${message}`);
  }
  return lines;
}
