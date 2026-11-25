/**
 * Pre-lab training decks: the deck for every module and recap, the foundations decks, and the complete deck.
 * The labs are built offline into a throwaway folder (fictional names only). The decks are read back from the real
 * PowerPoint files (slide text, speaker notes, alt text), so what is asserted is what a presenter would get.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import { buildFacilitatorGuideModel, renderFacilitatorGuideMarkdown } from "../lib/lab-builder/facilitator-guide.js";
import { buildAdminPrerequisites } from "../lib/lab-builder/admin-prereqs.js";
import { getConcepts } from "../lib/lab-builder/concepts.js";
import { getProducts } from "../lib/lab-builder/products.js";
import { findTermsInText, checkTrainingLibrary, loadTrainingLibrary } from "../lib/lab-builder/training-library.js";
import { findLabStepLeaks } from "../lib/lab-builder/training-guard.js";
import { averageGrade } from "../lib/lab-builder/training-text.js";
import { TRAINING_MINUTES, TRAINING_SCHEMA_VERSION, buildTrainingPlan, formatTrainingDuration } from "../lib/lab-builder/training-plan.js";
import { TRAINING_STATE_FILE, ensureGeneratedLabTrainingDecks, planDecks, readCachedTrainingDeck, renderTrainingDeckBuffer, writeFileAtomic } from "../lib/lab-builder/training-decks.js";
import { renderTrainingDeck } from "../lib/lab-builder/training-pptx.js";
import { checkPptxPackage } from "../../tools/lab-builder/lib/ooxml-strict.mjs";
import { SAMPLE_LABS, adminMarkerList, buildSampleLabs, findAdminLeaks, readDeck } from "./fixtures/training-labs.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const cleanups = [];
const ctx = {};

/** Everything the tests need about one built lab: its files, its plan, and every deck read back from PowerPoint. */
function inspect(dir) {
  const markdown = readFileSync(join(dir, "index.md"), "utf8");
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const plan = buildTrainingPlan({ markdown, manifest, labId: manifest.labId || "lab", outputDir: dir });
  const decks = planDecks(plan).map((d) => {
    const { buffer, overflow } = renderTrainingDeck(d.spec, {});
    return { ...d, buffer, overflow, read: readDeck(buffer) };
  });
  return { dir, markdown, manifest, plan, decks };
}

const deckText = (deck) => deck.read.slides.flatMap((s) => [...s.lines, ...s.notes]);
const topicDecks = (lab) => lab.decks.filter((d) => d.descriptor.kind === "topic");

before(async () => {
  ctx.built = await buildSampleLabs();
  cleanups.push(ctx.built.cleanup);
  ctx.labs = {};
  for (const [name, entry] of Object.entries(ctx.built.labs)) ctx.labs[name] = inspect(entry.outputDir);
});

after(() => {
  for (const clean of cleanups.reverse()) clean();
});

function copyLab(name) {
  const root = mkdtempSync(join(tmpdir(), "training-copy-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "lab");
  cpSync(ctx.labs[name].dir, dir, { recursive: true });
  return dir;
}

test("the curated training library is complete and plain", () => {
  const problems = checkTrainingLibrary(loadTrainingLibrary(), { conceptIds: getConcepts().map((c) => c.id), productIds: getProducts().map((p) => p.id) });
  assert.deepEqual(problems, []);
});

test("every module and recap gets a deck, with one foundations deck per product and a complete deck, named to sort in teaching order", () => {
  for (const [name, lab] of Object.entries(ctx.labs)) {
    const keys = lab.decks.map((d) => d.descriptor.key);
    const topics = topicDecks(lab);
    assert.equal(topics.length, lab.manifest.modules.length, `${name}: one deck per module and recap`);
    assert.deepEqual(topics.map((d) => d.descriptor.key), lab.manifest.modules.map((_, i) => String(i + 1)));
    assert.equal(lab.decks.filter((d) => d.descriptor.kind === "foundations").length, lab.manifest.request.products.length, `${name}: foundations per product`);
    assert.ok(keys.includes("complete"), `${name}: the complete deck`);
    const sorted = lab.decks.map((d) => d.descriptor.fileName).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
    assert.deepEqual(
      sorted,
      [...lab.decks.filter((d) => d.descriptor.kind === "foundations"), ...lab.decks.filter((d) => d.descriptor.kind === "complete"), ...topics].map((d) => d.descriptor.fileName),
      `${name}: foundations, then the complete deck, then topics in order`,
    );
  }
  const names = ctx.labs.level200.decks.map((d) => d.descriptor.fileName);
  assert.ok(names.includes("Training deck - Complete.pptx"));
  assert.ok(names.some((n) => /^Training deck - 00 Foundations - Copilot Studio\.pptx$/.test(n)));
  assert.ok(names.some((n) => /^Training deck - Module 03 - Generative orchestration\.pptx$/.test(n)));
});

test("each topic deck follows the storyline within the slide, time, and note limits", () => {
  const order = ["title", "scenario", "definition", "needToKnow?", "blocks", "flow", "example", "fit", "know", "terms+", "quiz", "labPreview", "learn"];
  let checked = 0;
  for (const [name, lab] of Object.entries(ctx.labs)) {
    for (const deck of topicDecks(lab)) {
      const { descriptor, spec, read } = deck;
      const label = `${name} ${descriptor.fileName}`;
      assert.equal(read.problems.length, 0, label);
      assert.equal(read.slides.length, spec.slides.length, `${label}: slide count`);
      const titles = read.slides.map((s) => s.title);
      assert.equal(new Set(titles).size, titles.length, `${label}: unique slide titles`);
      assert.ok(titles.every(Boolean), `${label}: every slide has a real title`);
      for (const slide of read.slides) {
        assert.ok(slide.notes.some((l) => /^TIME: about \d+ minutes?\.$/.test(l)), `${label} slide ${slide.number}: notes give the time`);
        assert.ok(slide.notes.some((l) => /^(SAY|EXAMPLE TO SAY OUT LOUD): /.test(l)), `${label} slide ${slide.number}: notes have a talk track`);
        assert.ok(slide.lines.length <= 45 && slide.lines.join(" ").split(/\s+/).length <= 240, `${label} slide ${slide.number}: not a text wall`);
      }
      if (descriptor.thin) continue;
      checked += 1;
      const pattern = new RegExp(`^${order.map((k) => (k.endsWith("?") ? `(?:${k.slice(0, -1)},)?` : k.endsWith("+") ? `(?:${k.slice(0, -1)},){1,2}` : `${k},`)).join("")}$`);
      assert.match(`${spec.slides.map((s) => s.kind).join(",")},`, pattern, `${label}: storyline`);
      assert.ok(spec.slides.length >= 10 && spec.slides.length <= 14, `${label}: ${spec.slides.length} slides`);
      assert.equal(spec.minutes, descriptor.kind === "topic" && lab.plan.topics[Number(descriptor.key) - 1].isRecap ? TRAINING_MINUTES.refresher : TRAINING_MINUTES.topic, `${label}: minutes`);
      assert.ok(spec.minutes >= 20 && spec.minutes <= 30);
      const quiz = spec.slides.findIndex((s) => s.kind === "quiz");
      assert.ok(read.slides[quiz].notes.filter((l) => /^ANSWER \d/.test(l)).length >= 3, `${label}: answers are in the notes`);
      assert.ok(read.slides[spec.slides.length - 1].lines.some((l) => /^https:\/\/learn\.microsoft\.com\//.test(l) || /learn\.microsoft\.com/.test(l)), `${label}: Microsoft Learn links`);
    }
  }
  assert.ok(checked >= 20, "many decks were checked");
});

test("no deck carries lab steps, administrator settings, identifiers, or screenshot cards", () => {
  for (const [name, lab] of Object.entries(ctx.labs)) {
    const admin = lab.manifest.adminPrerequisites || buildAdminPrerequisites({ manifest: lab.manifest, markdown: lab.markdown });
    const markers = adminMarkerList(admin);
    for (const deck of lab.decks) {
      const label = `${name} ${deck.descriptor.fileName}`;
      const text = deckText(deck).join("\n");
      assert.deepEqual(findLabStepLeaks(text), [], `${label}: lab steps or click paths`);
      assert.deepEqual(findAdminLeaks(text, markers), [], `${label}: administrator settings`);
      assert.doesNotMatch(text, /Screenshot to add|Answer Key|Run-of-Show/i, label);
      assert.doesNotMatch(text, GUID, `${label}: no GUID`);
      assert.doesNotMatch(text, /@(?!contoso\.|fabrikam\.)[a-z0-9-]+\.[a-z]{2,}/i, `${label}: no real address`);
      assert.doesNotMatch(text, /\.sharepoint\.com|\.crm\d*\.dynamics\.com/i, `${label}: no tenant host`);
    }
  }
});

test("slide text and notes read at a middle-school to early high-school level", () => {
  for (const [name, lab] of Object.entries(ctx.labs)) {
    for (const deck of lab.decks) {
      const label = `${name} ${deck.descriptor.fileName}`;
      const slideText = deck.read.slides.flatMap((s) => s.lines);
      const notes = deck.read.slides.flatMap((s) => s.notes.filter((l) => /^(SAY|EXAMPLE TO SAY OUT LOUD|ASK THE ROOM): /.test(l)).map((l) => l.replace(/^[A-Z ]+: /, "")));
      assert.ok(averageGrade(slideText) <= 10, `${label}: slide grade ${averageGrade(slideText).toFixed(1)}`);
      assert.ok(averageGrade(notes) <= 10, `${label}: notes grade ${averageGrade(notes).toFixed(1)}`);
    }
  }
});

test("a term is defined on the slide where it first appears, and never defined again in the complete deck", () => {
  const library = loadTrainingLibrary();
  for (const name of ["level100", "level200", "copilotHarness", "foundry"]) {
    const lab = ctx.labs[name];
    for (const deck of lab.decks.filter((d) => d.descriptor.kind !== "complete")) {
      const seen = new Set();
      const undefinedTerms = [];
      deck.spec.slides.forEach((slide, i) => {
        for (const id of slide.words || []) seen.add(id);
        for (const id of slide.vocabIds || []) seen.add(id);
        // Learn links name pages by their own titles, and the key terms and vocabulary slides are where terms are defined.
        if (["learn", "terms", "vocab"].includes(slide.kind)) return;
        const listed = new Set();
        // The "word to know" lines are where a term is defined, so a name inside a definition is not a use.
        const used = deck.read.slides[i].lines.filter((l) => !/ — /.test(l));
        for (const hit of findTermsInText([slide.title, ...used].join("\n"), library, { listed })) {
          if (!seen.has(hit.id)) undefinedTerms.push(`${hit.id} on slide ${i + 1}`);
        }
      });
      assert.deepEqual(undefinedTerms, [], `${name} ${deck.descriptor.fileName}`);
    }
    const complete = lab.decks.find((d) => d.descriptor.kind === "complete");
    const defined = complete.spec.slides.flatMap((s) => s.words || []);
    assert.deepEqual(defined.filter((id, i) => defined.indexOf(id) !== i), [], `${name}: no term is defined twice in the complete deck`);
    const listedTerms = complete.spec.slides.filter((s) => s.kind === "terms").flatMap((s) => s.body.items.map((item) => item.term));
    assert.deepEqual(listedTerms.filter((t, i) => listedTerms.indexOf(t) !== i), [], `${name}: no key term is listed twice`);
  }
});

test("the complete deck has an agenda with the total time, a divider per section, and points back instead of repeating itself", () => {
  const lab = ctx.labs.level300;
  const complete = lab.decks.find((d) => d.descriptor.kind === "complete");
  const kinds = complete.spec.slides.map((s) => s.kind);
  assert.equal(kinds[0], "title");
  assert.equal(kinds[1], "agenda");
  assert.equal(kinds.at(-1), "closing");
  const dividers = complete.spec.slides.filter((s) => s.kind === "divider");
  assert.equal(dividers.length, lab.decks.length - 1, "a divider for each foundations part and each topic");
  const agendaText = complete.read.slides[1].lines.join(" ");
  assert.match(agendaText, new RegExp(`${complete.spec.minutes} minutes`), "the total time is on the agenda");
  assert.equal(complete.spec.minutes, lab.plan.totalMinutes);
  const titles = complete.read.slides.map((s) => s.title);
  assert.equal(new Set(titles).size, titles.length, "unique slide titles in the one file");
  const topicSlides = lab.decks.filter((d) => d.descriptor.kind === "topic").reduce((sum, d) => sum + d.spec.slides.length, 0);
  assert.ok(complete.spec.slides.length < topicSlides + 8 * lab.plan.foundations.length + dividers.length + 3, "repeated ideas are pointed back to, not repeated");
  assert.ok(complete.spec.slides.some((s) => s.kind === "adds"), "a repeated concept gets a short 'what this adds' slide");
});

test("a Level 300 topic explains the ideas it builds on, and a Level 100 topic does not need to", () => {
  const level300 = topicDecks(ctx.labs.level300).filter((d) => !ctx.labs.level300.plan.topics[Number(d.descriptor.key) - 1].isRecap);
  assert.ok(level300.length >= 1);
  for (const deck of level300) {
    const slide = deck.spec.slides.find((s) => s.kind === "needToKnow");
    assert.ok(slide, "the 'You will need to know' slide");
    assert.match(slide.title, /^You will need to know: /);
    assert.ok(slide.body.items.length >= 2 && slide.body.items.length <= 4);
    const prereqIds = ctx.labs.level300.plan.topics[Number(deck.descriptor.key) - 1].prereqConceptIds;
    assert.ok(prereqIds.length >= slide.body.items.length, "the items come from its prerequisite topics");
    assert.ok(slide.body.items.every((item) => item.head && item.text.length > 20));
  }
  const first = topicDecks(ctx.labs.level100)[0];
  assert.ok(!first.spec.slides.some((s) => s.kind === "needToKnow"), "the first topic of a Level 100 lab starts from nothing");
  const second = topicDecks(ctx.labs.level100)[1];
  assert.ok(second.spec.slides.some((s) => s.kind === "needToKnow"), "a later topic explains the earlier one it builds on, so no one needs the earlier deck");
});

test("a Learn-only topic gets the short deck, tells the presenter to review it, and is flagged in the list", () => {
  const lab = ctx.labs.learnOnly;
  const flagged = topicDecks(lab).filter((d) => d.descriptor.unreviewed);
  assert.equal(flagged.length, 1, "only the Learn-only topic is flagged");
  const deck = flagged[0];
  assert.equal(deck.descriptor.thin, true);
  assert.equal(deck.spec.minutes, TRAINING_MINUTES.short);
  assert.ok(deck.spec.slides.length >= 5 && deck.spec.slides.length < 10, "shorter, never padded");
  assert.match(deck.read.slides[0].notes.join("\n"), /^REVIEW FIRST: /m);
  assert.ok(!deck.spec.slides.some((s) => s.kind === "scenario" || s.kind === "blocks"), "no invented building blocks");
  for (const other of lab.decks.filter((d) => d !== deck && d.descriptor.kind === "topic")) assert.equal(other.descriptor.unreviewed, false, other.descriptor.fileName);
  const complete = lab.decks.find((d) => d.descriptor.kind === "complete");
  assert.ok(complete.read.slides.some((s) => s.notes.some((l) => /^REVIEW FIRST: /.test(l))), "the complete deck keeps the review note");
});

test("honest availability: a fact Learn cannot confirm is said so for the presenter", () => {
  const notes = ctx.labs.sharepointAi.decks.flatMap((d) => d.read.slides.flatMap((s) => s.notes)).join("\n");
  const text = ctx.labs.sharepointAi.decks.flatMap((d) => d.read.slides.flatMap((s) => s.lines)).join("\n");
  assert.match(`${text}\n${notes}`, /Not confirmed in Microsoft Learn/);
});

test("the brand profile colors, name, and footer are applied", () => {
  const { spec } = ctx.labs.level100.decks.find((d) => d.descriptor.kind === "topic");
  const branded = renderTrainingDeck(spec, { branding: { companyName: "Fabrikam Learning", primaryColor: "#0b3d91", secondaryColor: "#c43e1c", footerText: "Fabrikam internal training", font: "Calibri", logoBuffer: null } });
  const read = readDeck(branded.buffer);
  assert.deepEqual(checkPptxPackage(branded.buffer, { expectNotes: true }), []);
  const all = read.slides.map((s) => s.xml).join("\n");
  assert.match(all, /0B3D91/);
  assert.match(all, /Fabrikam internal training|Fabrikam Learning/);
  const plain = readDeck(renderTrainingDeck(spec, {}).buffer).slides.map((s) => s.xml).join("\n");
  assert.doesNotMatch(plain, /0B3D91/);
  assert.equal(branded.overflow.length, 0, "custom colors and fonts still fit");
});

test("every deck is a clean PowerPoint package with notes, no overflow, and alt text for each diagram", () => {
  for (const [name, lab] of Object.entries(ctx.labs)) {
    for (const deck of lab.decks) {
      const label = `${name} ${deck.descriptor.fileName}`;
      assert.deepEqual(checkPptxPackage(deck.buffer, { expectNotes: true }), [], label);
      assert.deepEqual(deck.overflow, [], `${label}: text fits its shape`);
      assert.ok(deck.read.zip.entries.has("ppt/theme/theme2.xml"), `${label}: the notes master keeps its own theme`);
      assert.match(deck.read.zip.entries.get("ppt/notesMasters/_rels/notesMaster1.xml.rels").toString("utf8"), /Target="\.\.\/theme\/theme2\.xml"/);
      assert.equal(deck.read.slides.filter((s) => s.notes.length === 0).length, 0, `${label}: notes on every slide`);
      for (const slide of deck.read.slides) {
        for (const group of slide.groups) assert.ok(group.descr.length >= 25, `${label} slide ${slide.number}: alt text for "${group.name}"`);
        for (const alt of slide.pictures) assert.ok(alt.length >= 10, `${label} slide ${slide.number}: alt text for a picture`);
      }
      // The sample deck's scale: sentences are 12 to 16 points, small caps labels and the footer 10 and 11.
      const runSizes = deck.read.slides.flatMap((s) =>
        [...s.xml.matchAll(/<a:r>\s*<a:rPr[^>]* sz="(\d+)"[\s\S]*?<a:t>([^<]*)<\/a:t>/g)].map((m) => ({ size: Number(m[1]) / 100, text: m[2] })),
      );
      assert.ok(runSizes.length > 0 && Math.min(...runSizes.map((r) => r.size)) >= 10, `${label}: nothing under 10 points`);
      const stripSizes = deck.read.slides.flatMap((s) => [...s.xml.matchAll(/name="Words to Know"[\s\S]*?<\/p:sp>/g)].flatMap((m) => [...m[0].matchAll(/<a:rPr[^>]* sz="(\d+)"/g)].map((r) => Number(r[1]))));
      assert.ok(stripSizes.every((sz) => sz >= 1000), `${label}: the words strip is at least 10 points`);
    }
  }
});

test("a lab built before training decks existed gets them on demand, caches them, and rebuilds when stale", async () => {
  const dir = copyLab("level100");
  rmSync(join(dir, "training"), { recursive: true, force: true });
  const first = ensureGeneratedLabTrainingDecks(dir);
  assert.ok(first.summary.decks.length >= 6);
  const folder = join(dir, "training");
  const stateFile = join(folder, TRAINING_STATE_FILE);
  const state = () => JSON.parse(readFileSync(stateFile, "utf8"));
  assert.equal(state().schemaVersion, TRAINING_SCHEMA_VERSION);
  for (const d of first.summary.decks) assert.ok(readCachedTrainingDeck(dir, d.fileName), `${d.fileName} was written`);
  const builtAt = state().builtAt;

  await new Promise((r) => setTimeout(r, 15));
  ensureGeneratedLabTrainingDecks(dir);
  assert.equal(state().builtAt, builtAt, "a second read serves the cache");

  writeFileSync(stateFile, JSON.stringify({ ...state(), schemaVersion: TRAINING_SCHEMA_VERSION - 1 }));
  await new Promise((r) => setTimeout(r, 15));
  ensureGeneratedLabTrainingDecks(dir);
  assert.notEqual(state().builtAt, builtAt, "an older schema version rebuilds");
  assert.equal(state().schemaVersion, TRAINING_SCHEMA_VERSION);

  const rebuiltAt = state().builtAt;
  const victim = join(folder, first.summary.decks.find((d) => d.kind === "topic").fileName);
  writeFileSync(victim, "not a deck");
  await new Promise((r) => setTimeout(r, 15));
  ensureGeneratedLabTrainingDecks(dir);
  assert.notEqual(state().builtAt, rebuiltAt, "a damaged file is rebuilt");
  assert.deepEqual(checkPptxPackage(readFileSync(victim), { expectNotes: true }), []);

  // A changed Microsoft Learn record for a module makes its deck stale the same way it does for the lab text.
  const before = state().fingerprint;
  const manifestPath = join(dir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const mod = manifest.modules.find((m) => m.steps) || manifest.modules[0];
  mod.steps = { ...(mod.steps || {}), fetchedAt: "2031-01-01T00:00:00.000Z", url: mod.steps?.url || "https://learn.microsoft.com/microsoft-copilot-studio/fundamentals-get-started" };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  ensureGeneratedLabTrainingDecks(dir);
  assert.notEqual(state().fingerprint, before, "a changed Learn record changes the fingerprint and rebuilds");
});

test("two processes building the same decks at once never leave or serve a partial file", async () => {
  const dir = copyLab("level100");
  rmSync(join(dir, "training"), { recursive: true, force: true });
  const moduleUrl = pathToFileURL(join(here, "..", "lib", "lab-builder", "training-decks.js")).href;
  const code = `import(${JSON.stringify(moduleUrl)}).then((m) => { for (let i = 0; i < 3; i += 1) m.ensureGeneratedLabTrainingDecks(process.argv[1], { force: true }); });`;
  const localAppData = mkdtempSync(join(tmpdir(), "training-localappdata-"));
  cleanups.push(() => rmSync(localAppData, { recursive: true, force: true }));
  let running = 2;
  const failures = [];
  const children = [0, 1].map(() => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code, dir], { env: { ...process.env, LOCALAPPDATA: localAppData, LAB_BUILDER_LINK_CHECK: "off" }, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c));
    return new Promise((resolve) =>
      child.on("exit", (exitCode) => {
        running -= 1;
        if (exitCode !== 0) failures.push(stderr.slice(-600));
        resolve();
      }),
    );
  });
  const folder = join(dir, "training");
  let served = 0;
  while (running > 0) {
    if (existsSync(folder)) {
      for (const name of readdirSync(folder).filter((n) => n.endsWith(".pptx"))) {
        const data = readCachedTrainingDeck(dir, name);
        if (!data) continue;
        served += 1;
        assert.deepEqual(checkPptxPackage(data, { expectNotes: true }), [], `${name} was served whole`);
      }
    }
    await new Promise((r) => setTimeout(r, 8));
  }
  await Promise.all(children);
  assert.deepEqual(failures, [], "both writers finish without an error");
  assert.ok(served > 0, "the decks were read while they were written");
  assert.deepEqual(readdirSync(folder).filter((n) => n.endsWith(".tmp")), [], "no temporary files are left");
  const again = ensureGeneratedLabTrainingDecks(dir);
  for (const d of again.summary.decks) assert.deepEqual(checkPptxPackage(readFileSync(join(folder, d.fileName)), { expectNotes: true }), [], d.fileName);
});

test("the atomic writer replaces a file whole and cleans up after itself", () => {
  const root = mkdtempSync(join(tmpdir(), "training-atomic-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, "deck.bin");
  writeFileAtomic(target, Buffer.from("first"));
  writeFileAtomic(target, Buffer.from("second"));
  assert.equal(readFileSync(target, "utf8"), "second");
  assert.deepEqual(readdirSync(root), ["deck.bin"]);
});

test("the facilitator guide puts the pre-lab session first and splits training time from hands-on time", () => {
  const lab = ctx.labs.level200;
  const model = buildFacilitatorGuideModel(lab.dir);
  assert.equal(model.preLab.totalMinutes, lab.plan.totalMinutes);
  assert.equal(model.preLab.handsOnMinutes, model.pacing.modulesMinutes);
  assert.equal(model.pacing.preLabTrainingMinutes, lab.plan.totalMinutes);
  assert.equal(model.pacing.totalWithTrainingMinutes, lab.plan.totalMinutes + model.pacing.totalWorkshopMinutes);
  assert.deepEqual(
    model.preLab.rows.map((r) => r.kind),
    [...lab.plan.foundations.map(() => "foundations"), ...lab.plan.topics.map((t) => (t.isRecap ? "recap" : "topic"))],
    "foundations first, then each topic in teaching order",
  );
  assert.deepEqual(model.preLab.rows.slice(lab.plan.foundations.length).map((r) => r.title), lab.plan.topics.map((t) => t.title));
  assert.equal(model.preLab.rows.reduce((sum, r) => sum + r.trainingMinutes, 0), model.preLab.totalMinutes);
  const md = renderFacilitatorGuideMarkdown(model);
  const preLab = md.indexOf("### Pre-Lab Training Session (Deliver First)");
  assert.ok(preLab > 0 && preLab < md.indexOf("### Run-of-Show Pacing Table (Hands-On)"), "the training session comes before the hands-on run of show");
  assert.match(md, new RegExp(`\\| \\*\\*Training Plus Hands-On\\*\\* \\| \\*\\*${model.pacing.totalWithTrainingMinutes} minutes\\*\\*`));
  assert.match(md, /Core Module Delivery Time \(Hands-On\)/);
});

test("the lab's time summary says 'Training: about X' and 'Hands-on: about Y' separately", () => {
  for (const name of ["level100", "level200", "multiProduct"]) {
    const lab = ctx.labs[name];
    assert.match(lab.markdown, /\| \*\*TIME\*\* \| Hands-on: about [^|]+ \(estimate, not a limit\) \|/, name);
    assert.match(lab.markdown, new RegExp(`\\| \\*\\*TRAINING\\*\\* \\| Training: about ${formatTrainingDuration(lab.plan.totalMinutes).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}, delivered before the hands-on lab \\(estimate, not a limit\\) \\|`), name);
  }
});

test("the render helper serves any deck on demand, and an unknown key is simply not found", () => {
  const lab = ctx.labs.level200;
  const rendered = renderTrainingDeckBuffer(lab.plan, "complete");
  assert.deepEqual(checkPptxPackage(rendered.buffer, { expectNotes: true }), []);
  assert.equal(renderTrainingDeckBuffer(lab.plan, "99"), null);
  assert.ok(Object.keys(SAMPLE_LABS).length >= 9);
});
