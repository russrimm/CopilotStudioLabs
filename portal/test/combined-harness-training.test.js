/**
 * Training for a lab that covers two harnesses: the complete deck, the foundations deck, and the topic decks teach each
 * idea once, in sections (shared foundations, the first harness, the second harness), with "Same idea, different place"
 * slides where both harnesses have their own version. Also: the minutes add up, the facilitator guide's agenda matches
 * the deck's, the ZIP and its README say which harness each part is for, and the duplication guard.
 *
 * Offline and synthetic: no Microsoft Learn, no model, no network, nothing from a real tenant.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import { generateLab } from "../lib/lab-builder/generator.js";
import { getConcepts } from "../lib/lab-builder/concepts.js";
import { getDifference } from "../lib/lab-builder/differences.js";
import { buildFacilitatorGuideModel } from "../lib/lab-builder/facilitator-guide.js";
import { planLab } from "../lib/lab-builder/planner.js";
import { exportGeneratedLab } from "../lib/exporter.js";
import { auditEntryPaths, resolveExportBudget } from "../lib/export-names.js";
import { TRAINING_ZIP_FOLDER, buildTrainingPlan, estimateLabTrainingMinutes } from "../lib/lab-builder/training-plan.js";
import { guardDeckSpec, planDecks, summarizePlan } from "../lib/lab-builder/training-decks.js";
import { renderTrainingDeck } from "../lib/lab-builder/training-pptx.js";
import { buildCompleteDeck } from "../lib/lab-builder/training-slides.js";
import { bodySimilarity, dropDuplicateSlides, findDuplicateSlides, slideFingerprint } from "../lib/lab-builder/training-duplicates.js";
import { findLabStepLeaks } from "../lib/lab-builder/training-guard.js";
import { readZipStrict } from "../../tools/lab-builder/lib/ooxml-strict.mjs";

process.env.LAB_BUILDER_LINK_CHECK = "off";

const BUDGET = resolveExportBudget({});
const MIXED = ["mc-harness-choice", "dlp-governance", "create-agent", "agent-instructions", "knowledge-sharepoint", "mc-create-agent", "mc-instructions", "mc-knowledge", "mc-memory", "alm-solutions"];
const BOTH = { harnessMode: "both", products: ["copilot-studio"], industry: "retail", includeKnowledgeCheck: false };
const offline = { write: false, useLearnMcp: false, useLlm: false };
const cleanups = [];

const sum = (list, pick = (x) => x) => list.reduce((total, item) => total + (pick(item) || 0), 0);
const kinds = (slides) => slides.map((s) => s.kind);

async function combinedLab(features = MIXED, extra = {}) {
  const result = await generateLab({ ...BOTH, features, ...extra }, offline);
  const plan = buildTrainingPlan({ markdown: result.markdown, manifest: result.manifest, labId: "combined-sample" });
  const decks = planDecks(plan);
  const byKey = (key) => decks.find((d) => d.descriptor.key === key);
  return { result, plan, decks, complete: byKey("complete").spec, byKey };
}

/**
 * What the owner would get today without the option: one single-harness lab for each harness, with the topics that apply
 * to both in each of them. Their complete decks stitched together are the "concatenated" baseline.
 */
async function singleHarnessBaseline() {
  const shared = ["mc-harness-choice", "dlp-governance", "alm-solutions"];
  const standardOnly = ["create-agent", "agent-instructions", "knowledge-sharepoint"];
  const copilotOnly = ["mc-create-agent", "mc-instructions", "mc-knowledge", "mc-memory"];
  const build = async (harness, features) => {
    const r = await generateLab({ products: ["copilot-studio"], industry: "retail", includeKnowledgeCheck: false, harness, features }, offline);
    const plan = buildTrainingPlan({ markdown: r.markdown, manifest: r.manifest, labId: `${harness}-baseline` });
    return { plan, slides: buildCompleteDeck(plan).slides.length };
  };
  return { standard: await build("standard", [...shared, ...standardOnly]), copilot: await build("microsoft-copilot", [...shared, ...copilotOnly]) };
}

test("the complete deck has sections in order, a divider for each, and an agenda that lists them with minutes", async () => {
  const { plan, complete } = await combinedLab();
  assert.deepEqual(complete.sections.map((s) => s.name), ["Shared foundations", "Standard (Classic) harness", "Microsoft Copilot harness", "Shared wrap-up", "Check, key terms, and next steps"]);
  assert.deepEqual(complete.sections.map((s) => s.type), ["shared", "harness", "harness", "wrap", "wrap"]);

  const dividers = complete.slides.filter((s) => s.kind === "divider");
  assert.deepEqual(dividers.map((s) => s.title), complete.sections.map((s, i) => `Part ${i + 1} of ${complete.sections.length}: ${s.name}`));
  assert.ok(dividers.every((s) => s.title.length <= 60), "divider titles are short");

  const agenda = complete.slides.find((s) => s.kind === "agenda");
  assert.equal(agenda.title, "Agenda: both harnesses");
  assert.deepEqual(agenda.body.rows.map((r) => [r.label, r.minutes]), complete.sections.map((s) => [s.name, s.minutes]));
  assert.equal(agenda.body.totalMinutes, complete.minutes);

  // The slides run title, agenda, then each divider followed by its section, then the closing slide.
  const order = complete.slides.map((s) => s.kind);
  assert.deepEqual(order.slice(0, 3), ["title", "agenda", "divider"]);
  assert.equal(order.at(-1), "closing");
  assert.deepEqual(complete.slides.filter((s) => s.section).map((s) => s.section), [...complete.slides.filter((s) => s.section)].map((s) => s.section).sort((a, b) => a - b), "slides stay in section order");

  // Each harness section holds only its own topics (a shared topic is in a shared section).
  const titles = (section) => complete.slides.filter((s) => s.kind === "title" && s.section === section).map((s) => s.title);
  assert.ok(titles(1).includes("Choose a harness: standard or Microsoft Copilot") || titles(1).some((t) => /^Choose a harness/.test(t)));
  assert.ok(titles(2).every((t) => !/\(Microsoft Copilot\)/.test(t)), "no Microsoft Copilot topic in the Standard part");
  assert.deepEqual(plan.combined.parts.map((p) => p.id), ["shared", "standard", "microsoft-copilot", "shared-late"]);
});

test("no deck repeats a slide: every title is unique, the duplication guard finds nothing, and shared slides appear once", async () => {
  const { decks, complete, plan } = await combinedLab();
  for (const { descriptor, spec } of decks) {
    const titles = spec.slides.map((s) => s.title);
    assert.equal(new Set(titles).size, titles.length, `${descriptor.key}: no two slides share a title`);
    assert.deepEqual(findDuplicateSlides(spec.slides), [], `${descriptor.key}: no two slides share a body`);
  }

  // A shared topic is taught once, in the shared section, and never again in a harness part.
  const sharedTitle = plan.topics.find((t) => t.id === "dlp-governance").title;
  assert.equal(complete.slides.filter((s) => s.kind === "title" && s.title === sharedTitle).length, 1);
  assert.equal(complete.slides.filter((s) => s.section === 1 && s.kind === "title" && s.title === sharedTitle).length, 1);

  // The knowledge check, key terms, Learn links, and the lab preview are each said once, at the end.
  const wrap = complete.sections.findIndex((s) => s.name === "Check, key terms, and next steps") + 1;
  for (const kind of ["quiz", "terms", "learn"]) {
    const slides = complete.slides.filter((s) => s.kind === kind);
    assert.ok(slides.length >= 1, `${kind}: there is one set`);
    assert.ok(slides.every((s) => s.section === wrap), `${kind}: only in the closing section`);
  }
  assert.equal(complete.slides.filter((s) => s.kind === "labPreview").length, 0, "no per-topic lab previews");
  assert.equal(complete.slides.filter((s) => s.kind === "closing").length, 1, "one what-you-will-do-next slide");
  const questions = complete.slides.filter((s) => s.kind === "quiz").flatMap((s) => s.body.questions.map((q) => q.q));
  assert.equal(new Set(questions).size, questions.length, "no question is asked twice");
  const terms = complete.slides.filter((s) => s.kind === "terms").flatMap((s) => s.body.items.map((i) => i.term));
  assert.equal(new Set(terms).size, terms.length, "no word is defined twice");
  assert.equal(complete.slides.filter((s) => s.kind === "vocab").length, 0, "the shared vocabulary joins the one key-terms set");
});

test("where both harnesses have their own version of an idea, one 'Same idea, different place' slide shows them side by side", async () => {
  const { complete, plan } = await combinedLab();
  const compares = complete.slides.filter((s) => s.kind === "compare");
  const concepts = [...new Set(plan.topics.filter((t) => t.coveredEarlier && t.coveredEarlier.harness && t.harness && t.coveredEarlier.harness !== t.harness).map((t) => t.conceptId))];
  assert.deepEqual(compares.map((s) => s.body.concept), concepts.map((id) => getConcepts().find((c) => c.id === id).name), "one slide for each idea both harnesses teach");
  const names = compares.map((s) => s.title);
  assert.equal(new Set(names).size, names.length, "each comparison is shown once");
  for (const slide of compares) {
    assert.match(slide.title, /^Same idea, different place: .+/);
    assert.ok(slide.title.length <= 60, `${slide.title} is short`);
    assert.equal(slide.section, 3, "the comparison opens the second harness's version, in the second harness's part");
    const [first, second] = slide.body.columns;
    assert.deepEqual([first.name, second.name], ["Standard (Classic)", "Microsoft Copilot"], "the first harness is on the left");
    assert.ok(first.term && second.term && first.availability && second.availability);
    assert.ok(slide.sources.length > 0 && slide.checkedOn, "it carries the Microsoft Learn sources and the date they were checked");
    assert.ok(slide.notes.some((n) => /^SOURCE: .+https:\/\/learn\.microsoft\.com\//.test(n)));
    assert.deepEqual(findLabStepLeaks(slide.texts.join("\n")), [], "no lab step or click path");
  }
  // The words come from the curated record, not from anywhere else.
  const knowledge = compares.find((s) => s.body.concept === "Knowledge");
  assert.ok(knowledge.body.columns[1].summary.includes(getDifference("knowledge").harnesses["microsoft-copilot"].summary.split(". ")[0].slice(0, 40)));

  // The second version has no repeated "what is it" or "why it matters" slides, but keeps what is specific to the harness.
  const second = plan.topics.find((t) => t.id === "mc-create-agent");
  const slidesOf = (title) => complete.slides.filter((s) => s.section === 3 && typeof s.title === "string" && s.title.endsWith(`: ${title}`));
  assert.equal(slidesOf(second.short).filter((s) => ["scenario", "definition"].includes(s.kind)).length, 0);
  assert.ok(slidesOf(second.short).some((s) => s.kind === "blocks"));
});

test("the minutes are never counted twice: the plan, the deck, its sections, and the lab's estimate all agree", async () => {
  const { result, plan, decks, complete } = await combinedLab();
  assert.equal(sum(complete.slides, (s) => s.minutes), complete.minutes, "the deck's minutes are the sum of its slides");
  assert.equal(complete.minutes, plan.totalMinutes, "the deck's minutes are the plan's");
  assert.equal(sum(complete.sections, (s) => s.minutes), complete.minutes, "the sections add up to the deck");
  assert.equal(sum(plan.foundations, (f) => f.minutes) + sum(plan.topics, (t) => t.minutes), plan.totalMinutes);
  for (const { descriptor, spec } of decks) assert.equal(sum(spec.slides, (s) => s.minutes), descriptor.minutes, `${descriptor.key}: the slides add up to the deck`);
  assert.equal(estimateLabTrainingMinutes(result.plan).total, plan.totalMinutes, "the training minutes the lab quotes are the deck's");
  assert.ok(complete.slides.every((s) => Number.isInteger(s.minutes) && s.minutes >= 0));

  // An idea taught earlier takes a short deck, so a lab with both harnesses is shorter than two single-harness labs.
  const covered = plan.topics.filter((t) => t.coveredEarlier);
  assert.ok(covered.length >= 3 && covered.every((t) => t.minutes <= 12));
  const { standard, copilot } = await singleHarnessBaseline();
  assert.ok(plan.totalMinutes < standard.plan.totalMinutes + copilot.plan.totalMinutes, `${plan.totalMinutes} < ${standard.plan.totalMinutes} + ${copilot.plan.totalMinutes}`);
});

test("the facilitator guide's pre-lab minutes and agenda are the deck's", async () => {
  const root = mkdtempSync(join(tmpdir(), "combined-facilitator-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const built = await generateLab({ ...BOTH, features: MIXED }, { outputRoot: root, useLearnMcp: false, useLlm: false });
  const model = buildFacilitatorGuideModel(built.outputDir);
  const plan = buildTrainingPlan({ markdown: built.markdown, manifest: built.manifest, labId: built.labId, outputDir: built.outputDir });
  const complete = buildCompleteDeck(plan);

  assert.equal(model.harness, null);
  assert.match(model.harnessLabel, /^Both, one after another: Standard \(Classic\) harness, then Microsoft Copilot harness$/);
  assert.equal(model.preLab.totalMinutes, complete.minutes);
  assert.equal(sum(model.preLab.rows, (r) => r.trainingMinutes), model.preLab.totalMinutes, "the table's rows add up to its total");
  assert.deepEqual(model.preLab.sections.map((s) => [s.label, s.minutes]), complete.sections.map((s) => [s.name, s.minutes]), "the agenda is the deck's agenda");
  assert.equal(sum(model.preLab.sections, (s) => s.minutes), model.preLab.totalMinutes);
  assert.ok(model.preLab.rows.filter((r) => r.kind === "topic").every((r) => r.partLabel), "every topic row says which part it is in");
  assert.equal(model.pacing.totalWithTrainingMinutes, model.preLab.totalMinutes + model.pacing.totalWorkshopMinutes);
  assert.ok(model.modules.length > 0);
});

test("the ZIP keeps every path in the budget, orders the training folder by section, and its README lists the harness of each part", async () => {
  const root = mkdtempSync(join(tmpdir(), "combined-zip-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const built = await generateLab({ ...BOTH, features: MIXED }, { outputRoot: root, useLearnMcp: false, useLlm: false });
  const chunks = [];
  const sink = new Writable({ write(chunk, _enc, done) { chunks.push(chunk); done(); } });
  await exportGeneratedLab(root, built.labId, {}, sink, { formats: "docx,pptx" });
  const zip = readZipStrict(Buffer.concat(chunks), { opc: false });
  assert.deepEqual(zip.problems, []);
  const names = [...zip.entries.keys()];
  assert.deepEqual(auditEntryPaths(names, { budget: BUDGET }), [], "every path is within the budget and safe on Windows");
  assert.ok(Math.max(...names.map((n) => n.length)) <= 100, "no entry is longer than 100 characters");

  const training = names.filter((n) => n.startsWith(`${TRAINING_ZIP_FOLDER}/`) && n.endsWith(".pptx"));
  assert.ok(training.length >= 4);
  assert.deepEqual([...training].sort((a, b) => a.localeCompare(b, "en", { numeric: true })), training.sort((a, b) => a.localeCompare(b, "en", { numeric: true })));

  const readme = zip.entries.get("README.md").toString("utf8");
  assert.match(readme, /This package covers two harnesses, so every idea is taught once and the decks run in this order: Shared foundations, then Standard \(Classic\) harness, then Microsoft Copilot harness, then Shared wrap-up\./);
  assert.match(readme, /\| Folder \| Step \| Harness \| Full title \| Minutes \| Files \|/, "the modules table has a Harness column");
  for (const label of ["Standard (Classic) harness", "Microsoft Copilot harness", "Works in either harness"]) assert.ok(readme.includes(`| ${label} |`), `the README lists ${label}`);
  assert.match(readme, /\| File \| What it is \| Harness \| Full title \| Minutes \|/, "the other-files table says which harness each deck is for");
  assert.match(readme, /Training deck \(complete\) \| Both harnesses: Standard \(Classic\) harness, then Microsoft Copilot harness \|/);
  assert.match(readme, /^\d+\. .*\((Standard \(Classic\) harness|Microsoft Copilot harness|Works in either harness)\)$/m, "the module list names the harness");

  const manifest = JSON.parse(zip.entries.get("export-manifest.json").toString("utf8"));
  assert.ok(manifest.index.some((row) => row.harness === "Standard (Classic) harness") && manifest.index.some((row) => row.harness === "Microsoft Copilot harness"));
  assert.ok(manifest.modules.every((m) => m.harnessPart && "harnessLabel" in m));
  assert.ok(manifest.trainingDecks.every((d) => "part" in d || d.kind === "complete" || d.kind === "foundations"));
});

test("the duplication guard: two identical slides, a repeated title, or near-identical bodies fail a build in tests and are dropped in production", () => {
  const slide = (title, text, extra = {}) => ({ kind: "blocks", title, body: { nodes: [{ label: "One", plain: text }] }, minutes: 2, ...extra });
  const text = "An agent is a set of instructions, knowledge, and tools that work together to answer questions for the people who use it every day.";
  const a = slide("The building blocks: Create an agent", text);

  assert.deepEqual(findDuplicateSlides([a, { ...a }]).map((d) => [d.index, d.of, d.reason]), [[1, 0, "title"]], "two identical slides");
  assert.deepEqual(findDuplicateSlides([a, slide("Same blocks, other title", text)]).map((d) => [d.index, d.reason]), [[1, "body"]], "the same body under a new title");
  assert.deepEqual(findDuplicateSlides([a, slide("Close copy", `${text} It starts here.`)]).map((d) => d.reason), ["body"], "a near-identical body");
  assert.deepEqual(findDuplicateSlides([a, slide("Different slide", "Knowledge is what the agent reads before it answers, such as documents, websites, and tables of records, which you choose.")]), []);
  assert.equal(findDuplicateSlides([slide("Key terms (1 of 2)", text), slide("Key terms (2 of 2)", "A different set of words entirely, each one explained in a sentence of its own for the room to read aloud.")]).length, 0, "numbered parts of a series may share a title shape");
  assert.deepEqual(findDuplicateSlides([{ kind: "agenda", title: "Agenda", body: { rows: [{ label: "A" }] } }, { kind: "divider", title: "Part 1 of 1: A", body: { rows: [{ label: "A" }] } }]), [], "a divider shows the agenda by design");
  assert.ok(bodySimilarity(text, text) === 1 && bodySimilarity(text, "something else completely different here and there") < 0.2);
  assert.equal(slideFingerprint(a).title, "the building blocks create an agent");

  // In production the later slide goes, the minutes move to the slide before it, and a warning is logged.
  const warnings = [];
  const { slides, dropped } = dropDuplicateSlides([a, { ...a, minutes: 3 }], { warn: (m) => warnings.push(m), label: "deck" });
  assert.equal(slides.length, 1);
  assert.equal(slides[0].minutes, 5, "the dropped slide's minutes are kept");
  assert.equal(dropped.length, 1);
  assert.match(warnings[0], /dropped slide "The building blocks: Create an agent" because it repeats slide 1/);

  // guardDeckSpec: a build fails under node --test, and drops with a warning otherwise.
  const spec = { slides: [a, { ...a }], minutes: 4 };
  assert.throws(() => guardDeckSpec(spec, "Sample deck"), /repeats a slide/);
  const inTest = process.env.NODE_TEST_CONTEXT;
  const warn = console.warn;
  const logged = [];
  delete process.env.NODE_TEST_CONTEXT;
  console.warn = (m) => logged.push(m);
  try {
    const kept = guardDeckSpec(spec, "Sample deck");
    assert.equal(kept.slides.length, 1);
    assert.equal(logged.length, 1);
  } finally {
    process.env.NODE_TEST_CONTEXT = inTest;
    console.warn = warn;
  }
});

test("how many slides: two single-harness decks stitched together versus the one de-duplicated combined deck", async (t) => {
  const { complete } = await combinedLab();
  const { standard, copilot } = await singleHarnessBaseline();
  const concatenated = standard.slides + copilot.slides;
  t.diagnostic(`Standard deck ${standard.slides} slides + Microsoft Copilot deck ${copilot.slides} slides = ${concatenated} concatenated; the combined deck has ${complete.slides.length}.`);
  assert.ok(complete.slides.length < concatenated, `${complete.slides.length} < ${concatenated}`);
  assert.ok(complete.slides.length < Math.max(standard.slides, copilot.slides) + 0.5 * Math.min(standard.slides, copilot.slides), "the combined deck is far from the sum of the two");
});

test("a single-harness lab's decks, summary, and descriptors are exactly what they were: no parts, no harness fields", async () => {
  const result = await generateLab({ features: ["create-agent", "knowledge-sharepoint", "mc-harness-choice"], harness: "standard", products: ["copilot-studio"] }, offline);
  const plan = buildTrainingPlan({ markdown: result.markdown, manifest: result.manifest, labId: "single-sample" });
  assert.equal(plan.combined, null);
  assert.equal(plan.harness, "standard");
  const decks = planDecks(plan);
  assert.ok(decks.every((d) => !("partId" in d.descriptor) && !("harness" in d.descriptor) && !("sections" in d.descriptor)));
  assert.ok(!("combined" in summarizePlan(plan, decks.map((d) => d.descriptor))));
  const complete = decks.find((d) => d.descriptor.key === "complete").spec;
  assert.ok(!complete.combined && complete.slides.some((s) => s.kind === "labPreview"), "the single-harness complete deck still has its per-topic slides");
  assert.ok(!decks.some((d) => d.spec.slides.some((s) => s.kind === "compare")));

  // The combined layout is part of the fingerprint of a combined lab only.
  const first = await combinedLab(MIXED);
  const swapped = await generateLab({ ...BOTH, harnesses: ["microsoft-copilot", "standard"], features: MIXED }, offline);
  const swappedPlan = buildTrainingPlan({ markdown: swapped.markdown, manifest: swapped.manifest, labId: "combined-sample" });
  assert.notEqual(first.plan.fingerprint, swappedPlan.fingerprint, "a different order rebuilds the decks");
});

test("the decks of a combined lab render to clean PowerPoint files with no overflow on the new slides", async () => {
  const { decks } = await combinedLab();
  for (const { descriptor, spec } of decks) {
    const { buffer, overflow } = renderTrainingDeck(spec);
    assert.ok(buffer.length > 1500, `${descriptor.key} is a real package`);
    const zip = readZipStrict(buffer);
    assert.deepEqual(zip.problems, [], `${descriptor.key}: a clean OOXML package`);
    const mine = overflow.filter((o) => /Same idea, different place|Part \d of \d|Agenda: both/.test(o.slide));
    assert.deepEqual(mine, [], `${descriptor.key}: the comparison, divider, and agenda slides fit`);
  }
  assert.ok(planLab({ harnessMode: "both", products: ["copilot-studio"], features: MIXED }).harnessParts.parts.length >= 3);
});

test("cleanup", () => {
  for (const clean of cleanups.reverse()) clean();
});
