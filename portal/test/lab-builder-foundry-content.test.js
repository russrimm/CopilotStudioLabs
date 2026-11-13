import { test } from "node:test";
import assert from "node:assert/strict";
import { getFeatures, validateCatalog } from "../lib/lab-builder/catalog.js";
import { getConcepts, getKnownCoverageGaps } from "../lib/lab-builder/concepts.js";
import { productOf } from "../lib/lab-builder/products.js";
import { slotsForFeature } from "../lib/lab-builder/slots.js";
import { planLab } from "../lib/lab-builder/planner.js";

const foundry = () => getFeatures().filter((f) => productOf(f) === "ai-foundry");

test("Microsoft Foundry has a curriculum that spans levels 100, 200, and 300", () => {
  const features = foundry();
  assert.ok(features.length >= 12 && features.length <= 20, `expected 12 to 20 Foundry topics, found ${features.length}`);
  for (const level of [100, 200, 300]) {
    assert.ok(features.filter((f) => f.level === level).length >= 3, `level ${level} needs at least three Foundry topics`);
  }
  assert.deepEqual(validateCatalog(), []);
});

test("every Foundry topic is grounded: fetched Learn pages, a screenshot slot, and a role or prerequisite note", () => {
  for (const feature of foundry()) {
    assert.ok(feature.docUrls.every((url) => url.startsWith("https://learn.microsoft.com/azure/foundry") || url.startsWith("https://learn.microsoft.com/microsoft-copilot-studio/")), `${feature.id} cites a page outside the Foundry roots`);
    assert.ok(slotsForFeature(feature).length >= 1, `${feature.id} needs a screenshot slot`);
    assert.ok(feature.steps.length >= 6, `${feature.id} needs a real walkthrough`);
    assert.ok(feature.concepts.some((c) => /role|subscription|permission|quota|cost|billing|charge/i.test(c)), `${feature.id} should state roles, quota, or cost`);
  }
});

test("Foundry now covers the knowledge, tools, testing, and publish concepts that were known gaps", () => {
  const gaps = getKnownCoverageGaps();
  for (const concept of ["knowledge", "tools", "testing", "publish"]) {
    assert.equal(gaps.includes(`${concept}:ai-foundry`), false, `${concept}:ai-foundry should no longer be a known gap`);
    const entry = getConcepts().find((c) => c.id === concept);
    assert.ok(entry.features.some((id) => id.startsWith("fdy-")), `${concept} lists no Foundry topic`);
  }
});

test("a Foundry lab plans at each level without a harness or Copilot Studio core modules", () => {
  for (const level of [100, 200, 300]) {
    const ids = foundry().filter((f) => f.level === level).map((f) => f.id);
    const plan = planLab({ features: ids, products: ["ai-foundry"], level });
    assert.equal(plan.harness ?? null, null);
    assert.ok(plan.features.every((f) => productOf(f) === "ai-foundry"), `level ${level} plan includes another product's module`);
    assert.ok(plan.features.length >= ids.length);
  }
});
