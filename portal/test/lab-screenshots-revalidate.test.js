import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { PassThrough } from "node:stream";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import zlib from "node:zlib";
import { getFeatures } from "../lib/lab-builder/catalog.js";
import { resolveLabScreenshot } from "../lib/lab-builder/captured.js";
import { deriveSteps } from "../lib/lab-builder/steps.js";
import { generateLab } from "../lib/lab-builder/generator.js";
import { readGeneratedLab, resolveGeneratedAsset } from "../lib/lab-builder/generated-labs.js";
import {
  captureLabScreenshots,
  getLabScreenshotsStatus,
  revalidateLabAgainstLearn,
} from "../lib/lab-builder/lab-screenshots.js";
import {
  exportGeneratedLab,
  renderGeneratedLabDocx,
  renderGeneratedLabHtml,
  renderGeneratedLabPdf,
  renderGeneratedLabPptx,
} from "../lib/exporter.js";
import { renderLabMarkdown } from "../lib/markdown.js";

const ISOLATED_SHARED_SHOTS = mkdtempSync(join(tmpdir(), "lab-shots-isolated-"));
process.env.FEATURE_TOUR_SCREENSHOTS_DIR = ISOLATED_SHARED_SHOTS;
process.on("exit", () => {
  try {
    rmSync(ISOLATED_SHARED_SHOTS, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

function tmpDir(t, prefix = "lab-reval-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fixturePng(width = 140, height = 96, seedInit = 777) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(zlib.crc32(body) >>> 0, 8 + data.length);
    return out;
  };
  const rows = [];
  let seed = seedInit;
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    for (let i = 1; i < row.length; i += 1) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      row[i] = seed >> 16;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function normalizeDocKey(url) {
  return String(url || "")
    .trim()
    .toLowerCase()
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

let mockSessionSeq = 0;

function makeMockConnect(pagesByUrl = {}, searchItems = []) {
  const endpoint = `https://learn.microsoft.com/api/mcp#mock-${++mockSessionSeq}`;
  const handleCall = async (toolName, args) => {
    if (toolName === "microsoft_docs_search") {
      const matched = searchItems.length
        ? searchItems
        : Object.entries(pagesByUrl).map(([contentUrl, md]) => ({
            title: (md.match(/^#\s+(.+)$/m) || [null, "Microsoft Learn Article"])[1],
            contentUrl,
            content: md.slice(0, 300),
          }));
      return {
        content: [{ type: "text", text: JSON.stringify(matched) }],
      };
    }
    if (toolName === "microsoft_docs_fetch") {
      const md = lookupMockPage(pagesByUrl, args?.url);
      return {
        content: [{ type: "text", text: md }],
      };
    }
    return { content: [] };
  };
  return async () => ({
    ok: true,
    endpoint,
    async close() {},
    call: handleCall,
    callTool: handleCall,
  });
}

function makeMockFetchDocPage(pagesByUrl = {}) {
  return async (_session, url) => {
    const md = lookupMockPage(pagesByUrl, url);
    if (!md) {
      return { markdown: "", fetchedAt: new Date().toISOString(), error: `404 for ${url}` };
    }
    return { markdown: md, fetchedAt: new Date().toISOString(), error: null };
  };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitForServer(base, child) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early with code ${child.exitCode}`);
    try {
      const res = await fetch(`${base}/api/config`);
      if (res.status > 0) return;
    } catch {
      await new Promise((r) => setTimeout(r, 120));
    }
  }
  throw new Error("server did not start in time");
}

test("Preview and test an agent (mc-preview-test) and Memory (mc-memory) derive clean procedures without STEPS_NOT_DERIVED", async (t) => {
  const features = getFeatures();
  const createFeature = features.find((f) => f.id === "mc-create-agent");
  const previewFeature = features.find((f) => f.id === "mc-preview-test");
  const memoryFeature = features.find((f) => f.id === "mc-memory");
  assert.ok(createFeature && previewFeature && memoryFeature, "Microsoft Copilot harness features must exist");

  const createLearnMd = `# Create an agent in Copilot Studio

Use the **Microsoft Copilot** harness in Copilot Studio to create an agent grounded in your instructions.

## Create your agent

1. Sign in to Copilot Studio and on the **Home** page select **Agents**, then select **New agent** to open the **Build** tab.
2. Enter a name for your agent in the name field at the top of the designer.
3. Open **Agent settings** if you need to adjust the solution or schema name before the first save.
4. In the **Instructions** section, describe the agent's role, tone, and rules.
5. Select **Save** and confirm the **Build** tab displays knowledge, tools, skills, and memory components.`;

  const previewLearnMd = `# Test your agent in Copilot Studio

Use the built-in **Preview** and **Test your agent** pane to validate prompts and inspect reasoning before publishing to Microsoft Copilot.

## Open the test pane

1. In Copilot Studio, open your agent and select the **Preview** tab to open the interactive chat.
2. Select a prompt suggestion or enter a test message and send it to start a conversation.
3. Review the response and inspect the activity trace, then select a source or tool chip to jump to the **Build** tab.

## Toggle end user preview and filter history

1. Turn on the **End user preview** toggle to test the agent as end users see it, and note the estimated Copilot Credits total on the **Preview** tab.
2. Open conversation history and filter by **Failed** or **Completed** status to inspect earlier test runs.`;

  const memoryLearnMd = `# Memory in Microsoft 365 Copilot agents

Memory lets an agent recall user preferences across conversations in Microsoft Copilot.

## Turn Memory on for an agent

1. Open your agent in Copilot Studio and select the **Build** tab.
2. In the components panel, turn on the **Memory** toggle so the agent remembers per-user context.

## Preview and manage saved memories

1. On the **Preview** tab, tell the agent a formatting preference and start a new conversation.
2. In the new conversation, ask for a summary and verify the remembered preference is applied.
3. Ask the agent what it remembers in chat or open the memory portal link to **View memories** and review **Delete all memories**.`;

  const previewDerived = deriveSteps(previewLearnMd, previewFeature);
  assert.equal(previewDerived.ok, true);
  assert.ok(previewDerived.steps && previewDerived.steps.length >= 5);

  const memoryDerived = deriveSteps(memoryLearnMd, memoryFeature);
  assert.equal(memoryDerived.ok, true);
  assert.ok(memoryDerived.steps && memoryDerived.steps.length >= 5);

  const outputRoot = tmpDir(t, "mc-no-blocker-");
  const emptyLabsDir = tmpDir(t, "empty-labs-");
  const pagesByUrl = {
    [createFeature.docUrls[0]]: createLearnMd,
    [previewFeature.docUrls[0]]: previewLearnMd,
    [memoryFeature.docUrls[0]]: memoryLearnMd,
  };

  const build = await generateLab(
    {
      products: ["copilot-studio"],
      features: ["mc-preview-test", "mc-memory"],
      harness: "microsoft-copilot",
      includeCore: false,
    },
    {
      outputRoot,
      labsDir: emptyLabsDir,
      useLearnMcp: true,
      connect: makeMockConnect(pagesByUrl),
      checkLink: async (url) => ({ url, status: 200, ok: true }),
      useLlm: false,
    },
  );

  assert.equal(build.status, "complete", "build should complete cleanly without pausing on STEPS_NOT_DERIVED");
  assert.deepEqual(build.blockers, []);
});

test("generateLab writes per-lab screenshots/shots.json and screenshots/learn-state.json with structured steps and baselines", async (t) => {
  const outputRoot = tmpDir(t, "per-lab-plan-");
  const emptyLabsDir = tmpDir(t, "empty-labs-");
  const pngBuffer = fixturePng(150, 100, 101);

  const build = await generateLab(
    {
      products: ["copilot-studio"],
      features: ["mc-skills", "mc-memory"],
      harness: "microsoft-copilot",
      includeCore: false,
    },
    {
      outputRoot,
      labsDir: emptyLabsDir,
      useLearnMcp: false,
      useLlm: false,
    },
  );

  assert.equal(build.status, "complete");
  const shotsPlanPath = join(build.outputDir, "screenshots", "shots.json");
  const learnStatePath = join(build.outputDir, "screenshots", "learn-state.json");
  assert.ok(existsSync(shotsPlanPath), "screenshots/shots.json must be created");
  assert.ok(existsSync(learnStatePath), "screenshots/learn-state.json must be created");

  const shotsPlan = JSON.parse(readFileSync(shotsPlanPath, "utf8"));
  const learnState = JSON.parse(readFileSync(learnStatePath, "utf8"));

  assert.equal(shotsPlan.labId, build.labId);
  assert.equal(shotsPlan.harness, "microsoft-copilot");
  assert.ok(shotsPlan.shots.length >= 2);

  for (const shot of shotsPlan.shots) {
    assert.ok(shot.shotId && shot.featureId && shot.moduleTitle && shot.filename);
    assert.equal(shot.outputPath, `generated-labs/${build.labId}/assets/${shot.filename}`);
    assert.ok(shot.startUrl.startsWith("https://"));
    assert.deepEqual(shot.viewport, { width: 1440, height: 900 });
    assert.ok(Array.isArray(shot.steps) && shot.steps.some((s) => s.action === "navigate"));
    assert.ok(shot.steps.some((s) => s.action === "screenshot"));
    assert.ok(shot.learnBaseline && typeof shot.learnBaseline.stepHash === "string");
    assert.ok(Array.isArray(shot.learnBaseline.urls));
  }

  assert.equal(learnState.labId, build.labId);
  assert.equal(Object.keys(learnState.modules).length, build.manifest.modules.length);
  assert.ok(Object.keys(learnState.modules).length >= 2);
  assert.equal(build.manifest.screenshots.planPath, "screenshots/shots.json");
  assert.equal(build.manifest.screenshots.learnStatePath, "screenshots/learn-state.json");

  // Uncaptured placeholder (< 5 KB) resolves to null so exports use clean callouts rather than embedding the stub PNG
  const firstShot = shotsPlan.shots[0];
  assert.equal(resolveLabScreenshot(build.outputDir, firstShot.filename, { capturedDir: ISOLATED_SHARED_SHOTS }), null);

  const htmlUncaptured = renderGeneratedLabHtml(outputRoot, build.labId);
  assert.equal(htmlUncaptured.status, 200);
  // Only the small Portal brand banner logo may be a base64 PNG before module screenshots are captured
  const uncapturedDataImgs = htmlUncaptured.html.match(/<img[^>]+src="data:image\/png;base64,[^"]+"/g) || [];
  assert.ok(
    uncapturedDataImgs.every((tag) => tag.includes("lab-brand-logo")),
    "uncaptured module slots must not inline stub PNGs",
  );

  // Now capture screenshots via opt-in hermetic Playwright driver and verify real PNGs embed across HTML, DOCX, PDF, PPTX, and ZIP!
  const capOutcome = await captureLabScreenshots(outputRoot, build.labId, {
    onlyMissing: true,
    capturedDir: ISOLATED_SHARED_SHOTS,
    driver: async () => pngBuffer,
  });

  assert.equal(capOutcome.status, 200);
  assert.equal(capOutcome.body.capture.capturedCount, shotsPlan.shots.length);
  assert.equal(capOutcome.body.state.summary.captured, shotsPlan.shots.length);
  assert.equal(capOutcome.body.state.summary.missing, 0);

  // Preview read marks 0 pending screenshots
  const preview = readGeneratedLab(outputRoot, build.labId, renderLabMarkdown);
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.body.pendingScreenshots, []);
  assert.equal(preview.body.screenshotState.summary.captured, shotsPlan.shots.length);

  // Standalone HTML embeds base64 PNG data URI for captured module screenshots (beyond the brand logo)
  const htmlCaptured = renderGeneratedLabHtml(outputRoot, build.labId);
  assert.equal(htmlCaptured.status, 200);
  const capturedDataImgs = htmlCaptured.html.match(/<img[^>]+src="data:image\/png;base64,[^"]+"/g) || [];
  assert.ok(
    capturedDataImgs.some((tag) => !tag.includes("lab-brand-logo")),
    "captured module screenshots must be embedded inline in standalone HTML",
  );

  // DOCX, PDF, PPTX, and ZIP exports succeed and embed the real PNG assets
  const docxRes = renderGeneratedLabDocx(outputRoot, build.labId);
  assert.equal(docxRes.status, 200);
  assert.ok(docxRes.buffer.length > pngBuffer.length);

  const pdfRes = renderGeneratedLabPdf(outputRoot, build.labId);
  assert.equal(pdfRes.status, 200);
  assert.equal(pdfRes.buffer.subarray(0, 4).toString("ascii"), "%PDF");

  const pptxRes = renderGeneratedLabPptx(outputRoot, build.labId);
  assert.equal(pptxRes.status, 200);
  assert.ok(pptxRes.buffer.length > pngBuffer.length);

  const zipChunks = [];
  const zipStream = new PassThrough();
  zipStream.on("data", (chunk) => zipChunks.push(chunk));
  const zipRes = await exportGeneratedLab(outputRoot, build.labId, {}, zipStream, {
    formats: ["docx", "html"],
  });
  assert.ok(zipRes.bytes > pngBuffer.length);
  assert.ok(Buffer.concat(zipChunks).length > pngBuffer.length);
});

test("generateLab supports opt-in captureScreenshots during initial lab creation", async (t) => {
  const outputRoot = tmpDir(t, "opt-in-capture-");
  const emptyLabsDir = tmpDir(t, "empty-labs-");
  const pngBuffer = fixturePng(128, 96, 303);

  const build = await generateLab(
    {
      products: ["copilot-studio"],
      features: ["mc-memory"],
      harness: "microsoft-copilot",
      includeCore: false,
      captureScreenshots: true,
    },
    {
      outputRoot,
      labsDir: emptyLabsDir,
      useLearnMcp: false,
      useLlm: false,
      screenshotDriver: async () => pngBuffer,
    },
  );

  assert.equal(build.status, "complete");
  assert.ok(build.screenshotCapture);
  assert.ok(build.screenshotCapture.capturedCount >= 1);
  assert.equal(build.manifest.screenshots.pending, 0);
  const renderedHtml = readFileSync(join(build.outputDir, "index.html"), "utf8");
  assert.match(renderedHtml, /data:image\/png;base64,/);
});

test("revalidateLabAgainstLearn detects Microsoft Learn doc updates and auto-updates drifted steps + screenshots", async (t) => {
  const outputRoot = tmpDir(t, "learn-drift-");
  const emptyLabsDir = tmpDir(t, "empty-labs-");
  const allFeatures = getFeatures();
  const createFeature = allFeatures.find((f) => f.id === "mc-create-agent");
  const memoryFeature = allFeatures.find((f) => f.id === "mc-memory");
  const createUrl = createFeature.docUrls[0];
  const primaryUrl = memoryFeature.docUrls[0];

  const createMarkdown = `# Create an agent in Copilot Studio

## Create your agent

1. Sign in to Copilot Studio and on the **Home** page select **Agents**, then select **New agent** to open the **Build** tab.
2. Enter a name for your agent in the name field at the top of the designer.
3. Open **Agent settings** if you need to adjust the solution or schema name before saving.
4. In the **Instructions** section, describe the agent's role, tone, and rules.
5. Select **Save** and confirm the **Build** tab displays knowledge, tools, skills, and memory components.`;

  const v1Markdown = `# Memory in Microsoft 365 Copilot agents

## Enable memory for an agent

1. Open your agent in Copilot Studio and select the **Build** tab.
2. In the components panel, turn on the **Memory** toggle.
3. On the **Preview** tab, tell the agent a preference and start a new conversation.
4. Ask for a summary in the new conversation and check whether the remembered preference is applied.
5. Open the memory portal link to **View memories** or **Delete all memories**.`;

  const v2Markdown = `# Memory in Microsoft 365 Copilot agents

## Enable memory and retention controls for an agent

1. Open your agent in Copilot Studio and select the **Build** tab.
2. In the components panel, turn on **Memory**, enable **Long-term user memory**, and choose **30-day retention**.
3. On the **Preview** tab, tell the agent a preference and start a new conversation.
4. Verify recall across conversations in chat and check the retention timestamp.
5. Open the memory portal link to **View memories** or **Delete all memories**.`;

  const initialPng = fixturePng(120, 80, 11);
  const refreshedPng = fixturePng(144, 96, 999);

  const build = await generateLab(
    {
      products: ["copilot-studio"],
      features: ["mc-memory"],
      harness: "microsoft-copilot",
      includeCore: false,
      captureScreenshots: true,
    },
    {
      outputRoot,
      labsDir: emptyLabsDir,
      useLearnMcp: true,
      connect: makeMockConnect({ [createUrl]: createMarkdown, [primaryUrl]: v1Markdown }),
      checkLink: async (url) => ({ url, status: 200, ok: true }),
      useLlm: false,
      screenshotDriver: async () => initialPng,
    },
  );

  assert.equal(build.status, "complete");

  // 1. Revalidate against unchanged v1 docs -> up-to-date!
  const checkSame = await revalidateLabAgainstLearn(outputRoot, build.labId, {
    capturedDir: ISOLATED_SHARED_SHOTS,
    connect: makeMockConnect({ [createUrl]: createMarkdown, [primaryUrl]: v1Markdown }),
    fetchDocPage: makeMockFetchDocPage({ [createUrl]: createMarkdown, [primaryUrl]: v1Markdown }),
    autoUpdate: false,
  });
  assert.equal(checkSame.status, 200);
  assert.equal(checkSame.body.overallStatus, "up-to-date");
  assert.equal(checkSame.body.counts.docsUpdated, 0);
  assert.ok(checkSame.body.modules.every((m) => m.status === "up-to-date"));

  // 2. Revalidate against updated v2 docs without autoUpdate -> reports docs-updated + diff summary!
  const checkDrift = await revalidateLabAgainstLearn(outputRoot, build.labId, {
    capturedDir: ISOLATED_SHARED_SHOTS,
    connect: makeMockConnect({ [createUrl]: createMarkdown, [primaryUrl]: v2Markdown }),
    fetchDocPage: makeMockFetchDocPage({ [createUrl]: createMarkdown, [primaryUrl]: v2Markdown }),
    autoUpdate: false,
  });
  assert.equal(checkDrift.status, 200);
  assert.equal(checkDrift.body.overallStatus, "docs-updated");
  assert.equal(checkDrift.body.counts.docsUpdated, 1);
  const memDriftReport = checkDrift.body.modules.find((m) => m.featureId === "mc-memory");
  assert.equal(memDriftReport.status, "docs-updated");
  assert.ok(memDriftReport.diff.stepChanged);
  assert.ok(
    checkDrift.body.state.shots.filter((s) => s.featureId === "mc-memory").every((s) => s.stale === true),
  );

  // 3. Revalidate with autoUpdate + autoCapture -> updates index.md steps, re-runs Playwright on stale shot, refreshes HTML & topic docs!
  let driverCalls = 0;
  const autoFix = await revalidateLabAgainstLearn(outputRoot, build.labId, {
    capturedDir: ISOLATED_SHARED_SHOTS,
    connect: makeMockConnect({ [createUrl]: createMarkdown, [primaryUrl]: v2Markdown }),
    fetchDocPage: makeMockFetchDocPage({ [createUrl]: createMarkdown, [primaryUrl]: v2Markdown }),
    autoUpdate: true,
    updateSteps: true,
    autoCapture: true,
    onlyStale: true,
    driver: async ({ shot }) => {
      driverCalls += 1;
      assert.equal(shot.featureId, "mc-memory", "only the drifted module shot is re-captured when onlyStale: true");
      assert.ok(
        shot.steps.some(
          (st) =>
            JSON.stringify(st).includes("30-day retention") ||
            JSON.stringify(st).includes("Long-term user memory"),
        ),
        "Playwright runner receives refreshed MS Learn step actions",
      );
      return refreshedPng;
    },
  });

  assert.equal(autoFix.status, 200);
  assert.ok(driverCalls >= 1);
  assert.deepEqual(autoFix.body.updatedModuleIds, ["mc-memory"]);
  assert.equal(autoFix.body.state.summary.stale, 0);
  assert.equal(autoFix.body.state.summary.learnSyncStatus, "up-to-date");

  const updatedMd = readFileSync(join(build.outputDir, "index.md"), "utf8");
  assert.match(updatedMd, /Long-term user memory/);
  assert.match(updatedMd, /30-day retention/);

  const updatedHtml = readFileSync(join(build.outputDir, "index.html"), "utf8");
  assert.match(updatedHtml, /30-day retention/);
  assert.match(updatedHtml, /data:image\/png;base64,/);

  const statusAfter = getLabScreenshotsStatus(outputRoot, build.labId, { capturedDir: ISOLATED_SHARED_SHOTS });
  assert.equal(statusAfter.status, 200);
  assert.equal(statusAfter.body.summary.stale, 0);
  assert.equal(statusAfter.body.summary.captured, statusAfter.body.summary.total);
});

test("captureLabScreenshots reports auth-required and browser-unavailable gracefully with local headed CLI command", async (t) => {
  const outputRoot = tmpDir(t, "graceful-status-");
  const emptyLabsDir = tmpDir(t, "empty-labs-");
  const build = await generateLab(
    { products: ["copilot-studio"], features: ["mc-memory"], harness: "microsoft-copilot", includeCore: false },
    { outputRoot, labsDir: emptyLabsDir, useLearnMcp: false, useLlm: false },
  );

  const authOutcome = await captureLabScreenshots(outputRoot, build.labId, {
    capturedDir: ISOLATED_SHARED_SHOTS,
    driver: async () => ({
      status: "auth-required",
      error: "Tenant sign-in is required at https://login.microsoftonline.com/.",
    }),
  });

  assert.equal(authOutcome.status, 200);
  assert.ok(authOutcome.body.capture.authRequiredCount >= 1);
  assert.match(
    authOutcome.body.capture.cliCommandHeaded,
    new RegExp(`capture\\.js --generated-lab=${build.labId} --headed`),
  );
  assert.equal(authOutcome.body.state.shots[0].lastAttemptStatus, "auth-required");

  const unavailableOutcome = await captureLabScreenshots(outputRoot, build.labId, {
    capturedDir: ISOLATED_SHARED_SHOTS,
    driver: async () => ({
      status: "browser-unavailable",
      error: "Playwright Chromium is not installed.",
    }),
  });
  assert.equal(unavailableOutcome.status, 200);
  assert.ok(unavailableOutcome.body.capture.browserUnavailableCount >= 1);
  assert.equal(unavailableOutcome.body.state.shots[0].lastAttemptStatus, "browser-unavailable");
});

test("HTTP endpoints serve screenshots manifest, guard /assets/:filename against path traversal, and run revalidation", async (t) => {
  const outputRoot = tmpDir(t, "server-shots-");
  const emptyLabsDir = tmpDir(t, "empty-labs-");
  const secretFile = join(outputRoot, "secret.png");
  const realPng = fixturePng(128, 96, 555);
  writeFileSync(secretFile, realPng);

  const build = await generateLab(
    { products: ["copilot-studio"], features: ["mc-memory"], harness: "microsoft-copilot", includeCore: false },
    { outputRoot, labsDir: emptyLabsDir, useLearnMcp: false, useLlm: false },
  );

  const shotsPlan = JSON.parse(readFileSync(join(build.outputDir, "screenshots", "shots.json"), "utf8"));
  const shotName = shotsPlan.shots[0].filename;
  for (const s of shotsPlan.shots) {
    writeFileSync(join(build.outputDir, "assets", s.filename), realPng);
  }

  // Direct unit checks on resolveGeneratedAsset traversal vectors
  for (const badName of [
    "../secret.png",
    "..\\secret.png",
    "sub/secret.png",
    ".env",
    "secret.txt",
    "foo..png",
    "a/../../secret.png",
  ]) {
    const res = resolveGeneratedAsset(outputRoot, build.labId, badName, { capturedDir: ISOLATED_SHARED_SHOTS });
    assert.equal(res.status, 400, `expected 400 for ${badName}`);
  }

  // Symlink escape inside assets/ must also be rejected if symlinks are allowed on this Windows host
  const symlinkPath = join(build.outputDir, "assets", "linked-secret.png");
  let symlinkCreated = false;
  try {
    symlinkSync(secretFile, symlinkPath);
    symlinkCreated = true;
  } catch {
    /* Windows without Developer Mode may disallow symlink creation for non-elevated users */
  }
  if (symlinkCreated) {
    const symRes = resolveGeneratedAsset(outputRoot, build.labId, "linked-secret.png", {
      capturedDir: ISOLATED_SHARED_SHOTS,
    });
    assert.equal(symRes.status, 400);
    rmSync(symlinkPath, { force: true });
  }

  // Boot the real Express server and test HTTP endpoints end-to-end
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
    },
    stdio: "ignore",
  });
  t.after(() => child.kill());
  await waitForServer(base, child);

  // 1. GET /api/lab-builder/generated/:labId/screenshots
  const statusRes = await fetch(`${base}/api/lab-builder/generated/${build.labId}/screenshots`);
  assert.equal(statusRes.status, 200);
  const statusBody = await statusRes.json();
  assert.equal(statusBody.labId, build.labId);
  assert.equal(statusBody.summary.captured, statusBody.summary.total);

  // 2. GET /api/lab-builder/generated/:labId/assets/:filename (valid PNG)
  const assetRes = await fetch(`${base}/api/lab-builder/generated/${build.labId}/assets/${shotName}`);
  assert.equal(assetRes.status, 200);
  assert.equal(assetRes.headers.get("content-type"), "image/png");
  const servedBytes = Buffer.from(await assetRes.arrayBuffer());
  assert.equal(servedBytes.length, realPng.length);

  // 3. Path traversal probes over HTTP must never return 200 or leak secret.png
  for (const probe of [
    `%2e%2e%2fsecret.png`,
    `..%5csecret.png`,
    `sub/secret.png`,
    `foo..png`,
    `index.md`,
  ]) {
    const badRes = await fetch(`${base}/api/lab-builder/generated/${build.labId}/assets/${probe}`);
    assert.equal(badRes.status, 400, `probe ${probe} should fail with 400`);
  }

  // 4. Invalid labId traversal on /screenshots
  const badLabRes = await fetch(`${base}/api/lab-builder/generated/bad..lab/screenshots`);
  assert.equal(badLabRes.status, 400);
});
