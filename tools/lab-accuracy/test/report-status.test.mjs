import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_DRIFT_BASELINE_MAX_AGE_DAYS,
  driftBaselineMaxAgeDays,
  reportsNeedAction,
} from "../lib/report-status.mjs";

function cleanReports() {
  return {
    accuracy: {
      summary: {
        brokenLinks: 0,
        unreachableLinks: 0,
        mcpDriftWarnings: 0,
        mcpUnavailable: false,
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
  assert.equal(reportsNeedAction(baselinedReports({ acknowledged: 8 })), false);
});

test("drift outside the baseline still needs a maintainer", () => {
  assert.equal(reportsNeedAction(baselinedReports({ unexpected: 1, acknowledged: 8 })), true);
});

test("a stale or undated drift baseline needs a re-triage", () => {
  assert.equal(reportsNeedAction(baselinedReports({ acknowledged: 8, ageDays: 91 })), true);
  assert.equal(reportsNeedAction(baselinedReports({ acknowledged: 8, ageDays: null })), true);
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
