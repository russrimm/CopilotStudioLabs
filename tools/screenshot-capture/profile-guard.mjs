// Is the browser profile the companion wants to open already in use? Find out BEFORE starting a browser, say so in plain
// words, and wait for it to be free instead of failing the screenshots.
//
// Why this exists: a browser started on a profile folder that another browser process already holds does not open a
// window. It hands the request to that process and exits ("Opening in existing browser session"), so the companion
// saw "the browser closed right away", then the automation launcher failed the same way, and every shot was reported
// as failed although nothing was wrong with the screenshots.
//
// What is checked, none of it needs administrator rights:
//   1. the browser programs running on this computer whose command line names this exact profile folder
//      (Windows: Win32_Process through PowerShell; macOS and Linux: ps),
//   2. the profile's own lock (Windows: the "lockfile" the main process keeps open; macOS and Linux: SingletonLock),
//   3. a DevToolsActivePort file whose port still answers,
//   4. the companion's own records in the profile folder (which companion owns it, which browser it started).
//
// Safety rules this module keeps:
//   - It never ends, closes, or touches a process. It only reads.
//   - A browser counts as "started by this companion" only with proof: a record written when the companion started it
//     (process number and debugging port) that matches a live process whose command line names this profile folder and
//     that port. Anything else is "another browser" and is left alone.
//   - It never targets a browser's own default data folder (the one a person's everyday browser uses).

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const COMPANION_LOCK_FILE = ".companion-lock.json";
export const BROWSER_RECORD_FILE = ".companion-browser.json";
export const PROFILE_WAIT_MS = 120_000;
export const PROFILE_STATUS_MS = 15_000;
export const PROFILE_POLL_MS = 2000;
/** After a start that found the profile taken, how long to wait before trying to start again, and how many such starts are tried. */
export const PROFILE_RETRY_GAP_MS = 10_000;
export const PROFILE_MAX_START_FAILURES = 3;
/** The exit code a Chromium browser uses when its profile is already in use by another process. */
export const PROFILE_IN_USE_EXIT_CODE = 21;

const BROWSER_NAMES = Object.freeze({ edge: "Microsoft Edge", chrome: "Google Chrome", chromium: "Chromium" });
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class ProfileBusyError extends Error {
  /**
   * @param {string} message one plain sentence for the console
   * @param {object} details `{state, short}`: the kind of block and a shorter sentence for the portal
   */
  constructor(message, { state = "other", short = null } = {}) {
    super(message);
    this.name = "ProfileBusyError";
    this.code = "PROFILE_BUSY";
    this.state = state;
    this.short = short || message;
  }
}

export function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

// ── Comparing paths and command lines ──────────────────────────────────────

function trimSeparator(text) {
  return text.length > 1 && /[\\/]$/.test(text) && !/^[A-Za-z]:[\\/]$/.test(text) ? text.slice(0, -1) : text;
}

/** A path or command line made comparable: no quotes, one kind of slash, and no case on systems that ignore it. */
export function normalizeForMatch(text, platform = process.platform) {
  let out = String(text ?? "").replace(/"/g, "");
  if (platform === "win32") out = out.replace(/\//g, "\\").replace(/^\\\\\?\\/, "").replace(/(?<!^)\\{2,}/g, "\\");
  return platform === "win32" || platform === "darwin" ? out.toLowerCase() : out;
}

/** Every spelling of a profile folder a command line could use: as given, and with short names and links resolved. */
export function profilePathKeys(dir, { platform = process.platform, realpath = fs.realpathSync.native } = {}) {
  const keys = new Set();
  const add = (value) => {
    const key = normalizeForMatch(trimSeparator(String(value || "")), platform);
    if (key) keys.add(key);
  };
  add(path.resolve(dir));
  try {
    add(realpath(dir));
  } catch {
    // The folder does not exist yet: only the plain spelling counts.
  }
  return keys;
}

/** Whether a command line starts a browser on exactly this profile folder (not a folder inside it, not one that merely starts the same way). */
export function holdsProfile(commandLine, keys, platform = process.platform) {
  const text = normalizeForMatch(commandLine, platform);
  for (const key of keys) {
    const marker = `--user-data-dir=${key}`;
    for (let from = 0; ; ) {
      const at = text.indexOf(marker, from);
      if (at < 0) break;
      const end = at + marker.length;
      const after = text.slice(end, end + 2);
      if (after === "" || /^\s/.test(after) || (/^[\\/]/.test(after) && (after.length === 1 || /\s/.test(after[1])))) return true;
      from = end;
    }
  }
  return false;
}

/** The debugging port a command line asks for, or null. */
export function debugPortOf(commandLine) {
  const match = /--remote-debugging-port=(\d+)/.exec(String(commandLine ?? ""));
  return match ? Number(match[1]) : null;
}

/** A browser's helper processes (renderer, GPU, crash handler) carry `--type=`; the main process, which owns the profile, does not. */
export function isMainBrowserProcess(commandLine) {
  return !/(?:^|\s)--type=/.test(String(commandLine ?? ""));
}

/** "edge", "chrome", or "chromium" for a process, from its program name and path. */
export function browserKindOf({ name = "", commandLine = "" } = {}) {
  const text = `${name} ${String(commandLine).slice(0, 400)}`;
  if (/msedge|microsoft-edge|microsoft edge/i.test(text)) return "edge";
  if (/ms-playwright|chromium|headless_shell|chrome-headless-shell/i.test(text)) return "chromium";
  if (/chrome/i.test(text)) return "chrome";
  return "browser";
}

export function browserWord(kind) {
  return BROWSER_NAMES[kind] || "browser";
}

// ── Looking at the running programs ────────────────────────────────────────

const WINDOWS_QUERY =
  "[Console]::OutputEncoding=[Text.Encoding]::UTF8;" +
  "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe' OR Name='chrome.exe' OR Name='chromium.exe' OR Name='headless_shell.exe' OR Name='chrome-headless-shell.exe'\"" +
  " | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress";

function defaultExec(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, ...options }, (err, stdout) => (err ? reject(err) : resolve(String(stdout ?? ""))));
  });
}

export function parseWindowsProcesses(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows
    .filter((row) => row && Number.isInteger(row.ProcessId))
    .map((row) => ({ pid: row.ProcessId, ppid: Number.isInteger(row.ParentProcessId) ? row.ParentProcessId : null, name: String(row.Name || ""), commandLine: String(row.CommandLine || "") }));
}

export function parsePsProcesses(text) {
  const out = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match || !/--user-data-dir=/.test(match[3])) continue;
    out.push({ pid: Number(match[1]), ppid: Number(match[2]), name: path.basename(match[3].split(/\s--/)[0].trim()), commandLine: match[3] });
  }
  return out;
}

/**
 * The browser programs running now, with their command lines. Reads only; asks no special rights (a program that belongs
 * to another account, or runs with higher rights, may have no readable command line and is then not listed with one).
 * @returns {Promise<{ok: boolean, processes: object[], reason?: string}>}
 */
export async function listBrowserProcesses({ platform = process.platform, exec = defaultExec, timeoutMs = 20_000 } = {}) {
  try {
    if (platform === "win32") {
      const out = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_QUERY], { timeout: timeoutMs });
      return { ok: true, processes: parseWindowsProcesses(out) };
    }
    const out = await exec("ps", ["-axo", "pid=,ppid=,command="], { timeout: timeoutMs });
    return { ok: true, processes: parsePsProcesses(out) };
  } catch (err) {
    return { ok: false, processes: [], reason: String(err?.code || err?.message || "unreadable").slice(0, 80) };
  }
}

// ── The profile's own files ────────────────────────────────────────────────

/**
 * Whether the browser's profile lock is held right now.
 * Windows: the main process keeps "lockfile" open without sharing write access, so opening it for writing fails with a
 * sharing violation (EBUSY) while a browser holds it, and the file is gone when none does.
 * macOS and Linux: "SingletonLock" is a link named after the holder's computer and process number.
 * `held: null` means it cannot be told.
 */
export function readProfileLock(dir, { platform = process.platform, isAlive = pidIsAlive, hostname = os.hostname() } = {}) {
  if (platform === "win32") {
    try {
      fs.closeSync(fs.openSync(path.join(dir, "lockfile"), "r+"));
      return { held: false, how: "lockfile-free" };
    } catch (err) {
      if (err?.code === "ENOENT") return { held: false, how: "no-lockfile" };
      if (err?.code === "EBUSY") return { held: true, how: "lockfile-busy" };
      return { held: null, how: `lockfile-${err?.code || "unreadable"}` };
    }
  }
  try {
    const match = /^(.*)-(\d+)$/.exec(fs.readlinkSync(path.join(dir, "SingletonLock")));
    if (!match || match[1] !== hostname) return { held: null, how: "singleton-other-host" };
    return { held: isAlive(Number(match[2])), how: "singleton-lock", pid: Number(match[2]) };
  } catch (err) {
    return err?.code === "ENOENT" || err?.code === "EINVAL" ? { held: false, how: "no-singleton-lock" } : { held: null, how: `singleton-${err?.code || "unreadable"}` };
  }
}

/** The port in the profile's DevToolsActivePort file (a browser started with an automatic debugging port writes it), or null. */
export function readDevToolsPort(dir) {
  try {
    const port = Number.parseInt(String(fs.readFileSync(path.join(dir, "DevToolsActivePort"), "utf8")).split(/\r?\n/)[0], 10);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  } catch {
    return null;
  }
}

/** Whether a browser answers on a debugging port of this computer, and the address to connect to (only ever on this computer). */
export async function probeDebugPort(port, { fetchFn = globalThis.fetch, timeoutMs = 1500 } = {}) {
  if (!Number.isInteger(port) || port <= 0 || typeof fetchFn !== "function") return { answers: false };
  try {
    const response = await fetchFn(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout?.(timeoutMs) });
    if (!response?.ok) return { answers: false };
    const wsUrl = String((await response.json())?.webSocketDebuggerUrl || "");
    const parsed = new URL(wsUrl);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) || Number(parsed.port) !== port) return { answers: false, reason: "not-loopback" };
    return { answers: true, wsUrl };
  } catch {
    return { answers: false };
  }
}

/** The record the companion writes when it starts a browser on a profile: the browser's process number and debugging port. */
export function readBrowserRecord(dir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, BROWSER_RECORD_FILE), "utf8"));
    if (!Number.isInteger(raw?.pid) || raw.pid <= 0 || !Number.isInteger(raw?.port) || raw.port <= 0 || raw.port > 65535) return null;
    return { pid: raw.pid, port: raw.port, kind: ["edge", "chrome", "chromium"].includes(raw.kind) ? raw.kind : "browser", headless: raw.headless === true, inPrivate: raw.inPrivate === true, companionPid: Number.isInteger(raw.companionPid) ? raw.companionPid : null, startedAt: typeof raw.startedAt === "string" ? raw.startedAt : null };
  } catch {
    return null;
  }
}

export function writeBrowserRecord(dir, record) {
  const file = path.join(dir, BROWSER_RECORD_FILE);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify({ version: 1, ...record })}\n`, { mode: 0o600 });
    fs.renameSync(temp, file);
    return true;
  } catch {
    return false;
  }
}

/** Forget the record. With `pid`, only a record for that browser (a newer one stays). */
export function clearBrowserRecord(dir, pid = null) {
  try {
    if (pid !== null && readBrowserRecord(dir)?.pid !== pid) return false;
    fs.rmSync(path.join(dir, BROWSER_RECORD_FILE), { force: true });
    return true;
  } catch {
    return false;
  }
}

function readCompanionLock(dir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, COMPANION_LOCK_FILE), "utf8"));
    return Number.isInteger(raw?.pid) ? { pid: raw.pid } : null;
  } catch {
    return null;
  }
}

// ── Never the person's everyday browser folder ─────────────────────────────

/** Where each browser keeps the profile a person uses every day. The companion must never start a browser on one of these. */
export function defaultBrowserDataDirs({ platform = process.platform, env = process.env, homedir = os.homedir() } = {}) {
  if (platform === "win32") {
    const root = env.LOCALAPPDATA || path.join(homedir, "AppData", "Local");
    return ["Edge", "Edge Beta", "Edge Dev", "Edge SxS"].map((n) => path.win32.join(root, "Microsoft", n, "User Data")).concat(["Chrome", "Chrome Beta", "Chrome Dev", "Chrome SxS"].map((n) => path.win32.join(root, "Google", n, "User Data")), [path.win32.join(root, "Chromium", "User Data")]);
  }
  if (platform === "darwin") {
    const root = path.posix.join(homedir, "Library", "Application Support");
    return ["Microsoft Edge", "Microsoft Edge Beta", "Microsoft Edge Dev", path.posix.join("Google", "Chrome"), path.posix.join("Google", "Chrome Beta"), "Chromium"].map((n) => path.posix.join(root, n));
  }
  const root = env.XDG_CONFIG_HOME || path.posix.join(homedir, ".config");
  return ["microsoft-edge", "microsoft-edge-beta", "microsoft-edge-dev", "google-chrome", "google-chrome-beta", "google-chrome-unstable", "chromium"].map((n) => path.posix.join(root, n));
}

/** Whether a folder is, or is inside, a browser's own default data folder. */
export function isDefaultBrowserDir(dir, options = {}) {
  const platform = options.platform || process.platform;
  const resolve = platform === "win32" ? path.win32.resolve : path.posix.resolve;
  const key = trimSeparator(normalizeForMatch(resolve(dir), platform));
  for (const known of defaultBrowserDataDirs({ ...options, platform })) {
    const base = trimSeparator(normalizeForMatch(known, platform));
    if (key === base || key.startsWith(base + (platform === "win32" ? "\\" : "/"))) return true;
  }
  return false;
}

export const UNSAFE_PROFILE_MESSAGE = "That folder is where a browser keeps the profile you use every day, so the companion will not open a browser on it. Use --home with a different folder (or leave it out).";

// ── What is holding the profile? ───────────────────────────────────────────

/**
 * Look at a profile folder and say who holds it. States:
 *   free          nobody holds it
 *   ours-running  a browser this companion started earlier is still running and answers on its debugging port
 *   ours-silent   such a browser is still running but does not answer
 *   companion     another companion on this computer is using the folder
 *   other         a browser the companion cannot prove it started holds it (or something holds the lock that cannot be seen)
 * Reads only. Never ends or touches a process.
 */
export async function inspectProfile({ dir, platform = process.platform, listProcesses = listBrowserProcesses, probePort = probeDebugPort, readLock = readProfileLock, isAlive = pidIsAlive, selfPid = process.pid, trace = null } = {}) {
  // A folder that does not exist yet cannot be held by anything.
  if (!fs.existsSync(dir)) return { state: "free", holders: [], ours: null, wsUrl: null, scanned: false, lock: false, record: false };
  const keys = profilePathKeys(dir, { platform });
  const scan = await listProcesses({ platform });
  const holders = scan.ok ? scan.processes.filter((p) => isMainBrowserProcess(p.commandLine) && holdsProfile(p.commandLine, keys, platform)).map((p) => ({ pid: p.pid, kind: browserKindOf(p), port: debugPortOf(p.commandLine), commandLine: p.commandLine })) : [];
  const record = readBrowserRecord(dir);
  const lock = readLock(dir, { platform, isAlive });
  const portFile = readDevToolsPort(dir);
  const result = { state: "free", holders: holders.map(({ pid, kind, port }) => ({ pid, kind, port })), ours: null, wsUrl: null, scanned: scan.ok, lock: lock.held, record: Boolean(record) };

  // Another companion that is running now owns this folder, and so owns any browser it started: never reuse that one.
  const companion = readCompanionLock(dir);
  const otherCompanion = Boolean(companion && companion.pid !== selfPid && isAlive(companion.pid));

  // Proof the companion started it: the record names this browser's process number and debugging port, and a live process agrees.
  let proven = null;
  if (record && !otherCompanion) {
    proven = holders.find((h) => h.pid === record.pid && h.port === record.port) || null;
    if (!proven && !scan.ok && isAlive(record.pid) && lock.held === true && (await probePort(record.port)).answers) proven = { pid: record.pid, kind: record.kind, port: record.port };
    if (!proven && scan.ok) clearBrowserRecord(dir);
  }
  if (otherCompanion) {
    result.state = "companion";
  } else if (proven) {
    const probe = await probePort(record.port);
    result.ours = { ...record, kind: record.kind === "browser" ? proven.kind : record.kind };
    if (probe.answers) {
      result.state = "ours-running";
      result.wsUrl = probe.wsUrl;
    } else result.state = "ours-silent";
  } else if (holders.length) {
    result.state = "other";
  } else if (lock.held === true || (portFile && (await probePort(portFile)).answers)) {
    result.state = "other";
  }
  trace?.event("profile-inspect", { state: result.state, holders: holders.length, kinds: [...new Set(holders.map((h) => h.kind))].join(","), scanned: scan.ok, scanReason: scan.reason || null, lock: lock.how, recorded: Boolean(record) });
  return result;
}

// ── Plain-language messages ────────────────────────────────────────────────

function kindsOf(inspection, fallback) {
  const kinds = [...new Set((inspection.holders || []).map((h) => h.kind).filter((k) => k !== "browser"))];
  return kinds.length ? kinds.map(browserWord).join(" or ") : browserWord(fallback);
}

/**
 * What to tell the person when the capture browser is in use. Plain words, and it says what to do. `tail` finishes the
 * sentence "Close that window and ...": by default the job carries on by itself.
 */
export function profileBusyMessage(inspection, { kind = "edge", tail = "the job continues by itself" } = {}) {
  if (inspection.state === "ours-silent") {
    const label = browserWord(inspection.ours?.kind || kind);
    if (inspection.ours?.headless) return `A hidden ${label} that this companion started earlier is still running and is not responding. Close it in Task Manager (end the ${label} task with process number ${inspection.ours.pid}; your own browser windows are separate, leave them alone) and ${tail}. The companion does not close it for you.`;
    return `A ${label} window that this companion opened earlier is still open and is not responding. Close that window and ${tail}. The companion does not close it for you.`;
  }
  if (inspection.state === "companion") return `Another Local Capture Companion on this computer is using the capture browser. Let its capture finish, or close that companion (press Ctrl+C in its window), and ${tail}.`;
  if (inspection.holders?.length) {
    const label = kindsOf(inspection, kind);
    return `A browser window from an earlier run is still open on the capture profile. Close the ${label} window that the capture tool opened (it may be minimized or behind other windows) and ${tail}. Your own ${label} windows are not affected.`;
  }
  return `A window this computer cannot see (it may belong to another user account or run with higher rights) is using the capture browser, so it is left alone. Close any Microsoft Edge, Google Chrome, or Chromium window that the capture tool opened and ${tail}.`;
}

export function profileWaitLine(elapsedMs, waitMs) {
  return `Still waiting for the capture browser to be free (${Math.round(elapsedMs / 1000)} of ${Math.round(waitMs / 1000)} seconds). The job continues by itself as soon as it is.`;
}

/** The short sentence the portal shows for the screenshots that are waiting. */
export function profileBusyShort(inspection, { kind = "edge" } = {}) {
  if (inspection.state === "companion") return "Waiting for the browser: another companion on your computer is using it. Close that one, then select Resume.";
  const label = inspection.state === "ours-silent" ? browserWord(inspection.ours?.kind || kind) : kindsOf(inspection, kind);
  return `Waiting for the browser: a ${label} window from an earlier run is still open. Close it, then select Resume.`;
}

// ── Waiting for it ─────────────────────────────────────────────────────────

/**
 * One wait for one profile folder. `next()` returns when the folder is free to start a browser on (`{action: "launch"}`), or
 * when a browser this companion started earlier can be used again (`{action: "reuse", ours, wsUrl}`), and throws `ProfileBusyError`
 * when it is still held after `waitMs`. While it waits it says what to do once, then one short line every `statusMs`.
 * `next({ startFailed: true })` is for a start that failed because the profile was taken although nothing could be seen: it
 * waits one round before looking again.
 * `closeEarlier(ours, wsUrl)` closes a browser this companion started that cannot be used as it is (for example a hidden one
 * when a window is needed); it is only ever called with a proven one.
 */
export function createProfileWaiter({ dir, kind = "edge", headless = false, inPrivate = false, log = () => {}, trace = null, onWaiting = null, sleep = defaultSleep, now = () => Date.now(), waitMs = PROFILE_WAIT_MS, statusMs = PROFILE_STATUS_MS, pollMs = PROFILE_POLL_MS, retryGapMs = PROFILE_RETRY_GAP_MS, maxStartFailures = PROFILE_MAX_START_FAILURES, inspect = null, closeEarlier = null, platform = process.platform, listProcesses, probePort, readLock, isAlive, selfPid } = {}) {
  const look = inspect || (() => inspectProfile({ dir, platform, trace, ...(listProcesses ? { listProcesses } : {}), ...(probePort ? { probePort } : {}), ...(readLock ? { readLock } : {}), ...(isAlive ? { isAlive } : {}), ...(selfPid ? { selfPid } : {}) }));
  let startedAt = null;
  let lastStatusAt = 0;
  let told = false;
  let failures = 0;
  let notBefore = 0;
  const say = (message) => {
    log(`  ${message}`);
    onWaiting?.(message);
  };
  const busy = (blocked) => new ProfileBusyError(`The capture browser is still in use, so these screenshots did not run (they are waiting, not failed). ${profileBusyMessage(blocked, { kind, tail: "then select Resume in the portal" })}`, { state: blocked.state, short: profileBusyShort(blocked, { kind }) });
  return {
    /** Look once, without waiting: who holds the profile now. */
    inspect: look,
    async next({ startFailed = false } = {}) {
      if (startFailed) {
        // The browser said the profile is taken. Each try can open a window in the browser that has it, so a few tries a while apart, no more.
        failures += 1;
        notBefore = now() + retryGapMs;
      }
      for (;;) {
        const inspection = await look();
        if (inspection.state === "ours-running") {
          const same = inspection.ours.headless === Boolean(headless) && inspection.ours.inPrivate === Boolean(inPrivate);
          if (same) {
            trace?.event("profile-reuse", { waitedMs: startedAt === null ? 0 : now() - startedAt });
            return { action: "reuse", ours: inspection.ours, wsUrl: inspection.wsUrl };
          }
          // A browser this companion started, in a different mode (hidden when a window is needed): close it politely and look again.
          if (typeof closeEarlier === "function" && (await closeEarlier(inspection.ours, inspection.wsUrl))) continue;
          inspection.state = "ours-silent";
        }
        const at = now();
        const settling = inspection.state === "free" && at < notBefore;
        if (inspection.state === "free" && !settling) {
          if (failures >= maxStartFailures) {
            trace?.event("profile-busy-timeout", { state: "other", startFailures: failures });
            throw busy({ ...inspection, state: "other", holders: [] });
          }
          if (told) say("The capture browser is free now. Continuing.");
          return { action: "launch" };
        }
        if (startedAt === null) startedAt = at;
        const blocked = inspection.state === "free" ? { ...inspection, state: "other", holders: [] } : inspection;
        if (!told) {
          told = true;
          lastStatusAt = at;
          say(profileBusyMessage(blocked, { kind }));
          trace?.event("profile-busy", { state: blocked.state, holders: blocked.holders.length });
        } else if (at - lastStatusAt >= statusMs) {
          lastStatusAt = at;
          say(profileWaitLine(at - startedAt, waitMs));
        }
        if (at - startedAt >= waitMs) {
          trace?.event("profile-busy-timeout", { state: blocked.state, waitedMs: at - startedAt, startFailures: failures });
          throw busy(blocked);
        }
        await sleep(pollMs);
      }
    },
  };
}

/** Whether a failed browser start means "the profile is taken" (as opposed to "the browser would not start"). */
export function isProfileInUseFailure(err) {
  if (err?.code === "PROFILE_IN_USE" || err?.profileInUse === true) return true;
  return /Opening in existing browser session|profile (?:is |appears to be )?(?:already )?in use|ProcessSingleton|SingletonLock|profile directory is already in use/i.test(String(err?.message || err || ""));
}
