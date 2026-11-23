import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import vm from "node:vm";

import { generateLab } from "../lib/lab-builder/generator.js";
import {
  buildFacilitatorGuideModel,
  renderFacilitatorGuideDocxBuffer,
  renderFacilitatorGuideHtml,
  renderFacilitatorGuideMarkdown,
  renderFacilitatorGuidePdfBuffer,
} from "../lib/lab-builder/facilitator-guide.js";
import {
  buildPptxFromLabMarkdown,
  buildTopicPptxFromMarkdown,
  renderMarkdownToPptxBuffer,
} from "../lib/lab-builder/pptx-builder.js";
import {
  TOPIC_DOCUMENTS_SCHEMA_VERSION,
  ensureGeneratedLabTopicDocuments,
} from "../lib/lab-builder/topic-documents.js";

process.env.LAB_BUILDER_LINK_CHECK = "off";
process.env.LAB_BUILDER_VENDOR_DOCS = "off";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");

function tempDir(prefix = "facilitator-pptx-notes-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on("error", reject);
  });
}

async function startPortalServer(generatedLabsDir) {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.js"], {
    cwd: join(__dirname, ".."),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      PORTAL_AUTH_DISABLED: "true",
      AZURE_KEYVAULT_URL: "",
      LAB_BUILDER_OUTPUT_DIR: generatedLabsDir,
      LAB_BUILDER_LINK_CHECK: "off",
      LAB_BUILDER_VENDOR_DOCS: "off",
    },
    stdio: "ignore",
  });

  const startedAt = Date.now();
  while (Date.now() - startedAt < 15000) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${child.exitCode}`);
    try {
      const res = await fetch(`${baseUrl}/api/config`);
      if (res.ok) break;
    } catch {
      // Wait until Express starts listening.
    }
    await new Promise((r) => setTimeout(r, 120));
  }

  return {
    baseUrl,
    stop: () =>
      new Promise((resolve) => {
        if (child.killed || child.exitCode !== null) return resolve();
        child.once("exit", () => resolve());
        child.kill();
      }),
  };
}

function parseZipArchive(buffer) {
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  assert.notEqual(eocdOffset, -1, "Expected valid ZIP EOCD signature");
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const cdOffset = buffer.readUInt32LE(eocdOffset + 16);

  const files = new Map();
  let offset = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50, "Expected Central Directory header");
    const method = buffer.readUInt16LE(offset + 10);
    const compSize = buffer.readUInt32LE(offset + 20);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLen).toString("utf8");

    assert.equal(
      buffer.readUInt32LE(localHeaderOffset),
      0x04034b50,
      `Expected Local File header for ${name}`,
    );
    const localNameLen = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localHeaderOffset + 28);
    const flag = buffer.readUInt16LE(localHeaderOffset + 6);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const actualCompSize =
      (flag & 0x08) !== 0 ? compSize : buffer.readUInt32LE(localHeaderOffset + 18) || compSize;
    const rawSlice = buffer.subarray(dataStart, dataStart + actualCompSize);
    const content =
      method === 8 ? inflateRawSync(rawSlice) : method === 0 ? Buffer.from(rawSlice) : null;
    assert.ok(content !== null, `Unsupported ZIP compression method ${method} on ${name}`);
    files.set(name, content);

    offset += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

function assertWellFormedXml(xmlText, entryName) {
  assert.match(
    xmlText,
    /^<\?xml version="1\.0" encoding="UTF-8"/,
    `${entryName} must start with XML declaration`,
  );
  const stripped = xmlText
    .replace(/^<\?xml[^>]*\?>\s*/, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  const badAmp = stripped.match(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/);
  assert.equal(badAmp, null, `${entryName} contains unescaped '&': ${badAmp?.[0]}`);

  const stack = [];
  const tagRegex = /<\/?([A-Za-z_][\w:.-]*)(\s[^<>]*?)?(\/?)>/g;
  let match;
  while ((match = tagRegex.exec(stripped)) !== null) {
    const full = match[0];
    const tagName = match[1];
    const selfClosing = match[3] === "/";
    if (full.startsWith("</")) {
      const top = stack.pop();
      assert.equal(top, tagName, `${entryName}: closing </${tagName}> did not match open <${top}>`);
    } else if (!selfClosing) {
      stack.push(tagName);
    }
  }
  assert.deepEqual(stack, [], `${entryName}: unclosed XML tags remaining: ${stack.join(", ")}`);
}

function assertValidPptxSpeakerNotes(pptxBuffer, label = "deck") {
  const files = parseZipArchive(pptxBuffer);

  // Every XML & RELS file in the archive must be well-formed XML
  for (const [entryName, raw] of files.entries()) {
    if (entryName.endsWith(".xml") || entryName.endsWith(".rels")) {
      assertWellFormedXml(raw.toString("utf8"), `${label}:${entryName}`);
    }
  }

  // [Content_Types].xml must register notesMaster+xml and notesSlide+xml overrides
  const contentTypesXml = files.get("[Content_Types].xml").toString("utf8");
  assert.match(
    contentTypesXml,
    /PartName="\/ppt\/notesMasters\/notesMaster1\.xml"\s+ContentType="application\/vnd\.openxmlformats-officedocument\.presentationml\.notesMaster\+xml"/,
    `${label}: [Content_Types].xml missing notesMaster1.xml override`,
  );
  assert.match(
    contentTypesXml,
    /PartName="\/ppt\/notesSlides\/notesSlide1\.xml"\s+ContentType="application\/vnd\.openxmlformats-officedocument\.presentationml\.notesSlide\+xml"/,
    `${label}: [Content_Types].xml missing notesSlide1.xml override`,
  );

  // ppt/presentation.xml must obey strict ECMA-376 CT_Presentation child element order:
  // sldMasterIdLst -> notesMasterIdLst -> sldIdLst -> sldSz -> notesSz -> defaultTextStyle
  const presentationXml = files.get("ppt/presentation.xml").toString("utf8");
  const idxSldMaster = presentationXml.indexOf("<p:sldMasterIdLst>");
  const idxNotesMaster = presentationXml.indexOf("<p:notesMasterIdLst>");
  const idxSldId = presentationXml.indexOf("<p:sldIdLst>");
  const idxSldSz = presentationXml.indexOf("<p:sldSz ");
  const idxNotesSz = presentationXml.indexOf('<p:notesSz cx="6858000" cy="9144000"/>');
  const idxDefaultText = presentationXml.indexOf("<p:defaultTextStyle>");

  assert.ok(idxSldMaster > 0, `${label}: missing <p:sldMasterIdLst>`);
  assert.ok(
    idxSldMaster < idxNotesMaster,
    `${label}: <p:notesMasterIdLst> must appear after <p:sldMasterIdLst>`,
  );
  assert.ok(
    idxNotesMaster < idxSldId,
    `${label}: <p:notesMasterIdLst> must appear before <p:sldIdLst>`,
  );
  assert.ok(idxSldId < idxSldSz, `${label}: <p:sldSz> must appear after <p:sldIdLst>`);
  assert.ok(
    idxSldSz < idxNotesSz,
    `${label}: <p:notesSz cx="6858000" cy="9144000"/> must appear after <p:sldSz>`,
  );
  assert.ok(
    idxNotesSz < idxDefaultText,
    `${label}: <p:defaultTextStyle> must appear after <p:notesSz>`,
  );

  // ppt/_rels/presentation.xml.rels must point rIdNotesMaster1 -> notesMasters/notesMaster1.xml
  const presRelsXml = files.get("ppt/_rels/presentation.xml.rels").toString("utf8");
  assert.match(
    presRelsXml,
    /Id="rIdNotesMaster1"\s+Type="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/notesMaster"\s+Target="notesMasters\/notesMaster1\.xml"/,
  );

  // notesMaster1.xml + rels -> its OWN theme part (../theme/theme2.xml). PowerPoint rejects a package
  // whose notes master shares the slide master's theme1.xml as "corrupted and unreadable".
  assert.ok(files.has("ppt/notesMasters/notesMaster1.xml"), `${label}: missing notesMaster1.xml`);
  const notesMasterXml = files.get("ppt/notesMasters/notesMaster1.xml").toString("utf8");
  assert.match(notesMasterXml, /<p:ph type="sldImg"\/>/);
  assert.match(notesMasterXml, /<p:ph type="body" idx="1"\/>/);
  assert.match(notesMasterXml, /<p:ph type="sldNum"[^>]*idx="10"\/>/);

  const notesMasterRels = files
    .get("ppt/notesMasters/_rels/notesMaster1.xml.rels")
    .toString("utf8");
  assert.match(notesMasterRels, /Target="\.\.\/theme\/theme2\.xml"/);
  assert.doesNotMatch(notesMasterRels, /theme1\.xml/, `${label}: the notes master must not share theme1.xml`);
  assert.ok(files.has("ppt/theme/theme2.xml"), `${label}: missing the notes master theme part`);

  // Verify slides and bidirectional notesSlides relationships
  const slideNames = [...files.keys()]
    .filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  const notesNames = [...files.keys()]
    .filter((k) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(k))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));

  assert.ok(slideNames.length >= 3, `${label}: expected multiple slides`);
  assert.equal(
    notesNames.length,
    slideNames.length,
    `${label}: expected speaker notes on every generated slide`,
  );

  // docProps/app.xml <Notes> count matches notesSlides count
  const appPropsXml = files.get("docProps/app.xml").toString("utf8");
  assert.match(appPropsXml, new RegExp(`<Notes>${notesNames.length}</Notes>`));

  let combinedSlidesXml = "";
  let combinedNotesXml = "";
  for (let i = 0; i < slideNames.length; i += 1) {
    const slideNum = i + 1;
    const slideXml = files.get(`ppt/slides/slide${slideNum}.xml`).toString("utf8");
    const slideRels = files.get(`ppt/slides/_rels/slide${slideNum}.xml.rels`).toString("utf8");
    const notesXml = files.get(`ppt/notesSlides/notesSlide${slideNum}.xml`).toString("utf8");
    const notesRels = files
      .get(`ppt/notesSlides/_rels/notesSlide${slideNum}.xml.rels`)
      .toString("utf8");

    combinedSlidesXml += `\n${slideXml}`;
    combinedNotesXml += `\n${notesXml}`;

    // Bidirectional relationships
    assert.match(
      slideRels,
      new RegExp(
        `Type="http://schemas\\.openxmlformats\\.org/officeDocument/2006/relationships/notesSlide"\\s+Target="\\.\\./notesSlides/notesSlide${slideNum}\\.xml"`,
      ),
      `${label}: slide${slideNum}.xml.rels missing notesSlide relationship`,
    );
    assert.match(
      notesRels,
      /Type="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/notesMaster"\s+Target="\.\.\/notesMasters\/notesMaster1\.xml"/,
    );
    assert.match(
      notesRels,
      new RegExp(
        `Type="http://schemas\\.openxmlformats\\.org/officeDocument/2006/relationships/slide"\\s+Target="\\.\\./slides/slide${slideNum}\\.xml"`,
      ),
      `${label}: notesSlide${slideNum}.xml.rels missing back-link to slide${slideNum}.xml`,
    );

    // Required OOXML placeholders in notesSlideN.xml
    assert.match(notesXml, /<p:ph type="sldImg"\/>/);
    assert.match(notesXml, /<p:ph type="body" idx="1"\/>/);
    assert.match(notesXml, /<p:ph type="sldNum"[^>]*idx="10"\/>/);
    assert.match(notesXml, /<a:t>[^<]+<\/a:t>/, `${label}: notesSlide${slideNum} must be non-empty`);
  }

  return { files, slideNames, notesNames, combinedSlidesXml, combinedNotesXml };
}

// ── 1. Facilitator Guide Model + Renderers (even when includeKnowledgeCheck === false) ──

test("Facilitator Guide synthesizes run-of-show, >90m break cues, readiness runbook, playbook, and full quiz answer key even when learner quizzes are unchecked", async () => {
  const { dir, cleanup } = tempDir("fg-model-no-quiz-");
  try {
    const built = await generateLab(
      {
        title: "Contoso Healthcare Facilitator Workshop",
        products: ["copilot-studio"],
        industry: "healthcare",
        departments: ["customer-service"],
        roles: ["maker", "admin"],
        levels: [100, 200],
        harness: "standard",
        features: [
          "create-agent",
          "agent-instructions",
          "generative-orchestration",
          "topics",
          "entities-variables",
          "adaptive-cards",
          "knowledge-sharepoint",
          "knowledge-files-web",
          "publish-agent",
          "test-agent",
        ],
        includeCore: false,
        includeKnowledgeCheck: false,
        sharepointSiteName: "Contoso Clinical Policies Hub",
        sharepointSiteUrl: "https://contoso.sharepoint.com/sites/ClinicalPolicies",
      },
      { outputRoot: dir, useLearnMcp: false, useLlm: false },
    );

    assert.ok(!built.blocked);
    const labDir = join(dir, built.labId);

    // Learner index.md should NOT contain Knowledge Check quizzes when unchecked
    assert.doesNotMatch(built.markdown, /\*\*Knowledge check:\*\*/i);

    const model = buildFacilitatorGuideModel(labDir);
    assert.equal(model.title, "Contoso Healthcare Facilitator Workshop");
    assert.equal(model.learnerKnowledgeCheckEnabled, false);
    assert.equal(model.pacing.preFlightBufferMinutes, 15);
    assert.ok(
      model.pacing.modulesMinutes > 90,
      `Expected >90m workshop for break-cue verification, got ${model.pacing.modulesMinutes}m`,
    );
    assert.ok(
      model.pacing.rows.some((row) => row.kind === "break"),
      "Run-of-Show should inject a suggested break row for workshops >90 minutes",
    );
    assert.ok(
      model.modules.length >= 6,
      `Expected all modules in Facilitator Guide model, got ${model.modules.length}`,
    );

    // Every module must still carry synthesized Knowledge Check Answer Key + distractor rationales + Learn URL
    for (const mod of model.modules) {
      assert.ok(mod.teachingObjectiveAndFraming.whyLearnersCareHook.length > 20);
      assert.ok(mod.liveDemoTalkingPoints.length >= 3);
      assert.ok(mod.coachingAndPacingCues.length >= 3);
      assert.ok(mod.roadblocksAndFastRescues.length >= 2);
      assert.ok(mod.validationAndDebrief.discussionQuestion.length > 20);
      assert.ok(
        mod.knowledgeChecks.length >= 2,
        `Module ${mod.stepLabel} must include synthesized Knowledge Check questions even when includeKnowledgeCheck=false`,
      );
      for (const q of mod.knowledgeChecks) {
        assert.match(q.correctLetter, /^[A-D]$/);
        assert.equal(q.options.length, 4);
        assert.ok(q.explanation.length > 20);
        assert.equal(q.distractorRationales.length, 3);
        assert.match(q.learnUrl, /^https:\/\/learn\.microsoft\.com\//);
      }
    }

    // Markdown renderer verification
    const md = renderFacilitatorGuideMarkdown(model);
    assert.match(md, /# Contoso Healthcare Facilitator Workshop — Instructor & Facilitator Guide/);
    assert.match(md, /## 1\. Workshop Overview & Run-of-Show Pacing/);
    assert.match(md, /15 minutes \(sign-in, environment check, sample-files verification\)/);
    assert.match(md, /Suggested Stretch Break/);
    assert.match(md, /## 2\. Pre-Delivery Tenant, Licensing & Environment Readiness Runbook/);
    assert.match(md, /Contoso Clinical Policies Hub/);
    assert.match(md, /sample-files\//);
    assert.match(md, /Unchecked \/ omitted in learner handout/i);
    assert.match(md, /Knowledge Check Answer Key & Rationales/);
    assert.match(md, /\*\*Why [A-D] is incorrect:\*\*/);
    assert.match(md, /\*\*Microsoft Learn Reference:\*\*/);

    // DOCX renderer verification
    const docxBuf = renderFacilitatorGuideDocxBuffer(model, {
      branding: {
        companyName: "Contoso Health Training",
        primaryColor: "#0F766E",
        tagline: "Instructor Confidential",
      },
    });
    const docxZip = parseZipArchive(docxBuf);
    assert.ok(docxZip.has("word/document.xml"));
    const wordXml = docxZip.get("word/document.xml").toString("utf8");
    assertWellFormedXml(wordXml, "facilitator.docx:word/document.xml");
    assert.match(wordXml, /Facilitator Guide/);
    assert.match(wordXml, /Knowledge Check Answer Key/);

    // PDF renderer verification
    const pdfBuf = renderFacilitatorGuidePdfBuffer(model, {
      branding: { companyName: "Contoso Health Training", primaryColor: "#0F766E" },
    });
    assert.ok(pdfBuf.subarray(0, 8).toString("latin1").startsWith("%PDF-1.4"));
    assert.match(pdfBuf.subarray(pdfBuf.length - 64).toString("latin1"), /%%EOF/);

    // HTML renderer verification (dark/light/print styles)
    const html = renderFacilitatorGuideHtml(model, {
      branding: { companyName: "Contoso Health Training", primaryColor: "#0F766E" },
    });
    assert.match(html, /^<!DOCTYPE html>/);
    assert.match(html, /@media print/);
    assert.match(html, /\[data-theme="dark"\]/);
    assert.match(html, /Knowledge Check Answer Key &amp; Rationales/);
  } finally {
    cleanup();
  }
});

// ── 2. ECMA-376 PowerPoint Speaker Notes (Full-Lab + Per-Topic + On-Demand Refresh) ──

test("Full-lab and per-topic PowerPoint decks embed spec-compliant ECMA-376 Speaker Notes and keep Knowledge Check answers in Presenter View only", async () => {
  const { dir, cleanup } = tempDir("pptx-speaker-notes-");
  try {
    const built = await generateLab(
      {
        title: "Northwind Banking Agent Workshop",
        products: ["copilot-studio"],
        industry: "financial-services",
        levels: [100, 200],
        harness: "standard",
        features: ["create-agent", "knowledge-sharepoint"],
        includeCore: false,
        includeKnowledgeCheck: true,
      },
      { outputRoot: dir, useLearnMcp: false, useLlm: false },
    );

    assert.ok(!built.blocked);
    const labDir = join(dir, built.labId);
    const manifestPath = join(labDir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

    // 2a. Validate full-lab .pptx via buildPptxFromLabMarkdown
    const fullLabPptx = buildPptxFromLabMarkdown(built.markdown, {
      title: manifest.title,
      manifest,
      branding: { companyName: "Northwind Advisory", primaryColor: "#1D4ED8" },
    });
    assert.equal(buildPptxFromLabMarkdown, renderMarkdownToPptxBuffer);

    const fullChecked = assertValidPptxSpeakerNotes(fullLabPptx, "full-lab-pptx");
    // Knowledge Check slide exists on slide surface, does NOT spoil "Correct answer:" on-slide,
    // and places the answer key + rationale inside notesSlides!
    assert.match(fullChecked.combinedSlidesXml, /Knowledge Check/);
    assert.doesNotMatch(
      fullChecked.combinedSlidesXml,
      /Correct answer:/i,
      "Projected slide XML must not give away the Knowledge Check answer",
    );
    assert.match(fullChecked.combinedNotesXml, /INSTRUCTOR ANSWER KEY/);
    assert.match(fullChecked.combinedNotesXml, /CORRECT ANSWER:/);
    assert.match(fullChecked.combinedNotesXml, /MICROSOFT LEARN SOURCE:/);
    assert.match(fullChecked.combinedNotesXml, /WORKSHOP WELCOME/);

    // 2b. Validate per-topic .pptx written on disk during generateLab
    assert.equal(manifest.topicDocumentsVersion, TOPIC_DOCUMENTS_SCHEMA_VERSION);
    assert.ok(manifest.topicDocuments.length >= 2);
    for (const topicDoc of manifest.topicDocuments) {
      const topicPptxBuf = readFileSync(join(labDir, topicDoc.pptxPath));
      const topicChecked = assertValidPptxSpeakerNotes(topicPptxBuf, topicDoc.pptxFileName);
      assert.doesNotMatch(topicChecked.combinedSlidesXml, /Correct answer:/i);
      assert.match(topicChecked.combinedNotesXml, /CORRECT ANSWER:/);
      assert.match(topicChecked.combinedNotesXml, /FACILITATOR PACING CUE:/);
    }

    // 2c. Validate direct buildTopicPptxFromMarkdown with "(Correct)" option & blockquote answer
    const standaloneTopicMd = [
      "# SharePoint Grounding — Delegated Identity",
      "",
      "| Lab | Step | Level | Estimated time | Product(s) |",
      "|---|---|---|---|---|",
      "| Northwind Banking Agent Workshop | Step 1 | Level 200 | ~20 minutes | Microsoft Copilot Studio |",
      "",
      "> **Why this matters:** Delegated authentication enforces SharePoint document ACLs per user.",
      "",
      "**Do this:**",
      "",
      "1. Open **Knowledge** and add your SharePoint site URL.",
      "2. Enable user authentication and test citations in the **Test** pane.",
      "",
      "**Check your work:**",
      "",
      "- [ ] Authorized users receive grounded citations.",
      "",
      "### Knowledge Check",
      "",
      "**Question:** Which identity enforces SharePoint ACL trimming at query time?",
      "- A) Anonymous guest token",
      "- B) Signed-in end user's Microsoft Entra ID identity (Correct)",
      "- C) Static storage account key",
      "- D) Unauthenticated webhook",
      "",
      "> **Answer:** B — Delegated Microsoft Entra ID authentication preserves per-user document ACLs.",
    ].join("\n");

    const singleTopicPptx = buildTopicPptxFromMarkdown(standaloneTopicMd, {
      title: "Northwind - Step 01 - SharePoint Grounding",
    });
    const singleChecked = assertValidPptxSpeakerNotes(singleTopicPptx, "standalone-topic-pptx");
    assert.doesNotMatch(
      singleChecked.combinedSlidesXml,
      /\(Correct\)/i,
      "Slide options must strip inline (Correct) markers",
    );
    assert.doesNotMatch(singleChecked.combinedSlidesXml, /Correct answer:/i);
    assert.match(
      singleChecked.combinedNotesXml,
      /CORRECT ANSWER:\s*<\/a:t><\/a:r>\s*<a:r>[\s\S]*?<a:t>B\./,
    );
    assert.match(singleChecked.combinedNotesXml, /Delegated Microsoft Entra ID authentication/);

    // 2d. Verify legacy generated labs (topicDocumentsVersion: 2) refresh topics/*.pptx on demand
    const staleManifest = { ...manifest, topicDocumentsVersion: 2 };
    writeFileSync(join(labDir, manifest.topicDocuments[0].pptxPath), Buffer.from("stale"));
    writeFileSync(manifestPath, JSON.stringify(staleManifest, null, 2));

    const refreshedDocs = ensureGeneratedLabTopicDocuments(labDir, { labId: built.labId });
    const refreshedBuf = readFileSync(join(labDir, refreshedDocs[0].pptxPath));
    assertValidPptxSpeakerNotes(refreshedBuf, "refreshed-legacy-topic-pptx");
  } finally {
    cleanup();
  }
});

// ── 3. HTTP Export Routes, ZIP Facilitator Guide Folder & Step 8 UI Buttons ──

test("HTTP export endpoints serve facilitator-docx/pdf/md/html, bundle Facilitator Guide/ in .zip, and render clean Step 8 UI links", async () => {
  const { dir, cleanup } = tempDir("facilitator-http-ui-");
  let server = null;
  try {
    const built = await generateLab(
      {
        title: "Tailspin Copilot Readiness Lab",
        products: ["copilot-studio"],
        industry: "manufacturing",
        levels: [100],
        harness: "standard",
        features: ["create-agent", "agent-instructions"],
        includeCore: false,
        includeKnowledgeCheck: false,
      },
      { outputRoot: dir, useLearnMcp: false, useLlm: false },
    );
    assert.ok(!built.blocked);

    // 3a. Verify Step 8 & Generated Labs UI button HTML via lbGeneratedActionButtonsHtml
    const uiContext = vm.createContext({
      window: {},
      document: {
        getElementById: () => null,
        querySelector: () => null,
        addEventListener: () => {},
      },
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      fetch: async () => ({ ok: true, json: async () => ({ labs: [] }) }),
      escapeHtml: (s) =>
        String(s ?? "")
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;"),
      URL: globalThis.URL,
      Blob: globalThis.Blob,
      console,
      setTimeout,
      clearTimeout,
    });
    vm.runInContext(readFileSync(join(PUBLIC_DIR, "generated-labs.js"), "utf8"), uiContext);
    vm.runInContext(
      "globalThis.__fgUi = { lbGeneratedActionButtonsHtml };",
      uiContext,
    );

    const actionsHtml = uiContext.__fgUi.lbGeneratedActionButtonsHtml(
      built.labId,
      "Tailspin Copilot Readiness Lab",
    );
    const visibleText = actionsHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

    assert.match(actionsHtml, /export\?format=facilitator-docx/);
    assert.match(actionsHtml, /export\?format=facilitator-pdf/);
    assert.match(
      actionsHtml,
      /download="Tailspin Copilot Readiness Lab - Facilitator Guide\.docx"/,
    );
    assert.match(
      actionsHtml,
      /download="Tailspin Copilot Readiness Lab - Facilitator Guide\.pdf"/,
    );
    assert.match(actionsHtml, /🎓 Facilitator Guide \(\.docx\)/);
    assert.match(actionsHtml, /🎓 Facilitator Guide \(\.pdf\)/);
    assert.doesNotMatch(
      visibleText,
      new RegExp(built.labId),
      "Visible button labels must never expose raw labId slugs",
    );
    assert.doesNotMatch(
      visibleText,
      /Tailspin Copilot Readiness Lab - Facilitator Guide\.docx/,
      "Visible button labels must never expose raw download filenames",
    );

    // 3b. Verify GET & POST HTTP export routes on both /api/lab-builder/generated and /api/generated-labs
    server = await startPortalServer(dir);

    for (const prefix of ["/api/lab-builder/generated", "/api/generated-labs"]) {
      const docxRes = await fetch(
        `${server.baseUrl}${prefix}/${encodeURIComponent(built.labId)}/export?format=facilitator-docx`,
      );
      assert.equal(docxRes.status, 200);
      assert.match(docxRes.headers.get("content-type") || "", /wordprocessingml\.document/);
      assert.match(
        docxRes.headers.get("content-disposition") || "",
        /Tailspin Copilot Readiness Lab - Facilitator Guide\.docx/,
      );
      const docxArchive = parseZipArchive(Buffer.from(await docxRes.arrayBuffer()));
      assert.ok(docxArchive.has("word/document.xml"));

      const pdfRes = await fetch(
        `${server.baseUrl}${prefix}/${encodeURIComponent(built.labId)}/export?format=facilitator-pdf`,
      );
      assert.equal(pdfRes.status, 200);
      assert.match(pdfRes.headers.get("content-type") || "", /application\/pdf/);
      assert.match(
        pdfRes.headers.get("content-disposition") || "",
        /Tailspin Copilot Readiness Lab - Facilitator Guide\.pdf/,
      );
      const pdfBytes = Buffer.from(await pdfRes.arrayBuffer());
      assert.ok(pdfBytes.subarray(0, 8).toString("latin1").startsWith("%PDF-1.4"));

      const mdRes = await fetch(
        `${server.baseUrl}${prefix}/${encodeURIComponent(built.labId)}/export?format=facilitator-md`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            replacements: { Tailspin: "Fabrikam Precision" },
          }),
        },
      );
      assert.equal(mdRes.status, 200);
      assert.match(mdRes.headers.get("content-type") || "", /text\/markdown/);
      assert.match(
        mdRes.headers.get("content-disposition") || "",
        /Fabrikam Precision Copilot Readiness Lab - Facilitator Guide\.md/,
      );
      const mdBody = await mdRes.text();
      assert.match(
        mdBody,
        /# Fabrikam Precision Copilot Readiness Lab — Instructor & Facilitator Guide/,
      );
      assert.match(mdBody, /Knowledge Check Answer Key & Rationales/);

      const htmlRes = await fetch(
        `${server.baseUrl}${prefix}/${encodeURIComponent(built.labId)}/export?format=facilitator-html`,
      );
      assert.equal(htmlRes.status, 200);
      assert.match(htmlRes.headers.get("content-type") || "", /text\/html/);
      assert.match(
        htmlRes.headers.get("content-disposition") || "",
        /Tailspin Copilot Readiness Lab - Facilitator Guide\.html/,
      );
      const htmlBody = await htmlRes.text();
      assert.match(htmlBody, /<!DOCTYPE html>/);
      assert.match(htmlBody, /Run-of-Show Pacing/);
    }

    // 3c. Verify Complete Lab Package .zip includes Facilitator Guide/ (.md, .docx, .pdf, .html) AND speaker-notes PPTX
    const zipRes = await fetch(
      `${server.baseUrl}/api/lab-builder/generated/${encodeURIComponent(built.labId)}/export?format=zip&formats=all`,
    );
    assert.equal(zipRes.status, 200);
    const zipEntries = parseZipArchive(Buffer.from(await zipRes.arrayBuffer()));
    const exportManifest = JSON.parse(zipEntries.get("export-manifest.json").toString("utf8"));
    const labFolder = exportManifest.labFolder;
    const basePrefix = `${labFolder}/Facilitator Guide/Facilitator guide`;
    assert.ok(zipEntries.has(`${basePrefix}.md`), "ZIP missing Facilitator Guide .md");
    assert.ok(zipEntries.has(`${basePrefix}.docx`), "ZIP missing Facilitator Guide .docx");
    assert.ok(zipEntries.has(`${basePrefix}.pdf`), "ZIP missing Facilitator Guide .pdf");
    assert.ok(zipEntries.has(`${basePrefix}.html`), "ZIP missing Facilitator Guide .html");

    assert.equal(exportManifest.facilitatorGuideFolder, `${labFolder}/Facilitator Guide`);
    assert.ok(exportManifest.facilitatorGuideFiles.includes(`${basePrefix}.docx`));
    assert.ok(exportManifest.facilitatorGuideFiles.includes(`${basePrefix}.pdf`));

    // Verify per-module .pptx inside the ZIP also includes ECMA-376 Speaker Notes
    const modulePptxKey = [...zipEntries.keys()].find(
      (k) => k.startsWith(`${labFolder}/01 `) && k.endsWith(".pptx"),
    );
    assert.ok(modulePptxKey, "Expected per-module .pptx inside ZIP export");
    assertValidPptxSpeakerNotes(zipEntries.get(modulePptxKey), "zip-module-pptx");
  } finally {
    if (server) await server.stop();
    cleanup();
  }
});
