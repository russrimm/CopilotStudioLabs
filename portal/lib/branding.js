import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { resolve } from "path";

export const DEFAULT_BRANDING = Object.freeze({
  companyName: "Copilot Studio Labs",
  logo: null,
  primaryColor: "#4f8ff7",
  tagline: "Provisioning Portal",
});

const PORTAL_ROOT = resolve(import.meta.dirname, "..");
export const BRANDING_DATA_DIR = resolve(PORTAL_ROOT, "data");
export const BRANDING_PUBLIC_DIR = resolve(PORTAL_ROOT, "public");
export const BRANDING_UPLOADS_DIR = resolve(BRANDING_PUBLIC_DIR, "uploads");
export const BRANDING_FILE = resolve(BRANDING_DATA_DIR, "branding.json");

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function normalizePrimaryColor(value) {
  const normalized = String(value || "").trim();
  return /^#([0-9a-f]{6})$/i.test(normalized)
    ? normalized.toLowerCase()
    : DEFAULT_BRANDING.primaryColor;
}

function normalizeText(value, fallback) {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function isUploadPath(value) {
  return typeof value === "string" && /^\/uploads\/[^/]+$/i.test(value);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function ensureBrandingStorage() {
  ensureDir(BRANDING_DATA_DIR);
  ensureDir(BRANDING_UPLOADS_DIR);
}

export function normalizeBranding(input = {}, current = DEFAULT_BRANDING) {
  return {
    companyName: normalizeText(input.companyName, current.companyName || DEFAULT_BRANDING.companyName),
    logo: isUploadPath(input.logo) ? input.logo : current.logo || null,
    primaryColor: normalizePrimaryColor(input.primaryColor || current.primaryColor),
    tagline: normalizeText(input.tagline, current.tagline || DEFAULT_BRANDING.tagline),
  };
}

export function loadBranding() {
  ensureBrandingStorage();

  if (!existsSync(BRANDING_FILE)) {
    return { ...DEFAULT_BRANDING };
  }

  try {
    const saved = JSON.parse(readFileSync(BRANDING_FILE, "utf-8"));
    return normalizeBranding(saved, DEFAULT_BRANDING);
  } catch {
    return { ...DEFAULT_BRANDING };
  }
}

export function saveBranding(input = {}) {
  ensureBrandingStorage();
  const branding = normalizeBranding(input, loadBranding());
  writeFileSync(BRANDING_FILE, `${JSON.stringify(branding, null, 2)}\n`, "utf-8");
  return branding;
}

export function getBrandingLogoAbsolutePath(logoPath) {
  if (!isUploadPath(logoPath)) return null;
  return resolve(BRANDING_PUBLIC_DIR, `.${logoPath}`);
}

export function deleteBrandingLogo() {
  const current = loadBranding();
  const existingLogoPath = getBrandingLogoAbsolutePath(current.logo);
  if (existingLogoPath && existsSync(existingLogoPath)) {
    unlinkSync(existingLogoPath);
  }

  const next = {
    ...current,
    logo: null,
  };
  writeFileSync(BRANDING_FILE, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  return next;
}

export function updateBrandingLogo(fileName) {
  const current = loadBranding();
  const previousLogoPath = getBrandingLogoAbsolutePath(current.logo);
  const nextLogoPath = resolve(BRANDING_UPLOADS_DIR, fileName);
  const next = {
    ...current,
    logo: `/uploads/${fileName}`,
  };

  if (previousLogoPath && previousLogoPath !== nextLogoPath && existsSync(previousLogoPath)) {
    unlinkSync(previousLogoPath);
  }

  writeFileSync(BRANDING_FILE, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  return next;
}

export function applyBrandingTokens(content, branding = loadBranding()) {
  const replacements = new Map([
    ["{{COMPANY_NAME}}", branding.companyName],
    ["{{TAGLINE}}", branding.tagline],
    ["{{PRIMARY_COLOR}}", branding.primaryColor],
    ["{{COMPANY_LOGO}}", branding.logo || ""],
  ]);

  let result = content;
  for (const [search, replace] of replacements) {
    result = result.split(search).join(replace);
  }

  return result;
}

export function renderBrandingBannerHtml(branding = loadBranding(), logoPath = branding.logo) {
  const title = escapeHtml(branding.companyName);
  const tagline = escapeHtml(branding.tagline);
  const accent = escapeHtml(branding.primaryColor);
  const logo = logoPath
    ? `<img src="${escapeHtml(logoPath)}" alt="${title} logo" style="max-height: 48px; max-width: 180px; width: auto; display: block;" />`
    : "";

  return `
<div style="margin: 0 0 24px; border: 1px solid ${accent}; border-radius: 14px; padding: 18px 20px; background: rgba(79, 143, 247, 0.08);">
  <div style="display: flex; align-items: center; gap: 16px; flex-wrap: wrap;">
    ${logo}
    <div>
      <div style="font-size: 28px; font-weight: 700; color: ${accent};">${title}</div>
      <div style="font-size: 14px; color: #666;">${tagline}</div>
    </div>
  </div>
</div>`.trim();
}

export function prependBrandingBanner(content, branding = loadBranding(), logoPath = branding.logo) {
  const brandedContent = applyBrandingTokens(content, branding);
  return `${renderBrandingBannerHtml(branding, logoPath)}\n\n${brandedContent}`;
}
