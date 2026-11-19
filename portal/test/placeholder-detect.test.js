import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as portalDetector from "../lib/lab-builder/placeholder-detect.js";
import * as companionDetector from "../../tools/screenshot-capture/placeholder-detect.mjs";
import { verifyImage } from "../../tools/screenshot-capture/image-verify.mjs";
import { verifyCapturedImageBuffer } from "../../tools/screenshot-capture/lab-runner.mjs";
import { verifyUpload } from "../lib/capture/verify-upload.js";
import { COMPANION_FILES, buildCompanionZip } from "../lib/capture/companion-zip.js";
import { capturedImage, resolveLabScreenshot } from "../lib/lab-builder/captured.js";
import { copyScreenshots, planScreenshots } from "../lib/lab-builder/screenshots.js";
import { PLACEHOLDER_PATH } from "../lib/lab-builder/slots.js";
import { makePng } from "../../tools/screenshot-capture/test/fixtures/png.mjs";
import { bandedMock, lightPlaceholder, realFlatPage } from "../../tools/screenshot-capture/test/fixtures/placeholder-images.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "../..");
const FIXTURES = join(REPO, "tools", "screenshot-capture", "test", "fixtures", "placeholders");
const FILLERS = readdirSync(FIXTURES).map((name) => join(FIXTURES, name));
const REAL = [join(REPO, "labs", "06-energy-weather-agent", "assets", "copilot-studio-home.png"), join(REPO, "labs", "06-energy-weather-agent", "screenshots", "28-connection-manager.png")];

function tmp(t, prefix = "placeholder-portal-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Every image the two implementations must agree on: placeholders, look-alikes, and real screenshots. */
function agreementSet() {
  return [
    ...FILLERS.map((file) => ({ name: file.split(/[\\/]/).pop(), bytes: readFileSync(file), placeholder: true })),
    { name: "pending image", bytes: readFileSync(PLACEHOLDER_PATH), placeholder: true },
    { name: "regenerated light variant", bytes: lightPlaceholder({ width: 1280, height: 720 }), placeholder: true },
    { name: "regenerated dark variant", bytes: bandedMock({ width: 1280, height: 720 }), placeholder: true },
    ...REAL.map((file) => ({ name: file.split(/[\\/]/).pop(), bytes: readFileSync(file), placeholder: false })),
    { name: "near-uniform real page", bytes: realFlatPage(), placeholder: false },
    { name: "blue header without a frame", bytes: lightPlaceholder({ frame: false }), placeholder: false },
    { name: "synthetic ui page", bytes: makePng({ mode: "ui" }), placeholder: false },
  ];
}

test("the portal and the companion agree on every image, from bytes and from a path", (t) => {
  const dir = tmp(t);
  for (const item of agreementSet()) {
    const fromPortal = portalDetector.detectPlaceholder(item.bytes);
    const fromCompanion = companionDetector.detectPlaceholder(item.bytes);
    assert.deepEqual(fromPortal, fromCompanion, item.name);
    assert.equal(fromPortal.placeholder, item.placeholder, item.name);
    const file = join(dir, `${item.name.replace(/\W+/g, "-")}.png`);
    writeFileSync(file, item.bytes);
    assert.equal(portalDetector.isPlaceholderImage(file).placeholder, item.placeholder, `${item.name} by path`);
    assert.equal(companionDetector.isPlaceholder(file), item.placeholder, `${item.name} by path`);
  }
  assert.equal(portalDetector.KNOWN_PLACEHOLDER_SHA256, companionDetector.KNOWN_PLACEHOLDER_SHA256, "one list of known hashes");
});

test("every place that decides whether a picture is a screenshot rejects the placeholders and keeps the real ones", () => {
  for (const item of agreementSet()) {
    const upload = verifyUpload({ bytes: item.bytes, filename: "shot.png" });
    const companion = verifyImage(item.bytes, { filename: "shot.png" });
    const local = verifyCapturedImageBuffer(item.bytes, ".png");
    if (item.placeholder) {
      assert.equal(upload.ok, false, item.name);
      assert.equal(upload.reasons[0].code, "placeholder", item.name);
      assert.equal(upload.reasons[0].message, "This is a placeholder picture, not a screenshot of the product.");
      assert.deepEqual(companion.reasons.map((r) => r.code), ["placeholder"], item.name);
      assert.equal(local.ok, false, item.name);
    } else {
      assert.ok(!upload.reasons.some((r) => r.code === "placeholder"), item.name);
      assert.ok(!companion.reasons.some((r) => r.code === "placeholder"), item.name);
    }
  }
  assert.equal(verifyUpload({ bytes: REAL[0] && readFileSync(REAL[0]), filename: "shot.png" }).level, "pass");
});

test("the companion download ships the detector, and everything it imports is in the allowlist", async () => {
  assert.ok(COMPANION_FILES.includes("tools/screenshot-capture/placeholder-detect.mjs"));
  const { files } = await buildCompanionZip();
  assert.ok(files.includes("capture-companion/tools/screenshot-capture/placeholder-detect.mjs"));
  const allowed = new Set(COMPANION_FILES);
  for (const rel of COMPANION_FILES.filter((f) => f.endsWith(".mjs"))) {
    const source = readFileSync(join(REPO, rel), "utf8");
    for (const [, specifier] of source.matchAll(/(?:import|export)[^;]*?from\s+"(\.[^"]+)"/g)) {
      const target = resolve(dirname(join(REPO, rel)), specifier).slice(REPO.length + 1).replace(/\\/g, "/");
      assert.ok(allowed.has(target), `${rel} imports ${specifier}, which must be in COMPANION_FILES`);
    }
  }
});

test("a placeholder is never a captured image: not in a lab's assets and not in the shared library", (t) => {
  const lab = tmp(t, "lab-");
  const shared = tmp(t, "shared-");
  mkdirSync(join(lab, "assets"));
  const filler = readFileSync(FILLERS.find((f) => f.includes("light-topics-overview")));
  const real = readFileSync(REAL[0]);
  writeFileSync(join(lab, "assets", "filler.png"), filler);
  writeFileSync(join(lab, "assets", "pending.png"), readFileSync(PLACEHOLDER_PATH));
  writeFileSync(join(lab, "assets", "real.png"), real);
  writeFileSync(join(shared, "filler.png"), filler);
  writeFileSync(join(shared, "real-shared.png"), real);

  assert.equal(capturedImage(join(lab, "assets"), "filler.png"), null);
  assert.equal(capturedImage(shared, "filler.png"), null);
  assert.equal(capturedImage(join(lab, "assets"), "pending.png"), null);
  assert.ok(capturedImage(join(lab, "assets"), "real.png"));
  assert.equal(resolveLabScreenshot(lab, "filler.png", { capturedDir: [shared] }), null, "neither the lab nor the library has a real image");
  assert.equal(resolveLabScreenshot(lab, "real.png", { capturedDir: [shared] }).source, "lab");
  assert.equal(resolveLabScreenshot(lab, "real-shared.png", { capturedDir: [shared] }).source, "shared");
  assert.ok(statSync(join(lab, "assets", "filler.png")).size > 5 * 1024, "the filler is big enough to pass the old size check");
});

test("the generator never reuses a placeholder picture: its slot stays pending at the same file name", (t) => {
  const labsDir = tmp(t, "labs-");
  mkdirSync(join(labsDir, "lab-a", "assets"), { recursive: true });
  writeFileSync(join(labsDir, "lab-a", "assets", "filler.png"), readFileSync(FILLERS.find((f) => f.includes("light-trigger-phrases"))));
  writeFileSync(join(labsDir, "lab-a", "assets", "real.png"), readFileSync(REAL[0]));
  const plan = {
    features: [
      {
        id: "topics",
        name: "Topics",
        order: 1,
        reuseScreenshots: [
          { lab: "lab-a", file: "filler.png", caption: "Trigger node with example phrases" },
          { lab: "lab-a", file: "real.png", caption: "The agent home page" },
        ],
        screenshots: [],
      },
    ],
  };
  const shared = tmp(t, "shared-");
  const out = planScreenshots(plan, { labsDir, capturedDir: shared });
  assert.deepEqual(out.copies.map((c) => c.filename), ["real.png"], "only the real image is copied in");
  assert.deepEqual(out.placeholders.map((p) => p.filename), ["filler.png"]);
  const pending = out.shots.find((s) => s.filename === "filler.png");
  assert.equal(pending.status, "pending");
  assert.equal(pending.caption, "Trigger node with example phrases");
  assert.match(pending.alt, /Trigger node with example phrases/);
  assert.ok(pending.instructions.length > 0);
  const bundle = out.byFeature.get("topics");
  assert.deepEqual(bundle.reused.map((r) => r.filename), ["real.png"]);
  assert.deepEqual(bundle.capture.map((c) => [c.filename, c.pending]), [["filler.png", true]]);

  // A caller that hands a placeholder straight to copyScreenshots still cannot copy it in.
  const assets = join(tmp(t, "out-"), "assets");
  const copied = copyScreenshots([{ source: join(labsDir, "lab-a", "assets", "filler.png"), filename: "filler.png" }, { source: join(labsDir, "lab-a", "assets", "real.png"), filename: "real.png" }], assets);
  assert.equal(copied, 1);
  assert.deepEqual(readdirSync(assets), ["real.png"]);
});

test("a shared-library placeholder does not make a slot captured", (t) => {
  const shared = tmp(t, "shared-");
  const labsDir = tmp(t, "labs-");
  writeFileSync(join(shared, "slot-a.png"), readFileSync(FILLERS[0]));
  writeFileSync(join(shared, "slot-b.png"), readFileSync(REAL[0]));
  const plan = {
    features: [
      { id: "f1", name: "F1", order: 1, reuseScreenshots: [], screenshots: [{ filename: "slot-a.png" }, { filename: "slot-b.png" }] },
    ],
  };
  const out = planScreenshots(plan, { labsDir, capturedDir: shared });
  assert.deepEqual(out.shots.map((s) => [s.filename, s.status]), [["slot-a.png", "pending"], ["slot-b.png", "captured"]]);
  assert.deepEqual(out.placeholders.map((p) => p.filename), ["slot-a.png"]);
  assert.deepEqual(out.copies.map((c) => c.filename), ["slot-b.png"]);
});
