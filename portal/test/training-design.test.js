/**
 * The look of the pre-lab training decks: the owner's sample deck, drawn from design tokens. These tests read the
 * PowerPoint files back (slide XML, never the builder's intentions) and judge them: the palette, fonts, and sizes of
 * the sample; the dark title, divider, and closing slides and the light content slides in their fixed places; the
 * components each slide kind needs (cards, numbered circles, chevrons, callouts, a table); the contrast of every text and
 * background pair; alt text on diagrams and the decorative flag on backdrop shapes; harness colors that always carry the
 * harness name; the branded mapping; the bold fix for a brand font; and a saved deck from the previous layout rebuilding.
 *
 * Offline and synthetic: Contoso and Fabrikam only, no Microsoft Learn, no model, no network.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateLab } from "../lib/lab-builder/generator.js";
import { renderMarkdownToPptxBuffer } from "../lib/lab-builder/pptx-builder.js";
import { TRAINING_SCHEMA_VERSION, buildTrainingPlan } from "../lib/lab-builder/training-plan.js";
import { TRAINING_STATE_FILE, ensureGeneratedLabTrainingDecks, planDecks } from "../lib/lab-builder/training-decks.js";
import { renderTrainingDeck } from "../lib/lab-builder/training-pptx.js";
import { FONTS, GRID, PARTS, SAMPLE_PALETTE, TYPE, contrastRatio, harnessColors, inch, resolveDesign } from "../lib/lab-builder/training-design.js";
import { checkPptxPackage } from "../../tools/lab-builder/lib/ooxml-strict.mjs";
import { SAMPLE_LABS, buildSampleLabs, readDeck } from "./fixtures/training-labs.js";
import { makeLogoPng, parseAllShapes, parseTables, slideBackground } from "./fixtures/pptx-layout.js";

process.env.LAB_BUILDER_LINK_CHECK = "off";
process.env.LAB_BUILDER_VENDOR_DOCS = "off";

const P = SAMPLE_PALETTE;
const SLIDE_W = 12192000;
const SLIDE_H = 6858000;
const MIXED = ["mc-harness-choice", "dlp-governance", "create-agent", "agent-instructions", "knowledge-sharepoint", "mc-create-agent", "mc-instructions", "mc-knowledge", "mc-memory", "alm-solutions"];
const LONG_TITLE = "Fabrikam Energy & Resources: Build a Field Operations Assistant with Microsoft Copilot Studio on the Standard harness";
const BRANDS = {
  navyBlue: { companyName: "Fabrikam Learning", primaryColor: "#0b3d91", secondaryColor: "#c43e1c", font: "calibri", footerText: "Fabrikam internal training", logoBuffer: makeLogoPng() },
  lightYellow: { primaryColor: "#ffd400", secondaryColor: "#f6e05e", font: "verdana" },
  wine: { primaryColor: "#7a1f5c", font: "georgia" },
};
const offline = { write: false, useLearnMcp: false, useLlm: false };
const cleanups = [];
const ctx = { rendered: new Map() };

/** A rendered deck, read back; cached so each deck is drawn once per brand. */
function render(deck, brand = "default") {
  const key = `${deck.descriptor.key}|${brand}|${deck.spec.title}`;
  if (!ctx.rendered.has(key)) {
    const { buffer, overflow } = renderTrainingDeck(deck.spec, { branding: brand === "default" ? undefined : BRANDS[brand] });
    ctx.rendered.set(key, { buffer, overflow, read: readDeck(buffer), spec: deck.spec });
  }
  return ctx.rendered.get(key);
}

before(async () => {
  const root = mkdtempSync(join(tmpdir(), "training-design-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const plain = await generateLab({ ...SAMPLE_LABS.level200, title: LONG_TITLE, features: ["generative-orchestration", "connector-tools", "create-agent", "agent-instructions"] }, offline);
  const plainPlan = buildTrainingPlan({ markdown: plain.markdown, manifest: plain.manifest, labId: "design-plain" });
  const both = await generateLab({ harnessMode: "both", products: ["copilot-studio"], industry: "retail", includeKnowledgeCheck: false, title: "Contoso Retail Agents Lab", features: MIXED }, offline);
  const bothPlan = buildTrainingPlan({ markdown: both.markdown, manifest: both.manifest, labId: "design-both" });
  ctx.plain = { plan: plainPlan, decks: planDecks(plainPlan) };
  ctx.both = { plan: bothPlan, decks: planDecks(bothPlan) };
  ctx.root = root;
  ctx.all = [...ctx.plain.decks, ...ctx.both.decks];
  ctx.topic = ctx.plain.decks.find((d) => d.descriptor.kind === "topic" && d.spec.slides.some((s) => s.kind === "quiz"));
  ctx.foundations = ctx.plain.decks.find((d) => d.descriptor.kind === "foundations");
  ctx.complete = ctx.plain.decks.find((d) => d.descriptor.kind === "complete");
  ctx.bothComplete = ctx.both.decks.find((d) => d.descriptor.kind === "complete");
});

after(() => {
  for (const done of cleanups.reverse()) done();
});

/** [{slide, spec, shapes, tables, bg}] for every slide of a rendered deck. */
function slidesOf(deck, brand = "default") {
  const rendered = render(deck, brand);
  return rendered.read.slides.map((slide, i) => ({ slide, spec: rendered.spec.slides[i], shapes: parseAllShapes(slide.xml), tables: parseTables(slide.xml), bg: slideBackground(slide.xml), number: i + 1 }));
}
const byName = (shapes, name) => shapes.find((s) => s.name === name);
const named = (shapes, pattern) => shapes.filter((s) => pattern.test(s.name));
const firstOfKind = (deck, kind, brand) => slidesOf(deck, brand).find((s) => s.spec.kind === kind);

// ── Tokens ───────────────────────────────────────────────────────────────────

test("the design tokens are the sample deck's palette, fonts, sizes, and positions", () => {
  assert.deepEqual(
    { ink: P.ink, navy: P.navy, page: P.page, card: P.card, cardLine: P.cardLine, teal: P.teal, tealTint: P.tealTint, coral: P.coral, coralDark: P.coralDark, green: P.green, greenTint: P.greenTint, purple: P.purple, purpleTint: P.purpleTint, gray: P.gray, grayDark: P.grayDark, tile: P.tile, tileLine: P.tileLine, onDark: P.onDark, onDarkSoft: P.onDarkSoft },
    { ink: "1B2630", navy: "10303F", page: "F4F8FA", card: "FFFFFF", cardLine: "E3E7EA", teal: "0B6E99", tealTint: "DCEFF7", coral: "F26B4F", coralDark: "C2432A", green: "1E7A55", greenTint: "DDF0E6", purple: "7B3FE4", purpleTint: "EDE5FB", gray: "66727A", grayDark: "56646E", tile: "F1F4F6", tileLine: "C9D2D8", onDark: "D5DEE6", onDarkSoft: "C5D2DB" },
  );
  assert.deepEqual(FONTS, { heading: "Segoe UI Semibold", body: "Segoe UI" });
  assert.equal(TYPE.coverTitle[0], 48);
  assert.equal(TYPE.contentTitle[0], 30);
  assert.equal(TYPE.cardHeading, 19);
  assert.equal(TYPE.label, 10);
  assert.equal(TYPE.footer, 10);
  assert.ok(TYPE.bodyMin >= 12 && TYPE.bodyMax <= 16, "body text is 12 to 16 points");
  assert.equal(GRID.margin, inch(0.6));
  assert.ok(Math.abs(GRID.contentW - inch(12.13)) < 5000, "content is 12.13 inches wide");
  assert.deepEqual([GRID.eyebrowY, GRID.titleY, GRID.footerY, GRID.top], [inch(0.42), inch(0.72), inch(7.08), inch(1.65)]);
  assert.deepEqual(PARTS.cover.circles.map((c) => c.d), [5.6, 4.2, 2.8, 1.5]);
  assert.equal(PARTS.cover.barW, inch(0.28));
  assert.equal(PARTS.bandH, inch(0.85));
  assert.equal(PARTS.pillAdj, 50000);
});

test("with no brand profile the design is the sample palette and Segoe UI exactly; the harness colors are fixed meanings", () => {
  const d = resolveDesign();
  assert.equal(d.accent, P.teal);
  assert.equal(d.accentTint, P.tealTint);
  assert.equal(d.navy, P.navy);
  assert.equal(d.highlight, P.coral);
  assert.equal(d.highlightFill, P.coralDark, "white text sits on the darker coral");
  assert.equal(d.font.heading, "Segoe UI Semibold");
  assert.equal(d.font.body, "Segoe UI");
  assert.equal(d.harness.standard.fill, P.green);
  assert.equal(d.harness["microsoft-copilot"].fill, P.purple);
  assert.equal(d.harness["customer-conversation"].fill, P.teal);
  assert.equal(d.branded, false);
  // A brand never recolors a harness.
  const branded = resolveDesign({ primaryColor: "#c43e1c", secondaryColor: "#1e7a55" }, "Arial");
  assert.equal(branded.harness.standard.fill, P.green);
  assert.equal(branded.harness["microsoft-copilot"].fill, P.purple);
  assert.equal(harnessColors(branded, "standard").fill, P.green);
  assert.equal(harnessColors(branded, "some-new-harness").fill, branded.accent, "an unknown harness reads as the accent");
});

test("every text and background pair of the design reaches 4.5:1, with the sample palette and with brand colors that start too light", () => {
  const variants = [resolveDesign(), ...Object.values(BRANDS).map((b) => resolveDesign(b, null)), resolveDesign({ primaryColor: "#ffffff", secondaryColor: "#ffff00" }), resolveDesign({ primaryColor: "#101010", secondaryColor: "#202020" })];
  const problems = [];
  for (const [i, d] of variants.entries()) {
    const pairs = [
      ["white on accent", "FFFFFF", d.accent],
      ["white on highlight fill", "FFFFFF", d.highlightFill],
      ["white on navy", "FFFFFF", d.navy],
      ["white on standard", "FFFFFF", d.harness.standard.fill],
      ["white on copilot", "FFFFFF", d.harness["microsoft-copilot"].fill],
      ["white on customer conversation", "FFFFFF", d.harness["customer-conversation"].fill],
      ["accent text on page", d.accentText, d.page],
      ["accent text on card", d.accentText, d.card],
      ["accent text on tint", d.accentText, d.accentTint],
      ["highlight ink on page", d.highlightInk, d.page],
      ["highlight ink on card", d.highlightInk, d.card],
      ["highlight ink on tint", d.highlightInk, d.accentTint],
      ["highlight on navy", d.highlightOnDark, d.navy],
      ["gray on page", d.gray, d.page],
      ["gray on card", d.gray, d.card],
      ["dark gray on tile", d.grayDark, d.tile],
      ["dark gray on tint", d.grayDark, d.accentTint],
      ["ink on page", d.ink, d.page],
      ["ink on tint", d.ink, d.accentTint],
      ["ink on tile", d.ink, d.tile],
      ["on-dark on navy", d.onDark, d.navy],
      ["soft on-dark on navy", d.onDarkSoft, d.navy],
      ["footer on-dark on navy", d.onDarkFooter, d.navy],
      ["standard text on card", d.harness.standard.text, d.card],
      ["standard text on tint", d.harness.standard.text, d.harness.standard.tint],
      ["copilot text on card", d.harness["microsoft-copilot"].text, d.card],
      ["copilot text on tint", d.harness["microsoft-copilot"].text, d.harness["microsoft-copilot"].tint],
    ];
    for (const [label, fg, bg] of pairs) {
      const ratio = contrastRatio(fg, bg);
      if (ratio < 4.5) problems.push(`variant ${i}: ${label} (${fg} on ${bg}) is ${ratio.toFixed(2)}:1`);
    }
  }
  assert.deepEqual(problems, []);
  // The sample's own pairs that fail as drawn are the ones that were darkened, and nothing else moved.
  assert.ok(contrastRatio("FFFFFF", P.coral) < 4.5, "white on the sample's coral fails, so the coral fill that carries text is the darker coral");
  assert.ok(contrastRatio("FFFFFF", P.coralDark) >= 4.5);
  assert.ok(contrastRatio(P.green, P.greenTint) < 4.5, "the sample's green on its tint falls just short, so text on a harness tint is darkened a little");
});

// ── Structure ────────────────────────────────────────────────────────────────

test("the title slide is dark navy with the coral bar, the concentric circles, a coral eyebrow, a 48 pt title, and pills", () => {
  const s = slidesOf(ctx.topic)[0];
  assert.equal(s.spec.kind, "title");
  assert.equal(s.bg, P.navy);
  const bar = byName(s.shapes, "Coral Bar");
  assert.deepEqual([bar.x, bar.y, bar.cx, bar.cy, bar.fill], [0, 0, inch(0.28), SLIDE_H, P.coral]);
  const circles = named(s.shapes, /^Circle \d$/);
  assert.deepEqual(circles.map((c) => [c.geom, c.cx / 914400]), [["ellipse", 5.6], ["ellipse", 4.2], ["ellipse", 2.8], ["ellipse", 1.5]]);
  assert.deepEqual(circles.map((c) => c.fill), [P.teal, P.teal, P.teal, P.coral], "teal rings around a solid coral circle");
  assert.ok(circles.every((c) => c.decorative), "the backdrop is decorative");
  const centers = circles.map((c) => [c.x + c.cx / 2, c.y + c.cy / 2]);
  assert.ok(centers.every(([x, y]) => Math.abs(x - centers[0][0]) < 2 && Math.abs(y - centers[0][1]) < 2), "concentric");
  assert.ok(circles[0].x + circles[0].cx > SLIDE_W, "the right part runs off the slide");
  const eyebrow = byName(s.shapes, "Eyebrow");
  assert.equal(eyebrow.runs[0].color, P.coral);
  assert.equal(eyebrow.text, eyebrow.text.toUpperCase());
  assert.equal(eyebrow.runs[0].sizePt, 14);
  const title = s.shapes.find((x) => x.name === "Title");
  assert.equal(title.runs[0].sizePt, 48);
  assert.equal(title.runs[0].color, "FFFFFF");
  assert.equal(title.x, inch(0.9));
  assert.equal(byName(s.shapes, "Subtitle").runs[0].color, P.onDark);
  const pills = named(s.shapes, /^Tag \d+$/);
  assert.ok(pills.length >= 2);
  for (const pill of pills) {
    assert.deepEqual([pill.geom, pill.adj, pill.fill, pill.line, pill.cy, pill.runs[0].sizePt, pill.runs[0].color], ["roundRect", "50000", P.teal, "FFFFFF", PARTS.pillH, 12, "FFFFFF"]);
    assert.equal(pill.y, inch(5.85), "the pill row sits at the sample's height");
  }
  assert.equal(byName(s.shapes, "Series").runs[0].color, P.onDarkSoft);
  assert.ok(!byName(s.shapes, "Footer Context"), "the title slide has a series line, not a footer");
});

test("every content slide carries the eyebrow, the title, the footer, and the slide number where the sample puts them", () => {
  let checked = 0;
  for (const deck of [ctx.topic, ctx.foundations, ctx.complete]) {
    for (const s of slidesOf(deck)) {
      if (["title", "divider", "closing"].includes(s.spec.kind)) continue;
      checked += 1;
      const label = `${deck.descriptor.key} slide ${s.number} (${s.spec.kind})`;
      assert.equal(s.bg, P.page, `${label}: page color`);
      const eyebrow = byName(s.shapes, "Eyebrow");
      assert.deepEqual([eyebrow.x, eyebrow.y], [GRID.margin, GRID.eyebrowY], `${label}: eyebrow place`);
      assert.ok(eyebrow.runs[0].sizePt >= 11 && eyebrow.runs[0].sizePt <= 12 && eyebrow.runs[0].color === P.teal, `${label}: eyebrow is small teal caps`);
      assert.equal(eyebrow.text, eyebrow.text.toUpperCase());
      const title = s.shapes.find((x) => x.name === "Title" && x.placeholder);
      assert.deepEqual([title.x, title.y, title.cx], [GRID.margin, GRID.titleY, GRID.contentW], `${label}: title place`);
      assert.ok(title.runs[0].sizePt <= 30 && title.runs[0].sizePt >= 22 && title.runs[0].color === P.ink, `${label}: title is 30 pt or a step down, in ink`);
      assert.equal(title.runs[0].font, FONTS.heading);
      const footer = byName(s.shapes, "Footer Context");
      assert.deepEqual([footer.x, footer.y, footer.runs[0].sizePt, footer.runs[0].color], [GRID.margin, GRID.footerY, 10, P.gray], `${label}: footer`);
      const counter = byName(s.shapes, "Slide Counter");
      assert.deepEqual([counter.x, counter.y, counter.cx, counter.cy, counter.text], [GRID.numberX, GRID.numberY, GRID.numberW, GRID.numberH, String(s.number)], `${label}: slide number`);
    }
  }
  assert.ok(checked >= 20, `${checked} content slides checked`);
});

test("the divider and closing slides are dark and mirror the title slide", () => {
  const slides = slidesOf(ctx.complete);
  const divider = slides.find((s) => s.spec.kind === "divider");
  const closing = slides.find((s) => s.spec.kind === "closing");
  for (const s of [divider, closing]) {
    assert.equal(s.bg, P.navy);
    assert.equal(byName(s.shapes, "Coral Bar").fill, P.coral);
    assert.equal(byName(s.shapes, "Eyebrow").runs[0].color, P.coral);
    assert.equal(s.shapes.find((x) => x.name === "Title").runs[0].color, "FFFFFF");
  }
  assert.ok(named(closing.shapes, /^Circle \d$/).length === 4, "the closing slide carries the circles, smaller");
  const numbers = named(closing.shapes, /^Lab Part \d+ Number$/);
  assert.equal(numbers.length, closing.spec.body.rows.length);
  assert.ok(numbers.every((n) => n.geom === "ellipse" && n.fill === P.coralDark && n.runs[0].color === "FFFFFF"));
  const current = divider.spec.body.current;
  assert.equal(named(divider.shapes, /^Section \d+ Number$/).length, divider.spec.body.rows.length);
  assert.ok(byName(divider.shapes, `Section ${current + 1} Panel`), "the current part is filled");
});

test("each slide kind draws the component its data needs", () => {
  const seen = new Set();
  const decks = [ctx.topic, ctx.foundations, ctx.complete, ctx.bothComplete];
  for (const deck of decks) {
    for (const s of slidesOf(deck)) {
      const { kind, body } = s.spec;
      seen.add(kind);
      const label = `${deck.descriptor.key} slide ${s.number} (${kind})`;
      switch (kind) {
        case "blocks": {
          const bands = named(s.shapes, /^Block \d+ Heading$/);
          assert.equal(bands.length, body.nodes.length, `${label}: a header band for each block`);
          assert.ok(bands.every((b) => b.fill === P.teal && b.runs[0].color === "FFFFFF" && b.cy >= inch(0.5)), `${label}: teal bands with white headings`);
          assert.ok(s.slide.groups.some((g) => g.name === "Building Blocks Diagram"));
          break;
        }
        case "flow": {
          const steps = named(s.shapes, /^Step \d+ Heading$/);
          assert.equal(steps.length, body.steps.length);
          assert.match(steps[0].text, /^1\s+\S/, `${label}: numbered`);
          if (body.steps.length <= 5) assert.equal(s.shapes.filter((x) => x.geom === "chevron").length, body.steps.length - 1, `${label}: a chevron between steps`);
          assert.ok(s.shapes.filter((x) => x.geom === "chevron").every((c) => c.fill === P.coral && c.decorative));
          break;
        }
        case "example": {
          assert.equal(named(s.shapes, /^(Then)$/).length, 1);
          assert.equal(byName(s.shapes, "Then").geom, "rightArrow");
          assert.equal(byName(s.shapes, "What You Get").fill, P.navy);
          break;
        }
        case "definition": {
          assert.equal(s.shapes.filter((x) => x.geom === "rightArrow").length, body.picture ? 2 : 0);
          assert.ok(byName(s.shapes, "Definition Stripe"));
          break;
        }
        case "fit": {
          const good = byName(s.shapes, "Good Fit Heading");
          const not = byName(s.shapes, "Not A Fit Heading");
          assert.deepEqual([good.fill, not.fill], [P.teal, P.coralDark], `${label}: two colored column cards`);
          break;
        }
        case "scenario": {
          assert.equal(byName(s.shapes, "Situation Heading").fill, P.coralDark);
          assert.equal(byName(s.shapes, "Helps Heading").fill, P.teal);
          assert.equal(byName(s.shapes, "Lab Context Panel").fill, P.tealTint, `${label}: a tinted callout`);
          assert.equal(byName(s.shapes, "Lab Context Stripe").fill, P.coral, `${label}: with a coral stripe`);
          break;
        }
        case "quiz": {
          const circles = named(s.shapes, /^Question \d+ Number$/);
          assert.equal(circles.length, body.questions.length);
          assert.deepEqual(circles.map((c) => c.text), body.questions.map((_q, i) => String(i + 1)));
          assert.ok(circles.every((c) => c.geom === "ellipse"));
          break;
        }
        case "terms":
        case "vocab":
          assert.equal(named(s.shapes, /^Term \d+ Stripe$/).length, body.items.length, `${label}: a card for each term`);
          break;
        case "learn":
          assert.equal(s.shapes.flatMap((x) => x.runs).filter((r) => r.link).length, (body.links || []).length, `${label}: a link for each tile`);
          break;
        case "know":
          assert.equal(named(s.shapes, /^Fact \d+ Stripe$/).length, body.items.length);
          break;
        case "labPreview":
          assert.equal(byName(s.shapes, "Lab Panel").fill, P.navy);
          assert.equal(byName(s.shapes, "Time").geom, "roundRect");
          break;
        case "fitHub":
          assert.equal(byName(s.shapes, "Center").fill, P.navy, `${label}: the center is a dark layer`);
          assert.equal(named(s.shapes, /^Part \d+ Stripe$/).length, body.around.length);
          break;
        case "where":
          assert.ok(byName(s.shapes, "Where Note Panel"));
          break;
        case "day": {
          assert.equal(s.tables.length, 1);
          const [table] = s.tables;
          assert.deepEqual(table.rows[0].map((c) => c.fill), [P.navy, P.navy, P.navy], `${label}: a navy header row`);
          assert.deepEqual(table.rows.slice(1).map((r) => r[0].fill), table.rows.slice(1).map((_r, i) => (i % 2 === 0 ? P.card : P.tile)), `${label}: light zebra rows`);
          assert.equal(table.rows.length, body.rows.length + 1);
          break;
        }
        case "agenda":
          assert.equal(named(s.shapes, /^Agenda \d+ Number$/).length, body.rows.length);
          break;
        case "compare": {
          const heads = named(s.shapes, /^Harness \d Heading$/);
          assert.deepEqual(heads.map((h) => h.text), body.columns.map((c) => c.name));
          assert.deepEqual(heads.map((h) => h.fill), body.columns.map((c) => harnessColors(resolveDesign(), c.harness).fill), `${label}: each harness in its own color, with its name`);
          break;
        }
        case "adds":
          assert.equal(named(s.shapes, /^Item \d+ Number$/).length, body.items.length);
          break;
        case "needToKnow":
          assert.equal(named(s.shapes, /^Idea \d+ Stripe$/).length, body.items.length);
          break;
        default:
          break;
      }
    }
  }
  const kinds = [...seen].sort();
  assert.deepEqual(
    kinds,
    ["adds", "agenda", "blocks", "closing", "compare", "day", "definition", "divider", "example", "fit", "fitHub", "flow", "know", "labPreview", "learn", "needToKnow", "quiz", "scenario", "terms", "title", "vocab", "what", "where"].filter((k) => seen.has(k)),
  );
  for (const required of ["blocks", "flow", "example", "definition", "fit", "scenario", "quiz", "terms", "learn", "know", "labPreview", "fitHub", "day", "agenda", "compare", "closing", "divider", "title", "what", "vocab", "where"]) {
    assert.ok(seen.has(required), `the decks exercised the ${required} kind`);
  }
});

// ── Contrast ─────────────────────────────────────────────────────────────────

/** The color behind a shape's text: its own fill, else the last earlier shape with a fill that covers the text box's center, else the slide. */
function surfaceOf(shapes, index, bg) {
  const shape = shapes[index];
  if (shape.fill) return shape.fill;
  const cx = shape.x + shape.cx / 2;
  const cy = shape.y + shape.cy / 2;
  for (let i = index - 1; i >= 0; i -= 1) {
    const under = shapes[i];
    if (under.fill && cx >= under.x && cx <= under.x + under.cx && cy >= under.y && cy <= under.y + under.cy) return under.fill;
  }
  return bg;
}

function contrastProblems(deck, brand) {
  const problems = [];
  for (const s of slidesOf(deck, brand)) {
    s.shapes.forEach((shape, index) => {
      if (!shape.runs.length) return;
      const surface = surfaceOf(s.shapes, index, s.bg);
      for (const run of shape.runs) {
        const ratio = contrastRatio(run.color || "000000", surface);
        if (ratio < 4.5) problems.push(`${brand}/${deck.descriptor.key} slide ${s.number} "${shape.name}": ${run.color} on ${surface} is ${ratio.toFixed(2)}:1 ("${run.text.slice(0, 24)}")`);
      }
    });
    for (const table of s.tables) {
      for (const row of table.rows) {
        for (const cell of row) {
          for (const run of cell.runs) if (contrastRatio(run.color, cell.fill) < 4.5) problems.push(`${brand}/${deck.descriptor.key} slide ${s.number} table cell: ${run.color} on ${cell.fill}`);
        }
      }
    }
  }
  return problems;
}

test("every text color against the color behind it reaches 4.5:1 in the decks as drawn, default and branded, large text included", () => {
  const decks = [ctx.topic, ctx.foundations, ctx.complete, ctx.bothComplete];
  const problems = [];
  for (const deck of decks) problems.push(...contrastProblems(deck, "default"));
  for (const brand of Object.keys(BRANDS)) for (const deck of [ctx.topic, ctx.bothComplete]) problems.push(...contrastProblems(deck, brand));
  assert.deepEqual(problems, []);
});

// ── Accessibility ────────────────────────────────────────────────────────────

test("diagrams and tables carry a text description, and a shape with no text is marked decorative", () => {
  let groups = 0;
  let decorative = 0;
  const problems = [];
  for (const deck of ctx.all) {
    for (const s of slidesOf(deck)) {
      for (const group of s.slide.groups) {
        groups += 1;
        if (group.descr.length < 25) problems.push(`${deck.descriptor.key} slide ${s.number}: group "${group.name}" has no real alt text`);
      }
      for (const table of s.tables) if (table.descr.length < 25) problems.push(`${deck.descriptor.key} slide ${s.number}: table "${table.name}" has no alt text`);
      for (const shape of s.shapes) {
        if (shape.inGroup || shape.placeholder || shape.runs.length) continue;
        if (!shape.decorative) problems.push(`${deck.descriptor.key} slide ${s.number}: "${shape.name}" has no text and is not marked decorative`);
        else decorative += 1;
      }
    }
  }
  assert.deepEqual(problems, []);
  assert.ok(groups > 20 && decorative > 200, `${groups} groups and ${decorative} decorative shapes checked`);
});

test("shapes are in reading order: the title first, the content, then the footer; every slide has notes and a real title", () => {
  for (const deck of ctx.all) {
    const { read, overflow } = render(deck);
    assert.deepEqual(overflow, [], `${deck.descriptor.key}: every text fits its shape`);
    for (const s of slidesOf(deck)) {
      const label = `${deck.descriptor.key} slide ${s.number}`;
      assert.ok(read.slides[s.number - 1].notes.length > 0, `${label}: speaker notes`);
      assert.ok(read.slides[s.number - 1].title.length > 0, `${label}: a title`);
      const meaningful = s.shapes.filter((x) => !x.decorative);
      assert.ok(meaningful[0].placeholder, `${label}: the title placeholder is read first`);
      if (s.spec.kind !== "title") {
        assert.deepEqual(meaningful.slice(-2).map((x) => x.name), ["Footer Context", "Slide Counter"], `${label}: the footer is read last`);
      }
    }
  }
});

// ── Geometry ─────────────────────────────────────────────────────────────────

test("no shape leaves the slide and no text box lands on another's text, in short-title, long-title, and combined decks", () => {
  const problems = [];
  let slides = 0;
  const textArea = (s) => ({ x: s.x + s.insets.l, y: s.y + s.insets.t, r: s.x + s.cx - s.insets.r, b: s.y + s.cy - s.insets.b });
  for (const deck of ctx.all) {
    for (const s of slidesOf(deck)) {
      slides += 1;
      const label = `${deck.descriptor.key} slide ${s.number} (${s.spec.kind})`;
      for (const shape of s.shapes.filter((x) => !x.decorative)) {
        if (shape.x < 0 || shape.y < 0 || shape.x + shape.cx > SLIDE_W + 1 || shape.y + shape.cy > SLIDE_H + 1) problems.push(`${label}: "${shape.name}" leaves the slide`);
        if (!["Footer Context", "Slide Counter", "Series"].includes(shape.name) && shape.y + shape.cy > GRID.bottom + 1 && s.spec.kind !== "title") problems.push(`${label}: "${shape.name}" ends at ${shape.y + shape.cy}, below the content area`);
      }
      const texty = s.shapes.filter((x) => !x.decorative && x.runs.length);
      for (let i = 0; i < texty.length; i += 1) {
        for (let j = i + 1; j < texty.length; j += 1) {
          const a = textArea(texty[i]);
          const b = textArea(texty[j]);
          const overlapX = Math.min(a.r, b.r) - Math.max(a.x, b.x);
          const overlapY = Math.min(a.b, b.b) - Math.max(a.y, b.y);
          if (overlapX > 12700 && overlapY > 12700) problems.push(`${label}: the text of "${texty[i].name}" overlaps "${texty[j].name}"`);
        }
      }
    }
  }
  assert.deepEqual(problems, []);
  assert.ok(slides > 300, `${slides} slides checked`);
});

// ── Fonts and bold ───────────────────────────────────────────────────────────

test("a brand font does not make every run bold: headings are bold, body text is not (the renderRunXml fix)", () => {
  const read = render(ctx.topic, "navyBlue").read;
  const runs = read.slides.flatMap((s) => parseAllShapes(s.xml).flatMap((x) => x.runs.map((r) => ({ ...r, shape: x.name }))));
  assert.ok(runs.every((r) => r.font === "Calibri"), "the brand font is the only typeface");
  const body = runs.filter((r) => /^(Situation Text|Helps Text|Intro|Block \d+ Text|Step \d+ Text|Fact \d+ Text)$/.test(r.shape));
  assert.ok(body.length > 10);
  assert.ok(body.every((r) => !r.bold), "body text is regular weight");
  const titles = read.slides.map((s) => parseAllShapes(s.xml).find((x) => x.placeholder));
  assert.ok(titles.every((t) => t.runs[0].bold), "titles are bold");
  const headings = runs.filter((r) => /Heading$/.test(r.shape));
  assert.ok(headings.length > 10 && headings.every((r) => r.bold), "card headings are bold");
  // Without a brand font the sample's Semibold face is used as it is: no run is forced bold except a lead-in.
  const plain = render(ctx.topic).read.slides.flatMap((s) => parseAllShapes(s.xml).flatMap((x) => x.runs));
  assert.ok(plain.filter((r) => r.bold).every((r) => r.font === FONTS.heading), "only heading-face runs are ever bold");
  assert.ok(plain.filter((r) => r.font === FONTS.heading && !r.bold).length > 50, "headings are Segoe UI Semibold, not forced bold");
});

test("a lab-day deck with a brand font no longer bolds all of its body text, and the plain lab-day deck is untouched by the design change", async () => {
  const lab = await generateLab({ ...SAMPLE_LABS.level100 }, offline);
  const branded = renderMarkdownToPptxBuffer(lab.markdown, { title: lab.manifest.title, manifest: lab.manifest, branding: { font: "calibri", primaryColor: "#0b3d91" } });
  const runs = readDeck(branded).slides.flatMap((s) => parseAllShapes(s.xml).flatMap((x) => x.runs));
  const share = runs.filter((r) => r.bold).length / runs.length;
  assert.ok(share < 0.6, `${(share * 100).toFixed(0)}% of lab-day runs are bold under a brand font (was every run)`);
  assert.deepEqual(checkPptxPackage(branded, { expectNotes: true }), []);
  const plain = readDeck(renderMarkdownToPptxBuffer(lab.markdown, { title: lab.manifest.title, manifest: lab.manifest })).slides.map((s) => s.xml).join("\n");
  assert.doesNotMatch(plain, /adec:decorative/, "the lab-day deck does not use the training design's decorative flag");
  assert.doesNotMatch(plain, /10303F/, "or its navy");
});

// ── Brand mapping ────────────────────────────────────────────────────────────

test("a brand profile maps its colors onto the accent, highlight, and dark roles, and its font onto both font roles, with the same layouts", () => {
  const brand = BRANDS.navyBlue;
  const d = resolveDesign(brand, "Calibri");
  const slides = slidesOf(ctx.complete, "navyBlue");
  const cover = slides[0];
  assert.equal(cover.bg, d.navy, "the dark role comes from the brand's primary color");
  assert.notEqual(d.navy, P.navy);
  assert.ok(contrastRatio("FFFFFF", d.navy) >= 11);
  assert.equal(byName(cover.shapes, "Coral Bar").fill, d.highlight, "the highlight role is the brand's secondary color");
  assert.equal(d.highlight, "C43E1C");
  const circles = named(cover.shapes, /^Circle \d$/);
  assert.equal(circles[0].fill, d.accent, "the accent role is the brand's primary color");
  assert.equal(d.accent, "0B3D91");
  const xml = slides.map((s) => s.slide.xml).join("\n");
  assert.doesNotMatch(xml, new RegExp(P.teal), "the sample teal is gone");
  assert.match(xml, /Fabrikam internal training/);
  assert.equal(slides[1].shapes.find((x) => x.name === "Title").runs[0].font, "Calibri");
  // Same layouts: the same shapes in the same order on every slide, and the chrome (title, eyebrow, footer, number) in the same places.
  const plain = slidesOf(ctx.complete);
  const namesOf = (s) => s.shapes.filter((x) => x.name !== "Logo Plate").map((x) => x.name);
  assert.deepEqual(slides.map(namesOf), plain.map(namesOf), "the same shapes in the same order on every slide (the logo's plate aside)");
  const chromePlaces = (s) => s.shapes.filter((x) => ["Eyebrow", "Footer Context", "Slide Counter"].includes(x.name) || (x.name === "Title" && s.spec.kind !== "title")).map((x) => [x.name, x.x, x.y]);
  assert.deepEqual(slides.map(chromePlaces), plain.map(chromePlaces), "chrome never moves with the brand");
  // A light brand color is darkened to carry white text, and the logo sits on a white plate on the dark cover.
  const light = resolveDesign(BRANDS.lightYellow, null);
  assert.ok(contrastRatio("FFFFFF", light.accent) >= 4.5 && light.accent !== "FFD400");
  assert.ok(byName(cover.shapes, "Logo Plate"), "the logo is on a plate");
  assert.equal(byName(cover.shapes, "Logo Plate").fill, "FFFFFF");
  // A profile that sets only a font keeps the sample colors.
  const fontOnly = resolveDesign({ primaryColor: "#4f8ff7", font: "arial" }, "Arial");
  assert.equal(fontOnly.accent, P.teal);
  assert.equal(fontOnly.navy, P.navy);
  assert.equal(fontOnly.font.body, "Arial");
  assert.deepEqual(checkPptxPackage(render(ctx.complete, "navyBlue").buffer, { expectNotes: true }), []);
});

// ── Harness colors ───────────────────────────────────────────────────────────

test("in a combined deck every harness color sits beside the harness name: dividers, agenda, title pills, part tags, and the compare slide", () => {
  const slides = slidesOf(ctx.bothComplete);
  const d = resolveDesign();
  const names = { standard: "Standard (Classic)", "microsoft-copilot": "Microsoft Copilot" };
  const colorOf = (id) => d.harness[id].fill;
  const cover = slides[0];
  const pills = named(cover.shapes, /^Tag \d+$/);
  for (const id of Object.keys(names)) {
    const pill = pills.find((x) => x.text === names[id]);
    assert.ok(pill && pill.fill === colorOf(id), `the cover names ${names[id]} in its color`);
  }
  const agenda = slides.find((s) => s.spec.kind === "agenda");
  for (const row of agenda.spec.body.rows.filter((r) => r.harness)) {
    const pill = byName(agenda.shapes, `Agenda ${row.n} Harness`);
    assert.deepEqual([pill.text, pill.fill], [names[row.harness], colorOf(row.harness)], "the agenda row names its harness");
    assert.equal(byName(agenda.shapes, `Agenda ${row.n} Number`).fill, colorOf(row.harness));
  }
  const dividers = slides.filter((s) => s.spec.kind === "divider");
  const harnessDividers = dividers.filter((s) => s.spec.body.rows[s.spec.body.current].harness);
  assert.equal(harnessDividers.length, 2);
  for (const s of harnessDividers) {
    const id = s.spec.body.rows[s.spec.body.current].harness;
    assert.equal(byName(s.shapes, "Part Panel").fill, colorOf(id));
    assert.match(byName(s.shapes, "Part Time").text.toUpperCase(), new RegExp(names[id].toUpperCase().replace(/[()]/g, "\\$&")), "the panel says which harness");
  }
  const sharedDivider = dividers.find((s) => !s.spec.body.rows[s.spec.body.current].harness);
  assert.equal(byName(sharedDivider.shapes, "Part Panel").fill, d.accent, "a shared part is the neutral accent");
  const compare = slides.find((s) => s.spec.kind === "compare");
  assert.deepEqual(named(compare.shapes, /^Harness \d Heading$/).map((h) => [h.text, h.fill]), [["Standard (Classic)", colorOf("standard")], ["Microsoft Copilot", colorOf("microsoft-copilot")]]);
  const tagged = slides.filter((s) => byName(s.shapes, "Part Tag"));
  assert.ok(tagged.length > 20, "content slides of a combined deck carry a part tag");
  for (const s of tagged) {
    const tag = byName(s.shapes, "Part Tag");
    const id = Object.keys(names).find((key) => names[key] === tag.text);
    if (id) assert.equal(tag.fill, colorOf(id), "a harness tag is in its harness color, with its name");
    else assert.equal(tag.text, "Both harnesses");
  }
  // Colors keep one meaning: a harness color in a single-harness deck still comes with the harness name.
  const harnessFills = new Set([P.green, P.purple]);
  const stray = slidesOf(ctx.complete).flatMap((s) => s.shapes.filter((x) => harnessFills.has(x.fill) && !/standard|microsoft copilot/i.test(x.text)).map((x) => `slide ${s.number} "${x.name}"`));
  assert.deepEqual(stray, [], "no harness color without a harness name");
});

// ── Versions and saved decks ─────────────────────────────────────────────────

test("a deck saved under the previous layout (schema 2) is rebuilt on the next view, and the lab's own text is not rewritten", async () => {
  assert.equal(TRAINING_SCHEMA_VERSION, 3);
  const built = await buildSampleLabs(["level100"]);
  cleanups.push(built.cleanup);
  const dir = built.labs.level100.outputDir;
  const digest = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
  const before = { index: digest(join(dir, "index.md")), manifest: digest(join(dir, "manifest.json")) };
  const first = ensureGeneratedLabTrainingDecks(dir);
  const complete = first.summary.decks.find((d) => d.kind === "complete");
  const deckFile = join(dir, "training", complete.fileName);
  const fresh = digest(deckFile);
  // Make the saved state and file look like version 2 built them.
  const stateFile = join(dir, "training", TRAINING_STATE_FILE);
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  writeFileSync(stateFile, JSON.stringify({ ...state, schemaVersion: 2 }));
  writeFileSync(deckFile, Buffer.concat([readFileSync(deckFile), Buffer.from("old-layout")]));
  assert.notEqual(digest(deckFile), fresh);
  const second = ensureGeneratedLabTrainingDecks(dir);
  assert.equal(second.summary.schemaVersion, 3);
  assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).schemaVersion, 3, "the state is rewritten at version 3");
  const rebuilt = readDeck(readFileSync(deckFile));
  assert.ok(rebuilt.slides[0].xml.includes(P.navy), "the rebuilt deck has the new look");
  assert.deepEqual(rebuilt.problems, []);
  assert.deepEqual({ index: digest(join(dir, "index.md")), manifest: digest(join(dir, "manifest.json")) }, before, "the lab text is untouched");
});
