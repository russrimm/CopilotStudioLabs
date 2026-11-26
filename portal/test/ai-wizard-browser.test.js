/**
 * The AI writing control and its routes, in the real portal and a real browser (headless Chromium, a throwaway profile, a
 * throwaway port from 3201 to 3209, synthetic data only). The portal runs with AI off, exactly as it is deployed; the
 * browser's /api/ai answers are stubbed for the other states, so no model, no SDK and no account is ever involved.
 *
 * Checked: the three states (not possible here, off by the server, available with models), a layout at 1440 wide in the light
 * theme and 390 wide in the dark theme, keyboard use, the 44px targets, the draft round trip through the real drafts API, and
 * the request the build sends. Set AI_SHOTS_DIR to keep a screenshot of every state. The tests skip themselves when Playwright
 * or a Chromium build is not installed (tools/screenshot-capture: npm install).
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PORTAL_ROOT = resolve(here, "..");
const PLAYWRIGHT = resolve(PORTAL_ROOT, "..", "tools", "screenshot-capture", "node_modules", "playwright", "index.mjs");
const SHOTS = process.env.AI_SHOTS_DIR ? resolve(process.env.AI_SHOTS_DIR) : null;
const cleanups = [];
const ctx = {};

const OFF = { mode: "off", state: "off", possible: false, available: false, reason: "off", message: "AI writing is turned off on this server." };
const UNAVAILABLE = { mode: "local-user", state: "unavailable", possible: false, available: false, reason: "not-local", message: "AI writing in local mode only works from the PC that runs the portal." };
const READY = {
  mode: "local-user", state: "ready", possible: true, available: true, reason: "ready", message: "Signed in as octo-trainer.", signedIn: true, signedInAs: "octo-trainer", needsSignIn: false, provider: "GitHub Copilot",
  sends: "AI sees only the lab's topic text from Microsoft Learn and the catalog, and the scenario fields you typed. It never sees tenant data or screenshots. Steps, interface names and facts stay as written; AI only rewords them, and every reworded passage is checked against the original.",
};
const SIGN_IN = { ...READY, mode: "per-user", state: "sign-in", available: false, signedIn: false, signedInAs: null, needsSignIn: true, signInUrl: "/api/ai/auth/start", message: "Sign in with GitHub to use AI writing." };
const MODELS = {
  provider: "GitHub Copilot",
  models: [
    { id: "gpt-fast", name: "GPT Fast", cost: "Uses 0.33 of a premium request for each prompt", warning: null },
    { id: "gpt-smart", name: "GPT Smart", cost: "Uses 1 premium request for each prompt", warning: null },
    { id: "claude-careful", name: "Claude Careful", cost: "Uses 3 premium requests for each prompt", warning: "Preview model" },
  ],
};

function tmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A free port from 3201 to 3209. The search starts at 3204 so it does not race the other browser tests (3201 and 3206). */
async function freePort() {
  for (let offset = 0; offset < 9; offset += 1) {
    const port = 3201 + ((3 + offset) % 9);
    const free = await new Promise((resolveFree) => {
      const probe = createServer();
      probe.once("error", () => resolveFree(false));
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolveFree(true)));
    });
    if (free) return port;
  }
  throw new Error("no free port from 3201 to 3209");
}

before(async (t) => {
  if (!existsSync(PLAYWRIGHT)) return t.skip("Playwright is not installed (tools/screenshot-capture: npm install).");
  const { chromium } = await import(pathToFileURL(PLAYWRIGHT).href);
  try {
    ctx.browser = await chromium.launch({ headless: true });
  } catch (err) {
    return t.skip(`No headless Chromium is available: ${err.message.split("\n")[0]}`);
  }
  cleanups.push(() => ctx.browser?.close());
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });

  ctx.storageRoot = join(tmp("ai-browser-"), "storage");
  ctx.port = await freePort();
  ctx.base = `http://127.0.0.1:${ctx.port}`;
  ctx.serverOutput = "";
  const env = { ...process.env, PORT: String(ctx.port), HOST: "127.0.0.1", PORTAL_AUTH_DISABLED: "true", AZURE_KEYVAULT_URL: "", PORTAL_STORAGE_ROOT: ctx.storageRoot, FEATURE_TOUR_SCREENSHOTS_DIR: "", LAB_BUILDER_LINK_CHECK: "off", LAB_BUILDER_LLM: "off", CAPTURE_STARTUP_SCAN: "off", LOCALAPPDATA: tmp("ai-browser-localappdata-") };
  delete env.AI_GENERATION;
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "COPILOT_GITHUB_TOKEN"]) delete env[key];
  const child = spawn(process.execPath, ["server.js"], { cwd: PORTAL_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => (ctx.serverOutput += chunk));
  cleanups.push(() => child.kill());
  const deadline = Date.now() + 40000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}): ${ctx.serverOutput.slice(-800)}`);
    try {
      if ((await fetch(`${ctx.base}/healthz`)).ok) {
        await new Promise((r) => setTimeout(r, 200));
        if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}): ${ctx.serverOutput.slice(-800)}`);
        break;
      }
    } catch (err) {
      if (/server exited early/.test(err.message)) throw err;
    }
    if (Date.now() > deadline) throw new Error("server did not start in time");
    await new Promise((r) => setTimeout(r, 150));
  }
});

after(async () => {
  for (const fn of cleanups.reverse()) {
    try {
      await fn();
    } catch {
      /* best effort */
    }
  }
});

const SELECTIONS = { industry: null, roles: [], products: ["copilot-studio"], features: ["create-agent"], excluded: [], moduleOrder: [], excludedSubtopics: [], harness: "standard", level: 100, differencesFor: null, targetMinutes: null, customTitle: null, agentName: null, sharepointSiteName: "", sharepointSiteUrl: "", useLearnMcp: false, useLlm: false, includeKnowledgeCheck: false };

/** The Review and build step of the real wizard, with the AI endpoints answering as the scenario says. */
async function openReview({ width, theme, status, models = MODELS }) {
  const context = await ctx.browser.newContext({ viewport: { width, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  const sent = { generate: [], ai: [] };
  page.on("pageerror", (err) => errors.push(err.message));
  await page.route("**/api/ai/status", (route) => (sent.ai.push("status"), route.fulfill({ json: status })));
  await page.route("**/api/ai/models", (route) => (sent.ai.push("models"), route.fulfill({ json: models })));
  await page.route("**/api/ai/progress/*", (route) => route.fulfill({ json: { done: 12, total: 40, stage: "training", finished: false } }));
  await page.route("**/api/lab-builder/generate", (route) => {
    sent.generate.push(JSON.parse(route.request().postData() || "{}"));
    return route.fulfill({ status: 400, json: { error: "stubbed: no lab is built in this test" } });
  });
  await page.addInitScript((value) => {
    try {
      localStorage.setItem("portal-theme", value);
    } catch {
      /* sandboxed frames have no storage */
    }
  }, theme);
  await page.goto(`${ctx.base}/#labbuilder`);
  await page.waitForFunction(() => typeof lbLoadSelections === "function");
  await page.evaluate(async (selections) => {
    await lbLoadSelections({ title: "AI control check", selections });
  }, SELECTIONS);
  await page.locator("#lb-pane-4").waitFor({ state: "visible", timeout: 20000 });
  await page.waitForFunction(() => typeof labBuilderAi !== "undefined" && labBuilderAi.status !== undefined);
  await page.waitForTimeout(300);
  return { context, page, errors, sent };
}

async function shot(page, name) {
  if (!SHOTS) return;
  await page.evaluate(() => {
    const target = [document.getElementById("lb-ai-card"), document.querySelector(".lb-quiz-optin-card")].find((el) => el && !el.hidden && el.offsetParent !== null);
    target?.scrollIntoView({ block: "center" });
  });
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });
}

const VIEWS = [
  { width: 1440, theme: "light" },
  { width: 390, theme: "dark" },
];

for (const view of VIEWS) {
  const label = `${view.theme} ${view.width}`;

  test(`not possible here: the card is not on the page (${label})`, async () => {
    const { context, page, errors } = await openReview({ ...view, status: UNAVAILABLE });
    try {
      assert.equal(await page.locator("#lb-ai-card").isVisible(), false);
      assert.equal(await page.evaluate(() => JSON.stringify(lbAiRequestField())), "{}");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, "no sideways scroll");
      await page.locator(".lb-quiz-optin-card").scrollIntoViewIfNeeded();
      await shot(page, `ai-control-unavailable-${view.theme}-${view.width}`);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  test(`off by the server: one calm line, no control (${label})`, async () => {
    const { context, page, errors } = await openReview({ ...view, status: OFF });
    try {
      assert.equal(await page.locator("#lb-ai-card").isVisible(), true);
      assert.equal((await page.locator("#lb-ai-off-note").innerText()).trim(), "AI writing is turned off on this server.");
      assert.equal(await page.locator("#lb-ai-enabled").isVisible(), false);
      assert.equal(await page.locator("#lb-ai-model").isVisible(), false);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
      await shot(page, `ai-control-off-by-server-${view.theme}-${view.width}`);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  test(`available: off until chosen, then the models, the plain-words cost, what is sent, and a request that carries the choice (${label})`, async () => {
    const { context, page, errors, sent } = await openReview({ ...view, status: READY });
    try {
      assert.equal(await page.locator("#lb-ai-enabled").isVisible(), true);
      assert.equal(await page.locator("#lb-ai-enabled").isChecked(), false, "off by default");
      assert.equal(await page.locator("#lb-ai-options").isVisible(), false);
      assert.equal(sent.ai.includes("models"), false, "no model list until AI is turned on");
      await shot(page, `ai-control-available-off-${view.theme}-${view.width}`);

      // Keyboard: the checkbox takes focus and Space turns it on.
      await page.locator("#lb-ai-enabled").focus();
      await page.keyboard.press("Space");
      await page.locator("#lb-ai-options").waitFor({ state: "visible" });
      assert.equal(await page.locator("#lb-ai-enabled").getAttribute("aria-expanded"), "true");
      await page.waitForFunction(() => document.querySelectorAll("#lb-ai-model option").length === 4);
      assert.deepEqual(await page.locator("#lb-ai-model option").allInnerTexts(), ["Choose a model", "GPT Fast", "GPT Smart", "Claude Careful"]);
      assert.match(await page.locator("#lb-ai-status").innerText(), /Signed in as octo-trainer/);
      assert.match(await page.locator("#lb-ai-sends").innerText(), /never sees tenant data or screenshots/);

      await page.locator("#lb-ai-model").selectOption("claude-careful");
      assert.match(await page.locator("#lb-ai-model-cost").innerText(), /Uses 3 premium requests for each prompt\. Preview model/);
      assert.match(await page.locator("#lb-ai-summary").innerText(), /Claude Careful will reword the lab text, the training decks and the lab-day decks/);
      await page.locator("label[for=lb-ai-scope-labday]").click();
      assert.match(await page.locator("#lb-ai-summary").innerText(), /will reword the lab text and the training decks\./);
      await shot(page, `ai-control-available-${view.theme}-${view.width}`);

      // Targets are at least 44px tall, and nothing runs off the side.
      const sizes = await page.evaluate(() => ["#lb-ai-model", "label[for=lb-ai-enabled]", "label[for=lb-ai-scope-lab]", "label[for=lb-ai-scope-training]"].map((s) => document.querySelector(s).getBoundingClientRect().height));
      for (const height of sizes) assert.ok(height >= 43.5, `a target is ${height}px tall`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, "no sideways scroll");
      const card = await page.locator("#lb-ai-card").boundingBox();
      assert.ok(card.x >= 0 && card.x + card.width <= view.width + 1, "the card stays inside the page");

      // The outline names the choice, and the build request carries it.
      assert.match(await page.locator(".lb-outline-facts").innerText().catch(() => ""), /Written with AI \(Claude Careful\)/);
      await page.locator("#lb-generate-btn").click();
      await page.waitForFunction(() => !labBuilder.busy);
      assert.equal(sent.generate.length, 1);
      assert.deepEqual(sent.generate[0].ai, { enabled: true, provider: "github-copilot", model: "claude-careful", scope: ["lab", "training"] });
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
}

test("signing in: the prompt is plain, the model picker waits for the sign-in, and a build is refused until then", async () => {
  const { context, page, sent } = await openReview({ width: 390, theme: "dark", status: SIGN_IN });
  try {
    await page.locator("label[for=lb-ai-enabled]").click();
    assert.equal(await page.locator("#lb-ai-signin").isVisible(), true);
    assert.equal(await page.locator("#lb-ai-model").isVisible(), false);
    assert.equal((await page.locator("#lb-ai-status").innerText()).trim(), "Sign in with GitHub to use AI writing.");
    await shot(page, "ai-control-sign-in-dark-390");
    await page.locator("#lb-generate-btn").click();
    assert.match(await page.locator("#lb-ai-error").innerText(), /Sign in with GitHub to write with AI, or turn Write with AI off/);
    assert.equal(sent.generate.length, 0, "nothing was sent");
  } finally {
    await context.close();
  }
});

test("a draft saved with AI on keeps the choice through the real drafts API and opens with it again", async () => {
  const { context, page } = await openReview({ width: 1440, theme: "light", status: READY });
  try {
    await page.locator("label[for=lb-ai-enabled]").click();
    await page.waitForFunction(() => document.querySelectorAll("#lb-ai-model option").length === 4);
    await page.locator("#lb-ai-model").selectOption("gpt-smart");
    await page.locator("label[for=lb-ai-scope-training]").click();
    const saved = await page.evaluate(async () => {
      const content = lbDraftContent();
      const res = await fetch("/api/lab-builder/drafts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "AI draft", content }) });
      const body = await res.json();
      return { status: res.status, id: body.draft?.id, ai: body.draft?.content?.selections?.ai, sent: content.selections.ai };
    });
    assert.equal(saved.status, 201);
    assert.deepEqual(saved.ai, { enabled: true, model: "gpt-smart", scope: ["lab", "labday"] });
    assert.deepEqual(saved.sent, saved.ai);

    // Start over, then open the draft: the choice comes back.
    await page.evaluate(() => lbResetWizard());
    assert.equal(await page.locator("#lb-ai-enabled").isChecked(), false);
    const restored = await page.evaluate(async (id) => {
      const res = await fetch(`/api/lab-builder/drafts/${id}`);
      const body = await res.json();
      lbAiApplySaved(body.draft.content.selections.ai);
      await lbAiRefresh();
      return lbAiDraftChoice();
    }, saved.id);
    assert.deepEqual(restored, { enabled: true, model: "gpt-smart", scope: ["lab", "labday"] });
    assert.equal(await page.locator("#lb-ai-enabled").isChecked(), true);
  } finally {
    await context.close();
  }
});

test("the real portal, as deployed: AI is off, the routes say so, and an AI build request is refused before anything is built", async () => {
  const status = await (await fetch(`${ctx.base}/api/ai/status`)).json();
  assert.equal(status.state, "off");
  assert.equal(status.possible, false);
  const models = await fetch(`${ctx.base}/api/ai/models`);
  assert.equal(models.status, 403);
  assert.equal((await models.json()).code, "off");
  const build = await fetch(`${ctx.base}/api/lab-builder/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ products: ["copilot-studio"], features: ["create-agent"], harness: "standard", includeCore: false, useLearnMcp: false, useLlm: false, ai: { enabled: true, model: "gpt-smart" } }),
  });
  assert.equal(build.status, 403);
  const body = await build.json();
  assert.equal(body.code, "off");
  assert.match(body.error, /turned off on this server/);
  const list = await (await fetch(`${ctx.base}/api/lab-builder/generated`)).json();
  assert.equal((Array.isArray(list) ? list : list.labs || []).length, 0, "no lab was built");
  assert.doesNotMatch(ctx.serverOutput, /\[ai\].*(token|prompt)/i);
  // A request with AI off, or no ai field at all, is shape-checked like any other field.
  const bad = await fetch(`${ctx.base}/api/lab-builder/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ products: ["copilot-studio"], features: ["create-agent"], harness: "standard", ai: { enabled: true, model: "bad model" } }) });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /Pick a model/);
});
