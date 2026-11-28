/**
 * The "Hide the browser window while capturing" option in the Screenshot Center, in a real browser (headless Chromium, a throwaway
 * profile and data folder, a throwaway port, synthetic data only; the computer's status is stubbed, nothing is captured): the
 * explanation under the checkbox is fully visible (no clipped or overflowing text), readable (4.5:1) and tied to the checkbox
 * at 1440, 768, and 360 wide, in the light and dark themes. The checkbox is reachable and shows focus with the keyboard, and
 * ticking it updates the "Next capture" line. The browser tests skip themselves when Playwright or a Chromium build is not installed
 * (tools/screenshot-capture: npm install).
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { generateLab } from "../lib/lab-builder/generator.js";

const here = dirname(fileURLToPath(import.meta.url));
const PORTAL_ROOT = resolve(here, "..");
const PLAYWRIGHT = resolve(PORTAL_ROOT, "..", "tools", "screenshot-capture", "node_modules", "playwright", "index.mjs");
const WIDTHS = [1440, 768, 360];
const THEMES = ["light", "dark"];
const PRODUCT = "power-platform-ai-hub";
const cleanups = [];
const ctx = {};

function tmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A free port from 3221 to 3229, away from the other browser tests (3201 to 3209) and never the owner's portal. */
async function freePort() {
  for (let port = 3221; port <= 3229; port += 1) {
    const free = await new Promise((resolveFree) => {
      const probe = createServer();
      probe.once("error", () => resolveFree(false));
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolveFree(true)));
    });
    if (free) return port;
  }
  throw new Error("no free port from 3221 to 3229");
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

  ctx.storageRoot = join(tmp("background-browser-"), "storage");
  const build = await generateLab(
    { products: [PRODUCT], features: ["ppai-explore-ai-hub-models", "ppai-build-custom-prompt"], includeCore: false },
    { outputRoot: join(ctx.storageRoot, "generated-labs"), labsDir: tmp("background-browser-empty-labs-"), useLearnMcp: false, useLlm: false },
  );
  ctx.labId = build.labId;

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
      LOCALAPPDATA: tmp("background-browser-localappdata-"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => (ctx.serverOutput += chunk));
  cleanups.push(() => child.kill());
  const deadline = Date.now() + 40000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}): ${ctx.serverOutput.slice(-800)}`);
    try {
      if ((await fetch(`${ctx.base}/healthz`)).ok) {
        await new Promise((r) => setTimeout(r, 200));
        if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}): ${ctx.serverOutput.slice(-800)}`);
        break;
      }
    } catch (err) {
      if (/server exited early/.test(err.message)) throw err;
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

/** The status the portal would report for a connected computer that is (or is not) signed in to the lab's product. */
const statusBody = (signedIn) => ({
  companion: {
    connected: true,
    lastSeenAt: new Date().toISOString(),
    connectedCount: 1,
    deviceCount: 1,
    busy: false,
    signedInProducts: signedIn,
    devices: [{ id: "dev_0123456789ab", name: "Ada PC", platform: "win32", connected: true, busy: false, lastSeenAt: new Date().toISOString(), signedInProducts: signedIn }],
    downloadUrl: "/api/capture/companion.zip",
    onlineWindowSec: 90,
  },
  serverBrowser: { available: false },
  tenantUrls: { set: false, names: [] },
  sharedLibrary: { location: "persistent", persistent: true, total: 0, captured: 0, missing: 0, needsReview: 0 },
  jobs: { queued: 0, active: 0 },
  pairing: { codeTtlSec: 600 },
  limits: { maxUploadBytes: 8 * 1024 * 1024, acceptedTypes: ["image/png", "image/jpeg", "image/webp"] },
});

/** The lab's Screenshot Center in a fresh page of the given width, with a connected computer. */
async function openCenter(width, { signedIn = [] } = {}) {
  const context = await ctx.browser.newContext({ viewport: { width, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.route("**/api/capture/status", (route) => route.fulfill({ json: statusBody(signedIn) }));
  await page.goto(`${ctx.base}/#labbuilder`);
  await page.evaluate(async (labId) => {
    await lbLoadGenerated();
    await lbOpenGeneratedScreenshots(labId);
  }, ctx.labId);
  await page.locator("#sc-run-background").waitFor({ timeout: 20000 });
  await page.evaluate(async (labId) => {
    await scLoadStatus(true);
    scRerender(labId);
  }, ctx.labId);
  await page.locator("#sc-run-background-now").waitFor();
  return { context, page, errors };
}

const setTheme = (page, theme) => page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);

/** For each piece of the option's text: is it clipped, does it leave the Center or the screen, and how readable is it. */
function measureOption() {
  const parse = (value) => {
    const m = /rgba?\(([^)]+)\)/.exec(value);
    if (!m) return null;
    const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return { r, g, b, a };
  };
  const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
  const luminance = ({ r, g, b }) => {
    const channel = (v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const backgroundOf = (el) => {
    const layers = [];
    for (let node = el; node; node = node.parentElement) {
      const bg = parse(getComputedStyle(node).backgroundColor);
      if (bg && bg.a > 0) layers.push(bg);
      if (bg && bg.a >= 1) break;
    }
    return layers.reduceRight((under, layer) => over(layer, under), { r: 255, g: 255, b: 255, a: 1 });
  };
  const center = document.querySelector("[data-sc-root]").getBoundingClientRect();
  const targets = [
    ["label", document.querySelector('label[for="sc-run-background"]')],
    ...[...document.querySelectorAll("#sc-run-background-help p")].map((el, i) => [`help ${i + 1}`, el]),
    ...[...document.querySelectorAll("#sc-run-background-help strong")].map((el, i) => [`help lead ${i + 1}`, el]),
    ["now", document.querySelector("#sc-run-background-now")],
  ];
  return targets.map(([name, el]) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const bg = backgroundOf(el);
    const fg = over(parse(style.color) || { r: 0, g: 0, b: 0, a: 1 }, bg);
    const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
    return {
      name,
      text: el.textContent.slice(0, 40),
      width: rect.width,
      height: rect.height,
      left: rect.left,
      right: rect.right,
      centerLeft: center.left,
      centerRight: center.right,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      overflow: `${style.overflowX}/${style.overflowY}`,
      ratio: (hi + 0.05) / (lo + 0.05),
      viewport: window.innerWidth,
      pageScroll: document.documentElement.scrollWidth,
    };
  });
}

test("the explanation under the checkbox is fully visible and readable, at 1440, 768, and 360 wide, in the light and dark themes", async (t) => {
  if (!ctx.browser) return t.skip("no browser");
  for (const width of WIDTHS) {
    const { context, page, errors } = await openCenter(width, { signedIn: [PRODUCT] });
    for (const theme of THEMES) {
      await setTheme(page, theme);
      const rows = await page.evaluate(measureOption);
      const where = `${width}px, ${theme}`;
      assert.deepEqual(rows.map((r) => r.name), ["label", "help 1", "help 2", "help 3", "help lead 1", "help lead 2", "now"], `${where}: all the pieces are on screen`);
      for (const row of rows) {
        const who = `${where}: ${row.name} ("${row.text}")`;
        assert.ok(row.height > 0 && row.width > 0, `${who} takes up room`);
        assert.ok(row.scrollWidth <= row.clientWidth + 1, `${who} is clipped sideways: ${row.scrollWidth}px of text in ${row.clientWidth}px`);
        assert.ok(row.scrollHeight <= row.clientHeight + 1, `${who} is clipped at the bottom: ${row.scrollHeight}px of text in ${row.clientHeight}px`);
        assert.doesNotMatch(row.overflow, /hidden|clip|scroll|auto/, `${who} does not hide or scroll its text`);
        assert.ok(row.left >= row.centerLeft - 0.5 && row.right <= row.centerRight + 0.5, `${who} leaves the Screenshot Center: ${row.left.toFixed(1)} to ${row.right.toFixed(1)} in ${row.centerLeft.toFixed(1)} to ${row.centerRight.toFixed(1)}`);
        assert.ok(row.right <= row.viewport + 0.5, `${who} runs off the screen`);
        assert.ok(row.ratio >= 4.5, `${who} has a contrast of ${row.ratio.toFixed(2)}:1 and needs 4.5:1`);
      }
      assert.ok(rows[0].pageScroll <= rows[0].viewport + 1, `${where}: the page does not scroll sideways (${rows[0].pageScroll}px in ${rows[0].viewport}px)`);
    }
    assert.deepEqual(errors, [], `${width}px: the page had no script errors`);
    await context.close();
  }
});

test("the checkbox has a real label, points at the explanation, shows focus, and works from the keyboard", async (t) => {
  if (!ctx.browser) return t.skip("no browser");
  const { context, page } = await openCenter(768, { signedIn: [] });
  const facts = await page.evaluate(() => {
    const box = document.querySelector("#sc-run-background");
    const ids = box.getAttribute("aria-describedby").split(" ");
    return {
      label: box.labels?.[0]?.textContent,
      ids,
      described: ids.map((id) => document.getElementById(id)?.textContent || ""),
      checked: box.checked,
    };
  });
  assert.equal(facts.label, "Hide the browser window while capturing");
  assert.deepEqual(facts.ids, ["sc-run-background-help", "sc-run-background-now"]);
  assert.match(facts.described.join(" "), /Checked: works in the background when you are already signed in\./);
  assert.match(facts.described.join(" "), /Not checked: a browser window opens and stays open while it captures\./);
  assert.match(facts.described.join(" "), /Next capture: a browser window opens on your computer\.$/);
  assert.equal(facts.checked, false);

  for (const theme of THEMES) {
    await setTheme(page, theme);
    await page.focus("#sc-run-background");
    const focus = await page.evaluate(() => {
      const box = document.querySelector("#sc-run-background");
      const style = getComputedStyle(box);
      return { visible: box.matches(":focus-visible"), outlineStyle: style.outlineStyle, outlineWidth: parseFloat(style.outlineWidth), shadow: style.boxShadow };
    });
    assert.equal(focus.visible, true, `${theme}: the checkbox takes focus`);
    assert.ok((focus.outlineStyle !== "none" && focus.outlineWidth > 0) || focus.shadow !== "none", `${theme}: focus is visible (${JSON.stringify(focus)})`);
  }

  await page.keyboard.press("Space");
  await page.waitForFunction(() => document.querySelector("#sc-run-background")?.checked === true);
  const after = await page.evaluate(() => ({
    now: document.querySelector("#sc-run-background-now").textContent,
    focused: document.activeElement?.id,
    checked: document.querySelector("#sc-run-background").checked,
  }));
  assert.equal(after.checked, true);
  assert.equal(after.focused, "sc-run-background", "the keyboard stays on the checkbox after the line updates");
  assert.match(after.now, /^Next capture: a browser window opens so you can sign in to .+\. After that, captures can run in the background\.$/, "not signed in yet: a window opens first");
  await context.close();

  const signedIn = await openCenter(360, { signedIn: [PRODUCT] });
  await signedIn.page.click('label[for="sc-run-background"]');
  await signedIn.page.waitForFunction(() => document.querySelector("#sc-run-background")?.checked === true);
  assert.match(await signedIn.page.textContent("#sc-run-background-now"), /^Next capture: no browser window\. Your computer has a saved sign-in for .+\.$/);
  await signedIn.context.close();
});
