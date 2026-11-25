/**
 * Reads the layout of a generated PowerPoint slide the way a reviewer would: every top-level shape's rectangle,
 * its text, its anchor, and its alt text, straight from the slide XML. Used by the title-fit tests and by the
 * before/after audit script; it never calls the builders, so it judges their output, not their intentions.
 */

import { deflateSync } from "node:zlib";

import { wrapText, linesHeightEmu, fontFactors, measureWidthPt } from "../../lib/lab-builder/pptx-text-fit.js";

export const SLIDE_W = 12192000;
export const FOOTER_TOP = 6858000 - 365760;
export const FOOTER_NAMES = new Set(["Footer Context", "Slide Counter"]);
export const CHROME_NAMES = new Set(["Brand Bar", "Brand Bar Secondary", "Hero Brand Top Bar", "Cover Top Bar", "Eyebrow", "Title", "Slide Title", "Slide Kicker", "Slide Badge", "Header Divider", "Part Tag", "Series", ...FOOTER_NAMES]);

const decode = (text) => String(text).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&amp;/g, "&");

/** Runs of text in a piece of slide XML: text, size, weight, color, typeface, and the link it carries. */
function parseRuns(body) {
  return [...body.matchAll(/<a:r>([\s\S]*?)<\/a:r>/g)].map((r) => ({
    text: decode((r[1].match(/<a:t[^>]*>([^<]*)<\/a:t>/) || [null, ""])[1]),
    sizePt: Number((r[1].match(/sz="(\d+)"/) || [null, "1300"])[1]) / 100,
    bold: /\bb="1"/.test(r[1]),
    color: (r[1].match(/<a:solidFill><a:srgbClr val="([0-9A-Fa-f]{6})"/) || [null, ""])[1].toUpperCase(),
    font: (r[1].match(/<a:latin typeface="([^"]*)"/) || [null, ""])[1],
    link: /<a:hlinkClick\b/.test(r[1]),
  }));
}

/**
 * Every shape of a slide, in drawing order, including the children of a group: its rectangle, geometry, fill, outline,
 * whether it is marked decorative, its text runs, and whether it sits in a group. Judges the file, not the builder.
 */
export function parseAllShapes(xml) {
  const groups = [...xml.matchAll(/<p:grpSp>[\s\S]*?<\/p:grpSp>/g)].map((m) => [m.index, m.index + m[0].length]);
  return [...xml.matchAll(/<p:sp>([\s\S]*?)<\/p:sp>/g)].map((m) => {
    const body = m[1];
    const off = body.match(/<a:off x="(-?\d+)" y="(-?\d+)"\/>/);
    const ext = body.match(/<a:ext cx="(\d+)" cy="(\d+)"\/>/);
    const spPr = (body.match(/<p:spPr>([\s\S]*?)<\/p:spPr>/) || [null, ""])[1];
    const bodyPr = body.match(/<a:bodyPr([^>]*)>/);
    const inset = (n) => Number((bodyPr?.[1].match(new RegExp(`${n}="(\\d+)"`)) || [null, "0"])[1]);
    const runs = parseRuns(body);
    return {
      name: decode((body.match(/<p:cNvPr id="\d+" name="([^"]*)"/) || [null, ""])[1]),
      descr: decode((body.match(/<p:cNvPr id="\d+" name="[^"]*" descr="([^"]*)"/) || [null, ""])[1]),
      placeholder: /<p:ph\b/.test(body),
      inGroup: groups.some(([a, b]) => m.index > a && m.index < b),
      decorative: /<adec:decorative\b[^>]*val="1"/.test(body),
      geom: (spPr.match(/prst="(\w+)"/) || [null, "rect"])[1],
      adj: (spPr.match(/<a:gd name="adj" fmla="val (\d+)"/) || [null, null])[1],
      fill: ((spPr.match(/<\/a:prstGeom>\s*<a:solidFill><a:srgbClr val="([0-9A-Fa-f]{6})"/) || [null, null])[1] || "").toUpperCase() || null,
      line: ((spPr.match(/<a:ln\b[^>]*>\s*<a:solidFill><a:srgbClr val="([0-9A-Fa-f]{6})"/) || [null, null])[1] || "").toUpperCase() || null,
      x: off ? Number(off[1]) : 0,
      y: off ? Number(off[2]) : 0,
      cx: ext ? Number(ext[1]) : 0,
      cy: ext ? Number(ext[2]) : 0,
      insets: { l: inset("lIns"), t: inset("tIns"), r: inset("rIns"), b: inset("bIns") },
      anchor: (bodyPr?.[1].match(/anchor="(\w+)"/) || [null, "t"])[1],
      runs: runs.filter((r) => r.text),
      text: runs.map((r) => r.text).join(""),
    };
  });
}

/** The tables of a slide: each cell's fill and text runs, plus the table's name and alt text. */
export function parseTables(xml) {
  return [...xml.matchAll(/<p:graphicFrame>([\s\S]*?)<\/p:graphicFrame>/g)].map((m) => ({
    name: decode((m[1].match(/<p:cNvPr id="\d+" name="([^"]*)"/) || [null, ""])[1]),
    descr: decode((m[1].match(/<p:cNvPr id="\d+" name="[^"]*" descr="([^"]*)"/) || [null, ""])[1]),
    rows: [...m[1].matchAll(/<a:tr\b[^>]*>([\s\S]*?)<\/a:tr>/g)].map((row) =>
      [...row[1].matchAll(/<a:tc>([\s\S]*?)<\/a:tc>/g)].map((cell) => ({
        fill: ((cell[1].match(/<\/a:lnB>\s*<a:solidFill><a:srgbClr val="([0-9A-Fa-f]{6})"/) || [null, ""])[1]).toUpperCase(),
        runs: parseRuns(cell[1]).filter((r) => r.text),
      })),
    ),
  }));
}

/** The background color of a slide. */
export function slideBackground(xml) {
  return ((xml.match(/<p:bg>[\s\S]*?<a:srgbClr val="([0-9A-Fa-f]{6})"/) || [null, "FFFFFF"])[1]).toUpperCase();
}

/** The notes lines of one slide are read by the caller; this is the fixed footer position the training decks use. */
export const TRAINING_FOOTER_Y = 6473952;

/** The top-level elements of a slide's shape tree, in reading order. Children of a group are not listed on their own. */
export function parseSlideElements(xml) {
  const tree = (xml.match(/<p:spTree>([\s\S]*)<\/p:spTree>/) || [null, ""])[1];
  const tags = [...tree.matchAll(/<(\/?)p:(sp|pic|graphicFrame|grpSp)\b[^>]*>/g)];
  const out = [];
  for (let i = 0; i < tags.length; i += 1) {
    const [raw, closing, type] = tags[i];
    if (closing) continue;
    let end = i;
    if (type === "grpSp") {
      let depth = 0;
      for (let j = i; j < tags.length; j += 1) {
        if (tags[j][2] !== "grpSp") continue;
        depth += tags[j][1] ? -1 : 1;
        if (depth === 0) { end = j; break; }
      }
    } else {
      end = tags.findIndex((t, j) => j > i && t[1] && t[2] === type);
    }
    const start = tags[i].index;
    const stop = tags[end].index + tags[end][0].length;
    const body = tree.slice(start, stop);
    i = end;
    const off = body.match(/<a:off x="(-?\d+)" y="(-?\d+)"\/>/);
    const ext = body.match(/<a:ext cx="(\d+)" cy="(\d+)"\/>/);
    const name = decode((body.match(/<p:cNvPr id="\d+" name="([^"]*)"/) || [null, ""])[1]);
    const descr = decode((body.match(/<p:cNvPr id="\d+" name="[^"]*" descr="([^"]*)"/) || [null, ""])[1]);
    const paragraphs = [...body.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)].map((m) => {
      const p = m[1];
      const runs = [...p.matchAll(/<a:r>([\s\S]*?)<\/a:r>/g)].map((r) => ({
        text: decode(((r[1].match(/<a:t[^>]*>([^<]*)<\/a:t>/) || [null, ""])[1])),
        sizePt: Number((r[1].match(/sz="(\d+)"/) || [null, "1300"])[1]) / 100,
        bold: /\bb="1"/.test(r[1]),
        font: (r[1].match(/<a:latin typeface="([^"]*)"/) || [null, ""])[1],
      }));
      return {
        text: runs.map((r) => r.text).join(""),
        sizePt: runs[0]?.sizePt || 13,
        bold: runs.some((r) => r.bold),
        font: runs[0]?.font || "",
        spacingPct: Number((p.match(/<a:spcPct val="(\d+)"/) || [null, "118000"])[1]),
        spaceAfterPt: Number((p.match(/<a:spcAft><a:spcPts val="(\d+)"/) || [null, "0"])[1]) / 100,
        bulleted: /<a:buChar/.test(p),
      };
    });
    const bodyPr = body.match(/<a:bodyPr([^>]*)>/);
    const attr = (name2) => (bodyPr ? (bodyPr[1].match(new RegExp(`${name2}="(\\d+)"`)) || [null, "0"])[1] : "0");
    out.push({
      type,
      name,
      descr,
      decorative: /<adec:decorative\b[^>]*val="1"/.test(body),
      x: off ? Number(off[1]) : 0,
      y: off ? Number(off[2]) : 0,
      cx: ext ? Number(ext[1]) : 0,
      cy: ext ? Number(ext[2]) : 0,
      anchor: bodyPr ? (bodyPr[1].match(/anchor="(\w+)"/) || [null, "t"])[1] : null,
      insets: { l: Number(attr("lIns")), t: Number(attr("tIns")), r: Number(attr("rIns")), b: Number(attr("bIns")) },
      paragraphs,
      text: paragraphs.map((p) => p.text).join(" ").trim(),
      bottom: (off ? Number(off[2]) : 0) + (ext ? Number(ext[2]) : 0),
      right: (off ? Number(off[1]) : 0) + (ext ? Number(ext[1]) : 0),
    });
  }
  return out;
}

/** Estimated height in EMU of a shape's text, from the same width table the builders use. */
export function estimateShapeTextHeight(shape, { widthEmu = shape.cx - shape.insets.l - shape.insets.r } = {}) {
  let total = 0;
  for (const p of shape.paragraphs) {
    if (!p.text) continue;
    const lines = wrapText(p.text, widthEmu - (p.bulleted ? 251460 : 0), p.sizePt, p.font, { bold: p.bold }).length;
    total += linesHeightEmu(lines, p.sizePt, p.font, p.spacingPct) + Math.round(p.spaceAfterPt * 12700);
  }
  return total + shape.insets.t + shape.insets.b;
}

const overlapsY = (a, b) => a.y < b.bottom && b.y < a.bottom;
const overlapsX = (a, b) => a.x < b.right && b.x < a.right;
export const overlaps = (a, b) => overlapsY(a, b) && overlapsX(a, b);

/**
 * A title slide whose lab line, title, subtitle, and summary are one flowing text shape (the topic title slide and the cover
 * of a lab deck): its text must fit the shape, the shape must end before the next element starts, and no line may run
 * under the logo.
 */
function auditHeroPanel(shapes, body) {
  const problems = [];
  const panel = shapes.find((s) => s.name === "Hero Accent Panel" || s.name === "Cover Hero Box");
  if (!panel) return problems;
  const needed = estimateShapeTextHeight(panel);
  if (needed > panel.cy) problems.push(`the text of "${panel.name}" needs ${needed} EMU but the shape is ${panel.cy} EMU tall`);
  for (const s of body) {
    if (s === panel || s.type === "pic" || s.y < panel.y) continue;
    if (s.y < panel.bottom && overlapsX(s, panel)) problems.push(`"${panel.name}" (ends ${panel.bottom}) overlaps "${s.name}" (starts ${s.y})`);
  }
  const pic = shapes.find((s) => s.type === "pic");
  if (pic) {
    const left = panel.x + panel.insets.l;
    const width = panel.cx - panel.insets.l - panel.insets.r;
    let cursor = panel.y + panel.insets.t;
    for (const p of panel.paragraphs) {
      if (!p.text) continue;
      const lineH = linesHeightEmu(1, p.sizePt, p.font, p.spacingPct);
      wrapText(p.text, width, p.sizePt, p.font, { bold: p.bold }).forEach((line, k) => {
        const top = cursor + k * lineH;
        const reach = left + measureWidthPt(line, p.sizePt, p.font, { bold: p.bold }) * 12700;
        if (top < pic.bottom && top + lineH > pic.y && reach > pic.x) problems.push(`a line of "${panel.name}" ("${line.slice(0, 40)}") runs under the logo`);
      });
      cursor += linesHeightEmu(wrapText(p.text, width, p.sizePt, p.font, { bold: p.bold }).length, p.sizePt, p.font, p.spacingPct) + Math.round(p.spaceAfterPt * 12700);
    }
  }
  const first = panel.paragraphs[0];
  if (first && wrapText(first.text, panel.cx - panel.insets.l - panel.insets.r, first.sizePt, first.font, { bold: first.bold }).length > 1) problems.push("the first line of the panel wraps to a second line");
  return problems;
}

/**
 * Everything wrong with the top of one slide, as plain sentences; an empty list means the eyebrow, title, subtitle,
 * and first body element each have their own room. `notes` is the slide's speaker-note lines.
 */
export function auditSlideTop(slideXml, { notes = [], fullTitle = null, minTitlePt = 18, logo = false, margin = 640080 } = {}) {
  const problems = [];
  const shapes = parseSlideElements(slideXml);
  const byName = (n) => shapes.find((s) => s.name === n);
  const title = byName("Title") || byName("Slide Title");
  const hero = !title;
  // Decorative shapes (a bar, circles, a logo plate) are part of the backdrop; they may sit behind or beside text.
  const body = shapes.filter((s) => !CHROME_NAMES.has(s.name) && !s.decorative);
  const eyebrow = byName("Eyebrow");
  const kicker = byName("Slide Kicker");
  const badge = byName("Slide Badge");
  const divider = byName("Header Divider");

  if (hero) return auditHeroPanel(shapes, body);

  if (title.anchor !== "t") problems.push(`the title is anchored "${title.anchor}", so a long title grows up into the line above it`);
  const first = title.paragraphs[0];
  const lines = wrapText(title.text, title.cx, first.sizePt, first.font, { bold: true }).length;
  const needed = linesHeightEmu(lines, first.sizePt, first.font, first.spacingPct);
  if (needed > title.cy) problems.push(`the title needs ${needed} EMU (${lines} lines at ${first.sizePt} pt) but its box is ${title.cy} EMU tall`);
  if (first.sizePt < minTitlePt) problems.push(`the title is ${first.sizePt} pt, under the ${minTitlePt} pt minimum`);
  if (title.right > SLIDE_W - margin + 1) problems.push("the title runs past the right margin");
  if (eyebrow && overlaps(eyebrow, title)) problems.push(`the eyebrow (${eyebrow.y}-${eyebrow.bottom}) and the title (${title.y}-${title.bottom}) overlap`);
  if (kicker && overlaps(kicker, title)) problems.push(`the kicker (${kicker.y}-${kicker.bottom}) and the title (${title.y}-${title.bottom}) overlap`);
  if (badge && overlaps(badge, title)) problems.push(`the badge (${badge.y}-${badge.bottom}) and the title (${title.y}-${title.bottom}) overlap`);
  if (divider && divider.y < title.bottom) problems.push(`the title ends at ${title.bottom}, below the divider at ${divider.y}`);
  for (const shape of body) {
    if (shape.type === "pic") continue;
    if (shape.y < title.bottom) problems.push(`"${shape.name}" starts at ${shape.y}, inside the title (ends ${title.bottom})`);
    if (divider && shape.y < divider.bottom) problems.push(`"${shape.name}" starts at ${shape.y}, inside the header (divider ends ${divider.bottom})`);
    if (shape.bottom > FOOTER_TOP + 1 && !shape.name.startsWith("Slide")) problems.push(`"${shape.name}" ends at ${shape.bottom}, over the footer at ${FOOTER_TOP}`);
  }

  const subtitle = byName("Subtitle");
  if (subtitle) {
    const sp = subtitle.paragraphs[0];
    const subLines = wrapText(subtitle.text, subtitle.cx, sp.sizePt, sp.font, { bold: sp.bold }).length;
    const subNeeded = linesHeightEmu(subLines, sp.sizePt, sp.font, sp.spacingPct);
    if (subNeeded > subtitle.cy) problems.push(`the subtitle needs ${subNeeded} EMU but its box is ${subtitle.cy} EMU tall`);
    const below = body.filter((s) => s !== subtitle && s.y >= subtitle.y);
    for (const s of below) if (overlaps(subtitle, s)) problems.push(`the subtitle (${subtitle.y}-${subtitle.bottom}) and "${s.name}" (${s.y}-${s.bottom}) overlap`);
  }
  if (logo) {
    const pic = shapes.find((s) => s.type === "pic");
    if (pic && overlaps(title, pic)) problems.push(`the title box overlaps the logo (${pic.x},${pic.y})`);
  }

  if (fullTitle && fullTitle !== title.text) {
    if (title.descr !== fullTitle) problems.push("the title was shortened but its alt text does not hold the full title");
    if (!notes.some((line) => line.includes(fullTitle))) problems.push("the title was shortened but the speaker notes do not hold the full title");
  } else if (!fullTitle && title.text.includes("\u2026")) {
    if (!title.descr) problems.push("the title was shortened but its alt text is empty");
    else if (!notes.some((line) => line.includes(title.descr))) problems.push("the title was shortened but the speaker notes do not hold the full title");
  }
  if (eyebrow) {
    const ep = eyebrow.paragraphs[0];
    const eyebrowLines = wrapText(eyebrow.text, eyebrow.cx, ep.sizePt, ep.font, { bold: true }).length;
    if (eyebrowLines > 1) problems.push(`the eyebrow wraps to ${eyebrowLines} lines in a one-line box`);
  }
  return problems;
}

/** A solid-color PNG, so a deck can carry a logo without a real brand asset. */
export function makeLogoPng(width = 240, height = 80, rgb = [15, 108, 189]) {
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i += 1) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const typeBuf = Buffer.from(type, "ascii");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

export { fontFactors };
