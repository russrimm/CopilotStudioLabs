/**
 * Playwright step-through screenshot runner for individual generated labs.
 *
 * Used both via CLI:
 *   node tools/screenshot-capture/capture.js --generated-lab=<labId> [--auto|--headed|--stale-only|--only-missing]
 *   npm run capture:lab -- --generated-lab=<labId> --headed
 * and programmatically from `portal/lib/lab-builder/lab-screenshots.js`.
 *
 * Key behaviors:
 *  - Reuses persistent `.auth/<product>/` browser profiles and `storage-state.json`
 *    when present so authenticated Microsoft 365, Copilot Studio, SharePoint,
 *    Power Platform, and Microsoft Foundry sessions carry across runs.
 *  - Supports `--headed` (interactive sign-in + assisted step-through) and
 *    `--auto` / `--headless` automated Playwright step-through.
 *  - Steps through each module's structured UI actions (`navigate`,
 *    `waitForLoadState`, `dismissBanners`, accessible `getByRole`/`getByText`
 *    probes from bolded UI labels, `resolveCallouts`, and `screenshot`), writes
 *    validated PNGs to `generated-labs/<labId>/assets/<filename>`, updates
 *    `screenshots/shots.json` and `screenshots/learn-state.json`, and triggers
 *    full lab output regeneration (`index.html`, `topics/*.docx`, `topics/*.pptx`,
 *    `manifest.json`).
 *  - Degrades cleanly when Playwright/Chromium is unavailable or tenant login is
 *    needed, returning structured per-shot statuses (`captured`, `auth-required`,
 *    `browser-unavailable`, `manual-required`, `failed`) plus the exact one-line
 *    local headed CLI command.
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildSidecar, resolveCallouts, sidecarName } from "./callouts.mjs";
import { classifyUrl, createAuthGate, redactedAddress } from "./auth.mjs";
import { createCaptureSession, runCaptureShot } from "./capture-run.mjs";
import { DESTRUCTIVE_LABEL_RE, blockedInstructionReason, blockedLabelReason } from "./guard.mjs";
import { detectInstalledBrowsers } from "./browsers.mjs";
import { navigateWithSignIn } from "./lifecycle.mjs";
import { NAVIGATION_ROLES, findControls } from "./locator.mjs";
import { resolveShotUrl, resolveStartUrl } from "./manifests.mjs";
import { readinessBudgets, waitUntilReady } from "./readiness.mjs";
import { PLACEHOLDER_MESSAGE, detectPlaceholder } from "./placeholder-detect.mjs";

export { DESTRUCTIVE_LABEL_RE };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const REPO_ROOT = path.resolve(__dirname, "..", "..");
export const DEFAULT_GENERATED_ROOT = path.join(REPO_ROOT, "generated-labs");
export const MIN_CAPTURED_BYTES = 5 * 1024;

const SAFE_LAB_ID = /^[a-z0-9][a-z0-9-]{0,99}$/i;
const SAFE_ASSET_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpe?g|webp)$/i;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Check whether a URL is a Microsoft Entra / MSA interactive sign-in page. Only the host and path count:
 * a signed-in page whose query string mentions a sign-in address is still the product.
 */
export function isSignInRedirectUrl(rawUrl) {
  return classifyUrl(rawUrl).kind === "sign-in";
}

/**
 * Validate raw image bytes against the 5 KB minimum, the format magic header, and the placeholder check: a
 * placeholder picture (the pending image or a captioned filler) is never a captured screenshot, whatever its size.
 */
export function verifyCapturedImageBuffer(bytes, ext = ".png") {
  if (!Buffer.isBuffer(bytes) || bytes.length < MIN_CAPTURED_BYTES) {
    return {
      ok: false,
      reason: `Captured image is ${bytes?.length || 0} bytes (minimum ${MIN_CAPTURED_BYTES} bytes).`,
    };
  }
  if (detectPlaceholder(bytes).placeholder) return { ok: false, placeholder: true, reason: PLACEHOLDER_MESSAGE };
  const normalizedExt = String(ext || ".png").toLowerCase();
  if (normalizedExt === ".png") {
    const validHeader = PNG_MAGIC.every((b, idx) => bytes[idx] === b);
    if (!validHeader) return { ok: false, reason: "Captured file does not have a valid PNG signature." };
    return { ok: true, bytes: bytes.length };
  }
  if (normalizedExt === ".jpg" || normalizedExt === ".jpeg") {
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
      return { ok: false, reason: "Captured file does not have a valid JPEG signature." };
    }
    return { ok: true, bytes: bytes.length };
  }
  if (
    bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
    bytes.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return { ok: true, bytes: bytes.length };
  }
  return { ok: false, reason: `Unsupported screenshot extension "${normalizedExt}".` };
}

/**
 * Validate a captured screenshot file on disk.
 */
export function verifyCapturedImageFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return { ok: false, reason: "File does not exist." };
    const buf = fs.readFileSync(filePath);
    return verifyCapturedImageBuffer(buf, path.extname(filePath));
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/**
 * Build the exact one-line local Playwright CLI command for a generated lab.
 */
export function buildLabCaptureCliCommand(
  labId,
  { mode = "headed", onlyStale = false, onlyMissing = false, featureIds = null } = {},
) {
  const safeId = String(labId || "<lab-id>").trim();
  const flags = [`--generated-lab=${safeId}`];
  if (mode === "headed") flags.push("--headed");
  else flags.push("--auto");
  if (onlyStale) flags.push("--stale-only");
  else if (onlyMissing) flags.push("--only-missing");
  if (Array.isArray(featureIds) && featureIds.length > 0) {
    flags.push(`--feature=${featureIds.join(",")}`);
  }
  return `node tools/screenshot-capture/capture.js ${flags.join(" ")}`;
}

/**
 * Locate persistent browser authentication state for a product profile.
 * Checks both repo-level `.auth/<profile>/` and `tools/screenshot-capture/.auth/<profile>/`.
 */
export function resolveAuthStatePaths(authProfile = "copilot-studio", repoRoot = REPO_ROOT) {
  const safeProfile = /^[a-z0-9-]+$/i.test(String(authProfile || ""))
    ? String(authProfile)
    : "copilot-studio";
  const repoAuthDir = path.join(repoRoot, ".auth", safeProfile);
  const toolAuthDir = path.join(repoRoot, "tools", "screenshot-capture", ".auth", safeProfile);

  const storageCandidates = [
    path.join(repoAuthDir, "storage-state.json"),
    path.join(repoAuthDir, "state.json"),
    path.join(toolAuthDir, "storage-state.json"),
    path.join(toolAuthDir, "state.json"),
  ];
  const storageStatePath = storageCandidates.find((candidate) => fs.existsSync(candidate)) || null;
  const userDataDir = fs.existsSync(repoAuthDir) ? repoAuthDir : toolAuthDir;

  return {
    authProfile: safeProfile,
    userDataDir,
    storageStatePath,
    saveStorageStatePath: path.join(userDataDir, "storage-state.json"),
    hasSavedAuth: Boolean(storageStatePath || (fs.existsSync(userDataDir) && fs.readdirSync(userDataDir).length > 0)),
  };
}

/**
 * Try to load `playwright` from the current package, `tools/screenshot-capture`,
 * `portal`, or the repo root. Returns `null` when Playwright is not installed.
 */
export async function loadPlaywrightModule(repoRoot = REPO_ROOT) {
  try {
    return await import("playwright");
  } catch {
    // Fall through to workspace-relative package locations.
  }
  const searchBases = [
    path.join(repoRoot, "tools", "screenshot-capture", "package.json"),
    path.join(repoRoot, "portal", "package.json"),
    path.join(repoRoot, "package.json"),
  ];
  for (const pkgPath of searchBases) {
    if (!fs.existsSync(pkgPath)) continue;
    try {
      const req = createRequire(pkgPath);
      const resolved = req.resolve("playwright");
      return await import(pathToFileURL(resolved).href);
    } catch {
      // Keep checking remaining locations.
    }
  }
  return null;
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2) + "\n", "utf8");
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    fs.rmSync(tmpPath, { force: true });
    throw err;
  }
}

/**
 * Whether this machine can run a capture browser: Playwright is installed and
 * either its Chromium binary or an installed Microsoft Edge / Google Chrome exists.
 * Never launches a browser. `available` stays "the bundled Chromium is there".
 */
export async function detectBrowserAvailability({ repoRoot = REPO_ROOT, installedBrowsers = detectInstalledBrowsers } = {}) {
  const playwright = await loadPlaywrightModule(repoRoot);
  if (!playwright?.chromium) return { playwrightInstalled: false, chromiumInstalled: false, edgeInstalled: false, chromeInstalled: false, available: false, anyBrowser: false };
  let chromiumInstalled = false;
  try {
    chromiumInstalled = fs.existsSync(playwright.chromium.executablePath());
  } catch {
    chromiumInstalled = false;
  }
  const installed = installedBrowsers();
  const edgeInstalled = Boolean(installed.edge);
  const chromeInstalled = Boolean(installed.chrome);
  return { playwrightInstalled: true, chromiumInstalled, edgeInstalled, chromeInstalled, available: chromiumInstalled, anyBrowser: chromiumInstalled || edgeInstalled || chromeInstalled };
}

async function dismissCommonBanners(page) {
  const selectors = [
    '[role="dialog"] button',
    '[role="alertdialog"] button',
    '[id*="cookie" i] button',
    '[class*="cookie" i] button',
    '[data-testid*="banner" i] button',
  ];
  const dismissLabels = /^(?:accept|accept all|got it|dismiss|not now)$/i;
  for (const selector of selectors) {
    try {
      const buttons = page.locator(selector);
      const count = Math.min(await buttons.count().catch(() => 0), 6);
      for (let i = 0; i < count; i += 1) {
        const btn = buttons.nth(i);
        if (!(await btn.isVisible().catch(() => false))) continue;
        const text = String((await btn.innerText().catch(() => "")) || "").trim();
        if (dismissLabels.test(text)) {
          await btn.click({ timeout: 1200 }).catch(() => {});
        }
      }
    } catch {
      // Best-effort banner dismissal never blocks capture.
    }
  }
}

/**
 * A visible control whose accessible name is exactly `label`, or null. Only an exact name counts (never text that
 * merely contains the words), and a control that is off limits (delete, sign out, publish, create...) never does.
 * `regions` limits where the control may be.
 */
async function findVisibleControlByLabel(page, label, roles = NAVIGATION_ROLES, { regions = null } = {}) {
  if (!label || typeof label !== "string") return null;
  const found = await findControls(page, label, { roles: roles?.length ? roles : NAVIGATION_ROLES, regions });
  return found.find((candidate) => !candidate.off)?.locator || null;
}

// A step from an older plan names a label from the lab's text, which can also be a card or a link in the page's
// own content ("Knowledge" on the home page leads to a page that creates apps). Navigation and the page frame are
// fine; content is not.
const LEGACY_CLICK_REGIONS = ["nav", "header", "other"];

/**
 * Execute structured Playwright step-through actions for a single lab shot.
 */
export async function executePlaywrightLabShot({
  page,
  shot,
  manifest,
  assetsDir,
  screenshotsDir,
  mode = "headless",
  env = process.env,
  authTimeoutMs = 120_000,
  stepTimeoutMs = 1800,
  logger = null,
  hooks = null,
  auth = null,
  trace = null,
  session = null,
  effectiveMode = null,
  readiness = {},
  guided = {},
  attempt = 1,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  // The sign-in gate decides whether a page is the product or a sign-in page. A caller that runs several shots
  // passes one gate for the whole profile, so the person is asked to sign in once, not once per shot.
  const gate =
    auth ||
    createAuthGate({
      product: shot.authProfile || shot.product || "microsoft-365",
      waitMs: authTimeoutMs,
      allowWait: mode === "headed" && typeof page.url === "function",
      notify: ({ message }) => logger?.(`  → ${message}`),
      trace,
    });

  // A plan from a portal that classifies its shots carries a `capture` descriptor: follow it.
  if (shot.capture?.version && shot.capture.mode !== "manual") {
    return runCaptureShot({
      page,
      shot,
      session: session || createCaptureSession({ env }),
      effectiveMode: effectiveMode || (shot.capture.mode === "guided" ? "guided" : "auto"),
      env,
      gate,
      assetsDir,
      screenshotsDir,
      hooks,
      trace,
      log: logger,
      sleep,
      readiness,
      guided,
      attempt,
      verifyBuffer: verifyCapturedImageBuffer,
      stepTimeoutMs: Math.max(stepTimeoutMs, 3000),
    });
  }

  const viewport = {
    width: Number(shot.viewport?.width || 1440),
    height: Number(shot.viewport?.height || 900),
  };
  if (typeof page.setViewportSize === "function") {
    await page.setViewportSize(viewport).catch(() => {});
  }

  let targetUrl = null;
  try {
    const resolvedShot = resolveShotUrl(shot, env);
    targetUrl = resolvedShot?.url || shot.startUrl || resolveStartUrl(manifest, env) || null;
  } catch (err) {
    return { status: "failed", error: err.message, executedSteps: [] };
  }

  const needsSignIn = (result, executedSteps) => ({
    status: "auth-required",
    error: result.error,
    code: result.code,
    currentUrl: redactedAddress(typeof page.url === "function" ? page.url() : ""),
    executedSteps,
  });
  // Sign-in already failed for this profile in this run: do not open the page just to fail again.
  if (gate.failed) return needsSignIn({ error: gate.failed.message, code: gate.failed.code }, []);

  const executedSteps = [];
  const plannedSteps = Array.isArray(shot.steps) && shot.steps.length
    ? shot.steps
    : [
        ...(targetUrl ? [{ action: "navigate", url: targetUrl, waitUntil: "domcontentloaded" }] : []),
        { action: "waitForLoadState", state: "networkidle", timeoutMs: 6000, optional: true },
        { action: "dismissBanners", optional: true },
        { action: "screenshot", filename: shot.filename },
      ];

  let resolvedCalloutRects = null;
  const outputFile = path.resolve(assetsDir, shot.filename);

  for (const step of plannedSteps) {
    const action = step?.action;
    trace?.event("step", { action, shot: shot.filename });
    if (action === "navigate") {
      const navUrl = targetUrl || step.url;
      if (navUrl && /^https?:\/\//i.test(navUrl)) {
        logger?.(`  → Navigating to ${redactedAddress(navUrl)}`);
        const nav = await navigateWithSignIn({ page, url: navUrl, gate, sleep, trace, log: logger, reason: "open-lab-step", waitUntil: step.waitUntil || "domcontentloaded", timeout: Number(step.timeoutMs || 30_000) });
        if (nav.ok) executedSteps.push({ action: "navigate", url: navUrl, ok: true });
        else return needsSignIn(nav.signIn, executedSteps);
      }
      continue;
    }

    if (action === "waitForLoadState") {
      if (typeof page.waitForLoadState === "function") {
        await page
          .waitForLoadState(step.state || "domcontentloaded", { timeout: Number(step.timeoutMs || 6000) })
          .catch(() => {});
      }
      executedSteps.push({ action: "waitForLoadState", state: step.state || "domcontentloaded", ok: true });
      // Single-page apps send the browser to sign-in once they have loaded, so look again now.
      const signedIn = await gate.ensureSignedIn(page, { phase: "loaded" });
      if (!signedIn.ok) return needsSignIn(signedIn, executedSteps);
      continue;
    }

    if (action === "dismissBanners") {
      await dismissCommonBanners(page);
      executedSteps.push({ action: "dismissBanners", ok: true });
      continue;
    }

    if (action === "stepThrough" || action === "click" || action === "clickBestEffort") {
      const labels = Array.isArray(step.labels)
        ? step.labels
        : step.label
        ? [step.label]
        : [];
      const matchedLabels = [];
      const blocked = [];
      const readyToClick = await gate.ensureSignedIn(page, { phase: "check" });
      if (!readyToClick.ok) return needsSignIn(readyToClick, executedSteps);
      const instructionReason = blockedInstructionReason(step.instruction || "");
      for (const label of labels) {
        const reason = !label ? "empty" : instructionReason || blockedLabelReason(label);
        if (reason) {
          if (label) blocked.push(label);
          trace?.event("click-blocked", { label, reason: instructionReason ? `instruction is ${instructionReason}` : `label is ${reason}` });
          continue;
        }
        const candidates = await findControls(page, label, { roles: step.roles?.length ? step.roles : NAVIGATION_ROLES, regions: LEGACY_CLICK_REGIONS });
        const allowed = candidates.find((candidate) => !candidate.off);
        // The name matched something harmless, but the control itself may sign out, switch the account, or save something.
        const refused = candidates.find((candidate) => candidate.off);
        if (!allowed) {
          if (refused) {
            blocked.push(label);
            trace?.event("click-blocked", { label, reason: `control ${refused.off.why} is ${refused.off.reason}` });
          } else {
            trace?.event("step", { action: "click", label, found: false, note: "no control with that exact name outside the page content" });
          }
          continue;
        }
        const locator = allowed.locator;
        try {
          if (typeof locator.scrollIntoViewIfNeeded === "function") {
            await locator.scrollIntoViewIfNeeded({ timeout: stepTimeoutMs }).catch(() => {});
          }
          if (step.interaction !== "locate" && typeof locator.click === "function") {
            await locator.click({ timeout: stepTimeoutMs }).catch(() => {});
            if (typeof page.waitForTimeout === "function") {
              await page.waitForTimeout(350).catch(() => {});
            }
          }
          matchedLabels.push(label);
        } catch {
          // Best-effort step-through continues to next UI cue.
        }
      }
      executedSteps.push({
        action: "stepThrough",
        stepIndex: step.stepIndex ?? null,
        labels,
        matchedLabels,
        ...(blocked.length ? { blocked } : {}),
        ok: matchedLabels.length > 0 || step.optional !== false,
      });
      continue;
    }

    if (action === "probeControl") {
      const labels = Array.isArray(step.labels) ? step.labels : [];
      const matchedLabels = [];
      for (const label of labels) {
        const locator = await findVisibleControlByLabel(page, label, [
          "textbox",
          "combobox",
          "switch",
          "checkbox",
          "button",
          "tab",
        ]);
        if (locator) {
          if (typeof locator.scrollIntoViewIfNeeded === "function") {
            await locator.scrollIntoViewIfNeeded({ timeout: stepTimeoutMs }).catch(() => {});
          }
          matchedLabels.push(label);
        }
      }
      executedSteps.push({
        action: "probeControl",
        stepIndex: step.stepIndex ?? null,
        labels,
        matchedLabels,
        ok: true,
      });
      continue;
    }

    if (action === "probeCallouts") {
      const callouts = Array.isArray(step.callouts) ? step.callouts : shot.callouts || [];
      if (callouts.length && typeof page.getByText === "function") {
        resolvedCalloutRects = await resolveCallouts(page, callouts, viewport).catch(() => null);
        if (resolvedCalloutRects && screenshotsDir) {
          fs.mkdirSync(screenshotsDir, { recursive: true });
          const sidecarPath = path.join(screenshotsDir, sidecarName(shot.filename));
          writeJsonAtomic(sidecarPath, buildSidecar(shot.filename, viewport, resolvedCalloutRects));
        }
      }
      executedSteps.push({
        action: "probeCallouts",
        count: callouts.length,
        resolved: resolvedCalloutRects ? resolvedCalloutRects.filter((c) => c.rect).length : 0,
        ok: true,
      });
      continue;
    }

    if (action === "screenshot") {
      fs.mkdirSync(path.dirname(outputFile), { recursive: true });
      // A page that loaded slowly may have sent the browser to sign-in after the last check. Never take a picture of that.
      const stillSignedIn = await gate.ensureSignedIn(page, { phase: "screenshot" });
      if (!stillSignedIn.ok) return needsSignIn(stillSignedIn, executedSteps);
      if (stillSignedIn.waited && typeof page.waitForLoadState === "function") {
        await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
      }
      await waitUntilReady(page, { budgets: readinessBudgets(readiness, attempt), sleep, trace, shot: shot.filename, attempt });
      // The companion masks account details and places callouts here, right before the pixels are taken.
      if (typeof hooks?.beforeScreenshot === "function") {
        await hooks.beforeScreenshot({ page, shot, viewport, callouts: resolvedCalloutRects });
      }
      let raw;
      try {
        raw = await page.screenshot({
          path: outputFile,
          fullPage: Boolean(step.fullPage),
        });
      } finally {
        if (typeof hooks?.afterScreenshot === "function") {
          await Promise.resolve(hooks.afterScreenshot({ page, shot })).catch(() => {});
        }
      }
      const check = Buffer.isBuffer(raw)
        ? verifyCapturedImageBuffer(raw, path.extname(outputFile))
        : verifyCapturedImageFile(outputFile);
      if (!check.ok) {
        return {
          status: "failed",
          error: check.reason,
          executedSteps,
        };
      }
      if (Buffer.isBuffer(raw) && !fs.existsSync(outputFile)) {
        fs.writeFileSync(outputFile, raw);
      }
      executedSteps.push({ action: "screenshot", filename: shot.filename, bytes: check.bytes, ok: true });
    }
  }

  const finalCheck = verifyCapturedImageFile(outputFile);
  if (!finalCheck.ok) {
    return {
      status: "failed",
      error: finalCheck.reason,
      executedSteps,
    };
  }

  return {
    status: "captured",
    bytes: finalCheck.bytes,
    outputPath: shot.outputPath,
    filePath: outputFile,
    capturedAt: new Date().toISOString(),
    finalUrl: typeof page.url === "function" ? page.url() : null,
    callouts: resolvedCalloutRects,
    executedSteps,
  };
}

function locateLabDir(generatedRoot, rawLabId) {
  const labId = String(rawLabId || "").trim();
  if (!SAFE_LAB_ID.test(labId)) {
    return { ok: false, status: 400, error: "Invalid generated lab id." };
  }
  const root = path.resolve(generatedRoot);
  const labDir = path.resolve(root, labId);
  const rel = path.relative(root, labDir);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || rel !== labId) {
    return { ok: false, status: 400, error: "Invalid generated lab id." };
  }
  try {
    const st = fs.lstatSync(labDir);
    if (!st.isDirectory() || st.isSymbolicLink()) {
      return { ok: false, status: 404, error: `Generated lab "${labId}" not found.` };
    }
  } catch {
    return { ok: false, status: 404, error: `Generated lab "${labId}" not found.` };
  }
  if (!fs.existsSync(path.join(labDir, "manifest.json"))) {
    return { ok: false, status: 404, error: `Generated lab "${labId}" has no manifest.json.` };
  }
  return { ok: true, labId, labDir };
}

/**
 * Run Playwright screenshot step-through for an individual generated lab.
 *
 * @param {object} options
 * @param {string} options.labId
 * @param {string} [options.generatedRoot]
 * @param {string} [options.repoRoot]
 * @param {"auto"|"headless"|"headed"} [options.mode="auto"]
 * @param {boolean} [options.onlyMissing=false]
 * @param {boolean} [options.onlyStale=false]
 * @param {string[]} [options.featureIds]
 * @param {Array<string|number>} [options.shotIds]
 * @param {object|Function} [options.driver] optional hermetic test driver
 * @param {Function} [options.onRefreshOutputs] optional callback to refresh HTML/DOCX/PPTX/manifest
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {(msg: string) => void} [options.logger]
 */
export async function runGeneratedLabCapture(options = {}) {
  const {
    labId: rawLabId,
    generatedRoot: explicitGeneratedRoot,
    generatedLabsRoot,
    repoRoot = REPO_ROOT,
    mode: rawMode = "auto",
    onlyMissing = false,
    onlyStale: explicitOnlyStale = false,
    staleOnly = false,
    featureIds = null,
    shotIds = null,
    driver = null,
    playwrightModule,
    onRefreshOutputs = null,
    env = process.env,
    logger = null,
  } = options;
  const generatedRoot = explicitGeneratedRoot || generatedLabsRoot || DEFAULT_GENERATED_ROOT;
  const onlyStale = Boolean(explicitOnlyStale || staleOnly);

  const mode = rawMode === "headed" ? "headed" : "headless";
  const located = locateLabDir(generatedRoot, rawLabId);
  if (!located.ok) {
    return {
      ok: false,
      httpStatus: located.status,
      status: "not-found",
      error: located.error,
      shots: [],
    };
  }

  const { labId, labDir } = located;
  const screenshotsDir = path.join(labDir, "screenshots");
  const shotsJsonPath = path.join(screenshotsDir, "shots.json");
  const learnStatePath = path.join(screenshotsDir, "learn-state.json");
  const assetsDir = path.join(labDir, "assets");

  // Ensure per-lab screenshot plan exists even for older labs built before `screenshots/shots.json`.
  if (!fs.existsSync(shotsJsonPath)) {
    const helperUrl = pathToFileURL(
      path.join(repoRoot, "portal", "lib", "lab-builder", "lab-screenshots.js"),
    ).href;
    const { ensurePerLabScreenshotPlan } = await import(helperUrl);
    ensurePerLabScreenshotPlan(labDir, { labId });
  }

  const shotsPlan = JSON.parse(fs.readFileSync(shotsJsonPath, "utf8"));
  const learnState = fs.existsSync(learnStatePath)
    ? JSON.parse(fs.readFileSync(learnStatePath, "utf8"))
    : { schema: 1, labId, modules: {}, shots: {} };

  const featureSet =
    Array.isArray(featureIds) && featureIds.length
      ? new Set(featureIds.map((id) => String(id).trim()).filter(Boolean))
      : null;
  const shotIdSet =
    Array.isArray(shotIds) && shotIds.length
      ? new Set(shotIds.map((id) => String(id).trim()).filter(Boolean))
      : null;

  const selectedShots = (shotsPlan.shots || []).filter((shot) => {
    if (!SAFE_ASSET_FILENAME.test(String(shot.filename || ""))) return false;
    if (featureSet && !featureSet.has(shot.featureId || shot.feature)) return false;
    if (shotIdSet && !shotIdSet.has(String(shot.shotId)) && !shotIdSet.has(String(shot.id))) return false;

    const diskFile = path.join(assetsDir, shot.filename);
    const hasRealPng = verifyCapturedImageFile(diskFile).ok;
    const shotState = learnState.shots?.[shot.filename] || {};
    const moduleState = learnState.modules?.[shot.featureId || shot.feature] || {};
    const isStale =
      Boolean(shotState.stale) ||
      moduleState.status === "docs-updated" ||
      (shotState.capturedStepHash &&
        shot.learnBaseline?.stepHash &&
        shotState.capturedStepHash !== shot.learnBaseline.stepHash);

    if (onlyStale) return isStale || !hasRealPng;
    if (onlyMissing) return !hasRealPng;
    return true;
  });

  const cliCommand = buildLabCaptureCliCommand(labId, {
    mode: "headed",
    onlyStale,
    onlyMissing,
    featureIds: featureSet ? [...featureSet] : null,
  });

  if (selectedShots.length === 0) {
    return {
      ok: true,
      httpStatus: 200,
      labId,
      status: "nothing-to-capture",
      mode,
      attempted: 0,
      capturedCount: 0,
      authRequiredCount: 0,
      browserUnavailableCount: 0,
      failedCount: 0,
      cliCommand,
      cliCommandHeaded: cliCommand,
      shots: [],
      results: [],
    };
  }

  const results = [];
  const nowIso = new Date().toISOString();

  // ── Path A: Hermetic / custom injected driver ─────────────────────────────
  if (driver) {
    for (const shot of selectedShots) {
      if (shot.manual && mode !== "headed" && !driver.allowManual) {
        results.push({
          shotId: shot.shotId,
          featureId: shot.featureId || shot.feature,
          filename: shot.filename,
          status: "manual-required",
          error: "This step captures an external desktop or CLI window; capture manually or run in headed mode.",
        });
        continue;
      }
      try {
        const outcome =
          typeof driver === "function"
            ? await driver({ shot, manifest: shotsPlan, labDir, assetsDir, screenshotsDir, mode, env })
            : typeof driver.captureShot === "function"
            ? await driver.captureShot({ shot, manifest: shotsPlan, labDir, assetsDir, screenshotsDir, mode, env })
            : driver.createPage
            ? await executePlaywrightLabShot({
                page: await driver.createPage({ shot, manifest: shotsPlan, mode }),
                shot,
                manifest: shotsPlan,
                assetsDir,
                screenshotsDir,
                mode,
                env,
                logger,
              })
            : { status: "failed", error: "Invalid screenshot driver." };

        if (Buffer.isBuffer(outcome)) {
          fs.mkdirSync(assetsDir, { recursive: true });
          const outFile = path.join(assetsDir, shot.filename);
          const check = verifyCapturedImageBuffer(outcome, path.extname(outFile));
          if (!check.ok) {
            results.push({
              shotId: shot.shotId,
              featureId: shot.featureId || shot.feature,
              filename: shot.filename,
              status: "failed",
              error: check.reason,
            });
          } else {
            fs.writeFileSync(outFile, outcome);
            results.push({
              shotId: shot.shotId,
              featureId: shot.featureId || shot.feature,
              filename: shot.filename,
              outputPath: shot.outputPath,
              status: "captured",
              bytes: check.bytes,
              capturedAt: new Date().toISOString(),
            });
          }
        } else if (outcome && outcome.status === "captured") {
          if (Buffer.isBuffer(outcome.buffer)) {
            fs.mkdirSync(assetsDir, { recursive: true });
            const outFile = path.join(assetsDir, shot.filename);
            const check = verifyCapturedImageBuffer(outcome.buffer, path.extname(outFile));
            if (!check.ok) {
              results.push({
                shotId: shot.shotId,
                featureId: shot.featureId || shot.feature,
                filename: shot.filename,
                status: "failed",
                error: check.reason,
              });
              continue;
            }
            fs.writeFileSync(outFile, outcome.buffer);
            if (Array.isArray(outcome.callouts) && outcome.callouts.length) {
              fs.mkdirSync(screenshotsDir, { recursive: true });
              writeJsonAtomic(
                path.join(screenshotsDir, sidecarName(shot.filename)),
                buildSidecar(shot.filename, shot.viewport || { width: 1440, height: 900 }, outcome.callouts),
              );
            }
            results.push({
              shotId: shot.shotId,
              featureId: shot.featureId || shot.feature,
              filename: shot.filename,
              outputPath: shot.outputPath,
              status: "captured",
              bytes: check.bytes,
              capturedAt: outcome.capturedAt || new Date().toISOString(),
              executedSteps: outcome.executedSteps || [],
            });
          } else {
            results.push({
              shotId: shot.shotId,
              featureId: shot.featureId || shot.feature,
              filename: shot.filename,
              outputPath: shot.outputPath,
              ...outcome,
            });
          }
        } else {
          results.push({
            shotId: shot.shotId,
            featureId: shot.featureId || shot.feature,
            filename: shot.filename,
            status: outcome?.status || "failed",
            error: outcome?.error || "Screenshot capture did not complete.",
            currentUrl: outcome?.currentUrl || null,
          });
        }
      } catch (err) {
        results.push({
          shotId: shot.shotId,
          featureId: shot.featureId || shot.feature,
          filename: shot.filename,
          status: "failed",
          error: err.message,
        });
      }
    }
  } else {
    // ── Path B: Real Playwright Chromium step-through ─────────────────────────
    const playwright =
      playwrightModule !== undefined ? playwrightModule : await loadPlaywrightModule(repoRoot);
    if (!playwright?.chromium) {
      for (const shot of selectedShots) {
        learnState.shots ??= {};
        learnState.shots[shot.filename] = {
          ...(learnState.shots[shot.filename] || {}),
          shotId: shot.shotId,
          featureId: shot.featureId || shot.feature,
          moduleOrder: shot.moduleOrder ?? null,
          filename: shot.filename,
          lastAttemptStatus: "browser-unavailable",
          lastAttemptAt: nowIso,
          lastError: "Playwright is not installed in this environment.",
        };
      }
      writeJsonAtomic(learnStatePath, learnState);
      const unavailableShots = selectedShots.map((shot) => ({
        shotId: shot.shotId,
        featureId: shot.featureId || shot.feature,
        filename: shot.filename,
        status: "browser-unavailable",
        cliCommand,
      }));
      return {
        ok: false,
        httpStatus: 200,
        labId,
        status: "browser-unavailable",
        mode,
        attempted: selectedShots.length,
        message:
          "Playwright / Chromium is not installed in this runtime. Run the local CLI command below to install Chromium once and step through this lab.",
        installCommand: "cd tools/screenshot-capture && npm install && npx playwright install chromium",
        cliCommand,
        cliCommandHeaded: cliCommand,
        capturedCount: 0,
        authRequiredCount: 0,
        browserUnavailableCount: selectedShots.length,
        failedCount: 0,
        shots: unavailableShots,
        results: unavailableShots,
      };
    }

    // Group shots by authProfile so multi-product labs reuse each product's persistent auth profile.
    const shotsByProfile = new Map();
    for (const shot of selectedShots) {
      const profile = shot.authProfile || shotsPlan.authProfile || shot.product || "copilot-studio";
      if (!shotsByProfile.has(profile)) shotsByProfile.set(profile, []);
      shotsByProfile.get(profile).push(shot);
    }

    for (const [profile, profileShots] of shotsByProfile.entries()) {
      const auth = resolveAuthStatePaths(profile, repoRoot);
      let context = null;
      let browser = null;
      try {
        if (mode === "headed" || (fs.existsSync(auth.userDataDir) && !auth.storageStatePath)) {
          fs.mkdirSync(auth.userDataDir, { recursive: true });
          context = await playwright.chromium.launchPersistentContext(auth.userDataDir, {
            headless: mode !== "headed",
            viewport: { width: 1440, height: 900 },
          });
        } else {
          browser = await playwright.chromium.launch({ headless: true });
          context = await browser.newContext({
            viewport: { width: 1440, height: 900 },
            ...(auth.storageStatePath ? { storageState: auth.storageStatePath } : {}),
          });
        }

        const page = context.pages()[0] || (await context.newPage());
        // One sign-in gate per product profile: the person is asked once, and a failed sign-in stops the rest of this profile.
        const signInGate = createAuthGate({
          product: profile,
          waitMs: 120_000,
          allowWait: mode === "headed",
          notify: ({ message }) => logger?.(`[${labId}] ${message}`),
        });
        for (const shot of profileShots) {
          if (shot.manual && mode !== "headed") {
            results.push({
              shotId: shot.shotId,
              featureId: shot.featureId || shot.feature,
              filename: shot.filename,
              status: "manual-required",
              error: "Manual OS/CLI window shot; run with --headed or save the PNG directly.",
            });
            continue;
          }
          logger?.(`[${labId}] Stepping through ${shot.moduleTitle || shot.featureId} -> ${shot.filename}`);
          try {
            const shotOutcome = await executePlaywrightLabShot({
              page,
              shot,
              manifest: shotsPlan,
              assetsDir,
              screenshotsDir,
              mode,
              env,
              logger,
              auth: signInGate,
            });
            results.push({
              shotId: shot.shotId,
              featureId: shot.featureId || shot.feature,
              filename: shot.filename,
              outputPath: shot.outputPath,
              ...shotOutcome,
            });
          } catch (shotErr) {
            results.push({
              shotId: shot.shotId,
              featureId: shot.featureId || shot.feature,
              filename: shot.filename,
              status: "failed",
              error: shotErr.message,
            });
          }
        }

        // Persist updated authenticated storage state whenever at least one shot succeeded!
        if (results.some((r) => r.status === "captured") && typeof context.storageState === "function") {
          fs.mkdirSync(path.dirname(auth.saveStorageStatePath), { recursive: true });
          await context.storageState({ path: auth.saveStorageStatePath }).catch(() => {});
        }
      } catch (launchErr) {
        const errMsg = String(launchErr?.message || launchErr);
        const browserMissing = /Executable doesn't exist|playwright install|browserType\.launch/i.test(errMsg);
        for (const shot of profileShots) {
          results.push({
            shotId: shot.shotId,
            featureId: shot.featureId || shot.feature,
            filename: shot.filename,
            status: browserMissing ? "browser-unavailable" : "failed",
            error: browserMissing
              ? "Chromium browser binary is not installed. Run `npx playwright install chromium`."
              : errMsg,
            cliCommand,
          });
        }
      } finally {
        await context?.close().catch(() => {});
        await browser?.close().catch(() => {});
      }
    }
  }

  // ── Persist updated shot + Learn state & regenerate all lab outputs ────────
  const byFilename = new Map(results.map((r) => [r.filename, r]));
  for (const shot of shotsPlan.shots || []) {
    const outcome = byFilename.get(shot.filename);
    const diskCheck = verifyCapturedImageFile(path.join(assetsDir, shot.filename));
    if (diskCheck.ok) {
      shot.status = "captured";
      if (outcome?.capturedAt) shot.capturedAt = outcome.capturedAt;
    }
    if (outcome) {
      learnState.shots ??= {};
      const prev = learnState.shots[shot.filename] || {};
      const isCaptured = outcome.status === "captured" && diskCheck.ok;
      learnState.shots[shot.filename] = {
        ...prev,
        shotId: shot.shotId,
        featureId: shot.featureId || shot.feature,
        moduleOrder: shot.moduleOrder ?? null,
        filename: shot.filename,
        captured: isCaptured ? true : Boolean(prev.captured && diskCheck.ok),
        capturedAt: isCaptured ? outcome.capturedAt : prev.capturedAt || null,
        capturedStepHash: isCaptured ? shot.learnBaseline?.stepHash || null : prev.capturedStepHash || null,
        capturedContentFingerprint: isCaptured
          ? shot.learnBaseline?.contentFingerprint || null
          : prev.capturedContentFingerprint || null,
        captureSource: isCaptured ? "playwright-lab-runner" : prev.captureSource || null,
        stale: isCaptured ? false : Boolean(prev.stale),
        lastAttemptStatus: outcome.status,
        lastAttemptAt: nowIso,
        lastError: outcome.status === "captured" ? null : outcome.error || null,
      };
      if (isCaptured) {
        const fId = shot.featureId || shot.feature;
        if (learnState.modules?.[fId] && learnState.modules[fId].status !== "docs-updated") {
          learnState.modules[fId].status = "up-to-date";
        }
      }
    }
  }

  shotsPlan.updatedAt = nowIso;
  learnState.updatedAt = nowIso;
  writeJsonAtomic(shotsJsonPath, shotsPlan);
  writeJsonAtomic(learnStatePath, learnState);

  const capturedCount = results.filter((r) => r.status === "captured").length;
  const authRequiredCount = results.filter((r) => r.status === "auth-required").length;
  const browserUnavailableCount = results.filter((r) => r.status === "browser-unavailable").length;
  const failedCount = results.filter((r) => r.status === "failed").length;

  let refreshed = false;
  if (capturedCount > 0) {
    if (typeof onRefreshOutputs === "function") {
      await onRefreshOutputs(labDir, { labId });
      refreshed = true;
    } else {
      try {
        const helperUrl = pathToFileURL(
          path.join(repoRoot, "portal", "lib", "lab-builder", "lab-screenshots.js"),
        ).href;
        const { refreshGeneratedLabOutputs } = await import(helperUrl);
        refreshGeneratedLabOutputs(labDir, { labId });
        refreshed = true;
      } catch {
        refreshed = false;
      }
    }
  }

  const overallStatus =
    capturedCount === results.length
      ? "captured"
      : browserUnavailableCount > 0 && capturedCount === 0
      ? "browser-unavailable"
      : authRequiredCount > 0 && capturedCount === 0
      ? "auth-required"
      : capturedCount > 0
      ? "partial"
      : "failed";

  return {
    ok: capturedCount > 0 && failedCount === 0 && authRequiredCount === 0 && browserUnavailableCount === 0,
    httpStatus: 200,
    labId,
    status: overallStatus,
    mode,
    attempted: selectedShots.length,
    capturedCount,
    authRequiredCount,
    browserUnavailableCount,
    failedCount,
    refreshedOutputs: refreshed,
    cliCommand,
    cliCommandHeaded: cliCommand,
    installCommand:
      browserUnavailableCount > 0
        ? "cd tools/screenshot-capture && npm install && npx playwright install chromium"
        : null,
    shots: results,
    results,
  };
}
