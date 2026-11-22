/**
 * Capture platform under many hands at once: who owns a capture, which computer may take it, one capture per lab, who may stop
 * it, how many progress windows and uploads the portal holds open, and the library's slot lock across real processes.
 *
 * Hermetic: fake companions and browsers talk to the real routes over real HTTP, every folder is a throwaway, and no test sleeps to
 * "give something time". Where a test waits it waits for a stated condition (a counter, a stream ending) with a deadline.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import express from "express";

import { clientOwnerKey } from "../lib/concurrency/visitor.js";
import { generateLab } from "../lib/lab-builder/generator.js";
import { createJobStore } from "../lib/capture/jobs.js";
import { createStreamGate, createUploadGate } from "../lib/capture/limits.js";
import { acquireShareLock, withShareLockSync } from "../lib/capture/library-share.js";
import { cleanOwnerKey, mineFlag, ownerOf } from "../lib/capture/owner.js";
import { LIVE_RETENTION_MS, createPairingStore } from "../lib/capture/pairing.js";
import { registerCaptureRoutes } from "../lib/capture/routes.js";
import { makePng } from "../../tools/screenshot-capture/test/fixtures/png.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PORTAL_ROOT = resolve(here, "..");
const cleanups = [];
const ctx = {};

const ALICE = "contoso-alice-client-0000000";
const BOB = "fabrikam-bob-client-0000000";
const CAROL = "contoso-carol-client-000000";
const ALICE_KEY = clientOwnerKey(ALICE);
const BOB_KEY = clientOwnerKey(BOB);

function tmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Wait for a stated condition, checking often, and fail with `what` when it never holds. */
async function until(what, check, { timeoutMs = 8000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`Timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A promise that opens once, so several callers can start at the same moment. */
function barrier() {
  let open;
  const gate = new Promise((resolveGate) => {
    open = resolveGate;
  });
  return { gate, open };
}

async function api(base, method, path, { json, as, token, headers = {}, body, form } = {}) {
  const init = { method, headers: { ...headers } };
  if (as) init.headers["X-Client-Id"] = as;
  if (token) init.headers.Authorization = `Bearer ${token}`;
  if (json !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(json);
  } else if (body !== undefined) {
    init.body = body;
  } else if (form) {
    init.body = form;
  }
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: res.status, json: parsed, text, headers: res.headers };
}

/** No response may carry an owner key: not the field, and not the shape of one. */
function assertNoOwnerKey(text, what) {
  assert.ok(!/ownerKey/i.test(text), `${what} names an owner key`);
  assert.ok(!/\b[cu]-[a-f0-9]{32}\b/.test(text), `${what} carries an owner key`);
}

async function startApp({ env = {} } = {}) {
  const dataDir = mkdtempSync(join(ctx.root, "data-"));
  const app = express();
  app.set("env", "test");
  app.use(express.json({ limit: "64kb" }));
  const platform = registerCaptureRoutes(app, {
    generatedRoot: ctx.generatedRoot,
    dataDir,
    env: { PORTAL_STORAGE_ROOT: ctx.storageRoot, ...env },
    detectServerBrowser: async () => ({ available: false }),
  });
  const server = await new Promise((resolveServer) => {
    const s = app.listen(0, "127.0.0.1", () => resolveServer(s));
  });
  cleanups.push(() => {
    server.closeAllConnections?.();
    server.close();
  });
  return { platform, server, dataDir, base: `http://127.0.0.1:${server.address().port}` };
}

/** A computer paired from `as`'s browser (or from a caller nobody can tell apart), checked in, and able to ask for work. */
async function pairComputer(app, as, { name = "CONTOSO-PC", signedInProducts = ["copilot-studio"] } = {}) {
  const issued = await api(app.base, "POST", "/api/capture/pair", { as });
  assert.equal(issued.status, 201, issued.text);
  const paired = await api(app.base, "POST", "/api/capture/companion/pair", { json: { code: issued.json.code, deviceName: name, platform: "win32", companionVersion: "1.6.3" } });
  assert.equal(paired.status, 201, paired.text);
  const token = paired.json.token;
  const computer = {
    token,
    id: paired.json.device.id,
    heartbeat: (body = {}) => api(app.base, "POST", "/api/capture/companion/heartbeat", { token, json: { signedInProducts, ...body } }),
    next: () => api(app.base, "GET", "/api/capture/companion/next", { token }),
    progress: (jobId, body) => api(app.base, "POST", `/api/capture/companion/jobs/${jobId}/progress`, { token, json: body }),
    complete: (jobId, body = { message: "done" }) => api(app.base, "POST", `/api/capture/companion/jobs/${jobId}/complete`, { token, json: body }),
  };
  assert.equal((await computer.heartbeat()).status, 200);
  return computer;
}

const queueLab = (app, as, labId, extra = {}) => api(app.base, "POST", "/api/capture/jobs", { as, json: { target: { type: "lab", labId }, scope: { mode: "all", filenames: [], featureIds: [] }, ...extra } });
const otherTenant = { env: { CAPTURE_SHAREPOINT_SITE_URL: "https://fabrikam.sharepoint.com/sites/x" } };
const cancelJob = (app, as, jobId, json = {}) => api(app.base, "POST", `/api/capture/jobs/${jobId}/cancel`, { as, json });

/** Open a progress window the way a browser does, and keep hold of the socket so a test can close it. Resolves once the first bytes (or a refusal) arrive. */
function openStream(app, jobId, { as = null, cid = null } = {}) {
  return new Promise((resolveStream, reject) => {
    const query = cid ? `?cid=${cid}` : "";
    const req = http.get(`${app.base}/api/capture/jobs/${jobId}/events${query}`, { headers: as ? { "X-Client-Id": as } : {} }, (res) => {
      let text = "";
      let handedOver = false;
      res.setEncoding("utf8");
      const ended = new Promise((resolveEnd) => res.on("close", resolveEnd));
      const stream = { status: res.statusCode, headers: res.headers, read: () => text, ended, close: () => req.destroy() };
      res.on("data", (chunk) => {
        text += chunk;
        if (res.statusCode === 200 && !handedOver) {
          handedOver = true;
          resolveStream(stream);
        }
      });
      if (res.statusCode !== 200) res.on("end", () => resolveStream({ ...stream, text, json: JSON.parse(text || "null") }));
    });
    req.on("error", (err) => (err.code === "ECONNRESET" ? undefined : reject(err)));
  });
}

before(async () => {
  ctx.root = tmp("capture-concurrency-");
  ctx.storageRoot = join(ctx.root, "storage");
  ctx.generatedRoot = join(ctx.storageRoot, "generated-labs");
  ctx.libDir = join(ctx.storageRoot, "screenshots");
  mkdirSync(ctx.generatedRoot, { recursive: true });
  const emptyLabs = tmp("capture-concurrency-labs-");
  ctx.labs = [];
  for (let i = 0; i < 3; i += 1) {
    const build = await generateLab(
      { products: ["copilot-studio"], features: ["mc-memory"], harness: "microsoft-copilot", includeCore: false },
      { outputRoot: ctx.generatedRoot, labsDir: emptyLabs, useLearnMcp: false, useLlm: false },
    );
    const shots = JSON.parse(readFileSync(join(build.outputDir, "screenshots", "shots.json"), "utf8")).shots;
    ctx.labs.push({ labId: build.labId, labDir: build.outputDir, files: shots.map((s) => s.filename) });
  }
  assert.ok(ctx.labs[0].files.length >= 2, "the fixture lab needs two shots");
});

after(() => {
  for (const fn of cleanups.reverse()) {
    try {
      fn();
    } catch {
      /* best effort */
    }
  }
});

// ── Who owns a capture ───────────────────────────────────────────────────────

test("an owner is the signed-in person, else the browser's id (also from a stream's cid), else nobody, and only a hash is ever kept", () => {
  const request = (headers = {}, extra = {}) => ({ get: (name) => headers[name.toLowerCase()], headers, ...extra });
  const fromHeader = ownerOf(request({ "x-client-id": ALICE }));
  assert.equal(fromHeader, ALICE_KEY);
  assert.match(fromHeader, /^c-[a-f0-9]{32}$/);
  assert.ok(!fromHeader.includes(ALICE), "the id itself is never the key");
  assert.equal(ownerOf(request({}, { query: { cid: ALICE } })), ALICE_KEY, "a progress window cannot send headers, so its id travels in the address");
  assert.equal(ownerOf(request({ "x-client-id": "short" })), null, "an id of the wrong shape is no id");
  assert.equal(ownerOf(request()), null, "nobody to tell apart: the call stays permissive");

  const signedIn = ownerOf(request({ "x-client-id": ALICE }, { user: { tid: "00000000-0000-0000-0000-000000000000", oid: "00000000-0000-0000-0000-0000000000a1" } }));
  assert.match(signedIn, /^u-[a-f0-9]{32}$/);
  assert.notEqual(signedIn, ALICE_KEY, "a signed-in person wins over a browser id");
  assert.equal(ownerOf(request({}, { user: { upn: "alex@contoso.example" } })), ownerOf(request({}, { user: { upn: "ALEX@contoso.example" } })), "the same person, however the name is cased");

  assert.equal(cleanOwnerKey("not-a-key"), null);
  assert.equal(cleanOwnerKey(ALICE_KEY), ALICE_KEY);
  assert.equal(mineFlag(ALICE_KEY, ALICE_KEY), true);
  assert.equal(mineFlag(ALICE_KEY, BOB_KEY), false);
  assert.equal(mineFlag(null, BOB_KEY), null);
  assert.equal(mineFlag(ALICE_KEY, undefined), null);
});

test("pairing keeps the owner on the code and the computer, never shows it, and files written before owners existed still work", () => {
  const dir = tmp("pairing-owner-");
  const store = createPairingStore({ dir });
  const alicePc = store.exchangeCode(store.createCode({ ownerKey: ALICE_KEY }).code, { deviceName: "CONTOSO-PC" });
  const bobPc = store.exchangeCode(store.createCode({ ownerKey: BOB_KEY }).code, { deviceName: "FABRIKAM-PC" });
  const stored = JSON.parse(readFileSync(join(dir, "devices.json"), "utf8"));
  assert.deepEqual(stored.devices.map((d) => d.ownerKey), [ALICE_KEY, BOB_KEY], "the owner is saved with the computer");
  assert.ok(!JSON.stringify(alicePc.device).includes(ALICE_KEY), "the computer a browser is shown has no owner key");
  assert.equal(store.authenticate(alicePc.token).ownerKey, ALICE_KEY, "the portal itself can still read it back for matching jobs");
  assert.ok(!JSON.stringify(store.status({ ownerKey: ALICE_KEY })).includes(ALICE_KEY));

  assert.deepEqual(store.listDevices({ ownerKey: ALICE_KEY }).map((d) => d.id), [alicePc.device.id], "a person sees their own computers");
  assert.equal(store.listDevices().length, 2, "a caller nobody can tell apart sees them all");
  assert.equal(store.status({ ownerKey: BOB_KEY }).connectedCount, 0);
  assert.equal(store.revokeDevice(alicePc.device.id, { ownerKey: BOB_KEY }), false, "nobody disconnects a computer another person paired");
  assert.equal(store.authenticate(alicePc.token).ok, true);
  assert.equal(store.revokeDevice(alicePc.device.id, { ownerKey: ALICE_KEY }), true);
  assert.equal(bobPc.ok, true);

  // A file from before this change: no owner on the code or the computer.
  const oldDir = tmp("pairing-old-");
  const old = createPairingStore({ dir: oldDir });
  const code = old.createCode({ createdBy: "someone@contoso.example" });
  const file = join(oldDir, "devices.json");
  const state = JSON.parse(readFileSync(file, "utf8"));
  for (const entry of state.codes) delete entry.ownerKey;
  writeFileSync(file, JSON.stringify(state));
  const legacy = old.exchangeCode(code.code, { deviceName: "OLD-PC" });
  assert.equal(legacy.ok, true);
  const legacyState = JSON.parse(readFileSync(file, "utf8"));
  delete legacyState.devices[0].ownerKey;
  writeFileSync(file, JSON.stringify(legacyState));
  assert.equal(old.authenticate(legacy.token).ok, true);
  assert.equal(old.authenticate(legacy.token).ownerKey, null);
  assert.equal(old.listDevices({ ownerKey: BOB_KEY }).length, 1, "a computer paired before owners existed works for everyone");
});

test("a computer takes only its own person's captures (and ownerless ones); a computer paired before owners existed takes any", async () => {
  const app = await startApp();
  const alicePc = await pairComputer(app, ALICE, { name: "CONTOSO-PC" });
  const bobPc = await pairComputer(app, BOB, { name: "FABRIKAM-PC" });
  const [labA, labB, labC] = ctx.labs;

  const aliceJob = await queueLab(app, ALICE, labA.labId);
  assert.equal(aliceJob.status, 201, aliceJob.text);
  assert.equal(aliceJob.json.job.mine, true);
  assertNoOwnerKey(aliceJob.text, "the queue response");
  assert.equal((await bobPc.next()).status, 204, "another person's computer is never handed this capture");
  const claimed = await alicePc.next();
  assert.equal(claimed.status, 200, claimed.text);
  assert.equal(claimed.json.job.id, aliceJob.json.job.id);
  assertNoOwnerKey(claimed.text, "the job a computer is handed");
  assert.equal((await alicePc.complete(aliceJob.json.job.id)).status, 200);

  // A capture with no owner (a caller nobody can tell apart) can be taken by anyone's computer.
  const ownerless = await queueLab(app, null, labB.labId);
  assert.equal(ownerless.status, 201);
  assert.equal(ownerless.json.job.mine, null);
  assert.equal((await bobPc.next()).json.job.id, ownerless.json.job.id);
  assert.equal((await bobPc.complete(ownerless.json.job.id)).status, 200);

  // A computer paired before owners existed has no owner and takes any capture.
  const legacyPc = await pairComputer(app, null, { name: "LEGACY-PC" });
  const bobJob = await queueLab(app, BOB, labC.labId);
  assert.equal(bobJob.status, 201);
  assert.equal((await alicePc.next()).status, 204);
  assert.equal((await legacyPc.next()).json.job.id, bobJob.json.job.id);
  assert.equal((await legacyPc.complete(bobJob.json.job.id)).status, 200);

  // A job file written before owners existed (no ownerKey at all) is read, shown, and taken like an ownerless one.
  const jobs = createJobStore({ dir: join(app.dataDir, "capture-old") });
  const spec = { target: { type: "lab", labId: "contoso-lab" }, scope: { mode: "all", filenames: [], featureIds: [] }, options: {}, plan: { shots: [{ filename: "a.png", steps: [] }] } };
  const created = jobs.create(spec);
  const file = join(app.dataDir, "capture-old", "jobs", `${created.id}.json`);
  const saved = JSON.parse(readFileSync(file, "utf8"));
  delete saved.ownerKey;
  writeFileSync(file, JSON.stringify(saved));
  assert.equal(jobs.get(created.id, { viewerOwnerKey: ALICE_KEY }).mine, null);
  assert.equal(jobs.claimNext({ id: "dev_bbbbbbbbbbbb", name: "PC", ownerKey: BOB_KEY }).job.id, created.id);
});

test("two or three computers asking at the same moment never both get the same capture", async () => {
  const app = await startApp();
  const first = await pairComputer(app, ALICE, { name: "CONTOSO-PC-1" });
  const second = await pairComputer(app, ALICE, { name: "CONTOSO-PC-2" });
  const stranger = await pairComputer(app, BOB, { name: "FABRIKAM-PC" });
  const { labId } = ctx.labs[0];

  for (let round = 0; round < 5; round += 1) {
    const queued = await queueLab(app, ALICE, labId);
    assert.equal(queued.status, 201, queued.text);
    const { gate, open } = barrier();
    const asks = [first, second, stranger].map((computer) => gate.then(() => computer.next()));
    open();
    const [a, b, c] = await Promise.all(asks);
    assert.deepEqual([a.status, b.status].sort(), [200, 204], `round ${round}: exactly one of the two computers got the capture`);
    assert.equal(c.status, 204, "and the other person's computer got nothing");
    const winner = a.status === 200 ? first : second;
    const job = (await api(app.base, "GET", `/api/capture/jobs/${queued.json.job.id}`)).json.job;
    assert.equal(job.claim.deviceId, winner.id);
    assert.equal(job.events.filter((e) => e.type === "claimed").length, 1, "it was claimed once");
    assert.equal((await winner.complete(queued.json.job.id)).status, 200);
  }
});

// ── One capture per lab ──────────────────────────────────────────────────────

test("a lab runs one capture at a time: the same request returns it, any other is a plain 409, and other labs are not held up", async () => {
  const app = await startApp();
  const [labA, labB] = ctx.labs;
  const first = await queueLab(app, ALICE, labA.labId);
  assert.equal(first.status, 201, first.text);

  const again = await queueLab(app, ALICE, labA.labId);
  assert.equal(again.status, 200);
  assert.equal(again.json.existing, true, "the same request by the same person returns the capture that is already there");
  assert.equal(again.json.job.id, first.json.job.id);

  const differentScope = await queueLab(app, ALICE, labA.labId, { scope: { mode: "missing", filenames: [], featureIds: [] } });
  assert.equal(differentScope.status, 409, differentScope.text);
  assert.deepEqual(differentScope.json, {
    error: "This lab already has a capture in progress. Wait for it to finish or cancel it first.",
    code: "lab-busy",
    existingJobId: first.json.job.id,
    busyBy: "you",
  });
  assert.equal((await queueLab(app, ALICE, labA.labId, otherTenant)).status, 409, "other addresses do not make it another capture");
  assert.equal((await queueLab(app, ALICE, labA.labId, { options: { retake: true } })).status, 409, "neither do other options");

  const someoneElse = await queueLab(app, BOB, labA.labId);
  assert.equal(someoneElse.status, 409);
  assert.deepEqual(someoneElse.json, {
    error: "Another person is capturing this lab right now. Try again when they finish.",
    code: "lab-busy",
    existingJobId: first.json.job.id,
    busyBy: "someone-else",
  });
  assert.equal((await queueLab(app, BOB, labA.labId, otherTenant)).json.busyBy, "someone-else");
  const callerWithoutId = await queueLab(app, null, labA.labId, otherTenant);
  assert.equal(callerWithoutId.status, 409);
  assert.equal(callerWithoutId.json.busyBy, "you", "when the portal cannot tell the callers apart it does not say someone else");

  const otherLab = await queueLab(app, BOB, labB.labId);
  assert.equal(otherLab.status, 201, "another lab is not held up");

  assert.equal((await cancelJob(app, ALICE, first.json.job.id)).status, 200);
  const after = await queueLab(app, BOB, labA.labId);
  assert.equal(after.status, 201, "once the capture is over the lab is free again");
  assert.equal(after.json.job.mine, true);
  await cancelJob(app, BOB, after.json.job.id);
  await cancelJob(app, BOB, otherLab.json.job.id);
});

test("an equivalent capture by someone else is not handed over as if it were yours", async () => {
  const app = await startApp();
  const { labId } = ctx.labs[0];
  const mine = await queueLab(app, ALICE, labId, otherTenant);
  assert.equal(mine.status, 201);
  const theirs = await queueLab(app, BOB, labId, otherTenant);
  assert.equal(theirs.status, 409, "the very same request from another person is busy, not 'existing'");
  assert.equal(theirs.json.busyBy, "someone-else");
  assert.equal(theirs.json.job, undefined, "and it shows no job as theirs");
  await cancelJob(app, ALICE, mine.json.job.id);
});

test("two people asking for the same lab at the same moment get one capture and one plain refusal", async () => {
  const app = await startApp();
  const { labId } = ctx.labs[1];
  const { gate, open } = barrier();
  const asks = [ALICE, BOB].map((as) => gate.then(() => queueLab(app, as, labId)));
  open();
  const results = await Promise.all(asks);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  const refused = results.find((r) => r.status === 409);
  assert.equal(refused.json.busyBy, "someone-else");
  assert.equal(refused.json.existingJobId, results.find((r) => r.status === 201).json.job.id);
  assert.equal((await api(app.base, "GET", `/api/capture/jobs?labId=${labId}`)).json.jobs.length, 1, "only one capture was queued");
  assert.equal((await cancelJob(app, null, refused.json.existingJobId)).status, 200);
});

test("a capture of the shared library is not held to one per lab", async () => {
  const app = await startApp();
  const library = (scope) => api(app.base, "POST", "/api/capture/jobs", { as: ALICE, json: { target: { type: "library", products: ["copilot-studio"] }, scope: { mode: scope }, targets: { copilotStudioAgentUrl: "https://copilotstudio.microsoft.com/environments/Default-00000000-0000-0000-0000-000000000001/bots/00000000-0000-0000-0000-0000000000a1/overview" } } });
  const all = await library("all");
  const missing = await library("missing");
  assert.equal(all.status, 201, all.text);
  assert.equal(missing.status, 201, missing.text);
  assert.equal((await library("all")).json.existing, true, "the same library capture still returns the one that is there");
  for (const job of [all, missing]) await cancelJob(app, ALICE, job.json.job.id);
});

// ── Who may see it and who may stop it ───────────────────────────────────────

test("a capture says whether it is yours, only its owner can stop it, and no response carries the owner key", async () => {
  const app = await startApp();
  const alicePc = await pairComputer(app, ALICE);
  const { labId } = ctx.labs[0];
  const queued = await queueLab(app, ALICE, labId);
  const id = queued.json.job.id;

  const view = async (as, path) => (await api(app.base, "GET", path, { as })).json;
  assert.equal((await view(ALICE, `/api/capture/jobs/${id}`)).job.mine, true);
  assert.equal((await view(BOB, `/api/capture/jobs/${id}`)).job.mine, false);
  assert.equal((await view(null, `/api/capture/jobs/${id}`)).job.mine, null, "a caller with no id has nothing to compare");
  assert.equal((await view(BOB, `/api/capture/jobs?labId=${labId}`)).jobs[0].mine, false);
  assert.equal((await view(ALICE, `/api/capture/jobs?labId=${labId}`)).jobs[0].mine, true);
  for (const [as, path] of [[BOB, `/api/capture/jobs/${id}`], [BOB, `/api/capture/jobs?labId=${labId}`], [null, "/api/capture/jobs"], [BOB, "/api/capture/status"], [BOB, "/api/capture/devices"]]) {
    assertNoOwnerKey((await api(app.base, "GET", path, { as })).text, path);
  }

  const refused = await cancelJob(app, BOB, id);
  assert.equal(refused.status, 403);
  assert.equal(refused.json.error, "This capture was started by someone else, so only they can stop it.");
  assert.equal((await cancelJob(app, BOB, id, { pause: true })).status, 403, "pausing is stopping too");
  assert.equal((await view(ALICE, `/api/capture/jobs/${id}`)).job.status, "queued", "it was left as it was");

  // Once it runs, the same rule holds, and the owner's stop is honored between shots.
  assert.equal((await alicePc.next()).status, 200);
  assert.equal((await cancelJob(app, BOB, id)).status, 403);
  const stopped = await cancelJob(app, ALICE, id);
  assert.equal(stopped.status, 200);
  assert.equal(stopped.json.job.cancelRequested, true);
  assert.equal((await alicePc.complete(id)).status, 200);
  assert.equal((await cancelJob(app, BOB, id)).status, 409, "a finished capture just says it has finished");

  // A caller nobody can tell apart keeps the permissive behavior it always had.
  const next = await queueLab(app, ALICE, labId);
  assert.equal((await cancelJob(app, null, next.json.job.id)).status, 200);
});

test("a lab's progress is its own: lists filtered by lab and what is said about one lab never carry another lab's captures", async () => {
  const app = await startApp();
  const bobPc = await pairComputer(app, BOB, { signedInProducts: [] });
  await pairComputer(app, ALICE);
  const [labA, labB] = ctx.labs;
  const forA = await queueLab(app, ALICE, labA.labId);
  const forB = await queueLab(app, BOB, labB.labId);

  const claimedB = (await bobPc.next()).json;
  assert.equal(claimedB.job.id, forB.json.job.id);
  const [firstShot] = claimedB.shots;
  assert.equal((await bobPc.progress(claimedB.job.id, { shot: { filename: firstShot.filename, status: "running" }, message: "Bob's lab only" })).status, 200);

  const listA = (await api(app.base, "GET", `/api/capture/jobs?labId=${labA.labId}`, { as: ALICE })).json.jobs;
  assert.deepEqual(listA.map((j) => j.id), [forA.json.job.id]);
  assert.ok(listA.every((j) => j.target.labId === labA.labId));
  assert.equal(listA[0].progress.running, 0, "lab B's shot in progress is not lab A's");
  const listB = (await api(app.base, "GET", `/api/capture/jobs?labId=${labB.labId}`, { as: ALICE })).json.jobs;
  assert.deepEqual(listB.map((j) => j.id), [forB.json.job.id]);
  assert.equal(listB[0].progress.running, 1);
  const detailA = (await api(app.base, "GET", `/api/capture/jobs/${forA.json.job.id}`, { as: ALICE })).json.job;
  assert.ok(!JSON.stringify(detailA).includes(forB.json.job.id), "lab A's job says nothing about lab B's");
  assert.ok(detailA.shots.every((s) => s.status === "pending"));
  assert.ok(!JSON.stringify(detailA).includes("Bob's lab only"), "nor does it carry what was said about lab B's shot");

  // What a person is told to do about signing in is about their own captures, not another person's.
  for (const shot of claimedB.shots) await bobPc.progress(claimedB.job.id, { shot: { filename: shot.filename, status: "auth-required", error: "Sign in" } });
  assert.equal((await bobPc.complete(claimedB.job.id)).status, 200);
  const bobStatus = (await api(app.base, "GET", "/api/capture/status", { as: BOB })).json;
  assert.equal(bobStatus.jobs.needsSignIn?.jobId, claimedB.job.id);
  const aliceStatus = (await api(app.base, "GET", "/api/capture/status", { as: ALICE })).json;
  assert.equal(aliceStatus.jobs.needsSignIn, undefined, "another person's sign-in need, and their shot count, are not shown");
  await cancelJob(app, ALICE, forA.json.job.id);
});

test("a computer paired by someone else is not shown, not counted as connected, not asked to open a sign-in window, and not disconnected", async () => {
  const app = await startApp();
  const alicePc = await pairComputer(app, ALICE, { name: "CONTOSO-PC" });
  const status = (as) => api(app.base, "GET", "/api/capture/status", { as }).then((r) => r.json);
  assert.equal((await status(ALICE)).companion.connected, true);
  assert.equal((await status(CAROL)).companion.connected, false, "another person's computer does not make this person look connected");
  assert.equal((await status(null)).companion.connected, true, "a caller nobody can tell apart sees every computer");
  assert.deepEqual((await api(app.base, "GET", "/api/capture/devices", { as: CAROL })).json.devices, []);
  assert.equal((await api(app.base, "GET", "/api/capture/devices", { as: ALICE })).json.devices.length, 1);

  const setup = await api(app.base, "POST", "/api/capture/account-setup", { as: CAROL, json: { product: "copilot-studio" } });
  assert.equal(setup.status, 409);
  assert.equal(setup.json.code, "no-companion", "a sign-in window never opens on someone else's computer");
  assert.equal((await api(app.base, "POST", "/api/capture/account-setup", { as: ALICE, json: { product: "copilot-studio" } })).status, 202);

  const queued = await queueLab(app, CAROL, ctx.labs[2].labId);
  assert.equal(queued.status, 201);
  assert.equal(queued.json.companion.connected, false, "queued, but she is told no computer of hers is connected");
  await cancelJob(app, CAROL, queued.json.job.id);

  assert.equal((await api(app.base, "DELETE", `/api/capture/devices/${alicePc.id}`, { as: CAROL })).status, 404);
  assert.equal((await alicePc.heartbeat()).status, 200, "still connected");
  assert.equal((await api(app.base, "DELETE", `/api/capture/devices/${alicePc.id}`, { as: ALICE })).status, 200);
});

// ── Rate limits are per visitor, not per address ─────────────────────────────

test("rate limits count each browser on its own, and one address that rotates ids still has a ceiling", async () => {
  const app = await startApp({ env: { CAPTURE_PAIR_RATE_MAX: "2", CAPTURE_IP_RATE_MULTIPLIER: "2" } });
  const pair = (as) => api(app.base, "POST", "/api/capture/pair", { as });
  assert.deepEqual([(await pair(null)).status, (await pair(null)).status], [201, 201]);
  const noId = await pair(null);
  assert.equal(noId.status, 429, "callers with no id still share the address's own bucket");
  assert.ok(Number(noId.headers.get("retry-after")) >= 1);

  assert.deepEqual([(await pair(ALICE)).status, (await pair(ALICE)).status], [201, 201]);
  assert.equal((await pair(ALICE)).status, 429, "a third code in the window is refused");
  assert.deepEqual([(await pair(BOB)).status, (await pair(BOB)).status], [201, 201], "another browser on the same address has its own allowance");
  const rotated = await pair(CAROL);
  assert.equal(rotated.status, 429, "but one address cannot make new ids forever: the address has a ceiling too");
  assert.match(rotated.json.error, /Too many pairing codes requested\. Try again in \d+s\./);
});

// ── Open progress windows ────────────────────────────────────────────────────

test("the stream gate counts each window once, however it ends", () => {
  const gate = createStreamGate({ max: 3, perVisitorMax: 2 });
  const a1 = gate.tryOpen("visitor-a");
  const a2 = gate.tryOpen("visitor-a");
  assert.equal(gate.tryOpen("visitor-a"), null, "a visitor's own limit");
  const b1 = gate.tryOpen("visitor-b");
  assert.equal(gate.tryOpen("visitor-c"), null, "the portal's limit");
  assert.deepEqual(gate.snapshot(), { open: 3, visitors: 2, max: 3, perVisitorMax: 2 });
  assert.equal(a1(), true);
  assert.equal(a1(), false, "a second release of the same window changes nothing");
  assert.equal(gate.snapshot().open, 2);
  assert.equal(gate.openFor("visitor-a"), 1);
  a2();
  b1();
  assert.deepEqual(gate.snapshot(), { open: 0, visitors: 0, max: 3, perVisitorMax: 2 });
  assert.equal(typeof gate.tryOpen("visitor-a"), "function");
});

test("progress windows are capped for the portal and for each visitor, and every way one ends gives its place back exactly once", async () => {
  const app = await startApp({ env: { CAPTURE_SSE_MAX: "3", CAPTURE_SSE_PER_VISITOR_MAX: "2" } });
  const alicePc = await pairComputer(app, ALICE);
  const { platform } = app;
  const queued = await queueLab(app, ALICE, ctx.labs[0].labId);
  const id = queued.json.job.id;
  const open = () => platform.sse.snapshot().open;

  const a1 = await openStream(app, id, { as: ALICE });
  const a2 = await openStream(app, id, { cid: ALICE });
  assert.equal(a1.status, 200);
  assert.equal(a2.status, 200, "a progress window cannot send headers, so its id in the address counts as the same visitor");
  assert.equal(open(), 2);
  assert.match(a1.read(), /event: snapshot/);
  assert.match(a1.read(), /"mine":true/);
  assertNoOwnerKey(a1.read(), "the progress window");

  const tooMany = await openStream(app, id, { as: ALICE });
  assert.equal(tooMany.status, 429);
  assert.equal(tooMany.json.error, "Too many progress windows are open. Close one and try again.");
  assert.ok(Number(tooMany.headers["retry-after"]) >= 1);
  assert.equal(open(), 2, "a refused window is never counted");

  const b1 = await openStream(app, id, { as: BOB });
  assert.equal(b1.status, 200, "another visitor is not held up by Alice's limit");
  assert.match(b1.read(), /"mine":false/);
  assert.equal(open(), 3);
  assert.equal((await openStream(app, id, { as: CAROL })).status, 429, "the portal's own limit holds for everyone");
  assert.equal(platform.jobs.subscriberCount(id), 3);

  // The person closes a window: the place comes back, once.
  a1.close();
  await until("the closed window to give its place back", () => open() === 2);
  assert.equal(platform.sse.openFor(ALICE_KEY), 1);
  assert.equal(platform.jobs.subscriberCount(id), 2, "and its listener is removed");
  const again = await openStream(app, id, { as: ALICE });
  assert.equal(again.status, 200);
  assert.equal(open(), 3);

  // The capture ends: every window is told, closes, and gives its place back.
  assert.equal((await alicePc.next()).status, 200);
  assert.equal((await cancelJob(app, ALICE, id)).status, 200);
  assert.equal((await alicePc.complete(id)).status, 200);
  await Promise.all([a2, b1, again].map((stream) => stream.ended));
  for (const stream of [a2, b1, again]) assert.match(stream.read(), /event: end/);
  assert.deepEqual(platform.sse.snapshot(), { open: 0, visitors: 0, max: 3, perVisitorMax: 2 });
  assert.equal(platform.jobs.subscriberCount(), 0, "no listener is left behind");

  // A window opened on a finished capture is answered and closed at once, and counted back.
  const late = await openStream(app, id, { as: ALICE });
  assert.equal(late.status, 200);
  await late.ended;
  assert.match(late.read(), /event: end/);
  assert.equal(platform.sse.snapshot().open, 0);
});

test("a window left open to the time limit ends, and gives its place back once", async () => {
  const app = await startApp({ env: { CAPTURE_SSE_MAX_MS: "150" } });
  const queued = await queueLab(app, ALICE, ctx.labs[1].labId);
  const stream = await openStream(app, queued.json.job.id, { as: ALICE });
  assert.equal(stream.status, 200);
  assert.equal(app.platform.sse.snapshot().open, 1);
  await stream.ended;
  assert.equal(app.platform.sse.snapshot().open, 0);
  assert.equal(app.platform.jobs.subscriberCount(), 0);
  await cancelJob(app, ALICE, queued.json.job.id);
});

// ── Uploads in flight ────────────────────────────────────────────────────────

test("the upload gate gives places out in turn, lets a waiter go when one frees, and turns the rest away after a bounded wait", async () => {
  const gate = createUploadGate({ max: 1, waitMs: 60, maxWaiting: 1 });
  const first = gate.acquire();
  const release = await first.ready;
  assert.equal(typeof release, "function");
  const waiter = gate.acquire();
  assert.equal(gate.snapshot().waiting, 1);
  assert.equal(await gate.acquire().ready, null, "more waiters than the queue holds are turned away at once");
  assert.equal(await waiter.ready, null, "a waiter that is not served in time is told so");
  assert.equal(gate.snapshot().waiting, 0);

  const patient = createUploadGate({ max: 1, waitMs: 5000 });
  const held = await patient.acquire().ready;
  const next = patient.acquire();
  held();
  held();
  const given = await next.ready;
  assert.equal(typeof given, "function");
  assert.equal(patient.snapshot().active, 1, "releasing twice never frees a place that is not free");
  const leaver = patient.acquire();
  leaver.cancel();
  assert.equal(await leaver.ready, null, "a client that left while waiting never takes a place");
  given();
  assert.deepEqual([patient.snapshot().active, patient.snapshot().waiting], [0, 0]);
});

/** Start a picture upload and stop after `head` bytes, so the portal is left reading the body. */
function startUpload(app, filename, bytes, { as = ALICE, head = 1000 } = {}) {
  const req = http.request(`${app.base}/api/capture/library/screenshots/${encodeURIComponent(filename)}`, { method: "PUT", headers: { "Content-Type": "image/png", "Content-Length": String(bytes.length), "X-Client-Id": as } });
  const done = new Promise((resolveDone) => {
    req.on("response", (res) => {
      let text = "";
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => resolveDone({ status: res.statusCode, text }));
    });
    req.on("error", () => resolveDone({ status: 0, text: "" }));
  });
  req.write(bytes.subarray(0, head));
  return { done, finish: () => req.end(bytes.subarray(head)), abort: () => req.destroy() };
}

test("only a few pictures are read at once: the others wait a short while, then get a plain 503, and a place comes back on every path", async () => {
  const app = await startApp({ env: { CAPTURE_UPLOAD_CONCURRENCY: "1", CAPTURE_UPLOAD_WAIT_MS: "250" } });
  const [{ files }] = ctx.labs;
  const picture = (seed) => makePng({ mode: "ui", seed });
  const upload = (seed) => api(app.base, "PUT", `/api/capture/library/screenshots/${encodeURIComponent(files[0])}`, { as: BOB, body: picture(seed), headers: { "Content-Type": "image/png" } });
  const uploads = () => app.platform.uploads.snapshot();

  const slow = startUpload(app, files[0], picture(1));
  await until("the first upload to hold the only place", () => uploads().active === 1);
  const turnedAway = await upload(2);
  assert.equal(turnedAway.status, 503);
  assert.equal(turnedAway.json.error, "The portal is receiving several pictures right now. Try again in a few seconds.");
  assert.ok(Number(turnedAway.headers.get("retry-after")) >= 1);
  assert.equal(uploads().waiting, 0, "the one that gave up is no longer waiting");

  // The client leaves in the middle of its upload: the place comes back.
  slow.abort();
  await until("the abandoned upload to give its place back", () => uploads().active === 0);
  const ok = await upload(3);
  assert.ok([200, 202].includes(ok.status), ok.text);
  assert.equal(uploads().active, 0, "and a finished upload gives its place back");
});

test("an upload that has to wait is served as soon as the place before it frees", async () => {
  const app = await startApp({ env: { CAPTURE_UPLOAD_CONCURRENCY: "1", CAPTURE_UPLOAD_WAIT_MS: "20000" } });
  const [{ files }] = ctx.labs;
  const bytes = makePng({ mode: "ui", seed: 5 });
  const uploads = () => app.platform.uploads.snapshot();

  const first = startUpload(app, files[0], bytes);
  await until("the first upload to hold the only place", () => uploads().active === 1);
  const second = api(app.base, "PUT", `/api/capture/library/screenshots/${encodeURIComponent(files[1] || files[0])}`, { as: BOB, body: makePng({ mode: "ui", seed: 6 }), headers: { "Content-Type": "image/png" } });
  await until("the second upload to be waiting", () => uploads().waiting === 1);
  first.finish();
  const [firstResult, secondResult] = await Promise.all([first.done, second]);
  assert.ok([200, 202].includes(firstResult.status), firstResult.text);
  assert.ok([200, 202].includes(secondResult.status), secondResult.text);
  assert.deepEqual([uploads().active, uploads().waiting], [0, 0]);
});

// ── One writer per picture, across processes ─────────────────────────────────

test("a slot lock is released only by its holder: a lock taken over after a crash is never removed by the one that stalled", () => {
  const dir = tmp("share-lock-");
  const lockFile = join(dir, "slot.png.blob-tmp-share-lock");
  const stalled = acquireShareLock(dir, "slot.png");
  assert.equal(typeof stalled, "function");
  assert.ok(JSON.parse(readFileSync(lockFile, "utf8")).token, "the lock names its holder");
  assert.equal(acquireShareLock(dir, "slot.png"), null, "one writer at a time");

  const longAgo = new Date(Date.now() - 5 * 60 * 1000);
  utimesSync(lockFile, longAgo, longAgo);
  const taker = acquireShareLock(dir, "slot.png");
  assert.equal(typeof taker, "function", "a lock left by a crashed run is taken over");
  stalled();
  assert.ok(existsSync(lockFile), "the stalled holder woke up and must not remove a lock that is not its own");
  assert.equal(acquireShareLock(dir, "slot.png"), null, "the new holder still has it");
  taker();
  assert.equal(existsSync(lockFile), false);
  stalled();
  assert.equal(existsSync(lockFile), false);
  assert.deepEqual(readdirSync(dir), [], "no leftovers");

  // A lock that is not stale is never taken, however many ask.
  const held = acquireShareLock(dir, "slot.png");
  for (let i = 0; i < 5; i += 1) assert.equal(acquireShareLock(dir, "slot.png"), null);
  held();
});

test("a write that must happen waits for the lock, runs once it has it, and says plainly when it never gets it", () => {
  const dir = tmp("share-lock-wait-");
  const held = acquireShareLock(dir, "slot.png");
  assert.throws(() => withShareLockSync(dir, "slot.png", () => assert.fail("must not run"), { timeoutMs: 60 }), (err) => err.code === "LOCK_TIMEOUT" && err.status === 503 && /Try again in a moment/.test(err.message));
  held();
  assert.equal(withShareLockSync(dir, "slot.png", () => "written"), "written");
  assert.throws(() => withShareLockSync(dir, "slot.png", () => { throw new Error("boom"); }), /boom/);
  assert.equal(typeof acquireShareLock(dir, "slot.png"), "function", "the lock is released even when the work fails");
});

function runChild(script, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, CHILD_ARGS: JSON.stringify(args) }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolveRun(out) : reject(new Error(`child failed (${code}): ${err.slice(-500)}`))));
  });
}

test("three processes changing one picture's counter under the slot lock lose no update", async () => {
  const dir = tmp("share-lock-counter-");
  const file = join(dir, "counter.txt");
  writeFileSync(file, "0");
  const libraryShare = pathToFileURL(join(PORTAL_ROOT, "lib", "capture", "library-share.js")).href;
  const atomic = pathToFileURL(join(PORTAL_ROOT, "lib", "concurrency", "atomic-file.js")).href;
  const script = `
    import fs from "node:fs";
    import { withShareLockSync } from ${JSON.stringify(libraryShare)};
    import { sleepSync } from ${JSON.stringify(atomic)};
    const args = JSON.parse(process.env.CHILD_ARGS);
    while (Date.now() < args.startAt) {}
    for (let i = 0; i < args.count; i += 1) {
      withShareLockSync(args.dir, "counter.txt", () => {
        const value = Number(fs.readFileSync(args.file, "utf8"));
        sleepSync(1);
        fs.writeFileSync(args.file, String(value + 1));
      }, { timeoutMs: 30000 });
    }
    process.stdout.write("done", () => process.exit(0));
  `;
  const startAt = Date.now() + 2500;
  await Promise.all([17, 17, 16].map((count) => runChild(script, { dir, file, count, startAt })));
  assert.equal(readFileSync(file, "utf8"), "50", "50 increments, 50 counted");
  assert.deepEqual(readdirSync(dir).sort(), ["counter.txt"], "and no lock file is left behind");
});

test("three processes promoting different verified pictures into the same shared slots leave whole pictures and one record each, none lost", async () => {
  rmSync(ctx.libDir, { recursive: true, force: true });
  const dataDir = mkdtempSync(join(ctx.root, "multi-data-"));
  const captureDir = join(dataDir, "capture");
  const pictures = [];
  for (let i = 0; i < 12; i += 1) {
    const file = join(ctx.root, `picture-${i}.png`);
    writeFileSync(file, makePng({ mode: "ui", seed: 300 + i }));
    pictures.push(file);
  }
  const files = ctx.labs[0].files.slice(0, 2);
  const store = pathToFileURL(join(PORTAL_ROOT, "lib", "capture", "screenshot-store.js")).href;
  const script = `
    import fs from "node:fs";
    import { createScreenshotStore } from ${JSON.stringify(store)};
    const args = JSON.parse(process.env.CHILD_ARGS);
    const store = createScreenshotStore({ generatedRoot: args.generatedRoot, captureDir: args.captureDir, capturedDirs: () => ({ primary: args.libDir, search: [args.libDir] }) });
    const target = store.lab(args.labId);
    const outcomes = [];
    while (Date.now() < args.startAt) {}
    for (let round = 0; round < args.rounds; round += 1) {
      const filename = args.files[(args.index + round) % args.files.length];
      const slot = target.slot(filename);
      const evidence = { finalUrl: "https://copilotstudio.microsoft.com/environments/00000000-0000-0000-0000-000000000000/bots", title: "Copilot Studio", visibleText: [...slot.expectedLabels, "Settings"], redaction: { applied: true, masked: 1 }, capturedAt: new Date().toISOString(), executedSteps: 3 };
      const bytes = fs.readFileSync(args.pictures[args.index * args.rounds + round]);
      const result = store.submit(target, filename, bytes, { evidence, source: "companion", defer: true, requireEvidence: true, requireRedaction: true, retake: true });
      outcomes.push(result.body.library?.outcome ?? result.body.outcome);
    }
    process.stdout.write(JSON.stringify(outcomes), () => process.exit(0));
  `;
  const rounds = 4;
  const startAt = Date.now() + 3000;
  const outcomes = (
    await Promise.all(ctx.labs.map((lab, index) => runChild(script, { generatedRoot: ctx.generatedRoot, captureDir, libDir: ctx.libDir, labId: lab.labId, files, index, rounds, pictures, startAt })))
  ).map((out) => JSON.parse(out));
  const all = outcomes.flat();
  assert.equal(all.length, 12);
  assert.ok(all.every((o) => ["shared", "replaced", "skipped", "already-shared"].includes(o)), JSON.stringify(all));
  assert.ok(all.some((o) => o === "shared" || o === "replaced"), "somebody got a picture in");

  const records = JSON.parse(readFileSync(join(captureDir, "library-verification.json"), "utf8"));
  const inputs = pictures.map((p) => sha(readFileSync(p)));
  let written = 0;
  for (const filename of files) {
    const slotFile = join(ctx.libDir, filename);
    if (!existsSync(slotFile)) continue;
    written += 1;
    const bytes = readFileSync(slotFile);
    assert.ok(inputs.includes(sha(bytes)), `${filename} is one of the pictures, whole`);
    assert.equal(records.shots[filename]?.sha256, sha(bytes), `${filename} has a record, and it describes exactly this picture`);
    assert.equal(records.shots[filename].state, "accepted");
    const previous = `${slotFile}.previous`;
    if (existsSync(previous)) assert.ok(inputs.includes(sha(readFileSync(previous))), "an earlier picture is kept whole");
  }
  assert.equal(written, files.length, "every slot somebody wrote has its picture");
  assert.deepEqual(Object.keys(records.shots).sort(), files.filter((f) => existsSync(join(ctx.libDir, f))).sort(), "and no record was lost to another process's write");
  assert.deepEqual(readdirSync(ctx.libDir).filter((name) => name.includes(".blob-tmp-")), [], "no lock or half-written file is left");
  assert.deepEqual(readdirSync(captureDir).filter((name) => name.includes(".blob-tmp-")), [], "nor beside the records");
});

test("three processes writing different slots' checks into the library's one records file lose none", async () => {
  const dataDir = mkdtempSync(join(ctx.root, "records-data-"));
  const captureDir = join(dataDir, "capture");
  const store = pathToFileURL(join(PORTAL_ROOT, "lib", "capture", "screenshot-store.js")).href;
  const atomic = pathToFileURL(join(PORTAL_ROOT, "lib", "concurrency", "atomic-file.js")).href;
  const script = `
    import { createScreenshotStore } from ${JSON.stringify(store)};
    import { sleepSync } from ${JSON.stringify(atomic)};
    const args = JSON.parse(process.env.CHILD_ARGS);
    const library = createScreenshotStore({ generatedRoot: args.generatedRoot, captureDir: args.captureDir, capturedDirs: () => ({ primary: args.libDir, search: [args.libDir] }) }).library();
    while (Date.now() < args.startAt) {}
    for (let n = 0; n < args.count; n += 1) {
      library.writeRecord(\`slot-\${args.index}-\${n}.png\`, { state: "accepted", sha256: \`\${args.index}-\${n}\` });
      sleepSync(5);
    }
    process.stdout.write("done", () => process.exit(0));
  `;
  const startAt = Date.now() + 3000;
  const count = 12;
  await Promise.all([0, 1, 2].map((index) => runChild(script, { generatedRoot: ctx.generatedRoot, captureDir, libDir: ctx.libDir, index, count, startAt })));
  const records = JSON.parse(readFileSync(join(captureDir, "library-verification.json"), "utf8"));
  assert.equal(Object.keys(records.shots).length, 3 * count, "every process's every record is there");
  for (let index = 0; index < 3; index += 1) for (let n = 0; n < count; n += 1) assert.equal(records.shots[`slot-${index}-${n}.png`]?.sha256, `${index}-${n}`);
  assert.deepEqual(readdirSync(captureDir).filter((name) => name.includes(".blob-tmp-")), [], "and no lock or half-written file is left");
});

// ── Memory ───────────────────────────────────────────────────────────────────

test("computers not seen for a day are dropped from memory, every map stays bounded, and a disconnected computer leaves nothing behind", () => {
  let clock = Date.UTC(2026, 0, 1);
  const store = createPairingStore({ dir: tmp("pairing-memory-"), now: () => clock });
  const pair = (name) => store.exchangeCode(store.createCode({ ownerKey: ALICE_KEY }).code, { deviceName: name }).device.id;
  const [one, two, three] = [pair("CONTOSO-PC-1"), pair("CONTOSO-PC-2"), pair("CONTOSO-PC-3")];
  for (const id of [one, two, three]) store.heartbeat(id, { signedInProducts: ["copilot-studio"] });
  store.queueCommand(one, { type: "setup-account", product: "copilot-studio" });
  assert.deepEqual(store.memoryStats(), { live: 3, persistedSeen: 3, commands: 1 });

  clock += LIVE_RETENTION_MS + 60 * 1000;
  const four = pair("CONTOSO-PC-4");
  store.heartbeat(four, {});
  assert.deepEqual(store.memoryStats(), { live: 1, persistedSeen: 1, commands: 0 }, "the three that went quiet, and the request nobody took, are forgotten");
  assert.equal(store.listDevices().length, 4, "their saved records stay, so they are seen again when they come back");
  store.heartbeat(one, {});
  assert.equal(store.memoryStats().live, 2);

  assert.equal(store.hasPendingCommands("dev_nobody0000"), false);
  assert.equal(store.memoryStats().commands, 0, "asking about a computer with no request does not remember it");
  store.queueCommand(four, { type: "setup-account", product: "copilot-studio" });
  assert.equal(store.revokeDevice(four), true);
  assert.deepEqual(store.memoryStats(), { live: 1, persistedSeen: 1, commands: 0 }, "a disconnected computer leaves nothing in any map");

  const crowded = createPairingStore({ dir: tmp("pairing-cap-"), now: () => clock });
  for (let i = 0; i < 600; i += 1) crowded.heartbeat(`dev_${String(i).padStart(12, "0")}`, {});
  assert.equal(crowded.memoryStats().live, 600);
  clock += 6 * 60 * 1000;
  crowded.heartbeat("dev_ffffffffffff", {});
  assert.ok(crowded.memoryStats().live <= 500, `capped, now ${crowded.memoryStats().live}`);
});
