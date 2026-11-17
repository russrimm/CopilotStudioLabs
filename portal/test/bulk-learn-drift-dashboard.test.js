/**
 * Hermetic unit, HTTP integration, and accessibility/UI tests for
 * Feature 9: Bulk Microsoft Learn Drift Dashboard.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import zlib from "node:zlib";

import { getFeatures } from "../lib/lab-builder/catalog.js";
import { generateLab } from "../lib/lab-builder/generator.js";
import { listGeneratedLabs } from "../lib/lab-builder/generated-labs.js";
import { captureLabScreenshots, revalidateLabAgainstLearn } from "../lib/lab-builder/lab-screenshots.js";
import {
  FLEET_METADATA_FILENAME,
  getFleetLearnDriftStatus,
  scanAllGeneratedLabsAgainstLearn,
  summarizeLabLearnDrift,
} from "../lib/lab-builder/learn-drift-dashboard.js";

process.env.LAB_BUILDER_LINK_CHECK = "off";
process.env.LAB_BUILDER_VENDOR_DOCS = "off";

const ISOLATED_SHARED_SHOTS = mkdtempSync(join(tmpdir(), "drift-isolated-shots-"));
process.on("exit", () => {
  try {
    rmSync(ISOLATED_SHARED_SHOTS, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function tmpDir(t, prefix = "drift-dash-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
  return dir;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function fixturePng(width = 140, height = 96, seed = 42) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  let s = seed >>> 0 || 1;
  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    raw[pos++] = 0;
    for (let x = 0; x < width; x += 1) {
      s = (s * 1664525 + 1013904223) >>> 0;
      raw[pos++] = (s >>> 16) & 0xff;
      raw[pos++] = (s >>> 8) & 0xff;
      raw[pos++] = s & 0xff;
      raw[pos++] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const idat = zlib.deflateSync(raw, { level: 0 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function normalizeDocKey(url = "") {
  return String(url || "")
    .trim()
    .toLowerCase()
    .replace(/[?#].*$/, "")
    .replace(/^https:\/\/learn\.microsoft\.com\/[a-z]{2}-[a-z]{2}\//, "https://learn.microsoft.com/")
    .replace(/\/+$/, "");
}

function lookupMockPage(pagesByUrl = {}, url = "") {
  if (pagesByUrl[url]) return pagesByUrl[url];
  const target = normalizeDocKey(url);
  for (const [k, v] of Object.entries(pagesByUrl)) {
    if (normalizeDocKey(k) === target) return v;
  }
  return "";
}

let mockConnectSeq = 0;

function makeMockConnect(pagesByUrl = {}) {
  const endpoint = `https://learn.microsoft.com/api/mcp#drift-mock-${++mockConnectSeq}`;
  const handleCall = async (name, args) => {
    if (name === "microsoft_docs_search") {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              Object.entries(pagesByUrl).map(([url, md]) => ({
                title: md.split("\n")[0]?.replace(/^#\s*/, "") || "Microsoft Learn Doc",
                contentUrl: url,
                content: md.slice(0, 300),
              })),
            ),
          },
        ],
      };
    }
    if (name === "microsoft_docs_fetch") {
      const md = lookupMockPage(pagesByUrl, args?.url);
      return md ? { content: [{ type: "text", text: md }] } : { content: [] };
    }
    return { content: [] };
  };
  return async () => ({
    ok: true,
    endpoint,
    call: handleCall,
    callTool: handleCall,
    async close() {},
  });
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolvePort(port));
    });
    srv.on("error", reject);
  });
}

async function startMockLearnMcpServer(t, getDocForUrl) {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      let rpcReq = {};
      try {
        rpcReq = JSON.parse(raw || "{}");
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "bad json" }));
        return;
      }
      if (rpcReq.method === "initialize") {
        res.writeHead(200, {
          "content-type": "application/json",
          "mcp-session-id": "mock-learn-session",
        });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: rpcReq.id,
            result: { protocolVersion: "2025-06-18", capabilities: {} },
          }),
        );
        return;
      }
      if (rpcReq.method === "tools/call" && rpcReq.params?.name === "microsoft_docs_fetch") {
        const url = rpcReq.params?.arguments?.url || "";
        try {
          const doc = getDocForUrl(url);
          if (doc && typeof doc === "object" && doc.httpStatus && doc.httpStatus >= 400) {
            res.writeHead(doc.httpStatus, { "content-type": "text/plain" });
            res.end(doc.error || "Simulated upstream error");
            return;
          }
          const text = typeof doc === "string" ? doc : doc?.markdown || "";
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: rpcReq.id,
              result: { content: text ? [{ type: "text", text }] : [] },
            }),
          );
        } catch (err) {
          res.writeHead(500, { "content-type": "text/plain" });
          res.end(err.message);
        }
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: rpcReq.id ?? 1, result: { content: [] } }));
    });
  });

  await new Promise((resolveListen, reject) => {
    server.listen(0, "127.0.0.1", resolveListen);
    server.on("error", reject);
  });
  t.after(() => server.close());
  const { port } = server.address();
  return `http://127.0.0.1:${port}/api/mcp`;
}

async function waitForServer(baseUrl, child, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let exitCode = null;
  child.on("exit", (code) => {
    exitCode = code;
  });
  while (Date.now() < deadline) {
    if (exitCode !== null) {
      throw new Error(`portal server exited early with code ${exitCode}`);
    }
    try {
      const r = await fetch(`${baseUrl}/api/health`);
      if (r.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error("Timed out waiting for portal server");
}

function readZipEntry(buffer, nameFragment) {
  let offset = buffer.length - 22;
  while (offset >= 0 && buffer.readUInt32LE(offset) !== 0x06054b50) offset -= 1;
  assert.ok(offset >= 0, "ZIP central directory must exist");
  const count = buffer.readUInt16LE(offset + 10);
  let cursor = buffer.readUInt32LE(offset + 16);
  for (let i = 0; i < count; i += 1) {
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const entryName = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    if (entryName === nameFragment || entryName.includes(nameFragment)) {
      const dataStart =
        localOffset +
        30 +
        buffer.readUInt16LE(localOffset + 26) +
        buffer.readUInt16LE(localOffset + 28);
      const data = buffer.subarray(dataStart, dataStart + compressedSize);
      return (method === 8 ? zlib.inflateRawSync(data) : data).toString("utf8");
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`${nameFragment} not found in ZIP`);
}

// ── Shared MS Learn fixtures ────────────────────────────────────────────────

const FEATURES = getFeatures();
const CREATE_FEATURE = FEATURES.find((f) => f.id === "mc-create-agent");
const MEMORY_FEATURE = FEATURES.find((f) => f.id === "mc-memory");
const PREVIEW_FEATURE = FEATURES.find((f) => f.id === "mc-preview-test");

const CREATE_URL = CREATE_FEATURE.docUrls[0];
const MEMORY_URL = MEMORY_FEATURE.docUrls[0];
const PREVIEW_URL = PREVIEW_FEATURE.docUrls[0];

const CREATE_MD = `# Create an agent in Copilot Studio

Use the **Microsoft Copilot** harness in Copilot Studio to create an agent grounded in your instructions.

## Create your agent

1. Sign in to Copilot Studio and on the **Home** page select **Agents**, then select **New agent** to open the **Build** tab.
2. Enter a name for your agent in the name field at the top of the designer.
3. Open **Agent settings** if you need to adjust the solution or schema name before the first save.
4. In the **Instructions** section, describe the agent's role, tone, and rules.
5. Select **Save** and confirm the **Build** tab displays knowledge, tools, skills, and memory components.`;

const MEMORY_V1_MD = `# Memory in Microsoft 365 Copilot agents

## Enable memory for an agent

1. Open your agent in Copilot Studio and select the **Build** tab.
2. In the components panel, turn on the **Memory** toggle.
3. On the **Preview** tab, tell the agent a preference and start a new conversation.
4. Ask for a summary in the new conversation and check whether the remembered preference is applied.
5. Open the memory portal link to **View memories** or **Delete all memories**.`;

const MEMORY_V2_MD = `# Memory in Microsoft 365 Copilot agents

## Enable memory and 90-day retention governance for an agent

1. Open your agent in Copilot Studio and select the **Build** tab.
2. In the components panel, turn on **Memory**, enable **Enterprise retention policy**, and select **90-day audit window**.
3. On the **Preview** tab, tell the agent a preference and start a new conversation.
4. Verify recall across conversations in chat and confirm the **90-day audit window** badge appears.
5. Open the memory portal link to **View memories** or **Delete all memories**.`;

const PREVIEW_V1_MD = `# Test your agent in Copilot Studio

Use the built-in **Preview** and **Test your agent** pane to validate prompts and inspect reasoning before publishing to Microsoft Copilot.

## Open the test pane

1. In Copilot Studio, open your agent and select the **Preview** tab to open the interactive chat.
2. Select a prompt suggestion or enter a test message and send it to start a conversation.
3. Review the response and inspect the activity trace, then select a source or tool chip to jump to the **Build** tab.

## Toggle end user preview and filter history

1. Turn on the **End user preview** toggle to test the agent as end users see it, and note the estimated Copilot Credits total on the **Preview** tab.
2. Open conversation history and filter by **Failed** or **Completed** status to inspect earlier test runs.`;

// ── 1. Fleet summary across all drift postures ──────────────────────────────

test("summarizeLabLearnDrift, getFleetLearnDriftStatus, and listGeneratedLabs classify not-checked, up-to-date, docs-updated, missing-screenshot, and ungrounded labs without network calls", async (t) => {
  const outputRoot = tmpDir(t, "fleet-summary-");
  const emptyLabsDir = tmpDir(t, "empty-labs-");
  const png = fixturePng(128, 96, 77);

  const baselineDocs = {
    [CREATE_URL]: CREATE_MD,
    [MEMORY_URL]: MEMORY_V1_MD,
    [PREVIEW_URL]: PREVIEW_V1_MD,
  };

  // Lab 1: Freshly generated, never re-checked -> "not-checked"
  const uncheckedLab = await generateLab(
    {
      products: ["copilot-studio"],
      features: ["mc-preview-test"],
      harness: "microsoft-copilot",
      includeCore: false,
      title: "Unchecked Preview Lab",
    },
    { outputRoot, labsDir: emptyLabsDir, useLearnMcp: false, useLlm: false },
  );
  assert.equal(uncheckedLab.status, "complete");

  // Lab 2: Revalidated + screenshots captured -> "up-to-date"
  const upToDateLab = await generateLab(
    {
      products: ["copilot-studio"],
      features: ["mc-preview-test"],
      harness: "microsoft-copilot",
      includeCore: false,
      captureScreenshots: true,
      title: "Up To Date Preview Lab",
    },
    {
      outputRoot,
      labsDir: emptyLabsDir,
      useLearnMcp: true,
      connect: makeMockConnect(baselineDocs),
      checkLink: async (url) => ({ url, status: 200, ok: true }),
      useLlm: false,
      screenshotDriver: async () => png,
    },
  );
  assert.equal(upToDateLab.status, "complete");
  await revalidateLabAgainstLearn(outputRoot, upToDateLab.labId, {
    capturedDir: ISOLATED_SHARED_SHOTS,
    fetchDoc: async (url) => lookupMockPage(baselineDocs, url),
    autoUpdate: false,
  });

  // Lab 3: Revalidated against updated MEMORY_V2_MD -> "docs-updated"
  const driftedLab = await generateLab(
    {
      products: ["copilot-studio"],
      features: ["mc-memory"],
      harness: "microsoft-copilot",
      includeCore: false,
      captureScreenshots: true,
      title: "Drifted Memory Lab",
    },
    {
      outputRoot,
      labsDir: emptyLabsDir,
      useLearnMcp: true,
      connect: makeMockConnect(baselineDocs),
      checkLink: async (url) => ({ url, status: 200, ok: true }),
      useLlm: false,
      screenshotDriver: async () => png,
    },
  );
  assert.equal(driftedLab.status, "complete");
  await revalidateLabAgainstLearn(outputRoot, driftedLab.labId, {
    capturedDir: ISOLATED_SHARED_SHOTS,
    fetchDoc: async (url) => (normalizeDocKey(url) === normalizeDocKey(MEMORY_URL) ? MEMORY_V2_MD : lookupMockPage(baselineDocs, url)),
    autoUpdate: false,
  });

  // Lab 4: Revalidated with no captured screenshots -> "missing-screenshot"
  const missingShotsLab = await generateLab(
    {
      products: ["copilot-studio"],
      features: ["mc-preview-test"],
      harness: "microsoft-copilot",
      includeCore: false,
      title: "Missing Screenshots Lab",
    },
    {
      outputRoot,
      labsDir: emptyLabsDir,
      useLearnMcp: true,
      connect: makeMockConnect(baselineDocs),
      checkLink: async (url) => ({ url, status: 200, ok: true }),
      useLlm: false,
    },
  );
  assert.equal(missingShotsLab.status, "complete");
  await revalidateLabAgainstLearn(outputRoot, missingShotsLab.labId, {
    capturedDir: ISOLATED_SHARED_SHOTS,
    fetchDoc: async (url) => lookupMockPage(baselineDocs, url),
    autoUpdate: false,
  });

  // Lab 5: Synthetic ungrounded custom lab -> "ungrounded"
  const ungroundedId = "custom-ungrounded-lab";
  const ungroundedDir = join(outputRoot, ungroundedId);
  mkdirSync(join(ungroundedDir, "screenshots"), { recursive: true });
  writeFileSync(
    join(ungroundedDir, "manifest.json"),
    JSON.stringify(
      {
        title: "Custom Ungrounded Lab",
        generatedAt: "2026-01-10T00:00:00.000Z",
        modules: [{ id: "nonexistent-custom-topic", name: "Offline Topic" }],
        grounding: { groundedModules: 0 },
      },
      null,
      2,
    ),
  );
  writeFileSync(join(ungroundedDir, "index.md"), "# Custom Ungrounded Lab\n");

  const fleet = getFleetLearnDriftStatus(outputRoot);
  assert.equal(fleet.lastBulkScanAt, null);
  assert.deepEqual(fleet.counts, {
    total: 5,
    upToDate: 1,
    docsUpdated: 1,
    missingScreenshots: 1,
    notChecked: 1,
    ungrounded: 1,
  });

  const byId = new Map(fleet.labs.map((l) => [l.labId, l]));
  assert.equal(byId.get(uncheckedLab.labId).status, "not-checked");
  assert.equal(byId.get(uncheckedLab.labId).lastCheckedAt, null);

  assert.equal(byId.get(upToDateLab.labId).status, "up-to-date");
  assert.ok(byId.get(upToDateLab.labId).lastCheckedAt);
  assert.equal(byId.get(upToDateLab.labId).driftedModuleCount, 0);
  assert.equal(byId.get(upToDateLab.labId).missingScreenshotCount, 0);

  const driftedSummary = byId.get(driftedLab.labId);
  assert.equal(driftedSummary.status, "docs-updated");
  assert.equal(driftedSummary.driftedModuleCount, 1);
  assert.equal(driftedSummary.driftedModules.length, 1);
  assert.equal(driftedSummary.driftedModules[0].moduleId, "mc-memory");
  assert.equal(driftedSummary.driftedModules[0].learnUrl, MEMORY_URL);

  assert.equal(byId.get(missingShotsLab.labId).status, "missing-screenshot");
  assert.ok(byId.get(missingShotsLab.labId).missingScreenshotCount >= 1);

  assert.equal(byId.get(ungroundedId).status, "ungrounded");

  // Verify listGeneratedLabs attaches learnDrift to every item as well
  const listed = listGeneratedLabs(outputRoot);
  assert.equal(listed.labs.length, 5);
  for (const item of listed.labs) {
    assert.ok(item.learnDrift, `expected learnDrift on ${item.labId}`);
    assert.equal(item.learnDrift.status, byId.get(item.labId).status);
  }
});

// ── 2 & 3. Bulk scan + bulk autoUpdate over HTTP & direct API ───────────────

test("HTTP GET/POST /api/lab-builder/learn-drift and /scan detect upstream MS Learn edits, persist learn-drift-fleet.json, and bulk auto-update drifted steps/HTML/topic docs", async (t) => {
  const outputRoot = tmpDir(t, "http-drift-");
  const emptyLabsDir = tmpDir(t, "empty-labs-");
  const png = fixturePng(136, 92, 202);

  const liveDocs = {
    [CREATE_URL]: CREATE_MD,
    [MEMORY_URL]: MEMORY_V1_MD,
    [PREVIEW_URL]: PREVIEW_V1_MD,
  };

  const mockMcpUrl = await startMockLearnMcpServer(t, (url) => lookupMockPage(liveDocs, url));

  // Build Lab A (mc-memory, screenshots captured) and Lab B (mc-preview-test, screenshots captured)
  // plus Lab C (mc-memory, screenshots NOT captured -> pending)
  const labA = await generateLab(
    {
      products: ["copilot-studio"],
      features: ["mc-memory"],
      harness: "microsoft-copilot",
      includeCore: false,
      captureScreenshots: true,
      title: "Memory Governance Workshop",
    },
    {
      outputRoot,
      labsDir: emptyLabsDir,
      useLearnMcp: true,
      connect: makeMockConnect(liveDocs),
      checkLink: async (url) => ({ url, status: 200, ok: true }),
      useLlm: false,
      screenshotDriver: async () => png,
    },
  );
  assert.equal(labA.status, "complete");

  const labB = await generateLab(
    {
      products: ["copilot-studio"],
      features: ["mc-preview-test"],
      harness: "microsoft-copilot",
      includeCore: false,
      captureScreenshots: true,
      title: "Agent Preview Workshop",
    },
    {
      outputRoot,
      labsDir: emptyLabsDir,
      useLearnMcp: true,
      connect: makeMockConnect(liveDocs),
      checkLink: async (url) => ({ url, status: 200, ok: true }),
      useLlm: false,
      screenshotDriver: async () => png,
    },
  );
  assert.equal(labB.status, "complete");

  const labC = await generateLab(
    {
      products: ["copilot-studio"],
      features: ["mc-memory"],
      harness: "microsoft-copilot",
      includeCore: false,
      title: "Uncaptured Memory Workshop",
    },
    {
      outputRoot,
      labsDir: emptyLabsDir,
      useLearnMcp: true,
      connect: makeMockConnect(liveDocs),
      checkLink: async (url) => ({ url, status: 200, ok: true }),
      useLlm: false,
    },
  );
  assert.equal(labC.status, "complete");

  // Boot the Express portal server wired to our local mock Learn MCP server (zero internet traffic)
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      PORTAL_AUTH_DISABLED: "true",
      AZURE_KEYVAULT_URL: "",
      LAB_BUILDER_OUTPUT_DIR: outputRoot,
      FEATURE_TOUR_SCREENSHOTS_DIR: ISOLATED_SHARED_SHOTS,
      LEARN_MCP_URL: mockMcpUrl,
      LAB_BUILDER_LINK_CHECK: "off",
      LAB_BUILDER_VENDOR_DOCS: "off",
      LAB_BUILDER_MANAGE_RATE_MAX: "50",
    },
    stdio: "ignore",
  });
  t.after(() => child.kill());
  await waitForServer(base, child);

  // Initial GET /api/lab-builder/learn-drift: all 3 labs are "not-checked"
  const initRes = await fetch(`${base}/api/lab-builder/learn-drift`);
  assert.equal(initRes.status, 200);
  const initBody = await initRes.json();
  assert.equal(initBody.lastBulkScanAt, null);
  assert.equal(initBody.counts.total, 3);
  assert.equal(initBody.counts.notChecked, 3);

  // Simulate upstream Microsoft Learn updating mc-memory procedure steps!
  liveDocs[MEMORY_URL] = MEMORY_V2_MD;

  // Bulk scan across all labs (autoUpdate: false)
  const scanRes = await fetch(`${base}/api/lab-builder/learn-drift/scan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ autoUpdate: false }),
  });
  assert.equal(scanRes.status, 200);
  const scanBody = await scanRes.json();
  assert.equal(scanBody.scannedCount, 3);
  assert.equal(scanBody.updatedCount, 0);
  assert.equal(scanBody.errorCount, 0);
  assert.equal(scanBody.counts.docsUpdated, 2, "labA and labC use mc-memory and should report docs-updated");
  assert.equal(scanBody.counts.upToDate, 1, "labB uses mc-skills and should report up-to-date");
  assert.ok(scanBody.scannedAt);

  // Verify learn-drift-fleet.json persisted and ignored by listGeneratedLabs / GET /api/lab-builder/generated
  const fleetFile = join(outputRoot, FLEET_METADATA_FILENAME);
  assert.ok(existsSync(fleetFile), "learn-drift-fleet.json must be written to rootDir");
  const persistedFleet = JSON.parse(readFileSync(fleetFile, "utf8"));
  assert.equal(persistedFleet.lastBulkScanAt, scanBody.scannedAt);

  const aliasGet = await fetch(`${base}/api/generated-labs/learn-drift`);
  assert.equal(aliasGet.status, 200);
  const aliasGetBody = await aliasGet.json();
  assert.equal(aliasGetBody.lastBulkScanAt, scanBody.scannedAt);
  assert.equal(aliasGetBody.counts.docsUpdated, 2);

  const genListRes = await fetch(`${base}/api/lab-builder/generated`);
  assert.equal(genListRes.status, 200);
  const genListBody = await genListRes.json();
  assert.equal(genListBody.labs.length, 3, "learn-drift-fleet.json must not appear as a lab");
  const genLabA = genListBody.labs.find((l) => l.labId === labA.labId);
  const genLabB = genListBody.labs.find((l) => l.labId === labB.labId);
  assert.equal(genLabA.learnDrift.status, "docs-updated");
  assert.equal(genLabB.learnDrift.status, "up-to-date");

  // Subset autoUpdate: update ONLY labA via /api/generated-labs/learn-drift/scan
  const subsetUpdateRes = await fetch(`${base}/api/generated-labs/learn-drift/scan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ labIds: [labA.labId], autoUpdate: true }),
  });
  assert.equal(subsetUpdateRes.status, 200);
  const subsetBody = await subsetUpdateRes.json();
  assert.equal(subsetBody.scannedCount, 1);
  assert.equal(subsetBody.updatedCount, 1);
  assert.equal(subsetBody.counts.docsUpdated, 1, "labC is still drifted while labA is now updated");
  assert.equal(subsetBody.counts.upToDate, 2, "labA and labB are now up-to-date");

  // Verify labA's index.md, standalone index.html, and per-topic DOCX were refreshed with 90-day audit window!
  const labAMd = readFileSync(join(labA.outputDir, "index.md"), "utf8");
  const labAHtml = readFileSync(join(labA.outputDir, "index.html"), "utf8");
  assert.match(labAMd, /90-day audit window/);
  assert.match(labAHtml, /90-day audit window/);

  const labAManifest = JSON.parse(readFileSync(join(labA.outputDir, "manifest.json"), "utf8"));
  const memTopicDoc = (labAManifest.topicDocuments || []).find((d) => /Memory/i.test(d.title));
  assert.ok(memTopicDoc, "per-topic document metadata must exist for Memory module");
  const docxBytes = readFileSync(join(labA.outputDir, "topics", memTopicDoc.docxFileName));
  const docxXml = readZipEntry(docxBytes, "word/document.xml");
  assert.match(docxXml, /90-day audit window/, "per-topic DOCX must contain refreshed MS Learn steps");
  const pptxStat = statSync(join(labA.outputDir, "topics", memTopicDoc.pptxFileName));
  assert.ok(pptxStat.size > 1000, "per-topic PPTX must be regenerated");

  // Fleet-wide autoUpdate: updates remaining drifted labC (whose screenshots are still pending -> transitions to "missing-screenshot")
  const fullUpdateRes = await fetch(`${base}/api/lab-builder/learn-drift/scan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ autoUpdate: true }),
  });
  assert.equal(fullUpdateRes.status, 200);
  const fullUpdateBody = await fullUpdateRes.json();
  assert.equal(fullUpdateBody.errorCount, 0);
  assert.equal(fullUpdateBody.counts.docsUpdated, 0, "all drifted labs resolved");
  assert.equal(fullUpdateBody.counts.upToDate, 2);
  assert.equal(fullUpdateBody.counts.missingScreenshots, 1, "labC transitions to missing-screenshot until captured");

  const labCMd = readFileSync(join(labC.outputDir, "index.md"), "utf8");
  assert.match(labCMd, /90-day audit window/);
  assert.equal(summarizeLabLearnDrift(outputRoot, labC.labId).status, "missing-screenshot");

  // Invalid labIds / path traversal probes over HTTP must be rejected with 400
  for (const badPayload of [
    { labIds: ["../secret"] },
    { labIds: ["bad..lab"] },
    { labIds: ["nested/lab"] },
    { labIds: ["nested\\lab"] },
    { labIds: [""] },
    { labIds: "not-an-array" },
  ]) {
    const badRes = await fetch(`${base}/api/lab-builder/learn-drift/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(badPayload),
    });
    assert.equal(badRes.status, 400, `expected 400 for ${JSON.stringify(badPayload)}`);
  }
});

// ── 4. Partial-failure resilience & bounded concurrency ─────────────────────

test("scanAllGeneratedLabsAgainstLearn isolates per-lab fetchDoc errors without aborting batch and enforces bounded concurrency", async (t) => {
  const outputRoot = tmpDir(t, "resilience-");
  const emptyLabsDir = tmpDir(t, "empty-labs-");
  const png = fixturePng(120, 80, 313);

  const baselineDocs = {
    [CREATE_URL]: CREATE_MD,
    [MEMORY_URL]: MEMORY_V1_MD,
    [PREVIEW_URL]: PREVIEW_V1_MD,
  };

  const labs = [];
  for (let i = 0; i < 4; i += 1) {
    const feature = i === 1 ? "mc-memory" : "mc-preview-test";
    const built = await generateLab(
      {
        products: ["copilot-studio"],
        features: [feature],
        harness: "microsoft-copilot",
        includeCore: false,
        captureScreenshots: true,
        title: `Batch Lab ${i + 1}`,
      },
      {
        outputRoot,
        labsDir: emptyLabsDir,
        useLearnMcp: true,
        connect: makeMockConnect(baselineDocs),
        checkLink: async (url) => ({ url, status: 200, ok: true }),
        useLlm: false,
        screenshotDriver: async () => png,
      },
    );
    assert.equal(built.status, "complete");
    labs.push(built);
  }

  const failingLabId = labs[1].labId;
  const activeLabs = new Set();
  let peakConcurrentLabs = 0;

  const outcome = await scanAllGeneratedLabsAgainstLearn(outputRoot, {
    concurrency: 2,
    capturedDir: ISOLATED_SHARED_SHOTS,
    fetchDoc: async (url, ctx) => {
      activeLabs.add(ctx.labId);
      peakConcurrentLabs = Math.max(peakConcurrentLabs, activeLabs.size);
      await new Promise((r) => setTimeout(r, 35));
      activeLabs.delete(ctx.labId);
      if (ctx.labId === failingLabId) {
        throw new Error("Simulated Learn timeout on lab 2");
      }
      return lookupMockPage(baselineDocs, url);
    },
  });

  assert.equal(outcome.status, 200);
  assert.ok(peakConcurrentLabs <= 2, `expected <= 2 concurrent lab scans, got ${peakConcurrentLabs}`);
  assert.equal(outcome.body.scannedCount, 3);
  assert.equal(outcome.body.errorCount, 1);

  const failedEntry = outcome.body.results.find((r) => r.labId === failingLabId);
  assert.ok(failedEntry);
  assert.equal(failedEntry.ok, false);
  assert.match(failedEntry.error, /Simulated Learn timeout on lab 2/);

  const succeededEntries = outcome.body.results.filter((r) => r.labId !== failingLabId);
  assert.equal(succeededEntries.length, 3);
  for (const entry of succeededEntries) {
    assert.equal(entry.ok, true);
    assert.equal(entry.status, "up-to-date");
  }
});

// ── 5. Accessibility, CSS contrast, and frontend VM behavior checks ─────────

function tokens(html, blockStart) {
  const start = html.indexOf(blockStart);
  assert.ok(start >= 0, `${blockStart} block must exist`);
  const body = html.slice(start, html.indexOf("}", start));
  return Object.fromEntries(
    [...body.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)].map((m) => [m[1], m[2]]),
  );
}

function luminance(hex) {
  const value = hex.replace("#", "");
  const full = value.length === 3 ? [...value].map((c) => c + c).join("") : value;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test("index.html and generated-labs.js expose accessible Bulk MS Learn Drift Dashboard controls, WCAG AA contrast, filter/sort, and quick card update", async () => {
  const indexHtml = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const genLabsJs = readFileSync(new URL("../public/generated-labs.js", import.meta.url), "utf8");

  // Explicit accessible label for #lb-gen-drift-filter and accessible button names
  assert.match(indexHtml, /id="lb-gen-drift-dashboard"[^>]*aria-labelledby="lb-gen-drift-heading"/);
  assert.match(indexHtml, /<label\s+for="lb-gen-drift-filter">\s*MS Learn status\s*<\/label>/);
  assert.match(indexHtml, /<select\s+id="lb-gen-drift-filter"/);
  assert.match(indexHtml, /data-drift-action="scan-all"[^>]*aria-label="[^"]+"/);
  assert.match(indexHtml, /data-drift-action="update-drifted"[^>]*aria-label="[^"]+"/);
  assert.match(indexHtml, /id="lb-gen-drift-status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(indexHtml, /<option value="needs-update">Needs update first<\/option>/);
  assert.doesNotMatch(genLabsJs, /\bon(click|change|input)=/);

  // Focus-visible and print CSS present
  assert.match(indexHtml, /#lb-gen-drift-filter:focus-visible/);
  assert.match(indexHtml, /\.lb-gen-drift-dashboard/);

  // WCAG AA >= 4.5:1 contrast in both dark and light themes for all drift pills/badges
  const dark = tokens(indexHtml, ":root {");
  const light = tokens(indexHtml, ':root[data-theme="light"]');
  for (const [themeName, tks] of [
    ["dark", dark],
    ["light", light],
  ]) {
    assert.ok(
      contrastRatio(tks["--stat-total-text"], tks["--stat-total-bg"]) >= 4.5,
      `${themeName} total pill contrast`,
    );
    assert.ok(
      contrastRatio(tks["--complete-text"], tks["--complete-bg"]) >= 4.5,
      `${themeName} up-to-date pill/badge contrast`,
    );
    assert.ok(
      contrastRatio(tks["--stat-warn-text"], tks["--stat-warn-bg"]) >= 4.5,
      `${themeName} drifted warning pill/badge contrast`,
    );
    assert.ok(
      contrastRatio(tks["--stat-chip-text"], tks["--stat-chip-bg"]) >= 4.5,
      `${themeName} neutral pill/badge contrast`,
    );
  }

  // Evaluate generated-labs.js in a hermetic VM harness to verify rendering, filtering, sorting, and single-lab sync
  const elements = new Map();
  const getEl = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        innerHTML: "",
        textContent: "",
        className: "",
        hidden: true,
        disabled: false,
        style: {},
        attrs: {},
        setAttribute(k, v) {
          this.attrs[k] = String(v);
        },
        removeAttribute(k) {
          delete this.attrs[k];
        },
        addEventListener() {},
        querySelector: () => null,
        querySelectorAll: () => [],
      });
    }
    return elements.get(id);
  };

  const context = {
    document: {
      getElementById: getEl,
      querySelector: () => null,
      querySelectorAll: () => [],
      body: { dataset: {}, appendChild() {} },
    },
    window: { addEventListener() {}, print() {} },
    CSS: { escape: (s) => String(s) },
    escapeHtml: (s) =>
      String(s ?? "").replace(
        /[&<>"']/g,
        (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
      ),
    labBuilder: { industries: [], levels: [], harnesses: [], products: [], editing: null },
    lbFormatMinutes: (m) => `${m} min`,
    lbLoadSelections: async () => {},
    lbLoadResultPreview: async () => {},
    toast: () => {},
    fetch: async () => ({ ok: true, json: async () => ({ labs: [] }) }),
    setTimeout,
    console,
  };
  vm.createContext(context);
  vm.runInContext(genLabsJs, context);

  // Empty state hides #lb-gen-drift-dashboard
  vm.runInContext("lbGen.labs = []; lbGenRender();", context);
  assert.equal(getEl("lb-gen-drift-dashboard").hidden, true);

  // Populate 3 labs with distinct drift statuses
  const sampleLabs = [
    {
      labId: "lab-old-ok",
      title: "Alpha Up To Date",
      generatedAt: "2026-03-01T10:00:00.000Z",
      totalMinutes: 45,
      moduleCount: 2,
      learnDrift: {
        status: "up-to-date",
        lastCheckedAt: "2026-03-02T10:00:00.000Z",
        driftedModuleCount: 0,
        driftedModules: [],
        missingScreenshotCount: 0,
        moduleCount: 2,
      },
    },
    {
      labId: "lab-drifted",
      title: "Beta Drifted Lab",
      generatedAt: "2026-02-15T10:00:00.000Z",
      totalMinutes: 60,
      moduleCount: 3,
      learnDrift: {
        status: "docs-updated",
        lastCheckedAt: "2026-03-02T11:00:00.000Z",
        driftedModuleCount: 2,
        driftedModules: [
          { moduleId: "mc-memory", title: "Agent Memory", learnUrl: MEMORY_URL },
          { moduleId: "mc-preview-test", title: "Preview and Test", learnUrl: PREVIEW_URL },
        ],
        missingScreenshotCount: 0,
        moduleCount: 3,
      },
    },
    {
      labId: "lab-unchecked",
      title: "Gamma Fresh Lab",
      generatedAt: "2026-03-05T10:00:00.000Z",
      totalMinutes: 30,
      moduleCount: 1,
      learnDrift: {
        status: "not-checked",
        lastCheckedAt: null,
        driftedModuleCount: 0,
        driftedModules: [],
        missingScreenshotCount: 1,
        moduleCount: 1,
      },
    },
  ];

  vm.runInContext(`lbGen.labs = ${JSON.stringify(sampleLabs)}; lbGenRender();`, context);

  assert.equal(getEl("lb-gen-drift-dashboard").hidden, false);
  assert.equal(getEl("lb-drift-stat-total").textContent, "3");
  assert.equal(getEl("lb-drift-stat-uptodate").textContent, "1");
  assert.equal(getEl("lb-drift-stat-drifted").textContent, "1");
  assert.equal(getEl("lb-drift-stat-unchecked").textContent, "1");
  assert.equal(getEl("lb-gen-drift-update-btn").hidden, false);
  assert.equal(getEl("lb-gen-drift-update-btn").disabled, false);
  assert.match(getEl("lb-gen-drift-update-btn").textContent, /Update all drifted labs \(1\)/);

  const listHtmlAll = getEl("lb-generated-list").innerHTML;
  assert.match(listHtmlAll, /✓ MS Learn up to date/);
  assert.match(listHtmlAll, /⚠ 2 topics updated on MS Learn/);
  assert.match(listHtmlAll, /Not checked against MS Learn yet/);
  assert.match(listHtmlAll, /data-gen-action="quick-learn-update"[^>]*data-lab-id="lab-drifted"/);

  // Sort by "needs-update" -> Beta Drifted Lab appears first despite older generatedAt!
  const sortedIds = vm.runInContext(
    `lbGen.sort = "needs-update"; lbGenVisible().map((l) => l.labId);`,
    context,
  );
  assert.equal(sortedIds[0], "lab-drifted");

  // Filter by "docs-updated" -> only Beta Drifted Lab shown
  vm.runInContext(`lbGen.driftFilter = "docs-updated"; lbGenRender();`, context);
  assert.match(getEl("lb-gen-count").textContent, /Showing 1 of 3 generated labs/);
  assert.doesNotMatch(getEl("lb-generated-list").innerHTML, /Alpha Up To Date/);
  assert.match(getEl("lb-generated-list").innerHTML, /Beta Drifted Lab/);

  // Single-lab revalidation sync helper updates badge & hides bulk Update button once resolved
  vm.runInContext(
    `lbGen.driftFilter = "all";
     lbSyncSingleLabDriftFromState("lab-drifted", {
       lastRevalidatedAt: "2026-03-06T12:00:00.000Z",
       summary: { total: 2, captured: 2, missing: 0, stale: 0, learnSyncStatus: "up-to-date" },
       modules: [{ featureId: "mc-memory", title: "Agent Memory", status: "up-to-date" }]
     });`,
    context,
  );
  assert.equal(getEl("lb-drift-stat-drifted").textContent, "0");
  assert.equal(getEl("lb-drift-stat-uptodate").textContent, "2");
  assert.equal(getEl("lb-gen-drift-update-btn").hidden, true);
});
