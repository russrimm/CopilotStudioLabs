// Building the practice agent from scratch and walking a lab on it. This is the engine behind "Build the agent from scratch":
//
//   ensureScratchAgent   finds this lab's practice agent (made once, reused, resumable) or makes it, in the environment the
//                        person chose or the one the product opens, and writes it down locally the moment it exists
//   prepareStage         brings one stage of the lab into place on that agent (name, instructions, knowledge, publish),
//                        once: a stage already done is skipped, so a rerun never creates or adds anything twice
//   prepareScratchShot   for one shot: the stages before it, the right screen, and the shot's own state (a dialog open, a
//                        question answered), with every step proved by what the page shows
//
// Every click and keystroke goes through the executor, so the action tiers decide, at the click, whether it happens: a
// write is only ever done inside the practice agent (or the one sanctioned Create flow), and never anything in the NEVER
// list. A step the computer cannot do ends the shot as "needs you" with a plain, specific reason. An unexpected prompt
// (a license, a consent, a quota message) stops the whole run.

import { createExecutor, removableItemsInPage } from "./executor.mjs";
import { TIER } from "./guard.mjs";
import { findControls } from "./locator.mjs";
import { BLOCKERS, resolveStage, scratchInputs, stageById, stagesBefore, sanitizeScratchContext } from "./walkthrough.mjs";
import * as R from "./scratch-recipes.mjs";
import { sanitizeSteps } from "./setup-steps.mjs";
import { AGENT_ACCOUNT_MESSAGE, agentAccountState } from "./practice.mjs";
import { parseCopilotStudioAddress } from "./targets.mjs";

const DEFAULT_START = "https://copilotstudio.microsoft.com/";
const CREATE_AREAS = new Set(["home", "agents", "create", "new"]);
const sleepDefault = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The per-job state of a from-scratch run. */
export function scratchState(session) {
  if (!session.scratch) {
    const context = sanitizeScratchContext(session.autonomy?.scratchContext || {});
    session.scratch = { context, inputs: scratchInputs(context), agent: null, layout: null, halted: null, done: new Set(), asked: false, retired: false, budget: { count: 0, max: 80, gapMs: session.writeGapMs ?? 1500, last: 0 } };
  }
  return session.scratch;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The first page after sign-in can be a personal home that the product moves on from a few seconds later. */
const isProvisionalEnv = (envId) => String(envId || "").startsWith("~");

/** A page of the environment from which the one sanctioned Create flow runs (the Agents list, Home, or the new-agent page before it is saved). */
export function isCreateFlowUrl(url, envBase) {
  const parsed = parseCopilotStudioAddress(url);
  if (!parsed.ok || !envBase || parsed.envBase !== envBase) return false;
  if (parsed.botId) return !UUID.test(parsed.botId) && /^(?:new|create)$/i.test(parsed.botId);
  return !parsed.area || CREATE_AREAS.has(parsed.area);
}

/** Wait until the product has moved on from the personal home to the environment it really opens (it can take ten seconds). */
async function settledEnvironment(page, { sleep = sleepDefault, tries = 20 } = {}) {
  let parsed = parseCopilotStudioAddress(page.url());
  for (let i = 0; i < tries && (!parsed.envBase || isProvisionalEnv(parsed.envId)); i += 1) {
    await sleep(1000);
    parsed = parseCopilotStudioAddress(page.url());
  }
  return parsed;
}

const needsYou = (cause, error, extra = {}) => ({ ok: false, status: "needs-you", cause, error, ...extra });

/**
 * The steps of a recipe, checked. A step the safety rules drop (for example a button name that sounds like publishing to a channel)
 * must never be skipped quietly: a stage would then look done without its write. A recipe with a dropped step is refused whole.
 */
export function strictSteps(raw) {
  const steps = sanitizeSteps(raw, { product: "copilot-studio" });
  const missing = raw.filter((r) => !steps.some((s) => s.id === r.id || s.id.startsWith(`${r.id}-`))).map((r) => r.id);
  return { steps, missing };
}

/** One sentence for a step the computer could not do, with the one thing to do next. */
function stepFailure(label, result) {
  const failed = result?.failed;
  if (result?.halted) return { cause: String(result.haltKind || "").startsWith("unexpected-") || result.haltKind === "write-limit" ? "run-stopped" : "unexpected-effect", error: `${result.halted}`, halted: true };
  if (failed?.code === "blocked") return { cause: "blocked-by-safety", error: `The computer would not ${label.toLowerCase()}, because ${failed.blockedBy ? `it is something it never does (${failed.blockedBy})` : "a safety rule stops it"}. Set the screen up yourself with “Retake guided”.` };
  if (failed?.code === "cancelled") return { cause: "stopped", error: "You stopped the capture, so nothing else was changed." };
  if (failed?.id === "knowledge-add-url") return { cause: "automation-failed", error: "The product did not accept the website address (it allows a public website only up to two levels deep, and its Add button stays off), so no knowledge was added. Use “Retake guided”, or add a website yourself." };
  return { cause: "automation-failed", error: `The computer could not ${label.toLowerCase()}${failed?.why ? ` (${failed.why})` : ""}. Use “Show me once” so it can learn this step, or set the screen up yourself with “Retake guided”.` };
}

/**
 * Whether the agent page has the newer layout's tab strip (Build, Preview, ...), waiting for it to be drawn. A real page can take
 * many seconds, and the waiting never touches the page. The older layout is recognized by its Overview link once that has stayed
 * for a moment (the newer layout's tabs win whenever they are there).
 */
export async function detectLayout(page, { sleep = sleepDefault, waitMs = 10_000, settleMs = 1500 } = {}) {
  const deadline = Date.now() + waitMs;
  let overviewSince = 0;
  for (;;) {
    const [build, preview] = await Promise.all(["Build", "Preview"].map((name) => findControls(page, name, { roles: ["tab"] }).then((list) => list.filter((c) => !c.off).length > 0)));
    if (build && preview) return "newer";
    const overview = (await findControls(page, "Overview", { roles: ["link", "tab", "treeitem", "menuitem"], regions: ["nav"] })).length > 0;
    if (overview) {
      overviewSince = overviewSince || Date.now();
      if (Date.now() - overviewSince >= settleMs) return "classic";
    } else overviewSince = 0;
    if (Date.now() >= deadline) return overview ? "classic" : "unknown";
    await sleep(400);
  }
}

function makeExecutor({ page, session, practice, trace, log, sleep, terms, home, shot, companion, inputs, readiness }) {
  const scratch = scratchState(session);
  const claimOnce = (key) => Boolean(practice?.agentId) && session.registry.claimOnce(practice.agentId, key) === true;
  return createExecutor({ page, autonomy: session.autonomy, product: "copilot-studio", practice, claimOnce, trace, log, sleep, terms, home, shot, companion, inputs: { ...scratch.inputs, ...(inputs || {}) }, answerMs: readiness?.answerMs, onProgress: session.onProgress, shouldStop: session.shouldStop, writeBudget: scratch.budget, effectMs: session.effectMs, findMs: session.findMs });
}

/** The address an agent is opened at: its own base, and the section when the address has one (the classic layout's /overview). */
const addressOf = (parsed) => (parsed.section ? `${parsed.agentBase}/${parsed.section}` : parsed.agentBase);

/**
 * Find the practice agent in the Agents list by its name: search the list, open the agent, and read its address. The name
 * is the practice agent's own (the fixed prefix and a short title), so nothing else is opened.
 * @returns {Promise<{signIn?: object, parsed?: object, failed?: object}>}
 */
async function findAgentByName({ page, session, go, env, name, trace, log, sleep, terms, home, companion, readiness }) {
  const list = await go(`${env.envBase}/agents`, "the list of agents");
  if (list.signIn) return { signIn: list.signIn };
  const practice = { agentId: null, envId: env.envId, creating: (url) => isCreateFlowUrl(url, env.envBase) };
  const executor = makeExecutor({ page, session, practice, trace, log, sleep, terms, home, shot: "find-agent", companion, readiness });
  const found = await executor.run(sanitizeSteps(R.findAgentSteps(name), { product: "copilot-studio" }));
  const parsed = parseCopilotStudioAddress(page.url());
  if (found.ok && UUID.test(parsed.botId || "")) return { parsed };
  return { failed: found };
}

/**
 * Find this lab's practice agent or make it. A failure is remembered for the rest of the job, so a missing Create control
 * is reported once for every shot instead of being tried (and clicked) again and again.
 * @returns {Promise<{ok: true, agent: object}|{ok: false, status: string, cause: string, error: string}>}
 */
export async function ensureScratchAgent(args) {
  const scratch = scratchState(args.session);
  if (scratch.agent) return { ok: true, agent: scratch.agent };
  if (scratch.failure) return scratch.failure;
  const result = await buildScratchAgent(args);
  if (!result.ok && !result.signIn) scratch.failure = result;
  return result;
}

/**
 * The environment a job works in: the one the person chose, or the one the product opens for this account (the first page is a
 * personal home that moves on to the real environment, so the address is waited for, never trusted at once). Remembered on the session.
 * @returns {Promise<{signIn?: object, env?: object}>} `env` is missing when the product opened none
 */
export async function ensureEnvironment({ page, session, go, sleep = sleepDefault }) {
  const chosen = parseCopilotStudioAddress(session.autonomy?.practiceEnvironmentUrl || "");
  let env = chosen;
  if (!env.envBase && session.cs?.envBase) env = parseCopilotStudioAddress(`${session.cs.envBase}/home`);
  if (!env.envBase || isProvisionalEnv(env.envId)) {
    const here = parseCopilotStudioAddress(page.url());
    if (here.envBase && !isProvisionalEnv(here.envId)) env = here;
  }
  if (!env.envBase) {
    const origin = parseCopilotStudioAddress(session.values?.copilotStudioUrl || "").origin || DEFAULT_START.replace(/\/$/, "");
    const opened = await go(`${origin}/`, "Copilot Studio");
    if (opened.signIn) return { signIn: opened.signIn };
    env = await settledEnvironment(page, { sleep });
  }
  if (env.envBase && isProvisionalEnv(env.envId) && !chosen.envBase) {
    // The Agents list of the personal home moves on to the environment the account really opens.
    await go(`${env.envBase}/agents`, "the list of agents");
    env = await settledEnvironment(page, { sleep });
  }
  if (!env.envBase) return {};
  session.cs = { ...(session.cs || {}), envBase: env.envBase };
  return { env };
}

async function buildScratchAgent({ page, session, go, trace = null, log = null, sleep = sleepDefault, terms = [], home = null, companion = "", readiness = {} }) {
  const scratch = scratchState(session);
  const { autonomy, registry } = session;
  if (!autonomy.scratch || !registry) return needsYou("scratch-off", "This job did not allow the computer to build a practice agent.");
  const key = scratch.context.key;

  const found = await ensureEnvironment({ page, session, go, sleep });
  if (found.signIn) return { ok: false, signIn: found.signIn };
  if (!found.env) return needsYou("no-environment", "Copilot Studio did not open an environment for this account, so there is nowhere to build the practice agent. Open Copilot Studio in the companion's window once, or give the environment's address in the consent card.");
  const env = found.env;
  const envId = env.envId;
  const base = { envBase: env.envBase, envId };

  if (autonomy.startFresh && !scratch.retired) {
    scratch.retired = true;
    const count = registry.retire(envId, key);
    if (count) log?.("  Start fresh: the earlier practice agent is left as it is (nothing is deleted), and a new one is built.");
  }

  const existing = registry.find(envId, key);
  if (existing) {
    // A practice agent made while another sign-in was active is not used, and nothing is built in its place: the person decides what happens next.
    if (agentAccountState(existing, session.accountId) === "different") {
      trace?.event("practice-agent-account", { state: "different", scratch: true });
      log?.("  The practice agent from an earlier run was made under a different sign-in, so it is not used.");
      return needsYou("agent-unavailable", AGENT_ACCOUNT_MESSAGE);
    }
    await go(existing.address || `${env.envBase}/bots/${existing.botId}/overview`, "your practice agent");
    const landed = parseCopilotStudioAddress(page.url());
    if (landed.botId && landed.botId.toLowerCase() === String(existing.botId).toLowerCase()) {
      registry.recordReuse(envId, key, { accountId: session.accountId });
      scratch.agent = { ...base, botId: existing.botId, agentBase: landed.agentBase, openUrl: addressOf(landed), name: existing.name, reused: true, createdAt: existing.createdAt };
      trace?.event("practice-agent", { reused: true, scratch: true });
      log?.("  Reusing your practice agent.");
      return { ok: true, agent: scratch.agent };
    }
    registry.retire(envId, key);
    log?.("  The practice agent from an earlier run could not be opened (it may have been deleted), so a new one is built.");
  }

  const name = scratch.context.agentName;
  const lookup = { page, session, go, env, name, trace, log, sleep, terms, home, companion, readiness };
  if (registry.pending(envId, key)) {
    // An earlier run clicked Save and stopped before it wrote the new agent down: never create a second one blindly.
    const adopt = await findAgentByName(lookup);
    if (adopt.signIn) return { ok: false, signIn: adopt.signIn };
    if (adopt.parsed) {
      registry.recordAgent({ ...base, botId: adopt.parsed.botId, name, address: addressOf(adopt.parsed), key, accountId: session.accountId });
      scratch.agent = { ...base, botId: adopt.parsed.botId, agentBase: adopt.parsed.agentBase, openUrl: addressOf(adopt.parsed), name, reused: true };
      log?.("  Found the practice agent that an earlier run started to create, and will use it.");
      return { ok: true, agent: scratch.agent };
    }
    return needsYou("agent-create-failed", "An earlier run started to create the practice agent and stopped before it could write down which one it is, so the computer will not create a second one. Look in your Agents list for one named “Lab screenshots - …”, then choose Start fresh and run the capture again (a new agent is then built; the old one stays until you delete it).");
  }

  // Create it. Nothing exists until the last click, and the registry is written just before it, so a crash after the click cannot lead to a second agent.
  const list = await go(`${env.envBase}/agents`, "the list of agents in your practice environment");
  if (list.signIn) return { ok: false, signIn: list.signIn };
  const at = parseCopilotStudioAddress(page.url());
  if (at.envBase && at.envBase !== env.envBase) return needsYou("no-environment", chosen.envBase ? "Copilot Studio opened a different environment than the one you chose, so the computer did not build anything. Check the environment address in the consent card." : "Copilot Studio moved to a different environment while the computer was getting ready, so it did not build anything. Run the capture again.");
  const practice = { agentId: null, envId, creating: (url) => isCreateFlowUrl(url, env.envBase) };
  const executor = makeExecutor({ page, session, practice, trace, log, sleep, terms, home, shot: "create-agent", companion, readiness });
  const stop = (made) => {
    scratch.halted = { kind: made.haltKind, message: made.halted };
    return needsYou("run-stopped", made.halted);
  };
  const cannot = (what, made) => needsYou("agent-create-failed", `${what} Use “Show me once” to teach it this step, or set the agent up yourself and choose “Use an existing agent”.`, { detail: made.failed?.why || "", diagnostic: made.diagnostic?.file || null });
  const opened = await executor.run(sanitizeSteps(R.CREATE_AGENT_OPEN, { product: "copilot-studio" }));
  if (opened.halted) return stop(opened);
  if (!opened.ok) return cannot("The computer could not find a way to create an agent in this environment. The account may not be allowed to create agents here, or the New agent control was renamed.", opened);
  const filled = await executor.run(sanitizeSteps(R.CREATE_AGENT_FILL, { product: "copilot-studio" }));
  if (filled.halted) return stop(filled);
  if (!filled.ok) return cannot("The computer opened the new agent page but could not find the Name field. Nothing was created.", filled);
  registry.markPending({ envId, key, name });
  const committed = await executor.run(sanitizeSteps(R.CREATE_AGENT_COMMIT, { product: "copilot-studio" }));
  if (committed.halted) return stop(committed);
  const clicked = committed.steps?.some((s) => s.status === "ok");
  // Nothing was created if the Save control was never found or its click was blocked; pending stays only when the click was made.
  if (!clicked) {
    registry.clearPending(envId, key);
    return cannot("The computer named the agent but could not find its Save button. Nothing was created.", committed);
  }
  // The new-agent page can stay on its own address after Save: then the agent is found in the list by its name.
  let created = parseCopilotStudioAddress(page.url());
  for (let tries = 0; tries < 6 && !UUID.test(created.botId || ""); tries += 1) {
    await sleep(1000);
    created = parseCopilotStudioAddress(page.url());
  }
  if (!UUID.test(created.botId || "")) {
    const found = await findAgentByName(lookup);
    if (found.signIn) return { ok: false, signIn: found.signIn };
    if (found.parsed) created = found.parsed;
  }
  if (!UUID.test(created.botId || "")) return needsYou("agent-create-failed", "The computer clicked Save but could not find the new agent afterward, so it stopped. Look in your Agents list for one named “Lab screenshots - …”, then choose Start fresh and run again.", { detail: committed.failed?.why || "" });
  registry.recordAgent({ ...base, botId: created.botId, name, address: addressOf(created), key, accountId: session.accountId });
  registry.recordChange({ botId: created.botId, what: `Created the practice agent “${name}”`, shot: "" });
  scratch.agent = { ...base, botId: created.botId, agentBase: created.agentBase, openUrl: addressOf(created), name, reused: false, createdAt: new Date().toISOString() };
  trace?.event("practice-agent", { reused: false, scratch: true });
  log?.(`  Created the practice agent “${name}”. It is listed in the report at the end of the job.`);
  return { ok: true, agent: scratch.agent };
}

const MAX_LEFTOVER_RESETS = 6;

/**
 * A picture can leave a dialog or menu open (the page is no longer opened again for every picture). Close it the way a person would;
 * only a page that is fully drawn and still shows something that will not close is opened once more, on purpose, and never in a loop.
 */
async function clearLeftovers({ page, session, go, sleep = sleepDefault, trace = null, target }) {
  const scratch = scratchState(session);
  if (!scratch.layout) return false;
  const executor = makeExecutor({ page, session, practice: { agentId: scratch.agent.botId, envId: scratch.agent.envId }, trace, sleep, shot: "clean-start" });
  const cleaned = await executor.cleanup().catch(() => ({ closed: false, left: 0 }));
  if (!cleaned.left || (scratch.leftoverResets || 0) >= MAX_LEFTOVER_RESETS) return false;
  const drawn = await page.evaluate(() => document.readyState === "complete").catch(() => false);
  if (!drawn) return false;
  scratch.leftoverResets = (scratch.leftoverResets || 0) + 1;
  trace?.event("page-recovery", { why: "a dialog or menu from the last picture would not close", resets: scratch.leftoverResets });
  await go(target, "your practice agent", { reload: true });
  return true;
}

/** Open the practice agent's first page and learn which layout it has. */
const LAYOUT_WAIT_MS = 45_000;

/**
 * Make sure the browser is on the practice agent and learn which layout it has. A page already inside the agent is used as it is:
 * opening its address again would restart a page that takes many seconds to draw. The wait for the tabs never touches the page; only
 * after a long quiet wait (the page drew nothing) is it opened once more, on purpose, and at most twice in a job.
 */
export async function openPracticeAgent({ page, session, go, sleep = sleepDefault, trace = null, layoutWaitMs = LAYOUT_WAIT_MS }) {
  const scratch = scratchState(session);
  const agent = scratch.agent;
  const insideAgent = () => {
    const here = parseCopilotStudioAddress(page.url());
    return Boolean(here.botId && here.botId.toLowerCase() === String(agent.botId).toLowerCase());
  };
  const target = agent.openUrl || `${agent.agentBase}/overview`;
  // A page that was just opened gets the whole wait to draw; a page that is already drawn answers at once.
  let fresh = false;
  if (insideAgent()) {
    trace?.event("navigation-skipped", { reason: "open-practice-screen", why: "the browser is already inside the practice agent" });
    fresh = await clearLeftovers({ page, session, go, sleep, trace, target });
  } else {
    const opened = await go(target, "your practice agent");
    if (opened.signIn) return { ok: false, signIn: opened.signIn };
    if (!insideAgent()) return needsYou("agent-create-failed", "The practice agent could not be opened, so the computer stopped. It may have been deleted: choose Start fresh to build a new one.");
    fresh = true;
  }
  let layout = await detectLayout(page, { sleep, waitMs: !fresh && (scratch.layout === "newer" || scratch.layout === "classic") ? Math.min(layoutWaitMs, 20_000) : layoutWaitMs });
  if (layout === "unknown" && (scratch.recoveries || 0) < 2) {
    scratch.recoveries = (scratch.recoveries || 0) + 1;
    trace?.event("page-recovery", { why: "the agent page drew nothing for a long time", waitedMs: layoutWaitMs });
    const again = await go(target, "your practice agent", { reload: true });
    if (again.signIn) return { ok: false, signIn: again.signIn };
    layout = await detectLayout(page, { sleep, waitMs: layoutWaitMs });
  }
  scratch.layout = layout;
  trace?.event("agent-layout", { layout, scratch: true });
  return { ok: true, layout };
}

const STAGE_STEPS = {
  agent: (layout) => (layout === "newer" ? R.tabSteps("Build") : []),
  instructions: (layout) => (layout === "newer" ? [...R.tabSteps("Build"), ...R.SET_INSTRUCTIONS] : [{ id: "overview-nav", action: "open-nav", target: { name: "Overview", within: "nav" } }, ...R.SET_INSTRUCTIONS]),
  knowledge: (layout, scratch) => {
    if (!scratch.context.website) return null;
    return layout === "newer" ? [...R.tabSteps("Build"), ...R.ADD_WEBSITE_KNOWLEDGE] : [{ id: "knowledge-nav", action: "open-nav", target: { name: "Knowledge", within: "nav" } }, ...R.ADD_WEBSITE_KNOWLEDGE];
  },
  publish: (layout) => (layout === "newer" ? [...R.tabSteps("Build"), ...R.PUBLISH_AGENT] : R.PUBLISH_AGENT),
};

/** Why a stage has nothing to do (no website in the lab, or nothing changes the agent). */
const stageSkip = (stage, scratch) => (stage === "knowledge" && !scratch.context.website ? "The lab gives no public website to add as knowledge, so the agent keeps no knowledge source." : null);

/**
 * Bring one stage of the lab into place on the practice agent. A stage already done is skipped.
 * @returns {Promise<{ok: boolean, skipped?: string, ran?: boolean, cause?: string, error?: string, halted?: boolean}>}
 */
export async function prepareStage({ stage, page, session, go, trace = null, log = null, sleep = sleepDefault, terms = [], home = null, companion = "", readiness = {}, shot = "" }) {
  const scratch = scratchState(session);
  const agent = scratch.agent;
  const info = stageById(stage);
  const build = STAGE_STEPS[stage];
  if (!info || !build) return { ok: true, ran: false };
  if (scratch.done.has(stage) || session.registry.stageDone(agent.botId, stage)) {
    scratch.done.add(stage);
    return { ok: true, ran: false };
  }
  // A stage that failed is reported again for every later shot that needs it, and is not tried (and written) again in the same job.
  if (scratch.stageFailures?.[stage]) return scratch.stageFailures[stage];
  const skip = stageSkip(stage, scratch);
  if (skip) return { ok: true, ran: false, skipped: skip };
  const remember = (failure) => {
    scratch.stageFailures = { ...(scratch.stageFailures || {}), [stage]: failure };
    return failure;
  };
  const opened = await openPracticeAgent({ page, session, go, sleep, trace });
  if (!opened.ok) return opened;
  const raw = build(scratch.layout, scratch);
  if (!raw) return { ok: true, ran: false };
  const { steps, missing } = strictSteps(raw);
  if (missing.length) return remember({ ok: false, cause: "blocked-by-safety", error: `${info.label}: a step of this recipe (${missing.join(", ")}) is something the safety rules never allow, so the stage was not run.` });
  const executor = makeExecutor({ page, session, practice: { agentId: agent.botId, envId: agent.envId }, trace, log, sleep, terms, home, shot: shot || `stage-${stage}`, companion, readiness });
  let toRun = steps;
  // A knowledge source that is already listed is not added again: the Build tab is looked at first.
  if (stage === "knowledge" && scratch.layout === "newer") {
    const lead = steps.filter((s) => /^build-tab/.test(s.id));
    const led = await executor.run(lead);
    if (!led.ok) {
      await executor.cleanup().catch(() => {});
      const failure = stepFailure(info.label, led);
      if (failure.halted) scratch.halted = { kind: led.haltKind, message: led.halted };
      return remember({ ok: false, cause: failure.cause, error: `${info.label}: ${failure.error}`, halted: failure.halted === true, diagnostic: led.diagnostic?.file || null });
    }
    if ((await page.evaluate(removableItemsInPage).catch(() => 0)) > 0) {
      scratch.done.add(stage);
      session.registry.markStage(agent.botId, stage);
      return { ok: true, ran: false, skipped: "A knowledge source is already listed, so none is added again." };
    }
    toRun = steps.filter((s) => !/^build-tab/.test(s.id));
  }
  const result = await executor.run(toRun);
  const changed = result.steps.filter((r) => r.status === "ok" && r.tier >= TIER.PRACTICE && r.effect !== "already there");
  for (const r of changed) session.registry.recordChange({ botId: agent.botId, what: r.summary || `${r.action} in the practice agent`, shot });
  if (!result.ok) {
    await executor.cleanup().catch(() => {});
    const failure = stepFailure(info.label, result);
    if (failure.halted) scratch.halted = { kind: result.haltKind, message: result.halted };
    return remember({ ok: false, cause: failure.cause, error: `${info.label}: ${failure.error}`, halted: failure.halted === true, diagnostic: result.diagnostic?.file || null });
  }
  scratch.done.add(stage);
  session.registry.markStage(agent.botId, stage);
  return { ok: true, ran: true };
}

const wordsOf = (shot) => [shot?.caption, shot?.alt, ...(shot?.instructions || []), ...((shot?.callouts || []).map((c) => c.text || c.label))].map((t) => String(t || "").replace(/\*\*/g, "")).join(" ").toLowerCase();

/** The steps that put the screen of a shot into the state its picture shows, on the layout the agent has. */
export function showStepsFor({ stage, shot, layout, website = "" }) {
  const kind = String(shot?.kind || "").toLowerCase();
  const words = wordsOf(shot);
  const dialog = kind === "dialog" || /\bdialog\b/.test(words);
  const newer = layout === "newer";
  const nav = (name, alt = []) => [{ id: `${name.toLowerCase()}-nav`, action: "open-nav", target: { name, alt, within: "nav" } }, { id: `${name.toLowerCase()}-nav-open`, action: "verify", target: { role: "link", name, alt, within: "nav" }, expect: { selected: true }, timeoutMs: 8000 }];
  const outOfScope = /\b(?:out-of-scope|out of scope|decline|declin|redirect|refus)/.test(words);
  switch (stage) {
    case "agent":
      return newer ? R.tabSteps("Build") : nav("Overview");
    case "instructions":
      if (kind === "test-result" || /\b(?:preview tab|ask|question|answer|response)\b/.test(words)) return newer ? [...R.tabSteps("Preview"), ...R.askSteps({ outOfScope })] : R.askSteps({ outOfScope, openTest: true });
      return newer ? R.tabSteps("Build") : nav("Overview");
    case "knowledge":
      return [...(newer ? R.tabSteps("Build") : nav("Knowledge")), ...(dialog ? R.OPEN_ADD_KNOWLEDGE : [])];
    case "tools": {
      const base = newer ? R.tabSteps("Build") : nav("Tools", ["Actions"]);
      if (!dialog) return base;
      const feature = String(shot?.featureId || shot?.feature || "").toLowerCase();
      if (newer && /(?:^|-)skills?$/.test(feature)) return [...base, ...R.OPEN_ADD_SKILL];
      // The Add a tool dialog opens on Featured; the MCP picture is its MCP tab.
      if (newer && /(?:^|-)(?:tools-mcp|mcp-servers?)$/.test(feature)) return [...base, ...R.OPEN_ADD_TOOL, ...R.innerTabSteps(["MCP"], { required: true })];
      return [...base, ...R.OPEN_ADD_TOOL];
    }
    case "model":
      return newer ? [...R.tabSteps("Build"), ...R.OPEN_MODEL_LIST] : null;
    case "preview":
      return newer ? [...R.tabSteps("Preview"), ...R.askSteps({ outOfScope })] : R.askSteps({ outOfScope, openTest: true });
    case "evaluate":
      return [...(newer ? R.tabSteps("Evaluate") : nav("Evaluation", ["Evaluations"])), ...(newer && /\b(?:new evaluation|create (?:an? |your first )?evaluation|data set|dataset|test set|evaluation name)\b/.test(words) ? R.OPEN_NEW_EVALUATION : [])];
    case "publish":
      if (dialog || /\bdialog\b|\bpublish agent\b/.test(words) && !/\b(?:confirmation|success|published)\b/.test(words)) return [...(newer ? R.tabSteps("Build") : []), ...R.OPEN_PUBLISH_DIALOG];
      // Just before the one publish click, the agent must still look built: a knowledge source is listed and the instructions are not the empty placeholder.
      return [...(newer ? R.tabSteps("Build") : []), ...(newer ? [{ id: "publish-built", action: "wait-for", say: "Checking that the agent is built before publishing it", expect: { ...(website ? { removable: true } : {}), absent: ["Instructions guide how your agent responds"] }, timeoutMs: 8000, retries: 0 }] : []), ...R.PUBLISH_AGENT];
    case "monitor":
      return [...(newer ? R.tabSteps("Monitor") : nav("Analytics")), ...(/\b(?:session|transcript|conversation)\b/.test(words) ? R.MONITOR_SESSIONS : [])];
    case "settings":
      if (/\bmemory\b/.test(words)) return [...(newer ? R.tabSteps("Build") : []), ...R.MEMORY_ON];
      if (!newer) return [...nav("Settings"), ...(/\b(?:generative|orchestration)\b/.test(words) ? R.CLASSIC_ORCHESTRATION : [])];
      // The dialog opens on Agent details; a picture of any other setting must name its tab, or it is not guessed.
      if (!R.settingsTabFor(words) && !/\b(?:agent details|identity|schema name|agent settings|settings dialog)\b/.test(words)) return null;
      return [...R.tabSteps("Build"), ...R.OPEN_AGENT_SETTINGS, ...(R.settingsTabFor(words) ? R.innerTabSteps(R.settingsTabFor(words), { required: true }) : [])];
    default:
      return null;
  }
}

/** The stages to bring into place before this shot's own screen. A dialog or the publish step itself leaves its own stage for the shot to show. */
export function stagesToPrepare(stage, shot) {
  const info = stageById(stage);
  if (!info) return [];
  const before = stagesBefore(stage).filter((s) => s.prepares).map((s) => s.id);
  const kind = String(shot?.kind || "").toLowerCase();
  const own = info.prepares && kind !== "dialog" && stage !== "publish" ? [stage] : [];
  return [...before, ...own];
}

/**
 * Everything a shot needs before its picture, on the practice agent. Returns the candidate steps for the shot's own state
 * (the caller runs them with the person's recorded recipe first), or a "needs you" result with a plain reason.
 * @returns {Promise<object>} `{ok: true, passthrough: true}` for a screen this does not handle, `{ok: true, agent, layout, steps, stage}`, or `{ok: false, status, cause, error}`
 */
export async function prepareScratchShot({ page, shot, session, go, trace = null, log = null, sleep = sleepDefault, terms = [], home = null, companion = "", readiness = {}, guided = false }) {
  const scratch = scratchState(session);
  const found = resolveStage(shot);
  if (String(shot.capture?.product || shot.product || "copilot-studio") !== "copilot-studio") return { ok: true, passthrough: true };
  if (!found.scoped && !found.blocker) {
    // A screen the walkthrough does not build (the home page, the Agents list) still needs the real environment, which the product reaches through a personal home first.
    if (!session.cs?.envBase) {
      const environment = await ensureEnvironment({ page, session, go, sleep });
      if (environment.signIn) return { ok: false, signIn: environment.signIn };
    }
    return { ok: true, passthrough: true };
  }
  // A person who sets a screen up themselves ("Retake guided", "Show me once") is not stopped by what the computer cannot do.
  if (found.blocker && !guided) {
    const blocker = BLOCKERS[found.blocker];
    return needsYou(blocker.code, `${blocker.reason} ${blocker.fix}`, { blocker: found.blocker });
  }
  if (!found.scoped) return { ok: true, passthrough: true };
  if (scratch.halted && !guided) return needsYou("run-stopped", `The run stopped earlier: ${scratch.halted.message}`);

  const ensured = await ensureScratchAgent({ page, session, go, trace, log, sleep, terms, home, companion, readiness });
  if (ensured.signIn) return { ok: false, signIn: ensured.signIn };
  if (!ensured.ok) {
    if (ensured.cause === "run-stopped") scratch.halted = scratch.halted || { kind: "unexpected", message: ensured.error };
    return ensured;
  }
  if (scratch.halted && !guided) return needsYou("run-stopped", `The run stopped earlier: ${scratch.halted.message}`);
  for (const stage of stagesToPrepare(found.stage, shot)) {
    const prepared = await prepareStage({ stage, page, session, go, trace, log, sleep, terms, home, companion, readiness, shot: shot.filename });
    if (prepared.signIn) return { ok: false, signIn: prepared.signIn };
    if (!prepared.ok) return needsYou(prepared.cause || "automation-failed", prepared.error, { diagnostic: prepared.diagnostic || null });
    if (prepared.skipped) log?.(`  ${prepared.skipped}`);
  }
  // Sessions on the Monitor tab exist only after a conversation: have one first.
  if (found.stage === "monitor" && !scratch.asked && !session.registry.stageDone(scratch.agent.botId, "conversation")) {
    const opened = await openPracticeAgent({ page, session, go, sleep, trace });
    if (opened.signIn) return { ok: false, signIn: opened.signIn };
    const executor = makeExecutor({ page, session, practice: { agentId: scratch.agent.botId, envId: scratch.agent.envId }, trace, log, sleep, terms, home, shot: shot.filename, companion, readiness });
    const ask = await executor.run(sanitizeSteps(scratch.layout === "newer" ? [...R.tabSteps("Preview"), ...R.askSteps({})] : R.askSteps({ openTest: true }), { product: "copilot-studio" }));
    await executor.cleanup().catch(() => {});
    if (ask.ok) {
      scratch.asked = true;
      session.registry.markStage(scratch.agent.botId, "conversation");
    }
  }
  const opened = await openPracticeAgent({ page, session, go, sleep, trace });
  if (opened.signIn) return { ok: false, signIn: opened.signIn };
  if (!opened.ok) return opened;
  const raw = showStepsFor({ stage: found.stage, shot, layout: scratch.layout, website: scratch.context.website });
  if (!raw) return needsYou("needs-you", scratch.layout === "classic" && found.stage === "model" ? "The classic layout has no model list, so there is nothing to show." : "The computer has not seen how to put this screen on the practice agent in the real product, so it does not guess. Use “Show me once” so it learns the step, or “Retake guided”.");
  const compiled = strictSteps(raw);
  if (compiled.missing.length) return needsYou("blocked-by-safety", `A step for this screen (${compiled.missing.join(", ")}) is something the safety rules never allow, so it was not run. Set the screen up yourself with “Retake guided”.`);
  return { ok: true, agent: scratch.agent, layout: scratch.layout, stage: found.stage, steps: compiled.steps, inputs: scratch.inputs };
}
