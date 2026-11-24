/**
 * A screenshot is a Standard (Classic) harness picture or a Microsoft Copilot harness picture, and the two are never mixed.
 *
 * The lab's harness is the authority: every Copilot Studio picture of a lab is taken in it. The shared library keeps a picture of a
 * harness-specific slot under a name that carries the harness; a picture from before harnesses were recorded is "Harness not recorded" and is
 * never reused for such a slot until a person tags it. Everything runs against throwaway folders with synthetic pictures.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { generateLab } from "../lib/lab-builder/generator.js";
import { resolveLabScreenshot, capturedImage } from "../lib/lab-builder/captured.js";
import { getLabScreenshotsStatus, writeLabVerificationRecord } from "../lib/lab-builder/lab-screenshots.js";
import { scanLabDirectory } from "../lib/lab-builder/lab-gate.js";
import { decorateGeneratedHtml } from "../lib/lab-builder/generated-labs.js";
import { pendingShotCardHtml } from "../lib/lab-builder/pending-shot-card.js";
import { validateScreenshotSlots } from "../lib/lab-builder/slots.js";
import { createCapturePlatform } from "../lib/capture/index.js";
import { buildLabChecklist, renderChecklistMarkdown } from "../lib/capture/checklist.js";
import { buildDryPlan, formatDryPlan } from "../lib/capture/dry-plan.js";
import { buildLabJobPlan, buildLibraryJobPlan, findLibrarySlot } from "../lib/capture/plan.js";
import { assessPictures, FLAGS } from "../lib/capture/picture-integrity.js";
import { sha256Hex, shareVerdict } from "../lib/capture/library-share.js";
import { buildLibraryExport, importLibraryZip } from "../lib/capture/library-transfer.js";
import { verifyImage } from "../../tools/screenshot-capture/image-verify.mjs";
import { makePng } from "../../tools/screenshot-capture/test/fixtures/png.mjs";
import * as H from "../../tools/screenshot-capture/harness.mjs";
import { shotHarness } from "../../tools/feature-tour/lib/shots.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "..", "..");
const cleanups = [];
const ctx = {};

function tmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const png = (seed) => makePng({ mode: "ui", seed });

async function newLab(features, harness, root = ctx.generatedRoot) {
  const build = await generateLab(
    { products: ["copilot-studio"], features, ...(harness ? { harness } : {}), includeCore: false },
    { outputRoot: root, labsDir: ctx.emptyLabs, useLearnMcp: false, useLlm: false },
  );
  const read = (rel) => JSON.parse(readFileSync(join(build.outputDir, rel), "utf8"));
  const plan = read(join("screenshots", "shots.json"));
  return { labId: build.labId, labDir: build.outputDir, plan, shots: plan.shots, files: plan.shots.map((s) => s.filename), manifest: read("manifest.json") };
}

/** What a current companion proves before it takes the picture. */
const proof = (id) => ({ version: 1, id, proof: "landmarks", landmarks: id === "standard" ? ["Overview", "Knowledge", "Topics"] : ["Build", "Preview", "Evaluate", "Monitor"], switched: id === "standard", wanted: id });

function evidenceFor(target, filename, harness = undefined) {
  const slot = target.slot(filename);
  return {
    version: 2,
    finalUrl: "https://copilotstudio.microsoft.com/environments/00000000-0000-0000-0000-000000000000/bots",
    title: "Copilot Studio",
    visibleText: [...(slot.expectedLabels || []), "Settings"],
    redaction: { applied: true, masked: 2 },
    capturedAt: new Date().toISOString(),
    executedSteps: 4,
    ...(harness ? { harness: proof(harness) } : {}),
  };
}

/** A capture the way the companion uploads one (needs a proof), or a person's upload by hand (no evidence at all). */
function capture(labId, filename, { seed = 1, harness = undefined, companion = true, store = ctx.store } = {}) {
  const target = store.lab(labId);
  const bytes = makePng({ mode: "ui", seed });
  const result = companion
    ? store.submit(target, filename, bytes, { evidence: evidenceFor(target, filename, harness), source: "companion", defer: true, requireEvidence: true, requireRedaction: true, requireProof: true })
    : store.submit(target, filename, bytes, { evidence: evidenceFor(target, filename), source: "manual-upload", defer: true, requireRedaction: true });
  return { ...result, bytes };
}

const libFile = (name) => join(ctx.libDir, name);
/** A library with nothing in it, for checks of what a lab's own pictures say (the shared library may hold a good picture for the slot). */
const emptyLibrary = (() => {
  const dir = mkdtempSync(join(tmpdir(), "harness-identity-nolib-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
})();
const libraryRecords = () => JSON.parse(readFileSync(join(ctx.dataDir, "capture", "library-verification.json"), "utf8"));
const status = (labId, libDir = ctx.libDir) => getLabScreenshotsStatus(ctx.generatedRoot, labId, { capturedDir: [libDir] }).body;
const row = (labId, filename, libDir = ctx.libDir) => status(labId, libDir).shots.find((s) => s.filename === filename);

before(() => {
  ctx.root = tmp("harness-identity-");
  ctx.storageRoot = join(ctx.root, "storage");
  ctx.generatedRoot = join(ctx.storageRoot, "generated-labs");
  ctx.dataDir = join(ctx.storageRoot, "data");
  ctx.libDir = join(ctx.storageRoot, "screenshots");
  ctx.emptyLabs = tmp("harness-identity-empty-labs-");
  mkdirSync(ctx.generatedRoot, { recursive: true });
  ctx.platform = createCapturePlatform({ generatedRoot: ctx.generatedRoot, dataDir: ctx.dataDir, env: { PORTAL_STORAGE_ROOT: ctx.storageRoot }, detectServerBrowser: async () => ({ available: false }) });
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

// ── The shared module ────────────────────────────────────────────────────────

test("the labels are plain text, a file name carries the harness, and a picture fits a slot only in its own harness", () => {
  assert.equal(H.harnessLabel("standard"), "Standard (Classic) harness");
  assert.equal(H.harnessLabel("microsoft-copilot"), "Microsoft Copilot harness");
  assert.equal(H.harnessLabel("customer-conversation"), "Customer Conversation harness (preview)");
  assert.equal(H.harnessLabel("either"), "Works in either harness");
  assert.equal(H.harnessLabel(null), "", "a product with no harnesses shows no label");
  assert.equal(H.harnessLabel("both"), "", "the catalog's group name is not a harness of a picture");
  assert.equal(H.pictureHarnessLabel(null), "Harness not recorded");
  for (const label of Object.values(H.HARNESS_LABELS)) assert.doesNotMatch(label, /[^\x20-\x7e]/, "no emoji or special character");

  assert.equal(H.taggedName("agent-overview.png", "standard"), "agent-overview.classic.png");
  assert.equal(H.taggedName("agent-overview.png", "microsoft-copilot"), "agent-overview.copilot.png");
  assert.equal(H.taggedName("agent-overview.classic.png", "standard"), "agent-overview.classic.png", "tagging twice changes nothing");
  assert.deepEqual(H.splitTaggedName("agent-overview.copilot.png"), { base: "agent-overview.png", harness: "microsoft-copilot" });
  assert.deepEqual(H.splitTaggedName("agent-overview.png"), { base: "agent-overview.png", harness: null });
  assert.equal(H.libraryName("x.png", "either"), "x.png");
  assert.equal(H.libraryName("x.png", null), "x.png");

  assert.equal(H.pictureFitsSlot("standard", "standard").ok, true);
  assert.equal(H.pictureFitsSlot("standard", "microsoft-copilot").code, "wrong-harness");
  assert.equal(H.pictureFitsSlot("microsoft-copilot", "standard").code, "wrong-harness");
  assert.equal(H.pictureFitsSlot("standard", null).code, "not-recorded", "a picture with no harness is never used for a harness-specific slot");
  assert.equal(H.pictureFitsSlot("either", null).ok, true);
  assert.equal(H.pictureFitsSlot(null, null).ok, true);
});

test("the lab's harness decides what a slot needs, a module written for another harness is a gap, and a feature for both has two library pictures", () => {
  assert.deepEqual(H.labSlotNeed({ labHarness: "standard" }), { id: "standard", source: "lab" });
  assert.equal(H.labSlotNeed({ labHarness: "microsoft-copilot" }).id, "microsoft-copilot");
  assert.deepEqual(H.labSlotNeed({}), { id: "standard", source: "default" });
  assert.equal(H.labSlotNeed({ product: "sharepoint-ai", labHarness: "standard" }).id, null, "a product with no harnesses has none");
  assert.deepEqual(H.harnessGapFor({ featureHarness: ["microsoft-copilot"], need: "standard" }), { feature: ["microsoft-copilot"], lab: "standard" });
  assert.equal(H.harnessGapFor({ featureHarness: ["standard", "microsoft-copilot"], need: "standard" }), null);
  assert.deepEqual(H.libraryVariants({ featureHarness: ["standard", "microsoft-copilot"] }), ["standard", "microsoft-copilot"]);
  assert.deepEqual(H.libraryVariants({ featureHarness: "both" }), ["standard", "microsoft-copilot"]);
  assert.deepEqual(H.libraryVariants({ featureHarness: ["customer-conversation"] }), ["customer-conversation"]);
  assert.deepEqual(H.libraryVariants({ product: "ai-foundry" }), [null]);
});

test("the harness is proven from tab and navigation names, and the plan says the owner's switch path and the proof", () => {
  assert.equal(H.harnessFromLandmarks({ tabs: ["Build", "Preview", "Evaluate", "Monitor"] }).harness, "microsoft-copilot");
  assert.equal(H.harnessFromLandmarks({ tabs: ["Build", "Preview", "Evaluate", "Deploy", "Monitor"] }).harness, "customer-conversation");
  assert.equal(H.harnessFromLandmarks({ nav: ["Overview", "Knowledge", "Topics"] }).harness, "standard");
  assert.equal(H.harnessFromLandmarks({ nav: ["Overview"] }), null, "Overview alone proves nothing");
  assert.equal(H.harnessFromLandmarks({ tabs: ["Build"] }), null);
  assert.equal(H.harnessFromPoweredBy("Microsoft Copilot"), "microsoft-copilot");
  assert.equal(H.harnessFromPoweredBy("Standard"), "standard");
  const standard = H.harnessPlan("standard");
  assert.equal(standard.switch, true);
  assert.match(standard.switchStep, /ellipsis in the lower left corner > Open classic experience > Skip feedback/);
  const copilot = H.harnessPlan("microsoft-copilot");
  assert.equal(copilot.switch, false);
  assert.match(copilot.switchStep, /copilotstudio\.microsoft\.com/);
  assert.equal(H.sanitizeHarnessProof(proof("standard")).id, "standard");
  assert.equal(H.sanitizeHarnessProof({ ...proof("standard"), proof: "guess" }), null, "only a landmark proof counts");
  assert.equal(H.sanitizeHarnessProof({ ...proof("standard"), landmarks: [] }), null);
});

// ── The lab records its harness, and every shot carries what it needs ───────

test("a lab says which harness it is built for, how that was decided, and every shot says what it needs (shots.json, manifest, SHOTLIST)", async () => {
  const chosen = await newLab(["create-agent"], "standard");
  assert.equal(chosen.plan.harness, "standard");
  assert.deepEqual({ id: chosen.plan.harnessInfo.id, label: chosen.plan.harnessInfo.label, source: chosen.plan.harnessInfo.source }, { id: "standard", label: "Standard (Classic) harness", source: "chosen" });
  assert.match(chosen.plan.harnessInfo.statement, /^This lab: Standard \(Classic\) harness\. Every picture is taken in the Classic harness\.$/);
  assert.deepEqual(chosen.manifest.labHarness, { id: "standard", label: "Standard (Classic) harness", source: "chosen" });
  for (const shot of chosen.shots) {
    assert.equal(shot.harness, "standard");
    assert.equal(shot.harnessLabel, "Standard (Classic) harness");
  }
  const list = readFileSync(join(chosen.labDir, "SHOTLIST.md"), "utf8");
  assert.match(list, /This lab: Standard \(Classic\) harness\. Every picture is taken in the Classic harness\./);
  assert.match(list, /- \*\*Harness:\*\* Standard \(Classic\) harness/);
  const legacy = JSON.parse(readFileSync(join(chosen.labDir, "shots.json"), "utf8"));
  assert.equal(legacy.harness, "standard");
  assert.equal(legacy.shots[0].harnessLabel, "Standard (Classic) harness");

  const copilot = await newLab(["mc-memory"], "microsoft-copilot");
  assert.equal(copilot.plan.harness, "microsoft-copilot");
  assert.ok(copilot.shots.every((s) => s.harness === "microsoft-copilot" && s.harnessLabel === "Microsoft Copilot harness"));

  // Nothing chosen: the harness is the one most of the lab's modules are written for, and the lab data says it was inferred.
  const inferred = await newLab(["mc-memory"], null);
  assert.equal(inferred.plan.harness, "microsoft-copilot");
  assert.equal(inferred.plan.harnessInfo.source, "inferred");
  assert.equal(inferred.manifest.labHarness.source, "inferred");
});

test("a module written for another harness is a gap in the lab, never a picture taken in the wrong harness", async () => {
  const lab = await newLab(["mc-memory"], "standard");
  assert.ok(lab.shots.every((s) => s.harness === "standard"), "the lab's harness decides");
  assert.ok(lab.shots.every((s) => s.harnessGap && s.harnessGap.lab === "standard" && s.harnessGap.feature.includes("microsoft-copilot")));
  const target = ctx.store.lab(lab.labId);
  const refused = ctx.store.submit(target, lab.files[0], png(3), { evidence: evidenceFor(target, lab.files[0], "standard"), source: "companion", requireEvidence: true, requireProof: true });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "harness-gap");
  assert.match(refused.body.message, /written for the Microsoft Copilot harness, but this lab is built for the Standard \(Classic\) harness/);
  const plan = buildLabJobPlan({ generatedRoot: ctx.generatedRoot, labId: lab.labId, scope: { mode: "all", filenames: [], featureIds: [] }, capturedDir: [ctx.libDir] });
  assert.ok(plan.shots.every((s) => s.harnessGap && /not|cannot|written for/.test(s.harnessGapNote)));
  assert.equal(status(lab.labId).harnessSummary.gaps, lab.files.length);
  const gate = scanLabDirectory(lab.labDir);
  assert.ok(gate.findings.some((f) => f.code === "harness-gap" && f.severity === "gap"), "lab-gate flags it");
});

test("a picture from a hand-written lab (written in the Classic experience) is never reused in a lab for another harness", async () => {
  const standard = await newLab(["create-agent"], "standard");
  const copilot = await newLab(["create-agent"], "microsoft-copilot");
  const size = (lab) => statSync(join(lab.labDir, "assets", "copilot-studio-home.png")).size;
  assert.ok(size(standard) > 10000, "a Standard lab keeps the hand-written lab's picture (it shows as Harness not recorded until a person tags it)");
  assert.ok(size(copilot) < 2000, "a Microsoft Copilot lab keeps the pending placeholder, to be taken in its own harness");
  assert.equal(status(standard.labId).shots.find((s) => s.filename === "copilot-studio-home.png").harnessState, "not-recorded");
});

test("the capture plan carries each shot's harness, the switch step and the proof; the dry plan states them per shot and per lab", async () => {
  const standard = await newLab(["create-agent"], "standard");
  const plan = buildLabJobPlan({ generatedRoot: ctx.generatedRoot, labId: standard.labId, scope: { mode: "all", filenames: [], featureIds: [] }, capturedDir: [ctx.libDir], scratch: true, agentSource: "created" });
  assert.equal(plan.labHarness.id, "standard");
  for (const shot of plan.shots) {
    assert.equal(shot.harness, "standard");
    assert.equal(shot.capture.harness.switch, true);
    assert.match(shot.capture.harness.switchStep, /ellipsis in the lower left corner > Open classic experience > Skip feedback/);
    assert.match(shot.capture.harness.proof, /Overview/);
  }
  const dry = buildDryPlan(plan);
  assert.equal(dry.labHarness.id, "standard");
  assert.match(dry.practiceAgentHarness, /Standard \(Classic\) harness practice agent, created inside the classic experience after the switch/);
  const text = formatDryPlan(dry);
  assert.match(text, /This lab: Standard \(Classic\) harness\. Every picture is taken in the Classic harness\./);
  assert.match(text, /harness: Standard \(Classic\) harness/);
  assert.match(text, /switch: ellipsis in the lower left corner > Open classic experience > Skip feedback/);
  assert.match(text, /proof landmark: Side navigation with Overview/);

  const copilot = await newLab(["mc-memory"], "microsoft-copilot");
  const copilotText = formatDryPlan(buildDryPlan(buildLabJobPlan({ generatedRoot: ctx.generatedRoot, labId: copilot.labId, scope: { mode: "all", filenames: [], featureIds: [] }, capturedDir: [ctx.libDir], scratch: true, agentSource: "created" })));
  assert.match(copilotText, /harness: Microsoft Copilot harness/);
  assert.match(copilotText, /no switch: open copilotstudio\.microsoft\.com /);
  assert.match(copilotText, /proof landmark: The Build, Preview, Evaluate, and Monitor tabs/);
  assert.doesNotMatch(copilotText, /Open classic experience > Skip feedback/, "a Microsoft Copilot picture never switches");

  const markdown = renderChecklistMarkdown(buildLabChecklist({ generatedRoot: ctx.generatedRoot, labId: standard.labId, capturedDir: [ctx.libDir] }));
  assert.match(markdown, /This lab: Standard \(Classic\) harness\./);
});

test("the shared library plan has one picture per harness for a feature written for both, under names that carry the harness", () => {
  const library = buildLibraryJobPlan({ scope: { mode: "all", filenames: [], featureIds: [] }, products: ["copilot-studio"], capturedDir: [ctx.libDir] });
  const rows = library.shots.filter((s) => s.slotFilename === "mc-harness-choice-home.png");
  assert.deepEqual(rows.map((s) => s.filename).sort(), ["mc-harness-choice-home.classic.png", "mc-harness-choice-home.copilot.png"]);
  assert.deepEqual(rows.map((s) => s.harness).sort(), ["microsoft-copilot", "standard"]);
  const single = library.shots.find((s) => s.slotFilename === "create-agent-describe.png");
  assert.equal(single.filename, "create-agent-describe.classic.png");
  assert.equal(single.harnessLabel, "Standard (Classic) harness");
  assert.ok(findLibrarySlot("create-agent-describe.classic.png"));
  assert.equal(findLibrarySlot("create-agent-describe.png"), null, "the plain name is no longer a slot: a picture saved under it has no harness recorded");
  const other = buildLibraryJobPlan({ scope: { mode: "all", filenames: [], featureIds: [] }, products: ["sharepoint-ai"], capturedDir: [] });
  assert.ok(other.shots.every((s) => s.harness === null && !/\.(?:classic|copilot|customer)\./.test(s.filename)), "a product with no harnesses keeps plain names and no harness");
});

// ── Never mix ────────────────────────────────────────────────────────────────

test("a Classic picture never satisfies a Microsoft Copilot slot and the reverse, in the library and in labs", async () => {
  const slot = "mc-harness-choice-home.png";
  const standardLab = await newLab(["mc-harness-choice"], "standard");
  const copilotLab = await newLab(["mc-harness-choice"], "microsoft-copilot");
  assert.ok(standardLab.files.includes(slot));
  assert.equal(row(standardLab.labId, slot).harness, "standard");
  assert.equal(row(copilotLab.labId, slot).harness, "microsoft-copilot");

  const taken = capture(standardLab.labId, slot, { seed: 41, harness: "standard" });
  assert.equal(taken.status, 200, JSON.stringify(taken.body));
  assert.equal(taken.body.library.outcome, "shared");
  assert.ok(existsSync(libFile("mc-harness-choice-home.classic.png")), "saved under the harness's name");
  assert.equal(existsSync(libFile(slot)), false, "never under the plain name");
  const record = libraryRecords().shots["mc-harness-choice-home.classic.png"];
  assert.equal(record.harness.id, "standard");
  assert.equal(record.harness.proof, "landmarks", "the companion proved it, nobody assumed it");

  // The Microsoft Copilot lab does not get it, and neither does a lab built later.
  assert.equal(row(copilotLab.labId, slot).captured, false);
  assert.equal(resolveLabScreenshot(copilotLab.labDir, slot, { capturedDir: [ctx.libDir] }), null);
  assert.ok(resolveLabScreenshot(standardLab.labDir, slot, { capturedDir: [ctx.libDir] }));
  assert.equal(capturedImage([ctx.libDir], slot, { harness: "microsoft-copilot" }), null);
  const later = await newLab(["mc-harness-choice"], "microsoft-copilot");
  assert.equal(existsSync(join(later.labDir, "assets", slot)) && capturedImage(join(later.labDir, "assets"), slot) !== null, false, "a new Microsoft Copilot lab copies nothing from the Classic picture");
  const reverse = capture(copilotLab.labId, slot, { seed: 42, harness: "microsoft-copilot" });
  assert.equal(reverse.status, 200);
  assert.ok(existsSync(libFile("mc-harness-choice-home.copilot.png")));
  assert.notDeepEqual(readFileSync(libFile("mc-harness-choice-home.classic.png")), readFileSync(libFile("mc-harness-choice-home.copilot.png")), "two pictures side by side");
  assert.equal(ctx.store.libraryState().shots.filter((s) => s.slotFilename === slot).length, 2);
});

test("a companion picture taken in the other harness is rejected, one with no proof goes to review, and a manual upload is recorded as the slot's harness on a person's word", async () => {
  const lab = await newLab(["create-agent"], "standard");
  const slot = "create-agent-describe.png";
  assert.ok(lab.files.includes(slot));
  const wrong = capture(lab.labId, slot, { seed: 51, harness: "microsoft-copilot" });
  assert.equal(wrong.status, 422);
  assert.equal(wrong.body.outcome, "rejected");
  assert.equal(wrong.body.verification.reasons.find((r) => r.code === "wrong-harness").level, "fail");
  assert.match(wrong.body.message, /taken in the Microsoft Copilot harness, but this screenshot needs the Standard \(Classic\) harness/);
  assert.equal(row(lab.labId, slot).captured, false, "never saved as good");

  const unproven = capture(lab.labId, slot, { seed: 52 });
  assert.equal(unproven.status, 202);
  assert.ok(unproven.body.verification.reasons.some((r) => r.code === "harness-unproven" && /1\.8\.0/.test(r.message)));

  const accepted = ctx.store.accept(ctx.store.lab(lab.labId), slot, { defer: true });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  const stamp = JSON.parse(readFileSync(join(lab.labDir, "screenshots", "verification.json"), "utf8")).shots[slot].harness;
  assert.equal(stamp.id, "standard");
  assert.equal(stamp.proof, "person", "a person accepted it; nothing proved it");
  assert.equal(row(lab.labId, slot).pictureHarness, "standard");

  const byHand = await newLab(["create-agent"], "standard");
  const manual = capture(byHand.labId, byHand.files[0], { seed: 53, companion: false });
  assert.equal(manual.status, 200);
  assert.equal(row(byHand.labId, byHand.files[0]).pictureHarnessLabel, "Standard (Classic) harness");
});

test("a picture with no harness recorded stays visible in its lab, is listed as not recorded, is never shared, and one click records it", async () => {
  const lab = await newLab(["create-agent"], "standard");
  const slot = "create-agent-describe.png";
  assert.ok(lab.files.includes(slot));
  const bytes = png(61);
  writeFileSync(join(lab.labDir, "assets", slot), bytes);
  writeLabVerificationRecord(lab.labDir, slot, { ok: true, level: "pass", state: "accepted", sha256: sha256Hex(bytes), source: "companion", redaction: { applied: true, masked: 1 }, acceptedAt: "2026-01-01T00:00:00.000Z" });

  const before = row(lab.labId, slot);
  assert.equal(before.captured, true, "the lab keeps showing the picture it has");
  assert.equal(before.harnessState, "not-recorded");
  assert.equal(before.pictureHarnessLabel, "Harness not recorded");
  assert.match(before.harnessMessage, /no harness recorded/);
  assert.deepEqual([status(lab.labId).harnessSummary.notRecordedFiles.includes(slot), status(lab.labId).harnessSummary.notRecorded === status(lab.labId).harnessSummary.notRecordedFiles.length], [true, true]);
  assert.ok(scanLabDirectory(lab.labDir).findings.some((f) => f.code === "harness-not-recorded"));

  const shared = ctx.store.shareLabPictures(lab.labId).body;
  assert.equal(shared.skipped.find((s) => s.filename === slot)?.code, "harness-not-recorded", "never silently reused for a harness-specific slot");
  assert.equal(readdirSync(ctx.libDir).filter((name) => name.startsWith("create-agent-describe")).some((name) => readFileSync(libFile(name)).equals(bytes)), false, "its bytes are not in the library under any name");

  const tagged = ctx.store.tagPicture(ctx.store.lab(lab.labId), slot, "standard");
  assert.equal(tagged.status, 200);
  assert.equal(tagged.body.outcome, "tagged");
  assert.equal(row(lab.labId, slot).harnessState, "ok");
  assert.equal(row(lab.labId, slot).pictureHarness, "standard");
  assert.equal(ctx.store.tagPicture(ctx.store.lab(lab.labId), slot, "standard").status, 409, "already recorded");
  assert.equal(ctx.store.shareLabPicture(ctx.store.lab(lab.labId), slot, { confirm: true }).status, 200, "now it may be shared, under the harness's name");
  assert.ok(existsSync(libFile("create-agent-describe.classic.png")));

  // Saying it is the other harness never puts it in the slot: it moves to the kept pictures, and the slot is pending again.
  const second = await newLab(["create-agent"], "standard");
  const bytes2 = png(62);
  writeFileSync(join(second.labDir, "assets", slot), bytes2);
  const moved = ctx.store.tagPicture(ctx.store.lab(second.labId), slot, "microsoft-copilot");
  assert.equal(moved.status, 200);
  assert.equal(moved.body.outcome, "moved");
  assert.match(moved.body.message, /from the Microsoft Copilot harness, but this slot needs the Standard \(Classic\) harness/);
  assert.equal(row(second.labId, slot, emptyLibrary).captured, false);
  const keptEntry = ctx.store.keptOverview().entries.find((e) => e.labId === second.labId);
  assert.deepEqual(keptEntry.pictures.map((p) => [p.base, p.why, p.harness]), [[slot, "wrong-harness", "microsoft-copilot"]]);
  assert.deepEqual(keptEntry.pictures[0].restore, [], "a Microsoft Copilot picture is not put back into a Standard slot");
  assert.equal(keptEntry.pictures[0].harnessApplies, true, "a Copilot Studio picture is a harness picture");
});

test("a kept picture of a product with no harnesses is not 'Harness not recorded', and a staged picture says which harness the companion proved", async () => {
  const build = await generateLab(
    { products: ["sharepoint-ai"], features: ["spai-copilot-in-sharepoint-overview"], includeCore: false },
    { outputRoot: ctx.generatedRoot, labsDir: ctx.emptyLabs, useLearnMcp: false, useLlm: false },
  );
  const plan = JSON.parse(readFileSync(join(build.outputDir, "screenshots", "shots.json"), "utf8"));
  const name = plan.shots[0].filename;
  assert.ok(!plan.shots[0].harness, "a product with no harnesses has no harness on its shots");
  writeFileSync(join(build.outputDir, "assets", name), png(81));
  ctx.store.carryLabPictures(build.labId);
  const entry = ctx.store.keptOverview().entries.find((e) => e.labId === build.labId);
  assert.ok(entry?.pictures.length, "the picture was kept");
  assert.deepEqual(entry.pictures.map((p) => [p.harness, p.harnessApplies]), entry.pictures.map(() => [null, false]), "no harness applies, so the UI shows no label");

  const lab = await newLab(["create-agent"], "standard");
  const staged = capture(lab.labId, "create-agent-describe.png", { seed: 82, harness: "microsoft-copilot" });
  assert.equal(staged.body.verification.harnessSeen.id, "microsoft-copilot", "the review says what the companion read from the page");
  assert.equal(staged.body.verification.harness, undefined, "and it is not mistaken for the picture's saved stamp");
});

test("a lab picture stamped with the other harness is not used, and lab-gate and the lab status say so", async () => {
  const lab = await newLab(["create-agent"], "standard");
  const slot = "create-agent-describe.png";
  const bytes = png(71);
  writeFileSync(join(lab.labDir, "assets", slot), bytes);
  writeLabVerificationRecord(lab.labDir, slot, { ok: true, level: "pass", state: "accepted", sha256: sha256Hex(bytes), harness: { id: "microsoft-copilot", proof: "landmarks", at: "2026-01-01T00:00:00.000Z" } });
  const shown = row(lab.labId, slot, emptyLibrary);
  assert.equal(shown.captured, false, "the slot is pending: the picture is not used");
  assert.equal(shown.harnessState, "wrong-harness");
  assert.equal(shown.pictureHarness, "microsoft-copilot");
  const summary = status(lab.labId, emptyLibrary).harnessSummary;
  assert.equal(summary.wrong, 1);
  assert.equal(summary.mixed, true);
  assert.match(summary.mixedMessage, /built for the Standard \(Classic\) harness, but it has pictures from the Microsoft Copilot harness/);
  const findings = scanLabDirectory(lab.labDir).findings;
  assert.ok(findings.some((f) => f.code === "wrong-harness-picture" && f.severity === "gap"));

  const other = capture(lab.labId, lab.files[1] || slot, { seed: 72, harness: "standard" });
  assert.ok([200, 202].includes(other.status));
});

test("pictures from both harnesses in one lab are flagged, and the same picture under two harnesses is wrong for both", () => {
  const picture = (id, harness, slotHarness, sha) => ({ id, scope: "lab", labId: "lab", filename: id, sha256: sha, fingerprint: null, record: null, confirmed: false, harnessStamp: harness, slot: { product: "copilot-studio", depth: null, label: id, harness: slotHarness } });
  const results = assessPictures([picture("a.png", "microsoft-copilot", "standard", "s1"), picture("b.png", "standard", "standard", "s2")]);
  const a = results.find((r) => r.id === "lab:lab:a.png" || r.id === "a.png");
  assert.ok(a.flags.some((f) => f.code === FLAGS.HARNESS_MISMATCH && f.level === "definite" && /needs the Standard \(Classic\) harness/.test(f.message)));
  assert.equal(results.find((r) => r.id === "b.png").flags.length, 0);

  const same = assessPictures([picture("c.png", null, "standard", "same"), picture("d.png", null, "microsoft-copilot", "same")]);
  for (const result of same) assert.ok(result.flags.some((f) => f.code === FLAGS.HARNESS_MIXED && f.level === "definite"), "one picture cannot show both harnesses");
  const kept = assessPictures([{ ...picture("e.png", null, "standard", "same2"), confirmed: true }, picture("f.png", null, "microsoft-copilot", "same2")]);
  assert.ok(kept.find((r) => r.id === "e.png").flags.some((f) => f.code === FLAGS.HARNESS_MIXED), "Keep this one does not change it");
});

test("a picture is shared only when it is recorded as taken in the slot's harness", () => {
  const bytes = png(81);
  const slot = { product: "copilot-studio", harness: "standard" };
  const base = { filename: "x.classic.png", bytes, slot, intent: "share" };
  const check = (harness) => ({ sha256: sha256Hex(bytes), state: "accepted", level: "pass", ok: true, redaction: { applied: true, masked: 1 }, ...(harness ? { harness: { id: harness, proof: "person" } } : {}) });
  assert.equal(shareVerdict({ ...base, record: check("standard") }).ok, true);
  assert.equal(shareVerdict({ ...base, record: check(null) }).code, "harness-not-recorded");
  assert.equal(shareVerdict({ ...base, record: null }).code, "harness-not-recorded", "even a person's choice needs the harness first");
  assert.equal(shareVerdict({ ...base, record: check("microsoft-copilot") }).code, "wrong-harness");
  assert.equal(shareVerdict({ ...base, record: { ...check("standard"), sha256: "someone-elses" } }).code, "harness-not-recorded", "a stamp belongs to exact bytes");
  assert.equal(shareVerdict({ ...base, slot: { product: "copilot-studio", harness: null }, record: check(null) }).ok, true, "a slot with no harness needs none");
});

test("pictures saved under a plain name are listed as not recorded, never used, tagged with one click, and travel in the library ZIP as they are", async () => {
  const storeDir = tmp("harness-identity-store-");
  const dataDir = tmp("harness-identity-data-");
  const platform = createCapturePlatform({ generatedRoot: tmp("harness-identity-labs-"), dataDir, env: { PORTAL_STORAGE_ROOT: storeDir }, detectServerBrowser: async () => ({ available: false }) });
  const store = platform.screenshots;
  const folder = join(storeDir, "screenshots");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "create-agent-describe.png"), png(91));
  writeFileSync(join(folder, "mc-harness-choice-home.png"), png(92));

  const state = store.libraryState();
  assert.equal(state.summary.harnessNotRecorded, 2);
  assert.deepEqual(state.unrecorded.map((p) => p.filename).sort(), ["create-agent-describe.png", "mc-harness-choice-home.png"]);
  assert.equal(state.shots.find((s) => s.filename === "create-agent-describe.classic.png").captured, false, "not used for the slot");
  assert.equal(state.unrecorded.find((p) => p.filename === "mc-harness-choice-home.png").harnesses.length, 2);

  const exported = await buildLibraryExport(store);
  assert.equal(exported.count, 2);

  const tagged = store.tagPicture(store.library(), "create-agent-describe.png", "standard");
  assert.equal(tagged.status, 200, JSON.stringify(tagged.body));
  assert.equal(tagged.body.libraryFilename, "create-agent-describe.classic.png");
  assert.ok(existsSync(join(folder, "create-agent-describe.classic.png")));
  assert.equal(existsSync(join(folder, "create-agent-describe.png")), false);
  assert.equal(store.libraryState().shots.find((s) => s.filename === "create-agent-describe.classic.png").captured, true);
  const stamp = JSON.parse(readFileSync(join(dataDir, "capture", "library-verification.json"), "utf8")).shots["create-agent-describe.classic.png"].harness;
  assert.deepEqual([stamp.id, stamp.proof], ["standard", "person"]);

  // A Standard-only slot's picture that is really a Microsoft Copilot one is not used for it.
  writeFileSync(join(folder, "agent-overview.png"), png(93));
  const moved = store.tagPicture(store.library(), "agent-overview.png", "microsoft-copilot");
  assert.equal(moved.body.outcome, "moved");
  assert.equal(existsSync(join(folder, "agent-overview.png")), false);
  assert.equal(store.libraryState().unrecorded.some((p) => p.filename === "agent-overview.png"), false);

  // A ZIP made before the tag (names with no harness) imports as unrecorded, and a tagged name imports as a slot.
  const other = createCapturePlatform({ generatedRoot: tmp("harness-identity-labs2-"), dataDir: tmp("harness-identity-data2-"), env: { PORTAL_STORAGE_ROOT: tmp("harness-identity-store2-") }, detectServerBrowser: async () => ({ available: false }) });
  const imported = importLibraryZip(other.screenshots, exported.buffer);
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  assert.equal(other.screenshots.libraryState().summary.harnessNotRecorded, 2);
  assert.equal(other.screenshots.libraryState().summary.captured, 0);
});

// ── The catalog, the companion version, the evidence, and the preview card ──

test("a slot may only say 'either'; the lab's harness decides everything else, and 'both' in the shot list means one picture per harness", () => {
  assert.equal(shotHarness({ harnessGroup: "both" }, {}), "both");
  assert.equal(shotHarness({ harnessGroup: "standard" }, {}), "standard");
  assert.equal(shotHarness({ harnessGroup: "both" }, { harness: "either" }), "either");
  assert.throws(() => shotHarness({ harnessGroup: "both" }, { harness: "standard", filename: "x.png" }), /may only say harness "either"/);
  const features = [{ id: "demo", name: "Demo", harness: ["standard"], screenshots: [{ filename: "demo.png", harness: "standard" }] }];
  const problems = validateScreenshotSlots({ features, meta: { "demo.png": { kind: "ui-location", caption: "A caption here", alt: "The Demo page with its list of items and the New button visible." } }, overlay: {} });
  assert.ok(problems.some((p) => /a slot may only say "either"/.test(p)));
});

test("a picture's evidence carries the harness proof only when it is complete, and an older companion's picture goes to review", () => {
  const bytes = png(101);
  const evidence = { version: 2, finalUrl: "https://copilotstudio.microsoft.com/environments/x/bots/y/overview", title: "Copilot Studio", visibleText: ["Overview"], redaction: { applied: true, masked: 1 } };
  const run = (extra, expectHarness = "standard") => verifyImage(bytes, { filename: "a.png", requireEvidence: true, requireProof: true, requireRedaction: true, expectHarness, evidence: { ...evidence, ...extra } });
  assert.ok(run({}).reasons.some((r) => r.code === "harness-unproven" && r.level === "warn"));
  assert.ok(run({ harness: proof("microsoft-copilot") }).reasons.some((r) => r.code === "wrong-harness" && r.level === "fail"));
  assert.ok(!run({ harness: proof("standard") }).reasons.some((r) => /harness/.test(r.code)));
  assert.ok(run({ harness: { ...proof("standard"), landmarks: [] } }).reasons.some((r) => r.code === "harness-unproven"), "an incomplete proof is no proof");
  assert.ok(!verifyImage(bytes, { filename: "a.png", requireEvidence: true, requireProof: true, evidence }).reasons.some((r) => /harness/.test(r.code)), "a slot with no harness asks for none");
});

test("the preview card of a picture still to add says which harness to take it in", async () => {
  const lab = await newLab(["create-agent"], "standard");
  const card = pendingShotCardHtml(lab.files[0], { alt: "The Home page.", harness: "standard", instructions: [] });
  assert.match(card, /<span class="lab-shot-card-harness"><strong>Harness:<\/strong> Standard \(Classic\) harness<\/span>/);
  assert.doesNotMatch(pendingShotCardHtml("x.png", { alt: "A page.", harness: "" }), /lab-shot-card-harness/, "a product with no harnesses shows none");
  const served = decorateGeneratedHtml(readFileSync(join(lab.labDir, "index.html"), "utf8"), lab.labId, lab.labDir, { capturedDir: [ctx.libDir] });
  assert.ok(served.pending.length > 0, "the lab preview still has pictures to add");
  assert.match(served.html, /<span class="lab-shot-card-harness"><strong>Harness:<\/strong> Standard \(Classic\) harness<\/span>/, "the preview shows it on a card");
});

test("the companion download carries the shared harness module the companion imports", async () => {
  const { COMPANION_FILES } = await import("../lib/capture/companion-zip.js");
  assert.ok(COMPANION_FILES.includes("tools/screenshot-capture/harness.mjs"));
  assert.ok(existsSync(join(REPO_ROOT, "tools", "screenshot-capture", "harness.mjs")));
});
