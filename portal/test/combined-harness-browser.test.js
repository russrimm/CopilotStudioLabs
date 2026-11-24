/**
 * "Both, one after another" in a real browser (headless Chromium, a throwaway profile, a throwaway port, throwaway storage
 * folders): the choice next to the single harnesses, keyboard use, the order line, a light 1440 and a dark 390 layout,
 * the draft round trip, and the lab that comes out. No language model and no Microsoft Learn; synthetic data only.
 * The test skips itself when Playwright or a Chromium build is not installed (tools/screenshot-capture: npm install).
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PORTAL_ROOT = resolve(here, "..");
const PLAYWRIGHT = resolve(PORTAL_ROOT, "..", "tools", "screenshot-capture", "node_modules", "playwright", "index.mjs");
const cleanups = [];
const ctx = {};

/** Browser tests share ports 3201-3209; this file starts at 3208 so it stays clear of the others. */
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
    for (const port of [3208, 3209, 3201, 3202, 3203, 3204, 3205, 3206, 3207]) {
      const got = await probe(port);
      if (got) return got;
    }
    return probe(0);
  })();
}

before(async () => {
  const root = mkdtempSync(join(tmpdir(), "lb-both-harnesses-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  ctx.dataDir = join(root, "data");
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
      PORTAL_DATA_DIR: ctx.dataDir,
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

const setTheme = (page, theme) => page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);

/** Open the wizard on Tailor it with Copilot Studio chosen. */
async function openTailor(page) {
  await page.goto(`${ctx.base}/#labbuilder`);
  await page.waitForSelector("#lb-product-options input");
  await page.click('#lb-product-options label:has(input[value="copilot-studio"])');
  await page.click("#lb-pane-1 .lb-nav-next");
  await page.waitForSelector("#lb-pane-2", { state: "visible" });
  await page.waitForSelector('#lb-harness-options input[value="both"]');
}

test("Both, one after another is a keyboard-friendly choice with an order line, in light 1440 and dark 390", async (t) => {
  if (ctx.skipReason) return t.skip(ctx.skipReason);
  const context = await ctx.browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  try {
    await openTailor(page);
    await setTheme(page, "light");

    // The choice sits in the same radio group as the single harnesses, with its plain hint.
    assert.deepEqual(await page.$$eval("#lb-harness-options input", (inputs) => inputs.map((i) => i.value)), ["standard", "microsoft-copilot", "customer-conversation", "both"]);
    const label = await page.textContent('#lb-harness-options label:has(input[value="both"])');
    assert.match(label, /Both, one after another/);
    assert.match(label, /Covers the Standard \(Classic\) harness first, then the Microsoft Copilot harness\. Shared topics appear once\./);
    assert.equal(await page.isVisible('#lb-harness-options label:has(input[value="both"])'), true);
    assert.equal(await page.isHidden("#lb-harness-order"), true, "the order line waits for the choice");

    // Keyboard only: focus the selected radio, then move down to Both with the arrow key.
    await page.focus('#lb-harness-options input[value="standard"]');
    for (let i = 0; i < 3; i += 1) await page.keyboard.press("ArrowDown");
    await page.waitForFunction(() => labBuilder.harnessMode === "both");
    assert.equal(await page.isChecked('#lb-harness-options input[value="both"]'), true);
    await page.waitForFunction(() => /^Order: Standard \(Classic\) first, then Microsoft Copilot\.$/.test(document.getElementById("lb-harness-order-text").textContent));
    assert.equal(await page.isVisible("#lb-harness-order"), true);
    assert.match(await page.textContent("#lb-harness-hint"), /Both harnesses are selected, Standard \(Classic\) first, then Microsoft Copilot\./);
    assert.equal(await page.$eval("#lb-harness-order-text", (el) => el.getAttribute("aria-live")), "polite", "a change of order is announced");

    // The order control is a real button: Tab reaches it, Enter swaps.
    await page.focus('#lb-harness-options input[value="both"]');
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "lb-harness-swap");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => /^Order: Microsoft Copilot first, then Standard \(Classic\)\.$/.test(document.getElementById("lb-harness-order-text").textContent));
    await page.click("#lb-harness-swap");
    await page.waitForFunction(() => /^Order: Standard \(Classic\) first/.test(document.getElementById("lb-harness-order-text").textContent));

    // The topic list asked for both harnesses, and the summary says so.
    assert.match(await page.textContent("#lb-summary"), /Both: Standard \(Classic\), then Microsoft Copilot/);
    assert.equal(await page.isHidden("#lb-differences-options input"), true, "the comparison notes are not offered");

    // Light, 1440 wide: nothing overflows sideways.
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no horizontal scroll at 1440");

    // Dark, 390 wide: the same choice, still readable, no sideways scroll, a touch-sized Swap button.
    await page.setViewportSize({ width: 390, height: 844 });
    await setTheme(page, "dark");
    assert.equal(await page.isVisible('#lb-harness-options label:has(input[value="both"])'), true);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no horizontal scroll at 390");
    const swap = await page.$eval("#lb-harness-swap", (el) => ({ height: el.getBoundingClientRect().height, width: el.getBoundingClientRect().width }));
    assert.ok(swap.height >= 44, `Swap order is touch-sized (${swap.height}px)`);
    const colors = await page.$eval("#lb-harness-order", (el) => {
      const style = getComputedStyle(el);
      return { background: style.backgroundColor, border: style.borderTopColor, color: getComputedStyle(document.getElementById("lb-harness-order-text")).color };
    });
    assert.notEqual(colors.background, "rgba(0, 0, 0, 0)");
    assert.notEqual(colors.color, colors.background, "text and background differ in dark");
    await page.setViewportSize({ width: 1440, height: 900 });
    await setTheme(page, "light");
  } finally {
    await context.close();
  }
});

test("a lab built with Both comes out in parts, and a draft keeps the choice and its order through a reload", async (t) => {
  if (ctx.skipReason) return t.skip(ctx.skipReason);
  const context = await ctx.browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const draftFiles = () => {
    const dir = join(ctx.dataDir, "lab-builder", "drafts");
    try {
      return readdirSync(dir, { recursive: true }).filter((name) => String(name).endsWith(".json") && !String(name).includes("unsaved"));
    } catch {
      return [];
    }
  };
  try {
    await openTailor(page);
    await page.click('#lb-harness-options label:has(input[value="both"])');
    await page.waitForFunction(() => labBuilder.harnessMode === "both");
    await page.click("#lb-harness-swap");
    await page.waitForFunction(() => labBuilder.harnessOrder[0] === "microsoft-copilot");

    // Topics: both harnesses' topics are offered, and each row says which harness it is for.
    await page.click("#lb-pane-2 .lb-nav-next");
    await page.waitForSelector("#lb-pane-3", { state: "visible" });
    await page.waitForSelector("#lb-topic-groups details.lb-concept");
    const ids = await page.evaluate(() => labBuilder.rec.concepts.flatMap((c) => c.topics.map((topic) => topic.id)));
    assert.ok(ids.includes("create-agent") && ids.includes("mc-create-agent"), "the topic list holds both harnesses' topics");
    assert.match(await page.textContent("#lb-topic-groups"), /Standard \(Classic\)|Microsoft Copilot|Either harness/);

    // Save and finish later, reload, resume.
    await page.click("#lb-save-draft");
    await page.waitForSelector("#lb-draft-name-dialog[open]");
    await page.fill("#lb-draft-name", "Contoso both harnesses");
    await page.click("#lb-draft-name-save");
    await page.waitForFunction(() => /^Saved\. You can pick this up later under Saved drafts\./.test(document.getElementById("lb-draft-status").textContent));
    assert.equal(draftFiles().length, 1);
    await page.reload();
    await page.waitForSelector('input[name="lb-product"]');
    await page.waitForFunction(() => document.getElementById("lb-drafts-badge").textContent === "1");
    await page.click("#lb-drafts-details > summary");
    await page.waitForSelector("#lb-drafts-list .lb-gen-item");
    await page.click('#lb-drafts-list button[aria-label="Resume Contoso both harnesses"]');
    await page.waitForFunction(() => labBuilder.harnessMode === "both" && labBuilder.harnessOrder[0] === "microsoft-copilot", null, { timeout: 15000 });
    const request = await page.evaluate(() => JSON.parse(JSON.stringify(lbRequest())));
    assert.equal(request.harnessMode, "both");
    assert.deepEqual(request.harnesses, ["microsoft-copilot", "standard"], "the order comes back as it was saved");
    assert.ok(!("harness" in request));

    // The lab that comes out: planned in parts, each module in one part.
    const res = await fetch(`${ctx.base}/api/lab-builder/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harnessMode: "both", harnesses: ["standard", "microsoft-copilot"], products: ["copilot-studio"], features: ["create-agent", "mc-create-agent", "mc-harness-choice"] }),
    });
    assert.equal(res.status, 200);
    const plan = await res.json();
    assert.deepEqual(plan.harnessParts.parts.map((p) => p.id), ["shared", "standard", "microsoft-copilot"]);
    assert.equal(plan.harness, null);
    assert.deepEqual(plan.modules.map((m) => m.harnessPart), ["shared", "standard", "microsoft-copilot"]);
  } finally {
    await context.close();
  }
});
