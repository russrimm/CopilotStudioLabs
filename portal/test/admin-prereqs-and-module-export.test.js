import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { PassThrough } from "node:stream";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync, inflateRawSync, inflateSync } from "node:zlib";
import vm from "node:vm";

import { planLab } from "../lib/lab-builder/planner.js";
import { generateLab } from "../lib/lab-builder/generator.js";
import { buildAdminPrerequisites, renderAdminPrerequisitesMarkdown } from "../lib/lab-builder/admin-prereqs.js";
import {
  buildModuleSampleFiles,
  formatModuleBaseName,
  sanitizeFilesystemTitle,
  splitGeneratedLabModules,
} from "../lib/lab-builder/module-samples.js";
import { renderMarkdownToDocxBuffer } from "../lib/lab-builder/docx-builder.js";
import { renderMarkdownToPdfBuffer } from "../lib/lab-builder/pdf-builder.js";
import { renderLabHtmlDocument, renderStandaloneLabHtml } from "../lib/lab-builder/html-lab.js";
import { renderLabMarkdown } from "../lib/markdown.js";
import { parseLabSteps } from "../lib/step-validator/steps.js";
import { resolveGeneratedAsset, readGeneratedLab } from "../lib/lab-builder/generated-labs.js";
import {
  exportGeneratedLab,
  normalizeDocFormats,
  renderGeneratedLabDocx,
  renderGeneratedLabPdf,
} from "../lib/exporter.js";

process.env.LAB_BUILDER_LINK_CHECK = "off";
process.env.LAB_BUILDER_VENDOR_DOCS = "off";

function tempDir(prefix = "admin-prereqs-export-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function collectStream(fn) {
  return new Promise((resolvePromise, rejectPromise) => {
    const out = new PassThrough();
    const chunks = [];
    out.on("data", (chunk) => chunks.push(chunk));
    out.on("end", () => resolvePromise(Buffer.concat(chunks)));
    out.on("error", rejectPromise);
    Promise.resolve(fn(out)).catch(rejectPromise);
  });
}

function parseZipArchive(buffer) {
  // Parse End of Central Directory (0x06054b50) and Central Directory entries (0x02014b50).
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
    // Archiver streaming ZIPs set bit 3 (data descriptor) so compSize lives in the central directory!
    const actualCompSize = (flag & 0x08) !== 0 ? compSize : buffer.readUInt32LE(localHeaderOffset + 18) || compSize;
    const rawSlice = buffer.subarray(dataStart, dataStart + actualCompSize);
    const content = method === 8 ? inflateRawSync(rawSlice) : method === 0 ? Buffer.from(rawSlice) : null;
    assert.ok(content !== null, `Unsupported ZIP compression method ${method} on ${name}`);
    files.set(name, content);

    offset += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

/** Build a tiny valid 2x2 RGB PNG using Node built-ins for image embedding tests. */
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
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8; // bit depth 8
  ihdr[9] = 2; // RGB
  // Two scanlines: filter byte 0 + two RGB pixels per row
  const rawScanlines = Buffer.from([
    0, 0x00, 0x78, 0xd4, 0x10, 0x6e, 0xbe,
    0, 0x2b, 0x88, 0xd8, 0x00, 0x5a, 0x9e,
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

test("buildAdminPrerequisites dynamically derives connectors, DLP/ACP policies, Code apps/PCF, Dataverse storage, and cloud roles", () => {
  const plan = planLab({
    vertical: "financial-services",
    departments: ["finance", "it"],
    products: ["copilot-studio", "power-platform-ai-hub"],
    harness: "standard",
    levels: [100, 200, 300],
    features: [
      "create-agent",
      "knowledge-sharepoint",
      "knowledge-dataverse",
      "custom-connectors",
      "mcp-servers",
      "ppai-code-interpreter-prompts",
      "computer-use",
      "channel-web-sdk",
    ],
  });

  const prereqs = buildAdminPrerequisites(plan);
  const connectorIds = prereqs.connectors.map((c) => c.id);
  assert.ok(connectorIds.includes("sharepoint"), "includes SharePoint connector");
  assert.ok(connectorIds.includes("microsoft-dataverse"), "includes Microsoft Dataverse connector");
  assert.ok(connectorIds.includes("custom-connectors-openapi"), "includes Custom Connector");
  assert.ok(connectorIds.includes("mcp-server-endpoints"), "includes MCP server endpoint connector");

  const dlpIds = prereqs.dlpAndAcp.map((i) => i.id);
  assert.ok(dlpIds.includes("dlp-business-group-alignment"), "includes Business DLP data group policy");
  assert.ok(dlpIds.includes("dlp-endpoint-filtering"), "includes HTTP/MCP endpoint filtering allowlist");
  assert.ok(dlpIds.includes("acp-managed-environment-policies"), "includes ACP / Managed Environment policy");

  const envIds = prereqs.environmentSettings.map((i) => i.id);
  assert.ok(envIds.includes("dataverse-database-and-storage"), "includes Dataverse database and storage capacity");
  assert.ok(envIds.includes("code-apps-and-pcf-components"), "includes Code apps and PCF for canvas apps toggle");
  assert.ok(envIds.includes("code-interpreter-python-execution"), "includes Code Interpreter toggle");
  assert.ok(envIds.includes("computer-use-toggle"), "includes Computer Use toggle");

  const md = renderAdminPrerequisitesMarkdown(prereqs);
  assert.match(md, /^## Connectors, Environment, and Tenant Prerequisites/m);
  assert.match(md, /Power Apps Component Framework \(PCF\) for Canvas Apps and Code Apps/i);
  assert.match(md, /Agent Control Plane \(ACP\)/);
  assert.match(md, /Microsoft Dataverse/);

  // Step validator must skip the end-of-lab prerequisites section and all its H3 headings.
  const sampleLabMd = [
    "# Sample Lab",
    "## Step-by-Step",
    "### Step 1 — Create an agent",
    "1. Select **Create** in the left navigation.",
    md,
  ].join("\n\n");
  const parsed = parseLabSteps(sampleLabMd);
  assert.equal(parsed.steps.length, 1, "Only actual lab steps are extracted; admin prerequisite H3s are skipped");
});

test("Foundry-only labs generate cloud/Foundry prerequisites with zero QA errors and zero Copilot Studio leakage", async () => {
  const { dir, cleanup } = tempDir("foundry-prereqs-");
  try {
    const built = await generateLab(
      {
        industry: "healthcare",
        departments: ["it"],
        products: ["ai-foundry"],
        level: 200,
        features: ["fdy-orient-foundry", "fdy-agent-ai-search"],
      },
      { outputRoot: dir, useLearnMcp: false, useLlm: false },
    );
    assert.equal(built.status, "complete");
    assert.deepEqual(
      built.qa.findings.filter((f) => f.severity === "error"),
      [],
      `Expected 0 QA errors, got: ${JSON.stringify(built.qa.findings)}`,
    );
    assert.equal(built.validation.failed, 0, `Expected 0 structural validation failures, got: ${JSON.stringify(built.validation)}`);
    assert.ok(built.adminPrerequisites, "adminPrerequisites returned on generateLab result");
    assert.ok(
      built.adminPrerequisites.tenantAndCloud.some((item) => item.id === "azure-foundry-rbac-and-quota"),
      "Foundry lab includes Azure & Microsoft Foundry RBAC + model quota prerequisite",
    );
    assert.doesNotMatch(built.markdown, /Connectors, Environment, and Tenant Prerequisites/, "learner guides carry no administrator section");
    assert.match(built.markdown, /Your administrator has completed the setup for this lab \(see the Administrator setup guide\)\./);
  } finally {
    cleanup();
  }
});

test("pure-Node .docx and .pdf builders emit spec-compliant binary documents with embedded PNG images", () => {
  const samplePng = buildSamplePng();
  const sampleMd = [
    "# Module 01 - Create an agent",
    "",
    "> **Tip:** Verify connector allowlists before publishing.",
    "",
    "## Step-by-Step",
    "",
    "1. Open **Microsoft Copilot Studio** and select `Create`.",
    "2. Upload `sample-files/handbook.md` to Knowledge.",
    "",
    "![Agent overview screenshot](assets/01-overview.png)",
    "",
    "| Connector | DLP Group |",
    "| --- | --- |",
    "| SharePoint | Business |",
    "| Microsoft Dataverse | Business |",
    "",
    "- [ ] Agent responds with grounded citations",
  ].join("\n");

  const docxBuf = renderMarkdownToDocxBuffer(sampleMd, {
    title: "Module 01 - Create an agent",
    branding: {
      companyName: "Contoso Financial",
      tagline: "AI Enablement Workshop",
      primaryColor: "#005A9E",
      logoBuffer: samplePng,
    },
    resolveImageBuffer: () => samplePng,
  });
  assert.equal(docxBuf[0], 0x50);
  assert.equal(docxBuf[1], 0x4b);
  const docxEntries = parseZipArchive(docxBuf);
  assert.ok(docxEntries.has("[Content_Types].xml"));
  assert.ok(docxEntries.has("_rels/.rels"));
  assert.ok(docxEntries.has("word/document.xml"));
  assert.ok(docxEntries.has("word/_rels/document.xml.rels"));
  assert.ok(docxEntries.has("word/styles.xml"));
  assert.ok(docxEntries.has("word/numbering.xml"));
  assert.ok(
    [...docxEntries.keys()].some((k) => k.startsWith("word/media/image") && k.endsWith(".png")),
    "DOCX embeds PNG media entry",
  );
  const docXml = docxEntries.get("word/document.xml").toString("utf8");
  assert.match(docXml, /Module 01 - Create an agent/);
  assert.match(docXml, /Microsoft Dataverse/);
  assert.match(docXml, /<w:tbl>/);
  assert.match(docXml, /<w:drawing>/);

  const pdfBuf = renderMarkdownToPdfBuffer(sampleMd, {
    title: "Module 01 - Create an agent",
    branding: {
      companyName: "Contoso Financial",
      tagline: "AI Enablement Workshop",
      primaryColor: "#005A9E",
    },
    resolveImageBuffer: () => samplePng,
  });
  const pdfHead = pdfBuf.subarray(0, 16).toString("latin1");
  const pdfText = pdfBuf.toString("latin1");
  assert.match(pdfHead, /^%PDF-1\.4/);
  assert.match(pdfText, /\/Type \/Catalog/);
  assert.match(pdfText, /\/Type \/Pages/);
  assert.match(pdfText, /\/Subtype \/Image/);
  assert.match(pdfText, /\nxref\n/);
  assert.match(pdfText, /%%EOF\s*$/);
  assert.match(pdfText, /Module 01 - Create an agent/);
});

test("per-module ZIP export creates titled module folders, scenario sample-files, and honors docx/pdf/html/all format filters over HTTP", async () => {
  const { dir: genRoot, cleanup } = tempDir("module-zip-http-");
  let srv = null;
  try {
    const built = await generateLab(
      {
        vertical: "retail",
        departments: ["sales", "operations"],
        products: ["copilot-studio"],
        harness: "standard",
        levels: [100, 200, 300],
        features: [
          "create-agent",
          "knowledge-sharepoint",
          "custom-connectors",
          "adaptive-cards",
          "evaluations",
        ],
      },
      { outputRoot: genRoot, useLearnMcp: false, useLlm: false },
    );
    assert.equal(built.status, "complete");
    assert.equal(built.validation.failed, 0);
    assert.deepEqual(built.qa.findings.filter((f) => f.severity === "error"), []);

    // Check sanitizeFilesystemTitle & formatModuleBaseName
    assert.equal(
      sanitizeFilesystemTitle("Module 1: Connect REST/OpenAPI?:*<>| Tool"),
      "Module 1 - Connect REST - OpenAPI - Tool",
    );
    assert.equal(formatModuleBaseName(2, "Ground on SharePoint"), "Module 02 - Ground on SharePoint");

    // Verify readGeneratedLab exposes adminPrerequisites
    const readRes = readGeneratedLab(genRoot, built.labId, (md) => md);
    assert.equal(readRes.status, 200);
    assert.ok(readRes.body.adminPrerequisites?.connectors?.length >= 2);

    // Verify normalizeDocFormats validation
    assert.deepEqual(normalizeDocFormats("all"), ["docx", "pptx", "pdf", "html"]);
    assert.deepEqual(normalizeDocFormats("docx"), ["docx"]);
    assert.deepEqual(normalizeDocFormats("pptx"), ["pptx"]);
    assert.deepEqual(normalizeDocFormats("pdf,html"), ["pdf", "html"]);
    assert.throws(() => normalizeDocFormats("exe"), /Unsupported document format/);

    // Direct programmatic export with formats="all"
    const allZipBuf = await collectStream((out) =>
      exportGeneratedLab(genRoot, built.labId, { Contoso: "Northwind Traders" }, out, {
        resolveAsset: resolveGeneratedAsset,
        formats: "all",
      }),
    );
    const allZip = parseZipArchive(allZipBuf);
    const allPaths = [...allZip.keys()];

    // The export-manifest names the short lab folder; the ZIP no longer uses the long lab id as its root.
    const exportManifest = JSON.parse(allZip.get("export-manifest.json").toString("utf8"));
    const labFolder = exportManifest.labFolder;
    assert.ok(labFolder && labFolder.length <= 30 && labFolder !== built.labId, `short lab folder, got: ${labFolder}`);

    // Backward-compatible root lab files remain intact, while raw unbranded topics/ binaries are omitted from ZIP
    assert.ok(allZip.has(`${labFolder}/index.md`));
    assert.ok(allZip.has(`${labFolder}/index.html`));
    assert.ok(allZip.has(`${labFolder}/manifest.json`));
    assert.ok(allZip.has("export-manifest.json"));
    assert.ok(!allPaths.some((p) => p.startsWith(`${labFolder}/topics/`)), "Raw disk topics/ folder is not duplicated in ZIP");

    assert.deepEqual(exportManifest.formats, ["docx", "pptx", "pdf", "html"]);
    assert.equal(exportManifest.modules.length, built.manifest.modules.length);

    // Overview folder has all 4 formats, and no administrator setup (that is in "For the administrator/")
    const overviewPrefix = `${labFolder}/00 - Overview/Lab Overview`;
    assert.ok(allZip.has(`${overviewPrefix}.docx`));
    assert.ok(allZip.has(`${overviewPrefix}.pptx`));
    assert.ok(allZip.has(`${overviewPrefix}.pdf`));
    assert.ok(allZip.has(`${overviewPrefix}.html`));

    // Every module is in its own `NN <short title>` folder with short named .docx, .pptx, .pdf, .html AND sample-files/
    for (const mod of exportManifest.modules) {
      assert.match(mod.folder, new RegExp(`^${labFolder}/\\d{2} .+`));
      assert.ok(mod.fileBaseName.includes(" - "), `Expected the lab's own per-module name, got: ${mod.fileBaseName}`);
      const [docxPath, pptxPath, pdfPath, htmlPath] = mod.documents;
      assert.match(docxPath, /\/\d{2}( .+)? - Handout\.docx$/);
      assert.match(pptxPath, /\/\d{2}( .+)? - Slides\.pptx$/);
      assert.match(pdfPath, /\/\d{2}( .+)? - PDF\.pdf$/);
      assert.match(htmlPath, /\/\d{2}( .+)? - Web page\.html$/);
      for (const path of mod.documents) assert.ok(allZip.has(path), `Missing ${path}`);
      assert.ok(allZip.has(`${mod.folder}/sample-files/README.txt`), `Missing sample-files/README.txt in ${mod.folder}`);
      assert.ok(
        mod.sampleFiles.some((path) => /\/sample-files\/starter-inputs[^/]*\.md$/.test(path)),
        `Missing the starter inputs file in ${mod.folder}`,
      );

      // Verify nested .docx inside the ZIP is itself a valid PKZIP OOXML document
      const nestedDocx = allZip.get(docxPath);
      assert.equal(nestedDocx[0], 0x50);
      assert.equal(nestedDocx[1], 0x4b);
      const innerDocx = parseZipArchive(nestedDocx);
      assert.ok(innerDocx.has("word/document.xml"));

      // Verify nested .pptx inside the ZIP is itself a valid PKZIP PresentationML deck
      const nestedPptx = allZip.get(pptxPath);
      assert.equal(nestedPptx[0], 0x50);
      assert.equal(nestedPptx[1], 0x4b);
      const innerPptx = parseZipArchive(nestedPptx);
      assert.ok(innerPptx.has("ppt/presentation.xml"));
      assert.ok(innerPptx.has("ppt/slides/slide1.xml"));

      // Verify nested .pdf inside the ZIP is a valid %PDF-1.4 binary
      const nestedPdf = allZip.get(pdfPath);
      assert.match(nestedPdf.subarray(0, 12).toString("latin1"), /^%PDF-1\.4/);
    }

    // Check capability-specific sample files across modules (SharePoint .md, OpenAPI .json, Adaptive Card .json, Evaluation .csv)
    assert.ok(allPaths.some((p) => p.endsWith("-policy-handbook.md")), "Includes SharePoint knowledge handbook sample");
    assert.ok(allPaths.some((p) => p.endsWith("-openapi-spec.json")), "Includes Custom Connector OpenAPI JSON sample");
    // Deep module folders may lose a filler word from a sample file name to stay inside the Windows path budget.
    assert.ok(allPaths.some((p) => /\/adaptive-card(-template)?\.json$/.test(p)), "Includes Adaptive Card JSON sample");
    assert.ok(allPaths.some((p) => p.endsWith("/evaluation-test-cases.csv")), "Includes Agent Evaluation CSV test set sample");

    // Boot live HTTP server and test format-specific ZIPs + direct docx/pptx/pdf + 400 validation
    srv = await bootServer({ LAB_BUILDER_OUTPUT_DIR: genRoot });

    for (const singleFmt of ["docx", "pptx", "pdf", "html"]) {
      const res = await fetch(`${srv.base}/api/lab-builder/generated/${built.labId}/export?format=zip&formats=${singleFmt}`);
      assert.equal(res.status, 200, `Expected 200 for formats=${singleFmt}`);
      assert.match(res.headers.get("content-type") || "", /application\/zip/);
      const zipEntries = parseZipArchive(Buffer.from(await res.arrayBuffer()));
      assert.ok(
        ![...zipEntries.keys()].some((p) => /(^|\/)topics\//.test(p)),
        `Single-format ZIP (${singleFmt}) must not leak unbranded topics/ files`,
      );
      const singleManifest = JSON.parse(zipEntries.get("export-manifest.json").toString("utf8"));
      const modOneFolder = singleManifest.modules[0].folder;
      const modOneDocs = singleManifest.modules[0].documents;
      assert.equal(modOneDocs.length, 1, `Expected one document for formats=${singleFmt}`);
      assert.ok(modOneDocs[0].endsWith(`.${singleFmt}`));
      assert.ok(zipEntries.has(modOneDocs[0]), `Expected .${singleFmt} in module folder`);
      for (const otherFmt of ["docx", "pptx", "pdf", "html"].filter((f) => f !== singleFmt)) {
        assert.ok(
          ![...zipEntries.keys()].some((p) => p.startsWith(`${modOneFolder}/`) && p.endsWith(`.${otherFmt}`)),
          `Did not expect .${otherFmt} when formats=${singleFmt}`,
        );
      }
      assert.ok(zipEntries.has(`${modOneFolder}/sample-files/README.txt`), "Sample files still included for single-format ZIP");
    }

    const directDocx = await fetch(`${srv.base}/api/lab-builder/generated/${built.labId}/export?format=docx`);
    assert.equal(directDocx.status, 200);
    assert.match(directDocx.headers.get("content-type") || "", /wordprocessingml/);
    const directDocxBuf = Buffer.from(await directDocx.arrayBuffer());
    assert.equal(directDocxBuf[0], 0x50);
    assert.equal(directDocxBuf[1], 0x4b);

    const directPptx = await fetch(`${srv.base}/api/lab-builder/generated/${built.labId}/export?format=pptx`);
    assert.equal(directPptx.status, 200);
    assert.match(directPptx.headers.get("content-type") || "", /presentationml\.presentation/);
    const directPptxBuf = Buffer.from(await directPptx.arrayBuffer());
    assert.equal(directPptxBuf[0], 0x50);
    assert.equal(directPptxBuf[1], 0x4b);

    const directPdf = await fetch(`${srv.base}/api/lab-builder/generated/${built.labId}/export?format=pdf`);
    assert.equal(directPdf.status, 200);
    assert.match(directPdf.headers.get("content-type") || "", /application\/pdf/);
    const directPdfBuf = Buffer.from(await directPdf.arrayBuffer());
    assert.match(directPdfBuf.subarray(0, 12).toString("latin1"), /^%PDF-1\.4/);

    const badZipFormats = await fetch(`${srv.base}/api/lab-builder/generated/${built.labId}/export?format=zip&formats=exe`);
    assert.equal(badZipFormats.status, 400);

    const labDetailRes = await fetch(`${srv.base}/api/lab-builder/generated/${built.labId}`);
    assert.equal(labDetailRes.status, 200);
    const labDetail = await labDetailRes.json();
    assert.ok(Array.isArray(labDetail.adminPrerequisites?.connectors));
  } finally {
    if (srv) srv.stop();
    cleanup();
  }
});

test("portal generated-labs UI renders format selector (all, docx, pdf, html) and admin prerequisites summary", () => {
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
    `${genLabsSrc}\nglobalThis.__genUi = { lbGeneratedActionButtonsHtml, lbRenderAdminPrerequisitesHtml, lbRenderRequiredByHtml };`,
    context,
  );

  const buttonsHtml = context.__genUi.lbGeneratedActionButtonsHtml("retail-200-lab", "Retail Workshop");
  assert.match(buttonsHtml, /data-zip-format-select/);
  assert.match(buttonsHtml, /<option value="all">/);
  assert.match(buttonsHtml, /<option value="docx">/);
  assert.match(buttonsHtml, /<option value="pptx">/);
  assert.match(buttonsHtml, /<option value="pdf">/);
  assert.match(buttonsHtml, /<option value="html">/);
  assert.match(buttonsHtml, /data-gen-action="export-zip"/);
  assert.match(buttonsHtml, /data-gen-action="export-html"/);

  const manyModules = [
    "Recap 1 - Create an agent",
    "Recap 2 - Agent instructions & persona",
    "Step 3 — Ground on SharePoint knowledge",
    "Step 18 - Create, train, and use a document processing model",
    "Step 19 - Connect a REST, GraphQL, or OpenAPI tool",
    "Step 20 - Configure autonomous event triggers",
    "Step 21 - Run evaluation test sets",
  ];

  const reqListHtml = context.__genUi.lbRenderRequiredByHtml(manyModules);
  assert.match(reqListHtml, /class="lb-prereq-req-list"/);
  // The lab's own headings stay "Recap 1" and "Step 18"; the portal shows "Refresher 1" and "Part 18", because "Step" means a wizard step there.
  assert.match(reqListHtml, /<span class="lb-prereq-req-badge lb-prereq-req-badge-recap">Refresher 1<\/span>/);
  assert.match(reqListHtml, /<span class="lb-prereq-req-badge">Part 18<\/span>/);
  assert.doesNotMatch(reqListHtml.replace(/<[^>]+>/g, " "), /\b(?:Recap|Step) \d/);
  assert.match(
    reqListHtml,
    /<span class="lb-prereq-req-title">Create, train, and use a document processing model<\/span>/,
  );
  assert.match(reqListHtml, /<details class="lb-prereq-req-more">\s*<summary>\+3 more modules \(7 total\)<\/summary>/);
  assert.doesNotMatch(reqListHtml, /Recap 1 - Create an agent,\s*Recap 2/);

  assert.match(context.__genUi.lbRenderRequiredByHtml(["All modules"]), /<span class="lb-prereq-req-title">All modules<\/span>/);
  assert.equal(context.__genUi.lbRenderRequiredByHtml([]), "");

  const prereqHtml = context.__genUi.lbRenderAdminPrerequisitesHtml({
    connectors: [
      {
        name: "Microsoft Dataverse",
        tier: "Standard",
        dataGroup: "Business",
        requiredBy: manyModules,
        purpose: "Store agent configuration and transcripts.",
      },
      {
        name: "Optional Connector",
        tier: "Standard",
        dataGroup: "Business",
        requiredBy: [],
        purpose: "No modules attached.",
      },
    ],
    dlpAndAcp: [
      {
        title: "Place required connectors in Business",
        adminPath: "PPAC > Policies",
        requiredBy: manyModules.slice(0, 5),
        detail: "Avoid blocked connector pairs.",
      },
    ],
    environmentSettings: [
      {
        title: "Code apps and Power Apps component framework (PCF) for canvas apps",
        adminPath: "PPAC > Environments > Features",
        requiredBy: ["Step 12 - Build a PCF component"],
        detail: "Enable Code apps and PCF.",
      },
    ],
    tenantAndCloud: [
      {
        title: "Microsoft Entra ID permissions",
        adminPath: "Entra admin center",
        requiredBy: ["All modules"],
        detail: "Configure SSO.",
      },
    ],
  });
  assert.match(prereqHtml, /Connectors, Environment, and Tenant Prerequisites/);
  assert.match(prereqHtml, /Microsoft Dataverse/);
  assert.match(prereqHtml, /<td class="lb-prereq-col-req"><ul class="lb-prereq-req-list">/);
  assert.match(prereqHtml, /<td class="lb-prereq-col-req"><span class="lb-prereq-req-empty">—<\/span><\/td>/);
  assert.match(prereqHtml, /<div class="lb-prereq-card-req">\s*<span class="lb-prereq-card-req-label">Required by:<\/span>/);
  assert.match(prereqHtml, /\+1 more module \(5 total\)/);
  assert.match(prereqHtml, /Code apps and Power Apps component framework \(PCF\) for canvas apps/);

  const indexHtml = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(indexHtml, /\.lb-prereq-req-list\s*\{/);
  assert.match(indexHtml, /\.lb-prereq-req-more\s*\{/);
  assert.match(indexHtml, /@media print[\s\S]*?\.lb-admin-prereqs[\s\S]*?\.lb-prereq-req-more/);
});

test("multi-module Required By entries render real line breaks across Markdown, standalone HTML, DOCX, and PDF exports", () => {
  const modulesWithCommasAndPipes = [
    "Recap 1 - Create an agent",
    "Recap 2 - Agent instructions, tone, and persona",
    "Step 3 — Ground on SharePoint knowledge",
    "Step 18 - Create, train, and use a document processing model",
    "Step 19 - Connect REST | OpenAPI tool",
    "Step 20 - Configure autonomous triggers",
  ];

  const prereqs = {
    summary: "Review these environment and tenant prerequisites before starting the workshop.",
    connectors: [
      {
        name: "Microsoft Dataverse",
        classification: "Standard",
        dataGroup: "Business",
        requiredBy: modulesWithCommasAndPipes,
        details: "Stores agent state and transcripts.",
        endpoints: ["*.crm.dynamics.com"],
      },
      {
        name: "SharePoint",
        classification: "Standard",
        dataGroup: "Business",
        requiredBy: ["Step 3 — Ground on SharePoint knowledge"],
        details: "Grounds responses on intranet sites.",
        endpoints: [],
      },
    ],
    dlpAndAcp: [
      {
        title: "Align Business data group",
        status: "Required",
        adminPath: "PPAC > Policies > Data policies",
        details: "Keep Dataverse and SharePoint in the Business group.",
        requiredBy: modulesWithCommasAndPipes.slice(0, 3),
      },
    ],
    environmentSettings: [],
    tenantAndCloud: [],
  };

  const md = renderAdminPrerequisitesMarkdown(prereqs);
  assert.doesNotMatch(
    md,
    /Recap 1 - Create an agent,\s*Recap 2/,
    "Connector Required By cell must not join modules with commas",
  );
  assert.match(
    md,
    /• \*\*Recap 1:\*\* Create an agent<br>• \*\*Recap 2:\*\* Agent instructions, tone, and persona<br>• \*\*Step 3:\*\* Ground on SharePoint knowledge<br>• \*\*Step 18:\*\* Create, train, and use a document processing model<br>• \*\*Step 19:\*\* Connect REST \\\| OpenAPI tool/,
  );
  assert.match(
    md,
    /<br>\*\*Required by:\*\*<br>• \*\*Recap 1:\*\* Create an agent<br>• \*\*Recap 2:\*\* Agent instructions, tone, and persona/,
  );

  // Portal live Markdown preview (#lb-result-preview / #preview-area)
  const previewHtml = renderLabMarkdown(md);
  assert.match(previewHtml, /<strong>Step 18:<\/strong> Create, train, and use a document processing model<br\s*\/?>/);
  assert.doesNotMatch(previewHtml, /&lt;br\s*\/?&gt;/i);

  // Standalone HTML export (html-lab.js) + inline code safety check
  assert.equal(renderLabHtmlDocument, renderStandaloneLabHtml);
  const mdWithInlineCodeBr = `${md}\n\nKeep literal \`<br>\` inside inline code spans untouched.\n`;
  const standaloneHtml = renderLabHtmlDocument(mdWithInlineCodeBr, { title: "Prereq Line Break Test" });
  assert.match(
    standaloneHtml,
    /<strong>Recap 1:<\/strong> Create an agent<br>• <strong>Recap 2:<\/strong> Agent instructions, tone, and persona/,
  );
  assert.match(standaloneHtml, /Connect REST \| OpenAPI tool/);
  assert.match(standaloneHtml, /<code>&lt;br&gt;<\/code>/, "Inline code `<br>` stays escaped");
  const htmlWithoutCode = standaloneHtml.replace(/<code>[\s\S]*?<\/code>/g, "");
  assert.doesNotMatch(htmlWithoutCode, /&lt;br\s*\/?&gt;/i, "No escaped <br> leaks into table cells or checklist items");

  // Word .docx export (docx-builder.js)
  const docxBuf = renderMarkdownToDocxBuffer(mdWithInlineCodeBr, { title: "Prereq Line Break Test" });
  const docxEntries = parseZipArchive(docxBuf);
  const docXml = docxEntries.get("word/document.xml").toString("utf8");
  assert.match(docXml, /<w:r><w:br\/><\/w:r>/, "DOCX emits real OOXML <w:br/> elements");
  assert.match(docXml, /Create, train, and use a document processing model/);
  assert.match(docXml, /Connect REST \| OpenAPI tool/);
  // Only the inline `<code>` run should contain escaped &lt;br&gt;
  const escapedBrMatches = docXml.match(/&lt;br&gt;/gi) || [];
  assert.equal(escapedBrMatches.length, 1, "Only the backtick code span contains literal &lt;br&gt; in DOCX");

  // Adobe .pdf export (pdf-builder.js) — verify real vertical line breaks + ultra-tall 40-module pagination
  const fortyModules = Array.from(
    { length: 40 },
    (_, idx) => `Step ${idx + 1} - Configure module ${idx + 1}, policies, and validation`,
  );
  const tallMd = renderAdminPrerequisitesMarkdown({
    ...prereqs,
    connectors: [
      ...prereqs.connectors,
      {
        name: "HTTP with Microsoft Entra ID",
        classification: "Premium",
        dataGroup: "Business",
        requiredBy: fortyModules,
        details: "Calls downstream enterprise APIs.",
        endpoints: [],
      },
    ],
  }) + "\n\nKeep literal `<br>` inside inline code spans untouched.\n";

  const pdfBuf = renderMarkdownToPdfBuffer(tallMd, { title: "Prereq Line Break Test" });
  const pdfLatin1 = pdfBuf.toString("latin1");
  assert.match(pdfLatin1, /^%PDF-1\.4/);

  // Decompress all /FlateDecode page content streams to inspect exact PDF text operators.
  const decodedPages = [];
  const flateRe = /<< \/Filter \/FlateDecode \/Length (\d+) >>\nstream\n/g;
  let streamMatch;
  while ((streamMatch = flateRe.exec(pdfLatin1)) !== null) {
    const byteLen = Number(streamMatch[1]);
    const startOffset = streamMatch.index + streamMatch[0].length;
    const compressed = pdfBuf.subarray(startOffset, startOffset + byteLen);
    decodedPages.push(inflateSync(compressed).toString("latin1"));
  }
  assert.ok(decodedPages.length >= 2, "40-module prerequisite table paginates cleanly across multiple PDF pages");
  const pdfOps = decodedPages.join("\n");

  assert.match(pdfOps, /\(\\225\) Tj/, "Bullet glyph renders as WinAnsi 0o225 in PDF");
  assert.match(pdfOps, /\(18:\) Tj/);
  assert.match(pdfOps, /\(40:\) Tj/);

  // Extract baseline Y coordinates for 18: and 19: to prove they sit on distinct vertical rows,
  // and verify no baseline drops below the bottom page margin (25pt footer, 54pt body margin).
  const tdMatches = [...pdfOps.matchAll(/([0-9.]+) ([0-9.]+) Td \(([^)]*(?:\\\)[^)]*)*)\) Tj/g)];
  const step18Op = tdMatches.find((m) => m[3] === "18:");
  const step19Op = tdMatches.find((m) => m[3] === "19:");
  assert.ok(step18Op && step19Op, "Both Step 18: and Step 19: appear as bold PDF runs");
  assert.notEqual(step18Op[2], step19Op[2], "Step 18 and Step 19 render on distinct PDF baselines");

  for (const m of tdMatches) {
    const y = Number(m[2]);
    assert.ok(y >= 20 && y <= 792, `PDF text baseline ${y} must stay within page bounds (token: ${m[3]})`);
  }

  // Only the Courier (/F4) code token may contain literal "<br>"
  const literalBrOps = [...pdfOps.matchAll(/\/(F\d) [0-9.]+ Tf [^()]*\(([^)]*<br>[^)]*)\) Tj/gi)];
  assert.equal(literalBrOps.length, 1, "Only inline code span renders literal <br> in PDF");
  assert.equal(literalBrOps[0][1], "F4");
});
