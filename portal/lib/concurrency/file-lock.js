/**
 * A cross-process lock made from one exclusive file (`wx`), for the few places where more than one process can write the
 * same file: the portal beside a command-line tool, or two portals on one volume. Inside one process prefer
 * keyed-mutex.js, which does not touch the disk.
 *
 * The lock file holds a random token. Only the holder that wrote the token removes it, and a lock older than `staleMs`
 * is a crashed run and is taken over. The name carries the ".blob-tmp-" marker so the Azure Blob mirror never uploads it.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sleepSync } from "./atomic-file.js";

const DEFAULTS = { timeoutMs: 10000, staleMs: 60000, retryMs: 20 };

export class LockTimeoutError extends Error {
  constructor(lockFile) {
    super("Another request is changing this right now. Try again in a moment.");
    this.name = "LockTimeoutError";
    this.code = "LOCK_TIMEOUT";
    this.status = 503;
    this.lockFile = lockFile;
  }
}

/** The lock file that guards `file`. */
export function lockPathFor(file) {
  return `${file}.blob-tmp-lock`;
}

function tryAcquire(lockFile, staleMs) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const token = randomUUID();
  try {
    fs.writeFileSync(lockFile, JSON.stringify({ token, pid: process.pid, at: Date.now() }), { flag: "wx" });
    return token;
  } catch (err) {
    // On Windows a lock file that was just released can still be "delete pending", and opening it then fails with EPERM,
    // EBUSY, or EACCES instead of EEXIST: all of these mean "held right now, try again".
    if (!["EEXIST", "EPERM", "EBUSY", "EACCES"].includes(err?.code)) throw err;
  }
  try {
    const age = Date.now() - fs.statSync(lockFile).mtimeMs;
    if (age > staleMs) {
      // Only one taker wins the rename; the others see the file gone and try the normal path again.
      const taken = `${lockFile}.stale-${process.pid}-${randomUUID()}`;
      fs.renameSync(lockFile, taken);
      fs.rmSync(taken, { force: true });
    }
  } catch {
    /* the holder released it, or another process took it over first */
  }
  return null;
}

function release(lockFile, token) {
  try {
    const held = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    if (held?.token === token) fs.rmSync(lockFile, { force: true });
  } catch {
    /* already gone or taken over */
  }
}

/** Run `work` while holding the lock, waiting (blocking this thread) up to `timeoutMs`. For short, synchronous sections. */
export function withFileLockSync(lockFile, work, { timeoutMs = DEFAULTS.timeoutMs, staleMs = DEFAULTS.staleMs, retryMs = DEFAULTS.retryMs } = {}) {
  const deadline = Date.now() + timeoutMs;
  let token = tryAcquire(lockFile, staleMs);
  while (!token) {
    if (Date.now() > deadline) throw new LockTimeoutError(lockFile);
    sleepSync(retryMs);
    token = tryAcquire(lockFile, staleMs);
  }
  try {
    return work();
  } finally {
    release(lockFile, token);
  }
}

/** Run `work` (which may await) while holding the lock, waiting without blocking the event loop. */
export async function withFileLock(lockFile, work, { timeoutMs = DEFAULTS.timeoutMs, staleMs = DEFAULTS.staleMs, retryMs = DEFAULTS.retryMs } = {}) {
  const deadline = Date.now() + timeoutMs;
  let token = tryAcquire(lockFile, staleMs);
  while (!token) {
    if (Date.now() > deadline) throw new LockTimeoutError(lockFile);
    await new Promise((resolve) => setTimeout(resolve, retryMs));
    token = tryAcquire(lockFile, staleMs);
  }
  try {
    return await work();
  } finally {
    release(lockFile, token);
  }
}
