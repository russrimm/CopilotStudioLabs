/**
 * Kept pictures: the recoverable archive for real screenshots that exist only in a lab that is being deleted or replaced.
 *
 * Nothing that was really captured is thrown away with its lab. A picture the shared library does not (and may not) hold is
 * saved here for 90 days, with its saved check, its "Mark as accurate" confirmation, and its callouts, so a person can
 * restore it or download it.
 *
 * Layout (inside the library folder, so it persists and is mirrored to Azure Blob with it):
 *
 *   <kept folder>/<labId>-<yyyymmddhhmmss>-<4 hex>/
 *       entry.json            who, why, when, when it expires, and one record per picture
 *       pictures/<file name>  the picture's exact bytes (an earlier version ends in .previous)
 *
 * An entry is built in a temporary folder (the `.blob-tmp-` marker keeps the Blob mirror from uploading half of it), every
 * picture is read back and checked against its SHA-256, and only then is the folder renamed into place. An entry is
 * therefore either complete or absent.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { isRealScreenshotBytes } from "../lab-builder/captured.js";
import { normalizeHarness } from "../../../tools/screenshot-capture/harness.mjs";
import { fileSha256, sha256Hex } from "./library-share.js";
import { cleanText, readJson, writeBytesAtomic, writeJsonAtomic } from "./store-util.js";

const harnessOfRecord = (record) => {
  const id = normalizeHarness(record?.harness?.id);
  return id && id !== "either" ? id : null;
};

export const KEPT_RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

const ENTRY_ID = /^[a-z0-9][a-z0-9-]{0,140}$/;
const PICTURE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(?:png|jpe?g|webp)(?:\.previous)?$/i;
const PREVIOUS = /\.previous$/i;
const ENTRY_FILE = "entry.json";
const PICTURES_DIR = "pictures";

/** The picture's own file name: an earlier version (`x.png.previous`) belongs to `x.png`. */
export const baseFilename = (name) => String(name).replace(PREVIOUS, "");

export const isKeptPictureName = (name) => typeof name === "string" && PICTURE_NAME.test(name) && !name.includes("..");

const stamp = (ms) => new Date(ms).toISOString().replace(/[-:T]/g, "").slice(0, 14);

/**
 * @param {object} options
 * @param {string} options.keptDir the archive folder
 * @param {() => number} [options.now]
 * @param {number} [options.retentionDays]
 * @param {(line: string) => void} [options.logger]
 */
export function createKeptStore({ keptDir, now = () => Date.now(), retentionDays = KEPT_RETENTION_DAYS, logger = null }) {
  const root = path.resolve(keptDir);
  const entryDir = (id) => path.join(root, id);
  const entryFile = (id) => path.join(entryDir(id), ENTRY_FILE);
  const pictureFile = (id, filename) => path.join(entryDir(id), PICTURES_DIR, filename);

  function readEntry(id) {
    if (!ENTRY_ID.test(String(id))) return null;
    const entry = readJson(entryFile(id), null);
    return entry && entry.schema === 1 && entry.id === id && entry.pictures && typeof entry.pictures === "object" ? entry : null;
  }

  function entryIds() {
    try {
      return fs
        .readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.isSymbolicLink() && ENTRY_ID.test(d.name))
        .map((d) => d.name);
    } catch {
      return [];
    }
  }

  const present = (entry, filename) => {
    try {
      return fs.statSync(pictureFile(entry.id, filename)).isFile();
    } catch {
      return false;
    }
  };

  function describe(entry) {
    const expiresMs = Date.parse(entry.expiresAt);
    const pictures = Object.entries(entry.pictures)
      .filter(([filename]) => present(entry, filename))
      .map(([filename, p]) => ({
        filename,
        base: baseFilename(filename),
        earlierVersion: PREVIOUS.test(filename),
        size: Number(p.size) || 0,
        sha256: p.sha256 || null,
        why: cleanText(p.why, 40) || "lab-only",
        message: cleanText(p.message, 300),
        hasCheck: Boolean(p.record),
        confirmed: Boolean(p.confirmation),
        // The harness the picture was recorded as taken in (only while its saved check belongs to these bytes), or null: "Harness not recorded".
        harness: p.record && p.record.sha256 && p.record.sha256 === p.sha256 ? harnessOfRecord(p.record) : null,
      }))
      .sort((a, b) => a.filename.localeCompare(b.filename));
    return {
      id: entry.id,
      labId: entry.labId,
      labTitle: cleanText(entry.labTitle, 200),
      reason: entry.reason,
      replacedBy: entry.replacedBy || null,
      keptAt: entry.keptAt,
      expiresAt: entry.expiresAt,
      daysLeft: Number.isFinite(expiresMs) ? Math.max(0, Math.ceil((expiresMs - now()) / DAY_MS)) : 0,
      pictures,
    };
  }

  /** Every entry that still has a picture, newest first. */
  function list() {
    return entryIds()
      .map(readEntry)
      .filter(Boolean)
      .map(describe)
      .filter((entry) => entry.pictures.length)
      .sort((a, b) => String(b.keptAt).localeCompare(String(a.keptAt)));
  }

  /** The SHA-256 of every picture of `labId` that is already kept, so keeping the same picture twice stays one copy. */
  function keptHashes(labId) {
    const seen = new Set();
    for (const id of entryIds()) {
      const entry = readEntry(id);
      if (!entry || entry.labId !== labId) continue;
      for (const [filename, p] of Object.entries(entry.pictures)) if (present(entry, filename)) seen.add(`${filename}:${p.sha256}`);
    }
    return seen;
  }

  /**
   * Keep pictures from a lab. Throws (keeping nothing) when anything could not be saved and verified.
   *
   * @param {object} input
   * @param {string} input.labId
   * @param {string} [input.labTitle]
   * @param {"deleted"|"replaced"|"failed-build"} input.reason
   * @param {string|null} [input.replacedBy] the lab that replaced it
   * @param {Array<{filename: string, bytes: Buffer, why?: string, message?: string, record?: object|null, confirmation?: object|null, callouts?: Array|null}>} input.pictures
   * @returns {{entryId: string|null, kept: string[], alreadyKept: string[]}}
   */
  function archive({ labId, labTitle = "", reason, replacedBy = null, pictures }) {
    const have = keptHashes(labId);
    const fresh = [];
    const alreadyKept = [];
    for (const picture of pictures) {
      if (!isKeptPictureName(picture.filename) || !Buffer.isBuffer(picture.bytes)) throw new Error(`Cannot keep ${cleanText(picture.filename, 80)}.`);
      (have.has(`${picture.filename}:${sha256Hex(picture.bytes)}`) ? alreadyKept : fresh).push(picture);
    }
    if (!fresh.length) return { entryId: null, kept: [], alreadyKept: alreadyKept.map((p) => p.filename) };

    const keptAtMs = now();
    const id = `${String(labId).toLowerCase()}-${stamp(keptAtMs)}-${crypto.randomBytes(2).toString("hex")}`;
    if (!ENTRY_ID.test(id)) throw new Error("Cannot keep pictures for this lab id.");
    fs.mkdirSync(root, { recursive: true });
    const temp = path.join(root, `.blob-tmp-${process.pid}-${crypto.randomUUID()}`);
    try {
      const records = {};
      for (const picture of fresh) {
        const target = path.join(temp, PICTURES_DIR, picture.filename);
        writeBytesAtomic(target, picture.bytes);
        const sha = sha256Hex(picture.bytes);
        if (fileSha256(target) !== sha) throw new Error(`The kept copy of ${picture.filename} did not match the original.`);
        records[picture.filename] = {
          sha256: sha,
          size: picture.bytes.length,
          why: cleanText(picture.why, 40) || "lab-only",
          message: cleanText(picture.message, 300),
          record: picture.record && typeof picture.record === "object" ? picture.record : null,
          confirmation: picture.confirmation && typeof picture.confirmation === "object" ? picture.confirmation : null,
          callouts: Array.isArray(picture.callouts) ? picture.callouts : null,
        };
      }
      const entry = {
        schema: 1,
        id,
        labId: String(labId),
        labTitle: cleanText(labTitle, 200),
        reason,
        replacedBy: replacedBy ? String(replacedBy) : null,
        keptAt: new Date(keptAtMs).toISOString(),
        expiresAt: new Date(keptAtMs + retentionDays * DAY_MS).toISOString(),
        retentionDays,
        pictures: records,
      };
      writeJsonAtomic(path.join(temp, ENTRY_FILE), entry);
      fs.renameSync(temp, entryDir(id));
    } catch (err) {
      fs.rmSync(temp, { recursive: true, force: true });
      throw err;
    }
    logger?.(`[kept-pictures] Kept ${fresh.length} picture(s) from ${labId} (${reason}) until ${new Date(keptAtMs + retentionDays * DAY_MS).toISOString().slice(0, 10)}.`);
    return { entryId: id, kept: fresh.map((p) => p.filename), alreadyKept: alreadyKept.map((p) => p.filename) };
  }

  /** One kept picture with everything saved beside it, or null. */
  function read(entryId, filename) {
    const entry = readEntry(entryId);
    if (!entry || !isKeptPictureName(filename) || !entry.pictures[filename]) return null;
    try {
      const bytes = fs.readFileSync(pictureFile(entryId, filename));
      return { entry: describe(entry), bytes, meta: entry.pictures[filename] };
    } catch {
      return null;
    }
  }

  /** Delete one kept picture for good (the whole entry when it was the last one). */
  function removePicture(entryId, filename) {
    const entry = readEntry(entryId);
    if (!entry || !isKeptPictureName(filename) || !entry.pictures[filename]) return false;
    const remaining = Object.keys(entry.pictures).filter((name) => name !== filename && present(entry, name));
    if (!remaining.length) {
      fs.rmSync(entryDir(entryId), { recursive: true, force: true });
      return true;
    }
    const { [filename]: _gone, ...rest } = entry.pictures;
    writeJsonAtomic(entryFile(entryId), { ...entry, pictures: rest });
    fs.rmSync(pictureFile(entryId, filename), { force: true });
    return true;
  }

  /** Delete every entry whose time is up. Logs one plain line per entry. */
  function purge() {
    const removed = [];
    for (const id of entryIds()) {
      const entry = readEntry(id);
      if (!entry) continue;
      const expires = Date.parse(entry.expiresAt);
      if (!Number.isFinite(expires) || expires > now()) continue;
      fs.rmSync(entryDir(id), { recursive: true, force: true });
      const count = Object.keys(entry.pictures).length;
      removed.push({ id, labId: entry.labId, pictures: count });
      logger?.(`[kept-pictures] Removed ${count} kept picture(s) from ${entry.labId}: they were kept for ${entry.retentionDays || retentionDays} days (since ${String(entry.keptAt).slice(0, 10)}) and no one restored them.`);
    }
    return { removed };
  }

  return { root, list, archive, read, removePicture, purge, retentionDays };
}

/** Whether `bytes` are a real screenshot of the type the file name says (a kept picture is checked again before it is restored). */
export function isRestorable(bytes, filename) {
  return isRealScreenshotBytes(bytes, path.extname(baseFilename(filename)).toLowerCase());
}
