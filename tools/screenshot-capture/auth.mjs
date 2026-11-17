// Sign-in handling for the Local Capture Companion: telling a sign-in page from the product,
// waiting for the person to sign in once (not once per shot), and keeping that sign-in on this
// computer so the next shot, the next product, the next job, and the next run do not ask again.
//
// The companion never types credentials. The person signs in in the browser window; this module
// only watches the address, waits, and remembers.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isSignInUrl } from "./image-verify.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const BROWSER_KINDS = Object.freeze(["edge", "chrome", "chromium"]);
export const SESSION_FILE = "companion-session.json";
export const META_FILE = "companion-signin.json";
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const SAFE_PRODUCT = /^[a-z0-9-]+$/i;

// ── Telling a sign-in page from the product ────────────────────────────────

// Where companies that sign in with their own identity provider (AD FS, SAML, WS-Federation) send people.
const FEDERATED_PATH_RE = /^\/(?:adfs\/(?:ls|oauth2)|saml2?(?:\/|$)|wsfed(?:\/|$)|login\.srf$|ppsecure\/)/i;

/**
 * What an address is, from its host and path only. The query string is ignored: a signed-in page can carry a
 * `redirect_uri=https://login.microsoftonline.com/...` parameter without being a sign-in page.
 *
 * kind: "sign-in" (Microsoft or a company identity provider: password, MFA, "Stay signed in?", account picker,
 * consent), "app" (anything else on the web), "blank" (nothing loaded yet), "error" (the browser's error page).
 */
export function classifyUrl(rawUrl) {
  const value = String(rawUrl ?? "").trim();
  if (!value || /^about:blank/i.test(value)) return { kind: "blank", host: "", path: "", reason: "nothing loaded yet" };
  if (/^chrome-error:/i.test(value)) return { kind: "error", host: "", path: "", reason: "the browser could not load the page" };
  let url;
  try {
    url = new URL(value);
  } catch {
    return { kind: "blank", host: "", path: "", reason: "not an address" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { kind: "blank", host: "", path: "", reason: `scheme ${url.protocol}` };
  const host = url.hostname.toLowerCase();
  const pathname = url.pathname || "/";
  const hostOnly = `${url.protocol}//${url.host}${pathname}`;
  if (isSignInUrl(hostOnly)) {
    const byPath = /\/oauth2\/(?:v2\.0\/)?authorize/i.test(pathname) && !isSignInUrl(`${url.protocol}//${url.host}/`);
    return { kind: "sign-in", host, path: pathname, reason: byPath ? `path=${pathname}` : `host=${host}` };
  }
  if (FEDERATED_PATH_RE.test(pathname)) return { kind: "sign-in", host, path: pathname, reason: `identity provider path=${pathname}` };
  return { kind: "app", host, path: pathname, reason: "not a sign-in host or path" };
}

/** An address with nothing private in it: host and path, no query string, and ids replaced. For logs and traces. */
export function redactedAddress(rawUrl) {
  const info = classifyUrl(rawUrl);
  if (!info.host) return info.kind === "blank" ? "(blank)" : `(${info.kind})`;
  const cleanPath = info.path
    .split("/")
    .map((part) => (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(part) || /^[0-9a-f]{20,}$/i.test(part) || /@/.test(part) ? "{id}" : part.slice(0, 60)))
    .join("/");
  return `${info.host}${cleanPath.slice(0, 120)}`;
}

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
 * Time here is counted from the waits themselves (not the clock), so tests that skip sleeping stay fast.
 */
export function createAuthGate({
  product,
  waitMs = 10 * 60 * 1000,
  allowWait = true,
  pollMs = 500,
  settleMs = 1500,
  graceMs = 2500,
  maxEpisodes = 3,
  bounceMs = 20_000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  notify = noop,
  trace = null,
} = {}) {
  const label = productLabel(product);
  const poll = Math.max(1, Math.min(pollMs, Math.floor(waitMs / 4) || 1));
  const state = { clockMs: 0, waitedMs: 0, episodes: 0, signedIn: null, target: null, failed: null, waits: 0 };

  const read = (page) => {
    let address = "";
    try {
      address = typeof page.url === "function" ? page.url() : "";
    } catch {
      address = "";
    }
    return { address, info: classifyUrl(address) };
  };
  const tick = async (ms) => {
    await sleep(ms);
    state.clockMs += ms;
  };
  const fail = (code, message) => {
    state.failed = { code, message };
    trace?.event("sign-in-failed", { product, code });
    return { ok: false, status: "auth-required", code, error: message };
  };

  /** Let a page that is about to send the browser to sign-in (single-page apps do, after they load) do it before judging it. */
  async function watchForRedirect(page, budgetMs) {
    let { address, info } = read(page);
    let stableMs = 0;
    let watched = 0;
    while (info.kind !== "sign-in" && watched < budgetMs && !(info.kind === "app" && stableMs >= settleMs)) {
      await tick(poll);
      watched += poll;
      const next = read(page);
      stableMs = next.address === address ? stableMs + poll : 0;
      address = next.address;
      info = next.info;
    }
    return info;
  }

  async function waitThroughSignIn(page, info) {
    if (state.failed) return { ok: false, status: "auth-required", code: state.failed.code, error: state.failed.message };
    if (!allowWait) return fail("headless", `${label} needs a sign-in, but this companion was started with --headless, which cannot ask for one.`);
    if (state.episodes >= maxEpisodes) return fail("loop", `The browser kept returning to the sign-in page for ${label}.`);
    if (state.signedIn && state.signedIn.target === state.target && state.clockMs - state.signedIn.atMs < bounceMs) {
      return fail("bounced", `You signed in to ${label}, but the browser was sent back to the sign-in page right away. Your organization may not allow this browser.`);
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
        message: `Waiting for you to sign in to ${label} in the browser window. This computer remembers it afterwards. When it asks "Stay signed in?", choose Yes so the sign-in lasts.`,
      });
    };
    while (state.waitedMs < waitMs) {
      await tick(poll);
      state.waitedMs += poll;
      episodeMs += poll;
      const next = read(page);
      stableMs = next.address === address ? stableMs + poll : 0;
      address = next.address;
      if (next.info.kind === "app" && stableMs >= settleMs) {
        state.signedIn = { atMs: state.clockMs, target: state.target };
        trace?.event("sign-in-complete", { product, host: next.info.host, path: next.info.path, waitedMs: state.waitedMs, announced });
        return { ok: true, waited: true };
      }
      if (!announced && episodeMs >= graceMs && next.info.kind !== "app") announce();
    }
    if (!announced) announce();
    return fail("timeout", `The sign-in to ${label} was not finished in time.`);
  }

  return {
    product,
    label,
    state,
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
      if (state.failed) return { ok: false, status: "auth-required", code: state.failed.code, error: state.failed.message };
      if (phase === "navigate") state.target = hostOf(target);
      let info = read(page).info;
      if (phase === "navigate" && info.kind !== "sign-in") info = await watchForRedirect(page, Math.max(settleMs * 3, 3000));
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
