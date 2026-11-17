/**
 * Tests for persistent Azure Files storage configuration, stateful portal
 * directory overrides, HTTP persistence across server restarts, `/uploads`
 * hardening, and Bicep template compilation.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  OUTPUT_ROOT,
  PORTAL_ROOT,
  ensurePortalStorageDirs,
  getStorageDiagnostics,
  resolveGeneratedLabsDir,
  resolvePortalDataDir,
  resolvePortalUploadsDir,
  resolveSafeUploadFile,
} from "../lib/storage-config.js";
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

test("storage-config resolves default local paths, PORTAL_STORAGE_ROOT, and individual overrides", (t) => {
  assert.equal(resolveGeneratedLabsDir({}), OUTPUT_ROOT);
  assert.equal(resolvePortalDataDir({}), resolve(PORTAL_ROOT, "data"));
  assert.equal(resolvePortalUploadsDir({}), resolve(PORTAL_ROOT, "public", "uploads"));

  const defaultDiag = getStorageDiagnostics({});
  assert.deepEqual(defaultDiag, {
    persistent: false,
    backend: "local-disk",
    writable: true,
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
  });

  const acaAutoDiag = getStorageDiagnostics({
    PORTAL_STORAGE_ROOT: storageRoot,
    CONTAINER_APP_NAME: "ca-portal-demo",
  });
  assert.deepEqual(acaAutoDiag, {
    persistent: true,
    backend: "azure-files",
    writable: true,
  });

  const explicitAzureFilesDiag = getStorageDiagnostics({
    PORTAL_STORAGE_ROOT: storageRoot,
    PORTAL_STORAGE_BACKEND: "azure-files",
  });
  assert.deepEqual(explicitAzureFilesDiag, {
    persistent: true,
    backend: "azure-files",
    writable: true,
  });

  // Never leak raw host filesystem paths in public diagnostics.
  const serializedDiag = JSON.stringify(explicitAzureFilesDiag);
  assert.ok(!serializedDiag.includes(storageRoot));
  assert.ok(!serializedDiag.includes(storageRoot.replaceAll("\\", "/")));

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
    PORTAL_STORAGE_BACKEND: "azure-files",
  };
  const degradedEnsured = ensurePortalStorageDirs(degradedEnv);
  assert.equal(degradedEnsured.writable, false);
  assert.deepEqual(getStorageDiagnostics(degradedEnv), {
    persistent: true,
    backend: "azure-files",
    writable: false,
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

test("HTTP portal persists branding, uploaded logos, feedback, and generated labs across restarts while blocking SVG and path traversal", async (t) => {
  const storageRoot = makeTempDir(t, "http-persist-");

  async function startIsolatedPortal() {
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
        PORTAL_STORAGE_BACKEND: "azure-files",
        LAB_BUILDER_LINK_CHECK: "off",
        LAB_BUILDER_LLM: "off",
      },
      stdio: "ignore",
    });
    await waitForServer(base, child);
    return { port, base, child };
  }

  let uploadedLogoUrl = "";
  let generatedLabId = "";

  // Boot instance #1 and populate portal state + generated lab.
  const first = await startIsolatedPortal();
  try {
    const healthRes = await fetch(`${first.base}/healthz`);
    assert.equal(healthRes.status, 200);
    const healthJson = await healthRes.json();
    assert.equal(healthJson.status, "ok");
    assert.deepEqual(healthJson.storage, {
      persistent: true,
      backend: "azure-files",
      writable: true,
    });
    assert.ok(!JSON.stringify(healthJson).includes(storageRoot));
    assert.ok(!JSON.stringify(healthJson).includes(storageRoot.replaceAll("\\", "/")));

    const configRes = await fetch(`${first.base}/api/config`);
    assert.equal(configRes.status, 200);
    const configJson = await configRes.json();
    assert.deepEqual(configJson.storage, {
      persistent: true,
      backend: "azure-files",
      writable: true,
    });
    assert.ok(!JSON.stringify(configJson).includes(storageRoot));
    assert.ok(!JSON.stringify(configJson).includes(storageRoot.replaceAll("\\", "/")));

    // Save branding text fields.
    const brandRes = await fetch(`${first.base}/api/branding`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        companyName: "Fabrikam AI Enablement",
        primaryColor: "#107c41",
        tagline: "Azure Files Backed",
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

    // Upload valid PNG logo and verify it lands in PORTAL_STORAGE_ROOT/uploads and serves from /uploads/:file.
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

    const uploadedFileName = uploadedLogoUrl.replace("/uploads/", "");
    assert.equal(existsSync(join(storageRoot, "uploads", uploadedFileName)), true);
    assert.equal(existsSync(join(PORTAL_ROOT, "public", "uploads", uploadedFileName)), false);

    const serveLogoRes = await fetch(`${first.base}${uploadedLogoUrl}`);
    assert.equal(serveLogoRes.status, 200);
    assert.match(serveLogoRes.headers.get("content-type") || "", /^image\/png/i);
    assert.equal(serveLogoRes.headers.get("x-content-type-options"), "nosniff");
    const servedBytes = Buffer.from(await serveLogoRes.arrayBuffer());
    assert.deepEqual(servedBytes, ONE_PIXEL_PNG);

    // Harden /uploads against dropped SVG, disguised SVG-as-PNG, and path traversal.
    writeFileSync(
      join(storageRoot, "uploads", "dropped.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>',
    );
    writeFileSync(
      join(storageRoot, "uploads", "disguised.png"),
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );

    const droppedSvgRes = await fetch(`${first.base}/uploads/dropped.svg`);
    assert.equal(droppedSvgRes.status, 400);

    const disguisedPngRes = await fetch(`${first.base}/uploads/disguised.png`);
    assert.equal(disguisedPngRes.status, 400);

    const encodedTraversalRes = await fetch(`${first.base}/uploads/%2e%2e%2fdata%2fbranding.json`);
    assert.equal(encodedTraversalRes.status, 400);
    assert.doesNotMatch(await encodedTraversalRes.text(), /Fabrikam AI Enablement/);

    const backslashTraversalRes = await fetch(`${first.base}/uploads/..%5cdata%5cbranding.json`);
    assert.equal(backslashTraversalRes.status, 400);

    const rawTraversalRes = await rawHttpGet(first.port, "/uploads/../data/branding.json");
    assert.notEqual(rawTraversalRes.status, 200);
    assert.doesNotMatch(rawTraversalRes.body, /Fabrikam AI Enablement/);

    const missingUploadRes = await fetch(`${first.base}/uploads/does-not-exist.png`);
    assert.equal(missingUploadRes.status, 404);

    // Save feedback entry.
    const feedbackRes = await fetch(`${first.base}/api/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        labId: "01-intro-workshop",
        section: "Overview",
        rating: "up",
        comment: "Persisted across container restarts",
      }),
    });
    assert.equal(feedbackRes.status, 201);
    assert.equal(existsSync(join(storageRoot, "data", "feedback.json")), true);

    // Generate an offline lab and verify it lands in PORTAL_STORAGE_ROOT/generated-labs.
    const genRes = await fetch(`${first.base}/api/lab-builder/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        products: ["copilot-studio"],
        features: ["create-agent"],
        level: 100,
        useLearnMcp: false,
        useLlm: false,
      }),
    });
    assert.equal(genRes.status, 200);
    const genJson = await genRes.json();
    assert.equal(genJson.status, "complete");
    generatedLabId = genJson.labId;
    assert.ok(generatedLabId);
    assert.equal(existsSync(join(storageRoot, "generated-labs", generatedLabId, "index.md")), true);
  } finally {
    first.child.kill();
  }

  // Boot instance #2 against the same PORTAL_STORAGE_ROOT (simulating ACA revision redeploy / scale-from-zero).
  const second = await startIsolatedPortal();
  try {
    const brandAfterRestart = await (await fetch(`${second.base}/api/branding`)).json();
    assert.equal(brandAfterRestart.companyName, "Fabrikam AI Enablement");
    assert.equal(brandAfterRestart.primaryColor, "#107c41");
    assert.equal(brandAfterRestart.tagline, "Azure Files Backed");
    assert.equal(brandAfterRestart.logo, uploadedLogoUrl);

    const logoAfterRestart = await fetch(`${second.base}${uploadedLogoUrl}`);
    assert.equal(logoAfterRestart.status, 200);
    assert.deepEqual(Buffer.from(await logoAfterRestart.arrayBuffer()), ONE_PIXEL_PNG);

    const feedbackAfterRestart = await (
      await fetch(`${second.base}/api/feedback/01-intro-workshop`)
    ).json();
    assert.equal(feedbackAfterRestart.feedback.length, 1);
    assert.equal(feedbackAfterRestart.feedback[0].comment, "Persisted across container restarts");

    const generatedList = await (await fetch(`${second.base}/api/lab-builder/generated`)).json();
    const labsArray = Array.isArray(generatedList?.labs) ? generatedList.labs : [];
    assert.ok(
      labsArray.some((lab) => (lab.labId || lab.id) === generatedLabId),
      `expected ${generatedLabId} in ${JSON.stringify(labsArray)}`,
    );

    const generatedRead = await fetch(`${second.base}/api/lab-builder/generated/${encodeURIComponent(generatedLabId)}`);
    assert.equal(generatedRead.status, 200);
  } finally {
    second.child.kill();
  }
});

test("infra/main.bicep compiles cleanly via az bicep build and mounts AzureFile at /mnt/portal-storage without exposing keys in outputs", () => {
  const mainBicepPath = join(repoRoot, "infra", "main.bicep");
  const storageBicepSource = readFileSync(join(repoRoot, "infra", "modules", "storage.bicep"), "utf8");
  const containerAppBicepSource = readFileSync(join(repoRoot, "infra", "modules", "container-app.bicep"), "utf8");

  assert.match(storageBicepSource, /Microsoft\.Storage\/storageAccounts@2023-05-01/);
  assert.match(storageBicepSource, /'portalstate'/);
  assert.doesNotMatch(storageBicepSource, /listKeys/);

  assert.match(containerAppBicepSource, /Microsoft\.App\/managedEnvironments\/storages@2024-03-01/);
  assert.match(containerAppBicepSource, /storageType:\s*'AzureFile'/);
  assert.match(containerAppBicepSource, /mountPath:\s*'\/mnt\/portal-storage'/);

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

  // Root outputs must never expose storage keys or listKeys() calls.
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
  assert.equal(storageAccountRes.properties?.allowSharedKeyAccess, true);

  const shareRes = storageResources.find(
    (resource) => resource.type === "Microsoft.Storage/storageAccounts/fileServices/shares",
  );
  assert.ok(shareRes, "Azure Files share resource must exist");
  const defaultShareQuota = storageModule.properties?.template?.parameters?.shareQuota?.defaultValue;
  assert.equal(
    shareRes.properties?.shareQuota === 5 || defaultShareQuota === 5,
    true,
    "Azure Files share quota must default to 5 GiB",
  );
  assert.equal(shareRes.properties?.enabledProtocols, "SMB");

  const portalModule = (compiled.resources || []).find(
    (resource) => resource.type === "Microsoft.Resources/deployments" && resource.name === "portal",
  );
  assert.ok(portalModule, "portal deployment module must exist in compiled main.bicep");
  assert.doesNotMatch(
    JSON.stringify(portalModule.properties?.template?.outputs || {}),
    /listKeys|accountKey/i,
  );

  const portalResources = portalModule.properties?.template?.resources || [];
  const envStorageRes = portalResources.find(
    (resource) => resource.type === "Microsoft.App/managedEnvironments/storages",
  );
  assert.ok(envStorageRes, "Managed Environment Azure Files storage link must exist");
  assert.equal(envStorageRes.properties?.azureFile?.accessMode, "ReadWrite");

  const containerAppRes = portalResources.find(
    (resource) => resource.type === "Microsoft.App/containerApps",
  );
  assert.ok(containerAppRes, "Container App resource must exist");
  assert.deepEqual(containerAppRes.properties?.template?.volumes, [
    {
      name: "portal-storage",
      storageType: "AzureFile",
      storageName: "portalstate",
    },
  ]);

  const portalContainer = containerAppRes.properties?.template?.containers?.[0];
  assert.deepEqual(portalContainer?.volumeMounts, [
    {
      volumeName: "portal-storage",
      mountPath: "/mnt/portal-storage",
    },
  ]);

  const envByName = Object.fromEntries((portalContainer?.env || []).map((item) => [item.name, item.value]));
  assert.equal(envByName.PORTAL_STORAGE_ROOT, "/mnt/portal-storage");
  assert.equal(envByName.PORTAL_STORAGE_BACKEND, "azure-files");
  assert.equal(envByName.LAB_BUILDER_OUTPUT_DIR, "/mnt/portal-storage/generated-labs");
  assert.equal(envByName.PORTAL_DATA_DIR, "/mnt/portal-storage/data");
  assert.equal(envByName.PORTAL_UPLOADS_DIR, "/mnt/portal-storage/uploads");
});
