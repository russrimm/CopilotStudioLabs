// Real-browser proof of automatic capture: the whole lab is captured by the real companion against a real local portal
// and the pretend product site, with no click from a person. It checks what was photographed, that nothing outside the
// safety tiers was touched, that consent is enforced on both sides, and that "Show me once" is learned and replayed.
// Skipped when no browser is installed.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createPortalClient } from "../companion.mjs";
import { createRecipeStore } from "../recipes.mjs";
import { detectBrowserAvailability } from "../lab-runner.mjs";
import { FAKE_AGENT_URL, FAKE_PRACTICE_ENV_URL, FAKE_SITE_URL } from "./fixtures/fake-product-site.mjs";
import { startScenario, WORKTREE_ROOT } from "./fixtures/capture-scenarios.mjs";

const found = await detectBrowserAvailability({ repoRoot: WORKTREE_ROOT }).catch(() => ({ available: false }));
const skip = found.available ? false : "Playwright with a browser is not installed";
const AGENT = { copilotStudioAgentUrl: FAKE_AGENT_URL };
const READ_ONLY = { consented: true, level: "read-only" };
const PRACTICE = { consented: true, level: "practice", practiceEnvironmentUrl: FAKE_PRACTICE_ENV_URL };
const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "..", "..", "..");
const JOB = (extra = {}) => ({ targets: AGENT, options: { mode: "autonomous" }, ...extra });
const count = (rows, status) => rows.filter((r) => r.status === status).length;

/** What every automatic run must satisfy, whatever the product does. */
function assertClean(out, { writes = [], person = 0 } = {}) {
  const text = out.lines.join("\n");
  assert.deepEqual(out.site.stats.dangers, [], "nothing the computer must never touch was touched");
  assert.equal(out.site.stats.adminVisits, 0, "the admin page was never opened");
  assert.deepEqual(out.site.stats.writes.map((w) => w.split(":")[0]).filter((w) => !writes.includes(w)), [], "no write outside what consent allowed");
  assert.doesNotMatch(text, /\[you set it up\]/, "no shot was routed to a person");
  // `person`: shots with no step that reaches their screen are left to a person instead of photographing whatever is open.
  assert.equal(count(out.rows, "needs-you"), person, text);
  assert.equal(count(out.rows, "failed"), 0, text);
}

test("read-only automatic capture captures every browser-reachable shot and stops cleanly at what needs a practice agent", { skip, timeout: 240_000 }, async () => {
  const scenario = await startScenario({ repoDir: REPO });
  try {
    await scenario.call("PUT", "/api/capture/consent", READ_ONLY);
    const out = await scenario.runJob({ job: JOB() });
    assertClean(out);
    assert.equal(count(out.rows, "captured"), 7, out.lines.join("\n"));
    const review = out.rows.filter((r) => r.status === "needs-review");
    // The pretend site has no activity map, so that picture is saved for review (the recipe checks the screen by its own label); the two screens that need a practice agent still say so.
    assert.deepEqual(review.map((r) => r.filename), ["activity-map-plan.png", "knowledge-answer-citation.png", "publish-confirmation.png"]);
    assert.deepEqual(review.filter((r) => r.cause === "needs-practice-agent").map((r) => r.filename), ["knowledge-answer-citation.png", "publish-confirmation.png"], "the two screens that need a practice agent say so");
    // A label the lab expects that the page does not show is now a reason on its own (companion pictures must prove the screen), next to the recipe's own review.
    assert.deepEqual(review.find((r) => r.filename === "activity-map-plan.png").verification.reasons.map((x) => x.code), ["labels-missing", "recipe-review"]);
    assert.deepEqual(out.site.stats.writes, [], "nothing was created, saved, or published");
    assert.ok(out.rows.every((r) => !r.raw.setup || r.raw.setup.steps.every((s) => s.tier <= 1)), "no step above Tier 1 ran");
    const test = out.rows.find((r) => r.filename === "test-pane-in-scope.png");
    assert.match(test.raw.outcome, /sample question/i, "the card says what was done");
    assert.ok(test.raw.setup.steps.some((s) => s.strategy), "and which strategies found the controls");
    assert.equal(out.job.options.autonomy.level, "read-only");
  } finally {
    await scenario.close();
  }
});

test("without consent the job carries nothing above Tier 0, and the companion refuses Tier 2 without its own flag even when the portal asks", { skip, timeout: 240_000 }, async () => {
  const noFlag = await startScenario({ repoDir: REPO });
  try {
    await noFlag.call("PUT", "/api/capture/consent", PRACTICE);
    const out = await noFlag.runJob({ job: JOB(), runOptions: { allowPracticeWrites: false } });
    assertClean(out);
    assert.deepEqual(out.site.stats.writes, [], "the portal asked for a practice agent and the computer said no");
    assert.equal(count(out.rows, "needs-review"), 3, "the activity map the pretend site lacks, and the two screens that need a practice agent");
    assert.match(out.lines.join("\n"), /allow-practice-writes/, "the person is told what to change");
  } finally {
    await noFlag.close();
  }

  const noConsent = await startScenario({ repoDir: REPO });
  try {
    const queued = await noConsent.call("POST", "/api/capture/jobs", { target: { type: "lab", labId: noConsent.lab.labId }, scope: { mode: "all" }, targets: AGENT, options: { mode: "autonomous" } });
    assert.equal(queued.body.needsConsent, true, "the portal will not start an automatic job without the person's consent");
    assert.equal(queued.body.job, null);
  } finally {
    await noConsent.close();
  }
});

test("with consent and the flag a practice agent is created once, reused by the next job, listed, and nothing is deleted", { skip, timeout: 300_000 }, async () => {
  const scenario = await startScenario({ repoDir: REPO });
  try {
    await scenario.call("PUT", "/api/capture/consent", PRACTICE);
    const first = await scenario.runJob({ job: JOB(), runOptions: { allowPracticeWrites: true } });
    assertClean(first, { writes: ["create-start", "create-agent", "add-knowledge", "publish"] });
    assert.equal(count(first.rows, "captured"), 8, first.lines.join("\n"));
    assert.deepEqual(first.rows.filter((r) => r.status === "needs-review").map((r) => r.filename), ["activity-map-plan.png", "knowledge-answer-citation.png"], "the screens a recipe cannot check are kept for a person (the pretend site has no activity map; a citation is always checked by a person)");
    assert.equal(scenario.site.practiceAgents().length, 1, "one practice agent");
    assert.ok(scenario.site.practiceAgents()[0].name.startsWith("Lab screenshots - "));
    assert.ok(first.job.result.created.length >= 1, "the portal names what was created");
    assert.ok(first.job.result.created.every((c) => !/https?:|[0-9a-f]{8}-[0-9a-f]{4}/i.test(JSON.stringify(c))), "and never links or identifies it");
    const report = path.join(scenario.home, "practice-report.md");
    assert.ok(fs.existsSync(report), "the report is written for the person");
    assert.ok(!scenario.site.stats.writes.some((w) => /delete/i.test(w)), "nothing was deleted");

    const second = await scenario.runJob({ job: JOB(), runOptions: { allowPracticeWrites: true } });
    assertClean(second, { writes: ["create-start", "create-agent", "add-knowledge", "publish"] });
    assert.equal(scenario.site.practiceAgents().length, 1, "the practice agent was reused, not created again");
    assert.equal(count(second.rows, "captured"), 8, "the same screens are captured, and the same two are kept for a person");
  } finally {
    await scenario.close();
  }
});

const botIdsOpened = (out) => [...new Set(out.site.stats.pages.map((p) => /\/bots\/([^/]+)/.exec(p)?.[1]).filter(Boolean))];

test("with no agent address given, the practice agent is created first and every shot that shows an agent uses it, and no other agent in the tenant is opened", { skip, timeout: 300_000 }, async () => {
  const scenario = await startScenario({ repoDir: REPO });
  try {
    await scenario.call("PUT", "/api/capture/consent", PRACTICE);
    const out = await scenario.runJob({ job: { options: { mode: "autonomous" } }, runOptions: { allowPracticeWrites: true } });
    assertClean(out, { writes: ["create-start", "create-agent", "add-knowledge", "publish"] });
    assert.equal(out.job.options.agentSource, "created", "the created agent is the default when no address is given");
    assert.equal(count(out.rows, "skipped"), 0, "nothing waited for an address");
    assert.equal(count(out.rows, "captured"), 8, out.lines.join("\n"));
    const made = scenario.site.practiceAgents();
    assert.equal(made.length, 1, "one practice agent");
    assert.deepEqual(botIdsOpened(out), [made[0].id], "the only agent page that was opened is the one the computer made");
    // The plan runs the shots that create the agent before the first shot that needs it, and says so.
    const order = out.claimed.shots.map((s) => s.filename);
    const creators = out.claimed.shots.filter((s) => s.capture.agent?.creates).map((s) => order.indexOf(s.filename));
    const dependents = out.claimed.shots.filter((s) => s.capture.agent?.needs && !s.capture.agent.creates).map((s) => order.indexOf(s.filename));
    assert.ok(creators.length >= 1 && dependents.length >= 3 && Math.max(...creators) < Math.min(...dependents), `creation first: ${order.join(", ")}`);
    assert.match(out.lines.join("\n"), /uses the practice agent created first in this capture/);

    // A second job for the lab reuses it without being told anything about it.
    const second = await scenario.runJob({ job: { options: { mode: "autonomous" } }, runOptions: { allowPracticeWrites: true } });
    assertClean(second, { writes: ["create-start", "create-agent", "add-knowledge", "publish"] });
    assert.equal(scenario.site.practiceAgents().length, 1, "reused, not created again");
    assert.equal(count(second.rows, "captured"), 8);
  } finally {
    await scenario.close();
  }
});

test("when the practice agent cannot be created, the shots that show an agent wait with one plain reason, nothing is guessed, and no other agent is opened", { skip, timeout: 300_000 }, async () => {
  // The newer layout has no "Create blank agent" button, so the practice agent cannot be made on this site.
  const scenario = await startScenario({ repoDir: REPO, site: { layout: "newer" } });
  try {
    await scenario.call("PUT", "/api/capture/consent", PRACTICE);
    const out = await scenario.runJob({ job: { options: { mode: "autonomous" } }, runOptions: { allowPracticeWrites: true } });
    assert.deepEqual(out.site.stats.dangers, []);
    assert.deepEqual(out.site.stats.writes, [], "nothing was made or changed");
    assert.deepEqual(botIdsOpened(out), [], "no agent page was opened: the shots did not go to a guessed or saved agent");
    const waiting = out.rows.filter((r) => r.cause === "agent-unavailable");
    assert.ok(waiting.length >= 3, out.rows.map((r) => `${r.filename}:${r.status}:${r.cause || ""}`).join(", "));
    assert.ok(waiting.every((r) => r.status === "skipped" && /^The practice agent could not be created \(.+\), so this screenshot needs an agent address\.$/.test(r.reason)), waiting.map((r) => r.reason).join(" | "));
    assert.equal(out.job.causes.find((c) => c.code === "agent-unavailable")?.title, "Waiting for the agent");
    assert.equal(scenario.site.practiceAgents().length, 0);
  } finally {
    await scenario.close();
  }
});

test("a job from an older portal, with no agent source and no hand-off fields, behaves exactly as before", { skip, timeout: 300_000 }, async () => {
  const scenario = await startScenario({ repoDir: REPO });
  try {
    await scenario.call("PUT", "/api/capture/consent", PRACTICE);
    const out = await scenario.runJob({
      job: JOB(),
      runOptions: { allowPracticeWrites: true },
      onClient: (client) => {
        const next = client.next;
        client.next = async () => {
          const claimed = await next();
          delete claimed.job.options.agentSource;
          for (const shot of claimed.shots) delete shot.capture.agent;
          return claimed;
        };
      },
    });
    assertClean(out, { writes: ["create-start", "create-agent", "add-knowledge", "publish"] });
    assert.equal(out.claimed.job.options.agentSource, undefined);
    assert.equal(count(out.rows, "captured"), 8, out.lines.join("\n"));
    assert.equal(scenario.site.practiceAgents().length, 1);
    assert.doesNotMatch(out.lines.join("\n"), /uses the practice agent created first|uses the agent whose address/, "the older way says nothing new");
  } finally {
    await scenario.close();
  }
});

const VARIANTS = [
  ["labels that are aria-labels and icons", { labelVariants: true }],
  ["a cookie banner and an unsaved-changes prompt", { cookieBanner: true, leavePrompt: true }],
  ["a test pane in an iframe and a dialog in a shadow root", { testPaneInIframe: true, shadowDialog: true }],
  ["slow answers, a flaky control, and a slow page", { chatDelayMs: 2500, chatStreamMs: 1800, flakyKnowledge: true, overviewBlankMs: 2500 }],
  ["a product that ignores typed section addresses", { directSections: false }],
];

for (const [name, site] of VARIANTS) {
  test(`automatic capture still reaches every screen with ${name}`, { skip, timeout: 240_000 }, async () => {
    const scenario = await startScenario({ repoDir: REPO, site });
    try {
      await scenario.call("PUT", "/api/capture/consent", READ_ONLY);
      const out = await scenario.runJob({ job: JOB() });
      assertClean(out);
      assert.equal(count(out.rows, "captured"), 7, out.lines.join("\n"));
      assert.equal(count(out.rows, "needs-review"), 3);
    } finally {
      await scenario.close();
    }
  });
}

test("Agent Builder, which has no direct address, and a SharePoint site are captured automatically", { skip, timeout: 240_000 }, async () => {
  const builder = await startScenario({ repoDir: REPO, lab: { products: ["m365-copilot-agent-builder"], features: ["dca-agent-builder-first-agent", "dca-write-agent-instructions", "dca-agent-builder-knowledge"] } });
  try {
    await builder.call("PUT", "/api/capture/consent", READ_ONLY);
    const out = await builder.runJob({ job: { options: { mode: "autonomous" } } });
    assertClean(out);
    // The pretend Agent Builder has no Try it panel and no knowledge options. A picture that does not show the labels the lab names is saved for
    // review (these four used to be accepted as captured although they showed the Configure screen again, which is how a wrong screen got in).
    assert.equal(count(out.rows, "captured"), 4, out.lines.join("\n"));
    const review = out.rows.filter((r) => r.status === "needs-review");
    assert.deepEqual(review.map((r) => r.filename), ["dca-try-it-response.png", "dca-instructions-test-result.png", "dca-knowledge-section.png", "dca-knowledge-test-result.png"]);
    assert.ok(review.every((r) => r.verification.reasons.some((x) => x.code === "labels-missing")), "each says which labels are missing");
    assert.equal(out.site.stats.directBuilderVisits, 0, "it was reached through Microsoft 365 Copilot, never by an address");
  } finally {
    await builder.close();
  }
  const site = await startScenario({ repoDir: REPO, lab: { products: ["sharepoint-ai"], features: ["spai-copilot-in-sharepoint-overview"], sharepointSiteUrl: FAKE_SITE_URL, sharepointSiteName: "Training" } });
  try {
    await site.call("PUT", "/api/capture/consent", READ_ONLY);
    const out = await site.runJob({ job: { options: { mode: "autonomous" } } });
    assertClean(out, { person: 1 });
    // No step reaches the first screen (a Copilot answer in the site's content), so it is left to a person: the old run photographed the site's home page and called it captured.
    // The second picture shows a panel the pretend site does not have, so the landmark check (the label the lab names) saves it for review instead of accepting the wrong screen.
    assert.equal(count(out.rows, "captured"), 0, out.lines.join("\n"));
    assert.equal(out.rows.find((r) => r.filename === "spai-copilot-answer-site-content.png").status, "needs-you");
    assert.equal(out.rows.find((r) => r.filename === "spai-copilot-answer-site-content.png").cause, "no-recipe");
    const review = out.rows.filter((r) => r.status === "needs-review");
    assert.deepEqual(review.map((r) => r.filename), ["spai-site-ai-settings-panel.png"]);
    assert.ok(review[0].verification.reasons.some((x) => x.code === "recipe-review"), "the recipe's own review is still there");
    assert.match(review[0].verification.reasons.find((x) => x.code === "recipe-review").message, /missing: Site AI/);
  } finally {
    await site.close();
  }
});

test("a shot automation cannot do is taught once with Show me once, shared safely, replayed automatically, and marked stale when the page changes", { skip, timeout: 300_000 }, async () => {
  // A renamed Test button that no built-in step knows about.
  const scenario = await startScenario({ repoDir: REPO, site: { testButtonName: "Chat panel" } });
  const only = { scope: { mode: "selected", filenames: ["test-pane-in-scope.png"] } };
  try {
    await scenario.call("PUT", "/api/capture/consent", READ_ONLY);

    const failed = await scenario.runJob({ job: JOB(only) });
    const row = failed.rows[0];
    assert.equal(row.status, "needs-you");
    assert.equal(row.cause, "automation-failed");
    assert.match(row.reason, /Show me once/, "the person is told how to teach it");
    const diagnostics = path.join(scenario.home, ".captures", "diagnostics");
    assert.ok(fs.existsSync(diagnostics) && fs.readdirSync(diagnostics).length >= 1, "a diagnostic bundle was written");
    const bundle = fs.readFileSync(path.join(diagnostics, fs.readdirSync(diagnostics)[0]), "utf8");
    assert.ok(!/\?|@|cookie|Bearer|ada/i.test(bundle.replace(/"[^"]*":\s*null/g, "")) || !/\?[a-z]+=/i.test(bundle), "the bundle has no query strings or secrets");
    assert.match(bundle, /Chat panel|Test your agent|Publish/, "it lists the control names around the failing step");

    // A scripted person shows the setup once.
    const person = async ({ page }) => {
      const bar = page.getByRole("button", { name: "Capture this screen", exact: true });
      await bar.waitFor({ state: "visible", timeout: 10_000 });
      await page.getByRole("button", { name: "Chat panel", exact: true }).click();
      await page.getByLabel("Type your message").fill("My private question about ada@contoso.com");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await page.getByText(/Here is an answer/).waitFor({ state: "visible", timeout: 10_000 });
      await bar.click();
    };
    const taught = await scenario.runJob({ job: { targets: AGENT, ...only, options: { mode: "guided", record: { share: true } } }, runOptions: { attended: true, guidedWaitSec: 40, onGuidedWaiting: person } });
    assert.equal(taught.rows[0].status, "captured", taught.lines.join("\n"));
    const store = createRecipeStore(scenario.home);
    const saved = store.list();
    assert.equal(saved.length, 1, "one recipe was saved on this computer");
    const text = JSON.stringify(saved[0]);
    assert.ok(!/ada@|contoso|private question/i.test(text), "what the person typed never became part of the recipe");
    assert.ok(saved[0].steps.some((s) => s.action === "open" && s.target?.name === "Chat panel"), `the click is recorded by its role and name: ${JSON.stringify(saved[0].steps)}`);
    assert.ok(!/"x"|"y"|clientX|coordinates/i.test(text), "never coordinates");
    assert.ok(saved[0].steps.every((s) => (s.tier ?? 0) <= 1), "nothing above Tier 1 was recorded");
    assert.equal(saved[0].shared, true, "the person chose to share it, and the portal accepted it");
    const shared = (await scenario.call("GET", "/api/capture/recipes")).body;
    assert.ok(JSON.stringify(shared).includes("Set up test-pane-in-scope.png"), "the portal keeps it for every lab");
    assert.ok(!/ada@|contoso|private question|https?:/i.test(JSON.stringify(shared)), "the shared copy is anonymous");

    // The portal refuses a recipe that holds tenant-specific data.
    const code = (await scenario.call("POST", "/api/capture/pair")).body;
    const paired = await createPortalClient({ portal: scenario.base }).pair({ code: code.code, deviceName: "TEST-PC" });
    const client = createPortalClient({ portal: scenario.base, token: paired.token });
    await assert.rejects(client.shareRecipe({ key: saved[0].key, title: "Bad", steps: [{ id: "s1", action: "open", target: { role: "button", name: "Open https://contoso.sharepoint.com/sites/x?id=1" } }] }), (err) => err.status === 422 || /not shared|reject|invalid/i.test(err.message));

    // The next run replays it by itself.
    const replay = await scenario.runJob({ job: JOB(only) });
    assertClean(replay);
    assert.equal(replay.rows[0].status, "captured", replay.lines.join("\n"));
    assert.equal(replay.rows[0].raw.setup?.source, "local", "the recipe the person recorded was used");
    assert.equal(store.list()[0].stale, false);

    // The page changes: the replay fails, the recipe is marked stale, and the shot says what to do.
    scenario.site.config.testButtonName = "Assistant";
    const changed = await scenario.runJob({ job: JOB(only) });
    assert.equal(changed.rows[0].status, "needs-you");
    assert.equal(createRecipeStore(scenario.home).list()[0].stale, true, "the recipe is stale now");
    assert.deepEqual(changed.site.stats.dangers, []);
    assert.deepEqual(changed.site.stats.writes, []);
  } finally {
    await scenario.close();
  }
});
