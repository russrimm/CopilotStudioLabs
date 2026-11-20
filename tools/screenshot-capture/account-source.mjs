// Which account a capture signs in with, worked out from facts that can be checked and never from page text.
//
// On Windows, a browser on a PC that is joined to a work or school account (Microsoft Entra) can sign in to Microsoft
// pages by itself with that Windows account, without showing a sign-in page. That is convenient for the person's
// own work, but it means screenshots can silently come from the corporate tenant instead of the demo tenant the
// person wants. This module finds out whether the PC has such an account, and after sign-in classifies where the
// session's account came from:
//
//   windows-sso    no sign-in page was shown, and the page landed in the Windows work account's own tenant
//   manual         a sign-in page was shown and the person completed it
//   saved-session  a sign-in saved on this computer was restored, and no sign-in page was shown
//   unknown        none of the above can be told
//
// Privacy: tenant ids are compared in memory only. They are never logged, traced, uploaded, displayed, or stored.
// Everything that leaves a function here is a flag or a classification. The Windows account's tenant id is kept on a
// property that does not show up in JSON, spreads, or console output, so it cannot leak by accident.

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const ACCOUNT_MODES = Object.freeze(["separate", "windows"]);
export const ACCOUNT_SOURCES = Object.freeze(["windows-sso", "manual", "saved-session", "unknown"]);
export const ACCOUNT_FILE = "companion-account.json";
/** A visit to a sign-in host shorter than this is a redirect that passed by itself, not a page a person used. */
export const SIGN_IN_SHOWN_MS = 3000;
/** What an address the account was checked against points at (a word, never the address). */
export const VERIFIED_FOR = Object.freeze(["agent", "environment", "site", "project"]);

const GUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const GUID_RE = new RegExp(`^${GUID_SOURCE}$`, "i");

// ── The choice ─────────────────────────────────────────────────────────────

export function parseAccountMode(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return { ok: false, error: "--account-mode needs a value: separate or windows." };
  return ACCOUNT_MODES.includes(text) ? { ok: true, mode: text } : { ok: false, error: `--account-mode must be separate or windows (got "${value}").` };
}

// ── Does this PC have a work account the browser could use? ────────────────

/** Keep the tenant id off every printed or serialized form of the object. */
function withPrivateTenant(flags, tenantId) {
  const out = { ...flags };
  Object.defineProperty(out, "osTenantId", { value: tenantId || null, enumerable: false, writable: false });
  return out;
}

/** The yes/no after `name :` in `dsregcmd /status` output, or null when the line is missing. */
function dsregFlag(text, name) {
  const match = new RegExp(`^[ \\t]*${name}[ \\t]*:[ \\t]*(YES|NO)[ \\t]*\\r?$`, "im").exec(text);
  return match ? match[1].toUpperCase() === "YES" : null;
}

function dsregValue(text, name) {
  const match = new RegExp(`^[ \\t]*${name}[ \\t]*:[ \\t]*(\\S.*?)[ \\t]*\\r?$`, "im").exec(text);
  return match ? match[1] : null;
}

/**
 * Read `dsregcmd /status` text into flags. `osWorkAccount` is true when the PC is joined to Microsoft Entra, registered
 * with a work or school account, or joined to a domain (any of them lets a browser sign in on its own).
 * The tenant id of the Windows work account (the primary refresh token's authority, or the joined tenant) is kept
 * in memory on `osTenantId`, which is not enumerable.
 */
export function parseDsregcmd(output) {
  const text = String(output ?? "");
  const azureAdJoined = dsregFlag(text, "AzureAdJoined");
  const domainJoined = dsregFlag(text, "DomainJoined");
  const workplaceJoined = dsregFlag(text, "WorkplaceJoined");
  const prt = dsregFlag(text, "AzureAdPrt");
  if ([azureAdJoined, domainJoined, workplaceJoined, prt].every((value) => value === null)) {
    return withPrivateTenant({ known: false, osWorkAccount: null, azureAdJoined: null, domainJoined: null, workplaceJoined: null, prt: null }, null);
  }
  const authority = dsregValue(text, "AzureAdPrtAuthority");
  const candidates = [authority && authority.match(new RegExp(GUID_SOURCE, "i"))?.[0], dsregValue(text, "TenantId"), dsregValue(text, "WorkplaceTenantId")];
  const tenantId = candidates.map((value) => String(value || "").trim().toLowerCase()).find((value) => GUID_RE.test(value)) || null;
  return withPrivateTenant(
    {
      known: true,
      osWorkAccount: Boolean(azureAdJoined || workplaceJoined || domainJoined),
      azureAdJoined,
      domainJoined,
      workplaceJoined,
      prt,
    },
    tenantId,
  );
}

/** What this computer has: on Windows from `dsregcmd`, elsewhere "unknown" (no work account is assumed, none is ruled out). */
export function readOsAccount({ exec = execFileSync, platform = process.platform, timeoutMs = 8000 } = {}) {
  if (platform !== "win32") return withPrivateTenant({ known: false, osWorkAccount: null, azureAdJoined: null, domainJoined: null, workplaceJoined: null, prt: null }, null);
  try {
    const out = String(exec("dsregcmd", ["/status"], { encoding: "utf8", timeout: timeoutMs, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }) || "");
    return parseDsregcmd(out);
  } catch {
    return parseDsregcmd("");
  }
}

export const OS_ACCOUNT_FILE = ".companion-os-account.json";

function readRememberedOsAccount(home) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(home, OS_ACCOUNT_FILE), "utf8"));
    return typeof raw?.osWorkAccount === "boolean" ? raw.osWorkAccount : null;
  } catch {
    return null;
  }
}

function rememberOsAccount(home, osWorkAccount) {
  try {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, OS_ACCOUNT_FILE), `${JSON.stringify({ version: 1, osWorkAccount, checkedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
  } catch {
    // Remembering is a convenience only.
  }
}

/** Whether a separate sign-in was ever set up here (its folder exists), which only happens on a PC with a Windows work account. */
function hasSeparateSignIn(home) {
  try {
    return fs.readdirSync(path.join(home, ".auth", "separate")).length > 0;
  } catch {
    return false;
  }
}

/**
 * `readOsAccount`, made safe against one bad reading. A PC that has a Windows work account decides where the sign-in lives
 * (the "separate" folder) and which browser comes first, so a `dsregcmd` that is slow or fails must not silently turn
 * "work account" into "no work account" and send the capture to the shared sign-in. When it cannot be read: try once more
 * with a longer wait, then use what an earlier start saw, then (a separate sign-in exists, so this PC had a work account).
 * Only the yes or no is remembered, never an id.
 * @returns {object} the same shape as `readOsAccount`; `source` says when the answer is not a fresh reading
 */
export function resolveOsAccount({ home, platform = process.platform, read = readOsAccount, log = () => {} } = {}) {
  let found = read();
  if (found.known) {
    if (home) rememberOsAccount(home, found.osWorkAccount === true);
    return found;
  }
  if (platform !== "win32") return found;
  found = read({ timeoutMs: 30_000 });
  if (found.known) {
    if (home) rememberOsAccount(home, found.osWorkAccount === true);
    return found;
  }
  const remembered = home ? readRememberedOsAccount(home) : null;
  const inferred = remembered !== null ? remembered : home && hasSeparateSignIn(home) ? true : null;
  if (inferred === null) return found;
  log(`This PC would not say whether it has a Windows work account, so the answer from earlier is used (${inferred ? "it has one, so your separate sign-in is used" : "it does not"}).`);
  return Object.defineProperty({ known: false, osWorkAccount: inferred, azureAdJoined: null, domainJoined: null, workplaceJoined: null, prt: null, source: "remembered" }, "osTenantId", { value: null, enumerable: false, writable: false });
}

/** The flags that may leave this computer (and nothing else). */
export function osAccountFlags(os) {
  return { known: Boolean(os?.known), osWorkAccount: os?.osWorkAccount === null || os?.osWorkAccount === undefined ? null : Boolean(os.osWorkAccount), prt: os?.prt ?? null };
}

/**
 * Whether the organization makes Microsoft Edge sign every profile in with the work account (the BrowserSignin policy
 * set to "force"). On such a PC a new Edge profile is signed in with the Windows work account within seconds, so a
 * normal Edge window can never be a separate sign-in. Windows only; null when it cannot be read.
 */
export function readEdgeSignInPolicy({ exec = execFileSync, platform = process.platform } = {}) {
  if (platform !== "win32") return null;
  for (const hive of ["HKCU", "HKLM"]) {
    try {
      const out = String(exec("reg", ["query", `${hive}\\SOFTWARE\\Policies\\Microsoft\\Edge`, "/v", "BrowserSignin"], { encoding: "utf8", timeout: 5000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }) || "");
      const match = /BrowserSignin\s+REG_DWORD\s+(0x[0-9a-f]+|\d+)/i.exec(out);
      if (match) return { forced: Number(match[1]) === 2 };
    } catch {
      // Not set in this hive.
    }
  }
  return { forced: false };
}

// ── Comparing tenants, in memory ───────────────────────────────────────────

/**
 * The tenant ids an address carries: the default environment's name (Default-<id>), a tenant in the path, or a
 * tenant parameter. Used for comparison only; the result must never be logged or kept.
 */
export function tenantIdsInUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl ?? ""));
  } catch {
    return [];
  }
  const found = new Set();
  const segments = url.pathname.split("/").filter(Boolean);
  segments.forEach((segment, index) => {
    const lower = segment.toLowerCase();
    const def = new RegExp(`^default-(${GUID_SOURCE})$`, "i").exec(segment);
    if (def) found.add(def[1].toLowerCase());
    if ((lower === "tenants" || lower === "directory") && GUID_RE.test(segments[index + 1] || "")) found.add(segments[index + 1].toLowerCase());
  });
  for (const name of ["tid", "tenantId", "tenant", "directory"]) {
    const value = url.searchParams.get(name);
    if (value && GUID_RE.test(value)) found.add(value.toLowerCase());
  }
  return [...found];
}

/**
 * Whether an address is in the Windows work account's own tenant: true, false, or null when the address carries no
 * tenant id (or the PC has none to compare with).
 */
export function landedInOsTenant(rawUrl, os) {
  const tenant = os?.osTenantId;
  if (!tenant) return null;
  const ids = tenantIdsInUrl(rawUrl);
  if (!ids.length) return null;
  return ids.includes(String(tenant).toLowerCase());
}

/** The tenant-specific part of a SharePoint host (contoso for contoso.sharepoint.com, contoso-my..., contoso-admin...), or "". */
function sharePointTenantLabel(host) {
  const match = /^([a-z0-9-]+?)(?:-admin|-my)?\.sharepoint(?:-df)?\.com$/i.exec(String(host || "").trim());
  return match ? match[1].toLowerCase() : "";
}

/** Whether two hosts belong to the same SharePoint tenant. Other hosts match only when they are the same host. */
export function sameTenantHost(a, b) {
  const left = String(a || "").toLowerCase();
  const right = String(b || "").toLowerCase();
  if (!left || !right) return false;
  const x = sharePointTenantLabel(left);
  const y = sharePointTenantLabel(right);
  if (x || y) return x === y;
  return left === right;
}

// ── Was a sign-in page shown? ──────────────────────────────────────────────

/**
 * From the hops a sign-in gate recorded (`{at, kind}` in milliseconds), whether the browser stayed on a sign-in page
 * long enough for a person to have used it. A redirect that passed in a moment is single sign-on, not a page shown.
 */
export function signInPageShown(hops, { minMs = SIGN_IN_SHOWN_MS, endAt = null } = {}) {
  const list = Array.isArray(hops) ? hops : [];
  for (let i = 0; i < list.length; i += 1) {
    if (list[i]?.kind !== "sign-in") continue;
    const next = list[i + 1];
    const end = next ? next.at : endAt;
    if (end === null || end === undefined) continue;
    if (end - list[i].at >= minMs) return true;
  }
  return false;
}

// ── Classifying the session's account ──────────────────────────────────────

/**
 * Where the session's account came from.
 * @param {object} input
 * @param {boolean} input.signInShown a sign-in page was shown to the person and finished
 * @param {boolean|null} input.inOsTenant the landed address is in the Windows work account's tenant (null: cannot tell)
 * @param {boolean|null} input.osWorkAccount this PC has a work account the browser could use
 * @param {string|null} [input.previous] how this profile was classified before
 * @param {boolean} [input.setup] the person just chose the account in account setup
 * @returns {{source: string, why: string}}
 */
export function classifyAccountSource({ signInShown = false, inOsTenant = null, osWorkAccount = null, previous = null, setup = false } = {}) {
  if (setup || signInShown) return { source: "manual", why: "a sign-in page was shown and completed" };
  const before = ACCOUNT_SOURCES.includes(previous) ? previous : null;
  if (before === "manual" || before === "saved-session") return { source: "saved-session", why: "a sign-in saved on this computer was restored" };
  if (osWorkAccount && inOsTenant === true) return { source: "windows-sso", why: "no sign-in page was shown and the page landed in the Windows work account's tenant" };
  if (inOsTenant === false) return { source: "saved-session", why: "no sign-in page was shown and the page did not land in the Windows work account's tenant" };
  if (before === "windows-sso") return { source: "windows-sso", why: "this profile was signed in by the Windows work account before" };
  return { source: "unknown", why: "the account could not be told apart" };
}

// ── What is kept on this computer about a profile's account ────────────────

const SIGN_IN_ID_RE = /^[0-9a-f]{12}$/;

/**
 * `{source, confirmed, verified, verifiedFor, inOsTenant, classifiedAt, signInId}` for a profile folder, or null. Flags only: no account
 * names, no ids. `signInId` is a random marker made when the profile's first record is written; a profile that is cleared (choosing the
 * account again) loses its record, so the next sign-in gets a new marker. It says "the same sign-in as before", never who it is.
 */
export function readAccountRecord(dir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, ACCOUNT_FILE), "utf8"));
    if (!raw || typeof raw !== "object") return null;
    return {
      source: ACCOUNT_SOURCES.includes(raw.source) ? raw.source : "unknown",
      confirmed: raw.confirmed === true,
      verified: raw.verified === true,
      verifiedFor: VERIFIED_FOR.includes(raw.verifiedFor) ? raw.verifiedFor : null,
      inOsTenant: typeof raw.inOsTenant === "boolean" ? raw.inOsTenant : null,
      classifiedAt: typeof raw.classifiedAt === "string" ? raw.classifiedAt : null,
      signInId: SIGN_IN_ID_RE.test(String(raw.signInId || "")) ? raw.signInId : null,
    };
  } catch {
    return null;
  }
}

/**
 * Save a profile's classification, whether the person confirmed the account once, and whether it reached an address the
 * person gave. A value left out keeps what was saved before.
 */
export function writeAccountRecord(dir, { source, confirmed, verified, verifiedFor, inOsTenant }, { now = () => Date.now() } = {}) {
  const previous = readAccountRecord(dir);
  const isVerified = verified === undefined ? previous?.verified === true : verified === true;
  const record = {
    version: 1,
    source: ACCOUNT_SOURCES.includes(source) ? source : "unknown",
    confirmed: confirmed === undefined ? previous?.confirmed === true : confirmed === true,
    verified: isVerified,
    verifiedFor: isVerified ? (VERIFIED_FOR.includes(verifiedFor) ? verifiedFor : verifiedFor === undefined ? previous?.verifiedFor ?? null : null) : null,
    inOsTenant: inOsTenant === undefined ? previous?.inOsTenant ?? null : typeof inOsTenant === "boolean" ? inOsTenant : null,
    classifiedAt: new Date(now()).toISOString(),
    signInId: previous?.signInId || crypto.randomBytes(6).toString("hex"),
  };
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, ACCOUNT_FILE);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
  return record;
}

// ── The payload the portal sees ────────────────────────────────────────────

/**
 * The account facts a heartbeat or a job report carries. Flags and short words only.
 * `verified` is true once the account reached an address the person gave, or the person confirmed it.
 * `inOsTenant` says the session is in the same tenant as the Windows work account (true, false, or null when it cannot be told).
 */
export function accountPayload({ mode, source = "unknown", verified = false, osWorkAccountDetected = null, browser = null, inOsTenant = null, inPrivate = false, verifiedFor = null } = {}) {
  return {
    mode: ACCOUNT_MODES.includes(mode) ? mode : "separate",
    source: ACCOUNT_SOURCES.includes(source) ? source : "unknown",
    verified: verified === true,
    osWorkAccountDetected: osWorkAccountDetected === null || osWorkAccountDetected === undefined ? null : Boolean(osWorkAccountDetected),
    browser: ["edge", "chrome", "chromium"].includes(browser) ? browser : null,
    inOsTenant: typeof inOsTenant === "boolean" ? inOsTenant : null,
    inPrivate: inPrivate === true,
    verifiedFor: VERIFIED_FOR.includes(verifiedFor) ? verifiedFor : null,
  };
}
