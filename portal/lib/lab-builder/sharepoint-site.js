/**
 * Shared SharePoint site detection, validation, normalization, and clickable
 * Markdown hyperlink helpers for the Lab Builder.
 *
 * Strictly zero external npm dependencies. Keep the feature/product detection
 * rules synchronized with `portal/public/lab-builder-wizard.js`.
 */

const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F]/g;

/**
 * Explicit catalog and legacy feature IDs across non-`sharepoint-ai` products
 * that require having, creating, grounding in, or governing a SharePoint site,
 * document library, or list.
 */
export const SHAREPOINT_FEATURE_IDS = new Set([
  "knowledge-sharepoint",
  "mc-knowledge",
  "mc-knowledge-enterprise",
  "dca-agent-builder-knowledge",
  "dca-toolkit-knowledge-capabilities",
  "dca-knowledge-sharepoint-onedrive",
  "m365h-data-access-governance-reports",
  "m365h-restricted-content-discovery",
  "m365h-secure-copilot-data",
  "ppai-document-processing-model",
  "sp-ai-page-approval-flow",
]);

const SHAREPOINT_STEP_ACTION_RE =
  /\b(?:create|open|navigate\s+to|go\s+to|enter|paste|provide|type|connect|ground|restrict|govern|assess|review|run\s+data\s+access\s+governance\s+reports\s+for)\b[^.]{0,90}\bsharepoint\s+(?:site|sites|url|urls|document\s+library|library|libraries|list|lists|page|pages|team\s+site|communication\s+site)\b|\bsharepoint\.com\/(?:sites|teams)\b|\bOneDriveAndSharePoint\b/i;

const SHAREPOINT_CAPABILITY_TOKEN_RE =
  /^(?:sharepoint|onedriveandsharepoint|sharepoint-online|spo|sam)$/i;

const BARE_HOSTNAME_URL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+(?:\/.*)?$/i;

const UNSAFE_SCHEME_RE = /^\s*(?:javascript|data|vbscript|file|blob):/i;

/**
 * Determine whether a single feature/topic requires having, creating,
 * configuring, grounding in, or governing a SharePoint site.
 *
 * @param {string|object|null|undefined} feature
 * @returns {boolean}
 */
export function featureRequiresSharepointSite(feature) {
  if (!feature) return false;
  if (typeof feature === "string") {
    const rawId = feature.trim();
    if (!rawId) return false;
    return (
      SHAREPOINT_FEATURE_IDS.has(rawId) ||
      /^sp(?:ai|-ai)-/i.test(rawId) ||
      /\bsharepoint\b/i.test(rawId)
    );
  }
  if (typeof feature !== "object") return false;
  if (feature.requiresSharepointSite === true) return true;

  const id = String(feature.id || "").trim();
  const product = String(feature.product || "").trim();
  if (product === "sharepoint-ai") return true;
  if (id && (SHAREPOINT_FEATURE_IDS.has(id) || /^sp(?:ai|-ai)-/i.test(id) || /\bsharepoint\b/i.test(id))) {
    return true;
  }

  const name = String(feature.name || "");
  if (/\bsharepoint\b/i.test(name)) return true;

  // Exclude billing-only mentions of the "SharePoint agents" pay-as-you-go service
  // so billing setup topics do not prompt for a SharePoint site URL unnecessarily.
  const summaryWithoutBillingService = String(feature.summary || "").replace(
    /\bsharepoint\s+agents\b/gi,
    "",
  );
  if (/\bsharepoint\b|\bOneDriveAndSharePoint\b/i.test(summaryWithoutBillingService)) {
    return true;
  }

  for (const list of [feature.tags, feature.capabilities, feature.connectors]) {
    if (!Array.isArray(list)) continue;
    if (
      list.some((item) => {
        const token = String(item || "").trim();
        return SHAREPOINT_CAPABILITY_TOKEN_RE.test(token) || /\bsharepoint\b/i.test(token);
      })
    ) {
      return true;
    }
  }

  if (Array.isArray(feature.prerequisites)) {
    if (feature.prerequisites.some((entry) => /\bsharepoint\b/i.test(String(entry || "")))) {
      return true;
    }
  }

  if (Array.isArray(feature.steps)) {
    if (feature.steps.some((step) => SHAREPOINT_STEP_ACTION_RE.test(String(step || "")))) {
      return true;
    }
  }

  if (Array.isArray(feature.screenshots)) {
    if (
      feature.screenshots.some((shot) =>
        /^sharepoint-/i.test(String(shot?.section || "")),
      )
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Determine whether a planned or selected lab has a SharePoint site aspect.
 *
 * @param {{ products?: string[], features?: Array<string|object> }} [input]
 * @returns {boolean}
 */
export function labRequiresSharepointSite({ products = [], features = [] } = {}) {
  if (Array.isArray(products) && products.includes("sharepoint-ai")) {
    return true;
  }
  if (Array.isArray(features) && features.some((f) => featureRequiresSharepointSite(f))) {
    return true;
  }
  return false;
}

/**
 * Sanitize a SharePoint site display name.
 *
 * @param {unknown} rawName
 * @returns {string}
 */
export function normalizeSharepointSiteName(rawName) {
  if (typeof rawName !== "string") return "";
  return rawName
    .replace(CONTROL_CHARS_RE, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/**
 * Validate and normalize a SharePoint site URL.
 *
 * Accepts `https://` and `http://` URLs with a valid domain host, and
 * auto-normalizes bare domain inputs such as `contoso.sharepoint.com/sites/HR`
 * to `https://contoso.sharepoint.com/sites/HR`. Rejects `javascript:`, `data:`,
 * protocol-relative URLs, embedded credentials, spaces, and malformed syntax.
 *
 * @param {unknown} rawUrl
 * @returns {{ valid: boolean, url: string, error: string|null }}
 */
export function validateSharepointSiteUrl(rawUrl) {
  if (rawUrl === undefined || rawUrl === null) {
    return { valid: true, url: "", error: null };
  }
  if (typeof rawUrl !== "string") {
    return {
      valid: false,
      url: "",
      error:
        "Enter a valid http:// or https:// SharePoint site URL (for example, https://contoso.sharepoint.com/sites/OperationsHub).",
    };
  }

  const cleaned = rawUrl.replace(CONTROL_CHARS_RE, "").trim();
  if (!cleaned) {
    return { valid: true, url: "", error: null };
  }

  if (UNSAFE_SCHEME_RE.test(cleaned) || cleaned.startsWith("//") || /[<>"`\s]/.test(cleaned)) {
    return {
      valid: false,
      url: "",
      error:
        "Enter a valid http:// or https:// SharePoint site URL (for example, https://contoso.sharepoint.com/sites/OperationsHub).",
    };
  }

  let candidate = cleaned;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(candidate)) {
    if (BARE_HOSTNAME_URL_RE.test(candidate)) {
      candidate = `https://${candidate}`;
    } else {
      return {
        valid: false,
        url: "",
        error:
          "Enter a valid http:// or https:// SharePoint site URL (for example, https://contoso.sharepoint.com/sites/OperationsHub).",
      };
    }
  }

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return {
      valid: false,
      url: "",
      error:
        "Enter a valid http:// or https:// SharePoint site URL (for example, https://contoso.sharepoint.com/sites/OperationsHub).",
    };
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return {
      valid: false,
      url: "",
      error:
        "SharePoint site URL must start with https:// or http:// (for example, https://contoso.sharepoint.com/sites/OperationsHub).",
    };
  }

  if (parsed.username || parsed.password) {
    return {
      valid: false,
      url: "",
      error: "SharePoint site URL must not include embedded credentials.",
    };
  }

  const host = parsed.hostname || "";
  if (!host || !host.includes(".") || host.startsWith(".") || host.endsWith(".") || host.includes("..")) {
    return {
      valid: false,
      url: "",
      error:
        "Enter a complete SharePoint site domain and URL (for example, https://contoso.sharepoint.com/sites/OperationsHub).",
    };
  }

  const rawAfterOrigin = candidate.replace(/^https?:\/\/[^/?#]+/i, "");
  const hadExplicitRootSlash = rawAfterOrigin.startsWith("/");
  const normalized =
    parsed.pathname === "/" && !hadExplicitRootSlash && !parsed.search && !parsed.hash
      ? parsed.origin
      : `${parsed.origin}${parsed.pathname}${parsed.search}${parsed.hash}`;

  return { valid: true, url: normalized, error: null };
}

/**
 * Normalize a SharePoint site URL, optionally throwing on invalid values.
 *
 * @param {unknown} rawUrl
 * @param {{ strict?: boolean }} [options]
 * @returns {string}
 */
export function normalizeSharepointSiteUrl(rawUrl, { strict = false } = {}) {
  const checked = validateSharepointSiteUrl(rawUrl);
  if (!checked.valid) {
    if (strict) throw new Error(checked.error);
    return "";
  }
  return checked.url;
}

/**
 * Derive a clean, human-readable label from a validated SharePoint URL without
 * exposing raw `https://` scheme syntax in visible link text.
 *
 * @param {string} url
 * @returns {string}
 */
export function deriveSharepointSiteLabel(url) {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    const segments = parsed.pathname
      .split("/")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        try {
          return decodeURIComponent(s);
        } catch {
          return s;
        }
      });

    const siteMarkerIdx = segments.findIndex((s) => /^(?:sites|teams)$/i.test(s));
    if (siteMarkerIdx >= 0 && segments[siteMarkerIdx + 1]) {
      return `${segments[siteMarkerIdx + 1]} (${host})`;
    }
    if (segments.length > 0) {
      return `${segments[segments.length - 1]} (${host})`;
    }
    return `${host} SharePoint site`;
  } catch {
    return "SharePoint site";
  }
}

/**
 * Escape characters that could break Markdown `[label](href)` link or table syntax,
 * and strip any leading `http(s)://` scheme so visible link labels stay clean.
 *
 * @param {string} label
 * @returns {string}
 */
export function escapeMarkdownLinkLabel(label) {
  const cleaned = String(label || "")
    .replace(CONTROL_CHARS_RE, "")
    .replace(/^https?:\/\//i, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned
    .replace(/\\/g, "\\\\")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/\|/g, "\\|");
}

/**
 * Percent-encode characters that break Markdown `(href)` link delimiters.
 *
 * @param {string} url
 * @returns {string}
 */
export function safeMarkdownHref(url) {
  return String(url || "")
    .replace(CONTROL_CHARS_RE, "")
    .trim()
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/\[/g, "%5B")
    .replace(/\]/g, "%5D")
    .replace(/\s+/g, "%20");
}

/**
 * Resolve normalized SharePoint site configuration and ready-to-embed Markdown
 * formatting from a lab request or manifest.
 *
 * @param {{ sharepointSiteName?: unknown, sharepointSiteUrl?: unknown, name?: unknown, url?: unknown }} [input]
 * @param {{ strict?: boolean }} [options]
 * @returns {{
 *   name: string|null,
 *   url: string|null,
 *   label: string|null,
 *   hasName: boolean,
 *   hasUrl: boolean,
 *   configured: boolean,
 *   markdownLink: string
 * }}
 */
export function resolveSharepointSite(input = {}, { strict = false } = {}) {
  const rawName = input?.sharepointSiteName ?? input?.name ?? "";
  const rawUrl = input?.sharepointSiteUrl ?? input?.url ?? "";
  const name = normalizeSharepointSiteName(rawName);
  const url = normalizeSharepointSiteUrl(rawUrl, { strict });
  const label = name || (url ? deriveSharepointSiteLabel(url) : "");
  const hasName = Boolean(name);
  const hasUrl = Boolean(url);
  const configured = hasName || hasUrl;

  let markdownLink = "";
  if (hasUrl) {
    const safeLabel = escapeMarkdownLinkLabel(label || deriveSharepointSiteLabel(url) || "SharePoint site");
    markdownLink = `[${safeLabel}](${safeMarkdownHref(url)})`;
  } else if (hasName) {
    markdownLink = `**${escapeMarkdownLinkLabel(name)}**`;
  }

  return {
    name: name || null,
    url: url || null,
    label: label || null,
    hasName,
    hasUrl,
    configured,
    markdownLink,
  };
}
