/**
 * Sample labs for the training deck tests: offline, deterministic, fictional names only. Each lab is built once per
 * test file and kept in a throwaway folder.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateLab } from "../../lib/lab-builder/generator.js";
import { readZipStrict } from "../../../tools/lab-builder/lib/ooxml-strict.mjs";

process.env.LAB_BUILDER_LINK_CHECK = "off";
process.env.LAB_BUILDER_VENDOR_DOCS = "off";

/** The labs: the owner's own examples at several levels, other harnesses and products, a Learn-only topic, and two products at once. */
export const SAMPLE_LABS = {
  level100: { title: "Contoso Plant Foundations Lab", industry: "manufacturing", products: ["copilot-studio"], harness: "standard", level: 100, features: ["create-agent", "agent-instructions", "knowledge-sharepoint", "publish-agent"], includeKnowledgeCheck: true },
  level200: { title: "Contoso Plant Operations Lab", industry: "manufacturing", products: ["copilot-studio"], harness: "standard", level: 200, features: ["generative-orchestration", "connector-tools"], includeKnowledgeCheck: true },
  level300: { title: "Fabrikam Retail Integration Lab", industry: "retail", products: ["copilot-studio"], harness: "standard", level: 300, features: ["custom-connectors"], includeKnowledgeCheck: false },
  copilotHarness: { title: "Contoso Copilot Harness Lab", industry: "financial-services", products: ["copilot-studio"], harness: "microsoft-copilot", level: 100, features: ["mc-create-agent", "mc-instructions", "mc-knowledge"], includeKnowledgeCheck: true },
  agentBuilder: { title: "Fabrikam Agent Builder Lab", industry: "healthcare", products: ["m365-copilot-agent-builder"], level: 200, features: ["dca-write-agent-instructions", "dca-agent-builder-knowledge"], includeKnowledgeCheck: true },
  sharepointAi: { title: "Contoso SharePoint AI Lab", industry: "education", products: ["sharepoint-ai"], level: 100, features: ["spai-build-agent-sharepoint-content"], includeKnowledgeCheck: true },
  foundry: { title: "Fabrikam Foundry Lab", industry: "energy-resources", products: ["ai-foundry"], level: 200, features: ["fdy-create-prompt-agent"], includeKnowledgeCheck: true },
  learnOnly: { title: "Contoso Child Agent Lab", industry: "retail", products: ["copilot-studio"], harness: "standard", level: 200, features: ["learn-add-agent-child-agent"], includeKnowledgeCheck: false },
  multiProduct: { title: "Contoso Two Products Lab", industry: "nonprofit", products: ["copilot-studio", "sharepoint-ai"], harness: "standard", level: 100, features: ["knowledge-sharepoint", "spai-build-agent-sharepoint-content"], includeKnowledgeCheck: true },
};

/** Build the named labs into a throwaway root (or the one given). Returns `{root, labs: {name: {labId, outputDir}}, cleanup}`. */
export async function buildSampleLabs(names = Object.keys(SAMPLE_LABS), { root = mkdtempSync(join(tmpdir(), "training-labs-")) } = {}) {
  const labs = {};
  for (const name of names) {
    const built = await generateLab(SAMPLE_LABS[name], { outputRoot: root, useLearnMcp: false, useLlm: false });
    labs[name] = { labId: built.labId, outputDir: built.outputDir };
  }
  return { root, labs, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const decodeEntities = (text) => String(text).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const runsOf = (xml) => [...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)].map((m) => decodeEntities([...m[1].matchAll(/<a:t[^>]*>([^<]*)<\/a:t>/g)].map((t) => t[1]).join(""))).filter(Boolean);

/** Read a deck the way a reader would: per slide, the title, every line of slide text, the speaker notes, and the diagram groups with their alt text. */
export function readDeck(buffer) {
  const zip = readZipStrict(buffer, { opc: false });
  const names = [...zip.entries.keys()].filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  const slides = names.map((name, index) => {
    const xml = zip.entries.get(name).toString("utf8");
    const number = Number(name.match(/\d+/)[0]);
    const shapes = [...xml.matchAll(/<p:sp>([\s\S]*?)<\/p:sp>/g)].map((m) => m[1]);
    const titleShape = shapes.find((s) => /<p:ph type="title"/.test(s)) || "";
    const notesXml = zip.entries.get(`ppt/notesSlides/notesSlide${number}.xml`)?.toString("utf8") || "";
    const notesBody = (notesXml.match(/<p:ph type="body"[\s\S]*?<\/p:sp>/) || [""])[0];
    return {
      index,
      number,
      xml,
      title: runsOf(titleShape).join(" "),
      lines: runsOf(xml),
      notes: runsOf(notesBody),
      groups: [...xml.matchAll(/<p:grpSp>\s*<p:nvGrpSpPr>\s*<p:cNvPr id="\d+" name="([^"]*)"(?: descr="([^"]*)")?/g)].map((m) => ({ name: decodeEntities(m[1]), descr: decodeEntities(m[2] || "") })),
      pictures: [...xml.matchAll(/<p:pic>[\s\S]*?<p:cNvPr id="\d+" name="[^"]*"(?: descr="([^"]*)")?/g)].map((m) => decodeEntities(m[1] || "")),
    };
  });
  return { zip, slides, problems: zip.problems };
}

const compactText = (text) => decodeEntities(text).toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Strings only the administrator model writes: finding one in a deck means a setting leaked (the same idea as admin-setup-guide.test.js). */
export function adminMarkerList(admin) {
  const markers = ["Connectors, Environment, and Tenant Prerequisites", "Admin Prerequisites, DLP & Guardrails", "Additional Admin & DLP Controls", "Connectors and Endpoints to Allow", "Admin Center & Implementation Guidance", "Required Role / Connector / Policy"];
  for (const group of [admin?.connectors, admin?.dlpAndAcp, admin?.environmentSettings, admin?.tenantAndCloud]) {
    for (const entry of group || []) {
      if (entry.title) markers.push(entry.title);
      if (entry.details) markers.push(entry.details.slice(0, 90));
      if (entry.adminPath && entry.adminPath.length > 40) markers.push(entry.adminPath);
    }
  }
  return markers.map((text) => ({ text, key: compactText(text) })).filter((m) => m.key.length >= 20);
}

export function findAdminLeaks(text, markers) {
  const haystack = compactText(text);
  return markers.filter((m) => haystack.includes(m.key)).map((m) => m.text);
}
