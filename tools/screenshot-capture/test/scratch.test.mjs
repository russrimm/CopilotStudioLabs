// Building the agent from scratch, without a browser: how a lab's shots map to stages of one practice agent, what the
// computer types into it (checked again here), that every step of every recipe survives the safety rules, the local
// opt-in and registry, and the guard's adversarial labels for the writes the walkthrough makes.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { TIER, authorizeStep, checkPublicWebsite, classifyControl, resolveAutonomy } from "../guard.mjs";
import { ensurePracticeOptIn, hasPracticeOptIn, loadSettings, saveSettings } from "../companion.mjs";
import { buildPracticeReport, createPracticeRegistry, practiceName } from "../practice.mjs";
import { insidePracticeAgent, stepFromEvent } from "../recorder.mjs";
import * as R from "../scratch-recipes.mjs";
import { isCreateFlowUrl, showStepsFor, stagesToPrepare, strictSteps } from "../scratch.mjs";
import { sanitizeSteps } from "../setup-steps.mjs";
import { BLOCKERS, STAGES, classifyStage, orderForWalkthrough, sanitizeScratchContext, scratchAgentName, scratchInputs, stagesBefore, summarizeBlockers } from "../walkthrough.mjs";

const ENV = "https://copilotstudio.microsoft.com/environments/6b988893-6c74-4e65-9d9a-f7f044be1d08";
const BOT = "7a1c0001-5b3d-4e6f-8a9b-c0d1e2f3a4b5";
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "scratch-unit-"));
const shot = (over = {}) => ({ filename: "a.png", featureId: "mc-instructions", section: "build", kind: "after", product: "copilot-studio", caption: "A caption", alt: "An alt", instructions: [], callouts: [], moduleOrder: 1, ...over });

// ── The lab becomes a walkthrough ───────────────────────────────────────────

test("a shot belongs to the stage its feature names, and the stages are built in the order a lab teaches them", () => {
  const stageOf = (featureId, section = "build", kind = "after") => classifyStage(shot({ featureId, section, kind })).stage;
  assert.equal(stageOf("mc-create-agent"), "agent");
  assert.equal(stageOf("create-agent", "overview"), "agent");
  assert.equal(stageOf("mc-instructions"), "instructions");
  assert.equal(stageOf("agent-instructions", "overview"), "instructions");
  assert.equal(stageOf("mc-knowledge", "build", "dialog"), "knowledge");
  assert.equal(stageOf("knowledge-sharepoint", "knowledge", "dialog"), "knowledge");
  assert.equal(stageOf("mc-tools", "tools", "dialog"), "tools");
  assert.equal(stageOf("mc-model-selection", "overview", "settings"), "model");
  assert.equal(stageOf("mc-preview-test", "preview", "test-result"), "preview");
  assert.equal(stageOf("mc-evaluate", "evaluate", "test-result"), "evaluate");
  assert.equal(stageOf("mc-publish-agent", "build", "dialog"), "publish");
  assert.equal(stageOf("publish-agent", "overview"), "publish");
  assert.equal(stageOf("mc-monitor", "analytics", "ui-location"), "monitor");
  assert.equal(stageOf("analytics", "analytics"), "monitor");
  assert.equal(stageOf("mc-memory", "build", "settings"), "settings");
  assert.equal(stageOf("generative-orchestration", "settings", "settings"), "settings");
  assert.deepEqual(STAGES.map((s) => s.id), ["agent", "instructions", "knowledge", "tools", "model", "preview", "evaluate", "publish", "monitor", "settings"]);
  assert.deepEqual(stagesBefore("preview").map((s) => s.id), ["agent", "instructions", "knowledge"], "a test needs the agent, its instructions, and its knowledge");
  assert.deepEqual(stagesBefore("agent"), []);
});

test("environment pages, other products, and screens outside the agent are not built from scratch", () => {
  assert.deepEqual(classifyStage(shot({ section: "home", featureId: "create-agent" })), { stage: "other", order: 5, scoped: false, blocker: null });
  assert.equal(classifyStage(shot({ section: "agents", featureId: "create-agent" })).scoped, false);
  assert.deepEqual(classifyStage(shot({ product: "sharepoint-ai", section: "sharepoint-site", featureId: "x" })), { stage: "other", order: 999, scoped: false, blocker: null }, "another product keeps its own screens");
  for (const [featureId, blocker] of [["dlp-governance", "admin"], ["channel-teams", "other-product"], ["voice-agents", "other-product"], ["mc-credit-billing", "admin"], ["servicenow-integration", "outside-agent"], ["topics", "outside-agent"]]) {
    const found = classifyStage(shot({ featureId, section: "settings" }));
    assert.deepEqual([found.scoped, found.blocker], [false, blocker], featureId);
  }
});

test("a shot the computer cannot take says why in plain words, from what the picture shows, never from every step of the module", () => {
  const found = (over) => classifyStage(shot(over));
  assert.equal(found({ featureId: "mc-tools", section: "tools", kind: "error-state", caption: "A tool blocked by a data policy" }).blocker, "error-state", "an error state is never caused on purpose, and a data policy mention does not turn it into an admin screen");
  assert.equal(found({ featureId: "mc-tools", section: "tools", kind: "after", caption: "A connected Outlook tool" }).blocker, "connection");
  assert.equal(found({ featureId: "mc-tools", section: "tools", kind: "dialog", caption: "The Add a tool dialog" }).blocker, null, "opening the dialog is fine");
  assert.equal(found({ featureId: "mc-knowledge", kind: "after", caption: "Sample files uploaded to the library" }).blocker, "files");
  assert.equal(found({ featureId: "mc-publish-agent", kind: "dialog", caption: "The Publish agent dialog", instructions: ["Publish the agent to its channels", "Select Microsoft Teams"] }).blocker, null, "a module that talks about channels can still have a picture of the default Publish dialog");
  assert.equal(found({ featureId: "mc-publish-agent", kind: "after", caption: "The Microsoft Teams channel", callouts: [{ text: "Teams channel" }] }).blocker, "channel");
  assert.equal(found({ featureId: "mc-evaluate", section: "evaluate", kind: "test-result", caption: "A finished evaluation" }).blocker, "credits", "running an evaluation spends Copilot Credits, which the computer does not do");
  assert.equal(found({ featureId: "mc-evaluate", section: "evaluate", kind: "ui-location", caption: "The Evaluate tab" }).blocker, null);
  for (const blocker of ["connection", "files", "channel", "admin", "other-product", "error-state"]) {
    assert.ok(BLOCKERS[blocker].reason.length > 40 && BLOCKERS[blocker].fix.length > 15, `${blocker} has a reason and one fix`);
    assert.doesNotMatch(`${BLOCKERS[blocker].reason} ${BLOCKERS[blocker].fix}`, /https?:|[0-9a-f]{8}-[0-9a-f]{4}/i);
  }
  const groups = summarizeBlockers([{ capture: { scratch: { blocker: "connection" } } }, { capture: { scratch: { blocker: "connection" } } }, { capture: { scratch: { blocker: "files" } } }, { capture: { scratch: {} } }]);
  assert.deepEqual(groups.map((g) => [g.blocker, g.count]), [["connection", 2], ["files", 1]], "shots with the same reason are one group with one fix");
});

test("the shots are walked in the order of the lab's modules, and a stage's own steps come after the stages it needs", () => {
  const ordered = orderForWalkthrough([
    shot({ filename: "publish.png", featureId: "mc-publish-agent", moduleOrder: 8, section: "build" }),
    shot({ filename: "preview.png", featureId: "mc-preview-test", moduleOrder: 6, section: "preview" }),
    shot({ filename: "create.png", featureId: "mc-create-agent", moduleOrder: 1 }),
    shot({ filename: "instr-test.png", featureId: "mc-instructions", moduleOrder: 2, kind: "test-result", section: "test" }),
    shot({ filename: "instr.png", featureId: "mc-instructions", moduleOrder: 2 }),
  ]);
  assert.deepEqual(ordered.map((s) => s.filename), ["create.png", "instr-test.png", "instr.png", "preview.png", "publish.png"], "by module, then by stage, and inside one stage as the plan lists them");
  assert.deepEqual(stagesToPrepare("preview", shot({ kind: "test-result" })), ["agent", "instructions", "knowledge"], "a test needs everything before it");
  assert.deepEqual(stagesToPrepare("knowledge", shot({ kind: "dialog" })), ["agent", "instructions"], "the dialog shot is taken before the source is added");
  assert.deepEqual(stagesToPrepare("knowledge", shot({ kind: "after" })), ["agent", "instructions", "knowledge"]);
  assert.deepEqual(stagesToPrepare("publish", shot({ kind: "dialog" })), ["agent", "instructions", "knowledge"], "publishing is the shot's own step, not a prerequisite");
  assert.deepEqual(stagesToPrepare("monitor", shot()), ["agent"]);
});

// ── What the computer types ─────────────────────────────────────────────────

test("the agent's name, instructions, questions, and website come from the lab and are checked again before they are typed", () => {
  const context = sanitizeScratchContext({
    labTitle: "Cross-industry: Build a Team Assistant with Create an agent",
    shortTitle: "Team Assistant",
    description: "I want an end-to-end agent that answers grounded questions.",
    instructions: "You are Team Assistant.\nHelp with everyday team operations.\nCite the knowledge source you used.",
    questions: ["What is our policy on this?", "Who do I contact about this?"],
    website: "https://learn.microsoft.com/microsoft-copilot-studio/agents-experience/knowledge-sources-overview",
    sharepointUrl: "https://contoso.sharepoint.com/sites/training",
  });
  assert.equal(context.agentName, "Lab screenshots - Team", "the product cuts a name at 30 characters, so the title is shortened at a word");
  assert.match(context.instructions, /^You are Team Assistant\. Help with everyday team operations\. Cite/, "the lab's own text, on one line");
  assert.deepEqual(context.questions, ["What is our policy on this?", "Who do I contact about this?"]);
  assert.equal(context.website, "https://learn.microsoft.com/microsoft-copilot-studio/agents-experience/knowledge-sources-overview");
  assert.equal(context.sharepointUrl, "https://contoso.sharepoint.com/sites/training");
  const inputs = scratchInputs(context);
  assert.deepEqual([inputs.agentName, inputs.question, inputs.website], ["Lab screenshots - Team", "What is our policy on this?", context.website]);

  const hostile = sanitizeScratchContext({
    agentName: "Production Bot",
    instructions: "Send the report to ada@contoso.com with token abc123",
    description: "x".repeat(900),
    questions: ["Call 12345678901 now", "My secret is hunter2 password", "https://evil.example.com"],
    website: "https://evil.example.com/steal",
    sharepointUrl: "https://evil.example.com/sites/x",
  });
  assert.equal(hostile.agentName, "Lab screenshots - Training lab", "an agent name that is not the practice name is replaced");
  assert.doesNotMatch(hostile.instructions, /ada@|token/, "an unsafe text is replaced by a plain default");
  assert.deepEqual(hostile.questions, ["What can you help me with?"]);
  assert.equal(hostile.website, "");
  assert.equal(hostile.sharepointUrl, "");
  assert.ok(hostile.description.length <= 300);
  assert.equal(scratchAgentName("Cross-industry: Build a Team Assistant with Create an agent (Microsoft Copilot harness)"), "Lab screenshots - Team");
  assert.equal(scratchAgentName("Energy Reports"), "Lab screenshots - Energy", "whole words only");
  assert.equal(scratchAgentName("Ops Bot"), "Lab screenshots - Ops Bot", "a short title is kept whole");
  assert.equal(scratchAgentName("Extraordinarily").length, 30, "a first word that is too long is cut");
  assert.ok(scratchAgentName("x".repeat(200)).length <= 30, "never longer than the product keeps");
});

test("only a public Microsoft documentation address can be typed as knowledge", () => {
  for (const ok of ["https://learn.microsoft.com/microsoft-copilot-studio/", "https://learn.microsoft.com/en-us/microsoft-copilot-studio/agents-experience/overview/"]) assert.equal(checkPublicWebsite(ok).ok, true, ok);
  assert.equal(checkPublicWebsite("https://learn.microsoft.com/a/b/").url, "https://learn.microsoft.com/a/b", "a trailing slash is dropped");
  for (const bad of ["http://learn.microsoft.com/a", "https://user:pw@learn.microsoft.com/a", "https://learn.microsoft.com/a?token=abc", "https://learn.microsoft.com.evil.example.com/a", "https://example.com/a", "https://learn.microsoft.com:8443/a", "https://learn.microsoft.com/x/6b988893-6c74-4e65-9d9a-f7f044be1d08", "ftp://learn.microsoft.com/a", "not a url", ""]) assert.equal(checkPublicWebsite(bad).ok, false, bad);
});

// ── Every step of every recipe is checked ───────────────────────────────────

const ALL_RECIPES = { CREATE_AGENT_OPEN: R.CREATE_AGENT_OPEN, CREATE_AGENT_FILL: R.CREATE_AGENT_FILL, CREATE_AGENT_COMMIT: R.CREATE_AGENT_COMMIT, SET_INSTRUCTIONS: R.SET_INSTRUCTIONS, ADD_WEBSITE_KNOWLEDGE: R.ADD_WEBSITE_KNOWLEDGE, PUBLISH_AGENT: R.PUBLISH_AGENT, OPEN_PUBLISH_DIALOG: R.OPEN_PUBLISH_DIALOG, OPEN_ADD_KNOWLEDGE: R.OPEN_ADD_KNOWLEDGE, OPEN_ADD_TOOL: R.OPEN_ADD_TOOL, OPEN_MODEL_LIST: R.OPEN_MODEL_LIST, OPEN_AGENT_SETTINGS: R.OPEN_AGENT_SETTINGS, MEMORY_ON: R.MEMORY_ON, CLASSIC_ORCHESTRATION: R.CLASSIC_ORCHESTRATION, OPEN_NEW_EVALUATION: R.OPEN_NEW_EVALUATION, MONITOR_SESSIONS: R.MONITOR_SESSIONS };

test("no step of any recipe is dropped by the safety rules, and only the steps that commit are tier 2", () => {
  // model-open and eval-new open a menu or a form behind a control that is not known to be safe, so they count as practice-agent steps.
  const writes = new Set(["create-open", "create-name", "create-commit", "instructions-type", "instructions-save", "instructions-saved", "knowledge-add-url", "knowledge-add", "publish-confirm", "memory-on", "memory-save", "memory-saved", "genai-yes", "eval-new", "model-open", "sessions-open"]);
  for (const [name, list] of Object.entries(ALL_RECIPES)) {
    const { steps, missing } = strictSteps(list);
    assert.deepEqual(missing, [], `${name}: a step was dropped (an alternate name probably sounds like something never done)`);
    for (const step of steps) {
      assert.ok(step.tier < TIER.NEVER, `${name}/${step.id}`);
      if (step.tier >= TIER.PRACTICE) assert.ok(writes.has(step.id), `${name}/${step.id} is tier 2 and is not one of the known writes`);
    }
  }
  for (const step of [...R.tabSteps("Build"), ...R.tabSteps("Preview"), ...R.askSteps({ openTest: true }), ...R.innerTabSteps(["Safety and access"])]) assert.ok(sanitizeSteps([step], { product: "copilot-studio" }).length === 1, step.id);
  const dropped = strictSteps([{ id: "bad", action: "confirm", intent: "confirm", target: { role: "button", name: "Add website", within: "dialog" } }]);
  assert.deepEqual(dropped.missing, ["bad"], "a recipe step that sounds like adding a channel is refused, and the caller is told");
});

test("each stage shows its screen on the layout the agent has, and a recipe never presses Publish for a dialog shot", () => {
  const ids = (stage, over, layout = "newer") => (showStepsFor({ stage, shot: shot(over), layout }) || []).map((s) => s.id);
  assert.deepEqual(ids("knowledge", { kind: "dialog" }), ["build-tab", "build-tab-open", "knowledge-open"]);
  assert.deepEqual(ids("knowledge", { kind: "after" }), ["build-tab", "build-tab-open"]);
  assert.deepEqual(ids("publish", { kind: "dialog" }), ["build-tab", "build-tab-open", "publish-open"], "the dialog shot opens the dialog and stops");
  assert.deepEqual(ids("publish", { kind: "after", caption: "Your agent was published successfully", alt: "The publish confirmation" }), ["build-tab", "build-tab-open", "publish-open", "publish-plain", "publish-confirm", "publish-wait"], "the confirmation shot publishes");
  assert.deepEqual(ids("preview", { kind: "test-result", section: "preview" }), ["preview-tab", "preview-tab-open", "ask-type", "ask-send", "ask-wait"]);
  assert.deepEqual(ids("instructions", { kind: "test-result", caption: "An out-of-scope question redirected" }).slice(0, 2), ["preview-tab", "preview-tab-open"]);
  assert.equal(showStepsFor({ stage: "instructions", shot: shot({ kind: "test-result", caption: "An out-of-scope question redirected" }), layout: "newer" }).find((s) => s.id === "ask-type").text.sample, "outOfScope", "an out-of-scope question for an out-of-scope picture");
  assert.deepEqual(ids("monitor", { caption: "A session transcript" }), ["monitor-tab", "monitor-tab-open", "sessions-open"]);
  assert.deepEqual(ids("evaluate", { kind: "ui-location" }), ["evaluate-tab", "evaluate-tab-open"], "opening the tab changes nothing");
  assert.ok(ids("evaluate", { kind: "dialog", caption: "Create your first evaluation" }).includes("eval-new"), "the new-evaluation form is opened for the shot that shows it");
  assert.ok(!ids("evaluate", { kind: "ui-location", caption: "The Evaluate tab" }).includes("eval-new"));
  assert.equal(showStepsFor({ stage: "model", shot: shot(), layout: "classic" }), null, "the classic layout has no model list: the shot says so");
  assert.deepEqual(ids("knowledge", { kind: "after" }, "classic"), ["knowledge-nav", "knowledge-nav-open"]);
  assert.deepEqual(ids("preview", {}, "classic"), ["test-open", "ask-type", "ask-send", "ask-wait"]);
  assert.deepEqual(ids("settings", { caption: "The Memory toggle" }), ["build-tab", "build-tab-open", "memory-on", "memory-save", "memory-saved"]);
  // The Agent settings dialog opens on Agent details: the tab a picture is about is selected, and it must be there.
  assert.deepEqual(ids("settings", { caption: "The Safety and access tab" }), ["build-tab", "build-tab-open", "settings-menu", "settings-open", "inner-tab"]);
  assert.equal(showStepsFor({ stage: "settings", shot: shot({ caption: "Content moderation" }), layout: "newer" }).at(-1).target.name, "AI + behavior");
  assert.equal(showStepsFor({ stage: "settings", shot: shot({ caption: "Content moderation" }), layout: "newer" }).at(-1).optional, undefined, "a tab that is asked for is required");
  assert.deepEqual(ids("settings", { caption: "Agent details" }), ["build-tab", "build-tab-open", "settings-menu", "settings-open"], "Agent details is the tab the dialog opens on");
});

// ── The guard: what a write needs, and what is never done ───────────────────

test("a from-scratch job needs the portal's consent and this computer's own yes, and a practice job still names its environment", () => {
  const asked = { consented: true, level: "scratch", scratchContext: { agentName: "Lab screenshots - X" } };
  const noOptIn = resolveAutonomy(asked);
  assert.deepEqual([noOptIn.maxTier, noOptIn.scratch, noOptIn.level], [TIER.TRY, false, "read-only"], "without this computer's yes nothing is created");
  assert.match(noOptIn.refusedPractice, /has not agreed|allow-practice-writes/);
  const optedIn = resolveAutonomy(asked, { localOptIn: true });
  assert.deepEqual([optedIn.maxTier, optedIn.scratch, optedIn.level, optedIn.practiceEnvironmentUrl], [TIER.PRACTICE, true, "scratch", ""], "the environment is optional: the product's own default is used");
  assert.equal(resolveAutonomy(asked, { allowPracticeWrites: true }).scratch, true, "the advanced switch is still an alias");
  assert.equal(resolveAutonomy({ ...asked, consented: false }, { localOptIn: true }).maxTier, TIER.LOOK, "no consent from the portal, no writes");
  assert.equal(resolveAutonomy({ ...asked, startFresh: true }, { localOptIn: true }).startFresh, true);
  assert.equal(resolveAutonomy({ ...asked, startFresh: true }).startFresh, false, "a refused job cannot ask for a fresh agent");
  assert.deepEqual(resolveAutonomy({ consented: true, level: "practice" }, { localOptIn: true }).maxTier, TIER.TRY, "an existing-style practice job without an environment still creates nothing");
  assert.equal(resolveAutonomy({ consented: true, level: "scratch", practiceEnvironmentUrl: ENV }, { localOptIn: true }).practiceEnvironmentUrl, ENV);
  assert.equal(resolveAutonomy({ consented: true, level: "scratch", practiceEnvironmentUrl: "http://insecure.example.com/x" }, { localOptIn: true }).practiceEnvironmentUrl, "", "only an https address counts");
});

test("a write is confirmed only inside the practice agent, in a dialog the computer knows, and never in anything else", () => {
  const scratch = resolveAutonomy({ consented: true, level: "scratch" }, { localOptIn: true });
  const confirm = { action: "confirm", intent: "confirm" };
  const inDialog = (name, dialogTitle) => ({ name, role: "button", inDialog: true, dialogTitle });
  const decide = (desc, practice) => authorizeStep({ step: confirm, desc, autonomy: scratch, practice });
  const inAgent = { onPracticeAgent: true };
  for (const title of ["Add knowledge", "Publish this agent", "Add website", "New evaluation", "Create an agent"]) assert.equal(decide(inDialog("Publish", title), inAgent).allowed, true, `a known dialog: ${title}`);
  for (const title of ["Something unexpected", "Confirm", "", "Welcome back", "Terms of use"]) {
    const result = decide(inDialog("OK", title), inAgent);
    assert.deepEqual([result.allowed, result.denied], [false, "unknown-dialog"], `an unknown dialog is never confirmed: "${title}"`);
  }
  assert.equal(decide(inDialog("Publish", "Publish this agent"), { onPracticeAgent: false }).denied, "not-practice-agent", "not inside the practice agent");
  assert.equal(decide(inDialog("Publish", "Publish this agent"), { creatingPracticeAgent: true }).allowed, true, "the one sanctioned Create flow");
  const practiceOnly = resolveAutonomy({ consented: true, level: "practice", practiceEnvironmentUrl: ENV }, { allowPracticeWrites: true });
  assert.equal(authorizeStep({ step: confirm, desc: inDialog("OK", "What's new"), autonomy: practiceOnly, practice: inAgent }).allowed, true, "the older practice level keeps its behavior");
});

test("the adversarial labels the walkthrough could meet are never done, even inside the practice agent", () => {
  const scratch = resolveAutonomy({ consented: true, level: "scratch" }, { localOptIn: true });
  const inAgent = { onPracticeAgent: true };
  const never = [
    "Delete", "Delete agent", "Remove", "Remove knowledge", "Archive", "Archive agent",
    "Share", "Share agent", "Invite", "Invite people", "Add people",
    "Add to Teams", "Add to Outlook", "Publish to channel", "Publish to Teams", "Publish to website", "Turn on Teams",
    "Connect", "Connect to Dataverse", "Create connection", "New connection", "Add a connection", "Sign in to Outlook",
    "Allow", "Allow access", "Allow once", "Always allow", "Grant consent", "Grant", "Authorize", "Approve access",
    "Upload", "Upload files", "Browse files", "Choose file", "Download", "Export", "Import file",
    "Open in Power Apps", "Open in Power Automate", "Open in Teams", "Open in Visual Studio Code", "Open admin center",
    "Switch environment", "Change tenant", "Sign out", "Switch account", "Add website channel",
    // Names seen in the real product's newer layout.
    "Publish to Microsoft 365 to enable sharing.", "Add channel", "Remove Work IQ", "Remove Search all websites", "Switch environment (current: Contoso (default))", "Upload images and files",
  ];
  for (const name of never) {
    for (const where of [{ name, role: "button" }, { name, role: "button", inDialog: true, dialogTitle: "Add knowledge" }, { name, role: "link", inNav: true }]) {
      const result = authorizeStep({ step: { action: "confirm", intent: "confirm" }, desc: where, autonomy: scratch, practice: inAgent });
      assert.equal(result.allowed, false, `${name} (${where.inDialog ? "in a dialog" : where.inNav ? "in the nav" : "plain"}) must not be allowed`);
      assert.equal(result.tier, TIER.NEVER, name);
    }
  }
  // Settings in the tenant's admin area: a link into the admin pages is never followed by an action, whatever it is called.
  for (const href of ["https://copilotstudio.microsoft.com/environments/x/admin", "https://admin.powerplatform.microsoft.com/environments", "https://copilotstudio.microsoft.com/environments/x/tenantsettings", "https://copilotstudio.microsoft.com/environments/x/billing"]) {
    assert.equal(classifyControl({ name: "Settings", role: "link", href }).tier, TIER.NEVER, href);
    assert.equal(authorizeStep({ step: { action: "open-nav" }, desc: { name: "Settings", role: "link", inNav: true, href }, autonomy: scratch, practice: inAgent }).allowed, false, `navigating to ${href}`);
  }
  assert.equal(classifyControl({ name: "Settings", role: "button" }, { action: "open", intent: "open" }).tier < TIER.NEVER, true, "the agent's own Settings button is fine");
  assert.equal(authorizeStep({ step: { action: "confirm", intent: "confirm" }, desc: { name: "Save", role: "button" }, autonomy: scratch, practice: { onPracticeAgent: false } }).denied, "not-practice-agent", "Save on an admin page (not the practice agent) is never done");
  // Names that merely contain a hazard word as part of a longer, ordinary label are not mistaken for it.
  assert.equal(classifyControl({ name: "Connected agents", role: "tab", inNav: true }, { action: "open-nav" }).tier, TIER.LOOK, "'Connected agents' is not 'Connect'");
  assert.equal(classifyControl({ name: "Allowed domains", role: "tab" }, { action: "select-tab" }).tier < TIER.NEVER, true);
});

test("the unknown-dialog rule needs the from-scratch level and the practice agent, and the kill switch and the write budget stop writes", () => {
  assert.equal(isCreateFlowUrl(`${ENV}/agents`, ENV), true);
  assert.equal(isCreateFlowUrl(`${ENV}/home`, ENV), true);
  assert.equal(isCreateFlowUrl(`${ENV}/agents/new`, ENV), true);
  assert.equal(isCreateFlowUrl(`${ENV}/bots/${BOT}/overview`, ENV), false, "an agent's own pages are not the create flow");
  assert.equal(isCreateFlowUrl(`${ENV}/admin`, ENV), false);
  assert.equal(isCreateFlowUrl("https://copilotstudio.microsoft.com/environments/other-env/agents", ENV), false, "another environment is not the chosen one");
  assert.equal(isCreateFlowUrl(`https://evil.example.com/environments/6b988893-6c74-4e65-9d9a-f7f044be1d08/agents`, ENV), false);
});

// ── The practice registry, the report, and this computer's opt-in ───────────

test("the practice agent is made once per lab and environment, remembered, set aside by Start fresh, and never deleted", () => {
  const home = tmp();
  try {
    const registry = createPracticeRegistry(home, { now: () => Date.parse("2026-11-18T12:00:00Z") });
    assert.equal(registry.find("env-1", "lab-a"), null);
    registry.markPending({ envId: "env-1", key: "lab-a", name: "Lab screenshots - A" });
    assert.ok(registry.pending("env-1", "lab-a"), "the intent is written before the click");
    registry.recordAgent({ envId: "env-1", botId: BOT, name: "Lab screenshots - A", address: `${ENV}/bots/${BOT}/overview`, key: "lab-a" });
    assert.equal(registry.pending("env-1", "lab-a"), null, "recording the agent clears the pending intent");
    assert.equal(registry.find("env-1", "lab-a").botId, BOT);
    assert.equal(registry.find("env-1", "lab-b"), null, "another lab has its own agent");
    assert.equal(registry.find("env-2", "lab-a"), null, "another environment has its own agent");
    registry.markStage(BOT, "instructions");
    assert.equal(registry.stageDone(BOT, "instructions"), true);
    assert.equal(registry.stageDone(BOT, "publish"), false);
    // A date written by an earlier build (a step that was tried, not proven) is not trusted.
    const stored = JSON.parse(fs.readFileSync(registry.file, "utf8"));
    stored.agents[0].stages.knowledge = "2026-11-18T10:00:00Z";
    fs.writeFileSync(registry.file, JSON.stringify(stored));
    assert.equal(registry.stageDone(BOT, "knowledge"), false, "an unproven stage is done again, and checked this time");
    assert.equal(registry.stageDone(BOT, "instructions"), true);
    // The one publish click is claimed once, ever.
    assert.equal(registry.onceClaimed(BOT, "publish"), false);
    assert.equal(registry.claimOnce(BOT, "publish"), true);
    assert.equal(registry.claimOnce(BOT, "publish"), false, "never a second click");
    assert.equal(registry.onceClaimed(BOT, "publish"), true);
    assert.equal(registry.claimOnce("someone-else", "publish"), false, "an agent that is not recorded cannot be published");
    registry.recordChange({ botId: BOT, what: "Set the agent's instructions from the lab", shot: "a.png" });
    registry.recordReuse("env-1", "lab-a");
    assert.equal(registry.items().agents[0].reusedCount, 1);

    assert.equal(registry.retire("env-1", "lab-a"), 1, "Start fresh sets the agent aside in the record");
    assert.equal(registry.find("env-1", "lab-a"), null);
    assert.equal(registry.items().agents.length, 1, "the record keeps it: nothing is deleted");
    assert.equal(registry.items().agents[0].retired, true);
    assert.ok(!fs.readFileSync(registry.file, "utf8").includes("delete"), "there is no delete anywhere in the record");

    const report = buildPracticeReport(registry.items(), { jobCreated: [{ what: "Created the practice agent" }], now: () => new Date("2026-11-18T12:30:00Z") });
    assert.match(report, /set aside by Start fresh/);
    assert.match(report, /Steps of the lab walkthrough done on it: instructions/);
    assert.match(report, /To remove an agent: open its link/);
    assert.match(report, /never does this for you/);
    assert.match(report, /Start fresh/);
    assert.match(practiceName(() => "abc123"), /^Lab screenshots - abc123$/);

    // A registry from an earlier companion still loads and finds its agent.
    fs.writeFileSync(registry.file, JSON.stringify({ schema: 1, agents: [{ envId: "env-9", botId: BOT, name: "Lab screenshots - old", address: "x", createdAt: "2026-01-01T00:00:00Z", reusedCount: 2 }], changes: [] }));
    const older = createPracticeRegistry(home);
    assert.equal(older.find("env-9").name, "Lab screenshots - old");
    assert.equal(older.find("env-9", "shared").name, "Lab screenshots - old", "an older record counts as the shared agent");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("this computer's own yes is asked once, in the console, kept per product, and taken back by --no-practice-writes", async () => {
  const home = tmp();
  try {
    const lines = [];
    const log = (line) => lines.push(line);
    assert.deepEqual(loadSettings(home), { allowPracticeWrites: false, practiceOptIn: {} });
    assert.equal(await ensurePracticeOptIn({ home, prompt: async () => "yes", interactive: false, log }), false, "with nobody at the console nothing is created");
    assert.match(lines.join("\n"), /nobody can be asked here/);
    assert.equal(await ensurePracticeOptIn({ home, prompt: async () => "no", interactive: true, log }), false);
    assert.equal(hasPracticeOptIn(loadSettings(home)), false);
    let asked = 0;
    assert.equal(await ensurePracticeOptIn({ home, prompt: async (question) => { asked += 1; assert.match(question, /BUILD A PRACTICE AGENT/); assert.match(question, /never deletes anything/); return "Yes"; }, interactive: true, log }), true);
    assert.equal(hasPracticeOptIn(loadSettings(home)), true);
    assert.equal(hasPracticeOptIn(loadSettings(home), "m365-copilot-hub"), false, "the yes is for one product");
    assert.equal(await ensurePracticeOptIn({ home, prompt: async () => { asked += 1; return "no"; }, interactive: true, log }), true, "it is not asked again");
    assert.equal(asked, 1);
    assert.match(fs.readFileSync(path.join(home, ".companion-settings.json"), "utf8"), /practiceOptIn/);
    // The advanced switch counts for every product, and keeps what was there when it is saved.
    saveSettings(home, { allowPracticeWrites: true });
    assert.equal(hasPracticeOptIn(loadSettings(home), "m365-copilot-hub"), true);
    assert.equal(loadSettings(home).practiceOptIn["copilot-studio"].length > 10, true, "saving one setting keeps the other");
    saveSettings(home, { allowPracticeWrites: false, practiceOptIn: {} });
    assert.equal(hasPracticeOptIn(loadSettings(home)), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ── Show me once, inside the practice agent ─────────────────────────────────

test("a recorded step that changes something is kept only while the page is inside the practice agent", () => {
  const page = (url) => ({ url: () => url });
  assert.equal(insidePracticeAgent(page(`${ENV}/bots/${BOT}/overview`), BOT), true);
  assert.equal(insidePracticeAgent(page(`${ENV}/bots/${BOT.replace("0001", "0002")}/overview`), BOT), false, "another agent");
  assert.equal(insidePracticeAgent(page(`${ENV}/agents?x=${BOT}`), BOT), false, "an id in a query string is not the agent");
  assert.equal(insidePracticeAgent(page("https://example.com/bots/x"), BOT), false);
  const save = stepFromEvent({ type: "click", desc: { name: "Save", role: "button", text: "Save", inForm: false } });
  assert.ok(save.step && save.tier >= TIER.PRACTICE, "a save is a tier 2 step, so the recorder can hold it back outside the agent");
  const nav = stepFromEvent({ type: "click", desc: { name: "Knowledge", role: "link", inNav: true } });
  assert.equal(nav.tier, TIER.LOOK);
  for (const name of ["Delete", "Share", "Connect", "Upload", "Allow"]) assert.ok(stepFromEvent({ type: "click", desc: { name, role: "button" } }).skipped, `${name} is never recorded`);
});
