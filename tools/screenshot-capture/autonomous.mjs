// Autonomous setup for one shot: choose where its steps come from, run them through the executor, and say plainly
// what happened. The order of trust is: the person's own recorded recipe for this shot (when it is not stale), then the
// plan the portal sent (a shared recipe, a built-in recipe, or steps derived from the lab). A recipe that fails when
// it is replayed is marked stale and the next source is tried at once, so a UI change costs one extra attempt, not a
// shot. Whatever the source, every step is checked again here and by the gate before it touches the page.

import { createExecutor } from "./executor.mjs";
import { REASONS } from "./automation.mjs";
import { TIER } from "./guard.mjs";
import { sanitizeSetup, sanitizeSteps, stepsFromReveal } from "./setup-steps.mjs";
import { recipeKeyForShot } from "./recipes.mjs";
import { ensurePracticeAgent } from "./practice.mjs";
import { resolveAutomation } from "./walkthrough.mjs";

export { recipeKeyForShot, stepsFromReveal };

/**
 * The step lists to try for a shot, in order, each with where it came from.
 * @returns {Array<{source: string, steps: object[], limited: object|null, final?: object, inputs: object, recipeKey?: object}>}
 */
export function setupCandidates(shot, { session, practiceAllowed, scratch = null }) {
  const capture = shot.capture || {};
  const product = capture.product || shot.product || "copilot-studio";
  const out = [];
  const key = recipeKeyForShot(shot);
  const local = session.recipes?.get(key);
  const planned = sanitizeSetup(capture.setup, { allowPractice: practiceAllowed, product });
  const inputs = planned?.inputs || {};
  if (local) {
    const steps = sanitizeSteps(local.steps, { product }).filter((s) => practiceAllowed || (s.tier < TIER.PRACTICE && !s.practiceOnly));
    if (steps.length) out.push({ source: "local", steps, limited: null, final: local.final, inputs, recipeKey: key });
  }
  // Building from scratch: the walkthrough's own steps for this shot's stage replace the recipes written for an agent that already exists.
  if (scratch?.steps?.length) {
    out.push({ source: `scratch:${scratch.stage}`, steps: scratch.steps, limited: null, inputs: { ...inputs, ...(scratch.inputs || {}) } });
    return out;
  }
  if (planned && planned.steps.length) out.push({ source: planned.source, steps: planned.steps, limited: planned.limited || null, final: planned.final, inputs, needsPractice: planned.needsPractice });
  else if (planned?.limited) out.push({ source: planned.source, steps: [], limited: planned.limited, final: planned.final, inputs, needsPractice: true });
  if (!out.length) out.push({ source: "derived", steps: stepsFromReveal(capture.reveal, product), limited: null, inputs });
  return out;
}

const trimStepRecord = (r) => ({ id: r.id, action: r.action, status: r.status, strategy: r.strategy || "", tier: r.tier, note: r.summary || "", why: r.note || "", ms: r.ms });

/** Plain explanations for steps that are known to fail for a reason the person can understand and fix. */
const PLAIN_FAILURES = Object.freeze({
  "knowledge-add-url": "The product did not accept the website address (it allows a public website only up to two levels deep, and the Add button stays off), so no knowledge was added. Use “Retake guided”, or add a website yourself.",
  "sessions-any": "The Sessions list has nothing to show yet: sessions appear only after people use the published agent in a channel, and the computer never adds channels or talks to the agent as a user. Use “Retake guided” once the agent has real sessions.",
  "sessions-open": "The Sessions list has nothing to open yet: sessions appear only after the agent is published and people talk to it in a channel, and the computer never adds channels. Use “Retake guided” once the agent has real sessions.",
  "publish-plain": "The Publish dialog shows something the computer does not know (a channel, an audience, a warning, or another button), so it did not publish anything. Look at the dialog yourself, then use “Retake guided”.",
});

/** One sentence that says what the computer could not do and what to do next. */
export function failureMessage(failed, { source = "" } = {}) {
  if (!failed) return "The computer could not set up this screen.";
  if (failed.code !== "blocked" && PLAIN_FAILURES[failed.id]) return PLAIN_FAILURES[failed.id];
  const what = failed.step ? `“${failed.step}”` : "a step";
  switch (failed.code) {
    case "blocked":
      return `The computer would not do ${what}, because it is something it never does on its own (${failed.blockedBy || "a safety rule"}). Set the screen up yourself with “Retake guided”.`;
    case "needs-practice":
      return `${what} needs a practice agent, which this job did not allow.`;
    case "unexpected-effect":
    case "unexpected-prompt":
    case "write-limit":
      return `${failed.why || "A click did something unexpected."} Nothing else was clicked.`;
    case "cancelled":
      return "You stopped the capture, so nothing else was changed.";
    case "left-allowed-site":
      return "The page left the product's own sites, so the capture stopped. Nothing else was clicked.";
    default:
      return `The computer could not complete ${what}: ${failed.why || "the control was not found or did nothing"}. Use “Show me once” so it can learn this screen${source === "local" ? " again" : ""}, or set it up yourself with “Retake guided”.`;
  }
}

/** Whether a shot needs an agent that the person's own address would otherwise have to supply. */
export const needsAgent = (shot) => (shot?.capture?.agentNeeds || []).includes("copilot-studio-agent");

/**
 * Whether a shot's steps need a practice agent, and the practice agent (found or created) when this job allows one. When the job hands
 * the agent over from the creation step (`agentSource: "created"`), every shot that needs an agent needs this one, so the agent is made
 * (or reused) once, for the first of them, and the rest find it in the session.
 */
export async function preparePractice({ page, shot, session, go, trace = null, log = null, sleep, terms = [], home = null, companion = "" }) {
  const autonomy = session.autonomy;
  const practiceAllowed = autonomy.maxTier >= TIER.PRACTICE;
  const product = shot.capture?.product || shot.product || "copilot-studio";
  const handoff = session.agentSource === "created" && product === "copilot-studio" && needsAgent(shot);
  const needed = handoff || setupCandidates(shot, { session, practiceAllowed }).some((c) => c.needsPractice);
  if (!needed) return { needed: false, info: null, error: "" };
  if (!practiceAllowed || !session.registry) return { needed: true, info: null, error: handoff ? autonomy.refusedPractice || "The practice agent could not be created, because this job does not allow it" : "" };
  const executorFor = (practice) => createExecutor({ page, autonomy, product, practice, trace, log, sleep, terms, home, shot: shot.filename, companion, onProgress: session.onProgress, shouldStop: session.shouldStop });
  const ensured = await ensurePracticeAgent({ page, autonomy, registry: session.registry, session, executorFor, go, trace, log });
  return ensured.ok ? { needed: true, info: ensured, error: "" } : { needed: true, info: null, error: ensured.error || "The practice agent could not be set up.", cause: ensured.cause || "" };
}

/**
 * Run the autonomous setup of a shot.
 * @param {object} [options.practiceInfo] the practice agent from `preparePractice`, when the shot runs inside it
 * @returns {Promise<{ok: boolean, setup: object, failed?: object, executor: object, cause?: string, error?: string}>}
 */
export async function runShotSetup({ page, shot, session, practiceInfo = null, practiceError = "", scratch = null, trace = null, log = null, sleep, terms = [], home = null, companion = "", readiness = {} }) {
  // A recipe family has a ceiling: what it does is opening, asking, and closing, so the executor refuses anything more, even in a job that allows a practice agent.
  const autonomy = scratch?.maxTier != null ? { ...session.autonomy, maxTier: Math.min(session.autonomy.maxTier, scratch.maxTier) } : session.autonomy;
  const practiceAllowed = session.autonomy.maxTier >= TIER.PRACTICE;
  const product = shot.capture?.product || shot.product || "copilot-studio";
  const candidates = setupCandidates(shot, { session, practiceAllowed, scratch });
  const notes = practiceError ? [practiceError] : [];

  const practice = { agentId: practiceInfo?.botId || null, envId: practiceInfo?.envId || undefined, creating: false };
  const claimOnce = (key) => Boolean(practiceInfo?.botId) && session.registry?.claimOnce?.(practiceInfo.botId, key) === true;
  const executor = createExecutor({ page, autonomy, product, practice, claimOnce, trace, log, sleep, terms, home, shot: shot.filename, companion, inputs: { ...(candidates[0]?.inputs || {}), ...(scratch?.inputs || {}) }, answerMs: readiness.answerMs, onProgress: session.onProgress, shouldStop: session.shouldStop, writeBudget: session.scratch?.budget, effectMs: session.effectMs, findMs: session.findMs });

  const attempts = [];
  // A screen deeper than the page the address opens, with nothing that can reach it (no recorded recipe, no shared or built-in recipe, no labels to
  // open), is not photographed as it stands: the page that happens to be open is the product's start page, not the screen the lab describes.
  // The shot is left to a person, for the same plain reason the portal showed on its card.
  if (!scratch && !candidates.some((c) => c.steps.length || c.limited) && !["auto", "manual"].includes(shot.capture?.mode)) {
    const automation = resolveAutomation(shot);
    const reason = (automation?.state === "person" && REASONS[automation.reason]) || REASONS.unseen;
    trace?.event("no-recipe", { shot: shot.filename, reason: reason.code, mode: shot.capture?.mode || null });
    return {
      ok: false,
      executor,
      cause: "no-recipe",
      reason: reason.code,
      error: `${reason.why} Use “Retake guided”, or upload the picture.`,
      setup: { source: "derived", steps: [], summary: [], notes: [...notes, "No steps reach this screen."] },
    };
  }
  for (const [index, candidate] of candidates.entries()) {
    // A recipe that needs the practice agent is run in it; without one the steps that need it were already left out.
    const steps = practiceInfo || !candidate.needsPractice ? candidate.steps : candidate.steps.filter((s) => s.tier < TIER.PRACTICE && !s.practiceOnly);
    const finalStep = candidate.final?.text?.length ? [{ id: "final", action: "wait-for", expect: { text: candidate.final.text }, tier: 0, timeoutMs: 6000 }] : [];
    const result = await executor.run([...steps, ...finalStep]);
    attempts.push({ source: candidate.source, ok: result.ok, steps: result.steps.map(trimStepRecord) });
    const changed = result.steps.filter((r) => r.status === "ok" && r.tier >= TIER.PRACTICE);
    if (changed.length && practiceInfo && session.registry) for (const r of changed) session.registry.recordChange({ botId: practiceInfo.botId, what: r.summary || `${r.action} in the practice agent`, shot: shot.filename });
    if (candidate.recipeKey) session.recipes?.markReplay(candidate.recipeKey, result.ok, result.failed?.why || "");
    if (result.ok) {
      // The product showed its own confirmation after the one publish click: the agent is published, and Monitor can show sessions once people use it.
      if (practiceInfo && session.registry && result.steps.some((r) => r.id === "publish-confirm" && r.status === "ok")) session.registry.markStage(practiceInfo.botId, "published");
      // What a recipe family did, for the practice report: what it opened or asked, and what (if anything) it added to the practice agent.
      if (practiceInfo && session.registry?.recordRecipe && scratch?.family) {
        session.registry.recordRecipe({ botId: practiceInfo.botId, family: scratch.family.id, key: scratch.family.key, shot: shot.filename, what: scratch.family.note || "", created: scratch.family.objects || [], verified: scratch.family.verified });
      }
      const limited = (!practiceInfo && candidate.needsPractice) || candidate.limited ? candidate.limited || { by: "practice-agent", skipped: [] } : null;
      return {
        ok: true,
        executor,
        practice: practiceInfo,
        family: scratch?.family || null,
        setup: {
          source: candidate.source,
          steps: result.steps.map(trimStepRecord),
          summary: result.steps.filter((r) => r.status === "ok" && r.effect !== "already there").map((r) => r.summary).filter(Boolean).slice(0, 10),
          limitedBy: limited ? limited.by : null,
          skipped: limited?.skipped || [],
          practice: practiceInfo ? { name: practiceInfo.name, reused: practiceInfo.reused === true } : null,
          earlier: attempts.slice(0, -1).map((a) => ({ source: a.source, ok: a.ok })),
          notes,
        },
      };
    }
    trace?.event("setup-failed", { shot: shot.filename, source: candidate.source, step: result.failed?.id, code: result.failed?.code, next: index + 1 < candidates.length });
    if (index + 1 < candidates.length) {
      log?.(`  The ${candidate.source === "local" ? "recorded recipe" : "steps"} for this screen did not work. Trying another way.`);
      await executor.cleanup().catch(() => {});
      continue;
    }
    const failedRecord = result.steps.at(-1);
    const failed = { ...result.failed, step: failedRecord?.summary || result.failed?.id, diagnostic: result.diagnostic?.file || null, blockedBy: result.failed?.blockedBy || result.blocked?.[0]?.category || "" };
    // Something nobody planned for (a license, a consent, a quota message) or the limit of changes: the whole from-scratch run stops here.
    const runStopped = failed.code === "unexpected-prompt" || failed.code === "write-limit";
    if (runStopped && session.scratch) session.scratch.halted = { kind: result.haltKind || failed.code, message: failed.why || "" };
    return {
      ok: false,
      executor,
      failed,
      cause: runStopped ? "run-stopped" : failed.code === "blocked" ? "blocked-by-safety" : failed.code === "unexpected-effect" ? "unexpected-effect" : failed.code === "needs-practice" ? "needs-practice-agent" : failed.code === "cancelled" ? "stopped" : "automation-failed",
      error: failureMessage(failed, { source: candidate.source }),
      setup: { source: candidate.source, steps: result.steps.map(trimStepRecord), summary: [], failedStep: { id: failed.id, action: failed.action, note: failed.step || "", why: failed.why || "", diagnostic: failed.diagnostic || null }, limitedBy: null, skipped: [], earlier: attempts.slice(0, -1).map((a) => ({ source: a.source, ok: a.ok })), notes },
    };
  }
  return { ok: false, executor, cause: "automation-failed", error: failureMessage(null), setup: { source: "derived", steps: [], summary: [], notes } };
}
