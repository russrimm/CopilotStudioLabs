/**
 * AI writing for the training decks, at the slide model.
 *
 * A deck spec (what buildTopicDeck, buildFoundationsDeck and buildCompleteDeck return) is plain data before any drawing.
 * This module finds the text on each slide that a model may reword, and puts accepted rewordings back. It never touches
 * drawing code, so a change to how slides look (training-pptx.js, pptx-text-fit.js) does not change what is written. The
 * text still goes through the normal deck pipeline afterwards: text-fit, the duplicate-slide guard, plain text.
 *
 * Only prose that explains an idea is reworded: the situation and "why it matters" text, definitions and analogies, "what
 * this adds", things to know first, the parts of a diagram, good fit and not a fit, and what comes next in the lab, plus
 * the lines a presenter says aloud (`SAY:` in the speaker notes). Titles, key terms, quiz questions and answers, licensing
 * and availability facts, links and sources are never sent.
 */

import { createHash } from "node:crypto";

import { knownNames } from "./names.js";

const MIN_CHARS = 12;
const SAY = /^SAY: /;

function isText(value) {
  return typeof value === "string" && value.trim().length >= MIN_CHARS;
}

/** The writable string fields of one slide, as paths into `slide.body`. */
function bodyPaths(slide) {
  const b = slide.body || {};
  const list = (name) => (Array.isArray(b[name]) ? b[name].map((_, i) => [name, i]) : []);
  switch (slide.kind) {
    case "scenario":
      return [["situation"], ...(b.helpsItems?.length ? [] : [["helps"]])];
    case "definition":
      return [["sentence"], ["analogy"], ["thisTopic"]];
    case "adds":
      return list("items");
    case "needToKnow":
      return (b.items || []).map((_, i) => ["items", i, "text"]);
    case "blocks":
      return (b.nodes || []).map((_, i) => ["nodes", i, "plain"]);
    case "flow":
      return (b.steps || []).map((_, i) => ["steps", i, "plain"]);
    case "fit":
      return [...list("use"), ...list("not")];
    case "labPreview":
      return [["outcome"]];
    default:
      return [];
  }
}

function read(object, path) {
  return path.reduce((value, key) => (value == null ? undefined : value[key]), object);
}

function write(object, path, text) {
  const parent = read(object, path.slice(0, -1));
  if (parent) parent[path[path.length - 1]] = text;
}

const hashOf = (sources) => createHash("sha1").update(JSON.stringify(sources)).digest("hex").slice(0, 16);

/** The blocks of one slide: its body text, and the lines its presenter says aloud. */
function slideBlocks(deckKey, slide, index) {
  const blocks = [];
  const paths = bodyPaths(slide).filter((path) => isText(read(slide.body, path)));
  if (paths.length) {
    const sources = paths.map((path) => read(slide.body, path));
    blocks.push({ id: `${deckKey}.s${index}.body`, kind: "slide", type: "list", sources, itemKind: "slide", deck: true, names: knownNames(), sourceHash: hashOf(sources), paths });
  }
  const said = (slide.notes || []).map((line, i) => [i, line]).filter(([, line]) => SAY.test(line) && isText(line.replace(SAY, "")));
  if (said.length) {
    const sources = said.map(([, line]) => line.replace(SAY, ""));
    blocks.push({ id: `${deckKey}.s${index}.notes`, kind: "note", type: "list", sources, itemKind: "note", deck: true, names: knownNames(), sourceHash: hashOf(sources), lines: said.map(([i]) => i) });
  }
  return blocks;
}

/** Every writable block of a deck spec, in slide order. */
export function extractDeckBlocks(deckKey, spec) {
  return (spec.slides || []).flatMap((slide, index) => slideBlocks(deckKey, slide, index));
}

function diagramAlt(slide) {
  if (slide.kind === "blocks") {
    const nodes = slide.body.nodes || [];
    return `Diagram of ${nodes.length} building blocks: ${nodes.map((n) => `${n.label}, ${n.plain}`).join("; ")}`;
  }
  if (slide.kind === "flow") {
    const steps = slide.body.steps || [];
    return `Flow diagram with ${steps.length} steps: ${steps.map((s) => s.label).join(", then ")}.`;
  }
  return null;
}

/**
 * A copy of the spec with the saved AI text in place of the standard text. A saved block is used only when the standard
 * text it was written from is still what the spec holds.
 *
 * @param {string} deckKey
 * @param {object} spec
 * @param {{decks?: Record<string, Record<string, {source: string, items: string[]}>>}|null} saved
 */
export function applyDeckWriting(deckKey, spec, saved) {
  const writing = saved?.decks?.[deckKey];
  if (!writing) return spec;
  let changed = false;
  const slides = spec.slides.map((slide, index) => {
    let next = slide;
    for (const block of slideBlocks(deckKey, slide, index)) {
      const entry = writing[block.id];
      if (!entry || entry.source !== block.sourceHash || !Array.isArray(entry.items) || entry.items.length !== block.sources.length) continue;
      if (next === slide) next = { ...slide, body: structuredClone(slide.body), notes: [...(slide.notes || [])] };
      if (block.paths) {
        const before = diagramAlt(slide);
        block.paths.forEach((path, i) => write(next.body, path, entry.items[i]));
        const after = diagramAlt(next);
        if (before && slide.alt === before) next.alt = after;
      } else {
        block.lines.forEach((lineIndex, i) => {
          next.notes[lineIndex] = `SAY: ${entry.items[i]}`;
        });
      }
      changed = true;
    }
    return next;
  });
  return changed ? { ...spec, slides } : spec;
}

/** What to save for a finished run: per deck, per block, the source hash and the accepted items. */
export function savedEntry(block, items) {
  return { source: block.sourceHash, items };
}
