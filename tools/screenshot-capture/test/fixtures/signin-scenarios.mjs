// Real-browser sign-in scenarios for the Local Capture Companion. Each scenario runs
// the companion's own runJob against a pretend tenant (see fake-tenant.mjs), so the
// same code that runs on a person's computer is exercised. `toolDir` points at the
// screenshot-capture folder to test, which is how a before/after comparison is made.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { FAKE_PRODUCT_HOSTS, createFakeTenant, withFakeTenant } from "./fake-tenant.mjs";

export function recordingClient() {
  const calls = { progress: [], uploads: [], completes: [], statuses: [] };
  return {
    calls,
    async heartbeat() {
      return {};
    },
    async progress(_jobId, body) {
      calls.progress.push(body);
      if (body.shot) calls.statuses.push(`${body.shot.filename}:${body.shot.status}`);
      return { ok: true };
    },
    async upload(_jobId, filename) {
      calls.uploads.push(filename);
      return { status: 200, body: { outcome: "accepted" } };
    },
    async complete(_jobId, body) {
      calls.completes.push(body);
      return {};
    },
  };
}

export function scenarioShot({ filename, host = FAKE_PRODUCT_HOSTS[0], profile = "copilot-studio", path: pagePath = "/", click = [], instruction = "" }) {
  const steps = [
    { action: "navigate", url: `https://${host}${pagePath}`, waitUntil: "domcontentloaded" },
    { action: "waitForLoadState", state: "networkidle", timeoutMs: 3000, optional: true },
    { action: "dismissBanners", optional: true },
  ];
  if (click.length) steps.push({ action: "stepThrough", labels: click, instruction, roles: ["link", "button"], interaction: "click-or-focus", optional: true });
  steps.push({ action: "screenshot", fullPage: false });
  return {
    filename,
    shotId: filename,
    featureId: "feature",
    moduleTitle: "Module",
    product: profile,
    authProfile: profile,
    startUrl: `https://${host}${pagePath}`,
    viewport: { width: 1280, height: 720 },
    manual: false,
    requiresEnv: null,
    expectedLabels: ["Settings", "Memory"],
    callouts: [],
    steps,
  };
}

export function scenarioJob(shots, id = "job_00000000000000aa") {
  return { job: { id, target: { type: "library", products: [] }, scope: {}, options: { callouts: "none", redact: true }, createdAt: new Date().toISOString(), resumed: false }, env: {}, shots };
}

const [A, B, C] = FAKE_PRODUCT_HOSTS;
const trap = `/trap?returnUrl=${encodeURIComponent("https://login.microsoftonline.com/common/oauth2/authorize")}`;

/**
 * Situations a person can run into. `tenant` shapes the pretend tenant, `jobs` is a list of jobs run one after
 * the other in the same companion home (a restart of the companion between jobs).
 */
export function scenarioCatalog() {
  const copilot = (filename, extra = {}) => scenarioShot({ filename, host: A, profile: "copilot-studio", ...extra });
  const admin = (filename) => scenarioShot({ filename, host: C, profile: "copilot-studio" });
  const power = (filename) => scenarioShot({ filename, host: B, profile: "power-platform-ai-hub" });
  return {
    "first shot works, then the next page asks for a fresh sign-in": { tenant: { preSignedIn: [A], stepUpHosts: [C] }, jobs: [[copilot("a1.png"), admin("b1.png"), admin("b2.png"), admin("b3.png")]] },
    "two jobs, sign-in kept as a session cookie (restart between)": { tenant: { preSignedIn: [A], sessionCookies: true }, jobs: [[copilot("a1.png")], [copilot("a2.png")]] },
    "two jobs, person chose Yes on Stay signed in?": { tenant: { preSignedIn: [A], sessionCookies: false }, jobs: [[copilot("a1.png")], [copilot("a2.png")]] },
    "second product in the same job": { tenant: { preSignedIn: [A] }, jobs: [[copilot("a1.png"), power("b1.png"), power("b2.png")]] },
    "lab step says Sign out": { tenant: { preSignedIn: [A] }, jobs: [[copilot("a1.png", { click: ["Sign out"], instruction: "Select your profile, then select **Sign out**." }), copilot("a2.png"), copilot("a3.png")]] },
    "lab step says Switch account": { tenant: { preSignedIn: [A] }, jobs: [[copilot("a1.png", { click: ["Switch account"], instruction: "Select **Switch account**." }), copilot("a2.png"), copilot("a3.png")]] },
    "sign-in is blocked for this browser, 4 shots": { tenant: { blockSignIn: true }, jobs: [[copilot("a1.png"), copilot("a2.png"), copilot("a3.png"), copilot("a4.png")]] },
    "signed-in page whose address mentions the login host": { tenant: { preSignedIn: [A] }, jobs: [[scenarioShot({ filename: "a1.png", host: A, path: trap }), copilot("a2.png")]] },
    "saved app sign-in expired, silent single sign-on through a slow login page": { tenant: { preSignedIn: [A], staleApp: true, sessionCookies: false, ssoHop: "client", hopDelayMs: 800 }, jobs: [[copilot("a1.png"), copilot("a2.png")]] },
  };
}

/** Load the companion from a folder (defaults to this checkout). */
export async function loadCompanion(toolDir) {
  return import(pathToFileURL(path.join(toolDir, "companion.mjs")).href);
}

export async function loadPlaywright(toolDir) {
  const { loadPlaywrightModule } = await import(pathToFileURL(path.join(toolDir, "lab-runner.mjs")).href);
  return loadPlaywrightModule(path.resolve(toolDir, "..", ".."));
}

/**
 * Run one or more jobs, one after the other, in the same companion home (so what a first
 * job saved is what the second job finds, like two `--watch` iterations or two runs).
 */
export async function runScenario({ toolDir, tenantOptions = {}, jobs, signInWaitSec = 9, options = {}, channel = undefined }) {
  const companion = await loadCompanion(toolDir);
  const playwright = await loadPlaywright(toolDir);
  const tenant = createFakeTenant(tenantOptions);
  const wrapped = withFakeTenant(playwright, tenant, { forceChannel: channel });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "signin-scenario-"));
  const lines = [];
  const results = [];
  const started = Date.now();
  try {
    for (const [index, shots] of jobs.entries()) {
      const client = recordingClient();
      const result = await companion.runJob({
        client,
        claimed: scenarioJob(shots, `job_00000000000000${String(index).padStart(2, "0")}`),
        home,
        playwright: wrapped,
        options: { headless: true, waitForSignIn: true, signInWaitSec, ...options },
        log: (line) => lines.push(String(line)),
        heartbeatMs: 60_000,
      });
      results.push({ result, calls: client.calls });
    }
  } finally {
    try {
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
    } catch {
      // A browser can hold a file a moment longer on Windows; the folder is in the temp directory.
    }
  }
  return { tenant, results, launches: wrapped.launches, lines, elapsedMs: Date.now() - started };
}
