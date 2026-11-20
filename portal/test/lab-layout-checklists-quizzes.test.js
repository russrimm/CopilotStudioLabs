import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import vm from "node:vm";

import {
  canonicalLearnUrl,
  dedupeLearnSources,
  selectRelevantLearnSource,
} from "../lib/lab-builder/learn-citations.js";
import { groundFeature } from "../lib/lab-builder/learn-mcp.js";
import { composeLab } from "../lib/lab-builder/composer.js";
import { renderDifferenceBlock } from "../lib/lab-builder/differences.js";
import { furtherLearningBlock, knowledgeCheckBlock, troubleshootingBlock } from "../lib/lab-builder/teaching.js";
import { planLab } from "../lib/lab-builder/planner.js";
import { getFeature } from "../lib/lab-builder/catalog.js";
import { FILLER_DISTRACTORS } from "../lib/lab-builder/lab-gate.js";
import { assessLab } from "../lib/lab-builder/qa.js";
import { generateLab } from "../lib/lab-builder/generator.js";
import { selectionsFromManifest } from "../lib/lab-builder/generated-labs.js";
import { renderLabMarkdown, sanitizeLabHtml } from "../lib/markdown.js";
import { renderLabMarkdownFallback, renderStandaloneLabHtml } from "../lib/lab-builder/html-lab.js";
import { renderMarkdownToDocxBuffer } from "../lib/lab-builder/docx-builder.js";
import { renderMarkdownToPdfBuffer } from "../lib/lab-builder/pdf-builder.js";

process.env.LAB_BUILDER_LINK_CHECK = "off";
process.env.LAB_BUILDER_VENDOR_DOCS = "off";

function unzipEntries(zipBuffer) {
  const entries = new Map();
  let eocdOffset = -1;
  for (let i = zipBuffer.length - 22; i >= 0; i -= 1) {
    if (zipBuffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  assert.ok(eocdOffset >= 0, "valid ZIP EOCD header expected");
  const totalEntries = zipBuffer.readUInt16LE(eocdOffset + 10);
  let cdPos = zipBuffer.readUInt32LE(eocdOffset + 16);
  for (let idx = 0; idx < totalEntries; idx += 1) {
    assert.equal(zipBuffer.readUInt32LE(cdPos), 0x02014b50);
    const method = zipBuffer.readUInt16LE(cdPos + 10);
    const compSize = zipBuffer.readUInt32LE(cdPos + 20);
    const nameLen = zipBuffer.readUInt16LE(cdPos + 28);
    const extraLen = zipBuffer.readUInt16LE(cdPos + 30);
    const commentLen = zipBuffer.readUInt16LE(cdPos + 32);
    const localOffset = zipBuffer.readUInt32LE(cdPos + 42);
    const name = zipBuffer.subarray(cdPos + 46, cdPos + 46 + nameLen).toString("utf8");
    const localNameLen = zipBuffer.readUInt16LE(localOffset + 26);
    const localExtraLen = zipBuffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const compSlice = zipBuffer.subarray(dataStart, dataStart + compSize);
    const rawData = method === 0 ? Buffer.from(compSlice) : inflateRawSync(compSlice);
    entries.set(name, rawData);
    cdPos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function hexToRgb(hex) {
  const clean = hex.replace("#", "").trim();
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

function luminance([r, g, b]) {
  const srgb = [r, g, b].map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
}

function contrastRatio(fg, bg) {
  const l1 = luminance(hexToRgb(fg));
  const l2 = luminance(hexToRgb(bg));
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

test("Microsoft Learn URL canonicalization and citation deduplication collapse fragments, locales, trailing slashes, and duplicate titles", async () => {
  assert.equal(
    canonicalLearnUrl("https://learn.microsoft.com/en-us/microsoft-365-copilot/extensibility/overview-custom-engine-agent/#architecture"),
    "https://learn.microsoft.com/microsoft-365-copilot/extensibility/overview-custom-engine-agent",
  );
  assert.equal(
    canonicalLearnUrl("https://learn.microsoft.com/en-us/copilot/microsoft-365/agent-essentials/m365-agents-checklist?tabs=maker&WT.mc_id=123#step-2"),
    "https://learn.microsoft.com/copilot/microsoft-365/agent-essentials/m365-agents-checklist",
  );

  const deduped = dedupeLearnSources([
    {
      title: "Skills overview for agents (Microsoft Copilot)",
      url: "https://learn.microsoft.com/en-us/microsoft-copilot-studio/skills-overview#when-to-use-skills",
    },
    {
      title: "Skills overview for agents (Microsoft Copilot)",
      url: "https://learn.microsoft.com/microsoft-copilot-studio/skills-overview/#prerequisites",
    },
    {
      title: "https://learn.microsoft.com/en-us/microsoft-copilot-studio/skills-overview",
      url: "https://learn.microsoft.com/en-us/microsoft-copilot-studio/skills-overview",
    },
    {
      title: "Create a skill for an agent (Customer Conversation) (preview)",
      url: "https://learn.microsoft.com/en-us/microsoft-copilot-studio/create-skill#configure-inputs",
    },
    {
      title: "Create a skill for an agent (Customer Conversation) (preview) | Microsoft Learn",
      url: "https://learn.microsoft.com/en-us/microsoft-copilot-studio/create-skill-preview",
    },
  ]);

  assert.equal(deduped.length, 2);
  assert.equal(deduped[0].title, "Skills overview for agents (Microsoft Copilot)");
  assert.equal(deduped[0].url, "https://learn.microsoft.com/microsoft-copilot-studio/skills-overview");
  assert.equal(deduped[1].title, "Create a skill for an agent (Customer Conversation) (preview)");

  // groundFeature merges chunked search results + curated docUrls without repeating titles
  const mockSession = {
    ok: true,
    endpoint: "mock://learn-dedupe-test",
    call: async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify([
            {
              title: "Add a SharePoint source to Copilot Studio",
              contentUrl: "https://learn.microsoft.com/en-us/microsoft-copilot-studio/nlu-boost-node#sharepoint",
              content: "Add SharePoint sites or document libraries as knowledge sources in Microsoft Copilot Studio.",
            },
            {
              title: "Add a SharePoint source to Copilot Studio",
              contentUrl: "https://learn.microsoft.com/en-us/microsoft-copilot-studio/nlu-boost-node#permissions",
              content: "SharePoint permissions govern every grounded citation returned to signed-in users.",
            },
          ]),
        },
      ],
    }),
  };
  const grounded = await groundFeature(mockSession, {
    id: "knowledge-sharepoint",
    name: "Ground on SharePoint sites and document libraries",
    product: "copilot-studio",
    searchQueries: ["Copilot Studio SharePoint knowledge"],
    docUrls: ["https://learn.microsoft.com/en-us/microsoft-copilot-studio/nlu-boost-node/"],
  });
  const matching = grounded.sources.filter((s) => s.url.includes("nlu-boost-node"));
  assert.equal(matching.length, 1, "expected chunked section anchors and curated URL to collapse into 1 citation");
  assert.equal(matching[0].title, "Add a SharePoint source to Copilot Studio");
  assert.doesNotMatch(matching[0].url, /#/);

  // renderDifferenceBlock renders bulleted deduplicated sources instead of one cramped semicolon-joined line
  const diffLines = renderDifferenceBlock({
    record: {
      confidence: "documented",
      lastVerified: "2026-04-01",
      harnesses: {
        standard: { term: "SharePoint knowledge", summary: "Add site URL.", availability: "supported" },
        "microsoft-copilot": { term: "Agent Builder knowledge", summary: "Paste site URL.", availability: "supported" },
      },
      sources: [
        {
          title: "SharePoint knowledge in Agent Builder",
          url: "https://learn.microsoft.com/en-us/microsoft-365-copilot/extensibility/agent-builder-knowledge#sites",
        },
        {
          title: "SharePoint knowledge in Agent Builder",
          url: "https://learn.microsoft.com/microsoft-365-copilot/extensibility/agent-builder-knowledge/",
        },
      ],
    },
    concept: { summary: "Ground agent answers on SharePoint content." },
    labHarness: "standard",
    otherHarness: "microsoft-copilot",
    harnesses: [
      { id: "standard", name: "Standard" },
      { id: "microsoft-copilot", name: "Microsoft 365 Copilot" },
    ],
    clean: (t) => String(t),
  });
  const diffMd = diffLines.join("\n");
  assert.match(diffMd, /\*\*Sources \(checked 2026-04-01\)\.\*\*\n\n- \[/);
  assert.equal((diffMd.match(/agent-builder-knowledge/g) || []).length, 1);

  // furtherLearningBlock deduplicates across grounding + feature docUrls
  const furtherLines = furtherLearningBlock(
    {
      features: [
        {
          id: "f1",
          name: "Knowledge sources",
          docUrls: ["https://learn.microsoft.com/en-us/microsoft-copilot-studio/nlu-boost-node/"],
        },
        {
          id: "f2",
          name: "SharePoint grounding",
          docUrls: ["https://learn.microsoft.com/microsoft-copilot-studio/nlu-boost-node#sharepoint"],
        },
      ],
    },
    new Map([
      [
        "f1",
        {
          sources: [
            {
              title: "Add a SharePoint source to Copilot Studio",
              url: "https://learn.microsoft.com/en-us/microsoft-copilot-studio/nlu-boost-node#overview",
            },
          ],
        },
      ],
    ]),
  );
  const furtherMd = furtherLines.join("\n");
  assert.equal((furtherMd.match(/nlu-boost-node/g) || []).length, 1);
});

test("Check your work and Validation task lists render interactive enabled checkboxes across Portal and standalone HTML while sanitizing unsafe inputs", () => {
  const plan = planLab({
    industry: "financial-services",
    roles: ["business-analyst"],
    harness: "standard",
    level: 200,
    features: ["create-agent", "adaptive-cards"],
    includeKnowledgeCheck: false,
  });
  const md = composeLab(plan, new Map(), new Map(), { byFeature: new Map() });

  const portalHtml = renderLabMarkdown(md);
  assert.match(portalHtml, /class="contains-task-list"/);
  assert.match(portalHtml, /<label class="task-list-label">/);
  assert.match(portalHtml, /class="task-list-item-checkbox"[^>]*data-task-key="task-\d+-[a-z0-9]+"/);
  assert.doesNotMatch(portalHtml, /task-list-item-checkbox[^>]*disabled/i);

  const fallbackHtml = renderLabMarkdownFallback("- [ ] Verify grounded citations\n- [x] Publish agent");
  assert.match(fallbackHtml, /<label class="task-list-label">/);
  assert.doesNotMatch(fallbackHtml, /disabled/i);

  const standalone = renderStandaloneLabHtml(md, { title: plan.title, labId: "interactive-check-lab" });
  assert.doesNotMatch(standalone, /task-list-item-checkbox[^>]*disabled/i);
  assert.match(standalone, /const taskStorageKey = "csl-lab-tasks:" \+ scope;/);
  assert.match(standalone, /window\.localStorage\.getItem\(key\)/);
  assert.match(standalone, /window\.localStorage\.setItem\(key, JSON\.stringify\(value\)\)/);

  // Strict sanitizer keeps checkbox/radio inputs and quiz buttons but strips text/password/hidden inputs and submit buttons
  const dirty = sanitizeLabHtml(`
    <ul class="contains-task-list">
      <li class="task-list-item"><label class="task-list-label"><input type="checkbox" class="task-list-item-checkbox" disabled data-task-key="task-1"><span class="task-list-item-text">Safe item</span></label></li>
    </ul>
    <input type="text" value="phish">
    <input type="password" name="pw">
    <input type="hidden" value="secret">
    <button type="submit" onclick="alert(1)">Submit</button>
    <button type="button" class="lab-quiz-btn" data-quiz-action="check-question">Check answer</button>
  `);
  assert.match(dirty, /type="checkbox"/);
  assert.doesNotMatch(dirty, /disabled/i);
  assert.doesNotMatch(dirty, /type="text"|type="password"|type="hidden"|type="submit"|onclick/i);
  assert.match(dirty, /class="lab-quiz-btn"/);
});

test("generated lab typography CSS restores paragraph, list, heading, checklist, and mini-quiz spacing and meets WCAG AA contrast", () => {
  const indexHtml = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(indexHtml, /\.preview-frame p\s*\{[^}]*margin:\s*0 0 14px/);
  assert.match(indexHtml, /\.preview-frame ul,\s*\.preview-frame ol\s*\{[^}]*padding-left:\s*26px/);
  assert.match(indexHtml, /\.preview-frame li\s*\{[^}]*margin:\s*0 0 8px/);
  assert.match(indexHtml, /\.preview-frame h3\s*\{[^}]*border-top:\s*1px solid var\(--border\)/);
  assert.match(indexHtml, /\.preview-frame \.lab-module-meta\s*\{/);
  assert.match(indexHtml, /\.preview-frame \.lab-subhead\s*\{/);
  assert.match(indexHtml, /\.preview-frame \.lab-scenario-callout\s*\{/);
  assert.match(indexHtml, /\.preview-frame \.lab-quiz-explanation\[hidden\]\s*\{\s*display:\s*block !important;\s*\}/);

  const standalone = renderStandaloneLabHtml({
    title: "Layout Contrast Check",
    markdown: "# Title\n\n## Step-by-Step\n\n### Step 1 - Build\n*Level 100 · about 15 minutes*\n\n**Do this**\n\n1. Open Studio.\n\n- [ ] Verify.\n",
  });
  assert.match(standalone, /\.lab-article p\s*\{\s*margin:\s*0 0 14px/);
  assert.match(standalone, /\.lab-article ul,\s*\.lab-article ol\s*\{\s*padding-left:\s*26px;\s*margin:\s*8px 0 16px;/);
  assert.match(standalone, /\.lab-article \.lab-quiz-explanation\[hidden\]\s*\{\s*display:\s*block !important;\s*\}/);

  // Verify standalone light and dark custom property palettes meet WCAG AA (>= 4.5:1 text, >= 3.0:1 borders)
  assert.ok(contrastRatio("#162447", "#edf3fe") >= 4.5, "light callout text contrast >= 4.5:1");
  assert.ok(contrastRatio("#1d5bd6", "#ffffff") >= 3.0, "light callout border contrast >= 3.0:1");
  assert.ok(contrastRatio("#78350f", "#fef3c7") >= 4.5, "light warning text contrast >= 4.5:1");
  assert.ok(contrastRatio("#0b6e4f", "#e6f6f0") >= 4.5, "light success text contrast >= 4.5:1");
  assert.ok(contrastRatio("#0d7a58", "#ffffff") >= 3.0, "light success border contrast >= 3.0:1");

  assert.ok(contrastRatio("#dce6fa", "#182238") >= 4.5, "dark callout text contrast >= 4.5:1");
  assert.ok(contrastRatio("#5b9bff", "#181c26") >= 3.0, "dark callout border contrast >= 3.0:1");
  assert.ok(contrastRatio("#fde68a", "#332611") >= 4.5, "dark warning text contrast >= 4.5:1");
  assert.ok(contrastRatio("#6ee7b7", "#102a22") >= 4.5, "dark success text contrast >= 4.5:1");
  assert.ok(contrastRatio("#3dd6a3", "#181c26") >= 3.0, "dark success border contrast >= 3.0:1");
});

test("wizard Step 7 exposes Knowledge Check opt-in above Advanced options, defaults to false, and round-trips through manifests", () => {
  const indexHtml = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const pane7Start = indexHtml.indexOf('id="lb-pane-7"');
  const quizToggleIdx = indexHtml.indexOf('id="lb-include-knowledge-check"', pane7Start);
  const advancedIdx = indexHtml.indexOf('<details class="lb-advanced">', pane7Start);
  assert.ok(pane7Start > 0 && quizToggleIdx > pane7Start, "Step 7 must contain #lb-include-knowledge-check");
  assert.ok(quizToggleIdx < advancedIdx, "#lb-include-knowledge-check must appear above <details class=\"lb-advanced\">");
  assert.doesNotMatch(
    indexHtml.slice(quizToggleIdx - 40, quizToggleIdx + 220),
    /\bchecked\b/i,
    "#lb-include-knowledge-check must default to unchecked in HTML",
  );

  // Load lab-builder-wizard.js in a minimal VM harness to verify fresh-start default, toggle, summary, and restore
  const wizardJs = readFileSync(new URL("../public/lab-builder-wizard.js", import.meta.url), "utf8");
  const elements = new Map();
  const getEl = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        value: "",
        checked: false,
        hidden: false,
        disabled: false,
        innerHTML: "",
        textContent: "",
        dataset: {},
        style: {},
        classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
        setAttribute() {},
        removeAttribute() {},
        querySelector: () => null,
        querySelectorAll: () => [],
        focus() {},
      });
    }
    return elements.get(id);
  };
  const ctx = vm.createContext({
    document: {
      getElementById: getEl,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
    },
    window: { addEventListener() {}, scrollTo() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    esc: (s) => String(s ?? ""),
    apiUrl: (u) => u,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    console,
  });
  vm.runInContext(wizardJs, ctx);

  assert.equal(vm.runInContext("lbRequest().includeKnowledgeCheck", ctx), false);
  vm.runInContext("lbSetIncludeKnowledgeCheck(true)", ctx);
  assert.equal(vm.runInContext("lbRequest().includeKnowledgeCheck", ctx), true);
  vm.runInContext("lbResetAnswers()", ctx);
  assert.equal(vm.runInContext("lbRequest().includeKnowledgeCheck", ctx), false);

  const restoredTrue = selectionsFromManifest({
    request: { features: ["create-agent"], level: 100, harness: "standard", includeKnowledgeCheck: true },
  });
  assert.equal(restoredTrue.includeKnowledgeCheck, true);

  const restoredFalse = selectionsFromManifest({
    request: { features: ["create-agent"], level: 100, harness: "standard", includeKnowledgeCheck: false },
  });
  assert.equal(restoredFalse.includeKnowledgeCheck, false);
});

test("per-lesson multiple-choice mini-quizzes honor includeKnowledgeCheck, link every answer and point of interest to Microsoft Learn, and export cleanly to HTML, DOCX, and PDF", async () => {
  const root = mkdtempSync(join(tmpdir(), "quiz-export-"));
  try {
    // 1. Disabled (includeKnowledgeCheck: false) omits quizzes and passes QA with zero penalty
    const disabledLab = await generateLab(
      {
        industry: "healthcare",
        roles: ["it-admin"],
        harness: "standard",
        level: 200,
        features: ["create-agent", "adaptive-cards"],
        includeKnowledgeCheck: false,
      },
      { outputRoot: root, useLearnMcp: false, useLlm: false },
    );
    assert.equal(disabledLab.status, "complete");
    assert.equal(disabledLab.validation.failed, 0);
    const disabledMd = readFileSync(join(disabledLab.outputDir, "index.md"), "utf8");
    assert.doesNotMatch(disabledMd, /Knowledge check: Lesson mini-quiz/);
    const disabledQa = assessLab(disabledMd, {
      expectedTopics: [{ id: "adaptive-cards", name: "Collect structured input with Adaptive Cards" }],
      includeKnowledgeCheck: false,
    });
    assert.equal(
      disabledQa.findings.some((f) => f.check === "module-knowledge-check"),
      false,
      "disabled includeKnowledgeCheck must not penalize missing knowledge checks",
    );

    // 2. Enabled (includeKnowledgeCheck: true) generates 3 A-D multiple-choice questions per Step lesson (not Recap!)
    const enabledLab = await generateLab(
      {
        industry: "healthcare",
        roles: ["it-admin"],
        harness: "standard",
        level: 200,
        features: ["create-agent", "adaptive-cards"],
        includeKnowledgeCheck: true,
      },
      { outputRoot: root, useLearnMcp: false, useLlm: false },
    );
    assert.equal(enabledLab.status, "complete");
    assert.equal(enabledLab.validation.failed, 0);
    assert.deepEqual(
      enabledLab.qa.findings.filter((f) => f.severity === "error"),
      [],
    );

    const enabledMd = readFileSync(join(enabledLab.outputDir, "index.md"), "utf8");
    // Recaps 1-2 (Level 100) get no quiz; Steps 1-2 (Entities & variables + Adaptive Cards) each get 1 mini-quiz of 3 A-D questions
    assert.equal((enabledMd.match(/\*\*Knowledge check: Lesson mini-quiz\*\*/g) || []).length, 2);
    assert.equal((enabledMd.match(/\*\*Question [123]\.\*\*/g) || []).length, 6);
    assert.equal((enabledMd.match(/^- \*\*[ABCD]\.\*\*/gm) || []).length, 24);
    assert.doesNotMatch(enabledMd, /^#{4,6}\s/m, "mini-quiz must never emit h4-h6 headings inside modules");

    // Every answer explanation AND troubleshooting point of interest carries a Microsoft Learn link
    const answerMatches = [
      ...enabledMd.matchAll(/<summary>Knowledge check: Question \d+ answer and Microsoft Learn reference<\/summary>([\s\S]*?)<\/details>/g),
    ];
    assert.equal(answerMatches.length, 6);
    for (const [, body] of answerMatches) {
      assert.match(body, /\*\*Correct answer:\s*[ABCD]\.\*\*/);
      assert.match(body, /\*\*Microsoft Learn reference:\*\*\s*\[[^\]]+\]\(https:\/\/learn\.microsoft\.com\/[^)]+\)/);
    }
    assert.match(enabledMd, /\*\*Troubleshooting\*\*[\s\S]*?\[[^\]]+\]\(https:\/\/learn\.microsoft\.com\/[^)]+\)/);

    // Keyword-matched Learn source selection picks the closest Learn URL
    const picked = selectRelevantLearnSource(
      [
        { title: "Create and delete agents", url: "https://learn.microsoft.com/microsoft-copilot-studio/fundamentals-get-started" },
        { title: "SharePoint security and permissions in Copilot Studio", url: "https://learn.microsoft.com/microsoft-copilot-studio/nlu-boost-node" },
      ],
      "SharePoint permissions and document library security trimming",
    );
    assert.equal(picked.url, "https://learn.microsoft.com/microsoft-copilot-studio/nlu-boost-node");

    // 3. Portal preview & Standalone HTML render interactive radio cards, Check answer, Check quiz, Reset quiz, and Learn links
    const portalHtml = renderLabMarkdown(enabledMd);
    assert.match(portalHtml, /<section class="lab-quiz"/);
    assert.equal((portalHtml.match(/class="lab-quiz-radio"/g) || []).length, 24);
    assert.match(portalHtml, /data-quiz-check-one="0"/);
    assert.match(portalHtml, /data-quiz-check-all="true"/);
    assert.match(portalHtml, /data-quiz-reset="true"/);
    assert.match(portalHtml, /class="lab-quiz-learn-ref"[\s\S]*?href="https:\/\/learn\.microsoft\.com\//);

    const standaloneHtml = renderStandaloneLabHtml(enabledMd, {
      title: enabledLab.manifest.title,
      labId: enabledLab.slug,
      renderMarkdown: renderLabMarkdown,
    });
    assert.match(standaloneHtml, /<section class="lab-quiz"/);
    assert.match(standaloneHtml, /const quizStorageKey = "csl-lab-quizzes:" \+ scope;/);

    // 4. Word .docx export renders human-readable questions, options, answers, and OOXML hyperlinks (no raw JSON!)
    const docxBuf = renderMarkdownToDocxBuffer(enabledMd, { title: enabledLab.manifest.title });
    const docxEntries = unzipEntries(docxBuf);
    const docXml = docxEntries.get("word/document.xml").toString("utf8");
    const relsXml = docxEntries.get("word/_rels/document.xml.rels").toString("utf8");
    assert.match(docXml, /Knowledge check: Lesson mini-quiz/);
    assert.match(docXml, /Question 1\./);
    assert.match(docXml, /Correct answer:/);
    assert.match(docXml, /<w:hyperlink r:id="rIdLink\d+"/);
    assert.match(relsXml, /Target="https:\/\/learn\.microsoft\.com\//);
    assert.doesNotMatch(docXml, /"correctOption"/);

    // 5. Adobe .pdf export renders human-readable questions, options, answers, and clickable /URI link annotations
    const pdfBuf = renderMarkdownToPdfBuffer(enabledMd, { title: enabledLab.manifest.title });
    const pdfLatin1 = pdfBuf.toString("latin1");
    assert.match(pdfLatin1, /^%PDF-1\.4/);
    assert.match(pdfLatin1, /\/Subtype \/Link/);
    assert.match(pdfLatin1, /\/S \/URI \/URI \(https:\/\/learn\.microsoft\.com\//);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("troubleshooting adds the cautions Microsoft Learn printed on the page, once, and still ends with the universal tips", () => {
  const u = { esc: (s) => s, scrub: (s) => s, bullets: (items) => items.map((i) => `- ${i}`).join("\n"), lowerFirst: (s) => s };
  const feature = { ...getFeature("mc-monitor"), troubleshooting: [], concepts: [] };
  const plain = troubleshootingBlock(feature, u, null).join("\n");
  assert.doesNotMatch(plain, /Microsoft Learn warns/);
  const text = troubleshootingBlock(feature, u, null, ["Sessions appear only after real users chat with a published agent.", "Second caution from the page here.", "A third caution that is left out."]).join("\n");
  assert.equal((text.match(/\*\*Microsoft Learn warns\.\*\*/g) || []).length, 2, "at most two");
  assert.match(text, /Sessions appear only after real users chat/);
  assert.ok(text.indexOf("Microsoft Learn warns") < text.indexOf("A step does not match your screen"), "specific cautions come before the universal tips");
  const repeated = troubleshootingBlock({ ...feature, concepts: ["Sessions appear only after real users chat with a published agent and must be published first."] }, u, null, ["Sessions appear only after real users chat with a published agent."]).join("\n");
  assert.equal((repeated.match(/Sessions appear only after real users chat/g) || []).length, 1, "a caution already in the concepts is not repeated");
});

test("quiz wrong answers are real statements about the lab's other modules, never filler, and never an unreviewed disclaimer", () => {
  const ids = ["mc-create-agent", "mc-instructions", "mc-knowledge", "mc-preview-test", "mc-publish-agent"];
  const features = ids.map((id, index) => ({ ...getFeature(id), stepOrder: index + 1 }));
  const u = { esc: (s) => s, scrub: (s) => s, bullets: (items) => items.map((i) => `- ${i}`).join("\n"), lowerFirst: (s) => s };
  const plan = { profile: { agentName: "Helper" }, includeKnowledgeCheck: true, features };
  const quiz = (feature, p = plan) => knowledgeCheckBlock(feature, p, u, null).join("\n");

  const text = quiz(features[1]);
  const groups = text.split(/\*\*Question \d+\.\*\*/).slice(1);
  assert.equal(groups.length, 3, "all three questions are still asked");
  for (const group of groups) {
    const options = [...group.matchAll(/^- \*\*([A-D])\.\*\* (.+)$/gm)].map((m) => m[2]);
    assert.equal(options.length, 4);
    assert.equal(new Set(options).size, 4, "no two answers are the same");
    assert.ok(!options.some((option) => FILLER_DISTRACTORS.some((pattern) => pattern.test(option))), "no filler answer");
    assert.match(group, /The other answers describe \*\*/, "the explanation says where the wrong answers came from");
    assert.ok(!group.includes(features[1].name + "**, not this module"), "a module is never listed as its own wrong answer");
  }

  const solo = quiz(features[0], { ...plan, features: [features[0]] });
  assert.match(solo, /bypasses environment permissions/, "a lab with no other module falls back to the plain wrong answers");
  assert.doesNotMatch(solo, /The other answers describe/);

  const unreviewed = features.map((f) => (f.id === "mc-knowledge" ? { ...f, whyItMatters: "Microsoft Learn describes this topic as a preview.", summary: "Microsoft Learn describes this topic as a preview." } : f));
  assert.doesNotMatch(quiz(unreviewed[1], { ...plan, features: unreviewed }), /Microsoft Learn describes this topic as/);
});
