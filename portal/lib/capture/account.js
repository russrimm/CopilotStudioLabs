/**
 * Which account a computer's screenshots come from, as the portal keeps and shows it.
 *
 * The companion reports yes/no flags and short words only: how the account was chosen, whether it was checked against an
 * address the person gave, and whether this PC has a Windows work account. Nothing here is an account name, a tenant id, or
 * an address, and anything that looks like one is dropped. Old companions (before 1.5.0) send none of it.
 */

import { cleanText } from "./store-util.js";

export const ACCOUNT_SOURCES = Object.freeze(["windows-sso", "manual", "saved-session", "unknown"]);
export const ACCOUNT_MODES = Object.freeze(["separate", "windows"]);
export const ACCOUNT_BROWSERS = Object.freeze(["edge", "chrome", "chromium"]);
export const ACCOUNT_SETUP_STATES = Object.freeze(["requested", "waiting-for-you", "done", "needs-account", "failed"]);
export const VERIFIED_FOR = Object.freeze(["agent", "environment", "site", "project"]);
export const NEEDS_ACCOUNT_CODES = Object.freeze(["windows-account", "wrong-account", "unverified"]);
/** The first companion that reports its account and can choose one. */
export const ACCOUNT_MIN_COMPANION = "1.5.0";

const PRODUCT_ID_RE = /^[a-z0-9-]{1,60}$/;
const COMMAND_ID_RE = /^[a-z0-9_-]{1,60}$/i;

/** Plain text from a companion: no addresses, no email addresses, no ids, bounded. */
function plain(value, max) {
  return cleanText(
    String(value ?? "")
      .replace(/https?:\/\/\S+/gi, "")
      .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, "")
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ""),
    max,
  );
}

const flag = (value) => (typeof value === "boolean" ? value : null);

/** The account facts a heartbeat or a job carries. Null when none were sent (an older companion). */
export function cleanAccount(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return {
    mode: ACCOUNT_MODES.includes(raw.mode) ? raw.mode : "separate",
    source: ACCOUNT_SOURCES.includes(raw.source) ? raw.source : "unknown",
    verified: raw.verified === true,
    osWorkAccountDetected: flag(raw.osWorkAccountDetected),
    browser: ACCOUNT_BROWSERS.includes(raw.browser) ? raw.browser : null,
    inOsTenant: flag(raw.inOsTenant),
    inPrivate: raw.inPrivate === true,
    verifiedFor: VERIFIED_FOR.includes(raw.verifiedFor) ? raw.verifiedFor : null,
  };
}

/** How the last "Choose which account to use" went on a computer. */
export function cleanAccountSetup(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = String(raw.id || "");
  const product = String(raw.product || "");
  if (!COMMAND_ID_RE.test(id) || !PRODUCT_ID_RE.test(product) || !ACCOUNT_SETUP_STATES.includes(raw.state)) return null;
  return { id, product, state: raw.state, message: plain(raw.message, 300) };
}

/** Why a job stopped before capturing: the code and one sentence, never an address. */
export function cleanNeedsAccount(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const message = plain(raw.message, 400);
  if (!message) return null;
  return {
    product: PRODUCT_ID_RE.test(String(raw.product || "")) ? String(raw.product) : "",
    code: NEEDS_ACCOUNT_CODES.includes(raw.code) ? raw.code : "wrong-account",
    message,
  };
}

export { COMMAND_ID_RE, PRODUCT_ID_RE };
