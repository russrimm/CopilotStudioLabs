import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getFeatures, validateCatalog } from "../lib/lab-builder/catalog.js";
import { getConcepts, getKnownCoverageGaps } from "../lib/lab-builder/concepts.js";
import { generateLab } from "../lib/lab-builder/generator.js";
import { planLab } from "../lib/lab-builder/planner.js";
import { recommend } from "../lib/lab-builder/recommend.js";
import { validateLabDir } from "../lib/validator.js";

process.env.LAB_BUILDER_LINK_CHECK = "off";
process.env.LAB_BUILDER_VENDOR_DOCS = "off";

const HARNESS = "customer-conversation";
const ccFeatures = () => getFeatures().filter((f) => f.harness.includes(HARNESS));

test("every concept has a Customer Conversation variant or a reason, and no gap is left", () => {
  assert.deepEqual(validateCatalog(), []);
  assert.deepEqual(getKnownCoverageGaps().filter((gap) => gap.endsWith(`:${HARNESS}`)), []);
  const features = new Map(getFeatures().map((f) => [f.id, f]));
  for (const concept of getConcepts()) {
    const variants = concept.features.filter((id) => features.get(id)?.harness.includes(HARNESS));
    assert.ok(variants.length || concept.notApplicable?.[HARNESS], `${concept.id} has neither a variant nor a reason`);
    if (!variants.length) assert.match(concept.notApplicable[HARNESS], /Learn/, `${concept.id}: the reason says what Learn says`);
  }
});

test("Customer Conversation features are single-harness and cite the Learn pages they were verified against", () => {
  for (const f of ccFeatures()) {
    assert.deepEqual(f.harness, [HARNESS], f.id);
    assert.ok(f.docUrls.includes(f.verifiedAgainst), `${f.id}: verifiedAgainst is one of docUrls`);
    assert.ok(f.docUrls.every((u) => u.startsWith("https://learn.microsoft.com/")), `${f.id}: Learn only`);
    assert.ok(f.screenshots.length === 0 || f.screenshots.every((s) => s.filename.startsWith("cc-")), f.id);
  }
});

test("the wizard recommends only Customer Conversation topics at each level, with core modules first", () => {
  const level100 = recommend({ harness: HARNESS, level: 100 });
  assert.ok(level100.selectedIds.length >= 5);
  assert.ok(level100.selectedIds.every((id) => ccFeatures().some((f) => f.id === id)), level100.selectedIds.join(", "));
  assert.ok(level100.selectedIds.includes("cc-create-agent"));

  const level300 = recommend({ harness: HARNESS, level: 300 });
  assert.ok(level300.totals.minutes > level100.totals.minutes);
  const covered = level300.concepts.filter((c) => c.topics.length);
  assert.ok(covered.length >= 19, `${covered.length} concepts have Customer Conversation topics`);
  const notApplicable = level300.concepts.filter((c) => !c.topics.length);
  assert.ok(notApplicable.every((c) => c.notApplicable && !c.notYetAvailable), "empty concepts explain themselves");
});

test("prerequisites join a Customer Conversation lab with the topic that needs them", () => {
  const rec = recommend({ harness: HARNESS, level: 100, selected: ["cc-contact-center"] });
  for (const id of ["cc-deploy-channels", "cc-teams-phone", "cc-preview-test", "cc-create-agent"]) {
    const topic = rec.concepts.flatMap((c) => c.topics).find((t) => t.id === id);
    assert.ok(topic?.selected && topic.required, `${id} is added as a prerequisite`);
    assert.ok(topic.reasons.some((r) => /Required by/.test(r)), `${id} says why`);
  }
  const added = rec.totals.minutes;
  assert.equal(
    added,
    rec.concepts.flatMap((c) => c.topics).filter((t) => t.selected).reduce((sum, t) => sum + t.minutes, 0),
    "review time totals count the added prerequisites",
  );
});

test("a plan for one Customer Conversation topic takes its core modules from the same harness", () => {
  const plan = planLab({ features: ["cc-escalate-human"] });
  assert.equal(plan.harness, HARNESS);
  const ids = plan.features.map((f) => f.id);
  assert.ok(ids.includes("cc-create-agent") && ids.includes("cc-add-tools"));
  assert.ok(!ids.includes("create-agent") && !ids.includes("mc-create-agent"), ids.join(", "));
  assert.ok(plan.features.every((f) => f.harness.includes(HARNESS)));

  const mixed = planLab({ features: ["cc-escalate-human", "topics"] });
  assert.ok(mixed.warnings.some((w) => /mixes .*Customer Conversation harness.* modules/.test(w)), mixed.warnings.join("\n"));
});

test("a full Customer Conversation lab generates and passes the lab validator", async (t) => {
  const outputRoot = mkdtempSync(join(tmpdir(), "lab-builder-cc-"));
  t.after(() => rmSync(outputRoot, { recursive: true, force: true }));

  const features = ccFeatures().map((f) => f.id);
  const result = await generateLab({ features, harness: HARNESS }, { outputRoot, useLearnMcp: false, useLlm: false });

  assert.equal(result.validation.failed, 0, JSON.stringify(result.validation.tests.filter((x) => x.status === "fail")));
  assert.ok(existsSync(join(result.outputDir, "index.md")));
  const markdown = readFileSync(join(result.outputDir, "index.md"), "utf8");
  assert.match(markdown, /written for the Customer Conversation harness/);
  assert.match(markdown, /How this differs on the Microsoft Copilot harness/);
  for (const f of ccFeatures()) assert.ok(markdown.includes(f.name), `${f.name} is in the lab`);

  const again = validateLabDir(result.outputDir, { labId: "cc-sample", title: "cc-sample" });
  assert.equal(again.failed, 0, JSON.stringify(again.tests.filter((x) => x.status === "fail")));
});
