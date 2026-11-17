// Real-browser proof of the capture fixes. The companion's own runJob drives a real Chromium (and the installed
// Microsoft Edge, when there is one) against a pretend Copilot Studio that answers by route interception, so
// nothing leaves this computer and the real host patterns are exercised. Each test skips itself when no browser is
// installed. It imitates what broke the real captures: a start page that is not the agent, a promo card named like
// a navigation item, pages that show a skeleton or a bare spinner for seconds, an interrupted first navigation,
// and a window the person closes.
//
// To see the same scenarios against a lab built by the portal, before and after a change:
//   node test/fixtures/capture-repro.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { detectInstalledBrowsers } from "../browsers.mjs";
import { runJob } from "../companion.mjs";
import { detectBrowserAvailability, loadPlaywrightModule } from "../lab-runner.mjs";
import { FAKE_AGENT, FAKE_AGENT_URL, FAKE_ENV_ID, FAKE_HOSTS, createFakeProductSite, withFakeProductSite } from "./fixtures/fake-product-site.mjs";

const found = await detectBrowserAvailability();
const edge = Boolean(detectInstalledBrowsers().edge);
const playwright = found.playwrightInstalled ? await loadPlaywrightModule() : null;
const skip = !found.available && "Playwright with Chromium is not installed";

const base = `https://${FAKE_HOSTS.studio}/environments/${FAKE_ENV_ID}`;
const SCREENS = {
  home: { scope: "environment", paths: ["home"], label: "the Copilot Studio home page", path: ["Copilot Studio", "Home"] },
  overview: { scope: "agent", paths: ["overview"], label: "the agent's Overview page", path: ["Copilot Studio", "your agent", "Overview"] },
  knowledge: { scope: "agent", paths: ["knowledge"], label: "the agent's Knowledge page", path: ["Copilot Studio", "your agent", "Knowledge"] },
  settings: { scope: "agent", paths: ["settings"], label: "the agent's Settings page", path: ["Copilot Studio", "your agent", "Settings"] },
};

/** A plan shot the way the portal builds it: a `capture` descriptor with the route, the expected address, and what to reveal. */
function planShot(filename, screenId, { mode = "auto", reveal = [], extra = {} } = {}) {
  const screen = SCREENS[screenId];
  return {
    filename,
    shotId: filename,
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
    capture: {
      version: 1,
      mode,
      why: "",
      needs: screen.scope === "agent" && mode === "auto" ? ["copilot-studio-agent"] : [],
      missing: [],
      ready: true,
      route: { kind: "copilot-studio", screen: screenId, scope: screen.scope },
      screen: { id: screenId, label: screen.label },
      path: screen.path,
      expect: { family: "copilot-studio", scope: screen.scope, paths: screen.paths, label: screen.label, strict: mode === "auto" },
      reveal,
      landmarks: [],
      guide: ["Set the screen up.", "Press Capture this screen."],
    },
    ...extra,
  };
}

function recordingClient({ onUpload = null } = {}) {
  const calls = { progress: [], uploads: [], completes: [] };
  return {
    calls,
    async heartbeat() {
      return {};
    },
    async progress(_id, body) {
      calls.progress.push(body);
      return { ok: true };
    },
    async upload(_id, filename, payload) {
      calls.uploads.push({ filename, evidence: payload.evidence });
      if (onUpload) await onUpload({ uploads: calls.uploads.length, filename });
      return { status: 200, body: { outcome: "accepted" } };
    },
    async complete(_id, body) {
      calls.completes.push(body);
      return {};
    },
  };
}

async function run({ shots, site: siteOptions = {}, env = { CAPTURE_COPILOT_STUDIO_AGENT_URL: FAKE_AGENT_URL }, targets = {}, options = {}, channel = undefined, jobOptions = {}, closeAfter = 0 }) {
  const site = createFakeProductSite(siteOptions);
  const wrapped = withFakeProductSite(playwright, site, { forceChannel: channel });
  const client = recordingClient({
    onUpload: closeAfter ? async ({ uploads }) => (uploads === closeAfter ? Promise.all(wrapped.contexts.map((c) => c.close().catch(() => {}))) : undefined) : null,
  });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "capture-real-"));
  const lines = [];
  const started = Date.now();
  try {
    const result = await runJob({
      client,
      claimed: { job: { id: "job_00000000000000bb", target: { type: "library", products: [] }, scope: {}, options: { callouts: "none", redact: true, ...jobOptions }, createdAt: new Date().toISOString(), resumed: false }, env, targets, shots },
      home,
      playwright: wrapped,
      options: { headless: true, attended: true, waitForSignIn: true, signInWaitSec: 8, readiness: { maxMs: 12_000 }, ...options },
      log: (line) => lines.push(String(line)),
      heartbeatMs: 60_000,
    });
    return { result, client, site, lines, launches: wrapped.launches, elapsedMs: Date.now() - started };
  } finally {
    await Promise.all(wrapped.contexts.map((c) => c.close().catch(() => {})));
    try {
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
    } catch {
      // A browser can hold a file a moment longer on Windows; the folder is in the temp directory.
    }
  }
}

const finalPaths = (out) => Object.fromEntries(out.client.calls.uploads.map((u) => [u.filename, u.evidence.finalUrl.replace(base, "")]));

const FOUR = () => [
  planShot("home.png", "home"),
  planShot("overview.png", "overview"),
  planShot("knowledge.png", "knowledge"),
  planShot("settings.png", "settings", { reveal: [{ action: "reveal", label: "Generative AI", required: true }] }),
];

test("real browser: with the agent address every screen is the right one, and nothing in the tenant is changed", { skip, timeout: 120_000 }, async () => {
  const out = await run({ shots: FOUR() });
  assert.equal(out.result.tally.captured, 4, out.lines.join("\n"));
  assert.deepEqual(finalPaths(out), {
    "home.png": "/home",
    "overview.png": `/bots/${FAKE_AGENT.id}/overview`,
    "knowledge.png": `/bots/${FAKE_AGENT.id}/knowledge`,
    "settings.png": `/bots/${FAKE_AGENT.id}/settings`,
  });
  assert.deepEqual(out.site.stats.writes, [], "no publish, no create, nothing");
  assert.equal(out.site.stats.appsNewVisits, 0, "the promo card that looks like the Knowledge item was never followed");
  assert.deepEqual(out.site.stats.blocked, [], "nothing reached an address outside the pretend tenant");
  const settings = out.client.calls.uploads.find((u) => u.filename === "settings.png").evidence;
  assert.ok(settings.routeSteps.some((s) => s.action === "reveal" && s.ok && s.label === "Generative AI"), "the Generative AI tab was selected, and the record says so");
  assert.match(out.lines.join("\n"), /Opened Copilot Studio, then your agent, then Settings, then selected Generative AI\./);
});

test("real browser: the same headline scenario works in the installed Microsoft Edge", { skip: !found.playwrightInstalled ? "Playwright is not installed" : !edge && "Microsoft Edge is not installed", timeout: 120_000 }, async () => {
  const out = await run({ shots: FOUR(), channel: "msedge", options: { browserKinds: ["edge"] } });
  assert.equal(out.result.tally.captured, 4, out.lines.join("\n"));
  assert.equal(out.launches[0].options.channel, "msedge");
  assert.deepEqual(out.site.stats.writes, []);
});

test("real browser: a product that ignores typed addresses is still reached through its own navigation", { skip, timeout: 120_000 }, async () => {
  const out = await run({ shots: [planShot("settings.png", "settings", { reveal: [{ action: "reveal", label: "Generative AI", required: true }] }), planShot("knowledge.png", "knowledge")], site: { directSections: false } });
  assert.equal(out.result.tally.captured, 2, out.lines.join("\n"));
  assert.deepEqual(finalPaths(out), { "settings.png": `/bots/${FAKE_AGENT.id}/settings`, "knowledge.png": `/bots/${FAKE_AGENT.id}/knowledge` });
  assert.equal(out.site.stats.appsNewVisits, 0);
});

test("real browser: a page that shows a skeleton, a bare spinner, and late text is photographed only when it is ready", { skip, timeout: 120_000 }, async () => {
  const out = await run({ shots: [planShot("overview.png", "overview")], site: { overviewBlankMs: 2500, lateTextMs: 600, defaultDelayMs: 900 } });
  assert.equal(out.result.tally.captured, 1, out.lines.join("\n"));
  const evidence = out.client.calls.uploads[0].evidence;
  assert.ok(evidence.visibleText.some((l) => l === "Instructions (saved)"), "the part of the page that fills in late had arrived");
});

test("real browser: an interrupted first navigation is retried", { skip, timeout: 120_000 }, async () => {
  // No environment address is known, so the first page opened is the product's start page.
  const out = await run({ shots: [planShot("home.png", "home")], env: {}, site: { abortFirstNavigation: true } });
  assert.equal(out.result.tally.captured, 1, out.lines.join("\n"));
  assert.equal(out.site.stats.aborted, 1);
  assert.match(out.lines.join("\n"), /The page did not open \(net::ERR_ABORTED\)\. Trying again/);
});

test("real browser: no address for an agent screen is explained once and the open browser is never sent to a wrong page", { skip, timeout: 120_000 }, async () => {
  const out = await run({ shots: FOUR(), env: {} });
  assert.equal(out.result.tally.captured, 1, "only the home page needs no agent");
  assert.equal(out.result.tally.skipped, 3);
  const status = Object.fromEntries(out.client.calls.progress.filter((p) => p.shot?.status === "skipped").map((p) => [p.shot.filename, p.shot.cause]));
  assert.deepEqual(status, { "overview.png": "no-agent", "knowledge.png": "no-agent", "settings.png": "no-agent" });
  assert.equal(out.site.stats.appsNewVisits, 0);
});

test("real browser: the agent can be opened by its name from the list, never the look-alike copy", { skip, timeout: 120_000 }, async () => {
  const out = await run({ shots: [planShot("overview.png", "overview"), planShot("settings.png", "settings")], env: {}, targets: { copilotStudioAgentName: FAKE_AGENT.name } });
  assert.equal(out.result.tally.captured, 2, out.lines.join("\n"));
  assert.ok(Object.values(finalPaths(out)).every((p) => p.includes(`/bots/${FAKE_AGENT.id}/`)));
  assert.deepEqual(out.site.stats.writes, [], "Create blank agent was never clicked");
});

test("real browser: closing the window mid-job pauses once with one message instead of failing every remaining shot", { skip, timeout: 120_000 }, async () => {
  const out = await run({ shots: [...FOUR(), planShot("a.png", "overview"), planShot("b.png", "overview")], closeAfter: 2 });
  assert.equal(out.result.tally.captured, 2);
  assert.equal(out.result.tally.paused, 4);
  assert.equal(out.result.tally.failed, 0);
  assert.equal(out.lines.filter((l) => /closed the browser window/.test(l)).length, 1);
  assert.equal(out.client.calls.completes[0].paused.reason, "browser-closed");
  assert.ok(out.elapsedMs < 60_000, "no waiting around for a window that is gone");
});

test("real browser: guided capture shows the toolbar, a person's click captures, and the toolbar is gone from the page and the picture", { skip, timeout: 120_000 }, async () => {
  const seen = [];
  const out = await run({
    shots: [planShot("test.png", "overview", { mode: "guided" }), planShot("dialog.png", "knowledge", { mode: "guided" }), planShot("skipme.png", "settings", { mode: "guided" })],
    options: {
      guidedWaitSec: 20,
      onGuidedWaiting: async ({ shot, page }) => {
        const bar = page.getByRole("button", { name: "Capture this screen", exact: true });
        await bar.waitFor({ state: "visible", timeout: 10_000 });
        seen.push(await page.getByRole("region", { name: "Screenshot helper" }).innerText());
        if (shot.filename === "test.png") {
          await page.getByRole("button", { name: "Test", exact: true }).click();
          await page.getByLabel("Type your message").fill("What is our policy?");
          await page.getByRole("button", { name: "Send", exact: true }).click();
          await bar.click();
        } else if (shot.filename === "dialog.png") {
          await page.getByRole("button", { name: "Add knowledge", exact: true }).click();
          await page.keyboard.press("Alt+Shift+C");
        } else {
          await page.getByRole("button", { name: "Skip", exact: true }).click();
        }
      },
    },
  });
  assert.equal(out.result.tally.captured, 2, out.lines.join("\n"));
  assert.equal(out.result.tally.skipped, 1);
  assert.ok(seen.every((text) => /Set the screen up\./.test(text) && /Alt\+Shift\+C/.test(text)), "the toolbar showed the plain instructions and the shortcut");
  const uploaded = out.client.calls.uploads.find((u) => u.filename === "test.png").evidence;
  assert.equal(uploaded.mode, "guided");
  assert.ok(!uploaded.visibleText.some((l) => /Capture this screen|Screenshot helper/.test(l)), "the toolbar was not in the page when the picture was taken");
  assert.ok(uploaded.visibleText.some((l) => /Here is an answer/.test(l)), "the screen the person set up is what was photographed");
  assert.deepEqual(out.site.stats.writes, [], "the person's test question is not a tenant change, and the companion changed nothing");
});

test("real browser: a screen waiting for a person who is not there is marked 'needs you' after one bounded wait", { skip, timeout: 120_000 }, async () => {
  const out = await run({ shots: [planShot("g1.png", "overview", { mode: "guided" }), planShot("g2.png", "knowledge", { mode: "guided" }), planShot("a.png", "home")], options: { guidedWaitSec: 1.5 } });
  assert.equal(out.result.tally.captured, 1, "the automatic shot ran first and was not held up");
  assert.equal(out.result.tally.needsYou, 2);
  assert.ok(out.elapsedMs < 60_000);
  assert.equal(out.lines.join("\n").match(/Nobody answered/g).length, 1);
});
