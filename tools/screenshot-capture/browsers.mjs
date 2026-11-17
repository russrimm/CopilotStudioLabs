// Which browser the companion opens. People sign in themselves, so a normal installed browser
// (Microsoft Edge, then Google Chrome) is preferred over Playwright's bundled Chromium: it is the
// browser their organization already trusts, and some tenants refuse to sign in to an unmanaged one.
// Nothing here hides that it is automated or changes how the browser identifies itself.

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
 * The browsers to try, best first.
 * `installed` is `{edge, chrome, chromium}` (truthy when present). An explicit choice never falls back to another browser.
 */
export function chooseBrowsers({ requested = "auto", installed = {} } = {}) {
  const order = requested === "auto" ? ["edge", "chrome", "chromium"] : [requested];
  const kinds = order.filter((kind) => Boolean(installed[kind]));
  if (kinds.length) return { ok: true, kinds, requested };
  return { ok: false, kinds: [], requested, message: missingBrowserMessage(requested) };
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
export function launchBrowser({ playwright, kind, dir, headless = false, viewport = { width: 1440, height: 900 } }) {
  const info = BROWSER_INFO[kind];
  if (!info) throw new Error(`Unknown browser "${kind}".`);
  return playwright.chromium.launchPersistentContext(dir, { headless: Boolean(headless), viewport, ...(info.channel ? { channel: info.channel } : {}) });
}
