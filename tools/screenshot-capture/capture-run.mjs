// Captures one shot the way its plan says (the plan's `capture` descriptor): open the product, go straight to
// the screen with the agent and environment that are known, bring the labels the lab points at into view with
// read-only clicks, wait until the page is really ready, and only then take the picture. Whenever a required
// step cannot be done, the shot stops with a precise reason instead of photographing whatever page happens to
// be open.
//
// Two ways to reach a screen, in this order: its address (the environment and agent come from the capture
// settings, or are learned from where the product sends the browser), and, when the address does not land
// there, the product's own navigation by exact name. Nothing here types, creates, publishes, or deletes.

import fs from "node:fs";
import path from "node:path";

import { buildSidecar, resolveCallouts, sidecarName } from "./callouts.mjs";
import { preparePractice, runShotSetup } from "./autonomous.mjs";
import { prepareScratchShot } from "./scratch.mjs";
import { resolveAutonomy } from "./guard.mjs";
import { briefError, BrowserClosedError, classifyBrowserError, navigateWithSignIn, settleAddress } from "./lifecycle.mjs";
import { recipeKeyForShot, toSharePayload, validateSharedRecipe } from "./recipes.mjs";
import { startRecorder } from "./recorder.mjs";
import { findControls, openNavigationItem, revealLabel } from "./locator.mjs";
import { removeGuidedToolbar, waitForGuidedAction } from "./guided.mjs";
import { readinessBudgets, waitUntilReady } from "./readiness.mjs";
import { collectVisibleLabels } from "./redact.mjs";
import { redactedAddress } from "./auth.mjs";
import {
  COPILOT_STUDIO_SCREENS,
  REQUIREMENTS,
  assessLanding,
  describePage,
  maskedPath,
  missingRequirements,
  parseCopilotStudioAddress,
  targetValuesFromJob,
} from "./targets.mjs";

const DEFAULT_START = "https://copilotstudio.microsoft.com/";
const sleepDefault = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** What a job knows about where it is capturing, shared by every shot of a product in the job. */
export function createCaptureSession({ env = {}, targets = {}, autonomy = null, registry = null, recipes = null, home = null, terms = [], companionVersion = "", writeGapMs = undefined, effectMs = undefined, findMs = undefined } = {}) {
  return {
    values: targetValuesFromJob(env, targets),
    cs: { envBase: null, agentBase: null, agentSource: null },
    // What the computer may do on its own in this job (see guard.mjs), and the local stores it may use.
    autonomy: autonomy || resolveAutonomy(null),
    registry,
    recipes,
    home,
    terms,
    companionVersion,
    practiceAgent: null,
    // Test knobs: how long writes are spaced apart, and how long a click waits for its effect or a control to appear.
    writeGapMs,
    effectMs,
    findMs,
  };
}

function failure(status, cause, error, extra = {}) {
  return { status, cause, error, ...extra };
}

/**
 * Keep what the person showed: the recipe is stored on this computer, and sent to the portal only when the person
 * chose to share it and it passes the same checks the portal runs.
 */
async function saveRecording({ shot, session, recorded, log, trace }) {
  const out = { steps: recorded.steps.length, skipped: recorded.skipped.length, saved: false, shared: false };
  if (!recorded.steps.length) {
    log?.("  Nothing could be recorded from what you did, so the computer has nothing new to learn here.");
    return out;
  }
  const key = recipeKeyForShot(shot);
  const recipe = { key, title: `Set up ${shot.filename}`, steps: recorded.steps };
  if (session.recipes?.put(recipe)) {
    out.saved = true;
    log?.(`  Saved ${recorded.steps.length} step${recorded.steps.length === 1 ? "" : "s"} on this computer. The computer will do this itself next time.`);
  }
  if (session.record?.share && session.shareRecipe) {
    const payload = toSharePayload(recipe);
    const checked = validateSharedRecipe(payload);
    if (!checked.ok) {
      log?.(`  This recipe was not shared: ${checked.errors[0]}`);
    } else {
      try {
        await session.shareRecipe(checked.recipe);
        session.recipes?.markShared(key);
        out.shared = true;
        log?.("  Shared the recipe anonymously (control names only), so every lab can use it.");
      } catch (err) {
        log?.(`  The recipe could not be shared: ${briefError(err)}`);
      }
    }
  }
  trace?.event("recipe-recorded", { shot: shot.filename, steps: out.steps, skipped: out.skipped, shared: out.shared });
  return out;
}

/**
 * Take pictures at the same size in every browser: 1440 by 900 CSS pixels at a device pixel ratio of 1. Windows display
 * scaling (125% or 150%) otherwise makes a window's pictures 1.25 or 1.5 times larger (measured: 1542 by 1362 pixels in Edge
 * at 150%). Setting the viewport turns that scaling off for the page; this looks that it did, writes what it saw to the
 * trace, and sets it once more when it did not.
 */
export async function normalizeViewport(page, viewport, trace = null) {
  if (typeof page.setViewportSize !== "function") return null;
  await page.setViewportSize(viewport).catch(() => {});
  if (typeof page.evaluate !== "function") return null;
  let seen = null;
  try {
    seen = await page.evaluate(() => ({ dpr: window.devicePixelRatio, width: window.innerWidth, height: window.innerHeight }));
  } catch {
    return null;
  }
  if (!seen || typeof seen.dpr !== "number") return null;
  const normalized = Math.abs(seen.dpr - 1) < 0.01 && seen.width === viewport.width && seen.height === viewport.height;
  trace?.event("viewport", { width: seen.width, height: seen.height, dpr: Math.round(seen.dpr * 100) / 100, normalized });
  if (!normalized) {
    await page.setViewportSize({ width: viewport.width + 1, height: viewport.height }).catch(() => {});
    await page.setViewportSize(viewport).catch(() => {});
  }
  return { ...seen, normalized };
}

function record(steps, entry) {
  steps.push(entry);
  if (steps.length > 14) steps.shift();
  return entry;
}

const NEWER_LAYOUT_TABS = Object.freeze(["Build", "Preview", "Evaluate", "Monitor"]);
/** In the newer agent layout only these screens are tabs. The other classic screens are cards on Build, not pages of their own. */
const NEWER_LAYOUT_SCREEN_TAB = Object.freeze({ overview: "Build", evaluations: "Evaluate", analytics: "Monitor" });

/**
 * Whether an agent page has the newer layout's tab strip (Build, Preview, Evaluate, Monitor), and which tab is open.
 * Measured on a real agent: an address such as `.../knowledge` is kept in the address bar but the page shows Build, so
 * the address alone cannot prove which screen is showing. Only control roles and names are read, never page text.
 */
export async function readAgentTabs(page) {
  let present = 0;
  let open = null;
  for (const name of NEWER_LAYOUT_TABS) {
    const found = (await findControls(page, name, { roles: ["tab"] })).filter((c) => !c.off);
    if (!found.length) continue;
    present += 1;
    if (!open && found.some((c) => c.selected)) open = name;
  }
  return present === NEWER_LAYOUT_TABS.length ? { newer: true, open } : { newer: false, open: null };
}

/** In the newer layout, open the tab the screen belongs to. `classicOnly` is true for a screen that has no page there. */
async function alignAgentLayout({ page, screen, sleep, trace, steps, readiness, shot }) {
  // The tab strip is drawn after the address settles: look once the page has been still.
  await waitUntilReady(page, { budgets: readinessBudgets(readiness), sleep, trace, shot });
  const layout = await readAgentTabs(page);
  if (!layout.newer) return null;
  const tab = NEWER_LAYOUT_SCREEN_TAB[screen.id];
  trace?.event("agent-layout", { layout: "newer", screen: screen.id, tab: tab || null, open: layout.open });
  if (!tab) return { newer: true, classicOnly: true, open: layout.open };
  if (layout.open !== tab) {
    const step = await openNavigationItem(page, tab, { roles: ["tab"], regions: ["nav", "header"], sleep, trace, action: "navigate" });
    record(steps, step);
  }
  return { newer: true, classicOnly: false, open: tab };
}

const newerLayoutMessage = (screen) =>
  `This agent uses the newer Copilot Studio layout (Build, Preview, Evaluate, and Monitor tabs), which has no separate ${screen.short} page: the picture would show the Build tab instead. Use “Retake guided”, or “Show me once” so the computer learns this screen.`;

const needMessage = (ids) => {
  const nouns = ids.map((id) => REQUIREMENTS[id]?.noun).filter(Boolean);
  const list = nouns.length > 1 ? `${nouns.slice(0, -1).join(", ")} and ${nouns.at(-1)}` : nouns[0] || "an address";
  return `This screenshot needs your ${list}. Add it in Capture settings, then retake.`;
};

/** Open a Copilot Studio screen. Returns `{ok, ...}` or a failure result. */
async function openCopilotStudio({ page, shot, session, env, effectiveMode, gate, trace, log, sleep, steps, controlOptions }) {
  const capture = shot.capture;
  const screen = COPILOT_STUDIO_SCREENS[capture.route.screen];
  const cs = session.cs;
  const agentCfg = parseCopilotStudioAddress(session.values.copilotStudioAgentUrl || "");
  const envCfg = parseCopilotStudioAddress(session.values.copilotStudioUrl || "");
  if (!cs.envBase) cs.envBase = agentCfg.envBase || envCfg.envBase || null;
  if (!cs.agentBase && (agentCfg.agentBase || envCfg.agentBase)) {
    cs.agentBase = agentCfg.agentBase || envCfg.agentBase;
    cs.agentSource = "address";
  }
  const origin = agentCfg.origin || envCfg.origin || DEFAULT_START.replace(/\/$/, "");
  const go = async (url, label) => {
    log?.(`  → Opening ${redactedAddress(url)}`);
    const before = maskedPath(page.url());
    const nav = await navigateWithSignIn({ page, url, gate, sleep, trace, log, reason: "open-copilot-studio-screen" });
    if (!nav.ok) return { signIn: nav.signIn };
    const after = await settleAddress(page, { sleep });
    record(steps, { action: "open", label, ok: true, found: true, urlBefore: before, urlAfter: maskedPath(after) });
    return { url: after };
  };

  // 1. The environment: learn it from where the product sends the browser when it is not configured.
  if (!cs.envBase) {
    const opened = await go(envCfg.ok ? `${origin}/` : DEFAULT_START, "Copilot Studio");
    if (opened.signIn) return { signIn: opened.signIn };
    const learned = parseCopilotStudioAddress(opened.url);
    if (learned.envBase) cs.envBase = learned.envBase;
    else if (effectiveMode === "auto") {
      return failure("failed", "navigation-failed", "Copilot Studio did not open an environment. Check that you are signed in, or add your environment address in Capture settings.", { currentUrl: maskedPath(opened.url) });
    }
  }

  // 2. The agent, for an agent screen: its address, or its name from the Agents list.
  if (screen.scope === "agent" && !cs.agentBase) {
    const name = session.values.copilotStudioAgentName;
    if (name && cs.envBase) {
      const list = await go(`${cs.envBase}/agents`, "the list of agents");
      if (list.signIn) return { signIn: list.signIn };
      await waitUntilReady(page, { budgets: readinessBudgets(controlOptions.readiness), sleep, trace, shot: shot.filename });
      const links = (await findControls(page, name, { roles: ["link"], regions: ["main", "other"] })).filter((c) => !c.off);
      const entry = { action: "open-agent", label: name.length > 60 ? `${name.slice(0, 57)}...` : name, found: links.length > 0, ok: false, urlBefore: maskedPath(page.url()), urlAfter: maskedPath(page.url()), tried: 0 };
      record(steps, entry);
      if (!links.length) {
        if (effectiveMode === "auto") return failure("failed", "agent-not-found", `No agent named “${name}” was found in this environment. Check the agent name in Capture settings; it must match exactly.`, { currentUrl: maskedPath(page.url()) });
      } else {
        entry.tried = 1;
        await links[0].locator.click({ timeout: 4000 }).catch((err) => {
          if (classifyBrowserError(err) === "browser-closed") throw new BrowserClosedError();
        });
        const landed = await settleAddress(page, { sleep });
        const parsed = parseCopilotStudioAddress(landed);
        entry.urlAfter = maskedPath(landed);
        if (parsed.agentBase) {
          cs.agentBase = parsed.agentBase;
          cs.agentSource = "name";
          entry.ok = true;
        } else if (effectiveMode === "auto") {
          return failure("failed", "agent-not-found", `Selecting “${name}” did not open an agent. Add the agent's address in Capture settings instead.`, { currentUrl: maskedPath(landed) });
        }
      }
    } else if (effectiveMode === "auto") {
      return failure("skipped", "no-agent", "No agent is open. Add the agent's address or name in Capture settings, then retake.", { needs: ["copilot-studio-agent"] });
    }
  }

  // 3. The screen itself.
  const wantsAgent = screen.scope === "agent";
  const base = wantsAgent ? cs.agentBase : cs.envBase;
  if (!base) {
    // Guided: the closest page there is. The person opens the rest.
    if (cs.envBase) await go(`${cs.envBase}/agents`, "the list of agents");
    return { ok: true, partial: true };
  }
  const target = `${base}/${screen.paths[0]}`;
  const opened = await go(target, screen.short);
  if (opened.signIn) return { signIn: opened.signIn };
  let landing = assessLanding(opened.url, { ...capture.expect, strict: effectiveMode === "auto" });
  if (landing.state === "mismatch" && wantsAgent && effectiveMode === "auto" && screen.id !== "overview") {
    // The address did not land there: use the product's own navigation, by exact name, inside the navigation.
    for (const label of screen.navLabels || [screen.short]) {
      const step = await openNavigationItem(page, label, { roles: ["link", "tab", "treeitem", "menuitem"], regions: ["nav"], sleep, trace, action: "navigate" });
      record(steps, step);
      if (!step.ok) continue;
      const landed = await settleAddress(page, { sleep });
      landing = assessLanding(landed, { ...capture.expect, strict: true });
      if (landing.state !== "mismatch") break;
    }
  }
  if (landing.state === "mismatch" && effectiveMode === "auto") {
    return failure("failed", "wrong-screen", `The browser ended on ${landing.page}, not ${landing.expected}. ${wantsAgent ? "Check the agent address in Capture settings, or use “Retake guided”." : "Use “Retake guided”."}`, { currentUrl: maskedPath(page.url()), landing });
  }
  const layout = wantsAgent && effectiveMode === "auto" ? await alignAgentLayout({ page, screen, sleep, trace, steps, readiness: controlOptions.readiness, shot: shot.filename }) : null;
  return { ok: true, landing, layout };
}

/** Open a screen that is an address of its own (admin centers, a SharePoint site, a project). */
async function openAddress({ page, shot, env, gate, trace, log, sleep, steps }) {
  const route = shot.capture.route;
  const override = route.urlEnv ? env?.[route.urlEnv] : null;
  const url = override && /^https:\/\/\S+$/.test(override) ? override : route.url;
  if (!url || !/^https:\/\//i.test(url)) return { ok: true, partial: true };
  log?.(`  → Opening ${redactedAddress(url)}`);
  const before = maskedPath(page.url());
  const nav = await navigateWithSignIn({ page, url, gate, sleep, trace, log, reason: "open-product-address" });
  if (!nav.ok) return { signIn: nav.signIn };
  const landed = await settleAddress(page, { sleep });
  record(steps, { action: "open", label: shot.capture.path?.[0] || "the page", ok: true, found: true, urlBefore: before, urlAfter: maskedPath(landed) });
  let expect = shot.capture.expect;
  if (override && expect) {
    try {
      expect = { ...expect, host: new URL(override).host };
    } catch {
      // Keep the plan's own host.
    }
  }
  return { ok: true, landing: assessLanding(landed, expect ? { ...expect, strict: true } : null) };
}

/**
 * Capture one shot from its `capture` descriptor.
 * @param {object} options
 * @param {object} options.page
 * @param {object} options.shot a plan shot with `capture`
 * @param {object} options.session `createCaptureSession()`: what the job knows (settings, the learned agent)
 * @param {"auto"|"guided"} options.effectiveMode how this shot is run now
 * @param {object} options.gate the sign-in gate for the product
 * @param {(bytes: Buffer, ext: string) => {ok: boolean, reason?: string, bytes?: number}} options.verifyBuffer
 */
export async function runCaptureShot({
  page,
  shot,
  session,
  effectiveMode = "auto",
  env = process.env,
  gate,
  assetsDir,
  screenshotsDir,
  hooks = null,
  trace = null,
  log = null,
  sleep = sleepDefault,
  readiness = {},
  guided = {},
  attempt = 1,
  verifyBuffer,
  stepTimeoutMs = 3000,
}) {
  const capture = shot.capture;
  const steps = [];
  const viewport = { width: Number(shot.viewport?.width || 1440), height: Number(shot.viewport?.height || 900) };
  await normalizeViewport(page, viewport, trace);
  const outputFile = path.resolve(assetsDir, shot.filename);
  const needsSignIn = (result) => failure("auth-required", "sign-in", result.error, { code: result.code, currentUrl: redactedAddress(typeof page.url === "function" ? page.url() : ""), executedSteps: steps });
  const done = (result) => ({ executedSteps: steps, ...result });
  const detail = { mode: effectiveMode, path: capture.path || [], screen: capture.screen?.label || null };
  trace?.event("shot-plan", { shot: shot.filename, mode: effectiveMode, classified: capture.mode, screen: capture.screen?.id || null, route: capture.route?.kind || null, attempt });
  const autonomous = effectiveMode === "autonomous";
  const strict = effectiveMode === "auto" || autonomous;
  let setupRun = null;
  const stopSetup = async () => {
    await setupRun?.executor?.cleanup?.().catch(() => {});
  };

  // A page the practice agent needs is reached by address, with the same sign-in check as every other page. From scratch, an address
  // opened a moment ago is not opened again (the real pages take many seconds to draw), and `reload` is the one deliberate way to do it.
  const goTo = async (url, label, { reload = false } = {}) => {
    log?.(`  → ${reload ? "Opening again" : "Opening"} ${redactedAddress(url)}`);
    const before = maskedPath(page.url());
    const nav = await navigateWithSignIn({ page, url, gate, sleep, trace, log, reason: "open-practice-screen", settleMs: session.autonomy?.scratch === true ? 45_000 : 0, reload });
    if (!nav.ok) return { signIn: nav.signIn };
    const after = await settleAddress(page, { sleep });
    record(steps, { action: "open", label, ok: true, found: true, urlBefore: before, urlAfter: maskedPath(after) });
    return { url: after };
  };

  if (gate.failed) return needsSignIn({ error: gate.failed.message, code: gate.failed.code });

  // 0. Autonomous: a shot whose steps need a practice agent runs inside it (found or created), only when this job allows one.
  // Building from scratch goes further: every agent screen of the lab is shown on a practice agent the computer builds itself.
  let practiceInfo = null;
  let practiceError = "";
  let routeSession = session;
  let scratchRun = null;
  const scratchJob = session.autonomy?.scratch === true && String(capture.product || shot.product || "copilot-studio") === "copilot-studio";
  if (scratchJob && (autonomous || effectiveMode === "guided")) {
    const prepared = await prepareScratchShot({ page, shot, session, go: goTo, trace, log, sleep, terms: session.terms, home: session.home, companion: session.companionVersion, readiness, guided: effectiveMode === "guided" });
    if (prepared.signIn) return needsSignIn(prepared.signIn);
    if (!prepared.ok) {
      trace?.event("scratch-stopped", { shot: shot.filename, cause: prepared.cause, blocker: prepared.blocker || "" });
      if (effectiveMode === "guided") log?.(`  ${prepared.error}`);
      else return done(failure("needs-you", prepared.cause, prepared.error, { detail: { ...detail, blocker: prepared.blocker || undefined }, currentUrl: maskedPath(page.url()), diagnostic: prepared.diagnostic ? { failedStep: { diagnostic: prepared.diagnostic } } : null }));
    } else if (!prepared.passthrough) {
      scratchRun = prepared;
      practiceInfo = { ...prepared.agent, ok: true };
      routeSession = { ...session, cs: { envBase: prepared.agent.envBase, agentBase: prepared.agent.agentBase, agentSource: "practice" } };
      detail.practice = { name: prepared.agent.name, reused: prepared.agent.reused === true };
      detail.scratch = { stage: prepared.stage, layout: prepared.layout };
    }
  } else if (autonomous) {
    const prepared = await preparePractice({ page, shot, session, go: goTo, trace, log, sleep, terms: session.terms, home: session.home, companion: session.companionVersion });
    practiceError = prepared.error;
    if (practiceError) log?.(`  ${practiceError}`);
    if (prepared.info) {
      practiceInfo = prepared.info;
      routeSession = { ...session, cs: { envBase: prepared.info.envBase, agentBase: prepared.info.agentBase, agentSource: "practice" } };
      detail.practice = { name: prepared.info.name, reused: prepared.info.reused === true };
    }
  }

  // 1. What this shot cannot do without. A shot that runs in the practice agent does not need the person's own agent.
  if (strict) {
    const needed = autonomous ? [...new Set([...(capture.needs || []), ...(capture.agentNeeds || [])])] : capture.needs;
    const missing = missingRequirements(needed, session.values).filter((id) => !(practiceInfo && id === "copilot-studio-agent"));
    if (missing.length) {
      const cause = REQUIREMENTS[missing[0]]?.cause || "no-address";
      trace?.event("shot-skipped", { shot: shot.filename, cause, needs: missing.join(",") });
      return done(failure("skipped", cause, needMessage(missing), { needs: missing, detail }));
    }
  }

  // 2. Get to the screen. A from-scratch shot is already on the practice agent; its own steps open the screen and prove it by what the page shows.
  const controlOptions = { readiness };
  let opened;
  if (scratchRun) opened = { ok: true, landing: null };
  else if (capture.route?.kind === "copilot-studio") opened = await openCopilotStudio({ page, shot, session: routeSession, env, effectiveMode: strict ? "auto" : effectiveMode, gate, trace, log, sleep, steps, controlOptions });
  else if (capture.route?.kind === "url") opened = await openAddress({ page, shot, env, gate, trace, log, sleep, steps });
  else opened = { ok: true, partial: true };
  if (opened.signIn) return needsSignIn(opened.signIn);
  if (opened.status) return done({ ...opened, detail: { ...detail, ...(opened.detail || {}) } });
  detail.landing = opened.landing ? { state: opened.landing.state, page: opened.landing.page } : null;

  // 3a. Autonomous: put the screen into the state the shot needs (open a dialog, ask the test pane, select a tab).
  if (autonomous) {
    setupRun = await runShotSetup({ page, shot, session, practiceInfo, practiceError, scratch: scratchRun, trace, log, sleep, terms: session.terms, home: session.home, companion: session.companionVersion, readiness });
    detail.setup = setupRun.setup;
    for (const step of setupRun.setup.steps || []) record(steps, { action: step.action, label: step.note || step.id, found: step.status !== "skipped", ok: step.status === "ok", note: step.why || step.strategy || "" });
    if (!setupRun.ok) {
      await stopSetup();
      trace?.event("shot-needs-you", { shot: shot.filename, cause: setupRun.cause, step: setupRun.setup.failedStep?.id || "", layout: opened.layout?.classicOnly ? "newer" : null });
      const layoutHint = opened.layout?.classicOnly ? `This agent uses the newer Copilot Studio layout, which has no separate ${COPILOT_STUDIO_SCREENS[capture.route.screen].short} page. ` : "";
      return done(failure("needs-you", setupRun.cause, `${layoutHint}${setupRun.error}`, { detail, currentUrl: maskedPath(page.url()), diagnostic: setupRun.setup.failedStep ? setupRun.setup : null }));
    }
    detail.landing = detail.landing || null;
  }

  // 3b. Bring the labels the lab points at into view (read-only: a tab, a navigation item).
  if (effectiveMode === "auto") {
    for (const step of capture.reveal || []) {
      const collect = async (p) => (hooks?.collectLabels ? hooks.collectLabels(p) : collectVisibleLabels(p, {}));
      const result = await revealLabel(page, step.label, { required: step.required, collect, sleep, trace, stepTimeoutMs });
      record(steps, result);
      if (!result.ok && step.required) {
        return done(failure("failed", "control-not-found", `Could not find “${step.label}” ${capture.screen?.label ? `on ${capture.screen.label}` : "on the page"}. Use “Retake guided” and open it yourself.`, { currentUrl: maskedPath(page.url()), detail }));
      }
    }
  }

  // 3c. A screen that has no page in the newer agent layout would be a picture of the Build tab. Say so instead of passing it off as the screen.
  if (strict && opened.layout?.classicOnly) {
    const changedScreen = autonomous ? (setupRun?.setup?.steps || []).some((s) => s.status === "ok") : (capture.reveal || []).some((r) => steps.some((s) => s.action === "reveal" && s.ok && s.tried > 0 && s.label === r.label));
    if (!changedScreen) {
      await stopSetup();
      trace?.event("shot-wrong-layout", { shot: shot.filename, screen: capture.screen?.id || null });
      return done(failure("failed", "wrong-screen", newerLayoutMessage(COPILOT_STUDIO_SCREENS[capture.route.screen]), { currentUrl: maskedPath(page.url()), detail }));
    }
  }

  // 4. Guided: the person sets the screen up and captures it. With "Show me once" the computer also learns the steps.
  if (effectiveMode === "guided") {
    const recording = Boolean(session.record);
    const config = {
      title: shot.moduleTitle ? `${String(shot.moduleTitle).slice(0, 60)}: ${shot.filename}` : `Set up ${shot.filename}`,
      lines: recording ? ["Show me once: set the screen up the way you normally would.", "The computer records your clicks, never what you type, so it can do this itself next time.", "Then press Capture this screen."] : capture.guide || [],
    };
    let recorder = null;
    if (recording) recorder = await startRecorder(page, { product: capture.product || shot.product || "", log, sleep, practiceAgentId: session.scratch?.agent?.botId || null }).catch((err) => {
      log?.(`  Recording could not start: ${briefError(err)}`);
      return null;
    });
    log?.(`  Waiting for you in the browser window: set up the screen, then press Capture this screen (${shot.filename}).`);
    // A hook for tests and automation: something that plays the person while the toolbar is shown.
    if (typeof guided.onWaiting === "function") void Promise.resolve(guided.onWaiting({ shot, config, page })).catch(() => {});
    const action = await waitForGuidedAction(page, { config, timeoutMs: guided.timeoutMs ?? 120_000, shouldStop: guided.shouldStop, sleep: guided.sleep || sleep });
    trace?.event("guided-result", { shot: shot.filename, action });
    if (recorder) {
      const recorded = await recorder.stop().catch(() => ({ steps: [], skipped: [] }));
      if (action === "capture") detail.recorded = await saveRecording({ shot, session, recorded, log, trace });
    }
    if (action === "closed") throw new BrowserClosedError();
    if (action === "skip") return done(failure("skipped", "skipped-by-you", "You skipped this screen.", { detail }));
    if (action === "stop") return done(failure("paused", "stopped", "You stopped the capture.", { detail, stopJob: true }));
    if (action === "timeout") return done(failure("needs-you", "needs-you", "Nobody pressed Capture this screen in time, so this screen is waiting for you. Use “Retake guided” when you are at the computer.", { detail, timedOut: true }));
    if (action === "cancelled") return done(failure("cancelled", "stopped", "The job was canceled.", { detail }));
    detail.landing = { ...assessLanding(typeof page.url === "function" ? page.url() : "", { ...capture.expect, strict: false }) };
    try {
      await removeGuidedToolbar(page);
    } catch (err) {
      return done(failure("failed", "unknown", briefError(err), { detail }));
    }
  }

  // 5. Ready, then the picture.
  try {
  const stillSignedIn = await gate.ensureSignedIn(page, { phase: "screenshot" });
  if (!stillSignedIn.ok) return needsSignIn(stillSignedIn);
  // A quiet screen: no blinking caret, no hover tooltip, and nothing half-loaded.
  if (autonomous) await setupRun?.executor?.prepareForCapture({ keepPointer: (setupRun.setup.steps || []).at(-1)?.action === "hover" });
  await waitUntilReady(page, { budgets: readinessBudgets(readiness, attempt), sleep, trace, shot: shot.filename, attempt });

  let callouts = null;
  if (Array.isArray(shot.callouts) && shot.callouts.length && typeof page.getByText === "function") {
    callouts = await resolveCallouts(page, shot.callouts, viewport).catch(() => null);
    if (callouts && screenshotsDir) {
      fs.mkdirSync(screenshotsDir, { recursive: true });
      fs.writeFileSync(path.join(screenshotsDir, sidecarName(shot.filename)), `${JSON.stringify(buildSidecar(shot.filename, viewport, callouts), null, 2)}\n`);
    }
  }
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  if (typeof hooks?.beforeScreenshot === "function") await hooks.beforeScreenshot({ page, shot, viewport, callouts });
  let raw;
  try {
    raw = await page.screenshot({ path: outputFile, fullPage: false });
  } finally {
    if (typeof hooks?.afterScreenshot === "function") await Promise.resolve(hooks.afterScreenshot({ page, shot })).catch(() => {});
  }
  const check = verifyBuffer(Buffer.isBuffer(raw) ? raw : fs.readFileSync(outputFile), path.extname(outputFile));
  if (!check.ok) return done(failure("failed", "blank-page", check.reason, { detail }));
  if (Buffer.isBuffer(raw) && !fs.existsSync(outputFile)) fs.writeFileSync(outputFile, raw);
  record(steps, { action: "screenshot", ok: true, found: true, urlBefore: maskedPath(page.url()), urlAfter: maskedPath(page.url()) });

  const finalUrl = typeof page.url === "function" ? page.url() : null;
  detail.finalPage = finalUrl ? describePage(finalUrl) : null;
  return {
    status: "captured",
    bytes: check.bytes,
    outputPath: shot.outputPath,
    filePath: outputFile,
    capturedAt: new Date().toISOString(),
    finalUrl,
    callouts,
    executedSteps: steps,
    detail,
  };
  } finally {
    // What the steps opened is closed again, so the next screen starts clean.
    await stopSetup();
  }
}
