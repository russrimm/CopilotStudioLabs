import assert from "node:assert/strict";
import { test } from "node:test";

import { reportsNeedAction } from "../lib/report-status.mjs";

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
