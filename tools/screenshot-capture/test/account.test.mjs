// Hermetic tests for choosing and checking the account the screenshots come from: reading what this PC has (dsregcmd),
// how a session's account is classified, the default browser order, profile folders per account mode, the wrong-account
// guard, the account setup (which never clicks), and that no tenant id, host, or account name ever reaches a trace or a verdict.
// Every id, host, and account below is fake.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { accountStartLines, commandValues, createPortalClient, openProfile, parseArgs, PortalError, runCompanion, runJob } from "../companion.mjs";
import { accountPayload, classifyAccountSource, landedInOsTenant, osAccountFlags, parseAccountMode, parseDsregcmd, readAccountRecord, readEdgeSignInPolicy, readOsAccount, sameTenantHost, signInPageShown, tenantIdsInUrl, writeAccountRecord } from "../account-source.mjs";
import { assessAccountLanding, decideAccount, describeAccount, describeAccountState, expectedFromValues, verifyProductAccount } from "../account-guard.mjs";
import { runSetupAccount, setupInstructions } from "../account-setup.mjs";
import { attachArgs, closeStrayTabs, fitWindow } from "../attach.mjs";
import { createAuthGate, forgetSignIn, listSignedInProducts, profileDir, profileNamespace, readSignInStates, saveSession } from "../auth.mjs";
import { autoBrowserOrder, chooseBrowsers, launchBrowser, launchPolicy } from "../browsers.mjs";
import { createTrace } from "../trace.mjs";
import { createFakePlaywright } from "./fixtures/fake-playwright.mjs";

const OS_TENANT = "0a1b2c3d-1111-4222-8333-444455556666";
const DEMO_TENANT = "9f8e7d6c-aaaa-4bbb-8ccc-ddddeeeeffff";
const DEMO_ENV = "5e5e5e5e-1234-4abc-8def-0123456789ab";
const BOT = "b0b0b0b0-5678-4abc-8def-abcdefabcdef";
const FAKE_SITE_HOST = "fakecorp-demo.sharepoint.com";
const FAKE_UPN = "ada.fake@example.invalid";
const APP = "https://copilotstudio.microsoft.com/";
const LOGIN = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x";
const AGENT_URL = `https://copilotstudio.microsoft.com/environments/${DEMO_ENV}/bots/${BOT}/overview`;
const PRIVATE_VALUES = [OS_TENANT, DEMO_TENANT, DEMO_ENV, BOT, FAKE_SITE_HOST, FAKE_UPN, "fakecorp"];

const dsreg = ({ azureAd = "YES", domain = "NO", workplace = "NO", prt = "YES", authority = `https://login.microsoftonline.com/${OS_TENANT}`, tenantId = null } = {}) => `
+----------------------------------------------------------------------+
| Device State                                                         |
+----------------------------------------------------------------------+

             AzureAdJoined : ${azureAd}
          EnterpriseJoined : NO
              DomainJoined : ${domain}
               Device Name : FAKE-PC
${tenantId ? `                  TenantId : ${tenantId}\n` : ""}
+----------------------------------------------------------------------+
| User State                                                           |
+----------------------------------------------------------------------+

                    NgcSet : NO
           WorkplaceJoined : ${workplace}

+----------------------------------------------------------------------+
| SSO State                                                            |
+----------------------------------------------------------------------+

                AzureAdPrt : ${prt}
${prt === "YES" ? `      AzureAdPrtUpdateTime : 2026-01-01 00:00:00.000 UTC\n       AzureAdPrtAuthority : ${authority}\n` : ""}             EnterprisePrt : NO
`;

const JOINED = parseDsregcmd(dsreg());
const NOT_JOINED = parseDsregcmd(dsreg({ azureAd: "NO", prt: "NO" }));

function tmpDir(t, prefix = "account-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function collectLog() {
  const lines = [];
  const log = (message = "") => lines.push(String(message));
  log.lines = lines;
  log.text = () => lines.join("\n");
  return log;
}

/** The text of everything a trace, a verdict, or a payload holds must not carry any private value. */
function assertNoPrivateValues(value, what) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const secret of PRIVATE_VALUES) assert.ok(!text.toLowerCase().includes(secret.toLowerCase()), `${what} must not contain ${secret.slice(0, 6)}…`);
}

// ── What this PC has ─────────────────────────────────────────────────────────

test("dsregcmd output becomes flags, and the Windows account's tenant id stays out of every printed form", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(JOINED)), { known: true, osWorkAccount: true, azureAdJoined: true, domainJoined: false, workplaceJoined: false, prt: true });
  assert.equal(JOINED.osTenantId, OS_TENANT, "kept in memory for comparison");
  assertNoPrivateValues(JOINED, "the flag set");
  assertNoPrivateValues(`${JSON.stringify({ ...JOINED })} ${Object.keys(JOINED).join(",")} ${Object.values(JOINED).join(",")}`, "spread, keys, and values");
  assert.ok(!Object.keys(JOINED).includes("osTenantId"), "not enumerable");
  assert.deepEqual(osAccountFlags(JOINED), { known: true, osWorkAccount: true, prt: true });
  assertNoPrivateValues(osAccountFlags(JOINED), "the flags that may leave this computer");

  const noPrt = parseDsregcmd(dsreg({ prt: "NO", tenantId: OS_TENANT }));
  assert.equal(noPrt.osWorkAccount, true, "joined without a token is still a work account");
  assert.equal(noPrt.prt, false);
  assert.equal(noPrt.osTenantId, OS_TENANT, "falls back to the joined tenant");

  const notJoined = parseDsregcmd(dsreg({ azureAd: "NO", prt: "NO" }));
  assert.equal(notJoined.osWorkAccount, false);
  assert.equal(notJoined.osTenantId, null);

  assert.equal(parseDsregcmd(dsreg({ azureAd: "NO", workplace: "YES", prt: "NO" })).osWorkAccount, true, "a registered work account counts");
  assert.equal(parseDsregcmd(dsreg({ azureAd: "NO", domain: "YES", prt: "NO" })).osWorkAccount, true, "a domain-joined PC counts");

  const garbage = parseDsregcmd("not dsregcmd output at all");
  assert.deepEqual(osAccountFlags(garbage), { known: false, osWorkAccount: null, prt: null });
  assert.equal(parseDsregcmd(undefined).osWorkAccount, null);
});

test("on macOS and Linux the work account is unknown, and a failing dsregcmd is unknown too", () => {
  for (const platform of ["darwin", "linux"]) {
    const result = readOsAccount({ platform, exec: () => assert.fail("dsregcmd is Windows only") });
    assert.deepEqual(osAccountFlags(result), { known: false, osWorkAccount: null, prt: null });
  }
  assert.equal(readOsAccount({ platform: "win32", exec: () => dsreg() }).osWorkAccount, true);
  assert.equal(readOsAccount({ platform: "win32", exec: () => { throw new Error("not found"); } }).osWorkAccount, null);
});

test("the organization's forced Edge sign-in policy is read as a yes or no", () => {
  const reg = (hive, value) => (_command, args) => {
    if (!String(args[1]).startsWith(hive)) throw new Error("not set");
    return `\n${args[1]}\n    BrowserSignin    REG_DWORD    ${value}\n`;
  };
  assert.deepEqual(readEdgeSignInPolicy({ platform: "win32", exec: reg("HKCU", "0x2") }), { forced: true });
  assert.deepEqual(readEdgeSignInPolicy({ platform: "win32", exec: reg("HKLM", "0x1") }), { forced: false });
  assert.deepEqual(readEdgeSignInPolicy({ platform: "win32", exec: () => { throw new Error("none"); } }), { forced: false });
  assert.equal(readEdgeSignInPolicy({ platform: "linux", exec: () => assert.fail("Windows only") }), null);
});

// ── Comparing tenants in memory ──────────────────────────────────────────────

test("tenant ids are found in an address only to be compared, and a missing id says nothing", () => {
  assert.deepEqual(tenantIdsInUrl(`https://copilotstudio.microsoft.com/environments/Default-${OS_TENANT}/home`), [OS_TENANT]);
  assert.deepEqual(tenantIdsInUrl(`https://ai.azure.com/?tid=${DEMO_TENANT}&x=1`), [DEMO_TENANT]);
  assert.deepEqual(tenantIdsInUrl(`https://portal.azure.com/tenants/${OS_TENANT}/overview`), [OS_TENANT]);
  assert.deepEqual(tenantIdsInUrl(`https://copilotstudio.microsoft.com/environments/${DEMO_ENV}/home`), [], "a plain environment id is not a tenant id");
  assert.deepEqual(tenantIdsInUrl("not an address"), []);

  assert.equal(landedInOsTenant(`https://copilotstudio.microsoft.com/environments/Default-${OS_TENANT}/home`, JOINED), true);
  assert.equal(landedInOsTenant(`https://copilotstudio.microsoft.com/environments/Default-${DEMO_TENANT}/home`, JOINED), false);
  assert.equal(landedInOsTenant("https://m365.cloud.microsoft/chat", JOINED), null);
  assert.equal(landedInOsTenant(`https://copilotstudio.microsoft.com/environments/Default-${OS_TENANT}/home`, NOT_JOINED), null);
  assert.equal(landedInOsTenant("https://x.example/", null), null);
});

test("SharePoint hosts of one tenant match (site, personal, admin), others do not", () => {
  assert.equal(sameTenantHost(FAKE_SITE_HOST, "fakecorp-demo-admin.sharepoint.com"), true);
  assert.equal(sameTenantHost(FAKE_SITE_HOST, "fakecorp-demo-my.sharepoint.com"), true);
  assert.equal(sameTenantHost(FAKE_SITE_HOST, "othertenant.sharepoint.com"), false);
  assert.equal(sameTenantHost("make.powerapps.com", "make.powerapps.com"), true);
  assert.equal(sameTenantHost("make.powerapps.com", "ai.azure.com"), false);
  assert.equal(sameTenantHost("", "x.sharepoint.com"), false);
});

// ── Was a sign-in page shown, and where did the account come from ────────────

test("a redirect that passes in a moment is single sign-on, and a page that stays is a sign-in page that was shown", () => {
  assert.equal(signInPageShown([{ at: 0, kind: "app" }, { at: 100, kind: "sign-in" }, { at: 900, kind: "app" }]), false);
  assert.equal(signInPageShown([{ at: 0, kind: "app" }, { at: 100, kind: "sign-in" }, { at: 12_000, kind: "app" }]), true);
  assert.equal(signInPageShown([{ at: 100, kind: "sign-in" }], { endAt: 9000 }), true, "still on it when time ran out");
  assert.equal(signInPageShown([{ at: 100, kind: "sign-in" }]), false, "an open visit with no end is not counted");
  assert.equal(signInPageShown([]), false);
});

test("the account source is windows-sso, manual, saved-session, or unknown, by fixed rules", () => {
  assert.equal(classifyAccountSource({ signInShown: false, inOsTenant: true, osWorkAccount: true }).source, "windows-sso");
  assert.equal(classifyAccountSource({ signInShown: true, inOsTenant: true, osWorkAccount: true }).source, "manual", "a person signed in, even with the same account");
  assert.equal(classifyAccountSource({ signInShown: true, inOsTenant: false, osWorkAccount: true }).source, "manual");
  assert.equal(classifyAccountSource({ signInShown: false, inOsTenant: false, osWorkAccount: true }).source, "saved-session");
  assert.equal(classifyAccountSource({ signInShown: false, inOsTenant: true, osWorkAccount: true, previous: "manual" }).source, "saved-session", "classified before: the person chose it");
  assert.equal(classifyAccountSource({ signInShown: false, inOsTenant: null, osWorkAccount: true }).source, "unknown");
  assert.equal(classifyAccountSource({ signInShown: false, inOsTenant: true, osWorkAccount: false }).source, "unknown", "no Windows account to come from");
  assert.equal(classifyAccountSource({ signInShown: false, inOsTenant: null, osWorkAccount: true, previous: "windows-sso" }).source, "windows-sso");
  assert.equal(classifyAccountSource({ setup: true }).source, "manual");
  assert.equal(parseAccountMode("Windows").mode, "windows");
  assert.match(parseAccountMode("both").error, /--account-mode must be separate or windows/);
  assert.match(parseAccountMode("").error, /needs a value/);
});

// ── Command line ─────────────────────────────────────────────────────────────

test("--account-mode and --setup-account are parsed, and the default is left to the machine", () => {
  assert.equal(parseArgs([]).accountMode, null);
  assert.equal(parseArgs(["--account-mode=windows"]).accountMode, "windows");
  assert.equal(parseArgs(["--account-mode", "separate"]).accountMode, "separate");
  assert.match(parseArgs(["--account-mode=sometimes"]).error, /--account-mode must be separate or windows/);
  assert.equal(parseArgs(["--setup-account"]).setupAccount, "copilot-studio");
  assert.equal(parseArgs(["--setup-account=sharepoint-ai"]).setupAccount, "sharepoint-ai");
  assert.equal(parseArgs(["--setup-account", "ai-foundry"]).setupAccount, "ai-foundry");
  assert.match(parseArgs(["--setup-account=../x"]).error, /--setup-account needs a product name/);
});

// ── Which browser, and how ───────────────────────────────────────────────────

test("the default browser order avoids the browsers that sign in with the Windows work account", () => {
  const all = { edge: true, chrome: true, chromium: true };
  // A PC with a work account, a separate sign-in wanted: a browser that does not use it first, Edge last.
  assert.deepEqual(chooseBrowsers({ requested: "auto", installed: all, accountMode: "separate", osWorkAccount: true }).kinds, ["chrome", "chromium", "edge"]);
  assert.deepEqual(chooseBrowsers({ requested: "auto", installed: { edge: true, chromium: true }, accountMode: "separate", osWorkAccount: true }).kinds, ["chromium", "edge"]);
  assert.deepEqual(chooseBrowsers({ requested: "auto", installed: { edge: true }, accountMode: "separate", osWorkAccount: true }).kinds, ["edge"], "Edge is the only one left: it is opened InPrivate");
  // The Windows account allowed on purpose, or no work account, or unknown: the original order.
  assert.deepEqual(chooseBrowsers({ requested: "auto", installed: all, accountMode: "windows", osWorkAccount: true }).kinds, ["edge", "chrome", "chromium"]);
  assert.deepEqual(chooseBrowsers({ requested: "auto", installed: all, accountMode: "separate", osWorkAccount: false }).kinds, ["edge", "chrome", "chromium"]);
  assert.deepEqual(chooseBrowsers({ requested: "auto", installed: all, accountMode: "separate", osWorkAccount: null }).kinds, ["edge", "chrome", "chromium"]);
  assert.deepEqual(autoBrowserOrder({ accountMode: "separate", osWorkAccount: true }), ["chrome", "chromium", "edge"]);
  // An explicit choice is never changed.
  assert.deepEqual(chooseBrowsers({ requested: "edge", installed: all, accountMode: "separate", osWorkAccount: true }).kinds, ["edge"]);
  assert.deepEqual(chooseBrowsers({ requested: "chromium", installed: { chromium: true }, accountMode: "separate", osWorkAccount: true }).kinds, ["chromium"]);
});

test("Edge is opened InPrivate only when a separate sign-in is wanted on a PC with a Windows work account", () => {
  assert.deepEqual(launchPolicy({ kind: "edge", accountMode: "separate", osWorkAccount: true }), { inPrivate: true });
  assert.deepEqual(launchPolicy({ kind: "edge", accountMode: "windows", osWorkAccount: true }), { inPrivate: false });
  assert.deepEqual(launchPolicy({ kind: "edge", accountMode: "separate", osWorkAccount: false }), { inPrivate: false });
  assert.deepEqual(launchPolicy({ kind: "edge", accountMode: "separate", osWorkAccount: null }), { inPrivate: false });
  assert.deepEqual(launchPolicy({ kind: "chrome", accountMode: "separate", osWorkAccount: true }), { inPrivate: false });
  const calls = [];
  const playwright = { chromium: { launchPersistentContext: (dir, options) => { calls.push(options); return {}; } } };
  launchBrowser({ playwright, kind: "edge", dir: "/p", inPrivate: true });
  launchBrowser({ playwright, kind: "edge", dir: "/p" });
  assert.deepEqual(calls[0].args, ["--inprivate"]);
  assert.equal(calls[1].args, undefined);
});

test("the attach switches add only what keeps a covered window working and the InPrivate choice, and none of the hiding switches", () => {
  const normal = attachArgs({ dir: "/p", port: 1 });
  for (const flag of ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"]) assert.ok(normal.includes(flag), flag);
  assert.ok(!normal.includes("--inprivate"));
  assert.ok(attachArgs({ dir: "/p", port: 1, inPrivate: true }).includes("--inprivate"));
  assert.equal(attachArgs({ dir: "/p", port: 1, inPrivate: true }).at(-1), "about:blank");
  for (const flag of ["--enable-automation", "--disable-blink-features", "--user-agent", "--disable-extensions"]) assert.ok(!normal.some((a) => a.startsWith(flag)), `no ${flag}`);
});

test("only the browser's own pages are closed, never a page of the web", async () => {
  const page = (url, closed = []) => ({ url: () => url, close: async () => closed.push(url) });
  const closed = [];
  const keep = page("about:blank");
  const context = { pages: () => [keep, page("edge://welcome/", closed), page("chrome://newtab/", closed), page("about:blank#extra", closed), page("https://login.microsoftonline.com/common/oauth2/authorize", closed), page("https://copilotstudio.microsoft.com/", closed)] };
  const trace = createTrace({ file: null });
  const result = await closeStrayTabs(context, keep, { trace });
  assert.equal(result.closed, 3);
  assert.deepEqual(closed, ["edge://welcome/", "chrome://newtab/", "about:blank#extra"]);
  assert.ok(trace.lines.some((l) => /stray-tabs-closed/.test(l)));
  assert.deepEqual(await closeStrayTabs({ pages: () => { throw new Error("gone"); } }, keep), { closed: 0 });
});

test("the window is made as large as the pictures, within the screen, and a browser that refuses is left alone", async () => {
  const sent = [];
  const session = { send: async (method, params) => { sent.push([method, params]); return method === "Browser.getWindowForTarget" ? { windowId: 7 } : {}; }, detach: async () => {} };
  const page = { isClosed: () => false, evaluate: async () => ({ ow: 1050, oh: 1000, iw: 1028, ih: 908, aw: 1707, ah: 1027 }) };
  const result = await fitWindow({ pages: () => [page], newCDPSession: async () => session }, { width: 1440, height: 900 });
  assert.deepEqual(result, { fitted: true, width: 1462, height: 992 });
  assert.deepEqual(sent.at(-1), ["Browser.setWindowBounds", { windowId: 7, bounds: { windowState: "normal", width: 1462, height: 992 } }]);
  const small = await fitWindow({ pages: () => [{ isClosed: () => false, evaluate: async () => ({ ow: 800, oh: 600, iw: 780, ih: 500, aw: 1280, ah: 720 }) }], newCDPSession: async () => session });
  assert.deepEqual([small.width, small.height], [1280, 720], "never larger than the screen");
  assert.deepEqual(await fitWindow({ pages: () => [page], newCDPSession: async () => { throw new Error("no"); } }), { fitted: false });
  assert.deepEqual(await fitWindow({ pages: () => [] }), { fitted: false });
});

// ── Profile folders per account mode ─────────────────────────────────────────

test("a profile signed in by the Windows account is never used as a separate profile", (t) => {
  const home = tmpDir(t);
  assert.equal(profileNamespace({ mode: "separate", osWorkAccount: true }), "separate");
  assert.equal(profileNamespace({ mode: "windows", osWorkAccount: true }), "");
  assert.equal(profileNamespace({ mode: "separate", osWorkAccount: false }), "", "nothing to avoid: earlier sign-ins keep working");
  assert.equal(profileNamespace({ mode: "separate", osWorkAccount: null }), "");
  const original = profileDir(home, "edge", "copilot-studio");
  const separate = profileDir(home, "edge", "copilot-studio", "separate");
  assert.equal(original, path.join(home, ".auth", "edge", "copilot-studio"));
  assert.equal(separate, path.join(home, ".auth", "separate", "edge", "copilot-studio"));
  assert.notEqual(original, separate);
  assert.throws(() => profileDir(home, "edge", "copilot-studio", "elsewhere"), /Unknown profile namespace/);
  assert.throws(() => profileDir(home, "firefox", "x", "separate"), /Unknown browser/);

  // A sign-in made with the Windows account (original folder) is not a sign-in of the separate profile.
  fs.mkdirSync(original, { recursive: true });
  fs.writeFileSync(path.join(original, "companion-session.json"), JSON.stringify({ version: 1, cookies: [{ name: "a", value: "b" }] }));
  fs.writeFileSync(path.join(original, "companion-signin.json"), JSON.stringify({ lastCapturedAt: "2026-01-01T00:00:00.000Z" }));
  writeAccountRecord(original, { source: "windows-sso" });
  assert.deepEqual(listSignedInProducts(home, { namespace: "separate" }), []);
  assert.deepEqual(listSignedInProducts(home, { namespace: "" }), ["copilot-studio"]);
  assert.deepEqual(listSignedInProducts(home), ["copilot-studio"], "without a namespace every layout is listed");

  fs.mkdirSync(separate, { recursive: true });
  fs.writeFileSync(path.join(separate, "companion-session.json"), JSON.stringify({ version: 1, cookies: [{ name: "a", value: "b" }] }));
  fs.writeFileSync(path.join(separate, "companion-signin.json"), JSON.stringify({ lastCapturedAt: "2026-01-02T00:00:00.000Z" }));
  writeAccountRecord(separate, { source: "manual", confirmed: true, verified: true, verifiedFor: "agent", inOsTenant: false });
  assert.deepEqual(listSignedInProducts(home, { namespace: "separate" }), ["copilot-studio"]);
  const profiles = readSignInStates(home)[0].profiles;
  assert.deepEqual(profiles.map((p) => [p.namespace, p.accountSource, p.accountConfirmed, p.accountVerified, p.accountVerifiedFor]).sort(), [["", "windows-sso", false, false, null], ["separate", "manual", true, true, "agent"]]);

  // Forgetting a sign-in covers both layouts.
  assert.deepEqual(forgetSignIn(home, ["copilot-studio"]).sort(), ["edge/copilot-studio", "separate/edge/copilot-studio"]);
  assert.deepEqual(readSignInStates(home), []);
});

test("an account record keeps flags only, and a value left out keeps what was saved", (t) => {
  const dir = tmpDir(t);
  assert.equal(readAccountRecord(dir), null);
  writeAccountRecord(dir, { source: "manual", verified: true, verifiedFor: "agent", inOsTenant: false });
  const first = readAccountRecord(dir);
  assert.deepEqual({ ...first, classifiedAt: null }, { source: "manual", confirmed: false, verified: true, verifiedFor: "agent", inOsTenant: false, classifiedAt: null });
  writeAccountRecord(dir, { source: "saved-session", confirmed: true });
  const second = readAccountRecord(dir);
  assert.equal(second.confirmed, true);
  assert.equal(second.verified, true, "kept");
  assert.equal(second.verifiedFor, "agent", "kept while verified");
  writeAccountRecord(dir, { source: "saved-session", verified: false });
  assert.equal(readAccountRecord(dir).verifiedFor, null, "no longer verified: no word either");
  const raw = fs.readFileSync(path.join(dir, "companion-account.json"), "utf8");
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ["classifiedAt", "confirmed", "inOsTenant", "source", "verified", "verifiedFor", "version"]);
  assert.deepEqual(accountPayload({ mode: "x", source: "nope", browser: "firefox", verifiedFor: "tenant" }), { mode: "separate", source: "unknown", verified: false, osWorkAccountDetected: null, browser: null, inOsTenant: null, inPrivate: false, verifiedFor: null });
});

// ── The guard ────────────────────────────────────────────────────────────────

test("the expected address of each product comes from the capture settings, and an address without a tenant says nothing", () => {
  const cs = expectedFromValues("copilot-studio", { copilotStudioAgentUrl: AGENT_URL });
  assert.equal(cs.hasAddress, true);
  assert.equal(cs.what, "agent");
  assert.equal(cs.envId, DEMO_ENV);
  assert.equal(cs.botId, BOT);
  assert.equal(expectedFromValues("copilot-studio", { copilotStudioUrl: `https://copilotstudio.microsoft.com/environments/${DEMO_ENV}/home` }).what, "environment");
  assert.equal(expectedFromValues("copilot-studio", {}).hasAddress, false);
  assert.equal(expectedFromValues("copilot-studio", { copilotStudioAgentName: "My agent" }).hasAddress, false, "a name is not an address");
  assert.equal(expectedFromValues("sharepoint-ai", { sharepointSiteUrl: `https://${FAKE_SITE_HOST}/sites/training` }).host, FAKE_SITE_HOST);
  assert.equal(expectedFromValues("sharepoint-ai", { sharepointAdminUrl: "https://x-admin.sharepoint.com" }).hasAddress, false);
  assert.equal(expectedFromValues("power-platform-ai-hub", { powerPlatformEnvUrl: `https://make.powerapps.com/environments/${DEMO_ENV}/home` }).envId, DEMO_ENV);
  assert.equal(expectedFromValues("m365-copilot-hub", { m365AdminUrl: "https://admin.cloud.microsoft" }).hasAddress, false, "a public admin center says nothing about the account");
  assert.equal(expectedFromValues("ai-foundry", { foundryProjectUrl: `https://ai.azure.com/p?tid=${DEMO_TENANT}` }).tenantIds[0], DEMO_TENANT);
});

test("landing checks: a different environment, an access-denied page, a different SharePoint host, and no address", () => {
  const agent = expectedFromValues("copilot-studio", { copilotStudioAgentUrl: AGENT_URL });
  assert.deepEqual(assessAccountLanding({ expected: agent, finalUrl: AGENT_URL, title: "Agent" }), { state: "ok", reason: "matches" });
  assert.equal(assessAccountLanding({ expected: agent, finalUrl: `https://copilotstudio.microsoft.com/environments/Default-${OS_TENANT}/home` }).state, "different", "landed in another environment");
  assert.equal(assessAccountLanding({ expected: agent, finalUrl: `https://copilotstudio.microsoft.com/environments/${DEMO_ENV}/home` }).state, "denied", "the agent never opened");
  assert.equal(assessAccountLanding({ expected: agent, finalUrl: `https://copilotstudio.microsoft.com/environments/${DEMO_ENV}/bots/${BOT}/AccessDenied` }).state, "denied");
  assert.equal(assessAccountLanding({ expected: agent, finalUrl: "https://copilotstudio.microsoft.com/error" }).reason, "error-page");
  assert.equal(assessAccountLanding({ expected: agent, finalUrl: "https://copilotstudio.microsoft.com/" }).state, "unknown", "mid-redirect says nothing");
  assert.equal(assessAccountLanding({ expected: agent, finalUrl: LOGIN }).state, "unknown", "still signing in");
  assert.equal(assessAccountLanding({ expected: agent, finalUrl: "https://elsewhere.example/" }).state, "unknown");

  const site = expectedFromValues("sharepoint-ai", { sharepointSiteUrl: `https://${FAKE_SITE_HOST}/sites/training` });
  assert.equal(assessAccountLanding({ expected: site, finalUrl: `https://${FAKE_SITE_HOST}/sites/training` }).state, "ok");
  assert.equal(assessAccountLanding({ expected: site, finalUrl: "https://othertenant.sharepoint.com/sites/training" }).reason, "site-differs");
  assert.equal(assessAccountLanding({ expected: site, finalUrl: `https://${FAKE_SITE_HOST}/_layouts/15/AccessDenied.aspx` }).state, "denied");

  const env = expectedFromValues("power-platform-ai-hub", { powerPlatformEnvUrl: `https://make.powerapps.com/environments/${DEMO_ENV}/home` });
  assert.equal(assessAccountLanding({ expected: env, finalUrl: "https://make.powerapps.com/environments/aaaaaaaa-0000-4000-8000-000000000000/home" }).state, "different");
  assert.equal(assessAccountLanding({ expected: env, finalUrl: `https://make.powerapps.com/environments/${DEMO_ENV}/home` }).state, "ok");
  const project = expectedFromValues("ai-foundry", { foundryProjectUrl: `https://ai.azure.com/p?tid=${DEMO_TENANT}` });
  assert.equal(assessAccountLanding({ expected: project, finalUrl: `https://ai.azure.com/p?tid=${OS_TENANT}` }).state, "different");
  assert.equal(assessAccountLanding({ expected: project, finalUrl: `https://ai.azure.com/p?tid=${DEMO_TENANT}`, title: "" }).reason, "no-title", "an empty page title is a weak sign");

  assert.deepEqual(assessAccountLanding({ expected: expectedFromValues("copilot-studio", {}), finalUrl: APP }), { state: "no-address", reason: "no-address" });
});

test("the decisions: stop for the Windows account, stop for a different account, wait for automatic capture, otherwise go on", () => {
  const agent = expectedFromValues("copilot-studio", { copilotStudioAgentUrl: AGENT_URL });
  const ok = { state: "ok", reason: "matches" };
  const different = { state: "different", reason: "environment-differs" };

  const sso = decideAccount({ mode: "separate", source: "windows-sso", expected: agent, landing: different, browser: "edge" });
  assert.equal(sso.action, "stop");
  assert.equal(sso.code, "windows-account");
  assert.equal(sso.message, "Edge signed in automatically with your Windows work account, not the account that owns this agent. Restart with --browser=chromium, or run --setup-account.");
  const ssoNoAddress = decideAccount({ mode: "separate", source: "windows-sso", expected: expectedFromValues("copilot-studio", {}), landing: { state: "no-address" }, browser: "edge" });
  assert.equal(ssoNoAddress.code, "windows-account", "never silently the Windows account unless the person chose it");
  assert.match(ssoNoAddress.message, /not a separate account/);

  // The Windows account allowed on purpose: fine while it fits the person's own address, a stop when it does not.
  const chosen = decideAccount({ mode: "windows", explicitMode: true, source: "windows-sso", expected: agent, landing: ok, browser: "edge" });
  assert.deepEqual([chosen.action, chosen.verified], ["proceed", true]);
  assert.equal(decideAccount({ mode: "windows", explicitMode: true, source: "windows-sso", expected: agent, landing: different, browser: "edge" }).code, "windows-account");
  assert.equal(decideAccount({ mode: "windows", explicitMode: true, source: "windows-sso", expected: expectedFromValues("copilot-studio", {}), landing: { state: "no-address" }, browser: "edge" }).verified, true, "chosen on purpose counts as confirmed");
  assert.equal(decideAccount({ mode: "windows", explicitMode: false, source: "windows-sso", expected: expectedFromValues("copilot-studio", {}), landing: { state: "no-address" }, browser: "edge" }).verified, false, "the default is not a choice");

  const wrong = decideAccount({ mode: "separate", source: "manual", expected: agent, landing: different, browser: "chromium" });
  assert.deepEqual([wrong.action, wrong.code], ["stop", "wrong-account"]);
  assert.match(wrong.message, /signed in to a different account than the one that owns that agent/);
  assert.equal(decideAccount({ mode: "separate", source: "saved-session", expected: agent, landing: { state: "denied", reason: "agent-not-reached" } }).code, "wrong-account");

  const noAddress = { state: "no-address" };
  const unverified = decideAccount({ mode: "separate", source: "manual", expected: expectedFromValues("copilot-studio", {}), landing: noAddress, autonomous: true });
  assert.deepEqual([unverified.action, unverified.code], ["stop", "unverified"]);
  assert.match(unverified.message, /--setup-account/);
  const notAutonomous = decideAccount({ mode: "separate", source: "manual", expected: expectedFromValues("copilot-studio", {}), landing: noAddress, autonomous: false });
  assert.deepEqual([notAutonomous.action, notAutonomous.verified], ["proceed", false], "an ordinary capture may run; the readiness strip says the account is not verified");
  assert.equal(decideAccount({ mode: "separate", source: "manual", expected: expectedFromValues("copilot-studio", {}), landing: noAddress, autonomous: true, confirmed: true }).action, "proceed", "confirmed once by the person");
  assert.deepEqual(decideAccount({ mode: "separate", source: "manual", expected: agent, landing: ok, autonomous: true }), { action: "proceed", code: null, message: "", verified: true }, "verified by the person's own address");
  assertNoPrivateValues([sso, wrong, unverified], "a verdict");
});

// ── Checking one product, with a scripted browser ────────────────────────────

/** A browser page whose address follows a script of [fromTick, address]; the companion's waits move the clock. */
function scriptedPage(script, { title = "Copilot Studio" } = {}) {
  const state = { tick: 0, goto: [], interactions: [] };
  const urlAt = (tick) => [...script].reverse().find(([from]) => tick >= from)?.[1] ?? "about:blank";
  const forbidden = (name) => async () => {
    state.interactions.push(name);
  };
  const page = {
    url: () => urlAt(state.tick),
    async goto(url) {
      state.goto.push(url);
    },
    async title() {
      return title;
    },
    on() {},
    isClosed: () => false,
    click: forbidden("click"),
    fill: forbidden("fill"),
    type: forbidden("type"),
    press: forbidden("press"),
    reload: forbidden("reload"),
    goBack: forbidden("goBack"),
    getByRole: () => ({ click: forbidden("role-click"), count: async () => 0 }),
    getByText: () => ({ click: forbidden("text-click"), count: async () => 0 }),
    locator: () => ({ click: forbidden("locator-click"), count: async () => 0 }),
  };
  return { state, page, sleep: async () => { state.tick += 1; } };
}

const gateFor = (sleep, trace = null) => createAuthGate({ product: "copilot-studio", waitMs: 600_000, pollMs: 10, settleMs: 30, graceMs: 20, confirmMs: 0, firstLoadMs: 0, sleep, trace });
const SEPARATE = { mode: "separate", explicitMode: false, os: JOINED, kind: "chromium", inPrivate: false };
const OS_HOME = `${APP}environments/Default-${OS_TENANT}/home`;
const DEMO_HOME = `${APP}environments/Default-${DEMO_TENANT}/home`;

test("a sign-in page the person used is manual; a silent trip into the Windows tenant is windows-sso, and it stops a separate sign-in", async (t) => {
  const dir = tmpDir(t);
  const trace = createTrace({ file: null });
  // Manual: the sign-in page stays for a long time, then the page lands in the demo tenant.
  const manual = scriptedPage([[0, APP], [2, LOGIN], [500, DEMO_HOME]]);
  const a = await verifyProductAccount({ page: manual.page, gate: gateFor(manual.sleep, trace), product: "copilot-studio", values: {}, startUrl: APP, ctx: SEPARATE, dir, trace, sleep: manual.sleep });
  assert.equal(a.source, "manual");
  assert.equal(a.account.inOsTenant, false);
  assert.equal(a.decision.action, "proceed");
  assert.equal(a.decision.verified, false, "no address of the person's was set");
  assert.equal(readAccountRecord(dir).source, "manual");
  assert.deepEqual(manual.state.interactions, [], "nothing was clicked, typed, or reloaded");

  // Silent: a quick trip to the sign-in host, landing in the Windows account's tenant.
  const sso = scriptedPage([[0, APP], [2, LOGIN], [5, OS_HOME]]);
  const ssoDir = tmpDir(t);
  const b = await verifyProductAccount({ page: sso.page, gate: gateFor(sso.sleep, trace), product: "copilot-studio", values: {}, startUrl: APP, ctx: { ...SEPARATE, kind: "edge" }, dir: ssoDir, trace, sleep: sso.sleep });
  assert.equal(b.source, "windows-sso");
  assert.equal(b.account.inOsTenant, true);
  assert.equal(b.decision.code, "windows-account");
  assert.equal(b.ok, false);
  assert.match(b.decision.message, /^Edge signed in automatically with your Windows work account/);

  // The same silent trip is fine when the person chose the Windows account on purpose.
  const sso2 = scriptedPage([[0, APP], [2, LOGIN], [5, OS_HOME]]);
  const c = await verifyProductAccount({ page: sso2.page, gate: gateFor(sso2.sleep), product: "copilot-studio", values: {}, startUrl: APP, ctx: { ...SEPARATE, mode: "windows", explicitMode: true, kind: "edge" }, dir: tmpDir(t), sleep: sso2.sleep });
  assert.equal(c.source, "windows-sso");
  assert.equal(c.ok, true);
  assert.equal(c.account.verified, true);
  assert.equal(c.account.mode, "windows");

  assertNoPrivateValues(trace.lines.join("\n"), "the trace");
  assertNoPrivateValues([a.account, a.decision, b.account, b.decision, c.account], "the payloads and verdicts");
});

test("a saved sign-in that restores without a sign-in page is saved-session, in another tenant than Windows or after the person chose it", async (t) => {
  const dir = tmpDir(t);
  writeAccountRecord(dir, { source: "manual" });
  // Landing in the Windows tenant, but the profile was chosen by the person before: still theirs.
  const s1 = scriptedPage([[0, OS_HOME]]);
  const first = await verifyProductAccount({ page: s1.page, gate: gateFor(s1.sleep), product: "copilot-studio", values: {}, startUrl: APP, ctx: SEPARATE, dir, sleep: s1.sleep });
  assert.equal(first.source, "saved-session");
  assert.equal(first.account.inOsTenant, true, "still flagged: it is the account Windows uses for work");
  assert.equal(first.ok, true);

  const s2 = scriptedPage([[0, DEMO_HOME]]);
  const second = await verifyProductAccount({ page: s2.page, gate: gateFor(s2.sleep), product: "copilot-studio", values: {}, startUrl: APP, ctx: SEPARATE, dir: tmpDir(t), sleep: s2.sleep });
  assert.equal(second.source, "saved-session");
  assert.equal(second.account.inOsTenant, false);

  const s3 = scriptedPage([[0, "https://m365.cloud.microsoft/chat"]]);
  const third = await verifyProductAccount({ page: s3.page, gate: gateFor(s3.sleep), product: "m365-copilot-agent-builder", values: {}, startUrl: "https://m365.cloud.microsoft/chat", ctx: SEPARATE, dir: tmpDir(t), sleep: s3.sleep });
  assert.equal(third.source, "unknown", "no tenant in the address: it cannot be told");
});

test("the person's own agent address verifies the account, and a different environment stops the capture before any picture", async (t) => {
  const trace = createTrace({ file: null });
  const dir = tmpDir(t);
  const good = scriptedPage([[0, APP], [2, LOGIN], [500, AGENT_URL]]);
  const verified = await verifyProductAccount({ page: good.page, gate: gateFor(good.sleep, trace), product: "copilot-studio", values: { copilotStudioAgentUrl: AGENT_URL }, startUrl: APP, ctx: SEPARATE, dir, autonomous: true, trace, sleep: good.sleep });
  assert.equal(verified.ok, true);
  assert.deepEqual([verified.account.verified, verified.account.verifiedFor], [true, "agent"]);
  assert.deepEqual(good.state.goto, [AGENT_URL], "it opened the person's own agent");
  assert.deepEqual(readAccountRecord(dir), { ...readAccountRecord(dir), source: "manual", verified: true, verifiedFor: "agent" });

  const bad = scriptedPage([[0, APP], [2, LOGIN], [500, DEMO_HOME]]);
  const stopped = await verifyProductAccount({ page: bad.page, gate: gateFor(bad.sleep, trace), product: "copilot-studio", values: { copilotStudioAgentUrl: AGENT_URL }, startUrl: APP, ctx: SEPARATE, dir: tmpDir(t), trace, sleep: bad.sleep });
  assert.equal(stopped.ok, false);
  assert.equal(stopped.decision.code, "wrong-account");
  assert.equal(stopped.landing.state, "different");

  const noAddress = scriptedPage([[0, APP], [2, LOGIN], [500, DEMO_HOME]]);
  const waiting = await verifyProductAccount({ page: noAddress.page, gate: gateFor(noAddress.sleep, trace), product: "copilot-studio", values: {}, startUrl: APP, ctx: SEPARATE, dir: tmpDir(t), autonomous: true, trace, sleep: noAddress.sleep });
  assert.equal(waiting.decision.code, "unverified");
  assert.equal(waiting.account.verified, false);

  assertNoPrivateValues(trace.lines.join("\n"), "the trace");
  assertNoPrivateValues([verified.account, stopped.account, stopped.decision, stopped.landing, waiting.decision], "the payloads and verdicts");
  const events = trace.lines.map((l) => JSON.parse(l)).filter((e) => e.event === "account-check");
  assert.equal(events.length, 3);
  for (const event of events) assert.deepEqual(Object.keys(event).filter((k) => typeof event[k] === "string" && /[0-9a-f]{8}-/.test(event[k])), []);
});

test("a sign-in that does not finish is left to the sign-in handling, with no account decision", async (t) => {
  const stuck = scriptedPage([[0, LOGIN]]);
  const gate = createAuthGate({ product: "copilot-studio", waitMs: 200, pollMs: 10, settleMs: 30, graceMs: 20, confirmMs: 0, firstLoadMs: 0, sleep: stuck.sleep });
  const result = await verifyProductAccount({ page: stuck.page, gate, product: "copilot-studio", values: {}, startUrl: APP, ctx: SEPARATE, dir: tmpDir(t), sleep: stuck.sleep });
  assert.equal(result.ok, false);
  assert.ok(result.signIn, "the sign-in result is handed back");
  assert.equal(result.decision, null);
});

test("what a computer reports without a job comes from its profiles, worst case first", (t) => {
  const home = tmpDir(t);
  const none = describeAccountState({ home, namespace: "separate", mode: "separate", osWorkAccount: true, browser: "chromium" });
  assert.deepEqual(none, { mode: "separate", source: "unknown", verified: false, osWorkAccountDetected: true, browser: "chromium", inOsTenant: null, inPrivate: false, verifiedFor: null });
  const a = profileDir(home, "chromium", "copilot-studio", "separate");
  const b = profileDir(home, "chromium", "sharepoint-ai", "separate");
  writeAccountRecord(a, { source: "manual", confirmed: true, verified: true, verifiedFor: "agent", inOsTenant: false });
  writeAccountRecord(b, { source: "windows-sso", inOsTenant: true });
  const mixed = describeAccountState({ home, namespace: "separate", mode: "separate", osWorkAccount: true, browser: "chromium" });
  assert.equal(mixed.source, "windows-sso", "one profile signed in by the Windows account makes the whole report say so");
  assert.equal(mixed.verified, false);
  assert.equal(mixed.inOsTenant, true);
  assert.equal(describeAccountState({ home, namespace: "separate", mode: "separate", osWorkAccount: true, browser: "edge" }).source, "unknown", "another browser has its own profiles");
  fs.rmSync(b, { recursive: true, force: true });
  const good = describeAccountState({ home, namespace: "separate", mode: "separate", osWorkAccount: true, browser: "chromium" });
  assert.deepEqual([good.source, good.verified, good.verifiedFor, good.inOsTenant], ["manual", true, "agent", false]);
  assert.match(describeAccount(good), /^a separate sign-in in Chromium, verified for your agent\.$/);
  assert.match(describeAccount({ ...good, inOsTenant: true }), /same account Windows uses for work/);
  assert.match(describeAccount({ source: "windows-sso", browser: "edge" }), /^your Windows work account \(single sign-on in Microsoft Edge\)\. Screenshots come from that account\.$/);
  assert.match(describeAccount({ source: "manual", mode: "separate", browser: "edge", inPrivate: true, verified: false }), /Microsoft Edge InPrivate, not verified yet/);
});

// ── Account setup: the person signs in, the computer only watches ────────────

test("account setup opens the profile, waits through a fake account picker without clicking it, then saves the account the person chose", async (t) => {
  const home = tmpDir(t);
  const dir = profileDir(home, "chromium", "copilot-studio", "separate");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "old-marker.txt"), "an earlier sign-in");
  let tick = 0;
  const picker = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?prompt=select_account";
  const fake = createFakePlaywright({
    rewriteUrl: (u) => (tick < 400 ? picker : /^https:\/\/copilotstudio\.microsoft\.com/.test(u) ? DEMO_HOME : u),
    controlDetails: {},
    labels: ["Use another account", FAKE_UPN, "Sign in"],
  });
  const states = [];
  const sleepFn = async () => {
    tick += 1;
    if (tick === 300) fake.signIn({ persistent: true });
  };
  const log = collectLog();
  const trace = createTrace({ file: null });
  const outcome = await runSetupAccount({ home, product: "copilot-studio", playwright: fake.playwright, kinds: ["chromium"], account: { mode: "separate", explicitMode: false, os: JOINED }, open: openProfile, values: {}, log, sleepFn, trace, onState: (s) => states.push(s.state), deps: { gate: { waitMs: 600_000, pollMs: 10, settleMs: 30, graceMs: 20, confirmMs: 0, firstLoadMs: 0 }, surface: false } });
  assert.equal(outcome.ok, true);
  assert.deepEqual(states, ["waiting-for-you", "done"]);
  assert.deepEqual(fake.log.clicks, [], "the companion never picked an account or clicked anything");
  assert.deepEqual(fake.log.goto, [APP], "it opened the product start page once");
  assert.ok(!fs.existsSync(path.join(dir, "old-marker.txt")), "it started from a clean sign-in so the person could choose");
  const record = readAccountRecord(dir);
  assert.deepEqual([record.source, record.confirmed, record.inOsTenant], ["manual", true, false]);
  assert.ok(fs.existsSync(path.join(dir, "companion-session.json")), "the session is saved");
  assert.equal(fake.log.launched[0].dir, dir, "the separate folder");
  assert.equal(fake.log.closed, 1, "the browser is closed at the end");
  assert.match(log.text(), /Sign in with the account you want your screenshots to come from, for example your demo tenant/);
  assert.match(log.text(), /choose “Use another account” and sign in\. You do this yourself/);
  assert.match(log.text(), /Account chosen: a separate sign-in in Chromium, confirmed by you\./);
  assertNoPrivateValues(log.text(), "the console");
  assertNoPrivateValues(trace.lines.join("\n"), "the trace");
});

test("account setup stops when the Windows account signed in by itself, and when the account does not fit the person's address", async (t) => {
  const home = tmpDir(t);
  const sso = createFakePlaywright({ rewriteUrl: (u) => (/copilotstudio/.test(u) ? OS_HOME : u) });
  const states = [];
  const gate = { waitMs: 600_000, pollMs: 10, settleMs: 30, graceMs: 20, confirmMs: 0, firstLoadMs: 0 };
  const stoppedBySso = await runSetupAccount({ home, product: "copilot-studio", playwright: sso.playwright, kinds: ["edge"], account: { mode: "separate", explicitMode: false, os: JOINED }, open: openProfile, values: {}, log: () => {}, sleepFn: async () => {}, onState: (s) => states.push(s.state), deps: { gate, surface: false } });
  assert.equal(stoppedBySso.ok, false);
  assert.equal(stoppedBySso.decision.code, "windows-account");
  assert.deepEqual(states, ["waiting-for-you", "needs-account"]);
  assert.equal(readAccountRecord(profileDir(home, "edge", "copilot-studio", "separate"))?.confirmed, false, "not confirmed");
  assert.ok(!fs.existsSync(path.join(profileDir(home, "edge", "copilot-studio", "separate"), "companion-session.json")), "nothing is saved for a refused account");

  const other = createFakePlaywright({ rewriteUrl: (u) => (/copilotstudio/.test(u) ? DEMO_HOME : u) });
  const second = await runSetupAccount({ home: tmpDir(t), product: "copilot-studio", playwright: other.playwright, kinds: ["chromium"], account: { mode: "separate", explicitMode: false, os: JOINED }, open: openProfile, values: { copilotStudioAgentUrl: AGENT_URL }, log: () => {}, sleepFn: async () => {}, deps: { gate, surface: false } });
  assert.equal(second.decision.code, "wrong-account");
});

test("account setup says so when another companion window uses the profile, and when the browser closes early", async (t) => {
  const home = tmpDir(t);
  const fake = createFakePlaywright();
  const states = [];
  const inUse = await runSetupAccount({ home, product: "copilot-studio", playwright: fake.playwright, kinds: ["chromium"], account: { mode: "separate", os: JOINED }, open: openProfile, log: () => {}, onState: (s) => states.push(s), deps: { clear: () => { throw Object.assign(new Error("Another companion window is already using this sign-in profile."), { code: "PROFILE_IN_USE" }); }, surface: false } });
  assert.equal(inUse.ok, false);
  assert.equal(states[0].state, "failed");
  assert.equal(fake.log.launched.length, 0, "no browser was opened");

  const closed = createFakePlaywright({ rewriteUrl: () => LOGIN });
  closed.page.isClosed = () => true;
  const early = await runSetupAccount({ home, product: "copilot-studio", playwright: closed.playwright, kinds: ["chromium"], account: { mode: "separate", os: JOINED }, open: openProfile, log: () => {}, sleepFn: async () => {}, deps: { gate: { waitMs: 600_000, pollMs: 10, firstLoadMs: 0, settleMs: 30, graceMs: 20, confirmMs: 0 }, surface: false } });
  assert.equal(early.ok, false);
  assert.match(early.message, /browser window was closed/);
  assert.match(setupInstructions({ label: "Copilot Studio", kind: "edge", inPrivate: true }).join(" "), /InPrivate/);
});

// ── The job: profile folders, reports, and what the portal is told ───────────

const claimedJob = (shots, { env = {}, options = {} } = {}) => ({
  job: { id: "job_0123456789abcdef", target: { type: "lab", labId: "lab-a" }, scope: {}, options: { callouts: "none", redact: true, ...options }, createdAt: new Date().toISOString(), resumed: false },
  env,
  shots,
});
const legacyShot = (filename, extra = {}) => ({ filename, shotId: filename, featureId: "f", moduleTitle: "M", product: "copilot-studio", authProfile: "copilot-studio", startUrl: APP, viewport: { width: 1440, height: 900 }, manual: false, requiresEnv: null, expectedLabels: ["Settings"], callouts: [], steps: [{ action: "navigate", url: APP }, { action: "screenshot" }], ...extra });

function recordingClient({ rejectNeedsAccount = false } = {}) {
  const calls = { statuses: [], completes: [], uploads: [], heartbeats: [] };
  return {
    calls,
    async heartbeat(body) {
      calls.heartbeats.push(body);
      return {};
    },
    async progress(_id, body) {
      if (body.shot) {
        if (rejectNeedsAccount && body.shot.status === "needs-account") throw new PortalError("client", "Unknown status.", { status: 400 });
        calls.statuses.push({ file: body.shot.filename, status: body.shot.status, message: body.shot.message, error: body.shot.error, cause: body.shot.cause });
      }
      return { ok: true };
    },
    async upload(_id, filename) {
      calls.uploads.push(filename);
      return { status: 200, body: { outcome: "accepted" } };
    },
    async complete(_id, body) {
      calls.completes.push(body);
      return {};
    },
  };
}

const fastGate = { authSettleMs: 0, authPollMs: 5, authGraceMs: 0, authConfirmMs: 0, authFirstLoadMs: 0 };

test("a separate sign-in uses its own folder on a PC with a Windows work account, and Edge is opened InPrivate", async (t) => {
  const home = tmpDir(t);
  // A sign-in made earlier with the Windows account (original folder) must not come back as a separate one.
  const original = profileDir(home, "chromium", "copilot-studio");
  fs.mkdirSync(original, { recursive: true });
  fs.writeFileSync(path.join(original, "companion-session.json"), JSON.stringify({ version: 1, cookies: [{ name: "ESTSAUTH", value: "x", domain: "login.microsoftonline.com", path: "/", expires: -1 }] }));
  const fake = createFakePlaywright({ rewriteUrl: (u) => (/copilotstudio/.test(u) ? DEMO_HOME : u) });
  const log = collectLog();
  const client = recordingClient();
  await runJob({ client, claimed: claimedJob([legacyShot("a.png")]), home, playwright: fake.playwright, options: { ...fastGate, browserKinds: ["chromium"], account: { mode: "separate", explicitMode: false, os: JOINED } }, log, sleepFn: async () => {}, heartbeatMs: 60_000 });
  assert.equal(fake.log.launched[0].dir, profileDir(home, "chromium", "copilot-studio", "separate"));
  assert.equal(fake.live.context.added.length, 0, "the Windows account's saved session was not restored");
  assert.match(log.text(), /Account: a separate sign-in in Chromium, not verified yet\./);

  // Edge: InPrivate.
  const edge = createFakePlaywright({ rewriteUrl: (u) => (/copilotstudio/.test(u) ? DEMO_HOME : u) });
  await runJob({ client: recordingClient(), claimed: claimedJob([legacyShot("a.png")]), home: tmpDir(t), playwright: edge.playwright, options: { ...fastGate, browserKinds: ["edge"], account: { mode: "separate", explicitMode: false, os: JOINED } }, log: () => {}, sleepFn: async () => {}, heartbeatMs: 60_000 });
  assert.deepEqual(edge.log.launched[0].options.args, ["--inprivate"]);

  // The Windows account allowed on purpose: the original folder and a normal Edge window.
  const windows = createFakePlaywright({ rewriteUrl: (u) => (/copilotstudio/.test(u) ? DEMO_HOME : u) });
  const winHome = tmpDir(t);
  await runJob({ client: recordingClient(), claimed: claimedJob([legacyShot("a.png")]), home: winHome, playwright: windows.playwright, options: { ...fastGate, browserKinds: ["edge"], account: { mode: "windows", explicitMode: true, os: JOINED } }, log: () => {}, sleepFn: async () => {}, heartbeatMs: 60_000 });
  assert.equal(windows.log.launched[0].dir, profileDir(winHome, "edge", "copilot-studio"));
  assert.equal(windows.log.launched[0].options.args, undefined);
});

test("the Windows account signing in by itself stops every shot of the product before any picture, and the portal is told why", async (t) => {
  const home = tmpDir(t);
  const fake = createFakePlaywright({ rewriteUrl: (u) => (/copilotstudio/.test(u) ? OS_HOME : u) });
  const client = recordingClient();
  const log = collectLog();
  const result = await runJob({ client, claimed: claimedJob([legacyShot("a.png"), legacyShot("b.png"), legacyShot("m.png", { manual: true })]), home, playwright: fake.playwright, options: { ...fastGate, browserKinds: ["edge"], account: { mode: "separate", explicitMode: false, os: JOINED } }, log, sleepFn: async () => {}, heartbeatMs: 60_000 });
  assert.equal(fake.log.screenshots, 0, "no picture was taken");
  assert.equal(result.tally.captured, 0);
  assert.equal(result.tally.failed, 2);
  assert.deepEqual(client.calls.statuses.filter((s) => s.status === "needs-account").map((s) => s.file), ["a.png", "b.png"]);
  assert.equal(client.calls.statuses.find((s) => s.file === "m.png").status, "manual-required", "a screen outside the browser is unaffected");
  assert.match(client.calls.statuses.find((s) => s.file === "a.png").message, /^Edge signed in automatically with your Windows work account/);
  assert.equal(client.calls.statuses.find((s) => s.file === "a.png").cause, "needs-account");
  const done = client.calls.completes[0];
  assert.equal(done.needsAccount.code, "windows-account");
  assert.equal(done.needsAccount.product, "copilot-studio");
  assert.equal(done.account.source, "windows-sso");
  assert.equal(done.account.mode, "separate");
  assert.equal(done.account.browser, "edge");
  assert.equal(done.account.inPrivate, true);
  assert.match(done.message, /Restart with --browser=chromium, or run --setup-account/);
  assert.match(log.text(), /Not run: the account is not the right one/);
  assertNoPrivateValues(done, "the completion report");
  assertNoPrivateValues(client.calls.statuses, "the shot reports");
  assertNoPrivateValues(log.text(), "the console");
});

test("an address that leads to a different environment is a wrong-account stop, and an older portal still gets the sentence", async (t) => {
  const fake = createFakePlaywright({ rewriteUrl: (u) => (/copilotstudio/.test(u) ? DEMO_HOME : u) });
  const client = recordingClient({ rejectNeedsAccount: true });
  const result = await runJob({ client, claimed: claimedJob([legacyShot("a.png")], { env: { CAPTURE_COPILOT_STUDIO_AGENT_URL: AGENT_URL } }), home: tmpDir(t), playwright: fake.playwright, options: { ...fastGate, browserKinds: ["chromium"], account: { mode: "separate", explicitMode: false, os: JOINED } }, log: () => {}, sleepFn: async () => {}, heartbeatMs: 60_000 });
  assert.equal(fake.log.screenshots, 0);
  assert.equal(result.tally.failed, 1);
  const row = client.calls.statuses.find((s) => s.file === "a.png" && s.status === "failed");
  assert.ok(row, "a portal that does not know needs-account gets a failed shot with the same sentence");
  assert.match(row.error, /signed in to a different account than the one that owns that agent/);
  assert.equal(client.calls.completes[0].needsAccount.code, "wrong-account");
});

test("automatic capture waits for the account, and an ordinary capture runs with the account reported as not verified", async (t) => {
  const autoShot = (filename) => ({ ...legacyShot(filename), capture: { version: 1, mode: "auto", product: "copilot-studio", route: { kind: "copilot-studio", screen: "home" }, screen: { id: "home", label: "the home page" }, path: ["Copilot Studio"], expect: { family: "copilot-studio", scope: "environment", paths: ["home"], label: "home" }, landmarks: [], reveal: [], needs: [] } });
  const fake = createFakePlaywright({ rewriteUrl: (u) => (/copilotstudio/.test(u) ? DEMO_HOME : u) });
  const client = recordingClient();
  const log = collectLog();
  const home = tmpDir(t);
  const result = await runJob({ client, claimed: claimedJob([autoShot("a.png")], { options: { mode: "autonomous", autonomy: { level: "read-only" } } }), home, playwright: fake.playwright, options: { ...fastGate, browserKinds: ["chromium"], account: { mode: "separate", explicitMode: false, os: JOINED } }, log, sleepFn: async () => {}, heartbeatMs: 60_000 });
  assert.equal(fake.log.screenshots, 0, "automatic capture did not start");
  assert.equal(result.tally.failed, 1);
  assert.equal(client.calls.completes[0].needsAccount.code, "unverified");
  assert.match(client.calls.statuses[0].message ?? client.calls.statuses.find((s) => s.status === "needs-account")?.message ?? "", /Run --setup-account once/);

  const ordinary = createFakePlaywright({ rewriteUrl: (u) => (/copilotstudio/.test(u) ? DEMO_HOME : u) });
  const client2 = recordingClient();
  const second = await runJob({ client: client2, claimed: claimedJob([legacyShot("b.png")]), home: tmpDir(t), playwright: ordinary.playwright, options: { ...fastGate, browserKinds: ["chromium"], account: { mode: "separate", explicitMode: false, os: JOINED } }, log: () => {}, sleepFn: async () => {}, heartbeatMs: 60_000 });
  assert.equal(second.tally.captured, 1);
  assert.equal(client2.calls.completes[0].account.verified, false);
  assert.equal(client2.calls.completes[0].needsAccount, undefined);
});

test("a job without account options (an older caller) runs exactly as before", async (t) => {
  const home = tmpDir(t);
  const fake = createFakePlaywright();
  const client = recordingClient();
  const result = await runJob({ client, claimed: claimedJob([legacyShot("a.png")]), home, playwright: fake.playwright, options: { ...fastGate, browserKinds: ["chromium"] }, log: () => {}, sleepFn: async () => {}, heartbeatMs: 60_000 });
  assert.equal(result.tally.captured, 1);
  assert.equal(fake.log.launched[0].dir, profileDir(home, "chromium", "copilot-studio"));
  assert.equal(client.calls.completes[0].account, undefined, "no account fields without account options");
});

// ── What the portal is told ──────────────────────────────────────────────────

test("a heartbeat carries the account flags and nothing else about it, and a wake header is noticed once", async () => {
  const sent = [];
  let wake = false;
  const fetchImpl = async (url, init) => {
    if (init.method === "POST") sent.push(JSON.parse(init.body));
    const headers = new Headers(wake ? { "x-companion-wake": "1" } : {});
    if (String(url).endsWith("/next")) return { status: 204, ok: true, headers, json: async () => null };
    return { status: 200, ok: true, headers, json: async () => ({ ok: true, commands: [{ id: "cmd_a", type: "setup-account", product: "copilot-studio" }] }) };
  };
  const client = createPortalClient({ portal: "http://localhost:3019", token: "cap_FAKE", fetchImpl });
  const account = accountPayload({ mode: "separate", source: "manual", verified: true, osWorkAccountDetected: true, browser: "chromium", inOsTenant: false, verifiedFor: "agent" });
  const reply = await client.heartbeat({ busy: false, signedInProducts: [], account });
  assert.deepEqual(sent[0].account, account);
  assert.deepEqual(Object.keys(sent[0].account).sort(), ["browser", "inOsTenant", "inPrivate", "mode", "osWorkAccountDetected", "source", "verified", "verifiedFor"]);
  assert.equal(reply.commands[0].type, "setup-account");
  assert.equal(await client.next(), null);
  assert.equal(client.takeWake(), false);
  wake = true;
  await client.next();
  assert.equal(client.takeWake(), true);
  assert.equal(client.takeWake(), false, "reading it clears it");
  assert.deepEqual(commandValues({ env: { CAPTURE_COPILOT_STUDIO_AGENT_URL: AGENT_URL, NOT_CAPTURE: "https://x.example/" }, targets: { copilotStudioAgentName: "My agent" } }), { copilotStudioAgentUrl: AGENT_URL, copilotStudioAgentName: "My agent" });
});

test("the start of a run says plainly which account is used and what each choice does", () => {
  const text = (extra) => accountStartLines(extra).join("\n");
  assert.match(text({ mode: "separate", os: JOINED, kind: "chromium" }), /Account: a separate sign-in\. This PC has a Windows work account, and Chromium does not use it\. You sign in once, yourself/);
  assert.match(text({ mode: "separate", os: JOINED, kind: "chromium" }), /--setup-account.*--account-mode=windows/s);
  assert.match(text({ mode: "separate", os: JOINED, kind: "edge", edgeForced: true, requestedBrowser: "auto" }), /opened InPrivate.*your organization makes Edge sign in with it.*does not use it/s);
  assert.match(text({ mode: "separate", os: JOINED, kind: "edge", requestedBrowser: "auto" }), /Chromium is the most reliable/);
  assert.doesNotMatch(text({ mode: "separate", os: JOINED, kind: "edge", requestedBrowser: "edge" }), /Chromium is the most reliable/);
  assert.match(text({ mode: "windows", explicitMode: true, os: JOINED, kind: "edge" }), /your Windows work account is allowed.*Microsoft Edge may sign in with it automatically.*not from a separate demo tenant/s);
  assert.match(text({ mode: "windows", explicitMode: true, os: JOINED, kind: "chromium" }), /Chromium does not use it automatically/);
  assert.match(text({ mode: "windows", explicitMode: true, os: NOT_JOINED, kind: "edge" }), /no Windows work account that a browser could use, so nothing changes/);
  assert.match(text({ mode: "separate", os: NOT_JOINED, kind: "edge" }), /you sign in once, yourself, in the browser window/);
});

test("--check and --setup-account use the PC's work account, and --check says which account will be used", async (t) => {
  const home = tmpDir(t);
  const log = collectLog();
  const base = { nonInteractive: true, noSignals: true, resolveHome: () => ({ home, synced: { synced: false }, source: "test" }), osAccount: JOINED, edgePolicy: () => ({ forced: true }) };
  const seen = [];
  const preflight = async (args) => {
    seen.push(args);
    return { ok: true, kinds: chooseBrowsers({ requested: args.browser, installed: { edge: true, chrome: false, chromium: true }, accountMode: args.accountMode, osWorkAccount: args.osWorkAccount }).kinds };
  };
  const code = await runCompanion(["--check"], { ...base, log, preflight });
  assert.equal(code, 0);
  assert.deepEqual([seen[0].accountMode, seen[0].osWorkAccount], ["separate", true]);
  assert.match(log.text(), /Browser: Chromium \(installed with Playwright\), or Microsoft Edge if that will not start\./);
  assert.match(log.text(), /Account: a separate sign-in\. This PC has a Windows work account, and Chromium does not use it/);

  const log2 = collectLog();
  await runCompanion(["--check", "--account-mode=windows"], { ...base, log: log2, preflight });
  assert.match(log2.text(), /Browser: Microsoft Edge, or Chromium/);
  assert.match(log2.text(), /your Windows work account is allowed \(--account-mode=windows\)/);

  const received = [];
  const log3 = collectLog();
  const exit = await runCompanion(["--setup-account=sharepoint-ai"], { ...base, log: log3, preflight, playwright: {}, setupAccount: async (args) => { received.push(args); return { ok: true }; } });
  assert.equal(exit, 0);
  assert.equal(received[0].product, "sharepoint-ai");
  assert.deepEqual(received[0].kinds, ["chromium", "edge"]);
  assert.equal(received[0].account.mode, "separate");
  assert.equal(received[0].account.os.osWorkAccount, true);
  assert.equal(await runCompanion(["--setup-account"], { ...base, log: collectLog(), preflight, playwright: {}, setupAccount: async () => ({ ok: false }) }), 4, "an account that could not be chosen exits with the sign-in code");
});

test("forgetting a sign-in is not blocked by the account mode, and --status lists the account of each profile", async (t) => {
  const home = tmpDir(t);
  const dir = profileDir(home, "chromium", "copilot-studio", "separate");
  writeAccountRecord(dir, { source: "manual", confirmed: true });
  fs.writeFileSync(path.join(dir, "keep.txt"), "x");
  const log = collectLog();
  const base = { nonInteractive: true, noSignals: true, resolveHome: () => ({ home, synced: { synced: false }, source: "test" }), osAccount: JOINED };
  const { describeSignInState } = await import("../companion.mjs");
  const lines = describeSignInState(home).join("\n");
  assert.match(lines, /Chromium \(installed with Playwright\) \(separate sign-in\): profile saved yes/);
  assert.match(lines, /Account: you signed in yourself, confirmed by you\./);
  assert.match(lines, /--setup-account/);
  const code = await runCompanion(["--forget-signin=copilot-studio"], { ...base, log });
  assert.equal(code, 0);
  assert.match(log.text(), /Removed the saved sign-in \(separate\/chromium\/copilot-studio\)/);
  assert.ok(!fs.existsSync(dir));
});

test("a session saved in a separate profile is restored there and counted for that account mode only", async (t) => {
  const home = tmpDir(t);
  const fake = createFakePlaywright();
  const opened = await openProfile({ playwright: fake.playwright, home, profile: "copilot-studio", kinds: ["chromium"], log: () => {}, account: { mode: "separate", os: JOINED } });
  assert.equal(opened.dir, profileDir(home, "chromium", "copilot-studio", "separate"));
  assert.equal(opened.namespace, "separate");
  assert.equal(opened.inPrivate, false);
  fake.signIn({ persistent: true });
  await saveSession({ context: opened.context, dir: opened.dir, product: "copilot-studio", browser: "chromium", captured: true });
  await opened.context.close();
  assert.deepEqual(listSignedInProducts(home, { namespace: "separate" }), ["copilot-studio"]);
  assert.deepEqual(listSignedInProducts(home, { namespace: "" }), []);
  const again = createFakePlaywright();
  const second = await openProfile({ playwright: again.playwright, home, profile: "copilot-studio", kinds: ["chromium"], log: () => {}, account: { mode: "separate", os: JOINED } });
  assert.equal(second.restored, 1);
  const windows = createFakePlaywright();
  const third = await openProfile({ playwright: windows.playwright, home, profile: "copilot-studio", kinds: ["chromium"], log: () => {}, account: { mode: "windows", os: JOINED } });
  assert.equal(third.restored, 0, "the Windows-account profile is a different folder");
  assert.equal(osAccountFlags(null).osWorkAccount, null);
});
