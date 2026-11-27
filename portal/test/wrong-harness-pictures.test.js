/**
 * Pictures that show the wrong harness, found by the shape of the address they were taken on.
 *
 * A companion older than 1.8.1 sent no proof of the harness, so a Microsoft Copilot picture could sit in a Standard (Classic) lab waiting for review with
 * only unrelated reasons. These tests build exactly that on a synthetic storage folder and check: the lab state and the library state say so when they are
 * read (and no file is rewritten), accepting such a picture is refused, it can be kept in the kept pictures list, "Pictures that look wrong" flags an
 * accepted one, and the two command-line tools (dry run first, --apply a separate step). Every picture is synthetic and no real tenant is used.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { generateLab } from "../lib/lab-builder/generator.js";
import { getLabScreenshotsStatus, readLabVerification, writeLabVerificationRecord } from "../lib/lab-builder/lab-screenshots.js";
import { registerCaptureRoutes } from "../lib/capture/routes.js";
import { createKeptStore } from "../lib/capture/kept-pictures.js";
import { readRecordsFile, sha256Hex, writeRecordsFile } from "../lib/capture/library-share.js";
import { FLAGS, FLAG_SHORT, assessPictures } from "../lib/capture/picture-integrity.js";
import { wrongHarnessPictureMessage } from "../../tools/screenshot-capture/harness.mjs";
import { makePng } from "../../tools/screenshot-capture/test/fixtures/png.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "..", "..");
const cleanups = [];
const tmp = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const ENV = "00000000-0000-0000-0000-000000000000";
const AGENT = "00000000-0000-0000-0000-0000000000a1";
const HOST = "https://copilotstudio.microsoft.com";
const COPILOT_PREVIEW = `${HOST}/environments/${ENV}/agents/${AGENT}/preview`;
const COPILOT_PLAIN = `${HOST}/environments/${ENV}/agents/${AGENT}`;
const STANDARD_PAGE = `${HOST}/environments/${ENV}/bots/${AGENT}/overview`;
const WRONG = "This picture was taken in the Microsoft Copilot harness (Build, Preview, Evaluate, Monitor); this lab needs the Standard (Classic) harness.";
const REFUSED = `${WRONG} It cannot be accepted for this screenshot. Keep it in the kept pictures, or retake it.`;
let LIBRARY_SLOT = "";

// What a companion before 1.8.1 saved with a picture of a Standard lab taken on a Microsoft Copilot agent page: nothing about the harness.
const OLD_REASONS = [
  { code: "labels-missing", level: "warn", message: "Only 0 of 4 expected UI labels are visible. Check that the screen is the one the lab describes." },
  { code: "recipe-review", level: "warn", message: "The recipe saved this picture for review because it cannot check this screen on its own." },
  { code: "landing-page", level: "warn", message: "This shows the product's start page, but its lab describes a deeper screen. Check it, then accept it or retake it." },
];

const png = (seed) => makePng({ mode: "ui", seed });
const codes = (reasons) => reasons.map((r) => r.code);

async function newLab(root, emptyLabs, harness = "standard") {
  const build = await generateLab({ products: ["copilot-studio"], features: ["create-agent"], harness, includeCore: false }, { outputRoot: root, labsDir: emptyLabs, useLearnMcp: false, useLlm: false });
  const plan = JSON.parse(readFileSync(join(build.outputDir, "screenshots", "shots.json"), "utf8"));
  return { labId: build.labId, labDir: build.outputDir, files: plan.shots.map((s) => s.filename) };
}

/**
 * Put a picture in the review queue the way the portal does (the staged picture and its meta, and the needs-review record in the lab or the library),
 * without going through the upload checks, so a picture an older companion staged can be built exactly.
 */
function stage(env, scope, filename, { seed, finalUrl = COPILOT_PREVIEW, source = "companion", reasons = OLD_REASONS, evidence, harness = null, priorRecord = null }) {
  const bytes = png(seed);
  const dir = join(env.dataDir, "capture", "staged", scope.kind === "library" ? "library" : `lab-${scope.labId}`);
  mkdirSync(dir, { recursive: true });
  const stagedAt = "2026-11-20T10:00:00.000Z";
  const saved = evidence === undefined ? { version: 1, finalUrl, title: "Copilot Studio", visibleText: ["Overview"], redaction: { applied: true, masked: 2 }, signals: null, capturedAt: stagedAt, harness, harnessReached: null, executedSteps: 3, mode: "autonomous", setup: null, routeSteps: [] } : evidence;
  const verification = { ok: true, level: "warn", reasons, format: "png", width: 1280, height: 800, bytes: bytes.length, sha256: sha256Hex(bytes), ...(saved ? { finalUrl: saved.finalUrl } : {}), evidenceVersion: 1, checkedAt: stagedAt };
  writeFileSync(join(dir, filename), bytes);
  writeFileSync(join(dir, `${filename}.meta.json`), JSON.stringify({ verification, evidence: saved, source, jobId: "job_synthetic", stagedAt, callouts: null, expect: null, expectedLabels: [], extras: {} }));
  const record = { ...verification, state: "needs-review", source, jobId: "job_synthetic", stagedAt, ...(priorRecord ? { priorRecord } : {}) };
  if (scope.kind === "lab") writeLabVerificationRecord(scope.labDir, filename, record);
  else {
    const file = join(env.dataDir, "capture", "library-verification.json");
    const { shots, confirmations } = readRecordsFile(file);
    writeRecordsFile(file, { shots: { ...shots, [filename]: record }, confirmations });
  }
  return { bytes, dir, image: join(dir, filename), meta: join(dir, `${filename}.meta.json`), record };
}

const stateOf = (env, labId) => getLabScreenshotsStatus(env.generatedRoot, labId, { capturedDir: [env.libDir] }).body;
const rowOf = (env, labId, filename) => stateOf(env, labId).shots.find((s) => s.filename === filename);
const listing = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).sort() : []);

const ctx = {};
let server;

before(async () => {
  const storage = join(tmp("wrong-harness-"), "storage");
  Object.assign(ctx, { storage, generatedRoot: join(storage, "generated-labs"), dataDir: join(storage, "data"), libDir: join(storage, "screenshots"), emptyLabs: tmp("wrong-harness-empty-labs-") });
  mkdirSync(ctx.generatedRoot, { recursive: true });
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  app.use((req, _res, next) => {
    req.body ??= {};
    next();
  });
  const platform = registerCaptureRoutes(app, { generatedRoot: ctx.generatedRoot, dataDir: ctx.dataDir, env: { PORTAL_STORAGE_ROOT: storage, CAPTURE_STARTUP_SCAN: "off" }, scheduleBlobSync: () => {}, detectServerBrowser: async () => ({ available: false }) });
  ctx.store = platform.screenshots;
  server = await new Promise((resolveServer) => {
    const s = app.listen(0, "127.0.0.1", () => resolveServer(s));
  });
  ctx.base = `http://127.0.0.1:${server.address().port}`;
  ctx.lab = await newLab(ctx.generatedRoot, ctx.emptyLabs);
  assert.ok(ctx.lab.files.length >= 3, "the synthetic lab has the slots these tests use");
  // Any library slot that needs the Standard (Classic) harness: its library name carries the harness.
  LIBRARY_SLOT = ctx.store.libraryState().shots.find((s) => s.harness === "standard")?.filename || "";
  assert.ok(LIBRARY_SLOT, "the library has a Standard slot");
});

after(async () => {
  await new Promise((done) => (server ? server.close(done) : done()));
  for (const fn of cleanups.reverse()) {
    try {
      fn();
    } catch {
      /* best effort */
    }
  }
});

const call = async (method, url, json) => {
  const res = await fetch(`${ctx.base}${url}`, { method, headers: json ? { "Content-Type": "application/json" } : {}, body: json ? JSON.stringify(json) : undefined });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const labUrl = (labId, filename, suffix = "") => `/api/lab-builder/generated/${labId}/screenshots/${filename}${suffix}`;

// ── Reading a staged picture ─────────────────────────────────────────────────

test("a staged picture from an old companion on a Microsoft Copilot page says it is the wrong harness, first, without any file being rewritten", () => {
  const env = ctx;
  const [slot] = ctx.lab.files;
  const staged = stage(env, { kind: "lab", ...ctx.lab }, slot, { seed: 1 });
  const recordFile = join(ctx.lab.labDir, "screenshots", "verification.json");
  const before = { image: readFileSync(staged.image), meta: readFileSync(staged.meta), record: readFileSync(recordFile) };
  const filesBefore = [listing(staged.dir), listing(join(ctx.lab.labDir, "screenshots"))];

  const row = rowOf(env, ctx.lab.labId, slot);
  assert.equal(row.needsReview, true);
  assert.deepEqual(codes(row.verification.reasons), ["wrong-harness", "labels-missing", "recipe-review", "landing-page"], "the harness reason comes first, the saved ones follow");
  assert.deepEqual(row.verification.reasons[0], { code: "wrong-harness", level: "warn", message: WRONG, derived: true });
  assert.equal(row.verification.reasons[0].message, wrongHarnessPictureMessage("microsoft-copilot", "standard"));
  assert.deepEqual(row.harnessReview, {
    code: "wrong-harness",
    found: "microsoft-copilot",
    foundLabel: "Microsoft Copilot harness",
    source: "address",
    needed: "standard",
    neededLabel: "Standard (Classic) harness",
    message: WRONG,
    canAccept: false,
    addressAgrees: false,
  });

  // Read twice more, and look at everything on disk: nothing was written.
  rowOf(env, ctx.lab.labId, slot);
  assert.deepEqual(readFileSync(staged.image), before.image);
  assert.deepEqual(readFileSync(staged.meta), before.meta);
  assert.deepEqual(readFileSync(recordFile), before.record, "the saved check is as it was: the reason is added when it is read");
  assert.deepEqual([listing(staged.dir), listing(join(ctx.lab.labDir, "screenshots"))], filesBefore);
  assert.deepEqual(codes(readLabVerification(ctx.lab.labDir)[slot].reasons), ["labels-missing", "recipe-review", "landing-page"]);
  ctx.store.reset(ctx.store.lab(ctx.lab.labId), slot);
});

test("the other harness readings: the address that fits and no proof is unproven, a proof wins, nothing at all is unproven, and a hand upload is not judged for it", () => {
  const env = ctx;
  const slot = ctx.lab.files[2];
  const scope = { kind: "lab", ...ctx.lab };
  const proofStandard = { version: 2, id: "standard", proof: "landmarks", landmarks: ["Overview", "Knowledge", "Topics"], switched: true, wanted: "standard" };
  const read = (options) => {
    stage(env, scope, slot, options);
    const row = rowOf(env, ctx.lab.labId, slot);
    ctx.store.reset(ctx.store.lab(ctx.lab.labId), slot);
    return row;
  };

  const fits = read({ seed: 11, finalUrl: STANDARD_PAGE });
  assert.equal(fits.harnessReview.code, "harness-unproven");
  assert.equal(fits.harnessReview.canAccept, true);
  assert.equal(fits.harnessReview.addressAgrees, true);
  assert.equal(fits.harnessReview.found, null);
  assert.equal(fits.harnessReview.foundLabel, "Harness not recorded");
  assert.equal(fits.verification.reasons[0].code, "harness-unproven");
  assert.match(fits.verification.reasons[0].message, /address fits the Standard \(Classic\) harness, but an address alone does not prove it/);

  const proven = read({ seed: 12, finalUrl: COPILOT_PLAIN, harness: proofStandard });
  assert.deepEqual([proven.harnessReview.code, proven.harnessReview.source, proven.harnessReview.found, proven.harnessReview.canAccept], ["ok", "proof", "standard", true], "the companion's proof wins over a Microsoft Copilot looking address");
  assert.ok(!codes(proven.verification.reasons).some((code) => /harness/.test(code)));

  const nothing = read({ seed: 13, evidence: null });
  assert.equal(nothing.harnessReview.code, "harness-unproven");
  assert.equal(nothing.verification.reasons[0].message, "The companion did not report which harness this picture shows, so it is saved for review. Check that it shows the Standard (Classic) harness before you accept it.");

  // The address contradicts the slot whoever staged the picture; "not proven" is only said for a companion's picture.
  const byHandWrong = read({ seed: 14, finalUrl: COPILOT_PREVIEW, source: "manual-upload", reasons: [] });
  assert.equal(byHandWrong.harnessReview.code, "wrong-harness");
  assert.equal(byHandWrong.verification.reasons[0].code, "wrong-harness");
  const byHand = read({ seed: 15, finalUrl: STANDARD_PAGE, source: "manual-upload", reasons: [] });
  assert.equal(byHand.harnessReview.code, "harness-unproven");
  assert.deepEqual(byHand.verification.reasons, [], "a person who uploaded it by hand vouches for it when accepting");
});

// ── Accepting, and keeping ───────────────────────────────────────────────────

test("a fresh companion picture taken on a Microsoft Copilot agent page for a Standard slot is rejected with the plain sentence, and nothing is saved", () => {
  const slot = ctx.lab.files[1];
  const target = ctx.store.lab(ctx.lab.labId);
  const evidence = { version: 2, finalUrl: COPILOT_PREVIEW, title: "Copilot Studio", visibleText: ["Something else entirely"], redaction: { applied: true, masked: 2, controls: 1, lists: 0, listsMasked: 0 }, signals: { signInVisible: false, accountControl: true }, capturedAt: "2026-11-26T10:00:00.000Z", executedSteps: 3 };
  const treeBefore = [listing(join(ctx.dataDir, "capture")), listing(join(ctx.lab.labDir, "screenshots")), listing(join(ctx.lab.labDir, "assets"))];
  const result = ctx.store.submit(target, slot, png(91), { evidence, source: "companion", requireEvidence: true, requireRedaction: true, requireProof: true });
  assert.equal(result.status, 422);
  assert.equal(result.body.outcome, "rejected");
  assert.equal(result.body.message, WRONG, "the plain sentence, not an earlier warning");
  assert.ok(codes(result.body.verification.reasons).includes("wrong-harness"));
  assert.deepEqual([listing(join(ctx.dataDir, "capture")), listing(join(ctx.lab.labDir, "screenshots")), listing(join(ctx.lab.labDir, "assets"))], treeBefore, "not saved, not staged");
  // The same picture taken on a Standard agent page is only unproven: it goes to review.
  const fits = ctx.store.submit(target, slot, png(92), { evidence: { ...evidence, finalUrl: STANDARD_PAGE }, source: "companion", requireEvidence: true, requireRedaction: true, requireProof: true });
  assert.equal(fits.status, 202);
  assert.ok(codes(fits.body.verification.reasons).includes("harness-unproven"));
  ctx.store.reset(target, slot);
});

test("accepting a wrong-harness picture is refused with 409 and writes nothing; one that is only unproven can still be accepted", async () => {
  const env = ctx;
  const [, wrongSlot, unprovenSlot] = ctx.lab.files;
  const scope = { kind: "lab", ...ctx.lab };
  const wrong = stage(env, scope, wrongSlot, { seed: 21 });
  rowOf(env, ctx.lab.labId, wrongSlot);
  const recordFile = join(ctx.lab.labDir, "screenshots", "verification.json");
  const asset = join(ctx.lab.labDir, "assets", wrongSlot);
  const snapshot = () => ({ image: readFileSync(wrong.image), meta: readFileSync(wrong.meta), record: readFileSync(recordFile), asset: existsSync(asset) ? readFileSync(asset) : null, tree: [listing(wrong.dir), listing(join(ctx.lab.labDir, "assets")), listing(join(ctx.lab.labDir, "screenshots")), listing(ctx.libDir)] });
  const before = snapshot();

  const refused = await call("POST", labUrl(ctx.lab.labId, wrongSlot, "/accept"));
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.json, { outcome: "rejected", code: "wrong-harness", message: REFUSED, filename: wrongSlot });
  assert.deepEqual(snapshot(), before, "nothing was written, and the staged picture is still waiting");
  assert.equal(ctx.store.accept(ctx.store.lab(ctx.lab.labId), wrongSlot).status, 409, "the store refuses it too");

  stage(env, scope, unprovenSlot, { seed: 22, finalUrl: STANDARD_PAGE });
  const accepted = await call("POST", labUrl(ctx.lab.labId, unprovenSlot, "/accept"));
  assert.equal(accepted.status, 200, JSON.stringify(accepted.json));
  assert.equal(accepted.json.outcome, "accepted");
  assert.equal(readLabVerification(ctx.lab.labDir)[unprovenSlot].harness.proof, "person", "a person looked at it; nothing proved it");
  ctx.store.reset(ctx.store.lab(ctx.lab.labId), wrongSlot);
  ctx.store.reset(ctx.store.lab(ctx.lab.labId), unprovenSlot);
});

test("keeping a wrong-harness picture moves it to the kept pictures list and puts the slot back as it was; any other picture is refused", async () => {
  const env = ctx;
  const [, slot, other] = ctx.lab.files;
  const scope = { kind: "lab", ...ctx.lab };
  const prior = { ok: true, level: "pass", state: "accepted", sha256: "a".repeat(64), source: "manual-upload", acceptedAt: "2026-11-01T10:00:00.000Z", harness: { id: "standard", proof: "person", at: "2026-11-01T10:00:00.000Z" } };
  const staged = stage(env, scope, slot, { seed: 31, priorRecord: prior });

  const notWrong = stage(env, scope, other, { seed: 32, finalUrl: STANDARD_PAGE });
  const refusedKeep = await call("POST", labUrl(ctx.lab.labId, other, "/keep-staged"));
  assert.equal(refusedKeep.status, 409);
  assert.equal(refusedKeep.json.code, "not-wrong-harness");
  assert.ok(existsSync(notWrong.image), "it stays in review");

  const kept = await call("POST", labUrl(ctx.lab.labId, slot, "/keep-staged"));
  assert.equal(kept.status, 200, JSON.stringify(kept.json));
  assert.equal(kept.json.outcome, "kept");
  assert.equal(kept.json.code, "wrong-harness");
  assert.ok(kept.json.message.startsWith(WRONG));
  assert.equal(existsSync(staged.image) || existsSync(staged.meta), false, "cleared from review");
  assert.deepEqual(readLabVerification(ctx.lab.labDir)[slot], prior, "the record the slot had before staging is back, exactly");
  const row = rowOf(env, ctx.lab.labId, slot);
  assert.equal(row.needsReview, false);
  assert.ok(!row.harnessReview);

  const entry = ctx.store.keptOverview().entries.find((e) => e.labId === ctx.lab.labId && e.pictures.some((p) => p.base === slot));
  assert.equal(entry.reason, "wrong-harness");
  const picture = entry.pictures.find((p) => p.base === slot);
  assert.deepEqual([picture.why, picture.harness, picture.message], ["wrong-harness", "microsoft-copilot", WRONG]);
  assert.ok(picture.restore.every((option) => option.type !== "lab"), "it is never put back into the Standard slot it was refused for");
  assert.deepEqual(ctx.store.keptPicture(entry.id, picture.filename).bytes, staged.bytes, "the kept copy is the staged picture, byte for byte");
  assert.equal((await call("POST", labUrl(ctx.lab.labId, slot, "/keep-staged"))).status, 404, "nothing is waiting any more");
  ctx.store.reset(ctx.store.lab(ctx.lab.labId), other);
  ctx.store.removeKept(entry.id, picture.filename);
});

test("a staged picture of a library slot is read, refused, and kept the same way", async () => {
  const env = ctx;
  const staged = stage(env, { kind: "library" }, LIBRARY_SLOT, { seed: 41 });
  const row = ctx.store.libraryState().shots.find((s) => s.filename === LIBRARY_SLOT);
  assert.equal(row.needsReview, true);
  assert.equal(row.harnessReview.code, "wrong-harness");
  assert.equal(row.harnessReview.neededLabel, "Standard (Classic) harness");
  assert.equal(row.verification.reasons[0].code, "wrong-harness");
  assert.deepEqual(ctx.store.library().readRecords()[LIBRARY_SLOT].reasons.map((r) => r.code), codes(OLD_REASONS), "the saved record is untouched");

  const refused = await call("POST", `/api/capture/library/screenshots/${LIBRARY_SLOT}/accept`);
  assert.equal(refused.status, 409);
  assert.equal(refused.json.code, "wrong-harness");
  assert.ok(existsSync(staged.image));
  const kept = await call("POST", `/api/capture/library/screenshots/${LIBRARY_SLOT}/keep-staged`);
  assert.equal(kept.status, 200, JSON.stringify(kept.json));
  assert.equal(existsSync(staged.image), false);
  assert.ok(!ctx.store.library().readRecords()[LIBRARY_SLOT], "no record is left for a slot that held nothing before");
  const entry = ctx.store.keptOverview().entries.find((e) => e.labId === "shared-library");
  assert.deepEqual(entry.pictures.map((p) => [p.base, p.why]), [[LIBRARY_SLOT, "wrong-harness"]]);
  ctx.store.removeKept(entry.id, entry.pictures[0].filename);
});

// ── Moving every wrong-harness picture ───────────────────────────────────────

test("the store's quarantine lists first and changes nothing, then --apply moves only the wrong-harness pictures", () => {
  const env = ctx;
  const [a, b, c] = ctx.lab.files;
  const scope = { kind: "lab", ...ctx.lab };
  const wrongLab = stage(env, scope, a, { seed: 51 });
  const unproven = stage(env, scope, b, { seed: 52, finalUrl: STANDARD_PAGE });
  const noEvidence = stage(env, scope, c, { seed: 53, evidence: null });
  const wrongLibrary = stage(env, { kind: "library" }, LIBRARY_SLOT, { seed: 54 });
  const tree = () => [listing(join(ctx.dataDir, "capture")), listing(join(ctx.lab.labDir, "screenshots")), listing(join(ctx.lab.labDir, "assets"))];
  const before = tree();

  const dry = ctx.store.quarantineWrongHarnessStaged({});
  assert.equal(dry.status, 200);
  assert.equal(dry.body.dryRun, true);
  assert.deepEqual(dry.body.pictures.map((p) => `${p.scope}:${p.filename}`).sort(), [`lab:${a}`, `library:${LIBRARY_SLOT}`].sort());
  assert.deepEqual(dry.body.counts, { pictures: 2, library: 1, lab: 1, labs: 1 });
  assert.match(dry.body.report, /2 staged pictures taken in the wrong harness would move to the kept pictures list/);
  assert.match(dry.body.report, /Nothing was changed/);
  assert.deepEqual(tree(), before, "a dry run changes nothing");
  assert.equal(ctx.store.keptOverview().entries.length, 0);

  const done = ctx.store.quarantineWrongHarnessStaged({ dryRun: false });
  assert.equal(done.status, 200);
  assert.deepEqual(done.body.failed, []);
  assert.equal(done.body.moved.length, 2);
  assert.equal(existsSync(wrongLab.image) || existsSync(wrongLab.meta), false);
  assert.equal(existsSync(wrongLibrary.image) || existsSync(wrongLibrary.meta), false);
  assert.ok(existsSync(unproven.image) && existsSync(noEvidence.image), "a picture that only lacks a proof is never moved");
  assert.equal(rowOf(env, ctx.lab.labId, b).needsReview, true);
  assert.ok(!readLabVerification(ctx.lab.labDir)[a], "the slot is as it was before the picture was staged");

  const entries = ctx.store.keptOverview().entries;
  const bytesOf = (entry) => ctx.store.keptPicture(entry.id, entry.pictures[0].filename).bytes;
  assert.deepEqual(entries.map((e) => e.reason), ["wrong-harness", "wrong-harness"]);
  const labEntry = entries.find((e) => e.labId === ctx.lab.labId);
  assert.deepEqual(bytesOf(labEntry), wrongLab.bytes, "the archive holds the staged bytes");
  assert.deepEqual(bytesOf(entries.find((e) => e.labId === "shared-library")), wrongLibrary.bytes);

  const again = ctx.store.quarantineWrongHarnessStaged({ dryRun: false });
  assert.deepEqual([again.body.moved.length, again.body.counts.pictures], [0, 0], "running it again moves nothing more");
  assert.equal(ctx.store.quarantineWrongHarnessStaged({ labId: "no-such-lab" }).status, 404);
  for (const entry of entries) ctx.store.removeKept(entry.id, entry.pictures[0].filename);
  ctx.store.reset(ctx.store.lab(ctx.lab.labId), b);
  ctx.store.reset(ctx.store.lab(ctx.lab.labId), c);
});

test("the command line tool is a dry run by default, --apply is a separate step, and a report is never written inside the repository", async () => {
  const root = tmp("wrong-harness-cli-");
  const storage = join(root, "storage");
  const generatedRoot = join(storage, "generated-labs");
  const dataDir = join(storage, "data");
  const libDir = join(storage, "screenshots");
  mkdirSync(generatedRoot, { recursive: true });
  mkdirSync(libDir, { recursive: true });
  const lab = await newLab(generatedRoot, ctx.emptyLabs);
  const env = { dataDir };
  const [a, , b] = lab.files;
  const wrong = stage(env, { kind: "lab", ...lab }, a, { seed: 61 });
  const unproven = stage(env, { kind: "lab", ...lab }, b, { seed: 62, finalUrl: STANDARD_PAGE });
  const wrongLibrary = stage(env, { kind: "library" }, LIBRARY_SLOT, { seed: 63 });
  const tree = () => [listing(storage)];
  const cli = (...args) => spawnSync(process.execPath, [join(REPO_ROOT, "tools", "lab-builder", "quarantine-wrong-harness.mjs"), `--library-dir=${libDir}`, `--root=${generatedRoot}`, `--data=${dataDir}`, ...args], { encoding: "utf8", env: { ...process.env, PORTAL_STORAGE_ROOT: "" } });
  const before = tree();

  const outside = tmp("wrong-harness-report-");
  const reportFile = join(outside, "report.md");
  const dry = cli(`--report=${reportFile}`);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /2 staged pictures taken in the wrong harness would move to the kept pictures list/);
  assert.match(dry.stdout, /Run again with --apply/);
  assert.ok(dry.stdout.includes(`Lab ${lab.labId}: ${a}`));
  assert.ok(!dry.stdout.includes(b), "an unproven picture is not listed");
  assert.deepEqual(tree(), before, "the default is a dry run: nothing changed");
  assert.match(readFileSync(reportFile, "utf8"), /Dry run \(nothing was changed\)/);
  assert.equal(cli("--dry-run").status, 0);
  assert.equal(cli("--apply", "--dry-run").status, 2, "the two choices exclude each other");
  assert.equal(cli("--dry-run", `--report=${join(REPO_ROOT, "tools", "report-should-not-exist.md")}`).status, 2, "never a report inside the repository");
  assert.equal(cli("--lab=no-such-lab").status, 2);

  const json = JSON.parse(cli("--json").stdout);
  assert.equal(json.mode, "dry-run");
  assert.deepEqual(json.pictures.map((p) => [p.scope, p.filename, p.needs, p.shows, p.read]).sort(), [["lab", a, "standard", "microsoft-copilot", "address"], ["library", LIBRARY_SLOT, "standard", "microsoft-copilot", "address"]].sort());

  const apply = cli("--apply");
  assert.equal(apply.status, 0, apply.stderr);
  assert.match(apply.stdout, /Moved 2 staged pictures to the kept pictures list/);
  assert.equal(existsSync(wrong.image) || existsSync(wrongLibrary.image), false);
  assert.ok(existsSync(unproven.image), "the unproven picture stays in review");
  const kept = createKeptStore({ keptDir: join(libDir, ".kept") });
  const entries = kept.list();
  assert.deepEqual(entries.map((e) => e.reason).sort(), ["wrong-harness", "wrong-harness"]);
  const labEntry = entries.find((e) => e.labId === lab.labId);
  assert.deepEqual(kept.read(labEntry.id, labEntry.pictures[0].filename).bytes, wrong.bytes, "archived byte for byte");
  assert.match(cli("--apply").stdout, /No pictures were moved|No staged picture was taken in the wrong harness/, "a second run has nothing to do");
});

// ── Accepted pictures that look wrong ────────────────────────────────────────

const picture = (id, { stamp = null, proof = null, finalUrl = null, confirmed = false, slotHarness = "standard", sha = id } = {}) => ({
  id,
  scope: "lab",
  labId: "lab",
  filename: id,
  sha256: sha,
  fingerprint: null,
  record: finalUrl ? { sha256: sha, state: "accepted", finalUrl } : null,
  confirmed,
  harnessStamp: stamp,
  harnessProof: proof,
  slot: { product: "copilot-studio", depth: null, label: id, harness: slotHarness },
});
const mismatch = (result) => result.flags.find((f) => f.code === FLAGS.HARNESS_MISMATCH);

test("an accepted picture is flagged when the address it was taken on names the other harness, even when a person's stamp says otherwise", () => {
  const [personStamped, kept, landmarks, landmarksAgree, onlyAddress, agreeing, standardAddress, library] = assessPictures([
    picture("person.png", { stamp: "standard", proof: "person", finalUrl: COPILOT_PREVIEW }),
    picture("kept.png", { stamp: "standard", proof: "person", finalUrl: COPILOT_PLAIN, confirmed: true }),
    picture("landmarks.png", { stamp: "standard", proof: "landmarks", finalUrl: COPILOT_PREVIEW }),
    picture("agree.png", { stamp: "standard", proof: "landmarks", finalUrl: STANDARD_PAGE }),
    picture("address.png", { finalUrl: COPILOT_PREVIEW }),
    picture("copilot-slot.png", { stamp: "microsoft-copilot", proof: "person", finalUrl: COPILOT_PREVIEW, slotHarness: "microsoft-copilot" }),
    picture("standard-address.png", { stamp: "standard", proof: "person", finalUrl: STANDARD_PAGE }),
    picture("library.png", { stamp: "standard", proof: "library", finalUrl: COPILOT_PREVIEW }),
  ]);
  assert.deepEqual([mismatch(personStamped)?.level, mismatch(personStamped)?.message], ["definite", WRONG], "a person accepted it in review; the address says otherwise");
  assert.equal(personStamped.level, "definite");
  assert.equal(personStamped.harnessSeen.id, "microsoft-copilot");
  assert.equal(personStamped.harnessSeen.source, "address");
  assert.ok(mismatch(kept), "Keep this one does not silence a harness mismatch");
  assert.equal(mismatch(landmarks), undefined, "the stamp the companion proved wins over the address");
  assert.equal(mismatch(landmarksAgree), undefined);
  assert.equal(landmarksAgree.level, null);
  assert.ok(mismatch(onlyAddress), "no stamp at all: the address names the harness");
  assert.equal(mismatch(agreeing), undefined, "a Microsoft Copilot slot with a Microsoft Copilot picture");
  assert.equal(mismatch(standardAddress), undefined);
  assert.equal(mismatch(library).message, WRONG, "a library stamp is a stamp, the address still contradicts it");
  assert.equal(FLAG_SHORT[FLAGS.HARNESS_MISMATCH], "taken in the other harness");
});

test("the stamp keeps its own sentence when no address contradicts it, and a proven stamp of the other harness is still wrong", () => {
  const [person, proven] = assessPictures([picture("person.png", { stamp: "microsoft-copilot", proof: "person" }), picture("proven.png", { stamp: "microsoft-copilot", proof: "landmarks", finalUrl: STANDARD_PAGE })]);
  assert.equal(mismatch(person).message, "This picture was taken in the Microsoft Copilot harness, but this screenshot needs the Standard (Classic) harness.");
  assert.equal(mismatch(proven).message, "This picture was taken in the Microsoft Copilot harness, but this screenshot needs the Standard (Classic) harness.");
  assert.equal(proven.harnessSeen.source, "proof");
});

test("the scan carries the stamp's proof and the address, so Pictures that look wrong lists an accepted picture of the wrong harness", async () => {
  const lab = ctx.lab;
  const [slot, second] = lab.files;
  const write = (filename, seed, harness, finalUrl) => {
    const bytes = png(seed);
    writeFileSync(join(lab.labDir, "assets", filename), bytes);
    writeLabVerificationRecord(lab.labDir, filename, { ok: true, level: "pass", state: "accepted", sha256: sha256Hex(bytes), source: "companion", redaction: { applied: true, masked: 1 }, evidenceVersion: 2, finalUrl, harness, acceptedAt: "2026-11-20T10:00:00.000Z" });
  };
  write(slot, 71, { id: "standard", proof: "person", at: "2026-11-20T10:00:00.000Z" }, COPILOT_PREVIEW);
  write(second, 72, { id: "standard", proof: "landmarks", at: "2026-11-20T10:00:00.000Z" }, COPILOT_PREVIEW);
  ctx.store.forgetSuspects();
  const found = ctx.store.suspectPictures({ labId: lab.labId }).body.pictures;
  const wrongOne = found.find((p) => p.scope === "lab" && p.filename === slot);
  assert.ok(wrongOne, "flagged");
  assert.equal(wrongOne.level, "definite");
  assert.ok(wrongOne.flags.some((f) => f.code === FLAGS.HARNESS_MISMATCH && f.message === WRONG));
  assert.deepEqual([wrongOne.pictureHarness, wrongOne.pictureHarnessLabel, wrongOne.pictureHarnessSource], ["microsoft-copilot", "Microsoft Copilot harness", "address"]);
  assert.equal(wrongOne.short.includes("taken in the other harness"), true);
  const proofRow = found.find((p) => p.scope === "lab" && p.filename === second);
  assert.ok(!proofRow || !proofRow.flags.some((f) => f.code === FLAGS.HARNESS_MISMATCH), "the companion read the page: the proof wins over the address");
  const item = ctx.store.scanPictures({ library: false, labIds: [lab.labId] }).items.find((i) => i.filename === second);
  assert.equal(item.pictureHarnessProof, "landmarks", "the stamp's proof is carried into the inventory");
});
