// Recipes: a person's recorded way of setting up a screen, kept on their computer, and (only when they choose) shared
// with the portal as an anonymous recipe attached to a shot slot, so every lab and every user benefits.
//
// A recipe is the same steps the portal builds (see setup-steps.mjs), keyed by product, screen, and shot slot. It
// never holds a coordinate, a selector, an address, an account, or a typed value: only the roles and names of the
// controls a person clicked and which kind of sample text went where. Anything that could identify a tenant or a
// person is refused before it is stored locally and again before it is shared, and the portal checks it a third
// time with the same code.

import fs from "node:fs";
import path from "node:path";

import { TIER } from "./guard.mjs";
import { MAX_SETUP_STEPS, SAMPLE_KINDS, sanitizeSteps } from "./setup-steps.mjs";

export const RECIPE_VERSION = 1;
export const RECIPES_DIR = ".recipes";
export const MAX_SHARED_BYTES = 12 * 1024;
const SLOT_RE = /^[a-z0-9][a-z0-9._-]{0,80}$/i;
const PRODUCT_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;
const SCREEN_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

const GUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const URL_RE = /(?:https?|ftp|file):\/\/|\bwww\.|[a-z0-9-]+\.(?:com|net|org|io|microsoft|office|azure)\b/i;
const TENANT_RE = /\.onmicrosoft\.com|-my\.sharepoint|-admin\.sharepoint|\.sharepoint\.com|\/sites\/|\/tenants?\//i;
const LONG_NUMBER_RE = /\d{5,}/;

/** The key a recipe is stored and shared under. */
export function recipeKey({ product, screen, slot }) {
  return `${product}/${screen || "-"}/${slot}`;
}

/** The key a shot's recipes are stored and shared under: its product, the screen it shows, and its slot (the file name without its extension). */
export function recipeKeyForShot(shot) {
  const capture = shot.capture || {};
  const product = capture.product || shot.product || "copilot-studio";
  const slot = String(shot.filename || "").replace(/\.[a-z0-9]+$/i, "").toLowerCase();
  const screen = String(capture.screen?.id || capture.section || shot.section || "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return { product, screen, slot };
}

export function parseRecipeKey(key) {
  const [product, screen, slot, ...rest] = String(key || "").split("/");
  if (rest.length || !PRODUCT_RE.test(product || "") || !SCREEN_RE.test(screen === "-" ? "x" : screen || "") || !SLOT_RE.test(slot || "")) return null;
  return { product, screen: screen === "-" ? "" : screen, slot };
}

const walkStrings = (value, visit, depth = 0) => {
  if (depth > 6) return;
  if (typeof value === "string") visit(value);
  else if (Array.isArray(value)) value.forEach((v) => walkStrings(v, visit, depth + 1));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => walkStrings(v, visit, depth + 1));
};

/**
 * Why a recipe may not be shared, or an empty list. This is the one check the companion, the portal's route, and the
 * tests all use.
 */
export function shareProblems(raw, { knownProducts = null } = {}) {
  const problems = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return ["The recipe is not an object."];
  if (JSON.stringify(raw).length > MAX_SHARED_BYTES) problems.push("The recipe is too large.");
  const key = raw.key || {};
  if (!PRODUCT_RE.test(String(key.product || ""))) problems.push("The product is not valid.");
  else if (knownProducts && !knownProducts.includes(key.product)) problems.push("The product is not one this portal knows.");
  if (key.screen && !SCREEN_RE.test(String(key.screen))) problems.push("The screen is not valid.");
  if (!SLOT_RE.test(String(key.slot || ""))) problems.push("The shot slot is not valid.");
  if (typeof raw.title === "string" && raw.title.length > 100) problems.push("The title is too long.");
  walkStrings(raw, (text) => {
    if (GUID_RE.test(text)) problems.push("It contains an identifier (a tenant, environment, or agent id).");
    else if (EMAIL_RE.test(text)) problems.push("It contains an email address.");
    else if (URL_RE.test(text) || /[?&][a-z]+=/i.test(text)) problems.push("It contains a web address.");
    else if (TENANT_RE.test(text)) problems.push("It contains a tenant address.");
    else if (LONG_NUMBER_RE.test(text)) problems.push("It contains a long number.");
  });
  const steps = Array.isArray(raw.steps) ? raw.steps : [];
  if (!steps.length) problems.push("The recipe has no steps.");
  if (steps.length > MAX_SETUP_STEPS) problems.push(`The recipe has more than ${MAX_SETUP_STEPS} steps.`);
  for (const step of steps) {
    if (step?.text?.literal !== undefined) problems.push("A shared recipe cannot hold typed text; it holds a kind of sample instead.");
    if (step?.text?.sample && !SAMPLE_KINDS.includes(step.text.sample)) problems.push("A sample kind is not valid.");
    for (const name of [step?.target?.name, ...(step?.target?.alt || [])]) {
      if (typeof name === "string" && (name.length > 60 || /\d{4,}/.test(name))) problems.push("A control name is too long or looks like data, not a label.");
    }
  }
  return [...new Set(problems)].slice(0, 6);
}

/**
 * A recipe the way it is stored: the key, the checked steps, and nothing else. Returns null when it has no valid step
 * or a step needs more than a practice agent.
 */
export function sanitizeRecipe(raw, { product = "" } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const key = { product: String(raw.key?.product || product), screen: String(raw.key?.screen || ""), slot: String(raw.key?.slot || "") };
  if (!PRODUCT_RE.test(key.product) || !SLOT_RE.test(key.slot) || (key.screen && !SCREEN_RE.test(key.screen))) return null;
  const steps = sanitizeSteps(raw.steps, { product: key.product });
  if (!steps.length) return null;
  return {
    version: RECIPE_VERSION,
    key,
    title: String(raw.title || "").replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, 100),
    steps,
    maxTier: steps.reduce((max, s) => Math.max(max, s.tier), 0),
    ...(raw.final && typeof raw.final === "object" ? { final: raw.final } : {}),
  };
}

/** The anonymous form of a recipe that may be sent to the portal: the key, the title, and the steps. */
export function toSharePayload(recipe) {
  const clean = sanitizeRecipe(recipe);
  if (!clean) return null;
  const steps = clean.steps.map(({ note, tier, ...step }) => step);
  return { version: RECIPE_VERSION, key: clean.key, title: clean.title, steps };
}

/**
 * Validate a recipe offered for sharing: the shared checks, then the usual shape checks.
 * @returns {{ok: boolean, recipe?: object, errors: string[]}}
 */
export function validateSharedRecipe(raw, options = {}) {
  const errors = shareProblems(raw, options);
  if (errors.length) return { ok: false, errors };
  const recipe = sanitizeRecipe(raw);
  if (!recipe) return { ok: false, errors: ["The recipe has no valid steps."] };
  if (recipe.maxTier >= TIER.NEVER) return { ok: false, errors: ["A step is something the computer never does."] };
  const payload = toSharePayload(recipe);
  return { ok: true, recipe: payload, errors: [] };
}

// ── Local store ─────────────────────────────────────────────────────────────

/**
 * The person's own recipes, under the companion folder. A recipe that fails when it is replayed is marked stale, so
 * the next run does not trust it until it is recorded again.
 */
export function createRecipeStore(home, { now = () => Date.now() } = {}) {
  const dir = path.join(home, RECIPES_DIR);
  const file = path.join(dir, "recipes.json");
  const load = () => {
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      return data && typeof data.recipes === "object" ? data : { schema: 1, recipes: {} };
    } catch {
      return { schema: 1, recipes: {} };
    }
  };
  const save = (data) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  };
  const iso = () => new Date(now()).toISOString();
  return {
    file,
    get(key) {
      const entry = load().recipes[recipeKey(key)];
      return entry && !entry.stale ? entry : null;
    },
    getAny(key) {
      return load().recipes[recipeKey(key)] || null;
    },
    put(recipe, { shared = false } = {}) {
      const clean = sanitizeRecipe(recipe);
      if (!clean) return null;
      const data = load();
      data.recipes[recipeKey(clean.key)] = { ...clean, recordedAt: iso(), stale: false, replays: 0, failures: 0, shared };
      save(data);
      return data.recipes[recipeKey(clean.key)];
    },
    markShared(key) {
      const data = load();
      const entry = data.recipes[recipeKey(key)];
      if (entry) {
        entry.shared = true;
        save(data);
      }
    },
    /** A replay worked or did not. A failure makes the recipe stale until it is recorded again. */
    markReplay(key, ok, why = "") {
      const data = load();
      const entry = data.recipes[recipeKey(key)];
      if (!entry) return;
      entry.replays = (entry.replays || 0) + 1;
      entry.lastReplayAt = iso();
      if (ok) entry.stale = false;
      else {
        entry.stale = true;
        entry.failures = (entry.failures || 0) + 1;
        entry.staleBecause = String(why).slice(0, 120);
      }
      save(data);
    },
    remove(key) {
      const data = load();
      delete data.recipes[recipeKey(key)];
      save(data);
    },
    list() {
      return Object.values(load().recipes);
    },
  };
}
