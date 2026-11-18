// Where the companion keeps its data: the pairing file, the browser sign-in, traces, recipes, and the practice-agent
// list. That folder holds a live browser profile (a locked cookie database, files written all the time) and a saved
// sign-in that lets anyone who has it act as the account. A folder that a sync service (OneDrive, Dropbox, iCloud
// Drive, Google Drive) manages can lock or lose those files, which looks like a sign-in that never sticks, and it
// uploads the sign-in to the cloud. So the data lives in a local folder of this computer, never in a synced one.
//
// Nothing here reads file contents. It only looks at paths, environment variables, and (on Windows) folder attributes.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DATA_FOLDER_NAMES = Object.freeze({ win32: "CopilotStudioLabsCompanion", darwin: "CopilotStudioLabsCompanion", posix: "copilot-studio-labs-companion" });

const pathFor = (platform) => (platform === "win32" ? path.win32 : path.posix);

/** The local, per-user folder for companion data on this operating system. */
export function localDataHome({ platform = process.platform, env = process.env, homedir = os.homedir() } = {}) {
  const p = pathFor(platform);
  if (platform === "win32") return p.join(env.LOCALAPPDATA || p.join(homedir, "AppData", "Local"), DATA_FOLDER_NAMES.win32);
  if (platform === "darwin") return p.join(homedir, "Library", "Application Support", DATA_FOLDER_NAMES.darwin);
  return p.join(env.XDG_DATA_HOME || p.join(homedir, ".local", "share"), DATA_FOLDER_NAMES.posix);
}

// ── Is this folder synced? ─────────────────────────────────────────────────

const SEGMENT_PROVIDERS = Object.freeze([
  { id: "onedrive", label: "OneDrive", test: /^onedrive(?:\s*-\s*.+|-.+)?$/i },
  { id: "dropbox", label: "Dropbox", test: /^dropbox(?:\s*\(.+\)|\s*-\s*.+)?$/i },
  { id: "icloud", label: "iCloud Drive", test: /^(?:icloud\s*drive|iclouddrive|com~apple~clouddocs)$/i },
  { id: "gdrive", label: "Google Drive", test: /^(?:google\s*drive|googledrive(?:-.+)?|my drive)$/i },
  { id: "box", label: "Box", test: /^box(?:\s*sync)?$/i },
]);
const ENV_PROVIDERS = Object.freeze([
  { name: "OneDriveCommercial", id: "onedrive", label: "OneDrive" },
  { name: "OneDriveConsumer", id: "onedrive", label: "OneDrive" },
  { name: "OneDrive", id: "onedrive", label: "OneDrive" },
]);
// File Provider and cloud-file flags that Windows puts on placeholders a sync service manages.
const CLOUD_FLAGS = /\b(?:Offline|RecallOnOpen|RecallOnDataAccess|Pinned|Unpinned)\b/i;

const normalizeForCompare = (value, platform) => {
  const p = pathFor(platform);
  let text = p.normalize(String(value || "")).replace(/[\\/]+$/, "");
  if (platform === "win32") text = text.toLowerCase();
  return text;
};

function isInside(child, parent, platform) {
  if (!parent) return false;
  const a = normalizeForCompare(child, platform);
  const b = normalizeForCompare(parent, platform);
  if (!b) return false;
  const sep = platform === "win32" ? "\\" : "/";
  return a === b || a.startsWith(`${b}${sep}`);
}

/** The folder and its parents, nearest first, up to the root. */
export function ancestorChain(target, { platform = process.platform, max = 12 } = {}) {
  const p = pathFor(platform);
  const chain = [];
  let current = p.resolve(String(target || ""));
  for (let i = 0; i < max; i += 1) {
    chain.push(current);
    const parent = p.dirname(current);
    if (!parent || parent === current) break;
    current = parent;
  }
  return chain;
}

/**
 * The attributes Windows reports for a folder and its parents, in one PowerShell call (names only, no contents).
 * Returns `[{ path, attributes }]`; an empty list when it cannot be read. Only used on Windows.
 */
export function windowsFolderAttributes(target, { exec = execFileSync, platform = process.platform } = {}) {
  if (platform !== "win32") return [];
  const script = "$p=$args[0]; for($i=0;$i -lt 8 -and $p;$i++){ if(Test-Path -LiteralPath $p){ $a=(Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue).Attributes; if($a){ \"$p|$a\" } }; $n=Split-Path -Path $p -Parent; if(-not $n -or $n -eq $p){break}; $p=$n }";
  try {
    const out = exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script, String(target)], { encoding: "utf8", timeout: 6000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    return String(out || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const at = line.lastIndexOf("|");
        return at > 0 ? { path: line.slice(0, at), attributes: line.slice(at + 1) } : null;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Whether a folder is managed by a sync service. Checks, in order: the folder names on its path (OneDrive, Dropbox,
 * iCloud Drive, Google Drive, Box, and macOS CloudStorage), the OneDrive environment variables, and on Windows the
 * cloud-file attributes of the folder and its parents (a reparse point that is read-only or marked as a cloud file,
 * which is how OneDrive Files On-Demand shows up).
 * @returns {{synced: boolean, provider: string|null, why: string|null}}
 */
export function detectSyncedFolder(target, { platform = process.platform, env = process.env, attributesOf = null } = {}) {
  const p = pathFor(platform);
  const resolved = p.resolve(String(target || ""));
  const segments = resolved.split(platform === "win32" ? /[\\/]+/ : /\/+/).filter(Boolean);

  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    const previous = (segments[i - 1] || "").toLowerCase();
    // macOS File Provider folders live in Library/CloudStorage/<Provider>-<account>.
    if (previous === "cloudstorage" && (segments[i - 2] || "").toLowerCase() === "library") {
      const known = SEGMENT_PROVIDERS.find((entry) => entry.test.test(segment)) || SEGMENT_PROVIDERS.find((entry) => segment.toLowerCase().startsWith(entry.id));
      return { synced: true, provider: known?.label || "a cloud storage service", why: "its path is inside Library/CloudStorage" };
    }
    if (segment.toLowerCase() === "mobile documents" && previous === "library") return { synced: true, provider: "iCloud Drive", why: "its path is inside iCloud Drive" };
    const hit = SEGMENT_PROVIDERS.find((entry) => entry.test.test(segment));
    if (hit) return { synced: true, provider: hit.label, why: `its path contains the ${hit.label} folder` };
  }

  for (const entry of ENV_PROVIDERS) {
    const root = env?.[entry.name];
    if (root && isInside(resolved, root, platform)) return { synced: true, provider: entry.label, why: `it is inside the ${entry.name} folder` };
  }

  const read = attributesOf || (platform === "win32" ? (value) => windowsFolderAttributes(value, { platform }) : () => []);
  for (const item of read(resolved) || []) {
    const attributes = String(item?.attributes || "");
    if (!/ReparsePoint/i.test(attributes)) continue;
    if (CLOUD_FLAGS.test(attributes) || /ReadOnly/i.test(attributes)) return { synced: true, provider: "a cloud sync service", why: "Windows marks it as a cloud-synced folder (a read-only reparse point)" };
  }
  return { synced: false, provider: null, why: null };
}

// ── Choosing the data folder ───────────────────────────────────────────────

/**
 * Decide where the data lives.
 * An explicit --home or COMPANION_HOME is honored; otherwise it is the local per-user folder. Data left beside the
 * code by an older companion is reported as `legacy`.
 */
export function resolveHome({ explicit = "", envHome = "", codeDir, platform = process.platform, env = process.env, homedir = os.homedir(), allowSynced = false, detect = detectSyncedFolder, attributesOf = null, exists = (file) => fs.existsSync(file) } = {}) {
  const defaultDir = localDataHome({ platform, env, homedir });
  const chosen = String(explicit || "").trim() || String(envHome || "").trim();
  const source = explicit ? "option" : envHome ? "environment" : "default";
  const home = chosen ? path.resolve(chosen) : defaultDir;
  const synced = detect(home, { platform, env, attributesOf });
  const result = { home, source, defaultDir, synced, allowSynced: Boolean(allowSynced), refused: synced.synced && !allowSynced, legacy: null };
  if (source === "default" && codeDir) {
    const dir = path.resolve(codeDir);
    const hasPairing = exists(path.join(dir, ".companion.json"));
    const hasProfiles = exists(path.join(dir, ".auth"));
    if (path.resolve(dir) !== path.resolve(home) && (hasPairing || hasProfiles)) {
      result.legacy = { dir, hasPairing, hasProfiles, synced: detect(dir, { platform, env, attributesOf }) };
    }
  }
  return result;
}

/** The command that starts the companion with a local folder (shown when a synced folder is refused). */
export function localHomeCommand(defaultDir, { platform = process.platform } = {}) {
  const quoted = platform === "win32" ? `"${defaultDir}"` : `'${defaultDir.replace(/'/g, "'\\''")}'`;
  return `node companion.mjs --home=${quoted}`;
}

/** Why the companion will not use a synced folder, and what to do. Plain language. */
export function syncedHomeMessage(resolved, { platform = process.platform } = {}) {
  const { home, synced, defaultDir } = resolved;
  const provider = synced.provider || "a cloud sync service";
  return [
    `The companion's data folder is inside ${provider} (${home}).`,
    `It holds a live browser profile and your saved sign-in. ${provider} can lock or lose those files, which makes the sign-in loop or never stick, and it uploads the sign-in to the cloud.`,
    `Use a local folder instead:`,
    `    ${localHomeCommand(defaultDir, { platform })}`,
    `(or set COMPANION_HOME to that folder). To use this folder anyway, add --allow-synced-home. That is not recommended.`,
  ].join("\n");
}

/** One or two lines about the data folder, for --status and --check-signin. */
export function describeHomeState(resolved) {
  const { home, source, synced, allowSynced } = resolved;
  const where = source === "option" ? "chosen with --home" : source === "environment" ? "from COMPANION_HOME" : "the default local folder";
  if (!synced.synced) return [`Data folder: ${home} (${where}; local, not synced).`];
  const provider = synced.provider || "a cloud sync service";
  return [`Data folder: ${home} (${where}).`, `  Warning: this folder is inside ${provider}${allowSynced ? " (allowed with --allow-synced-home)" : ""}, so the sign-in may not stick and is uploaded to the cloud. Move it to ${resolved.defaultDir}.`];
}

// ── Moving data from the old place ─────────────────────────────────────────

const MIGRATED_FILES = Object.freeze([".companion.json", ".companion-settings.json", ".practice-agents.json"]);
const MIGRATED_FOLDERS = Object.freeze([".recipes"]);
const SESSION_FILES = Object.freeze(["companion-session.json", "companion-signin.json"]);

/**
 * Bring data that an older companion kept beside its code into the new folder. The pairing file, settings, practice
 * list, and recorded recipes are copied. The browser profile (`.auth`) and captures are NOT copied: a profile from a
 * synced folder may be damaged, so the person signs in once more (when the old folder is not synced, only the small
 * saved-session files are kept, so even that is usually not needed). A pairing file that sits in a synced folder is moved,
 * not copied, so the token does not stay in the cloud.
 * @returns {{copied: string[], movedPairing: boolean, oldProfiles: string|null, skipped: boolean}}
 */
export function migrateLegacyHome({ legacy, home, log = () => {}, fsImpl = fs } = {}) {
  const result = { copied: [], movedPairing: false, oldProfiles: null, skipped: false };
  if (!legacy?.dir || !home) {
    result.skipped = true;
    return result;
  }
  const alreadyThere = fsImpl.existsSync(path.join(home, ".companion.json"));
  if (!alreadyThere) {
    fsImpl.mkdirSync(home, { recursive: true });
    for (const name of MIGRATED_FILES) {
      const from = path.join(legacy.dir, name);
      const to = path.join(home, name);
      if (!fsImpl.existsSync(from) || fsImpl.existsSync(to)) continue;
      try {
        fsImpl.copyFileSync(from, to);
        try {
          fsImpl.chmodSync(to, 0o600);
        } catch {
          // Not every file system supports permissions.
        }
        result.copied.push(name);
        if (name === ".companion.json" && legacy.synced?.synced) {
          fsImpl.rmSync(from, { force: true });
          result.movedPairing = true;
        }
      } catch {
        // A file that cannot be copied is left where it is; the person pairs again.
      }
    }
    for (const name of MIGRATED_FOLDERS) {
      const from = path.join(legacy.dir, name);
      const to = path.join(home, name);
      if (!fsImpl.existsSync(from) || fsImpl.existsSync(to)) continue;
      try {
        fsImpl.cpSync(from, to, { recursive: true });
        result.copied.push(name);
      } catch {
        // Recipes can be recorded again.
      }
    }
  } else result.skipped = true;
  // A saved session (a small cookie file) from a folder that is not synced still works, so keep it and spare a sign-in.
  if (!alreadyThere && !legacy.synced?.synced) {
    const authRoot = path.join(legacy.dir, ".auth");
    try {
      for (const kind of fsImpl.readdirSync(authRoot)) {
        for (const product of fsImpl.readdirSync(path.join(authRoot, kind))) {
          for (const name of SESSION_FILES) {
            const from = path.join(authRoot, kind, product, name);
            const to = path.join(home, ".auth", kind, product, name);
            if (!fsImpl.existsSync(from) || fsImpl.existsSync(to)) continue;
            fsImpl.mkdirSync(path.dirname(to), { recursive: true });
            fsImpl.copyFileSync(from, to);
            result.copied.push(path.join(".auth", kind, product, name));
          }
        }
      }
    } catch {
      // No old sign-in to keep.
    }
  }
  const oldProfiles = path.join(legacy.dir, ".auth");
  if (fsImpl.existsSync(oldProfiles)) result.oldProfiles = oldProfiles;
  if (result.copied.length) log(`Moved this companion's pairing and settings to ${home}. The browser sign-in was not copied: you sign in once more.`);
  return result;
}

/** Delete the old browser sign-in folder beside the code. Only that folder; returns whether it was removed. */
export function deleteOldSignIn({ legacyDir, fsImpl = fs } = {}) {
  if (!legacyDir) return false;
  const target = path.join(legacyDir, ".auth");
  if (!fsImpl.existsSync(target)) return false;
  fsImpl.rmSync(target, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
  return !fsImpl.existsSync(target);
}

/** The lines shown after a migration when the old sign-in folder is still there. */
export function oldSignInAdvice({ oldProfiles, synced }) {
  if (!oldProfiles) return [];
  const where = synced?.synced ? ` It is inside ${synced.provider || "a synced folder"}, so a copy of that sign-in is in the cloud.` : "";
  return [`The old sign-in folder is still at ${oldProfiles}.${where} Delete it with: node companion.mjs --delete-old-signin`];
}
