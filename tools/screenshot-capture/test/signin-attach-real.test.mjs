// Real-browser proof of the sign-in changes: the installed Edge (or Chrome) is started the normal way, connected to over
// a loopback debugging port, and signs in through the pretend tenant while the companion only watches. Skipped when no
// installed browser or no Playwright is available.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { attachedCount } from "../attach.mjs";
import { detectInstalledBrowsers } from "../browsers.mjs";
import { loadPlaywrightModule } from "../lab-runner.mjs";
import { FAKE_PRODUCT_HOSTS } from "./fixtures/fake-tenant.mjs";
import { runScenario, scenarioShot } from "./fixtures/signin-scenarios.mjs";

const TOOL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [A] = FAKE_PRODUCT_HOSTS;

let playwright = null;
try {
  playwright = await loadPlaywrightModule(path.resolve(TOOL_DIR, "..", ".."));
} catch {
  playwright = null;
}
const installed = detectInstalledBrowsers();
const kind = installed.edge ? "edge" : installed.chrome ? "chrome" : null;
const skip = !playwright?.chromium || !kind ? "no installed Edge or Chrome, or no Playwright" : false;

test("a real browser started the normal way signs in through the tenant while the companion only watches, then ends cleanly", { skip, timeout: 120_000 }, async () => {
  const run = await runScenario({
    toolDir: TOOL_DIR,
    tenantOptions: { userSignsInAfterMs: 6000, sessionCookies: false, staySignedInPage: true, userChoosesYes: true },
    jobs: [[scenarioShot({ filename: "a.png", host: A }), scenarioShot({ filename: "b.png", host: A, path: "/settings" })]],
    signInWaitSec: 40,
    options: { browserKinds: [kind], launch: "attach", authSettleMs: 500, authConfirmMs: 800, attended: true },
  });
  const { result, calls } = run.results[0];
  assert.deepEqual(calls.uploads, ["a.png", "b.png"], "both pictures were taken after the sign-in");
  assert.equal(result.signInFailures.length, 0);
  assert.ok(run.lines.some((l) => /started the normal way/.test(l)), "the browser was started by attach");
  assert.deepEqual(run.launches.map((l) => l.via), ["attach"], "one browser, connected to, not launched by Playwright");
  assert.equal(attachedCount(), 0, "the browser process was ended");
  const startPages = run.tenant.stats.productPages.filter((p) => p === `${A}/`).length;
  assert.ok(startPages <= 2, `the product start page was requested ${startPages} times: the sign-in was not interrupted by another navigation`);
  assert.equal(run.tenant.stats.interactivePages, 1, "the person signed in once");
});

test("a real browser caught in a redirect loop between the product and sign-in is stopped and diagnosed, not retried", { skip, timeout: 120_000 }, async () => {
  const run = await runScenario({
    toolDir: TOOL_DIR,
    tenantOptions: { preSignedIn: [A], staleApp: true, bounceForever: true, redirectDelayMs: 100 },
    jobs: [[scenarioShot({ filename: "a.png", host: A }), scenarioShot({ filename: "b.png", host: A, path: "/memory" })]],
    signInWaitSec: 60,
    options: { browserKinds: [kind], launch: "attach", authSettleMs: 500, authConfirmMs: 500 },
  });
  const { result, calls } = run.results[0];
  assert.equal(result.signInFailures[0]?.code, "ping-pong");
  assert.deepEqual(calls.uploads, [], "no picture was taken");
  assert.ok(run.lines.some((l) => /kept bouncing between Microsoft Copilot Studio and the sign-in page/.test(l)));
  assert.ok(run.lines.some((l) => /Things that can cause this/.test(l)));
  assert.equal(calls.completes.at(-1).signIn.code, "ping-pong");
  assert.equal(attachedCount(), 0);
  assert.ok(run.elapsedMs < 60_000, "it stopped within seconds, not after the whole wait");
});
