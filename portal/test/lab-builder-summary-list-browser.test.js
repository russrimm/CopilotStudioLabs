/**
 * "Your lab so far" lists every product and every other choice on its own line, each written out in full. This test
 * selects four products (two of them added from Microsoft Learn, one with a long name and one with an unbroken word
 * that is longer than a phone is wide), walks Steps 1 to 4 and back, and checks in headless Chromium, in both themes at
 * 1440, 768, and 360 wide, that on every step the list shows: every name is in the page and fully visible (nothing
 * clipped, no ellipsis, no line clamp), the list and the page do not scroll sideways, the sticky header does not grow
 * with the list, and Back and Next stay on screen.
 *
 * It runs against a real server with throwaway storage folders, Microsoft Learn and the language model off. It skips
 * itself when Playwright or a Chromium build is not installed (tools/screenshot-capture: npm install).
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildUserProduct, writeUserProducts } from "../lib/lab-builder/user-products.js";

const here = dirname(fileURLToPath(import.meta.url));
const PORTAL_ROOT = resolve(here, "..");
const PLAYWRIGHT = resolve(PORTAL_ROOT, "..", "tools", "screenshot-capture", "node_modules", "playwright", "index.mjs");
const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 768, height: 900 },
  { width: 360, height: 740 },
];
const LONG_NAME = "What do you need help with today? Contoso Field Service Help Center";
const UNBROKEN_NAME = "Fabrikam ContosoRetailOperationsIntelligencePlatformSuite Preview";
const DEFAULT_CHOICES = ["Industry: Cross-industry", "Departments: All departments", "Level: Level 100 (Beginner)", "Agent experience: Standard harness"];
const cleanups = [];
const ctx = {};

function freePort() {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.once("error", () => resolvePort(0));
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

before(async () => {
  const root = mkdtempSync(join(tmpdir(), "lb-summary-list-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));

  // Two products added from Learn, saved the way older versions saved them: a short name cut at 29 characters.
  const saved = [
    buildUserProduct({ name: LONG_NAME, root: "https://learn.microsoft.com/contoso-field-service-help" }),
    buildUserProduct({ name: UNBROKEN_NAME, root: "https://learn.microsoft.com/fabrikam-retail-suite" }),
  ].map((product) => ({ ...product, shortName: `${product.name.slice(0, 29)}…` }));
  ctx.customIds = saved.map((product) => product.id);
  assert.ok(LONG_NAME.length >= 60 && LONG_NAME.length <= 80 && UNBROKEN_NAME.length <= 80, "the test names fit a saved product");
  const productsFile = join(root, "user-products.json");
  writeUserProducts(productsFile, saved);

  ctx.port = await freePort();
  ctx.base = `http://127.0.0.1:${ctx.port}`;
  let stderr = "";
  const child = spawn(process.execPath, ["server.js"], {
    cwd: PORTAL_ROOT,
    env: {
      ...process.env,
      PORT: String(ctx.port),
      HOST: "127.0.0.1",
      PORTAL_AUTH_DISABLED: "true",
      AZURE_KEYVAULT_URL: "",
      AZURE_STORAGE_BLOB_ENDPOINT: "",
      PORTAL_DATA_DIR: join(root, "data"),
      LAB_BUILDER_USER_PRODUCTS: productsFile,
      LAB_BUILDER_OUTPUT_DIR: join(root, "generated"),
      FEATURE_TOUR_SCREENSHOTS_DIR: join(root, "shots"),
      LAB_BUILDER_LINK_CHECK: "off",
      LAB_BUILDER_LLM: "off",
      LAB_BUILDER_VENDOR_DOCS: "off",
      CAPTURE_STARTUP_SCAN: "off",
      LEARN_MCP_URL: "http://127.0.0.1:9/",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  cleanups.push(() => child.kill());
  const deadline = Date.now() + 40000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}): ${stderr.slice(-800)}`);
    try {
      if ((await fetch(`${ctx.base}/healthz`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server did not start: ${stderr.slice(-800)}`);
    await new Promise((r) => setTimeout(r, 150));
  }

  if (!existsSync(PLAYWRIGHT)) {
    ctx.skipReason = "Playwright is not installed (tools/screenshot-capture: npm install).";
    return;
  }
  try {
    const { chromium } = await import(pathToFileURL(PLAYWRIGHT).href);
    ctx.browser = await chromium.launch({ headless: true });
    cleanups.push(() => ctx.browser?.close());
  } catch (err) {
    ctx.skipReason = `No headless Chromium is available: ${err.message.split("\n")[0]}`;
  }
});

after(() => {
  for (const clean of cleanups.reverse()) {
    try {
      clean();
    } catch {
      /* best effort */
    }
  }
});

/** Runs in the page: what the list says, and every way its text could be cut off, hidden, or pushed off the page. */
function measureSummary() {
  const root = document.getElementById("lb-summary");
  const box = root.getBoundingClientRect();
  const sticky = document.getElementById("lb-wizard-sticky");
  const problems = [];
  const skip = (el) => el.classList.contains("sr-only");
  for (const el of [root, ...root.querySelectorAll("*")]) {
    if (skip(el)) continue;
    const style = getComputedStyle(el);
    const name = `${el.tagName.toLowerCase()}${el.className ? `.${String(el.className).trim().split(/\s+/).join(".")}` : ""}`;
    if (style.textOverflow === "ellipsis") problems.push(`${name} has text-overflow: ellipsis`);
    if (style.webkitLineClamp && style.webkitLineClamp !== "none") problems.push(`${name} has a line clamp`);
    if (style.whiteSpace === "nowrap") problems.push(`${name} does not wrap`);
    if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1) problems.push(`${name} scrolls sideways (${el.scrollWidth} > ${el.clientWidth})`);
    const clips = ["overflowX", "overflowY"].some((axis) => style[axis] !== "visible");
    if (clips && el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 1) problems.push(`${name} clips its content (${el.scrollHeight} > ${el.clientHeight})`);
  }
  // The box each line of text really occupies must sit inside the list and inside the window.
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent.trim() || skip(node.parentElement)) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) {
      if (rect.left < box.left - 1 || rect.right > box.right + 1) problems.push(`"${node.textContent.slice(0, 30)}" sticks out of the list (${rect.left.toFixed(0)}-${rect.right.toFixed(0)} vs ${box.left.toFixed(0)}-${box.right.toFixed(0)})`);
      if (rect.right > innerWidth + 1 || rect.left < -1) problems.push(`"${node.textContent.slice(0, 30)}" is off the page`);
    }
  }
  const onScreen = (el) => {
    const rect = el.getBoundingClientRect();
    return el.checkVisibility() && rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight + 1 && rect.left >= 0 && rect.right <= innerWidth + 1;
  };
  const buttons = (selector) => [...document.querySelectorAll(selector)].filter(onScreen).map((el) => el.id || el.className);
  return {
    theme: document.documentElement.getAttribute("data-theme"),
    hidden: root.hidden || !root.checkVisibility(),
    position: getComputedStyle(root).position,
    title: root.querySelector(".lb-summary-title")?.textContent ?? "",
    products: [...root.querySelectorAll(".lb-summary-values li")].map((li) => li.textContent),
    choices: [...root.querySelectorAll(".lb-summary-item:not(.lb-summary-products)")].map((li) => li.textContent),
    seen: root.innerText,
    problems,
    listOverflow: root.scrollWidth - root.clientWidth,
    pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    stickyHeight: Math.round(sticky.getBoundingClientRect().height),
    stickyPosition: getComputedStyle(sticky).position,
    nextOnScreen: buttons(".lb-nav-next"),
    backOnScreen: buttons(".lb-nav-back"),
    announce: document.getElementById("lb-summary-announce").textContent,
  };
}

async function openWizard(viewport, theme) {
  const context = await ctx.browser.newContext({ viewport });
  await context.addInitScript((value) => {
    try {
      localStorage.setItem("portal-theme", value);
    } catch {
      /* storage unavailable */
    }
  }, theme);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.goto(`${ctx.base}/#labbuilder`);
  await page.waitForSelector("#lb-product-options input");
  await page.waitForFunction(() => document.querySelectorAll("#lb-steps li:not([hidden])").length === 4);
  return { context, page, errors };
}

for (const theme of ["light", "dark"]) {
  for (const viewport of VIEWPORTS) {
    test(`Your lab so far lists every product and choice in full on Steps 1 to 4 at ${viewport.width}px (${theme})`, async (t) => {
      if (ctx.skipReason) return t.skip(ctx.skipReason);
      const { context, page, errors } = await openWizard(viewport, theme);
      try {
        const click = async (selector) => {
          await page.click(selector);
          await page.waitForTimeout(150);
        };
        const check = async (where, { products, choices, back }) => {
          await page.waitForTimeout(250);
          const view = await page.evaluate(measureSummary);
          assert.equal(view.theme, theme, `${where}: the ${theme} theme is applied`);
          assert.equal(view.hidden, false, `${where}: the list shows`);
          assert.equal(view.title, "Your lab so far");
          assert.deepEqual(view.products, products, `${where}: one line per product, each in full`);
          assert.equal(view.choices.length, choices.length, `${where}: ${view.choices.join(" | ")}`);
          choices.forEach((expected, index) => {
            if (expected instanceof RegExp) assert.match(view.choices[index], expected, `${where}: choice ${index + 1}`);
            else assert.equal(view.choices[index], expected, `${where}: choice ${index + 1}`);
          });
          for (const name of products) assert.ok(view.seen.includes(name), `${where}: "${name}" is on screen in full`);
          assert.doesNotMatch(view.seen, /…|\.\.\./, `${where}: nothing is shortened`);
          assert.deepEqual(view.problems, [], `${where}: nothing is cut off`);
          assert.ok(view.listOverflow <= 0, `${where}: the list is ${view.listOverflow}px wider than its box`);
          assert.ok(view.pageOverflow <= 0, `${where}: the page is ${view.pageOverflow}px wider than the window`);
          assert.equal(view.position, "static", `${where}: the list scrolls with the page, so it never covers a step`);
          assert.ok(view.nextOnScreen.length >= 1, `${where}: Next (or Build my lab) is on screen`);
          if (back) assert.ok(view.backOnScreen.length >= 1, `${where}: Back is on screen`);
          return view;
        };

        // Step 1: pick four products, two of them added from Microsoft Learn.
        assert.ok(await page.evaluate(() => document.getElementById("lb-summary").hidden), "nothing is listed before a product is chosen");
        for (const id of ["copilot-studio", "sharepoint-ai", ...ctx.customIds]) await click(`#lb-product-options label:has(input[value="${id}"])`);
        const products = ["Copilot Studio", "SharePoint AI", LONG_NAME, UNBROKEN_NAME];
        const first = await check("Step 1", { products, choices: [] });
        assert.match(first.announce, /^Your lab so far: 4 products\.$/);
        const card = await page.textContent(`#lb-product-options label:has(input[value="${ctx.customIds[0]}"])`);
        assert.ok(card.includes(LONG_NAME) && !card.includes("…"), "the product card names the whole product too");
        assert.ok((await page.textContent(`#lb-product-options label:has(input[value="${ctx.customIds[0]}"]) .lb-card-learn a`)).includes(LONG_NAME), "and so does its Microsoft Learn link");
        const stickyHeight = first.stickyHeight;

        // Steps 2 to 4: the same products, plus what Tailor it chose.
        await click("#lb-pane-1 .lb-nav-next");
        await page.waitForSelector("#lb-pane-2", { state: "visible" });
        const second = await check("Step 2", { products, choices: DEFAULT_CHOICES, back: true });
        assert.equal(second.stickyHeight, stickyHeight, "the header with the step pills is as tall as it was; the list does not live in it");
        await click("#lb-pane-2 .lb-nav-next");
        await page.waitForSelector("#lb-pane-3", { state: "visible" });
        await page.waitForFunction(() => /^Suggested lab: \d+ topics?/.test(document.getElementById("lb-topic-summary")?.textContent || ""));
        await check("Step 3", { products, choices: DEFAULT_CHOICES, back: true });
        await click("#lb-pane-3 .lb-nav-next");
        await page.waitForSelector("#lb-pane-4", { state: "visible" });
        await check("Step 4", { products, choices: DEFAULT_CHOICES, back: true });

        // Going back to Tailor it after Topics adds the topic count and time, as the one-line summary did.
        await click('#lb-steps [data-lb-step="2"]');
        await page.waitForSelector("#lb-pane-2", { state: "visible" });
        await check("Step 2 again", { products, choices: [...DEFAULT_CHOICES, /^Topics: .+ \(estimate, not a limit\)$|^Topics: No topics selected yet$/], back: true });

        // A step that is scrolled well down keeps the header at the top and the list does not follow it.
        if (viewport.width > 720 && viewport.height >= 760) {
          await click('#lb-steps [data-lb-step="3"]');
          await page.waitForSelector("#lb-pane-3", { state: "visible" });
          await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
          await page.waitForTimeout(200);
          const scrolled = await page.evaluate(measureSummary);
          assert.equal(scrolled.stickyPosition, "sticky");
          assert.ok(scrolled.stickyHeight <= 140, `the sticky header is ${scrolled.stickyHeight}px tall`);
          assert.ok(scrolled.nextOnScreen.length >= 1, "Next is still on screen after scrolling");
        }
        assert.deepEqual(errors, [], "no script errors on the page");
      } finally {
        await context.close();
      }
    });
  }
}
