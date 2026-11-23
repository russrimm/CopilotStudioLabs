/**
 * Per-lab Playwright screenshot planning, asset resolution, Microsoft Learn
 * drift re-validation, and automated step + screenshot regeneration.
 *
 * Files managed inside each `generated-labs/<labId>/`:
 *  - `screenshots/shots.json`       Structured Playwright step-through manifest
 *  - `screenshots/learn-state.json` Per-module & per-shot Learn baseline + capture state
 *  - `manifest.json`                Summarized under `manifest.screenshots`
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getFeature } from "./catalog.js";
import { capturedImage, capturedScreenshotsDirs, resolveLabScreenshot } from "./captured.js";
import { scrubForbidden } from "./composer.js";
import { renderStandaloneLabHtml } from "./html-lab.js";
import { connect, fetchDocPage } from "./learn-mcp.js";
import { DEFAULT_PRODUCT, productOf } from "./products.js";
import { repairGeneratedLabPlaceholders } from "./placeholder-repair.js";
import { buildShotList } from "./screenshots.js";
import { repairConnectorNames } from "./connector-names.js";
import { MIN_CAPTURED_BYTES, describeSlot, slotsForFeature } from "./slots.js";
import { deriveSteps, diffSteps, isVerifiedCanonicalArticle } from "./steps.js";
import { flattenStepLegacy, joinStep, repairRunOnStep, stepLeadSentence, stepPlainLines, stepToMarkdown, takeSubSteps } from "./sub-steps.js";
import { writeGeneratedLabTopicDocuments } from "./topic-documents.js";
import { writeGeneratedLabTrainingDecks } from "./training-decks.js";
import { validateLabDir } from "../validator.js";
import {
  buildLabCaptureCliCommand,
  runGeneratedLabCapture,
  verifyCapturedImageFile,
} from "../../../tools/screenshot-capture/lab-runner.mjs";
import { blockedInstructionReason, blockedLabelReason } from "../../../tools/screenshot-capture/guard.mjs";
import { cleanExpectedLabel } from "../../../tools/screenshot-capture/labels.mjs";
import { describeShotCapture } from "../capture/classify.js";
import { fileSha256, readRecordsFile, validConfirmation, writeRecordsFile } from "../capture/library-share.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../../..");
const CAPTURE_PRODUCTS_PATH = path.join(REPO_ROOT, "tools", "feature-tour", "capture-products.json");
const OVERLAY_PATH = path.join(REPO_ROOT, "tools", "feature-tour", "overlay.json");

const SAFE_LAB_ID = /^[a-z0-9][a-z0-9-]{0,99}$/i;
const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpe?g|gif|webp)$/i;
const DEFAULT_VIEWPORT = Object.freeze({ width: 1440, height: 900 });

const CLICK_STEP_RE =
  /\b(?:select|choose|click|open|go to|navigate to|switch to|expand|turn on|enable|launch)\b/i;
const INPUT_STEP_RE = /\b(?:enter|type|paste|provide|fill|search for|filter by)\b/i;
const DESTRUCTIVE_STEP_RE =
  /\b(?:delete|remove|erase|purge|destroy|disconnect|unregister|revoke|reset all|delete all)\b/i;

let cachedCaptureProducts = null;
let cachedOverlay = null;

function getCaptureProducts() {
  if (!cachedCaptureProducts) {
    try {
      cachedCaptureProducts = JSON.parse(fs.readFileSync(CAPTURE_PRODUCTS_PATH, "utf8")).products || {};
    } catch {
      cachedCaptureProducts = {};
    }
  }
  return cachedCaptureProducts;
}

function getOverlayByFeature() {
  if (!cachedOverlay) {
    try {
      cachedOverlay = JSON.parse(fs.readFileSync(OVERLAY_PATH, "utf8")).shots || {};
    } catch {
      cachedOverlay = {};
    }
  }
  return cachedOverlay;
}

/**
 * Normalize Microsoft Learn Markdown so transient metadata or whitespace never
 * causes false-positive drift alerts.
 */
export function normalizeDocContent(markdown) {
  let text = String(markdown || "").replace(/\r\n/g, "\n");
  text = text.replace(/^---\n[\s\S]*?\n---\n?/, "");
  text = text
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .filter((line) => !/^(?:ms\.date|last[_ -]?updated|fetchedAt)\s*:/i.test(line.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text;
}

export function hashText(text) {
  return crypto.createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

export function hashContentFingerprint(markdown) {
  const normalized = normalizeDocContent(markdown);
  if (!normalized) return null;
  return hashText(normalized);
}

export function hashSteps(steps) {
  // Sub-steps hash in their old one-sentence form, so a lab built before they had their own lines does not look changed.
  const normalized = (Array.isArray(steps) ? steps : [])
    .map((step) => flattenStepLegacy(step).replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  return hashText(normalized);
}

export function extractDocHeadings(markdown) {
  const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
  const headings = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = line.match(/^(#{1,4})\s+(.+?)\s*$/);
    if (match) {
      headings.push(match[2].replace(/[*_`]/g, "").trim());
    }
  }
  return headings;
}

function extractBoldLabels(stepText) {
  const matches = [...String(stepText || "").matchAll(/\*\*([^*]{1,80})\*\*/g)];
  const seen = new Set();
  const labels = [];
  for (const m of matches) {
    // Labels come from Learn text, which has typos, sentences, and placeholders: keep only usable ones.
    const cleaned = cleanExpectedLabel(m[1]);
    if (!cleaned || seen.has(cleaned.toLowerCase())) continue;
    seen.add(cleaned.toLowerCase());
    labels.push(cleaned);
  }
  return labels;
}

function resolveProductCaptureConfig(productId, section, harness) {
  const products = getCaptureProducts();
  const cfg = products[productId] || products[DEFAULT_PRODUCT] || {};
  const secCfg = (section && cfg.sections?.[section]) || {};

  let defaultStartUrl = cfg.startUrl || "https://copilotstudio.microsoft.com/";
  if (productId === "copilot-studio" && harness === "microsoft-copilot" && section === "copilot-app") {
    defaultStartUrl = "https://m365.cloud.microsoft/chat";
  }

  return {
    authProfile: cfg.authProfile || productId || DEFAULT_PRODUCT,
    startUrl: secCfg.url || defaultStartUrl,
    startUrlEnv: secCfg.urlEnv || cfg.startUrlEnv || null,
    manual: Boolean(secCfg.manual),
    navHint: secCfg.hint || null,
  };
}

/**
 * Build structured Playwright step-through actions from a module's verified UI steps.
 */
export function derivePlaywrightSteps({
  uiSteps = [],
  startUrl,
  callouts = [],
  filename,
  outputPath,
}) {
  const actions = [];
  if (startUrl && /^https?:\/\//i.test(startUrl)) {
    actions.push({
      action: "navigate",
      url: startUrl,
      waitUntil: "domcontentloaded",
    });
  }
  actions.push({
    action: "waitForLoadState",
    state: "networkidle",
    timeoutMs: 8000,
    optional: true,
  });
  actions.push({
    action: "dismissBanners",
    optional: true,
  });

  (Array.isArray(uiSteps) ? uiSteps : []).forEach((rawStep, idx) => {
    const instruction = String(rawStep || "").replace(/\s+/g, " ").trim();
    if (!instruction) return;
    // Never plan a click that signs in or out, switches the account, or deletes something: the person signs in themselves.
    const labels = extractBoldLabels(instruction).filter((label) => !blockedLabelReason(label));
    if (!labels.length || DESTRUCTIVE_STEP_RE.test(instruction) || blockedInstructionReason(instruction)) return;

    if (INPUT_STEP_RE.test(instruction) && !CLICK_STEP_RE.test(instruction)) {
      actions.push({
        action: "probeControl",
        stepIndex: idx + 1,
        instruction,
        labels: labels.slice(0, 3),
        locatorStrategy: ["getByRole", "getByLabel", "getByPlaceholder", "getByText"],
        interaction: "locate",
        optional: true,
      });
      return;
    }

    actions.push({
      action: "stepThrough",
      stepIndex: idx + 1,
      instruction,
      labels: labels.slice(0, 4),
      roles: ["tab", "menuitem", "treeitem", "button", "link"],
      locatorStrategy: ["getByRole", "getByText"],
      interaction: "click-or-focus",
      optional: true,
    });
  });

  if (Array.isArray(callouts) && callouts.length) {
    actions.push({
      action: "probeCallouts",
      callouts: callouts.map((c, idx) => ({
        n: Number.isInteger(c.n) ? c.n : idx + 1,
        label: String(c.label || c.text || `Callout ${idx + 1}`),
        text: String(c.text || c.label || ""),
      })),
    });
  }

  actions.push({
    action: "screenshot",
    filename,
    outputPath,
    fullPage: false,
  });

  return actions;
}

function findOverlaySlot(featureId, filename) {
  const list = getOverlayByFeature()[featureId] || [];
  return list.find((item) => item.filename === filename) || null;
}

function sanitizeSlugToken(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function buildModuleBaseline({ feature, derivedRecord, groundingRecord, generatedAt }) {
  const activeSteps = Array.isArray(derivedRecord?.steps) && derivedRecord.steps.length
    ? derivedRecord.steps
    : Array.isArray(feature?.steps)
    ? feature.steps
    : [];
  const urls = [
    ...(derivedRecord?.url ? [derivedRecord.url] : []),
    ...(Array.isArray(feature?.docUrls) ? feature.docUrls : []),
    ...(Array.isArray(groundingRecord?.sources) ? groundingRecord.sources.map((s) => s.url) : []),
  ].filter((u, idx, arr) => typeof u === "string" && /^https?:\/\//i.test(u) && arr.indexOf(u) === idx);

  const primaryUrl = derivedRecord?.url || feature?.verifiedAgainst || urls[0] || null;
  const contentFingerprint = derivedRecord?.contentFingerprint || null;
  const pageFingerprints =
    derivedRecord?.pageFingerprints && typeof derivedRecord.pageFingerprints === "object"
      ? derivedRecord.pageFingerprints
      : primaryUrl && contentFingerprint
      ? { [primaryUrl]: contentFingerprint }
      : {};

  return {
    urls,
    primaryUrl,
    stepSource: derivedRecord?.source || "catalog-fallback",
    stepReason: derivedRecord?.reason || null,
    steps: [...activeSteps],
    stepHash: hashSteps(activeSteps),
    contentFingerprint,
    pageFingerprints,
    headings: Array.isArray(derivedRecord?.pageHeadings) ? derivedRecord.pageHeadings : [],
    sectionHeading: derivedRecord?.sectionHeading || null,
    verifiedAt: derivedRecord?.fetchedAt || generatedAt || new Date().toISOString(),
  };
}

/**
 * Construct `screenshots/shots.json` and `screenshots/learn-state.json` payloads
 * for a newly built (or reconstructed) generated lab.
 */
export function buildPerLabScreenshotArtifacts({
  labId,
  labDir = null,
  plan,
  screenshots,
  stepsByFeature = new Map(),
  groundingByFeature = new Map(),
  generatedAt = new Date().toISOString(),
  capturedDir = capturedScreenshotsDirs(),
}) {
  const primaryProd = plan.products?.[0] || DEFAULT_PRODUCT;
  const primaryCfg = resolveProductCaptureConfig(primaryProd, "home", plan.harness);
  const perLabShots = [];
  const moduleStates = {};
  const shotStates = {};

  const legacyByFilename = new Map((screenshots?.shots || []).map((s) => [s.filename, s]));

  for (const feature of plan.features || []) {
    const fProduct = productOf(feature);
    const fHarness = plan.harness || feature.harness?.[0] || null;
    const derivedRecord = stepsByFeature.get(feature.id) || null;
    const groundingRecord = groundingByFeature.get(feature.id) || null;
    const learnBaseline = buildModuleBaseline({
      feature,
      derivedRecord,
      groundingRecord,
      generatedAt,
    });

    const sectionNum = feature.prerequisite
      ? (feature.recapOrder ?? feature.order)
      : (feature.stepOrder ?? feature.order);
    const stepLabel =
      feature.stepLabel || (feature.prerequisite ? `Recap ${sectionNum}` : `Step ${sectionNum}`);

    const featureShotsBundle = screenshots?.byFeature?.get(feature.id) || { reused: [], capture: [] };
    const combinedSlots = [
      ...(featureShotsBundle.reused || []).map((item) => ({ ...item, origin: "reused" })),
      ...(featureShotsBundle.capture || []).map((item) => ({ ...item, origin: "slot" })),
    ];

    let moduleHasMissingShot = false;

    for (const item of combinedSlots) {
      const legacy = legacyByFilename.get(item.filename) || null;
      const overlaySlot = findOverlaySlot(feature.id, item.filename);
      const rawCatalogSlot = (slotsForFeature(feature) || []).find((s) => s.filename === item.filename) || overlaySlot || {};
      const section = legacy?.section || rawCatalogSlot.section || "agents";
      const captureCfg = resolveProductCaptureConfig(fProduct, section, fHarness);
      const startUrl = legacy?.url || rawCatalogSlot.url || captureCfg.startUrl;
      const viewport = legacy?.viewport || rawCatalogSlot.viewport || { ...DEFAULT_VIEWPORT };
      const callouts = Array.isArray(rawCatalogSlot.callouts)
        ? rawCatalogSlot.callouts.map((c, idx) => ({
            n: Number.isInteger(c.n) ? c.n : idx + 1,
            label: c.label,
            text: c.text || c.label,
          }))
        : [];
      const outputPath = `generated-labs/${labId}/assets/${item.filename}`;
      const shotId = `${String(feature.order || 1).padStart(2, "0")}-${sanitizeSlugToken(feature.id)}-${sanitizeSlugToken(
        path.basename(item.filename, path.extname(item.filename)),
      )}`;

      const resolvedExisting = labDir
        ? resolveLabScreenshot(labDir, item.filename, { capturedDir })
        : item.origin === "reused" || legacy?.status === "captured"
        ? { source: item.origin === "reused" ? "lab" : "shared" }
        : null;

      const isCaptured = Boolean(resolvedExisting);
      if (!isCaptured) moduleHasMissingShot = true;

      const pwSteps = derivePlaywrightSteps({
        uiSteps: learnBaseline.steps,
        startUrl,
        callouts,
        filename: item.filename,
        outputPath,
      });

      perLabShots.push({
        id: perLabShots.length + 1,
        shotId,
        moduleOrder: feature.order,
        stepLabel,
        feature: feature.id,
        featureId: feature.id,
        moduleTitle: feature.name,
        product: fProduct,
        harness: fHarness,
        authProfile: captureCfg.authProfile,
        section,
        labSection: `${stepLabel} - ${feature.name}`,
        figure: item.figure || legacy?.figure || `${sectionNum}.1`,
        kind: item.kind || legacy?.kind || "ui-location",
        origin: item.origin,
        status: isCaptured ? "captured" : "pending",
        filename: item.filename,
        outputPath,
        startUrl,
        url: startUrl,
        urlEnv: rawCatalogSlot.urlEnv || captureCfg.startUrlEnv || null,
        manual: Boolean(rawCatalogSlot.manual ?? captureCfg.manual),
        navHint: rawCatalogSlot.navHint || captureCfg.navHint || null,
        viewport,
        alt: item.alt || legacy?.alt || describeSlot(feature, { filename: item.filename }).alt,
        caption: item.caption || legacy?.caption || feature.name,
        instructions:
          item.instructions ||
          legacy?.instructions ||
          learnBaseline.steps.slice(0, 5).map(stepLeadSentence) ||
          [`Capture the ${feature.name} screen.`],
        callouts,
        steps: pwSteps,
        learnBaseline: {
          urls: learnBaseline.urls,
          primaryUrl: learnBaseline.primaryUrl,
          stepSource: learnBaseline.stepSource,
          stepHash: learnBaseline.stepHash,
          contentFingerprint: learnBaseline.contentFingerprint,
          sectionHeading: learnBaseline.sectionHeading,
          verifiedAt: learnBaseline.verifiedAt,
        },
      });

      shotStates[item.filename] = {
        shotId,
        featureId: feature.id,
        moduleOrder: feature.order,
        filename: item.filename,
        captured: isCaptured,
        capturedAt: isCaptured ? generatedAt : null,
        capturedStepHash: isCaptured ? learnBaseline.stepHash : null,
        capturedContentFingerprint: isCaptured ? learnBaseline.contentFingerprint : null,
        captureSource: isCaptured ? (resolvedExisting.source === "shared" ? "feature-tour" : "reused") : null,
        stale: false,
        lastAttemptStatus: null,
        lastAttemptAt: null,
        lastError: null,
      };
    }

    moduleStates[feature.id] = {
      featureId: feature.id,
      moduleOrder: feature.order,
      stepLabel,
      moduleTitle: feature.name,
      product: fProduct,
      harness: fHarness,
      shotFilenames: combinedSlots.map((s) => s.filename),
      learnBaseline,
      status: moduleHasMissingShot ? "missing-screenshot" : "up-to-date",
      lastCheckedAt: learnBaseline.stepSource === "doc-derived" ? generatedAt : null,
      diff: null,
    };
  }

  const shotsPlan = {
    schema: 1,
    kind: "generated-lab",
    lab: labId,
    labId,
    title: plan.title,
    product: primaryProd,
    products: plan.products || [primaryProd],
    harness: plan.harness || null,
    authProfile: primaryCfg.authProfile,
    assetsDir: "../assets",
    startUrl: primaryCfg.startUrl,
    startUrlEnv: primaryCfg.startUrlEnv,
    generatedAt,
    updatedAt: generatedAt,
    shots: perLabShots,
  };

  const learnState = {
    schema: 1,
    labId,
    generatedAt,
    updatedAt: generatedAt,
    lastRevalidatedAt: null,
    learnSyncStatus: "baseline",
    modules: moduleStates,
    shots: shotStates,
  };

  return { shotsPlan, learnState };
}

function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, filePath);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Write `screenshots/shots.json` and `screenshots/learn-state.json` inside `labDir`
 * and enrich `manifest.screenshots` with plan/state summary metadata.
 */
export function writePerLabScreenshotArtifacts(labDir, { shotsPlan, learnState, manifest }) {
  const screenshotsDir = path.join(labDir, "screenshots");
  fs.mkdirSync(screenshotsDir, { recursive: true });
  writeJsonAtomic(path.join(screenshotsDir, "shots.json"), shotsPlan);
  writeJsonAtomic(path.join(screenshotsDir, "learn-state.json"), learnState);

  if (manifest && typeof manifest === "object") {
    applyScreenshotSummaryToManifest(manifest, labDir, { shotsPlan, learnState });
  }
}

export function applyScreenshotSummaryToManifest(
  manifest,
  labDir,
  { shotsPlan = null, learnState = null, capturedDir = capturedScreenshotsDirs() } = {},
) {
  if (!manifest || typeof manifest !== "object") return;
  const existing = manifest.screenshots && typeof manifest.screenshots === "object" ? manifest.screenshots : {};
  const shots = Array.isArray(shotsPlan?.shots) ? shotsPlan.shots : [];
  let reusedCount = existing.reused ?? 0;
  let slotCaptured = 0;
  let slotPending = 0;
  let staleCount = 0;

  if (shots.length > 0) {
    reusedCount = shots.filter((s) => s.origin === "reused").length;
    for (const shot of shots) {
      const resolved = labDir ? resolveLabScreenshot(labDir, shot.filename, { capturedDir }) : null;
      const isCaptured = resolved ? true : shot.status === "captured";
      if (shot.origin !== "reused") {
        if (isCaptured) slotCaptured += 1;
        else slotPending += 1;
      }
      const sState = learnState?.shots?.[shot.filename];
      const mState = learnState?.modules?.[shot.featureId || shot.feature];
      if (sState?.stale || mState?.status === "docs-updated") staleCount += 1;
    }
  } else {
    slotCaptured = existing.captured ?? 0;
    slotPending = existing.pending ?? existing.toCapture ?? 0;
  }

  manifest.screenshots = {
    ...existing,
    reused: reusedCount,
    captured: slotCaptured,
    pending: slotPending,
    toCapture: slotPending,
    total: reusedCount + slotCaptured + slotPending,
    labShotCount: shots.length,
    stale: staleCount,
    planPath: "screenshots/shots.json",
    learnStatePath: "screenshots/learn-state.json",
    learnSyncStatus: learnState?.learnSyncStatus || existing.learnSyncStatus || "baseline",
    lastRevalidatedAt: learnState?.lastRevalidatedAt || existing.lastRevalidatedAt || null,
  };
}

/**
 * Reconstruct `screenshots/shots.json` and `screenshots/learn-state.json` on demand
 * for any generated lab built prior to per-lab screenshot state tracking.
 */
export function ensurePerLabScreenshotPlan(labDir, { labId: explicitLabId, capturedDir = capturedScreenshotsDirs() } = {}) {
  const resolvedDir = path.resolve(labDir);
  const labId = explicitLabId || path.basename(resolvedDir);
  const shotsJsonPath = path.join(resolvedDir, "screenshots", "shots.json");
  const learnStatePath = path.join(resolvedDir, "screenshots", "learn-state.json");
  if (fs.existsSync(shotsJsonPath) && fs.existsSync(learnStatePath)) {
    return {
      shotsPlan: JSON.parse(fs.readFileSync(shotsJsonPath, "utf8")),
      learnState: JSON.parse(fs.readFileSync(learnStatePath, "utf8")),
    };
  }

  const manifestPath = path.join(resolvedDir, "manifest.json");
  const manifest = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    : { title: labId, modules: [] };
  const markdown = fs.existsSync(path.join(resolvedDir, "index.md"))
    ? fs.readFileSync(path.join(resolvedDir, "index.md"), "utf8")
    : "";
  const legacyShots = fs.existsSync(path.join(resolvedDir, "shots.json"))
    ? JSON.parse(fs.readFileSync(path.join(resolvedDir, "shots.json"), "utf8")).shots || []
    : [];

  const features = [];
  const stepsByFeature = new Map();
  const groundingByFeature = new Map();
  const byFeature = new Map();

  for (const mod of manifest.modules || []) {
    const cat = getFeature(mod.id) || {
      id: mod.id,
      name: mod.name,
      product: mod.product || manifest.product || DEFAULT_PRODUCT,
      steps: [],
      docUrls: (mod.sources || []).map((s) => s.url).filter(Boolean),
      screenshots: [],
    };
    const mergedFeature = {
      ...cat,
      order: mod.order,
      stepOrder: mod.stepOrder ?? null,
      recapOrder: mod.recapOrder ?? null,
      stepLabel: mod.stepLabel,
      prerequisite: mod.role === "prerequisite",
    };
    features.push(mergedFeature);

    const extractedSteps = extractModuleStepsFromMarkdown(markdown, mod) || cat.steps || [];
    stepsByFeature.set(mod.id, {
      source: mod.steps?.source || "catalog-fallback",
      reason: mod.steps?.reason || null,
      url: mod.steps?.url || cat.verifiedAgainst || cat.docUrls?.[0] || null,
      fetchedAt: mod.steps?.fetchedAt || manifest.generatedAt || null,
      sectionHeading: mod.steps?.sectionHeading || null,
      steps: extractedSteps,
    });
    groundingByFeature.set(mod.id, { sources: mod.sources || [] });

    const modLegacy = legacyShots.filter((s) => s.feature === mod.id);
    byFeature.set(mod.id, {
      reused: [],
      capture: modLegacy.map((s) => ({
        filename: s.filename,
        caption: s.caption,
        alt: s.alt,
        kind: s.kind,
        figure: s.figure,
        instructions: s.instructions,
        pending: s.status !== "captured",
      })),
    });
  }

  const artifacts = buildPerLabScreenshotArtifacts({
    labId,
    labDir: resolvedDir,
    plan: {
      title: manifest.title || labId,
      products: manifest.products || [manifest.product || DEFAULT_PRODUCT],
      harness: manifest.differences?.labHarness || manifest.request?.harness || null,
      features,
    },
    screenshots: { byFeature, shots: legacyShots },
    stepsByFeature,
    groundingByFeature,
    generatedAt: manifest.generatedAt || new Date().toISOString(),
    capturedDir,
  });

  writePerLabScreenshotArtifacts(resolvedDir, { ...artifacts, manifest });
  writeJsonAtomic(manifestPath, manifest);
  return artifacts;
}

function findModuleHeadingBounds(lines, mod) {
  const stepLabel =
    mod.stepLabel ||
    (mod.role === "prerequisite"
      ? `Recap ${mod.recapOrder ?? mod.order}`
      : `Step ${mod.stepOrder ?? mod.order}`);
  const escapedLabel = stepLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headingRe = new RegExp(`^###\\s+${escapedLabel}\\s+-\\s+`, "i");
  const startIdx = lines.findIndex((line) => headingRe.test(line));
  if (startIdx < 0) return null;
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    if (/^#{2,3}\s+/.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  return { startIdx, endIdx };
}

export function extractModuleStepsFromMarkdown(markdown, mod) {
  const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
  const bounds = findModuleHeadingBounds(lines, mod);
  if (!bounds) return null;
  const doThisIdx = lines.findIndex(
    (line, idx) => idx > bounds.startIdx && idx < bounds.endIdx && line.trim() === "**Do this**",
  );
  if (doThisIdx < 0) return null;

  const steps = [];
  let startedList = false;
  for (let i = doThisIdx + 1; i < bounds.endIdx; i += 1) {
    const trimmed = lines[i].trim();
    const m = trimmed.match(/^\d+\.\s+(.+)$/);
    if (m) {
      startedList = true;
      // A step's lettered sub-steps (indented lines under it) are part of the step.
      const sub = takeSubSteps(lines, i + 1);
      steps.push(joinStep(m[1].trim(), sub.items, sub.note));
      i = sub.next - 1;
      continue;
    }
    if (startedList && !trimmed) break;
  }
  return steps.length ? steps : null;
}

/**
 * Replace a single module's `**Do this**` provenance line and numbered UI steps
 * inside `index.md` while keeping the rest of the lab untouched.
 */
export function updateLabModuleStepsInMarkdown(
  markdown,
  { mod, newSteps, sectionHeading, url, fetchedAt },
) {
  const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
  const bounds = findModuleHeadingBounds(lines, mod);
  if (!bounds || !Array.isArray(newSteps) || !newSteps.length) return markdown;

  const doThisIdx = lines.findIndex(
    (line, idx) => idx > bounds.startIdx && idx < bounds.endIdx && line.trim() === "**Do this**",
  );
  if (doThisIdx < 0) return markdown;

  let firstStepIdx = -1;
  let afterStepsIdx = -1;
  for (let i = doThisIdx + 1; i < bounds.endIdx; i += 1) {
    const trimmed = lines[i].trim();
    if (/^\d+\.\s+/.test(trimmed)) {
      if (firstStepIdx < 0) firstStepIdx = i;
      // The step's lettered sub-steps go with it, so they are replaced and never left behind.
      i = takeSubSteps(lines, i + 1).next - 1;
      afterStepsIdx = i + 1;
      continue;
    }
    if (firstStepIdx >= 0 && trimmed === "") {
      afterStepsIdx = i;
      break;
    }
    if (firstStepIdx >= 0) {
      afterStepsIdx = i;
      break;
    }
  }
  if (firstStepIdx < 0) return markdown;

  const heading = sectionHeading ? scrubForbidden(sectionHeading) : "the current documentation";
  const day = fetchedAt ? String(fetchedAt).slice(0, 10) : new Date().toISOString().slice(0, 10);
  const link = url ? `[${heading}](${url})` : heading;
  const replacementBlock = [
    "**Do this**",
    "",
    `*Read from ${link} on ${day}.*`,
    "",
    ...newSteps.map((s, idx) => stepToMarkdown(scrubForbidden(s), idx + 1)),
  ];

  const updated = [
    ...lines.slice(0, doThisIdx),
    ...replacementBlock,
    ...lines.slice(afterStepsIdx),
  ];
  return updated.join("\n");
}

function fileToDataUri(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const ext = path.extname(filePath).toLowerCase();
    const mime =
      ext === ".png"
        ? "image/png"
        : ext === ".jpg" || ext === ".jpeg"
        ? "image/jpeg"
        : ext === ".webp"
        ? "image/webp"
        : null;
    if (!mime) return null;
    const buf = fs.readFileSync(filePath);
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

/**
 * Regenerate all derived files inside `generated-labs/<labId>/` after screenshots
 * or Microsoft Learn module steps are updated:
 *   - `index.html` (with inline data URIs for real captured PNGs)
 *   - `topics/*.docx` and `topics/*.pptx`
 *   - `shots.json` and `SHOTLIST.md`
 *   - `manifest.json` (`screenshots` + `validation`)
 */
export function refreshGeneratedLabOutputs(
  labDir,
  { labId: explicitLabId, markdown: explicitMarkdown, manifest: explicitManifest, capturedDir = capturedScreenshotsDirs() } = {},
) {
  const resolvedDir = path.resolve(labDir);
  const labId = explicitLabId || path.basename(resolvedDir);
  const indexPath = path.join(resolvedDir, "index.md");
  const manifestPath = path.join(resolvedDir, "manifest.json");
  const markdown = explicitMarkdown ?? fs.readFileSync(indexPath, "utf8");
  const manifest = explicitManifest ?? JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  if (explicitMarkdown !== undefined) {
    fs.writeFileSync(indexPath, markdown, "utf8");
  }

  const standaloneHtml = renderStandaloneLabHtml(markdown, {
    title: manifest.title || labId,
    labId,
    resolveImageSrc: (assetName) => {
      const resolved = resolveLabScreenshot(resolvedDir, assetName, { capturedDir });
      if (resolved?.file) {
        const uri = fileToDataUri(resolved.file);
        if (uri) return uri;
      }
      return `assets/${assetName}`;
    },
  });
  fs.writeFileSync(path.join(resolvedDir, "index.html"), standaloneHtml, "utf8");

  writeGeneratedLabTopicDocuments(resolvedDir, {
    labId,
    markdown,
    manifest,
  });
  // A changed Microsoft Learn page makes the training decks stale the same way it does the lab text: rebuild them now.
  try {
    writeGeneratedLabTrainingDecks(resolvedDir, { labId, markdown, manifest });
  } catch {
    /* they are built again the next time someone asks for one */
  }

  // Sync legacy root `shots.json` & `SHOTLIST.md` if present
  const rootShotsPath = path.join(resolvedDir, "shots.json");
  if (fs.existsSync(rootShotsPath)) {
    try {
      const rootShots = JSON.parse(fs.readFileSync(rootShotsPath, "utf8"));
      for (const shot of rootShots.shots || []) {
        const resolved = resolveLabScreenshot(resolvedDir, shot.filename, { capturedDir });
        shot.status = resolved ? "captured" : "pending";
      }
      writeJsonAtomic(rootShotsPath, rootShots);
      const shotlistPath = path.join(resolvedDir, "SHOTLIST.md");
      if ((rootShots.shots || []).some((s) => s.status !== "captured")) {
        fs.writeFileSync(
          shotlistPath,
          buildShotList({ title: manifest.title || labId }, rootShots.shots),
          "utf8",
        );
      } else if (fs.existsSync(shotlistPath)) {
        fs.rmSync(shotlistPath, { force: true });
      }
    } catch {
      // Non-fatal if legacy shots.json was customized.
    }
  }

  const { shotsPlan, learnState } = ensurePerLabScreenshotPlan(resolvedDir, { labId, capturedDir });
  applyScreenshotSummaryToManifest(manifest, resolvedDir, { shotsPlan, learnState, capturedDir });

  const validation = validateLabDir(resolvedDir, { labId, title: manifest.title || labId });
  manifest.validation = {
    passed: validation.passed,
    failed: validation.failed,
    checkedAt: new Date().toISOString(),
  };
  manifest.updatedAt = new Date().toISOString();
  writeJsonAtomic(manifestPath, manifest);

  return { labId, manifest, validation };
}

const repairChecked = new Map();

/**
 * Repair a generated lab built while placeholder pictures counted as captured screenshots: each filler picture in
 * `assets/` becomes the standard pending image, its slot becomes a pending slot, and the lab's derived outputs are
 * regenerated. A lab with nothing to repair is not written. Never throws, so a read can always go on.
 *
 * @param {object} [options]
 * @param {boolean} [options.dryRun] report what would change and write nothing
 * @param {number} [options.maxAgeMs] skip the check when this lab was checked that recently (for list views)
 */
export function repairLabPlaceholders(labDir, { labId: explicitLabId, capturedDir = capturedScreenshotsDirs(), dryRun = false, maxAgeMs = 0 } = {}) {
  const resolvedDir = path.resolve(labDir);
  const labId = explicitLabId || path.basename(resolvedDir);
  const none = { changed: false, placeholders: [], slots: [] };
  if (maxAgeMs > 0) {
    const last = repairChecked.get(resolvedDir);
    if (last && Date.now() - last < maxAgeMs) return none;
    repairChecked.set(resolvedDir, Date.now());
  }
  try {
    return repairGeneratedLabPlaceholders(resolvedDir, {
      dryRun,
      loadPlan: () => ensurePerLabScreenshotPlan(resolvedDir, { labId, capturedDir }),
      refreshOutputs: () => refreshGeneratedLabOutputs(resolvedDir, { labId, capturedDir }),
    });
  } catch (err) {
    return { ...none, error: err.message };
  }
}

function resolveSafeLabDir(generatedRoot, rawLabId) {
  const labId = String(rawLabId || "").trim();
  if (!SAFE_LAB_ID.test(labId)) return { status: 400, error: "Invalid lab id" };
  const root = path.resolve(generatedRoot);
  const labDir = path.resolve(root, labId);
  const rel = path.relative(root, labDir);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || rel !== labId) {
    return { status: 400, error: "Invalid lab id" };
  }
  try {
    const stat = fs.lstatSync(labDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return { status: 404, error: "Generated lab not found" };
    }
  } catch {
    return { status: 404, error: "Generated lab not found" };
  }
  if (!fs.existsSync(path.join(labDir, "manifest.json"))) {
    return { status: 404, error: "Generated lab not found" };
  }
  return { status: 200, labId, labDir };
}

/** Validate a lab id and locate its folder: `{status: 200, labId, labDir}` or `{status, error}`. */
export const resolveGeneratedLabDir = resolveSafeLabDir;

const DEFAULT_CAPTURE_CAPABILITIES = Object.freeze({
  companionConnected: false,
  companionLastSeenAt: null,
  serverBrowserAvailable: false,
  tenantUrlsSet: false,
  signedInProducts: [],
});
let captureCapabilitiesProvider = null;
let captureTargetsProvider = null;
let sharedLibraryProvider = null;

/** The capture platform registers a callback so status payloads can say whether a companion is connected. */
export function setCaptureCapabilitiesProvider(provider) {
  captureCapabilitiesProvider = typeof provider === "function" ? provider : null;
}

/** The capture platform registers a callback that returns the capture settings in effect for a lab (addresses and names). */
export function setCaptureTargetsProvider(provider) {
  captureTargetsProvider = typeof provider === "function" ? provider : null;
}

/**
 * The capture platform registers the shared library's view for status payloads: `{ isSlot(filename), records() }`, where
 * `records()` returns the library's `{ shots, confirmations }`. Without it, a lab's status carries no sharing details.
 */
export function setSharedLibraryProvider(provider) {
  sharedLibraryProvider = provider && typeof provider.isSlot === "function" && typeof provider.records === "function" ? provider : null;
}

function currentSharedLibrary() {
  try {
    const records = sharedLibraryProvider?.records();
    return sharedLibraryProvider ? { isSlot: (name) => Boolean(sharedLibraryProvider.isSlot(name)), shots: records?.shots || {}, confirmations: records?.confirmations || {} } : null;
  } catch {
    return null;
  }
}

function currentCaptureTargets(labId) {
  try {
    const values = captureTargetsProvider?.(labId);
    return values && typeof values === "object" ? values : {};
  } catch {
    return {};
  }
}

function currentCaptureCapabilities() {
  try {
    const live = captureCapabilitiesProvider?.();
    return live && typeof live === "object" ? { ...DEFAULT_CAPTURE_CAPABILITIES, ...live } : { ...DEFAULT_CAPTURE_CAPABILITIES };
  } catch {
    return { ...DEFAULT_CAPTURE_CAPABILITIES };
  }
}

/** "What to show" lines for a shot, as plain short strings the Screenshot Center can display. */
export function instructionList(value) {
  const lines = Array.isArray(value) ? value : typeof value === "string" ? value.split(/\r?\n/) : [];
  // A step with lettered sub-steps (or the old one-sentence form of it) shows each sub-step on its own line.
  const expanded = lines.flatMap((line) => {
    const text = String(line ?? "");
    const fixed = repairRunOnStep(text) ?? text;
    return fixed.includes("\n") ? stepPlainLines(fixed) : [text];
  });
  return expanded
    .map((line) => repairConnectorNames(String(line ?? "").replace(/\s+/g, " ").trim().slice(0, 300)))
    .filter(Boolean)
    .slice(0, 8);
}

const VERIFICATION_FILE = "verification.json";
const labRecordsFile = (labDir) => path.join(labDir, "screenshots", VERIFICATION_FILE);

/** Per-shot verification records written when a screenshot is uploaded, pasted, or captured by the companion. */
export function readLabVerification(labDir) {
  try {
    return readRecordsFile(labRecordsFile(labDir)).shots;
  } catch {
    return {};
  }
}

/** Store (or clear, with `null`) one shot's verification record. Confirmations in the same file are kept. */
export function writeLabVerificationRecord(labDir, filename, record) {
  const file = labRecordsFile(labDir);
  const { shots, confirmations } = readRecordsFile(file);
  if (record) shots[filename] = record;
  else delete shots[filename];
  writeRecordsFile(file, { shots, confirmations });
}

/** Per-shot "Mark as accurate" confirmations for the lab's own pictures: `{ [filename]: { sha256, at, by? } }`. */
export function readLabConfirmations(labDir) {
  try {
    return readRecordsFile(labRecordsFile(labDir)).confirmations;
  } catch {
    return {};
  }
}

/** Store (or clear, with `null`) one shot's confirmation. */
export function writeLabConfirmation(labDir, filename, confirmation) {
  const file = labRecordsFile(labDir);
  const { shots, confirmations } = readRecordsFile(file);
  if (confirmation) confirmations[filename] = confirmation;
  else if (!(filename in confirmations)) return;
  else delete confirmations[filename];
  writeRecordsFile(file, { shots, confirmations });
}

function recomputeLearnSync(labDir, shotsPlan, learnState, capturedDir) {
  const stillUpdated = Object.values(learnState.modules || {}).some((m) => m.status === "docs-updated");
  const stillMissing = (shotsPlan.shots || []).some((s) => !resolveLabScreenshot(labDir, s.filename, { capturedDir }));
  learnState.learnSyncStatus = stillUpdated ? "docs-updated" : stillMissing ? "missing-screenshot" : "up-to-date";
}

/**
 * Record that a real image now sits at `assets/<filename>`: clear the shot's
 * stale flag, mark its module up to date when every shot in it is fresh, and
 * recompute the lab's Learn sync status. Call `refreshGeneratedLabOutputs` next.
 */
export function recordLabShotCaptured(
  labDir,
  { labId: explicitLabId, filename, source = "companion", capturedAt = new Date().toISOString(), capturedDir = capturedScreenshotsDirs() } = {},
) {
  const resolvedDir = path.resolve(labDir);
  const labId = explicitLabId || path.basename(resolvedDir);
  const { shotsPlan, learnState } = ensurePerLabScreenshotPlan(resolvedDir, { labId, capturedDir });
  const shot = (shotsPlan.shots || []).find((s) => s.filename === filename);
  if (!shot) return { ok: false, error: "That screenshot is not part of this lab." };
  const featureId = shot.featureId || shot.feature;

  shot.status = "captured";
  shot.capturedAt = capturedAt;
  learnState.shots ??= {};
  learnState.shots[filename] = {
    ...(learnState.shots[filename] || {}),
    shotId: shot.shotId,
    featureId,
    moduleOrder: shot.moduleOrder ?? null,
    filename,
    captured: true,
    capturedAt,
    capturedStepHash: shot.learnBaseline?.stepHash || null,
    capturedContentFingerprint: shot.learnBaseline?.contentFingerprint || null,
    captureSource: source,
    stale: false,
    lastAttemptStatus: "captured",
    lastAttemptAt: capturedAt,
    lastError: null,
  };

  const mod = learnState.modules?.[featureId];
  if (mod) {
    const moduleShots = (shotsPlan.shots || []).filter((s) => (s.featureId || s.feature) === featureId);
    const allFresh = moduleShots.every(
      (s) => !learnState.shots?.[s.filename]?.stale && resolveLabScreenshot(resolvedDir, s.filename, { capturedDir }),
    );
    if (allFresh) {
      mod.status = "up-to-date";
      mod.diff = null;
    } else if (mod.status !== "docs-updated") {
      mod.status = "missing-screenshot";
    }
  }

  recomputeLearnSync(resolvedDir, shotsPlan, learnState, capturedDir);
  shotsPlan.updatedAt = capturedAt;
  learnState.updatedAt = capturedAt;
  writeJsonAtomic(path.join(resolvedDir, "screenshots", "shots.json"), shotsPlan);
  writeJsonAtomic(path.join(resolvedDir, "screenshots", "learn-state.json"), learnState);
  return { ok: true, featureId };
}

/** Record that a shot was reset to the placeholder so it can be retaken. */
export function recordLabShotReset(labDir, { labId: explicitLabId, filename, capturedDir = capturedScreenshotsDirs() } = {}) {
  const resolvedDir = path.resolve(labDir);
  const labId = explicitLabId || path.basename(resolvedDir);
  const { shotsPlan, learnState } = ensurePerLabScreenshotPlan(resolvedDir, { labId, capturedDir });
  const shot = (shotsPlan.shots || []).find((s) => s.filename === filename);
  if (!shot) return { ok: false, error: "That screenshot is not part of this lab." };
  const featureId = shot.featureId || shot.feature;
  const stillResolves = Boolean(resolveLabScreenshot(resolvedDir, filename, { capturedDir }));

  shot.status = stillResolves ? "captured" : "pending";
  learnState.shots ??= {};
  learnState.shots[filename] = {
    ...(learnState.shots[filename] || {}),
    shotId: shot.shotId,
    featureId,
    filename,
    captured: stillResolves,
    capturedAt: stillResolves ? learnState.shots[filename]?.capturedAt || null : null,
    captureSource: stillResolves ? learnState.shots[filename]?.captureSource || null : null,
    lastAttemptStatus: "reset",
    lastAttemptAt: new Date().toISOString(),
  };
  const mod = learnState.modules?.[featureId];
  if (mod && !stillResolves && mod.status !== "docs-updated") mod.status = "missing-screenshot";

  recomputeLearnSync(resolvedDir, shotsPlan, learnState, capturedDir);
  shotsPlan.updatedAt = learnState.updatedAt = new Date().toISOString();
  writeJsonAtomic(path.join(resolvedDir, "screenshots", "shots.json"), shotsPlan);
  writeJsonAtomic(path.join(resolvedDir, "screenshots", "learn-state.json"), learnState);
  return { ok: true, featureId, stillResolves };
}

const firstDate = (...values) => values.find((v) => typeof v === "string" && Number.isFinite(Date.parse(v))) || null;

/**
 * Where a lab's picture comes from and how it is shared: `imageSource` ("lab" or "library"), the date it was captured,
 * whether a person confirmed it, and how it relates to the shared library's picture for the same slot.
 */
function describePictureSharing({ shot, resolved, verification, learnShot, labConfirmations, library, capturedDir }) {
  const none = { imageSource: null, imageCapturedAt: null, confirmed: null, share: null };
  if (!resolved) return none;
  const fromLibrary = resolved.source === "shared";
  const record = fromLibrary ? library?.shots?.[shot.filename] : verification;
  const confirmation = fromLibrary ? library?.confirmations?.[shot.filename] : labConfirmations?.[shot.filename];
  let mtime = null;
  try {
    mtime = fs.statSync(resolved.file).mtime.toISOString();
  } catch {
    mtime = null;
  }
  const out = {
    imageSource: fromLibrary ? "library" : "lab",
    imageCapturedAt: firstDate(record?.acceptedAt, fromLibrary ? null : learnShot?.capturedAt, mtime),
    confirmed: confirmation ? validConfirmation(confirmation, fileSha256(resolved.file)) : null,
    share: null,
  };
  if (!library) return out;
  if (!library.isSlot(shot.filename)) return { ...out, share: { state: "lab-only" } };
  if (fromLibrary) return { ...out, share: { state: "shared", libraryConfirmed: Boolean(out.confirmed) } };
  const libraryImage = capturedImage(capturedDir, shot.filename);
  if (!libraryImage) return { ...out, share: { state: "not-shared", libraryConfirmed: false } };
  const librarySha = fileSha256(libraryImage.file);
  return {
    ...out,
    share: {
      state: librarySha && librarySha === fileSha256(resolved.file) ? "shared" : "differs",
      libraryConfirmed: Boolean(validConfirmation(library.confirmations?.[shot.filename], librarySha)),
    },
  };
}

/**
 * Inspect per-lab screenshot manifest, captured/missing/stale counts, and
 * Microsoft Learn sync status (`GET /api/lab-builder/generated/:labId/screenshots`).
 */
export function getLabScreenshotsStatus(
  generatedRoot,
  rawLabId,
  { capturedDir = capturedScreenshotsDirs() } = {},
) {
  const found = resolveSafeLabDir(generatedRoot, rawLabId);
  if (found.status !== 200) return { status: found.status, body: { error: found.error } };

  const { labId, labDir } = found;
  repairLabPlaceholders(labDir, { labId, capturedDir });
  const { shotsPlan, learnState } = ensurePerLabScreenshotPlan(labDir, { labId, capturedDir });
  const verificationRecords = readLabVerification(labDir);
  const labConfirmations = readLabConfirmations(labDir);
  const library = currentSharedLibrary();
  const captureValues = currentCaptureTargets(labId);

  const shots = (shotsPlan.shots || []).map((shot) => {
    const perLabOk = verifyCapturedImageFile(path.join(labDir, "assets", shot.filename)).ok;
    const resolved = resolveLabScreenshot(labDir, shot.filename, { capturedDir });
    const sState = learnState.shots?.[shot.filename] || {};
    const mState = learnState.modules?.[shot.featureId || shot.feature] || {};
    const docsUpdated = mState.status === "docs-updated" || Boolean(sState.stale);
    const hasScreenshot = Boolean(resolved);
    const verification = verificationRecords[shot.filename] || null;
    const sharing = describePictureSharing({ shot, resolved, verification, learnShot: sState, labConfirmations, library, capturedDir });

    const syncStatus = docsUpdated
      ? "docs-updated"
      : hasScreenshot
      ? "up-to-date"
      : "missing-screenshot";

    return {
      id: shot.id,
      shotId: shot.shotId,
      moduleOrder: shot.moduleOrder,
      stepLabel: shot.stepLabel,
      featureId: shot.featureId || shot.feature,
      moduleTitle: shot.moduleTitle,
      product: shot.product,
      harness: shot.harness,
      section: shot.section,
      figure: shot.figure,
      kind: shot.kind,
      origin: shot.origin || "slot",
      filename: shot.filename,
      outputPath: shot.outputPath,
      assetUrl: `/api/lab-builder/generated/${labId}/assets/${shot.filename}`,
      startUrl: shot.startUrl,
      manual: Boolean(shot.manual),
      navHint: repairConnectorNames(shot.navHint || "") || null,
      alt: repairConnectorNames(shot.alt),
      caption: repairConnectorNames(shot.caption),
      instructions: instructionList(shot.instructions),
      stepCount: Array.isArray(shot.steps) ? shot.steps.length : 0,
      captured: hasScreenshot,
      capturedInLab: perLabOk,
      capturedSource: resolved?.source || null,
      stale: docsUpdated,
      syncStatus,
      checkState: docsUpdated ? "docs-updated" : mState.lastCheckedAt ? "up-to-date" : "not-checked",
      capturedAt: hasScreenshot ? sState.capturedAt || null : null,
      captureSource: hasScreenshot ? sState.captureSource || null : null,
      lastAttemptStatus: sState.lastAttemptStatus || null,
      lastError: sState.lastError || null,
      verification,
      needsReview: verification?.state === "needs-review",
      ...sharing,
      learnBaseline: shot.learnBaseline || null,
      // How this shot is captured under the settings in effect, so the Screenshot Center can say why.
      capture: describeShotCapture({ ...shot, product: shot.product }, captureValues),
    };
  });

  const modules = Object.values(learnState.modules || {})
    .sort((a, b) => Number(a.moduleOrder || 0) - Number(b.moduleOrder || 0))
    .map((mod) => {
      const moduleShots = shots.filter((s) => s.featureId === mod.featureId);
      const anyDocsUpdated =
        mod.status === "docs-updated" || moduleShots.some((s) => s.syncStatus === "docs-updated");
      const anyMissing = moduleShots.some((s) => !s.captured);
      const status = anyDocsUpdated
        ? "docs-updated"
        : anyMissing
        ? "missing-screenshot"
        : "up-to-date";
      return {
        featureId: mod.featureId,
        moduleOrder: mod.moduleOrder,
        stepLabel: mod.stepLabel,
        moduleTitle: mod.moduleTitle,
        product: mod.product,
        harness: mod.harness,
        status,
        checkState: anyDocsUpdated ? "docs-updated" : mod.lastCheckedAt ? "up-to-date" : "not-checked",
        lastCheckedAt: mod.lastCheckedAt || null,
        primaryUrl: mod.learnBaseline?.primaryUrl || null,
        stepHash: mod.learnBaseline?.stepHash || null,
        contentFingerprint: mod.learnBaseline?.contentFingerprint || null,
        verifiedAt: mod.learnBaseline?.verifiedAt || null,
        diff: mod.diff || null,
        shotCount: moduleShots.length,
        capturedCount: moduleShots.filter((s) => s.captured).length,
      };
    });

  const capturedCount = shots.filter((s) => s.captured).length;
  const capturedInLabCount = shots.filter((s) => s.capturedInLab).length;
  const missingCount = shots.filter((s) => !s.captured).length;
  const staleCount = shots.filter((s) => s.stale).length;
  const needsReviewCount = shots.filter((s) => s.needsReview).length;
  const confirmedCount = shots.filter((s) => s.captured && s.confirmed).length;
  const docsUpdatedModules = modules.filter((m) => m.status === "docs-updated").length;

  const learnSyncStatus =
    docsUpdatedModules > 0 || staleCount > 0
      ? "docs-updated"
      : missingCount > 0
      ? "missing-screenshot"
      : "up-to-date";
  // Honest check state: a lab nobody has checked against Microsoft Learn is "not-checked", never "up-to-date".
  const checkState =
    docsUpdatedModules > 0 || staleCount > 0
      ? "docs-updated"
      : learnState.lastRevalidatedAt
      ? "up-to-date"
      : "not-checked";

  return {
    status: 200,
    body: {
      labId,
      title: shotsPlan.title,
      product: shotsPlan.product,
      products: shotsPlan.products,
      harness: shotsPlan.harness,
      checkState,
      captureCapabilities: currentCaptureCapabilities(),
      cliCommand: buildLabCaptureCliCommand(labId, { mode: "headed", onlyMissing: missingCount > 0 && staleCount === 0, onlyStale: staleCount > 0 }),
      cliAutoCommand: buildLabCaptureCliCommand(labId, { mode: "auto", onlyStale: staleCount > 0 }),
      summary: {
        total: shots.length,
        captured: capturedCount,
        capturedInLab: capturedInLabCount,
        capturedShared: Math.max(0, capturedCount - capturedInLabCount),
        missing: missingCount,
        stale: staleCount,
        needsReview: needsReviewCount,
        confirmed: confirmedCount,
        notConfirmed: Math.max(0, capturedCount - confirmedCount),
        upToDate: shots.filter((s) => s.syncStatus === "up-to-date").length,
        docsUpdatedModules,
        totalModules: modules.length,
        learnSyncStatus,
        checkState,
        lastRevalidatedAt: learnState.lastRevalidatedAt || null,
      },
      modules,
      shots,
    },
  };
}

function summarizeStepAndHeadingDiff(baseline, live) {
  const beforeSteps = Array.isArray(baseline?.steps) ? baseline.steps : [];
  const afterSteps = Array.isArray(live?.steps) ? live.steps : beforeSteps;
  // Steps compare in their old one-sentence form, so a baseline saved before sub-steps had their own lines matches.
  const flat = (s) => flattenStepLegacy(s).replace(/\s+/g, " ").trim().toLowerCase();
  const beforeNorm = new Set(beforeSteps.map(flat));
  const afterNorm = new Set(afterSteps.map(flat));

  const addedSteps = afterSteps.filter((s) => !beforeNorm.has(flat(s)));
  const removedSteps = beforeSteps.filter((s) => !afterNorm.has(flat(s)));

  const beforeHeadings = Array.isArray(baseline?.headings) ? baseline.headings : [];
  const afterHeadings = Array.isArray(live?.headings) ? live.headings : [];
  const addedHeadings = beforeHeadings.length
    ? afterHeadings.filter((h) => !beforeHeadings.includes(h))
    : [];
  const removedHeadings = beforeHeadings.length
    ? beforeHeadings.filter((h) => !afterHeadings.includes(h))
    : [];

  const drift = diffSteps(beforeSteps, afterSteps);
  const parts = [];
  if (addedSteps.length || removedSteps.length) {
    parts.push(`${addedSteps.length} step(s) added, ${removedSteps.length} step(s) replaced/removed`);
  }
  if (addedHeadings.length || removedHeadings.length) {
    parts.push(`${addedHeadings.length + removedHeadings.length} section heading(s) changed`);
  }
  if (!parts.length) {
    parts.push("Microsoft Learn article content updated since baseline");
  }

  return {
    summary: parts.join("; "),
    stepChanged: Boolean(addedSteps.length || removedSteps.length || drift.level !== "none"),
    addedSteps,
    removedSteps,
    addedHeadings,
    removedHeadings,
    changedHeadings: {
      added: addedHeadings,
      removed: removedHeadings,
    },
    beforeCount: beforeSteps.length,
    afterCount: afterSteps.length,
    drift,
  };
}

/**
 * Re-validate every module in `generated-labs/<labId>/` against live Microsoft Learn
 * documentation, detect updated articles/procedures, and optionally auto-update
 * drifted lab steps + run Playwright step-through screenshot capture.
 */
export async function revalidateLabAgainstLearn(generatedRoot, rawLabId, options = {}) {
  const found = resolveSafeLabDir(generatedRoot, rawLabId);
  if (found.status !== 200) return { status: found.status, body: { error: found.error } };

  const { labId, labDir } = found;
  const capturedDir = options.capturedDir || capturedScreenshotsDirs();
  const shouldUpdateSteps =
    options.updateSteps !== undefined
      ? Boolean(options.updateSteps)
      : Boolean(options.autoUpdate || options.autoCapture);
  const shouldAutoCapture =
    options.autoCapture !== undefined ? Boolean(options.autoCapture) : Boolean(options.autoUpdate);
  const mode = options.mode === "headed" ? "headed" : "auto";
  const onlyStale = options.onlyStale !== false;

  const { shotsPlan, learnState } = ensurePerLabScreenshotPlan(labDir, { labId, capturedDir });
  const manifestPath = path.join(labDir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  let markdown = fs.readFileSync(path.join(labDir, "index.md"), "utf8");

  const customFetchDoc = typeof options.fetchDoc === "function" ? options.fetchDoc : null;
  const bypassCache = options.bypassCache !== false;

  const session = customFetchDoc && !options.connect
    ? { ok: true, endpoint: "custom-fetchDoc", async close() {} }
    : await (options.connect || connect)({ signal: options.signal });
  if (!session?.ok) {
    return {
      status: 503,
      body: {
        error: `Could not reach Microsoft Learn MCP server (${session?.error || "unavailable"}).`,
        learnConnected: false,
      },
    };
  }

  const readPage = customFetchDoc
    ? async (_sess, url, pageOpts = {}) => {
        const res = await customFetchDoc(url, {
          ...pageOpts,
          labId,
          signal: options.signal,
        });
        if (typeof res === "string") {
          return { url, markdown: res, fetchedAt: new Date().toISOString() };
        }
        if (res && typeof res === "object") {
          return {
            url,
            markdown: typeof res.markdown === "string" ? res.markdown : "",
            fetchedAt: res.fetchedAt || new Date().toISOString(),
            error: res.error || null,
          };
        }
        return { url, markdown: "", error: "Empty documentation response" };
      }
    : options.fetchDocPage || fetchDocPage;
  const checkedAt = new Date().toISOString();
  const moduleReports = [];
  const updatedFeatureIds = [];
  let attemptedUrlCount = 0;
  let succeededUrlCount = 0;
  const fetchErrors = [];

  try {
    for (const modMeta of manifest.modules || []) {
      const featureId = modMeta.id;
      const modState = learnState.modules?.[featureId];
      if (!modState) continue;

      const baseline = modState.learnBaseline || {};
      const catalogFeature = getFeature(featureId) || {
        id: featureId,
        name: modMeta.name,
        steps: baseline.steps || [],
        docUrls: baseline.urls || [],
        verifiedAgainst: baseline.primaryUrl || null,
      };
      const candidateUrls =
        Array.isArray(baseline.urls) && baseline.urls.length
          ? baseline.urls
          : catalogFeature.docUrls || [];

      let liveDerived = null;
      let livePrimaryMarkdown = null;
      let livePrimaryUrl = baseline.primaryUrl || candidateUrls[0] || null;
      const livePageFingerprints = {};

      for (const url of candidateUrls) {
        attemptedUrlCount += 1;
        const page = await readPage(session, url, { bypassCache });
        if (page.error || !page.markdown) {
          if (page.error) fetchErrors.push(String(page.error));
          continue;
        }
        succeededUrlCount += 1;
        const fp = hashContentFingerprint(page.markdown);
        if (fp) livePageFingerprints[url] = fp;
        if (url === livePrimaryUrl || !livePrimaryMarkdown) {
          livePrimaryMarkdown = page.markdown;
          livePrimaryUrl = url;
        }
        const derived = deriveSteps(page.markdown, catalogFeature, url);
        if (derived.ok && !liveDerived) {
          liveDerived = {
            url,
            steps: derived.steps,
            sectionHeading: derived.heading,
            fetchedAt: page.fetchedAt || checkedAt,
            contentFingerprint: fp,
            headings: extractDocHeadings(page.markdown),
          };
        }
      }

      const liveFingerprint =
        liveDerived?.contentFingerprint ||
        (livePrimaryMarkdown ? hashContentFingerprint(livePrimaryMarkdown) : null);
      const liveHeadings =
        liveDerived?.headings || (livePrimaryMarkdown ? extractDocHeadings(livePrimaryMarkdown) : []);
      const liveSteps = liveDerived?.steps || null;
      const liveStepHash = liveSteps ? hashSteps(liveSteps) : null;

      const stepChanged = Boolean(liveStepHash && baseline.stepHash && liveStepHash !== baseline.stepHash);
      const contentChanged = Boolean(
        baseline.contentFingerprint &&
          liveFingerprint &&
          liveFingerprint !== baseline.contentFingerprint &&
          (!liveSteps || stepChanged || !isVerifiedCanonicalArticle(livePrimaryMarkdown || "", catalogFeature)),
      );
      const docsChanged = stepChanged || contentChanged;

      const moduleShots = (shotsPlan.shots || []).filter((s) => (s.featureId || s.feature) === featureId);
      const allShotsCaptured =
        moduleShots.length === 0 ||
        moduleShots.every((s) => Boolean(resolveLabScreenshot(labDir, s.filename, { capturedDir })));

      modState.lastCheckedAt = checkedAt;

      // Backfill initial live contentFingerprint if lab was originally built offline and steps match.
      if (!docsChanged && !baseline.contentFingerprint && liveFingerprint) {
        baseline.contentFingerprint = liveFingerprint;
        baseline.headings = liveHeadings;
        baseline.pageFingerprints = { ...(baseline.pageFingerprints || {}), ...livePageFingerprints };
      }

      if (docsChanged) {
        const diff = summarizeStepAndHeadingDiff(baseline, {
          steps: liveSteps || baseline.steps,
          headings: liveHeadings,
        });
        modState.diff = diff;

        if (shouldUpdateSteps && liveSteps?.length) {
          markdown = updateLabModuleStepsInMarkdown(markdown, {
            mod: modMeta,
            newSteps: liveSteps,
            sectionHeading: liveDerived?.sectionHeading || baseline.sectionHeading,
            url: liveDerived?.url || livePrimaryUrl,
            fetchedAt: liveDerived?.fetchedAt || checkedAt,
          });

          modMeta.steps = {
            ...(modMeta.steps || {}),
            source: "doc-derived",
            reason: null,
            canonicalVerified: true,
            url: liveDerived?.url || livePrimaryUrl,
            fetchedAt: liveDerived?.fetchedAt || checkedAt,
            sectionHeading: liveDerived?.sectionHeading || null,
            count: liveSteps.length,
            drift: diffSteps(catalogFeature.steps || [], liveSteps),
          };
          // The training decks follow the same Learn record: a new page fingerprint makes them stale.
          modMeta.training = {
            ...(modMeta.training || {}),
            contentFingerprint: liveFingerprint,
            learnCheckedAt: liveDerived?.fetchedAt || checkedAt,
          };

          modState.learnBaseline = {
            ...baseline,
            primaryUrl: liveDerived?.url || livePrimaryUrl,
            stepSource: "doc-derived",
            steps: [...liveSteps],
            stepHash: liveStepHash,
            contentFingerprint: liveFingerprint,
            pageFingerprints: { ...(baseline.pageFingerprints || {}), ...livePageFingerprints },
            headings: liveHeadings,
            sectionHeading: liveDerived?.sectionHeading || baseline.sectionHeading,
            verifiedAt: checkedAt,
          };

          for (const shot of moduleShots) {
            shot.steps = derivePlaywrightSteps({
              uiSteps: liveSteps,
              startUrl: shot.startUrl,
              callouts: shot.callouts,
              filename: shot.filename,
              outputPath: shot.outputPath,
            });
            shot.learnBaseline = {
              ...(shot.learnBaseline || {}),
              primaryUrl: modState.learnBaseline.primaryUrl,
              stepSource: "doc-derived",
              stepHash: liveStepHash,
              contentFingerprint: liveFingerprint,
              sectionHeading: modState.learnBaseline.sectionHeading,
              verifiedAt: checkedAt,
            };
          }
        } else if (shouldUpdateSteps && liveFingerprint) {
          modState.learnBaseline = {
            ...baseline,
            contentFingerprint: liveFingerprint,
            headings: liveHeadings,
            verifiedAt: checkedAt,
          };
        }

        const stepsApplied = Boolean(shouldUpdateSteps && liveSteps?.length);
        const baselineApplied = Boolean(shouldUpdateSteps && (liveSteps?.length || liveFingerprint));
        const resolvedWithoutCapture = baselineApplied && !shouldAutoCapture;
        const resolvedModStatus = resolvedWithoutCapture
          ? allShotsCaptured
            ? "up-to-date"
            : "missing-screenshot"
          : "docs-updated";

        if (resolvedWithoutCapture) {
          modState.diff = null;
        }
        modState.status = resolvedModStatus;
        for (const shot of moduleShots) {
          learnState.shots ??= {};
          learnState.shots[shot.filename] = {
            ...(learnState.shots[shot.filename] || {}),
            shotId: shot.shotId,
            featureId,
            moduleOrder: modMeta.order,
            filename: shot.filename,
            stale: !resolvedWithoutCapture,
          };
        }
        updatedFeatureIds.push(featureId);
        moduleReports.push({
          featureId,
          moduleOrder: modMeta.order,
          moduleTitle: modMeta.name,
          status: resolvedModStatus,
          stepsUpdated: stepsApplied,
          baselineUpdated: baselineApplied,
          diff: resolvedWithoutCapture ? null : diff,
        });
      } else {
        const previouslyStale = modState.status === "docs-updated";
        const clearStaleWithoutCapture = Boolean(previouslyStale && shouldUpdateSteps && !shouldAutoCapture);
        const keepStale = previouslyStale && !clearStaleWithoutCapture;
        const nextStatus = keepStale
          ? "docs-updated"
          : allShotsCaptured
          ? "up-to-date"
          : "missing-screenshot";
        if (!keepStale) modState.diff = null;
        modState.status = nextStatus;
        if (clearStaleWithoutCapture) {
          for (const shot of moduleShots) {
            if (learnState.shots?.[shot.filename]) {
              learnState.shots[shot.filename].stale = false;
            }
          }
          updatedFeatureIds.push(featureId);
        }
        moduleReports.push({
          featureId,
          moduleOrder: modMeta.order,
          moduleTitle: modMeta.name,
          status: nextStatus,
          stepsUpdated: false,
          baselineUpdated: clearStaleWithoutCapture,
          diff: modState.diff || null,
        });
      }
    }
  } finally {
    await session.close?.().catch?.(() => {});
  }

  if (attemptedUrlCount > 0 && succeededUrlCount === 0 && fetchErrors.length > 0) {
    return {
      status: 502,
      body: {
        error: `Failed to fetch Microsoft Learn documentation: ${fetchErrors[0]}`,
        learnConnected: true,
      },
    };
  }

  learnState.lastRevalidatedAt = checkedAt;
  learnState.updatedAt = checkedAt;
  shotsPlan.updatedAt = checkedAt;

  const isUngrounded = (manifest.modules?.length || 0) > 0 && attemptedUrlCount === 0;
  const anyDocsUpdated = Object.values(learnState.modules || {}).some((m) => m.status === "docs-updated");
  const anyMissing = (shotsPlan.shots || []).some(
    (s) => !resolveLabScreenshot(labDir, s.filename, { capturedDir }),
  );
  learnState.learnSyncStatus = anyDocsUpdated
    ? "docs-updated"
    : isUngrounded
    ? "ungrounded"
    : anyMissing
    ? "missing-screenshot"
    : "up-to-date";

  writePerLabScreenshotArtifacts(labDir, { shotsPlan, learnState, manifest });

  if (shouldUpdateSteps && updatedFeatureIds.length > 0) {
    refreshGeneratedLabOutputs(labDir, { labId, markdown, manifest, capturedDir });
  } else {
    writeJsonAtomic(manifestPath, manifest);
  }

  let captureSummary = null;
  if (shouldAutoCapture) {
    captureSummary = await runGeneratedLabCapture({
      labId,
      generatedRoot,
      repoRoot: REPO_ROOT,
      mode,
      onlyStale,
      onlyMissing: !onlyStale && !updatedFeatureIds.length,
      featureIds: onlyStale && updatedFeatureIds.length ? updatedFeatureIds : null,
      driver: options.driver || null,
      env: options.env || process.env,
      onRefreshOutputs: (dir) => refreshGeneratedLabOutputs(dir, { labId, capturedDir }),
    });

    // Clear module `docs-updated` status for modules whose screenshots were all freshly re-captured!
    if (captureSummary.capturedCount > 0) {
      const freshState = JSON.parse(
        fs.readFileSync(path.join(labDir, "screenshots", "learn-state.json"), "utf8"),
      );
      for (const mod of Object.values(freshState.modules || {})) {
        const modShots = (shotsPlan.shots || []).filter((s) => (s.featureId || s.feature) === mod.featureId);
        const everyFresh =
          modShots.length > 0 &&
          modShots.every((s) => {
            const st = freshState.shots?.[s.filename];
            return st && !st.stale && verifyCapturedImageFile(path.join(labDir, "assets", s.filename)).ok;
          });
        if (everyFresh) {
          mod.status = "up-to-date";
          mod.diff = null;
        }
      }
      const stillUpdated = Object.values(freshState.modules || {}).some((m) => m.status === "docs-updated");
      const stillMissing = (shotsPlan.shots || []).some(
        (s) => !resolveLabScreenshot(labDir, s.filename, { capturedDir }),
      );
      freshState.learnSyncStatus = stillUpdated
        ? "docs-updated"
        : stillMissing
        ? "missing-screenshot"
        : "up-to-date";
      writeJsonAtomic(path.join(labDir, "screenshots", "learn-state.json"), freshState);
      refreshGeneratedLabOutputs(labDir, { labId, capturedDir });
    }
  }

  const latestStatus = getLabScreenshotsStatus(generatedRoot, labId, { capturedDir });
  const counts = {
    upToDate: moduleReports.filter((m) => m.status === "up-to-date").length,
    docsUpdated: moduleReports.filter((m) => m.status === "docs-updated").length,
    missingScreenshot: moduleReports.filter((m) => m.status === "missing-screenshot").length,
  };
  return {
    status: 200,
    body: {
      labId,
      checkedAt,
      overallStatus: latestStatus.body.summary?.learnSyncStatus || "up-to-date",
      checkState: latestStatus.body.checkState,
      counts,
      updatedModules: updatedFeatureIds,
      updatedModuleIds: updatedFeatureIds,
      modules: moduleReports,
      capture: captureSummary,
      state: latestStatus.body,
    },
  };
}

/**
 * Trigger Playwright step-through screenshot capture for an individual generated lab
 * (`POST /api/lab-builder/generated/:labId/screenshots/capture`).
 */
export async function captureLabScreenshots(generatedRoot, rawLabId, options = {}) {
  const found = resolveSafeLabDir(generatedRoot, rawLabId);
  if (found.status !== 200) return { status: found.status, body: { error: found.error } };

  const { labId, labDir } = found;
  const capturedDir = options.capturedDir || capturedScreenshotsDirs();
  ensurePerLabScreenshotPlan(labDir, { labId, capturedDir });

  const featureIds = Array.isArray(options.featureIds)
    ? options.featureIds.filter((id) => typeof id === "string" && id.trim().length <= 120)
    : null;
  const mode = options.mode === "headed" ? "headed" : "auto";

  const captureSummary = await runGeneratedLabCapture({
    labId,
    generatedRoot,
    repoRoot: REPO_ROOT,
    mode,
    onlyMissing: Boolean(options.onlyMissing),
    onlyStale: Boolean(options.onlyStale),
    featureIds,
    driver: options.driver || null,
    env: options.env || process.env,
    onRefreshOutputs: (dir) => refreshGeneratedLabOutputs(dir, { labId, capturedDir }),
  });

  // No browser (or no sign-in) on the server: point at the Local Capture Companion instead of only a CLI string.
  if (
    typeof options.companionFallback === "function" &&
    (captureSummary.status === "browser-unavailable" || captureSummary.status === "auth-required")
  ) {
    try {
      const companion = await options.companionFallback({
        labId,
        onlyMissing: Boolean(options.onlyMissing),
        onlyStale: Boolean(options.onlyStale),
        featureIds,
      });
      if (companion) {
        captureSummary.companion = companion;
        if (companion.message) captureSummary.message = companion.message;
      }
    } catch (err) {
      captureSummary.companion = { queued: false, connected: false, message: `Could not queue a companion job: ${err.message}` };
    }
  }

  // Clear `docs-updated` once stale module screenshots have been freshly captured
  if (captureSummary.capturedCount > 0) {
    const learnStatePath = path.join(labDir, "screenshots", "learn-state.json");
    const shotsJsonPath = path.join(labDir, "screenshots", "shots.json");
    if (fs.existsSync(learnStatePath) && fs.existsSync(shotsJsonPath)) {
      const learnState = JSON.parse(fs.readFileSync(learnStatePath, "utf8"));
      const shotsPlan = JSON.parse(fs.readFileSync(shotsJsonPath, "utf8"));
      for (const mod of Object.values(learnState.modules || {})) {
        const modShots = (shotsPlan.shots || []).filter((s) => (s.featureId || s.feature) === mod.featureId);
        const allClean =
          modShots.length > 0 &&
          modShots.every((s) => {
            const st = learnState.shots?.[s.filename];
            return st && !st.stale && verifyCapturedImageFile(path.join(labDir, "assets", s.filename)).ok;
          });
        if (allClean) {
          mod.status = "up-to-date";
          mod.diff = null;
        }
      }
      const stillUpdated = Object.values(learnState.modules || {}).some((m) => m.status === "docs-updated");
      const stillMissing = (shotsPlan.shots || []).some(
        (s) => !resolveLabScreenshot(labDir, s.filename, { capturedDir }),
      );
      learnState.learnSyncStatus = stillUpdated
        ? "docs-updated"
        : stillMissing
        ? "missing-screenshot"
        : "up-to-date";
      writeJsonAtomic(learnStatePath, learnState);
      refreshGeneratedLabOutputs(labDir, { labId, capturedDir });
    }
  }

  const latestStatus = getLabScreenshotsStatus(generatedRoot, labId, { capturedDir });
  return {
    status: 200,
    body: {
      labId,
      capture: captureSummary,
      state: latestStatus.body,
    },
  };
}

export function isValidScreenshotFilename(name) {
  return typeof name === "string" && SAFE_FILENAME.test(name) && !name.includes("..");
}
