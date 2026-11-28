/**
 * The Screenshots choice on Review and build: in every state (a computer connected, none connected, the connection check failed) it says in
 * plain words what happens with and without screenshots, nothing is cut off from 1440 down to 360 wide in both themes, the text has enough
 * contrast, it works from the keyboard, and the same true or false still goes to the server. A finished build without screenshots says where to
 * take them.
 *
 * It runs in headless Chromium against a real server with throwaway storage folders, Microsoft Learn and the language model off. The connected
 * computer is a stubbed status answer: no companion is started and no capture runs. It skips itself when Playwright or a Chromium build is not
 * installed (tools/screenshot-capture: npm install).
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
  const root = mkdtempSync(join(tmpdir(), "lb-capture-choice-"));
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

const CONNECTED_STATUS = {
  companion: {
    connected: true,
    lastSeenAt: new Date().toISOString(),
    connectedCount: 1,
    deviceCount: 1,
    busy: false,
    signedInProducts: [],
    devices: [{ id: "dev_0123456789ab", name: "Ada PC", platform: "win32", connected: true, busy: false, lastSeenAt: new Date().toISOString(), signedInProducts: [] }],
    downloadUrl: "/api/capture/companion.zip",
    onlineWindowSec: 90,
  },
  serverBrowser: { available: false },
  tenantUrls: { set: false, names: [] },
  sharedLibrary: { location: "persistent", persistent: true, total: 20, captured: 0, missing: 20, needsReview: 0 },
  jobs: { queued: 0, active: 0 },
  pairing: { codeTtlSec: 600 },
  limits: { maxUploadBytes: 8 * 1024 * 1024, acceptedTypes: ["image/png", "image/jpeg", "image/webp"] },
};

/** Opens the wizard. `answer.mode` picks what the portal says about the computer: "failed", then "connected", then "none" (the real answer). */
async function openPage(viewport, theme = "light") {
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
  const answer = { mode: "failed" };
  await page.route("**/api/capture/status", (route) => {
    if (answer.mode === "connected") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(CONNECTED_STATUS) });
    if (answer.mode === "failed") return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "down" }) });
    return route.continue();
  });
  await page.goto(`${ctx.base}/#labbuilder`);
  await page.waitForSelector("#lb-product-options input");
  await page.waitForFunction(() => document.querySelectorAll("#lb-steps li:not([hidden])").length === 4);
  return { context, page, errors, answer };
}

async function toReview(page) {
  await page.click('#lb-product-options label:has(input[value="copilot-studio"])');
  await page.click("#lb-pane-1 .lb-nav-next");
  await page.waitForSelector("#lb-pane-2", { state: "visible" });
  await page.waitForFunction(() => document.querySelectorAll("#lb-level-options .lb-seg-count").length === 3);
  await page.click("#lb-pane-2 .lb-nav-next");
  await page.waitForSelector("#lb-pane-3", { state: "visible" });
  await page.waitForSelector("#lb-topic-groups details.lb-concept");
  await page.waitForFunction(() => /^Suggested lab: \d+ topics?/.test(document.getElementById("lb-topic-summary").textContent));
  await page.click("#lb-pane-3 .lb-nav-next");
  await page.waitForSelector("#lb-pane-4", { state: "visible" });
  await page.waitForSelector("#lb-preview table.lb-outline");
}

/** Reads the status again (as the page does when Review and build opens) and waits for its words. */
async function refresh(page) {
  await page.evaluate(() => scSyncCaptureOnBuild());
  await page.waitForFunction(() => document.getElementById("lb-capture-on-build-status").textContent.length > 20);
}

/** Runs in the page: what is visible in the Screenshots block, whether any of it is cut off or too faint. */
function inspectChoice() {
  const wrap = document.getElementById("lb-capture-on-build-wrap");
  const rendered = (node) => {
    for (let n = node; n && n !== document.body; n = n.parentElement) {
      if (n.hidden || getComputedStyle(n).display === "none" || getComputedStyle(n).visibility === "hidden") return false;
    }
    const rect = node.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1;
  };
  const parse = (value) => {
    const m = /rgba?\(([^)]+)\)/.exec(value);
    if (!m) return [255, 255, 255, 1];
    const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return [r, g, b, a];
  };
  const background = (node) => {
    let base = [255, 255, 255];
    const chain = [];
    for (let n = node; n; n = n.parentElement) chain.push(parse(getComputedStyle(n).backgroundColor));
    for (const [r, g, b, a] of chain.reverse()) base = [r * a + base[0] * (1 - a), g * a + base[1] * (1 - a), b * a + base[2] * (1 - a)];
    return base;
  };
  const luminance = ([r, g, b]) => {
    const f = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const contrast = (node) => {
    const [r, g, b, a] = parse(getComputedStyle(node).color);
    const bg = background(node);
    const fg = [r * a + bg[0] * (1 - a), g * a + bg[1] * (1 - a), b * a + bg[2] * (1 - a)];
    const [hi, lo] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const texts = [...wrap.querySelectorAll("legend, .lb-capture-on-build-title, .lb-capture-on-build-help, #lb-capture-on-build-status, #lb-capture-on-build-setup")].filter(rendered);
  const problems = [];
  const lines = [];
  for (const node of texts) {
    const rect = node.getBoundingClientRect();
    const name = node.id || node.className || node.tagName.toLowerCase();
    lines.push({ name: String(name), text: node.textContent.trim() });
    if (rect.left < -0.5 || rect.right > innerWidth + 0.5) problems.push(`${name} runs off the window (${Math.round(rect.left)} to ${Math.round(rect.right)} of ${innerWidth})`);
    if (node.scrollWidth > node.clientWidth + 1 && node.clientWidth > 0) problems.push(`${name} is wider than its box`);
    for (let n = node.parentElement; n && n !== document.documentElement; n = n.parentElement) {
      const style = getComputedStyle(n);
      const box = n.getBoundingClientRect();
      if (style.overflowX !== "visible" && (rect.left < box.left - 1 || rect.right > box.right + 1)) problems.push(`${name} is cut off sideways by ${n.id || n.className}`);
      if (style.overflowY !== "visible" && n !== document.body && (rect.top < box.top - 1 || rect.bottom > box.bottom + 1)) problems.push(`${name} is cut off above or below by ${n.id || n.className}`);
    }
    if (node.matches(".lb-capture-on-build-help, #lb-capture-on-build-status, .lb-capture-on-build-title, legend")) {
      const ratio = contrast(node);
      if (ratio < 4.5) problems.push(`${name} has contrast ${ratio.toFixed(2)}:1, under 4.5:1`);
    }
  }
  const radios = [...wrap.querySelectorAll('input[type="radio"]')].filter(rendered).map((radio) => ({ id: radio.id, checked: radio.checked, disabled: radio.disabled, name: radio.labels[0]?.querySelector(".lb-capture-on-build-title")?.textContent || "", described: (radio.getAttribute("aria-describedby") || "").split(/\s+/).map((id) => document.getElementById(id)?.textContent.trim() || "") }));
  return {
    problems,
    lines,
    radios,
    legend: wrap.querySelector("legend")?.textContent || "",
    choiceShown: rendered(document.getElementById("lb-capture-on-build-choice")),
    setupShown: rendered(document.getElementById("lb-capture-on-build-setup")),
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
}

const NOT_TAKEN = /the build takes no new screenshots\. Your lab is still built, and pictures that already exist for these screens are used\. Each missing one shows a "Screenshot to add" note until you take it later in the lab's Screenshot Center\./;

for (const [name, viewport, theme] of [
  ["1440 wide, light", { width: 1440, height: 900 }, "light"],
  ["1440 wide, dark", { width: 1440, height: 900 }, "dark"],
  ["768 wide, light", { width: 768, height: 900 }, "light"],
  ["768 wide, dark", { width: 768, height: 900 }, "dark"],
  ["360 wide, light", { width: 360, height: 800 }, "light"],
  ["360 wide, dark", { width: 360, height: 800 }, "dark"],
]) {
  test(`Review and build says what the Screenshots choice does in every state, fully visible (${name})`, async (t) => {
    if (ctx.skipReason) return t.skip(ctx.skipReason);
    const { context, page, errors, answer } = await openPage(viewport, theme);
    try {
      await toReview(page);

      // The check failed: no choice, the paragraph says what a build does, the button stays.
      answer.mode = "failed";
      await refresh(page);
      let seen = await page.evaluate(inspectChoice);
      assert.deepEqual(seen.problems, [], `check failed, ${name}`);
      assert.equal(seen.choiceShown, false);
      assert.equal(seen.setupShown, true, "Set up screenshot capture is still offered");
      assert.match(seen.lines.find((l) => l.name === "lb-capture-on-build-status").text, /^We could not check whether a computer is connected, so /);
      assert.match(seen.lines.find((l) => l.name === "lb-capture-on-build-status").text, NOT_TAKEN);
      assert.equal(seen.overflow <= 0, true, `the page is not wider than the window (${seen.overflow}px)`);

      // A computer is connected: both options show, each says what it does, and building later is the default.
      answer.mode = "connected";
      await refresh(page);
      seen = await page.evaluate(inspectChoice);
      assert.deepEqual(seen.problems, [], `connected, ${name}`);
      assert.equal(seen.choiceShown, true);
      assert.equal(seen.setupShown, false);
      assert.equal(seen.legend, "Screenshots");
      assert.deepEqual(seen.radios.map((r) => r.name), ["Take the screenshots right after the build", "Build now, take the screenshots later"]);
      assert.deepEqual(seen.radios.map((r) => [r.checked, r.disabled]), [[false, false], [true, false]], "nothing is taken during the build unless the person asks");
      assert.match(seen.radios[0].described[0], /^Your connected computer opens each screen in the product and takes the pictures\. A screen it cannot take on its own waits for you in the Screenshot Center\.$/);
      assert.match(seen.radios[1].described[0], /^Your lab is ready right away\. Each missing picture shows a "Screenshot to add" note until you take it in the lab's Screenshot Center\.$/);
      for (const radio of seen.radios) assert.match(radio.described[1], /^Connected: Ada PC\. Either way, your lab is built, and pictures that already exist for these screens are used\.$/, "the connection line describes both options");
      assert.equal(seen.overflow <= 0, true);

      // No computer is connected (the real answer from the server): the choice goes away again and the paragraph says what a build does.
      answer.mode = "none";
      await refresh(page);
      seen = await page.evaluate(inspectChoice);
      assert.deepEqual(seen.problems, [], `no computer, ${name}`);
      assert.equal(seen.choiceShown, false);
      assert.equal(seen.setupShown, true);
      const text = seen.lines.find((l) => l.name === "lb-capture-on-build-status").text;
      assert.match(text, /^No computer is connected, so /);
      assert.match(text, NOT_TAKEN);
      assert.match(text, /To take them right after the build, connect your computer \(about two minutes\)\.$/);
      assert.deepEqual(errors, [], "no script errors on the page");
    } finally {
      await context.close();
    }
  });
}

test("the choice works from the keyboard, shows focus, and sends the same true or false to the server", async (t) => {
  if (ctx.skipReason) return t.skip(ctx.skipReason);
  const { context, page, errors, answer } = await openPage({ width: 1440, height: 900 });
  try {
    await toReview(page);
    answer.mode = "connected";
    await refresh(page);
    const sent = [];
    await page.route("**/api/lab-builder/generate", async (route) => {
      sent.push(route.request().postDataJSON().captureScreenshots);
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "stopped for this test" }) });
    });

    await page.click("#lb-generate-btn");
    await page.waitForFunction(() => document.getElementById("lb-generate-btn") && !document.getElementById("lb-generate-btn").disabled);
    assert.deepEqual(sent, [false], "left alone, the build asks for no capture");

    // Arrow keys move between the two options like any radio group, and the group is one tab stop.
    await page.focus("#lb-capture-later");
    await page.keyboard.press("ArrowUp");
    assert.equal(await page.evaluate(() => document.activeElement.id), "lb-capture-on-build");
    assert.equal(await page.evaluate(() => document.getElementById("lb-capture-on-build").checked), true, "the first option is picked");
    assert.equal(await page.evaluate(() => document.getElementById("lb-capture-later").checked), false, "which leaves the other unpicked");
    const outline = await page.evaluate(() => {
      const style = getComputedStyle(document.getElementById("lb-capture-on-build"));
      return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
    });
    assert.ok(outline.style !== "none" && outline.width >= 2, `the focused option has a visible outline (${outline.style} ${outline.width}px)`);

    await page.click("#lb-generate-btn");
    await page.waitForFunction(() => !document.getElementById("lb-generate-btn").disabled);
    assert.deepEqual(sent, [false, true], "picking the first option asks for a capture after the build");

    await page.click('label[for="lb-capture-later"]');
    await page.click("#lb-generate-btn");
    await page.waitForFunction(() => !document.getElementById("lb-generate-btn").disabled);
    assert.deepEqual(sent, [false, true, false], "picking the second option turns it off again");

    // Losing the computer puts the choice back to building now: nothing is asked for that cannot run.
    await page.click('label[for="lb-capture-on-build"]');
    answer.mode = "none";
    await refresh(page);
    await page.click("#lb-generate-btn");
    await page.waitForFunction(() => !document.getElementById("lb-generate-btn").disabled);
    assert.deepEqual(sent, [false, true, false, false], "with no computer connected the build never asks for a capture");
    assert.deepEqual(errors, [], "no script errors on the page");
  } finally {
    await context.close();
  }
});

test("a lab built without screenshots says where to take them, and shows a note for each missing picture", async (t) => {
  if (ctx.skipReason) return t.skip(ctx.skipReason);
  const { context, page, errors, answer } = await openPage({ width: 1440, height: 900 });
  try {
    await toReview(page);
    answer.mode = "none";
    await refresh(page);
    await page.evaluate(() => {
      document.getElementById("lb-use-learn").checked = false;
      document.getElementById("lb-use-llm").checked = false;
    });
    const posted = page.waitForRequest((req) => req.url().endsWith("/api/lab-builder/generate") && req.method() === "POST");
    await page.click("#lb-generate-btn");
    assert.equal((await posted).postDataJSON().captureScreenshots, false);
    await page.waitForSelector("#lb-result-panel", { state: "visible", timeout: 120000 });
    await page.waitForSelector("#lb-result-preview .lab-shot-card", { state: "attached", timeout: 60000 });
    await page.waitForSelector("#lb-result-preview .lb-warning[role=status]", { state: "attached" });

    const reminder = (await page.textContent("#lb-result-preview .lb-warning[role=status]")).trim();
    assert.match(reminder, /^\d+ screenshots? (is|are) not taken yet\. Each shows a "Screenshot to add" note until you take it in the Screenshot Center above\.$/);
    const cards = await page.locator("#lb-result-preview .lab-shot-card").count();
    assert.equal(Number(/^(\d+)/.exec(reminder)[1]), cards, "the reminder counts the notes in the lab");
    assert.equal(await page.isVisible("#lb-result-screenshots .sc-center"), true, "the Screenshot Center is on the result, above the lab");
    assert.match(await page.textContent("#lb-result-screenshots .sc-intro"), /Until a picture is taken, its place in the lab shows a "Screenshot to add" note\. You can also paste or upload your own\./);
    assert.match(await page.textContent("#lb-result-screenshots .sc-primary-btn"), /^Connect your computer$/, "with none connected, the one button connects one");
    assert.ok((await page.locator('#lb-result-screenshots [data-sc-action="shot-upload"]').count()) >= 1, "a picture can be uploaded without a computer");
    assert.equal(await page.locator("#lb-result-screenshots .sc-banner").count(), 0, "choosing to take them later is not a warning");
    assert.deepEqual(errors, [], "no script errors on the page");
  } finally {
    await context.close();
  }
});
