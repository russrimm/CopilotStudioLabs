/**
 * Capture accuracy, end to end in a real browser: the portal's real server, a lab built by the lab builder, the real
 * Local Capture Companion, and a pretend Copilot Studio that imitates what broke the real captures. Every test
 * skips itself when Playwright or a browser is not installed.
 *
 * The same scenarios print before and after numbers with:
 *   node tools/screenshot-capture/test/fixtures/capture-repro.mjs [--repo-dir=<checkout>]
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { detectBrowserAvailability } from "../../tools/screenshot-capture/lab-runner.mjs";
import { FAKE_AGENT_URL } from "../../tools/screenshot-capture/test/fixtures/fake-product-site.mjs";
import { scriptedPerson } from "../../tools/screenshot-capture/test/fixtures/capture-repro.mjs";
import { judge, runCaptureScenario, tally } from "../../tools/screenshot-capture/test/fixtures/capture-scenarios.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const found = await detectBrowserAvailability();
const skip = !found.available && "Playwright with Chromium is not installed";
const AGENT = { copilotStudioAgentUrl: FAKE_AGENT_URL };
const scenario = (extra) => runCaptureScenario({ repoDir: REPO_ROOT, ...extra });

test("e2e: with the agent address, every automatic screenshot is accepted on the right screen and nothing is changed in the tenant", { skip, timeout: 180_000 }, async () => {
  const out = await scenario({ job: { targets: AGENT } });
  const t = tally(out.rows);
  assert.equal(t.acceptedOnWrongScreen, 0, "a wrong screen is never accepted");
  assert.equal(t.landedWrong, 0);
  assert.equal(t.needsReview, 2, "only the two screens outside the agent wait for a person: no content proves their harness (nothing is stuck for a label that never appears)");
  assert.ok(t.accepted >= 3, out.lines.join("\n"));
  for (const filename of ["agent-overview.png", "agent-instructions.png", "generative-orchestration-setting.png"]) {
    const row = out.rows.find((r) => r.filename === filename);
    assert.equal(row.status, "captured", `${filename}: ${row.reason}`);
    assert.equal(judge(row).right, true, filename);
    assert.ok(row.raw.outcome.startsWith("Opened Copilot Studio"), `${filename}: the card says how it got there`);
  }
  for (const filename of ["copilot-studio-home.png", "create-agent-describe.png"]) {
    const row = out.rows.find((r) => r.filename === filename);
    assert.equal(row.status, "needs-review", filename);
    // In this mode the computer sets nothing up, so the Agents list shows without its menu open: the labels of the menu are reported as missing, which is true and is why a person looks.
    const codes = row.verification.reasons.map((r) => r.code);
    assert.ok(codes.includes("harness-unproven"), `${filename}: kept for a person because nothing proves its harness`);
    assert.deepEqual(codes.filter((c) => c !== "harness-unproven" && c !== "labels-missing"), [], `${filename}: no other reason than the missing labels of the lab's later steps`);
    assert.equal(judge(row).right, true, filename);
  }
  assert.deepEqual(out.site.stats.writes, [], "no publish, no create, nothing");
  assert.equal(out.site.stats.appsNewVisits, 0);
  assert.equal(out.job.status, "done");
  assert.equal(out.labStatus.shots.find((s) => s.filename === "agent-overview.png").captured, true, "the lab itself now has the screenshot");
  // The shots that need a person are said so plainly, grouped, and not run on a wrong page (nobody is at this computer).
  const needsYou = out.rows.filter((r) => r.status === "needs-you");
  assert.ok(needsYou.length >= 4);
  assert.ok(out.job.causes.some((c) => c.code === "needs-you" && c.count === needsYou.length));
});

test("e2e: with no addresses, shots that need the agent are held back with one clear group and never end on a wrong page", { skip, timeout: 180_000 }, async () => {
  const out = await scenario({});
  const t = tally(out.rows);
  assert.equal(t.acceptedOnWrongScreen, 0);
  assert.equal(t.landedWrong, 0, "the old behavior landed on a wrong page 8 times out of 10");
  const group = out.job.causes.find((c) => c.code === "no-agent");
  assert.ok(group && group.count >= 3, "one group: No agent address set");
  assert.equal(group.fixAction, "settings");
  assert.deepEqual(out.site.stats.writes, []);
  assert.equal(out.queued.missing[0].id, "copilot-studio-agent", "the portal said what was missing when it queued the job");
});

test("e2e: a lab built with a SharePoint site address queues with that address and is not skipped for a missing variable", { skip, timeout: 180_000 }, async () => {
  const out = await scenario({ lab: { products: ["sharepoint-ai"], features: ["spai-copilot-in-sharepoint-overview"], sharepointSiteUrl: "https://contoso.sharepoint.com/sites/training", sharepointSiteName: "Training" } });
  assert.deepEqual(out.job.envNames, ["CAPTURE_SHAREPOINT_SITE_URL"]);
  assert.ok(out.rows.every((r) => r.status !== "skipped"), "nothing is skipped for the address");
  assert.ok(!JSON.stringify(out.job).includes("contoso.sharepoint.com"));
});

test("e2e: closing the browser mid-job pauses the job once and every remaining shot can be resumed", { skip, timeout: 180_000 }, async () => {
  const out = await scenario({
    job: { targets: AGENT },
    onUpload: async ({ uploads, contexts }) => {
      if (uploads === 2) await Promise.all(contexts.map((c) => c.close().catch(() => {})));
    },
  });
  const t = tally(out.rows);
  assert.equal(t.failed, 0, "no fifty failures");
  assert.ok(t.paused >= 1);
  assert.equal(out.lines.filter((l) => /closed the browser window/.test(l)).length, 1);
  assert.equal(out.job.result.resumable, true);
  assert.equal(out.job.causes.find((c) => c.code === "browser-closed").fixAction, "resume");
});

test("e2e: guided mode waits for a person at each screen, then verifies and uploads as usual", { skip, timeout: 240_000 }, async () => {
  const out = await scenario({ job: { targets: AGENT, options: { mode: "guided" } }, runOptions: { attended: true, onGuidedWaiting: scriptedPerson } });
  const t = tally(out.rows);
  assert.equal(t.landedWrong, 0);
  assert.equal(t.acceptedOnWrongScreen, 0);
  // A person drives in guided mode and the companion only reads, so it can prove the harness only where the page shows an agent's own tabs or
  // navigation. A screen outside any agent (Home, the start of Create) cannot be proven: its picture is saved for review, never as a good one.
  const reviewed = out.rows.filter((r) => r.status === "needs-review").map((r) => r.filename).sort();
  assert.deepEqual(reviewed, ["copilot-studio-home.png", "create-agent-describe.png"], out.lines.join("\n"));
  assert.equal(t.accepted, 7, out.lines.join("\n"));
  const skipped = out.rows.filter((r) => r.status === "skipped");
  assert.deepEqual(skipped.map((r) => [r.filename, r.cause]), [["publish-confirmation.png", "skipped-by-you"]], "the person skipped the screen that would publish");
  assert.deepEqual(out.site.stats.writes, [], "nothing in the tenant was changed by the companion");
  assert.ok(out.rows.filter((r) => r.status === "captured").every((r) => r.raw.mode === "guided" && /You set up the screen\./.test(r.raw.outcome)));
});
