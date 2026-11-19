// Where the capture happens: the small set of tenant addresses and names a capture needs, and how to find
// a product screen from them. Shared by the portal (settings, validation, plans) and the companion (navigation
// and landing checks). Pure functions only: no files, no network, no browser.
//
// Minimal context per product:
//   Copilot Studio          an environment (optional: the sign-in redirect lands in the default one) and an agent
//                           (its address, or its name) for every agent screen: Overview, Knowledge, Tools, Settings...
//   Agent Builder           the agent's name
//   SharePoint              the site address
//   Power Platform          the environment address
//   Microsoft Foundry       the project address
//   admin centers           the admin center address (optional: a public address is used)

import { cleanExpectedLabels } from "./labels.mjs";

// ── Settings ───────────────────────────────────────────────────────────────

/**
 * Every capture setting. `env` is the CAPTURE_* variable an address is carried in (https only); a name has none
 * and travels as a job setting. `profile` fields live on the brand profile with the same id.
 */
export const TARGET_FIELDS = Object.freeze([
  { id: "copilotStudioUrl", label: "Copilot Studio environment address", kind: "url", product: "copilot-studio", env: "CAPTURE_COPILOT_STUDIO_START_URL", placeholder: "https://copilotstudio.microsoft.com/environments/<environment id>/home", help: "Optional. Copy it from the address bar when Copilot Studio shows your environment's home page.", family: "copilot-studio" },
  { id: "copilotStudioAgentUrl", label: "Copilot Studio agent address", kind: "url", product: "copilot-studio", env: "CAPTURE_COPILOT_STUDIO_AGENT_URL", placeholder: "https://copilotstudio.microsoft.com/environments/<environment id>/bots/<agent id>/overview", help: "Open your agent in Copilot Studio and copy the address from the address bar. This is how every agent screen (Overview, Knowledge, Tools, Settings) is reached.", family: "copilot-studio", agent: true },
  { id: "copilotStudioAgentName", label: "Copilot Studio agent name", kind: "text", product: "copilot-studio", env: null, placeholder: "My agent", help: "Use this instead of the address: the exact name of your agent. It is opened from the Agents list." },
  { id: "agentBuilderAgentName", label: "Agent Builder agent name", kind: "text", product: "m365-copilot-agent-builder", env: null, placeholder: "My agent", help: "The exact name of the agent you build in Microsoft 365 Copilot." },
  { id: "sharepointSiteUrl", label: "SharePoint site address", kind: "url", product: "sharepoint-ai", env: "CAPTURE_SHAREPOINT_SITE_URL", placeholder: "https://contoso.sharepoint.com/sites/training", help: "The site the lab uses. Shots of site pages open it." },
  { id: "sharepointAdminUrl", label: "SharePoint admin center address", kind: "url", product: "sharepoint-ai", env: "CAPTURE_SHAREPOINT_ADMIN_URL", placeholder: "https://contoso-admin.sharepoint.com", help: "Optional. Your tenant's admin center, if the public address does not work for you." },
  { id: "m365AdminUrl", label: "Microsoft 365 admin center address", kind: "url", product: "m365-copilot-hub", env: "CAPTURE_M365_ADMIN_URL", placeholder: "https://admin.cloud.microsoft", help: "Optional." },
  { id: "powerPlatformEnvUrl", label: "Power Platform environment address", kind: "url", product: "power-platform-ai-hub", env: "CAPTURE_POWER_PLATFORM_START_URL", placeholder: "https://make.powerapps.com/environments/<environment id>/home", help: "The environment that holds your AI hub, flows, and apps." },
  { id: "foundryProjectUrl", label: "Foundry project address", kind: "url", product: "ai-foundry", env: "CAPTURE_FOUNDRY_PROJECT_URL", placeholder: "https://ai.azure.com/…", help: "Open your project in the Foundry portal and copy the address from the address bar." },
]);

const FIELD_BY_ID = new Map(TARGET_FIELDS.map((f) => [f.id, f]));
export const TARGET_FIELD_IDS = Object.freeze(TARGET_FIELDS.map((f) => f.id));
export const TARGET_TEXT_MAX = 80;
const MAX_URL = 2048;

export function targetField(id) {
  return FIELD_BY_ID.get(id) || null;
}

/** The environment variable a field's address travels in, or null for a name. */
export function envNameForField(id) {
  return targetField(id)?.env || null;
}

const COPILOT_STUDIO_HOST_RE = /(?:^|\.)copilotstudio\./i;

/**
 * Check one setting. An empty value is valid and means "not set". Addresses must be https without a user name or
 * password; Copilot Studio addresses must be Copilot Studio; an agent address must point at an agent.
 * @returns {{ok: boolean, value: string, error?: string}}
 */
export function validateTargetValue(id, raw) {
  const field = targetField(id);
  if (!field) return { ok: false, value: "", error: "That is not a capture setting." };
  const text = String(raw ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (!text) return { ok: true, value: "" };
  if (field.kind === "text") {
    if (/[<>]/.test(text)) return { ok: false, value: "", error: `${field.label} cannot contain < or >.` };
    if (text.length > TARGET_TEXT_MAX) return { ok: false, value: "", error: `${field.label} can be at most ${TARGET_TEXT_MAX} characters.` };
    return { ok: true, value: text.replace(/\s+/g, " ") };
  }
  if (text.length > MAX_URL) return { ok: false, value: "", error: `${field.label} is too long.` };
  let url;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, value: "", error: `${field.label} must be a web address that starts with https://.` };
  }
  if (url.protocol !== "https:") return { ok: false, value: "", error: `${field.label} must start with https://. Other addresses are not used.` };
  if (url.username || url.password) return { ok: false, value: "", error: `Remove the user name and password from the ${field.label.toLowerCase()}.` };
  if (!url.hostname || !url.hostname.includes(".")) return { ok: false, value: "", error: `${field.label} must be a full web address.` };
  if (field.family === "copilot-studio") {
    if (!COPILOT_STUDIO_HOST_RE.test(url.hostname)) return { ok: false, value: "", error: `${field.label} must be a Copilot Studio address (copilotstudio.microsoft.com).` };
    if (field.agent && !parseCopilotStudioAddress(text).botId) {
      return { ok: false, value: "", error: "That address does not point at an agent. Open your agent in Copilot Studio and copy the address from the address bar." };
    }
  }
  return { ok: true, value: url.href.replace(/#.*$/, "") };
}

/**
 * Check a set of settings. Unknown fields are ignored; an invalid one is reported by field and left out.
 * @returns {{ok: boolean, values: Record<string, string>, errors: Record<string, string>}}
 */
export function validateTargets(input) {
  const values = {};
  const errors = {};
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  for (const field of TARGET_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(source, field.id)) continue;
    const checked = validateTargetValue(field.id, source[field.id]);
    if (checked.ok) values[field.id] = checked.value;
    else errors[field.id] = checked.error;
  }
  return { ok: Object.keys(errors).length === 0, values, errors };
}

/** The CAPTURE_* variables for the addresses among `values` (https only; blanks left out). */
export function targetEnvFromValues(values) {
  const env = {};
  for (const field of TARGET_FIELDS) {
    const value = values?.[field.id];
    if (field.env && typeof value === "string" && value && validateTargetValue(field.id, value).ok) env[field.env] = value;
  }
  return env;
}

/** The names (not addresses) among `values`: the settings that travel with a job and never as an environment variable. */
export function targetTextFromValues(values) {
  const out = {};
  for (const field of TARGET_FIELDS) {
    const value = values?.[field.id];
    if (field.kind === "text" && typeof value === "string" && value && validateTargetValue(field.id, value).ok) out[field.id] = value;
  }
  return out;
}

/** Settings as a job carries them: addresses in `env`, names in `text`. */
export function targetValuesFromJob(env, text) {
  const values = {};
  for (const field of TARGET_FIELDS) {
    if (field.env && typeof env?.[field.env] === "string" && env[field.env]) values[field.id] = env[field.env];
    if (field.kind === "text" && typeof text?.[field.id] === "string" && text[field.id]) values[field.id] = text[field.id];
  }
  return values;
}

// ── What a screen needs ────────────────────────────────────────────────────

/**
 * What a shot cannot be captured without. `fields` is "any one of these"; `cause` is the failure group the
 * shots land in when it is missing.
 */
export const REQUIREMENTS = Object.freeze({
  "copilot-studio-agent": { id: "copilot-studio-agent", product: "copilot-studio", label: "your Copilot Studio agent", noun: "agent address", fields: ["copilotStudioAgentUrl", "copilotStudioAgentName"], cause: "no-agent", prompt: "Paste your agent's address (open the agent in Copilot Studio and copy it from the address bar), or type the agent's name." },
  "agent-builder-agent": { id: "agent-builder-agent", product: "m365-copilot-agent-builder", label: "your Agent Builder agent", noun: "agent name", fields: ["agentBuilderAgentName"], cause: "no-agent", prompt: "Type the name of the agent you build in Microsoft 365 Copilot." },
  "sharepoint-site": { id: "sharepoint-site", product: "sharepoint-ai", label: "your SharePoint site", noun: "SharePoint site address", fields: ["sharepointSiteUrl"], cause: "no-site", prompt: "Paste the address of your SharePoint site (for example https://contoso.sharepoint.com/sites/training)." },
  "foundry-project": { id: "foundry-project", product: "ai-foundry", label: "your Foundry project", noun: "Foundry project address", fields: ["foundryProjectUrl"], cause: "no-address", prompt: "Open your project in the Foundry portal and paste its address." },
  "power-platform-environment": { id: "power-platform-environment", product: "power-platform-ai-hub", label: "your Power Platform environment", noun: "Power Platform environment address", fields: ["powerPlatformEnvUrl"], cause: "no-address", prompt: "Paste the address of your Power Platform environment." },
  "sharepoint-admin": { id: "sharepoint-admin", product: "sharepoint-ai", label: "your SharePoint admin center", noun: "SharePoint admin center address", fields: ["sharepointAdminUrl"], cause: "no-address", prompt: "Paste the address of your SharePoint admin center." },
  "m365-admin": { id: "m365-admin", product: "m365-copilot-hub", label: "your Microsoft 365 admin center", noun: "admin center address", fields: ["m365AdminUrl"], cause: "no-address", prompt: "Paste the address of your Microsoft 365 admin center." },
});

/** The requirement a tenant-address variable stands for (a section that can only be reached through a tenant address). */
export const REQUIREMENT_FOR_ENV = Object.freeze({
  CAPTURE_SHAREPOINT_SITE_URL: "sharepoint-site",
  CAPTURE_FOUNDRY_PROJECT_URL: "foundry-project",
  CAPTURE_POWER_PLATFORM_START_URL: "power-platform-environment",
  CAPTURE_SHAREPOINT_ADMIN_URL: "sharepoint-admin",
  CAPTURE_M365_ADMIN_URL: "m365-admin",
});

export function requirementMet(id, values) {
  const requirement = REQUIREMENTS[id];
  if (!requirement) return true;
  if (requirement.fields.some((fieldId) => Boolean(values?.[fieldId]))) return true;
  // The Copilot Studio start address used to be the only place to put an address: one that points at an agent still counts.
  return id === "copilot-studio-agent" && Boolean(values?.copilotStudioUrl && parseCopilotStudioAddress(values.copilotStudioUrl).botId);
}

export function missingRequirements(ids, values) {
  return [...new Set(ids || [])].filter((id) => REQUIREMENTS[id] && !requirementMet(id, values));
}

// ── Copilot Studio addresses ───────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Copilot Studio screens. An agent screen lives under `/environments/<env>/bots/<agent>/<path>`, an environment
 * screen under `/environments/<env>/<path>`. `paths` are the address segments the screen has been seen under.
 */
export const COPILOT_STUDIO_SCREENS = Object.freeze({
  home: { id: "home", scope: "environment", paths: ["home"], label: "the Copilot Studio home page", short: "Home" },
  agents: { id: "agents", scope: "environment", paths: ["agents"], label: "the list of agents", short: "Agents" },
  overview: { id: "overview", scope: "agent", paths: ["overview"], label: "the agent's Overview page", short: "Overview", navLabels: ["Overview"] },
  knowledge: { id: "knowledge", scope: "agent", paths: ["knowledge"], label: "the agent's Knowledge page", short: "Knowledge", navLabels: ["Knowledge"] },
  tools: { id: "tools", scope: "agent", paths: ["actions", "tools"], label: "the agent's Tools page", short: "Tools", navLabels: ["Tools", "Actions"] },
  topics: { id: "topics", scope: "agent", paths: ["topics"], label: "the agent's Topics page", short: "Topics", navLabels: ["Topics"] },
  analytics: { id: "analytics", scope: "agent", paths: ["analytics"], label: "the agent's Analytics page", short: "Analytics", navLabels: ["Analytics"] },
  channels: { id: "channels", scope: "agent", paths: ["channels"], label: "the agent's Channels page", short: "Channels", navLabels: ["Channels"] },
  evaluations: { id: "evaluations", scope: "agent", paths: ["evaluations", "evaluation", "evaluate"], label: "the agent's Evaluation page", short: "Evaluation", navLabels: ["Evaluation", "Evaluations"] },
  settings: { id: "settings", scope: "agent", paths: ["settings"], label: "the agent's Settings page", short: "Settings", navLabels: ["Settings"] },
});

/**
 * Take apart a Copilot Studio address. `agentBase` and `envBase` keep the origin and the path prefix only
 * (no query, no fragment), so they are safe to keep and to log after the ids are masked.
 */
export function parseCopilotStudioAddress(raw) {
  let url;
  try {
    url = new URL(String(raw ?? ""));
  } catch {
    return { ok: false };
  }
  if (url.protocol !== "https:" || !COPILOT_STUDIO_HOST_RE.test(url.hostname)) return { ok: false };
  const segs = url.pathname.split("/").filter(Boolean);
  const out = { ok: true, origin: url.origin, host: url.hostname, envId: null, botId: null, area: null, section: null, envBase: null, agentBase: null };
  if (segs[0] !== "environments" || !segs[1]) return out;
  out.envId = segs[1];
  out.envBase = `${url.origin}/environments/${segs[1]}`;
  const rest = segs.slice(2);
  if ((rest[0] === "bots" || (rest[0] === "agents" && UUID_RE.test(rest[1] || ""))) && rest[1]) {
    out.botId = rest[1];
    out.agentBase = `${out.envBase}/${rest[0]}/${rest[1]}`;
    out.area = "bots";
    out.section = rest[2] || null;
  } else {
    out.area = rest[0] || null;
    out.section = rest[1] || null;
  }
  return out;
}

/** The address of a Copilot Studio screen, from what is known so far. Null when the context is not enough. */
export function copilotStudioScreenUrl(screenId, { envBase = null, agentBase = null } = {}) {
  const screen = COPILOT_STUDIO_SCREENS[screenId];
  if (!screen) return null;
  if (screen.scope === "agent") return agentBase ? `${agentBase}/${screen.paths[0]}` : null;
  return envBase ? `${envBase}/${screen.paths[0]}` : null;
}

// ── Where the browser actually is ──────────────────────────────────────────

const SECTION_NAMES = { actions: "Tools", tools: "Tools", evaluation: "Evaluation", evaluations: "Evaluation", evaluate: "Evaluation" };

/** Mask ids in an address path so it is safe to show and to keep. */
export function maskedPath(rawUrl) {
  try {
    const url = new URL(String(rawUrl ?? ""));
    const path = url.pathname.split("/").map((s) => (UUID_RE.test(s) || /^[0-9a-f]{24,}$/i.test(s) ? "{id}" : s)).join("/");
    return `${url.host}${path}`;
  } catch {
    return "";
  }
}

const MASK_GUID = "00000000-0000-0000-0000-000000000000";

/**
 * An address with every id replaced by a zero id and no query or fragment: still a valid address of the same shape, so a page
 * can be judged by it, but it names no environment and no agent. Used for what is sent to the portal about a practice agent.
 */
export function maskedAddress(rawUrl) {
  try {
    const url = new URL(String(rawUrl ?? ""));
    const path = url.pathname.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, MASK_GUID);
    return `${url.protocol}//${url.host}${path}`;
  } catch {
    return "";
  }
}

/** A plain-language name for the page an address is, for sentences like "This is the Copilot Studio home page". */
export function describePage(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl ?? ""));
  } catch {
    return "a page that is not a web page";
  }
  if (/(?:^|\.)(?:login\.microsoftonline|login\.live|login\.microsoft)\./i.test(url.hostname) || /^login\./i.test(url.hostname)) return "a Microsoft sign-in page";
  const parsed = parseCopilotStudioAddress(rawUrl);
  if (parsed.ok) {
    if (parsed.botId) {
      const section = parsed.section ? SECTION_NAMES[parsed.section] || `${parsed.section[0].toUpperCase()}${parsed.section.slice(1)}` : "Overview";
      return `the agent's ${section} page`;
    }
    if (parsed.area === "home") return "the Copilot Studio home page";
    if (parsed.area === "agents") return "the list of agents";
    if (parsed.area === "apps") return "a page for creating an app";
    if (parsed.envId) return `a different Copilot Studio page (${maskedPath(rawUrl).split("/").slice(3).join("/") || "home"})`;
    return "the Copilot Studio start page";
  }
  return `a page on ${url.hostname}`;
}

function hostFamily(host) {
  const parts = String(host || "").toLowerCase().split(".").filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join(".") : parts.join(".");
}

/**
 * Whether the page the browser ended on is the screen the plan expects.
 * `expect` is `{family: "copilot-studio", scope, paths, label}` or `{family: "url", host, label}`.
 * @returns {{state: "match"|"mismatch"|"unknown", page: string, expected: string}}
 */
export function assessLanding(finalUrl, expect) {
  const expected = expect?.label || "the screen the lab describes";
  if (!expect || !expect.family || !finalUrl) return { state: "unknown", page: finalUrl ? describePage(finalUrl) : "", expected };
  const page = describePage(finalUrl);
  if (expect.family === "copilot-studio") {
    const parsed = parseCopilotStudioAddress(finalUrl);
    if (!parsed.ok || !parsed.envId) return { state: "mismatch", page, expected };
    // A person who sets a screen up themselves may be on any page of the product.
    if (expect.strict === false) return { state: "match", page, expected };
    const paths = Array.isArray(expect.paths) ? expect.paths : [];
    if (expect.scope === "agent") {
      if (!parsed.botId) return { state: "mismatch", page, expected };
      return { state: paths.includes(parsed.section || "overview") ? "match" : "mismatch", page, expected };
    }
    return { state: !parsed.botId && paths.includes(parsed.area) ? "match" : "mismatch", page, expected };
  }
  if (expect.family === "url" && expect.host) {
    try {
      const url = new URL(finalUrl);
      return { state: hostFamily(url.hostname) === hostFamily(expect.host) ? "match" : "mismatch", page, expected };
    } catch {
      return { state: "unknown", page, expected };
    }
  }
  return { state: "unknown", page, expected };
}

/** Plain-language steps for a screen, like ["Copilot Studio", "your agent", "Settings"]. */
export function describePath(screenId) {
  const screen = COPILOT_STUDIO_SCREENS[screenId];
  if (!screen) return ["Copilot Studio"];
  return screen.scope === "agent" ? ["Copilot Studio", "your agent", screen.short] : ["Copilot Studio", screen.short];
}

/** Labels for a shot: cleaned and bounded. */
export function landmarkLabels(list, max = 8) {
  return cleanExpectedLabels(list, { max });
}

/**
 * How one shot is run in a job of this mode: "auto", "guided", "needs-you" (automatic mode meets a screen that
 * needs a person), "manual", or "legacy" (a plan from a portal that does not classify its shots).
 */
export function effectiveModeFor(shot, jobMode = "smart") {
  if (shot.manual || shot.capture?.mode === "manual") return "manual";
  if (!shot.capture?.version) return "legacy";
  // Autonomous: the computer sets every browser screen up itself. A person is asked only after automation failed.
  if (jobMode === "autonomous") return "autonomous";
  if (jobMode === "guided") return "guided";
  if (shot.capture.mode === "guided") return jobMode === "auto" ? "needs-you" : "guided";
  return "auto";
}
