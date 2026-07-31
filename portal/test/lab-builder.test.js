import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getCategories,
  getFeatures,
  getFeature,
  getFeaturesByCategory,
  expandPrereqs,
  orderFeatures,
  validateCatalog,
} from "../lib/lab-builder/catalog.js";
import { planLab, slugify } from "../lib/lab-builder/planner.js";
import { generateLab } from "../lib/lab-builder/generator.js";
import { detectProvider } from "../lib/lab-builder/llm.js";
import { scrubForbidden } from "../lib/lab-builder/composer.js";

// ── Catalog ─────────────────────────────────────────────────────────────────

test("catalog has no integrity problems", () => {
  assert.deepEqual(validateCatalog(), []);
});

test("catalog exposes categories and features", () => {
  assert.ok(getCategories().length >= 5);
  assert.ok(getFeatures().length >= 20);
  assert.equal(getFeature("create-agent").id, "create-agent");
  assert.equal(getFeature("does-not-exist"), null);
});

test("every feature belongs to a rendered category group", () => {
  const grouped = getFeaturesByCategory().flatMap((c) => c.features.map((f) => f.id));
  for (const feature of getFeatures()) {
    assert.ok(grouped.includes(feature.id), `${feature.id} is not in any category group`);
  }
});

test("expandPrereqs pulls in transitive prerequisites", () => {
  const ids = expandPrereqs(["agent-to-agent"]);
  assert.ok(ids.includes("connected-agents"));
  assert.ok(ids.includes("generative-orchestration"));
  assert.ok(ids.includes("create-agent"));
});

test("expandPrereqs drops unknown ids", () => {
  assert.deepEqual(expandPrereqs(["not-a-feature"]), []);
});

test("orderFeatures places every prerequisite before its dependent", () => {
  const ids = orderFeatures(expandPrereqs(["agent-to-agent", "analytics", "channel-teams"]));
  for (const [index, id] of ids.entries()) {
    for (const prereq of getFeature(id).prereqs || []) {
      if (!ids.includes(prereq)) continue;
      assert.ok(ids.indexOf(prereq) < index, `${prereq} must come before ${id}`);
    }
  }
});

// ── Planner ─────────────────────────────────────────────────────────────────

test("planLab rejects an empty feature selection", () => {
  assert.throws(() => planLab({ features: [] }), /at least one/i);
});

test("planLab produces an ordered, numbered module list", () => {
  const plan = planLab({ industry: "retail", roles: ["customer-service"], features: ["connector-tools"] });
  assert.ok(plan.features.length >= 2);
  assert.deepEqual(
    plan.features.map((f) => f.order),
    plan.features.map((_, i) => i + 1),
  );
  assert.equal(plan.industry.id, "retail");
  assert.equal(plan.roles[0].id, "customer-service");
  assert.match(plan.title, /Retail/);
});

test("planLab respects a time budget and reports deferred modules", () => {
  const plan = planLab({ industry: "retail", features: ["agent-to-agent", "voice-agents"], timeBudget: 60 });
  assert.ok(plan.totalMinutes <= 60, `expected <= 60 minutes, got ${plan.totalMinutes}`);
  assert.ok(plan.deferred.length > 0);
});

test("planLab warns about unknown industries and roles", () => {
  const plan = planLab({ industry: "nope", roles: ["nope"], features: ["topics"] });
  assert.ok(plan.warnings.some((w) => /Unknown industry/i.test(w)));
  assert.ok(plan.warnings.some((w) => /Unknown role/i.test(w)));
});

test("slugify produces filesystem-safe names", () => {
  assert.equal(slugify("Retail: Store & Support!"), "retail-store-support");
});

// ── LLM detection ───────────────────────────────────────────────────────────

test("detectProvider prefers Azure OpenAI, then GitHub Models, then none", () => {
  assert.equal(
    detectProvider({
      AZURE_OPENAI_ENDPOINT: "https://x.openai.azure.com",
      AZURE_OPENAI_API_KEY: "k",
      AZURE_OPENAI_DEPLOYMENT: "gpt-4o",
      GITHUB_TOKEN: "t",
    }).kind,
    "azure-openai",
  );
  assert.equal(detectProvider({ GITHUB_TOKEN: "t" }).kind, "github-models");
  assert.equal(detectProvider({}).kind, "none");
  assert.equal(detectProvider({ GITHUB_TOKEN: "t", LAB_BUILDER_LLM: "off" }).kind, "none");
});

// ── Composer ────────────────────────────────────────────────────────────────

test("scrubForbidden removes markers the lab validator rejects", () => {
  const cleaned = scrubForbidden("TODO check this, FIXME later, TBD, XXX");
  assert.doesNotMatch(cleaned, /\b(?:TODO|FIXME|TBD|XXX)\b/i);
});

// ── Generator (offline: no network, no LLM) ─────────────────────────────────

test("generateLab writes a lab that passes every validator rule", async (t) => {
  const outputRoot = mkdtempSync(join(tmpdir(), "lab-builder-test-"));
  t.after(() => rmSync(outputRoot, { recursive: true, force: true }));

  const result = await generateLab(
    {
      industry: "energy-resources",
      roles: ["operations"],
      features: ["knowledge-sharepoint", "connector-tools", "analytics"],
      timeBudget: 300,
    },
    { outputRoot, useLearnMcp: false, useLlm: false },
  );

  assert.ok(existsSync(join(result.outputDir, "index.md")));
  assert.ok(existsSync(join(result.outputDir, "manifest.json")));
  assert.equal(result.validation.failed, 0, JSON.stringify(result.validation.tests.filter((x) => x.status === "fail")));
  assert.ok(result.validation.passed >= 15);

  const markdown = readFileSync(join(result.outputDir, "index.md"), "utf8");
  assert.match(markdown, /^# /m);
  assert.match(markdown, /\*\*DIFFICULTY\*\*/);
  assert.match(markdown, /\*\*INDUSTRIES\*\*/);
  assert.match(markdown, /^## Overview$/m);
  assert.match(markdown, /^## Learning Objectives$/m);
  assert.match(markdown, /^### Step 1 - /m);
  assert.doesNotMatch(markdown, /\b(?:TODO|FIXME|TBD|XXX)\b/i);
});

test("generateLab dry run writes nothing", async () => {
  const result = await generateLab(
    { industry: "education", features: ["topics"] },
    { write: false, useLearnMcp: false, useLlm: false },
  );
  assert.equal(result.outputDir, null);
  assert.ok(result.markdown.length > 500);
});

test("generateLab records offline grounding as a warning, not a failure", async () => {
  const result = await generateLab(
    { industry: "nonprofit", features: ["topics"] },
    { write: false, useLearnMcp: false, useLlm: false },
  );
  assert.equal(result.manifest.grounding.groundedModules, 0);
  assert.ok(result.plan.warnings.some((w) => /Learn/i.test(w)));
});
