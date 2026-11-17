/**
 * Bulk Microsoft Learn Drift Dashboard & Fleet Scanner.
 *
 * Provides zero-network cached drift posture summaries across all saved
 * generated labs (`summarizeLabLearnDrift`, `getFleetLearnDriftStatus`) and a
 * bounded-concurrency bulk re-validation / auto-update runner
 * (`scanAllGeneratedLabsAgainstLearn`).
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { capturedScreenshotsDirs, resolveLabScreenshot } from "./captured.js";
import { getFeature } from "./catalog.js";
import { listGeneratedLabs } from "./generated-labs.js";
import { revalidateLabAgainstLearn } from "./lab-screenshots.js";

export const FLEET_METADATA_FILENAME = "learn-drift-fleet.json";
export const DRIFT_STATUSES = Object.freeze([
  "up-to-date",
  "docs-updated",
  "missing-screenshot",
  "ungrounded",
  "not-checked",
]);

const SAFE_LAB_ID = /^[a-z0-9][a-z0-9-]{0,99}$/i;
const DEFAULT_SCAN_CONCURRENCY = 3;
const MAX_SCAN_CONCURRENCY = 8;

function isSafeLabId(rawId) {
  return typeof rawId === "string" && SAFE_LAB_ID.test(rawId) && !rawId.includes("..");
}

function resolveContainedLabDir(rootDir, labId) {
  if (!rootDir || !isSafeLabId(labId)) return null;
  const root = resolve(rootDir);
  const labDir = resolve(root, labId);
  const rel = relative(root, labDir);
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || rel !== labId) return null;
  try {
    const st = lstatSync(labDir);
    if (!st.isDirectory() || st.isSymbolicLink()) return null;
  } catch {
    return null;
  }
  return labDir;
}

function readJsonIfExists(filePath) {
  if (!filePath || !existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath, data) {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf8");
  try {
    renameSync(tmpPath, filePath);
  } catch (err) {
    rmSync(tmpPath, { force: true });
    throw err;
  }
}

function emptyCounts() {
  return {
    total: 0,
    upToDate: 0,
    docsUpdated: 0,
    missingScreenshots: 0,
    notChecked: 0,
    ungrounded: 0,
  };
}

function tallyDriftCounts(items) {
  const counts = emptyCounts();
  for (const item of items) {
    const status = item?.learnDrift?.status || item?.status || "not-checked";
    counts.total += 1;
    if (status === "up-to-date") counts.upToDate += 1;
    else if (status === "docs-updated") counts.docsUpdated += 1;
    else if (status === "missing-screenshot") counts.missingScreenshots += 1;
    else if (status === "ungrounded") counts.ungrounded += 1;
    else counts.notChecked += 1;
  }
  return counts;
}

function resolveModuleLearnUrl(moduleId, modState, manifestMod) {
  const baseline = modState?.learnBaseline || {};
  if (typeof baseline.primaryUrl === "string" && baseline.primaryUrl) return baseline.primaryUrl;
  if (Array.isArray(baseline.urls) && typeof baseline.urls[0] === "string" && baseline.urls[0]) {
    return baseline.urls[0];
  }
  if (typeof manifestMod?.steps?.url === "string" && manifestMod.steps.url) {
    return manifestMod.steps.url;
  }
  const firstSourceUrl = Array.isArray(manifestMod?.sources)
    ? manifestMod.sources.find((s) => typeof s?.url === "string" && s.url)?.url
    : null;
  if (firstSourceUrl) return firstSourceUrl;
  const catalogFeature = moduleId ? getFeature(moduleId) : null;
  if (Array.isArray(catalogFeature?.docUrls) && catalogFeature.docUrls[0]) {
    return catalogFeature.docUrls[0];
  }
  return null;
}

function detectUngroundedLab({ rawSyncStatus, moduleCount, learnState, manifestModules, manifest }) {
  if (rawSyncStatus === "ungrounded") return true;
  if (moduleCount <= 0) return false;

  const stateEntries =
    learnState?.modules && typeof learnState.modules === "object"
      ? Object.entries(learnState.modules)
      : [];
  if (stateEntries.length > 0) {
    return stateEntries.every(([key, mod]) => {
      const id = String(mod?.featureId || key);
      const manifestMod = manifestModules.find((m) => m?.id === id) || null;
      return !resolveModuleLearnUrl(id, mod, manifestMod);
    });
  }

  if (
    manifest?.grounding &&
    typeof manifest.grounding === "object" &&
    Number(manifest.grounding.groundedModules) === 0 &&
    manifestModules.length > 0
  ) {
    return manifestModules.every((mod) => !resolveModuleLearnUrl(mod?.id, null, mod));
  }

  return false;
}

/**
 * Summarize a single generated lab's cached Microsoft Learn drift posture
 * without performing any network requests or disk writes.
 *
 * @param {string} rootDir
 * @param {string} labId
 * @param {object} [manifest]
 */
export function summarizeLabLearnDrift(rootDir, labId, manifest = null) {
  const labDir = resolveContainedLabDir(rootDir, labId);
  const resolvedManifest =
    manifest && typeof manifest === "object"
      ? manifest
      : labDir
      ? readJsonIfExists(join(labDir, "manifest.json"))
      : null;

  const learnState = labDir
    ? readJsonIfExists(join(labDir, "screenshots", "learn-state.json"))
    : null;
  const shotsPlan = labDir
    ? readJsonIfExists(join(labDir, "screenshots", "shots.json"))
    : null;

  const manifestModules = Array.isArray(resolvedManifest?.modules) ? resolvedManifest.modules : [];
  const manifestModById = new Map(
    manifestModules
      .filter((m) => m && typeof m.id === "string")
      .map((m) => [m.id, m]),
  );

  const stateModuleEntries =
    learnState?.modules && typeof learnState.modules === "object"
      ? Object.entries(learnState.modules).sort(
          ([, a], [, b]) => Number(a?.order || 0) - Number(b?.order || 0),
        )
      : [];

  const moduleCount =
    manifestModules.length > 0 ? manifestModules.length : stateModuleEntries.length;

  const driftedModules = [];
  for (const [key, modState] of stateModuleEntries) {
    if (modState?.status !== "docs-updated") continue;
    const moduleId = String(modState.featureId || key);
    const manifestMod = manifestModById.get(moduleId) || null;
    driftedModules.push({
      moduleId,
      title: String(modState.title || manifestMod?.name || moduleId),
      learnUrl: resolveModuleLearnUrl(moduleId, modState, manifestMod),
    });
  }

  const rawSyncStatus =
    (typeof learnState?.learnSyncStatus === "string" && learnState.learnSyncStatus) ||
    (typeof resolvedManifest?.screenshots?.learnSyncStatus === "string" &&
      resolvedManifest.screenshots.learnSyncStatus) ||
    null;

  if (driftedModules.length === 0 && rawSyncStatus === "docs-updated") {
    for (const mod of manifestModules) {
      if (mod?.steps?.drift && mod.steps.drift !== "none") {
        const moduleId = String(mod.id || "");
        driftedModules.push({
          moduleId,
          title: String(mod.name || moduleId),
          learnUrl: resolveModuleLearnUrl(moduleId, null, mod),
        });
      }
    }
  }

  const driftedModuleCount =
    driftedModules.length > 0
      ? driftedModules.length
      : rawSyncStatus === "docs-updated"
      ? Math.max(1, Number(resolvedManifest?.screenshots?.stale || 0))
      : 0;

  let missingScreenshotCount = 0;
  if (labDir && Array.isArray(shotsPlan?.shots)) {
    const capturedDir = capturedScreenshotsDirs();
    missingScreenshotCount = shotsPlan.shots.filter(
      (shot) => !resolveLabScreenshot(labDir, shot?.filename, { capturedDir }),
    ).length;
  } else if (learnState?.shots && typeof learnState.shots === "object") {
    missingScreenshotCount = Object.values(learnState.shots).filter((s) => !s?.captured).length;
  } else if (resolvedManifest?.screenshots && typeof resolvedManifest.screenshots === "object") {
    missingScreenshotCount = Math.max(
      0,
      Number(
        resolvedManifest.screenshots.pending ??
          resolvedManifest.screenshots.toCapture ??
          0,
      ),
    );
  }

  const lastCheckedAt =
    (typeof learnState?.lastRevalidatedAt === "string" && learnState.lastRevalidatedAt) ||
    (typeof resolvedManifest?.screenshots?.lastRevalidatedAt === "string" &&
      resolvedManifest.screenshots.lastRevalidatedAt) ||
    null;

  const isUngrounded = detectUngroundedLab({
    rawSyncStatus,
    moduleCount,
    learnState,
    manifestModules,
    manifest: resolvedManifest,
  });

  let status;
  if (driftedModuleCount > 0 || rawSyncStatus === "docs-updated") {
    status = "docs-updated";
  } else if (isUngrounded) {
    status = "ungrounded";
  } else if (rawSyncStatus === "not-checked" || !lastCheckedAt) {
    status = "not-checked";
  } else if (missingScreenshotCount > 0 || rawSyncStatus === "missing-screenshot") {
    status = "missing-screenshot";
  } else {
    status = "up-to-date";
  }

  return {
    status,
    lastCheckedAt,
    driftedModuleCount,
    driftedModules,
    missingScreenshotCount,
    moduleCount,
  };
}

function readFleetMetadata(rootDir) {
  if (!rootDir || !existsSync(rootDir)) return null;
  const root = resolve(rootDir);
  const metaPath = resolve(root, FLEET_METADATA_FILENAME);
  if (relative(root, metaPath) !== FLEET_METADATA_FILENAME) return null;
  try {
    if (lstatSync(metaPath).isSymbolicLink()) return null;
  } catch {
    return null;
  }
  return readJsonIfExists(metaPath);
}

/**
 * Return cached fleet-wide Microsoft Learn drift status across all saved
 * generated labs in `rootDir` without making network calls.
 *
 * @param {string} rootDir
 */
export function getFleetLearnDriftStatus(rootDir) {
  const { labs: rawLabs } = listGeneratedLabs(rootDir);
  const fleetMeta = readFleetMetadata(rootDir);
  const lastBulkScanAt =
    typeof fleetMeta?.lastBulkScanAt === "string" && fleetMeta.lastBulkScanAt
      ? fleetMeta.lastBulkScanAt
      : null;

  const labs = rawLabs.map((lab) => {
    const drift = lab.learnDrift || summarizeLabLearnDrift(rootDir, lab.labId, null);
    return {
      labId: lab.labId,
      title: lab.title,
      generatedAt: lab.generatedAt || null,
      updatedAt: lab.updatedAt || null,
      ...drift,
      learnDrift: drift,
    };
  });

  return {
    lastBulkScanAt,
    counts: tallyDriftCounts(labs),
    labs,
  };
}

/**
 * Bulk scan saved generated labs in `rootDir` against live Microsoft Learn
 * documentation with bounded concurrency, optionally auto-updating drifted
 * lab steps, standalone HTML, and per-topic DOCX/PPTX artifacts.
 *
 * @param {string} rootDir
 * @param {object} [options]
 * @param {string[]} [options.labIds]
 * @param {boolean} [options.autoUpdate=false]
 * @param {boolean} [options.bypassCache=true]
 * @param {number} [options.concurrency=3]
 * @param {Function} [options.fetchDoc]
 * @param {string} [options.capturedDir]
 * @param {AbortSignal} [options.signal]
 */
export async function scanAllGeneratedLabsAgainstLearn(
  rootDir,
  {
    labIds,
    autoUpdate = false,
    bypassCache = true,
    concurrency = DEFAULT_SCAN_CONCURRENCY,
    fetchDoc,
    capturedDir,
    signal,
  } = {},
) {
  const root = resolve(rootDir);

  let targetLabIds;
  if (labIds !== undefined && labIds !== null) {
    if (!Array.isArray(labIds)) {
      return {
        status: 400,
        body: { error: "labIds must be an array of valid lab IDs." },
      };
    }
    const normalized = [];
    const seen = new Set();
    for (const rawId of labIds) {
      if (!isSafeLabId(rawId)) {
        return {
          status: 400,
          body: { error: "Invalid lab id in labIds." },
        };
      }
      const candidate = resolve(root, rawId);
      const rel = relative(root, candidate);
      if (!rel || rel.startsWith("..") || isAbsolute(rel) || rel !== rawId) {
        return {
          status: 400,
          body: { error: "Invalid lab id in labIds." },
        };
      }
      if (!seen.has(rawId)) {
        seen.add(rawId);
        normalized.push(rawId);
      }
    }
    targetLabIds = normalized;
  } else {
    targetLabIds = listGeneratedLabs(root).labs.map((lab) => lab.labId);
  }

  const workerCount = Math.max(
    1,
    Math.min(MAX_SCAN_CONCURRENCY, Math.floor(Number(concurrency) || DEFAULT_SCAN_CONCURRENCY)),
  );

  const results = new Array(targetLabIds.length);
  let cursor = 0;

  async function runWorker() {
    while (cursor < targetLabIds.length) {
      const idx = cursor++;
      const labId = targetLabIds[idx];
      try {
        const outcome = await revalidateLabAgainstLearn(root, labId, {
          autoUpdate: Boolean(autoUpdate),
          updateSteps: Boolean(autoUpdate),
          autoCapture: false,
          bypassCache: bypassCache !== false,
          fetchDoc,
          capturedDir,
          signal,
        });

        const drift = summarizeLabLearnDrift(root, labId);
        if (outcome.status !== 200) {
          results[idx] = {
            labId,
            ok: false,
            status: "error",
            httpStatus: outcome.status,
            error: outcome.body?.error || `Revalidation failed (${outcome.status})`,
            updated: false,
            driftedModuleCount: drift.driftedModuleCount,
            driftedModules: drift.driftedModules,
            missingScreenshotCount: drift.missingScreenshotCount,
            lastCheckedAt: drift.lastCheckedAt,
            learnDrift: drift,
          };
          continue;
        }

        const updatedModuleIds = Array.isArray(outcome.body?.updatedModuleIds)
          ? outcome.body.updatedModuleIds
          : [];
        const stepsUpdated = Boolean(
          autoUpdate &&
            (updatedModuleIds.length > 0 ||
              (Array.isArray(outcome.body?.modules) &&
                outcome.body.modules.some((m) => m?.stepsUpdated || m?.baselineUpdated))),
        );

        results[idx] = {
          labId,
          ok: true,
          status: drift.status,
          httpStatus: 200,
          error: null,
          updated: stepsUpdated,
          updatedModuleIds: stepsUpdated ? updatedModuleIds : [],
          driftedModuleCount: drift.driftedModuleCount,
          driftedModules: drift.driftedModules,
          missingScreenshotCount: drift.missingScreenshotCount,
          lastCheckedAt: drift.lastCheckedAt,
          learnDrift: drift,
        };
      } catch (err) {
        const drift = summarizeLabLearnDrift(root, labId);
        results[idx] = {
          labId,
          ok: false,
          status: "error",
          httpStatus: 500,
          error: err?.message || "Unexpected error while scanning lab against Microsoft Learn.",
          updated: false,
          driftedModuleCount: drift.driftedModuleCount,
          driftedModules: drift.driftedModules,
          missingScreenshotCount: drift.missingScreenshotCount,
          lastCheckedAt: drift.lastCheckedAt,
          learnDrift: drift,
        };
      }
    }
  }

  if (targetLabIds.length > 0) {
    await Promise.all(
      Array.from({ length: Math.min(workerCount, targetLabIds.length) }, () => runWorker()),
    );
  }

  const scannedAt = new Date().toISOString();
  const scannedCount = results.filter((r) => r?.ok).length;
  const updatedCount = results.filter((r) => r?.ok && r?.updated).length;
  const errorCount = results.filter((r) => !r?.ok).length;

  mkdirSync(root, { recursive: true });
  const fleetBeforePersist = getFleetLearnDriftStatus(root);
  const persistedMeta = {
    schemaVersion: 1,
    lastBulkScanAt: scannedAt,
    autoUpdate: Boolean(autoUpdate),
    scannedCount,
    updatedCount,
    errorCount,
    counts: fleetBeforePersist.counts,
  };
  writeJsonAtomic(join(root, FLEET_METADATA_FILENAME), persistedMeta);

  const fleet = getFleetLearnDriftStatus(root);

  return {
    status: 200,
    body: {
      scannedAt,
      scannedCount,
      updatedCount,
      errorCount,
      counts: fleet.counts,
      results,
      fleet,
    },
  };
}
