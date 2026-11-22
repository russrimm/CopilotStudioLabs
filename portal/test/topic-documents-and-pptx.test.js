import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync, inflateRawSync } from "node:zlib";
import vm from "node:vm";

import { generateLab } from "../lib/lab-builder/generator.js";
import {
  readGeneratedLab,
  readGeneratedLabTopicDocument,
  updateGeneratedLabMeta,
} from "../lib/lab-builder/generated-labs.js";
import {
  formatLabTopicBaseName,
  formatLabTopicStepTag,
} from "../lib/lab-builder/module-samples.js";
import {
  parseTopicMarkdownStructure,
  renderMarkdownToPptxBuffer,
  renderTopicToPptxBuffer,
} from "../lib/lab-builder/pptx-builder.js";
import { validateLabDir } from "../lib/validator.js";

process.env.LAB_BUILDER_LINK_CHECK = "off";
process.env.LAB_BUILDER_VENDOR_DOCS = "off";

function tempDir(prefix = "topic-docs-pptx-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
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

    assert.equal(buffer.readUInt32LE(localHeaderOffset), 0x04034b50, `Expected Local File header for ${name}`);
    const localNameLen = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localHeaderOffset + 28);
    const flag = buffer.readUInt16LE(localHeaderOffset + 6);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const actualCompSize = (flag & 0x08) !== 0 ? compSize : buffer.readUInt32LE(localHeaderOffset + 18) || compSize;
    const rawSlice = buffer.subarray(dataStart, dataStart + actualCompSize);
    const content = method === 8 ? inflateRawSync(rawSlice) : method === 0 ? Buffer.from(rawSlice) : null;
    assert.ok(content !== null, `Unsupported ZIP compression method ${method} on ${name}`);
    files.set(name, content);

    offset += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

/** Verify well-formed XML element nesting across every `.xml` / `.rels` entry in an OOXML archive. */
function assertWellFormedXml(xmlText, entryName) {
  assert.match(xmlText, /^<\?xml version="1\.0" encoding="UTF-8"/, `${entryName} must start with XML declaration`);
  const stripped = xmlText
    .replace(/^<\?xml[^>]*\?>\s*/, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  // Ensure no unescaped stray ampersands
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

function buildSamplePng() {
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const typeBuf = Buffer.from(type, "ascii");
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length, 0);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(4, 0);
  ihdr.writeUInt32BE(3, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rawScanlines = Buffer.from([
    0, 0x00, 0x78, 0xd4, 0x10, 0x6e, 0xbe, 0x00, 0x5a, 0x9e, 0x2b, 0x88, 0xd8,
    0, 0x00, 0x78, 0xd4, 0x10, 0x6e, 0xbe, 0x00, 0x5a, 0x9e, 0x2b, 0x88, 0xd8,
    0, 0x00, 0x78, 0xd4, 0x10, 0x6e, 0xbe, 0x00, 0x5a, 0x9e, 0x2b, 0x88, 0xd8,
  ]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(rawScanlines)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const srv = createServer();
    srv.once("error", rejectPort);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolvePort(port));
    });
  });
}

async function bootServer(extraEnv = {}) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      PORTAL_AUTH_DISABLED: "true",
      AZURE_KEYVAULT_URL: "",
      LAB_BUILDER_LINK_CHECK: "off",
      LAB_BUILDER_VENDOR_DOCS: "off",
      ...extraEnv,
    },
    stdio: "ignore",
  });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${child.exitCode}`);
    try {
      const res = await fetch(`${base}/api/config`);
      if (res.ok) {
        return {
          base,
          stop: () => {
            child.kill();
          },
        };
      }
    } catch {
      // Server still booting.
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  child.kill();
  throw new Error("Timed out waiting for portal test server");
}

test("pure-Node PresentationML .pptx builder emits valid 16:9 OOXML slides, paginated steps, media, quiz, and external Learn links", () => {
  const samplePng = buildSamplePng();
  const topicMd = [
    "# Ground on SharePoint knowledge",
    "",
    "*Part of lab: **Healthcare Patient Support Lab** · Step 2 · ~25 min*",
    "",
    "| Field | Details |",
    "| --- | --- |",
    "| **Module** | Step 2 — Ground on SharePoint knowledge |",
    "| **Estimated Time** | ~25 min |",
    "| **Level** | Level 200 |",
    "",
    "---",
    "",
    "### Step 2 — Ground on SharePoint knowledge",
    "",
    "*Level 200 · ~25 min · Grounding*",
    "",
    "**Why this matters:** Grounding your agent on curated SharePoint sites ensures responses cite authoritative policies.",
    "",
    "In your scenario, Contoso Health clinical coordinators ask policy questions that must be answered strictly from approved SharePoint libraries.",
    "",
    "**Key concepts:**",
    "",
    "- **Generative answers**: Synthesizes grounded answers from indexed SharePoint pages and documents.",
    "- **Tenant graph permissions**: Enforces the signed-in user's SharePoint ACLs at query time.",
    "",
    "**Do this:**",
    "",
    "1. Open **Microsoft Copilot Studio** and select your Healthcare Patient Support agent.",
    "2. Select **Knowledge** in the left navigation, then select **+ Add knowledge**.",
    "3. Choose **SharePoint** and paste your clinical policy site URL.",
    "4. Enter a clear description so the orchestrator knows when to query this source.",
    "5. Select **Add** and wait for the status indicator to show **Ready**.",
    "6. Open the **Test your agent** pane and ask a grounded policy question.",
    "7. Inspect the citation link and confirm it points to the SharePoint document.",
    "",
    "![SharePoint knowledge source configuration](assets/02-sharepoint-knowledge.png)",
    "",
    "| Site Library | Access Scope |",
    "| --- | --- |",
    "| Clinical Policies | All clinical staff |",
    "| Escalation Playbooks | Triage leads |",
    "",
    "```text",
    "Summarize the outpatient triage escalation policy and cite the exact document.",
    "```",
    "",
    "**Check your work:**",
    "",
    "- [ ] SharePoint source appears with Ready status under Knowledge",
    "- [ ] Test pane response includes an inline citation to the policy document",
    "",
    "<details>",
    "<summary>Troubleshooting — common pitfalls &amp; fixes</summary>",
    "",
    "- **Agent returns ungrounded general knowledge** — Verify Web Search is turned off and the SharePoint URL has no trailing file path.",
    "",
    "</details>",
    "",
    "#### Knowledge check",
    "",
    "1. How does SharePoint knowledge grounding enforce document access?",
    "   - A) Anyone with the agent link can read every document",
    "   - B) It enforces the signed-in user's SharePoint permissions at query time",
    "   - C) It copies files into public blob storage",
    "",
    "<details>",
    "<summary>Answer &amp; explanation</summary>",
    "",
    "**Correct answer:** B — Copilot Studio queries SharePoint using the authenticated user's identity. [SharePoint knowledge sources](https://learn.microsoft.com/en-us/microsoft-copilot-studio/nlu-boost-node)",
    "",
    "</details>",
    "",
    "**References:**",
    "",
    "- [Add SharePoint as a knowledge source](https://learn.microsoft.com/en-us/microsoft-copilot-studio/knowledge-add-sharepoint)",
    "- [Generative answers overview](https://learn.microsoft.com/en-us/microsoft-copilot-studio/nlu-boost-node)",
  ].join("\n");

  const parsed = parseTopicMarkdownStructure(topicMd, {
    labTitle: "Healthcare Patient Support Lab",
    stepLabel: "Step 2",
    topicTitle: "Ground on SharePoint knowledge",
  });
  assert.equal(parsed.tables.length, 1, "Synthetic Field/Details header table is consumed as metadata, leaving the real content table");
  assert.equal(parsed.steps.length, 7);
  assert.equal(parsed.knowledgeChecks.length, 1);
  assert.ok(parsed.references.length >= 2);

  const pptxBuf = renderTopicToPptxBuffer(topicMd, {
    title: "Healthcare Patient Support Lab - Step 02 - Ground on SharePoint knowledge",
    branding: {
      companyName: "Contoso Health",
      tagline: "Clinical AI Enablement",
      primaryColor: "#0F6CBD",
      logoBuffer: samplePng,
    },
    resolveImageBuffer: () => samplePng,
    topic: {
      labTitle: "Healthcare Patient Support Lab",
      stepLabel: "Step 2",
      topicTitle: "Ground on SharePoint knowledge",
      products: "Microsoft Copilot Studio",
    },
  });

  assert.equal(pptxBuf[0], 0x50);
  assert.equal(pptxBuf[1], 0x4b);
  const entries = parseZipArchive(pptxBuf);

  for (const requiredEntry of [
    "[Content_Types].xml",
    "_rels/.rels",
    "docProps/core.xml",
    "docProps/app.xml",
    "ppt/presentation.xml",
    "ppt/_rels/presentation.xml.rels",
    "ppt/presProps.xml",
    "ppt/viewProps.xml",
    "ppt/tableStyles.xml",
    "ppt/theme/theme1.xml",
    "ppt/slideMasters/slideMaster1.xml",
    "ppt/slideMasters/_rels/slideMaster1.xml.rels",
    "ppt/slideLayouts/slideLayout1.xml",
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
  ]) {
    assert.ok(entries.has(requiredEntry), `Missing required OOXML entry: ${requiredEntry}`);
  }

  // Validate well-formed XML on every single XML and .rels part
  for (const [name, buf] of entries.entries()) {
    if (name.endsWith(".xml") || name.endsWith(".rels")) {
      assertWellFormedXml(buf.toString("utf8"), name);
    }
  }

  const presXml = entries.get("ppt/presentation.xml").toString("utf8");
  assert.match(presXml, /<p:sldSz cx="12192000" cy="6858000"\/>/, "16:9 widescreen slide dimensions");

  const themeXml = entries.get("ppt/theme/theme1.xml").toString("utf8");
  assert.match(themeXml, /0F6CBD/, "Theme honors custom branding.primaryColor");

  const slideNames = [...entries.keys()].filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k));
  assert.ok(slideNames.length >= 6, `Expected multi-slide paginated deck (>=6 slides), got ${slideNames.length}`);

  const mediaNames = [...entries.keys()].filter((k) => k.startsWith("ppt/media/image") && k.endsWith(".png"));
  assert.ok(mediaNames.length >= 1, "PPTX embeds PNG screenshot/logo media");

  const allSlidesXml = slideNames.map((n) => entries.get(n).toString("utf8")).join("\n");
  assert.match(allSlidesXml, /Healthcare Patient Support Lab/);
  assert.match(allSlidesXml, /Ground on SharePoint knowledge/);
  assert.match(allSlidesXml, /<p:pic>/, "Embedded screenshot rendered via <p:pic>");
  assert.match(allSlidesXml, /<a:tbl>/, "Markdown table rendered via <a:tbl>");
  assert.match(allSlidesXml, /Knowledge Check/, "Includes Knowledge Check slide");
  assert.match(allSlidesXml, /Microsoft Learn References/, "Includes References slide");
  assert.match(
    allSlidesXml,
    /<a:hlinkClick r:id="rId\d+"[^>]*\/>/,
    "Includes clickable hyperlink runs",
  );

  const allSlideRels = [...entries.keys()]
    .filter((k) => /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/.test(k))
    .map((n) => entries.get(n).toString("utf8"))
    .join("\n");
  assert.match(
    allSlideRels,
    /Target="https:\/\/learn\.microsoft\.com\/en-us\/microsoft-copilot-studio\/knowledge-add-sharepoint" TargetMode="External"/,
    "Slide .rels contains external Microsoft Learn hyperlink relationship",
  );

  // Also verify full-lab renderMarkdownToPptxBuffer
  const fullLabDeck = renderMarkdownToPptxBuffer(
    [
      "# Full Lab Deck",
      "## Overview",
      "Build and validate a grounded agent.",
      "## Step-by-Step",
      topicMd.split("---")[1],
    ].join("\n\n"),
    { title: "Full Lab Deck", resolveImageBuffer: () => samplePng },
  );
  const fullEntries = parseZipArchive(fullLabDeck);
  assert.ok(fullEntries.has("ppt/presentation.xml"));
  assert.ok(fullEntries.has("ppt/slides/slide1.xml"));
});

test("per-lab naming enforces lab prefix, Step/Recap tags, Windows MAX_PATH bounds, and collision disambiguation", () => {
  assert.equal(formatLabTopicStepTag("Step 1", 1), "Step 01");
  assert.equal(formatLabTopicStepTag("Recap 2", 2), "Recap 02");

  const standardName = formatLabTopicBaseName(
    "Contoso Retail Support Lab",
    "Step 3",
    3,
    "Connect REST/OpenAPI?:*<>| Tools",
  );
  assert.equal(
    standardName,
    "Contoso Retail Support Lab - Step 03 - Connect REST - OpenAPI - Tools",
  );

  // Maximum 160-character lab title + long topic title + deeply nested outputDir must stay well under Windows MAX_PATH (230 chars)
  const veryLongLabTitle =
    "Enterprise Cross-Departmental Financial Services Copilot Studio Autonomous Orchestration and Governance Masterclass Workshop Series 2026 Edition Alpha";
  const veryLongTopicTitle =
    "Configure End-to-End Microsoft Entra On-Behalf-Of OAuth2 Authentication with Scoped Connector Policies and Audit Logging";
  const deepOutputDir =
    "D:\\repos\\copilot-worktrees\\CopilotStudioLabs\\russrimm-bookish-garbanzo\\generated-labs\\financial-services-autonomous-orchestration-and-governance-2026";

  const used = new Set();
  const base1 = formatLabTopicBaseName(veryLongLabTitle, "Step 12", 12, veryLongTopicTitle, {
    outputDir: deepOutputDir,
    usedBaseNames: used,
  });
  const base2 = formatLabTopicBaseName(veryLongLabTitle, "Step 12", 12, veryLongTopicTitle, {
    outputDir: deepOutputDir,
    usedBaseNames: used,
  });

  const fullPptxPath1 = join(deepOutputDir, "topics", `${base1}.pptx`);
  const fullPptxPath2 = join(deepOutputDir, "topics", `${base2}.pptx`);
  assert.ok(fullPptxPath1.length < 230, `Expected Windows path < 230 chars, got ${fullPptxPath1.length}: ${fullPptxPath1}`);
  assert.ok(fullPptxPath2.length < 230, `Expected disambiguated Windows path < 230 chars, got ${fullPptxPath2.length}`);
  assert.notEqual(base1.toLowerCase(), base2.toLowerCase(), "Duplicate sanitized names are disambiguated");
  assert.match(base1, / - Step 12 - /);

  // Short and long topic titles inside the same deep outputDir share an identical lab prefix so directory listings sort in step order
  const shortTopicBase = formatLabTopicBaseName(veryLongLabTitle, "Step 1", 1, "Create an agent", {
    outputDir: deepOutputDir,
  });
  const longTopicBase = formatLabTopicBaseName(veryLongLabTitle, "Step 2", 2, veryLongTopicTitle, {
    outputDir: deepOutputDir,
  });
  assert.equal(
    shortTopicBase.split(" - Step 01 - ")[0],
    longTopicBase.split(" - Step 02 - ")[0],
    "Topics in the same lab keep an identical lab prefix even under deep outputDir",
  );
  assert.ok(shortTopicBase.localeCompare(longTopicBase) < 0, "Step 01 sorts before Step 02");
});

test("generateLab writes per-topic .docx and .pptx named per lab in topics/ (including Recap + Step), passes validator, syncs on rename, synthesizes legacy labs, and serves HTTP downloads", async () => {
  const { dir: genRoot, cleanup } = tempDir("gen-topic-docs-e2e-");
  let srv = null;
  try {
    // Level 200 with lower-level prerequisites produces BOTH Recap N and Step M modules!
    const built = await generateLab(
      {
        title: "Northwind Patient Triage Lab",
        industry: "healthcare",
        departments: ["customer-service"],
        products: ["copilot-studio"],
        harness: "standard",
        level: 200,
        features: ["knowledge-sharepoint", "adaptive-cards"],
        includeKnowledgeCheck: true,
      },
      { outputRoot: genRoot, useLearnMcp: false, useLlm: false },
    );

    assert.equal(built.status, "complete");
    assert.equal(built.validation.failed, 0, `Validator failed: ${JSON.stringify(built.validation.tests?.filter((t) => t.status === "fail"))}`);

    // Re-run validateLabDir directly against the written directory to confirm assets-dir-clean passes
    const valReport = validateLabDir(built.outputDir, built.labId);
    assert.equal(valReport.failed, 0);

    // Ensure no .docx or .pptx landed inside assets/
    const assetFiles = existsSync(join(built.outputDir, "assets"))
      ? readdirSync(join(built.outputDir, "assets"))
      : [];
    assert.ok(
      !assetFiles.some((f) => f.endsWith(".docx") || f.endsWith(".pptx")),
      "No .docx or .pptx files may be placed inside assets/",
    );

    // Verify topics/ holds exact per-lab .docx and .pptx files for every module (both Recap and Step)
    const topicsDir = join(built.outputDir, "topics");
    assert.ok(existsSync(topicsDir), "topics/ directory created on disk");
    const diskTopicFiles = readdirSync(topicsDir);

    assert.ok(Array.isArray(built.topicDocuments));
    assert.equal(built.topicDocuments.length, built.manifest.modules.length);
    assert.ok(
      built.topicDocuments.some((d) => /^Recap \d+$/.test(d.stepLabel)),
      "Includes Prerequisite Recap topic documents",
    );
    assert.ok(
      built.topicDocuments.some((d) => /^Step \d+$/.test(d.stepLabel)),
      "Includes main Step topic documents",
    );

    for (const doc of built.topicDocuments) {
      assert.ok(
        doc.fileBaseName.startsWith("Northwind Patient Triage Lab - "),
        `Expected filename to start with lab title, got: ${doc.fileBaseName}`,
      );
      assert.ok(diskTopicFiles.includes(doc.docxFileName), `Missing ${doc.docxFileName} in topics/`);
      assert.ok(diskTopicFiles.includes(doc.pptxFileName), `Missing ${doc.pptxFileName} in topics/`);

      const docxBytes = readFileSync(join(topicsDir, doc.docxFileName));
      const pptxBytes = readFileSync(join(topicsDir, doc.pptxFileName));
      assert.ok(parseZipArchive(docxBytes).has("word/document.xml"));
      assert.ok(parseZipArchive(pptxBytes).has("ppt/presentation.xml"));
    }

    // Boot HTTP server and verify generate/read/download/rename routes
    srv = await bootServer({ LAB_BUILDER_OUTPUT_DIR: genRoot });

    // 1. GET /api/lab-builder/generated/:labId includes topicDocuments
    const detailRes = await fetch(`${srv.base}/api/lab-builder/generated/${built.labId}`);
    assert.equal(detailRes.status, 200);
    const detailBody = await detailRes.json();
    assert.equal(detailBody.topicDocuments.length, built.manifest.modules.length);

    // 2. Download per-topic .docx and .pptx via both canonical and alias routes
    const firstDoc = detailBody.topicDocuments[0];
    const docxRes = await fetch(`${srv.base}/api/lab-builder/generated/${built.labId}/topics/${firstDoc.order}/docx`);
    assert.equal(docxRes.status, 200);
    assert.match(docxRes.headers.get("content-type") || "", /wordprocessingml\.document/);
    assert.equal(docxRes.headers.get("x-content-type-options"), "nosniff");
    assert.ok(
      (docxRes.headers.get("content-disposition") || "").includes(firstDoc.docxFileName),
      `Content-Disposition should carry per-lab filename '${firstDoc.docxFileName}', got: ${docxRes.headers.get("content-disposition")}`,
    );
    const downloadedDocx = Buffer.from(await docxRes.arrayBuffer());
    assert.ok(parseZipArchive(downloadedDocx).has("word/document.xml"));

    const pptxRes = await fetch(`${srv.base}/api/generated-labs/${built.labId}/topics/${firstDoc.order}/pptx`);
    assert.equal(pptxRes.status, 200);
    assert.match(pptxRes.headers.get("content-type") || "", /presentationml\.presentation/);
    assert.equal(pptxRes.headers.get("x-content-type-options"), "nosniff");
    assert.ok(
      (pptxRes.headers.get("content-disposition") || "").includes(firstDoc.pptxFileName),
      `Content-Disposition should carry per-lab filename '${firstDoc.pptxFileName}'`,
    );
    const downloadedPptx = Buffer.from(await pptxRes.arrayBuffer());
    assert.ok(parseZipArchive(downloadedPptx).has("ppt/presentation.xml"));

    // Validation errors on bad format / order
    assert.equal(
      (await fetch(`${srv.base}/api/lab-builder/generated/${built.labId}/topics/1/exe`)).status,
      400,
    );
    assert.equal(
      (await fetch(`${srv.base}/api/lab-builder/generated/${built.labId}/topics/0/pptx`)).status,
      400,
    );
    assert.equal(
      (await fetch(`${srv.base}/api/lab-builder/generated/${built.labId}/topics/999/pptx`)).status,
      404,
    );

    // 3. Rename the lab via PATCH /api/lab-builder/generated/:labId and verify old files are replaced on disk
    const renameRes = await fetch(`${srv.base}/api/lab-builder/generated/${built.labId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Fabrikam Clinical Escalation Workshop" }),
    });
    assert.equal(renameRes.status, 200);
    const renameBody = await renameRes.json();
    assert.equal(renameBody.lab.title, "Fabrikam Clinical Escalation Workshop");
    assert.ok(Array.isArray(renameBody.topicDocuments));

    const afterRenameFiles = readdirSync(topicsDir);
    assert.ok(
      !afterRenameFiles.some((f) => f.startsWith("Northwind Patient Triage Lab - ")),
      "Old lab-prefixed topic files were cleaned up on rename",
    );
    for (const doc of renameBody.topicDocuments) {
      assert.ok(
        doc.fileBaseName.startsWith("Fabrikam Clinical Escalation Workshop - "),
        `Expected renamed prefix, got: ${doc.fileBaseName}`,
      );
      assert.ok(afterRenameFiles.includes(doc.docxFileName));
      assert.ok(afterRenameFiles.includes(doc.pptxFileName));
    }

    const updatedManifest = JSON.parse(readFileSync(join(built.outputDir, "manifest.json"), "utf8"));
    assert.ok(
      updatedManifest.topicDocuments.every((d) =>
        d.fileBaseName.startsWith("Fabrikam Clinical Escalation Workshop - "),
      ),
      "manifest.json topicDocuments updated on rename",
    );

    // 4. Simulate a legacy generated lab created before topics/ existed on disk
    rmSync(topicsDir, { recursive: true, force: true });
    delete updatedManifest.topicDocuments;
    for (const m of updatedManifest.modules || []) {
      delete m.fileBaseName;
      delete m.docxFileName;
      delete m.pptxFileName;
      delete m.docxPath;
      delete m.pptxPath;
    }
    writeFileSync(join(built.outputDir, "manifest.json"), JSON.stringify(updatedManifest, null, 2), "utf8");
    assert.ok(!existsSync(topicsDir));

    const synthesizedRead = readGeneratedLab(genRoot, built.labId, (md) => md);
    assert.equal(synthesizedRead.status, 200);
    assert.equal(synthesizedRead.body.topicDocuments.length, updatedManifest.modules.length);
    assert.ok(existsSync(topicsDir), "Legacy lab synthesized topics/ on demand");

    const synthDoc = readGeneratedLabTopicDocument(genRoot, built.labId, 1, "pptx");
    assert.equal(synthDoc.status, 200);
    assert.ok(synthDoc.fileName.startsWith("Fabrikam Clinical Escalation Workshop - "));

    // 5. Verify POST /api/lab-builder/generate also returns topicDocuments directly
    const postGenRes = await fetch(`${srv.base}/api/lab-builder/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Tailspin Toys Quickstart",
        products: ["copilot-studio"],
        harness: "standard",
        level: 100,
        features: ["create-agent"],
        useLearnMcp: false,
        useLlm: false,
      }),
    });
    assert.equal(postGenRes.status, 200);
    const postGenBody = await postGenRes.json();
    assert.equal(postGenBody.status, "complete");
    assert.ok(Array.isArray(postGenBody.topicDocuments) && postGenBody.topicDocuments.length >= 1);
    assert.ok(postGenBody.topicDocuments[0].docxFileName.startsWith("Tailspin Toys Quickstart - "));
    assert.ok(postGenBody.topicDocuments[0].pptxFileName.startsWith("Tailspin Toys Quickstart - "));
  } finally {
    if (srv) srv.stop();
    cleanup();
  }
});

test("portal UI renders the accessible hands-on documents and decks card with per-lab filenames", () => {
  const genLabsSrc = readFileSync(new URL("../public/generated-labs.js", import.meta.url), "utf8");
  const context = {
    CSS: { escape: (s) => String(s) },
    escapeHtml: (s) =>
      String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;"),
    labBuilder: { industries: [], levels: [], harnesses: [], products: [] },
    lbFormatMinutes: (m) => `${m} min`,
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    window: { addEventListener() {} },
    fetch: async () => ({ ok: true, json: async () => ({ labs: [] }) }),
    toast: () => {},
  };
  vm.createContext(context);
  // The portal's scripts share one page: the shared helpers load first and give the lab's own module labels their portal wording.
  vm.runInContext(readFileSync(new URL("../public/screenshot-center-core.js", import.meta.url), "utf8"), context);
  vm.runInContext(
    `${genLabsSrc}\nglobalThis.__topicUi = { lbRenderTopicDocumentsHtml };`,
    context,
  );

  const html = context.__topicUi.lbRenderTopicDocumentsHtml("healthcare-lab", [
    {
      order: 1,
      id: "create-agent",
      stepLabel: "Recap 1",
      title: "Create an agent",
      fileBaseName: "Healthcare Lab - Recap 01 - Create an agent",
      docxFileName: "Healthcare Lab - Recap 01 - Create an agent.docx",
      pptxFileName: "Healthcare Lab - Recap 01 - Create an agent.pptx",
    },
    {
      order: 2,
      id: "knowledge-sharepoint",
      stepLabel: "Step 1",
      title: "Ground on SharePoint",
      fileBaseName: "Healthcare Lab - Step 01 - Ground on SharePoint",
      docxFileName: "Healthcare Lab - Step 01 - Ground on SharePoint.docx",
      pptxFileName: "Healthcare Lab - Step 01 - Ground on SharePoint.pptx",
    },
  ]);

  const visibleText = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

  assert.match(html, /Hands-on documents &amp; decks: lab day/);
  assert.match(html, /The training decks to deliver first are above\./, "points to the pre-lab group");
  assert.match(html, /2 topics<\/span>/);
  assert.doesNotMatch(html, /files named per lab/);
  assert.doesNotMatch(html, /generated-labs\//);
  assert.doesNotMatch(html, /lb-topic-doc-files/);
  // The files and the lab keep "Recap 01" and "Step 01"; the portal shows "Refresher 1" and "Part 1".
  assert.match(html, /lb-prereq-req-badge-recap">Refresher 1<\/span>/);
  assert.match(html, /<span class="lb-prereq-req-badge">Part 1<\/span>/);
  assert.match(html, /aria-label="Download Word guide for Refresher 1: Create an agent"/);
  assert.match(html, /aria-label="Download hands-on deck \(lab day\) for Part 1: Ground on SharePoint"/);
  assert.doesNotMatch(visibleText, /\b(?:Recap|Step) \d/);
  assert.match(html, /download="Healthcare Lab - Recap 01 - Create an agent\.docx"/);
  assert.match(html, /download="Healthcare Lab - Step 01 - Ground on SharePoint\.pptx"/);
  assert.doesNotMatch(visibleText, /Healthcare Lab - Recap 01 - Create an agent\.docx/);
  assert.doesNotMatch(visibleText, /Healthcare Lab - Step 01 - Ground on SharePoint\.pptx/);
  assert.match(html, /href="\/api\/lab-builder\/generated\/healthcare-lab\/topics\/1\/docx"/);
  assert.match(html, /href="\/api\/lab-builder\/generated\/healthcare-lab\/topics\/2\/pptx"/);
  assert.equal(context.__topicUi.lbRenderTopicDocumentsHtml("healthcare-lab", []), "");
});
