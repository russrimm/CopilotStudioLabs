// `--check-signin <product>`: find out, without capturing anything, why a sign-in does or does not stick.
//
// It opens the product's start page once, then only WATCHES while the person signs in, and writes down what it saw:
// the sequence of hosts and paths (never query strings), how long each step took, which sign-in and product cookies
// exist (names and attributes, never values), whether cookies are blocked, whether this computer is joined to a work
// account, whether the data folder is synced, how far this computer's clock is from Microsoft's, and any AADSTS error
// code. Then it says what it thinks in plain language and writes the same facts to a redacted trace.
//
// The same fact collectors feed the diagnosis shown when a capture job's sign-in fails (see createSignInDiagnoser).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { accountPayload, classifyAccountSource, landedInOsTenant, readAccountRecord, signInPageShown, writeAccountRecord } from "./account-source.mjs";
import { describeAccount } from "./account-guard.mjs";
import { createAuthGate, productLabel, saveSession } from "./auth.mjs";
import { BrowserClosedError, gotoWithRetry } from "./lifecycle.mjs";
import { diagnoseSignIn, diagnosisLines, readAadstsCode, signInReport } from "./signin-diagnosis.mjs";
import { classifyUrl, cleanPathForReport, maskTenantHost } from "./signin-url.mjs";
import { createSurfaceWatch, describeSurface } from "./surface-watch.mjs";
import { createTrace, traceFilePath } from "./trace.mjs";

const DEFAULT_START = "https://copilotstudio.microsoft.com/";

// ── Facts about this computer ──────────────────────────────────────────────

/** A cookie's name with ids hidden, or null when it should not be listed. */
export function cleanCookieName(name) {
  const value = String(name ?? "").trim();
  if (!value || /@/.test(value)) return null;
  const masked = value.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "{id}");
  return /^[A-Za-z0-9_.{}-]{1,48}$/.test(masked) ? masked : null;
}

/**
 * Which cookies exist for the sign-in hosts and the product, by name and attributes. Values are never read into the report.
 * @returns {{signIn: object[], product: object[]}|null}
 */
export async function cookiePresence(context, { productHost = "" } = {}) {
  let cookies;
  try {
    cookies = await context.cookies();
  } catch {
    return null;
  }
  const family = (host) => String(host).split(".").filter(Boolean).slice(-2).join(".");
  const targetFamily = productHost ? family(productHost) : "";
  const out = { signIn: [], product: [] };
  const seen = new Set();
  for (const cookie of Array.isArray(cookies) ? cookies : []) {
    const host = String(cookie?.domain || "").replace(/^\./, "").toLowerCase();
    if (!host) continue;
    const area = classifyUrl(`https://${host}/`).kind === "sign-in" ? "signIn" : targetFamily && family(host) === targetFamily ? "product" : null;
    const name = cleanCookieName(cookie?.name);
    if (!area || !name) continue;
    const key = `${area}:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (out[area].length < 40) {
      out[area].push({ name, secure: cookie.secure === true, httpOnly: cookie.httpOnly === true, sameSite: ["Strict", "Lax", "None"].includes(cookie.sameSite) ? cookie.sameSite : "unset", persistent: typeof cookie.expires === "number" && cookie.expires > 0 });
    }
  }
  return out;
}

/** Whether the browser profile blocks cookies, read from its settings file. Best effort. */
export function readCookieSettings(profileDir) {
  try {
    const prefs = JSON.parse(fs.readFileSync(path.join(profileDir, "Default", "Preferences"), "utf8"));
    const content = prefs?.profile?.default_content_setting_values?.cookies;
    const mode = prefs?.profile?.cookie_controls_mode;
    if (content === 2) return { setting: "block-all", blocked: true };
    if (mode === 1) return { setting: "block-third-party", blocked: true };
    return { setting: "allow", blocked: false };
  } catch {
    return { setting: "unknown", blocked: null };
  }
}

/** On Windows: whether this computer is joined to a work or school account, from `dsregcmd /status`. Yes or no only. */
export function windowsDeviceState({ exec = execFileSync, platform = process.platform } = {}) {
  if (platform !== "win32") return null;
  try {
    const out = String(exec("dsregcmd", ["/status"], { encoding: "utf8", timeout: 8000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }) || "");
    const flag = (name) => {
      const match = new RegExp(`^\\s*${name}\\s*:\\s*(YES|NO)\\s*$`, "im").exec(out);
      return match ? match[1].toUpperCase() === "YES" : null;
    };
    const azureAdJoined = flag("AzureAdJoined");
    const domainJoined = flag("DomainJoined");
    const workplaceJoined = flag("WorkplaceJoined");
    const prt = flag("AzureAdPrt");
    if ([azureAdJoined, domainJoined, workplaceJoined, prt].every((v) => v === null)) return null;
    return { joined: Boolean(azureAdJoined || domainJoined || workplaceJoined), azureAdJoined, domainJoined, workplaceJoined, prt };
  } catch {
    return null;
  }
}

/** How many seconds this computer's clock is ahead of Microsoft's sign-in service, from the `Date` header of one plain request. */
export async function measureClockSkew({ fetchFn = globalThis.fetch, now = () => Date.now(), timeoutMs = 4000 } = {}) {
  if (typeof fetchFn !== "function") return null;
  try {
    const before = now();
    const response = await fetchFn("https://login.microsoftonline.com/", { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout?.(timeoutMs) });
    const after = now();
    const header = response?.headers?.get?.("date");
    const server = Date.parse(header || "");
    if (!Number.isFinite(server)) return null;
    return Math.round(((before + after) / 2 - server) / 1000);
  } catch {
    return null;
  }
}

/**
 * The function a sign-in gate calls when sign-in stops working: it gathers the facts (an AADSTS code on screen,
 * the data folder, the launch method, cookie settings, device state, the clock) and returns the diagnosis.
 * The slow checks run once and only on a failure.
 */
export function createSignInDiagnoser({ synced = null, launch = null, profileDir = null, savedSession = false, device = windowsDeviceState, skew = measureClockSkew, readAadsts = readAadstsCode } = {}) {
  const cache = {};
  return async ({ code, page, product, bounces }) => {
    const aadsts = await readAadsts(page).catch(() => null);
    if (!("device" in cache)) cache.device = await Promise.resolve(device()).catch(() => null);
    if (!("skew" in cache)) cache.skew = await Promise.resolve(skew()).catch(() => null);
    return diagnoseSignIn({ code, aadsts, synced, launch, cookies: profileDir ? readCookieSettings(profileDir) : null, device: cache.device, skewSec: cache.skew, savedSession, bounces, product });
  };
}

// ── The check ──────────────────────────────────────────────────────────────

export function startUrlFor(product, config = null) {
  const configured = config?.products?.[product]?.startUrl;
  return /^https:\/\//i.test(String(configured || "")) ? configured : DEFAULT_START;
}

export async function readProductConfig() {
  try {
    const { readCaptureConfig } = await import("../feature-tour/lib/products.mjs");
    return readCaptureConfig();
  } catch {
    return null;
  }
}

const sec = (ms) => Math.round(ms / 100) / 10;

/** The hops as report lines: no query strings, ids and tenant names hidden. */
export function describeHops(hops, { max = 24 } = {}) {
  const list = (Array.isArray(hops) ? hops : []).slice(0, max).map((h, i) => ({
    step: i + 1,
    afterSec: sec(h.at || 0),
    kind: h.kind === "sign-in" ? "sign-in page" : "product page",
    host: maskTenantHost(h.host),
    path: cleanPathForReport(h.path),
  }));
  return list;
}

/** Plain-language lines for a finished check. */
export function describeVerdict(report) {
  const lines = [];
  const name = productLabel(report.product);
  const o = report.outcome;
  if (o.result === "signed-in") {
    const passedByItself = report.hops.some((h) => h.kind === "sign-in page");
    const how = o.needsPerson ? " (you had to sign in)" : passedByItself ? " (the sign-in page passed by itself: the saved sign-in or single sign-on worked)" : " (no sign-in page appeared while the product's page was watched)";
    lines.push(`Result: signed in. ${name} opened after ${report.hops.length} page change${report.hops.length === 1 ? "" : "s"} in ${o.durationSec} seconds${how}.`);
  } else if (o.result === "ping-pong") {
    lines.push(`Result: loop. The browser went back and forth between ${name} and the Microsoft sign-in page without staying on a sign-in page for you.`);
  } else if (o.result === "timeout") {
    lines.push(`Result: sign-in was not finished in ${o.durationSec} seconds.`);
  } else if (o.result === "browser-closed") {
    lines.push("Result: the browser window was closed before the sign-in finished.");
  } else {
    lines.push(`Result: ${o.result}.`);
  }
  lines.push(`Browser: ${report.browser.label}${report.browser.major ? ` ${report.browser.major}` : ""}, started ${report.browser.launch === "attach" ? "the normal way (attach)" : "by the automation launcher (playwright)"}.`);
  if (report.device) lines.push(`This computer is joined to a work or school account: ${report.device.joined ? "yes" : "no"}${report.device.prt === null ? "" : `; single sign-on token present: ${report.device.prt ? "yes" : "no"}`}.`);
  else lines.push("Work or school account on this computer: not checked (Windows only).");
  if (report.account) lines.push(`Account: ${describeAccount(report.account)}`);
  lines.push(`Data folder: ${report.home.synced ? `inside ${report.home.provider || "a synced folder"} (a likely cause of sign-in loops)` : "local, not synced"}.`);
  if (report.cookies) {
    const part = (list) => `${list.length} (${list.filter((c) => c.persistent).length} kept after the browser closes)`;
    lines.push(`Cookies: sign-in site ${part(report.cookies.signIn)}, product ${part(report.cookies.product)}.`);
  } else lines.push("Cookies: could not be listed.");
  lines.push(`Cookie setting in this browser profile: ${report.cookieSetting}.`);
  lines.push(`Clock: ${report.clockSkewSec === null ? "could not be compared with Microsoft's" : Math.abs(report.clockSkewSec) <= 120 ? "within two minutes of Microsoft's" : `${Math.abs(report.clockSkewSec)} seconds ${report.clockSkewSec > 0 ? "ahead of" : "behind"} Microsoft's (too far)`}.`);
  if (report.aadsts) lines.push(`Microsoft error code on screen: ${report.aadsts}.`);
  lines.push(...describeSurface(report.surface));
  if (report.diagnosis) lines.push(...diagnosisLines(report.diagnosis));
  return lines;
}

/**
 * Run the check. `open` is companion.openProfile (passed in to avoid a circular import).
 * @returns {Promise<{ok: boolean, report: object, lines: string[], traceFile: string|null}>}
 */
export async function runCheckSignIn({ home, product, playwright, kinds, launch = "auto", open, resolved = null, log = console.log, signInWaitSec = 180, sleepFn = (ms) => new Promise((r) => setTimeout(r, ms)), terms = [], companion = "", ask = null, deps = {}, account = null }) {
  const config = await readProductConfig();
  const start = startUrlFor(product, config);
  const startHost = new URL(start).hostname;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const trace = createTrace({ file: traceFilePath(home, path.join(".captures", "traces", `check-signin-${stamp}.log`)), terms, header: { companion, check: "check-signin", product, platform: process.platform } });
  log(`Checking the sign-in for ${productLabel(product)}. A browser window opens; sign in there if it asks. Nothing is captured.`);
  let opened;
  try {
    opened = await open({ playwright, home, profile: product, kinds, headless: false, log, trace, launch, account });
  } catch (err) {
    log(String(err?.message || err).split("\n")[0]);
    return { ok: false, report: null, lines: [], traceFile: trace.file };
  }
  const synced = resolved?.synced || { synced: false, provider: null };
  const diagnose = createSignInDiagnoser({ synced, launch: opened.launch || "playwright", profileDir: opened.dir, savedSession: Boolean(fs.existsSync(path.join(opened.dir || "", "companion-session.json"))), ...(deps.diagnoser || {}) });
  let surfaceWatch = null;
  const gate = createAuthGate({
    product,
    waitMs: signInWaitSec * 1000,
    pollMs: 250,
    settleMs: 3000,
    graceMs: 2500,
    confirmMs: 6000,
    firstLoadMs: 10_000,
    sleep: sleepFn,
    notify: ({ message }) => {
      log(message);
      if (surfaceWatch?.isCovered()) log("The sign-in window is behind other windows right now. Click the new browser window's icon on the taskbar to bring it forward.");
    },
    trace,
    diagnose,
    ...(deps.gate || {}),
  });
  let result;
  let page;
  const startedAt = Date.now();
  // Watches the window (tabs, popups, blank page, focus, sign-in broker windows) without touching it or reading page text.
  surfaceWatch = deps.surface === false ? null : createSurfaceWatch({ context: opened.context, pid: opened.context.companionPid, trace, ...(deps.surface || {}) });
  surfaceWatch?.start();
  let surface = null;
  try {
    page = opened.context.pages()[0] || (await opened.context.newPage());
    // Once, before sign-in begins (starting a browser normally puts its window in front); never again while a person signs in.
    if (deps.raiseWindow !== false) {
      await page.bringToFront?.().catch(() => {});
      trace.event("window-raise", { reason: "startup", times: 1 });
    }
    await gotoWithRetry(page, start, { waitUntil: "domcontentloaded", sleep: sleepFn, trace, reason: "check-signin-start" }).catch(() => {});
    result = await gate.ensureSignedIn(page, { phase: "navigate", target: start }).catch((err) => {
      if (!(err instanceof BrowserClosedError)) throw err;
      return { ok: false, status: "auth-required", code: "browser-closed", error: "The browser window was closed before the sign-in finished.", diagnosis: null };
    });
    surface = surfaceWatch ? await surfaceWatch.stop() : null;
    const durationSec = sec(gate.state.clockMs > 0 ? gate.state.clockMs : Date.now() - startedAt);
    const hops = gate.detector.hops();
    const needsPerson = gate.state.waits > 0 && gate.state.waitedMs >= 3000;
    // Which account this is, from how the sign-in went and where it landed (ids are compared in memory only).
    let accountFacts = null;
    if (account && result.ok) {
      const landed = typeof page.url === "function" ? page.url() : "";
      const inOsTenant = landedInOsTenant(landed, account.os);
      const before = readAccountRecord(opened.dir);
      const classified = classifyAccountSource({ signInShown: signInPageShown(hops), inOsTenant, osWorkAccount: account.os?.osWorkAccount ?? null, previous: before?.source || null });
      writeAccountRecord(opened.dir, { source: classified.source, inOsTenant });
      accountFacts = accountPayload({ mode: account.mode, source: classified.source, verified: before?.confirmed === true || before?.verified === true, osWorkAccountDetected: account.os?.osWorkAccount ?? null, browser: opened.kind, inOsTenant, inPrivate: opened.inPrivate === true });
    }
    const cookies = await cookiePresence(opened.context, { productHost: startHost });
    const device = await Promise.resolve((deps.device || windowsDeviceState)()).catch(() => null);
    const skewSec = await Promise.resolve((deps.skew || measureClockSkew)()).catch(() => null);
    const cookieSettings = opened.dir ? readCookieSettings(opened.dir) : { setting: "unknown", blocked: null };
    const aadsts = result.ok ? null : result.diagnosis?.aadsts || (await readAadstsCode(page));
    let version = "";
    try {
      version = String(opened.context.browser?.()?.version?.() || "");
    } catch {
      version = "";
    }
    const report = {
      version: 1,
      product,
      companion,
      platform: process.platform,
      browser: { kind: opened.kind, label: opened.kind === "edge" ? "Microsoft Edge" : opened.kind === "chrome" ? "Google Chrome" : "Chromium", launch: opened.launch || "playwright", major: (/(\d+)\./.exec(version) || [])[1] || "" },
      home: { synced: synced.synced === true, provider: synced.provider || null, source: resolved?.source || "unknown" },
      device: device ? { joined: device.joined === true, prt: device.prt ?? null } : null,
      outcome: { result: result.ok ? "signed-in" : result.code || "failed", needsPerson, durationSec },
      account: accountFacts,
      hops: describeHops(hops),
      cookies,
      cookieSetting: cookieSettings.setting,
      clockSkewSec: skewSec,
      aadsts,
      surface,
      diagnosis: result.ok ? null : result.diagnosis || diagnoseSignIn({ code: result.code, aadsts, synced, launch: opened.launch, cookies: cookieSettings, device, skewSec, product }),
    };
    const lines = describeVerdict(report);
    trace.event("check-signin-verdict", { result: report.outcome.result, hops: report.hops.length, durationSec, needsPerson, browser: report.browser.kind, launch: report.browser.launch, synced: report.home.synced, cookiesSignIn: cookies?.signIn.length ?? null, cookiesProduct: cookies?.product.length ?? null, cookieSetting: report.cookieSetting, clockSkewSec: skewSec, aadsts, deviceJoined: device?.joined ?? null });
    for (const hop of report.hops) trace.event("check-signin-hop", { step: hop.step, afterSec: hop.afterSec, kind: hop.kind, host: hop.host, path: hop.path });
    for (const line of lines) trace.event("check-signin-line", { text: line });
    if (result.ok) await saveSession({ context: opened.context, dir: opened.dir, product, browser: opened.kind, captured: false }).catch(() => {});
    log("");
    for (const line of lines) log(line);
    if (report.hops.length) {
      log("What the browser did (addresses without query strings):");
      for (const hop of report.hops) log(`  ${hop.step}. after ${hop.afterSec}s: ${hop.kind} ${hop.host}${hop.path}`);
    }
    log(`This check was written to ${trace.file}. It holds hosts, paths, cookie names, and settings only: no cookie values, tokens, page text, or account names. Send that file if you ask for help.`);
    if (!result.ok && typeof ask === "function") await ask("The browser window is still open so you can look at it. Press Enter here to close it. ").catch(() => {});
    return { ok: result.ok, report, lines, traceFile: trace.file, signIn: result.ok ? null : signInReport(report.diagnosis, { product }) };
  } finally {
    await surfaceWatch?.stop().catch(() => {});
    await opened.context.close().catch(() => {});
  }
}
