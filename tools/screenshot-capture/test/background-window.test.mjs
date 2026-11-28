// Hermetic tests for "Hide the browser window while capturing" (the portal's background option): what the companion
// does with a job that asks for it, with and without a saved sign-in, when the saved sign-in is refused, and for screens
// the person has to set up. A fake Playwright stands in for the browser, so no window ever opens and no tenant is used.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { listSignedInProfiles, runJob } from "../companion.mjs";
import { profileDir, saveSession } from "../auth.mjs";
import { createFakePlaywright } from "./fixtures/fake-playwright.mjs";

const APP = "https://copilotstudio.microsoft.com/";
const LOGIN = "https://login.microsoftonline.com/common/oauth2/authorize?client_id=x&redirect_uri=https%3A%2F%2Fapp.example.com";
const BACKGROUND_LINE = "Running in the background: your saved sign-in is used and no window is shown.";

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "background-window-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The product was signed in on this computer before: a capture worked and the session was saved. */
async function saveSignIn(home) {
  await saveSession({ context: { storageState: async () => ({ cookies: [{ name: "a", value: "b", expires: -1 }] }) }, dir: profileDir(home, "chromium", "copilot-studio"), product: "copilot-studio", browser: "chromium", captured: true });
  assert.deepEqual(listSignedInProfiles(home), ["copilot-studio"]);
}

function recordingClient() {
  const shots = [];
  return {
    shots,
    async heartbeat() {
      return {};
    },
    async progress(_id, body) {
      if (body.shot) shots.push(body.shot);
      return { ok: true };
    },
    async upload() {
      return { status: 200, body: { outcome: "accepted" } };
    },
    async complete() {
      return {};
    },
    /** The last thing said about each file. */
    last: () => Object.fromEntries(shots.map((s) => [s.filename, s])),
  };
}

const planShot = (filename, extra = {}) => ({
  filename, shotId: filename, featureId: "f", moduleTitle: "M", product: "copilot-studio", authProfile: "copilot-studio",
  startUrl: APP, viewport: { width: 1440, height: 900 }, manual: false, requiresEnv: null, expectedLabels: ["Settings"], callouts: [],
  steps: [{ action: "navigate", url: APP }, { action: "screenshot" }],
  ...extra,
});
const guidedShot = (filename) => planShot(filename, { capture: { version: 1, mode: "guided", product: "copilot-studio", route: { kind: "url", url: APP }, reveal: [], guide: ["Set up the screen."] } });
const claimed = (shots, options = {}) => ({ job: { id: "job_0123456789abcdef", target: { type: "lab", labId: "lab-a" }, scope: {}, options: { callouts: "none", redact: true, ...options }, createdAt: new Date().toISOString(), resumed: false }, env: {}, shots });

async function run(t, { home = tmpHome(t), shots, jobOptions = {}, runOptions = {}, fake = createFakePlaywright() }) {
  const client = recordingClient();
  const lines = [];
  const sizes = [];
  fake.page.setViewportSize = async (size) => {
    sizes.push(`${size.width}x${size.height}`);
  };
  const result = await runJob({
    client, claimed: claimed(shots, jobOptions), home, playwright: fake.playwright,
    options: { authSettleMs: 0, authPollMs: 5, authGraceMs: 0, signInWaitSec: 0.2, browserKinds: ["chromium"], ...runOptions },
    log: (line) => lines.push(String(line)), sleepFn: async () => {}, heartbeatMs: 60_000,
  });
  return { client, fake, result, text: lines.join("\n"), sizes, headless: fake.log.launched.map((l) => l.options.headless) };
}

test("checked with a saved sign-in: the browser opens hidden, nothing asks for a window, and the pictures are the same size as in a visible run", async (t) => {
  const home = tmpHome(t);
  await saveSignIn(home);
  const hidden = await run(t, { home, shots: [planShot("a.png"), planShot("b.png")], jobOptions: { background: true } });
  assert.deepEqual(hidden.headless, [true], "one browser, opened without a window");
  assert.ok(hidden.text.includes(BACKGROUND_LINE));
  assert.equal(hidden.result.tally.captured, 2);

  const shown = await run(t, { home, shots: [planShot("a.png"), planShot("b.png")] });
  assert.deepEqual(shown.headless, [false], "without the option the same sign-in opens a visible window");
  assert.ok(!shown.text.includes("in the background"));
  assert.equal(shown.result.tally.captured, 2);

  assert.deepEqual([...new Set(hidden.sizes)], ["1440x900"], "the picture size comes from the plan");
  assert.deepEqual(hidden.sizes, shown.sizes, "hidden or shown, every picture is set to the same size");
});

test("the companion's own --background works even when the portal did not ask for it", async (t) => {
  const home = tmpHome(t);
  await saveSignIn(home);
  const run1 = await run(t, { home, shots: [planShot("a.png")], runOptions: { background: true } });
  assert.deepEqual(run1.headless, [true]);
  assert.ok(run1.text.includes(BACKGROUND_LINE));
});

test("checked without a saved sign-in: a window opens so the person can sign in, and the console says why", async (t) => {
  const first = await run(t, { shots: [planShot("a.png")], jobOptions: { background: true } });
  assert.deepEqual(first.headless, [false]);
  assert.match(first.text, /There is no saved sign-in for Microsoft Copilot Studio yet, so a window opens for you to sign in\. Next time this can run in the background\./);
  assert.ok(!first.text.includes(BACKGROUND_LINE));
});

test("checked, but the saved sign-in is refused at the start: the hidden window is closed and a window opens instead", async (t) => {
  const home = tmpHome(t);
  await saveSignIn(home);
  const refused = await run(t, { home, shots: [planShot("a.png")], jobOptions: { background: true }, fake: createFakePlaywright({ rewriteUrl: () => LOGIN }) });
  assert.deepEqual(refused.headless, [true, false], "hidden first, then a visible window");
  assert.match(refused.text, /Microsoft Copilot Studio asked for a sign-in again in the background \(it needs you to sign in\), so a window is opening for you instead\./);
  assert.equal(refused.fake.log.closed >= 1, true, "the hidden window was closed");
});

test("checked, and the sign-in is needed later while the window is hidden: those screens stop with a plain message that does not talk about --headless", async (t) => {
  const home = tmpHome(t);
  await saveSignIn(home);
  // The first visit (the check at the start) finds the product; the next one is sent to the sign-in page.
  let fake = null;
  fake = createFakePlaywright({ rewriteUrl: (u) => (fake.log.goto.length >= 2 ? LOGIN : u) });
  const out = await run(t, { home, shots: [planShot("a.png"), planShot("b.png")], jobOptions: { background: true }, fake });
  assert.deepEqual(out.headless, [true], "no window was opened, so nothing could ask");
  const last = out.client.last();
  for (const name of ["a.png", "b.png"]) {
    assert.equal(last[name].status, "auth-required", name);
    assert.match(last[name].error, /Microsoft Copilot Studio needs a sign-in, but its browser window is hidden \(you chose Hide the browser window\), so nothing could ask you\. Turn that option off and retake: a window opens and you can sign in\./);
    assert.doesNotMatch(last[name].error, /--headless/);
  }
  assert.equal(out.result.tally.captured, 0);
});

test("a screen you set up yourself is never run in a hidden window: it ends as needs you, with the way forward", async (t) => {
  const home = tmpHome(t);
  await saveSignIn(home);
  const out = await run(t, { home, shots: [planShot("a.png"), guidedShot("g.png")], jobOptions: { background: true, mode: "smart" } });
  assert.deepEqual(out.headless, [true]);
  assert.equal(out.result.tally.captured, 1, "the automatic screen was captured hidden");
  const guided = out.client.last()["g.png"];
  assert.equal(guided.status, "needs-you");
  assert.equal(guided.cause, "needs-you");
  assert.match(guided.message, /^This screen needs you to set it up, but the browser window is hidden \(--headless, or you chose Hide the browser window\), so nobody can\. Use “Retake guided”: it opens a window\.$/);

  const visible = await run(t, { home, shots: [guidedShot("g.png")], jobOptions: { mode: "smart" }, runOptions: { guidedWaitSec: 0.2 } });
  assert.deepEqual(visible.headless, [false]);
  assert.doesNotMatch(visible.client.last()["g.png"].message, /hidden/, "with a window, the screen waits for the person instead");
});
