/**
 * Optional "Polish wording with AI".
 *
 * Off by default, and the feature works fully without it. When a language model
 * is configured (the same providers the lab builder uses) and the caller opts
 * in, it may rewrite only the title and description of use cases that were
 * already generated. It never sees or changes the product, harness, features,
 * topics, tools, or links: those stay exactly as generated, and every rewrite
 * is checked before it is used. A rewrite that adds a link, markup, or the name
 * of another product is rejected and the original wording stays.
 */

import { createLlm as defaultCreateLlm } from "../lab-builder/llm.js";

export const POLISH_MAX_ITEMS = 40;
const TITLE_RANGE = [8, 140];
const DESCRIPTION_RANGE = [40, 700];
const SYSTEM_PROMPT =
  "You edit the titles and descriptions of AI agent use cases for a training catalog. " +
  "Rewrite each title and description to be clear, concrete, and natural, in US English. " +
  "Keep every fact, product name, and capability exactly as given: do not add or remove capabilities, products, systems, numbers, or claims. " +
  "Do not add links, markdown, HTML, or quotation marks around the text. " +
  'Return only JSON: {"items":[{"id":"...","title":"...","description":"..."}]} with the same ids you were given.';

const URL_LIKE = /https?:\/\/|www\.|[<>`]/i;
const CONTROL = /[\u0000-\u001f\u007f]/;

function mentionedProducts(text) {
  const found = new Set();
  if (/copilot studio/i.test(text)) found.add("copilot-studio");
  if (/agent builder/i.test(text)) found.add("agent-builder");
  return found;
}

/** The checks one rewrite must pass, or null when it is acceptable. */
export function rejectionReason(original, rewrite) {
  if (!rewrite || typeof rewrite.title !== "string" || typeof rewrite.description !== "string") return "missing text";
  const title = rewrite.title.trim();
  const description = rewrite.description.trim();
  if (title.length < TITLE_RANGE[0] || title.length > TITLE_RANGE[1]) return "title length";
  if (description.length < DESCRIPTION_RANGE[0] || description.length > DESCRIPTION_RANGE[1]) return "description length";
  if (URL_LIKE.test(title) || URL_LIKE.test(description)) return "link or markup";
  if (CONTROL.test(title) || CONTROL.test(description)) return "control characters";
  const before = mentionedProducts(`${original.title} ${original.description}`);
  for (const product of mentionedProducts(`${title} ${description}`)) {
    if (!before.has(product)) return "new product name";
  }
  return null;
}

/**
 * @param {object[]} useCases generated use cases (only id, title, and description are read)
 * @param {{createLlm?: Function, env?: object, signal?: AbortSignal}} [options]
 * @returns {Promise<{applied: boolean, provider: string|null, note: string, accepted: number, rejected: number, items: Map<string, {title: string, description: string}>}>}
 */
export async function polishUseCases(useCases, { createLlm = defaultCreateLlm, env = process.env, signal } = {}) {
  const none = { applied: false, provider: null, accepted: 0, rejected: 0, items: new Map() };
  const llm = createLlm(env);
  if (!llm?.available) {
    return { ...none, note: "No language model is configured, so the standard wording is shown." };
  }
  const subset = useCases.slice(0, POLISH_MAX_ITEMS);
  if (!subset.length) return { ...none, provider: llm.provider?.label || null, note: "There was nothing to polish." };

  let parsed = null;
  try {
    const text = await llm.complete(SYSTEM_PROMPT, JSON.stringify({ items: subset.map(({ id, title, description }) => ({ id, title, description })) }), {
      json: true,
      maxTokens: 3500,
      temperature: 0.3,
      signal,
    });
    parsed = text ? JSON.parse(text) : null;
  } catch (err) {
    if (signal?.aborted) throw err;
    parsed = null;
  }
  const rewrites = Array.isArray(parsed?.items) ? parsed.items : [];
  if (!rewrites.length) {
    return { ...none, provider: llm.provider?.label || null, note: "The language model did not return usable wording, so the standard wording is shown." };
  }

  const originals = new Map(subset.map((u) => [u.id, u]));
  const items = new Map();
  let rejected = 0;
  for (const rewrite of rewrites) {
    const original = originals.get(rewrite?.id);
    if (!original || items.has(original.id)) continue;
    if (rejectionReason(original, rewrite)) {
      rejected += 1;
      continue;
    }
    items.set(original.id, { title: rewrite.title.trim(), description: rewrite.description.trim() });
  }
  return {
    applied: items.size > 0,
    provider: llm.provider?.label || null,
    accepted: items.size,
    rejected,
    items,
    note: items.size
      ? `Reworded ${items.size} title${items.size === 1 ? "" : "s"} and description${items.size === 1 ? "" : "s"}${rejected ? `; kept the standard wording for ${rejected} that did not pass the checks` : ""}.`
      : "None of the suggested wording passed the checks, so the standard wording is shown.",
  };
}

/** Apply accepted rewrites to a response. Only titles and descriptions change, and each changed use case says so. */
export function applyPolish(response, result) {
  const useCases = response.useCases.map((useCase) => {
    const rewrite = result.items.get(useCase.id);
    return rewrite ? { ...useCase, title: rewrite.title, description: rewrite.description, polished: true } : useCase;
  });
  return {
    ...response,
    useCases,
    polish: { requested: true, applied: result.applied, provider: result.provider, accepted: result.accepted, rejected: result.rejected, note: result.note },
  };
}
