import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { makePng, overlay, tmpDir } from "./helpers.mjs";
import { DEFAULTS, generate, readJson, serializeShotLists, writeSite } from "../lib/build.mjs";
import { readCatalogFile } from "../../../portal/lib/lab-builder/catalog-source.js";
import { checkFeatureShots } from "../../screenshot-capture/feature-shots-check.mjs";
import { listFeatureManifests } from "../../screenshot-capture/manifests.mjs";
import { manifestFileName, readCaptureConfig, validateCaptureConfig } from "../lib/products.mjs";
import { sidecarName } from "../lib/screenshots.mjs";

// The whole catalog: features.json plus every catalog/<product>.json.
const fullCatalog = readCatalogFile(DEFAULTS.catalog);
const config = readCaptureConfig();
const result = generate({ catalog: fullCatalog, overlay, screenshotsDir: path.join(tmpDir(), "none") });
const buildScript = path.join(path.dirname(DEFAULTS.overlay), "build.mjs");
const PRODUCTS = ["copilot-studio", "m365-copilot-agent-builder", "sharepoint-ai", "ai-foundry", "m365-copilot-hub", "power-platform-ai-hub"];

function repoWithManifests() {
  const root = tmpDir("feature-tour-all-");
  const dir = path.join(root, "tools", "screenshot-capture");
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(root, "docs", "feature-tour", "screenshots"), { recursive: true });
  for (const [name, content] of serializeShotLists(result)) fs.writeFileSync(path.join(dir, name), content);
  return { root, dir, assets: path.join(root, "docs", "feature-tour", "screenshots") };
}

function runCheck(dir, ...extra) {
  return spawnSync(process.execPath, [buildScript, "--check", `--shot-list-dir=${dir}`, ...extra], { encoding: "utf8" });
}

test("there is a shot list for every product in the catalog", () => {
  assert.deepEqual(result.products.map((p) => p.id).sort(), [...PRODUCTS].sort());
  for (const id of PRODUCTS) assert.ok(config.products[id], `${id} has capture settings`);
  assert.deepEqual(validateCaptureConfig(config, { products: PRODUCTS }), []);
});

test("every catalog feature of every product has at least one shot slot", () => {
  const slotted = new Set(result.products.flatMap((p) => p.shotList.shots.map((s) => s.feature)));
  for (const f of fullCatalog.features) assert.ok(slotted.has(f.id), `${f.id} (${f.product ?? "copilot-studio"}) has no slot`);
  for (const p of result.products) {
    const expected = fullCatalog.features.filter((f) => (f.product ?? "copilot-studio") === p.id).map((f) => f.id);
    assert.deepEqual([...new Set(p.shotList.shots.map((s) => s.feature))].sort(), expected.sort(), `${p.id} lists exactly its own features`);
  }
});

test("filenames are unique across all products and ids are sequential per product", () => {
  const all = result.products.flatMap((p) => p.shotList.shots.map((s) => s.filename));
  assert.equal(new Set(all).size, all.length, "the screenshots folder is shared, so a filename belongs to one shot");
  for (const p of result.products) assert.deepEqual(p.shotList.shots.map((s) => s.id), p.shotList.shots.map((_, i) => i + 1));
});

test("each manifest has the product, browser profile, start URL, and per-shot fields the capture tool needs", () => {
  for (const p of result.products) {
    const list = p.shotList;
    assert.equal(list.product, p.id);
    assert.equal(list.kind, "feature-tour");
    assert.equal(list.lab, p.lab);
    assert.equal(list.authProfile, config.products[p.id].authProfile);
    assert.match(list.startUrl, /^https:\/\//);
    assert.match(list.startUrlEnv, /^CAPTURE_[A-Z0-9_]+$/);
    assert.equal(p.manifest, manifestFileName(p.id));
    for (const s of list.shots) {
      assert.equal(s.product, p.id);
      assert.ok(s.setup.length > 0, `${s.filename} carries the feature's setup steps`);
      assert.ok(s.instructions.length > 0 && s.navHint && s.caption);
      assert.equal("harness" in s, p.id === "copilot-studio", `${s.filename}: only Copilot Studio has harnesses`);
      if (s.url) assert.match(s.url, /^https:\/\//);
      if (s.urlEnv) assert.match(s.urlEnv, /^CAPTURE_[A-Z0-9_]+$/);
      assert.ok(s.url || s.urlEnv || s.manual || p.id === "copilot-studio" || s.section === "learn", `${s.filename} has an address, an environment variable, or is manual`);
    }
  }
});

test("alt text and captions come from the reviewed slot text", () => {
  const slots = readJson(path.join(DEFAULTS.catalog, "..", "screenshot-slots.json")).slots;
  const sharepoint = result.products.find((p) => p.id === "sharepoint-ai");
  for (const s of sharepoint.shotList.shots) {
    assert.equal(s.caption, slots[s.filename].caption);
    assert.equal(s.alt, slots[s.filename].alt);
  }
});

test("every committed manifest passes the schema check and no file is orphaned", () => {
  const root = path.resolve(DEFAULTS.shotListDir, "..", "..");
  const known = new Set(result.products.flatMap((p) => p.shotList.shots.map((s) => s.filename)));
  const entries = listFeatureManifests(DEFAULTS.shotListDir);
  assert.deepEqual(entries.map((e) => e.product).sort(), [...PRODUCTS].sort());
  for (const e of entries) {
    const check = checkFeatureShots({ repoRoot: root, manifestPath: e.path, knownFilenames: known });
    assert.deepEqual(check.findings.filter((f) => f.severity === "critical"), [], e.file);
    assert.equal(check.total, result.products.find((p) => p.id === e.product).shotList.shots.length);
  }
});

test("a manifest that gives a non-Copilot Studio product a harness is rejected", () => {
  const { root, dir } = repoWithManifests();
  const file = path.join(dir, manifestFileName("sharepoint-ai"));
  const list = JSON.parse(fs.readFileSync(file, "utf8"));
  list.shots[0].harness = "standard";
  fs.writeFileSync(file, JSON.stringify(list));
  const check = checkFeatureShots({ repoRoot: root, manifestPath: file });
  assert.ok(check.findings.some((f) => f.severity === "critical" && /no harnesses/.test(f.message)));
});

test("build --check passes for current manifests and fails when any one is stale, missing, or unexpected", () => {
  const { dir } = repoWithManifests();
  const ok = runCheck(dir);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /6 products/);

  const file = path.join(dir, manifestFileName("ai-foundry"));
  const original = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, original.replace('"caption"', '"caption" '));
  const stale = runCheck(dir);
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /feature-shots\.ai-foundry\.json is out of date/);
  assert.equal(runCheck(dir, "--product=sharepoint-ai").status, 0, "--product only checks that product");
  assert.equal(runCheck(dir, "--product=ai-foundry").status, 1);

  fs.writeFileSync(file, original);
  fs.rmSync(path.join(dir, manifestFileName("m365-copilot-hub")));
  const missing = runCheck(dir);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /feature-shots\.m365-copilot-hub\.json is missing/);

  fs.writeFileSync(path.join(dir, manifestFileName("m365-copilot-hub")), serializeShotLists(result).get(manifestFileName("m365-copilot-hub")));
  fs.writeFileSync(path.join(dir, "feature-shots.retired-product.json"), "{}");
  const extra = runCheck(dir);
  assert.equal(extra.status, 1);
  assert.match(extra.stderr, /does not belong to any product/);
});

test("changing a catalog feature of a new product makes its manifest stale", () => {
  const catalog = structuredClone(fullCatalog);
  const feature = catalog.features.find((f) => f.product === "power-platform-ai-hub");
  feature.screenshots[0].instructions = [...feature.screenshots[0].instructions, "Also show the Next button."];
  const changed = serializeShotLists(generate({ catalog, overlay, screenshotsDir: tmpDir() }));
  const name = manifestFileName("power-platform-ai-hub");
  assert.notEqual(changed.get(name), serializeShotLists(result).get(name));
  assert.equal(changed.get(manifestFileName("sharepoint-ai")), serializeShotLists(result).get(manifestFileName("sharepoint-ai")));
});

test("a product or screenshot section without capture settings is rejected", () => {
  const catalog = structuredClone(fullCatalog);
  const feature = catalog.features.find((f) => f.product === "sharepoint-ai");
  feature.screenshots[0].section = "section-with-no-settings";
  assert.throws(() => generate({ catalog, overlay, screenshotsDir: tmpDir() }), /no capture settings for section "section-with-no-settings"/);
  const noProduct = structuredClone(fullCatalog);
  noProduct.features.push({ ...structuredClone(feature), id: "new-product-feature", product: "brand-new-product" });
  assert.throws(() => generate({ catalog: noProduct, overlay, screenshotsDir: tmpDir() }), /no entry for product brand-new-product/);
});

test("the site has a section for every product and the Copilot Studio URLs have not moved", () => {
  for (const p of result.products) {
    const base = p.id === "copilot-studio" ? "" : `${p.id}/`;
    assert.ok(result.pages.has(`${base}index.html`), `${p.id} index`);
    assert.ok(result.pages.has(`${base}tour.html`), `${p.id} tour`);
    for (const f of p.site.features) assert.ok(result.pages.has(`${base}features/${f.id}.html`), `${p.id}/${f.id}`);
  }
  const index = result.pages.get("sharepoint-ai/index.html");
  assert.match(index, /<nav aria-label="Products"/);
  assert.match(index, /href="\.\.\/index\.html"/, "links back to the Copilot Studio tour");
  assert.doesNotMatch(index, /id="f-harness"/, "no harness filter for a product without harnesses");
  assert.doesNotMatch(index, /Microsoft Copilot harness/);
  assert.match(index, /href="\.\.\/assets\/styles\.css"/);
  assert.match(result.pages.get("index.html"), /sharepoint-ai\/index\.html/);
});

test("captured images and callout sidecars for any product reach the site and the pending placeholder stays for the rest", () => {
  const screenshots = tmpDir();
  const product = result.products.find((p) => p.id === "m365-copilot-hub");
  const [first, second] = product.shotList.shots;
  const png = makePng(200, 120);
  fs.writeFileSync(path.join(screenshots, first.filename), png);
  fs.writeFileSync(
    path.join(screenshots, sidecarName(first.filename)),
    JSON.stringify({ viewport: { width: 200, height: 120 }, callouts: [{ n: 1, label: first.callouts[0]?.label ?? "x", rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 } }] }),
  );
  fs.writeFileSync(path.join(screenshots, second.filename), Buffer.alloc(100, 1));

  const built = generate({ catalog: fullCatalog, overlay, screenshotsDir: screenshots });
  const hub = built.products.find((p) => p.id === "m365-copilot-hub");
  const feature = hub.site.features.find((f) => f.id === first.feature);
  const shot = feature.shots.find((s) => s.filename === first.filename);
  assert.equal(shot.status, "ready");
  assert.equal(shot.src, `../screenshots/${first.filename}`);
  assert.deepEqual(shot.callouts[0].rect, { x: 0.1, y: 0.2, w: 0.3, h: 0.1 });
  assert.equal(feature.shots.find((s) => s.filename === second.filename).status, "pending", "a stub is still pending");

  const page = built.pages.get(`m365-copilot-hub/features/${first.feature}.html`);
  assert.ok(page.includes(`src="../../screenshots/${first.filename}"`));
  assert.match(page, /class="hotspot"/);
  assert.ok(page.includes(first.alt));
  assert.match(page, /Screenshot pending/);
  assert.equal(built.site.totals.shotsReady, 0, "Copilot Studio is unaffected");

  const out = path.join(tmpDir(), "site");
  writeSite(built, { out, assetsDir: DEFAULTS.assetsDir, screenshotsDir: screenshots });
  assert.ok(fs.existsSync(path.join(out, "screenshots", first.filename)));
  assert.ok(fs.existsSync(path.join(out, "screenshots", sidecarName(first.filename))));
  assert.ok(!fs.existsSync(path.join(out, "screenshots", second.filename)), "stubs are not published");
  assert.ok(fs.existsSync(path.join(out, "assets", "styles.css")));
  assert.ok(fs.existsSync(path.join(out, "m365-copilot-hub", "tour.html")));
});

test("generated content for the new products uses US English and never the retired product names", () => {
  const british = /\b(colour|behaviour|organis\w+|customis\w+|catalogue|licence|favour|centre|analyse\w*|initialis\w+|authoris\w+|recognis\w+)\b/i;
  for (const p of result.products.filter((x) => x.id !== "copilot-studio")) {
    const text = JSON.stringify(p.shotList).replace(/https?:\/\/[^\s"]+/g, "");
    assert.doesNotMatch(text, british, p.id);
    assert.doesNotMatch(text, /GitHub Copilot harness/i, p.id);
  }
});
