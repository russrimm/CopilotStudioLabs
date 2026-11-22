/**
 * Small JSON persistence helpers shared by the capture stores.
 *
 * Reads always go to disk (no cache) so state mirrored in from Azure Blob after
 * startup, or edited by another process, is never stale. Writes go through
 * ../concurrency/atomic-file.js: a temp file nobody else can pick, renamed over
 * the target, with the `.blob-tmp-` marker that the Azure Blob mirror already ignores.
 */

import { existsSync, readFileSync } from "node:fs";

import { writeFileAtomic, writeJsonAtomic as writeJsonAtomicFile } from "../concurrency/atomic-file.js";

export function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback;
    const raw = readFileSync(file, "utf8").trim();
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(file, value) {
  writeJsonAtomicFile(file, value);
}

export function writeBytesAtomic(file, bytes) {
  writeFileAtomic(file, bytes);
}

export function cleanText(value, max = 200) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}
