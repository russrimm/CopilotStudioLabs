/**
 * AI writing: the model list a person sees.
 *
 * Turns what the SDK reports (id, name, capabilities, billing multiplier, policy, provider) into plain words, drops the
 * models an administrator or the account's policy does not allow, and caches the answer for a short time.
 */

import { createHash } from "node:crypto";
import { isModelId } from "./config.js";

/** "Costs" in the words a trainer uses, from a billing multiplier. */
export function costLabel(multiplier) {
  if (multiplier === undefined || multiplier === null || !Number.isFinite(Number(multiplier))) return "Cost not reported by GitHub";
  const value = Number(multiplier);
  if (value === 0) return "Included with your plan, no premium requests";
  if (value === 1) return "Uses 1 premium request for each prompt";
  const shown = Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
  return value < 1 ? `Uses ${shown} of a premium request for each prompt` : `Uses ${shown} premium requests for each prompt`;
}

function cleanText(value, max = 80) {
  return String(value ?? "").replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * @param {object[]} raw models from the SDK (or built from configuration)
 * @param {{allowed?: string[]}} [options] administrator allowlist; empty or missing allows every model the account offers
 */
export function normalizeModels(raw, { allowed = [] } = {}) {
  const allow = new Set(allowed);
  const seen = new Set();
  const models = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    const id = entry?.id;
    if (!isModelId(id) || seen.has(id)) continue;
    if (allow.size && !allow.has(id)) continue;
    const state = entry?.policy?.state;
    if (state && state !== "enabled") continue;
    seen.add(id);
    const multiplier = entry?.billing?.multiplier;
    models.push({
      id,
      name: cleanText(entry?.name || id),
      vendor: cleanText(entry?.vendor || entry?.provider?.label || "", 40) || null,
      multiplier: Number.isFinite(Number(multiplier)) && multiplier !== null && multiplier !== undefined ? Number(multiplier) : null,
      cost: costLabel(multiplier),
      category: cleanText(entry?.modelPickerCategory || "", 24) || null,
      warning: cleanText(entry?.warningText?.text || entry?.warningText || "", 160) || null,
      reasoningEfforts: Array.isArray(entry?.supportedReasoningEfforts) ? entry.supportedReasoningEfforts.map((x) => cleanText(x, 12)).filter(Boolean) : [],
      defaultReasoningEffort: cleanText(entry?.defaultReasoningEffort || "", 12) || null,
    });
  }
  return models;
}

/** The models a "bring your own key" server offers, from AI_BYOK_MODELS, with a cost the owner pays elsewhere. */
export function byokModels(config) {
  return config.byok.models.map((model) => ({
    id: model.id,
    name: model.name,
    vendor: config.byok.type,
    multiplier: null,
    cost: "Billed by the server's own model provider, not by GitHub",
    category: null,
    warning: null,
    reasoningEfforts: [],
    defaultReasoningEffort: null,
  }));
}

/** A cache for the model list, one entry per identity, that lasts `ttlMs`. The key is a hash, never the token. */
export function createModelCache({ ttlMs, now = Date.now } = {}) {
  const entries = new Map();
  return {
    keyFor(identity) {
      return createHash("sha256").update(String(identity || "shared")).digest("hex").slice(0, 24);
    },
    get(key) {
      const hit = entries.get(key);
      if (!hit) return null;
      if (now() - hit.at > ttlMs) {
        entries.delete(key);
        return null;
      }
      return hit.models;
    },
    set(key, models) {
      if (entries.size >= 200) entries.delete(entries.keys().next().value);
      entries.set(key, { at: now(), models });
    },
    clear() {
      entries.clear();
    },
  };
}
