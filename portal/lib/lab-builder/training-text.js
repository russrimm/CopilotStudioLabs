/**
 * Plain-language helpers for the pre-lab training decks: a small readability
 * measure (Flesch-Kincaid grade), an acronym check, and the text shaping the
 * deck builder uses so slide text stays short and calm.
 *
 * Pure functions, no I/O. The tests use the same measure the library check does,
 * so a slide that fails here fails everywhere.
 */

/** Product and feature names that are long words but not hard to read; they count as one short word. */
export const PRODUCT_NAME_ALLOWLIST = Object.freeze([
  "Microsoft Copilot Studio",
  "Microsoft 365 Copilot",
  "Microsoft Copilot harness",
  "Customer Conversation harness",
  "Microsoft Foundry",
  "Microsoft Entra ID",
  "Microsoft Purview",
  "Power Platform",
  "Power Automate",
  "Power Apps",
  "AI Builder",
  "Copilot Studio",
  "SharePoint",
  "Dataverse",
  "Microsoft Teams",
  "OneDrive",
  "Azure AI Search",
  "Model Context Protocol",
  "Agent Builder",
  "Agents Toolkit",
  "Adaptive Cards",
  "Adaptive Card",
  "Power Fx",
  "Copilot Credits",
  "generative orchestration",
  "orchestration",
  "Microsoft Learn",
  "Contoso",
  "Fabrikam",
]);

/** Short all-caps words every audience reads without help. */
export const COMMON_ACRONYMS = Object.freeze(new Set(["AI", "US", "PDF", "URL", "FAQ", "FAQS", "IT", "HR", "ID", "OK", "PM", "AM", "UI", "Q&A", "QA", "CSV", "JSON", "SMS", "VS", "II", "III", "IV"]));

/** Count syllables in one English word (a standard heuristic, good enough for a grade estimate). */
export function countSyllables(rawWord) {
  const word = String(rawWord || "").toLowerCase().replace(/[^a-z]/g, "");
  if (!word) return 0;
  if (word.length <= 3) return 1;
  const stripped = word.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "");
  const groups = stripped.match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}

function maskAllowlist(text, allowlist) {
  let out = String(text || "");
  const sorted = [...allowlist].sort((a, b) => b.length - a.length);
  for (const name of sorted) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`\\b${escaped}\\b`, "gi"), "name");
  }
  return out;
}

/** Strip the markup the deck builder understands so only the words a presenter reads remain. */
export function plainText(text) {
  return String(text || "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Split text into sentences. A bullet or a short label counts as one sentence. */
export function splitSentences(text) {
  const cleaned = plainText(text).replace(/\b(e\.g|i\.e|vs|etc)\./gi, "$1");
  return cleaned
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => /[A-Za-z]/.test(s));
}

/**
 * Flesch-Kincaid grade level of `text`. Allowlisted product names count as one short word.
 * @returns {{grade:number, words:number, sentences:number}}
 */
export function fleschKincaid(text, { allowlist = PRODUCT_NAME_ALLOWLIST } = {}) {
  const masked = maskAllowlist(text, allowlist);
  const sentences = splitSentences(masked);
  const words = masked.match(/[A-Za-z][A-Za-z'’-]*/g) || [];
  if (!sentences.length || !words.length) return { grade: 0, words: words.length, sentences: sentences.length };
  const syllables = words.reduce((sum, word) => sum + countSyllables(word), 0);
  const grade = 0.39 * (words.length / sentences.length) + 11.8 * (syllables / words.length) - 15.59;
  return { grade: Math.max(0, Math.round(grade * 10) / 10), words: words.length, sentences: sentences.length };
}

/** Average grade over many pieces of text, weighting each by its word count. */
export function averageGrade(texts, options) {
  let weighted = 0;
  let total = 0;
  for (const text of texts) {
    const { grade, words } = fleschKincaid(text, options);
    if (!words) continue;
    weighted += grade * words;
    total += words;
  }
  return total ? Math.round((weighted / total) * 10) / 10 : 0;
}

/**
 * Acronyms (two or more capital letters) whose first use in `texts` (in reading order) is not explained.
 * An acronym is explained when its first use sits in parentheses after its words ("Model Context Protocol (MCP)"),
 * is followed by a parenthetical ("MCP (Model Context Protocol)"), or is on the common-acronym list.
 */
export function unexpandedAcronyms(texts, { extraOk = [] } = {}) {
  const ok = new Set([...COMMON_ACRONYMS, ...extraOk.map((a) => String(a).toUpperCase())]);
  const seen = new Set();
  const bad = [];
  for (const raw of texts) {
    const text = plainText(raw);
    for (const match of text.matchAll(/\b[A-Z][A-Z0-9&]{1,7}\b/g)) {
      const acronym = match[0];
      if (ok.has(acronym) || /^\d/.test(acronym) || seen.has(acronym)) continue;
      const before = text.slice(0, match.index);
      const after = text.slice(match.index + acronym.length);
      const inParens = /\(\s*$/.test(before) && /^\s*\)/.test(after);
      const followedByGloss = /^\s*\(\s*[A-Za-z]/.test(after);
      seen.add(acronym);
      if (!inParens && !followedByGloss) bad.push(acronym);
    }
  }
  return bad;
}

/** Uppercase the first letter. */
export function upperFirst(text) {
  const s = String(text || "");
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** Lowercase the first letter unless the first word is a name or acronym. */
export function lowerFirst(text) {
  const s = String(text || "");
  if (!s) return s;
  const first = s.split(/\s+/)[0];
  if (/^[A-Z]{2,}/.test(first) || /^[A-Z][a-z]+[A-Z]/.test(first)) return s;
  return s[0].toLowerCase() + s.slice(1);
}

/** Make sure text ends with a period (or other closing punctuation). */
export function endWithPeriod(text) {
  const clean = String(text || "").trim();
  if (!clean) return "";
  return /[.!?…]$/.test(clean) ? clean : `${clean}.`;
}

/** The first sentence of a text, whole (never cut in the middle of a word). */
export function firstSentence(text, maxChars = 200) {
  const sentences = splitSentences(text);
  const first = sentences[0] || "";
  if (first.length <= maxChars) return first;
  const cut = first.slice(0, maxChars);
  const space = cut.lastIndexOf(" ");
  return `${cut.slice(0, space > 40 ? space : maxChars).replace(/[,;:]+$/, "")}.`;
}

/** Whole sentences from `text` that fit in `maxChars` in total (at least one when it fits at all). */
export function wholeSentences(text, maxChars = 260, maxSentences = 3) {
  const out = [];
  let total = 0;
  for (const sentence of splitSentences(text)) {
    if (out.length >= maxSentences) break;
    if (total + sentence.length + (out.length ? 1 : 0) > maxChars) break;
    out.push(sentence);
    total += sentence.length + 1;
  }
  return out.join(" ");
}
