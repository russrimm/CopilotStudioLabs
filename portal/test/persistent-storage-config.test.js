/**
 * Tests for SFI-compliant passwordless Managed Identity Azure Blob persistence,
 * Network Security Perimeter Bicep templates, stateful portal directory
 * overrides, multi-container HTTP persistence & RBAC propagation safety,
 * `/uploads` hardening, and path-traversal defenses.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  OUTPUT_ROOT,
  PORTAL_ROOT,
  ensurePortalStorageDirs,
  getStorageDiagnostics,
  registerBlobSyncStatusProvider,
  resolveGeneratedLabsDir,
  resolvePortalDataDir,
  resolvePortalUploadsDir,
  resolveSafeUploadFile,
} from "../lib/storage-config.js";
import {
  BLOB_API_VERSION,
  STORAGE_RESOURCE_AUDIENCE,
  createBlobPersistence,
  createStorageTokenProvider,
  decodeXmlEntities,
  parseListBlobsXml,
  resolveSafeBlobLocalPath,
  validateSafeBlobName,
} from "../lib/blob-persistence.js";
import {
  deleteBrandingLogo,
  getBrandingDataDir,
  getBrandingFilePath,
  getBrandingLogoAbsolutePath,
  getBrandingUploadsDir,
  loadBranding,
  saveBranding,
  updateBrandingLogo,
} from "../lib/branding.js";
import {
  getRequest,
  listRequests,
  loadApprovalConfig,
  saveApprovalConfig,
  submitRequest,
} from "../lib/approvals.js";
import { loadAgentChatConfig, saveAgentChatConfig } from "../lib/agent-chat.js";
import { topicConfig } from "../lib/lab-builder/topic-store.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

// Minimal valid 1x1 transparent PNG
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

const DISABLED_BLOB_SYNC = Object.freeze({
  enabled: false,
  hydrated: false,
  hydratedFiles: 0,
  syncedFiles: 0,
  lastSyncAt: null,
  healthy: true,
});

function makeTempDir(t, prefix = "portal-storage-test-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

async function waitForServer(base, child) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early with code ${child.exitCode}`);
    }
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) return;
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  throw new Error("server did not start in time");
}

function rawHttpGet(port, rawPath) {
  return new Promise((resolveRes, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: "GET", path: rawPath },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolveRes({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.once("error", reject);
    req.end();
  });
}

function encodeXmlText(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function collectFilesWithHashes(rootDir) {
  const result = new Map();
  if (!existsSync(rootDir)) return result;

  function walk(cur) {
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      if (entry.name.startsWith(".portal-storage-probe-") || entry.name.includes(".blob-tmp-")) {
        continue;
      }
      const full = join(cur, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const rel = relative(rootDir, full).replaceAll("\\", "/");
        const bytes = readFileSync(full);
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        result.set(rel, { size: bytes.byteLength, sha256, bytes });
      }
    }
  }

  walk(rootDir);
  return result;
}

/**
 * Spin up an in-process mock server simulating BOTH:
 *  - Azure Container Apps Managed Identity `IDENTITY_ENDPOINT` (`/msi/token`)
 *  - Azure Blob Storage REST API (`x-ms-version: 2023-11-03`, Bearer RBAC, pagination)
 */
async function startMockAzureBlobAndIdentityServer(t, options = {}) {
  const expectedIdentityHeader = options.identityHeader ?? "test-msi-secret-header";
  const expectedClientId = options.clientId ?? "11111111-2222-3333-4444-555555555555";
  const containerName = options.containerName ?? "portalstate";
  const pageSize = options.pageSize ?? 2;

  const blobs = new Map(); // blobName -> { body: Buffer, contentType: string }
  let issuedTokenCounter = 0;
  const validTokens = new Set();
  let forceBlobStatus = options.initialBlobStatus ?? null;
  let forceTokenStatus = options.initialTokenStatus ?? null;

  const stats = {
    tokenRequests: 0,
    listRequests: 0,
    getRequests: 0,
    putRequests: 0,
    deleteRequests: 0,
    deletedNames: [],
    requestedGetNames: [],
  };

  const server = http.createServer((req, res) => {
    const parsedUrl = new URL(req.url, "http://127.0.0.1");

    // 1. Managed Identity token endpoint
    if (parsedUrl.pathname === "/msi/token") {
      stats.tokenRequests += 1;
      if (req.headers["x-identity-header"] !== expectedIdentityHeader) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "missing or invalid X-IDENTITY-HEADER" }));
        return;
      }
      if (
        parsedUrl.searchParams.get("api-version") !== "2019-08-01" ||
        parsedUrl.searchParams.get("resource") !== STORAGE_RESOURCE_AUDIENCE ||
        parsedUrl.searchParams.get("client_id") !== expectedClientId
      ) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unexpected query params" }));
        return;
      }
      if (forceTokenStatus) {
        res.writeHead(forceTokenStatus, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "forced token error" }));
        return;
      }

      issuedTokenCounter += 1;
      const token = `mock-mi-storage-jwt-${issuedTokenCounter}`;
      validTokens.add(token);
      const expiresOnSeconds = Math.floor((Date.now() + 60 * 60 * 1000) / 1000);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          access_token: token,
          expires_on: String(expiresOnSeconds),
          resource: STORAGE_RESOURCE_AUDIENCE,
          token_type: "Bearer",
        }),
      );
      return;
    }

    // 2. Azure Blob Storage REST API
    const authHeader = String(req.headers.authorization || "");
    const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : "";
    if (!bearer || !validTokens.has(bearer)) {
      res.writeHead(401, { "Content-Type": "application/xml" });
      res.end("<Error><Code>AuthenticationFailed</Code></Error>");
      return;
    }
    if (req.headers["x-ms-version"] !== BLOB_API_VERSION) {
      res.writeHead(400, { "Content-Type": "application/xml" });
      res.end("<Error><Code>InvalidHeaderValue</Code></Error>");
      return;
    }

    const prefix = `/${encodeURIComponent(containerName)}`;
    const isListRequest =
      req.method === "GET" &&
      parsedUrl.pathname === prefix &&
      parsedUrl.searchParams.get("restype") === "container" &&
      parsedUrl.searchParams.get("comp") === "list";

    if (isListRequest) {
      stats.listRequests += 1;
    }

    if (forceBlobStatus) {
      res.writeHead(forceBlobStatus, { "Content-Type": "application/xml" });
      res.end("<Error><Code>AuthorizationPermissionMismatch</Code></Error>");
      return;
    }

    if (isListRequest) {
      const sortedNames = [...blobs.keys()].sort();
      const marker = parsedUrl.searchParams.get("marker") || "";
      const startIndex = marker ? Number.parseInt(marker.split(":")[0], 10) || 0 : 0;
      const slice = sortedNames.slice(startIndex, startIndex + pageSize);
      const nextIndex = startIndex + slice.length;
      const nextMarker = nextIndex < sortedNames.length ? `${nextIndex}:page&next` : "";

      const itemsXml = slice
        .map(
          (name) =>
            `<Blob><Name>${encodeXmlText(name)}</Name><Properties><Content-Length>${blobs.get(name).body.byteLength}</Content-Length></Properties></Blob>`,
        )
        .join("");

      const xml =
        `<?xml version="1.0" encoding="utf-8"?>` +
        `<EnumerationResults ServiceEndpoint="http://127.0.0.1/" ContainerName="${encodeXmlText(containerName)}">` +
        `<Blobs>${itemsXml}</Blobs>` +
        `<NextMarker>${encodeXmlText(nextMarker)}</NextMarker>` +
        `</EnumerationResults>`;

      res.writeHead(200, { "Content-Type": "application/xml" });
      res.end(xml);
      return;
    }

    if (!parsedUrl.pathname.startsWith(`${prefix}/`)) {
      res.writeHead(404);
      res.end();
      return;
    }

    const encodedBlobKey = parsedUrl.pathname.slice(prefix.length + 1);
    const blobName = encodedBlobKey
      .split("/")
      .map((seg) => decodeURIComponent(seg))
      .join("/");

    if (req.method === "PUT") {
      stats.putRequests += 1;
      if (req.headers["x-ms-blob-type"] !== "BlockBlob") {
        res.writeHead(400, { "Content-Type": "application/xml" });
        res.end("<Error><Code>InvalidBlobType</Code></Error>");
        return;
      }
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        if (req.headers["content-length"] !== String(body.byteLength)) {
          res.writeHead(411);
          res.end();
          return;
        }
        blobs.set(blobName, {
          body,
          contentType: String(req.headers["content-type"] || "application/octet-stream"),
        });
        res.writeHead(201);
        res.end();
      });
      return;
    }

    if (req.method === "GET") {
      stats.getRequests += 1;
      stats.requestedGetNames.push(blobName);
      const stored = blobs.get(blobName);
      if (!stored) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": stored.contentType,
        "Content-Length": String(stored.body.byteLength),
      });
      res.end(stored.body);
      return;
    }

    if (req.method === "DELETE") {
      stats.deleteRequests += 1;
      stats.deletedNames.push(blobName);
      if (!blobs.has(blobName)) {
        res.writeHead(404);
        res.end();
        return;
      }
      blobs.delete(blobName);
      res.writeHead(202);
      res.end();
      return;
    }

    res.writeHead(405);
    res.end();
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  t.after(() => server.close());

  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl,
    blobEndpoint: `${baseUrl}/`,
    identityEndpoint: `${baseUrl}/msi/token`,
    identityHeader: expectedIdentityHeader,
    clientId: expectedClientId,
    containerName,
    blobs,
    stats,
    setBlobErrorStatus(code) {
      forceBlobStatus = code;
    },
    setTokenErrorStatus(code) {
      forceTokenStatus = code;
    },
    invalidateAllTokens() {
      validTokens.clear();
    },
  };
}

test("storage-config resolves default local paths, PORTAL_STORAGE_ROOT, azure-blob diagnostics, and individual overrides", (t) => {
  registerBlobSyncStatusProvider(null);
  assert.equal(resolveGeneratedLabsDir({}), OUTPUT_ROOT);
  assert.equal(resolvePortalDataDir({}), resolve(PORTAL_ROOT, "data"));
  assert.equal(resolvePortalUploadsDir({}), resolve(PORTAL_ROOT, "public", "uploads"));

  const defaultDiag = getStorageDiagnostics({});
  assert.deepEqual(defaultDiag, {
    persistent: false,
    backend: "local-disk",
    writable: true,
    blobSync: DISABLED_BLOB_SYNC,
  });

  const storageRoot = makeTempDir(t, "storage-root-");
  const rootEnv = { PORTAL_STORAGE_ROOT: storageRoot };

  assert.equal(resolveGeneratedLabsDir(rootEnv), resolve(storageRoot, "generated-labs"));
  assert.equal(resolvePortalDataDir(rootEnv), resolve(storageRoot, "data"));
  assert.equal(resolvePortalUploadsDir(rootEnv), resolve(storageRoot, "uploads"));

  const customVolDiag = getStorageDiagnostics(rootEnv);
  assert.deepEqual(customVolDiag, {
    persistent: true,
    backend: "custom-volume",
    writable: true,
    blobSync: DISABLED_BLOB_SYNC,
  });

  const acaAutoDiag = getStorageDiagnostics({
    PORTAL_STORAGE_ROOT: storageRoot,
    CONTAINER_APP_NAME: "ca-portal-demo",
  });
  assert.deepEqual(acaAutoDiag, {
    persistent: true,
    backend: "azure-files",
    writable: true,
    blobSync: DISABLED_BLOB_SYNC,
  });

  const azureBlobDiag = getStorageDiagnostics({
    PORTAL_STORAGE_ROOT: storageRoot,
    AZURE_STORAGE_BLOB_ENDPOINT: "https://stcslabssecret.blob.core.windows.net/",
    AZURE_STORAGE_BLOB_CONTAINER: "portalstate",
  });
  assert.deepEqual(azureBlobDiag, {
    persistent: true,
    backend: "azure-blob",
    writable: true,
    blobSync: {
      enabled: true,
      hydrated: false,
      hydratedFiles: 0,
      syncedFiles: 0,
      lastSyncAt: null,
      healthy: true,
    },
  });

  // Never leak raw host filesystem paths, storage endpoints, or secrets in public diagnostics.
  const serializedDiag = JSON.stringify(azureBlobDiag);
  assert.ok(!serializedDiag.includes(storageRoot));
  assert.ok(!serializedDiag.includes(storageRoot.replaceAll("\\", "/")));
  assert.ok(!serializedDiag.includes("stcslabssecret"));
  assert.ok(!serializedDiag.includes("blob.core.windows.net"));

  // Explicit per-directory overrides take precedence over PORTAL_STORAGE_ROOT.
  const overrideLabs = join(storageRoot, "custom-labs");
  const overrideData = join(storageRoot, "custom-data");
  const overrideUploads = join(storageRoot, "custom-uploads");
  const overrideEnv = {
    PORTAL_STORAGE_ROOT: storageRoot,
    LAB_BUILDER_OUTPUT_DIR: overrideLabs,
    PORTAL_DATA_DIR: overrideData,
    PORTAL_UPLOADS_DIR: overrideUploads,
  };
  assert.equal(resolveGeneratedLabsDir(overrideEnv), resolve(overrideLabs));
  assert.equal(resolvePortalDataDir(overrideEnv), resolve(overrideData));
  assert.equal(resolvePortalUploadsDir(overrideEnv), resolve(overrideUploads));

  const ensured = ensurePortalStorageDirs(rootEnv);
  assert.equal(ensured.writable, true);
  assert.equal(existsSync(resolve(storageRoot, "generated-labs")), true);
  assert.equal(existsSync(resolve(storageRoot, "data", "lab-builder")), true);
  assert.equal(existsSync(resolve(storageRoot, "uploads")), true);
  // Write-readiness probe cleans up after itself.
  assert.deepEqual(readdirSync(resolve(storageRoot, "uploads")), []);

  // Degraded / non-directory path does not crash ensurePortalStorageDirs or getStorageDiagnostics.
  const blockingFile = join(storageRoot, "not-a-directory");
  writeFileSync(blockingFile, "file-blocking-dir");
  const degradedEnv = {
    PORTAL_STORAGE_ROOT: blockingFile,
    PORTAL_STORAGE_BACKEND: "azure-blob",
  };
  const degradedEnsured = ensurePortalStorageDirs(degradedEnv);
  assert.equal(degradedEnsured.writable, false);
  assert.deepEqual(getStorageDiagnostics(degradedEnv), {
    persistent: true,
    backend: "azure-blob",
    writable: false,
    blobSync: {
      enabled: true,
      hydrated: false,
      hydratedFiles: 0,
      syncedFiles: 0,
      lastSyncAt: null,
      healthy: false,
    },
  });
});

test("branding, approvals, agent-chat, and topic-store honor PORTAL_STORAGE_ROOT and explicit overrides dynamically", async (t) => {
  const storageRoot = makeTempDir(t, "stateful-modules-root-");
  const overrideRoot = makeTempDir(t, "stateful-modules-override-");

  const savedEnv = {
    PORTAL_STORAGE_ROOT: process.env.PORTAL_STORAGE_ROOT,
    PORTAL_DATA_DIR: process.env.PORTAL_DATA_DIR,
    PORTAL_UPLOADS_DIR: process.env.PORTAL_UPLOADS_DIR,
    LAB_BUILDER_TOPICS_CACHE: process.env.LAB_BUILDER_TOPICS_CACHE,
  };
  t.after(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  process.env.PORTAL_STORAGE_ROOT = storageRoot;
  delete process.env.PORTAL_DATA_DIR;
  delete process.env.PORTAL_UPLOADS_DIR;
  delete process.env.LAB_BUILDER_TOPICS_CACHE;

  ensurePortalStorageDirs();

  // 1. Branding uses PORTAL_STORAGE_ROOT/data and PORTAL_STORAGE_ROOT/uploads.
  assert.equal(getBrandingDataDir(), resolve(storageRoot, "data"));
  assert.equal(getBrandingUploadsDir(), resolve(storageRoot, "uploads"));
  assert.equal(getBrandingFilePath(), resolve(storageRoot, "data", "branding.json"));

  const savedBrand = saveBranding({
    companyName: "Contoso Cloud Academy",
    primaryColor: "#0f6cbd",
    tagline: "Persistent Portal",
  });
  assert.equal(savedBrand.companyName, "Contoso Cloud Academy");
  assert.equal(existsSync(resolve(storageRoot, "data", "branding.json")), true);

  const logoPathOnDisk = resolve(storageRoot, "uploads", "logo-test.png");
  writeFileSync(logoPathOnDisk, ONE_PIXEL_PNG);
  const withLogo = updateBrandingLogo("logo-test.png");
  assert.equal(withLogo.logo, "/uploads/logo-test.png");
  assert.equal(getBrandingLogoAbsolutePath(withLogo.logo), logoPathOnDisk);
  assert.equal(getBrandingLogoAbsolutePath("/uploads/../branding.json"), null);
  assert.equal(getBrandingLogoAbsolutePath("/uploads/malicious.svg"), null);
  assert.equal(resolveSafeUploadFile("logo-test.png").status, 200);

  const clearedLogo = deleteBrandingLogo();
  assert.equal(clearedLogo.logo, null);
  assert.equal(existsSync(logoPathOnDisk), false);

  // 2. Approvals uses PORTAL_STORAGE_ROOT/data.
  saveApprovalConfig({ approvalMethod: "portal", approverEmails: ["admin@contoso.com"] });
  assert.equal(loadApprovalConfig().approvalMethod, "portal");
  assert.equal(existsSync(resolve(storageRoot, "data", "approval-config.json")), true);

  const submitted = await submitRequest({
    displayName: "Contoso Persistent Sandbox",
    requestedBy: "maker@contoso.com",
    environmentType: "Sandbox",
    location: "unitedstates",
  });
  assert.equal(existsSync(resolve(storageRoot, "data", "approval-requests.json")), true);
  assert.equal(listRequests().length, 1);
  assert.equal(getRequest(submitted.id)?.displayName, "Contoso Persistent Sandbox");

  // 3. Agent chat config uses PORTAL_STORAGE_ROOT/data.
  saveAgentChatConfig({
    tokenEndpoint: "https://example.environment.api.powerplatform.com/powervirtualagents/botsbyschema/bot/directline/token",
    agentName: "Persistent Lab Assistant",
  });
  const loadedChat = loadAgentChatConfig();
  assert.equal(loadedChat.configured, true);
  assert.equal(loadedChat.agentName, "Persistent Lab Assistant");
  assert.equal(existsSync(resolve(storageRoot, "data", "agent-chat-config.json")), true);

  // 4. Topic store defaults cachePath under PORTAL_STORAGE_ROOT/data/lab-builder/topics-cache.json.
  assert.equal(
    topicConfig().cachePath,
    join(resolve(storageRoot, "data"), "lab-builder", "topics-cache.json"),
  );

  // 5. Explicit PORTAL_DATA_DIR / PORTAL_UPLOADS_DIR / LAB_BUILDER_TOPICS_CACHE override PORTAL_STORAGE_ROOT.
  const explicitDataDir = join(overrideRoot, "explicit-data");
  const explicitUploadsDir = join(overrideRoot, "explicit-uploads");
  const explicitTopicsCache = join(overrideRoot, "custom-topics-cache.json");
  process.env.PORTAL_DATA_DIR = explicitDataDir;
  process.env.PORTAL_UPLOADS_DIR = explicitUploadsDir;

  // Fresh directory starts clean and isolated from storageRoot.
  assert.equal(loadBranding().companyName, "Microsoft AI Training Generator");
  assert.equal(listRequests().length, 0);
  assert.equal(loadAgentChatConfig().configured, false);
  assert.equal(
    topicConfig().cachePath,
    join(resolve(explicitDataDir), "lab-builder", "topics-cache.json"),
  );

  process.env.LAB_BUILDER_TOPICS_CACHE = explicitTopicsCache;
  assert.equal(topicConfig().cachePath, explicitTopicsCache);
});

test("Managed Identity Azure Blob persistence syncs generated labs, binary assets, JSON state, and deletions from Container #1 to empty Container #2 byte-for-byte", async (t) => {
  const mockCloud = await startMockAzureBlobAndIdentityServer(t, { pageSize: 3 });
  const container1Root = makeTempDir(t, "aca-replica-1-");
  const container2Root = makeTempDir(t, "aca-replica-2-empty-");

  async function startBlobBackedPortal(storageRoot) {
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, ["server.js"], {
      cwd: PORTAL_ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        HOST: "127.0.0.1",
        PORTAL_AUTH_DISABLED: "true",
        AZURE_KEYVAULT_URL: "",
        PORTAL_STORAGE_ROOT: storageRoot,
        PORTAL_STORAGE_BACKEND: "azure-blob",
        AZURE_STORAGE_BLOB_ENDPOINT: mockCloud.blobEndpoint,
        AZURE_STORAGE_BLOB_CONTAINER: mockCloud.containerName,
        AZURE_CLIENT_ID: mockCloud.clientId,
        IDENTITY_ENDPOINT: mockCloud.identityEndpoint,
        IDENTITY_HEADER: mockCloud.identityHeader,
        AZURE_STORAGE_SYNC_DEBOUNCE_MS: "40",
        LAB_BUILDER_LINK_CHECK: "off",
        LAB_BUILDER_LLM: "off",
      },
      stdio: "ignore",
    });
    await waitForServer(base, child);
    return { port, base, child };
  }

  let uploadedLogoUrl = "";
  let keptLabId = "";
  let deletedLabId = "";
  let container1Snapshot = null;

  // Boot Container #1 with empty storageRoot; create branding, logo, feedback, 2 labs, then delete 1 lab.
  const first = await startBlobBackedPortal(container1Root);
  try {
    const healthInitial = await (await fetch(`${first.base}/healthz`)).json();
    assert.equal(healthInitial.status, "ok");
    assert.equal(healthInitial.storage.persistent, true);
    assert.equal(healthInitial.storage.backend, "azure-blob");
    assert.equal(healthInitial.storage.writable, true);
    assert.equal(healthInitial.storage.blobSync.enabled, true);
    assert.equal(healthInitial.storage.blobSync.hydrated, true);
    assert.equal(healthInitial.storage.blobSync.healthy, true);

    const serializedHealth = JSON.stringify(healthInitial);
    assert.ok(!serializedHealth.includes(container1Root));
    assert.ok(!serializedHealth.includes(mockCloud.baseUrl));
    assert.ok(!serializedHealth.includes(mockCloud.identityHeader));

    // Save branding text fields.
    const brandRes = await fetch(`${first.base}/api/branding`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        companyName: "Fabrikam SFI Enablement",
        primaryColor: "#107c41",
        tagline: "Passwordless Managed Identity Blob",
      }),
    });
    assert.equal(brandRes.status, 200);

    // Reject SVG upload via multipart endpoint.
    const svgForm = new FormData();
    svgForm.append(
      "logo",
      new Blob(['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'], {
        type: "image/svg+xml",
      }),
      "evil.svg",
    );
    const svgUploadRes = await fetch(`${first.base}/api/branding/logo`, {
      method: "POST",
      body: svgForm,
    });
    assert.equal(svgUploadRes.status, 400);

    // Upload valid PNG logo.
    const pngForm = new FormData();
    pngForm.append("logo", new Blob([ONE_PIXEL_PNG], { type: "image/png" }), "brand.png");
    const logoUploadRes = await fetch(`${first.base}/api/branding/logo`, {
      method: "POST",
      body: pngForm,
    });
    assert.equal(logoUploadRes.status, 200);
    const logoBrandJson = await logoUploadRes.json();
    assert.match(logoBrandJson.logo, /^\/uploads\/logo-\d+\.png$/);
    uploadedLogoUrl = logoBrandJson.logo;

    // Harden /uploads against SVG, disguised markup, and path traversal (clean up rogue files afterward).
    const droppedSvgPath = join(container1Root, "uploads", "dropped.svg");
    const disguisedPngPath = join(container1Root, "uploads", "disguised.png");
    writeFileSync(droppedSvgPath, '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');
    writeFileSync(disguisedPngPath, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

    assert.equal((await fetch(`${first.base}/uploads/dropped.svg`)).status, 400);
    assert.equal((await fetch(`${first.base}/uploads/disguised.png`)).status, 400);
    assert.equal((await fetch(`${first.base}/uploads/%2e%2e%2fdata%2fbranding.json`)).status, 400);
    assert.equal((await fetch(`${first.base}/uploads/..%5cdata%5cbranding.json`)).status, 400);
    const rawTraversalRes = await rawHttpGet(first.port, "/uploads/../data/branding.json");
    assert.notEqual(rawTraversalRes.status, 200);
    assert.doesNotMatch(rawTraversalRes.body, /Fabrikam SFI Enablement/);

    rmSync(droppedSvgPath, { force: true });
    rmSync(disguisedPngPath, { force: true });

    // Save feedback entry.
    const feedbackRes = await fetch(`${first.base}/api/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        labId: "01-intro-workshop",
        section: "Overview",
        rating: "up",
        comment: "Synced via Managed Identity Blob Storage",
      }),
    });
    assert.equal(feedbackRes.status, 201);

    // Generate Lab A (kept) — includes Markdown, HTML, manifest, and binary DOCX/PPTX topic decks.
    const genARes = await fetch(`${first.base}/api/lab-builder/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Contoso & Co AI Lab",
        products: ["copilot-studio"],
        features: ["create-agent"],
        level: 100,
        useLearnMcp: false,
        useLlm: false,
      }),
    });
    assert.equal(genARes.status, 200);
    const genAJson = await genARes.json();
    assert.equal(genAJson.status, "complete");
    keptLabId = genAJson.labId;

    // Generate Lab B and wait for background Blob sync to upload it first, then DELETE it via API.
    const genBRes = await fetch(`${first.base}/api/lab-builder/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Temporary Ephemeral Lab",
        products: ["copilot-studio"],
        features: ["create-agent"],
        level: 100,
        useLearnMcp: false,
        useLlm: false,
      }),
    });
    assert.equal(genBRes.status, 200);
    const genBJson = await genBRes.json();
    deletedLabId = genBJson.labId;
    assert.notEqual(deletedLabId, keptLabId);

    // Wait until Lab B blobs appear in mock Blob storage before deleting Lab B.
    const uploadDeadline = Date.now() + 8000;
    while (Date.now() < uploadDeadline) {
      if ([...mockCloud.blobs.keys()].some((k) => k.startsWith(`generated-labs/${deletedLabId}/`))) {
        break;
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    assert.ok(
      [...mockCloud.blobs.keys()].some((k) => k.startsWith(`generated-labs/${deletedLabId}/`)),
      "Lab B should have been uploaded to Blob Storage before deletion",
    );

    // Delete Lab B via REST API and wait for coalesced DELETE sync to propagate to Blob Storage.
    const delRes = await fetch(
      `${first.base}/api/lab-builder/generated/${encodeURIComponent(deletedLabId)}`,
      { method: "DELETE" },
    );
    assert.equal(delRes.status, 200);

    const deleteDeadline = Date.now() + 8000;
    while (Date.now() < deleteDeadline) {
      const hasDeletedRemotely = ![...mockCloud.blobs.keys()].some((k) =>
        k.startsWith(`generated-labs/${deletedLabId}/`),
      );
      if (hasDeletedRemotely && mockCloud.stats.deleteRequests > 0) {
        break;
      }
      await new Promise((r) => setTimeout(r, 40));
    }

    assert.equal(
      [...mockCloud.blobs.keys()].some((k) => k.startsWith(`generated-labs/${deletedLabId}/`)),
      false,
      "Deleted lab blobs must be removed from Azure Blob Storage",
    );

    container1Snapshot = collectFilesWithHashes(container1Root);
    assert.ok(container1Snapshot.size >= 5, "Container #1 should have multiple persisted files");

    // Managed Identity token caching: dozens of PUT/DELETE requests should reuse 1 token from Container #1!
    assert.equal(mockCloud.stats.tokenRequests, 1, "Container #1 must cache Managed Identity token in memory");

    const configAfterSync = await (await fetch(`${first.base}/api/config`)).json();
    assert.equal(configAfterSync.storage.backend, "azure-blob");
    assert.equal(configAfterSync.storage.blobSync.enabled, true);
    assert.equal(configAfterSync.storage.blobSync.syncedFiles, container1Snapshot.size);
    assert.equal(configAfterSync.storage.blobSync.healthy, true);
    assert.ok(typeof configAfterSync.storage.blobSync.lastSyncAt === "string");
  } finally {
    first.child.kill();
  }

  // Confirm Container #2 starts with a completely empty directory!
  assert.deepEqual(readdirSync(container2Root), []);

  // Boot Container #2 pointing at the same Mock Azure Blob + Managed Identity server.
  const second = await startBlobBackedPortal(container2Root);
  try {
    const health2 = await (await fetch(`${second.base}/healthz`)).json();
    assert.equal(health2.storage.backend, "azure-blob");
    assert.equal(health2.storage.blobSync.enabled, true);
    assert.equal(health2.storage.blobSync.hydrated, true);
    assert.equal(health2.storage.blobSync.hydratedFiles, container1Snapshot.size);
    assert.equal(health2.storage.blobSync.syncedFiles, container1Snapshot.size);
    assert.equal(health2.storage.blobSync.healthy, true);

    // Byte-for-byte verification of EVERY file (Markdown, HTML, JSON, PNG, DOCX, PPTX) across replicas!
    const container2Snapshot = collectFilesWithHashes(container2Root);
    assert.deepEqual(
      [...container2Snapshot.keys()].sort(),
      [...container1Snapshot.keys()].sort(),
      "Container #2 must hydrate the exact file set from Container #1 (excluding deleted lab)",
    );

    for (const [relPath, expected] of container1Snapshot.entries()) {
      const actual = container2Snapshot.get(relPath);
      assert.ok(actual, `Missing hydrated file: ${relPath}`);
      assert.equal(actual.size, expected.size, `Byte size mismatch for ${relPath}`);
      assert.equal(actual.sha256, expected.sha256, `SHA-256 mismatch for ${relPath}`);
      assert.equal(Buffer.compare(actual.bytes, expected.bytes), 0, `Byte content mismatch for ${relPath}`);
    }

    // Verify HTTP APIs on Container #2 serve hydrated branding, logo, feedback, and generated lab.
    const brand2 = await (await fetch(`${second.base}/api/branding`)).json();
    assert.equal(brand2.companyName, "Fabrikam SFI Enablement");
    assert.equal(brand2.primaryColor, "#107c41");
    assert.equal(brand2.tagline, "Passwordless Managed Identity Blob");
    assert.equal(brand2.logo, uploadedLogoUrl);

    const logo2 = await fetch(`${second.base}${uploadedLogoUrl}`);
    assert.equal(logo2.status, 200);
    assert.deepEqual(Buffer.from(await logo2.arrayBuffer()), ONE_PIXEL_PNG);

    const feedback2 = await (await fetch(`${second.base}/api/feedback/01-intro-workshop`)).json();
    assert.equal(feedback2.feedback.length, 1);
    assert.equal(feedback2.feedback[0].comment, "Synced via Managed Identity Blob Storage");

    const generatedList2 = await (await fetch(`${second.base}/api/lab-builder/generated`)).json();
    const ids2 = (generatedList2.labs || []).map((lab) => lab.labId || lab.id);
    assert.ok(ids2.includes(keptLabId), "Hydrated lab must appear in Container #2");
    assert.ok(!ids2.includes(deletedLabId), "Deleted lab must NOT reappear in Container #2");
  } finally {
    second.child.kill();
  }
});

test("RBAC 403 propagation failure during startup hydrateFromBlob() never crashes boot and NEVER deletes pre-existing remote blobs", async (t) => {
  const mockCloud = await startMockAzureBlobAndIdentityServer(t, { initialBlobStatus: 403 });

  // Seed pre-existing remote blobs before the replica boots.
  mockCloud.blobs.set("generated-labs/precious-lab/index.md", {
    body: Buffer.from("# Precious Saved Lab\n", "utf8"),
    contentType: "text/markdown; charset=utf-8",
  });
  mockCloud.blobs.set("data/branding.json", {
    body: Buffer.from(
      JSON.stringify({
        companyName: "PreExisting Tenant Branding",
        logo: null,
        primaryColor: "#0f6cbd",
        tagline: "Must Never Be Wiped",
      }),
      "utf8",
    ),
    contentType: "application/json; charset=utf-8",
  });

  // 1. Verify full HTTP server still boots cleanly even while Azure RBAC returns 403!
  const bootRoot = makeTempDir(t, "rbac-403-boot-");
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.js"], {
    cwd: PORTAL_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      PORTAL_AUTH_DISABLED: "true",
      AZURE_KEYVAULT_URL: "",
      PORTAL_STORAGE_ROOT: bootRoot,
      PORTAL_STORAGE_BACKEND: "azure-blob",
      AZURE_STORAGE_BLOB_ENDPOINT: mockCloud.blobEndpoint,
      AZURE_STORAGE_BLOB_CONTAINER: mockCloud.containerName,
      AZURE_CLIENT_ID: mockCloud.clientId,
      IDENTITY_ENDPOINT: mockCloud.identityEndpoint,
      IDENTITY_HEADER: mockCloud.identityHeader,
      AZURE_STORAGE_RETRY_DELAY_MS: "10",
      LAB_BUILDER_LINK_CHECK: "off",
      LAB_BUILDER_LLM: "off",
    },
    stdio: "ignore",
  });

  try {
    await waitForServer(base, child);
    const health = await (await fetch(`${base}/healthz`)).json();
    assert.equal(health.status, "ok");
    assert.equal(health.storage.backend, "azure-blob");
    assert.equal(health.storage.blobSync.enabled, true);
    assert.equal(health.storage.blobSync.hydrated, false);
    assert.equal(health.storage.blobSync.healthy, false);
    assert.ok(!JSON.stringify(health).includes(mockCloud.baseUrl));
    assert.equal(mockCloud.stats.deleteRequests, 0, "Must NEVER issue DELETE on 403 boot");
  } finally {
    child.kill();
  }

  // 2. Verify programmatic controller retry + post-propagation reconciliation safety guard.
  const replicaRoot = makeTempDir(t, "rbac-403-reconcile-");
  const listBefore = mockCloud.stats.listRequests;
  const mirror = createBlobPersistence({
    env: {
      PORTAL_STORAGE_ROOT: replicaRoot,
      AZURE_STORAGE_BLOB_ENDPOINT: mockCloud.blobEndpoint,
      AZURE_STORAGE_BLOB_CONTAINER: mockCloud.containerName,
      AZURE_CLIENT_ID: mockCloud.clientId,
      IDENTITY_ENDPOINT: mockCloud.identityEndpoint,
      IDENTITY_HEADER: mockCloud.identityHeader,
    },
    maxRetries: 3,
    retryBaseDelayMs: 5,
  });

  const failedHydrateStatus = await mirror.hydrateFromBlob();
  assert.equal(failedHydrateStatus.hydrated, false);
  assert.equal(failedHydrateStatus.healthy, false);
  assert.equal(failedHydrateStatus.lastError, "Blob storage request failed (HTTP 403)");
  // 1 initial attempt + 3 retries = 4 list attempts.
  assert.equal(mockCloud.stats.listRequests - listBefore, 4);

  // User writes a new local file while replica is still unhydrated.
  ensurePortalStorageDirs({ PORTAL_STORAGE_ROOT: replicaRoot });
  writeFileSync(
    join(replicaRoot, "data", "feedback.json"),
    JSON.stringify([{ labId: "01", rating: "up" }]),
  );

  // Sync while 403 still active: fails non-fatally and deletes NOTHING.
  const syncDuring403 = await mirror.flushBlobSync();
  assert.equal(syncDuring403.hydrated, false);
  assert.equal(syncDuring403.healthy, false);
  assert.equal(mockCloud.stats.deleteRequests, 0);
  assert.equal(mockCloud.blobs.has("generated-labs/precious-lab/index.md"), true);
  assert.equal(mockCloud.blobs.has("data/branding.json"), true);

  // Now RBAC propagation finishes (200 OK): flushBlobSync reconciles missing remote blobs AND uploads new local file without deleting anything!
  mockCloud.setBlobErrorStatus(null);
  const reconciledStatus = await mirror.flushBlobSync();
  assert.equal(reconciledStatus.hydrated, true);
  assert.equal(reconciledStatus.healthy, true);
  assert.equal(reconciledStatus.lastError, null);
  assert.equal(mockCloud.stats.deleteRequests, 0, "Reconciliation must NEVER delete pre-existing remote blobs");
  assert.equal(mockCloud.blobs.has("generated-labs/precious-lab/index.md"), true);
  assert.equal(mockCloud.blobs.has("data/branding.json"), true);
  assert.equal(mockCloud.blobs.has("data/feedback.json"), true);
  assert.equal(
    readFileSync(join(replicaRoot, "generated-labs", "precious-lab", "index.md"), "utf8"),
    "# Precious Saved Lab\n",
  );
});

test("blob-persistence rejects malicious path-traversal blob names, decodes XML entities safely, and supports IMDS + token expiry refresh", async (t) => {
  const mockCloud = await startMockAzureBlobAndIdentityServer(t);
  const parentDir = makeTempDir(t, "traversal-sandbox-");
  const storageRoot = join(parentDir, "portal-storage");
  mkdirSync(storageRoot, { recursive: true });

  // Inject malicious blob keys directly into the mock remote container alongside one valid blob.
  const maliciousNames = [
    "../evil.js",
    "generated-labs/../../evil.js",
    "/etc/passwd",
    "C:/Windows/win.ini",
    "uploads\\..\\evil.js",
    "data/%2e%2e/evil.js",
  ];
  for (const bad of maliciousNames) {
    mockCloud.blobs.set(bad, {
      body: Buffer.from("process.exit(1);", "utf8"),
      contentType: "application/javascript",
    });
  }
  mockCloud.blobs.set("data/branding.json", {
    body: Buffer.from('{"companyName":"Safe & Sound"}\n', "utf8"),
    contentType: "application/json",
  });

  const env = {
    PORTAL_STORAGE_ROOT: storageRoot,
    AZURE_STORAGE_BLOB_ENDPOINT: mockCloud.blobEndpoint,
    AZURE_STORAGE_BLOB_CONTAINER: mockCloud.containerName,
    AZURE_CLIENT_ID: mockCloud.clientId,
    IDENTITY_ENDPOINT: mockCloud.identityEndpoint,
    IDENTITY_HEADER: mockCloud.identityHeader,
  };

  const mirror = createBlobPersistence({ env });
  const status = await mirror.hydrateFromBlob();

  assert.equal(status.hydrated, true);
  assert.equal(status.hydratedFiles, 1);
  assert.equal(status.rejectedBlobs, maliciousNames.length);
  assert.deepEqual(mockCloud.stats.requestedGetNames, ["data/branding.json"]);
  assert.equal(existsSync(join(parentDir, "evil.js")), false);
  assert.equal(existsSync(join(storageRoot, "evil.js")), false);
  assert.equal(
    readFileSync(join(storageRoot, "data", "branding.json"), "utf8"),
    '{"companyName":"Safe & Sound"}\n',
  );

  // Direct API calls with traversal names must reject immediately before making HTTP requests.
  for (const bad of maliciousNames) {
    assert.throws(() => validateSafeBlobName(bad), { code: "UNSAFE_BLOB_PATH" });
    assert.throws(() => resolveSafeBlobLocalPath(bad, env), { code: "UNSAFE_BLOB_PATH" });
    await assert.rejects(() => mirror.downloadBlob(bad), { code: "UNSAFE_BLOB_PATH" });
    await assert.rejects(() => mirror.uploadBlob(bad, Buffer.from("x")), { code: "UNSAFE_BLOB_PATH" });
    await assert.rejects(() => mirror.deleteBlob(bad), { code: "UNSAFE_BLOB_PATH" });
  }

  // XML single-pass entity decoding never double-unescapes `&amp;lt;`.
  assert.equal(decodeXmlEntities("Contoso &amp; Co &apos;Lab&apos; &amp;lt;tag&amp;gt;"), "Contoso & Co 'Lab' &lt;tag&gt;");
  const parsedXml = parseListBlobsXml(
    `<EnumerationResults><Blobs><Blob><Name>generated-labs/a &amp; b/index.md</Name></Blob></Blobs><NextMarker>2:a&amp;b</NextMarker></EnumerationResults>`,
  );
  assert.deepEqual(parsedXml, {
    names: ["generated-labs/a & b/index.md"],
    nextMarker: "2:a&b",
  });

  // Verify 64 MB BlockBlob upload + download round-trip works cleanly without corruption.
  const largeBlob = Buffer.alloc(64 * 1024 * 1024, 0x5a);
  largeBlob.write("HEAD-64MB-SENTINEL", 0, "utf8");
  largeBlob.write("TAIL-64MB-SENTINEL", largeBlob.length - 18, "utf8");
  await mirror.uploadBlob("generated-labs/large-lab/archive.zip", largeBlob, "application/zip");
  const downloadedLarge = await mirror.downloadBlob("generated-labs/large-lab/archive.zip");
  assert.equal(downloadedLarge.byteLength, 64 * 1024 * 1024);
  assert.equal(Buffer.compare(downloadedLarge, largeBlob), 0);
  await mirror.deleteBlob("generated-labs/large-lab/archive.zip");
  // Deleting an already-deleted blob (404) must also succeed idempotently.
  await mirror.deleteBlob("generated-labs/large-lab/archive.zip");

  // IMDS fallback + 5-minute token refresh skew verification.
  let fakeNowMs = 1_700_000_000_000;
  let imdsCalls = 0;
  const imdsProvider = createStorageTokenProvider({
    env: { AZURE_CLIENT_ID: "imds-client-guid" },
    now: () => fakeNowMs,
    fetchImpl: async (url, init) => {
      imdsCalls += 1;
      const parsed = new URL(url);
      assert.equal(parsed.origin, "http://169.254.169.254");
      assert.equal(parsed.pathname, "/metadata/identity/oauth2/token");
      assert.equal(parsed.searchParams.get("api-version"), "2018-02-01");
      assert.equal(parsed.searchParams.get("resource"), STORAGE_RESOURCE_AUDIENCE);
      assert.equal(parsed.searchParams.get("client_id"), "imds-client-guid");
      assert.equal(init.headers.Metadata, "true");
      return new Response(
        JSON.stringify({
          access_token: `imds-token-${imdsCalls}`,
          expires_on: String(Math.floor((fakeNowMs + 10 * 60 * 1000) / 1000)),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });

  assert.equal(await imdsProvider.acquireStorageAccessToken(), "imds-token-1");
  // +4 minutes (6 minutes left > 5-minute skew): still cached.
  fakeNowMs += 4 * 60 * 1000;
  assert.equal(await imdsProvider.acquireStorageAccessToken(), "imds-token-1");
  assert.equal(imdsCalls, 1);
  // +2 more minutes (4 minutes left <= 5-minute skew): refreshes automatically!
  fakeNowMs += 2 * 60 * 1000;
  assert.equal(await imdsProvider.acquireStorageAccessToken(), "imds-token-2");
  assert.equal(imdsCalls, 2);
});

test("infra/main.bicep compiles cleanly via az bicep build with SFI SecuredByPerimeter Blob storage, Managed Identity RBAC, and zero AzureFile mounts", () => {
  const storageBicepSource = readFileSync(join(repoRoot, "infra", "modules", "storage.bicep"), "utf8");
  const containerAppBicepSource = readFileSync(join(repoRoot, "infra", "modules", "container-app.bicep"), "utf8");
  const identityBicepSource = readFileSync(join(repoRoot, "infra", "modules", "identity.bicep"), "utf8");

  assert.match(identityBicepSource, /output\s+clientId\s+string\s*=\s*userIdentity\.properties\.clientId/);
  assert.match(storageBicepSource, /Microsoft\.Storage\/storageAccounts@2023-05-01/);
  assert.match(storageBicepSource, /allowSharedKeyAccess:\s*false/);
  assert.match(storageBicepSource, /publicNetworkAccess:\s*'SecuredByPerimeter'/);
  assert.match(storageBicepSource, /Microsoft\.Network\/networkSecurityPerimeters@2024-10-01/);
  assert.match(storageBicepSource, /ba92f5b4-2d11-453d-a403-e96b0029c9fe/);
  assert.doesNotMatch(storageBicepSource, /listKeys/);
  assert.doesNotMatch(storageBicepSource, /fileServices/);

  assert.doesNotMatch(containerAppBicepSource, /AzureFile/);
  assert.doesNotMatch(containerAppBicepSource, /managedEnvironments\/storages/);
  assert.doesNotMatch(containerAppBicepSource, /storageAccount\.listKeys/);
  assert.doesNotMatch(containerAppBicepSource, /volumeMounts/);

  const build = spawnSync("az bicep build --file infra/main.bicep --stdout", {
    cwd: repoRoot,
    encoding: "utf8",
    shell: true,
    timeout: 60000,
  });

  assert.equal(build.status, 0, `az bicep build failed:\n${build.stderr}`);
  assert.doesNotMatch(build.stderr || "", /\b(?:Warning|Error)\s+BCP\d+/i);

  const compiled = JSON.parse(build.stdout);
  assert.ok(compiled.outputs?.AZURE_STORAGE_ACCOUNT_NAME, "AZURE_STORAGE_ACCOUNT_NAME output must exist");
  assert.doesNotMatch(JSON.stringify(compiled.outputs || {}), /listKeys|accountKey/i);

  const storageModule = (compiled.resources || []).find(
    (resource) => resource.type === "Microsoft.Resources/deployments" && resource.name === "storage",
  );
  assert.ok(storageModule, "storage deployment module must exist in compiled main.bicep");
  assert.doesNotMatch(
    JSON.stringify(storageModule.properties?.template?.outputs || {}),
    /listKeys|accountKey/i,
  );

  const storageResources = storageModule.properties?.template?.resources || [];
  const storageAccountRes = storageResources.find(
    (resource) => resource.type === "Microsoft.Storage/storageAccounts",
  );
  assert.ok(storageAccountRes, "Microsoft.Storage/storageAccounts must exist");
  assert.equal(storageAccountRes.sku?.name, "Standard_LRS");
  assert.equal(storageAccountRes.kind, "StorageV2");
  assert.equal(storageAccountRes.properties?.minimumTlsVersion, "TLS1_2");
  assert.equal(storageAccountRes.properties?.allowBlobPublicAccess, false);
  assert.equal(storageAccountRes.properties?.supportsHttpsTrafficOnly, true);
  assert.equal(storageAccountRes.properties?.allowSharedKeyAccess, false);
  assert.equal(storageAccountRes.properties?.publicNetworkAccess, "SecuredByPerimeter");

  const blobContainerRes = storageResources.find(
    (resource) => resource.type === "Microsoft.Storage/storageAccounts/blobServices/containers",
  );
  assert.ok(blobContainerRes, "Azure Blob container resource must exist");
  assert.equal(blobContainerRes.properties?.publicAccess, "None");

  const nspRes = storageResources.find(
    (resource) => resource.type === "Microsoft.Network/networkSecurityPerimeters",
  );
  assert.ok(nspRes, "Network Security Perimeter resource must exist");

  const nspProfileRes = storageResources.find(
    (resource) => resource.type === "Microsoft.Network/networkSecurityPerimeters/profiles",
  );
  assert.ok(nspProfileRes, "Network Security Perimeter defaultProfile must exist");

  const nspAssocRes = storageResources.find(
    (resource) => resource.type === "Microsoft.Network/networkSecurityPerimeters/resourceAssociations",
  );
  assert.ok(nspAssocRes, "Network Security Perimeter storage-assoc must exist");
  assert.equal(nspAssocRes.properties?.accessMode, "Learning");

  const roleRes = storageResources.find(
    (resource) => resource.type === "Microsoft.Authorization/roleAssignments",
  );
  assert.ok(roleRes, "Storage Blob Data Contributor role assignment must exist");
  assert.equal(roleRes.properties?.principalType, "ServicePrincipal");
  assert.match(
    JSON.stringify(storageModule.properties?.template || {}),
    /ba92f5b4-2d11-453d-a403-e96b0029c9fe/,
  );

  const portalModule = (compiled.resources || []).find(
    (resource) => resource.type === "Microsoft.Resources/deployments" && resource.name === "portal",
  );
  assert.ok(portalModule, "portal deployment module must exist in compiled main.bicep");

  const portalResources = portalModule.properties?.template?.resources || [];
  assert.equal(
    portalResources.some((resource) => resource.type === "Microsoft.App/managedEnvironments/storages"),
    false,
    "Managed Environment SMB storage link must NOT exist",
  );

  const containerAppRes = portalResources.find(
    (resource) => resource.type === "Microsoft.App/containerApps",
  );
  assert.ok(containerAppRes, "Container App resource must exist");
  assert.equal(containerAppRes.properties?.template?.volumes, undefined);

  const portalContainer = containerAppRes.properties?.template?.containers?.[0];
  assert.equal(portalContainer?.volumeMounts, undefined);

  const envByName = Object.fromEntries((portalContainer?.env || []).map((item) => [item.name, item.value]));
  assert.equal(envByName.PORTAL_STORAGE_ROOT, "/app/portal-storage");
  assert.equal(envByName.PORTAL_STORAGE_BACKEND, "azure-blob");
  assert.equal(envByName.AZURE_STORAGE_BLOB_ENDPOINT, "[parameters('blobEndpoint')]");
  assert.equal(envByName.AZURE_STORAGE_BLOB_CONTAINER, "[parameters('blobContainerName')]");
  assert.equal(envByName.AZURE_CLIENT_ID, "[parameters('userIdentityClientId')]");
  assert.equal(envByName.LAB_BUILDER_OUTPUT_DIR, "/app/portal-storage/generated-labs");
  assert.equal(envByName.PORTAL_DATA_DIR, "/app/portal-storage/data");
  assert.equal(envByName.PORTAL_UPLOADS_DIR, "/app/portal-storage/uploads");
});
