import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { build, catalog, makePng, overlay, stripUrls, tmpDir } from "./helpers.mjs";
import { DEFAULTS, generate, writeSite } from "../lib/build.mjs";
import { HARNESS_ORDER, availabilityOf, harnessGroup } from "../lib/model.mjs";
import { inspectScreenshot, sidecarName } from "../lib/screenshots.mjs";

const result = build();
const { site, pages } = result;

test("every catalog feature appears exactly once in the model, index, tour, and pages", () => {
  const ids = catalog.features.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length, "catalog ids are unique");
  assert.deepEqual(site.features.map((f) => f.id).sort(), [...ids].sort());

  const index = pages.get("index.html");
  const tourData = JSON.parse(/<script type="application\/json" id="tour-data">([\s\S]*?)<\/script>/.exec(pages.get("tour.html"))[1]);
  assert.deepEqual(tourData.features.map((f) => f.id).sort(), [...ids].sort());
  for (const id of ids) {
    assert.equal(index.split(`href="features/${id}.html"`).length - 1, 1, `${id} has one card`);
    assert.ok(pages.has(`features/${id}.html`), `${id} has a page`);
  }
  assert.equal((index.match(/<li class="card"/g) ?? []).length, ids.length);
});

test("the tour lists only Copilot Studio features, and every feature in it carries its product", () => {
  const other = { ...catalog.features[0], id: "other-product-feature", product: "sharepoint-ai", harness: undefined };
  const mixed = { ...catalog, features: [...catalog.features, other] };
  const scoped = generate({ catalog: mixed, overlay, screenshotsDir: path.join(tmpDir(), "none") });
  assert.ok(!scoped.site.features.some((f) => f.id === other.id), "another product's feature is not in the tour");
  assert.equal(scoped.site.features.length, catalog.features.length);
  assert.ok(scoped.site.features.every((f) => f.product === "copilot-studio"));
  assert.equal(scoped.shotList.shots.some((s) => s.feature === other.id), false);
});

test("harness, level, and availability match the catalog", () => {
  const byId = new Map(catalog.features.map((f) => [f.id, f]));
  for (const f of site.features) {
    const source = byId.get(f.id);
    assert.deepEqual(f.harness, source.harness);
    assert.equal(f.harnessGroup, harnessGroup(source.harness));
    assert.equal(f.level, source.level);
    assert.equal(f.availability, availabilityOf(source));
    if (source.availability) assert.equal(f.availability, source.availability);
    else assert.equal(f.availability, "unflagged");
    const page = pages.get(`features/${f.id}.html`);
    assert.match(page, new RegExp(`badge-harness-${f.harnessGroup}`));
    assert.ok(page.includes(f.levelLabel));
  }
});

test("tour order is harness, then category, then level", () => {
  const rank = new Map(catalog.categories.map((c, i) => [c.id, i]));
  const keys = site.features.map((f) => [HARNESS_ORDER.indexOf(f.harnessGroup), rank.get(f.category), f.level]);
  for (let i = 1; i < keys.length; i += 1) {
    const [a, b] = [keys[i - 1], keys[i]];
    const cmp = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
    assert.ok(cmp <= 0, `${site.features[i - 1].id} should come before ${site.features[i].id}`);
  }
  assert.deepEqual(site.features.map((f) => f.order), site.features.map((_, i) => i + 1));
});

test("Learn links are well formed https URLs", () => {
  for (const f of site.features) {
    assert.ok(f.learn.length > 0, `${f.id} cites Learn`);
    for (const { url } of f.learn.concat([{ url: f.verifiedAgainst }])) {
      const parsed = new URL(url);
      assert.equal(parsed.protocol, "https:");
      assert.doesNotMatch(url, /\s/);
    }
    assert.ok(f.learn.every(({ url }) => new URL(url).hostname === "learn.microsoft.com"), `${f.id} docUrls are Learn pages`);
  }
});

test("generated content never says 'GitHub Copilot harness' and uses US English", () => {
  const bad = /GitHub Copilot harness/i;
  const british = /\b(colour|behaviour|organis\w+|customis\w+|catalogue|licence|favour|centre|analyse\w*|initialis\w+|authoris\w+|recognis\w+)\b/i;
  const all = [...pages.values(), JSON.stringify(result.shotList), JSON.stringify(overlay)].map(stripUrls);
  for (const text of all) {
    assert.doesNotMatch(text, bad);
    assert.doesNotMatch(text, british);
  }
  assert.ok(pages.get("index.html").includes("Microsoft Copilot harness"));
});

test("output is deterministic", () => {
  const again = build();
  assert.deepEqual([...again.pages.entries()], [...pages.entries()]);
  assert.deepEqual(again.shotList, result.shotList);
});

test("placeholder versus real screenshot detection", () => {
  const dir = tmpDir();
  const shots = result.shotList.shots;
  const [ready, stub, wrong, missing] = shots;
  fs.writeFileSync(path.join(dir, ready.filename), makePng());
  fs.writeFileSync(path.join(dir, stub.filename), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(dir, wrong.filename), Buffer.alloc(8192, 1));

  assert.equal(inspectScreenshot(dir, ready.filename).status, "ready");
  assert.equal(inspectScreenshot(dir, stub.filename).reason, "too-small");
  assert.equal(inspectScreenshot(dir, wrong.filename).reason, "not-an-image");
  assert.equal(inspectScreenshot(dir, missing.filename).reason, "missing");
  assert.equal(inspectScreenshot(dir, "../escape.png").reason, "invalid-filename");

  const withDir = build(dir);
  const featureOf = (shot) => withDir.site.features.find((f) => f.id === shot.feature);
  const readyFeature = featureOf(ready);
  const readyShot = readyFeature.shots.find((s) => s.filename === ready.filename);
  assert.equal(readyShot.status, "ready");
  assert.deepEqual([readyShot.width, readyShot.height], [120, 80]);
  assert.equal(featureOf(stub).shots.find((s) => s.filename === stub.filename).status, "pending");
  assert.equal(withDir.site.totals.shotsReady, 1);

  const page = withDir.pages.get(`features/${ready.feature}.html`);
  assert.match(page, new RegExp(`<img src="../screenshots/${ready.filename}"`));
  assert.match(page, /alt="[^"]+"/);
  const pendingPage = withDir.pages.get(`features/${stub.feature}.html`);
  assert.match(pendingPage, /Screenshot pending/);
  assert.doesNotMatch(pendingPage, new RegExp(`<img[^>]+${stub.filename}`));
});

test("callout rectangles come from the capture sidecar and drive the hotspots", () => {
  const dir = tmpDir();
  const shot = result.shotList.shots.find((s) => s.callouts.length >= 2);
  fs.writeFileSync(path.join(dir, shot.filename), makePng());
  fs.writeFileSync(
    path.join(dir, sidecarName(shot.filename)),
    JSON.stringify({ schema: 1, callouts: [{ n: 1, label: "x", rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 } }, { n: 2, label: "y", rect: null }, { n: 3, rect: { x: 0.9, y: 0.9, w: 0.5, h: 0.5 } }] }),
  );
  const out = build(dir);
  const built = out.site.features.find((f) => f.id === shot.feature).shots.find((s) => s.filename === shot.filename);
  assert.deepEqual(built.callouts[0].rect, { x: 0.1, y: 0.2, w: 0.3, h: 0.1 });
  assert.equal(built.callouts[1].rect, null, "unresolved callout has no hotspot");
  assert.ok(built.callouts.slice(2).every((c) => c.rect === null), "out-of-bounds rectangles are ignored");
  const page = out.pages.get(`features/${shot.feature}.html`);
  assert.equal((page.match(/class="hotspot"/g) ?? []).length, 1);
  assert.match(page, /left:10\.00%;top:20\.00%;width:30\.00%;height:10\.00%/);
});

test("writeSite copies only captured screenshots and their sidecars", () => {
  const dir = tmpDir();
  const out = tmpDir("feature-tour-out-");
  const shot = result.shotList.shots[0];
  fs.writeFileSync(path.join(dir, shot.filename), makePng());
  fs.writeFileSync(path.join(dir, "orphan.png"), makePng());
  const built = build(dir);
  writeSite(built, { out, assetsDir: DEFAULTS.assetsDir, screenshotsDir: dir });
  assert.deepEqual(fs.readdirSync(path.join(out, "screenshots")), [shot.filename]);
  for (const file of ["index.html", "tour.html", ".nojekyll", "assets/styles.css", "assets/tour.js", "assets/filter.js", "assets/theme.js"]) {
    assert.ok(fs.existsSync(path.join(out, file)), file);
  }
});

test("an overlay that names an unknown feature is rejected", () => {
  assert.throws(() => generate({ catalog, overlay: { shots: { nope: [] } }, screenshotsDir: tmpDir() }), /unknown feature id/);
  assert.throws(() => generate({ catalog, overlay: { shotOverrides: { "nope.png": {} } }, screenshotsDir: tmpDir() }), /unknown shot filename/);
});
