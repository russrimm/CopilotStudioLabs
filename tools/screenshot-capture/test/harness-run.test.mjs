// The harness as a requirement, without a browser: what the switch to the classic experience may touch, how the landmarks prove a harness, how a shot is
// stopped, stamped, or sent on in each mode, how the practice agent is named and recorded per harness, and the plan and command-line text. The pretend page
// (fake-app-page.mjs) answers the same role and name queries a real page does; the executor is replaced by one that records what it was asked to click, so
// the switch itself is proven against a real page in harness-browser.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createCaptureSession, runCaptureShot } from "../capture-run.mjs";
import { CAUSES } from "../causes.mjs";
import { COMPANION_VERSION, plainOutcome } from "../companion.mjs";
import { dryRunItemsFromJob, dryRunLines } from "../dry-run.mjs";
import { checkFeatureShots } from "../feature-shots-check.mjs";
import { familyShowSteps } from "../families.mjs";
import { authorizeStep, classifyControl, resolveAutonomy, TIER } from "../guard.mjs";
import { HARNESS_MIN_COMPANION, harnessPlan, sanitizeHarnessProof } from "../harness.mjs";
import {
  ensureClassicExperience,
  harnessEvidence,
  harnessGapMessage,
  harnessState,
  orderByHarness,
  proveAgentPage,
  proveHarness,
  readLandmarks,
  unprovenMessage,
  wantedHarness,
  wrongHarness,
} from "../harness-run.mjs";
import { verifyCapturedImageBuffer } from "../lab-runner.mjs";
import { buildPracticeReport, createPracticeRegistry, ensurePracticeAgent, isPracticeName, practiceName } from "../practice.mjs";
import { openPracticeAgent, prepareScratchShot, scratchState, showStepsFor } from "../scratch.mjs";
import { SETUP_ACTIONS, plannedTier, sanitizeSteps } from "../setup-steps.mjs";
import { buildStatus } from "../status.mjs";
import { MAX_AGENT_NAME, practiceAgentName, sanitizeScratchContext, scratchAgentName } from "../walkthrough.mjs";
import { createFakeApp } from "./fixtures/fake-app-page.mjs";
import { makePng } from "./fixtures/png.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.resolve(HERE, "..");
const instant = async () => {};
const ENV = "6b988893-6c74-4e65-9d9a-f7f044be1d08";
const BOT = "0f6c2d9a-3a54-4a64-8c61-5b1d7a2e9c11";
const base = `https://copilotstudio.microsoft.com/environments/${ENV}`;
const agent = `${base}/bots/${BOT}`;

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-run-"));
  t?.after?.(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// ── The switch may touch only its own controls ──────────────────────────────

const control = (name, extra = {}) => ({ name, text: name, aria: "", title: "", role: "button", tag: "button", inNav: true, ...extra });

test("the switch to the classic experience is a look on its own few controls, never on feedback that would be submitted, and never from a plan or a recording", () => {
  const verdict = (name, extra) => classifyControl(control(name, extra), { action: "switch-experience", intent: "choose" });
  for (const name of ["More options", "Open classic experience", "Skip feedback", "New experience"]) {
    const seen = verdict(name);
    assert.deepEqual([seen.tier, seen.category], [TIER.LOOK, "classic-switch"], name);
  }
  assert.equal(verdict("\u2026", { aria: "", role: "button" }).tier, TIER.LOOK, "an ellipsis that has only a glyph for a name is the menu button");
  assert.equal(verdict("...").tier, TIER.LOOK);
  for (const name of ["Submit", "Submit feedback", "Send feedback", "Delete agent", "Publish", "Sign out", "Share"]) {
    assert.equal(verdict(name).tier, TIER.NEVER, `${name} is never clicked as part of the switch`);
  }
  // The same words as another action keep their own rules.
  assert.notEqual(classifyControl(control("Open classic experience"), { action: "open", intent: "open" }).category, "classic-switch");
  // It needs no consent and no practice agent, and it is a look at every level.
  const read = resolveAutonomy(null);
  assert.equal(authorizeStep({ step: { action: "switch-experience" }, desc: control("Skip feedback"), autonomy: read }).allowed, true);
  assert.equal(authorizeStep({ step: { action: "switch-experience" }, desc: control("Submit"), autonomy: read }).allowed, false);

  // A plan, a shared recipe, and a recorded recipe cannot carry the action; the companion's own code can.
  const raw = [{ id: "x", action: "switch-experience", target: { name: "Skip feedback", within: "any" } }];
  assert.ok(!SETUP_ACTIONS.includes("switch-experience"));
  assert.deepEqual(sanitizeSteps(raw, { product: "copilot-studio" }), []);
  assert.equal(sanitizeSteps(raw, { product: "copilot-studio", internal: true })[0].tier, 0);
  assert.equal(plannedTier(raw[0], "copilot-studio"), 0);
  assert.equal(sanitizeSteps([{ id: "x", action: "switch-experience", target: { name: "Submit", within: "any" } }], { product: "copilot-studio", internal: true }).length, 0, "a step on any other control is dropped");
});

// ── Reading the page: which harness do the landmarks prove ──────────────────

const TABS = ["Build", "Preview", "Evaluate", "Monitor"].map((name) => ({ role: "tab", name, region: "nav" }));
const SIDE = ["Overview", "Knowledge", "Tools", "Topics", "Analytics", "Settings"].map((name) => ({ role: "link", name, region: "nav", ...(name === "Overview" ? { selected: true } : {}) }));
const appWith = (controls, extra = {}) =>
  createFakeApp({
    screens: {
      [`${agent}/overview`]: { text: ["Overview"], controls },
      [`${base}/home`]: { text: ["Home"], controls: [{ role: "menuitem", name: "Open classic experience", region: "nav" }, { role: "button", name: "Submit", region: "main" }] },
      ...extra,
    },
    redirects: { "https://copilotstudio.microsoft.com/": `${base}/home` },
  });

test("the landmarks prove the harness: the tab strip is the Microsoft Copilot harness (with Deploy, Customer Conversation), the side navigation is Standard, anything else is not proven", async () => {
  const seen = async (controls) => {
    const app = appWith(controls);
    await app.page.goto(`${agent}/overview`);
    return proveAgentPage(app.page, { sleep: instant, waitMs: 0, settleMs: 0 });
  };
  assert.equal((await seen(TABS)).harness, "microsoft-copilot");
  assert.deepEqual((await seen(TABS)).landmarks, ["Build", "Preview", "Evaluate", "Monitor"]);
  assert.equal((await seen([...TABS, { role: "tab", name: "Deploy", region: "nav" }])).harness, "customer-conversation", "a control named like a write (Deploy) is still read as a landmark");
  const classic = await seen(SIDE);
  assert.equal(classic.harness, "standard");
  assert.deepEqual(classic.landmarks, ["Overview", "Knowledge", "Tools", "Topics", "Analytics"]);
  assert.equal((await seen([...SIDE, ...TABS])).harness, "microsoft-copilot", "the tab strip wins");
  assert.equal(await seen([{ role: "link", name: "Overview", region: "nav" }]), null, "Overview alone is not the classic navigation");
  assert.equal(await seen([]), null);
  // A read that only reads: it never clicks.
  const app = appWith(SIDE);
  await app.page.goto(`${agent}/overview`);
  await readLandmarks(app.page);
  assert.deepEqual(app.log.clicks, []);
});

test("the proof a picture carries is only what was proven, and the portal reads it as it is", () => {
  const proof = harnessEvidence({ id: "standard", landmarks: ["Overview", "Knowledge"], switched: true, wanted: "standard" });
  assert.deepEqual(proof, { version: 1, id: "standard", proof: "landmarks", landmarks: ["Overview", "Knowledge"], switched: true, wanted: "standard" });
  assert.deepEqual(sanitizeHarnessProof(proof), proof);
  assert.equal(harnessEvidence({ id: "standard", landmarks: [], wanted: "standard" }), null, "no landmark, no proof");
  assert.equal(harnessEvidence({ id: null, landmarks: ["Overview"] }), null);
  assert.equal(harnessEvidence({ id: "either", landmarks: ["Overview"] }), null);
  assert.equal(HARNESS_MIN_COMPANION, COMPANION_VERSION, "the version that proves the harness is this one");
});

test("the plain sentences name both harnesses once, and a shot of a product with no harnesses is never held to one", () => {
  assert.equal(wrongHarness("microsoft-copilot", "standard"), "This agent is in the Microsoft Copilot harness; this picture needs the Standard (Classic) harness.");
  assert.equal(wrongHarness("standard", "microsoft-copilot"), "This agent is in the Standard (Classic) harness; this picture needs the Microsoft Copilot harness.");
  assert.equal(wrongHarness("microsoft-copilot", "customer-conversation"), "This agent is in the Microsoft Copilot harness; this picture needs the Customer Conversation harness (preview).");
  assert.match(unprovenMessage("standard"), /^The companion could not tell which harness this agent is in; this picture needs the Standard \(Classic\) harness\. It showed neither/);
  assert.equal(wantedHarness({ harness: "standard" }), "standard");
  assert.equal(wantedHarness({ product: "m365-copilot-hub", harness: "standard" }), null, "no other product has harnesses");
  assert.equal(wantedHarness({ harness: "either" }), null);
  assert.equal(wantedHarness({ harness: null }), null);
  assert.equal(wantedHarness({ harness: "both" }), null, "a shot never says both");
  assert.equal(wantedHarness({ capture: { harness: { id: "standard" } } }), null, "the plan's descriptor is not the shot's own word");
  assert.equal(wantedHarness({ harness: "microsoft-copilot", capture: { product: "copilot-studio" } }), "microsoft-copilot");
});

test("Microsoft Copilot pictures are taken before Standard ones, in their own order, because the switch lasts for the browser session", () => {
  const list = ["s1", "c1", "n1", "s2", "c2"].map((id) => ({ id, harness: id[0] === "s" ? "standard" : id[0] === "c" ? "microsoft-copilot" : null }));
  assert.deepEqual(orderByHarness(list).map((s) => s.id), ["c1", "n1", "c2", "s1", "s2"]);
  assert.deepEqual(orderByHarness(list.map((shot) => ({ shot })), (item) => item.shot).map((i) => i.shot.id), ["c1", "n1", "c2", "s1", "s2"]);
});

// ── Shots ────────────────────────────────────────────────────────────────────

const gateOk = () => ({ failed: null, async ensureSignedIn() { return { ok: true }; } });

function planShot(harness, capture = {}, extra = {}) {
  return {
    filename: "x.png",
    moduleTitle: "Module",
    harness,
    viewport: { width: 1280, height: 720 },
    callouts: [],
    capture: {
      version: 1,
      mode: "auto",
      why: "",
      needs: ["copilot-studio-agent"],
      missing: [],
      ready: true,
      route: { kind: "copilot-studio", screen: "overview", scope: "agent" },
      screen: { id: "overview", label: "the agent's Overview page" },
      path: ["Copilot Studio", "your agent", "Overview"],
      expect: { family: "copilot-studio", scope: "agent", paths: ["overview"], label: "the agent's Overview page", strict: true },
      reveal: [],
      landmarks: [],
      guide: ["Open Overview."],
      ...capture,
    },
    ...extra,
  };
}

/** An executor that records what it is asked to click (the switch itself is proven in a real browser). */
const recorder = () => {
  const calls = [];
  return { calls, deps: { createExecutor: () => ({ run: async (steps) => { calls.push(steps.map((s) => s.id).join("+")); return { ok: true, steps: [], failed: null, halted: null }; }, cleanup: async () => ({ closed: false, left: 0 }) }) } };
};

async function run(t, app, shot, { mode = "auto", targets = {}, agentUrl = `${agent}/overview`, session = null, guided = {}, log = [] } = {}) {
  const dir = tmp(t);
  const env = agentUrl ? { CAPTURE_COPILOT_STUDIO_AGENT_URL: agentUrl } : {};
  return runCaptureShot({
    page: app.page,
    shot,
    session: session || createCaptureSession({ env, targets, landmarkMs: 0, landmarkSettleMs: 0, promptMs: 0, findMs: 50 }),
    effectiveMode: mode,
    env,
    gate: gateOk(),
    assetsDir: path.join(dir, "a"),
    screenshotsDir: path.join(dir, "s"),
    sleep: instant,
    guided,
    log: (line) => log.push(line),
    verifyBuffer: verifyCapturedImageBuffer,
    readiness: { maxMs: 500 },
  });
}

const sessionWith = (harnessDeps, extra = {}) => {
  const session = createCaptureSession({ env: { CAPTURE_COPILOT_STUDIO_AGENT_URL: `${agent}/overview` }, landmarkMs: 0, landmarkSettleMs: 0, promptMs: 0, findMs: 50, ...extra });
  session.harnessDeps = harnessDeps;
  return session;
};

test("a Standard shot switches first, proves the classic landmarks, stamps what it proved, and does not switch again in the same session; a new session switches again", async (t) => {
  const exec = recorder();
  const app = appWith(SIDE);
  const session = sessionWith(exec.deps);
  const log = [];
  const first = await run(t, app, planShot("standard"), { session, log });
  assert.equal(first.status, "captured", first.error);
  assert.deepEqual(exec.calls, ["switch-menu", "switch-item"], "the ellipsis, then Open classic experience; no feedback prompt was shown, so Skip feedback was not clicked");
  assert.equal(app.log.goto[0], `${base}/home`, "the switch starts on the home page, before the agent");
  assert.equal(first.harness.id, "standard");
  assert.equal(first.harness.switched, true);
  assert.equal(first.harness.wanted, "standard");
  assert.deepEqual(first.harness.landmarks, ["Overview", "Knowledge", "Tools", "Topics", "Analytics"]);
  assert.match(log.join("\n"), /Switching to the classic experience: ellipsis in the lower left corner > Open classic experience > Skip feedback/);
  assert.match(log.join("\n"), /Proved the Standard \(Classic\) harness: Overview, Knowledge, Tools, Topics, Analytics/);
  assert.equal(first.detail.harness.proven, "standard");
  assert.match(plainOutcome(first.detail, first.executedSteps, "auto"), /Proved the Standard \(Classic\) harness: Overview, Knowledge, Tools, Topics, Analytics \(switched to the classic experience first\)\./);

  const again = await run(t, app, planShot("standard"), { session });
  assert.equal(again.status, "captured", again.error);
  assert.deepEqual(exec.calls, ["switch-menu", "switch-item"], "the switch is not repeated inside the session, but the landmark was read again");
  assert.equal(again.harness.id, "standard");

  const other = appWith(SIDE);
  const fresh = await run(t, other, planShot("standard"), { session });
  assert.equal(fresh.status, "captured", fresh.error);
  assert.deepEqual(exec.calls, ["switch-menu", "switch-item", "switch-menu", "switch-item"], "a new page is a new browser session: the switch is made again");
});

test("a page in the wrong harness is never saved as a picture of the other: the shot is needs-you with the plain reason, in every automatic mode", async (t) => {
  const exec = recorder();
  const app = appWith(TABS);
  const result = await run(t, app, planShot("standard"), { session: sessionWith(exec.deps) });
  assert.deepEqual([result.status, result.cause], ["needs-you", "wrong-harness"]);
  assert.equal(result.error, "This agent is in the Microsoft Copilot harness; this picture needs the Standard (Classic) harness. Choose a Standard (Classic) agent, or let the computer create one.");
  assert.equal(app.log.screenshots, 0, "nothing was photographed");
  assert.equal(result.harness, undefined);
  assert.equal(result.detail.harness.found, "microsoft-copilot");

  const classicApp = appWith(SIDE);
  const copilot = await run(t, classicApp, planShot("microsoft-copilot"), { session: sessionWith(recorder().deps) });
  assert.deepEqual([copilot.status, copilot.cause], ["needs-you", "wrong-harness"]);
  assert.match(copilot.error, /^This agent is in the Standard \(Classic\) harness; this picture needs the Microsoft Copilot harness\./);
  assert.equal(classicApp.log.screenshots, 0);

  // A page that shows neither is not guessed at.
  const blank = await run(t, appWith([]), planShot("standard"), { session: sessionWith(recorder().deps) });
  assert.deepEqual([blank.status, blank.cause], ["needs-you", "harness-unproven"]);
  assert.match(blank.error, /could not tell which harness this agent is in/);
});

test("a Microsoft Copilot shot never switches; after a Standard shot it goes back to the default experience first", async (t) => {
  const exec = recorder();
  const app = appWith(TABS);
  const session = sessionWith(exec.deps);
  const copilot = await run(t, app, planShot("microsoft-copilot"), { session });
  assert.equal(copilot.status, "captured", copilot.error);
  assert.deepEqual(exec.calls, [], "no switch step was run for a Microsoft Copilot picture");
  assert.equal(copilot.harness.id, "microsoft-copilot");
  assert.equal(copilot.harness.switched, false);
  assert.deepEqual(copilot.harness.landmarks, ["Build", "Preview", "Evaluate", "Monitor"]);
  assert.ok(!app.log.goto.includes("https://copilotstudio.microsoft.com/"), "the default experience was already the one in use");

  harnessState(session, app.page).classic = true;
  const back = await run(t, app, planShot("microsoft-copilot"), { session });
  assert.equal(back.status, "captured", back.error);
  assert.ok(app.log.goto.includes("https://copilotstudio.microsoft.com/"), "the default experience address was opened again");
  assert.equal(harnessState(session, app.page).classic, false);
  assert.deepEqual(exec.calls, []);
});

test("a shot whose module is not written for the lab's harness is never taken, and the other harness is never tried", async (t) => {
  const exec = recorder();
  const app = appWith(SIDE);
  const shot = planShot("standard", {}, { harnessGap: { feature: ["microsoft-copilot"], lab: "standard" } });
  assert.match(harnessGapMessage(shot), /^This module is written for the Microsoft Copilot harness, but this lab is built for the Standard \(Classic\) harness, so its picture cannot be taken in the lab's harness\./);
  for (const mode of ["auto", "guided", "autonomous"]) {
    const result = await run(t, app, shot, { mode, session: sessionWith(exec.deps) });
    assert.deepEqual([result.status, result.cause], ["needs-you", "harness-gap"], mode);
    assert.equal(result.error, harnessGapMessage(shot));
  }
  assert.deepEqual([app.log.goto.length, app.log.screenshots, exec.calls.length], [0, 0, 0], "nothing was opened, clicked, or photographed");
  assert.equal(harnessGapMessage(planShot("standard")), null);
});

test("guided: the person sets the screen up, but the landmarks are read at capture time, a wrong harness is refused, a proven one is stamped, and an unreadable page leaves the stamp out", async (t) => {
  const press = (app) => ({ timeoutMs: 5000, shouldStop: () => false, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), onWaiting: async ({ config }) => { app.config = config; return app.pressToolbar("capture"); } });
  const guidedShot = (harness) => planShot(harness, { mode: "guided", needs: [] });

  const wrong = appWith(TABS);
  const refused = await run(t, wrong, guidedShot("standard"), { mode: "guided", session: sessionWith(recorder().deps), guided: press(wrong) });
  assert.deepEqual([refused.status, refused.cause], ["needs-you", "wrong-harness"]);
  assert.match(refused.error, /^This agent is in the Microsoft Copilot harness; this picture needs the Standard \(Classic\) harness\./);
  assert.equal(wrong.log.screenshots, 0, "never saved as good");
  assert.ok(wrong.config.lines[0].startsWith("This picture needs the Standard (Classic) harness. Switch: ellipsis in the lower left corner > Open classic experience > Skip feedback."), "the person is told how to get there");

  const right = appWith(SIDE);
  const log = [];
  const exec = recorder();
  const stamped = await run(t, right, guidedShot("standard"), { mode: "guided", session: sessionWith(exec.deps), guided: press(right), log });
  assert.equal(stamped.status, "captured", stamped.error);
  assert.equal(stamped.harness.id, "standard");
  assert.deepEqual(exec.calls, ["switch-menu", "switch-item"], "the switch is made for the person first (best effort)");
  assert.equal(right.log.clicks.length, 0, "and nothing is clicked at capture time: the landmarks are only read");

  const nothing = appWith([]);
  const unproven = await run(t, nothing, guidedShot("microsoft-copilot"), { mode: "guided", session: sessionWith(recorder().deps), guided: press(nothing), log });
  assert.equal(unproven.status, "captured", unproven.error);
  assert.equal(unproven.harness, null, "no stamp for a page that could not be read");
  assert.equal(unproven.detail.harness.proven, null);
  assert.match(log.join("\n"), /could not tell which harness this agent is in.*saved without a harness recorded, so the portal sends it to review/s);
});

test("a chosen agent whose Agents list row says it is in another harness is refused before it is opened, with how to fix it", async (t) => {
  const app = createFakeApp({
    screens: {
      [`${base}/agents`]: { text: ["Agents"], poweredBy: { "Energy Assistant": "Microsoft Copilot harness" }, controls: [{ role: "link", name: "Energy Assistant", region: "main", goto: `${agent}/overview` }] },
      [`${base}/home`]: { text: ["Home"], controls: [] },
      [`${agent}/overview`]: { text: ["Overview"], controls: TABS },
    },
    redirects: { "https://copilotstudio.microsoft.com/": `${base}/home` },
  });
  const session = sessionWith(recorder().deps, {});
  session.values = { ...session.values, copilotStudioAgentName: "Energy Assistant", copilotStudioAgentUrl: "" };
  const result = await run(t, app, planShot("standard"), { agentUrl: null, session });
  assert.deepEqual([result.status, result.cause], ["needs-you", "wrong-harness"]);
  assert.equal(result.error, "This agent is in the Microsoft Copilot harness; this picture needs the Standard (Classic) harness. Choose a Standard (Classic) agent, or let the computer create one.");
  assert.ok(!app.log.clicks.includes("Energy Assistant"), "the agent was not opened");
});

test("the switch stops, with a plain reason, when the page offers no way into the classic experience", async (t) => {
  const failing = { createExecutor: () => ({ run: async () => ({ ok: false, steps: [], failed: { id: "switch-menu" }, halted: null }), cleanup: async () => ({}) }) };
  const app = appWith(SIDE);
  const session = sessionWith(failing);
  const out = await ensureClassicExperience({ page: app.page, session, go: async (url) => { await app.page.goto(url); return { url }; }, sleep: instant, deps: failing.deps || failing });
  assert.equal(out.ok, false);
  assert.equal(out.cause, "harness-switch-failed");
  assert.match(out.error, /could not find the ellipsis in the lower left corner/);
  assert.equal(harnessState(session, app.page).classic, false, "nothing is remembered as switched");
  const proof = await proveHarness({ page: app.page, session, wanted: "standard", scope: "agent", allowClicks: false, sleep: instant, waitMs: 0 });
  assert.equal(proof.ok, false, "and a page that is not an agent page proves nothing");
});

// ── The practice agent per harness ──────────────────────────────────────────

test("a practice agent's name carries its harness, is distinct per harness, and never exceeds the 30 characters the product keeps", () => {
  assert.equal(scratchAgentName("Team Assistant", "standard"), "Classic shots - Team Assistant");
  assert.equal(scratchAgentName("Team Assistant", "microsoft-copilot"), "Copilot shots - Team Assistant");
  assert.equal(scratchAgentName("Team Assistant"), "Lab screenshots - Team", "the older name is unchanged");
  const titles = ["Team Assistant", "x".repeat(200), "Cross-industry: Build a Customer Support Agent with Knowledge", "Ops", "Extraordinarily", "A B C D E F G H I J K L"];
  for (const title of titles) {
    const names = ["standard", "microsoft-copilot", "customer-conversation", null].map((h) => scratchAgentName(title, h));
    assert.ok(names.every((n) => n.length <= MAX_AGENT_NAME), `${title.slice(0, 20)}: ${names.map((n) => n.length).join(", ")}`);
    assert.equal(new Set(names).size, 4, "four distinct names");
  }
  const context = sanitizeScratchContext({ labTitle: "Cross-industry: Build a Team Assistant with Create an agent", key: "lab-a" });
  assert.equal(practiceAgentName(context, "standard"), "Classic shots - Team Assistant");
  assert.equal(practiceAgentName(context, "microsoft-copilot"), "Copilot shots - Team Assistant");
  assert.equal(practiceAgentName(context), context.agentName);
  assert.match(practiceName(() => "ab12cd", "standard"), /^Classic shots - ab12cd$/);
  assert.match(practiceName(() => "ab12cd", "microsoft-copilot"), /^Copilot shots - ab12cd$/);
  assert.match(practiceName(() => "ab12cd"), /^Lab screenshots - ab12cd$/);
  assert.ok(practiceName(() => "ffffff", "customer-conversation").length <= MAX_AGENT_NAME);
  for (const name of ["Classic shots - A", "Copilot shots - A", "Lab screenshots - A"]) assert.ok(isPracticeName(name), name);
  assert.equal(isPracticeName("Classic - Sales"), false, "a person's agent that looks similar is not ours");
});

test("the registry looks agents up by environment, lab, and harness; an agent recorded before harnesses is never returned for one; Start fresh can set aside one harness", (t) => {
  const registry = createPracticeRegistry(tmp(t));
  const record = (harness, botId, name) => registry.recordAgent({ envId: "env-1", botId, name, address: `${base}/bots/${botId}/overview`, key: "lab-a", harness });
  registry.recordAgent({ envId: "env-1", botId: "old", name: "Lab screenshots - Team", address: "", key: "lab-a" });
  assert.equal(registry.find("env-1", "lab-a", "standard"), null, "harness not recorded: not reused for a Standard slot");
  assert.equal(registry.find("env-1", "lab-a", "microsoft-copilot"), null);
  assert.equal(registry.find("env-1", "lab-a").botId, "old", "a lookup that names no harness keeps the older behavior");
  assert.equal(registry.findUnrecorded("env-1", "lab-a").botId, "old");

  record("standard", "c1", "Classic shots - Team");
  record("microsoft-copilot", "m1", "Copilot shots - Team");
  assert.equal(registry.find("env-1", "lab-a", "standard").botId, "c1");
  assert.equal(registry.find("env-1", "lab-a", "microsoft-copilot").botId, "m1");
  assert.equal(registry.find("env-1", "lab-b", "standard"), null, "another lab has its own agents");
  assert.equal(registry.find("env-2", "lab-a", "standard"), null, "and another environment");
  assert.equal(registry.items().agents.length, 3, "one record per harness, and the older record stays");

  // A second record for the same harness replaces its own, never another harness's.
  record("standard", "c2", "Classic shots - Team 2");
  assert.deepEqual(registry.items().agents.filter((a) => !a.retired).map((a) => a.botId).sort(), ["c2", "m1", "old"]);

  registry.markPending({ envId: "env-1", key: "lab-a", name: "Classic shots - Team", harness: "standard" });
  assert.ok(registry.pending("env-1", "lab-a", "standard"));
  assert.equal(registry.pending("env-1", "lab-a", "microsoft-copilot"), null, "a create that was started for one harness is not another's");
  registry.clearPending("env-1", "lab-a", "standard");
  assert.equal(registry.pending("env-1", "lab-a", "standard"), null);

  assert.equal(registry.retire("env-1", "lab-a", "standard"), 1, "one harness's agent is set aside");
  assert.equal(registry.find("env-1", "lab-a", "standard"), null);
  assert.equal(registry.find("env-1", "lab-a", "microsoft-copilot").botId, "m1");
  assert.equal(registry.retire("env-1", "lab-a"), 2, "Start fresh with no harness sets aside every harness's agent of the lab");

  const text = buildPracticeReport(registry.items());
  assert.match(text, /Harness: Microsoft Copilot harness/);
  assert.match(text, /Harness: Harness not recorded \(made before harnesses were recorded/);
});

test("an agent made for a harness is proven by its landmarks: a created agent that opens in the other harness is recorded as what it is and not used", async (t) => {
  const registry = createPracticeRegistry(tmp(t));
  const autonomy = resolveAutonomy({ consented: true, level: "practice", practiceEnvironmentUrl: `${base}/home` }, { allowPracticeWrites: true });
  const exec = recorder();
  const newAgent = `${base}/bots/7a1c0001-5b3d-4e6f-8a9b-c0d1e2f3a4b5`;
  const app = createFakeApp({ screens: { [`${base}/agents`]: { text: ["Agents"], controls: [] }, [`${base}/home`]: { text: ["Home"], controls: [{ role: "menuitem", name: "Open classic experience", region: "nav" }] }, [`${newAgent}/overview`]: { text: ["Overview"], controls: TABS } }, redirects: { "https://copilotstudio.microsoft.com/": `${base}/home` } });
  const session = createCaptureSession({ autonomy, registry, agentSource: "created", landmarkMs: 0, landmarkSettleMs: 0, promptMs: 0 });
  session.harnessDeps = exec.deps;
  const go = async (url) => { await app.page.goto(url); return { url }; };
  // The "create" steps end on a Microsoft Copilot agent although a Standard one was asked for.
  const executorFor = () => ({ run: async () => { await app.page.goto(`${newAgent}/overview`); return { ok: true, steps: [] }; } });
  const result = await ensurePracticeAgent({ page: app.page, autonomy, registry, session, executorFor, go, harness: "standard", random: () => "abc123", sleep: instant });
  assert.equal(result.ok, false);
  assert.equal(result.cause, "wrong-harness");
  assert.match(result.error, /^This agent is in the Microsoft Copilot harness; this picture needs the Standard \(Classic\) harness\. The practice agent was not used\./);
  assert.deepEqual(exec.calls, ["switch-menu", "switch-item"], "the Classic agent is made after the switch");
  assert.equal(registry.items().agents[0].name, "Classic shots - abc123");
  assert.equal(registry.find("env-1", undefined, "standard"), null);
  assert.equal(registry.items().agents[0].harness, "microsoft-copilot", "recorded under the harness it was proven to be in, never the one asked for");
  assert.equal(await ensurePracticeAgent({ page: app.page, autonomy, registry, session, executorFor, go, harness: "standard", sleep: instant }).then((r) => r.error), result.error, "the answer is remembered for the rest of the job");
});

test("the recipes choose their steps from the harness, not from a probe: Standard has the side navigation steps, the others the tab steps", () => {
  const shot = { kind: "ui-location", caption: "The agent", alt: "", instructions: [] };
  const ids = (list) => (list || []).map((s) => s.id);
  assert.deepEqual(ids(showStepsFor({ stage: "agent", shot, harness: "standard", layout: "newer" })), ["overview-nav", "overview-nav-open"], "the harness wins over a layout that was read");
  assert.deepEqual(ids(showStepsFor({ stage: "agent", shot, harness: "microsoft-copilot", layout: "classic" })), ["build-tab", "build-tab-open"]);
  assert.deepEqual(ids(showStepsFor({ stage: "agent", shot, harness: "customer-conversation" })), ["build-tab", "build-tab-open"]);
  assert.equal(showStepsFor({ stage: "model", shot, harness: "standard" }), null, "the classic layout has no model list");
  assert.ok(showStepsFor({ stage: "model", shot, harness: "microsoft-copilot" }));
  assert.deepEqual(ids(showStepsFor({ stage: "agent", shot, layout: "classic" })), ["overview-nav", "overview-nav-open"], "a caller with no harness keeps the layout it read");
  const automation = { family: "testset" };
  assert.ok(familyShowSteps({ automation, shot, harness: "standard", stage: "evaluate" }).steps.some((s) => s.id === "evaluation-nav"));
  assert.ok(familyShowSteps({ automation, shot, harness: "microsoft-copilot", stage: "evaluate" }).steps.some((s) => s.id === "evaluate-tab"));
});

test("an agent that was opened is proven before it is used: the wrong harness stops, the right one sets the layout from the harness", async () => {
  const autonomy = resolveAutonomy({ consented: true, level: "scratch", scratchContext: { labTitle: "Team", key: "lab-a" } }, { allowPracticeWrites: true });
  const open = async (controls, harness) => {
    const app = appWith(controls);
    const session = createCaptureSession({ autonomy, registry: {}, landmarkMs: 0, landmarkSettleMs: 0 });
    scratchState(session).agent = { botId: BOT, envBase: base, agentBase: agent, openUrl: `${agent}/overview`, name: "x", harness };
    const go = async (url) => { await app.page.goto(url); return { url }; };
    return openPracticeAgent({ page: app.page, session, go, sleep: instant, layoutWaitMs: 0 });
  };
  const right = await open(SIDE, "standard");
  assert.deepEqual([right.ok, right.layout, right.harness], [true, "classic", "standard"]);
  const copilot = await open(TABS, "microsoft-copilot");
  assert.deepEqual([copilot.ok, copilot.layout], [true, "newer"]);
  const wrong = await open(TABS, "standard");
  assert.deepEqual([wrong.ok, wrong.cause], [false, "wrong-harness"]);
  assert.match(wrong.error, /^This agent is in the Microsoft Copilot harness; this picture needs the Standard \(Classic\) harness\. The practice agent was not used\./);
  const blank = await open([], "standard");
  assert.deepEqual([blank.ok, blank.cause], [false, "harness-unproven"]);
});

test("the computer does not build a Customer Conversation agent: a plain reason, and guided capture carries on", async () => {
  const autonomy = resolveAutonomy({ consented: true, level: "scratch", scratchContext: { labTitle: "Team", key: "lab-a" } }, { allowPracticeWrites: true });
  const session = createCaptureSession({ autonomy, registry: {} });
  const shot = planShot("customer-conversation", {}, { featureId: "mc-create-agent", section: "build", kind: "after", caption: "The agent", product: "copilot-studio" });
  const result = await prepareScratchShot({ page: appWith([]).page, shot, session, go: async () => ({ url: "" }), sleep: instant, harness: "customer-conversation" });
  assert.deepEqual([result.ok, result.cause], [false, "needs-you"]);
  assert.match(result.error, /does not build Customer Conversation agents/);
});

// ── The plan, the dry run, and the command line ─────────────────────────────

test("the dry run prints, for every shot, its harness, the step that gets the page into it, and the landmark that proves it", () => {
  const job = { shots: [{ filename: "a.classic.png", harness: "standard", capture: { product: "copilot-studio" } }, { filename: "b.copilot.png", harness: "microsoft-copilot" }, { filename: "c.png", harness: null }, { filename: "d.png", harness: "standard", harnessGap: { feature: ["microsoft-copilot"], lab: "standard" } }] };
  const text = dryRunLines(dryRunItemsFromJob(job)).join("\n");
  assert.match(text, /a\.classic\.png.*\[Standard \(Classic\) harness\]/);
  assert.match(text, /Harness: Standard \(Classic\) harness\r?\n\s+Switch: ellipsis in the lower left corner > Open classic experience > Skip feedback\./);
  assert.match(text, /Proof before the picture: Side navigation with Overview/);
  assert.match(text, /Harness: Microsoft Copilot harness\r?\n\s+No switch: open https:\/\/copilotstudio\.microsoft\.com\//);
  assert.match(text, /Proof before the picture: The Build, Preview, Evaluate, and Monitor tabs/);
  assert.match(text, /d\.png\r?\n\s+Not taken: This module is written for the Microsoft Copilot harness/);
  assert.equal(harnessPlan("standard").switchStep, "Switch: ellipsis in the lower left corner > Open classic experience > Skip feedback.");
});

const capture = (...args) => spawnSync(process.execPath, ["capture.js", ...args], { cwd: TOOL, encoding: "utf8", timeout: 60_000 });

test("capture.js --harness accepts the five shot-level values, names the harness and the switch for each shot, and refuses anything else", () => {
  for (const value of ["standard", "microsoft-copilot", "customer-conversation", "either", "both"]) {
    const out = capture("--product=copilot-studio", "--list", `--harness=${value}`);
    assert.equal(out.status, 0, `${value}: ${out.stderr}`);
  }
  const bad = capture("--product=copilot-studio", "--list", "--harness=all");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--harness must be standard, microsoft-copilot, customer-conversation, either, or both\./);
  const other = capture("--product=ai-foundry", "--list", "--harness=standard");
  assert.equal(other.status, 1);
  assert.match(other.stderr, /only applies to Copilot Studio/);

  const dry = capture("--product=copilot-studio", "--dry-run", "--harness=standard");
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /harness: Standard \(Classic\) harness\r?\n\s+Switch: ellipsis in the lower left corner > Open classic experience > Skip feedback\./);
  assert.match(dry.stdout, /\.classic\.png/, "the picture is saved under the name that carries its harness");
  assert.match(dry.stdout, /Proof before the picture:/);
  const copilot = capture("--product=copilot-studio", "--dry-run", "--harness=microsoft-copilot");
  assert.match(copilot.stdout, /No switch: open https:\/\/copilotstudio\.microsoft\.com\//);
  assert.match(copilot.stdout, /\.copilot\.png/);
  // A shot kept once per harness is captured only when a variant is named.
  const both = capture("--product=copilot-studio", "--dry-run", "--harness=both");
  assert.match(both.stdout, /skipped unless you pick a harness: --harness=standard or --harness=microsoft-copilot/);
});

const manifestWith = (shots, product = "copilot-studio") => ({
  kind: "feature-tour",
  lab: "feature-tour",
  product,
  authProfile: product,
  startUrl: "https://copilotstudio.microsoft.com/",
  assetsDir: "docs/feature-tour/screenshots",
  shots: shots.map((shot, i) => ({ id: i + 1, feature: "f", featureName: "F", section: "home", caption: "c", navHint: "n", instructions: ["i"], setup: [], callouts: [], ...shot })),
});

test("the shot list check accepts one harness, either, or both, rejects anything else, and looks for each picture under the name that carries its harness", (t) => {
  const root = tmp(t);
  const shots = path.join(root, "docs", "feature-tour", "screenshots");
  fs.mkdirSync(shots, { recursive: true });
  const write = (manifest) => {
    const file = path.join(root, "feature-shots.json");
    fs.writeFileSync(file, JSON.stringify(manifest));
    return checkFeatureShots({ repoRoot: root, manifestPath: file });
  };
  const critical = (result) => result.findings.filter((f) => f.severity === "critical").map((f) => f.message);
  for (const harness of ["standard", "microsoft-copilot", "customer-conversation", "either", "both"]) assert.deepEqual(critical(write(manifestWith([{ filename: "a.png", harness }]))), [], harness);
  assert.match(critical(write(manifestWith([{ filename: "a.png", harness: "all" }])))[0], /harness must be standard, microsoft-copilot, customer-conversation, either, or both/);
  assert.match(critical(write(manifestWith([{ filename: "a.png" }])))[0], /harness must be/);

  const manifest = manifestWith([{ filename: "agent-overview.png", harness: "standard" }, { filename: "both-slot.png", harness: "both" }, { filename: "plain.png", harness: "either" }]);
  const png = makePng({ mode: "ui", seed: 3 });
  fs.writeFileSync(path.join(shots, "agent-overview.png"), png);
  assert.equal(write(manifest).captured, 0, "the plain name is a picture from before harnesses were recorded: it does not count for a Standard slot");
  fs.writeFileSync(path.join(shots, "agent-overview.classic.png"), png);
  fs.writeFileSync(path.join(shots, "both-slot.classic.png"), png);
  fs.writeFileSync(path.join(shots, "plain.png"), png);
  assert.equal(write(manifest).captured, 2, "a harness slot is captured under its tagged name, and a slot that is the same in either harness under its plain one");
  fs.writeFileSync(path.join(shots, "both-slot.copilot.png"), png);
  const done = write(manifest);
  assert.equal(done.captured, 3, "a both slot is captured when each harness has its picture");
  assert.ok(!done.findings.some((f) => f.code === "feature-shots-orphan" && /classic|copilot/.test(f.filename)), "the tagged names are not orphans");
  assert.match(critical(write(manifestWith([{ filename: "a.png" }], "ai-foundry")).findings ? write(manifestWith([{ filename: "a.png", harness: "standard" }], "ai-foundry")) : {})[0] || "", /must not have a harness/);
});

test("the status report counts a harness slot by its tagged name, and a both slot by both variants", (t) => {
  const root = tmp(t);
  const dir = path.join(root, "tools", "screenshot-capture");
  const shots = path.join(root, "docs", "feature-tour", "screenshots");
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(shots, { recursive: true });
  fs.writeFileSync(path.join(dir, "feature-shots.json"), JSON.stringify(manifestWith([{ filename: "a.png", harness: "standard" }, { filename: "b.png", harness: "both" }, { filename: "c.png", harness: "microsoft-copilot" }])));
  const png = makePng({ mode: "ui", seed: 5 });
  for (const name of ["a.classic.png", "b.classic.png", "c.png"]) fs.writeFileSync(path.join(shots, name), png);
  const status = buildStatus({ manifestDir: dir, repoRoot: root });
  const product = status.products[0];
  assert.deepEqual([product.total, product.captured, product.pending], [3, 1, 2], "c.png is not a Microsoft Copilot picture: it is an older, untagged one");
  assert.deepEqual(product.features[0].pending.sort(), ["b.copilot.png", "c.copilot.png"]);
});

test("the new causes have plain words and a fix", () => {
  for (const code of ["wrong-harness", "harness-unproven", "harness-switch-failed", "harness-gap"]) {
    assert.ok(CAUSES[code]?.title && CAUSES[code].fix, code);
    assert.ok(!/[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/u.test(JSON.stringify(CAUSES[code])), "no emoji");
  }
});
