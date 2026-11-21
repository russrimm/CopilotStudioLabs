/**
 * The whole walk-through in a real browser (headless Chromium, a throwaway profile, a throwaway port, throwaway
 * storage folders): Product, Tailor it, Topics, then Review and build, with Microsoft Learn and the language model off.
 *
 * It counts the clicks a person needs to build a default lab for one product, checks that every default is visibly
 * selected where it is offered, and checks the lab that comes out. Deterministic: no language model, and no
 * Microsoft Learn (the topic list comes from the committed snapshot and the Learn address points at a closed port).
 * The test skips itself when Playwright or a Chromium build is not installed (tools/screenshot-capture: npm install).
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PORTAL_ROOT = resolve(here, "..");
const PLAYWRIGHT = resolve(PORTAL_ROOT, "..", "tools", "screenshot-capture", "node_modules", "playwright", "index.mjs");
const CLICK_BUDGET = 6;
const cleanups = [];
const ctx = {};

function freePort() {
  const probe = (port) =>
    new Promise((resolvePort) => {
      const server = createServer();
      server.once("error", () => resolvePort(0));
      server.listen(port, "127.0.0.1", () => {
        const { port: bound } = server.address();
        server.close(() => resolvePort(bound));
      });
    });
  return (async () => {
    for (let port = 3101; port <= 3109; port += 1) {
      const got = await probe(port);
      if (got) return got;
    }
    return probe(0);
  })();
}

before(async () => {
  const root = mkdtempSync(join(tmpdir(), "lb-walkthrough-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
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
      LAB_BUILDER_OUTPUT_DIR: join(root, "generated"),
      FEATURE_TOUR_SCREENSHOTS_DIR: join(root, "shots"),
      LAB_BUILDER_LINK_CHECK: "off",
      LAB_BUILDER_LLM: "off",
      LAB_BUILDER_VENDOR_DOCS: "off",
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

test("a default lab for one product builds in at most six clicks, with every default visible", async (t) => {
  if (ctx.skipReason) return t.skip(ctx.skipReason);
  const context = await ctx.browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  let clicks = 0;
  const click = async (selector) => {
    await page.click(selector);
    clicks += 1;
  };
  const visible = (selector) => page.locator(selector).isVisible();
  try {
    await page.goto(`${ctx.base}/#labbuilder`);
    await page.waitForSelector("#lb-product-options input");
    await page.waitForFunction(() => document.querySelectorAll("#lb-steps li:not([hidden])").length === 4);

    // Four steps, named in plain words, whatever the product.
    assert.deepEqual(
      await page.$$eval("#lb-steps li", (items) => items.map((li) => li.textContent.replace(/^\s*\d+\s*/, "").trim())),
      ["Product", "Tailor it", "Topics", "Review and build"],
    );
    assert.match(await page.textContent("#lb-heading-1"), /^Step 1 of 4:/);

    // 1. Product. 2. Next.
    await click('#lb-product-options label:has(input[value="copilot-studio"])');
    await click("#lb-pane-1 .lb-nav-next");
    await page.waitForSelector("#lb-pane-2", { state: "visible" });
    assert.match(await page.textContent("#lb-heading-2"), /^Step 2 of 4: Tailor it/);

    // Every default is visibly selected and explained on Tailor it.
    await page.waitForFunction(() => document.querySelectorAll("#lb-level-options .lb-seg-count").length === 3 && /topic/.test(document.querySelector("#lb-level-options .lb-seg-count").textContent));
    assert.equal(await page.inputValue("#lb-industry-select"), "");
    assert.equal(await page.$eval("#lb-industry-select", (el) => el.selectedOptions[0].textContent), "Cross-industry");
    assert.equal(await page.textContent("#lb-industry-hint"), "Cross-industry is selected. Not sure? Keep it.");
    assert.equal(await page.isChecked("#lb-role-all"), true);
    assert.equal(await page.$$eval('input[name="lb-role"]:checked', (els) => els.length), 0);
    assert.equal(await page.$eval('input[name="lb-level"]:checked', (el) => el.value), "100");
    assert.match(await page.textContent("#lb-level-hint"), /^Level 100 \(Beginner\) is selected\./);
    assert.equal(await visible("#lb-harness-row"), true);
    assert.equal(await page.$eval('input[name="lb-harness"]:checked', (el) => el.value), "standard");
    assert.equal(await page.textContent("#lb-harness-hint"), "Standard harness is selected. Not sure? Keep it.");
    assert.match(await page.textContent("#lb-summary"), /Copilot Studio · Cross-industry · All departments · Level 100 \(Beginner\) · Standard harness/);

    // 3. Next (nothing to change on Tailor it).
    await click("#lb-pane-2 .lb-nav-next");
    await page.waitForSelector("#lb-pane-3", { state: "visible" });
    assert.match(await page.textContent("#lb-heading-3"), /^Step 3 of 4:/);
    await page.waitForSelector("#lb-topic-groups .lb-feature");

    // 4. Accept the suggested topics (a click only while Topics does not arrive with them selected).
    if ((await page.$$eval("#lb-pane-3 input[data-topic]:checked", (els) => els.length)) === 0) await click("#lb-pane-3 .lb-btn-recommend");
    await page.waitForFunction(() => document.querySelectorAll("#lb-pane-3 input[data-topic]:checked").length > 0);

    // 5. Next. Review and build is one screen with one primary action.
    await click("#lb-pane-3 .lb-nav-next");
    await page.waitForSelector("#lb-pane-4", { state: "visible" });
    assert.match(await page.textContent("#lb-heading-4"), /^Step 4 of 4: Review and build/);
    await page.waitForSelector("#lb-preview table.lb-outline");
    assert.equal(await page.$$eval("#lb-pane-4 .btn-primary", (els) => els.filter((el) => el.offsetParent !== null).length), 1);
    assert.equal(await page.textContent("#lb-generate-btn"), "Build my lab");
    assert.equal(await visible("#lb-customize-card"), false, "the brand card stays closed until it is asked for");
    assert.equal(await visible("#lb-sharepoint-site-prompt"), false);

    // Learn and the language model are off for the test: a setting for determinism, not a step in the walk-through.
    await page.evaluate(() => {
      document.getElementById("lb-use-learn").checked = false;
      document.getElementById("lb-use-llm").checked = false;
    });

    // 6. Build my lab.
    await click("#lb-generate-btn");
    await page.waitForSelector("#lb-result-panel", { state: "visible", timeout: 120000 });
    await page.waitForSelector(".lb-result-title");

    assert.ok(clicks <= CLICK_BUDGET, `the default path took ${clicks} clicks; the budget is ${CLICK_BUDGET}`);
    const pills = await page.$$eval("#lb-result-meta .scenario-pill", (els) => els.map((el) => el.textContent.trim()));
    assert.ok(pills.includes("Level 100 (Beginner)"), pills.join(" | "));

    const labs = await (await fetch(`${ctx.base}/api/lab-builder/generated`)).json();
    assert.equal(labs.labs.length, 1);
    const { selections } = labs.labs[0];
    assert.deepEqual(selections.products, ["copilot-studio"]);
    assert.equal(selections.level, 100);
    assert.equal(selections.harness, "standard");
    assert.ok(selections.features.length > 0, "the suggested topics were built");
  } finally {
    await context.close();
  }
});
