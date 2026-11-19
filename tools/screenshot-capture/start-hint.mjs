// Tells the person how to start the companion again from any folder, built from where it really is.
// The launchers (start-companion.cmd, .ps1, .sh) pass their own full path in COMPANION_LAUNCHER; without it
// (node companion.mjs run by hand) the hint names the node form. Nothing here includes the pairing code,
// and nothing is sent anywhere: it only becomes lines of text for the person's own terminal.

import fs from "node:fs";
import path from "node:path";

const LAUNCHER_NAME = /^start-companion\.(?:cmd|ps1|sh)$/i;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** PowerShell reads all four of these as a single quote, so each one is doubled to stay inside the string. */
export const quotePowerShell = (value) => `'${String(value).replace(/['\u2018\u2019\u201a\u201b]/g, (quote) => quote + quote)}'`;
export const quoteCmd = (value) => `"${String(value)}"`;
export const quotePosix = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;

const pathFor = (platform) => (platform === "win32" ? path.win32 : path.posix);

function usablePath(value, platform) {
  const text = typeof value === "string" ? value : "";
  if (!text || text.length > 1024 || CONTROL_CHARS.test(text)) return "";
  return pathFor(platform).isAbsolute(text) ? text : "";
}

/**
 * Lines that say how to start the companion again.
 * @param {object} [options]
 * @param {object} [options.env] where COMPANION_LAUNCHER is read from
 * @param {string} [options.platform] process.platform
 * @param {string} [options.entry] the full path of companion.mjs
 * @param {(file: string) => boolean} [options.exists]
 * @returns {string[]}
 */
export function startAgainLines({ env = process.env, platform = process.platform, entry = "", exists = fs.existsSync } = {}) {
  const windows = platform === "win32";
  let launcher = usablePath(env?.COMPANION_LAUNCHER, platform);
  if (launcher && (!LAUNCHER_NAME.test(pathFor(platform).basename(launcher)) || !exists(launcher))) launcher = "";
  const target = launcher || (entry ? usablePath(pathFor(platform).resolve(String(entry)), platform) : "");
  if (!target) return [];

  const lead = launcher ? "" : "node ";
  if (!windows) return [`Next time, start it from any folder with: ${lead}${quotePosix(target)}`];

  // A Windows path cannot hold a double quote, so the Command Prompt form is only left out for a % (cmd would expand it).
  const lines = [`Next time, start it from any folder with: ${launcher ? "& " : lead}${quotePowerShell(target)}`];
  if (!/[%"]/.test(target) && !/\.ps1$/i.test(target)) lines.push(`In Command Prompt (cmd.exe), use: ${lead}${quoteCmd(target)}`);
  return lines;
}
