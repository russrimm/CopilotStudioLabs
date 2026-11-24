/**
 * Duplicate guard for training decks: the same slide must never appear twice in one deck.
 *
 * A slide is fingerprinted by its normalized title and its normalized body text. Two slides in one deck are duplicates
 * when their titles are the same, or when their body text is the same or nearly the same (shared runs of three words).
 * `dropDuplicateSlides` keeps the first slide and drops the later one, which is what a combined-harness deck does in
 * production (with a logged warning); tests call `findDuplicateSlides` and expect an empty list.
 *
 * Pure: no I/O, no catalog access.
 */

/** Slides that repeat the agenda by design (a divider shows the agenda with its own part marked): only their titles are compared. */
const TITLE_ONLY_KINDS = new Set(["divider", "agenda"]);
/** Titles that repeat by design (a numbered part of a series), so only their body is compared. */
const SERIES_TITLE = /\(\d+ of \d+\)\s*$/;

/** Body similarity at or above this is a duplicate. */
export const NEAR_DUPLICATE_SIMILARITY = 0.85;
/** A body with fewer words than this is compared for exact equality only. */
export const MIN_WORDS_FOR_SIMILARITY = 12;

/** Lower case, no punctuation, single spaces: the form two slides are compared in. */
export function normalizeSlideText(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function collectStrings(value, out) {
  if (value === null || value === undefined) return out;
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
  } else if (typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
  return out;
}

/** Every string a slide shows in its body, in order. */
export function slideBodyText(slide) {
  return collectStrings(slide?.body, []).join(" ");
}

function shingles(words, size = 3) {
  const out = new Set();
  if (words.length < size) {
    if (words.length) out.add(words.join(" "));
    return out;
  }
  for (let i = 0; i <= words.length - size; i += 1) out.add(words.slice(i, i + size).join(" "));
  return out;
}

/** How alike two bodies are, from 0 to 1 (Jaccard over runs of three words). */
export function bodySimilarity(a, b) {
  const wa = normalizeSlideText(a).split(" ").filter(Boolean);
  const wb = normalizeSlideText(b).split(" ").filter(Boolean);
  if (!wa.length || !wb.length) return 0;
  const sa = shingles(wa);
  const sb = shingles(wb);
  let shared = 0;
  for (const s of sa) if (sb.has(s)) shared += 1;
  return shared / (sa.size + sb.size - shared);
}

/** The fingerprint of one slide. */
export function slideFingerprint(slide) {
  const body = normalizeSlideText(slideBodyText(slide));
  return { title: normalizeSlideText(slide?.title), body, words: body ? body.split(" ").length : 0 };
}

/**
 * The slides of a deck that repeat an earlier slide.
 *
 * @param {object[]} slides
 * @param {{threshold?: number, minWords?: number}} [options]
 * @returns {{index: number, of: number, reason: "title"|"body", similarity: number, title: string}[]}
 */
export function findDuplicateSlides(slides, { threshold = NEAR_DUPLICATE_SIMILARITY, minWords = MIN_WORDS_FOR_SIMILARITY } = {}) {
  const prints = slides.map(slideFingerprint);
  const found = [];
  const dropped = new Set();
  for (let i = 1; i < slides.length; i += 1) {
    for (let j = 0; j < i; j += 1) {
      if (dropped.has(j)) continue;
      let reason = null;
      let similarity = 0;
      if (prints[i].title && prints[i].title === prints[j].title && !SERIES_TITLE.test(String(slides[i].title || ""))) {
        reason = "title";
        similarity = 1;
      } else if (!TITLE_ONLY_KINDS.has(slides[i].kind) && !TITLE_ONLY_KINDS.has(slides[j].kind) && prints[i].body && prints[j].body) {
        if (prints[i].body === prints[j].body && Math.min(prints[i].words, prints[j].words) >= 3) {
          reason = "body";
          similarity = 1;
        } else if (Math.min(prints[i].words, prints[j].words) >= minWords) {
          similarity = bodySimilarity(prints[i].body, prints[j].body);
          if (similarity >= threshold) reason = "body";
        }
      }
      if (reason) {
        found.push({ index: i, of: j, reason, similarity: Math.round(similarity * 100) / 100, title: String(slides[i].title || "") });
        dropped.add(i);
        break;
      }
    }
  }
  return found;
}

/**
 * Remove the later copy of every duplicate slide from a deck spec. The minutes of a dropped slide move to the slide
 * before it, so the deck's minutes still equal the sum of its slides. Calls `warn` once per dropped slide.
 *
 * @returns {{slides: object[], dropped: {index: number, of: number, reason: string, title: string}[]}}
 */
export function dropDuplicateSlides(slides, { warn = null, label = "deck", ...options } = {}) {
  const duplicates = findDuplicateSlides(slides, options);
  if (!duplicates.length) return { slides, dropped: [] };
  const gone = new Set(duplicates.map((d) => d.index));
  const kept = [];
  slides.forEach((slide, index) => {
    if (!gone.has(index)) {
      kept.push({ ...slide });
      return;
    }
    const carry = Number(slide.minutes) || 0;
    if (carry && kept.length) kept[kept.length - 1].minutes = (Number(kept[kept.length - 1].minutes) || 0) + carry;
  });
  if (typeof warn === "function") {
    for (const d of duplicates) warn(`Training ${label}: dropped slide "${d.title}" because it repeats slide ${d.of + 1} (${d.reason}, ${d.similarity}).`);
  }
  return { slides: kept, dropped: duplicates };
}
