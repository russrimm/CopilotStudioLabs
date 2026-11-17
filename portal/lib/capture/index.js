/**
 * Screenshot capture platform: wires the job queue, companion pairing, the
 * screenshot store, and the status the portal shows. `registerCaptureRoutes`
 * (routes.js) exposes it over HTTP; server.js keeps the returned object to give
 * the older capture and generate endpoints a Local Capture Companion fallback.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { findProfile, getActiveProfileId, updateLabCaptureTargets, updateProfile } from "../branding-profiles.js";
import { capturedScreenshotsDir, capturedScreenshotsDirs } from "../lab-builder/captured.js";
import { setCaptureCapabilitiesProvider, setCaptureTargetsProvider } from "../lab-builder/lab-screenshots.js";
import { BAKED_CAPTURED_SCREENSHOTS_DIR, getStorageDiagnostics, resolvePortalDataDir } from "../storage-config.js";
import { detectBrowserAvailability } from "../../../tools/screenshot-capture/lab-runner.mjs";
import { productLabel } from "../../../tools/screenshot-capture/auth.mjs";
import { validateTargets } from "../../../tools/screenshot-capture/targets.mjs";
import { summarizeMissing } from "./classify.js";
import { createJobStore, normalizeJobRequest, validateCaptureEnv } from "./jobs.js";
import { COMPANION_ONLINE_MS, PAIRING_CODE_TTL_MS, createPairingStore } from "./pairing.js";
import { buildLabJobPlan, buildLibraryJobPlan } from "./plan.js";
import { createScreenshotStore } from "./screenshot-store.js";
import { describeCaptureTargets, jobTargetsFrom, resolveCaptureTargets } from "./targets.js";
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
  brand = { findProfile },
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
  // The Screenshot Center asks how each shot of a lab will be captured: the same settings a capture job would use.
  setCaptureTargetsProvider((labId) => {
    try {
      return resolveCaptureTargets({ manifest: readLabManifest(labId), env }).values;
    } catch {
      return {};
    }
  });

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

  function activeDuplicate(norm, env, targetText = {}) {
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
          (job.options?.mode || "smart") === norm.options.mode &&
          sameEnv(jobs.getPlan(job.id)?.env, env) &&
          sameEnv(jobs.getPlan(job.id)?.targets, targetText),
      );
  }

  /**
   * The capture settings a job carries: addresses (as CAPTURE_* variables) and names, resolved from the request,
   * the lab's own settings and SharePoint site, the brand profile, and this server's own environment.
   * @returns {{values: object, sources: object, env: Record<string, string>, text: Record<string, string>, source: string|null, error?: {status: number, message: string}}}
   */
  function resolveJobTargets(norm, body) {
    let profile = null;
    const requested = body?.brandProfileId;
    if (requested !== undefined && requested !== null && requested !== "") {
      if (typeof requested !== "string") return { values: {}, sources: {}, env: {}, text: {}, source: null, error: { status: 400, message: "brandProfileId must be a brand profile id." } };
      profile = brand.findProfile(requested, env);
      if (!profile) return { values: {}, sources: {}, env: {}, text: {}, source: null, error: { status: 404, message: "Brand profile not found." } };
    }
    const manifest = norm.target.type === "lab" && body?.useLabCustomization !== false ? readLabManifest(norm.target.labId) : null;
    const resolved = resolveCaptureTargets({ manifest, profile, env, request: { targets: norm.targets, env: norm.env } });
    const carried = jobTargetsFrom(resolved);
    const merged = validateCaptureEnv(carried.env);
    if (!merged.ok) return { values: {}, sources: {}, env: {}, text: {}, source: null, error: { status: 400, message: merged.errors[0] } };
    const used = new Set(Object.values(resolved.sources));
    const fromLab = used.has("lab") || used.has("lab-site") || Boolean(manifest?.customization && used.has("profile") && !profile);
    const base = profile && used.has("profile") ? "profile" : fromLab ? "lab" : used.has("profile") ? "profile" : used.has("server") ? "server" : null;
    const explicit = used.has("request");
    const source = base ? (explicit ? `${base}+request` : base) : explicit ? "request" : null;
    return { values: resolved.values, sources: resolved.sources, env: merged.env, text: carried.text, source };
  }

  function labSlotsDir(labId) {
    const dir = path.join(generatedRoot, String(labId));
    return /^[a-z0-9][a-z0-9-]{0,99}$/i.test(String(labId)) && existsSync(path.join(dir, "manifest.json")) ? dir : null;
  }

  function readLabManifest(labId) {
    const found = labSlotsDir(labId);
    if (!found) return null;
    try {
      const manifest = JSON.parse(readFileSync(path.join(found, "manifest.json"), "utf8"));
      return manifest && typeof manifest === "object" ? manifest : null;
    } catch {
      return null;
    }
  }

  /**
   * The capture settings in effect for a lab (or for the shared library), with what each shot is waiting for.
   * @returns {{labId: string|null, activeProfile: object|null, fields: object[], requirements: object[], missing: object[], shots: object[]}}
   */
  function targetsPayload({ labId = null } = {}) {
    const manifest = labId ? readLabManifest(labId) : null;
    const resolved = resolveCaptureTargets({ manifest, env });
    const shots = labId ? labShotCaptures(labId, resolved.values) : [];
    const profile = brand.findProfile?.(getActiveProfileId(env), env) || null;
    return { labId: labId || null, activeProfile: profile ? { id: profile.id, name: profile.name } : null, ...describeCaptureTargets(resolved, shots), shots: shots.map((s) => ({ filename: s.filename, mode: s.capture.mode, why: s.capture.why, path: s.capture.path, needs: s.capture.needs, missing: s.capture.missing, ready: s.capture.ready })) };
  }

  /** Each shot of a lab with how it will be captured under these settings. */
  function labShotCaptures(labId, values) {
    const plan = buildLabJobPlan({ generatedRoot, labId, scope: { mode: "all", filenames: [], featureIds: [] }, capturedDir: capturedDirs().search, values });
    return plan.status === 200 ? plan.shots : [];
  }

  /** Save capture settings on a lab (and, when asked, on the active brand profile so other labs use them too). */
  function saveLabTargets(labId, patch, { alsoProfile = false } = {}) {
    const dir = labSlotsDir(labId);
    if (!dir) return { status: 404, body: { error: `Generated lab "${labId}" not found.` } };
    const saved = updateLabCaptureTargets(dir, patch);
    if (!saved.ok) return { status: 400, body: { error: Object.values(saved.errors)[0], errors: saved.errors } };
    if (alsoProfile) {
      const profileSaved = saveProfileTargets(patch);
      if (profileSaved.status >= 400) return profileSaved;
    }
    return { status: 200, body: { saved: true, ...targetsPayload({ labId }) } };
  }

  /** Save capture settings on the active brand profile. */
  function saveProfileTargets(patch, { profileId = null } = {}) {
    const checked = validateTargets(patch);
    if (!checked.ok) return { status: 400, body: { error: Object.values(checked.errors)[0], errors: checked.errors } };
    const id = profileId || getActiveProfileId(env);
    try {
      updateProfile(id, checked.values, env);
    } catch (err) {
      return { status: err.status || 400, body: { error: err.message, errors: err.errors || undefined } };
    }
    return { status: 200, body: { saved: true, ...targetsPayload({}) } };
  }

  /**
   * Validate a job request, build its shot plan, and queue it.
   * @returns {{status: number, body: object}}
   */
  function queueJob(body, { createdBy = null } = {}) {
    const norm = normalizeJobRequest(body);
    if (!norm.ok) return { status: 400, body: { error: norm.errors[0], errors: norm.errors } };

    const jobTargets = resolveJobTargets(norm, body);
    if (jobTargets.error) return { status: jobTargets.error.status, body: { error: jobTargets.error.message } };

    const dirs = capturedDirs();
    const plan =
      norm.target.type === "lab"
        ? buildLabJobPlan({ generatedRoot, labId: norm.target.labId, scope: norm.scope, capturedDir: dirs.search, values: jobTargets.values })
        : buildLibraryJobPlan({ scope: norm.scope, products: norm.target.products, manifestDir, capturedDir: dirs.search, values: jobTargets.values });
    if (plan.status !== 200) return { status: plan.status, body: { error: plan.error } };

    const companion = pairing.status();
    const companionInfo = { connected: companion.connected, lastSeenAt: companion.lastSeenAt };
    if (!plan.shots.length) {
      return {
        status: 200,
        body: { job: null, nothingToCapture: true, companion: companionInfo, message: "Nothing to capture: every selected screenshot already exists." },
      };
    }

    // Shots that cannot run without an address are held back and the person is asked for it, not told "skipped" afterwards.
    const waiting = norm.options.mode === "guided" ? [] : plan.shots.filter((s) => s.capture?.mode === "auto" && s.capture.missing?.length);
    const missing = summarizeMissing(waiting);
    if (waiting.length === plan.shots.length) {
      return {
        status: 200,
        body: {
          job: null,
          needsAddress: true,
          missing,
          companion: companionInfo,
          message: `${waiting.length} screenshot${waiting.length === 1 ? " needs" : "s need"} ${missing.length === 1 ? `your ${missing[0].noun}` : "an address"} before they can be captured. Add it in Capture settings, then try again.`,
        },
      };
    }

    const existing = activeDuplicate(norm, jobTargets.env, jobTargets.text);
    if (existing) {
      return { status: 200, body: { job: jobs.get(existing.id), existing: true, envSource: jobTargets.source, companion: companionInfo, message: "This capture is already queued or running." } };
    }
    const job = jobs.create({ target: norm.target, scope: norm.scope, env: jobTargets.env, targets: jobTargets.text, options: norm.options, plan, createdBy });
    const runnable = plan.shots.length - waiting.length;
    return {
      status: 201,
      body: {
        job,
        envSource: jobTargets.source,
        companion: companionInfo,
        ...(missing.length ? { missing } : {}),
        message: companion.connected
          ? `Queued ${runnable} screenshot${runnable === 1 ? "" : "s"}. Your Local Capture Companion will pick them up.${waiting.length ? ` ${waiting.length} more need${waiting.length === 1 ? "s" : ""} an address first.` : ""}`
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
    if (result.body.needsAddress) return { ...base, queued: false, canQueue: true, reason: "needs-address", message: result.body.message, missing: result.body.missing };
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
    targetsPayload,
    saveLabTargets,
    saveProfileTargets,
    companionFallbackForLab,
    refreshServerBrowser,
    capturedDirs,
  };
}
