// Real-browser proof that the practice agent is made per harness: a Classic agent (made inside the classic experience, after the switch) for a Standard
// (Classic) picture and a Microsoft Copilot agent (made in the default experience) for a Microsoft Copilot picture, each proven by its landmarks, each
// recorded under its harness, never reused for the other, and an agent recorded before harnesses were recorded is never reused for either.
// It runs against the pretend Copilot Studio in `harnessMode`. Each test skips itself when no browser is installed.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createCaptureSession, runCaptureShot } from "../capture-run.mjs";
import { resolveAutonomy } from "../guard.mjs";
import { detectBrowserAvailability, loadPlaywrightModule, verifyCapturedImageBuffer } from "../lab-runner.mjs";
import { createPracticeRegistry } from "../practice.mjs";
import { FAKE_PRACTICE_ENV_ID, FAKE_PRACTICE_ENV_URL, createFakeProductSite } from "./fixtures/fake-product-site.mjs";

const found = await detectBrowserAvailability();
const playwright = found.playwrightInstalled ? await loadPlaywrightModule() : null;
const skip = !found.available && "Playwright with Chromium is not installed";

const gateOk = () => ({ failed: null, async ensureSignedIn() { return { ok: true }; } });
const real = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const CONTEXT = { labTitle: "Team Assistant", key: "lab-a", questions: ["What can you help me with?"] };

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
  const site = createFakeProductSite({ harnessMode: true, experienceDecides: false, defaultDelayMs: 40, chatDelayMs: 80, ...options });
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
    const session = createCaptureSession({ autonomy, registry, home, agentSource: "created", writeGapMs: 0, effectMs: 2500, findMs: 4000, landmarkMs: 4000, landmarkSettleMs: 150, promptMs: 1200 });
    const shoot = (shot) =>
      runCaptureShot({
        page,
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
    await fn({ site, registry, session, shoot, lines, dir });
  } finally {
    await browser.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const practiceAgents = (site) => site.practiceAgents().map((a) => ({ name: a.name, harness: a.harness }));

test("built from scratch, a Microsoft Copilot picture and a Standard picture each get their own practice agent: distinct, within 30 characters, made in the right experience, proven, and recorded by harness", { skip, timeout: 300_000 }, async () => {
  await withTenant({ level: "scratch" }, async ({ site, registry, shoot, lines }) => {
    const copilot = await shoot(agentShot("agent.copilot.png", "microsoft-copilot"));
    assert.equal(copilot.status, "captured", copilot.error);
    assert.equal(site.stats.classicClicks, 0, "the Microsoft Copilot agent was made without any switch");
    assert.equal(copilot.harness.id, "microsoft-copilot");
    assert.deepEqual(practiceAgents(site), [{ name: "Copilot shots - Team Assistant", harness: "microsoft-copilot" }]);

    const classic = await shoot(agentShot("agent.classic.png", "standard"));
    assert.equal(classic.status, "captured", classic.error);
    assert.equal(site.stats.classicClicks, 1, "the Classic agent was made after the switch");
    assert.equal(site.stats.feedbackSubmits, 0);
    assert.equal(classic.harness.id, "standard");
    assert.equal(classic.harness.switched, true);
    const made = practiceAgents(site);
    assert.deepEqual(made, [
      { name: "Copilot shots - Team Assistant", harness: "microsoft-copilot" },
      { name: "Classic shots - Team Assistant", harness: "standard" },
    ]);
    assert.ok(made.every((a) => a.name.length <= 30) && new Set(made.map((a) => a.name)).size === 2, "distinct names within the 30 characters the product keeps");

    // The registry looks agents up by environment, lab, and harness, and records the harness each agent was proven to be in.
    const envId = FAKE_PRACTICE_ENV_ID;
    assert.equal(registry.find(envId, "lab-a", "standard").name, "Classic shots - Team Assistant");
    assert.equal(registry.find(envId, "lab-a", "microsoft-copilot").name, "Copilot shots - Team Assistant");
    assert.equal(registry.find(envId, "lab-a", "customer-conversation"), null);
    assert.equal(registry.items().agents.length, 2);

    // Each slot gets the agent of its own harness, again and again: nothing more is created.
    const again = await shoot(agentShot("agent2.copilot.png", "microsoft-copilot"));
    assert.equal(again.status, "captured", again.error);
    assert.equal(site.practiceAgents().length, 2, "the Microsoft Copilot slot used its own agent, and made no third one");
    assert.equal(again.detail.practice.harness, "microsoft-copilot");
    assert.equal(site.stats.classicClicks, 1, "going back to a Microsoft Copilot picture did not switch anything");
    assert.match(lines.join("\n"), /Switching to the classic experience: ellipsis in the lower left corner > Open classic experience > Skip feedback/);
    assert.deepEqual(site.stats.dangers, []);
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
    assert.deepEqual(practiceAgents(site).filter((a) => a.name !== legacy.name), [{ name: "Copilot shots - Team Assistant", harness: "microsoft-copilot" }]);
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

test("one job with both harnesses, one harness after the other: the classic switch is made once, the default experience is opened again once, two practice agents are made, each picture carries the harness it was proven in, and a page still in the wrong harness after the switch is Needs you", { skip, timeout: 420_000 }, async () => {
  await withTenant({ level: "scratch" }, async ({ site, registry, shoot, lines }) => {
    // The plan gives all the Standard shots, then all the Microsoft Copilot shots (the creation step first inside each).
    const first = await shoot(agentShot("a.classic.png", "standard"));
    const second = await shoot(agentShot("b.classic.png", "standard"));
    assert.deepEqual([first.status, second.status], ["captured", "captured"], first.error || second.error);
    assert.deepEqual([first.harness.id, second.harness.id], ["standard", "standard"]);
    assert.equal(site.stats.classicClicks, 1, "the switch to the classic experience was made once for both Standard shots");
    assert.equal(first.harness.switched, true);
    assert.equal(site.experience.classic, true);
    assert.doesNotMatch(lines.join("\n"), /Changing experience/, "no return to the default experience before the Microsoft Copilot part");

    const third = await shoot(agentShot("c.copilot.png", "microsoft-copilot"));
    const fourth = await shoot(agentShot("d.copilot.png", "microsoft-copilot"));
    assert.deepEqual([third.status, fourth.status], ["captured", "captured"], third.error || fourth.error);
    assert.deepEqual([third.harness.id, fourth.harness.id], ["microsoft-copilot", "microsoft-copilot"]);
    assert.equal(third.harness.switched, false, "a Microsoft Copilot picture is never marked as switched");
    assert.equal(site.experience.classic, false, "the session is back in the default experience");
    assert.equal(site.stats.classicClicks, 1, "going back to the default experience clicked nothing in the classic one");
    const text = lines.join("\n");
    assert.equal((text.match(/Switching to the classic experience:/g) || []).length, 1);
    assert.equal((text.match(/Changing experience: going back to the default experience/g) || []).length, 1, "one return to the default experience");
    assert.match(text, /Proved the Microsoft Copilot harness: Build, Preview, Evaluate, Monitor/);

    // Two practice agents inside the same job, each proven in its own experience and neither used for the other.
    assert.deepEqual(practiceAgents(site), [
      { name: "Classic shots - Team Assistant", harness: "standard" },
      { name: "Copilot shots - Team Assistant", harness: "microsoft-copilot" },
    ]);
    assert.deepEqual(registry.items().agents.map((a) => a.harness), ["standard", "microsoft-copilot"]);
    assert.deepEqual([first, second, third, fourth].map((r) => r.detail.practice.harness), ["standard", "standard", "microsoft-copilot", "microsoft-copilot"]);

    // A plan that goes back to the first harness switches again, only because the session was left in the default experience.
    const back = await shoot(agentShot("e.classic.png", "standard"));
    assert.equal(back.status, "captured", back.error);
    assert.equal(back.harness.id, "standard");
    assert.equal(site.stats.classicClicks, 2, "an interleaved Standard shot switched again, proved again");
    assert.equal(site.practiceAgents().length, 2, "and used the Classic agent it already had");
  });

  // The switch did nothing: the page is still in the Microsoft Copilot harness, the shot is Needs you, nothing is built, and no picture is kept.
  await withTenant({ level: "scratch", switchBroken: true }, async ({ site, shoot, dir }) => {
    const result = await shoot(agentShot("f.classic.png", "standard"));
    assert.deepEqual([result.status, result.cause], ["needs-you", "wrong-harness"]);
    assert.match(result.error, /This agent is in the Microsoft Copilot harness; this picture needs the Standard \(Classic\) harness\./);
    assert.equal(result.harness, undefined, "no harness is stamped on a picture that was not taken");
    assert.equal(site.practiceAgents().length, 0, "no practice agent was made in the wrong experience");
    assert.ok(!fs.existsSync(path.join(dir, "a", "f.classic.png")), "the picture was not saved");
  });
});
