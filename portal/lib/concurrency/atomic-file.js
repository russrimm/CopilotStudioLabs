/**
 * Atomic file writes for every store the portal keeps on disk.
 *
 * A write goes to a temp file with a name nobody else can pick (process id plus a random id), then is renamed over the
 * target, so a reader sees the whole old file or the whole new one and two writers never share a temp file. The
 * ".blob-tmp-" marker is the name the Azure Blob mirror already skips, so a half-written copy is never uploaded, even
 * if the process stops between the write and the rename.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const RENAME_ATTEMPTS = 8;

/** Block this thread for `ms` milliseconds. Only for the tiny waits Windows needs between rename attempts. */
export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** A temp name beside `file` that is unique per call and ignored by the Blob mirror. */
export function tempPathFor(file) {
  return `${file}.blob-tmp-${process.pid}-${randomUUID()}`;
}

/** Rename, retrying briefly: Windows can refuse while an antivirus scanner or the Blob mirror holds the target. */
export function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (attempt >= RENAME_ATTEMPTS || !RETRY_CODES.has(err?.code)) throw err;
      sleepSync(15 * (attempt + 1));
    }
  }
}

/** Write `data` (a string or Buffer) to `file` atomically, creating the folder when needed. */
export function writeFileAtomic(file, data, options = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = tempPathFor(file);
  try {
    fs.writeFileSync(temp, data, { flag: "wx", ...(typeof data === "string" ? { encoding: options.encoding || "utf8" } : {}) });
    renameWithRetry(temp, file);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
}

/** Write `value` as JSON (two-space indent and a closing newline unless told otherwise). */
export function writeJsonAtomic(file, value, { spaces = 2, newline = true } = {}) {
  writeFileAtomic(file, `${JSON.stringify(value, null, spaces || undefined)}${newline ? "\n" : ""}`);
}

/** Read a JSON file, or `fallback` when it is missing or cannot be parsed. */
export function readJsonOr(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
