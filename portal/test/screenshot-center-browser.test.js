/**
 * Screenshot Center in a real browser (headless Chromium, a throwaway profile, a throwaway port, fake data):
 * where each picture comes from, Mark as accurate, the Confirmed badge, the "not confirmed yet" filter, keyboard use, and
 * the question a retake asks before it replaces a picture other labs use.
 *
 * Set SC_DEMO_DIR to a folder to also save screenshots of each step (for review; nothing is written there otherwise).
 * The test skips itself when Playwright or a Chromium build is not installed (tools/screenshot-capture: npm install).
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { generateLab } from "../lib/lab-builder/generator.js";
import { createCapturePlatform } from "../lib/capture/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const PORTAL_ROOT = resolve(here, "..");
const PLAYWRIGHT = resolve(PORTAL_ROOT, "..", "tools", "screenshot-capture", "node_modules", "playwright", "index.mjs");
const DEMO_DIR = process.env.SC_DEMO_DIR ? resolve(process.env.SC_DEMO_DIR) : "";
const cleanups = [];
const ctx = {};

function tmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

/** A made-up product page (fake names only), drawn in the browser, so the pictures in the screenshots are easy to read. */
function fakePageHtml({ title, section, lines }) {
  return `<!doctype html><meta charset="utf-8"><body style="margin:0;font:16px Segoe UI,Arial,sans-serif;background:#eef1f6;width:1280px;height:800px;display:flex;flex-direction:column">
  <header style="background:#1f4e8c;color:#fff;padding:14px 24px;font-size:20px;font-weight:600">Contoso Support Assistant<span style="float:right;font-size:14px;font-weight:400">Demo environment</span></header>
  <div style="display:flex;flex:1"><nav style="width:220px;background:#262b3a;color:#cfd6e6;padding:20px 0">
    ${["Overview", "Knowledge", "Tools", "Instructions", "Settings"].map((n) => `<div style="padding:12px 24px;${n === section ? "background:#3a4258;color:#fff;font-weight:600" : ""}">${n}</div>`).join("")}</nav>
  <main style="flex:1;padding:32px"><h1 style="margin:0 0 20px;font-size:28px;color:#1b2333">${title}</h1>
    ${lines.map((l) => `<div style="background:#fff;border:1px solid #c9d1e0;border-radius:8px;padding:18px 20px;margin-bottom:14px;color:#2b3447">${l}</div>`).join("")}</main></div></body>`;
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

  ctx.storageRoot = join(tmp("sc-browser-"), "storage");
  ctx.generatedRoot = join(ctx.storageRoot, "generated-labs");
  const emptyLabs = tmp("sc-browser-empty-labs-");
  const build = async () => {
    const out = await generateLab(
      { products: ["copilot-studio"], features: ["mc-memory"], harness: "microsoft-copilot", includeCore: false },
      { outputRoot: ctx.generatedRoot, labsDir: emptyLabs, useLearnMcp: false, useLlm: false },
    );
    const shots = JSON.parse(readFileSync(join(out.outputDir, "screenshots", "shots.json"), "utf8")).shots;
    return { labId: out.labId, files: shots.map((s) => s.filename) };
  };
  ctx.source = await build();
  ctx.viewer = await build();
  ctx.other = await build();

  // Two fake pages to use as the screenshots.
  const page = await ctx.browser.newPage({ viewport: { width: 1280, height: 800 } });
  const draw = async (spec) => {
    await page.setContent(fakePageHtml(spec));
    return page.screenshot({ type: "png" });
  };
  const first = await draw({ title: "Create an agent", section: "Overview", lines: ["Name: Contoso Support Assistant", "Description: Answers questions about orders and returns for Fabrikam customers.", "Language: English (United States)"] });
  const second = await draw({ title: "Memory", section: "Settings", lines: ["Remember user preferences: On", "Retention: 30 days", "Contoso Support Assistant can review and delete what it remembers."] });
  await page.close();

  // The source lab took the first picture on a computer with account details hidden, so it went into the shared library.
  // The viewer lab got the second one by upload, which carries no proof about account details, so it stays in that lab.
  const platform = createCapturePlatform({ generatedRoot: ctx.generatedRoot, dataDir: join(ctx.storageRoot, "data"), env: { PORTAL_STORAGE_ROOT: ctx.storageRoot }, detectServerBrowser: async () => ({ available: false }) });
  const store = platform.screenshots;
  const evidence = (target, filename, redaction) => ({
    finalUrl: "https://copilotstudio.microsoft.com/environments/00000000-0000-0000-0000-000000000000/bots",
    title: "Contoso Support Assistant",
    visibleText: [...target.slot(filename).expectedLabels, "Settings"],
    ...(redaction ? { redaction } : {}),
    capturedAt: new Date().toISOString(),
    executedSteps: 4,
  });
  const sourceTarget = store.lab(ctx.source.labId);
  const shared = store.submit(sourceTarget, ctx.source.files[0], first, { evidence: evidence(sourceTarget, ctx.source.files[0], { applied: true, masked: 2 }), source: "companion", requireEvidence: true, requireRedaction: true });
  assert.equal(shared.body.library?.outcome, "shared", JSON.stringify(shared.body));
  const viewerTarget = store.lab(ctx.viewer.labId);
  const byHand = store.submit(viewerTarget, ctx.viewer.files[1], second, { evidence: evidence(viewerTarget, ctx.viewer.files[1], null), source: "manual-upload" });
  assert.equal(byHand.status, 200, JSON.stringify(byHand.body));
  assert.equal(byHand.body.library?.code, "masking-unproven");

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
      PORTAL_STORAGE_ROOT: ctx.storageRoot,
      FEATURE_TOUR_SCREENSHOTS_DIR: "",
      LAB_BUILDER_LINK_CHECK: "off",
      LAB_BUILDER_LLM: "off",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  cleanups.push(() => child.kill());
  const deadline = Date.now() + 30000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}): ${stderr.slice(-800)}`);
    try {
      if ((await fetch(`${ctx.base}/healthz`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("server did not start in time");
    await new Promise((r) => setTimeout(r, 150));
  }
  if (DEMO_DIR) mkdirSync(DEMO_DIR, { recursive: true });
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

test("the Screenshot Center shows where each picture comes from, and Mark as accurate, Confirmed, and the filter work with the keyboard", async (t) => {
  if (!ctx.browser) return t.skip("no browser");
  const context = await ctx.browser.newContext({ viewport: { width: 1280, height: 2400 } });
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (err) => problems.push(err.message));
  page.on("console", (message) => message.type() === "error" && problems.push(message.text()));
  const shoot = async (name) => {
    if (!DEMO_DIR) return;
    // The panel redraws itself after a change (the lab files refresh); wait for it to settle, then capture the gallery in page
    // coordinates so the portal's sticky header does not cover it.
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(600);
    const box = await page.locator("#lb-result-screenshots .sc-gallery").evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height };
    });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: join(DEMO_DIR, `${name}.png`), fullPage: true, clip: box });
  };

  await page.goto(ctx.base);
  await page.evaluate(async (labId) => {
    await lbLoadGenerated();
    await lbOpenGeneratedScreenshots(labId);
  }, ctx.viewer.labId);
  const gallery = page.locator("#lb-result-screenshots .sc-gallery");
  await gallery.locator(".sc-card").first().waitFor({ timeout: 20000 });
  const card = (filename) => page.locator(`#lb-result-screenshots .sc-card[data-filename="${filename}"]`);
  const [library, own] = ctx.viewer.files;
  const dated = /captured [A-Z][a-z]{2} \d{1,2}, \d{4}$/;

  // Where each picture comes from.
  const librarySource = (await card(library).locator(".sc-source").textContent()).trim();
  assert.match(librarySource, /^Shared library \(every lab can use it\) \u00b7 /);
  assert.match(librarySource, dated);
  const ownSource = (await card(own).locator(".sc-source").textContent()).trim();
  assert.match(ownSource, /^This lab only \(will be kept for 90 days if you delete or replace this lab\) \u00b7 /);
  assert.match(ownSource, dated);
  assert.equal((await card(library).locator(".sc-status-chip").textContent()).trim(), "Captured", "a reused picture is Captured, not Pending");
  assert.match(await gallery.locator(".sc-confirm-summary").textContent(), /^0 of 2 captured screenshots confirmed accurate\./);
  assert.equal((await gallery.locator("[data-sc-unconfirmed-label]").textContent()).trim(), "Show only screenshots not confirmed yet (2)");
  await shoot("1-source-labels");

  // Mark as accurate with the keyboard (Tab to the button, Enter).
  const mark = card(own).getByRole("button", { name: /^Mark as accurate/ });
  await mark.focus();
  await page.keyboard.press("Enter");
  await card(own).locator(".sc-confirmed-chip").waitFor({ timeout: 10000 });
  assert.match((await card(own).locator(".sc-confirmed-chip").textContent()).trim(), /^Confirmed [A-Z][a-z]{2} \d{1,2}, \d{4}$/);
  assert.equal(await card(own).getByRole("button", { name: /^Clear confirmation/ }).count(), 1);
  assert.equal(await card(own).getByRole("button", { name: /^Mark as accurate/ }).count(), 0);
  assert.equal(await card(library).locator(".sc-confirmed-chip").count(), 0, "only the marked picture carries the badge");
  assert.equal((await gallery.locator("[data-sc-unconfirmed-label]").textContent()).trim(), "Show only screenshots not confirmed yet (1)");
  assert.match(await gallery.locator(".sc-confirm-summary").textContent(), /^1 of 2 captured screenshots confirmed accurate\./);
  await shoot("2-confirmed");

  // The filter, with the keyboard (Space on the checkbox).
  const only = page.locator("#sc-only-unconfirmed");
  await only.focus();
  await page.keyboard.press("Space");
  await page.waitForFunction(() => document.querySelectorAll("#lb-result-screenshots .sc-card").length === 1);
  assert.equal(await card(library).count(), 1);
  assert.equal(await card(own).count(), 0, "the confirmed picture is hidden by the filter");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "sc-only-unconfirmed", "the focus stays on the checkbox");
  await shoot("3-not-confirmed-filter");
  await page.keyboard.press("Space");
  await page.waitForFunction(() => document.querySelectorAll("#lb-result-screenshots .sc-card").length === 2);

  // The preview dialog offers the same button and shows the source.
  await card(own).locator(".sc-thumb").click();
  const dialog = page.locator("#lb-result-screenshots dialog.sc-lightbox");
  await dialog.waitFor({ state: "visible" });
  assert.match(await dialog.locator(".sc-lb-source").textContent(), /^This lab only \(will be kept for 90 days/);
  assert.equal(await dialog.getByRole("button", { name: /^Clear confirmation/ }).count(), 1);
  if (DEMO_DIR) await dialog.screenshot({ path: join(DEMO_DIR, "4-preview-dialog.png") });
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });

  // Retaking a shared picture other labs show asks first, in plain words; Cancel changes nothing.
  await card(library).getByRole("button", { name: /^Retake:/ }).click();
  const ask = card(library).locator(".sc-ask");
  await ask.waitFor({ timeout: 10000 });
  assert.equal((await ask.locator(".sc-ask-text").textContent()).trim(), "This picture is shared. 1 other lab uses it. A new capture replaces it for that lab. The old picture is kept as a backup.");
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Cancel");
  await shoot("5-retake-asks-first");
  await ask.getByRole("button", { name: "Cancel" }).click();
  assert.equal(await card(library).locator(".sc-ask").count(), 0);
  assert.match(await card(library).locator(".sc-source").textContent(), /^Shared library/, "nothing changed");

  // Clear confirmation puts it back.
  await card(own).getByRole("button", { name: /^Clear confirmation/ }).click();
  await card(own).getByRole("button", { name: /^Mark as accurate/ }).waitFor({ timeout: 10000 });
  assert.equal(await card(own).locator(".sc-confirmed-chip").count(), 0);

  // The lab's own status API carries the same facts.
  const api = await (await fetch(`${ctx.base}/api/lab-builder/generated/${ctx.viewer.labId}/screenshots`)).json();
  assert.equal(api.shots.find((s) => s.filename === library).imageSource, "library");
  assert.equal(api.shots.find((s) => s.filename === own).imageSource, "lab");
  assert.deepEqual(problems, [], "no console errors or page errors");
  await context.close();
});
