/**
 * Centralized storage path resolution and diagnostics for the portal.
 *
 * Keeps generated labs, portal JSON state (`branding.json`, approvals,
 * agent-chat config, feedback, Learn topics cache), and uploaded branding
 * assets under `PORTAL_STORAGE_ROOT` (mirrored to Azure Blob Storage via
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
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
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
  const requiredDirs = [generatedLabsDir, dataDir, labBuilderDataDir, uploadsDir];

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
  const writable = [
    resolveGeneratedLabsDir(env),
    resolvePortalDataDir(env),
    resolvePortalUploadsDir(env),
  ].every((dir) => isTargetDirWritable(dir));

  return {
    persistent: backend !== "local-disk",
    backend,
    writable,
    blobSync: resolveBlobSyncDiagnostics(env, backend),
  };
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
