// Real-browser proof that the harness is a requirement the companion enforces and proves, never a guess from whatever page opened. A real Chromium
// drives the pretend Copilot Studio (fake-product-site.mjs, `harnessMode`): the default experience has the Build, Preview, Evaluate, and Monitor tabs,
// the classic experience (the Standard harness) has the side navigation, and the way in is the ellipsis in the lower left corner of the side bar,
// Open classic experience, and Skip feedback. The control names are the owner's words; whether a real tenant names them the same is NOT proven here.
// Each test skips itself when no browser is installed.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createCaptureSession, runCaptureShot } from "../capture-run.mjs";
import { harnessState } from "../harness-run.mjs";
import { detectBrowserAvailability, loadPlaywrightModule, verifyCapturedImageBuffer } from "../lab-runner.mjs";
import { sanitizeHarnessProof } from "../harness.mjs";
import { FAKE_AGENT, FAKE_ENV_ID, FAKE_HOSTS, createFakeProductSite } from "./fixtures/fake-product-site.mjs";

const found = await detectBrowserAvailability();
const playwright = found.playwrightInstalled ? await loadPlaywrightModule() : null;
const skip = !found.available && "Playwright with Chromium is not installed";

const OTHER_AGENT_ID = "9b2e7f10-41cd-4f0e-a3a7-2c8d5e6f7a22";
const addressOf = (id, section = "overview") => `https://${FAKE_HOSTS.studio}/environments/${FAKE_ENV_ID}/bots/${id}/${section}`;
const CLASSIC_AGENT = addressOf(FAKE_AGENT.id);
const COPILOT_AGENT = addressOf(OTHER_AGENT_ID);

const SCREENS = {
  home: { scope: "environment", paths: ["home"], label: "the Copilot Studio home page", path: ["Copilot Studio", "Home"] },
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

/** A real browser on the pretend site. `fn` gets helpers to run shots on one page and to start another browser session (a new page). */
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
      lines,
      dir,
      newPage: () => context.newPage(),
      session: (agentUrl = null) => createCaptureSession({ env: agentUrl ? { CAPTURE_COPILOT_STUDIO_AGENT_URL: agentUrl } : {}, landmarkMs: 3000, landmarkSettleMs: 150, promptMs: 1200, findMs: 4000, effectMs: 2500 }),
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

test("a Standard (Classic) picture starts with the switch (ellipsis, Open classic experience, Skip feedback), proves the classic landmarks, and carries only what was proven", { skip, timeout: 120_000 }, async () => {
  await withSite({ experienceDecides: true }, async (ctx) => {
    const page = await ctx.newPage();
    const session = ctx.session(CLASSIC_AGENT);
    const result = await ctx.shoot(page, session, planShot("agent-overview.classic.png", "overview", "standard"), { agentUrl: CLASSIC_AGENT });
    assert.equal(result.status, "captured", result.error);
    assert.equal(ctx.site.stats.classicClicks, 1, "Open classic experience was clicked once");
    assert.equal(ctx.site.stats.feedbackSkips, 1, "Skip feedback was clicked");
    assert.equal(ctx.site.stats.feedbackSubmits, 0, "feedback is never submitted");
    assert.ok(ctx.site.stats.menuOpens >= 1, "through the ellipsis menu");
    assert.match(ctx.site.stats.pages[0], /\/home$/, "the switch starts on the home page, before the agent is opened");
    assert.ok(ctx.site.stats.pages.findIndex((p) => /\/bots\//.test(p)) > 0, ctx.site.stats.pages.join(", "));
    assert.deepEqual(ctx.site.stats.dangers, [], "nothing the computer must never touch was touched");
    assert.deepEqual(ctx.site.stats.writes, [], "the switch changes no tenant data");
    // What the picture carries is what the page was proven to be in.
    assert.equal(result.harness.id, "standard");
    assert.equal(result.harness.proof, "landmarks");
    assert.equal(result.harness.wanted, "standard");
    assert.equal(result.harness.switched, true);
    assert.ok(result.harness.landmarks.includes("Overview") && result.harness.landmarks.includes("Knowledge"));
    assert.deepEqual(sanitizeHarnessProof(result.harness), result.harness, "the server reads the proof as it is");
    assert.equal(result.detail.harness.proven, "standard");
    assert.ok(saved(ctx, "agent-overview.classic.png"));
    const text = ctx.lines.join("\n");
    assert.match(text, /Switching to the classic experience: ellipsis in the lower left corner > Open classic experience > Skip feedback/);
    assert.match(text, /Proved the Standard \(Classic\) harness: Overview, Knowledge/);
  });
});

test("a page in the wrong harness after the switch attempt stops the shot as needs-you and the picture is never saved", { skip, timeout: 120_000 }, async () => {
  // The agent is a Microsoft Copilot harness agent, so the switch cannot make it a Standard one.
  await withSite({ experienceDecides: false }, async (ctx) => {
    const page = await ctx.newPage();
    const result = await ctx.shoot(page, ctx.session(COPILOT_AGENT), planShot("agent-overview.classic.png", "overview", "standard"), { agentUrl: COPILOT_AGENT });
    assert.equal(ctx.site.stats.classicClicks, 1, "the switch was made first");
    assert.deepEqual([result.status, result.cause], ["needs-you", "wrong-harness"]);
    assert.equal(result.error, "This agent is in the Microsoft Copilot harness; this picture needs the Standard (Classic) harness. Choose a Standard (Classic) agent, or let the computer create one.");
    assert.equal(result.harness, undefined, "no proof is sent for a picture that was refused");
    assert.ok(!saved(ctx, "agent-overview.classic.png"), "nothing was saved");
    assert.equal(result.detail.harness.found, "microsoft-copilot");
  });
});

test("a Microsoft Copilot picture never clicks the switch, and is proven by its tab strip", { skip, timeout: 120_000 }, async () => {
  await withSite({ experienceDecides: false }, async (ctx) => {
    const page = await ctx.newPage();
    const result = await ctx.shoot(page, ctx.session(COPILOT_AGENT), planShot("agent-overview.copilot.png", "overview", "microsoft-copilot"), { agentUrl: COPILOT_AGENT });
    assert.equal(result.status, "captured", result.error);
    assert.equal(ctx.site.stats.classicClicks, 0, "Open classic experience was never clicked");
    assert.equal(ctx.site.stats.menuOpens, 0, "the ellipsis menu was never opened for an agent page");
    assert.equal(result.harness.id, "microsoft-copilot");
    assert.equal(result.harness.switched, false);
    assert.deepEqual(result.harness.landmarks, ["Build", "Preview", "Evaluate", "Monitor"]);
  });
  // A Microsoft Copilot picture of an agent that is in the classic experience is refused, and nothing is clicked to fix it.
  await withSite({ experienceDecides: false }, async (ctx) => {
    const page = await ctx.newPage();
    const result = await ctx.shoot(page, ctx.session(CLASSIC_AGENT), planShot("agent-overview.copilot.png", "overview", "microsoft-copilot"), { agentUrl: CLASSIC_AGENT });
    assert.deepEqual([result.status, result.cause], ["needs-you", "wrong-harness"]);
    assert.match(result.error, /^This agent is in the Standard \(Classic\) harness; this picture needs the Microsoft Copilot harness\. Choose a Microsoft Copilot agent, or let the computer create one\.$/);
    assert.equal(ctx.site.stats.classicClicks, 0);
    assert.ok(!saved(ctx, "agent-overview.copilot.png"));
  });
});

test("the switch lasts for one browser session: it is made again in a new session, and the landmarks are proven again for every Classic picture", { skip, timeout: 180_000 }, async () => {
  await withSite({ experienceDecides: true }, async (ctx) => {
    const page = await ctx.newPage();
    const session = ctx.session(CLASSIC_AGENT);
    const first = await ctx.shoot(page, session, planShot("one.classic.png", "overview", "standard"), { agentUrl: CLASSIC_AGENT });
    assert.equal(first.status, "captured", first.error);
    const afterFirst = ctx.site.stats.classicClicks;
    assert.equal(afterFirst, 1);
    assert.equal(harnessState(session, page).classic, true, "this page remembers that it was switched");

    // Another picture in the same session: no second switch, the landmark is read again.
    const second = await ctx.shoot(page, session, planShot("two.classic.png", "overview", "standard"), { agentUrl: CLASSIC_AGENT });
    assert.equal(second.status, "captured", second.error);
    assert.equal(ctx.site.stats.classicClicks, afterFirst, "the switch is not repeated inside one session");
    assert.equal(second.harness.id, "standard");

    // The product forgets the switch (the page fell back): the landmark says so, and the switch is made again before the picture.
    ctx.site.endSession();
    const third = await ctx.shoot(page, session, planShot("three.classic.png", "overview", "standard"), { agentUrl: CLASSIC_AGENT });
    assert.equal(third.status, "captured", third.error);
    assert.equal(ctx.site.stats.classicClicks, afterFirst + 1, "the switch was redone when the page fell back");
    assert.equal(third.harness.id, "standard");

    // A new browser session (a new page, with its own memory) starts with the switch.
    ctx.site.endSession();
    const other = await ctx.newPage();
    const fourth = await ctx.shoot(other, session, planShot("four.classic.png", "overview", "standard"), { agentUrl: CLASSIC_AGENT });
    assert.equal(fourth.status, "captured", fourth.error);
    assert.equal(ctx.site.stats.classicClicks, afterFirst + 2, "a new session is switched again before anything is captured");
  });
});

test("a Microsoft Copilot picture after a Classic one goes back to the default experience first, and stops when it cannot get back", { skip, timeout: 180_000 }, async () => {
  await withSite({ experienceDecides: true }, async (ctx) => {
    const page = await ctx.newPage();
    const session = ctx.session(CLASSIC_AGENT);
    const classic = await ctx.shoot(page, session, planShot("a.classic.png", "overview", "standard"), { agentUrl: CLASSIC_AGENT });
    assert.equal(classic.status, "captured", classic.error);
    const roots = ctx.site.stats.rootVisits;
    const copilot = await ctx.shoot(page, session, planShot("b.copilot.png", "overview", "microsoft-copilot"), { agentUrl: CLASSIC_AGENT });
    assert.equal(copilot.status, "captured", copilot.error);
    assert.ok(ctx.site.stats.rootVisits > roots, "the default experience address was opened again");
    assert.equal(copilot.harness.id, "microsoft-copilot");
    assert.equal(ctx.site.stats.classicClicks, 1, "nothing else was clicked to change the experience");
  });
  await withSite({ experienceDecides: true, rootResetsExperience: false }, async (ctx) => {
    const page = await ctx.newPage();
    const session = ctx.session(CLASSIC_AGENT);
    assert.equal((await ctx.shoot(page, session, planShot("a.classic.png", "overview", "standard"), { agentUrl: CLASSIC_AGENT })).status, "captured");
    const copilot = await ctx.shoot(page, session, planShot("b.copilot.png", "overview", "microsoft-copilot"), { agentUrl: CLASSIC_AGENT });
    assert.deepEqual([copilot.status, copilot.cause], ["needs-you", "wrong-harness"]);
    assert.match(copilot.error, /^This agent is in the Standard \(Classic\) harness; this picture needs the Microsoft Copilot harness\. Choose a Microsoft Copilot agent, or let the computer create one\.$/);
    assert.ok(!saved(ctx, "b.copilot.png"));
  });
});

test("a screen outside any agent is proven by the side bar menu: Open classic experience is offered in the default experience and not once switched", { skip, timeout: 180_000 }, async () => {
  await withSite({}, async (ctx) => {
    const page = await ctx.newPage();
    const result = await ctx.shoot(page, ctx.session(), planShot("home.classic.png", "home", "standard"));
    assert.equal(result.status, "captured", result.error);
    assert.equal(ctx.site.stats.classicClicks, 1);
    assert.equal(result.harness.id, "standard");
    assert.equal(result.harness.switched, true);
    assert.deepEqual(result.harness.landmarks, ["Menu in the lower left corner", "No Open classic experience command"]);
  });
  await withSite({}, async (ctx) => {
    const page = await ctx.newPage();
    const result = await ctx.shoot(page, ctx.session(), planShot("home.copilot.png", "home", "microsoft-copilot"));
    assert.equal(result.status, "captured", result.error);
    assert.equal(ctx.site.stats.classicClicks, 0, "the menu was read, and the command was not clicked");
    assert.equal(result.harness.id, "microsoft-copilot");
    assert.deepEqual(result.harness.landmarks, ["Menu in the lower left corner", "Open classic experience offered"]);
  });
  // The command does nothing: the session stays in the default experience, and the Standard picture is refused.
  await withSite({ switchBroken: true }, async (ctx) => {
    const page = await ctx.newPage();
    const result = await ctx.shoot(page, ctx.session(), planShot("home.classic.png", "home", "standard"));
    assert.deepEqual([result.status, result.cause], ["needs-you", "wrong-harness"]);
    assert.ok(!saved(ctx, "home.classic.png"));
  });
});

test("a feedback prompt with only Submit stops the switch: feedback is never submitted", { skip, timeout: 120_000 }, async () => {
  await withSite({ feedback: "submit-only", experienceDecides: true }, async (ctx) => {
    const page = await ctx.newPage();
    const result = await ctx.shoot(page, ctx.session(CLASSIC_AGENT), planShot("agent-overview.classic.png", "overview", "standard"), { agentUrl: CLASSIC_AGENT });
    assert.deepEqual([result.status, result.cause], ["needs-you", "harness-switch-failed"]);
    assert.match(result.error, /no Skip feedback button/);
    assert.equal(ctx.site.stats.feedbackSubmits, 0, "Submit was never clicked");
    assert.equal(ctx.site.stats.feedbackSkips, 0);
    assert.ok(!saved(ctx, "agent-overview.classic.png"));
  });
  // No prompt at all is fine: it is only skipped when it is there.
  await withSite({ feedback: "none", experienceDecides: true }, async (ctx) => {
    const page = await ctx.newPage();
    const result = await ctx.shoot(page, ctx.session(CLASSIC_AGENT), planShot("agent-overview.classic.png", "overview", "standard"), { agentUrl: CLASSIC_AGENT });
    assert.equal(result.status, "captured", result.error);
    assert.equal(ctx.site.stats.feedbackSkips, 0);
  });
});

test("when the ellipsis menu is not there the switch stops with a plain reason and nothing else is clicked", { skip, timeout: 120_000 }, async () => {
  await withSite({ noExperienceMenu: true, experienceDecides: true }, async (ctx) => {
    const page = await ctx.newPage();
    const result = await ctx.shoot(page, ctx.session(CLASSIC_AGENT), planShot("agent-overview.classic.png", "overview", "standard"), { agentUrl: CLASSIC_AGENT });
    assert.deepEqual([result.status, result.cause], ["needs-you", "harness-switch-failed"]);
    assert.match(result.error, /could not find the ellipsis in the lower left corner/);
    assert.deepEqual(ctx.site.stats.dangers, []);
    assert.equal(ctx.site.stats.classicClicks, 0);
  });
});

test("a chosen agent in the wrong harness is refused by its Powered by cell before it is opened", { skip, timeout: 120_000 }, async () => {
  await withSite({ experienceDecides: false }, async (ctx) => {
    const page = await ctx.newPage();
    // The person chose the agent by name; the Agents list says it is powered by the Microsoft Copilot harness.
    const session = createCaptureSession({ env: {}, targets: { copilotStudioAgentName: "Energy Assistant (test copy)" }, landmarkMs: 3000, landmarkSettleMs: 150, promptMs: 1200, findMs: 4000, effectMs: 2500 });
    const result = await ctx.shoot(page, session, planShot("agent-overview.classic.png", "overview", "standard"));
    assert.deepEqual([result.status, result.cause], ["needs-you", "wrong-harness"]);
    assert.equal(result.error, "This agent is in the Microsoft Copilot harness; this picture needs the Standard (Classic) harness. Choose a Standard (Classic) agent, or let the computer create one.");
    assert.ok(!ctx.site.stats.pages.some((p) => p.includes(OTHER_AGENT_ID)), "the agent was not opened");
  });
});

test("a Standard picture of a chosen agent that really is Standard is taken", { skip, timeout: 120_000 }, async () => {
  await withSite({ experienceDecides: false }, async (ctx) => {
    const page = await ctx.newPage();
    const session = createCaptureSession({ env: {}, targets: { copilotStudioAgentName: "Energy Assistant" }, landmarkMs: 3000, landmarkSettleMs: 150, promptMs: 1200, findMs: 4000, effectMs: 2500 });
    const result = await ctx.shoot(page, session, planShot("agent-overview.classic.png", "overview", "standard"));
    assert.equal(result.status, "captured", result.error);
    assert.equal(result.harness.id, "standard");
  });
});
