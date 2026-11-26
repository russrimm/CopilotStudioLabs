/**
 * AI writing: configuration read from the environment.
 *
 * Everything is off unless AI_GENERATION says otherwise, and an unknown value is treated as off (fail closed). Secrets
 * (a provider key, the GitHub App secret) stay in this object and are never copied into anything a route returns; use
 * describeConfig() for that.
 */

/** Bump when a prompt or the response schema changes: it is part of every cache key and of the lab's own note. */
export const AI_PROMPT_VERSION = "1";

/** Enters the training and lab fingerprints (like TRAINING_COMBINED_VERSION) so an AI build never shares an entry with a plain one. */
export const AI_WRITING_VERSION = 1;

export const AI_MODES = Object.freeze(["off", "local-user", "per-user", "byok"]);
export const AI_SCOPES = Object.freeze(["lab", "training", "labday"]);
export const AI_SCOPE_LABELS = Object.freeze({
  lab: "The lab text",
  training: "The training decks",
  labday: "The lab-day decks",
});

const DEFAULTS = Object.freeze({
  maxParallel: 2,
  timeoutMs: 120000,
  maxOutputChars: 12000,
  maxBlocksPerRequest: 24,
  maxBlocksPerLab: 400,
  dailyBlocksPerVisitor: 800,
  dailyLabsPerVisitor: 6,
  dailyTokensPerVisitor: 600000,
  maxConcurrentLabs: 2,
  modelCacheMs: 5 * 60 * 1000,
  retries: 1,
  sessionTtlMs: 8 * 60 * 60 * 1000,
});

function intFrom(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function listFrom(value) {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;

/** True for a model id the portal will carry in a request, a manifest, or a prompt. */
export function isModelId(value) {
  return typeof value === "string" && MODEL_ID.test(value);
}

function parseByokModels(raw) {
  const models = [];
  for (const entry of listFrom(raw)) {
    const [id, ...rest] = entry.split("=");
    const cleanId = id.trim();
    if (!isModelId(cleanId)) continue;
    models.push({ id: cleanId, name: rest.join("=").trim() || cleanId });
  }
  return models;
}

/**
 * @param {Record<string, string | undefined>} [env]
 */
export function readAiConfig(env = process.env) {
  const requested = String(env.AI_GENERATION ?? "off").trim().toLowerCase() || "off";
  const problems = [];
  let mode = requested;
  if (!AI_MODES.includes(requested)) {
    problems.push(`AI_GENERATION="${requested.slice(0, 20)}" is not one of ${AI_MODES.join(", ")}, so AI writing is off.`);
    mode = "off";
  }

  const byokModels = parseByokModels(env.AI_BYOK_MODELS);
  const allowedModels = listFrom(env.AI_ALLOWED_MODELS).filter(isModelId);
  const byok = {
    type: ["openai", "azure", "anthropic"].includes(String(env.AI_BYOK_TYPE || "").toLowerCase()) ? String(env.AI_BYOK_TYPE).toLowerCase() : "openai",
    baseUrl: String(env.AI_BYOK_BASE_URL || "").trim(),
    apiKey: String(env.AI_BYOK_API_KEY || "").trim(),
    wireApi: String(env.AI_BYOK_WIRE_API || "").toLowerCase() === "responses" ? "responses" : "completions",
    azureApiVersion: String(env.AI_BYOK_AZURE_API_VERSION || "").trim() || null,
    models: byokModels,
  };
  if (mode === "byok") {
    if (!byok.baseUrl || !/^https:\/\/[^\s]+$/i.test(byok.baseUrl)) problems.push("AI_BYOK_BASE_URL must be an https address.");
    if (!byok.apiKey) problems.push("AI_BYOK_API_KEY is not set.");
    if (!byok.models.length) problems.push("AI_BYOK_MODELS must list at least one model (id or id=Display name).");
  }

  const github = {
    clientId: String(env.AI_GITHUB_CLIENT_ID || "").trim(),
    clientSecret: String(env.AI_GITHUB_CLIENT_SECRET || "").trim(),
    publicUrl: String(env.AI_PUBLIC_URL || "").trim().replace(/\/+$/, ""),
  };
  if (mode === "per-user") {
    if (!github.clientId || !github.clientSecret) problems.push("AI_GITHUB_CLIENT_ID and AI_GITHUB_CLIENT_SECRET (a GitHub App) are required for per-user sign-in.");
    if (!/^https?:\/\/[^\s]+$/i.test(github.publicUrl)) problems.push("AI_PUBLIC_URL (the address people use to reach this portal) is required for per-user sign-in.");
  }

  return {
    mode,
    requested,
    problems,
    allowedModels,
    byok,
    github,
    copilotHome: String(env.AI_COPILOT_HOME || "").trim() || null,
    maxParallel: intFrom(env.AI_MAX_PARALLEL, DEFAULTS.maxParallel, { max: 4 }),
    timeoutMs: intFrom(env.AI_TIMEOUT_MS, DEFAULTS.timeoutMs, { min: 5000, max: 600000 }),
    maxOutputChars: intFrom(env.AI_MAX_OUTPUT_CHARS, DEFAULTS.maxOutputChars, { min: 500, max: 100000 }),
    maxBlocksPerRequest: intFrom(env.AI_MAX_BLOCKS_PER_REQUEST, DEFAULTS.maxBlocksPerRequest, { max: 60 }),
    maxBlocksPerLab: intFrom(env.AI_MAX_BLOCKS_PER_LAB, DEFAULTS.maxBlocksPerLab, { max: 5000 }),
    dailyBlocksPerVisitor: intFrom(env.AI_DAILY_BLOCKS_PER_VISITOR, DEFAULTS.dailyBlocksPerVisitor),
    dailyLabsPerVisitor: intFrom(env.AI_DAILY_LABS_PER_VISITOR, DEFAULTS.dailyLabsPerVisitor),
    dailyTokensPerVisitor: intFrom(env.AI_DAILY_TOKENS_PER_VISITOR, DEFAULTS.dailyTokensPerVisitor),
    maxConcurrentLabs: intFrom(env.AI_MAX_CONCURRENT_LABS, DEFAULTS.maxConcurrentLabs, { max: 8 }),
    modelCacheMs: intFrom(env.AI_MODEL_CACHE_MS, DEFAULTS.modelCacheMs, { min: 1000 }),
    retries: intFrom(env.AI_RETRIES, DEFAULTS.retries, { min: 0, max: 2 }),
    sessionTtlMs: intFrom(env.AI_SESSION_TTL_MS, DEFAULTS.sessionTtlMs, { min: 60000 }),
  };
}

/** The part of the configuration that is safe to show: no key, no secret, no client id. */
export function describeConfig(config) {
  return {
    mode: config.mode,
    problems: config.problems,
    maxParallel: config.maxParallel,
    maxBlocksPerLab: config.maxBlocksPerLab,
    dailyLabsPerVisitor: config.dailyLabsPerVisitor,
    dailyBlocksPerVisitor: config.dailyBlocksPerVisitor,
  };
}

/** What AI may write, from a request value. Unknown scopes are dropped; the order is fixed. */
export function normalizeScope(value) {
  const list = Array.isArray(value) ? value : value === undefined || value === null ? [...AI_SCOPES] : [value];
  const wanted = new Set(list.map((item) => String(item).trim().toLowerCase()));
  return AI_SCOPES.filter((scope) => wanted.has(scope));
}
