/**
 * Lab builder blockers — conditions that must stop the build and ask a human.
 *
 * A *warning* is informational: the build proceeds and the note is recorded.
 * A *blocker* halts generation before anything is written to disk, states the
 * consequence for the learner in plain language, and offers 2-4 ranked options
 * with exactly one marked recommended.
 *
 * The guiding rule for what belongs here: an explicit human choice is not a
 * silent degradation. Turning Microsoft Learn grounding off on purpose stays a
 * warning; the grounding server failing on its own is a blocker.
 *
 * This module owns the vocabulary so the generator, the portal route, the
 * wizard, and the CLI all speak the same codes.
 */

import { getCatalog } from "./catalog.js";

export const BLOCKER_CODES = Object.freeze({
  LEARN_MCP_UNAVAILABLE: "learn-mcp-unavailable",
  MODULES_UNGROUNDED: "modules-ungrounded",
  STEPS_FETCH_FAILED: "steps-fetch-failed",
  STEPS_NOT_DERIVED: "steps-not-derived",
  LLM_PARTIAL_FAILURE: "llm-partial-failure",
  MODULES_DEFERRED: "modules-deferred",
});

/** Option id that means "run the same gate again" rather than "resolve it". */
export const RETRY = "retry";
/** Option id that means "stop and write nothing". */
export const CANCEL = "cancel";

const CANCEL_OPTION = {
  id: CANCEL,
  label: "Cancel the build",
  tradeoff: "Nothing is written. Your selections are kept so you can change them and try again.",
};

/**
 * Ranked options per blocker, best first. Exactly one carries `recommended`.
 *
 * `learn-mcp-unavailable` deliberately has no "drop the affected modules"
 * option: when the handshake fails every module is affected, so dropping them
 * leaves an empty lab. That option belongs to `modules-ungrounded`, where the
 * affected set is a real subset.
 *
 * `modules-ungrounded` deliberately has no retry: a zero-result search is
 * cached for 15 minutes and reflects the query, not a transient fault.
 */
const OPTIONS = Object.freeze({
  [BLOCKER_CODES.LEARN_MCP_UNAVAILABLE]: [
    {
      id: RETRY,
      label: "Retry the connection now",
      tradeoff: "Costs one more handshake attempt. Most failures here are transient and clear on a second try.",
      recommended: true,
    },
    {
      id: "proceed-curated",
      label: "Build on the curated documentation links instead",
      tradeoff:
        "The lab is complete and passes validation, but nothing is checked against live documentation — neither the citations nor the click-by-click steps, which are read from the live pages when Learn is reachable. Anything Microsoft has changed will be wrong.",
    },
    CANCEL_OPTION,
  ],

  [BLOCKER_CODES.MODULES_UNGROUNDED]: [
    {
      id: "proceed-curated",
      label: "Cite the curated documentation links for those modules",
      tradeoff:
        "Those chapters cite the catalog's fallback links rather than live documentation. Every other chapter is still grounded on Microsoft Learn.",
      recommended: true,
    },
    {
      id: "drop-modules",
      label: "Remove those modules from the lab",
      tradeoff:
        "The lab gets shorter. Any module that depends on a removed one is removed too, and all of them move to Where to Go Next.",
    },
    CANCEL_OPTION,
  ],

  [BLOCKER_CODES.STEPS_FETCH_FAILED]: [
    {
      id: RETRY,
      label: "Retry reading those documentation pages",
      tradeoff: "Costs another request per module. Fetch failures here are usually timeouts and clear on a second try.",
      recommended: true,
    },
    {
      id: "proceed-catalog",
      label: "Use this repository's curated steps for those modules",
      tradeoff:
        "Those modules get a complete, valid walk-through, but their clicks were never checked against a live page and the lab says so.",
    },
    CANCEL_OPTION,
  ],

  // Deliberately no retry, for the same reason `modules-ungrounded` has none:
  // the page was read successfully and is cached for 15 minutes, and parsing it
  // again is deterministic. Offering a retry that cannot change the outcome
  // would waste the human's time and misrepresent the failure.
  [BLOCKER_CODES.STEPS_NOT_DERIVED]: [
    {
      id: "proceed-catalog",
      label: "Use this repository's curated steps for those modules",
      tradeoff:
        "Those modules get a complete, valid walk-through, but their clicks come from the catalog rather than the live page, and the lab says so per module.",
      recommended: true,
    },
    CANCEL_OPTION,
  ],

  [BLOCKER_CODES.LLM_PARTIAL_FAILURE]: [
    {
      id: RETRY,
      label: "Retry the passages that failed",
      tradeoff: "Spends tokens again and may hit the same rate limit or timeout.",
      recommended: true,
    },
    {
      id: "proceed-deterministic",
      label: "Use the catalog narrative for every passage",
      tradeoff:
        "One consistent voice throughout, but the lab loses the scenario-specific detail the model was writing.",
    },
    {
      id: "proceed-mixed",
      label: "Keep the passages that succeeded",
      tradeoff:
        "The lab mixes model-written and catalog narrative, so the voice changes from one section to the next.",
    },
    CANCEL_OPTION,
  ],

  [BLOCKER_CODES.MODULES_DEFERRED]: [
    {
      id: "accept-deferred",
      label: "Keep the time budget and list them as next steps",
      tradeoff:
        "The lab fits the time you asked for. The dropped modules appear only under Where to Go Next, not as hands-on chapters.",
      recommended: true,
    },
    {
      id: "ignore-budget",
      label: "Build every module you selected",
      tradeoff: "Every selected module becomes a chapter, and the lab runs longer than the budget you set.",
    },
    CANCEL_OPTION,
  ],
});

const TITLES = Object.freeze({
  [BLOCKER_CODES.LEARN_MCP_UNAVAILABLE]: "Microsoft Learn is unreachable",
  [BLOCKER_CODES.MODULES_UNGROUNDED]: "Some modules found no Microsoft Learn results",
  [BLOCKER_CODES.STEPS_FETCH_FAILED]: "Some documentation pages could not be read",
  [BLOCKER_CODES.STEPS_NOT_DERIVED]: "Some modules' steps could not be read from the documentation",
  [BLOCKER_CODES.LLM_PARTIAL_FAILURE]: "Some model-written passages failed",
  [BLOCKER_CODES.MODULES_DEFERRED]: "The time budget dropped a module you asked for",
});

const ALL_CODES = Object.values(BLOCKER_CODES);

/** The exact CLI flag that resolves one blocker with one option. */
export function cliFlagFor(code, optionId) {
  return `--decide ${code}=${optionId}`;
}

/** Ranked options for a blocker code, best first. Returns [] for unknown codes. */
export function getBlockerOptions(code) {
  return (OPTIONS[code] || []).map((option) => ({
    id: option.id,
    label: option.label,
    tradeoff: option.tradeoff,
    recommended: Boolean(option.recommended),
    cliFlag: cliFlagFor(code, option.id),
  }));
}

/** The recommended option id for a blocker code, or null. */
export function recommendedOption(code) {
  return getBlockerOptions(code).find((option) => option.recommended)?.id || null;
}

export function isKnownBlockerCode(code) {
  return ALL_CODES.includes(code);
}

export function isCancel(optionId) {
  return optionId === CANCEL;
}

/**
 * How current the catalog's fallback documentation links are.
 *
 * This is deliberately conservative: it makes no freshness claim it cannot
 * support. A date is only quoted when the catalog actually carries one.
 *
 * Resolution order:
 *   1. per-feature `lastVerified` (added by issue #42) — the oldest wins,
 *      and only when every affected feature carries one
 *   2. the catalog-wide `docsReviewed` fallback
 *   3. no date at all
 *
 * @param {Array<{lastVerified?:string}>} [features] the affected features
 */
export function curatedDocsAge(features = [], now = Date.now()) {
  const perFeature = features.map((feature) => feature?.lastVerified).filter(Boolean);
  const source =
    features.length > 0 && perFeature.length === features.length
      ? perFeature.sort()[0]
      : getCatalog().docsReviewed || null;

  const reviewedAt = source ? Date.parse(source) : NaN;
  if (Number.isNaN(reviewedAt)) {
    return { reviewed: null, ageDays: null, phrase: "not verified against live documentation" };
  }

  const ageDays = Math.max(0, Math.floor((now - reviewedAt) / 86400000));
  return {
    reviewed: source,
    ageDays,
    phrase: `last verified ${source} (${ageDays} day${ageDays === 1 ? "" : "s"} ago)`,
  };
}

/**
 * Build a blocker for a code.
 *
 * @param {string} code            one of BLOCKER_CODES
 * @param {object} [context]
 * @param {string} [context.consequence]  plain-language impact on the learner
 * @param {object} [context.detail]       machine-readable context for callers
 */
export function buildBlocker(code, { consequence = "", detail = {} } = {}) {
  if (!isKnownBlockerCode(code)) throw new Error(`Unknown blocker code: ${code}`);
  return {
    code,
    title: TITLES[code],
    consequence,
    detail,
    options: getBlockerOptions(code),
  };
}

/**
 * Validate a caller-supplied decisions map.
 * Rejects anything that is not `{ [knownCode]: knownOptionId }` so untrusted
 * input can never reach the generator.
 *
 * @returns {Record<string,string>} a plain object safe to pass on
 */
export function normalizeDecisions(raw) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("decisions must be an object mapping a blocker code to an option id.");
  }

  // Keys are checked against a fixed allowlist below, so a plain object is
  // safe here and stays comparable for callers and tests.
  const out = {};
  for (const [code, optionId] of Object.entries(raw)) {
    if (!isKnownBlockerCode(code)) {
      throw new Error(`Unknown blocker code "${code}". Known codes: ${ALL_CODES.join(", ")}.`);
    }
    if (typeof optionId !== "string") {
      throw new Error(`Decision for "${code}" must be an option id string.`);
    }
    const known = getBlockerOptions(code).map((option) => option.id);
    if (!known.includes(optionId)) {
      throw new Error(`Unknown option "${optionId}" for "${code}". Valid options: ${known.join(", ")}.`);
    }
    out[code] = optionId;
  }
  return out;
}

/**
 * The effective resolution for a blocker code.
 *
 * `retry` resolves to `undefined` on purpose: retrying means "evaluate this
 * gate again", so if the condition is still there the blocker is raised again.
 */
export function resolveDecision(decisions, code) {
  const chosen = decisions?.[code];
  return chosen && chosen !== RETRY ? chosen : undefined;
}

/**
 * The manifest record for a resolved blocker: which blocker, which option,
 * how it was decided, and when.
 *
 * Deliberately carries no user identity. The manifest travels with the lab —
 * `exporter.js` archives every non-Markdown file in a lab directory verbatim,
 * and that archive can be emailed to an arbitrary recipient. Attribution of
 * *who* decided belongs in a server-side log, never in the lab artifact.
 */
export function decisionRecord(blocker, optionId, { decidedVia = "api", decidedAt } = {}) {
  const option = blocker.options.find((candidate) => candidate.id === optionId) || null;
  return {
    code: blocker.code,
    title: blocker.title,
    consequence: blocker.consequence,
    chosen: option ? { id: option.id, label: option.label, tradeoff: option.tradeoff } : { id: optionId },
    decidedAt: decidedAt || new Date().toISOString(),
    decidedVia,
  };
}
