/**
 * The ready-made start command, end to end: the pairing API's launcher paths match the ZIP, README-FIRST.txt uses the
 * same wording and paths as the Screenshot Center, and the displayed commands really start the launchers.
 * The launcher tests copy the real launcher scripts next to a stub companion, in folders with spaces (as OneDrive has),
 * and run the exact text the Screenshot Center displays, from a different working directory.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { inflateRawSync } from "node:zlib";

import { buildCompanionZip, COMPANION_FILES, COMPANION_LAUNCHER } from "../lib/capture/companion-zip.js";
import { buildPairingCommands } from "../lib/capture/start-command.js";

const TOOL_DIR = new URL("../../tools/screenshot-capture/", import.meta.url);
const COMMAND_SOURCE = readFileSync(new URL("../public/screenshot-center-command.js", import.meta.url), "utf8");
const PORTAL = "http://localhost:3025";
const CODE = "ABCD-EFGH";
const ARGV = [`--portal=${PORTAL}`, `--code=${CODE}`];

function builder() {
  const context = { navigator: {}, console };
  vm.createContext(context);
  vm.runInContext(COMMAND_SOURCE, context);
  const launcher = JSON.parse(JSON.stringify(COMPANION_LAUNCHER));
  return {
    relative: (shell) => context.scCmdBuild({ shell, launcher, portalUrl: PORTAL, code: CODE, folder: null }),
    absolute(shell, folder) {
      const parsed = context.scCmdParseFolder(folder, shell);
      assert.equal(parsed.state, "ok", `${folder} is accepted for ${shell}`);
      return context.scCmdBuild({ shell, launcher, portalUrl: PORTAL, code: CODE, folder: parsed.folder });
    },
  };
}

test("the pairing API's launcher paths are the ones inside the ZIP, and each is shown by README-FIRST.txt", async () => {
  const { command, launcher } = buildPairingCommands({ portalUrl: PORTAL, code: CODE });
  assert.equal(command, `.\\capture-companion\\tools\\screenshot-capture\\start-companion.cmd ${ARGV.join(" ")}`);
  assert.deepEqual(Object.keys(launcher), ["relativeDir", "windows", "powershell", "posix"]);
  const { buffer, files } = await buildCompanionZip();
  for (const key of ["windows", "powershell", "posix"]) assert.ok(files.includes(launcher[key]), `${launcher[key]} is a file in the ZIP`);
  assert.ok(files.includes(`${launcher.relativeDir}/companion.mjs`), "the launchers sit beside companion.mjs");
  assert.ok(files.includes(`${launcher.relativeDir}/start-hint.mjs`), "the module that prints the start-again line ships too");
  assert.ok(COMPANION_FILES.includes("tools/screenshot-capture/start-hint.mjs"));

  const text = readZip(buffer).get("capture-companion/README-FIRST.txt").toString("utf8");
  const { relative } = builder();
  const placeholders = "--portal=<portal address> --code=<pairing code>";
  assert.ok(text.includes(relative("windows").replace(ARGV.join(" "), placeholders)), "README-FIRST shows the Windows command the portal shows");
  assert.ok(text.includes(relative("posix").replace(ARGV.join(" "), placeholders)), "and the macOS and Linux command");
  assert.match(text, /from the folder where you unzipped\s+the companion/);
  assert.match(text, /start with & and put the path in single quotes/);
  assert.match(text, /start-companion\.cmd, start-companion\.ps1, and start-companion\.sh/);
  assert.match(text, /prints the full command to\s+start it again/);
  assert.doesNotMatch(text, /\b(colour|behaviour|centre|licence|organis|catalogue|favourite)\w*/i, "US English only");
});

/** Entries of a ZIP, read through its central directory. */
function readZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i += 1) {
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nlen = buf.readUInt16LE(off + 28);
    const elen = buf.readUInt16LE(off + 30);
    const clen = buf.readUInt16LE(off + 32);
    const local = buf.readUInt32LE(off + 42);
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(dataStart, dataStart + csize);
    entries.set(buf.toString("utf8", off + 46, off + 46 + nlen), method === 8 ? inflateRawSync(data) : data);
    off += 46 + nlen + elen + clen;
  }
  return entries;
}

// ── The launchers, run with the displayed text ──────────────────────────────

const STUB_COMPANION = [
  'if (process.argv.includes("--check")) process.exit(0);',
  "console.log(JSON.stringify({ args: process.argv.slice(2), launcher: process.env.COMPANION_LAUNCHER || null, cwd: process.cwd() }));",
  "",
].join("\n");

/** The ZIP's layout in folders with spaces, the real launchers beside a stub companion, and a fake playwright folder. */
function stage(t) {
  const base = mkdtempSync(path.join(tmpdir(), "start hint "));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "OneDrive - Contoso", "Downloads", "copilot-studio-labs-capture-companion");
  const dir = path.join(root, "capture-companion", "tools", "screenshot-capture");
  mkdirSync(path.join(dir, "node_modules", "playwright"), { recursive: true });
  for (const name of ["start-companion.cmd", "start-companion.ps1", "start-companion.sh"]) {
    // The ZIP ships .cmd and .ps1 with CRLF and .sh with LF; do the same here.
    const raw = readFileSync(new URL(name, TOOL_DIR), "utf8");
    const text = name.endsWith(".sh") ? raw.replace(/\r\n/g, "\n") : raw.replace(/\r?\n/g, "\r\n");
    writeFileSync(path.join(dir, name), text);
  }
  chmodSync(path.join(dir, "start-companion.sh"), 0o755);
  writeFileSync(path.join(dir, "companion.mjs"), STUB_COMPANION);
  const elsewhere = mkdtempSync(path.join(tmpdir(), "elsewhere "));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
  return { root, dir, elsewhere };
}

function lastJson(result) {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const line = result.stdout.trim().split(/\r?\n/).filter((l) => l.startsWith("{")).at(-1);
  assert.ok(line, `the stub companion printed its arguments: ${result.stdout}`);
  return JSON.parse(line);
}

const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

test("Windows: the displayed PowerShell, Command Prompt, and relative commands start the launcher with the exact arguments", { skip: process.platform !== "win32" }, (t) => {
  const { root, dir, elsewhere } = stage(t);
  const { relative, absolute } = builder();
  const powershell = (command, cwd) => spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command], { encoding: "utf8", cwd, timeout: 90000 });
  const expectStarted = (result, launcherFile) => {
    const out = lastJson(result);
    assert.deepEqual(out.args, ARGV, "the portal and the code arrive as two arguments, untouched");
    assert.ok(same(out.launcher, path.join(dir, launcherFile)), `COMPANION_LAUNCHER is the launcher's full path: ${out.launcher}`);
    assert.ok(same(out.cwd, dir), "the launcher starts the companion from its own folder");
  };

  // The default form, from the unzip folder.
  expectStarted(powershell(relative("windows"), root), "start-companion.cmd");

  // The full path from a different folder: PowerShell (a path with spaces needs & and quotes) and Command Prompt.
  const shown = absolute("windows", root);
  assert.match(shown, /^& '.* .*start-companion\.cmd' --portal=/, "the path has spaces, so it is quoted with the call operator");
  expectStarted(powershell(shown, elsewhere), "start-companion.cmd");
  const cmdShown = absolute("cmd", root);
  expectStarted(spawnSync("cmd.exe", ["/d", "/s", "/c", `"${cmdShown}"`], { encoding: "utf8", cwd: elsewhere, timeout: 90000, windowsVerbatimArguments: true }), "start-companion.cmd");
  expectStarted(spawnSync("cmd.exe", ["/d", "/s", "/c", `"${relative("cmd")}"`], { encoding: "utf8", cwd: root, timeout: 90000, windowsVerbatimArguments: true }), "start-companion.cmd");

  // Forward slashes, a trailing separator, and the inner folder all reach the same launcher.
  for (const typed of [`${root.replace(/\\/g, "/")}/`, path.join(root, "capture-companion"), dir]) {
    expectStarted(powershell(absolute("windows", typed), elsewhere), "start-companion.cmd");
  }

  // The PowerShell launcher, started the same way, and it leaves no environment variable behind.
  const ps1 = `& '${path.join(dir, "start-companion.ps1")}' ${ARGV.join(" ")}`;
  const result = powershell(`${ps1}; Write-Output ('[' + $env:COMPANION_LAUNCHER + ']')`, elsewhere);
  expectStarted(result, "start-companion.ps1");
  assert.match(result.stdout, /\[\]\s*$/, "the variable is removed when the launcher ends");
});

test("Windows: the launchers pass awkward arguments through whole", { skip: process.platform !== "win32" }, (t) => {
  const { dir, elsewhere } = stage(t);
  const awkward = ["--device-name=Ada's PC (work)", "--mask=Contoso & Sons,100% real", "--home=C:\\Users\\Ada Lovelace\\OneDrive - X\\data"];
  const powershell = (command) => spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command], { encoding: "utf8", cwd: elsewhere, timeout: 90000 });
  const quoted = awkward.map((a) => `'${a.replace(/'/g, "''")}'`).join(" ");
  for (const file of ["start-companion.cmd", "start-companion.ps1"]) {
    const out = lastJson(powershell(`& '${path.join(dir, file)}' ${ARGV.join(" ")} ${quoted}`));
    assert.deepEqual(out.args, [...ARGV, ...awkward], file);
  }
});

test("macOS and Linux: the displayed commands start the launcher from any folder", { skip: process.platform === "win32" }, (t) => {
  const { root, dir, elsewhere } = stage(t);
  const { relative, absolute } = builder();
  const sh = (command, cwd) => spawnSync("sh", ["-c", command], { encoding: "utf8", cwd, timeout: 60000 });
  const expectStarted = (result) => {
    const out = lastJson(result);
    assert.deepEqual(out.args, ARGV);
    assert.equal(out.launcher, path.join(dir, "start-companion.sh"));
    assert.equal(out.cwd, dir);
  };
  expectStarted(sh(relative("posix"), root));
  expectStarted(sh(absolute("posix", root), elsewhere));
  expectStarted(sh(absolute("posix", `${root}/`), elsewhere));
});
