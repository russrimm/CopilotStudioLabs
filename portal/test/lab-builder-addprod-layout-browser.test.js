/**
 * Step 1 of the Build a Lab wizard ends with "Add another Microsoft product from Microsoft Learn". Its two rows (Choose a
 * product, Or search Microsoft Learn) used to sit directly on top of each other: no space between them, the controls
 * started at different left edges, and the focus ring of the list touched the search box. This test opens the panel in
 * headless Chromium, in both themes from 1440 down to 360 wide, and checks that the rows are apart, the controls line up
 * (side by side when wide, under their labels when narrow), nothing sticks out of the panel, and no focus ring touches
 * another control or label.
 *
 * It runs against a real server with throwaway storage folders, Microsoft Learn and the language model off. It skips
 * itself when Playwright or a Chromium build is not installed (tools/screenshot-capture: npm install).
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
/** The panel shows its controls side by side above this width and stacks them under their labels at or below it. */
const SIDE_BY_SIDE_FROM = 768;
const WIDTHS = [1440, 1024, 768, 390, 360];
const MIN_ROW_GAP = 16;
const MIN_RING = 4;
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
  const root = mkdtempSync(join(tmpdir(), "lb-addprod-layout-"));
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
 * Runs in the page with the panel open and one control focused (or none). Returns the box of every part of the panel
 * and the size the focus ring of the focused control reaches beyond its box.
 */
function measurePanel() {
  const box = (el) => {
    const b = el.getBoundingClientRect();
    return { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
  };
  const byId = (id) => document.getElementById(id);
  const panel = byId("lb-addprod");
  const focused = document.activeElement;
  const outline = focused ? getComputedStyle(focused) : null;
  return {
    theme: document.documentElement.getAttribute("data-theme"),
    parts: {
      panel: box(panel),
      pickLabel: box(document.querySelector('label[for="lb-addprod-pick"]')),
      select: box(byId("lb-addprod-pick")),
      add: box(byId("lb-addprod-add")),
      searchLabel: box(document.querySelector('label[for="lb-addprod-input"]')),
      input: box(byId("lb-addprod-input")),
      go: box(byId("lb-addprod-go")),
    },
    scrollWidth: panel.scrollWidth,
    clientWidth: panel.clientWidth,
    pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    focusedId: focused?.id || "",
    ring: outline && outline.outlineStyle !== "none" ? parseFloat(outline.outlineWidth) + parseFloat(outline.outlineOffset) : 0,
  };
}

const grow = (b, by) => ({ left: b.left - by, top: b.top - by, right: b.right + by, bottom: b.bottom + by });
const intersects = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
const EDGE = 0.5;

async function openPanel(viewport, theme) {
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
  await page.click("#lb-addprod > summary");
  await page.waitForSelector("#lb-addprod-pick", { state: "visible" });
  return { context, page, errors };
}

/** Moves focus with the keyboard first, so the browser draws the focus ring the way it does for a person tabbing. */
async function focusByKeyboard(page, id) {
  await page.keyboard.press("Tab");
  await page.evaluate((target) => document.getElementById(target).focus(), id);
  return page.evaluate(measurePanel);
}

for (const theme of ["light", "dark"]) {
  test(`the two rows of Add another Microsoft product stay apart and line up from 1440 to 360 wide (${theme})`, async (t) => {
    if (ctx.skipReason) return t.skip(ctx.skipReason);
    const { context, page, errors } = await openPanel({ width: WIDTHS[0], height: 900 }, theme);
    try {
      for (const width of WIDTHS) {
        const where = `${theme}, ${width}px`;
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(() => document.getElementById("lb-addprod-pick").scrollIntoView({ block: "center" }));
        const idle = await page.evaluate(measurePanel);
        const { parts } = idle;
        assert.equal(idle.theme, theme, `${where}: the ${theme} theme is applied`);

        // (a) The rows are clearly apart, and no control sits on another.
        const controls = ["select", "add", "input", "go"];
        for (let i = 0; i < controls.length; i += 1) {
          for (let j = i + 1; j < controls.length; j += 1) {
            assert.ok(!intersects(parts[controls[i]], parts[controls[j]]), `${where}: ${controls[i]} and ${controls[j]} overlap`);
          }
        }
        const rowGap = parts.input.top - parts.select.bottom;
        assert.ok(rowGap >= MIN_ROW_GAP, `${where}: the list and the search box are ${rowGap.toFixed(1)}px apart; they need at least ${MIN_ROW_GAP}px`);
        assert.ok(parts.searchLabel.top - Math.max(parts.select.bottom, parts.add.bottom) >= MIN_ROW_GAP, `${where}: the second row starts at least ${MIN_ROW_GAP}px below the first`);

        // (b) Side by side with the controls on one left edge when wide; each control under its own label when narrow.
        if (width >= SIDE_BY_SIDE_FROM) {
          assert.ok(Math.abs(parts.select.left - parts.input.left) <= EDGE, `${where}: the list starts at ${parts.select.left.toFixed(1)}px and the search box at ${parts.input.left.toFixed(1)}px`);
          assert.ok(Math.abs(parts.add.left - parts.go.left) <= EDGE, `${where}: the two buttons start on different edges`);
          assert.ok(Math.abs(parts.add.right - parts.go.right) <= EDGE, `${where}: the two buttons end on different edges`);
          assert.ok(Math.abs(parts.select.right - parts.input.right) <= EDGE, `${where}: the list and the search box end on different edges`);
          assert.ok(parts.pickLabel.right <= parts.select.left && parts.searchLabel.right <= parts.input.left, `${where}: each label sits before its control`);
          assert.ok(Math.abs(parts.pickLabel.left - parts.searchLabel.left) <= EDGE, `${where}: the two labels start on one edge`);
        } else {
          assert.ok(parts.select.top >= parts.pickLabel.bottom, `${where}: the list is below its label`);
          assert.ok(parts.input.top >= parts.searchLabel.bottom, `${where}: the search box is below its label`);
          assert.ok(Math.abs(parts.select.left - parts.pickLabel.left) <= EDGE && Math.abs(parts.input.left - parts.searchLabel.left) <= EDGE, `${where}: each control starts under its label`);
          assert.ok(parts.add.top >= parts.select.bottom && parts.go.top >= parts.input.bottom, `${where}: each button is below its control`);
        }

        // (c) Everything is inside the panel and nothing makes the panel or the page scroll sideways.
        for (const name of ["pickLabel", "select", "add", "searchLabel", "input", "go"]) {
          const part = parts[name];
          assert.ok(part.left >= parts.panel.left - EDGE && part.right <= parts.panel.right + EDGE, `${where}: ${name} sticks out of the panel`);
        }
        assert.ok(idle.scrollWidth <= idle.clientWidth, `${where}: the panel scrolls sideways (${idle.scrollWidth} > ${idle.clientWidth})`);
        assert.ok(idle.pageOverflow <= 0, `${where}: the page is ${idle.pageOverflow}px wider than the window`);

        // (d) The focus ring of each control stays clear of everything else in the panel.
        for (const [id, name] of [["lb-addprod-pick", "select"], ["lb-addprod-add", "add"], ["lb-addprod-input", "input"], ["lb-addprod-go", "go"]]) {
          const focused = await focusByKeyboard(page, id);
          assert.equal(focused.focusedId, id);
          assert.ok(focused.ring > 0, `${where}: ${id} shows a focus ring`);
          const ring = grow(focused.parts[name], Math.max(MIN_RING, focused.ring));
          for (const other of ["pickLabel", "select", "add", "searchLabel", "input", "go"]) {
            if (other === name) continue;
            assert.ok(!intersects(ring, focused.parts[other]), `${where}: the focus ring of ${id} touches ${other}`);
          }
        }
      }
      assert.deepEqual(errors, [], "no script errors on the page");
    } finally {
      await context.close();
    }
  });
}
