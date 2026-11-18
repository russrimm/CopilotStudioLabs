// Opening Edge or Chrome the way a person does, then connecting to it.
//
// Playwright's own launcher starts the browser with automation switches (one that shows the "controlled by automated
// test software" bar, one that turns extensions off, a fresh profile, and more). Some organizations' device-based sign-in
// (Conditional Access that wants a managed or compliant device, Windows account single sign-on) does not work in a
// browser started that way, so the sign-in bounces. This launcher ("attach") starts the installed browser as an ordinary
// process with its own dedicated profile folder and a debugging port that listens only on this computer, then connects
// Playwright to it over that port. The person signs in by hand in a normal window.
//
// This is not a disguise: it does not hide automation, change what the browser reports about itself, or work around
// any protection. It just does not add switches that change how a managed browser behaves.
//
// Safety: the port is random, bound to 127.0.0.1, and closed when the browser exits; a profile folder is used by one
// companion at a time; and the browser process is ended when the companion closes it, stops, or crashes.

import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

export const LAUNCH_CHOICES = Object.freeze(["auto", "attach", "playwright"]);
export const LOCK_FILE = ".companion-lock.json";

export function parseLaunchChoice(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return { ok: false, error: "--launch needs a value: auto, attach, or playwright." };
  return LAUNCH_CHOICES.includes(text) ? { ok: true, launch: text } : { ok: false, error: `--launch must be auto, attach, or playwright (got "${value}").` };
}

export class AttachError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AttachError";
    this.code = code;
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A free port on this computer's loopback address (a random one, picked by the operating system). */
export function freeLoopbackPort({ netModule = net } = {}) {
  return new Promise((resolve, reject) => {
    const server = netModule.createServer();
    server.unref?.();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** The command-line switches for a browser that is started as a normal process with a debugging port. */
export function attachArgs({ dir, port, headless = false }) {
  return [
    `--user-data-dir=${dir}`,
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    "--no-first-run",
    "--no-default-browser-check",
    ...(headless ? ["--headless=new"] : []),
    "about:blank",
  ];
}

// ── One companion per profile ──────────────────────────────────────────────

export function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

/**
 * Claim a profile folder for this process. A second companion on the same profile is refused (a browser started on a
 * profile that is already open would just hand the request to the first one and exit).
 */
export function acquireProfileLock(dir, { pid = process.pid, isAlive = pidIsAlive, now = () => Date.now() } = {}) {
  const file = path.join(dir, LOCK_FILE);
  const key = path.resolve(dir);
  fs.mkdirSync(dir, { recursive: true });
  let existing = null;
  try {
    existing = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    existing = null;
  }
  const heldHere = heldDirs.has(key);
  if (heldHere || (existing && Number.isInteger(existing.pid) && existing.pid !== pid && isAlive(existing.pid))) {
    throw new AttachError("PROFILE_IN_USE", "Another companion window is already using this sign-in profile. Close that window (or stop that companion), then try again.");
  }
  heldDirs.add(key);
  fs.writeFileSync(file, JSON.stringify({ pid, startedAt: new Date(now()).toISOString() }), { mode: 0o600 });
  return {
    release() {
      heldDirs.delete(key);
      try {
        const current = JSON.parse(fs.readFileSync(file, "utf8"));
        if (current?.pid === pid) fs.rmSync(file, { force: true });
      } catch {
        // Nothing to release.
      }
    },
  };
}

const heldDirs = new Set();

// ── Starting and stopping ──────────────────────────────────────────────────

const live = new Set();
let exitHookInstalled = false;

function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // The last chance: if the companion stops or crashes, do not leave a browser with a debugging port behind.
  process.on("exit", () => {
    for (const entry of [...live]) entry.killNow();
  });
}

/** Whether this Playwright module can connect to a running browser. */
export function attachSupported(playwright) {
  return typeof playwright?.chromium?.connectOverCDP === "function";
}

/** Whether attach should be used for this browser: Edge or Chrome, installed, with a Playwright that can connect. */
export function wantsAttach({ launch = "auto", kind, playwright, executable }) {
  if (launch === "playwright") return false;
  if (kind !== "edge" && kind !== "chrome") return false;
  if (!executable) return false;
  return attachSupported(playwright);
}

async function waitForEndpoint({ port, fetchFn, sleep, timeoutMs, pollMs, exited }) {
  for (let waited = 0; waited <= timeoutMs; waited += pollMs) {
    const gone = exited();
    if (gone) {
      throw new AttachError("BROWSER_EXITED", `${gone.error ? "The browser could not be started." : "The browser closed right away."} It may have handed over to a window that is already open, or this computer does not allow a browser to listen on a debugging port.`);
    }
    try {
      const response = await fetchFn(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout?.(1500) });
      if (response?.ok) {
        const body = await response.json();
        const wsUrl = String(body?.webSocketDebuggerUrl || "");
        const parsed = new URL(wsUrl);
        if (!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) || Number(parsed.port) !== port) {
          throw new AttachError("NOT_LOOPBACK", "The browser's debugging address was not on this computer, so it was not used.");
        }
        return { wsUrl };
      }
    } catch (err) {
      if (err instanceof AttachError) throw err;
      // Not listening yet.
    }
    await sleep(pollMs);
  }
  throw new AttachError("NO_DEBUG_PORT", "The browser did not open its debugging port in time.");
}

/**
 * Start the installed browser as a normal process and connect to it.
 * @returns {Promise<{context: object, browser: object, port: number, close: () => Promise<void>}>}
 *   `context.close()` closes the browser and ends its process.
 */
export async function launchAttached({ playwright, kind, dir, executable, headless = false, spawnFn = nodeSpawn, fetchFn = globalThis.fetch, portFn = freeLoopbackPort, sleep = defaultSleep, timeoutMs = 25_000, pollMs = 150, trace = null, isAlive = pidIsAlive, exitWaitMs = 15_000 } = {}) {
  if (!executable) throw new AttachError("NO_EXECUTABLE", "The browser program was not found.");
  if (!attachSupported(playwright)) throw new AttachError("UNSUPPORTED", "This Playwright cannot connect to a running browser.");
  installExitHook();
  const lock = acquireProfileLock(dir, { isAlive });
  let child = null;
  let browser = null;
  let exited = null;
  let closed = false;
  let port = 0;
  const entry = {
    killNow() {
      try {
        child?.kill?.();
      } catch {
        // Already gone.
      }
      lock.release();
    },
  };
  const waitForExit = async (ms) => {
    for (let waited = 0; !exited && waited < ms; waited += 50) await sleep(50);
    return Boolean(exited);
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    live.delete(entry);
    try {
      const session = await browser?.newBrowserCDPSession?.();
      await Promise.race([session?.send?.("Browser.close"), sleep(2000)]);
    } catch {
      // The browser may already be closing.
    }
    try {
      await browser?.close?.();
    } catch {
      // Disconnecting from a browser that is gone is fine.
    }
    if (child && !(await waitForExit(exitWaitMs))) {
      entry.killNow();
      await waitForExit(2000);
    }
    lock.release();
    trace?.event("attach-closed", { browser: kind });
  };

  try {
    port = await portFn();
    child = spawnFn(executable, attachArgs({ dir, port, headless }), { stdio: "ignore", windowsHide: false });
    live.add(entry);
    child.once?.("exit", (code, signal) => {
      exited = { code, signal };
      trace?.event("attach-process-exit", { browser: kind, code: code ?? null, signal: signal ?? null });
    });
    child.once?.("error", (error) => {
      exited = { error };
    });
    trace?.event("attach-start", { browser: kind, headless: Boolean(headless), port: "loopback" });
    const { wsUrl } = await waitForEndpoint({ port, fetchFn, sleep, timeoutMs, pollMs, exited: () => exited });
    browser = await playwright.chromium.connectOverCDP(wsUrl);
    const context = browser.contexts?.()[0];
    if (!context) throw new AttachError("NO_CONTEXT", "The browser opened without a profile to use.");
    let disconnected = false;
    browser.on?.("disconnected", () => {
      disconnected = true;
      live.delete(entry);
      lock.release();
    });
    context.isCompanionClosed = () => closed || disconnected || Boolean(exited);
    context.companionPid = child.pid;
    context.close = close;
    return { context, browser, port, close };
  } catch (err) {
    closed = false;
    try {
      await close();
    } catch {
      entry.killNow();
    }
    throw err;
  }
}

/** Close every browser this process started with attach. Safe to call more than once. */
export async function closeAllAttached() {
  for (const entry of [...live]) entry.killNow();
  live.clear();
}

/** Test hook: how many attached browsers this process is holding open. */
export const attachedCount = () => live.size;
