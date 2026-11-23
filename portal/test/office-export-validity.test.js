import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateLab } from "../lib/lab-builder/generator.js";
import { buildZipBuffer, renderMarkdownToDocxBuffer } from "../lib/lab-builder/docx-builder.js";
import { renderTopicToPptxBuffer } from "../lib/lab-builder/pptx-builder.js";
import { readGeneratedLabTopicDocument } from "../lib/lab-builder/generated-labs.js";
import { TOPIC_DOCUMENTS_SCHEMA_VERSION } from "../lib/lab-builder/topic-documents.js";
import {
  checkDocxPackage,
  checkPptxPackage,
  readZipStrict,
} from "../../tools/lab-builder/lib/ooxml-strict.mjs";
import {
  NASTY_TEXT,
  buildOfficeMatrix,
  buildTopicMarkdown,
  makePng,
  writeMatrixFiles,
} from "../../tools/lab-builder/lib/office-matrix.mjs";
import { prepareOpenXmlValidator, runOpenXmlValidator } from "../../tools/lab-builder/lib/openxml-validator.mjs";

process.env.LAB_BUILDER_VENDOR_DOCS = "off";
process.env.LAB_BUILDER_LINK_CHECK = "off";

/*
 * Office exports must open in real PowerPoint and Word, which reject packages that lenient readers
 * (python-pptx, the Open XML SDK validator) accept. These tests encode the invariants as strict,
 * dependency-free checks (tools/lab-builder/lib/ooxml-strict.mjs) over a matrix of generated exports.
 * For the real-application check use `node tools/lab-builder/validate-office.mjs`.
 */

function topicDeck() {
  const png = makePng(4, 3);
  return renderTopicToPptxBuffer(buildTopicMarkdown(), {
    title: "Strict invariants deck",
    branding: { companyName: "Contoso", primaryColor: "#0F6CBD", logoBuffer: png },
    resolveImageBuffer: () => png,
    topic: { labTitle: "Healthcare Patient Support Lab", stepLabel: "Step 2", topicTitle: "Ground on SharePoint knowledge" },
  });
}

/** Rewrite a package: `edit` receives the entry map (name -> Buffer) and may add, remove, or change parts. */
function rewrite(buffer, edit, { order } = {}) {
  const zip = readZipStrict(buffer);
  assert.deepEqual(zip.problems, [], "the starting package must be clean");
  const entries = new Map(zip.entries);
  edit(entries);
  const names = order ? order(entries) : [...entries.keys()];
  return buildZipBuffer(names.map((name) => ({ name, data: entries.get(name) })));
}

const text = (entries, name) => entries.get(name).toString("utf8");

test("the strict checker accepts a clean deck and flags each defect that Office (or the schema) rejects", () => {
  const good = topicDeck();
  assert.deepEqual(checkPptxPackage(good, { expectNotes: true }), []);

  const expectProblem = (label, mutate, pattern) => {
    const problems = checkPptxPackage(rewrite(good, mutate));
    assert.ok(problems.some((p) => pattern.test(p)), `${label}: expected ${pattern}, got ${JSON.stringify(problems.slice(0, 5))}`);
  };

  // The root cause of "PowerPoint says the file is corrupted": the notes master shared the slide master's theme part.
  expectProblem(
    "notes master shares theme1.xml",
    (e) => {
      e.set("ppt/notesMasters/_rels/notesMaster1.xml.rels", Buffer.from(text(e, "ppt/notesMasters/_rels/notesMaster1.xml.rels").replace("theme2.xml", "theme1.xml")));
      e.delete("ppt/theme/theme2.xml");
      e.set("[Content_Types].xml", Buffer.from(text(e, "[Content_Types].xml").replace(/<Override PartName="\/ppt\/theme\/theme2\.xml"[^>]*\/>\s*/, "")));
    },
    /shares theme part/,
  );
  expectProblem("notes master without its own theme", (e) => {
    e.set("ppt/notesMasters/_rels/notesMaster1.xml.rels", Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`));
  }, /exactly one theme relationship/);

  expectProblem("illegal XML character", (e) => e.set("ppt/slides/slide1.xml", Buffer.from(text(e, "ppt/slides/slide1.xml").replace("<a:t>", "<a:t>bad\uFFFE"))), /illegal XML character U\+FFFE/);
  expectProblem("schema child order", (e) => {
    const xml = text(e, "ppt/slides/slide2.xml");
    e.set("ppt/slides/slide2.xml", Buffer.from(xml.replace(/(<a:off [^>]*\/>)(\s*)(<a:ext [^>]*\/>)/, "$3$2$1")));
  }, /schema order/);
  expectProblem("duplicate shape id", (e) => e.set("ppt/slides/slide2.xml", Buffer.from(text(e, "ppt/slides/slide2.xml").replace(/<p:cNvPr id="3"/, '<p:cNvPr id="2"'))), /duplicate shape id/);
  expectProblem("layout id below 2147483648", (e) => e.set("ppt/slideMasters/slideMaster1.xml", Buffer.from(text(e, "ppt/slideMasters/slideMaster1.xml").replace('id="2147483649"', 'id="1000"'))), /must be between 2147483648/);
  expectProblem("layout id collides with the master id", (e) => e.set("ppt/slideMasters/slideMaster1.xml", Buffer.from(text(e, "ppt/slideMasters/slideMaster1.xml").replace('id="2147483649"', 'id="2147483648"'))), /already used/);
  expectProblem("slide id below 256", (e) => e.set("ppt/presentation.xml", Buffer.from(text(e, "ppt/presentation.xml").replace('<p:sldId id="256"', '<p:sldId id="12"'))), /256\.\.2147483647/);
  expectProblem("slide part without its content type", (e) => e.set("[Content_Types].xml", Buffer.from(text(e, "[Content_Types].xml").replace(/<Override PartName="\/ppt\/slides\/slide1\.xml"[^>]*\/>\s*/, ""))), /content type must be/);
  expectProblem("relationship to a missing part", (e) => e.set("ppt/slides/_rels/slide1.xml.rels", Buffer.from(text(e, "ppt/slides/_rels/slide1.xml.rels").replace("slideLayout1.xml", "slideLayout9.xml"))), /targets missing part/);
  expectProblem("font size outside 100..400000", (e) => e.set("ppt/slides/slide1.xml", Buffer.from(text(e, "ppt/slides/slide1.xml").replace(/(<a:rPr[^>]*?) sz="\d+"/, '$1 sz="50"'))), /between 100 and 400000/);
  expectProblem("fractional EMU value", (e) => e.set("ppt/slides/slide1.xml", Buffer.from(text(e, "ppt/slides/slide1.xml").replace(/<a:off x="\d+"/, '<a:off x="1.5"'))), /must be an integer/);
  expectProblem("negative extent", (e) => e.set("ppt/slides/slide1.xml", Buffer.from(text(e, "ppt/slides/slide1.xml").replace(/<a:ext cx="\d+"/, '<a:ext cx="-5"'))), /must not be negative/);
  expectProblem("undeclared namespace prefix", (e) => e.set("ppt/slides/slide1.xml", Buffer.from(text(e, "ppt/slides/slide1.xml").replace("</p:spTree>", "<q:extra/></p:spTree>"))), /undeclared namespace prefix/);
  expectProblem("orphan part", (e) => e.set("ppt/orphan.xml", Buffer.from('<?xml version="1.0" encoding="UTF-8"?><a:x xmlns:a="urn:x"/>')), /orphan part/);
  expectProblem("notes slide without a slide image placeholder", (e) => e.set("ppt/notesSlides/notesSlide1.xml", Buffer.from(text(e, "ppt/notesSlides/notesSlide1.xml").replace('type="sldImg"', 'type="dt"'))), /missing the 'sldImg'/);
  expectProblem("app.xml notes count out of sync", (e) => e.set("docProps/app.xml", Buffer.from(text(e, "docProps/app.xml").replace(/<Notes>\d+<\/Notes>/, "<Notes>0</Notes>"))), /<Notes> is 0/);
  expectProblem("empty r:embed", (e) => e.set("ppt/slides/slide1.xml", Buffer.from(text(e, "ppt/slides/slide1.xml").replace(/r:embed="[^"]*"/, 'r:embed=""'))), /empty r:embed/);
  const reordered = rewrite(good, () => {}, { order: (e) => [...[...e.keys()].filter((n) => n !== "[Content_Types].xml"), "[Content_Types].xml"] });
  assert.ok(checkPptxPackage(reordered).some((p) => /first entry must be \[Content_Types\]\.xml/.test(p)));
});

test("the strict checker flags WordprocessingML defects that Word or the schema rejects", () => {
  const good = renderMarkdownToDocxBuffer("# Title\n\nBody with a [link](https://learn.microsoft.com/en-us/) and `code`.\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n", { title: "Doc" });
  assert.deepEqual(checkDocxPackage(good), []);

  const expectProblem = (label, mutate, pattern) => {
    const problems = checkDocxPackage(rewrite(good, mutate));
    assert.ok(problems.some((p) => pattern.test(p)), `${label}: expected ${pattern}, got ${JSON.stringify(problems.slice(0, 5))}`);
  };
  expectProblem("run properties out of order", (e) => e.set("word/document.xml", Buffer.from(text(e, "word/document.xml").replace("<w:body>", '<w:body><w:p><w:r><w:rPr><w:u w:val="single"/><w:color w:val="112233"/></w:rPr><w:t>x</w:t></w:r></w:p>'))), /schema order/);
  expectProblem("illegal XML character", (e) => e.set("word/document.xml", Buffer.from(text(e, "word/document.xml").replace("<w:body>", "<w:body><w:p><w:r><w:t>bad\uFFFF</w:t></w:r></w:p>"))), /illegal XML character U\+FFFF/);
  expectProblem("table cell not ending in a paragraph", (e) => e.set("word/document.xml", Buffer.from(text(e, "word/document.xml").replace(/<w:tc>([\s\S]*?)<\/w:p><\/w:tc>/, "<w:tc>$1</w:p><w:tbl><w:tblGrid/></w:tbl></w:tc>"))), /<w:tc> must end with a <w:p>/);
  expectProblem("section properties not last", (e) => e.set("word/document.xml", Buffer.from(text(e, "word/document.xml").replace("</w:body>", "<w:p/></w:body>"))), /final child of <w:body> must be <w:sectPr>/);
  expectProblem("unknown style", (e) => e.set("word/document.xml", Buffer.from(text(e, "word/document.xml").replace('<w:pStyle w:val="Heading1"/>', '<w:pStyle w:val="NoSuchStyle"/>'))), /unknown style/);
});

let matrix;
before(async () => {
  matrix = await buildOfficeMatrix();
});
after(() => matrix?.cleanup());

test("every PPTX and DOCX export in the matrix passes the strict package checks", () => {
  const failures = [];
  for (const c of matrix.cases) {
    const problems = c.kind === "pptx" ? checkPptxPackage(c.buffer, { expectNotes: c.expectNotes }) : checkDocxPackage(c.buffer);
    if (problems.length) failures.push(`${c.kind} ${c.id} (${c.label}):\n    ${[...new Set(problems)].slice(0, 6).join("\n    ")}`);
  }
  assert.deepEqual(failures, [], `\n${failures.join("\n")}`);
});

test("the matrix covers branding with PNG and JPEG logos, images, special characters, large decks, ZIP bundles, and facilitator guides", () => {
  const pptx = matrix.cases.filter((c) => c.kind === "pptx");
  const docx = matrix.cases.filter((c) => c.kind === "docx");
  assert.ok(pptx.length >= 40 && docx.length >= 40, `matrix too small: ${pptx.length} decks, ${docx.length} documents`);

  const stats = pptx.map((c) => {
    const names = [...readZipStrict(c.buffer).entries.keys()];
    return {
      id: c.id,
      slides: names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).length,
      notes: names.filter((n) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n)).length,
      png: names.some((n) => /^ppt\/media\/.*\.png$/.test(n)),
      jpeg: names.some((n) => /^ppt\/media\/.*\.jpe?g$/.test(n)),
    };
  });
  assert.ok(stats.some((s) => s.slides >= 200), "a deck with at least 200 slides");
  assert.ok(stats.some((s) => s.png) && stats.some((s) => s.jpeg), "PNG and JPEG media");
  assert.ok(stats.every((s) => s.notes > 0), "every deck carries speaker notes");
  for (const needle of ["special-characters", "large-topic", "lab-small-full-branded", "lab-large-full-plain", "zip", "facilitator"]) {
    assert.ok(matrix.cases.some((c) => c.id.includes(needle)), `matrix includes ${needle}`);
  }
  assert.ok(matrix.cases.some((c) => c.id.includes("topic-plain")) && matrix.cases.some((c) => c.id.includes("topic-branded")));
});

test("a deck's notes master owns its own theme part and every master/layout id is unique and at least 2147483648", () => {
  const entries = readZipStrict(topicDeck()).entries;
  assert.ok(entries.has("ppt/theme/theme1.xml") && entries.has("ppt/theme/theme2.xml"));
  assert.match(text(entries, "ppt/slideMasters/_rels/slideMaster1.xml.rels"), /Target="\.\.\/theme\/theme1\.xml"/);
  assert.match(text(entries, "ppt/notesMasters/_rels/notesMaster1.xml.rels"), /Target="\.\.\/theme\/theme2\.xml"/);
  assert.match(text(entries, "[Content_Types].xml"), /PartName="\/ppt\/theme\/theme2\.xml" ContentType="application\/vnd\.openxmlformats-officedocument\.theme\+xml"/);
  const ids = [...text(entries, "ppt/presentation.xml").matchAll(/<p:sldMasterId id="(\d+)"/g), ...text(entries, "ppt/slideMasters/slideMaster1.xml").matchAll(/<p:sldLayoutId id="(\d+)"/g)].map((m) => Number(m[1]));
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => id >= 2147483648));
});

test("text with XML-illegal characters is sanitized in every Office part", () => {
  for (const c of matrix.cases.filter((x) => x.id.includes("special"))) {
    const { entries } = readZipStrict(c.buffer);
    for (const [name, data] of entries) {
      if (!/\.(xml|rels)$/.test(name)) continue;
      assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/.test(data.toString("utf8")), `${c.id}: ${name} contains an illegal XML character`);
    }
  }
  assert.match(NASTY_TEXT, /\uFFFE/, "the fixture really contains the characters under test");
});

test("a lab generated before the theme fix regenerates its cached per-topic decks on demand and serves valid decks", async () => {
  assert.ok(TOPIC_DOCUMENTS_SCHEMA_VERSION >= 4, "the schema version was bumped so stale per-topic caches regenerate");
  const root = mkdtempSync(join(tmpdir(), "stale-topic-decks-"));
  try {
    const built = await generateLab(
      {
        title: "Stale Cache Lab",
        industry: "healthcare",
        departments: ["customer-service"],
        products: ["copilot-studio"],
        harness: "standard",
        level: 100,
        features: ["knowledge-sharepoint"],
        includeKnowledgeCheck: true,
      },
      { outputRoot: root, useLearnMcp: false, useLlm: false },
    );
    const topicsDir = join(built.outputDir, "topics");
    const pptxFiles = readdirSync(topicsDir).filter((f) => f.endsWith(".pptx"));
    assert.ok(pptxFiles.length >= 1);

    // Re-create what the previous version wrote: the notes master pointing at the slide master's theme.
    const downgrade = (buffer) =>
      rewrite(buffer, (e) => {
        e.set("ppt/notesMasters/_rels/notesMaster1.xml.rels", Buffer.from(text(e, "ppt/notesMasters/_rels/notesMaster1.xml.rels").replace("theme2.xml", "theme1.xml")));
        e.delete("ppt/theme/theme2.xml");
        e.set("[Content_Types].xml", Buffer.from(text(e, "[Content_Types].xml").replace(/<Override PartName="\/ppt\/theme\/theme2\.xml"[^>]*\/>\s*/, "")));
      });
    for (const f of pptxFiles) {
      const stale = downgrade(readFileSync(join(topicsDir, f)));
      assert.ok(checkPptxPackage(stale).some((p) => /shares theme part/.test(p)));
      writeFileSync(join(topicsDir, f), stale);
    }
    const manifestPath = join(built.outputDir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.topicDocumentsVersion = 3;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    // Step 8 download path: the first request regenerates the stale cache.
    const served = readGeneratedLabTopicDocument(root, built.labId, 1, "pptx");
    assert.equal(served.status, 200);
    assert.deepEqual(checkPptxPackage(served.buffer, { expectNotes: true }), []);

    for (const f of pptxFiles) {
      assert.deepEqual(checkPptxPackage(readFileSync(join(topicsDir, f)), { expectNotes: true }), [], `${f} on disk was regenerated`);
    }
    assert.equal(JSON.parse(readFileSync(manifestPath, "utf8")).topicDocumentsVersion, TOPIC_DOCUMENTS_SCHEMA_VERSION);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the matrix includes the pre-lab training decks: plain, branded, and inside the ZIP bundles", () => {
  const training = matrix.cases.filter((c) => c.kind === "pptx" && /training deck/i.test(c.label));
  assert.ok(training.filter((c) => /\(plain\)/.test(c.label)).length >= 6, "the complete, foundations, and topic decks of the sample labs");
  assert.ok(training.filter((c) => /\(branded\)/.test(c.label)).length >= 6, "the same decks with a brand profile and a logo");
  assert.ok(training.filter((c) => /\((?:plain|branded)\)/.test(c.label)).every((c) => c.expectNotes === true), "every training slide has speaker notes");
  assert.ok(matrix.cases.some((c) => /ZIP bundle entry 1 - Training decks \(deliver first\)\/Training - complete\.pptx/.test(c.label)), "the ZIP's training folder");
});

test("the Open XML SDK validator reports zero schema errors for the whole matrix (skips without the .NET SDK)", { timeout: 300000 }, (t) => {
  if (process.env.LAB_BUILDER_OXML_VALIDATOR === "off") return t.skip("LAB_BUILDER_OXML_VALIDATOR=off");
  const prepared = prepareOpenXmlValidator();
  if (prepared.skip) return t.skip(prepared.skip);

  const dir = mkdtempSync(join(tmpdir(), "oxml-matrix-"));
  try {
    const files = writeMatrixFiles(matrix.cases, dir);
    const results = runOpenXmlValidator(prepared.dll, files.map((f) => f.file));
    const failures = [];
    for (const f of files) {
      const row = results.get(f.file);
      if (!row) failures.push(`${f.id}: no validator output`);
      else if (!row.opened) failures.push(`${f.id}: ${row.openError}`);
      else if (row.errorCount > 0) failures.push(`${f.id}: ${row.errors.slice(0, 3).map((e) => `${e.part} ${e.path} ${e.description}`).join(" | ")}`);
    }
    assert.deepEqual(failures, []);
    assert.equal(results.size, files.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
