/**
 * Measures slide text before it is drawn, so a title, an eyebrow, or a subtitle can be laid out from one vertical
 * budget and never run into the text next to it.
 *
 * PowerPoint does not shrink or wrap text when it opens a file, so a long title only looks right if the builder
 * knew how many lines it needs. The width table below is Arial Bold (every letter's advance, in 1/1000 em), scaled
 * per typeface and padded a little, so the estimate is on the wide side: a title that is measured to fit does fit,
 * and a real renderer wraps it to the same number of lines or fewer. A line is as tall as the typeface's own line
 * height (Segoe UI is 1.33 em), not a flat 1.2.
 *
 * Pure functions only; nothing here reads a file or a deck.
 */

export const EMU_PER_POINT = 12700;
const EMU_PER_INCH = 914400;

/** The ellipsis added when a title has to be shortened. */
export const ELLIPSIS = "…";

// Arial Bold advance widths for U+0020 through U+007E, in 1/1000 em.
const ASCII_WIDTHS = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

const SPECIAL_WIDTHS = new Map([
  ["\u2014", 1000], ["\u2013", 556], ["\u2026", 1000], ["\u00b7", 333], ["\u2022", 350], ["\u2018", 278], ["\u2019", 278],
  ["\u201c", 500], ["\u201d", 500], ["\u00d7", 584], ["\u00a0", 278],
]);

const DEFAULT_WIDTH = 600;
const WIDE_WIDTH = 1000;

/**
 * Typeface factors against the Arial Bold table: `width` scales every advance, `line` is the line height in em.
 * An unknown typeface is measured as wide and tall, so it errs toward a smaller title, never toward an overlap.
 */
const FONT_FACTORS = [
  { match: /segoe ui semibold/i, width: 0.96, line: 1.33 },
  { match: /segoe ui/i, width: 1.0, line: 1.33 },
  { match: /arial|helvetica|liberation sans/i, width: 1.0, line: 1.15 },
  { match: /calibri|carlito/i, width: 0.94, line: 1.22 },
  { match: /verdana|tahoma|dejavu/i, width: 1.25, line: 1.22 },
  { match: /georgia/i, width: 1.12, line: 1.14 },
  { match: /times/i, width: 1.0, line: 1.15 },
];
const UNKNOWN_FONT = Object.freeze({ width: 1.22, line: 1.33 });

/** Extra width so the estimate stays on the wide side of what a renderer produces. */
const WIDTH_SAFETY = 1.05;

/** Regular text is narrower than bold; this keeps regular-weight estimates conservative without being as wide as bold. */
const REGULAR_WEIGHT = 0.95;

export function fontFactors(fontName) {
  const name = String(fontName || "");
  return FONT_FACTORS.find((f) => f.match.test(name)) || UNKNOWN_FONT;
}

function advance(char) {
  const code = char.codePointAt(0);
  if (code >= 32 && code <= 126) return ASCII_WIDTHS[code - 32];
  if (SPECIAL_WIDTHS.has(char)) return SPECIAL_WIDTHS.get(char);
  if (code >= 0x2e80) return WIDE_WIDTH;
  return DEFAULT_WIDTH;
}

/** Width of `text` on one line, in points. */
export function measureWidthPt(text, sizePt, fontName, { bold = true } = {}) {
  const { width } = fontFactors(fontName);
  let units = 0;
  for (const char of String(text ?? "")) units += advance(char);
  return (units / 1000) * sizePt * width * WIDTH_SAFETY * (bold ? 1 : REGULAR_WEIGHT);
}

/** Break `text` into the lines a box `widthEmu` wide would show. A word wider than a line is broken by character. */
export function wrapText(text, widthEmu, sizePt, fontName, { bold = true } = {}) {
  const limit = (widthEmu / EMU_PER_INCH) * 72;
  const width = (s) => measureWidthPt(s, sizePt, fontName, { bold });
  const lines = [];
  for (const paragraph of String(text ?? "").split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const joined = line ? `${line} ${word}` : word;
      if (width(joined) <= limit) {
        line = joined;
        continue;
      }
      if (line) {
        lines.push(line);
        line = "";
      }
      let rest = word;
      while (width(rest) > limit) {
        let cut = 1;
        while (cut < rest.length && width(rest.slice(0, cut + 1)) <= limit) cut += 1;
        lines.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      line = rest;
    }
    lines.push(line);
  }
  return lines.length ? lines : [""];
}

/** Height in EMU of `lineCount` lines at `sizePt`, with the paragraph's line spacing (100000 is single). */
export function linesHeightEmu(lineCount, sizePt, fontName, spacingPct = 100000) {
  const { line } = fontFactors(fontName);
  return Math.ceil(lineCount * sizePt * line * (spacingPct / 100000) * EMU_PER_POINT);
}

/** The visible text before the ellipsis never ends on a stray separator. */
function trimTail(text) {
  return text.replace(/[\s,;:.\-–—(&/]+$/, "");
}

/**
 * Shorten `text` until `fits(candidate)` is true: cut at a word boundary and add an ellipsis. A title written as
 * "<name> — <what this slide is>" keeps its tail, because the tail is what tells one slide from the next.
 */
export function shortenToFit(text, fits) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (fits(clean)) return clean;
  const split = clean.match(/^(.+?) — ([^—]{3,60})$/);
  const head = split ? split[1] : clean;
  const tail = split ? ` — ${split[2]}` : "";
  const words = head.split(" ");
  for (let n = words.length - 1; n >= 1; n -= 1) {
    const candidate = `${trimTail(words.slice(0, n).join(" "))}${ELLIPSIS}${tail}`;
    if (fits(candidate)) return candidate;
  }
  const firstWord = words[0] || "";
  for (let n = firstWord.length - 1; n >= 1; n -= 1) {
    const candidate = `${firstWord.slice(0, n)}${ELLIPSIS}${tail}`;
    if (fits(candidate)) return candidate;
  }
  return ELLIPSIS;
}

/**
 * Fit a heading to a box: the largest step whose lines fit `maxHeightEmu` wins; if even the smallest step does not
 * fit, the text is shortened at that step. The full text is always returned beside what is shown.
 *
 * @param {object} options
 * @param {string} options.text
 * @param {string} options.fontName
 * @param {number} options.widthEmu
 * @param {number} options.maxHeightEmu
 * @param {Array<{sizePt: number, spacingPct?: number, maxLines?: number}>} options.steps largest first
 * @param {boolean} [options.bold]
 * @returns {{text: string, fullText: string, sizePt: number, spacingPct: number, lines: string[], heightEmu: number, shortened: boolean, steppedDown: boolean}}
 */
export function fitHeading({ text, fontName, widthEmu, maxHeightEmu, steps, bold = true }) {
  const fullText = String(text ?? "").replace(/\s+/g, " ").trim();
  const measure = (candidate, step) => {
    const lines = wrapText(candidate, widthEmu, step.sizePt, fontName, { bold });
    const spacingPct = step.spacingPct ?? 95000;
    const heightEmu = linesHeightEmu(lines.length, step.sizePt, fontName, spacingPct);
    const fits = heightEmu <= maxHeightEmu && (!step.maxLines || lines.length <= step.maxLines);
    return { lines, heightEmu, spacingPct, fits };
  };
  for (let i = 0; i < steps.length; i += 1) {
    const m = measure(fullText, steps[i]);
    if (m.fits) return { text: fullText, fullText, sizePt: steps[i].sizePt, spacingPct: m.spacingPct, lines: m.lines, heightEmu: m.heightEmu, shortened: false, steppedDown: i > 0 };
  }
  const last = steps[steps.length - 1];
  const shown = shortenToFit(fullText, (candidate) => measure(candidate, last).fits);
  const m = measure(shown, last);
  return { text: shown, fullText, sizePt: last.sizePt, spacingPct: m.spacingPct, lines: m.lines, heightEmu: m.heightEmu, shortened: shown !== fullText, steppedDown: steps.length > 1 };
}

/** Fit text that must stay on one line (an eyebrow, a kicker): step the size down, then shorten. */
export function fitSingleLine({ text, fontName, widthEmu, sizes, bold = true }) {
  const steps = sizes.map((sizePt) => ({ sizePt, spacingPct: 100000, maxLines: 1 }));
  const maxHeightEmu = linesHeightEmu(1, Math.max(...sizes), fontName, 100000);
  return fitHeading({ text, fontName, widthEmu, maxHeightEmu, steps, bold });
}

/**
 * Height in EMU of a stack of paragraphs in a box `widthEmu` wide (insets already taken off). A paragraph is
 * `{text, sizePt, fontName, bold?, spacingPct?, spaceAfterPt?, spaceBeforePt?}`; the defaults match the deck builder's
 * (118% line spacing, 4 pt after).
 */
export function paragraphsHeightEmu(paragraphs, widthEmu) {
  let total = 0;
  for (const p of paragraphs) {
    const lines = wrapText(p.text, widthEmu, p.sizePt, p.fontName, { bold: Boolean(p.bold) }).length;
    total += linesHeightEmu(lines, p.sizePt, p.fontName, p.spacingPct ?? 118000);
    total += Math.round(((p.spaceAfterPt ?? 4) + (p.spaceBeforePt ?? 0)) * EMU_PER_POINT);
  }
  return total;
}
