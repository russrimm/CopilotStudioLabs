/**
 * Builds the Local Capture Companion download.
 *
 * The ZIP mirrors the repository layout so the companion's relative imports work
 * unchanged. Only an explicit allowlist of files goes in: no tokens, no pairing
 * codes, no browser profiles, no environment files.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ZipArchive } from "archiver";

import { REPO_ROOT } from "../storage-config.js";

/** Files copied from the repository, relative to its root. */
export const COMPANION_FILES = Object.freeze([
  "tools/screenshot-capture/companion.mjs",
  "tools/screenshot-capture/lab-runner.mjs",
  "tools/screenshot-capture/capture-run.mjs",
  "tools/screenshot-capture/auth.mjs",
  "tools/screenshot-capture/browsers.mjs",
  "tools/screenshot-capture/guard.mjs",
  "tools/screenshot-capture/guided.mjs",
  "tools/screenshot-capture/labels.mjs",
  "tools/screenshot-capture/lifecycle.mjs",
  "tools/screenshot-capture/locator.mjs",
  "tools/screenshot-capture/readiness.mjs",
  "tools/screenshot-capture/targets.mjs",
  "tools/screenshot-capture/causes.mjs",
  "tools/screenshot-capture/trace.mjs",
  "tools/screenshot-capture/callouts.mjs",
  "tools/screenshot-capture/manifests.mjs",
  "tools/screenshot-capture/image-verify.mjs",
  "tools/screenshot-capture/placeholder-detect.mjs",
  "tools/screenshot-capture/redact.mjs",
  "tools/screenshot-capture/executor.mjs",
  "tools/screenshot-capture/setup-steps.mjs",
  "tools/screenshot-capture/diagnostics.mjs",
  "tools/screenshot-capture/practice.mjs",
  "tools/screenshot-capture/recipes.mjs",
  "tools/screenshot-capture/recipes-builtin.mjs",
  "tools/screenshot-capture/recorder.mjs",
  "tools/screenshot-capture/autonomous.mjs",
  "tools/screenshot-capture/walkthrough.mjs",
  "tools/screenshot-capture/automation.mjs",
  "tools/screenshot-capture/families.mjs",
  "tools/screenshot-capture/scratch.mjs",
  "tools/screenshot-capture/scratch-recipes.mjs",
  "tools/screenshot-capture/dry-run.mjs",
  "tools/screenshot-capture/home.mjs",
  "tools/screenshot-capture/attach.mjs",
  "tools/screenshot-capture/profile-guard.mjs",
  "tools/screenshot-capture/account-source.mjs",
  "tools/screenshot-capture/account-guard.mjs",
  "tools/screenshot-capture/account-setup.mjs",
  "tools/screenshot-capture/check-signin.mjs",
  "tools/screenshot-capture/signin-diagnosis.mjs",
  "tools/screenshot-capture/signin-url.mjs",
  "tools/screenshot-capture/surface-watch.mjs",
  "tools/screenshot-capture/start-hint.mjs",
  "tools/screenshot-capture/package.json",
  "tools/screenshot-capture/README.md",
  "tools/screenshot-capture/start-companion.cmd",
  "tools/screenshot-capture/start-companion.ps1",
  "tools/screenshot-capture/start-companion.sh",
  "tools/feature-tour/lib/products.mjs",
  "tools/feature-tour/capture-products.json",
]);

const EXECUTABLE = new Set(["tools/screenshot-capture/start-companion.sh"]);
export const COMPANION_ZIP_NAME = "copilot-studio-labs-capture-companion.zip";
const ROOT_FOLDER = "capture-companion";
const LAUNCHER_DIR = `${ROOT_FOLDER}/tools/screenshot-capture`;

/**
 * Where the launchers sit inside the ZIP, relative to the folder it was unzipped into (forward slashes).
 * The pairing API sends this so the Screenshot Center can show a command that includes the path.
 */
export const COMPANION_LAUNCHER = Object.freeze({
  relativeDir: LAUNCHER_DIR,
  windows: `${LAUNCHER_DIR}/start-companion.cmd`,
  powershell: `${LAUNCHER_DIR}/start-companion.ps1`,
  posix: `${LAUNCHER_DIR}/start-companion.sh`,
});

/** Launchers keep the line endings their shell needs, whatever the checkout used. */
function normalizeLineEndings(rel, buffer) {
  if (rel.endsWith(".sh")) return Buffer.from(buffer.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
  if (rel.endsWith(".cmd") || rel.endsWith(".ps1")) return Buffer.from(buffer.toString("utf8").replace(/\r?\n/g, "\r\n"), "utf8");
  return buffer;
}

const README_FIRST = [
  "Local Capture Companion",
  "=======================",
  "",
  "This folder runs on your own computer. It opens a browser window, you sign in",
  "to Microsoft 365 once, and it captures the screenshots the portal asks for.",
  "",
  "1. Install Node.js 20 or later from https://nodejs.org if you do not have it.",
  "2. Open the folder tools/screenshot-capture (inside this capture-companion folder).",
  "   It holds three launchers: start-companion.cmd, start-companion.ps1, and start-companion.sh.",
  "3. Windows: double-click start-companion.cmd (or run start-companion.ps1).",
  "   macOS and Linux: run ./start-companion.sh in a terminal.",
  "4. When asked, type the portal address and the pairing code. In the portal,",
  "   open the Screenshot Center and select Connect a computer to get the code.",
  "5. Leave the window open. The companion waits for capture jobs from the portal.",
  "",
  "To start it from a terminal instead, run this from the folder where you unzipped",
  "the companion (the folder that holds this capture-companion folder):",
  "  Windows PowerShell or Command Prompt:",
  "    .\\capture-companion\\tools\\screenshot-capture\\start-companion.cmd --portal=<portal address> --code=<pairing code>",
  "  macOS and Linux:",
  "    ./capture-companion/tools/screenshot-capture/start-companion.sh --portal=<portal address> --code=<pairing code>",
  "The portal shows this command with your pairing code filled in, ready to copy. If you",
  "tell it which folder you unzipped into, it shows the full path, so you can run it from",
  "any folder. A path with spaces (OneDrive folders have them) needs quotes. In PowerShell,",
  "start with & and put the path in single quotes, for example:",
  "  & 'C:\\Users\\you\\OneDrive - Contoso\\Downloads\\copilot-studio-labs-capture-companion\\capture-companion\\tools\\screenshot-capture\\start-companion.cmd' --portal=<portal address> --code=<pairing code>",
  "The companion remembers the pairing. Each time it starts it prints the full command to",
  "start it again, so you can copy it from there.",
  "",
  "This download contains no secrets. The pairing code works once and expires in",
  "10 minutes. You can disconnect this computer from the portal at any time.",
  "",
  "Your pairing and browser sign-in are kept in a local folder of your user account",
  "(on Windows, %LOCALAPPDATA%\\CopilotStudioLabsCompanion), never inside this folder.",
  "That keeps them out of OneDrive and other synced folders, where sign-in can loop.",
  "If sign-in does not stick, open a terminal in the tools/screenshot-capture folder and run:",
  "  node companion.mjs --check-signin",
  "To choose which account the screenshots come from (for example your demo tenant",
  "instead of your Windows work account), run this in the same folder:",
  "  node companion.mjs --setup-account",
  "",
  "See tools/screenshot-capture/README.md for troubleshooting.",
  "",
].join("\n");

/**
 * @param {object} [options]
 * @param {string} [options.repoRoot]
 * @returns {Promise<{buffer: Buffer, files: string[]}>}
 */
export function buildCompanionZip({ repoRoot = REPO_ROOT } = {}) {
  return new Promise((resolve, reject) => {
    const archive = new ZipArchive({ zlib: { level: 9 } });
    const chunks = [];
    const files = [];
    archive.on("data", (chunk) => chunks.push(chunk));
    archive.on("error", reject);
    archive.on("end", () => resolve({ buffer: Buffer.concat(chunks), files }));

    const date = new Date("2026-01-01T00:00:00Z");
    for (const rel of COMPANION_FILES) {
      const source = path.join(repoRoot, ...rel.split("/"));
      if (!existsSync(source)) continue;
      const name = `${ROOT_FOLDER}/${rel}`;
      archive.append(normalizeLineEndings(rel, readFileSync(source)), { name, date, mode: EXECUTABLE.has(rel) ? 0o755 : 0o644 });
      files.push(name);
    }
    archive.append(README_FIRST, { name: `${ROOT_FOLDER}/README-FIRST.txt`, date });
    files.push(`${ROOT_FOLDER}/README-FIRST.txt`);
    archive.finalize();
  });
}
