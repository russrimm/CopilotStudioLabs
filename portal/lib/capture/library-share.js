/**
 * Rules for sharing a lab's screenshot with every lab ("capture once, reuse everywhere"), and for the optional
 * "Mark as accurate" confirmation. Pure decisions and small file helpers only; `screenshot-store.js` does the writing.
 *
 * A lab picture may enter the shared library only when ALL of these hold:
 *   1. its file name is a shared slot (a feature tour shot), never a lab-specific one;
 *   2. the bytes are a real screenshot (the right type, at least MIN_CAPTURED_BYTES, not a placeholder picture);
 *   3. its saved check belongs to exactly these bytes, passed or was accepted by a person, and did not fail;
 *   4. account details are proven hidden (the check record says masking was applied), because the library serves labs
 *      for other customers and brand profiles. A picture put in by hand carries no such proof, so it is only shared
 *      when a person says so ("Use this one for every lab"); a picture whose masking was requested and not applied
 *      is never shared.
 *
 * An image that already sits in the library is never overwritten silently: see `replacementVerdict`.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { isPlaceholder } from "../lab-builder/placeholder-detect.js";
import { isRealScreenshotBytes } from "../lab-builder/captured.js";
import { cleanText, readJson, writeJsonAtomic } from "./store-util.js";

/** The backup kept beside a library picture before it is replaced (the last one only). Never served as a slot. */
export const PREVIOUS_SUFFIX = ".previous";

/** Plain-language reasons a picture was not shared. Keyed by the code the API returns. */
export const SHARE_MESSAGES = Object.freeze({
  "lab-only": "This screenshot is specific to this lab, so it is not shared.",
  placeholder: "This is a placeholder picture, so it is not shared.",
  "not-real": "This is not a real screenshot, so it is not shared.",
  "no-check": "There is no saved check for this picture, so it was not shared.",
  "check-mismatch": "The saved check is for a different picture, so this one was not shared.",
  "not-accepted": "This picture has not been accepted yet, so it is not shared.",
  failed: "This picture did not pass its check, so it is not shared.",
  "not-masked": "Account details were not hidden in this picture, so it is not shared. Retake it with hiding turned on.",
  "masking-unproven": "We could not confirm that account details are hidden, so this picture stays in this lab. After you check it, choose Use this one for every lab.",
  "library-has-one": "The shared library already has a picture for this, so this lab keeps its own.",
  "library-confirmed": "The shared picture is marked accurate, so it was kept and this lab keeps its own. Choose Use this one for every lab to replace it.",
  "not-persistent": "The shared library here is the committed folder in the code repository, so pictures are only shared when you choose Use this one for every lab.",
  busy: "Another change to this picture is in progress, so nothing was shared. Try again in a moment.",
  "no-picture": "This lab has no picture of its own for this screenshot.",
});

export const sha256Hex = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

const shaCache = new Map();
const SHA_CACHE_MAX = 2000;

/** SHA-256 of a file, cached by size and modified time so repeated status reads never rehash an unchanged picture. */
export function fileSha256(file) {
  try {
    const info = fs.statSync(file);
    const hit = shaCache.get(file);
    if (hit && hit.size === info.size && hit.mtimeMs === info.mtimeMs) return hit.sha;
    const sha = sha256Hex(fs.readFileSync(file));
    if (shaCache.size >= SHA_CACHE_MAX) shaCache.clear();
    shaCache.set(file, { size: info.size, mtimeMs: info.mtimeMs, sha });
    return sha;
  } catch {
    return null;
  }
}

// ── Records files: verification records plus confirmations ──────────────────

const plainObject = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});

/** Read a `verification.json` / `library-verification.json` file: `{ shots, confirmations }` (both always objects). */
export function readRecordsFile(file) {
  const raw = readJson(file, {});
  return { shots: plainObject(raw?.shots), confirmations: plainObject(raw?.confirmations) };
}

/** Write a records file atomically, keeping both the verification records and the confirmations. */
export function writeRecordsFile(file, { shots, confirmations }) {
  const out = { schema: 1, updatedAt: new Date().toISOString(), shots: plainObject(shots) };
  const kept = plainObject(confirmations);
  if (Object.keys(kept).length) out.confirmations = kept;
  writeJsonAtomic(file, out);
}

/** A confirmation as a person's "Mark as accurate": the picture's SHA-256 ties it to exact bytes. */
export function makeConfirmation(sha256, { by = null, at = new Date().toISOString() } = {}) {
  return { sha256, at, ...(by ? { by: cleanText(by, 120) } : {}) };
}

/**
 * The confirmation, only while it still describes these bytes. A picture that was retaken, replaced, or uploaded again
 * has a different SHA-256, so its old confirmation stops counting without anything having to clear it.
 *
 * @returns {{at: string}|null}
 */
export function validConfirmation(confirmation, sha256) {
  if (!confirmation || typeof confirmation !== "object" || !sha256) return null;
  if (confirmation.sha256 !== sha256) return null;
  const at = cleanText(confirmation.at, 40);
  return { at: Number.isFinite(Date.parse(at)) ? at : null };
}

// ── Whether a lab picture may be shared ─────────────────────────────────────

const hasReason = (record, code) => Array.isArray(record?.reasons) && record.reasons.some((r) => r?.code === code);

/**
 * Decide whether one lab picture may enter the shared library.
 *
 * @param {object} input
 * @param {string} input.filename
 * @param {Buffer} input.bytes the picture's bytes
 * @param {object|null} input.record the lab's saved check for this picture (`verification.json`)
 * @param {object|null} input.slot the library slot (`findLibrarySlot`), null for a lab-specific shot
 * @param {"capture"|"retake"|"accept"|"backfill"|"share"} input.intent `share` is a person choosing it ("Use this one for every lab")
 * @returns {{ok: true, masking: "proven"|"person-checked"}|{ok: false, code: string, message: string}}
 */
export function shareVerdict({ filename, bytes, record, slot, intent }) {
  const no = (code) => ({ ok: false, code, message: SHARE_MESSAGES[code] });
  if (!slot) return no("lab-only");
  const ext = path.extname(String(filename)).toLowerCase();
  if (!Buffer.isBuffer(bytes) || !isRealScreenshotBytes(bytes, ext)) return no(Buffer.isBuffer(bytes) && isPlaceholder(bytes) ? "placeholder" : "not-real");
  // A check only counts for the exact bytes it was made on. A person sharing a picture on purpose can vouch for one without a check.
  const check = record && typeof record === "object" && record.sha256 === sha256Hex(bytes) ? record : null;
  if (!check) {
    if (intent === "share") return { ok: true, masking: "person-checked" };
    return no(record ? "check-mismatch" : "no-check");
  }
  if (check.level === "fail" || check.ok === false) return no("failed");
  if (check.state !== "accepted") return no("not-accepted");
  if (hasReason(check, "not-redacted") || check.redaction?.applied === false) return no("not-masked");
  if (check.redaction?.applied === true) return { ok: true, masking: "proven" };
  return intent === "share" ? { ok: true, masking: "person-checked" } : no("masking-unproven");
}

/**
 * What to do with the library's slot when a lab picture is offered.
 *
 * - no picture there yet: write it;
 * - the same picture: nothing to do (so sharing twice, or from two labs at once, is harmless);
 * - a different picture marked accurate: keep it, unless a person chose "Use this one for every lab" and confirmed the replace;
 * - a different picture that is not confirmed: replace it only for an explicit Retake, an explicit Accept, or a person's choice,
 *   and keep a backup; an ordinary capture or a backfill never replaces it.
 *
 * @returns {{action: "write"|"replace"|"same"|"skip", code?: string, message?: string}}
 */
export function replacementVerdict({ existing, existingSha, candidateSha, confirmed, intent, replaceConfirmed = false }) {
  if (!existing) return { action: "write" };
  if (existingSha && existingSha === candidateSha) return { action: "same" };
  if (confirmed) {
    if (intent === "share" && replaceConfirmed) return { action: "replace" };
    return { action: "skip", code: "library-confirmed", message: SHARE_MESSAGES["library-confirmed"] };
  }
  if (["retake", "accept", "share"].includes(intent)) return { action: "replace" };
  return { action: "skip", code: "library-has-one", message: SHARE_MESSAGES["library-has-one"] };
}

// ── One writer per picture, across processes ────────────────────────────────

const LOCK_STALE_MS = 60_000;

/**
 * Take the lock for one library picture. Returns a release function, or null when another process holds it (a lock older
 * than a minute is a crashed run and is taken over). The lock file carries the `.blob-tmp-` marker, so the Azure Blob
 * mirror never uploads it.
 */
export function acquireShareLock(dir, filename) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${filename}.blob-tmp-share-lock`);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.closeSync(fs.openSync(file, "wx"));
      return () => fs.rmSync(file, { force: true });
    } catch (err) {
      if (err.code !== "EEXIST") return null;
      try {
        if (Date.now() - fs.statSync(file).mtimeMs <= LOCK_STALE_MS) return null;
        fs.rmSync(file, { force: true });
      } catch {
        return null;
      }
    }
  }
  return null;
}
