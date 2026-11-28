// Real-browser proof that the practice agent is made per harness: a Classic agent (started from More create options > Agent, Standard, in the classic experience
// tab after the switch) for a Standard (Classic) picture and a Microsoft Copilot agent (started from More create options > Agent, uses Copilot Credits, in the
// default experience) for a Microsoft Copilot picture, each proven by its landmarks, each recorded under its harness, never reused for the other, and an agent
// recorded before harnesses were recorded is never reused for either.
// It runs against the pretend Copilot Studio in `harnessMode` (two hosts, a new tab for the classic experience; see fake-product-site.mjs). What a real tenant
// shows AFTER "Agent, Standard" is chosen was never observed, so the pretend one is a guess; the steps after the option are the existing ones.
// Each test skips itself when no browser is installed.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { findAgentByName, agentAddressOf } from "../agent-lookup.mjs";
import { createExecutor } from "../executor.mjs";
import { createCaptureSession, runCaptureShot } from "../capture-run.mjs";
import { resolveAutonomy } from "../guard.mjs";
import { workPageOf } from "../harness-run.mjs";
import { detectBrowserAvailability, loadPlaywrightModule, verifyCapturedImageBuffer } from "../lab-runner.mjs";
import { createPracticeRegistry } from "../practice.mjs";
import { practiceAgentName } from "../walkthrough.mjs";
import { FAKE_PRACTICE_ENV_ID, FAKE_PRACTICE_ENV_URL, createFakeProductSite } from "./fixtures/fake-product-site.mjs";

const found = await detectBrowserAvailability();
const playwright = found.playwrightInstalled ? await loadPlaywrightModule() : null;
const skip = !found.available && "Playwright with Chromium is not installed";

const gateOk = () => ({ failed: null, async ensureSignedIn() { return { ok: true }; } });
const real = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const CONTEXT = { labTitle: "Team Assistant", key: "lab-a", questions: ["What can you help me with?"] };
// The practice agent names of this lab: the harness marker, the short title, and the lab's code (see scratchAgentName), within 30 characters.
const COPILOT_NAME = practiceAgentName(CONTEXT, "microsoft-copilot");
const CLASSIC_NAME = practiceAgentName(CONTEXT, "standard");
assert.match(COPILOT_NAME, /^Copilot shots - Team [0-9a-z]{4}$/);
assert.match(CLASSIC_NAME, /^Classic shots - Team [0-9a-z]{4}$/);

/** A shot of the "create the agent" stage (the walkthrough builds the agent and shows it), for the harness the picture needs. */
function agentShot(filename, harness) {
  return {
    filename,
    moduleTitle: "Create the agent",
    product: "copilot-studio",
    harness,
    featureId: "mc-create-agent",
    section: "build",
    kind: "after",
    caption: "The new agent",
    alt: "The new agent",
    instructions: [],
    viewport: { width: 1280, height: 720 },
    callouts: [],
    capture: {
      version: 1,
      mode: "auto",
      why: "",
      needs: ["copilot-studio-agent"],
      agentNeeds: ["copilot-studio-agent"],
      missing: [],
      ready: true,
      route: { kind: "copilot-studio", screen: "overview", scope: "agent" },
      screen: { id: "overview", label: "the agent's Overview page" },
      path: ["Copilot Studio", "your agent", "Overview"],
      expect: { family: "copilot-studio", scope: "agent", paths: ["overview"], label: "the agent's Overview page", strict: true },
      reveal: [],
      landmarks: [],
      guide: [],
    },
  };
}

async function withTenant(options, fn) {
  const site = createFakeProductSite({ harnessMode: true, defaultDelayMs: 40, chatDelayMs: 80, ...options });
  const browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await site.attach(context);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-practice-"));
  const home = path.join(dir, "home");
  const registry = createPracticeRegistry(home);
  const lines = [];
  try {
    const page = await context.newPage();
    const mode = options.level === "scratch" ? "scratch" : "practice";
    const autonomy = resolveAutonomy(
      { consented: true, level: mode, practiceEnvironmentUrl: FAKE_PRACTICE_ENV_URL, ...(mode === "scratch" ? { scratchContext: CONTEXT } : {}) },
      { allowPracticeWrites: true },
    );
    const session = createCaptureSession({ autonomy, registry, home, agentSource: "created", writeGapMs: 0, effectMs: 2500, findMs: 4000, landmarkMs: 4000, landmarkSettleMs: 150, promptMs: 1200, switchWaitMs: 4000, switchTabMs: 6000, ...(options.session || {}) });
    const shoot = (shot) =>
      runCaptureShot({
        page: workPageOf(session, page),
        shot,
        session,
        effectiveMode: "autonomous",
        env: {},
        gate: gateOk(),
        assetsDir: path.join(dir, "a"),
        screenshotsDir: path.join(dir, "s"),
        sleep: real,
        log: (line) => lines.push(String(line)),
        verifyBuffer: verifyCapturedImageBuffer,
        readiness: { maxMs: 3000, answerMs: 10000 },
      });
    await fn({ site, registry, session, shoot, lines, dir, context });
  } finally {
    await browser.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const practiceAgents = (site) => site.practiceAgents().map((a) => ({ name: a.name, harness: a.harness }));

// The real Agents list (observed 2026-11-27) drew its "More create options" button 15 to 30 seconds after the address opened, while the lower left "More options" button was there at
// once, and a click on that button opened a dialog named Account (the control list ended with Sign out). The old executor fell back to a fuzzy match (a name score of 0.77 for
// "More options" against "More create options") and reported the step OK, so every Microsoft Copilot practice agent failed with "could not choose Agent, uses Copilot Credits".
// The fake delay is scaled: 2.5 seconds here for the 15 to 30 seconds there.
const SLOW_LIST = { createMenuLateMs: 2500, accountDecoy: true };

test("the Agents list draws More create options late and the lower left More options opens the Account flyout: the computer waits for the exact button, never clicks the wrong one, and makes the agent from the right menu", { skip, timeout: 300_000 }, async () => {
  // Both ways of making the practice agent: the practice level (agent handed over from the creation step) and building from scratch.
  for (const level of ["practice", "scratch"]) {
    await withTenant({ level, ...SLOW_LIST, session: { createMenuMs: 20_000, agentListMs: 4000 } }, async ({ site, shoot }) => {
      const result = await shoot(agentShot("agent.copilot.png", "microsoft-copilot"));
      assert.equal(result.status, "captured", `${level}: ${result.error}`);
      assert.equal(site.stats.accountOpens, 0, `${level}: the lower left More options button (it opens the Account flyout) was never clicked`);
      assert.deepEqual(site.stats.dangers, [], `${level}: nothing in the Account flyout or the top bar was touched`);
      assert.deepEqual(site.stats.createPicks, ["copilot"], `${level}: it started from More create options > Agent, uses Copilot Credits`);
      assert.equal(site.practiceAgents().length, 1, `${level}: one practice agent was made`);
    });
  }
});

test("when the Agents list never draws More create options, the computer waits for it, says so in plain words, and never clicks another button; a click that opens the Account flyout is closed and named", { skip, timeout: 300_000 }, async () => {
  await withTenant({ level: "practice", createMenuLateMs: 60_000, accountDecoy: true, session: { createMenuMs: 2000 } }, async ({ site, shoot }) => {
    const result = await shoot(agentShot("agent.copilot.png", "microsoft-copilot"));
    assert.equal(result.status, "skipped", `${result.status} ${result.error}`);
    assert.match(result.error, /^The practice agent could not be created: “More create options” was not on the Agents list after waiting \d+ seconds? \(.+\), and the older “New agent” button did not work either \(.+\)\. Nothing was created, so this screenshot needs an agent address\.$/);
    assert.doesNotMatch(result.error, /could not choose/);
    assert.equal(site.stats.accountOpens, 0, "the lower left More options button was never clicked");
    assert.deepEqual([site.stats.dangers, site.stats.writes, site.practiceAgents().length], [[], [], 0]);
  });

  // The exact button is there, and it opens the Account dialog instead of the menu: the dialog is closed with Escape (nothing inside it is touched) and the reason names it.
  await withTenant({ level: "practice", createMenuOpensAccount: true, accountDecoy: true, session: { createMenuMs: 3000 } }, async ({ site, shoot }) => {
    const result = await shoot(agentShot("agent.copilot.png", "microsoft-copilot"));
    assert.equal(result.status, "skipped", `${result.status} ${result.error}`);
    assert.match(result.error, /after the computer used “More create options”, a dialog named “Account” opened instead of the menu; it was closed with Escape and nothing in it was touched/);
    assert.doesNotMatch(result.error, /could not choose/);
    assert.equal(site.stats.accountOpens, 1, "the button was clicked once, and the flyout was not clicked inside");
    assert.deepEqual([site.stats.dangers, site.stats.writes, site.practiceAgents().length], [[], [], 0], "Sign out and the rest of the flyout were never touched, and nothing was created");
  });
});

test("built from scratch, a Microsoft Copilot picture and a Standard picture each get their own practice agent: distinct, within 30 characters, started from the right create option, made in the right experience, proven, and recorded by harness", { skip, timeout: 300_000 }, async () => {
  await withTenant({ level: "scratch" }, async ({ site, registry, shoot, lines, context }) => {
    const copilot = await shoot(agentShot("agent.copilot.png", "microsoft-copilot"));
    assert.equal(copilot.status, "captured", copilot.error);
    assert.equal(site.stats.classicClicks, 0, "the Microsoft Copilot agent was made without any switch");
    assert.deepEqual(site.stats.createPicks, ["copilot"], "it started from More create options > Agent, uses Copilot Credits");
    assert.equal(copilot.harness.id, "microsoft-copilot");
    assert.equal(copilot.harness.host, "copilotstudio.microsoft.com");
    assert.deepEqual(practiceAgents(site), [{ name: COPILOT_NAME, harness: "microsoft-copilot" }]);

    const classic = await shoot(agentShot("agent.classic.png", "standard"));
    assert.equal(classic.status, "captured", classic.error);
    assert.equal(site.stats.classicClicks, 1, "the Classic agent was made after the switch");
    assert.equal(site.stats.popups, 1, "which opened the classic experience in a new tab");
    assert.deepEqual(site.stats.createPicks, ["copilot", "standard"], "and it started from More create options > Agent, Standard");
    assert.equal(site.stats.feedbackSubmits, 0);
    assert.equal(classic.harness.id, "standard");
    assert.equal(classic.harness.switched, true);
    assert.equal(classic.harness.host, "copilotstudio.preview.microsoft.com");
    assert.equal(classic.harness.via, "click-path");
    assert.equal(context.pages().length, 1, "one tab: the first tab was closed once the classic tab was open");
    const made = practiceAgents(site);
    assert.deepEqual(made, [
      { name: COPILOT_NAME, harness: "microsoft-copilot" },
      { name: CLASSIC_NAME, harness: "standard" },
    ]);
    assert.ok(made.every((a) => a.name.length <= 30) && new Set(made.map((a) => a.name)).size === 2, "distinct names within the 30 characters the product keeps");

    // The registry looks agents up by environment, lab, and harness, and records the harness each agent was proven to be in.
    const envId = FAKE_PRACTICE_ENV_ID;
    assert.equal(registry.find(envId, "lab-a", "standard").name, CLASSIC_NAME);
    assert.equal(registry.find(envId, "lab-a", "microsoft-copilot").name, COPILOT_NAME);
    assert.equal(registry.find(envId, "lab-a", "customer-conversation"), null);
    assert.equal(registry.items().agents.length, 2);

    // Each slot gets the agent of its own harness, again and again: nothing more is created.
    const again = await shoot(agentShot("agent2.copilot.png", "microsoft-copilot"));
    assert.equal(again.status, "captured", again.error);
    assert.equal(site.practiceAgents().length, 2, "the Microsoft Copilot slot used its own agent, and made no third one");
    assert.equal(again.detail.practice.harness, "microsoft-copilot");
    assert.equal(site.stats.classicClicks, 1, "going back to a Microsoft Copilot picture did not switch anything");
    assert.equal(context.pages().length, 1, "and it is still one tab: the single tab opened the default address again");
    assert.match(lines.join("\n"), /Switching to the classic experience: ellipsis in the lower left corner > Open classic experience > Skip feedback/);
    assert.deepEqual(site.stats.dangers, []);
  });
});

test("an agent is found by its exact name: names that start alike are told apart, a name two rows share is never opened, and the top bar's account button is never a row", { skip, timeout: 180_000 }, async () => {
  await withTenant({ level: "scratch" }, async ({ site, context }) => {
    const envId = FAKE_PRACTICE_ENV_ID;
    const agent = (n, name) => ({ id: `aaaaaaaa-0000-4000-8000-00000000000${n}`, name, harness: "microsoft-copilot" });
    // A longer name that starts with the wanted one is listed first: a partial match would open it.
    site.envs[envId].agents.push(agent(1, "Copilot shots - Energy ab12 (copy)"), agent(2, "Copilot shots - Energy ab12"), agent(3, "Copilot shots - Energy cd34"), agent(4, "Copilot shots - Energy cd34"));
    const page = await context.newPage();
    const autonomy = resolveAutonomy({ consented: true, level: "scratch", practiceEnvironmentUrl: FAKE_PRACTICE_ENV_URL, scratchContext: CONTEXT }, { allowPracticeWrites: true });
    const env = { envBase: FAKE_PRACTICE_ENV_URL.replace(/\/home$/, ""), envId };
    const go = async (url) => {
      await page.goto(url);
      return {};
    };
    const executorFor = (practice) => createExecutor({ page, autonomy, product: "copilot-studio", practice, sleep: real, effectMs: 2500, findMs: 3000 });
    const practice = { agentId: null, envId, creating: () => false };
    const find = (name) => findAgentByName({ page, go, env, name, executorFor, practice, sleep: real, waitMs: 3000 });

    const found = await find("Copilot shots - Energy ab12");
    assert.equal(found.parsed?.botId, agent(2).id, "the row whose whole name matches is the one opened, not the one that merely starts with it");
    assert.equal(agentAddressOf(page)?.botId, agent(2).id, "and the id is read from the address the page lands on");

    const twice = await find("Copilot shots - Energy cd34");
    assert.equal(twice.ambiguous, 2, "two rows have this name, so it is said and nothing is opened");
    assert.equal(twice.parsed, undefined);

    const none = await find("Copilot shots - Energy zz99");
    assert.deepEqual([none.parsed, none.ambiguous], [undefined, undefined], "a name that is not listed finds nothing");

    // The top bar's "Open account menu for <person>" starts with "Open " too: it is never taken for a row, whatever name is asked for.
    const account = await find("account menu for Ada Lovelace");
    assert.equal(account.parsed, undefined);
    assert.deepEqual(site.stats.dangers, [], "the account button was never clicked");
  });
});

test("an agent recorded under the older shared name is still reused by its address, and a new agent of a set-aside lab gets a name of its own", { skip, timeout: 240_000 }, async () => {
  await withTenant({ level: "scratch" }, async ({ site, registry, shoot }) => {
    // What an earlier version recorded: the harness marker, the title cut at 30 characters, and no code. Three labs shared it.
    const legacy = { id: "11111111-2222-4333-8444-555555555566", name: "Copilot shots - Team Assistant" };
    site.envs[FAKE_PRACTICE_ENV_ID].agents.push({ ...legacy, harness: "microsoft-copilot" });
    registry.recordAgent({ envId: FAKE_PRACTICE_ENV_ID, botId: legacy.id, name: legacy.name, address: `${FAKE_PRACTICE_ENV_URL.replace(/\/home$/, "")}/agents/${legacy.id}`, key: "lab-a", harness: "microsoft-copilot" });
    const reused = await shoot(agentShot("agent.copilot.png", "microsoft-copilot"));
    assert.equal(reused.status, "captured", reused.error);
    assert.equal(site.practiceAgents().length, 1, "the agent with the old name was reused: nothing new was created");
    assert.equal(registry.items().agents[0].reusedCount, 1);

    // Set aside by Start fresh: the next one is built, and its name differs from the old one that is still listed.
    assert.equal(registry.generation(FAKE_PRACTICE_ENV_ID, "lab-a", "microsoft-copilot"), 0);
    registry.retire(FAKE_PRACTICE_ENV_ID, "lab-a", "microsoft-copilot");
    assert.equal(registry.generation(FAKE_PRACTICE_ENV_ID, "lab-a", "microsoft-copilot"), 1);
  });
});

test("an agent recorded before harnesses were recorded is never reused for a harness-specific picture: a new one is made, and the log says so", { skip, timeout: 240_000 }, async () => {
  await withTenant({ level: "scratch" }, async ({ site, registry, shoot, lines }) => {
    // An agent from an earlier version: a name with the older prefix and no harness.
    const legacy = { id: "11111111-2222-4333-8444-555555555555", name: "Lab screenshots - Team" };
    site.envs[FAKE_PRACTICE_ENV_ID].agents.push({ ...legacy, harness: "standard" });
    registry.recordAgent({ envId: FAKE_PRACTICE_ENV_ID, botId: legacy.id, name: legacy.name, address: `${FAKE_PRACTICE_ENV_URL.replace(/\/home$/, "")}/bots/${legacy.id}/overview`, key: "lab-a" });
    assert.equal(registry.find(FAKE_PRACTICE_ENV_ID, "lab-a", "standard"), null, "a record with no harness does not match a harness");
    assert.equal(registry.findUnrecorded(FAKE_PRACTICE_ENV_ID, "lab-a").botId, legacy.id);

    const result = await shoot(agentShot("agent.copilot.png", "microsoft-copilot"));
    assert.equal(result.status, "captured", result.error);
    assert.deepEqual(practiceAgents(site).filter((a) => a.name !== legacy.name), [{ name: COPILOT_NAME, harness: "microsoft-copilot" }]);
    assert.match(lines.join("\n"), /An earlier practice agent has no harness recorded, so it is not used for a Microsoft Copilot harness picture\. A new one is built\./);
    assert.equal(registry.items().agents.find((a) => a.botId === legacy.id).reusedCount, 0, "the older agent was not reused");
    assert.equal(registry.findUnrecorded(FAKE_PRACTICE_ENV_ID, "lab-a").botId, legacy.id, "and it is still listed as not recorded");
  });
});

test("a Customer Conversation picture is never built by the computer: a plain reason, and nothing is created", { skip, timeout: 120_000 }, async () => {
  await withTenant({ level: "scratch" }, async ({ site, shoot }) => {
    const result = await shoot(agentShot("agent.customer.png", "customer-conversation"));
    assert.deepEqual([result.status, result.cause], ["needs-you", "needs-you"]);
    assert.match(result.error, /does not build Customer Conversation agents/);
    assert.equal(site.practiceAgents().length, 0);
    assert.deepEqual(site.stats.writes, []);
  });
});

test("with a practice agent (not built from scratch) the agent handed over from the creation step is the one of the slot's harness", { skip, timeout: 300_000 }, async () => {
  await withTenant({ level: "practice" }, async ({ site, registry, shoot, lines }) => {
    const copilot = await shoot({ ...agentShot("a.copilot.png", "microsoft-copilot"), featureId: "other", section: "overview" });
    assert.equal(copilot.status, "captured", copilot.error);
    assert.equal(copilot.harness.id, "microsoft-copilot");
    const classic = await shoot({ ...agentShot("a.classic.png", "standard"), featureId: "other", section: "overview" });
    assert.equal(classic.status, "captured", classic.error);
    assert.equal(classic.harness.id, "standard");
    const made = practiceAgents(site);
    assert.equal(made.length, 2);
    assert.match(made[0].name, /^Copilot shots - [0-9a-f]{6}$/);
    assert.match(made[1].name, /^Classic shots - [0-9a-f]{6}$/);
    assert.ok(made.every((a) => a.name.length <= 30));
    assert.deepEqual(made.map((a) => a.harness), ["microsoft-copilot", "standard"]);
    assert.deepEqual(registry.items().agents.map((a) => a.harness), ["microsoft-copilot", "standard"]);
    assert.equal(site.stats.classicClicks, 1);
    assert.match(lines.join("\n"), /Proved the Standard \(Classic\) harness: Overview/);
  });
});

test("one job with both harnesses, one harness after the other: the classic switch is made once, the classic tab is closed once, two practice agents are made, each picture carries the harness it was proven in, and a classic experience that cannot be reached is Needs you", { skip, timeout: 420_000 }, async () => {
  await withTenant({ level: "scratch" }, async ({ site, registry, shoot, lines, context }) => {
    // The plan gives all the Standard shots, then all the Microsoft Copilot shots (the creation step first inside each).
    const first = await shoot(agentShot("a.classic.png", "standard"));
    const second = await shoot(agentShot("b.classic.png", "standard"));
    assert.deepEqual([first.status, second.status], ["captured", "captured"], first.error || second.error);
    assert.deepEqual([first.harness.id, second.harness.id], ["standard", "standard"]);
    assert.equal(site.stats.classicClicks, 1, "the switch to the classic experience was made once for both Standard shots");
    assert.equal(site.stats.popups, 1);
    assert.equal(first.harness.switched, true);
    assert.equal(context.pages().length, 1, "one tab: the first tab was closed, the classic tab is the only one");
    assert.doesNotMatch(lines.join("\n"), /Changing experience/, "the classic tab stays the page in use for the whole Standard part");

    const third = await shoot(agentShot("c.copilot.png", "microsoft-copilot"));
    const fourth = await shoot(agentShot("d.copilot.png", "microsoft-copilot"));
    assert.deepEqual([third.status, fourth.status], ["captured", "captured"], third.error || fourth.error);
    assert.deepEqual([third.harness.id, fourth.harness.id], ["microsoft-copilot", "microsoft-copilot"]);
    assert.equal(third.harness.switched, false, "a Microsoft Copilot picture is never marked as switched");
    assert.equal(context.pages().length, 1, "still one tab: the classic tab opened the default address again for the Microsoft Copilot part");
    assert.equal(site.stats.classicClicks, 1, "going back to the default experience clicked nothing in the classic one");
    const text = lines.join("\n");
    assert.equal((text.match(/Switching to the classic experience:/g) || []).length, 1);
    assert.equal((text.match(/Changing experience: going back to the default experience/g) || []).length, 1, "the single tab went back to the default address once");
    assert.match(text, /Proved the Microsoft Copilot harness: Build, Preview, Evaluate, Monitor/);

    // Two practice agents inside the same job, each proven in its own experience and neither used for the other.
    assert.deepEqual(practiceAgents(site), [
      { name: CLASSIC_NAME, harness: "standard" },
      { name: COPILOT_NAME, harness: "microsoft-copilot" },
    ]);
    assert.deepEqual(registry.items().agents.map((a) => a.harness), ["standard", "microsoft-copilot"]);
    assert.deepEqual([first, second, third, fourth].map((r) => r.detail.practice.harness), ["standard", "standard", "microsoft-copilot", "microsoft-copilot"]);

    // A plan that goes back to the first harness switches again (a new tab), because the classic tab was closed.
    const back = await shoot(agentShot("e.classic.png", "standard"));
    assert.equal(back.status, "captured", back.error);
    assert.equal(back.harness.id, "standard");
    assert.equal(site.stats.classicClicks, 2, "an interleaved Standard shot switched again, proved again");
    assert.equal(site.stats.popups, 2);
    assert.equal(site.practiceAgents().length, 2, "and used the Classic agent it already had");
  });

  // The classic experience cannot be reached (neither the click path nor the preview address leads there): the shot is Needs you, nothing is built, and no picture is kept.
  await withTenant({ level: "scratch", previewUnavailable: true }, async ({ site, shoot, dir }) => {
    const result = await shoot(agentShot("f.classic.png", "standard"));
    assert.deepEqual([result.status, result.cause], ["needs-you", "harness-switch-failed"]);
    assert.match(result.error, /neither the click path nor the address copilotstudio\.preview\.microsoft\.com led to a classic page/);
    assert.equal(result.harness, undefined, "no harness is stamped on a picture that was not taken");
    assert.equal(site.practiceAgents().length, 0, "no practice agent was made in the wrong experience");
    assert.ok(!fs.existsSync(path.join(dir, "a", "f.classic.png")), "the picture was not saved");
  });
});
