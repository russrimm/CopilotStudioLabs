/**
 * The text at the top of every generated slide, whatever the title length: the eyebrow (or kicker), the title, the
 * subtitle, and the first body element each get their own room, in every deck the portal draws. The slide XML is
 * read back and every rectangle is compared, so these tests judge the file a person opens, not the builder's intent.
 * Synthetic labs only (Contoso, Fabrikam).
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateLab } from "../lib/lab-builder/generator.js";
import { buildTrainingPlan } from "../lib/lab-builder/training-plan.js";
import { planDecks } from "../lib/lab-builder/training-decks.js";
import { renderTrainingDeck } from "../lib/lab-builder/training-pptx.js";
import { renderMarkdownToPptxBuffer } from "../lib/lab-builder/pptx-builder.js";
import { renderSingleTopicBuffers } from "../lib/lab-builder/topic-documents.js";
import { splitGeneratedLabModules } from "../lib/lab-builder/module-samples.js";
import { ELLIPSIS, fitHeading, fitSingleLine, linesHeightEmu, shortenToFit, wrapText } from "../lib/lab-builder/pptx-text-fit.js";
import { checkPptxPackage } from "../../tools/lab-builder/lib/ooxml-strict.mjs";
import { readDeck } from "./fixtures/training-labs.js";
import { auditSlideTop, makeLogoPng, parseSlideElements } from "./fixtures/pptx-layout.js";

process.env.LAB_BUILDER_LINK_CHECK = "off";
process.env.LAB_BUILDER_VENDOR_DOCS = "off";

// The title the owner reported: the lab name carries the product and the harness, and the deck title repeats "Training deck:".
const OWNER_LAB_TITLE = "Energy & Resources: Build a Field Operations Assistant with Microsoft Copilot Studio on the Microsoft Copilot harness";
const UNBROKEN = "Contoso-Field-Operations-Assistant-Copilot-Studio-Harness-Configuration-Reference-Guide-2026";

const TITLE_VARIANTS = {
  short: (t) => t,
  medium: (t) => `${t}: Field Operations Assistant with Copilot Studio`,
  owner: (t) => `${t.split(":")[0]}: ${OWNER_LAB_TITLE}`,
  unbroken: (t) => `${t.split(":")[0]}: ${UNBROKEN}`,
};

const logo = makeLogoPng();
const BRANDS = {
  default: {},
  calibri: { font: "calibri", primaryColor: "#0b3d91", logoBuffer: null, coverSubtitle: "Contoso partner enablement program for field operations teams across every region" },
  verdana: { font: "verdana", primaryColor: "#7a1f5c", secondaryColor: "#c43e1c", logoBuffer: logo, companyName: "Fabrikam Learning" },
  georgia: { font: "georgia", primaryColor: "#14532d", logoBuffer: logo, companyName: "Fabrikam Global Learning and Enablement Services for Energy and Resources Partners", coverSubtitle: "Internal use only" },
};

const cleanups = [];
const ctx = {};

const clean = (text) => String(text || "").replace(/\s+/g, " ").trim();

before(async () => {
  const root = mkdtempSync(join(tmpdir(), "pptx-title-fit-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const request = { industry: "energy-resources", products: ["copilot-studio"], harness: "microsoft-copilot", level: 100, features: ["mc-create-agent", "mc-instructions", "mc-knowledge"], includeKnowledgeCheck: true };
  ctx.labs = {};
  for (const [name, title] of Object.entries({ plain: "Contoso Plant Foundations Lab", owner: OWNER_LAB_TITLE })) {
    const built = await generateLab({ ...request, title }, { outputRoot: root, useLearnMcp: false, useLlm: false });
    const markdown = readFileSync(join(built.outputDir, "index.md"), "utf8");
    const manifest = JSON.parse(readFileSync(join(built.outputDir, "manifest.json"), "utf8"));
    const plan = buildTrainingPlan({ markdown, manifest, labId: manifest.labId || name, outputDir: built.outputDir });
    ctx.labs[name] = { markdown, manifest, plan, decks: planDecks(plan) };
  }
});

after(() => {
  for (const done of cleanups.reverse()) done();
});

/** Audit every slide of a rendered deck; `fullTitles` (when known) are the titles the slides were asked to show. */
function auditDeck(label, buffer, { fullTitles = null, minTitlePt = 18, withLogo = false, margin = 640080 } = {}) {
  const read = readDeck(buffer);
  const problems = [];
  read.slides.forEach((slide, i) => {
    for (const problem of auditSlideTop(slide.xml, { notes: slide.notes, fullTitle: fullTitles ? fullTitles[i] : null, minTitlePt, logo: withLogo, margin })) {
      problems.push(`${label}, slide ${slide.number}: ${problem}`);
    }
  });
  return { problems, slides: read.slides.length };
}

// The training decks follow the sample deck's 0.6 inch margins; the lab-day decks keep their own 0.7 inch ones.
const TRAINING_MARGIN = 548640;

const variantSpec = (spec, variant) => {
  const shape = TITLE_VARIANTS[variant];
  return {
    ...spec,
    title: shape(spec.title),
    slides: spec.slides.map((s) => ({
      ...s,
      title: shape(s.title),
      body: s.kind === "title" && s.body?.subtitle && variant !== "short" ? { ...s.body, subtitle: `${s.body.subtitle}: ${OWNER_LAB_TITLE}` } : s.body,
    })),
  };
};

test("the owner's long lab title gives every training deck slide its own room, and nothing the title says is lost", () => {
  const { decks } = ctx.labs.owner;
  assert.ok(decks.length >= 4, "topic, foundations, and complete decks were planned");
  const problems = [];
  for (const deck of decks) {
    const { buffer } = renderTrainingDeck(deck.spec, {});
    problems.push(...auditDeck(deck.descriptor.fileName, buffer, { fullTitles: deck.spec.slides.map((s) => clean(s.title)), minTitlePt: 22, margin: TRAINING_MARGIN }).problems);
  }
  assert.deepEqual(problems, []);
  const complete = decks.find((d) => d.descriptor.kind === "complete");
  assert.match(complete.spec.slides[0].title, /^Training deck: Energy & Resources: Build a Field Operations Assistant/, "the deck title the owner saw");
});

test("every training slide kind keeps the eyebrow, title, subtitle, and body apart for short, medium, very long, and unbroken titles in every brand font", () => {
  const { decks } = ctx.labs.plain;
  const wanted = ["topic", "foundations", "complete"].map((kind) => decks.find((d) => d.descriptor.kind === kind)).filter(Boolean);
  assert.equal(wanted.length, 3);
  const problems = [];
  let audited = 0;
  const kinds = new Set();
  for (const [brandName, branding] of Object.entries(BRANDS)) {
    for (const variant of Object.keys(TITLE_VARIANTS)) {
      for (const deck of wanted) {
        const spec = variantSpec(deck.spec, variant);
        spec.slides.forEach((s) => kinds.add(s.kind));
        const { buffer } = renderTrainingDeck(spec, { branding });
        assert.deepEqual(checkPptxPackage(buffer, { expectNotes: true }), [], `${brandName} ${variant} ${deck.descriptor.kind}: a clean package`);
        const result = auditDeck(`${brandName}/${variant}/${deck.descriptor.kind}`, buffer, { fullTitles: spec.slides.map((s) => clean(s.title)), minTitlePt: 22, withLogo: Boolean(branding.logoBuffer), margin: TRAINING_MARGIN });
        problems.push(...result.problems);
        audited += result.slides;
      }
    }
  }
  assert.ok(audited > 400, `${audited} slides audited`);
  assert.ok(kinds.size >= 12, `${kinds.size} slide kinds covered`);
  assert.deepEqual(problems, []);
});

test("a title that fits keeps its size and its place; one that does not steps down and then shortens, and the training title slide keeps its own sizes", () => {
  const { decks } = ctx.labs.plain;
  const deck = decks.find((d) => d.descriptor.kind === "topic");
  const sizeOf = (spec, index) => {
    const { buffer } = renderTrainingDeck(spec, {});
    const title = parseSlideElements(readDeck(buffer).slides[index].xml).find((s) => s.name === "Title");
    return { size: title.paragraphs[0].sizePt, text: title.text, descr: title.descr, y: title.y, bottom: title.bottom };
  };
  const short = sizeOf(deck.spec, 1);
  assert.equal(short.size, 30, "a short content title stays 30 pt");
  assert.equal(short.y, 658368, "and it sits at 0.72 inch, as in the sample deck");
  assert.equal(short.bottom <= 1481328 + 1, true, "with its last line above the content, which starts at 1.65 inch");
  const cover = sizeOf(deck.spec, 0);
  assert.equal(cover.size, 48, "a short title slide title is 48 pt, as in the sample deck");
  const longSpec = variantSpec(deck.spec, "owner");
  const longCover = sizeOf(longSpec, 0);
  assert.ok(longCover.size < 48 && longCover.size >= 28, `the owner's title steps down on the title slide (${longCover.size} pt)`);
  const longContent = sizeOf(longSpec, 1);
  assert.ok(longContent.size < 30 && longContent.size >= 22, `and on a content slide (${longContent.size} pt)`);
  const absurd = sizeOf({ ...deck.spec, slides: deck.spec.slides.map((s, i) => (i === 1 ? { ...s, title: `${s.title}: ${OWNER_LAB_TITLE} ${OWNER_LAB_TITLE} ${OWNER_LAB_TITLE}` } : s)) }, 1);
  assert.equal(absurd.size, 22, "past the smallest size the title is shortened at 22 pt");
  assert.ok(absurd.text.includes(ELLIPSIS) && absurd.descr.length > absurd.text.length, "with an ellipsis, and the full title in the alt text");
});

test("the per-topic lab decks and the complete lab deck keep the kicker, badge, title, divider, and first card apart, for every title length and brand font", () => {
  const problems = [];
  let audited = 0;
  for (const labName of ["plain", "owner"]) {
    const lab = ctx.labs[labName];
    const split = splitGeneratedLabModules(lab.markdown, lab.manifest);
    assert.ok(split.modules.length >= 2);
    for (const [brandName, branding] of Object.entries(BRANDS)) {
      const complete = renderMarkdownToPptxBuffer(lab.markdown, { title: lab.manifest.title, manifest: lab.manifest, branding });
      assert.deepEqual(checkPptxPackage(complete, { expectNotes: true }), [], `${labName}/${brandName}: the complete deck is a clean package`);
      const whole = auditDeck(`${labName}/${brandName}/complete deck`, complete);
      problems.push(...whole.problems);
      audited += whole.slides;
      for (const variant of Object.keys(TITLE_VARIANTS)) {
        const mod = { ...split.modules[0], title: TITLE_VARIANTS[variant](split.modules[0].title) };
        const { pptxBuffer } = renderSingleTopicBuffers(mod, { labTitle: lab.manifest.title, manifest: lab.manifest, branding });
        const one = auditDeck(`${labName}/${brandName}/${variant}/topic deck`, pptxBuffer);
        problems.push(...one.problems);
        audited += one.slides;
      }
    }
  }
  assert.ok(audited > 400, `${audited} slides audited`);
  assert.deepEqual(problems, []);
});

test("fitHeading steps down, then shortens at a word boundary, and always hands back the full text", () => {
  const steps = [30, 26, 24, 22].map((sizePt) => ({ sizePt, spacingPct: 95000 }));
  const args = { fontName: "Segoe UI Semibold", widthEmu: 10911840, maxHeightEmu: 980000, steps };
  const short = fitHeading({ ...args, text: "How it works: Microsoft Copilot Studio" });
  assert.equal(short.sizePt, 30);
  assert.equal(short.shortened, false);
  const mid = fitHeading({ ...args, text: `Check your understanding: ${OWNER_LAB_TITLE}` });
  assert.ok(mid.sizePt < 30 && mid.heightEmu <= 980000);
  const huge = fitHeading({ ...args, text: `${OWNER_LAB_TITLE} ${OWNER_LAB_TITLE} ${OWNER_LAB_TITLE}` });
  assert.equal(huge.sizePt, 22);
  assert.equal(huge.shortened, true);
  assert.ok(huge.text.endsWith(ELLIPSIS) && !/\s…$/.test(huge.text), "cut at a word, ellipsis attached");
  assert.equal(huge.fullText, clean(`${OWNER_LAB_TITLE} ${OWNER_LAB_TITLE} ${OWNER_LAB_TITLE}`));
  assert.ok(huge.heightEmu <= 980000);
  const word = fitHeading({ ...args, text: "x".repeat(400) });
  assert.ok(word.heightEmu <= 980000 && word.shortened, "an unbroken word is cut too");
});

test("a wide brand font wraps a title sooner than a narrow one, and an unknown font is measured wide", () => {
  const text = "Build a Field Operations Assistant with Microsoft Copilot Studio on the Microsoft Copilot harness";
  const lines = (fontName) => wrapText(text, 6000000, 30, fontName).length;
  assert.ok(lines("Verdana") > lines("Calibri"));
  assert.ok(lines("Totally Unknown Display Font") >= lines("Arial"));
  assert.ok(linesHeightEmu(2, 30, "Segoe UI", 95000) > linesHeightEmu(2, 30, "Arial", 95000), "Segoe UI lines are taller");
});

test("a title written as '<name> — <what this slide is>' keeps the part that tells one slide from the next", () => {
  const shown = shortenToFit(`${OWNER_LAB_TITLE} — Check Your Work & Troubleshooting`, (t) => t.length <= 70);
  assert.match(shown, /… — Check Your Work & Troubleshooting$/);
  const single = fitSingleLine({ text: "TRAINING · MICROSOFT 365 COPILOT AGENT BUILDER FOR EVERY ENTERPRISE TEAM IN THE WORLD AND BEYOND", fontName: "Segoe UI Semibold", widthEmu: 3000000, sizes: [13, 12, 11] });
  assert.equal(single.lines.length, 1);
  assert.equal(single.shortened, true);
});
