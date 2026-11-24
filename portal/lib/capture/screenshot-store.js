/**
 * Stores, stages, accepts, and resets screenshots for a generated lab or for the
 * shared library. Every image passes `verifyUpload` first:
 *
 *   fail  -> rejected, nothing is written
 *   warn  -> staged for a person to look at, then accepted (or discarded)
 *   pass  -> committed immediately
 *
 * Committing a lab image also clears the shot's stale flag, recomputes the lab's
 * Learn sync status, and regenerates the lab's HTML, Word, and PowerPoint files
 * through `refreshGeneratedLabOutputs`. Committing a library image makes every
 * lab that uses the slot show it.
 *
 * "Capture once, reuse everywhere": a good lab picture for a shared slot is also placed in the
 * library (see `promote` and library-share.js), so the next lab does not retake it. The library
 * is never overwritten silently, a picture marked accurate is never replaced automatically, and a
 * replaced picture is kept as a one-deep `.previous` backup.
 */

import fs from "node:fs";
import path from "node:path";

import { lockPathFor, withFileLockSync } from "../concurrency/file-lock.js";
import { capturedImage, capturedScreenshotsDirs, isRealScreenshotBytes, resolveLabScreenshot } from "../lab-builder/captured.js";
import {
  getLabScreenshotsStatus,
  readLabConfirmations,
  readLabVerification,
  recordLabShotCaptured,
  recordLabShotReset,
  refreshGeneratedLabOutputs,
  withShotHarness,
  writeLabConfirmation,
  writeLabVerificationRecord,
} from "../lab-builder/lab-screenshots.js";
import { PLACEHOLDER_PATH } from "../lab-builder/slots.js";
import { isPlaceholder } from "../lab-builder/placeholder-detect.js";
import { BAKED_CAPTURED_SCREENSHOTS_DIR, resolveKeptScreenshotsDir } from "../storage-config.js";
import { fingerprintPicture, isFingerprint } from "../../../tools/screenshot-capture/fingerprint.mjs";
import { expectedLabelsForShot } from "./classify.js";
import { baseFilename, createKeptStore, isKeptPictureName, isRestorable } from "./kept-pictures.js";
import { createPictureScanner } from "./picture-inventory.js";
import { assessPictures, noticeText, shortReason } from "./picture-integrity.js";
import {
  PREVIOUS_SUFFIX,
  SHARE_LOCK_WAIT_MS,
  SHARE_MESSAGES,
  acquireShareLock,
  fileSha256,
  harnessStampOf,
  makeConfirmation,
  makeHarnessStamp,
  readRecordsFile,
  replacementVerdict,
  sha256Hex,
  shareVerdict,
  validConfirmation,
  withShareLockSync,
  writeRecordsFile,
} from "./library-share.js";
import { findLibrarySlot, isLibrarySlotName, labSlotFilenames, libraryShotIndex, listLibrarySlots, listUnrecordedLibraryPictures } from "./plan.js";
import { cleanText, readJson, writeBytesAtomic, writeJsonAtomic } from "./store-util.js";
import { summarizeVerification, verifyUpload } from "./verify-upload.js";
import { HARNESS_SHORT, harnessGapMessage, harnessLabel, isSpecificHarness, libraryName, normalizeHarness, pictureFitsSlot, pictureHarnessLabel } from "../../../tools/screenshot-capture/harness.mjs";

const REFRESH_DELAY_MS = 2500;
const MAX_REFRESH_LABS = 50;
const MAX_USAGE_LABS = 300;

function sidecarName(filename) {
  return `${filename.replace(/\.[^.]+$/, "")}.callouts.json`;
}

/** Where a lab keeps the picture a newer one replaced (hidden, so a lab export never carries it). */
const labPreviousDir = (labDir) => path.join(labDir, "screenshots", ".previous");

/**
 * Keep the lab's current real picture for `filename` as its one-deep backup before it is replaced or discarded.
 * A picture identical to the one replacing it needs no backup.
 */
function keepLabPrevious(labDir, filename, nextBytes = null) {
  let bytes;
  try {
    bytes = fs.readFileSync(path.join(labDir, "assets", filename));
  } catch {
    return false;
  }
  if (!isRealScreenshotBytes(bytes, path.extname(filename).toLowerCase())) return false;
  if (nextBytes && sha256Hex(nextBytes) === sha256Hex(bytes)) return false;
  writeBytesAtomic(path.join(labPreviousDir(labDir), filename), bytes);
  return true;
}

/** A lab's real pictures (and its earlier versions), read from its folder: `[{ filename, bytes, earlier }]`. */
function readLabPictures(labDir) {
  const out = [];
  for (const [dir, earlier] of [[path.join(labDir, "assets"), false], [labPreviousDir(labDir), true]]) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink() || !isKeptPictureName(entry.name) || /\.previous$/i.test(entry.name)) continue;
      let bytes;
      try {
        bytes = fs.readFileSync(path.join(dir, entry.name));
      } catch (err) {
        throw new Error(`Could not read the picture ${entry.name}: ${err.message}`);
      }
      if (isRealScreenshotBytes(bytes, path.extname(entry.name).toLowerCase())) out.push({ filename: entry.name, bytes, earlier });
    }
  }
  return out;
}

function cleanCallouts(callouts) {
  if (!Array.isArray(callouts)) return null;
  const items = callouts.slice(0, 12).map((c, i) => {
    const r = c?.rect;
    const ok = r && ["x", "y", "w", "h"].every((k) => Number.isFinite(Number(r[k])) && Number(r[k]) >= 0 && Number(r[k]) <= 1);
    return {
      n: Number.isInteger(c?.n) ? c.n : i + 1,
      label: cleanText(c?.label, 80),
      rect: ok ? { x: Number(r.x), y: Number(r.y), w: Number(r.w), h: Number(r.h) } : null,
    };
  });
  return items.length ? items : null;
}

/**
 * @param {object} options
 * @param {string} options.generatedRoot folder that holds generated labs
 * @param {string} options.captureDir `<data dir>/capture` (staging and library records)
 * @param {() => {primary: string, search: string[]}} options.capturedDirs the shared library's write folder and search path
 * @param {() => void} [options.onChange] called after the shared library changed on disk (the Azure Blob write-through)
 */
export function createScreenshotStore({ generatedRoot, captureDir, capturedDirs, manifestDir, logger = null, onChange = null, keptDir = null, now = () => Date.now() }) {
  const stagedRoot = path.join(captureDir, "staged");
  const libraryRecordsFile = path.join(captureDir, "library-verification.json");
  // The library's records file holds every slot's check in one file, so a change to it (from this process or a command-line
  // tool) is read, changed, and written under one lock. Lock order, always: a slot's lock first, then this one.
  const withRecordsLock = (work) => withFileLockSync(lockPathFor(libraryRecordsFile), work, { timeoutMs: SHARE_LOCK_WAIT_MS });
  // What looks like the wrong screen is judged by one scanner (picture-inventory.js) that reads this store's folders; it keeps what it
  // learned about each file, so asking again costs a directory listing, not a decode.
  const scanner = createPictureScanner({ generatedRoot, captureDir, capturedDirs: () => dirs(), manifestDir });
  // A write to a library slot (picture and check together) holds that slot's lock, the same lock sharing a lab picture takes.
  // Slow follow-up work (regenerating labs) is queued with `afterSlotLock` and runs once the lock is released.
  let afterLockQueue = null;
  const afterSlotLock = (fn) => (afterLockQueue ? afterLockQueue.push(fn) : fn());
  const withSlotLock = (target, filename, work) => {
    if (target.kind !== "library") return work();
    const queue = [];
    const outer = afterLockQueue;
    afterLockQueue = queue;
    let result;
    try {
      result = withShareLockSync(dirs().primary, filename, work);
    } finally {
      afterLockQueue = outer;
    }
    for (const fn of queue) fn();
    return result;
  };
  const labTimers = new Map();
  const labPending = new Set();
  const libraryPending = new Set();
  let libraryTimer = null;

  const dirs = () => {
    const resolved = capturedDirs?.() ?? { primary: capturedScreenshotsDirs()[0], search: capturedScreenshotsDirs() };
    return resolved;
  };
  /** The archive for pictures of deleted or replaced labs; it follows the library folder (see `resolveKeptScreenshotsDir`). */
  const keptFolder = () => (typeof keptDir === "function" ? keptDir() : keptDir || resolveKeptScreenshotsDir({ FEATURE_TOUR_SCREENSHOTS_DIR: dirs().primary, PORTAL_DATA_DIR: path.dirname(captureDir) }));
  const kept = () => createKeptStore({ keptDir: keptFolder(), now, logger });
  const libraryChanged = () => {
    forgetSuspects();
    try {
      onChange?.();
    } catch (err) {
      logger?.(`[capture] Blob write-through failed after a library change: ${err.message}`);
    }
  };
  /** The library is the committed folder in the code repository (no persistent or explicit folder is set). */
  const libraryIsCommittedFolder = () => path.resolve(dirs().primary) === path.resolve(BAKED_CAPTURED_SCREENSHOTS_DIR);

  // ── Lab and library targets share one interface ──────────────────────────

  function labTarget(labId) {
    const found = labSlotFilenames({ generatedRoot, labId, capturedDir: dirs().search });
    if (found.status !== 200) return { error: { status: found.status, body: { error: found.error } } };
    const slots = new Map(found.shots.map((s) => [s.filename, s]));
    return {
      kind: "lab",
      labId: found.labId,
      labDir: found.labDir,
      filenames: found.shots.map((s) => s.filename),
      stagedDir: path.join(stagedRoot, `lab-${found.labId}`),
      slot(filename) {
        const shot = slots.get(filename);
        if (!shot) return null;
        return { expectedLabels: expectedLabelsForShot(shot), feature: shot.featureId || shot.feature || null, harness: normalizeHarness(shot.harness), harnessGap: shot.harnessGap || null };
      },
      readRecords: () => readLabVerification(found.labDir),
      writeRecord: (filename, record) => writeLabVerificationRecord(found.labDir, filename, record),
      readConfirmations: () => readLabConfirmations(found.labDir),
      writeConfirmation: (filename, confirmation) => writeLabConfirmation(found.labDir, filename, confirmation),
      writeImage(filename, bytes, callouts) {
        const assets = path.join(found.labDir, "assets");
        fs.mkdirSync(assets, { recursive: true });
        const target = path.join(assets, filename);
        if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error("Refusing to write through a symbolic link.");
        keepLabPrevious(found.labDir, filename, bytes);
        writeBytesAtomic(target, bytes);
        if (callouts) writeJsonAtomic(path.join(found.labDir, "screenshots", sidecarName(filename)), { schema: 1, filename, callouts });
      },
      afterCommit(filename, { source, capturedAt, defer }) {
        recordLabShotCaptured(found.labDir, { labId: found.labId, filename, source, capturedAt, capturedDir: dirs().search });
        if (defer) scheduleLabRefresh(found.labId);
        else refreshLab(found.labId);
      },
      resetImage(filename) {
        const target = path.join(found.labDir, "assets", filename);
        if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error("Refusing to write through a symbolic link.");
        // The picture being discarded stays as a backup until a new one replaces it.
        keepLabPrevious(found.labDir, filename);
        writeBytesAtomic(target, fs.readFileSync(PLACEHOLDER_PATH));
        fs.rmSync(path.join(found.labDir, "screenshots", sidecarName(filename)), { force: true });
        recordLabShotReset(found.labDir, { labId: found.labId, filename, capturedDir: dirs().search });
        refreshLab(found.labId);
      },
      hasOwnImage: (filename) => Boolean(capturedImage(path.join(found.labDir, "assets"), filename)),
      state: () => getLabScreenshotsStatus(generatedRoot, found.labId, { capturedDir: dirs().search }).body,
    };
  }

  function libraryTarget() {
    return {
      kind: "library",
      stagedDir: path.join(stagedRoot, "library"),
      slot(filename) {
        return findLibrarySlot(filename, { manifestDir });
      },
      readRecords: () => readRecordsFile(libraryRecordsFile).shots,
      writeRecord(filename, record) {
        withRecordsLock(() => {
          const { shots, confirmations } = readRecordsFile(libraryRecordsFile);
          if (record) shots[filename] = record;
          else delete shots[filename];
          writeRecordsFile(libraryRecordsFile, { shots, confirmations });
        });
      },
      readConfirmations: () => readRecordsFile(libraryRecordsFile).confirmations,
      writeConfirmation(filename, confirmation) {
        withRecordsLock(() => {
          const { shots, confirmations } = readRecordsFile(libraryRecordsFile);
          if (confirmation) confirmations[filename] = confirmation;
          else if (!(filename in confirmations)) return;
          else delete confirmations[filename];
          writeRecordsFile(libraryRecordsFile, { shots, confirmations });
        });
      },
      writeImage(filename, bytes, callouts) {
        const dir = dirs().primary;
        fs.mkdirSync(dir, { recursive: true });
        // A replaced library picture is kept (the last one only), so a bad capture cannot destroy a good one.
        const current = capturedImage(dirs().search, filename);
        if (current && fileSha256(current.file) !== sha256Hex(bytes)) writeBytesAtomic(path.join(dir, `${filename}${PREVIOUS_SUFFIX}`), fs.readFileSync(current.file));
        writeBytesAtomic(path.join(dir, filename), bytes);
        if (callouts) writeJsonAtomic(path.join(dir, sidecarName(filename)), { schema: 1, filename, callouts });
      },
      afterCommit(filename, { defer }) {
        libraryPending.add(filename);
        if (defer) scheduleLibraryRefresh();
        else afterSlotLock(() => void flushLibraryRefresh().catch(() => {}));
        libraryChanged();
      },
      resetImage(filename) {
        const dir = dirs().primary;
        const current = capturedImage(dirs().search, filename);
        if (current) writeBytesAtomic(path.join(dir, `${filename}${PREVIOUS_SUFFIX}`), fs.readFileSync(current.file));
        fs.rmSync(path.join(dir, filename), { force: true });
        fs.rmSync(path.join(dir, sidecarName(filename)), { force: true });
        libraryPending.add(filename);
        afterSlotLock(() => void flushLibraryRefresh().catch(() => {}));
        libraryChanged();
      },
      hasOwnImage: (filename) => Boolean(capturedImage(dirs().primary, filename)),
      state: () => libraryState(),
    };
  }

  function libraryState({ products } = {}) {
    const { shots: records, confirmations } = readRecordsFile(libraryRecordsFile);
    const productSet = products?.length ? new Set(products) : null;
    const slots = listLibrarySlots({ manifestDir, capturedDir: dirs().search })
      .filter((s) => !productSet || productSet.has(s.product))
      .map(({ file, ...s }) => {
        let capturedAt = null;
        if (file) {
          capturedAt = records[s.filename]?.acceptedAt || null;
          if (!Number.isFinite(Date.parse(capturedAt || ""))) {
            try {
              capturedAt = fs.statSync(file).mtime.toISOString();
            } catch {
              capturedAt = null;
            }
          }
        }
        const confirmed = file && confirmations[s.filename] ? validConfirmation(confirmations[s.filename], fileSha256(file)) : null;
        return { ...s, capturedAt, confirmed, verification: records[s.filename] || null, needsReview: records[s.filename]?.state === "needs-review" };
      });
    const unrecorded = listUnrecordedLibraryPictures({ manifestDir, capturedDir: dirs().search })
      .filter((p) => !productSet || productSet.has(p.product))
      .map(({ file, dir, ...p }) => {
        let capturedAt = null;
        try {
          capturedAt = fs.statSync(file).mtime.toISOString();
        } catch {
          capturedAt = null;
        }
        return { ...p, capturedAt };
      });
    return {
      summary: {
        total: slots.length,
        captured: slots.filter((s) => s.captured).length,
        missing: slots.filter((s) => !s.captured).length,
        needsReview: slots.filter((s) => s.needsReview).length,
        confirmed: slots.filter((s) => s.confirmed).length,
        harnessNotRecorded: unrecorded.length,
      },
      shots: slots,
      // Pictures saved before harnesses were recorded: never used for a slot that needs a harness until a person says which one they show.
      unrecorded,
    };
  }

  // ── Refreshing derived outputs ───────────────────────────────────────────

  function refreshLab(labId) {
    const timer = labTimers.get(labId);
    if (timer) clearTimeout(timer);
    labTimers.delete(labId);
    labPending.delete(labId);
    const found = labSlotFilenames({ generatedRoot, labId, capturedDir: dirs().search });
    if (found.status !== 200) return { refreshed: false };
    try {
      refreshGeneratedLabOutputs(found.labDir, { labId: found.labId, capturedDir: dirs().search });
      return { refreshed: true };
    } catch (err) {
      logger?.(`[capture] Could not refresh lab ${labId}: ${err.message}`);
      return { refreshed: false, error: err.message };
    }
  }

  function scheduleLabRefresh(labId) {
    labPending.add(labId);
    const existing = labTimers.get(labId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => refreshLab(labId), REFRESH_DELAY_MS);
    timer.unref?.();
    labTimers.set(labId, timer);
  }

  /** Regenerate a lab's outputs now when uploads for it are waiting on the short delay. */
  function flushLab(labId) {
    return labPending.has(labId) ? refreshLab(labId) : { refreshed: false };
  }

  function scheduleLibraryRefresh() {
    if (libraryTimer) clearTimeout(libraryTimer);
    libraryTimer = setTimeout(() => void flushLibraryRefresh().catch(() => {}), REFRESH_DELAY_MS);
    libraryTimer.unref?.();
  }

  /** Refresh every generated lab that uses a newly captured library slot (a bounded number, one at a time). */
  async function flushLibraryRefresh() {
    if (libraryTimer) clearTimeout(libraryTimer);
    libraryTimer = null;
    const filenames = new Set(libraryPending);
    libraryPending.clear();
    if (!filenames.size || !fs.existsSync(generatedRoot)) return { refreshed: 0 };
    let refreshed = 0;
    for (const entry of fs.readdirSync(generatedRoot, { withFileTypes: true })) {
      if (refreshed >= MAX_REFRESH_LABS) break;
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const shotsFile = path.join(generatedRoot, entry.name, "screenshots", "shots.json");
      if (!fs.existsSync(shotsFile)) continue;
      try {
        const plan = withShotHarness(readJson(shotsFile, null) || {});
        // A lab that has its own picture for a slot keeps showing it, so only labs that show the library's picture need refreshing.
        const assets = path.join(generatedRoot, entry.name, "assets");
        const uses = (plan?.shots || []).some((s) => filenames.has(libraryName(s.filename, s.harness)) && !capturedImage(assets, s.filename));
        if (!uses) continue;
        if (refreshLab(entry.name).refreshed) refreshed += 1;
      } catch {
        // A lab with a damaged plan is skipped; its next edit rebuilds it.
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    return { refreshed };
  }

  // ── Staging ──────────────────────────────────────────────────────────────

  const stagedImage = (target, filename) => path.join(target.stagedDir, filename);
  const stagedMeta = (target, filename) => path.join(target.stagedDir, `${filename}.meta.json`);

  function stage(target, filename, bytes, meta) {
    writeBytesAtomic(stagedImage(target, filename), bytes);
    writeJsonAtomic(stagedMeta(target, filename), meta);
  }

  function clearStaged(target, filename) {
    fs.rmSync(stagedImage(target, filename), { force: true });
    fs.rmSync(stagedMeta(target, filename), { force: true });
  }

  /** The staged image bytes for review, or null. */
  function readStaged(target, filename) {
    try {
      return { bytes: fs.readFileSync(stagedImage(target, filename)), meta: readJson(stagedMeta(target, filename), null) };
    } catch {
      return null;
    }
  }

  // ── Operations ───────────────────────────────────────────────────────────

  /** The callouts saved beside a lab's picture, or null. */
  function readLabCallouts(target, filename) {
    const saved = readJson(path.join(target.labDir, "screenshots", sidecarName(filename)), null);
    return cleanCallouts(saved?.callouts);
  }

  /**
   * The name a lab's picture has in the shared library, and what that is for: the library keeps a picture of a slot that needs a harness under
   * a name that carries it (`agent-overview.classic.png`). For a lab's own picture it is the harness the lab's slot needs; for a picture with
   * no lab (one carried out of a lab that is being removed, or restored from the kept pictures) it is the harness the picture is recorded as.
   */
  function libraryNameFor(target, filename, record, sha) {
    if (target?.kind === "lab") return libraryName(filename, target.slot(filename)?.harness ?? null);
    return libraryName(filename, harnessStampOf(record, sha));
  }

  /**
   * Offer a lab's picture to the shared library ("capture once, reuse everywhere"). Never throws for a rule: the answer says
   * what happened and, when nothing was shared, why in plain words. A picture of a slot that needs a harness is shared only when it is
   * recorded as taken in that harness; it is saved under the harness's name, so it can never stand in for the other harness's slot.
   *
   * @param {"capture"|"retake"|"accept"|"backfill"|"share"} intent see `replacementVerdict` for what each may replace
   * @returns {{outcome: "shared"|"replaced"|"already-shared"|"skipped"|"would-share", filename: string, code?: string, message?: string}}
   */
  function promoteFromLab(target, filename, { bytes, record, intent, capturedAt = null, callouts = null, defer = true, replaceConfirmed = false, dryRun = false, confirmed = false }) {
    const sha = Buffer.isBuffer(bytes) ? sha256Hex(bytes) : "";
    const libFile = libraryNameFor(target, filename, record, sha);
    const done = (outcome, extra = {}) => ({ outcome, filename, ...(libFile !== filename ? { libraryFilename: libFile } : {}), ...extra });
    const skip = (code, message) => done("skipped", { code, message: message || SHARE_MESSAGES[code] });
    const slot = findLibrarySlot(libFile, { manifestDir });
    // A picture with no lab and no harness record, for a slot that needs a harness, is "not recorded", not "lab only".
    if (!slot && !target && isLibrarySlotName(filename, { manifestDir })) return skip("harness-not-recorded");
    const verdict = shareVerdict({ filename, bytes, record, slot, intent });
    if (!verdict.ok) return skip(verdict.code, verdict.message);
    // One bad picture must never spread to every lab: a picture that looks like the wrong screen (a start page for a deeper slot, the
    // same picture as other slots, a page that was not signed in) is not shared, unless a person marked this exact picture "Keep this one".
    const kept = confirmed || Boolean(target && validConfirmation(target.readConfirmations?.()[filename], sha));
    const looksWrong = kept ? null : pictureLooksWrong({ filename: libFile, bytes, record, intent });
    if (looksWrong) return skip("looks-wrong", looksWrong);
    // The committed folder is tracked by Git: a customer's picture must never land there unless a person chose to share it.
    if (libraryIsCommittedFolder() && !["share", "backfill"].includes(intent)) return skip("not-persistent");

    const { primary, search } = dirs();
    const release = dryRun ? () => {} : acquireShareLock(primary, libFile);
    if (!release) return skip("busy");
    try {
      const existing = capturedImage(search, libFile);
      const existingSha = existing ? fileSha256(existing.file) : null;
      const records = readRecordsFile(libraryRecordsFile);
      const decision = replacementVerdict({
        existing,
        existingSha,
        candidateSha: sha,
        confirmed: Boolean(validConfirmation(records.confirmations[libFile], existingSha)),
        intent,
        replaceConfirmed,
      });
      if (decision.action === "skip") return skip(decision.code, decision.message);
      if (decision.action === "same") return done("already-shared");
      if (dryRun) return done("would-share", { replaces: decision.action === "replace" });

      // The picture and its check change together under the records lock (another process may be changing another slot's record),
      // so a lock that cannot be had leaves the slot exactly as it was.
      try {
        withRecordsLock(() => {
          // A replaced picture is kept (the last one only) so a bad capture cannot destroy a good one.
          if (existing) writeBytesAtomic(path.join(primary, `${libFile}${PREVIOUS_SUFFIX}`), fs.readFileSync(existing.file));
          writeBytesAtomic(path.join(primary, libFile), bytes);
          if (callouts) writeJsonAtomic(path.join(primary, sidecarName(libFile)), { schema: 1, filename: libFile, callouts });
          else fs.rmSync(path.join(primary, sidecarName(libFile)), { force: true });
          const latest = readRecordsFile(libraryRecordsFile);
          latest.shots[libFile] = { ...record, state: "accepted", acceptedAt: capturedAt || record?.acceptedAt || new Date().toISOString() };
          delete latest.confirmations[libFile];
          writeRecordsFile(libraryRecordsFile, latest);
        });
      } catch (err) {
        if (err?.code === "LOCK_TIMEOUT") return skip("busy");
        throw err;
      }

      libraryPending.add(libFile);
      if (defer) scheduleLibraryRefresh();
      else void flushLibraryRefresh().catch(() => {});
      libraryChanged();
      return done(existing ? "replaced" : "shared", { previousKept: Boolean(existing) });
    } finally {
      release();
    }
  }

  /** What a picture that was just accepted is recorded as taken in: the harness the companion proved, or the slot's harness on a person's word (an upload by hand, or a picture accepted after review). */
  function harnessStampFor(slot, verification) {
    const need = normalizeHarness(slot?.harness);
    if (!isSpecificHarness(need)) return null;
    const proven = verification?.evidence?.harness;
    return makeHarnessStamp(need, proven && proven.id === need ? "landmarks" : "person");
  }

  function commit(target, filename, bytes, { verification, source, capturedAt, callouts, defer, jobId = null, intent = "capture", extras = {} }) {
    // A library slot is written (picture, then its check) under the slot's lock, so a command-line tool or another portal on
    // the same folder can never leave the picture of one capture beside the check of another.
    const harness = harnessStampFor(target.slot(filename), verification);
    const record = { ...summarizeVerification(verification, extras), state: "accepted", source, jobId, acceptedAt: capturedAt, ...(harness ? { harness } : {}) };
    withSlotLock(target, filename, () => {
      target.writeImage(filename, bytes, callouts);
      clearStaged(target, filename);
      target.writeRecord(filename, record);
      // New bytes: an earlier "Mark as accurate" no longer describes this picture.
      target.writeConfirmation(filename, null);
      target.afterCommit(filename, { source, capturedAt, defer });
    });
    if (target.kind !== "lab") return null;
    const sharing = promoteFromLab(target, filename, { bytes, record, intent, capturedAt, callouts, defer });
    return sharing.code === "lab-only" ? null : sharing;
  }

  /**
   * What the picture itself says is wrong with it, judged like every other picture (picture-integrity.js) against the pictures of this lab
   * and the shared library: it is the same as another slot's picture when the two cannot both be right, or it is a start page (or the
   * agent's main tab) for a slot that describes a deeper screen. Two slots that show the same screen (both are the start page, both
   * were reached by the same steps) are not a problem, and a good new picture is not held back by an old wrong one it matches.
   * @returns {Array<{code: string, message: string}>}
   */
  function integrityReasons(target, filename, { sha256, fingerprint, record }) {
    const labId = target.kind === "lab" ? target.labId : null;
    let others = [];
    try {
      others = scanner.inventory({ library: true, labIds: labId ? [labId] : [] }).pictures.filter((p) => p.filename !== filename);
    } catch (err) {
      logger?.(`[capture] Could not compare a picture with the others: ${err.message}`);
      return [];
    }
    const candidate = { id: "candidate", scope: target.kind, labId, filename, sha256, fingerprint, record: { ...record, sha256, state: "accepted" }, confirmed: false, slot: scanner.slotOf(filename, { labId }) };
    const result = assessPictures([...others, candidate]).find((r) => r.id === "candidate");
    const out = [];
    for (const flag of result?.flags || []) {
      if (flag.level !== "definite") continue;
      if (flag.code === "DUPLICATE_ACROSS_SLOTS" || flag.code === "NEAR_DUPLICATE") {
        const names = (flag.others || []).slice(0, 2).map((o) => `“${cleanText(o.label, 80)}”`).join(" and ");
        out.push({ code: "duplicate-picture", message: `This looks the same as ${names || "another screenshot"}${(flag.others || []).length > 2 ? " and others" : ""}. A picture cannot be the right one for two different screens. Check it, then accept it or retake it.` });
      } else if (flag.code === "LANDING_PAGE") {
        out.push({ code: "landing-page", message: `${flag.message} Check it, then accept it or retake it.` });
      }
    }
    return out;
  }

  /**
   * Whether a picture offered to the shared library looks like the wrong screen, judged against the pictures already in the library
   * (picture-integrity.js). Returns the plain reason, or null when it is fine. An explicit "Use this one for every lab" (`share`) is
   * stopped only by a definite finding; every other way in is also stopped by a probable one.
   */
  function pictureLooksWrong({ filename, bytes, record, intent }) {
    let others = [];
    try {
      others = scanner.inventory({ library: true, labIds: [] }).pictures.filter((p) => p.filename !== filename);
    } catch (err) {
      logger?.(`[capture] Could not check a picture before sharing it: ${err.message}`);
      return null;
    }
    const sha = sha256Hex(bytes);
    const fingerprint = record && record.sha256 === sha && isFingerprint(record.fingerprint) ? record.fingerprint : fingerprintPicture(bytes);
    const candidate = { id: "candidate", scope: "library", labId: null, filename, sha256: sha, fingerprint, record: record || null, confirmed: false, slot: scanner.slotOf(filename) };
    const result = assessPictures([...others, candidate]).find((r) => r.id === "candidate");
    if (!result?.level || (result.level === "probable" && intent === "share")) return null;
    return `${result.flags[0].message} It stays where it is. If it is right, mark it Keep this one first.`;
  }

  /**
   * Verify and store an uploaded image. `outcome` is `accepted`, `needs-review`, or `rejected`.
   * `retake` says the person asked for a new picture (so it may replace the library's, unless that one is marked accurate).
   *
   * @returns {{status: number, body: object}}
   */
  function submit(target, filename, bytes, { evidence = null, source = "upload", acceptWarnings = false, defer = false, callouts = null, jobId = null, requireEvidence = false, requireRedaction = false, requireProof = false, productLabel = "", companionVersion = "", expect = null, expectedLabels = null, retake = false } = {}) {
    const slot = target.slot(filename);
    if (!slot) return { status: 404, body: { error: "That file name is not a screenshot slot here.", filename } };
    // A slot whose module is not written for the lab's harness cannot get a picture in the lab's harness: it is a gap in the lab, not a picture to take.
    if (slot.harnessGap) {
      const message = harnessGapMessage(slot.harnessGap);
      return { status: 409, body: { outcome: "rejected", filename, code: "harness-gap", message, verification: { ok: false, level: "fail", reasons: [{ code: "harness-gap", level: "fail", message }] } } };
    }
    const labels = Array.isArray(expectedLabels) && expectedLabels.length ? expectedLabels : slot.expectedLabels;
    const verification = verifyUpload({
      bytes,
      filename,
      evidence,
      expectedLabels: labels,
      expect,
      requireEvidence,
      requireRedaction,
      requireProof,
      productLabel,
      expectHarness: slot.harness,
    });
    if (verification.level === "fail") {
      const failed = summarizeVerification(verification);
      return { status: 422, body: { outcome: "rejected", filename, verification: failed, message: verification.reasons[0]?.message || "The image failed verification." } };
    }
    // What the picture looks like (kept with its check) and what it looks like to the other slots' pictures.
    const fingerprint = verification.format === "png" ? fingerprintPicture(bytes) : null;
    const extras = { ...(fingerprint ? { fingerprint } : {}), ...(companionVersion ? { companionVersion: cleanText(companionVersion, 20) } : {}) };
    const problems = integrityReasons(target, filename, { sha256: verification.sha256, fingerprint, record: summarizeVerification(verification) });
    for (const problem of problems) verification.reasons.push({ code: problem.code, level: "warn", message: problem.message });
    if (problems.length) {
      verification.level = "warn";
      verification.ok = true;
    }
    const record = summarizeVerification(verification, extras);

    const capturedAt = new Date().toISOString();
    if (verification.level === "warn" && !acceptWarnings) {
      stage(target, filename, bytes, { verification: record, evidence: verification.evidence, source, jobId, stagedAt: capturedAt, callouts: cleanCallouts(callouts), expect, expectedLabels: labels, extras });
      // A picture already in place keeps its own check, so discarding this one later puts it back.
      const before = target.readRecords()[filename];
      const priorRecord = before?.state === "accepted" ? before : before?.priorRecord || null;
      target.writeRecord(filename, { ...record, state: "needs-review", source, jobId, stagedAt: capturedAt, ...(priorRecord ? { priorRecord } : {}) });
      return {
        status: 202,
        body: { outcome: "needs-review", filename, verification: record, message: "The image was saved for review. Check it, then accept it or retake it." },
      };
    }

    const intent = retake ? "retake" : acceptWarnings ? "accept" : "capture";
    const sharing = commit(target, filename, bytes, { verification, source, capturedAt, callouts: cleanCallouts(callouts), defer, jobId, intent, extras });
    return { status: 200, body: { outcome: "accepted", filename, verification: { ...record, state: "accepted" }, ...(sharing ? { library: sharing } : {}), state: defer ? null : target.state() } };
  }

  /** Accept the staged image for a slot (a person looked at the warnings). */
  function accept(target, filename, { defer = false } = {}) {
    if (!target.slot(filename)) return { status: 404, body: { error: "That file name is not a screenshot slot here.", filename } };
    const staged = readStaged(target, filename);
    if (!staged) return { status: 404, body: { error: "Nothing is waiting for review for this screenshot.", filename } };
    const slot = target.slot(filename);
    const verification = verifyUpload({ bytes: staged.bytes, filename, evidence: staged.meta?.evidence || null, expectedLabels: staged.meta?.expectedLabels || slot.expectedLabels, expect: staged.meta?.expect || null });
    if (verification.level === "fail") {
      clearStaged(target, filename);
      target.writeRecord(filename, null);
      return { status: 422, body: { outcome: "rejected", filename, verification: summarizeVerification(verification), message: verification.reasons[0]?.message } };
    }
    // Accepting a picture whose masking was required and missing must not make it look masked to the library.
    const notMasked = (staged.meta?.verification?.reasons || []).find((r) => r?.code === "not-redacted");
    if (notMasked && !verification.reasons.some((r) => r.code === "not-redacted")) verification.reasons.push(notMasked);
    // Accepting a picture the portal found wrong (the same as another slot's, or a start page for a deeper screen) is a person saying it is
    // right: it is marked Keep this one, so it is not flagged again.
    const sawProblem = (staged.meta?.verification?.reasons || []).some((r) => r?.code === "duplicate-picture" || r?.code === "landing-page");
    const sharing = commit(target, filename, staged.bytes, {
      verification,
      source: staged.meta?.source || "upload",
      capturedAt: new Date().toISOString(),
      callouts: staged.meta?.callouts || null,
      defer,
      jobId: staged.meta?.jobId || null,
      intent: "accept",
      extras: staged.meta?.extras || {},
    });
    if (sawProblem) {
      withSlotLock(target, filename, () => target.writeConfirmation(filename, makeConfirmation(sha256Hex(staged.bytes), { by: "review" })));
      if (target.kind === "library") libraryChanged();
    }
    return { status: 200, body: { outcome: "accepted", filename, ...(sharing ? { library: sharing } : {}), state: defer ? null : target.state() } };
  }

  /**
   * Discard a picture that is waiting for review, or reset a committed one to the placeholder so it can be retaken.
   * Discarding a waiting picture never touches the picture already in place (or its check). Resetting a committed picture
   * keeps it as a backup (a library picture beside it as `.previous`, a lab picture in the lab's hidden `.previous` folder).
   */
  function reset(target, filename) {
    if (!target.slot(filename)) return { status: 404, body: { error: "That file name is not a screenshot slot here.", filename } };
    const staged = readStaged(target, filename);
    if (staged) {
      const record = target.readRecords()[filename];
      clearStaged(target, filename);
      target.writeRecord(filename, record?.priorRecord || null);
      return { status: 200, body: { outcome: "reset", filename, discardedStaged: true, removedImage: false, state: target.state() } };
    }
    const hadOwn = target.hasOwnImage(filename);
    withSlotLock(target, filename, () => {
      target.writeRecord(filename, null);
      target.writeConfirmation(filename, null);
      if (hadOwn || target.kind === "lab") target.resetImage(filename);
    });
    return { status: 200, body: { outcome: "reset", filename, discardedStaged: false, removedImage: hadOwn, state: target.state() } };
  }

  // ── Sharing a lab's pictures, and confirming them ────────────────────────

  /**
   * "Use this one for every lab": a person chose to put this lab's own picture in the shared library. It needs `confirm`
   * (the person saw what it does); a picture the library already has marked accurate also needs `replaceConfirmed`, which
   * clears that mark. The replaced picture is kept as a backup.
   */
  function shareLabPicture(target, filename, { confirm = false, replaceConfirmed = false } = {}) {
    if (!target.slot(filename)) return { status: 404, body: { error: "That file name is not a screenshot slot here.", filename } };
    if (confirm !== true) return { status: 400, body: { error: "Confirm first: this picture will be used by every lab.", filename } };
    const own = capturedImage(path.join(target.labDir, "assets"), filename);
    if (!own) return { status: 409, body: { outcome: "skipped", filename, code: "no-picture", message: SHARE_MESSAGES["no-picture"] } };
    const result = promoteFromLab(target, filename, {
      bytes: fs.readFileSync(own.file),
      record: target.readRecords()[filename] || null,
      intent: "share",
      capturedAt: target.readRecords()[filename]?.acceptedAt || null,
      callouts: readLabCallouts(target, filename),
      replaceConfirmed: replaceConfirmed === true,
    });
    const ok = ["shared", "replaced", "already-shared"].includes(result.outcome);
    return { status: ok ? 200 : 409, body: { ...result, ...(result.code === "library-confirmed" ? { needsReplaceConfirmation: true } : {}), state: target.state() } };
  }

  /**
   * Share every eligible picture a lab already has ("Share this lab's captured screenshots"). Nothing is overwritten: a slot
   * the library already has, a lab-specific slot, a placeholder, and anything not proven clean is skipped with a reason.
   */
  function shareLabPictures(labId, { dryRun = false, withState = true } = {}) {
    const target = labTarget(labId);
    if (target.error) return target.error;
    const records = target.readRecords();
    const promoted = [];
    const alreadyShared = [];
    const skipped = [];
    let noPicture = 0;
    for (const filename of target.filenames) {
      const own = capturedImage(path.join(target.labDir, "assets"), filename);
      if (!own) {
        noPicture += 1;
        continue;
      }
      const result = promoteFromLab(target, filename, {
        bytes: fs.readFileSync(own.file),
        record: records[filename] || null,
        intent: "backfill",
        capturedAt: records[filename]?.acceptedAt || null,
        callouts: readLabCallouts(target, filename),
        dryRun,
      });
      if (result.outcome === "skipped") skipped.push({ filename, code: result.code, message: result.message });
      else if (result.outcome === "already-shared") alreadyShared.push(filename);
      else promoted.push(filename);
    }
    return {
      status: 200,
      body: {
        labId: target.labId,
        dryRun,
        promoted,
        alreadyShared,
        skipped,
        counts: { promoted: promoted.length, alreadyShared: alreadyShared.length, skipped: skipped.length, noPicture },
        state: dryRun || !withState ? null : target.state(),
      },
    };
  }

  /** The picture a target shows for a slot, and which records hold its confirmation (`name` is the name those records use: a library picture's name carries its harness). */
  function pictureOf(target, filename) {
    if (target.kind === "library") {
      const image = capturedImage(dirs().search, filename);
      return image ? { image, owner: target, scope: "library", name: filename } : null;
    }
    const resolved = resolveLabScreenshot(target.labDir, filename, { capturedDir: dirs().search, harness: target.slot(filename)?.harness ?? null });
    if (!resolved) return null;
    return resolved.source === "lab" ? { image: resolved, owner: target, scope: "lab", name: filename } : { image: resolved, owner: libraryTarget(), scope: "library", name: resolved.name || filename };
  }

  /** "Mark as accurate": a person says this picture is right. It is tied to the picture's exact bytes. Never blocks anything. */
  function confirm(target, filename, { by = null } = {}) {
    if (!target.slot(filename)) return { status: 404, body: { error: "That file name is not a screenshot slot here.", filename } };
    if (readStaged(target, filename)) return { status: 409, body: { error: "Accept or discard the picture that is waiting for review first.", filename } };
    const picture = pictureOf(target, filename);
    const sha = picture ? fileSha256(picture.image.file) : null;
    if (!sha) return { status: 409, body: { error: "There is no captured picture to mark as accurate yet.", filename } };
    const confirmation = makeConfirmation(sha, { by });
    picture.owner.writeConfirmation(picture.name, confirmation);
    if (picture.scope === "library") libraryChanged();
    return { status: 200, body: { outcome: "confirmed", filename, scope: picture.scope, confirmed: { at: confirmation.at }, state: target.state() } };
  }

  /** "Clear confirmation". */
  function unconfirm(target, filename) {
    if (!target.slot(filename)) return { status: 404, body: { error: "That file name is not a screenshot slot here.", filename } };
    const picture = pictureOf(target, filename);
    picture?.owner.writeConfirmation(picture.name, null);
    target.writeConfirmation(filename, null);
    if (picture?.scope === "library") libraryChanged();
    return { status: 200, body: { outcome: "unconfirmed", filename, scope: picture?.scope || target.kind, state: target.state() } };
  }

  /** How many other labs show the library's picture for a slot, so a retake can say who it affects. `filename` is the library name (it carries the harness). */
  function libraryUsage(filename, { exceptLabId = null } = {}) {
    if (!findLibrarySlot(filename, { manifestDir })) return { status: 404, body: { error: "That file name is not a screenshot slot here.", filename } };
    const picture = capturedImage(dirs().search, filename);
    let otherLabs = 0;
    if (picture && fs.existsSync(generatedRoot)) {
      let scanned = 0;
      for (const entry of fs.readdirSync(generatedRoot, { withFileTypes: true })) {
        if (scanned >= MAX_USAGE_LABS) break;
        if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === exceptLabId) continue;
        const shotsFile = path.join(generatedRoot, entry.name, "screenshots", "shots.json");
        if (!fs.existsSync(shotsFile)) continue;
        scanned += 1;
        const plan = withShotHarness(readJson(shotsFile, null) || {});
        if ((plan?.shots || []).some((s) => libraryName(s.filename, s.harness) === filename && !capturedImage(path.join(generatedRoot, entry.name, "assets"), s.filename))) otherLabs += 1;
      }
    }
    const confirmation = picture ? readRecordsFile(libraryRecordsFile).confirmations[filename] : null;
    return { status: 200, body: { filename, hasPicture: Boolean(picture), otherLabs, confirmed: Boolean(picture && validConfirmation(confirmation, fileSha256(picture.file))) } };
  }

  // ── Saying which harness a picture shows ─────────────────────────────────

  /**
   * "This is Standard (Classic)" / "This is Microsoft Copilot": a person says which harness a picture from before harnesses were recorded
   * shows, with one click (the way "Mark as accurate" works). For a lab's own picture the answer is saved on its check, for exactly these
   * bytes. A picture that shows a different harness than its slot needs is never used for the slot: it is moved to the kept pictures list
   * (restorable for 90 days) and the slot goes back to pending. For a library picture saved under a slot's plain name, a matching answer
   * moves it to the harness's name (where the slot finds it), and any other answer moves it to the kept pictures list.
   *
   * @param {object} target a lab target, or the library target (then `filename` is the picture's plain name)
   * @param {string} filename
   * @param {string} harness "standard" or "microsoft-copilot" (or "customer-conversation")
   * @returns {{status: number, body: object}}
   */
  function tagPicture(target, filename, harness, { by = null } = {}) {
    const id = normalizeHarness(harness);
    if (!isSpecificHarness(id)) return { status: 400, body: { error: "Choose which harness the picture shows: Standard (Classic) or Microsoft Copilot.", filename } };
    return target.kind === "library" ? tagLibraryPicture(target, filename, id, { by }) : tagLabPicture(target, filename, id, { by });
  }

  function tagLabPicture(target, filename, id, { by = null } = {}) {
    const slot = target.slot(filename);
    if (!slot) return { status: 404, body: { error: "That file name is not a screenshot slot here.", filename } };
    if (readStaged(target, filename)) return { status: 409, body: { error: "Accept or discard the picture that is waiting for review first.", filename } };
    const own = capturedImage(path.join(target.labDir, "assets"), filename);
    if (!own) return { status: 409, body: { error: "This lab has no picture of its own for this screenshot, so there is nothing to tag.", filename } };
    const bytes = fs.readFileSync(own.file);
    const sha = sha256Hex(bytes);
    const records = target.readRecords();
    const recorded = harnessStampOf(records[filename], sha);
    if (recorded) return { status: 409, body: { error: `This picture is already recorded as the ${harnessLabel(recorded)}.`, filename, harness: recorded } };
    const fit = pictureFitsSlot(slot.harness, id);
    if (!fit.ok) {
      const message = `${fit.message} It was moved to the kept pictures list, and the screenshot is waiting for a picture from the ${harnessLabel(slot.harness)}.`;
      kept().archive({
        labId: target.labId,
        labTitle: labTitleOf(target.labDir),
        reason: "wrong-harness",
        pictures: [{ filename, bytes, why: "wrong-harness", message: fit.message, record: { ...(records[filename] || {}), sha256: sha, harness: makeHarnessStamp(id, "person") }, confirmation: target.readConfirmations()[filename] || null, callouts: readLabCallouts(target, filename) }],
      });
      withSlotLock(target, filename, () => {
        target.writeRecord(filename, null);
        target.writeConfirmation(filename, null);
        target.resetImage(filename);
      });
      return { status: 200, body: { outcome: "moved", filename, harness: id, message, state: target.state() } };
    }
    const before = records[filename] || {};
    withSlotLock(target, filename, () => {
      target.writeRecord(filename, { ...before, sha256: sha, state: before.state || "accepted", source: before.source || "tagged", acceptedAt: before.acceptedAt || new Date().toISOString(), harness: makeHarnessStamp(id, "person") });
    });
    return { status: 200, body: { outcome: "tagged", filename, harness: id, harnessLabel: harnessLabel(id), by: by || null, state: target.state() } };
  }

  function tagLibraryPicture(target, filename, id) {
    const row = listUnrecordedLibraryPictures({ manifestDir, capturedDir: dirs().search }).find((p) => p.filename === filename);
    if (!row) return { status: 404, body: { error: "There is no picture saved under that name without a harness.", filename } };
    const bytes = fs.readFileSync(row.file);
    const sha = sha256Hex(bytes);
    const { primary } = dirs();
    const writable = path.resolve(row.dir) === path.resolve(primary);
    const callouts = cleanCallouts(readJson(path.join(row.dir, sidecarName(filename)), null)?.callouts);
    const { shots: records, confirmations } = readRecordsFile(libraryRecordsFile);
    const removeLegacy = () => {
      if (!writable) return;
      fs.rmSync(path.join(primary, filename), { force: true });
      fs.rmSync(path.join(primary, sidecarName(filename)), { force: true });
      fs.rmSync(path.join(primary, `${filename}${PREVIOUS_SUFFIX}`), { force: true });
    };
    if (!row.harnesses.includes(id)) {
      const message = `This picture is from the ${harnessLabel(id)}, but this screenshot needs the ${row.harnesses.map(harnessLabel).join(" or the ")}, so it is not used. It was moved to the kept pictures list.`;
      if (!writable) return { status: 409, body: { error: "This picture is in the committed folder of the code repository, so it is not moved from here.", filename } };
      kept().archive({ labId: LIBRARY_ENTRY_ID, labTitle: "Shared library", reason: "wrong-harness", pictures: [{ filename, bytes, why: "wrong-harness", message, record: { ...(records[filename] || {}), sha256: sha, harness: makeHarnessStamp(id, "person") }, confirmation: confirmations[filename] || null, callouts }] });
      withSlotLock(target, filename, () => {
        removeLegacy();
        target.writeRecord(filename, null);
        target.writeConfirmation(filename, null);
      });
      libraryChanged();
      return { status: 200, body: { outcome: "moved", filename, harness: id, message } };
    }
    const libFile = libraryName(filename, id);
    const existing = capturedImage(dirs().search, libFile);
    if (existing && fileSha256(existing.file) !== sha) {
      return { status: 409, body: { error: `The library already has a different ${harnessLabel(id)} picture for this screenshot. Retake or replace that one instead.`, filename, libraryFilename: libFile } };
    }
    withSlotLock(target, libFile, () => {
      if (!existing) {
        fs.mkdirSync(primary, { recursive: true });
        writeBytesAtomic(path.join(primary, libFile), bytes);
        if (callouts) writeJsonAtomic(path.join(primary, sidecarName(libFile)), { schema: 1, filename: libFile, callouts });
      }
      const before = records[filename] || {};
      target.writeRecord(libFile, { ...before, sha256: sha, state: "accepted", source: before.source || "tagged", acceptedAt: before.acceptedAt || new Date().toISOString(), harness: makeHarnessStamp(id, "person") });
      if (confirmations[filename] && validConfirmation(confirmations[filename], sha)) target.writeConfirmation(libFile, confirmations[filename]);
      removeLegacy();
      if (writable) {
        target.writeRecord(filename, null);
        target.writeConfirmation(filename, null);
      }
    });
    libraryPending.add(libFile);
    afterSlotLock(() => void flushLibraryRefresh().catch(() => {}));
    libraryChanged();
    return { status: 200, body: { outcome: "tagged", filename, libraryFilename: libFile, harness: id, harnessLabel: harnessLabel(id), state: libraryState() } };
  }

  // ── Keeping a lab's pictures before the lab is deleted or replaced ───────

  const LAB_FOLDER = /^[a-z0-9][a-z0-9-]{0,99}$/i;

  /** The folder of a lab that may be removed: a real folder straight inside the generated-labs folder (a half-built lab counts too). */
  function labFolder(labId) {
    if (!LAB_FOLDER.test(String(labId))) return null;
    const root = path.resolve(generatedRoot);
    const dir = path.resolve(root, String(labId));
    if (path.relative(root, dir) !== String(labId)) return null;
    try {
      const info = fs.lstatSync(dir);
      return info.isDirectory() && !info.isSymbolicLink() ? dir : null;
    } catch {
      return null;
    }
  }

  const labTitleOf = (labDir) => cleanText(readJson(path.join(labDir, "manifest.json"), null)?.title, 200);
  const labCalloutsOf = (labDir, filename) => cleanCallouts(readJson(path.join(labDir, "screenshots", sidecarName(filename)), null)?.callouts);

  /**
   * What would happen to each real picture of a lab that is removed (and replaced by `newLabId`, when there is one). Writes nothing.
   *   shared  the library already holds exactly this picture
   *   present the replacing lab already has exactly this picture
   *   carry   the replacing lab has this slot and no picture of its own, so it is copied there
   *   share   the picture may enter the shared library (the same rules as "Use this one for every lab", never replacing one)
   *   keep    anything else goes to the kept-pictures archive
   */
  function planLabPictures(labId, { newLabId = null } = {}) {
    const labDir = labFolder(labId);
    if (!labDir) return { status: 404, error: "Generated lab not found" };
    const fresh = newLabId ? labTarget(newLabId) : null;
    if (fresh?.error) return { status: fresh.error.status, error: fresh.error.body.error };
    const freshNames = new Set(fresh?.filenames || []);
    const records = readLabVerification(labDir);
    const confirmations = readLabConfirmations(labDir);
    const pictures = readLabPictures(labDir);
    const current = new Set(pictures.filter((p) => !p.earlier).map((p) => `${p.filename}:${sha256Hex(p.bytes)}`));
    const items = [];
    for (const picture of pictures) {
      const sha = sha256Hex(picture.bytes);
      const item = { filename: picture.filename, bytes: picture.bytes, sha, earlier: picture.earlier, record: records[picture.filename] || null, confirmation: confirmations[picture.filename] || null, plan: null };
      // The library holds a picture of a slot that needs a harness under the harness's name, and only when this picture is recorded as taken in it.
      const libFile = libraryNameFor(null, picture.filename, item.record, sha);
      const existing = findLibrarySlot(libFile, { manifestDir }) ? capturedImage(dirs().search, libFile) : null;
      const inLibrary = Boolean(existing && fileSha256(existing.file) === sha);
      if (picture.earlier) {
        item.plan = inLibrary || current.has(`${picture.filename}:${sha}`) ? "shared" : "keep";
        if (item.plan === "keep") Object.assign(item, { code: "previous-version", message: "An earlier version of a picture, kept when it was replaced." });
      } else if (inLibrary) item.plan = "shared";
      else if (fresh && freshNames.has(picture.filename) && pictureFitsSlot(fresh.slot(picture.filename)?.harness, harnessStampOf(item.record, sha)).ok) {
        const own = capturedImage(path.join(fresh.labDir, "assets"), picture.filename);
        if (!own) item.plan = "carry";
        else if (fileSha256(own.file) === sha) item.plan = "present";
      }
      if (!item.plan) {
        const check = promoteFromLab(null, picture.filename, { bytes: picture.bytes, record: item.record, intent: "carry", dryRun: true });
        if (check.outcome === "would-share") item.plan = "share";
        else if (check.outcome === "already-shared") item.plan = "shared";
        else Object.assign(item, { plan: "keep", code: check.code, message: check.message });
      }
      items.push(item);
    }
    return { labId, labDir, items };
  }

  const PLAN_VIEW = ({ filename, plan, code, message, earlier }) => ({ filename, plan, earlier, ...(code ? { code, message } : {}) });

  /** The numbers the delete and replace messages use. `outcome` is the final answer for each picture. */
  function countPictures(items) {
    const real = items.filter((i) => !i.earlier);
    const n = (...names) => real.filter((i) => names.includes(i.outcome || i.plan)).length;
    const alreadyShared = n("shared");
    const toShare = n("share", "newly-shared");
    return {
      total: real.length,
      alreadyShared,
      toShare,
      shared: alreadyShared + toShare,
      carried: n("carry", "carried", "present"),
      kept: n("keep", "kept"),
      earlierVersions: items.filter((i) => i.earlier && (i.outcome || i.plan) !== "shared").length,
      retentionDays: kept().retentionDays,
    };
  }

  /** What deleting or replacing this lab would do to its pictures, without doing it (for the confirmation and the notices). */
  function previewLabPictures(labId, { newLabId = null } = {}) {
    const plan = planLabPictures(labId, { newLabId });
    if (plan.error) return { status: plan.status, body: { error: plan.error } };
    return { status: 200, body: { labId, counts: countPictures(plan.items), pictures: plan.items.map(PLAN_VIEW) } };
  }

  /**
   * Keep a lab's real pictures before its folder is removed. Every picture ends up in exactly one safe place:
   * the shared library, the replacing lab, or the kept-pictures archive. Nothing is overwritten and nothing is deleted;
   * running it again changes nothing more. Returns `{ok: false, error}` (and the lab must stay) when anything could not be kept.
   *
   * @param {string} labId
   * @param {{newLabId?: string|null, reason?: "deleted"|"replaced"|"failed-build"}} [options]
   */
  function carryLabPictures(labId, { newLabId = null, reason = newLabId ? "replaced" : "deleted" } = {}) {
    let plan;
    try {
      plan = planLabPictures(labId, { newLabId });
    } catch (err) {
      return { ok: false, status: 500, error: `This lab's pictures could not be checked, so nothing was removed: ${err.message}` };
    }
    if (plan.error) return { ok: false, status: plan.status, error: plan.error };
    const { items, labDir } = plan;
    if (!items.some((i) => !["shared", "present"].includes(i.plan))) return { ok: true, counts: countPictures(items), kept: [] };

    let release;
    try {
      release = acquireShareLock(keptFolder(), `lab-${labId}`);
    } catch (err) {
      return { ok: false, status: 500, error: `Somewhere to keep this lab's pictures could not be prepared, so nothing was removed: ${err.message}` };
    }
    if (!release) return { ok: false, status: 409, error: "Another change to this lab's pictures is in progress, so nothing was removed. Try again in a moment." };
    try {
      const fresh = newLabId ? labTarget(newLabId) : null;
      const stamp = new Date(now()).toISOString();
      const leftover = [];
      let carried = false;
      for (const item of items) {
        const callouts = labCalloutsOf(labDir, item.filename);
        const keep = (code, message) => {
          item.outcome = "kept";
          leftover.push({ filename: item.earlier ? `${item.filename}.previous` : item.filename, bytes: item.bytes, why: code || item.code, message: message || item.message || SHARE_MESSAGES[code], record: item.record, confirmation: item.confirmation, callouts });
        };
        if (item.plan === "shared" || item.plan === "present") {
          item.outcome = item.plan;
        } else if (item.plan === "carry") {
          try {
            fresh.writeImage(item.filename, item.bytes, callouts);
            if (item.record) fresh.writeRecord(item.filename, item.record);
            if (item.confirmation && validConfirmation(item.confirmation, item.sha)) fresh.writeConfirmation(item.filename, item.confirmation);
            fresh.afterCommit(item.filename, { source: item.record?.source || "carried", capturedAt: item.record?.acceptedAt || stamp, defer: true });
            item.outcome = "carried";
            carried = true;
          } catch (err) {
            logger?.(`[capture] Could not copy ${item.filename} into ${newLabId}: ${err.message}`);
            keep("carry-failed", "This picture could not be copied into the new lab, so it was kept.");
          }
        } else if (item.plan === "share") {
          let result;
          try {
            result = promoteFromLab(null, item.filename, { bytes: item.bytes, record: item.record, intent: "carry", capturedAt: item.record?.acceptedAt || null, callouts, defer: true });
          } catch (err) {
            result = { outcome: "skipped", code: "busy", message: err.message };
          }
          if (["shared", "replaced"].includes(result.outcome)) item.outcome = "newly-shared";
          else if (result.outcome === "already-shared") item.outcome = "shared";
          else keep(result.code, result.message);
        } else keep();
      }
      if (leftover.length) {
        try {
          kept().archive({ labId, labTitle: labTitleOf(labDir), reason, replacedBy: newLabId, pictures: leftover });
        } catch (err) {
          return { ok: false, status: 500, error: `This lab's pictures could not be saved, so nothing was removed: ${err.message}` };
        }
      }
      if (carried) refreshLab(newLabId);
      return { ok: true, counts: countPictures(items), kept: leftover.map((p) => p.filename) };
    } finally {
      release();
    }
  }

  /** The guard `deleteGeneratedLab`, `replaceGeneratedLab`, and a failed build run before they remove a lab folder. */
  function guardLabRemoval({ labId, reason, newLabId = null }) {
    return carryLabPictures(labId, { newLabId, reason });
  }

  // ── The kept-pictures archive ────────────────────────────────────────────

  /** Where a kept picture can go back to: a lab that has the slot, no picture of its own, and needs the harness the picture was taken in, or the shared library (when it has none). */
  function restoreOptionsFor(entry, picture) {
    const options = [];
    for (const id of new Set([entry.labId, entry.replacedBy].filter(Boolean))) {
      const target = labTarget(id);
      if (target.error || !target.filenames.includes(picture.base) || target.hasOwnImage(picture.base)) continue;
      // A picture is never put back into a slot that needs the other harness, or into one that needs a harness when none was recorded.
      if (!pictureFitsSlot(target.slot(picture.base)?.harness, picture.harness).ok) continue;
      options.push({ type: "lab", labId: id, title: labTitleOf(target.labDir) || id });
    }
    const libFile = libraryName(picture.base, picture.harness);
    if (!picture.earlierVersion && findLibrarySlot(libFile, { manifestDir }) && !libraryIsCommittedFolder() && !capturedImage(dirs().search, libFile)) options.push({ type: "library" });
    return options;
  }

  /** Whether a kept picture belongs to a slot that needs a harness. A product with no harnesses (SharePoint, Teams) has none, so its pictures are not "Harness not recorded". */
  function keptHarnessApplies(entry, picture, libraryIndex) {
    if (picture.harness) return true;
    for (const slot of libraryIndex.values()) if (slot.shot.slotFilename === picture.base) return Boolean(slot.harness);
    const target = entry.labId ? labTarget(entry.labId) : null;
    return Boolean(target && !target.error && target.slot(picture.base)?.harness);
  }

  /** Every kept picture with where it can be restored (`GET /api/capture/kept`). */
  function keptOverview() {
    const store = kept();
    const libraryIndex = libraryShotIndex({ manifestDir });
    return {
      retentionDays: store.retentionDays,
      entries: store.list().map((entry) => ({ ...entry, pictures: entry.pictures.map((p) => ({ ...p, harnessApplies: keptHarnessApplies(entry, p, libraryIndex), restore: restoreOptionsFor(entry, p) })) })),
    };
  }

  /** The bytes of one kept picture, for the preview and the download. */
  function keptPicture(entryId, filename) {
    const found = kept().read(entryId, filename);
    return found ? { bytes: found.bytes, filename } : null;
  }

  /**
   * Put a kept picture back: into a lab that has the slot and no picture of its own (`to: "lab"`), or into the shared library
   * (`to: "library"`, which needs `confirm: true` because every lab will show it). Nothing is replaced. The kept copy is removed
   * only after the picture is in place.
   */
  function restoreKept(entryId, filename, { to = null, labId = null, confirm = false } = {}) {
    const found = kept().read(entryId, filename);
    if (!found) return { status: 404, body: { error: "That kept picture was not found. It may have been restored or removed already." } };
    const { bytes, meta, entry } = found;
    const picture = entry.pictures.find((p) => p.filename === filename);
    if (!isRestorable(bytes, filename) || sha256Hex(bytes) !== meta.sha256) return { status: 409, body: { error: "The kept copy is damaged and cannot be restored. Download it instead." } };
    const base = baseFilename(filename);
    const options = restoreOptionsFor(entry, picture);
    const choice = to === "library" ? options.find((o) => o.type === "library") : options.find((o) => o.type === "lab" && (!labId || o.labId === labId));
    if (!choice) {
      return { status: 409, body: { error: "There is no place to put this picture back right now: the lab it came from has a picture here (or is gone) and the shared library does not take it. Download it instead.", options } };
    }
    if (choice.type === "library") {
      if (confirm !== true) return { status: 400, body: { error: "Confirm first: this picture will be used by every lab." } };
      const result = promoteFromLab(null, base, { bytes, record: meta.record, intent: "share", capturedAt: meta.record?.acceptedAt || null, callouts: cleanCallouts(meta.callouts), defer: true, confirmed: true });
      if (!["shared", "replaced", "already-shared"].includes(result.outcome)) return { status: 409, body: { error: result.message || "The shared library did not take this picture.", code: result.code } };
    } else {
      const target = labTarget(choice.labId);
      target.writeImage(base, bytes, cleanCallouts(meta.callouts));
      if (meta.record) target.writeRecord(base, meta.record);
      if (meta.confirmation && validConfirmation(meta.confirmation, meta.sha256)) target.writeConfirmation(base, meta.confirmation);
      // A person who restores a picture that was moved because it looked wrong has looked at it: it is marked Keep this one.
      else if (meta.why === "looks-wrong") target.writeConfirmation(base, makeConfirmation(meta.sha256, { by: "restore" }));
      target.afterCommit(base, { source: meta.record?.source || "restored", capturedAt: meta.record?.acceptedAt || new Date(now()).toISOString(), defer: false });
    }
    if (choice.type === "library" && meta.why === "looks-wrong") {
      const libFile = libraryName(base, picture.harness);
      withRecordsLock(() => {
        const latest = readRecordsFile(libraryRecordsFile);
        latest.confirmations[libFile] = makeConfirmation(meta.sha256, { by: "restore" });
        writeRecordsFile(libraryRecordsFile, latest);
      });
      libraryChanged();
    }
    kept().removePicture(entryId, filename);
    return { status: 200, body: { outcome: "restored", to: choice.type, ...(choice.type === "lab" ? { labId: choice.labId } : {}), filename: base } };
  }

  /** Delete one kept picture for good. */
  function removeKept(entryId, filename) {
    return kept().removePicture(entryId, filename)
      ? { status: 200, body: { outcome: "removed", filename } }
      : { status: 404, body: { error: "That kept picture was not found. It may have been restored or removed already." } };
  }

  // ── Moving the shared library between computers ──────────────────────────

  /** Every picture in the library's own folder (not the committed fallback) with its saved check and its "Mark as accurate", for the export. */
  function libraryPictures() {
    const { shots: records, confirmations } = readRecordsFile(libraryRecordsFile);
    const out = [];
    for (const slot of listLibrarySlots({ manifestDir, capturedDir: [dirs().primary] })) {
      if (!slot.captured || !slot.file) continue;
      const bytes = fs.readFileSync(slot.file);
      const sha = sha256Hex(bytes);
      const confirmation = confirmations[slot.filename] ? validConfirmation(confirmations[slot.filename], sha) : null;
      out.push({ filename: slot.filename, bytes, sha256: sha, record: records[slot.filename] || null, confirmedAt: confirmation?.at || null });
    }
    // Pictures from before harnesses were recorded travel as they are: still "Harness not recorded" on the other computer.
    for (const picture of listUnrecordedLibraryPictures({ manifestDir, capturedDir: [dirs().primary] })) {
      const bytes = fs.readFileSync(picture.file);
      out.push({ filename: picture.filename, bytes, sha256: sha256Hex(bytes), record: null, confirmedAt: null });
    }
    return out;
  }

  /** A picture saved under a slot's plain name (one from before harnesses were recorded) is imported as it is, still unrecorded. */
  function importUnrecordedPicture(filename, bytes, { replace = false, dryRun = false } = {}) {
    const done = (outcome, code, message) => ({ outcome, filename, ...(code ? { code, message } : {}) });
    const ext = path.extname(filename).toLowerCase();
    if (!isRealScreenshotBytes(bytes, ext)) return done("rejected", Buffer.isBuffer(bytes) && isPlaceholder(bytes) ? "placeholder" : "not-real", Buffer.isBuffer(bytes) && isPlaceholder(bytes) ? SHARE_MESSAGES.placeholder : SHARE_MESSAGES["not-real"]);
    const existing = capturedImage(dirs().primary, filename);
    if (existing) {
      if (fileSha256(existing.file) === sha256Hex(bytes)) return done("skipped", "already-there", "The library already has exactly this picture.");
      if (!replace) return done("skipped", "exists", "The library already has a different picture. Choose Replace existing pictures to use the imported one (the old one is kept as a backup).");
    }
    if (dryRun) return done(existing ? "would-replace" : "would-import");
    withShareLockSync(dirs().primary, filename, () => {
      fs.mkdirSync(dirs().primary, { recursive: true });
      if (existing) writeBytesAtomic(path.join(dirs().primary, `${filename}${PREVIOUS_SUFFIX}`), fs.readFileSync(existing.file));
      writeBytesAtomic(path.join(dirs().primary, filename), bytes);
    });
    libraryChanged();
    return done(existing ? "replaced" : "imported", "harness-not-recorded", "This picture has no harness recorded, so it is kept apart until you say which harness it shows.");
  }

  /**
   * Put one imported picture in the library the way an upload would: the same name, format, size, blank-page, and placeholder
   * checks. A picture the library already has is left alone unless `replace` is chosen (the old one is kept as a backup).
   *
   * @returns {{outcome: "imported"|"replaced"|"needs-review"|"skipped"|"rejected", filename: string, code?: string, message?: string}}
   */
  function importLibraryPicture(filename, bytes, { replace = false, dryRun = false, confirmedAt = null, expectedSha = null } = {}) {
    const target = libraryTarget();
    const done = (outcome, code, message) => ({ outcome, filename, ...(code ? { code, message } : {}) });
    if (!target.slot(filename)) {
      if (isLibrarySlotName(filename, { manifestDir })) return importUnrecordedPicture(filename, bytes, { replace, dryRun });
      return done("rejected", "not-a-slot", "This is not the name of a shared screenshot, so it was not imported.");
    }
    const ext = path.extname(filename).toLowerCase();
    if (!isRealScreenshotBytes(bytes, ext)) return done("rejected", Buffer.isBuffer(bytes) && isPlaceholder(bytes) ? "placeholder" : "not-real", Buffer.isBuffer(bytes) && isPlaceholder(bytes) ? SHARE_MESSAGES.placeholder : SHARE_MESSAGES["not-real"]);
    const sha = sha256Hex(bytes);
    const existing = capturedImage(dirs().primary, filename);
    if (existing) {
      if (fileSha256(existing.file) === sha) return done("skipped", "already-there", "The library already has exactly this picture.");
      if (!replace) return done("skipped", "exists", "The library already has a different picture. Choose Replace existing pictures to use the imported one (the old one is kept as a backup).");
    }
    if (dryRun) {
      const check = verifyUpload({ bytes, filename, expectedLabels: target.slot(filename).expectedLabels });
      if (check.level === "fail") return done("rejected", "failed-check", check.reasons[0]?.message || "The picture did not pass its check.");
      return done(existing ? "would-replace" : "would-import");
    }
    const result = submit(target, filename, bytes, { source: "import", retake: false });
    if (result.status === 422) return done("rejected", "failed-check", result.body.message || "The picture did not pass its check.");
    if (result.status === 202) return done("needs-review", "needs-review", "The picture needs a look before it is used. Open it in the Screenshot Center and accept or discard it.");
    if (result.status !== 200) return done("rejected", "not-saved", result.body.error || "The picture could not be saved.");
    if (confirmedAt && expectedSha === sha && Number.isFinite(Date.parse(confirmedAt))) {
      target.writeConfirmation(filename, makeConfirmation(sha, { at: confirmedAt }));
      libraryChanged();
    }
    return done(existing ? "replaced" : "imported");
  }

  /** Delete kept pictures older than the retention. Runs at start and daily; every removal is one plain log line. */
  function purgeKept() {
    return kept().purge();
  }

  /** How many pictures are kept and for how long, for the status line (cheap: no restore options). */
  function keptSummary() {
    const store = kept();
    const entries = store.list();
    return { entries: entries.length, pictures: entries.reduce((sum, e) => sum + e.pictures.length, 0), retentionDays: store.retentionDays };
  }

  // ── Pictures that look like the wrong screen ─────────────────────────────

  const LIBRARY_ENTRY_ID = "shared-library";
  const SUSPECT_CACHE_MS = 5000;
  let suspectCache = null;
  let flagCache = null;
  const forgetSuspects = () => {
    suspectCache = null;
    flagCache = null;
  };

  let recordsSnapshot = { key: "", value: null };
  /** The library's saved checks and Keep this one marks, re-read only when the file changed (this runs for every picture a lab shows). */
  function libraryRecords() {
    try {
      const info = fs.statSync(libraryRecordsFile);
      const key = `${info.size}:${info.mtimeMs}`;
      if (recordsSnapshot.key !== key) recordsSnapshot = { key, value: readRecordsFile(libraryRecordsFile) };
      return recordsSnapshot.value;
    } catch {
      return { shots: {}, confirmations: {} };
    }
  }

  /**
   * Whether the library picture at `file` may be copied into a new lab (or, with `forDisplay`, shown in a lab that has no picture of its
   * own): its saved check (when it has one) must be for these bytes and clean, and it must not look like the wrong screen (unless a
   * person marked this exact picture Keep this one). Showing a picture is stopped only by a clear finding; copying it also by a doubt.
   * A picture with no saved check at all (one committed in the repository) is judged by how it looks next to the others only.
   */
  function reuseVerdict(file, { forDisplay = false } = {}) {
    const filename = path.basename(String(file));
    const sha = fileSha256(file);
    if (!sha) return { ok: true };
    const { shots, confirmations } = libraryRecords();
    const kept = Boolean(confirmations[filename] && validConfirmation(confirmations[filename], sha));
    if (kept) return { ok: true };
    const record = shots[filename];
    if (record && !forDisplay) {
      if (record.sha256 !== sha) return { ok: false, message: SHARE_MESSAGES["check-mismatch"] };
      if (record.state !== "accepted" || record.level !== "pass" || (Array.isArray(record.reasons) && record.reasons.length)) return { ok: false, message: SHARE_MESSAGES.warned };
    }
    if (!flagCache || now() - flagCache.at > SUSPECT_CACHE_MS || flagCache.shas.get(filename) !== sha) {
      const scan = scanner.scan({ library: true, labIds: [] });
      flagCache = { at: now(), shas: new Map(scan.items.map((i) => [i.filename, i.sha256])), flagged: new Map(scan.items.filter((i) => i.level && !i.confirmed).map((i) => [i.filename, i])) };
    }
    const flagged = flagCache.flagged.get(filename);
    if (!flagged || (forDisplay && flagged.level !== "definite")) return { ok: true };
    return { ok: false, message: flagged.flags[0]?.message || SHARE_MESSAGES["looks-wrong"] };
  }

  /** One flagged picture as the Screenshot Center and the command line show it. */
  const suspectView = (item) => ({
    scope: item.scope,
    labId: item.labId || null,
    labTitle: item.labTitle || null,
    filename: item.filename,
    label: item.label,
    // The harness the screenshot needs and the one the picture is recorded as taken in, so a reviewer can tell at a glance.
    harness: item.harness || null,
    harnessLabel: item.harnessLabel || null,
    pictureHarness: item.pictureHarness || null,
    pictureHarnessLabel: item.harness ? pictureHarnessLabel(item.pictureHarness) : null,
    level: item.level,
    reason: item.flags[0]?.message || "",
    short: shortReason(item.flags),
    flags: item.flags.map(({ code, level, message }) => ({ code, level, message })),
    reach: item.reach,
    writable: item.writable,
    sha256: item.sha256,
    width: item.fingerprint?.w || null,
    height: item.fingerprint?.h || null,
  });

  const LEVEL_ORDER = { definite: 0, probable: 1 };
  const bySuspectOrder = (a, b) => (LEVEL_ORDER[a.level] ?? 2) - (LEVEL_ORDER[b.level] ?? 2) || String(a.labId || "").localeCompare(String(b.labId || "")) || a.filename.localeCompare(b.filename);

  /**
   * The pictures that look like the wrong screen, in the shared library and (with `labId`) in one lab. Reads only.
   * `GET /api/capture/suspect-pictures`.
   */
  function suspectPictures({ labId = null } = {}) {
    if (labId && !labFolder(labId)) return { status: 404, body: { error: "Generated lab not found" } };
    const result = scanner.scan({ library: true, labIds: labId ? [labId] : [] });
    const pictures = result.items.filter((item) => item.level && !item.confirmed).map(suspectView).sort(bySuspectOrder);
    const counts = { total: pictures.length, definite: pictures.filter((p) => p.level === "definite").length, probable: pictures.filter((p) => p.level === "probable").length };
    return { status: 200, body: { scannedAt: result.scannedAt, counts, notice: noticeText(counts.total), retentionDays: kept().retentionDays, pictures } };
  }

  /** The shared library's count of pictures that look wrong, for the status line and the start-up notice. Cached for a few seconds. */
  function suspectSummary({ fresh = false } = {}) {
    if (!fresh && suspectCache && now() - suspectCache.at < SUSPECT_CACHE_MS) return suspectCache.value;
    let value;
    try {
      const body = suspectPictures().body;
      value = { total: body.counts.total, definite: body.counts.definite, probable: body.counts.probable, notice: body.notice, scannedAt: body.scannedAt };
    } catch (err) {
      logger?.(`[capture] Could not check the library for pictures that look wrong: ${err.message}`);
      value = { total: 0, definite: 0, probable: 0, notice: "", scannedAt: null, error: err.message };
    }
    suspectCache = { at: now(), value };
    return value;
  }

  /** The bytes of a library picture, for the preview in the panel. A picture saved under a slot's plain name (no harness recorded) is shown too. */
  function libraryPicture(filename) {
    const found = capturedImage(dirs().search, filename);
    if (!found || !(findLibrarySlot(filename, { manifestDir }) || isLibrarySlotName(filename, { manifestDir }))) return null;
    return { bytes: fs.readFileSync(found.file), filename };
  }

  /**
   * "Move pictures that look wrong to the kept pictures list". Every picture it moves is first saved in the kept pictures archive
   * with its check, its Keep this one mark, and its callouts (for 90 days, restorable), and only then removed from the shared library
   * or the lab's assets; its slot goes back to pending. A dry run (the default) changes nothing and says what would happen.
   *
   * @param {object} [options]
   * @param {boolean} [options.dryRun] default true
   * @param {Array<{scope: "library"|"lab", labId?: string, filename: string}>|null} [options.items] move exactly these (the person chose them); default: every definite one
   * @param {boolean} [options.includeProbable] with no `items`, move the probable ones too
   * @param {string|null} [options.labId] limit the scan to the library and this lab
   */
  function quarantineWrongPictures({ dryRun = true, items = null, includeProbable = false, labId = null } = {}) {
    const chosen = Array.isArray(items) ? items : null;
    // Moving a shared picture also moves the copies of it in labs, so any choice that includes one looks at every lab.
    const labIds = chosen && !chosen.some((i) => i?.scope === "library") ? [...new Set(chosen.filter((i) => i?.scope === "lab" && labFolder(i.labId)).map((i) => i.labId))] : labId ? [labId] : null;
    if (labId && !labFolder(labId)) return { status: 404, body: { error: "Generated lab not found" } };
    const scan = scanner.scan({ library: true, labIds });
    const flagged = scan.items.filter((item) => item.level && !item.confirmed);
    const keyOf = (item) => `${item.scope}:${item.labId || ""}:${item.filename}`;
    let selected;
    const notMoved = [];
    if (chosen) {
      const wanted = new Set(chosen.map((i) => `${i?.scope}:${i?.scope === "lab" ? i.labId : ""}:${i?.filename}`));
      selected = flagged.filter((item) => wanted.has(keyOf(item)));
      for (const key of wanted) if (!selected.some((item) => keyOf(item) === key)) notMoved.push({ key, why: "This picture is not flagged, or a person already marked it Keep this one, so it was left alone." });
    } else {
      selected = flagged.filter((item) => item.level === "definite" || includeProbable);
    }
    // A copy of a moved library picture in a lab ("reused" or copied in when the lab was built) goes with it: it is the same picture.
    const movedSha = new Set(selected.filter((item) => item.scope === "library").map((item) => `${item.filename}:${item.sha256}`));
    for (const item of scan.items) {
      if (item.scope === "lab" && !item.confirmed && movedSha.has(`${item.filename}:${item.sha256}`) && !selected.includes(item)) selected.push(Object.assign(item, { derived: true, level: item.level || "definite", flags: item.flags.length ? item.flags : [{ code: "DUPLICATE_ACROSS_SLOTS", level: "definite", message: "This is a copy of a shared picture that was moved because it looked like the wrong screen." }] }));
    }
    const movable = [];
    for (const item of selected) {
      if (!item.writable) notMoved.push({ key: keyOf(item), filename: item.filename, scope: item.scope, labId: item.labId || null, why: "This picture is in the committed folder of the code repository, so it is not moved from here." });
      else movable.push(item);
    }

    const labs = [...new Set(movable.filter((i) => i.scope === "lab").map((i) => i.labId))].sort();
    const view = (item) => ({ ...suspectView(item), derived: item.derived === true });
    const plan = { dryRun, counts: { pictures: movable.length, library: movable.filter((i) => i.scope === "library").length, lab: movable.filter((i) => i.scope === "lab").length, labs: labs.length, slotsPending: new Set(movable.map((i) => i.filename)).size }, pictures: movable.map(view).sort(bySuspectOrder), notMoved, retentionDays: kept().retentionDays };
    if (dryRun || !movable.length) return { status: 200, body: { ...plan, moved: [], report: quarantineReport(plan, { moved: [] }) } };

    const moved = [];
    const failed = [];
    const groups = new Map();
    for (const item of movable) {
      const id = item.scope === "library" ? LIBRARY_ENTRY_ID : item.labId;
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(item);
    }
    for (const [ownerId, group] of groups) {
      const isLibrary = ownerId === LIBRARY_ENTRY_ID;
      const target = isLibrary ? libraryTarget() : labTarget(ownerId);
      if (target.error) {
        for (const item of group) failed.push({ filename: item.filename, scope: item.scope, labId: item.labId || null, why: target.error.body.error });
        continue;
      }
      const records = target.readRecords();
      const confirmations = target.readConfirmations();
      const pictures = [];
      const live = [];
      for (const item of group) {
        let bytes;
        try {
          bytes = fs.readFileSync(item.file);
        } catch {
          failed.push({ filename: item.filename, scope: item.scope, labId: item.labId || null, why: "The picture could not be read, so it was left where it is." });
          continue;
        }
        // The picture that was judged must be the one moved: a retake in between leaves the new one alone.
        if (sha256Hex(bytes) !== item.sha256) {
          failed.push({ filename: item.filename, scope: item.scope, labId: item.labId || null, why: "The picture changed while this ran, so it was left where it is." });
          continue;
        }
        const callouts = isLibrary ? cleanCallouts(readJson(path.join(path.dirname(item.file), sidecarName(item.filename)), null)?.callouts) : readLabCallouts(target, item.filename);
        pictures.push({ filename: item.filename, bytes, why: "looks-wrong", message: item.flags[0]?.message || "Looks like the wrong screen.", record: records[item.filename] || null, confirmation: confirmations[item.filename] || null, callouts });
        live.push(item);
      }
      if (!pictures.length) continue;
      try {
        kept().archive({ labId: ownerId, labTitle: isLibrary ? "Shared library" : labTitleOf(target.labDir), reason: "looks-wrong", pictures });
      } catch (err) {
        for (const item of live) failed.push({ filename: item.filename, scope: item.scope, labId: item.labId || null, why: `The picture could not be kept first, so nothing was moved: ${err.message}` });
        continue;
      }
      for (const item of live) {
        try {
          if (isLibrary) {
            withSlotLock(target, item.filename, () => {
              const dir = dirs().primary;
              const previous = path.join(dir, `${item.filename}${PREVIOUS_SUFFIX}`);
              if (fileSha256(previous) === item.sha256) fs.rmSync(previous, { force: true });
              fs.rmSync(path.join(dir, item.filename), { force: true });
              fs.rmSync(path.join(dir, sidecarName(item.filename)), { force: true });
              target.writeRecord(item.filename, null);
              target.writeConfirmation(item.filename, null);
            });
            libraryPending.add(item.filename);
          } else {
            const earlier = path.join(labPreviousDir(target.labDir), item.filename);
            if (fileSha256(earlier) === item.sha256) fs.rmSync(earlier, { force: true });
            target.writeRecord(item.filename, null);
            target.writeConfirmation(item.filename, null);
            writeBytesAtomic(path.join(target.labDir, "assets", item.filename), fs.readFileSync(PLACEHOLDER_PATH));
            fs.rmSync(path.join(target.labDir, "screenshots", sidecarName(item.filename)), { force: true });
            recordLabShotReset(target.labDir, { labId: target.labId, filename: item.filename, capturedDir: dirs().search });
          }
          moved.push({ filename: item.filename, scope: item.scope, labId: item.labId || null, label: item.label, level: item.level, reason: item.flags[0]?.message || "", short: shortReason(item.flags) });
        } catch (err) {
          failed.push({ filename: item.filename, scope: item.scope, labId: item.labId || null, why: `It was kept, but could not be removed: ${err.message}` });
        }
      }
      if (!isLibrary) refreshLab(ownerId);
    }
    if (moved.some((m) => m.scope === "library")) {
      libraryChanged();
      afterSlotLock(() => void flushLibraryRefresh().catch(() => {}));
    }
    forgetSuspects();
    const result = { ...plan, dryRun: false, moved, failed };
    return { status: 200, body: { ...result, report: quarantineReport(plan, { moved, failed }) } };
  }

  /** The plain report of a quarantine run, as lines of text. */
  function quarantineReport(plan, { moved = [], failed = [] } = {}) {
    const lines = [];
    const days = plan.retentionDays;
    if (plan.dryRun) {
      lines.push(plan.counts.pictures ? `${plan.counts.pictures} picture${plan.counts.pictures === 1 ? "" : "s"} would move to the kept pictures list (${plan.counts.library} in the shared library, ${plan.counts.lab} in ${plan.counts.labs} lab${plan.counts.labs === 1 ? "" : "s"}). Nothing was changed.` : "No pictures need to move.");
      if (plan.counts.pictures) lines.push(`${plan.counts.slotsPending} screenshot slot${plan.counts.slotsPending === 1 ? "" : "s"} would go back to pending. Moved pictures are kept for ${days} days and can be restored.`);
    } else {
      lines.push(moved.length ? `Moved ${moved.length} picture${moved.length === 1 ? "" : "s"} to the kept pictures list. Their screenshot slots are pending again. They are kept for ${days} days and can be restored.` : "No pictures were moved.");
      if (failed.length) lines.push(`${failed.length} picture${failed.length === 1 ? "" : "s"} could not be moved and were left where they were.`);
    }
    for (const item of plan.dryRun ? plan.pictures : moved) lines.push(`- ${item.scope === "library" ? "Shared library" : `Lab ${item.labId}`}: ${item.filename}${item.short ? ` (${item.short})` : ""}`);
    for (const item of failed) lines.push(`- Not moved: ${item.filename}: ${item.why}`);
    for (const item of plan.notMoved || []) lines.push(`- Left alone: ${item.filename || item.key}: ${item.why}`);
    return lines.join("\n");
  }

  return {
    lab: labTarget,
    library: libraryTarget,
    suspectPictures,
    suspectSummary,
    reuseVerdict,
    libraryPicture,
    quarantineWrongPictures,
    forgetSuspects,
    scanPictures: scanner.scan,
    pictureScanner: scanner,
    previewLabPictures,
    carryLabPictures,
    guardLabRemoval,
    keptOverview,
    keptPicture,
    restoreKept,
    removeKept,
    purgeKept,
    keptSummary,
    libraryPictures,
    importLibraryPicture,
    libraryState,
    submit,
    accept,
    reset,
    confirm,
    unconfirm,
    tagPicture,
    shareLabPicture,
    shareLabPictures,
    libraryUsage,
    readStaged,
    flushLab,
    flushLibrary: flushLibraryRefresh,
    refreshLab,
    resolveLabScreenshot: (labDir, filename) => resolveLabScreenshot(labDir, filename, { capturedDir: dirs().search }),
  };
}
