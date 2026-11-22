/**
 * SFI-compliant passwordless Managed Identity Azure Blob persistence mirror.
 *
 * Mirrors `generated-labs/`, `data/`, `uploads/`, and `screenshots/` between local container
 * disk (`PORTAL_STORAGE_ROOT`) and Azure Blob Storage over HTTPS using Entra
 * Managed Identity RBAC (`Storage Blob Data Contributor`) with zero storage
 * account keys and zero external npm dependencies (Node 24 built-ins only).
 *
 * Upload passes: `scheduleBlobSync()` is a cheap synchronous call that debounces a burst into one pass (never later
 * than `BLOB_SYNC_MAX_WAIT_MS`). Every entry point (scheduled, flush, manual, shutdown) runs through one serialized
 * runner, so two passes never overlap. A pass yields to the event loop as it walks the tree, and sends a file only if
 * it is unchanged since it was read. A failed pass retries on a bounded exponential backoff
 * (`BLOB_SYNC_RETRY_BASE_MS`), independent of any request.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, promises as fsp, renameSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import {
  ensurePortalStorageDirs,
  registerBlobSyncStatusProvider,
  resolveCapturedScreenshotsDir,
  resolveGeneratedLabsDir,
  resolvePortalDataDir,
  resolvePortalUploadsDir,
} from "./storage-config.js";

export const STORAGE_RESOURCE_AUDIENCE = "https://storage.azure.com/";
export const BLOB_API_VERSION = "2023-11-03";
export const DEFAULT_BLOB_CONTAINER = "portalstate";
export const MANAGED_BLOB_PREFIXES = Object.freeze(["generated-labs", "data", "uploads", "screenshots"]);

const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_SYNC_DEBOUNCE_MS = 250;
// A burst of changes never postpones the next upload pass by more than this (env BLOB_SYNC_MAX_WAIT_MS).
const DEFAULT_SYNC_MAX_WAIT_MS = 30000;
// Backoff between automatic retries of a failed pass (env BLOB_SYNC_RETRY_BASE_MS), doubling up to the attempt cap.
const DEFAULT_SYNC_FAILURE_RETRY_BASE_MS = 2000;
const MAX_SYNC_FAILURE_RETRIES = 5;
const MAX_SYNC_FAILURE_RETRY_DELAY_MS = 5 * 60 * 1000;
// A pass that skipped a file because it changed mid-pass reruns at most this many times back to back.
const MAX_CHURN_RERUNS = 3;
const DEFAULT_SHUTDOWN_FLUSH_TIMEOUT_MS = 10000;
// A pass hands the event loop back after this many files or this much work, whichever comes first.
const YIELD_EVERY_FILES = 20;
const YIELD_EVERY_MS = 15;
const HASH_SLICE_BYTES = 4 * 1024 * 1024;
// A file modified this recently when tracked is re-hashed instead of trusted by size and mtime alone, because a second
// write inside the same timestamp tick would look unchanged.
const RACY_STAMP_WINDOW_MS = 2000;
const DEFAULT_HYDRATE_CONCURRENCY = 6;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 150;
const DEFAULT_REQUEST_TIMEOUT_MS = 120000;
const DEFAULT_IMDS_TIMEOUT_MS = 5000;
const IMDS_TOKEN_ENDPOINT = "http://169.254.169.254/metadata/identity/oauth2/token";

const CONTENT_TYPES_BY_EXT = Object.freeze({
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
});

function trimEnv(value) {
  return typeof value === "string" ? value.trim() : "";
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function sleep(ms) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolveTimer) => setTimeout(resolveTimer, ms));
}

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function inferContentType(blobName) {
  const ext = extname(blobName).toLowerCase();
  return CONTENT_TYPES_BY_EXT[ext] || "application/octet-stream";
}

function createStageError(message, { stage = "blob", httpStatus = null, code = null, retryable = false } = {}) {
  const err = new Error(message);
  err.stage = stage;
  if (typeof httpStatus === "number") err.httpStatus = httpStatus;
  if (code) err.code = code;
  err.retryable = Boolean(retryable);
  return err;
}

/**
 * Return a strictly sanitized diagnostic description that never exposes URLs,
 * storage account names, bearer tokens, headers, or filesystem paths.
 */
export function sanitizeBlobError(err) {
  if (!err) return null;
  if (err.code === "UNSAFE_BLOB_PATH") {
    return "Unsafe blob path rejected";
  }
  const stageLabel = err.stage === "token" ? "Managed identity token" : "Blob storage";
  if (typeof err.httpStatus === "number") {
    return `${stageLabel} request failed (HTTP ${err.httpStatus})`;
  }
  if (err.name === "TimeoutError" || err.name === "AbortError") {
    return `${stageLabel} request timed out`;
  }
  return `${stageLabel} network or I/O error`;
}

/**
 * Decode XML character & named entities in a single pass so `&amp;lt;` decodes
 * to `&lt;` and never double-unescapes.
 */
export function decodeXmlEntities(raw) {
  return String(raw ?? "").replace(
    /&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-fA-F]+);/g,
    (full, entity) => {
      switch (entity) {
        case "lt":
          return "<";
        case "gt":
          return ">";
        case "quot":
          return '"';
        case "apos":
          return "'";
        case "amp":
          return "&";
        default: {
          const codePoint = entity.startsWith("#x") || entity.startsWith("#X")
            ? Number.parseInt(entity.slice(2), 16)
            : Number.parseInt(entity.slice(1), 10);
          if (!Number.isInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) {
            return full;
          }
          try {
            return String.fromCodePoint(codePoint);
          } catch {
            return full;
          }
        }
      }
    },
  );
}

/**
 * Parse Azure Blob `List Blobs` XML payload into `{ names, nextMarker }`.
 */
export function parseListBlobsXml(xmlText) {
  const xml = String(xmlText ?? "");
  const names = [];
  const blobRegex = /<Blob\b[^>]*>([\s\S]*?)<\/Blob>/gi;
  let blobMatch;
  while ((blobMatch = blobRegex.exec(xml)) !== null) {
    const inner = blobMatch[1];
    const nameMatch = /<Name>([\s\S]*?)<\/Name>/i.exec(inner);
    if (nameMatch) {
      names.push(decodeXmlEntities(nameMatch[1]));
    }
  }

  // Strip `<Blobs>...</Blobs>` before reading top-level `<NextMarker>`.
  const withoutBlobs = xml.replace(/<Blobs\b[^>]*>[\s\S]*?<\/Blobs>/gi, "");
  const markerMatch = /<NextMarker>([\s\S]*?)<\/NextMarker>/i.exec(withoutBlobs);
  const nextMarker = markerMatch ? decodeXmlEntities(markerMatch[1]).trim() : "";

  return { names, nextMarker };
}

/**
 * Check whether a blob name contains any traversal, drive-letter, slash,
 * control-character, or encoded-traversal hazard.
 */
export function isUnsafeBlobName(blobName) {
  if (typeof blobName !== "string" || blobName.length === 0 || blobName.length > 1024) {
    return true;
  }
  if (/[\x00-\x1f\x7f\\:]/.test(blobName)) {
    return true;
  }
  if (blobName.startsWith("/") || blobName.endsWith("/")) {
    return true;
  }
  if (/(?:%2e%2e|%2f|%5c|%00)/i.test(blobName)) {
    return true;
  }
  const segments = blobName.split("/");
  for (const seg of segments) {
    if (!seg || seg === "." || seg === "..") {
      return true;
    }
  }
  return false;
}

/**
 * Validate `blobName` against path traversal and return normalized segments.
 * Throws an `UNSAFE_BLOB_PATH` error if invalid.
 */
export function validateSafeBlobName(blobName, { requireManagedPrefix = false } = {}) {
  if (isUnsafeBlobName(blobName)) {
    throw createStageError("Unsafe blob path rejected", {
      stage: "validation",
      code: "UNSAFE_BLOB_PATH",
      retryable: false,
    });
  }
  const segments = blobName.split("/");
  if (requireManagedPrefix) {
    if (segments.length < 2 || !MANAGED_BLOB_PREFIXES.includes(segments[0])) {
      throw createStageError("Unsafe blob path rejected", {
        stage: "validation",
        code: "UNSAFE_BLOB_PATH",
        retryable: false,
      });
    }
  }
  return segments;
}

export function encodeBlobPath(blobName) {
  const segments = validateSafeBlobName(blobName);
  return segments.map((segment) => encodeURIComponent(segment)).join("/");
}

// Half-written copies and lock leftovers: never uploaded, in a file or a folder name.
function isTransientFileName(fileName) {
  return (
    fileName.startsWith(".portal-storage-probe-") ||
    fileName.includes(".blob-tmp-") ||
    fileName.includes(".stale-") ||
    /\.tmp$/i.test(fileName)
  );
}

function resolvePrefixDirs(env) {
  return {
    "generated-labs": resolveGeneratedLabsDir(env),
    data: resolvePortalDataDir(env),
    uploads: resolvePortalUploadsDir(env),
    screenshots: resolveCapturedScreenshotsDir(env),
  };
}

function assertNoSymlinkAncestors(baseDir, targetPath) {
  const rel = relative(baseDir, targetPath);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw createStageError("Unsafe blob path rejected", {
      stage: "validation",
      code: "UNSAFE_BLOB_PATH",
      retryable: false,
    });
  }
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  let current = baseDir;
  if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
    throw createStageError("Unsafe blob path rejected", {
      stage: "validation",
      code: "UNSAFE_BLOB_PATH",
      retryable: false,
    });
  }
  for (const part of parts) {
    current = resolve(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw createStageError("Unsafe blob path rejected", {
        stage: "validation",
        code: "UNSAFE_BLOB_PATH",
        retryable: false,
      });
    }
  }
}

/**
 * Resolve a managed blob (`generated-labs/...`, `data/...`, `uploads/...`,
 * `screenshots/...`) to a verified path inside the configured portal storage directories.
 */
export function resolveSafeBlobLocalPath(blobName, env = process.env) {
  const segments = validateSafeBlobName(blobName, { requireManagedPrefix: true });
  const [prefix, ...rest] = segments;
  const dirs = resolvePrefixDirs(env);
  const baseDir = dirs[prefix];
  if (!baseDir) {
    throw createStageError("Unsafe blob path rejected", {
      stage: "validation",
      code: "UNSAFE_BLOB_PATH",
      retryable: false,
    });
  }
  const targetPath = resolve(baseDir, ...rest);
  assertNoSymlinkAncestors(baseDir, targetPath);
  return targetPath;
}

function parseTokenExpiryMs(payload, nowMs) {
  const rawExpiresOn = payload?.expires_on ?? payload?.expiresOn;
  if (rawExpiresOn !== undefined && rawExpiresOn !== null && String(rawExpiresOn).trim() !== "") {
    const numeric = Number(rawExpiresOn);
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric < 1e12 ? numeric * 1000 : numeric;
    }
    const parsedDate = Date.parse(String(rawExpiresOn));
    if (Number.isFinite(parsedDate) && parsedDate > 0) {
      return parsedDate;
    }
  }

  const rawExpiresIn = payload?.expires_in ?? payload?.expiresIn;
  if (rawExpiresIn !== undefined && rawExpiresIn !== null && String(rawExpiresIn).trim() !== "") {
    const seconds = Number(rawExpiresIn);
    if (Number.isFinite(seconds) && seconds > 0) {
      return nowMs + seconds * 1000;
    }
  }

  return nowMs + 60 * 60 * 1000;
}

/**
 * Create an isolated Managed Identity OAuth2 bearer token provider for
 * `https://storage.azure.com/` with in-memory caching until 5 minutes before expiry.
 */
export function createStorageTokenProvider({
  env = process.env,
  fetchImpl = globalThis.fetch,
  tokenProvider = null,
  clientId: explicitClientId,
  now = () => Date.now(),
} = {}) {
  let cachedToken = null;
  let cachedExpiresAtMs = 0;
  let inflightPromise = null;

  function invalidate() {
    cachedToken = null;
    cachedExpiresAtMs = 0;
  }

  async function acquireToken() {
    const nowMs = now();
    if (cachedToken && cachedExpiresAtMs - TOKEN_REFRESH_SKEW_MS > nowMs) {
      return cachedToken;
    }
    if (inflightPromise) {
      return inflightPromise;
    }

    inflightPromise = (async () => {
      if (typeof tokenProvider === "function") {
        const supplied = await tokenProvider();
        if (typeof supplied === "string" && supplied.trim()) {
          cachedToken = supplied.trim();
          cachedExpiresAtMs = now() + 60 * 60 * 1000;
          return cachedToken;
        }
        const tokenValue = trimEnv(supplied?.accessToken ?? supplied?.access_token);
        if (!tokenValue) {
          throw createStageError("Custom tokenProvider returned empty token", {
            stage: "token",
            retryable: false,
          });
        }
        cachedToken = tokenValue;
        cachedExpiresAtMs = Number.isFinite(supplied?.expiresOnMs)
          ? supplied.expiresOnMs
          : parseTokenExpiryMs(supplied, now());
        return cachedToken;
      }

      const staticToken = trimEnv(env?.AZURE_STORAGE_BEARER_TOKEN);
      if (staticToken) {
        cachedToken = staticToken;
        cachedExpiresAtMs = now() + 60 * 60 * 1000;
        return cachedToken;
      }

      const clientId =
        explicitClientId !== undefined
          ? trimEnv(explicitClientId)
          : trimEnv(env?.AZURE_STORAGE_CLIENT_ID) || trimEnv(env?.AZURE_CLIENT_ID);

      const identityEndpoint = trimEnv(env?.IDENTITY_ENDPOINT);
      const identityHeader = trimEnv(env?.IDENTITY_HEADER);

      let url;
      let headers;
      let timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS;

      if (identityEndpoint && identityHeader) {
        const sep = identityEndpoint.includes("?") ? "&" : "?";
        url =
          `${identityEndpoint}${sep}api-version=2019-08-01` +
          `&resource=${encodeURIComponent(STORAGE_RESOURCE_AUDIENCE)}` +
          (clientId ? `&client_id=${encodeURIComponent(clientId)}` : "");
        headers = {
          "X-IDENTITY-HEADER": identityHeader,
          Accept: "application/json",
        };
      } else {
        url =
          `${IMDS_TOKEN_ENDPOINT}?api-version=2018-02-01` +
          `&resource=${encodeURIComponent(STORAGE_RESOURCE_AUDIENCE)}` +
          (clientId ? `&client_id=${encodeURIComponent(clientId)}` : "");
        headers = {
          Metadata: "true",
          Accept: "application/json",
        };
        timeoutMs = DEFAULT_IMDS_TIMEOUT_MS;
      }

      let response;
      try {
        response = await fetchImpl(url, {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        const wrapped = createStageError("Managed identity token network failure", {
          stage: "token",
          retryable: true,
        });
        wrapped.name = err?.name || "Error";
        throw wrapped;
      }

      if (!response.ok) {
        const status = response.status;
        throw createStageError(`Managed identity token HTTP ${status}`, {
          stage: "token",
          httpStatus: status,
          retryable: status === 403 || status === 404 || status === 429 || status >= 500,
        });
      }

      let payload;
      try {
        payload = await response.json();
      } catch {
        throw createStageError("Invalid JSON from managed identity endpoint", {
          stage: "token",
          retryable: false,
        });
      }

      const accessToken = trimEnv(payload?.access_token ?? payload?.accessToken);
      if (!accessToken) {
        throw createStageError("Missing access_token in managed identity response", {
          stage: "token",
          retryable: false,
        });
      }

      cachedToken = accessToken;
      cachedExpiresAtMs = parseTokenExpiryMs(payload, now());
      return cachedToken;
    })().finally(() => {
      inflightPromise = null;
    });

    return inflightPromise;
  }

  return {
    acquireStorageAccessToken: acquireToken,
    invalidate,
  };
}

/**
 * Convenience one-shot / custom-provider wrapper for Managed Identity token acquisition.
 */
export async function acquireStorageAccessToken(options = {}) {
  const provider = createStorageTokenProvider(options);
  return provider.acquireStorageAccessToken();
}

/**
 * Run `worker` over `items` with a concurrency limit. After the first failure no new item starts, but every worker
 * already running settles before the first error is rethrown, so nothing keeps uploading behind a failed pass.
 */
async function runWithConcurrency(items, concurrency, worker) {
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));
  let index = 0;
  let failure = null;
  const runners = Array.from({ length: limit }, async () => {
    while (!failure && index < items.length) {
      const currentIndex = index;
      index += 1;
      try {
        await worker(items[currentIndex], currentIndex);
      } catch (err) {
        failure ??= { err };
      }
    }
  });
  await Promise.all(runners);
  if (failure) throw failure.err;
}

function yieldToEventLoop() {
  return new Promise((resolveImmediate) => setImmediate(resolveImmediate));
}

/** Hands the event loop back after every `everyFiles` ticks or `everyMs` of work, so HTTP requests keep being served. */
function createYielder({ everyFiles = YIELD_EVERY_FILES, everyMs = YIELD_EVERY_MS } = {}) {
  let ticks = 0;
  let sliceStartedAt = performance.now();
  return {
    async tick() {
      ticks += 1;
      if (ticks >= everyFiles || performance.now() - sliceStartedAt >= everyMs) {
        ticks = 0;
        await yieldToEventLoop();
        sliceStartedAt = performance.now();
      }
    },
  };
}

/** SHA-256 that gives the event loop a turn between slices of a large buffer. */
async function sha256HexYielding(buffer) {
  if (buffer.byteLength <= HASH_SLICE_BYTES) return sha256Hex(buffer);
  const hash = createHash("sha256");
  for (let offset = 0; offset < buffer.byteLength; offset += HASH_SLICE_BYTES) {
    hash.update(buffer.subarray(offset, offset + HASH_SLICE_BYTES));
    await yieldToEventLoop();
  }
  return hash.digest("hex");
}

/**
 * Write `buffer` beside `targetPath` under a unique `.blob-tmp-` name, then rename it into place, so a reader sees the
 * whole old file or the whole new one and the sync pass never uploads a half-written copy. With `overwrite: false` an
 * existing target wins (checked right before the rename) and `false` is returned.
 */
async function writeBufferAtomically(targetPath, buffer, { overwrite = true } = {}) {
  await fsp.mkdir(dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.blob-tmp-${process.pid}-${randomUUID()}`;
  try {
    await fsp.writeFile(tempPath, buffer, { flag: "wx" });
    if (!overwrite && existsSync(targetPath)) {
      await fsp.rm(tempPath, { force: true });
      return false;
    }
    renameSync(tempPath, targetPath);
    return true;
  } catch (err) {
    try {
      await fsp.rm(tempPath, { force: true });
    } catch {
      // Ignore cleanup failure.
    }
    throw err;
  }
}

function readStatStamp(filePath) {
  const st = statSync(filePath, { bigint: true });
  return {
    size: Number(st.size),
    mtimeMs: Number(st.mtimeMs),
    mtimeNs: st.mtimeNs,
  };
}

async function readStatStampAsync(filePath) {
  const st = await fsp.stat(filePath, { bigint: true });
  return {
    size: Number(st.size),
    mtimeMs: Number(st.mtimeMs),
    mtimeNs: st.mtimeNs,
    isFile: st.isFile(),
  };
}

function sameStamp(a, b) {
  return a.size === b.size && a.mtimeNs === b.mtimeNs;
}

async function walkManagedDirectory(baseDir, prefix, outMap, yielder) {
  try {
    await fsp.access(baseDir);
  } catch {
    return;
  }

  async function recurse(currentDir, relSegments) {
    let entries;
    try {
      entries = await fsp.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (isTransientFileName(entry.name)) continue;
      if (entry.isSymbolicLink()) continue;

      const fullPath = resolve(currentDir, entry.name);
      const nextSegments = [...relSegments, entry.name];

      if (entry.isDirectory()) {
        await recurse(fullPath, nextSegments);
      } else if (entry.isFile()) {
        const blobName = [prefix, ...nextSegments].join("/");
        if (isUnsafeBlobName(blobName)) continue;
        outMap.set(blobName, { fullPath });
        await yielder.tick();
      }
    }
  }

  await recurse(baseDir, []);
}

/**
 * Create a self-contained Azure Blob persistence mirror controller.
 */
export function createBlobPersistence(options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const rawEndpoint = trimEnv(options.endpoint ?? env?.AZURE_STORAGE_BLOB_ENDPOINT);
  const endpoint = rawEndpoint.replace(/\/+$/, "");
  const container =
    trimEnv(options.container ?? env?.AZURE_STORAGE_BLOB_CONTAINER) || DEFAULT_BLOB_CONTAINER;
  const enabled = Boolean(endpoint);

  const debounceMs = positiveInt(
    options.debounceMs ?? env?.AZURE_STORAGE_SYNC_DEBOUNCE_MS,
    DEFAULT_SYNC_DEBOUNCE_MS,
  );
  const hydrateConcurrency = Math.max(
    1,
    positiveInt(options.concurrency, DEFAULT_HYDRATE_CONCURRENCY),
  );
  const maxRetries = positiveInt(
    options.maxRetries ?? env?.AZURE_STORAGE_MAX_RETRIES,
    DEFAULT_MAX_RETRIES,
  );
  const retryBaseDelayMs = positiveInt(
    options.retryBaseDelayMs ?? env?.AZURE_STORAGE_RETRY_DELAY_MS,
    DEFAULT_RETRY_BASE_DELAY_MS,
  );
  const requestTimeoutMs = Math.max(
    1000,
    positiveInt(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS),
  );
  const syncMaxWaitMs = Math.max(
    debounceMs,
    positiveInt(options.maxWaitMs ?? env?.BLOB_SYNC_MAX_WAIT_MS, DEFAULT_SYNC_MAX_WAIT_MS),
  );
  const failureRetryBaseMs = positiveInt(
    options.syncRetryBaseMs ?? env?.BLOB_SYNC_RETRY_BASE_MS,
    DEFAULT_SYNC_FAILURE_RETRY_BASE_MS,
  );
  const maxFailureRetries = positiveInt(options.maxSyncFailureRetries, MAX_SYNC_FAILURE_RETRIES);
  const random = typeof options.random === "function" ? options.random : Math.random;
  // Injectable so tests drive the debounce, backoff, and shutdown timers with a fake clock. The default clock is
  // monotonic, so a wall-clock jump cannot stretch the debounce.
  const timers = {
    now: typeof options.timers?.now === "function" ? options.timers.now : () => performance.now(),
    setTimeout:
      typeof options.timers?.setTimeout === "function"
        ? options.timers.setTimeout
        : (fn, ms) => setTimeout(fn, ms),
    clearTimeout:
      typeof options.timers?.clearTimeout === "function"
        ? options.timers.clearTimeout
        : (handle) => clearTimeout(handle),
  };

  const tokenManager = createStorageTokenProvider({
    env,
    fetchImpl,
    tokenProvider: options.tokenProvider ?? null,
    clientId: options.clientId,
    now: options.now,
  });

  // relPath -> { size: number, mtimeMs: number, mtimeNs: bigint, sha256: string, racy: boolean }
  const syncedFiles = new Map();

  let hydrated = false;
  let hydratedFiles = 0;
  let rejectedBlobs = 0;
  let lastSyncAt = null;
  let lastError = null;
  let healthy = true;

  let debounceTimer = null;
  let pendingSince = 0;
  let lastRequestAt = 0;
  let retryTimer = null;
  let failureRetryAttempts = 0;
  let activeSyncPromise = null;
  let syncRequestedWhileRunning = false;
  let passFailed = false;
  let passChurned = false;
  let stopped = false;
  let shuttingDown = false;

  function containerBaseUrl() {
    if (!enabled) {
      throw createStageError("Azure Blob endpoint is not configured", {
        stage: "blob",
        retryable: false,
      });
    }
    return `${endpoint}/${encodeURIComponent(container)}`;
  }

  /**
   * `guard` is a synchronous last-look check run right before the request is sent (after the bearer token is in
   * hand, which can take a while): when it returns false nothing is sent and `null` is returned.
   */
  async function blobFetch(url, init = {}, { allowNotFound = false, guard = null } = {}) {
    let token = await tokenManager.acquireStorageAccessToken();
    if (guard && !guard()) return null;
    const attemptRequest = async (bearerToken) => {
      const headers = {
        Authorization: `Bearer ${bearerToken}`,
        "x-ms-version": BLOB_API_VERSION,
        "x-ms-date": new Date().toUTCString(),
        ...(init.headers || {}),
      };

      let response;
      try {
        response = await fetchImpl(url, {
          ...init,
          headers,
          signal: AbortSignal.timeout(requestTimeoutMs),
        });
      } catch (err) {
        const wrapped = createStageError("Blob storage request failed", {
          stage: "blob",
          retryable: true,
        });
        wrapped.name = err?.name || "Error";
        throw wrapped;
      }
      return response;
    };

    let response = await attemptRequest(token);
    if (response.status === 401) {
      tokenManager.invalidate();
      token = await tokenManager.acquireStorageAccessToken();
      if (guard && !guard()) return null;
      response = await attemptRequest(token);
    }

    if (allowNotFound && response.status === 404) {
      return response;
    }

    if (!response.ok) {
      const status = response.status;
      throw createStageError(`Blob storage HTTP ${status}`, {
        stage: "blob",
        httpStatus: status,
        retryable: status === 403 || status === 408 || status === 429 || status >= 500,
      });
    }

    return response;
  }

  async function withRetries(operation) {
    let attempt = 0;
    for (;;) {
      try {
        return await operation();
      } catch (err) {
        const canRetry = Boolean(err?.retryable) && attempt < maxRetries;
        if (!canRetry) {
          throw err;
        }
        const delayMs = retryBaseDelayMs * Math.pow(2, attempt);
        attempt += 1;
        await sleep(delayMs);
      }
    }
  }

  async function listBlobs() {
    const allNames = [];
    const seenMarkers = new Set();
    let marker = "";

    for (;;) {
      const query =
        `?restype=container&comp=list&maxresults=5000` +
        (marker ? `&marker=${encodeURIComponent(marker)}` : "");
      const response = await blobFetch(`${containerBaseUrl()}${query}`, { method: "GET" });
      const xmlText = await response.text();
      const { names, nextMarker } = parseListBlobsXml(xmlText);
      allNames.push(...names);

      if (!nextMarker || seenMarkers.has(nextMarker)) {
        break;
      }
      seenMarkers.add(nextMarker);
      marker = nextMarker;
    }

    return allNames;
  }

  async function downloadBlob(blobName) {
    const encodedPath = encodeBlobPath(blobName);
    const response = await blobFetch(`${containerBaseUrl()}/${encodedPath}`, { method: "GET" });
    return Buffer.from(await response.arrayBuffer());
  }

  /** Resolves `false` (nothing sent) when `guard` vetoes the upload at send time, `true` once the blob is written. */
  async function uploadBlobGuarded(blobName, buffer, contentType, guard) {
    const encodedPath = encodeBlobPath(blobName);
    const body = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const response = await blobFetch(
      `${containerBaseUrl()}/${encodedPath}`,
      {
        method: "PUT",
        headers: {
          "x-ms-blob-type": "BlockBlob",
          "Content-Length": String(body.byteLength),
          "Content-Type": contentType || inferContentType(blobName),
        },
        body,
      },
      { guard },
    );
    return response !== null;
  }

  async function uploadBlob(blobName, buffer, contentType) {
    await uploadBlobGuarded(blobName, buffer, contentType, null);
  }

  async function deleteBlob(blobName) {
    const encodedPath = encodeBlobPath(blobName);
    await blobFetch(
      `${containerBaseUrl()}/${encodedPath}`,
      { method: "DELETE" },
      { allowNotFound: true },
    );
  }

  function partitionRemoteBlobs(remoteNames) {
    const validManaged = [];
    let rejectedCount = 0;

    for (const name of remoteNames) {
      if (isUnsafeBlobName(name)) {
        rejectedCount += 1;
        continue;
      }
      const slashIdx = name.indexOf("/");
      if (slashIdx <= 0) continue;
      const prefix = name.slice(0, slashIdx);
      if (!MANAGED_BLOB_PREFIXES.includes(prefix)) continue;
      validManaged.push(name);
    }

    return { validManaged, rejectedCount };
  }

  /**
   * Startup hydration: lists and downloads all managed remote blobs into
   * `PORTAL_STORAGE_ROOT` with bounded concurrency, retrying transient RBAC/5xx
   * errors and never crashing server startup.
   */
  async function hydrateFromBlob() {
    if (!enabled) {
      return getStatus();
    }

    ensurePortalStorageDirs(env);

    try {
      await withRetries(async () => {
        const remoteNames = await listBlobs();
        const { validManaged, rejectedCount } = partitionRemoteBlobs(remoteNames);
        rejectedBlobs += rejectedCount;

        const downloadedEntries = [];
        await runWithConcurrency(validManaged, hydrateConcurrency, async (blobName) => {
          const targetPath = resolveSafeBlobLocalPath(blobName, env);
          const content = await downloadBlob(blobName);
          await writeBufferAtomically(targetPath, content);
          const stamp = readStatStamp(targetPath);
          downloadedEntries.push([
            blobName,
            {
              ...stamp,
              sha256: sha256Hex(content),
              racy: false,
            },
          ]);
        });

        syncedFiles.clear();
        for (const [blobName, meta] of downloadedEntries) {
          syncedFiles.set(blobName, meta);
        }
        hydrated = true;
        hydratedFiles = downloadedEntries.length;
        healthy = true;
        lastError = null;
        lastSyncAt = new Date().toISOString();
      });
    } catch (err) {
      hydrated = false;
      healthy = false;
      lastError = sanitizeBlobError(err);
      // Typically RBAC still propagating: try again by itself instead of waiting for the first change.
      scheduleFailureRetry();
    }

    return getStatus();
  }

  async function scanLocalFiles(yielder) {
    const dirs = resolvePrefixDirs(env);
    const localMap = new Map();
    for (const prefix of MANAGED_BLOB_PREFIXES) {
      await walkManagedDirectory(dirs[prefix], prefix, localMap, yielder);
    }
    return localMap;
  }

  function trackSynced(blobName, stamp, sha256) {
    syncedFiles.set(blobName, {
      size: stamp.size,
      mtimeMs: stamp.mtimeMs,
      mtimeNs: stamp.mtimeNs,
      sha256,
      racy: Date.now() - stamp.mtimeMs < RACY_STAMP_WINDOW_MS,
    });
  }

  /**
   * Non-destructive reconciliation when startup `hydrateFromBlob()` failed
   * (for example while Azure RBAC was still propagating): pulls any remote
   * blobs missing locally without overwriting newer local writes and NEVER
   * deletes pre-existing remote blobs.
   */
  async function reconcileRemoteBeforeSync(localFiles) {
    const remoteNames = await listBlobs();
    const { validManaged, rejectedCount } = partitionRemoteBlobs(remoteNames);
    rejectedBlobs += rejectedCount;

    const missingLocally = validManaged.filter((blobName) => !localFiles.has(blobName));
    await runWithConcurrency(missingLocally, hydrateConcurrency, async (blobName) => {
      const targetPath = resolveSafeBlobLocalPath(blobName, env);
      if (existsSync(targetPath)) return;
      const content = await downloadBlob(blobName);
      // A local write that landed while the download was in flight wins over the older remote copy.
      if (!(await writeBufferAtomically(targetPath, content, { overwrite: false }))) return;
      const stamp = readStatStamp(targetPath);
      trackSynced(blobName, stamp, sha256Hex(content));
      localFiles.set(blobName, { fullPath: targetPath });
    });

    hydrated = true;
    hydratedFiles += missingLocally.length;
  }

  /**
   * Bring one local file up to date in Blob. The size/mtime stamp read before the content is what gets tracked, and a
   * synchronous re-stat right before the PUT vetoes the upload when the file changed in the meantime: an older version
   * is never sent over a newer one, and the tracked state only ever describes what was actually uploaded.
   */
  async function syncLocalFile(blobName, fullPath) {
    let before;
    try {
      before = await readStatStampAsync(fullPath);
    } catch {
      return; // Removed since the scan; the delete phase or the next pass reconciles it.
    }
    if (!before.isFile) return;

    const prev = syncedFiles.get(blobName);
    if (prev && !prev.racy && sameStamp(prev, before)) return;

    let buffer;
    try {
      buffer = await fsp.readFile(fullPath);
    } catch {
      return;
    }
    const sha256 = await sha256HexYielding(buffer);
    if (prev && prev.sha256 === sha256) {
      trackSynced(blobName, before, sha256);
      return;
    }

    const unchangedSinceRead = () => {
      try {
        return sameStamp(before, readStatStamp(fullPath));
      } catch {
        return false;
      }
    };
    const uploaded = await uploadBlobGuarded(blobName, buffer, inferContentType(blobName), unchangedSinceRead);
    if (!uploaded) {
      passChurned = true;
      return;
    }
    trackSynced(blobName, before, sha256);
  }

  function isTrackedFileBackOnDisk(blobName) {
    try {
      const localPath = resolveSafeBlobLocalPath(blobName, env);
      return lstatSync(localPath).isFile() && !isTransientFileName(basename(localPath));
    } catch {
      return false;
    }
  }

  /**
   * One scan-and-sync pass. Private: every entry point goes through `runSerializedSync` so two passes never overlap.
   */
  async function performSyncPass() {
    if (!enabled) {
      return getStatus();
    }

    passFailed = false;
    try {
      await withRetries(async () => {
        const yielder = createYielder();
        const localFiles = await scanLocalFiles(yielder);
        const wasHydratedBeforePass = hydrated;

        if (!hydrated) {
          await reconcileRemoteBeforeSync(localFiles);
        }

        // One failing file never stops the others; the first error is rethrown once every file has been tried.
        let firstFileError = null;
        await runWithConcurrency([...localFiles.entries()], hydrateConcurrency, async ([blobName, localInfo]) => {
          try {
            await syncLocalFile(blobName, localInfo.fullPath);
          } catch (err) {
            firstFileError ??= err;
          }
          await yielder.tick();
        });
        if (firstFileError) throw firstFileError;

        // CRITICAL SAFETY GUARD: Only delete remote blobs that were previously
        // materialized in `syncedFiles` AND only when this replica was already
        // hydrated before the pass started (so an unhydrated container can never
        // delete pre-existing remote blobs).
        if (wasHydratedBeforePass && hydrated) {
          const toDelete = [];
          for (const trackedBlobName of syncedFiles.keys()) {
            if (!localFiles.has(trackedBlobName)) {
              toDelete.push(trackedBlobName);
            }
          }

          await runWithConcurrency(toDelete, hydrateConcurrency, async (blobName) => {
            // The pass can run for a while; a file that came back since the scan is kept, and the rerun picks it up.
            if (isTrackedFileBackOnDisk(blobName)) {
              passChurned = true;
              return;
            }
            await deleteBlob(blobName);
            syncedFiles.delete(blobName);
          });
        }

        healthy = true;
        lastError = null;
        lastSyncAt = new Date().toISOString();
      });
    } catch (err) {
      passFailed = true;
      healthy = false;
      lastError = sanitizeBlobError(err);
    }

    return getStatus();
  }

  function cancelDebounce() {
    if (debounceTimer) {
      timers.clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    pendingSince = 0;
  }

  function cancelFailureRetry() {
    if (retryTimer) {
      timers.clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  /**
   * After a failed pass, retry on a timer with exponential backoff and jitter, independent of any request. Gives up
   * after `maxFailureRetries` attempts and waits for the next scheduled change (which starts a fresh budget).
   */
  function scheduleFailureRetry() {
    cancelFailureRetry();
    if (stopped || shuttingDown || failureRetryAttempts >= maxFailureRetries) return;
    const ceilingMs = Math.max(MAX_SYNC_FAILURE_RETRY_DELAY_MS, failureRetryBaseMs);
    const backoffMs = Math.min(ceilingMs, failureRetryBaseMs * 2 ** failureRetryAttempts);
    const delayMs = Math.round(backoffMs * (0.5 + 0.5 * random()));
    failureRetryAttempts += 1;
    retryTimer = timers.setTimeout(() => {
      retryTimer = null;
      void runSerializedSync().catch(() => {});
    }, delayMs);
    retryTimer?.unref?.();
  }

  /**
   * The single runner behind every entry point (scheduled, flush, manual `syncToBlob`, shutdown). A call that arrives
   * while a pass is running does not start a second one: it asks for a rerun and shares the running promise, which only
   * settles after a pass that began after the call.
   */
  function runSerializedSync() {
    if (!enabled) {
      return Promise.resolve(getStatus());
    }
    if (activeSyncPromise) {
      syncRequestedWhileRunning = true;
      return activeSyncPromise;
    }

    activeSyncPromise = (async () => {
      let result = null;
      let churnReruns = 0;
      let churnPending = false;
      try {
        for (;;) {
          syncRequestedWhileRunning = false;
          passChurned = false;
          result = await performSyncPass();
          // A file changed under the pass: go again, but never spin on a file that keeps changing.
          churnPending = passChurned;
          if (churnPending && churnReruns < MAX_CHURN_RERUNS) {
            churnReruns += 1;
            churnPending = false;
            syncRequestedWhileRunning = true;
          }
          if (!syncRequestedWhileRunning) break;
        }
      } finally {
        // Cleared in the same turn as the last rerun check, so a request can never be lost between the two.
        activeSyncPromise = null;
      }
      if (passFailed) {
        scheduleFailureRetry();
      } else {
        failureRetryAttempts = 0;
        cancelFailureRetry();
      }
      if (churnPending) scheduleBlobSync();
      return result;
    })();

    return activeSyncPromise;
  }

  function onDebounceTimer() {
    debounceTimer = null;
    const nowMs = timers.now();
    const quietForMs = nowMs - lastRequestAt;
    const waitedMs = nowMs - pendingSince;
    if (quietForMs < debounceMs && waitedMs < syncMaxWaitMs) {
      armDebounce(Math.max(0, Math.min(debounceMs, debounceMs - quietForMs, syncMaxWaitMs - waitedMs)));
      return;
    }
    pendingSince = 0;
    // A fresh change supersedes any pending failure retry and starts a new retry budget.
    cancelFailureRetry();
    failureRetryAttempts = 0;
    void runSerializedSync().catch(() => {});
  }

  function armDebounce(delayMs) {
    debounceTimer = timers.setTimeout(onDebounceTimer, delayMs);
    debounceTimer?.unref?.();
  }

  /**
   * Called on every mutating response, so it stays synchronous and cheap: it records the time and arms at most one
   * timer. The pass runs `debounceMs` after the last call, or `maxWaitMs` after the first of a continuous burst.
   */
  function scheduleBlobSync() {
    if (!enabled) return;
    stopped = false;
    if (shuttingDown) {
      if (activeSyncPromise) syncRequestedWhileRunning = true;
      return;
    }
    const nowMs = timers.now();
    lastRequestAt = nowMs;
    if (debounceTimer) return;
    pendingSince = nowMs;
    armDebounce(debounceMs);
  }

  async function flushBlobSync() {
    cancelDebounce();
    cancelFailureRetry();
    return runSerializedSync();
  }

  /**
   * For a SIGTERM handler: cancels the timers, runs one final serialized pass, and resolves (never rejects) with the
   * sync status plus `timedOut`, no later than `timeoutMs` from the call.
   */
  async function flushBlobSyncForShutdown({ timeoutMs = DEFAULT_SHUTDOWN_FLUSH_TIMEOUT_MS } = {}) {
    shuttingDown = true;
    cancelDebounce();
    cancelFailureRetry();
    if (!enabled) {
      return { ...getStatus(), timedOut: false };
    }

    const limitMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) >= 0 ? Number(timeoutMs) : DEFAULT_SHUTDOWN_FLUSH_TIMEOUT_MS;
    let timeoutHandle = null;
    try {
      const timedOut = await Promise.race([
        runSerializedSync().then(
          () => false,
          () => false,
        ),
        new Promise((resolveTimeout) => {
          timeoutHandle = timers.setTimeout(() => resolveTimeout(true), limitMs);
        }),
      ]);
      return { ...getStatus(), timedOut };
    } catch {
      return { ...getStatus(), timedOut: false };
    } finally {
      if (timeoutHandle !== null) timers.clearTimeout(timeoutHandle);
    }
  }

  function stop() {
    stopped = true;
    cancelDebounce();
    cancelFailureRetry();
  }

  function getPublicDiagnostics() {
    return {
      enabled,
      hydrated,
      hydratedFiles,
      syncedFiles: syncedFiles.size,
      lastSyncAt,
      healthy,
    };
  }

  function getStatus() {
    return {
      ...getPublicDiagnostics(),
      rejectedBlobs,
      lastError,
      syncing: activeSyncPromise !== null,
      retryScheduled: retryTimer !== null,
      retryAttempts: failureRetryAttempts,
    };
  }

  return {
    enabled,
    acquireStorageAccessToken: tokenManager.acquireStorageAccessToken,
    listBlobs,
    downloadBlob,
    uploadBlob,
    deleteBlob,
    hydrateFromBlob,
    syncToBlob: runSerializedSync,
    scheduleBlobSync,
    flushBlobSync,
    flushBlobSyncForShutdown,
    stop,
    getPublicDiagnostics,
    getStatus,
  };
}

let defaultBlobPersistence = null;

/**
 * Initialize the process-wide Azure Blob persistence mirror and hydrate
 * saved state from Azure Blob Storage when `AZURE_STORAGE_BLOB_ENDPOINT` is set.
 */
export async function initBlobPersistence(options = {}) {
  defaultBlobPersistence?.stop?.();
  const instance = createBlobPersistence(options);
  defaultBlobPersistence = instance;
  registerBlobSyncStatusProvider(() => instance.getPublicDiagnostics());
  if (instance.enabled) {
    await instance.hydrateFromBlob();
  }
  return instance;
}

export function scheduleBlobSync() {
  defaultBlobPersistence?.scheduleBlobSync();
}

function disabledSyncStatus() {
  return {
    enabled: false,
    hydrated: false,
    hydratedFiles: 0,
    syncedFiles: 0,
    lastSyncAt: null,
    healthy: true,
    rejectedBlobs: 0,
    lastError: null,
  };
}

export async function flushBlobSync() {
  if (!defaultBlobPersistence) {
    return disabledSyncStatus();
  }
  return defaultBlobPersistence.flushBlobSync();
}

/**
 * For a SIGTERM handler: cancels the pending timers, runs one final serialized sync pass, and resolves with the sync
 * status plus `timedOut`. Never rejects and never waits past `timeoutMs`.
 */
export async function flushBlobSyncForShutdown(options = {}) {
  if (!defaultBlobPersistence) {
    return { ...disabledSyncStatus(), timedOut: false };
  }
  return defaultBlobPersistence.flushBlobSyncForShutdown(options);
}

export function getBlobPersistence() {
  return defaultBlobPersistence;
}
