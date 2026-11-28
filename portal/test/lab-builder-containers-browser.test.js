/**
 * The Build a Lab tab keeps to one frame: the page title and the wizard header (the step indicator, what you have chosen,
 * and the navigation), at most one status message, and one content area for the current step. This test counts the
 * containers a person can see (panels, cards, banners, boxed notes) in every wizard step and in the common states, and
 * fails when a new box is stacked on the page, so it cannot quietly get cluttered again.
 *
 * It runs in headless Chromium against a real server with throwaway storage folders, Microsoft Learn and the language
 * model off. It skips itself when Playwright or a Chromium build is not installed (tools/screenshot-capture: npm install).
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
/** The most top-level containers the tab may show at once: one step, one status message, and a finished lab. */
const TOP_LEVEL_LIMIT = 3;
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
  const root = mkdtempSync(join(tmpdir(), "lb-containers-"));
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

/**
 * Runs in the page. A container is a visible block that draws a full border or a fill of its own and is not a control
 * (button, field, link, summary, label, or an inline chip). `top` are containers with no container around them on the
 * tab; `nested` are containers inside the step that are not a choice (an option card, a row to tick) or a warning.
 */
function inspectContainers() {
  const root = document.getElementById("panel-labbuilder");
  const controlTags = new Set(["BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY", "A", "LABEL", "OPTION", "IFRAME", "TABLE", "THEAD", "TBODY", "TFOOT", "TR", "TD", "TH", "CAPTION", "FIELDSET", "LEGEND", "SPAN", "STRONG", "EM", "B", "I", "SMALL", "CODE", "KBD"]);
  const choiceOrWarning = [
    ".lb-segmented", ".lb-seg-option", ".lb-radio-option", ".scenario-role", ".lb-chip", ".lb-feature", ".lb-subtopic",
    ".lb-module", ".lb-harness-order", ".lb-mine-result", ".lb-warning", ".lb-error", '[role="alert"]', ".lb-decisions",
    ".bp-pv", ".lb-removed-section",
  ].join(",");
  const transparent = (value) => value === "rgba(0, 0, 0, 0)" || value === "transparent";
  const effectiveBackground = (node) => {
    for (let n = node; n; n = n.parentElement) {
      const bg = getComputedStyle(n).backgroundColor;
      if (!transparent(bg)) return bg;
    }
    return "";
  };
  const shown = (node) => {
    for (let n = node; n && n !== root.parentElement; n = n.parentElement) {
      const style = getComputedStyle(n);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const parent = n.parentElement;
      if (parent && parent.tagName === "DETAILS" && !parent.open && n.tagName !== "SUMMARY") return false;
    }
    const rect = node.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1;
  };
  const isContainer = (node) => {
    if (controlTags.has(node.tagName)) return false;
    const style = getComputedStyle(node);
    if (style.display.startsWith("inline") || style.display === "contents") return false;
    const fullBorder = ["Top", "Right", "Bottom", "Left"].every((side) => parseFloat(style[`border${side}Width`]) > 0 && style[`border${side}Style`] !== "none");
    const ownFill = !transparent(style.backgroundColor) && style.backgroundColor !== effectiveBackground(node.parentElement);
    return fullBorder || (ownFill && parseFloat(style.paddingTop) + parseFloat(style.paddingLeft) > 0);
  };
  const label = (node) => `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ""}${typeof node.className === "string" && node.className.trim() ? `.${node.className.trim().split(/\s+/).join(".")}` : ""}`;
  const top = [];
  const nested = [];
  const walk = (node, insideContainer, insideStep, insideChoice) => {
    for (const child of node.children) {
      if (!shown(child)) continue;
      // Saved drafts and Previously generated labs are lists to look things up in; their rows are checked below.
      if (child.classList.contains("lb-generated-section")) continue;
      const container = isContainer(child);
      const isStep = child.classList.contains("lb-pane");
      const isChoice = Boolean(child.matches(choiceOrWarning));
      if (container) {
        const entry = { label: label(child), id: child.id, classes: [...child.classList] };
        if (!insideContainer) top.push(entry);
        else if (insideStep && !insideChoice && !isChoice) nested.push(entry);
      }
      walk(child, insideContainer || container, insideStep || isStep, insideChoice || (container && isChoice));
    }
  };
  walk(root, false, false, false);
  const visible = (selector) => [...root.querySelectorAll(selector)].filter(shown);
  return {
    top,
    nested,
    library: visible(".lb-generated-section").filter(isContainer).map(label),
    panels: visible(".panel").map(label),
    status: visible("#lb-status-slot > .lb-status").map((node) => node.id),
    banner: visible("#rh-banner").length,
    frame: visible("#lb-wizard-sticky").length,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    clippedSteps: visible(".lb-step").filter((node) => node.scrollWidth > node.clientWidth + 1 || node.getBoundingClientRect().right > innerWidth).length,
  };
}

const kindOf = (box) => (box.classes.includes("lb-status") ? "status" : box.classes.includes("lb-pane") ? "step" : box.id === "lb-result-panel" ? "result" : "other");

/** One frame, one status message at most, one step, and nothing boxed inside the step that is not a choice. */
function assertCalm(report, where, { finished = false } = {}) {
  const kinds = report.top.map(kindOf);
  assert.deepEqual(report.top.filter((box) => kindOf(box) === "other").map((box) => box.label), [], `${where}: only the step, one status message, and a finished lab may be boxed`);
  assert.equal(kinds.filter((kind) => kind === "step").length, 1, `${where}: exactly one step is shown`);
  assert.ok(kinds.filter((kind) => kind === "status").length <= 1, `${where}: at most one status message`);
  assert.equal(kinds.filter((kind) => kind === "result").length, finished ? 1 : 0, `${where}: the lab card shows only once a lab is built`);
  assert.ok(report.top.length <= TOP_LEVEL_LIMIT, `${where}: ${report.top.length} containers on the page (${report.top.map((box) => box.label).join(", ")}); the limit is ${TOP_LEVEL_LIMIT}`);
  assert.deepEqual(report.nested.map((box) => box.label), [], `${where}: no box inside the step unless it is a choice or a warning`);
  assert.deepEqual(report.library, [], `${where}: Saved drafts and Previously generated labs are plain rows, not cards`);
  assert.ok(report.status.length <= 1, `${where}: the status slot shows ${report.status.join(", ")}`);
  assert.equal(report.frame, 1, `${where}: one wizard header`);
  assert.ok(report.overflow <= 0, `${where}: the page is ${report.overflow}px wider than the window`);
  assert.equal(report.clippedSteps, 0, `${where}: no step pill is cut off`);
}

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
  await page.goto(`${ctx.base}/#labbuilder`);
  await page.waitForSelector("#lb-product-options input");
  await page.waitForFunction(() => document.querySelectorAll("#lb-steps li:not([hidden])").length === 4);
  return { context, page, errors };
}

async function toStep(page, step) {
  const current = await page.evaluate(() => labBuilder.step);
  if (step >= 2 && current < 2) {
    if (!(await page.$("#lb-product-options input:checked"))) await page.click('#lb-product-options label:has(input[value="copilot-studio"])');
    await page.click("#lb-pane-1 .lb-nav-next");
    await page.waitForSelector("#lb-pane-2", { state: "visible" });
    await page.waitForFunction(() => document.querySelectorAll("#lb-level-options .lb-seg-count").length === 3);
  }
  if (step >= 3 && current < 3) {
    await page.click("#lb-pane-2 .lb-nav-next");
    await page.waitForSelector("#lb-pane-3", { state: "visible" });
    await page.waitForSelector("#lb-topic-groups details.lb-concept");
    await page.waitForFunction(() => /^Suggested lab: \d+ topics?/.test(document.getElementById("lb-topic-summary").textContent));
  }
  if (step >= 4 && current < 4) {
    await page.click("#lb-pane-3 .lb-nav-next");
    await page.waitForSelector("#lb-pane-4", { state: "visible" });
    await page.waitForSelector("#lb-preview table.lb-outline");
  }
}

for (const [name, viewport, theme] of [
  ["wide, light", { width: 1440, height: 900 }, "light"],
  ["wide, dark", { width: 1440, height: 900 }, "dark"],
  ["narrow, light", { width: 360, height: 800 }, "light"],
  ["narrow, dark", { width: 360, height: 800 }, "dark"],
]) {
  test(`every wizard step keeps to one frame and one content area (${name})`, async (t) => {
    if (ctx.skipReason) return t.skip(ctx.skipReason);
    const { context, page, errors } = await openPage(viewport, theme);
    try {
      for (let step = 1; step <= 4; step += 1) {
        await toStep(page, step);
        await page.waitForTimeout(150);
        const report = await page.evaluate(inspectContainers);
        assertCalm(report, `step ${step}, ${name}`);
        if (step === 1) assert.equal(report.banner, 1, "the first-run banner is a slim line on a fresh install and is not boxed");
      }
      // The optional choices on Review and build open in place; none of them adds a box.
      await page.click("#lb-brand-change");
      await page.waitForSelector("#lb-customize-card", { state: "visible" });
      await page.evaluate(() => document.querySelectorAll("#lb-pane-4 details").forEach((d) => (d.open = true)));
      assertCalm(await page.evaluate(inspectContainers), `step 4 with every option open, ${name}`);
      assert.deepEqual(errors, [], "no script errors on the page");
    } finally {
      await context.close();
    }
  });
}

test("a dismissed first-run banner leaves the title and the wizard where they were", async (t) => {
  if (ctx.skipReason) return t.skip(ctx.skipReason);
  const { context, page } = await openPage({ width: 1440, height: 900 });
  try {
    await page.waitForSelector("#rh-banner:not([hidden])");
    const before = await page.evaluate(inspectContainers);
    assert.equal(before.banner, 1);
    await page.click("#rh-banner-dismiss");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "lb-build-heading", "focus lands on the page title");
    const after = await page.evaluate(inspectContainers);
    assert.equal(after.banner, 0);
    assertCalm(after, "after dismissing the banner");
  } finally {
    await context.close();
  }
});

test("the status slot shows one message at a time, the most important first", async (t) => {
  if (ctx.skipReason) return t.skip(ctx.skipReason);
  const { context, page } = await openPage({ width: 1440, height: 900 });
  try {
    await toStep(page, 2);
    const shown = async () => (await page.evaluate(inspectContainers)).status;
    assert.deepEqual(await shown(), [], "nothing to say, nothing shown");

    // Everything that can speak does, all at once.
    await page.evaluate(() => {
      lbDraftAnnounce("Saved. You can pick this up later under Saved drafts.");
      lbDraftShowNotice('Resumed "Demo". You are on Step 2 of 4: Tailor it.', ["One topic is no longer listed."]);
      lbSetEditing({ labId: "demo", title: "Demo lab" });
      document.getElementById("lb-unsaved-banner-text").textContent = "You have unsaved work from today at 3:00 PM. Resume or discard.";
      document.getElementById("lb-unsaved-banner").hidden = false;
      lbAskStartOver();
    });
    assert.deepEqual(await shown(), ["lb-start-over-confirm"], "a question that needs an answer comes first");
    assertCalm(await page.evaluate(inspectContainers), "with every message waiting");

    await page.click("#lb-start-over-keep");
    assert.deepEqual(await shown(), ["lb-unsaved-banner"], "then work that would otherwise be lost");
    await page.evaluate(() => (document.getElementById("lb-unsaved-banner").hidden = true));
    assert.deepEqual(await shown(), ["lb-edit-banner"], "then the lab being edited");
    await page.evaluate(() => lbStopEditing(true));
    assert.deepEqual(await shown(), ["lb-draft-notice"], "then a resumed draft");
    await page.evaluate(() => lbDraftHideNotice());
    assert.deepEqual(await shown(), ["lb-draft-status"], "and last the plain status");
    assert.equal(await page.evaluate(() => document.getElementById("lb-draft-status").textContent), "Kept your choices.", "the answer to the question is the status");
    await page.evaluate(() => lbDraftAnnounce(""));
    assert.deepEqual(await shown(), []);

    // The live regions stay in the page for a screen reader, whichever message is showing.
    for (const id of ["lb-draft-status", "lb-draft-announce", "lb-summary-announce"]) {
      assert.match((await page.getAttribute(`#${id}`, "aria-live")) || "", /polite/, `${id} is still a polite live region`);
    }
    assert.equal(await page.getAttribute("#lb-draft-status", "role"), "status");
  } finally {
    await context.close();
  }
});

test("start over, editing a lab, and a build in progress or finished each stay within the limit", async (t) => {
  if (ctx.skipReason) return t.skip(ctx.skipReason);
  const { context, page, errors } = await openPage({ width: 1440, height: 900 });
  try {
    await toStep(page, 3);

    await page.click("#lb-start-over");
    await page.waitForSelector("#lb-start-over-confirm", { state: "visible" });
    assert.equal(await page.evaluate(() => document.activeElement?.id), "lb-start-over-keep", "focus lands on the safe answer");
    assertCalm(await page.evaluate(inspectContainers), "start over asking");
    await page.click("#lb-start-over-keep");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "lb-start-over", "focus goes back to Start over");

    await page.evaluate(() => lbSetEditing({ labId: "demo-lab", title: "Demo lab" }));
    assertCalm(await page.evaluate(inspectContainers), "editing an existing lab");
    assert.deepEqual((await page.evaluate(inspectContainers)).status, ["lb-edit-banner"]);

    await toStep(page, 4);
    await page.evaluate(() => {
      document.getElementById("lb-use-learn").checked = false;
      document.getElementById("lb-use-llm").checked = false;
    });
    assertCalm(await page.evaluate(inspectContainers), "editing, on Review and build");
    assert.equal(await page.isVisible("#lb-save-mode"), true, "the save choice is still there while editing");
    await page.evaluate(() => lbStopEditing(true));

    // Hold the build open so the running state can be looked at.
    let release;
    const held = new Promise((resolveHeld) => {
      release = resolveHeld;
    });
    await page.route("**/api/lab-builder/generate", async (route) => {
      await held;
      await route.continue();
    });
    await page.click("#lb-generate-btn");
    await page.waitForSelector("#lb-generating-card", { state: "visible" });
    assertCalm(await page.evaluate(inspectContainers), "a build running");
    release();
    await page.waitForSelector("#lb-result-panel", { state: "visible", timeout: 120000 });
    await page.waitForSelector(".lb-result-title");
    assertCalm(await page.evaluate(inspectContainers), "a finished build", { finished: true });
    assert.deepEqual(errors, [], "no script errors on the page");
  } finally {
    await context.close();
  }
});

test("a resumed draft and an offer of unsaved work each show one message", async (t) => {
  if (ctx.skipReason) return t.skip(ctx.skipReason);
  const { context, page } = await openPage({ width: 1440, height: 900 });
  try {
    await page.waitForFunction(() => lbDraft.loaded);
    await toStep(page, 2);
    await page.waitForResponse((res) => res.url().endsWith("/api/lab-builder/drafts/unsaved") && res.request().method() === "PUT", { timeout: 20000 });

    // A refresh in the middle of a lab offers the work back.
    await page.reload();
    await page.waitForSelector("#lb-product-options input");
    await page.waitForSelector("#lb-unsaved-banner:not([hidden])");
    assertCalm(await page.evaluate(inspectContainers), "an offer of unsaved work");
    assert.deepEqual((await page.evaluate(inspectContainers)).status, ["lb-unsaved-banner"]);
    await page.click("#lb-unsaved-resume");
    await page.waitForFunction(() => labBuilder.step === 2 && document.activeElement?.id === "lb-heading-2");
    assertCalm(await page.evaluate(inspectContainers), "resumed unsaved work");

    // Save on purpose, start over, and resume the named draft: the notice replaces the offer, and Saved works.
    await page.click("#lb-save-draft");
    await page.waitForSelector("#lb-draft-name-dialog[open]");
    await page.fill("#lb-draft-name", "Container test draft");
    await page.click("#lb-draft-name-save");
    await page.waitForFunction(() => /^Saved\./.test(document.getElementById("lb-draft-status").textContent));
    await page.click("#lb-start-over");
    await page.click("#lb-start-over-yes");
    await page.waitForFunction(() => labBuilder.step === 1 && labBuilder.selectedProducts.size === 0);
    await page.click("#lb-drafts-details > summary");
    await page.click('#lb-drafts-list button[aria-label="Resume Container test draft"]');
    await page.waitForSelector("#lb-draft-notice:not([hidden])");
    assertCalm(await page.evaluate(inspectContainers), "a resumed draft");
    assert.deepEqual((await page.evaluate(inspectContainers)).status, ["lb-draft-notice"]);
  } finally {
    await context.close();
  }
});
