/**
 * Builds the shot plan a capture job carries: which shots to run, and for each
 * one the page to open, the bounded UI steps to take, the callouts to place, and
 * the labels the finished screenshot should show.
 *
 * The plan is data, not code. Steps are restricted to a small allowlist of
 * actions (navigate over https, wait, dismiss banners, click or focus a labeled
 * control, locate a control, resolve callouts, screenshot) and never type text,
 * so the companion can run them in a signed-in browser safely.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { capturedImage, capturedScreenshotsDirs, resolveLabScreenshot } from "../lab-builder/captured.js";
import {
  derivePlaywrightSteps,
  ensurePerLabScreenshotPlan,
  labHarnessOrder,
  resolveGeneratedLabDir,
} from "../lab-builder/lab-screenshots.js";
import { getSlotMeta } from "../lab-builder/slots.js";
import { listFeatureManifests } from "../../../tools/screenshot-capture/manifests.mjs";
import { blockedInstructionReason, blockedLabelReason } from "../../../tools/screenshot-capture/guard.mjs";
import { REQUIREMENTS, COPILOT_STUDIO_SCREENS, missingRequirements, targetField } from "../../../tools/screenshot-capture/targets.mjs";
import { classifyShot, expectedLabelsForShot } from "./classify.js";
import { buildSetupPlan } from "./setup-plan.js";
import { createsAgent, describeAutomation, orderCreationFirst, orderForWalkthrough, personAutomation, sanitizeAutomation, scratchDescriptor } from "../../../tools/screenshot-capture/walkthrough.mjs";
import { harnessGapMessage, harnessLabel, harnessPlan, harnessProofFor, labHarnessStatement, libraryName, libraryVariants, normalizeHarness } from "../../../tools/screenshot-capture/harness.mjs";

const ALLOWED_ACTIONS = new Set([
  "navigate",
  "waitForLoadState",
  "dismissBanners",
  "stepThrough",
  "click",
  "clickBestEffort",
  "probeControl",
  "probeCallouts",
  "screenshot",
]);
const WAIT_UNTIL = new Set(["load", "domcontentloaded", "networkidle", "commit"]);
const INTERACTIONS = new Set(["click-or-focus", "locate"]);
const ROLES = new Set(["tab", "menuitem", "treeitem", "button", "link", "textbox", "combobox", "switch", "checkbox"]);

function text(value, max) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function labelsOf(list, max = 6) {
  return (Array.isArray(list) ? list : []).map((l) => text(l, 80)).filter(Boolean).slice(0, max);
}

function isHttps(url) {
  return /^https:\/\/[^\s]+$/.test(String(url || ""));
}

/** Keep only allowed actions and known, bounded fields. */
export function sanitizePlanSteps(steps) {
  const out = [];
  for (const raw of Array.isArray(steps) ? steps.slice(0, 60) : []) {
    const action = String(raw?.action || "");
    if (!ALLOWED_ACTIONS.has(action)) continue;
    const step = { action };
    if (action === "navigate") {
      if (!isHttps(raw.url)) continue;
      step.url = String(raw.url).slice(0, 2048);
      step.waitUntil = WAIT_UNTIL.has(raw.waitUntil) ? raw.waitUntil : "domcontentloaded";
    }
    if (action === "waitForLoadState") step.state = WAIT_UNTIL.has(raw.state) ? raw.state : "domcontentloaded";
    if (Number.isFinite(Number(raw.timeoutMs))) step.timeoutMs = Math.max(0, Math.min(60000, Number(raw.timeoutMs)));
    if (Number.isInteger(raw.stepIndex)) step.stepIndex = raw.stepIndex;
    if (raw.instruction) step.instruction = text(raw.instruction, 300);
    if (raw.label) step.label = text(raw.label, 80);
    if (Array.isArray(raw.labels)) step.labels = labelsOf(raw.labels, 6);
    if (Array.isArray(raw.roles)) step.roles = raw.roles.filter((r) => ROLES.has(r)).slice(0, 9);
    if (INTERACTIONS.has(raw.interaction)) step.interaction = raw.interaction;
    if (raw.optional !== undefined) step.optional = Boolean(raw.optional);
    if (action === "probeCallouts") {
      step.callouts = (Array.isArray(raw.callouts) ? raw.callouts : []).slice(0, 12).map((c, i) => ({
        n: Number.isInteger(c?.n) ? c.n : i + 1,
        label: text(c?.label ?? c?.text, 80),
        text: text(c?.text ?? c?.label, 120),
      }));
    }
    if (action === "screenshot") step.fullPage = Boolean(raw.fullPage);
    // A click that deletes something, signs in or out, or switches the account never goes into a plan.
    if (["stepThrough", "click", "clickBestEffort"].includes(action)) {
      if (blockedInstructionReason(step.instruction)) continue;
      const hadLabels = Boolean(step.label) || Boolean(step.labels?.length);
      if (step.labels) step.labels = step.labels.filter((l) => !blockedLabelReason(l));
      if (step.label && blockedLabelReason(step.label)) delete step.label;
      if (hadLabels && !step.label && !step.labels?.length) continue;
    }
    out.push(step);
  }
  return out;
}

/** The labels the finished screenshot should show: the shot's own callouts and bold labels, never other screens' steps. */
function expectedLabelsFor(shot) {
  return expectedLabelsForShot({ callouts: shot.callouts || [], instructions: shot.instructions || [] }, { extra: shot.capture?.landmarks || [] });
}

function viewportOf(value) {
  const width = Number(value?.width);
  const height = Number(value?.height);
  return Number.isFinite(width) && Number.isFinite(height) && width >= 320 && height >= 240 && width <= 3840 && height <= 2400
    ? { width, height }
    : { width: 1440, height: 900 };
}

function toPlanShot(raw, { authProfile, product, startUrl, steps, callouts, instructions, values = {}, allowPractice = false, sharedRecipes = null, labTitle = "", scratch = false, agentSource = null, agentFallback = null, meta = null }) {
  const src = raw;
  // The feature tour's shot lists carry no kind or description; the slot table does, and a lab's own shots are read with it. The classifier
  // that decides how a shot is captured by address keeps reading the shot as the shot list gives it.
  const full = meta ? { ...raw, kind: raw.kind || meta.kind, alt: raw.alt || meta.alt, caption: raw.caption || meta.caption } : raw;
  const urlEnv = /^CAPTURE_[A-Z0-9_]{1,80}$/.test(String(src.urlEnv || "")) ? src.urlEnv : null;
  const capture = classifyShot({ ...src, product: product ?? src.product, callouts, instructions }, { values });
  // What the computer sets up on the screen, in autonomous mode. Steps that need a practice agent are in the plan only when the job allows one.
  // A from-scratch capture of Copilot Studio builds its screens with the walkthrough instead; another product's screens are opened by the product's own navigation.
  const walkthroughBuilds = scratch && String(product ?? src.product ?? "copilot-studio") === "copilot-studio";
  const setup = walkthroughBuilds ? null : buildSetupPlan({ ...src, product: product ?? src.product, callouts, instructions }, { capture, allowPractice, sharedRecipes, labTitle });
  // Built from scratch: which stage of the lab the shot belongs to, and why it needs a person when the computer cannot do it.
  const stage = scratch ? scratchDescriptor({ ...full, product: product ?? src.product, callouts, instructions }) : null;
  const agent = agentDescriptor(src, capture, { agentSource, agentFallback, stage });
  // Whether the computer takes this shot by itself (and how), or the one reason it needs a person. A library slot is read with its slot description (its kind), as a lab's own shot is.
  const readAs = meta ? classifyShot({ ...full, product: product ?? src.product, callouts, instructions }, { values }) : capture;
  let automation = sanitizeAutomation(describeAutomation({ ...full, product: product ?? src.product, callouts, instructions }, { capture: readAs, labels: expectedLabelsForShot({ callouts, instructions }, { extra: capture.landmarks || [] }) }));
  // A screen deeper than the page its address opens, with no recipe (a shared or built-in one, or labels to open) to reach it, is not
  // photographed as it stands: the page that happens to be open is the product's start page. It is left to a person, for the same plain
  // reason the computer gives when it meets the shot (a from-scratch capture of Copilot Studio is the exception: its walkthrough builds the screen).
  if (automation?.state === "automatic" && automation.via !== "address" && !walkthroughBuilds && !setup?.steps?.length && !setup?.limited && !["auto", "manual"].includes(capture.mode)) {
    automation = sanitizeAutomation(personAutomation(readAs.product === "copilot-studio" ? "unseen" : "other-product"));
  }
  // A shot that uses the agent created earlier in this capture is not waiting for an address: the agent arrives from the creation step.
  const unmetNeeds = agent?.via === "created" ? (capture.needs || []).filter((id) => id !== "copilot-studio-agent") : capture.needs;
  // A screen the settings already lead to is opened directly, so even a companion that follows only the address lands on it.
  const directUrl = capture.mode !== "manual" ? capture.knownUrl || null : null;
  const effectiveStart = directUrl || startUrl;
  // The page-by-page clicks are gone from the plan: the `capture` descriptor says how to reach the screen, and a
  // companion that does not know it still opens the best address and takes the picture.
  const planSteps = capture.mode === "manual" ? steps : derivePlaywrightSteps({ uiSteps: [], startUrl: effectiveStart, callouts, filename: src.filename, outputPath: src.outputPath });
  // An older companion skips a shot whose tenant address variable is unset, so name the one this shot is waiting for.
  // (A companion that reads `capture` decides for itself; this keeps the older contract.)
  const unmet = capture.mode !== "manual" ? missingRequirements(unmetNeeds, values) : [];
  const waitingField = unmet.length ? REQUIREMENTS[unmet[0]].fields.map((id) => targetField(id)).find((f) => f?.env) : null;
  // The harness this picture is taken in (Copilot Studio only), the step that gets the page into it, and the landmark that proves it.
  const harness = String(product ?? src.product ?? "copilot-studio") === "copilot-studio" ? normalizeHarness(src.harness) : null;
  const harnessSteps = harness ? harnessPlan(harness) : null;
  // A screen outside any agent shows no landmark, so its plan line says it is checked by the host only and goes to review. A screen the walkthrough builds
  // is taken on the practice agent, so it is proven by the agent's own tabs whatever its address opens.
  const harnessScope = !stage?.scoped && capture?.route?.kind === "copilot-studio" && COPILOT_STUDIO_SCREENS[capture.route.screen]?.scope === "environment" ? "environment" : "agent";
  const harnessGap = harness && src.harnessGap && typeof src.harnessGap === "object" && src.harnessGap.lab
    ? { feature: (Array.isArray(src.harnessGap.feature) ? src.harnessGap.feature : []).map(normalizeHarness).filter(Boolean).slice(0, 3), lab: normalizeHarness(src.harnessGap.lab) }
    : null;
  const plainName = text(String(src.slotFilename || src.filename || "").replace(/\.[a-z0-9]+$/i, "").toLowerCase(), 80);
  const shot = {
    filename: src.filename,
    ...(src.slotFilename ? { slotFilename: text(src.slotFilename, 120) } : {}),
    shotId: src.shotId ?? null,
    featureId: src.featureId ?? src.feature ?? null,
    harness,
    harnessLabel: harness ? harnessLabel(harness) : null,
    // A lab that covers both harnesses: the part the slot sits in, and for a shared topic the note "Works in either harness".
    ...(src.harnessPart ? { harnessPart: text(src.harnessPart, 40), harnessScope: src.harnessScope === "shared" ? "shared" : "harness", ...(src.harnessNote ? { harnessNote: text(src.harnessNote, 80) } : {}) } : {}),
    ...(harnessGap ? { harnessGap, harnessGapNote: harnessGapMessage(harnessGap) } : {}),
    kind: text(full.kind, 30) || null,
    moduleOrder: Number.isInteger(src.moduleOrder) && src.moduleOrder >= 0 && src.moduleOrder < 1000 ? src.moduleOrder : null,
    product: product ?? src.product ?? null,
    authProfile,
    section: text(src.section, 60) || null,
    moduleTitle: text(src.moduleTitle ?? src.featureName, 160) || null,
    caption: text(full.caption, 200) || null,
    startUrl: isHttps(effectiveStart) ? effectiveStart : null,
    urlEnv,
    requiresEnv: waitingField?.env || null,
    navHint: text(src.navHint, 300) || null,
    manual: Boolean(src.manual) || capture.mode === "manual",
    viewport: viewportOf(src.viewport),
    steps: sanitizePlanSteps(planSteps),
    callouts: (Array.isArray(callouts) ? callouts : []).slice(0, 12).map((c, i) => ({
      n: Number.isInteger(c?.n) ? c.n : i + 1,
      label: text(c?.label ?? c?.text, 80),
      text: text(c?.text ?? c?.label, 120),
    })),
    instructions: (Array.isArray(instructions) ? instructions : []).slice(0, 6).map((i) => text(i, 300)),
    capture: { ...withAgentHandoff(sanitizeCaptureDescriptor(capture), agent), ...(harnessSteps ? { harness: { id: harness, label: harnessLabel(harness), switch: harnessSteps.switch, switchStep: harnessSteps.switchStep, proof: harnessProofFor(harness, harnessScope) } } : {}), ...(setup ? { setup } : {}), ...(stage ? { scratch: stage, ...(stage.scoped && !stage.blocker ? { expect: SCRATCH_EXPECT } : {}) } : {}), ...(automation ? { automation } : {}), slot: plainName },
  };
  // A recipe family judges its own screen: the callouts of the lab's other steps are not what its picture shows.
  shot.expectedLabels = automation?.via === "family" ? automation.landmarks : expectedLabelsFor(shot);
  return shot;
}

/**
 * What a shot has to do with the lab's agent, in this plan. `needs`: it shows an agent. `creates`: it belongs to the part of the lab that creates
 * one. `via`: where its agent comes from: "created" (the practice agent the computer creates, or reuses, earlier in this capture: nothing to type),
 * "own" (the agent the person chose and gave an address or a name for) or "address" (the person's address is the only way left, because the
 * agent cannot be created now: `fallback` says why). A shot that shows no agent has `via: null`.
 * @param {{agentSource: "created"|"own"|null, agentFallback: string|null, stage: object|null}} options `agentSource` is the person's choice; `agentFallback` is why the agent cannot be created now (null when it can)
 */
function agentDescriptor(src, capture, { agentSource = null, agentFallback = null, stage = null } = {}) {
  if (!agentSource) return null;
  const needs = (capture.agentNeeds || []).includes("copilot-studio-agent");
  const creates = createsAgent(src);
  if (!needs && !creates) return null;
  // Built from scratch, only a shot the walkthrough puts on the practice agent uses it; the rest are left to the person with a plain reason.
  const onPractice = !stage || (stage.scoped && !stage.blocker);
  const via = !needs ? null : agentSource === "created" ? (!agentFallback && onPractice ? "created" : "address") : "own";
  return { needs, creates, via, ...(agentFallback && via === "address" ? { fallback: agentFallback } : {}) };
}

const AGENT_VIA = new Set(["created", "own", "address"]);

/** The descriptor with the agent hand-off applied: a shot whose agent comes from the creation step is ready, not waiting for an address. */
function withAgentHandoff(descriptor, agent) {
  if (!descriptor || !agent) return descriptor;
  const clean = { needs: agent.needs === true, creates: agent.creates === true, via: AGENT_VIA.has(agent.via) ? agent.via : null, ...(agent.fallback ? { fallback: text(agent.fallback, 80) } : {}) };
  if (agent.via !== "created") return { ...descriptor, agent: clean };
  const missing = (descriptor.missing || []).filter((id) => id !== "copilot-studio-agent");
  return { ...descriptor, missing, agentMissing: (descriptor.agentMissing || []).filter((id) => id !== "copilot-studio-agent"), ready: missing.length === 0, agent: clean };
}

// Built from scratch, the walkthrough proves each screen by its tabs and controls, not by its address: in the newer layout the address keeps /knowledge while the page shows Build.
const SCRATCH_EXPECT = Object.freeze({ family: "copilot-studio", scope: "agent", paths: [], label: "the practice agent", strict: false });

/** The descriptor as a plan carries it: bounded text and known fields only, no internal helper values. */
export function sanitizeCaptureDescriptor(capture) {
  if (!capture || typeof capture !== "object") return null;
  const list = (value, max, len = 80) => (Array.isArray(value) ? value.slice(0, max).map((v) => text(v, len)).filter(Boolean) : []);
  const expect = capture.expect && typeof capture.expect === "object" ? capture.expect : null;
  return {
    version: capture.version,
    mode: ["auto", "guided", "manual"].includes(capture.mode) ? capture.mode : "guided",
    why: text(capture.why, 300),
    product: text(capture.product, 60) || null,
    section: text(capture.section, 60) || null,
    needs: list(capture.needs, 4, 40).filter((id) => REQUIREMENTS[id]),
    missing: list(capture.missing, 4, 40).filter((id) => REQUIREMENTS[id]),
    agentNeeds: list(capture.agentNeeds, 4, 40).filter((id) => REQUIREMENTS[id]),
    agentMissing: list(capture.agentMissing, 4, 40).filter((id) => REQUIREMENTS[id]),
    ready: capture.ready !== false,
    route: capture.route && typeof capture.route === "object" ? { kind: text(capture.route.kind, 20), screen: text(capture.route.screen, 30) || undefined, scope: text(capture.route.scope, 20) || undefined, url: isHttps(capture.route.url) ? capture.route.url : undefined, urlEnv: /^CAPTURE_[A-Z0-9_]{1,80}$/.test(String(capture.route.urlEnv || "")) ? capture.route.urlEnv : undefined, direct: capture.route.direct === true ? true : undefined } : { kind: "none" },
    screen: capture.screen ? { id: text(capture.screen.id, 40), label: text(capture.screen.label, 120) } : null,
    path: list(capture.path, 6, 60),
    expect: expect
      ? { family: text(expect.family, 20), scope: text(expect.scope, 20) || undefined, paths: list(expect.paths, 4, 40), host: text(expect.host, 120) || undefined, label: text(expect.label, 120), strict: expect.strict !== false }
      : null,
    reveal: (Array.isArray(capture.reveal) ? capture.reveal : []).slice(0, 3).map((s) => ({ action: "reveal", label: text(s.label, 80), required: Boolean(s.required) })).filter((s) => s.label),
    landmarks: list(capture.landmarks, 8, 80),
    guide: list(capture.guide, 6, 220),
    ...(capture.agent && typeof capture.agent === "object"
      ? { agent: { needs: capture.agent.needs === true, creates: capture.agent.creates === true, via: AGENT_VIA.has(capture.agent.via) ? capture.agent.via : null, ...(capture.agent.fallback ? { fallback: text(capture.agent.fallback, 80) } : {}) } }
      : {}),
  };
}

function inScope(scope, { filename, featureId, missing, stale }) {
  if (scope.filenames?.length && !scope.filenames.includes(filename)) return false;
  if (scope.featureIds?.length && !scope.featureIds.includes(featureId)) return false;
  if (scope.mode === "missing") return missing;
  if (scope.mode === "stale") return stale || missing;
  return true;
}

/**
 * The shots a lab job should capture. Returns `{status: 200, title, shots}` or `{status, error}`.
 */
export function buildLabJobPlan({ generatedRoot, labId, scope, capturedDir = capturedScreenshotsDirs(), values = {}, allowPractice = false, sharedRecipes = null, scratch = false, agentSource = null, agentFallback = null }) {
  const found = resolveGeneratedLabDir(generatedRoot, labId);
  if (found.status !== 200) return { status: found.status, error: found.error };
  const { shotsPlan, learnState } = ensurePerLabScreenshotPlan(found.labDir, { labId: found.labId, capturedDir });

  const shots = [];
  for (const shot of shotsPlan.shots || []) {
    const featureId = shot.featureId || shot.feature;
    const shotState = learnState.shots?.[shot.filename] || {};
    const moduleState = learnState.modules?.[featureId] || {};
    const stale =
      Boolean(shotState.stale) ||
      moduleState.status === "docs-updated" ||
      Boolean(shotState.capturedStepHash && shot.learnBaseline?.stepHash && shotState.capturedStepHash !== shot.learnBaseline.stepHash);
    const missing = !resolveLabScreenshot(found.labDir, shot.filename, { capturedDir, harness: shot.harness });
    if (!inScope(scope, { filename: shot.filename, featureId, missing, stale })) continue;
    const steps = Array.isArray(shot.steps) && shot.steps.length
      ? shot.steps
      : derivePlaywrightSteps({
          uiSteps: shot.instructions || [],
          startUrl: shot.startUrl,
          callouts: shot.callouts,
          filename: shot.filename,
          outputPath: shot.outputPath,
        });
    shots.push(
      toPlanShot(shot, {
        authProfile: shot.authProfile || shotsPlan.authProfile || shot.product || "copilot-studio",
        product: shot.product,
        startUrl: shot.startUrl || shotsPlan.startUrl,
        steps,
        callouts: shot.callouts,
        instructions: shot.instructions,
        values,
        allowPractice,
        sharedRecipes,
        labTitle: shotsPlan.title || "",
        scratch,
        agentSource,
        agentFallback,
      }),
    );
  }
  // Built from scratch, the lab's modules are the order the agent is built in. When the agent comes from the creation step, that step goes first.
  const ordered = scratch ? orderForWalkthrough(shots) : shots;
  // A lab that covers both harnesses is captured one harness at a time, so the computer changes experience as few times as possible (the classic
  // switch once, the default experience once): every slot of the first harness (its part, and the shared topics, which are taken in it), then every
  // slot of the second. The creation step goes first within each harness, because each harness has its own practice agent.
  const harnessOrder = labHarnessOrder(shotsPlan);
  const groups = harnessOrder.length === 2 ? groupByHarness(ordered, harnessOrder) : [ordered];
  const arranged = groups.flatMap((group) => (agentSource === "created" && !agentFallback ? orderCreationFirst(group) : group));
  return { status: 200, title: shotsPlan.title || labId, labId: found.labId, labDir: found.labDir, labHarness: shotsPlan.harnessInfo || null, shots: arranged };
}

/** Shots in groups by the harness they are taken in, in the lab's order; shots with no harness (another product) come last. */
function groupByHarness(shots, order) {
  const groups = order.map((id) => shots.filter((s) => normalizeHarness(s.harness) === id));
  const rest = shots.filter((s) => !order.includes(normalizeHarness(s.harness)));
  return [...groups, rest].filter((group) => group.length);
}

/** Every filename a lab accepts uploads for. */
export function labSlotFilenames({ generatedRoot, labId, capturedDir = capturedScreenshotsDirs() }) {
  const found = resolveGeneratedLabDir(generatedRoot, labId);
  if (found.status !== 200) return { status: found.status, error: found.error };
  const { shotsPlan } = ensurePerLabScreenshotPlan(found.labDir, { labId: found.labId, capturedDir });
  return { status: 200, labId: found.labId, labDir: found.labDir, shots: shotsPlan.shots || [], harnessInfo: shotsPlan.harnessInfo || null };
}

/**
 * Every slot of the shared library as a row: the feature tour's shot lists, one row per harness the slot has a picture for (a slot of a feature
 * written for both the Standard and the Microsoft Copilot harness has two). `key` is the picture's name in the library, which carries the
 * harness for a slot that needs one (`agent-overview.classic.png`); a slot of a product with no harnesses keeps its plain name.
 */
function libraryShots({ manifestDir } = {}) {
  const out = [];
  for (const entry of listFeatureManifests(manifestDir)) {
    if (!entry.manifest) continue;
    for (const shot of entry.manifest.shots || []) {
      const word = String(shot.harness ?? "").trim().toLowerCase();
      const variants = libraryVariants({
        product: entry.product,
        slotHarness: word === "either" ? "either" : null,
        featureHarness: word === "both" ? ["standard", "microsoft-copilot"] : word ? [word] : null,
      });
      for (const harness of variants) out.push({ entry, shot, harness, key: libraryName(shot.filename, harness) });
    }
  }
  return out;
}

/** Every slot in the shared library (the feature tour's shot lists), with whether a real image exists. `filename` is the library name (it carries the harness). */
export function listLibrarySlots({ manifestDir, capturedDir = capturedScreenshotsDirs() } = {}) {
  return libraryShots({ manifestDir }).map(({ entry, shot, harness, key }) => {
    const image = capturedImage(capturedDir, key);
    return {
      product: entry.product,
      feature: shot.feature,
      featureName: shot.featureName || null,
      filename: key,
      slotFilename: shot.filename,
      harness,
      harnessLabel: harness ? harnessLabel(harness) : null,
      section: shot.section || null,
      caption: shot.caption || null,
      manual: Boolean(shot.manual),
      urlEnv: shot.urlEnv || null,
      captured: Boolean(image),
      bytes: image?.size ?? null,
      file: image?.file ?? null,
    };
  });
}

/**
 * The library's pictures saved under a slot's plain name for a slot that needs a harness: pictures from before harnesses were recorded.
 * They are never used for the slot; the Screenshot Center lists them as "Harness not recorded" so a person can say which harness each one shows.
 * @returns {Array<{filename: string, feature: string, featureName: string|null, product: string, harnesses: string[], bytes: number, file: string, dir: string}>}
 */
export function listUnrecordedLibraryPictures({ manifestDir, capturedDir = capturedScreenshotsDirs() } = {}) {
  const out = new Map();
  const tagged = new Set();
  const sha = (file) => {
    try {
      return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    } catch {
      return null;
    }
  };
  for (const { entry, shot, harness, key } of libraryShots({ manifestDir })) {
    if (!harness || harness === "either") continue;
    const found = capturedImage(capturedDir, shot.filename);
    if (!found) continue;
    // A picture that already has a copy under a harness's name (the tag was applied, and the original sits in a folder that cannot be changed) is not unrecorded any more.
    const copy = capturedImage(capturedDir, key);
    if (copy && copy.size === found.size && sha(copy.file) === sha(found.file)) tagged.add(shot.filename);
    const row = out.get(shot.filename) || { filename: shot.filename, feature: shot.feature, featureName: shot.featureName || null, product: entry.product, harnesses: [], bytes: found.size, file: found.file, dir: found.dir };
    if (!row.harnesses.includes(harness)) row.harnesses.push(harness);
    out.set(shot.filename, row);
  }
  return [...out.values()].filter((row) => !tagged.has(row.filename));
}

/** The shots a shared-library job should capture. Returns `{status: 200, shots}`. A slot that needs a harness has one shot per harness. */
export function buildLibraryJobPlan({ scope, products = [], manifestDir, capturedDir = capturedScreenshotsDirs(), values = {}, allowPractice = false, sharedRecipes = null, scratch = false, agentSource = null, agentFallback = null }) {
  const productSet = products.length ? new Set(products) : null;
  const shots = [];
  const seen = new Set();
  for (const { entry, shot, harness, key } of libraryShots({ manifestDir })) {
    if (productSet && !productSet.has(entry.product)) continue;
    if (seen.has(key)) continue;
    const missing = !capturedImage(capturedDir, key);
    if (!inScope(scope, { filename: key, featureId: shot.feature, missing, stale: false })) continue;
    seen.add(key);
    const startUrl = shot.url || entry.manifest.startUrl;
    shots.push(
      toPlanShot({ ...shot, filename: key, slotFilename: shot.filename, harness }, {
        meta: getSlotMeta()[shot.filename] || null,
        authProfile: entry.manifest.authProfile || entry.product,
        product: entry.product,
        startUrl,
        steps: derivePlaywrightSteps({
          uiSteps: shot.setup || [],
          startUrl,
          callouts: shot.callouts,
          filename: key,
          outputPath: path.posix.join("docs/feature-tour/screenshots", key),
        }),
        callouts: shot.callouts,
        instructions: shot.instructions,
        values,
        allowPractice,
        sharedRecipes,
        labTitle: shot.featureName || "",
        scratch,
        agentSource,
        agentFallback,
      }),
    );
  }
  return { status: 200, shots: agentSource === "created" && !agentFallback ? orderCreationFirst(shots) : shots };
}

/** Resolve one library slot by its library name (it carries the harness), or null when no feature shot list names it. */
export function findLibrarySlot(filename, { manifestDir } = {}) {
  for (const { entry, shot, harness, key } of libraryShots({ manifestDir })) {
    if (key === filename) {
      return {
        product: entry.product,
        feature: shot.feature,
        filename,
        slotFilename: shot.filename,
        harness,
        expectedLabels: expectedLabelsFor({ steps: [], callouts: shot.callouts || [], instructions: shot.instructions || [] }),
      };
    }
  }
  return null;
}

/** Whether a plain slot name belongs to the library (some harness of it has a library slot): how a lab asks "can this picture be shared". */
export function isLibrarySlotName(filename, { manifestDir } = {}) {
  return libraryShots({ manifestDir }).some(({ shot }) => shot.filename === filename);
}

/** Every library slot by library name with the shot as the feature tour describes it (its kind, caption, and alt text from the slot table): `Map<name, {product, harness, shot}>`. */
export function libraryShotIndex({ manifestDir } = {}) {
  const meta = getSlotMeta();
  const out = new Map();
  for (const { entry, shot, harness, key } of libraryShots({ manifestDir })) {
    if (out.has(key)) continue;
    const slot = meta[shot.filename] || {};
    out.set(key, { product: entry.product, harness, shot: { ...shot, filename: key, slotFilename: shot.filename, product: entry.product, kind: shot.kind || slot.kind, alt: shot.alt || slot.alt, caption: shot.caption || slot.caption } });
  }
  return out;
}