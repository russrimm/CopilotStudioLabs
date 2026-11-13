import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import zlib from "node:zlib";
import { getFeatures, validateCatalog } from "../lib/lab-builder/catalog.js";
import { decorateGeneratedHtml, resolveGeneratedAsset } from "../lib/lab-builder/generated-labs.js";
import { generateLab } from "../lib/lab-builder/generator.js";
import { planLab } from "../lib/lab-builder/planner.js";
import { planScreenshots } from "../lib/lab-builder/screenshots.js";
import {
  MIN_CAPTURED_BYTES,
  PLACEHOLDER_PATH,
  altProblems,
  describeSlot,
  getSlotMeta,
  slotsForFeature,
  validateScreenshotSlots,
} from "../lib/lab-builder/slots.js";
import { checkHeadingOrder, checkImageAlts, countUnlabeledFences } from "../lib/validator.js";

const tmp = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "lab-shots-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// These tests assume no screenshot has been captured. Point the captured-screenshots folder at an
// empty one so real captures committed under docs/feature-tour/screenshots never change the results.
const NO_CAPTURES = mkdtempSync(join(tmpdir(), "lab-shots-none-"));
process.env.FEATURE_TOUR_SCREENSHOTS_DIR = NO_CAPTURES;

// A valid, incompressible PNG above the 5 KB "real screenshot" bar. A test fixture only.
function fixturePng(width = 120, height = 80) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(zlib.crc32(body) >>> 0, 8 + data.length);
    return out;
  };
  const rows = [];
  let seed = 4242;
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

test("every slot has specific alt text, a caption, and a kind, and the catalog stays valid", () => {
  assert.deepEqual(validateCatalog(), []);
  assert.deepEqual(validateScreenshotSlots({ features: getFeatures() }), []);
  const meta = getSlotMeta();
  assert.ok(Object.keys(meta).length >= 90);
  for (const [filename, entry] of Object.entries(meta)) {
    assert.deepEqual(altProblems(entry.alt), [], filename);
    assert.notEqual(entry.alt, entry.caption, filename);
  }
});

test("alt text rules reject what a screen reader user cannot use", () => {
  assert.match(altProblems("").join(), /empty/);
  assert.match(altProblems("screenshot").join(), /generic/);
  assert.match(altProblems("The page").join(), /too short/);
  assert.match(altProblems("Screenshot of the Topics page with two topics").join(), /should not start with/);
  assert.match(altProblems("Image of the Topics page with two topics").join(), /should not start with/);
  assert.match(altProblems("topics-list.png shown here for you").join(), /file name/);
  assert.match(altProblems("The red button that starts the test").join(), /color/);
  assert.match(altProblems("x ".repeat(130)).join(), /250/);
  assert.deepEqual(altProblems("The Topics page listing custom and system topics."), []);
});

test("slot validation names missing entries, bad kinds, repeated captions, and orphans", () => {
  const features = [{ id: "f", screenshots: [{ filename: "a.png" }, { filename: "b.png" }, { filename: "c.png" }] }];
  const meta = {
    "a.png": { kind: "dialog", caption: "A caption", alt: "A dialog that shows the setting you just changed." },
    "b.png": { kind: "nope", caption: "Same text for both", alt: "Same text for both" },
    "orphan.png": { kind: "dialog", caption: "C", alt: "A dialog that shows something useful here." },
  };
  const problems = validateScreenshotSlots({ features, meta, overlay: {} }).join("\n");
  assert.match(problems, /c\.png has no entry/);
  assert.match(problems, /b\.png: kind must be one of/);
  assert.match(problems, /alt text repeats the caption/);
  assert.match(problems, /orphan\.png matches no slot/);
});

test("Microsoft Copilot harness features now have slots", () => {
  for (const id of ["mc-skills", "mc-memory", "mc-hooks", "mc-preview-test", "mc-evaluate", "mc-create-agent", "test-agent"]) {
    const feature = getFeatures().find((f) => f.id === id);
    assert.ok(slotsForFeature(feature).length >= 1, `${id} has no slot`);
  }
  const described = describeSlot({ name: "Memory" }, { filename: "mc-memory-toggle.png" });
  assert.equal(described.kind, "settings");
  assert.match(described.alt, /Memory toggle/);
});

test("the placeholder is a tiny neutral PNG that every capture tool treats as pending", () => {
  const bytes = readFileSync(PLACEHOLDER_PATH);
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(bytes.length < MIN_CAPTURED_BYTES, `${bytes.length} bytes must be under ${MIN_CAPTURED_BYTES}`);
  assert.equal(bytes.readUInt32BE(16), 960);
  assert.equal(bytes.readUInt32BE(20), 540);
});

test("the screenshot plan numbers figures and carries alt text, caption, kind, and pending status", () => {
  const plan = planLab({ features: ["mc-skills", "mc-memory"], harness: "microsoft-copilot", includeCore: false });
  const result = planScreenshots(plan, { labsDir: join(tmpdir(), "no-such-labs") });
  assert.equal(result.shots.length, result.placeholders.length);
  assert.ok(result.shots.length >= 2);
  const figures = result.shots.map((s) => s.figure);
  assert.equal(new Set(figures).size, figures.length);
  for (const shot of result.shots) {
    assert.match(shot.figure, /^\d+\.\d+$/);
    assert.equal(typeof shot.id, "number", "capture.js selects shots by numeric id");
    assert.equal(shot.status, "pending");
    assert.deepEqual(altProblems(shot.alt), []);
    assert.ok(shot.caption && shot.kind && shot.instructions.length);
  }
});

test("a generated lab places figures with real alt text, no learner-facing capture instructions, and a shot list", async (t) => {
  const outputRoot = tmp(t);
  const result = await generateLab(
    { features: ["mc-skills", "mc-memory", "mc-hooks"], harness: "microsoft-copilot", includeCore: false },
    { outputRoot, useLearnMcp: false, useLlm: false },
  );
  const md = readFileSync(join(result.outputDir, "index.md"), "utf8");
  assert.match(md, /!\[The Add skill dialog with the Create from blank option[^\]]*\]\(assets\/mc-skills-add-skill\.png\)/);
  assert.match(md, /\*Figure \d+\.\d+\. The Add skill dialog\.\*/);
  assert.doesNotMatch(md, /Capture this screen/);
  assert.doesNotMatch(md, /node tools\/screenshot-capture/);
  assert.deepEqual(checkImageAlts(md).problems, []);

  const assets = join(result.outputDir, "assets");
  for (const name of readdirSync(assets)) assert.ok(statSync(join(assets, name)).size < MIN_CAPTURED_BYTES, `${name} is a placeholder`);

  const shots = JSON.parse(readFileSync(join(result.outputDir, "shots.json"), "utf8"));
  assert.equal(shots.shots.length, result.manifest.screenshots.pending);
  assert.ok(shots.shots.every((s) => s.alt && s.caption && s.figure && s.status === "pending" && s.filename && s.section && s.instructions.length));
  const list = readFileSync(join(result.outputDir, "SHOTLIST.md"), "utf8");
  assert.match(list, /Screenshot pending/);
  assert.match(list, /\*\*Alt text:\*\*/);
  assert.match(list, /capture\.js --manifest/);
  assert.equal(result.manifest.screenshots.total, result.manifest.screenshots.reused + result.manifest.screenshots.pending);

  for (const name of ["image-alt-text", "heading-order"]) {
    assert.equal(result.validation.tests.find((x) => x.name === name).status, "pass", name);
  }
});

test("the alt-text check flags missing, generic, filename, and unmarked empty alts", () => {
  const bad = [
    "![](a.png)",
    "![image](a.png)",
    "![Screenshot of the page with settings](a.png)",
    '<img src="b.png">',
    '<img src="b.png" alt="">',
    '<img src="b.png" alt="b.png">',
  ].join("\n\n");
  const { count, problems } = checkImageAlts(bad);
  assert.equal(count, 6);
  assert.equal(problems.length >= 6, true);
  assert.deepEqual(checkImageAlts('<img src="rule.png" alt="" role="presentation">\n').problems, []);
  assert.deepEqual(checkImageAlts("```\n![](a.png)\n```\n").problems, []);
  assert.deepEqual(checkImageAlts("![The Topics page listing custom and system topics](a.png)").problems, []);
});

test("heading order and code fence labels are checked", () => {
  assert.deepEqual(checkHeadingOrder([{ level: 1, text: "T" }, { level: 2, text: "A" }, { level: 3, text: "B" }, { level: 2, text: "C" }]), []);
  assert.match(checkHeadingOrder([{ level: 2, text: "A" }, { level: 4, text: "Deep" }]).join(), /"Deep" jumps from H2 to H4/);
  assert.equal(countUnlabeledFences("```powershell\nx\n```\n\n```\ny\n```\n~~~\nz\n~~~\n"), 2);
  assert.equal(countUnlabeledFences("```js\nx\n```\n"), 0);
});

test("generated lab previews point images at the asset route and say which are pending", (t) => {
  const root = tmp(t);
  const labDir = join(root, "my-lab");
  mkdirSync(join(labDir, "assets"), { recursive: true });
  writeFileSync(join(labDir, "assets", "stub.png"), readFileSync(PLACEHOLDER_PATH));
  writeFileSync(join(labDir, "assets", "real.png"), Buffer.alloc(MIN_CAPTURED_BYTES + 100, 1));
  const html = '<p><img src="assets/stub.png" alt="A stub"></p><p><img src="assets/real.png" alt="A real one"></p><img src="https://example.com/x.png" alt="x">';
  const { html: out, pending } = decorateGeneratedHtml(html, "my-lab", labDir);
  assert.deepEqual(pending, ["stub.png"]);
  assert.match(out, /src="\/api\/lab-builder\/generated\/my-lab\/assets\/stub\.png" alt="A stub"><br><strong class="shot-pending">Screenshot pending\.<\/strong>/);
  assert.match(out, /assets\/real\.png" alt="A real one">(?!<br>)/);
  assert.match(out, /src="https:\/\/example\.com\/x\.png"/);
});

test("the asset route only serves real images inside a generated lab", (t) => {
  const root = tmp(t);
  mkdirSync(join(root, "lab-one", "assets"), { recursive: true });
  writeFileSync(join(root, "lab-one", "assets", "a.png"), "x");
  writeFileSync(join(root, "lab-one", "assets", "script.js"), "x");
  writeFileSync(join(root, "secret.png"), "x");
  assert.equal(resolveGeneratedAsset(root, "lab-one", "a.png").status, 200);
  assert.equal(resolveGeneratedAsset(root, "lab-one", "a.png").type, "image/png");
  assert.equal(resolveGeneratedAsset(root, "lab-one", "script.js").status, 400);
  assert.equal(resolveGeneratedAsset(root, "lab-one", "..%2Fsecret.png").status, 400);
  assert.equal(resolveGeneratedAsset(root, "lab-one", "../secret.png").status, 400);
  assert.equal(resolveGeneratedAsset(root, "../lab-one", "a.png").status, 400);
  assert.equal(resolveGeneratedAsset(root, "lab-one", "missing.png").status, 404);
  assert.equal(existsSync(join(root, "secret.png")), true);
});

test("a captured screenshot is copied into a generated lab for any product, and uncaptured slots keep the placeholder", async (t) => {
  const captured = tmp(t);
  const plan = planLab({ products: ["sharepoint-ai"], level: 100, features: ["spai-build-agent-sharepoint-content"], harness: "standard" });
  const slots = planScreenshots(plan, { labsDir: join(tmpdir(), "no-such-labs"), capturedDir: captured });
  assert.ok(slots.shots.length >= 2, "the feature has more than one slot");
  assert.ok(slots.shots.every((s) => s.status === "pending"), "nothing captured yet");

  const [first, second] = slots.shots;
  const png = fixturePng();
  writeFileSync(join(captured, first.filename), png);
  writeFileSync(join(captured, second.filename), readFileSync(PLACEHOLDER_PATH));

  const result = planScreenshots(plan, { labsDir: join(tmpdir(), "no-such-labs"), capturedDir: captured });
  assert.equal(result.shots[0].status, "captured");
  assert.equal(result.shots[1].status, "pending", "a stub under the 5 KB bar is still pending");
  assert.deepEqual(result.copies.map((c) => c.filename), [first.filename]);
  assert.deepEqual(result.placeholders.map((p) => p.filename), result.shots.slice(1).map((s) => s.filename));
  assert.equal(result.shots[0].alt, first.alt, "alt text does not change when the image arrives");
  assert.equal(result.shots[0].caption, first.caption);

  process.env.FEATURE_TOUR_SCREENSHOTS_DIR = captured;
  try {
    const outputRoot = tmp(t);
    const lab = await generateLab(
      { products: ["sharepoint-ai"], level: 100, features: ["spai-build-agent-sharepoint-content"], harness: "standard" },
      { outputRoot, useLearnMcp: false, useLlm: false },
    );
    const assets = join(lab.outputDir, "assets");
    assert.deepEqual(readFileSync(join(assets, first.filename)), png);
    assert.ok(statSync(join(assets, second.filename)).size < MIN_CAPTURED_BYTES);
    assert.equal(lab.manifest.screenshots.captured, 1);
    assert.equal(lab.manifest.screenshots.pending, slots.shots.length - 1);
    assert.equal(lab.manifest.screenshots.total, lab.manifest.screenshots.reused + slots.shots.length);

    const md = readFileSync(join(lab.outputDir, "index.md"), "utf8");
    assert.match(md, new RegExp(`\\]\\(assets/${first.filename.replace(/\./g, "\\.")}\\)`), "the Markdown still points at the same filename");
    const shotsJson = JSON.parse(readFileSync(join(lab.outputDir, "shots.json"), "utf8"));
    assert.deepEqual(shotsJson.shots.map((s) => s.status), ["captured", ...slots.shots.slice(1).map(() => "pending")]);
    const list = readFileSync(join(lab.outputDir, "SHOTLIST.md"), "utf8");
    assert.doesNotMatch(list, new RegExp(`assets/${first.filename.replace(/\./g, "\\.")}`), "a captured slot is not on the to-do list");
    assert.match(list, /1 already captured/);
  } finally {
    process.env.FEATURE_TOUR_SCREENSHOTS_DIR = NO_CAPTURES;
  }
});

test("a previewed lab that still holds a placeholder shows the captured image instead of the pending note", (t) => {
  const root = tmp(t);
  const captured = tmp(t);
  const labDir = join(root, "my-lab");
  mkdirSync(join(labDir, "assets"), { recursive: true });
  writeFileSync(join(labDir, "manifest.json"), "{}");
  writeFileSync(join(labDir, "assets", "later.png"), readFileSync(PLACEHOLDER_PATH));
  writeFileSync(join(labDir, "assets", "still-pending.png"), readFileSync(PLACEHOLDER_PATH));
  const html = '<img src="assets/later.png" alt="Captured later"><img src="assets/still-pending.png" alt="Not yet">';

  assert.deepEqual(decorateGeneratedHtml(html, "my-lab", labDir, { capturedDir: captured }).pending, ["later.png", "still-pending.png"]);

  const png = fixturePng();
  writeFileSync(join(captured, "later.png"), png);
  assert.deepEqual(decorateGeneratedHtml(html, "my-lab", labDir, { capturedDir: captured }).pending, ["still-pending.png"]);
  const served = resolveGeneratedAsset(root, "my-lab", "later.png", { capturedDir: captured });
  assert.equal(served.status, 200);
  assert.deepEqual(readFileSync(served.path), png);
  assert.equal(resolveGeneratedAsset(root, "my-lab", "still-pending.png", { capturedDir: captured }).path, join(labDir, "assets", "still-pending.png"));

  // A lab that does not exist cannot be used to read captured images.
  assert.equal(resolveGeneratedAsset(root, "no-such-lab", "later.png", { capturedDir: captured }).status, 404);
});
