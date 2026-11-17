/**
 * SFI-compliant passwordless Managed Identity Azure Blob persistence mirror.
 *
 * Mirrors `generated-labs/`, `data/`, `uploads/`, and `screenshots/` between local container
 * disk (`PORTAL_STORAGE_ROOT`) and Azure Blob Storage over HTTPS using Entra
 * Managed Identity RBAC (`Storage Blob Data Contributor`) with zero storage
 * account keys and zero external npm dependencies (Node 24 built-ins only).
 */

import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
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

function isTransientFileName(fileName) {
  return (
    fileName.startsWith(".portal-storage-probe-") ||
    fileName.includes(".blob-tmp-")
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

async function runWithConcurrency(items, concurrency, worker) {
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));
  let index = 0;
  const runners = Array.from({ length: limit }, async () => {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      await worker(items[currentIndex], currentIndex);
    }
  });
  await Promise.all(runners);
}

function writeBufferAtomically(targetPath, buffer) {
  const dir = dirname(targetPath);
  mkdirSync(dir, { recursive: true });
  const tempPath = `${targetPath}.blob-tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(tempPath, buffer);
    renameSync(tempPath, targetPath);
  } catch (err) {
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath);
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

function walkManagedDirectory(baseDir, prefix, outMap) {
  if (!existsSync(baseDir)) return;

  function recurse(currentDir, relSegments) {
    let entries;
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (isTransientFileName(entry.name)) continue;
      if (entry.isSymbolicLink()) continue;

      const fullPath = resolve(currentDir, entry.name);
      const nextSegments = [...relSegments, entry.name];

      if (entry.isDirectory()) {
        recurse(fullPath, nextSegments);
      } else if (entry.isFile()) {
        const blobName = [prefix, ...nextSegments].join("/");
        if (isUnsafeBlobName(blobName)) continue;
        try {
          const stamp = readStatStamp(fullPath);
          outMap.set(blobName, {
            fullPath,
            ...stamp,
          });
        } catch {
          // File may have been concurrently removed; next scan will reconcile.
        }
      }
    }
  }

  recurse(baseDir, []);
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

  const tokenManager = createStorageTokenProvider({
    env,
    fetchImpl,
    tokenProvider: options.tokenProvider ?? null,
    clientId: options.clientId,
    now: options.now,
  });

  // relPath -> { size: number, mtimeMs: number, mtimeNs: bigint, sha256: string }
  const syncedFiles = new Map();

  let hydrated = false;
  let hydratedFiles = 0;
  let rejectedBlobs = 0;
  let lastSyncAt = null;
  let lastError = null;
  let healthy = true;

  let debounceTimer = null;
  let activeSyncPromise = null;
  let syncRequestedWhileRunning = false;

  function containerBaseUrl() {
    if (!enabled) {
      throw createStageError("Azure Blob endpoint is not configured", {
        stage: "blob",
        retryable: false,
      });
    }
    return `${endpoint}/${encodeURIComponent(container)}`;
  }

  async function blobFetch(url, init = {}, { allowNotFound = false } = {}) {
    let token = await tokenManager.acquireStorageAccessToken();
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

  async function uploadBlob(blobName, buffer, contentType) {
    const encodedPath = encodeBlobPath(blobName);
    const body = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    await blobFetch(`${containerBaseUrl()}/${encodedPath}`, {
      method: "PUT",
      headers: {
        "x-ms-blob-type": "BlockBlob",
        "Content-Length": String(body.byteLength),
        "Content-Type": contentType || inferContentType(blobName),
      },
      body,
    });
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
          writeBufferAtomically(targetPath, content);
          const stamp = readStatStamp(targetPath);
          downloadedEntries.push([
            blobName,
            {
              ...stamp,
              sha256: sha256Hex(content),
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
    }

    return getStatus();
  }

  function scanLocalFiles() {
    const dirs = resolvePrefixDirs(env);
    const localMap = new Map();
    for (const prefix of MANAGED_BLOB_PREFIXES) {
      walkManagedDirectory(dirs[prefix], prefix, localMap);
    }
    return localMap;
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
      writeBufferAtomically(targetPath, content);
      const stamp = readStatStamp(targetPath);
      const entry = {
        ...stamp,
        sha256: sha256Hex(content),
      };
      syncedFiles.set(blobName, entry);
      localFiles.set(blobName, { fullPath: targetPath, ...stamp });
    });

    hydrated = true;
    hydratedFiles += missingLocally.length;
  }

  async function performSyncPass() {
    if (!enabled) {
      return getStatus();
    }

    try {
      await withRetries(async () => {
        const localFiles = scanLocalFiles();
        const wasHydratedBeforePass = hydrated;

        if (!hydrated) {
          await reconcileRemoteBeforeSync(localFiles);
        }

        const toUpload = [];
        for (const [blobName, localInfo] of localFiles.entries()) {
          const prev = syncedFiles.get(blobName);
          if (
            prev &&
            prev.size === localInfo.size &&
            prev.mtimeNs === localInfo.mtimeNs
          ) {
            continue;
          }

          let buffer;
          let freshStamp;
          try {
            buffer = readFileSync(localInfo.fullPath);
            freshStamp = readStatStamp(localInfo.fullPath);
          } catch {
            // File disappeared mid-scan; skip in this pass.
            continue;
          }

          const sha256 = sha256Hex(buffer);
          if (prev && prev.sha256 === sha256) {
            syncedFiles.set(blobName, {
              ...freshStamp,
              sha256,
            });
            continue;
          }

          toUpload.push({ blobName, buffer, freshStamp, sha256 });
        }

        await runWithConcurrency(toUpload, hydrateConcurrency, async (item) => {
          await uploadBlob(item.blobName, item.buffer, inferContentType(item.blobName));
          syncedFiles.set(item.blobName, {
            ...item.freshStamp,
            sha256: item.sha256,
          });
        });

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
            await deleteBlob(blobName);
            syncedFiles.delete(blobName);
          });
        }

        healthy = true;
        lastError = null;
        lastSyncAt = new Date().toISOString();
      });
    } catch (err) {
      healthy = false;
      lastError = sanitizeBlobError(err);
    }

    return getStatus();
  }

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
      do {
        syncRequestedWhileRunning = false;
        result = await performSyncPass();
      } while (syncRequestedWhileRunning);
      return result;
    })().finally(() => {
      activeSyncPromise = null;
    });

    return activeSyncPromise;
  }

  function scheduleBlobSync() {
    if (!enabled) return;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void runSerializedSync();
    }, debounceMs);
    debounceTimer.unref?.();
  }

  async function flushBlobSync() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (!enabled) {
      return getStatus();
    }
    if (activeSyncPromise) {
      syncRequestedWhileRunning = true;
      return activeSyncPromise;
    }
    return runSerializedSync();
  }

  function stop() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
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
    syncToBlob: performSyncPass,
    scheduleBlobSync,
    flushBlobSync,
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

export async function flushBlobSync() {
  if (!defaultBlobPersistence) {
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
  return defaultBlobPersistence.flushBlobSync();
}

export function getBlobPersistence() {
  return defaultBlobPersistence;
}
