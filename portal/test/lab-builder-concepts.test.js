import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { getFeatures, getHarnesses, validateCatalog } from "../lib/lab-builder/catalog.js";
import { getConcepts, getConceptForFeature, getKnownCoverageGaps, getRecommendations, validateConcepts } from "../lib/lab-builder/concepts.js";
import { buildCoverageMatrix, renderCoverageMarkdown, validateCoverage } from "../lib/lab-builder/coverage.js";
import { recommend } from "../lib/lab-builder/recommend.js";
import { planLab } from "../lib/lab-builder/planner.js";
import { generateLab } from "../lib/lab-builder/generator.js";
import { buildAdminPrerequisites } from "../lib/lab-builder/admin-prereqs.js";
import { getProducts } from "../lib/lab-builder/products.js";
import { getIndustries, getRoles } from "../lib/scenarios.js";
import { isThirdPartyConnectorTopic, topicToFeature } from "../lib/lab-builder/topic-feature.js";

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
  const withThirdParty = [...FEATURES, { id: "tp", harness: ["standard"], level: 200, thirdPartyConnector: true }];
  assert.match(
    validateConcepts({
      concepts: [concept({ features: ["a", "b", "tp"] })],
      recommendations: { levels: { 200: ["tp"] }, verticals: {}, departments: {} },
      features: withThirdParty,
      harnesses: HARNESSES,
    }).join("\n"),
    /third-party connector and must remain optional/,
  );
  assert.match(
    validateConcepts({
      concepts: [concept({ features: ["a", "b", "tp"] })],
      recommendations: { levels: {}, verticals: { retail: { why: "Retail", topics: ["tp"] } }, departments: {} },
      features: withThirdParty,
      harnesses: HARNESSES,
    }).join("\n"),
    /third-party connector and must remain optional/,
  );
  assert.match(
    validateConcepts({
      concepts: [concept({ features: ["a", "b", "tp"] })],
      recommendations: { levels: {}, verticals: { retail: { why: "Retail", topics: ["a"], optionalThirdParty: ["a"] } }, departments: {} },
      features: withThirdParty,
      harnesses: HARNESSES,
    }).join("\n"),
    /must have thirdPartyConnector: true/,
  );
  assert.deepEqual(check([concept({ features: ["a", "b"] })]), []);
});

test("a concept with no variant and no not-applicable reason fails coverage", () => {
  const concept = (over) => ({ id: "c", name: "C", summary: "S", order: 1, features: ["a"], notApplicable: {}, ...over });
  const check = (concepts, knownGaps = []) =>
    validateCoverage({ concepts, features: FEATURES, harnesses: HARNESSES, knownGaps });

  assert.match(check([concept()]).join("\n"), /coverage c: no feature and no notApplicable reason for harness "microsoft-copilot"/);
  assert.deepEqual(check([concept({ notApplicable: { "microsoft-copilot": "Not offered." } })]), []);
  assert.deepEqual(check([concept()], ["c:microsoft-copilot"]), []);
  assert.match(check([concept({ features: ["a", "b"] })], ["c:microsoft-copilot"]).join("\n"), /now covered; remove it/);
  assert.equal(buildCoverageMatrix({ concepts: [concept()], features: FEATURES, harnesses: HARNESSES }).rows[0].cells.standard.status, "variant");
});

test("the shipped coverage matrix lists every concept and only shrinks its known gaps", () => {
  const matrix = buildCoverageMatrix({ concepts: getConcepts(), features: getFeatures(), harnesses: getHarnesses() });
  assert.equal(matrix.rows.length, getConcepts().length);
  assert.deepEqual([...matrix.missing].sort(), [...getKnownCoverageGaps()].sort());
});
test("docs/lab-builder.md carries the current coverage matrix", () => {
  const doc = readFileSync(new URL("../../docs/lab-builder.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const block = doc.match(/<!-- coverage-matrix:start -->\n([\s\S]*?)\n<!-- coverage-matrix:end -->/)?.[1];
  const matrix = buildCoverageMatrix({ concepts: getConcepts(), features: getFeatures(), harnesses: getHarnesses() });
  assert.equal(block, renderCoverageMarkdown(matrix, getHarnesses()), "regenerate the matrix in docs/lab-builder.md");
});
test("recommendations cite a reason for every pre-selected topic and keep 3rd-party connectors unchecked by default", () => {
  const result = recommend({ industry: "healthcare", departments: ["it"], level: 200, harness: "standard" });
  const allTopics = result.concepts.flatMap((c) => c.topics);
  const selected = allTopics.filter((t) => t.selected);
  assert.ok(selected.length > 5);
  for (const topic of selected) {
    assert.ok(topic.reasons.length, `${topic.id} has no reason`);
    assert.equal(topic.thirdPartyConnector, false, `${topic.id} must be a 1st-party capability when auto-selected`);
  }
  assert.ok(selected.some((t) => t.id === "connector-tools" && /IT/.test(t.reasons.join(" "))));
  assert.ok(selected.some((t) => t.id === "knowledge-dataverse" && /Healthcare/.test(t.reasons.join(" "))));
  const servicenow = allTopics.find((t) => t.id === "servicenow-integration");
  assert.equal(servicenow.thirdPartyConnector, true);
  assert.equal(servicenow.selected, false);
  assert.equal(servicenow.recommended, false);
  assert.deepEqual(servicenow.optionalFor, ["IT"]);
  // Healthcare's Epic on FHIR topic is level 300, so a level 200 lab does not list it at all.
  assert.equal(allTopics.some((t) => t.id === "epic-fhir-integration"), false);
  const healthcare300 = recommend({ industry: "healthcare", level: 300 });
  assert.equal(healthcare300.selectedIds.includes("epic-fhir-integration"), false);
  assert.equal(healthcare300.recommendedIds.includes("epic-fhir-integration"), false);
  const epic = healthcare300.concepts.flatMap((c) => c.topics).find((t) => t.id === "epic-fhir-integration");
  assert.equal(epic.thirdPartyConnector, true);
  assert.equal(epic.selected, false);
  assert.deepEqual(epic.optionalFor, ["Healthcare"]);
});

test("prerequisites from lower levels are listed apart from the level's own topics, with the topic that needs them", () => {
  const result = recommend({ level: 200, harness: "standard", selected: ["generative-orchestration"] });
  const flat = result.concepts.flatMap((c) => c.topics);
  const orchestration = flat.find((t) => t.id === "generative-orchestration");
  assert.ok(orchestration.selected);
  assert.equal(flat.some((t) => t.id === "agent-instructions"), false, "a Level 100 topic is not mixed into the Level 200 list");
  const instructions = result.prerequisites.topics.find((t) => t.id === "agent-instructions");
  assert.ok(instructions.selected);
  assert.equal(instructions.level, 100);
  assert.ok(instructions.neededBy.length >= 1);
  assert.match(instructions.reason, /Needed by/);
  assert.ok(instructions.minutes <= instructions.fullMinutes);
  assert.ok(!result.selectedIds.includes("agent-instructions"), "selectedIds holds only the level's own topics");
  assert.ok(result.prerequisites.selectedIds.includes("agent-instructions"));
});

test("every topic at the chosen level that applies to the harness stays selectable, and nothing else is listed", () => {
  for (const harness of getHarnesses().map((h) => h.id)) {
    for (const level of [100, 200, 300]) {
      const result = recommend({ harness, level });
      const listed = result.concepts.flatMap((c) => c.topics);
      const ids = new Set(listed.map((t) => t.id));
      for (const f of getFeatures().filter((f) => f.harness?.includes(harness) && f.level === level)) {
        assert.ok(ids.has(f.id), `${f.id} missing for ${harness} at level ${level}`);
      }
      assert.ok(listed.every((t) => t.level === level), `${harness} level ${level} lists another level`);
      assert.equal(result.filter.shown, listed.length);
    }
    for (const concept of recommend({ harness }).concepts) {
      if (!concept.topics.length) assert.ok(concept.notApplicable, `${concept.id} has no topics and no reason on ${harness}`);
    }
  }
  const mc = recommend({ harness: "microsoft-copilot" });
  assert.match(mc.concepts.find((c) => c.id === "conversation-design").notApplicable, /instructions/i);
  assert.ok(recommend({ harness: "microsoft-copilot", level: 200 }).concepts.find((c) => c.id === "skills").topics.some((t) => t.id === "mc-skills"));
  assert.ok(recommend({ harness: "standard", level: 200 }).concepts.find((c) => c.id === "skills").topics.some((t) => t.id === "prompt-tools"));
});

test("a learner's own selection replaces the recommendation, and a turned-off prerequisite only warns", () => {
  const picked = recommend({ harness: "standard", level: 200, selected: ["connector-tools"] });
  assert.ok(picked.selectedIds.includes("connector-tools"));
  assert.ok(picked.prerequisites.selectedIds.includes("create-agent"), "prerequisites are added");
  assert.ok(!picked.selectedIds.includes("topics"));

  const off = recommend({ harness: "standard", level: 200, selected: ["connector-tools"], excluded: ["generative-orchestration"] });
  assert.ok(!off.selectedIds.includes("generative-orchestration"));
  assert.equal(off.dependencyWarnings[0].id, "generative-orchestration");
  assert.ok(off.dependencyWarnings[0].dependents.length >= 1);
  assert.equal(off.totals.isEstimate, true);
  assert.equal(off.totals.minutes, off.concepts.reduce((s, c) => s + c.minutes, 0) + off.prerequisites.minutes);
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

test("recommendation data points only at real 1st-party topics and valid optional 3rd-party connectors", () => {
  const recs = getRecommendations();
  const byId = new Map(getFeatures().map((f) => [f.id, f]));
  const ids = [
    ...Object.values(recs.levels).flat(),
    ...Object.values(recs.verticals).flatMap((v) => v.topics),
    ...Object.values(recs.departments).flatMap((d) => d.topics),
  ];
  for (const id of ids) {
    assert.ok(byId.has(id), id);
    assert.equal(Boolean(byId.get(id).thirdPartyConnector), false, `${id} is a 3rd-party connector and must not be in default recommendations`);
  }
  const optionalIds = [
    ...Object.values(recs.verticals).flatMap((v) => v.optionalThirdParty || []),
    ...Object.values(recs.departments).flatMap((d) => d.optionalThirdParty || []),
  ];
  for (const id of optionalIds) {
    assert.ok(byId.has(id), id);
    assert.equal(byId.get(id).thirdPartyConnector, true, `${id} in optionalThirdParty must have thirdPartyConnector: true`);
  }
});

const THIRD_PARTY_FEATURE_IDS = [
  "servicenow-integration",
  "snowflake-integration",
  "sap-integration",
  "salesforce-integration",
  "jira-integration",
  "epic-fhir-integration",
  "shopify-integration",
];
const THIRD_PARTY_PREREQ_CONNECTOR_IDS = new Set([
  "servicenow",
  "snowflake",
  "sap-erp-odata",
  "salesforce",
  "jira",
  "epic-fhir",
  "shopify",
]);

test("every vertical, department, product, harness, and level defaults strictly to 1st-party connectors", () => {
  const thirdPartySet = new Set(getFeatures().filter((f) => f.thirdPartyConnector).map((f) => f.id));
  assert.deepEqual([...thirdPartySet].sort(), [...THIRD_PARTY_FEATURE_IDS].sort());

  const industries = [undefined, ...getIndustries().map((i) => i.id)];
  const roles = getRoles().map((r) => r.id);
  const departmentCases = [[], ...roles.map((r) => [r]), roles];

  for (const product of getProducts()) {
    const harnesses = product.hasHarnesses ? getHarnesses().filter((h) => h.product === product.id).map((h) => h.id) : [undefined];
    for (const harness of harnesses) {
      for (const level of [100, 200, 300]) {
        for (const industry of industries) {
          for (const departments of departmentCases) {
            const answers = {
              products: [product.id],
              level,
              ...(harness ? { harness } : {}),
              ...(industry ? { industry } : {}),
              departments,
            };
            const rec = recommend(answers);
            const label = `${product.id}/${harness || "no-harness"}/L${level}/${industry || "cross"}/${departments.join("+") || "none"}`;
            for (const id of [...rec.selectedIds, ...rec.preselectedIds, ...rec.recommendedIds, ...rec.prerequisites.selectedIds]) {
              assert.equal(thirdPartySet.has(id), false, `${label} auto-included 3rd-party connector ${id}`);
            }
            const withRec = recommend({ ...answers, selected: rec.recommendedIds });
            for (const id of [...withRec.selectedIds, ...withRec.prerequisites.selectedIds]) {
              assert.equal(thirdPartySet.has(id), false, `${label} Select recommended included 3rd-party connector ${id}`);
            }
          }
        }
      }
    }
  }

  // Verify buildAdminPrerequisites(plan) across every industry + all departments at Levels 100, 200, and 300 has 1P connectors only and zero 3rd-party connectors.
  for (const level of [100, 200, 300]) {
    for (const industry of getIndustries().map((i) => i.id)) {
      const rec = recommend({ industry, departments: roles, level, harness: "standard" });
      const features = rec.selectedIds.length ? rec.selectedIds : rec.recommendedIds;
      const plan = planLab({ industry, roles, level, harness: "standard", features });
      const prereqs = buildAdminPrerequisites(plan);
      assert.ok(prereqs.connectors.length > 0, `Level ${level} ${industry} should derive 1st-party connectors`);
      for (const c of prereqs.connectors) {
        assert.equal(
          THIRD_PARTY_PREREQ_CONNECTOR_IDS.has(c.id),
          false,
          `Level ${level} ${industry} default admin prerequisites unexpectedly included 3rd-party connector ${c.id}`,
        );
      }
    }
  }
});

test("3rd-party connector modules remain selectable as optional topics and appear in plans, labs, and Admin Prerequisites only when explicitly chosen", async () => {
  const retailDefault = recommend({
    industry: "retail",
    departments: ["sales", "finance", "operations", "customer-service", "it"],
    level: 200,
    harness: "standard",
  });
  const listed200 = retailDefault.concepts.flatMap((c) => c.topics);
  for (const id of ["servicenow-integration", "snowflake-integration", "sap-integration", "salesforce-integration", "jira-integration"]) {
    const row = listed200.find((t) => t.id === id);
    assert.ok(row, `${id} stays listed and selectable at Level 200`);
    assert.equal(row.thirdPartyConnector, true);
    assert.equal(row.selected, false);
    assert.equal(row.recommended, false);
  }
  const listed300 = recommend({ industry: "retail", departments: ["it"], level: 300, harness: "standard" }).concepts.flatMap((c) => c.topics);
  for (const id of ["epic-fhir-integration", "shopify-integration"]) {
    const row = listed300.find((t) => t.id === id);
    assert.ok(row, `${id} stays listed and selectable at Level 300`);
    assert.equal(row.thirdPartyConnector, true);
    assert.equal(row.selected, false);
    assert.equal(row.recommended, false);
  }

  const defaultLab = await generateLab(
    {
      industry: "retail",
      roles: ["sales", "finance", "operations"],
      level: 200,
      harness: "standard",
      features: retailDefault.selectedIds,
      includeCore: false,
    },
    { write: false, useLearnMcp: false, useLlm: false },
  );
  assert.doesNotMatch(defaultLab.markdown, /SAP ERP and OData integration|Salesforce CRM integration/);
  const defaultPrereqs = buildAdminPrerequisites(defaultLab.plan);
  assert.ok(defaultPrereqs.connectors.length > 0);
  assert.equal(defaultPrereqs.connectors.some((c) => c.id === "sap-erp-odata" || c.id === "salesforce"), false);
  assert.equal(defaultLab.adminPrerequisites.connectors.some((c) => c.id === "sap-erp-odata" || c.id === "salesforce"), false);

  // Explicit opt-in on Step 6 includes SAP and Salesforce in the plan, generated lab, and Admin Prerequisites.
  const optedIn = recommend({
    industry: "retail",
    departments: ["sales", "finance"],
    level: 200,
    harness: "standard",
    selected: [...retailDefault.selectedIds, "sap-integration", "salesforce-integration"],
  });
  assert.ok(optedIn.selectedIds.includes("sap-integration"));
  assert.ok(optedIn.selectedIds.includes("salesforce-integration"));

  const optedInLab = await generateLab(
    {
      industry: "retail",
      roles: ["sales", "finance"],
      level: 200,
      harness: "standard",
      features: optedIn.selectedIds,
      includeCore: false,
    },
    { write: false, useLearnMcp: false, useLlm: false },
  );
  assert.match(optedInLab.markdown, /SAP ERP and OData integration/);
  assert.match(optedInLab.markdown, /Salesforce CRM integration/);
  const optedInPrereqs = buildAdminPrerequisites(optedInLab.plan);
  assert.equal(optedInPrereqs.connectors.some((c) => c.id === "sap-erp-odata"), true);
  assert.equal(optedInPrereqs.connectors.some((c) => c.id === "salesforce"), true);
  assert.equal(optedInLab.adminPrerequisites.connectors.some((c) => c.id === "sap-erp-odata"), true);
  assert.equal(optedInLab.adminPrerequisites.connectors.some((c) => c.id === "salesforce"), true);
});

test("Microsoft Learn topic mapping flags 3rd-party vendor connectors without false positives on 1st-party topics", () => {
  const snapshot = JSON.parse(readFileSync(new URL("../lib/lab-builder/learn-topics.snapshot.json", import.meta.url), "utf8"));
  for (const topic of snapshot.topics.filter((t) => t.status === "new")) {
    assert.equal(isThirdPartyConnectorTopic(topic), false, `1st-party snapshot topic ${topic.id} (${topic.title}) should not be flagged as 3rd-party`);
  }

  for (const sample of [
    { id: "learn-sap", title: "Connect SAP ERP data to your agent", urls: ["https://learn.microsoft.com/microsoft-copilot-studio/sap-agent"], harnesses: ["standard"], status: "new", level: 200 },
    { id: "learn-sf", title: "Add Salesforce knowledge", urls: ["https://learn.microsoft.com/connectors/salesforce/"], harnesses: ["standard"], status: "new", level: 200 },
    { id: "learn-wd", title: "Workday connector actions", urls: ["https://learn.microsoft.com/connectors/workday/"], harnesses: ["standard"], status: "new", level: 200 },
    { id: "learn-box", title: "Use the Box connector", urls: ["https://learn.microsoft.com/connectors/box/"], harnesses: ["standard"], status: "new", level: 200 },
  ]) {
    assert.equal(isThirdPartyConnectorTopic(sample), true, sample.id);
    assert.equal(topicToFeature(sample).thirdPartyConnector, true, sample.id);
    const rec = recommend({ harness: "standard", level: 200 }, { topics: [sample] });
    assert.equal(rec.selectedIds.includes(sample.id), false);
    assert.equal(rec.recommendedIds.includes(sample.id), false);
    const card = rec.concepts.flatMap((c) => c.topics).find((t) => t.id === sample.id);
    assert.equal(card.thirdPartyConnector, true);
    assert.equal(card.selected, false);
  }

  // Ensure ordinary UI wording ("search box") is never misclassified as the Box connector.
  assert.equal(
    isThirdPartyConnectorTopic({
      id: "learn-search-box",
      title: "Configure the search box in SharePoint",
      urls: ["https://learn.microsoft.com/sharepoint/search-box"],
      harnesses: ["standard"],
    }),
    false,
  );
});
