/**
 * Plain text, no emoji.
 *
 * Labs, exports, decks and guides read as calm, professional documents. Emoji used as decoration, bullets or icons make
 * them look like a toy, so nothing the product makes carries one. This module is the single place that rule lives:
 *
 *   plainText(text)        a string with every emoji replaced by words or removed (Markdown by default, { html: true } for HTML)
 *   plainTextDeep(value)   the same for every string inside an object or array (a manifest, a plan, a topic)
 *   containsEmoji(text)    whether a string has one (the guard test and the inventory use the same definition)
 *
 * What it does with a symbol (the sense decides; the reader never loses a fact):
 *   - Status marks that stand alone (a table cell, a list item, "Enabled: <mark>") become a word: Yes, No, Partial,
 *     Not applicable. A mark that leads a sentence is dropped when the sentence already says it ("Supported", "Not
 *     available"); a cross in front of a sentence that does not say it becomes "No:".
 *   - Callout icons at the start of a line become the label that callouts already use: Tip:, Goal:, Try it:, Warning:,
 *     Important:, Note:. A line that already starts with its label keeps just the label. In a heading the icon is dropped.
 *   - Every other symbol is decoration and is removed, with the double space it leaves collapsed.
 *   - Code fences, inline code and URLs are never touched. A sentence keeps its meaning: nothing but the symbol changes.
 *
 * Kept on purpose (not emoji in practice): the legal marks (copyright, registered, trademark) and the checkbox glyphs of
 * the checklist tables, unless a variation selector asks for the colored emoji form. Arrows, bullets, the multiplication
 * sign, the ellipsis and dashes are not pictographs and are never touched.
 *
 * The call is idempotent: its output holds no emoji, so a second pass changes nothing. That is what lets older saved labs
 * be repaired on read without rewriting a file on disk.
 */

// The legal marks and the checkbox glyphs stay unless the colored form (variation selector 16) follows.
const KEPT_UNLESS_COLORED = "[\\u00A9\\u00AE\\u2122\\u2610-\\u2612]";
const PICTOGRAPH = `(?:(?!${KEPT_UNLESS_COLORED}(?!\\uFE0F))\\p{Extended_Pictographic})`;
// The plain check and cross glyphs are not pictographs, but they are the status marks emoji replace, so they count too.
const STATUS_GLYPH = "[\\u2713\\u2715\\u2717\\u2718]";
const UNIT =
  `(?:${PICTOGRAPH}(?:\\uFE0F|\\p{Emoji_Modifier})?|${STATUS_GLYPH}|\\p{Regional_Indicator}{2}|[0-9#*]\\uFE0F?\\u20E3)`;
const SEQUENCE_SOURCE = `${UNIT}(?:\\u200D${UNIT})*[\\u{E0020}-\\u{E007F}]*\\uFE0F?`;

const EMOJI_TEST = new RegExp(`${SEQUENCE_SOURCE}|\\uFE0F`, "u");
const EMOJI_GLOBAL_SOURCE = SEQUENCE_SOURCE;
const RUN_SOURCE = `${SEQUENCE_SOURCE}(?:[ \\t]*${SEQUENCE_SOURCE})*`;
const KEYCAP = /([0-9#*])\uFE0F?\u20E3/gu;
const STRAY_SELECTOR = /\uFE0F/g;

const SENTINEL = "\uE002";
const SENTINEL_END = "\uE003";
const mark = (word = "") => `${SENTINEL}${word}${SENTINEL_END}`;
const MASK_OPEN = "\uE000";
const MASK_CLOSE = "\uE001";

/**
 * Class of each symbol: what it means, so the right plain word replaces it. Anything not listed is decoration.
 * [code point, name, class]
 */
const SYMBOLS = [
  [0x2705, "white heavy check mark", "yes"],
  [0x2714, "heavy check mark", "yes"],
  [0x2713, "check mark", "yes"],
  [0x2611, "ballot box with check", "yes"],
  [0x1f7e2, "green circle", "yes"],
  [0x1f7e9, "green square", "yes"],
  [0x1f44d, "thumbs up", "yes"],
  [0x1f197, "OK button", "yes"],
  [0x274c, "cross mark", "no"],
  [0x274e, "cross mark button", "no"],
  [0x2716, "heavy multiplication x", "no"],
  [0x2715, "multiplication x", "no"],
  [0x2717, "ballot x", "no"],
  [0x2718, "heavy ballot x", "no"],
  [0x26d4, "no entry", "no"],
  [0x1f6ab, "prohibited", "no"],
  [0x1f534, "red circle", "no"],
  [0x1f7e5, "red square", "no"],
  [0x1f44e, "thumbs down", "no"],
  [0x1f7e1, "yellow circle", "partial"],
  [0x1f7e0, "orange circle", "partial"],
  [0x1f7e8, "yellow square", "partial"],
  [0x26a0, "warning sign", "warn"],
  [0x1f6a8, "rotating light", "warn"],
  [0x2757, "exclamation mark", "important"],
  [0x2755, "white exclamation mark", "important"],
  [0x203c, "double exclamation mark", "important"],
  [0x2049, "exclamation question mark", "important"],
  [0x1f4a1, "light bulb", "tip"],
  [0x1f3af, "direct hit (target)", "goal"],
  [0x1f9ea, "test tube", "try"],
  [0x1f4dd, "memo", "note"],
  [0x1f4cc, "pushpin", "note"],
  [0x1f4cd, "round pushpin", "note"],
  [0x2139, "information", "note"],
  [0x1f5d2, "spiral notepad", "note"],
  [0x2796, "heavy minus sign", "na"],
  [0x27a1, "right arrow", "arrow:\u2192"],
  [0x2b05, "left arrow", "arrow:\u2190"],
  [0x2b06, "up arrow", "arrow:\u2191"],
  [0x2b07, "down arrow", "arrow:\u2193"],
];

// Names for decorative symbols, for the inventory only. Everything else is reported by its code point.
const DECORATIVE_NAMES = {
  0x26a1: "lightning (zap)", 0x1f510: "locked with key", 0x1f916: "robot", 0x1f680: "rocket", 0x1f9ec: "DNA helix",
  0x1f4cb: "clipboard", 0x1f504: "counterclockwise arrows", 0x2699: "gear", 0x1f50c: "electric plug", 0x1f4c4: "page",
  0x1f4e6: "package", 0x1f5d1: "wastebasket", 0x1f5c2: "card index dividers", 0x1f4da: "books", 0x1f441: "eye",
  0x1f4e7: "e-mail", 0x2601: "cloud", 0x1f517: "link", 0x1f393: "graduation cap", 0x1f4ca: "bar chart", 0x1f9ed: "compass",
  0x1f5fa: "world map", 0x1f41b: "bug", 0x1f5a8: "printer", 0x1f4f8: "camera with flash", 0x1f511: "key", 0x2b50: "star",
  0x1f4c1: "folder", 0x23f3: "hourglass", 0x1f4c5: "calendar", 0x1f50d: "magnifying glass", 0x2197: "north east arrow",
  0x1f3a8: "palette", 0x1f4e5: "inbox tray", 0x1f4e2: "loudspeaker", 0x23f1: "stopwatch", 0x1f9e9: "puzzle piece",
  0x1f3ed: "factory", 0x1f3e2: "office building", 0x1f552: "clock", 0x23ed: "next track", 0x1f310: "globe", 0x1f527: "wrench",
  0x1f4be: "floppy disk", 0x1f6e1: "shield", 0x1f50e: "magnifying glass (right)", 0x1f433: "whale", 0x1f39a: "level slider",
  0x1f3f7: "label", 0x1f9f1: "brick", 0x1f4ac: "speech balloon", 0x1f4e1: "satellite antenna", 0x25b6: "play button",
  0x1f6cd: "shopping bags", 0x1f3e6: "bank", 0x1f3e5: "hospital", 0x1f91d: "handshake", 0x1f4c8: "chart increasing",
  0x1f4bc: "briefcase", 0x1f4e3: "megaphone", 0x1f3a7: "headphone", 0x2696: "balance scale", 0x1f4b0: "money bag",
  0x1f9d1: "person", 0x1f5a5: "desktop computer", 0x1f331: "seedling", 0x267f: "wheelchair", 0x26aa: "white circle",
  0x1f5c3: "card file box", 0x1f6e0: "hammer and wrench", 0x1f4ce: "paperclip", 0x2b1c: "white square",
  0x1f4d5: "closed book", 0x1f4d8: "blue book", 0x1f4f1: "mobile phone", 0x2795: "heavy plus sign", 0x1f4e8: "incoming envelope",
  0x2754: "white question mark", 0x1f4f7: "camera", 0x1f4d6: "open book", 0x1f4d0: "triangular ruler", 0x1f3c1: "chequered flag",
  0x1f389: "party popper", 0x2728: "sparkles", 0x1f525: "fire", 0x1f9e0: "brain",
};

const BY_CODE_POINT = new Map(SYMBOLS.map(([cp, name, cls]) => [cp, { name, cls }]));

const CLASS_WORDS = {
  yes: { alone: "Yes", lead: "" },
  no: { alone: "No", lead: "No:" },
  partial: { alone: "Partial", lead: "" },
  warn: { alone: "Partial", lead: "Warning:" },
  important: { alone: "Important", lead: "Important:" },
  tip: { alone: "Tip", lead: "Tip:" },
  goal: { alone: "Goal", lead: "Goal:" },
  try: { alone: "Try it", lead: "Try it:" },
  note: { alone: "Note", lead: "Note:" },
  na: { alone: "Not applicable", lead: "" },
  deco: { alone: "", lead: "" },
};

// A label the text already carries, so the symbol is dropped rather than doubled ("Tip: Tip: ...").
const LABEL_ALREADY_THERE = {
  tip: /^[\s*_]*(?:\w+\s+)?(?:tip|hint)\b/i,
  goal: /^[\s*_]*(?:goal|objective|aim|purpose)\b/i,
  try: /^[\s*_]*(?:try|test|exercise|lab|practice|hands-on)\b/i,
  warn: /^[\s*_]*(?:warning|caution|important|danger|careful|critical|note)\b/i,
  important: /^[\s*_]*(?:important|warning|caution|note|critical)\b/i,
  note: /^[\s*_]*(?:note|info|information|reminder|important)\b/i,
};

const NEGATIVE_START =
  /^[\s*_]*(?:not?\b|never\b|un[a-z]+|non[a-z-]*|disabled|blocked|deprecated|retired|removed|missing|fail[a-z]*|incorrect|wrong|avoid|don'?t|do not|cannot|can'?t|won'?t|isn'?t|aren'?t|without|none\b)/i;

function symbolInfo(symbol) {
  const first = symbol.codePointAt(0);
  const known = BY_CODE_POINT.get(first);
  // The checkbox with a check is a status mark only in its colored form; the bare glyph never reaches here.
  if (known) return { cp: first, name: known.name, cls: known.cls.split(":")[0], glyph: known.cls.split(":")[1] || "" };
  return {
    cp: first,
    name: DECORATIVE_NAMES[first] || `emoji U+${first.toString(16).toUpperCase().padStart(4, "0")}`,
    cls: "deco",
    glyph: "",
  };
}

/** The class that decides a run of symbols: the first one that is not decoration, else decoration. */
function runInfo(run) {
  const symbols = run.match(new RegExp(EMOJI_GLOBAL_SOURCE, "gu")) || [];
  const infos = symbols.map(symbolInfo);
  return infos.find((info) => info.cls !== "deco") || infos[0] || { cls: "deco", glyph: "" };
}

/** @returns {string[]} an iterable of { symbol, index } for every emoji sequence in the text */
export function emojiMatches(text) {
  const out = [];
  const pattern = new RegExp(EMOJI_GLOBAL_SOURCE, "gu");
  let match;
  while ((match = pattern.exec(String(text))) !== null) out.push({ symbol: match[0], index: match.index });
  return out;
}

const ESCAPES = /(?:\\u\{[0-9a-fA-F]{1,6}\}|\\u[0-9a-fA-F]{4}|&#x[0-9a-fA-F]{2,6};|&#\d{2,7};|(?:%[0-9a-fA-F]{2}){3,4})+/g;

// A run of %XX bytes (a symbol inside a data: URI) decodes as UTF-8; anything that is not valid UTF-8 is left alone.
function decodePercent(run) {
  return run.replace(/(?:%[0-9a-fA-F]{2})+/g, (bytes) => {
    try {
      return decodeURIComponent(bytes);
    } catch {
      return bytes;
    }
  });
}

function decodeEscapes(run) {
  return decodePercent(run).replace(/\\u\{([0-9a-fA-F]{1,6})\}|\\u([0-9a-fA-F]{4})|&#x([0-9a-fA-F]{2,6});|&#(\d{2,7});/g, (_, braced, four, hex, dec) => {
    const code = braced ? parseInt(braced, 16) : four ? parseInt(four, 16) : hex ? parseInt(hex, 16) : parseInt(dec, 10);
    try {
      return String.fromCodePoint(code);
    } catch {
      return "";
    }
  });
}

/**
 * Emoji written as an escape in source text (a \u escape, a surrogate pair, or an HTML entity), which a plain search for the
 * symbol does not find. Returns [{ symbol, index }] where symbol is the decoded emoji and index is where the escape starts.
 */
export function escapedEmojiMatches(text) {
  const out = [];
  const source = String(text);
  let run;
  ESCAPES.lastIndex = 0;
  while ((run = ESCAPES.exec(source)) !== null) {
    for (const found of emojiMatches(decodeEscapes(run[0]))) out.push({ symbol: found.symbol, index: run.index });
  }
  return out;
}

export function containsEmoji(text) {
  return typeof text === "string" && EMOJI_TEST.test(text);
}

/** What the symbol becomes, for the inventory: its name and the plain-text replacement. */
export function symbolSuggestion(symbol) {
  const info = symbolInfo(symbol);
  const words = {
    yes: "a status word (Yes, Done, Ready, Passed) or removed",
    no: "No, Failed or Not done (No: before a sentence)",
    partial: "Partial",
    warn: "Warning: or Caution: (Partial alone in a table cell)",
    important: "Important:",
    tip: "Tip:",
    goal: "Goal:",
    try: "Try it: or Test:",
    note: "Note:",
    na: "Not applicable",
    arrow: `plain arrow ${info.glyph}`,
    deco: "removed",
  }[info.cls === "deco" || !info.glyph ? info.cls : "arrow"];
  return { name: info.name, words };
}

function fenceMarker(line) {
  const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  return match ? { char: match[1][0], length: match[1].length } : null;
}

// Inline code, link targets, and bare URLs are masked while a line is rewritten, then put back untouched.
const INLINE_PROTECTED = /(`+)[^\n]*?\1|(?<=\])\([^)\n]*\)|<https?:[^>\n]*>|\bhttps?:\/\/[^\s<>"'`)\]]+/g;
// JavaScript templates use backticks for text and HTML marks code with tags, so only links are protected there.
const LINKS_ONLY = /(?<=\])\([^)\n]*\)|<https?:[^>\n]*>|\bhttps?:\/\/[^\s<>"'`)\]]+/g;

function rewriteLine(line, html, labels, source) {
  const stash = [];
  let work = line.replace(source || html ? LINKS_ONLY : INLINE_PROTECTED, (whole) => {
    stash.push(whole);
    return `${MASK_OPEN}${stash.length - 1}${MASK_CLOSE}`;
  });
  work = work.replace(KEYCAP, "$1");
  const runPattern = new RegExp(RUN_SOURCE, "gu");
  let touched = false;
  work = work.replace(runPattern, (run, offset, whole) => {
    touched = true;
    const before = whole.slice(0, offset);
    const after = whole.slice(offset + run.length);
    const info = runInfo(run);
    const words = CLASS_WORDS[info.cls] || CLASS_WORDS.deco;
    const lead = html
      ? /(?:>|^)\s*$/.test(before)
      : /(?:^|\|)\s*(?:>\s*)*(?:(?:[-*+]|\d+[.)])\s+)?(?:#{1,6}\s+)?(?:(?:\*\*|__|\*|_)\s*)?$/.test(before);
    const heading = html ? /<h[1-6][^>]*>\s*(?:<[^>]+>\s*)*$/i.test(before) : /^\s*#{1,6}\s+/.test(before);
    const afterColon = /:\s*(?:\*\*|__)?$/.test(before);
    const closes = /^\s*(?:\*\*|__|\*|_)?\s*(?:\||$|[.,;)]|<\/)/.test(after);
    if (info.glyph) return arrowResult(info.glyph, before, after);
    if (!labels) return mark();
    if ((lead || afterColon) && closes && !heading && words.alone) return mark(words.alone);
    if (lead && !heading && words.lead) {
      const already = LABEL_ALREADY_THERE[info.cls];
      if (already && already.test(after.replace(/^\s+/, ""))) return mark();
      if (info.cls === "no" && NEGATIVE_START.test(after.replace(/^\s+/, ""))) return mark();
      return mark(words.lead);
    }
    return mark();
  });
  if (touched) work = squeeze(work);
  work = work.replace(STRAY_SELECTOR, "");
  return work.replace(new RegExp(`${MASK_OPEN}(\\d+)${MASK_CLOSE}`, "g"), (_, index) => stash[Number(index)]);
}

function arrowResult(glyph, before, after) {
  const left = before && !/\s$/.test(before) ? " " : "";
  const right = after && !/^\s/.test(after) ? " " : "";
  return `${left}${glyph}${right}`;
}

// Take the symbol out together with the space it leaves behind, without disturbing indentation, emphasis marks or table pipes.
function squeeze(line) {
  return line.replace(/([ \t]*)\uE002([^\uE003]*)\uE003([ \t]*)/g, (match, leftSpace, word, rightSpace, offset, whole) => {
    const before = whole.slice(0, offset);
    const after = whole.slice(offset + match.length);
    const opening = /[>"'`(\[{*_|]$/.test(before);
    if (!before.trim()) {
      // At the start of the content: keep the indentation, then the word (if any) and the text that follows.
      return word ? `${leftSpace}${word}${after.trim() ? " " : ""}` : leftSpace;
    }
    if (word) {
      const lead = leftSpace || (opening ? "" : " ");
      return `${lead}${word}${after.trim() && !/^<\//.test(after.trimStart()) ? " " : ""}`;
    }
    if (!after.trim() || /^[,.;:!?)\]}]/.test(after) || /^<\//.test(after)) return "";
    if (!leftSpace && opening) return "";
    return leftSpace || rightSpace ? " " : "";
  });
}
function rewrite(text, html, labels, source) {
  const lines = text.split(/(\r?\n)/);
  const out = [];
  let fence = null;
  for (let index = 0; index < lines.length; index += 2) {
    const line = lines[index];
    const marker = html ? null : fenceMarker(line);
    if (fence) {
      if (marker && marker.char === fence.char && marker.length >= fence.length && /^ {0,3}[`~]+\s*$/.test(line)) fence = null;
      out.push(line);
    } else if (marker) {
      fence = marker;
      out.push(line);
    } else {
      out.push(containsEmoji(line) ? rewriteLine(line, html, labels, source) : line);
    }
    if (lines[index + 1] !== undefined) out.push(lines[index + 1]);
  }
  return out.join("");
}

const HTML_RAW_BLOCKS = /<(pre|code|script|style)\b[\s\S]*?<\/\1>/gi;

/**
 * @param {string} text Markdown (default) or HTML ({ html: true })
 * @param {{ html?: boolean, labels?: boolean, source?: boolean }} options `labels: false` only removes symbols (no Yes, No or Tip: words);
 *   `source: true` treats backticks as text (JavaScript templates), which only a one-off cleanup of source files needs

 * @returns {string} the text with every emoji replaced by words or removed; anything that is not a string is returned as is
 */
export function plainText(text, { html = false, labels = true, source = false } = {}) {
  if (typeof text !== "string" || !containsEmoji(text)) return text;
  if (!html) return rewrite(text, false, labels, source);
  const raw = [];
  const masked = text.replace(HTML_RAW_BLOCKS, (block) => {
    raw.push(block);
    return `${MASK_OPEN}raw${raw.length - 1}${MASK_CLOSE}`;
  });
  return rewrite(masked, true, labels, source).replace(new RegExp(`${MASK_OPEN}raw(\\d+)${MASK_CLOSE}`, "g"), (_, index) => raw[Number(index)]);
}

/** plainText for every string in a value (arrays and plain objects are copied; keys are left alone). */
export function plainTextDeep(value, options) {
  if (typeof value === "string") return plainText(value, options);
  if (Array.isArray(value)) return value.map((item) => plainTextDeep(item, options));
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plainTextDeep(item, options)]));
  }
  return value;
}
