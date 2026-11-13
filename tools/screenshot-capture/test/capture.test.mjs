import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { buildStatus } from "../status.mjs";
import { listFeatureManifests, resolveShotUrl, resolveStartUrl } from "../manifests.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const toolDir = path.resolve(here, "..");
const capture = path.join(toolDir, "capture.js");
const verify = path.join(toolDir, "verify-shots.js");
const status = path.join(toolDir, "status.mjs");
const PRODUCTS = ["copilot-studio", "m365-copilot-agent-builder", "sharepoint-ai", "ai-foundry", "m365-copilot-hub", "power-platform-ai-hub"];
const manifests = listFeatureManifests(toolDir);

// The capture tool must not see a CAPTURE_* variable unless a test sets one.
function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of Object.keys(env)) if (key.startsWith("CAPTURE_") && !(key in extra)) delete env[key];
  return env;
}

function run(script, args, extra = {}) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: cleanEnv(extra), cwd: toolDir });
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(zlib.crc32(body) >>> 0, 8 + data.length);
  return out;
}

// A valid, incompressible PNG above the 5 KB "real screenshot" bar. A test fixture only.
function fixturePng() {
  const width = 120;
  const height = 80;
  const rows = [];
  let seed = 99;
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

// A repo layout with the real manifests and an empty screenshots folder, for the checks that read captures.
function fixtureRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capture-repo-"));
  const dir = path.join(root, "tools", "screenshot-capture");
  const assets = path.join(root, "docs", "feature-tour", "screenshots");
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(assets, { recursive: true });
  for (const m of manifests) fs.copyFileSync(m.path, path.join(dir, m.file));
  return { root, dir, assets };
}

test("every product has a manifest", () => {
  assert.deepEqual(manifests.map((m) => m.product).sort(), [...PRODUCTS].sort());
  assert.equal(manifests[0].product, "copilot-studio", "Copilot Studio is listed first");
  assert.ok(manifests.every((m) => m.manifest && !m.error));
});

for (const product of PRODUCTS) {
  test(`capture.js --dry-run works for ${product} without launching a browser`, () => {
    const manifest = manifests.find((m) => m.product === product).manifest;
    const out = run(capture, [`--product=${product}`, "--dry-run"]);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, new RegExp(`Dry run: ${manifest.shots.length} selected shot\\(s\\)`));
    assert.match(out.stdout, new RegExp(`Product: ${product}`));
    assert.ok(out.stdout.includes(`Start URL: ${manifest.startUrl}`));
    assert.match(out.stdout, new RegExp(`Browser profile: \\.auth[\\\\/]${manifest.authProfile}`));
    assert.ok(out.stdout.includes(manifest.shots[0].filename));
  });
}

test("each product's browser profile is its own folder", () => {
  const profiles = manifests.map((m) => m.manifest.authProfile);
  assert.equal(new Set(profiles).size, profiles.length);
});

test("--features with --list covers every product, and --product=<id> narrows it", () => {
  const all = run(capture, ["--features", "--list"]);
  assert.equal(all.status, 0, all.stderr);
  for (const product of PRODUCTS) assert.ok(all.stdout.includes(`===== ${product} =====`), product);
  const one = run(capture, ["--product=sharepoint-ai", "--list"]);
  assert.match(one.stdout, /Shots manifest \(31 total/);
  assert.doesNotMatch(one.stdout, /=====/);
});

test("--features alone still means the Copilot Studio list, and --only and --feature filter any product", () => {
  const cs = run(capture, ["--features", "--dry-run", "--only=1"]);
  assert.match(cs.stdout, /Product: copilot-studio/);
  const spai = manifests.find((m) => m.product === "sharepoint-ai").manifest;
  const feature = spai.shots[0].feature;
  const filtered = run(capture, ["--product=sharepoint-ai", "--dry-run", `--feature=${feature}`]);
  const count = spai.shots.filter((s) => s.feature === feature).length;
  assert.match(filtered.stdout, new RegExp(`Dry run: ${count} selected shot\\(s\\)`));
  const only = run(capture, ["--product=ai-foundry", "--dry-run", "--only=2,4"]);
  assert.match(only.stdout, /Dry run: 2 selected shot\(s\)/);
});

test("--section limits a product's shots to one portal area and rejects an unknown area", () => {
  const spai = manifests.find((m) => m.product === "sharepoint-ai").manifest;
  const count = spai.shots.filter((s) => s.section === "sharepoint-admin-center").length;
  const out = run(capture, ["--product=sharepoint-ai", "--dry-run", "--section=sharepoint-admin-center"]);
  assert.match(out.stdout, new RegExp(`Dry run: ${count} selected shot\\(s\\)`));
  const bad = run(capture, ["--product=sharepoint-ai", "--dry-run", "--section=nope"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /unknown section\(s\): nope/);
});

test("a tenant address comes from the shot's environment variable, and a bad value is rejected", () => {
  const spai = manifests.find((m) => m.product === "sharepoint-ai").manifest;
  const shot = spai.shots.find((s) => s.urlEnv === "CAPTURE_SHAREPOINT_SITE_URL");
  assert.ok(shot, "a SharePoint site shot uses a tenant address");
  const unset = run(capture, ["--product=sharepoint-ai", "--dry-run", `--only=${shot.id}`]);
  assert.match(unset.stdout, /url: \(stay on current page\)/);
  assert.match(unset.stdout, /CAPTURE_SHAREPOINT_SITE_URL \(not set\)/);

  const set = run(capture, ["--product=sharepoint-ai", "--dry-run", `--only=${shot.id}`], { CAPTURE_SHAREPOINT_SITE_URL: "https://contoso.sharepoint.com/sites/team" });
  assert.match(set.stdout, /url: https:\/\/contoso\.sharepoint\.com\/sites\/team/);
  assert.match(set.stdout, /CAPTURE_SHAREPOINT_SITE_URL \(set\)/);

  const bad = run(capture, ["--product=sharepoint-ai", "--dry-run", `--only=${shot.id}`], { CAPTURE_SHAREPOINT_SITE_URL: "http://contoso.sharepoint.com" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /CAPTURE_SHAREPOINT_SITE_URL must be an https URL/);

  const start = run(capture, ["--product=power-platform-ai-hub", "--dry-run", "--only=1"], { CAPTURE_POWER_PLATFORM_START_URL: "https://make.powerapps.com/environments/abc/home" });
  assert.match(start.stdout, /Start URL: https:\/\/make\.powerapps\.com\/environments\/abc\/home/);
});

test("resolveShotUrl and resolveStartUrl prefer a valid https override", () => {
  assert.deepEqual(resolveShotUrl({ url: "https://a.example/", urlEnv: "CAPTURE_X" }, {}), { url: "https://a.example/", source: "manifest" });
  assert.deepEqual(resolveShotUrl({ url: "https://a.example/", urlEnv: "CAPTURE_X" }, { CAPTURE_X: "https://b.example/" }), { url: "https://b.example/", source: "CAPTURE_X" });
  assert.deepEqual(resolveShotUrl({}, {}), { url: null, source: null });
  assert.throws(() => resolveShotUrl({ urlEnv: "CAPTURE_X" }, { CAPTURE_X: "javascript:alert(1)" }), /must be an https URL/);
  assert.equal(resolveStartUrl({ startUrl: "https://s.example/", startUrlEnv: "CAPTURE_S" }, { CAPTURE_S: "https://t.example/" }), "https://t.example/");
  assert.equal(resolveStartUrl({ startUrl: "https://s.example/" }, {}), "https://s.example/");
});

test("capture.js rejects an unknown product, and --harness for a product without harnesses", () => {
  const unknown = run(capture, ["--product=nope", "--dry-run"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /no feature shot list for product "nope"/);
  const harness = run(capture, ["--product=ai-foundry", "--harness=standard", "--dry-run"]);
  assert.equal(harness.status, 1);
  assert.match(harness.stderr, /--harness only applies to Copilot Studio/);
});

test("manual shots are marked and do not get a URL", () => {
  const spai = manifests.find((m) => m.product === "sharepoint-ai").manifest;
  const manual = spai.shots.find((s) => s.manual);
  assert.ok(manual, "the PowerShell shot is manual");
  const out = run(capture, ["--product=sharepoint-ai", "--dry-run", `--only=${manual.id}`]);
  assert.match(out.stdout, /manual: yes/);
  assert.match(out.stdout, /url: \(stay on current page\)/);
});

test("verify-shots reports pending shots per product, passes by default, and fails in strict-missing mode", () => {
  const { root } = fixtureRepo();
  const base = run(verify, [`--root=${root}`, "--features", "--json"]);
  assert.equal(base.status, 0, base.stdout + base.stderr);
  const report = JSON.parse(base.stdout);
  assert.deepEqual(Object.keys(report.featureTour.products).sort(), [...PRODUCTS].sort());
  assert.equal(report.featureTour.captured, 0);
  assert.equal(report.featureTour.pending, report.featureTour.total);
  assert.equal(report.summary.critical, 0);
  assert.ok(report.featureTour.missing.every((m) => PRODUCTS.includes(m.product)));

  const strict = run(verify, [`--root=${root}`, "--features", "--strict-missing"]);
  assert.equal(strict.status, 1);
  assert.match(strict.stdout, /feature-shots-pending/);
  const scoped = run(verify, [`--root=${root}`, "--product=sharepoint-ai", "--strict-missing"]);
  assert.equal(scoped.status, 1);
  assert.doesNotMatch(scoped.stdout, /ai-foundry/);
});

test("verify-shots counts captured images per product, warns on a stub, and does not call another product's image an orphan", () => {
  const { root, assets } = fixtureRepo();
  const spai = manifests.find((m) => m.product === "sharepoint-ai").manifest.shots;
  const foundry = manifests.find((m) => m.product === "ai-foundry").manifest.shots;
  fs.writeFileSync(path.join(assets, spai[0].filename), fixturePng());
  fs.writeFileSync(path.join(assets, foundry[0].filename), fixturePng());
  fs.writeFileSync(path.join(assets, foundry[1].filename), Buffer.alloc(200, 1));

  const out = run(verify, [`--root=${root}`, "--features", "--json"]);
  assert.equal(out.status, 0, out.stdout);
  const report = JSON.parse(out.stdout);
  assert.equal(report.featureTour.products["sharepoint-ai"].captured, 1);
  assert.equal(report.featureTour.products["ai-foundry"].captured, 1);
  assert.equal(report.featureTour.captured, 2);
  const warnings = Object.values(report.labs).flatMap((l) => l.findings).filter((f) => f.severity === "warning");
  assert.ok(warnings.some((w) => w.code === "feature-shots-invalid-image" && w.filename === foundry[1].filename));
  assert.ok(!warnings.some((w) => w.code === "feature-shots-orphan"), "a shared folder holds every product's images");

  fs.writeFileSync(path.join(assets, "not-in-any-manifest.png"), fixturePng());
  const orphan = JSON.parse(run(verify, [`--root=${root}`, "--features", "--json"]).stdout);
  const orphans = Object.values(orphan.labs).flatMap((l) => l.findings).filter((f) => f.code === "feature-shots-orphan");
  assert.ok(orphans.length >= 1 && orphans.every((f) => f.filename === "not-in-any-manifest.png"));
});

test("verify-shots fails when a manifest is invalid or missing", () => {
  const { root, dir } = fixtureRepo();
  const file = path.join(dir, "feature-shots.ai-foundry.json");
  const list = JSON.parse(fs.readFileSync(file, "utf8"));
  list.shots[1].filename = list.shots[0].filename;
  fs.writeFileSync(file, JSON.stringify(list));
  const dup = run(verify, [`--root=${root}`, "--features"]);
  assert.equal(dup.status, 1);
  assert.match(dup.stdout, /feature-shots-duplicate-filename/);

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "capture-empty-"));
  fs.mkdirSync(path.join(empty, "tools", "screenshot-capture"), { recursive: true });
  const none = run(verify, [`--root=${empty}`, "--features"]);
  assert.equal(none.status, 1);
  assert.match(none.stdout, /No feature-shots\*\.json found/);

  assert.equal(run(verify, [`--root=${root}`, "--product=nope"]).status, 2);
});

test("status counts captured and pending per product and feature and prints the next command", () => {
  const { root, dir, assets } = fixtureRepo();
  const spai = manifests.find((m) => m.product === "sharepoint-ai").manifest.shots;
  const first = spai[0];
  fs.writeFileSync(path.join(assets, first.filename), fixturePng());

  const s = buildStatus({ manifestDir: dir, repoRoot: root });
  const product = s.products.find((p) => p.product === "sharepoint-ai");
  assert.equal(product.captured, 1);
  assert.equal(product.pending, spai.length - 1);
  assert.equal(product.manualPending, spai.filter((x) => x.manual).length);
  assert.ok(product.requiredEnv.includes("CAPTURE_SHAREPOINT_SITE_URL"));
  const feature = product.features.find((f) => f.feature === first.feature);
  assert.equal(feature.captured, 1);
  assert.ok(!feature.pending.includes(first.filename));
  assert.equal(s.total, s.captured + s.pending);
  assert.equal(s.nextProduct, "copilot-studio");
  assert.equal(s.nextCommand, "cd tools/screenshot-capture && node capture.js --product=copilot-studio --missing");

  const text = run(status, [`--root=${root}`, "--product=sharepoint-ai"]);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /Next command/);
  assert.match(text.stdout, /node capture\.js --product=sharepoint-ai --missing/);
  assert.match(text.stdout, /CAPTURE_SHAREPOINT_SITE_URL/);
  assert.match(text.stdout, /\[pending\] spai-/);
  assert.equal(run(status, [`--root=${root}`, "--strict"]).status, 1, "--strict fails while shots are pending");
  assert.equal(run(status, [`--root=${root}`, "--product=nope"]).status, 2);
  const json = JSON.parse(run(status, [`--root=${root}`, "--json"]).stdout);
  assert.equal(json.products.length, 6);
});

test("status says nothing is pending when every shot is captured", () => {
  const { root, dir, assets } = fixtureRepo();
  const png = fixturePng();
  for (const m of manifests) for (const shot of m.manifest.shots) fs.writeFileSync(path.join(assets, shot.filename), png);
  const s = buildStatus({ manifestDir: dir, repoRoot: root });
  assert.equal(s.pending, 0);
  assert.equal(s.nextCommand, null);
  const text = run(status, [`--root=${root}`]);
  assert.match(text.stdout, /Nothing pending/);
  assert.equal(run(status, [`--root=${root}`, "--strict"]).status, 0);
});
