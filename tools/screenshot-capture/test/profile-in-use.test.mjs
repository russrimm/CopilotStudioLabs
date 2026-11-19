// A browser profile that is already in use: the companion looks BEFORE it starts a browser, says in plain words what to
// close, waits for it, reuses a browser it started itself earlier, never touches one it cannot prove it started, and keeps
// the screenshots waiting (not failed) when the browser stays busy. Hermetic except the "real browser" tests, which start
// only headless browsers on throwaway profile folders, never show a window, and skip themselves without Playwright.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveOsAccount } from "../account-source.mjs";
import { attachArgs, closeAllAttached, freeLoopbackPort, launchAttached } from "../attach.mjs";
import { profileDir, profileNamespace } from "../auth.mjs";
import { openProfile, runJob as runJobReal } from "../companion.mjs";
import { loadPlaywrightModule } from "../lab-runner.mjs";
import { createPracticeRegistry } from "../practice.mjs";
import {
  BROWSER_RECORD_FILE,
  clearBrowserRecord,
  createProfileWaiter,
  defaultBrowserDataDirs,
  holdsProfile,
  inspectProfile,
  isDefaultBrowserDir,
  isMainBrowserProcess,
  isProfileInUseFailure,
  listBrowserProcesses,
  pidIsAlive,
  probeDebugPort,
  profilePathKeys,
  readBrowserRecord,
  readProfileLock,
  writeBrowserRecord,
} from "../profile-guard.mjs";
import { createTrace } from "../trace.mjs";
import { createFakePlaywright } from "./fixtures/fake-playwright.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const TOOL_DIR = path.resolve(here, "..");
const REPO_ROOT = path.resolve(TOOL_DIR, "..", "..");
const HOLD_BROWSER = path.join(here, "fixtures", "hold-browser.mjs");
const quickAuth = { authSettleMs: 0, authPollMs: 5, authGraceMs: 0, signInWaitSec: 0.05 };
const instant = async () => {};

function tmpDir(t, prefix = "profile-in-use-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
    } catch {
      // A browser that is still shutting down can hold a file for a moment; the system's temp folder is cleaned later.
    }
  });
  return dir;
}

function collectLog() {
  const lines = [];
  const log = (message = "") => lines.push(String(message));
  log.lines = lines;
  log.text = () => lines.join("\n");
  return log;
}

/** Time that only moves when something waits, so a two-minute wait takes no time. */
function fakeClock() {
  let ms = 0;
  return { now: () => ms, sleep: async (n) => { ms += n; }, get ms() { return ms; } };
}

/** Pretend portal: records what the companion reports. */
function recordingClient() {
  const calls = { progress: [], uploads: [], completes: [] };
  return {
    calls,
    async heartbeat() {
      return {};
    },
    async progress(_id, body) {
      calls.progress.push(body);
      return { ok: true };
    },
    async upload(_id, filename) {
      calls.uploads.push(filename);
      return { status: 200, body: { outcome: "accepted" } };
    },
    async complete(_id, body) {
      calls.completes.push(body);
      return {};
    },
    final() {
      const out = {};
      for (const entry of calls.progress) if (entry.shot) out[entry.shot.filename] = entry.shot;
      return out;
    },
  };
}

const planShot = (filename) => ({
  filename,
  shotId: filename,
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
    { action: "stepThrough", labels: ["Settings"], instruction: "Select **Settings**.", interaction: "click-or-focus" },
    { action: "probeCallouts", callouts: [{ n: 1, label: "Memory", text: "Memory" }] },
    { action: "screenshot", fullPage: false },
  ],
});

const claimedJob = (shots) => ({ job: { id: "job_0123456789abcdef", target: { type: "lab", labId: "lab-a" }, scope: {}, options: { callouts: "sidecar", redact: true }, createdAt: "2026-01-01T00:00:00Z", resumed: false }, env: {}, shots });

/** Replace process.kill for one test: only "is it alive" checks pass through; any real signal is recorded and refused. */
function watchKills(t) {
  const real = process.kill;
  const sent = [];
  process.kill = (pid, signal) => {
    if (signal === 0) return real.call(process, pid, 0);
    sent.push([pid, signal]);
    return true;
  };
  t.after(() => {
    process.kill = real;
  });
  return sent;
}

// ── A pretend browser that holds the profile ─────────────────────────────────

const HOLDER_PID = 4_242_424;
const holderCommand = (dir, port) => `"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" --remote-debugging-port=${port} --user-data-dir="${dir}" --no-first-run about:blank`;

/** A fake program that holds a profile until `freeAtMs` on the fake clock. Everything the guard reads about it is pretend. */
function fakeHolder({ dir, clock, freeAtMs = Infinity, port = 51_111 }) {
  const running = () => clock.now() < freeAtMs;
  return {
    port,
    listProcesses: async () => ({
      ok: true,
      processes: running()
        ? [
            { pid: HOLDER_PID, ppid: 1, name: "msedge.exe", commandLine: holderCommand(dir, port) },
            { pid: HOLDER_PID + 1, ppid: HOLDER_PID, name: "msedge.exe", commandLine: `"C:\\x\\msedge.exe" --type=renderer --user-data-dir="${dir}" --lang=en-US` },
          ]
        : [],
    }),
    readLock: () => ({ held: running(), how: "fake" }),
    isAlive: (pid) => (pid === HOLDER_PID ? running() : pidIsAlive(pid)),
    probePort: async () => ({ answers: false }),
  };
}

const waitOptions = (clock, holder, extra = {}) => ({ listProcesses: holder.listProcesses, readLock: holder.readLock, isAlive: holder.isAlive, probePort: holder.probePort, sleep: clock.sleep, now: clock.now, waitMs: 120_000, statusMs: 15_000, pollMs: 5000, ...extra });

const JARGON = /existing browser session|Chromium instance|launchPersistentContext|browserType\.|Call log|ProcessSingleton/i;

// ── The wait and the plain-language messages ─────────────────────────────────

test("a browser this companion started earlier that does not answer: the job says what to close, waits, and carries on by itself when it is gone", async (t) => {
  const home = tmpDir(t);
  const dir = profileDir(home, "chromium", "copilot-studio", "");
  fs.mkdirSync(dir, { recursive: true });
  const clock = fakeClock();
  const holder = fakeHolder({ dir, clock, freeAtMs: 40_000 });
  // The proof it was started here: the record the launcher wrote (its process number and debugging port).
  writeBrowserRecord(dir, { pid: HOLDER_PID, port: holder.port, kind: "edge", headless: false, inPrivate: false, companionPid: 1, startedAt: "2026-01-01T00:00:00Z" });
  const kills = watchKills(t);
  const client = recordingClient();
  const log = collectLog();
  const fake = createFakePlaywright();

  const result = await runJobReal({ client, claimed: claimedJob([planShot("a.png")]), home, playwright: fake.playwright, options: { ...quickAuth, browserKinds: ["chromium"], profileWait: waitOptions(clock, holder) }, log, sleepFn: instant, heartbeatMs: 60_000 });

  const text = log.text();
  assert.match(text, /A Microsoft Edge window that this companion opened earlier is still open and is not responding\. Close that window and the job continues by itself\. The companion does not close it for you\./);
  assert.equal(text.match(/Still waiting for the capture browser to be free \(15 of 120 seconds\)/g)?.length, 1, "a status line every 15 seconds");
  assert.equal(text.match(/Still waiting for the capture browser to be free \(30 of 120 seconds\)/g)?.length, 1);
  assert.doesNotMatch(text, /Still waiting .*\(45 of 120/, "it stopped waiting once the window was gone");
  assert.match(text, /The capture browser is free now\. Continuing\./);
  assert.equal(result.tally.captured, 1, "the job carried on and captured");
  assert.equal(result.tally.failed, 0);
  assert.equal(fake.log.launched.length, 1, "one browser was started, after the wait");
  assert.deepEqual(kills, [], "nothing was ended by the companion");
  assert.doesNotMatch(text, JARGON);
  assert.ok(client.calls.progress.some((p) => /not responding/.test(p.message || "")), "the portal's live progress says what the computer is waiting for");
});

test("a browser the companion cannot prove it started is never touched: plain instructions, the shots wait instead of failing, and nothing is used up", async (t) => {
  const home = tmpDir(t);
  const dir = profileDir(home, "chromium", "copilot-studio", "");
  fs.mkdirSync(dir, { recursive: true });
  const clock = fakeClock();
  const holder = fakeHolder({ dir, clock });
  const kills = watchKills(t);
  // A practice agent already exists, and its one-time publish permission has not been used.
  const registryFile = path.join(home, ".practice-agents.json");
  fs.writeFileSync(registryFile, `${JSON.stringify({ schema: 2, agents: [{ botId: "bot-fake-1", envId: "env-fake-1", name: "Lab screenshots - Demo", stages: {} }], changes: [], pending: [] }, null, 2)}\n`);
  const before = fs.readFileSync(registryFile);
  const client = recordingClient();
  const log = collectLog();
  const fake = createFakePlaywright();

  const result = await runJobReal({ client, claimed: claimedJob([planShot("a.png"), planShot("b.png")]), home, playwright: fake.playwright, options: { ...quickAuth, browserKinds: ["chromium"], profileWait: waitOptions(clock, holder), localOptIn: true }, log, sleepFn: instant, heartbeatMs: 60_000 });

  const text = log.text();
  assert.match(text, /A browser window from an earlier run is still open on the capture profile\. Close the Microsoft Edge window that the capture tool opened \(it may be minimized or behind other windows\) and the job continues by itself\. Your own Microsoft Edge windows are not affected\./);
  assert.match(text, /The capture browser is still in use, so these screenshots did not run \(they are waiting, not failed\)\./);
  assert.ok((text.match(/Still waiting for the capture browser to be free/g) || []).length >= 6, "a status line every 15 seconds for the whole two minutes");
  assert.doesNotMatch(text, JARGON);
  assert.doesNotMatch(text, /automation launcher|managed browser/, "no fallback, no misleading sentence");

  assert.equal(fake.log.launched.length, 0, "no browser was started on a profile that is in use");
  assert.deepEqual(kills, [], "the companion never ends a browser it cannot prove it started");
  assert.equal(result.tally.failed, 0, "nothing failed");
  assert.equal(result.tally.paused, 2);
  assert.equal(result.paused.reason, "browser-busy");
  const final = client.final();
  assert.ok(!Object.values(final).some((s) => ["failed", "auth-required", "skipped"].includes(s.status)), "no shot was reported as failed");
  assert.match(text, /Job finished: 0 captured, 0 saved for review, 0 failed, 0 not run, 2 waiting for the browser\./);
  const complete = client.calls.completes[0];
  assert.equal(complete.paused.reason, "browser-busy");
  assert.match(complete.paused.message, /^Waiting for the browser: a Microsoft Edge window from an earlier run is still open\. Close it, then select Resume\./);

  // Nothing was consumed: the practice records are byte for byte what they were, and the publish permission is still unused.
  assert.deepEqual(fs.readFileSync(registryFile), before);
  assert.equal(createPracticeRegistry(home).onceClaimed("bot-fake-1", "publish"), false);
  assert.equal(createPracticeRegistry(home).claimOnce("bot-fake-1", "publish"), true, "the one-time claim is still there to be used by the retry");
});

test("a start that finds the profile taken is not retried with the automation launcher; the person gets plain words and the raw text stays in the trace", async (t) => {
  const home = tmpDir(t);
  const clock = fakeClock();
  const wait = { listProcesses: async () => ({ ok: true, processes: [] }), readLock: () => ({ held: false, how: "fake" }), sleep: clock.sleep, now: clock.now, waitMs: 120_000, statusMs: 15_000, pollMs: 5000 };

  // 1. The normal start exits with the code a browser uses for "the profile is in use", and nothing is visible on the computer.
  const world = fakeBrowserWorld({ exitCode: 21 });
  const log = collectLog();
  await assert.rejects(
    openProfile({ playwright: world.playwright, home, profile: "copilot-studio", kinds: ["chrome"], log, installed: { chrome: "C:\\chrome.exe" }, attachOptions: world.options, profileWait: wait }),
    (err) => err.code === "PROFILE_BUSY" && /A window this computer cannot see/.test(err.message) && /select Resume in the portal/.test(err.message),
  );
  assert.equal(world.launches.length, 0, "the automation launcher was never tried");
  assert.equal(world.spawned.length, 3, "a few tries, a while apart, no more (each can open a window in the browser that has the profile)");
  assert.doesNotMatch(log.text(), /automation launcher|managed browser/);
  assert.match(log.text(), /A window this computer cannot see \(it may belong to another user account or run with higher rights\) is using the capture browser, so it is left alone\./);
  assert.match(log.text(), /Close any Microsoft Edge, Google Chrome, or Chromium window that the capture tool opened and the job continues by itself\./);
  assert.doesNotMatch(log.text(), JARGON);

  // 2. The automation launcher itself says "Opening in existing browser session": the same plain message, the raw words in the trace only.
  const clock2 = fakeClock();
  const trace = createTrace({ file: null });
  const raw = new Error("browserType.launchPersistentContext: Opening in existing browser session.\nCall log:\n  - <launching> msedge");
  const playwright = { chromium: { async launchPersistentContext() { throw raw; } } };
  const log2 = collectLog();
  await assert.rejects(
    openProfile({ playwright, home, profile: "copilot-studio", kinds: ["chromium"], log: log2, trace, profileWait: { ...wait, sleep: clock2.sleep, now: clock2.now } }),
    (err) => err.code === "PROFILE_BUSY" && !JARGON.test(err.message),
  );
  assert.doesNotMatch(log2.text(), JARGON);
  assert.match(trace.lines.join("\n"), /Opening in existing browser session/, "the raw text is kept in the trace");
  assert.equal(isProfileInUseFailure(raw), true);
  assert.equal(isProfileInUseFailure(new Error("spawn EACCES")), false);
});

test("the 'managed browser' sentence is shown only on a PC that has a work account, and the fallback still works when the normal start cannot listen on a debugging port", async (t) => {
  const home = tmpDir(t);
  const clock = fakeClock();
  const wait = { listProcesses: async () => ({ ok: true, processes: [] }), readLock: () => ({ held: false }), sleep: clock.sleep, now: clock.now };
  const run = async (osWorkAccount) => {
    const world = fakeBrowserWorld({ spawnFails: true });
    const log = collectLog();
    const opened = await openProfile({ playwright: world.playwright, home, profile: "copilot-studio", kinds: ["chrome"], log, installed: { chrome: "C:\\chrome.exe" }, attachOptions: world.options, account: { mode: "separate", explicitMode: false, os: { osWorkAccount } }, profileWait: wait });
    assert.equal(opened.launch, "playwright");
    return log.text();
  };
  const plain = await run(false);
  assert.match(plain, /Google Chrome could not be started the normal way .*Opening it with the automation launcher instead\./);
  assert.doesNotMatch(plain, /managed browser/, "a PC without a work account has nothing managed to warn about");
  assert.match(await run(true), /Opening it with the automation launcher instead\. If your organization needs a managed browser, sign-in may not work\./);
});

test("the browser the companion starts is written down and taken away again, on a normal close and on the way out", async (t) => {
  const home = tmpDir(t);
  const dir = path.join(home, "profile");
  const world = fakeBrowserWorld({ stays: true });
  const opened = await launchAttached({ playwright: world.playwright, kind: "edge", dir, executable: "C:\\edge.exe", ...world.options });
  const record = readBrowserRecord(dir);
  assert.equal(record.pid, world.spawned[0].child.pid);
  assert.equal(record.port, opened.port);
  assert.equal(record.kind, "edge");
  assert.equal(record.companionPid, process.pid);
  await opened.context.close();
  assert.equal(readBrowserRecord(dir), null, "the record is cleared when the browser is closed");

  // The way out (Ctrl+C, a crash, a closed console): the browser is ended and the record goes with it.
  const second = fakeBrowserWorld({ stays: true });
  await launchAttached({ playwright: second.playwright, kind: "edge", dir, executable: "C:\\edge.exe", ...second.options });
  assert.ok(readBrowserRecord(dir));
  await closeAllAttached();
  assert.equal(second.spawned[0].killed, true, "the browser this companion started is ended");
  assert.equal(readBrowserRecord(dir), null);
  assert.ok(!fs.existsSync(path.join(dir, BROWSER_RECORD_FILE)));
});

test("a work account that cannot be read this time does not send the capture to the shared sign-in", (t) => {
  const home = tmpDir(t);
  fs.mkdirSync(path.join(home, ".auth", "separate", "chromium", "copilot-studio"), { recursive: true });
  const unknown = { known: false, osWorkAccount: null };
  const tries = [];
  const log = collectLog();
  const found = resolveOsAccount({ home, platform: "win32", read: (options) => (tries.push(options?.timeoutMs ?? 8000), unknown), log });
  assert.deepEqual(tries, [8000, 30_000], "a slow answer is given a second, longer try first");
  assert.equal(found.osWorkAccount, true, "a separate sign-in exists, so this PC has a work account");
  assert.equal(profileNamespace({ mode: "separate", osWorkAccount: found.osWorkAccount }), "separate");
  assert.match(log.text(), /would not say whether it has a Windows work account/);

  // A good reading is remembered (the yes or no only), and a later bad one uses it.
  const other = tmpDir(t);
  assert.equal(resolveOsAccount({ home: other, platform: "win32", read: () => ({ known: true, osWorkAccount: true }) }).osWorkAccount, true);
  assert.equal(resolveOsAccount({ home: other, platform: "win32", read: () => unknown, log: collectLog() }).osWorkAccount, true);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(other, ".companion-os-account.json"), "utf8"))).sort(), ["checkedAt", "osWorkAccount", "version"]);
  // Nothing to go on: unchanged. Other systems: one reading, no guessing.
  assert.equal(resolveOsAccount({ home: tmpDir(t), platform: "win32", read: () => unknown }).osWorkAccount, null);
  let reads = 0;
  resolveOsAccount({ home: tmpDir(t), platform: "linux", read: () => (reads += 1, unknown) });
  assert.equal(reads, 1);
});

test("a browser that belongs to another companion that is running now is never taken over", async (t) => {
  const home = tmpDir(t);
  const dir = profileDir(home, "chromium", "copilot-studio", "");
  fs.mkdirSync(dir, { recursive: true });
  const clock = fakeClock();
  const holder = fakeHolder({ dir, clock });
  const OTHER_COMPANION = 3_141_592;
  writeBrowserRecord(dir, { pid: HOLDER_PID, port: holder.port, kind: "edge", headless: false, inPrivate: false, companionPid: OTHER_COMPANION, startedAt: "2026-01-01T00:00:00Z" });
  fs.writeFileSync(path.join(dir, ".companion-lock.json"), JSON.stringify({ pid: OTHER_COMPANION }));
  const options = { dir, listProcesses: holder.listProcesses, readLock: holder.readLock, isAlive: (pid) => pid === OTHER_COMPANION || holder.isAlive(pid), probePort: async () => ({ answers: true, wsUrl: `ws://127.0.0.1:${holder.port}/devtools/browser/x` }) };
  const seen = await inspectProfile(options);
  assert.equal(seen.state, "companion", "it answers on its port, and it is still not ours to use");
  assert.ok(readBrowserRecord(dir), "its record is left alone");
  const log = collectLog();
  const waiter = createProfileWaiter({ ...options, kind: "edge", log, sleep: clock.sleep, now: clock.now, waitMs: 30_000, statusMs: 15_000, pollMs: 5000 });
  await assert.rejects(waiter.next(), (err) => err.code === "PROFILE_BUSY" && err.state === "companion");
  assert.match(log.text(), /Another Local Capture Companion on this computer is using the capture browser\. Let its capture finish, or close that companion \(press Ctrl\+C in its window\), and the job continues by itself\./);
});

test("the companion never opens a browser on the folder a person's own browser uses, and reads command lines exactly", async (t) => {
  const everyday = defaultBrowserDataDirs()[0];
  assert.equal(isDefaultBrowserDir(everyday), true);
  assert.equal(isDefaultBrowserDir(path.join(everyday, "Default")), true);
  assert.equal(isDefaultBrowserDir(path.join(os.tmpdir(), "capture", ".auth", "edge", "copilot-studio")), false);
  assert.equal(isDefaultBrowserDir("C:\\Users\\Ada\\AppData\\Local\\Microsoft\\Edge\\User Data\\Profile 1", { platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local" } }), true);
  assert.equal(isDefaultBrowserDir("C:\\Users\\Ada\\AppData\\Local\\CopilotStudioLabsCompanion\\.auth\\edge\\copilot-studio", { platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local" } }), false);
  const watching = watchKills(t);
  await assert.rejects(openProfile({ playwright: createFakePlaywright().playwright, home: everyday, profile: "copilot-studio", kinds: ["chromium"], log: collectLog() }), (err) => err.code === "UNSAFE_PROFILE" && /where a browser keeps the profile you use every day/.test(err.message));
  assert.deepEqual(watching, []);

  const dir = path.join(os.tmpdir(), "Capture Home", ".auth", "edge", "copilot-studio");
  const keys = profilePathKeys(dir);
  assert.equal(holdsProfile(`"C:\\edge.exe" --user-data-dir="${dir}" --no-first-run`, keys), true, "a quoted folder with a space in it");
  assert.equal(holdsProfile(`"C:\\edge.exe" "--user-data-dir=${dir}"`, keys), true);
  assert.equal(holdsProfile(`msedge --user-data-dir=${dir}${path.sep} about:blank`, keys), true, "a trailing separator");
  assert.equal(holdsProfile(`msedge --user-data-dir=${dir}-two --no-first-run`, keys), false, "a different folder that starts the same way");
  assert.equal(holdsProfile(`msedge --user-data-dir=${path.join(dir, "Default")}`, keys), false, "a folder inside it");
  assert.equal(holdsProfile("msedge --no-first-run", keys), false, "the person's own browser has no such switch");
  assert.equal(isMainBrowserProcess("msedge --user-data-dir=x"), true);
  assert.equal(isMainBrowserProcess("msedge --type=renderer --user-data-dir=x"), false);
});

// ── Real headless browsers on throwaway profiles ─────────────────────────────

let playwright = null;
try {
  playwright = await loadPlaywrightModule(REPO_ROOT);
} catch {
  playwright = null;
}
const chromiumPath = (() => {
  try {
    const file = playwright?.chromium?.executablePath?.();
    return file && fs.existsSync(file) ? file : null;
  } catch {
    return null;
  }
})();
const skip = !chromiumPath && "Playwright with Chromium is not installed";

async function waitUntil(check, ms = 30_000, step = 200) {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, step));
  }
  return false;
}

/** End only the browser programs whose command line names this throwaway folder. */
async function endBrowsersOn(dir) {
  const keys = profilePathKeys(dir);
  const { processes } = await listBrowserProcesses();
  for (const p of processes) {
    if (!holdsProfile(p.commandLine, keys)) continue;
    try {
      process.kill(p.pid);
    } catch {
      // Already gone.
    }
  }
}

function readReady(child, ms = 60_000) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("The helper browser did not start in time.")), ms);
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const line = buffer.split("\n").find((l) => l.startsWith("{"));
      if (line) {
        clearTimeout(timer);
        resolve(JSON.parse(line));
      }
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("The helper exited before the browser was ready."));
    });
  });
}

test("real browser: a browser the companion started and left behind is used again; one it cannot prove it started is never touched", { skip, timeout: 240_000 }, async (t) => {
  const home = tmpDir(t);
  const dir = profileDir(home, "chrome", "copilot-studio", "");
  fs.mkdirSync(dir, { recursive: true });
  t.after(() => endBrowsersOn(dir));

  // Play the earlier companion that crashed: start a headless browser the way the launcher does, detached, and write its record.
  const port = await freeLoopbackPort();
  const child = spawn(chromiumPath, attachArgs({ dir, port, headless: true }), { stdio: "ignore", detached: true, windowsHide: true });
  child.unref();
  assert.ok(Number.isInteger(child.pid));
  writeBrowserRecord(dir, { pid: child.pid, port, kind: "chrome", headless: true, inPrivate: false, companionPid: 1, startedAt: new Date().toISOString() });
  assert.ok(await waitUntil(async () => (await probeDebugPort(port)).answers, 60_000), "the browser answers on its debugging port");

  // The real checks, with no special rights: the lock is held, the command line names the folder, the record proves it.
  assert.equal(readProfileLock(dir).held, true, "the browser's own lock on the profile is held");
  const first = await inspectProfile({ dir });
  assert.equal(first.state, "ours-running");
  assert.equal(first.ours.pid, child.pid);
  assert.ok(first.scanned && first.holders.some((h) => h.pid === child.pid));
  assert.match(first.wsUrl, /^ws:\/\/127\.0\.0\.1:\d+\//);

  // Without the proof it is somebody else's browser: seen, named, waited for, and never touched.
  const record = readBrowserRecord(dir);
  clearBrowserRecord(dir);
  const unknown = await inspectProfile({ dir });
  assert.equal(unknown.state, "other");
  assert.equal(unknown.holders[0].pid, child.pid);
  const clock = fakeClock();
  const log = collectLog();
  const waiter = createProfileWaiter({ dir, kind: "chrome", headless: true, log, sleep: clock.sleep, now: clock.now, waitMs: 4000, statusMs: 2000, pollMs: 2000 });
  await assert.rejects(waiter.next(), (err) => err.code === "PROFILE_BUSY" && /still in use/.test(err.message));
  assert.match(log.text(), /A browser window from an earlier run is still open on the capture profile/);
  assert.equal(pidIsAlive(child.pid), true, "the browser was not touched");

  // With the proof back, openProfile connects to it instead of starting another.
  writeBrowserRecord(dir, record);
  const log2 = collectLog();
  const opened = await openProfile({ playwright, home, profile: "copilot-studio", kinds: ["chrome"], headless: true, log: log2, installed: { chrome: chromiumPath } });
  assert.equal(opened.launch, "attach");
  assert.equal(opened.context.companionPid, child.pid, "the same browser, not a new one");
  assert.match(log2.text(), /Reconnected to the Google Chrome window that this companion opened earlier/);
  const page = opened.context.pages()[0] || (await opened.context.newPage());
  assert.equal(await page.evaluate(() => 1 + 1), 2, "the page of the earlier browser works");
  await opened.context.close();
  assert.ok(await waitUntil(() => !pidIsAlive(child.pid), 30_000), "closing it asked the browser to quit, and it did");
  assert.equal((await inspectProfile({ dir })).state, "free", "nothing holds the profile any more");
  assert.equal(readBrowserRecord(dir), null, "the record is cleared");
  await closeAllAttached();
});

test("real browser: a normal exit and a crash do not leave the browser the companion started behind", { skip, timeout: 240_000 }, async (t) => {
  for (const mode of ["exit", "crash"]) {
    const home = tmpDir(t);
    const dir = profileDir(home, "chrome", "copilot-studio", "");
    t.after(() => endBrowsersOn(dir));
    const helper = spawn(process.execPath, [HOLD_BROWSER, dir, mode], { stdio: ["ignore", "pipe", "ignore"] });
    const started = await readReady(helper);
    assert.ok(Number.isInteger(started.pid) && started.port > 0, `${mode}: the helper started a browser`);
    assert.equal(readBrowserRecord(dir)?.pid, started.pid, `${mode}: the browser was written down`);
    await new Promise((resolve) => helper.once("exit", resolve));
    assert.ok(await waitUntil(() => !pidIsAlive(started.pid), 30_000), `${mode}: the browser is gone after the companion left`);
    assert.equal(readBrowserRecord(dir), null, `${mode}: the record is gone too`);
  }
});

// ── A fake browser program for the launcher ──────────────────────────────────

function fakeBrowserWorld({ exitCode = null, spawnFails = false, stays = false } = {}) {
  const spawned = [];
  const launches = [];
  let nextPort = 52_000;
  let nextPid = 900_001;
  const spawnFn = () => {
    if (spawnFails) throw new Error("spawn EACCES");
    const child = new EventEmitter();
    child.pid = (nextPid += 1);
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      child.emit("exit", 0, null);
      return true;
    };
    spawned.push({ child, get killed() { return child.killed; } });
    if (!stays) Promise.resolve().then(() => child.emit("exit", exitCode, null));
    return child;
  };
  const makeContext = () => ({ pages: () => [], async newPage() { return { url: () => "about:blank" }; }, async addCookies() {}, async storageState() { return { cookies: [], origins: [] }; } });
  const playwright = {
    chromium: {
      async connectOverCDP() {
        const context = makeContext();
        return {
          contexts: () => [context],
          on() {},
          async close() {},
          async newBrowserCDPSession() {
            return { async send() { spawned.at(-1)?.child.emit("exit", 0, null); } };
          },
        };
      },
      async launchPersistentContext(dir, options) {
        launches.push({ dir, options });
        return makeContext();
      },
    },
  };
  return { spawned, launches, playwright, options: { spawnFn, fetchFn: async (url) => (stays ? { ok: true, json: async () => ({ webSocketDebuggerUrl: `ws://127.0.0.1:${new URL(url).port}/devtools/browser/abc` }) } : Promise.reject(new Error("connection refused"))), portFn: async () => (nextPort += 1), sleep: instant, timeoutMs: 600, pollMs: 100, exitWaitMs: 200 } };
}
