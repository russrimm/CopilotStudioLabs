import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  KNOWN_PLACEHOLDER_SHA256,
  PLACEHOLDER_MARKER,
  PLACEHOLDER_MESSAGE,
  PLACEHOLDER_REASONS,
  detectPlaceholder,
  detectPlaceholderLayout,
  isPlaceholder,
  isPlaceholderImage,
} from "../placeholder-detect.mjs";
import { verifyImage } from "../image-verify.mjs";
import { detectInstalledBrowsers } from "../browsers.mjs";
import { loadPlaywrightModule, verifyCapturedImageBuffer, verifyCapturedImageFile } from "../lab-runner.mjs";
import { inspectScreenshot } from "../../feature-tour/lib/screenshots.mjs";
import { makePng } from "./fixtures/png.mjs";
import { bandedMock, encodePng, lightPlaceholder, realFlatPage, textChunk } from "./fixtures/placeholder-images.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "../../..");
const FIXTURES = join(here, "fixtures", "placeholders");
const PENDING_IMAGE = join(REPO, "portal", "lib", "lab-builder", "assets", "screenshot-pending.png");
const REAL = [
  join(REPO, "labs", "06-energy-weather-agent", "assets", "copilot-studio-home.png"),
  join(REPO, "labs", "06-energy-weather-agent", "screenshots", "28-connection-manager.png"),
  join(REPO, "labs", "06-energy-weather-agent", "screenshots", "dark", "29-connection-established.png"),
  join(REPO, "labs", "04-energy-ops-agent", "assets", "images", "issues-banner.png"),
];

const KNOWN_FIXTURES = readdirSync(FIXTURES).filter((name) => !name.includes("stamped"));
const STAMPED_FIXTURES = readdirSync(FIXTURES).filter((name) => name.includes("stamped"));

function tmp(t) {
  const dir = mkdtempSync(join(tmpdir(), "placeholder-detect-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

let playwright = null;
try {
  playwright = await loadPlaywrightModule(REPO);
} catch {
  playwright = null;
}
const installed = detectInstalledBrowsers();
const channel = installed.edge ? "msedge" : installed.chrome ? "chrome" : null;
const skipBrowser = !playwright?.chromium || !channel ? "no installed Edge or Chrome, or no Playwright" : false;

test("screenshots taken by a real browser are never flagged, even pale pages with a blue header", { skip: skipBrowser, timeout: 120_000 }, async () => {
  const browser = await playwright.chromium.launch({ channel, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 675 } });
    const pages = {
      "plain page": "<body style='margin:0;font:28px Segoe UI,sans-serif'><h1 style='margin:60px'>Hello</h1><p style='margin:60px'>A short paragraph on a white page.</p></body>",
      "blue header, pale body, little content": "<body style='margin:0;background:#f1f5f9;font:20px Segoe UI,sans-serif'><header style='background:#4f8ff7;color:#fff;height:70px;padding:20px 28px;box-sizing:border-box'>Settings</header><main style='text-align:center;padding-top:200px'>No agents yet</main></body>",
      "dark page": "<body style='margin:0;background:#1b1d23;color:#e4e6f0;font:20px Segoe UI,sans-serif'><nav style='background:#14161c;height:48px;padding:12px 16px;box-sizing:border-box'>Studio</nav><main style='padding:60px'>Topics<ul><li>Greeting</li><li>Fallback</li></ul></main></body>",
    };
    for (const [name, html] of Object.entries(pages)) {
      await page.setContent(html);
      const bytes = await page.screenshot({ type: "png" });
      assert.equal(detectPlaceholder(bytes).placeholder, false, name);
      assert.equal(detectPlaceholder(bytes, { structural: true }).reason, null, name);
    }
  } finally {
    await browser.close();
  }
});

test("every committed placeholder picture is recognized by its known hash, from bytes and from a path", () => {
  assert.equal(KNOWN_FIXTURES.length, 7, "six light placeholders and the Lab 06 mock-up");
  for (const name of KNOWN_FIXTURES) {
    const file = join(FIXTURES, name);
    const verdict = detectPlaceholder(readFileSync(file));
    assert.equal(verdict.placeholder, true, name);
    assert.equal(verdict.reason, PLACEHOLDER_REASONS.knownHash, name);
    assert.equal(verdict.confidence, 1);
    assert.ok(verdict.label, `${name} says where it came from`);
    assert.deepEqual(detectPlaceholder(file), verdict, `${name}: a path and its bytes agree`);
  }
});

test("files stamped by the generator scripts are recognized exactly by their PNG marker", () => {
  assert.equal(STAMPED_FIXTURES.length, 2);
  for (const name of STAMPED_FIXTURES) {
    const verdict = detectPlaceholder(join(FIXTURES, name), { structural: false });
    assert.equal(verdict.placeholder, true, name);
    assert.equal(verdict.reason, PLACEHOLDER_REASONS.marker, name);
  }
  const stamped = lightPlaceholder({ chunksBeforeData: [textChunk(PLACEHOLDER_MARKER.keyword, `${PLACEHOLDER_MARKER.value}: made by a script`)] });
  assert.equal(detectPlaceholder(stamped, { structural: false }).reason, PLACEHOLDER_REASONS.marker);
  const other = lightPlaceholder({ chunksBeforeData: [textChunk("Software", "Paint.NET 5.1")] });
  assert.equal(detectPlaceholder(other, { structural: false }).placeholder, false, "another program's Software entry is not the marker");
  const unrelated = encodePng(640, 400, (x, y) => [(x >> 2) % 256, (y >> 2) % 256, 128], { chunksBeforeData: [textChunk(PLACEHOLDER_MARKER.keyword, PLACEHOLDER_MARKER.value)] });
  assert.equal(isPlaceholder(unrelated), true, "the marker is trusted whatever the picture looks like");
});

test("the layout signature alone recognizes every placeholder file without any hash or marker", () => {
  for (const name of [...KNOWN_FIXTURES, ...STAMPED_FIXTURES]) {
    const family = detectPlaceholderLayout(readFileSync(join(FIXTURES, name)));
    assert.ok(family, `${name} matches a layout signature`);
    assert.equal(family, name.startsWith("dark") ? "banded-mock" : "light-header", name);
  }
});

test("regenerated variants of the same generators are caught by layout, not by hash", () => {
  const variants = [
    lightPlaceholder(),
    lightPlaceholder({ width: 1280, height: 720 }),
    lightPlaceholder({ width: 960, height: 540, bar: [30, 100, 220], body: [236, 240, 245], frameColor: [120, 130, 150] }),
    lightPlaceholder({ width: 1200, height: 700, text: [10, 10, 10] }),
  ];
  for (const bytes of variants) {
    const verdict = detectPlaceholder(bytes);
    assert.equal(verdict.placeholder, true);
    assert.equal(verdict.reason, PLACEHOLDER_REASONS.lightHeader);
    assert.ok(verdict.confidence >= 0.85 && verdict.confidence < 1);
  }
  for (const bytes of [bandedMock(), bandedMock({ width: 1280, height: 720, second: [40, 44, 56] }), bandedMock({ header: [10, 10, 14], footerHeight: 36 })]) {
    const verdict = detectPlaceholder(bytes);
    assert.equal(verdict.placeholder, true);
    assert.equal(verdict.reason, PLACEHOLDER_REASONS.bandedMock);
  }
});

test("the neutral pending image counts as a placeholder (pending), whatever the file is called", (t) => {
  const bytes = readFileSync(PENDING_IMAGE);
  assert.equal(bytes.length, 532);
  const verdict = detectPlaceholder(bytes);
  assert.equal(verdict.placeholder, true);
  assert.equal(verdict.reason, PLACEHOLDER_REASONS.pendingImage);
  const copy = join(tmp(t), "renamed.png");
  writeFileSync(copy, bytes);
  assert.equal(detectPlaceholder(copy).reason, PLACEHOLDER_REASONS.pendingImage);
});

test("real product screenshots are never flagged", () => {
  for (const file of REAL) {
    const verdict = detectPlaceholder(file);
    assert.equal(verdict.placeholder, false, file);
    assert.equal(verdict.reason, null);
    assert.equal(verdict.confidence, 0);
  }
  assert.equal(detectPlaceholder(REAL[1]).placeholder, false, "a real near-uniform page with a pale body and a white header");
});

test("near-uniform and dark real pages, and look-alikes missing a defining feature, are not placeholders", () => {
  const negatives = {
    "near-uniform real page": realFlatPage(),
    "dark real page": realFlatPage({ header: [20, 20, 20], body: [31, 31, 31], rail: [27, 27, 27] }),
    "blue-header page without the frame": lightPlaceholder({ frame: false }),
    "pale body with a white header and a frame": lightPlaceholder({ bar: [255, 255, 255] }),
    "bars without a matching footer": bandedMock({ footer: [60, 60, 70] }),
    "one color": encodePng(800, 450, () => [241, 245, 249]),
    "busy noise": makePng({ width: 800, height: 450, mode: "noise" }),
    "mostly one color": makePng({ width: 800, height: 450, mode: "mostly" }),
    "white page with noisy bands": makePng({ width: 800, height: 450, mode: "ui" }),
  };
  for (const [name, bytes] of Object.entries(negatives)) assert.equal(detectPlaceholder(bytes).placeholder, false, name);
});

test("inputs that cannot be placeholders are quickly negative", (t) => {
  assert.equal(detectPlaceholder(join(tmp(t), "missing.png")).placeholder, false);
  assert.equal(detectPlaceholder(Buffer.from("not an image")).placeholder, false);
  assert.equal(detectPlaceholder(Buffer.alloc(0)).placeholder, false);
  assert.equal(detectPlaceholder(null).placeholder, false);
  assert.equal(detectPlaceholder(Buffer.concat([readFileSync(join(FIXTURES, KNOWN_FIXTURES[0])), Buffer.alloc(300 * 1024)])).placeholder, false, "bigger than any generated placeholder");
  assert.equal(isPlaceholderImage, detectPlaceholder);
  assert.ok(Object.keys(KNOWN_PLACEHOLDER_SHA256).every((hash) => /^[0-9a-f]{64}$/.test(hash)));
});

test("detection is fast and a repeat is cached", () => {
  const files = [...KNOWN_FIXTURES.map((n) => join(FIXTURES, n)), ...REAL];
  const buffers = [lightPlaceholder({ width: 1100, height: 620 }), bandedMock({ width: 1100, height: 640 }), realFlatPage({ width: 1100, height: 620 })];
  for (const bytes of buffers) detectPlaceholder(bytes);
  const start = performance.now();
  for (let i = 0; i < 40; i += 1) for (const bytes of buffers) detectPlaceholder(Buffer.concat([bytes.subarray(0, bytes.length - 12), Buffer.alloc(i % 3), bytes.subarray(bytes.length - 12)]));
  const files1 = performance.now();
  for (const file of files) detectPlaceholder(file);
  for (const file of files) detectPlaceholder(file);
  const done = performance.now();
  assert.ok(files1 - start < 5000, `120 uncached layout checks took ${Math.round(files1 - start)} ms`);
  assert.ok(done - files1 < 1500, `${files.length * 2} file checks took ${Math.round(done - files1)} ms`);
});

test("the companion verifies with the same detector: a placeholder fails upload verification with a plain-language reason", () => {
  for (const name of [...KNOWN_FIXTURES, ...STAMPED_FIXTURES]) {
    const result = verifyImage(readFileSync(join(FIXTURES, name)), { filename: "shot.png" });
    assert.equal(result.ok, false, name);
    assert.equal(result.level, "fail");
    assert.equal(result.reasons[0].code, "placeholder", name);
    assert.equal(result.reasons[0].message, PLACEHOLDER_MESSAGE);
    assert.deepEqual(result.reasons.map((r) => r.code), ["placeholder"]);
  }
  const pending = verifyImage(readFileSync(PENDING_IMAGE), { filename: "shot.png" });
  assert.equal(pending.reasons[0].code, "placeholder", "the pending image is a placeholder, not just 'too small'");
  assert.equal(verifyImage(makePng({ mode: "ui" }), { filename: "shot.png" }).level, "pass");
  assert.equal(verifyImage(readFileSync(REAL[0]), { filename: "shot.png" }).reasons.some((r) => r.code === "placeholder"), false);
  assert.match(PLACEHOLDER_MESSAGE, /placeholder picture, not a screenshot of the product/);
});

test("lab-runner treats a placeholder as not captured whatever its size", (t) => {
  const filler = readFileSync(join(FIXTURES, KNOWN_FIXTURES[0]));
  assert.ok(filler.length > 5 * 1024);
  const buffer = verifyCapturedImageBuffer(filler, ".png");
  assert.equal(buffer.ok, false);
  assert.equal(buffer.placeholder, true);
  assert.equal(buffer.reason, PLACEHOLDER_MESSAGE);
  const file = join(tmp(t), "shot.png");
  writeFileSync(file, filler);
  assert.equal(verifyCapturedImageFile(file).ok, false);
  assert.equal(verifyCapturedImageFile(REAL[0]).ok, true);
  assert.equal(verifyCapturedImageBuffer(readFileSync(REAL[0]), ".png").ok, true);
});

test("feature tour inspection reports a placeholder as pending", (t) => {
  const dir = tmp(t);
  writeFileSync(join(dir, "filler.png"), readFileSync(join(FIXTURES, KNOWN_FIXTURES[1])));
  writeFileSync(join(dir, "pending.png"), readFileSync(PENDING_IMAGE));
  writeFileSync(join(dir, "real.png"), readFileSync(REAL[0]));
  assert.deepEqual(inspectScreenshot(dir, "filler.png"), { status: "pending", reason: "placeholder", bytes: readFileSync(join(FIXTURES, KNOWN_FIXTURES[1])).length });
  assert.equal(inspectScreenshot(dir, "pending.png").status, "pending");
  assert.equal(inspectScreenshot(dir, "real.png").status, "ready");
});

test("the detector module is standalone: it imports only Node built-ins, so the companion download can ship it", () => {
  const source = readFileSync(join(here, "..", "placeholder-detect.mjs"), "utf8");
  const specifiers = [...source.matchAll(/^import .* from "([^"]+)";?$/gm)].map((m) => m[1]);
  assert.ok(specifiers.length > 0);
  for (const specifier of specifiers) assert.match(specifier, /^node:/, `${specifier} must be a Node built-in`);
});

test("verify-shots --check-state flags a captioned filler picture as critical, and the pending image as a warning only", (t) => {
  const root = tmp(t);
  const assets = join(root, "labs", "99-demo", "assets");
  mkdirSync(assets, { recursive: true });
  mkdirSync(join(root, "tools", "screenshot-capture"), { recursive: true });
  writeFileSync(join(root, "labs", "99-demo", "index.md"), "# Demo\n\n![A filler picture that pretends to be a screenshot](assets/filler.png)\n\n![Still to capture with the pending image](assets/pending.png)\n\n![A real screenshot of the product](assets/real.png)\n");
  writeFileSync(join(assets, "filler.png"), readFileSync(join(FIXTURES, KNOWN_FIXTURES[2])));
  writeFileSync(join(assets, "pending.png"), readFileSync(PENDING_IMAGE));
  writeFileSync(join(assets, "real.png"), readFileSync(REAL[0]));
  const run = (extra = []) =>
    spawnSync(process.execPath, [join(here, "..", "verify-shots.js"), `--root=${root}`, "--json", ...extra], { encoding: "utf8" });
  const result = run(["--check-state", "--lab=99-demo"]);
  const report = JSON.parse(result.stdout);
  const findings = report.labs["99-demo"].findings;
  assert.ok(findings.some((f) => f.code === "restored-placeholder" && f.severity === "critical" && f.path.endsWith("filler.png")));
  assert.ok(findings.some((f) => f.code === "placeholder-image" && f.severity === "warning" && f.path.endsWith("pending.png")));
  assert.ok(!findings.some((f) => f.path?.endsWith("real.png") && /placeholder/.test(f.code)));
  assert.ok(!findings.some((f) => f.code === "restored-placeholder" && f.path.endsWith("pending.png")), "the pending image is the intended stand-in");
  assert.equal(result.status, 1, "a filler picture fails the check-state run");
});
