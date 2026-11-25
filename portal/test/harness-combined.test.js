/**
 * A lab that covers both harnesses one after another ("Both, one after another") and the screenshot harness rules: every picture is taken in the
 * harness of the part it sits in (a shared topic in the first harness), the two are never crossed, the "pictures from both harnesses" warning
 * does not fire for it, lab-gate checks each part against its own harness, and the capture plan runs one harness at a time with one practice
 * agent per harness. Offline, with synthetic pictures and throwaway folders.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateLab } from "../lib/lab-builder/generator.js";
import { getLabScreenshotsStatus, writeLabVerificationRecord } from "../lib/lab-builder/lab-screenshots.js";
import { scanLabDirectory } from "../lib/lab-builder/lab-gate.js";
import { featureLabHarness, labHarnessInfo, labHarnessSummary } from "../lib/lab-builder/lab-harness.js";
import { createCapturePlatform } from "../lib/capture/index.js";
import { buildDryPlan, formatDryPlan } from "../lib/capture/dry-plan.js";
import { buildLabChecklist } from "../lib/capture/checklist.js";
import { buildLabJobPlan } from "../lib/capture/plan.js";
import { sha256Hex } from "../lib/capture/library-share.js";
import { makePng } from "../../tools/screenshot-capture/test/fixtures/png.mjs";
import * as H from "../../tools/screenshot-capture/harness.mjs";

process.env.LAB_BUILDER_LINK_CHECK = "off";

const MIXED = ["create-agent", "mc-create-agent", "knowledge-sharepoint", "mc-knowledge", "dlp-governance", "mc-harness-choice"];
const cleanups = [];
const ctx = {};

function tmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const png = (seed) => makePng({ mode: "ui", seed });
const proof = (id) => ({ version: 1, id, proof: "landmarks", landmarks: id === "standard" ? ["Overview", "Knowledge", "Topics"] : ["Build", "Preview", "Evaluate", "Monitor"], switched: id === "standard", wanted: id });

before(async () => {
  ctx.storage = tmp("harness-combined-");
  ctx.generatedRoot = join(ctx.storage, "generated-labs");
  ctx.dataDir = join(ctx.storage, "data");
  ctx.libDir = join(ctx.storage, "screenshots");
  ctx.emptyLabs = tmp("harness-combined-empty-");
  ctx.noLibrary = tmp("harness-combined-nolib-");
  mkdirSync(ctx.generatedRoot, { recursive: true });
  ctx.platform = createCapturePlatform({ generatedRoot: ctx.generatedRoot, dataDir: ctx.dataDir, env: { PORTAL_STORAGE_ROOT: ctx.storage }, detectServerBrowser: async () => ({ available: false }) });
  ctx.store = ctx.platform.screenshots;
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

async function newCombinedLab(order = undefined) {
  const build = await generateLab(
    { products: ["copilot-studio"], features: MIXED, harnessMode: "both", ...(order ? { harnesses: order } : {}), includeCore: false },
    { outputRoot: ctx.generatedRoot, labsDir: ctx.emptyLabs, useLearnMcp: false, useLlm: false },
  );
  const read = (rel) => JSON.parse(readFileSync(join(build.outputDir, rel), "utf8"));
  return { labId: build.labId, labDir: build.outputDir, manifest: read("manifest.json"), plan: read(join("screenshots", "shots.json")), legacy: build.shots?.shots || [], result: build };
}

const status = (labId) => getLabScreenshotsStatus(ctx.generatedRoot, labId, { capturedDir: [ctx.noLibrary] }).body;
const planOf = (labId, extra = {}) => buildLabJobPlan({ generatedRoot: ctx.generatedRoot, labId, scope: { mode: "all", filenames: [], featureIds: [] }, capturedDir: [ctx.noLibrary], scratch: true, agentSource: "created", ...extra });

/** A real-looking picture saved in a lab's own assets and checked as taken in `harness` (what a stamped capture leaves behind). */
function placePicture(lab, filename, harness, seed) {
  const bytes = png(seed);
  writeFileSync(join(lab.labDir, "assets", filename), bytes);
  writeLabVerificationRecord(lab.labDir, filename, { ok: true, level: "pass", state: "accepted", sha256: sha256Hex(bytes), harness: { id: harness, proof: "landmarks", at: "2026-01-01T00:00:00.000Z" } });
}

test("each picture of a combined lab needs the harness of its section, and a shared topic is taken in the first harness", async () => {
  const lab = await newCombinedLab();
  assert.equal(lab.manifest.labHarness, null, "a combined lab has no single harness");
  assert.deepEqual([lab.plan.harnessMode, lab.plan.harnesses], ["both", ["standard", "microsoft-copilot"]]);
  assert.equal(lab.plan.harnessInfo.mode, "both");
  assert.equal(lab.plan.harnessInfo.id, null);
  assert.match(lab.plan.harnessInfo.statement, /both harnesses, one after another \(Standard \(Classic\) harness first, then Microsoft Copilot harness\)/);

  const byFeature = (id) => lab.plan.shots.filter((s) => s.feature === id);
  for (const s of byFeature("create-agent")) assert.deepEqual([s.harness, s.harnessScope, s.harnessPart], ["standard", "harness", "standard"], s.filename);
  for (const s of byFeature("mc-create-agent")) assert.deepEqual([s.harness, s.harnessScope, s.harnessPart], ["microsoft-copilot", "harness", "microsoft-copilot"], s.filename);
  const shared = byFeature("mc-harness-choice");
  assert.ok(shared.length > 0);
  for (const s of shared) {
    assert.deepEqual([s.harness, s.harnessScope, s.harnessNote], ["standard", "shared", "Works in either harness"], `${s.filename} is taken in the first harness`);
    assert.deepEqual(s.harnesses, ["standard", "microsoft-copilot"]);
    assert.equal(s.harnessGap, undefined);
  }
  assert.ok(lab.plan.shots.every((s) => !s.harnessGap), "no module of a combined lab is written for another harness than its part");

  // The saved list of slots keeps main's rule (a shared slot has no harness of its own) and says what its picture is taken in.
  const legacyShared = lab.legacy.filter((s) => s.feature === "mc-harness-choice");
  assert.ok(legacyShared.every((s) => s.harness === null && s.harnessScope === "shared" && s.captureHarness === "standard"));
  assert.ok(lab.legacy.filter((s) => s.feature === "mc-create-agent").every((s) => s.harness === "microsoft-copilot"));

  // The harness is read from the section, never from the catalog tags: a plan feature's `harness` is the tag list.
  assert.equal(featureLabHarness({ harnessMode: "both", harnesses: ["standard", "microsoft-copilot"] }, { id: "x", harnessPart: "microsoft-copilot", harness: ["standard"] }), "microsoft-copilot");
  assert.equal(featureLabHarness({ harnessMode: "both", harnesses: ["microsoft-copilot", "standard"] }, { id: "x", harnessPart: "shared" }), "microsoft-copilot", "the order decides the shared topics' harness");
  assert.equal(featureLabHarness({ harness: "standard" }, { id: "x" }), "standard", "a single-harness lab is unchanged");

  const list = readFileSync(join(lab.labDir, "SHOTLIST.md"), "utf8");
  assert.match(list, /This lab: both harnesses, one after another/);
  assert.match(list, /\*\*Harness:\*\* Microsoft Copilot harness/);
  assert.match(list, /\*\*Harness:\*\* Standard \(Classic\) harness/);
});

test("the Screenshot Center status states both harnesses, labels every slot with its part, and never warns that the lab is mixed", async () => {
  const lab = await newCombinedLab();
  placePicture(lab, "agent-overview.png", "standard", 11);
  placePicture(lab, "mc-create-agent-build.png", "microsoft-copilot", 12);
  const s = status(lab.labId);
  assert.equal(s.harness, null);
  assert.equal(s.harnessInfo.mode, "both");
  assert.equal(s.harnessSummary.combined, true);
  assert.deepEqual(s.harnessSummary.order, ["standard", "microsoft-copilot"]);
  assert.match(s.harnessSummary.statement, /both harnesses, one after another/);
  assert.equal(s.harnessSummary.mixed, false, "both harnesses are expected in a combined lab");
  assert.equal(s.harnessSummary.mixedMessage, "");
  assert.equal(s.harnessSummary.wrong, 0);
  assert.deepEqual(s.harnessSummary.harnessesSeen.sort(), ["microsoft-copilot", "standard"]);
  const row = (name) => s.shots.find((x) => x.filename === name);
  assert.deepEqual([row("agent-overview.png").harness, row("agent-overview.png").harnessState, row("agent-overview.png").harnessPart], ["standard", "ok", "standard"]);
  assert.deepEqual([row("mc-create-agent-build.png").harness, row("mc-create-agent-build.png").harnessState, row("mc-create-agent-build.png").harnessPart], ["microsoft-copilot", "ok", "microsoft-copilot"]);
  const parts = Object.fromEntries(s.harnessSummary.parts.map((p) => [p.harness, p]));
  assert.ok(parts.standard.shots > 0 && parts["microsoft-copilot"].shots > 0);
  assert.equal(parts.standard.taken, 1);
  assert.equal(parts["microsoft-copilot"].taken, 1);
  const sharedRow = s.shots.find((x) => x.harnessScope === "shared");
  assert.deepEqual([sharedRow.harness, sharedRow.harnessNote], ["standard", "Works in either harness"]);
});

test("lab-gate checks each part against its own harness: no mixed warning for a correct lab, a gap for a picture in the wrong part", async () => {
  const lab = await newCombinedLab();
  placePicture(lab, "agent-overview.png", "standard", 21);
  placePicture(lab, "mc-create-agent-build.png", "microsoft-copilot", 22);
  const codes = () => scanLabDirectory(lab.labDir, { capturedDir: [ctx.noLibrary] }).findings.map((f) => f.code);
  assert.ok(!codes().includes("mixed-harness-pictures"), "a combined lab is meant to show both");
  assert.ok(!codes().includes("wrong-harness-picture"));
  assert.ok(!codes().includes("harness-gap"));

  // A Microsoft Copilot picture in a Standard part's slot is wrong, and so is a Standard picture in a Microsoft Copilot part's slot.
  const inPart = (harness) => lab.plan.shots.filter((s) => s.harnessScope === "harness" && s.harness === harness).map((s) => s.filename);
  const standardSlot = inPart("standard").find((f) => f !== "agent-overview.png");
  const copilotSlot = inPart("microsoft-copilot").find((f) => f !== "mc-create-agent-build.png");
  assert.ok(standardSlot && copilotSlot, "each part has a second slot");
  placePicture(lab, standardSlot, "microsoft-copilot", 23);
  placePicture(lab, copilotSlot, "standard", 24);
  const gate = scanLabDirectory(lab.labDir, { capturedDir: [ctx.noLibrary] });
  const wrong = gate.findings.find((f) => f.code === "wrong-harness-picture");
  assert.ok(wrong, "the pictures in the wrong part are flagged");
  assert.equal(wrong.severity, "gap");
  assert.equal(wrong.count, 2);
  assert.match(wrong.message, /different harness than the part they sit in/);
  assert.ok(!gate.findings.some((f) => f.code === "mixed-harness-pictures"));
  const s = status(lab.labId);
  assert.equal(s.shots.find((x) => x.filename === standardSlot).harnessState, "wrong-harness");
  assert.equal(s.shots.find((x) => x.filename === standardSlot).captured, false, "a picture of the other harness never fills the slot");
  assert.equal(s.shots.find((x) => x.filename === copilotSlot).harnessState, "wrong-harness");
  assert.equal(s.harnessSummary.wrong, 2);
  assert.equal(s.harnessSummary.mixed, false);

  // The same pictures in a lab for one harness are the "mixed" case it always was.
  const summary = labHarnessSummary("standard", [{ filename: "a.png", harnessState: "ok", pictureHarness: "standard" }, { filename: "b.png", harnessState: "wrong-harness", pictureHarness: "microsoft-copilot" }]);
  assert.equal(summary.mixed, true);
  assert.equal(labHarnessInfo(null, "saved", { order: ["standard", "microsoft-copilot"] }).mode, "both");
});

test("an upload is checked against the harness of the section it belongs to, in the same lab", async () => {
  const lab = await newCombinedLab();
  const target = ctx.store.lab(lab.labId);
  const upload = (filename, harness, seed) => {
    const slot = target.slot(filename);
    const evidence = { version: 2, finalUrl: "https://copilotstudio.microsoft.com/environments/00000000-0000-0000-0000-000000000000/bots", title: "Copilot Studio", visibleText: [...(slot.expectedLabels || []), "Settings"], redaction: { applied: true, masked: 2 }, capturedAt: new Date().toISOString(), executedSteps: 3, harness: proof(harness) };
    return ctx.store.submit(target, filename, png(seed), { evidence, source: "companion", defer: true, requireEvidence: true, requireRedaction: true, requireProof: true });
  };
  assert.equal(target.slot("agent-overview.png").harness, "standard");
  assert.equal(target.slot("mc-create-agent-build.png").harness, "microsoft-copilot");

  const crossed = upload("mc-create-agent-build.png", "standard", 31);
  assert.equal(crossed.status, 422);
  assert.match(crossed.body.message, /taken in the Standard \(Classic\) harness, but this screenshot needs the Microsoft Copilot harness/);
  const crossedBack = upload("agent-overview.png", "microsoft-copilot", 32);
  assert.equal(crossedBack.status, 422);
  assert.match(crossedBack.body.message, /taken in the Microsoft Copilot harness, but this screenshot needs the Standard \(Classic\) harness/);

  // The right harness in each part is accepted, and each picture is stamped with the harness it was proven in.
  const own = upload("agent-overview.png", "standard", 33);
  assert.ok([200, 202].includes(own.status), JSON.stringify(own.body).slice(0, 300));
  const ownCopilot = upload("mc-create-agent-build.png", "microsoft-copilot", 34);
  assert.ok([200, 202].includes(ownCopilot.status), JSON.stringify(ownCopilot.body).slice(0, 300));

  // A shared topic is taken in the first harness; the other harness's picture is not its picture.
  const sharedName = lab.plan.shots.find((s) => s.harnessScope === "shared").filename;
  assert.equal(target.slot(sharedName).harness, "standard");
  assert.equal(upload(sharedName, "microsoft-copilot", 35).status, 422);

  // The library keeps the picture of a harness-specific slot under the harness's name, so the two never share a file.
  assert.equal(H.libraryName("agent-overview.png", "standard"), "agent-overview.classic.png");
  assert.equal(H.libraryName("mc-create-agent-build.png", "microsoft-copilot"), "mc-create-agent-build.copilot.png");
});

test("the capture plan runs one harness at a time, one practice agent per harness, and the dry plan states the switch for each", async () => {
  const lab = await newCombinedLab();
  const plan = planOf(lab.labId);
  assert.equal(plan.status, 200);
  assert.equal(plan.labHarness.mode, "both");
  const harnesses = plan.shots.map((s) => s.harness);
  const firstCopilot = harnesses.indexOf("microsoft-copilot");
  assert.ok(firstCopilot > 0, "the first harness comes first");
  assert.ok(harnesses.slice(0, firstCopilot).every((h) => h === "standard"), "every Standard (Classic) slot, shared topics included, before any Microsoft Copilot slot");
  assert.ok(harnesses.slice(firstCopilot).every((h) => h === "microsoft-copilot"), "and the experience changes once");
  assert.ok(plan.shots.some((s) => s.filename === "agent-overview.png") && plan.shots.some((s) => s.filename === "mc-create-agent-build.png"));
  assert.ok(plan.shots[0].capture.agent?.creates || /create/.test(plan.shots[0].filename), "the creation step leads the first harness");
  const sharedPlanShot = plan.shots.find((s) => s.filename === lab.plan.shots.find((x) => x.harnessScope === "shared").filename);
  assert.deepEqual([sharedPlanShot.harness, sharedPlanShot.harnessScope, sharedPlanShot.harnessNote], ["standard", "shared", "Works in either harness"]);
  const list = buildLabChecklist({ generatedRoot: ctx.generatedRoot, labId: lab.labId, capturedDir: [ctx.noLibrary] });
  assert.equal(list.labHarness.mode, "both");
  assert.match(list.labHarness.statement, /both harnesses, one after another/);
  const sharedItem = [...list.computer, ...list.you].find((i) => i.filename === sharedPlanShot.filename);
  assert.deepEqual([sharedItem.harness, sharedItem.harnessScope], ["standard", "shared"]);

  const dry = buildDryPlan(plan);
  assert.equal(dry.labHarness.mode, "both");
  assert.deepEqual(dry.labHarness.order, ["standard", "microsoft-copilot"]);
  assert.equal(dry.experienceChanges, 1);
  assert.deepEqual(dry.practiceAgents.map((a) => a.harness), ["standard", "microsoft-copilot"]);
  assert.match(dry.practiceAgents[0].note, /made on the Agents list with More create options > Agent, Standard \(not yet seen working on a real tenant.*in the classic experience tab on copilotstudio\.preview\.microsoft\.com after the switch \(ellipsis in the lower left corner > Open classic experience > Skip feedback\)/);
  assert.match(dry.practiceAgents[1].note, /made on the Agents list with More create options > Agent, uses Copilot Credits \(not yet seen working on a real tenant.*in the default experience at copilotstudio\.microsoft\.com \(no switch\)/);
  const standardShot = dry.automatic.find((s) => s.harness === "standard" && s.filename === "agent-overview.png");
  const copilotShot = dry.automatic.find((s) => s.harness === "microsoft-copilot");
  assert.match(standardShot.switchStep, /^Switch: ellipsis in the lower left corner > Open classic experience > Skip feedback\. The click opens the classic experience in a new browser tab on copilotstudio\.preview\.microsoft\.com/);
  assert.match(copilotShot.switchStep, /^No switch: use copilotstudio\.microsoft\.com \(the default experience\) and an agent whose Agent harness column says Microsoft Copilot/);
  assert.match(standardShot.proof, /tab strip with Overview/);
  assert.match(copilotShot.proof, /Build, Preview, Evaluate, and Monitor/);

  const text = formatDryPlan(dry);
  assert.match(text, /This lab: both harnesses, one after another/);
  assert.match(text, /changes experience 1 time\./);
  assert.match(text, /Standard \(Classic\) harness practice agent/);
  assert.match(text, /Microsoft Copilot harness practice agent/);
  assert.doesNotMatch(text, /https?:\/\//, "a plan names no address");
});

test("the order of the two harnesses decides which is taken first, and a single-harness lab is unchanged", async () => {
  const reversed = await newCombinedLab(["microsoft-copilot", "standard"]);
  const plan = planOf(reversed.labId);
  const harnesses = plan.shots.map((s) => s.harness);
  assert.equal(harnesses[0], "microsoft-copilot");
  assert.equal(plan.shots.find((s) => s.filename === reversed.plan.shots.find((x) => x.harnessScope === "shared").filename).harness, "microsoft-copilot", "a shared topic is taken in the first harness of the order");
  assert.deepEqual(buildDryPlan(plan).practiceAgents.map((a) => a.harness), ["microsoft-copilot", "standard"]);

  const single = await generateLab({ products: ["copilot-studio"], features: ["create-agent", "knowledge-sharepoint"], harness: "standard", includeCore: false }, { outputRoot: ctx.generatedRoot, labsDir: ctx.emptyLabs, useLearnMcp: false, useLlm: false });
  const singlePlan = planOf(single.labId);
  assert.ok(singlePlan.shots.every((s) => s.harness === "standard"));
  assert.equal(singlePlan.labHarness.id, "standard");
  assert.equal(buildDryPlan(singlePlan).experienceChanges, 0);
  assert.deepEqual(buildDryPlan(singlePlan).practiceAgents.map((a) => a.harness), ["standard"]);
  assert.ok(existsSync(join(single.outputDir, "SHOTLIST.md")));
});
