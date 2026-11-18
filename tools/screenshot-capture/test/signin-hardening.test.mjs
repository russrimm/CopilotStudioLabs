// Sign-in hardening: where the companion keeps its data, how it starts the browser, and how it behaves while a
// person signs in (it only watches), plus the diagnosis when a sign-in loops. Everything here is hermetic: fake
// browsers, fake pages with a virtual clock, and temporary folders.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { acquireProfileLock, AttachError, attachArgs, closeAllAttached, freeLoopbackPort, launchAttached, LOCK_FILE, parseLaunchChoice, settleTabs, wantsAttach } from "../attach.mjs";
import { createAuthGate } from "../auth.mjs";
import { cleanCookieName, cookiePresence, describeHops, measureClockSkew, readCookieSettings, runCheckSignIn, windowsDeviceState } from "../check-signin.mjs";
import { COMPANION_VERSION, EXIT, openProfile, parseArgs, runCompanion, runJob, helpText } from "../companion.mjs";
import { deleteOldSignIn, describeHomeState, detectSyncedFolder, localDataHome, migrateLegacyHome, resolveHome, syncedHomeMessage } from "../home.mjs";
import { gotoWithRetry, navigateWithSignIn } from "../lifecycle.mjs";
import { aadstsFromUrl, createPingPongDetector, diagnoseSignIn, extractAadstsCode, readAadstsCode, signInReport } from "../signin-diagnosis.mjs";
import { classifyUrl, cleanPathForReport, cleanPathSegment, maskTenantHost, redactedAddress } from "../signin-url.mjs";
import { createSurfaceWatch, describeNativeSnapshot, describeSurface } from "../surface-watch.mjs";
import { createTrace } from "../trace.mjs";
import { createFakePlaywright } from "./fixtures/fake-playwright.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const TOOL_DIR = path.resolve(here, "..");
const TOKEN = "cap_FAKE_TOKEN_FOR_TESTS_0123456789abcdefghij";
const APP = "https://copilotstudio.microsoft.com/";
const LOGIN = "https://login.microsoftonline.com/common/oauth2/authorize?client_id=x";
const instant = async () => {};

function tmpDir(t, prefix = "hardening-") {
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

// ── Where the data lives ─────────────────────────────────────────────────────

test("the default data folder is local to the user account on every operating system", () => {
  assert.equal(localDataHome({ platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local" }, homedir: "C:\\Users\\Ada" }), "C:\\Users\\Ada\\AppData\\Local\\CopilotStudioLabsCompanion");
  assert.equal(localDataHome({ platform: "win32", env: {}, homedir: "C:\\Users\\Ada" }), "C:\\Users\\Ada\\AppData\\Local\\CopilotStudioLabsCompanion");
  assert.equal(localDataHome({ platform: "darwin", env: {}, homedir: "/Users/ada" }), "/Users/ada/Library/Application Support/CopilotStudioLabsCompanion");
  assert.equal(localDataHome({ platform: "linux", env: { XDG_DATA_HOME: "/data/x" }, homedir: "/home/ada" }), "/data/x/copilot-studio-labs-companion");
  assert.equal(localDataHome({ platform: "linux", env: {}, homedir: "/home/ada" }), "/home/ada/.local/share/copilot-studio-labs-companion");
});

test("synced folders are recognized: OneDrive, Dropbox, iCloud Drive, Google Drive, by path, environment variable, and Windows attributes", () => {
  const cases = [
    ["win32", "C:\\Users\\Ada\\OneDrive - Microsoft\\Documents\\copilot-studio-labs-capture-companion\\capture-companion\\tools\\screenshot-capture", {}, "OneDrive"],
    ["win32", "C:\\Users\\Ada\\OneDrive\\Desktop\\x", {}, "OneDrive"],
    ["win32", "C:\\Users\\Ada\\OneDrive-Contoso\\x", {}, "OneDrive"],
    ["win32", "D:\\Sync\\Work\\data", { OneDriveCommercial: "D:\\Sync\\Work" }, "OneDrive"],
    ["win32", "d:\\sync\\work\\data", { OneDrive: "D:\\Sync\\Work" }, "OneDrive"],
    ["win32", "C:\\Users\\Ada\\Dropbox (Personal)\\x", {}, "Dropbox"],
    ["win32", "C:\\Users\\Ada\\Dropbox\\x", {}, "Dropbox"],
    ["win32", "G:\\My Drive\\x", {}, "Google Drive"],
    ["win32", "C:\\Users\\Ada\\Google Drive\\x", {}, "Google Drive"],
    ["win32", "C:\\Users\\Ada\\iCloudDrive\\x", {}, "iCloud Drive"],
    ["darwin", "/Users/ada/Library/Mobile Documents/com~apple~CloudDocs/x", {}, "iCloud Drive"],
    ["darwin", "/Users/ada/Library/CloudStorage/OneDrive-Contoso/x", {}, "OneDrive"],
    ["darwin", "/Users/ada/Library/CloudStorage/GoogleDrive-ada@contoso.com/My Drive/x", {}, "Google Drive"],
    ["linux", "/home/ada/Dropbox/x", {}, "Dropbox"],
  ];
  for (const [platform, target, env, provider] of cases) {
    const found = detectSyncedFolder(target, { platform, env, attributesOf: () => [] });
    assert.equal(found.synced, true, `${target} is synced`);
    assert.equal(found.provider, provider, target);
  }
  for (const [platform, target] of [
    ["win32", "C:\\Users\\Ada\\AppData\\Local\\CopilotStudioLabsCompanion"],
    ["win32", "D:\\repos\\tool"],
    ["darwin", "/Users/ada/Library/Application Support/CopilotStudioLabsCompanion"],
    ["linux", "/home/ada/.local/share/copilot-studio-labs-companion"],
    ["win32", "C:\\Users\\Ada\\Documents\\Boxes of things"],
  ]) {
    assert.equal(detectSyncedFolder(target, { platform, env: {}, attributesOf: () => [] }).synced, false, `${target} is local`);
  }
  // Windows reports OneDrive Files On-Demand folders as read-only reparse points; a plain junction is not synced.
  const attributes = (value) => () => [{ path: "C:\\Data", attributes: value }];
  assert.equal(detectSyncedFolder("C:\\Data\\home", { platform: "win32", env: {}, attributesOf: attributes("ReadOnly, Directory, Archive, ReparsePoint") }).synced, true);
  assert.equal(detectSyncedFolder("C:\\Data\\home", { platform: "win32", env: {}, attributesOf: attributes("Directory, ReparsePoint, Offline") }).synced, true);
  assert.equal(detectSyncedFolder("C:\\Data\\home", { platform: "win32", env: {}, attributesOf: attributes("Directory, ReparsePoint") }).synced, false, "a plain junction is not a sync folder");
  assert.equal(detectSyncedFolder("C:\\Data\\home", { platform: "win32", env: {}, attributesOf: attributes("ReadOnly, Directory") }).synced, false);
});

test("an explicit or environment home in a synced folder is refused unless --allow-synced-home is given, and the message gives the exact local command", () => {
  const platform = process.platform;
  const base = { platform, env: {}, homedir: os.homedir(), attributesOf: () => [] };
  const synced = path.join(os.tmpdir(), "OneDrive - Contoso", "data");
  const refused = resolveHome({ ...base, explicit: synced, codeDir: TOOL_DIR, exists: () => false });
  assert.equal(refused.refused, true);
  assert.equal(refused.source, "option");
  const message = syncedHomeMessage(refused, { platform });
  assert.match(message, /inside OneDrive/);
  assert.ok(message.includes(`--home=${platform === "win32" ? `"${refused.defaultDir}"` : `'${refused.defaultDir}'`}`), "the exact command with the local folder");
  assert.match(message, /--allow-synced-home/);
  assert.equal(resolveHome({ ...base, explicit: synced, allowSynced: true, codeDir: TOOL_DIR, exists: () => false }).refused, false);
  assert.equal(resolveHome({ ...base, envHome: synced, codeDir: TOOL_DIR, exists: () => false }).source, "environment");
  assert.equal(resolveHome({ ...base, envHome: synced, codeDir: TOOL_DIR, exists: () => false }).refused, true);
  const fallback = resolveHome({ ...base, codeDir: TOOL_DIR, exists: () => false });
  assert.equal(fallback.source, "default");
  assert.equal(fallback.home, fallback.defaultDir);
  assert.equal(fallback.refused, false);
  assert.match(describeHomeState(refused).join("\n"), /Warning: this folder is inside OneDrive/);
  assert.match(describeHomeState(fallback).join("\n"), /local, not synced/);
});

test("data an older version kept beside the code is found, and only the default home looks for it", () => {
  const base = { platform: process.platform, env: {}, homedir: os.homedir(), attributesOf: () => [] };
  const code = path.join(os.tmpdir(), "OneDrive - Microsoft", "companion", "tools", "screenshot-capture");
  const exists = (file) => file === path.join(code, ".companion.json") || file === path.join(code, ".auth");
  const found = resolveHome({ ...base, codeDir: code, exists });
  assert.equal(found.legacy.dir, code);
  assert.equal(found.legacy.hasPairing, true);
  assert.equal(found.legacy.hasProfiles, true);
  assert.equal(found.legacy.synced.synced, true, "the old folder is in OneDrive");
  assert.equal(resolveHome({ ...base, explicit: path.join(os.tmpdir(), "mine"), codeDir: code, exists }).legacy, null, "a folder the person chose is never migrated");
});

test("moving old data: the pairing moves out of a synced folder, a browser profile is never copied, and the sign-in advice names the delete command", (t) => {
  const root = tmpDir(t);
  const makeLegacy = (name) => {
    const dir = path.join(root, name);
    fs.mkdirSync(path.join(dir, ".auth", "edge", "copilot-studio", "Default"), { recursive: true });
    fs.mkdirSync(path.join(dir, ".recipes"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".companion.json"), JSON.stringify({ portal: "http://127.0.0.1:9", token: TOKEN }));
    fs.writeFileSync(path.join(dir, ".recipes", "recipes.json"), "{}");
    fs.writeFileSync(path.join(dir, ".auth", "edge", "copilot-studio", "Default", "Cookies"), "locked database");
    fs.writeFileSync(path.join(dir, ".auth", "edge", "copilot-studio", "companion-session.json"), JSON.stringify({ cookies: [] }));
    return dir;
  };

  const syncedLegacy = makeLegacy("synced");
  const homeA = path.join(root, "homeA");
  const a = migrateLegacyHome({ legacy: { dir: syncedLegacy, synced: { synced: true, provider: "OneDrive" } }, home: homeA });
  assert.ok(a.copied.includes(".companion.json"));
  assert.equal(a.movedPairing, true);
  assert.ok(!fs.existsSync(path.join(syncedLegacy, ".companion.json")), "the token does not stay in the cloud");
  assert.ok(fs.existsSync(path.join(homeA, ".companion.json")));
  assert.ok(fs.existsSync(path.join(homeA, ".recipes", "recipes.json")));
  assert.ok(!fs.existsSync(path.join(homeA, ".auth")), "nothing from a synced profile is copied");
  assert.equal(a.oldProfiles, path.join(syncedLegacy, ".auth"));

  const localLegacy = makeLegacy("local");
  const homeB = path.join(root, "homeB");
  const b = migrateLegacyHome({ legacy: { dir: localLegacy, synced: { synced: false } }, home: homeB });
  assert.equal(b.movedPairing, false);
  assert.ok(fs.existsSync(path.join(localLegacy, ".companion.json")), "a local copy stays");
  assert.ok(fs.existsSync(path.join(homeB, ".auth", "edge", "copilot-studio", "companion-session.json")), "the small saved session is kept");
  assert.ok(!fs.existsSync(path.join(homeB, ".auth", "edge", "copilot-studio", "Default")), "the browser profile itself is not");

  fs.writeFileSync(path.join(homeB, ".companion.json"), "{\"portal\":\"http://x\"}");
  const again = migrateLegacyHome({ legacy: { dir: localLegacy, synced: { synced: false } }, home: homeB });
  assert.equal(again.skipped, true, "an existing pairing is never overwritten");
  assert.match(fs.readFileSync(path.join(homeB, ".companion.json"), "utf8"), /http:\/\/x/);

  assert.equal(deleteOldSignIn({ legacyDir: syncedLegacy }), true);
  assert.ok(!fs.existsSync(path.join(syncedLegacy, ".auth")));
  assert.ok(fs.existsSync(path.join(syncedLegacy, ".recipes")), "only the sign-in folder is deleted");
  assert.equal(deleteOldSignIn({ legacyDir: syncedLegacy }), false);
});

test("runCompanion: a synced --home is refused with the exact command, --allow-synced-home overrides it, and --status shows the data folder", async (t) => {
  const root = tmpDir(t);
  const synced = path.join(root, "OneDrive - Contoso", "data");
  const log = collectLog();
  const deps = { log, noSignals: true, nonInteractive: true, preflight: async () => ({ ok: true, problems: [], kinds: ["chromium"] }), homeEnv: { env: {}, platform: process.platform, homedir: root, attributesOf: () => [] } };
  assert.equal(await runCompanion([`--home=${synced}`, "--check-signin"], { ...deps, checkSignin: async () => assert.fail("must not open a browser") }), EXIT.usage);
  assert.match(log.text(), /data folder is inside OneDrive/);
  assert.match(log.text(), /--home=/);
  assert.equal(fs.existsSync(synced), false, "nothing was created in the synced folder");

  const allowed = collectLog();
  let seen = null;
  const code = await runCompanion([`--home=${synced}`, "--allow-synced-home", "--check-signin=ai-foundry", "--launch=playwright"], { ...deps, log: allowed, playwright: {}, checkSignin: async (args) => ((seen = args), { ok: true }) });
  assert.equal(code, EXIT.ok);
  assert.equal(seen.product, "ai-foundry");
  assert.equal(seen.launch, "playwright");
  assert.match(allowed.text(), /Warning: this folder is inside OneDrive \(allowed with --allow-synced-home\)/);

  const status = collectLog();
  await runCompanion(["--status", `--home=${synced}`], { ...deps, log: status });
  assert.match(status.text(), /Data folder: .*OneDrive - Contoso/);
  assert.match(status.text(), /Warning: this folder is inside OneDrive/);

  const local = collectLog();
  await runCompanion(["--status", `--home=${path.join(root, "local")}`], { ...deps, log: local });
  assert.match(local.text(), /local, not synced/);
});

test("runCompanion moves a legacy folder into the local data home on the first start", async (t) => {
  const root = tmpDir(t);
  const code = path.join(root, "OneDrive - Contoso", "tools", "screenshot-capture");
  fs.mkdirSync(path.join(code, ".auth", "edge", "copilot-studio"), { recursive: true });
  fs.writeFileSync(path.join(code, ".companion.json"), JSON.stringify({ portal: "http://127.0.0.1:1", token: TOKEN, deviceId: "dev_x", deviceName: "PC" }));
  const appData = path.join(root, "AppData", "Local");
  const log = collectLog();
  const homeEnv = { env: process.platform === "win32" ? { LOCALAPPDATA: appData } : { XDG_DATA_HOME: appData }, platform: process.platform, homedir: root, attributesOf: () => [] };
  await runCompanion(["--status"], { log, codeDir: code, homeEnv, noSignals: true, nonInteractive: true, preflight: async () => ({ ok: true, problems: [], kinds: ["chromium"] }) });
  const home = localDataHome(homeEnv);
  assert.ok(fs.existsSync(path.join(home, ".companion.json")), "the pairing is in the new local folder");
  assert.ok(!fs.existsSync(path.join(code, ".companion.json")), "and no longer in the synced one");
  assert.match(log.text(), /Moved this companion's pairing and settings to /);
  assert.match(log.text(), /--delete-old-signin/);
  assert.match(log.text(), /inside OneDrive, so a copy of that sign-in is in the cloud/);
  assert.ok(fs.existsSync(path.join(code, ".auth")), "the old sign-in is not deleted without being asked");

  const deleted = collectLog();
  await runCompanion(["--delete-old-signin"], { log: deleted, codeDir: code, homeEnv });
  assert.ok(!fs.existsSync(path.join(code, ".auth")));
  assert.match(deleted.text(), /Deleted the old sign-in folder/);
});

// ── Starting the browser the normal way ──────────────────────────────────────

const FORBIDDEN_SWITCHES = ["--enable-automation", "--disable-extensions", "--disable-blink-features", "--disable-popup-blocking", "--disable-default-apps", "--no-service-autorun", "--password-store", "--use-mock-keychain", "--user-agent"];

/** A pretend browser program (a process that listens on a debugging port) and a Playwright that can connect to it. */
function fakeBrowserWorld({ ws = (port) => `ws://127.0.0.1:${port}/devtools/browser/abc`, exitsRightAway = false, exitsOnCloseCommand = true, spawnFails = false } = {}) {
  const spawned = [];
  const cdp = { connected: [], disconnected: 0, sent: [], launches: [] };
  const spawnFn = (exe, args) => {
    if (spawnFails) throw new Error("spawn EACCES");
    const child = new EventEmitter();
    child.kill = () => {
      child.emit("exit", 0, null);
      return true;
    };
    spawned.push({ exe, args, child });
    if (exitsRightAway) Promise.resolve().then(() => child.emit("exit", 0, null));
    return child;
  };
  let nextPort = 51000;
  const portFn = async () => (nextPort += 1);
  const fetchFn = async (url) => {
    if (exitsRightAway) throw new Error("connection refused");
    return { ok: true, json: async () => ({ webSocketDebuggerUrl: ws(Number(new URL(url).port)) }) };
  };
  const makeContext = () => ({
    pages: () => [],
    async newPage() {
      return { url: () => "about:blank" };
    },
    async addCookies() {},
    async cookies() {
      return [];
    },
    async storageState() {
      return { cookies: [], origins: [] };
    },
  });
  const playwright = {
    chromium: {
      async connectOverCDP(url) {
        cdp.connected.push(url);
        const context = makeContext();
        return {
          contexts: () => [context],
          on() {},
          version: () => "Edg/150.0.1234.5",
          async close() {
            cdp.disconnected += 1;
          },
          async newBrowserCDPSession() {
            return {
              async send(method) {
                cdp.sent.push(method);
                if (exitsOnCloseCommand) spawned.at(-1)?.child.emit("exit", 0, null);
              },
            };
          },
        };
      },
      async launchPersistentContext(dir, options) {
        cdp.launches.push({ dir, options });
        return makeContext();
      },
    },
  };
  return { spawned, cdp, playwright, options: { spawnFn, fetchFn, portFn, sleep: instant, timeoutMs: 600, pollMs: 100, exitWaitMs: 200 } };
}

test("the attach launcher starts a normal browser with a profile folder and a loopback debug port, and none of the automation switches", async (t) => {
  const args = attachArgs({ dir: "/p", port: 51234, headless: false });
  assert.ok(args.includes("--user-data-dir=/p"));
  assert.ok(args.includes("--remote-debugging-port=51234"));
  assert.ok(args.includes("--remote-debugging-address=127.0.0.1"));
  assert.ok(args.includes("--no-first-run"));
  for (const flag of FORBIDDEN_SWITCHES) assert.ok(!args.some((a) => a.startsWith(flag)), `no ${flag}`);
  assert.ok(attachArgs({ dir: "/p", port: 1, headless: true }).includes("--headless=new"));

  const port = await freeLoopbackPort();
  assert.ok(Number.isInteger(port) && port > 1023);
  await new Promise((resolve, reject) => {
    const probe = net.createServer().once("error", reject);
    probe.listen(port, "127.0.0.1", () => probe.close(resolve));
  });

  assert.deepEqual(parseLaunchChoice("attach"), { ok: true, launch: "attach" });
  assert.match(parseLaunchChoice("fast").error, /--launch must be auto, attach, or playwright/);
  const pw = { chromium: { connectOverCDP() {} } };
  assert.equal(wantsAttach({ launch: "auto", kind: "edge", playwright: pw, executable: "C:\\edge.exe" }), true);
  assert.equal(wantsAttach({ launch: "auto", kind: "chrome", playwright: pw, executable: "C:\\chrome.exe" }), true);
  assert.equal(wantsAttach({ launch: "playwright", kind: "edge", playwright: pw, executable: "C:\\edge.exe" }), false);
  assert.equal(wantsAttach({ launch: "auto", kind: "chromium", playwright: pw, executable: "x" }), false, "the bundled browser is always launched by Playwright");
  assert.equal(wantsAttach({ launch: "auto", kind: "edge", playwright: {}, executable: "C:\\edge.exe" }), false, "a Playwright that cannot connect");
  assert.equal(wantsAttach({ launch: "auto", kind: "edge", playwright: pw, executable: null }), false, "the browser is not installed");
  t.after(closeAllAttached);
});

test("attach connects over a loopback address, ends the browser process when it is closed, and frees the profile", async (t) => {
  const dir = tmpDir(t);
  const world = fakeBrowserWorld();
  const opened = await launchAttached({ playwright: world.playwright, kind: "edge", dir, executable: "C:\\edge.exe", ...world.options });
  assert.equal(world.spawned.length, 1);
  assert.equal(world.spawned[0].exe, "C:\\edge.exe");
  assert.match(world.cdp.connected[0], /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\//, "connected on the loopback address");
  assert.ok(fs.existsSync(path.join(dir, LOCK_FILE)), "the profile is claimed");
  assert.equal(opened.context.isCompanionClosed(), false);

  await opened.context.close();
  assert.deepEqual(world.cdp.sent, ["Browser.close"], "the browser is asked to quit so it saves its profile");
  assert.equal(world.cdp.disconnected, 1);
  assert.equal(opened.context.isCompanionClosed(), true);
  assert.ok(!fs.existsSync(path.join(dir, LOCK_FILE)), "the profile is released");
  await opened.context.close();
  assert.equal(world.cdp.sent.length, 1, "closing twice does nothing more");

  // A browser that ignores the close command is ended anyway.
  const stubborn = fakeBrowserWorld({ exitsOnCloseCommand: false });
  const second = await launchAttached({ playwright: stubborn.playwright, kind: "chrome", dir, executable: "C:\\chrome.exe", ...stubborn.options });
  let exited = false;
  stubborn.spawned[0].child.on("exit", () => {
    exited = true;
  });
  await second.context.close();
  assert.equal(exited, true, "the process was ended");
});

test("a second companion on the same profile is refused, and a debug address that is not on this computer is never used", async (t) => {
  const dir = tmpDir(t);
  const world = fakeBrowserWorld();
  const first = await launchAttached({ playwright: world.playwright, kind: "edge", dir, executable: "C:\\edge.exe", ...world.options });
  await assert.rejects(launchAttached({ playwright: world.playwright, kind: "edge", dir, executable: "C:\\edge.exe", ...world.options }), (err) => err instanceof AttachError && err.code === "PROFILE_IN_USE" && /Another companion window is already using this sign-in profile/.test(err.message));
  await first.context.close();

  const other = tmpDir(t);
  fs.writeFileSync(path.join(other, LOCK_FILE), JSON.stringify({ pid: 424242 }));
  assert.throws(() => acquireProfileLock(other, { isAlive: () => true }), (err) => err.code === "PROFILE_IN_USE");
  const stale = acquireProfileLock(other, { isAlive: () => false });
  stale.release();

  const remote = fakeBrowserWorld({ ws: (port) => `ws://203.0.113.9:${port}/devtools/browser/abc` });
  await assert.rejects(launchAttached({ playwright: remote.playwright, kind: "edge", dir: tmpDir(t), executable: "C:\\edge.exe", ...remote.options }), (err) => err.code === "NOT_LOOPBACK");
  assert.equal(remote.cdp.connected.length, 0, "it never connected to it");

  const quits = fakeBrowserWorld({ exitsRightAway: true });
  await assert.rejects(launchAttached({ playwright: quits.playwright, kind: "edge", dir: tmpDir(t), executable: "C:\\edge.exe", ...quits.options }), (err) => err.code === "BROWSER_EXITED" && /closed right away/.test(err.message));
});

test("companion.openProfile uses attach for Edge and Chrome, the Playwright launcher on request, and falls back with one clear message", async (t) => {
  const home = tmpDir(t);
  const installed = { edge: "C:\\edge.exe", chrome: null };
  const world = fakeBrowserWorld();
  const log = collectLog();
  const opened = await openProfile({ playwright: world.playwright, home, profile: "copilot-studio", kinds: ["edge"], log, installed, attachOptions: world.options });
  assert.equal(opened.launch, "attach");
  assert.match(log.text(), /Opened Microsoft Edge \(started the normal way\)\./);
  await opened.context.close();

  const asked = await openProfile({ playwright: world.playwright, home, profile: "copilot-studio", kinds: ["edge"], log: collectLog(), installed, launch: "playwright", attachOptions: world.options });
  assert.equal(asked.launch, "playwright");
  assert.equal(world.cdp.launches.length, 1);

  const bundled = await openProfile({ playwright: world.playwright, home, profile: "copilot-studio", kinds: ["chromium"], log: collectLog(), installed, attachOptions: world.options });
  assert.equal(bundled.launch, "playwright", "the bundled Chromium is never started this way");

  const broken = fakeBrowserWorld({ spawnFails: true });
  const fallbackLog = collectLog();
  const fell = await openProfile({ playwright: broken.playwright, home, profile: "copilot-studio", kinds: ["edge"], log: fallbackLog, installed, attachOptions: broken.options });
  assert.equal(fell.launch, "playwright");
  assert.match(fallbackLog.text(), /Microsoft Edge could not be started the normal way .*Opening it with the automation launcher instead/);
  await assert.rejects(openProfile({ playwright: broken.playwright, home, profile: "copilot-studio", kinds: ["edge"], log: collectLog(), installed, launch: "attach", attachOptions: broken.options }), /spawn EACCES/);
  t.after(closeAllAttached);
});

// ── Sign-in pages are watched, never touched ─────────────────────────────────

/** A page whose address depends on a virtual clock. Any call that would act on the page fails the test. */
function timelinePage(timeline) {
  const clock = { ms: 0 };
  const calls = [];
  const urlAt = typeof timeline === "function" ? timeline : (ms) => [...timeline].reverse().find(([from]) => ms >= from)?.[1] ?? "about:blank";
  const forbidden = (name) => async () => {
    calls.push(name);
    throw new Error(`The companion must not call ${name} while a person signs in.`);
  };
  const page = { url: () => urlAt(clock.ms), isClosed: () => false, on() {} };
  for (const name of ["goto", "reload", "goBack", "bringToFront", "screenshot", "evaluate", "click", "fill", "setViewportSize", "waitForLoadState"]) page[name] = forbidden(name);
  return { page, clock, calls, sleep: async (ms) => { clock.ms += ms; } };
}

const SIGN_IN_FLOW = [
  [0, APP],
  [200, "https://login.microsoftonline.com/common/oauth2/authorize?client_id=abc&login_hint=ada%40contoso.com"], // account picker
  [3000, "https://login.microsoftonline.com/contoso.onmicrosoft.com/login"], // password
  [8000, "https://login.microsoftonline.com/common/SAS/ProcessAuth"], // MFA: 20 seconds of waiting for a phone
  [28_000, "https://login.microsoftonline.com/common/kmsi"], // Stay signed in?
  [31_000, "https://login.microsoftonline.com/common/consent?code=SECRET"], // consent
  [35_000, `${APP}signin-callback?code=SECRET&state=abc`],
  [36_000, `${APP}environments/Default/home`],
];

test("a multi-page sign-in (account picker, password, 20 seconds of MFA, Stay signed in?, consent) is only watched: no navigation, reload, click, or picture", async () => {
  const { page, clock, calls, sleep } = timelinePage(SIGN_IN_FLOW);
  const said = [];
  const trace = createTrace({ file: null });
  const gate = createAuthGate({ product: "copilot-studio", waitMs: 600_000, pollMs: 250, settleMs: 3000, graceMs: 2500, confirmMs: 3000, sleep, notify: (n) => said.push(n.message), trace });
  const result = await gate.ensureSignedIn(page, { phase: "navigate", target: APP });
  assert.deepEqual(result, { ok: true, waited: true });
  assert.deepEqual(calls, [], "the page was only read");
  assert.equal(said.length, 1, "the person was told once");
  assert.ok(clock.ms >= 36_000 + 3000, "it waited for the product to settle and then watched a little longer");
  assert.equal(gate.detector.result(clock.ms).detected, false, "twenty seconds of MFA is a person at work, not a loop");
  const written = trace.lines.join("\n");
  for (const secret of ["SECRET", "login_hint", "contoso.onmicrosoft.com", "ada%40", "client_id"]) assert.ok(!written.includes(secret), `the trace never holds ${secret}`);
});

test("a product that shows its own page for several seconds before it redirects to sign-in is not trusted early (real Copilot Studio does this)", async () => {
  const flow = [
    [0, APP],
    [6200, "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=abc"],
    [10_000, `${APP}auth-redirect.html`],
    [10_100, APP],
    [14_200, `${APP}environments/~personal/home`],
    [20_000, `${APP}environments/abc/home`],
  ];
  const early = timelinePage(flow);
  const hasty = createAuthGate({ product: "copilot-studio", waitMs: 600_000, pollMs: 250, settleMs: 1000, graceMs: 100, confirmMs: 0, firstLoadMs: 0, sleep: early.sleep });
  assert.deepEqual(await hasty.ensureSignedIn(early.page, { phase: "navigate", target: APP }), { ok: true }, "without the first-load hold, the product's own page looks like a finished sign-in");
  assert.ok(early.clock.ms < 6200, "...which is judged before the redirect happens");

  const patient = timelinePage(flow);
  const gate = createAuthGate({ product: "copilot-studio", waitMs: 600_000, pollMs: 250, settleMs: 1000, graceMs: 100, confirmMs: 6000, firstLoadMs: 10_000, sleep: patient.sleep });
  assert.deepEqual(await gate.ensureSignedIn(patient.page, { phase: "navigate", target: APP }), { ok: true, waited: true });
  assert.ok(patient.clock.ms >= 20_000, "it watched until the product reached its home page");
  assert.deepEqual(patient.calls, [], "and touched nothing");

  // A signed-in session: the first page is held once, later pages in the same job are not.
  const signedIn = timelinePage([[0, `${APP}environments/abc/home`]]);
  const again = createAuthGate({ product: "copilot-studio", waitMs: 600_000, pollMs: 250, settleMs: 1000, graceMs: 100, confirmMs: 6000, firstLoadMs: 10_000, sleep: signedIn.sleep });
  assert.deepEqual(await again.ensureSignedIn(signedIn.page, { phase: "navigate", target: APP }), { ok: true });
  assert.ok(signedIn.clock.ms >= 10_000, "the first page was watched for the whole hold");
  const before = signedIn.clock.ms;
  assert.deepEqual(await again.ensureSignedIn(signedIn.page, { phase: "navigate", target: `${APP}environments/abc/agents` }), { ok: true });
  assert.ok(signedIn.clock.ms - before <= 3000, "the second page only needs the short settle");
});

test("while a sign-in is in progress the page is never navigated, even when a navigation is asked for or interrupted", async () => {
  const trace = createTrace({ file: null });
  // Already on a sign-in page: the navigation is skipped.
  const busy = timelinePage([[0, "https://login.microsoftonline.com/common/oauth2/authorize?client_id=abc"]]);
  const skipped = await gotoWithRetry(busy.page, `${APP}home`, { sleep: busy.sleep, trace, reason: "open-screen" });
  assert.deepEqual(skipped, { skipped: "sign-in" });
  assert.deepEqual(busy.calls, []);

  // An interrupted navigation that ended on a sign-in page is not retried.
  let gotos = 0;
  const state = { url: "about:blank" };
  const interrupted = {
    url: () => state.url,
    async goto() {
      gotos += 1;
      state.url = "https://login.microsoftonline.com/common/oauth2/authorize?client_id=abc";
      throw new Error("page.goto: net::ERR_ABORTED at https://copilotstudio.microsoft.com/");
    },
  };
  assert.deepEqual(await gotoWithRetry(interrupted, APP, { sleep: instant, trace, reason: "open-screen" }), { skipped: "sign-in" });
  assert.equal(gotos, 1, "no retry once the browser is at the sign-in page");

  // A sign-in page that opens while waiting to retry stops the retry.
  const state2 = { url: "about:blank", sleeps: 0 };
  let gotos2 = 0;
  const slow = {
    url: () => state2.url,
    async goto() {
      gotos2 += 1;
      throw new Error("page.goto: Timeout 30000ms exceeded.");
    },
  };
  const result = await gotoWithRetry(slow, APP, { sleep: async () => { state2.url = "https://login.live.com/login.srf?x=1"; }, trace, reason: "open-screen" });
  assert.deepEqual(result, { skipped: "sign-in" });
  assert.equal(gotos2, 1);

  // An ordinary interrupted navigation is still retried.
  let tries = 0;
  const flaky = { url: () => "about:blank", async goto() { tries += 1; if (tries < 2) throw new Error("net::ERR_ABORTED"); } };
  await gotoWithRetry(flaky, APP, { sleep: instant, trace });
  assert.equal(tries, 2);

  const events = trace.lines.map((l) => JSON.parse(l));
  assert.ok(events.some((e) => e.event === "navigation-skipped" && e.reason === "open-screen"), "a skipped navigation says why");
  assert.ok(events.some((e) => e.event === "navigation" && e.reason && e.to), "every navigation is logged with its reason");
  assert.ok(!trace.lines.join("\n").includes("client_id"), "and never with a query string");
});

test("a navigation skipped for a sign-in is made once the person has signed in", async () => {
  const gotos = [];
  const clock = { ms: 0 };
  const timeline = [[0, "https://login.microsoftonline.com/common/oauth2/authorize"], [4000, `${APP}other-landing`], [7000, `${APP}other-landing`]];
  let current = null;
  const page = {
    url: () => current ?? [...timeline].reverse().find(([from]) => clock.ms >= from)[1],
    isClosed: () => false,
    on() {},
    async goto(url) {
      gotos.push(url);
      current = url;
    },
  };
  const gate = createAuthGate({ product: "copilot-studio", waitMs: 120_000, pollMs: 250, settleMs: 1000, graceMs: 100, confirmMs: 0, sleep: async (ms) => { clock.ms += ms; } });
  const outcome = await navigateWithSignIn({ page, url: `${APP}environments/Default/home`, gate, sleep: instant, reason: "open-screen" });
  assert.equal(outcome.ok, true);
  assert.deepEqual(gotos, [`${APP}environments/Default/home`], "exactly one navigation, after sign-in");
});

test("after a fresh sign-in lands on the product's home page instead of the asked-for screen, the screen is opened once", async () => {
  const gotos = [];
  const clock = { ms: 0 };
  const timeline = [[0, APP], [2000, "https://login.microsoftonline.com/common/oauth2/v2.0/authorize"], [5000, `${APP}environments/abc/home`]];
  let current = null;
  const page = {
    url: () => current ?? [...timeline].reverse().find(([from]) => clock.ms >= from)[1],
    isClosed: () => false,
    on() {},
    async goto(url) {
      gotos.push(url);
      // The first navigation is followed by the product's own redirects; only the one after sign-in sticks.
      current = gotos.length > 1 ? url : null;
    },
  };
  const gate = createAuthGate({ product: "copilot-studio", waitMs: 120_000, pollMs: 250, settleMs: 1000, graceMs: 100, confirmMs: 0, firstLoadMs: 4000, sleep: async (ms) => { clock.ms += ms; } });
  const outcome = await navigateWithSignIn({ page, url: `${APP}environments/abc/agents/xyz/overview`, gate, sleep: instant, reason: "open-screen" });
  assert.equal(outcome.ok, true);
  assert.deepEqual(gotos, [`${APP}environments/abc/agents/xyz/overview`, `${APP}environments/abc/agents/xyz/overview`], "the first navigation, and one more after the person signed in");

  // A start page with no path is not asked for again: the home page it lands on is the page.
  const rootGotos = [];
  const clock2 = { ms: 0 };
  const rootPage = { url: () => [...timeline].reverse().find(([from]) => clock2.ms >= from)[1], isClosed: () => false, on() {}, async goto(url) { rootGotos.push(url); } };
  const rootGate = createAuthGate({ product: "copilot-studio", waitMs: 120_000, pollMs: 250, settleMs: 1000, graceMs: 100, confirmMs: 0, firstLoadMs: 4000, sleep: async (ms) => { clock2.ms += ms; } });
  assert.equal((await navigateWithSignIn({ page: rootPage, url: APP, gate: rootGate, sleep: instant, reason: "open-start" })).ok, true);
  assert.deepEqual(rootGotos, [APP]);
});

test("no code path navigates a page except through lifecycle.mjs, and nothing reloads or clicks Back on a sign-in page", () => {
  const sources = fs.readdirSync(TOOL_DIR).filter((f) => f.endsWith(".mjs"));
  for (const file of sources) {
    const source = fs.readFileSync(path.join(TOOL_DIR, file), "utf8");
    if (file !== "lifecycle.mjs") assert.ok(!/\.goto\s*\(/.test(source), `${file} navigates only through gotoWithRetry`);
    assert.ok(!/\.reload\s*\(/.test(source), `${file} never reloads a page`);
    assert.ok(!/\bsetInterval\s*\([^)]*(?:goto|bringToFront)/.test(source), `${file} has no timer that navigates or steals focus`);
    if (file !== "executor.mjs") assert.ok(!/\.goBack\s*\(/.test(source), `${file} never goes Back`);
  }
  const executor = fs.readFileSync(path.join(TOOL_DIR, "executor.mjs"), "utf8");
  assert.match(executor, /classifyUrl\(.*\)\.kind === "sign-in"/, "the executor checks for a sign-in page before it acts or goes Back");
  for (const file of ["attach.mjs", "check-signin.mjs", "signin-diagnosis.mjs", "signin-url.mjs", "home.mjs", "auth.mjs"]) {
    const source = fs.readFileSync(path.join(TOOL_DIR, file), "utf8");
    assert.ok(!/\b(?:userAgent|webdriver|stealth|evasion|AutomationControlled|enable-automation)\b/i.test(source), `${file} never hides that the browser is automated`);
    assert.ok(!/\.(fill|type|press|pressSequentially|setInputFiles|selectOption|check|uncheck|click)\s*\(/.test(source), `${file} never drives a page`);
  }
});

// ── A browser that keeps bouncing ────────────────────────────────────────────

test("the ping-pong detector counts short visits to a sign-in page, and a person typing clears the count", () => {
  const info = (kind) => classifyUrl(kind === "app" ? APP : LOGIN);
  const detector = createPingPongDetector();
  let at = 0;
  const visit = (kind, ms) => {
    detector.hop(info(kind), at);
    at += ms;
    detector.tick(at);
  };
  visit("app", 500);
  visit("sign-in", 500);
  visit("app", 500);
  visit("sign-in", 500);
  assert.equal(detector.result(at).detected, false, "two bounces are not yet a loop");
  visit("app", 500);
  visit("sign-in", 500);
  visit("app", 500);
  assert.equal(detector.result(at).detected, true, "three bounces in under 90 seconds");
  assert.equal(detector.result(at + 200_000).detected, false, "old bounces fall out of the window");

  const patient = createPingPongDetector();
  at = 0;
  const hop = (kind, ms) => {
    patient.hop(info(kind), at);
    at += ms;
    patient.tick(at);
  };
  hop("app", 500);
  hop("sign-in", 500);
  hop("app", 500);
  hop("sign-in", 500);
  hop("app", 500);
  hop("sign-in", 20_000);
  hop("app", 500);
  assert.equal(patient.result(at).detected, false, "twenty seconds on a sign-in page is a person signing in");
  assert.ok(patient.hops().length >= 6);
  assert.ok(patient.hops().every((h) => !("url" in h) && !/\?/.test(h.path)), "hops hold host and path only");
});

test("a browser that keeps bouncing between the product and sign-in is stopped, diagnosed, left open, and never navigated", async () => {
  const bounce = timelinePage((ms) => (Math.floor(ms / 500) % 2 === 1 ? LOGIN : APP));
  const trace = createTrace({ file: null });
  const seen = [];
  const diagnose = async (facts) => {
    seen.push(facts);
    return diagnoseSignIn({ code: facts.code, aadsts: "AADSTS50196", bounces: facts.bounces, product: "copilot-studio", synced: { synced: true, provider: "OneDrive" } });
  };
  const gate = createAuthGate({ product: "copilot-studio", waitMs: 600_000, pollMs: 250, settleMs: 1000, graceMs: 100, confirmMs: 1500, sleep: bounce.sleep, trace, diagnose });
  const result = await gate.ensureSignedIn(bounce.page, { phase: "navigate", target: APP });
  assert.equal(result.ok, false);
  assert.equal(result.code, "ping-pong");
  assert.ok(bounce.clock.ms < 15_000, "it stopped within seconds, not after the full wait");
  assert.deepEqual(bounce.calls, [], "it stopped without touching the page");
  assert.equal(gate.failed.keepOpen, true, "the window stays open for the person to look at");
  assert.equal(seen[0].code, "ping-pong");
  assert.ok(seen[0].bounces >= 3);
  assert.match(result.error, /kept bouncing between Microsoft Copilot Studio and the sign-in page/);
  assert.match(result.error, /Use a local folder/, "the message ends with the next step");
  assert.equal(result.diagnosis.aadsts, "AADSTS50196");
  assert.match(gate.describeFailure(2), /retry the 2 screenshots/);
  // Every later check fails at once, without watching again.
  const before = bounce.clock.ms;
  assert.equal((await gate.ensureSignedIn(bounce.page, { phase: "check" })).code, "ping-pong");
  assert.equal(bounce.clock.ms, before);
  assert.ok(trace.lines.map((l) => JSON.parse(l)).some((e) => e.event === "sign-in-failed" && e.code === "ping-pong" && e.aadsts === "AADSTS50196"));
});

test("a person who takes a long time to type between quick redirects is not mistaken for a loop", async () => {
  const flow = timelinePage((ms) => {
    if (ms < 500) return APP;
    if (ms < 1000) return LOGIN;
    if (ms < 1500) return APP;
    if (ms < 2000) return LOGIN;
    if (ms < 2500) return APP;
    if (ms < 15_000) return LOGIN; // typing and approving on a phone
    if (ms < 15_500) return APP;
    if (ms < 16_000) return LOGIN;
    return `${APP}home`;
  });
  const gate = createAuthGate({ product: "copilot-studio", waitMs: 600_000, pollMs: 250, settleMs: 1000, graceMs: 100, confirmMs: 1000, sleep: flow.sleep });
  const result = await gate.ensureSignedIn(flow.page, { phase: "navigate", target: APP });
  assert.deepEqual(result, { ok: true, waited: true });
});

test("a product page that bounces back to sign-in just after it settles keeps the gate watching instead of declaring success", async () => {
  const flow = timelinePage((ms) => {
    if (ms < 1000) return LOGIN;
    if (ms < 2500) return `${APP}signin-callback`; // looks signed in...
    if (ms < 9000) return "https://login.microsoftonline.com/common/oauth2/authorize?prompt=none"; // ...then the app sends it back
    return `${APP}home`;
  });
  const gate = createAuthGate({ product: "copilot-studio", waitMs: 600_000, pollMs: 250, settleMs: 1000, graceMs: 100, confirmMs: 3000, sleep: flow.sleep });
  const result = await gate.ensureSignedIn(flow.page, { phase: "navigate", target: APP });
  assert.deepEqual(result, { ok: true, waited: true });
  assert.ok(flow.clock.ms >= 9000, "it did not report success before the app finished signing in");
  assert.equal(gate.state.episodes, 1, "and it was one sign-in, not several");
});

// ── Saying why ───────────────────────────────────────────────────────────────

test("an AADSTS code is read only from error parameters and from a sign-in page, and only the code leaves the page", async () => {
  assert.equal(extractAadstsCode("Sorry. AADSTS50196: The server terminated an operation because it encountered a client request loop. Trace ID 1234"), "AADSTS50196");
  assert.equal(extractAadstsCode("no error here"), null);
  assert.equal(aadstsFromUrl(`${APP}signin-callback?error=access_denied&error_description=AADSTS53003%3A+Blocked+by+Conditional+Access&state=abc`), "AADSTS53003");
  assert.equal(aadstsFromUrl(`${APP}home?returnUrl=AADSTS50058`), null, "only the error parameters are read");

  const onSignIn = { url: () => LOGIN, evaluate: async (fn) => (fn.toString().includes("AADSTS") ? "AADSTS50058" : "Ada Lovelace ada@contoso.com") };
  assert.equal(await readAadstsCode(onSignIn), "AADSTS50058");
  let evaluated = false;
  const onProduct = { url: () => `${APP}home`, evaluate: async () => ((evaluated = true), "AADSTS50058") };
  assert.equal(await readAadstsCode(onProduct), null);
  assert.equal(evaluated, false, "no page text is read on a product page");
  const leaky = { url: () => LOGIN, evaluate: async () => "ada@contoso.com is signed in" };
  assert.equal(await readAadstsCode(leaky), null, "text that is not a code is dropped");
});

test("the diagnosis lists the likely causes first, names the next step, and the portal report is bounded and plain", () => {
  const synced = diagnoseSignIn({ code: "ping-pong", bounces: 4, synced: { synced: true, provider: "OneDrive" }, product: "copilot-studio", launch: "attach", skewSec: 4, cookies: { blocked: false } });
  assert.equal(synced.checks[0].id, "synced-profile");
  assert.equal(synced.checks[0].level, "likely");
  assert.match(synced.nextStep, /local folder/);
  assert.match(synced.summary, /back and forth between the product and the Microsoft sign-in page 4 times/);
  assert.equal(synced.checks.find((c) => c.id === "clock-skew").level, "ruled-out");
  assert.equal(synced.checks.find((c) => c.id === "cookies-blocked").level, "ruled-out");

  const ca = diagnoseSignIn({ code: "ping-pong", aadsts: "AADSTS53003", synced: { synced: false }, product: "copilot-studio", launch: "playwright", device: { joined: true, prt: true } });
  assert.equal(ca.checks[0].id, "conditional-access");
  assert.ok(ca.checks.some((c) => c.id === "automation-browser" && c.level === "likely"), "a managed device and the automation launcher");
  assert.match(ca.summary, /AADSTS53003: A Conditional Access policy blocked the sign-in/);

  const stale = diagnoseSignIn({ code: "bounced", savedSession: true, product: "ai-foundry" });
  assert.ok(stale.checks.find((c) => c.id === "stale-session").level === "likely");
  assert.match(stale.checks.find((c) => c.id === "stale-session").fix, /--forget-signin=ai-foundry/);
  assert.equal(diagnoseSignIn({ code: "ping-pong", skewSec: 600 }).checks[0].id, "clock-skew");
  assert.equal(diagnoseSignIn({ code: "ping-pong", cookies: { blocked: true } }).checks[0].id, "cookies-blocked");
  const waiting = diagnoseSignIn({ code: "timeout", bounces: 0, product: "copilot-studio", synced: { synced: false } });
  assert.equal(waiting.checks[0].id, "waiting-for-you", "a sign-in page nobody finished says so first, not a guess about the organization");
  assert.match(waiting.nextStep, /finish the sign-in there/);
  assert.ok(!diagnoseSignIn({ code: "ping-pong", bounces: 3 }).checks.some((c) => c.id === "waiting-for-you" && c.level !== "ruled-out"), "a loop is not a person who has not signed in yet");

  const report = signInReport({ ...ca, summary: `${"x".repeat(900)} https://login.microsoftonline.com/?code=SECRET` }, { product: "copilot-studio" });
  assert.equal(report.code, "ping-pong");
  assert.equal(report.aadsts, "AADSTS53003");
  assert.ok(report.summary.length <= 400);
  assert.ok(report.checks.length <= 8 && report.checks.every((c) => ["likely", "possible"].includes(c.level)));
  assert.equal(signInReport(null), null);
  assert.equal(signInReport({ ...ca, aadsts: "not a code" }).aadsts, null);
});

// ── --check-signin ───────────────────────────────────────────────────────────

test("cookie presence lists names and attributes for the sign-in and product sites, never a value, an account, or an unrelated site", async () => {
  const cookies = [
    { name: "ESTSAUTHPERSISTENT", value: "VALUE-ONE-SECRET", domain: ".login.microsoftonline.com", secure: true, httpOnly: true, sameSite: "None", expires: 4102444800 },
    { name: "ESTSAUTH", value: "VALUE-TWO-SECRET", domain: "login.microsoftonline.com", secure: true, httpOnly: true, sameSite: "None", expires: -1 },
    { name: "msal.0f1d2c3b-aaaa-4bbb-8ccc-1234567890ab.idtoken", value: "VALUE-THREE-SECRET", domain: "copilotstudio.microsoft.com", secure: true, httpOnly: false, sameSite: "Lax", expires: -1 },
    { name: "ada@contoso.com", value: "VALUE-FOUR-SECRET", domain: "copilotstudio.microsoft.com" },
    { name: "tracker", value: "VALUE-FIVE-SECRET", domain: "ads.example.net" },
  ];
  const found = await cookiePresence({ cookies: async () => cookies }, { productHost: "copilotstudio.microsoft.com" });
  const text = JSON.stringify(found);
  assert.ok(!/VALUE-|@|0f1d2c3b|tracker|example/.test(text), "no values, accounts, ids, or unrelated sites");
  assert.deepEqual(found.signIn.map((c) => [c.name, c.persistent, c.httpOnly, c.sameSite]), [["ESTSAUTHPERSISTENT", true, true, "None"], ["ESTSAUTH", false, true, "None"]]);
  assert.deepEqual(found.product.map((c) => c.name), ["msal.{id}.idtoken"]);
  assert.equal(cleanCookieName("ada@contoso.com"), null);
  assert.equal(await cookiePresence({ cookies: async () => { throw new Error("closed"); } }), null);
});

test("--check-signin facts: cookie settings, a yes/no device state, and the clock", async (t) => {
  const dir = tmpDir(t);
  assert.deepEqual(readCookieSettings(dir), { setting: "unknown", blocked: null });
  fs.mkdirSync(path.join(dir, "Default"));
  const write = (prefs) => fs.writeFileSync(path.join(dir, "Default", "Preferences"), JSON.stringify(prefs));
  write({ profile: { default_content_setting_values: { cookies: 2 } } });
  assert.deepEqual(readCookieSettings(dir), { setting: "block-all", blocked: true });
  write({ profile: { cookie_controls_mode: 1 } });
  assert.deepEqual(readCookieSettings(dir), { setting: "block-third-party", blocked: true });
  write({ profile: {} });
  assert.deepEqual(readCookieSettings(dir), { setting: "allow", blocked: false });

  const dsreg = "+---+\n| Device State |\n   AzureAdJoined : YES\n EnterpriseJoined : NO\n DomainJoined : NO\n   Device Name : ADA-LAPTOP.contoso.com\n+---+\n  AzureAdPrt : YES\n   WorkplaceJoined : NO\n   UserEmail : ada@contoso.com\n";
  const device = windowsDeviceState({ platform: "win32", exec: () => dsreg });
  assert.deepEqual(device, { joined: true, azureAdJoined: true, domainJoined: false, workplaceJoined: false, prt: true });
  assert.ok(!/ada|contoso|LAPTOP/i.test(JSON.stringify(device)), "only yes and no leave the output");
  assert.equal(windowsDeviceState({ platform: "linux", exec: () => dsreg }), null);
  assert.equal(windowsDeviceState({ platform: "win32", exec: () => { throw new Error("not found"); } }), null);

  const now = 1_700_000_000_000;
  const skew = await measureClockSkew({ now: () => now, fetchFn: async () => ({ headers: { get: () => new Date(now - 600_000).toUTCString() } }) });
  assert.equal(skew, 600, "ten minutes ahead of the sign-in service");
  assert.equal(await measureClockSkew({ fetchFn: async () => { throw new Error("offline"); } }), null);
});

test("hops are described with no query string, and tenant names and ids are hidden", () => {
  assert.equal(maskTenantHost("contoso.sharepoint.com"), "{tenant}.sharepoint.com");
  assert.equal(maskTenantHost("contoso-admin.sharepoint.com"), "{tenant}-admin.sharepoint.com");
  assert.equal(maskTenantHost("fabrikam.onmicrosoft.com"), "{tenant}.onmicrosoft.com");
  assert.equal(maskTenantHost("copilotstudio.microsoft.com"), "copilotstudio.microsoft.com");
  assert.equal(cleanPathForReport("/contoso.onmicrosoft.com/oauth2/authorize"), "/{id}/oauth2/authorize");
  assert.equal(redactedAddress("https://login.microsoftonline.com/contoso.com/kmsi?x=1"), "login.microsoftonline.com/{id}/kmsi");
  const hops = describeHops([{ at: 0, kind: "app", host: "contoso.sharepoint.com", path: "/sites/x" }, { at: 1234, kind: "sign-in", host: "login.microsoftonline.com", path: "/0f1d2c3b-aaaa-4bbb-8ccc-1234567890ab/oauth2/authorize" }]);
  assert.deepEqual(hops.map((h) => [h.step, h.afterSec, h.kind, h.host, h.path]), [[1, 0, "product page", "{tenant}.sharepoint.com", "/sites/x"], [2, 1.2, "sign-in page", "login.microsoftonline.com", "/{id}/oauth2/authorize"]]);
});

/** A fake `open` that hands the check a page driven by a virtual clock. */
function fakeOpen(timeline, { dir, cookies = [] } = {}) {
  const flow = timelinePage(timeline);
  const gotos = [];
  flow.page.goto = async (url) => {
    gotos.push(url);
  };
  flow.page.evaluate = async () => null;
  const closed = { count: 0 };
  const context = {
    pages: () => [flow.page],
    async newPage() {
      return flow.page;
    },
    async cookies() {
      return cookies;
    },
    async storageState() {
      return { cookies: [{ name: "ESTSAUTH", value: "VALUE-SECRET", expires: -1 }] };
    },
    browser: () => ({ version: () => "Edg/150.0.1.2" }),
    async close() {
      closed.count += 1;
    },
  };
  return { flow, gotos, closed, open: async () => ({ context, kind: "edge", dir, launch: "attach" }) };
}

test("--check-signin opens the product once, only watches, and writes a plain verdict and a redacted trace", async (t) => {
  const home = tmpDir(t);
  const dir = path.join(home, ".auth", "edge", "copilot-studio");
  fs.mkdirSync(dir, { recursive: true });
  const world = fakeOpen(SIGN_IN_FLOW, {
    dir,
    cookies: [
      { name: "ESTSAUTHPERSISTENT", value: "VALUE-ONE-SECRET", domain: ".login.microsoftonline.com", secure: true, httpOnly: true, sameSite: "None", expires: 4102444800 },
      { name: "app_session", value: "VALUE-TWO-SECRET", domain: "copilotstudio.microsoft.com", secure: true, httpOnly: true, sameSite: "Lax", expires: -1 },
    ],
  });
  const log = collectLog();
  const outcome = await runCheckSignIn({ home, product: "copilot-studio", playwright: {}, kinds: ["edge"], launch: "auto", open: world.open, resolved: { source: "default", synced: { synced: false } }, log, signInWaitSec: 600, sleepFn: world.flow.sleep, companion: COMPANION_VERSION, deps: { device: () => ({ joined: true, prt: true }), skew: async () => 3, surface: false, raiseWindow: false } });
  assert.equal(outcome.ok, true);
  assert.deepEqual(world.gotos, [APP], "exactly one navigation: the start page");
  assert.deepEqual(world.flow.calls, [], "the sign-in itself was only watched");
  assert.equal(world.closed.count, 1);
  const text = log.text();
  assert.match(text, /Result: signed in\. Microsoft Copilot Studio opened after \d+ page changes in [\d.]+ seconds \(you had to sign in\)\./);
  assert.match(text, /Browser: Microsoft Edge 150, started the normal way \(attach\)\./);
  assert.match(text, /joined to a work or school account: yes; single sign-on token present: yes/);
  assert.match(text, /Data folder: local, not synced\./);
  assert.match(text, /Cookies: sign-in site 1 \(1 kept after the browser closes\), product 1 \(0 kept after the browser closes\)\./);
  assert.match(text, /Clock: within two minutes of Microsoft's\./);
  assert.match(text, /What the browser did \(addresses without query strings\):/);
  const trace = fs.readFileSync(outcome.traceFile, "utf8");
  for (const output of [text, trace, JSON.stringify(outcome.report)]) {
    for (const secret of ["VALUE-ONE-SECRET", "VALUE-TWO-SECRET", "VALUE-SECRET", "SECRET", "login_hint", "ada%40", "contoso.onmicrosoft.com", "client_id", "?"]) {
      if (output === text && secret === "?") continue;
      assert.ok(!output.includes(secret), `the verdict never holds ${secret}`);
    }
  }
  assert.ok(trace.includes("check-signin-verdict") && trace.includes("check-signin-hop"));
  assert.ok(fs.existsSync(path.join(dir, "companion-session.json")), "a working sign-in is saved");
});

test("--check-signin reports a loop with the diagnosis, the AADSTS code, and the next step, and offers to keep the window open", async (t) => {
  const home = tmpDir(t);
  const dir = path.join(home, ".auth", "edge", "copilot-studio");
  fs.mkdirSync(dir, { recursive: true });
  const world = fakeOpen((ms) => (Math.floor(ms / 500) % 2 === 1 ? LOGIN : APP), { dir });
  world.flow.page.evaluate = async () => "AADSTS50196";
  const log = collectLog();
  const asked = [];
  const outcome = await runCheckSignIn({ home, product: "copilot-studio", playwright: {}, kinds: ["edge"], open: world.open, resolved: { source: "option", synced: { synced: true, provider: "OneDrive" } }, log, signInWaitSec: 120, sleepFn: world.flow.sleep, ask: async (q) => asked.push(q), deps: { device: () => null, skew: async () => null, surface: false, raiseWindow: false } });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.report.outcome.result, "ping-pong");
  assert.equal(outcome.report.aadsts, "AADSTS50196");
  assert.match(log.text(), /Result: loop\./);
  assert.match(log.text(), /Data folder: inside OneDrive \(a likely cause of sign-in loops\)\./);
  assert.match(log.text(), /Microsoft error code on screen: AADSTS50196/);
  assert.match(log.text(), /Next step: /);
  assert.equal(outcome.signIn.code, "ping-pong");
  assert.equal(asked.length, 1, "the person is asked before the window closes");
});

// ── What the window did while a person signed in ─────────────────────────────

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

function fakeSurfaceWorld() {
  const handlers = { page: {}, context: {} };
  const calls = [];
  const state = { url: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize", title: "Sign in to your account", dom: { visibility: "visible", focused: true, ready: "complete", elements: 96, inputs: 3, buttons: 1, frames: 0 }, closed: false, opener: null };
  const forbidden = (name) => async () => {
    calls.push(name);
  };
  const makePage = () => ({
    url: () => state.url,
    isClosed: () => state.closed,
    on(name, fn) {
      handlers.page[name] = fn;
    },
    title: async () => state.title,
    evaluate: async () => state.dom,
    opener: async () => state.opener,
    goto: forbidden("goto"),
    reload: forbidden("reload"),
    bringToFront: forbidden("bringToFront"),
    click: forbidden("click"),
    fill: forbidden("fill"),
  });
  const page = makePage();
  const pages = [page];
  const sent = [];
  const context = {
    pages: () => pages.filter((p) => !p.isClosed()),
    on(name, fn) {
      handlers.context[name] = fn;
    },
    browser: () => ({
      async newBrowserCDPSession() {
        return {
          async send(method, args) {
            sent.push(method);
            if (method === "Target.getTargets") return { targetInfos: pages.map((_, i) => ({ type: "page", targetId: `t${i}`, title: "SECRET TITLE" })) };
            if (method === "Browser.getWindowForTarget") return { windowId: args.targetId === "t0" ? 1 : 2, bounds: { windowState: "normal" } };
            return {};
          },
          async detach() {},
        };
      },
    }),
  };
  return { page, pages, context, state, handlers, calls, sent, makePage };
}

test("describeNativeSnapshot reports only the front window's role and sign-in broker names, never other programs", () => {
  const seen = describeNativeSnapshot({ bw: 1, bmin: 0, fg: "notepad", others: ["CredentialUIBroker", "msedge", "Slack"] });
  assert.deepEqual(seen, { browserWindows: 1, browserMinimized: 0, front: "another-app", brokerWindows: ["CredentialUIBroker"], otherEdgeWindows: 1 });
  assert.ok(!JSON.stringify(seen).includes("notepad") && !JSON.stringify(seen).includes("Slack"));
  assert.equal(describeNativeSnapshot({ bw: 1, bmin: 0, fg: "browser", others: [] }).front, "browser");
  assert.equal(describeNativeSnapshot({ bw: 1, bmin: 0, fg: "msedge", others: "msedge" }).front, "another-edge-window");
  assert.equal(describeNativeSnapshot({ bw: 0, bmin: 1, fg: "explorer", others: [] }).front, "desktop");
  assert.equal(describeNativeSnapshot({ bw: 1, bmin: 0, fg: "LogonUI", others: [] }).front, "LogonUI");
  assert.equal(describeNativeSnapshot(null), null);
});

test("the surface watch records tabs, popups, a blank sign-in page, focus, and sign-in broker windows without touching the page or reading its text", async () => {
  const world = fakeSurfaceWorld();
  const trace = createTrace({ file: null });
  const native = { browserWindows: 1, browserMinimized: 0, front: "browser", brokerWindows: [], otherEdgeWindows: 0 };
  let turn = 0;
  const steps = [
    () => {
      native.front = "another-app"; // the window gets covered
    },
    () => {
      world.state.opener = {}; // a popup opens
      const popup = world.makePage();
      world.pages.push(popup);
      world.handlers.context.page(popup);
    },
    () => {
      world.state.dom = { visibility: "visible", focused: true, ready: "complete", elements: 2, inputs: 0, buttons: 0, frames: 0 }; // the page empties
    },
    () => {},
    () => {
      native.brokerWindows = ["CredentialUIBroker"]; // a Windows account window appears
    },
    () => {},
  ];
  const sleep = async () => {
    steps[turn]?.();
    turn += 1;
    await nextTurn();
  };
  const watch = createSurfaceWatch({ context: world.context, pid: 4242, trace, sleep, nativeProbe: () => ({ latest: () => ({ ...native }), stop() {} }) });
  watch.start();
  for (let i = 0; i < 200 && turn < steps.length; i += 1) await nextTurn();
  assert.equal(watch.isCovered(), true, "the browser window is behind another program");
  const summary = await watch.stop();

  assert.deepEqual(world.calls, [], "the page was only observed: no navigation, reload, click, typing, or bringing it to the front");
  assert.equal(summary.popupsOpened, 1);
  assert.ok(summary.maxTabs >= 2 && summary.maxWindows >= 1);
  assert.equal(summary.blankOnSignIn?.why, "blank-document");
  assert.deepEqual(summary.brokers, ["CredentialUIBroker"]);
  assert.ok(summary.covered.includes("another-app"));
  assert.equal(summary.lostFocus, 1);
  const written = trace.lines.join("\n");
  for (const name of ["surface-tab-opened", "surface-windows", "surface-sign-in-surface-gone", "surface-native", "surface-watch-summary"]) assert.ok(written.includes(name), `the trace has ${name}`);
  assert.ok(written.includes('"popup":true'));
  assert.ok(!written.includes("SECRET TITLE") && !written.includes("Sign in to your account"), "titles and page text are never written, only whether the title is empty");
  assert.match(written, /"titleEmpty":false/);
  const lines = describeSurface(summary).join("\n");
  assert.match(lines, /popup/);
  assert.match(lines, /went blank \(an empty document\).*did not reload it/);
  assert.match(lines, /Windows sign-in window was open \(CredentialUIBroker\)/);
  assert.match(lines, /lost focus 1 time/);
  await watch.stop();
  assert.equal(trace.lines.filter((l) => l.includes("surface-watch-summary")).length, 1, "stopping twice writes one summary");
});

test("a page that only changes screens, or a sign-in form that comes back, is not reported as a vanished sign-in box", async () => {
  const world = fakeSurfaceWorld();
  const trace = createTrace({ file: null });
  let turn = 0;
  const steps = [
    () => {
      world.state.dom = { ...world.state.dom, inputs: 0, buttons: 0, elements: 2 }; // one empty sample
    },
    () => {
      world.state.dom = { visibility: "visible", focused: true, ready: "complete", elements: 80, inputs: 2, buttons: 1, frames: 0 }; // and it is back
    },
    () => {},
    () => {},
  ];
  const watch = createSurfaceWatch({ context: world.context, trace, nativeProbe: () => null, sleep: async () => { steps[turn]?.(); turn += 1; await nextTurn(); } });
  watch.start();
  for (let i = 0; i < 200 && turn < steps.length; i += 1) await nextTurn();
  const summary = await watch.stop();
  assert.equal(summary.blankOnSignIn, null);
  assert.ok(!trace.lines.join("\n").includes("surface-sign-in-surface-gone"));
});

test("--check-signin brings the window forward once before sign-in begins, watches the window, and tells the person when it is behind other windows", async (t) => {
  const home = tmpDir(t);
  const dir = path.join(home, ".auth", "edge", "copilot-studio");
  fs.mkdirSync(dir, { recursive: true });
  const world = fakeOpen(SIGN_IN_FLOW, { dir });
  const log = collectLog();
  const covered = { browserWindows: 1, browserMinimized: 0, front: "another-app", brokerWindows: [], otherEdgeWindows: 0 };
  const outcome = await runCheckSignIn({ home, product: "copilot-studio", playwright: {}, kinds: ["edge"], open: world.open, resolved: { source: "default", synced: { synced: false } }, log, signInWaitSec: 600, sleepFn: world.flow.sleep, deps: { device: () => null, skew: async () => null, surface: { nativeProbe: () => ({ latest: () => covered, stop() {} }) } } });
  assert.equal(outcome.ok, true);
  assert.deepEqual(world.flow.calls.filter((c) => c !== "evaluate"), ["bringToFront"], "one bring-to-front, at startup, and nothing else touched the page");
  assert.deepEqual(world.gotos, [APP]);
  const text = log.text();
  assert.match(text, /behind other windows right now/, "the person is told where the window may be");
  assert.match(text, /Window: up to 1 tab, no popups\./);
  const trace = fs.readFileSync(outcome.traceFile, "utf8");
  assert.equal((trace.match(/"event":"window-raise"/g) || []).length, 1);
  assert.ok(trace.includes("surface-watch-summary"));
});

test("a browser that rearranges its first tabs is given a moment to settle, and a debug port that never answers is given up on in real time", async () => {
  const states = [1, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1];
  let reads = 0;
  const context = { pages: () => Array.from({ length: states[Math.min(reads++, states.length - 1)] }, () => ({ isClosed: () => false })) };
  const trace = createTrace({ file: null });
  const settled = await settleTabs(context, { sleep: instant, trace });
  assert.deepEqual(settled, { tabs: 1, settled: true });
  assert.ok(reads >= 8, "it kept looking until the number of tabs stopped changing");
  assert.ok(trace.lines.join("\n").includes("attach-tabs-settled"));
  assert.equal((await settleTabs({ pages: () => { throw new Error("gone"); } }, { sleep: instant })).tabs, -1, "a context that cannot be read is not a reason to fail");

  const world = fakeBrowserWorld();
  const slow = async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
    throw new Error("connection reset");
  };
  const started = Date.now();
  await assert.rejects(launchAttached({ playwright: world.playwright, kind: "edge", dir: fs.mkdtempSync(path.join(os.tmpdir(), "ep-")), executable: "C:\\edge.exe", ...world.options, fetchFn: slow, timeoutMs: 200, pollMs: 1, endpointSlackMs: 0 }), (err) => err.code === "NO_DEBUG_PORT");
  assert.ok(Date.now() - started < 3000, "200 attempts of 60 ms each would take 12 seconds; the real clock ended it");
  await closeAllAttached();
});

test("a path segment that holds an id (the default environment is Default- plus the tenant id) is masked", () => {
  assert.equal(cleanPathSegment("Default-9a35777a-28ce-467a-92be-0cf503f7e030"), "Default-{id}");
  assert.equal(cleanPathForReport("/environments/Default-9a35777a-28ce-467a-92be-0cf503f7e030/home"), "/environments/Default-{id}/home");
  assert.equal(cleanPathSegment("~personal"), "~personal");
});

// ── Inside a job ─────────────────────────────────────────────────────────────

function jobClaim(filenames) {
  const shots = filenames.map((filename) => ({
    filename, shotId: filename, featureId: "f", moduleTitle: "M", product: "copilot-studio", authProfile: "copilot-studio", startUrl: APP, viewport: { width: 1280, height: 720 }, manual: false, requiresEnv: null, expectedLabels: ["Settings"], callouts: [],
    steps: [{ action: "navigate", url: APP }, { action: "screenshot" }],
  }));
  return { job: { id: "job_00000000000000cc", target: { type: "library", products: [] }, scope: {}, options: { callouts: "none", redact: true }, createdAt: new Date().toISOString(), resumed: false }, env: {}, shots };
}

function jobClient() {
  const calls = { completes: [], statuses: [] };
  return {
    calls,
    async heartbeat() { return {}; },
    async progress(_id, body) {
      if (body.shot) calls.statuses.push({ ...body.shot });
      return { ok: true };
    },
    async upload() { return { status: 200, body: { outcome: "accepted" } }; },
    async complete(_id, body) { calls.completes.push(body); return {}; },
  };
}

test("a job whose sign-in loops stops, explains why, tells the portal, and keeps the window open until it is closed", async (t) => {
  const home = tmpDir(t);
  let reads = 0;
  const fake = createFakePlaywright({ rewriteUrl: () => (reads++ % 2 === 0 ? APP : LOGIN) });
  const client = jobClient();
  const log = collectLog();
  const diagnoser = async ({ code, bounces }) => diagnoseSignIn({ code, bounces, aadsts: "AADSTS50196", synced: { synced: true, provider: "OneDrive" }, product: "copilot-studio" });
  const result = await runJob({ client, claimed: jobClaim(["a.png", "b.png"]), home, playwright: fake.playwright, options: { authSettleMs: 0, authPollMs: 5, authGraceMs: 0, authConfirmMs: 20, browserKinds: ["chromium"], signInDiagnoser: diagnoser, keepOpenMs: 3000, attended: true }, log, sleepFn: instant, heartbeatMs: 60_000 });
  assert.equal(result.signInFailures[0].code, "ping-pong");
  assert.equal(result.tally.failed, 2);
  assert.equal(fake.log.screenshots, 0, "no picture was taken of a sign-in page");
  assert.equal(fake.log.goto.length, 1, "the page was opened once, not again for the second shot");
  const text = log.text();
  assert.match(text, /kept bouncing between Microsoft Copilot Studio and the sign-in page/);
  assert.match(text, /Things that can cause this/);
  assert.match(text, /The sign-in files are in a synced folder \(likely\)/);
  assert.match(text, /--check-signin=copilot-studio/);
  assert.match(text, /The browser window stays open so you can look at it/);
  assert.equal(fake.log.closed, 1, "the window closed after the wait");
  const done = client.calls.completes.at(-1);
  assert.equal(done.signIn.code, "ping-pong");
  assert.equal(done.signIn.aadsts, "AADSTS50196");
  assert.equal(done.signIn.product, "copilot-studio");
  assert.ok(done.signIn.checks.some((c) => c.id === "synced-profile" && c.level === "likely"));
  assert.ok(client.calls.statuses.some((s) => s.status === "auth-required" && /Use a local folder/.test(s.error)), "each shot carries the next step");
});

test("a sign-in that merely times out closes its window and reports a diagnosis too, with nothing kept open", async (t) => {
  const home = tmpDir(t);
  const fake = createFakePlaywright({ rewriteUrl: () => LOGIN });
  const client = jobClient();
  const result = await runJob({ client, claimed: jobClaim(["a.png"]), home, playwright: fake.playwright, options: { authSettleMs: 0, authPollMs: 5, authGraceMs: 0, signInWaitSec: 0.1, browserKinds: ["chromium"], signInDiagnoser: async ({ code }) => diagnoseSignIn({ code, product: "copilot-studio" }) }, log: collectLog(), sleepFn: instant, heartbeatMs: 60_000 });
  assert.equal(result.signInFailures[0].code, "timeout");
  assert.equal(fake.log.closed, 1);
  assert.equal(client.calls.completes.at(-1).signIn.code, "timeout");
});

// ── The command line ─────────────────────────────────────────────────────────

test("the new options parse, and the version and help describe them", () => {
  assert.equal(COMPANION_VERSION, "1.6.0");
  assert.equal(parseArgs(["--check-signin"]).checkSignin, "copilot-studio");
  assert.equal(parseArgs(["--check-signin", "ai-foundry"]).checkSignin, "ai-foundry");
  assert.equal(parseArgs(["--check-signin=sharepoint-ai", "--launch=attach"]).checkSignin, "sharepoint-ai");
  assert.equal(parseArgs(["--check-signin", "--debug"]).checkSignin, "copilot-studio", "a following option is not taken for the product");
  assert.match(parseArgs(["--check-signin=../x"]).error, /--check-signin needs a product name/);
  assert.equal(parseArgs([]).launch, "auto");
  assert.equal(parseArgs(["--launch=playwright"]).launch, "playwright");
  assert.match(parseArgs(["--launch=fast"]).error, /--launch must be/);
  assert.equal(parseArgs(["--allow-synced-home"]).allowSyncedHome, true);
  assert.equal(parseArgs(["--delete-old-signin"]).deleteOldSignin, true);
  for (const word of ["--check-signin", "--launch=auto|attach|playwright", "--allow-synced-home", "--delete-old-signin"]) assert.ok(helpText().includes(word), `help mentions ${word}`);
});

test("the companion download carries every new module", async () => {
  const { COMPANION_FILES } = await import("../../../portal/lib/capture/companion-zip.js");
  for (const file of ["home.mjs", "attach.mjs", "check-signin.mjs", "signin-diagnosis.mjs", "signin-url.mjs"]) assert.ok(COMPANION_FILES.includes(`tools/screenshot-capture/${file}`), file);
  // Every module the companion imports from this folder is in the download.
  const wanted = new Set();
  for (const entry of COMPANION_FILES.filter((f) => f.startsWith("tools/screenshot-capture/") && f.endsWith(".mjs"))) {
    const source = fs.readFileSync(path.resolve(TOOL_DIR, "..", "..", entry), "utf8");
    for (const match of source.matchAll(/from "\.\/([a-z0-9-]+\.mjs)"/g)) wanted.add(`tools/screenshot-capture/${match[1]}`);
  }
  for (const file of wanted) assert.ok(COMPANION_FILES.includes(file), `${file} is imported by the companion but missing from the download`);
});
