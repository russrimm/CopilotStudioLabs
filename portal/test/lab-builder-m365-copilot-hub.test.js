import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getFeatures, validateCatalog } from "../lib/lab-builder/catalog.js";
import { getConcepts } from "../lib/lab-builder/concepts.js";
import { generateLab } from "../lib/lab-builder/generator.js";
import { planLab } from "../lib/lab-builder/planner.js";
import { recommend } from "../lib/lab-builder/recommend.js";
import { getSlotMeta, slotsForFeature } from "../lib/lab-builder/slots.js";

process.env.LAB_BUILDER_LINK_CHECK = "off";
process.env.LAB_BUILDER_VENDOR_DOCS = "off";

const PRODUCT = "m365-copilot-hub";
const hub = () => getFeatures().filter((f) => f.product === PRODUCT);

test("the Microsoft 365 Copilot hub offers a curriculum at every level, with a screenshot slot per topic", () => {
  assert.deepEqual(validateCatalog(), []);
  const features = hub();
  assert.ok(features.length >= 12, "enough topics for a whole curriculum");
  for (const level of [100, 200, 300]) {
    assert.ok(features.filter((f) => f.level === level).length >= 3, `level ${level} has at least three topics`);
  }
  for (const f of features) {
    assert.ok(f.id.startsWith("m365h-"), `${f.id} uses the m365h- prefix`);
    assert.ok(f.steps.length >= 6, `${f.id} has a real walkthrough`);
    assert.ok(f.steps.some((s) => /\*\*[^*]+\*\*/.test(s)), `${f.id} bolds UI names`);
    const slots = slotsForFeature(f);
    assert.ok(slots.length >= 1, `${f.id} has at least one screenshot slot`);
    for (const slot of slots) assert.ok(getSlotMeta()[slot.filename], `${slot.filename} has alt text`);
  }
});

test("every hub topic belongs to a concept that lists the hub, and recommendations surface hub topics at each level", () => {
  const concepts = getConcepts();
  for (const f of hub()) {
    const owners = concepts.filter((c) => c.features.includes(f.id));
    assert.equal(owners.length, 1, `${f.id} is in exactly one concept`);
    assert.ok(owners[0].products.includes(PRODUCT), `${f.id}'s concept lists the hub`);
  }
  for (const level of [100, 200, 300]) {
    const result = recommend({ products: [PRODUCT], level });
    const ids = result.concepts.flatMap((c) => c.topics.map((t) => t.id));
    assert.ok(ids.some((id) => id.startsWith("m365h-")), `level ${level} lists hub topics`);
    assert.ok(result.concepts.flatMap((c) => c.topics).some((t) => t.selected), `level ${level} pre-selects hub topics`);
  }
});

test("a hub lab builds offline and passes the validator, with lower-level prerequisites as recaps", async () => {
  const plan = planLab({ products: [PRODUCT], level: 300, features: ["m365h-agent-management-rules"] });
  assert.equal(plan.harness ?? null, null);
  assert.deepEqual(plan.prerequisites, ["m365h-review-agent-inventory", "m365h-control-agent-availability", "m365h-agent-lifecycle-actions"]);
  assert.ok(plan.features.filter((f) => f.prerequisite).length === 3, "lower-level prerequisites become recaps");

  const outputRoot = mkdtempSync(join(tmpdir(), "hub-lab-"));
  try {
    const result = await generateLab(
      { products: [PRODUCT], features: ["m365h-tour-copilot-settings", "m365h-control-web-search", "m365h-dlp-for-copilot"], title: "Hub sample" },
      { outputRoot, useLearnMcp: false, useLlm: false },
    );
    assert.equal(result.status, "complete");
    assert.equal(result.validation.failed, 0);
    const markdown = readFileSync(join(result.outputDir, "index.md"), "utf8");
    assert.match(markdown, /Allow web search in Copilot/);
    assert.doesNotMatch(markdown, /Microsoft Copilot harness/);
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});
