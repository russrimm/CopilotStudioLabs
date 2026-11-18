/**
 * The command that starts the Local Capture Companion, as the pairing API returns it.
 *
 * The portal cannot know where a person unzipped the download, so the command uses the launcher's
 * path as it appears inside the ZIP, relative to the folder the ZIP was unzipped into. The Screenshot
 * Center adds the full path in the browser when the person says which folder it is. The `launcher`
 * field carries the pieces so the browser builds each shell's form; `command` stays for older clients.
 */

import { COMPANION_LAUNCHER } from "./companion-zip.js";

// Only plain host names and addresses go into a command. Anything else is left out, and the companion asks for it instead.
const SAFE_PORTAL = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/;
const SAFE_CODE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;

/** The `--portal` and `--code` arguments that are safe to paste into any shell. */
function pairingArguments({ portalUrl, code }) {
  const args = [];
  if (SAFE_PORTAL.test(String(portalUrl || ""))) args.push(`--portal=${portalUrl}`);
  if (SAFE_CODE.test(String(code || ""))) args.push(`--code=${code}`);
  return args;
}

/**
 * @param {{portalUrl: string, code: string}} input
 * @returns {{command: string, launcher: {relativeDir: string, windows: string, powershell: string, posix: string}}}
 */
export function buildPairingCommands({ portalUrl, code }) {
  const windowsLauncher = `.\\${COMPANION_LAUNCHER.windows.replace(/\//g, "\\")}`;
  return {
    command: [windowsLauncher, ...pairingArguments({ portalUrl, code })].join(" "),
    launcher: { ...COMPANION_LAUNCHER },
  };
}
