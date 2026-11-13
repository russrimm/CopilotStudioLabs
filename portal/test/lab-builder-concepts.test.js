import { test } from "node:test";
import assert from "node:assert/strict";

import { getFeatures, getHarnesses, validateCatalog } from "../lib/lab-builder/catalog.js";
import { getConcepts, getConceptForFeature, getRecommendations, validateConcepts } from "../lib/lab-builder/concepts.js";
import { recommend } from "../lib/lab-builder/recommend.js";
import { planLab } from "../lib/lab-builder/planner.js";

const FEATURES = [
  { id: "a", harness: ["standard"], level: 100 },
  { id: "b", harness: ["microsoft-copilot"], level: 100 },
];
const HARNESSES = [{ id: "standard" }, { id: "microsoft-copilot" }];
const RECS = { levels: { 100: ["a"] }, verticals: {}, departments: {} };

test("every shipped feature belongs to exactly one concept, and the catalog stays valid", () => {
  const owners = new Map();
  for (const concept of getConcepts()) for (const id of concept.features) owners.set(id, [...(owners.get(id) || []), concept.id]);
  for (const f of getFeatures()) assert.deepEqual(owners.get(f.id)?.length, 1, `${f.id} belongs to ${owners.get(f.id)}`);
  assert.equal(getConceptForFeature("mc-skills").id, "skills");
  assert.equal(getConceptForFeature("prompt-tools").id, "skills");
  assert.deepEqual(validateCatalog(), []);
});

test("concept validation names every inconsistency", () => {
  const concept = (over) => ({ id: "c", name: "C", summary: "S", order: 1, features: ["a"], notApplicable: {}, ...over });
  const check = (concepts, recommendations = RECS) =>
    validateConcepts({ concepts, recommendations, features: FEATURES, harnesses: HARNESSES });

  assert.match(check([concept({ features: ["a"] })]).join("\n"), /b: does not belong to any concept/);
  assert.match(check([concept({ features: ["a", "b", "zzz"] })]).join("\n"), /unknown feature "zzz"/);
  assert.match(check([concept({ features: ["a", "b"] }), concept({ id: "d", features: ["a"] })]).join("\n"), /a: listed under both c and d/);
  assert.match(check([concept({ features: ["a", "b"], notApplicable: { "microsoft-copilot": "why" } })]).join("\n"), /a feature for it exists/);
  assert.match(check([concept({ features: ["a", "b"], notApplicable: { standard: "" } })]).join("\n"), /needs a reason/);
  assert.match(check([concept({ features: ["a", "b"] })], { levels: { 100: ["nope"] } }).join("\n"), /unknown feature "nope"/);
  assert.deepEqual(check([concept({ features: ["a", "b"] })]), []);
});

test("recommendations cite a reason for every pre-selected topic", () => {
  const result = recommend({ industry: "healthcare", departments: ["it"], level: 200, harness: "standard" });
  const selected = result.concepts.flatMap((c) => c.topics).filter((t) => t.selected);
  assert.ok(selected.length > 5);
  for (const topic of selected) assert.ok(topic.reasons.length, `${topic.id} has no reason`);
  assert.ok(selected.some((t) => t.id === "servicenow-integration" && /IT/.test(t.reasons.join(" "))));
  // Healthcare's FHIR topic is level 300, so it is selectable but not recommended at level 200.
  const fhir = result.concepts.flatMap((c) => c.topics).find((t) => t.id === "epic-fhir-integration");
  assert.equal(fhir.selected, false);
  assert.equal(recommend({ industry: "healthcare", level: 300 }).selectedIds.includes("epic-fhir-integration"), true);
});

test("prerequisites are selected as required, with the topic that needs them", () => {
  const result = recommend({ level: 200, harness: "standard" });
  const flat = result.concepts.flatMap((c) => c.topics);
  const orchestration = flat.find((t) => t.id === "generative-orchestration");
  assert.ok(orchestration.selected);
  const instructions = flat.find((t) => t.id === "agent-instructions");
  assert.ok(instructions.selected && instructions.required);
  assert.match(instructions.reasons.join(" "), /Required by/);
});

test("every topic that applies to the harness stays selectable, and others are explained", () => {
  for (const harness of getHarnesses().map((h) => h.id)) {
    const result = recommend({ harness });
    const listed = new Set(result.concepts.flatMap((c) => c.topics.map((t) => t.id)));
    for (const f of getFeatures().filter((f) => f.harness.includes(harness))) {
      assert.ok(listed.has(f.id), `${f.id} missing for ${harness}`);
    }
    for (const concept of result.concepts) {
      if (!concept.topics.length) assert.ok(concept.notApplicable, `${concept.id} has no topics and no reason on ${harness}`);
    }
  }
  const mc = recommend({ harness: "microsoft-copilot" });
  assert.match(mc.concepts.find((c) => c.id === "conversation-design").notApplicable, /instructions/i);
  assert.ok(mc.concepts.find((c) => c.id === "skills").topics.some((t) => t.id === "mc-skills"));
  const std = recommend({ harness: "standard" });
  assert.ok(std.concepts.find((c) => c.id === "skills").topics.some((t) => t.id === "prompt-tools"));
});

test("a learner's own selection replaces the recommendation, and a turned-off prerequisite only warns", () => {
  const picked = recommend({ harness: "standard", selected: ["connector-tools"] });
  assert.ok(picked.selectedIds.includes("connector-tools"));
  assert.ok(picked.selectedIds.includes("create-agent"), "prerequisites are added");
  assert.ok(!picked.selectedIds.includes("topics"));

  const off = recommend({ harness: "standard", selected: ["connector-tools"], excluded: ["generative-orchestration"] });
  assert.ok(!off.selectedIds.includes("generative-orchestration"));
  assert.equal(off.dependencyWarnings[0].id, "generative-orchestration");
  assert.ok(off.dependencyWarnings[0].dependents.length >= 1);
  assert.equal(off.totals.isEstimate, true);
  assert.equal(off.totals.minutes, off.concepts.reduce((s, c) => s + c.minutes, 0));
});

test("bad answers are rejected or reported, never guessed", () => {
  assert.throws(() => recommend({ harness: "nope" }), /Unknown harness/);
  assert.throws(() => recommend({ level: 150 }), /level must be/);
  assert.throws(() => recommend({ departments: "it" }), /must be an array/);
  assert.ok(recommend({ industry: "nope", departments: ["nope"] }).warnings.length === 2);
});

test("the planner honors the harness, and never re-adds a prerequisite the learner turned off", () => {
  const plan = planLab({ features: ["connector-tools"], harness: "standard", level: 200, excluded: ["generative-orchestration"] });
  const ids = plan.features.map((f) => f.id);
  assert.ok(!ids.includes("generative-orchestration"));
  assert.ok(ids.includes("connector-tools"));
  assert.equal(plan.assumedPrereqs[0].id, "generative-orchestration");
  assert.ok(plan.warnings.some((w) => /assumes learners have already done them/.test(w)));
  assert.equal(plan.difficulty, "Intermediate");
  assert.equal(plan.request.harness, "standard");

  const mcPlan = planLab({ features: ["mc-skills"], harness: "microsoft-copilot" });
  assert.ok(mcPlan.features.every((f) => f.harness.includes("microsoft-copilot")));
  assert.ok(!mcPlan.warnings.some((w) => /mixes/.test(w)));

  assert.throws(() => planLab({ features: ["topics"], harness: "nope" }), /Unknown harness/);
  assert.throws(() => planLab({ features: ["topics"], excluded: ["nope"] }), /Unknown excluded/);
  assert.throws(() => planLab({ features: ["topics"], excluded: ["topics"] }), /excluded/);
  assert.throws(() => planLab({ features: ["topics"], level: 400 }), /level must be/);
});

test("recommendation data points only at real topics", () => {
  const recs = getRecommendations();
  const known = new Set(getFeatures().map((f) => f.id));
  const ids = [...Object.values(recs.levels).flat(), ...Object.values(recs.verticals).flatMap((v) => v.topics), ...Object.values(recs.departments).flatMap((d) => d.topics)];
  for (const id of ids) assert.ok(known.has(id), id);
});
