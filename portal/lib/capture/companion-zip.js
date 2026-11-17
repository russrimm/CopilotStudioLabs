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
  "tools/screenshot-capture/auth.mjs",
  "tools/screenshot-capture/browsers.mjs",
  "tools/screenshot-capture/guard.mjs",
  "tools/screenshot-capture/trace.mjs",
  "tools/screenshot-capture/callouts.mjs",
  "tools/screenshot-capture/manifests.mjs",
  "tools/screenshot-capture/image-verify.mjs",
  "tools/screenshot-capture/redact.mjs",
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
  "2. Open the folder tools/screenshot-capture.",
  "3. Windows: double-click start-companion.cmd (or run start-companion.ps1).",
  "   macOS and Linux: run ./start-companion.sh in a terminal.",
  "4. When asked, type the portal address and the pairing code. In the portal,",
  "   open the Screenshot Center and select Connect a computer to get the code.",
  "5. Leave the window open. The companion waits for capture jobs from the portal.",
  "",
  "This download contains no secrets. The pairing code works once and expires in",
  "10 minutes. You can disconnect this computer from the portal at any time.",
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
