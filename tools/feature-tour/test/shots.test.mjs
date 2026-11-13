import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { build, catalog, makePng, overlay, tmpDir } from "./helpers.mjs";
import { DEFAULTS, serializeShotList } from "../lib/build.mjs";
import { NAV_SECTIONS } from "../lib/model.mjs";
import { checkFeatureShots } from "../../screenshot-capture/feature-shots-check.mjs";
import { normalizeRect, buildSidecar, sidecarName as captureSidecarName } from "../../screenshot-capture/callouts.mjs";
import { sidecarName } from "../lib/screenshots.mjs";

const { shotList } = build();

function writeManifest(list) {
  const root = tmpDir("feature-tour-repo-");
  const manifest = path.join(root, "tools", "screenshot-capture", "feature-shots.json");
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.mkdirSync(path.join(root, "docs", "feature-tour", "screenshots"), { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify(list));
  return { root, manifest };
}

test("every catalog feature has at least one shot entry", () => {
  const withShots = new Set(shotList.shots.map((s) => s.feature));
  for (const f of catalog.features) assert.ok(withShots.has(f.id), `${f.id} has no shot`);
});

test("a feature with no screenshots in the catalog still gets a slot", () => {
  const extra = { ...structuredClone(catalog.features[0]), id: "brand-new", name: "Brand new", screenshots: [] };
  const out = build(tmpDir(), { ...catalog, features: [...catalog.features, extra] });
  assert.ok(out.shotList.shots.some((s) => s.feature === "brand-new"));
  assert.ok(out.site.features.find((f) => f.id === "brand-new").shots.length >= 1);
});

test("shot list filenames and ids are unique and the schema is valid", () => {
  const filenames = shotList.shots.map((s) => s.filename);
  assert.equal(new Set(filenames).size, filenames.length);
  assert.deepEqual(shotList.shots.map((s) => s.id), shotList.shots.map((_, i) => i + 1));
  const { root, manifest } = writeManifest(shotList);
  const res = checkFeatureShots({ repoRoot: root, manifestPath: manifest });
  assert.deepEqual(res.findings, []);
  assert.equal(res.total, shotList.shots.length);
  assert.equal(res.missing.length, shotList.shots.length, "nothing is captured yet in a fresh folder");
});

test("shot entries carry what the capture tool and tour need", () => {
  for (const s of shotList.shots) {
    assert.ok(s.instructions.length > 0 && s.setup.length > 0, s.filename);
    assert.ok(s.callouts.every((c, i) => c.n === i + 1 && c.label && c.text), s.filename);
    assert.equal(Boolean(s.navSection), NAV_SECTIONS.has(s.section), s.filename);
    if (s.url) assert.match(s.url, /^https:\/\//);
  }
  assert.equal(shotList.assetsDir, "docs/feature-tour/screenshots");
});

test("checker reports pending shots, invalid images, and schema problems", () => {
  const { root, manifest } = writeManifest(shotList);
  const dir = path.join(root, "docs", "feature-tour", "screenshots");
  const [a, b] = shotList.shots;
  fs.writeFileSync(path.join(dir, a.filename), makePng());
  fs.writeFileSync(path.join(dir, b.filename), Buffer.from("tiny"));
  fs.writeFileSync(path.join(dir, "stray.png"), makePng());
  const res = checkFeatureShots({ repoRoot: root, manifestPath: manifest });
  assert.equal(res.captured, 1);
  assert.deepEqual(res.findings.map((f) => f.code).sort(), ["feature-shots-invalid-image", "feature-shots-orphan"]);
  assert.ok(res.missing.some((m) => m.filename === b.filename));

  const strict = checkFeatureShots({ repoRoot: root, manifestPath: manifest, strictMissing: true });
  assert.ok(strict.findings.some((f) => f.code === "feature-shots-pending" && f.severity === "critical"));

  const broken = structuredClone(shotList);
  broken.shots[1].filename = broken.shots[0].filename;
  broken.shots[2].callouts = [{ n: 2, label: "", text: "x" }];
  const second = writeManifest(broken);
  const codes = checkFeatureShots({ repoRoot: second.root, manifestPath: second.manifest }).findings.map((f) => f.code);
  assert.ok(codes.includes("feature-shots-duplicate-filename"));
  assert.ok(codes.includes("feature-shots-callouts"));
});

test("committed feature-shots.json matches the catalog and overlay", () => {
  const committed = fs.readFileSync(DEFAULTS.shotList, "utf8").replace(/\r\n/g, "\n");
  assert.equal(
    committed,
    serializeShotList(shotList),
    "Run: npm run feature-tour:build and commit tools/screenshot-capture/feature-shots.json",
  );
});

test("adding a feature to the catalog makes the committed shot list stale", () => {
  const committed = fs.readFileSync(DEFAULTS.shotList, "utf8").replace(/\r\n/g, "\n");
  const extra = { ...structuredClone(catalog.features[0]), id: "brand-new", name: "Brand new", screenshots: [] };
  const out = build(tmpDir(), { ...catalog, features: [...catalog.features, extra] });
  assert.notEqual(serializeShotList(out.shotList), committed);
});

test("build --check exits 0 when current", () => {
  const run = spawnSync(process.execPath, [path.join(path.dirname(DEFAULTS.overlay), "build.mjs"), "--check"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
});

test("verify-shots reports pending screenshots without failing, and fails in strict-missing mode", () => {
  const script = path.join(DEFAULTS.shotList, "..", "verify-shots.js");
  const base = spawnSync(process.execPath, [script, "--product=copilot-studio", "--json"], { encoding: "utf8" });
  assert.equal(base.status, 0, base.stderr);
  const report = JSON.parse(base.stdout);
  assert.equal(report.featureTour.total, shotList.shots.length);
  assert.equal(report.featureTour.captured + report.featureTour.pending, report.featureTour.total);
  const shotsDir = path.resolve(path.dirname(DEFAULTS.shotList), "..", "..", "docs", "feature-tour", "screenshots");
  const anyCaptured = fs.readdirSync(shotsDir).some((n) => /\.(png|jpe?g|webp)$/i.test(n));
  if (!anyCaptured) {
    const strict = spawnSync(process.execPath, [script, "--product=copilot-studio", "--strict-missing"], { encoding: "utf8" });
    assert.equal(strict.status, 1);
  }
});

test("callout geometry is normalized to the viewport", () => {
  assert.deepEqual(normalizeRect({ x: 144, y: 90, width: 288, height: 45 }, { width: 1440, height: 900 }), { x: 0.1, y: 0.1, w: 0.2, h: 0.05 });
  assert.deepEqual(normalizeRect({ x: -50, y: 0, width: 100, height: 100 }, { width: 1000, height: 1000 }), { x: 0, y: 0, w: 0.05, h: 0.1 });
  assert.equal(normalizeRect(null, { width: 10, height: 10 }), null);
  assert.equal(normalizeRect({ x: 2000, y: 0, width: 50, height: 50 }, { width: 1000, height: 1000 }), null);
  const sidecar = buildSidecar("a.png", { width: 1440, height: 900 }, [{ n: 1, label: "L", rect: null }]);
  assert.deepEqual(sidecar.callouts, [{ n: 1, label: "L", rect: null }]);
  assert.equal(captureSidecarName("x/y.png".split("/")[1]), sidecarName("y.png"));
  assert.equal(sidecarName("create-agent.png"), "create-agent.callouts.json");
});

test("overlay shots only reference known features", () => {
  const ids = new Set(catalog.features.map((f) => f.id));
  for (const id of Object.keys(overlay.shots)) assert.ok(ids.has(id), id);
});
