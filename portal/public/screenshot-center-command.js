// Screenshot Center: the command that starts the Local Capture Companion, shown in the pairing card.
// The portal cannot know where the person unzipped the download, so the command uses the launcher's
// path inside the ZIP, relative to the unzip folder. When the person types that folder, the command
// carries the full path instead. The folder stays in this browser (localStorage), is never sent to the
// portal, and is never run: it is validated, then quoted for the chosen shell, then shown as text.
// Pure builders come first, then the small piece of pairing-card DOM that uses them.

const SC_CMD_SHELLS = Object.freeze([
  { id: "windows", label: "Windows PowerShell" },
  { id: "cmd", label: "Command Prompt" },
  { id: "posix", label: "macOS or Linux" },
]);
const SC_CMD_FOLDER_KEY = "sc-companion-folder";
const SC_CMD_FOLDER_MAX = 300;
// Plain host names and addresses only; anything else is left out of the command and the companion asks for it instead.
const SC_CMD_SAFE_PORTAL = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/;
const SC_CMD_SAFE_CODE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const SC_CMD_SAFE_RELATIVE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+){0,8}$/;
// Control, line-break, zero-width, and bidirectional characters: they could hide or reorder what a command says.
const SC_CMD_HIDDEN_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;
const SC_CMD_STRAIGHT_QUOTES = new Set(['"', "'"]);
const SC_CMD_CURLY_QUOTES = new Map([["\u201c", "\u201d"], ["\u2018", "\u2019"]]);

const scCmdState = { shell: "", draft: null };

// ── Pure builders ───────────────────────────────────────────────────────────

/** "windows" or "posix" from what the browser says about the computer, or "" when it does not say. */
function scCmdDetectShell(nav = typeof navigator !== "undefined" ? navigator : null) {
  const platform = String(nav?.userAgentData?.platform || nav?.platform || "");
  if (/^win/i.test(platform)) return "windows";
  if (/^(mac|darwin|linux|x11|cros|chrome os|freebsd|openbsd)/i.test(platform)) return "posix";
  const agent = String(nav?.userAgent || "");
  if (/windows/i.test(agent)) return "windows";
  if (/macintosh|mac os x|linux|cros/i.test(agent)) return "posix";
  return "";
}

function scCmdShell() {
  return SC_CMD_SHELLS.some((s) => s.id === scCmdState.shell) ? scCmdState.shell : scCmdDetectShell() || "windows";
}

/** The launcher paths the pairing API sends, or null when they are missing or not plain relative paths (an older server). */
function scCmdLauncherOf(raw) {
  if (!raw || typeof raw !== "object") return null;
  const pick = (key) => {
    const value = raw[key];
    return typeof value === "string" && SC_CMD_SAFE_RELATIVE.test(value) && value.split("/").every((part) => part !== "." && part !== "..") ? value : "";
  };
  const launcher = { relativeDir: pick("relativeDir"), windows: pick("windows"), posix: pick("posix") };
  return launcher.relativeDir && launcher.windows && launcher.posix ? launcher : null;
}

/** PowerShell reads all four of these as a single quote, so each one is doubled to stay inside the string. */
const scCmdQuotePowerShell = (value) => `'${String(value).replace(/['\u2018\u2019\u201a\u201b]/g, (quote) => quote + quote)}'`;
const scCmdQuotePosix = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;

function scCmdExampleFolder(shell) {
  return shell === "posix" ? "/Users/you/Downloads/copilot-studio-labs-capture-companion" : "C:\\Users\\you\\Downloads\\copilot-studio-labs-capture-companion";
}

/**
 * Turn what the person typed into a folder that is safe to put in a command for this shell.
 * @returns {{state: "empty"} | {state: "ok", folder: string} | {state: "invalid", message: string}}
 */
function scCmdParseFolder(raw, shell) {
  const invalid = (message) => ({ state: "invalid", message });
  const windows = shell !== "posix";
  let text = String(raw ?? "").trim();
  if (!text) return { state: "empty" };
  if (text.length > SC_CMD_FOLDER_MAX) return invalid("That path is too long. Type just the folder you unzipped the companion into.");
  if (SC_CMD_HIDDEN_CHARS.test(text)) return invalid("That path has a line break or another hidden character. Type it on one line.");
  // "Copy as path" in File Explorer wraps the path in quotes.
  const last = text[text.length - 1];
  if (text.length > 1 && (SC_CMD_STRAIGHT_QUOTES.has(text[0]) ? text[0] === last : SC_CMD_CURLY_QUOTES.get(text[0]) === last)) text = text.slice(1, -1).trim();
  if (!text) return { state: "empty" };

  if (windows) {
    text = text.replace(/\//g, "\\").replace(/\\{2,}/g, "\\").replace(/\\+$/, "");
    if (/[<>"|?*]/.test(text) || text.indexOf(":", 2) !== -1) return invalid("Windows does not allow < > \" | ? * or a colon in the middle of a folder path.");
    if (!/^[A-Za-z]:(?:\\|$)/.test(text)) return invalid(`Start with a drive letter, like ${scCmdExampleFolder("windows")}. Network folders are not supported here.`);
    if (shell === "cmd" && text.includes("%")) return invalid("Command Prompt treats % as a variable. Use Windows PowerShell, or leave the folder empty.");
    return { state: "ok", folder: text };
  }
  if (/^[A-Za-z]:[\\/]/.test(text)) return invalid("That looks like a Windows folder. Choose Windows PowerShell or Command Prompt above, or type a macOS or Linux path.");
  if (!(text === "~" || text.startsWith("~/") || text.startsWith("/"))) return invalid(`Start with / (or ~/ for your home folder), like ${scCmdExampleFolder("posix")}.`);
  return { state: "ok", folder: text.replace(/\/{2,}/g, "/").replace(/\/+$/, "") };
}

/** The full launcher path. Accepts the unzip folder, the capture-companion folder inside it, or the launcher's own folder. */
function scCmdLauncherPath(folder, shell, launcher) {
  const windows = shell !== "posix";
  const sep = windows ? "\\" : "/";
  const same = (a, b) => (windows ? a.toLowerCase() === b.toLowerCase() : a === b);
  const file = (windows ? launcher.windows : launcher.posix).split("/").pop();
  const dir = launcher.relativeDir.split("/");
  const have = folder.split(sep);
  let extra = dir;
  if (have.length >= dir.length && have.slice(-dir.length).every((part, i) => same(part, dir[i]))) extra = [];
  else if (same(have[have.length - 1], dir[0])) extra = dir.slice(1);
  return [folder, ...extra, file].join(sep);
}

function scCmdQuotePath(shell, fullPath) {
  if (shell === "windows") return `& ${scCmdQuotePowerShell(fullPath)}`;
  if (shell === "cmd") return `"${fullPath}"`;
  // A quoted ~ is not expanded, so the home folder stays outside the quotes.
  if (fullPath.startsWith("~/")) return `~/${scCmdQuotePosix(fullPath.slice(2))}`;
  return scCmdQuotePosix(fullPath);
}

/** The whole command. `folder` is a value from scCmdParseFolder, or null for the relative form. */
function scCmdBuild({ shell, launcher, portalUrl, code, folder = null }) {
  const args = [];
  if (SC_CMD_SAFE_PORTAL.test(String(portalUrl || ""))) args.push(`--portal=${portalUrl}`);
  if (SC_CMD_SAFE_CODE.test(String(code || ""))) args.push(`--code=${code}`);
  let program;
  if (folder === null) program = shell === "posix" ? `./${launcher.posix}` : `.\\${launcher.windows.replace(/\//g, "\\")}`;
  else program = scCmdQuotePath(shell, scCmdLauncherPath(folder, shell, launcher));
  return [program, ...args].join(" ");
}

// ── What the pairing card shows ─────────────────────────────────────────────

function scCmdFolderText() {
  if (scCmdState.draft === null) {
    let stored = "";
    try {
      stored = String(localStorage.getItem(SC_CMD_FOLDER_KEY) || "");
    } catch {
      /* storage is unavailable: the folder lasts for this page view */
    }
    scCmdState.draft = stored.length <= SC_CMD_FOLDER_MAX ? stored : "";
  }
  return scCmdState.draft;
}

/** Keep what the person typed for next time, but only when it is usable; it never leaves this browser. */
function scCmdSetFolder(value) {
  scCmdState.draft = String(value ?? "");
  if (scCmdParseFolder(scCmdState.draft, scCmdShell()).state === "invalid") return;
  try {
    localStorage.setItem(SC_CMD_FOLDER_KEY, scCmdState.draft.trim());
  } catch {
    /* storage is unavailable: the folder lasts for this page view */
  }
}

/** The command, the note under it, and any problem with the typed folder, for the pairing in `p`. Null for an older server. */
function scCmdModel(p, { showError = true } = {}) {
  const launcher = scCmdLauncherOf(p?.launcher);
  if (!launcher) return null;
  const shell = scCmdShell();
  const parsed = scCmdParseFolder(scCmdFolderText(), shell);
  const folder = parsed.state === "ok" ? parsed.folder : null;
  return {
    shell,
    text: scCmdBuild({ shell, launcher, portalUrl: p.portalUrl, code: p.code, folder }),
    note: folder === null ? "Run this from the folder where you unzipped the companion." : "This command has the full path, so you can run it from any folder.",
    error: parsed.state === "invalid" && showError ? parsed.message : "",
  };
}

/** What the Copy command button copies: exactly the command on screen. */
function scPairingCommandText() {
  const p = scState.pairing;
  const model = p ? scCmdModel(p) : null;
  return model ? model.text : String(p?.command || "");
}

function scCmdPaint(root, { showError = true } = {}) {
  const model = scCmdModel(scState.pairing, { showError });
  if (!model || !root) return;
  root.querySelector("[data-sc-cmd-text]").textContent = model.text;
  root.querySelector("[data-sc-cmd-note]").textContent = model.note;
  const error = root.querySelector("[data-sc-cmd-error]");
  error.textContent = model.error;
  error.hidden = !model.error;
  const input = root.querySelector("[data-sc-cmd-folder]");
  if (model.error) input.setAttribute("aria-invalid", "true");
  else input.removeAttribute("aria-invalid");
  root.querySelector("[data-sc-cmd-help]").textContent = scCmdHelp(model.shell);
  for (const radio of root.querySelectorAll("[data-sc-cmd-shell]")) radio.checked = radio.dataset.scCmdShell === model.shell;
}

function scCmdHelp(shell) {
  return `Type the folder you unzipped into, for example ${scCmdExampleFolder(shell)}. It stays in this browser and is never sent to the portal.`;
}

/** The "Or run this ready-made command" step, or null when the server did not send the launcher paths. */
function scBuildCommandItem(p) {
  const model = scCmdModel(p);
  if (!model) return null;
  const item = scEl("li", { class: "sc-cmd" });
  item.appendChild(scEl("span", { text: "Or run this ready-made command:" }));

  const shells = scEl("div", { class: "sc-cmd-shells", attrs: { role: "radiogroup", "aria-labelledby": "sc-cmd-shells-label" } });
  shells.appendChild(scEl("span", { id: "sc-cmd-shells-label", class: "sc-cmd-shells-label", text: "Run it in:" }));
  for (const shell of SC_CMD_SHELLS) {
    const id = `sc-cmd-shell-${shell.id}`;
    const radio = scEl("input", { id, attrs: { type: "radio", name: "sc-cmd-shell", value: shell.id, autocomplete: "off" }, data: { scCmdShell: shell.id, scFocus: `pair-shell:${shell.id}` } });
    radio.checked = shell.id === model.shell;
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      scCmdState.shell = shell.id;
      scCmdPaint(item);
      scAnnounce(`Showing the ${shell.label} command.`);
    });
    shells.appendChild(scEl("span", { class: "sc-cmd-shell" }, [radio, scLabel(id, shell.label)]));
  }
  item.appendChild(shells);

  const row = scEl("div", { class: "sc-code-row" });
  row.appendChild(scEl("code", { class: "sc-command sc-command-wrap", text: model.text, data: { scCmdText: "1" } }));
  row.appendChild(scButton("Copy command", { action: "pair-copy-command", focus: "pair-copy-command" }));
  row.appendChild(scCopyAckEl("pair-copy-command"));
  item.appendChild(row);
  item.appendChild(scEl("p", { id: "sc-cmd-note", class: "sc-cmd-note", text: model.note, attrs: { role: "status", "aria-live": "polite", "aria-atomic": "true" }, data: { scCmdNote: "1" } }));

  const folder = scEl("div", { class: "sc-cmd-folder" });
  folder.appendChild(scLabel("sc-cmd-folder", "Where did you unzip the companion? (optional)"));
  const input = scEl("input", {
    id: "sc-cmd-folder",
    attrs: { type: "text", autocomplete: "off", spellcheck: "false", autocapitalize: "off", "aria-describedby": "sc-cmd-folder-help sc-cmd-folder-error" },
    data: { scCmdFolder: "1", scFocus: "pair-folder" },
  });
  input.value = scCmdFolderText();
  // Typing updates the command quietly; the problem is explained once the person leaves the box.
  input.addEventListener("input", () => {
    scCmdSetFolder(input.value);
    scCmdPaint(item, { showError: false });
  });
  input.addEventListener("change", () => scCmdPaint(item));
  folder.appendChild(input);
  folder.appendChild(scEl("p", { id: "sc-cmd-folder-help", class: "sc-cmd-help", text: scCmdHelp(model.shell), data: { scCmdHelp: "1" } }));
  folder.appendChild(scEl("p", { id: "sc-cmd-folder-error", class: "sc-cmd-error", text: model.error, attrs: { hidden: model.error ? false : true }, data: { scCmdError: "1" } }));
  item.appendChild(folder);
  scCmdPaint(item);
  return item;
}
