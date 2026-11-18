// Real-browser proof of the account changes: an installed Edge opened InPrivate (what a separate sign-in uses on a PC
// with a Windows work account) signs in through the pretend tenant, keeps the sign-in between jobs, and reports how the
// account was chosen; and the pictures are 1440 by 900 pixels whatever the display scaling is. Skipped when no installed
// Edge or Chrome, or no Playwright, is available. Every id here is fake.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseDsregcmd } from "../account-source.mjs";
import { attachedCount, fitWindow, launchAttached } from "../attach.mjs";
import { detectInstalledBrowsers } from "../browsers.mjs";
import { normalizeViewport } from "../capture-run.mjs";
import { loadPlaywrightModule } from "../lab-runner.mjs";
import { FAKE_PRODUCT_HOSTS } from "./fixtures/fake-tenant.mjs";
import { runScenario, scenarioShot } from "./fixtures/signin-scenarios.mjs";

const TOOL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [A] = FAKE_PRODUCT_HOSTS;
const JOINED = parseDsregcmd("AzureAdJoined : YES\nDomainJoined : NO\nWorkplaceJoined : NO\nAzureAdPrt : YES\nAzureAdPrtAuthority : https://login.microsoftonline.com/0a1b2c3d-1111-4222-8333-444455556666\n");

let playwright = null;
try {
  playwright = await loadPlaywrightModule(path.resolve(TOOL_DIR, "..", ".."));
} catch {
  playwright = null;
}
const installed = detectInstalledBrowsers();
const kind = installed.edge ? "edge" : installed.chrome ? "chrome" : null;
const skip = !playwright?.chromium || !kind ? "no installed Edge or Chrome, or no Playwright" : false;

test("a separate sign-in in a real browser opened the way the account mode says keeps its sign-in between jobs and reports how the account was chosen", { skip, timeout: 180_000 }, async () => {
  const run = await runScenario({
    toolDir: TOOL_DIR,
    tenantOptions: { userSignsInAfterMs: 6000, sessionCookies: false, staySignedInPage: true, userChoosesYes: true },
    jobs: [[scenarioShot({ filename: "a.png", host: A })], [scenarioShot({ filename: "b.png", host: A })]],
    signInWaitSec: 40,
    options: { browserKinds: [kind], launch: "attach", authSettleMs: 500, authConfirmMs: 800, attended: true, account: { mode: "separate", explicitMode: false, os: JOINED } },
  });
  const [first, second] = run.results;
  assert.deepEqual(first.calls.uploads, ["a.png"]);
  assert.deepEqual(second.calls.uploads, ["b.png"], "the second job took its picture without a second sign-in");
  assert.equal(run.tenant.stats.interactivePages, 1, "the person signed in once");
  assert.deepEqual(run.launches.map((l) => l.via), ["attach", "attach"]);
  if (kind === "edge") assert.ok(run.lines.some((l) => /Opened Microsoft Edge InPrivate \(started the normal way\)/.test(l)), "Edge is opened InPrivate for a separate sign-in");
  assert.equal(first.calls.completes[0].account.source, "manual", "a sign-in page was shown and the person completed it");
  assert.equal(first.calls.completes[0].account.mode, "separate");
  assert.equal(first.calls.completes[0].account.inPrivate, kind === "edge");
  assert.equal(second.calls.completes[0].account.source, "saved-session", "restored from this computer, no sign-in page");
  assert.ok(run.lines.some((l) => /Your saved sign-in was restored/.test(l)), "the saved session came back into the browser");
  assert.equal(attachedCount(), 0, "no browser was left running");
});

test("a real browser takes pictures at 1440 by 900 pixels at a device pixel ratio of 1, and the window fits them as far as the screen allows", { skip, timeout: 120_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "account-real-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }));
  const executable = installed[kind];
  const { context } = await launchAttached({ playwright, kind, dir, executable, headless: false, inPrivate: kind === "edge" });
  try {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto("data:text/html,<html><body style='margin:0;background:linear-gradient(90deg,red,blue)'><h1>probe</h1></body></html>");
    await fitWindow(context);
    const seen = await normalizeViewport(page, { width: 1440, height: 900 });
    assert.ok(seen, "the viewport was read back");
    assert.equal(seen.normalized, true);
    assert.equal(Math.round(seen.dpr * 100) / 100, 1);
    const png = await page.screenshot();
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1440, 900]);
  } finally {
    await context.close();
  }
  assert.equal(attachedCount(), 0);
});
