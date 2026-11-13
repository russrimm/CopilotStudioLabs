import { test } from "node:test";
import assert from "node:assert/strict";
import { generateLab } from "../lib/lab-builder/generator.js";
import { assessLab } from "../lib/lab-builder/qa.js";
import { getFeatures, validateCatalog } from "../lib/lab-builder/catalog.js";
import { getKnownCoverageGaps } from "../lib/lab-builder/concepts.js";
import { getSlotMeta } from "../lib/lab-builder/slots.js";

const PRODUCT = "m365-copilot-agent-builder";
const mine = () => getFeatures().filter((f) => f.product === PRODUCT);

test("Agent Builder has a curriculum across all three levels and a clean catalog", () => {
  const features = mine();
  assert.ok(features.length >= 12 && features.length <= 20, `${features.length} features`);
  for (const level of [100, 200, 300]) assert.ok(features.some((f) => f.level === level), `level ${level}`);
  assert.deepEqual(validateCatalog(), []);
  assert.ok(!getKnownCoverageGaps().includes(`tools:${PRODUCT}`), "the tools gap is filled");
});

test("every Agent Builder feature has screenshot slots with curated alt text", () => {
  const meta = getSlotMeta();
  for (const f of mine()) {
    assert.ok(f.screenshots?.length, `${f.id} has no screenshot slots`);
    for (const slot of f.screenshots) {
      assert.ok(slot.filename.startsWith("dca-"), slot.filename);
      assert.ok(meta[slot.filename], `${slot.filename} has no alt text entry`);
    }
  }
});

test("availability is stated only where Learn states it", () => {
  const withAvailability = mine().filter((f) => f.availability);
  assert.deepEqual(withAvailability.map((f) => f.id), ["dca-agent-builder-skills"]);
  assert.equal(withAvailability[0].availability, "preview");
});

test("a multi-module Agent Builder lab never prints an undefined sample prompt and passes QA", async () => {
  const { markdown, status } = await generateLab(
    {
      features: ["dca-write-agent-instructions", "dca-agent-builder-knowledge", "dca-agent-builder-capabilities", "dca-agent-builder-skills", "dca-toolkit-api-plugin-typespec"],
      products: [PRODUCT],
      level: 200,
    },
    { write: false, useLearnMcp: false, useLlm: false, checkLinks: false },
  );
  assert.equal(status, "complete");
  assert.doesNotMatch(markdown, /undefined/);
  assert.doesNotMatch(markdown, /Microsoft Copilot harness/);
  assert.ok(assessLab(markdown, {}).score >= 85);
});
