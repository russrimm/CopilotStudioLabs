/**
 * The prerequisites checklist in a real browser (headless Chromium, a throwaway profile, a throwaway port, fake data):
 * the button and format picker in the lab panel, the download for the chosen format, and the preview dialog with the keyboard.
 *
 * Set PREREQ_DEMO_DIR to a folder to also save screenshots of the panel and the preview (for review; nothing is written
 * there otherwise). The test skips itself when Playwright or a Chromium build is not installed
 * (tools/screenshot-capture: npm install).
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

const here = dirname(fileURLToPath(import.meta.url));
const PORTAL_ROOT = resolve(here, "..");
const PLAYWRIGHT = resolve(PORTAL_ROOT, "..", "tools", "screenshot-capture", "node_modules", "playwright", "index.mjs");
const DEMO_DIR = process.env.PREREQ_DEMO_DIR ? resolve(process.env.PREREQ_DEMO_DIR) : "";
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

before(async (t) => {
  if (!existsSync(PLAYWRIGHT)) return t.skip("Playwright is not installed (tools/screenshot-capture: npm install).");
  const { chromium } = await import(pathToFileURL(PLAYWRIGHT).href);
  try {
    ctx.browser = await chromium.launch({ headless: true });
  } catch (err) {
    return t.skip(`No headless Chromium is available: ${err.message.split("\n")[0]}`);
  }
  cleanups.push(() => ctx.browser?.close());

  ctx.storageRoot = join(tmp("prereq-browser-"), "storage");
  ctx.generatedRoot = join(ctx.storageRoot, "generated-labs");
  mkdirSync(ctx.generatedRoot, { recursive: true });
  process.env.LAB_BUILDER_LINK_CHECK = "off";
  process.env.LAB_BUILDER_VENDOR_DOCS = "off";
  const built = await generateLab(
    { products: ["copilot-studio", "sharepoint-ai"], harness: "standard", features: ["create-agent", "knowledge-sharepoint", "connector-tools"], includeCore: false, industry: "manufacturing" },
    { outputRoot: ctx.generatedRoot, useLearnMcp: false, useLlm: false },
  );
  ctx.labId = built.labId;

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

test("an author picks a format, downloads only the prerequisites, and previews what the customer gets, with the keyboard", async (t) => {
  if (!ctx.browser) return t.skip("no browser");
  const context = await ctx.browser.newContext({ viewport: { width: 1280, height: 1600 }, acceptDownloads: true });
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (err) => problems.push(err.message));
  page.on("console", (message) => message.type() === "error" && problems.push(message.text()));

  await page.goto(ctx.base);
  await page.evaluate(async (labId) => {
    await lbLoadGenerated();
    await lbOpenGenerated(labId);
  }, ctx.labId);
  const group = page.locator("#lb-result-meta .lb-prereq-group");
  await group.waitFor({ timeout: 20000 });
  assert.match(await group.innerText(), /Prerequisites checklist/i);
  assert.equal((await group.locator(".lb-prereq-note").textContent()).trim(), "Only the prerequisites, safe to send to the customer.");
  const picker = group.getByLabel(/^Format of the prerequisites checklist for/);
  assert.deepEqual(await picker.locator("option").allTextContents(), ["Word (.docx), recommended", "PDF (.pdf)", "Web page (.html)", "Markdown (.md)"]);
  assert.equal(await picker.inputValue(), "docx", "Word is the default");
  if (DEMO_DIR) await group.screenshot({ path: join(DEMO_DIR, "1-lab-panel-button.png") });

  // Download Word (the default) with the keyboard.
  const download = group.getByRole("button", { name: /^Download prerequisites checklist for/ });
  await download.focus();
  const [docx] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Enter")]);
  assert.match(docx.suggestedFilename(), / - Prerequisites checklist\.docx$/);
  const docxPath = join(tmp("prereq-dl-"), "checklist.docx");
  await docx.saveAs(docxPath);
  assert.equal(readFileSync(docxPath).subarray(0, 2).toString(), "PK", "a Word file is a zip package");

  // Choose PDF in the picker, then download it.
  await picker.selectOption("pdf");
  const [pdf] = await Promise.all([page.waitForEvent("download"), download.click()]);
  assert.match(pdf.suggestedFilename(), / - Prerequisites checklist\.pdf$/);
  const pdfPath = join(tmp("prereq-dl-"), "checklist.pdf");
  await pdf.saveAs(pdfPath);
  assert.match(readFileSync(pdfPath).subarray(0, 8).toString("latin1"), /^%PDF-1\.4/);

  // The preview shows the same document, without scripts, and gives the focus back when it closes.
  const preview = group.getByRole("button", { name: /^Preview the prerequisites checklist for/ });
  await preview.focus();
  await page.keyboard.press("Enter");
  const dialog = page.locator("#lb-prereq-preview-dialog");
  await dialog.waitFor({ state: "visible" });
  assert.equal(await page.evaluate(() => document.activeElement?.id), "lb-prereq-preview-close", "the focus moves into the dialog");
  const frame = page.frameLocator("#lb-prereq-preview-frame");
  await frame.getByText("Please complete before the workshop").waitFor({ timeout: 10000 });
  assert.match(await dialog.locator("#lb-prereq-preview-desc").textContent(), /^This is what the customer gets: \d+ items across \d+ roles, and nothing else from the lab\.$/);
  assert.ok((await frame.locator("tr[data-role]").count()) > 5, "the checklist rows are there");
  assert.ok((await frame.locator("input[type=checkbox]").count()) > 5, "each row has a checkbox");
  assert.equal(await frame.getByText("Knowledge check", { exact: false }).count(), 0, "no quiz in the customer's copy");
  if (DEMO_DIR) await dialog.screenshot({ path: join(DEMO_DIR, "2-preview-dialog.png") });

  // The dialog downloads the format that was picked.
  const [fromDialog] = await Promise.all([page.waitForEvent("download"), dialog.getByRole("button", { name: "Download prerequisites checklist" }).click()]);
  assert.match(fromDialog.suggestedFilename(), / - Prerequisites checklist\.pdf$/);

  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-gen-action")), "preview-prereqs", "the focus returns to Preview");

  assert.deepEqual(problems, [], "no console errors or page errors");
  await context.close();
});

test("the last wizard step's success state offers the same checklist download next to the other downloads", async (t) => {
  if (!ctx.browser) return t.skip("no browser");
  const context = await ctx.browser.newContext({ viewport: { width: 1280, height: 1600 }, acceptDownloads: true });
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (err) => problems.push(err.message));
  await page.goto(ctx.base);
  // The same object the generate call returns, reduced to what the success state reads.
  await page.evaluate((labId) => {
    lbShowResult({
      labId,
      title: "Fabrikam Plant Operations Assistant",
      difficulty: "Beginner",
      duration: "About 1 hour",
      manifest: { grounding: { groundedModules: 1, totalModules: 1 }, screenshots: { reused: 0, pending: 0 }, level: 100, modules: [] },
      validation: { passed: 1, failed: 0 },
      markdown: "# Fabrikam Plant Operations Assistant",
      warnings: [],
    });
  }, ctx.labId);
  const downloads = page.locator("#lb-result-meta .lb-download-files-group");
  const group = page.locator("#lb-result-meta .lb-prereq-group");
  await group.waitFor({ timeout: 10000 });
  assert.equal(await downloads.count(), 1, "the other downloads are there");
  assert.equal(await group.count(), 1);
  assert.match(await group.innerText(), /Download prerequisites checklist/);
  assert.match(await group.innerText(), /Only the prerequisites, safe to send to the customer\./);
  const [file] = await Promise.all([page.waitForEvent("download"), group.getByRole("button", { name: /^Download prerequisites checklist for/ }).click()]);
  assert.match(file.suggestedFilename(), / - Prerequisites checklist\.docx$/);
  assert.deepEqual(problems, []);
  await context.close();
});