// Which screenshots the computer takes by itself, and why the others need a person: the classification of five sample labs (before and after),
// every slot of the shared library, the fixed set of reasons, and the dry plan. Offline (no model, no Microsoft Learn, no browser).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { generateLab } from "../lib/lab-builder/generator.js";
import { getLabScreenshotsStatus } from "../lib/lab-builder/lab-screenshots.js";
import { buildLabJobPlan, buildLibraryJobPlan } from "../lib/capture/plan.js";
import { buildDryPlan, formatDryPlan } from "../lib/capture/dry-plan.js";
import { FAMILIES, REASONS, REASON_ORDER, describeReasonCounts } from "../../tools/screenshot-capture/automation.mjs";
import { sanitizeAutomation } from "../../tools/screenshot-capture/walkthrough.mjs";

const SETS = {
  standard: { features: ["create-agent", "agent-instructions", "knowledge-sharepoint", "generative-orchestration", "content-moderation", "evaluations", "connector-tools", "topics", "dlp-governance"], harness: "standard" },
  "microsoft-copilot": { features: ["mc-create-agent", "mc-instructions", "mc-knowledge", "mc-preview-test", "mc-publish-agent", "mc-evaluate", "mc-hooks", "mc-monitor"], harness: "microsoft-copilot" },
  "agent-builder": { products: ["m365-copilot-agent-builder"], features: ["dca-agent-builder-first-agent", "dca-write-agent-instructions", "dca-agent-builder-knowledge"] },
  "sharepoint-ai": { products: ["sharepoint-ai"], features: ["spai-build-agent-sharepoint-content", "spai-agent-sharepoint-knowledge-sources", "spai-share-agent-and-manage-access"] },
  foundry: { products: ["ai-foundry"], features: ["fdy-create-prompt-agent", "fdy-agent-file-search", "fdy-manage-quota"] },
};

const dirs = [];
const plans = {};
const tmp = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

before(async () => {
  const empty = tmp("automation-empty-");
  for (const [name, request] of Object.entries(SETS)) {
    const root = join(tmp("automation-lab-"), name);
    mkdirSync(root, { recursive: true });
    const build = await generateLab({ includeCore: false, ...request }, { outputRoot: root, labsDir: empty, useLearnMcp: false, useLlm: false });
    plans[name] = { root, labId: build.labId, plan: buildLabJobPlan({ generatedRoot: root, labId: build.labId, scope: { mode: "all" }, capturedDir: [empty], scratch: true, agentSource: "created", allowPractice: false }) };
  }
  plans.library = { plan: buildLibraryJobPlan({ scope: { mode: "all" }, capturedDir: [empty], scratch: true, agentSource: "created", allowPractice: false }) };
});

after(() => {
  for (const dir of dirs.reverse()) rmSync(dir, { recursive: true, force: true });
});

const tally = (shots, pick) => shots.reduce((map, s) => ((map[pick(s)] = (map[pick(s)] || 0) + 1), map), {});
const byName = (name) => Object.fromEntries(plans[name].plan.shots.map((s) => [s.filename, s.capture.automation]));

test("before and after: the planner still says how a shot is captured by address, and the automation says whether the computer takes it itself", () => {
  // [planner mode counts (unchanged), automatic, needs a person, reasons, recipe families]
  const expected = {
    standard: [{ auto: 9, guided: 15 }, 16, 8, { admin: 2, "build-first": 2, connection: 2, credits: 1, unseen: 1 }, { conversation: 5, dialog: 2, testset: 1 }],
    "microsoft-copilot": [{ auto: 4, guided: 7 }, 6, 5, { "build-first": 1, credits: 1, "real-users": 2, unseen: 1 }, { conversation: 2, dialog: 2 }],
    "agent-builder": [{ guided: 8 }, 0, 8, { "other-product": 8 }, {}],
    "sharepoint-ai": [{ guided: 6 }, 0, 6, { "other-product": 6 }, {}],
    foundry: [{ guided: 9 }, 2, 7, { "other-product": 7 }, { navigate: 2 }],
  };
  for (const [name, [modes, automatic, person, reasons, families]] of Object.entries(expected)) {
    const shots = plans[name].plan.shots;
    assert.deepEqual(tally(shots, (s) => s.capture.mode), modes, `${name}: the planner's own reading is unchanged`);
    assert.equal(shots.filter((s) => s.capture.automation.state === "automatic").length, automatic, `${name}: automatic`);
    assert.equal(shots.filter((s) => s.capture.automation.state === "person").length, person, `${name}: needs a person`);
    assert.deepEqual(tally(shots.filter((s) => s.capture.automation.reason), (s) => s.capture.automation.reason), reasons, `${name}: the reasons`);
    assert.deepEqual(tally(shots.filter((s) => s.capture.automation.family), (s) => s.capture.automation.family), families, `${name}: the recipe families`);
  }
  // Across the five labs: 45 of the 58 shots were "guided" (what the Screenshot Center showed as needing a person); now 24 run automatically.
  // (One Foundry shot names navigation labels but no step reaches its screen, so it is left to a person instead of being photographed from the start page.)
  const all = Object.keys(expected).flatMap((name) => plans[name].plan.shots);
  assert.deepEqual([all.length, all.filter((s) => s.capture.mode === "guided").length, all.filter((s) => s.capture.automation.state === "automatic").length], [58, 45, 24]);
});

test("the shots that were conservative are now taken by a family, and each one says how it is judged", () => {
  const standard = byName("standard");
  const pick = (a) => [a.state, a.family, a.panel || a.opener || null, a.verified, a.review];
  assert.deepEqual(pick(standard["test-pane-in-scope.png"]), ["automatic", "conversation", null, true, "never"], "a plain question and its answer was proven on a real tenant");
  assert.deepEqual(pick(standard["activity-map-plan.png"]), ["automatic", "conversation", "activity-map", false, "landmark"], "the activity map is checked by its own label");
  assert.deepEqual(pick(standard["knowledge-answer-citation.png"]), ["automatic", "conversation", "citation", false, "always"], "a citation cannot be checked by the computer, so every picture is saved for a person");
  assert.deepEqual(pick(standard["guardrail-refusal.png"]), ["automatic", "conversation", "refusal", false, "always"]);
  assert.equal(standard["activity-map-plan.png"].landmarks[0], "Activity map");
  assert.deepEqual(pick(standard["knowledge-sharepoint-add.png"]).slice(0, 3), ["automatic", "dialog", "knowledge"]);
  assert.deepEqual([standard["eval-test-set.png"].family, standard["eval-test-set.png"].objects], ["testset", ["evaluation-test-set"]], "the one object a recipe may add to the practice agent");
  const mc = byName("microsoft-copilot");
  assert.deepEqual(pick(mc["mc-preview-test-trace.png"]).slice(0, 3), ["automatic", "conversation", "trace"]);
  assert.deepEqual(pick(mc["mc-publish-agent-dialog.png"]).slice(0, 3), ["automatic", "dialog", "publish"]);
  for (const a of Object.values({ ...standard, ...mc }).filter((x) => x.family)) assert.ok(FAMILIES[a.family] && a.maxTier <= (a.family === "testset" ? 2 : 1), "no family may do more than its ceiling");
});

test("what stays with a person says one reason from the fixed set, in plain words, with the exact steps", () => {
  const standard = byName("standard");
  assert.equal(standard["eval-results.png"].reason, "credits");
  assert.equal(standard["tool-test-result.png"].reason, "connection");
  assert.equal(standard["trigger-phrases.png"].reason, "build-first", "a topic built on the authoring canvas is built by a person");
  assert.equal(byName("microsoft-copilot")["mc-monitor-sessions.png"].reason, "real-users", "sessions appear only after real people use a published agent");
  for (const name of Object.keys(SETS)) {
    for (const shot of plans[name].plan.shots.filter((s) => s.capture.automation.state === "person")) {
      const a = shot.capture.automation;
      assert.ok(REASONS[a.reason], `${shot.filename} has a reason from the fixed set`);
      assert.equal(a.reasonLabel, REASONS[a.reason].label);
      assert.ok(a.why.length > 40 && a.manual.length >= 2, `${shot.filename} says why and what to do`);
      assert.doesNotMatch(JSON.stringify(a), /https?:|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i, "no address or id");
    }
  }
  assert.deepEqual([...REASON_ORDER].sort(), Object.keys(REASONS).sort(), "every reason has a place in the summary");
  assert.equal(describeReasonCounts(["admin", "admin", "other-product", "connection", "made-up"]), "2 admin screens, 1 other product, 1 connection, 1 screen not seen in the product yet");
});

test("every slot of the shared library is either taken by the computer or left to a person for one known reason", () => {
  const shots = plans.library.plan.shots;
  assert.ok(shots.length >= 300, "the library has its slots");
  for (const shot of shots) {
    const a = shot.capture.automation;
    assert.ok(a && ["automatic", "person"].includes(a.state), shot.filename);
    if (a.state === "person") assert.ok(REASONS[a.reason], `${shot.filename}: ${a.reason}`);
    else assert.equal(a.reason, null);
  }
  const person = shots.filter((s) => s.capture.automation.state === "person").length;
  const automatic = shots.length - person;
  assert.ok(automatic >= 60 && person >= 200, `a mix of both: ${automatic} automatic, ${person} need a person`);
  // A plan from a portal that does not know the field is read the old way: a descriptor that does not fit is dropped, not guessed.
  assert.equal(sanitizeAutomation({ state: "maybe" }), null);
  assert.equal(sanitizeAutomation({ state: "person", reason: "made-up" }).reason, "unseen");
  assert.equal(sanitizeAutomation({ state: "automatic", family: "made-up" }).family, null);
});

test("the dry plan lists the order, the recipes, what is added to the practice agent, and what stays manual, and changes nothing", () => {
  const dry = buildDryPlan(plans.standard.plan);
  assert.deepEqual([dry.totals.total, dry.totals.automatic, dry.totals.needYou], [24, 16, 8]);
  assert.ok(dry.automatic.every((s, i) => s.order === i + 1), "in the order the lab builds the agent");
  assert.deepEqual(dry.objects.map((o) => [o.id, o.shots]), [["evaluation-test-set", ["eval-test-set.png"]]], "the practice agent gets one test set, for the one screenshot that shows it");
  assert.equal(dry.totals.unverified, dry.automatic.filter((s) => s.family && !s.verified).length);
  assert.match(dry.summary, /^8 need you: 2 admin screens, 2 connections, 1 Copilot Credits run, 2 screens that need something built first, 1 screen not seen in the product yet$/);
  assert.ok(dry.manual.every((m) => m.reasonLabel && m.steps.length));
  const text = formatDryPlan(dry);
  assert.match(text, /Runs automatically, in this order:/);
  assert.match(text, /Added to the practice agent for these screenshots:\n {2}- One evaluation test set/);
  assert.match(text, /Stays with a person:/);
  assert.doesNotMatch(JSON.stringify(dry) + text, /https?:\/\/|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}/i, "nothing that identifies a tenant");
});

test("the dry plan command prints the same plan for a generated lab without a browser or a portal", () => {
  const { root, labId } = plans.standard;
  const script = resolve(fileURLToPath(new URL("../../tools/lab-builder/dry-plan.mjs", import.meta.url)));
  const text = execFileSync(process.execPath, [script, root, labId, "--all"], { encoding: "utf8", env: { ...process.env, LAB_BUILDER_LLM: "off" } });
  assert.match(text, /^Dry plan: /);
  assert.match(text, /16 of 24 screenshots run automatically/);
  const json = JSON.parse(execFileSync(process.execPath, [script, root, labId, "--all", "--json"], { encoding: "utf8", env: { ...process.env, LAB_BUILDER_LLM: "off" } }));
  assert.deepEqual([json.totals.automatic, json.totals.needYou], [16, 8]);
});

test("the Screenshot Center's lab status carries the same reading as the plan, so each card shows its reason", () => {
  const { root, labId, plan } = plans.standard;
  const empty = tmp("automation-status-empty-");
  const status = getLabScreenshotsStatus(root, labId, { capturedDir: [empty] }).body;
  const fromStatus = Object.fromEntries(status.shots.map((s) => [s.filename, s.capture.automation]));
  for (const shot of plan.shots) {
    const a = fromStatus[shot.filename];
    assert.ok(a && ["automatic", "person"].includes(a.state), `${shot.filename} has an automation reading`);
    assert.equal(a.state, shot.capture.automation.state, `${shot.filename}: the card and the plan agree`);
    assert.equal(a.reason, shot.capture.automation.reason, shot.filename);
    assert.equal(a.family, shot.capture.automation.family, shot.filename);
  }
  assert.equal(fromStatus["eval-results.png"].reason, "credits");
  assert.equal(fromStatus["eval-results.png"].reasonLabel, "Needs Copilot Credits");
  assert.ok(fromStatus["eval-results.png"].manual.length >= 2, "the exact manual steps travel with the status");
  assert.doesNotMatch(JSON.stringify(status.shots.map((s) => s.capture)), /https?:\/\/|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}/i, "nothing that identifies a tenant");
});
