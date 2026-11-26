/**
 * AI writing: the "no invented facts" guard.
 *
 * The model is a writer, never a source. Every block it returns is compared with the block it was given. Each of these
 * kinds of token in the source must still be in the answer, and the answer may not add a new one:
 *   - numbers (3, 25%, 1,000, 4.5)
 *   - web addresses
 *   - code and identifiers (`text in backticks`, snake_case, camelCase, FILE_NAMES.json, GUIDs, paths, {{placeholders}})
 *   - interface terms (**bold**, "quoted", the parts of a click path, and the interface terms the caller lists)
 *   - product and connector names the caller lists
 * A list (the steps of a module) must keep its length, its order, and the line structure of each item. A block that
 * fails any check is discarded and the deterministic text is used instead, so a guard failure can only make a lab plainer,
 * never wrong. The checks never read the network and never call a model.
 */

import { plainText } from "../lab-builder/plain-text.js";
import { findLabStepLeaks } from "../lab-builder/training-guard.js";

export const GUARD_VERSION = 1;

const URL_RE = /https?:\/\/[^\s<>"'`)\]]+/gi;
const FENCE_RE = /```/;
const HEADING_RE = /^\s{0,3}#{1,6}\s/m;
const LIST_MARK_RE = /^\s*(?:[-*\u2022]|\d{1,2}[.)])\s+/m;
const HTML_RE = /<\/?[a-z][^>]*>/i;
const IMAGE_RE = /!\[[^\]]*\]\([^)]*\)/;
const LINK_RE = /\[[^\]]+\]\([^)]*\)/g;
const SCRIPT_RE = /javascript:|data:text\/html/i;
const PLACEHOLDER_WORD_RE = /\b(?:TODO|TBD|FIXME|XXX|lorem ipsum)\b/i;
// Meta-talk about the task ("Sure, here is the reworded text:"). A presenter's own line may open with "Here's what happens"
// or "Here are the words you'll hear", so "here" and "below" count as chatter only when they point at the text itself.
const CHATTER_RE = /^\s*(?:sure|certainly|of course|okay|ok|as requested)\b/i;
const CHATTER_HERE_RE = /^\s*(?:here(?:'s| is| are)|below (?:is|are))\s+(?:the |your |a |an |my |these |those |some |one )?(?:(?:quick|short|simple|clean|clear|plain|better|improved|polished)\s+)?(?:(?:re)?word(?:ed|ing)|rewrit(?:e|ten)|re-?written|rework(?:ed)?|revis(?:ed|ion)|updated|improved|edited|polished|rephrased|simplified|clearer|new|final|draft|json|text|version|passages?|slides?|notes?|answers?|output|result|response|reply)\b/i;
const REFUSAL_RE = /\b(?:as an ai|language model|i(?:'m| am) (?:sorry|unable)|i can(?:'|no)t (?:help|assist|comply)|i cannot (?:help|assist|comply|provide))\b/i;
const INJECTION_RE = /\b(?:ignore (?:all |any |the )?(?:previous|prior|above|earlier) (?:instructions|rules|messages)|disregard (?:the )?(?:previous|above|system)|system prompt|developer message|new instructions|you are now|jailbreak|<\/?untrusted)/i;

const CODE_PATTERNS = [
  /`([^`\n]{1,80})`/g,
  /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g,
  /\b[a-z]+(?:[A-Z][a-z0-9]+)+\b/g,
  /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g,
  /\b[\w-]+\.(?:json|csv|xlsx?|docx?|pptx?|pdf|txt|md|ya?ml|xml|html?|js|ts|ps1|zip|png|jpe?g|svg)\b/gi,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  /\{\{[^}\n]+\}\}|%[A-Za-z_][A-Za-z0-9_]*%/g,
  /(?:[A-Za-z]:)?(?:[\\/][\w.-]+){2,}/g,
];

const UK_TO_US = [
  [/\bcolour(s|ed|ing)?\b/gi, "color$1"],
  [/\bbehaviour(s)?\b/gi, "behavior$1"],
  [/\bfavour(s|ed|ing|ite|ites)?\b/gi, "favor$1"],
  [/\bcentre(s|d)?\b/gi, "center$1"],
  [/\bcatalogue(s|d)?\b/gi, "catalog$1"],
  [/\blicence(s)?\b/gi, "license$1"],
  [/\bprogramme(s)?\b/gi, "program$1"],
  [/\bgrey\b/gi, "gray"],
  [/\banalys(e|ed|es|ing)\b/gi, "analyz$1"],
  [/\b(organ|custom|recogn|priorit|summar|standard|optim|minim|maxim|util|final|initial|author|categor|synchron|normal|personal|visual|emphas|capital|digit|modern|special|real)is(e|ed|es|ing|ation|ations)\b/gi, "$1iz$2"],
];

/** "organise" becomes "organize": the common British spellings, as in qa.js and differences.js. */
export function toUsEnglish(text) {
  let out = String(text);
  for (const [pattern, replacement] of UK_TO_US) {
    out = out.replace(pattern, (...args) => {
      const match = args[0];
      const groups = args.slice(1, -2).filter((value) => typeof value === "string");
      const repl = replacement.replace(/\$(\d)/g, (_, n) => groups[Number(n) - 1] ?? "");
      return /^[A-Z]/.test(match) ? repl[0].toUpperCase() + repl.slice(1) : repl;
    });
  }
  return out;
}

function normalizeNumber(raw) {
  return raw.replace(/,/g, "");
}

function collect(text, patterns, { group = 0 } = {}) {
  const found = new Set();
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const value = (match[group] ?? match[0]).trim();
      if (value) found.add(value);
    }
  }
  return found;
}

/**
 * The tokens a block must keep and may not add.
 * @param {string} text
 * @param {{ui?: string[], names?: string[]}} [lists] interface terms and product or connector names to look for
 */
export function protectedTokens(text, { ui = [], names = [] } = {}) {
  const source = String(text ?? "");
  const urls = new Set([...source.matchAll(URL_RE)].map((m) => m[0].replace(/[.,;:!?]+$/, "")));
  const withoutUrls = source.replace(URL_RE, " ");
  // A `code span` keeps its backticks: dropping them changes how a learner reads it.
  const code = collect(withoutUrls, CODE_PATTERNS.slice(0, 1));
  for (const token of collect(withoutUrls, CODE_PATTERNS.slice(1))) code.add(token);
  const stripped = withoutUrls.replace(/`[^`\n]*`/g, " ");
  const numbers = new Set([...stripped.matchAll(/(?<![\w.])\d[\d,]*(?:\.\d+)?%?/g)].map((m) => normalizeNumber(m[0])));
  // Bold and quoted terms keep their marks: a step that loses the bold on a button name has changed.
  const interfaceTerms = new Set();
  for (const m of withoutUrls.matchAll(/\*\*([^*\n]{1,80})\*\*/g)) interfaceTerms.add(`**${m[1].trim()}**`);
  for (const m of withoutUrls.matchAll(/["\u201c][^"\u201d\n]{2,60}["\u201d]/g)) interfaceTerms.add(m[0]);
  for (const line of withoutUrls.split("\n")) {
    if (!/\s>\s/.test(line)) continue;
    for (const part of line.split(/\s>\s/)) {
      const cleaned = part.replace(/\*\*/g, "").replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9)]+$/g, "").trim();
      if (cleaned && cleaned.length <= 60) interfaceTerms.add(cleaned);
    }
  }
  for (const term of ui) if (term && source.includes(term)) interfaceTerms.add(term);
  const nameSet = new Set();
  const nameRe = nameRegex(names);
  if (nameRe) for (const m of source.matchAll(nameRe)) if (!isPlainWordUse(source, m)) nameSet.add(m[0]);
  return { urls, code, numbers, ui: interfaceTerms, names: nameSet };
}

const NAME_RE_CACHE = new WeakMap();

// Product names that are also ordinary English words. At the start of a sentence a capital letter says nothing, so "Teams keep
// answering the same questions" is the plain noun. The name counts there only when a word that belongs to the product follows
// ("Teams channel", "Excel workbook"); anywhere else in a sentence, a capital means the product.
const AMBIGUOUS_NAMES = new Set(["Teams", "Excel", "Outlook"]);
const PRODUCT_CONTEXT_RE = /^\s+(?:app|apps|application|channel|channels|chat|chats|message|messages|meeting|meetings|bot|bots|connector|connectors|tab|tabs|post|posts|notification|notifications|integration|integrations|admin|users?|team\b|workbook|workbooks|spreadsheet|spreadsheets|sheet|sheets|file|files|add-in|add-ins|calendar|inbox|mailbox|email|emails|mail|rule|rules|for\s+(?:web|mobile|desktop|Microsoft)|on\s+(?:the\s+)?(?:web|mobile|desktop))/i;
const SENTENCE_START_RE = /(?:^|[.!?]["'\u201d)\]]*\s+|\n\s*(?:[-*\u2022]\s+|\d{1,2}[.)]\s+)?)$/;

function isPlainWordUse(text, match) {
  if (!AMBIGUOUS_NAMES.has(match[0])) return false;
  if (!SENTENCE_START_RE.test(text.slice(0, match.index))) return false;
  return !PRODUCT_CONTEXT_RE.test(text.slice(match.index + match[0].length, match.index + match[0].length + 40));
}

/** One regular expression for a whole list of names, longest first, so "Power Automate" wins over "Power". */
function nameRegex(names) {
  if (!Array.isArray(names) || !names.length) return null;
  let cached = NAME_RE_CACHE.get(names);
  if (cached === undefined) {
    const alternatives = [...new Set(names.filter(Boolean))]
      .sort((a, b) => b.length - a.length)
      .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    cached = alternatives.length ? new RegExp(`(?<![A-Za-z0-9])(?:${alternatives.join("|")})(?![A-Za-z0-9])`, "g") : null;
    NAME_RE_CACHE.set(names, cached);
  }
  return cached;
}

const KINDS = ["urls", "code", "numbers", "ui", "names"];

function mergeTokens(...sets) {
  const merged = Object.fromEntries(KINDS.map((kind) => [kind, new Set()]));
  for (const tokens of sets) for (const kind of KINDS) for (const value of tokens[kind]) merged[kind].add(value);
  return merged;
}

function containsToken(kind, output, outputTokens, token) {
  if (kind === "numbers") return outputTokens.numbers.has(token);
  if (kind === "urls") return output.includes(token);
  return output.includes(token);
}

/** Names of the checks a pair of texts fails (empty when the answer is faithful). */
function compare(source, output, { ui, names, allowed }) {
  const sourceTokens = protectedTokens(source, { ui, names });
  const outputTokens = protectedTokens(output, { ui, names });
  const allowedTokens = allowed ? protectedTokens(allowed, { ui, names }) : null;
  const known = allowedTokens ? mergeTokens(sourceTokens, allowedTokens) : sourceTokens;
  for (const kind of KINDS) {
    for (const token of sourceTokens[kind]) {
      if (!containsToken(kind, output, outputTokens, token)) return { problem: "dropped", kind, token };
    }
    for (const token of outputTokens[kind]) {
      if (!known[kind].has(token)) return { problem: "invented", kind, token };
    }
  }
  return null;
}

function structuralProblem(source, output) {
  const flags = [
    [FENCE_RE, "code fence"],
    [HEADING_RE, "heading"],
    [HTML_RE, "html"],
    [IMAGE_RE, "image"],
    [SCRIPT_RE, "script link"],
    [PLACEHOLDER_WORD_RE, "placeholder word"],
    [CHATTER_RE, "chatter"],
    [CHATTER_HERE_RE, "chatter"],
    [REFUSAL_RE, "refusal"],
    [INJECTION_RE, "injection"],
  ];
  for (const [pattern, name] of flags) {
    if (pattern.test(output) && !pattern.test(source)) return name;
  }
  if (LIST_MARK_RE.test(output) && !LIST_MARK_RE.test(source)) return "list marker";
  const sourceLinks = new Set(source.match(LINK_RE) || []);
  for (const link of output.match(LINK_RE) || []) if (!sourceLinks.has(link)) return "new link";
  return null;
}

/** Length bounds as a share of the source, by kind of block. A block may also carry its own `limits`. */
export const LENGTH_LIMITS = Object.freeze({
  overview: { min: 0.35, max: 2.6, floor: 60 },
  why: { min: 0.4, max: 2.4, floor: 40 },
  scenario: { min: 0.4, max: 2.4, floor: 60 },
  step: { min: 0.5, max: 1.8, floor: 6 },
  concept: { min: 0.4, max: 2, floor: 12 },
  trouble: { min: 0.4, max: 2, floor: 10 },
  slide: { min: 0.4, max: 1.25, floor: 8 },
  note: { min: 0.4, max: 2, floor: 8 },
});

function cleanOutput(text, { multiline }) {
  let out = toUsEnglish(plainText(String(text ?? "")));
  out = out.replace(/\r\n?/g, "\n");
  out = multiline ? out.split("\n").map((line) => line.replace(/[ \t]+$/g, "")).join("\n").trim() : out.replace(/\s*\n\s*/g, " ").replace(/[ \t]{2,}/g, " ").trim();
  return out;
}

function markerOf(line) {
  const m = /^(\s*)(?:(\d+[.)]|[a-z][.)]|[-*]))\s/.exec(line);
  return m ? `${m[1].length}:${m[2]}` : "";
}

/**
 * Check one piece of text against its source.
 *
 * @param {object} block
 * @param {string} block.kind  overview, why, scenario, step, concept, trouble, slide or note
 * @param {string} block.source  the deterministic text
 * @param {string} [block.allowed]  other text the writer may draw numbers and names from (the scenario the person typed)
 * @param {string[]} [block.ui]  interface terms to keep
 * @param {string[]} [block.names]  product and connector names (none may be added)
 * @param {boolean} [block.deck]  the text goes on a training slide, which may not read like a lab step
 * @param {number} [block.maxChars]  the slide's room for this text
 * @param {boolean} [block.multiline]  a step with sub-steps keeps its lines
 * @param {string} output  what the model wrote
 * @param {{maxOutputChars?: number}} [options]
 * @returns {{ok: true, text: string} | {ok: false, reason: string}}
 */
export function checkText(block, output, { maxOutputChars = 12000 } = {}) {
  if (typeof output !== "string") return { ok: false, reason: "not-text" };
  if (output.length > maxOutputChars) return { ok: false, reason: "too-long" };
  const source = String(block.source ?? "");
  const multiline = Boolean(block.multiline) || source.includes("\n");
  const text = cleanOutput(output, { multiline });
  if (!text) return { ok: false, reason: "empty" };

  const limits = { ...(LENGTH_LIMITS[block.kind] || LENGTH_LIMITS.note), ...(block.limits || {}) };
  const length = text.length;
  if (length < Math.max(limits.floor, Math.floor(source.length * limits.min))) return { ok: false, reason: "too-short" };
  if (length > Math.ceil(source.length * limits.max) + 12) return { ok: false, reason: "too-long" };
  if (block.maxChars && length > block.maxChars) return { ok: false, reason: "does-not-fit" };

  const structural = structuralProblem(source, text);
  if (structural) return { ok: false, reason: `structure:${structural}` };

  if (multiline) {
    const sourceLines = source.split("\n");
    const outLines = text.split("\n");
    if (sourceLines.length !== outLines.length) return { ok: false, reason: "lines-changed" };
    for (let i = 0; i < sourceLines.length; i += 1) {
      if (markerOf(sourceLines[i]) !== markerOf(outLines[i])) return { ok: false, reason: "lines-changed" };
    }
  }

  const difference = compare(source, text, { ui: block.ui || [], names: block.names || [], allowed: block.allowed || "" });
  if (difference) return { ok: false, reason: `${difference.problem}:${difference.kind}`, token: difference.token };

  // A slide that says "pick a prompt agent" may say "Choose a prompt agent": the source already gave that advice, and "choose" and
  // "pick" mean the same thing here. Any other opening verb, and "Choose" where the source never advised choosing, still reads like
  // a lab step.
  const advises = /\b(?:pick|choose)\b/i.test(source);
  const forLeaks = advises ? text.replace(/(^|[.!?:]\s+)Choose\b/g, "$1Pick") : text;
  if (block.deck && findLabStepLeaks(forLeaks).length && !findLabStepLeaks(source).length) return { ok: false, reason: "reads-like-a-step" };
  return { ok: true, text };
}

/**
 * The plain kind of a guard reason, for counting rejections: schema (the answer was not the JSON asked for), missing (a
 * passage was not answered), dropped (a protected term was lost), added (one was invented), length, step-order (a list lost
 * its count, order or line structure), injection, chatter, markup (headings, lists, links, HTML), step-voice (a slide that read
 * like a lab step) or other.
 */
export function rejectionKind(reason) {
  const text = String(reason || "");
  if (/^(?:invalid-json|schema|not-text)$/.test(text)) return "schema";
  if (text === "missing") return "missing";
  if (text.startsWith("dropped")) return "dropped";
  if (text.startsWith("invented")) return "added";
  if (/^(?:too-short|too-long|does-not-fit|empty)$/.test(text)) return "length";
  if (/^(?:count-changed|lines-changed|duplicate-items|not-a-list)$/.test(text)) return "step-order";
  if (text === "structure:injection") return "injection";
  if (text === "structure:chatter" || text === "structure:refusal") return "chatter";
  if (text.startsWith("structure")) return "markup";
  if (text === "reads-like-a-step") return "step-voice";
  return "other";
}

/**
 * Check a list that must keep its length and order (the steps of a module). Every item is checked against the item in the
 * same place; one failure rejects the whole list, so a module never mixes two voices or loses a step.
 * @returns {{ok: true, items: string[]} | {ok: false, reason: string, index?: number}}
 */
export function checkList(block, outputs, options) {
  if (!Array.isArray(outputs)) return { ok: false, reason: "not-a-list" };
  const sources = block.sources;
  if (outputs.length !== sources.length) return { ok: false, reason: "count-changed" };
  const items = [];
  for (let i = 0; i < sources.length; i += 1) {
    const result = checkText({ ...block, kind: block.itemKind || block.kind, source: sources[i], limits: block.limits }, outputs[i], options);
    if (!result.ok) return { ok: false, reason: result.reason, index: i, token: result.token };
    items.push(result.text);
  }
  const seen = new Set();
  for (const item of items) {
    const key = item.toLowerCase();
    if (seen.has(key) && sources.length > 1) return { ok: false, reason: "duplicate-items" };
    seen.add(key);
  }
  return { ok: true, items };
}
