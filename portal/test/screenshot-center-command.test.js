/**
 * The "Or run this ready-made command" step of the pairing card: the operating-system-aware command with the
 * launcher's path, the optional "Where did you unzip the companion?" folder, and the safety of what it shows.
 * The real browser scripts run in node:vm against the fake DOM, with a fake fetch and clipboard.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

import { buildPairingCommands } from "../lib/capture/start-command.js";
import { createFakeDom } from "./fixtures/fake-dom.js";

const publicFile = (name) => readFileSync(new URL(`../public/${name}`, import.meta.url), "utf8");
const SOURCES = ["screenshot-center-core.js", "screenshot-center-command.js", "screenshot-center-jobs.js", "screenshot-center.js"].map(publicFile);
const COMMAND_SOURCE = publicFile("screenshot-center-command.js");
const INDEX_HTML = publicFile("index.html");

const PORTAL = "https://portal.example";
const CODE = "ABCD-EFGH";
const DIR_WIN = "capture-companion\\tools\\screenshot-capture";
const FILE_WIN = `${DIR_WIN}\\start-companion.cmd`;
const FILE_POSIX = "capture-companion/tools/screenshot-capture/start-companion.sh";
const ARGS = `--portal=${PORTAL} --code=${CODE}`;
const RELATIVE_WINDOWS = `.\\${FILE_WIN} ${ARGS}`;
const RELATIVE_POSIX = `./${FILE_POSIX} ${ARGS}`;
const STORAGE_KEY = "sc-companion-folder";
const OK_COMMAND = "Command copied to your clipboard";
const COPY_FAILED = "Couldn't copy. Select the command and press Ctrl+C.";

const pairReply = (extra = {}) => ({
  status: 201,
  body: { code: CODE, expiresAt: new Date(Date.now() + 600000).toISOString(), expiresInSec: 600, portalUrl: PORTAL, ...buildPairingCommands({ portalUrl: PORTAL, code: CODE }), ...extra },
});

const WINDOWS = { userAgentData: { platform: "Windows" }, platform: "Win32" };
const MAC = { userAgentData: { platform: "macOS" }, platform: "MacIntel" };
const LINUX = { platform: "Linux x86_64" };

function makeHarness({ nav = WINDOWS, reply = pairReply(), storage = new Map() } = {}) {
  const { document, FakeEvent } = createFakeDom();
  const add = (id, attrs = {}) => {
    const el = document.createElement("div");
    el.id = id;
    for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
    document.body.appendChild(el);
    return el;
  };
  const live = add("app-live");
  const host = add("pair-host", { "data-sc-pairing-host": "build" });
  const h = { document, host, live, copied: [], calls: [], storage, writeFails: false, reply, FakeEvent };
  const context = {
    document,
    window: { addEventListener() {} },
    fetch: async (url, init = {}) => {
      const method = String(init.method || "GET").toUpperCase();
      h.calls.push({ method, url: String(url), body: typeof init.body === "string" ? init.body : null });
      const status = method === "POST" && /\/api\/capture\/pair$/.test(url) ? h.reply : { status: 200, body: { companion: { devices: [], downloadUrl: "/api/capture/companion.zip" } } };
      return { ok: status.status < 300, status: status.status, json: async () => status.body };
    },
    setTimeout: () => ({ unref() {} }),
    clearTimeout() {},
    setInterval: () => ({ unref() {} }),
    clearInterval() {},
    navigator: {
      ...nav,
      clipboard: {
        writeText: async (text) => {
          if (h.writeFails) throw new Error("NotAllowedError");
          h.copied.push(text);
        },
      },
    },
    localStorage: { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)) },
    console,
    URL,
  };
  vm.createContext(context);
  for (const source of SOURCES) vm.runInContext(source, context);
  h.run = (code) => vm.runInContext(code, context);
  h.flush = async () => {
    for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  h.start = async () => {
    h.run("scStartPairing")({ source: "build" });
    await h.flush();
    return h;
  };
  h.card = () => host.querySelector(".sc-pairing");
  h.command = () => host.querySelector(".sc-command")?.textContent ?? null;
  h.note = () => host.querySelector("[data-sc-cmd-note]")?.textContent ?? null;
  h.error = () => host.querySelector("[data-sc-cmd-error]");
  h.folder = () => host.querySelector("[data-sc-cmd-folder]");
  h.radios = () => host.querySelectorAll("[data-sc-cmd-shell]");
  h.checkedShell = () => h.radios().find((r) => r.checked)?.dataset.scCmdShell ?? null;
  h.type = (value, { commit = true } = {}) => {
    const input = h.folder();
    input.value = value;
    input.dispatchEvent(new FakeEvent("input"));
    if (commit) input.dispatchEvent(new FakeEvent("change"));
  };
  h.leave = () => h.folder().dispatchEvent(new FakeEvent("change"));
  h.choose = (shell) => {
    const radio = h.radios().find((r) => r.dataset.scCmdShell === shell);
    radio.checked = true;
    radio.dispatchEvent(new FakeEvent("change"));
  };
  h.copy = async () => {
    const button = host.querySelector('[data-sc-action="pair-copy-command"]');
    button.focus();
    await h.run("scHandleAction")("", "pair-copy-command", button, "", null);
    await h.flush();
    return button;
  };
  h.ack = () => host.querySelectorAll("[data-sc-copy-ack]").find((el) => el.textContent !== "") || null;
  h.liveText = () => live.textContent.replace(/\u00a0/g, "").trim();
  return h;
}

// ── A small model of how each shell reads the displayed command ──────────────
// It understands only the quoting the Center produces and fails on any metacharacter left bare, so a command
// that would let something else run cannot pass. It returns the words the shell would hand to the program.

const PS_QUOTES = "'\u2018\u2019\u201a\u201b";
const BARE_OK = {
  windows: /[A-Za-z0-9_.\\/:=@%+,-]/,
  cmd: /[A-Za-z0-9_.\\/:=@+,-]/,
  posix: /[A-Za-z0-9_./:=@%+,-]/,
};

function splitCommand(shell, text) {
  const words = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === " ") {
      i += 1;
      continue;
    }
    let word = "";
    while (i < text.length && text[i] !== " ") {
      const ch = text[i];
      if (shell === "windows" && PS_QUOTES.includes(ch)) {
        i += 1;
        for (;;) {
          assert.ok(i < text.length, `unterminated quote in: ${text}`);
          if (PS_QUOTES.includes(text[i])) {
            if (i + 1 < text.length && PS_QUOTES.includes(text[i + 1])) {
              word += text[i + 1];
              i += 2;
              continue;
            }
            i += 1;
            break;
          }
          word += text[i];
          i += 1;
        }
      } else if (shell === "cmd" && ch === '"') {
        i += 1;
        while (text[i] !== '"') {
          assert.ok(i < text.length, `unterminated quote in: ${text}`);
          assert.notEqual(text[i], "%", `cmd would expand % inside quotes: ${text}`);
          word += text[i];
          i += 1;
        }
        i += 1;
      } else if (shell === "posix" && ch === "'") {
        i += 1;
        while (text[i] !== "'") {
          assert.ok(i < text.length, `unterminated quote in: ${text}`);
          word += text[i];
          i += 1;
        }
        i += 1;
      } else if (shell === "posix" && ch === "\\" && text[i + 1] === "'") {
        word += "'";
        i += 2;
      } else if (shell === "posix" && ch === "~" && word === "" && text[i + 1] === "/") {
        word += "~";
        i += 1;
      } else if (shell === "windows" && ch === "&" && words.length === 0 && word === "" && text[i + 1] === " ") {
        word = "&";
        i += 1;
      } else {
        assert.match(ch, BARE_OK[shell], `an unquoted ${JSON.stringify(ch)} would be read by the ${shell} shell: ${text}`);
        word += ch;
        i += 1;
      }
    }
    words.push(word);
  }
  return words;
}

/** The program the command runs, or a failure when anything else would run. */
function programOf(shell, text) {
  const words = splitCommand(shell, text);
  if (shell === "windows" && words[0] === "&") words.shift();
  assert.equal(words.length, 3, `exactly a program and two arguments: ${text}`);
  assert.deepEqual(words.slice(1), [`--portal=${PORTAL}`, `--code=${CODE}`]);
  return words[0];
}

test("the model of the shells reads the quoting the Center produces and rejects bare metacharacters", () => {
  assert.deepEqual(splitCommand("windows", "& 'C:\\a b\\it''s.cmd' --x"), ["&", "C:\\a b\\it's.cmd", "--x"]);
  assert.deepEqual(splitCommand("windows", "& 'C:\\O\u2019\u2019Brien\\x.cmd'"), ["&", "C:\\O\u2019Brien\\x.cmd"]);
  assert.deepEqual(splitCommand("cmd", '"C:\\a b\\x.cmd" --x'), ["C:\\a b\\x.cmd", "--x"]);
  assert.deepEqual(splitCommand("posix", "'/a b/it'\\''s/x.sh' --x"), ["/a b/it's/x.sh", "--x"]);
  assert.deepEqual(splitCommand("posix", "~/'My Files/x.sh' --x"), ["~/My Files/x.sh", "--x"]);
  for (const [shell, text] of [["windows", "& C:\\x; calc"], ["windows", "C:\\x$(calc)"], ["cmd", "C:\\x & calc"], ["cmd", '"C:\\%PATH%\\x"'], ["posix", "/x; rm -rf /"], ["posix", "/x$(calc)"], ["posix", "'/x'`id`"]]) {
    assert.throws(() => splitCommand(shell, text), `${shell}: ${text}`);
  }
});

// ── The default command, by operating system ────────────────────────────────

test("on Windows the card shows the PowerShell command with the launcher's relative path, and the label stays", async () => {
  const h = await makeHarness({ nav: WINDOWS }).start();
  assert.ok(h.card(), "the pairing card is open");
  assert.match(h.card().textContent, /Or run this ready-made command:/);
  assert.equal(h.command(), RELATIVE_WINDOWS);
  assert.equal(h.command(), `.\\capture-companion\\tools\\screenshot-capture\\start-companion.cmd --portal=${PORTAL} --code=${CODE}`);
  assert.equal(h.note(), "Run this from the folder where you unzipped the companion.");
  assert.equal(h.checkedShell(), "windows");
  assert.deepEqual(h.radios().map((r) => r.dataset.scCmdShell), ["windows", "cmd", "posix"], "a small selector is always there");
  assert.deepEqual(h.host.querySelectorAll(".sc-cmd-shell label").map((l) => l.textContent), ["Windows PowerShell", "Command Prompt", "macOS or Linux"]);
  assert.equal(programOf("windows", h.command()), `.\\${FILE_WIN}`);
  assert.equal(h.card().querySelector(".sc-code").textContent, CODE, "the pairing code is unchanged");
  assert.match(h.card().querySelector("[data-sc-pair-timer]").textContent, /^Code expires in (10:00|9:5\d)$/, "the expiry is unchanged");
  assert.match(h.card().textContent, /Waiting for your computer/, "the auto-detect wait is unchanged");
});

test("on macOS and Linux the card shows the POSIX command, and the selector switches between all three", async () => {
  for (const nav of [MAC, LINUX, { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" }, { platform: "Darwin" }]) {
    const h = await makeHarness({ nav }).start();
    assert.equal(h.checkedShell(), "posix", JSON.stringify(nav));
    assert.equal(h.command(), RELATIVE_POSIX);
    assert.equal(programOf("posix", h.command()), `./${FILE_POSIX}`);
  }
  const win = await makeHarness({ nav: { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } }).start();
  assert.equal(win.checkedShell(), "windows", "the user agent is a fallback");
  win.choose("cmd");
  assert.equal(win.command(), RELATIVE_WINDOWS, "without a folder, Command Prompt runs the same relative command");
  assert.equal(win.liveText(), "Showing the Command Prompt command.");
  win.choose("posix");
  assert.equal(win.command(), RELATIVE_POSIX);
  assert.equal(win.liveText(), "Showing the macOS or Linux command.");
  assert.equal(win.checkedShell(), "posix");
});

test("when the browser does not say which system it is, Windows is shown first and the selector offers the others", async () => {
  const h = await makeHarness({ nav: {} }).start();
  assert.equal(h.checkedShell(), "windows");
  assert.equal(h.command(), RELATIVE_WINDOWS);
  h.choose("posix");
  assert.equal(h.command(), RELATIVE_POSIX);
});

// ── The unzip folder ────────────────────────────────────────────────────────

test("a typed folder turns the command into the full path, quoted for the shell, and Copy copies exactly that", async () => {
  const h = await makeHarness().start();
  const field = h.folder();
  assert.equal(h.host.querySelector('label[for="sc-cmd-folder"]').textContent, "Where did you unzip the companion? (optional)");
  assert.equal(field.value, "");

  h.type("C:\\Users\\Russ\\Downloads\\copilot-studio-labs-capture-companion");
  const full = `C:\\Users\\Russ\\Downloads\\copilot-studio-labs-capture-companion\\${FILE_WIN}`;
  assert.equal(h.command(), `& '${full}' ${ARGS}`);
  assert.equal(h.note(), "This command has the full path, so you can run it from any folder.");
  assert.equal(h.folder(), field, "typing does not rebuild the box, so the caret and focus stay");
  assert.equal(programOf("windows", h.command()), full);

  h.choose("cmd");
  assert.equal(h.command(), `"${full}" ${ARGS}`);
  assert.equal(programOf("cmd", h.command()), full);
  h.choose("posix");
  assert.equal(h.error().hidden, false, "a Windows folder is not a macOS or Linux folder");
  assert.match(h.error().textContent, /looks like a Windows folder/);
  assert.equal(h.command(), RELATIVE_POSIX, "an unusable folder never changes the command");
  h.choose("windows");
  assert.equal(h.error().hidden, true);

  const button = await h.copy();
  assert.deepEqual(h.copied, [`& '${full}' ${ARGS}`], "Copy copies exactly what is displayed");
  assert.equal(h.copied[0], h.command());
  assert.equal(h.document.activeElement, button, "focus stays on the button");
});

test("the folder is read the way people type or paste it: OneDrive and spaces, slashes, trailing separators, quotes, and the inner folders", async () => {
  const h = await makeHarness().start();
  const expectWindows = (typed, base) => {
    h.type(typed);
    assert.equal(h.error().hidden, true, `${typed} is accepted`);
    assert.equal(programOf("windows", h.command()), `${base}\\${FILE_WIN}`, typed);
  };
  const oneDrive = "C:\\Users\\Russ\\OneDrive - Contoso\\Documents\\copilot-studio-labs-capture-companion";
  expectWindows(oneDrive, oneDrive);
  assert.equal(h.command(), `& '${oneDrive}\\${FILE_WIN}' ${ARGS}`, "a path with spaces is quoted and uses the call operator");
  expectWindows("C:/Users/Russ/Downloads/pack/", "C:\\Users\\Russ\\Downloads\\pack");
  expectWindows("C:\\Users\\Russ\\Downloads\\pack\\\\\\", "C:\\Users\\Russ\\Downloads\\pack");
  expectWindows('"C:\\Users\\Russ\\Downloads\\pack"', "C:\\Users\\Russ\\Downloads\\pack");
  expectWindows("'C:\\Users\\Russ\\Downloads\\pack'", "C:\\Users\\Russ\\Downloads\\pack");
  expectWindows("\u201cC:\\Users\\Russ\\Downloads\\pack\u201d", "C:\\Users\\Russ\\Downloads\\pack");
  expectWindows("  C:\\Users\\Russ\\Downloads\\pack  ", "C:\\Users\\Russ\\Downloads\\pack");
  h.type("c:\\users\\russ\\pack\\Capture-Companion");
  assert.equal(programOf("windows", h.command()), "c:\\users\\russ\\pack\\Capture-Companion\\tools\\screenshot-capture\\start-companion.cmd", "the capture-companion folder itself is accepted, in any letter case");
  expectWindows(`C:\\pack\\${DIR_WIN}`, "C:\\pack");
  expectWindows(`C:\\${"x".repeat(297)}`, `C:\\${"x".repeat(297)}`);
  expectWindows("C:\\", "C:");
  expectWindows("D:", "D:");
  assert.equal(h.command(), `& 'D:\\${FILE_WIN}' ${ARGS}`);

  h.choose("posix");
  const expectPosix = (typed, program) => {
    h.type(typed);
    assert.equal(h.error().hidden, true, `${typed} is accepted`);
    assert.equal(programOf("posix", h.command()), program, typed);
  };
  expectPosix("/Users/russ/My Files/pack/", `/Users/russ/My Files/pack/${FILE_POSIX}`);
  assert.equal(h.command(), `'/Users/russ/My Files/pack/${FILE_POSIX}' ${ARGS}`);
  expectPosix("/home/o'brien/pack", `/home/o'brien/pack/${FILE_POSIX}`);
  assert.equal(h.command(), `'/home/o'\\''brien/pack/${FILE_POSIX}' ${ARGS}`);
  expectPosix("~/Downloads/my pack", `~/Downloads/my pack/${FILE_POSIX}`);
  assert.equal(h.command(), `~/'Downloads/my pack/${FILE_POSIX}' ${ARGS}`, "the home folder stays outside the quotes so the shell expands it");
  expectPosix("~", `~/${FILE_POSIX}`);
  expectPosix("/", `/${FILE_POSIX}`);
  expectPosix("/opt//pack///", `/opt/pack/${FILE_POSIX}`);
  expectPosix("/opt/pack/capture-companion", `/opt/pack/${FILE_POSIX}`);
  expectPosix("/opt/Capture-Companion", `/opt/Capture-Companion/${FILE_POSIX}`);
});

test("a folder that is not a usable path is explained after the person leaves the box, and never changes the command", async () => {
  const h = await makeHarness().start();
  const rejected = [
    ["relative", "Downloads\\pack", /Start with a drive letter/],
    ["network share", "\\\\server\\share\\pack", /Start with a drive letter/],
    ["colon", "C:\\pa:ck", /does not allow/],
    ["angle bracket", "C:\\pa<ck", /does not allow/],
    ["pipe", "C:\\x | calc", /does not allow/],
    ["redirect", "C:\\x > out.txt", /does not allow/],
    ["quote break-out", 'C:\\x" & calc & "', /does not allow/],
    ["half-quoted", '"C:\\x" & calc', /does not allow/],
    ["wildcard", "C:\\pack\\*", /does not allow/],
    ["newline", "C:\\pack\nrm -rf /", /hidden character/],
    ["tab inside", "C:\\pa\tck", /hidden character/],
    ["NUL", "C:\\pa\u0000ck", /hidden character/],
    ["bidirectional override", "C:\\pack\u202eexe.cmd", /hidden character/],
    ["zero width", "C:\\pa\u200bck", /hidden character/],
    ["too long", `C:\\${"a".repeat(299)}`, /too long/],
    ["very long", "C:\\" + "a".repeat(100000), /too long/],
  ];
  for (const [name, typed, message] of rejected) {
    h.type(typed, { commit: false });
    assert.equal(h.command(), RELATIVE_WINDOWS, `${name}: the command stays relative`);
    assert.equal(h.error().hidden, true, `${name}: nothing is announced while the person is still typing`);
    h.leave();
    assert.equal(h.error().hidden, false, `${name}: the problem is shown after leaving the box`);
    assert.match(h.error().textContent, message, name);
    assert.equal(h.folder().getAttribute("aria-invalid"), "true", name);
    assert.ok(!h.error().textContent.includes(typed.slice(0, 20)) || typed.length < 4, `${name}: the message does not repeat the input`);
    assert.equal(h.command(), RELATIVE_WINDOWS, name);
    assert.equal(h.note(), "Run this from the folder where you unzipped the companion.", name);
  }
  h.type("C:\\pack");
  assert.equal(h.error().hidden, true, "fixing it clears the message");
  assert.equal(h.folder().getAttribute("aria-invalid"), null);

  h.choose("cmd");
  h.type("C:\\100%\\pack");
  assert.match(h.error().textContent, /Command Prompt treats %/);
  assert.equal(h.command(), RELATIVE_WINDOWS);
  h.choose("windows");
  assert.equal(h.error().hidden, true, "PowerShell can quote a % safely");
  assert.equal(programOf("windows", h.command()), `C:\\100%\\pack\\${FILE_WIN}`);

  h.choose("posix");
  for (const typed of ["Downloads/pack", "pack", "~other/pack", "C:\\pack", "D:/pack"]) {
    h.type(typed);
    assert.equal(h.error().hidden, false, typed);
    assert.equal(h.command(), RELATIVE_POSIX, typed);
  }
  h.type("/Users/russ/pack\nrm -rf /");
  assert.match(h.error().textContent, /hidden character/);
});

test("injection attempts end up inside quotes as one path, so the displayed command can only start the launcher", async () => {
  const windowsFolders = [
    "C:\\x; rm -rf /",
    "C:\\x$(calc)",
    "C:\\x`whoami`",
    "C:\\x && calc",
    "C:\\x' ; calc ; '",
    "C:\\x\u2019 ; calc ; \u2018",
    "C:\\a&b^c(d)!e",
    "C:\\x -ErrorAction Stop; Invoke-Expression 'calc'",
    "C:\\100%\\pack",
  ];
  const h = await makeHarness().start();
  for (const shell of ["windows", "cmd"]) {
    h.choose(shell);
    for (const typed of windowsFolders) {
      h.type(typed);
      if (shell === "cmd" && typed.includes("%")) {
        assert.equal(h.error().hidden, false, `cmd refuses ${typed}`);
        assert.equal(h.command(), RELATIVE_WINDOWS);
        continue;
      }
      const folder = typed.replace(/\//g, "\\").replace(/\\+$/, "");
      assert.equal(h.error().hidden, true, `${shell}: ${typed}`);
      assert.equal(programOf(shell, h.command()), `${folder}\\${FILE_WIN}`, `${shell}: ${typed}`);
    }
  }
  h.choose("posix");
  const posixFolders = ["/tmp/x; rm -rf ~", "/tmp/$(calc)", "/tmp/`id`", "/tmp/a && b", "/tmp/it's", '/tmp/"quoted"', "/tmp/a\\b", "/tmp/*", "/tmp/a\\'; rm -rf /; '", "/tmp/${IFS}x", "/tmp/a|b>c<d"];
  for (const typed of posixFolders) {
    h.type(typed);
    assert.equal(h.error().hidden, true, typed);
    assert.equal(programOf("posix", h.command()), `${typed}/${FILE_POSIX}`, typed);
  }
});

// ── Where the folder lives ──────────────────────────────────────────────────

test("the folder is remembered in this browser, only when usable, and is never sent to the server", async () => {
  const storage = new Map();
  const first = makeHarness({ storage });
  await first.start();
  first.type("C:\\Users\\Russ\\Downloads\\pack");
  assert.equal(storage.get(STORAGE_KEY), "C:\\Users\\Russ\\Downloads\\pack");
  first.type("C:\\bad<folder", { commit: false });
  assert.equal(storage.get(STORAGE_KEY), "C:\\Users\\Russ\\Downloads\\pack", "an unusable folder is not remembered");

  first.type("C:\\Users\\Russ\\Downloads\\pack");
  await first.run("scHandleAction")("", "pair-new", first.host.querySelector('[data-sc-action="pair-new"]'), "", null);
  await first.flush();
  assert.equal(first.folder().value, "C:\\Users\\Russ\\Downloads\\pack", "a new code keeps the folder");
  assert.match(first.command(), /^& 'C:\\Users\\Russ\\Downloads\\pack\\capture-companion\\/);
  const posts = first.calls.filter((c) => c.method === "POST");
  assert.equal(posts.length, 2, "the only requests are the two pairing codes");
  assert.ok(posts.every((c) => c.body === "{}"), "they carry no data");
  const everything = JSON.stringify(first.calls);
  assert.ok(!everything.includes("Russ") && !everything.includes("Downloads"), "the folder never appears in a request");

  const later = makeHarness({ storage });
  await later.start();
  assert.equal(later.folder().value, "C:\\Users\\Russ\\Downloads\\pack", "it is filled in on the next visit");
  assert.match(later.command(), /^& 'C:\\Users\\Russ\\Downloads\\pack\\capture-companion\\tools\\screenshot-capture\\start-companion\.cmd' --portal=/);
  assert.equal(later.note(), "This command has the full path, so you can run it from any folder.");

  later.type("");
  assert.equal(storage.get(STORAGE_KEY), "", "clearing the box forgets it");
  assert.equal(later.command(), RELATIVE_WINDOWS);

  const stale = makeHarness({ storage: new Map([[STORAGE_KEY, "C:\\Users\\Russ\\Downloads\\pack"]]), nav: MAC });
  await stale.start();
  assert.equal(stale.command(), RELATIVE_POSIX, "a remembered Windows folder does not break the macOS command");
  assert.match(stale.error().textContent, /looks like a Windows folder/);

  const huge = makeHarness({ storage: new Map([[STORAGE_KEY, "C:\\" + "a".repeat(100000)]]) });
  await huge.start();
  assert.equal(huge.folder().value, "", "an oversized stored value is ignored");
  assert.equal(huge.command(), RELATIVE_WINDOWS);

  const blocked = makeHarness();
  blocked.run("localStorage").getItem = () => {
    throw new Error("SecurityError");
  };
  blocked.run("localStorage").setItem = () => {
    throw new Error("SecurityError");
  };
  await blocked.start();
  blocked.type("C:\\pack");
  assert.match(blocked.command(), /^& 'C:\\pack\\capture-companion/, "without storage the folder lasts for the page view");
});

test("the command script has no network, markup, or clipboard code, and stores only the folder", () => {
  assert.doesNotMatch(COMMAND_SOURCE, /\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|\.innerHTML|insertAdjacentHTML|outerHTML|document\.write|\beval\(|new Function|clipboard|sessionStorage|indexedDB|\bopen\(/);
  assert.deepEqual([...COMMAND_SOURCE.matchAll(/localStorage\.(\w+)\(([^,)]*)/g)].map((m) => [m[1], m[2]]), [["getItem", "SC_CMD_FOLDER_KEY"], ["setItem", "SC_CMD_FOLDER_KEY"]]);
  assert.match(COMMAND_SOURCE, /const SC_CMD_FOLDER_KEY = "sc-companion-folder";/);
  assert.doesNotMatch(COMMAND_SOURCE, /\b(colour|behaviour|centre|licence|organis|catalogue|favourite)\w*/i, "US English only");
});

test("the script loads in order and the card's styles use theme tokens and add no print rule of their own", () => {
  const at = (name) => INDEX_HTML.indexOf(`<script src="${name}" defer></script>`);
  const order = ["screenshot-center-core.js", "screenshot-center-command.js", "screenshot-center-jobs.js", "screenshot-center.js"].map(at);
  assert.ok(order.every((i) => i > 0), "every script tag exists and is deferred");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "the command builder loads right after the core, before the code that uses it");
  const [screen, print] = INDEX_HTML.split("@media print");
  assert.ok(print.includes(".sc-pairing,"), "the pairing card is hidden in the one print block");
  assert.ok(!screen.includes("@media print"), "and no earlier print rule was added");
  const rules = [...screen.matchAll(/^\s*(\.sc-cmd[^{]*|\.sc-command\.sc-command-wrap[^{]*)\{([^}]*)\}/gm)];
  assert.ok(rules.length >= 10, "the new rules are in the stylesheet");
  for (const [, selector, body] of rules) {
    assert.doesNotMatch(body, /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i, `${selector.trim()} takes its colors from theme tokens`);
  }
});

// ── Copy, announcements, and safety ─────────────────────────────────────────

test("Copy command keeps its green confirmation and its announcement, and says what to do when copying is blocked", async () => {
  const h = await makeHarness().start();
  h.type("C:\\Users\\Russ\\OneDrive - Contoso\\pack");
  const button = await h.copy();
  assert.equal(button.textContent, "Copy command");
  assert.equal(h.copied[0], h.command());
  const ack = h.ack();
  assert.equal(ack.textContent, OK_COMMAND);
  assert.ok(ack.classList.contains("sc-copy-ack-ok") && !ack.classList.contains("sc-copy-ack-fail"));
  assert.ok(ack.querySelector("svg.sc-copy-ack-icon"), "a checkmark icon");
  assert.equal(h.liveText(), `${OK_COMMAND}.`);
  assert.equal(button.parentNode.children[button.parentNode.children.indexOf(button) + 1], ack, "the confirmation sits right next to the button");

  h.choose("posix");
  h.type("/Users/russ/My Files");
  await h.copy();
  assert.equal(h.copied.at(-1), `'/Users/russ/My Files/${FILE_POSIX}' ${ARGS}`, "after a change, Copy copies the new command");
  assert.equal(h.copied.at(-1), h.command());

  h.writeFails = true;
  await h.copy();
  assert.equal(h.ack().textContent, COPY_FAILED);
  assert.ok(h.ack().classList.contains("sc-copy-ack-fail"), "never styled as success");
  assert.equal(h.liveText(), COPY_FAILED);
  assert.equal(h.copied.length, 2, "nothing else was copied");
});

test("the card, the notes, and the errors are built from text only: typed markup never becomes elements", async () => {
  const h = await makeHarness().start();
  h.type("<img src=x onerror=alert(1)>");
  assert.match(h.error().textContent, /does not allow/);
  assert.ok(!h.card().textContent.includes("onerror"), "the message does not repeat the input");
  h.choose("posix");
  h.type("/<script>alert(1)</script>/<img src=x onerror=alert(2)>");
  assert.equal(h.error().hidden, true);
  assert.equal(h.card().querySelectorAll("img, script, iframe").length, 0);
  assert.deepEqual(h.card().querySelectorAll("a").map((a) => a.getAttribute("href")), ["/api/capture/companion.zip"], "the only link is the download");
  assert.ok(h.command().includes("<script>alert(1)</script>"), "it is shown as quoted text");
  assert.equal(programOf("posix", h.command()), `/<script>alert(1)</script>/<img src=x onerror=alert(2)>/${FILE_POSIX}`);
  assert.equal(h.card().querySelectorAll(".sc-command").length, 1);
});

test("only plain portal addresses and codes go into the command; anything else is left for the companion to ask for", async () => {
  assert.deepEqual(buildPairingCommands({ portalUrl: "https://x.example'; calc; '", code: CODE }).command.split(" ").slice(1), [`--code=${CODE}`]);
  assert.deepEqual(buildPairingCommands({ portalUrl: PORTAL, code: "ABCD EFGH; calc" }).command.split(" ").slice(1), [`--portal=${PORTAL}`]);
  assert.deepEqual(buildPairingCommands({ portalUrl: "http://localhost:3025", code: CODE }).command.split(" ").slice(1), ["--portal=http://localhost:3025", `--code=${CODE}`]);

  const evil = pairReply({ portalUrl: "https://x.example$(calc)", code: "ABCD-EFGH" });
  const h = await makeHarness({ reply: evil }).start();
  assert.equal(h.command(), `.\\${FILE_WIN} --code=${CODE}`, "the page leaves an unsafe address out too");
  const dollars = pairReply({ portalUrl: "https://x.example", code: "ab; calc" });
  const k = await makeHarness({ reply: dollars }).start();
  assert.equal(k.command(), `.\\${FILE_WIN} --portal=https://x.example`);
});

test("older servers still render: a reply without the launcher paths shows the command it sent, and Copy copies it", async () => {
  const old = { status: 201, body: { code: CODE, expiresAt: new Date(Date.now() + 600000).toISOString(), expiresInSec: 600, portalUrl: PORTAL, command: `start-companion --portal=${PORTAL} --code=${CODE}` } };
  const h = await makeHarness({ reply: old }).start();
  assert.equal(h.command(), `start-companion --portal=${PORTAL} --code=${CODE}`);
  assert.equal(h.folder(), null, "no folder box without the launcher paths");
  assert.equal(h.radios().length, 0);
  assert.match(h.card().textContent, /Or run this ready-made command:/);
  await h.copy();
  assert.deepEqual(h.copied, [`start-companion --portal=${PORTAL} --code=${CODE}`]);
  assert.equal(h.ack().textContent, OK_COMMAND);

  for (const launcher of [{}, null, "x", { relativeDir: "../etc", windows: "../etc/x.cmd", posix: "../etc/x.sh" }, { relativeDir: "a", windows: "a b/x.cmd", posix: "a/x.sh" }, { relativeDir: "a", windows: "/abs/x.cmd", posix: "a/x.sh" }, { relativeDir: "a", windows: "a/x.cmd" }]) {
    const odd = await makeHarness({ reply: { ...old, body: { ...old.body, launcher } } }).start();
    assert.equal(odd.command(), `start-companion --portal=${PORTAL} --code=${CODE}`, JSON.stringify(launcher));
    assert.equal(odd.folder(), null);
  }
});

test("the card works in the Setup checklist and Step 8 hosts too: its controls handle their own events", async () => {
  const h = makeHarness();
  h.host.setAttribute("data-sc-pairing-host", "readiness");
  await h.run("scStartPairing")({ source: "readiness" });
  await h.flush();
  assert.equal(h.command(), RELATIVE_WINDOWS);
  h.type("C:\\pack");
  assert.match(h.command(), /^& 'C:\\pack\\capture-companion\\/);
  h.choose("posix");
  assert.equal(h.error().hidden, false);
});
