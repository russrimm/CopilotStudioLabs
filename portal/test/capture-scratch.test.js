// The portal's half of "build the agent from scratch": the consent level, what a job carries (and what it never carries to the
// browser), the plan's order, an older companion, what comes back, and that no address or id is kept.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCapturePlatform, SCRATCH_MIN_COMPANION } from "../lib/capture/index.js";
import { autonomyFor, createConsentStore, describeConsent, validateConsent } from "../lib/capture/consent.js";
import { cleanScratch } from "../lib/capture/jobs.js";
import { knowledgeWebsite, readLabScratchContext, sampleInputsFromMarkdown, scenarioQuestions } from "../lib/capture/scratch-context.js";
import { generateLab } from "../lib/lab-builder/generator.js";

const ENV_ID = "Default-00000000-0000-0000-0000-000000000001";
const ENV_URL = `https://copilotstudio.microsoft.com/environments/${ENV_ID}/home`;
const AGENT_URL = `https://copilotstudio.microsoft.com/environments/${ENV_ID}/bots/00000000-0000-0000-0000-0000000000a1/overview`;
const cleanups = [];
const ctx = {};
const tmp = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

before(async () => {
  ctx.root = tmp("capture-scratch-");
  ctx.generatedRoot = join(ctx.root, "generated-labs");
  mkdirSync(ctx.generatedRoot, { recursive: true });
  const emptyLabs = tmp("capture-scratch-labs-");
  const build = await generateLab(
    { products: ["copilot-studio"], features: ["mc-create-agent", "mc-instructions", "mc-knowledge", "mc-preview-test", "mc-publish-agent", "mc-monitor", "mc-memory"], harness: "microsoft-copilot", includeCore: false },
    { outputRoot: ctx.generatedRoot, labsDir: emptyLabs, useLearnMcp: false, useLlm: false },
  );
  ctx.labId = build.labId;
  ctx.labDir = build.outputDir;
});

after(() => {
  for (const fn of cleanups.reverse()) {
    try {
      fn();
    } catch {
      /* best effort */
    }
  }
});

function platform(t) {
  const root = tmp("capture-scratch-p-");
  return createCapturePlatform({ generatedRoot: ctx.generatedRoot, env: { PORTAL_STORAGE_ROOT: root }, dataDir: root, detectServerBrowser: async () => ({ available: false }) });
}

const labJob = (extra = {}) => ({ target: { type: "lab", labId: ctx.labId }, scope: { mode: "all" }, options: { mode: "autonomous" }, ...extra });

test("the scratch consent level needs no address, takes an optional environment, and lists what is created and what is never done", () => {
  const plain = validateConsent({ consented: true, level: "scratch" });
  assert.equal(plain.ok, true);
  assert.deepEqual(plain.consent, { version: 1, consented: true, level: "scratch", practiceEnvironmentUrl: "" });
  const chosen = validateConsent({ consented: true, level: "scratch", practiceEnvironmentUrl: ENV_URL });
  assert.equal(chosen.consent.practiceEnvironmentUrl, `https://copilotstudio.microsoft.com/environments/${ENV_ID}`, "only the environment is kept");
  assert.equal(validateConsent({ consented: true, level: "scratch", practiceEnvironmentUrl: "https://example.com/environments/x/home" }).ok, false);
  assert.equal(validateConsent({ consented: "yes", level: "scratch" }).ok, false, "only a real yes counts");

  const shown = describeConsent({ ...plain.consent, consentedAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(shown.scratch, true);
  assert.ok(shown.rules.creates.length >= 5 && shown.rules.creates.some((line) => /Lab screenshots - /.test(line)), "the card lists exactly what is created");
  assert.ok(shown.rules.never.some((line) => /Publish to a channel/i.test(line)) && shown.rules.never.some((line) => /Touch any agent that is not its own/i.test(line)));
  assert.ok(!JSON.stringify(shown).includes(ENV_ID));
});

test("a request can ask for less than the scratch consent, an own agent downgrades it, and no consent means no autonomy", () => {
  const record = validateConsent({ consented: true, level: "scratch", practiceEnvironmentUrl: ENV_URL }).consent;
  assert.equal(autonomyFor(record).level, "scratch");
  assert.equal(autonomyFor(record, { level: "read-only" }).level, "read-only", "a request can lower it");
  assert.equal(autonomyFor(record, { agent: "existing" }).level, "read-only", "the person's own agent is looked at, never built over");
  assert.equal(autonomyFor(record, { agent: "existing" }).practiceEnvironmentUrl, "");
  assert.equal(autonomyFor(null, { level: "scratch" }), null);
  const store = createConsentStore({ dir: tmp("consent-") });
  store.put("default", record);
  assert.equal(store.get("default").level, "scratch");
});

test("a from-scratch job needs no agent address, carries the lab's own words to the companion only, and orders the shots by module", (t) => {
  const p = platform(t);
  assert.equal(p.saveConsent({ consented: true, level: "scratch" }).status, 200);
  const queued = p.queueJob(labJob());
  assert.equal(queued.status, 201, JSON.stringify(queued.body).slice(0, 300));
  assert.notEqual(queued.body.needsAddress, true, "the old prompt for an agent address is gone");
  assert.equal(queued.body.autonomy.level, "scratch");

  const browserView = JSON.stringify(queued.body) + JSON.stringify(p.jobs.get(queued.body.job.id));
  assert.ok(!browserView.includes("scratchContext"), "the lab's text for the agent is not in what the browser reads");
  assert.ok(!browserView.includes("Lab screenshots - "), "neither is the agent's name");

  const plan = p.jobs.getPlan(queued.body.job.id);
  assert.equal(plan.autonomy.level, "scratch");
  assert.match(plan.autonomy.scratchContext.agentName, /^Lab screenshots - .{1,12}$/);
  assert.ok(plan.autonomy.scratchContext.agentName.length <= 30, "the product keeps 30 characters of an agent's name");
  assert.ok(plan.autonomy.scratchContext.instructions.length > 20 && !/\n/.test(plan.autonomy.scratchContext.instructions), "the lab's instructions, on one line");
  assert.equal(plan.autonomy.startFresh, false);
  const modules = plan.shots.map((s) => Number(s.moduleOrder ?? 0));
  assert.deepEqual([...modules].sort((a, b) => a - b), modules, "shots run in the order of the lab's modules");
  assert.ok(plan.shots.every((s) => s.capture?.scratch), "every shot says what stage it belongs to");
  assert.ok(plan.shots.some((s) => s.capture.scratch.stage === "instructions") && plan.shots.some((s) => s.capture.scratch.stage === "knowledge"));
  p.jobs.cancel(queued.body.job.id);
});

test("a saved agent address still means the person's own agent, unless the request asks to build from scratch", (t) => {
  const p = platform(t);
  p.saveConsent({ consented: true, level: "scratch" });
  const own = p.queueJob(labJob({ targets: { copilotStudioAgentUrl: AGENT_URL } }));
  assert.equal(own.status, 201);
  assert.equal(own.body.autonomy.level, "read-only", "an agent the person gave is looked at, not built over");
  p.jobs.cancel(own.body.job.id);
  const scratch = p.queueJob(labJob({ targets: { copilotStudioAgentUrl: AGENT_URL }, options: { mode: "autonomous", agent: "scratch" } }));
  assert.equal(scratch.body.autonomy.level, "scratch");
  p.jobs.cancel(scratch.body.job.id);
  const fresh = p.queueJob(labJob({ options: { mode: "autonomous", startFresh: true } }));
  assert.equal(p.jobs.getPlan(fresh.body.job.id).autonomy.startFresh, true, "Start fresh travels in the plan");
  p.jobs.cancel(fresh.body.job.id);
});

test("an older companion is asked to update before anything is queued", (t) => {
  const p = platform(t);
  p.saveConsent({ consented: true, level: "scratch" });
  const code = p.pairing.createCode({ createdBy: "test" });
  const paired = p.pairing.exchangeCode(code.code, { deviceName: "OLD-PC", companionVersion: "1.5.0" });
  p.pairing.heartbeat(paired.device.id, { companionVersion: "1.5.0" });
  const old = p.queueJob(labJob());
  assert.equal(old.body.job, null);
  assert.deepEqual(old.body.needsNewerCompanion, { min: SCRATCH_MIN_COMPANION, version: "1.5.0" });
  assert.match(old.body.message, /cannot build the agent from scratch yet/);
  assert.equal(p.jobs.list().length, 0, "nothing is queued for a companion that cannot do it");
  p.pairing.heartbeat(paired.device.id, { companionVersion: SCRATCH_MIN_COMPANION });
  const ok = p.queueJob(labJob());
  assert.equal(ok.status, 201);
  p.jobs.cancel(ok.body.job.id);
});

test("what comes back about the practice agent keeps a name, a day, and the stages, and never an address or an id", () => {
  const kept = cleanScratch({ name: "Lab screenshots - Team https://copilotstudio.microsoft.com/environments/x/bots/y ada@contoso.com", createdAt: "2026-11-18", reused: true, environment: "set", stages: ["agent", "instructions", "bad stage!", "knowledge"], stopped: "Stopped at https://x.example.com/a" });
  assert.ok(!JSON.stringify(kept).includes("http") && !JSON.stringify(kept).includes("@"));
  assert.deepEqual(kept.stages, ["agent", "instructions", "knowledge"]);
  assert.equal(kept.reused, true);
  assert.equal(kept.environment, "set");
  assert.equal(cleanScratch({ createdAt: "yesterday" }).createdAt, undefined);
  assert.equal(cleanScratch("nonsense"), null);
});

test("the lab's own words are read from its Markdown and manifest, and a website must be public Microsoft documentation", () => {
  const md = readFileSync(join(ctx.labDir, "index.md"), "utf8");
  const context = readLabScratchContext(ctx.labDir, { labId: ctx.labId, title: "Team lab" });
  assert.ok(context.agentName.startsWith("Lab screenshots - "));
  assert.ok(context.instructions.length > 0);
  assert.equal(context.key.length > 0, true);
  assert.deepEqual(sampleInputsFromMarkdown("**Sample input.** Paste the instructions\n\n```text\nBe brief.\n```\n").map((s) => s.text), ["Be brief."]);
  assert.deepEqual(scenarioQuestions("**Questions the finished agent should answer**\n\n- “What is our leave policy?”\n- “Who approves travel?”\n\nNext"), ["What is our leave policy?", "Who approves travel?"]);
  assert.equal(knowledgeWebsite({ modules: [{ id: "knowledge", sources: [{ url: "https://example.com/a" }, { url: "https://learn.microsoft.com/microsoft-copilot-studio/knowledge-copilot-studio" }] }] }), "https://learn.microsoft.com/microsoft-copilot-studio/knowledge-copilot-studio");
  assert.equal(knowledgeWebsite({ modules: [{ id: "knowledge", sources: [{ url: "https://evil.example.com/a" }] }] }), "");
  assert.ok(md.length > 100);
});
