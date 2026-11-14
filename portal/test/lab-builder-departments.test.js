import { test } from "node:test";
import assert from "node:assert/strict";

import { getProducts } from "../lib/lab-builder/products.js";
import { recommend } from "../lib/lab-builder/recommend.js";
import { planLab, composeScenarioProfile, getScenarioProfile } from "../lib/lab-builder/planner.js";
import { generateLab } from "../lib/lab-builder/generator.js";
import { getIndustries, getRoles } from "../lib/scenarios.js";

const LEVELS = [100, 200, 300];
const ROLES = getRoles().map((r) => r.id);
const answersFor = (product, level, extra = {}) => ({
  products: [product.id],
  level,
  ...(product.hasHarnesses ? { harness: "standard" } : {}),
  ...extra,
});
// One level 100 topic per product, enough to plan and build a lab.
const firstTopic = (product) => recommend(answersFor(product, 100)).recommendedIds[0];
const build = (request) => generateLab(request, { write: false, useLearnMcp: false, useLlm: false });

test("every department has its own complete scenario, and no two departments share a sample question", () => {
  const seen = new Map();
  for (const id of ROLES) {
    const p = composeScenarioProfile("healthcare", [id], ROLES);
    for (const field of ["agentName", "domain", "audience", "problem", "outcome", "kpi"]) {
      assert.ok(typeof p[field] === "string" && p[field].trim(), `${id} has no ${field}`);
    }
    for (const field of ["knowledgeSources", "sampleQuestions", "entities", "terms"]) {
      assert.ok(Array.isArray(p[field]) && p[field].length >= 3, `${id} has too few ${field}`);
    }
    assert.doesNotMatch(p.problem, /\{setting\}/, `${id} leaves a placeholder`);
    for (const q of p.sampleQuestions) {
      assert.ok(!seen.has(q), `"${q}" is used by ${seen.get(q)} and ${id}`);
      seen.set(q, id);
    }
  }
  assert.equal(new Set(ROLES.map((id) => composeScenarioProfile(undefined, [id], ROLES).agentName)).size, ROLES.length, "every department has its own agent");
});

test("with no department the vertical's own scenario is used unchanged", () => {
  for (const industry of getIndustries()) {
    assert.deepEqual(composeScenarioProfile(industry.id, [], ROLES), getScenarioProfile(industry.id));
  }
  assert.deepEqual(composeScenarioProfile(undefined, [], ROLES), getScenarioProfile(undefined));
});

test("the same vertical and level with two departments yield different titles, agents, scenarios, and objectives, for every product", async () => {
  for (const product of getProducts()) {
    const features = [firstTopic(product)];
    const base = { ...answersFor(product, 100), industry: "healthcare", features };
    const finance = await build({ ...base, roles: ["finance"] });
    const hr = await build({ ...base, roles: ["hr"] });
    const label = product.id;
    assert.notEqual(finance.plan.title, hr.plan.title, `${label}: title`);
    assert.notEqual(finance.plan.profile.agentName, hr.plan.profile.agentName, `${label}: agent`);
    assert.notEqual(finance.plan.profile.problem, hr.plan.profile.problem, `${label}: problem`);
    assert.notEqual(finance.plan.slug, hr.plan.slug, `${label}: slug`);
    assert.match(finance.plan.title, /^Healthcare: .*Finance Close/, label);
    assert.match(hr.plan.title, /^Healthcare: .*Employee Help/, label);
    if (product.id === "copilot-studio") {
      assert.match(finance.plan.title, /^Healthcare: Build a Finance Close Assistant/, label);
      assert.match(hr.plan.title, /^Healthcare: Build an Employee Help Assistant/, label);
    }
    const financeDeliverable = finance.plan.profile.agentName;
    const hrDeliverable = hr.plan.profile.agentName;
    for (const [result, own, other] of [
      [finance, financeDeliverable, hrDeliverable],
      [hr, hrDeliverable, financeDeliverable],
    ]) {
      assert.ok(result.markdown.includes(own), `${label}: the lab names ${own}`);
      assert.ok(!result.markdown.includes(other), `${label}: ${other} leaked into ${own}'s lab`);
      assert.match(result.markdown, /Applied to the (Finance|HR) scenario, you carry each objective into/, `${label}: objectives tie to the department`);
    }
    assert.match(finance.markdown, /What is the status of invoice INV-2041\?/, `${label}: finance sample question`);
    assert.doesNotMatch(finance.markdown, /parental leave/i, `${label}: HR content leaked`);
    assert.match(hr.markdown, /parental leave/i, `${label}: HR sample question`);
    assert.doesNotMatch(hr.markdown, /INV-2041/, `${label}: finance content leaked`);
    assert.equal(hr.manifest.request.roles.join(), "hr");
  }
});

test("the vertical still shapes the setting while the department sets the use case", () => {
  const request = { features: ["create-agent"], level: 100, harness: "standard", roles: ["finance"] };
  const hospital = planLab({ ...request, industry: "healthcare" });
  const plant = planLab({ ...request, industry: "manufacturing" });
  assert.equal(hospital.profile.agentName, plant.profile.agentName);
  assert.match(hospital.profile.problem, /healthcare organization/);
  assert.match(plant.profile.problem, /manufacturing business/);
  assert.notEqual(hospital.title, plant.title);
  assert.match(planLab({ ...request }).profile.problem, /your organization/, "no vertical: no invented setting");
  assert.match(planLab({ ...request }).title, /^Cross-industry: Build a Finance Close Assistant/);
});

test("several departments are handled coherently: each is represented, order does not matter, and others do not leak", () => {
  const request = { features: ["create-agent"], level: 100, harness: "standard", industry: "retail" };
  const a = planLab({ ...request, roles: ["legal", "sales"] });
  const b = planLab({ ...request, roles: ["sales", "legal"] });
  assert.deepEqual(a.profile, b.profile, "the same departments give the same lab regardless of click order");
  assert.equal(a.profile.agentName, "Sales and Legal Assistant");
  assert.match(a.profile.problem, /For Sales:.*For Legal:/);
  assert.ok(a.profile.sampleQuestions.length > 3);
  const sales = composeScenarioProfile("retail", ["sales"], ROLES).sampleQuestions;
  const legal = composeScenarioProfile("retail", ["legal"], ROLES).sampleQuestions;
  assert.ok(sales.some((q) => a.profile.sampleQuestions.includes(q)) && legal.some((q) => a.profile.sampleQuestions.includes(q)), "both departments contribute questions");
  const marketing = composeScenarioProfile("retail", ["marketing"], ROLES);
  for (const q of marketing.sampleQuestions) assert.ok(!a.profile.sampleQuestions.includes(q), "an unselected department's question leaked");
  assert.doesNotMatch(JSON.stringify(a.profile), /Campaign Content Assistant|brand voice/);

  const many = planLab({ ...request, roles: ["sales", "legal", "finance", "hr"] });
  assert.equal(many.profile.agentName, "Cross-Functional Assistant");
  assert.match(many.profile.audience, /Sales, Legal, Finance, and HR teams/);
  assert.ok(many.profile.sampleQuestions.length <= 6);
});

test("an agent name or title the user typed still wins over the department's", () => {
  const plan = planLab({ features: ["create-agent"], level: 100, harness: "standard", roles: ["finance"], agentName: "Ledger Buddy", title: "My lab" });
  assert.equal(plan.profile.agentName, "Ledger Buddy");
  assert.equal(plan.title, "My lab");
});

test("each department recommends topics for every product, and departments recommend different topics", () => {
  for (const product of getProducts()) {
    const topicsFor = (role) => {
      const ids = new Set();
      for (const level of LEVELS) {
        const rec = recommend(answersFor(product, level, { departments: [role] }));
        for (const t of rec.concepts.flatMap((c) => c.topics)) if (t.reasons.some((r) => /^Recommended for (?!level)/.test(r))) ids.add(t.id);
      }
      return [...ids].sort().join(",");
    };
    const sets = ROLES.map((role) => ({ role, ids: topicsFor(role) }));
    for (const { role, ids } of sets) assert.ok(ids, `${product.id}: ${role} recommends nothing`);
    assert.ok(new Set(sets.map((s) => s.ids)).size >= 8, `${product.id}: departments recommend near-identical topics`);
  }
});
