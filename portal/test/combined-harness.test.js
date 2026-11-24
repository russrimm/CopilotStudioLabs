/**
 * A lab that covers two harnesses one after another ("Both, one after another"): the planner's ordered, de-duplicated
 * parts, the lab text, the manifest and screenshot records other code reads through harness-parts.js, the topic list,
 * the administrator prerequisites, and the draft migration. Offline: no Microsoft Learn, no model, no network.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { getFeature, getFeatures } from "../lib/lab-builder/catalog.js";
import { getConceptForFeature } from "../lib/lab-builder/concepts.js";
import { generateLab } from "../lib/lab-builder/generator.js";
import {
  COMBINED_HARNESS_MODE,
  SHARED_LATE_PART,
  SHARED_NOTE,
  SHARED_PART,
  harnessConceptPairs,
  harnessForModule,
  labHarnesses,
  partitionIntoHarnessParts,
  singleLabHarness,
} from "../lib/lab-builder/harness-parts.js";
import { combinedModuleNames } from "../lib/lab-builder/module-names.js";
import { planLab } from "../lib/lab-builder/planner.js";
import { productOf } from "../lib/lab-builder/products.js";
import { recommend } from "../lib/lab-builder/recommend.js";
import { buildAdminPrerequisites } from "../lib/lab-builder/admin-prereqs.js";
import { DRAFT_SCHEMA_VERSION, migrateDraftRecord, normalizeDraftContent } from "../lib/lab-builder/drafts.js";

process.env.LAB_BUILDER_LINK_CHECK = "off";

const MIXED = ["create-agent", "mc-create-agent", "knowledge-sharepoint", "mc-knowledge", "dlp-governance", "alm-solutions", "mc-memory", "topics", "mc-harness-choice"];
const BOTH = { harnessMode: "both", products: ["copilot-studio"] };
const offline = { write: false, useLearnMcp: false, useLlm: false };

const idsOf = (plan) => plan.features.map((f) => f.id);
const partIds = (plan) => plan.harnessParts.parts.map((p) => p.id);

/** Every prerequisite of a module sits before it in the lab (catalog prerequisites are transitive through `prereqs`). */
function assertPrerequisitesFirst(ids) {
  const at = new Map(ids.map((id, i) => [id, i]));
  for (const id of ids) {
    for (const pre of getFeature(id).prereqs || []) {
      if (at.has(pre)) assert.ok(at.get(pre) < at.get(id), `${pre} comes before ${id}`);
    }
  }
}

test("both harnesses give one ordered list: shared first, the first harness, the second, then a shared wrap-up, each topic once", () => {
  const plan = planLab({ ...BOTH, features: MIXED });
  assert.equal(plan.harness, null, "a combined lab has no single harness");
  assert.equal(plan.harnessMode, COMBINED_HARNESS_MODE);
  assert.deepEqual(plan.harnesses, ["standard", "microsoft-copilot"]);
  assert.deepEqual(plan.differencesFor, [], "it teaches the other harness itself, so it carries no How this differs notes");
  assert.deepEqual(partIds(plan), [SHARED_PART, "standard", "microsoft-copilot", SHARED_LATE_PART]);

  const ids = idsOf(plan);
  assert.equal(new Set(ids).size, ids.length, "no module appears twice");
  const parts = Object.fromEntries(plan.harnessParts.parts.map((p) => [p.id, p.moduleIds]));
  assert.deepEqual(parts[SHARED_PART], ["mc-harness-choice", "dlp-governance"], "topics tagged for both harnesses are taught once, first");
  assert.deepEqual(parts.standard, ["create-agent", "topics", "knowledge-sharepoint", "publish-agent"], "the prerequisite publish-agent joins the Standard part");
  assert.deepEqual(parts["microsoft-copilot"], ["mc-create-agent", "mc-knowledge", "mc-memory"]);
  assert.deepEqual(parts[SHARED_LATE_PART], ["alm-solutions"], "a shared topic that builds on a Standard-only topic waits until after the harness parts");
  assert.deepEqual(ids, plan.harnessParts.parts.flatMap((p) => p.moduleIds), "the lab order is the parts in order");
  assertPrerequisitesFirst(ids);

  // Numbering runs across the whole lab, and each module says which part it sits in.
  assert.deepEqual(plan.features.map((f) => f.stepOrder), ids.map((_, i) => i + 1));
  assert.ok(plan.features.every((f) => f.harnessPart));
  assert.deepEqual(plan.request.harnesses, ["standard", "microsoft-copilot"]);
  assert.equal(plan.request.harnessMode, COMBINED_HARNESS_MODE);
});

test("the order can be swapped, and the ideas both harnesses teach are paired", () => {
  const swapped = planLab({ ...BOTH, harnesses: ["microsoft-copilot", "standard"], features: MIXED });
  assert.deepEqual(partIds(swapped), [SHARED_PART, "microsoft-copilot", "standard", SHARED_LATE_PART]);
  assert.deepEqual(swapped.harnessParts.order, ["microsoft-copilot", "standard"]);

  const plan = planLab({ ...BOTH, features: MIXED });
  const concepts = plan.harnessParts.differs.map((d) => d.concept);
  assert.deepEqual(concepts, ["create-agent", "knowledge"], "the two ideas that have their own topic in each harness");
  const create = plan.harnessParts.differs[0];
  assert.deepEqual(create.modules, { standard: ["create-agent"], "microsoft-copilot": ["mc-create-agent"] });
  assert.deepEqual(harnessConceptPairs(["create-agent", "mc-create-agent", "mc-memory", "dlp-governance"]).map((p) => p.conceptId), ["create-agent"], "a concept in one harness only, or a shared topic, is not a pair");
});

test("a request for one harness is unchanged, and a plain list of two harnesses keeps its old meaning", () => {
  const single = planLab({ features: MIXED.filter((id) => id !== "mc-memory"), harness: "standard", products: ["copilot-studio"] });
  assert.equal(single.harness, "standard");
  assert.equal(single.harnessParts, undefined);
  assert.equal(single.harnessMode, undefined);
  assert.deepEqual(single.differencesFor, ["microsoft-copilot"]);
  assert.ok(!("harnessMode" in single.request) && !("harnesses" in single.request), "a single-harness plan records nothing new");

  const same = planLab({ features: MIXED.filter((id) => id !== "mc-memory"), harness: "standard", harnessMode: "single", products: ["copilot-studio"] });
  assert.deepEqual(idsOf(same), idsOf(single));

  const list = planLab({ features: ["create-agent", "mc-create-agent"], harnesses: ["standard", "microsoft-copilot"], products: ["copilot-studio"] });
  assert.equal(list.harness, "standard", "two harnesses without the option still mean the first one, with notes for the second");
  assert.equal(list.harnessParts, undefined);
  assert.deepEqual(list.differencesFor, ["microsoft-copilot"]);
});

test("a combined request is checked: two different harnesses of one product, and only for a product that has harnesses", () => {
  assert.throws(() => planLab({ ...BOTH, harnesses: ["standard"], features: ["create-agent"] }), /exactly two harnesses/);
  assert.throws(() => planLab({ ...BOTH, harnesses: ["standard", "standard"], features: ["create-agent"] }), /exactly two harnesses|Unknown/);
  assert.throws(() => planLab({ ...BOTH, harnesses: ["standard", "nope"], features: ["create-agent"] }), /Unknown harness/);
  assert.throws(() => planLab({ harnessMode: "several", features: ["create-agent"], products: ["copilot-studio"] }), /harnessMode must be/);

  const dropped = planLab({ harnessMode: "both", products: ["ai-foundry"], features: ["fdy-orient-foundry"] });
  assert.equal(dropped.harness, null);
  assert.equal(dropped.harnessParts, undefined, "a product without harnesses has no combined layout");
  assert.ok(dropped.warnings.some((w) => /harness was ignored/i.test(w)));

  // A topic that belongs to neither harness is left out with a warning, and a request with nothing left is refused.
  const outside = planLab({ ...BOTH, features: ["create-agent", "cc-create-agent"] });
  assert.deepEqual(idsOf(outside), ["create-agent"]);
  assert.ok(outside.warnings.some((w) => /apply to neither/.test(w)));
  assert.throws(() => planLab({ ...BOTH, features: ["cc-create-agent"] }), /None of the selected topics apply/);
});

test("every Standard or Microsoft Copilot topic of the catalog lands in exactly one part, with its prerequisites first", () => {
  const pair = new Set(["standard", "microsoft-copilot"]);
  const wanted = getFeatures().filter((f) => productOf(f) === "copilot-studio" && (f.harness || ["standard"]).some((h) => pair.has(h))).map((f) => f.id);
  const plan = planLab({ ...BOTH, features: wanted });
  assert.deepEqual([...idsOf(plan)].sort(), [...wanted].sort(), "every topic, none twice, none added");
  assertPrerequisitesFirst(idsOf(plan));

  const partOf = new Map(plan.harnessParts.parts.flatMap((p) => p.moduleIds.map((id) => [id, p.id])));
  for (const id of wanted) {
    const tags = getFeature(id).harness;
    const part = partOf.get(id);
    if (tags.length === 2) assert.ok([SHARED_PART, SHARED_LATE_PART].includes(part), `${id} is shared`);
    else assert.equal(part, tags[0], `${id} sits in its own harness part`);
  }
  // The rule for a shared topic: it leads only when everything it builds on is shared too.
  const late = plan.harnessParts.parts.find((p) => p.id === SHARED_LATE_PART)?.moduleIds || [];
  for (const id of late) assert.ok((getFeature(id).prereqs || []).some((pre) => partOf.get(pre) && ![SHARED_PART].includes(partOf.get(pre))), `${id} builds on a harness-specific topic`);
  const shared = plan.harnessParts.parts.find((p) => p.id === SHARED_PART).moduleIds;
  assert.ok(shared.length >= 1 && shared.every((id) => getFeature(id).harness.length === 2));
});

test("partitioning is deterministic and keeps the order it was given inside a part", () => {
  const input = ["mc-create-agent", "create-agent", "mc-knowledge", "knowledge-sharepoint", "mc-harness-choice"];
  const a = partitionIntoHarnessParts(input, ["standard", "microsoft-copilot"]);
  const b = partitionIntoHarnessParts(input, ["standard", "microsoft-copilot"]);
  assert.deepEqual(a, b);
  assert.deepEqual(a.ids, ["mc-harness-choice", "create-agent", "knowledge-sharepoint", "mc-create-agent", "mc-knowledge"]);
  assert.deepEqual(partitionIntoHarnessParts(["cc-create-agent", "create-agent"], ["standard", "microsoft-copilot"]).dropped, ["cc-create-agent"]);
});

test("a combined lab names two same-named modules with a short tag and leaves the others plain", () => {
  const plan = planLab({ ...BOTH, features: MIXED });
  const named = combinedModuleNames(plan.features);
  const byId = Object.fromEntries(named.map((f) => [f.id, f.name]));
  assert.equal(byId["create-agent"], "Create an agent (Standard)");
  assert.equal(byId["mc-create-agent"], "Create an agent (Microsoft Copilot)");
  assert.equal(byId["mc-knowledge"], "Add knowledge", "the harness suffix comes off where the name is already distinct");
  assert.ok(!named.some((f) => /harness\)/i.test(f.name)), "no repeated (... harness) suffix");
});

test("the lab text covers each idea once: parts, a harness label on every module, and a pointer instead of a repeated explanation", async () => {
  const result = await generateLab({ ...BOTH, features: MIXED, industry: "retail" }, offline);
  assert.equal(result.status, "complete");
  const md = result.markdown;
  assert.match(md, /\| \*\*HARNESS\*\* \| Both, one after another: Standard \(Classic\) harness, then Microsoft Copilot harness \|/);
  assert.match(md, /- \*\*Part 1 - Shared foundations\*\* \(works in either harness\): Steps 1 to 2/);
  assert.match(md, /- \*\*Part 2 - Standard \(Classic\) harness\*\*: Steps 3 to 6/);
  assert.match(md, /- \*\*Part 3 - Microsoft Copilot harness\*\*: Steps 7 to 9/);
  assert.match(md, /Two practice agents, one for each harness/, "the prerequisites say a combined lab needs one agent per harness");

  const headings = [...md.matchAll(/^### (Step|Recap) \d+ - (.+)$/gm)].map((m) => m[2]);
  assert.equal(new Set(headings).size, headings.length, "no module heading repeats");
  assert.match(md, /### Step 1 - Choose a harness[^\n]*\n\n\*Level 100 · about 15 minutes · Works in either harness\*/);
  assert.match(md, /### Step 3 - Create an agent \(Standard\)\n\n\*Level 100 · about 15 minutes · Standard \(Classic\) harness\*/);

  // The Microsoft Copilot version of a paired idea points back instead of repeating the explanation.
  const mcCreate = md.slice(md.indexOf("### Step 7 - Create an agent (Microsoft Copilot)"), md.indexOf("### Step 8"));
  assert.match(mcCreate, /\*\*What is different here\.\*\* Same idea as Step 3 \(Create an agent \(Standard\)\) in the Standard \(Classic\) harness part, so it is not explained again\./);
  assert.ok(!/\*\*Why it matters\.\*\*/.test(mcCreate), "the shared explanation is not said twice");
  assert.match(mcCreate, /\*\*Sources \(checked \d{4}-\d{2}-\d{2}\)\.\*\*/, "what is different comes with its Microsoft Learn sources");
  const stdCreate = md.slice(md.indexOf("### Step 3 - Create an agent (Standard)"), md.indexOf("### Step 4"));
  assert.match(stdCreate, /\*\*Why it matters\.\*\*/, "the first version explains the idea");
  assert.ok(!/How this differs on/.test(md), "no comparison notes: both harnesses are taught");
  assert.ok(!/<details>/.test(md.slice(md.indexOf("## Step-by-Step"))) || !/How this differs/.test(md));

  // A sample input or troubleshooting item both versions of an idea would print word for word is printed once.
  assert.match(mcCreate, /\*\*Sample input\.\*\* Use the same sample input as in Step 3\./);
  assert.equal([...md.matchAll(/^\*\*Sample input\.\*\* When Copilot Studio asks you to describe the agent/gm)].length, 1, "the sample input text appears once");
  const longLines = new Map();
  for (const raw of md.split(/\r?\n/)) {
    const key = raw.toLowerCase().replace(/\s+/g, " ").trim();
    if (/^\s*[|#]/.test(raw) || key.length < 90 || /^\*\*microsoft learn reference|^- \[/.test(key) || /^- \*\*[a-d]\.\*\*/.test(key)) continue;
    longLines.set(key, (longLines.get(key) || 0) + 1);
  }
  assert.deepEqual([...longLines].filter(([, n]) => n > 1).map(([text]) => text.slice(0, 80)), [], "no paragraph repeats word for word (quiz options and source links aside)");
});

test("a single-harness lab prints its sample input and troubleshooting for every module, as it always did", async () => {
  const result = await generateLab({ features: ["create-agent", "agent-instructions"], harness: "standard", products: ["copilot-studio"], industry: "retail" }, offline);
  assert.ok(!/Use the same sample input as in Step/.test(result.markdown));
  assert.ok(!/\*\*More in Step \d+\./.test(result.markdown));
});

test("the manifest and the screenshot slots record which harness each module and picture belongs to, through one helper", async () => {
  const result = await generateLab({ ...BOTH, features: MIXED }, offline);
  const manifest = result.manifest;
  assert.equal(manifest.request.harnessMode, "both");
  assert.deepEqual(manifest.request.harnesses, ["standard", "microsoft-copilot"]);
  assert.equal(manifest.differences.labHarness, null);
  assert.deepEqual(manifest.harnessParts.parts.map((p) => p.id), [SHARED_PART, "standard", "microsoft-copilot", SHARED_LATE_PART]);
  assert.deepEqual(labHarnesses(manifest), ["standard", "microsoft-copilot"]);
  assert.equal(singleLabHarness(manifest), null);

  const byId = Object.fromEntries(manifest.modules.map((m) => [m.id, m]));
  assert.equal(byId["create-agent"].harness, "standard");
  assert.equal(byId["mc-create-agent"].harness, "microsoft-copilot");
  assert.equal(byId["mc-harness-choice"].harness, null);
  assert.equal(byId["mc-harness-choice"].harnessScope, "shared");
  assert.equal(byId["mc-harness-choice"].harnessNote, SHARED_NOTE);
  assert.deepEqual(byId["mc-harness-choice"].harnesses, ["standard", "microsoft-copilot"]);

  const own = harnessForModule(manifest, byId["mc-knowledge"]);
  assert.deepEqual({ part: own.part, scope: own.scope, harness: own.harness }, { part: "microsoft-copilot", scope: "harness", harness: "microsoft-copilot" });
  const shared = harnessForModule(manifest, byId["dlp-governance"].order);
  assert.deepEqual({ scope: shared.scope, harness: shared.harness, note: shared.note }, { scope: "shared", harness: null, note: "Works in either harness" });
  assert.equal(harnessForModule(manifest, "alm-solutions").part, SHARED_LATE_PART);

  // Every picture slot carries the harness of the section it sits in.
  const slots = result.shots.shots;
  assert.ok(slots.length > 0);
  for (const slot of slots) {
    const module = byId[slot.feature];
    assert.equal(slot.harnessPart, module.harnessPart, `${slot.slot} is in the ${module.harnessPart} part`);
    assert.equal(slot.harness, module.harness);
  }
  assert.ok(slots.some((s) => s.harness === "standard") && slots.some((s) => s.harness === "microsoft-copilot") && slots.some((s) => s.harnessScope === "shared"));

  // A single-harness lab keeps the manifest it always had: no parts, no per-module harness fields, and the helper reads the lab's harness.
  const single = await generateLab({ features: ["create-agent", "knowledge-sharepoint"], harness: "standard", products: ["copilot-studio"] }, offline);
  assert.equal(single.manifest.harnessParts, undefined);
  assert.ok(single.manifest.modules.every((m) => !("harnessPart" in m) && !("harness" in m)));
  assert.ok(single.shots.shots.every((s) => !("harnessPart" in s)));
  assert.equal(harnessForModule(single.manifest, 1).harness, "standard");
  assert.equal(harnessForModule(single.manifest, 1).scope, "harness");
});

test("the administrator prerequisites list each prerequisite once, say which harness each module is in, and cover both harnesses", async () => {
  const result = await generateLab({ ...BOTH, features: MIXED }, offline);
  const prereqs = result.adminPrerequisites;
  assert.deepEqual(prereqs.harnesses, ["standard", "microsoft-copilot"]);
  assert.equal(prereqs.harness, null);
  assert.match(prereqs.summary, /Standard \(Classic\) harness and Microsoft Copilot harness, with one practice agent in each/);
  const ids = [...prereqs.connectors, ...prereqs.dlpAndAcp, ...prereqs.environmentSettings, ...prereqs.tenantAndCloud].map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length, "one entry per prerequisite, never two");
  assert.ok(prereqs.connectors.some((c) => c.id === "office365-teams-outlook"), "the Microsoft Copilot harness checks apply when it is one of the two");
  const labels = [...prereqs.connectors, ...prereqs.dlpAndAcp, ...prereqs.environmentSettings, ...prereqs.tenantAndCloud].flatMap((item) => item.requiredBy);
  assert.ok(labels.some((label) => / · Standard \(Classic\)$/.test(label)));
  assert.ok(labels.some((label) => / · Microsoft Copilot$/.test(label)));
  assert.ok(labels.some((label) => / · Either harness$/.test(label)));
  for (const item of [...prereqs.connectors, ...prereqs.dlpAndAcp, ...prereqs.environmentSettings, ...prereqs.tenantAndCloud]) {
    assert.equal(new Set(item.requiredBy).size, item.requiredBy.length, `${item.id}: a module is listed once`);
  }

  // Built straight from a plan (the composer's route) it gives the same harness reading.
  const fromPlan = buildAdminPrerequisites({ features: result.plan.features, products: result.plan.products, harness: result.plan.harness, harnesses: result.plan.harnesses });
  assert.deepEqual(fromPlan.harnesses, ["standard", "microsoft-copilot"]);

  // A single-harness lab keeps its record exactly: one harness, no list.
  const single = await generateLab({ features: ["create-agent"], harness: "standard", products: ["copilot-studio"] }, offline);
  assert.equal(single.adminPrerequisites.harness, "standard");
  assert.ok(!("harnesses" in single.adminPrerequisites));
});

test("the topic list for both harnesses shows each harness's topics, and a single harness shows only its own", () => {
  const both = recommend({ level: 100, products: ["copilot-studio"], harnessMode: "both" });
  assert.deepEqual(both.answers.harnesses, ["standard", "microsoft-copilot"]);
  assert.equal(both.answers.harnessMode, "both");
  const create = both.concepts.find((c) => c.id === "create-agent");
  assert.deepEqual(create.topics.map((t) => t.id).sort(), ["create-agent", "mc-create-agent"].sort());
  assert.deepEqual(create.products, ["copilot-studio"], "the product is named once");

  const single = recommend({ level: 100, products: ["copilot-studio"], harness: "standard" });
  assert.equal(single.answers.harnessMode, undefined);
  assert.deepEqual(single.concepts.find((c) => c.id === "create-agent").topics.map((t) => t.id), ["create-agent"]);
  assert.throws(() => recommend({ level: 100, harnessMode: "both", harnesses: ["standard"] }), /exactly two different harnesses/);
  assert.throws(() => recommend({ level: 100, harnessMode: "both", harnesses: ["standard", "nope"] }), /Unknown harness/);
});

test("the concept of each topic is what pairs the two harnesses", () => {
  assert.equal(getConceptForFeature("create-agent").id, getConceptForFeature("mc-create-agent").id);
  assert.notEqual(getConceptForFeature("create-agent").id, getConceptForFeature("mc-memory").id);
});

test("a draft saved before the option (version 2) opens as a single-harness draft, and the new choice is checked", () => {
  const v2 = {
    schemaVersion: 2,
    id: "unsaved",
    content: { selections: { products: ["copilot-studio"], harness: "microsoft-copilot", features: ["mc-create-agent"] }, wizard: { step: 2 } },
  };
  const migrated = migrateDraftRecord(v2);
  assert.equal(migrated.schemaVersion, DRAFT_SCHEMA_VERSION);
  assert.equal(migrated.content.selections.harnessMode, "single");
  assert.deepEqual(migrated.content.selections.harnesses, ["standard", "microsoft-copilot"]);
  assert.equal(migrated.content.selections.harness, "microsoft-copilot", "every other choice is untouched");
  assert.equal(v2.schemaVersion, 2, "reading never changes the file it read");

  const kept = normalizeDraftContent({ selections: { products: ["copilot-studio"], harnessMode: "both", harnesses: ["microsoft-copilot", "standard"] }, wizard: {} });
  assert.equal(kept.selections.harnessMode, "both");
  assert.deepEqual(kept.selections.harnesses, ["microsoft-copilot", "standard"], "the order round-trips");
  const plain = normalizeDraftContent({ selections: { products: ["copilot-studio"] }, wizard: {} });
  assert.equal(plain.selections.harnessMode, "single");
  assert.throws(() => normalizeDraftContent({ selections: { products: ["copilot-studio"], harnessMode: "all" }, wizard: {} }), /harness choice/);
  assert.throws(() => normalizeDraftContent({ selections: { products: ["copilot-studio"], harnesses: ["standard"] }, wizard: {} }), /pair/);
});
