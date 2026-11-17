// Hermetic tests for the sign-in handling of the Local Capture Companion: telling a sign-in
// page from the product, signing in once, keeping the session, never clicking anything that
// signs out, choosing a browser, the redacted trace, and the watch-mode limits. A fake
// Playwright stands in for the browser, so none of this needs a browser or a tenant.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  EXIT,
  captureShot as captureShotReal,
  describeSignInState,
  listSignedInProfiles,
  openProfile,
  parseArgs,
  preflight,
  runCompanion,
  runJob as runJobReal,
  safeSteps,
  saveConfig,
} from "../companion.mjs";
import { classifyUrl, createAuthGate, forgetSignIn, productLabel, profileDir, readSignInStates, redactedAddress, restoreSession, saveSession } from "../auth.mjs";
import { browserCandidates, chooseBrowsers, detectInstalledBrowsers, isMissingBrowserError, missingBrowserMessage, parseBrowserChoice } from "../browsers.mjs";
import { blockedInstructionReason, blockedLabelReason, controlIsOffLimits, isAccountLink } from "../guard.mjs";
import { executePlaywrightLabShot, isSignInRedirectUrl } from "../lab-runner.mjs";
import { createTrace, redactTraceText, traceFilePath } from "../trace.mjs";
import { createFakePlaywright } from "./fixtures/fake-playwright.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const TOOL_DIR = path.resolve(here, "..");
const LOGIN = "https://login.microsoftonline.com/common/oauth2/authorize?client_id=x&redirect_uri=https%3A%2F%2Fapp.example.com";
const APP = "https://copilotstudio.microsoft.com/";
const TOKEN = "cap_FAKE_TOKEN_FOR_TESTS_0123456789abcdefghij";

function tmpDir(t, prefix = "signin-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function collectLog() {
  const lines = [];
  const log = (message = "") => lines.push(String(message));
  log.lines = lines;
  log.text = () => lines.join("\n");
  return log;
}

/** A page whose address depends on how many waits have passed: a script of [fromTick, address]. */
function scriptedPage(script) {
  const state = { tick: 0 };
  const urlAt = (tick) => [...script].reverse().find(([from]) => tick >= from)?.[1] ?? "about:blank";
  return { state, page: { url: () => urlAt(state.tick) }, sleep: async () => { state.tick += 1; } };
}

const gateOf = (extra = {}) => createAuthGate({ product: "copilot-studio", waitMs: 600, pollMs: 10, settleMs: 30, graceMs: 20, ...extra });

// ── The captured address: host and path, never the query string ──────────────

test("sign-in pages are recognized by host and path, and a query string never makes a page a sign-in page", () => {
  assert.equal(classifyUrl("https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x").kind, "sign-in");
  assert.equal(classifyUrl("https://login.microsoftonline.com/contoso.com/kmsi").kind, "sign-in", "Stay signed in?");
  assert.equal(classifyUrl("https://login.live.com/login.srf").kind, "sign-in");
  assert.equal(classifyUrl("https://sts.contoso.com/adfs/ls/?wa=wsignin1.0").kind, "sign-in", "a company identity provider");
  assert.equal(classifyUrl("https://login.microsoftonline.us/common/oauth2/authorize").kind, "sign-in");
  assert.equal(classifyUrl("https://copilotstudio.microsoft.com/environments/Default/home?returnUrl=https%3A%2F%2Flogin.microsoftonline.com%2Fcommon").kind, "app");
  assert.equal(classifyUrl("https://make.powerapps.com/#redirect_uri=login.microsoftonline.com/oauth2/authorize").kind, "app");
  assert.equal(classifyUrl("about:blank").kind, "blank");
  assert.equal(classifyUrl("").kind, "blank");
  assert.equal(classifyUrl("chrome-error://chromewebdata/").kind, "error");
  assert.equal(classifyUrl(LOGIN).reason, "host=login.microsoftonline.com");
  assert.equal(isSignInRedirectUrl("https://admin.microsoft.com/?next=login.microsoftonline.com"), false, "the lab runner uses the same rule");
  assert.equal(isSignInRedirectUrl("https://login.windows.net/common/oauth2/authorize"), true);
});

test("addresses in logs and traces have no query string, fragment, or ids", () => {
  assert.equal(redactedAddress("https://copilotstudio.microsoft.com/environments/0f1d2c3b-aaaa-4bbb-8ccc-1234567890ab/home?code=SECRET#token=1"), "copilotstudio.microsoft.com/environments/{id}/home");
  assert.equal(redactedAddress("about:blank"), "(blank)");
  assert.equal(redactedAddress("https://login.microsoftonline.com/ada@contoso.com/kmsi?x=1"), "login.microsoftonline.com/{id}/kmsi");
});

test("product names come from the capture products file", () => {
  assert.equal(productLabel("copilot-studio"), "Microsoft Copilot Studio");
  assert.equal(productLabel("some-new-product"), "Some New Product");
});

// ── Waiting for the person to sign in, once ──────────────────────────────────

test("a quick silent single sign-on trip to the sign-in host passes without asking the person anything", async () => {
  const { page, sleep } = scriptedPage([[0, APP], [2, LOGIN], [3, "https://login.microsoftonline.com/common/reprocess"], [4, `${APP}home`]]);
  const said = [];
  const gate = gateOf({ sleep, graceMs: 1000, notify: (n) => said.push(n.message) });
  const result = await gate.ensureSignedIn(page, { phase: "navigate", target: APP });
  assert.deepEqual(result, { ok: true, waited: true });
  assert.deepEqual(said, [], "a hop that ends by itself says nothing");
});

test("Stay signed in, account picker, MFA, and Working on it pages are waited through, and the person is told once", async () => {
  const { page, sleep, state } = scriptedPage([
    [0, LOGIN],
    [3, "https://login.microsoftonline.com/common/login"],
    [6, "https://login.microsoftonline.com/common/SAS/ProcessAuth"],
    [9, "https://login.microsoftonline.com/common/kmsi"],
    [12, "https://login.microsoftonline.com/common/reprocess"],
    [15, `${APP}home`],
  ]);
  const said = [];
  const gate = gateOf({ sleep, notify: (n) => said.push(n.message) });
  const result = await gate.ensureSignedIn(page, { phase: "navigate", target: APP });
  assert.deepEqual(result, { ok: true, waited: true });
  assert.equal(said.length, 1);
  assert.match(said[0], /^Waiting for you to sign in to Microsoft Copilot Studio in the browser window\. This computer remembers it afterwards\./);
  assert.match(said[0], /choose Yes/, "the person is told what to pick on Stay signed in?");
  assert.ok(state.tick >= 15);
  assert.equal(gate.state.waits, 1);
});

test("a page that sends the browser to sign-in a moment after it loads is not taken for the product", async () => {
  const { page, sleep } = scriptedPage([[0, APP], [4, LOGIN], [12, `${APP}home`]]);
  const gate = gateOf({ sleep, settleMs: 80 });
  const result = await gate.ensureSignedIn(page, { phase: "navigate", target: APP });
  assert.deepEqual(result, { ok: true, waited: true }, "the redirect after load was seen and waited out");
});

test("a signed-in page whose address mentions the sign-in host is the product, with no wait", async () => {
  const { page, sleep, state } = scriptedPage([[0, `${APP}home?returnUrl=https%3A%2F%2Flogin.microsoftonline.com%2Fcommon%2Foauth2%2Fauthorize`]]);
  const gate = gateOf({ sleep });
  assert.deepEqual(await gate.ensureSignedIn(page, { phase: "check" }), { ok: true });
  assert.equal(state.tick, 0);
});

test("when sign-in does not finish, the wait ends once and every later check fails at once without waiting again", async () => {
  const { page, sleep, state } = scriptedPage([[0, LOGIN]]);
  const said = [];
  const gate = gateOf({ sleep, waitMs: 100, notify: (n) => said.push(n.message) });
  const first = await gate.ensureSignedIn(page, { phase: "navigate", target: APP });
  assert.equal(first.ok, false);
  assert.equal(first.status, "auth-required");
  assert.equal(first.code, "timeout");
  const ticks = state.tick;
  for (let i = 0; i < 5; i += 1) assert.equal((await gate.ensureSignedIn(page, { phase: "navigate", target: APP })).code, "timeout");
  assert.equal(state.tick, ticks, "no more waiting after the first failure");
  assert.equal(said.length, 1, "the person was told once");
  assert.match(gate.describeFailure(3), /Sign in to Microsoft Copilot Studio on your computer, then retry the 3 screenshots\./);
  assert.match(gate.describeFailure(1), /retry the 1 screenshot\./);
});

test("--headless cannot sign in, so it says so instead of waiting", async () => {
  const { page, sleep, state } = scriptedPage([[0, LOGIN]]);
  const gate = gateOf({ sleep, allowWait: false });
  const result = await gate.ensureSignedIn(page, { phase: "navigate", target: APP });
  assert.equal(result.code, "headless");
  assert.match(result.error, /--headless/);
  assert.equal(state.tick, 0);
});

test("being sent straight back to sign-in after signing in stops the loop with a clear reason", async () => {
  const { page, state, sleep } = scriptedPage([[0, LOGIN], [4, `${APP}home`], [20, LOGIN]]);
  const gate = gateOf({ sleep, bounceMs: 500 });
  assert.equal((await gate.ensureSignedIn(page, { phase: "navigate", target: APP })).ok, true);
  state.tick = 21;
  const again = await gate.ensureSignedIn(page, { phase: "navigate", target: APP });
  assert.equal(again.code, "bounced");
  assert.match(again.error, /sent back to the sign-in page right away/);
});

test("a different product host that needs its own sign-in is allowed, but only a few times", async () => {
  const script = [[0, LOGIN], [3, `${APP}home`]];
  const { page, state, sleep } = scriptedPage(script);
  const gate = gateOf({ sleep, bounceMs: 0, maxEpisodes: 2 });
  assert.equal((await gate.ensureSignedIn(page, { phase: "navigate", target: "https://a.example.com/" })).ok, true);
  state.tick = 0;
  assert.equal((await gate.ensureSignedIn(page, { phase: "navigate", target: "https://b.example.com/" })).ok, true);
  state.tick = 0;
  assert.equal((await gate.ensureSignedIn(page, { phase: "navigate", target: "https://c.example.com/" })).code, "loop");
});

// ── Keeping the sign-in ──────────────────────────────────────────────────────

test("the session, session cookies included, is saved next to the profile and put back into a new browser", async (t) => {
  const home = tmpDir(t);
  const fake = createFakePlaywright();
  const dir = profileDir(home, "edge", "copilot-studio");
  const first = await fake.playwright.chromium.launchPersistentContext(dir, {});
  fake.signIn({ persistent: false });
  const saved = await saveSession({ context: first, dir, product: "copilot-studio", browser: "edge", captured: true });
  assert.deepEqual(saved, { saved: true, cookies: 1 });
  await first.close();

  // A real browser drops session cookies when the profile closes: the new browser starts empty.
  const second = await fake.playwright.chromium.launchPersistentContext(dir, {});
  assert.equal(second.jar.length, 0);
  const restored = await restoreSession({ context: second, dir });
  assert.equal(restored.restored, 1);
  assert.equal(second.jar[0].name, "ESTSAUTH");
  assert.equal(second.jar[0].expires, -1);

  const file = fs.readFileSync(path.join(dir, "companion-session.json"), "utf8");
  assert.ok(!file.includes("origins"), "only cookies are kept");
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(dir, "companion-session.json")).mode & 0o077, 0, "only the owner can read it");
  assert.deepEqual(listSignedInProfiles(home), ["copilot-studio"]);
});

test("old, expired, or missing saved sessions are ignored", async (t) => {
  const home = tmpDir(t);
  const dir = profileDir(home, "chrome", "copilot-studio");
  const context = { added: [], async addCookies(c) { this.added.push(...c); }, async storageState() { return { cookies: [{ name: "a", value: "b", expires: -1 }, { name: "old", value: "x", expires: 5 }] }; } };
  assert.equal((await restoreSession({ context, dir })).reason, "nothing-saved");
  await saveSession({ context, dir, product: "copilot-studio", browser: "chrome" });
  const restored = await restoreSession({ context, dir, now: () => Date.now() });
  assert.equal(restored.restored, 1, "the cookie that expired long ago is dropped");
  assert.deepEqual(context.added.map((c) => c.name), ["a"]);
  const stale = await restoreSession({ context, dir, now: () => Date.now() + 40 * 24 * 60 * 60 * 1000 });
  assert.equal(stale.reason, "too-old");
  assert.equal((await saveSession({ context: { storageState: async () => ({ cookies: [] }) }, dir, product: "copilot-studio", browser: "chrome" })).saved, false, "an empty jar is not saved over a good one");
});

test("sign-in state is per product and per browser, a bare profile folder is not a sign-in, and --forget-signin removes it", async (t) => {
  const home = tmpDir(t);
  fs.mkdirSync(profileDir(home, "edge", "ai-foundry"), { recursive: true });
  fs.writeFileSync(path.join(profileDir(home, "edge", "ai-foundry"), "Cookies"), "x");
  const dir = profileDir(home, "chrome", "copilot-studio");
  const context = { storageState: async () => ({ cookies: [{ name: "a", value: "b", expires: -1 }] }) };
  await saveSession({ context, dir, product: "copilot-studio", browser: "chrome", captured: true });
  const states = readSignInStates(home);
  assert.deepEqual(states.map((s) => [s.product, s.signedIn]), [["ai-foundry", false], ["copilot-studio", true]]);
  assert.equal(states[0].profiles[0].profilePresent, true);
  assert.equal(states[0].profiles[0].savedSession, false);
  assert.equal(states[1].profiles[0].browser, "chrome");
  assert.ok(states[1].lastCapturedAt);

  const lines = describeSignInState(home).join("\n");
  assert.match(lines, /Microsoft Foundry \(ai-foundry\): not confirmed/);
  assert.match(lines, /Microsoft Copilot Studio \(copilot-studio\): signed in/);
  assert.match(lines, /Google Chrome: profile saved yes, session saved yes, last successful capture \d{4}-\d\d-\d\d \d\d:\d\d/);
  assert.match(lines, /--forget-signin/);

  assert.deepEqual(forgetSignIn(home, ["copilot-studio"]), ["chrome/copilot-studio"]);
  assert.deepEqual(listSignedInProfiles(home), []);
  assert.deepEqual(forgetSignIn(home, "all"), ["edge/ai-foundry"]);
  assert.deepEqual(describeSignInState(home), ["Not signed in to any product yet. The first capture opens a browser window to sign in."]);
  assert.throws(() => profileDir(home, "firefox", "x"), /Unknown browser/);
  assert.throws(() => profileDir(home, "edge", "../x"), /Unknown product/);
});

// ── Never click anything that signs out, switches the account, or signs in ───

test("labels and sentences that sign in or out, switch the account, or delete something are off limits", () => {
  for (const label of ["Sign out", "Sign Out", "Sign in", "Sign In", "Sign-in", "Sign in to Microsoft 365", "Log out", "Log in", "Login", "Logoff", "Switch account", "Switch to another account", "Switch user", "Switch directory", "Use another account", "Add account", "Add another account", "Remove account", "Forget account", "Choose an account", "Pick an account", "Account manager", "My account", "View account", "Profile picture", "Delete agent", "Reset all"]) {
    assert.ok(blockedLabelReason(label), `${label} is blocked`);
  }
  for (const label of ["Settings", "Memory", "Sign-in logs", "Sign-in activity", "Accounts", "Account", "Account Data Lookup Agent", "Profile", "Logs", "Insights", "Switch", "Agents"]) {
    assert.equal(blockedLabelReason(label), null, `${label} is allowed`);
  }
  for (const text of ["Select your profile, then select **Sign out**.", "Select **Switch account**.", "Use another account to sign in.", "Log off when you are done.", "Delete the memory"]) {
    assert.ok(blockedInstructionReason(text), text);
  }
  for (const text of ["Sign in to Copilot Studio, then select **Settings**.", "After you sign in, open **Memory**.", "Select **Settings**."]) {
    assert.equal(blockedInstructionReason(text), null, text);
  }
});

test("a control whose name looks harmless but whose link signs out or switches the account is refused too", () => {
  assert.equal(controlIsOffLimits({ text: "More", aria: "", title: "", href: "/signout" })?.why, "link");
  assert.equal(controlIsOffLimits({ text: "Next", aria: "", title: "", href: "https://login.microsoftonline.com/common/oauth2/logout?x=1" })?.reason, "account");
  assert.equal(controlIsOffLimits({ text: "Other", aria: "", title: "", href: "https://login.microsoftonline.com/common/oauth2/authorize?prompt=select_account" })?.reason, "account");
  assert.equal(controlIsOffLimits({ text: "", aria: "Account manager for Ada", title: "", href: "" })?.why, "name");
  assert.equal(controlIsOffLimits({ text: "Settings", aria: "", title: "", href: "/settings" }), null);
  assert.equal(controlIsOffLimits(null), null);
  assert.equal(isAccountLink("/memory/logs"), false);
  assert.equal(isAccountLink("/auth/logout"), true);
});

test("safeSteps drops steps and labels that sign out, switch the account, or sign in", () => {
  const steps = safeSteps([
    { action: "stepThrough", labels: ["Settings", "Sign out", "Switch account", "Sign in", "Account manager"], instruction: "Select **Settings**." },
    { action: "stepThrough", labels: ["Profile"], instruction: "Select your profile, then select **Sign out**." },
    { action: "click", labels: ["Use another account"], instruction: "Select **Use another account**." },
    { action: "stepThrough", labels: ["Memory"], instruction: "Sign in to Copilot Studio, then select **Memory**." },
  ]);
  assert.deepEqual(steps.filter((s) => s.action !== "screenshot").map((s) => s.labels), [["Settings"], ["Memory"]]);
});

test("the runner never clicks a sign-out, switch-account, or sign-in control, even when the plan asks for it", async (t) => {
  const home = tmpDir(t);
  const labels = ["Settings", "Sign out", "Switch account", "Sign in", "Account manager", "More options", "Memory"];
  const fake = createFakePlaywright({
    labels,
    controlDetails: { "More options": { text: "More options", aria: "", title: "", href: "https://copilotstudio.microsoft.com/signout" } },
  });
  const shot = {
    filename: "x.png", authProfile: "copilot-studio", startUrl: APP, expectedLabels: ["Settings"], callouts: [],
    steps: [
      { action: "navigate", url: APP },
      { action: "stepThrough", labels: ["Settings", "Sign out", "Switch account", "Sign in", "Account manager", "More options", "Memory"], instruction: "Select **Settings**.", interaction: "click-or-focus" },
      { action: "screenshot" },
    ],
  };
  const trace = createTrace({ file: null });
  // The plan filter and the runner each refuse; this checks the runner by skipping the plan filter.
  const outcome = await executePlaywrightLabShot({
    page: fake.page, shot, manifest: {}, assetsDir: path.join(home, "a"), screenshotsDir: path.join(home, "s"), mode: "headed", env: {}, trace,
    auth: gateOf({ settleMs: 0 }),
  });
  assert.equal(outcome.status, "captured");
  assert.deepEqual(fake.log.clicks, ["Settings", "Memory"], "only harmless controls were clicked");
  const step = outcome.executedSteps.find((s) => s.action === "stepThrough");
  assert.deepEqual(step.blocked.sort(), ["Account manager", "More options", "Sign in", "Sign out", "Switch account"]);
  const events = trace.lines.map((l) => JSON.parse(l));
  assert.ok(events.some((e) => e.event === "click-blocked" && /link is account/.test(e.reason)));
});

// ── Signing in once per product per job ──────────────────────────────────────

const quickRun = { authSettleMs: 0, authPollMs: 5, authGraceMs: 0 };

function recordingClient() {
  const calls = { statuses: [], notes: [], completes: [], uploads: [], heartbeats: [] };
  return {
    calls,
    async heartbeat(body) {
      calls.heartbeats.push(body);
      return {};
    },
    async progress(_id, body) {
      if (body.shot) calls.statuses.push(`${body.shot.filename}:${body.shot.status}`);
      if (body.message) calls.notes.push(body.message);
      if (body.shot?.error) calls.statuses.push(`  ${body.shot.error}`);
      return { ok: true };
    },
    async upload(_id, filename) {
      calls.uploads.push(filename);
      return { status: 200, body: { outcome: "accepted" } };
    },
    async complete(_id, body) {
      calls.completes.push(body);
      return {};
    },
  };
}

const planShot = (filename, extra = {}) => ({
  filename, shotId: filename, featureId: "f", moduleTitle: "M", product: "copilot-studio", authProfile: "copilot-studio",
  startUrl: APP, viewport: { width: 1440, height: 900 }, manual: false, requiresEnv: null, expectedLabels: ["Settings"], callouts: [],
  steps: [{ action: "navigate", url: APP }, { action: "screenshot" }],
  ...extra,
});
const claimed = (shots) => ({ job: { id: "job_0123456789abcdef", target: { type: "lab", labId: "lab-a" }, scope: {}, options: { callouts: "none", redact: true }, createdAt: new Date().toISOString(), resumed: false }, env: {}, shots });

test("the person is asked to sign in once for the whole product, not once per shot, and the session is kept", async (t) => {
  const home = tmpDir(t);
  let signedIn = false;
  const fake = createFakePlaywright({ rewriteUrl: (u) => (signedIn ? u : LOGIN) });
  let ticks = 0;
  const sleepFn = async () => {
    ticks += 1;
    if (ticks === 6 && !signedIn) {
      signedIn = true;
      fake.signIn({ persistent: false });
    }
  };
  const client = recordingClient();
  const log = collectLog();
  const result = await runJobReal({ client, claimed: claimed([planShot("a.png"), planShot("b.png"), planShot("c.png")]), home, playwright: fake.playwright, options: { ...quickRun, browserKinds: ["edge"] }, log, sleepFn, heartbeatMs: 60_000 });
  assert.equal(result.tally.captured, 3);
  assert.equal((log.text().match(/Waiting for you to sign in to Microsoft Copilot Studio/g) || []).length, 1, "one waiting message on the console");
  assert.equal(client.calls.notes.filter((n) => /Waiting for you to sign in/.test(n)).length, 1, "one waiting message in the portal");
  assert.match(client.calls.notes[0], /This computer remembers it afterwards/);
  assert.equal(fake.log.launched.length, 1);
  assert.equal(fake.log.launched[0].dir, path.join(home, ".auth", "edge", "copilot-studio"));
  assert.equal(fake.log.launched[0].options.channel, "msedge", "the installed Edge is opened");
  assert.match(log.text(), /Opened Microsoft Edge\./);
  assert.deepEqual(listSignedInProfiles(home), ["copilot-studio"]);
  assert.ok(fs.existsSync(path.join(home, ".auth", "edge", "copilot-studio", "companion-session.json")), "the session is saved after a successful capture");
  assert.deepEqual(client.calls.heartbeats, [], "no heartbeat ran in this short job");
  assert.match(log.text(), /so you will not need to sign in again/);

  // The next job, with a new browser, gets the session back and is not asked again.
  const again = createFakePlaywright();
  const log2 = collectLog();
  const second = await runJobReal({ client: recordingClient(), claimed: claimed([planShot("d.png")]), home, playwright: again.playwright, options: { ...quickRun, browserKinds: ["edge"] }, log: log2, sleepFn: async () => {}, heartbeatMs: 60_000 });
  assert.equal(second.tally.captured, 1);
  assert.equal(again.live.context.added.length, 1, "the saved session cookie was restored");
  assert.match(log2.text(), /Your saved sign-in was restored/);
  assert.doesNotMatch(log2.text(), /Waiting for you to sign in/);
});

test("when sign-in does not work, the product's remaining shots stop at once and are reported once with what to do", async (t) => {
  const home = tmpDir(t);
  const fake = createFakePlaywright({ rewriteUrl: () => LOGIN });
  const client = recordingClient();
  const log = collectLog();
  const shots = [planShot("a.png"), planShot("b.png"), planShot("m.png", { manual: true }), planShot("c.png"), planShot("d.png")];
  const result = await runJobReal({ client, claimed: claimed(shots), home, playwright: fake.playwright, options: { ...quickRun, signInWaitSec: 0.2, browserKinds: ["edge"] }, log, sleepFn: async () => {}, heartbeatMs: 60_000 });
  assert.equal(result.tally.captured, 0);
  assert.equal(result.tally.failed, 4);
  assert.equal(result.tally.manual, 1);
  assert.equal(fake.log.goto.length, 1, "the browser went to the page once and never again");
  assert.equal(fake.log.screenshots, 0);
  const authReports = client.calls.statuses.filter((s) => /:auth-required$/.test(s));
  assert.deepEqual(authReports, ["a.png:auth-required", "b.png:auth-required", "c.png:auth-required", "d.png:auth-required"]);
  assert.ok(client.calls.statuses.includes("m.png:manual-required"));
  const messages = client.calls.statuses.filter((s) => s.startsWith("  "));
  assert.equal(new Set(messages).size, 1, "every shot carries the same single message");
  assert.match(messages[0], /Sign in to Microsoft Copilot Studio on your computer, then retry the 4 screenshots\./);
  assert.equal((log.text().match(/Waiting for you to sign in/g) || []).length, 1);
  assert.match(log.text(), /Why some screenshots did not run:/);
  assert.match(log.text(), /- 4 screenshots: .*retry the 4 screenshots/);
  assert.match(log.text(), /- 1 screenshot: This screen is outside the browser/);
  assert.equal(result.signInFailures.length, 1);
  assert.deepEqual(result.capturedProducts, []);
  assert.equal(result.notRun.length, 5);
  assert.deepEqual(listSignedInProfiles(home), [], "a profile folder that never signed in is not reported as signed in");
});

test("each product signs in once and one product failing does not stop another", async (t) => {
  const home = tmpDir(t);
  const fake = createFakePlaywright({ rewriteUrl: (u) => (/make\.powerapps/.test(u) ? LOGIN : u) });
  const client = recordingClient();
  const shots = [planShot("a.png"), planShot("p1.png", { authProfile: "power-platform-ai-hub", product: "power-platform-ai-hub", startUrl: "https://make.powerapps.com/", steps: [{ action: "navigate", url: "https://make.powerapps.com/" }, { action: "screenshot" }] }), planShot("b.png")];
  const result = await runJobReal({ client, claimed: claimed(shots), home, playwright: fake.playwright, options: { ...quickRun, signInWaitSec: 0.2, browserKinds: ["edge"] }, log: () => {}, sleepFn: async () => {}, heartbeatMs: 60_000 });
  assert.equal(result.tally.captured, 2);
  assert.deepEqual(result.signInFailures.map((f) => f.product), ["power-platform-ai-hub"]);
  assert.deepEqual(result.capturedProducts, ["copilot-studio"]);
  assert.deepEqual(fake.log.launched.map((l) => path.basename(l.dir)), ["copilot-studio", "power-platform-ai-hub"], "each product has its own profile");
});

test("a sign-in page that is only recognized from the picture counts as not signed in and stops the rest", async (t) => {
  const home = tmpDir(t);
  const fake = createFakePlaywright({ title: "Sign in to your account" });
  const client = recordingClient();
  const result = await runJobReal({ client, claimed: claimed([planShot("a.png"), planShot("b.png"), planShot("c.png")]), home, playwright: fake.playwright, options: { ...quickRun, browserKinds: ["chromium"] }, log: () => {}, sleepFn: async () => {}, heartbeatMs: 60_000 });
  assert.equal(result.tally.captured, 0);
  assert.equal(fake.log.screenshots, 1, "only the first picture was taken");
  assert.deepEqual(client.calls.statuses.filter((s) => /:auth-required$/.test(s)).length, 3);
});

test("with --headless the companion does not wait for a sign-in it cannot receive", async (t) => {
  const home = tmpDir(t);
  const fake = createFakePlaywright({ rewriteUrl: () => LOGIN });
  const client = recordingClient();
  const started = Date.now();
  const result = await runJobReal({ client, claimed: claimed([planShot("a.png"), planShot("b.png")]), home, playwright: fake.playwright, options: { ...quickRun, headless: true, browserKinds: ["chromium"] }, log: () => {}, heartbeatMs: 60_000 });
  assert.ok(Date.now() - started < 5000);
  assert.equal(result.tally.failed, 2);
  assert.ok(client.calls.statuses.some((s) => /--headless/.test(s)));
  assert.equal(fake.log.launched[0].options.headless, true);
});

// ── Browsers ─────────────────────────────────────────────────────────────────

test("--browser is parsed, and auto prefers an installed Edge, then Chrome, then the bundled Chromium", () => {
  assert.equal(parseArgs([]).browser, "auto");
  assert.equal(parseArgs(["--browser=edge"]).browser, "edge");
  assert.equal(parseArgs(["--browser", "chrome"]).browser, "chrome");
  assert.equal(parseArgs(["--browser=msedge"]).browser, "edge");
  assert.match(parseArgs(["--browser=firefox"]).error, /--browser must be auto, edge, chrome, or chromium/);
  assert.match(parseArgs(["--browser"]).error, /--browser needs a value/);
  assert.deepEqual(parseBrowserChoice("Chromium"), { ok: true, browser: "chromium" });

  assert.deepEqual(chooseBrowsers({ requested: "auto", installed: { edge: true, chrome: true, chromium: true } }).kinds, ["edge", "chrome", "chromium"]);
  assert.deepEqual(chooseBrowsers({ requested: "auto", installed: { chrome: true, chromium: true } }).kinds, ["chrome", "chromium"]);
  assert.deepEqual(chooseBrowsers({ requested: "auto", installed: { chromium: true } }).kinds, ["chromium"]);
  assert.deepEqual(chooseBrowsers({ requested: "edge", installed: { edge: true, chrome: true } }).kinds, ["edge"], "an explicit choice never falls back");
  const none = chooseBrowsers({ requested: "edge", installed: { chrome: true } });
  assert.equal(none.ok, false);
  assert.match(none.message, /Microsoft Edge was not found/);
  assert.match(chooseBrowsers({ requested: "auto", installed: {} }).message, /Install Microsoft Edge or Google Chrome, or run: npx playwright install chromium/);
  assert.match(missingBrowserMessage("chromium"), /npx playwright install chromium/);
});

test("installed browsers are found from their usual places on each system, without starting them", () => {
  const win = { platform: "win32", env: { PROGRAMFILES: "C:\\Program Files", "PROGRAMFILES(X86)": "C:\\Program Files (x86)", LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" } };
  assert.ok(browserCandidates(win).edge.includes("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"));
  assert.ok(browserCandidates(win).chrome.includes("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"));
  const found = detectInstalledBrowsers({ ...win, exists: (file) => file.endsWith("msedge.exe") && file.startsWith("C:\\Program Files (x86)") });
  assert.equal(found.edge, "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe");
  assert.equal(found.chrome, null);
  assert.ok(browserCandidates({ platform: "darwin", env: {} }).edge[0].includes("Microsoft Edge.app"));
  assert.ok(browserCandidates({ platform: "linux", env: {} }).chrome.includes("/usr/bin/google-chrome"));
  assert.equal(isMissingBrowserError(new Error("browserType.launchPersistentContext: Chromium distribution 'msedge' is not found at C:\\x")), true);
  assert.equal(isMissingBrowserError(new Error("Executable doesn't exist at /x")), true);
  assert.equal(isMissingBrowserError(new Error("Target page, context or browser has been closed")), false);
});

test("preflight accepts an installed Edge without Chromium, and explains what is missing otherwise", async () => {
  const detect = (extra) => async () => ({ playwrightInstalled: true, chromiumInstalled: false, edgeInstalled: false, chromeInstalled: false, ...extra });
  const ok = collectLog();
  const ready = await preflight({ home: "/x", log: ok, nodeVersion: "24.0.0", detect: detect({ edgeInstalled: true }) });
  assert.equal(ready.ok, true);
  assert.deepEqual(ready.kinds, ["edge"]);
  const wantsChrome = collectLog();
  assert.equal((await preflight({ home: "/x", log: wantsChrome, nodeVersion: "24.0.0", browser: "chrome", detect: detect({ edgeInstalled: true }) })).ok, false);
  assert.match(wantsChrome.text(), /Google Chrome was not found/);
  const nothing = collectLog();
  assert.equal((await preflight({ home: "/x", log: nothing, nodeVersion: "24.0.0", detect: detect({}) })).ok, false);
  assert.match(nothing.text(), /Install Microsoft Edge or Google Chrome/);
  assert.match(nothing.text(), /--install-browser/);
});

test("a browser that is not installed is skipped for the next one, and an explicit choice reports a clear message", async (t) => {
  const home = tmpDir(t);
  const missing = (_dir, options) => (options.channel === "msedge" ? new Error("browserType.launchPersistentContext: Chromium distribution 'msedge' is not found at C:\\x. Run \"npx playwright install msedge\"") : null);
  const fake = createFakePlaywright({ launchError: missing });
  const log = collectLog();
  const opened = await openProfile({ playwright: fake.playwright, home, profile: "copilot-studio", kinds: ["edge", "chrome", "chromium"], log });
  assert.equal(opened.kind, "chrome");
  assert.equal(opened.dir, path.join(home, ".auth", "chrome", "copilot-studio"), "profiles are kept apart per browser");
  assert.match(log.text(), /Microsoft Edge was not found\. Trying the next browser\./);
  assert.match(log.text(), /Opened Google Chrome\./);
  await assert.rejects(openProfile({ playwright: fake.playwright, home, profile: "copilot-studio", kinds: ["edge"], log: () => {} }), (err) => err.code === "BROWSER_MISSING" && /Microsoft Edge was not found/.test(err.message));

  const client = recordingClient();
  const result = await runJobReal({ client, claimed: claimed([planShot("a.png")]), home, playwright: createFakePlaywright({ launchError: missing }).playwright, options: { ...quickRun, browserKinds: ["edge"] }, log, sleepFn: async () => {}, heartbeatMs: 60_000 });
  assert.equal(result.tally.failed, 1);
  assert.ok(client.calls.statuses.some((s) => /Microsoft Edge was not found/.test(s)));
});

// ── The trace ────────────────────────────────────────────────────────────────

test("the trace keeps hosts, paths, and decisions, and nothing private", (t) => {
  const file = path.join(tmpDir(t), "trace.log");
  const trace = createTrace({ file, terms: ["Acme Corp"], header: { companion: "1.1.0" } });
  trace.event("page-check", {
    address: "https://login.microsoftonline.com/0f1d2c3b-aaaa-4bbb-8ccc-1234567890ab/oauth2/authorize?client_id=abc&code=SUPERSECRETCODE&login_hint=ada@contoso.com",
    note: "Signed in as ada.lovelace@contoso.com for Acme Corp; cookie ESTSAUTH=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop and token QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5",
    decision: "treated as sign-in because host=login.microsoftonline.com",
    ms: 120,
    cookies: { secret: "x" },
    "bad key!": "x",
  });
  const written = fs.readFileSync(file, "utf8");
  for (const secret of ["SUPERSECRETCODE", "client_id", "login_hint", "ada@contoso.com", "ada.lovelace", "Acme Corp", "eyJhbGci", "QUJDREVG", "0f1d2c3b", "secret", "bad key"]) {
    assert.ok(!written.includes(secret), `the trace never contains ${secret}`);
  }
  const entry = JSON.parse(written.trim().split("\n").at(-1));
  assert.equal(entry.decision, "treated as sign-in because host=login.microsoftonline.com");
  assert.equal(entry.ms, 120);
  assert.match(entry.address, /^https:\/\/login\.microsoftonline\.com\/\{id\}\/oauth2\/authorize$/);
  assert.equal(typeof entry.t, "number");
  assert.equal(redactTraceText("go to https://a.example.com/x?y=1#z now"), "go to https://a.example.com/x now");
  assert.equal(traceFilePath("/home/x", "mine.log"), path.resolve("/home/x", "mine.log"));
  assert.match(traceFilePath("/home/x", null, () => 0).replace(/\\/g, "/"), /\/home\/x\/\.captures\/traces\/companion-1970-01-01T00-00-00-000Z\.log$/);
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o077, 0);
});

test("--debug and --trace write a trace of the sign-in decisions under the companion folder and print where it is", async (t) => {
  const home = tmpDir(t);
  const fake = createFakePlaywright({ rewriteUrl: () => LOGIN });
  const client = recordingClient();
  let served = false;
  client.next = async () => (served ? null : ((served = true), claimed([planShot("a.png"), planShot("b.png")])));
  saveConfig(home, { portal: "http://127.0.0.1:9", token: TOKEN, deviceId: "dev_x", deviceName: "PC" });
  const log = collectLog();
  const code = await runCompanion(["--once", "--debug", `--home=${home}`, "--browser=edge"], {
    log, client, playwright: fake.playwright, noSignals: true, nonInteractive: true,
    preflight: async () => ({ ok: true, problems: [], kinds: ["edge"] }),
    runnerOptions: { ...quickRun, signInWaitSec: 0.1 }, sleepFn: async () => {},
  });
  assert.equal(code, EXIT.ok);
  const printed = log.text().match(/Writing a debug trace to (.+?)\. It holds/);
  assert.ok(printed, "the trace path is printed");
  const file = printed[1];
  assert.ok(file.startsWith(path.join(home, ".captures", "traces")), "the trace is under the companion folder");
  const events = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(events.some((e) => e.event === "page-check" && /treated as sign-in because host=login\.microsoftonline\.com/.test(e.decision)));
  assert.ok(events.some((e) => e.event === "sign-in-failed" && e.code === "timeout"));
  assert.ok(!fs.readFileSync(file, "utf8").includes("client_id"), "no query strings");
  assert.match(log.text(), /Debug trace saved: /);

  const named = collectLog();
  const again = createFakePlaywright();
  served = false;
  await runCompanion(["--once", "--trace=my-trace.log", `--home=${home}`], { log: named, client, playwright: again.playwright, noSignals: true, nonInteractive: true, preflight: async () => ({ ok: true, problems: [] }), runnerOptions: quickRun, sleepFn: async () => {} });
  assert.ok(fs.existsSync(path.join(home, "my-trace.log")), "--trace=<file> implies --debug");
  assert.match(parseArgs(["--trace"]).error, /--trace needs a file name/);
});

// ── --status and --forget-signin ─────────────────────────────────────────────

test("--status lists the sign-in state of each product, even when the portal cannot be reached", async (t) => {
  const home = tmpDir(t);
  saveConfig(home, { portal: "http://127.0.0.1:1", token: TOKEN, deviceId: "dev_x", deviceName: "PC" });
  const dir = profileDir(home, "edge", "copilot-studio");
  await saveSession({ context: { storageState: async () => ({ cookies: [{ name: "a", value: "b", expires: -1 }] }) }, dir, product: "copilot-studio", browser: "edge", captured: true });
  const log = collectLog();
  const code = await runCompanion(["--status", `--home=${home}`], { log, noSignals: true, nonInteractive: true, preflight: async () => ({ ok: true, problems: [], kinds: ["edge"] }) });
  assert.equal(code, EXIT.unreachable);
  assert.match(log.text(), /Cannot reach the portal/);
  assert.match(log.text(), /Microsoft Copilot Studio \(copilot-studio\): signed in/);
  assert.match(log.text(), /Microsoft Edge: profile saved yes, session saved yes/);
});

test("--forget-signin removes one product's saved sign-in, or all of them, and needs no portal or browser", async (t) => {
  const home = tmpDir(t);
  for (const product of ["copilot-studio", "ai-foundry"]) {
    await saveSession({ context: { storageState: async () => ({ cookies: [{ name: "a", value: "b", expires: -1 }] }) }, dir: profileDir(home, "edge", product), product, browser: "edge", captured: true });
  }
  const one = collectLog();
  assert.equal(await runCompanion(["--forget-signin=copilot-studio", `--home=${home}`], { log: one }), EXIT.ok);
  assert.match(one.text(), /Removed the saved sign-in \(edge\/copilot-studio\)/);
  assert.deepEqual(listSignedInProfiles(home), ["ai-foundry"]);
  const none = collectLog();
  await runCompanion(["--forget-signin=copilot-studio", `--home=${home}`], { log: none });
  assert.match(none.text(), /There is no saved sign-in for copilot-studio/);
  await runCompanion(["--forget-signin=all", `--home=${home}`], { log: collectLog() });
  assert.deepEqual(listSignedInProfiles(home), []);
  assert.match(parseArgs(["--forget-signin=../x"]).error, /--forget-signin needs a product name/);
  assert.match(parseArgs(["--forget-signin"]).error, /--forget-signin needs a product name/);
});

// ── Watch mode never loops on sign-in ────────────────────────────────────────

test("--watch pauses, then stops picking up jobs, when jobs keep ending without a sign-in", async (t) => {
  const home = tmpDir(t);
  saveConfig(home, { portal: "http://127.0.0.1:9", token: TOKEN, deviceId: "dev_x", deviceName: "PC" });
  const fake = createFakePlaywright({ rewriteUrl: () => LOGIN });
  const client = recordingClient();
  let nextCalls = 0;
  let number = 0;
  client.next = async () => {
    nextCalls += 1;
    number += 1;
    return { ...claimed([planShot(`a${number}.png`), planShot(`b${number}.png`)]), job: { ...claimed([]).job, id: `job_00000000000000${String(number).padStart(2, "0")}` } };
  };
  const sleeps = [];
  const log = collectLog();
  const code = await runCompanion([`--home=${home}`, "--watch"], {
    log, client, playwright: fake.playwright, noSignals: true, nonInteractive: true, pollMs: 1000,
    preflight: async () => ({ ok: true, problems: [], kinds: ["edge"] }),
    runnerOptions: { ...quickRun, signInWaitSec: 0.1 },
    sleepFn: async (ms) => { sleeps.push(ms); },
    shouldStop: () => nextCalls > 20,
  });
  assert.equal(code, EXIT.signIn, "it stops by itself after three jobs in a row without a sign-in");
  assert.equal(nextCalls, 3, "and asked for exactly three jobs");
  assert.match(log.text(), /Waiting 30 seconds before taking another job/);
  assert.match(log.text(), /Waiting 60 seconds before taking another job/);
  assert.match(log.text(), /Microsoft Copilot Studio did not work 3 jobs in a row, so I will stop picking up capture jobs on my own/);
  assert.match(log.text(), /--debug/);
  assert.equal(fake.log.launched.length, 3, "one browser per job, one sign-in wait per job");
  const held = sleeps.filter((ms) => ms === 1000).length;
  assert.ok(held >= 30 + 60 - 2, "the pauses are real waits between polls, not skipped");
});

test("a job that the portal keeps handing back is closed instead of run again and again", async (t) => {
  const home = tmpDir(t);
  saveConfig(home, { portal: "http://127.0.0.1:9", token: TOKEN, deviceId: "dev_x", deviceName: "PC" });
  const fake = createFakePlaywright();
  const client = recordingClient();
  let nextCalls = 0;
  client.next = async () => { nextCalls += 1; return claimed([planShot("a.png")]); };
  const log = collectLog();
  await runCompanion([`--home=${home}`, "--watch"], {
    log, client, playwright: fake.playwright, noSignals: true, nonInteractive: true, pollMs: 10,
    preflight: async () => ({ ok: true, problems: [], kinds: ["chromium"] }),
    runnerOptions: quickRun, sleepFn: async () => {}, shouldStop: () => nextCalls >= 5,
  });
  assert.equal(client.calls.uploads.length, 2, "it ran the job twice at most");
  assert.match(log.text(), /Closing it instead of running it again/);
  assert.ok(client.calls.completes.some((c) => /Closed by the companion/.test(c.message)));
});

test("captureShot without a shared gate still waits for sign-in only as long as it was told to", async (t) => {
  const home = tmpDir(t);
  const fake = createFakePlaywright({ rewriteUrl: () => LOGIN });
  const outcome = await captureShotReal({ page: fake.page, shot: planShot("a.png"), assetsDir: path.join(home, "a"), screenshotsDir: path.join(home, "s"), env: {}, redact: true, terms: [], calloutMode: "none", log: () => {}, signInWaitMs: 60, sleepFn: async () => {} });
  assert.equal(outcome.status, "auth-required");
  assert.equal(fake.log.screenshots, 0);
});

test("the sign-in modules never drive a page or hide that the browser is automated", () => {
  for (const file of ["auth.mjs", "browsers.mjs", "guard.mjs", "trace.mjs"]) {
    const source = fs.readFileSync(path.join(TOOL_DIR, file), "utf8");
    assert.ok(!/\.(fill|type|press|pressSequentially|setInputFiles|selectOption|check|uncheck|goto)\s*\(/.test(source), `${file} never drives a page`);
    assert.ok(!/\b(?:userAgent|webdriver|stealth|evasion|--disable-blink-features|AutomationControlled)\b/i.test(source), `${file} never hides that the browser is automated`);
  }
});
