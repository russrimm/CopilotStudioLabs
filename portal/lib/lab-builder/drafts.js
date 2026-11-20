/**
 * Saved drafts of a partly configured lab, and the one "unsaved work" slot behind the wizard's autosave.
 *
 * A draft holds the wizard's choices, not a lab. Its `selections` use the same fields as the selections a built lab
 * saves in its manifest (see selectionsFromManifest in generated-labs.js), so "Edit selections" and "Resume" share one
 * schema. The wizard-only extras (the step, which steps were answered, the learner's own topic picks, the modules taken
 * out in Review, and the names of what was chosen) live beside them.
 *
 * Files live under `<data dir>/lab-builder/drafts/<owner>/`, one JSON file per draft, so they follow the portal's
 * persistent storage (and its Blob mirror). `<owner>` is `local` when portal sign-in is off, otherwise a one-way hash of
 * the signed-in identity: a person's drafts are never listed, read, changed, or deleted for anyone else, and no name or
 * address is written to disk. Every write goes to a temp file first and is then renamed into place.
 *
 * Kept free of Express so it can be tested directly. Every failure is a DraftError with a plain-language message.
 */

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** The version written into every file. Bump it, and add a step to MIGRATIONS, when the saved shape changes. */
export const DRAFT_SCHEMA_VERSION = 1;
export const MAX_DRAFTS = 50;
export const MAX_DRAFT_BYTES = 256 * 1024;
export const MAX_NAME_LENGTH = 80;
export const UNSAVED_ID = "unsaved";

const MAX_IDS = 1000;
const MAX_SUBTOPIC_IDS = 5000;
const MAX_LABELS = 2000;
const MAX_LABEL_LENGTH = 120;
const ID_TEXT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const DRAFT_ID = /^draft-[0-9a-f]{24}$/;
const LAB_ID = /^[a-z0-9-]{1,100}$/i;
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;
const CHOSEN_STEPS = ["product", "vertical", "departments", "level", "harness", "topics"];
const OVERRIDE_KEYS = ["companyName", "tagline", "moreInfoUrl", "moreInfoLabel", "supportName", "supportEmail", "footerText"];
const STEP_COUNT = 8;

/** A failure with a message that is safe and clear enough to show a person as it is. */
export class DraftError extends Error {
  constructor(message, status = 400, code = "invalid") {
    super(message);
    this.name = "DraftError";
    this.status = status;
    this.code = code;
  }
}

/** Steps that upgrade a file saved by an older version, keyed by the version they upgrade from. */
const MIGRATIONS = Object.freeze({});

export function isDraftId(value) {
  return typeof value === "string" && DRAFT_ID.test(value);
}

export function newDraftId() {
  return `draft-${randomBytes(12).toString("hex")}`;
}

/**
 * Whose space the drafts belong to. A signed-in person gets a private space named by a one-way hash of their identity;
 * with sign-in off there is one shared local space. Returns null when sign-in is on but no identity arrived.
 */
export function ownerKeyFor(user, { authEnabled = false } = {}) {
  const identity = user && (user.oid || user.upn) ? `${String(user.tid || "").toLowerCase()}:${String(user.oid || user.upn).toLowerCase()}` : "";
  if (identity) return `u-${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
  return authEnabled ? null : "local";
}

export function draftsDirFor(dataDir) {
  return path.join(dataDir, "lab-builder", "drafts");
}

function cleanLine(value, max) {
  return String(value ?? "")
    .replace(CONTROL_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** A draft name: one line, 1 to 80 characters. */
export function cleanDraftName(value) {
  const name = cleanLine(value, MAX_NAME_LENGTH + 1);
  if (!name) throw new DraftError("Give the draft a name.");
  if (name.length > MAX_NAME_LENGTH) throw new DraftError(`Use ${MAX_NAME_LENGTH} characters or fewer for the draft name.`);
  return name;
}

function idList(value, label, { max = MAX_IDS } = {}) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new DraftError(`The ${label} in this draft are not a list, so it was not saved.`);
  if (value.length > max) throw new DraftError(`This draft has more ${label} than can be saved (${max} at most). Remove some and try again.`);
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== "string" || !ID_TEXT.test(item)) throw new DraftError(`One of the ${label} in this draft is not valid, so it was not saved.`);
    seen.add(item);
  }
  return [...seen];
}

function optionalId(value, label) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !ID_TEXT.test(value)) throw new DraftError(`The ${label} in this draft is not valid, so it was not saved.`);
  return value;
}

function optionalText(value, max) {
  if (value === undefined || value === null) return null;
  const text = cleanLine(value, max);
  return text || null;
}

function stepNumber(value, fallback, label) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > STEP_COUNT) throw new DraftError(`The ${label} in this draft is not a wizard step, so it was not saved.`);
  return value;
}

function flag(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Check and clean what the wizard sent. Unknown fields are left out; a field that is the wrong kind of value is
 * refused with a plain message instead of being repaired, so a bug in the page can never quietly change a draft.
 */
export function normalizeDraftContent(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new DraftError("There is nothing to save yet.");
  const sel = raw.selections && typeof raw.selections === "object" && !Array.isArray(raw.selections) ? raw.selections : null;
  if (!sel) throw new DraftError("There is nothing to save yet.");

  const products = idList(sel.products, "products");
  if (!products.length) throw new DraftError("Choose at least one product before you save a draft.");
  if (sel.level !== undefined && sel.level !== null && ![100, 200, 300].includes(sel.level)) throw new DraftError("The level in this draft is not Level 100, 200, or 300, so it was not saved.");
  if (sel.targetMinutes !== undefined && sel.targetMinutes !== null && (!Number.isInteger(sel.targetMinutes) || sel.targetMinutes < 1 || sel.targetMinutes > 100000)) {
    throw new DraftError("The target time in this draft is not a whole number of minutes, so it was not saved.");
  }
  const overrides = {};
  if (sel.brandOverrides && typeof sel.brandOverrides === "object" && !Array.isArray(sel.brandOverrides)) {
    for (const key of OVERRIDE_KEYS) {
      const text = typeof sel.brandOverrides[key] === "string" ? cleanLine(sel.brandOverrides[key], 500) : "";
      if (text) overrides[key] = text;
    }
  }
  const selections = {
    products,
    industry: optionalId(sel.industry, "industry"),
    roles: idList(sel.roles, "departments"),
    level: sel.level ?? null,
    harness: optionalId(sel.harness, "harness"),
    differencesFor: sel.differencesFor === undefined || sel.differencesFor === null ? null : idList(sel.differencesFor, "harness comparisons"),
    features: idList(sel.features, "topics"),
    excluded: idList(sel.excluded, "left-out topics"),
    excludedSubtopics: idList(sel.excludedSubtopics, "left-out sub-topics", { max: MAX_SUBTOPIC_IDS }),
    moduleOrder: idList(sel.moduleOrder, "modules in the lab order"),
    targetMinutes: sel.targetMinutes ?? null,
    customTitle: optionalText(sel.customTitle, 160),
    agentName: optionalText(sel.agentName, 128),
    sharepointSiteName: optionalText(sel.sharepointSiteName, 200),
    sharepointSiteUrl: optionalText(sel.sharepointSiteUrl, 500),
    useLearnMcp: flag(sel.useLearnMcp, true),
    useLlm: flag(sel.useLlm, true),
    includeKnowledgeCheck: flag(sel.includeKnowledgeCheck, false),
    brandProfileId: optionalId(sel.brandProfileId, "brand profile"),
    brandOverrides: overrides,
  };

  const wiz = raw.wizard && typeof raw.wizard === "object" && !Array.isArray(raw.wizard) ? raw.wizard : {};
  const step = stepNumber(wiz.step, 1, "step");
  const chosen = Array.isArray(wiz.chosenSteps) ? wiz.chosenSteps : [];
  if (chosen.some((id) => !CHOSEN_STEPS.includes(id))) throw new DraftError("One of the answered steps in this draft is not valid, so it was not saved.");
  if (wiz.picked !== undefined && wiz.picked !== null && !Array.isArray(wiz.picked)) throw new DraftError("The topic picks in this draft are not a list, so it was not saved.");
  const removedRaw = wiz.removed === undefined || wiz.removed === null ? [] : wiz.removed;
  if (!Array.isArray(removedRaw)) throw new DraftError("The removed modules in this draft are not a list, so it was not saved.");
  if (removedRaw.length > MAX_IDS) throw new DraftError(`This draft has more removed modules than can be saved (${MAX_IDS} at most).`);
  const removed = removedRaw.map((entry) => {
    const id = typeof entry === "string" ? entry : entry?.id;
    if (typeof id !== "string" || !ID_TEXT.test(id)) throw new DraftError("One of the removed modules in this draft is not valid, so it was not saved.");
    return { id, wasPicked: typeof entry === "object" ? entry.wasPicked !== false : true };
  });
  const wizard = {
    step,
    furthest: Math.max(step, stepNumber(wiz.furthest, step, "furthest step")),
    chosenSteps: CHOSEN_STEPS.filter((id) => chosen.includes(id)),
    picked: wiz.picked === undefined || wiz.picked === null ? null : idList(wiz.picked, "topic picks"),
    removed,
  };

  const labels = {};
  if (raw.labels && typeof raw.labels === "object" && !Array.isArray(raw.labels)) {
    const entries = Object.entries(raw.labels);
    if (entries.length > MAX_LABELS) throw new DraftError("This draft names more items than can be saved. Remove some topics and try again.");
    for (const [id, name] of entries) {
      const text = typeof name === "string" ? cleanLine(name, MAX_LABEL_LENGTH) : "";
      if (ID_TEXT.test(id) && text) labels[id] = text;
    }
  }

  const content = { selections, wizard, labels };
  if (Buffer.byteLength(JSON.stringify(content)) > MAX_DRAFT_BYTES) {
    throw new DraftError(`This draft is too large to save (the limit is ${MAX_DRAFT_BYTES / 1024} KB). Leave out some topics or sub-topics and try again.`, 413, "too-large");
  }
  return content;
}

function summarize(record) {
  const sel = record.content?.selections || {};
  return {
    id: record.id,
    name: record.name,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    builtAt: record.builtAt || null,
    builtLabId: record.builtLabId || null,
    products: sel.products || [],
    industry: sel.industry || null,
    level: sel.level ?? null,
    harness: sel.harness || null,
    step: record.content?.wizard?.step || 1,
    topicCount: (sel.features || []).length,
  };
}

/** Upgrade a parsed file to the current version, or say why it cannot be opened here. */
export function migrateDraftRecord(record, { currentVersion = DRAFT_SCHEMA_VERSION, migrations = MIGRATIONS } = {}) {
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new DraftError("This draft file could not be read.", 422, "unreadable");
  let version = record.schemaVersion;
  if (!Number.isInteger(version) || version < 0) throw new DraftError("This draft file could not be read.", 422, "unreadable");
  if (version > currentVersion) {
    throw new DraftError("This draft was saved by a newer version of the portal, so it cannot be opened here. The draft has not been changed.", 409, "newer-version");
  }
  let next = record;
  while (version < currentVersion) {
    const step = migrations[version];
    if (typeof step !== "function") throw new DraftError("This draft was saved by an older version that can no longer be opened. The draft has not been changed.", 409, "older-version");
    next = step(next);
    version += 1;
    next = { ...next, schemaVersion: version };
  }
  return next;
}

function validRecord(record, id) {
  if (!record || typeof record !== "object" || record.id !== id) throw new DraftError("This draft file could not be read.", 422, "unreadable");
  if (id !== UNSAVED_ID) {
    if (typeof record.name !== "string" || !record.name.trim()) throw new DraftError("This draft file could not be read.", 422, "unreadable");
    if (typeof record.createdAt !== "string" || typeof record.updatedAt !== "string") throw new DraftError("This draft file could not be read.", 422, "unreadable");
  }
  try {
    return { ...record, content: normalizeDraftContent(record.content) };
  } catch (err) {
    if (err instanceof DraftError) throw new DraftError("This draft file could not be read.", 422, "unreadable");
    throw err;
  }
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Write to a temp file, then rename it over the target, so a reader never sees half a file. */
function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // ".blob-tmp-" is the name the Blob mirror already skips, so a half-written copy is never uploaded.
  const temp = `${file}.blob-tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    fs.writeFileSync(temp, text, { flag: "wx" });
    for (let attempt = 0; ; attempt += 1) {
      try {
        fs.renameSync(temp, file);
        return;
      } catch (err) {
        // Windows can briefly refuse a rename while an antivirus scanner or the Blob mirror holds the target.
        if (attempt >= 4 || !["EPERM", "EBUSY", "EACCES"].includes(err?.code)) throw err;
        sleepMs(15 * (attempt + 1));
      }
    }
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
}

/**
 * @param {object} options
 * @param {string} options.dir the drafts folder (see draftsDirFor)
 * @param {() => number} [options.now] clock, injectable for tests
 * @param {{currentVersion?: number, migrations?: object}} [options.schema] injectable for migration tests
 */
export function createDraftStore({ dir, now = Date.now, schema = {} } = {}) {
  if (!dir) throw new Error("createDraftStore needs a folder.");
  const root = path.resolve(dir);
  const version = schema.currentVersion ?? DRAFT_SCHEMA_VERSION;
  const iso = () => new Date(now()).toISOString();

  const ownerDir = (owner) => {
    if (typeof owner !== "string" || !/^(local|u-[0-9a-f]{32})$/.test(owner)) throw new DraftError("Sign in to use saved drafts.", 401, "no-owner");
    return path.join(root, owner);
  };
  const fileOf = (owner, id) => path.join(ownerDir(owner), `${id}.json`);
  const checkId = (id) => {
    if (!isDraftId(id)) throw new DraftError("That is not a draft id.", 400, "bad-id");
  };

  function readRecord(file, id) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (err) {
      if (err?.code === "ENOENT") throw new DraftError("That draft was not found. It may have been deleted.", 404, "not-found");
      throw new DraftError("This draft file could not be read.", 422, "unreadable");
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new DraftError("This draft file could not be read.", 422, "unreadable");
    }
    return validRecord(migrateDraftRecord(parsed, schema), id);
  }

  function draftFiles(owner) {
    let names;
    try {
      names = fs.readdirSync(ownerDir(owner));
    } catch (err) {
      if (err?.code === "ENOENT") return [];
      throw err;
    }
    return names.filter((name) => name.endsWith(".json") && isDraftId(name.slice(0, -5))).map((name) => name.slice(0, -5));
  }

  function write(owner, record) {
    writeFileAtomic(fileOf(owner, record.id), `${JSON.stringify(record)}\n`);
    return record;
  }

  function assertRoom(owner) {
    if (draftFiles(owner).length >= MAX_DRAFTS) {
      throw new DraftError(`You already have ${MAX_DRAFTS} saved drafts. Delete one you no longer need, then save again.`, 409, "limit");
    }
  }

  return {
    /** Every draft, newest first. A file that cannot be read is listed as unavailable; the other drafts are not affected. */
    list(owner) {
      const drafts = [];
      for (const id of draftFiles(owner)) {
        try {
          drafts.push(summarize(readRecord(fileOf(owner, id), id)));
        } catch (err) {
          if (!(err instanceof DraftError) || err.code === "not-found") continue;
          let updatedAt = null;
          try {
            updatedAt = fs.statSync(fileOf(owner, id)).mtime.toISOString();
          } catch {
            /* a file removed during the scan is simply not listed */
          }
          drafts.push({ id, name: null, unavailable: true, reason: err.code, message: err.message, updatedAt });
        }
      }
      drafts.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
      return { drafts, limit: MAX_DRAFTS };
    },

    get(owner, id) {
      checkId(id);
      return readRecord(fileOf(owner, id), id);
    },

    create(owner, { name, content } = {}) {
      const clean = normalizeDraftContent(content);
      const draftName = name === undefined || name === null ? `Draft ${iso().slice(0, 10)}` : cleanDraftName(name);
      assertRoom(owner);
      const stamp = iso();
      return write(owner, { schemaVersion: version, id: newDraftId(), name: draftName, createdAt: stamp, updatedAt: stamp, builtAt: null, builtLabId: null, content: clean });
    },

    /** Rename, replace the content, or both. The last save wins; the response says when it happened. */
    update(owner, id, { name, content } = {}) {
      checkId(id);
      if (name === undefined && content === undefined) throw new DraftError("There is nothing to change.");
      const record = readRecord(fileOf(owner, id), id);
      const next = { ...record, schemaVersion: version };
      if (name !== undefined) next.name = cleanDraftName(name);
      if (content !== undefined) next.content = normalizeDraftContent(content);
      next.updatedAt = iso();
      return write(owner, next);
    },

    duplicate(owner, id) {
      checkId(id);
      const record = readRecord(fileOf(owner, id), id);
      assertRoom(owner);
      const stamp = iso();
      const copyName = `Copy of ${record.name}`.slice(0, MAX_NAME_LENGTH).trim();
      return write(owner, { schemaVersion: version, id: newDraftId(), name: copyName, createdAt: stamp, updatedAt: stamp, builtAt: null, builtLabId: null, content: record.content });
    },

    /** Delete works even on a file that cannot be read, so a damaged draft can always be cleared. */
    remove(owner, id) {
      checkId(id);
      try {
        fs.unlinkSync(fileOf(owner, id));
      } catch (err) {
        if (err?.code === "ENOENT") throw new DraftError("That draft was already deleted.", 404, "not-found");
        throw err;
      }
      return { id };
    },

    /** Mark a draft as built into a lab. The draft stays; the page shows it as Built with a link to the lab. */
    markBuilt(owner, id, labId) {
      checkId(id);
      if (typeof labId !== "string" || !LAB_ID.test(labId)) throw new DraftError("That is not a lab id.");
      const record = readRecord(fileOf(owner, id), id);
      return write(owner, { ...record, schemaVersion: version, builtAt: iso(), builtLabId: labId });
    },

    /** The autosave slot, or null when there is none or it cannot be read. */
    getUnsaved(owner) {
      try {
        return readRecord(fileOf(owner, UNSAVED_ID), UNSAVED_ID);
      } catch (err) {
        if (err instanceof DraftError) return null;
        throw err;
      }
    },

    saveUnsaved(owner, { content, basedOn } = {}) {
      const clean = normalizeDraftContent(content);
      if (basedOn !== undefined && basedOn !== null && !isDraftId(basedOn)) throw new DraftError("That is not a draft id.", 400, "bad-id");
      const stamp = iso();
      return write(owner, { schemaVersion: version, id: UNSAVED_ID, name: null, createdAt: stamp, updatedAt: stamp, basedOn: basedOn || null, content: clean });
    },

    clearUnsaved(owner) {
      fs.rmSync(fileOf(owner, UNSAVED_ID), { force: true });
    },
  };
}

export { summarize as summarizeDraft };
