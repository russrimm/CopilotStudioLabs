/**
 * Which agent a capture's screenshots use, and whether the agent can come from the creation step.
 *
 *   created   the practice agent the computer creates (or reuses) first in the same capture, and then uses for every screenshot that shows an
 *             agent. Nothing to type. This is the default.
 *   own       an agent the person chose, by address or by name.
 *
 * Only the choice is kept (a word, with the lab's capture settings). The address of an agent the computer created stays on the computer that
 * created it (its local practice-agent record); the portal never sees it.
 */

import { TARGET_FIELDS, withoutOwnAgent } from "../../../tools/screenshot-capture/targets.mjs";
import { normalizeAgentSource } from "../../../tools/screenshot-capture/walkthrough.mjs";

/** The first companion that hands the practice agent to every later screenshot, whatever level of automatic capture was allowed. */
export const HANDOFF_MIN_COMPANION = "1.6.2";

/** Why the agent cannot be created now, as short codes the plan carries; `fallbackReason` words them. */
export const AGENT_FALLBACKS = Object.freeze(["consent", "companion"]);

/** The choice a request makes: the field itself, or the older `agent` option ("existing" is the person's own agent, "scratch" is the created one). */
export function requestedAgentSource(options) {
  const asked = normalizeAgentSource(options?.agentSource);
  if (asked) return asked;
  if (options?.agent === "existing") return "own";
  if (options?.agent === "scratch") return "created";
  return null;
}

/**
 * The choice that applies: what the request says, else what the lab saved, else "own" when an agent address or name is already set (that is how
 * labs worked before this choice existed), else "created".
 * @returns {{source: "created"|"own", from: "request"|"lab"|"address"|"default"}}
 */
export function resolveAgentSource({ requested = null, saved = null, agentSupplied = false } = {}) {
  const asked = normalizeAgentSource(requested);
  if (asked) return { source: asked, from: "request" };
  const kept = normalizeAgentSource(saved);
  if (kept) return { source: kept, from: "lab" };
  return agentSupplied ? { source: "own", from: "address" } : { source: "created", from: "default" };
}

/**
 * Whether the practice agent can be created in a job: automatic capture must be on and allowed to create one, and the companion must be able to
 * hand it over. `fallback` is the reason when it cannot (null when it can).
 * @param {{level: string}|null} autonomy what the job may do
 * @param {{handoffSupported: boolean, scratchSupported: boolean}} support what the connected companion can do
 */
export function creationState({ autonomy = null, mode = "smart", support = { handoffSupported: true } } = {}) {
  if (mode !== "autonomous" || !autonomy || !["scratch", "practice"].includes(autonomy.level)) return { possible: false, fallback: "consent" };
  // Building from scratch has handed the agent over since the companion that can build it (1.6.0); the practice level needs 1.6.2.
  if (autonomy.level === "practice" && support.handoffSupported === false) return { possible: false, fallback: "companion" };
  return { possible: true, fallback: null };
}

/** The settings a job carries when its agent comes from the creation step: the person's own agent address and name are not among them. */
export function withoutOwnAgentTargets(jobTargets) {
  const values = withoutOwnAgent(jobTargets.values);
  const env = { ...jobTargets.env };
  const text = { ...jobTargets.text };
  for (const field of TARGET_FIELDS) {
    if (!["copilotStudioAgentUrl", "copilotStudioAgentName", "copilotStudioUrl"].includes(field.id)) continue;
    if (field.env) {
      if (values[field.id]) env[field.env] = values[field.id];
      else delete env[field.env];
    }
    if (field.kind === "text" && !values[field.id]) delete text[field.id];
  }
  return { ...jobTargets, values, env, text };
}

/** Why a screenshot that should use the created agent needs an address instead, in plain words (for the job row and the Screenshot Center). */
export function fallbackReason(code) {
  if (code === "companion") return `your Local Capture Companion is older than ${HANDOFF_MIN_COMPANION}, so it cannot hand a practice agent to the other screenshots yet`;
  return "automatic capture is not allowed to create anything yet";
}
