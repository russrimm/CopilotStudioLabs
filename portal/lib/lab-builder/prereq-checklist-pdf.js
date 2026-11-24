/**
 * The Prerequisites checklist as a PDF.
 *
 * Uses the shared pure-Node PDF writer (`pdf-builder.js`) through its Markdown pipeline, with the
 * writer's opt-in layout options: column widths for the checklist tables, drawn checkboxes, a
 * repeating table header, headings that stay with the table, and a footer that names the document.
 */

import { ensureReadableColor, normalizeHexColor6 } from "./brand-theme.js";
import { renderMarkdownToPdfBuffer } from "./pdf-builder.js";
import { checklistItemParts, formatItemNumbers } from "./prereq-checklist.js";

const cell = (text) => String(text ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();

function itemCell(item) {
  const parts = checklistItemParts(item);
  const lines = [];
  if (parts.title) lines.push(`**${item.n}. ${cell(parts.title)}**`);
  if (parts.text) lines.push(parts.title ? cell(parts.text) : `**${item.n}.** ${cell(parts.text)}`);
  if (!parts.title && !parts.text) lines.push(`**${item.n}.**`);
  if (parts.condition) lines.push(`*${cell(parts.condition)}*`);
  if (parts.where) lines.push(`*${cell(parts.where)}*`);
  if (parts.check) lines.push(`**How to check:** ${cell(parts.check)}`);
  return lines.join("<br>");
}

function whyCell(item) {
  const parts = checklistItemParts(item);
  const lines = [];
  if (parts.why) lines.push(cell(parts.why));
  if (parts.learn) lines.push(`[${cell(parts.learn.label)}](${parts.learn.url})`);
  if (parts.confirm) lines.push(`**${cell(parts.confirm)}**`);
  return lines.join("<br>");
}

/** The Markdown the PDF writer lays out (not the same as the downloadable Markdown: tables, not task lists). */
export function renderPrerequisitesChecklistPdfMarkdown(model) {
  const lines = [
    `#### ${model.documentTitle.toUpperCase()}`,
    "",
    `# ${model.title}`,
    "",
    `> **${model.banner}**`,
    "",
    `**Products:** ${cell(model.products.join("; "))}`,
    "",
    `**Audience:** ${cell(model.audience)}`,
    "",
    `**Date:** ${model.dateText}`,
    "",
  ];
  if (model.customerName) lines.push(`**Prepared for:** ${cell(model.customerName)}`, "");
  lines.push(model.summary, "", "> **How to use this checklist**", ">", ...model.howToUse.map((line) => `> - ${line}`), "");

  if (model.roles.length) {
    lines.push("## Who needs to be involved", "", "| Who | What they do | Items |", "|---|---|---|");
    for (const role of model.roles) lines.push(`| **${cell(role.label)}** | ${cell(role.does)} | ${formatItemNumbers(role.items)} |`);
    lines.push("");
  }

  for (const section of model.sections) {
    lines.push(`## ${section.title}`, "");
    if (section.intro) lines.push(section.intro, "");
    lines.push("| | What to have ready | Who | Why it is needed | Done by / date |", "|---|---|---|---|---|");
    for (const item of section.items) {
      lines.push(`| \u2610 | ${itemCell(item)} | ${cell(item.roleLabel)} | ${whyCell(item)} |  |`);
    }
    lines.push("");
  }

  lines.push("## Confirm and return", "", model.confirm.line, "");
  if (model.contact?.moreInfo) lines.push(`[${cell(model.contact.moreInfo.label)}](${model.contact.moreInfo.url})`, "");
  for (const field of model.confirm.fields) lines.push(`${field}: ______________________________`, "");
  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * @param {object} model from `buildPrerequisitesChecklist`
 * @param {object} [options]
 * @param {object} [options.branding] `{ companyName, tagline, primaryColor, secondaryColor, font, coverSubtitle, footerText, logoBuffer }`
 */
export function renderPrerequisitesChecklistPdfBuffer(model, { branding } = {}) {
  const footerLabel = [`${model.title} - ${model.documentTitle}`, model.footerText].filter(Boolean).join("  |  ");
  // Headings and links use the brand color, so keep it readable on white paper.
  const primary = normalizeHexColor6(branding?.primaryColor);
  const readable = primary ? { ...branding, primaryColor: ensureReadableColor(primary, ["#ffffff"], "#0b2a5b", 4.5) } : branding;
  return renderMarkdownToPdfBuffer(renderPrerequisitesChecklistPdfMarkdown(model), {
    title: `${model.title} - ${model.documentTitle}`,
    branding: readable,
    tableColumnWeights: { 5: [5, 40, 14, 29, 12], 3: [27, 53, 20] },
    drawCheckboxCells: true,
    repeatTableHeader: true,
    keepHeadingWithNext: true,
    drawLogo: true,
    footerLabel,
  });
}
