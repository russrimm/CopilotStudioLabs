// The wrong-account guard: before the first screenshot of a product, find out which account the session is signed in
// with, and stop with one plain sentence if it is the wrong one.
//
// What it uses: the addresses the job carries (the Copilot Studio agent or environment, the SharePoint site, a
// Power Platform environment, a Foundry project), where the browser actually landed (host and path only), whether the
// page title is empty, and how the sign-in went (see account-source.mjs). It never reads page text and never types,
// clicks, or switches accounts: the person chooses the account themselves.
//
// Privacy: ids and hosts are compared in memory. Decisions, traces, and messages hold fixed sentences and yes/no flags only.

import { accountPayload, classifyAccountSource, landedInOsTenant, readAccountRecord, sameTenantHost, signInPageShown, tenantIdsInUrl, writeAccountRecord } from "./account-source.mjs";
import { readSignInStates } from "./auth.mjs";
import { navigateWithSignIn, settleAddress } from "./lifecycle.mjs";
import { classifyUrl } from "./signin-url.mjs";
import { parseCopilotStudioAddress } from "./targets.mjs";

const SHORT_BROWSER = { edge: "Edge", chrome: "Chrome", chromium: "Chromium" };
const ERROR_PATH_RE = /(?:^|\/)(?:access[-_]?denied|accessdenied|unauthorized|forbidden|not[-_]?found|notfound|no[-_]?access|404|403|error)(?:\/|\.|$)/i;

// ── What the person's addresses say to expect ──────────────────────────────

/**
 * The address (and what it points at) a product's screenshots are expected to come from, from the capture settings.
 * Only a tenant-specific address counts: an admin center's public address says nothing about the account.
 * The ids stay in this object, in memory.
 */
export function expectedFromValues(product, values = {}) {
  const none = { product, hasAddress: false, kind: null, what: "address", url: null, host: null, envId: null, botId: null, tenantIds: [] };
  const url = (field) => (typeof values?.[field] === "string" && /^https:\/\//i.test(values[field]) ? values[field] : null);
  if (product === "copilot-studio") {
    const agent = url("copilotStudioAgentUrl");
    const env = url("copilotStudioUrl");
    const address = agent || env;
    if (!address) return none;
    const parsed = parseCopilotStudioAddress(address);
    if (!parsed.ok || !parsed.envId) return none;
    return { product, hasAddress: true, kind: "copilot-studio", what: parsed.botId ? "agent" : "environment", url: address, host: parsed.host, envId: parsed.envId, botId: parsed.botId || null, tenantIds: tenantIdsInUrl(address) };
  }
  if (product === "sharepoint-ai") {
    const site = url("sharepointSiteUrl");
    if (!site) return none;
    return { product, hasAddress: true, kind: "sharepoint", what: "site", url: site, host: new URL(site).hostname, envId: null, botId: null, tenantIds: [] };
  }
  if (product === "power-platform-ai-hub") {
    const env = url("powerPlatformEnvUrl");
    if (!env) return none;
    const segments = new URL(env).pathname.split("/").filter(Boolean);
    const envId = segments[0] === "environments" ? segments[1] || null : null;
    return { product, hasAddress: Boolean(envId), kind: "power-platform", what: "environment", url: env, host: new URL(env).hostname, envId, botId: null, tenantIds: tenantIdsInUrl(env) };
  }
  if (product === "ai-foundry") {
    const project = url("foundryProjectUrl");
    if (!project) return none;
    return { product, hasAddress: true, kind: "foundry", what: "project", url: project, host: new URL(project).hostname, envId: null, botId: null, tenantIds: tenantIdsInUrl(project) };
  }
  return none;
}

// ── Did the address lead where it should? ──────────────────────────────────

const sameText = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();

/**
 * Whether the page the browser ended on is the one the expected address leads to.
 * state: "ok" (it is), "different" (another environment, site, or project: the account cannot see the expected one),
 * "denied" (an access-denied or not-found page, or the agent never opened), "unknown", or "no-address".
 * It looks at the address (host and path) and whether the page has a title. It does not read the page.
 */
export function assessAccountLanding({ expected, finalUrl, title = null } = {}) {
  if (!expected?.hasAddress) return { state: "no-address", reason: "no-address" };
  const landedInfo = classifyUrl(finalUrl);
  if (landedInfo.kind === "sign-in") return { state: "unknown", reason: "still-signing-in" };
  if (landedInfo.kind !== "app") return { state: "unknown", reason: "cannot-tell" };
  if (ERROR_PATH_RE.test(landedInfo.path)) return { state: "denied", reason: "error-page" };

  if (expected.kind === "copilot-studio") {
    const landed = parseCopilotStudioAddress(finalUrl);
    if (!landed.ok) return { state: "unknown", reason: "cannot-tell" };
    if (!landed.envId) return { state: "unknown", reason: "cannot-tell" };
    if (!sameText(landed.envId, expected.envId)) return { state: "different", reason: "environment-differs" };
    if (expected.botId && !sameText(landed.botId, expected.botId)) return { state: "denied", reason: "agent-not-reached" };
    return { state: "ok", reason: "matches" };
  }
  if (expected.kind === "sharepoint") {
    if (!sameTenantHost(expected.host, landedInfo.host)) return { state: "different", reason: "site-differs" };
    return { state: "ok", reason: "matches" };
  }
  if (expected.kind === "power-platform") {
    const segments = String(finalUrl).split("?")[0].split("/");
    const at = segments.indexOf("environments");
    const landedEnv = at >= 0 ? segments[at + 1] : null;
    if (landedEnv && !sameText(landedEnv, expected.envId)) return { state: "different", reason: "environment-differs" };
    return landedEnv ? { state: "ok", reason: "matches" } : { state: "unknown", reason: "cannot-tell" };
  }
  if (expected.kind === "foundry") {
    const landedTenants = tenantIdsInUrl(finalUrl);
    if (expected.tenantIds.length && landedTenants.length && !landedTenants.some((id) => expected.tenantIds.includes(id))) return { state: "different", reason: "tenant-differs" };
    if (title !== null && String(title).trim() === "") return { state: "unknown", reason: "no-title" };
    return { state: "ok", reason: "matches" };
  }
  return { state: "unknown", reason: "cannot-tell" };
}

// ── The decision ───────────────────────────────────────────────────────────

/**
 * Whether the capture may go on with this account.
 * @param {object} input
 * @param {"separate"|"windows"} input.mode the account mode the person chose (or the default)
 * @param {boolean} [input.explicitMode] the person said it on the command line
 * @param {string} input.source `windows-sso`, `manual`, `saved-session`, or `unknown`
 * @param {object} [input.expected] `expectedFromValues(...)`
 * @param {object} [input.landing] `assessAccountLanding(...)`
 * @param {boolean} [input.confirmed] the person confirmed this profile's account once
 * @param {boolean} [input.autonomous] the shots about to run are automatic ones
 * @param {string} [input.browser] edge, chrome, or chromium
 * @returns {{action: "proceed"|"stop", code: string|null, message: string, verified: boolean}}
 */
export function decideAccount({ mode = "separate", explicitMode = false, source = "unknown", expected = null, landing = null, confirmed = false, autonomous = false, browser = null } = {}) {
  const what = expected?.hasAddress ? expected.what : "address";
  const label = SHORT_BROWSER[browser] || "The browser";
  const mismatch = landing?.state === "different" || landing?.state === "denied";
  const verifiedByAddress = landing?.state === "ok";
  const windowsOnPurpose = mode === "windows" && explicitMode === true && source === "windows-sso";
  const verified = verifiedByAddress || confirmed === true || windowsOnPurpose;

  if (source === "windows-sso" && (mode === "separate" || mismatch)) {
    const owner = mismatch || expected?.hasAddress ? `the account that owns this ${what}` : "a separate account";
    return { action: "stop", code: "windows-account", verified: false, message: `${label} signed in automatically with your Windows work account, not ${owner}. Restart with --browser=chromium, or run --setup-account.` };
  }
  if (mismatch) {
    return { action: "stop", code: "wrong-account", verified: false, message: `You are signed in to a different account than the one that owns that ${what}. Run --setup-account and sign in with the account you want, then retake.` };
  }
  if (autonomous && !verified) {
    return { action: "stop", code: "unverified", verified: false, message: "Automatic capture waits until you have chosen the account. Run --setup-account once and sign in with the account you want (add your agent address in Capture settings to have it checked every time), then retake." };
  }
  return { action: "proceed", code: null, verified, message: "" };
}

// ── Checking one product ───────────────────────────────────────────────────

/**
 * Open the product (at the person's own address when there is one), let sign-in finish without touching it, work out
 * which account this is, and decide whether the capture may go on.
 *
 * @param {object} options
 * @param {object} options.page
 * @param {object} options.gate the product's sign-in gate (see auth.mjs)
 * @param {string} options.product
 * @param {object} options.values the job's capture settings (`targetValuesFromJob`)
 * @param {string} options.startUrl where to open the product when no address is set
 * @param {object} options.ctx `{mode, explicitMode, os, kind}`: how the account mode and this PC's work account were set
 * @param {string} options.dir the browser profile folder (the account classification is kept next to it)
 * @param {boolean} [options.autonomous]
 * @returns {Promise<{ok: boolean, signIn?: object, account: object, decision: object, source: string, landing: object}>}
 */
export async function verifyProductAccount({ page, gate, product, values = {}, startUrl, ctx, dir, autonomous = false, trace = null, log = null, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), navigate = navigateWithSignIn }) {
  const expected = expectedFromValues(product, values);
  const target = expected.url || startUrl;
  const base = { mode: ctx.mode, osWorkAccountDetected: ctx.os?.osWorkAccount ?? null, browser: ctx.kind, inPrivate: ctx.inPrivate === true };
  if (target) {
    const nav = await navigate({ page, url: target, gate, sleep, trace, log, reason: "account-check" });
    if (!nav.ok) return { ok: false, signIn: nav.signIn, account: accountPayload(base), decision: null, source: "unknown", landing: { state: "unknown", reason: "sign-in" } };
  }
  const landedUrl = await settleAddress(page, { sleep });
  let title = null;
  try {
    title = typeof page.title === "function" ? await page.title() : null;
  } catch {
    title = null;
  }
  const record = dir ? readAccountRecord(dir) : null;
  const inOsTenant = landedInOsTenant(landedUrl, ctx.os);
  const shown = signInPageShown(gate.detector?.hops?.() || []);
  const classified = classifyAccountSource({ signInShown: shown, inOsTenant, osWorkAccount: ctx.os?.osWorkAccount ?? null, previous: record?.source || null });
  const landing = assessAccountLanding({ expected, finalUrl: landedUrl, title });
  const decision = decideAccount({ mode: ctx.mode, explicitMode: ctx.explicitMode === true, source: classified.source, expected, landing, confirmed: record?.confirmed === true, autonomous, browser: ctx.kind });
  const verifiedFor = decision.verified && landing.state === "ok" ? expected.what : null;
  if (dir) writeAccountRecord(dir, { source: classified.source, verified: decision.verified, verifiedFor, inOsTenant });
  trace?.event("account-check", { product, source: classified.source, why: classified.why, mode: ctx.mode, browser: ctx.kind, signInShown: shown, inOsTenant, landing: landing.state, landingReason: landing.reason, hasAddress: expected.hasAddress, action: decision.action, code: decision.code, verified: decision.verified });
  return { ok: decision.action === "proceed", account: accountPayload({ ...base, source: classified.source, verified: decision.verified, inOsTenant, verifiedFor }), decision, source: classified.source, landing, verifiedFor };
}

// ── What this computer reports without a job ───────────────────────────────

const SHORT_NAMES = { edge: "Microsoft Edge", chrome: "Google Chrome", chromium: "Chromium" };

/** A browser's short name for a sentence ("Chromium", not "Chromium (installed with Playwright)"). */
export function browserShortName(kind) {
  return SHORT_NAMES[kind] || "the browser";
}

/** One plain sentence about the account in use, for the console. The portal shows the same facts in its own words. */
export function describeAccount(account) {
  const where = account?.browser ? `${SHORT_NAMES[account.browser] || account.browser}${account.inPrivate ? " InPrivate" : ""}` : "the browser";
  if (account?.source === "windows-sso") return `your Windows work account (single sign-on in ${where}). Screenshots come from that account.`;
  const kind = account?.mode === "windows" ? "your sign-in (the Windows work account was allowed)" : "a separate sign-in";
  const same = account?.inOsTenant === true ? " It is the same account Windows uses for work." : "";
  const checked = account?.verified ? (account.verifiedFor ? `verified for your ${account.verifiedFor}` : "confirmed by you") : "not verified yet";
  return `${kind} in ${where}, ${checked}.${same}`;
}

const SOURCE_PRIORITY = ["windows-sso", "unknown", "saved-session", "manual"];

/**
 * The account facts for a heartbeat, from what is kept next to each profile of the browser in use. The worst case wins:
 * one profile signed in by the Windows work account makes the whole report say so.
 */
export function describeAccountState({ home, namespace = "", mode = "separate", osWorkAccount = null, browser = null, inPrivate = false } = {}) {
  const records = [];
  try {
    for (const entry of readSignInStates(home, { namespace })) {
      for (const profile of entry.profiles) {
        if (browser && profile.browser !== browser) continue;
        if (profile.accountSource) records.push({ source: profile.accountSource, verified: profile.accountVerified === true, confirmed: profile.accountConfirmed === true, inOsTenant: profile.accountInOsTenant ?? null, verifiedFor: profile.accountVerifiedFor || null });
      }
    }
  } catch {
    // Nothing to report yet.
  }
  const source = SOURCE_PRIORITY.find((s) => records.some((r) => r.source === s)) || "unknown";
  const verified = records.length > 0 && records.every((r) => r.verified || r.confirmed);
  const inOsTenant = records.some((r) => r.inOsTenant === true) ? true : records.length && records.every((r) => r.inOsTenant === false) ? false : null;
  const verifiedFor = records.find((r) => r.verifiedFor)?.verifiedFor || null;
  return accountPayload({ mode, source, verified, osWorkAccountDetected: osWorkAccount, browser, inOsTenant, inPrivate, verifiedFor });
}
