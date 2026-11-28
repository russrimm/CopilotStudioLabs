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
import { roleCompatible, strategiesFor } from "../executor.mjs";
import { createAgentOpenPlan, openCreateFlow } from "../scratch-recipes.mjs";
import { CREATE_OPTIONS, HARNESS_MIN_COMPANION, harnessFromAgentHarness, harnessPlan, sanitizeHarnessProof, sanitizeHarnessReached } from "../harness.mjs";
import {
  classicPageOf,
  ensureClassicExperience,
  harnessEvidence,
  harnessGapMessage,
  harnessState,
  orderByHarness,
  proveAgentPage,
  proveHarness,
  readAgentHarness,
  readLandmarks,
  unprovenMessage,
  wantedHarness,
  workPageOf,
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

test("the practice agent starts from More create options: Agent, Standard and Agent, uses Copilot Credits are allowed only as its create step, the Customer conversation option never, and a failed step names itself", async () => {
  for (const harness of ["standard", "microsoft-copilot"]) {
    const steps = sanitizeSteps(createAgentOpenPlan(harness).menu, { product: "copilot-studio" });
    assert.deepEqual(steps.map((s) => s.id), ["create-menu", "create-option"], `${harness}: no step was dropped by the safety rules`);
    assert.ok(steps.every((s) => s.tier === TIER.PRACTICE), "both steps are practice-agent steps, so they run only in the sanctioned create flow");
  }
  assert.equal(createAgentOpenPlan("customer-conversation").menu, null, "the computer never builds a Customer Conversation agent");
  // The credits rule (a control that spends Copilot Credits is never clicked) holds everywhere else.
  const item = (name, action) => classifyControl({ name, text: name, aria: "", title: "", role: "menuitem", tag: "button" }, { action, intent: "choose" });
  assert.notEqual(item("Agent, uses Copilot Credits", "create").category, "credits");
  assert.equal(item("Agent, uses Copilot Credits", "click").category, "credits", "the same words as any other action keep the rule");
  assert.equal(item("Customer conversation agent, uses Copilot Credits", "create").category, "credits");
  assert.equal(item("Run evaluation", "create").category, "credits");

  const fake = (failId, extra = {}) => ({ ran: [], async run(steps) { this.ran.push(steps.map((s) => s.id)); const bad = steps.find((s) => s.id === failId); return bad ? { ok: false, steps: [], failed: { id: bad.id, why: "not found", missing: true, ...extra } } : { ok: true, steps: [] }; }, async readOverlays() { return this.overlays || []; }, async cleanup() {} });
  const standardMenu = fake("create-menu");
  const noMenu = await openCreateFlow({ executor: standardMenu, harness: "standard" });
  assert.deepEqual([noMenu.ok, noMenu.via, noMenu.stage, noMenu.option], [false, "create-option", "menu", "Agent, Standard"], "a Standard agent has no other way in: the exact step is named");
  assert.deepEqual(standardMenu.ran, [["create-menu", "create-option"]], "and the older New agent button is not tried");
  assert.match(noMenu.reason, /^“More create options” was not on the Agents list after waiting \d+ seconds/);
  const noOption = await openCreateFlow({ executor: fake("create-option"), harness: "standard" });
  assert.deepEqual([noOption.ok, noOption.stage], [false, "option"]);
  assert.match(noOption.reason, /menu was not open when “Agent, Standard” was to be chosen/, "no menu is open: it says the menu was not open, not that the option is missing");
  const openMenu = fake("create-option");
  openMenu.overlays = [{ kind: "menu", title: "" }];
  assert.match((await openCreateFlow({ executor: openMenu, harness: "standard" })).reason, /menu is open but does not list “Agent, Standard”/, "an open menu without the option says so");
  const copilotFallback = fake("create-menu");
  const older = await openCreateFlow({ executor: copilotFallback, harness: "microsoft-copilot" });
  assert.deepEqual([older.ok, older.via], [true, "new-agent-button"], "an older build without the create menu still has the New agent button for a Microsoft Copilot agent");
  assert.deepEqual(copilotFallback.ran, [["create-menu", "create-option"], ["create-open"]]);
  // A different dialog that opened (the account flyout) is a failure with its own sentence: the older button is never tried after a wrong click.
  const wrong = fake("create-menu", { missing: false, why: "after the computer used “More create options”, a dialog named “Account” opened instead of the menu; it was closed with Escape and nothing in it was touched" });
  const wrongMenu = await openCreateFlow({ executor: wrong, harness: "microsoft-copilot" });
  assert.deepEqual([wrongMenu.ok, wrongMenu.via, wrongMenu.stage], [false, "create-option", "menu"]);
  assert.deepEqual(wrong.ran, [["create-menu", "create-option"]], "a wrong dialog does not fall back to another button");
  assert.match(wrongMenu.reason, /a dialog named “Account” opened instead of the menu/);
  assert.doesNotMatch(wrongMenu.reason, /could not choose/);
  const noCopilotOption = await openCreateFlow({ executor: fake("create-option"), harness: "microsoft-copilot" });
  assert.deepEqual([noCopilotOption.ok, noCopilotOption.stage, noCopilotOption.option], [false, "option", "Agent, uses Copilot Credits"], "a menu without the option stops: the button is not guessed");
  const plain = fake("none");
  assert.equal((await openCreateFlow({ executor: plain, harness: null })).via, "new-agent-button");
  assert.deepEqual(plain.ran, [["create-open"]], "a shot with no harness keeps the older single button");
});

test("the create menu step finds its button by exact name only, waits for the list to draw, and is OK only when the menu lists the option", () => {
  for (const harness of ["standard", "microsoft-copilot"]) {
    const [menu, option] = sanitizeSteps(createAgentOpenPlan(harness).menu, { product: "copilot-studio" });
    assert.deepEqual([...strategiesFor(menu)], ["role-exact", "attribute"], "no partial name, no visible-text, and no fuzzy match: a lower left More options button is not More create options");
    assert.deepEqual([...strategiesFor(option)], ["role-exact", "attribute"]);
    assert.equal(menu.findMs, 60_000, "the Agents list takes 15 to 30 seconds to draw, so the button is waited for");
    assert.deepEqual(menu.expect.menuItems, [CREATE_OPTIONS[harness].names[0]], "the menu that opened must list the harness's option");
  }
  assert.equal(createAgentOpenPlan("standard", { waitMs: 800 }).menu[0].findMs, 800, "the wait is a knob, for tests");
  assert.deepEqual([...strategiesFor({ action: "type", target: { name: "Name" } })], ["role-exact", "attribute", "role-name"], "typing is unchanged");
  assert.deepEqual([...strategiesFor({ action: "open", intent: "open", expect: { dialog: true } })], ["role-exact", "attribute", "role-name"], "a step that opens a menu or a dialog never uses the visible-text and fuzzy strategies");
  assert.deepEqual([...strategiesFor({ action: "confirm", tier: 2 })], ["role-exact", "attribute"], "a step that confirms finds its control by its exact name");
  assert.deepEqual([...strategiesFor({ action: "click", tier: 2 })], ["role-exact", "attribute"], "so does any tier 2 write");
  assert.deepEqual([...strategiesFor({ action: "select-tab", tier: 0 })], ["role-exact", "role-name", "attribute", "text-ancestor", "fuzzy"], "navigation keeps its looser fallbacks");
  assert.equal(roleCompatible("menuitem", "button"), false, "a plain button called Settings is not the Settings menu item");
  assert.equal(roleCompatible("button", "link"), true);
});

// ── Reading the page: which harness do the landmarks prove ──────────────────

const TABS = ["Build", "Preview", "Evaluate", "Monitor"].map((name) => ({ role: "tab", name, region: "nav" }));
// The tab strip of a Standard agent page (observed on a real tenant, 2026-11-24): Overview, Knowledge, Tools, Agents, Topics, Activity, Evaluation.
const STRIP = ["Overview", "Knowledge", "Tools", "Agents", "Topics", "Activity", "Evaluation"].map((name) => ({ role: "tab", name, region: "header" }));
// The side navigation of an OLDER classic build: kept as a fallback only.
const SIDE = ["Overview", "Knowledge", "Tools", "Topics", "Analytics", "Settings"].map((name) => ({ role: "link", name, region: "nav", ...(name === "Overview" ? { selected: true } : {}) }));
const previewBase = `https://copilotstudio.preview.microsoft.com/environments/${ENV}`;
const previewAgent = `${previewBase}/bots/${BOT}`;
const MORE = { role: "button", name: "More options", region: "nav" };
const CLASSIC_COMMAND = { role: "menuitem", name: "Open classic experience", region: "other" };
/** The pretend product: the agent page at the default address and on the preview address, and the home pages of both experiences (the menu is the same in both). */
const appWith = (controls, extra = {}) =>
  createFakeApp({
    screens: {
      [`${agent}/overview`]: { text: ["Overview"], controls },
      [`${previewAgent}/overview`]: { text: ["Overview"], controls },
      [`${base}/home`]: { text: ["Home"], controls: [MORE, CLASSIC_COMMAND, { role: "button", name: "Submit", region: "main" }] },
      [`${previewBase}/home`]: { text: ["Home"], controls: [MORE, CLASSIC_COMMAND] },
      [`${previewBase}/agents`]: { text: ["Agents"], controls: [] },
      ...extra,
    },
    redirects: { "https://copilotstudio.microsoft.com/": `${base}/home`, "https://copilotstudio.preview.microsoft.com/": `${previewBase}/home` },
  });

test("the landmarks prove the harness: the four tabs are the Microsoft Copilot harness (with Deploy, Customer Conversation), the Standard tab strip is Standard, anything else is not proven", async () => {
  const seen = async (controls) => {
    const app = appWith(controls);
    await app.page.goto(`${agent}/overview`);
    return proveAgentPage(app.page, { sleep: instant, waitMs: 0, settleMs: 0 });
  };
  assert.equal((await seen(TABS)).harness, "microsoft-copilot");
  assert.deepEqual((await seen(TABS)).landmarks, ["Build", "Preview", "Evaluate", "Monitor"]);
  assert.equal((await seen([...TABS, { role: "tab", name: "Deploy", region: "nav" }])).harness, "customer-conversation", "a control named like a write (Deploy) is still read as a landmark");
  const strip = await seen(STRIP);
  assert.equal(strip.harness, "standard");
  assert.deepEqual(strip.landmarks, ["Overview", "Knowledge", "Tools", "Topics", "Agents"]);
  assert.equal((await seen([STRIP[0], STRIP[1], STRIP[2]])).harness, "standard", "Overview and two of the others are enough");
  assert.equal(await seen([STRIP[0], STRIP[1]]), null, "Overview and only one other tab is not the Standard tab strip");
  assert.equal(await seen([STRIP[1], STRIP[2], STRIP[3], STRIP[4]]), null, "without Overview it is not the Standard tab strip");
  assert.equal(await seen([...STRIP, { role: "tab", name: "Build", region: "header" }]), null, "a mix with a Microsoft Copilot tab proves nothing");
  assert.equal((await seen([...STRIP, ...TABS])).harness, "microsoft-copilot", "the four tabs win");
  // An older build had a side navigation instead: still read, as a fallback.
  const side = await seen(SIDE);
  assert.equal(side.harness, "standard");
  assert.deepEqual(side.landmarks, ["Overview", "Knowledge", "Tools", "Topics", "Analytics"]);
  assert.equal((await seen([...SIDE, ...TABS])).harness, "microsoft-copilot", "the tab strip wins");
  assert.equal(await seen([{ role: "link", name: "Overview", region: "nav" }]), null, "Overview alone is not the classic navigation");
  assert.equal(await seen([]), null);
  // A read that only reads: it never clicks.
  const app = appWith(STRIP);
  await app.page.goto(`${agent}/overview`);
  await readLandmarks(app.page);
  assert.deepEqual(app.log.clicks, []);
});

test("the proof a picture carries is only what was proven, where it was, and how it was reached; a proof made of the retired menu lines is refused", () => {
  const proof = harnessEvidence({ id: "standard", landmarks: ["Overview", "Knowledge"], switched: true, wanted: "standard", host: "copilotstudio.preview.microsoft.com", via: "click-path" });
  assert.deepEqual(proof, { version: 2, id: "standard", proof: "landmarks", landmarks: ["Overview", "Knowledge"], switched: true, wanted: "standard", host: "copilotstudio.preview.microsoft.com", via: "click-path" });
  assert.deepEqual(sanitizeHarnessProof(proof), proof);
  assert.deepEqual(sanitizeHarnessProof({ ...proof, host: "contoso.sharepoint.com", via: "somewhere" }), { version: 2, id: "standard", proof: "landmarks", landmarks: ["Overview", "Knowledge"], switched: true, wanted: "standard" }, "only a Copilot Studio host and a known way are kept");
  assert.equal(harnessEvidence({ id: "standard", landmarks: [], wanted: "standard" }), null, "no landmark, no proof");
  assert.equal(harnessEvidence({ id: null, landmarks: ["Overview"] }), null);
  assert.equal(harnessEvidence({ id: "either", landmarks: ["Overview"] }), null);
  // Companion 1.8.0 proved a page outside an agent by the side bar menu, which offers Open classic experience in EVERY experience: such a proof proves nothing.
  const retired = { version: 1, id: "microsoft-copilot", proof: "landmarks", landmarks: ["Menu in the lower left corner", "Open classic experience offered"], switched: false, wanted: "microsoft-copilot" };
  assert.equal(sanitizeHarnessProof(retired), null);
  assert.equal(sanitizeHarnessProof({ ...retired, id: "standard", landmarks: ["Menu in the lower left corner", "No Open classic experience command"] }), null);
  // A 1.8.0 proof made of an agent page's own tabs is still good.
  assert.equal(sanitizeHarnessProof({ version: 1, id: "microsoft-copilot", proof: "landmarks", landmarks: ["Build", "Preview", "Evaluate", "Monitor"], switched: false, wanted: "microsoft-copilot" })?.id, "microsoft-copilot");
  assert.equal(HARNESS_MIN_COMPANION, "1.8.1", "the first version that proves the harness; its proofs of agent pages (the landmarks of the tab strip) stay valid in 1.8.2, 1.8.3, and 1.8.4");
  assert.equal(COMPANION_VERSION, "1.8.4");
  // A screen outside an agent has no proof, only where it was and how it was reached.
  assert.deepEqual(sanitizeHarnessReached({ id: "standard", host: "copilotstudio.preview.microsoft.com", via: "click-path" }), { version: 2, id: "standard", scope: "environment", host: "copilotstudio.preview.microsoft.com", via: "click-path", proven: false });
  assert.equal(sanitizeHarnessReached({ id: "standard", host: "copilotstudio.preview.microsoft.com" }), null, "how it was reached is part of the record");
  assert.equal(sanitizeHarnessReached({ id: "standard", host: "contoso.sharepoint.com", via: "click-path" }), null, "and so is a Copilot Studio host");
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

test("shots are taken one harness at a time, in the order each harness first appears, so the experience changes once; a plan already in that order is kept", () => {
  const list = ["s1", "c1", "n1", "s2", "c2"].map((id) => ({ id, harness: id[0] === "s" ? "standard" : id[0] === "c" ? "microsoft-copilot" : null }));
  assert.deepEqual(orderByHarness(list).map((s) => s.id), ["s1", "s2", "c1", "n1", "c2"]);
  assert.deepEqual(orderByHarness(list.map((shot) => ({ shot })), (item) => item.shot).map((i) => i.shot.id), ["s1", "s2", "c1", "n1", "c2"]);
  const inOrder = ["s1", "s2", "c1", "c2"].map((id) => ({ id, harness: id[0] === "s" ? "standard" : "microsoft-copilot" }));
  assert.deepEqual(orderByHarness(inOrder).map((s) => s.id), ["s1", "s2", "c1", "c2"], "one harness at a time is left as it is");
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

/**
 * An executor that records which switch steps it is asked to run, and plays the product for the one that matters: the click on Open classic experience opens the
 * classic experience in a NEW TAB (observed on a real tenant). The clicks themselves are proven against a real page in harness-browser.test.mjs.
 * `opens`: "new-tab" (the real behavior), "same-tab" (the page itself moves), or "nothing" (the click does nothing).
 */
const recorder = (app = null, { opens = "new-tab" } = {}) => {
  const calls = [];
  return {
    calls,
    deps: {
      createExecutor: ({ page }) => ({
        run: async (steps) => {
          for (const step of steps) {
            calls.push(step.id);
            if (step.id === "switch-item" && app && opens === "new-tab") app.openTab(`${previewBase}/home`);
            if (step.id === "switch-item" && opens === "same-tab") await page.goto(`${previewBase}/home`);
          }
          return { ok: true, steps: [], failed: null, halted: null };
        },
        cleanup: async () => ({ closed: false, left: 0 }),
      }),
    },
  };
};

async function run(t, app, shot, { mode = "auto", targets = {}, agentUrl = `${agent}/overview`, session = null, guided = {}, log = [] } = {}) {
  const dir = tmp(t);
  const env = agentUrl ? { CAPTURE_COPILOT_STUDIO_AGENT_URL: agentUrl } : {};
  return runCaptureShot({
    page: app.page,
    shot,
    session: session || createCaptureSession({ env, targets, landmarkMs: 0, landmarkSettleMs: 0, promptMs: 0, findMs: 50, switchWaitMs: 0, switchTabMs: 300 }),
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
  const session = createCaptureSession({ env: { CAPTURE_COPILOT_STUDIO_AGENT_URL: `${agent}/overview` }, landmarkMs: 0, landmarkSettleMs: 0, promptMs: 0, findMs: 50, switchWaitMs: 0, switchTabMs: 300, ...extra });
  session.harnessDeps = harnessDeps;
  return session;
};

test("THE REAL FAILURE: a Standard shot switches first, the click opens a NEW TAB, and the shot is taken in that tab (the old code kept using the first one); the switch is not repeated in the same job", async (t) => {
  const app = appWith(STRIP, { [`${agent}/overview`]: { text: ["Overview"], controls: STRIP } });
  const exec = recorder(app);
  const session = sessionWith(exec.deps);
  const log = [];
  const first = await run(t, app, planShot("standard"), { session, log });
  assert.equal(first.status, "captured", first.error);
  assert.deepEqual(exec.calls, ["switch-menu", "switch-item"], "the More options button, then Open classic experience (no feedback prompt was shown, so Skip feedback was not clicked); nothing else is clicked to prove it");
  assert.equal(app.log.goto[0], `${base}/home`, "the switch starts on the default address's home page, before the agent");
  assert.equal(app.log.tabs, 1, "the click opened one new tab");
  const classic = classicPageOf(session);
  assert.ok(classic && classic !== app.page, "the new tab is the page in use");
  assert.equal(app.page.url(), `${base}/home`, "the first tab stayed where it was");
  assert.equal(classic.url(), `${previewAgent}/overview`, "the agent was opened in the new tab, on the preview host under /bots/<id>/");
  assert.equal(first.finalUrl, `${previewAgent}/overview`);
  assert.equal(first.harness.id, "standard");
  assert.equal(first.harness.switched, true);
  assert.equal(first.harness.wanted, "standard");
  assert.equal(first.harness.host, "copilotstudio.preview.microsoft.com");
  assert.equal(first.harness.via, "click-path");
  assert.deepEqual(first.harness.landmarks, ["Overview", "Knowledge", "Tools", "Topics", "Agents"]);
  assert.match(log.join("\n"), /Switching to the classic experience: ellipsis in the lower left corner > Open classic experience > Skip feedback/);
  assert.match(log.join("\n"), /The classic experience is open in a new tab \(copilotstudio\.preview\.microsoft\.com\), reached by the click path/);
  assert.match(log.join("\n"), /Proved the Standard \(Classic\) harness: Overview, Knowledge, Tools, Topics, Agents/);
  assert.equal(first.detail.harness.proven, "standard");
  assert.match(plainOutcome(first.detail, first.executedSteps, "auto"), /Proved the Standard \(Classic\) harness: Overview, Knowledge, Tools, Topics, Agents \(switched to the classic experience first\)\./);

  const again = await run(t, app, planShot("standard"), { session });
  assert.equal(again.status, "captured", again.error);
  assert.deepEqual(exec.calls, ["switch-menu", "switch-item"], "the switch is not repeated inside the job, but the landmark was read again");
  assert.equal(app.log.tabs, 1);
  assert.equal(again.harness.id, "standard");

  // The classic tab is closed (by the person): the next Standard shot switches again, and follows the new tab again.
  await classic.close();
  const third = await run(t, app, planShot("standard"), { session });
  assert.equal(third.status, "captured", third.error);
  assert.deepEqual(exec.calls, ["switch-menu", "switch-item", "switch-menu", "switch-item"], "the classic tab was gone, so the click path was made again");
  assert.equal(app.log.tabs, 2);
  assert.notEqual(classicPageOf(session), classic);
});

test("a switch that moves the same tab is followed too; a click that opens nothing falls back to the preview address in a new tab, recorded as the way used; with neither the shot stops with a plain reason", async (t) => {
  const sameApp = appWith(STRIP, { [`${agent}/overview`]: { text: ["Overview"], controls: STRIP } });
  const same = sessionWith(recorder(sameApp, { opens: "same-tab" }).deps);
  const moved = await run(t, sameApp, planShot("standard"), { session: same });
  assert.equal(moved.status, "captured", moved.error);
  assert.equal(sameApp.log.tabs, 0, "no new tab was needed");
  assert.equal(classicPageOf(same), sameApp.page);
  assert.equal(moved.harness.via, "click-path");

  const directApp = appWith(STRIP);
  const log = [];
  const direct = await run(t, directApp, planShot("standard"), { session: sessionWith(recorder(directApp, { opens: "nothing" }).deps), log });
  assert.equal(direct.status, "captured", direct.error);
  assert.equal(directApp.context.pages().length, 1, "the preview address was opened in a new tab, and the first tab was closed: one tab");
  assert.equal(direct.harness.via, "preview-address", "the proof records the way used");
  assert.match(log.join("\n"), /The click did not open the classic experience, so the computer opens its address directly \(copilotstudio\.preview\.microsoft\.com\)/);

  // The preview address does not lead to the classic experience either: Needs you, with the reason.
  const broken = createFakeApp({ screens: { [`${base}/home`]: { text: ["Home"], controls: [MORE, CLASSIC_COMMAND] }, [`${base}/agents`]: { text: ["Agents"], controls: [] } }, redirects: { "https://copilotstudio.microsoft.com/": `${base}/home`, [`${previewBase}/agents`]: `${base}/agents` } });
  const failed = await run(t, broken, planShot("standard"), { session: sessionWith(recorder(broken, { opens: "nothing" }).deps) });
  assert.deepEqual([failed.status, failed.cause], ["needs-you", "harness-switch-failed"]);
  assert.match(failed.error, /neither the click path nor the address copilotstudio\.preview\.microsoft\.com led to a classic page/);
  assert.equal(broken.log.screenshots, 0);
});

test("a page in the wrong harness is never saved as a picture of the other: the shot is needs-you with the plain reason, in every automatic mode", async (t) => {
  const app = appWith(TABS);
  const result = await run(t, app, planShot("standard"), { session: sessionWith(recorder(app).deps) });
  assert.deepEqual([result.status, result.cause], ["needs-you", "wrong-harness"]);
  assert.equal(result.error, "This agent is in the Microsoft Copilot harness; this picture needs the Standard (Classic) harness. Choose a Standard (Classic) agent, or let the computer create one.");
  assert.equal(app.log.screenshots, 0, "nothing was photographed");
  assert.equal(result.harness, undefined);
  assert.equal(result.detail.harness.found, "microsoft-copilot");

  const classicApp = appWith(STRIP);
  const copilot = await run(t, classicApp, planShot("microsoft-copilot"), { session: sessionWith(recorder(classicApp).deps) });
  assert.deepEqual([copilot.status, copilot.cause], ["needs-you", "wrong-harness"]);
  assert.match(copilot.error, /^This agent is in the Standard \(Classic\) harness; this picture needs the Microsoft Copilot harness\./);
  assert.equal(classicApp.log.screenshots, 0);

  // A page that shows neither is not guessed at.
  const empty = appWith([]);
  const blank = await run(t, empty, planShot("standard"), { session: sessionWith(recorder(empty).deps) });
  assert.deepEqual([blank.status, blank.cause], ["needs-you", "harness-unproven"]);
  assert.match(blank.error, /could not tell which harness this agent is in/);
});

test("a Microsoft Copilot shot never switches; after a Standard shot the first tab was closed (one tab), and the next Microsoft Copilot shot opens the default address again in that single tab", async (t) => {
  const app = appWith(STRIP, { [`${agent}/overview`]: { text: ["Overview"], controls: TABS } });
  const exec = recorder(app);
  const session = sessionWith(exec.deps);
  const copilot = await run(t, app, planShot("microsoft-copilot"), { session });
  assert.equal(copilot.status, "captured", copilot.error);
  assert.deepEqual(exec.calls, [], "no switch step was run for a Microsoft Copilot picture");
  assert.equal(copilot.harness.id, "microsoft-copilot");
  assert.equal(copilot.harness.switched, false);
  assert.equal(copilot.harness.host, "copilotstudio.microsoft.com");
  assert.equal(copilot.harness.via, "default-address");
  assert.deepEqual(copilot.harness.landmarks, ["Build", "Preview", "Evaluate", "Monitor"]);
  assert.ok(!app.log.goto.includes("https://copilotstudio.microsoft.com/"), "the default experience was already the one in use");

  const classic = await run(t, app, planShot("standard"), { session });
  assert.equal(classic.status, "captured", classic.error);
  assert.equal(app.context.pages().length, 1, "one tab: the first tab (the default address) was closed once the classic tab was open");
  assert.ok(app.page.isClosed(), "the first tab is the one that was closed");
  const tab = classicPageOf(session);
  assert.ok(tab && !tab.isClosed());
  assert.equal(workPageOf(session, null), tab, "the classic tab is the page the job works in from now on");

  const back = await run(t, app, planShot("microsoft-copilot"), { session });
  assert.equal(back.status, "captured", back.error);
  assert.equal(app.context.pages().length, 1, "still one tab");
  assert.ok(!tab.isClosed(), "the single tab is reused: the default address is opened in it again");
  assert.equal(classicPageOf(session), null, "and it is no longer the classic tab");
  assert.equal(back.harness.host, "copilotstudio.microsoft.com");
  assert.ok(app.log.goto.includes("https://copilotstudio.microsoft.com/"), "the default experience address was opened in the one tab, and the harness was proven again");
  assert.deepEqual(exec.calls, ["switch-menu", "switch-item"], "nothing else was clicked to change the experience");

  // A page that is itself in the classic experience (the same tab moved) goes back to the default address in place.
  const movedApp = appWith(TABS);
  const moved = sessionWith(recorder(movedApp).deps);
  harnessState(moved, movedApp.page).classic = true;
  const inPlace = await run(t, movedApp, planShot("microsoft-copilot"), { session: moved });
  assert.equal(inPlace.status, "captured", inPlace.error);
  assert.ok(movedApp.log.goto.includes("https://copilotstudio.microsoft.com/"), "the default experience address was opened again");
  assert.equal(harnessState(moved, movedApp.page).classic, false);
});

test("a screen outside any agent is never proven by what it shows: it is taken on the host that matches the harness, stamped with the host and how it was reached, and no menu is read", async (t) => {
  const homeShot = (harness) => planShot(harness, { needs: [], route: { kind: "copilot-studio", screen: "home", scope: "environment" }, screen: { id: "home", label: "the Copilot Studio home page" }, path: ["Copilot Studio", "Home"], expect: { family: "copilot-studio", scope: "environment", paths: ["home"], label: "the Copilot Studio home page", strict: true } });
  const app = appWith(STRIP);
  const exec = recorder(app);
  const standard = await run(t, app, homeShot("standard"), { session: sessionWith(exec.deps), agentUrl: null });
  assert.equal(standard.status, "captured", standard.error);
  assert.deepEqual(exec.calls, ["switch-menu", "switch-item"], "only the switch clicked anything: the menu is the same in every experience, so it is not opened to find out what experience this is");
  assert.equal(standard.harness, null, "no proof");
  assert.deepEqual(standard.harnessReached, { version: 2, id: "standard", scope: "environment", host: "copilotstudio.preview.microsoft.com", via: "click-path", proven: false });
  assert.equal(standard.detail.harness.notProvenByContent, true);
  assert.equal(standard.finalUrl, `${previewBase}/home`, "a Standard lab's Home is taken on the preview host");

  const copilotApp = appWith(TABS);
  const copilotExec = recorder(copilotApp);
  const copilot = await run(t, copilotApp, homeShot("microsoft-copilot"), { session: sessionWith(copilotExec.deps), agentUrl: null });
  assert.equal(copilot.status, "captured", copilot.error);
  assert.deepEqual(copilotExec.calls, [], "nothing was clicked");
  assert.equal(copilot.harness, null);
  assert.deepEqual(copilot.harnessReached, { version: 2, id: "microsoft-copilot", scope: "environment", host: "copilotstudio.microsoft.com", via: "default-address", proven: false });

  // The host is corroboration that can only refuse: a Standard picture of a page that ends on the default host is never kept.
  const bounced = createFakeApp({ screens: { [`${base}/home`]: { text: ["Home"], controls: [MORE, CLASSIC_COMMAND] } }, redirects: { "https://copilotstudio.microsoft.com/": `${base}/home`, [`${previewBase}/home`]: `${base}/home` } });
  const wrongSession = sessionWith(recorder(bounced).deps);
  harnessState(wrongSession, bounced.page).classic = true;
  const wrong = await run(t, bounced, homeShot("standard"), { session: wrongSession, agentUrl: null });
  assert.deepEqual([wrong.status, wrong.cause], ["needs-you", "wrong-harness"]);
  assert.match(wrong.error, /^This page is on copilotstudio\.microsoft\.com, which is the Microsoft Copilot harness experience; this picture needs the Standard \(Classic\) harness\./);
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

const HARNESS_TIP = { copilot: "This agent runs on the Microsoft Copilot harness. Copilot Credits are used as you create and edit it.", standard: "This agent runs on the standard harness. It doesn't use Copilot Credits for users with a Microsoft 365 Copilot license." };

test("the Agent harness cell is read from its start (the tooltip is appended to the cell's text), per agent row; an older Powered by column is a fallback; rows that disagree decide nothing", () => {
  assert.equal(harnessFromAgentHarness(`Microsoft Copilot${HARNESS_TIP.copilot}`), "microsoft-copilot");
  assert.equal(harnessFromAgentHarness(`Standard${HARNESS_TIP.standard}`), "standard", "the tooltip's own words (Microsoft 365 Copilot, Copilot Credits) never decide");
  assert.equal(harnessFromAgentHarness("Microsoft Copilot"), "microsoft-copilot");
  assert.equal(harnessFromAgentHarness("  standard  "), "standard");
  assert.equal(harnessFromAgentHarness("Customer Conversation"), "customer-conversation");
  assert.equal(harnessFromAgentHarness("Published"), null);
  assert.equal(harnessFromAgentHarness(`Last modified today. ${HARNESS_TIP.standard}`), null, "text that does not start with a harness is not a harness");
  assert.equal(harnessFromAgentHarness(""), null);
});

test("a chosen agent whose Agents list row says it is in another harness is refused before it is opened, in both directions, with how to fix it", async (t) => {
  const row = (name, harness, tip) => ({ role: "button", name: `Open ${name}`, region: "main", goto: harness === "standard" ? `${previewAgent}/overview` : `${base}/agents/${BOT}` });
  const listFor = (hostBase) => ({
    text: ["Agents"],
    agentHarness: { "Energy Assistant": { column: "agent-harness", texts: [`Microsoft Copilot${HARNESS_TIP.copilot}`] } },
    controls: [row("Energy Assistant", "microsoft-copilot"), { role: "button", name: "Open account menu for Ada Lovelace", region: "header" }],
  });
  const app = appWith(STRIP, { [`${previewBase}/agents`]: listFor(), [`${base}/agents`]: listFor() });
  const session = sessionWith(recorder(app).deps, {});
  session.values = { ...session.values, copilotStudioAgentName: "Energy Assistant", copilotStudioAgentUrl: "" };
  const result = await run(t, app, planShot("standard"), { agentUrl: null, session });
  assert.deepEqual([result.status, result.cause], ["needs-you", "wrong-harness"]);
  assert.equal(result.error, "This agent is in the Microsoft Copilot harness; this picture needs the Standard (Classic) harness. Choose a Standard (Classic) agent, or let the computer create one.");
  assert.equal(result.detail.harness.via, "agent-harness-column");
  assert.ok(!app.log.clicks.includes("Open Energy Assistant"), "the agent was not opened");
  assert.ok(!app.log.clicks.includes("Open account menu for Ada Lovelace"), "the top bar's Open button is never taken for a row's");
  assert.equal(app.log.screenshots, 0);

  // The other way round: a Standard row for a Microsoft Copilot picture. Nothing is switched.
  const standardList = { text: ["Agents"], agentHarness: { "Energy Assistant": { column: "agent-harness", texts: [`Standard${HARNESS_TIP.standard}`] } }, controls: [row("Energy Assistant", "standard")] };
  const other = appWith(TABS, { [`${base}/agents`]: standardList });
  const exec = recorder(other);
  const second = sessionWith(exec.deps, {});
  second.values = { ...second.values, copilotStudioAgentName: "Energy Assistant", copilotStudioAgentUrl: "" };
  const refused = await run(t, other, planShot("microsoft-copilot"), { agentUrl: null, session: second });
  assert.deepEqual([refused.status, refused.cause], ["needs-you", "wrong-harness"]);
  assert.equal(refused.error, "This agent is in the Standard (Classic) harness; this picture needs the Microsoft Copilot harness. Choose a Microsoft Copilot agent, or let the computer create one.");
  assert.deepEqual(exec.calls, [], "no switch was made for a Microsoft Copilot picture");
  assert.ok(!other.log.clicks.includes("Open Energy Assistant"));

  // A row that agrees is opened by its Open button.
  const fine = appWith(STRIP, { [`${previewBase}/agents`]: { text: ["Agents"], agentHarness: { "Energy Assistant": { column: "agent-harness", texts: [`Standard${HARNESS_TIP.standard}`] } }, controls: [row("Energy Assistant", "standard")] } });
  const third = sessionWith(recorder(fine).deps, {});
  third.values = { ...third.values, copilotStudioAgentName: "Energy Assistant", copilotStudioAgentUrl: "" };
  const taken = await run(t, fine, planShot("standard"), { agentUrl: null, session: third });
  assert.equal(taken.status, "captured", taken.error);
  assert.deepEqual(fine.log.clicks, ["Open Energy Assistant"]);
  assert.equal(taken.harness.id, "standard");
  assert.equal(taken.finalUrl, `${previewAgent}/overview`);

  // Rows with the same name in two harnesses decide nothing (the page's own landmarks do), and an older build's Powered by column is still read.
  const ambiguous = appWith([], { [`${base}/agents`]: { text: [], agentHarness: { Twin: { column: "agent-harness", texts: ["Standard", "Microsoft Copilot"] } }, controls: [] } });
  await ambiguous.page.goto(`${base}/agents`);
  assert.equal(await readAgentHarness(ambiguous.page, "Twin"), null);
  const older = appWith([], { [`${base}/agents`]: { text: [], agentHarness: { Old: { column: "powered-by", texts: ["Microsoft Copilot harness"] } }, controls: [] } });
  await older.page.goto(`${base}/agents`);
  assert.equal(await readAgentHarness(older.page, "Old"), "microsoft-copilot");
});

test("the switch stops, with a plain reason, when neither the page's controls nor the preview address lead into the classic experience", async (t) => {
  const failing = { createExecutor: () => ({ run: async () => ({ ok: false, steps: [], failed: { id: "switch-menu" }, halted: null }), cleanup: async () => ({}) }) };
  const app = appWith(SIDE);
  const session = sessionWith(failing);
  const out = await ensureClassicExperience({ page: app.page, session, go: async (url) => { await app.page.goto(url); return { url }; }, sleep: instant, deps: failing.deps || failing });
  assert.equal(out.ok, false);
  assert.equal(out.cause, "harness-switch-failed");
  assert.match(out.error, /neither the click path nor the address copilotstudio\.preview\.microsoft\.com led to a classic page/);
  assert.equal(harnessState(session, app.page).classic, false, "nothing is remembered as switched");
  assert.equal(classicPageOf(session), null);
  const proof = await proveHarness({ page: app.page, session, wanted: "standard", scope: "agent", allowClicks: false, sleep: instant, waitMs: 0 });
  assert.equal(proof.ok, false, "and a page that is not an agent page proves nothing");
});

// ── The practice agent per harness ──────────────────────────────────────────

test("a practice agent's name carries its harness, is distinct per harness and per lab, and never exceeds the 30 characters the product keeps", () => {
  const classicTeam = scratchAgentName("Team Assistant", "standard", { key: "lab-a" });
  assert.match(classicTeam, /^Classic shots - Team [0-9a-z]{4}$/);
  assert.match(scratchAgentName("Team Assistant", "microsoft-copilot", { key: "lab-a" }), /^Copilot shots - Team [0-9a-z]{4}$/);
  assert.equal(scratchAgentName("Team Assistant", "standard", { key: "lab-a" }), classicTeam, "the same lab and harness always get the same name");
  assert.equal(scratchAgentName("Team Assistant"), "Lab screenshots - Team", "the older name is unchanged");
  const titles = ["Team Assistant", "x".repeat(200), "Cross-industry: Build a Customer Support Agent with Knowledge", "Ops", "Extraordinarily", "A B C D E F G H I J K L"];
  for (const title of titles) {
    const names = ["standard", "microsoft-copilot", "customer-conversation", null].map((h) => scratchAgentName(title, h, { key: title }));
    assert.ok(names.every((n) => n.length <= MAX_AGENT_NAME), `${title.slice(0, 20)}: ${names.map((n) => n.length).join(", ")}`);
    assert.equal(new Set(names).size, 4, "four distinct names");
  }
  // Two labs whose titles start alike were given the SAME name when the title was cut at the 30 characters (a real run: "Classic shots - Energy &" three times).
  const energy = ["lab-energy-utilities-assistant", "lab-energy-grid-planner", "lab-energy-retail-advisor"].map((key, i) => scratchAgentName(["Energy & Utilities Assistant", "Energy & Grid Planner", "Energy & Retail Advisor"][i], "standard", { key }));
  assert.equal(new Set(energy).size, 3, `three labs, three names: ${energy.join(" | ")}`);
  assert.ok(energy.every((n) => n.length <= MAX_AGENT_NAME && /^Classic shots - Energy [0-9a-z]{4}$/.test(n)), energy.join(" | "));
  // An agent set aside by Start fresh stays in the list, so the next one has a different name.
  assert.notEqual(scratchAgentName("Team Assistant", "standard", { key: "lab-a", generation: 1 }), classicTeam);
  const context = sanitizeScratchContext({ labTitle: "Cross-industry: Build a Team Assistant with Create an agent", key: "lab-a" });
  assert.equal(practiceAgentName(context, "standard"), classicTeam, "the name comes from the lab's key");
  assert.match(practiceAgentName(context, "microsoft-copilot"), /^Copilot shots - Team [0-9a-z]{4}$/);
  assert.notEqual(practiceAgentName(context, "standard", { generation: 1 }), practiceAgentName(context, "standard"));
  assert.equal(practiceAgentName(context), context.agentName);
  assert.match(practiceName(() => "ab12cd", "standard"), /^Classic shots - ab12cd$/);
  assert.match(practiceName(() => "ab12cd", "microsoft-copilot"), /^Copilot shots - ab12cd$/);
  assert.match(practiceName(() => "ab12cd"), /^Lab screenshots - ab12cd$/);
  assert.ok(practiceName(() => "ffffff", "customer-conversation").length <= MAX_AGENT_NAME);
  for (const name of ["Classic shots - A", "Copilot shots - A", "Lab screenshots - A", "Classic shots - Energy 3k9a"]) assert.ok(isPracticeName(name), name);
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
  const newAgent = `${previewBase}/bots/7a1c0001-5b3d-4e6f-8a9b-c0d1e2f3a4b5`;
  const app = appWith(STRIP, { [`${previewBase}/agents`]: { text: ["Agents"], controls: [] }, [`${newAgent}/overview`]: { text: ["Overview"], controls: TABS } });
  const exec = recorder(app);
  const session = createCaptureSession({ autonomy, registry, agentSource: "created", landmarkMs: 0, landmarkSettleMs: 0, promptMs: 0, switchWaitMs: 0, switchTabMs: 300 });
  session.harnessDeps = exec.deps;
  // The shot has already switched (the way runCaptureShot does it) and works in the classic tab.
  const switched = await ensureClassicExperience({ page: app.page, session, go: async (url, label, options = {}) => { await (options.on || app.page).goto(url); return { url }; }, sleep: instant, deps: exec.deps });
  assert.equal(switched.ok, true);
  const tab = switched.page;
  assert.notEqual(tab, app.page);
  const go = async (url) => { await tab.goto(url); return { url }; };
  // The create steps: the Agents list's More create options and "Agent, Standard", then the name and the confirm button. They end on a Microsoft Copilot agent although a Standard one was asked for.
  const ran = [];
  const executorFor = () => ({ run: async (steps) => { ran.push(steps.map((s) => s.id)); if (steps.some((s) => s.id === "create-confirm")) await tab.goto(`${newAgent}/overview`); return { ok: true, steps: [] }; }, cleanup: async () => ({}) });
  const result = await ensurePracticeAgent({ page: tab, autonomy, registry, session, executorFor, go, harness: "standard", random: () => "abc123", sleep: instant });
  assert.equal(result.ok, false);
  assert.equal(result.cause, "wrong-harness");
  assert.match(result.error, /^This agent is in the Microsoft Copilot harness; this picture needs the Standard \(Classic\) harness\. The practice agent was not used\./);
  assert.deepEqual(exec.calls, ["switch-menu", "switch-item"], "the switch was made once, for the Classic agent; the second call reused it");
  assert.deepEqual(ran, [["create-menu", "create-option"], ["create-name", "create-confirm"]], "the Standard agent starts from More create options > Agent, Standard, and the steps after it are the existing ones");
  assert.equal(registry.items().agents[0].name, "Classic shots - abc123");
  assert.equal(registry.find("env-1", undefined, "standard"), null);
  assert.equal(registry.items().agents[0].harness, "microsoft-copilot", "recorded under the harness it was proven to be in, never the one asked for");
  assert.equal(await ensurePracticeAgent({ page: tab, autonomy, registry, session, executorFor, go, harness: "standard", sleep: instant }).then((r) => r.error), result.error, "the answer is remembered for the rest of the job");
});

test("the recipes choose their steps from the harness, not from a probe: Standard has the tab strip steps (with the overflow menu), the others the Build tab steps", () => {
  const shot = { kind: "ui-location", caption: "The agent", alt: "", instructions: [] };
  const ids = (list) => (list || []).map((s) => s.id);
  assert.deepEqual(ids(showStepsFor({ stage: "agent", shot, harness: "standard", layout: "newer" })), ["cl-overview-tab", "cl-overview-tab-open"], "the harness wins over a layout that was read");
  assert.deepEqual(ids(showStepsFor({ stage: "agent", shot, harness: "microsoft-copilot", layout: "classic" })), ["build-tab", "build-tab-open"]);
  assert.deepEqual(ids(showStepsFor({ stage: "agent", shot, harness: "customer-conversation" })), ["build-tab", "build-tab-open"]);
  assert.deepEqual(ids(showStepsFor({ stage: "model", shot, harness: "standard" })), ["cl-overview-tab", "cl-overview-tab-open", "classic-model-open"], "a Standard agent has the model combobox on its Overview tab");
  assert.ok(showStepsFor({ stage: "model", shot, harness: "microsoft-copilot" }));
  assert.deepEqual(ids(showStepsFor({ stage: "agent", shot, layout: "classic" })), ["overview-nav", "overview-nav-open"], "a caller with no harness keeps the layout it read (an older classic build with a side navigation)");
  const automation = { family: "testset" };
  assert.ok(familyShowSteps({ automation, shot, harness: "standard", stage: "evaluate" }).steps.some((s) => s.id === "cl-evaluation-more"), "a Standard Evaluation tab is reached through the tab strip, with the overflow menu as the way when it is not on the strip");
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
  assert.match(text, /Harness: Standard \(Classic\) harness\r?\n\s+Switch: ellipsis in the lower left corner > Open classic experience > Skip feedback\. The click opens the classic experience in a new browser tab on copilotstudio\.preview\.microsoft\.com; the picture is taken in that tab, where Standard agents open\./);
  assert.match(text, /Proof before the picture: A tab strip with Overview and at least two of Knowledge, Tools, Topics, Agents, Activity, or Evaluation/);
  assert.match(text, /Harness: Microsoft Copilot harness\r?\n\s+No switch: use copilotstudio\.microsoft\.com \(the default experience\) and an agent whose Agent harness column says Microsoft Copilot/);
  assert.match(text, /Proof before the picture: The Build, Preview, Evaluate, and Monitor tabs/);
  assert.match(text, /d\.png\r?\n\s+Not taken: This module is written for the Microsoft Copilot harness/);
  assert.match(harnessPlan("standard").switchStep, /^Switch: ellipsis in the lower left corner > Open classic experience > Skip feedback\. The click opens the classic experience in a new browser tab on copilotstudio\.preview\.microsoft\.com/);
  assert.match(harnessPlan("standard").environment, /^A screen outside the agent \(Home, the Agents list\) cannot be proven by what it shows\./);
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
  assert.match(copilot.stdout, /No switch: use copilotstudio\.microsoft\.com/);
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
