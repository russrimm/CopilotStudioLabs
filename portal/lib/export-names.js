/**
 * Short, readable names for everything the portal exports, and the one path budget every ZIP is held to.
 *
 * WHY A BUDGET
 *   Windows Explorer ("Extract All") and many tools refuse a path longer than 260 characters (MAX_PATH, which counts
 *   the terminating NUL, so 259 usable). The full path of an extracted file is
 *
 *       <where the person saves it> \ <folder named after the ZIP> \ <the entry path inside the ZIP>
 *
 *   and the portal controls only the last two parts. The numbers below were chosen so that extraction works from
 *   any folder up to 110 characters deep (a typical Downloads folder is 30 to 60, a OneDrive or company-redirected one
 *   can reach 100):
 *
 *       110 (folder the person extracts into)
 *     +   1 (separator)
 *     +  46 (ZIP file name, at most 50 including ".zip", minus the ".zip" Explorer drops from its folder name)
 *     +   1 (separator)
 *     + 100 (the longest entry path inside the ZIP, counting the root folder and every separator)
 *     = 258, one under the 259 limit.
 *
 *   Entry paths are held to 100 (hard) with 90 as the length most entries stay under; the ZIP file name to 50;
 *   a downloaded single file name to 120 (so saving into a deep folder also works).
 *
 * HOW NAMES ARE SHORTENED (readable, never blind truncation)
 *   - Lab folder: the first meaningful words of the title ("Retail Store Support Assistant"), at most 30 characters.
 *   - Module folder: "NN <short title>", or "NN Recap - <short title>" for a prerequisite recap. NN is the module's
 *     position in the teaching order, so folders still list in that order.
 *   - Module documents: "NN <short title> - <Kind>.<ext>" with a short fixed vocabulary (Handout, Slides, PDF, Web page,
 *     Notes). The title is kept whole when the budget allows and dropped ("NN - Handout.docx") when it does not: the
 *     folder name and the document's own cover already carry it.
 *   - Everything else uses fixed short names ("Administrator setup guide.docx", "Training 03 <short title>.pptx").
 *   - Every document keeps its full title inside, and the README.md and export-manifest.json in each ZIP map every
 *     short path to the full title, kind, format, module order, and minutes.
 *
 * A name is cut at a word boundary, never on a dangling "with" or "and". If a path still goes over the hard limit (a
 * very long picture name, say) the guard shortens it further and ends it with a 4 character hash so names stay
 * unique, and records a warning in export-manifest.json. In tests (`NODE_TEST_CONTEXT`) the guard throws instead, so a
 * naming mistake is found by the suite and not by a customer.
 *
 * Overrides (all optional; values are clamped to a safe range): PORTAL_EXPORT_MAX_ENTRY_PATH (default 100),
 * PORTAL_EXPORT_TARGET_ENTRY_PATH (90), PORTAL_EXPORT_MAX_ZIP_NAME (50), PORTAL_EXPORT_MAX_DOWNLOAD_NAME (120),
 * PORTAL_EXPORT_LAB_FOLDER_CHARS (30), PORTAL_EXPORT_MODULE_TITLE_CHARS (32), PORTAL_EXPORT_STRICT_BUDGET (on|off).
 *
 * Pure and dependency-free (Node built-ins only), so a worker thread, a command-line tool, and a test can all use it.
 */

import { createHash } from "node:crypto";

/** The one-line fix for a ZIP that was already downloaded with long paths (README.md in every ZIP, and the docs). */
export const EXTRACT_ON_WINDOWS_TIP = "If Windows says a path name is too long, extract this ZIP into a short folder such as `C:\\Labs`, use 7-Zip, or turn on Windows long paths.";

/** Windows MAX_PATH: the limit Explorer and many tools enforce on the full path. It counts the terminating NUL. */
export const WINDOWS_MAX_PATH = 260;
/** The depth of folder we promise to extract into: C:\Users\<name>\OneDrive - <Company>\Documents\Training\... */
export const ASSUMED_EXTRACT_PREFIX = 110;
export const DEFAULT_MAX_ENTRY_PATH = 100;
export const DEFAULT_TARGET_ENTRY_PATH = 90;
export const DEFAULT_MAX_ZIP_NAME = 50;
export const DEFAULT_MAX_DOWNLOAD_NAME = 120;
export const DEFAULT_LAB_FOLDER_CHARS = 30;
export const DEFAULT_MODULE_TITLE_CHARS = 32;

const ENV_NAMES = Object.freeze({
  entryMax: "PORTAL_EXPORT_MAX_ENTRY_PATH",
  entryTarget: "PORTAL_EXPORT_TARGET_ENTRY_PATH",
  zipNameMax: "PORTAL_EXPORT_MAX_ZIP_NAME",
  downloadNameMax: "PORTAL_EXPORT_MAX_DOWNLOAD_NAME",
  labFolderChars: "PORTAL_EXPORT_LAB_FOLDER_CHARS",
  moduleTitleChars: "PORTAL_EXPORT_MODULE_TITLE_CHARS",
  strict: "PORTAL_EXPORT_STRICT_BUDGET",
});

function intFromEnv(env, name, fallback, min, max) {
  const raw = String(env?.[name] ?? "").trim();
  if (!/^\d+$/.test(raw)) return fallback;
  return Math.min(max, Math.max(min, Number.parseInt(raw, 10)));
}

/**
 * The budget in force. Read on every call so a change to the environment (a test, an operator) applies at once.
 * Values are clamped: a path under 60 characters could not hold a module folder and a file name at all.
 */
export function resolveExportBudget(env = process.env) {
  const entryMax = intFromEnv(env, ENV_NAMES.entryMax, DEFAULT_MAX_ENTRY_PATH, 60, 240);
  const entryTarget = Math.min(entryMax, intFromEnv(env, ENV_NAMES.entryTarget, DEFAULT_TARGET_ENTRY_PATH, 50, 230));
  const rawStrict = String(env?.[ENV_NAMES.strict] ?? "").trim().toLowerCase();
  const strict = rawStrict ? ["on", "1", "true", "yes"].includes(rawStrict) : Boolean(env?.NODE_TEST_CONTEXT);
  return Object.freeze({
    entryMax,
    entryTarget,
    zipNameMax: intFromEnv(env, ENV_NAMES.zipNameMax, DEFAULT_MAX_ZIP_NAME, 24, 120),
    downloadNameMax: intFromEnv(env, ENV_NAMES.downloadNameMax, DEFAULT_MAX_DOWNLOAD_NAME, 40, 200),
    labFolderChars: intFromEnv(env, ENV_NAMES.labFolderChars, DEFAULT_LAB_FOLDER_CHARS, 12, 60),
    moduleTitleChars: intFromEnv(env, ENV_NAMES.moduleTitleChars, DEFAULT_MODULE_TITLE_CHARS, 16, 60),
    strict,
  });
}

/** The extracted path of the longest possible entry from a folder `prefix` characters deep, for a ZIP named `zipName`. */
export function worstCaseExtractedPath(budget = resolveExportBudget(), { prefix = ASSUMED_EXTRACT_PREFIX } = {}) {
  return prefix + 1 + (budget.zipNameMax - ".zip".length) + 1 + budget.entryMax;
}

// ── Kinds ───────────────────────────────────────────────────────────────────

/** The short fixed vocabulary for the kind of a module document, by format. */
export const DOC_KINDS = Object.freeze({ docx: "Handout", pptx: "Slides", pdf: "PDF", html: "Web page", md: "Notes" });
/** "Web page" + ".html": the longest kind-and-extension pair, so names do not change with the formats chosen. */
const WORST_KIND_AND_EXT = "Web page.html".length;

export function docKind(format) {
  return DOC_KINDS[String(format || "").toLowerCase()] || "File";
}

// ── Text cleaning ───────────────────────────────────────────────────────────

const SPECIAL_FOLD = { ß: "ss", æ: "ae", Æ: "AE", ø: "o", Ø: "O", đ: "d", Đ: "D", ł: "l", Ł: "L", œ: "oe", Œ: "OE", þ: "th", Þ: "Th" };
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const ILLEGAL_SEGMENT_CHARS = /[<>:"\\|?*\u0000-\u001f\u007f]/;
const TRAILING_STOPWORDS = new Set(["a", "an", "the", "and", "or", "of", "for", "to", "in", "on", "at", "by", "with", "from", "as", "is", "vs", "into", "using"]);
const LAB_STOPWORDS = new Set([...TRAILING_STOPWORDS, "your", "our", "build", "building", "create", "creating"]);

/** Plain ASCII: accents fold to their base letter, typographic punctuation to its plain form, anything else is dropped. */
export function asciiFold(text) {
  return String(text ?? "")
    .replace(/[ßæÆøØđĐłŁœŒþÞ]/g, (ch) => SPECIAL_FOLD[ch] || "")
    .replace(/[\u2018\u2019\u201a\u2032]/g, "'")
    .replace(/[\u201c\u201d\u201e\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/[\u00a0\u2000-\u200b\u202f\u205f\u3000]/g, " ")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x00-\x7f]/g, "");
}

/** A human title made safe as part of a file or folder name: ASCII, no forbidden characters, no markdown marks. */
export function cleanTitle(text) {
  return asciiFold(text)
    .replace(/[*_`~]/g, "")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, " - ")
    .replace(/\s+/g, " ")
    .replace(/(?:\s*-\s*){2,}/g, " - ")
    .replace(/^[.\s-]+|[.\s-]+$/g, "");
}

/** Ends a name cleanly: no trailing dot, space, hyphen, or comma, and a Windows-reserved name gets a suffix. */
function finishSegment(text, fallback = "Item", max = Infinity) {
  let out = String(text ?? "").replace(/[.\s,;:-]+$/g, "").replace(/^[.\s]+/g, "");
  if (!out) out = fallback;
  if (WINDOWS_RESERVED.test(out.split(".")[0])) out = `${out} Lab`;
  if (out.length > max) out = out.slice(0, max).replace(/[.\s,;:-]+$/g, "");
  return out || String(fallback).slice(0, Math.max(1, max));
}

/**
 * Cut `text` to at most `max` characters at a word boundary, never leaving a dangling "with", "and", "a" or a
 * trailing punctuation mark. A single word longer than `max` is cut inside the word.
 */
export function cutAtWordBoundary(text, max, { midWord = true } = {}) {
  const source = String(text ?? "").replace(/\s+/g, " ").trim();
  const limit = Math.max(1, Math.floor(max));
  const tidy = (value) => {
    let out = value.replace(/[\s.,;:&+/-]+$/g, "");
    for (;;) {
      const match = /(?:^|\s)([A-Za-z]+)$/.exec(out);
      if (!match || !TRAILING_STOPWORDS.has(match[1].toLowerCase()) || (match.index === 0 && out.length === match[1].length)) break;
      out = out.slice(0, match.index).replace(/[\s.,;:&+/-]+$/g, "");
    }
    return out;
  };
  if (source.length <= limit) return tidy(source) || source;
  let cut;
  if (source[limit] === " ") cut = source.slice(0, limit);
  else {
    const space = source.slice(0, limit).lastIndexOf(" ");
    // With midWord off, a word is never split: what fits whole (possibly nothing) is returned.
    cut = space >= Math.min(4, limit) ? source.slice(0, space) : midWord ? source.slice(0, limit) : space > 0 ? source.slice(0, space) : "";
  }
  return tidy(cut) || (midWord ? source.slice(0, limit).replace(/[\s.,;:&+/-]+$/g, "") : "");
}

/** A short title for a folder or file name: cleaned, then cut at a word boundary. */
export function shortTitle(text, max, fallback = "Module") {
  const cleaned = cleanTitle(text) || fallback;
  return cutAtWordBoundary(cleaned, max) || cleaned.slice(0, Math.max(1, max));
}

/**
 * The lab folder name: the first meaningful words of the title, at most `max` characters and `maxWords` words.
 * "Retail: Build a Store Support Assistant with Microsoft Copilot Studio" -> "Retail Store Support Assistant".
 */
export function shortLabName(title, { max = DEFAULT_LAB_FOLDER_CHARS, maxWords = 4, fallback = "Lab" } = {}) {
  const tokens = asciiFold(title)
    .replace(/[*_`~]/g, " ")
    .split(/\s+/)
    .map((token) => token.replace(/[^A-Za-z0-9&+-]/g, "").replace(/^[-+&]+|[-+&]+$/g, ""))
    .filter(Boolean);
  const meaningful = tokens.filter((token) => !LAB_STOPWORDS.has(token.toLowerCase()));
  const words = meaningful.length ? meaningful : tokens;
  const picked = [];
  for (const word of words) {
    if (picked.length >= maxWords) break;
    if ([...picked, word].join(" ").length > max) break;
    picked.push(word);
  }
  const name = picked.join(" ") || (words[0] || "").slice(0, max);
  return finishSegment(name, fallback, max);
}

/** `name`, or `name 2`, `name 3` ... when another entry of `used` (lowercase names) already has it. Records the choice in `used`. */
export function uniqueName(name, used, { max = Infinity } = {}) {
  let candidate = name;
  for (let n = 2; used.has(candidate.toLowerCase()); n += 1) {
    const suffix = ` ${n}`;
    candidate = `${finishSegment(name, "Item", Math.max(1, max - suffix.length))}${suffix}`;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

function splitExtension(fileName) {
  const match = /^(.*?)(\.[A-Za-z0-9]{1,8})$/.exec(fileName);
  return match && match[1] ? { base: match[1], ext: match[2] } : { base: fileName, ext: "" };
}

/**
 * Fit a file name into `max` characters, keeping its extension. A name that already fits is only made safe. A longer one
 * loses filler words ("and", "the") first, then whole words from the end, then (for one very long word) letters.
 */
export function fitFileName(fileName, max) {
  const safe = asciiFold(fileName).replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "-").replace(/\s+/g, " ").trim();
  if (safe.length <= max) return safe.replace(/[. ]+$/g, "") || "file";
  const { base, ext } = splitExtension(safe);
  const room = Math.max(1, max - ext.length);
  if (base.length <= room) return `${base}${ext}`;
  const sep = base.includes(" ") ? " " : base.includes("_") && !base.includes("-") ? "_" : "-";
  let words = base.split(/[ _.-]+/).filter(Boolean);
  const lean = words.filter((word) => !TRAILING_STOPWORDS.has(word.toLowerCase()) && word.toLowerCase() !== "sample");
  if (lean.length) words = lean;
  while (words.length > 1 && words.join(sep).length > room) words = words.slice(0, -1);
  let out = words.join(sep);
  if (out.length > room) out = out.slice(0, room);
  return `${out.replace(/[. _-]+$/g, "") || "file"}${ext}`;
}

/**
 * A downloaded file name held to `max` (default 120) characters: cut at a word boundary, extension kept, safe on Windows.
 * Names that already fit come back unchanged, so nothing readable is lost.
 */
export function shortenDownloadFileName(fileName, max = resolveExportBudget().downloadNameMax) {
  const raw = String(fileName ?? "").replace(/[\r\n]+/g, " ").replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  const { base, ext } = splitExtension(raw);
  const room = Math.max(8, max - ext.length);
  if (raw.length <= max) return finishNameWithExt(base, ext, room);
  return finishNameWithExt(cutAtWordBoundary(base, room), ext, room);
}

function finishNameWithExt(base, ext, room) {
  const cleaned = base.replace(/[. ]+$/g, "").replace(/^[. ]+/g, "");
  const name = WINDOWS_RESERVED.test(cleaned) ? `${cleaned} file` : cleaned;
  return `${name.slice(0, room).replace(/[. ]+$/g, "") || "download"}${ext}`;
}

/**
 * The file name a lab ZIP downloads as: "<short lab name> - Lab package.zip", at most `max` (default 50) characters,
 * ".zip" included. A single-format ZIP says so: "<short lab name> - Lab package (docx).zip".
 */
export function zipDownloadName(title, { kind = "Lab package", variant = "", max = resolveExportBudget().zipNameMax, labChars, labName } = {}) {
  const tail = `${variant ? ` - ${kind} (${variant})` : ` - ${kind}`}.zip`;
  const room = Math.max(8, Math.min(labChars || DEFAULT_LAB_FOLDER_CHARS, max - tail.length));
  // A lab folder name that is already short is used as it is, so the ZIP and the folder inside it always match.
  const lab = labName ? cutAtWordBoundary(labName, room) || shortLabName(title, { max: room }) : shortLabName(title, { max: room });
  return `${lab}${tail}`;
}

// ── Plans for a lab ZIP ─────────────────────────────────────────────────────

function pad(order) {
  return String(Math.max(0, Number(order) || 0)).padStart(2, "0");
}

/**
 * The folder of one module: "NN <short title>" or "NN Recap - <short title>". `titleChars` is the cap for a step's title
 * (a recap's is four less to make room for the label).
 */
export function moduleFolderName({ order, title, isRecap = false }, { titleChars = DEFAULT_MODULE_TITLE_CHARS } = {}) {
  const label = isRecap ? "Recap - " : "";
  const cap = isRecap ? Math.max(12, titleChars - 4) : titleChars;
  const text = shortTitle(title, cap, isRecap ? "Recap" : "Module");
  return `${pad(order)} ${label}${text}`;
}

/** The name of a training deck inside the training folder, from the same short title the module folder uses. */
export function trainingDeckFileName(deck, { titleChars = DEFAULT_MODULE_TITLE_CHARS } = {}) {
  if (deck.kind === "complete") return "Training - complete.pptx";
  if (deck.kind === "foundations") {
    const product = cutAtWordBoundary(cleanTitle(deck.productShort || deck.title || "Product"), 24) || "Product";
    return `Training 00 Foundations ${product}.pptx`;
  }
  const isRecap = Boolean(deck.isRecap) || /^recap\b/i.test(String(deck.stepLabel || ""));
  return `Training ${moduleFolderName({ order: deck.order, title: deck.title, isRecap }, { titleChars })}.pptx`;
}

/**
 * Names for every module of a lab ZIP. `modules` is `[{order, title, isRecap}]` in teaching order and `labFolder` the
 * lab folder's name. Returns, per module, its folder, a function that names a document of a given format, and the
 * longest sample file name that keeps `<lab>/<folder>/sample-files/<name>` inside the budget.
 *
 * The document file name repeats the short title when the whole title fits the target (90) with the longest kind
 * ("Web page.html"). Otherwise it keeps the first words that fit at a word boundary (two or more words, at least 8
 * characters), and otherwise leaves the title out ("NN - Handout.docx"): the folder name and the document's own cover
 * already carry it. The same names come back whatever formats were asked for. Sample files are fitted to the hard limit.
 */
export function planModuleNames(modules, { labFolder, budget = resolveExportBudget() } = {}) {
  const used = new Set();
  const out = new Map();
  for (const mod of modules) {
    const folder = uniqueName(moduleFolderName(mod, { titleChars: budget.moduleTitleChars }), used, { max: 60 });
    const nn = pad(mod.order);
    const titleText = folder.slice(nn.length + 1).replace(/^Recap - /, "");
    const room = budget.entryTarget - labFolder.length - 1 - folder.length - 1 - (nn.length + 1 + 3 + WORST_KIND_AND_EXT);
    let fileTitle = titleText;
    if (fileTitle.length > room) {
      fileTitle = room >= 8 ? cutAtWordBoundary(titleText, room, { midWord: false }) : "";
      if (fileTitle.length < 8 || !/\s/.test(fileTitle)) fileTitle = "";
    }
    const sampleNameMax = Math.max(14, budget.entryMax - labFolder.length - 1 - folder.length - 1 - "sample-files/".length);
    out.set(Number(mod.order), {
      order: Number(mod.order),
      folder,
      fileTitle,
      sampleNameMax,
      docName(format) {
        const kind = docKind(format);
        const ext = String(format).toLowerCase();
        return fileTitle ? `${nn} ${fileTitle} - ${kind}.${ext}` : `${nn} - ${kind}.${ext}`;
      },
    });
  }
  return out;
}

/**
 * The lab folder name for a ZIP. `longestFixedRelPath` is the length of the longest path inside the lab folder that cannot be
 * renamed (pictures, the saved guide), so those always fit; the name is as short as that needs, never under 12.
 */
export function planLabFolder(title, { labId = "", used = new Set(), longestFixedRelPath = 0, budget = resolveExportBudget() } = {}) {
  const room = Math.min(budget.labFolderChars, budget.entryMax - 1 - longestFixedRelPath);
  const max = Math.max(12, room);
  const source = String(title || "").trim() || String(labId || "").replace(/[-_]+/g, " ");
  return uniqueName(shortLabName(source, { max, fallback: "Lab" }), used, { max });
}

// ── The path guard ──────────────────────────────────────────────────────────

/** Thrown in tests (and when a budget cannot be met at all). It is an internal error: the naming code left a path over budget. */
export class ExportBudgetError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ExportBudgetError";
    this.code = "EXPORT_PATH_BUDGET";
    this.status = 500;
    this.details = details;
  }
}

function hash4(text) {
  return createHash("sha1").update(String(text)).digest("hex").slice(0, 4);
}

function normalizeEntryPath(raw) {
  const parts = String(raw ?? "").replace(/\\/g, "/").split("/").filter((part) => part && part !== ".");
  if (parts.some((part) => part === "..")) throw new ExportBudgetError(`Unsafe ZIP entry path: ${raw}`, { path: raw });
  return parts;
}

function sanitizeSegment(segment) {
  let out = segment.replace(/[<>:"\\|?*\u0000-\u001f\u007f]/g, "_").replace(/[. ]+$/g, "");
  if (WINDOWS_RESERVED.test(out.split(".")[0])) out = `_${out}`;
  return out || "_";
}

/**
 * Holds every entry of one ZIP to the budget. `claim(path)` returns the path to write: the same path when it is clean, in
 * budget, and new; otherwise (outside strict mode) a shortened or de-duplicated one, with a warning recorded.
 * In strict mode any problem throws an ExportBudgetError that names the path.
 */
export function createZipPathGuard({ budget = resolveExportBudget(), maxPath, strict } = {}) {
  const limit = maxPath || budget.entryMax;
  const isStrict = strict === undefined ? budget.strict : Boolean(strict);
  const used = new Set();
  const dirMap = new Map();
  const warnings = [];
  let longest = 0;
  let count = 0;

  const warn = (code, original, shortened) => warnings.push({ code, original, shortened, length: shortened.length, limit });

  function shortenDirectories(parts, minKeep, rawParts) {
    return parts.map((part, index) => {
      if (index >= parts.length - 1 || part.length <= minKeep + 5) return part;
      const key = rawParts.slice(0, index + 1).join("/");
      if (!dirMap.has(key)) dirMap.set(key, `${part.slice(0, minKeep).replace(/[. ]+$/g, "")}~${hash4(key)}`);
      return dirMap.get(key);
    });
  }

  function shortenFile(parts, over, suffix) {
    const file = parts[parts.length - 1];
    const { base, ext } = splitExtension(file);
    const keep = Math.max(4, base.length - over - suffix.length - 1);
    return [...parts.slice(0, -1), `${base.slice(0, keep).replace(/[. ]+$/g, "") || "f"}~${suffix}${ext}`];
  }

  function claim(raw) {
    const original = normalizeEntryPath(raw).join("/");
    let parts = normalizeEntryPath(raw);
    if (!parts.length) throw new ExportBudgetError("An empty ZIP entry path.", { path: raw });

    if (parts.some((part) => ILLEGAL_SEGMENT_CHARS.test(part) || /[. ]$/.test(part) || WINDOWS_RESERVED.test(part.split(".")[0]))) {
      if (isStrict) throw new ExportBudgetError(`ZIP entry path is not safe on Windows: ${original}`, { path: original });
      parts = parts.map(sanitizeSegment);
      warn("unsafe-name", original, parts.join("/"));
    }

    // A directory that was shortened for one entry is shortened the same way for every later entry, so it is never split in two.
    const rawParts = [...parts];
    parts = parts.map((part, index) => (index < parts.length - 1 ? dirMap.get(rawParts.slice(0, index + 1).join("/")) || part : part));
    let candidate = parts.join("/");
    if (candidate.length > limit) {
      if (isStrict) throw new ExportBudgetError(`ZIP entry path is ${candidate.length} characters, over the budget of ${limit}: ${candidate}`, { path: candidate, length: candidate.length, limit });
      const suffix = hash4(original);
      let shortened = null;
      for (const keepDirectory of [0, 30, 14, 6]) {
        const directories = keepDirectory ? shortenDirectories(parts, keepDirectory, rawParts) : parts;
        const over = directories.join("/").length - limit;
        const trial = over > 0 ? shortenFile(directories, over, suffix) : directories;
        if (trial.join("/").length <= limit) {
          shortened = trial;
          break;
        }
      }
      if (!shortened) throw new ExportBudgetError(`ZIP entry path cannot be shortened under ${limit} characters: ${candidate}`, { path: candidate, limit });
      parts = shortened;
      candidate = parts.join("/");
      warn("path-shortened", original, candidate);
    }

    if (used.has(candidate.toLowerCase())) {
      if (isStrict) throw new ExportBudgetError(`Two ZIP entries have the same path (ignoring case): ${candidate}`, { path: candidate });
      const { base, ext } = splitExtension(parts[parts.length - 1]);
      const tag = hash4(`${original}#${used.size}`);
      parts = [...parts.slice(0, -1), `${base.slice(0, Math.max(4, base.length - 5))}~${tag}${ext}`];
      candidate = parts.join("/");
      warn("name-collision", original, candidate);
    }

    used.add(candidate.toLowerCase());
    count += 1;
    longest = Math.max(longest, candidate.length);
    return candidate;
  }

  return { claim, warnings, strict: isStrict, limit, get longest() { return longest; }, get count() { return count; } };
}

/**
 * Check a list of ZIP entry paths against the budget and the Windows rules without changing anything. Returns the
 * problems found (an empty list means the ZIP is clean). Used by tests and by tools that audit an existing ZIP.
 */
export function auditEntryPaths(paths, { budget = resolveExportBudget() } = {}) {
  const problems = [];
  const seen = new Set();
  for (const path of paths) {
    if (path.length > budget.entryMax) problems.push(`${path.length} characters (limit ${budget.entryMax}): ${path}`);
    const lower = path.toLowerCase();
    if (seen.has(lower)) problems.push(`duplicate when case is ignored: ${path}`);
    seen.add(lower);
    for (const segment of path.split("/")) {
      if (!segment) continue;
      if (ILLEGAL_SEGMENT_CHARS.test(segment)) problems.push(`character Windows does not allow: ${path}`);
      if (/[. ]$/.test(segment)) problems.push(`ends with a dot or a space: ${path}`);
      if (WINDOWS_RESERVED.test(segment.split(".")[0])) problems.push(`reserved Windows name: ${path}`);
    }
  }
  return problems;
}
