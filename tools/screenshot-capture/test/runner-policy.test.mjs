// Hermetic tests for how a shot is captured: the page-ready check, browser lifecycle helpers, the control match
// policy, and a whole shot from its plan (open the product, learn the environment, open the agent, reach the screen,
// stop with a reason when something required cannot be done, and the guided toolbar).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createCaptureSession, runCaptureShot } from "../capture-run.mjs";
import { BrowserClosedError, classifyBrowserError, ensureLivePage, gotoWithRetry, watchContext } from "../lifecycle.mjs";
import { findControls, openNavigationItem, revealLabel } from "../locator.mjs";
import { readinessBudgets, waitUntilReady } from "../readiness.mjs";
import { verifyCapturedImageBuffer } from "../lab-runner.mjs";
import { createTrace } from "../trace.mjs";
import { createFakeApp } from "./fixtures/fake-app-page.mjs";

const instant = async () => {};
const ENV = "6b988893-6c74-4e65-9d9a-f7f044be1d08";
const BOT = "0f6c2d9a-3a54-4a64-8c61-5b1d7a2e9c11";
const base = `https://copilotstudio.microsoft.com/environments/${ENV}`;
const agent = `${base}/bots/${BOT}`;

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-policy-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// ── Page ready ───────────────────────────────────────────────────────────────

test("a page is ready only when it has loaded, shows no loading indicator, has been still, and two pictures match", async () => {
  const app = createFakeApp({ screens: { "https://x.test/a": { text: ["Hi"], controls: [], busy: 3 } } });
  await app.page.goto("https://x.test/a");
  const trace = createTrace({ file: null });
  const result = await waitUntilReady(app.page, { budgets: readinessBudgets({ maxMs: 20_000 }), sleep: instant, trace, shot: "a.png" });
  assert.equal(result.ready, true);
  assert.ok(result.waitedMs >= 750, "it waited for the three loading indicators to go away");
  const event = JSON.parse(trace.lines.find((l) => l.includes("ready-wait")));
  assert.deepEqual([event.ready, event.framesStable, event.indicatorsVisible], [true, true, 0]);
  assert.equal(event.maxMs, 20_000, "the budget used is in the trace");

  const stuck = createFakeApp({ screens: { "https://x.test/a": { text: [], controls: [], busy: 1_000_000 } } });
  await stuck.page.goto("https://x.test/a");
  const gaveUp = await waitUntilReady(stuck.page, { budgets: readinessBudgets({ maxMs: 3000 }), sleep: instant });
  assert.equal(gaveUp.ready, false, "a page that never finishes is photographed anyway, but not called ready");
  assert.ok(gaveUp.busy > 0 && gaveUp.waitedMs >= 3000);
});

test("readiness budgets are configurable and a retry waits longer", () => {
  assert.equal(readinessBudgets({}).maxMs, 20_000);
  assert.equal(readinessBudgets({ maxMs: 5000, quietMs: 100 }).maxMs, 5000);
  assert.equal(readinessBudgets({ maxMs: 5000 }, 2).maxMs, 10_000);
  assert.ok(readinessBudgets({}, 2).quietMs > readinessBudgets({}, 1).quietMs);
  assert.equal(readinessBudgets({ maxMs: "x" }).maxMs, 20_000, "nonsense falls back to the default");
});

test("a page that unsteadily changes between pictures is not ready until two match", async () => {
  const app = createFakeApp({ screens: { "https://x.test/a": { text: [], controls: [] } } });
  await app.page.goto("https://x.test/a");
  let n = 0;
  const real = app.page.screenshot;
  app.page.screenshot = async (o) => (o?.type === "jpeg" ? Buffer.from(`frame ${n++ < 3 ? n : "same"}`) : real(o));
  const result = await waitUntilReady(app.page, { budgets: readinessBudgets({ maxMs: 30_000 }), sleep: instant });
  assert.equal(result.ready, true);
  assert.ok(n >= 4, "it kept looking until two frames in a row were identical");
});

// ── Lifecycle ────────────────────────────────────────────────────────────────

test("browser errors are told apart", () => {
  assert.equal(classifyBrowserError(new Error("page.goto: Target page, context or browser has been closed")), "browser-closed");
  assert.equal(classifyBrowserError(new Error("page.screenshot: Target closed")), "browser-closed");
  assert.equal(classifyBrowserError(new Error("Page crashed")), "page-crashed");
  assert.equal(classifyBrowserError(new Error("page.goto: net::ERR_ABORTED at https://copilotstudio.microsoft.com/")), "transient");
  assert.equal(classifyBrowserError(new Error("page.goto: Timeout 30000ms exceeded.")), "transient");
  assert.equal(classifyBrowserError(new Error("something else")), "other");
});

test("an interrupted navigation is retried with a pause, a closed browser never is", async () => {
  const sleeps = [];
  const sleep = async (ms) => sleeps.push(ms);
  const flaky = createFakeApp({ screens: {}, gotoFailure: (_u, attempt) => (attempt < 2 ? new Error("page.goto: net::ERR_ABORTED") : null) });
  await gotoWithRetry(flaky.page, "https://x.test/", { sleep });
  assert.deepEqual([flaky.log.goto.length, sleeps], [3, [1000, 3000]], "two retries, with a growing pause");

  const dead = createFakeApp({ screens: {}, gotoFailure: () => new Error("page.goto: net::ERR_ABORTED") });
  await assert.rejects(gotoWithRetry(dead.page, "https://x.test/", { sleep: instant }), /ERR_ABORTED/);
  assert.equal(dead.log.goto.length, 3, "it gives up after two retries");

  const closed = createFakeApp({ screens: {}, gotoFailure: () => new Error("page.goto: Target page, context or browser has been closed") });
  await assert.rejects(gotoWithRetry(closed.page, "https://x.test/", { sleep: instant }), BrowserClosedError);
  assert.equal(closed.log.goto.length, 1, "no retry for a window that is gone");

  const landed = createFakeApp({ screens: {}, gotoFailure: () => Object.assign(new Error("net::ERR_ABORTED"), {}) });
  landed.state.current = "https://x.test/start";
  await gotoWithRetry(landed.page, "https://x.test/start", { sleep: instant });
  assert.equal(landed.log.goto.length, 1, "an interrupted navigation that already landed counts as done");
});

test("a closed or crashed tab is replaced by a new one, and a closed browser is reported", async () => {
  const app = createFakeApp({ screens: {} });
  const watcher = watchContext({ on: () => {} });
  assert.equal(await ensureLivePage(app.context, app.page, { watcher }), app.page, "a healthy tab is kept");
  app.close();
  await ensureLivePage(app.context, app.page, { watcher });
  assert.equal(app.log.newPages, 1, "a closed tab is replaced");
  const closedContext = { newPage: async () => { throw new Error("browser.newPage: Target page, context or browser has been closed"); } };
  await assert.rejects(ensureLivePage(closedContext, { isClosed: () => true }, { watcher }), BrowserClosedError);
});

// ── Control match policy ─────────────────────────────────────────────────────

const settingsApp = () =>
  createFakeApp({
    screens: {
      [`${agent}/overview`]: {
        text: ["Overview", "Instructions"],
        controls: [
          { role: "link", name: "Overview", region: "nav", selected: true },
          { role: "link", name: "Settings", region: "nav", goto: `${agent}/settings` },
          { role: "link", name: "Knowledge", region: "main", goto: `${base}/apps/new` },
          { role: "link", name: "Knowledge", region: "nav", goto: `${agent}/knowledge` },
          { role: "link", name: "Knowledge base", region: "nav", goto: `${base}/apps/new` },
          { role: "button", name: "Publish", region: "header" },
          { role: "button", name: "Publish", region: "nav" },
        ],
      },
      [`${agent}/settings`]: {
        text: ["Settings", "General"],
        controls: [
          { role: "tab", name: "General", region: "nav", selected: true },
          { role: "tab", name: "Generative AI", region: "nav", select: true },
          { role: "button", name: "Dead", region: "nav" },
        ],
      },
      [`${agent}/knowledge`]: { text: ["Knowledge"], controls: [] },
    },
    redirects: {},
  });

test("only a control named exactly the label is found, nav first, and off-limits controls are refused", async () => {
  const app = settingsApp();
  await app.page.goto(`${agent}/overview`);
  const knowledge = await findControls(app.page, "knowledge");
  assert.deepEqual(knowledge.map((c) => c.region), ["nav", "main"], "the navigation comes first, and 'Knowledge base' is not a match");
  const publish = await findControls(app.page, "Publish");
  assert.ok(publish.length === 2 && publish.every((c) => c.off?.reason === "write"), "Publish is never a candidate");
  assert.deepEqual((await findControls(app.page, "Knowledge", { regions: ["nav"] })).map((c) => c.region), ["nav"]);
});

test("a navigation item is opened by its exact name inside the navigation, never the look-alike in the page", async () => {
  const app = settingsApp();
  await app.page.goto(`${agent}/overview`);
  const step = await openNavigationItem(app.page, "Knowledge", { sleep: instant });
  assert.deepEqual([step.found, step.ok, step.tried], [true, true, 1]);
  assert.equal(app.page.url(), `${agent}/knowledge`, "the navigation item, not the promo that leads to a page for creating apps");
  assert.deepEqual(app.log.clicks, ["Knowledge"]);
  assert.match(step.urlAfter, /^copilotstudio\.microsoft\.com\/environments\/\{id\}\/bots\/\{id\}\/knowledge$/, "the record holds masked addresses");

  await app.page.goto(`${agent}/overview`);
  const none = await openNavigationItem(app.page, "Publish", { roles: ["button"], regions: ["nav", "header"], sleep: instant });
  assert.deepEqual([none.found, none.ok], [false, false]);
  assert.match(none.note, /off limits/);
});

test("a click that changes nothing is not success: the next candidate is tried", async () => {
  const app = createFakeApp({
    screens: {
      "https://x.test/a": {
        controls: [
          { role: "link", name: "Reports", region: "nav" },
          { role: "link", name: "Reports", region: "nav", goto: "https://x.test/b" },
        ],
      },
      "https://x.test/b": { controls: [] },
    },
  });
  await app.page.goto("https://x.test/a");
  const step = await openNavigationItem(app.page, "Reports", { sleep: instant });
  assert.deepEqual([step.ok, step.tried], [true, 2]);
  assert.equal(app.page.url(), "https://x.test/b");
  assert.deepEqual(app.log.clicks, ["Reports", "Reports"]);
});

test("a label is revealed by selecting its tab, and left alone when it is already open or only text", async () => {
  const app = settingsApp();
  await app.page.goto(`${agent}/settings`);
  const collect = async (page) => page.evaluate(function collectVisibleLabelsInPage() {});
  const opened = await revealLabel(app.page, "Generative AI", { required: true, collect, sleep: instant });
  assert.deepEqual([opened.found, opened.ok, opened.tried], [true, true, 1]);
  const again = await revealLabel(app.page, "Generative AI", { required: true, collect, sleep: instant });
  assert.deepEqual([again.ok, again.tried, again.note], [true, 0, "already open"]);
  const text = await revealLabel(app.page, "General", { collect, sleep: instant });
  assert.equal(text.ok, true);
  const missing = await revealLabel(app.page, "Security", { required: true, collect, sleep: instant });
  assert.deepEqual([missing.found, missing.ok], [false, false]);
  assert.deepEqual(app.log.clicks, ["Generative AI"], "nothing else was clicked");
});

// ── A whole shot ─────────────────────────────────────────────────────────────

function planShot(capture = {}, extra = {}) {
  return {
    filename: "x.png",
    moduleTitle: "Module",
    viewport: { width: 1280, height: 720 },
    callouts: [],
    capture: {
      version: 1,
      mode: "auto",
      why: "",
      needs: ["copilot-studio-agent"],
      missing: [],
      ready: true,
      route: { kind: "copilot-studio", screen: "settings", scope: "agent" },
      screen: { id: "settings", label: "the agent's Settings page" },
      path: ["Copilot Studio", "your agent", "Settings"],
      expect: { family: "copilot-studio", scope: "agent", paths: ["settings"], label: "the agent's Settings page", strict: true },
      reveal: [],
      landmarks: [],
      guide: ["Open Settings."],
      ...capture,
    },
    ...extra,
  };
}

const gateOk = () => ({ failed: null, async ensureSignedIn() { return { ok: true }; } });

async function run(t, app, shot, { values = {}, mode = "auto", guided = {}, gate = gateOk(), session = null } = {}) {
  const dir = tmp(t);
  const env = {};
  if (values.agentUrl) env.CAPTURE_COPILOT_STUDIO_AGENT_URL = values.agentUrl;
  const targets = values.agentName ? { copilotStudioAgentName: values.agentName } : {};
  return runCaptureShot({
    page: app.page,
    shot,
    session: session || createCaptureSession({ env, targets }),
    effectiveMode: mode,
    env,
    gate,
    assetsDir: path.join(dir, "a"),
    screenshotsDir: path.join(dir, "s"),
    sleep: instant,
    guided,
    verifyBuffer: verifyCapturedImageBuffer,
    readiness: { maxMs: 2000 },
  });
}

test("a shot that needs the agent and has none stops before opening anything, and says what to do", async (t) => {
  const app = settingsApp();
  const result = await run(t, app, planShot());
  assert.deepEqual([result.status, result.cause], ["skipped", "no-agent"]);
  assert.match(result.error, /needs your agent address\. Add it in Capture settings/);
  assert.equal(app.log.goto.length, 0, "nothing was opened and nothing was photographed");
  assert.equal(app.log.screenshots, 0);
});

test("with the agent address the screen is opened directly and the landing is checked", async (t) => {
  const app = settingsApp();
  const result = await run(t, app, planShot({ reveal: [{ action: "reveal", label: "Generative AI", required: true }] }), { values: { agentUrl: `${agent}/overview` } });
  assert.equal(result.status, "captured", result.error);
  assert.deepEqual(app.log.goto, [`${agent}/settings`], "straight to the screen, no start page, no wandering");
  assert.equal(result.detail.landing.state, "match");
  assert.deepEqual(result.executedSteps.map((s) => [s.action, s.ok]), [["open", true], ["reveal", true], ["screenshot", true]]);
  assert.deepEqual(app.log.clicks, ["Generative AI"]);
  assert.match(result.finalUrl, /\/settings$/);
});

test("the environment is learned from where the product sends the browser, and the agent is opened by its exact name once per job", async (t) => {
  const app = createFakeApp({
    screens: {
      [`${base}/agents`]: {
        text: ["Agents"],
        controls: [
          { role: "link", name: "Energy Assistant (test copy)", region: "main", goto: `${base}/bots/9999/overview` },
          { role: "link", name: "Energy Assistant", region: "main", goto: `${agent}/overview` },
          { role: "button", name: "Create blank agent", region: "main" },
        ],
      },
      [`${agent}/overview`]: { text: ["Overview"], controls: [] },
      [`${agent}/settings`]: { text: ["Settings"], controls: [] },
    },
    redirects: { "https://copilotstudio.microsoft.com/": `${base}/home` },
  });
  const session = createCaptureSession({ targets: { copilotStudioAgentName: "Energy Assistant" } });
  const overview = planShot({ route: { kind: "copilot-studio", screen: "overview", scope: "agent" }, expect: { family: "copilot-studio", scope: "agent", paths: ["overview"], label: "the agent's Overview page", strict: true } });
  const first = await run(t, app, overview, { values: { agentName: "Energy Assistant" }, session });
  assert.equal(first.status, "captured", first.error);
  assert.deepEqual(app.log.clicks, ["Energy Assistant"], "the exact name, not the test copy, and never Create blank agent");
  assert.equal(session.cs.agentSource, "name");
  assert.equal(session.cs.envBase, base);
  const gotosBefore = app.log.goto.length;
  const second = await run(t, app, planShot(), { values: { agentName: "Energy Assistant" }, session });
  assert.equal(second.status, "captured", second.error);
  assert.deepEqual(app.log.goto.slice(gotosBefore), [`${agent}/settings`], "the next shot goes straight to its screen");

  const lost = await run(t, createFakeApp({ screens: { [`${base}/agents`]: { controls: [] } }, redirects: { "https://copilotstudio.microsoft.com/": `${base}/home` } }), planShot(), { values: { agentName: "Missing" } });
  assert.deepEqual([lost.status, lost.cause], ["failed", "agent-not-found"]);
  assert.match(lost.error, /No agent named “Missing” was found/);
});

test("when the address does not land on the screen, the product's own navigation is used, and a failure names both pages", async (t) => {
  const app = settingsApp();
  app.page.goto = async (url) => {
    app.log.goto.push(url);
    app.state.current = url === `${agent}/settings` ? `${agent}/overview` : url;
  };
  const result = await run(t, app, planShot(), { values: { agentUrl: `${agent}/overview` } });
  assert.equal(result.status, "captured", result.error);
  assert.deepEqual(app.log.clicks, ["Settings"], "the navigation item, selected by its exact name");

  const stuck = settingsApp();
  stuck.page.goto = async (url) => {
    stuck.log.goto.push(url);
    stuck.state.current = `${agent}/overview`;
  };
  stuck.page.getByRole = () => ({ count: async () => 0, nth: () => null });
  const failed = await run(t, stuck, planShot(), { values: { agentUrl: `${agent}/overview` } });
  assert.deepEqual([failed.status, failed.cause], ["failed", "wrong-screen"]);
  assert.match(failed.error, /ended on the agent's Overview page, not the agent's Settings page/);
  assert.equal(stuck.log.screenshots, 0, "a wrong screen is never photographed");
});

test("a required step that cannot be done stops the shot with the reason, and nothing is photographed", async (t) => {
  const app = settingsApp();
  const result = await run(t, app, planShot({ reveal: [{ action: "reveal", label: "Security", required: true }] }), { values: { agentUrl: `${agent}/overview` } });
  assert.deepEqual([result.status, result.cause], ["failed", "control-not-found"]);
  assert.match(result.error, /Could not find “Security” on the agent's Settings page\. Use “Retake guided”/);
  assert.equal(app.log.screenshots, 0);
  assert.equal(result.executedSteps.at(-1).found, false, "the step record says what was looked for");

  const optional = await run(t, settingsApp(), planShot({ reveal: [{ action: "reveal", label: "Security", required: false }] }), { values: { agentUrl: `${agent}/overview` } });
  assert.equal(optional.status, "captured", "a hint that is not required does not stop the shot");
});

test("a shot never clicks anything that creates, publishes, or deletes, even when the plan names it", async (t) => {
  const app = settingsApp();
  const result = await run(t, app, planShot({ reveal: [{ action: "reveal", label: "Publish", required: true }] }), { values: { agentUrl: `${agent}/overview` } });
  assert.equal(result.cause, "control-not-found");
  assert.ok(!app.log.clicks.includes("Publish"));
});

test("sign-in is checked after every navigation and stops the shot with the sign-in reason", async (t) => {
  const app = settingsApp();
  const gate = { failed: null, async ensureSignedIn() { return { ok: false, status: "auth-required", code: "timeout", error: "The sign-in was not finished in time." }; } };
  const result = await run(t, app, planShot(), { values: { agentUrl: `${agent}/overview` }, gate });
  assert.deepEqual([result.status, result.cause], ["auth-required", "sign-in"]);
  assert.equal(app.log.screenshots, 0);
});

test("guided: the person's choice decides, and a missing person times out instead of hanging", async (t) => {
  const guidedShot = planShot({ mode: "guided", needs: [] });
  const real = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  for (const [action, expectStatus, expectCause] of [["capture", "captured", undefined], ["skip", "skipped", "skipped-by-you"], ["stop", "paused", "stopped"]]) {
    const app = settingsApp();
    const result = await run(t, app, guidedShot, {
      values: { agentUrl: `${agent}/overview` },
      mode: "guided",
      guided: { timeoutMs: 5000, shouldStop: () => false, sleep: real, onWaiting: async () => app.pressToolbar(action) },
    });
    assert.equal(result.status, expectStatus, `${action}: ${result.error}`);
    assert.equal(result.cause, expectCause);
    assert.equal(app.log.screenshots, action === "capture" ? 1 : 0);
  }
  const absent = await run(t, settingsApp(), guidedShot, { values: { agentUrl: `${agent}/overview` }, mode: "guided", guided: { timeoutMs: 300, shouldStop: () => false, sleep: real } });
  assert.deepEqual([absent.status, absent.timedOut], ["needs-you", true]);
  assert.match(absent.error, /Nobody pressed Capture this screen in time/);
});

test("guided without an agent opens the closest page it can and still waits for the person", async (t) => {
  const app = createFakeApp({ screens: { [`${base}/agents`]: { text: ["Agents"], controls: [] } }, redirects: { "https://copilotstudio.microsoft.com/": `${base}/home` } });
  const result = await run(t, app, planShot({ mode: "guided", needs: [] }), {
    mode: "guided",
    guided: { timeoutMs: 5000, shouldStop: () => false, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), onWaiting: async () => app.pressToolbar("capture") },
  });
  assert.equal(result.status, "captured", result.error);
  assert.equal(app.page.url(), `${base}/agents`, "the closest page: the list of agents");
});
