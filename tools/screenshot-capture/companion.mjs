#!/usr/bin/env node
// Local Capture Companion for the Microsoft AI Training Generator portal.
//
// Runs on your own computer. You pair it with the portal once, sign in to each
// Microsoft product once in the browser window it opens, and from then on the
// portal can ask it to capture screenshots. It checks every image, hides account
// details, uploads the result, and the portal updates your lab for you.
//
// What it never does: it never types into tenant pages (you sign in yourself),
// never clicks a control whose name says delete, remove, or reset, and never
// sends your password or browser profile anywhere. Only screenshots, page
// addresses, and visible control names leave this computer, and only to the
// portal you paired with.
//
//   node companion.mjs --portal=https://<portal> --code=ABCD-EFGH    pair, then watch for jobs
//   node companion.mjs --watch                                       keep running (default)
//   node companion.mjs --once                                        run one queued job, then exit
//   node companion.mjs --help

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { verifyImage } from "./image-verify.mjs";
import { DESTRUCTIVE_LABEL_RE, detectBrowserAvailability, executePlaywrightLabShot, loadPlaywrightModule } from "./lab-runner.mjs";
import { applyRedaction, burnCalloutMarkers, clearOverlays, collectVisibleLabels, scrubSensitiveText } from "./redact.mjs";

export const COMPANION_VERSION = "1.0.0";
export const MIN_NODE_MAJOR = 20;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_NAME = ".companion.json";
const HEARTBEAT_MS = 20_000;
const SIGN_IN_WAIT_MS = 10 * 60 * 1000;
const ALLOWED_ACTIONS = new Set(["navigate", "waitForLoadState", "dismissBanners", "stepThrough", "click", "clickBestEffort", "probeControl", "probeCallouts", "screenshot"]);

export const EXIT = Object.freeze({ ok: 0, usage: 1, unreachable: 2, auth: 3 });

// ── Command line ───────────────────────────────────────────────────────────

export function helpText() {
  return `Local Capture Companion ${COMPANION_VERSION}

Usage:
  node companion.mjs --portal=<address> --code=<pairing code>   Pair this computer, then wait for jobs
  node companion.mjs                                            Wait for jobs (after pairing)
  node companion.mjs --once [--wait=<seconds>]                  Run one queued job and exit
  node companion.mjs --status                                   Show the connection and sign-in state
  node companion.mjs --unpair                                   Forget this computer's pairing

Options:
  --callouts=sidecar|burn|none   Numbered callouts: save positions only (default), draw them on the image, or skip
  --mask=<text>[,<text>]         Extra text to hide (for example your tenant name)
  --no-redact                    Do not hide account details (not recommended)
  --headless                     No visible window. It cannot sign in, so use it only for public pages and automated checks
  --device-name=<name>           Name shown in the portal (default: this computer's name)
  --interval=<seconds>           How often to ask the portal for jobs (default 4)
  --sign-in-wait=<seconds>       How long to wait for you to sign in (default 600)
  --home=<folder>                Where the pairing file and browser sign-ins live
  --install-browser              Install the Chromium browser, then exit
  --check                        Check this computer is ready, then exit
  --verbose                      Print more detail
  --help                         Show this help
`;
}

export function parseArgs(argv = []) {
  const opts = { watch: true, once: false, waitSec: 0, callouts: null, maskTerms: [], redact: true, intervalSec: 4, signInWaitSec: SIGN_IN_WAIT_MS / 1000, verbose: false };
  const take = (arg, name) => {
    if (arg === `--${name}`) return { value: true, usesNext: true };
    if (arg.startsWith(`--${name}=`)) return { value: arg.slice(name.length + 3), usesNext: false };
    return null;
  };
  const list = [...argv];
  for (let i = 0; i < list.length; i += 1) {
    const arg = list[i];
    const valued = (name) => {
      const hit = take(arg, name);
      if (!hit) return undefined;
      if (hit.usesNext) {
        const next = list[i + 1];
        if (next === undefined || next.startsWith("--")) return "";
        i += 1;
        return next;
      }
      return hit.value;
    };
    let v;
    if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--once") opts.once = true;
    else if (arg === "--watch") opts.watch = true;
    else if (arg === "--no-redact") opts.redact = false;
    else if (arg === "--headless") opts.headless = true;
    else if (arg === "--verbose") opts.verbose = true;
    else if (arg === "--unpair") opts.unpair = true;
    else if (arg === "--status") opts.status = true;
    else if (arg === "--check") opts.check = true;
    else if (arg === "--install-browser") opts.installBrowser = true;
    else if ((v = valued("portal")) !== undefined) opts.portal = v;
    else if ((v = valued("code")) !== undefined) opts.code = v;
    else if ((v = valued("home")) !== undefined) opts.home = v;
    else if ((v = valued("device-name")) !== undefined) opts.deviceName = v;
    else if ((v = valued("wait")) !== undefined) opts.waitSec = Math.max(0, Number(v) || 0);
    else if ((v = valued("interval")) !== undefined) opts.intervalSec = Math.max(1, Number(v) || 4);
    else if ((v = valued("sign-in-wait")) !== undefined) opts.signInWaitSec = Math.max(30, Number(v) || 600);
    else if ((v = valued("callouts")) !== undefined) {
      if (!["sidecar", "burn", "none"].includes(v)) opts.error = `--callouts must be sidecar, burn, or none (got "${v}").`;
      else opts.callouts = v;
    } else if ((v = valued("mask")) !== undefined) opts.maskTerms.push(...String(v).split(",").map((t) => t.trim()).filter(Boolean));
    else opts.error = `I do not know the option "${arg}". Run with --help to see the options.`;
  }
  if (opts.once) opts.watch = false;
  return opts;
}

/** Accept an https address, or http only for this computer (local development). */
export function validatePortalUrl(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: false, error: "Enter the portal address, for example https://my-portal.azurecontainerapps.io." };
  let url;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: `"${text}" is not a web address. Include https://.` };
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    return { ok: false, error: "The portal address must start with https:// (http:// is only allowed for localhost)." };
  }
  if (url.username || url.password) return { ok: false, error: "Remove the user name and password from the portal address." };
  return { ok: true, portal: url.origin };
}

// ── Pairing file ───────────────────────────────────────────────────────────

export function configPath(home) {
  return path.join(home, CONFIG_NAME);
}

export function loadConfig(home) {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(home), "utf8"));
    return parsed && typeof parsed.token === "string" && typeof parsed.portal === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export function saveConfig(home, config) {
  fs.mkdirSync(home, { recursive: true });
  const file = configPath(home);
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Not every file system supports permissions.
  }
}

export function clearConfig(home) {
  fs.rmSync(configPath(home), { force: true });
}

/** Browser profiles that already hold a sign-in (one folder per product under `.auth`). */
export function listSignedInProfiles(home) {
  const root = path.join(home, ".auth");
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^[a-z0-9-]+$/.test(entry.name))
      .filter((entry) => fs.readdirSync(path.join(root, entry.name)).length > 0)
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

// ── Portal client ──────────────────────────────────────────────────────────

export class PortalError extends Error {
  constructor(kind, message, { status = null, code = null, retryAfterSec = null, body = null } = {}) {
    super(message);
    this.name = "PortalError";
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.retryAfterSec = retryAfterSec;
    this.body = body;
  }
}

const AUTH_MESSAGES = {
  "token-revoked": "This computer was disconnected in the portal.",
  "token-expired": "This computer's connection to the portal expired.",
  "token-invalid": "The portal does not recognize this computer's pairing.",
  "token-missing": "This computer is not paired with the portal.",
};

export function createPortalClient({ portal, token = null, fetchImpl = globalThis.fetch, version = COMPANION_VERSION } = {}) {
  async function request(method, route, { json, form, auth = true, timeoutMs = 30_000 } = {}) {
    const headers = { Accept: "application/json", "X-Companion-Version": version };
    if (auth && token) headers.Authorization = `Bearer ${token}`;
    let body;
    if (json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(json);
    } else if (form) {
      body = form;
    }
    let res;
    try {
      res = await fetchImpl(`${portal}${route}`, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new PortalError("unreachable", `Cannot reach the portal at ${portal}. Check your internet connection or VPN. (${err?.cause?.code || err?.name || "network error"})`);
    }
    if (res.status === 204) return { status: 204, body: null };
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (res.ok) return { status: res.status, body: data };
    const code = data?.code || null;
    const retryAfterSec = Number(res.headers.get("retry-after")) || null;
    if (res.status === 401 && code && String(code).startsWith("token-")) {
      throw new PortalError("auth", `${AUTH_MESSAGES[code] || "The portal rejected this computer's pairing."} Pair it again: get a new code in the portal, then run this with --portal and --code.`, { status: 401, code, body: data });
    }
    if (res.status === 429) throw new PortalError("rate-limited", data?.error || "The portal asked this computer to slow down.", { status: 429, code, retryAfterSec, body: data });
    if (res.status >= 500) throw new PortalError("server", data?.error || `The portal had a problem (HTTP ${res.status}).`, { status: res.status, code, body: data });
    return { status: res.status, body: data, rejected: true };
  }

  const must = (result, what) => {
    if (result.rejected) throw new PortalError("client", result.body?.error || `The portal refused ${what} (HTTP ${result.status}).`, { status: result.status, code: result.body?.code || null, body: result.body });
    return result.body;
  };

  return {
    async pair({ code, deviceName, platform = process.platform }) {
      const result = await request("POST", "/api/capture/companion/pair", { json: { code, deviceName, platform, companionVersion: version }, auth: false });
      if (result.rejected) throw new PortalError("pair", result.body?.error || "The portal did not accept that pairing code.", { status: result.status, code: result.body?.code || null });
      return result.body;
    },
    async heartbeat(info = {}) {
      return must(await request("POST", "/api/capture/companion/heartbeat", { json: { companionVersion: version, ...info } }), "the check-in");
    },
    async next() {
      const result = await request("GET", "/api/capture/companion/next");
      return result.status === 204 ? null : must(result, "the job request");
    },
    async progress(jobId, body) {
      return must(await request("POST", `/api/capture/companion/jobs/${jobId}/progress`, { json: body }), "the progress update");
    },
    /** Upload one image. Returns `{status, body}` for accepted (200), needs-review (202), and rejected (422). */
    async upload(jobId, filename, { bytes, evidence, callouts, mime }) {
      const form = new FormData();
      form.append("file", new Blob([bytes], { type: mime || "image/png" }), filename);
      form.append("evidence", JSON.stringify(evidence || {}));
      if (callouts) form.append("callouts", JSON.stringify(callouts));
      const result = await request("PUT", `/api/capture/companion/jobs/${jobId}/shots/${encodeURIComponent(filename)}`, { form, timeoutMs: 120_000 });
      if (result.rejected && result.status !== 422) must(result, "the screenshot");
      return { status: result.status, body: result.body };
    },
    async complete(jobId, body = {}) {
      return must(await request("POST", `/api/capture/companion/jobs/${jobId}/complete`, { json: body }), "the job completion");
    },
  };
}

// ── Running a job ──────────────────────────────────────────────────────────

const mimeFor = (filename) => (/\.jpe?g$/i.test(filename) ? "image/jpeg" : /\.webp$/i.test(filename) ? "image/webp" : "image/png");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Only CAPTURE_* variables with https addresses are used from a job. */
export function jobEnvironment(jobEnv, base = process.env) {
  const env = { ...base };
  for (const [name, value] of Object.entries(jobEnv || {})) {
    if (/^CAPTURE_[A-Z0-9_]{1,80}$/.test(name) && /^https:\/\/\S+$/.test(String(value))) env[name] = value;
  }
  return env;
}

/** Keep allowed actions only, and drop any step aimed at a control whose name says delete, remove, or reset. */
export function safeSteps(steps) {
  const kept = [];
  for (const step of Array.isArray(steps) ? steps : []) {
    if (!ALLOWED_ACTIONS.has(step?.action)) continue;
    if (step.action === "navigate" && !/^https:\/\//i.test(String(step.url || ""))) continue;
    if (["stepThrough", "click", "clickBestEffort"].includes(step.action)) {
      if (DESTRUCTIVE_LABEL_RE.test(String(step.instruction || ""))) continue;
      const labels = (Array.isArray(step.labels) ? step.labels : step.label ? [step.label] : []).filter((l) => !DESTRUCTIVE_LABEL_RE.test(String(l)));
      if (!labels.length) continue;
      kept.push({ ...step, labels, label: undefined });
      continue;
    }
    kept.push(step);
  }
  if (!kept.some((s) => s.action === "screenshot")) kept.push({ action: "screenshot", fullPage: false });
  return kept;
}

function failureText(check) {
  return check.reasons.filter((r) => r.level === "fail").map((r) => r.message).join(" ") || "The screenshot did not pass the checks.";
}

/**
 * Capture one shot in an open page: run its steps, hide account details, take the
 * picture, and verify it. Retries once when the picture comes out blank.
 */
export async function captureShot({ page, shot, assetsDir, screenshotsDir, env, redact, terms, calloutMode, log, signInWaitMs = SIGN_IN_WAIT_MS, sleepFn = sleep, headless = false }) {
  const steps = safeSteps(shot.steps);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const evidence = { finalUrl: "", title: "", visibleText: [], redaction: null, capturedAt: null, executedSteps: 0 };
    const hooks = {
      async beforeScreenshot({ page: livePage, viewport, callouts }) {
        evidence.finalUrl = typeof livePage.url === "function" ? livePage.url() : "";
        evidence.title = typeof livePage.title === "function" ? await livePage.title().catch(() => "") : "";
        evidence.visibleText = await collectVisibleLabels(livePage, { terms });
        if (redact) evidence.redaction = await applyRedaction(livePage, { terms });
        if (calloutMode === "burn" && Array.isArray(callouts) && callouts.some((c) => c.rect)) {
          await burnCalloutMarkers(livePage, callouts, viewport);
        }
      },
      async afterScreenshot({ page: livePage }) {
        await clearOverlays(livePage);
      },
    };
    const outcome = await executePlaywrightLabShot({
      page,
      shot: { ...shot, steps },
      manifest: { startUrl: shot.startUrl },
      assetsDir,
      screenshotsDir,
      mode: "headed",
      env,
      authTimeoutMs: signInWaitMs,
      logger: log,
      hooks,
    });
    if (outcome.status !== "captured") return outcome;

    evidence.capturedAt = outcome.capturedAt;
    evidence.executedSteps = (outcome.executedSteps || []).length;
    evidence.title = scrubSensitiveText(evidence.title, terms);
    const bytes = fs.readFileSync(outcome.filePath);
    const check = verifyImage(bytes, {
      filename: shot.filename,
      evidence,
      expectedLabels: shot.expectedLabels,
      requireEvidence: true,
      requireRedaction: redact,
    });
    if (check.reasons.some((r) => r.code === "blank") && attempt === 1) {
      log("  The picture came out blank. Waiting a few seconds and trying once more.");
      await sleepFn(4000);
      continue;
    }
    if (!check.ok) return { status: "failed", error: failureText(check), check };
    return { status: "captured", bytes, check, evidence, callouts: outcome.callouts };
  }
  return { status: "failed", error: "The screenshot could not be captured." };
}

/**
 * Run every shot of a claimed job in a headed browser with a saved profile per product.
 * `playwright` is the Playwright module (injectable for tests).
 */
export async function runJob({ client, claimed, home, playwright, options = {}, log = console.log, shouldStop = () => false, sleepFn = sleep, heartbeatMs = HEARTBEAT_MS }) {
  const { job } = claimed;
  const shots = Array.isArray(claimed.shots) ? claimed.shots : [];
  const env = jobEnvironment(claimed.env);
  const jobOptions = job.options || {};
  const calloutMode = options.callouts || jobOptions.callouts || "sidecar";
  const redact = options.redact !== false && jobOptions.redact !== false;
  const terms = [...(options.maskTerms || []), ...(jobOptions.maskTerms || [])];
  const workDir = path.join(home, ".captures", job.id);
  const assetsDir = path.join(workDir, "assets");
  const screenshotsDir = path.join(workDir, "screenshots");
  const tally = { captured: 0, needsReview: 0, failed: 0, skipped: 0, manual: 0 };
  const state = { cancelled: false };
  const stopRequested = () => state.cancelled || shouldStop();
  const where = job.target?.type === "lab" ? `lab ${job.target.labId}` : "the shared library";
  log(`\nJob ${job.id}: ${shots.length} screenshot${shots.length === 1 ? "" : "s"} for ${where}${claimed.job.resumed ? " (resuming)" : ""}.`);

  const note = (message) => client.progress(job.id, { message }).then((r) => { if (r?.cancelRequested) state.cancelled = true; }).catch(() => {});
  const jobLog = (message) => {
    log(message);
    if (/sign-in/i.test(message)) void note("Waiting for you to sign in in the browser window.");
  };
  const report = async (shot, status, message, error = null) => {
    const reply = await client.progress(job.id, { shot: { filename: shot.filename, status, message, error } });
    if (reply?.cancelRequested) state.cancelled = true;
  };

  const heartbeat = setInterval(() => {
    client
      .heartbeat({ jobId: job.id, busy: true, signedInProducts: listSignedInProfiles(home) })
      .then((r) => { if (r?.cancelRequested) state.cancelled = true; })
      .catch(() => {});
  }, heartbeatMs);
  heartbeat.unref?.();

  const groups = new Map();
  for (const shot of shots) {
    const profile = /^[a-z0-9-]+$/i.test(String(shot.authProfile || "")) ? String(shot.authProfile) : "default";
    if (!groups.has(profile)) groups.set(profile, []);
    groups.get(profile).push(shot);
  }

  let fatalError = null;
  let index = 0;
  try {
    for (const [profile, profileShots] of groups) {
      if (stopRequested()) break;
      const authDir = path.join(home, ".auth", profile);
      let context = null;
      try {
        const needsBrowser = profileShots.some((s) => !s.manual && !(s.requiresEnv && !env[s.requiresEnv]));
        if (needsBrowser) {
          fs.mkdirSync(authDir, { recursive: true });
          log(`\nOpening the browser for ${profile}. If it asks you to sign in, sign in once; the companion remembers it.`);
          context = await playwright.chromium.launchPersistentContext(authDir, { headless: Boolean(options.headless), viewport: { width: 1440, height: 900 } });
        }
      } catch (err) {
        const text = String(err?.message || err);
        const missing = /Executable doesn't exist|playwright install/i.test(text);
        const message = missing ? "The Chromium browser is not installed. Run: npx playwright install chromium" : `The browser could not start: ${text.split("\n")[0]}`;
        log(`  ${message}`);
        for (const shot of profileShots) {
          index += 1;
          tally.failed += 1;
          await report(shot, "failed", null, message).catch(() => {});
        }
        continue;
      }

      try {
        const page = context ? context.pages()[0] || (await context.newPage()) : null;
        await page?.bringToFront?.().catch(() => {});
        for (const shot of profileShots) {
          index += 1;
          if (stopRequested()) {
            log("Stopping: the job was canceled or the companion is closing.");
            break;
          }
          log(`\n[${index}/${shots.length}] ${shot.filename}${shot.moduleTitle ? `  (${shot.moduleTitle})` : ""}`);

          if (shot.manual) {
            tally.manual += 1;
            log("  This screen is outside the browser. Capture it with an OS screenshot tool and upload it in the portal.");
            await report(shot, "manual-required", "Capture this one with an OS screenshot tool and upload it in the portal.");
            continue;
          }
          if (shot.requiresEnv && !env[shot.requiresEnv]) {
            tally.skipped += 1;
            const message = `This shot needs your tenant address in ${shot.requiresEnv}. Add it to the portal's brand profile, or set it on this computer before starting the companion.`;
            log(`  Skipped. ${message}`);
            await report(shot, "skipped", message);
            continue;
          }

          await report(shot, "running", "Capturing.");
          let result;
          try {
            result = await captureShot({ page, shot, assetsDir, screenshotsDir, env, redact, terms, calloutMode, log: jobLog, signInWaitMs: (options.signInWaitSec || SIGN_IN_WAIT_MS / 1000) * 1000, sleepFn, headless: Boolean(options.headless) });
          } catch (err) {
            result = { status: "failed", error: String(err?.message || err) };
          }

          if (result.status === "auth-required") {
            tally.failed += 1;
            const message = "You were not signed in. Sign in in the browser window, then queue this shot again.";
            log(`  ${message}`);
            await report(shot, "auth-required", null, message);
            continue;
          }
          if (result.status !== "captured") {
            tally.failed += 1;
            log(`  Could not capture: ${result.error}`);
            await report(shot, "failed", null, result.error);
            continue;
          }

          const callouts = calloutMode === "none" ? null : (result.callouts || []).map(({ n, label, rect }) => ({ n, label, rect: rect ?? null }));
          const uploaded = await uploadWithRetry(client, job.id, shot, { bytes: result.bytes, evidence: result.evidence, callouts, mime: mimeFor(shot.filename) }, { log, sleepFn });
          if (uploaded.body?.cancelRequested) state.cancelled = true;
          const outcome = uploaded.body?.outcome;
          if (outcome === "accepted") {
            tally.captured += 1;
            log("  Captured, verified, and saved to the portal.");
          } else if (outcome === "needs-review") {
            tally.needsReview += 1;
            const why = (uploaded.body?.verification?.reasons || []).map((r) => r.message).join(" ");
            log(`  Saved for review in the portal. ${why}`);
          } else {
            tally.failed += 1;
            log(`  The portal rejected the image: ${uploaded.body?.message || uploaded.body?.error || "it failed verification."}`);
          }
        }
        if (tally.captured + tally.needsReview > 0 && listSignedInProfiles(home).includes(profile)) {
          log(`\nThe browser profile for ${profile} is saved on this computer, so you will not need to sign in again.`);
        }
      } finally {
        await context?.close?.().catch(() => {});
      }
      if (stopRequested()) break;
    }
  } catch (err) {
    fatalError = err instanceof PortalError && err.kind === "auth" ? null : String(err?.message || err);
    if (err instanceof PortalError && err.kind === "auth") throw err;
    log(`\nThe job stopped early: ${fatalError}`);
  } finally {
    clearInterval(heartbeat);
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  const summary = `${tally.captured} captured, ${tally.needsReview} saved for review, ${tally.failed} failed, ${tally.skipped + tally.manual} not run.`;
  try {
    await client.complete(job.id, { message: summary, ...(fatalError ? { fatalError } : {}) });
  } catch (err) {
    if (err instanceof PortalError && err.kind === "auth") throw err;
    log(`Could not tell the portal the job finished: ${err.message}`);
  }
  log(state.cancelled ? `\nCanceled from the portal. ${summary}` : `\nJob finished: ${summary}`);
  return { cancelled: state.cancelled, tally, fatalError };
}

async function uploadWithRetry(client, jobId, shot, payload, { log, sleepFn }) {
  const delays = [2000, 5000, 10000];
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await client.upload(jobId, shot.filename, payload);
    } catch (err) {
      if (!(err instanceof PortalError) || err.kind === "auth" || err.kind === "client" || attempt >= delays.length) throw err;
      log(`  Upload did not go through (${err.message}). Trying again in ${delays[attempt] / 1000} seconds.`);
      await sleepFn(delays[attempt]);
    }
  }
}

// ── Preflight ──────────────────────────────────────────────────────────────

export async function preflight({ home, log = console.log, nodeVersion = process.versions.node, detect = detectBrowserAvailability } = {}) {
  const problems = [];
  const major = Number.parseInt(String(nodeVersion).split(".")[0], 10);
  if (!Number.isFinite(major) || major < MIN_NODE_MAJOR) {
    problems.push(`Node.js ${MIN_NODE_MAJOR} or later is required (this is ${nodeVersion}). Install it from https://nodejs.org and run this again.`);
  }
  const found = await detect({ repoRoot: path.resolve(HERE, "..", "..") });
  if (!found.playwrightInstalled) {
    problems.push(`The Playwright package is not installed. In this folder (${home}) run:\n    npm install\n    npx playwright install chromium`);
  } else if (!found.chromiumInstalled) {
    problems.push("The Chromium browser is not installed. In this folder run:\n    npx playwright install chromium\n  (or run this again with --install-browser)");
  }
  if (problems.length) {
    log("This computer is not ready yet:");
    for (const p of problems) log(`  - ${p}`);
  }
  return { ok: problems.length === 0, problems, found };
}

function installBrowser(log) {
  return new Promise((resolve) => {
    log("Installing the Chromium browser (one time)...");
    const child = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["playwright", "install", "chromium"], { cwd: HERE, stdio: "inherit", shell: process.platform === "win32" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())));
  } finally {
    rl.close();
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

/**
 * Run the companion. Returns an exit code. Everything it needs can be injected
 * so the whole flow runs in tests without a real browser or portal.
 */
export async function runCompanion(argv = process.argv.slice(2), deps = {}) {
  const log = deps.log || console.log;
  const opts = parseArgs(argv);
  if (opts.help) {
    log(helpText());
    return EXIT.ok;
  }
  if (opts.error) {
    log(opts.error);
    return EXIT.usage;
  }
  const home = path.resolve(opts.home || process.env.COMPANION_HOME || HERE);
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const sleepFn = deps.sleepFn || sleep;

  log(`Local Capture Companion ${COMPANION_VERSION}`);

  if (opts.unpair) {
    clearConfig(home);
    log("This computer is no longer paired. To remove it from the portal list too, select Disconnect there.");
    return EXIT.ok;
  }
  if (opts.installBrowser) return (await (deps.installBrowser || installBrowser)(log)) ? EXIT.ok : EXIT.usage;

  const ready = await (deps.preflight || preflight)({ home, log });
  if (!ready.ok) return EXIT.usage;
  if (opts.check) {
    log("This computer is ready.");
    return EXIT.ok;
  }

  let config = loadConfig(home);
  const interactive = Boolean(process.stdin.isTTY) && !deps.nonInteractive;
  if (opts.code || !config) {
    let portalText = opts.portal || config?.portal;
    let code = opts.code;
    if (!portalText && interactive) portalText = await ask("Portal address (for example https://my-portal.azurecontainerapps.io): ");
    if (!code && interactive) code = await ask("Pairing code from the portal (for example ABCD-EFGH): ");
    const checked = validatePortalUrl(portalText);
    if (!checked.ok) {
      log(checked.error);
      return EXIT.usage;
    }
    if (!code) {
      log("This computer is not paired. In the portal, open the Screenshot Center, select Connect a computer, and run this again with --portal=<address> --code=<code>.");
      return EXIT.usage;
    }
    try {
      const paired = await createPortalClient({ portal: checked.portal, fetchImpl }).pair({ code, deviceName: opts.deviceName || os.hostname() });
      config = { portal: checked.portal, token: paired.token, deviceId: paired.device.id, deviceName: paired.device.name, pairedAt: new Date().toISOString() };
      saveConfig(home, config);
      log(`Paired with ${checked.portal} as "${config.deviceName}".`);
    } catch (err) {
      log(err.message);
      return err instanceof PortalError && err.kind === "unreachable" ? EXIT.unreachable : EXIT.auth;
    }
  } else if (opts.portal) {
    const checked = validatePortalUrl(opts.portal);
    if (checked.ok && checked.portal !== config.portal) {
      log(`This computer is paired with ${config.portal}, not ${checked.portal}. Run with --unpair first, then pair again.`);
      return EXIT.usage;
    }
  }

  const client = deps.client || createPortalClient({ portal: config.portal, token: config.token, fetchImpl });

  if (opts.status) {
    try {
      const beat = await client.heartbeat({ busy: false, signedInProducts: listSignedInProfiles(home) });
      log(`Connected to ${config.portal} as "${config.deviceName}". Pairing valid until ${beat.tokenExpiresAt}.`);
      const signedIn = listSignedInProfiles(home);
      log(signedIn.length ? `Signed in to: ${signedIn.join(", ")}` : "Not signed in to any product yet. The first capture opens a browser window to sign in.");
      return EXIT.ok;
    } catch (err) {
      log(err.message);
      return err.kind === "auth" ? EXIT.auth : EXIT.unreachable;
    }
  }

  const playwright = deps.playwright || (await loadPlaywrightModule(path.resolve(HERE, "..", "..")));
  let stopping = false;
  const onSigint = () => {
    if (stopping) process.exit(130);
    stopping = true;
    log("\nStopping after the current screenshot. Press Ctrl+C again to quit now.");
  };
  if (!deps.noSignals) process.on("SIGINT", onSigint);

  const runnerOptions = { callouts: opts.callouts, maskTerms: opts.maskTerms, redact: opts.redact, signInWaitSec: opts.signInWaitSec, headless: opts.headless };
  const pollMs = (deps.pollMs ?? opts.intervalSec * 1000);
  let lastBeat = 0;
  let announced = false;
  let waitedMs = 0;
  let unreachableShown = false;
  let backoffMs = 0;
  log(`Connected to ${config.portal}.`);

  try {
    while (!stopping && !deps.shouldStop?.()) {
      try {
        if (Date.now() - lastBeat >= HEARTBEAT_MS || lastBeat === 0) {
          await client.heartbeat({ busy: false, signedInProducts: listSignedInProfiles(home) });
          lastBeat = Date.now();
        }
        const claimed = await client.next();
        unreachableShown = false;
        backoffMs = 0;
        if (claimed) {
          announced = false;
          await runJob({ client, claimed, home, playwright, options: runnerOptions, log, shouldStop: () => stopping, sleepFn });
          lastBeat = 0;
          if (opts.once) break;
          continue;
        }
        if (opts.once) {
          if (waitedMs >= opts.waitSec * 1000) {
            log("No capture jobs are waiting. In the portal, start a capture, then run this again.");
            break;
          }
          waitedMs += pollMs;
        } else if (!announced) {
          log("Waiting for capture jobs from the portal. Leave this window open. Press Ctrl+C to stop.");
          announced = true;
        }
        await sleepFn(pollMs);
      } catch (err) {
        if (err instanceof PortalError && err.kind === "auth") {
          log(`\n${err.message}`);
          if (err.code === "token-revoked" || err.code === "token-expired" || err.code === "token-invalid") clearConfig(home);
          return EXIT.auth;
        }
        if (opts.once) {
          log(err.message);
          return err.kind === "unreachable" ? EXIT.unreachable : EXIT.usage;
        }
        if (!unreachableShown || err.kind !== "unreachable") log(`${err.message} I will keep trying.`);
        unreachableShown = err.kind === "unreachable";
        backoffMs = Math.min(60_000, Math.max(pollMs, backoffMs * 2 || pollMs));
        await sleepFn(err.retryAfterSec ? err.retryAfterSec * 1000 : backoffMs);
      }
    }
  } finally {
    if (!deps.noSignals) process.off("SIGINT", onSigint);
  }
  return EXIT.ok;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCompanion().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`The companion stopped: ${err?.message || err}`);
      process.exit(1);
    },
  );
}
