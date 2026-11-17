// Hermetic tests for the Local Capture Companion: a fake portal over real HTTP and
// a fake Playwright. No tenant, no browser, no real portal. One test uses a real
// browser when Playwright with Chromium is installed and skips itself otherwise.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  COMPANION_VERSION,
  EXIT,
  PortalError,
  captureShot as captureShotReal,
  clearConfig,
  configPath,
  createPortalClient,
  jobEnvironment,
  listSignedInProfiles,
  loadConfig,
  parseArgs,
  preflight,
  runCompanion,
  runJob as runJobReal,
  safeSteps,
  saveConfig,
  validatePortalUrl,
} from "../companion.mjs";
import { createAuthGate } from "../auth.mjs";
import { detectBrowserAvailability, loadPlaywrightModule } from "../lab-runner.mjs";
import {
  applyRedaction,
  buildSensitiveRegExp,
  burnCalloutMarkers,
  clearOverlays,
  collectVisibleLabels,
  findSensitiveSpans,
  scrubSensitiveText,
} from "../redact.mjs";
import { makePng } from "./fixtures/png.mjs";
import { createFakePlaywright } from "./fixtures/fake-playwright.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const TOOL_DIR = path.resolve(here, "..");
const REPO_ROOT = path.resolve(TOOL_DIR, "..", "..");
const TOKEN = "cap_FAKE_TOKEN_FOR_TESTS_0123456789abcdefghij";

// The fake pages answer instantly, so the sign-in gate does not need to watch a page settle.
const quickAuth = { authSettleMs: 0, authPollMs: 5, authGraceMs: 0 };
const runJob = (args) => runJobReal({ ...args, options: { ...quickAuth, signInWaitSec: 0.05, ...args.options } });
const captureShot = (args) => captureShotReal({ auth: createAuthGate({ product: "copilot-studio", waitMs: args.signInWaitMs ?? 50, settleMs: 0, pollMs: 5 }), ...args });

function tmpDir(t, prefix = "companion-") {
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

/** A portal that speaks the companion protocol and records every request. */
async function startFakePortal(t, scenario = {}) {
  const state = {
    token: TOKEN,
    requests: [],
    pairs: [],
    uploads: [],
    progress: [],
    completes: [],
    jobs: scenario.jobs ? [...scenario.jobs] : [],
    authError: scenario.authError || null,
    cancelAfterUploads: scenario.cancelAfterUploads ?? Infinity,
    uploadStatus: scenario.uploadStatus || null,
  };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url, "http://127.0.0.1");
    state.requests.push({ method: req.method, path: url.pathname, auth: req.headers.authorization || null, version: req.headers["x-companion-version"] || null });
    const send = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(body === null ? undefined : JSON.stringify(body));
    };
    if (req.method === "POST" && url.pathname === "/api/capture/companion/pair") {
      const body = JSON.parse(raw.toString() || "{}");
      state.pairs.push(body);
      return body.code === "ABCD-EFGH"
        ? send(201, { token: state.token, device: { id: "dev_abcdefabcdef", name: body.deviceName } })
        : send(401, { error: "That pairing code is not valid.", code: "pair-invalid" });
    }
    if (state.authError) return send(401, { error: "nope", code: state.authError });
    if (req.headers.authorization !== `Bearer ${state.token}`) return send(401, { error: "A capture token is required.", code: "token-missing" });
    if (url.pathname === "/api/capture/companion/heartbeat") return send(200, { ok: true, cancelRequested: false, tokenExpiresAt: "2030-01-01T00:00:00.000Z" });
    if (url.pathname === "/api/capture/companion/next") {
      const claimed = state.jobs.shift();
      return claimed ? send(200, claimed) : send(204, null);
    }
    const jobMatch = url.pathname.match(/^\/api\/capture\/companion\/jobs\/([^/]+)\/(progress|complete|shots)(?:\/(.+))?$/);
    if (jobMatch) {
      const [, jobId, kind, file] = jobMatch;
      if (kind === "progress") {
        state.progress.push(JSON.parse(raw.toString() || "{}"));
        return send(200, { ok: true, cancelRequested: state.uploads.length >= state.cancelAfterUploads });
      }
      if (kind === "complete") {
        state.completes.push({ jobId, ...JSON.parse(raw.toString() || "{}") });
        return send(200, { job: { id: jobId, status: "done" } });
      }
      const form = await new Response(raw, { headers: { "content-type": req.headers["content-type"] } }).formData();
      const image = form.get("file");
      state.uploads.push({
        jobId,
        filename: decodeURIComponent(file),
        partName: image?.name,
        bytes: Buffer.from(await image.arrayBuffer()),
        evidence: JSON.parse(form.get("evidence") || "{}"),
        callouts: form.get("callouts") ? JSON.parse(form.get("callouts")) : null,
      });
      if (state.uploadStatus) return send(state.uploadStatus.status, state.uploadStatus.body);
      return send(200, {
        outcome: "accepted",
        filename: decodeURIComponent(file),
        verification: { level: "pass", reasons: [] },
        cancelRequested: state.uploads.length >= state.cancelAfterUploads,
      });
    }
    return send(404, { error: "unknown" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  state.base = `http://127.0.0.1:${server.address().port}`;
  return state;
}

const baseShot = (overrides = {}) => ({
  filename: "mc-memory-toggle.png",
  shotId: "01-mc-memory-01",
  featureId: "mc-memory",
  moduleTitle: "Memory",
  product: "copilot-studio",
  authProfile: "copilot-studio",
  startUrl: "https://copilotstudio.microsoft.com/",
  viewport: { width: 1440, height: 900 },
  manual: false,
  requiresEnv: null,
  expectedLabels: ["Settings", "Memory"],
  callouts: [{ n: 1, label: "Memory", text: "Memory" }],
  steps: [
    { action: "navigate", url: "https://copilotstudio.microsoft.com/", waitUntil: "domcontentloaded" },
    { action: "waitForLoadState", state: "networkidle", timeoutMs: 100 },
    { action: "dismissBanners" },
    { action: "stepThrough", labels: ["Settings", "Delete agent"], instruction: "Select **Settings**.", interaction: "click-or-focus" },
    { action: "probeCallouts", callouts: [{ n: 1, label: "Memory", text: "Memory" }] },
    { action: "screenshot", fullPage: false },
  ],
  ...overrides,
});

const claimedJob = (shots, extra = {}) => ({
  job: {
    id: "job_0123456789abcdef",
    target: { type: "lab", labId: "lab-a" },
    scope: {},
    options: { callouts: "sidecar", redact: true },
    createdAt: new Date().toISOString(),
    resumed: false,
    ...extra.job,
  },
  env: extra.env || {},
  shots,
});

// ── Command line and pure helpers ────────────────────────────────────────────

test("parseArgs reads pairing, mode, and option flags and rejects unknown ones", () => {
  const opts = parseArgs(["--portal=https://p.example.com", "--code", "ABCD-EFGH", "--once", "--wait=30", "--callouts=burn", "--mask=Contoso,contoso.com", "--no-redact", "--interval=2", "--device-name=Ada PC", "--home=/tmp/x", "--headless"]);
  assert.equal(opts.portal, "https://p.example.com");
  assert.equal(opts.code, "ABCD-EFGH");
  assert.equal(opts.once, true);
  assert.equal(opts.watch, false);
  assert.equal(opts.waitSec, 30);
  assert.equal(opts.callouts, "burn");
  assert.deepEqual(opts.maskTerms, ["Contoso", "contoso.com"]);
  assert.equal(opts.redact, false);
  assert.equal(opts.headless, true);
  assert.equal(opts.intervalSec, 2);
  assert.equal(opts.deviceName, "Ada PC");
  assert.equal(parseArgs([]).watch, true);
  assert.equal(parseArgs(["--watch"]).watch, true);
  assert.match(parseArgs(["--bogus"]).error, /--bogus/);
  assert.match(parseArgs(["--callouts=huge"]).error, /--callouts/);
});

test("portal addresses must be https, or http only for this computer", () => {
  assert.deepEqual(validatePortalUrl("https://portal.example.com/some/path?q=1"), { ok: true, portal: "https://portal.example.com" });
  assert.equal(validatePortalUrl("http://localhost:3005").portal, "http://localhost:3005");
  assert.equal(validatePortalUrl("http://127.0.0.1:3010").ok, true);
  for (const bad of ["", "portal.example.com", "http://portal.example.com", "ftp://x.example.com", "https://user:pw@portal.example.com", "javascript:alert(1)"]) {
    const result = validatePortalUrl(bad);
    assert.equal(result.ok, false, bad);
    assert.ok(result.error.length > 10);
  }
});

test("job environment keeps only CAPTURE_* https addresses", () => {
  const env = jobEnvironment(
    { CAPTURE_SHAREPOINT_SITE_URL: "https://contoso.sharepoint.com/sites/x", CAPTURE_BAD: "http://insecure", PATH: "https://evil.example.com", NODE_OPTIONS: "--inspect" },
    { PATH: "/usr/bin", KEEP: "1" },
  );
  assert.equal(env.CAPTURE_SHAREPOINT_SITE_URL, "https://contoso.sharepoint.com/sites/x");
  assert.equal(env.CAPTURE_BAD, undefined);
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.KEEP, "1");
});

test("plan steps are limited to safe actions and never touch destructive controls or leave https", () => {
  const steps = safeSteps([
    { action: "navigate", url: "https://copilotstudio.microsoft.com/" },
    { action: "navigate", url: "file:///etc/passwd" },
    { action: "navigate", url: "http://insecure.example.com" },
    { action: "type", text: "secret" },
    { action: "fill", selector: "#x", value: "y" },
    { action: "evaluate", script: "alert(1)" },
    { action: "stepThrough", labels: ["Settings", "Delete agent", "Reset all"], instruction: "Select **Settings**." },
    { action: "stepThrough", labels: ["Remove connection"], instruction: "Select **Remove connection**." },
    { action: "click", labels: ["Memory"], instruction: "Delete the memory" },
    { action: "probeCallouts", callouts: [] },
  ]);
  assert.deepEqual(steps.map((s) => s.action), ["navigate", "stepThrough", "probeCallouts", "screenshot"]);
  assert.deepEqual(steps[1].labels, ["Settings"]);
  assert.equal(safeSteps(undefined).length, 1, "a screenshot step is always present");
});

test("account details are found and scrubbed from text", () => {
  const text = "Signed in as ada.lovelace@contoso.com on contoso.onmicrosoft.com; site fabrikam-admin.sharepoint.com; Acme Corp rocks";
  const spans = findSensitiveSpans(text, ["Acme Corp"]).map((s) => s.text);
  assert.deepEqual(spans, ["ada.lovelace@contoso.com", "contoso.onmicrosoft.com", "fabrikam-admin.sharepoint.com", "Acme Corp"]);
  assert.equal(scrubSensitiveText(text, ["Acme Corp"]), "Signed in as [hidden] on [hidden]; site [hidden]; [hidden] rocks");
  assert.equal(scrubSensitiveText("Settings and Memory"), "Settings and Memory");
  assert.ok(buildSensitiveRegExp(["ab"]).source.includes("onmicrosoft"), "terms shorter than 3 characters are ignored");
  assert.ok(!buildSensitiveRegExp(["ab"]).source.includes("|ab"));
});

test("the pairing file is kept out of git and holds the token only locally", (t) => {
  const home = tmpDir(t);
  assert.equal(loadConfig(home), null);
  saveConfig(home, { portal: "https://p.example.com", token: TOKEN, deviceId: "dev_x", deviceName: "PC" });
  assert.equal(loadConfig(home).token, TOKEN);
  if (process.platform !== "win32") assert.equal(fs.statSync(configPath(home)).mode & 0o077, 0, "only the owner can read the token");
  clearConfig(home);
  assert.equal(loadConfig(home), null);
  fs.writeFileSync(configPath(home), "{not json");
  assert.equal(loadConfig(home), null);

  const toolIgnore = fs.readFileSync(path.join(TOOL_DIR, ".gitignore"), "utf8");
  const rootIgnore = fs.readFileSync(path.join(REPO_ROOT, ".gitignore"), "utf8");
  for (const entry of [".companion.json", ".auth/", ".captures/"]) {
    assert.ok(toolIgnore.includes(entry), `tools/screenshot-capture/.gitignore covers ${entry}`);
    assert.ok(rootIgnore.includes(entry), `.gitignore covers ${entry}`);
  }
});

test("listSignedInProfiles reports only products whose sign-in has worked, not profile folders the browser created", (t) => {
  const home = tmpDir(t);
  assert.deepEqual(listSignedInProfiles(home), []);
  // A browser creates its profile folder the moment it opens, signed in or not.
  fs.mkdirSync(path.join(home, ".auth", "edge", "copilot-studio"), { recursive: true });
  fs.writeFileSync(path.join(home, ".auth", "edge", "copilot-studio", "Cookies"), "x");
  fs.mkdirSync(path.join(home, ".auth", "copilot-studio"), { recursive: true });
  fs.writeFileSync(path.join(home, ".auth", "copilot-studio", "Cookies"), "x");
  fs.mkdirSync(path.join(home, ".auth", "chromium", "Bad Name"), { recursive: true });
  assert.deepEqual(listSignedInProfiles(home), [], "a profile folder alone is not a sign-in");
  const dir = path.join(home, ".auth", "edge", "copilot-studio");
  fs.writeFileSync(path.join(dir, "companion-session.json"), JSON.stringify({ version: 1, cookies: [{ name: "a", value: "b" }] }));
  fs.writeFileSync(path.join(dir, "companion-signin.json"), JSON.stringify({ version: 1, product: "copilot-studio", browser: "edge", lastCapturedAt: "2026-01-02T03:04:05.000Z" }));
  assert.deepEqual(listSignedInProfiles(home), ["copilot-studio"]);
});

test("preflight explains in plain language what is missing", async () => {
  const log = collectLog();
  const old = await preflight({ home: "/x", log, nodeVersion: "18.19.0", detect: async () => ({ playwrightInstalled: false, chromiumInstalled: false }) });
  assert.equal(old.ok, false);
  assert.match(log.text(), /Node\.js 20 or later/);
  assert.match(log.text(), /npm install/);
  assert.match(log.text(), /npx playwright install chromium/);
  const noBrowser = collectLog();
  assert.equal((await preflight({ home: "/x", log: noBrowser, nodeVersion: "24.0.0", detect: async () => ({ playwrightInstalled: true, chromiumInstalled: false }) })).ok, false);
  assert.match(noBrowser.text(), /--install-browser/);
  const ready = collectLog();
  assert.equal((await preflight({ home: "/x", log: ready, nodeVersion: "24.0.0", detect: async () => ({ playwrightInstalled: true, chromiumInstalled: true }) })).ok, true);
  assert.equal(ready.lines.length, 0);
});

// ── One shot ─────────────────────────────────────────────────────────────────

test("captureShot hides account details before the picture and removes the overlays after", async (t) => {
  const home = tmpDir(t);
  const { page, log } = createFakePlaywright();
  const result = await captureShot({
    page,
    shot: baseShot(),
    assetsDir: path.join(home, "assets"),
    screenshotsDir: path.join(home, "screenshots"),
    env: {},
    redact: true,
    terms: [],
    calloutMode: "sidecar",
    log: () => {},
  });
  assert.equal(result.status, "captured");
  assert.equal(result.check.level, "pass");
  assert.equal(result.evidence.redaction.applied, true);
  assert.equal(result.evidence.redaction.masked, 3);
  assert.equal(result.evidence.finalUrl, "https://copilotstudio.microsoft.com/");
  assert.equal(result.evidence.title, "Copilot Studio");
  assert.ok(!result.evidence.visibleText.some((l) => l.includes("ada@contoso.com")), "account details never leave in evidence");
  assert.ok(result.evidence.visibleText.some((l) => l.includes("[hidden]")));
  const order = log.order.filter((n) => ["maskSensitiveInPage", "screenshot", "clearOverlaysInPage"].includes(n));
  assert.deepEqual(order, ["maskSensitiveInPage", "screenshot", "clearOverlaysInPage"]);
  assert.ok(!log.evaluations.includes("drawCalloutMarkersInPage"), "callouts are saved as positions, not drawn, by default");
  assert.deepEqual(log.clicks, ["Settings"], "the destructive control is never clicked");
  assert.equal(result.callouts[0].rect.w > 0, true);
  assert.ok(fs.existsSync(path.join(home, "screenshots", "mc-memory-toggle.callouts.json")));
});

test("captureShot can draw numbered callouts or skip masking when asked", async (t) => {
  const home = tmpDir(t);
  const burn = createFakePlaywright();
  await captureShot({ page: burn.page, shot: baseShot(), assetsDir: path.join(home, "a"), screenshotsDir: path.join(home, "s"), env: {}, redact: true, terms: [], calloutMode: "burn", log: () => {} });
  assert.ok(burn.log.evaluations.includes("drawCalloutMarkersInPage"));
  const raw = createFakePlaywright();
  const result = await captureShot({ page: raw.page, shot: baseShot(), assetsDir: path.join(home, "a2"), screenshotsDir: path.join(home, "s2"), env: {}, redact: false, terms: [], calloutMode: "none", log: () => {} });
  assert.ok(!raw.log.evaluations.includes("maskSensitiveInPage"));
  assert.equal(result.evidence.redaction, null);
  assert.ok(!raw.log.evaluations.includes("drawCalloutMarkersInPage"));
});

test("captureShot retries a blank picture once, then reports it instead of uploading", async (t) => {
  const home = tmpDir(t);
  const blank = makePng({ mode: "blank", width: 640, height: 400 });
  const sleeps = [];
  const flaky = createFakePlaywright({ screenshot: (n) => (n === 1 ? blank : makePng({ mode: "ui", seed: 9 })) });
  const recovered = await captureShot({ page: flaky.page, shot: baseShot(), assetsDir: path.join(home, "a"), screenshotsDir: path.join(home, "s"), env: {}, redact: true, terms: [], calloutMode: "sidecar", log: () => {}, sleepFn: async (ms) => sleeps.push(ms) });
  assert.equal(recovered.status, "captured");
  assert.equal(flaky.log.screenshots, 2);
  assert.equal(sleeps.filter((ms) => ms >= 4000).length, 1, "one longer wait before the second try (the short ones are the page-ready checks)");

  const always = createFakePlaywright({ screenshot: () => blank });
  const failed = await captureShot({ page: always.page, shot: baseShot(), assetsDir: path.join(home, "a3"), screenshotsDir: path.join(home, "s3"), env: {}, redact: true, terms: [], calloutMode: "sidecar", log: () => {}, sleepFn: async () => {} });
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /blank/i);
  assert.equal(always.log.screenshots, 2);
});

test("captureShot rejects a sign-in page locally and reports auth-required when sign-in is needed", async (t) => {
  const home = tmpDir(t);
  const onSignIn = createFakePlaywright({ rewriteUrl: () => "https://login.microsoftonline.com/common/oauth2/authorize?x=1" });
  const needsSignIn = await captureShot({ page: onSignIn.page, shot: baseShot(), assetsDir: path.join(home, "a"), screenshotsDir: path.join(home, "s"), env: {}, redact: true, terms: [], calloutMode: "sidecar", log: () => {} });
  assert.equal(needsSignIn.status, "auth-required");
  assert.equal(onSignIn.log.screenshots, 0, "nothing is captured on a sign-in page");

  const titled = createFakePlaywright({ title: "Sign in to your account" });
  const refused = await captureShot({ page: titled.page, shot: baseShot(), assetsDir: path.join(home, "a2"), screenshotsDir: path.join(home, "s2"), env: {}, redact: true, terms: [], calloutMode: "sidecar", log: () => {} });
  assert.equal(refused.status, "failed");
  assert.match(refused.error, /sign-in page/);
});

// ── A whole job against a fake portal ────────────────────────────────────────

test("runJob captures, verifies, uploads, and completes; skips manual and tenant-address shots in plain language", async (t) => {
  const home = tmpDir(t);
  const portal = await startFakePortal(t);
  const client = createPortalClient({ portal: portal.base, token: TOKEN });
  const { playwright, log: pw } = createFakePlaywright();
  const log = collectLog();
  const shots = [
    baseShot(),
    baseShot({ filename: "terminal.png", manual: true }),
    baseShot({ filename: "site.png", requiresEnv: "CAPTURE_SHAREPOINT_SITE_URL", authProfile: "sharepoint-ai" }),
  ];
  const result = await runJob({ client, claimed: claimedJob(shots), home, playwright, options: {}, log, heartbeatMs: 60_000 });

  assert.deepEqual(result.tally, { captured: 1, needsReview: 0, failed: 0, skipped: 1, manual: 1, needsYou: 0, paused: 0 });
  assert.equal(portal.uploads.length, 1);
  const upload = portal.uploads[0];
  assert.equal(upload.filename, "mc-memory-toggle.png");
  assert.equal(upload.partName, "mc-memory-toggle.png");
  assert.ok(upload.bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
  assert.equal(upload.evidence.finalUrl, "https://copilotstudio.microsoft.com/");
  assert.equal(upload.evidence.redaction.applied, true);
  assert.ok(upload.evidence.visibleText.includes("Settings"));
  assert.ok(!JSON.stringify(upload.evidence).includes("ada@contoso.com"));
  assert.deepEqual(upload.callouts.map((c) => [c.n, c.label, Boolean(c.rect)]), [[1, "Memory", true]]);

  const statuses = portal.progress.filter((p) => p.shot).map((p) => `${p.shot.filename}:${p.shot.status}`);
  assert.ok(statuses.includes("mc-memory-toggle.png:running"));
  assert.ok(statuses.includes("terminal.png:manual-required"));
  assert.ok(statuses.includes("site.png:skipped"));
  assert.match(log.text(), /CAPTURE_SHAREPOINT_SITE_URL/);
  assert.match(log.text(), /OS screenshot tool/);
  assert.equal(portal.completes.length, 1);
  assert.match(portal.completes[0].message, /1 captured/);
  assert.equal(pw.launched.length, 1, "one browser profile per product");
  assert.equal(pw.launched[0].options.headless, false, "the browser is headed so you can sign in");
  assert.equal(pw.launched[0].dir, path.join(home, ".auth", "chromium", "copilot-studio"), "each product keeps its own sign-in under .auth/<browser>/<product>");
  assert.equal(pw.closed, 1);
  assert.ok(!fs.existsSync(path.join(home, ".captures", "job_0123456789abcdef")), "working files are cleaned up");
  assert.ok(portal.requests.every((r) => r.auth === `Bearer ${TOKEN}`));
  assert.ok(!log.text().includes(TOKEN), "the token is never printed");
});

test("a tenant address from the job unlocks shots that need it", async (t) => {
  const home = tmpDir(t);
  const portal = await startFakePortal(t);
  const { playwright, log: pw } = createFakePlaywright();
  const shot = baseShot({ filename: "site.png", requiresEnv: "CAPTURE_SHAREPOINT_SITE_URL", urlEnv: "CAPTURE_SHAREPOINT_SITE_URL", authProfile: "sharepoint-ai" });
  const result = await runJob({
    client: createPortalClient({ portal: portal.base, token: TOKEN }),
    claimed: claimedJob([shot], { env: { CAPTURE_SHAREPOINT_SITE_URL: "https://contoso.sharepoint.com/sites/training" } }),
    home,
    playwright,
    log: () => {},
    heartbeatMs: 60_000,
  });
  assert.equal(result.tally.captured, 1);
  assert.equal(pw.goto[0], "https://contoso.sharepoint.com/sites/training", "the job's address is where the browser goes");
  assert.equal(pw.launched[0].dir, path.join(home, ".auth", "chromium", "sharepoint-ai"));
});

test("runJob stops between shots when the portal says the job was canceled", async (t) => {
  const home = tmpDir(t);
  const portal = await startFakePortal(t, { cancelAfterUploads: 1 });
  const { playwright, log: pw } = createFakePlaywright();
  const log = collectLog();
  const result = await runJob({
    client: createPortalClient({ portal: portal.base, token: TOKEN }),
    claimed: claimedJob([baseShot(), baseShot({ filename: "second.png" }), baseShot({ filename: "third.png" })]),
    home,
    playwright,
    log,
    heartbeatMs: 60_000,
  });
  assert.equal(result.cancelled, true);
  assert.equal(portal.uploads.length, 1, "the second shot is never started");
  assert.equal(pw.screenshots, 1);
  assert.match(log.text(), /Canceled from the portal/);
  assert.equal(portal.completes.length, 1, "the portal is told the job ended");
  assert.equal(pw.closed, 1, "the browser is closed");
});

test("runJob reports sign-in needs, rejected images, and missing browsers without crashing", async (t) => {
  const home = tmpDir(t);
  const portal = await startFakePortal(t, { uploadStatus: { status: 422, body: { outcome: "rejected", message: "The image is blank or a single color." } } });
  const client = createPortalClient({ portal: portal.base, token: TOKEN });
  const log = collectLog();
  const fake = createFakePlaywright({ rewriteUrl: (u) => (u.includes("needs-signin") ? "https://login.microsoftonline.com/x" : u) });
  const result = await runJob({
    client,
    claimed: claimedJob([
      baseShot({ filename: "ok.png" }),
      baseShot({ filename: "signin.png", startUrl: "https://needs-signin.example.com/", steps: [{ action: "navigate", url: "https://needs-signin.example.com/" }, { action: "screenshot" }] }),
    ]),
    home,
    playwright: fake.playwright,
    log,
    heartbeatMs: 60_000,
  });
  assert.equal(result.tally.failed, 2);
  assert.match(log.text(), /Sign in to Microsoft Copilot Studio on your computer, then retry the 1 screenshot/);
  assert.match(log.text(), /portal rejected the image: The image is blank/);
  const reported = portal.progress.filter((p) => p.shot).map((p) => `${p.shot.filename}:${p.shot.status}`);
  assert.ok(reported.includes("signin.png:auth-required"));

  const noBrowser = {
    chromium: {
      async launchPersistentContext() {
        throw new Error("browserType.launchPersistentContext: Executable doesn't exist at C:\\pw\\chrome.exe");
      },
    },
  };
  const log2 = collectLog();
  const missing = await runJob({ client, claimed: claimedJob([baseShot({ filename: "x.png" })]), home, playwright: noBrowser, log: log2, heartbeatMs: 60_000 });
  assert.equal(missing.tally.failed, 1);
  assert.match(log2.text(), /npx playwright install chromium/);
  assert.ok(!/at .*\.js:\d+/.test(log2.text()), "no stack traces for people");
});

test("runJob needs-review and portal auth errors are handled plainly", async (t) => {
  const home = tmpDir(t);
  const review = await startFakePortal(t, { uploadStatus: { status: 202, body: { outcome: "needs-review", verification: { reasons: [{ message: "Only 0 of 2 expected UI labels are visible." }] } } } });
  const log = collectLog();
  const result = await runJob({ client: createPortalClient({ portal: review.base, token: TOKEN }), claimed: claimedJob([baseShot()]), home, playwright: createFakePlaywright().playwright, log, heartbeatMs: 60_000 });
  assert.equal(result.tally.needsReview, 1);
  assert.match(log.text(), /Saved for review in the portal\. Only 0 of 2/);

  const revoked = await startFakePortal(t, { authError: "token-revoked" });
  await assert.rejects(
    runJob({ client: createPortalClient({ portal: revoked.base, token: TOKEN }), claimed: claimedJob([baseShot()]), home, playwright: createFakePlaywright().playwright, log: () => {}, heartbeatMs: 60_000 }),
    (err) => err instanceof PortalError && err.kind === "auth" && /disconnected in the portal/.test(err.message),
  );
});

// ── The whole program ────────────────────────────────────────────────────────

const ready = async () => ({ ok: true, problems: [] });

test("--portal and --code pair once, save the token locally, and --once reports an empty queue", async (t) => {
  const home = tmpDir(t);
  const portal = await startFakePortal(t);
  const log = collectLog();
  const code = await runCompanion([`--portal=${portal.base}`, "--code=ABCD-EFGH", "--once", `--home=${home}`, "--device-name=Ada PC"], { log, preflight: ready, playwright: createFakePlaywright().playwright, noSignals: true, nonInteractive: true });
  assert.equal(code, EXIT.ok);
  assert.equal(portal.pairs[0].deviceName, "Ada PC");
  assert.equal(portal.pairs[0].code, "ABCD-EFGH");
  assert.equal(loadConfig(home).token, TOKEN);
  assert.equal(loadConfig(home).portal, portal.base);
  assert.match(log.text(), /Paired with .* as "Ada PC"/);
  assert.match(log.text(), /No capture jobs are waiting/);
  assert.ok(!log.text().includes(TOKEN));
  assert.equal(portal.requests.at(-1).version, COMPANION_VERSION);

  // A second run needs no code.
  const again = collectLog();
  assert.equal(await runCompanion(["--once", `--home=${home}`], { log: again, preflight: ready, playwright: createFakePlaywright().playwright, noSignals: true, nonInteractive: true }), EXIT.ok);
  assert.equal(portal.pairs.length, 1);
  assert.doesNotMatch(again.text(), /Paired with/);
});

test("--once claims and runs one job, then exits", async (t) => {
  const home = tmpDir(t);
  const portal = await startFakePortal(t, { jobs: [claimedJob([baseShot()])] });
  saveConfig(home, { portal: portal.base, token: TOKEN, deviceId: "dev_x", deviceName: "PC" });
  const log = collectLog();
  const code = await runCompanion(["--once", `--home=${home}`, "--callouts=none"], { log, preflight: ready, playwright: createFakePlaywright().playwright, noSignals: true, nonInteractive: true });
  assert.equal(code, EXIT.ok);
  assert.equal(portal.uploads.length, 1);
  assert.equal(portal.uploads[0].callouts, null, "--callouts=none sends no callouts");
  assert.equal(portal.completes.length, 1);
  assert.match(log.text(), /Job finished: 1 captured/);
  const heartbeats = portal.requests.filter((r) => r.path.endsWith("/heartbeat"));
  assert.ok(heartbeats.length >= 1);
});

test("a wrong pairing code, a revoked token, and an unreachable portal each get a clear message and exit code", async (t) => {
  const home = tmpDir(t);
  const portal = await startFakePortal(t);
  const wrong = collectLog();
  assert.equal(await runCompanion([`--portal=${portal.base}`, "--code=WRNG-CODE", "--once", `--home=${home}`], { log: wrong, preflight: ready, noSignals: true, nonInteractive: true }), EXIT.auth);
  assert.match(wrong.text(), /pairing code is not valid/);
  assert.equal(loadConfig(home), null);

  assert.equal(await runCompanion(["--once", `--home=${home}`], { log: collectLog(), preflight: ready, noSignals: true, nonInteractive: true }), EXIT.usage, "unpaired and no code to ask for");
  assert.equal(await runCompanion(["--portal=http://insecure.example.com", "--code=ABCD-EFGH", `--home=${home}`], { log: collectLog(), preflight: ready, noSignals: true, nonInteractive: true }), EXIT.usage);

  const revokedPortal = await startFakePortal(t, { authError: "token-revoked" });
  saveConfig(home, { portal: revokedPortal.base, token: TOKEN, deviceId: "dev_x", deviceName: "PC" });
  const revoked = collectLog();
  assert.equal(await runCompanion(["--once", `--home=${home}`], { log: revoked, preflight: ready, noSignals: true, nonInteractive: true }), EXIT.auth);
  assert.match(revoked.text(), /disconnected in the portal/);
  assert.match(revoked.text(), /Pair it again/);
  assert.equal(loadConfig(home), null, "a revoked token is forgotten");

  const expiredPortal = await startFakePortal(t, { authError: "token-expired" });
  saveConfig(home, { portal: expiredPortal.base, token: TOKEN, deviceId: "dev_x", deviceName: "PC" });
  const expired = collectLog();
  assert.equal(await runCompanion(["--once", `--home=${home}`], { log: expired, preflight: ready, noSignals: true, nonInteractive: true }), EXIT.auth);
  assert.match(expired.text(), /expired/);

  saveConfig(home, { portal: "http://127.0.0.1:1", token: TOKEN, deviceId: "dev_x", deviceName: "PC" });
  const down = collectLog();
  assert.equal(await runCompanion(["--once", `--home=${home}`], { log: down, preflight: ready, noSignals: true, nonInteractive: true }), EXIT.unreachable);
  assert.match(down.text(), /Cannot reach the portal at http:\/\/127\.0\.0\.1:1/);
  assert.ok(!/ECONNREFUSED.*\n.*at /.test(down.text()));
});

test("--watch keeps polling through an outage and runs the job when the portal comes back", async (t) => {
  const home = tmpDir(t);
  const portal = await startFakePortal(t, { jobs: [claimedJob([baseShot()])] });
  saveConfig(home, { portal: portal.base, token: TOKEN, deviceId: "dev_x", deviceName: "PC" });
  let failures = 2;
  const flakyFetch = async (url, init) => {
    if (failures > 0) {
      failures -= 1;
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    }
    return fetch(url, init);
  };
  const sleeps = [];
  const log = collectLog();
  const code = await runCompanion([`--home=${home}`, "--watch"], {
    log,
    preflight: ready,
    playwright: createFakePlaywright().playwright,
    fetchImpl: flakyFetch,
    noSignals: true,
    nonInteractive: true,
    pollMs: 1000,
    sleepFn: async (ms) => sleeps.push(ms),
    shouldStop: () => portal.completes.length > 0,
  });
  assert.equal(code, EXIT.ok);
  assert.equal(portal.uploads.length, 1, "the job ran after the outage");
  assert.match(log.text(), /Cannot reach the portal/);
  assert.match(log.text(), /I will keep trying/);
  assert.ok(sleeps.length >= 2 && sleeps[1] >= sleeps[0], "it backs off between attempts");
  assert.equal((log.text().match(/Cannot reach the portal/g) || []).length, 1, "an outage is announced once");
});

test("--once --wait polls for a while before giving up, and --status, --unpair, and --help work", async (t) => {
  const home = tmpDir(t);
  const portal = await startFakePortal(t);
  saveConfig(home, { portal: portal.base, token: TOKEN, deviceId: "dev_x", deviceName: "PC" });
  const polls = () => portal.requests.filter((r) => r.path.endsWith("/next")).length;
  const sleeps = [];
  await runCompanion(["--once", "--wait=2", `--home=${home}`], { log: collectLog(), preflight: ready, noSignals: true, nonInteractive: true, pollMs: 500, sleepFn: async (ms) => sleeps.push(ms) });
  assert.equal(polls(), 5, "it asks once, then every poll until the wait is over");

  const status = collectLog();
  assert.equal(await runCompanion(["--status", `--home=${home}`], { log: status, preflight: ready, noSignals: true, nonInteractive: true }), EXIT.ok);
  assert.match(status.text(), /Connected to .* as "PC"/);
  assert.match(status.text(), /Not signed in to any product yet/);

  const help = collectLog();
  assert.equal(await runCompanion(["--help"], { log: help }), EXIT.ok);
  assert.match(help.text(), /--once/);
  assert.equal(await runCompanion(["--bogus"], { log: collectLog() }), EXIT.usage);

  const unpair = collectLog();
  assert.equal(await runCompanion(["--unpair", `--home=${home}`], { log: unpair }), EXIT.ok);
  assert.equal(loadConfig(home), null);
  assert.match(unpair.text(), /no longer paired/);
});

test("in a real browser, account details are covered during the picture and nothing is left behind", async (t) => {
  const found = await detectBrowserAvailability();
  if (!found.available) {
    t.skip("Playwright with Chromium is not installed");
    return;
  }
  const { chromium } = await loadPlaywrightModule();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 400 } });
    await page.setContent(
      `<body style="font:20px Arial"><button id="O365_MainLink_Me" style="position:absolute;right:10px;top:10px;width:40px;height:40px">AL</button>` +
        `<h1>Settings</h1><p>Signed in as ada.lovelace@contoso.com (contoso.onmicrosoft.com)</p><input value="grace@fabrikam.com"><p>Acme Corp</p><button>Memory</button></body>`,
    );
    const before = await page.screenshot();
    const redaction = await applyRedaction(page, { terms: ["Acme Corp"] });
    assert.equal(redaction.applied, true);
    assert.ok(redaction.masked >= 5, "the account control, the address, the tenant host, the field, and the term are covered");
    const covered = await page.screenshot();
    assert.ok(!before.equals(covered), "the picture taken while masked differs");
    assert.deepEqual(await collectVisibleLabels(page, { terms: ["Acme Corp"] }), ["AL", "Settings", "Memory"]);
    assert.equal(await burnCalloutMarkers(page, [{ n: 1, label: "Memory", rect: { x: 0.1, y: 0.5, w: 0.2, h: 0.1 } }], { width: 800, height: 400 }), 1);
    await clearOverlays(page);
    assert.equal(await page.evaluate(() => document.querySelectorAll("[data-capture-overlay]").length), 0);
    assert.ok((await page.screenshot()).equals(before), "after the picture the page is exactly as it was");
  } finally {
    await browser.close();
  }
});

test("the companion never types into pages: its source has no fill, type, or press calls", () => {
  for (const file of ["companion.mjs", "redact.mjs"]) {
    const source = fs.readFileSync(path.join(TOOL_DIR, file), "utf8");
    assert.ok(!/\.(fill|type|press|pressSequentially|setInputFiles|selectOption|check|uncheck)\s*\(/.test(source), `${file} never drives input`);
  }
  const runner = fs.readFileSync(path.join(TOOL_DIR, "lab-runner.mjs"), "utf8");
  const stepThrough = runner.slice(runner.indexOf('action === "stepThrough"'), runner.indexOf('action === "probeControl"'));
  assert.match(stepThrough, /blockedLabelReason/);
});
