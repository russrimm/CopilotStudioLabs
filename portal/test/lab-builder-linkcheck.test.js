import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classify,
  createLinkChecker,
  parseRetryAfterMs,
  partitionSources,
  verifyUrls,
} from "../lib/lab-builder/linkcheck.js";

test("parseRetryAfterMs parses seconds and HTTP-dates with a ceiling", () => {
  const now = Date.parse("2026-11-14T12:00:00Z");
  assert.equal(parseRetryAfterMs("3", { now, maxMs: 5000 }), 3000);
  assert.equal(parseRetryAfterMs("120", { now, maxMs: 5000 }), 5000);
  assert.equal(parseRetryAfterMs("Sat, 14 Nov 2026 12:00:02 GMT", { now, maxMs: 5000 }), 2000);
  assert.equal(parseRetryAfterMs("", { now, maxMs: 5000 }), null);
});

test("createLinkChecker retries transient 429 responses on Microsoft Learn and cancels unread bodies", async () => {
  let calls = 0;
  let cancelled = 0;
  const delays = [];
  let nowMs = 5000;

  const check = createLinkChecker({
    now: () => nowMs,
    sleep: async (ms) => {
      delays.push(ms);
      nowMs += ms;
    },
    random: () => 0,
    minHostIntervalMs: { "learn.microsoft.com": 0 },
    fetchImpl: async (url) => {
      calls += 1;
      const body = {
        cancel: async () => {
          cancelled += 1;
        },
      };
      if (calls === 1) {
        return {
          status: 429,
          ok: false,
          url,
          headers: new Headers({ "retry-after": "1" }),
          body,
        };
      }
      return { status: 200, ok: true, url, headers: new Headers(), body };
    },
  });

  const record = await check("https://learn.microsoft.com/en-us/microsoft-copilot-studio/topics");
  assert.equal(record.status, 200);
  assert.equal(record.ok, true);
  assert.equal(calls, 2);
  assert.equal(cancelled, 2);
  assert.deepEqual(delays, [1000]);
  assert.equal(classify(record), "ok");
});

test("persistent 429 from Microsoft Learn stays unreachable and never drops valid citations", async () => {
  let missingCalls = 0;
  const learnUrl = "https://learn.microsoft.com/en-us/microsoft-copilot-studio/overview";
  const deadUrl = "https://learn.microsoft.com/en-us/microsoft-copilot-studio/deleted-page";

  const check = createLinkChecker({
    maxRetries: 2,
    sleep: async () => {},
    random: () => 0.5,
    minHostIntervalMs: { "learn.microsoft.com": 0 },
    fetchImpl: async (url) => {
      if (url === learnUrl) {
        return { status: 429, ok: false, url, headers: new Headers({ "retry-after": "30" }), body: null };
      }
      missingCalls += 1;
      return { status: 404, ok: false, url, headers: new Headers(), body: null };
    },
  });

  const records = await verifyUrls([learnUrl, learnUrl, deadUrl], { checkLink: check });
  assert.equal(missingCalls, 1, "404 must not be retried");

  const throttled = records.get(learnUrl);
  assert.equal(throttled.status, 429);
  assert.equal(throttled.rateLimited, true);
  assert.equal(classify(throttled), "unreachable");

  const { kept, dropped, unreachable } = partitionSources(
    [
      { title: "Overview", url: learnUrl },
      { title: "Deleted", url: deadUrl },
    ],
    records,
  );
  assert.deepEqual(kept.map((s) => s.url), [learnUrl]);
  assert.deepEqual(unreachable.map((s) => s.url), [learnUrl]);
  assert.deepEqual(dropped.map((s) => s.url), [deadUrl]);
});

test("createLinkChecker caps concurrent in-flight requests to learn.microsoft.com", async () => {
  let active = 0;
  let maxActive = 0;

  const check = createLinkChecker({
    hostConcurrency: { "learn.microsoft.com": 2 },
    minHostIntervalMs: { "learn.microsoft.com": 0 },
    fetchImpl: async (url) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      return { status: 200, ok: true, url, headers: new Headers(), body: null };
    },
  });

  const urls = Array.from({ length: 6 }, (_, i) => `https://learn.microsoft.com/en-us/microsoft-copilot-studio/p-${i}`);
  const records = await verifyUrls(urls, { concurrency: 8, checkLink: check });
  assert.equal(records.size, 6);
  assert.equal(maxActive, 2, `expected per-host cap of 2 for Learn, saw ${maxActive}`);
});
