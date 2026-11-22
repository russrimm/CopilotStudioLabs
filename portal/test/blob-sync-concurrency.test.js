/**
 * Azure Blob mirror under many concurrent users: burst coalescing with a max wait, one serialized runner behind every
 * entry point, older versions never landing over newer ones, backoff retries after a failed pass, an event loop that
 * keeps turning during a big pass, a bounded shutdown flush, and temp files that are never uploaded.
 *
 * Hermetic: a fake Blob client (no network, fake-account.blob.invalid), a fake clock for every timer, and a throwaway
 * storage root per test. Waits are on state (a held request reached, a pass finished), never on elapsed time.
 */

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, promises as fsPromises, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createBlobPersistence, flushBlobSyncForShutdown, getBlobPersistence, initBlobPersistence, scheduleBlobSync } from "../lib/blob-persistence.js";
import { registerBlobSyncStatusProvider } from "../lib/storage-config.js";

const FAKE_ENDPOINT = "https://fake-account.blob.invalid";
const cleanups = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function until(predicate, label) {
  for (let turn = 0; turn < 200000; turn += 1) {
    if (predicate()) return;
    await new Promise((resolveTurn) => (turn % 100 === 99 ? setTimeout(resolveTurn, 1) : setImmediate(resolveTurn)));
  }
  assert.fail(`never reached: ${label}`);
}

async function turns(count) {
  for (let turn = 0; turn < count; turn += 1) await new Promise((resolveTurn) => setImmediate(resolveTurn));
}

function createFakeClock(startMs = 1_000_000) {
  let nowMs = startMs;
  let nextId = 0;
  const pending = new Map();
  const created = [];
  return {
    now: () => nowMs,
    setTimeout(fn, delayMs) {
      nextId += 1;
      created.push(delayMs);
      pending.set(nextId, { at: nowMs + delayMs, fn });
      return { id: nextId, unref() {} };
    },
    clearTimeout(handle) {
      if (handle) pending.delete(handle.id);
    },
    pendingCount: () => pending.size,
    createdDelays: () => [...created],
    advance(ms) {
      const target = nowMs + ms;
      for (;;) {
        let next = null;
        for (const [id, timer] of pending) {
          if (timer.at <= target && (!next || timer.at < next.timer.at)) next = { id, timer };
        }
        if (!next) break;
        pending.delete(next.id);
        nowMs = Math.max(nowMs, next.timer.at);
        next.timer.fn();
      }
      nowMs = target;
    },
  };
}

/** A fake Blob endpoint speaking just enough of the REST API; any request can be held open behind a barrier. */
function createFakeBlob() {
  const blobs = new Map();
  const puts = [];
  const holds = [];
  const stats = { requests: 0, putAttempts: 0, deletes: 0, maxInFlightSameBlob: 0 };
  const putsInFlight = new Map();
  let putFailure = null;
  let listFailure = null;

  function hold(method, name) {
    const reached = deferred();
    const released = deferred();
    holds.push({ method, name, used: false, reached, released });
    return { reached: reached.promise, release: () => released.resolve() };
  }

  async function fetchImpl(url, init = {}) {
    const parsed = new URL(url);
    const method = init.method || "GET";
    stats.requests += 1;
    if (parsed.searchParams.get("comp") === "list") {
      if (listFailure) return new Response(null, { status: listFailure });
      const names = [...blobs.keys()].sort().map((name) => `<Blob><Name>${name}</Name></Blob>`).join("");
      return new Response(`<EnumerationResults><Blobs>${names}</Blobs><NextMarker></NextMarker></EnumerationResults>`, { status: 200 });
    }
    const name = decodeURIComponent(parsed.pathname.split("/").slice(2).join("/"));
    if (method === "PUT") {
      stats.putAttempts += 1;
      const inFlight = (putsInFlight.get(name) ?? 0) + 1;
      putsInFlight.set(name, inFlight);
      stats.maxInFlightSameBlob = Math.max(stats.maxInFlightSameBlob, inFlight);
    }
    try {
      const held = holds.find((entry) => !entry.used && entry.method === method && entry.name === name);
      if (held) {
        held.used = true;
        held.reached.resolve();
        await held.released.promise;
      }
      if (method === "PUT") {
        const status = typeof putFailure === "function" ? putFailure(name) : putFailure;
        if (status) return new Response(null, { status });
        const body = Buffer.from(init.body);
        blobs.set(name, body);
        puts.push({ name, text: body.toString("utf8") });
        return new Response(null, { status: 201 });
      }
      if (method === "DELETE") {
        stats.deletes += 1;
        blobs.delete(name);
        return new Response(null, { status: 202 });
      }
      return blobs.has(name) ? new Response(blobs.get(name), { status: 200 }) : new Response(null, { status: 404 });
    } finally {
      if (method === "PUT") putsInFlight.set(name, putsInFlight.get(name) - 1);
    }
  }

  return {
    blobs,
    puts,
    stats,
    fetchImpl,
    hold,
    failPuts(spec) {
      putFailure = spec;
    },
    failLists(status) {
      listFailure = status;
    },
  };
}

async function setup({ hydrate = true, envExtra = {}, ...options } = {}) {
  const root = mkdtempSync(join(tmpdir(), "blob-sync-"));
  const fake = createFakeBlob();
  const clock = createFakeClock();
  const mirror = createBlobPersistence({
    env: { PORTAL_STORAGE_ROOT: root, AZURE_STORAGE_BLOB_ENDPOINT: FAKE_ENDPOINT, ...envExtra },
    fetchImpl: fake.fetchImpl,
    tokenProvider: () => "test-token",
    retryBaseDelayMs: 0,
    maxRetries: 0,
    timers: clock,
    ...options,
  });
  cleanups.push(() => {
    mirror.stop();
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });
  if (hydrate) await mirror.hydrateFromBlob();
  return { root, fake, clock, mirror };
}

function writeLocal(root, relPath, content) {
  const file = join(root, ...relPath.split("/"));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

const settled = (mirror) => !mirror.getStatus().syncing;
const settleAfter = (mirror, fake, putAttempts) => until(() => fake.stats.putAttempts === putAttempts && settled(mirror), `${putAttempts} upload attempts and an idle runner`);

// ── Burst coalescing ─────────────────────────────────────────────────────────

test("a burst of changes arms one timer, and a continuous burst still flushes at the max wait", async () => {
  const { mirror, fake, clock, root } = await setup({ envExtra: { BLOB_SYNC_MAX_WAIT_MS: "2000" } });
  const requestsBefore = fake.stats.requests;

  writeLocal(root, "data/burst-0.json", "{}");
  for (let call = 0; call < 10000; call += 1) assert.equal(mirror.scheduleBlobSync(), undefined, "scheduling is synchronous and returns nothing");
  assert.equal(clock.createdDelays().length, 1, "ten thousand mutating responses share a single debounce timer");
  assert.equal(fake.stats.requests, requestsBefore, "scheduling never touches Blob");

  // A request every 100 ms keeps resetting a 250 ms debounce, so only the max wait can flush it.
  for (let step = 1; step < 20; step += 1) {
    writeLocal(root, `data/burst-${step}.json`, "{}");
    clock.advance(100);
    mirror.scheduleBlobSync();
    assert.equal(fake.stats.putAttempts, 0, `no pass before the max wait (step ${step})`);
  }
  writeLocal(root, "data/burst-20.json", "{}");
  clock.advance(100);
  await until(() => fake.puts.length > 0 && settled(mirror), "the max-wait pass finished");
  assert.equal(fake.puts.length, 21, "the pass uploaded everything written during the burst, once each");

  writeLocal(root, "data/late.json", "{}");
  mirror.scheduleBlobSync();
  clock.advance(249);
  assert.equal(fake.blobs.has("data/late.json"), false, "a quiet period shorter than the debounce does not flush");
  clock.advance(1);
  await until(() => fake.blobs.has("data/late.json") && settled(mirror), "the debounced pass finished");
});

test("the default max wait is thirty seconds", async () => {
  const { mirror, fake, clock, root } = await setup();
  writeLocal(root, "data/steady.json", "{}");
  mirror.scheduleBlobSync();
  for (let elapsed = 100; elapsed < 30000; elapsed += 100) {
    clock.advance(100);
    mirror.scheduleBlobSync();
  }
  assert.equal(fake.stats.putAttempts, 0);
  clock.advance(100);
  await until(() => fake.blobs.has("data/steady.json") && settled(mirror), "the 30 s pass finished");
});

// ── Serialization and ordering ───────────────────────────────────────────────

test("scheduled, flush, manual and shutdown entry points share one runner, so passes never overlap", async () => {
  const { mirror, fake, clock, root } = await setup();
  for (const name of ["a", "b", "c"]) writeLocal(root, `data/${name}.json`, `{"${name}":1}`);
  const hold = fake.hold("PUT", "data/a.json");

  const first = mirror.syncToBlob();
  await hold.reached;
  mirror.scheduleBlobSync();
  clock.advance(250);
  const joined = [mirror.syncToBlob(), mirror.flushBlobSync(), mirror.flushBlobSyncForShutdown({ timeoutMs: 600000 })];
  hold.release();
  const results = await Promise.all([first, ...joined]);

  assert.equal(fake.stats.maxInFlightSameBlob, 1, "the same blob is never uploaded by two passes at once");
  assert.deepEqual(fake.puts.map((put) => put.name).sort(), ["data/a.json", "data/b.json", "data/c.json"], "each file was uploaded exactly once");
  assert.ok(results.every((status) => status.healthy));
});

test("an older version never lands over a newer one while its upload is held open", async () => {
  const { mirror, fake, root } = await setup();
  const file = writeLocal(root, "data/doc.json", "version-1");
  const hold = fake.hold("PUT", "data/doc.json");

  const first = mirror.syncToBlob();
  await hold.reached;
  writeLocal(root, "data/doc.json", "version-2-is-newer");
  const second = mirror.flushBlobSync();
  assert.equal(fake.stats.putAttempts, 1, "the second sync waits behind the held upload");
  hold.release();
  await Promise.all([first, second]);

  assert.deepEqual(fake.puts.map((put) => put.text), ["version-1", "version-2-is-newer"], "the older upload lands first, the newer one last");
  assert.equal(fake.blobs.get("data/doc.json").toString(), readFileSync(file, "utf8"));
  await mirror.syncToBlob();
  assert.equal(fake.puts.length, 2, "nothing is left to upload");
});

test("a file that changes after it was read is never sent: the send-time check skips the stale read", async () => {
  let armed = null;
  // An expired token on every call makes the token step a seam between reading the file and sending it.
  const tokenProvider = async () => {
    if (armed) {
      const gate = armed;
      armed = null;
      gate.held.resolve();
      await gate.released.promise;
    }
    return { accessToken: "test-token", expiresOnMs: 0 };
  };
  const { mirror, fake, root } = await setup({ tokenProvider });
  writeLocal(root, "data/doc.json", "first-version");

  const gate = { held: deferred(), released: deferred() };
  armed = gate;
  const pass = mirror.syncToBlob();
  await gate.held.promise;
  writeLocal(root, "data/doc.json", "second-version-is-longer");
  gate.released.resolve();
  const status = await pass;

  assert.deepEqual(fake.puts.map((put) => put.text), ["second-version-is-longer"], "the stale first version was never uploaded");
  assert.equal(status.healthy, true);
});

test("a same-size rewrite inside the same timestamp tick is still detected", async () => {
  const { mirror, fake, root } = await setup();
  const file = writeLocal(root, "data/counter.json", '{"n":1}');
  const tick = new Date();
  utimesSync(file, tick, tick);
  await mirror.syncToBlob();

  writeFileSync(file, '{"n":2}');
  utimesSync(file, tick, tick);
  await mirror.syncToBlob();

  assert.equal(fake.blobs.get("data/counter.json").toString(), '{"n":2}');
});

test("a failed upload never leaves another upload running behind it, and the other files still land", async () => {
  const { mirror, fake, root } = await setup();
  writeLocal(root, "data/a.json", "A");
  writeLocal(root, "data/b.json", "B");
  fake.failPuts((name) => (name === "data/a.json" ? 503 : null));
  const hold = fake.hold("PUT", "data/b.json");

  let finished = false;
  const pass = mirror.syncToBlob().then((status) => {
    finished = true;
    return status;
  });
  await hold.reached;
  await until(() => fake.stats.putAttempts === 2, "both uploads started");
  await turns(50);
  assert.equal(finished, false, "the pass waits for the held upload even though the other one already failed");
  hold.release();
  const status = await pass;

  assert.equal(status.healthy, false);
  assert.equal(status.lastError, "Blob storage request failed (HTTP 503)");
  assert.equal(fake.blobs.get("data/b.json").toString(), "B");
  assert.equal(fake.blobs.has("data/a.json"), false);
});

test("a remote copy restored mid-pass never overwrites a local write that landed while it downloaded", async () => {
  const { mirror, fake, root } = await setup({ hydrate: false });
  fake.blobs.set("data/r.json", Buffer.from("remote-old"));
  const hold = fake.hold("GET", "data/r.json");

  const pass = mirror.syncToBlob();
  await hold.reached;
  const file = writeLocal(root, "data/r.json", "local-newer-write");
  hold.release();
  await pass;

  assert.equal(readFileSync(file, "utf8"), "local-newer-write");
  assert.deepEqual(readdirSync(join(root, "data")).filter((name) => name.includes(".blob-tmp-")), []);
  await mirror.syncToBlob();
  assert.equal(fake.blobs.get("data/r.json").toString(), "local-newer-write", "the newer local write reaches Blob");
});

test("a file that comes back while a pass is running is not deleted from Blob", async () => {
  const { mirror, fake, root } = await setup();
  const a = writeLocal(root, "data/a.json", "A-content");
  writeLocal(root, "data/b.json", "B-v1");
  await mirror.syncToBlob();

  rmSync(a);
  writeLocal(root, "data/b.json", "B-v2-is-longer");
  const hold = fake.hold("PUT", "data/b.json");
  const pass = mirror.syncToBlob();
  await hold.reached;
  writeLocal(root, "data/a.json", "A-content");
  hold.release();
  await pass;

  assert.equal(fake.stats.deletes, 0);
  assert.equal(fake.blobs.has("data/a.json"), true);
});

// ── Failure handling ─────────────────────────────────────────────────────────

test("a failed pass retries on a bounded, doubling backoff and recovers on the next change", async () => {
  const { mirror, fake, clock, root } = await setup({ random: () => 1, envExtra: { BLOB_SYNC_RETRY_BASE_MS: "1000" } });
  writeLocal(root, "data/a.json", "payload");
  fake.failPuts(503);

  mirror.scheduleBlobSync();
  clock.advance(250);
  await settleAfter(mirror, fake, 1);
  assert.equal(mirror.getStatus().healthy, false);
  assert.equal(mirror.getStatus().lastError, "Blob storage request failed (HTTP 503)");

  const backoff = [1000, 2000, 4000, 8000, 16000];
  for (let attempt = 0; attempt < backoff.length; attempt += 1) {
    assert.equal(mirror.getStatus().retryScheduled, true, `retry ${attempt + 1} is scheduled`);
    clock.advance(backoff[attempt]);
    await settleAfter(mirror, fake, attempt + 2);
  }
  assert.deepEqual(clock.createdDelays(), [250, ...backoff], "delays double from the base");
  assert.equal(mirror.getStatus().retryScheduled, false, "gives up after five retries");
  assert.equal(clock.pendingCount(), 0);
  clock.advance(60 * 60 * 1000);
  await turns(20);
  assert.equal(fake.stats.putAttempts, 6, "no further attempts until the next change");

  // The next scheduled change starts over; a failing Blob never slows the scheduling call itself.
  fake.failPuts(null);
  const requestsBefore = fake.stats.requests;
  assert.equal(mirror.scheduleBlobSync(), undefined);
  assert.equal(fake.stats.requests, requestsBefore);
  clock.advance(250);
  await settleAfter(mirror, fake, 7);
  assert.equal(mirror.getStatus().healthy, true);
  assert.equal(mirror.getStatus().lastError, null);
  assert.equal(mirror.getStatus().retryAttempts, 0, "retry state resets on success");
  assert.equal(fake.blobs.get("data/a.json").toString(), "payload");
});

test("a retry that succeeds clears its backoff state, and the first delay carries jitter and defaults to two seconds", async () => {
  const jittered = await setup({ random: () => 0, envExtra: { BLOB_SYNC_RETRY_BASE_MS: "1000" } });
  writeLocal(jittered.root, "data/a.json", "payload");
  jittered.fake.failPuts(503);
  jittered.mirror.scheduleBlobSync();
  jittered.clock.advance(250);
  await settleAfter(jittered.mirror, jittered.fake, 1);
  assert.deepEqual(jittered.clock.createdDelays(), [250, 500], "half the backoff at the low end of the jitter");

  jittered.fake.failPuts(null);
  jittered.clock.advance(500);
  await settleAfter(jittered.mirror, jittered.fake, 2);
  assert.equal(jittered.mirror.getStatus().healthy, true);
  assert.equal(jittered.mirror.getStatus().retryScheduled, false);
  assert.equal(jittered.clock.pendingCount(), 0);

  const defaults = await setup({ random: () => 1 });
  writeLocal(defaults.root, "data/a.json", "payload");
  defaults.fake.failPuts(503);
  defaults.mirror.scheduleBlobSync();
  defaults.clock.advance(250);
  await settleAfter(defaults.mirror, defaults.fake, 1);
  assert.deepEqual(defaults.clock.createdDelays(), [250, 2000]);
});

test("a failed startup hydrate retries by itself and reconciles once Blob answers", async () => {
  const { mirror, fake, clock, root } = await setup({ hydrate: false, random: () => 1, envExtra: { BLOB_SYNC_RETRY_BASE_MS: "1000" } });
  fake.blobs.set("data/remote.json", Buffer.from("remote-state"));
  fake.failLists(403);

  const failed = await mirror.hydrateFromBlob();
  assert.equal(failed.hydrated, false);
  assert.equal(failed.retryScheduled, true);
  assert.deepEqual(clock.createdDelays(), [1000]);

  fake.failLists(null);
  clock.advance(1000);
  await until(() => mirror.getStatus().hydrated && settled(mirror), "the retry pass reconciled");
  assert.equal(readFileSync(join(root, "data", "remote.json"), "utf8"), "remote-state");
  assert.equal(mirror.getStatus().healthy, true);
  assert.equal(clock.pendingCount(), 0);
});

test("stop() clears the retry timer, and a pass that fails after stop() does not schedule one", async () => {
  const first = await setup({ random: () => 1 });
  writeLocal(first.root, "data/a.json", "payload");
  first.fake.failPuts(503);
  first.mirror.scheduleBlobSync();
  first.clock.advance(250);
  await settleAfter(first.mirror, first.fake, 1);
  assert.equal(first.clock.pendingCount(), 1);
  first.mirror.stop();
  assert.equal(first.clock.pendingCount(), 0);
  first.clock.advance(60 * 60 * 1000);
  await turns(20);
  assert.equal(first.fake.stats.putAttempts, 1);

  const second = await setup({ random: () => 1 });
  writeLocal(second.root, "data/a.json", "payload");
  second.fake.failPuts(503);
  const hold = second.fake.hold("PUT", "data/a.json");
  const pass = second.mirror.syncToBlob();
  await hold.reached;
  second.mirror.stop();
  hold.release();
  await pass;
  assert.equal(second.mirror.getStatus().retryScheduled, false);
  assert.equal(second.clock.pendingCount(), 0);
});

// ── Event loop ───────────────────────────────────────────────────────────────

test("a pass over hundreds of files keeps the event loop turning", async () => {
  const { mirror, fake, root } = await setup();
  for (let index = 0; index < 400; index += 1) {
    writeLocal(root, `generated-labs/lab-${index % 20}/file-${index}.md`, `# file ${index}\n`);
  }

  let ticks = 0;
  let probing = true;
  const probe = () => {
    if (!probing) return;
    ticks += 1;
    setImmediate(probe);
  };
  setImmediate(probe);

  const beforeUploadPass = ticks;
  await mirror.syncToBlob();
  const uploadPassTicks = ticks - beforeUploadPass;
  assert.equal(fake.puts.length, 400, "every file is still uploaded");
  assert.ok(fake.blobs.has("generated-labs/lab-3/file-23.md"), "blob names are unchanged");

  const beforeScanPass = ticks;
  await mirror.syncToBlob();
  const scanPassTicks = ticks - beforeScanPass;
  probing = false;

  assert.ok(uploadPassTicks > 20, `the upload pass yielded to the event loop (${uploadPassTicks} ticks)`);
  assert.ok(scanPassTicks > 20, `the scan-only pass yielded to the event loop (${scanPassTicks} ticks)`);
  assert.equal(fake.puts.length, 400, "an unchanged tree uploads nothing");
});

// ── Graceful shutdown ────────────────────────────────────────────────────────

test("shutdown flush cancels the timers, runs one final pass, and resolves", async () => {
  const { mirror, fake, clock, root } = await setup();
  writeLocal(root, "data/last-words.json", "{}");
  mirror.scheduleBlobSync();
  assert.equal(clock.pendingCount(), 1);

  const result = await mirror.flushBlobSyncForShutdown({ timeoutMs: 5000 });

  assert.equal(result.timedOut, false);
  assert.equal(result.healthy, true);
  assert.ok(fake.blobs.has("data/last-words.json"), "the pending change reached Blob");
  assert.equal(clock.pendingCount(), 0, "neither the debounce nor the shutdown timer is left behind");
  mirror.scheduleBlobSync();
  assert.equal(clock.pendingCount(), 0, "nothing is armed once shutting down");
});

test("shutdown flush picks up a change that lands during its own pass", async () => {
  const { mirror, fake, root } = await setup();
  writeLocal(root, "data/a.json", "A");
  const hold = fake.hold("PUT", "data/a.json");

  const flushing = mirror.flushBlobSyncForShutdown({ timeoutMs: 600000 });
  await hold.reached;
  writeLocal(root, "data/b.json", "B");
  mirror.scheduleBlobSync();
  hold.release();
  const result = await flushing;

  assert.equal(result.timedOut, false);
  assert.equal(fake.blobs.get("data/b.json")?.toString(), "B");
});

test("shutdown flush never waits past its timeout and never rejects", async () => {
  const hung = await setup();
  writeLocal(hung.root, "data/a.json", "A");
  const hold = hung.fake.hold("PUT", "data/a.json");
  const flushing = hung.mirror.flushBlobSyncForShutdown({ timeoutMs: 3000 });
  await hold.reached;
  hung.clock.advance(2999);
  await turns(10);
  hung.clock.advance(1);
  const timedOut = await flushing;
  assert.equal(timedOut.timedOut, true, "resolves when the Blob request never answers");
  hold.release();
  await until(() => settled(hung.mirror), "the abandoned pass finished");

  const failing = await setup();
  writeLocal(failing.root, "data/a.json", "A");
  failing.fake.failPuts(503);
  const failed = await failing.mirror.flushBlobSyncForShutdown({ timeoutMs: 5000 });
  assert.equal(failed.timedOut, false);
  assert.equal(failed.healthy, false);
  assert.equal(failing.clock.pendingCount(), 0, "no retry is scheduled while shutting down");

  const disabled = createBlobPersistence({
    env: { PORTAL_STORAGE_ROOT: hung.root },
    fetchImpl: () => assert.fail("a disabled mirror never calls Blob"),
  });
  assert.deepEqual(await disabled.flushBlobSyncForShutdown({ timeoutMs: 1000 }), { ...disabled.getStatus(), timedOut: false });
});

test("the process-wide flushBlobSyncForShutdown flushes the default mirror", async () => {
  const root = mkdtempSync(join(tmpdir(), "blob-sync-default-"));
  const fake = createFakeBlob();
  const clock = createFakeClock();
  cleanups.push(() => {
    getBlobPersistence()?.stop();
    registerBlobSyncStatusProvider(null);
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });
  await initBlobPersistence({
    env: { PORTAL_STORAGE_ROOT: root, AZURE_STORAGE_BLOB_ENDPOINT: FAKE_ENDPOINT },
    fetchImpl: fake.fetchImpl,
    tokenProvider: () => "test-token",
    timers: clock,
  });
  writeLocal(root, "data/process-wide.json", "{}");
  scheduleBlobSync();

  const result = await flushBlobSyncForShutdown({ timeoutMs: 5000 });

  assert.equal(result.timedOut, false);
  assert.ok(fake.blobs.has("data/process-wide.json"));
  assert.equal(clock.pendingCount(), 0);
});

// ── Temp files ───────────────────────────────────────────────────────────────

test("temp files and lock leftovers in the managed folders are never uploaded", async () => {
  const { mirror, fake, root } = await setup();
  writeLocal(root, "data/state.json", "{}");
  writeLocal(root, "screenshots/a.png", "png");
  writeLocal(root, "data/state.json.blob-tmp-123-abc", "half");
  writeLocal(root, "data/state.json.4242.tmp", "half");
  writeLocal(root, "data/state.json.4242.1700000000000.TMP", "half");
  writeLocal(root, "data/lock.blob-tmp-lock", "lock");
  writeLocal(root, "data/lock.blob-tmp-lock.stale-1-xyz", "lock");
  writeLocal(root, "data/old.json.stale-9-abc", "old");
  writeLocal(root, "screenshots/.blob-tmp-1-half-written/pictures/p.png", "half");
  writeLocal(root, "uploads/.portal-storage-probe-1", "probe");
  writeLocal(root, "uploads/logo.png.blob-tmp-9-zz", "half");

  await mirror.syncToBlob();
  await mirror.syncToBlob();

  assert.deepEqual([...fake.blobs.keys()].sort(), ["data/state.json", "screenshots/a.png"]);
});

test("a restore writes a unique temp file then renames it, and a failed restore leaves no temp file behind", async (t) => {
  const { mirror, fake, root } = await setup({ hydrate: false });
  fake.blobs.set("data/conflict.json", Buffer.from("remote-conflict"));
  fake.blobs.set("data/ok.json", Buffer.from("remote-ok"));
  const writes = [];
  const realWriteFile = fsPromises.writeFile;
  t.mock.method(fsPromises, "writeFile", (...args) => {
    writes.push(String(args[0]));
    return realWriteFile(...args);
  });

  // A folder squats on the target name, so the rename step fails.
  writeLocal(root, "data/conflict.json/keep.txt", "keep");
  const failed = await mirror.hydrateFromBlob();
  assert.equal(failed.hydrated, false);
  assert.equal(failed.healthy, false);
  assert.deepEqual(readdirSync(join(root, "data")).filter((name) => name.includes(".blob-tmp-")), [], "the temp file is cleaned up");
  assert.equal(readFileSync(join(root, "data", "conflict.json", "keep.txt"), "utf8"), "keep");

  rmSync(join(root, "data", "conflict.json"), { recursive: true });
  writes.length = 0;
  const restored = await mirror.hydrateFromBlob();
  assert.equal(restored.hydrated, true);
  assert.equal(readFileSync(join(root, "data", "conflict.json"), "utf8"), "remote-conflict");
  assert.equal(readFileSync(join(root, "data", "ok.json"), "utf8"), "remote-ok");
  assert.equal(writes.length, 2);
  for (const written of writes) assert.match(written, /\.blob-tmp-\d+-[0-9a-f-]{36}$/, "the bytes go to a unique temp name first");
  assert.notEqual(writes[0], writes[1]);
  assert.deepEqual(readdirSync(join(root, "data")).filter((name) => name.includes(".blob-tmp-")), []);
});
