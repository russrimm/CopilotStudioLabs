/**
 * Draws the pre-lab training decks (see training-slides.js) as PowerPoint files, on the same deck assembler,
 * theme, brand profile, speaker-notes parts, and package code as every other deck the portal makes.
 *
 * Design rules (calm, clear, trustworthy): one idea per slide, large type (nothing in the body under 16 pt, titles
 * 30 pt), one accent color (the brand's), flat shapes with no gradients, no side stripes, no boxes inside boxes,
 * generous whitespace, a real title on every slide, shapes in reading order (title, content, then footer),
 * a text description on every diagram, and a fit check on every text box so nothing overflows.
 */

import {
  COLORS,
  PptxDeckAssembler,
  SLIDE_CX,
  SLIDE_CY,
  blendHex,
  normalizeHexColor,
  xmlEscape,
} from "./pptx-builder.js";
import { plainText } from "./training-text.js";
import { loadTrainingLibrary } from "./training-library.js";

const MARGIN = 640080;
const CONTENT_W = SLIDE_CX - MARGIN * 2;
const TOP = 1580000;
const BOTTOM = 6300000;
const FOOTER_Y = SLIDE_CY - 365760;
const MIN_BODY_PT = 16;
const LINE_SPACING = 105000;
const EMU_PER_INCH = 914400;

/** Relative luminance of a hex color, 0 (black) to 1 (white). */
function luminance(hex) {
  const h = normalizeHexColor(hex);
  const channel = (offset) => {
    const v = Number.parseInt(h.slice(offset, offset + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

/** WCAG contrast ratio between two colors. */
export function contrastRatio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Darken `hex` toward the deck's ink until it reads on `background` at 4.5:1 or better. */
function readableOn(hex, background = "FFFFFF") {
  let color = normalizeHexColor(hex);
  for (let i = 0; i < 10 && contrastRatio(color, background) < 4.5; i += 1) color = blendHex(color, COLORS.ink, 0.2);
  return color;
}

/** Text color for a filled shape: white when the fill allows it, otherwise the ink. */
function onFill(fill) {
  return contrastRatio(fill, "FFFFFF") >= 4.5 ? "FFFFFF" : COLORS.ink;
}

// ── Fit estimate ──────────────────────────────────────────────────────────────

/** How many lines `text` needs in a box `widthEmu` wide at `pt`. A conservative word-wrap estimate. */
export function estimateLines(text, widthEmu, pt, bold = false) {
  const perChar = pt * (bold ? 0.56 : 0.52);
  const charsPerLine = Math.max(4, Math.floor(((widthEmu / EMU_PER_INCH) * 72) / perChar));
  let lines = 0;
  for (const paragraph of String(text || "").split("\n")) {
    let current = 0;
    let used = 1;
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const need = word.length + (current ? 1 : 0);
      if (current + need > charsPerLine && current) {
        used += 1;
        current = word.length;
      } else {
        current += need;
      }
    }
    lines += used;
  }
  return Math.max(1, lines);
}

/** Estimated height in EMU of paragraphs in a box. */
export function estimateHeight(paragraphs, widthEmu, insets = { l: 0, t: 0, r: 0, b: 0 }) {
  const inner = widthEmu - (insets.l || 0) - (insets.r || 0);
  let pts = 0;
  for (const p of paragraphs) {
    const size = p.sizePt || 18;
    const text = p.text ?? p.markdown ?? (Array.isArray(p.runs) ? p.runs.map((r) => r.text || "").join("") : "");
    const indent = p.bulletChar ? 251460 : 0;
    const lines = estimateLines(plainText(text).replace(/\s+/g, " "), inner - indent, size, Boolean(p.bold));
    pts += lines * size * 1.2 * (LINE_SPACING / 100000) + (p.spaceAfterPt ?? 4) + (p.spaceBeforePt || 0);
  }
  return Math.round(pts * 12700) + (insets.t || 0) + (insets.b || 0);
}

/** Shrink text (down to `minPt`) until it fits the box. Returns the paragraphs and whether they fit. */
function fitParagraphs(paragraphs, widthEmu, heightEmu, insets, minPt = MIN_BODY_PT) {
  let scaled = paragraphs;
  for (let step = 0; step <= 8; step += 1) {
    scaled = paragraphs.map((p) => ({ ...p, sizePt: Math.max(Math.min(p.sizePt || 18, minPt), (p.sizePt || 18) - step) }));
    if (estimateHeight(scaled, widthEmu, insets) <= heightEmu) return { paragraphs: scaled, fits: true };
  }
  return { paragraphs: scaled, fits: false };
}

// ── Assembler with a real title placeholder ──────────────────────────────────

const TITLE_PLACEHOLDER_TEXT = "Click to edit Master title style";

class TrainingDeckAssembler extends PptxDeckAssembler {
  renderSlideMasterXml() {
    return super.renderSlideMasterXml().replace(
      /(<\/p:grpSpPr>)(\s*<\/p:spTree>)/,
      `$1
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Title Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="${MARGIN}" y="520000"/><a:ext cx="${CONTENT_W}" cy="840000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
        <p:txBody><a:bodyPr vert="horz" lIns="0" tIns="0" rIns="0" bIns="0" rtlCol="0" anchor="b"><a:normAutofit/></a:bodyPr><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>${TITLE_PLACEHOLDER_TEXT}</a:t></a:r><a:endParaRPr lang="en-US"/></a:p></p:txBody>
      </p:sp>$2`,
    );
  }

  renderSlideLayoutXml() {
    return super.renderSlideLayoutXml()
      .replace('type="blank"', 'type="titleOnly"')
      .replace('<p:cSld name="Blank">', '<p:cSld name="Title Only">')
      .replace(
        /(<\/p:grpSpPr>)(\s*<\/p:spTree>)/,
        `$1
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
        <p:spPr/>
        <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>${TITLE_PLACEHOLDER_TEXT}</a:t></a:r><a:endParaRPr lang="en-US"/></a:p></p:txBody>
      </p:sp>$2`,
      );
  }
}

// ── Drawing context ──────────────────────────────────────────────────────────

class Painter {
  constructor(deck, slide, report, label) {
    this.deck = deck;
    this.slide = slide;
    this.report = report;
    this.label = label;
    this.primary = deck.primaryHex;
    this.accentText = readableOn(deck.primaryHex);
    this.dark = deck.primaryDarkHex;
    this.tint = deck.primaryTintHex;
    this.border = deck.primaryBorderHex;
    this.heading = deck.brandFont || "Segoe UI Semibold";
  }

  p(text, sizePt, opts = {}) {
    return { text, sizePt, colorHex: COLORS.body, spaceAfterPt: 6, lineSpacingPct: LINE_SPACING, ...opts };
  }

  /** Add a text box that is fit-checked. */
  box(name, x, y, cx, cy, paragraphs, opts = {}) {
    const insets = opts.insets || { l: 0, t: 0, r: 0, b: 0 };
    const fit = fitParagraphs(paragraphs, cx, cy, insets, opts.minPt || MIN_BODY_PT);
    if (!fit.fits) this.report.push({ slide: this.label, shape: name, needed: estimateHeight(fit.paragraphs, cx, insets), have: cy });
    this.slide.addShape({
      name,
      x,
      y,
      cx,
      cy,
      geom: opts.geom || "rect",
      fillHex: opts.fillHex,
      borderHex: opts.borderHex,
      anchor: opts.anchor || "t",
      insets,
      paragraphs: fit.paragraphs,
    });
  }

  /** Raw shape XML for use inside a diagram group (fit-checked the same way). */
  shapeXml(name, x, y, cx, cy, paragraphs, opts = {}) {
    const insets = opts.insets || { l: 160000, t: 120000, r: 160000, b: 100000 };
    const fit = fitParagraphs(paragraphs, cx, cy, insets, opts.minPt || MIN_BODY_PT);
    if (!fit.fits) this.report.push({ slide: this.label, shape: name, needed: estimateHeight(fit.paragraphs, cx, insets), have: cy });
    return this.slide.renderShapeXml({
      name,
      x,
      y,
      cx,
      cy,
      geom: opts.geom || "roundRect",
      fillHex: opts.fillHex,
      borderHex: opts.borderHex,
      anchor: opts.anchor || "t",
      insets,
      paragraphs: fit.paragraphs,
    });
  }

  /** A group of shapes with one text description, so a screen reader announces the diagram once. */
  group(name, alt, bounds, children) {
    const id = this.slide.allocateShapeId();
    const { x, y, cx, cy } = bounds;
    this.slide.elementsXml.push(`<p:grpSp>
      <p:nvGrpSpPr>
        <p:cNvPr id="${id}" name="${xmlEscape(name)}" descr="${xmlEscape(alt)}"/>
        <p:cNvGrpSpPr/>
        <p:nvPr/>
      </p:nvGrpSpPr>
      <p:grpSpPr>
        <a:xfrm>
          <a:off x="${Math.round(x)}" y="${Math.round(y)}"/>
          <a:ext cx="${Math.round(cx)}" cy="${Math.round(cy)}"/>
          <a:chOff x="${Math.round(x)}" y="${Math.round(y)}"/>
          <a:chExt cx="${Math.round(cx)}" cy="${Math.round(cy)}"/>
        </a:xfrm>
      </p:grpSpPr>
      ${children.join("\n      ")}
    </p:grpSp>`);
  }

  arrowXml(name, x, y, cx, cy, fillHex) {
    return this.slide.renderShapeXml({ name, x, y, cx, cy, geom: "rightArrow", fillHex, paragraphs: [{ text: "", sizePt: 4 }], insets: { l: 0, t: 0, r: 0, b: 0 } });
  }
}

/** The title placeholder, in the slide's chrome so it is read first. */
function addTitle(slide, painter, text, { sizePt = 30, y = 480000, cy = 980000 } = {}) {
  const id = slide.allocateShapeId();
  const para = slide.renderParagraphXml({ text, sizePt, bold: true, colorHex: COLORS.ink, font: painter.heading, spaceAfterPt: 0, lineSpacingPct: 95000 });
  const needed = estimateHeight([{ text, sizePt, bold: true, spaceAfterPt: 0 }], CONTENT_W);
  if (needed > cy) painter.report.push({ slide: painter.label, shape: "Title", needed, have: cy });
  slide.chromeXml.push(`<p:sp>
      <p:nvSpPr>
        <p:cNvPr id="${id}" name="Title"/>
        <p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>
        <p:nvPr><p:ph type="title"/></p:nvPr>
      </p:nvSpPr>
      <p:spPr>
        <a:xfrm><a:off x="${MARGIN}" y="${y}"/><a:ext cx="${CONTENT_W}" cy="${cy}"/></a:xfrm>
      </p:spPr>
      <p:txBody>
        <a:bodyPr vert="horz" wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="b"><a:normAutofit/></a:bodyPr>
        <a:lstStyle/>
        ${para}
      </p:txBody>
    </p:sp>`);
}

function addChrome(slide, painter) {
  slide.chromeXml.push(
    slide.renderShapeXml({ name: "Brand Bar", x: 0, y: 0, cx: SLIDE_CX, cy: 91440, fillHex: painter.deck.primaryHex, paragraphs: [{ text: "", sizePt: 4 }], insets: { l: 0, t: 0, r: 0, b: 0 } }),
  );
  if (painter.deck.secondaryHex) {
    slide.chromeXml.push(
      slide.renderShapeXml({ name: "Brand Bar Secondary", x: 0, y: 91440, cx: SLIDE_CX, cy: 27432, fillHex: painter.deck.secondaryHex, paragraphs: [{ text: "", sizePt: 2 }], insets: { l: 0, t: 0, r: 0, b: 0 } }),
    );
  }
}

function addEyebrow(slide, painter, eyebrow) {
  if (!eyebrow) return;
  slide.chromeXml.push(
    slide.renderShapeXml({
      name: "Eyebrow",
      x: MARGIN,
      y: 250000,
      cx: CONTENT_W - 2200000,
      cy: 240000,
      paragraphs: [{ text: eyebrow, sizePt: 13, bold: true, colorHex: painter.accentText, font: painter.heading, spaceAfterPt: 0 }],
      insets: { l: 0, t: 0, r: 0, b: 0 },
    }),
  );
}

// ── Words strip ──────────────────────────────────────────────────────────────

/** Lay out the "word to know" line(s) at the foot of a slide. Returns where the content must end and a draw function. */
function wordsStrip(painter, words, library) {
  if (!words?.length) return { top: BOTTOM, draw() {} };
  const lines = words.length;
  const height = Math.round((lines * 14 * 1.26 + (lines > 1 ? 18 : 0) + 8) * 12700) + 120000;
  const y = FOOTER_Y - 60000 - height;
  return {
    top: y - 140000,
    draw() {
      const slide = painter.slide;
      slide.addShape({ name: "Words Divider", x: MARGIN, y: y - 40000, cx: CONTENT_W, cy: 12700, fillHex: COLORS.borderLight, paragraphs: [{ text: "", sizePt: 2 }], insets: { l: 0, t: 0, r: 0, b: 0 } });
      const paragraphs = [];
      if (lines > 1) paragraphs.push(painter.p("WORDS TO KNOW", 12, { bold: true, colorHex: COLORS.muted, spaceAfterPt: 2 }));
      words.forEach((id, index) => {
        const entry = library.terms[id];
        paragraphs.push({
          runs: [
            { text: `${lines === 1 ? "Word to know: " : ""}${entry.term}`, bold: true, colorHex: COLORS.ink, font: painter.heading },
            { text: ` — ${entry.plain}.`, colorHex: COLORS.body },
          ],
          sizePt: 14,
          spaceAfterPt: index === words.length - 1 ? 0 : 2,
          lineSpacingPct: LINE_SPACING,
        });
      });
      painter.box("Words to Know", MARGIN, y, CONTENT_W, height - 20000, paragraphs, { minPt: 12, insets: { l: 0, t: 40000, r: 0, b: 0 } });
    },
  };
}

// ── Slide kinds ──────────────────────────────────────────────────────────────

const DRAW = {
  title(p, slide, body, ctx) {
    const { deck } = p;
    let y = 1700000;
    p.box("Subtitle", MARGIN, y, CONTENT_W - 2200000, 520000, [p.p(body.subtitle || "", 20, { colorHex: COLORS.muted, spaceAfterPt: 0 })]);
    y += 600000;
    if (body.tags?.length) {
      p.box("Details", MARGIN, y, CONTENT_W, 380000, [p.p(body.tags.join("   ·   "), 18, { colorHex: COLORS.muted, spaceAfterPt: 0 })]);
      y += 560000;
    }
    p.box("Outcomes Heading", MARGIN, y + 160000, CONTENT_W, 420000, [p.p(body.outcomesHeading || "", 22, { bold: true, colorHex: p.accentText, font: p.heading, spaceAfterPt: 0 })]);
    const top = y + 660000;
    const bottom = ctx.bottom;
    p.box(
      "Outcomes",
      MARGIN,
      top,
      CONTENT_W,
      Math.max(900000, bottom - top),
      body.outcomes.map((o, i) => p.p(`${i + 1}.  ${o}`, 24, { spaceAfterPt: 10 })),
    );
    if (deck.logoMedia) {
      slide.addPicture({ media: deck.logoMedia, x: SLIDE_CX - MARGIN - 1700000, y: 250000, maxCx: 1700000, maxCy: 560000, alt: deck.organizationName ? `${deck.organizationName} logo` : "Organization logo" });
    }
  },

  scenario(p, slide, body, ctx) {
    const gap = 360000;
    const colW = Math.floor((CONTENT_W - gap) / 2);
    const contextH = Math.min(760000, estimateHeight([p.p(body.context, 20, { spaceAfterPt: 0 })], CONTENT_W) + 60000);
    const h = ctx.bottom - TOP - contextH - 160000;
    p.box("The Situation", MARGIN, TOP, colW, h, [p.p(body.situationHeading, 20, { bold: true, colorHex: p.accentText, font: p.heading }), p.p(body.situation, 24)], { insets: { l: 0, t: 0, r: 0, b: 0 } });
    const helpsParagraphs = body.helpsItems?.length
      ? body.helpsItems.map((t) => p.p(plainText(t), 22, { bulletChar: "•", bulletColorHex: p.primary, spaceAfterPt: 10 }))
      : [p.p(body.helps, 22)];
    p.box(
      "How It Helps",
      MARGIN + colW + gap,
      TOP,
      colW,
      h,
      [p.p(body.helpsHeading, 20, { bold: true, colorHex: p.dark, font: p.heading, spaceAfterPt: 10 }), ...helpsParagraphs],
      { fillHex: p.tint, borderHex: p.border, geom: "roundRect", insets: { l: 260000, t: 220000, r: 260000, b: 200000 } },
    );
    p.box("Lab Context", MARGIN, ctx.bottom - contextH, CONTENT_W, contextH, [p.p(body.context, 20, { colorHex: COLORS.muted, spaceAfterPt: 0 })]);
  },

  definition(p, slide, body, ctx) {
    let y = TOP;
    const pictureMin = 1100000;
    const extra = [];
    if (body.analogy) extra.push(p.p(body.analogy, 20, { italic: true, colorHex: COLORS.muted }));
    if (body.thisTopic) extra.push(p.p(body.thisTopic, 20));
    const extraH = extra.length ? Math.min(1500000, estimateHeight(extra, CONTENT_W) + 40000) : 0;
    const sentenceMax = Math.max(900000, ctx.bottom - TOP - extraH - (extraH ? 120000 : 0) - pictureMin - 120000);
    const sentenceNeed = estimateHeight([p.p(body.sentence, 28, { bold: true, spaceAfterPt: 0 })], CONTENT_W) + 60000;
    const sentenceH = Math.min(sentenceMax, Math.max(700000, sentenceNeed));
    p.box("Definition", MARGIN, y, CONTENT_W, sentenceH, [p.p(body.sentence, 28, { bold: true, colorHex: COLORS.ink, font: p.heading, spaceAfterPt: 0 })]);
    y += sentenceH + 80000;
    if (extra.length) {
      p.box("In This Topic", MARGIN, y, CONTENT_W, extraH, extra);
      y += extraH + 120000;
    }
    const pictureH = Math.min(1500000, ctx.bottom - y);
    if (pictureH >= 800000) {
      const boxW = 3300000;
      const arrowW = 640000;
      const gap = Math.floor((CONTENT_W - boxW * 3 - arrowW * 2) / 4);
      const x0 = MARGIN + gap;
      const py = ctx.bottom - pictureH;
      const items = [body.picture.left, body.picture.middle, body.picture.right];
      const children = [];
      items.forEach((label, i) => {
        const x = x0 + i * (boxW + arrowW + gap * 1.0);
        const middle = i === 1;
        children.push(
          p.shapeXml(`Picture Box ${i + 1}`, x, py, boxW, pictureH, [p.p(label, 22, { bold: true, align: "ctr", colorHex: middle ? onFill(p.primary) : COLORS.ink, font: p.heading, spaceAfterPt: 0 })], {
            fillHex: middle ? p.primary : p.tint,
            borderHex: middle ? p.primary : p.border,
            anchor: "ctr",
          }),
        );
        if (i < 2) children.push(p.arrowXml(`Picture Arrow ${i + 1}`, x + boxW + gap / 2, py + pictureH / 2 - 150000, arrowW, 300000, p.border));
      });
      p.group("Simple Picture", body.pictureAlt, { x: MARGIN, y: py, cx: CONTENT_W, cy: pictureH }, children);
    }
  },

  adds(p, slide, body, ctx) {
    p.box("Recall", MARGIN, TOP, CONTENT_W, 800000, [p.p(body.recall, 22, { colorHex: COLORS.muted })]);
    const top = TOP + 900000;
    p.box(
      "What This Adds",
      MARGIN,
      top,
      CONTENT_W,
      ctx.bottom - top,
      [p.p(body.heading, 22, { bold: true, colorHex: p.accentText, font: p.heading }), ...body.items.map((t) => p.p(t, 22, { bulletChar: "•", bulletColorHex: p.primary, spaceAfterPt: 8 }))],
    );
  },

  needToKnow(p, slide, body, ctx) {
    p.box("Intro", MARGIN, TOP, CONTENT_W, 420000, [p.p(body.intro, 20, { colorHex: COLORS.muted, spaceAfterPt: 0 })]);
    const top = TOP + 520000;
    const rowH = Math.floor((ctx.bottom - top) / Math.max(1, body.items.length));
    body.items.forEach((item, i) => {
      p.box(
        `Idea ${i + 1}`,
        MARGIN,
        top + i * rowH,
        CONTENT_W,
        rowH - 100000,
        [p.p(item.head, 22, { bold: true, colorHex: p.accentText, font: p.heading, spaceAfterPt: 2 }), p.p(item.text, 20, { spaceAfterPt: 0 })],
      );
    });
  },

  blocks(p, slide, body, ctx) {
    const nodes = body.nodes;
    const gap = 160000;
    // Six blocks read better as two rows of three than as six narrow columns.
    const perRow = nodes.length >= 6 ? 3 : nodes.length;
    const rows = Math.ceil(nodes.length / perRow);
    const w = Math.floor((CONTENT_W - gap * (perRow - 1)) / perRow);
    const labelPt = nodes.length > 4 && rows === 1 ? 20 : 22;
    const bodyPt = nodes.length > 4 && rows === 1 ? 16 : 18;
    const need = Math.max(...nodes.map((n) => estimateHeight([p.p(n.label, labelPt, { bold: true, spaceAfterPt: 8 }), p.p(plainText(n.plain), bodyPt, { spaceAfterPt: 0 })], w - 340000, { l: 0, t: 0, r: 0, b: 0 }) + 340000));
    const maxH = Math.floor((Math.min(rows === 1 ? 3600000 : 4560000, ctx.bottom - TOP - 200000) - gap * (rows - 1)) / rows);
    const h = Math.min(maxH, Math.max(1900000, need + 500000));
    const areaH = h * rows + gap * (rows - 1);
    const y = TOP + 120000;
    const children = nodes.map((n, i) =>
      p.shapeXml(
        `Building Block ${i + 1}`,
        MARGIN + (i % perRow) * (w + gap),
        y + Math.floor(i / perRow) * (h + gap),
        w,
        h,
        [p.p(n.label, labelPt, { bold: true, colorHex: p.dark, font: p.heading, spaceAfterPt: 8 }), p.p(plainText(n.plain), bodyPt, { spaceAfterPt: 0 })],
        { fillHex: p.tint, borderHex: p.border, insets: { l: 170000, t: 190000, r: 170000, b: 150000 } },
      ),
    );
    p.group("Building Blocks Diagram", slide.altText, { x: MARGIN, y, cx: CONTENT_W, cy: areaH }, children);
  },

  flow(p, slide, body, ctx) {
    const steps = body.steps;
    const perRow = steps.length > 4 ? Math.ceil(steps.length / 2) : steps.length;
    const rows = Math.ceil(steps.length / perRow);
    const arrowW = 260000;
    const gap = 140000;
    const w = Math.floor((CONTENT_W - (arrowW + gap * 2) * (perRow - 1)) / perRow);
    const rowGap = 220000;
    const maxH = Math.min(2400000, Math.floor((ctx.bottom - TOP - 140000 - rowGap * (rows - 1)) / rows));
    const need = Math.max(...steps.map((s) => estimateHeight([p.p(`0.  ${s.label}`, 20, { bold: true, spaceAfterPt: 8 }), p.p(plainText(s.plain), 16, { spaceAfterPt: 0 })], w - 300000) + 290000));
    const h = Math.min(maxH, Math.max(1500000, need + 400000));
    const flowH = h * rows + rowGap * (rows - 1);
    const children = [];
    steps.forEach((s, i) => {
      const row = Math.floor(i / perRow);
      const col = i % perRow;
      const x = MARGIN + col * (w + arrowW + gap * 2);
      const y = TOP + 120000 + row * (h + rowGap);
      children.push(
        p.shapeXml(
          `Step ${i + 1}`,
          x,
          y,
          w,
          h,
          [p.p(`${i + 1}.  ${s.label}`, 20, { bold: true, colorHex: p.dark, font: p.heading, spaceAfterPt: 8 }), p.p(plainText(s.plain), 16, { spaceAfterPt: 0 })],
          { fillHex: p.tint, borderHex: p.border, insets: { l: 150000, t: 170000, r: 150000, b: 120000 } },
        ),
      );
      if (col < perRow - 1 && i < steps.length - 1) children.push(p.arrowXml(`Arrow ${i + 1}`, x + w + gap, y + h / 2 - 140000, arrowW, 280000, p.border));
    });
    p.group("How It Works Diagram", slide.altText, { x: MARGIN, y: TOP + 120000, cx: CONTENT_W, cy: flowH }, children);
  },

  example(p, slide, body, ctx) {
    const arrowW = 560000;
    const gap = 200000;
    const colW = Math.floor((CONTENT_W - arrowW - gap * 2) / 2);
    const quoted = body.inputIsQuestion ? `“${body.input.replace(/^["“]|["”]$/g, "")}”` : body.input;
    const insetH = 390000;
    const needFor = (paragraphs) => estimateHeight(paragraphs, colW - 480000) + insetH;
    const wanted = Math.max(
      needFor([p.p(body.inputHeading, 18, { bold: true, spaceAfterPt: 6 }), p.p(quoted, 24, {})]),
      needFor([p.p(body.outputHeading, 18, { bold: true, spaceAfterPt: 6 }), p.p(body.output, 22)]),
    );
    const h = Math.min(ctx.bottom - TOP - (body.expect ? 900000 : 200000), Math.max(2200000, wanted + 300000));
    p.box(
      "What Starts It",
      MARGIN,
      TOP,
      colW,
      h,
      [p.p(body.inputHeading, 18, { bold: true, colorHex: p.accentText, font: p.heading }), p.p(quoted, 24, { italic: Boolean(body.inputIsQuestion), colorHex: COLORS.ink })],
      { fillHex: p.tint, borderHex: p.border, geom: "roundRect", insets: { l: 240000, t: 210000, r: 240000, b: 180000 } },
    );
    slide.elementsXml.push(p.arrowXml("Then", MARGIN + colW + gap, TOP + h / 2 - 160000, arrowW, 320000, p.border));
    p.box(
      "What You Get",
      MARGIN + colW + arrowW + gap * 2,
      TOP,
      colW,
      h,
      [p.p(body.outputHeading, 18, { bold: true, colorHex: p.accentText, font: p.heading }), p.p(body.output, 22)],
      { fillHex: COLORS.subtleBg, borderHex: COLORS.border, geom: "roundRect", insets: { l: 240000, t: 210000, r: 240000, b: 180000 } },
    );
    if (body.expect) p.box("In The Lab", MARGIN, TOP + h + 200000, CONTENT_W, 600000, [p.p(body.expect, 18, { colorHex: COLORS.muted, spaceAfterPt: 0 })]);
  },

  fit(p, slide, body, ctx) {
    const gap = 400000;
    const colW = Math.floor((CONTENT_W - gap) / 2);
    const h = ctx.bottom - TOP - 120000;
    const bullets = (items, color) => items.map((t) => p.p(plainText(t), 22, { bulletChar: "•", bulletColorHex: color, spaceAfterPt: 10 }));
    p.box("Good Fit", MARGIN, TOP, colW, h, [p.p(body.useHeading, 22, { bold: true, colorHex: p.accentText, font: p.heading, spaceAfterPt: 10 }), ...bullets(body.use, p.primary)]);
    p.box("Not A Fit", MARGIN + colW + gap, TOP, colW, h, [p.p(body.notHeading, 22, { bold: true, colorHex: COLORS.warnAccent, font: p.heading, spaceAfterPt: 10 }), ...bullets(body.not, COLORS.warnAccent)]);
  },

  know(p, slide, body, ctx) {
    const labelW = 2700000;
    const textW = CONTENT_W - labelW - 200000;
    const rows = body.items;
    const avail = ctx.bottom - TOP;
    const rowGap = 110000;
    // Use the largest text size at which every row fits, then place the rows one after another.
    let size = 20;
    const heightAt = (pt) => rows.map((r) => Math.max(420000, estimateHeight([p.p(r.text, pt, { spaceAfterPt: 0 })], textW) + 40000));
    while (size > MIN_BODY_PT && heightAt(size).reduce((a, b) => a + b, 0) + rowGap * (rows.length - 1) > avail) size -= 2;
    const heights = heightAt(size);
    let y = TOP;
    rows.forEach((item, i) => {
      if (i > 0) slide.addShape({ name: `Row Divider ${i}`, x: MARGIN, y: y - rowGap / 2, cx: CONTENT_W, cy: 12700, fillHex: COLORS.borderLight, paragraphs: [{ text: "", sizePt: 2 }], insets: { l: 0, t: 0, r: 0, b: 0 } });
      p.box(`${item.label} Label`, MARGIN, y, labelW, heights[i], [p.p(item.label, size, { bold: true, colorHex: item.confirmed ? p.accentText : COLORS.warnAccent, font: p.heading, spaceAfterPt: 0 })]);
      p.box(`${item.label} Text`, MARGIN + labelW + 200000, y, textW, heights[i], [p.p(item.text, size, { colorHex: item.confirmed ? COLORS.body : COLORS.warnAccent, spaceAfterPt: 0 })]);
      y += heights[i] + rowGap;
    });
  },

  terms(p, slide, body, ctx) {
    const items = body.items;
    const cols = items.length > 3 ? 2 : 1;
    const gap = 400000;
    const colW = Math.floor((CONTENT_W - gap * (cols - 1)) / cols);
    const perCol = Math.ceil(items.length / cols);
    const rowH = Math.floor((ctx.bottom - TOP) / Math.max(perCol, 1));
    items.forEach((item, i) => {
      const col = Math.floor(i / perCol);
      const row = i % perCol;
      p.box(`Term ${i + 1}`, MARGIN + col * (colW + gap), TOP + row * rowH, colW, rowH - 100000, [p.p(item.term, 22, { bold: true, colorHex: p.accentText, font: p.heading, spaceAfterPt: 2 }), p.p(`${item.plain}.`, 18, { spaceAfterPt: 0 })]);
    });
  },

  quiz(p, slide, body, ctx) {
    // One full-width row per question: the question, then its choices on one line, so every row stays short.
    // A row is as tall as its own text needs; spare room is shared out evenly.
    const qs = body.questions;
    const rowGap = 70000;
    const insets = { l: 220000, t: 90000, r: 220000, b: 70000 };
    const parts = qs.map((q, i) => [
      p.p(`${i + 1}.  ${q.q}`, 18, { bold: true, colorHex: COLORS.ink, font: p.heading, spaceAfterPt: 3 }),
      p.p(q.options.map((o, j) => `${["A", "B", "C", "D"][j]}.  ${o}`).join("     ·     "), 16, { spaceAfterPt: 0 }),
    ]);
    const needs = parts.map((paragraphs) => estimateHeight(paragraphs, CONTENT_W, insets) + 30000);
    const avail = ctx.bottom - TOP - rowGap * (qs.length - 1);
    const spare = Math.max(0, avail - needs.reduce((a, b) => a + b, 0));
    const heights = needs.map((need) => need + Math.min(160000, Math.floor(spare / qs.length)));
    let y = TOP;
    qs.forEach((q, i) => {
      p.box(`Question ${i + 1}`, MARGIN, y, CONTENT_W, heights[i], parts[i], { fillHex: p.tint, borderHex: p.border, geom: "roundRect", insets });
      y += heights[i] + rowGap;
    });
  },

  labPreview(p, slide, body, ctx) {
    p.box("Module", MARGIN, TOP, CONTENT_W, 620000, [p.p(body.moduleLabel, 30, { bold: true, colorHex: p.accentText, font: p.heading, spaceAfterPt: 0 })]);
    p.box("Time", MARGIN, TOP + 700000, CONTENT_W, 420000, [p.p(body.time, 20, { colorHex: COLORS.muted, spaceAfterPt: 0 })]);
    p.box("Outcome", MARGIN, TOP + 1300000, CONTENT_W, 1500000, [p.p(body.outcome, 26, { spaceAfterPt: 0 })]);
    p.box("Note", MARGIN, ctx.bottom - 560000, CONTENT_W, 520000, [p.p(body.note, 20, { colorHex: COLORS.muted, spaceAfterPt: 0 })]);
  },

  learn(p, slide, body, ctx) {
    p.box("Intro", MARGIN, TOP, CONTENT_W, 420000, [p.p(body.intro, 20, { colorHex: COLORS.muted, spaceAfterPt: 0 })]);
    const links = body.links || [];
    const top = TOP + 560000;
    const rowH = Math.min(900000, Math.floor((ctx.bottom - top) / Math.max(links.length, 1)));
    links.forEach((link, i) => {
      const shown = link.url.replace(/^https:\/\//, "");
      p.box(
        `Link ${i + 1}`,
        MARGIN,
        top + i * rowH,
        CONTENT_W,
        rowH - 60000,
        [p.p(`[${link.title.replace(/[[\]]/g, "")}](${link.url})`, 20, { spaceAfterPt: 2, markdown: `[${link.title.replace(/[[\]]/g, "")}](${link.url})`, text: undefined }), p.p(shown, 14, { colorHex: COLORS.muted, spaceAfterPt: 0 })],
        { minPt: 14 },
      );
    });
    if (!links.length) p.box("No Links", MARGIN, top, CONTENT_W, 500000, [p.p("Open Microsoft Learn and search for this topic.", 20)]);
  },

  what(p, slide, body, ctx) {
    p.box("What It Is", MARGIN, TOP, CONTENT_W, 1900000, [p.p(body.sentence, 28, { bold: true, colorHex: COLORS.ink, font: p.heading, spaceAfterPt: 0 })]);
    if (body.who) {
      const top = TOP + 2050000;
      p.box("Who Uses It", MARGIN, top, CONTENT_W, ctx.bottom - top, [p.p(body.whoHeading, 20, { bold: true, colorHex: p.accentText, font: p.heading }), p.p(body.who, 24, { spaceAfterPt: 0 })]);
    }
  },

  fitHub(p, slide, body, ctx) {
    const around = body.around;
    const h = ctx.bottom - TOP - 120000;
    const y0 = TOP + 120000;
    const perRow = Math.ceil(around.length / 2);
    const gap = 160000;
    const w = Math.floor((CONTENT_W - gap * (perRow - 1)) / perRow);
    const centerMin = 720000;
    const rowH = Math.min(1500000, Math.floor((h - 200000 - centerMin) / 2));
    const centerH = Math.max(centerMin, h - rowH * 2 - 200000);
    const children = [];
    const topRow = around.slice(0, perRow);
    const bottomRow = around.slice(perRow);
    topRow.forEach((n, i) => children.push(p.shapeXml(`Part ${i + 1}`, MARGIN + i * (w + gap), y0, w, rowH, [p.p(n.label, 18, { bold: true, colorHex: p.dark, font: p.heading, spaceAfterPt: 2 }), p.p(plainText(n.plain), 16, { spaceAfterPt: 0 })], { fillHex: p.tint, borderHex: p.border, minPt: 16, insets: { l: 140000, t: 90000, r: 140000, b: 60000 } })));
    const cy = y0 + rowH + 100000;
    const centerW = Math.min(CONTENT_W, 6200000);
    children.push(p.shapeXml("Center", MARGIN + Math.floor((CONTENT_W - centerW) / 2), cy, centerW, centerH, [p.p(body.center.label, 22, { bold: true, align: "ctr", colorHex: onFill(p.primary), font: p.heading, spaceAfterPt: 2 }), p.p(plainText(body.center.plain), 16, { align: "ctr", colorHex: onFill(p.primary), spaceAfterPt: 0 })], { fillHex: p.primary, borderHex: p.primary, anchor: "ctr", insets: { l: 200000, t: 70000, r: 200000, b: 70000 } }));
    bottomRow.forEach((n, i) => children.push(p.shapeXml(`Part ${perRow + i + 1}`, MARGIN + i * (w + gap), cy + centerH + 100000, w, rowH, [p.p(n.label, 18, { bold: true, colorHex: p.dark, font: p.heading, spaceAfterPt: 2 }), p.p(plainText(n.plain), 16, { spaceAfterPt: 0 })], { fillHex: p.tint, borderHex: p.border, minPt: 16, insets: { l: 140000, t: 90000, r: 140000, b: 60000 } })));
    p.group("How The Pieces Fit Diagram", slide.altText, { x: MARGIN, y: y0, cx: CONTENT_W, cy: h }, children);
  },

  vocab(p, slide, body, ctx) {
    DRAW.terms(p, slide, body, ctx);
  },

  where(p, slide, body, ctx) {
    const paragraphs = [];
    if (body.sentence) paragraphs.push(p.p(body.sentence, 26, { spaceAfterPt: 16 }));
    if (body.harness) paragraphs.push(p.p(body.harness, 22, { colorHex: p.accentText, bold: true, font: p.heading, spaceAfterPt: 0 }));
    p.box("Where", MARGIN, TOP, CONTENT_W, ctx.bottom - TOP - 760000, paragraphs);
    p.box("Where Note", MARGIN, ctx.bottom - 640000, CONTENT_W, 600000, [p.p(body.note, 20, { colorHex: COLORS.muted, spaceAfterPt: 0 })]);
  },

  day(p, slide, body, ctx) {
    p.box("Intro", MARGIN, TOP, CONTENT_W, 420000, [p.p(body.intro, 22, { colorHex: COLORS.muted, spaceAfterPt: 0 })]);
    const top = TOP + 560000;
    const rows = body.rows;
    const rowH = Math.min(560000, Math.floor((ctx.bottom - top - 700000) / Math.max(rows.length + 1, 1)));
    const colTrain = 2000000;
    const colHands = 2000000;
    const labelW = CONTENT_W - colTrain - colHands;
    p.box("Day Head Label", MARGIN, top, labelW, rowH, [p.p("Topic", 16, { bold: true, colorHex: COLORS.muted, spaceAfterPt: 0 })]);
    p.box("Day Head Training", MARGIN + labelW, top, colTrain, rowH, [p.p("Training", 16, { bold: true, colorHex: COLORS.muted, spaceAfterPt: 0 })]);
    p.box("Day Head Hands On", MARGIN + labelW + colTrain, top, colHands, rowH, [p.p("Hands-on", 16, { bold: true, colorHex: COLORS.muted, spaceAfterPt: 0 })]);
    rows.forEach((r, i) => {
      const y = top + (i + 1) * rowH;
      p.box(`Day Row ${i + 1}`, MARGIN, y, labelW - 100000, rowH, [p.p(r.label, 18, { spaceAfterPt: 0 })], { minPt: 16 });
      p.box(`Day Training ${i + 1}`, MARGIN + labelW, y, colTrain, rowH, [p.p(`${r.training} min`, 18, { spaceAfterPt: 0 })]);
      p.box(`Day Hands On ${i + 1}`, MARGIN + labelW + colTrain, y, colHands, rowH, [p.p(r.handsOn ? `${r.handsOn} min` : "see the lab", 18, { spaceAfterPt: 0 })]);
    });
    const y = top + (rows.length + 1) * rowH + (body.more ? rowH : 0);
    if (body.more) p.box("Day More", MARGIN, y - rowH, CONTENT_W, rowH, [p.p(`…and ${body.more}`, 16, { colorHex: COLORS.muted, spaceAfterPt: 0 })]);
    p.box("Day Totals", MARGIN, Math.min(y + 80000, ctx.bottom - 500000), CONTENT_W, 480000, [p.p(`Total: about ${body.totals.training} minutes of training, then about ${body.totals.handsOn} minutes hands-on.`, 20, { bold: true, colorHex: p.accentText, font: p.heading, spaceAfterPt: 0 })]);
  },

  agenda(p, slide, body, ctx) {
    const rows = body.rows;
    const cols = rows.length > 6 ? 2 : 1;
    const perCol = Math.ceil(rows.length / cols);
    const gap = 360000;
    const colW = Math.floor((CONTENT_W - gap * (cols - 1)) / cols);
    const top = TOP + (body.showTotal ? 520000 : 0);
    if (body.showTotal) p.box("Total", MARGIN, TOP, CONTENT_W, 460000, [p.p(`Training: about ${body.totalMinutes} minutes. Then the hands-on lab: about ${body.handsOnMinutes} minutes.`, 22, { bold: true, colorHex: p.accentText, font: p.heading, spaceAfterPt: 0 })]);
    const rowH = Math.min(560000, Math.floor((ctx.bottom - top) / perCol));
    rows.forEach((r, i) => {
      const col = Math.floor(i / perCol);
      const row = i % perCol;
      p.box(`Agenda ${r.n}`, MARGIN + col * (colW + gap), top + row * rowH, colW, rowH, [
        { runs: [{ text: `${r.n}.  ${r.label}`, colorHex: COLORS.body }, { text: `   ${r.minutes} min`, colorHex: COLORS.muted }], sizePt: 18, spaceAfterPt: 0, lineSpacingPct: LINE_SPACING },
      ], { minPt: 16 });
    });
  },

  /** "Same idea, different place": one column for each harness, side by side. */
  compare(p, slide, body, ctx) {
    p.box("Intro", MARGIN, TOP - 60000, CONTENT_W, 360000, [p.p(body.intro, 20, { colorHex: COLORS.muted, spaceAfterPt: 0 })]);
    const top = TOP + 320000;
    const gap = 300000;
    const colW = Math.floor((CONTENT_W - gap) / 2);
    const height = Math.max(1200000, ctx.bottom - top);
    body.columns.forEach((col, i) => {
      const paragraphs = [
        p.p(col.name, 20, { bold: true, colorHex: p.dark, font: p.heading, spaceAfterPt: 2 }),
        {
          runs: [
            { text: `Called "${col.term}"`, bold: true, colorHex: p.accentText, font: p.heading },
            { text: `   ${col.availability}`, bold: true, colorHex: COLORS.muted },
          ],
          sizePt: 20,
          spaceAfterPt: 8,
          lineSpacingPct: LINE_SPACING,
        },
        ...(col.summary ? [p.p(col.summary, 18, { spaceAfterPt: 6 })] : []),
        ...(col.where ? [p.p(`Where: ${col.where}`, 18, { spaceAfterPt: 6 })] : []),
        ...col.limits.map((limit) => p.p(limit, 16, { bulletChar: "•", bulletColorHex: p.primary, spaceAfterPt: 0 })),
      ];
      p.box(`Harness ${i + 1}`, MARGIN + i * (colW + gap), top, colW, height, paragraphs, {
        fillHex: p.tint,
        borderHex: p.border,
        geom: "roundRect",
        insets: { l: 200000, t: 120000, r: 200000, b: 100000 },
      });
    });
  },

  divider(p, slide, body, ctx) {
    const rows = body.rows;
    const windowed = rows.length > 12 ? rows.slice(Math.max(0, Math.min(body.current - 3, rows.length - 7)), Math.max(0, Math.min(body.current - 3, rows.length - 7)) + 7) : rows;
    const top = TOP + 120000;
    const rowH = Math.min(520000, Math.floor((ctx.bottom - top - 600000) / windowed.length));
    p.box("Section Time", MARGIN, TOP - 60000, CONTENT_W, 420000, [p.p(`This part takes about ${body.minutes} minutes. The whole training is about ${body.totalMinutes} minutes.`, 20, { colorHex: COLORS.muted, spaceAfterPt: 0 })]);
    windowed.forEach((r, i) => {
      const current = r.n - 1 === body.current;
      p.box(`Section ${r.n}`, MARGIN, top + 480000 + i * rowH, CONTENT_W, rowH, [
        { runs: [{ text: `${r.n}.  ${r.label}`, bold: current, colorHex: current ? p.accentText : COLORS.muted, font: current ? p.heading : undefined }, { text: `   ${r.minutes} min`, colorHex: COLORS.muted }], sizePt: current ? 22 : 18, spaceAfterPt: 0, lineSpacingPct: LINE_SPACING },
      ], { minPt: 16 });
    });
  },

  closing(p, slide, body, ctx) {
    p.box("Intro", MARGIN, TOP, CONTENT_W, 620000, [p.p(body.intro, 26, { bold: true, colorHex: COLORS.ink, font: p.heading, spaceAfterPt: 0 })]);
    const top = TOP + 760000;
    const rows = body.rows;
    const rowH = Math.min(440000, Math.floor((ctx.bottom - top - (body.more ? 440000 : 0)) / Math.max(rows.length, 1)));
    rows.forEach((r, i) => {
      p.box(`Lab Module ${i + 1}`, MARGIN, top + i * rowH, CONTENT_W, rowH, [
        { runs: [{ text: r.label, colorHex: COLORS.body }, { text: r.handsOn ? `   ${r.handsOn} min` : "", colorHex: COLORS.muted }], sizePt: 18, spaceAfterPt: 0, lineSpacingPct: LINE_SPACING },
      ], { minPt: 16 });
    });
    if (body.more) p.box("More", MARGIN, top + rows.length * rowH, CONTENT_W, 420000, [p.p(`…and ${body.more}`, 16, { colorHex: COLORS.muted, spaceAfterPt: 0 })]);
  },
};

/**
 * Render a deck spec (from training-slides.js) to a .pptx buffer.
 *
 * @param {object} spec deck spec
 * @param {{branding?: object, library: object, resolveImageBuffer?: Function}} options
 * @returns {{buffer: Buffer, overflow: Array<{slide: string, shape: string, needed: number, have: number}>}}
 */
export function renderTrainingDeck(spec, { branding, library = loadTrainingLibrary(), title } = {}) {
  const deck = new TrainingDeckAssembler({ title: title || spec.title, branding });
  const overflow = [];
  spec.slides.forEach((s, index) => {
    const label = `${index + 1}. ${s.title}`;
    const slide = deck.createSlide({ isHero: true, bgHex: "FFFFFF", footerLast: true, footerContext: spec.title });
    const painter = new Painter(deck, slide, overflow, label);
    slide.altText = s.alt || "";
    addChrome(slide, painter);
    const isTitle = s.kind === "title";
    addTitle(slide, painter, s.title, isTitle ? { sizePt: 36, y: 480000, cy: 1200000 } : {});
    addEyebrow(slide, painter, s.eyebrow);
    const strip = wordsStrip(painter, s.words, library);
    const draw = DRAW[s.kind];
    if (!draw) throw new Error(`No drawing for training slide kind "${s.kind}"`);
    draw(painter, slide, s.body, { bottom: strip.top });
    strip.draw();
    slide.setNotes(s.notes || []);
  });
  return { buffer: deck.toPptxBuffer(), overflow };
}

export { MIN_BODY_PT };
