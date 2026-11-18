// Sign-in handling for the Local Capture Companion: telling a sign-in page from the product,
// waiting for the person to sign in once (not once per shot), and keeping that sign-in on this
// computer so the next shot, the next product, the next job, and the next run do not ask again.
//
// The companion never types credentials. The person signs in in the browser window; this module
// only watches the address, waits, and remembers.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BrowserClosedError } from "./lifecycle.mjs";
import { classifyUrl, redactedAddress } from "./signin-url.mjs";
import { createPingPongDetector } from "./signin-diagnosis.mjs";

export { classifyUrl, redactedAddress };

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const BROWSER_KINDS = Object.freeze(["edge", "chrome", "chromium"]);
export const SESSION_FILE = "companion-session.json";
export const META_FILE = "companion-signin.json";
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const SAFE_PRODUCT = /^[a-z0-9-]+$/i;

// ── Product names ──────────────────────────────────────────────────────────

let cachedLabels = null;

/** "Microsoft Copilot Studio" for "copilot-studio"; a readable guess for anything else. */
export function productLabel(product) {
  if (!cachedLabels) {
    try {
      const file = path.resolve(HERE, "..", "feature-tour", "capture-products.json");
      const products = JSON.parse(fs.readFileSync(file, "utf8")).products || {};
      cachedLabels = Object.fromEntries(Object.entries(products).map(([id, entry]) => [id, String(entry.label || id)]));
    } catch {
      cachedLabels = {};
    }
  }
  const id = String(product || "");
  if (cachedLabels[id]) return cachedLabels[id];
  return id.split("-").filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ") || "Microsoft 365";
}

// ── Waiting for the person to sign in ──────────────────────────────────────

const noop = () => {};

const hostOf = (address) => {
  try {
    return new URL(String(address)).hostname.toLowerCase();
  } catch {
    return null;
  }
};

/**
 * One gate per product profile per job. It decides, for every shot of that profile, whether the page
 * is the product or a sign-in page, waits for the person to sign in at most once, and remembers when
 * sign-in did not work so the remaining shots stop instead of asking again.
 *
 * While the page is on a sign-in host the gate only WATCHES (it reads the address and waits). It never
 * navigates, reloads, retries, or takes a picture, so the person can finish typing, approve on a phone, and
 * answer "Stay signed in?". It waits until the page has left the sign-in hosts and stayed on the product,
 * then keeps watching for a few more seconds, because single-page apps often bounce once more to finish
 * signing in. A browser that keeps bouncing between the product and a sign-in host is a loop: the gate stops
 * and diagnoses it (see signin-diagnosis.mjs) instead of trying again.
 *
 * Time here is counted from the waits themselves (not the clock), so tests that skip sleeping stay fast.
 */
export function createAuthGate({
  product,
  waitMs = 10 * 60 * 1000,
  allowWait = true,
  pollMs = 500,
  settleMs = 1500,
  graceMs = 2500,
  confirmMs = 3000,
  firstLoadMs = 0,
  maxEpisodes = 3,
  bounceMs = 20_000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  notify = noop,
  trace = null,
  diagnose = null,
  pingPong = {},
} = {}) {
  const label = productLabel(product);
  const poll = Math.max(1, Math.min(pollMs, Math.floor(waitMs / 4) || 1));
  const state = { clockMs: 0, waitedMs: 0, episodes: 0, signedIn: null, target: null, failed: null, waits: 0, diagnosis: null, vouched: false };
  const detector = createPingPongDetector(pingPong);

  // One time line for hop timing: it moves with the waits above and with real time spent outside them.
  let stamp = 0;
  let lastReal = Date.now();
  let lastClock = 0;
  const stampNow = () => {
    const real = Date.now();
    stamp += Math.max(real - lastReal, state.clockMs - lastClock);
    lastReal = real;
    lastClock = state.clockMs;
    return stamp;
  };

  const read = (page) => {
    let address = "";
    try {
      address = typeof page.url === "function" ? page.url() : "";
    } catch {
      address = "";
    }
    return { address, info: classifyUrl(address) };
  };
  /** Read the address and remember where the browser is, for loop detection. */
  const observe = (page) => {
    const seen = read(page);
    const at = stampNow();
    detector.hop(seen.info, at);
    detector.tick(at);
    return seen;
  };
  const watched = new WeakSet();
  const watchHops = (page) => {
    if (!page || watched.has(page) || typeof page.on !== "function") return;
    watched.add(page);
    try {
      page.on("framenavigated", (frame) => {
        try {
          if (frame && typeof page.mainFrame === "function" && frame !== page.mainFrame()) return;
          const info = classifyUrl(typeof frame?.url === "function" ? frame.url() : read(page).address);
          detector.hop(info, stampNow());
          if (info.kind === "sign-in" || info.kind === "app") trace?.event("page-hop", { product, kind: info.kind, host: info.host, path: info.path });
        } catch {
          // A page that cannot report its address is not a reason to stop.
        }
      });
    } catch {
      // Not every driver has page events; polling still sees most hops.
    }
  };
  const loop = () => detector.result(stampNow());
  const tick = async (ms) => {
    await sleep(ms);
    state.clockMs += ms;
  };
  const fail = (code, message, diagnosis = null) => {
    state.failed = { code, message, diagnosis, keepOpen: code === "ping-pong" };
    state.diagnosis = diagnosis;
    trace?.event("sign-in-failed", { product, code, aadsts: diagnosis?.aadsts || null, bounces: loop().bounces });
    return { ok: false, status: "auth-required", code, error: message, diagnosis };
  };
  /** Fail with the plain reason and, when a diagnosis can be made, the next step. */
  const failWith = async (code, message, page) => {
    const bouncesSeen = loop().bounces;
    // A browser that is bouncing may be on the product at this instant: watch a few seconds for it to show its sign-in page, so a visible error code can be read.
    if (code === "ping-pong" || code === "bounced" || code === "loop") {
      for (let i = 0; i < 12 && read(page).info.kind !== "sign-in"; i += 1) {
        await tick(poll);
        if (typeof page.isClosed === "function" && page.isClosed()) break;
      }
    }
    let diagnosis = null;
    if (typeof diagnose === "function") {
      try {
        diagnosis = (await diagnose({ code, page, product, bounces: bouncesSeen, hops: detector.hops() })) || null;
      } catch {
        diagnosis = null;
      }
    }
    return fail(code, diagnosis?.nextStep ? `${message} ${diagnosis.nextStep}` : message, diagnosis);
  };

  /**
   * Let a page that is about to send the browser to sign-in (single-page apps do, after they load) do it before judging it.
   * The first page of a product is held longer (`holdMs`): the real products show their own page for several seconds before they redirect.
   */
  async function watchForRedirect(page, budgetMs, holdMs = settleMs) {
    let { address, info } = observe(page);
    let stableMs = 0;
    let watchedMs = 0;
    while (info.kind !== "sign-in" && watchedMs < budgetMs && !(info.kind === "app" && stableMs >= holdMs)) {
      await tick(poll);
      watchedMs += poll;
      if (typeof page.isClosed === "function" && page.isClosed()) throw new BrowserClosedError();
      const next = observe(page);
      stableMs = next.address === address ? stableMs + poll : 0;
      address = next.address;
      info = next.info;
    }
    return info;
  }

  async function waitThroughSignIn(page, info) {
    if (state.failed) return { ok: false, status: "auth-required", code: state.failed.code, error: state.failed.message, diagnosis: state.failed.diagnosis };
    if (!allowWait) return fail("headless", `${label} needs a sign-in, but this companion was started with --headless, which cannot ask for one.`);
    if (loop().detected) return failWith("ping-pong", `The browser kept bouncing between ${label} and the sign-in page.`, page);
    if (state.episodes >= maxEpisodes) return failWith("loop", `The browser kept returning to the sign-in page for ${label}.`, page);
    if (state.signedIn && state.signedIn.target === state.target && state.clockMs - state.signedIn.atMs < bounceMs) {
      return failWith("bounced", `You signed in to ${label}, but the browser was sent back to the sign-in page right away. Your organization may not allow this browser.`, page);
    }
    state.episodes += 1;
    state.waits += 1;
    trace?.event("sign-in-wait-start", { product, reason: info.reason, host: info.host, path: info.path });
    let address = read(page).address;
    let stableMs = 0;
    let episodeMs = 0;
    let announced = false;
    // A quick round trip to the sign-in host (silent single sign-on) is not a reason to speak up: only say so if it lasts.
    const announce = () => {
      announced = true;
      notify({
        product,
        label,
        message: `Waiting for you to sign in to ${label} in the browser window. This computer remembers it afterwards. When it asks "Stay signed in?", choose Yes so the sign-in lasts. If you do not see the window, it may be behind other windows: look for the new browser window on the taskbar.`,
      });
    };
    while (state.waitedMs < waitMs) {
      await tick(poll);
      state.waitedMs += poll;
      episodeMs += poll;
      // The person closed the window while we waited: stop waiting for a sign-in nobody can finish.
      if (typeof page.isClosed === "function" && page.isClosed()) throw new BrowserClosedError();
      const next = observe(page);
      stableMs = next.address === address ? stableMs + poll : 0;
      address = next.address;
      if (loop().detected) return failWith("ping-pong", `The browser kept bouncing between ${label} and the sign-in page.`, page);
      if (next.info.kind === "app" && stableMs >= settleMs) {
        // On the product and quiet. Keep watching a little longer: many apps finish signing in with one more round trip.
        const confirmed = await confirmSettled(page, next.address);
        if (confirmed.bounced) {
          stableMs = 0;
          address = confirmed.address;
          continue;
        }
        state.signedIn = { atMs: state.clockMs, target: state.target };
        state.vouched = true;
        trace?.event("sign-in-complete", { product, host: next.info.host, path: next.info.path, waitedMs: state.waitedMs, announced });
        return { ok: true, waited: true };
      }
      if (!announced && episodeMs >= graceMs && next.info.kind !== "app") announce();
    }
    if (!announced) announce();
    return failWith("timeout", `The sign-in to ${label} was not finished in time.`, page);
  }

  /** Watch the product page for `confirmMs` without touching it. Returns `{bounced: true}` when it went back to sign-in. */
  async function confirmSettled(page, startAddress) {
    let quiet = 0;
    let address = startAddress;
    let total = 0;
    while (quiet < confirmMs && total < confirmMs * 3) {
      await tick(poll);
      quiet += poll;
      total += poll;
      if (typeof page.isClosed === "function" && page.isClosed()) throw new BrowserClosedError();
      const seen = observe(page);
      if (seen.info.kind === "sign-in") return { bounced: true, address: seen.address };
      if (seen.address !== address) {
        address = seen.address;
        quiet = 0;
      }
    }
    return { bounced: false, address };
  }

  return {
    product,
    label,
    state,
    detector,
    get failed() {
      return state.failed;
    },
    /** Record that sign-in did not work (for example, a sign-in page that was only recognized after the picture), so the rest of the shots stop. */
    markFailed(code, message) {
      if (!state.failed) fail(code, message);
      return state.failed;
    },
    /**
     * Make sure the page is the product, waiting for the person to sign in if it is a sign-in page.
     * `phase: "navigate"` is the moment right after going to `target`; later checks reuse that target.
     * @returns {Promise<{ok: true, waited?: boolean} | {ok: false, status: "auth-required", code: string, error: string}>}
     */
    async ensureSignedIn(page, { phase = "check", target = null } = {}) {
      if (state.failed) return { ok: false, status: "auth-required", code: state.failed.code, error: state.failed.message, diagnosis: state.failed.diagnosis };
      watchHops(page);
      if (phase === "navigate") state.target = hostOf(target);
      let info = observe(page).info;
      if (phase === "navigate" && info.kind !== "sign-in") {
        const firstLoad = !state.vouched && firstLoadMs > settleMs;
        const holdMs = firstLoad ? firstLoadMs : settleMs;
        if (firstLoad) trace?.event("first-load-watch", { product, holdMs });
        info = await watchForRedirect(page, Math.max(holdMs * 3, 3000), holdMs);
        if (firstLoad && info.kind !== "sign-in") state.vouched = true;
      }
      trace?.event("page-check", { product, phase, kind: info.kind, host: info.host, path: info.path, decision: info.kind === "sign-in" ? `treated as sign-in because ${info.reason}` : `treated as the product (${info.reason})` });
      if (info.kind !== "sign-in") return { ok: true };
      return waitThroughSignIn(page, info);
    },
    /** The sentence shown for every shot that did not run because sign-in did not work. */
    describeFailure(count = 1) {
      const why = state.failed?.message || `${label} needs a sign-in.`;
      const shots = `${count} screenshot${count === 1 ? "" : "s"}`;
      return `${why} Sign in to ${label} on your computer, then retry the ${shots}.`;
    },
  };
}

// ── Keeping the sign-in ────────────────────────────────────────────────────

export function authRoot(home) {
  return path.join(home, ".auth");
}

/** One profile folder per browser and product, so an Edge sign-in and a Chromium sign-in never mix. */
export function profileDir(home, browserKind, product) {
  if (!BROWSER_KINDS.includes(browserKind)) throw new Error(`Unknown browser "${browserKind}".`);
  if (!SAFE_PRODUCT.test(String(product || ""))) throw new Error(`Unknown product "${product}".`);
  return path.join(authRoot(home), browserKind, product);
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writePrivateJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Not every file system supports permissions.
  }
}

/**
 * Save the browser's cookies (including session cookies, which a closed browser profile drops) next to the
 * profile. These files let anyone who has them act as the signed-in account: they stay on this computer.
 */
export async function saveSession({ context, dir, product, browser, captured = false, now = () => Date.now() }) {
  if (!context || typeof context.storageState !== "function") return { saved: false, reason: "no-storage-state" };
  let state;
  try {
    state = await context.storageState();
  } catch {
    return { saved: false, reason: "storage-state-failed" };
  }
  const cookies = (state?.cookies || []).filter((c) => c && c.name && c.value !== undefined);
  if (!cookies.length) return { saved: false, reason: "no-cookies" };
  const meta = readJsonFile(path.join(dir, META_FILE)) || {};
  writePrivateJson(path.join(dir, SESSION_FILE), { version: 1, cookies });
  writePrivateJson(path.join(dir, META_FILE), {
    version: 1,
    product,
    browser,
    savedAt: new Date(now()).toISOString(),
    cookies: cookies.length,
    lastCapturedAt: captured ? new Date(now()).toISOString() : meta.lastCapturedAt || null,
  });
  return { saved: true, cookies: cookies.length };
}

/** Put saved cookies back into a freshly opened browser profile. */
export async function restoreSession({ context, dir, now = () => Date.now(), maxAgeMs = SESSION_MAX_AGE_MS }) {
  const saved = readJsonFile(path.join(dir, SESSION_FILE));
  const meta = readJsonFile(path.join(dir, META_FILE));
  if (!saved || !Array.isArray(saved.cookies) || !saved.cookies.length) return { restored: 0, reason: "nothing-saved" };
  const savedAt = Date.parse(meta?.savedAt || "");
  if (Number.isFinite(savedAt) && now() - savedAt > maxAgeMs) return { restored: 0, reason: "too-old" };
  const nowSec = now() / 1000;
  const cookies = saved.cookies.filter((c) => c && (c.expires === -1 || c.expires === undefined || c.expires > nowSec));
  if (!cookies.length || typeof context?.addCookies !== "function") return { restored: 0, reason: "expired" };
  try {
    await context.addCookies(cookies);
    return { restored: cookies.length, reason: "ok" };
  } catch {
    return { restored: 0, reason: "add-cookies-failed" };
  }
}

function readProfile(dir, browser) {
  let present = false;
  try {
    present = fs.readdirSync(dir).length > 0;
  } catch {
    present = false;
  }
  const meta = readJsonFile(path.join(dir, META_FILE)) || {};
  const savedSession = fs.existsSync(path.join(dir, SESSION_FILE));
  return { browser, profilePresent: present, savedSession, savedAt: meta.savedAt || null, lastCapturedAt: meta.lastCapturedAt || null };
}

/** Sign-in state per product: profile folder, saved session, and last successful capture, for every browser. */
export function readSignInStates(home) {
  const root = authRoot(home);
  const products = new Map();
  for (const kind of BROWSER_KINDS) {
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(root, kind), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !SAFE_PRODUCT.test(entry.name)) continue;
      if (!products.has(entry.name)) products.set(entry.name, []);
      products.get(entry.name).push(readProfile(path.join(root, kind, entry.name), kind));
    }
  }
  return [...products.entries()]
    .map(([product, profiles]) => ({
      product,
      label: productLabel(product),
      profiles,
      signedIn: profiles.some((p) => p.savedSession && p.lastCapturedAt),
      lastCapturedAt: profiles.map((p) => p.lastCapturedAt).filter(Boolean).sort().at(-1) || null,
    }))
    .sort((a, b) => a.product.localeCompare(b.product));
}

/** Products with a sign-in that has worked: the list the portal shows as "signed in". An empty profile folder does not count. */
export function listSignedInProducts(home) {
  return readSignInStates(home).filter((s) => s.signedIn).map((s) => s.product);
}

/** Remove saved sign-ins (all browsers) for the given products, or every product with "all". Returns what was removed. */
export function forgetSignIn(home, products) {
  const wanted = products === "all" ? null : new Set((Array.isArray(products) ? products : [products]).map(String));
  const root = authRoot(home);
  const removed = [];
  for (const kind of BROWSER_KINDS) {
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(root, kind), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !SAFE_PRODUCT.test(entry.name)) continue;
      if (wanted && !wanted.has(entry.name)) continue;
      fs.rmSync(path.join(root, kind, entry.name), { recursive: true, force: true });
      removed.push(`${kind}/${entry.name}`);
    }
  }
  return removed;
}
