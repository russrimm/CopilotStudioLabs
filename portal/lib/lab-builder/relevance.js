/**
 * Relevance scoring for Microsoft Learn search results.
 *
 * `microsoft_docs_search` searches every Microsoft product at once. Ranked by
 * the server alone, a module about creating a Copilot Studio agent cited
 * Microsoft Fabric IQ, Power Automate process mining, and a Power Platform
 * release plan, while the page that actually answers it ranked fourth. Every
 * one of those URLs returns HTTP 200, so link checking cannot see the problem.
 * This module is the relevance test that was missing.
 *
 * The scoring reuses `steps.js` deliberately. `tokens`, `overlap`, `coverage`,
 * and `clamp` are the same primitives that pick a procedure out of a page, used
 * here on the same kind of question — "is this text about this module?" — so
 * the two scores stay comparable where they sit side by side in the manifest.
 * What does not carry over is `labels()` and `scoreProcedure()`: those key off
 * bolded UI labels in a fetched page, and a search excerpt has no bold and no
 * procedure to compare screens against.
 *
 * The one structural difference from `scoreProcedure` matters. There, every
 * candidate comes from a page already known to be about the right product, so
 * topical signals can simply be added up. Here the strongest topical signal is
 * also the most misleading one: `fabric/iq/ontology/how-to-create-agent-copilot-studio`
 * matches "create an agent" almost perfectly, because it is the same *task* in
 * the wrong *product*. So product affinity multiplies the topical score rather
 * than adding to it. An off-product page cannot out-argue its own URL.
 *
 * Search results are untrusted input. Nothing here executes them; URLs are
 * parsed with `URL` and anything that will not parse scores zero.
 */

import { tokens, overlap, coverage, clamp } from "./steps.js";

/**
 * Minimum score a search result must reach to be cited.
 *
 * Measured, not guessed. Across the five modules in the issue #40 reproduction,
 * every off-product result scored at or below 0.052 — `/power-platform/release-plan/…`
 * 0.052, `/fabric/iq/…` 0.044, `/power-apps/developer/…` 0.019 — while on-product
 * how-to pages reached 0.950. Any floor in that gap removes the cross-product
 * bleed, so the floor is set by the other risk: cutting a good citation.
 *
 * The binding case is `content-moderation`, whose best on-product result scores
 * only 0.185 because its vocabulary ("moderation level", "refusal behaviour")
 * barely appears in Learn titles. At 0.18 it would lose `prompt-model-settings`
 * (0.154) — the page that actually documents the moderation slider. 0.10 sits
 * below that page and above every off-product result, which is the whole job.
 */
export const DEFAULT_FLOOR = 0.1;

/** How many citations a module carries. Matches the previous behaviour. */
export const MAX_SOURCES = 6;

/**
 * Path roots that are umbrellas over many products rather than a product.
 *
 * `/microsoft-copilot-studio/` names one product, so one segment identifies it.
 * `/power-platform/` does not: it covers admin, ALM, release plans, and
 * reference architectures alike, so a feature documented under
 * `/power-platform/admin/` should not treat `/power-platform/release-plan/` as
 * home turf. For these roots the expected prefix is two segments deep.
 */
const UMBRELLA_ROOTS = new Set([
  "power-platform",
  "power-apps",
  "power-automate",
  "power-bi",
  "power-pages",
  "dynamics365",
  "azure",
  "microsoft-365",
  "troubleshoot",
  "industry",
]);

/**
 * Page kinds that answer a different question than a walk-through module asks.
 *
 * These are demoted, not banned — see `rankResults`. A release plan describes
 * what is coming rather than how to do it; a troubleshooting article assumes
 * you already did it and it broke. Both are worth citing when nothing better
 * exists, and worth nothing when a how-to is right there.
 */
const KIND_PENALTIES = [
  [/(^|\/)release-plan(\/|$)/, 0.45],
  [/(^|\/)(whats-new|release-notes|known-issues|limitations)(\/|$)/, 0.35],
  [/(^|\/)troubleshoot(\/|$)/, 0.3],
  [/(^|\/)(reference-architectures|architecture)(\/|$)/, 0.25],
  [/(^|\/)previous-versions(\/|$)/, 0.45],
];

const LOCALE = /^[a-z]{2}(-[a-z]{2})?$/i;

/** Path segments of a Learn URL, with any locale prefix removed. */
function segmentsOf(url) {
  try {
    const parsed = new URL(String(url));
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    const parts = parsed.pathname.split("/").filter(Boolean).map((part) => part.toLowerCase());
    if (parts.length && LOCALE.test(parts[0]) && parts[0] !== "iq") parts.shift();
    return parts;
  } catch {
    return null;
  }
}

/**
 * The documentation areas a feature's citations are expected to live in.
 *
 * Derived from the curated `docUrls` the catalog already carries, so the 36
 * catalog entries need no hand editing and a new entry inherits the behaviour
 * for free. A feature may override with an explicit `docPaths` array when the
 * derivation is wrong for it.
 *
 * @returns {string[][]} each prefix as its path segments, e.g. [["microsoft-copilot-studio"]]
 */
export function docPathPrefixes(feature) {
  // An explicit override is a statement of intent and is used verbatim. Only
  // derived prefixes get the umbrella-root depth rule applied to them.
  if (Array.isArray(feature?.docPaths) && feature.docPaths.length) {
    const explicit = new Map();
    for (const value of feature.docPaths) {
      const parts = String(value).split("/").filter(Boolean).map((part) => part.toLowerCase());
      if (parts.length) explicit.set(parts.join("/"), parts);
    }
    if (explicit.size) return [...explicit.values()];
  }

  const seen = new Map();
  for (const url of feature?.docUrls || []) {
    const parts = segmentsOf(url);
    if (!parts?.length) continue;
    const depth = UMBRELLA_ROOTS.has(parts[0]) && parts.length > 1 ? 2 : 1;
    const prefix = parts.slice(0, depth);
    seen.set(prefix.join("/"), prefix);
  }

  // A feature with no usable docUrls still belongs to this repository's product.
  if (!seen.size) seen.set("microsoft-copilot-studio", ["microsoft-copilot-studio"]);
  return [...seen.values()];
}

/**
 * How much this URL looks like it belongs to the module's product area.
 *
 *   1.00  inside one of the expected prefixes
 *   0.45  elsewhere, but still about this product — chiefly
 *         `/troubleshoot/power-platform/copilot-studio/...`, which is genuine
 *         Copilot Studio content filed under a different root
 *   0.08  another product entirely
 *
 * The off-product figure is small on purpose but not zero, so that scoring
 * stays a ranking rather than a whitelist and an unusually strong off-product
 * match can still be inspected in the manifest.
 */
export function pathAffinity(url, prefixes) {
  const parts = segmentsOf(url);
  if (!parts?.length) return 0;

  for (const prefix of prefixes) {
    if (prefix.every((segment, index) => parts[index] === segment)) return 1;
  }

  const products = new Set(prefixes.map((prefix) => prefix[0]));
  for (const segment of parts) {
    for (const product of products) {
      if (segment === product || product.endsWith(`-${segment}`)) return 0.45;
    }
  }

  return 0.08;
}

/** The demotion this URL earns for being the wrong *kind* of page. */
export function kindPenalty(url) {
  const parts = segmentsOf(url);
  if (!parts?.length) return 0;
  const path = `/${parts.join("/")}/`;
  let worst = 0;
  for (const [pattern, weight] of KIND_PENALTIES) {
    if (pattern.test(path)) worst = Math.max(worst, weight);
  }
  return worst;
}

/**
 * Score one search result against one catalog feature.
 *
 * `title` is compared symmetrically: a title and a module name are both short
 * labels for the same thing, which is what `overlap` is for. `excerpt` is
 * compared directionally: it is long, so the question is how much of the
 * module's vocabulary it actually reproduces, which is what `coverage` is for.
 *
 * @returns {{score:number, affinity:number, penalty:number, topical:number}}
 */
export function scoreResult(result, feature, prefixes = docPathPrefixes(feature)) {
  const featureTerms = tokens([feature?.name, feature?.summary].filter(Boolean).join(" "));
  const titleScore = overlap(tokens(result?.title), featureTerms);
  const excerptScore = coverage(featureTerms, tokens(result?.excerpt));

  const topical = clamp(0.6 * titleScore + 0.4 * excerptScore);
  const affinity = pathAffinity(result?.url, prefixes);
  const penalty = kindPenalty(result?.url);

  return { score: clamp(topical * affinity), affinity, penalty, topical };
}

/**
 * Rank a feature's search results and split them at the relevance floor.
 *
 * Kind penalties are applied only when an unpenalized result already clears
 * the floor — that is what "demote a troubleshooting page *when a how-to is
 * available*" means. Applying them unconditionally would throw away the only
 * on-topic page a module has whenever that page happens to be filed under
 * `/troubleshoot/`, which is a worse lab, not a stricter one.
 *
 * @returns {{kept:Array, dropped:Array}} both ranked best first
 */
export function rankResults(results = [], feature, { floor = DEFAULT_FLOOR } = {}) {
  const prefixes = docPathPrefixes(feature);
  const scored = results.map((result) => ({ result, ...scoreResult(result, feature, prefixes) }));

  const haveHowTo = scored.some((item) => item.penalty === 0 && item.score >= floor);
  const ranked = scored
    .map((item) => {
      const score = haveHowTo && item.penalty ? clamp(item.score - item.penalty) : item.score;
      return { ...item.result, relevance: Number(score.toFixed(3)), affinity: item.affinity };
    })
    .sort((a, b) => b.relevance - a.relevance);

  return {
    kept: ranked.filter((item) => item.relevance >= floor),
    dropped: ranked.filter((item) => item.relevance < floor),
  };
}
