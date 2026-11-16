import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inflateRawSync, inflateSync } from "node:zlib";

import { planLab } from "../lib/lab-builder/planner.js";
import { getFeatures } from "../lib/lab-builder/catalog.js";
import { composeLab } from "../lib/lab-builder/composer.js";
import {
  ARCHITECTURE_FENCE_LANG,
  buildArchitectureModel,
  serializeArchitectureBlock,
  parseArchitectureBlock,
  renderArchitectureOverviewHtml,
  buildArchitectureDocumentRows,
} from "../lib/lab-builder/architecture-overview.js";
import { renderLabMarkdown, sanitizeLabHtml } from "../lib/markdown.js";
import { renderStandaloneLabHtml } from "../lib/lab-builder/html-lab.js";
import { renderMarkdownToDocxBuffer } from "../lib/lab-builder/docx-builder.js";
import { renderMarkdownToPdfBuffer } from "../lib/lab-builder/pdf-builder.js";
import { splitGeneratedLabModules } from "../lib/lab-builder/module-samples.js";

process.env.LAB_BUILDER_LINK_CHECK = "off";
process.env.LAB_BUILDER_VENDOR_DOCS = "off";

function flattenCards(model) {
  return [
    ...model.lanes.flatMap((lane) => lane.cards.map((c) => ({ ...c, laneId: lane.id }))),
    ...(model.foundation?.guardrails || []).map((g) => ({
      id: g.id,
      title: g.title,
      role: g.detail,
      badges: g.badges || [],
      laneId: "foundation",
    })),
  ];
}

function parseZipEntries(buffer) {
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  assert.notEqual(eocdOffset, -1, "Expected valid ZIP EOCD signature");
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  let offset = buffer.readUInt32LE(eocdOffset + 16);
  const entries = new Map();

  for (let i = 0; i < totalEntries; i += 1) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50);
    const method = buffer.readUInt16LE(offset + 10);
    const compSize = buffer.readUInt32LE(offset + 20);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLen).toString("utf8");
    const localNameLen = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const raw = buffer.subarray(dataStart, dataStart + compSize);
    const content = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    entries.set(name, content);
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function extractPdfTextStreams(pdfBuffer) {
  const rawLatin1 = pdfBuffer.toString("latin1");
  const words = [];
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  for (const match of rawLatin1.matchAll(streamRe)) {
    const bytes = Buffer.from(match[1], "latin1");
    let decoded = match[1];
    try {
      decoded = inflateSync(bytes).toString("latin1");
    } catch {
      // Uncompressed PDF stream
    }
    for (const tj of decoded.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)) {
      words.push(
        tj[1]
          .replace(/\\\(/g, "(")
          .replace(/\\\)/g, ")")
          .replace(/\\\\/g, "\\"),
      );
    }
  }
  return words.join("");
}

function hexToRgb(hex) {
  const raw = String(hex).trim().replace(/^#/, "");
  const full = raw.length === 3 ? raw.split("").map((c) => c + c).join("") : raw.slice(0, 6);
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}

function luminance(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(fgHex, bgHex) {
  const l1 = luminance(hexToRgb(fgHex));
  const l2 = luminance(hexToRgb(bgHex));
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function parseCssCustomProperties(cssBlock) {
  const vars = {};
  for (const match of cssBlock.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    vars[match[1]] = match[2].trim();
  }
  return vars;
}

test("dynamic architecture model updates cards, flow labels, and Step/Recap badges when modules change and never invents 3rd-party connectors", () => {
  const minimalPlan = planLab({
    products: ["copilot-studio"],
    harness: "standard",
    industry: "healthcare",
    roles: ["maker"],
    features: ["create-agent", "knowledge-sharepoint"],
    includeCore: false,
  });
  const minimalModel = buildArchitectureModel(minimalPlan);
  const minimalTitles = flattenCards(minimalModel).map((c) => c.title).join(" | ");

  assert.match(minimalTitles, /SharePoint Document & Site Grounding/);
  assert.doesNotMatch(minimalTitles, /Model Context Protocol|SAP|Salesforce|ServiceNow|Jira|Snowflake|Epic|Shopify/i);
  assert.equal(minimalModel.lanes[1].flowOut, "Permission-Trimmed Grounding");

  const richPlan = planLab({
    products: ["copilot-studio"],
    harness: "standard",
    levels: [200, 300],
    industry: "manufacturing",
    roles: ["developer", "architect"],
    features: [
      "knowledge-tuning",
      "mcp-servers",
      "sap-integration",
      "evaluations",
      "entra-agent-identities",
    ],
    includeCore: false,
  });
  const richModel = buildArchitectureModel(richPlan);
  const richCards = flattenCards(richModel);
  const richTitles = richCards.map((c) => c.title).join(" | ");

  assert.equal(richModel.harness?.label, "Standard harness");
  assert.match(richTitles, /Model Context Protocol \(MCP\) Servers/);
  assert.match(richTitles, /SAP ERP & OData Integration/);
  assert.match(richTitles, /Automated Agent Evaluations/);
  assert.match(richTitles, /Microsoft Entra Agent Identities/);
  // Still never invents unselected third-party systems
  assert.doesNotMatch(richTitles, /Salesforce|ServiceNow|Jira|Snowflake|Epic|Shopify/i);
  assert.equal(richModel.lanes[1].flowOut, "Citations & MCP Tool Calls");

  // Lower-level prerequisites appear as Recap chips while main modules carry Step chips
  const allBadges = richCards.flatMap((c) => c.badges);
  assert.ok(allBadges.some((b) => /^Recap \d+$/.test(b)), `expected Recap badge in ${JSON.stringify(allBadges)}`);
  assert.ok(allBadges.some((b) => /^Step \d+$/.test(b)), `expected Step badge in ${JSON.stringify(allBadges)}`);

  // Microsoft Copilot harness visibly surfaces its own harness pill and MCP tool server card
  const mcPlan = planLab({
    products: ["copilot-studio"],
    harness: "microsoft-copilot",
    level: 200,
    industry: "technology",
    roles: ["developer"],
    features: ["mc-tools-mcp", "mc-evaluate"],
    includeCore: false,
  });
  const mcModel = buildArchitectureModel(mcPlan);
  assert.equal(mcModel.harness?.label, "Microsoft Copilot harness");
  assert.match(
    flattenCards(mcModel).map((c) => c.title).join(" | "),
    /MCP Tool Servers \(Microsoft Copilot Harness\)/,
  );
});

test("multi-product and harness variations visibly tailor architecture pills, lanes, and outcomes", () => {
  const multiPlan = planLab({
    products: ["copilot-studio", "ai-foundry"],
    harness: "customer-conversation",
    levels: [200, 300],
    industry: "financial-services",
    roles: ["maker", "developer"],
    features: ["cc-voice-settings", "cc-connected-agent", "fdy-agent-ai-search", "fdy-evaluate-agent"],
    includeCore: false,
    agentName: "Wealth Concierge Voice Agent",
  });
  const model = buildArchitectureModel(multiPlan);

  assert.equal(model.deliverableName, "Wealth Concierge Voice Agent");
  assert.deepEqual(
    model.products.map((p) => p.id),
    ["copilot-studio", "ai-foundry"],
  );
  assert.match(model.kindLabel, /Multi-Product Architecture/);
  assert.equal(model.harness?.label, "Customer Conversation harness (preview)");
  assert.equal(model.lanes[0].flowOut, "Voice & Chat Streams");

  const titles = flattenCards(model).map((c) => c.title).join(" | ");
  assert.match(titles, /Customer Voice & Speech Persona/);
  assert.match(titles, /Microsoft Foundry Connected Agent/);
  assert.match(titles, /Azure AI Search Hybrid & Semantic Index/);
  assert.match(titles, /Foundry Quality & Safety Evaluations/);
  assert.ok(model.foundation.outcome.kpi.length > 10);
});

test("every catalog feature across all 6 products maps into the architecture model and unknown discovered topics classify cleanly", () => {
  const allFeatures = getFeatures();
  assert.ok(allFeatures.length >= 190);

  for (const feature of allFeatures) {
    const model = buildArchitectureModel({
      products: [feature.product || "copilot-studio"],
      level: feature.level || 200,
      features: [{ ...feature, stepLabel: "Step 1", prerequisite: false }],
    });
    const badges = flattenCards(model).flatMap((c) => c.badges);
    assert.ok(
      badges.includes("Step 1"),
      `feature ${feature.id} (${feature.product || "copilot-studio"}) must attach its Step 1 badge`,
    );
  }

  // Simulated discovered topic not in static map
  const discoveredModel = buildArchitectureModel({
    products: ["copilot-studio"],
    features: [
      {
        id: "discovered-custom-mcp-gateway",
        name: "Custom MCP Gateway Routing",
        category: "tools",
        summary: "Routes tool invocations through a governed gateway.",
        stepLabel: "Step 1",
      },
    ],
  });
  const discoveredCard = flattenCards(discoveredModel).find((c) => c.title === "Custom MCP Gateway Routing");
  assert.ok(discoveredCard, "fallback classifier must render discovered module card");
  assert.deepEqual(discoveredCard.badges, ["Step 1"]);
});

test("portal renderLabMarkdown, standalone HTML, DOCX, and PDF all render lab-architecture cleanly without raw JSON leaks or skipped headings", async () => {
  const plan = planLab({
    products: ["copilot-studio"],
    harness: "standard",
    level: 200,
    industry: "retail",
    roles: ["maker"],
    features: ["create-agent", "knowledge-sharepoint", "mcp-servers", "evaluations"],
    includeCore: false,
    agentName: "Store Operations Copilot",
  });
  const markdown = composeLab(plan, new Map(), new Map(), {}, { groundedFeatures: 0, llmProvider: "none" });
  assert.match(markdown, new RegExp("```" + ARCHITECTURE_FENCE_LANG + "\\n"));

  // 1. Portal preview (renderLabMarkdown + sanitizeLabHtml)
  const portalHtml = renderLabMarkdown(markdown);
  assert.match(portalHtml, /<figure class="lab-arch" role="region" aria-label="Solution architecture overview: Store Operations Copilot">/);
  assert.match(portalHtml, /viewBox="0 0 24 24"/);
  assert.match(portalHtml, /class="lab-arch-chip lab-arch-chip-step"/);
  assert.doesNotMatch(portalHtml, /lab-architecture|"deliverableName"\s*:/);
  assert.doesNotMatch(portalHtml, /<h[4-6]\b/i, "architecture diagram must not emit h4-h6 tags");

  // Untrusted raw <svg> outside .lab-arch remains blocked by sanitizeLabHtml
  const malicious = sanitizeLabHtml('<svg onload="alert(1)"><a href="javascript:alert(2)">bad</a></svg>');
  assert.doesNotMatch(malicious, /<svg|javascript:|onload/i);

  // Static ```mermaid blocks remain supported alongside lab-architecture
  const staticMermaidHtml = renderLabMarkdown("```mermaid\nflowchart LR\n  A --> B\n```");
  assert.match(staticMermaidHtml, /<div class="mermaid">flowchart LR/);

  // 2. Standalone multi-page HTML export (html-lab.js)
  const standaloneHtml = renderStandaloneLabHtml(markdown, { title: plan.title });
  assert.match(standaloneHtml, /<figure class="lab-arch"/);
  assert.match(standaloneHtml, /Store Operations Copilot/);
  assert.match(standaloneHtml, /Model Context Protocol \(MCP\) Servers/);
  assert.doesNotMatch(standaloneHtml, /"deliverableName"\s*:/);
  assert.match(standaloneHtml, /@media print[\s\S]*?\.lab-arch[\s\S]*?page-break-inside:\s*avoid/);

  // 3. Overview module split + Word (.docx) export
  const split = splitGeneratedLabModules(markdown, plan);
  assert.match(split.overview.markdown, new RegExp("```" + ARCHITECTURE_FENCE_LANG));

  const docxBuf = renderMarkdownToDocxBuffer(split.overview.markdown, { title: plan.title });
  const zipEntries = parseZipEntries(docxBuf);
  const docXml = zipEntries.get("word/document.xml")?.toString("utf8") || "";
  assert.match(docXml, /<w:tbl>/);
  assert.match(docXml, /Architecture Layer/);
  assert.match(docXml, /Store Operations Copilot/);
  assert.match(docXml, /Model Context Protocol \(MCP\) Servers/);
  assert.match(docXml, /Target Business Outcome/);
  assert.doesNotMatch(docXml, /\[lab-architecture\]|"deliverableName"/);

  // 4. Adobe PDF (.pdf) export
  const pdfBuf = renderMarkdownToPdfBuffer(split.overview.markdown, { title: plan.title });
  assert.equal(pdfBuf.subarray(0, 8).toString("ascii"), "%PDF-1.4");
  const pdfText = extractPdfTextStreams(pdfBuf);
  assert.match(pdfText, /Architecture Layer/);
  assert.match(pdfText, /Store Operations Copilot/);
  assert.match(pdfText, /Target Business Outcome/);
  assert.doesNotMatch(pdfText, /"deliverableName"/);

  // Round-trip serialization/parsing and document row helper
  const model = buildArchitectureModel(plan);
  const parsed = parseArchitectureBlock(serializeArchitectureBlock(model));
  assert.equal(parsed?.deliverableName, "Store Operations Copilot");
  const docRows = buildArchitectureDocumentRows(parsed);
  assert.ok(docRows.rows.length >= 4);
  assert.match(renderArchitectureOverviewHtml("not-json"), /class="lab-arch-fallback"/);
});

test("architecture overview dark and light theme tokens meet WCAG AA contrast in both portal and standalone HTML", () => {
  const indexHtml = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const styleContent = indexHtml.match(/<style>([\s\S]*?)<\/style>/)?.[1] || "";
  const screenCss = styleContent.split("@media print")[0];
  const printCss = styleContent.split("@media print")[1] || "";

  // Screen CSS for .lab-arch must use theme variables, not hardcoded light colors
  const archRule = screenCss.match(/\.lab-arch\s*\{([^}]*)\}/)?.[1] || "";
  assert.ok(archRule, ".lab-arch CSS rule must exist in index.html");
  assert.match(archRule, /var\(--arch-bg\)/);
  assert.doesNotMatch(archRule, /#(?:ffffff|fff|f6f8fc|0f172a)\b/i);
  assert.match(printCss, /\.preview-frame\s+\.lab-arch[\s\S]*?page-break-inside:\s*avoid/);

  const portalDark = parseCssCustomProperties(styleContent.match(/:root\s*\{([^}]*)\}/)?.[1] || "");
  const portalLight = parseCssCustomProperties(
    styleContent.match(/:root\[data-theme="light"\],\s*body\[data-theme="light"\]\s*\{([^}]*)\}/)?.[1] || "",
  );

  const standaloneSample = renderStandaloneLabHtml("# Contrast\n\n## Overview\n\nBody", { title: "Contrast Check" });
  const standaloneStyle = standaloneSample.match(/<style>([\s\S]*?)<\/style>/)?.[1] || "";
  const standaloneLight = parseCssCustomProperties(standaloneStyle.match(/:root\s*\{([^}]*)\}/)?.[1] || "");
  const standaloneDark = parseCssCustomProperties(
    standaloneStyle.match(/:root\[data-theme="dark"\]\s*\{([^}]*)\}/)?.[1] || "",
  );

  for (const [label, t] of [
    ["portal-dark", portalDark],
    ["portal-light", portalLight],
    ["standalone-light", standaloneLight],
    ["standalone-dark", standaloneDark],
  ]) {
    const textPairs = [
      ["--arch-text", "--arch-bg"],
      ["--arch-text", "--arch-header-bg"],
      ["--arch-text", "--arch-lane-bg"],
      ["--arch-text", "--arch-card-bg"],
      ["--arch-text", "--arch-exp-soft"],
      ["--arch-text", "--arch-core-soft"],
      ["--arch-text", "--arch-ground-soft"],
      ["--arch-muted", "--arch-header-bg"],
      ["--arch-muted", "--arch-lane-bg"],
      ["--arch-muted", "--arch-card-bg"],
      ["--arch-eyebrow", "--arch-header-bg"],
      ["--arch-pill-text", "--arch-pill-bg"],
      ["--arch-pill-product-text", "--arch-pill-product-bg"],
      ["--arch-step-text", "--arch-step-bg"],
      ["--arch-recap-text", "--arch-recap-bg"],
      ["--arch-flow-text", "--arch-flow-bg"],
      ["--arch-exp-accent", "--arch-exp-soft"],
      ["--arch-core-accent", "--arch-core-soft"],
      ["--arch-ground-accent", "--arch-ground-soft"],
      ["--arch-gov-accent", "--arch-gov-soft"],
      ["--arch-gov-accent", "--arch-rail-bg"],
      ["--arch-outcome-text", "--arch-outcome-bg"],
      ["--arch-outcome-label", "--arch-outcome-bg"],
    ];

    for (const [fgVar, bgVar] of textPairs) {
      const ratio = contrastRatio(t[fgVar], t[bgVar]);
      assert.ok(
        ratio >= 4.5,
        `${label}: ${fgVar} (${t[fgVar]}) on ${bgVar} (${t[bgVar]}) must be >= 4.5:1, got ${ratio.toFixed(2)}:1`,
      );
    }

    const borderPairs = [
      ["--arch-border", "--arch-bg"],
      ["--arch-border", "--arch-lane-bg"],
      ["--arch-card-border", "--arch-lane-bg"],
      ["--arch-card-border", "--arch-card-bg"],
      ["--arch-connector", "--arch-bg"],
    ];
    for (const [fgVar, bgVar] of borderPairs) {
      const ratio = contrastRatio(t[fgVar], t[bgVar]);
      assert.ok(
        ratio >= 3.0,
        `${label}: ${fgVar} (${t[fgVar]}) on ${bgVar} (${t[bgVar]}) must be >= 3.0:1, got ${ratio.toFixed(2)}:1`,
      );
    }
  }
});
