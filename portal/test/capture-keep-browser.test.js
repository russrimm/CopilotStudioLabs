/**
 * Deleting a lab and keeping its pictures, in a real browser (headless Chromium, a throwaway profile, a throwaway port, fake data):
 * the delete confirmation says in plain words what happens to the pictures, deleting keeps them, and the Screenshot Center lists
 * them under Kept pictures with Restore and Delete forever.
 *
 * Set SC_DEMO_DIR to a folder to also save screenshots of each step (for review; nothing is written there otherwise).
 * The test skips itself when Playwright or a Chromium build is not installed (tools/screenshot-capture: npm install).
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { generateLab } from "../lib/lab-builder/generator.js";
import { createCapturePlatform } from "../lib/capture/index.js";
import { libraryName } from "../../tools/screenshot-capture/harness.mjs";

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

  ctx.storageRoot = join(tmp("keep-browser-"), "storage");
  ctx.generatedRoot = join(ctx.storageRoot, "generated-labs");
  const emptyLabs = tmp("keep-browser-empty-labs-");
  const build = async () => {
    const out = await generateLab(
      { products: ["copilot-studio"], features: ["mc-memory"], harness: "microsoft-copilot", includeCore: false },
      { outputRoot: ctx.generatedRoot, labsDir: emptyLabs, useLearnMcp: false, useLlm: false },
    );
    const shots = JSON.parse(readFileSync(join(out.outputDir, "screenshots", "shots.json"), "utf8")).shots;
    return { labId: out.labId, labDir: out.outputDir, files: shots.map((s) => s.filename) };
  };
  ctx.doomed = await build();
  ctx.viewer = await build();

  const page = await ctx.browser.newPage({ viewport: { width: 1280, height: 800 } });
  const draw = async (spec) => {
    await page.setContent(fakePageHtml(spec));
    return page.screenshot({ type: "png" });
  };
  const first = await draw({ title: "Create an agent", section: "Overview", lines: ["Name: Contoso Support Assistant", "Description: Answers questions about orders and returns for Fabrikam customers."] });
  const second = await draw({ title: "Memory", section: "Settings", lines: ["Remember user preferences: On", "Retention: 30 days"] });
  const third = await draw({ title: "Trainer notes", section: "Instructions", lines: ["Say hello to the class", "Show the Contoso Support Assistant"] });
  await page.close();

  // The doomed lab took one picture on a computer with account details hidden (so it is shared), and got another by upload
  // (no proof about account details, so it exists only in that lab), plus a picture of its own that is not a shared slot.
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
  const target = store.lab(ctx.doomed.labId);
  const shared = store.submit(target, ctx.doomed.files[0], first, { evidence: evidence(target, ctx.doomed.files[0], { applied: true, masked: 2 }), source: "companion", requireEvidence: true, requireRedaction: true });
  assert.equal(shared.body.library?.outcome, "shared", JSON.stringify(shared.body));
  const byHand = store.submit(target, ctx.doomed.files[1], second, { evidence: evidence(target, ctx.doomed.files[1], null), source: "manual-upload" });
  assert.equal(byHand.status, 200, JSON.stringify(byHand.body));
  assert.equal(byHand.body.library?.code, "masking-unproven");
  writeFileSync(join(ctx.doomed.labDir, "assets", "trainer-notes.png"), third);

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

test("the delete confirmation says what happens to the pictures, deleting keeps them, and Kept pictures can restore or delete them", async (t) => {
  if (!ctx.browser) return t.skip("no browser");
  const context = await ctx.browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (err) => problems.push(err.message));
  page.on("console", (message) => message.type() === "error" && problems.push(message.text()));
  const shoot = async (name, locator) => {
    if (!DEMO_DIR) return;
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(400);
    await (locator || page).screenshot({ path: join(DEMO_DIR, `${name}.png`) });
  };

  await page.goto(`${ctx.base}/#labbuilder`);
  await page.evaluate(async () => {
    await lbLoadGenerated();
    for (let node = document.getElementById("lb-generated-list"); node; node = node.parentElement) if (node.tagName === "DETAILS") node.open = true;
  });
  const row = page.locator(`.lb-gen-item[data-lab-id="${ctx.doomed.labId}"]`);
  await row.waitFor({ timeout: 20000 });
  await page.waitForLoadState("networkidle");

  // The confirmation, before anything is deleted.
  await row.locator('[data-gen-action="delete"]').click();
  const dialog = page.locator("#lb-gen-delete-dialog");
  await dialog.waitFor({ state: "visible" });
  await page.waitForFunction(() => !/Checking/.test(document.getElementById("lb-gen-delete-pictures").textContent));
  const said = (await page.locator("#lb-gen-delete-pictures").textContent()).trim();
  assert.equal(said, "1 picture is already shared and stays available to other labs. 2 pictures exist only in this lab and will be kept for 90 days so you can restore them.");
  assert.equal(await page.locator("#lb-gen-delete-confirm").isDisabled(), false);
  assert.equal((await page.locator("#lb-gen-delete-confirm").textContent()).trim(), "Delete lab");
  assert.equal((await page.locator("#lb-gen-delete-cancel").textContent()).trim(), "Cancel");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "lb-gen-delete-cancel", "Cancel has the focus, so Enter deletes nothing");
  await shoot("1-delete-confirmation-before", dialog);

  // Cancel changes nothing.
  await page.locator("#lb-gen-delete-cancel").click();
  assert.equal(existsSync(ctx.doomed.labDir), true);

  // Delete: the lab is gone, its pictures are kept.
  await row.locator('[data-gen-action="delete"]').click();
  await page.waitForFunction(() => !/Checking/.test(document.getElementById("lb-gen-delete-pictures").textContent));
  await page.locator("#lb-gen-delete-confirm").click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(existsSync(ctx.doomed.labDir), false);
  const kept = readdirSync(join(ctx.storageRoot, "screenshots", ".kept"));
  assert.equal(kept.length, 1);

  // The Kept pictures panel, in the Screenshot Center of another lab.
  await page.evaluate(async (labId) => {
    await lbLoadGenerated();
    await lbOpenGeneratedScreenshots(labId);
  }, ctx.viewer.labId);
  const center = page.locator("#lb-result-screenshots");
  await center.locator(".sc-card").first().waitFor({ timeout: 20000 });
  await center.locator("details.sc-advanced > summary").click();
  const panel = center.locator("[data-sc-kept-host]");
  await panel.scrollIntoViewIfNeeded();
  assert.match(await center.locator("[data-sc-library-where]").textContent(), /^Shared screenshots are saved on this portal's storage volume\.$/);
  await panel.getByRole("button", { name: "Show kept pictures" }).click();
  await panel.locator(".sc-keep-row").first().waitFor();
  assert.match((await panel.locator(".sc-keep-entry-head").textContent()).trim(), /^From \u201c.+\u201d \(deleted [A-Z][a-z]{2} \d{1,2}, \d{4}\)\. 90 days left\.$/);
  const rows = panel.locator(".sc-keep-row");
  assert.equal(await rows.count(), 2);
  assert.equal(await panel.getByRole("button", { name: /^Restore/ }).count(), 1, "only the shared slot has somewhere to go");
  assert.equal(await panel.locator("a", { hasText: "Download" }).count(), 2);
  await shoot("2-kept-pictures-after", panel);

  // Restore to the shared library asks first.
  await panel.getByRole("button", { name: /^Restore to the shared library/ }).click();
  assert.equal((await panel.locator(".sc-ask-title").textContent()).trim(), "Use this picture for every lab?");
  await panel.getByRole("button", { name: "Yes, restore it to the shared library" }).click();
  await panel.locator(".sc-banner", { hasText: "Restored to the shared library. Every lab can use it." }).waitFor();
  assert.equal(await panel.locator(".sc-keep-row").count(), 1, "the restored picture leaves the archive");
  assert.equal(existsSync(join(ctx.storageRoot, "screenshots", libraryName(ctx.doomed.files[1], "microsoft-copilot"))), true, "saved under the harness's name");

  // Delete forever asks first, and Cancel changes nothing.
  await panel.getByRole("button", { name: /^Delete .* forever$/ }).click();
  assert.equal((await panel.locator(".sc-ask-text").textContent()).trim(), "It is removed from the kept pictures and cannot be restored.");
  await panel.getByRole("button", { name: "Cancel" }).click();
  assert.equal(await panel.locator(".sc-keep-row").count(), 1);
  await panel.getByRole("button", { name: /^Delete .* forever$/ }).click();
  await panel.getByRole("button", { name: "Yes, delete it forever" }).click();
  await panel.locator("[data-sc-kept-none]").waitFor();
  assert.equal((await panel.locator("[data-sc-kept-none]").textContent()).trim(), "No pictures are being kept right now.");
  assert.equal(readdirSync(join(ctx.storageRoot, "screenshots", ".kept")).length, 0);
  assert.deepEqual(problems, [], "no script errors");
  await context.close();
});
