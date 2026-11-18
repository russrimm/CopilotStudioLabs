// The "Next time, start it with: ..." lines: built from the launcher's real location, quoted for the person's shell,
// printed after pairing and when an already-paired companion starts, and never carrying the pairing code or the token.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { EXIT, runCompanion } from "../companion.mjs";
import { quoteCmd, quotePosix, quotePowerShell, startAgainLines } from "../start-hint.mjs";
import { createFakePlaywright } from "./fixtures/fake-playwright.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const TOOL_DIR = path.resolve(here, "..");
const TOKEN = "cap_FAKE_TOKEN_FOR_START_HINT_0123456789abcdef";
const CODE = "ABCD-EFGH";
const ready = async () => ({ ok: true, problems: [] });

function tmpDir(t, prefix = "start hint ") {
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

async function startFakePortal(t) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    const url = new URL(req.url, "http://127.0.0.1");
    const send = (status, payload) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(payload === null ? undefined : JSON.stringify(payload));
    };
    if (url.pathname === "/api/capture/companion/pair") return send(201, { token: TOKEN, device: { id: "dev_abcdefabcdef", name: body.deviceName } });
    if (url.pathname === "/api/capture/companion/heartbeat") return send(200, { ok: true, tokenExpiresAt: "2030-01-01T00:00:00.000Z" });
    if (url.pathname === "/api/capture/companion/next") return send(204, null);
    return send(404, { error: "unknown" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

/** A launcher file for this platform inside a folder with spaces, like a OneDrive download. */
function stageLauncher(t) {
  const dir = path.join(tmpDir(t), "OneDrive - Contoso", "copilot-studio-labs-capture-companion", "capture-companion", "tools", "screenshot-capture");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, process.platform === "win32" ? "start-companion.cmd" : "start-companion.sh");
  fs.writeFileSync(file, "");
  return file;
}

// ── The helper ──────────────────────────────────────────────────────────────

test("Windows: PowerShell and Command Prompt lines hold the launcher's full path, quoted, and never a pairing code", () => {
  const launcher = "C:\\Users\\Ada\\OneDrive - Contoso\\copilot-studio-labs-capture-companion\\capture-companion\\tools\\screenshot-capture\\start-companion.cmd";
  const lines = startAgainLines({ env: { COMPANION_LAUNCHER: launcher }, platform: "win32", entry: "C:\\x\\companion.mjs", exists: () => true });
  assert.deepEqual(lines, [`Next time, start it from any folder with: & '${launcher}'`, `In Command Prompt (cmd.exe), use: "${launcher}"`]);
  assert.ok(lines.every((line) => !/ABCD|--code|--portal|cap_/.test(line)));

  const ps1 = "C:\\Users\\Ada\\pack\\start-companion.ps1";
  assert.deepEqual(startAgainLines({ env: { COMPANION_LAUNCHER: ps1 }, platform: "win32", exists: () => true }), [`Next time, start it from any folder with: & '${ps1}'`], "a PowerShell launcher is started by PowerShell");

  const tricky = "C:\\Users\\O\u2019Brien\\it's 100%\\start-companion.cmd";
  assert.deepEqual(startAgainLines({ env: { COMPANION_LAUNCHER: tricky }, platform: "win32", exists: () => true }), [`Next time, start it from any folder with: & 'C:\\Users\\O\u2019\u2019Brien\\it''s 100%\\start-companion.cmd'`], "quotes are doubled, and Command Prompt would expand the %, so that line is left out");
});

test("macOS and Linux: one quoted line, with an apostrophe escaped", () => {
  const launcher = "/Users/ada/My Files/it's/capture-companion/tools/screenshot-capture/start-companion.sh";
  assert.deepEqual(startAgainLines({ env: { COMPANION_LAUNCHER: launcher }, platform: "darwin", exists: () => true }), [`Next time, start it from any folder with: '/Users/ada/My Files/it'\\''s/capture-companion/tools/screenshot-capture/start-companion.sh'`]);
});

test("started by hand with node, the line names the node form with the real path of companion.mjs", () => {
  assert.deepEqual(startAgainLines({ env: {}, platform: "win32", entry: "C:\\a b\\companion.mjs" }), [`Next time, start it from any folder with: node 'C:\\a b\\companion.mjs'`, `In Command Prompt (cmd.exe), use: node "C:\\a b\\companion.mjs"`]);
  assert.deepEqual(startAgainLines({ env: {}, platform: "linux", entry: "/opt/a b/companion.mjs" }), [`Next time, start it from any folder with: node '/opt/a b/companion.mjs'`]);
  assert.deepEqual(startAgainLines({ env: {}, platform: "linux", entry: "" }), [], "with nothing to point at, nothing is printed");
});

test("a launcher path that is missing, relative, hidden-character, or not a launcher is ignored", () => {
  const entry = "/opt/c/companion.mjs";
  const node = ["Next time, start it from any folder with: node '/opt/c/companion.mjs'"];
  const run = (value, exists = () => true) => startAgainLines({ env: { COMPANION_LAUNCHER: value }, platform: "linux", entry, exists });
  assert.deepEqual(run("/opt/c/start-companion.sh", () => false), node, "a launcher that is not on disk");
  assert.deepEqual(run("start-companion.sh"), node, "a relative path");
  assert.deepEqual(run("/opt/c/start-companion.sh\nrm -rf /"), node, "a line break");
  assert.deepEqual(run("/opt/c/\u202esh.noinapmoc-trats"), node, "a bidirectional override");
  assert.deepEqual(run("/opt/c/other.sh"), node, "a file that is not one of the launchers");
  assert.deepEqual(run("/opt/c/start-companion.sh; rm -rf /"), node, "text after the file name");
  assert.deepEqual(run(`/${"a".repeat(2000)}/start-companion.sh`), node, "an oversized value");
  assert.deepEqual(run(undefined), node);
  assert.deepEqual(run({ toString: () => "/opt/c/start-companion.sh" }), node, "something that is not a string");
});

test("each shell's quoting keeps a value as one word", () => {
  assert.equal(quotePowerShell("a b's"), "'a b''s'");
  assert.equal(quotePowerShell("\u2018x\u2019"), "'\u2018\u2018x\u2019\u2019'");
  assert.equal(quoteCmd("C:\\a b\\x"), '"C:\\a b\\x"');
  assert.equal(quotePosix("a b's"), "'a b'\\''s'");
  assert.equal(quotePosix("$(id) `id` ;"), "'$(id) `id` ;'");
});

// ── The program ─────────────────────────────────────────────────────────────

test("a fresh run prints the full launcher path after pairing, and an already-paired start prints it too; the code is never printed", async (t) => {
  const launcher = stageLauncher(t);
  const portal = await startFakePortal(t);
  const home = tmpDir(t, "home ");
  const startHint = { env: { COMPANION_LAUNCHER: launcher } };
  const quoted = process.platform === "win32" ? quotePowerShell(launcher) : quotePosix(launcher);
  const expected = process.platform === "win32" ? `Next time, start it from any folder with: & ${quoted}` : `Next time, start it from any folder with: ${quoted}`;
  const deps = { preflight: ready, playwright: createFakePlaywright().playwright, noSignals: true, nonInteractive: true, startHint };

  const first = collectLog();
  assert.equal(await runCompanion([`--portal=${portal}`, `--code=${CODE}`, "--once", `--home=${home}`, "--device-name=Ada PC"], { ...deps, log: first }), EXIT.ok);
  const lines = first.lines;
  assert.equal(lines.filter((l) => l === expected).length, 1, `the line appears once, with the real path:\n${first.text()}`);
  assert.ok(lines.indexOf(expected) > lines.findIndex((l) => /^Paired with /.test(l)), "it comes right after the pairing");
  assert.ok(first.text().includes(launcher), "the full launcher path is printed");
  assert.doesNotMatch(first.text(), new RegExp(`${CODE}|${TOKEN}`), "neither the pairing code nor the token is printed");
  assert.ok(lines.filter((l) => l.includes("Next time")).every((l) => !l.includes("--")), "the line is only the way to start it");

  const again = collectLog();
  assert.equal(await runCompanion(["--once", `--home=${home}`], { ...deps, log: again }), EXIT.ok);
  assert.equal(again.lines.filter((l) => l === expected).length, 1, "an already-paired start prints it once too");
  assert.doesNotMatch(again.text(), /Paired with/);
  assert.doesNotMatch(again.text(), new RegExp(`${CODE}|${TOKEN}`));
});

test("started with node directly, the banner names the node form with the path of companion.mjs", async (t) => {
  const portal = await startFakePortal(t);
  const home = tmpDir(t, "home ");
  const log = collectLog();
  const code = await runCompanion([`--portal=${portal}`, `--code=${CODE}`, "--once", `--home=${home}`], { log, preflight: ready, playwright: createFakePlaywright().playwright, noSignals: true, nonInteractive: true, startHint: { env: {} } });
  assert.equal(code, EXIT.ok);
  const entry = path.join(TOOL_DIR, "companion.mjs");
  const node = process.platform === "win32" ? `node ${quotePowerShell(entry)}` : `node ${quotePosix(entry)}`;
  assert.ok(log.lines.includes(`Next time, start it from any folder with: ${node}`), log.text());
  assert.doesNotMatch(log.text(), new RegExp(`${CODE}|${TOKEN}`));
});

test("nothing about where the companion lives is sent to the portal", async (t) => {
  const launcher = stageLauncher(t);
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({ url: req.url, headers: JSON.stringify(req.headers), body: Buffer.concat(chunks).toString() });
    const url = new URL(req.url, "http://127.0.0.1");
    res.writeHead(url.pathname.endsWith("/next") ? 204 : url.pathname.endsWith("/pair") ? 201 : 200, { "Content-Type": "application/json" });
    res.end(url.pathname.endsWith("/next") ? undefined : JSON.stringify(url.pathname.endsWith("/pair") ? { token: TOKEN, device: { id: "dev_abcdefabcdef", name: "x" } } : { ok: true, tokenExpiresAt: "2030-01-01T00:00:00.000Z" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const home = tmpDir(t, "home ");
  await runCompanion([`--portal=http://127.0.0.1:${server.address().port}`, `--code=${CODE}`, "--once", `--home=${home}`], { log: collectLog(), preflight: ready, playwright: createFakePlaywright().playwright, noSignals: true, nonInteractive: true, startHint: { env: { COMPANION_LAUNCHER: launcher } } });
  assert.ok(seen.length >= 3, "the companion paired, checked in, and asked for a job");
  const everything = JSON.stringify(seen);
  assert.ok(!everything.includes("OneDrive") && !everything.includes("start-companion") && !everything.includes("COMPANION_LAUNCHER"), "no path or launcher name goes to the portal");
});
