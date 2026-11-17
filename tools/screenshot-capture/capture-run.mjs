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
import { briefError, BrowserClosedError, classifyBrowserError, gotoWithRetry } from "./lifecycle.mjs";
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
export function createCaptureSession({ env = {}, targets = {} } = {}) {
  return { values: targetValuesFromJob(env, targets), cs: { envBase: null, agentBase: null, agentSource: null } };
}

function failure(status, cause, error, extra = {}) {
  return { status, cause, error, ...extra };
}

/** Wait for the address to stop changing (single-page apps redirect after they load), and return it. */
async function settleAddress(page, { sleep = sleepDefault, stableMs = 700, maxMs = 8000, stepMs = 150 } = {}) {
  let last = typeof page.url === "function" ? page.url() : "";
  let stable = 0;
  let waited = 0;
  while (waited < maxMs) {
    await sleep(stepMs);
    waited += stepMs;
    const now = page.url();
    if (now !== last) {
      last = now;
      stable = 0;
    } else {
      stable += stepMs;
      if (stable >= stableMs) break;
    }
  }
  return last;
}

function record(steps, entry) {
  steps.push(entry);
  if (steps.length > 14) steps.shift();
  return entry;
}

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
    await gotoWithRetry(page, url, { sleep, trace, log, waitUntil: "domcontentloaded" });
    const signedIn = await gate.ensureSignedIn(page, { phase: "navigate", target: url });
    if (!signedIn.ok) return { signIn: signedIn };
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
  return { ok: true, landing };
}

/** Open a screen that is an address of its own (admin centers, a SharePoint site, a project). */
async function openAddress({ page, shot, env, gate, trace, log, sleep, steps }) {
  const route = shot.capture.route;
  const override = route.urlEnv ? env?.[route.urlEnv] : null;
  const url = override && /^https:\/\/\S+$/.test(override) ? override : route.url;
  if (!url || !/^https:\/\//i.test(url)) return { ok: true, partial: true };
  log?.(`  → Opening ${redactedAddress(url)}`);
  const before = maskedPath(page.url());
  await gotoWithRetry(page, url, { sleep, trace, log, waitUntil: "domcontentloaded" });
  const signedIn = await gate.ensureSignedIn(page, { phase: "navigate", target: url });
  if (!signedIn.ok) return { signIn: signedIn };
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
  if (typeof page.setViewportSize === "function") await page.setViewportSize(viewport).catch(() => {});
  const outputFile = path.resolve(assetsDir, shot.filename);
  const needsSignIn = (result) => failure("auth-required", "sign-in", result.error, { code: result.code, currentUrl: redactedAddress(typeof page.url === "function" ? page.url() : ""), executedSteps: steps });
  const done = (result) => ({ executedSteps: steps, ...result });
  const detail = { mode: effectiveMode, path: capture.path || [], screen: capture.screen?.label || null };
  trace?.event("shot-plan", { shot: shot.filename, mode: effectiveMode, classified: capture.mode, screen: capture.screen?.id || null, route: capture.route?.kind || null, attempt });

  // 1. What this shot cannot do without.
  if (effectiveMode === "auto") {
    const missing = missingRequirements(capture.needs, session.values);
    if (missing.length) {
      const cause = REQUIREMENTS[missing[0]]?.cause || "no-address";
      trace?.event("shot-skipped", { shot: shot.filename, cause, needs: missing.join(",") });
      return done(failure("skipped", cause, needMessage(missing), { needs: missing, detail }));
    }
  }
  if (gate.failed) return needsSignIn({ error: gate.failed.message, code: gate.failed.code });

  // 2. Get to the screen.
  const controlOptions = { readiness };
  let opened;
  if (capture.route?.kind === "copilot-studio") opened = await openCopilotStudio({ page, shot, session, env, effectiveMode, gate, trace, log, sleep, steps, controlOptions });
  else if (capture.route?.kind === "url") opened = await openAddress({ page, shot, env, gate, trace, log, sleep, steps });
  else opened = { ok: true, partial: true };
  if (opened.signIn) return needsSignIn(opened.signIn);
  if (opened.status) return done({ ...opened, detail: { ...detail, ...(opened.detail || {}) } });
  detail.landing = opened.landing ? { state: opened.landing.state, page: opened.landing.page } : null;

  // 3. Bring the labels the lab points at into view (read-only: a tab, a navigation item).
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

  // 4. Guided: the person sets the screen up and captures it.
  if (effectiveMode === "guided") {
    const config = { title: shot.moduleTitle ? `${String(shot.moduleTitle).slice(0, 60)}: ${shot.filename}` : `Set up ${shot.filename}`, lines: capture.guide || [] };
    log?.(`  Waiting for you in the browser window: set up the screen, then press Capture this screen (${shot.filename}).`);
    // A hook for tests and automation: something that plays the person while the toolbar is shown.
    if (typeof guided.onWaiting === "function") void Promise.resolve(guided.onWaiting({ shot, config, page })).catch(() => {});
    const action = await waitForGuidedAction(page, { config, timeoutMs: guided.timeoutMs ?? 120_000, shouldStop: guided.shouldStop, sleep: guided.sleep || sleep });
    trace?.event("guided-result", { shot: shot.filename, action });
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
  const stillSignedIn = await gate.ensureSignedIn(page, { phase: "screenshot" });
  if (!stillSignedIn.ok) return needsSignIn(stillSignedIn);
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
}
