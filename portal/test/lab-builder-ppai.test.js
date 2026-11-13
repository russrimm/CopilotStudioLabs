import { test } from "node:test";
import assert from "node:assert/strict";

import { getFeatures } from "../lib/lab-builder/catalog.js";
import { getProduct, productOf } from "../lib/lab-builder/products.js";
import { planLab } from "../lib/lab-builder/planner.js";
import { slotsForFeature, describeSlot } from "../lib/lab-builder/slots.js";

process.env.LAB_BUILDER_LINK_CHECK = "off";
process.env.LAB_BUILDER_VENDOR_DOCS = "off";

const PRODUCT = "power-platform-ai-hub";
const features = () => getFeatures().filter((f) => productOf(f) === PRODUCT);

test("the Power Platform AI hub catalog is a full curriculum with a feature at every level", () => {
  const all = features();
  assert.ok(all.length >= 12 && all.length <= 20, `expected 12-20 features, got ${all.length}`);
  for (const level of getProduct(PRODUCT).levels) {
    assert.ok(all.some((f) => f.level === level), `no feature at level ${level}`);
  }
  assert.ok(all.every((f) => f.id.startsWith("ppai-")));
});

test("every Power Platform AI hub feature cites Learn, has screenshot slots with curated alt text, and bolds its UI names", () => {
  for (const feature of features()) {
    assert.ok(feature.docUrls.every((u) => u.startsWith("https://learn.microsoft.com/")), `${feature.id}: docUrls must be Learn pages`);
    assert.ok(feature.docUrls.includes(feature.verifiedAgainst), `${feature.id}: verifiedAgainst must be a docUrl`);
    const slots = slotsForFeature(feature);
    assert.ok(slots.length > 0, `${feature.id}: needs at least one screenshot slot`);
    for (const slot of slots) assert.ok(describeSlot(feature, slot).curated, `${feature.id}: ${slot.filename} needs curated alt text`);
    assert.ok(feature.steps.some((s) => /\*\*[^*]+\*\*/.test(s)), `${feature.id}: steps should bold UI names`);
    assert.ok(!feature.harness, `${feature.id}: AI hub features carry no harness`);
  }
});

test("availability is only set where it is a valid Learn-stated value and conflicting pages are called out", () => {
  const byId = Object.fromEntries(features().map((f) => [f.id, f]));
  for (const f of features()) {
    if (f.availability !== undefined) assert.ok(["ga", "preview", "retired"].includes(f.availability), f.id);
  }
  // Learn labels these two inconsistently, so the catalog states the conflict instead of picking a status.
  for (const id of ["ppai-prebuilt-receipt-processing-flow", "ppai-powerfx-ai-models-in-canvas-app"]) {
    assert.equal(byId[id].availability, undefined, `${id} must not claim a status Learn contradicts`);
    assert.ok(byId[id].concepts.some((c) => c.includes("Not confirmed in Microsoft Learn")), `${id} must flag the conflict`);
  }
});

test("a level 200 plan for the AI hub keeps lower-level prerequisites and stays inside the product", () => {
  const plan = planLab({ products: [PRODUCT], features: ["ppai-prediction-model", "ppai-human-review-prompt-output"], level: 200 });
  const ids = plan.features.map((f) => f.id);
  assert.ok(ids.includes("ppai-explore-ai-hub-models"), "level 100 prerequisite is added");
  assert.ok(ids.includes("ppai-use-prompt-in-flow-and-app") && ids.includes("ppai-build-custom-prompt"));
  assert.ok(plan.features.every((f) => productOf(f) === PRODUCT));
});
