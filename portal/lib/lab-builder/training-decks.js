/**
 * The pre-lab training decks of a generated lab, kept in `<labDir>/training/`.
 *
 *   Training deck - 00 Foundations - <Product>.pptx   one per product
 *   Training deck - Complete.pptx                      foundations, then every topic, with a running agenda
 *   Training deck - Module NN - <Title>.pptx           one per module and per prerequisite refresher
 *   training.json                                      what the files were built from (schema, fingerprint, descriptors)
 *
 * Decks are written when a lab is generated and synthesized on demand for labs built before they existed. A
 * deck is stale, and rebuilt, when the schema, the teaching library, or anything the lab says about the topic
 * (including the Microsoft Learn page record) changes: the saved fingerprint no longer matches.
 *
 * Writes are race-safe: every file is written under a unique temporary name in the same folder and renamed into
 * place, so another request or process never sees a partial file, and two writers of the same lab simply end up
 * with the same decks. Nothing here touches the lab's manifest, which other writers own.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadTrainingLibrary } from "./training-library.js";
import { TRAINING_DECK_PREFIX, TRAINING_FOLDER, TRAINING_SCHEMA_VERSION, TRAINING_ZIP_FOLDER, buildTrainingPlan } from "./training-plan.js";
import { renderTrainingDeck } from "./training-pptx.js";
import { buildCompleteDeck, buildFoundationsDeck, buildTopicDeck } from "./training-slides.js";

export const TRAINING_STATE_FILE = "training.json";
export const TRAINING_DECK_FORMATS = Object.freeze(["pptx", "outline"]);
export const TRAINING_MIME_TYPES = Object.freeze({
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  outline: "application/json; charset=utf-8",
});
const STALE_TMP_MS = 10 * 60 * 1000;

function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/** Write `data` to `target` so a reader sees the old file or the whole new one, never part of either. */
export function writeFileAtomic(target, data) {
  const temp = `${target}.${process.pid}.${crypto.randomBytes(5).toString("hex")}.tmp`;
  fs.writeFileSync(temp, data);
  let lastError = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      fs.renameSync(temp, target);
      return;
    } catch (err) {
      lastError = err;
      // Windows refuses to replace a file another process has open for a moment; try again shortly.
      if (!["EPERM", "EBUSY", "EACCES"].includes(err.code)) break;
      const until = Date.now() + 15 * (attempt + 1);
      while (Date.now() < until) {
        /* brief spin: this path is rare and short */
      }
    }
  }
  try {
    fs.rmSync(temp, { force: true });
  } catch {
    /* the temporary file is harmless */
  }
  throw lastError;
}

/** Remove temporary files an interrupted writer left behind. */
function sweepTemporaryFiles(dir) {
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".tmp")) continue;
      const file = path.join(dir, name);
      try {
        if (Date.now() - fs.statSync(file).mtimeMs > STALE_TMP_MS) fs.rmSync(file, { force: true });
      } catch {
        /* another writer got there first */
      }
    }
  } catch {
    /* no folder yet */
  }
}

function labInputs(labDir, options = {}) {
  const resolved = path.resolve(labDir);
  const labId = options.labId || path.basename(resolved);
  const indexPath = path.join(resolved, "index.md");
  const manifestPath = path.join(resolved, "manifest.json");
  const markdown = options.markdown !== undefined ? String(options.markdown) : fs.existsSync(indexPath) ? fs.readFileSync(indexPath, "utf8") : "";
  const manifest = options.manifest || (fs.existsSync(manifestPath) ? readJsonFile(manifestPath, {}) : {});
  return { resolved, labId, markdown, manifest };
}

/** Descriptors for every deck of a plan, with slide counts and flags, and the slide specs that draw them. */
export function planDecks(plan, library = loadTrainingLibrary()) {
  const decks = [];
  const push = (spec, extra) => {
    const fileName = `${extra.fileBaseName}.pptx`;
    decks.push({
      descriptor: {
        key: extra.key,
        kind: extra.kind,
        order: extra.order ?? null,
        productId: extra.productId ?? null,
        stepLabel: extra.stepLabel ?? null,
        title: extra.title,
        minutes: spec.minutes,
        slideCount: spec.slides.length,
        thin: Boolean(spec.thin),
        unreviewed: Boolean(spec.unreviewed),
        fileName,
        path: `${TRAINING_FOLDER}/${fileName}`,
      },
      spec,
    });
  };
  push(buildCompleteDeck(plan, { library }), { key: "complete", kind: "complete", title: `Complete training deck: ${plan.labTitle}`, fileBaseName: plan.completeFileBase });
  for (const foundation of plan.foundations) {
    const spec = buildFoundationsDeck(plan, foundation, { library });
    push(spec, { key: `foundations-${foundation.productId}`, kind: "foundations", productId: foundation.productId, title: spec.title, fileBaseName: foundation.fileBaseName });
  }
  for (const topic of plan.topics) {
    const spec = buildTopicDeck(plan, topic, { library });
    push(spec, { key: String(topic.order), kind: "topic", order: topic.order, stepLabel: topic.stepLabel, productId: topic.productId, title: topic.title, fileBaseName: topic.fileBaseName });
  }
  return decks;
}

/** The summary the list endpoint, the UI, and the export manifest use. */
export function summarizePlan(plan, descriptors) {
  return {
    schemaVersion: TRAINING_SCHEMA_VERSION,
    fingerprint: plan.fingerprint,
    labTitle: plan.labTitle,
    totalMinutes: plan.totalMinutes,
    handsOnMinutes: plan.handsOnMinutes,
    foundationsCount: plan.foundations.length,
    topicCount: plan.topics.length,
    decks: descriptors,
  };
}

function isValidDeckFile(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size < 1500) return false;
    const fd = fs.openSync(file, "r");
    try {
      const head = Buffer.alloc(4);
      fs.readSync(fd, head, 0, 4, 0);
      return head[0] === 0x50 && head[1] === 0x4b;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/**
 * Build every training deck for a lab and write them to `<labDir>/training/`, removing files the lab no longer has
 * and recording what they were built from in `training.json`.
 *
 * @returns {{summary: object, plan: object}}
 */
export function writeGeneratedLabTrainingDecks(labDir, options = {}) {
  const { resolved, labId, markdown, manifest } = labInputs(labDir, options);
  const library = options.library || loadTrainingLibrary();
  const plan = buildTrainingPlan({ markdown, manifest, labId, outputDir: resolved, library });
  const decks = planDecks(plan, library);
  const folder = path.join(resolved, TRAINING_FOLDER);
  // The lab folder must already exist: a reader that lost a race with delete or replace must not recreate it.
  try {
    fs.mkdirSync(folder);
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  }
  sweepTemporaryFiles(folder);

  const expected = new Set([TRAINING_STATE_FILE.toLowerCase()]);
  for (const { descriptor, spec } of decks) {
    const { buffer } = renderTrainingDeck(spec, { branding: options.branding, library });
    writeFileAtomic(path.join(folder, descriptor.fileName), buffer);
    expected.add(descriptor.fileName.toLowerCase());
  }
  const summary = summarizePlan(plan, decks.map((d) => d.descriptor));
  writeFileAtomic(path.join(folder, TRAINING_STATE_FILE), `${JSON.stringify({ ...summary, builtAt: new Date().toISOString() }, null, 2)}\n`);

  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name.endsWith(".tmp")) continue;
    if (!expected.has(entry.name.toLowerCase()) && /\.pptx$/i.test(entry.name)) {
      try {
        fs.rmSync(path.join(folder, entry.name), { force: true });
      } catch {
        /* a reader still has it open; the next build removes it */
      }
    }
  }
  return { summary, plan };
}

/**
 * Make sure the training decks exist and are current, synthesizing them on demand for labs built before
 * they existed. Returns the summary (descriptors, minutes, counts) and the plan.
 */
export function ensureGeneratedLabTrainingDecks(labDir, options = {}) {
  const { resolved, labId, markdown, manifest } = labInputs(labDir, options);
  const library = options.library || loadTrainingLibrary();
  const plan = buildTrainingPlan({ markdown, manifest, labId, outputDir: resolved, library });
  const folder = path.join(resolved, TRAINING_FOLDER);
  const state = readJsonFile(path.join(folder, TRAINING_STATE_FILE), null);
  const current =
    state &&
    state.schemaVersion === TRAINING_SCHEMA_VERSION &&
    state.fingerprint === plan.fingerprint &&
    Array.isArray(state.decks) &&
    state.decks.length > 0 &&
    state.decks.every((d) => isValidDeckFile(path.join(folder, d.fileName)));
  if (current && !options.force) return { summary: summarizePlan(plan, state.decks), plan };
  try {
    return writeGeneratedLabTrainingDecks(resolved, { ...options, labId, markdown, manifest, library });
  } catch (err) {
    // A read-only lab folder still gets its decks: they are rendered in memory and served without a cache.
    if (!["EACCES", "EPERM", "EROFS", "ENOENT"].includes(err.code)) throw err;
    const decks = planDecks(plan, library);
    return { summary: summarizePlan(plan, decks.map((d) => d.descriptor)), plan, uncached: true };
  }
}

/** Render one deck of a lab on the spot (used for custom branding, and when the cache cannot be written). */
export function renderTrainingDeckBuffer(plan, key, { branding, library = loadTrainingLibrary() } = {}) {
  const found = planDecks(plan, library).find((d) => d.descriptor.key === key);
  if (!found) return null;
  const { buffer, overflow } = renderTrainingDeck(found.spec, { branding, library });
  return { descriptor: found.descriptor, buffer, overflow, spec: found.spec };
}

/** The outline of a deck (slide titles, minutes, notes) as plain data, for review and for tests. */
export function trainingDeckOutline(plan, key, { library = loadTrainingLibrary() } = {}) {
  const found = planDecks(plan, library).find((d) => d.descriptor.key === key);
  if (!found) return null;
  return {
    ...found.descriptor,
    slides: found.spec.slides.map((s, i) => ({ number: i + 1, kind: s.kind, title: s.title, minutes: s.minutes, words: s.words || [], notes: s.notes || [] })),
  };
}

/** Which deck a URL segment names: a topic order, `complete`, `foundations`, or `foundations-<product>`. */
export function resolveDeckKey(rawKey, summary) {
  const key = String(rawKey ?? "").trim().toLowerCase();
  if (!key) return { error: "Training deck is required.", status: 400 };
  if (key === "foundations") {
    const found = summary.decks.filter((d) => d.kind === "foundations");
    if (found.length === 1) return { key: found[0].key };
    return { error: `This lab has ${found.length} products. Use foundations-<product id>: ${found.map((d) => d.key).join(", ")}.`, status: 400 };
  }
  if (key === "complete" || /^foundations-[a-z0-9-]+$/.test(key)) {
    return summary.decks.some((d) => d.key === key) ? { key } : { error: `Training deck "${key}" not found in generated lab.`, status: 404 };
  }
  if (/^\d+$/.test(key) && Number.parseInt(key, 10) >= 1) {
    const normalized = String(Number.parseInt(key, 10));
    return summary.decks.some((d) => d.key === normalized) ? { key: normalized } : { error: `Training topic ${normalized} not found in generated lab.`, status: 404 };
  }
  return { error: "Training deck must be a topic number, complete, foundations, or foundations-<product id>.", status: 400 };
}

/**
 * Read a cached deck file, retrying briefly if a writer is replacing it. Returns null when the file is missing
 * or is not a whole package, so the caller renders it instead.
 */
export function readCachedTrainingDeck(labDir, fileName) {
  const file = path.join(path.resolve(labDir), TRAINING_FOLDER, fileName);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      if (!isValidDeckFile(file)) return null;
      return fs.readFileSync(file);
    } catch (err) {
      if (!["EPERM", "EBUSY", "EACCES"].includes(err.code)) return null;
    }
  }
  return null;
}

/** Marks the decks of modules whose Microsoft Learn page changed (read from the lab's saved drift record; no network). */
export function learnChangedModuleIds(labDir) {
  const state = readJsonFile(path.join(path.resolve(labDir), "screenshots", "learn-state.json"), null);
  const changed = new Set();
  for (const [key, mod] of Object.entries(state?.modules || {})) {
    if (mod?.status === "docs-updated") changed.add(String(mod.featureId || key));
  }
  return changed;
}

/**
 * Descriptors for the list endpoint: each deck with its Learn-change flag. A topic whose Microsoft Learn page changed
 * is `stale`, the same way its lab text is, until the lab is refreshed from Learn.
 */
export function describeTrainingDecks(labDir, summary, plan) {
  const changed = learnChangedModuleIds(labDir);
  const idByOrder = new Map(plan.topics.map((t) => [String(t.order), t.id]));
  const decks = summary.decks.map((d) => {
    const topicId = d.kind === "topic" ? idByOrder.get(d.key) : null;
    const learnChanged = Boolean(topicId && changed.has(topicId));
    return { ...d, learnChanged, stale: learnChanged };
  });
  const complete = decks.find((d) => d.kind === "complete");
  if (complete) {
    complete.learnChanged = decks.some((d) => d.learnChanged);
    complete.stale = complete.learnChanged;
  }
  return { ...summary, decks };
}

/**
 * ZIP entries for the training decks: `[{name, data}]` under the folder that sorts first, plus a short README,
 * and the descriptor list for the export manifest. With `live` (replacements or custom branding apply) every deck is
 * rendered from the text given and nothing is cached; otherwise the lab's cached decks are used (and built if missing).
 */
export function trainingZipEntries(labDir, { labId, markdown, manifest, branding, live = false, library = loadTrainingLibrary() } = {}) {
  const { resolved, markdown: diskMarkdown, manifest: diskManifest, labId: resolvedLabId } = labInputs(labDir, { labId });
  let plan;
  let summary;
  let uncached = live;
  if (live) {
    plan = buildTrainingPlan({ markdown: markdown ?? diskMarkdown, manifest: manifest ?? diskManifest, labId: resolvedLabId, outputDir: resolved, library });
    summary = summarizePlan(plan, planDecks(plan, library).map((d) => d.descriptor));
  } else {
    const ensured = ensureGeneratedLabTrainingDecks(resolved, { labId: resolvedLabId, library });
    ({ plan, summary } = ensured);
    uncached = Boolean(ensured.uncached);
  }
  const entries = [];
  const files = [];
  let rendered = null;
  for (const deck of summary.decks) {
    let data = !uncached ? readCachedTrainingDeck(resolved, deck.fileName) : null;
    if (!data) {
      rendered ||= planDecks(plan, library);
      const found = rendered.find((d) => d.descriptor.key === deck.key);
      data = renderTrainingDeck(found.spec, { branding: live ? branding : undefined, library }).buffer;
    }
    entries.push({ name: `${TRAINING_ZIP_FOLDER}/${deck.fileName}`, data });
    files.push({ key: deck.key, kind: deck.kind, title: deck.title, minutes: deck.minutes, unreviewed: deck.unreviewed, file: `${TRAINING_ZIP_FOLDER}/${deck.fileName}` });
  }
  entries.push({ name: `${TRAINING_ZIP_FOLDER}/README.md`, data: renderTrainingFolderReadme(plan, summary) });
  return { entries, files, summary, plan };
}

/** The short README at the top of the training folder: what to deliver first and how long it takes. */
export function renderTrainingFolderReadme(plan, summary) {
  const lines = [`# Training decks: deliver these first`, "", `For people who are new to this. No lab steps. About ${summary.totalMinutes} minutes in total, then the hands-on lab (about ${summary.handsOnMinutes} minutes).`, ""];
  const complete = summary.decks.find((d) => d.kind === "complete");
  if (complete) lines.push(`- **${complete.fileName}**: everything in one file, in teaching order, with a running agenda (${complete.slideCount} slides, about ${complete.minutes} minutes).`);
  for (const d of summary.decks.filter((x) => x.kind === "foundations")) lines.push(`- **${d.fileName}**: the shared ideas and words for one product (about ${d.minutes} minutes).`);
  lines.push("", "## One deck per topic", "");
  for (const d of summary.decks.filter((x) => x.kind === "topic")) lines.push(`- ${d.fileName}: about ${d.minutes} minutes${d.unreviewed ? ". Review before you present: this topic comes only from Microsoft Learn." : ""}`);
  lines.push("", "Every slide has speaker notes with a talk track, an example to say out loud, a question for the room, what to demo, and its time.", "");
  return lines.join("\n");
}

export { TRAINING_DECK_PREFIX, TRAINING_FOLDER, TRAINING_ZIP_FOLDER };
