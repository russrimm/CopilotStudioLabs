/**
 * Screenshot capture platform: wires the job queue, companion pairing, the
 * screenshot store, and the status the portal shows. `registerCaptureRoutes`
 * (routes.js) exposes it over HTTP; server.js keeps the returned object to give
 * the older capture and generate endpoints a Local Capture Companion fallback.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { findProfile, getActiveProfileId, readCustomization, updateLabAgentSource, updateLabCaptureTargets, updateProfile } from "../branding-profiles.js";
import { capturedScreenshotsDir, capturedScreenshotsDirs } from "../lab-builder/captured.js";
import { setCaptureCapabilitiesProvider, setCaptureTargetsProvider, setSharedLibraryProvider } from "../lab-builder/lab-screenshots.js";
import { setLabPictureGuard } from "../lab-builder/picture-guard.js";
import { describeCapturedScreenshotsLocation, getStorageDiagnostics, resolveKeptScreenshotsDir, resolvePortalDataDir } from "../storage-config.js";
import { detectBrowserAvailability } from "../../../tools/screenshot-capture/lab-runner.mjs";
import { productLabel } from "../../../tools/screenshot-capture/auth.mjs";
import { validateTargets, missingRequirements } from "../../../tools/screenshot-capture/targets.mjs";
import { summarizeMissing } from "./classify.js";
import { ACCOUNT_MIN_COMPANION, PRODUCT_ID_RE } from "./account.js";
import { HANDOFF_MIN_COMPANION, creationState, requestedAgentSource, resolveAgentSource, withoutOwnAgentTargets } from "./agent-source.js";
import { autonomyFor, createConsentStore, describeConsent, validateConsent } from "./consent.js";
import { createJobStore, normalizeJobRequest, validateCaptureEnv } from "./jobs.js";
import { createStreamGate, createUploadGate, DEFAULT_SSE_MAX, DEFAULT_SSE_PER_VISITOR_MAX, DEFAULT_UPLOAD_CONCURRENCY, DEFAULT_UPLOAD_WAIT_MS } from "./limits.js";
import { readRecordsFile } from "./library-share.js";
import { cleanOwnerKey, differentPeople } from "./owner.js";
import { COMPANION_ONLINE_MS, PAIRING_CODE_TTL_MS, createPairingStore } from "./pairing.js";
import { positiveIntFromEnv } from "../rate-limit.js";
import { buildLabJobPlan, buildLibraryJobPlan, findLibrarySlot } from "./plan.js";
import { buildDryPlan } from "./dry-plan.js";
import { buildLabChecklist, renderChecklistMarkdown } from "./checklist.js";
import { readLabScratchContext } from "./scratch-context.js";
import { createScreenshotStore } from "./screenshot-store.js";
import { createSharedRecipeStore } from "./shared-recipes.js";
import { readJson, writeJsonAtomic } from "./store-util.js";
import { describeCaptureTargets, jobTargetsFrom, resolveCaptureTargets } from "./targets.js";
import { MAX_UPLOAD_BYTES } from "./verify-upload.js";

export const COMPANION_DOWNLOAD_URL = "/api/capture/companion.zip";
/** The first companion that can run a job on its own. An older one is given a smart job instead. */
export const AUTONOMOUS_MIN_COMPANION = "1.4.0";
/** The first companion that can build the practice agent from scratch. An older one would only look at screens, so it is asked to update first. */
export const SCRATCH_MIN_COMPANION = "1.6.0";
/** The first companion that runs the recipe families (test conversations with panels, dialogs, item details, a sample test set, landmark checks). An older one keeps working the older way. */
export const RECIPES_MIN_COMPANION = "1.6.3";
const BROWSER_CACHE_MS = 60 * 1000;
/** What a person is told when the lab they asked to capture already has a capture waiting or running. */
const LAB_BUSY_MESSAGES = Object.freeze({
  someoneElse: "Another person is capturing this lab right now. Try again when they finish.",
  you: "This lab already has a capture in progress. Wait for it to finish or cancel it first.",
});

/** Whether a version string such as "1.3.0" is at least `min`. An unknown version is not. */
export function versionAtLeast(version, min) {
  const parse = (v) => String(v ?? "").split("-")[0].split(".").map((n) => Number.parseInt(n, 10));
  const a = parse(version);
  const b = parse(min);
  if (a.some((n) => !Number.isFinite(n)) || a.length < 2) return false;
  for (let i = 0; i < 3; i += 1) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return true;
}

function sameList(a, b) {
  return JSON.stringify([...(a || [])].sort()) === JSON.stringify([...(b || [])].sort());
}

/** Whether this portal runs on one person's own computer (no storage root, no Azure Container Apps, no Blob mirror). */
export function isLocalRun(env = process.env) {
  const set = (name) => typeof env?.[name] === "string" && env[name].trim() !== "";
  const backend = String(env?.PORTAL_STORAGE_BACKEND || "").trim().toLowerCase();
  return !["PORTAL_STORAGE_ROOT", "CONTAINER_APP_NAME", "CONTAINER_APP_REVISION", "CONTAINER_APP_ENV_DNS_SUFFIX", "AZURE_STORAGE_BLOB_ENDPOINT"].some(set) && !backend.startsWith("azure");
}

/** One plain sentence about where the shared screenshots are saved. `folder` is only given to a person at the computer itself. */
export function describeLibraryLocation({ kind, backend = "local-disk", folder = null }) {
  if (kind === "committed") return "Shared screenshots are not saved permanently: this portal is using the screenshots folder in the code repository, which is read-only here.";
  if (kind === "storage-root") {
    return backend === "azure-blob" || backend === "azure-files" ? "Shared screenshots are saved in Azure storage." : "Shared screenshots are saved on this portal's storage volume.";
  }
  return folder ? `Shared screenshots are saved on this computer in ${folder}` : "Shared screenshots are saved on the computer that runs this portal.";
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
  scheduleBlobSync = null,
} = {}) {
  const captureDir = path.join(dataDir || resolvePortalDataDir(env), "capture");
  const capturedDirs = () => ({ primary: capturedScreenshotsDir(env), search: capturedScreenshotsDirs(env) });
  const pairing = createPairingStore({ dir: captureDir, now });
  const jobs = createJobStore({ dir: captureDir, now, productLabel });
  // Open progress windows and in-flight image uploads are capped so a busy portal cannot run out of sockets or memory.
  const sse = createStreamGate({ max: positiveIntFromEnv(env.CAPTURE_SSE_MAX, DEFAULT_SSE_MAX), perVisitorMax: positiveIntFromEnv(env.CAPTURE_SSE_PER_VISITOR_MAX, DEFAULT_SSE_PER_VISITOR_MAX) });
  const uploads = createUploadGate({ max: positiveIntFromEnv(env.CAPTURE_UPLOAD_CONCURRENCY, DEFAULT_UPLOAD_CONCURRENCY), waitMs: positiveIntFromEnv(env.CAPTURE_UPLOAD_WAIT_MS, DEFAULT_UPLOAD_WAIT_MS) });
  const consent = createConsentStore({ dir: captureDir, now });
  const sharedRecipes = createSharedRecipeStore({ dir: captureDir, now });
  const screenshots = createScreenshotStore({ generatedRoot, captureDir, capturedDirs, manifestDir, logger, onChange: typeof scheduleBlobSync === "function" ? scheduleBlobSync : null, keptDir: () => resolveKeptScreenshotsDir(env), now });
  // Deleting or replacing a lab (or throwing away one that failed to build) keeps its real pictures first.
  setLabPictureGuard(generatedRoot, (request) => screenshots.guardLabRemoval(request));
  try {
    screenshots.purgeKept();
  } catch (err) {
    logger?.(`[kept-pictures] Could not remove expired kept pictures: ${err.message}`);
  }
  // Lab screenshot status says where each picture comes from and how it relates to the shared library.
  setSharedLibraryProvider({
    isSlot: (filename) => Boolean(findLibrarySlot(filename, { manifestDir })),
    records: () => readRecordsFile(path.join(captureDir, "library-verification.json")),
  });

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

  /** Which consent record applies: the brand profile the job uses (asked for, or the active one), or "default" when there is none. */
  function consentScope(body) {
    const requested = body?.brandProfileId;
    if (typeof requested === "string" && requested) return { key: requested, profile: brand.findProfile?.(requested, env) || null };
    const activeId = getActiveProfileId(env);
    const profile = activeId ? brand.findProfile?.(activeId, env) || null : null;
    return { key: profile?.id || "default", profile };
  }

  /** What the computer is allowed to do, what it never does, and what this portal has recorded for the active profile. */
  function consentPayload({ body = null } = {}) {
    const scope = consentScope(body);
    const record = consent.get(scope.key);
    return { ...describeConsent(record, { profile: scope.profile }), key: scope.key };
  }

  function saveConsent(input, { body = null } = {}) {
    const checked = validateConsent(input);
    if (!checked.ok) return { status: 400, body: { error: checked.error, field: checked.field } };
    const scope = consentScope(body);
    consent.put(scope.key, checked.consent);
    return { status: 200, body: { saved: true, ...consentPayload({ body }) } };
  }

  function revokeConsent({ body = null } = {}) {
    const scope = consentScope(body);
    const existed = consent.revoke(scope.key);
    return { status: 200, body: { revoked: existed, ...consentPayload({ body }) } };
  }

  /** The companions that are connected now (and work for `ownerKey`, when it is given), and whether every one of them can run an autonomous job. */
  function companionCanRunAutonomous({ ownerKey = null } = {}) {
    const status = pairing.status({ ownerKey });
    const online = (status.devices || []).filter((d) => d.connected);
    if (!online.length) return { connected: false, supported: true, version: null, scratchSupported: true, handoffSupported: true, recipesSupported: true };
    const supported = online.some((d) => versionAtLeast(d.companionVersion, AUTONOMOUS_MIN_COMPANION));
    const scratchSupported = online.some((d) => versionAtLeast(d.companionVersion, SCRATCH_MIN_COMPANION));
    const handoffSupported = online.some((d) => versionAtLeast(d.companionVersion, HANDOFF_MIN_COMPANION));
    const recipesSupported = online.some((d) => versionAtLeast(d.companionVersion, RECIPES_MIN_COMPANION));
    return { connected: true, supported, version: online[0].companionVersion || null, scratchSupported, handoffSupported, recipesSupported };
  }

  /** The capture settings (addresses and names) in effect, as an account setup request carries them, so the landing can be checked. */
  function setupTargets(labId) {
    try {
      const manifest = labId ? readLabManifest(labId) : null;
      const activeId = getActiveProfileId(env);
      const profile = activeId ? brand.findProfile?.(activeId, env) || null : null;
      const resolved = resolveCaptureTargets({ manifest, profile, env, request: {} });
      const carried = jobTargetsFrom(resolved);
      const merged = validateCaptureEnv(carried.env);
      return { env: merged.ok ? merged.env : {}, targets: carried.text || {} };
    } catch {
      return { env: {}, targets: {} };
    }
  }

  /**
   * "Choose which account to use": ask a connected computer to open the sign-in window so the person can sign in with the
   * account they want. The request is given to the computer on its next check-in (see the heartbeat route).
   * Only a computer that works for the person asking is used: a sign-in window never opens on someone else's computer.
   * @returns {{status: number, body: object}}
   */
  function requestAccountSetup(body = {}, { ownerKey = null } = {}) {
    const product = typeof body.product === "string" && PRODUCT_ID_RE.test(body.product) ? body.product : "copilot-studio";
    const labId = typeof body.labId === "string" && /^[a-z0-9][a-z0-9-]{0,99}$/i.test(body.labId) ? body.labId : null;
    const online = (pairing.status({ ownerKey }).devices || []).filter((d) => d.connected);
    if (!online.length) return { status: 409, body: { error: "No computer is connected. Connect your computer first, then choose the account.", code: "no-companion" } };
    const capable = online.filter((d) => versionAtLeast(d.companionVersion, ACCOUNT_MIN_COMPANION));
    if (!capable.length) {
      return { status: 409, body: { error: `Your Local Capture Companion is older than ${ACCOUNT_MIN_COMPANION}, so it cannot choose an account yet. Download it again and replace the old one. Until then, run it with --browser=chromium to avoid your Windows work account.`, code: "companion-too-old" } };
    }
    const device = capable.find((d) => !d.busy);
    if (!device) return { status: 409, body: { error: "Your computer is capturing right now. Choose the account when the capture has finished.", code: "busy" } };
    const carried = setupTargets(labId);
    const queued = pairing.queueCommand(device.id, { type: "setup-account", product, env: carried.env, targets: carried.targets });
    return { status: 202, body: { requested: true, id: queued.id, product, deviceName: device.name, message: `Look for a new browser window on ${device.name}. Sign in there with the account you want your screenshots to come from. You choose the account yourself; the computer never clicks for you.` } };
  }

  /** Which companions can report and choose an account, for the Screenshot Center. */
  function accountCapability({ ownerKey = null } = {}) {
    const online = (pairing.status({ ownerKey }).devices || []).filter((d) => d.connected);
    return { connected: online.length > 0, supported: online.some((d) => versionAtLeast(d.companionVersion, ACCOUNT_MIN_COMPANION)), minCompanion: ACCOUNT_MIN_COMPANION };
  }

  const noticeFile = path.join(captureDir, "library-notice.json");

  /**
   * The one-time "we found your pictures" notice: shown the first time the portal starts with a library that already holds
   * pictures at the default per-user folder, until the person dismisses it. It only ever names the folder to a local person.
   */
  function locationNotice({ kind, folder, captured }) {
    if (kind !== "user-folder" || !captured) return null;
    const seen = readJson(noticeFile, null);
    if (seen?.dismissedAt) return null;
    return { id: "found-library", count: captured, text: `Found your shared screenshots${folder ? ` in ${folder}` : ""}: ${captured} ${captured === 1 ? "picture is" : "pictures are"} ready to reuse in every lab.` };
  }

  function dismissLocationNotice() {
    writeJsonAtomic(noticeFile, { schema: 1, dismissedAt: new Date(now()).toISOString() });
    return { dismissed: true };
  }

  /** `GET /api/capture/status`: what the portal shows (is a companion connected, since when, signed in to which products, and with which account). `ownerKey` limits the computers shown to the ones that work for the person asking. */
  async function statusPayload({ localRequest = false, ownerKey = null } = {}) {
    await refreshServerBrowser();
    const companion = pairing.status({ ownerKey });
    const storage = getStorageDiagnostics(env);
    const where = describeCapturedScreenshotsLocation(env);
    const location = where.kind === "explicit" ? "explicit" : where.kind === "committed" ? "baked" : "persistent";
    const library = screenshots.libraryState();
    const tenantNames = tenantUrlNames();
    // Shots waiting for a sign-in on the person's computer, until the companion reports that sign-in as done.
    const needsSignIn = jobs.latestSignInNeed({ signedInProducts: companion.signedInProducts, viewerOwnerKey: ownerKey });
    const signInNeed = needsSignIn ? { needsSignIn } : {};
    const support = companionCanRunAutonomous({ ownerKey });
    // The folder is only ever told to a person at the computer that runs the portal, never to a cloud portal's users.
    const folder = localRequest && isLocalRun(env) && where.kind !== "committed" && where.kind !== "storage-root" ? where.dir : null;
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
        // Where the screenshots come from (flags only). Null while no connected companion says (an older one does not).
        account: companion.account,
        accountSetup: companion.accountSetup,
        accountMinCompanion: ACCOUNT_MIN_COMPANION,
        accountSupported: accountCapability({ ownerKey }).supported,
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
        kind: where.kind,
        persistent: where.persistent,
        summary: describeLibraryLocation({ kind: where.kind, backend: storage.backend, folder }),
        ...(folder ? { folder } : {}),
        storage: { persistent: storage.persistent, backend: storage.backend, writable: storage.writable, blobSyncEnabled: storage.blobSync.enabled },
        total: library.summary.total,
        captured: library.summary.captured,
        missing: library.summary.missing,
        needsReview: library.summary.needsReview,
        confirmed: library.summary.confirmed,
        kept: screenshots.keptSummary(),
        notice: locationNotice({ kind: where.kind, folder, captured: library.summary.captured }),
      },
      jobs: { ...jobs.activity(), ...signInNeed },
      autonomy: { ...consentPayload(), minCompanion: AUTONOMOUS_MIN_COMPANION, companionSupported: support.supported, scratchMinCompanion: SCRATCH_MIN_COMPANION, scratchSupported: support.scratchSupported, handoffMinCompanion: HANDOFF_MIN_COMPANION, handoffSupported: support.handoffSupported, recipesMinCompanion: RECIPES_MIN_COMPANION, recipesSupported: support.recipesSupported, sharedRecipes: sharedRecipes.list().length },
      pairing: { codeTtlSec: Math.round(PAIRING_CODE_TTL_MS / 1000) },
      limits: { maxUploadBytes: MAX_UPLOAD_BYTES, acceptedTypes: ["image/png", "image/jpeg", "image/webp"] },
    };
  }

  /**
   * The capture that is already waiting or running for a request, if there is one:
   *  - `existing`: an equivalent capture (the same lab, scope, options, and addresses) started by the same person, or by
   *    someone the portal cannot tell apart. It is returned instead of queueing a second one.
   *  - `busy`: any other capture of the same lab (different scope, options, addresses, or person). A lab runs one capture
   *    at a time, so the pictures of two captures never land in the same slots together.
   * A capture of the whole shared library is not per lab, so only the equivalent check applies to it.
   */
  function activeClash(norm, env, targetText = {}, autonomy = null, ownerKey = null) {
    const candidates = jobs.active(norm.target.type === "lab" ? { labId: norm.target.labId } : {}).filter((job) => job.target.type === norm.target.type);
    const equivalent = (job) =>
      job.target.labId === norm.target.labId &&
      sameList(job.target.products, norm.target.products) &&
      job.scope.mode === norm.scope.mode &&
      sameList(job.scope.filenames, norm.scope.filenames) &&
      sameList(job.scope.featureIds, norm.scope.featureIds) &&
      (job.options?.mode || "smart") === norm.options.mode &&
      (job.options?.autonomy?.level || null) === (autonomy?.level || null) &&
      (job.options?.agentSource || null) === (norm.options.agentSource || null) &&
      Boolean(job.options?.record) === Boolean(norm.options.record) &&
      Boolean(job.options?.retake) === Boolean(norm.options.retake) &&
      sameEnv(jobs.getPlan(job.id)?.env, env) &&
      sameEnv(jobs.getPlan(job.id)?.targets, targetText);
    const same = candidates.find((job) => equivalent(job) && (norm.target.type !== "lab" || !differentPeople(job.ownerKey, ownerKey)));
    if (same) return { kind: "existing", job: same };
    if (norm.target.type !== "lab" || !candidates.length) return null;
    const other = candidates.find((job) => differentPeople(job.ownerKey, ownerKey)) || candidates[0];
    return { kind: "busy", job: other, busyBy: differentPeople(other.ownerKey, ownerKey) ? "someone-else" : "you" };
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
    // Which agent the lab's screenshots use: a word only. The address of an agent the computer created stays on that computer.
    const pick = resolveAgentSource({ saved: manifest ? readCustomization(manifest)?.captureAgentSource : null, agentSupplied: missingRequirements(["copilot-studio-agent"], resolved.values).length === 0 });
    return { labId: labId || null, activeProfile: profile ? { id: profile.id, name: profile.name } : null, agentSource: { source: pick.source, from: pick.from, saved: pick.from === "lab" }, ...describeCaptureTargets(resolved, shots), shots: shots.map((s) => ({ filename: s.filename, mode: s.capture.mode, why: s.capture.why, path: s.capture.path, needs: s.capture.needs, missing: s.capture.missing, ready: s.capture.ready })) };
  }

  /** What is left to capture for a lab, who can do it, and the steps for the ones only a person can (JSON, plus Markdown to print). */
  function labChecklist(labId) {
    const resolved = resolveCaptureTargets({ manifest: readLabManifest(labId), env });
    const list = buildLabChecklist({ generatedRoot, labId, values: resolved.values, capturedDir: capturedDirs().search });
    return list.status === 200 ? { ...list, markdown: renderChecklistMarkdown(list) } : list;
  }

  /** Each shot of a lab with how it will be captured under these settings. */
  function labShotCaptures(labId, values) {
    const plan = buildLabJobPlan({ generatedRoot, labId, scope: { mode: "all", filenames: [], featureIds: [] }, capturedDir: capturedDirs().search, values });
    return plan.status === 200 ? plan.shots : [];
  }

  /** Save capture settings on a lab (and, when asked, on the active brand profile so other labs use them too), and which agent the lab's screenshots use. */
  function saveLabTargets(labId, patch, { alsoProfile = false, agentSource = undefined } = {}) {
    const dir = labSlotsDir(labId);
    if (!dir) return { status: 404, body: { error: `Generated lab "${labId}" not found.` } };
    if (agentSource !== undefined && agentSource !== null && !["created", "own"].includes(agentSource)) return { status: 400, body: { error: 'The agent choice must be "created" or "own".' } };
    const saved = updateLabCaptureTargets(dir, patch);
    if (!saved.ok) return { status: 400, body: { error: Object.values(saved.errors)[0], errors: saved.errors } };
    if (agentSource) updateLabAgentSource(dir, agentSource);
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
   * Validate a job request, build its shot plan, and queue it. `ownerKey` (see owner.js) is who asked: the job is only given to a
   * computer that person paired, and only that person can stop it. A lab runs one capture at a time (409 `lab-busy` otherwise).
   * @returns {{status: number, body: object}}
   */
  function queueJob(body, { createdBy = null, ownerKey = null } = {}) {
    const owner = cleanOwnerKey(ownerKey);
    const norm = normalizeJobRequest(body);
    if (!norm.ok) return { status: 400, body: { error: norm.errors[0], errors: norm.errors } };

    let jobTargets = resolveJobTargets(norm, body);
    if (jobTargets.error) return { status: jobTargets.error.status, body: { error: jobTargets.error.message } };

    // Which agent the screenshots use: the request's choice, else the lab's saved one, else the agent created in this capture (an agent address that is already set keeps meaning "my own").
    const agentSupplied = missingRequirements(["copilot-studio-agent"], jobTargets.values).length === 0;
    const savedAgentSource = norm.target.type === "lab" ? readCustomization(readLabManifest(norm.target.labId))?.captureAgentSource || null : null;
    const agentPick = resolveAgentSource({ requested: requestedAgentSource(norm.options), saved: savedAgentSource, agentSupplied });
    let support = { connected: false, supported: true, scratchSupported: true, handoffSupported: true, recipesSupported: true, version: null };

    // What the computer may do comes from what the person agreed to, never from the request. A request can only ask for less.
    const stored = consent.get(consentScope(body).key);
    let mode = norm.options.mode || (stored ? "autonomous" : "smart");
    let autonomy = null;
    let downgraded = null;
    if (mode === "autonomous") {
      if (!stored) {
        return { status: 200, body: { job: null, needsConsent: true, consent: consentPayload({ body }), message: "Allow automatic capture first. It takes one minute and you decide what the computer may do." } };
      }
      support = companionCanRunAutonomous({ ownerKey: owner });
      if (support.connected && !support.supported) {
        mode = "smart";
        downgraded = { to: "smart", companionVersion: support.version, needs: AUTONOMOUS_MIN_COMPANION, message: `Your Local Capture Companion${support.version ? ` (${support.version})` : ""} is older than ${AUTONOMOUS_MIN_COMPANION}, so it cannot capture on its own yet. Download the companion again to get automatic capture. This capture runs the older way for now.` };
      } else {
        // The person's own agent is used when they chose it (or saved its address and chose nothing else); the practice agent created in this capture is the default.
        autonomy = autonomyFor(stored, { ...norm.options.autonomy, agent: agentPick.source === "own" ? "existing" : "scratch" });
        // Building from scratch needs a companion that can; an older one would only look at screens, so say so before queuing anything.
        if (autonomy?.level === "scratch" && support.connected && !support.scratchSupported) {
          return { status: 200, body: { job: null, needsNewerCompanion: { min: SCRATCH_MIN_COMPANION, version: support.version }, message: `Your Local Capture Companion${support.version ? ` (${support.version})` : ""} is older than ${SCRATCH_MIN_COMPANION}, so it cannot build the agent from scratch yet. Download the companion again, replace the old one, and try again.` } };
        }
      }
    }
    // Whether the agent can come from the creation step in this job. Only automatic capture creates anything: the other modes never do, so the choice does not apply to them.
    // When automatic capture cannot create the agent (read-only, or a companion that cannot hand it over), the shots that show an agent need an agent address, with a plain reason.
    const createdChoice = agentPick.source === "created" && mode === "autonomous";
    const creation = createdChoice ? creationState({ autonomy, mode, support }) : { possible: false, fallback: null };
    const agentFallback = createdChoice ? creation.fallback : null;
    const effectiveAgentSource = createdChoice && creation.possible ? "created" : "own";
    const planAgentSource = mode === "autonomous" ? agentPick.source : null;
    // The agent comes from the creation step: no other agent's address or name travels with the job.
    if (effectiveAgentSource === "created") jobTargets = withoutOwnAgentTargets(jobTargets);
    norm.options = { ...norm.options, mode, autonomy: autonomy ? { level: autonomy.level } : null, agentSource: effectiveAgentSource };
    const allowPractice = autonomy?.level === "practice";
    const scratch = autonomy?.level === "scratch";

    const dirs = capturedDirs();
    const plan =
      norm.target.type === "lab"
        ? buildLabJobPlan({ generatedRoot, labId: norm.target.labId, scope: norm.scope, capturedDir: dirs.search, values: jobTargets.values, allowPractice, sharedRecipes, scratch, agentSource: planAgentSource, agentFallback })
        : buildLibraryJobPlan({ scope: norm.scope, products: norm.target.products, manifestDir, capturedDir: dirs.search, values: jobTargets.values, allowPractice, sharedRecipes, scratch, agentSource: planAgentSource, agentFallback });
    if (plan.status !== 200) return { status: plan.status, body: { error: plan.error } };
    // The lab's own words for the agent (name, instructions, sample questions, a public website) travel with the job, to the companion only.
    if (scratch) autonomy = { ...autonomy, scratchContext: readLabScratchContext(plan.labDir || null, { labId: norm.target.type === "lab" ? norm.target.labId : "", title: plan.title || "" }), startFresh: norm.options.startFresh === true };

    const companion = pairing.status({ ownerKey: owner });
    const companionInfo = { connected: companion.connected, lastSeenAt: companion.lastSeenAt };
    if (!plan.shots.length) {
      return {
        status: 200,
        body: { job: null, nothingToCapture: true, companion: companionInfo, message: "Nothing to capture: every selected screenshot already exists." },
      };
    }

    // Shots that cannot run without an address are held back and the person is asked for it, not told "skipped" afterwards.
    const stillMissing = (shot) => {
      if (mode === "autonomous") {
        // A shot that runs in the practice agent (any agent screen, when it is built from scratch; any shot whose agent comes from the creation step) does not need the person's own agent.
        const practiceRun = scratch || shot.capture?.agent?.via === "created" || (allowPractice && shot.capture?.setup?.needsPractice === true);
        const needed = [...new Set([...(shot.capture?.needs || []), ...(shot.capture?.agentNeeds || [])])];
        return shot.capture?.mode !== "manual" && missingRequirements(needed, jobTargets.values).filter((id) => !(practiceRun && id === "copilot-studio-agent")).length > 0;
      }
      return shot.capture?.mode === "auto" && shot.capture.missing?.length > 0;
    };
    const waiting = mode === "guided" ? [] : plan.shots.filter(stillMissing);
    const missing = summarizeMissing(waiting.map((s) => (mode === "autonomous" ? { ...s, capture: { ...s.capture, missing: missingRequirements([...new Set([...(s.capture.needs || []), ...(s.capture.agentNeeds || [])])], jobTargets.values).filter((id) => !((scratch || s.capture?.agent?.via === "created") && id === "copilot-studio-agent")) } } : s)));
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

    const clash = activeClash(norm, jobTargets.env, jobTargets.text, autonomy, owner);
    if (clash?.kind === "existing") {
      return { status: 200, body: { job: jobs.get(clash.job.id, { viewerOwnerKey: owner }), existing: true, envSource: jobTargets.source, companion: companionInfo, message: "This capture is already queued or running." } };
    }
    if (clash?.kind === "busy") {
      const message = clash.busyBy === "someone-else" ? LAB_BUSY_MESSAGES.someoneElse : LAB_BUSY_MESSAGES.you;
      return { status: 409, body: { error: message, code: "lab-busy", existingJobId: clash.job.id, busyBy: clash.busyBy } };
    }
    const job = jobs.create({ target: norm.target, scope: norm.scope, env: jobTargets.env, targets: jobTargets.text, options: norm.options, plan, createdBy, ownerKey: owner, autonomy });
    const runnable = plan.shots.length - waiting.length;
    // The companion is too old to hand the practice agent to the other screenshots: say so in plain words, and name what to do.
    const agentHandoff = agentFallback === "companion" ? { supported: false, min: HANDOFF_MIN_COMPANION, version: support.version, message: `Your Local Capture Companion${support.version ? ` (${support.version})` : ""} is older than ${HANDOFF_MIN_COMPANION}, so it cannot hand the practice agent to the other screenshots yet. Download the companion again and replace the old one. Until then, screenshots that show an agent need an agent address.` } : null;
    // The recipe families need a newer companion. An older one still runs the job the way it always did, so the screenshots that depend on them stay with a person: say so.
    const familyShots = scratch ? plan.shots.filter((s) => s.capture?.automation?.state === "automatic" && ["conversation", "dialog", "item", "testset"].includes(s.capture.automation.family)).length : 0;
    const recipesHint = familyShots && support.connected && !support.recipesSupported
      ? { supported: false, min: RECIPES_MIN_COMPANION, version: support.version, shots: familyShots, message: `Your Local Capture Companion${support.version ? ` (${support.version})` : ""} is older than ${RECIPES_MIN_COMPANION}, so it cannot run the new automatic recipes yet. ${familyShots} screenshot${familyShots === 1 ? "" : "s"} (test conversations, dialogs, and the sample test set) still need you. Download the companion again and replace the old one.` }
      : null;
    return {
      status: 201,
      body: {
        job,
        envSource: jobTargets.source,
        companion: companionInfo,
        mode,
        agentSource: { choice: agentPick.source, effective: effectiveAgentSource, ...(agentFallback ? { fallback: agentFallback } : {}) },
        ...(agentHandoff ? { agentHandoff } : {}),
        ...(recipesHint ? { recipes: recipesHint } : {}),
        ...(autonomy ? { autonomy: { level: autonomy.level } } : {}),
        ...(downgraded ? { downgraded } : {}),
        ...(missing.length ? { missing } : {}),
        message: companion.connected
          ? `Queued ${runnable} screenshot${runnable === 1 ? "" : "s"}. Your Local Capture Companion will pick them up.${waiting.length ? ` ${waiting.length} more need${waiting.length === 1 ? "s" : ""} an address first.` : ""}${downgraded ? ` ${downgraded.message}` : ""}${agentHandoff ? ` ${agentHandoff.message}` : ""}${recipesHint ? ` ${recipesHint.message}` : ""}`
          : "Queued, but no Local Capture Companion is connected yet. Download it, pair it with a code, and it will pick this job up.",
      },
    };
  }

  /**
   * The dry plan of a capture request: which screenshots the computer will take by itself, in which order, which practice-agent objects it adds for
   * them, and which stay with a person and why. It reads the same plan a real capture would send, queues nothing, and needs no companion.
   */
  function dryPlan(body = {}) {
    const norm = normalizeJobRequest(body);
    if (!norm.ok) return { status: 400, body: { error: norm.errors[0], errors: norm.errors } };
    const jobTargets = resolveJobTargets(norm, body);
    if (jobTargets.error) return { status: jobTargets.error.status, body: { error: jobTargets.error.message } };
    const dirs = capturedDirs();
    const options = { values: jobTargets.values, scratch: true, allowPractice: false, agentSource: "created", agentFallback: null, sharedRecipes };
    const plan =
      norm.target.type === "lab"
        ? buildLabJobPlan({ generatedRoot, labId: norm.target.labId, scope: norm.scope, capturedDir: dirs.search, ...options })
        : buildLibraryJobPlan({ scope: norm.scope, products: norm.target.products, manifestDir, capturedDir: dirs.search, ...options });
    if (plan.status !== 200) return { status: plan.status, body: { error: plan.error } };
    return { status: 200, body: { dryPlan: buildDryPlan(plan), recipesMinCompanion: RECIPES_MIN_COMPANION } };
  }

  /** What the older capture endpoint returns when the server cannot run a browser. */
  async function companionFallbackForLab({ labId, onlyMissing = false, onlyStale = false, featureIds = null, createdBy = null, ownerKey = null }) {
    const owner = cleanOwnerKey(ownerKey);
    const companion = pairing.status({ ownerKey: owner });
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
      { createdBy, ownerKey: owner },
    );
    if (result.status >= 400) return { ...base, queued: false, canQueue: true, reason: "not-queued", message: result.body.error };
    if (result.body.nothingToCapture) return { ...base, queued: false, canQueue: false, reason: "nothing-to-capture", message: result.body.message };
    if (result.body.needsConsent) return { ...base, queued: false, canQueue: true, reason: "needs-consent", message: result.body.message };
    if (result.body.needsAddress) return { ...base, queued: false, canQueue: true, reason: "needs-address", message: result.body.message, missing: result.body.missing };
    const needsConsentHint = !consent.get(consentScope({}).key);
    return {
      ...base,
      queued: true,
      existing: Boolean(result.body.existing),
      jobId: result.body.job.id,
      mode: result.body.mode || null,
      ...(needsConsentHint ? { consentNeeded: true } : {}),
      message: `Capture is queued for your Local Capture Companion. It runs on your computer; follow progress in the Screenshot Center.${needsConsentHint ? " To let the computer set up and capture every screen by itself (test conversations, dialogs, Agent Builder), allow automatic capture in the Screenshot Center once." : ""}`,
    };
  }

  return {
    captureDir,
    pairing,
    jobs,
    screenshots,
    consent,
    sharedRecipes,
    sse,
    uploads,
    capabilities,
    statusPayload,
    dismissLocationNotice,
    queueJob,
    dryPlan,
    requestAccountSetup,
    accountCapability,
    consentPayload,
    saveConsent,
    revokeConsent,
    targetsPayload,
    labChecklist,
    saveLabTargets,
    saveProfileTargets,
    companionFallbackForLab,
    refreshServerBrowser,
    capturedDirs,
  };
}
