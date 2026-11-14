import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyFirstPartyLink,
  createPoliteLinkChecker,
  describeUnreachable,
  parseRetryAfterMs,
} from "../lib/http-check.mjs";
import { analyzeFeature } from "../lib/catalog-report.mjs";

const LEARN_A = "https://learn.microsoft.com/en-us/microsoft-copilot-studio/page-a";
const LEARN_B = "https://learn.microsoft.com/en-us/microsoft-copilot-studio/page-b";
const LEARN_C = "https://learn.microsoft.com/en-us/microsoft-copilot-studio/page-c";

test("parseRetryAfterMs parses delta-seconds, HTTP-dates, and clamps large values", () => {
  const now = Date.parse("2026-11-14T12:00:00Z");
  assert.equal(parseRetryAfterMs("2", { now, maxMs: 10000 }), 2000);
  assert.equal(parseRetryAfterMs("0.25", { now, maxMs: 10000 }), 250);
  assert.equal(parseRetryAfterMs("3600", { now, maxMs: 10000 }), 10000);
  assert.equal(parseRetryAfterMs("Sat, 14 Nov 2026 12:00:04 GMT", { now, maxMs: 10000 }), 4000);
  assert.equal(parseRetryAfterMs("Sat, 14 Nov 2026 11:59:00 GMT", { now, maxMs: 10000 }), 0);
  assert.equal(parseRetryAfterMs("not-a-valid-header", { now, maxMs: 10000 }), null);
  assert.equal(parseRetryAfterMs(null, { now, maxMs: 10000 }), null);
});

test("createPoliteLinkChecker deduplicates concurrent and sequential calls for the same URL", async () => {
  let networkHits = 0;
  const check = createPoliteLinkChecker({
    minHostIntervalMs: { "learn.microsoft.com": 0 },
    sleep: async () => {},
    fetchImpl: async (url) => {
      networkHits += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { status: 200, ok: true, url, headers: new Headers(), body: { cancel: async () => {} } };
    },
  });

  const [first, second] = await Promise.all([check(LEARN_A), check(LEARN_A)]);
  first.party = "first";
  const third = await check(LEARN_A);

  assert.equal(networkHits, 1, "identical URLs must only hit the network once per run");
  assert.equal(second.party, undefined, "callers receive independent shallow copies");
  assert.equal(third.party, undefined);
  assert.deepEqual(check.stats(), { uniqueChecked: 1, totalCalls: 3, retries: 0 });
});

test("createPoliteLinkChecker retries HTTP 429 with Retry-After and recovers without failing", async () => {
  const sleeps = [];
  let nowMs = 1000;
  let attempts = 0;

  const check = createPoliteLinkChecker({
    now: () => nowMs,
    sleep: async (ms) => {
      sleeps.push(ms);
      nowMs += ms;
    },
    random: () => 0,
    minHostIntervalMs: { "learn.microsoft.com": 0 },
    maxRetryAfterMs: 5000,
    fetchImpl: async (url) => {
      attempts += 1;
      if (attempts < 3) {
        return {
          status: 429,
          ok: false,
          url,
          headers: new Headers({ "retry-after": "2" }),
          body: { cancel: async () => {} },
        };
      }
      return { status: 200, ok: true, url, headers: new Headers(), body: { cancel: async () => {} } };
    },
  });

  const result = await check(LEARN_A);
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [2000, 2000]);
  assert.equal(classifyFirstPartyLink(result), "ok");
});

test("persistent HTTP 429 or 503 after retries is classified as unreachable, while 404/410 stay broken", async () => {
  let calls404 = 0;
  const check = createPoliteLinkChecker({
    maxRetries: 2,
    sleep: async () => {},
    random: () => 0.5,
    minHostIntervalMs: { "learn.microsoft.com": 0 },
    fetchImpl: async (url) => {
      if (url === LEARN_A) {
        return { status: 429, ok: false, url, headers: new Headers({ "retry-after": "60" }), body: null };
      }
      if (url === LEARN_B) {
        return { status: 503, ok: false, url, headers: new Headers(), body: null };
      }
      calls404 += 1;
      return { status: 404, ok: false, url, headers: new Headers(), body: null };
    },
  });

  const rateLimited = await check(LEARN_A);
  const unavailable = await check(LEARN_B);
  const missing = await check(LEARN_C);

  assert.equal(rateLimited.status, 429);
  assert.equal(rateLimited.rateLimited, true);
  assert.equal(rateLimited.error, "HTTP 429 (rate limited)");
  assert.equal(classifyFirstPartyLink(rateLimited), "unreachable");
  assert.equal(describeUnreachable(rateLimited), "HTTP 429 (rate limited)");

  assert.equal(unavailable.status, 503);
  assert.equal(classifyFirstPartyLink(unavailable), "unreachable");
  assert.equal(describeUnreachable(unavailable), "HTTP 503 (transient)");

  assert.equal(missing.status, 404);
  assert.equal(calls404, 1, "genuine 404 responses must not be retried");
  assert.equal(classifyFirstPartyLink(missing), "broken");

  const resultsByUrl = new Map([
    [LEARN_A, rateLimited],
    [LEARN_B, unavailable],
    [LEARN_C, missing],
  ]);
  const featureRecord = analyzeFeature(
    {
      id: "demo",
      name: "Demo",
      docUrls: [LEARN_A, LEARN_B, LEARN_C],
      lastVerified: "2026-11-01",
      verifiedAgainst: LEARN_A,
    },
    resultsByUrl,
    { now: Date.parse("2026-11-14T00:00:00Z") },
  );
  assert.deepEqual(featureRecord.brokenLinks.map((r) => r.url), [LEARN_C]);
  assert.deepEqual(featureRecord.unreachableLinks.map((r) => [r.url, r.error]), [
    [LEARN_A, "HTTP 429 (rate limited)"],
    [LEARN_B, "HTTP 503 (transient)"],
  ]);
});

test("per-host concurrency cap limits simultaneous requests to learn.microsoft.com", async () => {
  let inFlight = 0;
  let peakInFlight = 0;

  const check = createPoliteLinkChecker({
    hostConcurrency: { "learn.microsoft.com": 2 },
    minHostIntervalMs: { "learn.microsoft.com": 0 },
    fetchImpl: async (url) => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 15));
      inFlight -= 1;
      return { status: 200, ok: true, url, headers: new Headers(), body: null };
    },
  });

  const urls = Array.from({ length: 6 }, (_, i) => `https://learn.microsoft.com/en-us/doc-${i}`);
  await Promise.all(urls.map((u) => check(u)));
  assert.equal(peakInFlight, 2, `expected max 2 concurrent Learn requests, got ${peakInFlight}`);
});
