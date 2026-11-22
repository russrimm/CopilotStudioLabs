/**
 * Two people using the wizard at the same time, in two separate browser contexts (headless Chromium, throwaway profiles,
 * a throwaway portal on a port from 3131 to 3139): each has their own browser id, so each saves a draft, gets an autosave
 * banner, and builds a lab without seeing the other's drafts or banner. A second test shows what a person is told while
 * their lab waits in line (and that Cancel works while waiting) and when someone else deleted the lab they have open.
 * Set CONCURRENCY_DEMO_DIR to a folder to also save screenshots of those messages in light and dark. The tests skip
 * themselves when Playwright or a Chromium build is not installed (tools/screenshot-capture: npm install).
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PORTAL_ROOT = resolve(here, "..");
const PLAYWRIGHT = resolve(PORTAL_ROOT, "..", "tools", "screenshot-capture", "node_modules", "playwright", "index.mjs");
const DEMO_DIR = process.env.CONCURRENCY_DEMO_DIR ? resolve(process.env.CONCURRENCY_DEMO_DIR) : "";
const cleanups = [];
const ctx = {};

async function freePort() {
  const probe = (port) =>
    new Promise((resolvePort) => {
      const server = createServer();
      server.once("error", () => resolvePort(0));
      server.listen(port, "127.0.0.1", () => {
        const { port: bound } = server.address();
        server.close(() => resolvePort(bound));
      });
    });
  for (let port = 3131; port <= 3139; port += 1) {
    const got = await probe(port);
    if (got) return got;
  }
  return probe(0);
}

before(async () => {
  const root = mkdtempSync(join(tmpdir(), "lb-two-people-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const storage = join(root, "storage");
  const localAppData = join(root, "localappdata");
  mkdirSync(localAppData, { recursive: true });
  ctx.port = await freePort();
  ctx.base = `http://127.0.0.1:${ctx.port}`;
  let stderr = "";
  const child = spawn(process.execPath, ["server.js"], {
    cwd: PORTAL_ROOT,
    env: {
      ...process.env,
      LOCALAPPDATA: localAppData,
      PORT: String(ctx.port),
      HOST: "127.0.0.1",
      PORTAL_AUTH_DISABLED: "true",
      AZURE_KEYVAULT_URL: "",
      AZURE_STORAGE_BLOB_ENDPOINT: "",
      PORTAL_STORAGE_ROOT: storage,
      PORTAL_DATA_DIR: join(storage, "data"),
      LAB_BUILDER_OUTPUT_DIR: join(storage, "generated-labs"),
      FEATURE_TOUR_SCREENSHOTS_DIR: join(storage, "screenshots"),
      LAB_BUILDER_LINK_CHECK: "off",
      LAB_BUILDER_LLM: "off",
      LAB_BUILDER_VENDOR_DOCS: "off",
      LAB_BUILDER_TOPICS_DISABLED: "1",
      LAB_BUILDER_MAX_ACTIVE: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (c) => (stderr = (stderr + c).slice(-1500)));
  cleanups.push(() => child.kill());
  const deadline = Date.now() + 60000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`The portal exited early (${child.exitCode}): ${stderr}`);
    try {
      if ((await fetch(`${ctx.base}/healthz`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`The portal did not start: ${stderr}`);
    await new Promise((r) => setTimeout(r, 120));
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

async function person(name, { theme } = {}) {
  const context = await ctx.browser.newContext({ viewport: { width: 1280, height: 900 } });
  if (theme) {
    await context.addInitScript((value) => {
      try {
        localStorage.setItem("portal-theme", value);
      } catch {
        /* a sandboxed frame (the lab preview) has no storage */
      }
    }, theme);
  }
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.goto(`${ctx.base}/#labbuilder`);
  await page.waitForSelector('input[name="lb-product"]');
  await page.waitForFunction(() => lbDraft.loaded);
  return { name, context, page, errors, api: (path, init) => page.evaluate(async ([p, i]) => {
    const res = await fetch(p, i);
    return { status: res.status, body: await res.json().catch(() => null) };
  }, [path, init || {}]) };
}

async function shot(page, name, scrollTo) {
  if (!DEMO_DIR) return;
  if (scrollTo) await page.locator(scrollTo).scrollIntoViewIfNeeded();
  mkdirSync(DEMO_DIR, { recursive: true });
  await page.screenshot({ path: join(DEMO_DIR, `${name}.png`) });
}

const next = (page, step) => page.click(`#lb-pane-${step} .lb-nav-next`);
const stepIs = (page, step) => page.waitForFunction((n) => labBuilder.step === n && document.activeElement?.id === `lb-heading-${n}`, step, { timeout: 20000 });

/** Product, Tailor it, Topics (the suggestion), then Review and build: the wizard up to its last step. */
async function driveToReview(page, { industry, title }) {
  await page.check('input[name="lb-product"][value="copilot-studio"]');
  await next(page, 1);
  await stepIs(page, 2);
  await page.selectOption("#lb-industry-select", industry);
  await page.check('input[name="lb-role"]:nth-of-type(1)');
  await page.check('input[name="lb-level"][value="200"]');
  await page.check('input[name="lb-harness"][value="standard"]');
  await next(page, 2);
  await stepIs(page, 3);
  await page.waitForSelector("#lb-topic-groups details.lb-concept");
  await next(page, 3);
  await stepIs(page, 4);
  await page.waitForSelector("#lb-preview table");
  await page.evaluate(() => document.querySelectorAll("#lb-pane-4 details").forEach((d) => (d.open = true)));
  await page.fill("#lb-title", title);
  await page.uncheck("#lb-use-learn");
  await page.uncheck("#lb-use-llm");
}

async function saveDraft(page, name) {
  await page.click("#lb-save-draft");
  await page.waitForSelector("#lb-draft-name-dialog[open]");
  await page.fill("#lb-draft-name", name);
  await page.click("#lb-draft-name-save");
  await page.waitForFunction(() => /^Saved\. You can pick this up later/.test(document.getElementById("lb-draft-status").textContent));
}

test("two people at once: each saves a draft, gets their own autosave banner, and builds a lab, and neither sees the other's drafts", async (t) => {
  if (!ctx.browser) return t.skip(ctx.skipReason);
  const features = (await (await fetch(`${ctx.base}/api/lab-builder/features`)).json());
  const [ann, ben] = await Promise.all([person("ann"), person("ben")]);
  t.after(() => Promise.all([ann.context.close(), ben.context.close()]));
  assert.notEqual(await ann.page.evaluate(() => portalClientId()), await ben.page.evaluate(() => portalClientId()), "each browser made its own id");
  assert.equal(await ann.page.evaluate(() => portalClientId()), await ann.page.evaluate(() => localStorage.getItem("labBuilder.clientId.v1")), "and kept it");

  // Ann starts a lab and a refresh brings up her banner; Ben has done nothing, so his page shows no banner.
  await ann.page.check('input[name="lb-product"][value="copilot-studio"]');
  await next(ann.page, 1);
  await ann.page.selectOption("#lb-industry-select", features.industries[0].id);
  await ann.page.waitForResponse((res) => res.url().endsWith("/api/lab-builder/drafts/unsaved") && res.request().method() === "PUT", { timeout: 20000 });
  await ann.page.reload();
  await ann.page.waitForSelector("#lb-unsaved-banner:not([hidden])");
  assert.match(await ann.page.textContent("#lb-unsaved-banner-text"), /^You have unsaved work from .+\. Resume or discard\.$/);
  await ben.page.reload();
  await ben.page.waitForSelector('input[name="lb-product"]');
  await ben.page.waitForFunction(() => lbDraft.loaded);
  assert.equal(await ben.page.isHidden("#lb-unsaved-banner"), true, "Ben is not offered Ann's unsaved work");
  await ann.page.click("#lb-unsaved-discard");
  await ann.page.waitForSelector("#lb-unsaved-banner", { state: "hidden" });

  // Both go through the wizard, save a draft with their own name, and press Build at the same moment (one build runs at
  // a time here, so the second waits its turn and still succeeds).
  await Promise.all([
    driveToReview(ann.page, { industry: features.industries[0].id, title: "Ann retail lab" }),
    driveToReview(ben.page, { industry: features.industries[1].id, title: "Ben health lab" }),
  ]);
  await Promise.all([saveDraft(ann.page, "Draft by Ann"), saveDraft(ben.page, "Draft by Ben")]);
  await Promise.all([ann.page.click("#lb-generate-btn"), ben.page.click("#lb-generate-btn")]);
  await Promise.all([ann.page, ben.page].map((p) => p.waitForFunction(() => document.getElementById("lb-result-panel").style.display !== "none", null, { timeout: 150000 })));

  const labs = (await ann.api("/api/lab-builder/generated")).body.labs;
  assert.deepEqual(labs.map((l) => l.title).sort(), ["Ann retail lab", "Ben health lab"], "both labs were built");
  assert.equal(new Set(labs.map((l) => l.labId)).size, 2);

  // Each person's drafts: only their own, in the list, on a fresh load, and over the API.
  for (const [me, other, mine, theirs] of [[ann, ben, "Draft by Ann", "Draft by Ben"], [ben, ann, "Draft by Ben", "Draft by Ann"]]) {
    await me.page.reload();
    await me.page.waitForSelector('input[name="lb-product"]');
    await me.page.waitForFunction(() => document.getElementById("lb-drafts-badge").textContent === "1");
    await me.page.click("#lb-drafts-details > summary");
    await me.page.waitForSelector("#lb-drafts-list .lb-gen-item");
    const listText = await me.page.textContent("#lb-drafts-list");
    assert.match(listText, new RegExp(mine));
    assert.doesNotMatch(listText, new RegExp(theirs), `${me.name} does not see ${other.name}'s draft`);
    const drafts = (await me.api("/api/lab-builder/drafts")).body;
    assert.deepEqual(drafts.drafts.map((d) => d.name), [mine]);
    assert.equal(drafts.unsaved, null, "a built lab leaves no unsaved copy, and never someone else's");
  }
  assert.deepEqual([...ann.errors, ...ben.errors], [], "no script errors on either page");
});

for (const theme of ["light", "dark"]) {
  test(`while a lab waits in line the page says where it stands (and Cancel works), in ${theme} theme`, async (t) => {
    if (!ctx.browser) return t.skip(ctx.skipReason);
    const features = (await (await fetch(`${ctx.base}/api/lab-builder/features`)).json());
    const cy = await person("cy", { theme });
    t.after(() => cy.context.close());
    await driveToReview(cy.page, { industry: features.industries[2]?.id || features.industries[0].id, title: `Cy lab ${theme}` });

    // The real build runs; only the answers about the line are made up, so the words can be checked at known moments.
    const answers = [
      { state: "queued", position: 1, ahead: 0, running: 1, waiting: 1, concurrency: 1 },
      { state: "queued", position: 3, ahead: 2, running: 1, waiting: 3, concurrency: 1 },
    ];
    let asked = 0;
    await cy.page.route("**/api/lab-builder/build-queue/**", (route) => route.fulfill({ json: answers[Math.min(asked++, answers.length - 1)] }));
    let holdOpen = true;
    await cy.page.route("**/api/lab-builder/generate", async (route) => {
      while (holdOpen) await new Promise((r) => setTimeout(r, 50));
      await route.continue();
    });

    assert.equal(await cy.page.getAttribute("#lb-status", "aria-live"), "polite", "the status line is a polite live region");
    await cy.page.click("#lb-generate-btn");
    await cy.page.waitForFunction(() => document.getElementById("lb-status").textContent === "Your lab is next in line.", null, { timeout: 15000 });
    assert.equal(await cy.page.textContent("#lb-generating-phase"), "Your lab is next in line.");
    assert.match(await cy.page.textContent("#lb-generating-sub"), /^Your lab starts as soon as a place is free\. Nothing is written until it does, and you can cancel\.$/, "the card does not claim research is under way while the lab waits");
    assert.equal(await cy.page.isVisible("#lb-cancel-btn"), true, "Cancel is there while waiting");
    await shot(cy.page, `queue-next-in-line-${theme}`, "#lb-generating-stages");
    await cy.page.waitForFunction(() => document.getElementById("lb-status").textContent === "3 people are building labs. Yours starts soon.", null, { timeout: 15000 });
    assert.equal(await cy.page.textContent("#lb-generating-phase"), "3 people are building labs. Yours starts soon.");
    await shot(cy.page, `queue-people-building-${theme}`, "#lb-generating-stages");

    // Cancel with the keyboard while waiting: nothing is built and the button is back.
    await cy.page.focus("#lb-cancel-btn");
    await cy.page.keyboard.press("Enter");
    await cy.page.waitForFunction(() => document.getElementById("lb-status").textContent === "");
    assert.equal(await cy.page.isEnabled("#lb-generate-btn"), true);
    assert.deepEqual((await cy.api("/api/lab-builder/generated")).body.labs.filter((l) => l.title === `Cy lab ${theme}`), [], "a canceled wait builds nothing");

    // Let the next build through: the waiting words go away and the lab is built.
    holdOpen = false;
    await cy.page.unroute("**/api/lab-builder/build-queue/**");
    await cy.page.click("#lb-generate-btn");
    await cy.page.waitForFunction(() => document.getElementById("lb-result-panel").style.display !== "none", null, { timeout: 120000 });
    assert.equal(await cy.page.textContent("#lb-status"), "");
    assert.deepEqual(cy.errors, []);
  });

  test(`when someone else deletes the lab you have open, the page says so in plain words, in ${theme} theme`, async (t) => {
    if (!ctx.browser) return t.skip(ctx.skipReason);
    const features = (await (await fetch(`${ctx.base}/api/lab-builder/features`)).json());
    const dee = await person("dee", { theme });
    const eli = await person("eli", { theme });
    t.after(() => Promise.all([dee.context.close(), eli.context.close()]));
    await driveToReview(dee.page, { industry: features.industries[0].id, title: `Dee lab ${theme}` });
    await dee.page.click("#lb-generate-btn");
    await dee.page.waitForFunction(() => document.getElementById("lb-result-panel").style.display !== "none", null, { timeout: 120000 });
    const labId = (await dee.api("/api/lab-builder/generated")).body.labs.find((l) => l.title === `Dee lab ${theme}`).labId;
    await dee.page.waitForFunction(() => document.getElementById("lb-result-preview") && !/Loading the preview/.test(document.getElementById("lb-result-preview").textContent));

    // Eli (another browser) deletes it.
    assert.equal((await eli.api(`/api/lab-builder/generated/${labId}`, { method: "DELETE" })).status, 200);

    // Dee's next request about the lab says what happened, and the list catches up.
    await dee.page.evaluate((id) => lbLoadResultPreview(id), labId);
    const message = "Someone else changed this lab while you were viewing it. Reload to see the latest.";
    await dee.page.waitForFunction((text) => document.getElementById("lb-result-preview").textContent.includes(text), message);
    assert.equal(await dee.page.getAttribute("#lb-result-preview [role=alert]", "role"), "alert", "it is announced");
    await dee.page.waitForFunction((id) => !lbGen.labs.some((l) => l.labId === id), labId);
    await shot(dee.page, `lab-changed-${theme}`, "#lb-result-preview");
    assert.deepEqual(dee.errors, []);
  });
}
