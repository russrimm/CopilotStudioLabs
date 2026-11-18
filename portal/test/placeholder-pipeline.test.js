import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { PassThrough } from "node:stream";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

import { generateLab } from "../lib/lab-builder/generator.js";
import { decorateGeneratedHtml, listGeneratedLabs, readGeneratedLab, readGeneratedLabTopicDocument, resolveGeneratedAsset } from "../lib/lab-builder/generated-labs.js";
import { getLabScreenshotsStatus, repairLabPlaceholders } from "../lib/lab-builder/lab-screenshots.js";
import { findPlaceholderAssets } from "../lib/lab-builder/placeholder-repair.js";
import { isPlaceholder } from "../lib/lab-builder/placeholder-detect.js";
import { PLACEHOLDER_PATH } from "../lib/lab-builder/slots.js";
import { renderLabMarkdown } from "../lib/markdown.js";
import {
  exportGeneratedLab,
  renderGeneratedLabDocx,
  renderGeneratedLabFacilitatorMarkdown,
  renderGeneratedLabHtml,
  renderGeneratedLabMarkdown,
  renderGeneratedLabPdf,
  renderGeneratedLabPptx,
} from "../lib/exporter.js";
import { makePng } from "../../tools/screenshot-capture/test/fixtures/png.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PORTAL_ROOT = resolve(here, "..");
const REPO = resolve(PORTAL_ROOT, "..");
const FIXTURES = join(REPO, "tools", "screenshot-capture", "test", "fixtures", "placeholders");
const FILLER_BY_SLOT = {
  "topics-overview.png": readFileSync(join(FIXTURES, "light-topics-overview.png")),
  "trigger-phrases.png": readFileSync(join(FIXTURES, "light-trigger-phrases.png")),
};
const SLOTS = Object.keys(FILLER_BY_SLOT);
const PENDING = readFileSync(PLACEHOLDER_PATH);
const REAL_HOME = readFileSync(join(REPO, "labs", "06-energy-weather-agent", "assets", "copilot-studio-home.png"));

const ISOLATED_SHARED_SHOTS = mkdtempSync(join(tmpdir(), "placeholder-shared-"));
process.env.FEATURE_TOUR_SCREENSHOTS_DIR = ISOLATED_SHARED_SHOTS;
const cleanups = [() => rmSync(ISOLATED_SHARED_SHOTS, { recursive: true, force: true })];
process.on("exit", () => cleanups.forEach((fn) => { try { fn(); } catch { /* best effort */ } }));

function tmp(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The generator reuses pictures from the repository's own labs/ folder, so a generated lab here is built from the real files. */
async function generate(outputRoot) {
  const build = await generateLab(
    { products: ["copilot-studio"], features: ["create-agent", "topics"], includeCore: false },
    { outputRoot, useLearnMcp: false, useLlm: false },
  );
  assert.equal(build.status, "complete");
  return build;
}

const readJson = (labDir, rel) => JSON.parse(readFileSync(join(labDir, rel), "utf8"));
const writeJson = (labDir, rel, value) => writeFileSync(join(labDir, rel), `${JSON.stringify(value, null, 2)}\n`);
const bytesOf = (labDir, name) => readFileSync(join(labDir, "assets", name));
/** Compares bytes without letting a failed assertion try to print megabytes of diff. */
const sameBytes = (actual, expected, message) => assert.ok(Buffer.isBuffer(actual) && actual.equals(expected), message);

/**
 * A lab as the portal built it before the fix. The generator now leaves the two slots pending, so this rewrites the lab
 * the way the old generator left it: the captioned filler copied into assets/, both slots reused and captured in the
 * plan and the learn state, a "Reused from lab" credit under each figure, the old counts in the manifest, and the
 * pictures embedded in index.html.
 */
async function legacyLab(t) {
  const outputRoot = tmp(t, "placeholder-legacy-");
  const build = await generate(outputRoot);
  const labDir = build.outputDir;
  const plan = readJson(labDir, "screenshots/shots.json");
  const state = readJson(labDir, "screenshots/learn-state.json");
  const manifest = readJson(labDir, "manifest.json");
  let markdown = readFileSync(join(labDir, "index.md"), "utf8");
  let html = readFileSync(join(labDir, "index.html"), "utf8");
  const stamp = "2026-11-10T12:00:00.000Z";
  for (const name of SLOTS) {
    const shot = plan.shots.find((s) => s.filename === name);
    assert.ok(shot, `${name} is in the plan`);
    assert.equal(shot.status, "pending", "the fixed generator leaves the slot pending");
    Object.assign(shot, { origin: "reused", status: "captured", capturedAt: stamp });
    state.shots[name] = { ...state.shots[name], captured: true, capturedAt: stamp, captureSource: "reused", stale: false };
    manifest.screenshots.reused += 1;
    manifest.screenshots.pending -= 1;
    manifest.screenshots.toCapture -= 1;
    writeFileSync(join(labDir, "assets", name), FILLER_BY_SLOT[name]);
    markdown = markdown.replace(new RegExp(`(\\]\\(assets/${name.replace(".", "\\.")}\\)\\s+\\*Figure \\d+\\.\\d+\\. .+?)\\.\\*`), "$1. Reused from lab `02-conversational-design-fundamentals`.*");
    html = html.replace(`src="assets/${name}"`, `src="data:image/png;base64,${FILLER_BY_SLOT[name].toString("base64")}"`);
  }
  assert.equal((markdown.match(/Reused from lab `02-conversational-design-fundamentals`/g) || []).length, 2);
  writeJson(labDir, "screenshots/shots.json", plan);
  writeJson(labDir, "screenshots/learn-state.json", state);
  writeJson(labDir, "manifest.json", manifest);
  writeFileSync(join(labDir, "index.md"), markdown);
  writeFileSync(join(labDir, "index.html"), html);
  assert.equal((html.match(/data:image\/png;base64,iVBOR/g) || []).length >= 2, true, "index.html embeds the old pictures");
  return { outputRoot, labId: build.labId, labDir };
}

function readZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i += 1) {
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nlen = buf.readUInt16LE(off + 28);
    const elen = buf.readUInt16LE(off + 30);
    const clen = buf.readUInt16LE(off + 32);
    const local = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nlen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + csize);
    entries.set(name, method === 8 ? zlib.inflateRawSync(data) : data);
    off += 46 + nlen + elen + clen;
  }
  return entries;
}

async function zipExport(root, labId) {
  const out = new PassThrough();
  const chunks = [];
  out.on("data", (c) => chunks.push(c));
  await exportGeneratedLab(root, labId, {}, out, { resolveAsset: resolveGeneratedAsset });
  return Buffer.concat(chunks);
}

function snapshot(labDir) {
  const files = ["manifest.json", "index.md", "index.html", "screenshots/shots.json", "screenshots/learn-state.json"];
  return Object.fromEntries(files.map((f) => [f, statSync(join(labDir, f)).mtimeMs]));
}

test("a generated lab never copies a placeholder in as a screenshot, and counts it pending", async (t) => {
  const outputRoot = tmp(t, "placeholder-new-");
  const build = await generate(outputRoot);
  const labDir = build.outputDir;

  for (const name of SLOTS) {
    sameBytes(bytesOf(labDir, name), PENDING, `${name} is the standard pending image`);
  }
  sameBytes(bytesOf(labDir, "copilot-studio-home.png"), REAL_HOME, "a real reused screenshot is still copied in");

  const plan = readJson(labDir, "screenshots/shots.json");
  const state = readJson(labDir, "screenshots/learn-state.json");
  for (const name of SLOTS) {
    const shot = plan.shots.find((s) => s.filename === name);
    assert.equal(shot.status, "pending", name);
    assert.equal(shot.origin, "slot", name);
    assert.equal(state.shots[name].captured, false, name);
    assert.equal(state.shots[name].captureSource, null, name);
  }
  const home = plan.shots.find((s) => s.filename === "copilot-studio-home.png");
  assert.equal(home.status, "captured");

  const markdown = readFileSync(join(labDir, "index.md"), "utf8");
  assert.doesNotMatch(markdown, /Reused from lab `02-conversational-design-fundamentals`/);
  assert.match(markdown, /Reused from lab `06-energy-weather-agent`/);
  assert.equal(build.manifest.screenshots.reused, 1);

  const status = getLabScreenshotsStatus(outputRoot, build.labId, { capturedDir: ISOLATED_SHARED_SHOTS }).body;
  for (const name of SLOTS) {
    const shot = status.shots.find((s) => s.filename === name);
    assert.equal(shot.captured, false, name);
    assert.equal(shot.capturedSource, null, name);
    assert.equal(shot.syncStatus, "missing-screenshot", name);
  }
  assert.equal(status.summary.captured, 1);
  assert.equal(status.summary.missing, status.summary.total - 1);
  assert.equal(status.summary.learnSyncStatus, "missing-screenshot");
});

test("opening a lab built before the fix repairs it: pending slots, the pending image, honest counts, and nothing rewritten twice", async (t) => {
  const { outputRoot, labId, labDir } = await legacyLab(t);
  const realBefore = bytesOf(labDir, "copilot-studio-home.png");

  // Before anything repairs the lab: the asset route and the preview already refuse to show the filler as a capture.
  assert.equal(findPlaceholderAssets(labDir).length, 2);
  for (const name of SLOTS) {
    const asset = resolveGeneratedAsset(outputRoot, labId, name, { capturedDir: ISOLATED_SHARED_SHOTS });
    assert.equal(asset.status, 200);
    assert.equal(asset.path, PLACEHOLDER_PATH, `${name} is served as the standard pending image`);
    assert.equal(asset.type, "image/png");
  }
  const decorated = decorateGeneratedHtml(SLOTS.map((n) => `<img alt="x" src="assets/${n}">`).join(""), labId, labDir, { capturedDir: ISOLATED_SHARED_SHOTS });
  assert.deepEqual(decorated.pending, SLOTS);
  assert.equal((decorated.html.match(/Screenshot pending\./g) || []).length, 2);

  // The first read repairs everything.
  const status = getLabScreenshotsStatus(outputRoot, labId, { capturedDir: ISOLATED_SHARED_SHOTS }).body;
  for (const name of SLOTS) {
    sameBytes(bytesOf(labDir, name), PENDING, `${name} was replaced`);
    const shot = status.shots.find((s) => s.filename === name);
    assert.equal(shot.captured, false);
    assert.equal(shot.capturedSource, null);
    assert.equal(shot.capturedInLab, false);
    assert.equal(shot.captureSource, null);
    assert.equal(shot.capturedAt, null);
    assert.equal(shot.stale, false);
    assert.equal(shot.syncStatus, "missing-screenshot");
    assert.equal(shot.origin, "slot");
  }
  sameBytes(bytesOf(labDir, "copilot-studio-home.png"), realBefore, "a real capture is untouched");
  assert.equal(status.summary.captured, 1);
  assert.equal(status.summary.missing, status.summary.total - 1);
  assert.equal(status.summary.learnSyncStatus, "missing-screenshot");

  const plan = readJson(labDir, "screenshots/shots.json");
  const state = readJson(labDir, "screenshots/learn-state.json");
  for (const name of SLOTS) {
    assert.equal(plan.shots.find((s) => s.filename === name).status, "pending");
    assert.equal(state.shots[name].captured, false);
    assert.equal(state.shots[name].captureSource, null);
  }
  assert.equal(state.shots["copilot-studio-home.png"].captured, true);
  const manifest = readJson(labDir, "manifest.json");
  assert.equal(manifest.screenshots.reused, 1);
  assert.equal(manifest.screenshots.pending, manifest.screenshots.total - 1 - manifest.screenshots.captured);
  assert.doesNotMatch(readFileSync(join(labDir, "index.md"), "utf8"), /Reused from lab `02-conversational-design-fundamentals`/);
  assert.doesNotMatch(readFileSync(join(labDir, "index.html"), "utf8"), new RegExp(`assets/${SLOTS[0]}[^>]*>\\s*<[^>]*>\\s*data:image`), "index.html no longer embeds the old pictures");

  // A second read changes nothing.
  const before = snapshot(labDir);
  const again = repairLabPlaceholders(labDir, { labId, capturedDir: ISOLATED_SHARED_SHOTS });
  assert.equal(again.changed, false);
  assert.deepEqual(again.placeholders, []);
  getLabScreenshotsStatus(outputRoot, labId, { capturedDir: ISOLATED_SHARED_SHOTS });
  assert.deepEqual(snapshot(labDir), before, "nothing is rewritten when it is already correct");
  assert.deepEqual(findPlaceholderAssets(labDir), []);

  // The preview marks both slots with the standard note, and the lab list shows honest counts.
  const preview = readGeneratedLab(outputRoot, labId, renderLabMarkdown);
  assert.equal(preview.status, 200);
  for (const name of SLOTS) assert.ok(preview.body.pendingScreenshots.includes(name), `${name} is pending in the preview`);
  assert.ok((preview.body.html.match(/Screenshot pending\./g) || []).length >= 2);
  assert.equal(preview.body.screenshotState.summary.captured, 1);
  const listed = listGeneratedLabs(outputRoot).labs.find((l) => l.labId === labId);
  assert.equal(listed.screenshots.captured, manifest.screenshots.captured);
  assert.equal(listed.screenshots.learnSyncStatus, "missing-screenshot");
});

test("the preview, the topic documents, the lab list, and every export repair a legacy lab and never show the filler", async (t) => {
  const { outputRoot, labId, labDir } = await legacyLab(t);
  // Reading a topic document repairs first, so the stored documents are rebuilt without the filler.
  const doc = readGeneratedLabTopicDocument(outputRoot, labId, 1, "docx");
  assert.equal(doc.status, 200);
  for (const name of SLOTS) sameBytes(bytesOf(labDir, name), PENDING);

  const second = await legacyLab(t);
  const fillers = Object.values(FILLER_BY_SLOT).map((bytes) => bytes.toString("base64").slice(0, 400));
  const noFiller = (buffer, label) => {
    const text = buffer.toString("latin1");
    for (const marker of fillers) assert.ok(!text.includes(marker), `${label} must not embed the filler picture`);
    for (const bytes of Object.values(FILLER_BY_SLOT)) assert.equal(buffer.indexOf(bytes.subarray(0, 2000)), -1, `${label} must not contain the filler bytes`);
  };
  const run = { root: second.outputRoot, id: second.labId };
  const html = renderGeneratedLabHtml(run.root, run.id, {}, { resolveAsset: resolveGeneratedAsset });
  assert.equal(html.status, 200);
  noFiller(Buffer.from(html.html), "HTML");
  assert.ok(html.html.includes(PENDING.toString("base64").slice(0, 120)), "HTML shows the standard pending image for the slot");

  for (const [label, render] of [["DOCX", renderGeneratedLabDocx], ["PPTX", renderGeneratedLabPptx], ["PDF", renderGeneratedLabPdf]]) {
    const result = render(run.root, run.id, {}, { resolveAsset: resolveGeneratedAsset });
    assert.equal(result.status, 200, label);
    const buffer = result.buffer || result.bytes || result.docx || result.pptx || result.pdf;
    assert.ok(Buffer.isBuffer(buffer), `${label} returns a buffer`);
    noFiller(label === "PDF" ? buffer : Buffer.concat([...readZip(buffer).values()]), label);
  }
  const md = renderGeneratedLabMarkdown(run.root, run.id);
  assert.equal(md.status, 200);
  assert.doesNotMatch(md.markdown, /Reused from lab `02-conversational-design-fundamentals`/);
  const guide = renderGeneratedLabFacilitatorMarkdown(run.root, run.id);
  assert.equal(guide.status, 200);

  const zip = readZip(await zipExport(run.root, run.id));
  for (const name of SLOTS) {
    const entry = [...zip.entries()].find(([key]) => key.endsWith(`/assets/${name}`));
    assert.ok(entry, `${name} is in the ZIP`);
    sameBytes(entry[1], PENDING, `${name} ships as the standard pending image`);
  }
  sameBytes([...zip.entries()].find(([key]) => key.endsWith("/assets/copilot-studio-home.png"))[1], REAL_HOME);
  for (const [key, bytes] of zip) if (key.endsWith(".html")) noFiller(bytes, key);
});

test("the repair CLI reports on a dry run, repairs on apply, and finds nothing the second time", async (t) => {
  const { outputRoot, labId, labDir } = await legacyLab(t);
  const cli = join(REPO, "tools", "lab-builder", "repair-placeholders.mjs");
  const run = (...args) => spawnSync(process.execPath, [cli, `--root=${outputRoot}`, "--json", ...args], { encoding: "utf8", env: { ...process.env, FEATURE_TOUR_SCREENSHOTS_DIR: ISOLATED_SHARED_SHOTS } });
  const state = () => JSON.stringify(readdirSync(join(labDir, "assets")).sort().map((n) => [n, statSync(join(labDir, "assets", n)).size])) + readFileSync(join(labDir, "screenshots", "shots.json"), "utf8");

  const before = state();
  const dry = run("--dry-run");
  assert.equal(dry.status, 0, dry.stderr);
  const dryReport = JSON.parse(dry.stdout);
  assert.equal(dryReport.mode, "dry-run");
  assert.deepEqual([dryReport.totals.labs, dryReport.totals.affected, dryReport.totals.placeholders, dryReport.totals.slots, dryReport.totals.repaired], [1, 1, 2, 2, 0]);
  assert.equal(dryReport.labs[0].labId, labId);
  assert.deepEqual(dryReport.labs[0].files.sort(), [...SLOTS].sort());
  assert.equal(state(), before, "a dry run changes nothing");
  assert.equal(findPlaceholderAssets(labDir).length, 2);

  const apply = JSON.parse(run("--apply").stdout);
  assert.deepEqual([apply.totals.affected, apply.totals.placeholders, apply.totals.repaired, apply.totals.errors], [1, 2, 1, 0]);
  for (const name of SLOTS) sameBytes(bytesOf(labDir, name), PENDING);
  const second = JSON.parse(run("--apply").stdout);
  assert.deepEqual([second.totals.affected, second.totals.placeholders, second.totals.repaired], [0, 0, 0]);

  assert.equal(spawnSync(process.execPath, [cli], { encoding: "utf8" }).status, 2, "a mode is required");
  assert.equal(run("--apply", "--lab=no-such-lab").status, 2);
});

test("several processes repairing the same lab at once leave one consistent result", async (t) => {
  const { outputRoot, labDir } = await legacyLab(t);
  const cli = join(REPO, "tools", "lab-builder", "repair-placeholders.mjs");
  const env = { ...process.env, FEATURE_TOUR_SCREENSHOTS_DIR: ISOLATED_SHARED_SHOTS };
  const results = await Promise.all(
    Array.from({ length: 3 }, () => new Promise((done) => {
      const child = spawn(process.execPath, [cli, "--apply", `--root=${outputRoot}`, "--json"], { env, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (c) => { out += c; });
      child.on("close", (code) => done({ code, out }));
    })),
  );
  for (const r of results) assert.equal(r.code, 0, r.out);
  const reports = results.map((r) => JSON.parse(r.out));
  assert.ok(reports.some((r) => r.totals.repaired === 1), "one process did the repair");
  assert.ok(reports.every((r) => r.totals.errors === 0), "none of them failed");
  for (const name of SLOTS) sameBytes(bytesOf(labDir, name), PENDING);
  const leftovers = [labDir, join(labDir, "assets"), join(labDir, "screenshots")].flatMap((d) => readdirSync(d)).filter((n) => n.endsWith(".tmp"));
  assert.deepEqual(leftovers, [], "no temporary file is left behind");
  assert.equal(readJson(labDir, "screenshots/shots.json").shots.filter((s) => SLOTS.includes(s.filename) && s.status !== "pending").length, 0);
  assert.equal(JSON.parse(spawnSync(process.execPath, [cli, "--dry-run", `--root=${outputRoot}`, "--json"], { encoding: "utf8", env }).stdout).totals.affected, 0);
});

function freePort() {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
}

test("over HTTP: the status, the preview, the asset, and an upload of a placeholder all treat it as pending", async (t) => {
  const { labId, labDir } = await legacyLab(t);
  const storageRoot = tmp(t, "placeholder-server-");
  mkdirSync(join(storageRoot, "generated-labs"), { recursive: true });
  cpSync(labDir, join(storageRoot, "generated-labs", labId), { recursive: true });

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let stderr = "";
  const child = spawn(process.execPath, ["server.js"], {
    cwd: PORTAL_ROOT,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", PORTAL_AUTH_DISABLED: "true", AZURE_KEYVAULT_URL: "", PORTAL_STORAGE_ROOT: storageRoot, FEATURE_TOUR_SCREENSHOTS_DIR: "", LAB_BUILDER_LINK_CHECK: "off", LAB_BUILDER_LLM: "off" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (c) => { stderr += c; });
  t.after(() => child.kill());
  const deadline = Date.now() + 25000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${stderr.slice(-600)}`);
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error("server did not start");
    await new Promise((r) => setTimeout(r, 150));
  }

  const status = await (await fetch(`${base}/api/lab-builder/generated/${labId}/screenshots`)).json();
  for (const name of SLOTS) {
    const shot = status.shots.find((s) => s.filename === name);
    assert.equal(shot.captured, false, `${name} is not Captured`);
    assert.equal(shot.syncStatus, "missing-screenshot");
  }
  assert.equal(status.summary.captured, 1, "only the real screenshot counts");

  const preview = await (await fetch(`${base}/api/lab-builder/generated/${labId}`)).json();
  assert.ok(SLOTS.every((n) => preview.pendingScreenshots.includes(n)));
  assert.match(preview.html, /Screenshot pending\./);

  const asset = await fetch(`${base}/api/lab-builder/generated/${labId}/assets/${SLOTS[0]}`);
  assert.equal(asset.status, 200);
  sameBytes(Buffer.from(await asset.arrayBuffer()), PENDING, "the asset route serves the standard pending image");

  const upload = await fetch(`${base}/api/lab-builder/generated/${labId}/screenshots/${SLOTS[0]}`, { method: "PUT", headers: { "Content-Type": "image/png" }, body: FILLER_BY_SLOT[SLOTS[0]] });
  const body = await upload.json();
  assert.equal(upload.status, 422);
  assert.equal(body.outcome, "rejected");
  assert.equal(body.message, "This is a placeholder picture, not a screenshot of the product.");
  assert.equal(body.verification.reasons[0].code, "placeholder");
  sameBytes(readFileSync(join(storageRoot, "generated-labs", labId, "assets", SLOTS[0])), PENDING, "a rejected upload is never written");

  const real = await fetch(`${base}/api/lab-builder/generated/${labId}/screenshots/${SLOTS[0]}`, { method: "PUT", headers: { "Content-Type": "image/png" }, body: makePng({ mode: "ui", seed: 12 }) });
  assert.equal(real.status, 200, "a real picture is still accepted");
  assert.ok(!isPlaceholder(join(storageRoot, "generated-labs", labId, "assets", SLOTS[0])));
});
