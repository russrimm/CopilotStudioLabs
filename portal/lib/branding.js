import { mkdirSync } from "fs";
import { isAbsolute, relative, resolve } from "path";
import { PORTAL_ROOT, resolvePortalDataDir, resolvePortalUploadsDir } from "./storage-config.js";
import {
  applyBrandTokens,
  escapeHtmlText,
  getBrandFont,
  hasBrandCustomization,
  isSafeUploadPath,
  normalizeBrand,
  normalizeHexColor6,
  renderBrandInfoHtml,
  renderBrandInfoMarkdown,
} from "./lab-builder/brand-theme.js";
import {
  clearProfileLogo,
  getActiveBrand,
  getActiveProfileId,
  setProfileLogo,
  updateActiveProfileClassicFields,
} from "./branding-profiles.js";

/**
 * Backward-compatible single-brand API. Since brand profiles landed, these
 * helpers read and write the *active* profile; the full profile model lives in
 * `./branding-profiles.js` and the pure rendering rules in
 * `./lab-builder/brand-theme.js`.
 */

export const DEFAULT_BRANDING = Object.freeze({
  companyName: "Microsoft AI Training Generator",
  logo: null,
  primaryColor: "#4f8ff7",
  tagline: "Provisioning Portal",
});

export const BRANDING_PUBLIC_DIR = resolve(PORTAL_ROOT, "public");
export const BRANDING_DATA_DIR = resolvePortalDataDir();
export const BRANDING_UPLOADS_DIR = resolvePortalUploadsDir();
export const BRANDING_FILE = resolve(BRANDING_DATA_DIR, "branding.json");

export function getBrandingDataDir(env = process.env) {
  return resolvePortalDataDir(env);
}

export function getBrandingUploadsDir(env = process.env) {
  return resolvePortalUploadsDir(env);
}

export function getBrandingFilePath(env = process.env) {
  return resolve(getBrandingDataDir(env), "branding.json");
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function normalizeText(value, fallback) {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

export function escapeHtml(value) {
  return escapeHtmlText(value);
}

export function ensureBrandingStorage(env = process.env) {
  ensureDir(getBrandingDataDir(env));
  ensureDir(getBrandingUploadsDir(env));
}

/** Normalize the four classic fields (company name, tagline, color, logo). */
export function normalizeBranding(input = {}, current = DEFAULT_BRANDING) {
  return {
    companyName: normalizeText(input.companyName, current.companyName || DEFAULT_BRANDING.companyName),
    logo: isSafeUploadPath(input.logo) ? input.logo : current.logo || null,
    primaryColor: normalizeHexColor6(input.primaryColor || current.primaryColor) || DEFAULT_BRANDING.primaryColor,
    tagline: normalizeText(input.tagline, current.tagline || DEFAULT_BRANDING.tagline),
  };
}

/**
 * Load the active brand. Returns the classic fields (`companyName`, `logo`,
 * `primaryColor`, `tagline`) plus every extended profile field, so existing
 * callers keep working while new renderers read the rest.
 */
export function loadBranding(env = process.env) {
  ensureBrandingStorage(env);
  try {
    return getActiveBrand(env);
  } catch {
    return { ...normalizeBrand({}), profileId: null, profileName: null };
  }
}

export function saveBranding(input = {}, env = process.env) {
  ensureBrandingStorage(env);
  const classic = normalizeBranding(input, loadBranding(env));
  return updateActiveProfileClassicFields(classic, env);
}

export function getBrandingLogoAbsolutePath(logoPath, env = process.env) {
  if (!isSafeUploadPath(logoPath)) return null;
  const fileName = logoPath.slice("/uploads/".length);
  if (!fileName || fileName === "." || fileName === ".." || fileName.includes("..") || /[\\/\0]/.test(fileName)) {
    return null;
  }
  const uploadsDir = getBrandingUploadsDir(env);
  const targetPath = resolve(uploadsDir, fileName);
  const rel = relative(uploadsDir, targetPath);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return targetPath;
}

function toActiveBrand(profile) {
  return { ...normalizeBrand(profile), profileId: profile.id, profileName: profile.name };
}

export function deleteBrandingLogo(env = process.env) {
  ensureBrandingStorage(env);
  return toActiveBrand(clearProfileLogo(getActiveProfileId(env), env));
}

export function updateBrandingLogo(fileName, env = process.env) {
  ensureBrandingStorage(env);
  return toActiveBrand(setProfileLogo(getActiveProfileId(env), fileName, env));
}

/**
 * Replace {{COMPANY_NAME}}, {{TAGLINE}}, {{PRIMARY_COLOR}}, {{COMPANY_LOGO}} and the
 * profile tokens ({{MORE_INFO_URL}}, {{SUPPORT_EMAIL}}, {{FOOTER_TEXT}}, ...).
 * Empty values render nothing so no raw braces reach learners.
 */
export function applyBrandingTokens(content, branding = loadBranding()) {
  return applyBrandTokens(content, branding);
}

function hexToRgbTriplet(hex) {
  const normalized = normalizeHexColor6(hex) || DEFAULT_BRANDING.primaryColor;
  return [1, 3, 5].map((index) => parseInt(normalized.slice(index, index + 2), 16)).join(", ");
}

export function renderBrandingBannerHtml(branding = loadBranding(), logoPath = branding.logo) {
  const brand = normalizeBrand(branding);
  const title = escapeHtml(brand.companyName);
  const tagline = escapeHtml(brand.tagline);
  const accent = escapeHtml(brand.primaryColor);
  const secondary = brand.secondaryColor ? escapeHtml(brand.secondaryColor) : "";
  const fontCss = getBrandFont(brand.font).css;
  const fontStyle = fontCss ? ` font-family: ${escapeHtml(fontCss)};` : "";
  const secondaryRule = secondary ? ` border-bottom: 4px solid ${secondary};` : "";
  const subtitle = brand.coverSubtitle
    ? `\n      <div class="lab-branding-subtitle" style="font-size: 13px;">${escapeHtml(brand.coverSubtitle)}</div>`
    : "";
  const logo = logoPath
    ? `<img src="${escapeHtml(logoPath)}" alt="${title} logo" style="max-height: 48px; max-width: 180px; width: auto; display: block;" />`
    : "";

  return `
<div class="lab-branding-banner" style="margin: 0 0 24px; border: 1px solid ${accent};${secondaryRule} border-radius: 14px; padding: 18px 20px; background: rgba(${hexToRgbTriplet(brand.primaryColor)}, 0.08);${fontStyle}">
  <div style="display: flex; align-items: center; gap: 16px; flex-wrap: wrap;">
    ${logo}
    <div>
      <div class="lab-branding-title" style="font-size: 28px; font-weight: 700; color: ${accent};">${title}</div>
      <div class="lab-branding-tagline" style="font-size: 14px;">${tagline}</div>${subtitle}
    </div>
  </div>
</div>`.trim();
}

/** Subject and HTML body for the lab-package email, branded with the active profile. */
export function renderLabEmail({ labCount, labListHtml }, branding = loadBranding()) {
  const brand = normalizeBrand(branding);
  const custom = hasBrandCustomization(brand);
  const company = escapeHtml(brand.companyName);
  const accent = escapeHtml(brand.primaryColor);
  const fontCss = getBrandFont(brand.font).css;
  const fontFamily = fontCss ? escapeHtml(fontCss) : "Segoe UI, Arial, sans-serif";
  const heading = custom ? `Your ${company} Training Package` : "Your Microsoft AI Training Generator";
  const footer = custom
    ? escapeHtml(brand.footerText || `Sent by ${brand.companyName}`)
    : "Sent from the Microsoft AI Training Generator Provisioning Portal";
  const subject = custom
    ? `Your ${brand.companyName} Training Package`
    : "Your Microsoft AI Training Generator Package";
  const html = `
        <div style="font-family: ${fontFamily}; max-width: 600px;">
          <h2${custom ? ` style="color: ${accent};"` : ""}>⚡ ${heading}</h2>
          <p>Attached is your customized lab package containing ${Number(labCount) || 0} lab(s):</p>
          <ul>${labListHtml}</ul>
          <p>Unzip the attachment and follow each lab's <code>index.md</code> to get started.</p>
          ${custom ? renderBrandInfoHtml(brand, { className: "email-brand-info" }) : ""}
          <hr />
          <p style="color: #666; font-size: 12px;">
            ${footer}
          </p>
        </div>
      `;
  return { subject, html };
}

/** Resolve tokens and append the closing info blocks and footer when the brand has them. */
export function applyBrandingToMarkdown(content, branding = loadBranding(), { infoBlocks = true } = {}) {
  const brandedContent = applyBrandingTokens(content, branding);
  const info = infoBlocks ? renderBrandInfoMarkdown(branding) : "";
  return info ? `${brandedContent.replace(/\s+$/, "")}\n${info}` : brandedContent;
}

/**
 * Prepend the brand banner to Markdown, resolve tokens, and append the
 * "More information" / "Need help?" blocks and footer when the brand has them.
 * Pass `{ infoBlocks: false }` to skip the closing blocks for sub-documents.
 */
export function prependBrandingBanner(content, branding = loadBranding(), logoPath = branding.logo, { infoBlocks = true } = {}) {
  return `${renderBrandingBannerHtml(branding, logoPath)}\n\n${applyBrandingToMarkdown(content, branding, { infoBlocks })}`;
}
