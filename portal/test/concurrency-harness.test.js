/**
 * The small, deterministic version of the concurrency harness: four virtual people use a throwaway portal at the same time
 * (wizard calls, a Learn topic and a product added through a fake Learn, drafts and autosave, two people sending the same
 * build request at once, every kind of export, opening labs while one is replaced and another deleted, and two fake
 * companions claiming capture jobs and uploading pictures to the same shared slot). It fails on any unexpected answer or
 * failed integrity check. The full run (12 people, `npm run test:concurrency`) lives in docs/lab-builder.md.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { formatReport, runHarness } from "./concurrency/harness.mjs";

test("four people using the lab builder at once: no unexpected answers, no lost or mixed-up data, no leftovers", { timeout: 170000 }, async () => {
  const report = await runHarness({ users: 4, rounds: 1, seed: 7, relaxedLimits: true, label: "in-suite" });
  const text = formatReport(report);
  assert.equal(report.fatal, undefined, text);
  assert.equal(report.failures, 0, text);
  assert.deepEqual(report.scenarioErrors, [], text);
  for (const check of report.checks) assert.equal(check.ok, true, `${check.name}: ${check.detail}\n${text}`);
  assert.equal(report.generate.ok, report.generate.attempts, "every build asked for was built (none turned away)");
  assert.ok(report.capture.claims >= 1, "the fake companions claimed their jobs");
  assert.equal(report.capture.claimedOtherPersonsJob, 0, "a companion only got the job of the person who paired it");
  assert.ok(report.health.count > 3 && report.health.failures === 0, "/healthz answered every time while labs were built");
});
