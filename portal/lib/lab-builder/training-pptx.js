/**
 * Draws the pre-lab training decks (see training-slides.js) as PowerPoint files, on the same deck assembler, theme,
 * brand profile, speaker-notes parts, and package code as every other deck the portal makes.
 *
 * The look is the owner's sample deck (training-design.js holds the tokens and says what each color means): dark navy
 * title, divider, and closing slides with a coral bar and concentric circles; light content slides with an eyebrow, a
 * title, a footer, and a slide number in the same places; white cards with colored header bands; numbered circles;
 * chevron flows; tinted callouts; one table. Every graphic is a native shape. One idea per slide, generous margins,
 * body text between 12 and 16 points.
 *
 * Accessibility and fit: a real title placeholder on every slide, shapes in reading order (title, eyebrow, content,
 * then footer), a text description on every diagram group, purely decorative shapes marked decorative, and a measured
 * fit check on every text box so nothing overflows. The eyebrow, title, and subtitle are laid out from one vertical
 * budget (pptx-text-fit.js), so a long title never runs into the text above or below it.
 */

import { PptxDeckAssembler, SLIDE_CX, SlideBuilder, xmlEscape } from "./pptx-builder.js";
import { plainText } from "./training-text.js";
import { loadTrainingLibrary } from "./training-library.js";
import { fitHeading, fitSingleLine, linesHeightEmu, measureWidthPt, wrapText } from "./pptx-text-fit.js";
import { harnessShortName } from "./harness-parts.js";
import { GRID, PARTS, SPACING, TYPE, harnessColors, inch, resolveDesign } from "./training-design.js";

const ZERO = Object.freeze({ l: 0, t: 0, r: 0, b: 0 });
const PT = 12700;
const TRACK = Object.freeze({ cover: 300, eyebrow: 200, label: 100 });
const TITLE_PLACEHOLDER_TEXT = "Click to edit Master title style";
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

// ── Text measurement ──────────────────────────────────────────────────────────

const textOf = (p) => (p.runs ? p.runs.map((r) => r.text || "").join("") : p.text || "");

/** Height in EMU of one paragraph in a box `widthEmu` wide, measured with the same width table the title fit uses. */
function paragraphHeight(p, widthEmu, design) {
  const headingFace = p.font === design.font.heading || Boolean(p.runs?.some((r) => r.font === design.font.heading));
  const fontName = headingFace ? design.font.heading : design.font.body;
  const bold = headingFace || Boolean(p.bold) || Boolean(p.runs?.some((r) => r.bold));
  const indent = p.bulletChar ? 251460 : 0;
  const text = plainText(textOf(p)).replace(/\s+/g, " ");
  const trackingEmu = p.tracking ? Math.round((p.tracking / 100) * PT) * Math.max(0, text.length - 1) : 0;
  const lines = wrapText(text, Math.max(widthEmu - indent - trackingEmu, 100000), p.sizePt, fontName, { bold }).length;
  return linesHeightEmu(lines, p.sizePt, fontName, p.lineSpacingPct || SPACING.body) + Math.round(((p.spaceAfterPt ?? 0) + (p.spaceBeforePt || 0)) * PT);
}

/** Height in EMU of a stack of paragraphs, insets included. */
function stackHeight(paragraphs, widthEmu, design, insets = ZERO) {
  const inner = widthEmu - insets.l - insets.r;
  let total = insets.t + insets.b;
  for (const p of paragraphs) total += paragraphHeight(p, inner, design);
  return total;
}

/**
 * Shrink text a half point at a time (down to each paragraph's own floor) until the stack fits the box. The last
 * paragraph's space-after is not counted, since nothing follows it.
 */
function fitParagraphs(paragraphs, widthEmu, heightEmu, design, insets = ZERO) {
  const needed = (list) => stackHeight(list, widthEmu, design, insets) - Math.round((list[list.length - 1]?.spaceAfterPt ?? 0) * PT);
  let scaled = paragraphs;
  for (let step = 0; step <= 24; step += 1) {
    scaled = paragraphs.map((p) => ({ ...p, sizePt: Math.max(Math.min(p.minPt ?? TYPE.bodyMin, p.sizePt), p.sizePt - step * 0.5) }));
    if (needed(scaled) <= heightEmu) return { paragraphs: scaled, fits: true, needed: needed(scaled) };
  }
  return { paragraphs: scaled, fits: false, needed: needed(scaled) };
}

// ── The slide: a footer and a slide number in the sample's places ─────────────

class TrainingSlide extends SlideBuilder {
  /** The footer and the slide number sit last in reading order, under the same names every deck uses. */
  finalizeChrome(slideNumber) {
    if (this.meta.noFooter) return;
    const d = this.deck.design;
    const color = this.meta.dark ? d.onDarkFooter : d.gray;
    const brand = this.deck.footerText || this.deck.organizationName || "";
    const context = this.meta.footerContext || this.deck.title;
    const text = [brand, context].filter((part, i, all) => part && all.indexOf(part) === i).join("  ·  ");
    const width = inch(8);
    const fit = fitSingleLine({ text, fontName: d.font.body, widthEmu: width, sizes: [TYPE.footer], bold: false });
    this.trailingXml.push(
      this.renderShapeXml({
        name: "Footer Context",
        x: GRID.margin,
        y: GRID.footerY,
        cx: width,
        cy: GRID.footerH,
        anchor: "ctr",
        insets: ZERO,
        paragraphs: [{ text: fit.text, sizePt: fit.sizePt, colorHex: color, spaceAfterPt: 0, lineSpacingPct: 100000 }],
      }),
      this.renderShapeXml({
        name: "Slide Counter",
        x: GRID.numberX,
        y: GRID.numberY,
        cx: GRID.numberW,
        cy: GRID.numberH,
        anchor: "ctr",
        insets: ZERO,
        paragraphs: [{ text: String(slideNumber), sizePt: TYPE.footer, colorHex: color, align: "r", spaceAfterPt: 0, lineSpacingPct: 100000 }],
      }),
    );
  }
}

// ── The deck: the theme and the title placeholder follow the design ───────────

class TrainingDeckAssembler extends PptxDeckAssembler {
  constructor(options = {}) {
    super(options);
    this.design = resolveDesign(options.branding, this.brandFont);
  }

  createSlide(meta = {}) {
    const slide = new TrainingSlide(this, meta);
    this.slides.push(slide);
    return slide;
  }

  renderThemeXml(themeName) {
    const d = this.design;
    const scheme = `<a:clrScheme name="Training">
      <a:dk1><a:srgbClr val="${d.ink}"/></a:dk1>
      <a:lt1><a:srgbClr val="${d.white}"/></a:lt1>
      <a:dk2><a:srgbClr val="${d.navy}"/></a:dk2>
      <a:lt2><a:srgbClr val="${d.page}"/></a:lt2>
      <a:accent1><a:srgbClr val="${d.accent}"/></a:accent1>
      <a:accent2><a:srgbClr val="${d.highlightFill}"/></a:accent2>
      <a:accent3><a:srgbClr val="${d.harness.standard.fill}"/></a:accent3>
      <a:accent4><a:srgbClr val="${d.harness["microsoft-copilot"].fill}"/></a:accent4>
      <a:accent5><a:srgbClr val="${d.grayDark}"/></a:accent5>
      <a:accent6><a:srgbClr val="${d.navy}"/></a:accent6>
      <a:hlink><a:srgbClr val="${d.accentText}"/></a:hlink>
      <a:folHlink><a:srgbClr val="${d.grayDark}"/></a:folHlink>
    </a:clrScheme>`;
    return super.renderThemeXml(themeName).replace(/<a:clrScheme[\s\S]*?<\/a:clrScheme>/, scheme);
  }

  renderSlideMasterXml() {
    return super.renderSlideMasterXml()
      .replace('<a:defRPr sz="2800" b="1">', '<a:defRPr sz="3000" b="0">')
      .replace(
        /(<\/p:grpSpPr>)(\s*<\/p:spTree>)/,
        `$1
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Title Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="${GRID.margin}" y="${GRID.titleY}"/><a:ext cx="${GRID.contentW}" cy="${GRID.titleLimitY - GRID.titleY}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
        <p:txBody><a:bodyPr vert="horz" lIns="0" tIns="0" rIns="0" bIns="0" rtlCol="0" anchor="t"><a:normAutofit/></a:bodyPr><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>${TITLE_PLACEHOLDER_TEXT}</a:t></a:r><a:endParaRPr lang="en-US"/></a:p></p:txBody>
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

// ── Drawing context: the components every slide kind is built from ────────────

class Painter {
  constructor(deck, slide, report, label) {
    this.deck = deck;
    this.slide = slide;
    this.report = report;
    this.slideLabel = label;
    this.d = deck.design;
    this.out = slide.elementsXml;
    this.bounds = null;
  }

  // Paragraphs

  /** A body paragraph. */
  para(text, sizePt, o = {}) {
    const { color, after = 0, min = TYPE.bodyMin, ...rest } = o;
    return { text, sizePt, minPt: min, colorHex: color || this.d.ink, spaceAfterPt: after, lineSpacingPct: SPACING.body, ...rest };
  }

  /** A heading-face paragraph (Segoe UI Semibold, or the brand font set bold). */
  head(text, sizePt, o = {}) {
    const { color, after = 0, min = 13, ...rest } = o;
    return { text, sizePt, minPt: min, font: this.d.font.heading, colorHex: color || this.d.ink, spaceAfterPt: after, lineSpacingPct: SPACING.heading + 3000, ...rest };
  }

  /** A small caps label, as in "BEST FOR". */
  label(text, color, o = {}) {
    return this.head(String(text).toUpperCase(), TYPE.label, { color, min: TYPE.label, tracking: TRACK.label, after: 3, ...o });
  }

  /** A paragraph of a bold lead-in and plain text, as in a callout ("Better together:  ..."). */
  lead(leadText, text, sizePt, o = {}) {
    return this.para(text, sizePt, {
      ...o,
      text: undefined,
      runs: [
        { text: `${leadText}  `, font: this.d.font.heading, bold: true, colorHex: o.leadColor || this.d.ink },
        { text, colorHex: o.color || this.d.ink },
      ],
    });
  }

  // Shapes

  add(spec) {
    this.out.push(this.slide.renderShapeXml(spec));
    if (this.bounds) this.bounds.push({ x: spec.x, y: spec.y, r: spec.x + spec.cx, b: spec.y + spec.cy });
  }

  /** A shape with no text that a screen reader skips. */
  deco(name, geom, x, y, cx, cy, fill, o = {}) {
    this.add({ name, geom, x, y, cx, cy, fillHex: fill, borderHex: o.line, borderWidthEmu: o.lineW, adj: o.adj, decorative: true, insets: ZERO, paragraphs: [{ text: "", sizePt: 4 }] });
  }

  /** A shape that carries text, fit-checked: the text shrinks to fit, and a miss is reported. */
  block(name, x, y, cx, cy, paragraphs, o = {}) {
    const insets = o.insets || ZERO;
    const fit = fitParagraphs(paragraphs, cx, cy, this.d, insets);
    if (!fit.fits) this.report.push({ slide: this.slideLabel, shape: name, needed: fit.needed, have: cy });
    this.add({
      name,
      geom: o.geom || "rect",
      x,
      y,
      cx,
      cy,
      fillHex: o.fill,
      borderHex: o.line,
      borderWidthEmu: o.lineW,
      adj: o.adj,
      anchor: o.anchor || "t",
      insets,
      paragraphs: fit.paragraphs,
    });
  }

  /** A transparent text box. */
  text(name, x, y, cx, cy, paragraphs, o = {}) {
    this.block(name, x, y, cx, cy, paragraphs, o);
  }

  /** A diagram: its shapes grouped under one name and one text description. */
  group(name, alt, draw) {
    const saved = this.out;
    const savedBounds = this.bounds;
    const children = [];
    this.out = children;
    this.bounds = [];
    draw();
    const box = this.bounds;
    this.out = saved;
    this.bounds = savedBounds;
    if (!children.length) return;
    const x = Math.min(...box.map((b) => b.x));
    const y = Math.min(...box.map((b) => b.y));
    const cx = Math.max(...box.map((b) => b.r)) - x;
    const cy = Math.max(...box.map((b) => b.b)) - y;
    const id = this.slide.allocateShapeId();
    this.out.push(`<p:grpSp>
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
    if (this.bounds) this.bounds.push({ x, y, r: x + cx, b: y + cy });
  }

  // Components (the sample's recurring parts)

  /** A white card with a hairline border. */
  card(name, x, y, cx, cy, o = {}) {
    this.deco(`${name} Card`, "rect", x, y, cx, cy, this.d.card, { line: o.line || this.d.cardLine, lineW: o.lineW || PARTS.cardLine });
  }

  /** The colored stripe down the left edge of a card. */
  stripe(name, x, y, cy, color) {
    this.deco(`${name} Stripe`, "rect", x, y, PARTS.stripeW, cy, color);
  }

  /** A full-width header band with a heading and an optional small right-aligned tag. */
  band(name, x, y, cx, h, fill, heading, o = {}) {
    const pad = GRID.pad;
    const tagW = o.tag ? clamp(this.measureWidth(o.tag, TYPE.caption) + inch(0.1), inch(0.7), Math.floor(cx / 2)) : 0;
    this.block(`${name} Heading`, x, y, cx, h, [this.head(heading, o.sizePt || TYPE.cardHeading, { color: this.d.white, min: 14 })], { fill, anchor: "ctr", insets: { l: pad, t: 0, r: pad + tagW, b: 0 } });
    if (o.tag) this.text(`${name} Tag`, x + cx - pad - tagW, y, tagW, h, [this.para(o.tag, TYPE.caption, { color: this.d.white, align: "r", min: 10 })], { anchor: "ctr" });
  }

  /** A numbered circle. */
  circle(name, x, y, size, fill, n, o = {}) {
    this.block(name, x, y, size, size, [this.head(String(n), o.sizePt || (size >= PARTS.circleLarge ? 16 : 14), { color: o.color || this.d.white, align: "ctr", min: 11 })], { geom: "ellipse", fill, line: o.line, lineW: o.lineW, anchor: "ctr" });
  }

  /** A rounded pill sized to its text. Returns its width. */
  pill(name, x, y, text, fill, o = {}) {
    const h = o.h || PARTS.pillH;
    const size = o.sizePt || TYPE.pill;
    const w = o.w || Math.min(o.maxW || inch(6), this.measureWidth(text, size) + PARTS.pillPadX * 2);
    this.block(name, x, y, w, h, [this.para(text, size, { color: o.color || this.d.white, align: "ctr", min: 10 })], {
      geom: "roundRect",
      adj: PARTS.pillAdj,
      fill,
      line: o.line === undefined ? this.d.white : o.line,
      lineW: PARTS.cardLine,
      anchor: "ctr",
      insets: ZERO,
    });
    return w;
  }

  /** Width in EMU of one line of text (measured bold when it is a heading). */
  measureWidth(text, sizePt, { bold = false } = {}) {
    const fontName = bold ? this.d.font.heading : this.d.font.body;
    return Math.round(measureWidthPt(plainText(text), sizePt, fontName, { bold }) * PT);
  }

  /** A small chevron between steps. */
  chevron(name, x, y, color) {
    this.deco(name, "chevron", x, y, PARTS.chevronW, PARTS.chevronH, color);
  }

  /** A tinted callout with a coral stripe and a bold lead-in. */
  callout(name, x, y, cx, cy, paragraphs, o = {}) {
    this.deco(`${name} Panel`, "rect", x, y, cx, cy, o.fill || this.d.accentTint);
    this.deco(`${name} Stripe`, "rect", x, y, PARTS.calloutStripeW, cy, o.stripe || this.d.highlight);
    const pad = inch(0.28);
    this.text(name, x + pad, y, cx - pad - GRID.pad, cy, paragraphs, { anchor: "ctr" });
  }

  /** Height a callout needs for these paragraphs at width `cx`. */
  calloutHeight(paragraphs, cx, min = inch(0.62)) {
    return Math.max(min, stackHeight(paragraphs, cx - inch(0.28) - GRID.pad, this.d) - Math.round((paragraphs[paragraphs.length - 1]?.spaceAfterPt ?? 0) * PT) + inch(0.24));
  }

  /** A callout whose text runs in two columns under a small label (a long list of words). */
  calloutColumns(name, x, y, cx, cy, columns, label) {
    this.deco(`${name} Panel`, "rect", x, y, cx, cy, this.d.accentTint);
    this.deco(`${name} Stripe`, "rect", x, y, PARTS.calloutStripeW, cy, this.d.highlight);
    const pad = inch(0.28);
    const gap = inch(0.3);
    const colW = Math.floor((cx - pad - GRID.pad - gap * (columns.length - 1)) / columns.length);
    const labelH = label ? inch(0.26) : 0;
    if (label) this.text(`${name} Label`, x + pad, y + inch(0.06), cx - pad - GRID.pad, labelH, [label], { anchor: "ctr" });
    const columnsTop = label ? inch(0.34) : 0;
    columns.forEach((paragraphs, i) => {
      this.text(i === 0 ? name : `${name} ${i + 1}`, x + pad + i * (colW + gap), y + columnsTop, colW, cy - columnsTop - (label ? inch(0.08) : 0), paragraphs, { anchor: label ? "t" : "ctr" });
    });
  }

  /** Height of a card whose text needs `paragraphLists` (one list per column) below `top` EMU of header, clamped to what is left. */
  cardHeight(paragraphLists, innerW, { top = 0, bottomPad = inch(0.3), min = inch(2.2), max }) {
    const need = Math.max(...paragraphLists.map((list) => stackHeight(list, innerW, this.d) - Math.round((list[list.length - 1]?.spaceAfterPt ?? 0) * PT)));
    return clamp(top + need + bottomPad, Math.min(min, max), max);
  }

  /** A layer of a stack: a solid rounded bar with a heading and a line of text, in white. */
  layer(name, x, y, cx, cy, fill, heading, body) {
    const pad = inch(0.3);
    const paragraphs = [this.head(heading, 17, { color: this.d.white, after: 4, min: 14 })];
    if (body) paragraphs.push(this.para(body, 13.5, { color: this.d.white }));
    this.block(name, x, y, cx, cy, paragraphs, { fill, geom: "roundRect", adj: 6250, anchor: "ctr", insets: { l: pad, t: inch(0.1), r: pad, b: inch(0.1) } });
  }

  /** A tile in a schematic: a rounded white panel with a colored outline, or a solid one. */
  tile(name, x, y, cx, cy, paragraphs, o = {}) {
    this.block(name, x, y, cx, cy, paragraphs, {
      geom: "roundRect",
      adj: o.adj ?? 6250,
      fill: o.fill || this.d.card,
      line: o.line === undefined ? this.d.accent : o.line,
      lineW: o.lineW || PARTS.schematicLine,
      anchor: o.anchor || "ctr",
      insets: o.insets || { l: inch(0.2), t: inch(0.1), r: inch(0.2), b: inch(0.1) },
    });
  }

  /** An arrow between two tiles. */
  arrow(name, x, y, color) {
    this.deco(name, "rightArrow", x, y, PARTS.arrowW, PARTS.arrowH, color);
  }

  /** A table of rows: a navy header, then white and light rows. Columns are `{w, align}`. */
  table(name, alt, x, y, columns, header, rows, o = {}) {
    const d = this.d;
    const rowH = o.rowH || PARTS.tableRowH;
    const id = this.slide.allocateShapeId();
    const cell = (text, c, isHeader, rowIndex) => {
      const fill = isHeader ? d.navy : rowIndex % 2 === 1 ? d.card : d.tile;
      const paragraph = this.slide.renderParagraphXml({
        text: String(text ?? ""),
        sizePt: o.sizePt || 13,
        colorHex: isHeader ? d.white : d.ink,
        font: isHeader ? d.font.heading : undefined,
        align: c.align || "l",
        spaceAfterPt: 0,
        lineSpacingPct: 100000,
      });
      const line = (tag) => `<a:${tag} w="9525"><a:solidFill><a:srgbClr val="${d.tableLine}"/></a:solidFill></a:${tag}>`;
      return `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${paragraph}</a:txBody><a:tcPr marL="91440" marR="91440" marT="36576" marB="36576" anchor="ctr">${line("lnL")}${line("lnR")}${line("lnT")}${line("lnB")}<a:solidFill><a:srgbClr val="${fill}"/></a:solidFill></a:tcPr></a:tc>`;
    };
    const all = [header, ...rows];
    const rowsXml = all.map((cells, r) => `<a:tr h="${rowH}">${columns.map((c, i) => cell(cells[i], c, r === 0, r)).join("")}</a:tr>`).join("");
    const cx = columns.reduce((sum, c) => sum + c.w, 0);
    const cy = rowH * all.length;
    this.out.push(`<p:graphicFrame>
      <p:nvGraphicFramePr>
        <p:cNvPr id="${id}" name="${xmlEscape(name)}" descr="${xmlEscape(alt)}"/>
        <p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr>
        <p:nvPr/>
      </p:nvGraphicFramePr>
      <p:xfrm><a:off x="${Math.round(x)}" y="${Math.round(y)}"/><a:ext cx="${Math.round(cx)}" cy="${Math.round(cy)}"/></p:xfrm>
      <a:graphic>
        <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">
          <a:tbl>
            <a:tblPr firstRow="1" bandRow="1"/>
            <a:tblGrid>${columns.map((c) => `<a:gridCol w="${Math.round(c.w)}"/>`).join("")}</a:tblGrid>
            ${rowsXml}
          </a:tbl>
        </a:graphicData>
      </a:graphic>
    </p:graphicFrame>`);
    if (this.bounds) this.bounds.push({ x, y, r: x + cx, b: y + cy });
    return cy;
  }
}

// ── The top of every slide: eyebrow, title (a real placeholder), tag ──────────

/**
 * Where the title goes and how big it is, measured, so it can never run into the eyebrow above it or the content below
 * it. The title is anchored to its top (it can only grow downward), steps down in size, then is shortened.
 */
function layoutContentTitle(p, text) {
  const fit = fitHeading({
    text,
    fontName: p.d.font.heading,
    widthEmu: GRID.contentW,
    maxHeightEmu: GRID.titleLimitY - GRID.titleY,
    steps: TYPE.contentTitle.map((sizePt) => ({ sizePt, spacingPct: SPACING.heading })),
  });
  return { fit, x: GRID.margin, y: GRID.titleY, cx: GRID.contentW, cy: fit.heightEmu };
}

/** The title placeholder, in the slide's chrome so it is read first. */
function addTitle(slide, p, layout, color) {
  const { fit } = layout;
  const id = slide.allocateShapeId();
  const para = slide.renderParagraphXml({ text: fit.text, sizePt: fit.sizePt, colorHex: color, font: p.d.font.heading, spaceAfterPt: 0, lineSpacingPct: fit.spacingPct });
  const alt = fit.shortened ? ` descr="${xmlEscape(fit.fullText)}"` : "";
  slide.chromeXml.push(`<p:sp>
      <p:nvSpPr>
        <p:cNvPr id="${id}" name="Title"${alt}/>
        <p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>
        <p:nvPr><p:ph type="title"/></p:nvPr>
      </p:nvSpPr>
      <p:spPr>
        <a:xfrm><a:off x="${layout.x}" y="${layout.y}"/><a:ext cx="${layout.cx}" cy="${layout.cy}"/></a:xfrm>
      </p:spPr>
      <p:txBody>
        <a:bodyPr vert="horz" wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="t"><a:normAutofit/></a:bodyPr>
        <a:lstStyle/>
        ${para}
      </p:txBody>
    </p:sp>`);
}

/** The eyebrow: the section name in small tracked caps, teal on light slides and coral on dark ones. */
function addEyebrow(slide, p, eyebrow, { x = GRID.margin, y = GRID.eyebrowY, h = GRID.eyebrowH, width = inch(9), color, sizes = TYPE.eyebrow, tracking = TRACK.eyebrow } = {}) {
  if (!eyebrow) return;
  const trackingEmu = Math.round((tracking / 100) * PT);
  const upper = String(eyebrow).toUpperCase();
  const fit = fitSingleLine({ text: upper, fontName: p.d.font.heading, widthEmu: width - trackingEmu * upper.length, sizes });
  slide.chromeXml.push(
    slide.renderShapeXml({
      name: "Eyebrow",
      x,
      y,
      cx: width,
      cy: h,
      anchor: "ctr",
      insets: ZERO,
      paragraphs: [{ text: fit.text, sizePt: fit.sizePt, colorHex: color, font: p.d.font.heading, tracking, spaceAfterPt: 0, lineSpacingPct: 100000 }],
    }),
  );
}

/** A small pill at the right of the eyebrow row that names the harness (or both) a slide belongs to. */
function addPartTag(p, tag) {
  if (!tag?.text) return;
  const { d } = p;
  const fill = tag.harness ? harnessColors(d, tag.harness).fill : d.accent;
  const h = inch(0.32);
  const w = Math.min(inch(3), p.measureWidth(tag.text, 11) + inch(0.5));
  const saved = p.out;
  p.out = p.slide.chromeXml;
  p.block("Part Tag", GRID.margin + GRID.contentW - w, GRID.eyebrowY - inch(0.02), w, h, [p.para(tag.text, 11, { color: d.white, align: "ctr", min: 10 })], { geom: "roundRect", adj: PARTS.pillAdj, fill, anchor: "ctr" });
  p.out = saved;
}

/** A shape or group drawn into the slide's chrome rather than its content (used by the dark slides' backdrop). */
function intoChrome(p, draw) {
  const saved = p.out;
  p.out = p.slide.chromeXml;
  draw();
  p.out = saved;
}

// ── Words strip ──────────────────────────────────────────────────────────────

/** Lay out the "word to know" callout at the foot of a slide. Returns where the content must end and a draw function. */
function wordsStrip(p, words, library) {
  const bottom = GRID.bottom;
  if (!words?.length) return { top: bottom, draw() {} };
  const w = GRID.contentW;
  const wordParagraph = (id, last) => {
    const entry = library.terms[id];
    return {
      runs: [
        { text: `${words.length === 1 ? "Word to know:  " : ""}${entry.term}`, font: p.d.font.heading, bold: true, colorHex: p.d.ink },
        { text: ` — ${entry.plain}.`, colorHex: p.d.ink },
      ],
      sizePt: 12.5,
      minPt: TYPE.bodyMin,
      spaceAfterPt: last ? 0 : 3,
      lineSpacingPct: SPACING.body,
    };
  };
  // Four or more words run in columns under one label (two, or three for six or more), so a long list does not take the whole slide.
  const columns = words.length >= 6 ? 3 : words.length >= 4 ? 2 : 1;
  const per = Math.ceil(words.length / columns);
  const lists = Array.from({ length: columns }, (_v, c) => words.slice(c * per, (c + 1) * per).map((id, i, all) => wordParagraph(id, i === all.length - 1)));
  const label = p.label("Words to know", p.d.grayDark, { after: 0 });
  if (words.length > 1 && columns === 1) lists[0].unshift({ ...label, spaceAfterPt: 3 });
  const textW = columns > 1 ? Math.floor((w - inch(0.28) - GRID.pad - inch(0.3) * (columns - 1)) / columns) : w - inch(0.28) - GRID.pad;
  const h =
    columns > 1
      ? Math.max(inch(0.5), inch(0.34) + Math.max(...lists.map((list) => stackHeight(list, textW, p.d) - Math.round((list[list.length - 1]?.spaceAfterPt ?? 0) * PT))) + inch(0.12))
      : Math.max(inch(0.5), ...lists.map((list) => p.calloutHeight(list, textW + inch(0.28) + GRID.pad, inch(0.5))));
  const y = bottom - h;
  return {
    top: y - inch(0.15),
    draw() {
      if (columns === 1) p.callout("Words to Know", GRID.margin, y, w, h, lists[0]);
      else p.calloutColumns("Words to Know", GRID.margin, y, w, h, lists, label);
    },
  };
}

// ── Layout helpers ───────────────────────────────────────────────────────────

/** `n` equal cells in a grid of `cols` columns inside `area`. */
function gridCells(n, cols, area, gap, rowH) {
  const rows = Math.ceil(n / cols);
  const w = Math.floor((area.cx - gap * (cols - 1)) / cols);
  const h = rowH ?? Math.floor((area.cy - gap * (rows - 1)) / rows);
  return Array.from({ length: n }, (_v, i) => ({ x: area.x + (i % cols) * (w + gap), y: area.y + Math.floor(i / cols) * (h + gap), cx: w, cy: h, col: i % cols, row: Math.floor(i / cols) }));
}

/** Where a long URL is shown: the host, then the last part of the path. */
function shortUrl(url) {
  const bare = String(url).replace(/^https?:\/\//, "").replace(/[?#].*$/, "").replace(/\/$/, "");
  const parts = bare.split("/");
  if (parts.length <= 3) return bare;
  return `${parts[0]}/…/${parts[parts.length - 1]}`.slice(0, 70);
}

const LETTERS = ["A", "B", "C", "D", "E", "F"];

// ── Slide kinds ──────────────────────────────────────────────────────────────

const DRAW = {
  scenario(p, slide, body, ctx) {
    const { d } = p;
    const gap = GRID.gap;
    const colW = Math.floor((GRID.contentW - gap) / 2);
    const contextParagraphs = [p.para(body.context, 14, { after: 0 })];
    const contextH = p.calloutHeight(contextParagraphs, GRID.contentW);
    const inner = colW - GRID.pad * 2;
    const bandH = PARTS.bandHSmall;
    const columns = [
      { name: "Situation", fill: d.highlightFill, label: body.situationHeading, paragraphs: [p.para(body.situation, 16, { min: 13 })] },
      {
        name: "Helps",
        fill: d.accent,
        label: body.helpsHeading,
        paragraphs: body.helpsItems?.length
          ? body.helpsItems.map((t) => p.para(plainText(t), 15, { bulletChar: "•", bulletColorHex: d.accent, after: 8, min: 13 }))
          : [p.para(body.helps, 16, { min: 13 })],
      },
    ];
    const avail = ctx.bottom - GRID.top - contextH - gap;
    const h = p.cardHeight(columns.map((c) => c.paragraphs), inner, { top: bandH + inch(0.22), bottomPad: inch(0.3), min: inch(2.4), max: avail });
    columns.forEach((c, i) => {
      const x = GRID.margin + i * (colW + gap);
      p.card(c.name, x, GRID.top, colW, h);
      p.band(c.name, x, GRID.top, colW, bandH, c.fill, c.label, { sizePt: 17 });
      p.text(`${c.name} Text`, x + GRID.pad, GRID.top + bandH + inch(0.22), inner, h - bandH - inch(0.3), c.paragraphs);
    });
    p.callout("Lab Context", GRID.margin, GRID.top + h + gap, GRID.contentW, contextH, contextParagraphs);
  },

  definition(p, slide, body, ctx) {
    const { d } = p;
    const w = GRID.contentW;
    let y = GRID.top;
    const pictureMin = inch(1.5);
    const extra = [];
    if (body.analogy) extra.push(p.para(body.analogy, 14, { italic: true, after: body.thisTopic ? 6 : 0 }));
    if (body.thisTopic) extra.push(p.para(body.thisTopic, 14));
    const extraH = extra.length ? p.calloutHeight(extra, w) : 0;
    const stripeInset = inch(0.28);
    const sentenceSteps = [24, 22, 20, 18, 16];
    const available = ctx.bottom - GRID.top - (extraH ? extraH + GRID.gap : 0) - pictureMin - GRID.gap;
    let size = sentenceSteps[sentenceSteps.length - 1];
    for (const step of sentenceSteps) {
      size = step;
      if (stackHeight([p.head(body.sentence, step, { min: step })], w - stripeInset - GRID.pad, d, { l: 0, t: inch(0.2), r: 0, b: inch(0.2) }) <= available) break;
    }
    const sentenceParagraph = [p.head(body.sentence, size, { min: 16 })];
    const sentenceH = clamp(stackHeight(sentenceParagraph, w - stripeInset - GRID.pad, d, { l: 0, t: inch(0.2), r: 0, b: inch(0.2) }), inch(1.0), Math.max(inch(1.0), available));
    p.card("Definition", GRID.margin, y, w, sentenceH);
    p.stripe("Definition", GRID.margin, y, sentenceH, d.accent);
    p.text("Definition", GRID.margin + stripeInset, y, w - stripeInset - GRID.pad, sentenceH, sentenceParagraph, { anchor: "ctr" });
    y += sentenceH + GRID.gap;
    if (extra.length) {
      p.callout("In This Topic", GRID.margin, y, w, extraH, extra);
      y += extraH + GRID.gap;
    }
    const pictureH = ctx.bottom - y;
    if (pictureH < pictureMin) return;
    const captionH = inch(0.3);
    p.text("Picture Caption", GRID.margin, y, w, captionH, [p.para(`Illustrative: ${body.picture.left.toLowerCase()}, ${body.picture.middle} does its work, ${body.picture.right.toLowerCase()}`, 12, { color: d.grayDark })], { anchor: "ctr" });
    const tileY = y + captionH + inch(0.08);
    const tileH = Math.min(inch(1.5), pictureH - captionH - inch(0.08));
    const arrowGap = inch(0.2);
    const tileW = Math.floor((w - 2 * (PARTS.arrowW + 2 * arrowGap)) / 3);
    p.group("Simple Picture", body.pictureAlt, () => {
      [body.picture.left, body.picture.middle, body.picture.right].forEach((label, i) => {
        const x = GRID.margin + i * (tileW + PARTS.arrowW + 2 * arrowGap);
        const middle = i === 1;
        p.tile(`Picture Box ${i + 1}`, x, tileY, tileW, tileH, [p.head(label, 20, { color: middle ? d.white : d.ink, align: "ctr", min: 14 })], { fill: middle ? d.navy : d.card, line: middle ? d.navy : d.accent });
        if (i < 2) p.arrow(`Picture Arrow ${i + 1}`, x + tileW + arrowGap, tileY + tileH / 2 - PARTS.arrowH / 2, d.accent);
      });
    });
  },

  adds(p, slide, body, ctx) {
    const { d } = p;
    const w = GRID.contentW;
    const recall = [p.para(body.recall, 15)];
    const recallH = p.calloutHeight(recall, w);
    p.callout("Recall", GRID.margin, GRID.top, w, recallH, recall);
    const top = GRID.top + recallH + GRID.gap + inch(0.1);
    p.text("What This Adds Heading", GRID.margin, top, w, inch(0.4), [p.head(body.heading, 20, { color: d.accentText, min: 16 })], { anchor: "ctr" });
    const area = { x: GRID.margin, y: top + inch(0.5), cx: w, cy: ctx.bottom - top - inch(0.5) };
    const rowH = Math.min(inch(0.9), Math.floor((area.cy - GRID.gapSmall * (body.items.length - 1)) / Math.max(1, body.items.length)));
    body.items.forEach((item, i) => {
      const y = area.y + i * (rowH + GRID.gapSmall);
      p.card(`Item ${i + 1}`, GRID.margin, y, w, rowH);
      p.stripe(`Item ${i + 1}`, GRID.margin, y, rowH, d.accent);
      const size = Math.min(PARTS.circle, rowH - inch(0.16));
      p.circle(`Item ${i + 1} Number`, GRID.margin + inch(0.26), y + (rowH - size) / 2, size, d.accent, i + 1);
      p.text(`Item ${i + 1} Text`, GRID.margin + inch(0.26) + size + inch(0.2), y, w - inch(0.26) - size - inch(0.2) - GRID.pad, rowH, [p.para(item, 15)], { anchor: "ctr" });
    });
  },

  needToKnow(p, slide, body, ctx) {
    const { d } = p;
    p.text("Intro", GRID.margin, GRID.top, GRID.contentW, inch(0.4), [p.para(body.intro, 15, { color: d.gray })], { anchor: "ctr" });
    const top = GRID.top + inch(0.55);
    const items = body.items;
    const cols = items.length <= 3 ? items.length : 2;
    const rows = Math.ceil(items.length / cols);
    const probe = gridCells(items.length, cols, { x: GRID.margin, y: top, cx: GRID.contentW, cy: ctx.bottom - top }, GRID.gap, 1);
    const paragraphsOf = (item) => [p.head(item.head, 19, { after: 8, min: 15 }), p.para(item.text, 15, { min: 12 })];
    const cellH = p.cardHeight(items.map(paragraphsOf), probe[0].cx - inch(0.28) - GRID.pad, { top: inch(0.18), bottomPad: inch(0.3), min: inch(1.6), max: Math.floor((ctx.bottom - top - GRID.gap * (rows - 1)) / rows) });
    const cells = gridCells(items.length, cols, { x: GRID.margin, y: top, cx: GRID.contentW, cy: ctx.bottom - top }, GRID.gap, cellH);
    cells.forEach((c, i) => {
      const item = items[i];
      p.card(`Idea ${i + 1}`, c.x, c.y, c.cx, cellH);
      p.stripe(`Idea ${i + 1}`, c.x, c.y, cellH, d.accent);
      const x = c.x + inch(0.28);
      const w = c.cx - inch(0.28) - GRID.pad;
      p.text(`Idea ${i + 1} Text`, x, c.y + inch(0.18), w, cellH - inch(0.3), paragraphsOf(item));
    });
  },

  blocks(p, slide, body, ctx) {
    const { d } = p;
    const nodes = body.nodes;
    const n = nodes.length;
    const area = { x: GRID.margin, y: GRID.top, cx: GRID.contentW, cy: ctx.bottom - GRID.top };
    // Up to four blocks sit in one row; five or six in two rows of three.
    const cols = n <= 4 ? n : 3;
    const rows = Math.ceil(n / cols);
    const bandH = rows > 1 ? inch(0.5) : PARTS.bandH;
    const bodySize = rows > 1 ? 14 : 15;
    const probe = gridCells(n, cols, area, GRID.gap, 1);
    const maxRowH = Math.min(inch(4.4), Math.floor((area.cy - GRID.gap * (rows - 1)) / rows));
    const tight = rows > 1;
    const cardH = p.cardHeight(nodes.map((nd) => [p.para(plainText(nd.plain), bodySize, { min: 12 })]), probe[0].cx - GRID.pad * 2, { top: bandH + inch(tight ? 0.14 : 0.18), bottomPad: inch(tight ? 0.18 : 0.3), min: inch(1.8), max: maxRowH });
    const cells = gridCells(n, cols, area, GRID.gap, cardH);
    p.group("Building Blocks Diagram", slide.altText || nodes.map((b) => `${b.label}, ${plainText(b.plain)}`).join("; "), () => {
      cells.forEach((c, i) => {
        const node = nodes[i];
        p.card(`Block ${i + 1}`, c.x, c.y, c.cx, cardH);
        p.band(`Block ${i + 1}`, c.x, c.y, c.cx, bandH, d.accent, node.label, { sizePt: rows > 1 ? 17 : 19 });
        p.text(`Block ${i + 1} Text`, c.x + GRID.pad, c.y + bandH + inch(tight ? 0.14 : 0.18), c.cx - GRID.pad * 2, cardH - bandH - inch(tight ? 0.2 : 0.3), [p.para(plainText(node.plain), bodySize, { min: 12 })]);
      });
    });
  },

  flow(p, slide, body, ctx) {
    const { d } = p;
    const steps = body.steps;
    const n = steps.length;
    // Up to five steps run in one row, as in the sample's lifecycle slide; six or more in two rows.
    const perRow = n > 5 ? Math.ceil(n / 2) : n;
    const rows = Math.ceil(n / perRow);
    const gap = inch(0.42);
    const w = Math.floor((GRID.contentW - gap * (perRow - 1)) / perRow);
    const rowGap = inch(0.3);
    const avail = ctx.bottom - GRID.top;
    const bandH = PARTS.bandHSmall + inch(0.02);
    const maxH = Math.min(rows > 1 ? inch(2.5) : inch(3.8), Math.floor((avail - rowGap * (rows - 1)) / rows));
    const cardH = p.cardHeight(steps.map((s) => [p.para(plainText(s.plain), 14, { min: 12 })]), w - inch(0.36), { top: bandH + inch(0.16), bottomPad: inch(0.28), min: inch(2.0), max: maxH });
    p.group("How It Works Diagram", slide.altText || `Flow of ${n} steps: ${steps.map((s) => s.label).join(", then ")}.`, () => {
      steps.forEach((s, i) => {
        const col = i % perRow;
        const row = Math.floor(i / perRow);
        const x = GRID.margin + col * (w + gap);
        const y = GRID.top + row * (cardH + rowGap);
        p.card(`Step ${i + 1}`, x, y, w, cardH);
        p.band(`Step ${i + 1}`, x, y, w, bandH, d.accent, `${i + 1}  ${s.label}`, { sizePt: perRow >= 5 ? 15 : 16 });
        p.text(`Step ${i + 1} Text`, x + inch(0.18), y + bandH + inch(0.16), w - inch(0.36), cardH - bandH - inch(0.28), [p.para(plainText(s.plain), 14, { min: 12 })]);
        if (col < perRow - 1 && i < n - 1) p.chevron(`Step ${i + 1} Chevron`, x + w + (gap - PARTS.chevronW) / 2, y + (bandH - PARTS.chevronH) / 2, d.highlight);
      });
    });
  },

  example(p, slide, body, ctx) {
    const { d } = p;
    const quoted = body.inputIsQuestion ? `“${body.input.replace(/^["“]|["”]$/g, "")}”` : body.input;
    const gap = inch(0.2);
    const tileW = Math.floor((GRID.contentW - PARTS.arrowW - gap * 2) / 2);
    const hasExpect = Boolean(body.expect);
    const expectParagraphs = hasExpect ? [p.para(body.expect, 14)] : [];
    const expectH = hasExpect ? p.calloutHeight(expectParagraphs, GRID.contentW) : 0;
    const insets = { l: inch(0.3), t: inch(0.28), r: inch(0.3), b: inch(0.28) };
    const left = [p.label(body.inputHeading, d.accentText, { after: 8 }), p.para(quoted, 22, { italic: Boolean(body.inputIsQuestion), min: 14 })];
    const right = [p.label(body.outputHeading, d.highlightOnDark, { after: 8 }), p.para(body.output, 20, { color: d.white, min: 14 })];
    const wanted = Math.max(stackHeight(left, tileW, d, insets), stackHeight(right, tileW, d, insets));
    const h = clamp(wanted + inch(0.2), inch(2.8), ctx.bottom - GRID.top - (hasExpect ? expectH + GRID.gap : 0));
    p.group("Example Flow", slide.altText || `Example: what starts it, then what you get. ${quoted} leads to ${body.output}`, () => {
      p.tile("What Starts It", GRID.margin, GRID.top, tileW, h, left, { anchor: "t", insets, fill: d.card, line: d.accent });
      p.arrow("Then", GRID.margin + tileW + gap, GRID.top + h / 2 - PARTS.arrowH / 2, d.accent);
      p.tile("What You Get", GRID.margin + tileW + PARTS.arrowW + gap * 2, GRID.top, tileW, h, right, { anchor: "t", insets, fill: d.navy, line: d.navy });
    });
    if (hasExpect) p.callout("In The Lab", GRID.margin, GRID.top + h + GRID.gap, GRID.contentW, expectH, expectParagraphs);
  },

  fit(p, slide, body, ctx) {
    const { d } = p;
    const gap = GRID.gap;
    const colW = Math.floor((GRID.contentW - gap) / 2);
    const bullets = (items, color) => items.map((t) => p.para(plainText(t), 15, { bulletChar: "•", bulletColorHex: color, after: 10, min: 12 }));
    const columns = [
      { name: "Good Fit", fill: d.accent, heading: body.useHeading, paragraphs: bullets(body.use, d.accent) },
      { name: "Not A Fit", fill: d.highlightFill, heading: body.notHeading, paragraphs: bullets(body.not, d.highlightFill) },
    ];
    const h = p.cardHeight(columns.map((c) => c.paragraphs), colW - GRID.pad * 2, { top: PARTS.bandHSmall + inch(0.22), bottomPad: inch(0.3), min: inch(3.0), max: ctx.bottom - GRID.top });
    columns.forEach((c, i) => {
      const x = GRID.margin + i * (colW + gap);
      p.card(c.name, x, GRID.top, colW, h);
      p.band(c.name, x, GRID.top, colW, PARTS.bandHSmall, c.fill, c.heading, { sizePt: 18 });
      p.text(`${c.name} Text`, x + GRID.pad, GRID.top + PARTS.bandHSmall + inch(0.22), colW - GRID.pad * 2, h - PARTS.bandHSmall - inch(0.3), c.paragraphs);
    });
  },

  know(p, slide, body, ctx) {
    const { d } = p;
    const rows = body.items;
    const labelW = inch(2.3);
    const textX = GRID.margin + inch(0.28) + labelW + inch(0.2);
    const textW = GRID.contentW - (textX - GRID.margin) - GRID.pad;
    const insets = { l: 0, t: inch(0.04), r: 0, b: inch(0.04) };
    // Each row is as tall as its text needs; when they do not all fit (a long list of words below), the text steps down
    // to 12 pt and the rows tighten, and then share what there is.
    const plan = (size, minRow, gap) => {
      const needs = rows.map((item) => Math.max(minRow, Math.min(inch(1.3), stackHeight([p.para(item.text, size, { min: 12 })], textW, d, insets) + inch(0.06))));
      return { size, gap, needs, total: needs.reduce((a, b) => a + b, 0) + gap * (rows.length - 1) };
    };
    const avail = ctx.bottom - GRID.top;
    let layout = plan(14, inch(0.62), inch(0.12));
    if (layout.total > avail) layout = plan(12, inch(0.46), inch(0.08));
    const scale = Math.min(1, (avail - layout.gap * (rows.length - 1)) / (layout.total - layout.gap * (rows.length - 1)));
    let y = GRID.top;
    rows.forEach((item, i) => {
      const rowH = Math.floor(layout.needs[i] * scale);
      const color = item.confirmed ? d.accent : d.highlightFill;
      p.card(`Fact ${i + 1}`, GRID.margin, y, GRID.contentW, rowH);
      p.stripe(`Fact ${i + 1}`, GRID.margin, y, rowH, color);
      p.text(`${item.label} Label`, GRID.margin + inch(0.28), y, labelW, rowH, [p.head(item.label, layout.size === 14 ? 16 : 14, { color: item.confirmed ? d.accentText : d.highlightInk, min: 13 })], { anchor: "ctr" });
      p.text(`${item.label} Text`, textX, y, textW, rowH, [p.para(item.text, layout.size, { min: 12 })], { anchor: "ctr", insets });
      y += rowH + layout.gap;
    });
  },

  terms(p, slide, body, ctx) {
    const { d } = p;
    const items = body.items;
    const cols = items.length > 3 ? 2 : 1;
    const rows = Math.ceil(items.length / cols);
    const gap = GRID.gap;
    const cellH = Math.min(inch(1.5), Math.floor((ctx.bottom - GRID.top - gap * (rows - 1)) / rows));
    const cells = gridCells(items.length, cols, { x: GRID.margin, y: GRID.top, cx: GRID.contentW, cy: ctx.bottom - GRID.top }, gap, cellH);
    // Fill column by column so the order reads down the left and then the right.
    items.forEach((item, i) => {
      const c = cells[cols === 2 ? (i % rows) * 2 + Math.floor(i / rows) : i];
      p.card(`Term ${i + 1}`, c.x, c.y, c.cx, c.cy);
      p.stripe(`Term ${i + 1}`, c.x, c.y, c.cy, d.accent);
      p.text(`Term ${i + 1} Text`, c.x + inch(0.28), c.y + inch(0.1), c.cx - inch(0.28) - GRID.pad, c.cy - inch(0.2), [p.head(item.term, 17, { color: d.accentText, after: 4, min: 14 }), p.para(`${item.plain}.`, 14, { min: 12 })], { anchor: "ctr" });
    });
  },

  quiz(p, slide, body, ctx) {
    const { d } = p;
    const qs = body.questions;
    const gap = GRID.gap;
    const qCols = qs.length <= 2 ? 1 : 2;
    const size = PARTS.circle;
    const lead = inch(0.26) + size + inch(0.18);
    const fullW = GRID.contentW;
    const halfW = Math.floor((fullW - gap) / 2);
    // Two columns; a last odd question spans the row. Each row is as tall as its tallest question needs.
    const cards = qs.map((q, i) => {
      const wide = qCols === 1 || (i === qs.length - 1 && qs.length % 2 === 1);
      const w = wide ? fullW : halfW;
      const paragraphs = [p.head(q.q, 16, { after: 6, min: 12 }), ...q.options.map((o, j) => p.para(`${LETTERS[j]}.  ${o}`, 14, { after: 3, min: 12 }))];
      const need = stackHeight(paragraphs, w - lead - GRID.pad, d) - Math.round(3 * PT) + inch(0.34);
      return { q, i, wide, w, paragraphs, need, row: qCols === 1 ? i : Math.floor(i / 2), col: qCols === 1 || wide ? 0 : i % 2 };
    });
    const rowCount = Math.max(...cards.map((c) => c.row)) + 1;
    const needs = Array.from({ length: rowCount }, (_v, r) => Math.max(inch(1.3), ...cards.filter((c) => c.row === r).map((c) => c.need)));
    const avail = ctx.bottom - GRID.top - gap * (rowCount - 1);
    const scale = Math.min(1, avail / needs.reduce((a, b) => a + b, 0));
    const heights = needs.map((h) => Math.floor(h * scale));
    cards.forEach((c) => {
      const y = GRID.top + heights.slice(0, c.row).reduce((a, b) => a + b + gap, 0);
      const x = GRID.margin + c.col * (halfW + gap);
      const h = heights[c.row];
      p.card(`Question ${c.i + 1}`, x, y, c.w, h);
      p.stripe(`Question ${c.i + 1}`, x, y, h, d.accent);
      p.circle(`Question ${c.i + 1} Number`, x + inch(0.26), y + inch(0.17), size, d.accent, c.i + 1);
      p.text(`Question ${c.i + 1} Text`, x + lead, y + inch(0.16), c.w - lead - GRID.pad, h - inch(0.26), c.paragraphs);
    });
  },

  labPreview(p, slide, body, ctx) {
    const { d } = p;
    const w = GRID.contentW;
    const noteParagraphs = [p.para(body.note, 14)];
    const noteH = p.calloutHeight(noteParagraphs, w);
    const x = GRID.margin + inch(0.5);
    const inner = w - inch(1.0);
    const moduleParagraphs = [p.head(body.moduleLabel, 28, { color: d.white, min: 18 })];
    const moduleH = Math.min(inch(1.3), stackHeight(moduleParagraphs, inner, d));
    const outcomeParagraphs = [p.para(body.outcome, 20, { color: d.onDark, min: 14 })];
    const outcomeH = stackHeight(outcomeParagraphs, inner, d);
    const used = inch(0.35) + moduleH + inch(0.15) + PARTS.pillH + inch(0.3) + outcomeH + inch(0.4);
    const panelH = clamp(used, inch(2.8), ctx.bottom - GRID.top - noteH - GRID.gap);
    p.deco("Lab Panel", "rect", GRID.margin, GRID.top, w, panelH, d.navy);
    p.deco("Lab Stripe", "rect", GRID.margin, GRID.top, PARTS.calloutStripeW, panelH, d.highlight);
    p.text("Module", x, GRID.top + inch(0.35), inner, moduleH, moduleParagraphs);
    const pillY = GRID.top + inch(0.35) + moduleH + inch(0.15);
    p.pill("Time", x, pillY, body.time, d.accent, { line: d.white, maxW: inner });
    const outcomeY = pillY + PARTS.pillH + inch(0.3);
    p.text("Outcome", x, outcomeY, inner, GRID.top + panelH - outcomeY - inch(0.3), outcomeParagraphs);
    p.callout("Note", GRID.margin, GRID.top + panelH + GRID.gap, w, noteH, noteParagraphs);
  },

  learn(p, slide, body, ctx) {
    const { d } = p;
    p.text("Intro", GRID.margin, GRID.top, GRID.contentW, inch(0.4), [p.para(body.intro, 15, { color: d.gray })], { anchor: "ctr" });
    const links = body.links || [];
    const top = GRID.top + inch(0.55);
    if (!links.length) {
      p.text("No Links", GRID.margin, top, GRID.contentW, inch(0.5), [p.para("Open Microsoft Learn and search for this topic.", 16)]);
      return;
    }
    const cols = links.length > 1 ? 2 : 1;
    const rows = Math.ceil(links.length / cols);
    const gap = GRID.gap;
    const cellH = Math.min(inch(1.15), Math.floor((ctx.bottom - top - gap * (rows - 1)) / rows));
    const cells = gridCells(links.length, cols, { x: GRID.margin, y: top, cx: GRID.contentW, cy: ctx.bottom - top }, gap, cellH);
    links.forEach((link, i) => {
      const c = cells[i];
      p.card(`Link ${i + 1}`, c.x, c.y, c.cx, c.cy);
      p.stripe(`Link ${i + 1}`, c.x, c.y, c.cy, d.accent);
      const title = link.title.replace(/[[\]]/g, "");
      p.text(
        `Link ${i + 1} Text`,
        c.x + inch(0.28),
        c.y + inch(0.08),
        c.cx - inch(0.28) - GRID.pad,
        c.cy - inch(0.16),
        [
          { runs: [{ text: title, url: link.url, colorHex: d.accentText, font: d.font.heading }], text: title, sizePt: 14, minPt: 12, spaceAfterPt: 4, lineSpacingPct: SPACING.body },
          p.para(shortUrl(link.url), 12, { color: d.grayDark, min: 11 }),
        ],
        { anchor: "ctr" },
      );
    });
  },

  what(p, slide, body, ctx) {
    const { d } = p;
    const w = GRID.contentW;
    const whoParagraphs = body.who ? [p.head(body.whoHeading, 18, { color: d.highlightInk, after: 6, min: 14 }), p.para(body.who, 18, { min: 13 })] : [];
    const whoH = whoParagraphs.length ? Math.min(inch(2.0), stackHeight(whoParagraphs, w - inch(0.28) - GRID.pad, d, { l: 0, t: inch(0.2), r: 0, b: inch(0.2) })) : 0;
    const sentenceH = ctx.bottom - GRID.top - (whoH ? whoH + GRID.gap : 0);
    const sentenceCapH = Math.min(sentenceH, inch(2.6));
    p.card("What It Is", GRID.margin, GRID.top, w, sentenceCapH);
    p.stripe("What It Is", GRID.margin, GRID.top, sentenceCapH, d.accent);
    p.text("What It Is", GRID.margin + inch(0.28), GRID.top, w - inch(0.28) - GRID.pad, sentenceCapH, [p.head(body.sentence, 26, { min: 18 })], { anchor: "ctr" });
    if (whoH) {
      const y = GRID.top + sentenceCapH + GRID.gap;
      p.card("Who Uses It", GRID.margin, y, w, whoH);
      p.stripe("Who Uses It", GRID.margin, y, whoH, d.highlight);
      p.text("Who Uses It", GRID.margin + inch(0.28), y, w - inch(0.28) - GRID.pad, whoH, whoParagraphs, { anchor: "ctr" });
    }
  },

  fitHub(p, slide, body, ctx) {
    const { d } = p;
    const around = body.around;
    const perRow = Math.ceil(around.length / 2);
    const gap = GRID.gap;
    const h = ctx.bottom - GRID.top;
    const centerH = clamp(Math.floor(h * 0.3), inch(1.1), inch(1.6));
    const rowH = Math.min(inch(1.7), Math.floor((h - centerH - gap * 2) / 2));
    const w = Math.floor((GRID.contentW - gap * (perRow - 1)) / perRow);
    const rowsOf = [around.slice(0, perRow), around.slice(perRow)];
    const y0 = GRID.top + Math.floor((h - (rowH * 2 + centerH + gap * 2)) / 2);
    p.group("How The Pieces Fit Diagram", slide.altText || `${body.center.label} in the middle, with ${around.map((a) => a.label).join(", ")} around it.`, () => {
      const tileRow = (items, y, offset) =>
        items.forEach((n, i) => {
          const x = GRID.margin + i * (w + gap) + Math.floor((GRID.contentW - (items.length * w + (items.length - 1) * gap)) / 2);
          p.card(`Part ${offset + i + 1}`, x, y, w, rowH);
          p.stripe(`Part ${offset + i + 1}`, x, y, rowH, d.accent);
          p.text(`Part ${offset + i + 1} Text`, x + inch(0.26), y + inch(0.08), w - inch(0.26) - inch(0.14), rowH - inch(0.16), [p.head(n.label, 16, { after: 3, min: 13 }), p.para(plainText(n.plain), 13, { min: 12 })], { anchor: "ctr" });
        });
      tileRow(rowsOf[0], y0, 0);
      const cy = y0 + rowH + gap;
      p.layer("Center", GRID.margin, cy, GRID.contentW, centerH, d.navy, body.center.label, plainText(body.center.plain));
      tileRow(rowsOf[1], cy + centerH + gap, rowsOf[0].length);
    });
  },

  vocab(p, slide, body, ctx) {
    DRAW.terms(p, slide, body, ctx);
  },

  where(p, slide, body, ctx) {
    const { d } = p;
    const w = GRID.contentW;
    const noteParagraphs = [p.para(body.note, 14)];
    const noteH = p.calloutHeight(noteParagraphs, w);
    let y = GRID.top;
    const harnessIds = body.harnessIds || [];
    if (body.sentence) {
      const paragraphs = [p.head(body.sentence, 24, { min: 16 })];
      const h = Math.min(inch(2.2), Math.max(inch(1.2), stackHeight(paragraphs, w - inch(0.28) - GRID.pad, d, { l: 0, t: inch(0.2), r: 0, b: inch(0.2) })));
      p.card("Where", GRID.margin, y, w, h);
      p.stripe("Where", GRID.margin, y, h, d.accent);
      p.text("Where", GRID.margin + inch(0.28), y, w - inch(0.28) - GRID.pad, h, paragraphs, { anchor: "ctr" });
      y += h + GRID.gap;
    }
    if (body.harness) {
      const names = harnessIds.map((id) => harnessShortName(id));
      const pillsW = names.reduce((sum, name) => sum + p.measureWidth(name, TYPE.pill) + PARTS.pillPadX * 2 + PARTS.pillGap, 0);
      const paragraphs = [p.para(body.harness, 15)];
      const h = Math.max(inch(0.8), p.calloutHeight(paragraphs, w - pillsW));
      p.deco("Where Harness Panel", "rect", GRID.margin, y, w, h, d.accentTint);
      p.deco("Where Harness Stripe", "rect", GRID.margin, y, PARTS.calloutStripeW, h, d.highlight);
      const textX = GRID.margin + inch(0.28);
      p.text("Where Harness", textX, y, GRID.margin + w - pillsW - GRID.pad - textX, h, paragraphs, { anchor: "ctr" });
      let x = GRID.margin + w - GRID.pad;
      [...harnessIds].reverse().forEach((id) => {
        const name = harnessShortName(id);
        const pw = p.measureWidth(name, TYPE.pill) + PARTS.pillPadX * 2;
        x -= pw;
        p.pill(`Harness ${name}`, x, y + (h - PARTS.pillH) / 2, name, harnessColors(d, id).fill, { w: pw });
        x -= PARTS.pillGap;
      });
      y += h + GRID.gap;
    }
    p.callout("Where Note", GRID.margin, ctx.bottom - noteH, w, noteH, noteParagraphs);
  },

  day(p, slide, body, ctx) {
    const { d } = p;
    p.text("Intro", GRID.margin, GRID.top, GRID.contentW, inch(0.4), [p.para(body.intro, 15, { color: d.gray })], { anchor: "ctr" });
    const rows = body.rows;
    const top = GRID.top + inch(0.55);
    const totals = [p.lead("Total:", `about ${body.totals.training} minutes of training, then about ${body.totals.handsOn} minutes hands-on.`, 15)];
    const totalsH = p.calloutHeight(totals, GRID.contentW);
    const room = ctx.bottom - top - totalsH - GRID.gap - (body.more ? inch(0.35) : 0);
    const rowH = clamp(Math.floor(room / (rows.length + 1)), inch(0.32), PARTS.tableRowH);
    const colTrain = inch(2.0);
    const colHands = inch(2.0);
    const columns = [{ w: GRID.contentW - colTrain - colHands, align: "l" }, { w: colTrain, align: "l" }, { w: colHands, align: "l" }];
    const cy = p.table("Day Table", `Table of ${rows.length} topics with minutes of training and hands-on time.`, GRID.margin, top, columns, ["Topic", "Training", "Hands-on"], rows.map((r) => [r.label, `${r.training} min`, r.handsOn ? `${r.handsOn} min` : "see the lab"]), { rowH, sizePt: rowH < inch(0.4) ? 12 : 13 });
    let y = top + cy + inch(0.08);
    if (body.more) {
      p.text("Day More", GRID.margin, y, GRID.contentW, inch(0.3), [p.para(`…and ${body.more}`, 13, { color: d.gray })], { anchor: "ctr" });
      y += inch(0.35);
    }
    p.callout("Day Totals", GRID.margin, Math.min(y + GRID.gapSmall, ctx.bottom - totalsH), GRID.contentW, totalsH, totals);
  },

  agenda(p, slide, body, ctx) {
    const { d } = p;
    const rows = body.rows;
    const cols = rows.length > 6 ? 2 : 1;
    const perCol = Math.ceil(rows.length / cols);
    const gap = GRID.gapSmall + inch(0.04);
    const total = body.showTotal ? [p.lead("Training:", `about ${body.totalMinutes} minutes. Then the hands-on lab: about ${body.handsOnMinutes} minutes.`, 15)] : [];
    const totalH = total.length ? p.calloutHeight(total, GRID.contentW) : 0;
    const area = { x: GRID.margin, y: GRID.top, cx: GRID.contentW, cy: ctx.bottom - GRID.top - (totalH ? totalH + GRID.gap : 0) };
    const colGap = GRID.gap;
    const colW = Math.floor((area.cx - colGap * (cols - 1)) / cols);
    const rowH = Math.min(inch(0.86), Math.floor((area.cy - gap * (perCol - 1)) / perCol));
    const harnessNames = rows.map((r) => (r.harness ? harnessShortName(r.harness) : ""));
    const tagW = Math.max(0, ...harnessNames.map((name) => (name ? p.measureWidth(name, 11) + inch(0.4) : 0)));
    const minutesW = inch(0.9);
    rows.forEach((r, i) => {
      const col = Math.floor(i / perCol);
      const row = i % perCol;
      const x = area.x + col * (colW + colGap);
      const y = area.y + row * (rowH + gap);
      const colors = r.harness ? harnessColors(d, r.harness) : { fill: d.accent, text: d.accentText };
      p.card(`Agenda ${r.n}`, x, y, colW, rowH);
      p.stripe(`Agenda ${r.n}`, x, y, rowH, colors.fill);
      const size = Math.min(PARTS.circle, rowH - inch(0.14));
      p.circle(`Agenda ${r.n} Number`, x + inch(0.26), y + (rowH - size) / 2, size, colors.fill, r.n);
      const textX = x + inch(0.26) + size + inch(0.18);
      const textW = colW - (textX - x) - minutesW - (tagW ? tagW + inch(0.2) : 0) - inch(0.1);
      p.text(`Agenda ${r.n}`, textX, y, textW, rowH, [p.head(r.label, 16, { min: 12 })], { anchor: "ctr", insets: { l: 0, t: inch(0.03), r: 0, b: inch(0.03) } });
      if (harnessNames[i]) p.pill(`Agenda ${r.n} Harness`, x + colW - minutesW - inch(0.1) - inch(0.05) - tagW, y + (rowH - inch(0.32)) / 2, harnessNames[i], colors.fill, { h: inch(0.32), sizePt: 11, w: tagW, line: colors.fill });
      p.text(`Agenda ${r.n} Minutes`, x + colW - minutesW - inch(0.1), y, minutesW, rowH, [p.para(`${r.minutes} min`, 13, { color: d.gray, align: "r" })], { anchor: "ctr" });
    });
    if (total.length) p.callout("Total", GRID.margin, ctx.bottom - totalH, GRID.contentW, totalH, total);
  },

  /** "Same idea, different place": one colored card for each harness, side by side. */
  compare(p, slide, body, ctx) {
    const { d } = p;
    // When both harnesses use the same word for the idea, the intro says so once instead of each column repeating it.
    const sameTerm = body.columns.length === 2 && body.columns.every((c) => c.term.toLowerCase() === body.columns[0].term.toLowerCase());
    const intro = sameTerm ? `${body.intro} Both call it “${body.columns[0].term}”.` : body.intro;
    const introH = stackHeight([p.para(intro, 15)], GRID.contentW, d) + inch(0.1);
    p.text("Intro", GRID.margin, GRID.top - inch(0.1), GRID.contentW, introH, [p.para(intro, 15, { color: d.gray })], { anchor: "ctr" });
    const top = GRID.top - inch(0.1) + introH + inch(0.05);
    const gap = GRID.gap;
    const colW = Math.floor((GRID.contentW - gap) / 2);
    const bandH = PARTS.bandHSmall;
    const columns = body.columns.map((col) => {
      const colors = harnessColors(d, col.harness);
      const rowsOf = [
        ...(sameTerm ? [] : [{ label: "Called", text: `“${col.term}”` }]),
        ...(col.summary ? [{ label: "What it is", text: col.summary }] : []),
        ...(col.where ? [{ label: "Where", text: col.where.replace(/^Where:\s*/i, "") }] : []),
        ...(col.limits.length ? [{ label: "Watch for", text: col.limits[0] }] : []),
      ];
      const paragraphs = rowsOf.map((r, j) => ({
        runs: [
          { text: `${r.label.toUpperCase()}  `, font: d.font.heading, sizePt: TYPE.label, colorHex: colors.text, tracking: TRACK.label },
          { text: r.text, colorHex: d.ink },
        ],
        sizePt: 14,
        minPt: 12,
        spaceAfterPt: j === rowsOf.length - 1 ? 0 : 9,
        lineSpacingPct: SPACING.body,
      }));
      return { col, colors, paragraphs };
    });
    const h = p.cardHeight(columns.map((c) => c.paragraphs), colW - GRID.pad * 2, { top: bandH + inch(0.18), bottomPad: inch(0.22), min: inch(2.6), max: ctx.bottom - top });
    columns.forEach(({ col, colors, paragraphs }, i) => {
      const x = GRID.margin + i * (colW + gap);
      p.card(`Harness ${i + 1}`, x, top, colW, h, { line: colors.fill, lineW: PARTS.schematicLine });
      p.band(`Harness ${i + 1}`, x, top, colW, bandH, colors.fill, col.name, { tag: col.availability, sizePt: 19 });
      p.text(`Harness ${i + 1} Text`, x + GRID.pad, top + bandH + inch(0.18), colW - GRID.pad * 2, h - bandH - inch(0.26), paragraphs);
    });
  },
};

// ── Cover, divider, and closing: the dark slides ─────────────────────────────

/** The coral bar and the concentric circles every dark slide carries (the circles only when there is room). */
function drawBackdrop(p, { circles = true, scale = 1, dx = 0, dy = 0 } = {}) {
  const { d } = p;
  intoChrome(p, () => {
    p.deco("Coral Bar", "rect", 0, 0, PARTS.cover.barW, GRID.slideH, d.highlight);
    if (!circles) return;
    PARTS.cover.circles.forEach((c, i) => {
      const size = inch(c.d * scale);
      const fill = c.tone === "highlight" ? d.highlight : d.accent;
      const x = inch(c.x) + dx + (inch(c.d) - size) / 2;
      const y = inch(c.y) + dy + (inch(c.d) - size) / 2;
      p.deco(`Circle ${i + 1}`, "ellipse", x, y, size, size, fill, { line: fill });
    });
  });
}

/** The harness (or neutral) pills of a title slide: the tags, then any harness not already named in them. */
function coverPills(p, body) {
  const { d } = p;
  const ids = body.harnessIds || [];
  const names = new Map(ids.map((id) => [harnessShortName(id), id]));
  const pills = (body.tags || []).map((text) => ({ text, fill: names.has(text) ? harnessColors(d, names.get(text)).fill : d.accent }));
  for (const [name, id] of names) if (!pills.some((x) => x.text === name)) pills.push({ text: name, fill: harnessColors(d, id).fill });
  return pills;
}

function drawCover(p, slide, s, ctx) {
  const { d } = p;
  const body = s.body;
  const x = PARTS.cover.textX;
  const w = PARTS.cover.textW;
  drawBackdrop(p);
  // Eyebrow, title, subtitle, and the outcomes are one stack; the largest title size wins only if the whole stack still fits above the pills.
  // A tall stack may start a little higher before any title is shortened.
  const pills = coverPills(p, body);
  const pillRows = [];
  {
    let row = [];
    let used = 0;
    for (const pill of pills) {
      const pw = p.measureWidth(pill.text, TYPE.pill) + PARTS.pillPadX * 2;
      if (used + pw > inch(8.2) && row.length) {
        pillRows.push(row);
        row = [];
        used = 0;
      }
      row.push({ ...pill, w: pw });
      used += pw + PARTS.pillGap;
    }
    if (row.length) pillRows.push(row);
  }
  const pillsTop = PARTS.cover.pillY - (pillRows.length - 1) * (PARTS.pillH + inch(0.1));
  const budgetBottom = pillsTop - inch(0.25);
  const outcomes = body.outcomes || [];
  const outcomeSize = 15;
  const outcomeW = w - inch(0.34) - inch(0.2);
  const outcomeHeights = outcomes.map((o) => Math.max(inch(0.34), stackHeight([p.para(o, outcomeSize, { color: d.white })], outcomeW, d)) + inch(0.12));
  const outcomesH = outcomes.length ? inch(0.32) + outcomeHeights.reduce((a, b) => a + b, 0) : 0;
  const subtitleSteps = TYPE.subtitle.map((sizePt) => ({ sizePt, spacingPct: SPACING.body }));
  const attempt = (titleSteps, maxTitleH) => {
    const title = fitHeading({ text: s.title, fontName: d.font.heading, widthEmu: w, maxHeightEmu: maxTitleH, steps: titleSteps });
    const subtitle = fitHeading({ text: body.subtitle || "", fontName: d.font.body, widthEmu: w, maxHeightEmu: inch(1.2), steps: subtitleSteps, bold: false });
    const subtitleH = body.subtitle ? subtitle.heightEmu : 0;
    const total = title.heightEmu + (subtitleH ? inch(0.15) + subtitleH : 0) + (outcomesH ? inch(0.3) + outcomesH : 0);
    return { title, subtitle, subtitleH, total };
  };
  let chosen = null;
  let shift = 0;
  for (const tryShift of [0, inch(0.25), inch(0.45)]) {
    for (const size of TYPE.coverTitle) {
      const t = attempt([{ sizePt: size, spacingPct: SPACING.heading }], Infinity);
      if (!t.title.shortened && PARTS.cover.titleY - tryShift + t.total <= budgetBottom) {
        chosen = t;
        shift = tryShift;
        break;
      }
    }
    if (chosen) break;
  }
  if (!chosen) {
    // Even the smallest size does not fit: the title is shortened to what is left (the full text stays in the notes and the alt text).
    shift = inch(0.45);
    const smallest = TYPE.coverTitle[TYPE.coverTitle.length - 1];
    const rest = attempt([{ sizePt: smallest, spacingPct: SPACING.heading }], Infinity);
    const fixed = rest.total - rest.title.heightEmu;
    chosen = attempt([{ sizePt: smallest, spacingPct: SPACING.heading }], Math.max(linesHeightEmu(1, smallest, d.font.heading, SPACING.heading), budgetBottom - (PARTS.cover.titleY - shift) - fixed));
  }
  const titleTop = PARTS.cover.titleY - shift;
  if (chosen.title.shortened) ctx.notes.push(`FULL TITLE: ${chosen.title.fullText}`);
  if (chosen.subtitle.shortened) ctx.notes.push(`FULL SUBTITLE: ${chosen.subtitle.fullText}`);

  addTitle(slide, p, { fit: chosen.title, x, y: titleTop, cx: w, cy: chosen.title.heightEmu }, d.white);
  addEyebrow(slide, p, s.eyebrow, { x, y: PARTS.cover.eyebrowY - shift, h: inch(0.4), width: w, color: d.highlightOnDark, sizes: [TYPE.coverEyebrow, 13, 12], tracking: TRACK.cover });
  let y = titleTop + chosen.title.heightEmu;
  if (chosen.subtitleH) {
    y += inch(0.15);
    p.text("Subtitle", x, y, w, chosen.subtitleH + inch(0.02), [p.para(chosen.subtitle.text, chosen.subtitle.sizePt, { color: d.onDark, min: chosen.subtitle.sizePt })]);
    y += chosen.subtitleH;
  }
  if (outcomes.length) {
    y += inch(0.3);
    p.text("Outcomes Heading", x, y, w, inch(0.3), [p.label(body.outcomesHeading || "", d.highlightOnDark, { after: 0 })], { anchor: "ctr" });
    y += inch(0.32);
    outcomes.forEach((o, i) => {
      const rowH = outcomeHeights[i];
      const size = inch(0.34);
      p.circle(`Outcome ${i + 1} Number`, x, y + (rowH - size) / 2 - inch(0.02), size, d.highlightFill, i + 1, { sizePt: 12, line: d.highlightFill });
      p.text(`Outcome ${i + 1}`, x + size + inch(0.2), y, outcomeW, rowH, [p.para(o, outcomeSize, { color: d.white })], { anchor: "ctr" });
      y += rowH;
    });
  }
  pillRows.forEach((row, r) => {
    let px = x;
    row.forEach((pill, i) => {
      p.pill(`Tag ${r * 10 + i + 1}`, px, pillsTop + r * (PARTS.pillH + inch(0.1)), pill.text, pill.fill, { w: pill.w });
      px += pill.w + PARTS.pillGap;
    });
  });
  const series = [slide.deck.organizationName || "", "Pre-lab training: ideas first, then the hands-on lab."].filter(Boolean).join("  ·  ");
  p.text("Series", x, PARTS.cover.seriesY, w, inch(0.3), [p.para(series, TYPE.series, { color: d.onDarkSoft, min: 10 })], { anchor: "ctr" });
  if (slide.deck.logoMedia) {
    const plateW = inch(2.0);
    const plateH = inch(0.62);
    const px = SLIDE_CX - GRID.margin - plateW;
    p.deco("Logo Plate", "roundRect", px, inch(0.2), plateW, plateH, d.white, { adj: 12000 });
    slide.addPicture({ media: slide.deck.logoMedia, x: px + inch(0.1), y: inch(0.26), maxCx: plateW - inch(0.2), maxCy: plateH - inch(0.12), alt: slide.deck.organizationName ? `${slide.deck.organizationName} logo` : "Organization logo" });
  }
  return chosen.title;
}

/** A section divider: where we are in the training, on a dark slide. The current part is filled with its harness color and name. */
DRAW.divider = function divider(p, slide, body, ctx) {
  const { d } = p;
  const rows = body.rows;
  const windowed = rows.length > 12 ? rows.slice(Math.max(0, Math.min(body.current - 3, rows.length - 7)), Math.max(0, Math.min(body.current - 3, rows.length - 7)) + 7) : rows;
  const top = GRID.top;
  const listW = inch(7.4);
  const rowGap = inch(0.08);
  const rowH = Math.min(inch(0.68), Math.floor((ctx.bottom - top - rowGap * (windowed.length - 1)) / windowed.length));
  const current = rows[body.current];
  const currentColors = current?.harness ? harnessColors(d, current.harness) : { fill: d.accent };
  windowed.forEach((r, i) => {
    const isCurrent = r.n - 1 === body.current;
    const y = top + i * (rowH + rowGap);
    const colors = r.harness ? harnessColors(d, r.harness) : { fill: d.accent };
    if (isCurrent) p.deco(`Section ${r.n} Panel`, "rect", GRID.margin, y, listW, rowH, colors.fill);
    const size = Math.min(inch(0.42), rowH - inch(0.12));
    p.circle(`Section ${r.n} Number`, GRID.margin + inch(0.18), y + (rowH - size) / 2, size, isCurrent ? d.white : d.navy, r.n, { color: isCurrent ? colors.fill : d.onDarkSoft, line: isCurrent ? d.white : d.onDarkSoft, lineW: PARTS.cardLine });
    const minutesW = inch(0.9);
    const x = GRID.margin + inch(0.18) + size + inch(0.2);
    p.text(`Section ${r.n}`, x, y, listW - (x - GRID.margin) - minutesW - inch(0.15), rowH, [p.head(r.label, isCurrent ? 18 : 15, { color: isCurrent ? d.white : d.onDark, min: 12 })], { anchor: "ctr" });
    p.text(`Section ${r.n} Minutes`, GRID.margin + listW - minutesW - inch(0.15), y, minutesW, rowH, [p.para(`${r.minutes} min`, 13, { color: isCurrent ? d.white : d.onDarkSoft, align: "r" })], { anchor: "ctr" });
  });
  const cardX = GRID.margin + listW + inch(0.5);
  const cardW = GRID.margin + GRID.contentW - cardX;
  const cardH = inch(3.0);
  p.deco("Part Panel", "rect", cardX, top, cardW, cardH, currentColors.fill);
  const harnessName = current?.harness ? harnessShortName(current.harness) : "";
  const inner = cardW - inch(0.5);
  const paragraphs = [
    p.label(harnessName ? `This part · ${harnessName}` : "This part", d.white, { after: 8 }),
    p.head(`About ${body.minutes} minutes`, 24, { color: d.white, after: 8, min: 16 }),
    p.para(`The whole training is about ${body.totalMinutes} minutes.`, 14, { color: d.white }),
  ];
  p.text("Part Time", cardX + inch(0.25), top + inch(0.2), inner, cardH - inch(0.4), paragraphs, { anchor: "ctr" });
};

/** The closing slide mirrors the title slide: dark, numbered, with the same bar and circles. */
DRAW.closing = function closing(p, slide, body, ctx) {
  const { d } = p;
  const rows = body.rows;
  const cols = rows.length > 5 ? 2 : 1;
  const perCol = Math.ceil(rows.length / cols);
  const w = GRID.contentW;
  const introParagraphs = [p.head(body.intro, 20, { color: d.white, min: 16 })];
  const introH = Math.min(inch(0.9), stackHeight(introParagraphs, cols === 1 ? inch(8.1) : w, d));
  p.text("Intro", GRID.margin, GRID.top, cols === 1 ? inch(8.1) : w, introH, introParagraphs, { anchor: "ctr" });
  const top = GRID.top + introH + inch(0.3);
  const more = body.more ? inch(0.4) : 0;
  const rowH = Math.min(inch(0.78), Math.floor((ctx.bottom - top - more) / perCol));
  const colW = cols === 1 ? inch(8.1) : Math.floor((w - GRID.gap) / 2);
  rows.forEach((r, i) => {
    const col = Math.floor(i / perCol);
    const row = i % perCol;
    const x = GRID.margin + col * (colW + GRID.gap);
    const y = top + row * rowH;
    const size = Math.min(inch(0.5), rowH - inch(0.1));
    const fill = r.harness ? harnessColors(d, r.harness).fill : d.highlightFill;
    p.circle(`Lab Part ${i + 1} Number`, x, y + (rowH - size) / 2, size, fill, i + 1, { line: fill });
    const timeW = inch(1.0);
    p.text(`Lab Part ${i + 1}`, x + size + inch(0.2), y, colW - size - inch(0.2) - timeW, rowH, [p.para(r.label, 16, { color: d.white })], { anchor: "ctr" });
    if (r.handsOn) p.text(`Lab Part ${i + 1} Minutes`, x + colW - timeW, y, timeW, rowH, [p.para(`${r.handsOn} min`, 14, { color: d.onDarkSoft, align: "r" })], { anchor: "ctr" });
  });
  if (body.more) p.text("More", GRID.margin, top + perCol * rowH, w, more, [p.para(`…and ${body.more}`, 14, { color: d.onDarkSoft })], { anchor: "ctr" });
};

const DARK_KINDS = new Set(["divider", "closing"]);

// ── Render ───────────────────────────────────────────────────────────────────

/**
 * Render a deck spec (from training-slides.js) to a .pptx buffer.
 *
 * @param {object} spec deck spec
 * @param {{branding?: object, library?: object, title?: string}} options
 * @returns {{buffer: Buffer, overflow: Array<{slide: string, shape: string, needed: number, have: number}>}}
 */
export function renderTrainingDeck(spec, { branding, library = loadTrainingLibrary(), title } = {}) {
  const deck = new TrainingDeckAssembler({ title: title || spec.title, branding });
  const overflow = [];
  const d = deck.design;
  spec.slides.forEach((s, index) => {
    const label = `${index + 1}. ${s.title}`;
    const isCover = s.kind === "title";
    const dark = isCover || DARK_KINDS.has(s.kind);
    const slide = deck.createSlide({ isHero: true, bgHex: dark ? d.navy : d.page, footerLast: true, footerContext: spec.title, dark, noFooter: isCover });
    const painter = new Painter(deck, slide, overflow, label);
    slide.altText = s.alt || "";
    const extraNotes = [];
    const strip = isCover || dark ? { top: GRID.bottom, draw() {} } : wordsStrip(painter, s.words, library);
    let titleFit;
    if (isCover) {
      titleFit = drawCover(painter, slide, s, { notes: extraNotes });
    } else {
      if (dark) drawBackdrop(painter, { circles: s.kind === "closing" && (s.body.rows || []).length <= 5, scale: 0.8 });
      const header = layoutContentTitle(painter, s.title);
      addTitle(slide, painter, header, dark ? d.white : d.ink);
      addEyebrow(slide, painter, s.eyebrow, { color: dark ? d.highlightOnDark : d.accentText });
      if (s.kind !== "compare") addPartTag(painter, s.partTag);
      const draw = DRAW[s.kind];
      if (!draw) throw new Error(`No drawing for training slide kind "${s.kind}"`);
      draw(painter, slide, s.body, { bottom: strip.top, notes: extraNotes });
      strip.draw();
      titleFit = header.fit;
    }
    slide.setNotes(s.notes || []);
    // Nothing is lost when a title or subtitle had to be shortened: the full text is in the speaker notes (and, for the title, its alt text).
    if (titleFit?.shortened && !extraNotes.some((n) => n.startsWith("FULL TITLE:"))) extraNotes.unshift(`FULL TITLE: ${titleFit.fullText}`);
    if (extraNotes.length) slide.appendNotes(extraNotes);
  });
  return { buffer: deck.toPptxBuffer(), overflow };
}
