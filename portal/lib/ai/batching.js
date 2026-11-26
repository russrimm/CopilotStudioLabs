/**
 * AI writing: how passages are grouped into model calls.
 *
 * A block is a passage the guard judges as a whole (a paragraph, or a list such as the steps of a module or the lines on a
 * slide). The model sees each piece of a block as its own passage, so it cannot merge a list into one paragraph. Blocks are
 * packed into requests by size, so a call is neither so small that it wastes a prompt nor so large that it runs out of time
 * (a 60 second limit once rejected a call of 85 passages that a retry finished in 38 seconds). Every function here is pure.
 */

import { MIN_CALL_TIMEOUT_MS } from "./config.js";
import { protectedTokens } from "./guard.js";

/** The separator between a block id and the position of one of its items, in a passage id. */
export const PIECE_SEPARATOR = "~";

/**
 * True when a passage has enough plain words for a model to reword. A bold interface term, a code word, an address, a quoted
 * label and a number are protected and stay as written, so what is left must be at least three words.
 */
export function isRewordable(text) {
  const rest = String(text ?? "")
    .replace(/^SAY: /, "")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/\*\*[^*\n]*\*\*/g, " ")
    .replace(/["\u201c][^"\u201d\n]{2,60}["\u201d]/g, " ")
    .replace(/\d[\d.,:%/-]*/g, " ");
  return (rest.match(/[A-Za-z][A-Za-z'\u2019-]*/g) || []).length >= 3;
}

function keepFor(block, source) {
  const lists = { ui: block.ui || [], names: block.names || [] };
  const tokens = protectedTokens(source, lists);
  const keep = new Set();
  for (const group of [tokens.urls, tokens.code, tokens.numbers, tokens.ui, tokens.names]) for (const token of group) keep.add(token);
  return [...keep];
}

/** The passages of one block, each with its own id. Pieces that are not worth a model's time are marked and sent nowhere. */
export function piecesOf(block) {
  if (block.type === "list") {
    const count = block.sources.length;
    return block.sources.map((source, index) => ({
      id: `${block.id}${PIECE_SEPARATOR}${index + 1}`,
      index,
      kind: block.kind,
      group: block.id,
      position: `${index + 1} of ${count}`,
      source,
      keep: keepFor(block, source),
      ask: isRewordable(source),
      ...(block.maxChars ? { maxChars: block.maxChars } : {}),
    }));
  }
  const source = String(block.source ?? "");
  return [{ id: block.id, index: 0, kind: block.kind, source, keep: keepFor(block, source), ask: isRewordable(source), ...(block.maxChars ? { maxChars: block.maxChars } : {}) }];
}

/** How big a block is for the model: the characters of the pieces it will be asked to reword. */
export function sizeOf(pieces) {
  let chars = 0;
  let items = 0;
  for (const piece of pieces) {
    if (!piece.ask) continue;
    chars += piece.source.length;
    items += 1;
  }
  return { chars, items };
}

/**
 * Pack entries (blocks with their pieces, in unit order) into requests. A request holds at most `maxBlocks` blocks and
 * `maxChars` source characters, and its blocks come from at most `maxUnits` units, because every unit's scenario travels with
 * it. A block is never split across requests; one larger than `maxChars` goes alone.
 *
 * @param {Array<{unit: object, chars: number}>} entries
 */
export function packRequests(entries, { maxChars, maxBlocks, maxUnits = 3 }) {
  const requests = [];
  let current = null;
  for (const entry of entries) {
    const newUnit = !current || current.units.at(-1) !== entry.unit;
    const fits =
      current &&
      current.entries.length < maxBlocks &&
      current.chars + entry.chars <= maxChars &&
      (!newUnit || current.units.length < maxUnits);
    if (!fits) {
      current = { entries: [], units: [], chars: 0, depth: 0, attempts: 0 };
      requests.push(current);
    }
    if (current.units.at(-1) !== entry.unit) current.units.push(entry.unit);
    current.entries.push(entry);
    current.chars += entry.chars;
  }
  return requests.map(({ entries: list, depth, attempts }) => ({ entries: list, depth, attempts }));
}

/**
 * A request's entries grouped by unit, in order: what the prompt builder takes. The model sees short ids (p1, p2, ...) and
 * group labels (g1, g2, ...), which keeps both its answer and the prompt small; `ids` maps each short id back to the piece.
 */
export function sectionsOf(entries) {
  const sections = [];
  const ids = new Map();
  const groups = new Map();
  let count = 0;
  for (const entry of entries) {
    const pieces = entry.pieces
      .filter((piece) => piece.ask)
      .map((piece) => {
        count += 1;
        const local = `p${count}`;
        ids.set(local, piece.id);
        let group;
        if (piece.group) {
          if (!groups.has(piece.group)) groups.set(piece.group, `g${groups.size + 1}`);
          group = groups.get(piece.group);
        }
        return { ...piece, id: local, group };
      });
    const last = sections.at(-1);
    if (last && last.unit === entry.unit) last.pieces.push(...pieces);
    else sections.push({ unit: entry.unit, pieces });
  }
  return { sections, ids };
}

/**
 * The time one call is given. The model's own writing speed is the main cost (about 35 to 100 tokens a second on a small model
 * in practice), so the allowance grows with the text it must write: 30 seconds plus 40 ms for each output token expected,
 * between a floor and `maxMs` (AI_TIMEOUT_MS).
 */
export function callTimeoutMs({ chars, items }, maxMs) {
  const outputTokens = Math.ceil(chars / 3) + 25 * items;
  const wanted = 30000 + outputTokens * 40;
  return Math.max(Math.min(MIN_CALL_TIMEOUT_MS, maxMs), Math.min(maxMs, wanted));
}

/** Two halves of a request's entries, or null when it holds a single block (a block is never split). */
export function splitInHalf(entries) {
  if (entries.length < 2) return null;
  const middle = Math.ceil(entries.length / 2);
  return [entries.slice(0, middle), entries.slice(middle)];
}
