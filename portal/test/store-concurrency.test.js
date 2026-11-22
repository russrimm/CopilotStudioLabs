/**
 * Shared JSON stores and the Learn client under load: many callers at once, and more than one process.
 *
 * Nothing here reaches the network. Learn is a local http server; the cross-process tests run `node` children against
 * throwaway folders. Waits are barriers (the server holding a reply until the test lets it go), never sleeps.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import express from "express";

import { updateJsonFileSync, withLockedFileSync } from "../lib/concurrency/json-update.js";
import { lockPathFor } from "../lib/concurrency/file-lock.js";
import { connect, fetchDocPage, learnRequestStats, parseRetryAfterMs, retryDelayMs, searchDocs } from "../lib/lab-builder/learn-mcp.js";
import { registerProductRoutes } from "../lib/lab-builder/product-api.js";
import { setCustomProducts } from "../lib/lab-builder/products.js";
import { MAX_USER_PRODUCTS, buildUserProduct, readUserProducts, writeUserProducts } from "../lib/lab-builder/user-products.js";
import { listHash, writeJsonAtomic as writeSnapshotJson } from "../lib/lab-builder/topic-snapshot.js";
import { createTopicService, resetTopicSource, topicConfig } from "../lib/lab-builder/topic-store.js";
import { createRateLimiter, positiveIntFromEnv } from "../lib/rate-limit.js";
import { loadAgentChatConfig, saveAgentChatConfig } from "../lib/agent-chat.js";
import { loadApprovalConfig, saveApprovalConfig } from "../lib/approvals.js";
import { createProfile, getBrandProfileStorePath, listProfiles } from "../lib/branding-profiles.js";

process.env.LAB_BUILDER_LINK_CHECK = "off";

const PORTAL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIB_URL = `${pathToFileURL(path.join(PORTAL_DIR, "lib")).href}/`;

// ── Helpers ─────────────────────────────────────────────────────────────────

function tempDir(t, prefix = "store-concurrency-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function withEnv(t, name, value) {
  const saved = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  });
}

function waitFor(events, predicate) {
  return new Promise((resolve) => {
    const check = () => {
      if (!predicate()) return;
      events.off("change", check);
      resolve();
    };
    events.on("change", check);
    check();
  });
}

/** Let every queued microtask and I/O callback that is already runnable run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/**
 * A fake Microsoft Learn MCP server. Every tools/call is handed to `behavior[kind]` (kind is "fetch" or "search") as
 * `{ id, args, respond(text, {status, headers}) }`; the default answers at once. A test that wants a barrier stores the
 * call and answers it later.
 */
async function startLearn(t, behavior = {}) {
  const hits = { initialize: 0, fetch: 0, search: 0, urls: [] };
  const events = new EventEmitter();
  const state = { inFlight: 0, maxInFlight: 0 };
  const answered = new WeakSet();
  // A request counts as in flight from its arrival until this test answers it (or the client hangs up).
  const finish = (res) => {
    if (answered.has(res)) return;
    answered.add(res);
    state.inFlight -= 1;
  };
  const send = (res, payload, { status = 200, headers = {} } = {}) => {
    if (res.destroyed || res.writableEnded) return;
    finish(res);
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
  };
  const server = createServer(async (req, res) => {
    const body = JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString("utf8"));
    state.inFlight += 1;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    res.on("close", () => {
      finish(res);
      events.emit("change");
    });
    if (body.method === "initialize") {
      hits.initialize += 1;
      if (behavior.initialize) behavior.initialize({ id: body.id, res, send, hits });
      else send(res, { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18" } });
      events.emit("change");
      return;
    }
    const { name, arguments: args } = body.params;
    const kind = name === "microsoft_docs_fetch" ? "fetch" : "search";
    hits[kind] += 1;
    if (kind === "fetch") hits.urls.push(args.url);
    const call = {
      id: body.id,
      args,
      respond: (text, options) => send(res, { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text }] } }, options),
      fail: (status, headers) => send(res, "unavailable", { status, headers }),
    };
    if (behavior[kind]) behavior[kind](call);
    else call.respond(kind === "fetch" ? `# Page ${args.url}\n\nBody.` : JSON.stringify({ results: [] }));
    // After the behavior ran, so a waiter that checks what the behavior stored sees it.
    events.emit("change");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  return { endpoint, hits, events, state, session: (options = {}) => connect({ endpoint, timeoutMs: 5000, ...options }) };
}

const pageUrl = (n) => `https://learn.microsoft.com/en-us/contoso-test/page-${n}`;

function searchPayload(count) {
  return JSON.stringify({
    results: Array.from({ length: count }, (_, i) => ({
      title: `Contoso result ${i}`,
      url: `https://learn.microsoft.com/en-us/contoso-test/result-${i}`,
      content: `Contoso excerpt ${i} that is comfortably longer than forty characters.`,
    })),
  });
}

// ── Learn client: single flight ─────────────────────────────────────────────

test("identical simultaneous page reads make one network call and every caller gets the page", { timeout: 30000 }, async (t) => {
  const held = [];
  const learn = await startLearn(t, { fetch: (call) => held.push(call) });
  const session = await learn.session();
  const url = pageUrl("single-flight");

  const callers = Array.from({ length: 25 }, () => fetchDocPage(session, url));
  await waitFor(learn.events, () => held.length === 1);
  await settle();
  assert.equal(learn.hits.fetch, 1, "25 callers share one request");
  held[0].respond("# Shared page\n\nOne answer for everyone.");

  const pages = await Promise.all(callers);
  assert.ok(pages.every((page) => page.error === null && page.markdown.startsWith("# Shared page")));
  assert.equal(new Set(pages.map((page) => page.fetchedAt)).size, 1, "everyone received the same result");
  assert.equal((await fetchDocPage(session, url)).markdown, pages[0].markdown);
  assert.equal(learn.hits.fetch, 1, "the finished read is cached");
  assert.deepEqual(learnRequestStats(), { active: 0, queued: 0 });
});

test("identical simultaneous searches make one network call and each caller keeps its own limit", { timeout: 30000 }, async (t) => {
  const held = [];
  const learn = await startLearn(t, { search: (call) => held.push(call) });
  const session = await learn.session();

  const callers = [1, 2, 3, 4, 5].flatMap((limit) => [searchDocs(session, "contoso single flight", { limit }), searchDocs(session, "contoso single flight", { limit })]);
  await waitFor(learn.events, () => held.length === 1);
  await settle();
  assert.equal(learn.hits.search, 1);
  held[0].respond(searchPayload(5));

  const results = await Promise.all(callers);
  assert.deepEqual(results.map((items) => items.length), [1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
  assert.equal((await searchDocs(session, "contoso single flight", { limit: 2 })).length, 2);
  assert.equal(learn.hits.search, 1, "the answer is cached");
});

test("a failed flight is shared by its callers, never cached, and the next caller tries again", { timeout: 30000 }, async (t) => {
  let failing = true;
  const learn = await startLearn(t, {
    fetch: (call) => (failing ? call.fail(400) : call.respond("# Recovered")),
    search: (call) => (failing ? call.fail(400) : call.respond(searchPayload(2))),
  });
  const session = await learn.session();
  const url = pageUrl("failure");

  const failedPages = await Promise.all(Array.from({ length: 10 }, () => fetchDocPage(session, url)));
  assert.ok(failedPages.every((page) => /responded 400/.test(page.error) && page.markdown === ""));
  assert.equal(learn.hits.fetch, 1, "ten callers, one failed request");
  const failedSearches = await Promise.all(Array.from({ length: 10 }, () => searchDocs(session, "contoso failure")));
  assert.ok(failedSearches.every((items) => items.length === 0));
  assert.equal(learn.hits.search, 1);

  failing = false;
  const page = await fetchDocPage(session, url);
  assert.equal(page.error, null);
  assert.equal(page.markdown, "# Recovered");
  assert.equal(learn.hits.fetch, 2, "the next caller retried instead of reading a cached failure");
  assert.equal((await searchDocs(session, "contoso failure")).length, 2);
  assert.equal(learn.hits.search, 2);
  await fetchDocPage(session, url);
  assert.equal(learn.hits.fetch, 2, "and the good read is cached");
  assert.deepEqual(learnRequestStats(), { active: 0, queued: 0 });
});

test("when the caller that started a read is cancelled, the callers sharing it start a new read instead of failing", { timeout: 30000 }, async (t) => {
  const held = [];
  const learn = await startLearn(t, { fetch: (call) => held.push(call) });
  const leaderAbort = new AbortController();
  const leaderSession = await learn.session({ signal: leaderAbort.signal });
  const joinerSession = await learn.session();
  const url = pageUrl("leader-cancelled");

  const leader = fetchDocPage(leaderSession, url);
  const leaderOutcome = leader.then(() => "resolved", (err) => err.name);
  await waitFor(learn.events, () => held.length === 1);
  const joiner = fetchDocPage(joinerSession, url);
  await settle();
  assert.equal(learn.hits.fetch, 1, "the joiner shares the leader's request");

  leaderAbort.abort();
  assert.equal(await leaderOutcome, "AbortError");
  await waitFor(learn.events, () => held.length === 2);
  held[1].respond("# After takeover");
  const page = await joiner;
  assert.equal(page.error, null);
  assert.equal(page.markdown, "# After takeover");
  assert.equal(learn.hits.fetch, 2);
});

test("a joiner that is cancelled stops waiting at once and leaves the shared read running", { timeout: 30000 }, async (t) => {
  const held = [];
  const learn = await startLearn(t, { fetch: (call) => held.push(call) });
  const joinerAbort = new AbortController();
  const joinerSession = await learn.session({ signal: joinerAbort.signal });
  const leaderSession = await learn.session();
  const url = pageUrl("joiner-cancelled");

  const leader = fetchDocPage(leaderSession, url);
  await waitFor(learn.events, () => held.length === 1);
  const joiner = fetchDocPage(joinerSession, url);
  await settle();
  joinerAbort.abort();
  await assert.rejects(joiner, { name: "AbortError" });

  held[0].respond("# Still delivered");
  assert.equal((await leader).markdown, "# Still delivered");
  assert.equal(learn.hits.fetch, 1);
});

// ── Learn client: concurrency cap ───────────────────────────────────────────

test("no more than LAB_BUILDER_LEARN_MAX_CONCURRENT requests are in flight, and the rest all finish", { timeout: 60000 }, async (t) => {
  const held = [];
  const learn = await startLearn(t, { fetch: (call) => held.push(call) });
  const session = await learn.session();
  withEnv(t, "LAB_BUILDER_LEARN_MAX_CONCURRENT", "3");

  const callers = Array.from({ length: 10 }, (_, i) => fetchDocPage(session, pageUrl(`cap-${i}`)));
  await waitFor(learn.events, () => held.length === 3);
  await settle();
  assert.equal(learn.hits.fetch, 3, "only three requests left the process");
  assert.deepEqual(learnRequestStats(), { active: 3, queued: 7 });

  let answered = 0;
  while (answered < 10) {
    const batch = held.splice(0);
    for (const call of batch) call.respond(`# ${call.args.url}`);
    answered += batch.length;
    if (answered < 10) await waitFor(learn.events, () => held.length > 0);
  }
  const pages = await Promise.all(callers);
  assert.ok(pages.every((page) => page.error === null));
  assert.equal(learn.hits.fetch, 10);
  assert.equal(learn.state.maxInFlight, 3, "the server never saw more than the cap at once");
  assert.deepEqual(learnRequestStats(), { active: 0, queued: 0 });
});

test("a caller cancelled while waiting for a slot leaves the line and nobody deadlocks", { timeout: 60000 }, async (t) => {
  const held = [];
  const learn = await startLearn(t, { fetch: (call) => held.push(call) });
  const plain = await learn.session();
  const cancelAbort = new AbortController();
  const cancellable = await learn.session({ signal: cancelAbort.signal });
  withEnv(t, "LAB_BUILDER_LEARN_MAX_CONCURRENT", "1");

  const first = fetchDocPage(plain, pageUrl("line-first"));
  await waitFor(learn.events, () => held.length === 1);
  const cancelled = fetchDocPage(cancellable, pageUrl("line-cancelled"));
  const last = fetchDocPage(plain, pageUrl("line-last"));
  await settle();
  assert.deepEqual(learnRequestStats(), { active: 1, queued: 2 });

  cancelAbort.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
  assert.deepEqual(learnRequestStats(), { active: 1, queued: 1 }, "the cancelled waiter left the queue");

  held.shift().respond("# first");
  await waitFor(learn.events, () => held.length === 1);
  held.shift().respond("# last");
  assert.equal((await first).error, null);
  assert.equal((await last).markdown, "# last");
  assert.ok(!learn.hits.urls.includes(pageUrl("line-cancelled")), "the cancelled read never reached the server");
  assert.deepEqual(learnRequestStats(), { active: 0, queued: 0 });
});

test("a slot is released when a request fails, so a failing server cannot starve the queue", { timeout: 30000 }, async (t) => {
  const learn = await startLearn(t, { fetch: (call) => call.fail(400) });
  const session = await learn.session();
  withEnv(t, "LAB_BUILDER_LEARN_MAX_CONCURRENT", "1");

  const pages = await Promise.all(Array.from({ length: 6 }, (_, i) => fetchDocPage(session, pageUrl(`starve-${i}`))));
  assert.ok(pages.every((page) => /responded 400/.test(page.error)));
  assert.equal(learn.hits.fetch, 6);
  assert.deepEqual(learnRequestStats(), { active: 0, queued: 0 });
});

// ── Learn client: Retry-After and the cache bound ───────────────────────────

test("Retry-After is read as seconds or as an HTTP date, and the retry delay is bounded", () => {
  assert.equal(parseRetryAfterMs("2"), 2000);
  assert.equal(parseRetryAfterMs(" 0 "), 0);
  assert.equal(parseRetryAfterMs("Wed, 21 Oct 2026 07:28:05 GMT", Date.parse("Wed, 21 Oct 2026 07:28:00 GMT")), 5000);
  assert.equal(parseRetryAfterMs("Wed, 21 Oct 2026 07:28:00 GMT", Date.parse("Thu, 22 Oct 2026 07:28:00 GMT")), 0, "a date in the past means now");
  assert.ok(Number.isNaN(parseRetryAfterMs("soon")));
  assert.ok(Number.isNaN(parseRetryAfterMs(null)));

  assert.equal(retryDelayMs(1, Number.NaN, () => 0), 250, "no header: plain backoff");
  assert.equal(retryDelayMs(2, Number.NaN, () => 0), 500, "backoff doubles");
  assert.equal(retryDelayMs(1, 2000, () => 0), 2000, "the server's wait is honored");
  assert.equal(retryDelayMs(1, 2000, () => 1), 2500, "jitter adds up to a quarter");
  assert.equal(retryDelayMs(1, 0, () => 0), 250, "Retry-After: 0 still backs off a little");
  assert.equal(retryDelayMs(1, 120000, () => 0.9), 10000, "a long wait is capped at ten seconds");
});

test("a 429 with Retry-After is retried once after that wait; a 400 is not retried; two failures stop at two attempts", { timeout: 30000 }, async (t) => {
  let initializeAnswers = 0;
  const learn = await startLearn(t, {
    initialize: ({ id, res, send }) => {
      initializeAnswers += 1;
      if (initializeAnswers === 1) return send(res, "slow down", { status: 429, headers: { "retry-after": "1" } });
      return send(res, { jsonrpc: "2.0", id, result: { protocolVersion: "2025-06-18" } });
    },
  });
  const started = Date.now();
  const session = await learn.session();
  const elapsed = Date.now() - started;
  assert.equal(session.ok, true);
  assert.equal(learn.hits.initialize, 2);
  assert.ok(elapsed >= 950, `waited for Retry-After: 1 (took ${elapsed} ms)`);

  const badRequest = await startLearn(t, { initialize: ({ res, send }) => send(res, "bad", { status: 400 }) });
  assert.equal((await badRequest.session()).ok, false);
  assert.equal(badRequest.hits.initialize, 1, "a 400 is final");

  const down = await startLearn(t, { initialize: ({ res, send }) => send(res, "down", { status: 503, headers: { "retry-after": "0" } }) });
  assert.equal((await down.session()).ok, false);
  assert.equal(down.hits.initialize, 2, "at most two attempts");
});

test("the Learn cache holds at most LAB_BUILDER_LEARN_CACHE_MAX entries and drops the oldest first", { timeout: 30000 }, async (t) => {
  const learn = await startLearn(t);
  const session = await learn.session();
  withEnv(t, "LAB_BUILDER_LEARN_CACHE_MAX", "5");

  for (let i = 1; i <= 12; i += 1) await fetchDocPage(session, pageUrl(`cache-${i}`));
  assert.equal(learn.hits.fetch, 12);
  await fetchDocPage(session, pageUrl("cache-12"));
  await fetchDocPage(session, pageUrl("cache-8"));
  assert.equal(learn.hits.fetch, 12, "the five newest pages are still cached");
  await fetchDocPage(session, pageUrl("cache-1"));
  assert.equal(learn.hits.fetch, 13, "the oldest page was dropped");
  await fetchDocPage(session, pageUrl("cache-8"));
  assert.equal(learn.hits.fetch, 14, "and adding it back pushed out the next oldest");
});

// ── Topic store: one discovery per product ──────────────────────────────────

test("50 simultaneous revalidateIfStale() and 50 refresh() calls start exactly one discovery per product", { timeout: 30000 }, async (t) => {
  const dir = tempDir(t);
  t.after(() => resetTopicSource());
  const config = topicConfig({
    LAB_BUILDER_TOPICS_CACHE: path.join(dir, "topics-cache.json"),
    LAB_BUILDER_TOPICS_SNAPSHOT: path.join(dir, "no-baseline.json"),
    LAB_BUILDER_USER_TOPICS: path.join(dir, "user-topics.json"),
    LAB_BUILDER_TOPICS_MIN_REFRESH_MS: "60000",
  });
  const started = {};
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const emptySnapshot = () => {
    const snapshot = { schemaVersion: 1, generatedAt: new Date().toISOString(), source: "test", topics: [], catalog: [], pageHashes: {} };
    return { ...snapshot, listHash: listHash(snapshot) };
  };
  const service = createTopicService({
    config,
    discover: async ({ product = "copilot-studio" }) => {
      started[product] = (started[product] || 0) + 1;
      await gate;
      return emptySnapshot();
    },
  });

  const revalidations = Array.from({ length: 50 }, () => service.revalidateIfStale());
  assert.equal(revalidations.filter(Boolean).length, 1, "only the first call starts a refresh");
  const studio = Array.from({ length: 50 }, () => service.refresh());
  const foundry = Array.from({ length: 50 }, () => service.refresh({ product: "ai-foundry" }));
  const sharepoint = Array.from({ length: 50 }, () => service.refresh({ product: "sharepoint-ai" }));
  assert.deepEqual(started, { "copilot-studio": 1, "ai-foundry": 1, "sharepoint-ai": 1 }, "one discovery per product, started at once");

  release();
  for (const group of [studio, foundry, sharepoint]) {
    const results = await Promise.all(group);
    assert.ok(results.every((result) => result === results[0] || (result.ok && result.refreshedAt === results[0].refreshedAt)));
    assert.equal(results[0].ok, true);
  }
  const later = await Promise.all(Array.from({ length: 50 }, () => service.refresh()));
  assert.ok(later.every((result) => result.reason === "too-soon"), "no new discovery right after one finished");
  assert.equal(service.revalidateIfStale(), false);
  assert.deepEqual(started, { "copilot-studio": 1, "ai-foundry": 1, "sharepoint-ai": 1 });
});

// ── Atomic writes keep their exact format ───────────────────────────────────

const leftovers = (dir) => fs.readdirSync(dir).filter((name) => /\.tmp$|\.blob-tmp-/.test(name));

test("every store writes the same bytes as before and leaves no temp or lock file behind", (t) => {
  const dir = tempDir(t);
  const env = { PORTAL_DATA_DIR: path.join(dir, "data"), PORTAL_UPLOADS_DIR: path.join(dir, "uploads"), LAB_BUILDER_OUTPUT_DIR: path.join(dir, "labs") };
  const read = (file) => fs.readFileSync(file, "utf8");

  const productsFile = path.join(dir, "user-products.json");
  const product = buildUserProduct({ name: "Contoso Alpha", root: "https://learn.microsoft.com/contoso-alpha", now: Date.parse("2026-01-02T03:04:05Z") });
  writeUserProducts(productsFile, [product]);
  assert.equal(read(productsFile), `${JSON.stringify({ schemaVersion: 1, products: [product] }, null, 2)}\n`);

  const snapshotFile = path.join(dir, "snapshot.json");
  writeSnapshotJson(snapshotFile, { a: 1, b: [1, 2] });
  assert.equal(read(snapshotFile), `${JSON.stringify({ a: 1, b: [1, 2] }, null, 2)}\n`);

  const approvalConfig = saveApprovalConfig({ approvalMethod: "portal", approverEmails: "ann@contoso.example; bob@contoso.example" }, env);
  assert.equal(read(path.join(env.PORTAL_DATA_DIR, "approval-config.json")), JSON.stringify(approvalConfig, null, 2), "no closing newline, as before");
  assert.deepEqual(loadApprovalConfig(env).approverEmails, ["ann@contoso.example", "bob@contoso.example"]);

  const chat = saveAgentChatConfig({ tokenEndpoint: "https://chat.contoso.example/token", agentName: "Helper" }, env);
  assert.equal(read(path.join(env.PORTAL_DATA_DIR, "agent-chat-config.json")), JSON.stringify({ tokenEndpoint: chat.tokenEndpoint, agentName: chat.agentName }, null, 2));
  assert.equal(loadAgentChatConfig(env).configured, true);

  const created = createProfile({ name: "Contoso Retail", companyName: "Contoso Retail" }, env);
  const storeFile = getBrandProfileStorePath(env);
  const store = JSON.parse(read(storeFile));
  assert.equal(read(storeFile), `${JSON.stringify(store, null, 2)}\n`);
  assert.ok(store.profiles.some((p) => p.id === created.id));
  assert.equal(listProfiles(env).profiles.length, 2);

  for (const folder of [dir, env.PORTAL_DATA_DIR]) assert.deepEqual(leftovers(folder), [], folder);
});

test("updateJsonFileSync: fallback, no-change result, nested use, and the lock is always released", (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "counter.json");
  assert.deepEqual(updateJsonFileSync(file, (current) => ({ count: current.count + 1 }), { fallback: { count: 0 } }), { count: 1 });
  assert.equal(fs.readFileSync(file, "utf8"), `${JSON.stringify({ count: 1 }, null, 2)}\n`);
  assert.deepEqual(updateJsonFileSync(file, () => undefined), { count: 1 }, "returning undefined writes nothing");

  const nested = updateJsonFileSync(file, (current) => {
    withLockedFileSync(file, () => assert.ok(fs.existsSync(lockPathFor(file)), "the outer call holds the lock"));
    return { count: current.count + 10 };
  });
  assert.deepEqual(nested, { count: 11 });

  assert.throws(() => updateJsonFileSync(file, () => { throw new Error("stop"); }), /stop/);
  assert.equal(fs.existsSync(lockPathFor(file)), false, "a failing update still releases the lock");
  const fallback = { count: 100 };
  updateJsonFileSync(path.join(dir, "other.json"), (current) => { current.count += 1; return current; }, { fallback });
  assert.equal(fallback.count, 100, "the fallback object is never changed in place");
  assert.deepEqual(leftovers(dir), []);
});

// ── Product routes: two people adding at once ───────────────────────────────

async function startProductApi(t, { file, learn }) {
  setCustomProducts([]);
  withEnv(t, "LAB_BUILDER_USER_PRODUCTS_RATE_MAX", "1000");
  const service = { config: { userProductsPath: file } };
  const app = express();
  app.use(express.json());
  registerProductRoutes(app, { getService: () => service, createRateLimiter, positiveIntFromEnv, learn });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
    setCustomProducts(undefined);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return (route, method = "POST", body) =>
    fetch(`${base}${route}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
}

/** A Learn client whose page read waits at a gate: it opens by itself once `autoOpenAt` callers wait, or when the test says. */
function barrierLearn(autoOpenAt = Number.POSITIVE_INFINITY) {
  const events = new EventEmitter();
  const arrived = [];
  let open;
  const gate = new Promise((resolve) => {
    open = resolve;
  });
  const titleOf = (url) =>
    new URL(url).pathname
      .split("/")
      .pop()
      .split("-")
      .map((word) => word[0].toUpperCase() + word.slice(1))
      .join(" ");
  return {
    open: () => open(),
    whenArrived: (count) => waitFor(events, () => arrived.length >= count),
    search: async () => [],
    page: async (url) => {
      arrived.push(url);
      events.emit("change");
      if (arrived.length >= autoOpenAt) open();
      await gate;
      return { url, error: null, markdown: `# ${titleOf(url)} documentation\n\nLearn about the product and how to use it every day.\n` };
    },
  };
}

test("two people adding different products at the same moment both keep their product", { timeout: 30000 }, async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "user-products.json");
  const call = await startProductApi(t, { file, learn: barrierLearn(2) });

  const [one, two] = await Promise.all([
    call("/api/lab-builder/products/mine", "POST", { root: "https://learn.microsoft.com/contoso-alpha" }),
    call("/api/lab-builder/products/mine", "POST", { root: "https://learn.microsoft.com/contoso-beta" }),
  ]);
  assert.deepEqual([one.status, two.status], [201, 201]);
  assert.deepEqual(readUserProducts(file).map((p) => p.id).sort(), ["custom-contoso-alpha", "custom-contoso-beta"], "neither addition overwrote the other");
  assert.deepEqual(leftovers(dir), []);
});

test("two people racing for the last free slot: one is added, the other is told the list is full", { timeout: 30000 }, async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "user-products.json");
  const existing = Array.from({ length: MAX_USER_PRODUCTS - 1 }, (_, i) => buildUserProduct({ name: `Contoso Existing ${i}`, root: `https://learn.microsoft.com/contoso-existing-${i}` }));
  writeUserProducts(file, existing);
  const call = await startProductApi(t, { file, learn: barrierLearn(2) });

  const responses = await Promise.all([
    call("/api/lab-builder/products/mine", "POST", { root: "https://learn.microsoft.com/contoso-last-one" }),
    call("/api/lab-builder/products/mine", "POST", { root: "https://learn.microsoft.com/contoso-last-two" }),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [201, 400]);
  assert.equal(readUserProducts(file).length, MAX_USER_PRODUCTS, "the cap holds");
});

test("two people adding the same name at once: one is added, the other gets a clear conflict", { timeout: 30000 }, async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "user-products.json");
  const call = await startProductApi(t, { file, learn: barrierLearn(2) });

  const responses = await Promise.all([
    call("/api/lab-builder/products/mine", "POST", { root: "https://learn.microsoft.com/contoso-gamma", name: "Contoso Gamma" }),
    call("/api/lab-builder/products/mine", "POST", { root: "https://learn.microsoft.com/contoso-gamma-two", name: "Contoso Gamma" }),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
  assert.deepEqual(readUserProducts(file).map((p) => p.id), ["custom-contoso-gamma"]);
});

test("removing a product while another is being added keeps the addition and does not bring the removed one back", { timeout: 30000 }, async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "user-products.json");
  writeUserProducts(file, [buildUserProduct({ name: "Contoso Old", root: "https://learn.microsoft.com/contoso-old" })]);
  const learn = barrierLearn();
  const call = await startProductApi(t, { file, learn });

  const adding = call("/api/lab-builder/products/mine", "POST", { root: "https://learn.microsoft.com/contoso-new" });
  await learn.whenArrived(1);
  const removed = await call("/api/lab-builder/products/mine/custom-contoso-old", "DELETE");
  learn.open();
  const added = await adding;
  assert.equal(removed.status, 200);
  assert.equal(added.status, 201);
  assert.deepEqual(readUserProducts(file).map((p) => p.id), ["custom-contoso-new"]);
});

// ── Cross-process ───────────────────────────────────────────────────────────

const WORKER = `
const job = JSON.parse(process.env.STORE_TEST_JOB);
const load = (rel) => import(job.libUrl + rel);
while (Date.now() < job.startAt) await new Promise((resolve) => setTimeout(resolve, 5));
if (job.kind === "increment") {
  const { updateJsonFileSync } = await load("concurrency/json-update.js");
  const fs = await import("node:fs");
  for (let i = 0; i < job.times; i += 1) {
    updateJsonFileSync(job.file, (current) => {
      // Raw parse, not the tolerant reader: a half-written file must fail loudly here.
      if (fs.existsSync(job.file)) JSON.parse(fs.readFileSync(job.file, "utf8"));
      return { count: current.count + 1 };
    }, { fallback: { count: 0 } });
  }
} else if (job.kind === "products") {
  const { updateUserProducts, buildUserProduct } = await load("lab-builder/user-products.js");
  for (const name of job.names) {
    updateUserProducts(job.file, (current) => ({ products: [...current, buildUserProduct({ name, root: "https://learn.microsoft.com/" + name.toLowerCase().replace(/ /g, "-") })] }));
  }
} else if (job.kind === "topics") {
  const { createTopicService, topicConfig } = await load("lab-builder/topic-store.js");
  const { buildUserTopic } = await load("lab-builder/user-topic-build.js");
  const config = topicConfig({ LAB_BUILDER_TOPICS_CACHE: job.cache, LAB_BUILDER_TOPICS_SNAPSHOT: job.snapshot, LAB_BUILDER_USER_TOPICS: job.file });
  const service = createTopicService({ config, discover: async () => { throw new Error("not used"); } });
  for (const slug of job.slugs) {
    const topic = buildUserTopic({ url: "https://learn.microsoft.com/microsoft-copilot-studio/" + slug, markdown: "# Contoso " + slug + "\\n\\nThis article explains " + slug + " in Copilot Studio.", product: "copilot-studio" });
    if (!topic) throw new Error("no topic for " + slug);
    service.addUserTopic(topic);
  }
} else if (job.kind === "approvals") {
  const { submitRequest } = await load("approvals.js");
  await Promise.all(job.names.map((displayName) => submitRequest({ displayName, requestedBy: "user@contoso.example" })));
} else if (job.kind === "profiles") {
  const { createProfile } = await load("branding-profiles.js");
  for (const name of job.names) createProfile({ name, companyName: name });
}
`;

/** Start a node child that runs `job` at `startAt`; resolves when it exits cleanly. */
function runWorker(job, env) {
  const { NODE_TEST_CONTEXT: _context, ...inherited } = process.env;
  const child = spawn(process.execPath, ["--input-type=module", "-e", WORKER], {
    env: { ...inherited, ...env, STORE_TEST_JOB: JSON.stringify({ ...job, libUrl: LIB_URL }) },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`worker exited with ${code}: ${stderr.trim().slice(-600)}`))));
  });
}

function childEnv(dir) {
  return {
    LOCALAPPDATA: path.join(dir, "localappdata"),
    PORTAL_DATA_DIR: path.join(dir, "data"),
    PORTAL_UPLOADS_DIR: path.join(dir, "uploads"),
    LAB_BUILDER_OUTPUT_DIR: path.join(dir, "labs"),
    LAB_BUILDER_LINK_CHECK: "off",
  };
}

/**
 * Run workers together from a shared start time while watching `file` from outside; fails if a read ever sees unparsable
 * JSON. The watcher reads gently (every 100 ms): on Windows a rename over a file that another process keeps opening every
 * few milliseconds can fail, which says nothing about the code under test.
 */
async function runTogether(jobs, env, file) {
  const startAt = Date.now() + 1500;
  let running = true;
  const bad = [];
  let reads = 0;
  const poller = (async () => {
    while (running) {
      let text;
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
        text = null;
      }
      if (text !== null) {
        reads += 1;
        try {
          JSON.parse(text);
        } catch (err) {
          bad.push(`${err.message}: ${JSON.stringify(text.slice(0, 80))}`);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  })();
  try {
    await Promise.all(jobs.map((job) => runWorker({ ...job, startAt }, env)));
  } finally {
    running = false;
    await poller;
  }
  assert.deepEqual(bad, [], "the file never held a partial write");
  return reads;
}

test("two processes making 50 locked increments between them end at exactly 50", { timeout: 120000 }, async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "counter.json");
  await runTogether([{ kind: "increment", file, times: 25 }, { kind: "increment", file, times: 25 }], childEnv(dir), file);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { count: 50 });
  assert.deepEqual(leftovers(dir), []);
});

test("two processes adding different user products at once keep both sets", { timeout: 120000 }, async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "user-products.json");
  const mine = ["Contoso Alpha", "Contoso Beta", "Contoso Gamma", "Contoso Delta"];
  const theirs = ["Fabrikam One", "Fabrikam Two", "Fabrikam Three", "Fabrikam Four"];
  await runTogether([{ kind: "products", file, names: mine }, { kind: "products", file, names: theirs }], childEnv(dir), file);
  assert.deepEqual(readUserProducts(file).map((p) => p.name).sort(), [...mine, ...theirs].sort());
  assert.deepEqual(leftovers(dir), []);
});

test("two processes adding saved topics at once keep every topic", { timeout: 120000 }, async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "user-topics.json");
  const env = { ...childEnv(dir) };
  const jobBase = { file, cache: path.join(dir, "topics-cache.json"), snapshot: path.join(dir, "no-baseline.json") };
  const mine = ["contoso-one", "contoso-two", "contoso-three", "contoso-four"];
  const theirs = ["fabrikam-one", "fabrikam-two", "fabrikam-three", "fabrikam-four"];
  await runTogether([{ kind: "topics", ...jobBase, slugs: mine }, { kind: "topics", ...jobBase, slugs: theirs }], env, file);
  const saved = JSON.parse(fs.readFileSync(file, "utf8")).topics.map((topic) => topic.urls[0].split("/").pop());
  assert.deepEqual(saved.sort(), [...mine, ...theirs].sort());
  assert.deepEqual(leftovers(dir), []);
});

test("two processes submitting approval requests at once lose none", { timeout: 120000 }, async (t) => {
  const dir = tempDir(t);
  const env = childEnv(dir);
  fs.mkdirSync(env.PORTAL_DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(env.PORTAL_DATA_DIR, "approval-config.json"), JSON.stringify({ approvalMethod: "portal" }));
  const file = path.join(env.PORTAL_DATA_DIR, "approval-requests.json");
  const mine = Array.from({ length: 6 }, (_, i) => `Contoso Sandbox ${i}`);
  const theirs = Array.from({ length: 6 }, (_, i) => `Fabrikam Sandbox ${i}`);
  await runTogether([{ kind: "approvals", names: mine }, { kind: "approvals", names: theirs }], env, file);
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(saved.map((request) => request.displayName).sort(), [...mine, ...theirs].sort());
  assert.equal(new Set(saved.map((request) => request.id)).size, 12);
  assert.deepEqual(leftovers(env.PORTAL_DATA_DIR), []);
});

test("two processes creating brand profiles at once lose none", { timeout: 120000 }, async (t) => {
  const dir = tempDir(t);
  const env = childEnv(dir);
  const file = path.join(env.PORTAL_DATA_DIR, "brand-profiles.json");
  fs.mkdirSync(env.PORTAL_DATA_DIR, { recursive: true });
  const mine = Array.from({ length: 6 }, (_, i) => `Contoso Brand ${i}`);
  const theirs = Array.from({ length: 6 }, (_, i) => `Fabrikam Brand ${i}`);
  await runTogether([{ kind: "profiles", names: mine }, { kind: "profiles", names: theirs }], env, file);
  const names = JSON.parse(fs.readFileSync(file, "utf8")).profiles.map((profile) => profile.name);
  assert.deepEqual(names.filter((name) => name !== "Default").sort(), [...mine, ...theirs].sort());
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(leftovers(env.PORTAL_DATA_DIR), []);
});
