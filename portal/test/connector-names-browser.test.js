/**
 * Connector display names in a real browser (headless Chromium, a throwaway profile, a throwaway port, fake data): a lab saved
 * with a connector's internal name in its text and in its shot list is shown with the display name in the lab preview and in
 * the Screenshot Center. The lab's files on disk are left as they were.
 *
 * The test skips itself when Playwright or a Chromium build is not installed (tools/screenshot-capture: npm install).
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { generateLab } from "../lib/lab-builder/generator.js";

const here = dirname(fileURLToPath(import.meta.url));
const PORTAL_ROOT = resolve(here, "..");
const PLAYWRIGHT = resolve(PORTAL_ROOT, "..", "tools", "screenshot-capture", "node_modules", "playwright", "index.mjs");
const ENTRA = "HTTP with Microsoft Entra ID (preauthorized)";
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

  ctx.storageRoot = join(tmp("connector-names-browser-"), "storage");
  ctx.generatedRoot = join(ctx.storageRoot, "generated-labs");
  const built = await generateLab(
    { industry: "retail", roles: ["customer-service"], features: ["connector-tools"], title: "Contoso Connector Lab" },
    { outputRoot: ctx.generatedRoot, labsDir: tmp("connector-names-empty-labs-"), useLearnMcp: false, useLlm: false },
  );
  assert.equal(built.status, "complete");
  ctx.labId = built.labId;
  ctx.labDir = built.outputDir;

  // Age the lab: the text and the shot list carry internal names, as a lab saved by an earlier build would.
  const indexPath = join(ctx.labDir, "index.md");
  const md = readFileSync(indexPath, "utf8");
  const aged = md.replace("Select the service you want to connect to", "Select the service you want to connect to (`shared_webcontents`)");
  assert.notEqual(aged, md, "the connector topic has the step that was aged");
  writeFileSync(indexPath, aged);
  ctx.indexAfterAging = aged;
  const shotsPath = join(ctx.labDir, "screenshots", "shots.json");
  const plan = JSON.parse(readFileSync(shotsPath, "utf8"));
  const shot = plan.shots.find((s) => Array.isArray(s.instructions) && s.instructions.length);
  assert.ok(shot, "the lab has a shot with instructions");
  shot.instructions[0] = `${shot.instructions[0].replace(/\.$/, "")} for the shared_sharepointonline connector.`;
  ctx.agedInstruction = shot.instructions[0];
  writeFileSync(shotsPath, `${JSON.stringify(plan, null, 2)}\n`);

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

test("the lab preview and the Screenshot Center show a connector's display name, not its internal name", async (t) => {
  if (!ctx.browser) return t.skip("no browser");
  const context = await ctx.browser.newContext({ viewport: { width: 1280, height: 2400 } });
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (err) => problems.push(err.message));
  page.on("console", (message) => message.type() === "error" && problems.push(message.text()));

  await page.goto(ctx.base);
  await page.evaluate(async (labId) => {
    await lbLoadGenerated();
    await lbOpenGenerated(labId);
  }, ctx.labId);
  const preview = page.locator("#lb-result-preview");
  await page.waitForFunction(() => /Connector tools/.test(document.querySelector("#lb-result-preview")?.textContent || ""), null, { timeout: 20000 });
  const previewText = await preview.textContent();
  assert.ok(previewText.includes(`connect to (${ENTRA})`), "the aged step reads with the display name");
  assert.ok(!/shared_[a-z]/i.test(previewText), "and the lab preview shows no internal name");

  await page.evaluate(async (labId) => {
    await lbOpenGeneratedScreenshots(labId);
  }, ctx.labId);
  const gallery = page.locator("#lb-result-screenshots .sc-gallery");
  await gallery.locator(".sc-card").first().waitFor({ timeout: 20000 });
  const galleryText = await gallery.textContent();
  assert.ok(!/shared_[a-z]/i.test(galleryText), "the Screenshot Center shows no internal name");
  // What a picture should show (the lab's instructions) is in the data the Screenshot Center draws from.
  const status = await page.evaluate(async (labId) => (await fetch(`/api/lab-builder/generated/${labId}/screenshots`)).text(), ctx.labId);
  assert.ok(status.includes("for the SharePoint connector."), "its instructions carry the display name");
  assert.ok(!/shared_[a-z]/i.test(status), "and no internal name");
  assert.deepEqual(problems, []);
  await context.close();

  assert.equal(readFileSync(join(ctx.labDir, "index.md"), "utf8"), ctx.indexAfterAging, "the lab's own text is read, not rewritten");
});
