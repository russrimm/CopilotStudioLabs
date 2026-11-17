/**
 * Screenshot capture platform: wires the job queue, companion pairing, the
 * screenshot store, and the status the portal shows. `registerCaptureRoutes`
 * (routes.js) exposes it over HTTP; server.js keeps the returned object to give
 * the older capture and generate endpoints a Local Capture Companion fallback.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { buildCaptureEnv, findProfile } from "../branding-profiles.js";
import { capturedScreenshotsDir, capturedScreenshotsDirs } from "../lab-builder/captured.js";
import { setCaptureCapabilitiesProvider } from "../lab-builder/lab-screenshots.js";
import { BAKED_CAPTURED_SCREENSHOTS_DIR, getStorageDiagnostics, resolvePortalDataDir } from "../storage-config.js";
import { detectBrowserAvailability } from "../../../tools/screenshot-capture/lab-runner.mjs";
import { productLabel } from "../../../tools/screenshot-capture/auth.mjs";
import { createJobStore, normalizeJobRequest, validateCaptureEnv } from "./jobs.js";
import { COMPANION_ONLINE_MS, PAIRING_CODE_TTL_MS, createPairingStore } from "./pairing.js";
import { buildLabJobPlan, buildLibraryJobPlan } from "./plan.js";
import { createScreenshotStore } from "./screenshot-store.js";
import { MAX_UPLOAD_BYTES } from "./verify-upload.js";

export const COMPANION_DOWNLOAD_URL = "/api/capture/companion.zip";
const BROWSER_CACHE_MS = 60 * 1000;

function sameList(a, b) {
  return JSON.stringify([...(a || [])].sort()) === JSON.stringify([...(b || [])].sort());
}

function sameEnv(a, b) {
  const sorted = (env) => JSON.stringify(Object.entries(env || {}).sort(([x], [y]) => (x < y ? -1 : 1)));
  return sorted(a) === sorted(b);
}

/**
 * @param {object} options
 * @param {string} options.generatedRoot folder that holds generated labs
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {() => number} [options.now]
 * @param {() => Promise<{available: boolean}>} [options.detectServerBrowser] injectable for tests
 */
export function createCapturePlatform({
  generatedRoot,
  env = process.env,
  now = () => Date.now(),
  dataDir = null,
  manifestDir = undefined,
  detectServerBrowser = () => detectBrowserAvailability(),
  brand = { findProfile, buildCaptureEnv },
  logger = null,
} = {}) {
  const captureDir = path.join(dataDir || resolvePortalDataDir(env), "capture");
  const capturedDirs = () => ({ primary: capturedScreenshotsDir(env), search: capturedScreenshotsDirs(env) });
  const pairing = createPairingStore({ dir: captureDir, now });
  const jobs = createJobStore({ dir: captureDir, now, productLabel });
  const screenshots = createScreenshotStore({ generatedRoot, captureDir, capturedDirs, manifestDir, logger });

  let browser = { available: false, playwrightInstalled: false, chromiumInstalled: false, checkedAt: 0 };
  let browserCheck = null;
  async function refreshServerBrowser() {
    if (now() - browser.checkedAt < BROWSER_CACHE_MS) return browser;
    browserCheck ??= Promise.resolve()
      .then(() => detectServerBrowser())
      .then((found) => {
        browser = { available: Boolean(found?.available), playwrightInstalled: Boolean(found?.playwrightInstalled), chromiumInstalled: Boolean(found?.chromiumInstalled), checkedAt: now() };
      })
      .catch(() => {
        browser = { available: false, playwrightInstalled: false, chromiumInstalled: false, checkedAt: now() };
      })
      .finally(() => {
        browserCheck = null;
      });
    await browserCheck;
    return browser;
  }
  void refreshServerBrowser();

  function tenantUrlNames() {
    return Object.keys(env)
      .filter((name) => /^CAPTURE_[A-Z0-9_]+$/.test(name) && /^https:\/\/\S+$/.test(String(env[name] || "")))
      .sort();
  }

  /** The short capability summary every lab screenshot status carries. */
  function capabilities() {
    const status = pairing.status();
    return {
      companionConnected: status.connected,
      companionLastSeenAt: status.lastSeenAt,
      serverBrowserAvailable: browser.available,
      tenantUrlsSet: tenantUrlNames().length > 0,
      signedInProducts: status.signedInProducts,
    };
  }
  setCaptureCapabilitiesProvider(capabilities);

  /** `GET /api/capture/status`. */
  async function statusPayload() {
    await refreshServerBrowser();
    const companion = pairing.status();
    const storage = getStorageDiagnostics(env);
    const primary = capturedDirs().primary;
    const location = env.FEATURE_TOUR_SCREENSHOTS_DIR ? "explicit" : primary === BAKED_CAPTURED_SCREENSHOTS_DIR ? "baked" : "persistent";
    const library = screenshots.libraryState();
    const tenantNames = tenantUrlNames();
    // Shots waiting for a sign-in on the person's computer, until the companion reports that sign-in as done.
    const needsSignIn = jobs.latestSignInNeed({ signedInProducts: companion.signedInProducts });
    const signInNeed = needsSignIn ? { needsSignIn } : {};
    return {
      companion: {
        connected: companion.connected,
        lastSeenAt: companion.lastSeenAt,
        connectedCount: companion.connectedCount,
        deviceCount: companion.deviceCount,
        busy: companion.busy,
        signedInProducts: companion.signedInProducts,
        devices: companion.devices,
        downloadUrl: COMPANION_DOWNLOAD_URL,
        onlineWindowSec: Math.round(COMPANION_ONLINE_MS / 1000),
      },
      serverBrowser: {
        available: browser.available,
        playwrightInstalled: browser.playwrightInstalled,
        chromiumInstalled: browser.chromiumInstalled,
        note: browser.available
          ? "This server can run a browser, but it cannot sign in to your tenant. Use the Local Capture Companion for tenant screens."
          : "This server has no capture browser. Capture runs on your computer with the Local Capture Companion.",
      },
      tenantUrls: { set: tenantNames.length > 0, names: tenantNames },
      sharedLibrary: {
        location,
        persistent: location !== "baked" && storage.persistent,
        storage: { persistent: storage.persistent, backend: storage.backend, writable: storage.writable, blobSyncEnabled: storage.blobSync.enabled },
        total: library.summary.total,
        captured: library.summary.captured,
        missing: library.summary.missing,
        needsReview: library.summary.needsReview,
      },
      jobs: { ...jobs.activity(), ...signInNeed },
      pairing: { codeTtlSec: Math.round(PAIRING_CODE_TTL_MS / 1000) },
      limits: { maxUploadBytes: MAX_UPLOAD_BYTES, acceptedTypes: ["image/png", "image/jpeg", "image/webp"] },
    };
  }

  function activeDuplicate(norm, env) {
    return jobs
      .list({ limit: 200 })
      .find(
        (job) =>
          (job.status === "queued" || job.status === "claimed" || job.status === "running") &&
          job.target.type === norm.target.type &&
          job.target.labId === norm.target.labId &&
          sameList(job.target.products, norm.target.products) &&
          job.scope.mode === norm.scope.mode &&
          sameList(job.scope.filenames, norm.scope.filenames) &&
          sameList(job.scope.featureIds, norm.scope.featureIds) &&
          sameEnv(jobs.getPlan(job.id)?.env, env),
      );
  }

  /**
   * The tenant addresses a job carries, from a stored brand profile (`brandProfileId`)
   * or the lab's own brand customization, with explicit `env` entries winning per variable.
   * @returns {{env: Record<string, string>, source: string|null, error?: {status: number, message: string}}}
   */
  function resolveJobEnv(norm, body) {
    let derived = {};
    let source = null;
    const requested = body?.brandProfileId;
    if (requested !== undefined && requested !== null && requested !== "") {
      if (typeof requested !== "string") return { env: {}, source: null, error: { status: 400, message: "brandProfileId must be a brand profile id." } };
      const profile = brand.findProfile(requested, env);
      if (!profile) return { env: {}, source: null, error: { status: 404, message: "Brand profile not found." } };
      derived = brand.buildCaptureEnv(profile, { env });
      source = "profile";
    } else if (norm.target.type === "lab" && body?.useLabCustomization !== false) {
      const found = labSlotsDir(norm.target.labId);
      const customization = found ? readLabCustomization(found) : null;
      if (customization) {
        derived = brand.buildCaptureEnv({ customization }, { env });
        source = "lab";
      }
    }
    const merged = validateCaptureEnv({ ...derived, ...norm.env });
    if (!merged.ok) return { env: {}, source, error: { status: 400, message: merged.errors[0] } };
    if (Object.keys(norm.env).length && source) source = `${source}+request`;
    else if (Object.keys(norm.env).length) source = "request";
    return { env: merged.env, source };
  }

  function labSlotsDir(labId) {
    const dir = path.join(generatedRoot, String(labId));
    return /^[a-z0-9][a-z0-9-]{0,99}$/i.test(String(labId)) && existsSync(path.join(dir, "manifest.json")) ? dir : null;
  }

  function readLabCustomization(labDir) {
    try {
      const manifest = JSON.parse(readFileSync(path.join(labDir, "manifest.json"), "utf8"));
      return manifest?.customization && typeof manifest.customization === "object" ? manifest.customization : null;
    } catch {
      return null;
    }
  }

  /**
   * Validate a job request, build its shot plan, and queue it.
   * @returns {{status: number, body: object}}
   */
  function queueJob(body, { createdBy = null } = {}) {
    const norm = normalizeJobRequest(body);
    if (!norm.ok) return { status: 400, body: { error: norm.errors[0], errors: norm.errors } };

    const dirs = capturedDirs();
    const plan =
      norm.target.type === "lab"
        ? buildLabJobPlan({ generatedRoot, labId: norm.target.labId, scope: norm.scope, capturedDir: dirs.search })
        : buildLibraryJobPlan({ scope: norm.scope, products: norm.target.products, manifestDir, capturedDir: dirs.search });
    if (plan.status !== 200) return { status: plan.status, body: { error: plan.error } };

    const jobEnv = resolveJobEnv(norm, body);
    if (jobEnv.error) return { status: jobEnv.error.status, body: { error: jobEnv.error.message } };

    const companion = pairing.status();
    const companionInfo = { connected: companion.connected, lastSeenAt: companion.lastSeenAt };
    if (!plan.shots.length) {
      return {
        status: 200,
        body: { job: null, nothingToCapture: true, companion: companionInfo, message: "Nothing to capture: every selected screenshot already exists." },
      };
    }
    const existing = activeDuplicate(norm, jobEnv.env);
    if (existing) {
      return { status: 200, body: { job: jobs.get(existing.id), existing: true, envSource: jobEnv.source, companion: companionInfo, message: "This capture is already queued or running." } };
    }
    const job = jobs.create({ target: norm.target, scope: norm.scope, env: jobEnv.env, options: norm.options, plan, createdBy });
    return {
      status: 201,
      body: {
        job,
        envSource: jobEnv.source,
        companion: companionInfo,
        message: companion.connected
          ? `Queued ${plan.shots.length} screenshot${plan.shots.length === 1 ? "" : "s"}. Your Local Capture Companion will pick them up.`
          : "Queued, but no Local Capture Companion is connected yet. Download it, pair it with a code, and it will pick this job up.",
      },
    };
  }

  /** What the older capture endpoint returns when the server cannot run a browser. */
  async function companionFallbackForLab({ labId, onlyMissing = false, onlyStale = false, featureIds = null, createdBy = null }) {
    const companion = pairing.status();
    const base = { connected: companion.connected, lastSeenAt: companion.lastSeenAt, downloadUrl: COMPANION_DOWNLOAD_URL, pairUrl: "/api/capture/pair", statusUrl: "/api/capture/status" };
    if (!companion.connected) {
      return {
        ...base,
        queued: false,
        canQueue: true,
        reason: "no-companion",
        message:
          "This server cannot sign in to your tenant. Install the Local Capture Companion on your computer, pair it with a code from the portal, and it will capture these screenshots for you. You can also paste or upload any screenshot by hand.",
      };
    }
    const result = queueJob(
      { target: { type: "lab", labId }, scope: { mode: onlyStale ? "stale" : "missing", featureIds: featureIds || [] } },
      { createdBy },
    );
    if (result.status >= 400) return { ...base, queued: false, canQueue: true, reason: "not-queued", message: result.body.error };
    if (result.body.nothingToCapture) return { ...base, queued: false, canQueue: false, reason: "nothing-to-capture", message: result.body.message };
    return {
      ...base,
      queued: true,
      existing: Boolean(result.body.existing),
      jobId: result.body.job.id,
      message: "Capture is queued for your Local Capture Companion. It runs on your computer; follow progress in the Screenshot Center.",
    };
  }

  return {
    captureDir,
    pairing,
    jobs,
    screenshots,
    capabilities,
    statusPayload,
    queueJob,
    companionFallbackForLab,
    refreshServerBrowser,
    capturedDirs,
  };
}
