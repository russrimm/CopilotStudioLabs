// Hermetic tests for the portal side of the account choice: what a companion may report about its account (flags only),
// the request that asks a computer to open the sign-in window, the job state when a capture stops because of the account,
// and the companion download. Every id, address, and account below is fake.

import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cleanAccount, cleanAccountSetup, cleanNeedsAccount, ACCOUNT_MIN_COMPANION } from "../lib/capture/account.js";
import { createCapturePlatform } from "../lib/capture/index.js";
import { createPairingStore } from "../lib/capture/pairing.js";
import { buildCompanionZip, COMPANION_FILES } from "../lib/capture/companion-zip.js";
import { registerCaptureRoutes } from "../lib/capture/routes.js";
import { summarizeCauses } from "../lib/capture/jobs.js";
import { CAUSES } from "../../tools/screenshot-capture/causes.mjs";

const tmp = (prefix) => mkdtempSync(join(tmpdir(), prefix));
const FAKE_TENANT = "0a1b2c3d-1111-4222-8333-444455556666";
const FAKE_UPN = "ada.fake@example.invalid";
const AGENT_URL = `https://copilotstudio.microsoft.com/environments/Default-${FAKE_TENANT}/bots/00000000-0000-0000-0000-0000000000a1/overview`;
const GOOD = { mode: "separate", source: "manual", verified: true, verifiedFor: "agent", osWorkAccountDetected: true, browser: "chromium", inOsTenant: false, inPrivate: false };

function platform(t, extra = {}) {
  const root = tmp("capture-account-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return createCapturePlatform({ generatedRoot: join(root, "generated"), env: { PORTAL_STORAGE_ROOT: root }, dataDir: root, detectServerBrowser: async () => ({ available: false }), ...extra });
}

function pair(p, { name = "TEST-PC", version = "1.5.0" } = {}) {
  const code = p.pairing.createCode({ createdBy: "test" });
  const paired = p.pairing.exchangeCode(code.code, { deviceName: name, companionVersion: version, platform: "win32" });
  p.pairing.heartbeat(paired.device.id, { companionVersion: version });
  return paired;
}

// ── What a companion may say about its account ───────────────────────────────

test("the account facts are flags and short words, and anything shaped like an address or an account is dropped", () => {
  assert.deepEqual(cleanAccount(GOOD), GOOD);
  assert.equal(cleanAccount(undefined), null, "an older companion says nothing");
  assert.equal(cleanAccount("manual"), null);
  assert.equal(cleanAccount([]), null);
  const dirty = cleanAccount({ ...GOOD, source: FAKE_UPN, mode: "everything", browser: "firefox", verifiedFor: AGENT_URL, accountName: FAKE_UPN, tenantId: FAKE_TENANT, inOsTenant: "yes", osWorkAccountDetected: 1 });
  assert.deepEqual(dirty, { mode: "separate", source: "unknown", verified: true, osWorkAccountDetected: null, browser: null, inOsTenant: null, inPrivate: false, verifiedFor: null });
  assert.ok(!JSON.stringify(dirty).includes(FAKE_TENANT));
  assert.ok(!JSON.stringify(dirty).includes(FAKE_UPN));

  assert.deepEqual(cleanAccountSetup({ id: "cmd_abc123", product: "copilot-studio", state: "waiting-for-you", message: "Sign in" }), { id: "cmd_abc123", product: "copilot-studio", state: "waiting-for-you", message: "Sign in" });
  assert.equal(cleanAccountSetup({ id: "cmd_abc123", product: "copilot-studio", state: "hacked", message: "x" }), null);
  assert.equal(cleanAccountSetup({ id: "../x", product: "copilot-studio", state: "done" }), null);
  const message = cleanAccountSetup({ id: "cmd_abc123", product: "copilot-studio", state: "failed", message: `Went to ${AGENT_URL} as ${FAKE_UPN} in ${FAKE_TENANT}` }).message;
  for (const secret of [FAKE_UPN, FAKE_TENANT, "https://", "copilotstudio.microsoft.com"]) assert.ok(!message.includes(secret), `the message holds no ${secret}`);

  const needs = cleanNeedsAccount({ product: "copilot-studio", code: "windows-account", message: `Edge signed in as ${FAKE_UPN}. Restart with --browser=chromium.` });
  assert.equal(needs.code, "windows-account");
  assert.ok(!needs.message.includes(FAKE_UPN));
  assert.equal(cleanNeedsAccount({ code: "windows-account", message: "" }), null);
  assert.equal(cleanNeedsAccount({ code: "something", message: "A sentence." }).code, "wrong-account");
});

// ── Pairing: what is kept and what is asked ──────────────────────────────────

test("a heartbeat records the account flags, a companion that says nothing has none, and the status shows the latest report", (t) => {
  const p = platform(t);
  const old = pair(p, { name: "OLD-PC", version: "1.4.0" });
  assert.equal(p.pairing.status().account, null, "no report yet");
  assert.equal(p.pairing.listDevices().find((d) => d.id === old.device.id).account, null);

  const fresh = pair(p, { name: "NEW-PC" });
  p.pairing.heartbeat(fresh.device.id, { account: GOOD });
  const status = p.pairing.status();
  assert.deepEqual(status.account, GOOD);
  assert.deepEqual(status.devices.find((d) => d.id === fresh.device.id).account, GOOD);
  assert.equal(status.devices.find((d) => d.id === old.device.id).account, null, "the old companion still shows no account");

  // A heartbeat that leaves the account out keeps the last one; one that sends junk replaces it with nothing it can use.
  p.pairing.heartbeat(fresh.device.id, { busy: true });
  assert.deepEqual(p.pairing.status().account, GOOD);
  p.pairing.heartbeat(fresh.device.id, { account: { source: FAKE_UPN } });
  assert.equal(p.pairing.status().account.source, "unknown");
  const stored = JSON.stringify(p.pairing.listDevices());
  assert.ok(!stored.includes(FAKE_UPN));
});

test("a request for a computer is given once, replaced by a second click, and forgotten after ten minutes", (t) => {
  let now = 1_000_000;
  const dir = tmp("pairing-commands-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createPairingStore({ dir, now: () => now });
  const code = store.createCode();
  const paired = store.exchangeCode(code.code, { deviceName: "PC", companionVersion: "1.5.0", platform: "win32" });
  const id = paired.device.id;
  assert.equal(store.hasPendingCommands(id), false);
  assert.deepEqual(store.takeCommands(id), []);

  const first = store.queueCommand(id, { type: "setup-account", product: "copilot-studio", env: { CAPTURE_X: "https://x.example" }, targets: {} });
  assert.match(first.id, /^cmd_[a-f0-9]{12}$/);
  assert.equal(store.hasPendingCommands(id), true);
  assert.equal(store.listDevices()[0].accountSetup.state, "requested", "the portal can show that the request is waiting");
  const second = store.queueCommand(id, { type: "setup-account", product: "copilot-studio" });
  const taken = store.takeCommands(id);
  assert.deepEqual(taken.map((c) => c.id), [second.id], "one request per product");
  assert.deepEqual(store.takeCommands(id), [], "given once");
  assert.equal(store.hasPendingCommands(id), false);

  store.heartbeat(id, { accountSetup: { id: second.id, product: "copilot-studio", state: "waiting-for-you", message: "Sign in" } });
  assert.equal(store.status().accountSetup.state, "waiting-for-you");

  store.queueCommand(id, { type: "setup-account", product: "sharepoint-ai" });
  now += 11 * 60 * 1000;
  assert.equal(store.hasPendingCommands(id), false, "an old request is not run later");
  assert.deepEqual(store.takeCommands(id), []);
});

// ── The button: asking the connected computer ────────────────────────────────

test("choosing the account needs a connected companion that can do it, and tells the person what to do next", (t) => {
  const p = platform(t);
  assert.equal(p.requestAccountSetup({ product: "copilot-studio" }).status, 409);
  assert.equal(p.requestAccountSetup({ product: "copilot-studio" }).body.code, "no-companion");

  const old = pair(p, { name: "OLD-PC", version: "1.4.0" });
  const tooOld = p.requestAccountSetup({});
  assert.equal(tooOld.body.code, "companion-too-old");
  assert.match(tooOld.body.error, new RegExp(`older than ${ACCOUNT_MIN_COMPANION.replace(/\./g, "\\.")}.*--browser=chromium`));
  assert.deepEqual(p.accountCapability(), { connected: true, supported: false, minCompanion: ACCOUNT_MIN_COMPANION });

  const fresh = pair(p, { name: "NEW-PC" });
  p.pairing.heartbeat(fresh.device.id, { busy: true });
  assert.equal(p.requestAccountSetup({}).body.code, "busy", "not while a capture runs");
  p.pairing.heartbeat(fresh.device.id, { busy: false });
  const ok = p.requestAccountSetup({ product: "sharepoint-ai" });
  assert.equal(ok.status, 202);
  assert.equal(ok.body.requested, true);
  assert.equal(ok.body.product, "sharepoint-ai");
  assert.equal(ok.body.deviceName, "NEW-PC");
  assert.match(ok.body.message, /Look for a new browser window on NEW-PC.*You choose the account yourself; the computer never clicks for you\./);
  assert.equal(p.requestAccountSetup({ product: "../etc" }).body.product, "copilot-studio", "a bad product falls back, it is never used");
  assert.deepEqual(p.pairing.takeCommands(old.device.id), [], "only the computer that can do it is asked");
  assert.deepEqual(p.accountCapability(), { connected: true, supported: true, minCompanion: ACCOUNT_MIN_COMPANION });
});

test("the setup request carries the capture settings, so the landing can be checked against the person's own address", (t) => {
  const root = tmp("capture-account-env-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const p = createCapturePlatform({ generatedRoot: join(root, "generated"), env: { PORTAL_STORAGE_ROOT: root, CAPTURE_COPILOT_STUDIO_AGENT_URL: AGENT_URL }, dataDir: root, detectServerBrowser: async () => ({ available: false }) });
  const paired = pair(p);
  assert.equal(p.requestAccountSetup({ product: "copilot-studio" }).status, 202);
  const [command] = p.pairing.takeCommands(paired.device.id);
  assert.equal(command.type, "setup-account");
  assert.equal(command.env.CAPTURE_COPILOT_STUDIO_AGENT_URL, AGENT_URL, "the companion gets the address only in the request it fetches, never in what the browser reads");
  assert.ok(!JSON.stringify(p.pairing.status()).includes(FAKE_TENANT), "the status the page reads holds no address");
});

test("the status carries the account facts, whether the connected companion can report them, and the setup state", async (t) => {
  const p = platform(t);
  const none = await p.statusPayload();
  assert.equal(none.companion.account, null);
  assert.equal(none.companion.accountSupported, false);
  assert.equal(none.companion.accountMinCompanion, ACCOUNT_MIN_COMPANION);

  const fresh = pair(p);
  p.pairing.heartbeat(fresh.device.id, { account: GOOD, accountSetup: { id: "cmd_abc123", product: "copilot-studio", state: "done", message: "The account is chosen and saved." } });
  const status = await p.statusPayload();
  assert.deepEqual(status.companion.account, GOOD);
  assert.equal(status.companion.accountSupported, true);
  assert.equal(status.companion.accountSetup.state, "done");
  assert.ok(!JSON.stringify(status.companion).includes(FAKE_TENANT));
});

// ── Over HTTP, the way the real companion and the page call it ───────────────

async function call(base, method, path, { json, token } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (json !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${base}${path}`, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: res.status, json: parsed, headers: res.headers };
}

test("the button reaches the computer through the check-in, an empty job reply carries a wake header, and old companions are not disturbed", async (t) => {
  const root = tmp("capture-account-http-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  app.use((req, _res, next) => {
    req.body ??= {};
    next();
  });
  registerCaptureRoutes(app, { generatedRoot: join(root, "generated"), dataDir: root, env: { PORTAL_STORAGE_ROOT: root }, detectServerBrowser: async () => ({ available: false }) });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const issued = await call(base, "POST", "/api/capture/pair", { json: {} });
  const paired = await call(base, "POST", "/api/capture/companion/pair", { json: { code: issued.json.code, deviceName: "HTTP-PC", platform: "win32", companionVersion: "1.5.0" } });
  assert.equal(paired.status, 201);
  const token = paired.json.token;

  // Before the click: nothing to say, no header, no commands.
  assert.equal((await call(base, "GET", "/api/capture/companion/next", { token })).headers.get("x-companion-wake"), null);
  const first = await call(base, "POST", "/api/capture/companion/heartbeat", { token, json: { companionVersion: "1.5.0", busy: false, account: GOOD } });
  assert.equal(first.status, 200);
  assert.equal(first.json.commands, undefined);
  assert.deepEqual((await call(base, "GET", "/api/capture/status")).json.companion.account, GOOD);

  const click = await call(base, "POST", "/api/capture/account-setup", { json: { product: "copilot-studio" } });
  assert.equal(click.status, 202);
  const wake = await call(base, "GET", "/api/capture/companion/next", { token });
  assert.equal(wake.status, 204);
  assert.equal(wake.headers.get("x-companion-wake"), "1", "the next empty job reply tells the companion to check in now");
  const beat = await call(base, "POST", "/api/capture/companion/heartbeat", { token, json: { busy: false } });
  assert.equal(beat.json.commands.length, 1);
  assert.deepEqual({ type: beat.json.commands[0].type, product: beat.json.commands[0].product }, { type: "setup-account", product: "copilot-studio" });
  assert.equal(beat.json.commands[0].id, click.json.id);
  assert.equal((await call(base, "GET", "/api/capture/companion/next", { token })).headers.get("x-companion-wake"), null, "it was given once");
  assert.equal((await call(base, "POST", "/api/capture/companion/heartbeat", { token, json: { busy: false } })).json.commands, undefined);

  // The companion says how it is going; the page reads it from the status.
  await call(base, "POST", "/api/capture/companion/heartbeat", { token, json: { busy: true, accountSetup: { id: click.json.id, product: "copilot-studio", state: "waiting-for-you", message: "Sign in" } } });
  assert.equal((await call(base, "GET", "/api/capture/status")).json.companion.accountSetup.state, "waiting-for-you");
  // An unknown state or a made-up id is ignored, not stored.
  await call(base, "POST", "/api/capture/companion/heartbeat", { token, json: { accountSetup: { id: "x y", product: "copilot-studio", state: "waiting-for-you" } } });
  assert.equal((await call(base, "GET", "/api/capture/status")).json.companion.accountSetup, null);
});

// ── A capture that stops because of the account ──────────────────────────────

function queuedJob(p) {
  const queued = p.queueJob({ target: { type: "library", products: ["copilot-studio"] }, scope: { mode: "all" }, targets: { copilotStudioAgentUrl: AGENT_URL }, options: { mode: "smart" } });
  assert.equal(queued.status, 201, JSON.stringify(queued.body).slice(0, 200));
  return queued.body.job;
}

test("shots that stop on the account are their own state with their own cause, and the job says why", (t) => {
  const p = platform(t);
  const paired = pair(p);
  const job = queuedJob(p);
  const claimed = p.jobs.claimNext(paired.device);
  assert.equal(claimed.job.id, job.id);
  const names = claimed.plan.shots.map((s) => s.filename);
  assert.ok(names.length >= 2);
  const [a, b] = names;

  const reported = p.jobs.reportProgress(job.id, paired.device.id, { shot: { filename: a, status: "needs-account", message: `Edge signed in automatically with your Windows work account, not the account that owns this agent. Restart with --browser=chromium, or run --setup-account. (${FAKE_UPN})`, cause: "needs-account" } });
  assert.equal(reported.ok, true);
  const row = p.jobs.get(job.id).shots.find((s) => s.filename === a);
  assert.equal(row.status, "needs-account");
  assert.equal(row.cause, "needs-account");
  assert.ok(!JSON.stringify(row).includes(FAKE_UPN), "a message about the account holds no account name");
  assert.match(row.message, /Restart with --browser=chromium, or run --setup-account\./);

  const done = p.jobs.complete(job.id, paired.device.id, {
    message: "Finished.",
    account: { ...GOOD, source: "windows-sso", verified: false, verifiedFor: null, accountName: FAKE_UPN },
    needsAccount: { product: "copilot-studio", code: "windows-account", message: `Edge signed in automatically with your Windows work account. Restart with --browser=chromium, or run --setup-account. ${FAKE_UPN} ${AGENT_URL}` },
  });
  assert.equal(done.ok, true);
  const result = done.job.result;
  assert.equal(done.job.status, "failed", "nothing was captured: the job did not finish well");
  assert.equal(result.needsAccount.code, "windows-account");
  assert.match(result.needsAccount.message, /Restart with --browser=chromium, or run --setup-account\./);
  for (const secret of [FAKE_UPN, FAKE_TENANT, "https://"]) assert.ok(!JSON.stringify(result.needsAccount).includes(secret), `the stored reason holds no ${secret}`);
  assert.equal(result.account.source, "windows-sso");
  assert.equal(result.account.accountName, undefined, "only the known flags are kept");
  assert.match(done.job.error, /Restart with --browser=chromium/);
  assert.equal(result.failed >= 1, true, "the shot counts as failed");

  const causes = summarizeCauses(p.jobs.get(job.id).shots);
  const group = causes.find((c) => c.cause === "needs-account" || c.code === "needs-account");
  assert.ok(group, "the shots are grouped under the account cause");
  assert.equal(group.fixAction, "account");
  assert.equal(CAUSES["needs-account"].fixAction, "account");
  assert.match(CAUSES["needs-account"].fix, /Choose which account to use/);
  assert.ok(b);
});

test("a completion from an older companion has no account fields and nothing changes", (t) => {
  const p = platform(t);
  const paired = pair(p, { version: "1.4.0" });
  const job = queuedJob(p);
  const claimed = p.jobs.claimNext(paired.device);
  const [a] = claimed.plan.shots.map((s) => s.filename);
  p.jobs.reportProgress(job.id, paired.device.id, { shot: { filename: a, status: "failed", error: "The page did not open.", cause: "navigation-failed" } });
  const done = p.jobs.complete(job.id, paired.device.id, { message: "Finished." });
  assert.equal(done.job.result.account, undefined);
  assert.equal(done.job.result.needsAccount, undefined);
});

// ── The download ─────────────────────────────────────────────────────────────

test("the companion download carries the account modules and no sign-in, session, or account record", async () => {
  for (const file of ["account-source.mjs", "account-guard.mjs", "account-setup.mjs"]) assert.ok(COMPANION_FILES.includes(`tools/screenshot-capture/${file}`), `${file} is in the allowlist`);
  const { files } = await buildCompanionZip();
  for (const file of ["account-source.mjs", "account-guard.mjs", "account-setup.mjs"]) assert.ok(files.some((f) => f.endsWith(`/tools/screenshot-capture/${file}`)), `${file} is in the ZIP`);
  assert.ok(files.every((f) => !/(\.auth|companion-account\.json|companion-session\.json|companion-signin\.json|\.companion\.json|\.captures)/.test(f)), "no browser profile, session, account record, or pairing file");
});
