/**
 * Pictures that look wrong, in a real browser (headless Chromium, a throwaway profile, a throwaway port, synthetic pictures): the portal
 * checks the shared library once at start without moving anything, the Screenshot Center says so in one line, the "Pictures that look
 * wrong" panel lists each picture with its plain reason, Keep this one and Move to kept pictures work from the keyboard, and a moved
 * picture is in the kept pictures list and can be restored.
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
import { sha256Hex } from "../lib/capture/library-share.js";
import { writeLabVerificationRecord } from "../lib/lab-builder/lab-screenshots.js";
import { formPage, homePage, hubPage } from "./fixtures/block-pictures.js";

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

/** The first free port from the range this work may use. */
async function freePort() {
  for (let port = 3161; port <= 3169; port += 1) {
    const free = await new Promise((resolveFree) => {
      const probe = createServer();
      probe.once("error", () => resolveFree(false));
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolveFree(true)));
    });
    if (free) return port;
  }
  throw new Error("no free port from 3161 to 3169");
}

const record = (bytes, steps = [{ action: "open", label: "Open the page", ok: true, found: true, urlBefore: "make.powerapps.com/start", urlAfter: "make.powerapps.com/home" }]) => ({
  ok: true,
  level: "pass",
  reasons: [],
  sha256: sha256Hex(bytes),
  state: "accepted",
  finalUrl: "https://make.powerapps.com/environments/00000000-0000-0000-0000-000000000000/home",
  redaction: { applied: true, masked: 2 },
  evidenceVersion: 2,
  capture: { mode: "autonomous", steps },
});

before(async (t) => {
  if (!existsSync(PLAYWRIGHT)) return t.skip("Playwright is not installed (tools/screenshot-capture: npm install).");
  const { chromium } = await import(pathToFileURL(PLAYWRIGHT).href);
  try {
    ctx.browser = await chromium.launch({ headless: true });
  } catch (err) {
    return t.skip(`No headless Chromium is available: ${err.message.split("\n")[0]}`);
  }
  cleanups.push(() => ctx.browser?.close());

  ctx.storageRoot = join(tmp("wrong-browser-"), "storage");
  ctx.generatedRoot = join(ctx.storageRoot, "generated-labs");
  ctx.library = join(ctx.storageRoot, "screenshots");
  const build = await generateLab(
    { products: ["power-platform-ai-hub"], features: ["ppai-explore-ai-hub-models"], includeCore: false },
    { outputRoot: ctx.generatedRoot, labsDir: tmp("wrong-browser-empty-labs-"), useLearnMcp: false, useLlm: false },
  );
  ctx.labId = build.labId;
  ctx.labDir = build.outputDir;

  // Two slots that describe deeper screens hold the product's start page, one lab holds a copy of it, and one slot holds a real screen.
  const home = homePage();
  const hub = hubPage();
  mkdirSync(ctx.library, { recursive: true });
  const shots = {};
  for (const [name, bytes] of [["ppai-ai-models-page.png", home], ["ppai-ai-hub-menu.png", home]]) {
    writeFileSync(join(ctx.library, name), bytes);
    shots[name] = record(bytes);
  }
  writeFileSync(join(ctx.library, "ppai-prompt-builder-editor.png"), hub);
  shots["ppai-prompt-builder-editor.png"] = record(hub, [
    { action: "open", label: "Open the page", ok: true, found: true, urlBefore: "make.powerapps.com/start", urlAfter: "make.powerapps.com/home" },
    { action: "open", label: "AI hub", ok: true, found: true, urlBefore: "", urlAfter: "" },
  ]);
  const recordsFile = join(ctx.storageRoot, "data", "capture", "library-verification.json");
  mkdirSync(dirname(recordsFile), { recursive: true });
  writeFileSync(recordsFile, JSON.stringify({ schema: 1, shots }));
  writeFileSync(join(ctx.labDir, "assets", "ppai-ai-models-page.png"), home);
  writeLabVerificationRecord(ctx.labDir, "ppai-ai-models-page.png", record(home));
  ctx.libraryFiles = () => readdirSync(ctx.library).filter((name) => name.endsWith(".png")).sort();
  ctx.before = ctx.libraryFiles();

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
      LOCALAPPDATA: tmp("wrong-browser-localappdata-"),
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

test("the portal checks at start without moving anything, then the notice, the panel, Keep this one, and Move to kept pictures work in the Screenshot Center, from the keyboard too", async (t) => {
  if (!ctx.browser) return t.skip("no browser");

  // The check at start counted the pictures that look wrong and moved none of them.
  const status = await (await fetch(`${ctx.base}/api/capture/status`)).json();
  assert.equal(status.sharedLibrary.suspect.definite, 2, JSON.stringify(status.sharedLibrary.suspect));
  assert.deepEqual(ctx.libraryFiles(), ctx.before, "the check at start only reads");

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
  await page.evaluate(async (labId) => {
    await lbLoadGenerated();
    await lbOpenGeneratedScreenshots(labId);
  }, ctx.labId);
  const center = page.locator("#lb-result-screenshots");
  await center.locator(".sc-card").first().waitFor({ timeout: 20000 });

  // One calm line at the top, with one way to review.
  const notice = center.locator("[data-sc-wrong-notice]");
  await notice.waitFor({ timeout: 20000 });
  assert.equal((await notice.locator("p").textContent()).trim(), "3 pictures look like the wrong screen. Review them.");
  await shoot("1-notice-at-the-top", center);
  await notice.getByRole("button", { name: "Review the pictures that look like the wrong screen" }).click();
  const panel = center.locator("[data-sc-wrong-host]");
  await panel.locator("[data-sc-wrong-picture]").first().waitFor();
  assert.equal(await panel.locator("details, [role=dialog], dialog").count(), 0, "no new modal");
  assert.equal((await panel.locator("h6").textContent()).trim(), "Pictures that look wrong");
  const rows = panel.locator("[data-sc-wrong-picture]");
  assert.equal(await rows.count(), 3);
  assert.match(await rows.first().textContent(), /Clearly the wrong screen\./);
  assert.match(await panel.textContent(), /This shows the product's start page, but its lab describes a screen inside the product/);
  await shoot("2-panel-pictures-that-look-wrong", panel);

  // Keep this one, from the keyboard: the lab's own picture is marked and no longer flagged.
  const labRow = panel.locator('[data-sc-wrong-picture^="lab:"]');
  await labRow.getByRole("button", { name: "Keep this one" }).focus();
  await page.keyboard.press("Enter");
  await panel.locator("[data-sc-wrong-message]", { hasText: "Kept. This picture is not flagged again." }).waitFor();
  assert.equal(await panel.locator("[data-sc-wrong-picture]").count(), 2);
  assert.equal((await center.locator("[data-sc-wrong-notice] p").textContent()).trim(), "2 pictures look like the wrong screen. Review them.");

  // Move one library picture to the kept pictures list: it leaves the library, its slot goes pending, and nothing else moves.
  const libraryRow = panel.locator('[data-sc-wrong-picture="library::ppai-ai-hub-menu.png"]');
  await libraryRow.getByRole("button", { name: "Move ppai-ai-hub-menu.png to kept pictures" }).focus();
  await page.keyboard.press("Enter");
  await panel.locator("[data-sc-wrong-message]", { hasText: "1 picture moved to the kept pictures list. Its screenshot is pending again." }).waitFor();
  assert.deepEqual(ctx.libraryFiles(), ["ppai-ai-models-page.png", "ppai-prompt-builder-editor.png"], "exactly that picture left the library");
  assert.equal(await panel.locator("[data-sc-wrong-picture]").count(), 1);
  await shoot("3-after-moving-one", panel);

  // It is in the kept pictures list, and restoring it puts it back.
  const kept = await (await fetch(`${ctx.base}/api/capture/kept`)).json();
  const entry = kept.entries.find((e) => e.reason === "looks-wrong");
  assert.ok(entry, "the moved picture is kept");
  assert.deepEqual(entry.pictures.map((p) => p.filename), ["ppai-ai-hub-menu.png"]);
  const restored = await fetch(`${ctx.base}/api/capture/kept/${encodeURIComponent(entry.id)}/ppai-ai-hub-menu.png/restore`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to: "library", confirm: true }) });
  assert.equal(restored.status, 200, await restored.text());
  assert.ok(ctx.libraryFiles().includes("ppai-ai-hub-menu.png"), "restore puts it back where it was");
  assert.deepEqual(problems, [], "no script errors");
  await context.close();
});
