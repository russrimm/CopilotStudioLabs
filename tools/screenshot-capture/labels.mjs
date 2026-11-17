// Words and labels: the shared, dependency-free text rules behind "does this screen show what the lab
// describes". Lab steps come from Microsoft Learn and from catalog data, so the labels taken from them contain
// typos ("Start building form scratch"), stop words, sentences, and placeholders. These helpers clean the
// expected labels at their source and compare them to the visible text without being fooled by case,
// punctuation, small typos, or plurals.

export const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "into", "is", "it", "of", "on", "or", "that", "the", "this", "to", "with", "your", "you", "my",
]);

// Words that sit on nearly every screen, so seeing them proves nothing.
const GENERIC_LABELS = new Set(["yes", "no", "ok", "okay", "next", "back", "close", "done", "save", "cancel", "submit", "add", "new", "create", "select", "name", "description", "more", "all", "none", "other", "edit", "delete", "continue", "finish", "got it"]);

// Mistakes known to be in the lab sources (verified against the page they come from), fixed before use.
const KNOWN_TYPOS = [[/\bform scratch\b/gi, "from scratch"]];

const MAX_LABEL_WORDS = 8;

/** Lowercase, no accents, punctuation turned into spaces, one space between words. */
export function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function tokenize(value) {
  const text = normalizeText(value);
  return text ? text.split(" ") : [];
}

/** The words of a label that carry meaning (stop words removed). */
export function significantTokens(value) {
  return tokenize(value).filter((t) => !STOP_WORDS.has(t));
}

/**
 * One expected label made safe to use, or null when it is not a usable label: empty, a placeholder like
 * `<agent name>`, only stop words, a generic word, a sentence, or only digits. Known typos are corrected.
 */
export function cleanExpectedLabel(raw) {
  let text = String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/[*`]+/g, "")
    .replace(/^_+|_+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  if (/[<>{}[\]]/.test(text)) return null;
  text = text.replace(/^[\s"'“”‘’(]+|[\s"'“”‘’).,:;!]+$/g, "").trim();
  for (const [pattern, replacement] of KNOWN_TYPOS) text = text.replace(pattern, replacement);
  const words = tokenize(text);
  if (!words.length || words.length > MAX_LABEL_WORDS) return null;
  if (!significantTokens(text).length) return null;
  if (words.every((w) => /^\d+$/.test(w))) return null;
  if (words.length === 1 && (GENERIC_LABELS.has(words[0]) || words[0].length < 3)) return null;
  if (GENERIC_LABELS.has(words.join(" "))) return null;
  return text.slice(0, 80);
}

/** A list of labels cleaned, de-duplicated by meaning, and bounded. */
export function cleanExpectedLabels(list, { max = 20 } = {}) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const label = cleanExpectedLabel(raw);
    if (!label) continue;
    const key = normalizeText(label);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
    if (out.length >= max) break;
  }
  return out;
}

/** Whether two words are the same, a plural of each other, or one typo apart (a swap, a missing, extra, or wrong letter). */
export function wordsMatch(a, b) {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  if (a === `${b}s` || b === `${a}s` || a === `${b}es` || b === `${a}es`) return true;
  const diff = Math.abs(a.length - b.length);
  if (diff > 1) return false;
  if (diff === 0) {
    let first = -1;
    let count = 0;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] === b[i]) continue;
      count += 1;
      if (count === 1) first = i;
      if (count > 2) return false;
    }
    if (count === 1) return true;
    return count === 2 && a[first] === b[first + 1] && a[first + 1] === b[first];
  }
  const [shorter, longer] = a.length < b.length ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let skipped = false;
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) {
      i += 1;
      j += 1;
    } else if (skipped) {
      return false;
    } else {
      skipped = true;
      j += 1;
    }
  }
  return true;
}

/** A set of the words that are visible, ready to be searched. */
export function visibleWordSet(lines) {
  const words = new Set();
  for (const line of Array.isArray(lines) ? lines : [lines]) for (const token of tokenize(line)) words.add(token);
  return words;
}

function hasWord(words, token) {
  if (words.has(token)) return true;
  if (token.length < 4) return false;
  for (const w of words) if (wordsMatch(token, w)) return true;
  return false;
}

/**
 * Whether a label is on the screen: every meaningful word of it (all but one, for four words or more) is among
 * the visible words, give or take a typo or a plural. `words` comes from `visibleWordSet`.
 */
export function labelIsVisible(label, words) {
  const tokens = significantTokens(label);
  if (!tokens.length) return false;
  const found = tokens.filter((t) => hasWord(words, t)).length;
  return found === tokens.length || (tokens.length >= 4 && found >= tokens.length - 1);
}
