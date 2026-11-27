// The Standard (Classic) harness rules that need no browser: the address shape of an agent page as evidence, the recipes written from the real Standard page (observed on a
// real tenant on 2026-11-26), the gate's view of the Instructions editor and of the unsaved-changes prompt, which screens end as Needs you instead of being guessed, and the
// one plain line logged before every picture.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { classicGapFor, showStepsFor, stagesToPrepare } from "../scratch.mjs";
import { resolveAutomation, resolveStage } from "../walkthrough.mjs";
import { familyShowSteps } from "../families.mjs";
import { classifyControl, TIER } from "../guard.mjs";
import { HARNESS_TABS_WORDS, harnessFromAddress, harnessReview, wrongHarnessPictureMessage } from "../harness.mjs";
import { takingLine, workPageOf } from "../harness-run.mjs";
import { matchBuiltinRecipe } from "../recipes-builtin.mjs";
import { harnessUnprovenMessage } from "../image-verify.mjs";
import * as R from "../scratch-recipes.mjs";
import { sanitizeSteps } from "../setup-steps.mjs";

const ENV = "6b988893-6c74-4e65-9d9a-f7f044be1d08";
const ID = "0f6c2d9a-3a54-4a64-8c61-5b1d7a2e9c11";
const ZERO = "00000000-0000-0000-0000-000000000000";
const steps = (raw) => sanitizeSteps(raw, { product: "copilot-studio" });

test("the address shape of an agent page names its harness on either host, and nothing else does", () => {
  assert.deepEqual(harnessFromAddress(`https://copilotstudio.microsoft.com/environments/${ENV}/agents/${ID}/preview`), { id: "microsoft-copilot", shape: "agents", host: "copilotstudio.microsoft.com", alsoPossible: ["customer-conversation"] });
  assert.equal(harnessFromAddress(`https://copilotstudio.preview.microsoft.com/environments/${ENV}/agents/${ID}`).id, "microsoft-copilot", "the same shape on the preview host");
  assert.equal(harnessFromAddress(`https://copilotstudio.preview.microsoft.com/environments/${ENV}/bots/${ID}/overview`).id, "standard");
  assert.equal(harnessFromAddress(`https://copilotstudio.microsoft.com/environments/${ENV}/bots/${ID}/actions`).id, "standard", "on either host");
  // What the companion sends the portal keeps the shape and masks the ids: the zero id is an id too.
  assert.equal(harnessFromAddress(`https://copilotstudio.microsoft.com/environments/${ZERO}/agents/${ZERO}/preview`).id, "microsoft-copilot");
  for (const none of [`https://copilotstudio.microsoft.com/environments/${ENV}/home`, `https://copilotstudio.microsoft.com/environments/${ENV}/agents`, `https://copilotstudio.microsoft.com/environments/${ENV}/agents/new?kind=standard`, `https://copilotstudio.microsoft.com/environments/${ENV}/agents/create`, "https://example.com/environments/x/agents/" + ID, "", "not an address"]) {
    assert.equal(harnessFromAddress(none), null, none);
  }
});

test("a picture with no proof is judged by its address: the other harness's shape is wrong-harness with the plain sentence, the proof wins over the address, and nothing is a guess", () => {
  const agents = `https://copilotstudio.microsoft.com/environments/${ENV}/agents/${ID}/preview`;
  const bots = `https://copilotstudio.preview.microsoft.com/environments/${ENV}/bots/${ID}/overview`;
  const wrong = harnessReview({ slotHarness: "standard", finalUrl: agents });
  assert.deepEqual([wrong.code, wrong.found, wrong.source], ["wrong-harness", "microsoft-copilot", "address"]);
  assert.equal(wrong.message, "This picture was taken in the Microsoft Copilot harness (Build, Preview, Evaluate, Monitor); this lab needs the Standard (Classic) harness.");
  assert.equal(harnessReview({ slotHarness: "microsoft-copilot", finalUrl: bots }).message, "This picture was taken in the Standard (Classic) harness (Overview, Knowledge, Tools, Topics); this lab needs the Microsoft Copilot harness.");
  // The address can only contradict: an agreeing address is not a proof.
  const agrees = harnessReview({ slotHarness: "standard", finalUrl: bots });
  assert.deepEqual([agrees.code, agrees.addressAgrees], ["harness-unproven", true]);
  assert.equal(harnessReview({ slotHarness: "standard", finalUrl: `https://copilotstudio.microsoft.com/environments/${ENV}/home` }).code, "harness-unproven");
  assert.equal(harnessReview({ slotHarness: "standard" }).code, "harness-unproven", "no evidence at all");
  // A Customer Conversation agent has the same address shape as a Microsoft Copilot one.
  assert.equal(harnessReview({ slotHarness: "customer-conversation", finalUrl: agents }).code, "harness-unproven");
  assert.equal(harnessReview({ slotHarness: "customer-conversation", finalUrl: bots }).code, "wrong-harness");
  // The proof the companion read from the page wins over the address.
  assert.equal(harnessReview({ slotHarness: "standard", proof: { id: "standard" }, finalUrl: agents }).code, "ok");
  assert.equal(harnessReview({ slotHarness: "standard", proof: "microsoft-copilot", finalUrl: bots }).code, "wrong-harness");
  assert.equal(harnessReview({ slotHarness: "standard", proof: "microsoft-copilot", finalUrl: bots }).source, "proof");
  assert.equal(harnessReview({ slotHarness: "either", finalUrl: agents }).code, "ok", "a screen that is the same in every harness is not judged");
  assert.equal(harnessReview({ slotHarness: null, finalUrl: agents }).code, "ok", "a product with no harnesses is not judged");
  assert.equal(wrongHarnessPictureMessage("standard", "either"), "");
  assert.ok(Object.values(HARNESS_TABS_WORDS).every((words) => !/[^\x20-\x7e]/.test(words)), "plain text");
});

test("the gate: the Instructions editor edits the agent, the unsaved-changes prompt can be answered with Discard, and no other dialog can", () => {
  const editor = { name: "Describe what you want this agent to do, its tone, and rules", role: "textbox", editable: true, tag: "div", landmarks: [], section: "Instructions" };
  assert.equal(classifyControl(editor, { action: "type", intent: "type" }).tier, TIER.PRACTICE, "typing in the editor needs the practice agent");
  assert.equal(classifyControl(editor, { action: "type", intent: "type" }).category, "edit-field");
  // The box on the Home page that only holds a draft is still a draft (nothing is submitted).
  assert.equal(classifyControl({ name: "Describe your agent", role: "textbox", editable: true, tag: "textarea", landmarks: [] }, { action: "type" }).tier, TIER.TRY);
  const testBox = { name: "Ask a question or describe what you need, Classic shots - Team", role: "textbox", editable: true, tag: "textarea", landmarks: [], inTestPane: true };
  assert.equal(classifyControl(testBox, { action: "type" }).tier, TIER.TRY, "the Test panel's box is a sample question");
  assert.equal(classifyControl({ name: "Edit Instructions", role: "button", tag: "button", landmarks: [] }, { action: "open", intent: "open" }).tier, TIER.TRY);
  assert.equal(classifyControl({ name: "Save", role: "button", tag: "button", landmarks: [] }, { action: "confirm", intent: "confirm" }).tier, TIER.PRACTICE);
  // Discard: allowed on the dialog that offers Close, Discard, and Cancel (observed 2026-11-26), whatever its title, and on a dialog titled like an unsaved prompt.
  const discard = (extra) => ({ name: "Discard", role: "button", tag: "button", inDialog: true, landmarks: [], dialogTitle: "", dialogButtons: ["Close", "Discard", "Cancel"], ...extra });
  assert.equal(classifyControl(discard(), { action: "discard", intent: "close" }).tier, TIER.TRY);
  assert.equal(classifyControl(discard({ dialogButtons: [], dialogTitle: "Unsaved changes" }), { action: "discard", intent: "close" }).tier, TIER.TRY);
  assert.equal(classifyControl(discard({ dialogButtons: ["Discard", "Delete everything"], dialogTitle: "" }), { action: "discard", intent: "close" }).tier, TIER.NEVER, "a dialog with another button is not the prompt");
  assert.equal(classifyControl(discard({ dialogButtons: ["Discard"], dialogTitle: "Delete this agent?" }), { action: "discard", intent: "close" }).tier, TIER.NEVER, "a destructive dialog is never answered");
  assert.equal(classifyControl(discard({ inDialog: false }), { action: "discard", intent: "close" }).tier, TIER.NEVER, "and Discard outside a dialog is never clicked");
});

test("the new step fields are kept, bounded, and cannot carry anything but plain names", () => {
  const [step] = steps([{ id: "t", action: "verify", target: { role: "button", name: "Save", within: "main", section: "Instructions" }, expect: { enabled: true }, ifDisabled: "the text did not register in the Instructions editor", orGone: true, findMs: 99_999, skipUnlessPresent: { role: "tab", name: "Activity", within: "tablist" } }]);
  assert.equal(step.target.section, "Instructions");
  assert.equal(step.expect.enabled, true);
  assert.equal(step.ifDisabled, "the text did not register in the Instructions editor");
  assert.equal(step.orGone, true);
  assert.equal(step.findMs, 60_000, "a wait is bounded");
  assert.equal(step.skipUnlessPresent.name, "Activity");
  const [odd] = steps([{ id: "t2", action: "verify", target: { role: "button", name: "Save", section: "<script>x</script>" }, ifDisabled: "see https://example.com/a" }]);
  assert.equal(odd.target.section, undefined, "a section is a heading, never markup");
  assert.equal(odd.ifDisabled, undefined, "and a note is never an address");
  assert.equal(steps([{ id: "t3", action: "verify", target: { role: "button", name: "Save" }, expect: { enabled: true, disabled: true } }])[0].expect.disabled, true, "enabled and disabled are never asked together");
});

test("the Standard recipes are written for the tab strip: no Build, Preview, Evaluate, or Monitor tab of the Microsoft Copilot harness is ever asked for", () => {
  const shot = (over = {}) => ({ kind: "ui-location", caption: "The agent", alt: "", instructions: [], callouts: [], ...over });
  const stages = ["agent", "instructions", "knowledge", "tools", "model", "preview", "evaluate", "publish", "monitor", "settings"];
  const microsoftCopilotIds = /^(?:build|preview|evaluate|monitor)-tab/;
  for (const stage of stages) {
    for (const over of [{}, { kind: "dialog" }, { kind: "test-result", caption: "An answer in the test pane" }, { caption: "Generative orchestration", kind: "settings" }]) {
      const list = showStepsFor({ stage, shot: shot(over), harness: "standard", layout: "newer" });
      for (const step of list || []) assert.ok(!microsoftCopilotIds.test(step.id), `${stage}/${step.id}`);
    }
  }
  // The pages of a Standard agent by name: five tabs on the strip, four more in the overflow menu, and Settings as a page of its own.
  const ids = (list) => list.map((s) => s.id);
  assert.deepEqual(ids(showStepsFor({ stage: "tools", shot: shot(), harness: "standard" })), ["cl-tools-tab", "cl-tools-tab-open"]);
  assert.deepEqual(ids(showStepsFor({ stage: "monitor", shot: shot(), harness: "standard" })), ["cl-monitor-tabs", "cl-monitor-tab", "cl-monitor-more", "cl-monitor-item", "cl-monitor-tab-open"], "Monitor is reached through the overflow menu");
  assert.deepEqual(ids(showStepsFor({ stage: "evaluate", shot: shot(), harness: "standard" })), ["cl-evaluation-tabs", "cl-evaluation-tab", "cl-evaluation-more", "cl-evaluation-item", "cl-evaluation-tab-open"]);
  assert.deepEqual(ids(showStepsFor({ stage: "settings", shot: shot({ caption: "Generative AI orchestration" }), harness: "standard" })), ["classic-settings-open", "classic-settings-link"]);
  assert.deepEqual(ids(showStepsFor({ stage: "settings", shot: shot({ caption: "The agent settings" }), harness: "standard" })), ["classic-settings-open"], "a Settings picture that names no link shows the page as it opens");
  assert.deepEqual(ids(showStepsFor({ stage: "preview", shot: shot(), harness: "standard" })), ["test-open", "ask-type", "ask-send", "ask-wait"], "the Test panel is on every tab: no tab is opened first");
  const asked = showStepsFor({ stage: "preview", shot: shot(), harness: "standard" });
  assert.equal(asked.find((s) => s.id === "ask-type").target.section, "Test your agent", "the Test panel's box is named by its panel");
  assert.equal(asked.find((s) => s.id === "ask-send").target.section, "Test your agent");
  const instr = [...R.classicTabSteps("Overview"), ...R.SET_INSTRUCTIONS_CLASSIC];
  assert.deepEqual(steps(instr).map((s) => s.id), ["cl-overview-tab", "cl-overview-tab-open", "instr-edit", "instr-editor", "instr-type", "instr-enabled", "instr-save", "instr-saved"]);
  assert.equal(steps(instr).find((s) => s.id === "instr-type").target.name, "Describe what you want this agent to do, its tone, and rules");
  assert.ok(!steps(instr).some((s) => s.target?.alt?.length && s.action === "type"), "a text box that is typed into has one exact name and no looser alternates");
  // A caller with no harness (an older plan) keeps the side navigation of an older classic build.
  assert.deepEqual(ids(showStepsFor({ stage: "tools", shot: shot(), layout: "classic" })), ["tools-nav", "tools-nav-open"]);
  // Families: the same tab strip.
  const dialog = familyShowSteps({ automation: { family: "dialog", opener: "knowledge", landmarks: [], choices: [] }, shot: shot({ kind: "dialog" }), harness: "standard", stage: "knowledge" });
  assert.deepEqual(ids(dialog.steps), ["cl-knowledge-tab", "cl-knowledge-tab-open", "knowledge-open"]);
  assert.equal(familyShowSteps({ automation: { family: "dialog", opener: "evaluation", landmarks: [], choices: [] }, shot: shot({ kind: "dialog" }), harness: "standard", stage: "evaluate" }), null, "the new evaluation form of a Standard agent has no recipe");
});

test("the overflow steps leave the strip alone when the tab is on it, and name the overflow control by its count, never as the lower left More options", () => {
  const list = R.classicTabSteps("Activity");
  const byId = Object.fromEntries(list.map((s) => [s.id, s]));
  assert.equal(byId["cl-activity-tab"].skipUnlessPresent.name, "Activity", "the tab is clicked only when it is on the strip");
  assert.equal(byId["cl-activity-more"].skipIfPresent.name, "Activity", "and the overflow is opened only when it is not");
  assert.equal(byId["cl-activity-item"].skipIfPresent.name, "Activity");
  const names = [byId["cl-activity-more"].target.name, ...byId["cl-activity-more"].target.alt];
  assert.ok(names.every((n) => /^\d more options?$/.test(n)), names.join(", "));
  assert.ok(!names.includes("More options"), "the lower left More options menu is never this control");
  assert.deepEqual(R.classicTabSteps("Knowledge").map((s) => s.id), ["cl-knowledge-tab", "cl-knowledge-tab-open"], "a tab that is always on the strip is clicked directly");
  assert.equal(byId["cl-activity-more"].action, "reveal", "the overflow control only opens a menu: a look, never a change");
});

test("screens of a Standard agent that were never seen, or that belong to another harness, end as Needs you with the exact reason, and the rest have a recipe", () => {
  const shot = (over = {}) => ({ kind: "ui-location", caption: "The agent", alt: "", instructions: [], callouts: [], ...over });
  assert.match(classicGapFor({ stage: "knowledge" }), /^The Add knowledge dialog of a Standard \(Classic\) agent has not been seen yet/);
  assert.equal(classicGapFor({ stage: "knowledge", shot: shot({ kind: "dialog" }) }), null, "the dialog is opened and left, which needs only the verified button");
  assert.match(classicGapFor({ stage: "testset" }), /new evaluation form of a Standard \(Classic\) agent has not been seen yet/);
  assert.match(classicGapFor({ stage: "evaluate", shot: shot({ caption: "Create your first evaluation" }) }), /has not been seen yet/);
  assert.equal(classicGapFor({ stage: "evaluate", shot: shot() }), null, "the Evaluation tab itself is a recipe");
  assert.match(classicGapFor({ stage: "monitor", shot: shot({ caption: "A session transcript" }) }), /sessions list/);
  assert.equal(classicGapFor({ stage: "monitor", shot: shot() }), null);
  assert.match(classicGapFor({ stage: "settings", shot: shot({ caption: "The Memory toggle" }) }), /Memory is a feature of the Microsoft Copilot harness/);
  assert.match(classicGapFor({ stage: "preview", shot: shot({ caption: "Open the Preview tab" }) }), /catalog harness-tag error/);
  assert.match(classicGapFor({ stage: "tools", shot: shot({ kind: "dialog" }), family: { family: "dialog", opener: "skill" } }), /Add skill dialog belongs to the Microsoft Copilot harness/);
  for (const stage of ["agent", "instructions", "tools", "model", "preview", "publish", "settings"]) assert.equal(classicGapFor({ stage, shot: shot() }), null, stage);
});

test("on a Standard agent a picture that does not show knowledge is not held back by the knowledge stage, and one that does is", () => {
  const shot = (over = {}) => ({ kind: "test-result", caption: "An in-scope question answered", alt: "", instructions: [], callouts: [], ...over });
  assert.ok(stagesToPrepare("preview", shot()).includes("knowledge"), "another harness (or none) still prepares it");
  assert.ok(!stagesToPrepare("preview", shot(), "standard").includes("knowledge"));
  assert.deepEqual(stagesToPrepare("preview", shot(), "standard"), ["agent", "instructions"]);
  assert.ok(stagesToPrepare("preview", shot({ caption: "An answer with a citation" }), "standard").includes("knowledge"));
  assert.ok(stagesToPrepare("knowledge", shot({ kind: "after" }), "standard").includes("knowledge"));
});

test("Settings links of a Standard agent are chosen by the words of the picture, and only from the links the real page has", () => {
  assert.equal(R.classicSettingsLinkFor("Turn on generative orchestration"), "Generative AI");
  assert.equal(R.classicSettingsLinkFor("Content moderation level"), "Generative AI");
  assert.equal(R.classicSettingsLinkFor("The authentication page"), "Security");
  assert.equal(R.classicSettingsLinkFor("The Voice settings"), "Voice");
  assert.equal(R.classicSettingsLinkFor("The agent details"), "Agent details");
  assert.equal(R.classicSettingsLinkFor("Something else"), null);
  for (const text of ["generative", "authentication", "connected agents", "connection settings", "authoring canvas", "entities", "skills", "voice", "language understanding", "languages", "component collections", "advanced", "agent details"]) {
    assert.ok(R.CLASSIC_SETTINGS_LINKS.includes(R.classicSettingsLinkFor(text)), text);
  }
  assert.deepEqual(R.classicSettingsLinkSteps(null), []);
});

test("one plain line says what is about to be taken: the harness, the host, the agent, and the proof", () => {
  assert.equal(takingLine({ wanted: "standard", address: "https://copilotstudio.preview.microsoft.com/environments/x/bots/y/overview", agentName: "Classic shots - Team", landmarks: ["Overview", "Knowledge", "Tools"] }), "Taking this picture in the Standard (Classic) harness: copilotstudio.preview.microsoft.com, agent Classic shots - Team, proof: Overview, Knowledge, Tools");
  assert.equal(takingLine({ wanted: "standard", address: "https://copilotstudio.preview.microsoft.com/environments/x/agents", outsideAgent: true }), "Taking this picture in the Standard (Classic) harness: copilotstudio.preview.microsoft.com, no agent (a screen outside the agent), proof: none by content, so the picture is saved for review");
  assert.equal(takingLine({ wanted: "microsoft-copilot", address: "https://copilotstudio.microsoft.com/environments/x/agents/y", landmarks: ["Build", "Preview", "Evaluate", "Monitor"] }), "Taking this picture in the Microsoft Copilot harness: copilotstudio.microsoft.com, agent (your own agent), proof: Build, Preview, Evaluate, Monitor");
  assert.equal(takingLine({ wanted: null }), "");
});

test("the page in use after the switch is the one the harness settled on, and a page that was closed is never returned", () => {
  const open = { isClosed: () => false };
  const closed = { isClosed: () => true };
  assert.equal(workPageOf({ harness: { workPage: open } }, closed), open);
  assert.equal(workPageOf({ harness: { workPage: closed } }, open), open, "the first tab was closed: the fallback is returned only if it is open");
  assert.equal(workPageOf({}, open), open);
  assert.equal(workPageOf(null, null), null);
});

test("how a Standard agent is started: the Agents list with More create options open is opened and shown, and nothing is chosen", () => {
  const shot = { filename: "create-agent-describe.png", product: "copilot-studio", section: "agents", kind: "ui-location", caption: "Where a Standard agent is created", alt: "The Agents page with the More create options menu open and the Agent, Standard option listed.", instructions: ["Open the **Agents** page (the list of agents, not an agent).", "Select **More create options**.", "With the menu open, keep **Agent, Standard** in view, and take the picture. Do not select it yet."] };
  const recipe = matchBuiltinRecipe(shot);
  assert.equal(recipe.id, "cs.agents.create-options");
  assert.equal(recipe.practice, false, "it needs no practice agent: it only opens a menu");
  assert.deepEqual(recipe.steps.map((s) => s.id), ["create-options-open", "create-options-shown"]);
  assert.ok(recipe.steps.every((s) => s.tier < TIER.PRACTICE), "nothing that changes anything");
  assert.notEqual(matchBuiltinRecipe({ ...shot, section: "home", caption: "The Home page", instructions: [] })?.id, "cs.agents.create-options", "only the Agents list");
  assert.equal(matchBuiltinRecipe({ ...shot, filename: "create-agent-describe.classic.png" })?.id, "cs.agents.create-options", "the library name that carries the harness is the same slot");
  assert.notEqual(matchBuiltinRecipe({ ...shot, filename: "copilot-studio-home.png", caption: "Copilot Studio home - agent list for the current environment" })?.id, "cs.agents.create-options", "a reused picture of the feature has the same lab step text and must not open the menu");
});

// ── Every slot of a Standard lab ────────────────────────────────────────────

const here = path.dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(fs.readFileSync(path.join(here, "..", "feature-shots.json"), "utf8"));
const slotKinds = JSON.parse(fs.readFileSync(path.join(here, "..", "..", "..", "portal", "lib", "lab-builder", "screenshot-slots.json"), "utf8"));
const standardSlots = catalog.shots.filter((s) => s.harness === "standard" || s.harness === "both").map((s) => ({ ...s, featureId: s.feature, kind: (slotKinds.slots || slotKinds)[s.filename]?.kind || s.kind || "", product: "copilot-studio" }));

test("every slot a Standard lab can take by itself has a Standard recipe or an exact reason it is left to a person, and none is written for the Microsoft Copilot tabs", () => {
  assert.equal(standardSlots.length, 80, "73 Standard slots and 7 that are tagged for both harnesses");
  const counts = { steps: 0, gap: 0, outside: 0, person: 0 };
  for (const shot of standardSlots) {
    const automation = resolveAutomation(shot);
    if (automation?.state !== "automatic") {
      counts.person += 1;
      continue;
    }
    const found = resolveStage(shot);
    if (!found.scoped) {
      // A screen outside the agent (Home, the Agents list): its picture is saved for review, and only the host is checked.
      counts.outside += 1;
      continue;
    }
    const family = automation.via === "family" ? automation : null;
    const gap = classicGapFor({ stage: found.stage, shot, family });
    if (gap) {
      assert.match(gap, /\.$/, shot.filename);
      assert.ok(!/[^\x20-\x7e\u2018-\u201d]/.test(gap), `${shot.filename}: plain text`);
      counts.gap += 1;
      continue;
    }
    const raw = family ? familyShowSteps({ automation: family, shot, harness: "standard", stage: found.stage })?.steps : showStepsFor({ stage: found.stage, shot, harness: "standard", website: "https://learn.microsoft.com/a" });
    assert.ok(raw?.length, `${shot.filename} is automatic and has neither a Standard recipe nor a reason`);
    const compiled = steps(raw);
    assert.equal(compiled.length, raw.length, `${shot.filename}: a step was dropped by the safety rules`);
    for (const step of raw) assert.ok(!/^(?:build|preview|evaluate|monitor)-tab/.test(step.id), `${shot.filename}/${step.id}`);
    counts.steps += 1;
  }
  assert.deepEqual(counts, { steps: 6, gap: 14, outside: 3, person: 57 }, "6 have a recipe (agent overview, instructions, Test panel question and refusal, model list, Topics tab), 14 end as Needs you with their own reason, 3 are outside the agent (saved for review), and the rest need a person");
});

test("the slots with their own Needs you reason are Standard slots that are automatic by the walkthrough, and the reason is the one a person reads", () => {
  const names = Object.keys(R.CLASSIC_UNSEEN_SLOTS);
  assert.equal(names.length, 14);
  for (const name of names) {
    const shot = standardSlots.find((s) => s.filename === name);
    assert.ok(shot, `${name} is a slot of a Standard lab`);
    assert.equal(resolveAutomation(shot).state, "automatic", `${name} would be taken by the walkthrough if it had no reason`);
    assert.match(classicGapFor({ stage: "other", shot }), new RegExp(`^${R.CLASSIC_UNSEEN_SLOTS[name].slice(0, 30).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.* Use “Retake guided”, or upload the picture\\.$`), name);
  }
  assert.equal(classicGapFor({ stage: "other", shot: { filename: "publish-confirmation.classic.png" } }), `${R.CLASSIC_UNSEEN_SLOTS["publish-confirmation.png"]} Use “Retake guided”, or upload the picture.`, "a library name that carries the harness is the same slot");
  assert.equal(classicGapFor({ stage: "agent", shot: { filename: "agent-overview.png", kind: "after" } }), null);
});

test("the Topics page of a Standard agent is a tab to open, and the authoring canvas is not", () => {
  const topics = standardSlots.find((s) => s.filename === "topics-list.png");
  assert.deepEqual([resolveStage(topics).stage, resolveStage(topics).scoped, resolveStage(topics).blocker], ["topics", true, null]);
  assert.deepEqual(showStepsFor({ stage: "topics", shot: topics, harness: "standard" }).map((s) => s.id), ["cl-topics-tab", "cl-topics-tab-open"]);
  assert.equal(showStepsFor({ stage: "topics", shot: topics, harness: "microsoft-copilot" }), null, "the Microsoft Copilot harness has no Topics tab");
  for (const name of ["trigger-phrases.png", "question-entity-node.png", "global-variables.png", "power-fx-formula.png"]) {
    const shot = standardSlots.find((s) => s.filename === name);
    assert.equal(resolveStage(shot).blocker, "build-first", name);
  }
});

test("a Home picture that nothing can prove says it is the shared Home and does not show the Standard create flow", () => {
  const text = harnessUnprovenMessage({ wanted: "standard", reached: { host: "copilotstudio.preview.microsoft.com", id: "standard", via: "click-path" } });
  assert.match(text, /shared Home, which looks the same in every harness/);
  assert.match(text, /does not show the Standard create flow/);
  assert.match(text, /^This screen is outside the agent/);
});