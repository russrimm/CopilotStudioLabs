/**
 * The curated teaching content behind the pre-lab training decks, loaded from `training/*.json`:
 *
 *   terms*.json     the plain-language glossary (one entry per term, defined once)
 *   concepts*.json  one brief per catalog concept: what it is, the building blocks, how it works at runtime,
 *                   an example, when to use it and when not to, what happens to data, three beginner questions
 *   products.json   one foundations brief per product
 *
 * Every statement follows Microsoft Learn (each brief lists the pages it was checked against). The loader
 * merges the part files, refuses duplicate ids, and `checkTrainingLibrary` validates the whole library so a
 * bad edit fails a test instead of reaching a customer.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fleschKincaid, unexpandedAcronyms } from "./training-text.js";
import { findLabStepLeaks } from "./training-guard.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const TRAINING_LIBRARY_DIR = path.join(__dirname, "training");

/** Highest grade a single curated text may reach before the library check complains. */
export const MAX_TEXT_GRADE = 11;

let cached = null;

/** Single common words that are still jargon in a lab, so a deck tracks them even when no brief lists them. */
const AUTO_SINGLE_WORDS = new Set(["agent", "connector", "harness", "grounding"]);

/**
 * Whether a deck must define a term the first time its words appear on a slide, even if no brief lists it.
 * Distinctive terms (a name, an acronym, or two or more words) are tracked everywhere. A common single
 * word such as "tool" or "topic" is tracked only where a brief lists it, so ordinary uses of the word do not
 * trigger a definition. An entry may say `"detect": "auto"` or `"detect": "listed"` to decide for itself.
 */
export function isAutoDetected(id, entry) {
  if (entry?.detect === "auto") return true;
  if (entry?.detect === "listed") return false;
  const term = String(entry?.term || "");
  if (/[A-Z0-9]/.test(term) || /\s/.test(term)) return true;
  return AUTO_SINGLE_WORDS.has(id);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Load and merge every part file. The result is cached; `resetTrainingLibraryCache` clears it for tests. */
export function loadTrainingLibrary({ dir = TRAINING_LIBRARY_DIR, fresh = false } = {}) {
  if (cached && !fresh && dir === TRAINING_LIBRARY_DIR) return cached;
  const library = { terms: {}, concepts: {}, products: {}, featureOverrides: {}, duplicates: [], files: [] };
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith(".json")).sort() : [];
  for (const name of files) {
    const data = readJson(path.join(dir, name));
    library.files.push(name);
    const merge = (target, source, kind) => {
      for (const [id, value] of Object.entries(source || {})) {
        if (Object.hasOwn(library[target], id)) library.duplicates.push(`${kind} "${id}" is defined twice (${name})`);
        else library[target][id] = value;
      }
    };
    merge("terms", data.terms, "term");
    merge("concepts", data.concepts, "concept");
    merge("products", data.products, "product");
    merge("featureOverrides", data.featureOverrides, "feature override");
  }
  library.termMatchers = compileTermMatchers(library.terms);
  if (dir === TRAINING_LIBRARY_DIR) cached = library;
  return library;
}

export function resetTrainingLibraryCache() {
  cached = null;
}

/** Regular expressions for every term, longest pattern first so "generative orchestration" wins over "orchestration". */
export function compileTermMatchers(terms) {
  const list = [];
  for (const [id, entry] of Object.entries(terms || {})) {
    const patterns = Array.isArray(entry.match) && entry.match.length ? entry.match : [escapeRegex(entry.term)];
    const auto = isAutoDetected(id, entry);
    for (const pattern of patterns) {
      const sensitive = /^[A-Z0-9]{2,}$/.test(pattern) || /^[A-Z][A-Za-z0-9]*(?: [A-Za-z0-9]+)*$/.test(pattern) && /[A-Z]/.test(pattern.slice(1));
      list.push({ id, pattern, auto, length: pattern.length, regex: new RegExp(`(?<![\\w-])(?:${pattern})(?![\\w-])`, sensitive ? "g" : "gi") });
    }
  }
  return list.sort((a, b) => b.length - a.length);
}

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Every glossary term that appears in `text`, in order of first appearance: `[{id, index, text}]`.
 * A distinctive term is always found; a common single word (such as "tool") is found only when its id is in `listed`.
 */
export function findTermsInText(text, library = loadTrainingLibrary(), { listed = new Set() } = {}) {
  const taken = [];
  const hits = [];
  const source = String(text || "");
  for (const matcher of library.termMatchers) {
    if (!matcher.auto && !listed.has(matcher.id)) continue;
    matcher.regex.lastIndex = 0;
    for (const m of source.matchAll(matcher.regex)) {
      const start = m.index;
      const end = start + m[0].length;
      if (taken.some(([s, e]) => start < e && end > s)) continue;
      taken.push([start, end]);
      hits.push({ id: matcher.id, index: start, text: m[0] });
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}

const LEARN_URL = /^https:\/\/learn\.microsoft\.com\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/;
const GUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

function textsOfConcept(brief) {
  const out = [];
  const push = (label, text) => {
    if (typeof text === "string" && text.trim()) out.push({ label, text });
  };
  push("definition", brief.definition);
  push("analogy", brief.analogy);
  for (const [i, b] of (brief.blocks || []).entries()) push(`blocks[${i}]`, b.plain);
  for (const [i, s] of (brief.flow || []).entries()) push(`flow[${i}]`, s.plain);
  push("example.input", brief.example?.input);
  push("example.output", brief.example?.output);
  for (const [i, t] of (brief.whenToUse || []).entries()) push(`whenToUse[${i}]`, t);
  for (const [i, t] of (brief.whenNot || []).entries()) push(`whenNot[${i}]`, t);
  push("dataNote", brief.dataNote);
  push("needToKnow", brief.needToKnow);
  push("demo", brief.demo);
  push("askTheRoom", brief.askTheRoom);
  push("sayOutLoud", brief.sayOutLoud);
  for (const [i, q] of (brief.quiz || []).entries()) {
    push(`quiz[${i}].q`, q.q);
    for (const [j, o] of (q.options || []).entries()) push(`quiz[${i}].options[${j}]`, o);
    push(`quiz[${i}].why`, q.why);
  }
  return out;
}

/**
 * Validate the library. Returns a list of problem strings (empty when it is sound).
 * `conceptIds` and `productIds` are the catalog's, so a missing brief is reported.
 */
export function checkTrainingLibrary(library = loadTrainingLibrary(), { conceptIds = [], productIds = [], requireAll = true } = {}) {
  const problems = [...library.duplicates];
  const termIds = new Set(Object.keys(library.terms));

  for (const [id, term] of Object.entries(library.terms)) {
    if (!term.term || !term.plain) problems.push(`term "${id}" needs "term" and "plain"`);
    else if (term.plain.split(/\s+/).length > 26) problems.push(`term "${id}" is longer than 26 words`);
    if (term.plain && fleschKincaid(term.plain).grade > 13) problems.push(`term "${id}" reads above grade 13`);
  }

  if (requireAll) {
    for (const id of conceptIds) if (!library.concepts[id]) problems.push(`concept "${id}" has no brief`);
    for (const id of productIds) if (!library.products[id]) problems.push(`product "${id}" has no foundations brief`);
  }

  for (const [id, brief] of Object.entries(library.concepts)) {
    const where = `concept "${id}"`;
    if (!brief || typeof brief !== "object") {
      problems.push(`${where} is not a brief`);
      continue;
    }
    if (!brief.definition) problems.push(`${where} needs a definition`);
    const blocks = brief.blocks || [];
    const flow = brief.flow || [];
    if (blocks.length < 3 || blocks.length > 5) problems.push(`${where} needs 3 to 5 building blocks (has ${blocks.length})`);
    if (flow.length < 4 || flow.length > 6) problems.push(`${where} needs 4 to 6 flow steps (has ${flow.length})`);
    for (const [i, b] of blocks.entries()) {
      if (!b.label || !b.plain) problems.push(`${where} blocks[${i}] needs label and plain`);
      else if (b.label.split(/\s+/).length > 3) problems.push(`${where} blocks[${i}] label is longer than 3 words`);
    }
    for (const [i, s] of flow.entries()) {
      if (!s.label || !s.plain) problems.push(`${where} flow[${i}] needs label and plain`);
      else if (s.label.split(/\s+/).length > 3) problems.push(`${where} flow[${i}] label is longer than 3 words`);
    }
    if (!brief.example?.input || !brief.example?.output) problems.push(`${where} needs an example with input and output`);
    if ((brief.whenToUse || []).length < 2) problems.push(`${where} needs at least 2 whenToUse items`);
    if ((brief.whenNot || []).length < 2) problems.push(`${where} needs at least 2 whenNot items`);
    if (!brief.needToKnow) problems.push(`${where} needs a needToKnow summary`);
    for (const field of ["demo", "askTheRoom", "sayOutLoud"]) if (!brief[field]) problems.push(`${where} needs ${field}`);
    const quiz = brief.quiz || [];
    if (quiz.length < 3 || quiz.length > 4) problems.push(`${where} needs 3 or 4 quiz questions (has ${quiz.length})`);
    for (const [i, q] of quiz.entries()) {
      if (!q.q || !Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4 || !Number.isInteger(q.answer) || q.answer < 0 || q.answer >= (q.options || []).length || !q.why) {
        problems.push(`${where} quiz[${i}] needs q, 2 to 4 options, a valid answer index, and why`);
      }
    }
    if (!(brief.learn || []).length) problems.push(`${where} needs at least one Learn link`);
    for (const link of brief.learn || []) {
      if (!link.title || !LEARN_URL.test(link.url || "")) problems.push(`${where} has a bad Learn link: ${link.url}`);
    }
    if (!(brief.verifiedAgainst || []).length) problems.push(`${where} must list verifiedAgainst pages`);
    for (const url of brief.verifiedAgainst || []) if (!LEARN_URL.test(url)) problems.push(`${where} verifiedAgainst has a bad URL: ${url}`);
    for (const termId of brief.terms || []) if (!termIds.has(termId)) problems.push(`${where} uses unknown term "${termId}"`);

    const texts = textsOfConcept(brief);
    for (const { label, text } of texts) {
      if (GUID.test(text)) problems.push(`${where} ${label} contains a GUID`);
      if (/[\u2013\u2014]/.test(text) && label !== "definition") {
        /* dashes are fine in prose */
      }
      const leaks = findLabStepLeaks(text);
      if (leaks.length) problems.push(`${where} ${label} reads like a lab step or setting (${leaks[0]})`);
      if (!label.startsWith("quiz") && fleschKincaid(text).grade > MAX_TEXT_GRADE && text.split(/\s+/).length > 8) {
        problems.push(`${where} ${label} reads above grade ${MAX_TEXT_GRADE}: "${text.slice(0, 70)}"`);
      }
    }
    const bad = unexpandedAcronyms(texts.map((t) => t.text), { extraOk: [] });
    if (bad.length) problems.push(`${where} uses acronyms without expanding them: ${bad.join(", ")}`);
  }

  for (const [id, override] of Object.entries(library.featureOverrides)) {
    const where = `feature override "${id}"`;
    if (!override || typeof override !== "object") {
      problems.push(`${where} is not an override`);
      continue;
    }
    if (override.blocks && (override.blocks.length < 3 || override.blocks.length > 5)) problems.push(`${where} needs 3 to 5 building blocks`);
    if (override.flow && (override.flow.length < 4 || override.flow.length > 6)) problems.push(`${where} needs 4 to 6 flow steps`);
    for (const key of ["blocks", "flow"]) {
      for (const [i, item] of (override[key] || []).entries()) {
        if (!item.label || !item.plain) problems.push(`${where} ${key}[${i}] needs label and plain`);
        else if (item.label.split(/\s+/).length > 3) problems.push(`${where} ${key}[${i}] label is longer than 3 words`);
      }
    }
    if (override.example && (!override.example.input || !override.example.output)) problems.push(`${where} example needs input and output`);
    if (override.quiz && (override.quiz.length < 3 || override.quiz.length > 4)) problems.push(`${where} needs 3 or 4 quiz questions`);
    for (const [i, q] of (override.quiz || []).entries()) {
      if (!q.q || !Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4 || !Number.isInteger(q.answer) || q.answer < 0 || q.answer >= q.options.length || !q.why) {
        problems.push(`${where} quiz[${i}] needs q, 2 to 4 options, a valid answer index, and why`);
      }
    }
    for (const link of override.learn || []) if (!link.title || !LEARN_URL.test(link.url || "")) problems.push(`${where} has a bad Learn link: ${link.url}`);
    for (const url of override.verifiedAgainst || []) if (!LEARN_URL.test(url)) problems.push(`${where} verifiedAgainst has a bad URL: ${url}`);
    for (const termId of override.terms || []) if (!termIds.has(termId)) problems.push(`${where} uses unknown term "${termId}"`);
    const texts = textsOfConcept(override);
    for (const { label, text } of texts) {
      if (GUID.test(text)) problems.push(`${where} ${label} contains a GUID`);
      const leaks = findLabStepLeaks(text);
      if (leaks.length) problems.push(`${where} ${label} reads like a lab step or setting (${leaks[0]})`);
      if (!label.startsWith("quiz") && fleschKincaid(text).grade > MAX_TEXT_GRADE && text.split(/\s+/).length > 8) {
        problems.push(`${where} ${label} reads above grade ${MAX_TEXT_GRADE}: "${text.slice(0, 70)}"`);
      }
    }
    const bad = unexpandedAcronyms(texts.map((t) => t.text));
    if (bad.length) problems.push(`${where} uses acronyms without expanding them: ${bad.join(", ")}`);
  }

  for (const [id, brief] of Object.entries(library.products)) {
    const where = `product "${id}"`;
    if (!brief || typeof brief !== "object") {
      problems.push(`${where} is not a brief`);
      continue;
    }
    for (const field of ["whatItIs", "whoUses", "whereYouWork"]) if (!brief[field]) problems.push(`${where} needs ${field}`);
    const blocks = brief.blocks || [];
    if (blocks.length < 3 || blocks.length > 6) problems.push(`${where} needs 3 to 6 building blocks (has ${blocks.length})`);
    if (!(brief.learn || []).length) problems.push(`${where} needs at least one Learn link`);
    for (const link of brief.learn || []) if (!link.title || !LEARN_URL.test(link.url || "")) problems.push(`${where} has a bad Learn link: ${link.url}`);
    if (!(brief.verifiedAgainst || []).length) problems.push(`${where} must list verifiedAgainst pages`);
    for (const termId of brief.vocabulary || []) if (!termIds.has(termId)) problems.push(`${where} uses unknown term "${termId}"`);
    const flat = [brief.whatItIs, brief.whoUses, brief.whereYouWork, brief.fit?.center?.plain, ...(brief.blocks || []).map((b) => b.plain), ...(brief.fit?.around || []).map((b) => b.plain)].filter(Boolean);
    for (const text of flat) {
      if (GUID.test(text)) problems.push(`${where} contains a GUID`);
      const leaks = findLabStepLeaks(text);
      if (leaks.length) problems.push(`${where} reads like a lab step or setting (${leaks[0]})`);
    }
  }
  return problems;
}
