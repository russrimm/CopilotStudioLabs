/**
 * Pure, dependency-free brand helpers shared by the portal, the lab renderers
 * (Markdown, HTML, DOCX, PDF, PPTX), and the offline lab-builder CLI.
 *
 * Everything that decides what a "brand" is lives here: the field catalog and
 * validation rules, the font allowlist, WCAG contrast math, {{TOKEN}}
 * substitution, and the shared "More information" / "Need help?" content model.
 * Keep this file free of imports other than `./sharepoint-site.js` so
 * `tools/lab-builder/build.mjs` keeps working in bare Node before `npm ci`.
 */

import { normalizeSharepointSiteName, validateSharepointSiteUrl } from "./sharepoint-site.js";

const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F]/g;

export const DARK_SURFACE = "#181c26";
export const LIGHT_SURFACE = "#ffffff";
export const MAX_URL_LENGTH = 2048;

export const DEFAULT_BRAND = Object.freeze({
  companyName: "Microsoft AI Training Generator",
  tagline: "Provisioning Portal",
  logo: null,
  primaryColor: "#4f8ff7",
  secondaryColor: "",
  font: "default",
  coverSubtitle: "",
  footerText: "",
  moreInfoLabel: "",
  moreInfoUrl: "",
  supportName: "",
  supportEmail: "",
  communityUrl: "",
  defaultSharepointSiteName: "",
  defaultSharepointSiteUrl: "",
  copilotStudioUrl: "",
  powerPlatformEnvUrl: "",
  sharepointSiteUrl: "",
  sharepointAdminUrl: "",
  m365AdminUrl: "",
  foundryProjectUrl: "",
});

/**
 * Font allowlist. Only these identifiers are accepted so a brand can never
 * inject arbitrary CSS, XML, or PDF font names. `office` is the typeface name
 * written into DOCX/PPTX, `css` is the HTML font stack, and `pdf` selects the
 * built-in PDF family (the PDF builder only ships base-14 fonts).
 */
export const BRAND_FONTS = Object.freeze({
  default: { label: "Portal default", css: null, office: null, pdf: "sans" },
  "segoe-ui": {
    label: "Segoe UI",
    css: '"Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, Arial, sans-serif',
    office: "Segoe UI",
    pdf: "sans",
  },
  arial: { label: "Arial", css: 'Arial, "Helvetica Neue", Helvetica, sans-serif', office: "Arial", pdf: "sans" },
  calibri: {
    label: "Calibri",
    css: 'Calibri, Carlito, "Segoe UI", Arial, sans-serif',
    office: "Calibri",
    pdf: "sans",
  },
  verdana: { label: "Verdana", css: 'Verdana, Geneva, "Segoe UI", sans-serif', office: "Verdana", pdf: "sans" },
  georgia: { label: "Georgia", css: 'Georgia, "Times New Roman", serif', office: "Georgia", pdf: "serif" },
  "times-new-roman": {
    label: "Times New Roman",
    css: '"Times New Roman", Times, serif',
    office: "Times New Roman",
    pdf: "serif",
  },
});

export const BRAND_FONT_IDS = Object.freeze(Object.keys(BRAND_FONTS));

export function getBrandFont(fontId) {
  return BRAND_FONTS[fontId] || BRAND_FONTS.default;
}

/** Field catalog: drives validation for profiles and per-lab overrides. */
export const TEXT_FIELD_LIMITS = Object.freeze({
  companyName: 80,
  tagline: 120,
  coverSubtitle: 160,
  footerText: 200,
  moreInfoLabel: 60,
  supportName: 80,
  defaultSharepointSiteName: 120,
});

export const COLOR_FIELDS = Object.freeze(["primaryColor", "secondaryColor"]);

export const URL_FIELDS = Object.freeze([
  "moreInfoUrl",
  "communityUrl",
  "defaultSharepointSiteUrl",
  "copilotStudioUrl",
  "powerPlatformEnvUrl",
  "sharepointSiteUrl",
  "sharepointAdminUrl",
  "m365AdminUrl",
  "foundryProjectUrl",
]);

export const EMAIL_FIELDS = Object.freeze(["supportEmail"]);

export const ENVIRONMENT_URL_FIELDS = Object.freeze([
  "copilotStudioUrl",
  "powerPlatformEnvUrl",
  "sharepointSiteUrl",
  "sharepointAdminUrl",
  "m365AdminUrl",
  "foundryProjectUrl",
]);

/** Fields a single lab may override on top of its profile snapshot. */
export const OVERRIDE_FIELDS = Object.freeze([
  "companyName",
  "tagline",
  "coverSubtitle",
  "primaryColor",
  "secondaryColor",
  "moreInfoLabel",
  "moreInfoUrl",
  "supportName",
  "supportEmail",
  "communityUrl",
  "footerText",
  "defaultSharepointSiteName",
  "defaultSharepointSiteUrl",
]);

export const FIELD_LABELS = Object.freeze({
  companyName: "Company name",
  tagline: "Tagline",
  coverSubtitle: "Cover subtitle",
  footerText: "Footer text",
  moreInfoLabel: "More information label",
  moreInfoUrl: "More information URL",
  supportName: "Support contact name",
  supportEmail: "Support email",
  communityUrl: "Community URL",
  defaultSharepointSiteName: "SharePoint site name",
  defaultSharepointSiteUrl: "SharePoint site URL",
  copilotStudioUrl: "Copilot Studio URL",
  powerPlatformEnvUrl: "Power Platform environment URL",
  sharepointSiteUrl: "SharePoint site URL (tenant)",
  sharepointAdminUrl: "SharePoint admin center URL",
  m365AdminUrl: "Microsoft 365 admin center URL",
  foundryProjectUrl: "Foundry project URL",
  primaryColor: "Primary color",
  secondaryColor: "Secondary color",
  font: "Font",
});

export function cleanText(value) {
  return String(value ?? "")
    .replace(CONTROL_CHARS_RE, " ")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeHexColor6(value) {
  const match = String(value ?? "")
    .trim()
    .match(/^#?([0-9a-f]{6}|[0-9a-f]{3})$/i);
  if (!match) return null;
  let raw = match[1].toLowerCase();
  if (raw.length === 3) raw = `${raw[0]}${raw[0]}${raw[1]}${raw[1]}${raw[2]}${raw[2]}`;
  return `#${raw}`;
}

export function isSafeUploadPath(value) {
  return (
    typeof value === "string" &&
    /^\/uploads\/[^/\\\0]+$/i.test(value) &&
    !value.includes("..") &&
    !/\.svgz?$/i.test(value)
  );
}

/**
 * Validate an https-only URL. Bare domains are normalized to https://, while
 * http:, javascript:, data:, protocol-relative URLs, credentials, and spaces
 * are rejected using the same rules as the SharePoint site validator.
 *
 * @returns {{ valid: boolean, url: string, error: string|null }}
 */
export function validateHttpsUrl(raw) {
  if (raw === undefined || raw === null) return { valid: true, url: "", error: null };
  const generic = "Enter a valid https:// URL (for example, https://contoso.sharepoint.com).";
  if (typeof raw !== "string") return { valid: false, url: "", error: generic };
  const cleaned = raw.replace(CONTROL_CHARS_RE, "").trim();
  if (!cleaned) return { valid: true, url: "", error: null };
  if (/^http:\/\//i.test(cleaned)) {
    return { valid: false, url: "", error: "URLs must start with https:// (http:// is not allowed)." };
  }
  const checked = validateSharepointSiteUrl(cleaned);
  if (!checked.valid || !/^https:\/\//i.test(checked.url)) {
    return { valid: false, url: "", error: generic };
  }
  if (checked.url.length > MAX_URL_LENGTH) {
    return { valid: false, url: "", error: `URLs must be at most ${MAX_URL_LENGTH} characters.` };
  }
  return { valid: true, url: checked.url, error: null };
}

const EMAIL_RE = /^[^\s@<>"',;:()[\]\\]+@[^\s@<>"',;:()[\]\\]+\.[^\s@<>"',;:()[\]\\]+$/;

export function validateEmail(raw) {
  if (raw === undefined || raw === null) return { valid: true, email: "", error: null };
  if (typeof raw !== "string") return { valid: false, email: "", error: "Enter a valid email address." };
  const cleaned = raw.replace(CONTROL_CHARS_RE, "").trim();
  if (!cleaned) return { valid: true, email: "", error: null };
  if (cleaned.length > 254 || !EMAIL_RE.test(cleaned)) {
    return { valid: false, email: "", error: "Enter a valid email address (for example, help@contoso.com)." };
  }
  return { valid: true, email: cleaned, error: null };
}

/**
 * Strictly validate the supplied brand fields. Only own properties present in
 * `input` and listed in `fields` are checked, so callers can validate partial
 * patches. Blank optional values clear the field.
 *
 * @returns {{ values: object, errors: Record<string, string> }}
 */
export function validateBrandFields(input, fields) {
  const values = {};
  const errors = {};
  const src = input && typeof input === "object" ? input : {};
  const wanted = new Set(fields);
  const has = (key) => wanted.has(key) && Object.prototype.hasOwnProperty.call(src, key);

  for (const key of Object.keys(TEXT_FIELD_LIMITS)) {
    if (!has(key)) continue;
    const raw = src[key];
    if (raw !== null && raw !== undefined && typeof raw !== "string") {
      errors[key] = `${FIELD_LABELS[key]} must be text.`;
      continue;
    }
    const text = key === "defaultSharepointSiteName" ? normalizeSharepointSiteName(cleanText(raw)) : cleanText(raw);
    if (text.length > TEXT_FIELD_LIMITS[key]) {
      errors[key] = `${FIELD_LABELS[key]} must be at most ${TEXT_FIELD_LIMITS[key]} characters.`;
      continue;
    }
    if (key === "companyName" && !text) {
      errors[key] = "Company name is required.";
      continue;
    }
    values[key] = text;
  }

  for (const key of COLOR_FIELDS) {
    if (!has(key)) continue;
    const raw = src[key];
    const text = String(raw ?? "").trim();
    if (!text && key === "secondaryColor") {
      values[key] = "";
      continue;
    }
    const hex = normalizeHexColor6(text);
    if (!hex) {
      errors[key] = `${FIELD_LABELS[key]} must be a hex color such as #0f6cbd.`;
      continue;
    }
    values[key] = hex;
  }

  if (has("font")) {
    const raw = String(src.font ?? "").trim() || "default";
    if (!Object.prototype.hasOwnProperty.call(BRAND_FONTS, raw)) {
      errors.font = `Font must be one of: ${BRAND_FONT_IDS.join(", ")}.`;
    } else {
      values.font = raw;
    }
  }

  for (const key of URL_FIELDS) {
    if (!has(key)) continue;
    const checked = validateHttpsUrl(src[key]);
    if (!checked.valid) errors[key] = `${FIELD_LABELS[key]}: ${checked.error}`;
    else values[key] = checked.url;
  }

  for (const key of EMAIL_FIELDS) {
    if (!has(key)) continue;
    const checked = validateEmail(src[key]);
    if (!checked.valid) errors[key] = `${FIELD_LABELS[key]}: ${checked.error}`;
    else values[key] = checked.email;
  }

  return { values, errors };
}

/**
 * Tolerant normalization for render-time use: invalid or missing values fall
 * back to the defaults instead of throwing, so partial objects (such as the
 * classic `{ companyName, tagline, primaryColor, logo }` shape) always work.
 */
export function normalizeBrand(input = {}) {
  const src = input && typeof input === "object" ? input : {};
  const out = { ...DEFAULT_BRAND };

  for (const key of Object.keys(TEXT_FIELD_LIMITS)) {
    const text = cleanText(src[key]).slice(0, TEXT_FIELD_LIMITS[key]);
    out[key] = text || DEFAULT_BRAND[key];
  }
  for (const key of COLOR_FIELDS) {
    out[key] = normalizeHexColor6(src[key]) || DEFAULT_BRAND[key];
  }
  out.font = Object.prototype.hasOwnProperty.call(BRAND_FONTS, src.font) ? src.font : "default";
  for (const key of URL_FIELDS) {
    const checked = validateHttpsUrl(typeof src[key] === "string" ? src[key] : "");
    out[key] = checked.valid ? checked.url : "";
  }
  for (const key of EMAIL_FIELDS) {
    const checked = validateEmail(typeof src[key] === "string" ? src[key] : "");
    out[key] = checked.valid ? checked.email : "";
  }
  out.logo = isSafeUploadPath(src.logo) ? src.logo : null;

  const siteName = normalizeSharepointSiteName(cleanText(src.labSiteName));
  const siteUrl = validateHttpsUrl(typeof src.labSiteUrl === "string" ? src.labSiteUrl : "");
  if (siteName) out.labSiteName = siteName;
  if (siteUrl.valid && siteUrl.url) out.labSiteUrl = siteUrl.url;
  if (typeof src.profileId === "string") out.profileId = src.profileId;
  if (typeof src.profileName === "string") out.profileName = cleanText(src.profileName);
  return out;
}

/** Layer non-blank override values over a normalized brand. */
export function applyBrandOverrides(brand, overrides) {
  const base = { ...normalizeBrand(brand) };
  const src = overrides && typeof overrides === "object" ? overrides : {};
  const { values } = validateBrandFields(src, OVERRIDE_FIELDS);
  for (const key of OVERRIDE_FIELDS) {
    const value = values[key];
    if (typeof value === "string" && value) base[key] = value;
  }
  return base;
}

/** True when any visible brand field differs from the portal defaults. */
export function hasBrandCustomization(brand) {
  const normalized = normalizeBrand(brand);
  if (normalized.logo) return true;
  for (const key of Object.keys(DEFAULT_BRAND)) {
    if (key === "logo") continue;
    if (normalized[key] !== DEFAULT_BRAND[key]) return true;
  }
  return Boolean(normalized.labSiteName || normalized.labSiteUrl);
}

// ── WCAG contrast ───────────────────────────────────────────────────────────

function hexToRgb(hex) {
  const normalized = normalizeHexColor6(hex);
  if (!normalized) return null;
  return [1, 3, 5].map((index) => parseInt(normalized.slice(index, index + 2), 16));
}

function relativeLuminance(rgb) {
  const [r, g, b] = rgb.map((channel) => {
    const s = channel / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio between two hex colors, or null when either is invalid. */
export function contrastRatio(hexA, hexB) {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  if (!a || !b) return null;
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

export function describeContrast(hex) {
  const color = normalizeHexColor6(hex);
  if (!color) return null;
  const onWhite = contrastRatio(color, LIGHT_SURFACE);
  const onDark = contrastRatio(color, DARK_SURFACE);
  return {
    color,
    onWhite: round2(onWhite),
    onDark: round2(onDark),
    aaOnWhite: onWhite >= 4.5,
    aaOnDark: onDark >= 4.5,
    aaLargeOnWhite: onWhite >= 3,
    aaLargeOnDark: onDark >= 3,
    bestTextColor: contrastRatio(color, "#ffffff") >= contrastRatio(color, "#0b0e14") ? "#ffffff" : "#0b0e14",
  };
}

/** Contrast report for the profile colors, including human-readable warnings. */
export function describeBrandContrast(brand) {
  const normalized = normalizeBrand(brand);
  const report = { primary: describeContrast(normalized.primaryColor), secondary: null, warnings: [] };
  if (normalized.secondaryColor) report.secondary = describeContrast(normalized.secondaryColor);
  for (const [label, entry] of [
    ["Primary", report.primary],
    ["Secondary", report.secondary],
  ]) {
    if (!entry) continue;
    if (!entry.aaOnWhite) {
      report.warnings.push(
        `${label} color ${entry.color} has a contrast ratio of ${entry.onWhite}:1 on white, below the WCAG AA minimum of 4.5:1 for small text.`,
      );
    }
    if (!entry.aaOnDark) {
      report.warnings.push(
        `${label} color ${entry.color} has a contrast ratio of ${entry.onDark}:1 on dark backgrounds, below the WCAG AA minimum of 4.5:1 for small text.`,
      );
    }
  }
  return report;
}

/**
 * Darken or lighten `hex` toward `targetHex` until it reaches `minRatio`
 * against every background. Used to keep brand-colored text readable.
 */
export function ensureReadableColor(hex, backgrounds, targetHex, minRatio = 4.5) {
  const start = hexToRgb(hex);
  const target = hexToRgb(targetHex);
  const bgs = backgrounds.map(hexToRgb).filter(Boolean);
  if (!start || !target || !bgs.length) return normalizeHexColor6(hex) || hex;
  const toHex = (rgb) =>
    `#${rgb.map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, "0")).join("")}`;
  const ratioRgb = (rgbA, rgbB) => {
    const l1 = relativeLuminance(rgbA);
    const l2 = relativeLuminance(rgbB);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  const passes = (rgb) => bgs.every((bg) => ratioRgb(rgb.map((c) => Math.max(0, Math.min(255, Math.round(c)))), bg) >= minRatio);
  if (passes(start)) return toHex(start);
  let low = 0;
  let high = 1;
  let best = target;
  for (let step = 0; step < 18; step += 1) {
    const mid = (low + high) / 2;
    const blended = start.map((c, index) => c + (target[index] - c) * mid);
    if (passes(blended)) {
      best = blended;
      high = mid;
    } else {
      low = mid;
    }
  }
  return toHex(best);
}

// ── Escaping ────────────────────────────────────────────────────────────────

export function escapeHtmlText(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── Tokens ──────────────────────────────────────────────────────────────────

export const BRAND_TOKEN_NAMES = Object.freeze([
  "COMPANY_NAME",
  "TAGLINE",
  "PRIMARY_COLOR",
  "SECONDARY_COLOR",
  "COMPANY_LOGO",
  "COVER_SUBTITLE",
  "MORE_INFO_URL",
  "MORE_INFO_LABEL",
  "SUPPORT_EMAIL",
  "SUPPORT_NAME",
  "FOOTER_TEXT",
  "COMMUNITY_URL",
  "SHAREPOINT_SITE_URL",
  "SHAREPOINT_SITE_NAME",
  "TENANT_COPILOT_STUDIO_URL",
  "TENANT_POWER_PLATFORM_URL",
  "TENANT_SHAREPOINT_ADMIN_URL",
  "TENANT_M365_ADMIN_URL",
  "TENANT_FOUNDRY_PROJECT_URL",
]);

const URL_TOKEN_NAMES = new Set([
  "MORE_INFO_URL",
  "COMMUNITY_URL",
  "SHAREPOINT_SITE_URL",
  "TENANT_COPILOT_STUDIO_URL",
  "TENANT_POWER_PLATFORM_URL",
  "TENANT_SHAREPOINT_ADMIN_URL",
  "TENANT_M365_ADMIN_URL",
  "TENANT_FOUNDRY_PROJECT_URL",
]);

export const MORE_INFO_FALLBACK_LABEL = "More information";
export const COMMUNITY_LABEL = "Join the community";

export function getBrandSharepointSite(brand) {
  const normalized = normalizeBrand(brand);
  return {
    name: normalized.labSiteName || normalized.defaultSharepointSiteName || "",
    url: normalized.labSiteUrl || normalized.defaultSharepointSiteUrl || normalized.sharepointSiteUrl || "",
  };
}

export function getBrandTokenValues(brand) {
  const normalized = normalizeBrand(brand);
  const site = getBrandSharepointSite(normalized);
  const moreInfoLabel = normalized.moreInfoLabel || (normalized.moreInfoUrl ? MORE_INFO_FALLBACK_LABEL : "");
  return {
    COMPANY_NAME: normalized.companyName,
    TAGLINE: normalized.tagline,
    PRIMARY_COLOR: normalized.primaryColor,
    SECONDARY_COLOR: normalized.secondaryColor,
    COMPANY_LOGO: normalized.logo || "",
    COVER_SUBTITLE: normalized.coverSubtitle,
    MORE_INFO_URL: normalized.moreInfoUrl,
    MORE_INFO_LABEL: moreInfoLabel,
    SUPPORT_EMAIL: normalized.supportEmail,
    SUPPORT_NAME: normalized.supportName,
    FOOTER_TEXT: normalized.footerText,
    COMMUNITY_URL: normalized.communityUrl,
    SHAREPOINT_SITE_URL: site.url,
    SHAREPOINT_SITE_NAME: site.name,
    TENANT_COPILOT_STUDIO_URL: normalized.copilotStudioUrl,
    TENANT_POWER_PLATFORM_URL: normalized.powerPlatformEnvUrl,
    TENANT_SHAREPOINT_ADMIN_URL: normalized.sharepointAdminUrl,
    TENANT_M365_ADMIN_URL: normalized.m365AdminUrl,
    TENANT_FOUNDRY_PROJECT_URL: normalized.foundryProjectUrl,
  };
}

/**
 * Replace every supported {{TOKEN}}. Empty values render nothing, and Markdown
 * links or autolinks left empty by a missing URL collapse to their label so no
 * raw braces or broken `[text]()` constructs reach learners. Unrelated
 * `{{...}}` text (for example template examples in labs) is left untouched.
 */
export function applyBrandTokens(content, brand) {
  const text = String(content ?? "");
  if (!text.includes("{{")) return text;
  const values = getBrandTokenValues(brand);
  let emptiedUrl = false;
  let result = text;
  for (const name of BRAND_TOKEN_NAMES) {
    const token = `{{${name}}}`;
    if (!result.includes(token)) continue;
    const value = values[name] ?? "";
    if (!value && URL_TOKEN_NAMES.has(name)) emptiedUrl = true;
    result = result.split(token).join(value);
  }
  if (emptiedUrl) {
    result = result.replace(/\[([^\]]*)\]\(\s*\)/g, "$1").replace(/<\s*>/g, "");
  }
  return result;
}

// ── "More information" and "Need help?" content ─────────────────────────────

/** Structured content shared by every renderer. */
export function getBrandInfoModel(brand) {
  const normalized = normalizeBrand(brand);
  const moreInfo = normalized.moreInfoUrl
    ? { label: normalized.moreInfoLabel || MORE_INFO_FALLBACK_LABEL, url: normalized.moreInfoUrl }
    : null;
  const support =
    normalized.supportEmail || normalized.supportName
      ? {
          name: normalized.supportName,
          email: normalized.supportEmail,
          mailto: normalized.supportEmail ? `mailto:${normalized.supportEmail}` : "",
        }
      : null;
  const community = normalized.communityUrl ? { label: COMMUNITY_LABEL, url: normalized.communityUrl } : null;
  const footerText = normalized.footerText;
  return {
    moreInfo,
    support,
    community,
    footerText,
    hasLinks: Boolean(moreInfo || support || community),
    hasAny: Boolean(moreInfo || support || community || footerText),
  };
}

function markdownHref(url) {
  return String(url || "")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/\s+/g, "%20");
}

function markdownLabel(text) {
  return String(text || "").replace(/[\\[\]|]/g, (ch) => `\\${ch}`);
}

/**
 * Markdown for the closing "More information" and "Need help?" blocks plus the
 * footer line. Returns an empty string when the brand has none of them.
 */
export function renderBrandInfoMarkdown(brand) {
  const info = getBrandInfoModel(brand);
  if (!info.hasAny) return "";
  const lines = ["", "---", ""];
  if (info.moreInfo) {
    lines.push("### More information", "", `[${markdownLabel(info.moreInfo.label)}](${markdownHref(info.moreInfo.url)})`, "");
  }
  if (info.support || info.community) {
    lines.push("### Need help?", "");
    if (info.support) {
      const who = info.support.name ? `**${markdownLabel(info.support.name)}**` : "your support contact";
      lines.push(
        info.support.email
          ? `Contact ${who} at [${markdownLabel(info.support.email)}](${info.support.mailto}).`
          : `Contact ${who}.`,
        "",
      );
    }
    if (info.community) {
      lines.push(`${info.community.label}: [${markdownLabel(info.community.url.replace(/^https:\/\//, ""))}](${markdownHref(info.community.url)})`, "");
    }
  }
  if (info.footerText) lines.push(`*${markdownLabel(info.footerText)}*`, "");
  return lines.join("\n");
}

/** Escaped HTML for the same content, used by HTML pages that are not built from Markdown. */
export function renderBrandInfoHtml(brand, { className = "lab-brand-info" } = {}) {
  const info = getBrandInfoModel(brand);
  if (!info.hasAny) return "";
  const parts = [];
  if (info.moreInfo) {
    parts.push(
      `<section class="${className}-block" aria-labelledby="${className}-more"><h2 id="${className}-more">More information</h2><p><a href="${escapeHtmlText(info.moreInfo.url)}" rel="noopener noreferrer">${escapeHtmlText(info.moreInfo.label)}</a></p></section>`,
    );
  }
  if (info.support || info.community) {
    const bits = [];
    if (info.support) {
      const name = info.support.name ? `<strong>${escapeHtmlText(info.support.name)}</strong>` : "your support contact";
      bits.push(
        info.support.email
          ? `<p>Contact ${name} at <a href="${escapeHtmlText(info.support.mailto)}">${escapeHtmlText(info.support.email)}</a>.</p>`
          : `<p>Contact ${name}.</p>`,
      );
    }
    if (info.community) {
      bits.push(
        `<p>${escapeHtmlText(info.community.label)}: <a href="${escapeHtmlText(info.community.url)}" rel="noopener noreferrer">${escapeHtmlText(info.community.url.replace(/^https:\/\//, ""))}</a></p>`,
      );
    }
    parts.push(`<section class="${className}-block" aria-labelledby="${className}-help"><h2 id="${className}-help">Need help?</h2>${bits.join("")}</section>`);
  }
  if (info.footerText) parts.push(`<p class="${className}-footer">${escapeHtmlText(info.footerText)}</p>`);
  return `<div class="${className}">${parts.join("")}</div>`;
}

/** Plain-text lines for footers, README files, and slides. */
export function getBrandInfoLines(brand) {
  const info = getBrandInfoModel(brand);
  const lines = [];
  if (info.moreInfo) lines.push(`${info.moreInfo.label}: ${info.moreInfo.url}`);
  if (info.support) {
    const who = info.support.name || "Support";
    lines.push(info.support.email ? `Need help? Contact ${who} at ${info.support.email}` : `Need help? Contact ${who}`);
  }
  if (info.community) lines.push(`${info.community.label}: ${info.community.url}`);
  return lines;
}

// ── Capture environment ─────────────────────────────────────────────────────

export const CAPTURE_ENV_MAP = Object.freeze({
  copilotStudioUrl: "CAPTURE_COPILOT_STUDIO_START_URL",
  powerPlatformEnvUrl: "CAPTURE_POWER_PLATFORM_START_URL",
  sharepointSiteUrl: "CAPTURE_SHAREPOINT_SITE_URL",
  sharepointAdminUrl: "CAPTURE_SHAREPOINT_ADMIN_URL",
  m365AdminUrl: "CAPTURE_M365_ADMIN_URL",
  foundryProjectUrl: "CAPTURE_FOUNDRY_PROJECT_URL",
});
