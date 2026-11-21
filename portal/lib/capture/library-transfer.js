/**
 * Moving the shared screenshot library between computers (a person's PC and the Azure portal).
 *
 * Export: a ZIP of the library's pictures plus `manifest.json` with each picture's SHA-256, a trimmed copy of its saved
 * check, and its "Mark as accurate" date. The manifest carries no addresses, page titles, or capture details: only what is
 * needed to judge a picture again.
 *
 * Import: a ZIP of pictures (in the root or in `pictures/`). Each picture goes through the same checks as an upload (name,
 * format, size, blank page, placeholder), a picture the library already has is skipped unless the person chooses to replace
 * it, and the answer says in plain words what was imported, skipped, or rejected.
 */

import { ZipArchive } from "archiver";

import { isSafeUploadFilename, MAX_UPLOAD_BYTES } from "./verify-upload.js";
import { cleanText } from "./store-util.js";
import { readZipEntries, ZipError } from "./zip-read.js";

export const EXPORT_ZIP_NAME = "shared-screenshots.zip";
export const EXPORT_MANIFEST = "manifest.json";
export const MAX_IMPORT_ZIP_BYTES = 128 * 1024 * 1024;
const MAX_IMPORT_PICTURES = 500;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;

export const EXPORT_WARNING =
  "Exported pictures should show no account names, email addresses, or customer data. They were hidden when captured, and importing checks them again, but look at them before you share the ZIP.";

/** The part of a saved check that is safe to travel: no addresses, page titles, or capture steps. */
function portableCheck(record) {
  if (!record || typeof record !== "object") return null;
  return {
    level: record.level === "fail" ? "fail" : record.level === "warn" ? "warn" : "pass",
    state: cleanText(record.state, 20) || null,
    acceptedAt: cleanText(record.acceptedAt, 40) || null,
    source: cleanText(record.source, 40) || null,
    format: cleanText(record.format, 10) || null,
    width: Number.isFinite(Number(record.width)) ? Number(record.width) : null,
    height: Number.isFinite(Number(record.height)) ? Number(record.height) : null,
    reasons: (Array.isArray(record.reasons) ? record.reasons : []).slice(0, 12).map((r) => ({ code: cleanText(r?.code, 40), level: cleanText(r?.level, 10) })),
    redaction: record.redaction && typeof record.redaction === "object" ? { applied: record.redaction.applied === true, masked: Number.isFinite(Number(record.redaction.masked)) ? Number(record.redaction.masked) : 0 } : null,
  };
}

/**
 * @param {{libraryPictures: () => Array<{filename: string, bytes: Buffer, sha256: string, record: object|null, confirmedAt: string|null}>}} store
 * @returns {Promise<{buffer: Buffer, count: number, manifest: object}>}
 */
export function buildLibraryExport(store, { now = () => Date.now() } = {}) {
  const pictures = store.libraryPictures();
  const manifest = {
    schema: 1,
    kind: "shared-screenshots",
    exportedAt: new Date(now()).toISOString(),
    warning: EXPORT_WARNING,
    pictures: Object.fromEntries(
      pictures.map((p) => [p.filename, { sha256: p.sha256, bytes: p.bytes.length, check: portableCheck(p.record), confirmedAt: p.confirmedAt || null }]),
    ),
  };
  return new Promise((resolve, reject) => {
    const archive = new ZipArchive({ zlib: { level: 6 } });
    const chunks = [];
    archive.on("data", (chunk) => chunks.push(chunk));
    archive.on("error", reject);
    archive.on("end", () => resolve({ buffer: Buffer.concat(chunks), count: pictures.length, manifest }));
    const date = new Date(manifest.exportedAt);
    archive.append(`${JSON.stringify(manifest, null, 2)}\n`, { name: EXPORT_MANIFEST, date });
    for (const picture of pictures) archive.append(picture.bytes, { name: `pictures/${picture.filename}`, date, store: true });
    archive.finalize();
  });
}

function parseManifest(entries) {
  const entry = entries.find((e) => e.name === EXPORT_MANIFEST);
  if (!entry || entry.size > MAX_MANIFEST_BYTES) return {};
  try {
    const parsed = JSON.parse(entry.read().toString("utf8"));
    return parsed && typeof parsed === "object" && parsed.pictures && typeof parsed.pictures === "object" ? parsed.pictures : {};
  } catch {
    return {};
  }
}

/**
 * Import a ZIP of pictures into the library.
 *
 * @param {object} store the screenshot store (`importLibraryPicture`)
 * @param {Buffer} buffer the ZIP file
 * @param {{replace?: boolean, dryRun?: boolean}} [options]
 * @returns {{status: number, body: object}}
 */
export function importLibraryZip(store, buffer, { replace = false, dryRun = false } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return { status: 400, body: { error: "Choose a ZIP file to import." } };
  if (buffer.length > MAX_IMPORT_ZIP_BYTES) return { status: 413, body: { error: `The ZIP is larger than ${Math.round(MAX_IMPORT_ZIP_BYTES / 1048576)} MB.` } };
  let entries;
  try {
    entries = readZipEntries(buffer, { maxEntries: MAX_IMPORT_PICTURES + 20, maxEntryBytes: MAX_UPLOAD_BYTES });
  } catch (err) {
    return { status: err instanceof ZipError ? 400 : 500, body: { error: err instanceof ZipError ? err.message : "The ZIP could not be read." } };
  }
  const manifest = parseManifest(entries);
  const report = { dryRun, replace, imported: [], replaced: [], needsReview: [], skipped: [], rejected: [], ignored: [] };
  const seen = new Set();
  let picked = 0;
  for (const entry of entries) {
    if (entry.name === EXPORT_MANIFEST) continue;
    const name = entry.name.startsWith("pictures/") ? entry.name.slice("pictures/".length) : entry.name;
    // Only a plain file name is ever used; a path, a traversal, or an unsafe name is reported and never read.
    if (!name || name.includes("/") || name.includes("\\") || name.includes("..") || !isSafeUploadFilename(name)) {
      report.ignored.push(cleanText(entry.name, 120));
      continue;
    }
    if (seen.has(name)) {
      report.rejected.push({ filename: name, code: "duplicate", message: "The ZIP holds this picture more than once, so only the first one was used." });
      continue;
    }
    seen.add(name);
    picked += 1;
    if (picked > MAX_IMPORT_PICTURES) {
      report.rejected.push({ filename: name, code: "too-many", message: `Only the first ${MAX_IMPORT_PICTURES} pictures of a ZIP are imported.` });
      continue;
    }
    let bytes;
    try {
      bytes = entry.read();
    } catch (err) {
      report.rejected.push({ filename: name, code: err instanceof ZipError ? "unreadable" : "failed", message: err.message });
      continue;
    }
    const meta = manifest[name];
    // A "Mark as accurate" travels only for these exact bytes.
    const confirmedAt = meta?.confirmedAt && meta?.sha256 ? meta.confirmedAt : null;
    const result = store.importLibraryPicture(name, bytes, { replace, dryRun, confirmedAt, expectedSha: meta?.sha256 || null });
    const row = { filename: name, ...(result.code ? { code: result.code, message: result.message } : {}) };
    if (result.outcome === "imported" || result.outcome === "would-import") report.imported.push(row);
    else if (result.outcome === "replaced" || result.outcome === "would-replace") report.replaced.push(row);
    else if (result.outcome === "needs-review") report.needsReview.push(row);
    else if (result.outcome === "skipped") report.skipped.push(row);
    else report.rejected.push(row);
  }
  const counts = { imported: report.imported.length, replaced: report.replaced.length, needsReview: report.needsReview.length, skipped: report.skipped.length, rejected: report.rejected.length, ignored: report.ignored.length };
  return { status: 200, body: { ...report, counts, message: importMessage(counts, dryRun) } };
}

const plural = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** "3 pictures imported. 2 skipped because the library already has them. 1 rejected." */
export function importMessage(counts, dryRun = false) {
  const done = counts.imported + counts.replaced;
  const parts = [`${plural(done, "picture")} ${dryRun ? "would be imported" : "imported"}.`];
  if (counts.needsReview) parts.push(`${plural(counts.needsReview, "picture")} ${counts.needsReview === 1 ? "needs" : "need"} a look before ${counts.needsReview === 1 ? "it is" : "they are"} used.`);
  if (counts.skipped) parts.push(`${counts.skipped} skipped because the library already has ${counts.skipped === 1 ? "it" : "them"}.`);
  if (counts.rejected) parts.push(`${counts.rejected} rejected.`);
  return parts.join(" ");
}
