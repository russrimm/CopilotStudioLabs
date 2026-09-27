import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_DRIFT_BASELINE_MAX_AGE_DAYS,
  driftBaselineMaxAgeDays,
  isReferenceReport,
  referenceLinksNeedAction,
  reportsNeedAction,
} from "../lib/report-status.mjs";
import { cleanCatalogReport } from "./catalog-fixture.mjs";

// Pinned so a DRIFT_BASELINE_MAX_AGE_DAYS in the caller's environment cannot change the outcome.
const DEFAULT_LIMIT = { maxBaselineAgeDays: DEFAULT_DRIFT_BASELINE_MAX_AGE_DAYS };

function cleanReports() {
  return {
    accuracy: {
      summary: {
        brokenLinks: 0,
        unreachableLinks: 0,
        mcpDriftWarnings: 0,
        mcpUnavailable: false,
        references: {
          firstParty: { checked: 3, broken: 0, unreachable: 0 },
          thirdParty: { checked: 2, broken: 0, unreachable: 0, unverifiable: 0, skipped: 0 },
        },
      },
      labs: [],
    },
    screenshots: {
      summary: { labsNeedingRecapture: 0 },
      verifyShots: { available: true, critical: 0, warning: 0 },
      labs: [],
    },
    smoke: {
      summary: { unreachable: 0 },
      urls: [],
    },
    catalog: cleanCatalogReport(),
  };
}

test("monthly report status passes only fully clean reports", () => {
  assert.equal(reportsNeedAction(cleanReports()), false);
});

test("monthly report status fails closed for missing or malformed reports", () => {
  assert.equal(reportsNeedAction({}), true);
  assert.equal(reportsNeedAction({ ...cleanReports(), accuracy: { summary: {}, labs: [] } }), true);
  assert.equal(
    reportsNeedAction({
      ...cleanReports(),
      accuracy: {
        ...cleanReports().accuracy,
        labs: [{ brokenLinks: "not-an-array", unreachableLinks: [] }],
      },
    }),
    true,
  );
});

test("monthly report status fails closed for a missing or malformed catalog report", () => {
  const { catalog: _catalog, ...withoutCatalog } = cleanReports();
  assert.equal(reportsNeedAction(withoutCatalog), true);
  assert.equal(reportsNeedAction({ ...cleanReports(), catalog: { summary: {}, features: [] } }), true);
  const empty = cleanReports();
  empty.catalog.summary.features = 0;
  empty.catalog.features = [];
  assert.equal(reportsNeedAction(empty), true, "a catalog check that covered no features proves nothing");
});

test("monthly report status requires action for every degraded signal", () => {
  for (const mutate of [
    (reports) => { reports.accuracy.summary.brokenLinks = 1; },
    (reports) => { reports.accuracy.summary.unreachableLinks = 1; },
    (reports) => { reports.accuracy.summary.mcpDriftWarnings = 1; },
    (reports) => { reports.accuracy.summary.mcpUnavailable = true; },
    (reports) => { reports.screenshots.verifyShots.available = false; },
    (reports) => { reports.screenshots.verifyShots.critical = 1; },
    (reports) => { reports.screenshots.verifyShots.warning = 1; },
    (reports) => { reports.screenshots.summary.labsNeedingRecapture = 1; },
    (reports) => { reports.smoke.summary.unreachable = 1; },
    (reports) => { reports.catalog.summary.brokenLinks = 1; },
    (reports) => { reports.catalog.summary.unreachableLinks = 1; },
    (reports) => { reports.catalog.summary.refusedLinks = 1; },
    (reports) => { reports.catalog.summary.staleFeatures = 1; },
    (reports) => { reports.catalog.summary.unverifiedFeatures = 1; },
  ]) {
    const reports = cleanReports();
    mutate(reports);
    assert.equal(reportsNeedAction(reports), true);
  }
});

function baselinedReports({ unexpected = 0, acknowledged = 0, ageDays = 5 } = {}) {
  const reports = cleanReports();
  Object.assign(reports.accuracy.summary, {
    mcpDriftWarnings: unexpected + acknowledged,
    unexpectedDriftWarnings: unexpected,
    acknowledgedDriftWarnings: acknowledged,
    driftBaseline: { verifiedAt: "2026-09-26", ageDays, entries: acknowledged },
  });
  return reports;
}

test("acknowledged drift alone does not need a maintainer", () => {
  assert.equal(reportsNeedAction(baselinedReports({ acknowledged: 8 }), DEFAULT_LIMIT), false);
});

test("drift outside the baseline still needs a maintainer", () => {
  assert.equal(reportsNeedAction(baselinedReports({ unexpected: 1, acknowledged: 8 }), DEFAULT_LIMIT), true);
});

test("a stale or undated drift baseline needs a re-triage", () => {
  assert.equal(reportsNeedAction(baselinedReports({ acknowledged: 8, ageDays: 91 }), DEFAULT_LIMIT), true);
  assert.equal(reportsNeedAction(baselinedReports({ acknowledged: 8, ageDays: null }), DEFAULT_LIMIT), true);
  assert.equal(
    reportsNeedAction(baselinedReports({ acknowledged: 8, ageDays: 91 }), { maxBaselineAgeDays: 120 }),
    false,
  );
});

test("the baseline age limit can be configured and rejects nonsense", () => {
  assert.equal(driftBaselineMaxAgeDays({}), DEFAULT_DRIFT_BASELINE_MAX_AGE_DAYS);
  assert.equal(driftBaselineMaxAgeDays({ DRIFT_BASELINE_MAX_AGE_DAYS: "30" }), 30);
  assert.equal(driftBaselineMaxAgeDays({ DRIFT_BASELINE_MAX_AGE_DAYS: "-1" }), DEFAULT_DRIFT_BASELINE_MAX_AGE_DAYS);
  assert.equal(driftBaselineMaxAgeDays({ DRIFT_BASELINE_MAX_AGE_DAYS: "soon" }), DEFAULT_DRIFT_BASELINE_MAX_AGE_DAYS);
});

test("drift without a baseline fails closed", () => {
  const reports = baselinedReports({ acknowledged: 8 });
  delete reports.accuracy.summary.driftBaseline;
  assert.equal(reportsNeedAction(reports), true);
});

function thirdPartyLab(links = {}) {
  return {
    name: "01-test",
    brokenLinks: [],
    unreachableLinks: [],
    thirdPartyLinks: { broken: [], unreachable: [], unverifiable: [], skipped: [], ...links },
  };
}

test("broken or unreachable third-party links need action; bot blocks and policy skips do not", () => {
  const counts = (reports) => reports.accuracy.summary.references.thirdParty;

  const clean = cleanReports();
  clean.accuracy.labs = [thirdPartyLab()];
  assert.equal(reportsNeedAction(clean), false);
  assert.equal(referenceLinksNeedAction(clean.accuracy), false);

  for (const key of ["broken", "unreachable"]) {
    const reports = cleanReports();
    counts(reports)[key] = 1;
    assert.equal(reportsNeedAction(reports), true, key);
  }
  for (const key of ["unverifiable", "skipped"]) {
    const reports = cleanReports();
    counts(reports)[key] = 3;
    assert.equal(reportsNeedAction(reports), false, key);
  }
});

test("a report without a valid first-/third-party split fails closed", () => {
  for (const mutate of [
    (reports) => { delete reports.accuracy.summary.references; },
    (reports) => { delete reports.accuracy.summary.references.thirdParty; },
    (reports) => { reports.accuracy.summary.references.thirdParty.broken = "1"; },
    (reports) => { reports.accuracy.summary.references.firstParty.checked = -1; },
    (reports) => { reports.accuracy.labs = [{ brokenLinks: [], unreachableLinks: [] }]; },
    (reports) => { reports.accuracy.labs = [thirdPartyLab({ broken: "not-an-array" })]; },
  ]) {
    const reports = cleanReports();
    mutate(reports);
    assert.equal(isReferenceReport(reports.accuracy), false);
    assert.equal(reportsNeedAction(reports), true);
  }
});
