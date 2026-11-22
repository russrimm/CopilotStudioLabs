/**
 * Read-modify-write for a JSON file that more than one process can change (the portal beside a command-line tool, or two
 * portals on one volume). The whole sequence runs under the cross-process lock from file-lock.js and the write goes
 * through atomic-file.js, so no update is lost and a reader never sees half a file.
 *
 * Inside one process, synchronous code is already uninterrupted; the lock only matters between processes. It is
 * reentrant within a process so a function that holds it can call another that takes it.
 */

import { readJsonOr, writeJsonAtomic } from "./atomic-file.js";
import { lockPathFor, withFileLockSync } from "./file-lock.js";

// Safe as a plain set because the guarded work is synchronous: no other code in this process runs while it is held.
const held = new Set();

/** Run `work` (synchronous) while holding the lock that guards `file`. A nested call for the same file just runs. */
export function withLockedFileSync(file, work, lockOptions) {
  const lockFile = lockPathFor(file);
  if (held.has(lockFile)) return work();
  return withFileLockSync(
    lockFile,
    () => {
      held.add(lockFile);
      try {
        return work();
      } finally {
        held.delete(lockFile);
      }
    },
    lockOptions,
  );
}

const MISSING = Symbol("missing");

/**
 * Change a JSON file under the lock: read it (`fallback` when it is missing or unreadable), call `updater(current)`, and
 * write what it returns. An `updater` that returns `undefined` leaves the file alone. Returns the value written, or the
 * current value when nothing was written.
 *
 * @param {string} file
 * @param {(current: any) => any} updater
 * @param {{fallback?: any, spaces?: number, newline?: boolean, timeoutMs?: number, staleMs?: number, retryMs?: number}} [options]
 */
export function updateJsonFileSync(file, updater, { fallback = null, spaces, newline, ...lockOptions } = {}) {
  return withLockedFileSync(
    file,
    () => {
      const read = readJsonOr(file, MISSING);
      const current = read === MISSING ? structuredClone(fallback) : read;
      const next = updater(current);
      if (next === undefined) return current;
      writeJsonAtomic(file, next, { spaces, newline });
      return next;
    },
    lockOptions,
  );
}
