/**
 * A product added from Microsoft Learn explains itself and can be removed on its own card in Step 1 (Product).
 *
 * Runs against a real server in headless Chromium with throwaway storage: a fake saved-products file (never the real one),
 * Microsoft Learn and the language model off. Three saved products: one that points to the Microsoft Q&A forum (flagged as not
 * documentation), one real hub, and one with a generic landing page title. It checks, in both themes at 1440, 768, and 360 wide,
 * that the card text is fully visible, no box or side stripe was added inside the card, the text keeps its contrast, Remove is
 * reached with the keyboard and shows a focus ring, and the inline question fits and answers Escape; then that removing really
 * deletes the saved product, unselects it, updates Your lab so far, and that Undo is offered only where the address can be added
 * again. It skips itself when Playwright or a Chromium build is not installed (tools/screenshot-capture: npm install).
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildUserProduct, writeUserProducts } from "../lib/lab-builder/user-products.js";

const here = dirname(fileURLToPath(import.meta.url));
const PORTAL_ROOT = resolve(here, "..");
const PLAYWRIGHT = resolve(PORTAL_ROOT, "..", "tools", "screenshot-capture", "node_modules", "playwright", "index.mjs");
const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 768, height: 900 },
  { width: 360, height: 740 },
];
const NOON = Date.parse("2026-03-15T12:00:00Z");
const QA = buildUserProduct({ name: "What do you need help with today?", root: "https://learn.microsoft.com/answers", now: NOON });
const HUB = buildUserProduct({ name: "Power BI", root: "https://learn.microsoft.com/power-bi", now: NOON });
const GENERIC = buildUserProduct({ name: "Welcome", root: "https://learn.microsoft.com/fabric", now: NOON });
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

/** A portal on a free port with a throwaway data folder and these saved products. Returns its address and the file it reads and writes. */
async function startServer(saved) {
  const root = mkdtempSync(join(tmpdir(), "lb-added-card-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const productsFile = join(root, "user-products.json");
  writeUserProducts(productsFile, saved);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let stderr = "";
  const child = spawn(process.execPath, ["server.js"], {
    cwd: PORTAL_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      PORTAL_AUTH_DISABLED: "true",
      AZURE_KEYVAULT_URL: "",
      AZURE_STORAGE_BLOB_ENDPOINT: "",
      PORTAL_DATA_DIR: join(root, "data"),
      LAB_BUILDER_USER_PRODUCTS: productsFile,
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
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server did not start: ${stderr.slice(-800)}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  return { base, productsFile, stop: () => child.kill() };
}

before(async () => {
  ctx.shared = await startServer([QA, HUB, GENERIC]);
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

async function openWizard(base, viewport, theme) {
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
  await page.goto(`${base}/#labbuilder`);
  await page.waitForSelector("#lb-product-options input");
  await page.waitForFunction(() => document.querySelectorAll("#lb-steps li:not([hidden])").length === 4);
  return { context, page, errors };
}

const cardOf = (id) => `#lb-product-options label:has(input[value="${id}"])`;

/** Runs in the page: what one card says, and every way its text could be cut off, hidden, boxed, striped, or hard to read. */
function measureCard(id) {
  const card = document.querySelector(`#lb-product-options label:has(input[value="${id}"])`);
  const box = card.getBoundingClientRect();
  const problems = [];
  const skip = (el) => el.classList.contains("sr-only");
  const luminance = ([r, g, b]) => {
    const [lr, lg, lb] = [r, g, b].map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
  };
  const rgb = (value) => {
    const m = /rgba?\(([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)/.exec(value);
    if (!m) throw new Error(`unreadable color ${value}`);
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const cardBackground = rgb(getComputedStyle(card).backgroundColor);
  const lowest = { ratio: 99, where: "" };
  for (const el of [card, ...card.querySelectorAll("*")]) {
    if (skip(el)) continue;
    const style = getComputedStyle(el);
    const name = `${el.tagName.toLowerCase()}${el.className ? `.${String(el.className).trim().split(/\s+/).join(".")}` : ""}`;
    if (style.textOverflow === "ellipsis") problems.push(`${name} has text-overflow: ellipsis`);
    if (style.webkitLineClamp && style.webkitLineClamp !== "none") problems.push(`${name} has a line clamp`);
    if (style.whiteSpace === "nowrap" && el.tagName !== "BUTTON") problems.push(`${name} does not wrap`);
    if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1) problems.push(`${name} scrolls sideways (${el.scrollWidth} > ${el.clientWidth})`);
    if (["overflowX", "overflowY"].some((axis) => style[axis] !== "visible") && el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 1) problems.push(`${name} clips its content`);
    // No box and no side stripe may be added inside the card; the footer's one hairline above the numbers is the card's own.
    if (el !== card && !el.classList.contains("lb-card-footer") && !el.classList.contains("btn") && el.tagName !== "INPUT" && !el.classList.contains("lb-badge")) {
      const edges = ["Top", "Right", "Bottom", "Left"].map((side) => parseFloat(style[`border${side}Width`]) * (style[`border${side}Style`] === "none" ? 0 : 1));
      if (edges.some((width) => width > 0)) problems.push(`${name} has a border`);
      if (style.boxShadow !== "none") problems.push(`${name} has a shadow`);
      if (style.backgroundColor !== "rgba(0, 0, 0, 0)") problems.push(`${name} has a fill`);
    }
  }
  const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent.trim() || skip(node.parentElement)) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) {
      if (rect.left < box.left - 1 || rect.right > box.right + 1) problems.push(`"${node.textContent.slice(0, 30)}" sticks out of the card (${rect.left.toFixed(0)}-${rect.right.toFixed(0)} vs ${box.left.toFixed(0)}-${box.right.toFixed(0)})`);
      if (rect.right > innerWidth + 1 || rect.left < -1) problems.push(`"${node.textContent.slice(0, 30)}" is off the page`);
    }
    const parent = node.parentElement;
    if (parent.closest(".lb-card-notes, .lb-card-confirm")) {
      const ratio = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
      const value = ratio(rgb(getComputedStyle(parent).color), cardBackground);
      if (value < lowest.ratio) Object.assign(lowest, { ratio: value, where: node.textContent.trim().slice(0, 30) });
    }
  }
  for (const button of card.querySelectorAll("button")) {
    const rect = button.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || rect.left < 0 || rect.right > innerWidth + 1) problems.push(`button "${button.textContent}" is not fully on screen`);
  }
  return {
    theme: document.documentElement.getAttribute("data-theme"),
    text: card.innerText,
    problems,
    lowestContrast: lowest,
    cardOverflow: card.scrollWidth - card.clientWidth,
    pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    confirm: (() => {
      const group = card.querySelector(".lb-card-confirm");
      if (!group) return null;
      const rect = group.getBoundingClientRect();
      return { insideCard: rect.left >= box.left - 1 && rect.right <= box.right + 1, onScreenX: rect.left >= 0 && rect.right <= innerWidth + 1, text: group.innerText };
    })(),
  };
}

/** Runs in the page: the element holding the keyboard focus, and how its focus is drawn. */
function focusInfo() {
  const el = document.activeElement;
  const style = getComputedStyle(el);
  return {
    remove: el.getAttribute("data-prod-remove"),
    confirm: el.getAttribute("data-prod-confirm"),
    keep: el.getAttribute("data-prod-keep"),
    undo: el.hasAttribute("data-prod-undo"),
    id: el.id,
    label: el.getAttribute("aria-label") || el.textContent.trim(),
    outlineStyle: style.outlineStyle,
    outlineWidth: parseFloat(style.outlineWidth),
  };
}

async function tabTo(page, wanted, limit = 25) {
  for (let presses = 0; presses < limit; presses += 1) {
    await page.keyboard.press("Tab");
    const info = await page.evaluate(focusInfo);
    if (wanted(info)) return info;
  }
  throw new Error("the keyboard never reached it");
}

for (const theme of ["light", "dark"]) {
  for (const viewport of VIEWPORTS) {
    test(`an Added by you card reads in full, adds no box, and Remove works from the keyboard at ${viewport.width}px (${theme})`, async (t) => {
      if (ctx.skipReason) return t.skip(ctx.skipReason);
      const { context, page, errors } = await openWizard(ctx.shared.base, viewport, theme);
      try {
        for (const [product, expected] of [
          [QA, [/This points to Microsoft Q&A threads, which are not product documentation, so labs built from it will not be useful\. We suggest removing it\./, /learn\.microsoft\.com\/answers/]],
          [HUB, [/You added this from Microsoft Learn\. Its topics are read from the address below\./, /learn\.microsoft\.com\/power-bi/]],
          [GENERIC, [/Also known as Microsoft Fabric/, /learn\.microsoft\.com\/fabric/]],
        ]) {
          const view = await page.evaluate(measureCard, product.id);
          assert.equal(view.theme, theme, "the theme is applied");
          for (const pattern of [/Added by you/, /Added March 15, 2026/, /Not reviewed by this tool|No Microsoft Learn topics read yet/, ...expected]) assert.match(view.text, pattern, `${product.name}: ${pattern}`);
          assert.deepEqual(view.problems, [], `${product.name}: nothing is cut off, boxed, or striped`);
          assert.ok(view.lowestContrast.ratio >= 4.5, `${product.name}: "${view.lowestContrast.where}" has contrast ${view.lowestContrast.ratio.toFixed(2)}`);
          assert.ok(view.cardOverflow <= 0 && view.pageOverflow <= 0, `${product.name}: nothing scrolls sideways`);

          // Keyboard: Tab from the card's checkbox reaches its Remove button, which draws a focus ring.
          await page.focus(`${cardOf(product.id)} input`);
          const reached = await tabTo(page, (info) => info.remove === product.id);
          assert.equal(reached.label, `Remove ${product.name} from my products`);
          assert.ok(reached.outlineStyle !== "none" && reached.outlineWidth >= 2, `${product.name}: Remove shows a focus ring (${reached.outlineStyle} ${reached.outlineWidth}px)`);

          // Enter asks first, with the focus on Keep, and the question fits inside the card and the window.
          await page.keyboard.press("Enter");
          await page.waitForSelector(`${cardOf(product.id)} .lb-card-confirm`);
          const asking = await page.evaluate(focusInfo);
          assert.equal(asking.keep, product.id, "the focus lands on Keep");
          assert.ok(asking.outlineWidth >= 2, "Keep shows a focus ring");
          const open = await page.evaluate(measureCard, product.id);
          assert.deepEqual(open.problems, [], `${product.name}: the question is not cut off`);
          assert.ok(open.confirm.insideCard && open.confirm.onScreenX, `${product.name}: the question fits`);
          assert.match(open.confirm.text, /^Remove .+\n?\s*Labs you already built from it are not changed\. (You can add it again from Add another Microsoft product\.|It is not product documentation, so it cannot be added again\.)/s);
          assert.ok(open.lowestContrast.ratio >= 4.5, `${product.name}: the question keeps its contrast (${open.lowestContrast.ratio.toFixed(2)})`);
          await page.keyboard.press("Shift+Tab");
          assert.equal((await page.evaluate(focusInfo)).confirm, product.id, "the Remove button of the question is next to Keep");

          // Escape cancels and the focus goes back to Remove; nothing was deleted.
          await page.keyboard.press("Escape");
          assert.equal(await page.locator(`${cardOf(product.id)} .lb-card-confirm`).count(), 0, "Escape closes the question");
          assert.equal((await page.evaluate(focusInfo)).remove, product.id, "the focus is back on Remove");
          assert.equal(await page.locator(cardOf(product.id)).count(), 1, "the product is still there");
        }
        assert.equal(await page.locator("#lb-product-options input:checked").count(), 0, "asking and cancelling never ticked a product");
        assert.deepEqual(errors, [], "no script errors on the page");
      } finally {
        await context.close();
      }
    });
  }
}

for (const [theme, viewport] of [
  ["light", VIEWPORTS[0]],
  ["dark", VIEWPORTS[2]],
]) {
  test(`removing a product deletes it, unselects it, updates Your lab so far, and offers Undo only where it can be added again (${viewport.width}px, ${theme})`, async (t) => {
    if (ctx.skipReason) return t.skip(ctx.skipReason);
    const server = await startServer([QA, HUB, GENERIC]);
    const { context, page, errors } = await openWizard(server.base, viewport, theme);
    const requests = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/lab-builder/products/mine")) requests.push(`${request.method()} ${new URL(request.url()).pathname}`);
    });
    const savedIds = () => JSON.parse(readFileSync(server.productsFile, "utf8")).products.map((p) => p.id);
    const press = async (selector) => {
      await page.click(selector);
      await page.waitForTimeout(120);
    };
    try {
      // The Q&A product, selected: Remove, confirm, gone, no Undo (its address cannot be added again).
      await press(`${cardOf(QA.id)} input`);
      await press(`${cardOf(HUB.id)} input`);
      await page.waitForFunction(() => /What do you need help with today\?/.test(document.getElementById("lb-summary")?.innerText || ""));
      await press(`${cardOf(QA.id)} [data-prod-remove]`);
      assert.equal((await page.evaluate(focusInfo)).keep, QA.id);
      await press(`${cardOf(QA.id)} [data-prod-confirm]`);
      await page.waitForFunction((id) => !document.querySelector(`#lb-product-options input[value="${id}"]`), QA.id);
      await page.waitForFunction(() => /^Removed /.test(document.getElementById("lb-product-status")?.textContent || ""));
      assert.deepEqual(requests.filter((line) => line.startsWith("DELETE")), [`DELETE /api/lab-builder/products/mine/${QA.id}`]);
      assert.deepEqual(savedIds().sort(), [GENERIC.id, HUB.id].sort(), "the saved file no longer has it");
      assert.equal(await page.locator("#lb-product-status").innerText(), "Removed What do you need help with today? Labs you already built from it are not changed.");
      assert.equal(await page.locator("#lb-product-status [data-prod-undo]").count(), 0, "no Undo for an address the add route refuses");
      assert.equal((await page.evaluate(focusInfo)).id, "lb-product-status", "the focus is on the message");
      assert.doesNotMatch(await page.locator("#lb-summary").innerText(), /What do you need help with today/, "Your lab so far no longer lists it");
      assert.match(await page.locator("#lb-summary").innerText(), /Power BI/, "the other selected product stays");
      assert.equal(await page.locator("#lb-product-status").getAttribute("role"), "status");

      // The real hub: Remove, confirm, gone, Undo offered; Microsoft Learn is off here, so Undo says why and stays.
      await press(`${cardOf(HUB.id)} [data-prod-remove]`);
      await press(`${cardOf(HUB.id)} [data-prod-confirm]`);
      await page.waitForFunction((id) => !document.querySelector(`#lb-product-options input[value="${id}"]`), HUB.id);
      await page.waitForFunction(() => /^Removed Power BI/.test(document.getElementById("lb-product-status")?.textContent || ""));
      assert.equal(await page.locator("#lb-product-status").innerText(), "Removed Power BI. Labs you already built from it are not changed. Undo");
      assert.equal((await page.evaluate(focusInfo)).undo, true, "the focus is on Undo");
      assert.equal(await page.locator("#lb-summary").isHidden(), true, "with nothing selected Your lab so far is empty");
      assert.deepEqual(savedIds(), [GENERIC.id]);
      const fit = await page.evaluate(() => {
        const status = document.getElementById("lb-product-status").getBoundingClientRect();
        return { left: status.left, right: status.right, width: innerWidth, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
      });
      assert.ok(fit.left >= 0 && fit.right <= fit.width + 1 && fit.overflow <= 0, "the message and Undo fit the window");
      await press("#lb-product-status [data-prod-undo]");
      await page.waitForFunction(() => /could not be reached/i.test(document.getElementById("lb-product-error")?.textContent || ""));
      assert.match(await page.locator("#lb-product-error").innerText(), /You can also add it again from Add another Microsoft product\.$/);
      assert.equal(await page.locator("#lb-product-status [data-prod-undo]").count(), 1, "Undo stays so it can be tried again");
      assert.ok(requests.includes("POST /api/lab-builder/products/mine"), "Undo used the add route");

      // The panel under the list explains where added products are managed, and its list removes through the same code.
      await page.click("#lb-addprod > summary");
      await page.waitForFunction(() => /Products you added \(1\)/.test(document.getElementById("lb-addprod-saved")?.innerText || ""));
      assert.match(await page.locator("#lb-addprod .lb-mine-help").innerText(), /Products you add here appear in the list above marked Added by you.*Remove one from its card or from Products you added below\./);
      await press(`#lb-addprod-saved [data-addprod-remove="${GENERIC.id}"]`);
      await page.waitForFunction((id) => !document.querySelector(`#lb-product-options input[value="${id}"]`), GENERIC.id);
      await page.waitForFunction(() => /^Removed Welcome/.test(document.getElementById("lb-product-status")?.textContent || ""));
      assert.deepEqual(savedIds(), [], "the list's Remove deleted it too");
      assert.match(await page.locator("#lb-product-status").innerText(), /^Removed Welcome\. Labs you already built from it are not changed\. Undo$/);
      assert.deepEqual(errors, [], "no script errors on the page");
    } finally {
      await context.close();
      server.stop();
    }
  });
}
