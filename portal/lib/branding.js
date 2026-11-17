import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { isAbsolute, relative, resolve } from "path";
import { PORTAL_ROOT, resolvePortalDataDir, resolvePortalUploadsDir } from "./storage-config.js";

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
  return (
    typeof value === "string" &&
    /^\/uploads\/[^/\\\0]+$/i.test(value) &&
    !value.includes("..") &&
    !/\.svgz?$/i.test(value)
  );
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function ensureBrandingStorage(env = process.env) {
  ensureDir(getBrandingDataDir(env));
  ensureDir(getBrandingUploadsDir(env));
}

export function normalizeBranding(input = {}, current = DEFAULT_BRANDING) {
  return {
    companyName: normalizeText(input.companyName, current.companyName || DEFAULT_BRANDING.companyName),
    logo: isUploadPath(input.logo) ? input.logo : current.logo || null,
    primaryColor: normalizePrimaryColor(input.primaryColor || current.primaryColor),
    tagline: normalizeText(input.tagline, current.tagline || DEFAULT_BRANDING.tagline),
  };
}

export function loadBranding(env = process.env) {
  ensureBrandingStorage(env);
  const brandingFile = getBrandingFilePath(env);

  if (!existsSync(brandingFile)) {
    return { ...DEFAULT_BRANDING };
  }

  try {
    const saved = JSON.parse(readFileSync(brandingFile, "utf-8"));
    return normalizeBranding(saved, DEFAULT_BRANDING);
  } catch {
    return { ...DEFAULT_BRANDING };
  }
}

export function saveBranding(input = {}, env = process.env) {
  ensureBrandingStorage(env);
  const branding = normalizeBranding(input, loadBranding(env));
  writeFileSync(getBrandingFilePath(env), `${JSON.stringify(branding, null, 2)}\n`, "utf-8");
  return branding;
}

export function getBrandingLogoAbsolutePath(logoPath, env = process.env) {
  if (!isUploadPath(logoPath)) return null;
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

export function deleteBrandingLogo(env = process.env) {
  const current = loadBranding(env);
  const existingLogoPath = getBrandingLogoAbsolutePath(current.logo, env);
  if (existingLogoPath && existsSync(existingLogoPath)) {
    unlinkSync(existingLogoPath);
  }

  const next = {
    ...current,
    logo: null,
  };
  writeFileSync(getBrandingFilePath(env), `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  return next;
}

export function updateBrandingLogo(fileName, env = process.env) {
  ensureBrandingStorage(env);
  const current = loadBranding(env);
  const previousLogoPath = getBrandingLogoAbsolutePath(current.logo, env);
  const nextLogoPath = resolve(getBrandingUploadsDir(env), fileName);
  const next = {
    ...current,
    logo: `/uploads/${fileName}`,
  };

  if (previousLogoPath && previousLogoPath !== nextLogoPath && existsSync(previousLogoPath)) {
    unlinkSync(previousLogoPath);
  }

  writeFileSync(getBrandingFilePath(env), `${JSON.stringify(next, null, 2)}\n`, "utf-8");
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
<div class="lab-branding-banner" style="margin: 0 0 24px; border: 1px solid ${accent}; border-radius: 14px; padding: 18px 20px; background: rgba(79, 143, 247, 0.08);">
  <div style="display: flex; align-items: center; gap: 16px; flex-wrap: wrap;">
    ${logo}
    <div>
      <div class="lab-branding-title" style="font-size: 28px; font-weight: 700; color: ${accent};">${title}</div>
      <div class="lab-branding-tagline" style="font-size: 14px;">${tagline}</div>
    </div>
  </div>
</div>`.trim();
}

export function prependBrandingBanner(content, branding = loadBranding(), logoPath = branding.logo) {
  const brandedContent = applyBrandingTokens(content, branding);
  return `${renderBrandingBannerHtml(branding, logoPath)}\n\n${brandedContent}`;
}
