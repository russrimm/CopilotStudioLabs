/**
 * AI writing: how the engine behaves on a real service's bad days and good ones, with a fake backend. Batching by size, the
 * time limit of a call, splitting a call that timed out, backing off on 429 and 503, how many calls run at once, what is not sent
 * at all, what a rebuild does, and what a cancel leaves behind. Nothing here uses the SDK, the network, or any account.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { readAiConfig, AI_PROMPT_VERSION, AI_WRITING_VERSION, MIN_CALL_TIMEOUT_MS } from "../lib/ai/config.js";
import { blockCacheKey, createAiCache } from "../lib/ai/cache.js";
import { createEngine } from "../lib/ai/engine.js";
import { createCallGate, createUsageLimiter } from "../lib/ai/limits.js";
import { GUARD_VERSION } from "../lib/ai/guard.js";
import { newRecord, sealRecord } from "../lib/ai/record.js";
import { knownNames } from "../lib/ai/names.js";
import { createFakeBackend, passagesOf } from "./fixtures/fake-ai.js";

const NAMES = knownNames();
const config = (over = {}) => ({ ...readAiConfig({ AI_GENERATION: "local-user" }), ...over });
const sentence = (n) => `Associates answer question number ${n} about returns, pricing and promotions for the store every day of the week.`;

/** A unit of `blocks` list blocks, each with `items` sentences (about 110 characters each). */
function deck(id, blocks, items = 3, context = { industry: "Retail", agentName: "Store Assistant" }) {
  return {
    id,
    context,
    blocks: Array.from({ length: blocks }, (_, b) => ({
      id: `${id}.s${b}.notes`,
      kind: "note",
      type: "list",
      itemKind: "note",
      deck: true,
      names: NAMES,
      sources: Array.from({ length: items }, (_, i) => sentence(b * 10 + i)),
    })),
  };
}

function make(backend, over = {}, extra = {}) {
  const cfg = config(over);
  const sleeps = [];
  const lines = [];
  const cache = extra.cache || createAiCache();
  const engine = createEngine({
    backend,
    config: cfg,
    cache,
    limiter: createUsageLimiter({ config: cfg }),
    gate: extra.gate || null,
    logger: (line) => lines.push(line),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { engine, cache, sleeps, lines, cfg };
}

const go = (engine, units, input = {}) => engine.run({ units, model: "fake-fast", provider: "GitHub Copilot", visitor: "v1", ...input });
const completes = (backend) => backend.calls.filter((c) => c.type === "complete");

test("requests are sized by characters and blocks, so a large unit is many modest calls and not one huge one", async () => {
  const backend = createFakeBackend();
  const { engine } = make(backend, { maxCharsPerRequest: 3500, maxBlocksPerRequest: 16, maxParallel: 1 });
  const { summary } = await go(engine, [deck("big", 40, 3)]);
  const calls = completes(backend);
  assert.equal(summary.ai, 40, "every block is reworded");
  assert.ok(calls.length >= 4, `10 thousand characters need several calls, not one (${calls.length})`);
  assert.equal(summary.plannedRequests, calls.length);
  for (const call of calls) {
    assert.ok(call.chars <= 3500, `a call carries at most the configured characters (${call.chars})`);
    assert.ok(call.passages <= 16 * 3, "and at most the configured blocks");
  }
  // The count of blocks per call is its own limit.
  const small = make(createFakeBackend(), { maxCharsPerRequest: 20000, maxBlocksPerRequest: 5, maxParallel: 1 });
  const bySmall = await go(small.engine, [deck("many", 12, 1)]);
  assert.equal(bySmall.summary.plannedRequests, 3);
});

test("a call is given time in proportion to what it must write, never less than the floor and never more than AI_TIMEOUT_MS", async () => {
  const backend = createFakeBackend();
  const { engine } = make(backend, { timeoutMs: 120000, maxParallel: 1 });
  await go(engine, [deck("tiny", 1, 1)]);
  await go(engine, [deck("larger", 12, 3, { industry: "Another" })]);
  const [tiny, larger] = completes(backend).map((c) => c.timeoutMs);
  assert.equal(tiny, MIN_CALL_TIMEOUT_MS);
  assert.ok(larger > tiny && larger <= 120000, `${larger} is more than ${tiny}`);
  assert.ok(MIN_CALL_TIMEOUT_MS >= 60000, "the SDK's own default is 60 seconds and was what applied before");
});

test("a call that times out is split in half and each half is asked again, so the batch is not lost", async () => {
  // A service that cannot finish more than 12 passages in time: a 24-passage call fails, two of 12 succeed.
  const backend = createFakeBackend({ timeoutAbove: 12 });
  const { engine } = make(backend, { maxParallel: 1 });
  const { summary, results } = await go(engine, [deck("d", 8, 3)]);
  assert.equal(summary.ai, 8, "every block ends up reworded");
  assert.equal(summary.kept, 0);
  assert.equal(summary.timeouts, 1);
  assert.equal(summary.splits, 1);
  assert.equal(summary.requests, 3, "one call that timed out, then two halves");
  assert.deepEqual(completes(backend).map((c) => c.passages), [24, 12, 12]);
  assert.equal(results.get("d.s0.notes").status, "ai");
});

test("when even a single block cannot finish, it keeps the standard text and the reason is counted; calls stay within the retry budget", async () => {
  const backend = createFakeBackend({ timeoutAbove: 0 });
  const { engine } = make(backend, { maxParallel: 1, retries: 1 });
  const { summary } = await go(engine, [deck("d", 4, 3)]);
  assert.equal(summary.ai, 0);
  assert.equal(summary.kept, 4);
  assert.equal(summary.keptWhy.timeout, 4);
  assert.ok(summary.notes.some((n) => /took too long/.test(n)));
  const planned = summary.plannedRequests;
  assert.ok(summary.requests <= planned + Math.ceil(planned * 0.75) + 3, `a bad day cannot multiply the prompts (${summary.requests} for ${planned} planned)`);
});

test("a rate limit is waited out with a growing pause (or the service's own), then the call is made again", async () => {
  const backend = createFakeBackend({ rateLimited: 2 });
  const { engine, sleeps } = make(backend, { maxParallel: 1, retries: 2, backoffMs: 2000 });
  const { summary } = await go(engine, [deck("d", 2, 2)]);
  assert.equal(summary.ai, 2, "the third try worked");
  assert.equal(summary.backoffs, 2);
  assert.equal(sleeps.length, 2);
  assert.ok(sleeps[0] >= 2000 && sleeps[0] <= 2500, `first pause about 2 seconds (${sleeps[0]})`);
  assert.ok(sleeps[1] >= 4000 && sleeps[1] <= 5000, `second pause about 4 seconds (${sleeps[1]})`);

  const told = createFakeBackend({ rateLimited: 1, retryAfter: 7 });
  const second = make(told, { maxParallel: 1, retries: 2 });
  await go(second.engine, [deck("d", 2, 2)]);
  assert.ok(second.sleeps[0] >= 7000 && second.sleeps[0] <= 8750, `the service said 7 seconds (${second.sleeps[0]})`);

  const busy = createFakeBackend({ failFirst: 1, failWith: "503 service unavailable" });
  const third = make(busy, { maxParallel: 1, retries: 2 });
  const out = await go(third.engine, [deck("d", 2, 2)]);
  assert.equal(out.summary.ai, 2, "a 503 is retried the same way");
});

test("a service that keeps saying slow down is given up on after the configured retries, and the reason is plain", async () => {
  const backend = createFakeBackend({ rateLimited: 99 });
  const { engine } = make(backend, { maxParallel: 1, retries: 2 });
  const { summary } = await go(engine, [deck("d", 2, 2)]);
  assert.equal(completes(backend).length, 3, "the first try and two retries, no more");
  assert.equal(summary.kept, 2);
  assert.equal(summary.keptWhy.busy, 2);
  assert.ok(summary.notes.some((n) => /slow down/.test(n)));
});

test("a rate limit lowers how many calls run at once, so the service can recover", async () => {
  const backend = createFakeBackend({ rateLimited: 4, delayMs: 5 });
  // Eight calls, four at a time: the first four are refused, and the retries run fewer at once.
  const big = Array.from({ length: 8 }, (_, i) => ({ id: `u${i}`, context: { n: i }, blocks: [{ id: `u${i}.b`, kind: "note", type: "text", source: "x".repeat(10) + " " + sentence(i).repeat(12), names: NAMES, deck: true }] }));
  const { engine } = make(backend, { maxParallel: 4, retries: 2, maxCharsPerRequest: 500, maxOutputChars: 100000 });
  const { summary } = await go(engine, big);
  assert.equal(summary.backoffs, 4);
  assert.ok(backend.maxInflight <= 4);
  assert.equal(summary.total, 8);
});

test("no more than maxParallel calls run at once in a lab, and the server-wide gate caps all labs together", async () => {
  const blocks = (id) => ({ id, context: { id }, blocks: Array.from({ length: 6 }, (_, i) => ({ id: `${id}.b${i}`, kind: "note", type: "text", source: sentence(i).repeat(4), names: NAMES, deck: true })) });
  const each = Array.from({ length: 4 }, (_, i) => blocks(`u${i}`));
  const one = createFakeBackend({ delayMs: 15 });
  const { engine } = make(one, { maxParallel: 3, maxCharsPerRequest: 1000, maxBlocksPerRequest: 2, maxOutputChars: 100000 });
  await go(engine, each);
  assert.ok(one.maxInflight > 1 && one.maxInflight <= 3, `parallel but bounded (${one.maxInflight})`);

  const shared = createFakeBackend({ delayMs: 15 });
  const gate = createCallGate({ max: 2 });
  const a = make(shared, { maxParallel: 4, maxCharsPerRequest: 1000, maxBlocksPerRequest: 2, maxOutputChars: 100000 }, { gate });
  const b = make(shared, { maxParallel: 4, maxCharsPerRequest: 1000, maxBlocksPerRequest: 2, maxOutputChars: 100000 }, { gate });
  await Promise.all([go(a.engine, each), go(b.engine, each.map((u) => ({ ...u, id: `${u.id}b`, context: { other: u.id } })))]);
  assert.equal(shared.maxInflight, 2, "two labs together never exceed the server-wide limit");
  assert.equal(gate.snapshot().active, 0, "every slot is given back");
});

test("passages with nothing to reword are never sent, and are not counted as kept", async () => {
  const backend = createFakeBackend();
  const { engine } = make(backend);
  const unit = {
    id: "u",
    context: {},
    blocks: [
      { id: "u.labels", kind: "slide", type: "list", itemKind: "slide", deck: true, names: NAMES, sources: ["**Settings**", "100", "Add knowledge"] },
      { id: "u.mixed", kind: "slide", type: "list", itemKind: "slide", deck: true, names: NAMES, sources: ["**Overview**", "Agents help associates answer questions and share the answers."] },
      { id: "u.text", kind: "why", type: "text", source: "Agents help associates answer product questions quickly and consistently.", names: NAMES },
    ],
  };
  const { results, summary } = await go(engine, [unit]);
  assert.equal(results.get("u.labels").status, "skipped");
  assert.equal(summary.skipped, 1);
  assert.equal(summary.total, 2, "the skipped block is not a candidate");
  assert.equal(summary.ai, 2);
  const sent = completes(backend).flatMap((c) => passagesOf(c.prompt).map((p) => p.source));
  assert.equal(sent.length, 2);
  assert.ok(!sent.includes("**Overview**") && !sent.includes("**Settings**"));
  assert.equal(results.get("u.mixed").items[0], "**Overview**", "the label in a mixed list stays exactly as written");
  assert.notEqual(results.get("u.mixed").items[1], "Agents help associates answer questions and share the answers.");
});

test("each passage is its own entry with a short id, and a list the model writes as one paragraph is not mistaken for a rewrite", async () => {
  const backend = createFakeBackend();
  const { engine } = make(backend);
  await go(engine, [deck("d", 2, 3)]);
  const [call] = completes(backend);
  const passages = passagesOf(call.prompt);
  assert.deepEqual(passages.map((p) => p.id), ["p1", "p2", "p3", "p4", "p5", "p6"]);
  assert.deepEqual(passages.map((p) => p.position), ["1 of 3", "2 of 3", "3 of 3", "1 of 3", "2 of 3", "3 of 3"]);
  assert.deepEqual([...new Set(passages.map((p) => p.group))], ["g1", "g2"]);
  assert.equal(call.prompt.includes("d.s0.notes"), false, "the model is never asked to write a long id");
  assert.equal(call.prompt.includes('"blocks"'), false);
  assert.match(call.system, /Never merge two passages/);

  // The version 1 failure: the whole list written as one paragraph under the first passage. Now it is not accepted as a list.
  const merged = make(createFakeBackend({ behavior: "merged" }));
  const { summary } = await go(merged.engine, [deck("d", 2, 3)]);
  assert.equal(summary.ai, 0);
  assert.equal(summary.kept, 2);
  assert.ok(summary.rejected.missing >= 1);
});

test("guard rejections are counted by plain kind", async () => {
  const cases = [
    ["invent-number", "added"],
    ["inject", "injection"],
    ["chatter", "chatter"],
    ["markdown", "markup"],
    ["too-long", "length"],
  ];
  for (const [behavior, kind] of cases) {
    const { engine } = make(createFakeBackend({ behavior }));
    const { summary } = await go(engine, [deck("d", 3, 2)]);
    assert.equal(summary.rejectedKinds[kind], 3, `${behavior} counts as ${kind}`);
    assert.equal(summary.keptWhy.guard, 3);
  }
  const bad = make(createFakeBackend({ behavior: "invalid-json" }), { maxParallel: 1 });
  const out = await go(bad.engine, [deck("d", 3, 2)]);
  assert.equal(out.summary.rejectedKinds.schema, 3);
  assert.equal(out.summary.keptWhy.answer, 3);
});

test("a refusal is remembered for a while, so a rebuild straight after makes no call; later it is tried again", async () => {
  let clock = 1_000_000;
  const cache = createAiCache({ rejectTtlMs: 60_000, now: () => clock });
  const first = createFakeBackend({ behavior: "invent-number" });
  const a = make(first, {}, { cache });
  const one = await go(a.engine, [deck("d", 2, 2)]);
  assert.equal(one.summary.kept, 2);
  const callsBefore = completes(first).length;

  const again = make(first, {}, { cache });
  const two = await go(again.engine, [deck("d", 2, 2)]);
  assert.equal(completes(first).length, callsBefore, "no new call: the refusal is remembered");
  assert.equal(two.summary.kept, 2);
  assert.equal(two.summary.remembered, 2);
  assert.deepEqual(Object.keys(two.summary.rejected), Object.keys(one.summary.rejected), "and the same reason is reported");

  clock += 61_000;
  const later = createFakeBackend();
  const c = make(later, {}, { cache });
  const three = await go(c.engine, [deck("d", 2, 2)]);
  assert.equal(completes(later).length, 1, "an hour later the model gets another try");
  assert.equal(three.summary.ai, 2);

  const never = createAiCache({ rejectTtlMs: 0 });
  never.setReject("k".repeat(64), "invented:numbers");
  assert.equal(never.getReject("k".repeat(64)), null, "AI_REJECT_CACHE_MS=0 turns it off");
});

test("a rebuild of the same text with the same model makes no call at all", async () => {
  const cache = createAiCache();
  const first = createFakeBackend();
  const a = make(first, {}, { cache });
  const built = await go(a.engine, [deck("d", 6, 3), deck("e", 4, 2)]);
  assert.equal(built.summary.ai, 10);
  const second = createFakeBackend();
  const b = make(second, {}, { cache });
  const rebuilt = await go(b.engine, [deck("d", 6, 3), deck("e", 4, 2)]);
  assert.equal(completes(second).length, 0, "zero model calls on the rebuild");
  assert.equal(rebuilt.summary.cached, 10);
  assert.equal(rebuilt.summary.requests, 0);
});

test("cancel stops the run quickly, asks for nothing more, and leaves no call running", async () => {
  const backend = createFakeBackend({ hang: true });
  const { engine } = make(backend, { maxParallel: 2, maxCharsPerRequest: 1000, maxBlocksPerRequest: 2 });
  const controller = new AbortController();
  const started = Date.now();
  const pending = go(engine, [deck("a", 10, 3)], { signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  const { summary, results } = await pending;
  assert.ok(Date.now() - started < 2000, "the run ends within moments of the cancel");
  assert.equal(summary.stopped, true);
  assert.equal(summary.stopKind, "aborted");
  assert.equal(summary.ai, 0);
  assert.equal(summary.kept, summary.total);
  assert.equal(backend.inflight, 0, "no call is left running");
  assert.ok(completes(backend).length <= 2, "nothing new was started after the cancel");
  assert.ok([...results.values()].every((r) => r.status === "kept"));
});

test("progress counts passages done and prompts used, and the total leaves out what was skipped", async () => {
  const backend = createFakeBackend();
  const { engine } = make(backend, { maxParallel: 1, maxCharsPerRequest: 700 });
  const seen = [];
  const units = [deck("d", 6, 2), { id: "s", context: {}, blocks: [{ id: "s.label", kind: "slide", type: "list", itemKind: "slide", deck: true, names: NAMES, sources: ["**Home**"] }] }];
  await go(engine, units, { onProgress: (p) => seen.push(p) });
  assert.equal(seen.at(-1).total, 6, "the label-only block is not counted");
  assert.equal(seen.at(-1).done, 6);
  assert.ok(seen.every((p, i) => i === 0 || p.done >= seen[i - 1].done));
  assert.ok(seen.at(-1).requests >= 2, "prompts used so far are reported with the count");
});

test("the log carries counts and timings of each call, never a prompt, a passage, an answer or a token", async () => {
  const backend = createFakeBackend();
  const { engine, lines } = make(backend);
  await go(engine, [deck("secretdeck", 3, 2, { industry: "Retail", agentName: "Hidden Agent Name" })], { token: "gho_SECRETTOKEN123456" });
  const log = lines.join("\n");
  assert.match(log, /\[ai\] event=request model=fake-fast blocks=3 items=6 chars=\d+ ms=\d+ timeoutMs=\d+ depth=0 attempt=0 outcome=ok/);
  assert.match(log, /event=run /);
  for (const secret of ["gho_SECRET", "Hidden Agent Name", "Associates answer", "Retail", "secretdeck", "Put simply"]) assert.equal(log.includes(secret), false, `the log must not contain ${secret}`);
});

test("prompt version 2 is part of every cache key and of the lab's fingerprint", () => {
  assert.equal(AI_PROMPT_VERSION, "2");
  const block = { id: "b", kind: "why", type: "text", source: "Agents help the team.", names: [] };
  const key = blockCacheKey(block, { model: "m", provider: "p", context: "{}" });
  const body = (version) => JSON.stringify([version, GUARD_VERSION, "p", "m", "why", "text", "Agents help the team.", [], 0, 0, "", "{}"]);
  const hash = (text) => createHash("sha256").update(text).digest("hex");
  assert.equal(key, hash(body("2")), "the key is made with version 2");
  assert.notEqual(key, hash(body("1")), "a version 1 entry is never reused");
  const record = newRecord({ mode: "local-user", providerName: "GitHub Copilot", model: "m", modelName: "M", scope: ["lab"] });
  assert.equal(record.promptVersion, "2");
  sealRecord(record, { a: 1 });
  const sha1 = (version) => createHash("sha1").update(JSON.stringify([AI_WRITING_VERSION, version, "m", { a: 1 }])).digest("hex").slice(0, 16);
  assert.equal(record.fingerprint, sha1("2"));
  assert.notEqual(record.fingerprint, sha1("1"));
});
