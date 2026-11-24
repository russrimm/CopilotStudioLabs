/**
 * Pictures a person has to look at, in a real browser (headless Chromium, a throwaway profile, a throwaway port, synthetic pictures only):
 * the "Pictures that look wrong" thumbnails are big enough to judge, pressing one (mouse, Enter, or Space) shows the full-size picture in
 * the screenshot gallery's dialog, Fit to screen and Actual size work, the keyboard moves through the pictures and gives focus back,
 * Keep this one inside the viewer moves on to the next picture, and the Kept pictures list opens the same viewer.
 *
 * The pictures are 1280 by 800 blocks drawn by test/fixtures/block-pictures.js, so a thumbnail and the full-size picture are easy to tell
 * apart. Nothing real is used. The test skips itself when Playwright or a Chromium build is not installed (tools/screenshot-capture: npm install).
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { generateLab } from "../lib/lab-builder/generator.js";
import { sha256Hex } from "../lib/capture/library-share.js";
import { dialogPage, formPage, homePage, hubPage } from "./fixtures/block-pictures.js";

const here = dirname(fileURLToPath(import.meta.url));
const PORTAL_ROOT = resolve(here, "..");
const PLAYWRIGHT = resolve(PORTAL_ROOT, "..", "tools", "screenshot-capture", "node_modules", "playwright", "index.mjs");
const cleanups = [];
const ctx = {};
const NATURAL = { width: 1280, height: 800 };

function tmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The first free port from the range this work may use. */
async function freePort() {
  for (let port = 3201; port <= 3209; port += 1) {
    const free = await new Promise((resolveFree) => {
      const probe = createServer();
      probe.once("error", () => resolveFree(false));
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolveFree(true)));
    });
    if (free) return port;
  }
  throw new Error("no free port from 3201 to 3209");
}

const record = (bytes) => ({
  ok: true,
  level: "pass",
  reasons: [],
  sha256: sha256Hex(bytes),
  state: "accepted",
  finalUrl: "https://make.powerapps.com/environments/00000000-0000-0000-0000-000000000000/home",
  redaction: { applied: true, masked: 2 },
  evidenceVersion: 2,
  capture: { mode: "autonomous", steps: [{ action: "open", label: "Open the page", ok: true, found: true, urlBefore: "make.powerapps.com/start", urlAfter: "make.powerapps.com/home" }] },
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

  ctx.storageRoot = join(tmp("pictures-browser-"), "storage");
  const library = join(ctx.storageRoot, "screenshots");
  const build = await generateLab(
    { products: ["power-platform-ai-hub"], features: ["ppai-explore-ai-hub-models"], includeCore: false },
    { outputRoot: join(ctx.storageRoot, "generated-labs"), labsDir: tmp("pictures-browser-empty-labs-"), useLearnMcp: false, useLlm: false },
  );
  ctx.labId = build.labId;

  // Four slots that describe deeper screens hold a picture the computer took on the start page: each looks different, and each is flagged.
  // One of them is moved to the kept pictures list through the API, so there is something kept to look at.
  const big = { scale: 4 };
  ctx.pictures = {
    "ppai-ai-hub-menu.png": hubPage(big),
    "ppai-ai-models-page.png": homePage(big),
    "ppai-docproc-fields.png": formPage(big),
    "ppai-prompt-builder-editor.png": dialogPage(big),
  };
  mkdirSync(library, { recursive: true });
  const shots = {};
  for (const [name, bytes] of Object.entries(ctx.pictures)) {
    writeFileSync(join(library, name), bytes);
    shots[name] = record(bytes);
  }
  const recordsFile = join(ctx.storageRoot, "data", "capture", "library-verification.json");
  mkdirSync(dirname(recordsFile), { recursive: true });
  writeFileSync(recordsFile, JSON.stringify({ schema: 1, shots }));
  // A picture in the lab's own folder, only to read the headers its route sends.
  ctx.labAsset = "ppai-lab-only.png";
  writeFileSync(join(build.outputDir, "assets", ctx.labAsset), ctx.pictures["ppai-prompt-builder-editor.png"]);

  ctx.port = await freePort();
  ctx.base = `http://127.0.0.1:${ctx.port}`;
  ctx.serverOutput = "";
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
      CAPTURE_STARTUP_SCAN: "off",
      LOCALAPPDATA: tmp("pictures-browser-localappdata-"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => (ctx.serverOutput += chunk));
  cleanups.push(() => child.kill());
  const deadline = Date.now() + 40000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}): ${ctx.serverOutput.slice(-800)}`);
    try {
      if ((await fetch(`${ctx.base}/healthz`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("server did not start in time");
    await new Promise((r) => setTimeout(r, 150));
  }
  const moved = await fetch(`${ctx.base}/api/capture/suspect-pictures/quarantine`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dryRun: false, confirm: true, items: [{ scope: "library", filename: "ppai-prompt-builder-editor.png" }] }),
  });
  assert.equal(moved.status, 200);
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

/** Open the lab's Screenshot Center in a fresh page, with Advanced open. */
async function openCenter(viewport) {
  const context = await ctx.browser.newContext({ viewport });
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (err) => problems.push(err.message));
  page.on("console", (message) => message.type() === "error" && problems.push(message.text()));
  await page.goto(`${ctx.base}/#labbuilder`);
  await page.evaluate(async (labId) => {
    await lbLoadGenerated();
    await lbOpenGeneratedScreenshots(labId);
  }, ctx.labId);
  const center = page.locator("#lb-result-screenshots");
  await center.locator(".sc-card").first().waitFor({ timeout: 20000 });
  await center.locator("[data-sc-wrong-notice]").waitFor({ timeout: 20000 });
  await center.locator("[data-sc-wrong-notice]").getByRole("button").click();
  return { context, page, center, problems, panel: center.locator("[data-sc-wrong-host]") };
}

const imagesLoaded = (page, selector) => page.waitForFunction((sel) => [...document.querySelectorAll(sel)].length > 0 && [...document.querySelectorAll(sel)].every((img) => img.complete && img.naturalWidth > 0), selector, { timeout: 15000 });
const viewerImage = (page) => page.evaluate(() => {
  const img = document.querySelector("dialog[open].sc-lightbox .sc-pic-full");
  const box = img?.getBoundingClientRect();
  return img ? { natural: [img.naturalWidth, img.naturalHeight], width: Math.round(box.width), height: Math.round(box.height), src: img.getAttribute("src") } : null;
});
const focusedKey = (page) => page.evaluate(() => document.activeElement?.dataset?.picKey || document.activeElement?.dataset?.scFocus || document.activeElement?.tagName || "");

test("the pictures are big enough to judge, open full size from the mouse and the keyboard, and the viewer fits, shows actual size, moves, and gives focus back", async (t) => {
  if (!ctx.browser) return t.skip("no browser");
  const { context, page, panel, problems } = await openCenter({ width: 1440, height: 1000 });
  const thumbs = panel.locator("[data-sc-pic-open]");
  await thumbs.first().waitFor();
  assert.equal(await thumbs.count(), 3);
  assert.deepEqual(await panel.locator("[data-sc-wrong-picture] .sc-library-name").allTextContents(), ["The AI hub in the left pane", "The AI models page", "Defining the information to extract"]);
  await imagesLoaded(page, "[data-sc-wrong-host] .sc-pic-thumb img");

  // At 1440 wide each thumbnail is large enough to judge, in the picture's own shape (not cropped, not stretched).
  const sizes = await thumbs.evaluateAll((els) => els.map((el) => {
    const box = el.getBoundingClientRect();
    const img = el.querySelector("img").getBoundingClientRect();
    return { width: Math.round(box.width), height: Math.round(box.height), imgWidth: Math.round(img.width), cursor: getComputedStyle(el).cursor };
  }));
  for (const size of sizes) {
    assert.ok(size.width >= 240 && size.width <= 361, `a thumbnail is 240 to 360 CSS pixels wide: ${size.width}`);
    assert.ok(Math.abs(size.width / size.height - NATURAL.width / NATURAL.height) < 0.03, "it keeps the picture's shape");
    assert.ok(Math.abs(size.imgWidth - size.width) <= 2, "the picture fills it (inside its 1px border)");
    assert.equal(size.cursor, "pointer");
  }
  // No colored stripe on the side of a card: all four borders are the same width.
  const borders = await panel.locator("[data-sc-wrong-picture]").first().evaluate((el) => { const s = getComputedStyle(el); return [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth]; });
  assert.deepEqual(borders, ["1px", "1px", "1px", "1px"]);
  assert.match(await panel.locator("[data-sc-wrong-picture]").first().textContent(), /Clearly the wrong screen\./);

  // The hint is text and shows on hover and on keyboard focus.
  const hint = thumbs.first().locator(".sc-pic-hint");
  assert.equal(await hint.textContent(), "Click to enlarge");
  await thumbs.nth(1).hover();
  assert.equal(await thumbs.nth(1).locator(".sc-pic-hint").evaluate((el) => getComputedStyle(el).opacity), "1");

  // On a phone each thumbnail fills the row.
  await page.setViewportSize({ width: 390, height: 844 });
  const narrow = await thumbs.evaluateAll((els) => els.map((el) => {
    const row = el.closest("li");
    const style = getComputedStyle(row);
    return { thumb: Math.round(el.getBoundingClientRect().width), inner: Math.round(row.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)) };
  }));
  for (const { thumb, inner } of narrow) assert.ok(Math.abs(thumb - inner) <= 1, `at 390 wide the thumbnail fills the row: ${thumb} of ${inner}`);
  await page.setViewportSize({ width: 1440, height: 1000 });

  // Enter opens the first one; the full-size file loads (not the thumbnail's shape), as large as the screen allows.
  await thumbs.first().focus();
  await page.keyboard.press("Enter");
  const dialog = page.locator("dialog[open].sc-lightbox");
  await dialog.waitFor();
  assert.equal(await dialog.evaluate((el) => el.matches(":modal")), true, "a modal dialog keeps focus inside");
  await page.waitForFunction(() => { const img = document.querySelector("dialog[open] .sc-pic-full"); return img && img.complete && img.naturalWidth > 0; });
  assert.equal(await dialog.locator("#sc-lb-title").textContent(), "The AI hub in the left pane");
  assert.equal(await dialog.locator("[data-sc-pic-position]").textContent(), "Picture 1 of 3");
  const fit = await viewerImage(page);
  assert.deepEqual(fit.natural, [NATURAL.width, NATURAL.height], "the full natural-size file was loaded");
  assert.ok(fit.width > sizes[0].width * 2.5 && fit.width < NATURAL.width, `fit to screen is much larger than the thumbnail and still whole: ${fit.width}`);
  assert.ok(Math.abs(fit.width / fit.height - 1.6) < 0.03);
  assert.equal(await dialog.getByRole("button", { name: "Fit to screen" }).getAttribute("aria-pressed"), "true");
  assert.match(await dialog.textContent(), /This shows the product's start page, but its lab describes a screen inside the product/);
  assert.equal(await dialog.getByRole("button", { name: /^Keep this one/ }).count(), 1);
  assert.equal(await dialog.getByRole("button", { name: /^Move .* to kept pictures$/ }).count(), 1);
  assert.equal(await dialog.getByRole("link", { name: "Open in a new tab" }).count(), 1);

  // Actual size shows every pixel, with the picture scrolling inside its frame; Fit to screen goes back.
  await dialog.getByRole("button", { name: "Actual size" }).click();
  const actual = await viewerImage(page);
  assert.deepEqual([actual.width, actual.height], [NATURAL.width, NATURAL.height]);
  assert.equal(await dialog.locator("[data-sc-pic-scroll]").evaluate((el) => el.scrollHeight > el.clientHeight), true, "it scrolls");
  assert.equal(await dialog.getByRole("button", { name: "Actual size" }).getAttribute("aria-pressed"), "true");
  await dialog.getByRole("button", { name: "Fit to screen" }).click();
  assert.equal((await viewerImage(page)).width, fit.width);

  // Focus stays inside the dialog while Tab is pressed through it.
  for (let i = 0; i < 14; i += 1) {
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest("dialog")) || document.activeElement === document.body), true, "focus never leaves the dialog");
  }

  // The arrow keys move through the pictures in list order; Previous is off at the first one, Next at the last.
  assert.equal(await dialog.locator('[data-sc-action="lightbox-prev"]').isDisabled(), true);
  await dialog.locator('[data-sc-action="lightbox-close"]').focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(await dialog.locator("#sc-lb-title").textContent(), "The AI models page");
  await page.waitForFunction(() => document.querySelector("dialog[open] .sc-pic-full")?.naturalWidth > 0);
  assert.equal((await viewerImage(page)).src, "/api/capture/library/screenshots/ppai-ai-models-page.png/image");
  assert.equal(await page.locator("dialog[open] [data-sc-pic-live]").textContent().then((s) => s.replace(/\u00a0/g, "").trim()), "Picture 2 of 3: The AI models page");
  await page.keyboard.press("ArrowRight");
  assert.equal(await dialog.locator("[data-sc-pic-position]").textContent(), "Picture 3 of 3");
  assert.equal(await dialog.locator('[data-sc-action="lightbox-next"]').isDisabled(), true);
  await page.keyboard.press("ArrowRight");
  assert.equal(await dialog.locator("[data-sc-pic-position]").textContent(), "Picture 3 of 3", "it does not wrap");
  await page.keyboard.press("Home");
  assert.equal(await dialog.locator("[data-sc-pic-position]").textContent(), "Picture 1 of 3");
  await page.keyboard.press("ArrowRight");

  // Open in a new tab uses the same file, with no public caching.
  const [popup] = await Promise.all([context.waitForEvent("page"), dialog.getByRole("link", { name: "Open in a new tab" }).click()]);
  await popup.waitForLoadState("load");
  assert.deepEqual(await popup.evaluate(() => ({ type: document.contentType, size: [document.images[0]?.naturalWidth, document.images[0]?.naturalHeight] })), { type: "image/png", size: [NATURAL.width, NATURAL.height] });
  await popup.close();

  // Escape closes it and focus goes back to the thumbnail of the picture that was showing (the second one).
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" }).catch(() => {});
  assert.equal(await page.locator("dialog[open].sc-lightbox").count(), 0);
  assert.equal(await focusedKey(page), "library::ppai-ai-models-page.png");

  // Space opens the third one; the Close button returns to it.
  await thumbs.nth(2).focus();
  await page.keyboard.press("Space");
  await page.locator("dialog[open].sc-lightbox").waitFor();
  assert.equal(await page.locator("dialog[open] #sc-lb-title").textContent(), "Defining the information to extract");
  await page.getByRole("button", { name: "Close the preview" }).click();
  assert.equal(await page.locator("dialog[open].sc-lightbox").count(), 0);
  assert.equal(await focusedKey(page), "library::ppai-docproc-fields.png");

  // A click opens it too.
  await thumbs.nth(1).click();
  await page.locator("dialog[open].sc-lightbox").waitFor();
  assert.equal(await page.locator("dialog[open] #sc-lb-title").textContent(), "The AI models page");
  await page.keyboard.press("Escape");
  assert.deepEqual(problems, [], "no script errors");
  await context.close();
});

test("Keep this one inside the viewer removes the picture from the list and moves on to the next one, and the Kept pictures list opens the same viewer", async (t) => {
  if (!ctx.browser) return t.skip("no browser");
  const { context, page, center, panel, problems } = await openCenter({ width: 1440, height: 1000 });
  const thumbs = panel.locator("[data-sc-pic-open]");
  await thumbs.first().waitFor();
  await thumbs.first().click();
  const dialog = page.locator("dialog[open].sc-lightbox");
  await dialog.waitFor();
  await page.waitForFunction(() => document.querySelector("dialog[open] .sc-pic-full")?.naturalWidth > 0);
  await dialog.getByRole("button", { name: /^Keep this one/ }).focus();
  await page.keyboard.press("Enter");
  await dialog.locator("[data-sc-pic-notice]", { hasText: "Kept. This picture is not flagged again." }).waitFor();
  assert.equal(await dialog.locator("#sc-lb-title").textContent(), "The AI models page", "it moved on");
  assert.equal(await dialog.locator("[data-sc-pic-position]").textContent(), "Picture 1 of 2");
  assert.equal(await dialog.evaluate((el) => el.matches(":modal")), true, "still a modal dialog after the panel was drawn again");
  assert.equal(await focusedKey(page), "lb-keep", "focus stays on the button for the next picture");
  await page.waitForFunction(() => document.querySelector("dialog[open] .sc-pic-full")?.naturalWidth > 0);
  assert.equal((await viewerImage(page)).natural.join("x"), "1280x800");
  await panel.locator("[data-sc-wrong-picture]").nth(2).waitFor({ state: "detached" });
  await page.keyboard.press("Escape");
  assert.equal(await panel.locator("[data-sc-wrong-picture]").count(), 2, "it left the list");
  assert.equal(await panel.locator('[data-sc-wrong-picture="library::ppai-ai-hub-menu.png"]').count(), 0);
  assert.equal(await focusedKey(page), "library::ppai-ai-models-page.png", "focus returns to the thumbnail of the picture that was showing");

  // The Kept pictures list: the picture moved earlier is there, and its viewer offers Restore, Download, and Delete forever (which asks first).
  const keptHost = center.locator("[data-sc-kept-host]");
  await keptHost.getByRole("button", { name: /kept pictures/i }).first().click();
  const keptThumb = keptHost.locator("[data-sc-pic-open]");
  await keptThumb.waitFor();
  assert.equal(await keptThumb.count(), 1);
  await imagesLoaded(page, "[data-sc-kept-host] .sc-pic-thumb img");
  assert.ok((await keptThumb.evaluate((el) => el.getBoundingClientRect().width)) >= 240);
  await keptThumb.focus();
  await page.keyboard.press("Enter");
  await dialog.waitFor();
  await page.waitForFunction(() => document.querySelector("dialog[open] .sc-pic-full")?.naturalWidth > 0);
  assert.equal(await dialog.locator("#sc-lb-title").textContent(), "ppai-prompt-builder-editor.png");
  assert.deepEqual((await viewerImage(page)).natural, [NATURAL.width, NATURAL.height]);
  assert.equal(await dialog.getByRole("button", { name: /^Restore to the shared library/ }).count(), 1);
  assert.equal(await dialog.getByRole("link", { name: /^Download/ }).count(), 1);
  const keptUrl = (await viewerImage(page)).src;
  const keptRes = await fetch(`${ctx.base}${keptUrl}`);
  assert.equal(keptRes.status, 200);
  assert.match(keptRes.headers.get("cache-control"), /no-store|private/, "a kept picture is never cached by a shared cache");
  await dialog.getByRole("button", { name: /^Delete .* forever$/ }).focus();
  await page.keyboard.press("Enter");
  await dialog.locator('[data-sc-ask="keep-delete"]').waitFor();
  assert.equal((await fetch(`${ctx.base}${keptUrl}`)).status, 200, "nothing was deleted before the answer");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  assert.equal(await dialog.locator("[data-sc-ask]").count(), 0);
  assert.equal(await focusedKey(page), "lb-delete", "Cancel returns to the button that asked");
  await dialog.getByRole("button", { name: /^Delete .* forever$/ }).click();
  await dialog.getByRole("button", { name: "Yes, delete it forever" }).click();
  await page.locator("dialog[open].sc-lightbox").waitFor({ state: "detached" }).catch(() => {});
  assert.equal(await page.locator("dialog[open].sc-lightbox").count(), 0, "the viewer closes when nothing is left");
  await keptHost.locator("[data-sc-kept-none]").waitFor();
  assert.equal(readdirSync(join(ctx.storageRoot, "screenshots", ".kept")).length, 0);
  assert.deepEqual(problems, [], "no script errors");
  await context.close();
});

test("the picture routes are never cached by a shared cache, and the portal never writes a picture's name to its log", async (t) => {
  if (!ctx.browser) return t.skip("no browser");
  const cacheOf = async (path) => {
    const res = await fetch(`${ctx.base}${path}`);
    assert.equal(res.status, 200, path);
    return res.headers.get("cache-control");
  };
  assert.match(await cacheOf("/api/capture/library/screenshots/ppai-ai-models-page.png/image"), /no-store|private/);
  assert.match(await cacheOf(`/api/lab-builder/generated/${ctx.labId}/assets/${ctx.labAsset}`), /private|no-store/);
  for (const name of Object.keys(ctx.pictures)) assert.ok(!ctx.serverOutput.includes(name), "a picture's name is not logged");
});
