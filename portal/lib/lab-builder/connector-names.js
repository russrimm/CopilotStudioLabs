/**
 * Connector names: the display name a person knows, instead of the internal API name.
 *
 * Power Platform connectors have an internal API name (`shared_webcontents`, used in connection references, solutions and
 * the admin API) and a display name (`HTTP with Microsoft Entra ID (preauthorized)`, the title of the connector's
 * Microsoft Learn reference page). Microsoft Learn prints the internal name in a few places (for example the agent
 * inventory and connector policy pages), and the lab builder carries Learn text into steps, notes and tables, so the
 * internal name can reach a learner. Everything a person reads shows the display name.
 *
 * The curated table is `connectors.json`. Every entry was checked against its Learn connector page title and carries the
 * page it was checked against and the date (`tools/lab-builder/verify-connector-names.mjs` does the check and adds
 * entries). A name that is not in the table is looked up once at build time (see `connector-names-live.js`) and, when it
 * still cannot be resolved, shown as the neutral "a connector (<id>)" and reported, never guessed.
 *
 * Pure and dependency-free (only Node's file API), so the offline CLI can use it. Nothing here fetches anything.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATA_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "connectors.json");
export const CONNECTORS_DATA_PATH = DATA_PATH;
export const LEARN_CONNECTORS_BASE = "https://learn.microsoft.com/connectors/";

const PREFIX = "shared_";
const PROVIDER_PATH = "/providers/Microsoft.PowerApps/apis/";
/** What an unresolved name is shown as. The id stays in the parentheses so an administrator can still find it. */
export const NEUTRAL_LEAD = "a connector (";
/** The note that follows a literal code span (a URL or payload fragment that must stay exactly as written). */
export const LITERAL_NOTE_LEAD = " (connector: ";

let loaded = null;

function normalizeKey(value) {
  let key = String(value ?? "").trim().toLowerCase();
  if (key.startsWith(PROVIDER_PATH.toLowerCase())) key = key.slice(PROVIDER_PATH.length);
  return key.replace(/^shared-/, PREFIX);
}

/** The curated table, indexed by every name a lookup can use. Read once; `reloadConnectorTable` is for tests. */
function load() {
  if (loaded) return loaded;
  const raw = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
  const entries = (Array.isArray(raw?.connectors) ? raw.connectors : []).map((entry) => Object.freeze({ ...entry }));
  const byApi = new Map();
  const byLookup = new Map();
  for (const entry of entries) {
    const api = normalizeKey(entry.apiName);
    byApi.set(api, entry);
    byLookup.set(api, entry);
    if (api.startsWith(PREFIX)) byLookup.set(api.slice(PREFIX.length), entry);
    const slug = String(entry.learnSlug || "").trim().toLowerCase();
    if (slug) byLookup.set(slug, entry);
  }
  // Aliases never override a real API name or slug: the first entry to claim one keeps it.
  for (const entry of entries) {
    for (const alias of entry.aliases || []) {
      const key = normalizeKey(alias);
      if (key && !byLookup.has(key)) byLookup.set(key, entry);
    }
  }
  loaded = { entries, byApi, byLookup };
  return loaded;
}

/** Forget the loaded table so the next lookup reads the file again (tests that edit a copy of it). */
export function reloadConnectorTable() {
  loaded = null;
}

/** Every curated connector, in file order. */
export function listConnectors() {
  return load().entries;
}

function describe(entry) {
  return { apiName: entry.apiName, displayName: entry.displayName, learnUrl: entry.learnUrl, verifiedAt: entry.verifiedAt };
}

/**
 * Look a connector up by API name (`shared_webcontents`, `shared-webcontents`, or the full
 * `/providers/Microsoft.PowerApps/apis/shared_webcontents` path), by its Learn page name (`webcontents`), or by an alias.
 *
 * @param {string} value
 * @returns {{apiName: string, displayName: string, learnUrl: string, verifiedAt: string}|null} null when it is not in the table
 */
export function resolveConnector(value) {
  const entry = load().byLookup.get(normalizeKey(value));
  return entry ? describe(entry) : null;
}

/** The display name for `value`, or null. */
export function connectorDisplayName(value) {
  return resolveConnector(value)?.displayName ?? null;
}

/** The Learn connector reference page for an API name, even for one that is not in the table (the page is named by the id). */
export function connectorLearnUrl(value) {
  const known = resolveConnector(value);
  if (known) return known.learnUrl;
  const key = normalizeKey(value);
  return key.startsWith(PREFIX) ? `${LEARN_CONNECTORS_BASE}${key.slice(PREFIX.length)}/` : null;
}

// ── Finding and rewriting ids in text ─────────────────────────────────────────────────────────

const TOKEN_SOURCE = String.raw`shared[_-][a-z0-9]+(?:[_-][a-z0-9]+)*`;
/** Matches a whole connector-looking token, with the full resource path when it is written that way. */
const TOKEN_RE = new RegExp(String.raw`(?<![A-Za-z0-9_-])(?:\/providers\/Microsoft\.PowerApps\/apis\/)?(${TOKEN_SOURCE})(?![A-Za-z0-9])`, "gi");
const WHOLE_TOKEN_RE = new RegExp(String.raw`^(?:\/providers\/Microsoft\.PowerApps\/apis\/)?(${TOKEN_SOURCE})$`, "i");
/** Quick test: could this text hold an id at all? Used to skip the work for the many strings that cannot. */
const HAS_TOKEN_RE = /shared[_-][a-z0-9]/i;

/**
 * The longest table entry a token starts with, cutting only at hyphens (so `shared_sql-based` finds `shared_sql`
 * but `shared_documents` finds nothing). Returns the entry and how many characters of the token it covers.
 */
function lookupToken(token, extra) {
  let candidate = normalizeKey(token);
  for (;;) {
    const hit = load().byApi.get(candidate) || (extra && extra.get(candidate));
    if (hit) return { apiName: hit.apiName || candidate, displayName: hit.displayName, length: candidate.length };
    const cut = candidate.lastIndexOf("-");
    if (cut <= PREFIX.length) return null;
    candidate = candidate.slice(0, cut);
  }
}

function extraMap(resolved) {
  if (!resolved) return null;
  if (resolved instanceof Map) return resolved;
  return new Map(Object.entries(resolved).map(([key, value]) => [normalizeKey(key), value]));
}

/** What a replacement may do to a token it cannot resolve. */
function replaceTokens(text, ctx) {
  return text.replace(TOKEN_RE, (match, token, offset) => {
    const found = lookupToken(token, ctx.extra);
    if (found && found.displayName) return `${found.displayName}${token.slice(found.length)}`;
    // "shared-identity" is an ordinary hyphenated phrase; only the underscore form is ever taken for an unknown connector.
    if (!ctx.neutral || token[PREFIX.length - 1] === "-") return match;
    // The neutral form is only added once, so running the rewrite again changes nothing.
    if (text.slice(Math.max(0, offset - NEUTRAL_LEAD.length), offset) === NEUTRAL_LEAD) return match;
    const prefix = match.slice(0, match.length - token.length);
    return `${NEUTRAL_LEAD}${prefix}${token})`;
  });
}

// Pieces of a line that are never rewritten as prose: code spans (handled on their own), link targets, addresses and
// the attribute values of embedded HTML.
const SEGMENT_RE = /(`+)(?!`)(.+?)(?<!`)\1(?!`)|\]\([^)\s]*(?:\s+"[^"]*")?\)|<https?:\/\/[^>\s]+>|https?:\/\/[^\s)<>\]]+|\b(?:href|src|id|class|name|data-[\w-]+)=(?:"[^"]*"|'[^']*')/gi;

/** A code span is a literal (a URL, a path of its own, a payload fragment) when it holds more than a short name. */
function isLiteralSpan(inner) {
  const text = inner.trim();
  if (WHOLE_TOKEN_RE.test(text)) return false;
  return /[/{}"\\]|:\/\//.test(text);
}

function rewriteSpan(match, ticks, inner, restOfLine, ctx) {
  const trimmed = inner.trim();
  const whole = WHOLE_TOKEN_RE.exec(trimmed);
  if (whole) {
    const found = lookupToken(whole[1], ctx.extra);
    if (found && found.displayName && found.length === normalizeKey(whole[1]).length) return found.displayName;
    return ctx.neutral ? replaceTokens(trimmed, ctx) : match;
  }
  if (!isLiteralSpan(inner)) {
    return HAS_TOKEN_RE.test(inner) ? `${ticks}${replaceTokens(inner, ctx)}${ticks}` : match;
  }
  // A literal stays exactly as written; the sentence around it gets the display name.
  if (restOfLine.startsWith(LITERAL_NOTE_LEAD)) return match;
  const names = [];
  for (const [, token] of inner.matchAll(new RegExp(TOKEN_RE.source, "gi"))) {
    const name = lookupToken(token, ctx.extra)?.displayName;
    if (name && !names.includes(name)) names.push(name);
  }
  return names.length ? `${match}${LITERAL_NOTE_LEAD}${names.join(", ")})` : match;
}

function rewriteLine(line, ctx) {
  if (!HAS_TOKEN_RE.test(line)) return line;
  // A link reference definition is a target, not prose.
  if (/^\s{0,3}\[[^\]]+\]:\s+\S+/.test(line)) return line;
  let out = "";
  let last = 0;
  for (const m of line.matchAll(SEGMENT_RE)) {
    out += replaceTokens(line.slice(last, m.index), ctx);
    const end = m.index + m[0].length;
    out += m[1] !== undefined ? rewriteSpan(m[0], m[1], m[2], line.slice(end), ctx) : m[0];
    last = end;
  }
  return out + replaceTokens(line.slice(last), ctx);
}

/** Walk the lines of a Markdown text, calling `visit(line, lineNumber)` for each one outside fenced code and `<pre>` blocks. */
function eachProseLine(text, visit) {
  const lines = String(text).split("\n");
  let fence = null;
  let inPre = false;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const fenceMatch = raw.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      continue;
    }
    if (inPre) {
      if (/<\/pre>/i.test(raw)) inPre = false;
      continue;
    }
    if (/<pre[\s>]/i.test(raw) && !/<\/pre>/i.test(raw)) {
      inPre = true;
      continue;
    }
    visit(raw, i);
  }
  return lines;
}

/**
 * Rewrite the connector ids in `text` to display names.
 *
 * Only whole `shared_<name>` tokens that are in the curated table (or in `options.resolved`) are replaced, so ordinary
 * words are never touched. Fenced code blocks and `<pre>` blocks are left alone, and so are link targets, addresses and
 * HTML attributes. A short inline code span that is only an id (or `/providers/Microsoft.PowerApps/apis/<id>`) becomes
 * the display name; a longer literal one (a URL or payload fragment) stays as written and the display name follows it as
 * "(connector: Name)". Applying it again changes nothing.
 *
 * @param {string} text
 * @param {{resolved?: Map<string, {displayName: string}>|Record<string, {displayName: string}>, neutral?: boolean}} [options]
 *   `resolved`: names looked up at build time. `neutral`: show an id that cannot be resolved as "a connector (<id>)".
 * @returns {string}
 */
export function rewriteConnectorText(text, options = {}) {
  if (typeof text !== "string" || !HAS_TOKEN_RE.test(text)) return text;
  const ctx = { extra: extraMap(options.resolved), neutral: Boolean(options.neutral) };
  const crlf = text.includes("\r\n");
  const source = text.replace(/\r\n/g, "\n");
  const prose = new Set();
  const lines = eachProseLine(source, (_line, index) => prose.add(index));
  const out = lines.map((line, index) => (prose.has(index) ? rewriteLine(line, ctx) : line)).join("\n");
  return crlf ? out.replace(/\n/g, "\r\n") : out;
}

/** The repair for text saved by an older build: known ids become display names, nothing else changes. */
export function repairConnectorNames(text) {
  return rewriteConnectorText(text);
}

// Fields that hold identifiers or file names by design, and the user's own selections (kept as typed so "Edit selections" works).
const SKIPPED_KEYS = /^(?:url|urls|href|src|path|file|filename|fileName|asset|assets|image|slug|id|ids|labId|featureId|moduleId|apiName|apiNames|technicalName|technicalNames|learnUrl|hash|fingerprint|contentFingerprint|request|options|decisions)$/;
const FILE_OR_URL_RE = /^(?:https?:\/\/\S+|[\w./\\-]+\.(?:png|jpe?g|webp|gif|json|md|docx|pptx|pdf|html?))$/i;

/**
 * `value` with the ids in every string rewritten (objects and arrays are copied, never changed in place). Strings that are
 * addresses or file names, and the fields that hold identifiers by design, are left alone.
 */
export function rewriteConnectorValue(value, options = {}) {
  const walk = (node, key) => {
    if (typeof node === "string") {
      if (key && SKIPPED_KEYS.test(key)) return node;
      if (FILE_OR_URL_RE.test(node.trim())) return node;
      return rewriteConnectorText(node, options);
    }
    if (key && SKIPPED_KEYS.test(key)) return node;
    if (Array.isArray(node)) return node.map((item) => walk(item, key));
    if (node && typeof node === "object") {
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v, k)]));
    }
    return node;
  };
  return walk(value, "");
}

/**
 * Every connector-looking token a person would read in `text` (outside fenced code, address text and literal code spans).
 *
 * @returns {Array<{token: string, apiName: string, known: boolean, neutral: boolean, line: number}>}
 *   `neutral` is true for an id already shown as "a connector (<id>)", which is how an unresolved one is reported.
 */
export function findConnectorIds(text, options = {}) {
  const found = [];
  const extra = extraMap(options.resolved);
  const source = String(text ?? "").replace(/\r\n/g, "\n");
  if (!HAS_TOKEN_RE.test(source)) return found;
  eachProseLine(source, (line, index) => {
    if (!HAS_TOKEN_RE.test(line) || /^\s{0,3}\[[^\]]+\]:\s+\S+/.test(line)) return;
    const visit = (chunk, base) => {
      for (const m of chunk.matchAll(new RegExp(TOKEN_RE.source, "gi"))) {
        const token = m[1];
        const at = base + m.index;
        const known = Boolean(lookupToken(token, extra));
        // "shared-identity" is an ordinary hyphenated phrase, not a connector: only a known name is taken in that form.
        if (!known && token[PREFIX.length - 1] === "-") continue;
        found.push({
          token,
          apiName: normalizeKey(token),
          known,
          neutral: line.slice(Math.max(0, at - NEUTRAL_LEAD.length), at) === NEUTRAL_LEAD,
          line: index + 1,
        });
      }
    };
    let last = 0;
    for (const m of line.matchAll(SEGMENT_RE)) {
      visit(line.slice(last, m.index), last);
      // A short code span that is only an id is read as text; a literal one is allowed to keep it.
      if (m[1] !== undefined && !isLiteralSpan(m[2])) visit(m[0], m.index);
      last = m.index + m[0].length;
    }
    visit(line.slice(last), last);
  });
  return found;
}

/**
 * Every connector-looking token a person would read anywhere in `value` (a string or any nesting of arrays and objects),
 * skipping the fields that hold identifiers or file names by design. Same shape as `findConnectorIds`.
 */
export function findConnectorIdsInValue(value, options = {}) {
  const hits = [];
  const walk = (node, key) => {
    if (key && SKIPPED_KEYS.test(key)) return;
    if (typeof node === "string") {
      if (FILE_OR_URL_RE.test(node.trim())) return;
      hits.push(...findConnectorIds(node, options));
    } else if (Array.isArray(node)) {
      for (const item of node) walk(item, key);
    } else if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) walk(v, k);
    }
  };
  walk(value, "");
  return hits;
}

/**
 * The ids in `value` (a string or any object of strings) that are not in the table and would need a lookup, lowercased.
 */
export function collectUnknownConnectorIds(value, options = {}) {
  const extra = extraMap(options.resolved);
  const ids = new Set();
  for (const hit of findConnectorIdsInValue(value, { resolved: options.resolved })) {
    if (!hit.known && !hit.neutral && !extra?.has(hit.apiName)) ids.add(hit.apiName);
  }
  return [...ids].sort();
}

/** True when `text` has an id that is not shown as a display name (the lab gate and the output tests use this). */
export function hasConnectorId(text) {
  return findConnectorIds(text).length > 0;
}

/** Recorded in a lab's manifest once its saved topic documents were rebuilt from repaired text. */
export const CONNECTOR_NAMES_VERSION = 1;

/**
 * Whether reading this saved lab changes anything: its text or its manifest holds an id the table knows. A lab built after
 * connector names existed (or one that never had an id) answers false, so nothing derived from it is rebuilt.
 */
export function needsConnectorRepair({ markdown = "", manifest = null } = {}) {
  if (repairConnectorNames(String(markdown)) !== String(markdown)) return true;
  if (!manifest || typeof manifest !== "object") return false;
  return JSON.stringify(rewriteConnectorValue(manifest)) !== JSON.stringify(manifest);
}
