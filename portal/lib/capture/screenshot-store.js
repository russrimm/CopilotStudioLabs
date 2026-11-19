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

import { capturedImage, capturedScreenshotsDirs, resolveLabScreenshot } from "../lab-builder/captured.js";
import {
  getLabScreenshotsStatus,
  readLabConfirmations,
  readLabVerification,
  recordLabShotCaptured,
  recordLabShotReset,
  refreshGeneratedLabOutputs,
  writeLabConfirmation,
  writeLabVerificationRecord,
} from "../lab-builder/lab-screenshots.js";
import { PLACEHOLDER_PATH } from "../lab-builder/slots.js";
import { BAKED_CAPTURED_SCREENSHOTS_DIR } from "../storage-config.js";
import { expectedLabelsForShot } from "./classify.js";
import {
  PREVIOUS_SUFFIX,
  SHARE_MESSAGES,
  acquireShareLock,
  fileSha256,
  makeConfirmation,
  readRecordsFile,
  replacementVerdict,
  sha256Hex,
  shareVerdict,
  validConfirmation,
  writeRecordsFile,
} from "./library-share.js";
import { findLibrarySlot, labSlotFilenames, listLibrarySlots } from "./plan.js";
import { cleanText, readJson, writeBytesAtomic, writeJsonAtomic } from "./store-util.js";
import { summarizeVerification, verifyUpload } from "./verify-upload.js";

const REFRESH_DELAY_MS = 2500;
const MAX_REFRESH_LABS = 50;
const MAX_USAGE_LABS = 300;

function sidecarName(filename) {
  return `${filename.replace(/\.[^.]+$/, "")}.callouts.json`;
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
export function createScreenshotStore({ generatedRoot, captureDir, capturedDirs, manifestDir, logger = null, onChange = null }) {
  const stagedRoot = path.join(captureDir, "staged");
  const libraryRecordsFile = path.join(captureDir, "library-verification.json");
  const labTimers = new Map();
  const labPending = new Set();
  const libraryPending = new Set();
  let libraryTimer = null;

  const dirs = () => {
    const resolved = capturedDirs?.() ?? { primary: capturedScreenshotsDirs()[0], search: capturedScreenshotsDirs() };
    return resolved;
  };
  const libraryChanged = () => {
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
        return { expectedLabels: expectedLabelsForShot(shot), feature: shot.featureId || shot.feature || null };
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
        const { shots, confirmations } = readRecordsFile(libraryRecordsFile);
        if (record) shots[filename] = record;
        else delete shots[filename];
        writeRecordsFile(libraryRecordsFile, { shots, confirmations });
      },
      readConfirmations: () => readRecordsFile(libraryRecordsFile).confirmations,
      writeConfirmation(filename, confirmation) {
        const { shots, confirmations } = readRecordsFile(libraryRecordsFile);
        if (confirmation) confirmations[filename] = confirmation;
        else if (!(filename in confirmations)) return;
        else delete confirmations[filename];
        writeRecordsFile(libraryRecordsFile, { shots, confirmations });
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
        else void flushLibraryRefresh().catch(() => {});
        libraryChanged();
      },
      resetImage(filename) {
        const dir = dirs().primary;
        const current = capturedImage(dirs().search, filename);
        if (current) writeBytesAtomic(path.join(dir, `${filename}${PREVIOUS_SUFFIX}`), fs.readFileSync(current.file));
        fs.rmSync(path.join(dir, filename), { force: true });
        fs.rmSync(path.join(dir, sidecarName(filename)), { force: true });
        libraryPending.add(filename);
        void flushLibraryRefresh().catch(() => {});
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
    return {
      summary: {
        total: slots.length,
        captured: slots.filter((s) => s.captured).length,
        missing: slots.filter((s) => !s.captured).length,
        needsReview: slots.filter((s) => s.needsReview).length,
        confirmed: slots.filter((s) => s.confirmed).length,
      },
      shots: slots,
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
        const plan = readJson(shotsFile, null);
        // A lab that has its own picture for a slot keeps showing it, so only labs that show the library's picture need refreshing.
        const assets = path.join(generatedRoot, entry.name, "assets");
        const uses = (plan?.shots || []).some((s) => filenames.has(s.filename) && !capturedImage(assets, s.filename));
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
   * Offer a lab's picture to the shared library ("capture once, reuse everywhere"). Never throws for a rule: the answer says
   * what happened and, when nothing was shared, why in plain words.
   *
   * @param {"capture"|"retake"|"accept"|"backfill"|"share"} intent see `replacementVerdict` for what each may replace
   * @returns {{outcome: "shared"|"replaced"|"already-shared"|"skipped"|"would-share", filename: string, code?: string, message?: string}}
   */
  function promoteFromLab(target, filename, { bytes, record, intent, capturedAt = null, callouts = null, defer = true, replaceConfirmed = false, dryRun = false }) {
    const done = (outcome, extra = {}) => ({ outcome, filename, ...extra });
    const skip = (code, message) => done("skipped", { code, message: message || SHARE_MESSAGES[code] });
    const verdict = shareVerdict({ filename, bytes, record, slot: findLibrarySlot(filename, { manifestDir }), intent });
    if (!verdict.ok) return skip(verdict.code, verdict.message);
    // The committed folder is tracked by Git: a customer's picture must never land there unless a person chose to share it.
    if (libraryIsCommittedFolder() && !["share", "backfill"].includes(intent)) return skip("not-persistent");

    const { primary, search } = dirs();
    const release = dryRun ? () => {} : acquireShareLock(primary, filename);
    if (!release) return skip("busy");
    try {
      const existing = capturedImage(search, filename);
      const existingSha = existing ? fileSha256(existing.file) : null;
      const records = readRecordsFile(libraryRecordsFile);
      const decision = replacementVerdict({
        existing,
        existingSha,
        candidateSha: sha256Hex(bytes),
        confirmed: Boolean(validConfirmation(records.confirmations[filename], existingSha)),
        intent,
        replaceConfirmed,
      });
      if (decision.action === "skip") return skip(decision.code, decision.message);
      if (decision.action === "same") return done("already-shared");
      if (dryRun) return done("would-share", { replaces: decision.action === "replace" });

      // A replaced picture is kept (the last one only) so a bad capture cannot destroy a good one.
      if (existing) writeBytesAtomic(path.join(primary, `${filename}${PREVIOUS_SUFFIX}`), fs.readFileSync(existing.file));
      writeBytesAtomic(path.join(primary, filename), bytes);
      if (callouts) writeJsonAtomic(path.join(primary, sidecarName(filename)), { schema: 1, filename, callouts });
      else fs.rmSync(path.join(primary, sidecarName(filename)), { force: true });
      records.shots[filename] = { ...record, state: "accepted", acceptedAt: capturedAt || record?.acceptedAt || new Date().toISOString() };
      delete records.confirmations[filename];
      writeRecordsFile(libraryRecordsFile, records);

      libraryPending.add(filename);
      if (defer) scheduleLibraryRefresh();
      else void flushLibraryRefresh().catch(() => {});
      libraryChanged();
      return done(existing ? "replaced" : "shared", { previousKept: Boolean(existing) });
    } finally {
      release();
    }
  }

  function commit(target, filename, bytes, { verification, source, capturedAt, callouts, defer, jobId = null, intent = "capture" }) {
    target.writeImage(filename, bytes, callouts);
    clearStaged(target, filename);
    const record = { ...summarizeVerification(verification), state: "accepted", source, jobId, acceptedAt: capturedAt };
    target.writeRecord(filename, record);
    // New bytes: an earlier "Mark as accurate" no longer describes this picture.
    target.writeConfirmation(filename, null);
    target.afterCommit(filename, { source, capturedAt, defer });
    if (target.kind !== "lab") return null;
    const sharing = promoteFromLab(target, filename, { bytes, record, intent, capturedAt, callouts, defer });
    return sharing.code === "lab-only" ? null : sharing;
  }

  /**
   * Verify and store an uploaded image. `outcome` is `accepted`, `needs-review`, or `rejected`.
   * `retake` says the person asked for a new picture (so it may replace the library's, unless that one is marked accurate).
   *
   * @returns {{status: number, body: object}}
   */
  function submit(target, filename, bytes, { evidence = null, source = "upload", acceptWarnings = false, defer = false, callouts = null, jobId = null, requireEvidence = false, requireRedaction = false, expect = null, expectedLabels = null, retake = false } = {}) {
    const slot = target.slot(filename);
    if (!slot) return { status: 404, body: { error: "That file name is not a screenshot slot here.", filename } };
    const labels = Array.isArray(expectedLabels) && expectedLabels.length ? expectedLabels : slot.expectedLabels;
    const verification = verifyUpload({
      bytes,
      filename,
      evidence,
      expectedLabels: labels,
      expect,
      requireEvidence,
      requireRedaction,
    });
    const record = summarizeVerification(verification);
    if (verification.level === "fail") {
      return { status: 422, body: { outcome: "rejected", filename, verification: record, message: verification.reasons[0]?.message || "The image failed verification." } };
    }

    const capturedAt = new Date().toISOString();
    if (verification.level === "warn" && !acceptWarnings) {
      stage(target, filename, bytes, { verification: record, evidence: verification.evidence, source, jobId, stagedAt: capturedAt, callouts: cleanCallouts(callouts), expect, expectedLabels: labels });
      target.writeRecord(filename, { ...record, state: "needs-review", source, jobId, stagedAt: capturedAt });
      return {
        status: 202,
        body: { outcome: "needs-review", filename, verification: record, message: "The image was saved for review. Check it, then accept it or retake it." },
      };
    }

    const intent = retake ? "retake" : acceptWarnings ? "accept" : "capture";
    const sharing = commit(target, filename, bytes, { verification, source, capturedAt, callouts: cleanCallouts(callouts), defer, jobId, intent });
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
    const sharing = commit(target, filename, staged.bytes, {
      verification,
      source: staged.meta?.source || "upload",
      capturedAt: new Date().toISOString(),
      callouts: staged.meta?.callouts || null,
      defer,
      jobId: staged.meta?.jobId || null,
      intent: "accept",
    });
    return { status: 200, body: { outcome: "accepted", filename, ...(sharing ? { library: sharing } : {}), state: defer ? null : target.state() } };
  }

  /** Throw away a staged image, or reset a committed one to the placeholder so it can be retaken. */
  function reset(target, filename) {
    if (!target.slot(filename)) return { status: 404, body: { error: "That file name is not a screenshot slot here.", filename } };
    const hadStaged = Boolean(readStaged(target, filename));
    const hadOwn = target.hasOwnImage(filename);
    clearStaged(target, filename);
    target.writeRecord(filename, null);
    target.writeConfirmation(filename, null);
    if (hadOwn || target.kind === "lab") target.resetImage(filename);
    return { status: 200, body: { outcome: "reset", filename, discardedStaged: hadStaged, removedImage: hadOwn, state: target.state() } };
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

  /** The picture a target shows for a slot, and which records hold its confirmation. */
  function pictureOf(target, filename) {
    if (target.kind === "library") {
      const image = capturedImage(dirs().search, filename);
      return image ? { image, owner: target, scope: "library" } : null;
    }
    const resolved = resolveLabScreenshot(target.labDir, filename, { capturedDir: dirs().search });
    if (!resolved) return null;
    return resolved.source === "lab" ? { image: resolved, owner: target, scope: "lab" } : { image: resolved, owner: libraryTarget(), scope: "library" };
  }

  /** "Mark as accurate": a person says this picture is right. It is tied to the picture's exact bytes. Never blocks anything. */
  function confirm(target, filename, { by = null } = {}) {
    if (!target.slot(filename)) return { status: 404, body: { error: "That file name is not a screenshot slot here.", filename } };
    if (readStaged(target, filename)) return { status: 409, body: { error: "Accept or discard the picture that is waiting for review first.", filename } };
    const picture = pictureOf(target, filename);
    const sha = picture ? fileSha256(picture.image.file) : null;
    if (!sha) return { status: 409, body: { error: "There is no captured picture to mark as accurate yet.", filename } };
    const confirmation = makeConfirmation(sha, { by });
    picture.owner.writeConfirmation(filename, confirmation);
    if (picture.scope === "library") libraryChanged();
    return { status: 200, body: { outcome: "confirmed", filename, scope: picture.scope, confirmed: { at: confirmation.at }, state: target.state() } };
  }

  /** "Clear confirmation". */
  function unconfirm(target, filename) {
    if (!target.slot(filename)) return { status: 404, body: { error: "That file name is not a screenshot slot here.", filename } };
    const picture = pictureOf(target, filename);
    picture?.owner.writeConfirmation(filename, null);
    target.writeConfirmation(filename, null);
    if (picture?.scope === "library") libraryChanged();
    return { status: 200, body: { outcome: "unconfirmed", filename, scope: picture?.scope || target.kind, state: target.state() } };
  }

  /** How many other labs show the library's picture for a slot, so a retake can say who it affects. */
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
        const plan = readJson(shotsFile, null);
        if ((plan?.shots || []).some((s) => s.filename === filename) && !capturedImage(path.join(generatedRoot, entry.name, "assets"), filename)) otherLabs += 1;
      }
    }
    const confirmation = picture ? readRecordsFile(libraryRecordsFile).confirmations[filename] : null;
    return { status: 200, body: { filename, hasPicture: Boolean(picture), otherLabs, confirmed: Boolean(picture && validConfirmation(confirmation, fileSha256(picture.file))) } };
  }

  return {
    lab: labTarget,
    library: libraryTarget,
    libraryState,
    submit,
    accept,
    reset,
    confirm,
    unconfirm,
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
