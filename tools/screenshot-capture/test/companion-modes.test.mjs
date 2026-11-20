// Hermetic tests for how the companion runs a job in each mode and what it does when the browser misbehaves:
// automatic, guided, and smart jobs; screens that need a person when nobody is there; the browser window closed
// in the middle of a job; an interrupted navigation; a crashed tab; and a plan from an older portal.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { COMPANION_VERSION, DEFAULT_GUIDED_WAIT_SEC, effectiveModeFor, helpText, jobTargets, parseArgs, plainOutcome, runJob } from "../companion.mjs";
import { createFakePlaywright } from "./fixtures/fake-playwright.mjs";

const instant = async () => {};

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "companion-modes-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A portal that records what the companion tells it. */
function recordingClient() {
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
      return { status: 200, body: { outcome: "accepted" } };
    },
    async complete(_id, body) {
      calls.completes.push(body);
      return {};
    },
    /** The status each shot ended with (the last one reported). */
    final() {
      const out = {};
      for (const entry of calls.progress) if (entry.shot) out[entry.shot.filename] = entry.shot;
      return out;
    },
  };
}

const HOST = "make.powerapps.com";

function shot(filename, mode = "auto", extra = {}) {
  return {
    filename,
    shotId: filename,
    featureId: "f",
    moduleTitle: "Module",
    product: "power-platform-ai-hub",
    authProfile: "power-platform-ai-hub",
    startUrl: `https://${HOST}/`,
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
      needs: [],
      missing: [],
      ready: true,
      route: { kind: "url", url: `https://${HOST}/` },
      screen: { id: "start", label: "the page" },
      path: ["Power Platform", "AI hub"],
      expect: { family: "url", host: HOST, label: "a page of Power Platform", strict: mode === "auto" },
      reveal: [],
      landmarks: [],
      guide: ["Open the screen."],
    },
    ...extra,
  };
}

const job = (shots, options = {}) => ({ job: { id: "job_00000000000000aa", target: { type: "library", products: [] }, scope: {}, options: { callouts: "none", redact: true, ...options }, createdAt: "2026-01-01T00:00:00Z", resumed: false }, env: {}, targets: {}, shots });

async function go(t, shots, { jobOptions = {}, runOptions = {}, fake = createFakePlaywright(), sleepFn = instant } = {}) {
  const client = recordingClient();
  const lines = [];
  const result = await runJob({ client, claimed: job(shots, jobOptions), home: tmp(t), playwright: fake.playwright, options: { headless: false, ...runOptions }, log: (l) => lines.push(String(l)), sleepFn, heartbeatMs: 60_000 });
  return { client, lines, result, fake, final: client.final() };
}

const statuses = (final) => Object.fromEntries(Object.entries(final).map(([name, s]) => [name, s.status]));

// ── Modes ────────────────────────────────────────────────────────────────────

test("automatic mode does what it can and marks screens that need a person as 'needs you' without opening them", async (t) => {
  const run = await go(t, [shot("a.png", "auto"), shot("g.png", "guided")], { jobOptions: { mode: "auto" } });
  assert.deepEqual(statuses(run.final), { "a.png": run.final["a.png"].status, "g.png": "needs-you" });
  assert.equal(run.final["a.png"].status, "running", "the last report for a captured shot is the upload, not a status");
  assert.equal(run.final["g.png"].cause, "needs-you");
  assert.match(run.final["g.png"].message, /Automatic mode skips it/);
  assert.equal(run.result.tally.captured, 1);
  assert.equal(run.result.tally.needsYou, 1);
  assert.equal(run.fake.log.goto.length, 1, "only the automatic shot opened a page");
  assert.equal(run.client.calls.completes[0].paused, undefined);
});

test("smart mode runs the automatic shots first, even when a guided shot comes earlier in the plan", async (t) => {
  const run = await go(t, [shot("g.png", "guided"), shot("a1.png", "auto"), shot("a2.png", "auto")], { jobOptions: { mode: "smart" }, runOptions: { headless: true } });
  const order = run.client.calls.progress.filter((p) => p.shot?.status === "running").map((p) => p.shot.filename);
  assert.deepEqual(order, ["a1.png", "a2.png"], "nothing waits behind a screen that needs a person");
  assert.equal(run.final["g.png"].status, "needs-you", "nobody is here with --headless, so it is not left hanging");
  assert.match(run.final["g.png"].message, /--headless/);
  assert.equal(run.result.tally.captured, 2);
});

test("guided mode asks the person about every screen, and a person who is not there times out once, not for every shot", async (t) => {
  const started = Date.now();
  const run = await go(t, [shot("a.png", "auto"), shot("b.png", "guided"), shot("c.png", "guided")], {
    jobOptions: { mode: "guided" },
    runOptions: { guidedWaitSec: 0.2 },
  });
  assert.deepEqual(statuses(run.final), { "a.png": "needs-you", "b.png": "needs-you", "c.png": "needs-you" });
  assert.equal(run.final["a.png"].mode, "guided", "even an automatic shot is set up by the person in this mode");
  assert.ok(Date.now() - started < 8000, "one bounded wait, not one per shot");
  const text = run.lines.join("\n");
  assert.equal(text.match(/Nobody answered/g).length, 1, "one message");
  assert.match(run.final["c.png"].message, /Nobody was here to set this screen up earlier in this job/);
  assert.equal(run.result.tally.needsYou, 3);
});

test("a job in each mode reports the mode of every shot and the plain-language path with it", async (t) => {
  const run = await go(t, [shot("a.png", "auto")], { jobOptions: { mode: "smart" } });
  const report = run.client.calls.progress.find((p) => p.shot?.filename === "a.png" && p.shot.status === "running");
  assert.equal(report.shot.mode, "auto");
  assert.deepEqual(report.shot.path, ["Power Platform", "AI hub"]);
  assert.equal(plainOutcome({ path: ["Copilot Studio", "your agent", "Settings"] }, [{ action: "reveal", ok: true, tried: 1, label: "Generative AI" }], "auto"), "Opened Copilot Studio, then your agent, then Settings, then selected Generative AI.");
  assert.match(plainOutcome({ path: ["Copilot Studio"] }, [], "guided"), /You set up the screen\.$/);
});

test("how a shot runs, the job settings that travel with a job, and the command line", () => {
  assert.equal(effectiveModeFor(shot("g.png", "guided"), "auto"), "needs-you");
  assert.equal(COMPANION_VERSION, "1.6.2");
  assert.match(helpText(), /--guided-wait=<seconds>/);
  assert.match(helpText(), /--ready-wait=<seconds>/);
  const opts = parseArgs(["--guided-wait=30", "--ready-wait=40"]);
  assert.deepEqual([opts.guidedWaitSec, opts.readyWaitSec], [30, 40]);
  assert.equal(parseArgs(["--guided-wait=1"]).guidedWaitSec, 5, "a very short wait is raised to something a person can use");
  assert.equal(DEFAULT_GUIDED_WAIT_SEC, 120);
  assert.deepEqual(jobTargets({ copilotStudioAgentName: "My agent", copilotStudioAgentUrl: "https://x.example.com", unknown: "x", agentBuilderAgentName: "<b>" }), { copilotStudioAgentName: "My agent" }, "only valid names; addresses travel as variables");
  assert.deepEqual(jobTargets(null), {});
});

// ── The browser misbehaves ───────────────────────────────────────────────────

test("a closed browser window pauses the job once, with one clear message, and the portal is told it can resume", async (t) => {
  const fake = createFakePlaywright({ gotoFailure: (_url, n) => (n >= 2 ? new Error("page.goto: Target page, context or browser has been closed") : null) });
  const shots = Array.from({ length: 6 }, (_, i) => shot(`s${i + 1}.png`));
  const run = await go(t, shots, { fake });
  assert.equal(run.result.tally.captured, 2);
  assert.equal(run.result.paused.reason, "browser-closed");
  assert.equal(run.result.tally.paused, 4, "the rest are paused, not failed");
  assert.equal(run.result.tally.failed, 0);
  assert.equal(fake.log.goto.length, 3, "after the window closed, nothing else was tried");
  const messages = run.lines.filter((l) => /closed the browser window/.test(l));
  assert.equal(messages.length, 1, "one message, not one per shot");
  assert.match(messages[0], /4 screenshots were not captured yet\. In the portal, select Resume/);
  const complete = run.client.calls.completes[0];
  assert.equal(complete.paused.reason, "browser-closed");
  assert.match(complete.paused.message, /select Resume/);
  assert.ok(!Object.values(run.final).some((s) => s.status === "failed"));

  // Resume: the paused shots, queued again, are captured.
  const resumed = await go(t, shots.slice(2));
  assert.equal(resumed.result.tally.captured, 4);
});

test("an interrupted navigation is retried and the shot succeeds", async (t) => {
  const fake = createFakePlaywright({ gotoFailure: (_url, n) => (n === 0 ? new Error("page.goto: net::ERR_ABORTED at https://make.powerapps.com/") : null) });
  const run = await go(t, [shot("a.png")], { fake });
  assert.equal(run.result.tally.captured, 1);
  assert.equal(fake.log.goto.length, 2);
  assert.match(run.lines.join("\n"), /The page did not open \(net::ERR_ABORTED\)\. Trying again/);
});

test("a crashed tab is replaced by a new tab in the same browser and the shot is tried again", async (t) => {
  const fake = createFakePlaywright({ gotoFailure: (_url, n) => (n === 0 ? new Error("page.goto: Page crashed") : null) });
  const run = await go(t, [shot("a.png"), shot("b.png")], { fake });
  assert.equal(run.result.tally.captured, 2);
  assert.equal(fake.log.newPages, 1, "one new tab");
  assert.match(run.lines.join("\n"), /The browser tab crashed\. Opening a new tab/);
});

test("pressing Stop pauses the capture with its own message", async (t) => {
  const fake = createFakePlaywright();
  fake.page.exposeFunction = async (name, fn) => {
    if (name === "__captureGuidedAction") setTimeout(() => fn("stop"), 20);
  };
  const run = await go(t, [shot("g.png", "guided"), shot("h.png", "guided")], { fake, runOptions: { attended: true, guidedWaitSec: 5 }, sleepFn: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 30))) });
  assert.equal(run.result.paused.reason, "stopped");
  assert.match(run.lines.join("\n"), /You stopped the capture\. 2 screenshots are paused\./);
  assert.equal(run.client.calls.completes[0].paused.reason, "stopped");
});

// ── Older portals ────────────────────────────────────────────────────────────

test("a plan from an older portal, with no capture descriptor, still runs as before", async (t) => {
  const legacy = shot("old.png");
  delete legacy.capture;
  legacy.steps = [{ action: "navigate", url: `https://${HOST}/`, waitUntil: "domcontentloaded" }, { action: "screenshot" }];
  const run = await go(t, [legacy]);
  assert.equal(run.result.tally.captured, 1);
  assert.equal(run.client.calls.uploads[0].evidence.mode, "legacy");
  const noEnv = shot("env.png");
  delete noEnv.capture;
  noEnv.requiresEnv = "CAPTURE_SHAREPOINT_SITE_URL";
  const skipped = await go(t, [noEnv]);
  assert.equal(skipped.final["env.png"].status, "skipped");
  assert.equal(skipped.result.tally.skipped, 1);
});
