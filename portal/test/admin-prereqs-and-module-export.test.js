import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { PassThrough } from "node:stream";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync, inflateRawSync } from "node:zlib";
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
    assert.match(built.markdown, /## Connectors, Environment, and Tenant Prerequisites/);
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
    assert.deepEqual(normalizeDocFormats("all"), ["docx", "pdf", "html"]);
    assert.deepEqual(normalizeDocFormats("docx"), ["docx"]);
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

    // Backward-compatible root lab files remain intact
    assert.ok(allZip.has(`${built.labId}/index.md`));
    assert.ok(allZip.has(`${built.labId}/index.html`));
    assert.ok(allZip.has(`${built.labId}/manifest.json`));
    assert.ok(allZip.has("export-manifest.json"));

    const exportManifest = JSON.parse(allZip.get("export-manifest.json").toString("utf8"));
    assert.deepEqual(exportManifest.formats, ["docx", "pdf", "html"]);
    assert.equal(exportManifest.modules.length, built.manifest.modules.length);

    // Overview folder has all 3 formats
    const overviewPrefix = `${built.labId}/00 - Overview and Admin Prerequisites/Lab Overview and Admin Prerequisites`;
    assert.ok(allZip.has(`${overviewPrefix}.docx`));
    assert.ok(allZip.has(`${overviewPrefix}.pdf`));
    assert.ok(allZip.has(`${overviewPrefix}.html`));

    // Every module is in its own `Module NN - <Title>` folder with .docx, .pdf, .html AND sample-files/
    for (const mod of exportManifest.modules) {
      assert.match(mod.folder, new RegExp(`^${built.labId}/Module \\d{2} - .+`));
      const expectedBase = mod.folder.split("/").pop();
      assert.ok(allZip.has(`${mod.folder}/${expectedBase}.docx`), `Missing DOCX in ${mod.folder}`);
      assert.ok(allZip.has(`${mod.folder}/${expectedBase}.pdf`), `Missing PDF in ${mod.folder}`);
      assert.ok(allZip.has(`${mod.folder}/${expectedBase}.html`), `Missing HTML in ${mod.folder}`);
      assert.ok(allZip.has(`${mod.folder}/sample-files/README.txt`), `Missing sample-files/README.txt in ${mod.folder}`);
      assert.ok(
        allZip.has(`${mod.folder}/sample-files/starter-inputs-and-prompts.md`),
        `Missing starter-inputs-and-prompts.md in ${mod.folder}`,
      );

      // Verify nested .docx inside the ZIP is itself a valid PKZIP OOXML document
      const nestedDocx = allZip.get(`${mod.folder}/${expectedBase}.docx`);
      assert.equal(nestedDocx[0], 0x50);
      assert.equal(nestedDocx[1], 0x4b);
      const innerDocx = parseZipArchive(nestedDocx);
      assert.ok(innerDocx.has("word/document.xml"));

      // Verify nested .pdf inside the ZIP is a valid %PDF-1.4 binary
      const nestedPdf = allZip.get(`${mod.folder}/${expectedBase}.pdf`);
      assert.match(nestedPdf.subarray(0, 12).toString("latin1"), /^%PDF-1\.4/);
    }

    // Check capability-specific sample files across modules (SharePoint .md, OpenAPI .json, Adaptive Card .json, Evaluation .csv)
    assert.ok(allPaths.some((p) => p.endsWith("-policy-handbook.md")), "Includes SharePoint knowledge handbook sample");
    assert.ok(allPaths.some((p) => p.endsWith("-openapi-spec.json")), "Includes Custom Connector OpenAPI JSON sample");
    assert.ok(allPaths.some((p) => p.endsWith("/adaptive-card-template.json")), "Includes Adaptive Card JSON sample");
    assert.ok(allPaths.some((p) => p.endsWith("/evaluation-test-cases.csv")), "Includes Agent Evaluation CSV test set sample");

    // Boot live HTTP server and test format-specific ZIPs + direct docx/pdf + 400 validation
    srv = await bootServer({ LAB_BUILDER_OUTPUT_DIR: genRoot });

    for (const singleFmt of ["docx", "pdf", "html"]) {
      const res = await fetch(`${srv.base}/api/lab-builder/generated/${built.labId}/export?format=zip&formats=${singleFmt}`);
      assert.equal(res.status, 200, `Expected 200 for formats=${singleFmt}`);
      assert.match(res.headers.get("content-type") || "", /application\/zip/);
      const zipEntries = parseZipArchive(Buffer.from(await res.arrayBuffer()));
      const modOneFolder = exportManifest.modules[0].folder;
      const modOneBase = modOneFolder.split("/").pop();
      assert.ok(zipEntries.has(`${modOneFolder}/${modOneBase}.${singleFmt}`), `Expected .${singleFmt} in module folder`);
      for (const otherFmt of ["docx", "pdf", "html"].filter((f) => f !== singleFmt)) {
        assert.ok(
          !zipEntries.has(`${modOneFolder}/${modOneBase}.${otherFmt}`),
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
  vm.runInContext(
    `${genLabsSrc}\nglobalThis.__genUi = { lbGeneratedActionButtonsHtml, lbRenderAdminPrerequisitesHtml };`,
    context,
  );

  const buttonsHtml = context.__genUi.lbGeneratedActionButtonsHtml("retail-200-lab", "Retail Workshop");
  assert.match(buttonsHtml, /data-zip-format-select/);
  assert.match(buttonsHtml, /<option value="all">/);
  assert.match(buttonsHtml, /<option value="docx">/);
  assert.match(buttonsHtml, /<option value="pdf">/);
  assert.match(buttonsHtml, /<option value="html">/);
  assert.match(buttonsHtml, /data-gen-action="export-zip"/);
  assert.match(buttonsHtml, /data-gen-action="export-html"/);

  const prereqHtml = context.__genUi.lbRenderAdminPrerequisitesHtml({
    connectors: [
      { name: "SharePoint", tier: "Standard", dataGroup: "Business", requiredBy: ["Ground on SharePoint"], purpose: "Read documents" },
    ],
    dlpAndAcp: [
      { title: "Place required connectors in Business", adminPath: "PPAC > Policies", requiredBy: ["Ground on SharePoint"], detail: "Avoid blocked connector pairs." },
    ],
    environmentSettings: [
      { title: "Code apps and Power Apps component framework (PCF) for canvas apps", adminPath: "PPAC > Environments > Features", requiredBy: ["PCF component"], detail: "Enable Code apps and PCF." },
    ],
    tenantAndCloud: [
      { title: "Microsoft Entra ID permissions", adminPath: "Entra admin center", requiredBy: ["All modules"], detail: "Configure SSO." },
    ],
  });
  assert.match(prereqHtml, /Connectors, Environment, and Tenant Prerequisites/);
  assert.match(prereqHtml, /SharePoint/);
  assert.match(prereqHtml, /Code apps and Power Apps component framework \(PCF\) for canvas apps/);
});
