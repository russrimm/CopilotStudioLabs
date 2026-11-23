/**
 * Sample labs for the export path-budget tests: offline, deterministic, fictional names only. They cover the shapes that
 * made ZIP paths long: a single product with six modules, several products with 25+ modules and prerequisite recaps,
 * a Learn-only topic, a Foundry lab, and a lab whose title is 160 characters with an ampersand, quotes, accents, and
 * trailing dots.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateLab } from "../../lib/lab-builder/generator.js";

process.env.LAB_BUILDER_LINK_CHECK = "off";
process.env.LAB_BUILDER_VENDOR_DOCS = "off";

/** 160 characters, with accents, an ampersand, quotes, a hash, and trailing dots. */
export const LONG_TITLE = (() => {
  let title = 'Café Réunion & "Fabrikam" Plant #7 Línea 3: Build a Résumé-Screening Assistant for R&D with Agents, Flows, Connectors and Évaluations';
  while (title.length < 157) title += " & more";
  return `${title.slice(0, 157)}...`;
})();

export const EXPORT_SAMPLE_LABS = {
  single: { industry: "retail", includeCore: false, products: ["copilot-studio"], harness: "standard", features: ["create-agent", "knowledge-sharepoint", "custom-connectors", "mcp-servers", "knowledge-dataverse", "agent-flows"] },
  multi: {
    industry: "energy-resources",
    includeCore: false,
    level: 300,
    products: ["copilot-studio", "sharepoint-ai", "ai-foundry", "m365-copilot-agent-builder"],
    harness: "standard",
    features: [
      "mc-upgrade-from-standard", "custom-connectors", "epic-fhir-integration", "shopify-integration", "onprem-data-gateway", "vnet-private-connectivity",
      "spai-restricted-content-discovery", "spai-restricted-access-control", "fdy-configure-guardrails", "fdy-foundry-rbac", "dca-toolkit-mcp-plugin", "dca-agent-builder-share-and-catalog",
    ],
  },
  learnOnly: { title: "Contoso Child Agent Lab", industry: "retail", products: ["copilot-studio"], harness: "standard", level: 200, features: ["learn-add-agent-child-agent"], includeKnowledgeCheck: false },
  foundry: { title: "Fabrikam Foundry Lab", industry: "energy-resources", products: ["ai-foundry"], level: 200, features: ["fdy-create-prompt-agent"], includeKnowledgeCheck: true },
  longTitle: { title: LONG_TITLE, industry: "manufacturing", products: ["copilot-studio"], harness: "standard", level: 100, features: ["create-agent", "agent-instructions", "knowledge-sharepoint"], includeKnowledgeCheck: true },
};

/** Build the named labs into a throwaway root (or the one given). Returns `{root, labs: {name: {labId, outputDir, title, modules}}, cleanup}`. */
export async function buildExportSampleLabs(names = Object.keys(EXPORT_SAMPLE_LABS), { root = mkdtempSync(join(tmpdir(), "export-labs-")) } = {}) {
  const labs = {};
  for (const name of names) {
    const built = await generateLab(EXPORT_SAMPLE_LABS[name], { outputRoot: root, useLearnMcp: false, useLlm: false });
    labs[name] = { labId: built.labId, outputDir: built.outputDir, title: built.manifest.title, modules: built.manifest.modules.length };
  }
  return { root, labs, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
