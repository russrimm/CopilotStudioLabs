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
import { getProduct, getProducts, productOf, primaryProduct, validateProducts } from "../lib/lab-builder/products.js";
import { planLab } from "../lib/lab-builder/planner.js";
import { recommend } from "../lib/lab-builder/recommend.js";
import { buildDifferenceBlocks } from "../lib/lab-builder/differences.js";
import { selectionsFromManifest } from "../lib/lab-builder/generated-labs.js";

process.env.LAB_BUILDER_LINK_CHECK = "off";
process.env.LAB_BUILDER_VENDOR_DOCS = "off";

const NON_HARNESS = getProducts().filter((p) => !p.hasHarnesses).map((p) => p.id);
const idsOf = (product, level) => getFeatures().filter((f) => productOf(f) === product && (!level || f.level === level)).map((f) => f.id);

// ── The product model ───────────────────────────────────────────────────────

test("the shipped catalog has the six products, each with real Learn-grounded topics at every level it lists", () => {
  assert.deepEqual(
    getProducts().map((p) => p.id),
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
  for (const product of getProducts()) assert.ok(markdown.includes(`**${product.name}**`), `${product.name} has a table`);
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
    assert.ok(result.totals.selectedCount > 0, "the other product's topics are still listed");
    const only = recommend({ products: ["power-platform-ai-hub"], level: 300 });
    assert.equal(only.totals.selectedCount, 0);
    assert.match(only.products[0].message, /Choose another level/);
  } finally {
    all.splice(0, all.length, ...snapshot);
  }
  assert.ok(recommend({ products: ["power-platform-ai-hub"], level: 300 }).totals.selectedCount > 0);
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
    assert.equal(lab.manifest.generator, "Microsoft AI Training Generator");
    assert.equal(lab.manifest.product, "ai-foundry");
    assert.deepEqual(lab.manifest.products, ["ai-foundry"]);
    assert.ok(lab.manifest.modules.every((m) => m.product === "ai-foundry"));
    assert.equal(lab.manifest.differences.labHarness, null);
    assert.match(lab.markdown, /\| 🧩 \*\*PRODUCTS\*\* \| Microsoft Foundry \|/);
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
  const element = () => ({ innerHTML: "", textContent: "", value: "", checked: true, hidden: false, style: {}, contains: () => false, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, setAttribute() {}, removeAttribute() {}, classList: { toggle() {}, add() {}, remove() {} } });
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
  const run = (code) => vm.runInContext(code, context);
  run(`labBuilder.products = ${JSON.stringify(getProducts().map((p) => ({ id: p.id, name: p.name, shortName: p.shortName, hasHarnesses: p.hasHarnesses })))};`);
  return run;
}

test("the wizard starts on Product with Copilot Studio selected and the steps in the required order", () => {
  const run = loadWizard();
  assert.deepEqual(JSON.parse(run("JSON.stringify(LB_STEPS.map((s) => s.label))")), ["Product", "Vertical", "Departments", "Level", "Harness", "Topics", "Review", "Generate"]);
  assert.deepEqual(JSON.parse(run("JSON.stringify([...labBuilder.selectedProducts])")), ["copilot-studio"]);
  assert.deepEqual(JSON.parse(run("JSON.stringify(lbVisibleStepIds())")), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(run("lbAnswers().harness"), "standard");
});

test("the Harness step appears only when a selected product has harnesses", () => {
  const run = loadWizard();
  run("labBuilder.selectedProducts = new Set(['sharepoint-ai'])");
  assert.deepEqual(JSON.parse(run("JSON.stringify(lbVisibleStepIds())")), [1, 2, 3, 4, 6, 7, 8]);
  assert.equal(run("lbAdjacentStep(4, 1)"), 6, "Level goes straight to Topics");
  assert.equal(run("lbAdjacentStep(6, -1)"), 4, "Topics goes straight back to Level");
  assert.equal(run("'harness' in lbAnswers()"), false);
  assert.equal(run("'harness' in lbRequest()"), false);
  assert.deepEqual(JSON.parse(run("JSON.stringify(lbRequest().products)")), ["sharepoint-ai"]);

  run("labBuilder.selectedProducts = new Set(['sharepoint-ai', 'copilot-studio'])");
  assert.deepEqual(JSON.parse(run("JSON.stringify(lbVisibleStepIds())")), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(run("lbAdjacentStep(4, 1)"), 5);
  assert.deepEqual(JSON.parse(run("JSON.stringify(lbRequest().products)")), ["copilot-studio", "sharepoint-ai"], "products keep catalog order");
  assert.equal(run("lbRequest().harness"), "standard");
});

test("the last product cannot be cleared, and the product label names every selected product", () => {
  const run = loadWizard();
  run("lbToggleProduct('copilot-studio', false)");
  assert.deepEqual(JSON.parse(run("JSON.stringify([...labBuilder.selectedProducts])")), ["copilot-studio"]);
  run("labBuilder.selectedProducts = new Set(['sharepoint-ai', 'ai-foundry', 'copilot-studio'])");
  assert.equal(run("lbProductsLabel()"), "Copilot Studio, SharePoint AI, and Foundry");
});

// ── The rename ──────────────────────────────────────────────────────────────

test("the product is named Microsoft AI Training Generator wherever a person sees its name", () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  const html = read("../public/index.html");
  assert.match(html, /<title>[^<]*Microsoft AI Training Generator[^<]*<\/title>/);
  assert.match(html, /id="portal-title"[^>]*>[^<]*<span[^>]*>[^<]*<\/span> Microsoft AI Training Generator</);
  for (const file of ["../public/index.html", "../public/app.js", "../server.js", "../lib/branding.js", "../README.md", "../../README.md", "../package.json"]) {
    assert.doesNotMatch(read(file), /Copilot Studio Labs/, `${file} still uses the old product name`);
  }
  assert.match(read("../lib/branding.js"), /companyName: "Microsoft AI Training Generator"/);
  assert.match(read("../../README.md"), /^# ⚡ Microsoft AI Training Generator/m);
});
