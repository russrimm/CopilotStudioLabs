/**
 * AI writing: the `ai` object of a build request, `{ enabled, provider, model, scope }`.
 *
 * This only checks the shape, so an old client, a CLI or a draft with no `ai` field (or `enabled: false`) builds exactly as
 * before. Whether the model exists and whether this visitor may use it is decided later, by the service, against the live
 * model list.
 */

import { AI_SCOPES, isModelId } from "./config.js";

export const AI_PROVIDERS = Object.freeze(["github-copilot", "byok"]);

/**
 * @returns {undefined | {enabled: true, provider: string, model: string, scope: string[]}} undefined means no AI
 * @throws {Error} with a plain message when the shape is wrong
 */
export function normalizeAiChoice(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("ai must be an object.");
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") throw new Error("ai.enabled must be true or false.");
  if (!value.enabled) return undefined;
  if (value.provider !== undefined && !AI_PROVIDERS.includes(value.provider)) throw new Error(`ai.provider must be one of ${AI_PROVIDERS.join(", ")}.`);
  if (!isModelId(value.model)) throw new Error("Pick a model from the list to write with AI.");
  let scope = AI_SCOPES;
  if (value.scope !== undefined) {
    if (!Array.isArray(value.scope) || value.scope.length > AI_SCOPES.length) throw new Error(`ai.scope must list parts of the lab: ${AI_SCOPES.join(", ")}.`);
    const unknown = value.scope.filter((item) => !AI_SCOPES.includes(item));
    if (unknown.length) throw new Error(`Unknown AI scope "${String(unknown[0]).slice(0, 20)}". Use ${AI_SCOPES.join(", ")}.`);
    scope = AI_SCOPES.filter((item) => value.scope.includes(item));
    if (!scope.length) throw new Error("Choose at least one part of the lab for AI to write.");
  }
  return { enabled: true, provider: value.provider || "github-copilot", model: value.model, scope: [...scope] };
}
