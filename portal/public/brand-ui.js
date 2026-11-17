/**
 * Brand helpers shared by the Configuration tab, the lab builder's Step 7
 * "Customize this lab" card, and the saved-lab Customize section.
 *
 * Pure functions only (no DOM access at load time) so every page and the unit
 * tests can use them. Validation mirrors `portal/lib/lab-builder/brand-theme.js`;
 * the server always re-validates, this only gives instant inline feedback.
 */

const BRAND_FIELD_LABELS = {
  name: "Profile name",
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
};

const BRAND_TEXT_LIMITS = {
  name: 60,
  companyName: 80,
  tagline: 120,
  coverSubtitle: 160,
  footerText: 200,
  moreInfoLabel: 60,
  supportName: 80,
  defaultSharepointSiteName: 120,
};

const BRAND_URL_FIELDS = [
  "moreInfoUrl",
  "communityUrl",
  "defaultSharepointSiteUrl",
  "copilotStudioUrl",
  "powerPlatformEnvUrl",
  "sharepointSiteUrl",
  "sharepointAdminUrl",
  "m365AdminUrl",
  "foundryProjectUrl",
];

/** Fields a single lab may override (same list as the server's OVERRIDE_FIELDS). */
const BRAND_OVERRIDE_FIELDS = [
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
];

const BRAND_DEFAULT_PROFILE = {
  companyName: "Microsoft AI Training Generator",
  tagline: "Provisioning Portal",
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
};

/** Preview-only font stacks; the server allowlist decides what exports can use. */
const BRAND_FONT_STACKS = {
  default: "",
  "segoe-ui": '"Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, Arial, sans-serif',
  arial: 'Arial, "Helvetica Neue", Helvetica, sans-serif',
  calibri: 'Calibri, Carlito, "Segoe UI", Arial, sans-serif',
  verdana: 'Verdana, Geneva, "Segoe UI", sans-serif',
  georgia: 'Georgia, "Times New Roman", serif',
  "times-new-roman": '"Times New Roman", Times, serif',
};

const BRAND_DARK_SURFACE = "#181c26";

function brandEscapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function brandNormalizeHex(value) {
  const match = String(value ?? "").trim().match(/^#?([0-9a-f]{6}|[0-9a-f]{3})$/i);
  if (!match) return null;
  let raw = match[1].toLowerCase();
  if (raw.length === 3) raw = `${raw[0]}${raw[0]}${raw[1]}${raw[1]}${raw[2]}${raw[2]}`;
  return `#${raw}`;
}

function brandHexToRgb(hex) {
  const normalized = brandNormalizeHex(hex);
  if (!normalized) return null;
  return [1, 3, 5].map((index) => parseInt(normalized.slice(index, index + 2), 16));
}

function brandLuminance(rgb) {
  const [r, g, b] = rgb.map((channel) => {
    const s = channel / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio between two hex colors, or null when either is invalid. */
function brandContrastRatio(hexA, hexB) {
  const a = brandHexToRgb(hexA);
  const b = brandHexToRgb(hexB);
  if (!a || !b) return null;
  const l1 = brandLuminance(a);
  const l2 = brandLuminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function brandContrastReport(hex) {
  const color = brandNormalizeHex(hex);
  if (!color) return null;
  const onWhite = brandContrastRatio(color, "#ffffff");
  const onDark = brandContrastRatio(color, BRAND_DARK_SURFACE);
  return {
    color,
    onWhite: Math.round(onWhite * 100) / 100,
    onDark: Math.round(onDark * 100) / 100,
    aaOnWhite: onWhite >= 4.5,
    aaOnDark: onDark >= 4.5,
  };
}

/** Plain-language warnings for the two brand colors; empty when both pass WCAG AA. */
function brandContrastWarnings(primary, secondary) {
  const warnings = [];
  for (const [label, hex] of [["Primary", primary], ["Secondary", secondary]]) {
    const report = hex ? brandContrastReport(hex) : null;
    if (!report) continue;
    if (!report.aaOnWhite) {
      warnings.push(`${label} color ${report.color} has a contrast ratio of ${report.onWhite}:1 on white, below the WCAG AA minimum of 4.5:1 for small text.`);
    }
    if (!report.aaOnDark) {
      warnings.push(`${label} color ${report.color} has a contrast ratio of ${report.onDark}:1 on dark backgrounds, below the WCAG AA minimum of 4.5:1 for small text.`);
    }
  }
  return warnings;
}

/** Darken (or lighten) a color toward a target until it reaches the contrast ratio on the background. */
function brandReadableOn(hex, backgroundHex, targetHex, minRatio) {
  const start = brandHexToRgb(hex);
  const target = brandHexToRgb(targetHex);
  const normalized = brandNormalizeHex(hex);
  if (!start || !target || !brandNormalizeHex(backgroundHex)) return normalized || hex;
  const passes = (rgb) => {
    const rounded = rgb.map((c) => Math.max(0, Math.min(255, Math.round(c))));
    const l1 = brandLuminance(rounded);
    const l2 = brandLuminance(brandHexToRgb(backgroundHex));
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05) >= (minRatio || 4.5);
  };
  const toHex = (rgb) => `#${rgb.map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, "0")).join("")}`;
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

/** Returns an error message for an invalid https URL, or "" when the value is blank or valid. */
function brandValidateUrl(raw) {
  const value = String(raw ?? "").replace(/[\u0000-\u001F\u007F]/g, "").trim();
  if (!value) return "";
  const generic = "Enter a valid https:// URL (for example, https://contoso.sharepoint.com).";
  if (/^(?:javascript|data|vbscript|file|blob):/i.test(value) || value.startsWith("//") || /[<>"`\s]/.test(value)) return generic;
  if (/^http:\/\//i.test(value)) return "URLs must start with https:// (http:// is not allowed).";
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return generic;
  }
  if (parsed.protocol !== "https:") return generic;
  if (parsed.username || parsed.password) return "URLs must not include embedded credentials.";
  if (!parsed.hostname.includes(".") || parsed.hostname.startsWith(".") || parsed.hostname.endsWith(".")) return generic;
  if (candidate.length > 2048) return "URLs must be at most 2048 characters.";
  return "";
}

function brandValidateEmail(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  if (value.length > 254 || !/^[^\s@<>"',;:()[\]\\]+@[^\s@<>"',;:()[\]\\]+\.[^\s@<>"',;:()[\]\\]+$/.test(value)) {
    return "Enter a valid email address (for example, help@contoso.com).";
  }
  return "";
}

/** Inline validation for one field; returns an error message or "" when the value is acceptable. */
function brandValidateField(key, value) {
  const label = BRAND_FIELD_LABELS[key] || key;
  const text = String(value ?? "");
  if (key === "name" && !text.trim()) return "Profile name is required.";
  if (key === "companyName" && !text.trim()) return "Company name is required.";
  if (BRAND_TEXT_LIMITS[key] && text.trim().length > BRAND_TEXT_LIMITS[key]) {
    return `${label} must be at most ${BRAND_TEXT_LIMITS[key]} characters.`;
  }
  if (key === "primaryColor" && !brandNormalizeHex(text)) return "Primary color must be a hex color such as #0f6cbd.";
  if (key === "secondaryColor" && text.trim() && !brandNormalizeHex(text)) return "Secondary color must be a hex color such as #c2410c, or blank.";
  if (BRAND_URL_FIELDS.includes(key)) {
    const error = brandValidateUrl(text);
    return error ? `${label}: ${error}` : "";
  }
  if (key === "supportEmail") {
    const error = brandValidateEmail(text);
    return error ? `${label}: ${error}` : "";
  }
  return "";
}

/** Layer non-blank override values over a profile (blank means "use the profile value"). */
function brandMergeOverrides(base, overrides) {
  const merged = { ...BRAND_DEFAULT_PROFILE, ...(base || {}) };
  for (const key of BRAND_OVERRIDE_FIELDS) {
    const value = overrides && typeof overrides[key] === "string" ? overrides[key].trim() : "";
    if (value) merged[key] = value;
  }
  return merged;
}

/** Names of the overridden fields, for one-line summaries. */
function brandOverrideNames(overrides) {
  return BRAND_OVERRIDE_FIELDS.filter((key) => typeof overrides?.[key] === "string" && overrides[key].trim()).map(
    (key) => (BRAND_FIELD_LABELS[key] || key).toLowerCase(),
  );
}

function brandSafeUrl(url) {
  const value = String(url || "").trim();
  if (!value || brandValidateUrl(value)) return "";
  return /^https:\/\//i.test(value) ? value : `https://${value}`;
}

/**
 * Markup for a compact "paper" preview of the lab banner, a content sample, the
 * "More information" / "Need help?" blocks, and the footer. Every value is escaped
 * and only validated hex colors and https links reach attributes.
 */
function renderBrandPreviewHtml(brand, options = {}) {
  const b = { ...BRAND_DEFAULT_PROFILE, ...(brand || {}) };
  const primary = brandNormalizeHex(b.primaryColor) || BRAND_DEFAULT_PROFILE.primaryColor;
  const secondary = brandNormalizeHex(b.secondaryColor) || "";
  const title = brandReadableOn(primary, "#ffffff", "#000000", 4.5);
  const rgb = brandHexToRgb(primary);
  const tint = `rgba(${rgb.join(", ")}, 0.1)`;
  const fontStack = BRAND_FONT_STACKS[b.font] || "";
  const styleVars = [`--pv-title:${title}`, `--pv-tint:${tint}`, secondary ? `--pv-secondary:${secondary}` : "", fontStack ? `font-family:${fontStack}` : ""]
    .filter(Boolean)
    .join(";");
  const logo = /^\/uploads\/[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpe?g)$/i.test(String(b.logo || ""))
    ? `<img class="bp-pv-logo" src="${brandEscapeHtml(b.logo)}" alt="" />`
    : "";
  const moreInfoUrl = brandSafeUrl(b.moreInfoUrl);
  const communityUrl = brandSafeUrl(b.communityUrl);
  const supportEmail = brandValidateEmail(b.supportEmail) ? "" : String(b.supportEmail || "").trim();
  const info = [];
  if (moreInfoUrl) {
    info.push(`<div><strong>More information:</strong> <a href="${brandEscapeHtml(moreInfoUrl)}" target="_blank" rel="noopener noreferrer">${brandEscapeHtml(b.moreInfoLabel || "More information")}</a></div>`);
  }
  if (b.supportName || supportEmail) {
    const who = b.supportName ? brandEscapeHtml(b.supportName) : "your support contact";
    info.push(`<div><strong>Need help?</strong> Contact ${who}${supportEmail ? ` at <a href="mailto:${brandEscapeHtml(supportEmail)}">${brandEscapeHtml(supportEmail)}</a>` : ""}</div>`);
  }
  if (communityUrl) {
    info.push(`<div><strong>Join the community:</strong> <a href="${brandEscapeHtml(communityUrl)}" target="_blank" rel="noopener noreferrer">${brandEscapeHtml(communityUrl.replace(/^https:\/\//, ""))}</a></div>`);
  }
  const labTitle = options.labTitle ? brandEscapeHtml(options.labTitle) : "Your lab title";
  return `<div class="bp-pv" style="${brandEscapeHtml(styleVars)}">
  <div class="bp-pv-banner">
    ${logo}
    <div>
      <div class="bp-pv-company">${brandEscapeHtml(b.companyName || BRAND_DEFAULT_PROFILE.companyName)}</div>
      <div class="bp-pv-tagline">${brandEscapeHtml(b.tagline || BRAND_DEFAULT_PROFILE.tagline)}</div>
      ${b.coverSubtitle ? `<div class="bp-pv-subtitle">${brandEscapeHtml(b.coverSubtitle)}</div>` : ""}
    </div>
  </div>
  <div class="bp-pv-body">
    <div class="bp-pv-lab-title">${labTitle}</div>
    <div class="bp-pv-line"></div>
    <div class="bp-pv-line short"></div>
    ${info.length ? `<div class="bp-pv-info">${info.join("")}</div>` : ""}
  </div>
  <div class="bp-pv-footer">${brandEscapeHtml(b.footerText || "")}</div>
</div>`;
}
