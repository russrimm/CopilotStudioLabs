// Which browser the companion opens. People sign in themselves, so a normal installed browser is preferred over
// Playwright's bundled Chromium where that is safe: it is the browser their organization already trusts, and some
// tenants refuse to sign in to an unmanaged one.
//
// There is one exception, and it is about WHICH ACCOUNT signs in. On a PC that is joined to a work or school account
// (Microsoft Entra), Microsoft Edge signs its profiles in with that Windows work account, and a screenshot would then
// come from the corporate tenant instead of the demo tenant the person wants. So when the PC has a work account and the
// person has not asked for it ("--account-mode=windows"), the default order is Chrome, then Chromium, and Edge last, and
// Edge is then opened InPrivate, which does not carry the Windows account (measured, see the README). Nothing here hides
// that the browser is automated or changes how it identifies itself.

import fs from "node:fs";

import { BROWSER_KINDS } from "./auth.mjs";

export const BROWSER_INFO = Object.freeze({
  edge: { channel: "msedge", label: "Microsoft Edge" },
  chrome: { channel: "chrome", label: "Google Chrome" },
  chromium: { channel: null, label: "Chromium (installed with Playwright)" },
});

const BROWSER_CHOICES = Object.freeze(["auto", ...BROWSER_KINDS]);

export function parseBrowserChoice(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return { ok: false, error: "--browser needs a value: auto, edge, chrome, or chromium." };
  const alias = { msedge: "edge", "microsoft-edge": "edge", "google-chrome": "chrome" }[text] || text;
  return BROWSER_CHOICES.includes(alias) ? { ok: true, browser: alias } : { ok: false, error: `--browser must be auto, edge, chrome, or chromium (got "${value}").` };
}

/** Where each browser is normally installed on this computer. */
export function browserCandidates({ platform = process.platform, env = process.env } = {}) {
  const join = (...parts) => parts.filter(Boolean).join(platform === "win32" ? "\\" : "/");
  if (platform === "win32") {
    const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(Boolean);
    return {
      edge: roots.map((r) => join(r, "Microsoft", "Edge", "Application", "msedge.exe")),
      chrome: roots.map((r) => join(r, "Google", "Chrome", "Application", "chrome.exe")),
    };
  }
  if (platform === "darwin") {
    return {
      edge: ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
      chrome: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
    };
  }
  return {
    edge: ["/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable", "/opt/microsoft/msedge/msedge"],
    chrome: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome"],
  };
}

/** Which of Edge and Chrome are installed. Never starts a browser. */
export function detectInstalledBrowsers({ platform = process.platform, env = process.env, exists = (file) => fs.existsSync(file) } = {}) {
  const candidates = browserCandidates({ platform, env });
  const found = {};
  for (const kind of ["edge", "chrome"]) found[kind] = candidates[kind].find((file) => exists(file)) || null;
  return found;
}

/**
 * The order `--browser=auto` tries browsers in. With a Windows work account on this PC and a separate sign-in wanted,
 * a browser that cannot sign in with that account comes first and Edge comes last; otherwise the original order.
 */
export function autoBrowserOrder({ accountMode = "windows", osWorkAccount = null } = {}) {
  return accountMode === "separate" && osWorkAccount === true ? ["chrome", "chromium", "edge"] : ["edge", "chrome", "chromium"];
}

/**
 * The browsers to try, best first.
 * `installed` is `{edge, chrome, chromium}` (truthy when present). An explicit choice never falls back to another browser.
 */
export function chooseBrowsers({ requested = "auto", installed = {}, accountMode = "windows", osWorkAccount = null } = {}) {
  const order = requested === "auto" ? autoBrowserOrder({ accountMode, osWorkAccount }) : [requested];
  const kinds = order.filter((kind) => Boolean(installed[kind]));
  if (kinds.length) return { ok: true, kinds, requested };
  return { ok: false, kinds: [], requested, message: missingBrowserMessage(requested) };
}

/**
 * How a browser is opened for an account mode. Edge on a PC with a Windows work account is opened InPrivate when a
 * separate sign-in is wanted: an InPrivate window has no browser profile, so it does not carry the Windows account.
 * Allowing the Windows account on purpose ("windows") opens Edge normally.
 */
export function launchPolicy({ kind, accountMode = "windows", osWorkAccount = null } = {}) {
  return { inPrivate: kind === "edge" && accountMode === "separate" && osWorkAccount === true };
}

export function missingBrowserMessage(requested = "auto") {
  if (requested === "edge") return "Microsoft Edge was not found on this computer. Install it from https://www.microsoft.com/edge, or use --browser=auto.";
  if (requested === "chrome") return "Google Chrome was not found on this computer. Install it from https://www.google.com/chrome, or use --browser=auto.";
  if (requested === "chromium") return "The Chromium browser is not installed. Run: npx playwright install chromium (or run this again with --install-browser).";
  return "No supported browser was found. Install Microsoft Edge or Google Chrome, or run: npx playwright install chromium (or run this again with --install-browser).";
}

/** Whether a launch error means "this browser is not there" rather than "it started badly". */
export function isMissingBrowserError(error) {
  return /Executable doesn't exist|playwright install|is not found at|Chromium distribution '.*' is not found|ENOENT/i.test(String(error?.message || error));
}

export function browserLabel(kind) {
  return BROWSER_INFO[kind]?.label || kind;
}

/** Open a persistent profile in the chosen browser. */
export function launchBrowser({ playwright, kind, dir, headless = false, viewport = { width: 1440, height: 900 }, inPrivate = false }) {
  const info = BROWSER_INFO[kind];
  if (!info) throw new Error(`Unknown browser "${kind}".`);
  return playwright.chromium.launchPersistentContext(dir, { headless: Boolean(headless), viewport, ...(info.channel ? { channel: info.channel } : {}), ...(inPrivate ? { args: ["--inprivate"] } : {}) });
}
