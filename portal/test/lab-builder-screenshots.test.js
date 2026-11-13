import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
