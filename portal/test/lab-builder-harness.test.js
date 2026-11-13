import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getFeature, getFeatures, getFeaturesByCategory, getHarnesses, LEVELS, validateCatalog } from "../lib/lab-builder/catalog.js";
import { planLab } from "../lib/lab-builder/planner.js";
import { containsPhrase, normalizeText } from "../lib/step-validator/text.js";

process.env.LAB_BUILDER_LINK_CHECK = "off";
process.env.LAB_BUILDER_VENDOR_DOCS = "off";

const NOW = Date.parse("2026-11-12T12:00:00Z");
const LEARN = "https://learn.microsoft.com/microsoft-copilot-studio/";

function feature(overrides = {}) {
  return {
    id: "sample",
    name: "Sample",
    category: "foundations",
    level: 100,
    minutes: 10,
    harness: ["standard"],
    summary: "Configure something.",
    whyItMatters: "It matters.",
    concepts: ["A concept."],
    steps: ["Select **Create**."],
    validation: ["It worked."],
    learnQueries: ["Copilot Studio sample"],
    docUrls: [`${LEARN}sample`],
    lastVerified: "2026-11-12",
    verifiedAgainst: `${LEARN}sample`,
    prereqs: [],
    ...overrides,
  };
}

function catalog(features, harnesses) {
  return {
    categories: [{ id: "foundations" }],
    harnesses: harnesses ?? [
      { id: "standard", name: "Standard harness", description: "Classic.", learnUrl: `${LEARN}harnesses-overview` },
      { id: "microsoft-copilot", name: "Microsoft Copilot harness", description: "New.", learnUrl: `${LEARN}harnesses-overview` },
    ],
    features,
  };
}

test("a feature tagged with known harnesses passes", () => {
  const raw = catalog([feature({ harness: ["standard", "microsoft-copilot"], availability: "preview", harnessNote: "A difference." })]);
  assert.deepEqual(validateCatalog(raw, { now: NOW }), []);
});

test("harness tags are required once a catalog declares harnesses", () => {
  const missing = validateCatalog(catalog([feature({ harness: undefined })]), { now: NOW });
  assert.ok(missing.some((p) => /sample: harness must list/.test(p)), missing.join("\n"));

  const unknown = validateCatalog(catalog([feature({ harness: ["copilot-chat"] })]), { now: NOW });
  assert.ok(unknown.some((p) => /unknown harness "copilot-chat"/.test(p)), unknown.join("\n"));

  const badAvailability = validateCatalog(catalog([feature({ availability: "beta" })]), { now: NOW });
  assert.ok(badAvailability.some((p) => /availability must be one of/.test(p)), badAvailability.join("\n"));
});

test("a catalog that declares no harnesses is not checked for tags", () => {
  const raw = catalog([feature({ harness: undefined })], []);
  assert.deepEqual(validateCatalog(raw, { now: NOW }), []);
});

test("a feature cannot require a prerequisite from a higher level", () => {
  const raw = catalog([
    feature({ id: "advanced", level: 300, minutes: 30 }),
    feature({ id: "basic", level: 100, prereqs: ["advanced"] }),
  ]);
  const problems = validateCatalog(raw, { now: NOW });
  assert.ok(problems.some((p) => /basic: level 100 feature requires advanced, which is level 300/.test(p)), problems.join("\n"));
});

test("the shipped catalog tags every feature and covers every shipped harness and all three levels", () => {
  assert.deepEqual(getHarnesses().map((h) => h.id), ["standard", "microsoft-copilot", "customer-conversation"]);
  const features = getFeatures();
  for (const f of features) assert.ok(f.harness?.length, `${f.id} has no harness`);
  assert.ok(features.some((f) => f.harness.length === 1 && f.harness[0] === "microsoft-copilot"));
  assert.ok(features.some((f) => f.harness.length === 1 && f.harness[0] === "standard"));
  for (const { level } of LEVELS) assert.ok(features.some((f) => f.level === level), `no feature at level ${level}`);
});

test("harness notes only point at features that exist", () => {
  for (const f of getFeatures()) {
    for (const [, id] of (f.harnessNote || "").matchAll(/\b((?:mc|test)-[a-z-]+[a-z])\b/g)) {
      assert.ok(getFeature(id), `${f.id}: harnessNote mentions unknown feature ${id}`);
    }
  }
});

test("the wizard payload carries harness, availability, and note", () => {
  const flat = getFeaturesByCategory().flatMap((c) => c.features);
  const workIq = flat.find((f) => f.id === "work-iq");
  assert.deepEqual(workIq.harness, ["microsoft-copilot"]);
  assert.equal(workIq.availability, "ga");
  assert.ok(flat.find((f) => f.id === "topics").harnessNote);
});

test("the catalog uses the Microsoft Copilot harness name everywhere", () => {
  const found = [];
  const walk = (value, path) => {
    if (typeof value === "string") {
      if (/github copilot harness/i.test(value.replace(/https?:\/\/\S+/g, ""))) found.push(path);
    } else if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`));
    else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`);
  };
  walk({ harnesses: getHarnesses(), features: getFeatures() }, "catalog");
  assert.deepEqual(found.length, 0, found.join("\n"));
});

test("the old and new harness names compare equal against Learn text", () => {
  assert.equal(normalizeText("GitHub Copilot harness"), normalizeText("Microsoft Copilot harness"));
  assert.equal(normalizeText("agents powered by the GitHub Copilot Harness"), "agents powered by the microsoft copilot harness");
  assert.ok(containsPhrase(normalizeText("Manage costs for agents powered by the GitHub Copilot harness"), normalizeText("Microsoft Copilot harness")));
  assert.equal(normalizeText("GitHub Copilot extension"), "github copilot extension");
});

test("core modules follow the harness the requested features belong to", () => {
  const ids = (features) => planLab({ features }).features.map((f) => f.id);

  const microsoft = ids(["work-iq"]);
  assert.ok(microsoft.includes("mc-create-agent"));
  assert.ok(!microsoft.includes("create-agent"));

  const standard = ids(["topics"]);
  assert.ok(standard.includes("create-agent"));
  assert.ok(!standard.includes("mc-create-agent"));

  const neutral = ids(["mc-harness-choice"]);
  assert.ok(neutral.includes("create-agent"), "a feature tagged for both harnesses keeps the standard core");
});

test("a lab that mixes harnesses says so", () => {
  const mixed = planLab({ features: ["topics", "mc-skills"] });
  assert.ok(mixed.warnings.some((w) => /mixes standard harness and Microsoft Copilot harness/.test(w)), mixed.warnings.join("\n"));
  const single = planLab({ features: ["mc-skills"] });
  assert.ok(!single.warnings.some((w) => /mixes/.test(w)));
});

test("every harness's full module set generates a complete lab that passes the portal validator", async () => {
  const { generateLab } = await import("../lib/lab-builder/generator.js");
  for (const harness of ["standard", "microsoft-copilot"]) {
    const features = getFeatures().filter((f) => f.harness.includes(harness)).map((f) => f.id);
    let lab;
    const root = mkdtempSync(join(tmpdir(), "harness-lab-"));
    try {
      lab = await generateLab({ features, harness }, { outputRoot: root, useLearnMcp: false, useLlm: false });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    assert.equal(lab.status, "complete", `${harness}: ${lab.blockers.map((b) => b.code)}`);
    assert.equal(lab.validation.failed, 0, `${harness}: ${lab.validation.tests.filter((t) => t.status === "fail").map((t) => t.name)}`);
    for (const f of features) assert.ok(lab.markdown.includes(getFeature(f).name), `${harness}: ${f} is missing from the lab`);
  }
});