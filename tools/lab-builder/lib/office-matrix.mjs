/**
 * Builds a matrix of Office exports (PPTX and DOCX) for validation: synthetic
 * topics covering branding, logos, images, special characters and size extremes,
 * plus real generated labs exported through the portal exporter (full-lab deck,
 * per-topic decks, facilitator guide and ZIP bundle contents).
 *
 * Used by portal/test/office-export-validity.test.js (hermetic, strict checks) and
 * tools/lab-builder/validate-office.mjs (Open XML SDK validator + real Office).
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { crc32, deflateSync } from "node:zlib";
import { readZipStrict } from "./ooxml-strict.mjs";

// A real 8x6 JPEG so image parts are decodable without extra dependencies.
const SAMPLE_JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAGAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDHooor6A8E/9k=";

export const SAMPLE_JPEG = Buffer.from(SAMPLE_JPEG_BASE64, "base64");

/** Build a small solid-color PNG. */
export function makePng(width = 4, height = 3, [r, g, b] = [0, 120, 212]) {
  const chunk = (type, data) => {
    const typeBuf = Buffer.from(type, "ascii");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Characters that have broken Office packages: XML specials, C0 controls, U+FFFE/U+FFFF,
// lone surrogates, emoji, combining marks, right-to-left and CJK text, CDATA terminators.
export const NASTY_TEXT =
  "Tom & Jerry's \"quoted\" <tag> ]]> &amp; &#x0; tab\there nul\u0000 bs\u0008 vt\u000B ff\u000C us\u001F " +
  "noncharacter\uFFFE\uFFFF lone\uD83D high lone\uDE00 low emoji \u{1F600}\u{1F680} e\u0301 \u0645\u0631\u062D\u0628\u0627 \u65E5\u672C\u8A9E";

const LEARN_URL = "https://learn.microsoft.com/en-us/microsoft-copilot-studio/knowledge-add-sharepoint?a=1&b=2";

function quizBlock(n, question) {
  return [
    `${n}. ${question}`,
    "   - A) Anyone with the agent link can read every document",
    "   - B) It enforces the signed-in user's SharePoint permissions at query time",
    "   - C) It copies files into public blob storage",
    "",
    "<details>",
    `<summary>Question ${n} answer</summary>`,
    "",
    `**Correct answer:** B — Copilot Studio queries SharePoint with the signed-in identity. [Knowledge sources](${LEARN_URL})`,
    "",
    "</details>",
    "",
  ];
}

/** Structured topic Markdown shaped like generated module output. */
export function buildTopicMarkdown({ steps = 7, tableRows = 2, tableCols = 2, quizzes = 1, references = 2, codeLines = 1, special = false, longParagraph = 0, subSteps = false } = {}) {
  const flavor = (text) => (special ? `${text} ${NASTY_TEXT}` : text);
  const lines = [
    `# ${flavor("Ground on SharePoint knowledge")}`,
    "",
    `*Part of lab: **${flavor("Healthcare Patient Support Lab")}** · Step 2 · ~25 min*`,
    "",
    "| Field | Details |",
    "| --- | --- |",
    `| **Module** | Step 2 — ${flavor("Ground on SharePoint knowledge")} |`,
    "| **Estimated Time** | ~25 min |",
    "| **Level** | Level 200 |",
    "",
    "---",
    "",
    `### Step 2 — ${flavor("Ground on SharePoint knowledge")}`,
    "",
    `**Why this matters:** ${flavor("Grounding your agent on curated SharePoint sites ensures responses cite authoritative policies.")}`,
    "",
    `In your scenario, ${flavor("Contoso Health clinical coordinators")} ask policy questions that must be answered strictly from approved libraries.`,
    "",
    "**Key concepts:**",
    "",
    `- **Generative answers**: ${flavor("Synthesizes grounded answers from indexed pages.")}`,
    "- **Tenant graph permissions**: Enforces the signed-in user's SharePoint ACLs at query time.",
    "",
    "**Do this:**",
    "",
    ...Array.from({ length: steps }, (_v, i) => {
      const line = `${i + 1}. ${flavor(`Perform action ${i + 1} in **Microsoft Copilot Studio** and select [Learn](${LEARN_URL}).`)}`;
      if (!subSteps || i % 2) return [line];
      // Lettered sub-steps, as the lab composer writes them: indented under the step, with a note on the last line.
      return [
        `${line} Choose from:  `,
        `   a. ${flavor(`Select **Agent** under [Start building from scratch](${LEARN_URL}).`)}  `,
        `   b. ${flavor("Select **Create blank agent**, enter a name for the agent, and select **Create**.")}  `,
        "   More choices are in the linked article.",
      ];
    }).flat(),
    "",
    "![SharePoint knowledge source configuration](assets/02-sharepoint-knowledge.png)",
    "",
    `| ${Array.from({ length: tableCols }, (_v, c) => `Column ${c + 1}`).join(" | ")} |`,
    `| ${Array.from({ length: tableCols }, () => "---").join(" | ")} |`,
    ...Array.from({ length: tableRows }, (_v, r) => `| ${Array.from({ length: tableCols }, (_w, c) => flavor(`Row ${r + 1} value ${c + 1}`)).join(" | ")} |`),
    "",
    "```text",
    ...Array.from({ length: codeLines }, (_v, i) => flavor(`Summarize the outpatient triage escalation policy ${i + 1} and cite the exact document.`)),
    "```",
    "",
    "**What you should see:**",
    "",
    "- The SharePoint source shows a Ready status",
    "",
    "**Check your work:**",
    "",
    "- [ ] SharePoint source appears with Ready status under Knowledge",
    "- [ ] Test pane response includes an inline citation to the policy document",
    "",
    "<details>",
    "<summary>Troubleshooting — common pitfalls &amp; fixes</summary>",
    "",
    `- **Agent returns ungrounded general knowledge** — ${flavor("Verify Web Search is turned off.")}`,
    "",
    "</details>",
    "",
  ];
  if (longParagraph) lines.push("A".repeat(longParagraph).replace(/(.{80})/g, "$1 "), "");
  if (quizzes) {
    lines.push("#### Knowledge check", "");
    for (let q = 1; q <= quizzes; q += 1) lines.push(...quizBlock(q, flavor(`How does grounding enforce document access (variant ${q})?`)));
  }
  lines.push(
    "**References:**",
    "",
    ...Array.from({ length: references }, (_v, i) => `- [${flavor(`Reference ${i + 1}`)}](${LEARN_URL}&ref=${i + 1})`),
  );
  return lines.join("\n");
}

const BRANDS = {
  plain: null,
  branded: {
    companyName: "Fabrikam & Sons <Ltd>",
    tagline: 'Clinical "AI" Enablement',
    primaryColor: "#C2410C",
    secondaryColor: "#0F766E",
    font: "georgia",
    coverSubtitle: "Spring cohort & friends",
    footerText: "Fabrikam Internal Training",
    moreInfoLabel: "Fabrikam portal",
    moreInfoUrl: "https://learn.contoso.com/ai?x=1&y=2",
    supportName: "AI Help Desk",
    supportEmail: "ai-help@contoso.com",
    communityUrl: "https://community.contoso.com/ai",
  },
};

const SMALL_LAB = {
  title: "Northwind Patient Triage Lab",
  industry: "healthcare",
  departments: ["customer-service"],
  products: ["copilot-studio"],
  harness: "standard",
  level: 200,
  features: ["knowledge-sharepoint", "adaptive-cards"],
  includeKnowledgeCheck: true,
};

const LARGE_LAB = {
  title: "Contoso Enterprise Agent Program",
  industry: "healthcare",
  departments: ["customer-service"],
  products: ["copilot-studio"],
  harness: "standard",
  level: 200,
  features: [
    "create-agent", "agent-instructions", "generative-orchestration", "model-selection", "publish-agent", "test-agent",
    "topics", "entities-variables", "adaptive-cards", "power-fx", "knowledge-sharepoint", "knowledge-files-web",
    "connector-tools", "prompt-tools", "mcp-servers",
  ],
  includeKnowledgeCheck: true,
};

const SPECIAL_LAB = {
  ...SMALL_LAB,
  title: "R&D <Triage> \"Lab\" 100% Ünïcode ✓",
  includeKnowledgeCheck: false,
};

// Both Copilot Studio harnesses, one after another: the section dividers, the "Same idea, different place" slide, and the
// per-part training decks, the facilitator guide and the administrator guide of a combined lab.
const BOTH_LAB = {
  title: "Fabrikam Two Harness Lab",
  industry: "retail",
  products: ["copilot-studio"],
  harnessMode: "both",
  features: ["mc-harness-choice", "dlp-governance", "create-agent", "knowledge-sharepoint", "mc-create-agent", "mc-knowledge"],
  includeKnowledgeCheck: true,
};

function collectStream() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });
  return { stream, done: new Promise((resolve, reject) => {
    stream.on("finish", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  }) };
}

/**
 * Build the matrix.
 *
 * @param {{ labs?: boolean, largeLab?: boolean, log?: (msg: string) => void }} [options]
 * @returns {Promise<{ cases: Array<{ id: string, kind: "pptx"|"docx", label: string, buffer: Buffer, expectNotes?: boolean }>, dir: string, cleanup: () => void }>}
 */
export async function buildOfficeMatrix({ labs = true, largeLab = true, log = () => {} } = {}) {
  process.env.LAB_BUILDER_VENDOR_DOCS ??= "off";
  process.env.LAB_BUILDER_LINK_CHECK ??= "off";
  const portal = (rel) => import(new URL(`../../../portal/lib/${rel}`, import.meta.url).href);
  const { renderTopicToPptxBuffer, renderMarkdownToPptxBuffer } = await portal("lab-builder/pptx-builder.js");
  const { renderMarkdownToDocxBuffer } = await portal("lab-builder/docx-builder.js");

  const dir = mkdtempSync(join(tmpdir(), "office-matrix-"));
  const cases = [];
  const add = (id, kind, label, buffer, extra = {}) => cases.push({ id, kind, label, buffer, ...extra });

  const png = makePng(4, 3);
  const bigPng = makePng(320, 180, [15, 108, 189]);
  const topicHints = {
    labTitle: "Healthcare Patient Support Lab",
    stepLabel: "Step 2",
    topicTitle: "Ground on SharePoint knowledge",
    products: "Microsoft Copilot Studio",
  };
  const richBranding = { ...BRANDS.branded, logoBuffer: png };
  const scenarios = [
    ["rich-branded-png", "rich topic, branded, PNG logo and image", buildTopicMarkdown(), richBranding, () => png],
    ["rich-branded-jpeg", "rich topic, branded, JPEG logo and image", buildTopicMarkdown(), { ...BRANDS.branded, logoBuffer: SAMPLE_JPEG }, () => SAMPLE_JPEG],
    ["rich-large-image", "rich topic, large PNG screenshot", buildTopicMarkdown(), { primaryColor: "#0F6CBD" }, () => bigPng],
    ["rich-unbranded", "rich topic, no branding, image missing", buildTopicMarkdown(), undefined, () => null],
    ["special-characters", "topic with XML specials, control characters, emoji and RTL", buildTopicMarkdown({ special: true }), { ...BRANDS.branded, companyName: NASTY_TEXT.slice(0, 70), logoBuffer: png }, () => png],
    ["lettered-substeps", "topic whose steps have lettered sub-steps", buildTopicMarkdown({ steps: 12, subSteps: true }), richBranding, () => png],
    [
      "large-topic",
      "topic with 80 steps, 60x9 table, long code, 12 quizzes, 40 references",
      buildTopicMarkdown({ steps: 80, tableRows: 60, tableCols: 9, quizzes: 12, references: 40, codeLines: 300, longParagraph: 30000 }),
      richBranding,
      () => png,
    ],
  ];
  for (const [id, label, markdown, branding, resolve] of scenarios) {
    log(`pptx ${id}`);
    const buffer = renderTopicToPptxBuffer(markdown, {
      title: `Healthcare Patient Support Lab - Step 2 - ${id}`,
      branding,
      resolveImageBuffer: resolve,
      topic: topicHints,
    });
    add(`topic-${id}`, "pptx", `topic deck: ${label}`, buffer, { expectNotes: true });
    add(`topic-${id}`, "docx", `topic document: ${label}`, renderMarkdownToDocxBuffer(markdown, { title: `Topic ${id}`, branding, resolveImageBuffer: resolve }));
  }

  const overview = "# Overview\n\nBuild and validate a grounded agent.\n\n## Goals\n\n- First goal\n- Second goal\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n";
  add("markdown-overview", "pptx", "generic Markdown overview deck", renderMarkdownToPptxBuffer(overview, { title: "Overview deck" }));
  add("markdown-empty", "pptx", "empty Markdown deck", renderMarkdownToPptxBuffer("", { title: "Empty deck" }));
  add("markdown-special", "pptx", "generic Markdown with special characters", renderMarkdownToPptxBuffer(`# ${NASTY_TEXT}\n\n${NASTY_TEXT}\n\n- ${NASTY_TEXT}\n`, { title: NASTY_TEXT }));
  add("markdown-overview", "docx", "generic Markdown overview document", renderMarkdownToDocxBuffer(overview, { title: "Overview doc" }));
  add("markdown-special", "docx", "generic Markdown document with special characters", renderMarkdownToDocxBuffer(`# ${NASTY_TEXT}\n\n${NASTY_TEXT}\n\n- ${NASTY_TEXT}\n\n| ${NASTY_TEXT} | B |\n| --- | --- |\n| ${NASTY_TEXT} | 2 |\n`, { title: NASTY_TEXT }));

  if (labs) {
    const { generateLab } = await portal("lab-builder/generator.js");
    const exporter = await portal("exporter.js");
    const { writeGeneratedLabTopicDocuments } = await portal("lab-builder/topic-documents.js");
    const { writeGeneratedLabTrainingDecks } = await portal("lab-builder/training-decks.js");

    const labSpecs = [["lab-small", SMALL_LAB], ["lab-special", SPECIAL_LAB], ["lab-both", BOTH_LAB]];
    if (largeLab) labSpecs.push(["lab-large", LARGE_LAB]);
    const logoPath = join(dir, "logo.png");
    writeFileSync(logoPath, png);

    for (const [id, spec] of labSpecs) {
      log(`generating ${id}`);
      const root = join(dir, id);
      mkdirSync(root, { recursive: true });
      const built = await generateLab(spec, { outputRoot: root, useLearnMcp: false, useLlm: false });
      const topicsDir = join(built.outputDir, "topics");
      const readTopics = (tag) => {
        for (const file of readdirSync(topicsDir).sort()) {
          const m = file.match(/\.(pptx|docx)$/);
          if (m) add(`${id}-topic-${tag}-${file.replace(/[^A-Za-z0-9]+/g, "-").slice(-48)}`, m[1], `${id} per-topic ${m[1]} (${tag}) ${file}`, readFileSync(join(topicsDir, file)), m[1] === "pptx" ? { expectNotes: true } : {});
        }
      };
      readTopics("plain");

      // The pre-lab training decks: the complete deck, the foundations decks, and one per topic.
      const trainingDir = join(built.outputDir, "training");
      const readTraining = (tag) => {
        for (const file of readdirSync(trainingDir).sort()) {
          if (!/\.pptx$/.test(file)) continue;
          add(`${id}-training-${tag}-${file.replace(/[^A-Za-z0-9]+/g, "-").slice(-48)}`, "pptx", `${id} training deck (${tag}) ${file}`, readFileSync(join(trainingDir, file)), { expectNotes: true });
        }
      };
      readTraining("plain");
      const variants = [["plain", undefined, undefined], ["branded", BRANDS.branded, logoPath]];
      if (id === "lab-large") variants.length = 1;
      for (const [tag, branding, logoSourcePath] of variants) {
        const opts = { branding, logoSourcePath };
        const full = exporter.renderGeneratedLabPptx(root, built.labId, {}, opts);
        add(`${id}-full-${tag}`, "pptx", `${id} full-lab deck (${tag})`, full.buffer, { expectNotes: true });
        const docx = exporter.renderGeneratedLabDocx(root, built.labId, {}, opts);
        add(`${id}-full-${tag}`, "docx", `${id} full-lab document (${tag})`, docx.buffer);
        const fac = exporter.renderGeneratedLabFacilitatorDocx(root, built.labId, {}, opts);
        if (fac.buffer) add(`${id}-facilitator-${tag}`, "docx", `${id} facilitator guide (${tag})`, fac.buffer);
        const prerequisites = exporter.renderGeneratedLabPrerequisites(root, built.labId, "docx", {}, opts);
        if (prerequisites.buffer) add(`${id}-prerequisites-${tag}`, "docx", `${id} standalone prerequisites checklist (${tag})`, prerequisites.buffer);
        const adminGuide = exporter.renderGeneratedLabAdminGuide(root, built.labId, "docx", {}, opts);
        if (adminGuide.buffer) add(`${id}-admin-guide-${tag}`, "docx", `${id} Administrator setup guide (${tag})`, adminGuide.buffer);
      }

      if (id !== "lab-large") {
        const docBranding = { ...BRANDS.branded, logoBuffer: png };
        writeGeneratedLabTopicDocuments(built.outputDir, { branding: docBranding });
        readTopics("branded");
        writeGeneratedLabTrainingDecks(built.outputDir, { branding: docBranding });
        readTraining("branded");

        log(`bundling ${id} ZIP`);
        const sink = collectStream();
        await exporter.exportGeneratedLab(root, built.labId, {}, sink.stream, { branding: BRANDS.branded, logoSourcePath: logoPath, formats: "all" });
        const zip = readZipStrict(await sink.done, { opc: false });
        if (zip.problems.length) throw new Error(`ZIP bundle for ${id} is not a clean archive: ${zip.problems.join("; ")}`);
        let n = 0;
        for (const [name, data] of zip.entries) {
          const m = name.match(/\.(pptx|docx)$/);
          if (!m) continue;
          n += 1;
          add(`${id}-zip-${String(n).padStart(2, "0")}`, m[1], `${id} ZIP bundle entry ${name}`, data, m[1] === "pptx" ? { expectNotes: undefined } : {});
        }
      }
    }
  }

  return { cases, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Write every case to `outDir` as `<id>.<kind>` (ids are made unique) and return the paths. */
export function writeMatrixFiles(cases, outDir) {
  mkdirSync(outDir, { recursive: true });
  const used = new Set();
  return cases.map((c) => {
    let base = c.id.replace(/[^A-Za-z0-9._-]+/g, "-");
    let name = `${base}.${c.kind}`;
    for (let i = 2; used.has(name); i += 1) name = `${base}-${i}.${c.kind}`;
    used.add(name);
    const file = join(outDir, name);
    writeFileSync(file, c.buffer);
    return { ...c, file };
  });
}
