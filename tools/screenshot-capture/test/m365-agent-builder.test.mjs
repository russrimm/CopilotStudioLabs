// Microsoft 365 Copilot Agent Builder captures (the dca- pictures), written from what a real tenant showed on 2026-11-27 (read only, 1440 by 900): the side bar BUTTON Agents opens a flyout
// dialog named "Agents menu" with a LINK "New agent" that goes to /agents/new, a start screen with the heading "Build your own specialist agent" and the text box "Message Agent Builder",
// and no Describe or Configure tab. This file proves, in a real headless browser on a pretend site shaped like that (fixtures/fake-m365-copilot-site.mjs, no real tenant), that the old recipe
// failed the way the real run did and the new one passes only when the expected effect is seen, and, without a browser, that every screen nobody read ends as Needs you with its exact reason.
// Each browser test skips itself when no Chromium is installed.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { failureMessage, runShotSetup } from "../autonomous.mjs";
import { createCaptureSession } from "../capture-run.mjs";
import { createExecutor } from "../executor.mjs";
import { resolveAutonomy } from "../guard.mjs";
import { detectBrowserAvailability, loadPlaywrightModule } from "../lab-runner.mjs";
import { AGENT_BUILDER_START_SLOT, AGENT_BUILDER_UNSEEN_SLOTS, BUILTIN_RECIPES, agentBuilderUnseenReason, matchBuiltinRecipe } from "../recipes-builtin.mjs";
import { sanitizeSteps } from "../setup-steps.mjs";
import { describeAutomation } from "../walkthrough.mjs";
import { FAKE_M365_HOME_URL, FAKE_M365_NEW_AGENT_URL, FAKE_M365_START_URL, createFakeM365CopilotSite } from "./fixtures/fake-m365-copilot-site.mjs";

const found = await detectBrowserAvailability();
const playwright = found.playwrightInstalled ? await loadPlaywrightModule() : null;
const skip = !found.available && "Playwright with Chromium is not installed";
const real = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PRODUCT = "m365-copilot-agent-builder";
const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(here, "..", "feature-shots.m365-copilot-agent-builder.json"), "utf8"));
const shotOf = (file) => manifest.shots.find((s) => s.filename === file);
const planShot = (file, extra = {}) => ({ ...shotOf(file), product: PRODUCT, capture: { version: 1, mode: "guided", product: PRODUCT, route: { kind: "url" }, reveal: [] }, ...extra });

/** The recipe this change replaced, as it was (a button named Create agent in the main area), so the failure it had on the real page can be reproduced. */
const OLD_RECIPE = [
  { id: "agents-nav", action: "open-nav", target: { name: "Agents", alt: ["Agent store", "All agents"], within: "nav" } },
  { id: "builder-open", action: "open", intent: "open", target: { role: "button", name: "Create agent", alt: ["New agent", "Create an agent"], within: "main" }, expect: { text: ["Describe", "Configure"] } },
];

async function withSite(options, fn, { start = FAKE_M365_HOME_URL, findMs = 1000 } = {}) {
  const site = createFakeM365CopilotSite({ homeDelayMs: 120, ...options });
  const browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await site.attach(context);
  try {
    const page = await context.newPage();
    await page.goto(start);
    const executor = createExecutor({ page, autonomy: resolveAutonomy({ consented: true, level: "read-only" }), product: PRODUCT, inputs: {}, sleep: real, findMs, effectMs: 1200, writeBudget: { count: 0, max: Infinity, gapMs: 0, last: 0 } });
    await fn({ site, page, executor });
    // A request that escaped the pretend site would end at the real sign-in page (which the pretend site would then answer): none did.
    assert.equal(site.stats.loginPages, 0, "no request left the pretend site");
    assert.deepEqual(site.stats.blocked, [], "no address outside the product's own sites was asked for");
  } finally {
    await browser.close();
  }
}

const compiled = (raw) => {
  const steps = sanitizeSteps(raw, { product: PRODUCT });
  assert.equal(steps.length, raw.length, "every step is allowed by the safety rules");
  return steps;
};
const newRecipeSteps = () => matchBuiltinRecipe(planShot(AGENT_BUILDER_START_SLOT)).steps;
const failedOf = (result) => result.steps.find((s) => s.status === "failed");
/** The sentence the person reads for a failed run, composed the way the companion composes it (the failed step's own plain name first). */
const plainFailure = (result) => failureMessage({ ...result.failed, step: result.steps.at(-1)?.summary || result.failed?.id });

// ── The recipe (no browser) ─────────────────────────────────────────────────

test("the start screen has one recipe: the Agents menu, the New agent link, and proof by address and by content; no tab, template, Skip, Send, or sources step", () => {
  const recipe = matchBuiltinRecipe(planShot(AGENT_BUILDER_START_SLOT));
  assert.equal(recipe.id, "m365.agent-builder.open");
  assert.deepEqual(recipe.steps.map((s) => [s.id, s.action, s.target?.role || null, s.target?.name || null, s.target?.within || null, s.tier]), [
    ["agents-flyout-open", "open", "button", "Agents", "any", 1],
    ["agents-menu-shown", "verify", "dialog", "Agents menu", "any", 0],
    ["new-agent-open", "open-nav", "link", "New agent", "dialog", 1],
    ["builder-address", "wait-for", null, null, null, 0],
    ["builder-start-shown", "verify", null, "Build your own specialist agent", "any", 0],
  ]);
  assert.deepEqual(recipe.steps.find((s) => s.id === "builder-address").expect, { urlPath: "/agents/new" });
  assert.deepEqual(recipe.steps.find((s) => s.id === "builder-start-shown").target.alt, ["Message Agent Builder"], "the heading or the message box proves the screen by content");
  assert.ok(recipe.steps.every((s) => s.tier <= 1), "nothing is created, saved, or sent");
  const names = JSON.stringify(recipe.rawSteps);
  for (const never of ["Skip", "Send", "template", "Add and manage sources", "Describe", "Configure", "Create agent", "Publish", "Save"]) assert.doesNotMatch(names, new RegExp(never), `the recipe never names ${never}`);
  const written = BUILTIN_RECIPES.find((r) => r.id === "m365.agent-builder.open");
  assert.equal(written.variants, undefined, "the Configure, Describe, and Add knowledge variants are gone: those controls were not seen");
});

test("only the start screen gets the recipe; every other Agent Builder slot, and a harness-tagged name of the start screen, is matched by its file name", () => {
  const ids = manifest.shots.map((s) => [s.filename, matchBuiltinRecipe(planShot(s.filename))?.id || null]);
  assert.deepEqual(ids.filter(([, id]) => id), [[AGENT_BUILDER_START_SLOT, "m365.agent-builder.open"]]);
  assert.equal(matchBuiltinRecipe({ product: PRODUCT, filename: "dca-new-agent-page.classic.png", caption: "x", instructions: [] })?.id, "m365.agent-builder.open");
  assert.equal(matchBuiltinRecipe({ product: "copilot-studio", filename: AGENT_BUILDER_START_SLOT, caption: "x", instructions: [] }), null, "another product never gets it");
  assert.equal(describeAutomation(planShot(AGENT_BUILDER_START_SLOT), { capture: planShot(AGENT_BUILDER_START_SLOT).capture }).state, "automatic");
  assert.equal(describeAutomation(planShot("dca-configure-tab-prepopulated.png"), { capture: planShot("dca-configure-tab-prepopulated.png").capture }).state, "person");
});

test("every step of the recipe has a plain message that fits a job row", () => {
  for (const step of newRecipeSteps()) {
    const message = failureMessage({ id: step.id, action: step.action, code: "step-failed", why: "the control was not found or did nothing", step: step.note });
    assert.ok(message.length <= 300, `${step.id}: ${message.length} characters`);
    assert.doesNotMatch(message, /^The computer could not complete/, `${step.id} says what the page showed and what was expected, not the generic sentence`);
    assert.match(message, /Use “Retake guided”/);
  }
});

// ── Screens nobody read: Needs you with the exact reason (no browser) ───────

test("every other dca slot has its own plain reason, and the start screen has none", () => {
  const files = manifest.shots.map((s) => s.filename);
  assert.equal(files.length, 43);
  assert.deepEqual(files.filter((f) => !AGENT_BUILDER_UNSEEN_SLOTS[f] && f !== AGENT_BUILDER_START_SLOT), [], "every slot is either the start screen or has a reason");
  assert.deepEqual(Object.keys(AGENT_BUILDER_UNSEEN_SLOTS).filter((f) => !files.includes(f)), [], "and no reason is for a slot that does not exist");
  assert.equal(agentBuilderUnseenReason(planShot(AGENT_BUILDER_START_SLOT)), null);
  const reasons = Object.values(AGENT_BUILDER_UNSEEN_SLOTS);
  assert.equal(new Set(reasons).size, reasons.length, "no two slots share a reason: each says what its own picture needs");
  for (const [file, reason] of Object.entries(AGENT_BUILDER_UNSEEN_SLOTS)) {
    assert.match(reason, /^This picture (?:needs|is) /, `${file} says what the picture is`);
    assert.match(reason, /\.$/, `${file} is a sentence`);
    assert.doesNotMatch(reason, /[^\x20-\x7e]/, `${file}: plain ASCII text, no emoji`);
    assert.doesNotMatch(reason, /https?:|@|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i, `${file}: no address, email, or identifier`);
    assert.ok(/never|not take|does not guess|stopped/.test(reason), `${file} says why it stopped`);
    // A job row keeps 300 characters of a message, and the way out is added to the reason: the whole sentence must be readable in the portal.
    assert.ok(`${reason} Use “Retake guided”, or upload the picture.`.length <= 300, `${file} fits a job row (${reason.length + 44} characters)`);
  }
});

test("the nine Agent Builder screens of the 62-shot lab that failed with a vague message each say exactly what is needed and what was never read", () => {
  const nine = ["dca-new-agent-page.png", "dca-configure-tab-prepopulated.png", "dca-try-it-response.png", "dca-knowledge-section.png", "dca-knowledge-sources-added.png", "dca-knowledge-test-result.png", "dca-share-dialog.png", "dca-add-people-panel.png", "dca-about-this-agent.png"];
  const reason = (file) => AGENT_BUILDER_UNSEEN_SLOTS[file];
  assert.equal(reason("dca-new-agent-page.png"), undefined, "the start screen is the one that becomes automatic");
  // Configure, Try it, and the About dialog: the same unread layout, named exactly.
  for (const file of ["dca-configure-tab-prepopulated.png", "dca-try-it-response.png", "dca-knowledge-test-result.png", "dca-about-this-agent.png"]) {
    assert.match(reason(file), /Skip, a sent message, and every screen after the start screen were never read, and it has no Describe or Configure tab\. The computer does not guess\.$/, file);
  }
  assert.equal(reason("dca-configure-tab-prepopulated.png"), "This picture needs an agent's Configure view (name, description, instructions, knowledge, starter prompts). Skip, a sent message, and every screen after the start screen were never read, and it has no Describe or Configure tab. The computer does not guess.");
  assert.equal(reason("dca-try-it-response.png"), "This picture needs an agent's Try it view with one prompt and its response. Skip, a sent message, and every screen after the start screen were never read, and it has no Describe or Configure tab. The computer does not guess.");
  assert.match(reason("dca-knowledge-section.png"), /^This picture needs an agent's Knowledge section \(Search, Enter URL, Browse, Upload\)\. The start screen has Add and manage sources and a source filter strip, but neither was clicked, and the lab's options were never read\./);
  assert.match(reason("dca-knowledge-sources-added.png"), /the computer never uploads files, and that section was never read\.$/);
  // Sharing is refused by the safety rules whatever was read.
  assert.match(reason("dca-share-dialog.png"), /never shares an agent or invites people/);
  assert.match(reason("dca-add-people-panel.png"), /never shares an agent or invites people/);
  assert.equal(nine.filter((f) => !reason(f)).join(","), "dca-new-agent-page.png");
});

test("a slot nobody read stops before any step runs, with its reason and the way out; a recipe a person recorded or shared for it is still tried", async () => {
  const events = [];
  const session = createCaptureSession({ env: {}, targets: {}, autonomy: resolveAutonomy({ consented: true, level: "read-only" }) });
  const trace = { event: (name, data) => events.push([name, data]) };
  for (const file of Object.keys(AGENT_BUILDER_UNSEEN_SLOTS)) {
    // The portal's own plan carries no step for it (no recipe matches), so there is nothing that could be clicked.
    const result = await runShotSetup({ page: {}, shot: planShot(file), session, sleep: async () => {}, trace });
    assert.equal(result.ok, false, file);
    assert.equal(result.cause, "needs-you", file);
    assert.equal(result.error, `${AGENT_BUILDER_UNSEEN_SLOTS[file]} Use “Retake guided”, or upload the picture.`, file);
    assert.deepEqual(result.setup.steps, [], `${file}: no step ran`);
  }
  assert.equal(events.filter(([name]) => name === "agent-builder-unseen").length, Object.keys(AGENT_BUILDER_UNSEEN_SLOTS).length);
  // A harness-tagged library name is the same slot.
  assert.equal((await runShotSetup({ page: {}, shot: planShot("dca-share-dialog.png", { filename: "dca-share-dialog.classic.png" }), session, sleep: async () => {} })).cause, "needs-you");
  // The same file name in another product is not stopped by this table.
  assert.equal(agentBuilderUnseenReason({ product: "sharepoint-ai", filename: "dca-share-dialog.png" }), null);
});

test("in a real browser, a recipe the person recorded for an unread slot is tried instead of stopped", { skip, timeout: 120_000 }, async () => {
  await withSite({}, async ({ page, site }) => {
    const local = { steps: [{ id: "look", action: "verify", target: { role: "textbox", name: "Message Copilot", within: "any" } }] };
    const recipes = { get: () => local, markReplay() {} };
    const session = createCaptureSession({ env: {}, targets: {}, autonomy: resolveAutonomy({ consented: true, level: "read-only" }), recipes });
    const result = await runShotSetup({ page, shot: planShot("dca-configure-tab-prepopulated.png"), session, sleep: real, findMs: 1500 });
    assert.equal(result.ok, true, JSON.stringify(result.failed));
    assert.equal(result.setup.source, "local");
    assert.deepEqual(site.stats.writes, []);
  });
});

test("the slot document lists all 43 slots with the category the code gives each one", () => {
  const doc = fs.readFileSync(path.join(here, "..", "..", "..", "docs", "m365-agent-builder-capture-slots.md"), "utf8");
  const categoryOf = (file) => {
    const reason = AGENT_BUILDER_UNSEEN_SLOTS[file];
    if (!reason) return "a";
    if (/Visual Studio Code, outside the browser/.test(reason)) return "c";
    if (/admin screen/.test(reason)) return "d";
    if (/never shares|never submits|sends the agent to an admin/.test(reason)) return "e";
    if (/built and provisioned in Visual Studio Code/.test(reason)) return "f";
    return "b";
  };
  const counts = {};
  for (const shot of manifest.shots) {
    const row = doc.split("\n").find((line) => line.startsWith(`| ${shot.feature} | ${shot.filename} | `));
    assert.ok(row, `${shot.filename} has a row in docs/m365-agent-builder-capture-slots.md`);
    assert.equal(row.split("|")[3].trim(), categoryOf(shot.filename), `${shot.filename}: category`);
    counts[categoryOf(shot.filename)] = (counts[categoryOf(shot.filename)] || 0) + 1;
  }
  assert.deepEqual(counts, { a: 1, b: 18, c: 8, d: 5, e: 4, f: 7 });
  assert.match(doc, /Result: 1 slot with a recipe, 18 slots of category b, 8 of c, 5 of d, 4 of e, and 7 of f\./);
  assert.doesNotMatch(doc, /[^\x09\x0a\x0d\x20-\x7e\u201c\u201d]/, "plain text: no emoji or other symbols");
});

// ── The old recipe fails on the real structure; the new one passes ──────────

test("the old recipe fails on a page shaped like the real one with 'the control was not found', and clicks nothing that changes anything", { skip, timeout: 120_000 }, async () => {
  await withSite({}, async ({ site, executor, page }) => {
    const result = await executor.run(compiled(OLD_RECIPE));
    assert.equal(result.ok, false, "the old recipe cannot open Agent Builder on this page");
    const failed = failedOf(result);
    assert.equal(failed.id, "builder-open", "it got as far as the Agents button, then looked for a button named Create agent in the main area");
    assert.match(plainFailure(result), /The computer could not complete .*Opened .*Create agent.*: the control was not found or did nothing\./);
    assert.deepEqual(site.stats.writes, []);
    assert.equal(new URL(page.url()).pathname, "/home", "the side bar button did not navigate: the address stays /home");
  });
});

test("the new recipe: Agents menu, New agent, then the start screen proven by its address and by its heading; nothing is typed, chosen, or sent", { skip, timeout: 120_000 }, async () => {
  await withSite({}, async ({ site, executor, page }) => {
    const result = await executor.run(compiled(newRecipeSteps().map((s) => ({ ...s }))));
    assert.equal(result.ok, true, JSON.stringify(result.failed || result.steps.map((s) => [s.id, s.status, s.note])));
    assert.deepEqual(result.steps.map((s) => [s.id, s.status]), [["agents-flyout-open", "ok"], ["agents-menu-shown", "ok"], ["new-agent-open", "ok"], ["builder-address", "ok"], ["builder-start-shown", "ok"]]);
    assert.ok(result.steps.every((s) => s.tier <= 1), "no step above Tier 1");
    assert.equal(new URL(page.url()).pathname, "/agents/new");
    assert.equal(site.stats.flyoutOpens, 1, "the flyout was opened once");
    assert.equal(site.stats.directBuilderVisits, 0, "Agent Builder was reached through the Agents menu, never by typing its address");
    assert.deepEqual(site.stats.writes, [], "no template, Skip, View all, Add and manage sources, dictation, or send was clicked");
    assert.deepEqual(site.stats.dangers, []);
    assert.equal(await page.getByRole("heading", { name: "Build your own specialist agent" }).isVisible(), true);
    assert.equal(await page.getByRole("textbox", { name: "Message Agent Builder" }).inputValue(), "", "nothing was typed");
    assert.deepEqual(site.stats.blocked, [], "no address outside the product's own sites was asked for");
  });
});

test("already on the start screen, the click path is left out and the address and the content are still checked", { skip, timeout: 120_000 }, async () => {
  await withSite({}, async ({ site, executor, page }) => {
    assert.equal(new URL(page.url()).pathname, "/agents/new");
    const result = await executor.run(compiled(newRecipeSteps().map((s) => ({ ...s }))));
    assert.equal(result.ok, true, JSON.stringify(result.failed));
    assert.deepEqual(result.steps.map((s) => [s.id, s.status]), [["agents-flyout-open", "ok"], ["agents-menu-shown", "ok"], ["new-agent-open", "ok"], ["builder-address", "ok"], ["builder-start-shown", "ok"]]);
    assert.equal(site.stats.flyoutOpens, 0, "the Agents menu was not opened again");
    assert.equal(site.stats.directBuilderVisits, 1, "this test opened the address itself");
    assert.deepEqual(site.stats.writes, []);
  }, { start: FAKE_M365_NEW_AGENT_URL });
});

test("the start page the lab names (m365.cloud.microsoft/chat) redirects to the Home page, and the recipe still reaches the start screen from there", { skip, timeout: 120_000 }, async () => {
  await withSite({}, async ({ site, executor, page }) => {
    assert.equal(page.url(), FAKE_M365_HOME_URL, "the redirect the real page makes");
    const result = await executor.run(compiled(newRecipeSteps().map((s) => ({ ...s }))));
    assert.equal(result.ok, true, JSON.stringify(result.failed));
    assert.equal(site.stats.redirects, 1, "the chat address moved to the Home page once");
  }, { start: FAKE_M365_START_URL });
});

test("a step is OK only when its expected effect is seen: a side bar button that opens nothing, a menu without New agent, and a screen without the heading each stop with their own plain message", { skip, timeout: 180_000 }, async () => {
  await withSite({ flyout: "none" }, async ({ site, executor }) => {
    const result = await executor.run(compiled(newRecipeSteps().map((s) => ({ ...s }))));
    assert.equal(result.ok, false);
    assert.equal(failedOf(result).id, "agents-flyout-open");
    assert.match(plainFailure(result), /^The Microsoft 365 Copilot side bar has no button named “Agents” that could be clicked/);
    assert.deepEqual(site.stats.writes, []);
  });
  await withSite({ newAgentLink: false }, async ({ site, executor }) => {
    const result = await executor.run(compiled(newRecipeSteps().map((s) => ({ ...s }))));
    assert.equal(result.ok, false);
    assert.equal(failedOf(result).id, "new-agent-open", "the menu opened and was proven, but it has no New agent link");
    assert.match(plainFailure(result), /^The “Agents menu” is open, but it has no link named “New agent”/);
    assert.deepEqual(site.stats.writes, []);
  });
  await withSite({ startScreen: false }, async ({ site, executor }) => {
    const result = await executor.run(compiled(newRecipeSteps().map((s) => ({ ...s }))));
    assert.equal(result.ok, false);
    assert.equal(failedOf(result).id, "builder-start-shown", "the address is /agents/new but neither the heading nor the message box shows");
    assert.match(plainFailure(result), /^The address is the New agent page, but neither its heading “Build your own specialist agent” nor its message box “Message Agent Builder” is showing/);
  });
});

test("the old layout (Agents is a link to a page with a Create agent button) is not a layout the new recipe pretends to handle: it fails at the Agents button, and nothing is clicked", { skip, timeout: 120_000 }, async () => {
  await withSite({ agentsLink: true }, async ({ site, executor }) => {
    const result = await executor.run(compiled(newRecipeSteps().map((s) => ({ ...s }))));
    assert.equal(result.ok, false);
    assert.equal(failedOf(result).id, "agents-flyout-open");
    assert.deepEqual(site.stats.writes, []);
  });
});
