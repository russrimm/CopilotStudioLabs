/**
 * The Administrator setup guide as a PDF.
 *
 * Uses the shared pure-Node PDF writer (`pdf-builder.js`) through its Markdown pipeline with the layout options
 * the Prerequisites checklist already uses: column widths, drawn checkboxes, a repeating table header, headings
 * that stay with their table, and a footer that names the document.
 */

import { ensureReadableColor, normalizeHexColor6 } from "./brand-theme.js";
import { renderMarkdownToPdfBuffer } from "./pdf-builder.js";
import { adminGuideItemParts } from "./admin-guide.js";
import { formatItemNumbers } from "./prereq-checklist.js";

const cell = (text) => String(text ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();

function itemCell(item) {
  const parts = adminGuideItemParts(item);
  const lines = [`**${item.n}. ${cell(parts.title)}**`];
  lines.push(`*${cell(parts.stage)}${parts.condition ? ` \u00b7 ${cell(parts.condition)}` : ""}*`);
  parts.steps.forEach((step, i) => lines.push(`${i + 1}. ${cell(step)}`));
  if (parts.text) lines.push(`**${parts.whatLabel}:** ${cell(parts.text)}`);
  if (parts.check) lines.push(`**How to check:** ${cell(parts.check)}`);
  if (parts.detail) lines.push(`**Details:** ${cell(parts.detail)}`);
  if (parts.endpoints) lines.push(cell(parts.endpoints));
  if (parts.why) lines.push(`**Why:** ${cell(parts.why)}`);
  if (parts.learn) lines.push(`[${cell(parts.learn.label)}](${parts.learn.url})`);
  if (parts.confirm) lines.push(`**${cell(parts.confirm)}**`);
  return lines.join("<br>");
}

/** The Markdown the PDF writer lays out (not the same as the downloadable Markdown: tables, not task lists). */
export function renderAdministratorSetupGuidePdfMarkdown(model) {
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
  lines.push(model.summary, "", "> **How to use this guide**", ">", ...model.howToUse.map((line) => `> - ${line}`), "");
  if (model.notes.length) lines.push("> **Good to know**", ">", ...model.notes.map((note) => `> - ${note}`), "");

  if (model.workOrder.length) {
    lines.push("## Order of work", "", "| # | Setting | Stage | Who |", "|---|---|---|---|");
    for (const entry of model.workOrder) {
      lines.push(`| **${entry.n}** | ${cell(entry.title)} | ${cell(entry.stageTitle)} | ${cell(entry.roleLabel)} |`);
    }
    lines.push("");
  }

  if (model.roles.length) {
    lines.push("## Who does what", "", "| Who | What they do | Items |", "|---|---|---|");
    for (const role of model.roles) lines.push(`| **${cell(role.label)}** | ${cell(role.does)} | ${formatItemNumbers(role.items)} |`);
    lines.push("");
  }

  for (const section of model.sections) {
    lines.push(`## ${section.title}`, "");
    if (section.intro) lines.push(section.intro, "");
    lines.push("| | What to do | Done by / date |", "|---|---|---|");
    for (const item of section.items) lines.push(`| \u2610 | ${itemCell(item)} |  |`);
    lines.push("");
  }

  lines.push("## Confirm and return", "", model.confirm.line, "");
  if (model.contact?.moreInfo) lines.push(`[${cell(model.contact.moreInfo.label)}](${model.contact.moreInfo.url})`, "");
  for (const field of model.confirm.fields) lines.push(`${field}: ______________________________`, "");
  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * @param {object} model from `buildAdministratorSetupGuide`
 * @param {object} [options]
 * @param {object} [options.branding] `{ companyName, tagline, primaryColor, secondaryColor, font, coverSubtitle, footerText, logoBuffer }`
 */
export function renderAdministratorSetupGuidePdfBuffer(model, { branding } = {}) {
  const footerLabel = [`${model.title} - ${model.documentTitle}`, model.footerText].filter(Boolean).join("  |  ");
  // Headings and links use the brand color, so keep it readable on white paper.
  const primary = normalizeHexColor6(branding?.primaryColor);
  const readable = primary ? { ...branding, primaryColor: ensureReadableColor(primary, ["#ffffff"], "#0b2a5b", 4.5) } : branding;
  return renderMarkdownToPdfBuffer(renderAdministratorSetupGuidePdfMarkdown(model), {
    title: `${model.title} - ${model.documentTitle}`,
    branding: readable,
    tableColumnWeights: { 3: [6, 74, 20], 4: [7, 45, 28, 20] },
    drawCheckboxCells: true,
    repeatTableHeader: true,
    keepHeadingWithNext: true,
    drawLogo: true,
    footerLabel,
  });
}
