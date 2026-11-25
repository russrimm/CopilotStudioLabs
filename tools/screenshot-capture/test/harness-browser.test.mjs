// Real-browser proof that the harness is a requirement the companion enforces and proves, never a guess from whatever page opened. A real headless Chromium
// drives the pretend Copilot Studio (fake-product-site.mjs, `harnessMode`), which behaves the way a real tenant did when it was looked at on 2026-11-24:
//   - the default address (copilotstudio.microsoft.com) is the Microsoft Copilot experience, and a Microsoft Copilot agent has the Build, Preview, Evaluate,
//     and Monitor tabs (at /agents/<id>);
//   - the "More options" button in the lower left corner opens a menu that is the SAME in every experience (it always offers Open classic experience);
//   - Open classic experience shows a feedback prompt (Skip feedback), and then opens the classic experience in a NEW TAB on copilotstudio.preview.microsoft.com;
//   - a Standard agent lives on the preview host (/bots/<id>/overview) with a tab strip (Overview, Knowledge, Tools, Agents, Topics, Activity, Evaluation), and
//     opening one on the default host redirects to it in the same tab;
//   - the Agents list is a table with an "Agent harness" column and an "Open <name>" button in each row.
// Each test skips itself when no browser is installed. Whether a real tenant keeps behaving this way is checked by hand (see the README).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createCaptureSession, runCaptureShot } from "../capture-run.mjs";
import { classicPageOf, harnessState } from "../harness-run.mjs";
import { detectBrowserAvailability, loadPlaywrightModule, verifyCapturedImageBuffer } from "../lab-runner.mjs";
import { sanitizeHarnessProof, sanitizeHarnessReached } from "../harness.mjs";
import { FAKE_AGENT, FAKE_ENV_ID, FAKE_HOSTS, createFakeProductSite } from "./fixtures/fake-product-site.mjs";

const found = await detectBrowserAvailability();
const playwright = found.playwrightInstalled ? await loadPlaywrightModule() : null;
const skip = !found.available && "Playwright with Chromium is not installed";

const OTHER_AGENT_ID = "9b2e7f10-41cd-4f0e-a3a7-2c8d5e6f7a22";
const DEFAULT_HOST = FAKE_HOSTS.studio;
const PREVIEW_HOST = FAKE_HOSTS.previewStudio;
const STANDARD_ADDRESS = `https://${DEFAULT_HOST}/environments/${FAKE_ENV_ID}/bots/${FAKE_AGENT.id}/overview`;
const COPILOT_ADDRESS = `https://${DEFAULT_HOST}/environments/${FAKE_ENV_ID}/agents/${OTHER_AGENT_ID}`;
const STANDARD_NAME = "Energy Assistant";
const COPILOT_NAME = "Energy Assistant (test copy)";

const SCREENS = {
  home: { scope: "environment", paths: ["home"], label: "the Copilot Studio home page", path: ["Copilot Studio", "Home"] },
  agents: { scope: "environment", paths: ["agents"], label: "the list of agents", path: ["Copilot Studio", "Agents"] },
  overview: { scope: "agent", paths: ["overview"], label: "the agent's Overview page", path: ["Copilot Studio", "your agent", "Overview"] },
};

/** A plan shot the way the portal builds it, with the harness the picture needs. */
function planShot(filename, screenId, harness, extra = {}) {
  const screen = SCREENS[screenId];
  return {
    filename,
    moduleTitle: "Module",
    product: "copilot-studio",
    harness,
    viewport: { width: 1280, height: 720 },
    callouts: [],
    capture: {
      version: 1,
      mode: "auto",
      why: "",
      needs: screen.scope === "agent" ? ["copilot-studio-agent"] : [],
      missing: [],
      ready: true,
      route: { kind: "copilot-studio", screen: screenId, scope: screen.scope },
      screen: { id: screenId, label: screen.label },
      path: screen.path,
      expect: { family: "copilot-studio", scope: screen.scope, paths: screen.paths, label: screen.label, strict: true },
      reveal: [],
      landmarks: [],
      guide: ["Set the screen up.", "Press Capture this screen."],
    },
    ...extra,
  };
}

const gateOk = () => ({ failed: null, async ensureSignedIn() { return { ok: true }; } });
const real = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const KNOBS = { landmarkMs: 3000, landmarkSettleMs: 150, promptMs: 1200, findMs: 4000, effectMs: 2500, switchWaitMs: 4000, switchTabMs: 6000 };

/** A real browser on the pretend site. `fn` gets helpers to run shots on one page and to open another one. */
async function withSite(options, fn) {
  const site = createFakeProductSite({ harnessMode: true, defaultDelayMs: 40, chatDelayMs: 80, chatStreamMs: 80, ...options });
  const browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await site.attach(context);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-browser-"));
  const lines = [];
  try {
    await fn({
      site,
      context,
      lines,
      dir,
      newPage: () => context.newPage(),
      pages: () => context.pages().filter((p) => !p.isClosed()),
      session: ({ agentUrl = null, name = null, ...rest } = {}) => createCaptureSession({ env: agentUrl ? { CAPTURE_COPILOT_STUDIO_AGENT_URL: agentUrl } : {}, targets: name ? { copilotStudioAgentName: name } : {}, ...KNOBS, ...rest }),
      shoot: async (page, session, shot, { mode = "auto", agentUrl = null } = {}) =>
        runCaptureShot({
          page,
          shot,
          session,
          effectiveMode: mode,
          env: agentUrl ? { CAPTURE_COPILOT_STUDIO_AGENT_URL: agentUrl } : {},
          gate: gateOk(),
          assetsDir: path.join(dir, "a"),
          screenshotsDir: path.join(dir, "s"),
          sleep: real,
          log: (line) => lines.push(String(line)),
          verifyBuffer: verifyCapturedImageBuffer,
          readiness: { maxMs: 3000 },
        }),
    });
  } finally {
    await browser.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const saved = (ctx, filename) => fs.existsSync(path.join(ctx.dir, "a", filename));
/** Choose another agent by name for the next picture of the same job (the agent a job opened is remembered, as it must be, until it says otherwise). */
const pick = (session, name) => {
  session.values = { ...session.values, copilotStudioAgentName: name };
  session.cs.agentBase = null;
  session.cs.agentSource = null;
};

test("THE REAL FAILURE: Open classic experience opens a NEW TAB, and the Standard picture is taken in that tab, not in the old one", { skip, timeout: 120_000 }, async () => {
  await withSite({}, async (ctx) => {
    const first = await ctx.newPage();
    const session = ctx.session({ agentUrl: STANDARD_ADDRESS });
    const result = await ctx.shoot(first, session, planShot("agent-overview.classic.png", "overview", "standard"), { agentUrl: STANDARD_ADDRESS });
    assert.equal(result.status, "captured", result.error);
    // The click path: the ellipsis menu, Open classic experience, Skip feedback (never Submit), then the new tab.
    assert.equal(ctx.site.stats.classicClicks, 1, "Open classic experience was clicked once");
    assert.ok(ctx.site.stats.menuOpens >= 1, "through the More options menu");
    assert.equal(ctx.site.stats.feedbackSkips, 1, "Skip feedback was clicked");
    assert.equal(ctx.site.stats.feedbackSubmits, 0, "feedback is never submitted");
    assert.equal(ctx.site.stats.popups, 1, "the product opened the classic experience in a new tab");
    assert.equal(ctx.pages().length, 2, "two tabs are open");
    // The first tab stayed on the default address; the picture was taken in the second one, on the preview host.
    assert.ok(first.url().startsWith(`https://${DEFAULT_HOST}/`), `the first tab stays on the default address (${first.url()})`);
    const classic = classicPageOf(session);
    assert.ok(classic && classic !== first, "the new tab is the page the shot was taken in");
    assert.ok(classic.url().startsWith(`https://${PREVIEW_HOST}/environments/${FAKE_ENV_ID}/bots/${FAKE_AGENT.id}/`), classic.url());
    assert.ok(result.finalUrl.startsWith(`https://${PREVIEW_HOST}/`), result.finalUrl);
    assert.equal(ctx.site.stats.pages[0], `${DEFAULT_HOST}/environments/${FAKE_ENV_ID}/home`, "the switch starts on the default address's home page");
    assert.deepEqual(ctx.site.stats.dangers, [], "nothing the computer must never touch was touched");
    assert.deepEqual(ctx.site.stats.writes, [], "the switch changes no tenant data");
    // What the picture carries is what the page was proven to be in, where it was, and how it was reached.
    assert.equal(result.harness.id, "standard");
    assert.equal(result.harness.proof, "landmarks");
    assert.equal(result.harness.wanted, "standard");
    assert.equal(result.harness.switched, true);
    assert.equal(result.harness.host, PREVIEW_HOST);
    assert.equal(result.harness.via, "click-path");
    assert.ok(result.harness.landmarks.includes("Overview") && result.harness.landmarks.includes("Knowledge"), result.harness.landmarks.join(", "));
    assert.deepEqual(sanitizeHarnessProof(result.harness), result.harness, "the server reads the proof as it is");
    assert.ok(saved(ctx, "agent-overview.classic.png"));
    const text = ctx.lines.join("\n");
    assert.match(text, /Switching to the classic experience: ellipsis in the lower left corner > Open classic experience > Skip feedback/);
    assert.match(text, /The classic experience is open in a new tab \(copilotstudio\.preview\.microsoft\.com\), reached by the click path/);
    assert.match(text, /Proved the Standard \(Classic\) harness: Overview, Knowledge/);
  });
});

test("a Standard picture of an agent chosen by name opens it from the Agents list by its Open button, in the new tab, on the preview host", { skip, timeout: 120_000 }, async () => {
  await withSite({}, async (ctx) => {
    const first = await ctx.newPage();
    const session = ctx.session({ name: STANDARD_NAME });
    const result = await ctx.shoot(first, session, planShot("agent-overview.classic.png", "overview", "standard"));
    assert.equal(result.status, "captured", result.error);
    assert.equal(result.harness.id, "standard");
    assert.equal(result.harness.host, PREVIEW_HOST);
    const visited = ctx.site.stats.pages;
    assert.ok(visited.some((p) => p === `${PREVIEW_HOST}/environments/${FAKE_ENV_ID}/agents`), `the Agents list was opened on the preview host: ${visited.join(", ")}`);
    assert.ok(visited.some((p) => p.startsWith(`${PREVIEW_HOST}/environments/${FAKE_ENV_ID}/bots/${FAKE_AGENT.id}`)), "the Standard agent opened under /bots/<id> on the preview host");
    assert.deepEqual(ctx.site.stats.dangers, [], "the Open button of the row was used, and nothing in the top bar or the row's More actions");
  });
});

test("a Microsoft Copilot picture never switches, uses the default address, is proven by its tab strip, and carries the host it was on", { skip, timeout: 120_000 }, async () => {
  await withSite({}, async (ctx) => {
    const page = await ctx.newPage();
    const result = await ctx.shoot(page, ctx.session({ name: COPILOT_NAME }), planShot("agent-overview.copilot.png", "overview", "microsoft-copilot"));
    assert.equal(result.status, "captured", result.error);
    assert.equal(ctx.site.stats.classicClicks, 0, "Open classic experience was never clicked");
    assert.equal(ctx.site.stats.menuOpens, 0, "the More options menu was never opened for an agent page");
    assert.equal(ctx.site.stats.popups, 0);
    assert.equal(ctx.pages().length, 1, "no second tab");
    assert.equal(result.harness.id, "microsoft-copilot");
    assert.equal(result.harness.switched, false);
    assert.deepEqual(result.harness.landmarks, ["Build", "Preview", "Evaluate", "Monitor"]);
    assert.equal(result.harness.host, DEFAULT_HOST);
    assert.equal(result.harness.via, "default-address");
    assert.ok(ctx.site.stats.pages.some((p) => p.startsWith(`${DEFAULT_HOST}/environments/${FAKE_ENV_ID}/agents/${OTHER_AGENT_ID}`)), ctx.site.stats.pages.join(", "));
  });
});

test("an agent chosen by name is refused by its Agent harness cell before it is opened, in both directions, with how to fix it", { skip, timeout: 120_000 }, async () => {
  // A Microsoft Copilot agent for a Standard picture.
  await withSite({}, async (ctx) => {
    const page = await ctx.newPage();
    const result = await ctx.shoot(page, ctx.session({ name: COPILOT_NAME }), planShot("agent-overview.classic.png", "overview", "standard"));
    assert.deepEqual([result.status, result.cause], ["needs-you", "wrong-harness"]);
    assert.equal(result.error, "This agent is in the Microsoft Copilot harness; this picture needs the Standard (Classic) harness. Choose a Standard (Classic) agent, or let the computer create one.");
    assert.equal(result.detail.harness.via, "agent-harness-column");
    assert.ok(!ctx.site.stats.pages.some((p) => p.includes(OTHER_AGENT_ID)), "the agent was not opened");
    assert.ok(!saved(ctx, "agent-overview.classic.png"));
  });
  // A Standard agent for a Microsoft Copilot picture: nothing is switched, and the agent is not opened.
  await withSite({}, async (ctx) => {
    const page = await ctx.newPage();
    const result = await ctx.shoot(page, ctx.session({ name: STANDARD_NAME }), planShot("agent-overview.copilot.png", "overview", "microsoft-copilot"));
    assert.deepEqual([result.status, result.cause], ["needs-you", "wrong-harness"]);
    assert.equal(result.error, "This agent is in the Standard (Classic) harness; this picture needs the Microsoft Copilot harness. Choose a Microsoft Copilot agent, or let the computer create one.");
    assert.ok(!ctx.site.stats.pages.some((p) => p.includes(`/bots/${FAKE_AGENT.id}`)), "the Standard agent was not opened");
    assert.equal(ctx.site.stats.classicClicks, 0);
    assert.ok(!saved(ctx, "agent-overview.copilot.png"));
  });
});

test("an agent given by address is proven by the page: a Microsoft Copilot agent is refused for a Standard picture, and a Standard one (the default address redirects to the preview host) for a Microsoft Copilot picture", { skip, timeout: 120_000 }, async () => {
  await withSite({}, async (ctx) => {
    const page = await ctx.newPage();
    const result = await ctx.shoot(page, ctx.session({ agentUrl: COPILOT_ADDRESS }), planShot("agent-overview.classic.png", "overview", "standard"), { agentUrl: COPILOT_ADDRESS });
    assert.equal(ctx.site.stats.classicClicks, 1, "the switch was made first");
    assert.deepEqual([result.status, result.cause], ["needs-you", "wrong-harness"]);
    assert.equal(result.error, "This agent is in the Microsoft Copilot harness; this picture needs the Standard (Classic) harness. Choose a Standard (Classic) agent, or let the computer create one.");
    assert.equal(result.harness, undefined, "no proof is sent for a picture that was refused");
    assert.ok(!saved(ctx, "agent-overview.classic.png"), "nothing was saved");
  });
  await withSite({}, async (ctx) => {
    const page = await ctx.newPage();
    const result = await ctx.shoot(page, ctx.session({ agentUrl: STANDARD_ADDRESS }), planShot("agent-overview.copilot.png", "overview", "microsoft-copilot"), { agentUrl: STANDARD_ADDRESS });
    assert.deepEqual([result.status, result.cause], ["needs-you", "wrong-harness"]);
    assert.match(result.error, /^This agent is in the Standard \(Classic\) harness; this picture needs the Microsoft Copilot harness\. Choose a Microsoft Copilot agent, or let the computer create one\.$/);
    assert.ok(ctx.site.stats.redirects >= 1, "the default address sent the Standard agent to the preview host in the same tab");
    assert.equal(ctx.site.stats.classicClicks, 0, "nothing was clicked to change the experience");
    assert.ok(!saved(ctx, "agent-overview.copilot.png"));
  });
});

test("the classic tab is reused for later Standard pictures, closed before a Microsoft Copilot picture, and opened again by the next Standard one", { skip, timeout: 240_000 }, async () => {
  await withSite({}, async (ctx) => {
    const first = await ctx.newPage();
    const session = ctx.session({ name: STANDARD_NAME });
    const one = await ctx.shoot(first, session, planShot("one.classic.png", "overview", "standard"));
    assert.equal(one.status, "captured", one.error);
    const classicOne = classicPageOf(session);
    assert.equal(ctx.site.stats.popups, 1);
    assert.equal(harnessState(session, classicOne).classic, true, "the classic tab remembers that it was switched");

    // Another Standard picture in the same job: no second click, the same tab, the landmarks are read again.
    const two = await ctx.shoot(first, session, planShot("two.classic.png", "overview", "standard"));
    assert.equal(two.status, "captured", two.error);
    assert.equal(ctx.site.stats.popups, 1, "the switch is not repeated");
    assert.equal(ctx.site.stats.classicClicks, 1);
    assert.equal(classicPageOf(session), classicOne);
    assert.equal(ctx.pages().length, 2);
    assert.equal(two.harness.id, "standard");

    // A Microsoft Copilot picture: the extra tab is closed, the first tab (on the default address) is used, and nothing is clicked.
    pick(session, COPILOT_NAME);
    const three = await ctx.shoot(first, session, planShot("three.copilot.png", "overview", "microsoft-copilot"));
    assert.equal(three.status, "captured", three.error);
    assert.equal(ctx.pages().length, 1, "the classic tab was closed when it was no longer needed");
    assert.ok(classicOne.isClosed());
    assert.equal(classicPageOf(session), null);
    assert.equal(three.harness.id, "microsoft-copilot");
    assert.equal(three.harness.host, DEFAULT_HOST);
    assert.equal(ctx.site.stats.classicClicks, 1, "going back to the default experience clicked nothing in the classic one");
    assert.match(ctx.lines.join("\n"), /Closed the classic tab/);

    // The next Standard picture opens the classic experience again, in a new tab.
    pick(session, STANDARD_NAME);
    const four = await ctx.shoot(first, session, planShot("four.classic.png", "overview", "standard"));
    assert.equal(four.status, "captured", four.error);
    assert.equal(ctx.site.stats.classicClicks, 2);
    assert.equal(ctx.site.stats.popups, 2);
    assert.equal(ctx.pages().length, 2);
    assert.equal(four.harness.id, "standard");
  });
});

test("a switch that moves the same tab to the preview host is followed too, and a click that opens nothing falls back to the preview address in a new tab, recorded as the way used", { skip, timeout: 180_000 }, async () => {
  await withSite({ classicOpens: "same-tab" }, async (ctx) => {
    const first = await ctx.newPage();
    const session = ctx.session({ name: STANDARD_NAME });
    const result = await ctx.shoot(first, session, planShot("same.classic.png", "overview", "standard"));
    assert.equal(result.status, "captured", result.error);
    assert.equal(ctx.pages().length, 1, "no second tab was needed");
    assert.equal(classicPageOf(session), first, "the first tab is the classic page");
    assert.equal(result.harness.via, "click-path");
    assert.equal(result.harness.host, PREVIEW_HOST);
    // A Microsoft Copilot picture then goes back to the default address in that same tab.
    pick(session, COPILOT_NAME);
    const back = await ctx.shoot(first, session, planShot("back.copilot.png", "overview", "microsoft-copilot"));
    assert.equal(back.status, "captured", back.error);
    assert.ok(first.url().startsWith(`https://${DEFAULT_HOST}/`), first.url());
    assert.equal(back.harness.host, DEFAULT_HOST);
  });
  await withSite({ classicOpens: "none" }, async (ctx) => {
    const first = await ctx.newPage();
    const session = ctx.session({ name: STANDARD_NAME, switchTabMs: 800 });
    const result = await ctx.shoot(first, session, planShot("direct.classic.png", "overview", "standard"));
    assert.equal(result.status, "captured", result.error);
    assert.equal(ctx.site.stats.classicClicks, 1, "the click path was tried first");
    assert.equal(ctx.site.stats.popups, 0, "and it opened nothing");
    assert.equal(ctx.pages().length, 2, "the preview address was opened in a new tab");
    assert.equal(result.harness.via, "preview-address", "the proof records the way used");
    assert.equal(result.harness.host, PREVIEW_HOST);
    assert.match(ctx.lines.join("\n"), /The click did not open the classic experience, so the computer opens its address directly \(copilotstudio\.preview\.microsoft\.com\)/);
  });
});

test("a screen outside any agent is never proven by what it shows: it is taken on the host that matches the harness and stamped with the host and how it was reached", { skip, timeout: 180_000 }, async () => {
  await withSite({}, async (ctx) => {
    const page = await ctx.newPage();
    const session = ctx.session();
    const result = await ctx.shoot(page, session, planShot("home.classic.png", "home", "standard"));
    assert.equal(result.status, "captured", result.error);
    assert.equal(ctx.site.stats.classicClicks, 1, "the switch was made once, by the click path");
    assert.equal(result.harness, null, "no proof: the menu is the same in every experience, so nothing on this screen proves the harness");
    assert.deepEqual(result.harnessReached, { version: 2, id: "standard", scope: "environment", host: PREVIEW_HOST, via: "click-path", proven: false });
    assert.deepEqual(sanitizeHarnessReached(result.harnessReached), result.harnessReached);
    assert.equal(result.detail.harness.notProvenByContent, true);
    assert.ok(result.finalUrl.startsWith(`https://${PREVIEW_HOST}/`), "the Standard lab's Home is taken on the preview host");
    assert.match(ctx.lines.join("\n"), /cannot prove the harness\. It was taken on copilotstudio\.preview\.microsoft\.com/);
  });
  await withSite({}, async (ctx) => {
    const page = await ctx.newPage();
    const result = await ctx.shoot(page, ctx.session(), planShot("agents.copilot.png", "agents", "microsoft-copilot"));
    assert.equal(result.status, "captured", result.error);
    assert.equal(ctx.site.stats.classicClicks, 0);
    assert.equal(ctx.site.stats.menuOpens, 0, "the menu is not opened to find out what experience this is: it would tell nothing");
    assert.equal(result.harness, null);
    assert.deepEqual(result.harnessReached, { version: 2, id: "microsoft-copilot", scope: "environment", host: DEFAULT_HOST, via: "default-address", proven: false });
    assert.ok(result.finalUrl.startsWith(`https://${DEFAULT_HOST}/`));
  });
});

test("a feedback prompt with only Submit stops the switch (feedback is never submitted), and no prompt at all is fine", { skip, timeout: 120_000 }, async () => {
  await withSite({ feedback: "submit-only" }, async (ctx) => {
    const page = await ctx.newPage();
    const result = await ctx.shoot(page, ctx.session({ name: STANDARD_NAME }), planShot("agent-overview.classic.png", "overview", "standard"));
    assert.deepEqual([result.status, result.cause], ["needs-you", "harness-switch-failed"]);
    assert.match(result.error, /no Skip feedback button/);
    assert.equal(ctx.site.stats.feedbackSubmits, 0, "Submit was never clicked");
    assert.equal(ctx.site.stats.feedbackSkips, 0);
    assert.equal(ctx.site.stats.popups, 0);
    assert.ok(!saved(ctx, "agent-overview.classic.png"));
  });
  await withSite({ feedback: "none" }, async (ctx) => {
    const page = await ctx.newPage();
    const result = await ctx.shoot(page, ctx.session({ name: STANDARD_NAME }), planShot("agent-overview.classic.png", "overview", "standard"));
    assert.equal(result.status, "captured", result.error);
    assert.equal(ctx.site.stats.feedbackSkips, 0, "it is only skipped when it is there");
    assert.equal(ctx.site.stats.popups, 1);
  });
});

test("when the More options menu is not there the preview address is the way in, recorded as such; when that does not work either the switch stops with a plain reason", { skip, timeout: 120_000 }, async () => {
  await withSite({ noExperienceMenu: true }, async (ctx) => {
    const page = await ctx.newPage();
    const result = await ctx.shoot(page, ctx.session({ name: STANDARD_NAME, switchWaitMs: 600 }), planShot("agent-overview.classic.png", "overview", "standard"));
    assert.equal(result.status, "captured", result.error);
    assert.equal(result.harness.via, "preview-address", "the proof records that the click path was not available");
    assert.equal(result.harness.host, PREVIEW_HOST);
    assert.deepEqual(ctx.site.stats.dangers, []);
    assert.equal(ctx.site.stats.classicClicks, 0, "there was no menu to click");
    assert.equal(ctx.pages().length, 2, "the preview address was opened in a new tab");
  });
  await withSite({ noExperienceMenu: true, previewUnavailable: true }, async (ctx) => {
    const page = await ctx.newPage();
    const result = await ctx.shoot(page, ctx.session({ name: STANDARD_NAME, switchWaitMs: 600 }), planShot("agent-overview.classic.png", "overview", "standard"));
    assert.deepEqual([result.status, result.cause], ["needs-you", "harness-switch-failed"]);
    assert.match(result.error, /neither the click path nor the address copilotstudio\.preview\.microsoft\.com led to a classic page/);
    assert.deepEqual(ctx.site.stats.dangers, []);
    assert.equal(ctx.site.stats.classicClicks, 0);
    assert.equal(ctx.pages().length, 1, "the extra tab was closed again");
    assert.ok(!saved(ctx, "agent-overview.classic.png"));
  });
});

test("the Standard tab strip is read by accessible name whether or not the product repeats each label in its text (OverviewOverview)", { skip, timeout: 120_000 }, async () => {
  for (const doubledTabText of [true, false]) {
    await withSite({ doubledTabText }, async (ctx) => {
      const page = await ctx.newPage();
      const result = await ctx.shoot(page, ctx.session({ agentUrl: STANDARD_ADDRESS }), planShot("agent-overview.classic.png", "overview", "standard"), { agentUrl: STANDARD_ADDRESS });
      assert.equal(result.status, "captured", `doubledTabText=${doubledTabText}: ${result.error}`);
      assert.deepEqual(result.harness.landmarks.slice(0, 3), ["Overview", "Knowledge", "Tools"]);
    });
  }
});
