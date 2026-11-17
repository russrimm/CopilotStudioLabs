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
 */

import fs from "node:fs";
import path from "node:path";

import { capturedImage, capturedScreenshotsDirs, resolveLabScreenshot } from "../lab-builder/captured.js";
import {
  getLabScreenshotsStatus,
  readLabVerification,
  recordLabShotCaptured,
  recordLabShotReset,
  refreshGeneratedLabOutputs,
  writeLabVerificationRecord,
} from "../lab-builder/lab-screenshots.js";
import { PLACEHOLDER_PATH } from "../lab-builder/slots.js";
import { expectedLabelsForShot } from "./classify.js";
import { findLibrarySlot, labSlotFilenames, listLibrarySlots } from "./plan.js";
import { cleanText, readJson, writeBytesAtomic, writeJsonAtomic } from "./store-util.js";
import { summarizeVerification, verifyUpload } from "./verify-upload.js";

const REFRESH_DELAY_MS = 2500;
const MAX_REFRESH_LABS = 50;

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
 */
export function createScreenshotStore({ generatedRoot, captureDir, capturedDirs, manifestDir, logger = null }) {
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

  // ── Lab and library targets share one interface ──────────────────────────

  function labTarget(labId) {
    const found = labSlotFilenames({ generatedRoot, labId, capturedDir: dirs().search });
    if (found.status !== 200) return { error: { status: found.status, body: { error: found.error } } };
    const slots = new Map(found.shots.map((s) => [s.filename, s]));
    return {
      kind: "lab",
      labId: found.labId,
      labDir: found.labDir,
      stagedDir: path.join(stagedRoot, `lab-${found.labId}`),
      slot(filename) {
        const shot = slots.get(filename);
        if (!shot) return null;
        return { expectedLabels: expectedLabelsForShot(shot), feature: shot.featureId || shot.feature || null };
      },
      readRecords: () => readLabVerification(found.labDir),
      writeRecord: (filename, record) => writeLabVerificationRecord(found.labDir, filename, record),
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
      readRecords: () => readJson(libraryRecordsFile, { shots: {} }).shots || {},
      writeRecord(filename, record) {
        const shots = readJson(libraryRecordsFile, { shots: {} }).shots || {};
        if (record) shots[filename] = record;
        else delete shots[filename];
        writeJsonAtomic(libraryRecordsFile, { schema: 1, updatedAt: new Date().toISOString(), shots });
      },
      writeImage(filename, bytes, callouts) {
        const dir = dirs().primary;
        fs.mkdirSync(dir, { recursive: true });
        writeBytesAtomic(path.join(dir, filename), bytes);
        if (callouts) writeJsonAtomic(path.join(dir, sidecarName(filename)), { schema: 1, filename, callouts });
      },
      afterCommit(filename, { defer }) {
        libraryPending.add(filename);
        if (defer) scheduleLibraryRefresh();
        else void flushLibraryRefresh().catch(() => {});
      },
      resetImage(filename) {
        const dir = dirs().primary;
        fs.rmSync(path.join(dir, filename), { force: true });
        fs.rmSync(path.join(dir, sidecarName(filename)), { force: true });
        libraryPending.add(filename);
        void flushLibraryRefresh().catch(() => {});
      },
      hasOwnImage: (filename) => Boolean(capturedImage(dirs().primary, filename)),
      state: () => libraryState(),
    };
  }

  function libraryState({ products } = {}) {
    const records = libraryTarget().readRecords();
    const productSet = products?.length ? new Set(products) : null;
    const slots = listLibrarySlots({ manifestDir, capturedDir: dirs().search })
      .filter((s) => !productSet || productSet.has(s.product))
      .map((s) => ({ ...s, verification: records[s.filename] || null, needsReview: records[s.filename]?.state === "needs-review" }));
    return {
      summary: {
        total: slots.length,
        captured: slots.filter((s) => s.captured).length,
        missing: slots.filter((s) => !s.captured).length,
        needsReview: slots.filter((s) => s.needsReview).length,
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
        if (!(plan?.shots || []).some((s) => filenames.has(s.filename))) continue;
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

  function commit(target, filename, bytes, { verification, source, capturedAt, callouts, defer, jobId = null }) {
    target.writeImage(filename, bytes, callouts);
    clearStaged(target, filename);
    target.writeRecord(filename, { ...summarizeVerification(verification), state: "accepted", source, jobId, acceptedAt: capturedAt });
    target.afterCommit(filename, { source, capturedAt, defer });
  }

  /**
   * Verify and store an uploaded image. `outcome` is `accepted`, `needs-review`, or `rejected`.
   *
   * @returns {{status: number, body: object}}
   */
  function submit(target, filename, bytes, { evidence = null, source = "upload", acceptWarnings = false, defer = false, callouts = null, jobId = null, requireEvidence = false, requireRedaction = false, expect = null, expectedLabels = null } = {}) {
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

    commit(target, filename, bytes, { verification, source, capturedAt, callouts: cleanCallouts(callouts), defer, jobId });
    return { status: 200, body: { outcome: "accepted", filename, verification: { ...record, state: "accepted" }, state: defer ? null : target.state() } };
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
    commit(target, filename, staged.bytes, {
      verification,
      source: staged.meta?.source || "upload",
      capturedAt: new Date().toISOString(),
      callouts: staged.meta?.callouts || null,
      defer,
      jobId: staged.meta?.jobId || null,
    });
    return { status: 200, body: { outcome: "accepted", filename, state: defer ? null : target.state() } };
  }

  /** Throw away a staged image, or reset a committed one to the placeholder so it can be retaken. */
  function reset(target, filename) {
    if (!target.slot(filename)) return { status: 404, body: { error: "That file name is not a screenshot slot here.", filename } };
    const hadStaged = Boolean(readStaged(target, filename));
    const hadOwn = target.hasOwnImage(filename);
    clearStaged(target, filename);
    target.writeRecord(filename, null);
    if (hadOwn || target.kind === "lab") target.resetImage(filename);
    return { status: 200, body: { outcome: "reset", filename, discardedStaged: hadStaged, removedImage: hadOwn, state: target.state() } };
  }

  return {
    lab: labTarget,
    library: libraryTarget,
    libraryState,
    submit,
    accept,
    reset,
    readStaged,
    flushLab,
    flushLibrary: flushLibraryRefresh,
    refreshLab,
    resolveLabScreenshot: (labDir, filename) => resolveLabScreenshot(labDir, filename, { capturedDir: dirs().search }),
  };
}
