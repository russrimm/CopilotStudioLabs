// What a person's recorded recipe may hold, what may be shared, and what a diagnostic file may say. Everything here
// is about not leaking: no tenant, no account, no address, no typed text beyond a harmless kind of sample.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildDiagnosticBundle, cleanControlName, diagnosticAdvice } from "../diagnostics.mjs";
import { buildPracticeReport, createPracticeRegistry, isPracticeName, practiceEnvironment, practiceName, summarizeCreated, writePracticeReport } from "../practice.mjs";
import { createRecipeStore, parseRecipeKey, recipeKey, recipeKeyForShot, sanitizeRecipe, shareProblems, toSharePayload, validateSharedRecipe } from "../recipes.mjs";
import { stepFromEvent } from "../recorder.mjs";

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "recipes-"));
const ctl = (name, extra = {}) => ({ name, role: "button", inNav: false, inDialog: false, inTestPane: false, landmarks: [], ...extra });

const GOOD = {
  key: { product: "copilot-studio", screen: "overview", slot: "test-pane-in-scope" },
  title: "Set up test-pane-in-scope.png",
  steps: [
    { action: "open", intent: "open", target: { role: "button", name: "Test", within: "header" } },
    { action: "type", intent: "type", target: { role: "textbox", name: "Type your message", within: "chat" }, text: { sample: "question" } },
    { action: "send", intent: "send", target: { role: "button", name: "Send", within: "chat" } },
    { action: "wait-answer" },
  ],
};

test("a recipe is keyed by product, screen, and the shot's slot", () => {
  assert.equal(recipeKey(GOOD.key), "copilot-studio/overview/test-pane-in-scope");
  assert.deepEqual(parseRecipeKey("copilot-studio/overview/test-pane-in-scope"), GOOD.key);
  assert.deepEqual(parseRecipeKey("m365-copilot-agent-builder/-/dca-new-agent-page"), { product: "m365-copilot-agent-builder", screen: "", slot: "dca-new-agent-page" });
  for (const bad of ["", "a/b", "a/b/c/d", "../x/y/z", "copilot-studio/overview/../x", "Copilot Studio/a/b"]) assert.equal(parseRecipeKey(bad), null, bad);
  assert.deepEqual(recipeKeyForShot({ filename: "Test-Pane-In-Scope.png", capture: { product: "copilot-studio", screen: { id: "overview" } } }), GOOD.key);
});

test("a stored recipe keeps checked steps only, and a failed replay makes it stale until it is recorded again", () => {
  const home = temp();
  const store = createRecipeStore(home);
  assert.equal(store.put({ key: GOOD.key, steps: [{ action: "open", target: { selector: "#x" } }] }), null, "nothing valid to keep");
  const saved = store.put(GOOD);
  assert.equal(saved.steps.length, 4);
  assert.ok(store.get(GOOD.key));
  store.markReplay(GOOD.key, false, "the Send button was not found");
  assert.equal(store.get(GOOD.key), null, "a stale recipe is not trusted");
  assert.equal(store.getAny(GOOD.key).stale, true);
  assert.equal(store.getAny(GOOD.key).failures, 1);
  store.put(GOOD);
  assert.ok(store.get(GOOD.key), "recording it again makes it fresh");
  store.markReplay(GOOD.key, true);
  assert.equal(store.getAny(GOOD.key).replays, 1);
  assert.equal(JSON.stringify(store.list()).includes(home), false, "the stored recipe holds no folder path");
  fs.rmSync(home, { recursive: true, force: true });
});

test("a recipe is shared only when nothing in it could identify a tenant or a person", () => {
  assert.deepEqual(shareProblems(GOOD), []);
  assert.equal(validateSharedRecipe(GOOD).ok, true);
  const withName = (name) => ({ ...GOOD, steps: [{ action: "open", target: { role: "button", name, within: "main" } }] });
  const refused = [
    ["a tenant or environment id", withName("Environment 6b988893-6c74-4e65-9d9a-f7f044be1d08")],
    ["an email address", withName("ada@contoso.com")],
    ["a web address with a query", withName("https://contoso.sharepoint.com/sites/x?e=abc")],
    ["a web address", withName("see www.contoso.com")],
    ["a tenant host", withName("contoso.onmicrosoft.com")],
    ["a long number", withName("Account 123456789")],
    ["a name that is a sentence", withName("x".repeat(90))],
    ["typed text", { ...GOOD, steps: [{ action: "type", target: { role: "textbox", name: "Name" }, text: { literal: "Ada Lovelace" } }] }],
    ["a tenant in the key", { ...GOOD, key: { ...GOOD.key, slot: "contoso.sharepoint.com" } }],
    ["a bad product", { ...GOOD, key: { ...GOOD.key, product: "Not A Product" } }],
    ["no steps", { ...GOOD, steps: [] }],
    ["a very long title", { ...GOOD, title: "t".repeat(200) }],
  ];
  for (const [what, recipe] of refused) {
    assert.ok(shareProblems(recipe).length > 0, `${what} is refused`);
    assert.equal(validateSharedRecipe(recipe).ok, false, what);
  }
  assert.ok(shareProblems(GOOD, { knownProducts: ["ai-foundry"] }).length > 0, "the portal only takes products it knows");
  const payload = toSharePayload({ ...GOOD, createdAt: "2026-01-01", recordedAt: "x", stale: false });
  assert.deepEqual(Object.keys(payload).sort(), ["key", "steps", "title", "version"]);
  assert.ok(payload.steps.every((s) => s.tier === undefined && s.note === undefined), "the shared form has no derived fields");
  assert.equal(sanitizeRecipe({ key: GOOD.key, steps: [{ action: "open", intent: "open", target: { name: "Delete agent" } }] }), null, "a step that is never done is not a recipe");
});

test("the recorder keeps clicks as roles and names, never coordinates, secrets, accounts, or an item's own name", () => {
  const step = (event, options) => stepFromEvent(event, options);
  assert.deepEqual(step({ type: "click", desc: ctl("Knowledge", { role: "link", inNav: true }) }).step.action, "open-nav");
  assert.equal(step({ type: "click", desc: ctl("Generative AI", { role: "tab" }) }).step.action, "select-tab");
  assert.deepEqual(step({ type: "click", desc: ctl("Send", { inTestPane: true }) }).after, { action: "wait-answer" }, "after a send the computer waits for the answer");
  assert.equal(step({ type: "click", desc: ctl("Cancel", { inDialog: true, dialogTitle: "Add knowledge" }) }).step.action, "close");
  assert.equal(step({ type: "click", desc: ctl("Add knowledge") }, { dialogOpened: true }).step.expect.dialog, true, "a click that opened a dialog is recorded as opening it");
  assert.equal(step({ type: "click", desc: ctl("Add to agent", { inDialog: true, dialogTitle: "Add knowledge" }) }).step.action, "confirm");
  const item = step({ type: "click", desc: ctl("Contoso HR Bot", { role: "link" }), inList: true, index: 2 });
  assert.deepEqual(item.step, { action: "open-item", intent: "navigate", target: { within: "main", nth: 2 } });
  assert.equal(JSON.stringify(item).includes("Contoso"), false, "the agent's own name is never recorded");
  for (const never of ["Sign out", "Delete agent", "Share", "Switch account"]) assert.match(step({ type: "click", desc: ctl(never) }).skipped, /never|not recorded/i, never);
  assert.match(step({ type: "click", desc: ctl("") }).skipped, /no name/);

  const typed = (value, extra = {}) => step({ type: "input", value, desc: ctl("Type your message", { role: "textbox", inTestPane: true, ...extra }) });
  assert.deepEqual(typed("What is our policy?").step.text, { sample: "question" }, "what was typed becomes a kind of sample, not the words");
  assert.equal(JSON.stringify(typed("What is our policy?")).includes("policy"), false);
  for (const risky of ["my secret token is abc", "write to ada@contoso.com"]) {
    const made = typed(risky);
    assert.deepEqual(made.step.text, { sample: "question" }, "risky words are never kept; only the kind of sample is");
    assert.equal(/secret|token|ada|contoso/i.test(JSON.stringify(made)), false, `${risky} left no trace in the step`);
  }
  assert.equal(step({ type: "click", desc: ctl("Chat panel", { inHeader: true }) }, { panelOpened: true }).step.expect.panel, true, "a click that opened a panel is recorded as opening it");
  assert.equal(step({ type: "click", desc: ctl("Chat panel", { inHeader: true }) }, { panelOpened: true }).step.action, "open");
  assert.equal(step({ type: "click", desc: ctl("Chat panel", { inHeader: true }) }).step.action, "confirm", "with no visible effect an unknown control stays a practice-agent step");
  assert.match(step({ type: "input", value: "", skipped: "password", desc: ctl("Password", { role: "textbox" }) }).skipped, /password/);
  assert.match(step({ type: "input", value: "hello", desc: ctl("Display name", { role: "textbox" }) }).skipped, /kind of sample/);
});

test("a diagnostic file holds control names and page paths only", () => {
  const bundle = buildDiagnosticBundle({
    url: "https://contoso-admin.sharepoint.com/environments/6b988893-6c74-4e65-9d9a-f7f044be1d08/bots/0f6c2d9a-3a54-4a64-8c61-5b1d7a2e9c11/knowledge?code=abc123&user=ada@contoso.com#frag",
    frames: [
      { index: 0, controls: [{ role: "button", name: "Add knowledge", area: "main", x: 3, y: 4 }, { role: "link", name: "Ada Lovelace ada@contoso.com", area: "header" }, { role: "link", name: "Account 1234567890", area: "header" }, { role: "button", name: "Contoso secret project", area: "main" }], dialogs: ["Add knowledge", "ada@contoso.com"] },
    ],
    step: { id: "knowledge-open", action: "open", tier: 1, target: { role: "button", name: "Add knowledge", alt: ["Add a knowledge source"], within: "main" }, expect: { dialog: true } },
    attempts: [{ strategy: "role-exact", found: 1, tried: 1, effect: false, note: "nothing changed https://x.example/?token=abc" }],
    product: "copilot-studio",
    shot: "knowledge-sharepoint-add.png",
    terms: ["Contoso"],
    companion: "1.3.0",
  });
  const text = JSON.stringify(bundle);
  for (const secret of ["ada@contoso.com", "Ada Lovelace", "6b988893", "0f6c2d9a", "abc123", "?code", "1234567890", "Contoso", "token=abc"]) assert.equal(text.includes(secret), false, `${secret} is not in the file`);
  assert.equal(bundle.page.host, "{tenant}-admin.sharepoint.com");
  assert.equal(bundle.page.path, "environments/{id}/bots/{id}/knowledge");
  assert.deepEqual(bundle.controls.map((c) => c.name), ["Add knowledge", "", "", ""], "a name that looks like data is blanked, never kept");
  assert.deepEqual(bundle.dialogs, ["Add knowledge"]);
  assert.equal(bundle.step.target.name, "Add knowledge");
  assert.equal(cleanControlName("Close", []), "Close");
  assert.match(diagnosticAdvice("C:\\x\\diag.json"), /Attach it to a report/);
  assert.match(diagnosticAdvice(null), /could not be saved/);
});

test("a control label that names the signed-in person or the environment is kept without the name", () => {
  assert.equal(cleanControlName("Open account menu for Ada Lovelace", []), "Open account menu for {name}");
  assert.equal(cleanControlName("Switch environment (current: Contoso Dev)", []), "Switch environment (current: {name})");
  assert.equal(cleanControlName("Signed in as Ada Lovelace", []), "Signed in as {name}");
  assert.equal(cleanControlName("Open account menu", []), "Open account menu", "a label with no name is left alone");
  const bundle = buildDiagnosticBundle({ frames: [{ index: 0, controls: [{ role: "button", name: "Open account menu for Ada Lovelace", area: "nav" }, { role: "button", name: "Switch environment (current: Contoso Dev)", area: "nav" }] }] });
  const text = JSON.stringify(bundle);
  for (const secret of ["Ada", "Lovelace", "Contoso"]) assert.equal(text.includes(secret), false, `${secret} is not in the file`);
});

test("the practice agent is the only thing the computer may change, it is named plainly, and everything it made is listed", () => {
  const home = temp();
  assert.match(practiceName(() => "ab12cd"), /^Lab screenshots - ab12cd$/);
  assert.equal(isPracticeName("Lab screenshots - 1a2b3c"), true);
  assert.equal(isPracticeName("Energy Assistant"), false, "an agent the person made is never one of ours");
  const registry = createPracticeRegistry(home);
  assert.equal(registry.find("env-1"), null);
  registry.recordAgent({ envId: "env-1", botId: "bot-1", name: "Lab screenshots - 1a2b3c", address: "https://copilotstudio.microsoft.com/environments/env-1/bots/bot-1/overview" });
  registry.recordChange({ botId: "bot-1", what: "Confirmed “Publish” in the practice agent", shot: "publish-confirmation.png" });
  assert.equal(registry.find("env-1").botId, "bot-1");
  registry.recordAgent({ envId: "env-2", botId: "x", name: "Energy Assistant", address: "" });
  assert.equal(registry.find("env-2"), null, "an agent without the prefix is not treated as ours");
  registry.recordReuse("env-1");
  assert.deepEqual(registry.jobLog.map((e) => [e.kind, e.reused]), [["agent", false], ["change", false], ["agent", false], ["agent", true]], "the job's own log: created, changed, created, reused");
  const report = buildPracticeReport(registry.items(), { jobCreated: summarizeCreated(registry.jobLog) });
  assert.match(report, /never deletes anything/);
  assert.match(report, /Lab screenshots - 1a2b3c/);
  assert.match(report, /Confirmed “Publish”/);
  assert.match(report, /delete them yourself/);
  const file = writePracticeReport(home, registry);
  assert.ok(fs.existsSync(file));
  assert.deepEqual(practiceEnvironment("https://copilotstudio.microsoft.com/environments/env-1/home"), { envBase: "https://copilotstudio.microsoft.com/environments/env-1", envId: "env-1", origin: "https://copilotstudio.microsoft.com" });
  assert.equal(practiceEnvironment("https://example.com/environments/env-1"), null);
  assert.equal(practiceEnvironment("https://copilotstudio.microsoft.com/"), null, "an address with no environment is not a practice environment");
  assert.equal(JSON.stringify(summarizeCreated(registry.jobLog)).includes("https://"), false, "what goes to the portal has no address");
  fs.rmSync(home, { recursive: true, force: true });
});
