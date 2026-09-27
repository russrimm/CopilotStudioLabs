import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { applyDriftBaseline, baselineAgeDays, parseDriftBaseline, searchForCitedDocs } from "../check-accuracy.mjs";

const toolRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RANKING_NOTE =
  "No exact cited Learn page appeared in the current top search results. The links still resolve; review search ranking and product relevance before changing documentation.";

function report(labs) {
  return { generatedAt: "2026-10-01T06:00:00.000Z", summary: {}, labs };
}

test("the committed drift baseline is valid, sorted, and gives a reason for every entry", () => {
  const raw = JSON.parse(readFileSync(join(toolRoot, "drift-baseline.json"), "utf8"));
  const baseline = parseDriftBaseline(raw);

  assert.match(baseline.verifiedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.notEqual(
    baselineAgeDays(baseline.verifiedAt, new Date().toISOString()),
    null,
    "drift-baseline.json verifiedAt must be a real date that is not in the future",
  );
  assert.deepEqual(baseline.knownLabWarnings, [...baseline.knownLabWarnings].sort());
  for (const name of baseline.knownLabWarnings) {
    assert.ok(baseline.reasons[name]?.trim(), `${name} needs a triage reason in drift-baseline.json`);
  }
  assert.deepEqual(Object.keys(baseline.reasons).sort(), baseline.knownLabWarnings);
});

test("parseDriftBaseline rejects malformed baselines", () => {
  assert.throws(() => parseDriftBaseline({}), /knownLabWarnings/);
  assert.throws(() => parseDriftBaseline({ knownLabWarnings: [1] }), /knownLabWarnings/);
  assert.throws(() => parseDriftBaseline({ knownLabWarnings: [], reasons: [] }), /reasons/);
  assert.throws(() => parseDriftBaseline({ knownLabWarnings: [], reasons: { a: 1 } }), /reasons/);
  assert.deepEqual(parseDriftBaseline({ knownLabWarnings: ["a"] }), {
    verifiedAt: null,
    knownLabWarnings: ["a"],
    reasons: {},
  });
});

test("baselineAgeDays counts whole days and refuses invalid or future dates", () => {
  assert.equal(baselineAgeDays("2026-09-26", "2026-10-01T06:00:00.000Z"), 5);
  assert.equal(baselineAgeDays("2026-10-01", "2026-10-01T06:00:00.000Z"), 0);
  assert.equal(baselineAgeDays("2026-10-02", "2026-10-01T06:00:00.000Z"), 0, "a day of time-zone slack");
  assert.equal(baselineAgeDays("2027-09-26", "2026-10-01T06:00:00.000Z"), null, "a future date is a typo, not fresh");
  assert.equal(baselineAgeDays(null, "2026-10-01T06:00:00.000Z"), null);
  assert.equal(baselineAgeDays("not a date", "2026-10-01T06:00:00.000Z"), null);
});

function scriptedSearch(responses) {
  const calls = [];
  return {
    calls,
    search: async (query) => {
      calls.push(query);
      return responses[Math.min(calls.length - 1, responses.length - 1)];
    },
  };
}

const CITED = "https://learn.microsoft.com/en-us/microsoft-copilot-studio/flow-asynchronous-response";
const HIT = [{ url: "https://learn.microsoft.com/microsoft-copilot-studio/flow-asynchronous-response" }];
const MISS = [{ url: "https://learn.microsoft.com/microsoft-copilot-studio/whats-new" }];

test("a cited page missing from one search is not drift if a retry finds it", async () => {
  const { calls, search } = scriptedSearch([MISS, HIT]);
  const lookup = await searchForCitedDocs(search, "q", [CITED]);
  assert.equal(lookup.overlap, true);
  assert.equal(lookup.attempts, 2);
  assert.equal(calls.length, 2);
  assert.deepEqual(lookup.results, HIT);
});

test("drift is reported only when every attempt misses the cited pages", async () => {
  const { calls, search } = scriptedSearch([MISS]);
  const lookup = await searchForCitedDocs(search, "q", [CITED], { attempts: 3 });
  assert.equal(lookup.overlap, false);
  assert.equal(lookup.attempts, 3);
  assert.equal(calls.length, 3);
  assert.deepEqual(lookup.results, MISS);
});

test("a first-try hit, or a lab with no Learn links, searches once", async () => {
  const hit = scriptedSearch([HIT]);
  assert.equal((await searchForCitedDocs(hit.search, "q", [CITED])).attempts, 1);
  const none = scriptedSearch([MISS]);
  await searchForCitedDocs(none.search, "q", []);
  assert.equal(none.calls.length, 1);
});

test("applyDriftBaseline separates acknowledged, unexpected, and resolved drift", () => {
  const result = report([
    { name: "01-known", mcp: { query: "q", note: RANKING_NOTE } },
    { name: "02-new", mcp: { query: "q", note: RANKING_NOTE } },
    { name: "03-known-query-failure", mcp: { query: "q", note: "MCP query failed: timed out" } },
    { name: "04-known-cleared", mcp: { query: "q", note: null } },
    { name: "05-known-not-queried", mcp: { query: null, note: null } },
  ]);
  const baseline = parseDriftBaseline({
    verifiedAt: "2026-09-26",
    knownLabWarnings: ["01-known", "03-known-query-failure", "04-known-cleared", "05-known-not-queried"],
    reasons: { "01-known": "Ranking false positive." },
  });

  const unexpected = applyDriftBaseline(result, baseline);

  assert.deepEqual(unexpected, ["02-new", "03-known-query-failure"]);
  assert.equal(result.labs[0].mcp.drift, "acknowledged");
  assert.equal(result.labs[0].mcp.baselineReason, "Ranking false positive.");
  assert.equal(result.labs[1].mcp.drift, "unexpected");
  assert.equal(result.labs[2].mcp.drift, "unexpected");
  assert.equal(result.labs[3].mcp.drift, null);
  assert.deepEqual(result.summary.resolvedBaselineEntries, ["04-known-cleared"]);
  assert.equal(result.summary.acknowledgedDriftWarnings, 1);
  assert.equal(result.summary.unexpectedDriftWarnings, 2);
  assert.deepEqual(result.summary.driftBaseline, { verifiedAt: "2026-09-26", ageDays: 5, entries: 4 });
});
