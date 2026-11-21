import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

import { getProducts } from "../lib/lab-builder/products.js";
import { getCoreFeatures, expandPrereqs } from "../lib/lab-builder/catalog.js";
import { recommend } from "../lib/lab-builder/recommend.js";
import { planLab } from "../lib/lab-builder/planner.js";
import { generateLab } from "../lib/lab-builder/generator.js";
import { getIndustries, getRoles } from "../lib/scenarios.js";

const LEVELS = [100, 200, 300];
const answersFor = (product, level, extra = {}) => ({
  products: [product.id],
  level,
  ...(product.hasHarnesses ? { harness: "standard" } : {}),
  ...extra,
});

test("with no selections made, nothing is selected, required, or counted for any product at any level", () => {
  for (const product of getProducts()) {
    for (const level of LEVELS) {
      const rec = recommend(answersFor(product, level));
      const label = `${product.id} level ${level}`;
      assert.deepEqual(rec.selectedIds, [], `${label} pre-selects topics`);
      assert.deepEqual(rec.preselectedIds, [], label);
      assert.equal(rec.totals.selectedCount, 0, label);
      assert.equal(rec.totals.prerequisiteCount, 0, `${label} adds prerequisites nobody asked for`);
      assert.equal(rec.totals.minutes, 0, label);
      assert.deepEqual(rec.prerequisites.selectedIds, [], label);
      assert.ok(rec.concepts.flatMap((c) => c.topics).every((t) => !t.selected && !t.required), `${label} has a checked topic`);
      assert.ok(rec.recommendedIds.length > 0 || rec.concepts.every((c) => !c.topics.length), `${label} still says what it recommends`);
    }
  }
});

test("a lab cannot be planned or built from no topics", async () => {
  for (const product of getProducts()) {
    assert.throws(() => planLab({ products: [product.id], level: 100 }), /Select at least one topic/);
    assert.throws(() => planLab({ products: [product.id], level: 100, features: [] }), /Select at least one topic/);
    await assert.rejects(generateLab({ products: [product.id], features: [] }, { write: false, useLearnMcp: false, useLlm: false }), /Select at least one topic/);
  }
});

test("a vertical or a department pre-selects only what it points at, with a reason, and Select recommended is a separate act", () => {
  const rec = recommend({ industry: "healthcare", departments: ["it"], level: 200, harness: "standard" });
  const topics = rec.concepts.flatMap((c) => c.topics);
  const selected = topics.filter((t) => t.selected);
  assert.ok(selected.length > 0);
  for (const topic of selected) assert.ok(topic.reasons.some((r) => /Recommended for (Healthcare|IT)|Required by/.test(r)), `${topic.id} is selected without an answer behind it`);
  for (const id of rec.preselectedIds) assert.ok(topics.find((t) => t.id === id).reasons.some((r) => /Recommended for (Healthcare|IT)/.test(r)), id);
  const baseline = topics.filter((t) => t.recommended && !t.selected);
  assert.ok(baseline.length > 0, "level baseline topics are recommended but left unselected");
  assert.ok(rec.recommendedIds.length > rec.selectedIds.length);

  const chosen = recommend({ industry: "healthcare", departments: ["it"], level: 200, harness: "standard", selected: rec.recommendedIds });
  assert.equal(new Set(chosen.selectedIds).size, rec.recommendedIds.length, "selecting the recommendation selects exactly it");
  assert.deepEqual(chosen.preselectedIds, [], "an explicit selection is the learner's own");
});

test("a plan holds the chosen topics and the prerequisites they need, with no core foundation seed", () => {
  for (const product of getProducts()) {
    const rec = recommend(answersFor(product, 100));
    const first = rec.recommendedIds[0];
    const plan = planLab({ ...answersFor(product, 100), features: [first] });
    assert.deepEqual(plan.features.map((f) => f.id), [first], `${product.id} added modules to a one-topic lab`);
    assert.deepEqual(plan.warnings, []);
  }
});

test("core foundation modules are added only when asked for, and the lab says so", () => {
  const core = new Set(getCoreFeatures().map((f) => f.id));
  const needed = new Set(expandPrereqs(["publish-agent"]));
  const plain = planLab({ products: ["copilot-studio"], level: 100, harness: "standard", features: ["publish-agent"] });
  assert.deepEqual(new Set(plain.features.map((f) => f.id)), needed, "only the topic and the prerequisites it needs");
  const asked = planLab({ products: ["copilot-studio"], level: 100, harness: "standard", features: ["publish-agent"], includeCore: true });
  assert.ok(asked.features.some((f) => core.has(f.id) && !needed.has(f.id)));
  assert.ok(asked.features.length > plain.features.length);
  assert.ok(asked.warnings.some((w) => /Added \d+ core foundation module\(s\) because you asked/.test(w)));
});

// ── Client: hand-written lab chapters are not included until the user includes them ──

test("no hand-written lab is included until the user includes it, and a refresh keeps only the user's own choices", async () => {
  const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const start = source.indexOf("async function refreshLabs()");
  const end = source.indexOf("function renderLabs()");
  assert.ok(start > 0 && end > start, "refreshLabs is where the test expects it");
  let response = [
    { id: "a", available: true },
    { id: "b", available: true },
    { id: "c", available: false },
  ];
  const context = {
    labs: [],
    includedLabs: new Set(),
    validationResults: new Map(),
    fetch: async () => ({ json: async () => ({ labs: response }) }),
    renderLabs() {},
    renderResourceManifest() {},
    updateStatus() {},
    toast() {},
  };
  vm.createContext(context);
  vm.runInContext(`${source.slice(start, end)}; globalThis.refreshLabs = refreshLabs;`, context);

  await context.refreshLabs();
  assert.deepEqual([...context.includedLabs], [], "a fresh portal includes no lab");

  context.includedLabs.add("a");
  context.includedLabs.add("gone");
  await context.refreshLabs();
  assert.deepEqual([...context.includedLabs], ["a"], "the user's choice survives a refresh; a vanished lab does not");

  response = [{ id: "a", available: false }, { id: "b", available: true }];
  await context.refreshLabs();
  assert.deepEqual([...context.includedLabs], [], "a lab that became unavailable is no longer included");
});

// ── Client: the wizard starts empty and only the learner's act selects topics ──

function loadWizard() {
  const source = readFileSync(new URL("../public/lab-builder-wizard.js", import.meta.url), "utf8");
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) {
      elements.set(id, { id, innerHTML: "", textContent: "", value: "", checked: true, hidden: false, style: {}, contains: () => false, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, setAttribute() {}, removeAttribute() {}, focus() {}, scrollIntoView() {}, classList: { toggle() {}, add() {}, remove() {} } });
    }
    return elements.get(id);
  };
  const context = {
    document: { getElementById: element, querySelector: () => null, querySelectorAll: () => [], activeElement: { dataset: {} } },
    CSS: { escape: (s) => s },
    escapeHtml: (s) => String(s),
    toast: () => {},
    fetch: async (_url, init) => ({ ok: true, json: async () => recommend(JSON.parse(init.body)) }),
    setTimeout,
    console,
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  vm.runInContext("labBuilder.selectedProducts = new Set([LB_DEFAULT_PRODUCT]);", context);
  return { run: (code) => vm.runInContext(code, context), element };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("the wizard builds nothing before Topics, then arrives with the suggestion; Back to suggested restores it, Clear empties it, and there is no Reset", async () => {
  const { run, element } = loadWizard();
  run("lbRefresh()");
  await settle();
  assert.deepEqual(JSON.parse(run("JSON.stringify(lbRequest().features)")), [], "a wizard that has not reached Topics sends no topics");
  assert.equal(run("lbSelectedCount()"), 0);

  // Arriving on Topics selects the suggestion, so the person starts from something and unchecks what they do not need.
  run("lbGoToStep(LB_STEP.topics)");
  await settle();
  const recommended = JSON.parse(run("JSON.stringify(labBuilder.rec.recommendedIds)"));
  assert.ok(recommended.length > 0);
  assert.equal(run("labBuilder.pickedAuto"), true);
  assert.deepEqual(JSON.parse(run("JSON.stringify(labBuilder.rec.selectedIds)")).sort(), [...recommended].sort());
  assert.deepEqual(JSON.parse(run("JSON.stringify(lbRequest().features)")).sort(), [...recommended].sort(), "and the lab builds exactly what the list shows");
  assert.equal(element("lb-topic-intro").textContent, "Suggested for Level 100: the usual starting topics. Uncheck anything you do not need.");
  assert.match(element("lb-topic-summary").textContent, /^Suggested lab: \d+ topics?, about /);
  assert.match(element("lb-topic-groups").innerHTML, /<span class="lb-badge lb-badge-recommended">Suggested<\/span>/);
  assert.match(element("lb-topic-groups").innerHTML, /\schecked\s/);

  // Clear is a choice: nothing is selected, and the suggested topics say they are suggested but not selected.
  run("lbClearTopics()");
  await settle();
  assert.equal(run("lbSelectedCount()"), 0);
  assert.deepEqual(JSON.parse(run("JSON.stringify(lbRequest().features)")), []);
  assert.equal(element("lb-topic-summary").textContent, "No topics selected yet. Choose Change to pick some.");
  assert.match(element("lb-topic-groups").innerHTML, /Suggested, not selected/);
  assert.doesNotMatch(element("lb-topic-groups").innerHTML, /\schecked\s/);

  run("lbSelectRecommended()");
  await settle();
  assert.equal(run("labBuilder.pickedAuto"), true);
  assert.deepEqual(JSON.parse(run("JSON.stringify(labBuilder.rec.selectedIds)")).sort(), [...recommended].sort(), "Back to suggested selects exactly the suggestion");

  assert.equal(run("typeof lbResetTopics"), "undefined", "Back to suggested replaces both Select recommended and Reset to my answers");
});

test("choosing an industry and a department adds their topics to the suggestion, with the reason in the row details and the intro naming them", async () => {
  const { run, element } = loadWizard();
  const roles = getRoles();
  const department = roles.find((r) => r.id === "it");
  run(`labBuilder.industries = ${JSON.stringify(getIndustries())}; labBuilder.roles = ${JSON.stringify(roles)};`);
  run('labBuilder.industry = "healthcare"; labBuilder.selectedRoles = new Set(["it"]); labBuilder.level = 300; labBuilder.step = LB_STEP.topics; lbRefresh()');
  await settle();

  // What the answers add on top of the level baseline, as the server computes it.
  const added = recommend({ harness: "standard", industry: "healthcare", departments: ["it"], level: 300 }).preselectedIds;
  assert.ok(added.length > 0, "healthcare and IT point at topics at Level 300");
  assert.equal(run("labBuilder.pickedAuto"), true);
  const selected = new Set(JSON.parse(run("JSON.stringify(labBuilder.rec.selectedIds)")));
  for (const id of added) assert.ok(selected.has(id), `${id} is in the suggestion`);

  // The intro says once what the suggestion follows; no row repeats the generic level reason.
  assert.equal(element("lb-topic-intro").textContent, `Suggested for Level 300, with topics that follow Healthcare and ${department.name}. Uncheck anything you do not need.`);
  const html = element("lb-topic-groups").innerHTML;
  assert.doesNotMatch(html, /Recommended for level \d+/);
  const row = html.split('<div class="lb-feature lb-row').find((chunk) => chunk.includes(`data-topic="${added[0]}"`));
  assert.ok(row, "the topic the industry adds is listed");
  const visible = row.slice(0, row.indexOf("</label>"));
  const details = row.slice(row.indexOf('<div class="lb-row-details"'));
  assert.doesNotMatch(visible, /Why:|Recommended for/, "the reason is not in the visible row");
  assert.match(details, /<span class="lb-topic-reason">Why: [^<]*Recommended for (Healthcare|IT)/, "it is in the row's details");
});
