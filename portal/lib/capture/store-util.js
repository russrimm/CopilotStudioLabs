/**
 * Small JSON persistence helpers shared by the capture stores.
 *
 * Reads always go to disk (no cache) so state mirrored in from Azure Blob after
 * startup, or edited by another process, is never stale. Temp files carry the
 * `.blob-tmp-` marker that the Azure Blob mirror already ignores.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

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
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.blob-tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

export function writeBytesAtomic(file, bytes) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.blob-tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(tmp, bytes);
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

export function cleanText(value, max = 200) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}
