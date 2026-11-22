/**
 * Small, shared rules for a generated lab's folder while it changes.
 *
 *  - A lab that is still being built has a `.building` marker inside its folder. Readers (the list, open, export, and
 *    every other route that finds a lab by id) treat it as "not there yet", so nobody ever sees a half-written lab.
 *  - A lab that is deleted or replaced is first renamed to a trash folder (a rename inside one volume is atomic), so a
 *    reader sees the whole old lab or a clear "not found", never a half-deleted folder. The trash is then removed in the
 *    background. Trash and marker names carry ".blob-tmp-" or start with a dot, so the Azure Blob mirror and exports skip them.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { renameWithRetry } from "../concurrency/atomic-file.js";

export const BUILDING_MARKER = ".building";
export const TRASH_PREFIX = ".blob-tmp-trash-";
/** A build marker older than this belongs to a build that died; startup removes the folder. */
export const STALE_BUILD_MS = 30 * 60 * 1000;

export function markBuilding(labDir) {
  fs.writeFileSync(path.join(labDir, BUILDING_MARKER), `${new Date().toISOString()}\n`, "utf8");
}

export function clearBuilding(labDir) {
  fs.rmSync(path.join(labDir, BUILDING_MARKER), { force: true });
}

export function isBuilding(labDir) {
  return fs.existsSync(path.join(labDir, BUILDING_MARKER));
}

/**
 * Move a lab folder out of the library in one atomic step and remove it in the background.
 * Returns the trash path. Throws when the folder cannot be renamed (the caller reports that and leaves the lab in place).
 */
export function moveToTrash(rootDir, labDir) {
  const trash = path.join(rootDir, `${TRASH_PREFIX}${path.basename(labDir)}-${randomUUID()}`);
  renameWithRetry(labDir, trash);
  fs.promises.rm(trash, { recursive: true, force: true }).catch(() => {
    /* the next start sweeps leftovers */
  });
  return trash;
}

/** At start: remove trash a stopped process left behind and builds that never finished. Never throws. */
export function sweepLabLibrary(rootDir, { now = Date.now(), staleBuildMs = STALE_BUILD_MS } = {}) {
  const removed = { trash: 0, unfinished: 0 };
  let entries = [];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return removed;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(rootDir, entry.name);
    try {
      if (entry.name.startsWith(TRASH_PREFIX)) {
        fs.rmSync(dir, { recursive: true, force: true });
        removed.trash += 1;
      } else if (!entry.name.startsWith(".")) {
        const marker = path.join(dir, BUILDING_MARKER);
        if (fs.existsSync(marker) && now - fs.statSync(marker).mtimeMs > staleBuildMs) {
          fs.rmSync(dir, { recursive: true, force: true });
          removed.unfinished += 1;
        }
      }
    } catch {
      /* leave it for the next start */
    }
  }
  return removed;
}
