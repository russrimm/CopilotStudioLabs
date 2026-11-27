// Real-browser (headless) proof that the executor and the Standard (Classic) recipes work on a page shaped like the REAL Standard agent page, as observed on a real
// tenant on 2026-11-26 (read only): the Instructions card with Edit Instructions, the inline editor with a Save that stays disabled until the text changes, the Test
// panel with a second "describe" text box, the overflow menu of the tab strip (Activity, Evaluation, Monitor, Channels), and the Settings page.
// It runs against the pretend Copilot Studio (`realStandard` in fixtures/fake-product-site.mjs); no real tenant is touched, and every browser here is headless.
// Each test skips itself when no browser is installed.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createExecutor, fitsSection } from "../executor.mjs";
import { resolveAutonomy } from "../guard.mjs";
import { detectBrowserAvailability, loadPlaywrightModule } from "../lab-runner.mjs";
import * as R from "../scratch-recipes.mjs";
import { sanitizeSteps } from "../setup-steps.mjs";
import { FAKE_AGENT, FAKE_ENV_ID, FAKE_HOSTS, createFakeProductSite } from "./fixtures/fake-product-site.mjs";

const found = await detectBrowserAvailability();
const playwright = found.playwrightInstalled ? await loadPlaywrightModule() : null;
const skip = !found.available && "Playwright with Chromium is not installed";

const real = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const INSTRUCTIONS = "You help people find the right energy program. Answer only from the approved documents and say when you do not know.";
const AGENT_BASE = `https://${FAKE_HOSTS.previewStudio}/environments/${FAKE_ENV_ID}/bots/${FAKE_AGENT.id}`;
const steps = (raw) => {
  const compiled = sanitizeSteps(raw, { product: "copilot-studio" });
  // A step the safety rules dropped must never be skipped quietly (the walkthrough refuses such a recipe whole).
  assert.equal(compiled.length, raw.length, `every step is allowed: ${raw.filter((r) => !compiled.some((c) => c.id === r.id)).map((r) => r.id).join(", ")}`);
  return compiled;
};

async function withStandardPage(options, fn, { width = 1440, height = 900, path = "overview", executorOptions = {} } = {}) {
  const site = createFakeProductSite({ harnessMode: true, realStandard: true, defaultDelayMs: 30, chatDelayMs: 60, chatStreamMs: 60, ...options });
  const browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width, height } });
  await site.attach(context);
  try {
    const page = await context.newPage();
    await page.goto(`${AGENT_BASE}/${path}`);
    const autonomy = resolveAutonomy({ consented: true, level: "practice", practiceEnvironmentUrl: `https://${FAKE_HOSTS.studio}/environments/${FAKE_ENV_ID}/home` }, { allowPracticeWrites: true });
    const executor = createExecutor({
      page,
      autonomy,
      product: "copilot-studio",
      practice: { agentId: FAKE_AGENT.id, envId: FAKE_ENV_ID },
      inputs: { instructions: INSTRUCTIONS, question: "What can you help me with?" },
      sleep: real,
      findMs: 3000,
      effectMs: 2500,
      writeBudget: { count: 0, max: Infinity, gapMs: 0, last: 0 },
      ...executorOptions,
    });
    await fn({ site, page, executor, context });
  } finally {
    await browser.close();
  }
}

const failedStep = (result) => result.steps.find((s) => s.status === "failed");

test("the old Instructions recipe cannot set the instructions on the real Standard page (today's failure), and writes nothing", { skip, timeout: 120_000 }, async () => {
  await withStandardPage({}, async ({ site, executor, page }) => {
    // The old recipe never clicks Edit Instructions and names a text box ("Agent instructions") that the real page does not have.
    const result = await executor.run(steps(R.SET_INSTRUCTIONS));
    assert.equal(result.ok, false, "the old recipe fails on the real-shaped page");
    assert.deepEqual(site.stats.instructions, [], "and nothing was saved");
    assert.equal(await page.locator("#chat-input").inputValue(), "", "the Test panel's text box was not typed into");
  });
});

test("the Standard Instructions recipe: Edit Instructions, type in the editor, read the text back, Save becomes available, Save, and Save is disabled again", { skip, timeout: 120_000 }, async () => {
  await withStandardPage({}, async ({ site, executor, page }) => {
    const result = await executor.run(steps([...R.classicTabSteps("Overview"), ...R.SET_INSTRUCTIONS_CLASSIC]));
    assert.equal(result.ok, true, JSON.stringify(result.failed));
    assert.deepEqual(site.stats.instructions, [INSTRUCTIONS], "the lab's instructions were saved once");
    assert.deepEqual(site.stats.dangers, [], "and nothing the computer must never touch was touched");
    assert.equal(await page.locator("#instr-save").isDisabled(), true, "Save is disabled again: the product's own proof of the save");
    assert.equal(await page.locator("#chat-input").inputValue(), "", "the Test panel's text box was not typed into");
    const type = result.steps.find((s) => s.id === "instr-type");
    // Which text box received the text, and that it read back from it.
    assert.deepEqual({ name: type.typed.name, section: type.typed.section, inTestPane: type.typed.inTestPane, readback: type.typed.readback }, { name: "Describe what you want this agent to do, its tone, and rules", section: "Instructions", inTestPane: false, readback: "ok" });
    assert.match(type.strategy, /role-exact/);
    assert.equal(result.steps.find((s) => s.id === "instr-enabled").status, "ok");
  });
});

test("an editor that closes itself after Save is also a saved state", { skip, timeout: 120_000 }, async () => {
  await withStandardPage({ saveClosesEditor: true }, async ({ site, executor }) => {
    const result = await executor.run(steps([...R.classicTabSteps("Overview"), ...R.SET_INSTRUCTIONS_CLASSIC]));
    assert.equal(result.ok, true, JSON.stringify(result.failed));
    assert.deepEqual(site.stats.instructions, [INSTRUCTIONS]);
    assert.match(result.steps.find((s) => s.id === "instr-saved").effect, /gone/);
  });
});

test("a Save that stays disabled is named as such, nothing is saved, and the unsaved editor is left", { skip, timeout: 120_000 }, async () => {
  await withStandardPage({ editorIgnoresInput: true }, async ({ site, executor, page }) => {
    const result = await executor.run(steps([...R.classicTabSteps("Overview"), ...R.SET_INSTRUCTIONS_CLASSIC]));
    assert.equal(result.ok, false);
    assert.equal(result.failed.id, "instr-enabled");
    assert.equal(result.failed.why, "Save is disabled: the text did not register in the Instructions editor", "the cause is the disabled Save, in plain words, not a timeout");
    assert.deepEqual(site.stats.instructions, []);
    // The text is in the editor (it read back), which is what the diagnosis says: it was typed into the Instructions editor, not elsewhere.
    const type = result.steps.find((s) => s.id === "instr-type");
    assert.equal(type.typed.section, "Instructions");
    assert.equal(type.typed.readback, "ok");
    await executor.run(steps(R.ABANDON_INSTRUCTIONS_EDIT));
    assert.equal(await page.locator("#instr-editor").isHidden(), true, "the editor was closed again");
  });
});

test("Cancel after a change opens the Close, Discard, Cancel confirmation, and the abandon steps answer it with Discard (nothing is saved)", { skip, timeout: 120_000 }, async () => {
  await withStandardPage({}, async ({ site, executor, page }) => {
    const typed = await executor.run(steps([...R.classicTabSteps("Overview"), ...R.SET_INSTRUCTIONS_CLASSIC.slice(0, 4)]));
    assert.equal(typed.ok, true, JSON.stringify(typed.failed));
    assert.equal(await page.locator("#instr-save").isDisabled(), false, "the change registered");
    const left = await executor.run(steps(R.ABANDON_INSTRUCTIONS_EDIT));
    assert.equal(left.ok, true, JSON.stringify(left.failed));
    assert.equal(site.stats.discards, 1, "Discard was chosen on the confirmation");
    assert.deepEqual(site.stats.instructions, []);
    assert.equal(await page.locator("#instr-editor").isHidden(), true);
    assert.equal(await page.locator("#r-confirm").isHidden(), true);
  });
});

test("a text box is never typed into by a loose name: the Test panel's text box also says describe, and a step scoped to the Instructions card finds only the Instructions box", { skip, timeout: 120_000 }, async () => {
  await withStandardPage({}, async ({ site, executor, page }) => {
    // The editor is closed, so the Instructions box does not exist. The words "describe" and "instructions" are all over the Test panel's box: a type step that names the
    // Instructions card must not use it (the old fuzzy search did).
    const type = { id: "type-loose", action: "type", intent: "type", target: { role: "textbox", name: "Describe what you want this agent to do, its tone, and rules", alt: ["Instructions", "Describe"], within: "any", section: "Instructions" }, text: { sample: "instructions" } };
    const result = await executor.run(steps([type]));
    assert.equal(result.ok, false);
    assert.equal(await page.locator("#chat-input").inputValue(), "", "nothing was typed into the Test panel's text box");
    assert.deepEqual(site.stats.instructions, []);
    // Scoped to the Test panel, the same kind of words find the panel's own box.
    const panel = await executor.run(steps([{ id: "ask-type", action: "type", intent: "type", target: { role: "textbox", name: "Ask a question or describe what you need", within: "any", section: R.CLASSIC_TEST_SECTION }, text: { sample: "question" } }]));
    assert.equal(panel.ok, true, JSON.stringify(panel.failed));
    assert.equal(await page.locator("#chat-input").inputValue(), "What can you help me with?");
    assert.equal(panel.steps[0].typed.inTestPane, true);
  });
});

test("a step scoped to a card never acts on a control of another card", () => {
  assert.equal(fitsSection({ section: "Instructions", landmarks: [], inTestPane: false }, "Instructions"), true);
  assert.equal(fitsSection({ section: "Test your agent", landmarks: [], inTestPane: true }, "Instructions"), false, "the Test panel is not the Instructions card");
  assert.equal(fitsSection({ section: "Details", landmarks: [], inTestPane: false }, "Instructions"), false);
  assert.equal(fitsSection({ section: "", landmarks: ["Instructions card"], inTestPane: false }, "Instructions"), true, "a landmark label can name it");
  assert.equal(fitsSection({ section: "", landmarks: [], inTestPane: false }, "Instructions"), true, "a card with no heading is not ruled out");
  assert.equal(fitsSection({ section: "", landmarks: [], inTestPane: true }, "Instructions"), false, "but the Test panel always is");
});

test("the Test panel is asked with the panel's own box and Send, an answer is waited for, and the Instructions editor is untouched", { skip, timeout: 120_000 }, async () => {
  await withStandardPage({}, async ({ site, executor, page }) => {
    const result = await executor.run(steps(R.askSteps({ openTest: true, classic: true })));
    assert.equal(result.ok, true, JSON.stringify(result.failed));
    assert.equal(site.stats.answers, 1);
    assert.match(await page.locator("#chat").innerText(), /Agent: Here is an answer/);
    assert.equal(await page.locator("#instr-editor").isHidden(), true);
  });
});

for (const [width, label] of [[1440, "1440 pixels wide: Activity and Evaluation are tabs of their own"], [1200, "1200 pixels wide: all four are in the overflow menu"]]) {
  test(`the tab navigation reaches Activity, Evaluation, Monitor, and Channels at ${label}`, { skip, timeout: 180_000 }, async () => {
    await withStandardPage({}, async ({ page, executor }) => {
      const wide = width >= 1400;
      const overflow = await page.getByRole("tab", { name: /more options/i }).first().getAttribute("aria-label");
      assert.equal(overflow, wide ? "2 more options" : "4 more options");
      assert.equal(await page.getByRole("tab", { name: "Activity", exact: true }).isVisible(), wide, "Activity is a tab only at the wider window");
      for (const tab of ["Activity", "Evaluation", "Monitor", "Channels"]) {
        // From another tab, so that the page really changes.
        const away = await executor.run(steps(R.classicTabSteps("Topics")));
        assert.equal(away.ok, true, JSON.stringify(away.failed));
        const result = await executor.run(steps(R.classicTabSteps(tab)));
        assert.equal(result.ok, true, `${tab}: ${JSON.stringify(result.failed)}`);
        assert.match(page.url(), new RegExp(`/bots/${FAKE_AGENT.id}/${tab.toLowerCase()}$`), tab);
        assert.equal(await page.locator("h1").first().innerText(), tab);
        const direct = wide && ["Activity", "Evaluation"].includes(tab);
        assert.equal(result.steps.find((s) => s.id.endsWith("-more"))?.effect === "already there", direct, `${tab} was ${direct ? "clicked on the strip" : "reached through the overflow menu"}`);
      }
    }, { width });
  });
}

test("the tabs that are always on the strip (Knowledge, Tools, Agents, Topics) are clicked by name and proven selected, and Settings opens its own page with its links", { skip, timeout: 180_000 }, async () => {
  await withStandardPage({}, async ({ page, executor }) => {
    for (const [tab, slug] of [["Knowledge", "knowledge"], ["Tools", "actions"], ["Agents", "agents"], ["Topics", "topics"]]) {
      const result = await executor.run(steps(R.classicTabSteps(tab, { alt: tab === "Tools" ? ["Actions"] : [] })));
      assert.equal(result.ok, true, `${tab}: ${JSON.stringify(result.failed)}`);
      assert.match(page.url(), new RegExp(`/bots/${FAKE_AGENT.id}/${slug}$`));
    }
    const settings = await executor.run(steps([...R.CLASSIC_OPEN_SETTINGS, ...R.classicSettingsLinkSteps(R.classicSettingsLinkFor("Turn on generative orchestration"))]));
    assert.equal(settings.ok, true, JSON.stringify(settings.failed));
    assert.match(page.url(), /\/manage\/advancedSettings$/);
    assert.equal(await page.locator("[aria-current=page]").innerText(), "Generative AI");
    assert.equal(await page.getByRole("button", { name: "Save", exact: true }).isDisabled(), true, "the Settings page was only opened: nothing on it changed");
  });
});

test("the model list is a combobox on the Overview tab: it is opened and nothing is chosen", { skip, timeout: 120_000 }, async () => {
  await withStandardPage({}, async ({ executor, site }) => {
    const result = await executor.run(steps([...R.classicTabSteps("Overview"), ...R.CLASSIC_OPEN_MODEL_LIST]));
    assert.equal(result.ok, true, JSON.stringify(result.failed));
    assert.deepEqual(site.stats.writes, []);
  });
});
