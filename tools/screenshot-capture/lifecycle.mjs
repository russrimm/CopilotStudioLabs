// What goes wrong around the browser, not on the page: the person closes the window, a navigation is
// interrupted, a tab crashes. Each is told apart from a page problem so the companion can stop once with one
// clear message, retry what is worth retrying, or open a fresh tab, instead of failing every remaining shot.
//
// Navigation here is also where the companion stays out of the way of a sign-in: it never navigates a page that is
// on a sign-in host, and never retries a navigation once the browser has been sent there. Every navigation is
// written to the trace with its reason.

import { classifyUrl, currentAddress, redactedAddress } from "./signin-url.mjs";

const BROWSER_CLOSED_RE = /Target page, context or browser has been closed|Target closed|Browser has been closed|browser has been closed|has disconnected|Protocol error \([^)]*\): (?:Target|Session) closed|Connection closed|Browser closed/i;
const PAGE_CRASH_RE = /Target crashed|Page crashed|page crashed|Aw, Snap/i;
const TRANSIENT_RE = /net::ERR_(?:ABORTED|CONNECTION_RESET|CONNECTION_CLOSED|CONNECTION_REFUSED|NETWORK_CHANGED|TIMED_OUT|EMPTY_RESPONSE|HTTP2_PROTOCOL_ERROR|SOCKET_NOT_CONNECTED|INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|FAILED)|Navigation (?:failed|interrupted)|interrupted by another navigation|frame was detached|Timeout \d+ms exceeded|NS_BINDING_ABORTED/i;

export class BrowserClosedError extends Error {
  constructor(message = "The browser window was closed.") {
    super(message);
    this.name = "BrowserClosedError";
    this.code = "BROWSER_CLOSED";
  }
}

/** "browser-closed", "page-crashed", "transient" (worth trying again), or "other". */
export function classifyBrowserError(err) {
  const text = String(err?.message || err || "");
  if (err instanceof BrowserClosedError || BROWSER_CLOSED_RE.test(text)) return "browser-closed";
  if (PAGE_CRASH_RE.test(text)) return "page-crashed";
  if (TRANSIENT_RE.test(text)) return "transient";
  return "other";
}

export const isBrowserClosedError = (err) => classifyBrowserError(err) === "browser-closed";

/** The first line of a browser error, without the call log, for messages a person reads. */
export function briefError(err) {
  return String(err?.message || err || "").split("\n")[0].replace(/\s+/g, " ").trim().slice(0, 240);
}

/**
 * Remember that a browser context closed, whether the person closed the window or the browser stopped.
 * Returns `{ closed(): boolean }`.
 */
export function watchContext(context) {
  const state = { closed: false, crashed: new WeakSet() };
  try {
    context?.on?.("close", () => {
      state.closed = true;
    });
  } catch {
    // A driver without events: the next call that fails tells us.
  }
  return {
    closed: () => state.closed || context?.isCompanionClosed?.() === true,
    watchPage(page) {
      try {
        page?.on?.("crash", () => state.crashed.add(page));
      } catch {
        // Not every driver has page events.
      }
    },
    crashed: (page) => state.crashed.has(page),
  };
}

const lastNavigation = new WeakMap();

/** Whether the document of the page is still loading (a plain read; a page that cannot be asked counts as loaded). */
async function stillLoading(page) {
  if (typeof page?.evaluate !== "function") return false;
  try {
    return ["loading", "interactive"].includes(await page.evaluate(() => document.readyState));
  } catch {
    return false;
  }
}

/**
 * Go to an address, trying again when the navigation was interrupted (ERR_ABORTED), reset, or timed out.
 * A closed browser is never retried: it throws `BrowserClosedError` at once.
 *
 * It stays passive around sign-in: when the page is already on a sign-in host it does not navigate at all (it
 * returns `{ skipped: "sign-in" }`), and a navigation that ended on a sign-in host is never retried, because the
 * browser was sent there on purpose and a person may be typing. `reason` says why the navigation happens (for the trace).
 *
 * Navigation guard: an address that is already loading is never opened again (a restart only makes a slow page slower), and with
 * `settleMs` the same address is not opened again within that many milliseconds of the last time. Both return `{ skipped: "same-address" }`
 * and are written to the trace; `reload: true` is the one deliberate way to open the address again.
 */
export async function gotoWithRetry(page, url, { waitUntil = "domcontentloaded", timeout = 30_000, retries = 2, backoffMs = [1000, 3000], sleep = (ms) => new Promise((r) => setTimeout(r, ms)), trace = null, log = null, reason = "open-address", force = false, settleMs = 0, reload = false } = {}) {
  const from = currentAddress(page);
  if (!force && classifyUrl(from).kind === "sign-in") {
    trace?.event("navigation-skipped", { reason, why: "the page is on a sign-in page, so the companion only watches", from: redactedAddress(from), to: redactedAddress(url) });
    return { skipped: "sign-in" };
  }
  if (!reload && from && from !== "about:blank" && sameAddress(from, url)) {
    const last = lastNavigation.get(page);
    const recent = settleMs > 0 && last && sameAddress(last.url, url) && Date.now() - last.at < settleMs;
    if (recent || (await stillLoading(page))) {
      trace?.event("navigation-skipped", { reason, why: recent ? "the same address was opened a moment ago, so the page is given time instead of being opened again" : "the page is still loading", from: redactedAddress(from), to: redactedAddress(url) });
      return { skipped: "same-address" };
    }
  }
  trace?.event("navigation", { reason: reload ? `${reason} (reload)` : reason, from: redactedAddress(from), to: redactedAddress(url) });
  lastNavigation.set(page, { url, at: Date.now() });
  let attempt = 0;
  for (;;) {
    try {
      return await page.goto(url, { waitUntil, timeout });
    } catch (err) {
      const kind = classifyBrowserError(err);
      if (kind === "browser-closed") throw new BrowserClosedError();
      if (kind === "page-crashed") throw err;
      if (kind !== "transient" || attempt >= retries) throw err;
      // An interrupted navigation can still have landed: a page that is already at the address is a success.
      try {
        const now = currentAddress(page);
        if (now && now !== "about:blank" && sameAddress(now, url)) return null;
        // The browser was sent to a sign-in page (that is what interrupted the navigation): leave it alone.
        if (classifyUrl(now).kind === "sign-in") {
          trace?.event("navigation-retry-skipped", { reason, why: "the browser is on a sign-in page", at: redactedAddress(now) });
          return { skipped: "sign-in" };
        }
      } catch {
        // Fall through and retry.
      }
      const wait = backoffMs[Math.min(attempt, backoffMs.length - 1)] ?? 1000;
      attempt += 1;
      trace?.event("navigation-retry", { attempt, reason, why: briefError(err).replace(/Call log.*$/i, ""), waitMs: wait });
      log?.(`  The page did not open (${briefError(err).replace(/^page\.goto: /, "").replace(/ at https?:.*$/i, "")}). Trying again.`);
      await sleep(wait);
      // Look again after the pause: a sign-in page may have opened meanwhile.
      if (!force && classifyUrl(currentAddress(page)).kind === "sign-in") {
        trace?.event("navigation-retry-skipped", { reason, why: "a sign-in page opened while waiting", at: redactedAddress(currentAddress(page)) });
        return { skipped: "sign-in" };
      }
    }
  }
}

/**
 * Open an address and make sure the product (not a sign-in page) is showing, waiting for the person to sign in
 * when it is not. When the navigation was skipped because sign-in was already in progress, the address is
 * opened once the sign-in is done.
 * @returns {Promise<{ok: true, waited: boolean} | {ok: false, signIn: object}>}
 */
export async function navigateWithSignIn({ page, url, gate, sleep, trace = null, log = null, reason = "open-address", waitUntil = "domcontentloaded", timeout, settleMs = 0, reload = false }) {
  const first = await gotoWithRetry(page, url, { sleep, trace, log, waitUntil, reason, settleMs, reload, ...(timeout ? { timeout } : {}) });
  let signedIn = await gate.ensureSignedIn(page, { phase: "navigate", target: url });
  if (!signedIn.ok) return { ok: false, signIn: signedIn };
  const skipped = first?.skipped === "sign-in";
  const deepTarget = (() => {
    try {
      return new URL(url).pathname.replace(/\/$/, "") !== "";
    } catch {
      return false;
    }
  })();
  // Real products land on their home page after a fresh sign-in, not on the address that was asked for.
  const landedElsewhere = signedIn.waited === true && deepTarget;
  if ((skipped || landedElsewhere) && !sameAddress(currentAddress(page), url)) {
    await gotoWithRetry(page, url, { sleep, trace, log, waitUntil, reason: `${reason} (after sign-in)`, ...(timeout ? { timeout } : {}) });
    signedIn = await gate.ensureSignedIn(page, { phase: "navigate", target: url });
    if (!signedIn.ok) return { ok: false, signIn: signedIn };
  }
  return { ok: true, waited: signedIn.waited === true };
}

/** Wait for the address to stop changing (single-page apps redirect after they load), and return it. */
export async function settleAddress(page, { sleep = (ms) => new Promise((r) => setTimeout(r, ms)), stableMs = 700, maxMs = 8000, stepMs = 150 } = {}) {
  let last = typeof page.url === "function" ? page.url() : "";
  let stable = 0;
  let waited = 0;
  while (waited < maxMs) {
    await sleep(stepMs);
    waited += stepMs;
    const now = page.url();
    if (now !== last) {
      last = now;
      stable = 0;
    } else {
      stable += stepMs;
      if (stable >= stableMs) break;
    }
  }
  return last;
}

function sameAddress(a, b) {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.origin === y.origin && x.pathname.replace(/\/$/, "") === y.pathname.replace(/\/$/, "");
  } catch {
    return false;
  }
}

/**
 * A page that can be used: the same one when it is open, a new tab in the same browser when it was closed or
 * crashed, and `BrowserClosedError` when the whole browser is gone.
 */
export async function ensureLivePage(context, page, { watcher = null, trace = null } = {}) {
  if (watcher?.closed()) throw new BrowserClosedError();
  const closed = typeof page?.isClosed === "function" ? page.isClosed() : false;
  const crashed = Boolean(page && watcher?.crashed(page));
  if (page && !closed && !crashed) return page;
  try {
    const fresh = await context.newPage();
    watcher?.watchPage(fresh);
    await fresh.bringToFront?.().catch(() => {});
    trace?.event("page-reopened", { why: crashed ? "crashed" : "closed" });
    return fresh;
  } catch (err) {
    throw classifyBrowserError(err) === "browser-closed" || watcher?.closed() ? new BrowserClosedError() : err;
  }
}
