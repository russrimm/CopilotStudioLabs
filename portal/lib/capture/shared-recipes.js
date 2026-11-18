/**
 * Recipes people chose to share: anonymous setup steps attached to a shot slot, so every lab and every user
 * benefits from one person showing the computer a screen once. Only the controls' roles and names are kept; the
 * validator (shared with the companion) rejects anything that could identify a tenant or a person, and it runs here
 * again, so the portal never trusts what the companion checked.
 *
 * Stored in `<data dir>/capture/recipes.json`, so it follows the Azure Blob mirror. One recipe per slot (the newest
 * wins), bounded in count and size.
 */

import path from "node:path";

import { productIds, readCaptureConfig } from "../../../tools/feature-tour/lib/products.mjs";
import { recipeKey, validateSharedRecipe } from "../../../tools/screenshot-capture/recipes.mjs";
import { cleanText, readJson, writeJsonAtomic } from "./store-util.js";

export const MAX_SHARED_RECIPES = 500;

function knownProducts() {
  try {
    const ids = productIds(readCaptureConfig());
    return Array.isArray(ids) && ids.length ? ids : null;
  } catch {
    return null;
  }
}

export function createSharedRecipeStore({ dir, now = () => Date.now(), products = knownProducts } = {}) {
  const file = path.join(dir, "recipes.json");
  const load = () => {
    const data = readJson(file, null);
    return data && typeof data.recipes === "object" && !Array.isArray(data.recipes) ? data : { schema: 1, recipes: {} };
  };
  return {
    file,
    /** The shared recipe for a slot, or null. */
    get(key) {
      const entry = load().recipes[recipeKey(key)];
      return entry ? entry.recipe : null;
    },
    /**
     * Validate and keep a recipe. Returns `{ok, errors, recipe}`; nothing is stored when it is not valid.
     * @param {object} raw
     */
    put(raw) {
      const checked = validateSharedRecipe(raw, { knownProducts: typeof products === "function" ? products() : products });
      if (!checked.ok) return { ok: false, errors: checked.errors };
      const data = load();
      const key = recipeKey(checked.recipe.key);
      const replacing = Boolean(data.recipes[key]);
      if (!replacing && Object.keys(data.recipes).length >= MAX_SHARED_RECIPES) return { ok: false, errors: ["The portal already holds the most shared recipes it keeps."] };
      data.recipes[key] = { recipe: checked.recipe, sharedAt: new Date(now()).toISOString(), count: (data.recipes[key]?.count || 0) + 1 };
      writeJsonAtomic(file, data);
      return { ok: true, recipe: checked.recipe, replaced: replacing };
    },
    remove(key) {
      const data = load();
      const existed = Boolean(data.recipes[recipeKey(key)]);
      delete data.recipes[recipeKey(key)];
      writeJsonAtomic(file, data);
      return existed;
    },
    /** What the portal lists: the key, the title, how many steps, and when it was shared. No step names. */
    list() {
      return Object.entries(load().recipes).map(([key, entry]) => ({ key, title: cleanText(entry.recipe?.title, 100), steps: Array.isArray(entry.recipe?.steps) ? entry.recipe.steps.length : 0, sharedAt: entry.sharedAt || null }));
    },
  };
}
