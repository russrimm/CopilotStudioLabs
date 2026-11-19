/**
 * Screenshot capture platform: Local Capture Companion pairing, the persisted job
 * queue, strict upload verification, paste/upload/retake, the persistent shared
 * library, honest status, and the older capture endpoints.
 *
 * Hermetic: no real tenant and no browser. A fake companion talks to the real
 * portal server over real HTTP.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import express from "express";

import { generateLab } from "../lib/lab-builder/generator.js";
import { capturedImage, capturedScreenshotsDir, capturedScreenshotsDirs, resolveLabScreenshot } from "../lib/lab-builder/captured.js";
import { captureLabScreenshots, derivePlaywrightSteps, getLabScreenshotsStatus, revalidateLabAgainstLearn } from "../lib/lab-builder/lab-screenshots.js";
import { PLACEHOLDER_PATH } from "../lib/lab-builder/slots.js";
import { createBlobPersistence, MANAGED_BLOB_PREFIXES, resolveSafeBlobLocalPath } from "../lib/blob-persistence.js";
import {
  BAKED_CAPTURED_SCREENSHOTS_DIR,
  ensurePortalStorageDirs,
  getStorageDiagnostics,
  resolveCapturedScreenshotsDir,
  resolveCapturedScreenshotsSearchDirs,
} from "../lib/storage-config.js";
import { isCaptureCompanionRequest } from "../lib/require-auth.js";
import { createProfile } from "../lib/branding-profiles.js";
import { createJobStore, normalizeJobRequest, validateCaptureEnv } from "../lib/capture/jobs.js";
import { createPairingStore, normalizePairingCode } from "../lib/capture/pairing.js";
import { buildLabJobPlan, buildLibraryJobPlan, sanitizePlanSteps } from "../lib/capture/plan.js";
import { buildCompanionZip, COMPANION_FILES, COMPANION_LAUNCHER } from "../lib/capture/companion-zip.js";
import { registerCaptureRoutes } from "../lib/capture/routes.js";
import { isSafeUploadFilename, MAX_UPLOAD_BYTES, verifyUpload } from "../lib/capture/verify-upload.js";
import { makeJpeg, makePng, makeWebp, pngChunk } from "../../tools/screenshot-capture/test/fixtures/png.mjs";
import { createFakePlaywright } from "../../tools/screenshot-capture/test/fixtures/fake-playwright.mjs";
import { createPortalClient, runJob } from "../../tools/screenshot-capture/companion.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PORTAL_ROOT = resolve(here, "..");
const REPO_ROOT = resolve(PORTAL_ROOT, "..");
const cleanups = [];

function tmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
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

async function startPortal({ storageRoot, auth = false, env = {} }) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let stderr = "";
  const child = spawn(process.execPath, ["server.js"], {
    cwd: PORTAL_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      PORTAL_AUTH_DISABLED: auth ? "" : "true",
      ...(auth ? { AZURE_TENANT_ID: "00000000-0000-0000-0000-000000000000", PORTAL_API_AUDIENCE: "api://capture-test" } : {}),
      AZURE_KEYVAULT_URL: "",
      PORTAL_STORAGE_ROOT: storageRoot,
      FEATURE_TOUR_SCREENSHOTS_DIR: "",
      LAB_BUILDER_LINK_CHECK: "off",
      LAB_BUILDER_LLM: "off",
      ...env,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  cleanups.push(() => child.kill());
  const deadline = Date.now() + 20000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}): ${stderr.slice(-800)}`);
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("server did not start in time");
    await new Promise((r) => setTimeout(r, 120));
  }
  return { base, child, port };
}

async function call(base, method, path, { json, body, headers = {}, token, form } = {}) {
  const init = { method, headers: { ...headers } };
  if (token) init.headers.Authorization = `Bearer ${token}`;
  if (json !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(json);
  } else if (form) {
    init.body = form;
  } else if (body !== undefined) {
    init.body = body;
  }
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: res.status, json: parsed, text, headers: res.headers };
}

function png(bytes, type = "image/png") {
  return { body: bytes, headers: { "Content-Type": type } };
}

function readZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i += 1) {
    assert.equal(buf.readUInt32LE(off), 0x02014b50);
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nlen = buf.readUInt16LE(off + 28);
    const elen = buf.readUInt16LE(off + 30);
    const clen = buf.readUInt16LE(off + 32);
    const local = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nlen);
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(dataStart, dataStart + csize);
    entries.set(name, method === 8 ? zlib.inflateRawSync(data) : data);
    off += 46 + nlen + elen + clen;
  }
  return entries;
}

/** Drives the companion endpoints exactly as the real companion does. */
class FakeCompanion {
  constructor(base) {
    this.base = base;
    this.token = null;
  }

  async pair(code, extra = {}) {
    const res = await call(this.base, "POST", "/api/capture/companion/pair", { json: { code, deviceName: "TEST-PC", platform: "win32", companionVersion: "1.0.0", ...extra } });
    if (res.status === 201) this.token = res.json.token;
    return res;
  }

  heartbeat(body = {}) {
    return call(this.base, "POST", "/api/capture/companion/heartbeat", { token: this.token, json: { signedInProducts: ["copilot-studio"], ...body } });
  }

  next() {
    return call(this.base, "GET", "/api/capture/companion/next", { token: this.token });
  }

  progress(jobId, body) {
    return call(this.base, "POST", `/api/capture/companion/jobs/${jobId}/progress`, { token: this.token, json: body });
  }

  upload(jobId, filename, bytes, evidence, { multipart = true } = {}) {
    const path = `/api/capture/companion/jobs/${jobId}/shots/${encodeURIComponent(filename)}`;
    if (!multipart) {
      return call(this.base, "PUT", path, { token: this.token, body: bytes, headers: { "Content-Type": "image/png", "X-Capture-Evidence": Buffer.from(JSON.stringify(evidence)).toString("base64url") } });
    }
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: "image/png" }), filename);
    form.append("evidence", JSON.stringify(evidence));
    return call(this.base, "PUT", path, { token: this.token, form });
  }

  complete(jobId, body = { message: "done" }) {
    return call(this.base, "POST", `/api/capture/companion/jobs/${jobId}/complete`, { token: this.token, json: body });
  }
}

/** The address a correct screenshot of this shot would be taken at, from what the plan expects. */
function addressFor(shot) {
  const expect = shot.capture?.expect;
  if (expect?.family === "copilot-studio") {
    const base = "https://copilotstudio.microsoft.com/environments/abc";
    return expect.scope === "agent" ? `${base}/bots/def/${expect.paths[0]}` : `${base}/${expect.paths[0]}`;
  }
  if (expect?.family === "url" && expect.host) return `https://${expect.host}/`;
  return "https://copilotstudio.microsoft.com/environments/abc/bots";
}

function goodEvidence(shot) {
  return {
    finalUrl: `${addressFor(shot)}?token=SECRET#frag`,
    title: "Copilot Studio",
    visibleText: shot.expectedLabels?.length ? shot.expectedLabels : ["Settings"],
    redaction: { applied: true, masked: 2 },
    capturedAt: new Date().toISOString(),
    executedSteps: 5,
  };
}

async function buildLab(generatedRoot, emptyLabs) {
  const build = await generateLab(
    { products: ["copilot-studio"], features: ["mc-memory"], harness: "microsoft-copilot", includeCore: false },
    { outputRoot: generatedRoot, labsDir: emptyLabs, useLearnMcp: false, useLlm: false },
  );
  const shots = JSON.parse(readFileSync(join(build.outputDir, "screenshots", "shots.json"), "utf8")).shots;
  return { labId: build.labId, labDir: build.outputDir, shots };
}

const ctx = {};

before(async () => {
  ctx.root = tmp("capture-platform-");
  ctx.storageRoot = join(ctx.root, "storage");
  ctx.generatedRoot = join(ctx.storageRoot, "generated-labs");
  ctx.dataDir = join(ctx.storageRoot, "data");
  mkdirSync(ctx.generatedRoot, { recursive: true });
  const emptyLabs = tmp("capture-empty-labs-");
  ctx.emptyLabs = emptyLabs;
  ctx.lab = await buildLab(ctx.generatedRoot, emptyLabs);
  ctx.lab2 = await buildLab(ctx.generatedRoot, emptyLabs);
  ctx.lab3 = await buildLab(ctx.generatedRoot, emptyLabs);
  assert.notEqual(ctx.lab.labId, ctx.lab2.labId);
  assert.ok(ctx.lab.shots.length >= 2, "the fixture lab needs two shots");
  ctx.server = await startPortal({ storageRoot: ctx.storageRoot });
  ctx.base = ctx.server.base;
});

after(() => {
  for (const fn of cleanups.reverse()) {
    try {
      fn();
    } catch {
      /* best effort */
    }
  }
});

// ── Upload verification ──────────────────────────────────────────────────────

test("verifyUpload passes a real screenshot and decides everything from the bytes", () => {
  const ok = verifyUpload({ bytes: makePng({ mode: "ui" }), filename: "shot.png" });
  assert.equal(ok.level, "pass");
  assert.equal(ok.ok, true);
  assert.deepEqual([ok.format, ok.width, ok.height], ["png", 320, 200]);
  assert.match(ok.sha256, /^[a-f0-9]{64}$/);
  assert.equal(verifyUpload({ bytes: makeJpeg(), filename: "shot.jpg" }).level, "pass");
  assert.equal(verifyUpload({ bytes: makeWebp(), filename: "shot.webp" }).level, "pass");
});

test("verifyUpload rejects bad magic bytes, disguised SVG and HTML, wrong extensions, and corrupt files", () => {
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`.padEnd(9000, " "));
  const html = Buffer.from(`<!doctype html><script>alert(1)</script>`.padEnd(9000, " "));
  for (const bytes of [svg, html, Buffer.from("not an image".repeat(900)), Buffer.alloc(9000)]) {
    const result = verifyUpload({ bytes, filename: "shot.png" });
    assert.equal(result.level, "fail");
    assert.equal(result.reasons[0].code, "bad-signature");
  }
  assert.equal(verifyUpload({ bytes: makeJpeg(), filename: "shot.png" }).reasons[0].code, "extension-mismatch");
  assert.equal(verifyUpload({ bytes: makePng(), filename: "shot.jpg" }).reasons[0].code, "extension-mismatch");

  const corrupt = makePng();
  corrupt[40] ^= 0xff;
  assert.equal(verifyUpload({ bytes: corrupt, filename: "shot.png" }).reasons[0].code, "corrupt");
  assert.ok(verifyUpload({ bytes: makePng({ trailing: Buffer.from("<script>x</script>") }), filename: "shot.png" }).reasons.some((r) => r.code === "trailing-data"));
  const markup = makePng({ extraChunks: [pngChunk("tEXt", Buffer.from("Comment\0<script>alert(1)</script>"))] });
  assert.ok(verifyUpload({ bytes: markup, filename: "shot.png" }).reasons.some((r) => r.code === "embedded-markup"));
});

test("verifyUpload enforces the size cap, minimum size, and dimension limits", () => {
  const huge = Buffer.concat([makePng().subarray(0, 8), Buffer.alloc(MAX_UPLOAD_BYTES)]);
  assert.equal(verifyUpload({ bytes: huge, filename: "shot.png" }).reasons[0].code, "too-large");
  assert.equal(verifyUpload({ bytes: makePng({ width: 4, height: 4 }), filename: "shot.png" }).reasons[0].code, "too-small");
  assert.ok(verifyUpload({ bytes: makePng({ width: 100, height: 60 }), filename: "shot.png" }).reasons.some((r) => r.code === "dimensions-small"));
  assert.ok(verifyUpload({ bytes: makeJpeg({ width: 12000, height: 400 }), filename: "shot.jpg" }).reasons.some((r) => r.code === "dimensions-large"));
});

test("verifyUpload detects blank and near-uniform images", () => {
  const blank = verifyUpload({ bytes: makePng({ mode: "blank", width: 640, height: 400 }), filename: "shot.png" });
  assert.equal(blank.level, "fail");
  assert.equal(blank.reasons[0].code, "blank");
  const mostly = verifyUpload({ bytes: makePng({ mode: "mostly" }), filename: "shot.png" });
  assert.equal(mostly.level, "warn");
  assert.equal(mostly.reasons[0].code, "near-uniform");
});

test("verifyUpload rejects Microsoft sign-in pages from the reported address, title, or text", () => {
  const bytes = makePng({ mode: "ui" });
  for (const finalUrl of [
    "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x",
    "https://login.live.com/login.srf",
    "https://login.windows.net/tenant/oauth2/authorize",
    "https://LOGIN.MICROSOFTONLINE.COM/",
  ]) {
    const result = verifyUpload({ bytes, filename: "shot.png", evidence: { finalUrl, title: "Copilot Studio" } });
    assert.equal(result.level, "fail", finalUrl);
    assert.equal(result.reasons[0].code, "sign-in-page");
  }
  assert.equal(verifyUpload({ bytes, filename: "shot.png", evidence: { finalUrl: "https://copilotstudio.microsoft.com/", title: "Sign in to your account" } }).reasons[0].code, "sign-in-page");
  assert.equal(verifyUpload({ bytes, filename: "shot.png", evidence: { finalUrl: "https://copilotstudio.microsoft.com/", visibleText: ["Pick an account", "Use another account"] } }).reasons[0].code, "sign-in-page");
  assert.equal(verifyUpload({ bytes, filename: "shot.png", evidence: { finalUrl: "about:blank" } }).reasons[0].code, "not-a-web-page");
  // Evidence can add failures but never remove one: a good address does not rescue a blank image.
  const rescued = verifyUpload({ bytes: makePng({ mode: "blank", width: 640, height: 400 }), filename: "shot.png", evidence: { finalUrl: "https://copilotstudio.microsoft.com/" } });
  assert.equal(rescued.level, "fail");
});

test("verifyUpload scores UI labels, strips query strings, and warns on missing redaction", () => {
  const bytes = makePng({ mode: "ui" });
  const good = verifyUpload({
    bytes,
    filename: "shot.png",
    expectedLabels: ["Settings", "Memory"],
    requireEvidence: true,
    requireRedaction: true,
    evidence: { finalUrl: "https://copilotstudio.microsoft.com/a?token=SECRET#x", title: "Copilot Studio", visibleText: ["Settings", "Memory", "Home"], redaction: { applied: true, masked: 1 } },
  });
  assert.equal(good.level, "pass");
  assert.equal(good.labels.score, 1);
  assert.equal(good.evidence.finalUrl, "https://copilotstudio.microsoft.com/a");
  assert.ok(!JSON.stringify(good).includes("SECRET"));

  const low = verifyUpload({ bytes, filename: "shot.png", expectedLabels: ["Settings", "Memory", "Topics"], evidence: { finalUrl: "https://copilotstudio.microsoft.com/", visibleText: ["Home"], redaction: { applied: true } } });
  assert.equal(low.level, "warn");
  assert.ok(low.reasons.some((r) => r.code === "labels-missing"));
  assert.equal(low.labels.score, 0);

  const unredacted = verifyUpload({ bytes, filename: "shot.png", requireRedaction: true, evidence: { finalUrl: "https://copilotstudio.microsoft.com/", visibleText: [] } });
  assert.ok(unredacted.reasons.some((r) => r.code === "not-redacted"));
  assert.ok(verifyUpload({ bytes, filename: "shot.png", requireEvidence: true }).reasons.some((r) => r.code === "no-evidence"));
});

test("upload file names follow the screenshot allowlist and never traverse", () => {
  for (const name of ["shot.png", "A-b_c.1.jpg", "x.webp", "mc-memory-toggle.png"]) assert.equal(isSafeUploadFilename(name), true, name);
  for (const name of ["../x.png", "..\\x.png", "a/b.png", "a\\b.png", "x.gif", "x.svg", "x.png.exe", ".hidden.png", "x\0.png", "", `${"a".repeat(130)}.png`, "foo..png.txt"]) {
    assert.equal(isSafeUploadFilename(name), false, JSON.stringify(name));
  }
  assert.equal(verifyUpload({ bytes: makePng(), filename: "../x.png" }).reasons[0].code, "bad-filename");
});

// ── Pairing ──────────────────────────────────────────────────────────────────

test("pairing codes are one-time, expire, and only hashes are stored", () => {
  const dir = tmp("pairing-");
  let clock = 1_700_000_000_000;
  const store = createPairingStore({ dir, now: () => clock });
  const issued = store.createCode({ createdBy: "user@contoso.com" });
  assert.match(issued.code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.equal(issued.expiresInSec, 600);

  const paired = store.exchangeCode(issued.code.toLowerCase().replace("-", " "), { deviceName: "Laptop", platform: "darwin", companionVersion: "1.0.0" });
  assert.equal(paired.ok, true);
  assert.match(paired.token, /^cap_[A-Za-z0-9_-]{40,}$/);
  assert.equal(paired.device.name, "Laptop");
  assert.equal(store.exchangeCode(issued.code).reason, "invalid", "a code works once");

  const stored = readFileSync(join(dir, "devices.json"), "utf8");
  assert.ok(!stored.includes(paired.token), "the token is never stored");
  assert.ok(!stored.includes(normalizePairingCode(issued.code)), "the code is never stored");
  assert.ok(stored.includes("tokenHash"));

  const second = store.createCode();
  clock += 11 * 60 * 1000;
  assert.equal(store.exchangeCode(second.code).reason, "expired");
  assert.equal(store.exchangeCode(second.code).reason, "invalid", "an expired code is deleted too");
});

test("capture tokens authenticate, revoke, expire, and extend while in use", () => {
  const dir = tmp("pairing-auth-");
  let clock = 1_700_000_000_000;
  const day = 24 * 60 * 60 * 1000;
  const store = createPairingStore({ dir, now: () => clock, tokenTtlMs: 10 * day });
  const { token, device } = store.exchangeCode(store.createCode().code, { deviceName: "PC" });
  assert.equal(store.authenticate(token).ok, true);
  assert.equal(store.authenticate("").reason, "missing");
  assert.equal(store.authenticate("cap_notatoken").reason, "invalid");
  assert.equal(store.authenticate("Bearer-ish").reason, "invalid");
  assert.equal(store.authenticate(`${token}x`).reason, "invalid");

  clock += 6 * day;
  const before = store.authenticate(token).device.expiresAt;
  clock += 1 * day;
  assert.ok(store.authenticate(token).device.expiresAt >= before, "use extends the token");
  clock += 11 * day;
  assert.equal(store.authenticate(token).reason, "expired");

  clock = 1_700_000_000_000;
  const fresh = store.exchangeCode(store.createCode().code, { deviceName: "PC2" });
  assert.equal(store.revokeDevice(fresh.device.id), true);
  assert.equal(store.authenticate(fresh.token).reason, "revoked");
  assert.equal(store.revokeDevice(fresh.device.id), false);
  assert.equal(store.revokeDevice("dev_missing"), false);
  assert.equal(store.listDevices().some((d) => d.id === fresh.device.id), false);
  assert.ok(device.id.startsWith("dev_"));
});

test("repeated wrong pairing codes lock the exchange", () => {
  const store = createPairingStore({ dir: tmp("pairing-lock-"), now: () => 1_700_000_000_000 });
  const real = store.createCode().code;
  for (let i = 0; i < 15; i += 1) assert.equal(store.exchangeCode("WRONG-CODE").reason, "invalid");
  const locked = store.exchangeCode(real);
  assert.equal(locked.reason, "locked");
  assert.ok(locked.retryAfterSec > 0);
});

test("companion heartbeat drives connected status, last seen, and signed-in products", () => {
  let clock = 1_700_000_000_000;
  const store = createPairingStore({ dir: tmp("pairing-status-"), now: () => clock });
  assert.equal(store.status().connected, false);
  const { device } = store.exchangeCode(store.createCode().code, { deviceName: "PC" });
  assert.equal(store.status().connected, false, "paired but never seen");
  store.heartbeat(device.id, { signedInProducts: ["copilot-studio", "bad product!", "sharepoint-ai"], busy: false, companionVersion: "1.2.3" });
  let status = store.status();
  assert.equal(status.connected, true);
  assert.deepEqual(status.signedInProducts, ["copilot-studio", "sharepoint-ai"]);
  assert.equal(status.devices[0].companionVersion, "1.2.3");
  store.heartbeat(device.id, { busy: true });
  assert.deepEqual(store.status().signedInProducts, ["copilot-studio", "sharepoint-ai"], "omitted fields keep their last value");
  clock += 2 * 60 * 1000;
  status = store.status();
  assert.equal(status.connected, false);
  assert.ok(status.lastSeenAt);
});

// ── Jobs ─────────────────────────────────────────────────────────────────────

test("capture environment accepts only CAPTURE_* https addresses", () => {
  assert.equal(validateCaptureEnv({ CAPTURE_SHAREPOINT_SITE_URL: "https://contoso.sharepoint.com/sites/x" }).ok, true);
  for (const env of [
    { CAPTURE_X: "http://insecure.example.com" },
    { CAPTURE_X: "https://user:pw@example.com/" },
    { CAPTURE_X: "javascript:alert(1)" },
    { CAPTURE_X: "https://exa mple.com" },
    { PATH: "https://example.com" },
    { capture_x: "https://example.com" },
    { CAPTURE_X: 5 },
  ]) {
    assert.equal(validateCaptureEnv(env).ok, false, JSON.stringify(env));
  }
  assert.equal(normalizeJobRequest({ target: { type: "lab", labId: "x" }, scope: "bogus" }).ok, false);
  assert.equal(normalizeJobRequest({ target: { type: "lab", labId: "../x" } }).ok, false);
  assert.equal(normalizeJobRequest({ target: { type: "library" }, scope: { mode: "selected" } }).ok, false);
  assert.equal(normalizeJobRequest({ target: { type: "library", products: ["ai-foundry"] }, scope: { mode: "missing" }, options: { callouts: "burn" } }).ok, true);
});

function planShots(names) {
  return { shots: names.map((filename, i) => ({ filename, shotId: `s${i}`, featureId: "f", product: "copilot-studio", steps: [], expectedLabels: [] })) };
}

test("job queue lifecycle persists claim, progress, results, events, and completion", () => {
  const dir = tmp("jobs-");
  let clock = 1_700_000_000_000;
  const store = createJobStore({ dir, now: () => clock });
  const job = store.create({ target: { type: "lab", labId: "lab-a" }, scope: { mode: "missing", filenames: [], featureIds: [] }, env: { CAPTURE_A_URL: "https://a.example.com" }, options: { callouts: "sidecar", redact: true }, plan: planShots(["a.png", "b.png"]), createdBy: "me@contoso.com" });
  assert.equal(job.status, "queued");
  assert.deepEqual(job.envNames, ["CAPTURE_A_URL"]);
  assert.equal(job.progress.total, 2);
  assert.ok(!JSON.stringify(job).includes("a.example.com"), "env values stay out of the job");
  assert.equal(store.getPlan(job.id).env.CAPTURE_A_URL, "https://a.example.com");

  const device = { id: "dev_aaaaaaaaaaaa", name: "PC" };
  const claimed = store.claimNext(device);
  assert.equal(claimed.job.status, "claimed");
  assert.equal(claimed.resumed, false);
  assert.equal(store.claimNext({ id: "dev_bbbbbbbbbbbb", name: "Other" }), null, "one job, one companion");
  assert.equal(store.claimNext(device).resumed, true, "a restarted companion resumes its own job");

  assert.equal(store.reportProgress(job.id, "dev_bbbbbbbbbbbb", { message: "x" }).status, 409);
  const running = store.reportProgress(job.id, device.id, { shot: { filename: "a.png", status: "running", message: "Capturing" } });
  assert.equal(running.job.status, "running");
  assert.equal(running.job.progress.running, 1);
  store.recordShotResult(job.id, device.id, "a.png", { status: "captured", verification: { level: "pass" }, message: "ok" });
  store.recordShotResult(job.id, device.id, "b.png", { status: "failed", error: "blank" });
  assert.equal(store.recordShotResult(job.id, device.id, "nope.png", { status: "captured" }).status, 404);

  const done = store.complete(job.id, device.id, { message: "bye" });
  assert.equal(done.job.status, "done");
  assert.equal(done.job.result.captured, 1);
  assert.equal(done.job.result.failed, 1);
  assert.equal(done.job.result.partial, true);
  assert.equal(done.job.progress.percent, 100);
  assert.ok(done.job.finishedAt);
  assert.ok(done.job.events.length >= 5);
  assert.equal(store.complete(job.id, device.id).status, 409, "a finished job cannot be completed twice");

  const reopened = createJobStore({ dir, now: () => clock });
  assert.equal(reopened.get(job.id).status, "done", "jobs survive a restart");
  assert.equal(reopened.list().length, 1);
  assert.equal(reopened.get("job_0000000000000000"), null);
  assert.equal(reopened.get("../../etc/passwd"), null);
});

test("job cancel stops a queued job now and a running job between shots; stale claims expire", () => {
  let clock = 1_700_000_000_000;
  const store = createJobStore({ dir: tmp("jobs-cancel-"), now: () => clock, claimStaleMs: 60_000 });
  const spec = { target: { type: "lab", labId: "lab-a" }, scope: { mode: "all", filenames: [], featureIds: [] }, options: {}, plan: planShots(["a.png", "b.png"]) };
  const queued = store.create(spec);
  const cancelled = store.cancel(queued.id);
  assert.equal(cancelled.job.status, "cancelled");
  assert.ok(cancelled.job.shots.every((s) => s.status === "cancelled"));
  assert.equal(store.cancel(queued.id).status, 409);
  assert.equal(store.claimNext({ id: "dev_aaaaaaaaaaaa", name: "PC" }), null);

  const running = store.create(spec);
  const device = { id: "dev_aaaaaaaaaaaa", name: "PC" };
  store.claimNext(device);
  store.recordShotResult(running.id, device.id, "a.png", { status: "captured" });
  const asked = store.cancel(running.id);
  assert.equal(asked.job.cancelRequested, true);
  assert.equal(asked.job.status, "running");
  assert.equal(store.reportProgress(running.id, device.id, { message: "still here" }).cancelRequested, true);
  const finished = store.complete(running.id, device.id, {});
  assert.equal(finished.job.status, "cancelled");
  assert.deepEqual(finished.job.shots.map((s) => s.status), ["captured", "cancelled"]);

  const abandoned = store.create(spec);
  store.claimNext(device);
  clock += 2 * 60_000;
  const expired = store.get(abandoned.id);
  assert.equal(expired.status, "failed");
  assert.match(expired.error, /stopped responding/);
  const old = store.create(spec);
  clock += 25 * 60 * 60 * 1000;
  assert.equal(store.get(old.id).status, "failed");
});

// ── Shot plans ───────────────────────────────────────────────────────────────

test("shot plans carry safe steps, expected labels, and mark shots that need a tenant address", () => {
  const everything = { mode: "all", filenames: [], featureIds: [] };
  const sharepoint = buildLibraryJobPlan({ scope: everything, products: ["sharepoint-ai"], capturedDir: [] });
  assert.ok(sharepoint.shots.length > 20);
  const site = sharepoint.shots.find((s) => s.section === "sharepoint-site");
  assert.equal(site.requiresEnv, "CAPTURE_SHAREPOINT_SITE_URL", "a tenant-only section needs its address");
  assert.ok(sharepoint.shots.some((s) => s.manual), "terminal shots are marked manual");
  assert.ok(sharepoint.shots.every((s) => s.authProfile === "sharepoint-ai"));
  const copilotStudio = buildLibraryJobPlan({ scope: everything, products: ["copilot-studio"], capturedDir: [] });
  // A public page needs no address; an agent screen needs the agent (older companions are told which variable).
  assert.ok(copilotStudio.shots.every((s) => s.requiresEnv === null || s.requiresEnv === "CAPTURE_COPILOT_STUDIO_AGENT_URL"));
  assert.ok(copilotStudio.shots.filter((s) => s.section === "home").every((s) => s.requiresEnv === null), "a public start page is never a requirement");

  for (const shot of [...sharepoint.shots, ...copilotStudio.shots]) {
    assert.ok(shot.steps.every((s) => ["navigate", "waitForLoadState", "dismissBanners", "stepThrough", "click", "clickBestEffort", "probeControl", "probeCallouts", "screenshot"].includes(s.action)));
    assert.ok(shot.steps.filter((s) => s.action === "navigate").every((s) => /^https:\/\//.test(s.url)));
    assert.ok(shot.steps.at(-1).action === "screenshot");
  }
  assert.ok(copilotStudio.shots.some((s) => s.callouts.length && s.expectedLabels.length), "callout text becomes expected labels");

  const missing = buildLibraryJobPlan({ scope: { mode: "missing", filenames: [], featureIds: [] }, products: ["ai-foundry"], capturedDir: [] });
  const selected = buildLibraryJobPlan({ scope: { mode: "selected", filenames: [missing.shots[0].filename], featureIds: [] }, products: ["ai-foundry"], capturedDir: [] });
  assert.deepEqual(selected.shots.map((s) => s.filename), [missing.shots[0].filename]);
  const lab = buildLabJobPlan({ generatedRoot: ctx.generatedRoot, labId: ctx.lab.labId, scope: { mode: "missing", filenames: [], featureIds: [] }, capturedDir: [] });
  assert.equal(lab.status, 200);
  assert.ok(lab.shots.length >= 2 && lab.shots.every((s) => s.requiresEnv === null || s.requiresEnv === "CAPTURE_COPILOT_STUDIO_AGENT_URL"));
  assert.equal(buildLabJobPlan({ generatedRoot: ctx.generatedRoot, labId: "no-such-lab", scope: everything }).status, 404);
  assert.equal(buildLabJobPlan({ generatedRoot: ctx.generatedRoot, labId: "../x", scope: everything }).status, 400);

  const cleaned = sanitizePlanSteps([
    { action: "navigate", url: "javascript:alert(1)" },
    { action: "navigate", url: "http://insecure.example.com" },
    { action: "navigate", url: "https://ok.example.com", waitUntil: "bogus" },
    { action: "type", text: "x" },
    { action: "evaluate", script: "1" },
    { action: "stepThrough", labels: ["A".repeat(500)], roles: ["button", "shell"], interaction: "hack" },
  ]);
  assert.deepEqual(cleaned.map((s) => s.action), ["navigate", "stepThrough"]);
  assert.equal(cleaned[0].waitUntil, "domcontentloaded");
  assert.equal(cleaned[1].labels[0].length, 80);
  assert.deepEqual(cleaned[1].roles, ["button"]);
  assert.equal(cleaned[1].interaction, undefined);
});
// ── A job that ended without a sign-in ───────────────────────────────────────

test("a job whose shots ended waiting for a sign-in says what to do and is not handed out again and again", () => {
  let clock = 1_700_000_000_000;
  const store = createJobStore({ dir: tmp("jobs-signin-"), now: () => clock, productLabel: (id) => ({ "copilot-studio": "Microsoft Copilot Studio", "ai-foundry": "Microsoft Foundry" })[id] || id });
  const spec = { target: { type: "lab", labId: "lab-a" }, scope: { mode: "all", filenames: [], featureIds: [] }, options: {}, plan: { shots: [{ filename: "a.png", product: "copilot-studio", steps: [] }, { filename: "b.png", product: "copilot-studio", steps: [] }, { filename: "c.png", product: "ai-foundry", steps: [] }] } };
  const device = { id: "dev_aaaaaaaaaaaa", name: "PC" };
  const message = "Sign in to Microsoft Copilot Studio on your computer, then retry the 2 screenshots.";

  // Nothing was captured: the job says to sign in, not that the computer stopped.
  const job = store.create({ ...spec, plan: { shots: spec.plan.shots.slice(0, 2) } });
  store.claimNext(device);
  for (const name of ["a.png", "b.png"]) store.reportProgress(job.id, device.id, { shot: { filename: name, status: "auth-required", error: message } });
  const failed = store.complete(job.id, device.id, { message: "0 captured" }).job;
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, message, "the Screenshot Center shows this instead of the generic 'stopped before any screenshot'");
  assert.deepEqual(failed.needsSignIn, { count: 2, products: [{ id: "copilot-studio", label: "Microsoft Copilot Studio", count: 2 }], message });
  assert.deepEqual(failed.shots.map((s) => [s.status, s.error]), [["auth-required", message], ["auth-required", message]], "each shot keeps the message");
  assert.deepEqual(failed.result.needsSignIn.products.map((p) => p.id), ["copilot-studio"]);
  assert.equal(store.list()[0].needsSignIn.count, 2, "the job list carries it too");
  assert.equal(store.claimNext(device), null, "an ended job is never handed out again");

  // Some shots were captured: the job is done, and still says what is left.
  clock += 1000;
  const partial = store.create(spec);
  store.claimNext(device);
  store.recordShotResult(partial.id, device.id, "a.png", { status: "captured" });
  store.reportProgress(partial.id, device.id, { shot: { filename: "b.png", status: "auth-required", error: "x" } });
  store.reportProgress(partial.id, device.id, { shot: { filename: "c.png", status: "auth-required", error: "x" } });
  const done = store.complete(partial.id, device.id, {}).job;
  assert.equal(done.status, "done");
  assert.match(done.needsSignIn.message, /^Sign in to Microsoft Copilot Studio and Microsoft Foundry on your computer, then retry the 2 screenshots\.$/);
  assert.match(done.events.at(-1).message, /Sign in to Microsoft Copilot Studio and Microsoft Foundry/);

  // The need goes away when the companion reports the sign-in, and old needs expire.
  assert.equal(store.latestSignInNeed({ signedInProducts: [] }).jobId, partial.id, "the newest job with a need wins");
  assert.deepEqual(store.latestSignInNeed({ signedInProducts: ["copilot-studio"] }).products.map((p) => p.id), ["ai-foundry"]);
  assert.equal(store.latestSignInNeed({ signedInProducts: ["ai-foundry"] }).message, "Sign in to Microsoft Copilot Studio on your computer, then retry the 1 screenshot.");
  assert.equal(store.latestSignInNeed({ signedInProducts: ["copilot-studio", "ai-foundry"] }), null);
  clock += 25 * 60 * 60 * 1000;
  assert.equal(store.latestSignInNeed({ signedInProducts: [] }), null, "a day later nobody is waiting");

  // A companion that keeps asking for the same job without finishing a shot is stopped, not served forever.
  const stuck = store.create({ ...spec, plan: { shots: [{ filename: "a.png", product: "copilot-studio", steps: [] }, { filename: "b.png", product: "copilot-studio", steps: [] }] } });
  assert.equal(store.claimNext(device).resumed, false);
  for (let i = 0; i < 3; i += 1) {
    assert.equal(store.claimNext(device).resumed, true);
    clock += 1000;
  }
  assert.equal(store.claimNext(device), null, "after three resumes with no progress the job is closed");
  const closed = store.get(stuck.id);
  assert.equal(closed.status, "failed");
  assert.match(closed.error, /picked this job up several times without finishing it/);
  assert.ok(closed.shots.every((s) => s.status === "cancelled"));

  // Progress resets the count, so a companion that restarts between shots is never cut off.
  const steady = store.create({ ...spec, plan: { shots: ["a.png", "b.png", "c.png", "d.png", "e.png"].map((filename) => ({ filename, product: "copilot-studio", steps: [] })) } });
  store.claimNext(device);
  for (const name of ["a.png", "b.png", "c.png", "d.png"]) {
    assert.equal(store.claimNext(device).resumed, true);
    store.recordShotResult(steady.id, device.id, name, { status: "captured" });
  }
  assert.equal(store.get(steady.id).status, "running", "four restarts in a row, each after progress, are fine");
});

test("the portal status says which products still need a sign-in until the companion reports them signed in", async (t) => {
  const storageRoot = tmp("capture-signin-status-");
  const generatedRoot = join(storageRoot, "generated-labs");
  mkdirSync(generatedRoot, { recursive: true });
  const lab = await buildLab(generatedRoot, tmp("capture-signin-labs-"));
  const server = await startPortal({ storageRoot });
  const companion = new FakeCompanion(server.base);
  assert.equal((await companion.pair((await call(server.base, "POST", "/api/capture/pair")).json.code)).status, 201);
  assert.equal((await companion.heartbeat({ signedInProducts: [] })).status, 200);

  const queued = await call(server.base, "POST", "/api/capture/jobs", { json: { target: { type: "lab", labId: lab.labId }, scope: "missing" } });
  assert.equal(queued.status, 201, queued.text);
  const claimed = (await companion.next()).json;
  assert.ok(claimed.shots.length >= 2);
  const message = `Sign in to Microsoft Copilot Studio on your computer, then retry the ${claimed.shots.length} screenshots.`;
  for (const shot of claimed.shots) assert.equal((await companion.progress(claimed.job.id, { shot: { filename: shot.filename, status: "auth-required", message: null, error: message } })).status, 200);
  assert.equal((await companion.complete(claimed.job.id, { message: "0 captured" })).status, 200);

  const job = (await call(server.base, "GET", `/api/capture/jobs/${claimed.job.id}`)).json.job;
  assert.equal(job.status, "failed");
  assert.equal(job.error, message);
  assert.equal(job.needsSignIn.count, claimed.shots.length);
  assert.ok(job.shots.every((s) => s.status === "auth-required" && s.error === message));

  const waiting = (await call(server.base, "GET", "/api/capture/status")).json;
  assert.equal(waiting.jobs.needsSignIn.message, message);
  assert.deepEqual(waiting.jobs.needsSignIn.products.map((p) => p.label), ["Microsoft Copilot Studio"]);
  assert.deepEqual(waiting.companion.signedInProducts, []);

  assert.equal((await companion.heartbeat({ signedInProducts: ["copilot-studio"] })).status, 200);
  const signedIn = (await call(server.base, "GET", "/api/capture/status")).json;
  assert.equal(signedIn.jobs.needsSignIn, undefined, "once the companion reports the sign-in, nothing is waiting");
  assert.deepEqual(signedIn.companion.signedInProducts, ["copilot-studio"]);

  assert.equal((await companion.next()).status, 204, "the portal does not hand the finished job to the companion again");
  t.diagnostic("a job that ended without a sign-in is not served again, and the status clears once the companion reports the product signed in");
});

test("plans and step derivation never include a click that signs in or out, switches the account, or deletes", () => {
  const cleaned = sanitizePlanSteps([
    { action: "stepThrough", labels: ["Settings", "Sign out", "Switch account", "Sign in"], instruction: "Select **Settings**." },
    { action: "stepThrough", labels: ["Profile"], instruction: "Select your profile, then select **Sign out**." },
    { action: "click", label: "Use another account" },
    { action: "click", label: "Memory" },
    { action: "stepThrough", labels: ["Delete agent"], instruction: "Select **Delete agent**." },
    { action: "stepThrough", instruction: "Look around." },
  ]);
  assert.deepEqual(cleaned.map((s) => s.labels ?? s.label), [["Settings"], "Memory", undefined], "only harmless clicks stay; a step that never named a control is kept as it was");
  const derived = derivePlaywrightSteps({
    uiSteps: [
      "Select **Settings**.",
      "Select **Sign in**.",
      "Select your profile picture, then select **Sign out**.",
      "Select **Switch account**, then **Use another account**.",
      "Sign in to Copilot Studio, then select **Memory**.",
      "Select **Delete agent**.",
    ],
    startUrl: "https://copilotstudio.microsoft.com/",
    filename: "x.png",
  });
  assert.deepEqual(derived.filter((s) => s.action === "stepThrough").map((s) => s.labels), [["Settings"], ["Memory"]]);
});

// ── Shared library storage ───────────────────────────────────────────────────

test("the shared library resolves explicit override, then persistent storage, then the baked folder", () => {
  const root = tmp("library-resolve-");
  assert.equal(resolveCapturedScreenshotsDir({}), BAKED_CAPTURED_SCREENSHOTS_DIR);
  assert.deepEqual(resolveCapturedScreenshotsSearchDirs({}), [BAKED_CAPTURED_SCREENSHOTS_DIR]);
  const persistent = resolveCapturedScreenshotsDir({ PORTAL_STORAGE_ROOT: root });
  assert.equal(persistent, resolve(root, "screenshots"));
  assert.deepEqual(resolveCapturedScreenshotsSearchDirs({ PORTAL_STORAGE_ROOT: root }), [persistent, BAKED_CAPTURED_SCREENSHOTS_DIR]);
  const explicit = join(root, "override");
  assert.equal(resolveCapturedScreenshotsDir({ PORTAL_STORAGE_ROOT: root, FEATURE_TOUR_SCREENSHOTS_DIR: explicit }), resolve(explicit));
  assert.deepEqual(resolveCapturedScreenshotsSearchDirs({ PORTAL_STORAGE_ROOT: root, FEATURE_TOUR_SCREENSHOTS_DIR: explicit }), [resolve(explicit)], "an explicit folder is exclusive");
  assert.equal(capturedScreenshotsDir({ PORTAL_STORAGE_ROOT: root }), persistent);
  assert.deepEqual(capturedScreenshotsDirs({ PORTAL_STORAGE_ROOT: root }), [persistent, BAKED_CAPTURED_SCREENSHOTS_DIR]);
  assert.ok(ensurePortalStorageDirs({ PORTAL_STORAGE_ROOT: root }).writable);
  assert.ok(existsSync(persistent));
  assert.equal(JSON.stringify(getStorageDiagnostics({ PORTAL_STORAGE_ROOT: root })).includes(root), false, "diagnostics stay path-free");
});

test("an image in the persistent library serves every lab, and the persistent copy wins over the baked one", () => {
  const persistent = tmp("library-persistent-");
  const baked = tmp("library-baked-");
  const lab = tmp("library-lab-");
  mkdirSync(join(lab, "assets"), { recursive: true });
  writeFileSync(join(lab, "assets", "slot.png"), Buffer.alloc(532, 1));
  assert.equal(resolveLabScreenshot(lab, "slot.png", { capturedDir: [persistent, baked] }), null);
  writeFileSync(join(baked, "slot.png"), makePng({ seed: 2 }));
  const fromBaked = resolveLabScreenshot(lab, "slot.png", { capturedDir: [persistent, baked] });
  assert.equal(fromBaked.source, "shared");
  assert.equal(fromBaked.dir, baked);
  writeFileSync(join(persistent, "slot.png"), makePng({ seed: 3 }));
  assert.equal(resolveLabScreenshot(lab, "slot.png", { capturedDir: [persistent, baked] }).dir, persistent);
  assert.equal(capturedImage(baked, "slot.png").dir, baked);
  assert.equal(capturedImage([persistent, baked], "../slot.png"), null);
});

test("the screenshots prefix mirrors to Azure Blob with the same hydrate and write-through as other prefixes", async () => {
  assert.ok(MANAGED_BLOB_PREFIXES.includes("screenshots"));
  const root = tmp("library-blob-");
  const env = { PORTAL_STORAGE_ROOT: root, AZURE_STORAGE_BLOB_ENDPOINT: "https://example.blob.core.windows.net" };
  assert.equal(resolveSafeBlobLocalPath("screenshots/slot.png", env), resolve(root, "screenshots", "slot.png"));
  assert.throws(() => resolveSafeBlobLocalPath("screenshots/../data/x.json", env), /Unsafe blob path/);

  const blobs = new Map([["screenshots/remote.png", { body: makePng({ seed: 9 }), contentType: "image/png" }]]);
  const fakeFetch = async (url, init = {}) => {
    const parsed = new URL(url);
    const method = init.method || "GET";
    if (parsed.searchParams.get("comp") === "list") {
      const names = [...blobs.keys()].map((n) => `<Blob><Name>${n}</Name></Blob>`).join("");
      return new Response(`<EnumerationResults><Blobs>${names}</Blobs><NextMarker></NextMarker></EnumerationResults>`, { status: 200 });
    }
    const name = decodeURIComponent(parsed.pathname.split("/").slice(2).join("/"));
    if (method === "PUT") {
      blobs.set(name, { body: Buffer.from(init.body), contentType: init.headers["Content-Type"] });
      return new Response(null, { status: 201 });
    }
    if (method === "DELETE") {
      blobs.delete(name);
      return new Response(null, { status: 202 });
    }
    return blobs.has(name) ? new Response(blobs.get(name).body, { status: 200 }) : new Response(null, { status: 404 });
  };
  const mirror = createBlobPersistence({ env, fetchImpl: fakeFetch, tokenProvider: () => "test-token", retryBaseDelayMs: 0 });
  await mirror.hydrateFromBlob();
  const hydrated = join(root, "screenshots", "remote.png");
  assert.ok(existsSync(hydrated), "a captured image is restored after a restart");
  assert.deepEqual(readFileSync(hydrated), blobs.get("screenshots/remote.png").body);

  writeFileSync(join(root, "screenshots", "fresh.png"), makePng({ seed: 10 }));
  await mirror.syncToBlob();
  assert.equal(blobs.get("screenshots/fresh.png").contentType, "image/png");
  rmSync(join(root, "screenshots", "fresh.png"));
  await mirror.syncToBlob();
  assert.equal(blobs.has("screenshots/fresh.png"), false, "a reset image is removed from Blob too");
  assert.equal(blobs.has("screenshots/remote.png"), true);
});

// ── Honest status ────────────────────────────────────────────────────────────

test("lab screenshot status reports an honest checkState instead of a false up-to-date", async () => {
  const lab = await buildLab(ctx.generatedRoot, ctx.emptyLabs);
  const isolated = tmp("check-state-shared-");
  const status = () => getLabScreenshotsStatus(ctx.generatedRoot, lab.labId, { capturedDir: isolated }).body;
  let body = status();
  assert.equal(body.checkState, "not-checked");
  assert.equal(body.summary.checkState, "not-checked");
  assert.equal(body.summary.lastRevalidatedAt, null);
  assert.ok(body.modules.every((m) => m.checkState === "not-checked" || m.checkState === "up-to-date"));
  assert.ok(body.shots.every((s) => s.verification === null && s.needsReview === false));
  assert.ok(
    body.shots.every((s) => Array.isArray(s.instructions) && s.instructions.length > 0 && s.instructions.every((line) => typeof line === "string" && line.length <= 300)),
    "every shot carries its 'what to show' lines for the Screenshot Center",
  );
  assert.equal(body.captureCapabilities.companionConnected, false);
  assert.equal(body.captureCapabilities.tenantUrlsSet, false);
  assert.equal(typeof body.captureCapabilities.serverBrowserAvailable, "boolean");

  const learnPath = join(lab.labDir, "screenshots", "learn-state.json");
  const learn = JSON.parse(readFileSync(learnPath, "utf8"));
  learn.lastRevalidatedAt = new Date().toISOString();
  writeFileSync(learnPath, JSON.stringify(learn));
  body = status();
  assert.equal(body.checkState, "up-to-date");

  learn.shots[lab.shots[0].filename].stale = true;
  writeFileSync(learnPath, JSON.stringify(learn));
  body = status();
  assert.equal(body.checkState, "docs-updated");
  assert.equal(body.shots[0].checkState, "docs-updated");

  const fresh = await buildLab(ctx.generatedRoot, ctx.emptyLabs);
  const revalidated = await revalidateLabAgainstLearn(ctx.generatedRoot, fresh.labId, {
    capturedDir: isolated,
    fetchDoc: async () => ({ markdown: "# Documentation\n\nNothing to see." }),
  });
  assert.equal(revalidated.status, 200);
  assert.equal(revalidated.body.checkState, "up-to-date");
  assert.equal(revalidated.body.state.summary.checkState, "up-to-date");
});

// ── Authentication scope ─────────────────────────────────────────────────────

test("only the companion routes skip portal sign-in, and nothing else does", () => {
  const req = (method, originalUrl) => ({ method, originalUrl });
  for (const [method, url] of [["GET", "/api/capture/companion/next"], ["POST", "/api/capture/companion/pair"], ["POST", "/api/capture/companion/heartbeat"], ["POST", "/api/capture/companion/jobs/job_abc/progress"], ["PUT", "/api/capture/companion/jobs/job_abc/shots/a.png?x=1"], ["POST", "/api/capture/companion/jobs/job_abc/complete"]]) {
    assert.equal(isCaptureCompanionRequest(req(method, url)), true, `${method} ${url}`);
  }
  for (const [method, url] of [
    ["DELETE", "/api/capture/companion/next"],
    ["PATCH", "/api/capture/companion/next"],
    ["GET", "/api/capture/companion.zip"],
    ["GET", "/api/capture/companion/"],
    ["GET", "/api/capture/companion"],
    ["GET", "/api/capture/companion/../status"],
    ["GET", "/api/capture/companion/%2e%2e/status"],
    ["GET", "/api/capture/companions/next"],
    ["GET", "/api/capture/status"],
    ["POST", "/api/capture/pair"],
    ["POST", "/api/capture/jobs"],
    ["GET", "/api/lab-builder/generated"],
    ["GET", "/api/scenarios"],
    ["GET", "/API/capture/companion/next"],
    ["GET", "/other/api/capture/companion/next"],
  ]) {
    assert.equal(isCaptureCompanionRequest(req(method, url)), false, `${method} ${url}`);
  }
});

test("with portal sign-in enforced, a capture token reaches only the companion routes", async (t) => {
  const storageRoot = tmp("capture-auth-");
  const pairing = createPairingStore({ dir: join(storageRoot, "data", "capture") });
  const { token, device } = pairing.exchangeCode(pairing.createCode().code, { deviceName: "PC" });
  const server = await startPortal({ storageRoot, auth: true });

  const companion = await call(server.base, "GET", "/api/capture/companion/next", { token });
  assert.equal(companion.status, 204, "a valid capture token claims jobs");
  assert.equal((await call(server.base, "POST", "/api/capture/companion/heartbeat", { token, json: { signedInProducts: ["copilot-studio"] } })).status, 200);

  for (const [method, path] of [
    ["GET", "/api/capture/status"],
    ["POST", "/api/capture/pair"],
    ["GET", "/api/capture/jobs"],
    ["POST", "/api/capture/jobs"],
    ["GET", "/api/capture/devices"],
    ["DELETE", `/api/capture/devices/${device.id}`],
    ["GET", "/api/capture/companion.zip"],
    ["GET", "/api/capture/library"],
    ["GET", "/api/lab-builder/generated"],
    ["GET", "/api/config"],
    ["GET", "/api/scenarios"],
    ["POST", "/api/provision/deploy"],
    ["GET", "/api/capture/companion/../status"],
    ["DELETE", "/api/capture/companion/next"],
  ]) {
    const res = await call(server.base, method, path, { token, json: method === "GET" ? undefined : {} });
    assert.equal(res.status, 401, `${method} ${path} must need portal sign-in`);
  }

  assert.equal((await call(server.base, "GET", "/api/capture/companion/next")).json.code, "token-missing");
  assert.equal((await call(server.base, "GET", "/api/capture/companion/next", { token: "cap_forged" })).json.code, "token-invalid");
  assert.equal((await call(server.base, "GET", "/api/capture/companion/next", { token: "not-a-capture-token" })).json.code, "token-missing");
  assert.equal((await call(server.base, "POST", "/api/capture/companion/pair", { json: { code: "AAAA-BBBB" } })).status, 401);

  pairing.revokeDevice(device.id);
  const revoked = await call(server.base, "GET", "/api/capture/companion/next", { token });
  assert.equal(revoked.status, 401);
  assert.equal(revoked.json.code, "token-revoked");
  assert.match(revoked.json.error, /disconnected/);
  t.diagnostic("capture token scope verified against an auth-enforcing server");
});

// ── The companion over real HTTP ─────────────────────────────────────────────

test("a fake companion pairs, claims a job, uploads verified shots, and completes it end to end", async () => {
  const { base } = ctx;
  const { labId, labDir, shots } = ctx.lab;

  let status = (await call(base, "GET", "/api/capture/status")).json;
  assert.equal(status.companion.connected, false);
  // Whether this machine happens to have Playwright's browser must not change the result: "available" means the bundled one is there.
  assert.equal(status.serverBrowser.available, status.serverBrowser.chromiumInstalled);
  assert.equal(status.tenantUrls.set, false);
  assert.equal(status.sharedLibrary.location, "persistent");
  assert.equal(status.sharedLibrary.persistent, true);
  assert.ok(!JSON.stringify(status).includes(ctx.storageRoot), "status is path-free");

  const pair = await call(base, "POST", "/api/capture/pair");
  assert.equal(pair.status, 201);
  assert.match(pair.json.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.match(pair.json.command, /--code=/);
  assert.equal(pair.json.command, `.\\capture-companion\\tools\\screenshot-capture\\start-companion.cmd --portal=${pair.json.portalUrl} --code=${pair.json.code}`, "the compatible command now includes the launcher's relative path");
  assert.deepEqual(pair.json.launcher, { ...COMPANION_LAUNCHER }, "the additive launcher paths are the ones inside the ZIP");
  const companion = new FakeCompanion(base);
  const paired = await companion.pair(pair.json.code);
  assert.equal(paired.status, 201);
  assert.ok(companion.token.startsWith("cap_"));
  assert.equal((await new FakeCompanion(base).pair(pair.json.code)).json.code, "pair-invalid", "the code is one-time");
  assert.equal((await new FakeCompanion(base).pair("")).status, 401);
  ctx.device = paired.json.device;

  assert.equal((await companion.heartbeat()).status, 200);
  status = (await call(base, "GET", "/api/capture/status")).json;
  assert.equal(status.companion.connected, true);
  assert.deepEqual(status.companion.signedInProducts, ["copilot-studio"]);
  assert.equal(status.companion.devices[0].name, "TEST-PC");
  assert.ok(!JSON.stringify(status).includes(companion.token));

  const labStatus = (await call(base, "GET", `/api/lab-builder/generated/${labId}/screenshots`)).json;
  assert.equal(labStatus.captureCapabilities.companionConnected, true);
  assert.equal(labStatus.checkState, "not-checked");

  // The first shot's slot is stale: a job for stale shots picks it up along with the missing one.
  const learnPath = join(labDir, "screenshots", "learn-state.json");
  const learn = JSON.parse(readFileSync(learnPath, "utf8"));
  learn.shots[shots[0].filename].stale = true;
  learn.modules[shots[0].featureId].status = "docs-updated";
  writeFileSync(learnPath, JSON.stringify(learn));

  assert.equal((await call(base, "POST", "/api/capture/jobs", { json: { target: { type: "lab", labId }, scope: "everything" } })).status, 400);
  assert.equal((await call(base, "POST", "/api/capture/jobs", { json: { target: { type: "lab", labId }, env: { CAPTURE_X: "http://x.example.com" } } })).status, 400);
  assert.equal((await call(base, "POST", "/api/capture/jobs", { json: { target: { type: "lab", labId: "no-such-lab" } } })).status, 404);

  const tenantUrl = "https://contoso.sharepoint.com/sites/training";
  const queued = await call(base, "POST", "/api/capture/jobs", { json: { target: { type: "lab", labId }, scope: "stale", env: { CAPTURE_SHAREPOINT_SITE_URL: tenantUrl } } });
  assert.equal(queued.status, 201);
  const jobId = queued.json.job.id;
  assert.equal(queued.json.job.status, "queued");
  assert.equal(queued.json.job.progress.total, 2);
  assert.deepEqual(queued.json.job.envNames, ["CAPTURE_SHAREPOINT_SITE_URL"]);
  assert.ok(!queued.text.includes(tenantUrl), "the browser never gets the tenant address back");
  const again = await call(base, "POST", "/api/capture/jobs", { json: { target: { type: "lab", labId }, scope: "stale", env: { CAPTURE_SHAREPOINT_SITE_URL: tenantUrl } } });
  assert.equal(again.json.existing, true, "queueing the same capture twice reuses the job");
  assert.equal(again.json.job.id, jobId);

  const claimed = await companion.next();
  assert.equal(claimed.status, 200);
  assert.equal(claimed.json.job.id, jobId);
  assert.equal(claimed.json.env.CAPTURE_SHAREPOINT_SITE_URL, tenantUrl);
  assert.equal(claimed.json.shots.length, 2);
  for (const shot of claimed.json.shots) {
    assert.match(shot.filename, /\.png$/);
    assert.ok(shot.authProfile);
    assert.ok(shot.steps.some((s) => s.action === "screenshot" || s.action === "navigate"));
    assert.ok(shot.steps.every((s) => ["navigate", "waitForLoadState", "dismissBanners", "stepThrough", "click", "clickBestEffort", "probeControl", "probeCallouts", "screenshot"].includes(s.action)));
    assert.ok(Array.isArray(shot.expectedLabels));
  }
  assert.equal((await companion.next()).json.job.resumed, true);

  const first = claimed.json.shots.find((s) => s.filename === shots[0].filename);
  const second = claimed.json.shots.find((s) => s.filename === shots[1].filename);
  const running = await companion.progress(jobId, { shot: { filename: first.filename, status: "running", message: "Capturing" } });
  assert.equal(running.json.cancelRequested, false);
  let job = (await call(base, "GET", `/api/capture/jobs/${jobId}`)).json.job;
  assert.equal(job.status, "running");
  assert.equal(job.shots.find((s) => s.filename === first.filename).status, "running");

  const accepted = await companion.upload(jobId, first.filename, makePng({ mode: "ui", seed: 5 }), goodEvidence(first));
  assert.equal(accepted.status, 200, accepted.text);
  assert.equal(accepted.json.outcome, "accepted");
  assert.equal(accepted.json.verification.level, "pass");
  assert.match(accepted.json.verification.finalUrl, /^https:\/\/copilotstudio\.microsoft\.com\/environments\/abc\/[a-z/]+$/, "query strings are dropped");
  assert.ok(!accepted.text.includes("SECRET"));

  const signedIn = await companion.upload(jobId, second.filename, makePng({ mode: "ui", seed: 6 }), { ...goodEvidence(second), finalUrl: "https://login.microsoftonline.com/common/oauth2/authorize" });
  assert.equal(signedIn.status, 422);
  assert.equal(signedIn.json.outcome, "rejected");
  assert.equal(signedIn.json.verification.reasons[0].code, "sign-in-page");
  assert.equal(existsSync(join(labDir, "assets", second.filename)) && statSync(join(labDir, "assets", second.filename)).size > 5120, false, "a rejected image is never written");
  job = (await call(base, "GET", `/api/capture/jobs/${jobId}`)).json.job;
  assert.equal(job.shots.find((s) => s.filename === second.filename).status, "failed");

  const retake = await companion.upload(jobId, second.filename, makePng({ mode: "ui", seed: 7 }), goodEvidence(second), { multipart: false });
  assert.equal(retake.status, 200, retake.text);
  assert.equal(retake.json.outcome, "accepted");

  const done = await companion.complete(jobId, { message: "2 captured" });
  assert.equal(done.status, 200);
  assert.equal(done.json.job.status, "done");
  assert.equal(done.json.job.result.captured, 2);
  assert.equal(done.json.job.progress.percent, 100);
  assert.equal((await companion.complete(jobId)).status, 409);
  assert.equal((await companion.progress(jobId, { message: "late" })).status, 409);

  const after = (await call(base, "GET", `/api/lab-builder/generated/${labId}/screenshots`)).json;
  assert.equal(after.summary.captured, after.summary.total);
  assert.equal(after.summary.missing, 0);
  assert.equal(after.summary.stale, 0, "accepted uploads clear the stale flags");
  assert.equal(after.summary.learnSyncStatus, "up-to-date");
  assert.ok(after.shots.every((s) => s.capturedInLab && s.captureSource === "companion" && s.verification.state === "accepted"));
  assert.ok(after.modules.every((m) => m.status === "up-to-date"));
  const learnAfter = JSON.parse(readFileSync(learnPath, "utf8"));
  assert.equal(learnAfter.learnSyncStatus, "up-to-date");
  assert.equal(learnAfter.shots[first.filename].stale, false);
  assert.match(readFileSync(join(labDir, "index.html"), "utf8"), /data:image\/png;base64,/, "the lab's HTML shows the new image");
  assert.ok(statSync(join(labDir, "assets", first.filename)).size > 5120);

  const list = (await call(base, "GET", "/api/capture/jobs?limit=5")).json.jobs;
  assert.equal(list[0].id, jobId);
  assert.equal(list[0].shots, undefined, "the list carries summaries");
  assert.ok(list[0].progress);
  const finished = await call(base, "GET", `/api/capture/jobs/${jobId}/events`);
  assert.match(finished.headers.get("content-type"), /text\/event-stream/);
  assert.match(finished.text, /event: snapshot/);
  assert.match(finished.text, /event: end/);
});

test("the real companion code drives a whole job against the real portal over HTTP", async (t) => {
  const { base } = ctx;
  const { labId, labDir, shots } = ctx.lab3;

  const code = (await call(base, "POST", "/api/capture/pair")).json.code;
  const pairedClient = createPortalClient({ portal: base });
  const paired = await pairedClient.pair({ code, deviceName: "E2E-PC" });
  const client = createPortalClient({ portal: base, token: paired.token });
  await client.heartbeat({ signedInProducts: ["copilot-studio"] });

  const queued = await call(base, "POST", "/api/capture/jobs", { json: { target: { type: "lab", labId }, scope: "missing", options: { callouts: "sidecar", maskTerms: ["Contoso"] } } });
  assert.equal(queued.status, 201, queued.text);
  assert.deepEqual(queued.json.job.options.maskTerms, ["Contoso"]);
  const claimed = await client.next();
  assert.equal(claimed.shots.length, shots.length);

  const labels = [...new Set(claimed.shots.flatMap((s) => s.expectedLabels))];
  // The product sends the browser from its start page to the environment's home page.
  const fake = createFakePlaywright({ labels, pageLabels: [...labels, "Home"], rewriteUrl: (u) => (u === "https://copilotstudio.microsoft.com/" ? "https://copilotstudio.microsoft.com/environments/abc/home" : u) });
  const home = tmp("e2e-companion-home-");
  const lines = [];
  const result = await runJob({ client, claimed, home, playwright: fake.playwright, log: (m) => lines.push(m), heartbeatMs: 60_000 });
  assert.equal(result.tally.captured, shots.length, lines.join("\n"));

  const job = (await call(base, "GET", `/api/capture/jobs/${claimed.job.id}`)).json.job;
  assert.equal(job.status, "done");
  assert.ok(job.shots.every((s) => s.status === "captured" && s.verification.level === "pass" && s.verification.redaction.applied));
  const status = (await call(base, "GET", `/api/lab-builder/generated/${labId}/screenshots`)).json;
  assert.equal(status.summary.captured, status.summary.total);
  assert.ok(status.shots.every((s) => s.captureSource === "companion" && s.verification.finalUrl.startsWith("https://")));
  assert.ok(existsSync(join(labDir, "screenshots", `${shots[0].filename.replace(/\.[^.]+$/, "")}.callouts.json`)) || claimed.shots.every((s) => !s.callouts.length), "callout positions are stored next to the lab's screenshots");
  assert.match(readFileSync(join(labDir, "index.html"), "utf8"), /data:image\/png;base64,/);
  t.diagnostic(`companion log lines: ${lines.length}`);
});

test("a job carries the tenant addresses of a brand profile or of the lab's own brand customization", async () => {
  const { base } = ctx;
  const brandEnv = { PORTAL_STORAGE_ROOT: ctx.storageRoot };
  const profile = createProfile(
    {
      name: "Contoso Training",
      companyName: "Contoso",
      sharepointSiteUrl: "https://contoso.sharepoint.com/sites/training",
      copilotStudioUrl: "https://copilotstudio.preview.microsoft.com/environments/abc/home",
      foundryProjectUrl: "https://ai.azure.com/projects/contoso",
    },
    brandEnv,
  );
  const companion = new FakeCompanion(base);
  await companion.pair((await call(base, "POST", "/api/capture/pair")).json.code);
  await companion.heartbeat();
  const labId = ctx.lab.labId;
  const queue = (extra) => call(base, "POST", "/api/capture/jobs", { json: { target: { type: "lab", labId }, scope: { mode: "all", filenames: [], featureIds: [] }, ...extra } });
  const cancel = (id) => call(base, "POST", `/api/capture/jobs/${id}/cancel`);

  const fromProfile = await queue({ brandProfileId: profile.id, env: { CAPTURE_SHAREPOINT_SITE_URL: "https://contoso.sharepoint.com/sites/override" } });
  assert.equal(fromProfile.status, 201, fromProfile.text);
  assert.equal(fromProfile.json.envSource, "profile+request");
  assert.deepEqual(fromProfile.json.job.envNames, ["CAPTURE_COPILOT_STUDIO_START_URL", "CAPTURE_FOUNDRY_PROJECT_URL", "CAPTURE_SHAREPOINT_SITE_URL"]);
  assert.ok(!fromProfile.text.includes("contoso.sharepoint.com"), "tenant addresses never go back to the browser");
  const claimed = (await companion.next()).json;
  assert.equal(claimed.env.CAPTURE_COPILOT_STUDIO_START_URL, "https://copilotstudio.preview.microsoft.com/environments/abc/home");
  assert.equal(claimed.env.CAPTURE_SHAREPOINT_SITE_URL, "https://contoso.sharepoint.com/sites/override", "an explicit address wins per variable");
  await cancel(claimed.job.id);
  assert.equal((await companion.complete(claimed.job.id)).json.job.status, "cancelled");

  const sameButOtherBrand = await queue({ env: { CAPTURE_SHAREPOINT_SITE_URL: "https://fabrikam.sharepoint.com/sites/x" } });
  const sameAgain = await queue({ env: { CAPTURE_SHAREPOINT_SITE_URL: "https://fabrikam.sharepoint.com/sites/x" } });
  assert.equal(sameAgain.json.existing, true);
  const differentEnv = await queue({ env: { CAPTURE_SHAREPOINT_SITE_URL: "https://other.sharepoint.com/sites/x" } });
  assert.equal(differentEnv.status, 201, "the same capture for another tenant is a different job");
  for (const job of [sameButOtherBrand, differentEnv]) await cancel(job.json.job.id);

  assert.equal((await queue({ brandProfileId: "no-such-profile" })).status, 404);
  assert.equal((await queue({ brandProfileId: 42 })).status, 400);
  assert.equal((await queue({ brandProfileId: "../x" })).status, 404);

  const generated = await call(base, "POST", "/api/lab-builder/generate", {
    json: { products: ["copilot-studio"], features: ["mc-memory"], harness: "microsoft-copilot", includeCore: false, useLearnMcp: false, useLlm: false, brandProfileId: profile.id },
  });
  assert.equal(generated.status, 200, generated.text);
  const branded = generated.json.labId;
  const queueBranded = (extra) => call(base, "POST", "/api/capture/jobs", { json: { target: { type: "lab", labId: branded }, scope: "all", ...extra } });
  const automatic = await queueBranded({});
  assert.equal(automatic.status, 201, automatic.text);
  assert.equal(automatic.json.envSource, "lab", "a lab built with a brand profile uses its addresses automatically");
  assert.ok(automatic.json.job.envNames.includes("CAPTURE_SHAREPOINT_SITE_URL"));
  await cancel(automatic.json.job.id);
  const ignored = await queueBranded({ useLabCustomization: false });
  assert.equal(ignored.json.envSource, null);
  assert.deepEqual(ignored.json.job.envNames, []);
  await cancel(ignored.json.job.id);
});
test("cancel stops a queued job at once and a running job between shots", async () => {
  const { base } = ctx;
  const { labId, shots } = ctx.lab;
  for (const shot of shots) assert.equal((await call(base, "DELETE", `/api/lab-builder/generated/${labId}/screenshots/${shot.filename}`)).status, 200);
  const companion = new FakeCompanion(base);
  const code = (await call(base, "POST", "/api/capture/pair")).json.code;
  await companion.pair(code);
  await companion.heartbeat();

  const queued = (await call(base, "POST", "/api/capture/jobs", { json: { target: { type: "lab", labId }, scope: "missing" } })).json.job;
  const events = await fetch(`${base}/api/capture/jobs/${queued.id}/events`);
  const reader = events.body.getReader();
  const firstChunk = new TextDecoder().decode((await reader.read()).value);
  assert.match(firstChunk, /event: snapshot/);
  const cancelled = await call(base, "POST", `/api/capture/jobs/${queued.id}/cancel`);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.json.job.status, "cancelled");
  let streamed = firstChunk;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    streamed += new TextDecoder().decode(value);
  }
  assert.match(streamed, /event: update/);
  assert.match(streamed, /event: end/);
  assert.match(streamed, /"status":"cancelled"/);
  assert.equal((await companion.next()).status, 204, "a cancelled job is never claimed");
  assert.equal((await call(base, "POST", `/api/capture/jobs/${queued.id}/cancel`)).status, 409);
  assert.equal((await call(base, "POST", "/api/capture/jobs/not-a-job/cancel")).status, 400);
  assert.equal((await call(base, "POST", "/api/capture/jobs/job_0000000000000000/cancel")).status, 404);

  const running = (await call(base, "POST", "/api/capture/jobs", { json: { target: { type: "lab", labId }, scope: "missing" } })).json.job;
  const claimed = (await companion.next()).json;
  assert.equal(claimed.job.id, running.id);
  const [a, b] = claimed.shots;
  assert.equal((await companion.upload(running.id, a.filename, makePng({ mode: "ui", seed: 8 }), goodEvidence(a))).status, 200);
  const stop = await call(base, "POST", `/api/capture/jobs/${running.id}/cancel`);
  assert.equal(stop.json.job.cancelRequested, true);
  assert.equal(stop.json.job.status, "running", "the running shot finishes first");
  const progress = await companion.progress(running.id, { message: "between shots" });
  assert.equal(progress.json.cancelRequested, true, "the companion learns about the cancel on its next call");
  assert.equal((await companion.heartbeat({ jobId: running.id })).json.cancelRequested, true);
  const done = await companion.complete(running.id, { message: "stopped" });
  assert.equal(done.json.job.status, "cancelled");
  assert.deepEqual(done.json.job.shots.map((s) => [s.filename, s.status]), [[a.filename, "captured"], [b.filename, "cancelled"]]);
});

test("pasted and uploaded screenshots are verified strictly and never write outside the slot", async () => {
  const { base } = ctx;
  const { labId, labDir, shots } = ctx.lab2;
  const slot = shots[0].filename;
  const url = (name = slot) => `/api/lab-builder/generated/${labId}/screenshots/${name}`;
  const put = (name, bytes, type = "image/png") => call(base, "PUT", url(name), png(bytes, type));
  const before = readdirSync(join(labDir, "assets")).sort();

  for (const name of ["..%2Fevil.png", "%2e%2e%2fevil.png", "evil.png", "not-a-slot.png", "x.gif", "..%5Cevil.png"]) {
    const res = await put(name, makePng({ mode: "ui" }));
    assert.ok([400, 404].includes(res.status), `${name} -> ${res.status}`);
  }
  assert.deepEqual(readdirSync(join(labDir, "assets")).sort(), before, "no stray file was created");
  assert.equal(existsSync(join(ctx.generatedRoot, "evil.png")), false);
  assert.equal(existsSync(join(labDir, "evil.png")), false);

  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`.padEnd(9000, " "));
  for (const bytes of [svg, Buffer.from("<html><body>hi</body></html>".padEnd(9000, " ")), Buffer.from("plain text".repeat(900))]) {
    const res = await put(slot, bytes);
    assert.equal(res.status, 422);
    assert.equal(res.json.outcome, "rejected");
    assert.equal(res.json.verification.reasons[0].code, "bad-signature");
  }
  assert.equal((await put(slot, makeJpeg())).json.verification.reasons[0].code, "extension-mismatch");
  assert.equal((await put(slot, makePng({ mode: "blank", width: 800, height: 600 }))).json.verification.reasons[0].code, "blank");
  assert.equal((await put(slot, makePng({ width: 4, height: 4 }))).json.verification.reasons[0].code, "too-small");
  const slightlyOver = await put(slot, Buffer.concat([makePng().subarray(0, 8), Buffer.alloc(MAX_UPLOAD_BYTES + 100)]));
  assert.equal(slightlyOver.status, 422, "just over the cap is rejected by verification");
  assert.equal(slightlyOver.json.verification.reasons[0].code, "too-large");
  assert.equal((await call(base, "PUT", url(), { body: makePng(), headers: { "Content-Type": "text/html" } })).status, 415);
  assert.equal((await call(base, "PUT", url(), { body: makePng(), headers: { "Content-Type": "image/svg+xml" } })).status, 415);
  assert.equal((await call(base, "PUT", url(), { json: { image: "x" } })).status, 415);
  assert.equal((await call(base, "PUT", url(), { body: "", headers: { "Content-Type": "image/png" } })).status, 415);

  const form = new FormData();
  form.append("file", new Blob([makePng({ mode: "ui" })], { type: "image/png" }), slot);
  form.append("evidence", JSON.stringify({ finalUrl: "https://login.live.com/login.srf", title: "Sign in" }));
  const signIn = await call(base, "PUT", url(), { form });
  assert.equal(signIn.status, 422);
  assert.equal(signIn.json.verification.reasons[0].code, "sign-in-page");
  assert.ok(statSync(join(labDir, "assets", slot)).size < 5120, "the placeholder is untouched");
  assert.equal((await call(base, "GET", `/api/lab-builder/generated/${labId}/screenshots`)).json.summary.captured, 0);
});

test("a warning is staged for review and accepted by a person; DELETE resets to the placeholder for a retake", async () => {
  const { base } = ctx;
  const { labId, labDir, shots } = ctx.lab2;
  const [a, b] = shots.map((s) => s.filename);
  const url = (name, suffix = "") => `/api/lab-builder/generated/${labId}/screenshots/${name}${suffix}`;

  const warned = await call(base, "PUT", url(a), png(makePng({ mode: "mostly" })));
  assert.equal(warned.status, 202);
  assert.equal(warned.json.outcome, "needs-review");
  assert.equal(warned.json.verification.reasons[0].code, "near-uniform");
  assert.ok(statSync(join(labDir, "assets", a)).size < 5120, "nothing is committed until a person accepts");
  let status = (await call(base, "GET", `/api/lab-builder/generated/${labId}/screenshots`)).json;
  const row = status.shots.find((s) => s.filename === a);
  assert.equal(row.needsReview, true);
  assert.equal(row.verification.state, "needs-review");
  assert.equal(row.captured, false);
  assert.equal(status.summary.needsReview, 1);

  const staged = await call(base, "GET", url(a, "/staged"));
  assert.equal(staged.status, 200);
  assert.equal(staged.headers.get("content-type"), "image/png");
  assert.equal((await call(base, "GET", url(b, "/staged"))).status, 404);
  assert.equal((await call(base, "POST", url(b, "/accept"))).status, 404, "nothing to accept");

  const acceptedStaged = await call(base, "POST", url(a, "/accept"));
  assert.equal(acceptedStaged.status, 200);
  assert.equal(acceptedStaged.json.outcome, "accepted");
  assert.equal(acceptedStaged.json.state.shots.find((s) => s.filename === a).capturedInLab, true);
  assert.ok(statSync(join(labDir, "assets", a)).size > 5120);
  assert.equal((await call(base, "GET", url(a, "/staged"))).status, 404, "the staged copy is gone");

  // Paste straight in through the alias route with multipart, and with "use anyway".
  const form = new FormData();
  form.append("file", new Blob([makePng({ mode: "ui", seed: 12 })], { type: "image/png" }), b);
  const viaAlias = await call(base, "PUT", `/api/generated-labs/${labId}/screenshots/${b}`, { form });
  assert.equal(viaAlias.status, 200, viaAlias.text);
  assert.equal(viaAlias.json.outcome, "accepted");
  const html = readFileSync(join(labDir, "index.html"), "utf8");
  assert.match(html, /data:image\/png;base64,/);
  status = (await call(base, "GET", `/api/lab-builder/generated/${labId}/screenshots`)).json;
  assert.equal(status.summary.captured, status.summary.total);
  assert.ok(status.shots.every((s) => s.captureSource === "manual-upload"));
  assert.equal(status.summary.needsReview, 0);

  const anyway = await call(base, "PUT", `${url(a)}?acceptWarnings=true`, png(makePng({ mode: "mostly", seed: 3 })));
  assert.equal(anyway.status, 200);
  assert.equal(anyway.json.verification.level, "warn");

  const reset = await call(base, "DELETE", url(a));
  assert.equal(reset.status, 200);
  assert.equal(reset.json.outcome, "reset");
  assert.deepEqual(readFileSync(join(labDir, "assets", a)), readFileSync(PLACEHOLDER_PATH), "the placeholder is back");
  assert.equal(reset.json.state.shots.find((s) => s.filename === a).captured, false);
  assert.equal(reset.json.state.shots.find((s) => s.filename === a).verification, null);
  assert.equal(resolveLabScreenshot(labDir, a, { capturedDir: [] }), null);
  assert.equal((await call(base, "DELETE", url("unknown.png"))).status, 404);

  const retaken = await call(base, "PUT", url(a), png(makePng({ mode: "ui", seed: 14 })));
  assert.equal(retaken.status, 200);
  assert.equal(retaken.json.state.shots.find((s) => s.filename === a).captured, true);
});

test("a companion job for the shared library stores images persistently and every lab uses them", async () => {
  const { base } = ctx;
  const slot = ctx.lab.shots[1].filename;
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "tools", "screenshot-capture", "feature-shots.json"), "utf8"));
  assert.ok(manifest.shots.some((s) => s.filename === slot), "the fixture slot is a feature tour shot");

  const companion = new FakeCompanion(base);
  await companion.pair((await call(base, "POST", "/api/capture/pair")).json.code);
  await companion.heartbeat();

  const library = (await call(base, "GET", "/api/capture/library?products=copilot-studio")).json;
  assert.ok(library.summary.total > 100);
  assert.equal(library.shots.find((s) => s.filename === slot).captured, false);

  const queued = await call(base, "POST", "/api/capture/jobs", { json: { target: { type: "library", products: ["copilot-studio"] }, scope: { mode: "selected", filenames: [slot] } } });
  assert.equal(queued.status, 201, queued.text);
  assert.equal(queued.json.job.target.type, "library");
  const claimed = (await companion.next()).json;
  assert.equal(claimed.shots.length, 1);
  assert.equal(claimed.shots[0].filename, slot);
  assert.equal((await companion.upload(claimed.job.id, "not-in-this-job.png", makePng({ mode: "ui" }), goodEvidence(claimed.shots[0]))).status, 404);
  const uploaded = await companion.upload(claimed.job.id, slot, makePng({ mode: "ui", seed: 21 }), goodEvidence(claimed.shots[0]));
  assert.equal(uploaded.status, 200, uploaded.text);
  assert.equal((await companion.complete(claimed.job.id)).json.job.status, "done");

  const persistentFile = join(ctx.storageRoot, "screenshots", slot);
  assert.ok(existsSync(persistentFile), "the library image lives in the persistent screenshots folder");
  assert.equal((await call(base, "GET", "/api/capture/library?products=copilot-studio")).json.shots.find((s) => s.filename === slot).captured, true);
  assert.equal((await call(base, "GET", "/api/capture/status")).json.sharedLibrary.captured >= 1, true);

  const labStatus = (await call(base, "GET", `/api/lab-builder/generated/${ctx.lab.labId}/screenshots`)).json;
  const row = labStatus.shots.find((s) => s.filename === slot);
  assert.equal(row.captured, true);
  assert.equal(row.capturedSource, "shared");
  const asset = await fetch(`${base}/api/lab-builder/generated/${ctx.lab.labId}/assets/${slot}`);
  assert.equal(asset.status, 200);
  assert.ok((await asset.arrayBuffer()).byteLength > 5120);

  // The lab's own files catch up in the background after the job completes.
  const html = join(ctx.lab.labDir, "index.html");
  for (let i = 0; i < 40 && !/data:image\/png;base64,/.test(readFileSync(html, "utf8")); i += 1) await new Promise((r) => setTimeout(r, 150));
  assert.match(readFileSync(html, "utf8"), /data:image\/png;base64,/);

  const reset = await call(base, "DELETE", `/api/capture/library/screenshots/${slot}`);
  assert.equal(reset.status, 200);
  assert.equal(existsSync(persistentFile), false);
  assert.equal((await call(base, "DELETE", "/api/capture/library/screenshots/not-a-slot.png")).status, 404);
});

test("the shared companion download has the launchers and no secrets", async () => {
  const res = await fetch(`${ctx.base}/api/capture/companion.zip`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/zip");
  assert.match(res.headers.get("content-disposition"), /attachment; filename="copilot-studio-labs-capture-companion\.zip"/);
  const zip = readZip(Buffer.from(await res.arrayBuffer()));
  const names = [...zip.keys()];
  for (const file of ["companion.mjs", "lab-runner.mjs", "auth.mjs", "browsers.mjs", "guard.mjs", "trace.mjs", "callouts.mjs", "manifests.mjs", "image-verify.mjs", "redact.mjs", "package.json", "start-companion.cmd", "start-companion.ps1", "start-companion.sh"]) {
    assert.ok(names.includes(`capture-companion/tools/screenshot-capture/${file}`), `${file} is in the zip`);
  }
  assert.ok(names.includes("capture-companion/tools/feature-tour/lib/products.mjs"));
  assert.ok(names.includes("capture-companion/README-FIRST.txt"));
  for (const name of names) {
    const rel = name.replace(/^capture-companion\//, "");
    assert.ok(rel === "README-FIRST.txt" || COMPANION_FILES.includes(rel), `${name} is on the allowlist`);
    assert.ok(!/(^|\/)(\.companion\.json|\.auth|\.captures|\.env[^/]*|node_modules|test)(\/|$)/.test(name), `${name} must not ship`);
    const text = zip.get(name).toString("utf8");
    assert.ok(!/cap_[A-Za-z0-9_-]{20,}/.test(text), `${name} holds no capture token`);
    assert.ok(!/Bearer\s+[A-Za-z0-9._-]{20,}/.test(text), `${name} holds no bearer token`);
    assert.ok(!/AZURE_STORAGE|CLIENT_SECRET|PASSWORD\s*=/i.test(text), `${name} holds no secrets`);
  }
  assert.ok(!zip.get("capture-companion/tools/screenshot-capture/start-companion.sh").includes(13), "the shell launcher uses LF line endings");
  assert.ok(zip.get("capture-companion/tools/screenshot-capture/start-companion.cmd").toString().includes("\r\n"));
  const direct = await buildCompanionZip();
  assert.deepEqual(direct.files.sort(), names.sort());
});

test("old capture endpoints keep working and point at the companion instead of only a CLI string", async () => {
  const { base } = ctx;
  const { labId } = ctx.lab;
  const stateRes = await call(base, "GET", `/api/lab-builder/generated/${labId}/screenshots`);
  assert.equal(stateRes.status, 200);
  assert.match(stateRes.json.cliCommand, /capture\.js --generated-lab=/);
  assert.ok(stateRes.json.summary.learnSyncStatus);
  assert.equal((await call(base, "GET", `/api/generated-labs/${labId}/screenshots`)).status, 200);

  const nothing = await call(base, "POST", `/api/lab-builder/generated/${labId}/screenshots/capture`, { json: { featureIds: ["no-such-feature"] } });
  assert.equal(nothing.status, 200);
  assert.equal(nothing.json.capture.status, "nothing-to-capture");
  assert.equal((await call(base, "POST", `/api/lab-builder/generated/no-such-lab/screenshots/capture`, { json: {} })).status, 404);

  // In-process: no browser on the server means a structured companion result.
  const outcome = await captureLabScreenshots(ctx.generatedRoot, ctx.lab2.labId, {
    capturedDir: tmp("legacy-shared-"),
    driver: async () => ({ status: "browser-unavailable", error: "Playwright Chromium is not installed." }),
    companionFallback: async ({ labId: id }) => ({ queued: true, connected: true, jobId: "job_0123456789abcdef", message: `Queued for ${id}.` }),
  });
  assert.equal(outcome.status, 200);
  assert.equal(outcome.body.capture.status, "browser-unavailable");
  assert.equal(outcome.body.capture.companion.queued, true);
  assert.match(outcome.body.capture.message, /Queued for/);
  assert.match(outcome.body.capture.cliCommandHeaded, /--headed/, "the CLI command stays");
  const plain = await captureLabScreenshots(ctx.generatedRoot, ctx.lab2.labId, { capturedDir: tmp("legacy-shared-2-"), driver: async () => ({ status: "browser-unavailable", error: "x" }) });
  assert.equal(plain.body.capture.companion, undefined, "without a fallback the result is unchanged");
});

test("generate with captureScreenshots never waits on a tenant sign-in: it queues a job only when a companion is connected", async () => {
  const { base } = ctx;
  const generate = () =>
    call(base, "POST", "/api/lab-builder/generate", {
      json: { products: ["copilot-studio"], features: ["mc-memory"], harness: "microsoft-copilot", includeCore: false, useLearnMcp: false, useLlm: false, captureScreenshots: true },
    });

  // Disconnect every paired computer first.
  for (const device of (await call(base, "GET", "/api/capture/devices")).json.devices) {
    assert.equal((await call(base, "DELETE", `/api/capture/devices/${device.id}`)).status, 200);
  }
  assert.equal((await call(base, "DELETE", "/api/capture/devices/not-a-device")).status, 400);
  assert.equal((await call(base, "DELETE", `/api/capture/devices/${ctx.device.id}`)).status, 404, "already disconnected");
  assert.equal((await call(base, "GET", "/api/capture/status")).json.companion.connected, false);

  const started = Date.now();
  const without = await generate();
  assert.equal(without.status, 200, without.text);
  assert.ok(Date.now() - started < 30000, "the response is not held for a sign-in");
  assert.equal(without.json.captureQueued, false);
  assert.equal(without.json.captureReason, "no-companion");
  assert.equal(without.json.screenshotCapture.status, "not-queued");
  assert.equal(without.json.screenshotCapture.companion.canQueue, true);
  assert.match(without.json.screenshotCapture.companion.message, /Local Capture Companion/);
  assert.match(without.json.screenshotCapture.cliCommand, /capture\.js/);
  assert.ok(without.json.screenshotState.summary);

  const companion = new FakeCompanion(base);
  await companion.pair((await call(base, "POST", "/api/capture/pair")).json.code);
  await companion.heartbeat();
  const held = await generate();
  assert.equal(held.json.captureQueued, true, held.text);
  const saved = await call(base, "PUT", "/api/capture/targets", { json: { targets: { copilotStudioAgentUrl: "https://copilotstudio.microsoft.com/environments/abc/bots/def/overview" } } });
  assert.equal(saved.status, 200, saved.text);
  const withCompanion = await generate();
  assert.equal(withCompanion.status, 200, withCompanion.text);
  assert.equal(withCompanion.json.captureQueued, true);
  assert.match(withCompanion.json.captureJobId, /^job_[a-f0-9]{16}$/);
  assert.equal(withCompanion.json.screenshotCapture.status, "queued");
  const job = (await call(base, "GET", `/api/capture/jobs/${withCompanion.json.captureJobId}`)).json.job;
  assert.equal(job.target.labId, withCompanion.json.labId);
  assert.equal(job.status, "queued");

  const plainGenerate = await call(base, "POST", "/api/lab-builder/generate", {
    json: { products: ["copilot-studio"], features: ["mc-memory"], harness: "microsoft-copilot", includeCore: false, useLearnMcp: false, useLlm: false },
  });
  assert.equal(plainGenerate.json.captureQueued, false);
  assert.equal(plainGenerate.json.captureReason, null);
  assert.equal(plainGenerate.json.screenshotCapture, null);
});

test("request bodies are size limited", async () => {
  const { base } = ctx;
  const big = await call(base, "POST", "/api/capture/jobs", { json: { target: { type: "lab", labId: "x" }, filler: "x".repeat(80 * 1024) } });
  assert.equal(big.status, 413);
  assert.match(big.json.error, /too large/i);
  const huge = await call(base, "PUT", `/api/lab-builder/generated/${ctx.lab2.labId}/screenshots/${ctx.lab2.shots[0].filename}`, png(Buffer.concat([makePng().subarray(0, 8), Buffer.alloc(MAX_UPLOAD_BYTES + 100000)])));
  assert.equal(huge.status, 413);
  assert.match(huge.json.error, /too large/i);
});

// ── Rate limits and Blob write-through ───────────────────────────────────────

test("browser-facing capture routes are rate limited and mutations trigger Blob write-through", async (t) => {
  const dataDir = tmp("capture-rate-data-");
  const shared = tmp("capture-rate-shared-");
  let syncs = 0;
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  app.use((req, _res, next) => {
    req.body ??= {};
    next();
  });
  registerCaptureRoutes(app, {
    generatedRoot: ctx.generatedRoot,
    dataDir,
    env: { FEATURE_TOUR_SCREENSHOTS_DIR: shared, CAPTURE_PAIR_RATE_MAX: "3", CAPTURE_UPLOAD_RATE_MAX: "2", CAPTURE_EXCHANGE_RATE_MAX: "3", CAPTURE_MANAGE_RATE_MAX: "2" },
    scheduleBlobSync: () => {
      syncs += 1;
    },
    detectServerBrowser: async () => ({ available: false }),
  });
  const server = await new Promise((resolveServer) => {
    const s = app.listen(0, "127.0.0.1", () => resolveServer(s));
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  for (let i = 0; i < 3; i += 1) assert.equal((await call(base, "POST", "/api/capture/pair")).status, 201);
  const limited = await call(base, "POST", "/api/capture/pair");
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
  assert.match(limited.json.error, /Try again in \d+s/);
  assert.ok(syncs >= 3, "each mutating call schedules the Azure Blob sync");

  for (let i = 0; i < 3; i += 1) assert.equal((await call(base, "POST", "/api/capture/companion/pair", { json: { code: `BAD${i}-CODE` } })).status, 401);
  assert.equal((await call(base, "POST", "/api/capture/companion/pair", { json: { code: "BAD9-CODE" } })).status, 429);

  const slot = ctx.lab.shots[0].filename;
  const upload = () => call(base, "PUT", `/api/lab-builder/generated/${ctx.lab.labId}/screenshots/${slot}`, png(Buffer.from("nope")));
  assert.equal((await upload()).status, 422);
  assert.equal((await upload()).status, 422);
  assert.equal((await upload()).status, 429, "uploads have their own rate limit");

  assert.equal((await call(base, "POST", "/api/capture/jobs", { json: { target: { type: "lab", labId: "x" }, scope: "bogus" } })).status, 400);
  assert.equal((await call(base, "POST", "/api/capture/jobs", { json: {} })).status, 400);
  assert.equal((await call(base, "POST", "/api/capture/jobs", { json: {} })).status, 429, "job changes are rate limited");
  assert.equal((await call(base, "GET", "/api/capture/status")).status, 200, "reads are not limited");
});

test("server.js registers the capture routes once, after sign-in and Blob sync, before the SPA fallback", () => {
  const source = readFileSync(join(PORTAL_ROOT, "server.js"), "utf8");
  const importIndex = source.indexOf('import { registerCaptureRoutes } from "./lib/capture/routes.js"');
  const authIndex = source.indexOf('app.use("/api", requireAuth())');
  const syncIndex = source.indexOf("MUTATING_API_METHODS.has(req.method)");
  const registerIndex = source.indexOf("registerCaptureRoutes(app,");
  const spaIndex = source.indexOf("app.get(/.*/");
  assert.ok(importIndex > 0 && source.indexOf("registerCaptureRoutes(app,", registerIndex + 1) === -1);
  assert.ok(authIndex > 0 && syncIndex > authIndex && registerIndex > syncIndex && spaIndex > registerIndex);
  assert.match(source.slice(source.indexOf("registerCaptureRoutes(app,"), source.indexOf("registerCaptureRoutes(app,") + 260), /scheduleBlobSync/);
});
