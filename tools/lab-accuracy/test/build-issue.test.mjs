import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { cleanCatalogReport } from "./catalog-fixture.mjs";

const toolRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const RANKING_NOTE =
  "No exact cited Learn page appeared in the current top search results. The links still resolve; review search ranking and product relevance before changing documentation.";

const CLEAN_SCREENSHOTS = {
  staleThresholdDays: 180,
  summary: { labsNeedingRecapture: 0, missingImages: 0, staleImages: 0 },
  verifyShots: { available: true, critical: 0, warning: 0 },
  labs: [],
};

const CLEAN_SMOKE = {
  summary: { urls: 0, reachable: 0, unreachable: 0 },
  urls: [],
};

/**
 * Write the reports, run build-issue.mjs, and return its output and issue body.
 * A clean catalog report is written unless `catalog` is given; pass `null` to
 * leave it out.
 */
function buildIssue(t, accuracy, env = {}, { catalog = cleanCatalogReport() } = {}) {
  const outDir = mkdtempSync(join(tmpdir(), "lab-accuracy-report-"));
  t.after(() => rmSync(outDir, { recursive: true, force: true }));

  writeFileSync(join(outDir, "accuracy.json"), JSON.stringify(accuracy));
  writeFileSync(join(outDir, "screenshots.json"), JSON.stringify(CLEAN_SCREENSHOTS));
  writeFileSync(join(outDir, "smoke.json"), JSON.stringify(CLEAN_SMOKE));
  if (catalog !== null) writeFileSync(join(outDir, "catalog.json"), JSON.stringify(catalog));

  const { GITHUB_OUTPUT: _output, DRIFT_BASELINE_MAX_AGE_DAYS: _maxAge, ...parentEnv } = process.env;
  const output = execFileSync(process.execPath, [join(toolRoot, "build-issue.mjs")], {
    encoding: "utf8",
    env: { ...parentEnv, LAB_ACCURACY_OUT_DIR: outDir, ...env },
  });
  return { output, body: readFileSync(join(outDir, "issue.md"), "utf8") };
}

// A clean first-/third-party reference split (issue #39). The report fails
// closed without one, so every fixture that expects no action carries it.
const CLEAN_REFERENCES = {
  firstParty: { checked: 1, broken: 0, unreachable: 0 },
  thirdParty: { checked: 0, broken: 0, unreachable: 0, unverifiable: 0, skipped: 0 },
};
const NO_THIRD_PARTY_LINKS = { broken: [], unreachable: [], unverifiable: [], skipped: [] };

function baselinedAccuracy({ labs, unexpected, acknowledged, resolved = [], ageDays = 1 }) {
  return {
    summary: {
      labs: labs.length,
      brokenLinks: 0,
      unreachableLinks: 0,
      mcpDriftWarnings: unexpected + acknowledged,
      unexpectedDriftWarnings: unexpected,
      acknowledgedDriftWarnings: acknowledged,
      resolvedBaselineEntries: resolved,
      driftBaseline: { verifiedAt: "2026-09-26", ageDays, entries: acknowledged + resolved.length },
      mcpUnavailable: false,
      references: structuredClone(CLEAN_REFERENCES),
    },
    labs,
  };
}

function lab(name, mcp) {
  return { name, brokenLinks: [], unreachableLinks: [], thirdPartyLinks: structuredClone(NO_THIRD_PARTY_LINKS), mcp };
}

test("issue report lists unreachable links exactly once without broken links", (t) => {
  const { output, body } = buildIssue(t, {
    summary: {
      labs: 1,
      brokenLinks: 0,
      unreachableLinks: 1,
      mcpDriftWarnings: 0,
      mcpUnavailable: false,
      references: { ...structuredClone(CLEAN_REFERENCES), firstParty: { checked: 1, broken: 0, unreachable: 1 } },
    },
    labs: [{
      name: "01-test",
      brokenLinks: [],
      unreachableLinks: [{ url: "https://learn.example.test/page", error: "timeout" }],
      thirdPartyLinks: structuredClone(NO_THIRD_PARTY_LINKS),
      mcp: { note: null },
    }],
  });

  assert.match(output, /needs_action=true/);
  assert.match(body, /Reference links that could not be checked/);
  assert.equal(body.match(/https:\/\/learn\.example\.test\/page/g)?.length, 1);
});

test("acknowledged drift is listed with its reason but needs no action", (t) => {
  const { output, body } = buildIssue(t, baselinedAccuracy({
    unexpected: 0,
    acknowledged: 1,
    resolved: ["02-cleared"],
    labs: [
      lab("01-known", { query: "q", note: RANKING_NOTE, drift: "acknowledged", baselineReason: "Broad query ranks connector pages first." }),
      lab("02-cleared", { query: "q", note: null, drift: null }),
    ],
  }));

  assert.match(output, /needs_action=false/);
  assert.match(body, /Acknowledged drift — already triaged \(baseline verified 2026-09-26\)/);
  assert.match(body, /`01-known`: Broad query ranks connector pages first\./);
  assert.match(body, /Baseline entries that no longer drift/);
  assert.match(body, /`02-cleared`/);
  assert.doesNotMatch(body, /New Learn drift/);
  assert.match(body, /All checks passed/);
});

test("drift outside the baseline needs action and is listed apart from acknowledged drift", (t) => {
  const { output, body } = buildIssue(t, baselinedAccuracy({
    unexpected: 1,
    acknowledged: 1,
    labs: [
      lab("01-known", { query: "q", note: RANKING_NOTE, drift: "acknowledged", baselineReason: "Known." }),
      lab("03-new", { query: "q", note: RANKING_NOTE, drift: "unexpected" }),
    ],
  }));

  assert.match(output, /needs_action=true/);
  assert.match(body, /\*\*1\*\* new, \*\*1\*\* acknowledged in the baseline/);
  const newSection = body.slice(body.indexOf("New Learn drift"), body.indexOf("Acknowledged drift"));
  assert.match(newSection, /`03-new`/);
  assert.doesNotMatch(newSection, /`01-known`/);
});

test("a stale baseline asks for a re-triage", (t) => {
  const { output, body } = buildIssue(t, baselinedAccuracy({
    unexpected: 0,
    acknowledged: 1,
    ageDays: 120,
    labs: [lab("01-known", { query: "q", note: RANKING_NOTE, drift: "acknowledged", baselineReason: "Known." })],
  }));

  assert.match(output, /needs_action=true/);
  assert.match(body, /last verified \*\*120 days ago\*\* \(limit 90\)/);
});

// ── Lab-builder catalog (issue #42) ─────────────────────────────────────────

/** An accuracy report with nothing to act on, so only the catalog decides. */
function cleanAccuracy() {
  return baselinedAccuracy({ unexpected: 0, acknowledged: 0, labs: [lab("01-test", { note: null })] });
}

test("a clean catalog report adds its section and needs no action", (t) => {
  const { output, body } = buildIssue(t, cleanAccuracy());
  assert.match(output, /needs_action=false/);
  assert.match(body, /### 🧭 Lab-builder catalog/);
  assert.match(body, /Features checked: \*\*1\*\*/);
  assert.match(body, /oldest: `create-agent` \(2026-09-27, 0 days\)/);
  assert.match(body, /All checks passed/);
});

test("a missing catalog report fails closed", (t) => {
  const { output, body } = buildIssue(t, cleanAccuracy(), {}, { catalog: null });
  assert.match(output, /needs_action=true/);
  assert.match(body, /No valid catalog report was produced/);
});

test("a stale catalog feature needs action and says how to re-verify it", (t) => {
  const catalog = cleanCatalogReport({
    summary: { staleFeatures: 1 },
    feature: { lastVerified: "2026-01-01", ageDays: 269, stale: true },
  });
  const { output, body } = buildIssue(t, cleanAccuracy(), {}, { catalog });
  assert.match(output, /needs_action=true/);
  assert.match(body, /Features due for re-verification/);
  assert.match(body, /`create-agent` — last verified 2026-01-01 \(269 days ago\)/);
  assert.match(body, /Action required/);
});

test("a redirected catalog link is reported but needs no action", (t) => {
  const catalog = cleanCatalogReport({
    summary: { redirectedLinks: 1 },
    feature: { redirectedLinks: [{ url: "https://learn.example.test/old", finalUrl: "https://learn.example.test/new" }] },
  });
  const { output, body } = buildIssue(t, cleanAccuracy(), {}, { catalog });
  assert.match(output, /needs_action=false/);
  assert.match(body, /Catalog links that redirect \(no action required\)/);
  assert.match(body, /https:\/\/learn\.example\.test\/old now lands on https:\/\/learn\.example\.test\/new/);
});
