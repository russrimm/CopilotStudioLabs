#!/usr/bin/env node
// Local Capture Companion for the Microsoft AI Training Generator portal.
//
// Runs on your own computer. You pair it with the portal once, sign in to each
// Microsoft product once in the browser window it opens, and from then on the
// portal can ask it to capture screenshots. It checks every image, hides account
// details, uploads the result, and the portal updates your lab for you.
//
// What it never does: it never types into tenant pages (you sign in yourself),
// never clicks a control whose name says delete, remove, reset, sign in, sign out,
// or switch account, and never sends your password, cookies, or browser profile
// anywhere. Only screenshots, page addresses, and visible control names leave this
// computer, and only to the portal you paired with.
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

import { parseAccountMode, readAccountRecord, readEdgeSignInPolicy, resolveOsAccount } from "./account-source.mjs";
import { describeAccountState, describeAccount, browserShortName, verifyProductAccount } from "./account-guard.mjs";
import { createAuthGate, forgetSignIn, listSignedInProducts, productLabel, profileDir, profileNamespace, readSignInStates, restoreSession, saveSession, SESSION_FILE } from "./auth.mjs";
import { closeAllAttached, closeEarlierBrowser, closeStrayTabs, fitWindow, launchAttached, parseLaunchChoice, reconnectAttached, wantsAttach } from "./attach.mjs";
import { browserLabel, chooseBrowsers, detectInstalledBrowsers, isMissingBrowserError, launchBrowser, launchPolicy, missingBrowserMessage, parseBrowserChoice } from "./browsers.mjs";
import { createCaptureSession } from "./capture-run.mjs";
import { causeForVerification, describeCause } from "./causes.mjs";
import { createSignInDiagnoser, runCheckSignIn } from "./check-signin.mjs";
import { runSetupAccount } from "./account-setup.mjs";
import { diagnosticAdvice, writeDiagnostic } from "./diagnostics.mjs";
import { blockedInstructionReason, blockedLabelReason, resolveAutonomy } from "./guard.mjs";
import { deleteOldSignIn, describeHomeState, migrateLegacyHome, oldSignInAdvice, resolveHome, syncedHomeMessage } from "./home.mjs";
import { verifyImage } from "./image-verify.mjs";
import { detectBrowserAvailability, executePlaywrightLabShot, loadPlaywrightModule } from "./lab-runner.mjs";
import { briefError, classifyBrowserError, ensureLivePage, gotoWithRetry, watchContext } from "./lifecycle.mjs";
import { UNSAFE_PROFILE_MESSAGE, createProfileWaiter, isDefaultBrowserDir, isProfileInUseFailure } from "./profile-guard.mjs";
import { dryRunPlan } from "./dry-run.mjs";
import { createPracticeRegistry, summarizeCreated, writePracticeReport } from "./practice.mjs";
import { createRecipeStore } from "./recipes.mjs";
import { applyRedaction, burnCalloutMarkers, clearOverlays, collectVisibleLabels, scrubSensitiveText } from "./redact.mjs";
import { diagnosisLines, signInReport } from "./signin-diagnosis.mjs";
import { effectiveModeFor, maskedAddress, targetField, targetValuesFromJob, validateTargetValue } from "./targets.mjs";
import { createTrace, traceFilePath } from "./trace.mjs";
import { resolveStage } from "./walkthrough.mjs";
import { startAgainLines } from "./start-hint.mjs";

export const COMPANION_VERSION = "1.6.1";
export const MIN_NODE_MAJOR = 20;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_NAME = ".companion.json";
const HEARTBEAT_MS = 20_000;
const SIGN_IN_WAIT_MS = 10 * 60 * 1000;
const ALLOWED_ACTIONS = new Set(["navigate", "waitForLoadState", "dismissBanners", "stepThrough", "click", "clickBestEffort", "probeControl", "probeCallouts", "screenshot"]);
// After this many jobs in a row ended without a sign-in, stop picking up jobs on their own (restart the companion to try again).
const MAX_SIGN_IN_FAILURES = 3;
const SIGN_IN_BACKOFF_MS = [30_000, 60_000];
// A job the portal keeps handing back is run at most this many times by one companion process.
const MAX_JOB_RUNS = 2;

export const EXIT = Object.freeze({ ok: 0, usage: 1, unreachable: 2, auth: 3, signIn: 4 });

// ── Command line ───────────────────────────────────────────────────────────

export function helpText() {
  return `Local Capture Companion ${COMPANION_VERSION}

Usage:
  node companion.mjs --portal=<address> --code=<pairing code>   Pair this computer, then wait for jobs
  node companion.mjs                                            Wait for jobs (after pairing)
  node companion.mjs --once [--wait=<seconds>]                  Run one queued job and exit
  node companion.mjs --status                                   Show the connection, the data folder, and the sign-in state of each product
  node companion.mjs --check-signin[=<product>]                  Open the product once, watch the sign-in, and say why it does or does not stick (default copilot-studio)
  node companion.mjs --setup-account[=<product>]                 Choose which account the screenshots come from: opens the product so you sign in with the account you want (for example your demo tenant), then remembers it
  node companion.mjs --forget-signin=<product|all>              Delete the saved sign-in for a product (you sign in again next time)
  node companion.mjs --delete-old-signin                         Delete the old sign-in folder that earlier versions kept beside the code
  node companion.mjs --dry-run-plan[=<job file>]                 Print every step the computer would take, tier by tier, without a browser
  node companion.mjs --diagnose[=<product>]                      Write a redacted diagnostic file for the page open in a live browser
  node companion.mjs --unpair                                   Forget this computer's pairing

Options:
  --browser=auto|edge|chrome|chromium   Which browser to open (default auto). On a PC with a Windows work account, auto tries Google Chrome, then Chromium, then Microsoft Edge (opened InPrivate), so a screenshot is not taken with your work account by accident. Otherwise: Edge, then Chrome, then Chromium
  --account-mode=separate|windows   Which account the browser signs in with. separate (the default on a PC with a Windows work account): you sign in yourself, once, with the account you want, and Edge is never used with your Windows account. windows: allow Edge to sign in with your Windows work account on purpose (screenshots then come from that account)
  --launch=auto|attach|playwright   How Edge or Chrome is started. attach (the default for them) starts your normal browser and connects to it, which keeps work sign-in working; playwright uses the automation launcher
  --callouts=sidecar|burn|none   Numbered callouts: save positions only (default), draw them on the image, or skip
  --mask=<text>[,<text>]         Extra text to hide (for example your tenant name)
  --no-redact                    Do not hide account details (not recommended)
  --headless                     No visible window. It cannot sign in, so use it only for public pages and automated checks
  --background                   Run in a hidden window when a sign-in is already saved; a visible window opens if the product asks you to sign in again
  --allow-practice-writes        Advanced: let this computer build and use a practice agent for any job you allowed in the portal, without asking. Normally you do not need it: the first time a job asks to build a practice agent from scratch (or at the end of --setup-account) the companion asks you once. Saved until you use --no-practice-writes
  --no-practice-writes           Never create anything, whatever a job says (also forgets an earlier yes)
  --device-name=<name>           Name shown in the portal (default: this computer's name)
  --interval=<seconds>           How often to ask the portal for jobs (default 4)
  --sign-in-wait=<seconds>       How long to wait for you to sign in (default 600)
  --guided-wait=<seconds>        How long to wait for you at a screen you set up yourself (default 120), then it is marked "needs you"
  --ready-wait=<seconds>         How long to wait for a page to finish loading before the picture (default 20)
  --home=<folder>                Where the pairing file and browser sign-ins live (default: a local folder of your user account, never a synced one)
  --allow-synced-home            Use a --home that is inside OneDrive, Dropbox, iCloud Drive, or Google Drive anyway (not recommended: sign-in can loop)
  --debug                        Write a redacted trace (no cookies, tokens, page text, or account names) and print where it is
  --trace=<file>                 Same as --debug, writing to this file (a relative name is inside the --home folder)
  --install-browser              Install the Chromium browser, then exit
  --check                        Check this computer is ready, then exit
  --verbose                      Print more detail
  --help                         Show this help
`;
}

const parseDefaults = () => ({ watch: true, once: false, waitSec: 0, callouts: null, maskTerms: [], redact: true, intervalSec: 4, signInWaitSec: SIGN_IN_WAIT_MS / 1000, verbose: false, browser: "auto", launch: "auto", debug: false, trace: null, forgetSignin: null, accountMode: null, setupAccount: null });

export function parseArgs(argv = []) {
  const opts = parseDefaults();
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
    else if (arg === "--background") opts.background = true;
    else if (arg === "--allow-practice-writes") opts.allowPracticeWrites = true;
    else if (arg === "--no-practice-writes") opts.allowPracticeWrites = false;
    else if (arg === "--dry-run-plan") opts.dryRunPlan = true;
    else if (arg === "--diagnose") opts.diagnose = "copilot-studio";
    else if (arg.startsWith("--dry-run-plan=")) opts.dryRunPlan = arg.slice("--dry-run-plan=".length) || true;
    else if (arg.startsWith("--diagnose=")) {
      const product = arg.slice("--diagnose=".length);
      if (!/^[a-z0-9-]{1,60}$/i.test(product)) opts.error = "--diagnose needs a product name such as copilot-studio.";
      else opts.diagnose = product;
    }
    else if (arg === "--verbose") opts.verbose = true;
    else if (arg === "--debug") opts.debug = true;
    else if (arg === "--unpair") opts.unpair = true;
    else if (arg === "--status") opts.status = true;
    else if (arg === "--check") opts.check = true;
    else if (arg === "--allow-synced-home") opts.allowSyncedHome = true;
    else if (arg === "--delete-old-signin") opts.deleteOldSignin = true;
    else if (arg === "--check-signin") {
      // The product may follow as a separate word (--check-signin copilot-studio).
      const next = list[i + 1];
      if (next !== undefined && /^[a-z0-9-]{1,60}$/i.test(next) && !next.startsWith("--")) {
        opts.checkSignin = next;
        i += 1;
      } else opts.checkSignin = "copilot-studio";
    } else if (arg.startsWith("--check-signin=")) {
      const product = arg.slice("--check-signin=".length);
      if (!/^[a-z0-9-]{1,60}$/i.test(product)) opts.error = "--check-signin needs a product name such as copilot-studio.";
      else opts.checkSignin = product;
    }
    else if (arg === "--install-browser") opts.installBrowser = true;
    else if (arg === "--setup-account") {
      // The product may follow as a separate word (--setup-account copilot-studio).
      const next = list[i + 1];
      if (next !== undefined && /^[a-z0-9-]{1,60}$/i.test(next) && !next.startsWith("--")) {
        opts.setupAccount = next;
        i += 1;
      } else opts.setupAccount = "copilot-studio";
    } else if (arg.startsWith("--setup-account=")) {
      const product = arg.slice("--setup-account=".length);
      if (!/^[a-z0-9-]{1,60}$/i.test(product)) opts.error = "--setup-account needs a product name such as copilot-studio.";
      else opts.setupAccount = product;
    }
    else if ((v = valued("portal")) !== undefined) opts.portal = v;
    else if ((v = valued("code")) !== undefined) opts.code = v;
    else if ((v = valued("home")) !== undefined) opts.home = v;
    else if ((v = valued("device-name")) !== undefined) opts.deviceName = v;
    else if ((v = valued("wait")) !== undefined) opts.waitSec = Math.max(0, Number(v) || 0);
    else if ((v = valued("interval")) !== undefined) opts.intervalSec = Math.max(1, Number(v) || 4);
    else if ((v = valued("sign-in-wait")) !== undefined) opts.signInWaitSec = Math.max(30, Number(v) || 600);
    else if ((v = valued("guided-wait")) !== undefined) opts.guidedWaitSec = Math.max(5, Number(v) || DEFAULT_GUIDED_WAIT_SEC);
    else if ((v = valued("ready-wait")) !== undefined) opts.readyWaitSec = Math.max(2, Number(v) || 20);
    else if ((v = valued("browser")) !== undefined) {
      const choice = parseBrowserChoice(v === true ? "" : v);
      if (choice.ok) opts.browser = choice.browser;
      else opts.error = choice.error;
    } else if ((v = valued("account-mode")) !== undefined) {
      const choice = parseAccountMode(v === true ? "" : v);
      if (choice.ok) opts.accountMode = choice.mode;
      else opts.error = choice.error;
    } else if ((v = valued("launch")) !== undefined) {
      const choice = parseLaunchChoice(v === true ? "" : v);
      if (choice.ok) opts.launch = choice.launch;
      else opts.error = choice.error;
    } else if ((v = valued("trace")) !== undefined) {
      if (!v || v === true) opts.error = "--trace needs a file name, for example --trace=signin-trace.log.";
      else {
        opts.trace = v;
        opts.debug = true;
      }
    } else if ((v = valued("forget-signin")) !== undefined) {
      if (!v || v === true || !/^(?:all|[a-z0-9-]+)$/i.test(v)) opts.error = "--forget-signin needs a product name (for example copilot-studio) or all.";
      else opts.forgetSignin = v;
    } else if ((v = valued("callouts")) !== undefined) {
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

// ── This computer's own settings ───────────────────────────────────────────

const SETTINGS_NAME = ".companion-settings.json";

/**
 * What this computer allows, whatever a job asks for: whether a practice agent may be created (the advanced
 * `--allow-practice-writes` switch), and the one-time local opt-in per product for building the practice agent from scratch.
 */
export function loadSettings(home) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(home, SETTINGS_NAME), "utf8"));
    const optIn = parsed?.practiceOptIn && typeof parsed.practiceOptIn === "object" && !Array.isArray(parsed.practiceOptIn) ? parsed.practiceOptIn : {};
    const clean = {};
    for (const [product, at] of Object.entries(optIn)) if (/^[a-z0-9-]{1,60}$/i.test(product) && typeof at === "string") clean[product] = at.slice(0, 40);
    return { allowPracticeWrites: parsed?.allowPracticeWrites === true, practiceOptIn: clean };
  } catch {
    return { allowPracticeWrites: false, practiceOptIn: {} };
  }
}

/** Save a change to the settings; what is not mentioned keeps its value. */
export function saveSettings(home, patch) {
  const current = loadSettings(home);
  const next = { allowPracticeWrites: patch.allowPracticeWrites === undefined ? current.allowPracticeWrites : patch.allowPracticeWrites === true, practiceOptIn: patch.practiceOptIn === undefined ? current.practiceOptIn : patch.practiceOptIn };
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, SETTINGS_NAME);
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return next;
}

/** Whether this computer has agreed to build a practice agent for a product (the advanced switch counts for every product). */
export function hasPracticeOptIn(settings, product = "copilot-studio") {
  return settings?.allowPracticeWrites === true || Boolean(settings?.practiceOptIn?.[product]);
}

const ACCOUNT_CONFIRM_QUESTION = "\nYou are signed in in this window. Use THIS account for the practice agent and the screenshots? Only your yes is saved, never the account's name. Type yes to continue (anything else stops, and nothing is changed): ";

const OPT_IN_QUESTION = [
  "",
  "The Screenshot Center asked this computer to BUILD A PRACTICE AGENT in your demo account and use it to take the lab's screenshots.",
  "It will create one new agent named “Lab screenshots - <lab title>”, set its instructions, add a public website as knowledge, ask it a sample question,",
  "and publish only that practice agent, once, to its default state (no channels, no sharing, no audience changes). It never deletes anything, never touches another agent,",
  "never shares or publishes to channels, and never changes tenant or admin settings. You can delete the practice agent yourself afterward.",
  "Allow this computer to do that for Copilot Studio? (yes/no) ",
].join("\n");

/**
 * The one-time local opt-in: the portal's consent alone is not enough for a computer to create things, so this asks once, in the
 * console, and remembers the answer for the product. Without a person at the console (or an answer of yes) nothing is created.
 * @returns {Promise<boolean>} whether this computer allows it now
 */
export async function ensurePracticeOptIn({ home, product = "copilot-studio", prompt = null, interactive = false, log = console.log } = {}) {
  const settings = loadSettings(home);
  if (hasPracticeOptIn(settings, product)) return true;
  if (!interactive || typeof prompt !== "function") {
    log("This job asks the computer to build a practice agent, but this computer has not agreed to that yet and nobody can be asked here. Run the companion in a normal console window and answer yes once, or run it once with --allow-practice-writes. Nothing was created.");
    return false;
  }
  const answer = await prompt(OPT_IN_QUESTION).catch(() => "");
  if (!/^y(?:es)?$/i.test(String(answer).trim())) {
    log("Understood. Nothing will be created. Screens that need the practice agent are marked “needs you”.");
    return false;
  }
  saveSettings(home, { practiceOptIn: { ...settings.practiceOptIn, [product]: new Date().toISOString() } });
  log("Saved on this computer: jobs you allow in the portal may build and use a practice agent. Run with --no-practice-writes to take this back.");
  return true;
}

/**
 * Open the product in a hidden window with the saved sign-in and check it does not ask to sign in again. A product that
 * does (Conditional Access, a sign-in redirect) cannot run in the background: the caller opens a visible window instead.
 */
export async function probeBackground({ opened, profile, shot, env = {}, sleepFn = sleep, trace = null }) {
  const { context } = opened;
  const page = context.pages()[0] || (await context.newPage());
  const target = (shot?.urlEnv && env[shot.urlEnv]) || shot?.startUrl || shot?.capture?.route?.url || "https://copilotstudio.microsoft.com/";
  try {
    await gotoWithRetry(page, target, { waitUntil: "domcontentloaded", sleep: sleepFn, retries: 1, trace });
    const gate = createAuthGate({ product: profile, waitMs: 0, allowWait: false, pollMs: 100, settleMs: 800, graceMs: 1500, sleep: sleepFn, trace });
    const result = await gate.ensureSignedIn(page, { phase: "probe", target });
    return result.ok ? { ok: true } : { ok: false, why: "it needs you to sign in" };
  } catch (err) {
    if (classifyBrowserError(err) === "browser-closed") throw err;
    return { ok: false, why: "the page did not open" };
  }
}

/**
 * Products whose sign-in has worked on this computer: a screenshot was captured and the session was saved.
 * A profile folder alone does not count (the browser creates one the moment it opens, signed in or not).
 */
export function listSignedInProfiles(home, { namespace } = {}) {
  return listSignedInProducts(home, { namespace });
}

const ACCOUNT_SOURCE_WORDS = { "windows-sso": "your Windows work account signed in by itself", manual: "you signed in yourself", "saved-session": "a saved sign-in (made earlier)", unknown: "not checked yet" };

/** Plain-language lines about each product's sign-in on this computer, for --status. */
export function describeSignInState(home) {
  const states = readSignInStates(home);
  if (!states.length) return ["Not signed in to any product yet. The first capture opens a browser window to sign in."];
  const yesNo = (value) => (value ? "yes" : "no");
  const lines = ["Sign-in on this computer:"];
  for (const entry of states) {
    const verdict = entry.signedIn ? "signed in" : entry.profiles.some((p) => p.profilePresent) ? "not confirmed (no capture has worked yet)" : "not signed in";
    lines.push(`  ${entry.label} (${entry.product}): ${verdict}`);
    for (const p of entry.profiles) {
      const last = p.lastCapturedAt ? p.lastCapturedAt.replace("T", " ").slice(0, 16) : "never";
      const kind = p.namespace === "separate" ? " (separate sign-in)" : "";
      lines.push(`    ${browserLabel(p.browser)}${kind}: profile saved ${yesNo(p.profilePresent)}, session saved ${yesNo(p.savedSession)}, last successful capture ${last}`);
      if (p.accountSource) lines.push(`      Account: ${ACCOUNT_SOURCE_WORDS[p.accountSource] || p.accountSource}${p.accountVerified ? ", checked against your address" : p.accountConfirmed ? ", confirmed by you" : ", not verified"}${p.accountInOsTenant === true ? "; it is the same account Windows uses for work" : ""}.`);
    }
  }
  lines.push("To make a product ask for sign-in again, run with --forget-signin=<product> (or all). To choose which account is used, run with --setup-account.");
  return lines;
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
    if (res.status === 204) return { status: 204, body: null, wake: res.headers?.get?.("x-companion-wake") === "1" };
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
  // The portal sets a header on an empty job reply when it has something to tell this computer (a request to choose the
  // account). Older portals never do, and older companions ignore it.
  let wake = false;

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
      wake = result.status === 204 && result.wake === true;
      return result.status === 204 ? null : must(result, "the job request");
    },
    /** Whether the last empty job reply said the portal has something waiting for this computer. Reading it clears it. */
    takeWake() {
      const value = wake;
      wake = false;
      return value;
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
    /** Share a recipe (anonymous: control names only). The portal checks it again and refuses anything that could identify a tenant. */
    async shareRecipe(recipe) {
      return must(await request("POST", "/api/capture/companion/recipes", { json: { recipe } }), "the recipe");
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

/** Keep allowed actions only, and drop any step aimed at a control that deletes something, signs in or out, or switches the account. */
export function safeSteps(steps) {
  const kept = [];
  for (const step of Array.isArray(steps) ? steps : []) {
    if (!ALLOWED_ACTIONS.has(step?.action)) continue;
    if (step.action === "navigate" && !/^https:\/\//i.test(String(step.url || ""))) continue;
    if (["stepThrough", "click", "clickBestEffort"].includes(step.action)) {
      if (blockedInstructionReason(step.instruction)) continue;
      const labels = (Array.isArray(step.labels) ? step.labels : step.label ? [step.label] : []).filter((l) => !blockedLabelReason(l));
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
 * Open a product's browser profile in the first available browser of `kinds`, and put its saved session back.
 * Edge and Chrome are started the normal way and connected to (see attach.mjs) unless `launch` is "playwright"; if that
 * cannot start, the automation launcher is used with one clear message. A browser that is not installed is skipped;
 * any other launch problem is reported as it is.
 *
 * Before any browser is started the profile is checked (see profile-guard.mjs). A browser this companion started earlier that
 * still answers is used again. A profile held by anything else is never touched: the person is told what to close, and the
 * start waits (up to two minutes) for it to be free, then throws `PROFILE_BUSY`, which the job reports as "waiting", not "failed".
 * The automation launcher is never tried for a profile that is in use, because it can only fail the same way.
 * `profileWait` changes how the check and the wait run (tests); `onWaiting` hears each message while waiting.
 */
export async function openProfile({ playwright, home, profile, kinds, headless = false, log = console.log, trace = null, launch = "auto", installed = null, attachOptions = {}, account = null, profileWait = {}, onWaiting = null }) {
  const found = installed || detectInstalledBrowsers();
  // Where the profile lives and how Edge is opened depend on the account mode (see browsers.mjs and auth.mjs).
  const osWorkAccount = account?.os?.osWorkAccount ?? null;
  const namespace = account ? profileNamespace({ mode: account.mode, osWorkAccount }) : "";
  for (const kind of kinds) {
    const dir = profileDir(home, kind, profile, namespace);
    // Never the folder a person's everyday browser uses (a browser ignores the debugging port there, and it is theirs).
    if (isDefaultBrowserDir(dir)) throw Object.assign(new Error(UNSAFE_PROFILE_MESSAGE), { code: "UNSAFE_PROFILE" });
    const { inPrivate } = account ? launchPolicy({ kind, accountMode: account.mode, osWorkAccount }) : { inPrivate: false };
    const waiter = createProfileWaiter({
      dir,
      kind,
      headless,
      inPrivate,
      log,
      trace,
      onWaiting,
      closeEarlier: (record, wsUrl) => closeEarlierBrowser({ playwright, record, wsUrl, dir, trace, ...(attachOptions.sleep ? { sleep: attachOptions.sleep } : {}), ...(attachOptions.exitWaitMs ? { exitWaitMs: attachOptions.exitWaitMs } : {}) }),
      ...profileWait,
    });
    const startOnce = async (turn) => {
      let context = null;
      let how = "playwright";
      if (turn.action === "reuse") {
        // A browser this companion started earlier is still running and answers: use it instead of starting another one.
        try {
          ({ context } = await reconnectAttached({ playwright, kind, dir, record: turn.ours, wsUrl: turn.wsUrl, trace, ...attachOptions }));
        } catch (err) {
          throw Object.assign(err, { profileInUse: true });
        }
        how = "attach";
        log(`  Reconnected to the ${browserLabel(kind)} window that this companion opened earlier (it was still open).`);
      } else if (wantsAttach({ launch, kind, playwright, executable: found[kind] })) {
        try {
          ({ context } = await launchAttached({ playwright, kind, dir, executable: found[kind], headless, inPrivate, trace, ...attachOptions }));
          how = "attach";
        } catch (err) {
          if (isProfileInUseFailure(err)) throw err;
          // "Closed right away" is a hand-over to a browser that already has the profile as often as it is a blocked debugging port: look before blaming the port.
          if (err?.code === "BROWSER_EXITED" && (await waiter.inspect()).state !== "free") throw Object.assign(err, { profileInUse: true });
          if (launch === "attach") throw err;
          log(`  ${browserLabel(kind)} could not be started the normal way (${briefError(err)}). Opening it with the automation launcher instead.${osWorkAccount === true ? " If your organization needs a managed browser, sign-in may not work." : ""}`);
          trace?.event("attach-fallback", { browser: kind, why: err?.code || "error" });
        }
      }
      if (!context) context = await launchBrowser({ playwright, kind, dir, headless, inPrivate });
      if (how === "attach") {
        const pages = typeof context.pages === "function" ? context.pages() : [];
        await closeStrayTabs(context, pages.find((p) => /^about:blank/i.test(String(p.url?.() || ""))) || pages[0] || null, { trace });
        if (!headless) await fitWindow(context, { trace });
      }
      const restored = await restoreSession({ context, dir });
      log(`  Opened ${browserLabel(kind)}${inPrivate ? " InPrivate" : ""}${how === "attach" ? (turn.action === "reuse" ? " (the window from before)" : " (started the normal way)") : ""}.${how === "attach" && !headless ? " If another window covers it, click its icon on the taskbar." : ""}${restored.restored ? " Your saved sign-in was restored." : ""}`);
      trace?.event("profile-open", { product: profile, browser: kind, launch: how, reused: turn.action === "reuse", inPrivate, namespace: namespace || "original", restoredCookies: restored.restored, restoreReason: restored.reason });
      return { context, kind, dir, launch: how, inPrivate, namespace, restored: restored.restored };
    };
    try {
      let startFailed = false;
      for (;;) {
        const turn = await waiter.next({ startFailed });
        startFailed = false;
        try {
          return await startOnce(turn);
        } catch (err) {
          if (!isProfileInUseFailure(err)) throw err;
          // The browser itself says the profile is taken. The raw words stay in the trace; the person gets the plain ones from the wait.
          trace?.event("browser-start-failed", { browser: kind, why: "profile-in-use", detail: rawErrorLine(err) });
          startFailed = true;
        }
      }
    } catch (err) {
      if (err?.code === "PROFILE_BUSY" || !isMissingBrowserError(err)) throw err;
      trace?.event("browser-missing", { browser: kind });
      if (kinds.length > 1) log(`  ${browserLabel(kind)} was not found. Trying the next browser.`);
    }
  }
  throw Object.assign(new Error(missingBrowserMessage(kinds.length === 1 ? kinds[0] : "auto")), { code: "BROWSER_MISSING" });
}

/** The first line of a browser error with the user's folder name taken out, for the trace only. */
function rawErrorLine(err) {
  return String(err?.message || err || "").split("\n")[0].replace(/[A-Za-z]:\\Users\\[^\\\s]+/gi, "%USERPROFILE%").replace(/\/(?:home|Users)\/[^/\s]+/g, "~").slice(0, 240);
}

/** What a person reads when the browser could not start for a reason that is not "missing" or "in use". The raw text goes to the trace. */
export function plainStartFailure(err) {
  const first = String(err?.message || err || "").split("\n")[0].replace(/^browserType\.\w+:\s*/, "").replace(/\s+/g, " ").trim().slice(0, 200);
  return `The browser could not start${first ? `: ${first}` : ""}. Run the companion with --debug to write a trace of what happened.`;
}

/**
 * Capture one shot in an open page: follow its plan, hide account details, take the picture, and verify it.
 * Retries once, with longer waits, when the picture comes out blank or almost one color (a page that was still
 * loading); a guided shot is never retried, because a person set it up.
 * `auth` is the product's sign-in gate (one per product per job); without one, this shot gets its own.
 * `session` is what the job has learned about the product (the environment and agent); `effectiveMode` is
 * "auto" or "guided" for a classified shot.
 */
export async function captureShot({ page, shot, assetsDir, screenshotsDir, env, redact, terms, calloutMode, log, signInWaitMs = SIGN_IN_WAIT_MS, sleepFn = sleep, headless = false, auth = null, trace = null, session = null, effectiveMode = null, readiness = {}, guided = {} }) {
  const steps = safeSteps(shot.steps);
  const classified = Boolean(shot.capture?.version);
  const mode = classified ? effectiveMode || (shot.capture.mode === "guided" ? "guided" : "auto") : "legacy";
  // Built from scratch, the walkthrough proves each screen by its tabs and controls; the address alone cannot (the newer layout keeps /knowledge in the address while showing Build).
  const scratchLenient = session?.autonomy?.scratch === true && resolveStage(shot).scoped;
  const attempts = mode === "guided" ? 1 : 2;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const evidence = { finalUrl: "", title: "", visibleText: [], redaction: null, capturedAt: null, executedSteps: 0, mode, routeSteps: [], setup: null };
    const hooks = {
      collectLabels: (livePage) => collectVisibleLabels(livePage, { terms }),
      async beforeScreenshot({ page: livePage, viewport, callouts }) {
        evidence.finalUrl = typeof livePage.url === "function" ? livePage.url() : "";
        // A practice agent's address names the person's environment and the agent: the portal is told the shape of the page only.
        if (session?.autonomy?.scratch === true && evidence.finalUrl) evidence.finalUrl = maskedAddress(evidence.finalUrl) || "";
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
      mode: headless ? "headless" : "headed",
      env,
      authTimeoutMs: signInWaitMs,
      logger: log,
      hooks,
      auth,
      trace,
      session,
      effectiveMode: classified ? mode : null,
      readiness,
      guided,
      attempt,
      sleep: sleepFn,
    });
    if (outcome.status !== "captured") return outcome;

    evidence.capturedAt = outcome.capturedAt;
    evidence.executedSteps = (outcome.executedSteps || []).length;
    evidence.routeSteps = outcome.executedSteps || [];
    evidence.setup = setupEvidence(outcome.detail?.setup);
    evidence.title = scrubSensitiveText(evidence.title, terms);
    const bytes = fs.readFileSync(outcome.filePath);
    const check = verifyImage(bytes, {
      filename: shot.filename,
      evidence,
      expectedLabels: classified && shot.capture.landmarks?.length ? shot.capture.landmarks : shot.expectedLabels,
      expect: !(classified && shot.capture.expect) ? null : scratchLenient ? { family: "copilot-studio", scope: "agent", paths: [], label: "the practice agent", strict: false } : { ...shot.capture.expect, strict: mode === "auto" || mode === "autonomous" },
      requireEvidence: true,
      requireRedaction: redact,
    });
    if (check.reasons.some((r) => r.code === "blank" || r.code === "near-uniform") && attempt < attempts) {
      log("  The picture looks empty. The page may still have been loading. Waiting longer and trying once more.");
      await sleepFn(4000);
      continue;
    }
    if (!check.ok) return { status: "failed", error: failureText(check), cause: causeForVerification(check.reasons) || "rejected", check, detail: outcome.detail };
    return { status: "captured", bytes, check, evidence, callouts: outcome.callouts, detail: outcome.detail, executedSteps: outcome.executedSteps };
  }
  return { status: "failed", cause: "unknown", error: "The screenshot could not be captured." };
}

/**
 * Run every shot of a claimed job in a visible browser, with a saved profile per product and per browser.
 * `playwright` is the Playwright module (injectable for tests). The person is asked to sign in once per
 * product (see `createAuthGate`); when that does not work, the product's remaining shots stop at once.
 */
export async function runJob({ client, claimed, home, playwright, options = {}, log = console.log, shouldStop = () => false, sleepFn = sleep, heartbeatMs = HEARTBEAT_MS }) {
  const { job } = claimed;
  const shots = Array.isArray(claimed.shots) ? claimed.shots : [];
  const env = jobEnvironment(claimed.env);
  const targets = jobTargets(claimed.targets);
  const jobOptions = job.options || {};
  const jobMode = JOB_MODES.includes(options.mode) ? options.mode : JOB_MODES.includes(jobOptions.mode) ? jobOptions.mode : "smart";
  // What the computer may do on its own is what the job carries, limited by what this computer allows (see guard.mjs).
  const autonomy = resolveAutonomy(jobOptions.autonomy, { allowPracticeWrites: options.allowPracticeWrites === true, localOptIn: options.localOptIn === true });
  const registry = createPracticeRegistry(home);
  const recipes = createRecipeStore(home);
  const calloutMode = options.callouts || jobOptions.callouts || "sidecar";
  const redact = options.redact !== false && jobOptions.redact !== false;
  const terms = [...(options.maskTerms || []), ...(jobOptions.maskTerms || [])];
  const workDir = path.join(home, ".captures", job.id);
  const assetsDir = path.join(workDir, "assets");
  const screenshotsDir = path.join(workDir, "screenshots");
  const tally = { captured: 0, needsReview: 0, failed: 0, skipped: 0, manual: 0, needsYou: 0, paused: 0 };
  const state = { cancelled: false, paused: null, guidedUnavailable: false };
  const stopRequested = () => state.cancelled || shouldStop();
  const where = job.target?.type === "lab" ? `lab ${job.target.labId}` : "the shared library";
  log(`\nJob ${job.id}: ${shots.length} screenshot${shots.length === 1 ? "" : "s"} for ${where}${claimed.job.resumed ? " (resuming)" : ""}.`);
  if (shots.some((s) => s.capture?.version)) log(`  Mode: ${MODE_LABELS[jobMode]}.`);
  if (jobMode === "autonomous") {
    log(`  The computer may look at screens and try things that change nothing (open dialogs, ask the test pane a sample question). ${autonomy.level === "scratch" ? "It will also build one practice agent from scratch in your demo account and use it for the lab's screenshots. It never deletes anything." : autonomy.level === "practice" ? "It may also create and use one practice agent." : "It will not create or change anything."}`);
    if (autonomy.refusedPractice) log(`  ${autonomy.refusedPractice}`);
    if (!autonomy.consented) log("  This job did not carry your consent, so the computer will only look at screens, not open dialogs or ask questions.");
    if (autonomy.scratch) log("  Stop it any time with Stop in the portal or Ctrl+C: nothing is changed after that.");
  }

  const trace = options.trace || null;
  const launch = options.launch || "auto";
  const browserKinds = options.browserKinds?.length ? options.browserKinds : ["chromium"];
  // Which account the screenshots come from (see account-source.mjs and account-guard.mjs). Without it (older callers, tests
  // of other things) the original behavior is kept: no account check, original profile folders.
  const account = options.account || null;
  const accountNamespace = account ? profileNamespace({ mode: account.mode, osWorkAccount: account.os?.osWorkAccount ?? null }) : "";
  const accountCtxFor = (kind, inPrivate) => ({ mode: account.mode, explicitMode: account.explicitMode === true, os: account.os, kind, inPrivate });
  const accountInfo = account ? () => describeAccountState({ home, namespace: accountNamespace, mode: account.mode, osWorkAccount: account.os?.osWorkAccount ?? null, browser: browserKinds[0], inPrivate: launchPolicy({ kind: browserKinds[0], accountMode: account.mode, osWorkAccount: account.os?.osWorkAccount ?? null }).inPrivate }) : null;
  const accountStops = [];
  let accountReport = null;
  const signInWaitMs = (options.signInWaitSec || SIGN_IN_WAIT_MS / 1000) * 1000;
  const guidedWaitMs = (options.guidedWaitSec ?? DEFAULT_GUIDED_WAIT_SEC) * 1000;
  const readiness = { ...(options.readiness || {}) };
  // Someone is at the computer when the browser window is visible (a test can say so for a window nobody sees).
  const attended = options.attended ?? !options.headless;
  const notRun = [];
  const signInFailures = [];
  const diagnosisShown = new Set();
  const keepOpen = [];
  const capturedProducts = new Set();
  const scratchSessions = [];
  const processed = new Set();
  trace?.event("job-start", { shots: shots.length, browsers: browserKinds.join(","), headless: Boolean(options.headless), mode: jobMode, readyMs: readiness.maxMs ?? null, guidedWaitMs });

  const note = (message) => client.progress(job.id, { message }).then((r) => { if (r?.cancelRequested) state.cancelled = true; }).catch(() => {});
  // What the person is told while the capture browser is busy also reaches the portal's live progress.
  const waiting = (message) => void note(message);
  const report = async (shot, status, message, error = null, extra = {}) => {
    const reply = await client.progress(job.id, { shot: { filename: shot.filename, status, message, error, ...extra } });
    if (reply?.cancelRequested) state.cancelled = true;
  };
  // A portal from before account checks does not know the status "needs-account": it is then shown as a failed shot with the same sentence.
  const reportAccountStop = async (shot, message, extra = {}) => {
    try {
      await report(shot, "needs-account", message, null, { cause: "needs-account", ...extra });
    } catch (err) {
      if (!(err instanceof PortalError) || err.kind !== "client") throw err;
      await report(shot, "failed", null, message, { cause: "unknown", ...extra });
    }
  };

  const heartbeat = setInterval(() => {
    client
      .heartbeat({ jobId: job.id, busy: true, signedInProducts: listSignedInProfiles(home, { namespace: accountNamespace }), ...(accountInfo ? { account: accountInfo() } : {}) })
      .then((r) => { if (r?.cancelRequested) state.cancelled = true; })
      .catch(() => {});
  }, heartbeatMs);
  heartbeat.unref?.();

  // Each product gets its own browser profile. Inside one, shots that run by themselves go first and the ones that
  // need the person come last, so unattended work is never held up by a waiting screen.
  const groups = new Map();
  for (const shot of shots) {
    const profile = /^[a-z0-9-]+$/i.test(String(shot.authProfile || "")) ? String(shot.authProfile) : "default";
    if (!groups.has(profile)) groups.set(profile, []);
    groups.get(profile).push({ shot, effective: effectiveModeFor(shot, jobMode) });
  }
  for (const [profile, items] of groups) groups.set(profile, [...items.filter((i) => i.effective !== "guided"), ...items.filter((i) => i.effective === "guided")]);

  let fatalError = null;
  let index = 0;
  try {
    for (const [profile, items] of groups) {
      if (stopRequested() || state.paused) break;
      const label = productLabel(profile);
      const needsBrowserShot = ({ shot, effective }) => effective !== "manual" && effective !== "needs-you" && !(effective === "legacy" && shot.requiresEnv && !env[shot.requiresEnv]);
      const browserShots = items.filter(needsBrowserShot);
      let opened = null;
      // Hidden means no window is shown: either --headless, or --background with a sign-in that still works.
      let hidden = Boolean(options.headless);
      let backgroundHidden = false;
      try {
        if (browserShots.length) {
          log(`\nOpening the browser for ${label}.`);
          const wantsBackground = Boolean(options.background || jobOptions.background) && !options.headless;
          if (wantsBackground && listSignedInProfiles(home, { namespace: accountNamespace }).includes(profile)) {
            log("  Running in the background: your saved sign-in is used and no window is shown.");
            opened = await openProfile({ playwright, home, profile, kinds: browserKinds, headless: true, log, trace, launch, account, profileWait: options.profileWait, onWaiting: waiting });
            hidden = true;
            backgroundHidden = true;
            const probe = await probeBackground({ opened, profile, shot: browserShots[0].shot, env, sleepFn, trace });
            trace?.event("background-probe", { product: profile, ok: probe.ok, why: probe.why || "" });
            if (!probe.ok) {
              await opened.context.close().catch(() => {});
              log(`  ${label} asked for a sign-in again in the background (${probe.why}), so a window is opening for you instead.`);
              opened = await openProfile({ playwright, home, profile, kinds: browserKinds, headless: false, log, trace, launch, account, profileWait: options.profileWait, onWaiting: waiting });
              hidden = false;
              backgroundHidden = false;
            }
          } else {
            if (wantsBackground) log(`  There is no saved sign-in for ${label} yet, so a window opens for you to sign in. Next time this can run in the background.`);
            opened = await openProfile({ playwright, home, profile, kinds: browserKinds, headless: Boolean(options.headless), log, trace, launch, account, profileWait: options.profileWait, onWaiting: waiting });
          }
        }
      } catch (err) {
        if (err?.code === "PROFILE_BUSY") {
          // The capture browser is held by a window that is not ours to close. Nothing failed and nothing was started or used up:
          // the screenshots wait, and Resume in the portal queues them again.
          log(`  ${err.message}`);
          trace?.event("browser-busy-pause", { state: err.state || "other", shots: items.length });
          for (const item of items) {
            if (!needsBrowserShot(item)) continue;
            processed.add(item.shot.filename);
            notRun.push({ filename: item.shot.filename, why: "The capture browser was still in use." });
          }
          state.paused = { reason: "browser-busy", message: err.short || err.message };
          break;
        }
        const text = String(err?.message || err);
        trace?.event("browser-start-failed", { product: profile, why: err?.code || "error", detail: text.split("\n")[0].replace(/[A-Za-z]:\\Users\\[^\\\s]+/gi, "%USERPROFILE%").slice(0, 240) });
        const message = err?.code === "BROWSER_MISSING" || err?.code === "UNSAFE_PROFILE" ? text : plainStartFailure(err);
        log(`  ${message}`);
        for (const item of items) {
          index += 1;
          processed.add(item.shot.filename);
          if (!needsBrowserShot(item)) continue;
          tally.failed += 1;
          notRun.push({ filename: item.shot.filename, why: message });
          await report(item.shot, "failed", null, message, { cause: "unknown" }).catch(() => {});
        }
        continue;
      }
      const { context, kind, dir } = opened || {};
      const watcher = context ? watchContext(context) : null;

      // One gate per product per job: the person is asked to sign in once, and a failed sign-in stops the rest of this product.
      const diagnose = options.signInDiagnoser || createSignInDiagnoser({ synced: options.resolvedHome?.synced || null, launch: opened?.launch || null, profileDir: dir || null, savedSession: Boolean(dir && fs.existsSync(path.join(dir, SESSION_FILE))), ...(options.signInFacts || {}) });
      const gate = createAuthGate({
        product: profile,
        waitMs: signInWaitMs,
        allowWait: !hidden || Boolean(options.waitForSignIn),
        pollMs: options.authPollMs ?? 250,
        settleMs: options.authSettleMs ?? 1000,
        graceMs: options.authGraceMs ?? 2500,
        confirmMs: options.authConfirmMs ?? 6000,
        firstLoadMs: options.authFirstLoadMs ?? 10_000,
        sleep: sleepFn,
        notify: ({ message }) => {
          log(`\n${message}`);
          void note(message);
        },
        trace,
        diagnose,
      });
      let profileCaptured = false;
      let signInMessage = null;
      let browserShotsStarted = 0;
      const session = createCaptureSession({ env, targets, autonomy, registry, recipes, home, terms, companionVersion: COMPANION_VERSION, writeGapMs: options.writeGapMs, effectMs: options.effectMs, findMs: options.findMs });
      scratchSessions.push(session);
      session.shouldStop = stopRequested;
      // "Show me once": the portal asked for a retake in which the computer learns what the person does.
      session.record = jobOptions.record && typeof jobOptions.record === "object" ? { share: jobOptions.record.share === true } : null;
      session.shareRecipe = session.record?.share && typeof client.shareRecipe === "function" ? (recipe) => client.shareRecipe(recipe) : null;

      try {
        let page = context ? context.pages()[0] || (await context.newPage()) : null;
        watcher?.watchPage(page);
        await page?.bringToFront?.().catch(() => {});
        trace?.event("window-raise", { reason: "job-start", times: 1 });

        // Which account is this? Checked once per product, before its first screenshot: a capture must never silently come
        // from the Windows work account, or from an account that cannot see the person's own agent or site.
        let accountStop = null;
        if (account && context && page && browserShots.length && options.accountCheck !== false) {
          const first = browserShots[0].shot;
          const startUrl = (first.urlEnv && env[first.urlEnv]) || first.startUrl || first.capture?.route?.url || "https://copilotstudio.microsoft.com/";
          let check = null;
          const automatic = browserShots.some(({ effective }) => effective === "autonomous");
          if (automatic && dir && readAccountRecord(dir)?.confirmed !== true) log("  You sign in once in this window (only if it asks), then confirm here that it is the right account, and the capture carries on. You do not sign in twice.");
          try {
            check = await verifyProductAccount({ page, gate, product: profile, values: session.values, startUrl, ctx: accountCtxFor(kind, opened.inPrivate === true), dir, autonomous: automatic, confirmAccount: options.confirmAccount || null, trace, log, sleep: sleepFn });
          } catch (err) {
            if (!(err instanceof BrowserClosedError) && classifyBrowserError(err) !== "browser-closed" && !watcher?.closed()) {
              trace?.event("account-check-error", { why: briefError(err) });
            } else state.paused = { reason: "browser-closed" };
          }
          if (check?.signIn) {
            signInMessage = gate.describeFailure(browserShots.length);
            signInFailures.push({ product: profile, label, code: gate.failed?.code || "sign-in", diagnosis: gate.failed?.diagnosis || null });
            log(`  ${signInMessage}`);
            if (gate.failed?.diagnosis && !diagnosisShown.has(profile)) {
              diagnosisShown.add(profile);
              log("");
              for (const line of diagnosisLines(gate.failed.diagnosis)) log(`  ${line}`);
              log(`  To see exactly what the browser did, run: node companion.mjs --check-signin=${profile}`);
            }
          } else if (check) {
            accountReport = check.account;
            if (check.decision.action === "stop") {
              accountStop = { code: check.decision.code, message: check.decision.message };
              accountStops.push({ product: profile, ...accountStop });
              log(`\n  ${check.decision.message}`);
              void note(check.decision.message);
            } else log(`  Account: ${describeAccount(check.account)}`);
          }
        }
        for (const { shot, effective } of items) {
          if (state.paused) break;
          index += 1;
          if (stopRequested()) {
            log("Stopping: the job was canceled or the companion is closing.");
            break;
          }
          processed.add(shot.filename);
          const modeTag = effective === "guided" ? "  [you set it up]" : effective === "auto" || effective === "autonomous" ? "  [automatic]" : "";
          log(`\n[${index}/${shots.length}] ${shot.filename}${shot.moduleTitle ? `  (${shot.moduleTitle})` : ""}${modeTag}`);
          const common = { mode: ["guided", "auto", "autonomous"].includes(effective) ? effective : shot.capture?.mode || null, path: shot.capture?.path || undefined };

          if (effective === "manual") {
            tally.manual += 1;
            const message = "This screen is outside the browser. Capture it with an OS screenshot tool and upload it in the portal.";
            log(`  ${message}`);
            notRun.push({ filename: shot.filename, why: message });
            await report(shot, "manual-required", "Capture this one with an OS screenshot tool and upload it in the portal.", null, { cause: "manual", ...common });
            continue;
          }
          if (effective === "needs-you") {
            tally.needsYou += 1;
            const message = "This screen needs you to set it up (a test conversation, a dialog, a result). Automatic mode skips it. Use “Retake guided”, or choose Smart.";
            log(`  Not run: ${message}`);
            notRun.push({ filename: shot.filename, why: "It needs you to set it up." });
            await report(shot, "needs-you", message, null, { cause: "needs-you", ...common });
            continue;
          }
          if (effective === "guided" && (!attended || backgroundHidden || state.guidedUnavailable)) {
            tally.needsYou += 1;
            const message = !attended || backgroundHidden ? "This screen needs you to set it up, and this companion has no visible window (--headless or --background). Use “Retake guided” with a normal window." : "Nobody was here to set this screen up earlier in this job, so it is waiting for you. Use “Retake guided” when you are at the computer.";
            log(`  Not run: ${message}`);
            notRun.push({ filename: shot.filename, why: "It needs you at the computer." });
            await report(shot, "needs-you", message, null, { cause: "needs-you", ...common });
            continue;
          }
          if (effective === "legacy" && shot.requiresEnv && !env[shot.requiresEnv]) {
            tally.skipped += 1;
            const message = `This shot needs your tenant address in ${shot.requiresEnv}. Add it to the portal's brand profile, or set it on this computer before starting the companion.`;
            log(`  Skipped. ${message}`);
            notRun.push({ filename: shot.filename, why: `It needs your tenant address in ${shot.requiresEnv}.` });
            await report(shot, "skipped", message, null, { cause: "no-address" });
            continue;
          }

          browserShotsStarted += 1;
          if (accountStop && (accountStop.code !== "unverified" || effective === "autonomous")) {
            // The account is not the right one (or not confirmed for automatic capture): do not open the page, report the shot once.
            tally.failed += 1;
            log("  Not run: the account is not the right one (see above).");
            notRun.push({ filename: shot.filename, why: accountStop.message });
            await reportAccountStop(shot, accountStop.message, common);
            continue;
          }
          if (gate.failed) {
            // Sign-in did not work earlier in this job. Do not open the page or ask again: report the shot once and move on.
            tally.failed += 1;
            log("  Not run: sign-in did not finish (see above).");
            notRun.push({ filename: shot.filename, why: signInMessage });
            await report(shot, "auth-required", null, signInMessage, { cause: "sign-in", ...common });
            continue;
          }

          // Tabs the browser opened on its own since the last screen (a what's-new page, a stray new-tab page) are closed so they cannot take the window.
          if (context && effective !== "guided" && opened?.launch === "attach") await closeStrayTabs(context, page, { trace });
          await report(shot, "running", effective === "guided" ? "Waiting for you in the browser window." : "Capturing.", null, common);
          // What the computer is doing right now, for the portal's live progress (at most one message every two seconds).
          let lastProgressAt = 0;
          session.onProgress = (text) => {
            const at = Date.now();
            if (at - lastProgressAt < 2000) return;
            lastProgressAt = at;
            void report(shot, "running", text, null, common).catch(() => {});
          };
          let result;
          const attemptShot = async () => {
            page = await ensureLivePage(context, page, { watcher, trace });
            return captureShot({
              page,
              shot,
              assetsDir,
              screenshotsDir,
              env,
              redact,
              terms,
              calloutMode,
              log,
              signInWaitMs,
              sleepFn,
              headless: hidden,
              auth: gate,
              trace,
              session,
              effectiveMode: ["guided", "auto", "autonomous"].includes(effective) ? effective : null,
              readiness,
              guided: { timeoutMs: guidedWaitMs, shouldStop: stopRequested, sleep: sleepFn, onWaiting: options.onGuidedWaiting },
            });
          };
          try {
            try {
              result = await attemptShot();
            } catch (err) {
              // A tab that crashed is replaced by a new one in the same browser, and the shot is tried once more.
              if (classifyBrowserError(err) !== "page-crashed" || watcher?.closed()) throw err;
              log("  The browser tab crashed. Opening a new tab and trying this screenshot again.");
              trace?.event("page-crash-retry", { shot: shot.filename });
              page = await ensureLivePage(context, { isClosed: () => true }, { watcher, trace });
              result = await attemptShot();
            }
          } catch (err) {
            if (classifyBrowserError(err) === "browser-closed" || watcher?.closed()) {
              state.paused = { reason: "browser-closed" };
              trace?.event("browser-closed", { shot: shot.filename });
              break;
            }
            result = { status: "failed", cause: classifyBrowserError(err) === "transient" ? "navigation-failed" : "unknown", error: briefError(err) };
          }
          trace?.event("shot-result", { shot: shot.filename, status: result.status, code: result.code, cause: result.cause || null });
          const extra = { cause: result.cause || undefined, ...common, ...(result.detail?.path ? { path: result.detail.path } : {}), steps: summarizeSteps(result.executedSteps), setup: setupEvidence(result.detail?.setup) || undefined, outcome: result.status === "captured" ? plainOutcome(result.detail, result.executedSteps, effective) : undefined };

          // A page that looks like a sign-in page but was not recognized by its address (a company sign-in service) counts as not signed in.
          if (result.status === "failed" && result.check?.reasons?.some((r) => r.code === "sign-in-page") && !gate.failed) {
            gate.markFailed("sign-in-page", `${label} showed a sign-in page instead of the product.`);
            result = { status: "auth-required", code: "sign-in-page", error: gate.failed.message };
          }
          if (result.status === "auth-required") {
            if (!gate.failed) gate.markFailed(result.code || "sign-in", result.error || `${label} needs a sign-in.`);
            const remaining = browserShots.length - (browserShotsStarted - 1);
            signInMessage = gate.describeFailure(remaining);
            signInFailures.push({ product: profile, label, code: gate.failed.code, diagnosis: gate.failed.diagnosis || null });
            tally.failed += 1;
            log(`  ${signInMessage}`);
            if (gate.failed.diagnosis && !diagnosisShown.has(profile)) {
              diagnosisShown.add(profile);
              log("");
              for (const line of diagnosisLines(gate.failed.diagnosis)) log(`  ${line}`);
              log("  To see exactly what the browser did, run: node companion.mjs --check-signin=" + profile);
              trace?.event("sign-in-diagnosis", { product: profile, code: gate.failed.code, aadsts: gate.failed.diagnosis.aadsts || null, likely: gate.failed.diagnosis.checks.filter((c) => c.level === "likely").map((c) => c.id).join(",") });
            }
            notRun.push({ filename: shot.filename, why: signInMessage });
            await report(shot, "auth-required", null, signInMessage, { ...extra, cause: "sign-in" });
            continue;
          }
          if (result.status === "skipped") {
            tally.skipped += 1;
            log(`  Skipped. ${result.error}`);
            notRun.push({ filename: shot.filename, why: result.error });
            await report(shot, "skipped", result.error, null, extra);
            continue;
          }
          if (result.status === "needs-you") {
            tally.needsYou += 1;
            log(`  ${result.error}`);
            const failedFile = result.detail?.setup?.failedStep?.diagnostic;
            if (failedFile) log(`  ${diagnosticAdvice(failedFile)}`);
            const cause = result.cause && result.cause !== "needs-you" && result.cause !== "automation-failed" ? describeCause(result.cause) : null;
            notRun.push({ filename: shot.filename, why: cause && effective === "autonomous" ? `${cause.title}.` : effective === "autonomous" ? "The computer could not set it up." : "It needs you at the computer." });
            if (result.timedOut && !state.guidedUnavailable) {
              state.guidedUnavailable = true;
              log("  Nobody answered, so I will not wait for the other screens that need you. They are marked “needs you”.");
            }
            await report(shot, "needs-you", result.error, null, extra);
            continue;
          }
          if (result.status === "paused") {
            state.paused = { reason: result.cause === "stopped" ? "stopped" : "browser-closed" };
            break;
          }
          if (result.status === "cancelled") {
            state.cancelled = true;
            break;
          }
          if (result.status !== "captured") {
            tally.failed += 1;
            log(`  Could not capture: ${result.error}`);
            notRun.push({ filename: shot.filename, why: result.error });
            await report(shot, "failed", null, result.error, extra);
            continue;
          }

          // A picture was taken in the product, so this sign-in works: keep it, including session cookies that a closed browser drops.
          profileCaptured = true;
          capturedProducts.add(profile);
          if (context) await saveSession({ context, dir, product: profile, browser: kind, captured: true });

          const callouts = calloutMode === "none" ? null : (result.callouts || []).map(({ n, label: calloutLabel, rect }) => ({ n, label: calloutLabel, rect: rect ?? null }));
          const uploaded = await uploadWithRetry(client, job.id, shot, { bytes: result.bytes, evidence: result.evidence, callouts, mime: mimeFor(shot.filename) }, { log, sleepFn });
          if (uploaded.body?.cancelRequested) state.cancelled = true;
          const outcome = uploaded.body?.outcome;
          if (outcome === "accepted") {
            tally.captured += 1;
            log(`  Captured, verified, and saved to the portal. ${extra.outcome || ""}`.trimEnd());
          } else if (outcome === "needs-review") {
            tally.needsReview += 1;
            const why = (uploaded.body?.verification?.reasons || []).map((r) => r.message).join(" ");
            log(`  Saved for review in the portal. ${why}`);
          } else {
            tally.failed += 1;
            log(`  The portal rejected the image: ${uploaded.body?.message || uploaded.body?.error || "it failed verification."}`);
          }
        }
        if (profileCaptured) {
          if (context) await saveSession({ context, dir, product: profile, browser: kind, captured: true }).catch(() => {});
          log(`\nThe sign-in for ${label} is saved on this computer, so you will not need to sign in again. The saved files in the .auth folder give access to your account: keep them private.`);
        }
      } finally {
        // A sign-in that looped keeps its window open, so the person can look at it; the job is finished first and the window closes after.
        if (context && gate.failed?.keepOpen && !hidden && attended) keepOpen.push({ context, watcher, label });
        else await context?.close?.().catch(() => {});
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

  for (const shot of shots) {
    if (!processed.has(shot.filename)) notRun.push({ filename: shot.filename, why: state.paused ? "The capture was paused before this screenshot started." : "The job was canceled before this screenshot started." });
  }
  // Everything that has not been reported by now is waiting: count it once, so one message covers all of it.
  const reported = tally.captured + tally.needsReview + tally.failed + tally.skipped + tally.manual + tally.needsYou;
  if (state.paused) tally.paused = Math.max(0, shots.length - reported);
  let pausedNote = null;
  if (state.paused) {
    const count = `${tally.paused} screenshot${tally.paused === 1 ? "" : "s"}`;
    pausedNote =
      state.paused.reason === "stopped"
        ? `You stopped the capture. ${tally.paused} screenshot${tally.paused === 1 ? " is" : "s are"} paused. In the portal, select Resume to continue.`
        : state.paused.reason === "browser-busy"
          ? `${state.paused.message} ${count} ${tally.paused === 1 ? "is" : "are"} waiting, not failed.`
          : `You closed the browser window, so the capture is paused. ${tally.paused} screenshot${tally.paused === 1 ? " was" : "s were"} not captured yet. In the portal, select Resume to continue where it stopped.`;
    log(`\n${pausedNote}`);
  }
  const summary = `${tally.captured} captured, ${tally.needsReview} saved for review, ${tally.failed} failed, ${tally.skipped + tally.manual} not run${tally.needsYou ? `, ${tally.needsYou} need you` : ""}${tally.paused ? `, ${tally.paused} ${state.paused?.reason === "browser-busy" ? "waiting for the browser" : "paused"}` : ""}.`;
  // What the computer created (a practice agent, changes inside it): written to a report on this computer and named, never linked, to the portal.
  const created = summarizeCreated(registry.jobLog);
  let reportFile = null;
  if (created.length) {
    try {
      reportFile = writePracticeReport(home, registry, { jobCreated: created });
      log(`\nThe computer created ${created.length} item${created.length === 1 ? "" : "s"} in your practice environment. It never deletes anything: delete them yourself when you are done.`);
      for (const item of created) log(`  - ${item.what}`);
      log(`The report is saved at ${reportFile}`);
    } catch {
      log("\nThe computer created items in your practice environment, but the report could not be saved.");
    }
  }
  // What was built from scratch, as the portal may know it: a name, a date, and which steps are done. Never an address or an id.
  const scratchSession = scratchSessions.find((s) => s.scratch?.agent) || null;
  const stoppedSession = scratchSessions.find((s) => s.scratch?.halted) || null;
  const scratchReport = autonomy.scratch
    ? {
        ...(scratchSession ? { name: scratchSession.scratch.agent.name, reused: scratchSession.scratch.agent.reused === true, createdAt: String(scratchSession.scratch.agent.createdAt || new Date().toISOString()).slice(0, 10), stages: [...scratchSession.scratch.done].slice(0, 12) } : {}),
        environment: autonomy.practiceEnvironmentUrl ? "set" : "default",
        ...(stoppedSession ? { stopped: String(stoppedSession.scratch.halted.message || "").slice(0, 200) } : {}),
      }
    : null;
  const signInDiagnosis = signInFailures.find((f) => f.diagnosis)?.diagnosis || null;
  const signInInfo = signInDiagnosis ? signInReport(signInDiagnosis, { product: signInFailures.find((f) => f.diagnosis).product }) : null;
  const finalAccount = accountReport || (accountInfo ? accountInfo() : null);
  const needsAccount = accountStops[0] ? { product: accountStops[0].product, code: accountStops[0].code, message: accountStops[0].message } : null;
  try {
    await client.complete(job.id, { message: pausedNote || (needsAccount ? `${needsAccount.message} ${summary}` : summary), ...(fatalError ? { fatalError } : {}), ...(created.length ? { created } : {}), ...(scratchReport ? { scratch: scratchReport } : {}), ...(signInInfo ? { signIn: signInInfo } : {}), ...(finalAccount ? { account: finalAccount } : {}), ...(needsAccount ? { needsAccount } : {}), ...(state.paused ? { paused: { reason: state.paused.reason, message: pausedNote } } : {}) });
  } catch (err) {
    if (err instanceof PortalError && err.kind === "auth") throw err;
    log(`Could not tell the portal the job finished: ${err.message}`);
  }
  log(state.cancelled ? `\nCanceled from the portal. ${summary}` : `\nJob finished: ${summary}`);
  const reasons = new Map();
  for (const { why } of notRun) reasons.set(why, (reasons.get(why) || 0) + 1);
  if (reasons.size) {
    log("Why some screenshots did not run:");
    for (const [why, count] of reasons) log(`  - ${count} screenshot${count === 1 ? "" : "s"}: ${why}`);
  }
  trace?.event("job-end", { captured: tally.captured, failed: tally.failed, notRun: notRun.length, paused: tally.paused, needsYou: tally.needsYou });
  if (keepOpen.length) {
    log(`\nThe browser window stays open so you can look at it (${keepOpen.map((k) => k.label).join(", ")}). Close it when you are done; it closes by itself after a few minutes.`);
    for (let waited = 0; waited < (options.keepOpenMs ?? 5 * 60_000) && keepOpen.some((k) => !k.watcher?.closed()); waited += 1000) await sleepFn(1000);
    for (const k of keepOpen) await k.context.close?.().catch(() => {});
  }
  return { cancelled: state.cancelled, paused: state.paused, tally, fatalError, notRun, signInFailures, capturedProducts: [...capturedProducts] };
}

// ── Diagnose ───────────────────────────────────────────────────────────────

/**
 * `--diagnose`: open the product with the saved sign-in, let the person go to the page that gives trouble, and write the
 * redacted diagnostic file for it (control roles and names, the page's host and path, nothing else).
 */
export async function runDiagnose({ home, product, playwright, kinds, log = console.log, ask: prompt = ask, terms = [], launch = "auto", account = null }) {
  let opened;
  try {
    opened = await openProfile({ playwright, home, profile: product, kinds, headless: false, log, launch, account });
  } catch (err) {
    log(String(err?.message || err).split("\n")[0]);
    return EXIT.usage;
  }
  try {
    const page = opened.context.pages()[0] || (await opened.context.newPage());
    let start = "https://copilotstudio.microsoft.com/";
    try {
      const { readCaptureConfig } = await import("../feature-tour/lib/products.mjs");
      start = readCaptureConfig().products?.[product]?.startUrl || start;
    } catch {
      // The default start page is fine.
    }
    await gotoWithRetry(page, start, { waitUntil: "domcontentloaded", reason: "diagnose-start" }).catch(() => {});
    await prompt("Open the page that gives trouble in the browser window, then press Enter here. ");
    const live = opened.context.pages().at(-1) || page;
    const { file, bundle } = await writeDiagnostic({ page: live, home, product, shot: `diagnose-${product}`, terms, companion: COMPANION_VERSION, cause: "manual" });
    log(`Found ${bundle.controls.length} visible control${bundle.controls.length === 1 ? "" : "s"} and ${bundle.dialogs.length} open dialog${bundle.dialogs.length === 1 ? "" : "s"}.`);
    log(diagnosticAdvice(file));
    return file ? EXIT.ok : EXIT.usage;
  } finally {
    await opened.context.close().catch(() => {});
  }
}

// ── Modes, plain-language outcomes ─────────────────────────────────────────

export const JOB_MODES = Object.freeze(["autonomous", "auto", "guided", "smart"]);
const MODE_LABELS = { autonomous: "automatic (the computer sets up and captures every screen itself)", auto: "let the computer do it", guided: "you set up each screen", smart: "smart (the computer does what it can, you set up the rest)" };
export const DEFAULT_GUIDED_WAIT_SEC = 120;

/**
 * How one shot is run in a job of this mode: "auto", "guided", "needs-you" (automatic mode meets a screen that
 * needs a person), "manual", or "legacy" (a plan from a portal that does not classify its shots).
 */
export { effectiveModeFor };

/** Settings that are names rather than addresses travel with the job; keep only the known ones. */
export function jobTargets(raw) {
  const out = {};
  for (const [id, value] of Object.entries(raw && typeof raw === "object" ? raw : {})) {
    const field = targetField(id);
    if (!field || field.kind !== "text") continue;
    const checked = validateTargetValue(id, value);
    if (checked.ok && checked.value) out[id] = checked.value;
  }
  return out;
}

/** The capture settings an account-setup request carries: the same checked addresses and names a job carries. */
export function commandValues(command) {
  return targetValuesFromJob(jobEnvironment(command?.env, {}), jobTargets(command?.targets));
}

/**
 * What the person is told, at the start, about which account the screenshots come from. Honest about what each choice
 * does: no choice here hides which account is used.
 */
export function accountStartLines({ mode = "separate", explicitMode = false, os = null, kind = "chromium", requestedBrowser = "auto", edgeForced = false } = {}) {
  const name = browserShortName(kind);
  const lines = [];
  if (os?.osWorkAccount === true) {
    if (mode === "windows") {
      lines.push(`Account: your Windows work account is allowed (--account-mode=windows). ${kind === "edge" ? "Microsoft Edge may sign in with it automatically, and screenshots will then come from that account, not from a separate demo tenant." : `${name} does not use it automatically, so you sign in once yourself.`}`);
    } else if (kind === "edge") {
      lines.push(`Account: a separate sign-in in Microsoft Edge, opened InPrivate. This PC has a Windows work account${edgeForced ? " and your organization makes Edge sign in with it" : ""}; an InPrivate window does not use it. You sign in once, yourself, with the account you want the screenshots to come from (for example your demo tenant), and this computer remembers it.`);
      if (requestedBrowser !== "edge") lines.push("  Chrome and Chromium were not found. Chromium is the most reliable browser for captures: run npx playwright install chromium (or run this with --install-browser).");
    } else {
      lines.push(`Account: a separate sign-in. This PC has a Windows work account, and ${name} does not use it. You sign in once, yourself, with the account you want the screenshots to come from (for example your demo tenant); this computer remembers it.`);
    }
    lines.push(mode === "windows" ? "  To choose or change the account, run with --setup-account. To go back to a separate sign-in, run without --account-mode (or with --account-mode=separate)." : "  To choose or change the account, run with --setup-account. To allow the Windows work account on purpose, run with --account-mode=windows.");
  } else if (explicitMode && mode === "windows") {
    lines.push("Account: --account-mode=windows was given, but this PC has no Windows work account that a browser could use, so nothing changes: you sign in yourself.");
  } else {
    lines.push("Account: you sign in once, yourself, in the browser window, with the account you want the screenshots to come from. To choose or change it later, run with --setup-account.");
  }
  return lines;
}

/** "Opened Copilot Studio, then your agent, then Settings, then selected Generative AI." */
export function plainOutcome(detail, steps, mode) {
  const path = Array.isArray(detail?.path) ? detail.path.filter(Boolean) : [];
  const selected = (Array.isArray(steps) ? steps : []).filter((s) => s?.action === "reveal" && s.ok && s.tried > 0).map((s) => s.label);
  const opened = path.length ? `Opened ${path.join(", then ")}` : "Opened the page";
  const picked = selected.length ? `, then selected ${selected.join(" and ")}` : "";
  const did = Array.isArray(detail?.setup?.summary) && detail.setup.summary.length ? `, then ${detail.setup.summary.map((s) => String(s).replace(/^(\w)/, (c) => c.toLowerCase())).join(", then ")}` : "";
  const limited = detail?.setup?.limitedBy === "practice-agent" ? " It needs a practice agent to show the final state." : "";
  return `${opened}${picked}${did}.${mode === "guided" ? " You set up the screen." : ""}${limited}`;
}

/** The setup that ran for a shot, bounded for the portal: step names and outcomes, never page text or addresses. */
export function setupEvidence(setup) {
  if (!setup || typeof setup !== "object") return null;
  const word = (value, max) => String(value ?? "").replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, max);
  return {
    source: word(setup.source, 40),
    steps: (Array.isArray(setup.steps) ? setup.steps : []).slice(0, 16).map((s) => ({ id: word(s.id, 24), action: word(s.action, 24), status: ["ok", "skipped", "failed"].includes(s.status) ? s.status : "failed", strategy: word(s.strategy, 24), tier: Number.isInteger(s.tier) ? s.tier : 0, note: word(s.note || s.summary, 120) })),
    summary: (Array.isArray(setup.summary) ? setup.summary : []).slice(0, 10).map((s) => word(s, 120)).filter(Boolean),
    limitedBy: setup.limitedBy === "practice-agent" ? "practice-agent" : null,
    skipped: (Array.isArray(setup.skipped) ? setup.skipped : []).slice(0, 6).map((s) => word(s, 120)),
    practice: setup.practice ? { name: word(setup.practice.name, 80), reused: setup.practice.reused === true } : null,
    ...(setup.failedStep ? { failedStep: { id: word(setup.failedStep.id, 24), action: word(setup.failedStep.action, 24), note: word(setup.failedStep.note, 120) } } : {}),
  };
}

/** The steps taken, reduced to what the portal shows: no page text, only the labels the lab gave and masked addresses. */
export function summarizeSteps(steps) {
  return (Array.isArray(steps) ? steps : []).slice(0, 14).map((s) => ({
    action: String(s.action || "").slice(0, 24),
    label: s.label ? String(s.label).slice(0, 80) : undefined,
    found: s.found === true,
    ok: s.ok === true,
    urlBefore: s.urlBefore ? String(s.urlBefore).slice(0, 200) : undefined,
    urlAfter: s.urlAfter ? String(s.urlAfter).slice(0, 200) : undefined,
    note: s.note ? String(s.note).slice(0, 80) : undefined,
  }));
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

export async function preflight({ home, log = console.log, nodeVersion = process.versions.node, detect = detectBrowserAvailability, browser = "auto", accountMode = "windows", osWorkAccount = null } = {}) {
  const problems = [];
  const major = Number.parseInt(String(nodeVersion).split(".")[0], 10);
  if (!Number.isFinite(major) || major < MIN_NODE_MAJOR) {
    problems.push(`Node.js ${MIN_NODE_MAJOR} or later is required (this is ${nodeVersion}). Install it from https://nodejs.org and run this again.`);
  }
  const found = await detect({ repoRoot: path.resolve(HERE, "..", "..") });
  const choice = chooseBrowsers({ requested: browser, installed: { edge: found.edgeInstalled, chrome: found.chromeInstalled, chromium: found.chromiumInstalled }, accountMode, osWorkAccount });
  if (!found.playwrightInstalled) {
    problems.push(`The Playwright package is not installed. In this folder (${home}) run:\n    npm install\n    npx playwright install chromium`);
  } else if (!choice.ok) {
    problems.push(choice.message);
  }
  if (problems.length) {
    log("This computer is not ready yet:");
    for (const p of problems) log(`  - ${p}`);
  }
  return { ok: problems.length === 0, problems, found, kinds: choice.kinds };
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
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const sleepFn = deps.sleepFn || sleep;
  const interactive = Boolean(process.stdin.isTTY) && !deps.nonInteractive;

  log(`Local Capture Companion ${COMPANION_VERSION}`);

  if (opts.dryRunPlan) {
    const plan = dryRunPlan(opts.dryRunPlan);
    for (const line of plan.lines) log(line);
    return plan.ok ? EXIT.ok : EXIT.usage;
  }
  if (opts.deleteOldSignin) {
    const removed = deleteOldSignIn({ legacyDir: deps.codeDir || HERE });
    log(removed ? `Deleted the old sign-in folder beside the companion's code (${path.join(deps.codeDir || HERE, ".auth")}). Sign in once more the next time a capture needs it.` : "There is no old sign-in folder beside the companion's code.");
    return EXIT.ok;
  }

  // Where data lives: a local folder of this user, never a synced one (see home.mjs).
  const codeDir = deps.codeDir || HERE;
  const homeEnv = deps.homeEnv || {};
  const resolved = (deps.resolveHome || resolveHome)({ explicit: opts.home, envHome: (homeEnv.env || process.env).COMPANION_HOME, codeDir, allowSynced: opts.allowSyncedHome === true, ...homeEnv });
  const home = resolved.home;
  const onlyRemoves = Boolean(opts.unpair || opts.forgetSignin);
  if (opts.status || opts.checkSignin) for (const line of describeHomeState(resolved)) log(line);
  else if (resolved.synced.synced && resolved.allowSynced) log(describeHomeState(resolved)[1] || "");
  if (resolved.refused && !onlyRemoves && !opts.status) {
    log(syncedHomeMessage(resolved));
    return EXIT.usage;
  }
  if (resolved.legacy && !resolved.refused && !onlyRemoves) {
    const moved = migrateLegacyHome({ legacy: resolved.legacy, home, log });
    for (const line of oldSignInAdvice({ oldProfiles: moved.oldProfiles, synced: resolved.legacy.synced })) log(line);
    if (moved.oldProfiles && resolved.legacy.synced?.synced && interactive) {
      const answer = await (deps.ask || ask)("Delete the old sign-in folder now? (y/N) ").catch(() => "");
      if (/^y/i.test(String(answer))) log(deleteOldSignIn({ legacyDir: resolved.legacy.dir }) ? "Deleted the old sign-in folder." : "The old sign-in folder could not be deleted. Delete it yourself.");
    }
  }
  if (opts.allowPracticeWrites !== undefined) {
    saveSettings(home, { allowPracticeWrites: opts.allowPracticeWrites, ...(opts.allowPracticeWrites === false ? { practiceOptIn: {} } : {}) });
    log(opts.allowPracticeWrites ? "This computer now lets jobs that you allowed in the portal create and use one practice agent. Use --no-practice-writes to turn that off." : "This computer will never create anything, whatever a job says.");
  }
  const settings = loadSettings(home);
  if (opts.unpair) {
    clearConfig(home);
    log("This computer is no longer paired. To remove it from the portal list too, select Disconnect there.");
    return EXIT.ok;
  }
  if (opts.installBrowser) return (await (deps.installBrowser || installBrowser)(log)) ? EXIT.ok : EXIT.usage;
  if (opts.forgetSignin) {
    const removed = forgetSignIn(home, opts.forgetSignin === "all" ? "all" : [opts.forgetSignin]);
    log(removed.length ? `Removed the saved sign-in (${removed.join(", ")}). You will be asked to sign in again the next time a capture needs it.` : `There is no saved sign-in for ${opts.forgetSignin} on this computer.`);
    return EXIT.ok;
  }

  // Which account the screenshots come from: this PC's Windows work account (if any), and what the person asked for.
  const osAccount = deps.osAccount || resolveOsAccount({ home, log });
  const account = { mode: opts.accountMode || "separate", explicitMode: opts.accountMode !== null, os: osAccount };
  const ready = await (deps.preflight || preflight)({ home, log, browser: opts.browser, accountMode: account.mode, osWorkAccount: osAccount.osWorkAccount });
  if (!ready.ok) return EXIT.usage;
  const browserKinds = ready.kinds?.length ? ready.kinds : ["chromium"];
  const browserLine = `Browser: ${browserLabel(browserKinds[0])}${browserKinds.length > 1 ? `, or ${browserKinds.slice(1).map(browserLabel).join(" or ")} if that will not start` : ""}.`;
  const accountNamespace = profileNamespace({ mode: account.mode, osWorkAccount: osAccount.osWorkAccount });
  const accountLines = accountStartLines({ mode: account.mode, explicitMode: account.explicitMode, os: osAccount, kind: browserKinds[0], requestedBrowser: opts.browser, edgeForced: osAccount.osWorkAccount === true && browserKinds.includes("edge") ? (deps.edgePolicy || readEdgeSignInPolicy)()?.forced === true : false });
  const accountHeartbeat = () => describeAccountState({ home, namespace: accountNamespace, mode: account.mode, osWorkAccount: osAccount.osWorkAccount, browser: browserKinds[0], inPrivate: launchPolicy({ kind: browserKinds[0], accountMode: account.mode, osWorkAccount: osAccount.osWorkAccount }).inPrivate });
  if (opts.check) {
    log(browserLine);
    for (const line of accountLines) log(line);
    log("This computer is ready.");
    return EXIT.ok;
  }
  if (opts.setupAccount) {
    for (const line of accountLines) log(line);
    const driver = deps.playwright || (await loadPlaywrightModule(path.resolve(HERE, "..", "..")));
    const outcome = await (deps.setupAccount || runSetupAccount)({ home, product: opts.setupAccount, playwright: driver, kinds: browserKinds, launch: opts.launch, account, open: openProfile, log, signInWaitSec: opts.signInWaitSec, sleepFn, trace: opts.debug ? createTrace({ file: traceFilePath(home, opts.trace), terms: opts.maskTerms, header: { companion: COMPANION_VERSION, setup: "setup-account", product: opts.setupAccount, platform: process.platform } }) : null });
    await closeAllAttached();
    // The one place to agree, on this computer, to building a practice agent from scratch (the portal's consent alone does not let a computer create things).
    if (outcome.ok && interactive) {
      const optedIn = await ensurePracticeOptIn({ home, product: opts.setupAccount, prompt: deps.ask || ask, interactive, log });
      if (optedIn) log("You can now start “Capture all screenshots automatically” in the Screenshot Center and choose “Build the agent from scratch”.");
    }
    return outcome.ok ? EXIT.ok : EXIT.signIn;
  }
  if (opts.checkSignin) {
    for (const line of accountLines) log(line);
    const driver = deps.playwright || (await loadPlaywrightModule(path.resolve(HERE, "..", "..")));
    const outcome = await (deps.checkSignin || runCheckSignIn)({ home, product: opts.checkSignin, playwright: driver, kinds: browserKinds, launch: opts.launch, open: openProfile, resolved, log, signInWaitSec: opts.signInWaitSec, sleepFn, terms: opts.maskTerms, companion: COMPANION_VERSION, ask: interactive ? deps.ask || ask : null, account });
    await closeAllAttached();
    return outcome.ok ? EXIT.ok : EXIT.signIn;
  }
  if (opts.diagnose) {
    const driver = deps.playwright || (await loadPlaywrightModule(path.resolve(HERE, "..", "..")));
    const code = await runDiagnose({ home, product: opts.diagnose, playwright: driver, kinds: browserKinds, log, ask: deps.ask || ask, terms: opts.maskTerms, launch: opts.launch, account });
    await closeAllAttached();
    return code;
  }

  let config = loadConfig(home);
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
      for (const line of startAgainLines({ entry: path.join(HERE, "companion.mjs"), ...deps.startHint })) log(line);
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
    const signIn = describeSignInState(home);
    try {
      const beat = await client.heartbeat({ busy: false, signedInProducts: listSignedInProfiles(home, { namespace: accountNamespace }), account: accountHeartbeat() });
      log(`Connected to ${config.portal} as "${config.deviceName}". Pairing valid until ${beat.tokenExpiresAt}.`);
      log(browserLine);
      for (const line of accountLines) log(line);
      for (const line of signIn) log(line);
      return EXIT.ok;
    } catch (err) {
      log(err.message);
      for (const line of signIn) log(line);
      return err.kind === "auth" ? EXIT.auth : EXIT.unreachable;
    }
  }

  const playwright = deps.playwright || (await loadPlaywrightModule(path.resolve(HERE, "..", "..")));
  const trace = opts.debug ? createTrace({ file: traceFilePath(home, opts.trace), terms: opts.maskTerms, header: { companion: COMPANION_VERSION, node: process.versions.node, platform: process.platform, browsers: browserKinds.join(","), headless: Boolean(opts.headless) } }) : null;
  if (trace) log(`Writing a debug trace to ${trace.file}. It holds step names, hosts, paths, and decisions only: no cookies, tokens, page text, or account names.`);
  let stopping = false;
  const onSigint = () => {
    if (stopping) process.exit(130);
    stopping = true;
    log("\nStopping after the current screenshot. Press Ctrl+C again to quit now.");
  };
  if (!deps.noSignals) process.on("SIGINT", onSigint);

  const runnerOptions = { callouts: opts.callouts, maskTerms: opts.maskTerms, redact: opts.redact, signInWaitSec: opts.signInWaitSec, headless: opts.headless, background: opts.background === true, allowPracticeWrites: settings.allowPracticeWrites === true, browserKinds, launch: opts.launch, resolvedHome: resolved, trace, guidedWaitSec: opts.guidedWaitSec, readiness: opts.readyWaitSec ? { maxMs: opts.readyWaitSec * 1000 } : {}, account, ...(deps.runnerOptions || {}) };
  const pollMs = (deps.pollMs ?? opts.intervalSec * 1000);
  // The one-time local opt-in for building a practice agent from scratch: asked in this console the first time a job needs it.
  const optInFor = async (claimed) => {
    // A caller that has already settled it (a test, a scripted run) is not asked again.
    if (deps.runnerOptions?.localOptIn === true) return true;
    const level = claimed?.job?.options?.autonomy?.level;
    if (level !== "scratch" || claimed.job.options.autonomy.consented !== true) return false;
    if (opts.allowPracticeWrites === false) return false;
    return ensurePracticeOptIn({ home, product: "copilot-studio", prompt: deps.ask || ask, interactive, log });
  };
  // The one account question, asked in this same console right after the person signed in in the capture window, so nobody signs in twice.
  const confirmAccountHere = interactive || deps.ask ? async () => /^y(?:es)?$/i.test(String(await (deps.ask || ask)(ACCOUNT_CONFIRM_QUESTION).catch(() => "")).trim()) : null;
  let lastBeat = 0;
  let announced = false;
  let waitedMs = 0;
  let unreachableShown = false;
  let backoffMs = 0;
  // What this run has done with each job and each product's sign-in, so nothing loops: a job is not run again and again,
  // and repeated sign-in failures pause and then stop the pickup of new jobs.
  const jobRuns = new Map();
  const signInStreak = new Map();
  let holdMs = 0;
  // The last account setup the portal asked for and how it went, so the portal can show it on the next check-in.
  let accountSetupState = null;
  const handledCommands = new Set();
  log(`Connected to ${config.portal}.`);
  if (!opts.code) for (const line of startAgainLines({ entry: path.join(HERE, "companion.mjs"), ...deps.startHint })) log(line);
  log(browserLine);
  for (const line of accountLines) log(line);

  try {
    while (!stopping && !deps.shouldStop?.()) {
      try {
        if (Date.now() - lastBeat >= HEARTBEAT_MS || lastBeat === 0 || client.takeWake?.()) {
          const beat = await client.heartbeat({ busy: false, signedInProducts: listSignedInProfiles(home, { namespace: accountNamespace }), account: accountHeartbeat(), ...(accountSetupState ? { accountSetup: accountSetupState } : {}) });
          lastBeat = Date.now();
          // The portal can ask this computer to open the account setup (the "Choose which account to use" button).
          const command = (Array.isArray(beat?.commands) ? beat.commands : []).find((c) => c?.type === "setup-account" && /^[a-z0-9-]{1,60}$/i.test(String(c.product || "")) && !handledCommands.has(c.id));
          if (command) {
            handledCommands.add(command.id);
            log(`\nThe portal asked you to choose which account ${productLabel(command.product)} uses.`);
            const sendState = (value) => {
              accountSetupState = { id: String(command.id).slice(0, 60), product: command.product, state: value.state, message: String(value.message || "").slice(0, 300) };
              client.heartbeat({ busy: true, signedInProducts: listSignedInProfiles(home, { namespace: accountNamespace }), account: accountHeartbeat(), accountSetup: accountSetupState }).catch(() => {});
            };
            const outcome = await (deps.setupAccount || runSetupAccount)({ home, product: command.product, playwright, kinds: browserKinds, launch: opts.launch, account, open: openProfile, values: commandValues(command), log, signInWaitSec: opts.signInWaitSec, sleepFn, trace, onState: sendState });
            await closeAllAttached();
            if (!outcome.ok && !accountSetupState) sendState({ state: "failed", message: outcome.message });
            lastBeat = 0;
            continue;
          }
        }
        if (holdMs > 0) {
          holdMs -= pollMs;
          await sleepFn(pollMs);
          continue;
        }
        const claimed = await client.next();
        unreachableShown = false;
        backoffMs = 0;
        if (claimed) {
          announced = false;
          const jobId = claimed.job.id;
          const runs = (jobRuns.get(jobId) || 0) + 1;
          jobRuns.set(jobId, runs);
          if (runs > MAX_JOB_RUNS) {
            log(`The portal gave this computer job ${jobId} again after it already ran ${MAX_JOB_RUNS} times here. Closing it instead of running it again. Queue a new capture if you still need these screenshots.`);
            trace?.event("job-refused", { runs });
            await client.complete(jobId, { message: "Closed by the companion after repeated runs.", fatalError: "The companion ran this job several times and stopped it." }).catch(() => {});
            await sleepFn(pollMs);
            continue;
          }
          const outcome = await runJob({ client, claimed, home, playwright, options: { ...runnerOptions, localOptIn: await optInFor(claimed), confirmAccount: confirmAccountHere }, log, shouldStop: () => stopping, sleepFn });
          lastBeat = 0;
          if (opts.once) break;
          const failedProducts = new Set(outcome.signInFailures.map((f) => f.product));
          for (const product of outcome.capturedProducts) signInStreak.delete(product);
          for (const product of failedProducts) if (!outcome.capturedProducts.includes(product)) signInStreak.set(product, (signInStreak.get(product) || 0) + 1);
          const worst = Math.max(0, ...signInStreak.values());
          if (worst >= MAX_SIGN_IN_FAILURES) {
            const names = [...signInStreak].filter(([, n]) => n >= MAX_SIGN_IN_FAILURES).map(([product]) => productLabel(product)).join(", ");
            log(`\nSign-in to ${names} did not work ${worst} jobs in a row, so I will stop picking up capture jobs on my own. Fix the sign-in (see Troubleshooting in the README; run again with --debug to write a trace), then start the companion again.`);
            trace?.event("stopped-after-sign-in-failures", { jobs: worst });
            return EXIT.signIn;
          }
          if (worst > 0) {
            holdMs = SIGN_IN_BACKOFF_MS[Math.min(worst, SIGN_IN_BACKOFF_MS.length) - 1];
            log(`\nWaiting ${Math.round(holdMs / 1000)} seconds before taking another job, so you are not asked to sign in again right away. Press Ctrl+C to stop.`);
          }
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
    await closeAllAttached();
    if (trace) log(`Debug trace saved: ${trace.file}`);
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
