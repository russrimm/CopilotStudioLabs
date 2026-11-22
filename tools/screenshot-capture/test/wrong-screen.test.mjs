// Screenshots that show the wrong screen: what the companion now refuses to photograph, and what it hides. Real headless Chromium on
// made-up pages (nothing leaves this computer, no real product or tenant is opened). Each real-browser test skips itself when no
// Chromium is installed.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runShotSetup } from "../autonomous.mjs";
import { createCaptureSession } from "../capture-run.mjs";
import { runJob } from "../companion.mjs";
import { resolveAutonomy } from "../guard.mjs";
import { detectBrowserAvailability, loadPlaywrightModule } from "../lab-runner.mjs";
import { applyRedaction, clearOverlays, readPageSignals, scrubSensitiveText } from "../redact.mjs";
import { personAutomation, resolveAutomation } from "../walkthrough.mjs";
import { FAKE_AGENT_URL, createFakeProductSite, withFakeProductSite } from "./fixtures/fake-product-site.mjs";

const found = await detectBrowserAvailability();
const skip = !found.available && "Playwright with Chromium is not installed";
const playwright = found.playwrightInstalled ? await loadPlaywrightModule() : null;

// ── The computer does not photograph a start page for a deeper screen ───────

const stepless = (extra = {}) => ({
  filename: "ppai-ai-models-page.png",
  product: "power-platform-ai-hub",
  capture: { version: 1, mode: "guided", product: "power-platform-ai-hub", route: { kind: "url" }, reveal: [], automation: personAutomation("other-product"), ...extra },
});

test("a screen deeper than the page its address opens, with no step that reaches it, is left to a person with the portal's own reason, and nothing is photographed", async () => {
  const session = createCaptureSession({ env: {}, targets: {}, autonomy: resolveAutonomy(null) });
  const events = [];
  const result = await runShotSetup({ page: {}, shot: stepless(), session, sleep: async () => {}, trace: { event: (name, data) => events.push([name, data]) } });
  assert.equal(result.ok, false);
  assert.equal(result.cause, "no-recipe");
  assert.equal(result.reason, "other-product", "the same fixed reason the portal showed on the card");
  assert.match(result.error, /Use “Retake guided”, or upload the picture\.$/);
  assert.deepEqual(result.setup.steps, [], "no step ran");
  assert.deepEqual(events.map(([name]) => name), ["no-recipe"]);

  // The reason the portal showed is the reason the computer gives.
  const unseen = await runShotSetup({ page: {}, shot: stepless({ automation: personAutomation("unseen") }), session, sleep: async () => {} });
  assert.equal(unseen.cause, "no-recipe");
  assert.match(unseen.error, /has not seen this screen in the real product/);

  // An older plan with no reason still stops: it is read the same way the portal reads it.
  const older = await runShotSetup({ page: {}, shot: stepless({ automation: undefined }), session, sleep: async () => {} });
  assert.equal(older.cause, "no-recipe");
  assert.equal(older.ok, false);

  // A screen the address itself opens (the planner's own "auto" reading) is not affected.
  assert.equal(resolveAutomation({ filename: "x.png", capture: { automation: personAutomation("admin") } }).reason, "admin");
});

// ── Masking, in a real browser ──────────────────────────────────────────────

const PAGE = `<body style="font:16px Arial;margin:0;width:1000px;height:700px">
<header style="height:70px;position:relative">
  <span id="env" style="position:absolute;left:20px;top:10px">Contoso (default)</span>
  <span id="chip" style="position:absolute;left:260px;top:10px">Work Ada</span>
  <span id="plan" style="position:absolute;left:420px;top:10px">M365 Copilot (Premium)</span>
  <div id="initials" role="button" tabindex="0" style="position:absolute;right:20px;top:10px;width:40px;height:40px;border-radius:50%;background:#357;color:#fff;text-align:center;line-height:40px">AL</div>
</header>
<h1 id="welcome">Welcome, Ada!</h1>
<p id="hello">Hello, Grace</p><p id="hi">Hi, Linus.</p><p id="morning">Good morning, Margaret</p><p id="plain">Welcome to Copilot Studio</p>
<section><h2 id="recent-heading">Recent</h2><ul><li><a id="r1" href="#">Q3 renewal notes for Fabrikam</a></li><li><a id="r2" href="#">Draft reply to Tailspin</a></li></ul><a id="see-all" href="#">See all</a></section>
<aside aria-label="Chat history" style="width:300px"><div id="h1">Planning the offsite</div><div id="h2">Budget questions</div></aside>
<table><thead><tr><th id="th-name">Name</th><th id="th-last">Last opened</th></tr></thead><tbody><tr><td id="td-name">Support Assistant</td><td id="td-when">Yesterday</td></tr></tbody></table>
<p id="mail">Mail: ada@contoso.com</p>
<button id="settings">Settings</button></body>`;

/** The share (0 to 1) of an element's box (or of the box of one word in it) that an overlay covers. */
async function coverage(page, id, word = null) {
  return page.evaluate(
    ({ id: elementId, word: part }) => {
      const el = document.getElementById(elementId);
      let rect = el.getBoundingClientRect();
      if (part) {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        const node = walker.nextNode();
        const at = node.nodeValue.indexOf(part);
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + part.length);
        rect = range.getBoundingClientRect();
      }
      const area = rect.width * rect.height;
      let covered = 0;
      for (const overlay of document.querySelectorAll("[data-capture-overlay]")) {
        const o = overlay.getBoundingClientRect();
        const w = Math.max(0, Math.min(rect.right, o.right) - Math.max(rect.left, o.left));
        const h = Math.max(0, Math.min(rect.bottom, o.bottom) - Math.max(rect.top, o.top));
        covered += w * h;
      }
      return Math.min(1, covered / area);
    },
    { id, word },
  );
}

test("in a real browser, greetings, chips, avatars, recent and history lists, last-opened names, the environment, and emails are covered; the layout and the rest stay", { skip, timeout: 120_000 }, async () => {
  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    await page.setContent(PAGE);
    const before = await page.screenshot();
    const evidence = await applyRedaction(page);
    assert.equal(evidence.applied, true);
    assert.ok(evidence.controls >= 1, "the initials avatar counts as an account control");
    assert.ok(evidence.lists >= 3 && evidence.listsMasked === evidence.lists, `three list regions were found (Recent, the chat history, the Last opened table) and every one was covered: ${JSON.stringify(evidence)}`);

    for (const id of ["env", "chip", "plan", "initials", "r1", "r2"]) assert.ok((await coverage(page, id)) > 0.9, `${id} is covered`);
    for (const [id, word] of [["welcome", "Ada"], ["hello", "Grace"], ["hi", "Linus"], ["morning", "Margaret"], ["h1", "Planning the offsite"], ["h2", "Budget questions"], ["td-name", "Support Assistant"], ["td-when", "Yesterday"], ["mail", "ada@contoso.com"]]) assert.ok((await coverage(page, id, word)) > 0.9, `the name or title in "${id}" is covered`);
    for (const [id, word] of [["welcome", "Welcome"], ["hello", "Hello"], ["morning", "Good morning"]]) assert.ok((await coverage(page, id, word)) < 0.2, `the greeting words in "${id}" stay`);
    for (const id of ["plain", "recent-heading", "see-all", "th-name", "th-last", "settings"]) assert.ok((await coverage(page, id)) < 0.2, `${id} stays: layout and ordinary text are kept`);

    await clearOverlays(page);
    assert.equal(await page.evaluate(() => document.querySelectorAll("[data-capture-overlay]").length), 0);
    assert.ok((await page.screenshot()).equals(before), "after the picture the page is exactly as it was");
  } finally {
    await browser.close();
  }
});

test("the text a page sends as evidence never carries a name, a chip, or the environment", () => {
  assert.equal(scrubSensitiveText("Welcome, Ada!"), "Welcome, [hidden]!");
  assert.equal(scrubSensitiveText("Hello, Grace"), "Hello, [hidden]");
  assert.equal(scrubSensitiveText("Work Ada"), "[hidden]");
  assert.equal(scrubSensitiveText("Contoso (default)"), "[hidden]");
  assert.equal(scrubSensitiveText("Welcome to Copilot Studio"), "Welcome to Copilot Studio");
  assert.equal(scrubSensitiveText("Work item history"), "Work item history", "an ordinary label that starts with Work is not a chip");
});

test("in a real browser, the page's own signals say a public page offers Sign in and shows no account, and a signed-in page does not", { skip, timeout: 120_000 }, async () => {
  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    await page.setContent(`<body style="margin:0"><header style="height:60px"><b>Product</b><button style="float:right">Sign in</button></header><h1>Build things</h1></body>`);
    assert.deepEqual(await readPageSignals(page), { signInVisible: true, accountControl: false, signedOut: true });
    await page.setContent(PAGE);
    assert.deepEqual(await readPageSignals(page), { signInVisible: false, accountControl: true, signedOut: false });
    // A Sign in button lower in a signed-in page (a connection card) is not the page asking you to sign in.
    await page.setContent(`<body style="margin:0"><header style="height:60px"><button id="O365_MainLink_Me" style="float:right;width:40px;height:40px">AL</button></header><main style="padding:200px 20px"><button>Sign in</button></main></body>`);
    assert.equal((await readPageSignals(page)).signedOut, false);
    assert.equal(await readPageSignals({ evaluate: async () => undefined }), null, "a page that cannot be read says nothing");
  } finally {
    await browser.close();
  }
});

// ── The job stops on a public page ──────────────────────────────────────────

test("real browser: a product that shows its public page (a Sign in button, no account) stops the job with a plain reason and photographs nothing", { skip, timeout: 120_000 }, async () => {
  const site = createFakeProductSite({ signedOutHome: true });
  const wrapped = withFakeProductSite(playwright, site);
  const calls = { progress: [], uploads: [] };
  const client = {
    async heartbeat() {
      return {};
    },
    async progress(_id, body) {
      calls.progress.push(body);
      return { ok: true };
    },
    async upload(_id, filename) {
      calls.uploads.push(filename);
      return { status: 200, body: { outcome: "accepted" } };
    },
    async complete() {
      return {};
    },
  };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "capture-signed-out-"));
  const lines = [];
  const shot = {
    filename: "home.png",
    shotId: "home.png",
    featureId: "f",
    moduleTitle: "Module",
    product: "copilot-studio",
    authProfile: "copilot-studio",
    startUrl: "https://copilotstudio.microsoft.com/",
    viewport: { width: 1280, height: 720 },
    manual: false,
    requiresEnv: null,
    expectedLabels: [],
    callouts: [],
    steps: [],
    capture: { version: 1, mode: "auto", why: "", needs: [], missing: [], ready: true, route: { kind: "copilot-studio", screen: "home", scope: "environment" }, screen: { id: "home", label: "the Copilot Studio home page" }, path: ["Copilot Studio", "Home"], expect: { family: "copilot-studio", scope: "environment", paths: ["home"], label: "the Copilot Studio home page", strict: true }, reveal: [], landmarks: [], guide: [] },
  };
  try {
    const result = await runJob({
      client,
      claimed: { job: { id: "job_00000000000000cc", target: { type: "library", products: [] }, scope: {}, options: { callouts: "none", redact: true }, createdAt: new Date().toISOString(), resumed: false }, env: { CAPTURE_COPILOT_STUDIO_AGENT_URL: FAKE_AGENT_URL }, targets: {}, shots: [shot] },
      home,
      playwright: wrapped,
      options: { headless: true, attended: true, waitForSignIn: true, signInWaitSec: 8, readiness: { maxMs: 12_000 } },
      log: (line) => lines.push(String(line)),
      heartbeatMs: 60_000,
    });
    assert.equal(result.tally.captured, 0, lines.join("\n"));
    assert.equal(calls.uploads.length, 0, "nothing was uploaded");
    assert.equal(result.signInFailures.length, 1, "the product is marked as needing a sign-in");
    const reported = calls.progress.map((p) => p.shot).filter(Boolean).find((s) => s.status === "auth-required");
    assert.ok(reported, "the shot is reported as waiting for a sign-in");
    assert.match(String(reported.error), /You are not signed in to Copilot Studio/);
  } finally {
    await Promise.all(wrapped.contexts.map((c) => c.close().catch(() => {})));
    try {
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
    } catch {
      // A browser can hold a file a moment longer on Windows; the folder is in the temp directory.
    }
  }
});
