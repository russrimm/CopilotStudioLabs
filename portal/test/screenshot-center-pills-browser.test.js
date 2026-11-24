/**
 * Pills in the Screenshot Center, in a real browser (headless Chromium, a throwaway profile, a throwaway port, synthetic data only):
 * a long reason, warning, or label wraps onto more lines and stays inside its card, instead of running off the right edge and being cut
 * off. A short pill such as "Queued" stays as compact as it was. Checked at 360, 430, 768, and 1440 wide, in the light and dark themes.
 *
 * The scenario is the one a person reported: a card for "Part 4 · Topics & trigger phrases" that is queued, with an amber
 * "This screen has not been seen in the product yet" pill that is wider than a narrow card. test/fixtures/pill-scenario.js builds it with
 * the Center's own code. The CSS checks at the end need no browser. The browser tests skip themselves when Playwright or a Chromium
 * build is not installed (tools/screenshot-capture: npm install).
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { generateLab } from "../lib/lab-builder/generator.js";
import { PILL_HOLDER_SELECTOR, PILL_REASONS, PILL_SELECTOR, measurePills, naturalPillWidth, showPillScenario, stretchPills } from "./fixtures/pill-scenario.js";

const here = dirname(fileURLToPath(import.meta.url));
const PORTAL_ROOT = resolve(here, "..");
const PLAYWRIGHT = resolve(PORTAL_ROOT, "..", "tools", "screenshot-capture", "node_modules", "playwright", "index.mjs");
const WIDTHS = [360, 430, 768, 1440];
const THEMES = ["light", "dark"];
const SLACK = 0.5;
const cleanups = [];
const ctx = {};

function tmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A free port from the range this work may use. The search starts at 3206 so it does not race the picture viewer's browser test
 * (screenshot-center-pictures-browser.test.js), which starts at 3201 and can run at the same time.
 */
async function freePort() {
  for (let offset = 0; offset < 9; offset += 1) {
    const port = 3201 + ((5 + offset) % 9);
    const free = await new Promise((resolveFree) => {
      const probe = createServer();
      probe.once("error", () => resolveFree(false));
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolveFree(true)));
    });
    if (free) return port;
  }
  throw new Error("no free port from 3201 to 3209");
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

  ctx.storageRoot = join(tmp("pills-browser-"), "storage");
  const build = await generateLab(
    { products: ["power-platform-ai-hub"], features: ["ppai-explore-ai-hub-models", "ppai-build-custom-prompt"], includeCore: false },
    { outputRoot: join(ctx.storageRoot, "generated-labs"), labsDir: tmp("pills-browser-empty-labs-"), useLearnMcp: false, useLlm: false },
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
      LOCALAPPDATA: tmp("pills-browser-localappdata-"),
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
        // The answer must come from this server, not one that already held the port.
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

/** The lab's Screenshot Center, with the reported cards showing, in a fresh page of the given width. */
async function openScenario(width) {
  const context = await ctx.browser.newContext({ viewport: { width, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.goto(`${ctx.base}/#labbuilder`);
  await page.evaluate(async (labId) => {
    await lbLoadGenerated();
    await lbOpenGeneratedScreenshots(labId);
  }, ctx.labId);
  await page.locator("#lb-result-screenshots .sc-card").first().waitFor({ timeout: 20000 });
  await page.evaluate(showPillScenario, { labId: ctx.labId, reasons: PILL_REASONS });
  return { context, page, errors };
}

const setTheme = (page, theme) => page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
const measure = (page) => page.evaluate(measurePills, { selector: PILL_SELECTOR, holderSelector: PILL_HOLDER_SELECTOR });

/** No pill is clipped (its text fits inside it) and none sticks out of the card, step, or header that holds it. */
function assertPillsFit(rows, where) {
  for (const row of rows) {
    const who = `${where}: "${row.text}" (${row.cls})`;
    assert.ok(row.scrollWidth <= row.clientWidth + 1, `${who} is clipped: its text is ${row.scrollWidth}px wide in ${row.clientWidth}px`);
    if (row.holderRight === null) continue;
    assert.ok(row.right <= row.holderRight + SLACK, `${who} runs off the right edge of ${row.holder}: ${row.right.toFixed(1)} is past ${row.holderRight.toFixed(1)}`);
    assert.ok(row.left >= row.holderLeft - SLACK, `${who} runs off the left edge of ${row.holder}`);
  }
}

test("the wide reason pills of a card wrap and stay inside it, at every width and in both themes", async (t) => {
  if (!ctx.browser) return t.skip("no browser");
  for (const width of WIDTHS) {
    const { context, page, errors } = await openScenario(width);
    for (const theme of THEMES) {
      await setTheme(page, theme);
      const rows = await measure(page);
      const where = `${width}px, ${theme}`;
      const reasons = rows.filter((row) => row.cls.includes("sc-reason-chip"));
      assert.ok(reasons.length >= PILL_REASONS.length, `${where}: all three reason pills are on screen`);
      assert.deepEqual(reasons.slice(0, PILL_REASONS.length).map((row) => row.text), PILL_REASONS.map((text) => text.slice(0, 40)));
      assert.ok(rows.some((row) => row.cls.includes("sc-status-chip")) && rows.some((row) => row.cls.includes("sc-fig")), `${where}: the status pills and the figure labels were checked`);
      assertPillsFit(rows, where);
      // A pill that needs more than one line keeps a rounded look that suits it: a fixed radius, not a 999px capsule.
      for (const row of rows.filter((r) => r.cls.includes("sc-chip"))) assert.ok(row.radius <= 16, `${where}: "${row.text}" has a radius of ${row.radius}px`);
    }
    assert.deepEqual(errors, [], `${width}px: the page had no script errors`);
    await context.close();
  }
});

test("every kind of pill takes a very long text without being cut off, whether it has spaces to wrap at or not", async (t) => {
  if (!ctx.browser) return t.skip("no browser");
  const spaced = "A very long pill that has to wrap onto as many lines as it needs and still stay inside the card that holds it, however narrow the screen is.";
  const unbroken = "Needs-a-practice-agent-in-another-environment-before-the-computer-can-capture-this-screen-and-save-it-for-review-0123456789";
  for (const width of WIDTHS) {
    const { context, page } = await openScenario(width);
    for (const [kind, text] of [["with spaces", spaced], ["with no spaces", unbroken]]) {
      const changed = await page.evaluate(stretchPills, { selector: PILL_SELECTOR, text });
      assert.ok(changed >= 20, `${width}px: ${changed} pills were stretched, so the Center's header, steps, causes, and cards were all covered`);
      for (const theme of THEMES) {
        await setTheme(page, theme);
        const rows = await measure(page);
        assert.ok(rows.length >= changed, "every stretched pill was measured");
        assertPillsFit(rows, `${width}px, ${theme}, ${kind}`);
      }
    }
    await context.close();
  }
});

test("a short pill such as Queued stays compact: one line, as wide as its words, and still a full pill", async (t) => {
  if (!ctx.browser) return t.skip("no browser");
  for (const width of WIDTHS) {
    const { context, page } = await openScenario(width);
    const status = page.locator("#lb-result-screenshots .sc-status-chip");
    const labels = await status.allTextContents();
    assert.ok(labels.includes("Queued") && labels.includes("Pending"), `${width}px: the card shows ${labels.join(", ")}`);
    for (let i = 0; i < labels.length; i += 1) {
      const chip = status.nth(i);
      const natural = await chip.evaluate(naturalPillWidth);
      const box = await chip.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return { width: rect.width, height: rect.height, radius: parseFloat(style.borderTopLeftRadius), lineHeight: parseFloat(style.lineHeight) };
      });
      assert.ok(Math.abs(box.width - natural) <= 1, `${width}px: "${labels[i]}" is ${box.width}px wide and its words need ${natural}px`);
      assert.ok(box.width < 120, `${width}px: "${labels[i]}" stays small: ${box.width}px`);
      assert.ok(box.height < box.lineHeight * 2, `${width}px: "${labels[i]}" is one line tall: ${box.height}px`);
      assert.ok(box.radius >= box.height / 2 - 0.5, `${width}px: "${labels[i]}" is still a full pill (radius ${box.radius}px, height ${box.height}px)`);
    }
    await context.close();
  }
});

test("the long pill keeps its colors in both themes", async (t) => {
  if (!ctx.browser) return t.skip("no browser");
  const { context, page } = await openScenario(1440);
  const colors = {};
  for (const theme of THEMES) {
    await setTheme(page, theme);
    colors[theme] = await page.locator("#lb-result-screenshots .sc-reason-chip").first().evaluate((el) => {
      const style = getComputedStyle(el);
      return { color: style.color, background: style.backgroundColor, border: style.borderTopColor, borderWidth: style.borderTopWidth };
    });
    assert.equal(colors[theme].borderWidth, "1px", "a full 1px border, no side stripe");
  }
  assert.notEqual(colors.light.background, colors.dark.background, "each theme has its own amber");
  await context.close();
});

// ── The CSS itself, without a browser ───────────────────────────────────────

const html = readFileSync(resolve(PORTAL_ROOT, "public", "index.html"), "utf8");
const screenCss = (html.match(/<style>([\s\S]*?)<\/style>/)?.[1] || "").split("@media print")[0];
const rule = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return screenCss.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`))?.[1] || "";
};

test("the pill rules wrap, stay inside their card, and use a radius that suits several lines", () => {
  for (const selector of [".sc-chip", ".sc-thumb-busy", ".sc-pic-hint", ".sc-copy-ack", ".lb-brand-chip", ".lb-gen-chips li"]) {
    const css = rule(selector);
    assert.ok(css, `${selector} has a rule`);
    assert.doesNotMatch(css, /white-space:\s*nowrap/, `${selector} may wrap`);
    assert.doesNotMatch(css, /border-radius:\s*999px/, `${selector} has no capsule radius`);
    assert.match(css, /max-width:\s*(100%|calc\(100% - 16px\))/, `${selector} never exceeds its holder`);
  }
  const chip = rule(".sc-chip");
  assert.match(chip, /white-space:\s*normal/);
  assert.match(chip, /overflow-wrap:\s*anywhere/);
  assert.match(chip, /min-width:\s*0/);
  assert.match(chip, /border:\s*1px solid transparent/, "one full 1px border");
  assert.match(screenCss, /\.sc-chip-warn\s*\{[^}]*var\(--sc-warn-bg\)[^}]*var\(--sc-warn-fg\)/, "the amber colors are still the theme's");
});
