import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Writable } from "node:stream";

import { getFeature, getFeatures, getFeaturesByCategory, validateCatalog } from "../lib/lab-builder/catalog.js";
import { getProduct, productOf } from "../lib/lab-builder/products.js";
import { planLab } from "../lib/lab-builder/planner.js";
import { recommend } from "../lib/lab-builder/recommend.js";
import { getRecommendations } from "../lib/lab-builder/concepts.js";
import { generateLab } from "../lib/lab-builder/generator.js";
import { slotsForFeature, describeSlot } from "../lib/lab-builder/slots.js";
import { buildAdminPrerequisites } from "../lib/lab-builder/admin-prereqs.js";
import { buildPrerequisitesChecklist, renderPrerequisitesChecklistMarkdown } from "../lib/lab-builder/prereq-checklist.js";
import { buildAdministratorSetupGuide, renderAdministratorSetupGuideMarkdown } from "../lib/lab-builder/admin-guide.js";
import { LEARNER_SETUP_NOTE } from "../lib/lab-builder/learner-guide.js";
import { scanLabDirectory, summarizeGate } from "../lib/lab-builder/lab-gate.js";
import { readGeneratedLab, selectionsFromManifest } from "../lib/lab-builder/generated-labs.js";
import {
  exportGeneratedLab,
  renderGeneratedLabAdminGuide,
  renderGeneratedLabDocx,
  renderGeneratedLabHtml,
  renderGeneratedLabMarkdown,
  renderGeneratedLabPdf,
  renderGeneratedLabPptx,
  renderGeneratedLabPrerequisites,
} from "../lib/exporter.js";
import { auditEntryPaths, resolveExportBudget } from "../lib/export-names.js";
import { readZipStrict } from "../../tools/lab-builder/lib/ooxml-strict.mjs";

process.env.LAB_BUILDER_LINK_CHECK = "off";
process.env.LAB_BUILDER_VENDOR_DOCS = "off";

const PRODUCT = "power-platform-ai-hub";
const features = () => getFeatures().filter((f) => productOf(f) === PRODUCT);
const here = dirname(fileURLToPath(import.meta.url));
const LIB = resolve(here, "..", "lib", "lab-builder");
const REPO = resolve(here, "..", "..");

const REGION_LAB = "ppai-check-region-and-prerequisites";
const NEW_LABS = {
  "ppai-flow-add-ai-builder-actions": 100,
  "ppai-flow-classify-extract-route-text": 200,
  "ppai-flow-process-documents-on-arrival": 200,
  "ppai-flow-reliable-ai-actions": 300,
  "ppai-flow-monitor-troubleshoot-runs": 300,
  "ppai-agent-tools-prompt-and-flow": 300,
};
const PREREQ_ITEMS = [
  "ai-builder-model-region-availability",
  "ai-builder-us-government-limits",
  "ai-builder-enabled-for-environment",
  "ai-builder-sample-data",
];

const cleanups = [];
after(() => {
  for (const clean of cleanups.reverse()) clean();
});
function tmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const build = (request, root) => generateLab({ industry: "manufacturing", includeCore: false, includeKnowledgeCheck: true, products: [PRODUCT], ...request }, { outputRoot: root, useLearnMcp: false, useLlm: false });
const guideItems = (model) => model.sections.flatMap((section) => section.items);

test("the Power Platform AI hub catalog is a full curriculum with a feature at every level", () => {
  const all = features();
  assert.ok(all.length >= 12 && all.length <= 30, `expected 12-30 features, got ${all.length}`);
  for (const level of getProduct(PRODUCT).levels) {
    assert.ok(all.some((f) => f.level === level), `no feature at level ${level}`);
  }
  assert.ok(all.every((f) => f.id.startsWith("ppai-")));
});

test("every Power Platform AI hub feature cites Learn, has screenshot slots with curated alt text, and bolds its UI names", () => {
  for (const feature of features()) {
    assert.ok(feature.docUrls.every((u) => u.startsWith("https://learn.microsoft.com/")), `${feature.id}: docUrls must be Learn pages`);
    assert.ok(feature.docUrls.includes(feature.verifiedAgainst), `${feature.id}: verifiedAgainst must be a docUrl`);
    const slots = slotsForFeature(feature);
    assert.ok(slots.length > 0, `${feature.id}: needs at least one screenshot slot`);
    for (const slot of slots) assert.ok(describeSlot(feature, slot).curated, `${feature.id}: ${slot.filename} needs curated alt text`);
    assert.ok(feature.steps.some((s) => /\*\*[^*]+\*\*/.test(s)), `${feature.id}: steps should bold UI names`);
    assert.ok(!feature.harness, `${feature.id}: AI hub features carry no harness`);
  }
});

test("availability is only set where it is a valid Learn-stated value and conflicting pages are called out", () => {
  const byId = Object.fromEntries(features().map((f) => [f.id, f]));
  for (const f of features()) {
    if (f.availability !== undefined) assert.ok(["ga", "preview", "retired"].includes(f.availability), f.id);
  }
  // Learn labels these two inconsistently, so the catalog states the conflict instead of picking a status.
  for (const id of ["ppai-prebuilt-receipt-processing-flow", "ppai-powerfx-ai-models-in-canvas-app"]) {
    assert.equal(byId[id].availability, undefined, `${id} must not claim a status Learn contradicts`);
    assert.ok(byId[id].concepts.some((c) => c.includes("Not confirmed in Microsoft Learn")), `${id} must flag the conflict`);
  }
});

test("a level 200 plan for the AI hub keeps lower-level prerequisites and stays inside the product", () => {
  const plan = planLab({ products: [PRODUCT], features: ["ppai-prediction-model", "ppai-human-review-prompt-output"], level: 200 });
  const ids = plan.features.map((f) => f.id);
  assert.ok(ids.includes("ppai-explore-ai-hub-models"), "level 100 prerequisite is added");
  assert.ok(ids.includes("ppai-use-prompt-in-flow-and-app") && ids.includes("ppai-build-custom-prompt"));
  assert.ok(plan.features.every((f) => productOf(f) === PRODUCT));
});

// ── The region lab is gone and the new Power Automate and AI Builder labs are in ─────────────────────────────

test("the region and prerequisites lab is gone from the catalog, the wizard, the data files, and a generated lab", async () => {
  assert.equal(getFeature(REGION_LAB), null);
  assert.ok(!features().some((f) => f.id === REGION_LAB));
  assert.ok(!getFeaturesByCategory().flatMap((c) => c.features).some((f) => f.id === REGION_LAB), "not in the wizard's topic list");
  for (const level of [100, 200, 300]) {
    const rec = recommend({ products: [PRODUCT], level });
    assert.ok(!rec.concepts.flatMap((c) => c.topics).some((t) => t.id === REGION_LAB), `level ${level} wizard list`);
    assert.ok(!rec.recommendedIds.includes(REGION_LAB));
  }
  const files = [
    join(LIB, "catalog", "power-platform-ai-hub.json"),
    join(LIB, "recommendations.json"),
    join(LIB, "concepts.json"),
    join(LIB, "architecture-overview.js"),
    join(LIB, "learn-topics.power-platform-ai-hub.snapshot.json"),
    join(LIB, "training", "concepts-others.json"),
    join(LIB, "screenshot-slots.json"),
    join(REPO, "tools", "screenshot-capture", "feature-shots.power-platform-ai-hub.json"),
  ];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    assert.ok(!text.includes(REGION_LAB), `${file} still names the removed lab`);
    assert.ok(!text.includes("Check regional availability and environment prerequisites"), `${file} still carries its title`);
  }
  const root = tmp("ppai-region-gone-");
  const built = await build({ level: 100, features: ["ppai-prebuilt-sentiment-analysis"] }, root);
  const manifest = JSON.parse(readFileSync(join(built.outputDir, "manifest.json"), "utf8"));
  assert.ok(!manifest.modules.some((m) => m.id === REGION_LAB));
  assert.doesNotMatch(readFileSync(join(built.outputDir, "index.md"), "utf8"), /Check regional availability/i);
});

test("the default recommended AI hub set leads with the Power Automate and AI Builder integration labs", () => {
  const lists = getRecommendations().levels;
  const ppai = (level) => lists[String(level)].filter((id) => id.startsWith("ppai-"));
  assert.deepEqual(ppai(100).slice(0, 2), ["ppai-explore-ai-hub-models", "ppai-flow-add-ai-builder-actions"]);
  assert.deepEqual(ppai(200).slice(0, 3), ["ppai-use-prompt-in-flow-and-app", "ppai-flow-classify-extract-route-text", "ppai-flow-process-documents-on-arrival"]);
  assert.deepEqual(ppai(300).slice(0, 3), ["ppai-flow-reliable-ai-actions", "ppai-flow-monitor-troubleshoot-runs", "ppai-agent-tools-prompt-and-flow"]);
  for (const [level, id] of [[100, "ppai-flow-add-ai-builder-actions"], [200, "ppai-flow-classify-extract-route-text"], [300, "ppai-agent-tools-prompt-and-flow"]]) {
    assert.ok(recommend({ products: [PRODUCT], level }).recommendedIds.includes(id), `level ${level} recommends ${id}`);
  }
});

test("the six new Power Automate and AI Builder topics are complete catalog features with Learn sources and picture slots", () => {
  assert.deepEqual(validateCatalog(), [], "the whole catalog passes its own checks");
  const byId = new Map(features().map((f) => [f.id, f]));
  const seenShots = new Set();
  for (const [id, level] of Object.entries(NEW_LABS)) {
    const f = byId.get(id);
    assert.ok(f, `${id} is in the catalog`);
    assert.equal(f.level, level, `${id} level`);
    assert.equal(f.category, "apps-flows");
    assert.ok(f.lastVerified >= "2026-11-24", `${id} was verified on the day it was written`);
    assert.ok(f.docUrls.length >= 3 && f.docUrls.every((u) => /^https:\/\/learn\.microsoft\.com\/[^?#]+$/.test(u) && !/\/en-us\//.test(u)), `${id} docUrls`);
    assert.ok(f.steps.length >= 8 && f.concepts.length >= 4 && f.validation.length >= 2, `${id} has real steps, concepts, and checks`);
    assert.ok(f.screenshots.length >= 2);
    for (const shot of f.screenshots) {
      assert.match(shot.filename, /^ppai-.+\.png$/);
      assert.ok(!seenShots.has(shot.filename), `${shot.filename} is unique`);
      seenShots.add(shot.filename);
    }
    for (const pre of f.prereqs) assert.ok(byId.get(pre) && byId.get(pre).level <= f.level, `${id} prerequisite ${pre}`);
    assert.doesNotMatch(JSON.stringify(f), /[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/u, `${id} has no emoji`);
  }
  assert.ok(features().filter((f) => f.category === "apps-flows").length >= 8);
});

test("a generated AI hub lab with the new topics passes the lab gate with no gaps and exports in every format within the path budget", async () => {
  const root = tmp("ppai-new-labs-");
  for (const [level, ids] of [
    [100, ["ppai-flow-add-ai-builder-actions"]],
    [200, ["ppai-flow-classify-extract-route-text", "ppai-flow-process-documents-on-arrival"]],
    [300, ["ppai-flow-reliable-ai-actions", "ppai-flow-monitor-troubleshoot-runs", "ppai-agent-tools-prompt-and-flow"]],
  ]) {
    const built = await build({ level, features: ids }, root);
    assert.equal(built.status, "complete");
    assert.deepEqual(built.qa.findings.filter((f) => f.severity === "error"), []);
    assert.equal(built.validation.failed, 0);
    const manifest = JSON.parse(readFileSync(join(built.outputDir, "manifest.json"), "utf8"));
    for (const id of ids) assert.ok(manifest.modules.some((m) => m.id === id), `${id} is a module of the level ${level} lab`);
    assert.equal(summarizeGate(scanLabDirectory(built.outputDir)).gaps, 0, `level ${level}: the lab gate finds no gaps`);
    if (level !== 200) continue;

    for (const render of [renderGeneratedLabMarkdown, renderGeneratedLabHtml, renderGeneratedLabDocx, renderGeneratedLabPptx, renderGeneratedLabPdf]) {
      assert.equal(render(root, built.labId).status, 200, render.name);
    }
    for (const format of ["md", "html", "docx", "pdf"]) {
      assert.equal(renderGeneratedLabAdminGuide(root, built.labId, format).status, 200, `admin guide ${format}`);
      assert.equal(renderGeneratedLabPrerequisites(root, built.labId, format).status, 200, `prerequisites ${format}`);
    }
    const chunks = [];
    const sink = new Writable({ write(chunk, _enc, done) { chunks.push(chunk); done(); } });
    const summary = await exportGeneratedLab(root, built.labId, {}, sink, { formats: "all" });
    const zip = readZipStrict(Buffer.concat(chunks), { opc: false });
    assert.deepEqual(zip.problems, []);
    const names = [...zip.entries.keys()];
    assert.deepEqual(auditEntryPaths(names, { budget: resolveExportBudget({}) }), []);
    assert.ok(summary.longestEntry <= 100 && names.every((n) => n.length <= 100), `longest entry ${summary.longestEntry}`);
  }
});

test("the AI hub prerequisites are in the administrator guide and the checklist once each, with a why, a way to check, and Learn links, and only for an AI hub lab", async () => {
  const ppai = (ids, level = 200) => planLab({ products: [PRODUCT], features: ids, level });
  const withPrompt = buildAdminPrerequisites(ppai(["ppai-use-prompt-in-flow-and-app"]));
  const noPrompt = buildAdminPrerequisites(ppai(["ppai-flow-classify-extract-route-text"]));
  const ids = (prereqs) => prereqs.environmentSettings.map((i) => i.id);
  for (const id of [...PREREQ_ITEMS, "ai-builder-flow-license"]) {
    assert.equal(ids(withPrompt).filter((x) => x === id).length, 1, `${id} appears once`);
    assert.equal(ids(noPrompt).filter((x) => x === id).length, 1, `${id} appears once`);
  }
  assert.ok(ids(withPrompt).includes("ai-builder-prompt-model-availability"), "prompt availability shows with a prompt topic");
  assert.ok(!ids(noPrompt).includes("ai-builder-prompt-model-availability"), "and only then");
  assert.ok(!ids(buildAdminPrerequisites(ppai(["ppai-explore-ai-hub-models"], 100))).includes("ai-builder-flow-license"), "the flow license shows only with a flow topic");
  assert.ok(noPrompt.connectors.some((c) => c.id === "content-conversion"), "the email routing topic needs the Content Conversion connector");

  const csPlan = planLab({ products: ["copilot-studio"], harness: "standard", features: ["create-agent"], level: 100 });
  assert.ok(!buildAdminPrerequisites(csPlan).environmentSettings.some((i) => i.id.startsWith("ai-builder-")), "a Copilot Studio lab carries none of them");

  const root = tmp("ppai-prereqs-");
  const built = await build({ level: 200, features: ["ppai-use-prompt-in-flow-and-app", "ppai-flow-classify-extract-route-text"] }, root);
  const manifest = JSON.parse(readFileSync(join(built.outputDir, "manifest.json"), "utf8"));
  const markdown = readFileSync(join(built.outputDir, "index.md"), "utf8");
  const guide = buildAdministratorSetupGuide({ manifest, markdown });
  const checklist = buildPrerequisitesChecklist({ manifest, markdown });
  const expected = [...PREREQ_ITEMS, "ai-builder-prompt-model-availability", "ai-builder-flow-license"];
  for (const model of [guide, checklist]) {
    const items = model === guide ? guideItems(guide) : checklist.sections.flatMap((s) => s.items);
    for (const id of expected) {
      const hits = items.filter((i) => i.adminId === id);
      assert.equal(hits.length, 1, `${id} appears once`);
      assert.ok(hits[0].why.length > 20 && hits[0].check.length > 40, `${id} has a why and a way to check`);
      assert.match(hits[0].learn?.url ?? "", /^https:\/\/learn\.microsoft\.com\//, `${id} has a Learn link`);
      const links = [...hits[0].check.matchAll(/\]\((https?:[^)]+)\)/g)].map((m) => m[1]);
      assert.ok(links.every((u) => u.startsWith("https://learn.microsoft.com/")), `${id} check links only to Learn`);
    }
  }
  const us = guideItems(guide).find((i) => i.adminId === "ai-builder-us-government-limits");
  assert.match(us.condition, /^Only if your environment is in a US Government cloud/);
  assert.match(guideItems(guide).find((i) => i.adminId === "ai-builder-sample-data").condition, /optional/);
  assert.match(guideItems(guide).find((i) => i.adminId === "ai-builder-flow-license").confirm, /Not confirmed in Microsoft Learn/);
  const guideMd = renderAdministratorSetupGuideMarkdown(guide);
  const checklistMd = renderPrerequisitesChecklistMarkdown(checklist);
  for (const text of [guideMd, checklistMd]) {
    assert.match(text, /How to check/);
    assert.match(text, /https:\/\/learn\.microsoft\.com\/ai-builder\/availability-region/);
    assert.match(text, /https:\/\/learn\.microsoft\.com\/microsoft-copilot-studio\/prompt-model-availability/);
  }
  // Credits and capacity are the one existing item, not repeated.
  assert.equal(guideItems(guide).filter((i) => /Copilot Credits or AI Builder capacity/.test(i.title)).length, 1);

  // Learner outputs carry only the one-line pointer to the administrator guide.
  const learner = renderGeneratedLabMarkdown(root, built.labId);
  assert.equal(learner.status, 200);
  assert.equal(learner.markdown.split(LEARNER_SETUP_NOTE).length - 1, 1);
  for (const needle of ["How to check", "US Government limits for AI Builder", "Deploy sample apps and data", "ai-builder-sample-data", "Prompt models are available"]) {
    assert.ok(!learner.markdown.includes(needle), `the learner guide does not say "${needle}"`);
  }
});

test("a lab saved before this change, with the removed module and its saved administrator model, still opens and exports and is not rewritten", async () => {
  const root = tmp("ppai-legacy-");
  const built = await build({ level: 100, features: ["ppai-prebuilt-sentiment-analysis"] }, root);
  const manifestPath = join(built.outputDir, "manifest.json");
  const indexPath = join(built.outputDir, "index.md");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  // The saved administrator model is kept as it was written, so it has none of the new items.
  manifest.adminPrerequisites.environmentSettings = manifest.adminPrerequisites.environmentSettings.filter((i) => !i.id.startsWith("ai-builder-"));
  const template = manifest.modules.find((m) => m.id === "ppai-prebuilt-sentiment-analysis");
  const old = { ...template, id: REGION_LAB, name: "Check regional availability and environment prerequisites", order: manifest.modules.length + 1, stepOrder: manifest.modules.length + 1, stepLabel: `Step ${manifest.modules.length + 1}` };
  for (const key of ["fileBaseName", "docxFileName", "pptxFileName", "docxPath", "pptxPath"]) delete old[key];
  manifest.modules.push(old);
  manifest.request = { ...manifest.request, features: [REGION_LAB, ...(manifest.request?.features || [])] };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  writeFileSync(
    indexPath,
    `${readFileSync(indexPath, "utf8").trimEnd()}\n\n### Step ${old.stepOrder} - Check regional availability and environment prerequisites\n\n1. Note the region of the environment you will use.\n2. Open Feature availability by region and find your region.\n`,
  );
  const before = { manifest: readFileSync(manifestPath, "utf8"), index: readFileSync(indexPath, "utf8") };

  assert.equal(readGeneratedLab(root, built.labId).status, 200);
  for (const render of [renderGeneratedLabMarkdown, renderGeneratedLabHtml, renderGeneratedLabDocx, renderGeneratedLabPptx, renderGeneratedLabPdf]) {
    assert.equal(render(root, built.labId).status, 200, render.name);
  }
  for (const format of ["md", "docx", "pdf", "html"]) {
    assert.equal(renderGeneratedLabAdminGuide(root, built.labId, format).status, 200, `admin guide ${format}`);
    assert.equal(renderGeneratedLabPrerequisites(root, built.labId, format).status, 200, `prerequisites ${format}`);
  }
  const guide = renderGeneratedLabAdminGuide(root, built.labId, "md");
  assert.ok(!/AI Builder models are available in the environment's region/.test(guide.text), "the saved model has no new item: older labs simply do not show them");
  const chunks = [];
  const sink = new Writable({ write(chunk, _enc, done) { chunks.push(chunk); done(); } });
  const summary = await exportGeneratedLab(root, built.labId, {}, sink, { formats: "all" });
  assert.ok(summary.entryCount > 10 && summary.longestEntry <= 100);

  // The wizard drops the removed id with a warning instead of failing.
  const selections = selectionsFromManifest(JSON.parse(before.manifest));
  assert.ok(selections.features.includes(REGION_LAB));
  const rec = recommend({ products: [PRODUCT], level: 100, selected: selections.features });
  assert.ok(rec.warnings.some((w) => w.includes(REGION_LAB)), "an unknown topic is ignored with a warning");
  assert.ok(!rec.selectedIds.includes(REGION_LAB));

  assert.equal(readFileSync(manifestPath, "utf8"), before.manifest, "manifest.json is not rewritten");
  assert.equal(readFileSync(indexPath, "utf8"), before.index, "index.md is not rewritten");
});
