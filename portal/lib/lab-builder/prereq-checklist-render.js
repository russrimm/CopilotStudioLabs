/**
 * Renders a lab's standalone Prerequisites checklist in any of its formats from a lab's manifest and
 * Markdown. Shared by the portal (`exporter.js`) and the offline CLI (`tools/lab-builder/export-prerequisites.mjs`),
 * so it imports no npm packages: a lab built before this document existed renders the same way in both.
 */

import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { applyBrandingTokens, getBrandingLogoAbsolutePath } from "../branding.js";
import { resolveLabBrand } from "../branding-profiles.js";
import { hasBrandCustomization, normalizeBrand } from "./brand-theme.js";
import { buildPrerequisitesChecklist, checklistBaseName, renderPrerequisitesChecklistMarkdown } from "./prereq-checklist.js";
import { renderPrerequisitesChecklistDocxBuffer } from "./prereq-checklist-docx.js";
import { renderPrerequisitesChecklistHtml } from "./prereq-checklist-html.js";
import { renderPrerequisitesChecklistPdfBuffer } from "./prereq-checklist-pdf.js";

/** The formats the standalone prerequisites checklist is offered in. */
export const PREREQUISITES_FORMATS = Object.freeze(["docx", "pdf", "html", "md"]);

const FORMAT_META = Object.freeze({
  docx: { ext: "docx", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  pdf: { ext: "pdf", contentType: "application/pdf" },
  html: { ext: "html", contentType: "text/html; charset=utf-8" },
  md: { ext: "md", contentType: "text/markdown; charset=utf-8" },
});

const IMAGE_MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

/** "markdown" is the same as "md". Returns null for anything that is not offered. */
export function normalizePrerequisitesFormat(raw) {
  const token = String(raw ?? "docx").trim().toLowerCase().replace(/^\./, "");
  const format = token === "markdown" ? "md" : token;
  return PREREQUISITES_FORMATS.includes(format) ? format : null;
}

/** Branding handed to the Word and PDF writers, and to the web page writer (same fields as the lab exports). */
export function prerequisitesBranding(brand, logoPath) {
  const normalized = normalizeBrand(brand);
  const custom = hasBrandCustomization(normalized);
  if (!custom) return { custom, doc: { primaryColor: normalized.primaryColor }, html: null };
  const fields = {
    companyName: normalized.companyName,
    tagline: normalized.tagline,
    primaryColor: normalized.primaryColor,
    secondaryColor: normalized.secondaryColor,
    font: normalized.font,
    coverSubtitle: normalized.coverSubtitle,
    footerText: normalized.footerText,
  };
  let logoBuffer = null;
  let logoUrl = null;
  if (logoPath && existsSync(logoPath)) {
    try {
      logoBuffer = readFileSync(logoPath);
      const mime = IMAGE_MIME[extname(logoPath).toLowerCase()];
      if (mime) logoUrl = `data:${mime};base64,${logoBuffer.toString("base64")}`;
    } catch {
      logoBuffer = null;
    }
  }
  return { custom, doc: { ...fields, logoBuffer }, html: { ...fields, logoUrl } };
}

/**
 * @param {object} input
 * @param {object} input.manifest the lab's manifest.json
 * @param {string} input.markdown the lab's index.md
 * @param {string} [input.format] docx (default), pdf, html, or md
 * @param {Record<string,string>} [input.replacements] term replacements
 * @param {object} [input.branding] replaces the active-profile layer of the brand
 * @param {string} [input.logoSourcePath] overrides the brand's logo file
 * @param {Date|string|number} [input.now]
 * @param {object} [input.env]
 * @returns {object} `{ status: 200, title, model, format, ext, contentType, baseName, buffer | text }` or `{ status, error }`
 */
export function renderPrerequisitesChecklistFile({ manifest, markdown, format = "docx", replacements = {}, branding, logoSourcePath, now, env = process.env } = {}) {
  const kind = normalizePrerequisitesFormat(format);
  if (!kind) return { status: 400, error: `Unsupported prerequisites format. Allowed values: ${PREREQUISITES_FORMATS.join(", ")}.` };

  const brand = resolveLabBrand(manifest || null, { env, brand: branding });
  const entries = Object.entries(replacements || {}).filter(([k, v]) => k && v && k !== v);
  let content = String(markdown ?? "");
  let title = String(manifest?.title || "");
  for (const [search, replace] of entries) {
    content = content.split(search).join(replace);
    title = title.split(search).join(replace);
  }
  content = applyBrandingTokens(content, brand);
  title = applyBrandingTokens(title, brand);

  const custom = hasBrandCustomization(normalizeBrand(brand));
  const model = buildPrerequisitesChecklist({
    manifest: { ...(manifest || {}), title },
    markdown: content,
    brand: custom ? brand : null,
    now,
    replacements,
  });
  const meta = FORMAT_META[kind];
  const base = { status: 200, title: model.title, model, format: kind, ext: meta.ext, contentType: meta.contentType, baseName: checklistBaseName(model.title) };
  const logoPath = custom ? logoSourcePath || getBrandingLogoAbsolutePath(brand.logo, env) : null;
  const styled = prerequisitesBranding(brand, logoPath);

  if (kind === "md") return { ...base, text: renderPrerequisitesChecklistMarkdown(model) };
  if (kind === "html") return { ...base, text: renderPrerequisitesChecklistHtml(model, { branding: styled.html || { primaryColor: styled.doc.primaryColor } }) };
  const buffer =
    kind === "docx"
      ? renderPrerequisitesChecklistDocxBuffer(model, { branding: styled.doc })
      : renderPrerequisitesChecklistPdfBuffer(model, { branding: styled.doc });
  return { ...base, buffer };
}
