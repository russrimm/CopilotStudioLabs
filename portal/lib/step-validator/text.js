/**
 * Text helpers shared by claim extraction, matching, and reporting.
 *
 * Everything that touches Microsoft Learn content goes through `sanitizeExcerpt`
 * first: fetched docs are untrusted data, so they are only ever treated as plain
 * strings to search and to display, never interpreted or executed.
 */

const ARROW_RE = /\s*(?:→|->|=>|›|»|&gt;|&rarr;)\s*/g;

/** Drop markdown syntax and keep the visible words. */
export function stripMarkdown(text) {
  return String(text ?? "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/[*_`~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Copilot Studio renamed the "GitHub Copilot harness" to the "Microsoft Copilot
 * harness". Some Learn pages, titles, and URLs still use the old name, so both
 * names compare equal here. Only the comparison form changes; the Learn text
 * and URLs shown to learners are left exactly as published.
 */
const HARNESS_ALIAS_RE = /\bgithub copilot harness(es)?\b/g;

/**
 * Normalize text for phrase comparison. Case, quotes, dashes, markdown, and
 * punctuation are ignored; navigation arrows become ">" so "Settings → X",
 * "Settings > X", and "**Settings** > **X**" compare equal.
 */
export function normalizeText(text) {
  return stripMarkdown(text)
    .normalize("NFKC")
    .replace(ARROW_RE, " > ")
    .replace(/[\u2018\u2019\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E]/g, '"')
    .replace(/&amp;/g, "&")
    .toLowerCase()
    .replace(/\s&\s/g, " and ")
    .replace(/[^\p{L}\p{N}>% ]+/gu, " ")
    .replace(/\s*>\s*/g, " > ")
    .replace(/\s+/g, " ")
    .replace(HARNESS_ALIAS_RE, "microsoft copilot harness$1")
    .trim();
}

/** Singular/plural variants of the last word, so "Topics" matches "topic". */
export function phraseVariants(normalized) {
  const variants = new Set([normalized]);
  if (/s$/.test(normalized) && normalized.length > 4) variants.add(normalized.slice(0, -1));
  else if (normalized.length > 2) variants.add(`${normalized}s`);
  return [...variants];
}

/** Whole-word phrase containment on already-normalized strings. */
export function containsPhrase(haystack, needle) {
  if (!needle) return false;
  const padded = ` ${haystack} `;
  return phraseVariants(needle).some((variant) => padded.includes(` ${variant} `));
}

/** Split prose into sentences. Good enough for excerpt matching; not a linguistic parser. */
export function splitSentences(text) {
  return String(text ?? "")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(*`[])|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Remove control characters and HTML, and cap the length. Safe for display and storage. */
export function sanitizeExcerpt(text, max = 320) {
  const clean = String(text ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** A window of text around the first occurrence of an index, trimmed to word edges. */
export function excerptAround(text, index, length, max = 320) {
  const start = Math.max(0, index - Math.floor((max - length) / 2));
  const slice = String(text).slice(start, start + max);
  return sanitizeExcerpt(`${start > 0 ? "…" : ""}${slice}`, max + 2);
}

/** Only Microsoft Learn pages count as documentation evidence. */
export function isLearnUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname.toLowerCase() === "learn.microsoft.com";
  } catch {
    return false;
  }
}

/** Canonical form of a Learn URL: no locale, query, hash, or trailing slash. */
export function canonicalLearnUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/[a-z]{2}-[a-z]{2}(?=\/)/i, "").replace(/\/+$/, "");
    return `${u.protocol}//${u.hostname.toLowerCase()}${path}`.toLowerCase();
  } catch {
    return String(url ?? "").toLowerCase();
  }
}
