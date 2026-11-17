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

import path from "node:path";

import { capturedImage, capturedScreenshotsDirs, resolveLabScreenshot } from "../lab-builder/captured.js";
import {
  derivePlaywrightSteps,
  ensurePerLabScreenshotPlan,
  resolveGeneratedLabDir,
} from "../lab-builder/lab-screenshots.js";
import { listFeatureManifests } from "../../../tools/screenshot-capture/manifests.mjs";
import { blockedInstructionReason, blockedLabelReason } from "../../../tools/screenshot-capture/guard.mjs";
import { REQUIREMENTS, missingRequirements, targetField } from "../../../tools/screenshot-capture/targets.mjs";
import { classifyShot, expectedLabelsForShot } from "./classify.js";

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

function toPlanShot(src, { authProfile, product, startUrl, steps, callouts, instructions, values = {} }) {
  const urlEnv = /^CAPTURE_[A-Z0-9_]{1,80}$/.test(String(src.urlEnv || "")) ? src.urlEnv : null;
  const capture = classifyShot({ ...src, product: product ?? src.product, callouts, instructions }, { values });
  // A screen the settings already lead to is opened directly, so even a companion that follows only the address lands on it.
  const directUrl = capture.mode !== "manual" ? capture.knownUrl || null : null;
  const effectiveStart = directUrl || startUrl;
  // The page-by-page clicks are gone from the plan: the `capture` descriptor says how to reach the screen, and a
  // companion that does not know it still opens the best address and takes the picture.
  const planSteps = capture.mode === "manual" ? steps : derivePlaywrightSteps({ uiSteps: [], startUrl: effectiveStart, callouts, filename: src.filename, outputPath: src.outputPath });
  // An older companion skips a shot whose tenant address variable is unset, so name the one this shot is waiting for.
  // (A companion that reads `capture` decides for itself; this keeps the older contract.)
  const unmet = capture.mode !== "manual" ? missingRequirements(capture.needs, values) : [];
  const waitingField = unmet.length ? REQUIREMENTS[unmet[0]].fields.map((id) => targetField(id)).find((f) => f?.env) : null;
  const shot = {
    filename: src.filename,
    shotId: src.shotId ?? null,
    featureId: src.featureId ?? src.feature ?? null,
    product: product ?? src.product ?? null,
    authProfile,
    section: text(src.section, 60) || null,
    moduleTitle: text(src.moduleTitle ?? src.featureName, 160) || null,
    caption: text(src.caption, 200) || null,
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
    capture: sanitizeCaptureDescriptor(capture),
  };
  shot.expectedLabels = expectedLabelsFor(shot);
  return shot;
}

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
export function buildLabJobPlan({ generatedRoot, labId, scope, capturedDir = capturedScreenshotsDirs(), values = {} }) {
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
    const missing = !resolveLabScreenshot(found.labDir, shot.filename, { capturedDir });
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
      }),
    );
  }
  return { status: 200, title: shotsPlan.title || labId, labId: found.labId, shots };
}

/** Every filename a lab accepts uploads for. */
export function labSlotFilenames({ generatedRoot, labId, capturedDir = capturedScreenshotsDirs() }) {
  const found = resolveGeneratedLabDir(generatedRoot, labId);
  if (found.status !== 200) return { status: found.status, error: found.error };
  const { shotsPlan } = ensurePerLabScreenshotPlan(found.labDir, { labId: found.labId, capturedDir });
  return { status: 200, labId: found.labId, labDir: found.labDir, shots: shotsPlan.shots || [] };
}

function libraryShots({ manifestDir } = {}) {
  const out = [];
  for (const entry of listFeatureManifests(manifestDir)) {
    if (!entry.manifest) continue;
    for (const shot of entry.manifest.shots || []) {
      out.push({ entry, shot });
    }
  }
  return out;
}

/** Every slot in the shared library (the feature tour's shot lists), with whether a real image exists. */
export function listLibrarySlots({ manifestDir, capturedDir = capturedScreenshotsDirs() } = {}) {
  return libraryShots({ manifestDir }).map(({ entry, shot }) => {
    const image = capturedImage(capturedDir, shot.filename);
    return {
      product: entry.product,
      feature: shot.feature,
      featureName: shot.featureName || null,
      filename: shot.filename,
      section: shot.section || null,
      caption: shot.caption || null,
      manual: Boolean(shot.manual),
      urlEnv: shot.urlEnv || null,
      captured: Boolean(image),
      bytes: image?.size ?? null,
    };
  });
}

/** The shots a shared-library job should capture. Returns `{status: 200, shots}`. */
export function buildLibraryJobPlan({ scope, products = [], manifestDir, capturedDir = capturedScreenshotsDirs(), values = {} }) {
  const productSet = products.length ? new Set(products) : null;
  const shots = [];
  const seen = new Set();
  for (const { entry, shot } of libraryShots({ manifestDir })) {
    if (productSet && !productSet.has(entry.product)) continue;
    if (seen.has(shot.filename)) continue;
    const missing = !capturedImage(capturedDir, shot.filename);
    if (!inScope(scope, { filename: shot.filename, featureId: shot.feature, missing, stale: false })) continue;
    seen.add(shot.filename);
    const startUrl = shot.url || entry.manifest.startUrl;
    shots.push(
      toPlanShot(shot, {
        authProfile: entry.manifest.authProfile || entry.product,
        product: entry.product,
        startUrl,
        steps: derivePlaywrightSteps({
          uiSteps: shot.setup || [],
          startUrl,
          callouts: shot.callouts,
          filename: shot.filename,
          outputPath: path.posix.join("docs/feature-tour/screenshots", shot.filename),
        }),
        callouts: shot.callouts,
        instructions: shot.instructions,
        values,
      }),
    );
  }
  return { status: 200, shots };
}

/** Resolve one library slot by filename, or null when no feature shot list names it. */
export function findLibrarySlot(filename, { manifestDir } = {}) {
  for (const { entry, shot } of libraryShots({ manifestDir })) {
    if (shot.filename === filename) {
      return {
        product: entry.product,
        feature: shot.feature,
        filename,
        expectedLabels: expectedLabelsFor({ steps: [], callouts: shot.callouts || [], instructions: shot.instructions || [] }),
      };
    }
  }
  return null;
}
