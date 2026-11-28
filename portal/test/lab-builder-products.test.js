import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";

import { getFeatures, getHarnesses, validateCatalog } from "../lib/lab-builder/catalog.js";
import { readCatalogFile } from "../lib/lab-builder/catalog-source.js";
import { getConcepts, getKnownCoverageGaps, validateConcepts } from "../lib/lab-builder/concepts.js";
import { buildCoverageMatrix, renderCoverageMarkdown, validateCoverage } from "../lib/lab-builder/coverage.js";
import { discoverSnapshot } from "../lib/lab-builder/topic-discovery.js";
import { getBuiltInProducts, getProduct, getProducts, productOf, primaryProduct, setCustomProducts, validateProducts } from "../lib/lab-builder/products.js";
import { once } from "node:events";
import express from "express";
import { DELIVERABLE_MODES, resolveDeliverableMode } from "../lib/lab-builder/deliverable.js";
import { generateLab } from "../lib/lab-builder/generator.js";
import { getFeature } from "../lib/lab-builder/catalog.js";
import { readPicklist, registerProductRoutes, sortPicklist } from "../lib/lab-builder/product-api.js";
import { buildUserProduct, readUserProducts } from "../lib/lab-builder/user-products.js";
import { buildUserTopic, productForUrl } from "../lib/lab-builder/user-topic-build.js";
import { listHash } from "../lib/lab-builder/topic-snapshot.js";
import { resetTopicSource, setTopicSource, setUserTopicsSource } from "../lib/lab-builder/topic-store.js";
import { createRateLimiter, positiveIntFromEnv } from "../lib/rate-limit.js";
import { planLab } from "../lib/lab-builder/planner.js";
import { recommend } from "../lib/lab-builder/recommend.js";
import { buildDifferenceBlocks } from "../lib/lab-builder/differences.js";
import { selectionsFromManifest } from "../lib/lab-builder/generated-labs.js";
import { readSummary } from "./fixtures/lab-summary.js";

const NOTHING_YET = { title: "Your lab so far", empty: "Nothing yet.", products: [], choices: [] };
process.env.LAB_BUILDER_LINK_CHECK = "off";
process.env.LAB_BUILDER_VENDOR_DOCS = "off";

const NON_HARNESS = getBuiltInProducts().filter((p) => !p.hasHarnesses).map((p) => p.id);
const idsOf = (product, level) => getFeatures().filter((f) => productOf(f) === product && (!level || f.level === level)).map((f) => f.id);

// ── The product model ───────────────────────────────────────────────────────

test("the shipped catalog has the six products, each with real Learn-grounded topics at every level it lists", () => {
  // Built-in products only: a product a person added on this computer is saved in their own data and is not part of the shipped catalog.
  assert.deepEqual(
    getBuiltInProducts().map((p) => p.id),
    ["copilot-studio", "m365-copilot-agent-builder", "sharepoint-ai", "ai-foundry", "m365-copilot-hub", "power-platform-ai-hub"],
  );
  assert.deepEqual(validateCatalog(), []);
  for (const product of NON_HARNESS) {
    assert.ok(idsOf(product).length >= 3, `${product} needs at least three seeded topics`);
    for (const level of getProduct(product).levels) assert.ok(idsOf(product, level).length, `${product} has nothing at level ${level}`);
    for (const f of getFeatures().filter((f) => productOf(f) === product)) {
      assert.equal(f.harness, undefined, `${f.id} must not carry a harness tag`);
      assert.match(f.verifiedAgainst, /^https:\/\/learn\.microsoft\.com\//);
      assert.ok(f.docUrls.includes(f.verifiedAgainst), `${f.id}: verifiedAgainst is one of its docUrls`);
    }
  }
});

test("a feature with no product field is a Copilot Studio feature", () => {
  assert.equal(productOf({ id: "x" }), "copilot-studio");
  assert.ok(getFeatures().filter((f) => !f.product).every((f) => f.harness?.length));
});

test("product validation names every inconsistency", () => {
  const product = (over) => ({
    id: "demo", name: "Demo", shortName: "Demo", summary: "A demo product.", order: 1, agentNoun: "agent", levels: [100],
    learnHubUrl: "https://learn.microsoft.com/demo", learnRoots: ["https://learn.microsoft.com/demo"], hasHarnesses: false,
    labPrerequisites: ["An account."], licenseNote: "Not confirmed in Microsoft Learn.", ...over,
  });
  const feature = (over) => ({ id: "f", product: "demo", level: 100, prereqs: [], ...over });
  const check = (products, features, harnesses = []) => validateProducts({ products, features, harnesses }).join("\n");

  assert.equal(check([product()], [feature()]), "");
  assert.match(check([product()], [feature({ product: "nope" })]), /unknown product "nope"/);
  assert.match(check([product()], [feature({ harness: ["standard"] })]), /has no harnesses, so the feature must not carry a harness tag/);
  assert.match(check([product()], [feature({ level: 200 })]), /level 200 is not in demo levels/);
  assert.match(check([product({ levels: [100, 300] })], [feature()]), /lists level 300 but has no feature at that level/);
  assert.match(check([product()], []), /has no catalog features/);
  assert.match(check([product(), product({ id: "other" })], [feature(), feature({ id: "g", product: "other", prereqs: ["f"] })]), /prerequisite f belongs to another product/);
  assert.match(check([product({ learnRoots: ["http://example.com/x"] })], [feature()]), /learnRoots must list at least one https URL/);
  assert.match(check([product({ name: "Demo 🚀" })], [feature()]), /plain text without emoji/);
  assert.match(check([product({ hasHarnesses: true })], [feature()]), /hasHarnesses is true but no harness belongs to it/);
});

test("every product catalog file merges into the catalog and must match its file name", () => {
  const dir = mkdtempSync(join(tmpdir(), "catalog-source-"));
  try {
    mkdirSync(join(dir, "catalog"));
    writeFileSync(join(dir, "features.json"), JSON.stringify({ categories: [{ id: "a", name: "A" }], features: [{ id: "one" }] }));
    writeFileSync(join(dir, "catalog", "demo.json"), JSON.stringify({ product: "demo", categories: [{ id: "b", name: "B" }], features: [{ id: "two" }] }));
    const merged = readCatalogFile(join(dir, "features.json"));
    assert.deepEqual(merged.features.map((f) => [f.id, f.product]), [["one", undefined], ["two", "demo"]]);
    assert.deepEqual(merged.categories.map((c) => [c.id, c.products]), [["a", undefined], ["b", ["demo"]]]);

    writeFileSync(join(dir, "catalog", "wrong.json"), JSON.stringify({ product: "demo", features: [] }));
    assert.throws(() => readCatalogFile(join(dir, "features.json")), /must be "wrong"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Coverage per product ────────────────────────────────────────────────────

const COVERAGE_FEATURES = [
  { id: "cs", harness: ["standard"] },
  { id: "sp", product: "sharepoint-ai" },
];
const COVERAGE_HARNESSES = [{ id: "standard" }];
const concept = (over) => ({ id: "c", name: "C", summary: "S", order: 1, features: ["cs"], notApplicable: {}, ...over });

test("a concept owes a cell only to the products it lists, and a product without harnesses is judged as a whole", () => {
  const check = (concepts, knownGaps = []) => validateCoverage({ concepts, features: COVERAGE_FEATURES, harnesses: COVERAGE_HARNESSES, knownGaps });

  assert.deepEqual(check([concept()]), [], "Copilot Studio only: no cell owed to SharePoint AI");
  const both = concept({ products: ["copilot-studio", "sharepoint-ai"], features: ["cs", "sp"] });
  assert.deepEqual(check([both]), []);
  assert.match(check([concept({ products: ["copilot-studio", "sharepoint-ai"] })]).join("\n"), /no notApplicable reason for product "sharepoint-ai"/);
  assert.deepEqual(check([concept({ products: ["copilot-studio", "sharepoint-ai"], notApplicable: { "sharepoint-ai": "Learn describes no equivalent." } })]), []);
  assert.deepEqual(check([concept({ products: ["copilot-studio", "sharepoint-ai"] })], ["c:sharepoint-ai"]), []);
  assert.match(check([both], ["c:sharepoint-ai"]).join("\n"), /now covered; remove it/);

  const matrix = buildCoverageMatrix({ concepts: [both], features: COVERAGE_FEATURES, harnesses: COVERAGE_HARNESSES });
  assert.deepEqual(matrix.targets, ["standard", "sharepoint-ai"]);
  assert.equal(matrix.rows[0].cells["sharepoint-ai"].status, "variant");
});

test("concept validation checks the products a concept lists", () => {
  const products = [{ id: "copilot-studio" }, { id: "sharepoint-ai" }];
  const check = (concepts) => validateConcepts({ concepts, recommendations: { levels: {} }, features: COVERAGE_FEATURES, harnesses: COVERAGE_HARNESSES, products }).join("\n");

  assert.match(check([concept({ features: ["cs", "sp"] })]), /feature sp belongs to product sharepoint-ai, which the concept does not list/);
  assert.match(check([concept({ products: ["nope"], features: ["cs", "sp"] })]), /unknown product "nope"/);
  assert.match(check([concept({ products: ["copilot-studio", "sharepoint-ai"], features: ["cs", "sp"], notApplicable: { "sharepoint-ai": "x" } })]), /a feature for it exists/);
  assert.match(check([concept({ products: ["copilot-studio"], features: ["cs"], notApplicable: { "sharepoint-ai": "x" } }), concept({ id: "d", features: ["sp"], products: ["sharepoint-ai"] })]), /not a harness or product this concept applies to/);
});

test("the shipped coverage matrix has one table per product and only the known gaps are missing", () => {
  const matrix = buildCoverageMatrix({ concepts: getConcepts(), features: getFeatures(), harnesses: getHarnesses() });
  assert.deepEqual([...matrix.missing].sort(), [...getKnownCoverageGaps()].sort());
  const markdown = renderCoverageMarkdown(matrix, getHarnesses());
  for (const product of getBuiltInProducts()) assert.ok(markdown.includes(`**${product.name}**`), `${product.name} has a table`);
  for (const gap of getKnownCoverageGaps()) assert.ok(NON_HARNESS.includes(gap.split(":")[1]), `${gap} is a product gap`);
});

// ── Recommendations and planning across products ────────────────────────────

test("Copilot Studio stays the default, so existing answers recommend exactly what they did", () => {
  const plain = recommend({ harness: "standard", level: 200 });
  assert.deepEqual(plain.answers.products, ["copilot-studio"]);
  const explicit = recommend({ products: ["copilot-studio"], harness: "standard", level: 200 });
  assert.deepEqual(explicit.selectedIds, plain.selectedIds);
  assert.ok(plain.concepts.flatMap((c) => c.topics).every((t) => t.product === "copilot-studio"));
});

test("selecting several products lists each product's topics by concept with a product on every topic", () => {
  const result = recommend({ products: ["sharepoint-ai", "copilot-studio"], harness: "standard", level: 100 });
  const topics = result.concepts.flatMap((c) => c.topics);
  assert.deepEqual([...new Set(topics.map((t) => t.product))].sort(), ["copilot-studio", "sharepoint-ai"]);
  assert.equal(result.answers.harness, "standard");
  assert.ok(topics.every((t) => t.productName));
  assert.ok(topics.filter((t) => t.selected).every((t) => t.reasons.length), "every pre-selected topic says why");
  assert.deepEqual(result.products.map((p) => p.id), ["copilot-studio", "sharepoint-ai"]);
});

test("a lab with no product that has harnesses has no harness, and a harness sent anyway is ignored with a warning", () => {
  const result = recommend({ products: ["ai-foundry"], harness: "microsoft-copilot", level: 100 });
  assert.equal(result.answers.harness, null);
  assert.ok(result.warnings.some((w) => /harness was ignored/.test(w)));
  assert.deepEqual([...new Set(result.concepts.flatMap((c) => c.topics).map((t) => t.product))], ["ai-foundry"]);
  assert.throws(() => recommend({ products: ["nope"] }), /Unknown product id/);
  assert.throws(() => recommend({ products: [] }), /Select at least one product/);
});

test("a product with nothing at the chosen level explains what exists instead of leaving a dead end", () => {
  const all = getFeatures();
  const snapshot = [...all];
  try {
    // Take the Level 300 topics away from one product, as if they were not written yet.
    all.splice(0, all.length, ...snapshot.filter((f) => !(productOf(f) === "power-platform-ai-hub" && f.level === 300)));
    const result = recommend({ products: ["sharepoint-ai", "power-platform-ai-hub"], level: 300 });
    const thin = result.products.find((p) => p.id === "power-platform-ai-hub");
    assert.equal(thin.atLevel, 0);
    assert.match(thin.message, /no Level 300 \(Advanced\) topics yet\. It has \d+ at Level 100 \(Beginner\) and \d+ at Level 200 \(Intermediate\)\. Choose another level/);
    assert.ok(result.recommendedIds.length > 0, "the other product's topics are still listed and recommended");
    const only = recommend({ products: ["power-platform-ai-hub"], level: 300 });
    assert.equal(only.recommendedIds.length, 0);
    assert.match(only.products[0].message, /Choose another level/);
  } finally {
    all.splice(0, all.length, ...snapshot);
  }
  assert.ok(recommend({ products: ["power-platform-ai-hub"], level: 300 }).recommendedIds.length > 0);
});

test("the level filter still decides what is listed for every product", () => {
  for (const level of [100, 200, 300]) {
    const result = recommend({ products: NON_HARNESS, level });
    const listed = result.concepts.flatMap((c) => c.topics);
    assert.ok(listed.length, `level ${level} lists topics`);
    assert.ok(listed.every((t) => t.level === level), `level ${level} lists another level`);
    for (const id of NON_HARNESS.flatMap((p) => idsOf(p, level))) {
      assert.ok(listed.some((t) => t.id === id), `${id} missing at level ${level}`);
    }
  }
});

test("lower-level prerequisites from another product are kept apart, as recaps", () => {
  const result = recommend({ products: ["sharepoint-ai"], level: 200, selected: ["spai-agent-sharepoint-knowledge-sources"] });
  assert.ok(result.prerequisites.topics.some((p) => p.id === "spai-build-agent-sharepoint-content" && p.level === 100));
  assert.ok(result.concepts.flatMap((c) => c.topics).every((t) => t.level === 200));
});

test("planning a lab for products without harnesses sets no harness, no difference notes, and no Copilot Studio core modules", () => {
  const plan = planLab({ products: ["sharepoint-ai"], level: 100, features: ["spai-build-agent-sharepoint-content"], harness: "standard" });
  assert.equal(plan.harness, null);
  assert.deepEqual(plan.differencesFor, []);
  assert.deepEqual(plan.products, ["sharepoint-ai"]);
  assert.ok(plan.features.every((f) => productOf(f) === "sharepoint-ai"));
  assert.ok(plan.warnings.some((w) => /harness was ignored/.test(w)));
  assert.match(plan.title, /SharePoint/);
  assert.equal(primaryProduct(plan), "sharepoint-ai");
});

test("a request can combine products, and a topic outside the selected products is refused", () => {
  const plan = planLab({ features: ["spai-build-agent-sharepoint-content", "mc-create-agent"], level: 100, harness: "microsoft-copilot", includeCore: false });
  assert.deepEqual(plan.products, ["copilot-studio", "sharepoint-ai"], "derived from the topics when omitted");
  assert.equal(plan.harness, "microsoft-copilot");
  assert.throws(() => planLab({ products: ["copilot-studio"], features: ["spai-build-agent-sharepoint-content"] }), /not selected/);
  assert.throws(() => planLab({ products: ["nope"], features: ["mc-create-agent"] }), /Unknown product id/);
  assert.throws(() => planLab({ products: ["sharepoint-ai"], features: ["spai-build-agent-sharepoint-content"], harness: "nope" }), /Unknown harness/);
});

test("harness difference notes skip features of products that have no harnesses", () => {
  const plan = { harness: "standard", differencesFor: ["microsoft-copilot"], features: ["spai-build-agent-sharepoint-content", "dca-agent-builder-first-agent"].map((id) => getFeatures().find((f) => f.id === id)) };
  const blocks = buildDifferenceBlocks(plan, { harnesses: getHarnesses(), concepts: getConcepts() });
  assert.equal(blocks.byFeature.size, 0);
});

// ── Generated labs record their products ────────────────────────────────────

test("a generated lab for another product passes the validator and records its products", async () => {
  const { generateLab } = await import("../lib/lab-builder/generator.js");
  const root = mkdtempSync(join(tmpdir(), "product-lab-"));
  try {
    const lab = await generateLab(
      { products: ["ai-foundry"], level: 100, features: idsOf("ai-foundry", 100), includeCore: false },
      { outputRoot: root, useLearnMcp: false, useLlm: false },
    );
    assert.equal(lab.status, "complete");
    assert.equal(lab.validation.failed, 0, lab.validation.tests.filter((t) => t.status === "fail").map((t) => t.name).join(", "));
    assert.equal(lab.manifest.generator, "Dynamic Microsoft Training and Lab Generator");
    assert.equal(lab.manifest.product, "ai-foundry");
    assert.deepEqual(lab.manifest.products, ["ai-foundry"]);
    assert.ok(lab.manifest.modules.every((m) => m.product === "ai-foundry"));
    assert.equal(lab.manifest.differences.labHarness, null);
    assert.match(lab.markdown, /\| \*\*PRODUCTS\*\* \| Microsoft Foundry \|/);
    assert.doesNotMatch(lab.markdown, /Copilot Studio|harness/i, "nothing in a Foundry lab is about Copilot Studio");
    assert.deepEqual(selectionsFromManifest(lab.manifest).products, ["ai-foundry"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a lab saved before products existed is a Copilot Studio lab", () => {
  const manifest = { request: { features: ["create-agent"], level: 100, roles: [], excluded: [] }, options: {} };
  assert.deepEqual(selectionsFromManifest(manifest).products, ["copilot-studio"]);
  assert.deepEqual(selectionsFromManifest({ ...manifest, request: { ...manifest.request, products: ["sharepoint-ai", "copilot-studio"] } }).products, ["sharepoint-ai", "copilot-studio"]);
});

// ── Topic discovery is scoped to the product ────────────────────────────────

test("discovery for a product starts at its own hub and follows only links under its Learn roots", async () => {
  const product = getProduct("sharepoint-ai");
  const hub = product.learnHubUrl;
  const pages = new Map([
    [hub, `# Copilot in SharePoint\n\nCopilot in SharePoint helps people work with content in sites and libraries.\n\n- [Create an agent](${product.learnRoots[0]}/create-agent)\n- [Copilot Studio overview](https://learn.microsoft.com/microsoft-copilot-studio/fundamentals-what-is-copilot-studio)\n`],
    [`${product.learnRoots[0]}/create-agent`, "# Create an agent in SharePoint\n\nCreate an agent that answers questions from the content of a SharePoint site or library."],
  ]);
  const fetched = [];
  const session = {
    ok: true,
    call: async (name, args) => {
      if (name === "microsoft_docs_search") return { content: [{ type: "text", text: "[]" }] };
      fetched.push(args.url);
      const text = pages.get(args.url) ?? "This page was not found.";
      return { content: [{ type: "text", text }] };
    },
  };
  const catalog = { features: getFeatures(), concepts: getConcepts() };
  const snapshot = await discoverSnapshot({ session, catalog, product: "sharepoint-ai", limits: { minTopics: 1 }, now: () => Date.parse("2026-11-13T00:00:00Z") });
  assert.equal(snapshot.product, "sharepoint-ai");
  assert.ok(snapshot.topics.length >= 1);
  assert.ok(snapshot.topics.every((t) => t.product === "sharepoint-ai" && t.harnesses.length === 0));
  assert.ok(!fetched.some((url) => url.includes("/microsoft-copilot-studio/")), "no Copilot Studio page was read");
  assert.ok(snapshot.catalog.every((c) => getFeatures().find((f) => f.id === c.featureId) && productOf(getFeatures().find((f) => f.id === c.featureId)) === "sharepoint-ai"));
  await assert.rejects(() => discoverSnapshot({ session, catalog, product: "nope" }), /Unknown product/);
});

// ── The wizard's step logic ─────────────────────────────────────────────────

function loadWizard() {
  const source = readFileSync(new URL("../public/lab-builder-wizard.js", import.meta.url), "utf8");
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        innerHTML: "",
        textContent: "",
        value: "",
        checked: true,
        hidden: id === "lb-start-over",
        style: {},
        contains: () => false,
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener() {},
        setAttribute() {},
        removeAttribute() {},
        focus() {},
        scrollIntoView() {},
        classList: { toggle() {}, add() {}, remove() {} },
      });
    }
    return elements.get(id);
  };
  const recommendCalls = [];
  const toasts = [];
  const context = {
    document: { getElementById: element, querySelector: () => null, querySelectorAll: () => [], activeElement: { dataset: {} } },
    CSS: { escape: (s) => s },
    escapeHtml: (s) => String(s),
    toast: (msg, type) => toasts.push({ msg, type }),
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      recommendCalls.push(body);
      return { ok: true, json: async () => recommend(body) };
    },
    setTimeout,
    console,
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  const run = (code) => vm.runInContext(code, context);
  run(`labBuilder.products = ${JSON.stringify(getProducts().map((p) => ({ id: p.id, name: p.name, shortName: p.shortName, hasHarnesses: p.hasHarnesses })))};`);
  run(`labBuilder.levels = ${JSON.stringify([{ level: 100, label: "Beginner", description: "" }, { level: 200, label: "Intermediate", description: "" }, { level: 300, label: "Advanced", description: "" }])};`);
  return Object.assign(run, { element, recommendCalls, toasts, context });
}

test("a fresh wizard starts on Step 1 with no products selected and requires at least one product before advancing", async () => {
  const run = loadWizard();
  assert.deepEqual(JSON.parse(run("JSON.stringify(LB_STEPS.map((s) => s.label))")), ["Product", "Tailor it", "Topics", "Review and build"]);
  assert.equal(run("labBuilder.step"), 1);
  assert.deepEqual(JSON.parse(run("JSON.stringify([...labBuilder.selectedProducts])")), []);
  assert.deepEqual(JSON.parse(run("JSON.stringify(lbSelectedProductList())")), []);
  assert.equal(run("lbHasHarnessProduct()"), false);
  assert.equal(run("'harness' in lbAnswers()"), false);

  await run("lbRefresh()");
  assert.equal(run("labBuilder.rec"), null);
  assert.equal(run.recommendCalls.length, 0, "does not call /api/lab-builder/recommend when 0 products are selected");
  assert.deepEqual(readSummary(run.element("lb-summary").innerHTML), NOTHING_YET);
  assert.equal(run.element("lb-start-over").hidden, true, "Start over stays hidden when nothing has been selected yet");

  run("lbNextStep()");
  assert.equal(run("labBuilder.step"), 1);
  assert.equal(run.element("lb-product-error").textContent, "Choose at least one product to continue.");

  run("lbGoToStep(2)");
  assert.equal(run("labBuilder.step"), 1, "cannot jump past Step 1 without selecting a product");
});

test("selecting SharePoint AI alone selects only SharePoint AI and never auto-includes Copilot Studio", async () => {
  const run = loadWizard();
  run("lbToggleProduct('sharepoint-ai', true)");
  await new Promise((r) => setTimeout(r, 20));

  assert.deepEqual(JSON.parse(run("JSON.stringify([...labBuilder.selectedProducts])")), ["sharepoint-ai"]);
  assert.deepEqual(JSON.parse(run("JSON.stringify(lbRequest().products)")), ["sharepoint-ai"]);
  assert.equal(run("lbProductsLabel()"), "SharePoint AI");
  assert.equal(run("lbHasHarnessProduct()"), false);
  assert.equal(run.element("lb-start-over").hidden, false, "Start over appears as soon as a product is selected");
  assert.deepEqual(readSummary(run.element("lb-summary").innerHTML), { title: "Your lab so far", empty: "", products: ["SharePoint AI"], choices: [] });
  assert.doesNotMatch(run.element("lb-summary").innerHTML, /Copilot Studio|Cross-industry|All departments|Level 100/);

  run("lbNextStep()"); // Product -> Tailor it: the defaults are on screen, so the summary names them (no harness for this product)
  assert.equal(run("labBuilder.step"), 2);
  assert.deepEqual(readSummary(run.element("lb-summary").innerHTML), {
    title: "Your lab so far",
    empty: "",
    products: ["SharePoint AI"],
    choices: ["Industry: Cross-industry", "Departments: All departments", "Level: Level 100 (Beginner)"],
  });
  assert.doesNotMatch(run.element("lb-summary").innerHTML, /Copilot Studio|harness/i);
});

test("the harness choice on Tailor it appears only when a selected product has harnesses", async () => {
  const { getFeaturesByCategory } = await import("../lib/lab-builder/catalog.js");
  const run = loadWizard();
  run(`labBuilder.categories = ${JSON.stringify(getFeaturesByCategory())};`);
  run(`labBuilder.harnesses = ${JSON.stringify(getHarnesses())};`);
  run("labBuilder.selectedProducts = new Set(['sharepoint-ai'])");
  assert.deepEqual(JSON.parse(run("JSON.stringify(lbVisibleStepIds())")), [1, 2, 3, 4], "the step count stays four");
  assert.equal(run("lbAdjacentStep(2, 1)"), 3, "Tailor it goes straight to Topics");
  assert.equal(run("lbAdjacentStep(3, -1)"), 2, "Topics goes straight back to Tailor it");
  run("lbRenderHarnesses()");
  assert.equal(run.element("lb-harness-row").hidden, true, "no harness choice without a product that has harnesses");
  assert.equal(run.element("lb-harness-options").innerHTML, "");
  assert.equal(run("'harness' in lbAnswers()"), false);
  assert.equal(run("'harness' in lbRequest()"), false);
  assert.deepEqual(JSON.parse(run("JSON.stringify(lbRequest().products)")), ["sharepoint-ai"]);

  run("labBuilder.selectedProducts = new Set(['sharepoint-ai', 'copilot-studio'])");
  run("lbRenderHarnesses()");
  assert.deepEqual(JSON.parse(run("JSON.stringify(lbVisibleStepIds())")), [1, 2, 3, 4], "the step count does not change");
  assert.equal(run("lbAdjacentStep(2, 1)"), 3);
  assert.equal(run.element("lb-harness-row").hidden, false, "Tailor it shows the harness choice once a product has harnesses");
  assert.match(run.element("lb-harness-options").innerHTML, /<input type="radio" name="lb-harness" value="standard"[^>]*\bchecked\b[^>]*>/);
  assert.deepEqual(JSON.parse(run("JSON.stringify(lbRequest().products)")), ["copilot-studio", "sharepoint-ai"], "products keep catalog order");
  assert.equal(run("lbRequest().harness"), "standard");
});

test("unchecking all products clears selectedProducts cleanly without calling recommend with empty products", async () => {
  const run = loadWizard();
  run("lbToggleProduct('copilot-studio', true)");
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(JSON.parse(run("JSON.stringify([...labBuilder.selectedProducts])")), ["copilot-studio"]);

  const callsBeforeClear = run.recommendCalls.length;
  run("lbToggleProduct('copilot-studio', false)");
  await new Promise((r) => setTimeout(r, 20));

  assert.deepEqual(JSON.parse(run("JSON.stringify([...labBuilder.selectedProducts])")), []);
  assert.equal(run.element("lb-product-error").textContent, "");
  assert.equal(run("labBuilder.rec"), null);
  assert.equal(run.recommendCalls.length, callsBeforeClear, "no /api/lab-builder/recommend call is made with empty products");
  assert.deepEqual(readSummary(run.element("lb-summary").innerHTML), NOTHING_YET);

  run("labBuilder.selectedProducts = new Set(['sharepoint-ai', 'ai-foundry', 'copilot-studio'])");
  assert.equal(run("lbProductsLabel()"), "Copilot Studio, SharePoint AI, and Foundry");
});

test("lbStartNewLab clears carryover state back to a blank Step 1 while lbLoadSelections keeps legacy fallback", async () => {
  const run = loadWizard();
  run(`
    labBuilder.industries = [{ id: "manufacturing", name: "Manufacturing" }];
    labBuilder.roles = [{ id: "sales", name: "Sales" }];
    labBuilder.harnesses = [{ id: "standard", name: "Standard harness", product: "copilot-studio" }];
    labBuilder.selectedProducts = new Set(["copilot-studio", "sharepoint-ai"]);
    labBuilder.industry = "manufacturing";
    labBuilder.selectedRoles = new Set(["sales"]);
    labBuilder.level = 200;
    labBuilder.harness = "standard";
    labBuilder.picked = new Set(["connector-tools"]);
    labBuilder.excluded = new Set(["agent-instructions"]);
    labBuilder.step = LB_STEP.topics;
    labBuilder.furthest = LB_STEP.topics;
  `);
  await run("lbRefresh()");
  assert.deepEqual(readSummary(run.element("lb-summary").innerHTML), {
    title: "Your lab so far",
    empty: "",
    products: ["Copilot Studio", "SharePoint AI"],
    choices: ["Industry: Manufacturing", "Departments: Sales", "Level: Level 200 (Intermediate)", "Agent experience: Standard harness"],
  });
  assert.equal(run.element("lb-start-over").hidden, false);

  const callsBeforeReset = run.recommendCalls.length;
  await run("lbStartNewLab()");

  assert.equal(run("labBuilder.step"), 1);
  assert.equal(run("labBuilder.furthest"), 1);
  assert.deepEqual(JSON.parse(run("JSON.stringify([...labBuilder.selectedProducts])")), []);
  assert.equal(run("labBuilder.industry"), null);
  assert.deepEqual(JSON.parse(run("JSON.stringify([...labBuilder.selectedRoles])")), []);
  assert.equal(run("labBuilder.level"), 100);
  assert.equal(run("labBuilder.picked"), null);
  assert.equal(run("labBuilder.excluded.size"), 0);
  assert.equal(run("labBuilder.rec"), null);
  assert.equal(run.recommendCalls.length, callsBeforeReset, "resetting to 0 products does not call recommend");
  assert.deepEqual(readSummary(run.element("lb-summary").innerHTML), NOTHING_YET);
  assert.equal(run.element("lb-start-over").hidden, true);
  assert.ok(run.toasts.some((t) => t.msg === "Started a fresh lab. Choose one or more products to begin."));

  // Legacy saved labs with no products array still fall back to Copilot Studio when edited.
  await run(`lbLoadSelections({
    labId: "legacy-lab",
    title: "Legacy Lab",
    selections: { industry: "manufacturing", roles: ["sales"], level: 200, harness: "standard", features: ["connector-tools"], excluded: [] }
  })`);
  assert.deepEqual(JSON.parse(run("JSON.stringify([...labBuilder.selectedProducts])")), ["copilot-studio"]);
  assert.equal(run.element("lb-start-over").hidden, false);
});

test("Your lab so far reveals each wizard option progressively only after its step is chosen or confirmed", async () => {
  const run = loadWizard();
  run(`
    labBuilder.industries = [{ id: "healthcare", name: "Healthcare" }];
    labBuilder.roles = [{ id: "it", name: "IT" }];
    labBuilder.harnesses = [{ id: "standard", name: "Standard harness", product: "copilot-studio" }];
    lbRenderSummary();
  `);

  // Nothing chosen at all
  assert.deepEqual(readSummary(run.element("lb-summary").innerHTML), NOTHING_YET);
  assert.equal(run.element("lb-summary").hidden, true, "the list stays out of the way until a product is chosen");
  assert.doesNotMatch(run.element("lb-summary").innerHTML, /Copilot Studio|Cross-industry|All departments|Level 100|Standard harness|topic/);

  // Product step: choose Copilot Studio -> ONLY the product appears, and the Tailor defaults stay out of sight
  run("lbToggleProduct('copilot-studio', true)");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(run("labBuilder.step"), 1);
  assert.deepEqual(readSummary(run.element("lb-summary").innerHTML), { title: "Your lab so far", empty: "", products: ["Copilot Studio"], choices: [] });

  // Reach Tailor it: industry, departments, level, and harness appear together, defaults included. No topics yet.
  run("lbNextStep()");
  assert.equal(run("labBuilder.step"), 2);
  assert.deepEqual(readSummary(run.element("lb-summary").innerHTML).choices, [
    "Industry: Cross-industry",
    "Departments: All departments",
    "Level: Level 100 (Beginner)",
    "Agent experience: Standard harness",
  ]);

  // Changing a Tailor choice updates the list in place.
  run("lbSelectIndustry('healthcare')");
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(readSummary(run.element("lb-summary").innerHTML).choices, [
    "Industry: Healthcare",
    "Departments: All departments",
    "Level: Level 100 (Beginner)",
    "Agent experience: Standard harness",
  ]);
  run("lbSelectLevel(200)");
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(readSummary(run.element("lb-summary").innerHTML).choices, [
    "Industry: Healthcare",
    "Departments: All departments",
    "Level: Level 200 (Intermediate)",
    "Agent experience: Standard harness",
  ]);
  assert.doesNotMatch(run.element("lb-summary").innerHTML, /topic|Knowledge checks/i, "topics stay out until the Topics step is reached");

  // Reach Topics: the screen itself says the topic count and the time, so the list does not repeat them there.
  run("lbNextStep()");
  assert.equal(run("labBuilder.step"), 3);
  assert.deepEqual(readSummary(run.element("lb-summary").innerHTML).choices, [
    "Industry: Healthcare",
    "Departments: All departments",
    "Level: Level 200 (Intermediate)",
    "Agent experience: Standard harness",
  ]);
  assert.doesNotMatch(run.element("lb-summary").innerHTML, /topic/);

  // Back on another step, the list names the topics too, once Topics has been reached.
  await new Promise((r) => setTimeout(r, 20));
  run("lbGoToStep(2)");
  await new Promise((r) => setTimeout(r, 20));
  const back = readSummary(run.element("lb-summary").innerHTML);
  assert.deepEqual(back.choices.slice(0, 4), ["Industry: Healthcare", "Departments: All departments", "Level: Level 200 (Intermediate)", "Agent experience: Standard harness"]);
  assert.equal(back.choices.length, 5);
  assert.match(back.choices[4], /^Topics: \d+ topics?( \+ \d+ refreshers?)?, about .+ \(estimate, not a limit\)$/);

  // Confirming the Tailor step shows its answers even while the person is still on the Product step.
  const confirmed = loadWizard();
  confirmed("lbToggleProduct('sharepoint-ai', true)");
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(readSummary(confirmed.element("lb-summary").innerHTML), { title: "Your lab so far", empty: "", products: ["SharePoint AI"], choices: [] });
  confirmed("labBuilder.chosenSteps.add('tailor'); lbRenderSummary()");
  assert.equal(confirmed("labBuilder.step"), 1);
  assert.deepEqual(readSummary(confirmed.element("lb-summary").innerHTML).choices, ["Industry: Cross-industry", "Departments: All departments", "Level: Level 100 (Beginner)"]);
});

test("Your lab so far lists every selected product on its own line, in full, even a product added from Microsoft Learn whose saved short name was cut", async () => {
  const longName = "What do you need help with today? Microsoft Learn product page";
  assert.equal(longName.length, 62);
  const run = loadWizard();
  run(`labBuilder.products = labBuilder.products.concat([
    { id: "custom-long", name: ${JSON.stringify(longName)}, shortName: ${JSON.stringify(`${longName.slice(0, 29)}…`)}, hasHarnesses: false, custom: true },
    { id: "custom-old", name: "Contoso Field Service", shortName: "Contoso Field Service", hasHarnesses: false, custom: true },
  ]);`);
  run("labBuilder.selectedProducts = new Set(['copilot-studio', 'custom-long', 'sharepoint-ai', 'custom-old'])");
  run("labBuilder.chosenSteps.add('product'); lbRenderSummary()");

  const html = run.element("lb-summary").innerHTML;
  const summary = readSummary(html);
  assert.deepEqual(summary.products, ["Copilot Studio", "SharePoint AI", longName, "Contoso Field Service"], "one line per product, the added one with its whole name");
  assert.equal((html.match(/<li>/g) || []).length, 4, "each product is its own list item");
  assert.match(html, /<span class="lb-summary-label">Products<\/span>/);
  assert.doesNotMatch(html, /…|\.\.\./, "nothing is shortened");
  assert.doesNotMatch(html, / and |, and /, "the names are not run together into one sentence");
  assert.equal(run("lbProductsLabel()"), `Copilot Studio, SharePoint AI, ${longName}, and Contoso Field Service`, "a sentence uses the whole name too");
  assert.equal(run.element("lb-summary").hidden, false);
  assert.equal(run.element("lb-sticky-nav").hidden, false);

  // The same pieces appear under the same rules as before, each as its own labeled item.
  run(`
    labBuilder.industries = [{ id: "retail", name: "Retail" }];
    labBuilder.roles = [{ id: "sales", name: "Sales" }, { id: "it", name: "IT" }];
    labBuilder.harnesses = [{ id: "standard", name: "Standard harness", product: "copilot-studio" }];
    labBuilder.industry = "retail";
    labBuilder.selectedRoles = new Set(["sales", "it"]);
    labBuilder.level = 200;
    labBuilder.chosenSteps.add("tailor");
    labBuilder.chosenSteps.add("topics");
    labBuilder.step = LB_STEP.tailor;
    labBuilder.rec = { totals: { selectedCount: 1, prerequisiteCount: 2, duration: "35 min" } };
    labBuilder.includeKnowledgeCheck = true;
    lbRenderSummary();
  `);
  assert.deepEqual(readSummary(run.element("lb-summary").innerHTML).choices, [
    "Industry: Retail",
    "Departments: Sales, IT",
    "Level: Level 200 (Intermediate)",
    "Agent experience: Standard harness",
    "Topics: 1 topic + 2 refreshers, about 35 min (estimate, not a limit)",
    "Knowledge checks: Mini-quizzes on",
  ]);

  run("labBuilder.selectedProducts = new Set(['custom-long'])");
  run("lbRenderSummary()");
  assert.deepEqual(readSummary(run.element("lb-summary").innerHTML).products, [longName]);
  assert.match(run.element("lb-summary").innerHTML, /<span class="lb-summary-label">Product<\/span>/, "one product says Product, not Products");
});

test("a screen reader hears one short update when the list changes, not the whole list again", async () => {
  const run = loadWizard();
  run("lbToggleProduct('copilot-studio', true)");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(run.element("lb-summary-announce").textContent, "Your lab so far: 1 product.");
  run("lbToggleProduct('sharepoint-ai', true)");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(run.element("lb-summary-announce").textContent, "Your lab so far: 2 products.");
  run("labBuilder.chosenSteps.add('tailor'); lbRenderSummary()");
  assert.equal(run.element("lb-summary-announce").textContent, "Your lab so far: 2 products, 4 other choices.");
  const before = run.element("lb-summary").innerHTML;
  run("lbRenderSummary(); lbRenderSummary()");
  assert.equal(run.element("lb-summary").innerHTML, before, "drawing the same list again changes nothing");
  assert.equal(run.element("lb-summary-announce").textContent, "Your lab so far: 2 products, 4 other choices.");
  run("labBuilder.selectedProducts = new Set(); lbRenderSummary()");
  assert.equal(run.element("lb-summary-announce").textContent, "Your lab so far: nothing yet.", "emptying the list is said once");
  run("lbRenderSummary()");
  assert.equal(run.element("lb-summary-announce").textContent, "Your lab so far: nothing yet.");
});

// ── Wizard card footer & prominent stat chips ───────────────────────────────

test("Step 1 product cards separate total counts from per-level breakdown rows, and the Tailor it level and harness choices show their counts inline", async () => {
  const { getFeaturesByCategory } = await import("../lib/lab-builder/catalog.js");
  const run = loadWizard();
  const catalogProducts = getProducts().map((p) => ({
    id: p.id,
    name: p.name,
    shortName: p.shortName,
    summary: p.summary,
    hasHarnesses: p.hasHarnesses,
    learnHubUrl: p.learnHubUrl,
    featureCount: getFeatures().filter((f) => productOf(f) === p.id).length,
  }));
  run(`labBuilder.categories = ${JSON.stringify(getFeaturesByCategory())};`);
  run(`labBuilder.products = ${JSON.stringify(catalogProducts)};`);
  run(`labBuilder.harnesses = ${JSON.stringify(getHarnesses())};`);
  run("lbRenderProducts()");

  const productHtml = run.element("lb-product-options").innerHTML;
  const csProduct = catalogProducts.find((p) => p.id === "copilot-studio");
  const csL100 = idsOf("copilot-studio", 100).length;
  const csL200 = idsOf("copilot-studio", 200).length;
  const csL300 = idsOf("copilot-studio", 300).length;

  // Helper keeps readable text format.
  assert.equal(
    run(`lbProductLevelCounts(${JSON.stringify(csProduct)})`),
    `Level 100: ${csL100}, Level 200: ${csL200}, Level 300: ${csL300}`,
  );
  assert.equal(run('lbProductLevelCounts({ id: "empty-product" })'), "No topics yet");

  // Product card separates description from two-tier .lb-card-footer: Row 1 (.lb-stat-total-row) + Row 2 (.lb-stat-level-grid).
  assert.match(productHtml, /class="lb-card-body"/);
  assert.match(productHtml, /class="scenario-card-desc"[\s\S]*?<div class="lb-card-footer">/);
  assert.match(
    productHtml,
    new RegExp(
      `<div class="lb-stat-total-row"><span class="lb-stat-chip lb-stat-chip-total"><strong>${csProduct.featureCount}<\\/strong> total topics<span class="sr-only">\\.<\\/span><\\/span><\\/div>`,
    ),
  );
  assert.match(
    productHtml,
    new RegExp(
      `<div class="lb-stat-level-grid lb-stat-level-grid-3">[\\s\\S]*?<span class="lb-stat-chip lb-stat-chip-level"><span class="lb-stat-level-label">Level 100<span class="sr-only">:<\\/span><\\/span> <strong>${csL100}<\\/strong><span class="sr-only">,<\\/span><\\/span>`,
    ),
  );
  assert.match(
    productHtml,
    /<div class="lb-card-learn"><a href="https:\/\/learn\.microsoft\.com\/microsoft-copilot-studio\/"[^>]*>Microsoft Learn for Copilot Studio \(opens in a new tab\)<\/a><\/div>/,
  );

  // Stripping HTML tags yields natural screen-reader text with punctuation and spaces (never concatenated spans).
  const plainText = productHtml.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  assert.ok(
    plainText.includes(
      `${csProduct.featureCount} total topics. Level 100: ${csL100}, Level 200: ${csL200}, Level 300: ${csL300}. Microsoft Learn for Copilot Studio (opens in a new tab)`,
    ),
    `Expected natural screen-reader text in: ${plainText}`,
  );

  // Checked state toggles .checked class on selected product card, plus 1-level, 2-level, and 0-topic edge cases.
  run(`
    labBuilder.products = [
      { id: "solo", name: "Solo Product", shortName: "Solo", summary: "One topic.", featureCount: 1, learnHubUrl: "https://learn.microsoft.com/solo" },
      { id: "duo", name: "Duo Product", shortName: "Duo", summary: "Two levels.", featureCount: 3 },
      { id: "zero", name: "Empty Product", shortName: "Empty", summary: "Coming soon.", featureCount: 0 }
    ];
    labBuilder.categories = [{
      id: "c",
      features: [
        { id: "f1", product: "solo", level: 100 },
        { id: "f2", product: "duo", level: 100 },
        { id: "f3", product: "duo", level: 200 },
        { id: "f4", product: "duo", level: 200 }
      ]
    }];
    lbToggleProduct("solo", true);
  `);
  const edgeHtml = run.element("lb-product-options").innerHTML;
  assert.match(edgeHtml, /<label class="scenario-role checked">\s*<input[^>]*value="solo"[^>]*checked>/);
  assert.match(edgeHtml, /<div class="lb-stat-total-row"><span class="lb-stat-chip lb-stat-chip-total"><strong>1<\/strong> total topic<span class="sr-only">\.<\/span><\/span><\/div>/);
  assert.match(edgeHtml, /<div class="lb-stat-level-grid lb-stat-level-grid-1"><span class="lb-stat-chip lb-stat-chip-level">/);
  assert.match(edgeHtml, /<div class="lb-stat-level-grid lb-stat-level-grid-2"><span class="lb-stat-chip lb-stat-chip-level">/);
  assert.match(edgeHtml, /<div class="lb-stat-total-row"><span class="lb-stat-chip lb-stat-chip-empty">No topics yet<span class="sr-only">\.<\/span><\/span><\/div>/);

  // Tailor it: the level choice is a compact segmented control and the harness choice a radio list. Both show their
  // counts inline, next to the label, and neither uses the stat chips that product cards keep.
  run(`
    labBuilder.products = ${JSON.stringify(catalogProducts)};
    labBuilder.categories = ${JSON.stringify(getFeaturesByCategory())};
    labBuilder.selectedProducts = new Set(["copilot-studio"]);
    labBuilder.industry = "retail";
  `);
  await run("lbRenderLevels()");
  run("lbRenderHarnesses()");

  const levelHtml = run.element("lb-level-options").innerHTML;
  assert.doesNotMatch(levelHtml, /lb-stat-chip|lb-stat-total-row|lb-stat-detail-row|lb-card-footer|lb-card-learn/);
  const levelLabels = { 100: "Beginner", 200: "Intermediate", 300: "Advanced" };
  for (const level of [100, 200, 300]) {
    const shown = recommend({ industry: "retail", departments: [], products: ["copilot-studio"], level, harness: "standard" }).filter.shown;
    const count = shown > 0 ? `${shown} ${shown === 1 ? "topic" : "topics"}` : "No topics yet";
    assert.match(
      levelHtml,
      new RegExp(
        `<label class="lb-seg-option">\\s*<input type="radio" name="lb-level" value="${level}" autocomplete="off" ${level === 100 ? "checked" : ""}>\\s*<span class="lb-seg-title">Level ${level}<\\/span>\\s*<span class="lb-seg-count">${levelLabels[level]} · ${count}<\\/span>`,
      ),
      `Level ${level} shows its label and topic count inline`,
    );
  }
  assert.equal([...levelHtml.matchAll(/\schecked>/g)].length, 1, "exactly one level is checked");

  const harnessLevel = (level) => {
    run(`labBuilder.level = ${level};`);
    run("lbRenderHarnesses()");
    return run.element("lb-harness-options").innerHTML;
  };
  const csHarnesses = getHarnesses().filter((h) => (h.product || "copilot-studio") === "copilot-studio");
  assert.ok(csHarnesses.length >= 2);
  for (const level of [100, 200]) {
    const harnessHtml = harnessLevel(level);
    assert.doesNotMatch(harnessHtml, /lb-stat-chip|lb-stat-total-row|lb-card-footer|lb-card-learn/);
    for (const harness of csHarnesses) {
      const shown = getFeatures().filter((f) => productOf(f) === "copilot-studio" && (f.harness || []).includes(harness.id) && f.level === level).length;
      const levelName = `Level ${level} (${levelLabels[level]})`;
      const meta = shown ? `${shown} ${levelName} ${shown === 1 ? "topic" : "topics"}` : `No ${levelName} topics yet`;
      const escaped = meta.replace(/[()]/g, "\\$&");
      assert.match(
        harnessHtml,
        new RegExp(`<label class="lb-radio-option">\\s*<input type="radio" name="lb-harness" value="${harness.id}"[^>]*>\\s*<span class="lb-radio-name">[^<]*(?:<span[^>]*>[^<]*<\\/span>)?[^<]*<span class="lb-seg-count">· ${escaped}<\\/span>`),
        `${harness.id} shows its ${levelName} count inline`,
      );
    }
  }
});

test("sticky top navigation and right-anchored step footers stay synchronized across all four steps, with the harness row appearing on Tailor it without changing any label", async () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  const html = read("../public/index.html");
  const serverJs = read("../server.js");

  // Static public assets set Cache-Control: no-cache so browsers validate fresh wizard JS/CSS on reload.
  assert.match(
    serverJs,
    /express\.static\(resolve\(import\.meta\.dirname,\s*"public"\),\s*\{\s*setHeaders\(res\)\s*\{\s*res\.setHeader\("Cache-Control",\s*"no-cache"\);/,
  );

  // Sticky bar exposes persistent Back + Next controls alongside Start over, and every pane ends in a footer with a prominent Next (or Build).
  assert.match(html, /id="lb-wizard-sticky"[\s\S]*?id="lb-sticky-back"[^>]*hidden[\s\S]*?id="lb-sticky-next"[^>]*>Next: Tailor it →<\/button>/);
  const footerLabels = { 1: "Next: Tailor it →", 2: "Next: Topics →", 3: "Next: Review and build →", 4: "Build my lab" };
  for (const paneId of [1, 2, 3, 4]) {
    const paneMatch = html.match(
      new RegExp(`id="lb-pane-${paneId}"[\\s\\S]*?(?=<!-- Step |<div class="panel" id="lb-result-panel")`),
    );
    assert.ok(paneMatch, `expected #lb-pane-${paneId}`);
    assert.match(paneMatch[0], /data-lb-step-footer/, `#lb-pane-${paneId} should have a step footer`);
    const primary = paneMatch[0].match(/<button class="btn btn-primary lb-nav-next"[^>]*>([^<]*)<\/button>/);
    assert.ok(primary, `#lb-pane-${paneId} should have prominent .lb-nav-next CTA`);
    assert.equal(primary[1], footerLabels[paneId], `#lb-pane-${paneId} footer label`);
  }
  assert.match(html, /<button class="btn btn-primary lb-nav-next" type="button" id="lb-generate-btn" onclick="lbGenerate\(\)">Build my lab<\/button>/);
  // The Topics bottom bar is styled consistently via CSS without touching #lb-pane-3 inner markup.
  assert.match(html, /#lb-pane-3\s*>\s*div:last-child\s*\{/);
  assert.match(html, /\.lb-step-footer\s*>\s*\.lb-nav-next,\s*#lb-pane-3\s*>\s*div:last-child\s*>\s*\.btn-primary\s*\{\s*margin-left:\s*auto;/);

  const { getFeaturesByCategory } = await import("../lib/lab-builder/catalog.js");
  const run = loadWizard();
  run(`labBuilder.categories = ${JSON.stringify(getFeaturesByCategory())};`);
  run(`labBuilder.harnesses = ${JSON.stringify(getHarnesses())};`);
  run("lbSyncNavControls()");
  assert.equal(run.element("lb-sticky-back").hidden, true, "Step 1 hides sticky Back button");
  assert.equal(run.element("lb-sticky-next").textContent, footerLabels[1]);
  assert.equal(run.element("lb-sticky-next").disabled, false);

  // Select SharePoint AI (no harness): Tailor it has no harness row, and the sticky label already says "Next: Topics →".
  run("lbToggleProduct('sharepoint-ai', true)");
  await run("lbRefresh()");
  run("lbStickyPrimaryAction()"); // 1 -> 2
  assert.equal(run("labBuilder.step"), 2);
  assert.equal(run.element("lb-sticky-back").hidden, false, "Step 2+ shows sticky Back button");
  assert.equal(run.element("lb-sticky-next").textContent, footerLabels[2]);
  assert.equal(run.element("lb-harness-row").hidden, true, "no harness row for a product without harnesses");

  // Adding Copilot Studio (has harnesses) shows the harness row on Tailor it while every label stays the same.
  run("lbToggleProduct('copilot-studio', true)");
  await run("lbRefresh()");
  assert.equal(run("labBuilder.step"), 2);
  assert.equal(run.element("lb-harness-row").hidden, false, "the harness row appears on Tailor it");
  assert.match(run.element("lb-harness-options").innerHTML, /name="lb-harness"/);
  assert.equal(run.element("lb-sticky-next").textContent, footerLabels[2], "the sticky label does not change when the harness row appears");
  assert.equal(run("lbNextActionLabel(1)"), footerLabels[1]);
  assert.equal(run("lbNextActionLabel(3)"), footerLabels[3]);
  assert.equal(run("lbNextActionLabel(4)"), footerLabels[4]);

  run("lbStickyPrimaryAction()"); // 2 -> 3
  assert.equal(run("labBuilder.step"), 3);
  assert.equal(run.element("lb-sticky-next").textContent, footerLabels[3]);

  // Clearing selectedIds on Topics enforces the topic guard; picking a topic lets sticky Next advance 3 -> 4.
  const firstTopicId = run("labBuilder.rec.concepts[0].topics[0].id");
  run("labBuilder.rec.selectedIds = [];");
  run("lbStickyPrimaryAction()");
  assert.equal(run("labBuilder.step"), 3);
  assert.equal(run.element("lb-topic-error").textContent, "Choose at least one topic before you review the lab.");

  run(`lbOwnPicks().add(${JSON.stringify(firstTopicId)})`);
  await run("lbRefresh()");
  run("lbStickyPrimaryAction()"); // 3 -> 4
  assert.equal(run("labBuilder.step"), 4);
  assert.equal(run.element("lb-sticky-next").textContent, "Build my lab");

  // Deselecting all topics on Review and build disables the sticky primary and the Build button.
  const selectedIds = JSON.parse(run("JSON.stringify(labBuilder.rec.selectedIds)"));
  assert.ok(selectedIds.length > 0, "expected recommended topics to be preselected");
  run("labBuilder.rec.selectedIds = []; lbSyncReviewControls();");
  assert.equal(run.element("lb-sticky-next").disabled, true);
  assert.equal(run.element("lb-generate-btn").disabled, true);

  // Re-selecting a topic re-enables both, and the sticky primary on step 4 triggers lab generation.
  run(`labBuilder.rec.selectedIds = ${JSON.stringify(selectedIds)}; lbSyncReviewControls();`);
  assert.equal(run.element("lb-sticky-next").disabled, false);
  assert.equal(run.element("lb-generate-btn").disabled, false);

  let generatedCount = 0;
  run.context.lbGenerate = () => {
    generatedCount += 1;
    run("labBuilder.busy = true; lbSyncNavControls();");
  };
  run("lbStickyPrimaryAction()");
  assert.equal(generatedCount, 1, "clicking the sticky primary on step 4 triggers lab generation");
  assert.equal(run("labBuilder.step"), 4, "building does not move to another step");
  assert.equal(run.element("lb-sticky-next").disabled, true, "sticky primary disables while generation is busy");
  assert.equal(run.element("lb-sticky-back").disabled, true, "sticky Back disables while generation is busy");
});

// ── The rename ──────────────────────────────────────────────────────────────

test("the product is named Dynamic Microsoft Training and Lab Generator wherever a person sees its name", () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  const html = read("../public/index.html");
  assert.match(html, /<title>[^<]*Dynamic Microsoft Training and Lab Generator[^<]*<\/title>/);
  assert.match(html, /id="portal-title"[^>]*>Dynamic Microsoft Training and Lab Generator</);
  for (const file of ["../public/index.html", "../public/app.js", "../server.js", "../lib/branding.js", "../README.md", "../../README.md", "../package.json"]) {
    assert.doesNotMatch(read(file), /Copilot Studio Labs/, `${file} still uses the old product name`);
  }
  assert.match(read("../lib/product-name.js"), /PRODUCT_NAME = "Dynamic Microsoft Training and Lab Generator"/);
  assert.match(read("../lib/branding.js"), /companyName: PRODUCT_NAME/);
  assert.match(read("../../README.md"), /^# ⚡ Dynamic Microsoft Training and Lab Generator/m);
});

// ── Products added from Microsoft Learn ─────────────────────────────────────

function customProductFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "my-products-"));
  const root = "https://learn.microsoft.com/power-automate";
  const product = buildUserProduct({ name: "Microsoft Power Automate", root, summary: "Microsoft Power Automate documentation on Microsoft Learn." });
  setCustomProducts([product]);
  const main = { schemaVersion: 1, generatedAt: "2026-11-13T12:00:00Z", source: "test", catalogVersion: "test", topics: [], catalog: [], pageHashes: {} };
  main.listHash = listHash(main);
  setTopicSource({ source: "cache", snapshot: main });
  t.after(() => {
    setCustomProducts(undefined);
    resetTopicSource();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, product, root };
}

test("a product added from Learn joins the product list without touching the reviewed catalog or its checks", (t) => {
  const { product } = customProductFixture(t);
  assert.ok(getProducts().some((p) => p.id === product.id && p.custom === true));
  assert.deepEqual(getBuiltInProducts().filter((p) => p.custom), []);
  assert.deepEqual(validateCatalog(), [], "the coverage and product checks only judge the reviewed products");
  assert.equal(product.hasHarnesses, false);
  assert.match(product.labPrerequisites[0], /Not confirmed in Microsoft Learn/);
  assert.equal(buildUserProduct({ name: "x", root: "http://evil.example/x" }), null);
  assert.equal(buildUserProduct({ name: "Name", root: "https://learn.microsoft.com/" }), null);
});

test("a product added from Learn is never shown with a name cut short, including one saved earlier with a cut short name", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "my-products-short-"));
  t.after(() => {
    setCustomProducts(undefined);
    rmSync(dir, { recursive: true, force: true });
  });
  const name = "What do you need help with today? Microsoft Learn product page";
  const root = "https://learn.microsoft.com/contoso-help";
  const fresh = buildUserProduct({ name, root });
  assert.equal(fresh.shortName, name, "a new product keeps its whole name");

  // Older saved files carry a short name cut at 29 characters. The file is read as it is; only what the portal shows changes.
  const older = { ...fresh, shortName: `${name.slice(0, 29)}…` };
  const file = join(dir, "user-products.json");
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, products: [older] }));
  assert.equal(readUserProducts(file)[0].shortName, older.shortName, "reading does not rewrite the saved name");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).products[0].shortName, older.shortName, "and nothing is written back");

  setCustomProducts(readUserProducts(file));
  assert.equal(getProduct(older.id).shortName, name, "the product list shows the whole name wherever a short one is used");
  assert.equal(getProduct(older.id).name, name);
  assert.equal(getProduct("copilot-studio").shortName, "Copilot Studio", "reviewed products keep their short names");
});

test("a lab for a product added from Learn is neutral: a pilot, no agent, no architecture, no quiz", async (t) => {
  const { dir, product, root } = customProductFixture(t);
  const url = `${root}/getting-started`;
  const topic = buildUserTopic({
    url,
    product: product.id,
    markdown: "# Get started with flows\n\nA flow runs a series of steps when something happens.\n\n1. Select **Create**.\n2. Select **Instant cloud flow**.\n",
    now: Date.parse("2026-11-13T12:00:00Z"),
  });
  setUserTopicsSource([topic]);
  t.after(() => setUserTopicsSource(undefined));
  assert.equal(productForUrl(url), product.id);
  assert.equal(topic.product, product.id);
  assert.equal(resolveDeliverableMode([product.id], [getFeature(topic.id)]), DELIVERABLE_MODES.LEARN_PRODUCT);
  const lab = await generateLab({ products: [product.id], features: [topic.id], level: 200 }, { outputRoot: dir, useLearnMcp: false, useLlm: false });
  assert.equal(lab.status, "complete", JSON.stringify(lab.blockers?.map((b) => b.code)));
  assert.equal(lab.validation.failed, 0, JSON.stringify(lab.validation.tests.filter((x) => x.status === "fail")));
  assert.match(lab.plan.title, /^Cross-industry: Hands-on /);
  assert.doesNotMatch(lab.markdown, /lab-architecture|Copilot Studio|Assistant\b/);
  assert.match(lab.markdown, /Microsoft Power Automate/);
});

test("the product routes: picklist, search, add, refuse an overlap, and remove, saved on disk", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "product-routes-"));
  setCustomProducts([]);
  t.after(() => {
    setCustomProducts(undefined);
    rmSync(dir, { recursive: true, force: true });
  });
  const file = join(dir, "user-products.json");
  const service = { config: { userProductsPath: file, cachePath: join(dir, "c.json"), snapshotPath: join(dir, "s.json") } };
  const learn = {
    search: async () => [{ title: "Get started", url: "https://learn.microsoft.com/dynamics365/sales/get-started", excerpt: "x" }, { title: "Not Learn", url: "http://evil.example/x", excerpt: "y" }],
    page: async (url) => ({ url, error: null, markdown: "# Dynamics 365 Sales documentation\n\nLearn about the product and how to use it every day.\n" }),
  };
  const app = express();
  app.use(express.json());
  registerProductRoutes(app, { getService: () => service, createRateLimiter, positiveIntFromEnv, learn });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (route, method = "GET", body) => fetch(`${base}${route}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

  const picklist = await (await call("/api/lab-builder/products/picklist")).json();
  assert.ok(picklist.products.length >= 15 && picklist.products.every((p) => p.root.startsWith("https://learn.microsoft.com/")));
  assert.ok(picklist.products.find((p) => p.name === "Microsoft Teams platform").coveredBy, "an overlap with a reviewed product is flagged");

  const found = await (await call("/api/lab-builder/products/mine/search", "POST", { query: "dynamics sales" })).json();
  assert.equal(found.groups.length, 1);
  assert.deepEqual(found.groups[0].pages.map((page) => page.title), ["Get started"]);
  assert.deepEqual(found.groups[0].scopes.map((scope) => scope.root), ["https://learn.microsoft.com/dynamics365", "https://learn.microsoft.com/dynamics365/sales"], "the article itself is not a scope");
  assert.deepEqual(found.groups[0].scopes.filter((scope) => scope.recommended).map((scope) => scope.root), ["https://learn.microsoft.com/dynamics365/sales"]);
  assert.deepEqual(found.hidden, { count: 0, kinds: [] });

  const root = "https://learn.microsoft.com/dynamics365/sales";
  const added = await call("/api/lab-builder/products/mine", "POST", { root });
  assert.equal(added.status, 201);
  const product = (await added.json()).product;
  assert.deepEqual([product.id, product.name, product.custom], ["custom-dynamics-365-sales", "Dynamics 365 Sales", true]);
  assert.ok(getProducts().some((p) => p.id === product.id));
  assert.deepEqual(readUserProducts(file).map((p) => p.id), [product.id], "saved on disk");
  assert.equal((await call("/api/lab-builder/products/mine", "POST", { root })).status, 409);
  assert.equal((await call("/api/lab-builder/products/mine", "POST", { root: "https://learn.microsoft.com/copilot/plan" })).status, 409, "inside a reviewed product's documentation");
  assert.equal((await call("/api/lab-builder/products/mine", "POST", { root: "http://learn.microsoft.com/x" })).status, 400);
  for (const address of ["https://learn.microsoft.com/answers/a/12804744", "https://learn.microsoft.com/training/modules/overview-d365-sales-professional"]) {
    const refused = await call("/api/lab-builder/products/mine", "POST", { root: address });
    assert.equal(refused.status, 422, `${address} is not product documentation`);
    assert.match((await refused.json()).error, /not product documentation/);
  }
  assert.deepEqual(readUserProducts(file).map((p) => p.id), [product.id], "nothing was saved for a refused address");

  assert.equal((await call(`/api/lab-builder/products/mine/${product.id}`, "DELETE")).status, 200);
  assert.equal((await call(`/api/lab-builder/products/mine/${product.id}`, "DELETE")).status, 404);
  assert.equal(getProducts().some((p) => p.custom), false);
});

test("the Product step offers an Add another Microsoft product panel, labeled, with its script after the wizard, and marks what you added", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /<details class="lb-mine" id="lb-addprod">/);
  for (const id of ["lb-addprod-pick", "lb-addprod-input"]) assert.match(html, new RegExp(`<label for="${id}"`));
  assert.ok(html.indexOf("lab-builder-wizard.js") < html.indexOf("lab-builder-my-products.js"), "the panel script loads after the wizard");
  const panel = readFileSync(new URL("../public/lab-builder-my-products.js", import.meta.url), "utf8");
  for (const route of ["/api/lab-builder/products/picklist", "/api/lab-builder/products/mine/search", "/api/lab-builder/products/mine"]) assert.ok(panel.includes(route), route);
  const wizard = readFileSync(new URL("../public/lab-builder-wizard.js", import.meta.url), "utf8");
  assert.match(wizard, /lbRenderCustomProductStats/);
  assert.match(wizard, /Added by you/);
});

// ── The Choose a product dropdown is A to Z ─────────────────────────────────

const A_TO_Z = (a, b) => a.trim().localeCompare(b.trim(), "en-US", { numeric: true, sensitivity: "base" });

test("the picklist is ordered by display name: case ignored, numbers by value, symbols first, accents as plain letters, spaces ignored, ties in their original order", () => {
  const entries = (names) => names.map((name, index) => ({ name, root: `https://learn.microsoft.com/p${index}` }));
  const order = (names) => sortPicklist(entries(names)).map((entry) => entry.name);
  assert.deepEqual(order(["banana", "Apple", "cherry", "APRICOT"]), ["Apple", "APRICOT", "banana", "cherry"], "mixed case");
  assert.deepEqual(order(["Product 10", "Product 2", "Product 1"]), ["Product 1", "Product 2", "Product 10"], "numbers count by value");
  assert.deepEqual(order(["Zebra", "Éclair", "Eagle", "Ecole", "(Preview) Zed"]), ["(Preview) Zed", "Eagle", "Éclair", "Ecole", "Zebra"], "a symbol first, an accent as its plain letter");
  assert.deepEqual(order(["  Beta ", "Alpha", "Gamma "]), ["Alpha", "  Beta ", "Gamma "], "leading and trailing spaces do not count, and the names are returned as given");
  const ties = sortPicklist(entries(["alpha", "Alpha", "Beta", "ALPHA"]));
  assert.deepEqual(ties.map((entry) => entry.root.slice(-2)), ["p0", "p1", "p3", "p2"], "equal names keep the order they came in");
  assert.deepEqual(sortPicklist([]), []);
});

test("the shipped picklist comes back A to Z with every entry kept", () => {
  const file = JSON.parse(readFileSync(new URL("../lib/lab-builder/product-picklist.json", import.meta.url), "utf8")).products;
  const names = readPicklist().map((entry) => entry.name);
  assert.deepEqual(names, [...names].sort(A_TO_Z));
  assert.deepEqual([...names].sort(), file.map((entry) => entry.name).sort(), "the same products, only reordered");
});

/** The panel script in a small fake page whose requests go to a real picklist server at `base`. */
function loadProductPanel(base) {
  const source = readFileSync(new URL("../public/lab-builder-my-products.js", import.meta.url), "utf8");
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { id, innerHTML: "", textContent: "", value: "", listeners: {}, classList: { toggle() {} }, addEventListener(type, fn) { this.listeners[type] = fn; } });
    return elements.get(id);
  };
  const posts = [];
  const context = {
    document: { readyState: "complete", getElementById: element },
    escapeHtml: (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    labBuilder: { products: [], selectedProducts: new Set(), chosenSteps: new Set() },
    lbRenderProducts() {},
    lbProductsChanged() {},
    lbRefreshLearn: async () => {},
    fetch: async (path, init) => {
      if (path === "/api/lab-builder/features") return { ok: true, json: async () => ({ products: [] }) };
      if (init?.method === "POST") posts.push(JSON.parse(init.body));
      return fetch(`${base}${path}`, init);
    },
    setTimeout,
    console,
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  const run = (code) => vm.runInContext(code, context);
  const options = () => [...element("lb-addprod-pick").innerHTML.matchAll(/<option value="([^"]*)"( disabled)?>([^<]*)<\/option>/g)].map((m) => ({ value: m[1], disabled: Boolean(m[2]), label: m[3] }));
  return { run, element, options, posts };
}

test("the Choose a product dropdown is A to Z, keeps an added product in its place, and each option still adds its own product", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "product-dropdown-"));
  setCustomProducts([]);
  t.after(() => {
    setCustomProducts(undefined);
    rmSync(dir, { recursive: true, force: true });
  });
  const service = { config: { userProductsPath: join(dir, "user-products.json"), cachePath: join(dir, "c.json"), snapshotPath: join(dir, "s.json") } };
  const learn = { search: async () => [], page: async (url) => ({ url, error: null, markdown: "# Power BI documentation\n\nLearn about the product and how to use it every day.\n" }) };
  const app = express();
  app.use(express.json());
  registerProductRoutes(app, { getService: () => service, createRateLimiter, positiveIntFromEnv, learn });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const panel = loadProductPanel(`http://127.0.0.1:${server.address().port}`);
  const select = panel.element("lb-addprod-pick");
  const picklist = () => JSON.parse(panel.run("JSON.stringify(lbProd.picklist.map((item) => item.name))"));

  await panel.run("lbProdLoadPicklist()");
  const before = panel.options();
  const names = picklist();
  assert.deepEqual(before[0], { value: "", disabled: false, label: "Choose a product..." }, "the placeholder stays first");
  assert.ok(names.length >= 15);
  assert.deepEqual(names, [...names].sort(A_TO_Z), "the dropdown lists the products A to Z");
  assert.ok(before.some((option) => option.disabled && /\(already covered by /.test(option.label)), "a covered product is listed, disabled, in its own place");
  before.slice(1).forEach((option, index) => {
    assert.equal(option.value, String(index), "the value is the product's place in the list");
    assert.ok(option.label.startsWith(names[index]), `${option.label} is product ${index}`);
  });

  select.value = "";
  panel.element("lb-addprod-add").listeners.click();
  assert.equal(panel.element("lb-addprod-status").textContent, "Choose a product from the list first.");
  assert.deepEqual(panel.posts, []);

  select.value = before.find((option) => option.label === "Power BI").value;
  panel.element("lb-addprod-add").listeners.click();
  assert.deepEqual(panel.posts, [{ root: "https://learn.microsoft.com/power-bi", name: "Power BI" }], "the chosen option adds that product");
  for (let waited = 0; waited < 3000 && !/topics are in the Topics step/.test(panel.element("lb-addprod-status").textContent); waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(panel.element("lb-addprod-status").textContent, /^Added "Power BI"\./);

  const after = panel.options();
  assert.deepEqual(picklist(), names, "the list refreshes in the same order");
  assert.deepEqual(
    after.map((option) => option.label),
    before.map((option) => (option.label === "Power BI" ? "Power BI (added)" : option.label)),
    "the added product stays in its alphabetical place, marked added",
  );
  assert.equal(after.find((option) => option.label === "Power BI (added)").disabled, true);
});
