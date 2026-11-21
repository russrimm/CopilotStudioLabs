/**
 * The one place that decides what happens to a lab's real pictures before the lab's folder is removed.
 *
 * Deleting a lab, replacing it with a rebuilt one, and throwing away a lab that failed to build all remove a folder that
 * may hold screenshots nobody can retake easily. The capture platform registers the guard that keeps them (see
 * `carryLabPictures` in capture/screenshot-store.js) for its generated-labs folder; every removal in that folder runs the
 * guard first and stops when it says no.
 *
 * Without a registered guard for a folder (an offline script that never started the capture platform) the lab is removed
 * as before.
 */

import path from "node:path";

const guards = new Map();
const keyOf = (rootDir) => path.resolve(String(rootDir));

/** Register (or clear, with `null`) the guard for one generated-labs folder: `(request) => {ok: true, ...}|{ok: false, error}`. */
export function setLabPictureGuard(rootDir, fn) {
  if (typeof fn === "function") guards.set(keyOf(rootDir), fn);
  else guards.delete(keyOf(rootDir));
}

/**
 * Keep a lab's pictures before its folder is removed.
 *
 * @param {object} request
 * @param {string} request.rootDir the generated-labs folder the lab is in
 * @param {string} request.labId the lab that is about to be removed
 * @param {"deleted"|"replaced"|"failed-build"} request.reason
 * @param {string|null} [request.newLabId] the lab that replaces it
 * @returns {{ok: true, counts?: object}|{ok: false, status?: number, error: string}}
 */
export function guardLabPictures(request) {
  const guard = request?.rootDir ? guards.get(keyOf(request.rootDir)) : null;
  if (!guard) return { ok: true, unguarded: true };
  try {
    return guard(request);
  } catch (err) {
    return { ok: false, error: `This lab's pictures could not be kept, so nothing was removed: ${err.message}` };
  }
}
