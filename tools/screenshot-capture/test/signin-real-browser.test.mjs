// Real-browser proof of the sign-in fixes. The companion's own runJob drives a real Chromium
// (and the installed Microsoft Edge, when there is one) against a pretend tenant that answers
// by route interception, so nothing leaves this computer and the real sign-in host patterns
// are exercised. Each test skips itself when no browser is installed.
//
// To see the same scenarios before and after a change: node test/fixtures/signin-repro.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { detectInstalledBrowsers } from "../browsers.mjs";
import { detectBrowserAvailability } from "../lab-runner.mjs";
import { runScenario, scenarioCatalog } from "./fixtures/signin-scenarios.mjs";

const TOOL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const found = await detectBrowserAvailability();
const edge = Boolean(detectInstalledBrowsers().edge);
const catalog = scenarioCatalog();

const run = (name, extra = {}) => runScenario({ toolDir: TOOL_DIR, tenantOptions: catalog[name].tenant, jobs: catalog[name].jobs, signInWaitSec: 8, ...extra });
const notCaptured = (out) => out.results.flatMap((r) => r.calls.statuses.filter((s) => !s.endsWith(":running")));
const captured = (out) => out.results.reduce((n, r) => n + r.calls.uploads.length, 0);

test("real browser: the first shot works, the next page asks for a fresh sign-in, and the person is asked once", { skip: !found.available && "Playwright with Chromium is not installed", timeout: 90_000 }, async () => {
  const out = await run("first shot works, then the next page asks for a fresh sign-in", { options: { authGraceMs: 500 } });
  assert.equal(captured(out), 4, "every shot was captured");
  assert.deepEqual(notCaptured(out), []);
  assert.equal(out.tenant.stats.interactivePages, 1, "the sign-in page was shown once, not once per shot");
  assert.deepEqual(out.tenant.stats.blocked, [], "nothing reached an address outside the pretend tenant");
  assert.equal(out.launches.length, 1);
  assert.match(out.lines.join("\n"), /Waiting for you to sign in to Microsoft Copilot Studio in the browser window/);
  assert.equal(out.lines.join("\n").match(/Waiting for you to sign in/g).length, 1);
});

test("real browser: a sign-in kept as a session cookie survives the companion restarting", { skip: !found.available && "Playwright with Chromium is not installed", timeout: 90_000 }, async () => {
  const out = await run("two jobs, sign-in kept as a session cookie (restart between)");
  assert.equal(captured(out), 2);
  assert.equal(out.tenant.stats.interactivePages, 0, "the second job is not asked to sign in again");
  assert.match(out.lines.join("\n"), /Your saved sign-in was restored/);
});

test("real browser: a lab step that says Sign out or Switch account is never clicked", { skip: !found.available && "Playwright with Chromium is not installed", timeout: 120_000 }, async () => {
  for (const name of ["lab step says Sign out", "lab step says Switch account"]) {
    const out = await run(name);
    assert.equal(out.tenant.stats.signOuts, 0, `${name}: the account was never signed out`);
    assert.equal(out.tenant.stats.forcedReauth, 0, `${name}: no new sign-in was forced`);
    assert.equal(captured(out), 3, name);
  }
});

test("real browser: when sign-in is blocked the person is asked once and the remaining shots are reported at once", { skip: !found.available && "Playwright with Chromium is not installed", timeout: 90_000 }, async () => {
  const out = await run("sign-in is blocked for this browser, 4 shots");
  assert.equal(out.tenant.stats.interactivePages, 1, "one sign-in page, not one per shot");
  assert.deepEqual(notCaptured(out).filter((s) => s.endsWith(":auth-required")).length, 4);
  assert.equal(out.results[0].result.tally.failed, 4);
  assert.match(out.lines.join("\n"), /Sign in to Microsoft Copilot Studio on your computer, then retry the 4 screenshots/);
  assert.ok(out.elapsedMs < 25_000, "one bounded wait, not one per shot");
});

test("real browser: a signed-in page whose address mentions the sign-in host, and a slow single sign-on trip, are not mistaken for sign-in", { skip: !found.available && "Playwright with Chromium is not installed", timeout: 120_000 }, async () => {
  const trap = await run("signed-in page whose address mentions the login host");
  assert.equal(captured(trap), 2);
  assert.ok(trap.elapsedMs < 20_000, "no wait for a sign-in that is not needed");
  const slow = await run("saved app sign-in expired, silent single sign-on through a slow login page");
  assert.equal(captured(slow), 2);
  assert.equal(slow.tenant.stats.interactivePages, 0, "silent single sign-on needed no person");
  assert.doesNotMatch(slow.lines.join("\n"), /Waiting for you to sign in/, "a quick silent trip says nothing");
});

test("real browser: the same headline scenario works in the installed Microsoft Edge", { skip: !found.playwrightInstalled ? "Playwright is not installed" : !edge && "Microsoft Edge is not installed", timeout: 90_000 }, async () => {
  const out = await run("first shot works, then the next page asks for a fresh sign-in", { options: { browserKinds: ["edge"] } });
  assert.equal(captured(out), 4);
  assert.equal(out.tenant.stats.interactivePages, 1);
  assert.equal(out.launches[0].options.channel, "msedge");
  assert.ok(out.launches[0].dir.includes(path.join(".auth", "edge")), "Edge has its own profile folder");
});
