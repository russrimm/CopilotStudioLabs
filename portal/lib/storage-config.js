/**
 * Centralized storage path resolution and diagnostics for the portal.
 *
 * Keeps generated labs, portal JSON state (`branding.json`, approvals,
 * agent-chat config, feedback, Learn topics cache, screenshot capture jobs and
 * paired devices), uploaded branding assets, and the shared captured-screenshot
 * library under `PORTAL_STORAGE_ROOT` (mirrored to Azure Blob Storage via
 * passwordless Managed Identity in Container Apps, or on a persistent volume)
 * when configured, while falling back to the repository's local layout for
 * offline CLI runs and local development.
 *
 * Uses only Node built-in modules so offline CLI imports (`topic-store.js`)
 * work without `portal/node_modules`.
 */

import { randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  closeSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const PORTAL_ROOT = resolve(__dirname, "..");
export const REPO_ROOT = resolve(PORTAL_ROOT, "..");
export const OUTPUT_ROOT = resolve(REPO_ROOT, "generated-labs");

const SAFE_UPLOAD_FILENAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}\.(png|jpe?g)$/i;
const UPLOAD_CONTENT_TYPES = Object.freeze({
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
});

function trimEnv(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Resolve where generated labs are written and read.
 * Precedence: `LAB_BUILDER_OUTPUT_DIR` -> `${PORTAL_STORAGE_ROOT}/generated-labs` -> `OUTPUT_ROOT`.
 */
export function resolveGeneratedLabsDir(env = process.env) {
  const explicit = trimEnv(env?.LAB_BUILDER_OUTPUT_DIR);
  if (explicit) return resolve(explicit);
  const storageRoot = trimEnv(env?.PORTAL_STORAGE_ROOT);
  return storageRoot ? resolve(storageRoot, "generated-labs") : OUTPUT_ROOT;
}

/**
 * Resolve where mutable portal JSON state lives (`branding.json`, approvals,
 * agent-chat config, `feedback.json`, and `lab-builder/topics-cache.json`).
 * Precedence: `PORTAL_DATA_DIR` -> `${PORTAL_STORAGE_ROOT}/data` -> `${PORTAL_ROOT}/data`.
 */
export function resolvePortalDataDir(env = process.env) {
  const explicit = trimEnv(env?.PORTAL_DATA_DIR);
  if (explicit) return resolve(explicit);
  const storageRoot = trimEnv(env?.PORTAL_STORAGE_ROOT);
  return storageRoot ? resolve(storageRoot, "data") : resolve(PORTAL_ROOT, "data");
}

/**
 * Resolve where uploaded branding logos live.
 * Precedence: `PORTAL_UPLOADS_DIR` -> `${PORTAL_STORAGE_ROOT}/uploads` -> `${PORTAL_ROOT}/public/uploads`.
 */
export function resolvePortalUploadsDir(env = process.env) {
  const explicit = trimEnv(env?.PORTAL_UPLOADS_DIR);
  if (explicit) return resolve(explicit);
  const storageRoot = trimEnv(env?.PORTAL_STORAGE_ROOT);
  return storageRoot ? resolve(storageRoot, "uploads") : resolve(PORTAL_ROOT, "public", "uploads");
}

/** The feature tour's committed screenshots, baked into the container image. Read-only in production. */
export const BAKED_CAPTURED_SCREENSHOTS_DIR = resolve(REPO_ROOT, "docs", "feature-tour", "screenshots");

/** The folder name the per-user data home uses on every platform. */
export const USER_DATA_HOME_NAME = "CopilotStudioLabsPortal";

const ONEDRIVE_ENV_NAMES = ["OneDrive", "OneDriveCommercial", "OneDriveConsumer"];

function insideOrSame(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Whether `dir` sits in a OneDrive-synced folder: a path segment named OneDrive..., or inside a folder OneDrive says it syncs. */
function isInsideOneDrive(dir, env) {
  if (/(^|[\\/])OneDrive[^\\/]*([\\/]|$)/i.test(dir)) return true;
  return ONEDRIVE_ENV_NAMES.some((name) => {
    const root = trimEnv(env?.[name]);
    return root && isAbsolute(root) && insideOrSame(root, dir);
  });
}

/**
 * Where a person's own machine keeps the shared screenshot library when nothing else is configured: a per-user folder
 * outside the repository and outside OneDrive. Only `env` (and the injected `platform` and `home`) are read, so a test
 * with its own `env` never reaches the real profile. Returns `null` when no such folder can be worked out.
 *
 *   Windows  %LOCALAPPDATA%\CopilotStudioLabsPortal\screenshots   (else %USERPROFILE%\AppData\Local\...)
 *   macOS    ~/Library/Application Support/CopilotStudioLabsPortal/screenshots
 *   others   $XDG_DATA_HOME/CopilotStudioLabsPortal/screenshots   (else ~/.local/share/...)
 *
 * @param {{env?: NodeJS.ProcessEnv, platform?: string, home?: string|null}} [options]
 *   `home` replaces the home folder (default: `HOME` or `USERPROFILE` from `env`, and the real home only for `process.env`).
 */
export function resolveUserDataHome({ env = process.env, platform = process.platform, home = undefined } = {}) {
  const homeDir = home !== undefined ? home : trimEnv(env?.HOME) || trimEnv(env?.USERPROFILE) || (env === process.env ? homedir() : "");
  const candidates = [];
  if (platform === "win32") {
    candidates.push(trimEnv(env?.LOCALAPPDATA));
    if (homeDir) candidates.push(join(homeDir, "AppData", "Local"));
  } else if (platform === "darwin") {
    if (homeDir) candidates.push(join(homeDir, "Library", "Application Support"));
  } else {
    const xdg = trimEnv(env?.XDG_DATA_HOME);
    if (xdg && isAbsolute(xdg)) candidates.push(xdg);
    if (homeDir) candidates.push(join(homeDir, ".local", "share"));
  }
  const base = candidates.find((dir) => dir && isAbsolute(dir) && !isInsideOneDrive(dir, env));
  return base ? resolve(base, USER_DATA_HOME_NAME) : null;
}

/** The default shared-library folder (`<user data home>/screenshots`), or `null` when no per-user folder can be worked out. */
export function resolveDefaultUserLibraryDir(options = {}) {
  const home = resolveUserDataHome(options);
  return home ? resolve(home, "screenshots") : null;
}

/**
 * A test run (`node --test`) that did not inject its own environment never reads or writes a person's real library:
 * it keeps the committed folder as before. Any environment object a test builds itself is always honored.
 */
function realProfileOffLimits(env) {
  return env === process.env && Boolean(process.env.NODE_TEST_CONTEXT) && trimEnv(process.env.PORTAL_USER_LIBRARY) !== "on";
}

/**
 * Where the shared captured-screenshot library lives and why:
 * `explicit` (`FEATURE_TOUR_SCREENSHOTS_DIR`), `storage-root` (`${PORTAL_STORAGE_ROOT}/screenshots`, mirrored to Azure Blob or a
 * persistent volume), `user-folder` (the per-user folder above), or `committed` (the repository's `docs/feature-tour/screenshots`).
 *
 * @returns {{kind: "explicit"|"storage-root"|"user-folder"|"committed", dir: string, persistent: boolean}}
 */
export function describeCapturedScreenshotsLocation(env = process.env, options = {}) {
  const explicit = trimEnv(env?.FEATURE_TOUR_SCREENSHOTS_DIR);
  if (explicit) {
    const dir = resolve(explicit);
    return { kind: "explicit", dir, persistent: dir !== BAKED_CAPTURED_SCREENSHOTS_DIR };
  }
  const storageRoot = trimEnv(env?.PORTAL_STORAGE_ROOT);
  if (storageRoot) return { kind: "storage-root", dir: resolve(storageRoot, "screenshots"), persistent: true };
  const userDir = realProfileOffLimits(env) ? null : resolveDefaultUserLibraryDir({ env, ...options });
  if (userDir) return { kind: "user-folder", dir: userDir, persistent: true };
  return { kind: "committed", dir: BAKED_CAPTURED_SCREENSHOTS_DIR, persistent: false };
}

/**
 * Resolve where the shared captured-screenshot library is written.
 * Precedence: `FEATURE_TOUR_SCREENSHOTS_DIR` -> `${PORTAL_STORAGE_ROOT}/screenshots`
 * -> the per-user folder (`%LOCALAPPDATA%\CopilotStudioLabsPortal\screenshots` and its macOS/Linux equivalents)
 * -> the committed `docs/feature-tour/screenshots` (only when no per-user folder can be worked out).
 */
export function resolveCapturedScreenshotsDir(env = process.env, options = {}) {
  return describeCapturedScreenshotsLocation(env, options).dir;
}

/**
 * Every folder a captured screenshot may be read from, best first. An explicit
 * `FEATURE_TOUR_SCREENSHOTS_DIR` is exclusive (previews and tests stay isolated);
 * otherwise the persistent folder wins and the committed folder is a read-only fallback.
 */
export function resolveCapturedScreenshotsSearchDirs(env = process.env, options = {}) {
  const primary = resolveCapturedScreenshotsDir(env, options);
  if (trimEnv(env?.FEATURE_TOUR_SCREENSHOTS_DIR)) return [primary];
  return primary === BAKED_CAPTURED_SCREENSHOTS_DIR ? [primary] : [primary, BAKED_CAPTURED_SCREENSHOTS_DIR];
}

/**
 * Where pictures from a deleted or replaced lab are kept for a while (see `lib/capture/kept-pictures.js`). It sits inside
 * the library folder (`<library>/.kept`), so it persists and is mirrored to Azure Blob with the library. The committed
 * folder is never written to, so when the library is that folder the pictures are kept under the portal data folder.
 */
export function resolveKeptScreenshotsDir(env = process.env, options = {}) {
  const library = resolveCapturedScreenshotsDir(env, options);
  return library === BAKED_CAPTURED_SCREENSHOTS_DIR ? resolve(resolvePortalDataDir(env), "capture", "kept-pictures") : resolve(library, ".kept");
}

function probeDirWriteReadiness(dirPath) {
  let probePath = null;
  try {
    const info = statSync(dirPath);
    if (!info.isDirectory()) return false;
    accessSync(dirPath, constants.W_OK);
    probePath = resolve(dirPath, `.portal-storage-probe-${process.pid}-${randomUUID()}`);
    writeFileSync(probePath, "ok", { flag: "wx" });
    unlinkSync(probePath);
    probePath = null;
    return true;
  } catch {
    if (probePath) {
      try {
        if (existsSync(probePath)) unlinkSync(probePath);
      } catch {
        // Ignore probe cleanup errors on read-only or degraded mounts.
      }
    }
    return false;
  }
}

function isTargetDirWritable(targetDir) {
  try {
    let current = resolve(targetDir);
    while (!existsSync(current)) {
      const parent = dirname(current);
      if (parent === current) return false;
      current = parent;
    }
    const info = statSync(current);
    if (!info.isDirectory()) return false;
    accessSync(current, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure `generatedLabsDir`, `dataDir`, `${dataDir}/lab-builder`, and `uploadsDir`
 * exist and run a non-fatal write-readiness probe on each directory.
 */
export function ensurePortalStorageDirs(env = process.env) {
  const generatedLabsDir = resolveGeneratedLabsDir(env);
  const dataDir = resolvePortalDataDir(env);
  const labBuilderDataDir = resolve(dataDir, "lab-builder");
  const uploadsDir = resolvePortalUploadsDir(env);
  const screenshotsDir = resolveCapturedScreenshotsDir(env);
  const requiredDirs = [generatedLabsDir, dataDir, labBuilderDataDir, uploadsDir];
  // The baked library is committed and read-only in the image; only a persistent or explicit one must be writable.
  if (screenshotsDir !== BAKED_CAPTURED_SCREENSHOTS_DIR) requiredDirs.push(screenshotsDir);

  let writable = true;
  for (const dir of requiredDirs) {
    try {
      mkdirSync(dir, { recursive: true });
      if (!probeDirWriteReadiness(dir)) {
        writable = false;
      }
    } catch {
      writable = false;
    }
  }

  return {
    generatedLabsDir,
    dataDir,
    labBuilderDataDir,
    uploadsDir,
    screenshotsDir,
    writable,
  };
}

let blobSyncStatusProvider = null;

/**
 * Register (or clear with `null`) the process-wide Azure Blob sync diagnostics
 * callback used by `getStorageDiagnostics()` for `/healthz` and `/api/config`.
 */
export function registerBlobSyncStatusProvider(provider) {
  blobSyncStatusProvider = typeof provider === "function" ? provider : null;
}

function resolveStorageBackend(env = process.env) {
  const explicit = trimEnv(env?.PORTAL_STORAGE_BACKEND).toLowerCase();
  if (
    explicit === "azure-blob" ||
    explicit === "azure-files" ||
    explicit === "custom-volume" ||
    explicit === "local-disk"
  ) {
    return explicit;
  }

  if (trimEnv(env?.AZURE_STORAGE_BLOB_ENDPOINT)) {
    return "azure-blob";
  }

  const hasStorageRoot = Boolean(trimEnv(env?.PORTAL_STORAGE_ROOT));
  const inAzureContainerApps = Boolean(
    trimEnv(env?.CONTAINER_APP_NAME) ||
      trimEnv(env?.CONTAINER_APP_REVISION) ||
      trimEnv(env?.CONTAINER_APP_ENV_DNS_SUFFIX),
  );

  if (hasStorageRoot && inAzureContainerApps) {
    return "azure-files";
  }

  const hasCustomVolume = Boolean(
    hasStorageRoot ||
      trimEnv(env?.LAB_BUILDER_OUTPUT_DIR) ||
      trimEnv(env?.PORTAL_DATA_DIR) ||
      trimEnv(env?.PORTAL_UPLOADS_DIR),
  );

  return hasCustomVolume ? "custom-volume" : "local-disk";
}

function resolveBlobSyncDiagnostics(env, backend) {
  const endpointConfigured = Boolean(trimEnv(env?.AZURE_STORAGE_BLOB_ENDPOINT));
  const enabled = endpointConfigured || backend === "azure-blob";

  if (env === process.env && typeof blobSyncStatusProvider === "function") {
    const live = blobSyncStatusProvider();
    if (live && typeof live === "object") {
      return {
        enabled: Boolean(live.enabled),
        hydrated: Boolean(live.hydrated),
        hydratedFiles: Number.isFinite(live.hydratedFiles) ? live.hydratedFiles : 0,
        syncedFiles: Number.isFinite(live.syncedFiles) ? live.syncedFiles : 0,
        lastSyncAt: typeof live.lastSyncAt === "string" ? live.lastSyncAt : null,
        healthy: Boolean(live.healthy),
      };
    }
  }

  return {
    enabled,
    hydrated: false,
    hydratedFiles: 0,
    syncedFiles: 0,
    lastSyncAt: null,
    healthy: enabled ? endpointConfigured : true,
  };
}

/**
 * Return safe, path-free storage metadata suitable for `/healthz` and `/api/config`.
 *
 * @returns {{
 *   persistent: boolean,
 *   backend: "azure-blob" | "azure-files" | "custom-volume" | "local-disk",
 *   writable: boolean,
 *   blobSync: {
 *     enabled: boolean,
 *     hydrated: boolean,
 *     hydratedFiles: number,
 *     syncedFiles: number,
 *     lastSyncAt: string | null,
 *     healthy: boolean,
 *   }
 * }}
 */
export function getStorageDiagnostics(env = process.env) {
  const backend = resolveStorageBackend(env);
  const screenshotsDir = resolveCapturedScreenshotsDir(env);
  const writable = [
    resolveGeneratedLabsDir(env),
    resolvePortalDataDir(env),
    resolvePortalUploadsDir(env),
    ...(screenshotsDir === BAKED_CAPTURED_SCREENSHOTS_DIR ? [] : [screenshotsDir]),
  ].every((dir) => isTargetDirWritable(dir));

  return {
    persistent: backend !== "local-disk",
    backend,
    writable,
    blobSync: resolveBlobSyncDiagnostics(env, backend),
  };
}

/**
 * Path-free facts about the shared screenshot library for `/healthz`: where it lives (`explicit`, `storage-root`,
 * `user-folder`, or `committed`) and whether pictures saved there survive a restart.
 */
export function getScreenshotLibraryDiagnostics(env = process.env) {
  const { kind, persistent } = describeCapturedScreenshotsLocation(env);
  return { location: kind, persistent };
}

function hasMarkupSignature(filePath) {
  let fd = null;
  try {
    fd = openSync(filePath, "r");
    const sample = Buffer.alloc(256);
    const bytesRead = readSync(fd, sample, 0, sample.length, 0);
    const head = sample.subarray(0, bytesRead).toString("utf8");
    return /^\s*(?:<\?xml|<!doctype\s+(?:svg|html)|<(?:svg|html|script)\b)/i.test(head);
  } catch {
    return true;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close errors.
      }
    }
  }
}

/**
 * Validate and resolve a single uploaded raster logo inside `resolvePortalUploadsDir(env)`.
 * Rejects path traversal, symlinks, non-raster extensions (including `.svg`), and disguised markup.
 */
export function resolveSafeUploadFile(rawFileName, env = process.env) {
  const name = String(rawFileName ?? "");
  if (!name) {
    return { status: 404, error: "Asset not found" };
  }
  if (!SAFE_UPLOAD_FILENAME.test(name) || name.includes("..") || /[\\/\0]/.test(name)) {
    return { status: 400, error: "Invalid upload filename" };
  }

  const ext = extname(name).toLowerCase();
  const contentType = UPLOAD_CONTENT_TYPES[ext];
  if (!contentType) {
    return { status: 400, error: "Invalid upload filename" };
  }

  const uploadsDir = resolvePortalUploadsDir(env);
  const filePath = resolve(uploadsDir, name);
  const rel = relative(uploadsDir, filePath);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    return { status: 400, error: "Invalid upload filename" };
  }

  if (!existsSync(filePath)) {
    return { status: 404, error: "Asset not found" };
  }

  try {
    const info = lstatSync(filePath);
    if (info.isSymbolicLink() || !info.isFile()) {
      return { status: 400, error: "Invalid upload filename" };
    }
  } catch {
    return { status: 404, error: "Asset not found" };
  }

  if (hasMarkupSignature(filePath)) {
    return { status: 400, error: "Invalid upload content" };
  }

  return {
    status: 200,
    path: filePath,
    type: contentType,
  };
}
