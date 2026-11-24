/**
 * Reads every real picture the portal can show (the shared library and each generated lab's own pictures) with its saved check,
 * its slot, and its fingerprint, and asks picture-integrity.js which ones look like the wrong screen. Reads only: nothing here
 * writes, moves, or deletes a file. The Screenshot Center panel, the start-up notice, the quarantine tool, and the audit report
 * all read this one answer.
 */

import fs from "node:fs";
import path from "node:path";

import { fingerprintPicture, isFingerprint } from "../../../tools/screenshot-capture/fingerprint.mjs";
import { readCaptureConfig } from "../../../tools/feature-tour/lib/products.mjs";
import { isRealScreenshotBytes } from "../lab-builder/captured.js";
import { readLabConfirmations, readLabVerification } from "../lab-builder/lab-screenshots.js";
import { withShotHarness } from "../lab-builder/lab-harness.js";
import { harnessLabel, normalizeHarness } from "../../../tools/screenshot-capture/harness.mjs";
import { classifyShot } from "./classify.js";
import { sha256Hex, harnessStampOf, readRecordsFile, validConfirmation } from "./library-share.js";
import { libraryShotIndex } from "./plan.js";
import { assessPictures, countFlags, hostFamily, noticeText, slotDepth } from "./picture-integrity.js";
import { cleanText, readJson } from "./store-util.js";

const PICTURE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpe?g|webp)$/i;
const LAB_FOLDER = /^[a-z0-9][a-z0-9-]{0,99}$/i;
const FILE_CACHE_MAX = 5000;
const FINGERPRINT_CACHE_MAX = 3000;

// What was read from a file the last time (by path, size, and modified time) and what a picture looks like (by bytes), so a scan of
// a hundred labs does not decode a picture twice.
const fileCache = new Map();
const printCache = new Map();

function readPicture(file) {
  const info = fs.statSync(file);
  const key = `${file}|${info.size}|${info.mtimeMs}`;
  const hit = fileCache.get(key);
  if (hit) return hit;
  const bytes = fs.readFileSync(file);
  const read = { bytes: bytes.length, sha256: sha256Hex(bytes), real: isRealScreenshotBytes(bytes, path.extname(file).toLowerCase()), data: bytes };
  if (fileCache.size >= FILE_CACHE_MAX) fileCache.clear();
  // The bytes themselves are not kept in the cache: only what was learned from them.
  fileCache.set(key, { bytes: read.bytes, sha256: read.sha256, real: read.real });
  return read;
}

function fingerprintOf(file, read, record) {
  if (record && record.sha256 === read.sha256 && isFingerprint(record.fingerprint)) return record.fingerprint;
  if (printCache.has(read.sha256)) return printCache.get(read.sha256);
  const bytes = read.data || fs.readFileSync(file);
  const fp = fingerprintPicture(bytes);
  if (printCache.size >= FINGERPRINT_CACHE_MAX) printCache.clear();
  printCache.set(read.sha256, fp);
  return fp;
}

/** The host families each product's pages live on, from the capture settings. */
export function productHostsFromConfig(config) {
  const out = {};
  for (const [id, product] of Object.entries(config?.products || {})) {
    const hosts = new Set();
    const add = (url) => {
      try {
        hosts.add(hostFamily(new URL(url).hostname));
      } catch {
        // A section without a usable address adds nothing.
      }
    };
    add(product.startUrl);
    for (const section of Object.values(product.sections || {})) if (section?.url) add(section.url);
    out[id] = [...hosts];
  }
  return out;
}

const captionOf = (shot, filename) => cleanText(shot?.caption || shot?.alt || shot?.title || filename.replace(/\.[^.]+$/, ""), 120);

function describeSlot(shot, product) {
  if (!shot) return null;
  const capture = classifyShot({ ...shot, product: product || shot.product });
  return { product: capture.product, section: capture.section || null, depth: slotDepth(capture, shot), label: captionOf(shot, shot.filename || ""), kind: shot.kind || null, mode: capture.mode, harness: normalizeHarness(shot.harness) };
}

/**
 * @param {object} options
 * @param {string} options.generatedRoot the folder of generated labs
 * @param {string} options.captureDir `<data dir>/capture` (the library's saved checks)
 * @param {() => {primary: string, search: string[]}} options.capturedDirs the shared library's write folder and search path
 * @param {string} [options.manifestDir] the feature tour's shot lists
 */
export function createPictureScanner({ generatedRoot, captureDir, capturedDirs, manifestDir }) {
  const libraryRecordsFile = path.join(captureDir, "library-verification.json");

  /** Every real picture, with everything needed to judge it. Reads only. */
  function inventory({ library = true, labIds = null } = {}) {
    const config = readCaptureConfig();
    const slots = libraryShotIndex({ manifestDir });
    const librarySlot = (filename) => {
      const found = slots.get(filename);
      return found ? describeSlot({ ...found.shot, filename, harness: found.harness }, found.product) : null;
    };
    const pictures = [];

    if (library) {
      const { primary, search } = capturedDirs();
      const { shots: records, confirmations } = readRecordsFile(libraryRecordsFile);
      const seen = new Set();
      for (const dir of search) {
        let names = [];
        try {
          names = fs.readdirSync(dir);
        } catch {
          continue;
        }
        for (const name of names.sort()) {
          if (!PICTURE_FILE.test(name) || seen.has(name)) continue;
          const file = path.join(dir, name);
          let read;
          try {
            read = readPicture(file);
          } catch {
            continue;
          }
          if (!read.real) continue;
          seen.add(name);
          const record = records[name] || null;
          pictures.push({
            id: `library:${name}`,
            scope: "library",
            labId: null,
            labTitle: "",
            filename: name,
            file,
            writable: path.resolve(dir) === path.resolve(primary),
            bytes: read.bytes,
            sha256: read.sha256,
            fingerprint: fingerprintOf(file, read, record),
            record,
            harnessStamp: harnessStampOf(record, read.sha256),
            confirmed: Boolean(confirmations[name] && validConfirmation(confirmations[name], read.sha256)),
            slot: librarySlot(name),
          });
        }
      }
    }

    if (fs.existsSync(generatedRoot)) {
      const names = labIds ? [...labIds] : fs.readdirSync(generatedRoot, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.isSymbolicLink()).map((d) => d.name);
      for (const labId of names.sort()) {
        if (!LAB_FOLDER.test(labId)) continue;
        const labDir = path.join(generatedRoot, labId);
        const assets = path.join(labDir, "assets");
        if (!fs.existsSync(assets)) continue;
        const rawPlan = readJson(path.join(labDir, "screenshots", "shots.json"), null);
        // What each shot needs is worked out from the lab's harness, so a lab saved before harnesses were recorded is judged the same way.
        const plan = rawPlan ? withShotHarness(rawPlan) : null;
        const shotsByName = new Map((plan?.shots || []).map((s) => [s.filename, s]));
        const records = readLabVerification(labDir);
        const confirmations = readLabConfirmations(labDir);
        const labTitle = cleanText(readJson(path.join(labDir, "manifest.json"), null)?.title || plan?.title || "", 160);
        for (const name of fs.readdirSync(assets).sort()) {
          if (!PICTURE_FILE.test(name)) continue;
          const file = path.join(assets, name);
          let read;
          try {
            const info = fs.lstatSync(file);
            if (!info.isFile()) continue;
            read = readPicture(file);
          } catch {
            continue;
          }
          if (!read.real) continue;
          const record = records[name] || null;
          const shot = shotsByName.get(name);
          pictures.push({
            id: `lab:${labId}:${name}`,
            scope: "lab",
            labId,
            labTitle,
            filename: name,
            file,
            writable: true,
            bytes: read.bytes,
            sha256: read.sha256,
            fingerprint: fingerprintOf(file, read, record),
            record,
            harnessStamp: harnessStampOf(record, read.sha256),
            confirmed: Boolean(confirmations[name] && validConfirmation(confirmations[name], read.sha256)),
            slot: shot ? describeSlot(shot, shot.product || plan?.product) : librarySlot(name),
            captureSource: shot?.captureSource || null,
          });
        }
      }
    }
    return { pictures, productHosts: productHostsFromConfig(config) };
  }

  /**
   * Scan and judge. `library: false` leaves the shared library out; `labIds` limits the labs (null: every lab, []: none).
   * @returns {{scannedAt: string, counts: object, notice: string, items: object[], pictures: number}}
   */
  function scan({ library = true, labIds = null } = {}) {
    const { pictures, productHosts } = inventory({ library, labIds });
    const results = assessPictures(pictures, { productHosts });
    const byId = new Map(pictures.map((p) => [p.id, p]));
    const items = results.map((result) => {
      const p = byId.get(result.id);
      return { ...result, scope: p.scope, labId: p.labId, labTitle: p.labTitle, filename: p.filename, file: p.file, writable: p.writable, bytes: p.bytes, sha256: p.sha256, fingerprint: p.fingerprint, confirmed: p.confirmed, label: p.slot?.label || p.filename, product: p.slot?.product || null, section: p.slot?.section || null, kind: p.slot?.kind || null, harness: p.slot?.harness || null, harnessLabel: p.slot?.harness ? harnessLabel(p.slot.harness) : null, pictureHarness: p.harnessStamp || null, record: p.record, captureSource: p.captureSource || null };
    });
    const counts = countFlags(items);
    return { scannedAt: new Date().toISOString(), counts: { ...counts, pictures: items.length }, notice: noticeText(counts.total), items };
  }

  /** The slot of a picture as the scanner judges it (its product, depth, and label): a lab's own shot when `labId` is given, else the library's. Null for a name that is not a slot. */
  function slotOf(filename, { labId = null } = {}) {
    if (labId && LAB_FOLDER.test(labId)) {
      const plan = readJson(path.join(generatedRoot, labId, "screenshots", "shots.json"), null);
      const shot = (plan?.shots || []).find((s) => s.filename === filename);
      if (shot) return describeSlot(shot, shot.product || plan?.product);
    }
    const found = libraryShotIndex({ manifestDir }).get(filename);
    return found ? describeSlot({ ...found.shot, filename, harness: found.harness }, found.product) : null;
  }

  return { inventory, scan, slotOf, libraryRecordsFile };
}
