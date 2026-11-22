import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readJsonOr, tempPathFor, writeFileAtomic, writeJsonAtomic } from "../lib/concurrency/atomic-file.js";
import { createKeyedMutex } from "../lib/concurrency/keyed-mutex.js";
import { LockTimeoutError, lockPathFor, withFileLock, withFileLockSync } from "../lib/concurrency/file-lock.js";
import { BuildQueueError, createBuildQueue, isTicket } from "../lib/concurrency/build-queue.js";
import { callerAddress, clientOwnerKey, createVisitorCheck, normalizeAddress, readClientId, visitorKey } from "../lib/concurrency/visitor.js";
import { createWorkerPool } from "../lib/concurrency/worker-pool.js";
import { createRateLimiter } from "../lib/rate-limit.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const TEST_WORKER = new URL("./concurrency/test-worker.mjs", import.meta.url);
const dirs = [];
const tmp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lb-primitives-"));
  dirs.push(dir);
  return dir;
};
process.on("exit", () => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const tick = () => new Promise((resolve) => setImmediate(resolve));
const fakeReq = (headers = {}, extra = {}) => ({ headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])), method: "GET", ip: "198.51.100.7", socket: { remoteAddress: "127.0.0.1" }, ...extra });

// ── Atomic files, mutex, and locks ──────────────────────────────────────────

test("atomic writes use a name nobody else can pick, so many writers never collide and nothing is left behind", async () => {
  const dir = tmp();
  const file = path.join(dir, "store.json");
  assert.notEqual(tempPathFor(file), tempPathFor(file));
  assert.match(tempPathFor(file), /\.blob-tmp-\d+-[0-9a-f-]{36}$/);
  await Promise.all(Array.from({ length: 60 }, (_, i) => Promise.resolve().then(() => writeJsonAtomic(file, { writer: i, padding: "x".repeat(2000) }))));
  const parsed = readJsonOr(file);
  assert.ok(parsed && Number.isInteger(parsed.writer), "the file is whole JSON from exactly one writer");
  assert.deepEqual(readdirSync(dir), ["store.json"], "no temp file is left behind");
  writeFileAtomic(path.join(dir, "bytes.bin"), Buffer.from([1, 2, 3]));
  assert.deepEqual([...readFileSync(path.join(dir, "bytes.bin"))], [1, 2, 3]);
});

test("a keyed mutex runs the same key in order, lets other keys run at once, and survives a failure", async () => {
  const mutex = createKeyedMutex();
  const order = [];
  const gate = Promise.withResolvers();
  const first = mutex.run("a", async () => {
    order.push("a1 start");
    await gate.promise;
    order.push("a1 end");
  });
  const second = mutex.run("a", async () => {
    order.push("a2");
  });
  const other = mutex.run("b", async () => {
    order.push("b");
  });
  await other;
  await tick();
  assert.deepEqual(order, ["a1 start", "b"], "key b did not wait for key a, and a2 waited for a1");
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["a1 start", "b", "a1 end", "a2"]);

  await assert.rejects(mutex.run("a", async () => {
    throw new Error("boom");
  }));
  assert.equal(await mutex.run("a", async () => "still works"), "still works");
  await tick();
  assert.equal(mutex.size(), 0, "idle keys are forgotten");
});

test("a file lock serializes holders, is only released by its owner, and takes over a stale lock", async () => {
  const dir = tmp();
  const lock = lockPathFor(path.join(dir, "data.json"));
  const events = [];
  const gate = Promise.withResolvers();
  const holder = withFileLock(lock, async () => {
    events.push("holder in");
    await gate.promise;
    events.push("holder out");
  });
  await tick();
  const waiter = withFileLock(lock, async () => {
    events.push("waiter in");
  }, { retryMs: 5 });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(events, ["holder in"], "the second caller waits while the first holds the lock");
  gate.resolve();
  await Promise.all([holder, waiter]);
  assert.deepEqual(events, ["holder in", "holder out", "waiter in"]);
  assert.equal(existsSync(lock), false, "released locks leave no file");

  // A lock that was taken over is not removed by its old owner.
  await withFileLock(lock, async () => {
    rmSyncQuiet(lock);
    writeFileSync(lock, JSON.stringify({ token: "someone-else", pid: 1, at: Date.now() }));
  });
  assert.equal(existsSync(lock), true, "the old owner did not remove a lock that now belongs to someone else");
  assert.throws(() => withFileLockSync(lock, () => {}, { timeoutMs: 60, retryMs: 5 }), LockTimeoutError);
  // Once it is older than staleMs it is a crashed run's lock and is taken over.
  assert.equal(withFileLockSync(lock, () => "took over", { timeoutMs: 500, retryMs: 5, staleMs: 0 }), "took over");
});

function rmSyncQuiet(file) {
  try {
    rmSync(file, { force: true });
  } catch {
    /* already gone */
  }
}

test("50 increments split across two processes lose none, and the file always parses", async () => {
  const dir = tmp();
  const file = path.join(dir, "counter.json");
  writeFileSync(file, JSON.stringify({ count: 0 }));
  const script = path.join(here, "concurrency", "increment-child.mjs");
  const run = () =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, file, "25"], { stdio: ["ignore", "pipe", "pipe"] });
      let err = "";
      child.stderr.on("data", (c) => (err += c));
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`child exited ${code}: ${err}`))));
    });
  await Promise.all([run(), run()]);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).count, 50);
  assert.deepEqual(readdirSync(dir).filter((n) => n !== "counter.json"), [], "no temp or lock files remain");
});

// ── The build queue ─────────────────────────────────────────────────────────

test("the build queue runs a few builds at once and starts the rest in the order they asked", async () => {
  const queue = createBuildQueue({ concurrency: 2, maxPerOwner: 5, waitTimeoutMs: 0 });
  const started = [];
  const turns = ["a", "b", "c", "d"].map((name, i) => queue.enter({ owner: `owner-${i}`, ticket: `ticket-${name}-0000` }).then((turn) => {
    started.push(name);
    return turn;
  }));
  const [a, b] = await Promise.all([turns[0], turns[1]]);
  await tick();
  assert.deepEqual(started, ["a", "b"], "only two run at once");
  assert.deepEqual(queue.status("ticket-c-0000"), { running: 2, waiting: 2, concurrency: 2, state: "queued", position: 1, ahead: 0 });
  assert.equal(queue.status("ticket-d-0000").position, 2);
  assert.equal(queue.status("ticket-a-0000").state, "running");
  b.release();
  const c = await turns[2];
  await tick();
  assert.deepEqual(started, ["a", "b", "c"], "c starts when a place frees up, ahead of d");
  c.release();
  a.release();
  const d = await turns[3];
  d.release();
  d.release();
  assert.equal(queue.snapshot().running, 0, "releasing twice is harmless");
  assert.equal(queue.status("ticket-d-0000").state, "finished");
  assert.equal(queue.status("never-asked-0000").state, "unknown");
});

test("one person cannot hold more than their share, and a full line turns people away with plain words", async () => {
  const queue = createBuildQueue({ concurrency: 1, maxPerOwner: 2, maxWaiting: 2, waitTimeoutMs: 0 });
  const first = await queue.enter({ owner: "ann" });
  const second = queue.enter({ owner: "ann" });
  await assert.rejects(queue.enter({ owner: "ann" }), (err) => err instanceof BuildQueueError && err.code === "owner-limit" && err.status === 429 && /already have 2 labs/.test(err.message));
  const other = queue.enter({ owner: "ben" });
  await assert.rejects(queue.enter({ owner: "cy" }), (err) => err.code === "queue-full" && err.status === 503 && /Try again in a few minutes/.test(err.message));
  first.release();
  (await second).release();
  (await other).release();
  assert.equal(queue.snapshot().waiting, 0);
});

test("leaving the line (cancel) lets the next build start, and waiting too long ends with a clear message", async () => {
  const queue = createBuildQueue({ concurrency: 1, maxPerOwner: 3, waitTimeoutMs: 0 });
  const running = await queue.enter({ owner: "ann" });
  const controller = new AbortController();
  const cancelled = queue.enter({ owner: "ben", ticket: "ticket-ben-0001", signal: controller.signal });
  const next = queue.enter({ owner: "cy", ticket: "ticket-cy-00001" });
  assert.equal(queue.status("ticket-cy-00001").position, 2);
  controller.abort();
  await assert.rejects(cancelled, (err) => err.code === "cancelled");
  assert.equal(queue.status("ticket-cy-00001").position, 1, "the person behind moves up");
  running.release();
  (await next).release();

  const impatient = createBuildQueue({ concurrency: 1, maxPerOwner: 3, waitTimeoutMs: 25 });
  const held = await impatient.enter({ owner: "ann" });
  await assert.rejects(impatient.enter({ owner: "ben" }), (err) => err.code === "timeout" && err.status === 503 && /stayed busy for too long/.test(err.message));
  held.release();
  assert.equal(impatient.snapshot().waiting, 0, "the timed-out request left the line");

  assert.equal(isTicket("short"), false);
  assert.equal(isTicket("a-valid_ticket-123"), true);
  const dup = createBuildQueue({ concurrency: 1, waitTimeoutMs: 0 });
  const live = await dup.enter({ owner: "x", ticket: "ticket-same-0001" });
  await assert.rejects(dup.enter({ owner: "y", ticket: "ticket-same-0001" }), (err) => err.code === "duplicate-ticket");
  live.release();
});

// ── Who is calling ──────────────────────────────────────────────────────────

test("a browser id is checked by shape, hashed for use as a key, and an address is normalized", () => {
  const id = "AbCdEfGhIjKlMnOpQrStUv";
  assert.equal(readClientId(fakeReq({ "X-Client-Id": id })), id);
  for (const bad of ["short", "has spaces in it 123456789", "../../etc/passwd-aaaaaaaaaa", "x".repeat(65), ""]) assert.equal(readClientId(fakeReq({ "X-Client-Id": bad })), null, bad);
  assert.equal(readClientId(fakeReq({}, { method: "GET", query: { cid: id } })), id, "a progress stream cannot send headers, so a GET may carry the id in the address");
  assert.equal(readClientId(fakeReq({}, { method: "POST", query: { cid: id } })), null, "a write never takes its identity from the address");

  const owner = clientOwnerKey(id);
  assert.match(owner, /^c-[0-9a-f]{32}$/);
  assert.ok(!owner.includes(id.toLowerCase()) && !owner.includes(id), "the id never appears in the key");
  assert.equal(owner, clientOwnerKey(id));
  assert.notEqual(owner, clientOwnerKey(`${id}x`));

  assert.equal(normalizeAddress("203.0.113.9:51234"), "203.0.113.9");
  assert.equal(normalizeAddress("[2001:db8::1]:443"), "2001:db8::1");
  assert.equal(normalizeAddress("::ffff:203.0.113.9"), "203.0.113.9");
  assert.equal(callerAddress({ ip: "203.0.113.9:51234" }), "203.0.113.9");
  assert.equal(callerAddress({}), "unknown");
});

test("every visitor has their own bucket even when they all arrive from one address, and one address cannot flood by rotating ids", () => {
  let t = 1_000_000;
  const now = () => t;
  const visitor = createRateLimiter({ windowMs: 60_000, max: 2, now });
  const address = createRateLimiter({ windowMs: 60_000, max: 6, now });
  const check = createVisitorCheck(visitor, address);
  const person = (n) => fakeReq({ "x-client-id": `person${String(n).padStart(20, "0")}` }, { ip: "203.0.113.9" });

  // Two people behind one address: each gets their own two.
  assert.equal(check(person(1)).allowed, true);
  assert.equal(check(person(1)).allowed, true);
  const refused = check(person(1));
  assert.equal(refused.allowed, false);
  assert.ok(refused.retryAfterSec > 0);
  assert.equal(check(person(2)).allowed, true, "another person is not throttled by the first");
  assert.equal(check(person(2)).allowed, true);
  // The shared address allows 6 in all: 4 are used, two more people are let in, and the next is stopped by the address.
  assert.equal(check(person(3)).allowed, true);
  assert.equal(check(person(4)).allowed, true);
  assert.equal(check(person(5)).allowed, false, "the address backstop stops a flood that rotates ids");
  t += 61_000;
  assert.equal(check(person(1)).allowed, true, "windows expire");

  // Without an id the address is the visitor; a signed-in person is keyed by their identity, not their address.
  assert.equal(visitorKey(fakeReq({}, { ip: "203.0.113.9:7777" })), "ip:203.0.113.9");
  assert.match(visitorKey(fakeReq({}, { user: { oid: "oid-ann", tid: "tenant-contoso" } })), /^u:tenant-contoso:oid-ann$/);
  assert.notEqual(visitorKey(person(1)), visitorKey(person(2)));
});

// ── Worker pool ─────────────────────────────────────────────────────────────

test("the worker pool runs tasks off the main thread in order, reports a task's own failure plainly, and survives a crash", async (t) => {
  const pool = createWorkerPool({ file: TEST_WORKER, size: 1, timeoutMs: 5000, idleMs: 0 });
  t.after(() => pool.close());
  assert.deepEqual(await Promise.all([pool.run("echo", [1]), pool.run("echo", [2]), pool.run("echo", [3])]), [1, 2, 3]);
  assert.deepEqual(await pool.run("echo", [{ nested: [Buffer.from("hi")] }]).then((r) => r.nested[0] instanceof Uint8Array), true);
  await assert.rejects(pool.run("fail"), (err) => err.status === 422 && err.code === "nope" && err.message === "That did not work.");
  await assert.rejects(pool.run("crash"), (err) => err.code === "worker-crashed");
  assert.equal(await pool.run("echo", ["after the crash"]), "after the crash", "a replacement worker answers the next task");
  assert.ok(pool.snapshot().restarted >= 1);
});

test("a task that never answers is stopped by the timeout and the next task still runs", async (t) => {
  const pool = createWorkerPool({ file: TEST_WORKER, size: 1, timeoutMs: 60, idleMs: 0 });
  t.after(() => pool.close());
  const stuck = pool.run("hang");
  const next = pool.run("echo", ["ok"]);
  await assert.rejects(stuck, (err) => err.code === "timeout" && err.status === 504 && /took too long/.test(err.message));
  assert.equal(await next, "ok");
  assert.equal(pool.snapshot().timedOut, 1);
});

test("a full pool line turns new work away, and an idle worker stops to give its memory back", async (t) => {
  const pool = createWorkerPool({ file: TEST_WORKER, size: 1, timeoutMs: 5000, maxQueued: 1, idleMs: 20 });
  t.after(() => pool.close());
  const a = pool.run("echo", ["a"]);
  const b = pool.run("echo", ["b"]);
  await assert.rejects(pool.run("echo", ["c"]), (err) => err.code === "queue-full" && err.status === 503);
  assert.deepEqual(await Promise.all([a, b]), ["a", "b"]);
  const deadline = Date.now() + 3000;
  while (pool.snapshot().workers > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(pool.snapshot().workers, 0, "the idle worker was retired");
  assert.equal(await pool.run("echo", ["again"]), "again", "and a new one starts on demand");
});
