/**
 * The Prerequisites checklist as a Word (.docx) document.
 *
 * Written directly as WordprocessingML (like `docx-builder.js`, whose zip writer and image
 * helpers it reuses) because the checklist needs layout the Markdown pipeline does not offer:
 * fixed column widths, rows that never split across pages, a repeating header row, headings that
 * stay with their table, a different first page, and "Page X of Y" in the footer on every page.
 */

import { buildZipBuffer, inspectImageDimensions, stripIllegalXmlChars } from "./docx-builder.js";
import { contrastRatio, ensureReadableColor, getBrandFont, normalizeHexColor6 } from "./brand-theme.js";
import {
  checklistInlineSegments,
  checklistItemParts,
  checklistPlainText,
  formatItemNumbers,
} from "./prereq-checklist.js";

const PAGE_W = 12240;
const PAGE_H = 15840;
const MARGIN_X = 1080;
const CONTENT_W = PAGE_W - MARGIN_X * 2; // 10080 twips
const INK = "1F2937";
const MUTED = "475569";
const LINE = "CBD5E1";

const xml = (value) =>
  stripIllegalXmlChars(String(value ?? ""))
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const hex6 = (value, fallback) => (normalizeHexColor6(value) || `#${fallback}`).slice(1).toUpperCase();

function mixWithWhite(hex, amount) {
  const color = `#${hex}`;
  const channels = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  return channels
    .map((c) => Math.round(c + (255 - c) * amount).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

/**
 * @param {object} model from `buildPrerequisitesChecklist`
 * @param {object} [options]
 * @param {object} [options.branding] `{ companyName, tagline, primaryColor, secondaryColor, font, coverSubtitle, footerText, logoBuffer }`
 */
export function renderPrerequisitesChecklistDocxBuffer(model, { branding } = {}) {
  const brand = branding && typeof branding === "object" ? branding : {};
  const primaryHex = hex6(brand.primaryColor, "0F6CBD");
  const accent = ensureReadableColor(`#${primaryHex}`, ["#ffffff"], "#0b2a5b", 4.5).slice(1).toUpperCase();
  const bandText = contrastRatio(`#${primaryHex}`, "#ffffff") >= contrastRatio(`#${primaryHex}`, "#0b0e14") ? "FFFFFF" : "0B0E14";
  const secondary = brand.secondaryColor ? hex6(brand.secondaryColor, "") : "";
  const rule = secondary || LINE;
  const tint = mixWithWhite(primaryHex, 0.9);
  const fontName = getBrandFont(brand.font).office || "Segoe UI";
  const companyName = String(brand.companyName || "").trim();
  const showCompany = companyName && companyName !== "Microsoft AI Training Generator";

  const hyperlinks = [];
  const images = [];
  let drawingId = 1;

  const linkRel = (url) => {
    const target = String(url || "").trim();
    if (!/^https?:\/\//i.test(target)) return null;
    const existing = hyperlinks.find((h) => h.target === target);
    if (existing) return existing.rId;
    const rId = `rIdLink${hyperlinks.length + 1}`;
    hyperlinks.push({ rId, target });
    return rId;
  };

  // Child order follows the WordprocessingML schema: rFonts, b, i, caps, color, spacing, sz, szCs, u.
  const run = (text, p = {}) => {
    const value = String(text ?? "");
    if (!value) return "";
    const rPr = [];
    if (p.symbol) rPr.push('<w:rFonts w:ascii="Segoe UI Symbol" w:hAnsi="Segoe UI Symbol" w:eastAsia="Segoe UI Symbol" w:cs="Segoe UI Symbol"/>');
    if (p.bold) rPr.push("<w:b/>");
    if (p.italic) rPr.push("<w:i/>");
    if (p.caps) rPr.push("<w:caps/>");
    if (p.color) rPr.push(`<w:color w:val="${p.color}"/>`);
    if (p.spacing) rPr.push(`<w:spacing w:val="${p.spacing}"/>`);
    if (p.size) rPr.push(`<w:sz w:val="${p.size}"/><w:szCs w:val="${p.size}"/>`);
    if (p.underline) rPr.push('<w:u w:val="single"/>');
    return `<w:r>${rPr.length ? `<w:rPr>${rPr.join("")}</w:rPr>` : ""}<w:t xml:space="preserve">${xml(value)}</w:t></w:r>`;
  };

  const inline = (text, p = {}) =>
    checklistInlineSegments(text)
      .map((seg) => {
        if (seg.href) {
          const rId = linkRel(seg.href);
          return rId
            ? `<w:hyperlink r:id="${rId}">${run(seg.text, { ...p, color: accent, underline: true })}</w:hyperlink>`
            : run(seg.text, p);
        }
        return run(seg.text, seg.bold ? { ...p, bold: true } : p);
      })
      .join("");

  // Child order: pStyle, keepNext, keepLines, pBdr, shd, tabs, spacing, ind, jc.
  const para = (runs, p = {}) => {
    const pPr = [];
    if (p.style) pPr.push(`<w:pStyle w:val="${p.style}"/>`);
    if (p.keepNext) pPr.push("<w:keepNext/>");
    if (p.keepLines) pPr.push("<w:keepLines/>");
    if (p.borderBottom) pPr.push(`<w:pBdr><w:bottom w:val="single" w:sz="${p.borderBottom.size || 8}" w:space="4" w:color="${p.borderBottom.color}"/></w:pBdr>`);
    else if (p.borderTop) pPr.push(`<w:pBdr><w:top w:val="single" w:sz="6" w:space="4" w:color="${p.borderTop}"/></w:pBdr>`);
    if (p.shade) pPr.push(`<w:shd w:val="clear" w:color="auto" w:fill="${p.shade}"/>`);
    if (p.tabs) pPr.push(`<w:tabs>${p.tabs.map((t) => `<w:tab w:val="${t.val}" w:pos="${t.pos}"/>`).join("")}</w:tabs>`);
    if (p.before !== undefined || p.after !== undefined) pPr.push(`<w:spacing w:before="${p.before ?? 0}" w:after="${p.after ?? 0}"/>`);
    if (p.ind) pPr.push(`<w:ind ${p.ind}/>`);
    if (p.jc) pPr.push(`<w:jc w:val="${p.jc}"/>`);
    return `<w:p>${pPr.length ? `<w:pPr>${pPr.join("")}</w:pPr>` : ""}${runs}</w:p>`;
  };

  const logoXml = (buffer, altText, maxInches = 1.6) => {
    const meta = inspectImageDimensions(buffer);
    if (!meta) return "";
    const index = images.length + 1;
    const rId = `rIdImg${index}`;
    const mediaName = `image${index}.${meta.ext === "jpeg" ? "jpg" : meta.ext}`;
    images.push({ rId, mediaName, data: buffer });
    const naturalW = meta.width / 96;
    const widthIn = Math.min(maxInches, Math.max(0.6, naturalW));
    const heightIn = Math.min(0.9, (meta.height / 96) * (widthIn / naturalW));
    const cx = Math.round(widthIn * 914400);
    const cy = Math.round(heightIn * 914400);
    const id = drawingId++;
    const alt = xml(altText || "Logo");
    return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="Picture ${id}" descr="${alt}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${id}" name="${xml(mediaName)}" descr="${alt}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
  };

  // ── Tables ────────────────────────────────────────────────────────────────

  const borders = (color = LINE, sz = 4) =>
    ["top", "left", "bottom", "right", "insideH", "insideV"].map((side) => `<w:${side} w:val="single" w:sz="${sz}" w:space="0" w:color="${color}"/>`).join("");

  const cell = (width, paragraphs, { shade, vAlign = "top" } = {}) =>
    `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${shade ? `<w:shd w:val="clear" w:color="auto" w:fill="${shade}"/>` : ""}<w:vAlign w:val="${vAlign}"/></w:tcPr>${paragraphs || para("")}</w:tc>`;

  const row = (cells, { header = false } = {}) =>
    `<w:tr><w:trPr><w:cantSplit/>${header ? "<w:tblHeader/>" : ""}</w:trPr>${cells.join("")}</w:tr>`;

  const table = (widths, rows, { borderColor = LINE, noBorders = false } = {}) =>
    `<w:tbl><w:tblPr><w:tblW w:w="${widths.reduce((a, b) => a + b, 0)}" w:type="dxa"/>${noBorders ? "" : `<w:tblBorders>${borders(borderColor)}</w:tblBorders>`}<w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="70" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="70" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join("")}</w:tblGrid>${rows.join("")}</w:tbl>`;

  const small = { size: 17, color: MUTED };
  const headCell = (width, label) => cell(width, para(run(label, { bold: true, size: 18, color: INK }), { before: 20, after: 20 }), { shade: tint });

  // ── Body ──────────────────────────────────────────────────────────────────

  const body = [];

  if (showCompany || brand.logoBuffer) {
    const runs = [];
    if (brand.logoBuffer) {
      const logo = logoXml(brand.logoBuffer, companyName || "Logo");
      if (logo) runs.push(logo, run("   "));
    }
    if (showCompany) {
      runs.push(run(companyName, { bold: true, color: accent, size: 26 }));
      if (brand.tagline) runs.push(run(` \u2014 ${brand.tagline}`, { italic: true, color: MUTED, size: 20 }));
    }
    body.push(para(runs.join(""), { borderBottom: { color: rule, size: secondary ? 12 : 8 }, before: 0, after: 200 }));
  }

  body.push(para(run(model.documentTitle, { bold: true, caps: true, color: accent, spacing: 20, size: 22 }), { keepNext: true, before: 120, after: 40 }));
  body.push(para(run(model.title, { bold: true, color: INK, size: 52 }), { style: "Title", keepNext: true, before: 0, after: 160 }));
  body.push(para(run(model.banner, { bold: true, color: bandText, size: 26 }), { shade: primaryHex, keepNext: true, before: 40, after: 160, ind: 'w:left="120" w:right="120"' }));
  if (brand.coverSubtitle) body.push(para(run(brand.coverSubtitle, { italic: true, color: MUTED, size: 20 }), { before: 0, after: 120 }));

  const metaRows = [
    ["Products", model.products.join("; ")],
    ["Audience", model.audience],
    ["Date", model.dateText],
    ...(model.customerName ? [["Prepared for", model.customerName]] : []),
  ].map(([k, v]) => row([cell(1700, para(run(k, { bold: true, color: MUTED, size: 19 }), { before: 20, after: 20 })), cell(CONTENT_W - 1700, para(run(v, { size: 20 }), { before: 20, after: 20 }))]));
  body.push(table([1700, CONTENT_W - 1700], metaRows, { noBorders: true }));

  body.push(para(run(model.summary, { size: 21 }), { before: 200, after: 120 }));

  const howTo = [
    para(run("How to use this checklist", { bold: true, color: accent, size: 24 }), { keepNext: true, before: 20, after: 60 }),
    ...model.howToUse.map((line) =>
      para(run("\u2022", { bold: true, color: accent }) + "<w:r><w:tab/></w:r>" + run(line, { size: 20 }), { keepLines: true, before: 0, after: 50, ind: 'w:left="360" w:hanging="260"' }),
    ),
  ].join("");
  body.push(
    `<w:tbl><w:tblPr><w:tblW w:w="${CONTENT_W}" w:type="dxa"/><w:tblBorders>${borders(secondary || primaryHex, 6)}</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="100" w:type="dxa"/><w:left w:w="160" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:right w:w="160" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid><w:gridCol w:w="${CONTENT_W}"/></w:tblGrid>${row([cell(CONTENT_W, howTo, { shade: tint })])}</w:tbl>`,
  );

  const heading = (text) => para(run(text, { bold: true, color: accent, size: 30 }), { style: "Heading1", keepNext: true, borderBottom: { color: rule, size: secondary ? 12 : 6 }, before: 320, after: 120 });

  if (model.roles.length) {
    body.push(heading("Who needs to be involved"));
    const widths = [3100, 5100, CONTENT_W - 8200];
    body.push(
      table(widths, [
        row([headCell(widths[0], "Who"), headCell(widths[1], "What they do"), headCell(widths[2], "Items")], { header: true }),
        ...model.roles.map((role) =>
          row([
            cell(widths[0], para(run(role.label, { bold: true, size: 20 }), { before: 20, after: 20 })),
            cell(widths[1], para(run(role.does, { size: 20 }), { before: 20, after: 20 })),
            cell(widths[2], para(run(formatItemNumbers(role.items), { bold: true, size: 20 }), { before: 20, after: 20 })),
          ]),
        ),
      ]),
    );
  }

  const W = [560, 4300, 1500, 2520, CONTENT_W - 560 - 4300 - 1500 - 2520];
  for (const section of model.sections) {
    body.push(heading(section.title));
    if (section.intro) body.push(para(run(section.intro, { color: MUTED, size: 20 }), { keepNext: true, before: 0, after: 100 }));
    const rows = [
      row([headCell(W[0], ""), headCell(W[1], "What to have ready"), headCell(W[2], "Who"), headCell(W[3], "Why it is needed"), headCell(W[4], "Done by / date")], { header: true }),
    ];
    for (const item of section.items) {
      const parts = checklistItemParts(item);
      const what = [];
      if (parts.title) what.push(para(run(`${item.n}. `, { bold: true, color: MUTED, size: 20 }) + run(parts.title, { bold: true, size: 20 }), { keepNext: Boolean(parts.text), keepLines: true, before: 10, after: 30 }));
      if (parts.text) what.push(para((parts.title ? "" : run(`${item.n}. `, { bold: true, color: MUTED, size: 20 })) + inline(parts.text, { size: 20 }), { keepLines: true, before: 10, after: 30 }));
      if (!parts.title && !parts.text) what.push(para(run(`${item.n}.`, { bold: true, color: MUTED, size: 20 }), { before: 10, after: 30 }));
      if (parts.condition) what.push(para(run(parts.condition, { italic: true, ...small }), { before: 0, after: 30 }));
      if (parts.where) what.push(para(run(parts.where, small), { before: 0, after: 20 }));
      const why = [];
      if (parts.why) why.push(para(run(parts.why, { size: 18 }), { keepLines: true, before: 10, after: 40 }));
      if (parts.learn) why.push(para(inline(`[${parts.learn.label}](${parts.learn.url})`, { size: 18 }), { keepLines: true, before: 0, after: 40 }));
      if (parts.confirm) why.push(para(run(parts.confirm, { bold: true, color: "5B3A06", size: 18 }), { shade: "FEF3C7", keepLines: true, before: 20, after: 20 }));
      rows.push(
        row([
          cell(W[0], para(run("\u2610", { symbol: true, size: 30, color: INK }), { jc: "center", before: 0, after: 0 })),
          cell(W[1], what.join("")),
          cell(W[2], para(run(item.roleLabel, { bold: true, size: 18 }), { keepLines: true, before: 10, after: 20 })),
          cell(W[3], why.join("")),
          cell(W[4], para("", { before: 0, after: 0 })),
        ]),
      );
    }
    body.push(table(W, rows));
  }

  body.push(heading("Confirm and return"));
  body.push(para(run(model.confirm.line, { size: 21 }), { keepNext: true, before: 0, after: 100 }));
  if (model.contact?.moreInfo) body.push(para(inline(`[${model.contact.moreInfo.label}](${model.contact.moreInfo.url})`, { size: 20 }), { keepNext: true, before: 0, after: 100 }));
  const signW = Math.floor(CONTENT_W / model.confirm.fields.length);
  body.push(
    table(
      model.confirm.fields.map(() => signW),
      [
        row(model.confirm.fields.map((f) => cell(signW, para("", { before: 360, after: 0 }) + para(run(f, { size: 18, color: MUTED }), { borderTop: "64748B", before: 40, after: 0 })))),
      ],
      { noBorders: true },
    ),
  );
  body.push(para("", { before: 0, after: 0 }));

  // ── Header and footer ─────────────────────────────────────────────────────

  const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const footerLeftRaw = [checklistPlainText(model.title), model.documentTitle, brand.footerText || model.footerText].filter(Boolean).join(" \u00b7 ");
  const footerCut = footerLeftRaw.slice(0, 94);
  const footerWordEnd = footerCut.lastIndexOf(" ");
  const footerLeft = footerLeftRaw.length > 95 ? `${(footerWordEnd > 60 ? footerCut.slice(0, footerWordEnd) : footerCut).trim()}\u2026` : footerLeftRaw;
  const footerXml = (tag) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr ${NS}>${para(
    run(footerLeft, { color: MUTED, size: 16 }) +
      `<w:r><w:rPr><w:color w:val="${MUTED}"/><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr><w:tab/><w:t xml:space="preserve">Page </w:t></w:r><w:fldSimple w:instr=" PAGE "><w:r><w:rPr><w:color w:val="${MUTED}"/><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr><w:t>1</w:t></w:r></w:fldSimple><w:r><w:rPr><w:color w:val="${MUTED}"/><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr><w:t xml:space="preserve"> of </w:t></w:r><w:fldSimple w:instr=" NUMPAGES "><w:r><w:rPr><w:color w:val="${MUTED}"/><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr><w:t>1</w:t></w:r></w:fldSimple>`,
    { borderTop: LINE, tabs: [{ val: "right", pos: CONTENT_W }], before: 0, after: 0 },
  )}</w:ftr>`;
  const headerText = [showCompany ? companyName : "", model.documentTitle].filter(Boolean).join(" \u2014 ");
  const headerXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr ${NS}>${para(run(headerText, { color: MUTED, size: 16 }), { borderBottom: { color: LINE, size: 4 }, jc: "right", before: 0, after: 0 })}</w:hdr>`;
  const emptyHeaderXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr ${NS}><w:p/></w:hdr>`;

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">
<w:body>${body.join("\n")}
<w:sectPr><w:headerReference w:type="default" r:id="rIdHeader1"/><w:headerReference w:type="first" r:id="rIdHeader2"/><w:footerReference w:type="default" r:id="rIdFooter1"/><w:footerReference w:type="first" r:id="rIdFooter2"/><w:pgSz w:w="${PAGE_W}" w:h="${PAGE_H}"/><w:pgMar w:top="1260" w:right="${MARGIN_X}" w:bottom="1200" w:left="${MARGIN_X}" w:header="600" w:footer="560" w:gutter="0"/><w:titlePg/></w:sectPr>
</w:body>
</w:document>`;

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${xml(fontName)}" w:hAnsi="${xml(fontName)}" w:cs="${xml(fontName)}"/><w:color w:val="${INK}"/><w:sz w:val="21"/><w:szCs w:val="21"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="100" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="0" w:after="160" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:b/><w:color w:val="${INK}"/><w:sz w:val="52"/><w:szCs w:val="52"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="320" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:color w:val="${accent}"/><w:sz w:val="30"/><w:szCs w:val="30"/></w:rPr></w:style>
</w:styles>`;

  const docRels = [
    '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
    '<Relationship Id="rIdHeader1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>',
    '<Relationship Id="rIdHeader2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header2.xml"/>',
    '<Relationship Id="rIdFooter1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>',
    '<Relationship Id="rIdFooter2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer2.xml"/>',
    ...hyperlinks.map((h) => `<Relationship Id="${h.rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xml(h.target)}" TargetMode="External"/>`),
    ...images.map((img) => `<Relationship Id="${img.rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${xml(img.mediaName)}"/>`),
  ];

  const nowIso = new Date().toISOString();
  const docTitle = `${checklistPlainText(model.title)} \u2014 ${model.documentTitle}`;
  const entries = [
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpg" ContentType="image/jpeg"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/header2.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/><Override PartName="/word/footer2.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`,
    },
    {
      name: "_rels/.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`,
    },
    {
      name: "docProps/core.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(docTitle)}</dc:title><dc:creator>${xml(showCompany ? companyName : "Prerequisites checklist")}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${nowIso}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${nowIso}</dcterms:modified></cp:coreProperties>`,
    },
    {
      name: "docProps/app.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Copilot Studio Labs Builder</Application></Properties>`,
    },
    { name: "word/document.xml", data: documentXml },
    {
      name: "word/_rels/document.xml.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${docRels.join("")}</Relationships>`,
    },
    { name: "word/styles.xml", data: stylesXml },
    { name: "word/header1.xml", data: headerXml },
    { name: "word/header2.xml", data: emptyHeaderXml },
    { name: "word/footer1.xml", data: footerXml("default") },
    { name: "word/footer2.xml", data: footerXml("first") },
    ...images.map((img) => ({ name: `word/media/${img.mediaName}`, data: img.data, store: true })),
  ];
  return buildZipBuffer(entries);
}
