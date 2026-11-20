import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

import { generateLab } from "../lib/lab-builder/generator.js";
import { readGeneratedLab } from "../lib/lab-builder/generated-labs.js";
import { renderGeneratedLabMarkdown } from "../lib/exporter.js";
import { cleanStep } from "../lib/lab-builder/steps.js";
import {
  SUB_STEP_NOTE,
  flattenStepLegacy,
  joinStep,
  repairRunOnStep,
  repairRunOnSteps,
  splitStep,
  stepLeadSentence,
  stepPlainLines,
  stepToMarkdown,
  subStepLabel,
} from "../lib/lab-builder/sub-steps.js";
import { renderLabMarkdown } from "../lib/markdown.js";
import { renderLabMarkdownFallback, renderStandaloneLabHtml } from "../lib/lab-builder/html-lab.js";
import { renderMarkdownToDocxBuffer } from "../lib/lab-builder/docx-builder.js";
import { renderMarkdownToPdfBuffer } from "../lib/lab-builder/pdf-builder.js";
import { renderTopicToPptxBuffer } from "../lib/lab-builder/pptx-builder.js";
import { scanLabMarkdown } from "../lib/lab-builder/lab-gate.js";
import {
  extractModuleStepsFromMarkdown,
  hashSteps,
  instructionList,
  updateLabModuleStepsInMarkdown,
} from "../lib/lab-builder/lab-screenshots.js";
import { checkDocxPackage, checkPptxPackage, readZipStrict } from "../../tools/lab-builder/lib/ooxml-strict.mjs";
import { buildTopicMarkdown, makePng } from "../../tools/lab-builder/lib/office-matrix.mjs";

const LEARN = "https://learn.microsoft.com/en-us/microsoft-copilot-studio";

process.env.LAB_BUILDER_VENDOR_DOCS = "off";
process.env.LAB_BUILDER_LINK_CHECK = "off";

// The two steps from the report, in the one-sentence form older labs contain. "form scratch" is Learn's own typo.
const STEP5_LEAD =
  "On the Home page or on the Agents page, enter a brief description of what you want your agent to do. The description can have up to 1,024 characters. Choose from:";
const STEP5_RUN_ON = `${STEP5_LEAD} (a) On the Home page, select Agent under Start building form scratch; (b) On the Agents page, select Create blank agent, enter a name for the agent, optionally select Advanced settings to change the primary language, solution, and schema name for your agent, and select Create.`;
const STEP8_LEAD = "Depending on your agent's purposes, you can:";
const STEP8_RUN_ON = `${STEP8_LEAD} (a) [Change your agent's primary AI model](${LEARN}/authoring-select-agent-model); (b) [Add triggers](${LEARN}/authoring-triggers-about); (c) Add knowledge sources; (d) Add tools; (e) Add other agents; (f) Add topics.`;

const labMarkdown = (steps) => `### Step 1 - Create an agent

**Do this**

${steps.join("\n")}

**Check your work**

- [ ] The agent appears.
`;
const RUN_ON_LAB = labMarkdown(["1. Open Copilot Studio.", "2. Name the agent.", "3. Choose a model.", "4. Save it.", `5. ${STEP5_RUN_ON}`, "6. Test it.", "7. Publish it.", `8. ${STEP8_RUN_ON}`]);
const STRUCTURED_LAB = repairRunOnSteps(RUN_ON_LAB);

test("the one-sentence form of both reported steps is split into the lead plus lettered sub-steps, in Learn's words", () => {
  const five = splitStep(repairRunOnStep(STEP5_RUN_ON));
  assert.equal(five.lead, STEP5_LEAD);
  assert.deepEqual(five.subSteps, [
    "On the Home page, select Agent under Start building form scratch.",
    "On the Agents page, select Create blank agent, enter a name for the agent, optionally select Advanced settings to change the primary language, solution, and schema name for your agent, and select Create.",
  ]);

  const eight = splitStep(repairRunOnStep(STEP8_RUN_ON));
  assert.equal(eight.lead, STEP8_LEAD);
  assert.equal(eight.subSteps.length, 6);
  assert.equal(eight.subSteps[0], `[Change your agent's primary AI model](${LEARN}/authoring-select-agent-model).`, "links stay links");
  assert.equal(eight.subSteps[5], "Add topics.");

  assert.equal(
    stepToMarkdown(repairRunOnStep(STEP5_RUN_ON), 5),
    [`5. ${STEP5_LEAD}  `, `   a. ${five.subSteps[0]}  `, `   b. ${five.subSteps[1]}`].join("\n"),
    "indented under the number, hard breaks keep GitHub on separate lines",
  );
  assert.deepEqual(STRUCTURED_LAB.split("\n").filter((line) => /^\s+[a-f]\.\s/.test(line)).length, 8);
});

test("the repair leaves ordinary parentheses alone, keeps the more-choices note, and is idempotent", () => {
  for (const text of [
    "Pick a pet (a) cat; (b) dog, whichever you like.",
    "You can (a) cat only.",
    "Choose from: (a) First; (c) Third.",
    "Select **Save** (a) once; (b) twice.",
    "Choose from: (a) ; (b) .",
  ]) {
    assert.equal(repairRunOnStep(text), null, text);
  }
  const prose = "1. Use the (a) option on the left.\n2. Then (a) cat; (b) dog is just a list of words.\n\n```text\n5. Choose from: (a) X; (b) Y.\n```\n";
  assert.equal(repairRunOnSteps(prose), prose, "no list, wrong lead, and fenced code are untouched");

  const withNote = repairRunOnStep("Pick a source: (a) Files; (b) Websites; more in the linked article.");
  assert.equal(withNote, `Pick a source:\na. Files.\nb. Websites.\n${SUB_STEP_NOTE}`);
  assert.equal(flattenStepLegacy(withNote), "Pick a source: (a) Files; (b) Websites; more in the linked article.", "hashing keeps the old form");

  const once = repairRunOnSteps(RUN_ON_LAB);
  assert.notEqual(once, RUN_ON_LAB);
  assert.equal(repairRunOnSteps(once), once, "applying it again changes nothing");
  assert.equal(repairRunOnSteps(RUN_ON_LAB.replace(/\n/g, "\r\n")).replace(/\r\n/g, "\n"), once, "CRLF input works");
  assert.ok(!/\(a\)/.test(once));
  assert.equal(subStepLabel(0) + subStepLabel(25) + subStepLabel(26) + subStepLabel(27), "azaaab");
});

test("a step with one sub-step reads as one sentence, and a plain step is never turned into a list", () => {
  assert.equal(stepToMarkdown(joinStep("Pick one. Choose from:", ["Select **Save**."]), 3), "3. Pick one. Select **Save**.");
  assert.equal(stepToMarkdown("Select **Save**.", 2), "2. Select **Save**.");
  assert.equal(stepLeadSentence(joinStep(STEP5_LEAD, ["A.", "B."])), STEP5_LEAD.replace(/\s*Choose from:$/, ""));
  assert.deepEqual(stepPlainLines(joinStep(STEP8_LEAD, ["One.", "Two."], SUB_STEP_NOTE)), [STEP8_LEAD, "a. One.", "b. Two.", SUB_STEP_NOTE]);
});

for (const [name, render] of [
  ["the portal's Markdown renderer", renderLabMarkdown],
  ["the built-in HTML fallback renderer", renderLabMarkdownFallback],
]) {
  test(`${name} draws each lettered sub-step as its own item in a nested ordered list`, () => {
    for (const source of [STRUCTURED_LAB, RUN_ON_LAB]) {
      const html = render(source);
      const lists = html.match(/<ol type="a" class="lab-substeps">/g) || [];
      assert.equal(lists.length, 2, "one nested lettered list for each of the two steps");
      assert.match(html, /Choose from:\s*<ol type="a" class="lab-substeps"><li>On the Home page, select Agent under Start building form scratch\.<\/li><li>On the Agents page, select Create blank agent/);
      const eight = html.slice(html.indexOf("you can:"));
      assert.equal((eight.match(/<li>/g) || []).length, 6, "six sub-steps under step 8");
      assert.match(eight, new RegExp(`<a href="${LEARN}/authoring-select-agent-model"[^>]*>Change your agent(?:'|&#39;)s primary AI model</a>`), "links stay clickable");
      assert.match(html, /<li>Open Copilot Studio\.<\/li>/, "a step with no list stays a plain item");
      assert.ok(!/\(a\)|<br>|<li>a\. /.test(html), "no run-on sentence, no hard break, no typed letters");
      assert.equal((html.match(/<ol>/g) || []).length, 1, "the numbered steps are still one list");
    }
  });
}

test("the standalone lab page styles the sub-steps compactly and keeps them together in print", () => {
  const page = renderStandaloneLabHtml(STRUCTURED_LAB, { title: "Lab" });
  assert.match(page, /<ol type="a" class="lab-substeps">/);
  assert.match(page, /ol\.lab-substeps \{[^}]*list-style-type: lower-alpha/);
  assert.match(page, /ol\.lab-substeps > li \{[^}]*break-inside: avoid/);
});

const textOf = (xml) => [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join("");

test("the Word document gets a real second list level lettered a, b, c, not typed letters", () => {
  for (const source of [STRUCTURED_LAB, RUN_ON_LAB]) {
    const docx = renderMarkdownToDocxBuffer(source, { title: "Lab" });
    assert.deepEqual(checkDocxPackage(docx), []);
    const { entries } = readZipStrict(docx);
    const numbering = entries.get("word/numbering.xml").toString("utf8");
    assert.match(numbering, /<w:lvl w:ilvl="1">\s*<w:start w:val="1"\/>\s*<w:numFmt w:val="lowerLetter"\/>\s*<w:lvlText w:val="%2\."\/>/);
    const body = entries.get("word/document.xml").toString("utf8");
    const paragraphs = body.match(/<w:p>[\s\S]*?<\/w:p>/g);
    const level1 = paragraphs.filter((p) => p.includes('<w:ilvl w:val="1"/>'));
    assert.equal(level1.length, 8, "two sub-steps under step 5 and six under step 8");
    const numIds = new Set(paragraphs.filter((p) => p.includes("<w:numPr>")).filter((p) => !/numId w:val="1"/.test(p)).map((p) => /numId w:val="(\d+)"/.exec(p)[1]));
    assert.equal(numIds.size, 1, "sub-steps share the step list, so the letters restart under each step");
    for (const p of level1) assert.ok(!/^[a-f]\.\s/.test(textOf(p)), `no typed letter in: ${textOf(p)}`);
    assert.ok(!/\(a\)/.test(textOf(body)));
    assert.match(level1.find((p) => p.includes("<w:hyperlink")) || "", /primary AI model/, "a link inside a sub-step stays a hyperlink");
    const lead = paragraphs.find((p) => textOf(p).startsWith("On the Home page or on the Agents page"));
    assert.match(lead, /<w:ilvl w:val="0"\/>/);
  }
});

test("the PDF draws the letters as indented lines of their own", () => {
  const raw = renderMarkdownToPdfBuffer(STRUCTURED_LAB, { title: "Lab" });
  const latin = raw.toString("latin1");
  const content = [...latin.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)]
    .map((m) => {
      try {
        return inflateSync(Buffer.from(m[1], "latin1")).toString("latin1");
      } catch {
        return "";
      }
    })
    .join("\n");
  const drawn = (text) => content.includes(`(${text}) Tj`);
  for (const letter of ["a", "b", "c", "d", "e", "f"]) assert.ok(drawn(`${letter}.`), `${letter}. is drawn`);
  assert.ok(drawn("5.") && drawn("8."), "the step numbers are still drawn");
  assert.ok(!content.includes("\\(a\\)"), "no run-on sentence (a literal \"(a)\" would be drawn escaped)");
  const x = (label) => Number(new RegExp(`([\\d.]+) [\\d.]+ Td \\(${label}\\) Tj`).exec(content)?.[1]);
  assert.ok(x("a\\.") > x("5\\."), "a sub-step letter sits to the right of its step number");
});

const slideParagraphs = (slideXml) => (slideXml.match(/<a:p>[\s\S]*?<\/a:p>/g) || []).map((p) => ({ xml: p, text: [...p.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join("") }));

test("slides keep each sub-step on its own indented line, split across slides instead of overflowing", () => {
  const png = makePng(4, 3);
  const deck = renderTopicToPptxBuffer(buildTopicMarkdown({ steps: 12, subSteps: true }), {
    title: "Sub-steps deck",
    branding: { primaryColor: "#0F6CBD", logoBuffer: png },
    resolveImageBuffer: () => png,
    topic: { labTitle: "Retail Lab", stepLabel: "Step 2", topicTitle: "Ground on SharePoint knowledge" },
  });
  assert.deepEqual(checkPptxPackage(deck, { expectNotes: true }), []);
  const { entries } = readZipStrict(deck);
  const slides = [...entries.keys()].filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).map((name) => entries.get(name).toString("utf8"));
  const walk = slides.filter((xml) => xml.includes("Walkthrough Steps"));
  assert.ok(walk.length >= 2, `twelve steps with sub-steps need more than one slide (got ${walk.length})`);

  const all = walk.flatMap(slideParagraphs);
  const subLines = all.filter((p) => /^[ab]\.\s/.test(p.text));
  assert.equal(subLines.length, 12, "six steps with two sub-steps each, every one a paragraph of its own");
  assert.ok(subLines.every((p) => /marL="\d+"/.test(p.xml) && /indent="-\d+"/.test(p.xml)), "indented with a hanging letter");
  assert.ok(all.some((p) => p.text === SUB_STEP_NOTE), "the note keeps its own line");
  assert.ok(!all.some((p) => /\(a\)/.test(p.text)));
  const lead = all.find((p) => p.text.startsWith("1. Perform action 1"));
  assert.ok(lead.text.endsWith("Choose from:"), "the lead does not carry its sub-steps");

  // The step card is about 15 rows of text (about 110 characters wide); no slide may ask for more.
  for (const xml of walk) {
    const rows = slideParagraphs(xml)
      .filter((p) => /^(\d+|[a-z])\.\s/.test(p.text) || p.text === SUB_STEP_NOTE)
      .reduce((sum, p) => sum + Math.max(1, Math.ceil(p.text.length / 110)) + (/^\d/.test(p.text) ? 1 : 0), 0);
    assert.ok(rows <= 20, `a slide asks for ${rows} rows`);
  }
});

test("a step list with no sub-steps keeps its five-per-slide split", () => {
  const deck = renderTopicToPptxBuffer(buildTopicMarkdown({ steps: 10 }), { title: "Plain", topic: { topicTitle: "Plain steps" } });
  const { entries } = readZipStrict(deck);
  const walk = [...entries.keys()].filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).map((name) => entries.get(name).toString("utf8")).filter((xml) => xml.includes("Walkthrough Steps"));
  assert.equal(walk.length, 2);
});

test("the lab gate flags a leftover run-on sentence as polish, and not the lettered form", () => {
  const scan = (markdown) => scanLabMarkdown(markdown, { moduleIds: ["create-agent"] });
  const run = scan(RUN_ON_LAB).findings.find((f) => f.code === "run-on-substeps");
  assert.ok(run, "the one-sentence form is reported");
  assert.equal(run.severity, "polish");
  assert.equal(run.count, 2);
  assert.match(run.message, /list their choices as one long sentence/);
  assert.match(run.message, /\(a\) \.\.\.; \(b\) \.\.\./);
  assert.equal(scan(STRUCTURED_LAB).findings.some((f) => f.code === "run-on-substeps"), false);
});

test("screenshot instructions list each sub-step on its own plain line, for new and old labs", () => {
  const structured = joinStep(STEP5_LEAD, ["On the Home page, select Agent.", "On the Agents page, select Create blank agent."]);
  const expected = [STEP5_LEAD, "a. On the Home page, select Agent.", "b. On the Agents page, select Create blank agent."];
  assert.deepEqual(instructionList([structured]), expected);
  assert.deepEqual(instructionList([STEP5_RUN_ON]).slice(0, 1), [STEP5_LEAD]);
  assert.deepEqual(instructionList(["Select **Save**."]), ["Select **Save**."]);
});

test("reading a lab's steps back and replacing them keeps the sub-steps whole, and the Learn hash is unchanged", () => {
  const mod = { stepLabel: "Step 1" };
  const structured = repairRunOnSteps(labMarkdown(["1. Open it.", `2. ${STEP5_RUN_ON}`, "3. Save it."]));
  const steps = extractModuleStepsFromMarkdown(structured, mod);
  assert.equal(steps.length, 3);
  assert.equal(splitStep(steps[1]).subSteps.length, 2);

  const same = updateLabModuleStepsInMarkdown(structured, { mod, newSteps: steps, sectionHeading: "Create", url: LEARN, fetchedAt: "2026-01-01" });
  assert.deepEqual(extractModuleStepsFromMarkdown(same, mod), steps, "no sub-step line is left behind or duplicated");
  assert.equal((same.match(/^\s+a\. /gm) || []).length, 1);

  const before = hashSteps(["Open it.", STEP5_RUN_ON, "Save it."]);
  assert.equal(hashSteps(steps), before, "the same Learn page hashes the same before and after the layout change");
});

test("an older lab keeps its file as written and shows, previews, and downloads with its sub-steps on their own lines", async () => {
  const root = mkdtempSync(join(tmpdir(), "sub-steps-old-lab-"));
  try {
    const built = await generateLab(
      { title: "Older Lab", industry: "retail", departments: ["customer-service"], products: ["copilot-studio"], harness: "standard", level: 100, features: ["knowledge-sharepoint"] },
      { outputRoot: root, useLearnMcp: false, useLlm: false },
    );
    const indexPath = join(built.outputDir, "index.md");
    const original = readFileSync(indexPath, "utf8");
    const oldForm = original.replace(/^1\. .*$/m, `1. ${STEP5_RUN_ON}`);
    assert.notEqual(oldForm, original);
    writeFileSync(indexPath, oldForm);

    const read = readGeneratedLab(root, built.labId, renderLabMarkdown);
    assert.equal(read.status, 200);
    assert.match(read.body.markdown, /^1\. On the Home page .*Choose from:  \n {3}a\. On the Home page, select Agent/m);
    assert.match(read.body.html, /Choose from:\s*<ol type="a" class="lab-substeps"><li>On the Home page, select Agent/);

    const download = renderGeneratedLabMarkdown(root, built.labId);
    assert.match(download.markdown, /\n {3}b\. On the Agents page, select Create blank agent/);
    assert.ok(!/\(a\) On the Home page/.test(download.markdown));
    assert.equal(readFileSync(indexPath, "utf8"), oldForm, "the file on disk is not rewritten");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Learn list becomes sub-steps end to end, so the lab gate finds no run-on sentence", () => {
  const step = cleanStep(
    ["On the **Home** page or on the **Agents** page, enter a description. Choose from:", "- On the **Home** page, select **Agent**.", "- On the **Agents** page, select **Create blank agent**."],
    LEARN,
  );
  const md = labMarkdown(["1. Open it.", stepToMarkdown(step, 2), "3. Save it."]);
  assert.equal(scanLabMarkdown(md, { moduleIds: ["x"] }).findings.some((f) => f.code === "run-on-substeps"), false);
  assert.match(renderLabMarkdown(md), /<ol type="a" class="lab-substeps"><li>On the <strong>Home<\/strong> page, select <strong>Agent<\/strong>\.<\/li>/);
});
