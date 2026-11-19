/**
 * Self-repair for generated labs built while placeholder pictures were copied in as screenshots.
 *
 * Older labs hold copies of captioned filler pictures in `assets/` and mark them captured in
 * `screenshots/shots.json` and `screenshots/learn-state.json`. This module finds those files (by content, never by
 * size), turns each slot back into a pending slot, and replaces the file with the neutral "Screenshot pending" image.
 * Real captures are never touched, and a lab with nothing to repair is not written at all.
 *
 * Order matters for crash safety: state first, then the Markdown caption, then the derived outputs (index.html,
 * topic documents), and only then the pictures. A crash before the last step leaves the filler in place, so the
 * next read finds it and finishes the job; a finished lab never matches again.
 */

import fs from "node:fs";
import path from "node:path";

import { PLACEHOLDER_REASONS, detectPlaceholder } from "./placeholder-detect.js";
import { PLACEHOLDER_PATH } from "./slots.js";

const IMAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpe?g|webp)$/i;
const RETRY_AFTER_FAILURE_MS = 30_000;
const LOCK_NAME = ".placeholder-repair.lock";
const LOCK_STALE_MS = 60_000;
const RENAME_RETRIES = 8;
const failedAt = new Map();

function tempName(file) {
  return `${file}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Rename over `to`, retrying briefly: on Windows another process reading the file makes the rename fail with EPERM. */
function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (attempt >= RENAME_RETRIES || !["EPERM", "EBUSY", "EACCES"].includes(err.code)) throw err;
      sleep(15 * (attempt + 1));
    }
  }
}

function writeAtomic(file, write) {
  const temp = tempName(file);
  try {
    write(temp);
    renameWithRetry(temp, file);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
}

/**
 * One repair at a time per lab across processes. Returns the lock file when it is taken, false when another process
 * holds it (a lock older than a minute is a crashed run and is taken over), and null when no lock can be made at all.
 */
function acquireLock(labDir) {
  const file = path.join(labDir, LOCK_NAME);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.closeSync(fs.openSync(file, "wx"));
      return file;
    } catch (err) {
      if (err.code !== "EEXIST") return null;
      try {
        if (Date.now() - fs.statSync(file).mtimeMs <= LOCK_STALE_MS) return false;
        fs.rmSync(file, { force: true });
      } catch {
        return false;
      }
    }
  }
  return false;
}

function writeJsonAtomic(file, data) {
  writeAtomic(file, (temp) => fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, "utf8"));
}

/**
 * The picture files in a lab's `assets/` folder that are filler placeholders. The neutral pending image is correct
 * as it is and never listed.
 *
 * @returns {Array<{filename: string, file: string, reason: string, label: string|null}>}
 */
export function findPlaceholderAssets(labDir) {
  const assetsDir = path.join(path.resolve(labDir), "assets");
  let entries;
  try {
    entries = fs.readdirSync(assetsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    if (!entry.isFile() || !IMAGE_NAME.test(entry.name)) continue;
    const file = path.join(assetsDir, entry.name);
    const verdict = detectPlaceholder(file);
    if (verdict.placeholder && verdict.reason !== PLACEHOLDER_REASONS.pendingImage) {
      found.push({ filename: entry.name, file, reason: verdict.reason, label: verdict.label || null });
    }
  }
  return found;
}

/** Overwrite `file` with the neutral "Screenshot pending" image, atomically. */
export function replaceWithPendingImage(file) {
  writeAtomic(file, (temp) => fs.copyFileSync(PLACEHOLDER_PATH, temp));
}

const REUSED_CAPTION = /^(\*Figure \d+\.\d+\. .+?)\. Reused from lab `[^`]+`\.\*$/;

/** Drop the "Reused from lab" credit under each repaired figure, so no caption says a picture was taken when it was not. */
function stripReuseCredits(markdown, filenames) {
  const lines = markdown.split("\n");
  let changed = false;
  for (const filename of filenames) {
    const at = lines.findIndex((line) => line.includes(`](assets/${filename})`));
    if (at === -1) continue;
    let next = at + 1;
    while (next < lines.length && lines[next].trim() === "") next += 1;
    const match = lines[next]?.match(REUSED_CAPTION);
    if (match) {
      lines[next] = `${match[1]}.*`;
      changed = true;
    }
  }
  return changed ? lines.join("\n") : markdown;
}

/** Mark the plan and learn state so each repaired slot is pending and nothing still claims it was captured. */
function resetPendingState(shotsPlan, learnState, filenames) {
  const names = new Set(filenames);
  const now = new Date().toISOString();
  const featureIds = new Set();
  let touched = false;
  for (const shot of shotsPlan.shots || []) {
    if (!names.has(shot.filename)) continue;
    const featureId = shot.featureId || shot.feature;
    featureIds.add(featureId);
    if (shot.status !== "pending" || shot.origin === "reused" || shot.capturedAt) touched = true;
    shot.status = "pending";
    if (shot.origin === "reused") shot.origin = "slot";
    delete shot.capturedAt;
    const state = (learnState.shots ||= {})[shot.filename];
    if (state && (state.captured || state.captureSource || state.stale)) touched = true;
    learnState.shots[shot.filename] = {
      ...(state || { shotId: shot.shotId, featureId, moduleOrder: shot.moduleOrder ?? null, filename: shot.filename }),
      captured: false,
      capturedAt: null,
      capturedStepHash: null,
      capturedContentFingerprint: null,
      captureSource: null,
      stale: false,
    };
  }
  for (const featureId of featureIds) {
    const mod = learnState.modules?.[featureId];
    if (mod && mod.status === "up-to-date") {
      mod.status = "missing-screenshot";
      touched = true;
    }
  }
  if (featureIds.size) {
    const stillUpdated = Object.values(learnState.modules || {}).some((m) => m.status === "docs-updated");
    learnState.learnSyncStatus = stillUpdated ? "docs-updated" : "missing-screenshot";
  }
  if (touched) {
    shotsPlan.updatedAt = now;
    learnState.updatedAt = now;
  }
  return { touched, slots: [...names].filter((name) => (shotsPlan.shots || []).some((s) => s.filename === name)) };
}

/**
 * Repair one generated lab.
 *
 * @param {string} labDir
 * @param {object} options
 * @param {() => {shotsPlan: object, learnState: object}} options.loadPlan the lab's screenshot plan and learn state
 * @param {(() => void)} [options.refreshOutputs] regenerate index.html, topic documents, and the manifest summary
 * @param {boolean} [options.dryRun] report what would change and write nothing
 * @returns {{changed: boolean, placeholders: Array<{filename: string, reason: string, label: string|null}>, slots: string[], busy?: boolean, error?: string}}
 *   `busy` is true when another process is repairing the same lab right now; that process finishes the job.
 */
export function repairGeneratedLabPlaceholders(labDir, { loadPlan, refreshOutputs, dryRun = false } = {}) {
  const resolvedDir = path.resolve(labDir);
  const found = findPlaceholderAssets(resolvedDir);
  const report = { changed: false, placeholders: found.map(({ filename, reason, label }) => ({ filename, reason, label })), slots: [] };
  if (!found.length) return report;

  const filenames = found.map((item) => item.filename);
  if (dryRun) {
    try {
      const { shotsPlan } = loadPlan();
      report.slots = filenames.filter((name) => (shotsPlan.shots || []).some((s) => s.filename === name));
    } catch {
      /* the dry run still reports the files */
    }
    return report;
  }

  const lastFailure = failedAt.get(resolvedDir);
  if (lastFailure && Date.now() - lastFailure < RETRY_AFTER_FAILURE_MS) return { ...report, error: "A repair failed moments ago; it will be retried." };

  const lock = acquireLock(resolvedDir);
  if (lock === false) return { ...report, busy: true };
  try {
    const { shotsPlan, learnState } = loadPlan();
    const state = resetPendingState(shotsPlan, learnState, filenames);
    report.slots = state.slots;
    if (state.touched) {
      writeJsonAtomic(path.join(resolvedDir, "screenshots", "shots.json"), shotsPlan);
      writeJsonAtomic(path.join(resolvedDir, "screenshots", "learn-state.json"), learnState);
    }

    const indexPath = path.join(resolvedDir, "index.md");
    if (fs.existsSync(indexPath)) {
      const markdown = fs.readFileSync(indexPath, "utf8");
      const updated = stripReuseCredits(markdown, filenames);
      if (updated !== markdown) writeAtomic(indexPath, (temp) => fs.writeFileSync(temp, updated, "utf8"));
    }

    refreshOutputs?.();
    for (const item of found) replaceWithPendingImage(item.file);
    failedAt.delete(resolvedDir);
    report.changed = true;
  } catch (err) {
    failedAt.set(resolvedDir, Date.now());
    report.error = err.message;
  } finally {
    if (lock) fs.rmSync(lock, { force: true });
  }
  return report;
}
