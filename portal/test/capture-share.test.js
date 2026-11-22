/**
 * "Capture once, reuse everywhere": a good lab capture also goes into the shared screenshot library, the library is never
 * overwritten silently, a person can mark a picture as accurate, and a lab's existing pictures can be shared in bulk.
 *
 * Everything runs against throwaway folders with fake data. The library folder is `${storage}/screenshots`, the same
 * persistent folder the portal mirrors to Azure Blob.
 */

import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import express from "express";

import { createBlobPersistence } from "../lib/blob-persistence.js";
import { capturedImage } from "../lib/lab-builder/captured.js";
import { generateLab } from "../lib/lab-builder/generator.js";
import { getLabScreenshotsStatus } from "../lib/lab-builder/lab-screenshots.js";
import { PLACEHOLDER_PATH } from "../lib/lab-builder/slots.js";
import { createCapturePlatform } from "../lib/capture/index.js";
import { acquireShareLock, replacementVerdict, sha256Hex, shareVerdict } from "../lib/capture/library-share.js";
import { buildLabJobPlan } from "../lib/capture/plan.js";
import { registerCaptureRoutes } from "../lib/capture/routes.js";
import { createScreenshotStore } from "../lib/capture/screenshot-store.js";
import { makePng } from "../../tools/screenshot-capture/test/fixtures/png.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PORTAL_ROOT = resolve(here, "..");
const REPO_ROOT = resolve(PORTAL_ROOT, "..");
const cleanups = [];
const ctx = {};

function tmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function newLab(root = ctx.generatedRoot) {
  const build = await generateLab(
    { products: ["copilot-studio"], features: ["mc-memory"], harness: "microsoft-copilot", includeCore: false },
    { outputRoot: root, labsDir: ctx.emptyLabs, useLearnMcp: false, useLlm: false },
  );
  const shots = JSON.parse(readFileSync(join(build.outputDir, "screenshots", "shots.json"), "utf8")).shots;
  return { labId: build.labId, labDir: build.outputDir, shots, files: shots.map((s) => s.filename) };
}

async function call(method, path, { json, token, form } = {}) {
  const init = { method, headers: {} };
  if (token) init.headers.Authorization = `Bearer ${token}`;
  if (json !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(json);
  } else if (form) {
    init.body = form;
  }
  const res = await fetch(`${ctx.base}${path}`, init);
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: res.status, json: parsed, text };
}

/** The address a correct screenshot of this shot would be taken at, from what the job's plan expects. */
function addressFor(shot) {
  const expect = shot.capture?.expect;
  if (expect?.family === "copilot-studio") {
    const base = "https://copilotstudio.microsoft.com/environments/00000000-0000-0000-0000-000000000000";
    return expect.scope === "agent" ? `${base}/bots/00000000-0000-0000-0000-000000000001/${expect.paths[0]}` : `${base}/${expect.paths[0]}`;
  }
  return "https://copilotstudio.microsoft.com/environments/00000000-0000-0000-0000-000000000000/bots";
}

/** What a companion reports for a good capture: masked account details, an address that is not a sign-in page, the expected labels. */
function evidenceFor(target, filename, { redaction = { applied: true, masked: 2 } } = {}) {
  const slot = target.slot(filename);
  return {
    version: 2,
    finalUrl: "https://copilotstudio.microsoft.com/environments/00000000-0000-0000-0000-000000000000/bots",
    title: "Copilot Studio",
    visibleText: [...(slot.expectedLabels || []), "Settings"],
    ...(redaction ? { redaction } : {}),
    capturedAt: new Date().toISOString(),
    executedSteps: 4,
  };
}

/** A capture the way the companion uploads one (deferred refresh, masking required) unless the options say otherwise. */
function capture(labId, filename, { seed = 1, bytes, retake = false, source = "companion", acceptWarnings = false, requireRedaction = true, redaction, store = ctx.store } = {}) {
  const target = store.lab(labId);
  const png = bytes ?? makePng({ mode: "ui", seed });
  const evidence = evidenceFor(target, filename, redaction === undefined ? {} : { redaction });
  const result = store.submit(target, filename, png, { evidence, source, defer: true, requireEvidence: true, requireRedaction, retake, acceptWarnings });
  return { ...result, bytes: png };
}

const libraryFile = (filename) => join(ctx.libDir, filename);
const libraryRecords = () => JSON.parse(readFileSync(join(ctx.dataDir, "capture", "library-verification.json"), "utf8"));
const status = (labId) => getLabScreenshotsStatus(ctx.generatedRoot, labId, { capturedDir: [ctx.libDir] }).body;
const row = (labId, filename) => status(labId).shots.find((s) => s.filename === filename);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

before(async () => {
  ctx.root = tmp("capture-share-");
  ctx.storageRoot = join(ctx.root, "storage");
  ctx.generatedRoot = join(ctx.storageRoot, "generated-labs");
  ctx.dataDir = join(ctx.storageRoot, "data");
  ctx.libDir = join(ctx.storageRoot, "screenshots");
  ctx.emptyLabs = tmp("capture-share-empty-labs-");
  ctx.syncs = 0;

  const app = express();
  app.use(express.json({ limit: "64kb" }));
  const platform = registerCaptureRoutes(app, {
    generatedRoot: ctx.generatedRoot,
    dataDir: ctx.dataDir,
    env: { PORTAL_STORAGE_ROOT: ctx.storageRoot },
    scheduleBlobSync: () => {
      ctx.syncs += 1;
    },
    detectServerBrowser: async () => ({ available: false }),
  });
  ctx.platform = platform;
  ctx.store = platform.screenshots;
  ctx.server = await new Promise((resolveServer) => {
    const s = app.listen(0, "127.0.0.1", () => resolveServer(s));
  });
  ctx.base = `http://127.0.0.1:${ctx.server.address().port}`;
});

after(() => {
  ctx.server?.close();
  for (const fn of cleanups.reverse()) {
    try {
      fn();
    } catch {
      /* best effort */
    }
  }
});

// Every test starts with an empty shared library, and a counter for the Azure Blob write-through.
beforeEach(() => {
  rmSync(ctx.libDir, { recursive: true, force: true });
  rmSync(join(ctx.dataDir, "capture", "library-verification.json"), { force: true });
  ctx.syncs = 0;
});

// ── Promotion ────────────────────────────────────────────────────────────────

test("a verified capture of a shared slot also goes into the shared library, and the next lab finds it already captured", async () => {
  const first = await newLab();
  const second = await newLab();
  const [filename] = first.files;

  const result = capture(first.labId, filename, { seed: 11 });
  assert.equal(result.status, 200);
  assert.equal(result.body.library.outcome, "shared");
  assert.deepEqual(readFileSync(libraryFile(filename)), result.bytes, "the same bytes, under the same file name");
  const record = libraryRecords().shots[filename];
  assert.equal(record.state, "accepted");
  assert.equal(record.sha256, sha(result.bytes));
  assert.equal(record.redaction.applied, true);
  assert.ok(ctx.syncs >= 1, "the Azure Blob write-through is asked for after the library changed");

  // A lab built before the capture now shows the library's picture, says so, and gives the date.
  const reused = row(second.labId, filename);
  assert.equal(reused.captured, true);
  assert.equal(reused.capturedInLab, false);
  assert.equal(reused.imageSource, "library");
  assert.ok(Number.isFinite(Date.parse(reused.imageCapturedAt)));
  assert.deepEqual(reused.share, { state: "shared", libraryConfirmed: false });
  const own = row(first.labId, filename);
  assert.equal(own.imageSource, "lab", "the lab that took it owns its picture");
  assert.deepEqual(own.share, { state: "shared", libraryConfirmed: false }, "and it is the same picture the library has");

  // The job plan skips what resolves from the library, so only the missing shots are queued by default.
  const plan = buildLabJobPlan({ generatedRoot: ctx.generatedRoot, labId: second.labId, scope: { mode: "missing", filenames: [], featureIds: [] }, capturedDir: [ctx.libDir] });
  assert.deepEqual(plan.shots.map((s) => s.filename), second.files.filter((f) => f !== filename));
  const queued = await call("POST", "/api/capture/jobs", { json: { target: { type: "lab", labId: second.labId }, scope: "missing", targets: { copilotStudioAgentName: "Contoso Support Agent" } } });
  assert.equal(queued.status, 201, queued.text);
  assert.deepEqual(queued.json.job.shots.map((s) => s.filename), second.files.filter((f) => f !== filename));
  assert.equal((await call("POST", `/api/capture/jobs/${queued.json.job.id}/cancel`)).status, 200, "the job is not left waiting for another test's companion");
  const library = ctx.store.libraryState();
  assert.equal(library.shots.find((s) => s.filename === filename).captured, true);
  assert.ok(library.shots.find((s) => s.filename === filename).capturedAt);
});

test("when every shot of a new lab is already in the library, nothing is queued, and a lab built later reuses it", async () => {
  const origin = await newLab();
  for (const [index, filename] of origin.files.entries()) assert.equal(capture(origin.labId, filename, { seed: 20 + index }).body.library.outcome, "shared");

  const waiting = await newLab();
  // Built after the pictures were shared: the generator copies them from the library.
  process.env.FEATURE_TOUR_SCREENSHOTS_DIR = ctx.libDir;
  let later;
  try {
    later = await newLab();
  } finally {
    delete process.env.FEATURE_TOUR_SCREENSHOTS_DIR;
  }
  for (const lab of [waiting, later]) {
    const nothing = await call("POST", "/api/capture/jobs", { json: { target: { type: "lab", labId: lab.labId }, scope: "missing" } });
    assert.equal(nothing.status, 200);
    assert.equal(nothing.json.nothingToCapture, true, "every selected screenshot already exists");
    assert.equal(status(lab.labId).summary.missing, 0);
  }
  assert.equal(status(waiting.labId).shots.every((s) => s.imageSource === "library" && s.captured), true);
  assert.equal(capturedImage(join(later.labDir, "assets"), origin.files[0]) !== null, true, "the lab built later holds a copy of the shared picture");
});

test("a picture a person accepts after a warning stays in its lab until they choose to share it", async () => {
  const lab = await newLab();
  const [filename] = lab.files;
  const staged = capture(lab.labId, filename, { bytes: makePng({ mode: "mostly", seed: 5 }) });
  assert.equal(staged.status, 202, "a warning is staged, not committed");
  assert.equal(existsSync(libraryFile(filename)), false, "a picture waiting for review is never shared");

  const accepted = ctx.store.accept(ctx.store.lab(lab.labId), filename, { defer: true });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.library.code, "warned", "only a check with nothing to look at lets a picture into the library on its own");
  assert.match(accepted.body.library.message, /accepted after a warning/);
  assert.equal(existsSync(libraryFile(filename)), false);

  const chosen = ctx.store.shareLabPicture(ctx.store.lab(lab.labId), filename, { confirm: true });
  assert.equal(chosen.status, 200, "the person's own choice still shares it, when masking was proven");
  assert.deepEqual(readFileSync(libraryFile(filename)), staged.bytes);
});

test("a lab-specific slot stays in its lab", async () => {
  const lab = await newLab();
  const [filename] = lab.files;
  const noSharedSlots = createScreenshotStore({
    generatedRoot: ctx.generatedRoot,
    captureDir: join(ctx.dataDir, "capture"),
    capturedDirs: () => ({ primary: ctx.libDir, search: [ctx.libDir] }),
    manifestDir: tmp("capture-share-no-manifests-"),
  });
  const result = capture(lab.labId, filename, { seed: 30, store: noSharedSlots });
  assert.equal(result.status, 200);
  assert.equal(result.body.library, undefined, "nothing to say about a slot that is only for this lab");
  assert.equal(existsSync(libraryFile(filename)), false);
  const report = noSharedSlots.shareLabPictures(lab.labId).body;
  assert.deepEqual(report.skipped.map((s) => [s.filename, s.code]), [[filename, "lab-only"]]);
  assert.match(report.skipped[0].message, /specific to this lab/);
});

test("a placeholder, a stub, an unaccepted warning, a failed check, and unmasked account details are never shared", async () => {
  const check = (bytes) => ({ sha256: sha256Hex(bytes), state: "accepted", level: "pass", ok: true, redaction: { applied: true, masked: 1 } });
  const slot = { product: "copilot-studio" };
  const placeholder = readFileSync(PLACEHOLDER_PATH);
  const stub = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100)]);
  const real = makePng({ mode: "ui", seed: 40 });
  const verdict = (bytes, record, intent = "capture") => shareVerdict({ filename: "shot.png", bytes, record, slot, intent });
  assert.equal(verdict(placeholder, check(placeholder)).code, "placeholder");
  assert.equal(verdict(stub, check(stub)).code, "not-real");
  assert.equal(verdict(real, { ...check(real), state: "needs-review" }).code, "not-accepted");
  assert.equal(verdict(real, { ...check(real), level: "fail", ok: false }).code, "failed");
  assert.equal(verdict(real, { ...check(real), redaction: { applied: false, masked: 0 } }, "share").code, "not-masked", "even a person cannot share a picture whose masking was requested and not applied");
  assert.equal(verdict(real, { ...check(real), redaction: null }).code, "masking-unproven");
  assert.equal(verdict(real, { ...check(real), redaction: null }, "share").ok, true, "but a person may vouch for a picture put in by hand");
  assert.equal(verdict(real, { ...check(real), sha256: sha256Hex(Buffer.from("other")) }).code, "check-mismatch");
  assert.equal(verdict(real, null).code, "no-check");
  assert.equal(shareVerdict({ filename: "shot.png", bytes: real, record: check(real), slot: null, intent: "capture" }).code, "lab-only");

  // The same rules hold end to end.
  const lab = await newLab();
  const [filename] = lab.files;
  assert.equal(capture(lab.labId, filename, { bytes: makePng({ mode: "blank", width: 800, height: 600 }) }).status, 422, "a failed check");
  assert.equal(capture(lab.labId, filename, { bytes: makePng({ mode: "mostly", seed: 41 }) }).status, 202, "an unaccepted warning");
  assert.equal(existsSync(libraryFile(filename)), false);

  const unmasked = capture(lab.labId, filename, { seed: 42, redaction: { applied: false, masked: 0 } });
  assert.equal(unmasked.status, 202, "masking was required and was not applied, so a person has to look");
  const accepted = ctx.store.accept(ctx.store.lab(lab.labId), filename, { defer: true });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.library.code, "not-masked", "accepting it does not make it look masked");
  assert.match(accepted.body.library.message, /Account details were not hidden/);
  assert.equal(existsSync(libraryFile(filename)), false);

  const byHand = capture(lab.labId, filename, { seed: 43, source: "manual-upload", requireRedaction: false, redaction: null });
  assert.equal(byHand.status, 200);
  assert.equal(byHand.body.library.code, "masking-unproven", "a picture with no proof of hidden account details stays in its lab");
  assert.match(byHand.body.library.message, /could not confirm that account details are hidden/);
  assert.equal(existsSync(libraryFile(filename)), false);
  assert.equal(ctx.syncs, 0, "nothing was shared, so no Azure Blob write-through was asked for by the library");
});

// ── Never overwrite silently ─────────────────────────────────────────────────

test("an existing library picture is kept unless a person retakes or accepts, and the replaced one is kept as a backup", async () => {
  const [a, b, c, d] = [await newLab(), await newLab(), await newLab(), await newLab()];
  const filename = a.files[0];
  const first = capture(a.labId, filename, { seed: 51 });
  assert.equal(first.body.library.outcome, "shared");

  const ordinary = capture(b.labId, filename, { seed: 52 });
  assert.equal(ordinary.status, 200);
  assert.equal(ordinary.body.library.code, "library-has-one");
  assert.deepEqual(readFileSync(libraryFile(filename)), first.bytes, "an ordinary capture never replaces the library's picture");
  assert.deepEqual(readFileSync(join(b.labDir, "assets", filename)), ordinary.bytes, "the lab keeps its own");
  assert.equal(existsSync(`${libraryFile(filename)}.previous`), false);

  const retake = capture(b.labId, filename, { seed: 53, retake: true });
  assert.equal(retake.body.library.outcome, "replaced");
  assert.equal(retake.body.library.previousKept, true);
  assert.deepEqual(readFileSync(libraryFile(filename)), retake.bytes);
  assert.deepEqual(readFileSync(`${libraryFile(filename)}.previous`), first.bytes, "the previous picture is kept");
  assert.equal(capturedImage(ctx.libDir, `${filename}.previous`), null, "a backup is never served as a slot");
  assert.equal(ctx.store.libraryState().shots.some((s) => s.filename.endsWith(".previous")), false);
  assert.equal(readdirSync(ctx.libDir).filter((name) => name.includes(".blob-tmp-")).length, 0, "no temporary or lock file is left behind");

  // The same picture again changes nothing (sharing twice is harmless).
  assert.equal(capture(c.labId, filename, { bytes: retake.bytes, retake: true }).body.library.outcome, "already-shared");
  assert.deepEqual(readFileSync(`${libraryFile(filename)}.previous`), first.bytes);

  // A newer capture a person accepted after a warning is not shared by itself; their own choice replaces it.
  const staged = capture(d.labId, filename, { bytes: makePng({ mode: "mostly", seed: 54 }) });
  assert.equal(staged.status, 202);
  const accepted = ctx.store.accept(ctx.store.lab(d.labId), filename, { defer: true });
  assert.equal(accepted.body.library.code, "warned");
  assert.deepEqual(readFileSync(libraryFile(filename)), retake.bytes);
  const chosen = ctx.store.shareLabPicture(ctx.store.lab(d.labId), filename, { confirm: true });
  assert.equal(chosen.body.outcome, "replaced");
  assert.deepEqual(readFileSync(libraryFile(filename)), staged.bytes);
  assert.deepEqual(readFileSync(`${libraryFile(filename)}.previous`), retake.bytes);
});

test("a library picture marked accurate is never replaced automatically; Use this one for every lab asks, then clears the mark", async () => {
  const [a, b] = [await newLab(), await newLab()];
  const filename = a.files[0];
  const first = capture(a.labId, filename, { seed: 61 });
  const mark = await call("POST", `/api/capture/library/screenshots/${filename}/confirm`);
  assert.equal(mark.status, 200);
  assert.equal(mark.json.scope, "library");
  assert.equal(ctx.store.libraryState().shots.find((s) => s.filename === filename).confirmed.at, mark.json.confirmed.at);
  assert.equal(ctx.store.libraryState().summary.confirmed, 1);

  const retake = capture(b.labId, filename, { seed: 62, retake: true });
  assert.equal(retake.body.library.code, "library-confirmed");
  assert.match(retake.body.library.message, /marked accurate/);
  assert.deepEqual(readFileSync(libraryFile(filename)), first.bytes, "even a retake leaves a confirmed picture alone");
  assert.deepEqual(readFileSync(join(b.labDir, "assets", filename)), retake.bytes);
  const labRow = row(b.labId, filename);
  assert.deepEqual(labRow.share, { state: "differs", libraryConfirmed: true }, "the lab can offer Use this one for every lab");

  const share = (json) => call("POST", `/api/lab-builder/generated/${b.labId}/screenshots/${filename}/share`, { json });
  assert.equal((await share({})).status, 400, "a clear confirmation is required");
  const asked = await share({ confirm: true });
  assert.equal(asked.status, 409);
  assert.equal(asked.json.needsReplaceConfirmation, true);
  assert.deepEqual(readFileSync(libraryFile(filename)), first.bytes);
  const replaced = await share({ confirm: true, replaceConfirmed: true });
  assert.equal(replaced.status, 200, replaced.text);
  assert.equal(replaced.json.outcome, "replaced");
  assert.deepEqual(readFileSync(libraryFile(filename)), retake.bytes);
  assert.deepEqual(readFileSync(`${libraryFile(filename)}.previous`), first.bytes);
  assert.equal(ctx.store.libraryState().shots.find((s) => s.filename === filename).confirmed, null, "replacing clears the mark");
  assert.equal(libraryRecords().confirmations?.[filename], undefined);
  assert.ok(ctx.syncs >= 2);
});

test("two labs sharing the same slot at once leave exactly one consistent picture, even across processes", async () => {
  const [a, b] = [await newLab(), await newLab()];
  const filename = a.files[0];

  // A lock held by another process: nothing is shared and nothing is damaged; once it is released the share works.
  const release = acquireShareLock(ctx.libDir, filename);
  assert.equal(typeof release, "function");
  assert.equal(acquireShareLock(ctx.libDir, filename), null, "one writer at a time");
  assert.equal(capture(a.labId, filename, { seed: 71 }).body.library.code, "busy");
  assert.equal(existsSync(libraryFile(filename)), false);
  release();
  rmSync(libraryFile(filename), { force: true });

  // Two real processes start at the same moment.
  const script = `
    import { createScreenshotStore } from ${JSON.stringify(pathToFileURL(join(PORTAL_ROOT, "lib", "capture", "screenshot-store.js")).href)};
    const args = JSON.parse(process.env.SHARE_ARGS);
    const store = createScreenshotStore({ generatedRoot: args.generatedRoot, captureDir: args.captureDir, capturedDirs: () => ({ primary: args.libDir, search: [args.libDir] }) });
    const target = store.lab(args.labId);
    const slot = target.slot(args.filename);
    const evidence = { finalUrl: "https://copilotstudio.microsoft.com/environments/00000000-0000-0000-0000-000000000000/bots", title: "Copilot Studio", visibleText: [...slot.expectedLabels, "Settings"], redaction: { applied: true, masked: 1 }, capturedAt: new Date().toISOString(), executedSteps: 3 };
    while (Date.now() < args.startAt) {}
    const result = store.submit(target, args.filename, Buffer.from(args.bytes, "base64"), { evidence, source: "companion", defer: true, requireEvidence: true, requireRedaction: true });
    process.stdout.write(JSON.stringify(result.body.library || null), () => process.exit(0));
  `;
  const inputs = [makePng({ mode: "ui", seed: 72 }), makePng({ mode: "ui", seed: 73 })];
  const startAt = Date.now() + 3000;
  const runs = [a, b].map(
    (lab, index) =>
      new Promise((resolveRun, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
          env: { ...process.env, SHARE_ARGS: JSON.stringify({ generatedRoot: ctx.generatedRoot, captureDir: join(ctx.dataDir, "capture"), libDir: ctx.libDir, labId: lab.labId, filename, bytes: inputs[index].toString("base64"), startAt }) },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        let err = "";
        child.stdout.on("data", (chunk) => (out += chunk));
        child.stderr.on("data", (chunk) => (err += chunk));
        child.on("error", reject);
        child.on("close", (code) => (code === 0 ? resolveRun(JSON.parse(out)) : reject(new Error(`share process failed (${code}): ${err.slice(-400)}`))));
      }),
  );
  const outcomes = await Promise.all(runs);
  assert.equal(outcomes.filter((o) => o.outcome === "shared").length, 1, JSON.stringify(outcomes));
  assert.ok(outcomes.every((o) => ["shared", "skipped"].includes(o.outcome)));
  const written = readFileSync(libraryFile(filename));
  assert.ok(inputs.some((bytes) => bytes.equals(written)), "the library holds one of the two pictures, whole");
  assert.equal(libraryRecords().shots[filename].sha256, sha(written), "and its record describes exactly that picture");
  assert.equal(readdirSync(ctx.libDir).filter((name) => name.includes(".blob-tmp-")).length, 0);
  assert.equal(existsSync(`${libraryFile(filename)}.previous`), false, "nothing was replaced");
  for (const [index, lab] of [a, b].entries()) assert.deepEqual(readFileSync(join(lab.labDir, "assets", filename)), inputs[index], "each lab keeps its own picture");
});

test("a job asked for as a Retake may replace the library's picture; an ordinary job may not (through the companion routes)", async () => {
  const [a, b] = [await newLab(), await newLab()];
  const filename = a.files[0];
  const first = capture(a.labId, filename, { seed: 151 });
  assert.equal(first.body.library.outcome, "shared");

  const code = (await call("POST", "/api/capture/pair")).json.code;
  const token = (await call("POST", "/api/capture/companion/pair", { json: { code, deviceName: "TEST-PC", platform: "win32", companionVersion: "1.6.1" } })).json.token;
  await call("POST", "/api/capture/companion/heartbeat", { token, json: { signedInProducts: ["copilot-studio"] } });
  const runJob = async (options, seed) => {
    const queued = await call("POST", "/api/capture/jobs", { json: { target: { type: "lab", labId: b.labId }, scope: { mode: "selected", filenames: [filename] }, targets: { copilotStudioAgentName: "Contoso Support Agent" }, options } });
    assert.equal(queued.status, 201, queued.text);
    assert.equal(queued.json.job.options.retake, Boolean(options.retake));
    const claimed = (await call("GET", "/api/capture/companion/next", { token })).json;
    assert.equal(claimed.job.id, queued.json.job.id, "the companion claims the job just queued");
    const evidence = { ...evidenceFor(ctx.store.lab(b.labId), filename), finalUrl: addressFor(claimed.shots[0]) };
    const bytes = makePng({ mode: "ui", seed });
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: "image/png" }), filename);
    form.append("evidence", JSON.stringify(evidence));
    const uploaded = await call("PUT", `/api/capture/companion/jobs/${claimed.job.id}/shots/${encodeURIComponent(filename)}`, { token, form });
    assert.equal(uploaded.status, 200, uploaded.text);
    await call("POST", `/api/capture/companion/jobs/${claimed.job.id}/complete`, { token, json: { message: "done" } });
    return { library: uploaded.json.library, bytes };
  };

  const ordinary = await runJob({}, 152);
  assert.equal(ordinary.library.code, "library-has-one");
  assert.deepEqual(readFileSync(libraryFile(filename)), first.bytes);

  const retake = await runJob({ retake: true }, 153);
  assert.equal(retake.library.outcome, "replaced");
  assert.deepEqual(readFileSync(libraryFile(filename)), retake.bytes);
  assert.deepEqual(readFileSync(`${libraryFile(filename)}.previous`), first.bytes);
});

test("replacement rules in one place", () => {
  const base = { existing: { file: "x" }, existingSha: "aa", candidateSha: "bb", confirmed: false };
  assert.equal(replacementVerdict({ ...base, existing: null, intent: "capture" }).action, "write");
  assert.equal(replacementVerdict({ ...base, candidateSha: "aa", intent: "capture" }).action, "same");
  for (const intent of ["capture", "backfill"]) assert.equal(replacementVerdict({ ...base, intent }).code, "library-has-one");
  for (const intent of ["retake", "accept", "share"]) assert.equal(replacementVerdict({ ...base, intent }).action, "replace");
  for (const intent of ["capture", "backfill", "retake", "accept"]) assert.equal(replacementVerdict({ ...base, confirmed: true, intent }).code, "library-confirmed");
  assert.equal(replacementVerdict({ ...base, confirmed: true, intent: "share" }).code, "library-confirmed");
  assert.equal(replacementVerdict({ ...base, confirmed: true, intent: "share", replaceConfirmed: true }).action, "replace");
});

test("a library kept in the code repository's committed folder is never filled automatically", async () => {
  const lab = await newLab();
  const [filename] = lab.files;
  const baked = resolve(REPO_ROOT, "docs", "feature-tour", "screenshots");
  const committed = createScreenshotStore({
    generatedRoot: ctx.generatedRoot,
    captureDir: join(ctx.dataDir, "capture"),
    capturedDirs: () => ({ primary: baked, search: [baked] }),
  });
  const before = readdirSync(baked).sort();
  const result = capture(lab.labId, filename, { seed: 80, store: committed });
  assert.equal(result.body.library.code, "not-persistent");
  assert.match(result.body.library.message, /committed folder/);
  assert.deepEqual(readdirSync(baked).sort(), before, "no customer picture lands in a Git-tracked folder");
});

// ── Mark as accurate ─────────────────────────────────────────────────────────

test("Mark as accurate is tied to the picture's bytes, can be cleared, and never changes the checklist numbers or the lab files", async () => {
  const lab = await newLab();
  const [filename, other] = lab.files;
  const first = capture(lab.labId, filename, { seed: 91 });
  ctx.store.flushLab(lab.labId);
  const urlFor = (name) => `/api/lab-builder/generated/${lab.labId}/screenshots/${name}/confirm`;

  const before = status(lab.labId);
  const htmlBefore = sha(readFileSync(join(lab.labDir, "index.html")));
  assert.equal(before.shots.find((s) => s.filename === filename).confirmed, null);
  assert.equal(before.summary.confirmed, 0);
  assert.equal(before.summary.notConfirmed, 1);

  const marked = await call("POST", urlFor(filename));
  assert.equal(marked.status, 200, marked.text);
  assert.equal(marked.json.outcome, "confirmed");
  assert.equal(marked.json.scope, "lab");
  const after = status(lab.labId);
  const confirmedRow = after.shots.find((s) => s.filename === filename);
  assert.equal(confirmedRow.confirmed.at, marked.json.confirmed.at);
  assert.equal(after.summary.confirmed, 1);
  assert.equal(after.summary.notConfirmed, 0);
  const stored = JSON.parse(readFileSync(join(lab.labDir, "screenshots", "verification.json"), "utf8"));
  assert.equal(stored.confirmations[filename].sha256, sha(first.bytes), "stored with a SHA-256 of the picture");
  assert.ok(stored.shots[filename], "next to the verification records");

  // It never blocks anything: every other number, the modules, and the lab's own files are exactly as before.
  const { confirmed: c1, notConfirmed: n1, ...summaryBefore } = before.summary;
  const { confirmed: c2, notConfirmed: n2, ...summaryAfter } = after.summary;
  assert.deepEqual(summaryAfter, summaryBefore);
  assert.deepEqual(after.modules, before.modules);
  assert.equal(sha(readFileSync(join(lab.labDir, "index.html"))), htmlBefore);

  // Different bytes invalidate it by themselves, with nothing cleared.
  writeFileSync(join(lab.labDir, "assets", filename), makePng({ mode: "ui", seed: 92 }));
  assert.equal(row(lab.labId, filename).confirmed, null);
  assert.equal(status(lab.labId).summary.confirmed, 0);
  writeFileSync(join(lab.labDir, "assets", filename), first.bytes);
  assert.ok(row(lab.labId, filename).confirmed, "the same bytes count again");

  // A new capture drops the old mark.
  capture(lab.labId, filename, { seed: 93 });
  assert.equal(row(lab.labId, filename).confirmed, null);
  assert.equal(JSON.parse(readFileSync(join(lab.labDir, "screenshots", "verification.json"), "utf8")).confirmations?.[filename], undefined);

  // Clear confirmation.
  assert.equal((await call("POST", urlFor(filename))).status, 200);
  const cleared = await call("DELETE", urlFor(filename));
  assert.equal(cleared.status, 200);
  assert.equal(cleared.json.outcome, "unconfirmed");
  assert.equal(row(lab.labId, filename).confirmed, null);

  assert.equal((await call("POST", urlFor(other))).status, 409, "a screenshot with no picture cannot be marked");
  assert.equal((await call("POST", urlFor("not-a-slot.png"))).status, 404);
});

test("marking a picture served from the shared library marks the shared picture for every lab", async () => {
  const [a, b] = [await newLab(), await newLab()];
  const filename = a.files[0];
  capture(a.labId, filename, { seed: 95 });
  assert.equal(row(b.labId, filename).imageSource, "library");
  const marked = await call("POST", `/api/lab-builder/generated/${b.labId}/screenshots/${filename}/confirm`);
  assert.equal(marked.status, 200);
  assert.equal(marked.json.scope, "library");
  assert.ok(row(b.labId, filename).confirmed);
  assert.ok(ctx.store.libraryState().shots.find((s) => s.filename === filename).confirmed);
  assert.equal(await call("DELETE", `/api/lab-builder/generated/${b.labId}/screenshots/${filename}/confirm`).then((r) => r.status), 200);
  assert.equal(row(b.labId, filename).confirmed, null);
  assert.equal(ctx.store.libraryState().summary.confirmed, 0);
});

// ── Backfill: share the pictures a lab already has ───────────────────────────

test("Share this lab's captured screenshots: a dry run changes nothing, apply shares what is provably clean and never overwrites", async () => {
  const lab = await newLab();
  const [clean, byHand] = lab.files;

  // Pictures already in the lab, never shared (a store that sees no shared slots stands in for an earlier version).
  const earlier = createScreenshotStore({
    generatedRoot: ctx.generatedRoot,
    captureDir: join(ctx.dataDir, "capture"),
    capturedDirs: () => ({ primary: ctx.libDir, search: [ctx.libDir] }),
    manifestDir: tmp("capture-share-earlier-"),
  });
  const cleanShot = capture(lab.labId, clean, { seed: 101, store: earlier });
  capture(lab.labId, byHand, { seed: 102, store: earlier, source: "manual-upload", requireRedaction: false, redaction: null });
  assert.equal(existsSync(libraryFile(clean)), false);

  const dry = await call("POST", `/api/lab-builder/generated/${lab.labId}/screenshots/share`, { json: { dryRun: true } });
  assert.equal(dry.status, 200, dry.text);
  assert.deepEqual(dry.json.promoted, [clean]);
  assert.deepEqual(dry.json.skipped.map((s) => [s.filename, s.code]), [[byHand, "masking-unproven"]]);
  assert.equal(existsSync(libraryFile(clean)), false, "a dry run writes nothing");

  const applied = await call("POST", `/api/lab-builder/generated/${lab.labId}/screenshots/share`, { json: {} });
  assert.equal(applied.status, 200);
  assert.deepEqual(applied.json.promoted, [clean]);
  assert.deepEqual(applied.json.counts, { promoted: 1, alreadyShared: 0, skipped: 1, noPicture: lab.files.length - 2 });
  assert.deepEqual(readFileSync(libraryFile(clean)), cleanShot.bytes);
  assert.equal(existsSync(libraryFile(byHand)), false);
  assert.ok(ctx.syncs >= 1);

  const again = await call("POST", `/api/lab-builder/generated/${lab.labId}/screenshots/share`, { json: {} });
  assert.deepEqual(again.json.promoted, []);
  assert.deepEqual(again.json.alreadyShared, [clean], "sharing twice is harmless");

  // Another lab's different picture for the same slot never overwrites what the library has.
  const other = await newLab();
  capture(other.labId, clean, { seed: 103, store: earlier });
  const noOverwrite = ctx.store.shareLabPictures(other.labId).body;
  assert.deepEqual(noOverwrite.skipped.map((s) => [s.filename, s.code]), [[clean, "library-has-one"]]);
  assert.deepEqual(readFileSync(libraryFile(clean)), cleanShot.bytes);
});

test("the command-line tool has --dry-run and --apply and prints a plain report", async () => {
  const lab = await newLab();
  const [filename] = lab.files;
  const earlier = createScreenshotStore({
    generatedRoot: ctx.generatedRoot,
    captureDir: join(ctx.dataDir, "capture"),
    capturedDirs: () => ({ primary: ctx.libDir, search: [ctx.libDir] }),
    manifestDir: tmp("capture-share-cli-"),
  });
  const shot = capture(lab.labId, filename, { seed: 111, store: earlier });
  const cli = (...args) =>
    spawnSync(process.execPath, [join(REPO_ROOT, "tools", "lab-builder", "share-lab-screenshots.mjs"), `--root=${ctx.generatedRoot}`, `--library=${ctx.libDir}`, `--lab=${lab.labId}`, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, PORTAL_STORAGE_ROOT: ctx.storageRoot, FEATURE_TOUR_SCREENSHOTS_DIR: "" },
      encoding: "utf8",
    });

  assert.equal(cli().status, 2, "one of --dry-run or --apply is required");
  const dry = cli("--dry-run");
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /1 would be shared/);
  assert.equal(existsSync(libraryFile(filename)), false);
  const json = JSON.parse(cli("--dry-run", "--json").stdout);
  assert.deepEqual(json.labs[0].promoted, [filename]);

  const applied = cli("--apply");
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /1 shared/);
  assert.deepEqual(readFileSync(libraryFile(filename)), shot.bytes);
  assert.match(cli("--apply").stdout, /1 already in the library/);
});

// ── Who else uses a shared picture ───────────────────────────────────────────

test("the library says how many other labs show a picture, so a retake can ask first", async () => {
  const root = tmp("capture-share-usage-");
  const usage = createCapturePlatform({ generatedRoot: root, dataDir: ctx.dataDir, env: { PORTAL_STORAGE_ROOT: ctx.storageRoot }, detectServerBrowser: async () => ({ available: false }) });
  const [x, y] = [await newLab(root), await newLab(root)];
  await newLab(root);
  const filename = x.files[0];
  assert.equal(usage.screenshots.libraryUsage(filename).body.hasPicture, false);
  capture(x.labId, filename, { seed: 121, store: usage.screenshots });
  assert.deepEqual(usage.screenshots.libraryUsage(filename, { exceptLabId: x.labId }).body, { filename, hasPicture: true, otherLabs: 2, confirmed: false });
  capture(y.labId, filename, { seed: 122, store: usage.screenshots });
  assert.equal(usage.screenshots.libraryUsage(filename, { exceptLabId: x.labId }).body.otherLabs, 1, "a lab with its own picture does not use the shared one");
  assert.equal(usage.screenshots.libraryUsage("not-a-slot.png").status, 404);
});

// ── Azure Blob ───────────────────────────────────────────────────────────────

test("a shared picture, its backup, and the library records are mirrored to Azure Blob", async () => {
  const [a, b] = [await newLab(), await newLab()];
  const filename = a.files[0];
  const blobs = new Map();
  const fakeFetch = async (url, init = {}) => {
    const parsed = new URL(url);
    const method = init.method || "GET";
    if (parsed.searchParams.get("comp") === "list") {
      const names = [...blobs.keys()].map((n) => `<Blob><Name>${n}</Name></Blob>`).join("");
      return new Response(`<EnumerationResults><Blobs>${names}</Blobs><NextMarker></NextMarker></EnumerationResults>`, { status: 200 });
    }
    const name = decodeURIComponent(parsed.pathname.split("/").slice(2).join("/"));
    if (method === "PUT") {
      blobs.set(name, { body: Buffer.from(init.body), contentType: init.headers["Content-Type"] });
      return new Response(null, { status: 201 });
    }
    if (method === "DELETE") {
      blobs.delete(name);
      return new Response(null, { status: 202 });
    }
    return blobs.has(name) ? new Response(blobs.get(name).body, { status: 200 }) : new Response(null, { status: 404 });
  };
  const mirror = createBlobPersistence({
    env: { PORTAL_STORAGE_ROOT: ctx.storageRoot, LAB_BUILDER_OUTPUT_DIR: tmp("capture-share-blob-labs-"), AZURE_STORAGE_BLOB_ENDPOINT: "https://example.blob.core.windows.net" },
    fetchImpl: fakeFetch,
    tokenProvider: () => "test-token",
    retryBaseDelayMs: 0,
  });

  const first = capture(a.labId, filename, { seed: 131 });
  assert.ok(ctx.syncs >= 1, "the library asked for the write-through");
  await mirror.syncToBlob();
  assert.deepEqual(blobs.get(`screenshots/${filename}`).body, first.bytes);
  assert.ok(blobs.has("data/capture/library-verification.json"), "the saved checks that go with it");

  const retake = capture(b.labId, filename, { seed: 132, retake: true });
  await mirror.syncToBlob();
  assert.deepEqual(blobs.get(`screenshots/${filename}`).body, retake.bytes);
  assert.deepEqual(blobs.get(`screenshots/${filename}.previous`).body, first.bytes, "the backup survives a restart too");
  assert.equal([...blobs.keys()].some((name) => name.includes(".blob-tmp-")), false, "locks and temporary files are never uploaded");
});

test("every lab status row carries where its picture comes from, and an older lab with no sharing details still works", async () => {
  const lab = await newLab();
  const [filename] = lab.files;
  capture(lab.labId, filename, { seed: 141 });
  const body = status(lab.labId);
  for (const shot of body.shots) {
    assert.ok("imageSource" in shot && "imageCapturedAt" in shot && "confirmed" in shot && "share" in shot);
  }
  assert.equal(body.shots.find((s) => s.filename !== filename).imageSource, null, "a screenshot with no picture has no source");
  assert.equal(body.summary.confirmed, 0);
});
