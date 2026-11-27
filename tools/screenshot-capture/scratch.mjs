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
import { CUSTOMER_CONVERSATION, HARNESS_LABELS, MICROSOFT_COPILOT, STANDARD, isSpecificHarness } from "./harness.mjs";
import { ensureClassicExperience, ensureDefaultExperience, layoutForHarness, proveAgentPage, unprovenMessage, wrongHarness } from "./harness-run.mjs";
import { findControls } from "./locator.mjs";
import { BLOCKERS, practiceAgentName, resolveAutomation, resolveStage, scratchInputs, stageById, stagesBefore, sanitizeScratchContext } from "./walkthrough.mjs";
import { REASONS } from "./automation.mjs";
import { familyKey, familyShowSteps } from "./families.mjs";
import * as R from "./scratch-recipes.mjs";
import { sanitizeSteps } from "./setup-steps.mjs";
import { AGENT_ACCOUNT_MESSAGE, CUSTOMER_AGENT_MESSAGE, agentAccountState } from "./practice.mjs";
import { parseCopilotStudioAddress, sameEnvironment } from "./targets.mjs";

const DEFAULT_START = "https://copilotstudio.microsoft.com/";
const CREATE_AREAS = new Set(["home", "agents", "create", "new"]);
const sleepDefault = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const freshBag = () => ({ done: new Set(), asked: false, stageFailures: undefined, layout: null, recoveries: 0, leftoverResets: 0 });
const bagOf = (scratch) => ({ done: scratch.done, asked: scratch.asked, stageFailures: scratch.stageFailures, layout: scratch.layout, recoveries: scratch.recoveries || 0, leftoverResets: scratch.leftoverResets || 0 });

/**
 * The per-job state of a from-scratch run. There is one practice agent per harness (`agents`), and what was done to an agent (its stages, its layout,
 * whether it was asked a question) belongs to that agent: `agent`, `done`, `layout`, `asked`, and `stageFailures` always describe the agent in use now.
 */
export function scratchState(session) {
  if (!session.scratch) {
    const context = sanitizeScratchContext(session.autonomy?.scratchContext || {});
    session.scratch = { context, inputs: scratchInputs(context), agent: null, agents: {}, failures: {}, bags: new Map(), doneAll: new Set(), halted: null, retired: false, budget: { count: 0, max: 80, gapMs: session.writeGapMs ?? 1500, last: 0 }, ...freshBag() };
  }
  return session.scratch;
}

/** Make an agent the one in use: what was done to the agent that was in use is kept, and what was done to this one is brought back. */
function useAgent(scratch, agent) {
  const prior = scratch.agent;
  if (prior && prior.botId !== agent.botId) scratch.bags.set(prior.botId, bagOf(scratch));
  if (!prior || prior.botId !== agent.botId) Object.assign(scratch, scratch.bags.get(agent.botId) || freshBag());
  scratch.agent = agent;
  return agent;
}

/** A stage of the agent in use is done (and the job's report lists it). */
function markDone(scratch, stage) {
  scratch.done.add(stage);
  scratch.doneAll.add(stage);
}

/** The layout the steps are written for: the harness decides it (Standard is the classic side navigation, the others have the tab strip); an agent with no harness keeps the layout that was read. */
const layoutOf = (scratch) => (isSpecificHarness(scratch.agent?.harness) ? layoutForHarness(scratch.agent.harness) : scratch.layout);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The first page after sign-in can be a personal home that the product moves on from a few seconds later. */
const isProvisionalEnv = (envId) => String(envId || "").startsWith("~");

/** A page of the environment from which the one sanctioned Create flow runs (the Agents list, Home, or the new-agent page before it is saved). */
export function isCreateFlowUrl(url, envBase) {
  const parsed = parseCopilotStudioAddress(url);
  // The environment is what counts, not the host: the classic experience (the preview host) shares the environments of the default address.
  if (!parsed.ok || !envBase || !sameEnvironment(url, envBase)) return false;
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
 *
 * This is the landmark READER for an agent that has no harness (an older plan). An agent that has a harness is proven by `proveAgentPage`
 * (harness-run.mjs), and its layout is a consequence of the harness, never a guess from what the page happened to show.
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
  // One practice agent per harness: the slot a picture needs is the one that is built (once) and used.
  const slot = isSpecificHarness(args.harness) ? args.harness : "any";
  if (scratch.agents[slot]) return { ok: true, agent: useAgent(scratch, scratch.agents[slot]) };
  if (scratch.failures[slot]) return scratch.failures[slot];
  const result = await buildScratchAgent({ ...args, harness: slot === "any" ? null : slot });
  if (!result.ok && !result.signIn) scratch.failures[slot] = result;
  if (result.ok) scratch.agents[slot] = result.agent;
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

async function buildScratchAgent({ page, session, go, trace = null, log = null, sleep = sleepDefault, terms = [], home = null, companion = "", readiness = {}, harness = null }) {
  const scratch = scratchState(session);
  const { autonomy, registry } = session;
  if (!autonomy.scratch || !registry) return needsYou("scratch-off", "This job did not allow the computer to build a practice agent.");
  const key = scratch.context.key;
  const h = isSpecificHarness(harness) ? harness : null;
  if (h === CUSTOMER_CONVERSATION) return needsYou("needs-you", CUSTOMER_AGENT_MESSAGE);
  const chosen = parseCopilotStudioAddress(autonomy.practiceEnvironmentUrl || "");

  const found = await ensureEnvironment({ page, session, go, sleep });
  if (found.signIn) return { ok: false, signIn: found.signIn };
  if (!found.env) return needsYou("no-environment", "Copilot Studio did not open an environment for this account, so there is nowhere to build the practice agent. Open Copilot Studio in the companion's window once, or give the environment's address in the consent card.");
  const env = found.env;
  const envId = env.envId;
  const base = { envBase: env.envBase, envId, harness: h };

  if (autonomy.startFresh && !scratch.retired) {
    scratch.retired = true;
    const count = registry.retire(envId, key);
    if (count) log?.("  Start fresh: the earlier practice agent is left as it is (nothing is deleted), and a new one is built.");
  }

  // The experience the agent is made and opened in: the Classic agent inside the classic experience (after the switch), the Microsoft Copilot agent in the default one.
  const experience = async () => {
    if (h === STANDARD) return ensureClassicExperience({ page, session, go, trace, log, sleep, readiness, deps: session.harnessDeps || null });
    if (h === MICROSOFT_COPILOT) return ensureDefaultExperience({ page, session, go, trace, log, sleep, readiness });
    return { ok: true };
  };
  const experienceFailure = (made) => (made.signIn ? { ok: false, signIn: made.signIn } : needsYou(made.cause || "harness-switch-failed", made.error));
  // The agent's page must PROVE its harness before the agent is used or recorded as that harness.
  const prove = async (waitMs) => {
    if (!h) return { ok: true, proven: null };
    const seen = await proveAgentPage(page, { sleep, waitMs: waitMs ?? session.landmarkMs ?? LAYOUT_WAIT_MS, settleMs: session.landmarkSettleMs ?? 1500 });
    if (!seen) return { ok: false, proven: null, failure: needsYou("harness-unproven", `${unprovenMessage(h)} The practice agent was not used.`) };
    if (seen.harness !== h) return { ok: false, proven: seen.harness, failure: needsYou("wrong-harness", `${wrongHarness(seen.harness, h)} The practice agent was not used.`) };
    return { ok: true, proven: seen.harness, landmarks: seen.landmarks };
  };

  const existing = registry.find(envId, key, h);
  if (!existing && h && registry.findUnrecorded(envId, key)) {
    trace?.event("practice-agent-unrecorded", { harness: h, scratch: true });
    log?.(`  An earlier practice agent has no harness recorded, so it is not used for a ${HARNESS_LABELS[h]} picture. A new one is built.`);
  }
  if (existing) {
    // A practice agent made while another sign-in was active is not used, and nothing is built in its place: the person decides what happens next.
    if (agentAccountState(existing, session.accountId) === "different") {
      trace?.event("practice-agent-account", { state: "different", scratch: true });
      log?.("  The practice agent from an earlier run was made under a different sign-in, so it is not used.");
      return needsYou("agent-unavailable", AGENT_ACCOUNT_MESSAGE);
    }
    const switched = await experience();
    if (!switched.ok) return experienceFailure(switched);
    await go(existing.address || `${env.envBase}/bots/${existing.botId}/overview`, "your practice agent");
    const landed = parseCopilotStudioAddress(page.url());
    if (landed.botId && landed.botId.toLowerCase() === String(existing.botId).toLowerCase()) {
      const proof = await prove(20_000);
      if (!proof.ok) return proof.failure;
      registry.recordReuse(envId, key, { accountId: session.accountId, harness: h });
      const agent = { ...base, botId: existing.botId, agentBase: landed.agentBase, openUrl: addressOf(landed), name: existing.name, reused: true, createdAt: existing.createdAt };
      useAgent(scratch, agent);
      trace?.event("practice-agent", { reused: true, scratch: true, harness: h });
      log?.("  Reusing your practice agent.");
      return { ok: true, agent };
    }
    registry.retire(envId, key, h);
    log?.("  The practice agent from an earlier run could not be opened (it may have been deleted), so a new one is built.");
  }

  const name = practiceAgentName(scratch.context, h);
  const lookup = { page, session, go, env, name, trace, log, sleep, terms, home, companion, readiness };
  if (registry.pending(envId, key, h)) {
    // An earlier run clicked Save and stopped before it wrote the new agent down: never create a second one blindly.
    const adopt = await findAgentByName(lookup);
    if (adopt.signIn) return { ok: false, signIn: adopt.signIn };
    if (adopt.parsed) {
      const proof = await prove(20_000);
      registry.recordAgent({ ...base, harness: proof.proven || null, botId: adopt.parsed.botId, name, address: addressOf(adopt.parsed), key, accountId: session.accountId });
      if (!proof.ok) return proof.failure;
      const agent = { ...base, botId: adopt.parsed.botId, agentBase: adopt.parsed.agentBase, openUrl: addressOf(adopt.parsed), name, reused: true };
      useAgent(scratch, agent);
      log?.("  Found the practice agent that an earlier run started to create, and will use it.");
      return { ok: true, agent };
    }
    return needsYou("agent-create-failed", `An earlier run started to create the practice agent and stopped before it could write down which one it is, so the computer will not create a second one. Look in your Agents list for one named “${name}”, then choose Start fresh and run the capture again (a new agent is then built; the old one stays until you delete it).`);
  }

  // Made inside the experience of its harness, after the switch for a Classic agent. Nothing exists until the last click, and the registry is written just before it, so a crash after the click cannot lead to a second agent.
  const prepared = await experience();
  if (!prepared.ok) return experienceFailure(prepared);
  const list = await go(`${env.envBase}/agents`, "the list of agents in your practice environment");
  if (list.signIn) return { ok: false, signIn: list.signIn };
  const at = parseCopilotStudioAddress(page.url());
  if (at.envBase && !sameEnvironment(page.url(), env.envBase)) return needsYou("no-environment", chosen.envBase ? "Copilot Studio opened a different environment than the one you chose, so the computer did not build anything. Check the environment address in the consent card." : "Copilot Studio moved to a different environment while the computer was getting ready, so it did not build anything. Run the capture again.");
  const practice = { agentId: null, envId, creating: (url) => isCreateFlowUrl(url, env.envBase) };
  const executor = makeExecutor({ page, session, practice, trace, log, sleep, terms, home, shot: "create-agent", companion, readiness, inputs: { agentName: name } });
  const stop = (made) => {
    scratch.halted = { kind: made.haltKind, message: made.halted };
    return needsYou("run-stopped", made.halted);
  };
  const cannot = (what, made) => needsYou("agent-create-failed", `${what} Use “Show me once” to teach it this step, or set the agent up yourself and choose “Use an existing agent”.`, { detail: made.failed?.why || "", diagnostic: made.diagnostic?.file || null });
  // The new-agent flow starts from "More create options": "Agent, Standard" for a Standard practice agent, "Agent, uses Copilot Credits" for a Microsoft Copilot one.
  // NOT VERIFIED on a real tenant: what the flow shows after the option is chosen. The Name field and the Save button that follow must be found, or it stops with the exact step.
  const opened = await R.openCreateFlow({ executor, harness: h, trace, log });
  if (opened.halted) return stop(opened);
  if (!opened.ok) {
    if (opened.via === "create-option") {
      const exact = opened.stage === "menu" ? "open “More create options” on the Agents list" : `choose “${opened.option}” in “More create options”`;
      return cannot(`The computer could not ${exact}. The account may not be allowed to create ${h === STANDARD ? "Standard" : "Microsoft Copilot"} agents here, or the control was renamed. Nothing was created.`, opened);
    }
    return cannot("The computer could not find a way to create an agent in this environment. The account may not be allowed to create agents here, or the New agent control was renamed.", opened);
  }
  const filled = await executor.run(sanitizeSteps(R.CREATE_AGENT_FILL, { product: "copilot-studio" }));
  if (filled.halted) return stop(filled);
  if (!filled.ok) return cannot("The computer opened the new agent page but could not find the Name field. Nothing was created.", filled);
  registry.markPending({ envId, key, name, harness: h });
  const committed = await executor.run(sanitizeSteps(R.CREATE_AGENT_COMMIT, { product: "copilot-studio" }));
  if (committed.halted) return stop(committed);
  const clicked = committed.steps?.some((s) => s.status === "ok");
  // Nothing was created if the Save control was never found or its click was blocked; pending stays only when the click was made.
  if (!clicked) {
    registry.clearPending(envId, key, h);
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
  if (!UUID.test(created.botId || "")) return needsYou("agent-create-failed", `The computer clicked Save but could not find the new agent afterward, so it stopped. Look in your Agents list for one named “${name}”, then choose Start fresh and run again.`, { detail: committed.failed?.why || "" });
  // The new agent's harness is what its page proves, never what was asked for: it is recorded under the proven harness (or with none, when it could not be read).
  const proof = await prove();
  registry.recordAgent({ ...base, harness: proof.proven || null, botId: created.botId, name, address: addressOf(created), key, accountId: session.accountId });
  registry.recordChange({ botId: created.botId, what: `Created the practice agent “${name}”`, shot: "" });
  trace?.event("practice-agent", { reused: false, scratch: true, harness: h, proven: proof.proven || null });
  if (!proof.ok) return proof.failure;
  const agent = { ...base, botId: created.botId, agentBase: created.agentBase, openUrl: addressOf(created), name, reused: false, createdAt: new Date().toISOString() };
  useAgent(scratch, agent);
  log?.(`  Created the practice agent “${name}”. It is listed in the report at the end of the job.`);
  return { ok: true, agent };
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
  const harness = isSpecificHarness(agent.harness) ? agent.harness : null;
  const insideAgent = () => {
    const here = parseCopilotStudioAddress(page.url());
    if (!(here.botId && here.botId.toLowerCase() === String(agent.botId).toLowerCase())) return false;
    // A Standard agent's Settings page (/manage/...) is a full page with its own links and no tab strip: it is not the agent's page the steps start from, so it is left by opening the agent again.
    if (harness === STANDARD) {
      try {
        if (/\/manage(?:\/|$)/i.test(new URL(page.url()).pathname)) return false;
      } catch {
        return false;
      }
    }
    return true;
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
  const waitMs = !fresh && (scratch.layout === "newer" || scratch.layout === "classic") ? Math.min(layoutWaitMs, 20_000) : layoutWaitMs;
  if (harness) {
    // The agent has a harness: the landmarks PROVE the page is in it (the layout is then a consequence of the harness, never a guess from what opened).
    const read = () => proveAgentPage(page, { sleep, waitMs: session.landmarkMs ?? waitMs, settleMs: session.landmarkSettleMs ?? 1500 });
    let seen = await read();
    if (!seen && (scratch.recoveries || 0) < 2) {
      scratch.recoveries = (scratch.recoveries || 0) + 1;
      trace?.event("page-recovery", { why: "the agent page drew nothing for a long time", waitedMs: layoutWaitMs });
      const again = await go(target, "your practice agent", { reload: true });
      if (again.signIn) return { ok: false, signIn: again.signIn };
      seen = await read();
    }
    trace?.event("harness-proof", { wanted: harness, found: seen?.harness || null, scratch: true });
    if (!seen) return needsYou("harness-unproven", `${unprovenMessage(harness)} The practice agent was not used.`);
    if (seen.harness !== harness) return needsYou("wrong-harness", `${wrongHarness(seen.harness, harness)} The practice agent was not used.`);
    scratch.layout = layoutForHarness(harness);
    trace?.event("agent-layout", { layout: scratch.layout, harness, scratch: true });
    return { ok: true, layout: scratch.layout, harness, landmarks: seen.landmarks };
  }
  let layout = await detectLayout(page, { sleep, waitMs });
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
  instructions: (layout, scratch) => {
    if (layout === "newer") return [...R.tabSteps("Build"), ...R.SET_INSTRUCTIONS];
    // A Standard (Classic) agent: the Overview tab, Edit Instructions, the editor, Save (observed on a real tenant on 2026-11-26).
    if (scratch.agent?.harness === STANDARD) return [...R.classicTabSteps("Overview"), ...R.SET_INSTRUCTIONS_CLASSIC];
    return [{ id: "overview-nav", action: "open-nav", target: { name: "Overview", within: "nav" } }, ...R.SET_INSTRUCTIONS];
  },
  knowledge: (layout, scratch) => {
    if (!scratch.context.website) return null;
    return layout === "newer" ? [...R.tabSteps("Build"), ...R.ADD_WEBSITE_KNOWLEDGE] : [{ id: "knowledge-nav", action: "open-nav", target: { name: "Knowledge", within: "nav" } }, ...R.ADD_WEBSITE_KNOWLEDGE];
  },
  publish: (layout) => (layout === "newer" ? [...R.tabSteps("Build"), ...R.PUBLISH_AGENT] : R.PUBLISH_AGENT),
  // One sample test set, saved and never run. The Evaluate tab is opened first and looked at: a test set that is already there is not added again.
  testset: (layout) => (layout === "newer" ? [...R.tabSteps("Evaluate"), ...R.CREATE_TEST_SET] : [{ id: "evaluation-nav", action: "open-nav", target: { name: "Evaluation", alt: ["Evaluations"], within: "nav" } }, ...R.CREATE_TEST_SET]),
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
    markDone(scratch, stage);
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
  // A write on a Standard (Classic) agent whose dialog or form has not been seen on a real tenant is not guessed: the stage ends as Needs you with the exact reason.
  if (agent.harness === STANDARD) {
    const gap = classicGapFor({ stage });
    if (gap) return remember({ ok: false, cause: "needs-you", error: `${info.label}: ${gap}` });
  }
  const opened = await openPracticeAgent({ page, session, go, sleep, trace });
  if (!opened.ok) return opened;
  const raw = build(layoutOf(scratch), scratch);
  if (!raw) return { ok: true, ran: false };
  const { steps, missing } = strictSteps(raw);
  if (missing.length) return remember({ ok: false, cause: "blocked-by-safety", error: `${info.label}: a step of this recipe (${missing.join(", ")}) is something the safety rules never allow, so the stage was not run.` });
  const executor = makeExecutor({ page, session, practice: { agentId: agent.botId, envId: agent.envId }, trace, log, sleep, terms, home, shot: shot || `stage-${stage}`, companion, readiness });
  let toRun = steps;
  // A knowledge source that is already listed is not added again: the Build tab is looked at first.
  if (stage === "knowledge" && layoutOf(scratch) === "newer") {
    const lead = steps.filter((s) => /^build-tab/.test(s.id));
    const led = await executor.run(lead);
    if (!led.ok) {
      await executor.cleanup().catch(() => {});
      const failure = stepFailure(info.label, led);
      if (failure.halted) scratch.halted = { kind: led.haltKind, message: led.halted };
      return remember({ ok: false, cause: failure.cause, error: `${info.label}: ${failure.error}`, halted: failure.halted === true, diagnostic: led.diagnostic?.file || null });
    }
    if ((await page.evaluate(removableItemsInPage).catch(() => 0)) > 0) {
      markDone(scratch, stage);
      session.registry.markStage(agent.botId, stage);
      return { ok: true, ran: false, skipped: "A knowledge source is already listed, so none is added again." };
    }
    toRun = steps.filter((s) => !/^build-tab/.test(s.id));
  }
  // A test set that is already listed is not added again: the Evaluate tab is looked at first, and the empty state ("Create your first evaluation") is the only time one is added.
  if (stage === "testset") {
    const lead = steps.filter((s) => /^(?:evaluate-tab|evaluation-nav)/.test(s.id));
    const led = await executor.run(lead);
    if (!led.ok) {
      await executor.cleanup().catch(() => {});
      const failure = stepFailure(info.label, led);
      if (failure.halted) scratch.halted = { kind: led.haltKind, message: led.halted };
      return remember({ ok: false, cause: failure.cause, error: `${info.label}: ${failure.error}`, halted: failure.halted === true, diagnostic: led.diagnostic?.file || null });
    }
    // Only looked for, never clicked here: the button is named "Create ...", which the off-limits list covers, so its presence is read without that filter.
    const empty = (await findControls(page, "Create your first evaluation", { roles: ["button"] }).catch(() => [])).length > 0;
    if (!empty) {
      markDone(scratch, stage);
      session.registry.markStage(agent.botId, stage);
      return { ok: true, ran: false, skipped: "A test set is already listed, so none is added again." };
    }
    toRun = steps.filter((s) => !lead.includes(s));
  }
  const result = await executor.run(toRun);
  const changed = result.steps.filter((r) => r.status === "ok" && r.tier >= TIER.PRACTICE && r.effect !== "already there");
  for (const r of changed) session.registry.recordChange({ botId: agent.botId, what: r.summary || `${r.action} in the practice agent`, shot });
  if (!result.ok) {
    // A Standard Instructions editor left open with text in it is closed without saving (Cancel, then Discard on the confirmation), so the next screen starts clean.
    if (stage === "instructions" && agent.harness === STANDARD && !result.halted) await executor.run(sanitizeSteps(R.ABANDON_INSTRUCTIONS_EDIT, { product: "copilot-studio" })).catch(() => {});
    await executor.cleanup().catch(() => {});
    const failure = stepFailure(info.label, result);
    if (failure.halted) scratch.halted = { kind: result.haltKind, message: result.halted };
    return remember({ ok: false, cause: failure.cause, error: `${info.label}: ${failure.error}`, halted: failure.halted === true, diagnostic: result.diagnostic?.file || null });
  }
  markDone(scratch, stage);
  session.registry.markStage(agent.botId, stage);
  return { ok: true, ran: true };
}

const wordsOf = (shot) => [shot?.caption, shot?.alt, ...(shot?.instructions || []), ...((shot?.callouts || []).map((c) => c.text || c.label))].map((t) => String(t || "").replace(/\*\*/g, "")).join(" ").toLowerCase();

/**
 * The steps that put the screen of a shot into the state its picture shows. The harness decides which steps: the Standard (Classic) harness has
 * the side navigation (classic steps), the Microsoft Copilot and Customer Conversation harnesses have the tab strip (tab steps). `layout` is
 * only for a caller that has no harness (an older plan).
 */
export function showStepsFor({ stage, shot, layout, harness = null, website = "" }) {
  const kind = String(shot?.kind || "").toLowerCase();
  const words = wordsOf(shot);
  const dialog = kind === "dialog" || /\bdialog\b/.test(words);
  const newer = isSpecificHarness(harness) ? harness !== STANDARD : layout === "newer";
  // A Standard (Classic) agent has the tab strip (Overview, Knowledge, Tools, Agents, Topics, and Activity, Evaluation, Monitor, Channels behind the overflow at a narrower window);
  // only an agent with no harness recorded (an older plan) may still have the side navigation of an older classic build.
  const standard = harness === STANDARD;
  const nav = (name, alt = []) => (standard ? R.classicTabSteps(name, { alt }) : [{ id: `${name.toLowerCase()}-nav`, action: "open-nav", target: { name, alt, within: "nav" } }, { id: `${name.toLowerCase()}-nav-open`, action: "verify", target: { name, alt, within: "nav" }, expect: { selected: true }, timeoutMs: 8000 }]);
  const outOfScope = /\b(?:out-of-scope|out of scope|decline|declin|redirect|refus)/.test(words);
  const ask = (openTest) => R.askSteps({ outOfScope, openTest, classic: standard });
  switch (stage) {
    case "agent":
      return newer ? R.tabSteps("Build") : nav("Overview");
    case "instructions":
      if (kind === "test-result" || /\b(?:preview tab|ask|question|answer|response)\b/.test(words)) return newer ? [...R.tabSteps("Preview"), ...R.askSteps({ outOfScope })] : ask(true);
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
      // The newer layout has a model button on its Build tab; the Standard Overview tab has a combobox ("Select your agent's model"), opened and left as it is.
      if (standard) return [...nav("Overview"), ...R.CLASSIC_OPEN_MODEL_LIST];
      return newer ? [...R.tabSteps("Build"), ...R.OPEN_MODEL_LIST] : null;
    case "preview":
      return newer ? [...R.tabSteps("Preview"), ...R.askSteps({ outOfScope })] : ask(true);
    case "topics":
      // The Standard Topics tab: opened and shown as it is (the filter tabs and the table are read, nothing is changed).
      return standard ? nav("Topics") : null;
    case "evaluate":
      return [...(newer ? R.tabSteps("Evaluate") : nav("Evaluation", ["Evaluations"])), ...(newer && /\b(?:new evaluation|create (?:an? |your first )?evaluation|data set|dataset|test set|evaluation name)\b/.test(words) ? R.OPEN_NEW_EVALUATION : [])];
    case "publish":
      if (dialog || /\bdialog\b|\bpublish agent\b/.test(words) && !/\b(?:confirmation|success|published)\b/.test(words)) return [...(newer ? R.tabSteps("Build") : []), ...R.OPEN_PUBLISH_DIALOG];
      // Just before the one publish click, the agent must still look built: a knowledge source is listed and the instructions are not the empty placeholder.
      return [...(newer ? R.tabSteps("Build") : []), ...(newer ? [{ id: "publish-built", action: "wait-for", say: "Checking that the agent is built before publishing it", expect: { ...(website ? { removable: true } : {}), absent: ["Instructions guide how your agent responds"] }, timeoutMs: 8000, retries: 0 }] : []), ...R.PUBLISH_AGENT];
    case "monitor":
      return [...(newer ? R.tabSteps("Monitor") : nav("Monitor", ["Analytics"])), ...(!standard && /\b(?:session|transcript|conversation)\b/.test(words) ? R.MONITOR_SESSIONS : [])];
    case "settings":
      if (/\bmemory\b/.test(words)) return standard ? null : [...(newer ? R.tabSteps("Build") : []), ...R.MEMORY_ON];
      // The Standard Settings page is a full page reached from the top bar; its left links are opened by name, and nothing on it is changed.
      if (standard) return [...R.CLASSIC_OPEN_SETTINGS, ...R.classicSettingsLinkSteps(R.classicSettingsLinkFor(words))];
      if (!newer) return [...nav("Settings"), ...(/\b(?:generative|orchestration)\b/.test(words) ? R.CLASSIC_ORCHESTRATION : [])];
      // The dialog opens on Agent details; a picture of any other setting must name its tab, or it is not guessed.
      if (!R.settingsTabFor(words) && !/\b(?:agent details|identity|schema name|agent settings|settings dialog)\b/.test(words)) return null;
      return [...R.tabSteps("Build"), ...R.OPEN_AGENT_SETTINGS, ...(R.settingsTabFor(words) ? R.innerTabSteps(R.settingsTabFor(words), { required: true }) : [])];
    default:
      return null;
  }
}

/**
 * The plain reason a screen of a Standard (Classic) agent is NOT taken: a control or page of it that has not been seen on a real tenant (so no recipe is written, and nothing is guessed),
 * or a screen that belongs to another harness. Null when the screen has a recipe. The lists of what is unseen are in docs/lab-builder.md ("Standard (Classic) capture recipes").
 * @param {{stage: string, shot?: object, family?: object|null}} input
 */
export function classicGapFor({ stage, shot = {}, family = null }) {
  const words = wordsOf(shot);
  const kind = String(shot?.kind || "").toLowerCase();
  const dialog = kind === "dialog" || /\bdialog\b/.test(words);
  // A slot whose recipe cannot be written from what was seen (docs/standard-capture-slots.md): its own exact reason comes first.
  const unseen = R.classicUnseenReason(shot?.filename);
  if (unseen) return `${unseen} Use “Retake guided”, or upload the picture.`;
  if (/\b(?:build tab|preview tab|evaluate tab|monitor tab)\b/.test(words)) return "This screenshot is written for the Build, Preview, Evaluate, and Monitor tabs of the Microsoft Copilot harness, which a Standard (Classic) agent does not have. It is a catalog harness-tag error, so it is not taken in a Standard lab.";
  if (family?.family === "testset" || stage === "testset" || (stage === "evaluate" && /\b(?:new evaluation|create (?:an? |your first )?evaluation|data set|dataset|test set|evaluation name)\b/.test(words)) || (family?.family === "dialog" && family.opener === "evaluation")) {
    return "The new evaluation form of a Standard (Classic) agent has not been seen yet, so the computer does not guess its buttons. Use “Retake guided”, or upload the picture.";
  }
  if (stage === "knowledge" && !dialog) return "The Add knowledge dialog of a Standard (Classic) agent has not been seen yet, so the computer does not guess which controls add a knowledge source. Use “Retake guided”, or upload the picture.";
  if (stage === "monitor" && /\b(?:session|transcript|conversation)\b/.test(words)) return "The sessions list of a Standard (Classic) agent's Monitor page has not been seen yet, so the computer does not guess its controls. Use “Retake guided”, or upload the picture.";
  if (stage === "settings" && /\bmemory\b/.test(words)) return "Memory is a feature of the Microsoft Copilot harness, which a Standard (Classic) agent does not have. It is a catalog harness-tag error, so it is not taken in a Standard lab.";
  if (family?.family === "dialog" && family.opener === "skill") return "The Add skill dialog belongs to the Microsoft Copilot harness. A Standard (Classic) agent's skills are on its Settings page (Skills), which has not been seen yet, so the computer does not guess.";
  return null;
}

/**
 * The stages to bring into place before this shot's own screen. A dialog or the publish step itself leaves its own stage for the shot to show.
 * On a Standard (Classic) agent the Add knowledge stage has no recipe yet (its dialog was never seen), so a picture that does not show knowledge is not held back by it:
 * the test panel, the settings pages, and the tabs are taken without it, and a picture about knowledge ends as Needs you with the exact reason.
 */
export function stagesToPrepare(stage, shot, harness = null) {
  const info = stageById(stage);
  if (!info) return [];
  const standard = harness === STANDARD;
  const showsKnowledge = stage === "knowledge" || /\b(?:knowledge|citations?|cited|sources?)\b/.test(wordsOf(shot));
  const before = stagesBefore(stage).filter((s) => s.prepares).filter((s) => !(standard && s.id === "knowledge" && !showsKnowledge)).map((s) => s.id);
  const kind = String(shot?.kind || "").toLowerCase();
  const own = info.prepares && kind !== "dialog" && stage !== "publish" ? [stage] : [];
  return [...before, ...own];
}

/**
 * Everything a shot needs before its picture, on the practice agent. Returns the candidate steps for the shot's own state
 * (the caller runs them with the person's recorded recipe first), or a "needs you" result with a plain reason.
 * @returns {Promise<object>} `{ok: true, passthrough: true}` for a screen this does not handle, `{ok: true, agent, layout, steps, stage}`, or `{ok: false, status, cause, error}`
 */
export async function prepareScratchShot({ page, shot, session, go, trace = null, log = null, sleep = sleepDefault, terms = [], home = null, companion = "", readiness = {}, guided = false, harness = null }) {
  const scratch = scratchState(session);
  const found = resolveStage(shot);
  if (String(shot.capture?.product || shot.product || "copilot-studio") !== "copilot-studio") return { ok: true, passthrough: true };
  const automation = resolveAutomation(shot);
  // A screen the computer does not take, for one plain reason, is not tried: the same reason the portal showed on the shot's card.
  if (!guided && !found.blocker && automation?.state === "person") {
    const reason = REASONS[automation.reason] || REASONS.unseen;
    return needsYou("needs-you", `${reason.why} Use “Retake guided”, or upload the picture.`, { reason: reason.code });
  }
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
  // A recipe family is a way of taking a screen that was not seen on a real tenant yet (or not in this form): when the same recipe did not work twice in this
  // job, it is not tried again for another shot, so a changed screen costs two tries, never a loop.
  const family = automation?.state === "automatic" && automation.via === "family" ? automation : null;
  const recipeKey = familyKey(family);
  if (recipeKey && !guided && (scratch.familyFailures?.[recipeKey] || 0) >= MAX_RECIPE_FAILURES) {
    return needsYou("needs-you", "The computer tried this kind of screen twice in this job and could not set it up, so it stopped trying instead of guessing. Use “Show me once” so it learns the step, or “Retake guided”.", { reason: "unseen" });
  }
  // A test conversation belongs to the Preview stage whichever feature it shows, and a sample test set to its own stage.
  const stageId = family?.family === "conversation" ? "preview" : family?.family === "testset" ? "testset" : found.stage;

  // The computer builds a Classic agent (after the switch) and a Microsoft Copilot agent, and nothing else: a Customer Conversation agent is the person's.
  if (harness === CUSTOMER_CONVERSATION) return needsYou("needs-you", CUSTOMER_AGENT_MESSAGE);
  // A screen of a Standard (Classic) agent that has no recipe (a control that was never seen on a real tenant) or that belongs to another harness ends here with its exact reason,
  // before anything is built or clicked. A person who sets the screen up (guided) is not stopped.
  const gap = harness === STANDARD && !guided ? classicGapFor({ stage: found.stage, shot, family }) : null;
  if (gap) return needsYou("needs-you", gap, { reason: "standard-unseen" });
  const ensured = await ensureScratchAgent({ page, session, go, trace, log, sleep, terms, home, companion, readiness, harness });
  if (ensured.signIn) return { ok: false, signIn: ensured.signIn };
  if (!ensured.ok) {
    if (ensured.cause === "run-stopped") scratch.halted = scratch.halted || { kind: "unexpected", message: ensured.error };
    return ensured;
  }
  if (scratch.halted && !guided) return needsYou("run-stopped", `The run stopped earlier: ${scratch.halted.message}`);
  for (const stage of stagesToPrepare(stageId, shot, scratch.agent?.harness || harness)) {
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
    const ask = await executor.run(sanitizeSteps(layoutOf(scratch) === "newer" ? [...R.tabSteps("Preview"), ...R.askSteps({})] : R.askSteps({ openTest: true, classic: scratch.agent.harness === STANDARD }), { product: "copilot-studio" }));
    await executor.cleanup().catch(() => {});
    if (ask.ok) {
      scratch.asked = true;
      session.registry.markStage(scratch.agent.botId, "conversation");
    }
  }
  const opened = await openPracticeAgent({ page, session, go, sleep, trace });
  if (opened.signIn) return { ok: false, signIn: opened.signIn };
  if (!opened.ok) return opened;
  // The harness decides the steps (Standard: the side navigation; the others: the tab strip); the layout read from the page is only a fallback for an agent with no harness.
  const stepHarness = isSpecificHarness(scratch.agent.harness) ? scratch.agent.harness : null;
  const planned = family ? familyShowSteps({ automation: family, shot, layout: scratch.layout, harness: stepHarness, stage: found.stage }) : null;
  const raw = family ? planned?.steps || null : showStepsFor({ stage: found.stage, shot, layout: scratch.layout, harness: stepHarness, website: scratch.context.website });
  if (!raw) return needsYou("needs-you", layoutOf(scratch) === "classic" && found.stage === "model" ? "The classic layout has no model list, so there is nothing to show." : "The computer has not seen how to put this screen on the practice agent in the real product, so it does not guess. Use “Show me once” so it learns the step, or “Retake guided”.");
  const compiled = strictSteps(raw);
  if (compiled.missing.length) return needsYou("blocked-by-safety", `A step for this screen (${compiled.missing.join(", ")}) is something the safety rules never allow, so it was not run. Set the screen up yourself with “Retake guided”.`);
  // A family's own steps open, ask, and close: nothing they do may need more than that, whatever the job allows.
  const familyInfo = family
    ? { id: family.family, key: recipeKey, verified: family.verified !== false, review: family.review || "never", landmarks: planned?.landmarks || [], maxTier: Math.min(family.maxTier ?? 1, 1), objects: family.objects || [], note: planned?.note || "", ...(family.panel ? { panel: family.panel } : {}), ...(family.opener ? { opener: family.opener } : {}) }
    : null;
  // `proof` is what the landmarks showed when the practice agent's page was opened for this shot, before any step: a dialog the steps open later can cover the
  // tab strip or the side navigation, and the picture then keeps this proof as long as the page is not found in another harness.
  const proof = opened.landmarks?.length && stepHarness ? { found: stepHarness, landmarks: opened.landmarks } : null;
  return { ok: true, agent: scratch.agent, layout: layoutOf(scratch), harness: stepHarness, proof, stage: found.stage, steps: compiled.steps, inputs: scratch.inputs, family: familyInfo, maxTier: familyInfo ? familyInfo.maxTier : null };
}

/** How many times a recipe family may fail in one job before the computer stops trying it for other shots. */
export const MAX_RECIPE_FAILURES = 2;

/** Remember that a recipe family did not work for a shot in this job (the next shot of the same recipe counts toward the limit). */
export function noteRecipeFailure(session, key) {
  if (!key) return 0;
  const scratch = scratchState(session);
  scratch.familyFailures = { ...(scratch.familyFailures || {}), [key]: (scratch.familyFailures?.[key] || 0) + 1 };
  return scratch.familyFailures[key];
}
