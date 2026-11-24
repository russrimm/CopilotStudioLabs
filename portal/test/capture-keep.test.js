/**
 * Captured screenshots survive a rebuild: replacing or deleting a lab keeps every real picture (carried to the new lab, shared,
 * or kept for 90 days), a failed capture never empties a slot, the library has a durable default home, and the library moves
 * between computers as a ZIP.
 *
 * Everything runs against throwaway folders with fake data and an injected home folder, so no test reads or writes a person's
 * real profile or library.
 */

import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ZipArchive } from "archiver";
import express from "express";

import { createBlobPersistence } from "../lib/blob-persistence.js";
import { createCapturePlatform } from "../lib/capture/index.js";
import { createKeptStore } from "../lib/capture/kept-pictures.js";
import { acquireShareLock, sha256Hex } from "../lib/capture/library-share.js";
import { buildLibraryExport, importLibraryZip } from "../lib/capture/library-transfer.js";
import { registerCaptureRoutes } from "../lib/capture/routes.js";
import { readZipEntries } from "../lib/capture/zip-read.js";
import { generateLab } from "../lib/lab-builder/generator.js";
import { deleteGeneratedLab, replaceGeneratedLab } from "../lib/lab-builder/generated-labs.js";
import { getLabScreenshotsStatus, writeLabVerificationRecord } from "../lib/lab-builder/lab-screenshots.js";
import { PLACEHOLDER_PATH } from "../lib/lab-builder/slots.js";
import { BAKED_CAPTURED_SCREENSHOTS_DIR, resolveCapturedScreenshotsDir } from "../lib/storage-config.js";
import { makePng } from "../../tools/screenshot-capture/test/fixtures/png.mjs";
import { libraryName } from "../../tools/screenshot-capture/harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "..", "..");
const cleanups = [];
const ctx = {};

function tmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const png = (seed) => makePng({ mode: "ui", seed });
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function newLab(features = ["mc-memory"], root = ctx.generatedRoot) {
  const build = await generateLab(
    { products: ["copilot-studio"], features, harness: "microsoft-copilot", includeCore: false },
    { outputRoot: root, labsDir: ctx.emptyLabs, useLearnMcp: false, useLlm: false },
  );
  const shots = JSON.parse(readFileSync(join(build.outputDir, "screenshots", "shots.json"), "utf8")).shots;
  return { labId: build.labId, labDir: build.outputDir, files: shots.map((s) => s.filename) };
}

/** A picture that is already in a lab's assets with the saved check a companion capture leaves (or none). */
function putPicture(lab, filename, bytes, { record = "masked" } = {}) {
  writeFileSync(join(lab.labDir, "assets", filename), bytes);
  if (record) {
    writeLabVerificationRecord(lab.labDir, filename, {
      ok: true,
      level: "pass",
      state: "accepted",
      sha256: sha256Hex(bytes),
      source: "companion",
      acceptedAt: "2026-01-01T00:00:00.000Z",
      redaction: record === "masked" ? { applied: true, masked: 1 } : null,
      // What a current companion capture leaves: the harness the page was proven to be in (the labs here are Microsoft Copilot harness labs).
      harness: { id: "microsoft-copilot", proof: "landmarks", at: "2026-01-01T00:00:00.000Z" },
    });
  }
}

/** A capture the way the companion uploads one: masked account details, an address that is not a sign-in page, the expected labels. */
function capture(store, labId, filename, { seed = 1, bytes, retake = false, acceptWarnings = false } = {}) {
  const target = store.lab(labId);
  const png1 = bytes ?? png(seed);
  const slot = target.slot(filename);
  const evidence = {
    finalUrl: "https://copilotstudio.microsoft.com/environments/00000000-0000-0000-0000-000000000000/bots",
    title: "Copilot Studio",
    visibleText: [...(slot.expectedLabels || []), "Settings"],
    redaction: { applied: true, masked: 2 },
    capturedAt: new Date().toISOString(),
    executedSteps: 4,
  };
  return { ...store.submit(target, filename, png1, { evidence, source: "companion", defer: true, requireEvidence: true, requireRedaction: true, retake, acceptWarnings }), bytes: png1 };
}

/** A library picture placed the way an upload would. */
function putLibrary(store, filename, bytes) {
  const result = store.submit(store.library(), filename, bytes, { source: "manual-upload" });
  assert.equal(result.status, 200, JSON.stringify(result.body));
}

// The labs here are built for the Microsoft Copilot harness, so the library keeps their pictures under the harness name.
const libName = (filename) => libraryName(filename, "microsoft-copilot");
const libraryFile = (filename) => join(ctx.libDir, libName(filename));
const keptEntries = () => ctx.store.keptOverview().entries;
const labPrevious = (lab, filename) => join(lab.labDir, "screenshots", ".previous", filename);

function newPlatform({ env, root = tmp("keep-platform-"), logs = null } = {}) {
  const generatedRoot = join(root, "labs");
  mkdirSync(generatedRoot, { recursive: true });
  const platform = createCapturePlatform({ generatedRoot, dataDir: join(root, "data"), env, detectServerBrowser: async () => ({ available: false }), logger: logs ? (line) => logs.push(line) : null });
  return { platform, store: platform.screenshots, generatedRoot, dataDir: join(root, "data"), root };
}

before(async () => {
  ctx.root = tmp("capture-keep-");
  ctx.storageRoot = join(ctx.root, "storage");
  ctx.generatedRoot = join(ctx.storageRoot, "generated-labs");
  ctx.dataDir = join(ctx.storageRoot, "data");
  ctx.libDir = join(ctx.storageRoot, "screenshots");
  ctx.keptDir = join(ctx.libDir, ".kept");
  ctx.emptyLabs = tmp("capture-keep-empty-labs-");
  ctx.logs = [];
  mkdirSync(ctx.generatedRoot, { recursive: true });
  ctx.platform = createCapturePlatform({
    generatedRoot: ctx.generatedRoot,
    dataDir: ctx.dataDir,
    env: { PORTAL_STORAGE_ROOT: ctx.storageRoot },
    detectServerBrowser: async () => ({ available: false }),
    logger: (line) => ctx.logs.push(line),
  });
  ctx.store = ctx.platform.screenshots;

  const app = express();
  app.use(express.json({ limit: "64kb" }));
  registerCaptureRoutes(app, { platform: ctx.platform, generatedRoot: ctx.generatedRoot, dataDir: ctx.dataDir, env: { PORTAL_STORAGE_ROOT: ctx.storageRoot } });
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

beforeEach(() => {
  rmSync(ctx.libDir, { recursive: true, force: true });
  rmSync(join(ctx.dataDir, "capture", "library-verification.json"), { force: true });
  ctx.logs.length = 0;
});

async function http(method, path, { json, body, headers } = {}) {
  const init = { method, headers: { ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...headers } };
  if (json !== undefined) init.body = JSON.stringify(json);
  else if (body !== undefined) init.body = body;
  let res;
  // A busy machine can reset an idle keep-alive connection; asking again is harmless for every request this test makes.
  for (let attempt = 1; ; attempt += 1) {
    try {
      res = await fetch(`${ctx.base}${path}`, init);
      break;
    } catch (err) {
      if (attempt >= 3 || err.cause?.code !== "ECONNRESET") throw err;
    }
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  let parsed = null;
  try {
    parsed = JSON.parse(buffer.toString("utf8"));
  } catch {
    parsed = null;
  }
  return { status: res.status, json: parsed, buffer, headers: res.headers };
}

// ── Replace ──────────────────────────────────────────────────────────────────

test("replacing a lab keeps every real picture: carried, shared, or kept, and a different library picture is never overwritten", async () => {
  const a = await newLab(["mc-memory"]);
  const b = await newLab(["mc-preview-test"]);
  const [carry, share, other, labOnly] = ["mc-create-agent-build.png", "mc-memory-toggle.png", "mc-knowledge-add-dialog.png", "custom-team-notes.png"];
  const same = ctx.store.libraryState().shots.find((s) => s.harness === "microsoft-copilot" && ![carry, share, other].includes(s.slotFilename))?.slotFilename;
  const bytes = { carry: png(1), share: png(2), other: png(3), labOnly: png(4), theirs: png(5), same: png(6) };

  putLibrary(ctx.store, libName(other), bytes.theirs);
  putLibrary(ctx.store, libName(same), bytes.same);
  putPicture(a, carry, bytes.carry);
  putPicture(a, share, bytes.share);
  putPicture(a, other, bytes.other);
  putPicture(a, labOnly, bytes.labOnly, { record: null });
  putPicture(a, same, bytes.same);

  const preview = ctx.store.previewLabPictures(a.labId, { newLabId: b.labId });
  assert.equal(preview.status, 200);
  assert.deepEqual(
    Object.fromEntries(Object.entries(preview.body.counts).filter(([k]) => k !== "retentionDays")),
    { total: 5, alreadyShared: 1, toShare: 1, shared: 2, carried: 1, kept: 2, earlierVersions: 0 },
  );
  assert.equal(existsSync(libraryFile(share)), false, "a preview changes nothing");

  const replaced = replaceGeneratedLab(ctx.generatedRoot, a.labId, b.labId);
  assert.equal(replaced.replaced, true, replaced.error);
  assert.equal(replaced.pictures.carried, 1);
  assert.equal(replaced.pictures.kept, 2);
  assert.equal(existsSync(a.labDir), false, "the old lab is removed only after its pictures are safe");

  assert.deepEqual(readFileSync(join(b.labDir, "assets", carry)), bytes.carry, "a slot of the new lab gets the picture");
  const carried = JSON.parse(readFileSync(join(b.labDir, "screenshots", "verification.json"), "utf8"));
  assert.equal(carried.shots[carry].sha256, sha(bytes.carry), "with its saved check");
  assert.deepEqual(readFileSync(libraryFile(share)), bytes.share, "an eligible picture is promoted to the shared library");
  assert.deepEqual(readFileSync(libraryFile(other)), bytes.theirs, "a different library picture is never overwritten");
  assert.equal(existsSync(`${libraryFile(other)}.previous`), false);

  const [entry] = keptEntries();
  assert.equal(keptEntries().length, 1);
  assert.equal(entry.reason, "replaced");
  assert.equal(entry.replacedBy, b.labId);
  assert.deepEqual(entry.pictures.map((p) => [p.filename, p.why]).sort(), [[labOnly, "lab-only"], [other, "library-has-one"]].sort());
  assert.deepEqual(ctx.store.keptPicture(entry.id, other).bytes, bytes.other);
  assert.deepEqual(ctx.store.keptPicture(entry.id, labOnly).bytes, bytes.labOnly);
  assert.equal(Math.round((Date.parse(entry.expiresAt) - Date.parse(entry.keptAt)) / 86400000), 90, "kept for 90 days");
  assert.equal(entry.daysLeft, 90);
  const restoreOf = (name) => entry.pictures.find((p) => p.filename === name).restore;
  assert.deepEqual(restoreOf(labOnly), [], "a picture with no slot anywhere has no automatic place, so it is downloaded");
});

test("a lab's pictures are copied to the new lab only where it has no picture of its own; the rest stays safe", async () => {
  const a = await newLab(["mc-memory"]);
  const b = await newLab(["mc-memory"]);
  const [first, second] = a.files;
  putPicture(a, first, png(11), { record: null });
  putPicture(a, second, png(12));
  putPicture(b, first, png(13));
  const result = ctx.store.carryLabPictures(a.labId, { newLabId: b.labId });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(readFileSync(join(b.labDir, "assets", first)), png(13), "the new lab's own picture is never replaced");
  assert.deepEqual(readFileSync(join(b.labDir, "assets", second)), png(12));
  assert.equal(result.counts.carried, 1);
  assert.deepEqual(keptEntries()[0].pictures.map((p) => [p.filename, p.why]), [[first, "harness-not-recorded"]], "the picture that could not be carried or shared is kept (no harness is recorded for it)");
});

// ── Delete ───────────────────────────────────────────────────────────────────

test("deleting a lab shares what it may, keeps the rest for 90 days, and says so beforehand", async () => {
  const lab = await newLab(["mc-memory"]);
  const [, share] = lab.files;
  putPicture(lab, share, png(21));
  putPicture(lab, "my-own-shot.png", png(22), { record: null });
  const empty = await newLab(["mc-memory"]);

  const preview = ctx.store.previewLabPictures(lab.labId);
  assert.equal(preview.body.counts.toShare, 1);
  assert.equal(preview.body.counts.kept, 1);
  assert.equal(ctx.store.previewLabPictures(empty.labId).body.counts.total, 0, "placeholders are not pictures");

  const removed = deleteGeneratedLab(ctx.generatedRoot, lab.labId);
  assert.equal(removed.status, 200);
  assert.equal(removed.body.pictures.shared, 1);
  assert.equal(removed.body.pictures.kept, 1);
  assert.deepEqual(readFileSync(libraryFile(share)), png(21));
  assert.equal(existsSync(lab.labDir), false);
  const [entry] = keptEntries();
  assert.equal(entry.reason, "deleted");
  assert.deepEqual(entry.pictures.map((p) => p.filename), ["my-own-shot.png"]);

  assert.equal(deleteGeneratedLab(ctx.generatedRoot, empty.labId).status, 200);
  assert.equal(keptEntries().length, 1, "a lab with no real picture leaves nothing behind");
  assert.ok(ctx.logs.some((line) => /Kept 1 picture\(s\) from/.test(line)));
});

test("when the pictures cannot be kept, the lab is left exactly as it was, with a plain error", async () => {
  const lab = await newLab(["mc-memory"]);
  putPicture(lab, "my-own-shot.png", png(31), { record: null });
  mkdirSync(ctx.libDir, { recursive: true });
  writeFileSync(ctx.keptDir, "in the way");

  const blocked = deleteGeneratedLab(ctx.generatedRoot, lab.labId);
  assert.ok(blocked.status >= 400);
  assert.match(blocked.body.error, /nothing was removed/);
  assert.equal(blocked.body.labKept, true);
  assert.deepEqual(readFileSync(join(lab.labDir, "assets", "my-own-shot.png")), png(31), "the old lab and its picture are untouched");

  rmSync(ctx.keptDir, { force: true });
  assert.equal(deleteGeneratedLab(ctx.generatedRoot, lab.labId).status, 200, "and the delete works once the problem is gone");
});

test("two changes to one lab's pictures never overlap, and running the keep twice changes nothing more", async () => {
  const lab = await newLab(["mc-memory"]);
  putPicture(lab, "my-own-shot.png", png(41), { record: null });
  const release = acquireShareLock(ctx.keptDir, `lab-${lab.labId}`);
  assert.ok(release);
  const busy = deleteGeneratedLab(ctx.generatedRoot, lab.labId);
  assert.equal(busy.status, 409);
  assert.match(busy.body.error, /in progress/);
  assert.equal(existsSync(lab.labDir), true);
  release();

  const first = ctx.store.carryLabPictures(lab.labId);
  const again = ctx.store.carryLabPictures(lab.labId);
  assert.equal(first.ok && again.ok, true);
  assert.deepEqual(again.counts, first.counts);
  assert.equal(keptEntries().length, 1, "the same picture is kept once");
  assert.equal(readdirSync(ctx.keptDir).filter((name) => name.includes(".blob-tmp-") && !name.endsWith("share-lock")).length, 0, "no half-written entry is left");
});

test("a lab that failed to build keeps the pictures captured for it, and its folder stays when they cannot be kept", async () => {
  const root = join(ctx.storageRoot, "generated-labs");
  const before = new Set(readdirSync(root));
  const dropPicture = () => {
    const made = readdirSync(root).find((name) => !before.has(name));
    writeFileSync(join(root, made, "assets", "mc-memory-toggle.png"), png(51));
    return made;
  };
  let made = null;
  await assert.rejects(
    generateLab(
      { products: ["copilot-studio"], features: ["mc-memory"], harness: "microsoft-copilot", includeCore: false },
      {
        outputRoot: root,
        labsDir: ctx.emptyLabs,
        useLearnMcp: false,
        useLlm: false,
        captureScreenshots: true,
        onProgress: ({ stage }) => {
          if (stage !== "screenshots") return;
          made = dropPicture();
          throw new Error("The build stopped.");
        },
      },
    ),
    /The build stopped/,
  );
  assert.equal(existsSync(join(root, made)), false, "the failed lab is removed");
  const [entry] = keptEntries();
  assert.equal(entry.reason, "failed-build");
  assert.deepEqual(ctx.store.keptPicture(entry.id, "mc-memory-toggle.png").bytes, png(51));
});

// ── Retake and discard ───────────────────────────────────────────────────────

test("a retake that fails or is rejected leaves the old picture; a discard keeps a backup and never touches the picture in place", async () => {
  const lab = await newLab(["mc-memory"]);
  const [filename] = lab.files;
  const store = ctx.store;
  const first = capture(store, lab.labId, filename, { seed: 61 });
  assert.equal(first.status, 200);
  const asset = join(lab.labDir, "assets", filename);
  const records = () => JSON.parse(readFileSync(join(lab.labDir, "screenshots", "verification.json"), "utf8")).shots;

  const blank = capture(store, lab.labId, filename, { bytes: makePng({ mode: "blank", width: 800, height: 600 }), retake: true });
  assert.equal(blank.status, 422, "a rejected retake");
  assert.deepEqual(readFileSync(asset), first.bytes, "the old picture stays");
  assert.equal(records()[filename].state, "accepted");

  const staged = capture(store, lab.labId, filename, { bytes: makePng({ mode: "mostly", seed: 62 }), retake: true });
  assert.equal(staged.status, 202, "a retake that needs a look waits for review");
  assert.deepEqual(readFileSync(asset), first.bytes, "and the old picture stays in place until a new one is accepted");
  assert.equal(records()[filename].state, "needs-review");
  const discarded = store.reset(store.lab(lab.labId), filename);
  assert.equal(discarded.body.discardedStaged, true);
  assert.deepEqual(readFileSync(asset), first.bytes, "discarding the waiting picture does not discard the one in place");
  assert.equal(records()[filename].state, "accepted", "and its own check comes back");
  assert.equal(records()[filename].sha256, sha(first.bytes));

  const second = capture(store, lab.labId, filename, { seed: 63, retake: true });
  assert.equal(second.status, 200);
  assert.deepEqual(readFileSync(asset), second.bytes);
  assert.deepEqual(readFileSync(labPrevious(lab, filename)), first.bytes, "the replaced picture is kept as the lab's backup");
  assert.equal(readdirSync(join(lab.labDir, "assets")).some((name) => name.endsWith(".previous")), false, "never beside the assets a lab export carries");

  const gone = store.reset(store.lab(lab.labId), filename);
  assert.equal(gone.body.removedImage, true);
  assert.deepEqual(readFileSync(labPrevious(lab, filename)), second.bytes, "a discarded picture stays recoverable");
  const row = getLabScreenshotsStatus(ctx.generatedRoot, lab.labId, { capturedDir: [ctx.libDir] }).body.shots.find((s) => s.filename === filename);
  assert.equal(row.capturedInLab, false, "the lab no longer has its own picture");
  assert.equal(row.imageSource, "library", "and shows the shared one, which a lab discard does not touch");
  assert.deepEqual(readFileSync(libraryFile(filename)), second.bytes);
});

// ── Kept pictures: list, restore, delete forever, retention ──────────────────

test("kept pictures can be restored without overwriting anything, deleted forever, and purged after 90 days", async () => {
  const a = await newLab(["mc-memory"]);
  const b = await newLab(["mc-memory"]);
  const [slotName] = a.files;
  putPicture(a, slotName, png(71), { record: "unmasked" });
  putPicture(a, "my-own-shot.png", png(72), { record: null });
  const removed = deleteGeneratedLab(ctx.generatedRoot, a.labId);
  assert.equal(removed.status, 200);
  const [entry] = keptEntries();
  const kept = entry.pictures.find((p) => p.filename === slotName);
  assert.equal(kept.why, "masking-unproven");
  assert.deepEqual(kept.restore.map((o) => o.type), ["library"], "the lab it came from is gone, so the library is offered");

  assert.equal(ctx.store.restoreKept(entry.id, slotName, { to: "library" }).status, 400, "sharing with every lab needs confirmation");
  const restored = ctx.store.restoreKept(entry.id, slotName, { to: "library", confirm: true });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.deepEqual(readFileSync(libraryFile(slotName)), png(71));
  assert.equal(keptEntries()[0].pictures.some((p) => p.filename === slotName), false, "restored pictures leave the archive");
  assert.equal(ctx.store.restoreKept(entry.id, slotName, { to: "library", confirm: true }).status, 404);

  const other = keptEntries()[0].pictures.find((p) => p.filename === "my-own-shot.png");
  assert.equal(ctx.store.restoreKept(entry.id, other.filename, { to: "lab", labId: b.labId }).status, 409, "no slot, so no automatic place");
  assert.equal(ctx.store.removeKept(entry.id, other.filename).status, 200);
  assert.equal(keptEntries().length, 0, "deleting the last picture removes the entry");
  assert.equal(existsSync(join(ctx.keptDir, entry.id)), false);

  // Retention: an entry is purged only when its 90 days are up, with one plain log line.
  const lines = [];
  let clock = Date.parse("2026-03-01T00:00:00Z");
  const store = createKeptStore({ keptDir: tmp("keep-retention-"), now: () => clock, logger: (line) => lines.push(line) });
  store.archive({ labId: "old-lab", reason: "deleted", pictures: [{ filename: "a.png", bytes: png(73), why: "lab-only" }] });
  clock += 89 * 86400000;
  assert.deepEqual(store.purge().removed, []);
  assert.equal(store.list()[0].daysLeft, 1);
  clock += 2 * 86400000;
  assert.equal(store.purge().removed.length, 1);
  assert.equal(store.list().length, 0);
  assert.match(lines.at(-1), /Removed 1 kept picture\(s\) from old-lab: they were kept for 90 days \(since 2026-03-01\)/);
});

// ── Export and import ────────────────────────────────────────────────────────

async function zipOf(files, patch = (zip) => zip) {
  return new Promise((resolveZip, reject) => {
    const archive = new ZipArchive();
    const chunks = [];
    archive.on("data", (c) => chunks.push(c));
    archive.on("error", reject);
    archive.on("end", () => resolveZip(patch(Buffer.concat(chunks))));
    for (const [name, bytes] of Object.entries(files)) archive.append(bytes, { name });
    archive.finalize();
  });
}

test("the library exports to a ZIP with a trimmed manifest and imports with the same checks as an upload", async () => {
  const slots = ctx.store.libraryState().shots.map((s) => s.filename);
  const [s1, s2, s3, s4] = slots;
  const lab = await newLab(["mc-memory"]);
  const labSlot = lab.files[0];
  assert.equal(capture(ctx.store, lab.labId, labSlot, { seed: 81 }).status, 200);
  putLibrary(ctx.store, s1, png(82));
  putLibrary(ctx.store, s2, png(83));
  assert.equal(ctx.store.confirm(ctx.store.library(), s1).status, 200);

  const exported = await buildLibraryExport(ctx.store);
  assert.equal(exported.count, 3);
  const entries = readZipEntries(exported.buffer);
  const names = entries.map((e) => e.name).sort();
  assert.ok(names.includes("manifest.json") && names.includes(`pictures/${s1}`));
  const manifestText = entries.find((e) => e.name === "manifest.json").read().toString("utf8");
  assert.ok(!/copilotstudio\.microsoft\.com|finalUrl|pageTitle|"title"/.test(manifestText), "the manifest carries no addresses or page titles");
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.pictures[s1].sha256, sha(png(82)));
  assert.ok(manifest.pictures[s1].confirmedAt, "Confirmed marks travel");
  assert.equal(manifest.pictures[s2].confirmedAt, null);
  assert.match(manifest.warning, /no account names/);
  assert.equal(entries.some((e) => e.name.endsWith(".previous")), false);

  // Another computer: import the same ZIP.
  const other = newPlatform({ env: { PORTAL_STORAGE_ROOT: tmp("keep-import-") } });
  const result = importLibraryZip(other.store, exported.buffer);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.counts.imported, 3);
  assert.match(result.body.message, /^3 pictures imported\./);
  assert.ok(other.store.libraryState().shots.find((s) => s.filename === s1).confirmed, "the Confirmed mark comes back for the same picture");
  assert.equal(other.store.libraryState().shots.find((s) => s.filename === s2).confirmed, null);

  // Again: nothing is replaced unless the person chooses it.
  assert.equal(importLibraryZip(other.store, exported.buffer).body.counts.skipped, 3);
  const changed = await zipOf({ [`pictures/${s1}`]: png(84), [`${s3}`]: png(85), [`pictures/${s4}`]: readFileSync(PLACEHOLDER_PATH), "pictures/not-a-screenshot-name.png": png(86), "__/evil.png": png(87), "pictures/__/evil2.png": png(87), "folder/deep/x.png": png(88) }, (zip) =>
    // An archive tool cleans "../" out of names, so the traversal names are written the way a hostile ZIP would carry them.
    Buffer.from(zip.toString("latin1").replaceAll("__/evil", "../evil"), "latin1"),
  );
  const dry = importLibraryZip(other.store, changed, { dryRun: true });
  assert.equal(dry.body.counts.imported, 1, "a dry run reports what would happen");
  assert.equal(other.store.libraryState().shots.find((s) => s.filename === s3).captured, false, "and imports nothing");
  const skipped = importLibraryZip(other.store, changed);
  assert.deepEqual(skipped.body.skipped.map((r) => [r.filename, r.code]), [[s1, "exists"]]);
  assert.deepEqual(skipped.body.imported.map((r) => r.filename), [s3]);
  assert.deepEqual(skipped.body.rejected.map((r) => [r.filename, r.code]).sort(), [[s4, "placeholder"], ["not-a-screenshot-name.png", "not-a-slot"]].sort());
  assert.equal(skipped.body.ignored.length, 3, "paths and traversal names are ignored and never read");
  const replaced = importLibraryZip(other.store, await zipOf({ [`pictures/${s1}`]: png(84) }), { replace: true });
  assert.equal(replaced.body.counts.replaced, 1);

  // Bad input never crashes.
  assert.equal(importLibraryZip(other.store, Buffer.from("not a zip file at all, just text")).status, 400);
  assert.equal(importLibraryZip(other.store, Buffer.alloc(0)).status, 400);
});

test("the export and import routes and the command-line tools do the same thing", async () => {
  const slots = ctx.store.libraryState().shots.map((s) => s.filename);
  putLibrary(ctx.store, slots[0], png(91));
  const exported = await http("GET", "/api/capture/library/export");
  assert.equal(exported.status, 200);
  assert.equal(exported.headers.get("content-type"), "application/zip");
  assert.match(exported.headers.get("content-disposition"), /shared-screenshots\.zip/);
  assert.match(exported.headers.get("x-export-warning"), /account names/);
  assert.ok(readZipEntries(exported.buffer).some((e) => e.name === `pictures/${slots[0]}`));

  const target = newPlatform({ env: { PORTAL_STORAGE_ROOT: tmp("keep-route-") } });
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  registerCaptureRoutes(app, { platform: target.platform, generatedRoot: target.generatedRoot, dataDir: target.dataDir, env: { PORTAL_STORAGE_ROOT: target.root } });
  const server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const form = new FormData();
    form.append("file", new Blob([exported.buffer], { type: "application/zip" }), "shared-screenshots.zip");
    const dry = await (await fetch(`${base}/api/capture/library/import?dryRun=true`, { method: "POST", body: form })).json();
    assert.equal(dry.counts.imported, 1);
    assert.equal(target.store.libraryState().summary.captured, 0, "a dry run imports nothing");
    const raw = await (await fetch(`${base}/api/capture/library/import`, { method: "POST", headers: { "Content-Type": "application/zip" }, body: exported.buffer })).json();
    assert.equal(raw.counts.imported, 1);
    assert.equal((await fetch(`${base}/api/capture/library/import`, { method: "POST", headers: { "Content-Type": "application/zip" }, body: Buffer.from("nope") })).status, 400);
  } finally {
    server.close();
  }

  // The command-line tools: --dry-run reports, --apply writes.
  const work = tmp("keep-cli-");
  const zip = join(work, "out.zip");
  const cli = (script, ...args) => spawnSync(process.execPath, [join(REPO_ROOT, "tools", "lab-builder", script), ...args], { cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, PORTAL_STORAGE_ROOT: "", FEATURE_TOUR_SCREENSHOTS_DIR: "" } });
  const common = [`--library=${ctx.libDir}`, `--data=${ctx.dataDir}`];
  assert.equal(cli("export-screenshots.mjs", ...common).status, 2, "one of --dry-run or --apply is required");
  const dryExport = cli("export-screenshots.mjs", "--dry-run", ...common);
  assert.equal(dryExport.status, 0, dryExport.stderr);
  assert.match(dryExport.stdout, /1 picture would be exported/);
  assert.equal(existsSync(zip), false);
  const applyExport = cli("export-screenshots.mjs", "--apply", `--out=${zip}`, ...common);
  assert.equal(applyExport.status, 0, applyExport.stderr);
  assert.match(applyExport.stdout, /no account names/);
  assert.ok(existsSync(zip));

  const dest = [`--library=${join(work, "lib")}`, `--data=${join(work, "data")}`];
  const dryImport = cli("import-screenshots.mjs", "--dry-run", `--zip=${zip}`, ...dest);
  assert.equal(dryImport.status, 0, dryImport.stderr);
  assert.match(dryImport.stdout, /1 picture would be imported/);
  assert.equal(existsSync(join(work, "lib", slots[0])), false);
  const applyImport = cli("import-screenshots.mjs", "--apply", `--zip=${zip}`, ...dest);
  assert.equal(applyImport.status, 0, applyImport.stderr);
  assert.deepEqual(readFileSync(join(work, "lib", slots[0])), png(91));
  assert.match(cli("import-screenshots.mjs", "--apply", `--zip=${zip}`, ...dest).stdout, /1 skipped because the library already has it/);
});

// ── HTTP: preview, kept pictures, status ─────────────────────────────────────

test("the routes preview a delete, list and restore kept pictures, and ask before deleting one forever", async () => {
  const lab = await newLab(["mc-memory"]);
  putPicture(lab, "my-own-shot.png", png(101), { record: null });
  const preview = await http("GET", `/api/lab-builder/generated/${lab.labId}/pictures`);
  assert.equal(preview.status, 200);
  assert.equal(preview.json.counts.kept, 1);
  assert.equal((await http("GET", "/api/lab-builder/generated/not-a-lab/pictures")).status, 404);

  assert.equal(deleteGeneratedLab(ctx.generatedRoot, lab.labId).status, 200);
  const list = await http("GET", "/api/capture/kept");
  assert.equal(list.json.retentionDays, 90);
  const [entry] = list.json.entries;
  const file = entry.pictures[0].filename;
  const bytes = await http("GET", `/api/capture/kept/${entry.id}/${file}?download=1`);
  assert.deepEqual(bytes.buffer, png(101));
  assert.match(bytes.headers.get("content-disposition"), /attachment/);
  assert.equal((await http("GET", `/api/capture/kept/${entry.id}/..%2F..%2Fx.png`)).status, 400);
  assert.equal((await http("POST", `/api/capture/kept/${entry.id}/${file}/restore`, { json: {} })).status, 409);

  assert.equal((await http("DELETE", `/api/capture/kept/${entry.id}/${file}`)).status, 400, "delete forever needs the confirmation in the request");
  assert.equal((await http("DELETE", `/api/capture/kept/${entry.id}/${file}?confirm=true`)).status, 200);
  assert.equal((await http("GET", "/api/capture/kept")).json.entries.length, 0);
});

test("the status says where the shared screenshots are saved, and names the folder only to a person at the computer", async () => {
  // Storage root (the cloud and containers): never a path.
  const cloud = await http("GET", "/api/capture/status");
  assert.equal(cloud.json.sharedLibrary.kind, "storage-root");
  assert.equal(cloud.json.sharedLibrary.persistent, true);
  assert.equal(cloud.json.sharedLibrary.summary, "Shared screenshots are saved on this portal's storage volume.");
  assert.ok(!JSON.stringify(cloud.json).includes(ctx.storageRoot));
  const azure = newPlatform({ env: { PORTAL_STORAGE_ROOT: tmp("keep-azure-"), AZURE_STORAGE_BLOB_ENDPOINT: "https://example.blob.core.windows.net" } });
  const azureStatus = await azure.platform.statusPayload({ localRequest: true });
  assert.equal(azureStatus.sharedLibrary.summary, "Shared screenshots are saved in Azure storage.");
  assert.equal(azureStatus.sharedLibrary.folder, undefined);

  // A computer with no setting: the per-user folder, named to the person at it.
  const home = tmp("keep-home-");
  const env = { LOCALAPPDATA: home, XDG_DATA_HOME: home, HOME: home, USERPROFILE: home };
  const local = newPlatform({ env });
  const folder = resolveCapturedScreenshotsDir(env);
  assert.notEqual(folder, BAKED_CAPTURED_SCREENSHOTS_DIR);
  assert.ok(folder.startsWith(home));
  const mine = await local.platform.statusPayload({ localRequest: true });
  assert.equal(mine.sharedLibrary.kind, "user-folder");
  assert.equal(mine.sharedLibrary.persistent, true);
  assert.equal(mine.sharedLibrary.folder, folder);
  assert.equal(mine.sharedLibrary.summary, `Shared screenshots are saved on this computer in ${folder}`);
  assert.equal((await local.platform.statusPayload({ localRequest: false })).sharedLibrary.folder, undefined);
  assert.equal(mine.sharedLibrary.notice, null, "nothing to announce while the folder is empty");

  // The one-time notice when the default folder already holds pictures.
  mkdirSync(folder, { recursive: true });
  const slot = local.store.libraryState().shots[0].filename;
  writeFileSync(join(folder, slot), png(111));
  const found = (await local.platform.statusPayload({ localRequest: true })).sharedLibrary.notice;
  assert.match(found.text, /^Found your shared screenshots in .+: 1 picture is ready to reuse in every lab\.$/);
  local.platform.dismissLocationNotice();
  assert.equal((await local.platform.statusPayload({ localRequest: true })).sharedLibrary.notice, null, "shown once");
});

test("a computer with no setting saves a verified capture to its per-user folder, so the next lab can reuse it", async () => {
  const home = tmp("keep-auto-");
  const env = { LOCALAPPDATA: home, XDG_DATA_HOME: home, HOME: home, USERPROFILE: home };
  const mine = newPlatform({ env });
  const lab = await newLab(["mc-memory"], mine.generatedRoot);
  const next = await newLab(["mc-memory"], mine.generatedRoot);
  const [filename] = lab.files;
  const result = capture(mine.store, lab.labId, filename, { seed: 121 });
  assert.equal(result.status, 200);
  assert.equal(result.body.library.outcome, "shared", "no environment variable is needed for automatic sharing");
  assert.deepEqual(readFileSync(join(resolveCapturedScreenshotsDir(env), libName(filename))), result.bytes);
  assert.equal(getLabScreenshotsStatus(mine.generatedRoot, next.labId, { capturedDir: [resolveCapturedScreenshotsDir(env)] }).body.shots.find((s) => s.filename === filename).captured, true);
  // Deleting the lab that took it changes nothing for the next one, and nothing needs keeping.
  assert.equal(deleteGeneratedLab(mine.generatedRoot, lab.labId).status, 200);
  assert.deepEqual(readFileSync(join(resolveCapturedScreenshotsDir(env), libName(filename))), result.bytes);
  assert.equal(mine.store.keptOverview().entries.length, 0);
});

// ── Azure Blob ───────────────────────────────────────────────────────────────

test("the kept-pictures archive is mirrored to Azure Blob, hydrated at start, and removed when it expires", async () => {
  const lab = await newLab(["mc-memory"]);
  putPicture(lab, "my-own-shot.png", png(131), { record: null });
  assert.equal(deleteGeneratedLab(ctx.generatedRoot, lab.labId).status, 200);
  const [entry] = keptEntries();
  const stuck = join(ctx.keptDir, `.blob-tmp-${process.pid}-half-written`);
  mkdirSync(join(stuck, "pictures"), { recursive: true });
  writeFileSync(join(stuck, "pictures", "half.png"), "partial");

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
      blobs.set(name, Buffer.from(init.body));
      return new Response(null, { status: 201 });
    }
    if (method === "DELETE") {
      blobs.delete(name);
      return new Response(null, { status: 202 });
    }
    return blobs.has(name) ? new Response(blobs.get(name), { status: 200 }) : new Response(null, { status: 404 });
  };
  const mirrorFor = (storageRoot) =>
    createBlobPersistence({
      env: { PORTAL_STORAGE_ROOT: storageRoot, LAB_BUILDER_OUTPUT_DIR: join(storageRoot, "generated-labs"), AZURE_STORAGE_BLOB_ENDPOINT: "https://example.blob.core.windows.net" },
      fetchImpl: fakeFetch,
      tokenProvider: () => "test-token",
      retryBaseDelayMs: 0,
    });

  await mirrorFor(ctx.storageRoot).syncToBlob();
  assert.deepEqual(blobs.get(`screenshots/.kept/${entry.id}/pictures/my-own-shot.png`), png(131), "the kept picture is uploaded");
  assert.ok(blobs.has(`screenshots/.kept/${entry.id}/entry.json`), "with the record that says what it is and when it expires");
  assert.equal([...blobs.keys()].some((name) => name.includes(".blob-tmp-")), false, "a half-written entry and locks are never uploaded");

  // A new container starts empty and hydrates everything back, including the archive.
  const fresh = tmp("keep-hydrate-");
  const hydrated = mirrorFor(fresh);
  await hydrated.hydrateFromBlob();
  const store = createKeptStore({ keptDir: join(fresh, "screenshots", ".kept") });
  assert.deepEqual(store.list().map((e) => [e.id, e.pictures.map((p) => p.filename)]), [[entry.id, ["my-own-shot.png"]]]);

  // When the retention is over, the purge removes it and the mirror removes the blobs.
  const aged = createKeptStore({ keptDir: join(fresh, "screenshots", ".kept"), now: () => Date.now() + 91 * 86400000 });
  assert.equal(aged.purge().removed.length, 1);
  await hydrated.syncToBlob();
  assert.equal([...blobs.keys()].some((name) => name.includes("/.kept/")), false, "expired pictures leave Azure storage too");
});

// ── The default home for the library ─────────────────────────────────────────

test("under the test runner a plain environment keeps the committed folder, so no test touches a person's real library", () => {
  assert.equal(resolveCapturedScreenshotsDir(), BAKED_CAPTURED_SCREENSHOTS_DIR);
});
