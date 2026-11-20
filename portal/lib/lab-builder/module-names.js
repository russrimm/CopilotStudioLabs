/**
 * Plain module and title wording.
 *
 * The catalog names a module that exists on more than one harness with the harness in parentheses
 * ("Create an agent (Microsoft Copilot harness)") so the two can be told apart in the topic list. Inside a
 * lab written for one harness the suffix is noise: it repeats in every heading, quiz question and sentence,
 * and the lab already says which harness it is for. These helpers take it off where it is safe to.
 */

const SUFFIX = /\s*\((Microsoft Copilot|Customer Conversation|Standard) harness\)\s*$/i;
const HARNESS_LABEL = {
  "microsoft-copilot": "microsoft copilot",
  "customer-conversation": "customer conversation",
  standard: "standard",
};

export const MAX_TITLE_CHARS = 100;

/** The name without a trailing "(... harness)". */
export function stripHarnessSuffix(name) {
  return String(name ?? "").replace(SUFFIX, "").trim();
}

/**
 * The features with the lab harness's suffix removed from their names. Nothing changes when the lab mixes
 * harnesses or when stripping would make two names the same, because then the suffix is what tells them apart.
 */
export function plainModuleNames(features, harness) {
  const label = HARNESS_LABEL[harness];
  if (!label) return features;
  const suffixes = features.map((f) => SUFFIX.exec(f.name)?.[1]?.toLowerCase() ?? null);
  if (suffixes.some((s) => s && s !== label)) return features;
  const plain = features.map((f, index) => (suffixes[index] ? stripHarnessSuffix(f.name) : f.name));
  if (new Set(plain.map((n) => n.toLowerCase())).size !== plain.length) return features;
  return features.map((f, index) => (plain[index] === f.name ? f : { ...f, name: plain[index] }));
}

/**
 * The part of a lab title after "with": the module name for one module, "A and B" for two, and the products
 * (the fallback) for more or when the names would make the title too long. The modules are listed in the lab.
 */
export function titleHeadline(names, fallback, { prefixLength = 0 } = {}) {
  const clean = [...new Set(names.map(stripHarnessSuffix).filter(Boolean))];
  if (clean.length === 1) return clean[0];
  if (clean.length === 2) {
    const both = `${clean[0]} and ${clean[1]}`;
    if (prefixLength + both.length <= MAX_TITLE_CHARS) return both;
  }
  return fallback;
}