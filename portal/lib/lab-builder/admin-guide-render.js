/**
 * Renders a lab's Administrator setup guide in any of its formats from the lab's manifest and Markdown.
 * Shared by the portal (`exporter.js`) and the offline CLI (`tools/lab-builder/export-admin-guide.mjs`), so it
 * imports no npm packages: a lab built before this document existed renders the same way in both.
 */

import { getBrandingLogoAbsolutePath, applyBrandingTokens } from "../branding.js";
import { resolveLabBrand } from "../branding-profiles.js";
import { hasBrandCustomization, normalizeBrand } from "./brand-theme.js";
import { adminGuideBaseName, buildAdministratorSetupGuide, renderAdministratorSetupGuideMarkdown } from "./admin-guide.js";
import { renderAdministratorSetupGuideDocxBuffer } from "./admin-guide-docx.js";
import { renderAdministratorSetupGuideHtml } from "./admin-guide-html.js";
import { renderAdministratorSetupGuidePdfBuffer } from "./admin-guide-pdf.js";
import { prerequisitesBranding } from "./prereq-checklist-render.js";

/** The formats the Administrator setup guide is offered in. */
export const ADMIN_GUIDE_FORMATS = Object.freeze(["docx", "pdf", "html", "md"]);

const FORMAT_META = Object.freeze({
  docx: { ext: "docx", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  pdf: { ext: "pdf", contentType: "application/pdf" },
  html: { ext: "html", contentType: "text/html; charset=utf-8" },
  md: { ext: "md", contentType: "text/markdown; charset=utf-8" },
});

/** "markdown" is the same as "md". Returns null for anything that is not offered. */
export function normalizeAdminGuideFormat(raw) {
  const token = String(raw ?? "docx").trim().toLowerCase().replace(/^\./, "");
  const format = token === "markdown" ? "md" : token;
  return ADMIN_GUIDE_FORMATS.includes(format) ? format : null;
}

/**
 * @param {object} input
 * @param {object} input.manifest the lab's manifest.json
 * @param {string} input.markdown the lab's index.md (the old administrator section may still be in it; it is never read)
 * @param {string} [input.format] docx (default), pdf, html, or md
 * @param {Record<string,string>} [input.replacements] term replacements
 * @param {object} [input.branding] replaces the active-profile layer of the brand
 * @param {string} [input.logoSourcePath] overrides the brand's logo file
 * @param {Date|string|number} [input.now]
 * @param {object} [input.env]
 * @returns {object} `{ status: 200, title, model, format, ext, contentType, baseName, buffer | text }` or `{ status, error }`
 */
export function renderAdministratorSetupGuideFile({ manifest, markdown, format = "docx", replacements = {}, branding, logoSourcePath, now, env = process.env } = {}) {
  const kind = normalizeAdminGuideFormat(format);
  if (!kind) return { status: 400, error: `Unsupported administrator guide format. Allowed values: ${ADMIN_GUIDE_FORMATS.join(", ")}.` };

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
  const model = buildAdministratorSetupGuide({
    manifest: { ...(manifest || {}), title },
    markdown: content,
    brand: custom ? brand : null,
    now,
    replacements,
  });
  const meta = FORMAT_META[kind];
  const base = { status: 200, title: model.title, model, format: kind, ext: meta.ext, contentType: meta.contentType, baseName: adminGuideBaseName(model.title) };
  const logoPath = custom ? logoSourcePath || getBrandingLogoAbsolutePath(brand.logo, env) : null;
  const styled = prerequisitesBranding(brand, logoPath);

  if (kind === "md") return { ...base, text: renderAdministratorSetupGuideMarkdown(model) };
  if (kind === "html") return { ...base, text: renderAdministratorSetupGuideHtml(model, { branding: styled.html || { primaryColor: styled.doc.primaryColor } }) };
  const buffer =
    kind === "docx"
      ? renderAdministratorSetupGuideDocxBuffer(model, { branding: styled.doc })
      : renderAdministratorSetupGuidePdfBuffer(model, { branding: styled.doc });
  return { ...base, buffer };
}
