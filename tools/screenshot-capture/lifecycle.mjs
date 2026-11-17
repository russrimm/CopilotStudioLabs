// What goes wrong around the browser, not on the page: the person closes the window, a navigation is
// interrupted, a tab crashes. Each is told apart from a page problem so the companion can stop once with one
// clear message, retry what is worth retrying, or open a fresh tab, instead of failing every remaining shot.

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
    closed: () => state.closed,
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

/**
 * Go to an address, trying again when the navigation was interrupted (ERR_ABORTED), reset, or timed out.
 * A closed browser is never retried: it throws `BrowserClosedError` at once.
 */
export async function gotoWithRetry(page, url, { waitUntil = "domcontentloaded", timeout = 30_000, retries = 2, backoffMs = [1000, 3000], sleep = (ms) => new Promise((r) => setTimeout(r, ms)), trace = null, log = null } = {}) {
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
        const now = typeof page.url === "function" ? page.url() : "";
        if (now && now !== "about:blank" && sameAddress(now, url)) return null;
      } catch {
        // Fall through and retry.
      }
      const wait = backoffMs[Math.min(attempt, backoffMs.length - 1)] ?? 1000;
      attempt += 1;
      trace?.event("navigation-retry", { attempt, why: briefError(err).replace(/Call log.*$/i, ""), waitMs: wait });
      log?.(`  The page did not open (${briefError(err).replace(/^page\.goto: /, "").replace(/ at https?:.*$/i, "")}). Trying again.`);
      await sleep(wait);
    }
  }
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
