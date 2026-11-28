// Setup plans: the steps that put a screen into the state a picture needs. These tests check that anything outside the
// declarative shape is dropped, that steps needing a practice agent are left out without one, that the built-in
// recipes are valid and match the shots they are written for, and that the dry run prints them tier by tier.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { dryRunLines, dryRunPlan } from "../dry-run.mjs";
import { BUILTIN_RECIPES, listBuiltinRecipes, matchBuiltinRecipe } from "../recipes-builtin.mjs";
import { describeStep, groupStepsByTier, progressPhrase, sanitizeSetup, sanitizeStep, sanitizeSteps, sanitizeTarget, stepsFromReveal } from "../setup-steps.mjs";

test("a step holds a role, a name, and an area, never a selector, a position, or a script", () => {
  const step = sanitizeStep({ id: "s1", action: "open", intent: "open", target: { role: "button", name: "Add knowledge", within: "main", selector: "#add", x: 10, y: 20, xpath: "//div" }, selector: "#x", script: "alert(1)", x: 4 });
  assert.deepEqual(Object.keys(step).sort(), ["action", "id", "intent", "note", "target", "tier"]);
  assert.deepEqual(step.target, { role: "button", name: "Add knowledge", within: "main" });
  assert.equal(sanitizeTarget({ selector: "#x" }), null);
  assert.equal(sanitizeTarget({ name: "https://contoso.sharepoint.com/sites/x" }), null, "a name is a label, never an address");
  assert.equal(sanitizeTarget({ name: "ada@contoso.com" }), null);
  assert.equal(sanitizeTarget({ name: "0f6c2d9a-3a54-4a64-8c61-5b1d7a2e9c11" }), null);
  assert.equal(sanitizeStep({ action: "eval", target: { name: "x" } }), null, "an unknown action is dropped");
  assert.equal(sanitizeStep({ action: "open" }), null, "a click with no target is dropped");
});

test("typed text is a kind of sample or a short harmless literal, never anything else", () => {
  assert.deepEqual(sanitizeStep({ action: "type", target: { role: "textbox", name: "Type your message", within: "chat" }, text: { sample: "question" } }).text, { sample: "question" });
  assert.deepEqual(sanitizeStep({ action: "type", target: { role: "textbox", name: "Name", within: "main" }, text: { literal: "Lab screenshots - 1a2b3c" } }).text, { literal: "Lab screenshots - 1a2b3c" });
  assert.equal(sanitizeStep({ action: "type", target: { role: "textbox", name: "Name" }, text: { literal: "ada@contoso.com" } }), null);
  assert.equal(sanitizeStep({ action: "type", target: { role: "textbox", name: "Name" }, text: { sample: "password" } }), null);
  assert.equal(sanitizeStep({ action: "type", target: { role: "textbox", name: "Name" } }), null);
});

test("a step the computer never does is dropped when the plan is read, whatever it says", () => {
  const steps = sanitizeSteps([
    { action: "click", target: { name: "Delete agent" } },
    { action: "open-nav", target: { name: "Sign out" } },
    { action: "open", intent: "open", target: { name: "Share" } },
    { action: "open-nav", target: { name: "Knowledge", within: "nav" } },
  ]);
  assert.deepEqual(steps.map((s) => s.target.name), ["Knowledge"]);
});

test("steps that need a practice agent are left out unless the job may carry them, and the plan says so", () => {
  const raw = {
    source: "builtin:cs.publish.confirmation",
    steps: [
      { id: "a", action: "open", intent: "open", target: { name: "Publish", within: "header" }, expect: { dialog: true } },
      { id: "b", action: "confirm", intent: "confirm", target: { name: "Publish", within: "dialog" } },
      { id: "c", action: "wait-for", practiceOnly: true, expect: { text: ["published"] } },
    ],
  };
  const without = sanitizeSetup(raw, { allowPractice: false, product: "copilot-studio" });
  assert.deepEqual(without.steps.map((s) => s.id), ["a"], "only the dialog is opened");
  assert.equal(without.needsPractice, true);
  assert.equal(without.limited.by, "practice-agent");
  assert.equal(without.maxTier, 1, "nothing above tier 1 is in the plan");
  const again = sanitizeSetup(without, { allowPractice: false, product: "copilot-studio" });
  assert.equal(again.limited?.by, "practice-agent", "a plan that was already narrowed still says so when it is read again");
  assert.equal(again.needsPractice, true);
  const withIt = sanitizeSetup(raw, { allowPractice: true, product: "copilot-studio" });
  assert.deepEqual(withIt.steps.map((s) => s.id), ["a", "b", "c"]);
  assert.equal(withIt.maxTier, 2);
  assert.equal(withIt.limited, undefined);
});

test("sample inputs, the summary, and the live progress sentence are plain and bounded", () => {
  const setup = sanitizeSetup({ steps: [{ action: "open-nav", target: { name: "Knowledge", within: "nav" } }, { action: "type", intent: "type", target: { role: "textbox", name: "Type your message", within: "chat" }, text: { sample: "question" } }], inputs: { question: "What is our leave policy?", search: "ada@contoso.com", unknown: "x" } }, { product: "copilot-studio" });
  assert.deepEqual(setup.inputs, { question: "What is our leave policy?" }, "unsafe or unknown inputs are dropped");
  assert.deepEqual(setup.summary, ["Opened Knowledge", "Typed a sample question"]);
  assert.equal(progressPhrase({ action: "send" }), "Asking the test pane a sample question");
  assert.equal(progressPhrase({ action: "open", target: { name: "Add knowledge" } }), "Opening “Add knowledge”");
  assert.equal(describeStep({ action: "wait-answer" }), "Waited for the answer");
});

test("older reveal lists become optional steps, and a reveal that would commit something is dropped", () => {
  const steps = stepsFromReveal([{ label: "Generative AI", required: true }, { label: "Publish", required: false }, { label: "Security", required: false }], "copilot-studio");
  assert.deepEqual(steps.map((s) => [s.target.name, Boolean(s.optional)]), [["Generative AI", false], ["Security", true]]);
});

test("every built-in recipe is valid: no step is dropped as unsafe, and tier 2 steps are only the ones that commit", () => {
  assert.ok(BUILTIN_RECIPES.length >= 8);
  for (const recipe of listBuiltinRecipes()) {
    const written = BUILTIN_RECIPES.find((r) => r.id === recipe.id);
    const expected = written.steps.length + (written.variants || []).reduce((n, v) => n + v.steps.length, 0);
    assert.equal(recipe.steps.length, expected, `${recipe.id}: every written step survives checking`);
    const ids = recipe.steps.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length, `${recipe.id}: step ids are unique`);
    for (const step of recipe.steps) {
      assert.ok(step.tier <= 2, `${recipe.id}/${step.id} is below tier 3`);
      if (step.tier === 2) assert.ok(["confirm", "create"].includes(step.action), `${recipe.id}/${step.id}: only a confirming step is tier 2`);
    }
  }
});

test("a built-in recipe is chosen from what the shot is about", () => {
  const pick = (shot) => matchBuiltinRecipe({ product: "copilot-studio", instructions: [], callouts: [], ...shot })?.id;
  assert.equal(pick({ kind: "test-result", section: "test", caption: "A test answer" }), "cs.test-pane.ask");
  assert.equal(pick({ caption: "The answer cites the knowledge source", alt: "Citations listed under the answer" }), "cs.knowledge.cited-answer");
  assert.equal(pick({ caption: "The Add knowledge dialog", kind: "dialog" }), "cs.knowledge.add-dialog");
  assert.equal(pick({ caption: "Add a tool", alt: "The tool picker" }), "cs.tools.add-dialog");
  assert.equal(pick({ caption: "The published confirmation message" }), "cs.publish.confirmation");
  assert.equal(pick({ caption: "The Publish dialog", alt: "the publish dialog before you confirm" }), "cs.publish.dialog");
  assert.equal(pick({ section: "home", alt: "The Home page with the natural-language description box" }), "cs.home.describe");
  assert.equal(pick({ section: "settings", caption: "The Settings page" }), undefined, "an ordinary screen needs no recipe");
  // Agent Builder: only its start screen has a recipe (the Agents menu, then New agent, proven by address and by content); the screens after it were never read on a real tenant.
  const builder = matchBuiltinRecipe({ product: "m365-copilot-agent-builder", filename: "dca-new-agent-page.png", caption: "The New agent page", instructions: [], callouts: [] });
  assert.deepEqual(builder.steps.map((s) => s.id), ["agents-flyout-open", "agents-menu-shown", "new-agent-open", "builder-address", "builder-start-shown"]);
  assert.equal(matchBuiltinRecipe({ product: "m365-copilot-agent-builder", filename: "dca-instructions-field.png", caption: "Write the instructions", instructions: [], callouts: [] }), null, "an Agent Builder screen nobody read has no recipe");
  assert.equal(matchBuiltinRecipe({ product: "sharepoint-ai", caption: "A site page" }), null, "a product with no recipe gets none");
});

test("the dry run lists every step tier by tier and says what is never done, without a browser", () => {
  const out = dryRunPlan(true);
  assert.equal(out.ok, true);
  const text = out.lines.join("\n");
  assert.match(text, /Tier 0, look/);
  assert.match(text, /Tier 1, try/);
  assert.match(text, /Tier 2, practice agent/);
  assert.match(text, /cs\.publish\.confirmation/);
  assert.match(text, /Confirmed “Publish” in the practice agent/);
  assert.match(text, /Tier 3 is never done/);
  assert.match(text, /Sign out, switch accounts/);
  const groups = groupStepsByTier(listBuiltinRecipes().find((r) => r.id === "cs.publish.confirmation").steps);
  assert.deepEqual([...groups].map(([tier, list]) => [tier, list.length]), [[0, 1], [1, 1], [2, 1]]);
});

test("the dry run of a job file leaves out what the job could not carry", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dry-")), "job.json");
  const shot = (setup) => ({ filename: "publish-confirmation.png", product: "copilot-studio", capture: { product: "copilot-studio", setup } });
  const steps = [
    { id: "a", action: "open", intent: "open", target: { name: "Publish", within: "header" }, expect: { dialog: true } },
    { id: "b", action: "confirm", intent: "confirm", target: { name: "Publish", within: "dialog" } },
  ];
  fs.writeFileSync(file, JSON.stringify({ job: { options: { autonomy: { consented: true, level: "read-only" } } }, shots: [shot({ source: "builtin:x", steps })] }));
  const readOnly = dryRunPlan(file).lines.join("\n");
  assert.match(readOnly, /never creates or changes anything/);
  assert.doesNotMatch(readOnly, /Confirmed/);
  assert.match(readOnly, /Limited: steps that need a practice agent are left out/);
  fs.writeFileSync(file, JSON.stringify({ job: { options: { autonomy: { consented: true, level: "practice" } } }, shots: [shot({ source: "builtin:x", steps })] }));
  assert.match(dryRunPlan(file).lines.join("\n"), /Confirmed “Publish” in the practice agent/);
  assert.equal(dryRunPlan(path.join(os.tmpdir(), "no-such-plan.json")).ok, false);
  assert.match(dryRunLines([], {}).join("\n"), /Tier 3 is never done/);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});
