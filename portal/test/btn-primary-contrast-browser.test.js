/**
 * Primary buttons stay readable, in a real browser (headless Chromium, a throwaway profile, a throwaway port, synthetic data only).
 *
 * The scenario is the one the owner reported: the "Download complete training deck" link of a finished lab showed near black text on the
 * blue button, because a rule meant only to drop the link's underline also set the page text color and beat the button's own. The tests
 * measure the real contrast of that link's computed text color against its computed background (WCAG 2: 4.5 to 1), at rest, on hover, on
 * keyboard focus, pressed, and visited, in the light and the dark theme at 1440 and 390 wide, and then of every primary button on every
 * screen that can be reached with synthetic data. The last test reads the CSS and needs no browser. The browser tests skip themselves
 * when Playwright or a Chromium build is not installed (tools/screenshot-capture: npm install).
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { generateLab } from "../lib/lab-builder/generator.js";
import { PILL_REASONS, showPillScenario } from "./fixtures/pill-scenario.js";
import { WCAG_NORMAL_TEXT, sweepContrast } from "./fixtures/contrast-sweep.js";

const here = dirname(fileURLToPath(import.meta.url));
const PORTAL_ROOT = resolve(here, "..");
const PLAYWRIGHT = resolve(PORTAL_ROOT, "..", "tools", "screenshot-capture", "node_modules", "playwright", "index.mjs");
const WIDTHS = [1440, 390];
const THEMES = ["light", "dark"];
const OWNER_LINK = ".lb-training-actions a.btn-primary";
// Everything the app paints as a filled primary button.
const PRIMARY = ".btn-primary, .lab-page-btn-primary, .lab-quiz-btn-primary, .sc-primary-btn, .btn.lb-btn-recommend, .tab-group[aria-current='page']";
// The states a button can be in that the page can force, besides real hover and keyboard focus.
const FORCED_STATES = [
  ["rest", []],
  ["hover", ["hover"]],
  ["pressed", ["hover", "active"]],
  ["focus", ["focus", "focus-visible"]],
  ["visited", ["visited"]],
];
const TRAINING_LIST = {
  totalMinutes: 99,
  handsOnMinutes: 65,
  decks: [
    { key: "complete", kind: "complete", title: "Complete training deck: Contoso Lab", minutes: 99, fileName: "Training deck - Complete.pptx" },
    { key: "foundations-copilot-studio", kind: "foundations", title: "Foundations: Copilot Studio", minutes: 12, fileName: "Training deck - 00 Foundations.pptx" },
    { key: "1", kind: "topic", order: 1, stepLabel: "Step 1", title: "Create an agent", minutes: 25, fileName: "Training deck - Module 01.pptx" },
    { key: "2", kind: "topic", order: 2, stepLabel: "Step 2", title: "Add a child agent", minutes: 12, unreviewed: true, fileName: "Training deck - Module 02.pptx" },
  ],
};
const cleanups = [];
const ctx = {};

function tmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A free port from the range this work may use. The search starts at 3204 so it does not race the picture viewer's browser test
 * (3201), the pills test (3206), or the combined harness test (3208), which can run at the same time.
 */
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

  ctx.storageRoot = join(tmp("btn-contrast-"), "storage");
  const build = await generateLab(
    { products: ["power-platform-ai-hub"], features: ["ppai-explore-ai-hub-models", "ppai-build-custom-prompt"], includeCore: false },
    { outputRoot: join(ctx.storageRoot, "generated-labs"), labsDir: tmp("btn-contrast-empty-labs-"), useLearnMcp: false, useLlm: false },
  );
  ctx.labId = build.labId;

  ctx.port = await freePort();
  ctx.base = `http://127.0.0.1:${ctx.port}`;
  ctx.serverOutput = "";
  const child = spawn(process.execPath, ["server.js"], {
    cwd: PORTAL_ROOT,
    env: {
      ...process.env,
      PORT: String(ctx.port),
      HOST: "127.0.0.1",
      PORTAL_AUTH_DISABLED: "true",
      AZURE_KEYVAULT_URL: "",
      PORTAL_STORAGE_ROOT: ctx.storageRoot,
      FEATURE_TOUR_SCREENSHOTS_DIR: "",
      LAB_BUILDER_LINK_CHECK: "off",
      LAB_BUILDER_LLM: "off",
      CAPTURE_STARTUP_SCAN: "off",
      LOCALAPPDATA: tmp("btn-contrast-localappdata-"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => (ctx.serverOutput += chunk));
  cleanups.push(() => child.kill());
  const deadline = Date.now() + 40000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}): ${ctx.serverOutput.slice(-800)}`);
    try {
      if ((await fetch(`${ctx.base}/healthz`)).ok) {
        // The answer must come from this server, not one that already held the port.
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

const setTheme = (page, theme) => page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);

/** A fresh page that answers the training list from synthetic data and shows states at once (no color transitions to wait for). */
async function openPage(width) {
  const context = await ctx.browser.newContext({ viewport: { width, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.route("**/api/lab-builder/generated/*/training", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(TRAINING_LIST) }));
  const cdp = await context.newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  await page.goto(`${ctx.base}/#labbuilder`);
  await page.waitForSelector("#lb-product-options input");
  await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; animation: none !important; }" });
  return { context, page, cdp, errors, read: new Set() };
}

/** The finished lab's result area, with the training group above its downloads. */
async function openFinishedLab(page) {
  await page.evaluate(async (labId) => {
    await lbLoadGenerated();
    await lbOpenGenerated(labId);
  }, ctx.labId);
  await page.locator(OWNER_LINK).waitFor({ timeout: 20000 });
}

/** A control the page drew again (its checklist or preview finished loading) between marking it and reading it. */
class StaleControl extends Error {}

/** The worst reading of the element marked data-contrast-i (itself and any text inside it), with the page forced into `forced` states. */
async function readControl({ page, cdp }, index, forced = []) {
  const selector = `[data-contrast-i="${index}"], [data-contrast-i="${index}"] *`;
  let nodeId = null;
  if (forced.length) {
    const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
    ({ nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: `[data-contrast-i="${index}"]` }));
    if (!nodeId) throw new StaleControl(`the control marked ${index} was drawn again`);
    await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: forced });
  }
  try {
    const rows = await page.evaluate(sweepContrast, { selector });
    return rows.sort((a, b) => a.ratio - b.ratio)[0] || null;
  } finally {
    if (nodeId !== null) await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] }).catch(() => {});
  }
}

/** Mark the visible controls that match `selector`; returns what each one is so the same control is read once. */
const markControls = (page, selector) =>
  page.evaluate((sel) => {
    document.querySelectorAll("[data-contrast-i]").forEach((el) => el.removeAttribute("data-contrast-i"));
    const found = [];
    for (const el of document.querySelectorAll(sel)) {
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2 || getComputedStyle(el).visibility === "hidden") continue;
      el.setAttribute("data-contrast-i", String(found.length));
      found.push({ key: `${el.id}|${el.className}|${el.textContent.trim().slice(0, 40)}`, tag: el.tagName, disabled: el.matches(":disabled") });
    }
    return found;
  }, selector);

const describe = (row, where) => `${where}: ${row.selector} "${row.text}" is ${row.color} on ${row.background} = ${row.ratio}:1`;

// ── The owner's link ────────────────────────────────────────────────────────

test('"Download complete training deck" is readable at rest, on hover, on keyboard focus, pressed, and visited, in both themes', async (t) => {
  if (!ctx.browser) return t.skip("no browser");
  for (const width of WIDTHS) {
    const env = await openPage(width);
    const { context, page, errors } = env;
    await openFinishedLab(page);
    assert.equal((await page.locator(OWNER_LINK).textContent()).trim(), "Download complete training deck", "the label did not change");
    for (const theme of THEMES) {
      await setTheme(page, theme);
      const where = `${width}px, ${theme}`;
      const link = page.locator(OWNER_LINK);
      await link.scrollIntoViewIfNeeded();
      const [target] = await markControls(page, OWNER_LINK);
      assert.equal(target.tag, "A", "the owner's control is a link");

      // Real pointer and real keyboard first.
      await page.mouse.move(0, 0);
      const rest = await readControl(env, 0);
      assert.ok(rest.ratio >= WCAG_NORMAL_TEXT, describe(rest, `${where}, at rest`));
      await link.hover();
      const hover = await readControl(env, 0);
      assert.ok(hover.ratio >= WCAG_NORMAL_TEXT, describe(hover, `${where}, on hover`));
      await page.mouse.move(0, 0);
      await link.focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      assert.equal(await link.evaluate((el) => el === document.activeElement && el.matches(":focus-visible")), true, `${where}: the link has keyboard focus`);
      const focus = await readControl(env, 0);
      assert.ok(focus.ratio >= WCAG_NORMAL_TEXT, describe(focus, `${where}, on keyboard focus`));
      await link.evaluate((el) => el.blur());

      // Pressed and visited can only be forced.
      for (const [state, forced] of FORCED_STATES.filter(([name]) => ["pressed", "visited"].includes(name))) {
        const row = await readControl(env, 0, forced);
        assert.ok(row.ratio >= WCAG_NORMAL_TEXT, describe(row, `${where}, ${state}`));
      }
    }
    assert.deepEqual(errors, [], `${width}px: the page had no script errors`);
    await context.close();
  }
});

test("the secondary download links keep the text color of a plain button", async (t) => {
  if (!ctx.browser) return t.skip("no browser");
  const env = await openPage(1440);
  const { context, page } = env;
  await openFinishedLab(page);
  await page.click('[data-training-action="toggle"]');
  await page.locator(".lb-training-item-btn").first().waitFor({ timeout: 10000 });
  for (const theme of THEMES) {
    await setTheme(page, theme);
    const colors = await page.evaluate(() => {
      const color = (el) => getComputedStyle(el).color;
      const plain = document.querySelector('.lb-training-actions [data-training-action="toggle"]');
      return {
        plain: color(plain),
        foundations: color(document.querySelector(".lb-training-actions a.lb-download-link:not(.btn-primary)")),
        perTopic: [...document.querySelectorAll(".lb-training-item-btn")].map(color),
      };
    });
    assert.ok(colors.perTopic.length >= 3, "the topic list shows its Download links");
    assert.equal(colors.foundations, colors.plain, `${theme}: "Download foundations" has the plain button text color`);
    for (const color of colors.perTopic) assert.equal(color, colors.plain, `${theme}: a topic's Download link has the plain button text color`);
  }
  await context.close();
});

// ── Every primary button on every screen that synthetic data can reach ─────

/** Walk the screens in one page, calling `visit(name)` once each is showing. */
async function walkScreens(env, visit) {
  const { page } = env;
  await page.click('#lb-product-options label:has(input[value="copilot-studio"])');
  await visit("wizard step 1");
  await page.evaluate(() => lbNextStep());
  await page.waitForSelector("#lb-pane-2", { state: "visible" });
  await page.waitForFunction(() => document.querySelectorAll("#lb-level-options .lb-seg-count").length === 3);
  await visit("wizard step 2");
  await page.evaluate(() => lbNextStep());
  await page.waitForSelector("#lb-pane-3", { state: "visible" });
  await page.waitForSelector("#lb-topic-groups details.lb-concept");
  await page.waitForFunction(() => /^Suggested lab: \d+ topics?/.test(document.getElementById("lb-topic-summary").textContent));
  await visit("wizard step 3");
  await page.evaluate(() => lbNextStep());
  await page.waitForSelector("#lb-pane-4", { state: "visible" });
  await page.waitForSelector("#lb-preview table.lb-outline");
  await page.evaluate(() => document.querySelectorAll("#lb-pane-4 details").forEach((d) => (d.open = true)));
  await visit("wizard step 4");
  await page.evaluate(() => document.getElementById("lb-save-draft").click());
  await page.waitForSelector("#lb-draft-name", { state: "visible" });
  await visit("save draft dialog");
  await page.fill("#lb-draft-name", "Contoso draft");
  await page.evaluate(() => document.getElementById("lb-draft-name-save").click());
  await page.waitForFunction(() => document.querySelector("#lb-drafts-list button[data-draft-action]"), null, { timeout: 15000 });
  await page.evaluate(() => (document.getElementById("lb-drafts-details").open = true));
  await visit("saved drafts");

  await openFinishedLab(page);
  await page.waitForFunction(() => !/Loading the preview/.test(document.getElementById("lb-result-preview")?.textContent || ""), null, { timeout: 20000 });
  await visit("finished lab");
  await page.click('#lb-result-panel [data-training-action="toggle"]');
  await page.locator("#lb-result-panel .lb-training-item").first().waitFor({ timeout: 10000 });
  await visit("finished lab, training decks by topic");
  await visit("previously generated labs");

  await page.evaluate(async (labId) => lbOpenGeneratedScreenshots(labId), ctx.labId);
  await page.locator("#lb-result-screenshots .sc-card").first().waitFor({ timeout: 20000 });
  await visit("screenshot center");
  await page.evaluate(showPillScenario, { labId: ctx.labId, reasons: PILL_REASONS });
  await visit("screenshot center, a job and a person's step");
  await page.evaluate(
    (labId) => {
      const lab = scLab(labId);
      const [first, second] = lab.state.shots;
      first.captured = true;
      first.needsReview = true;
      first.capturedAt = new Date().toISOString();
      if (second) Object.assign(second, { captured: true, needsReview: false, capturedAt: new Date().toISOString() });
      lab.job = { status: "done", shots: lab.state.shots.map((s) => ({ filename: s.filename, status: "done" })) };
      scRenderInto(document.getElementById("lb-result-screenshots"), labId);
    },
    ctx.labId,
  );
  await visit("screenshot center, review and kept pictures");

  for (const id of await page.evaluate(() => [...document.querySelectorAll("dialog")].map((d) => d.id).filter(Boolean))) {
    await page.evaluate((i) => document.getElementById(i).showModal(), id);
    await visit(`dialog ${id}`);
    await page.evaluate((i) => document.getElementById(i).close(), id);
  }

  for (const tab of ["scenarios", "preview", "validate", "provision", "azure", "powerplatform", "email", "agent", "config"]) {
    await page.evaluate((name) => {
      document.querySelectorAll(".tab[hidden]").forEach((el) => el.removeAttribute("hidden"));
      setActiveTab(name);
    }, tab);
    if (tab === "scenarios") {
      await page.waitForFunction(() => typeof ucState !== "undefined" && ucState.initialized, null, { timeout: 15000 });
      await page.evaluate(() => ucSetIndustry(ucState.options.industries[0].id));
      await page.locator("[data-uc-add]").first().waitFor({ timeout: 15000 });
    }
    await visit(`tab ${tab}`);
  }
}

/**
 * Read every primary control on the screen that is showing: each state, both themes, and switched off for buttons.
 * Returns true when the page drew a control again while it was being read, so the caller reads the screen once more.
 */
async function readScreen(env, screen, width, failures, seen) {
  const { page } = env;
  const controls = await markControls(page, PRIMARY);
  // Each control is read once per width, wherever it first shows up.
  const fresh = controls.map((control, index) => ({ control, index })).filter(({ control }) => !env.read.has(control.key));
  try {
    for (const theme of THEMES) {
      await setTheme(page, theme);
      for (const { control, index } of fresh) {
        for (const [state, forced] of FORCED_STATES) {
          if (state === "visited" && control.tag !== "A") continue;
          const row = await readControl(env, index, forced);
          if (!row) continue;
          seen.add(`${theme}|${control.key}`);
          if (row.ratio < row.required) failures.push(describe(row, `${screen}, ${width}px, ${theme}, ${state}`));
        }
        if (control.tag === "BUTTON" && !control.disabled) {
          const toggle = (value) => page.evaluate(({ i, off }) => { const el = document.querySelector(`[data-contrast-i="${i}"]`); if (el) el.disabled = off; return Boolean(el); }, { i: index, off: value });
          if (!(await toggle(true))) throw new StaleControl(`the control marked ${index} was drawn again`);
          const row = await readControl(env, index);
          await toggle(false);
          if (row && row.ratio < row.required) failures.push(describe(row, `${screen}, ${width}px, ${theme}, disabled`));
        }
      }
    }
  } catch (err) {
    if (err instanceof StaleControl) return true;
    throw err;
  }
  for (const { control } of fresh) env.read.add(control.key);
  return false;
}

test("no primary button anywhere has less than 4.5 to 1 contrast, in either theme, at 1440 and 390 wide", async (t) => {
  if (!ctx.browser) return t.skip("no browser");
  const failures = [];
  const seen = new Set();
  for (const width of WIDTHS) {
    const env = await openPage(width);
    const { context, page, errors } = env;
    await walkScreens(env, async (screen) => {
      for (let attempt = 0; ; attempt += 1) {
        if (!(await readScreen(env, screen, width, failures, seen))) break;
        assert.ok(attempt < 3, `${screen}, ${width}px: the page kept drawing its buttons again while they were read`);
        await page.waitForTimeout(600);
      }
    });
    assert.deepEqual(errors, [], `${width}px: the page had no script errors`);
    await context.close();
  }
  const unique = [...new Set(failures)];
  assert.equal(unique.length, 0, `${unique.length} primary button readings are under 4.5:1:\n${unique.slice(0, 12).join("\n")}`);
  assert.ok(seen.size >= 2 * 25, `the sweep reached ${seen.size / 2} different primary controls; it should reach at least 25`);
  assert.ok([...seen].some((key) => key.includes("lb-download-link") && key.includes("Download complete training deck")), "and it reached the owner's link");
});

// ── The CSS itself, without a browser ───────────────────────────────────────

const publicDir = resolve(PORTAL_ROOT, "public");
const html = readFileSync(resolve(publicDir, "index.html"), "utf8");
const screenCss = (html.match(/<style>([\s\S]*?)<\/style>/)?.[1] || "").split("@media print")[0].replace(/\/\*[\s\S]*?\*\//g, "");

/** The classes the app puts on the same element as btn-primary, found in the markup the scripts and the page build. */
function primaryCompanionClasses() {
  const found = new Set();
  const sources = readdirSync(publicDir).filter((name) => /\.(js|html)$/.test(name));
  for (const name of sources) {
    const text = readFileSync(resolve(publicDir, name), "utf8");
    for (const match of text.matchAll(/class(?:Name)?\s*[:=]\s*[`"']([^`"']*(?<![\w-])btn-primary(?![\w-])[^`"']*)[`"']/g)) {
      for (const token of match[1].split(/\s+/)) if (/^[a-z][a-z0-9-]*$/.test(token)) found.add(token);
    }
  }
  for (const generic of ["btn", "btn-primary", "btn-sm"]) found.delete(generic);
  return found;
}

test("no rule sets a text color on a class that rides on btn-primary, except the accent tokens", () => {
  const companions = primaryCompanionClasses();
  assert.ok(companions.has("lb-download-link") && companions.has("lb-nav-next"), `the scan found the classes that ride on btn-primary: ${[...companions].join(" ")}`);
  const stray = [];
  for (const [, selectorList, body] of screenCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const color = body.match(/(?:^|[;\s])color\s*:\s*([^;]+)/)?.[1]?.trim();
    if (!color) continue;
    for (const selector of selectorList.split(",").map((s) => s.trim())) {
      const subject = selector.split(/[\s>+~]+/).pop();
      const riders = [...subject.matchAll(/\.([\w-]+)/g)].map((m) => m[1]).filter((name) => companions.has(name));
      if (riders.length && !/^var\(--accent(-hover)?-contrast\)$/.test(color)) stray.push(`${selector} { color: ${color} }`);
    }
  }
  assert.deepEqual(stray, [], "a color here wins over .btn-primary and paints the page text color on the blue fill; leave color to the button");
});
