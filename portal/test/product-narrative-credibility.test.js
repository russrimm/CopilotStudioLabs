import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getFeatures } from "../lib/lab-builder/catalog.js";
import { getIndustries, getRoles } from "../lib/scenarios.js";
import { getProducts, productOf } from "../lib/lab-builder/products.js";
import { DELIVERABLE_MODES, resolveDeliverableMode } from "../lib/lab-builder/deliverable.js";
import { composeScenarioProfile, planLab } from "../lib/lab-builder/planner.js";
import { generateLab } from "../lib/lab-builder/generator.js";
import { assessLab } from "../lib/lab-builder/qa.js";
import { validateLabDir } from "../lib/validator.js";

process.env.LAB_BUILDER_LINK_CHECK = "off";
process.env.LAB_BUILDER_VENDOR_DOCS = "off";

const SINGLE_AGENT_RE = /\ba single(?:,\s*auditable)?\s+agent\b/i;
const FORBIDDEN_HARNESS_RE = /github copilot harness/i;
const NON_AGENT_CHATBOT_PATTERNS = [
  /Questions the finished agent should answer/i,
  /Ask the published agent\b/i,
  /remove it from the \*\*Agents\*\* page/i,
  /building on the same agent/i,
  /\*\*Sample prompt\.\*\* Try asking/i,
  /^#\s+[^:\n]+:\s+Build an?\s+[^\n]*Assistant\b/im,
];

function pickFeatures(productId, predicate = () => true, count = 2) {
  const pool = getFeatures().filter((f) => productOf(f) === productId && predicate(f));
  assert.ok(pool.length >= 1, `expected at least 1 feature for ${productId}`);
  const level = pool[0].level;
  return {
    level,
    features: pool.filter((f) => f.level === level).slice(0, count).map((f) => f.id),
  };
}

test("scenario-profiles.json and planner profiles never emit universal 'a single agent' boilerplate", () => {
  const raw = readFileSync(new URL("../lib/lab-builder/scenario-profiles.json", import.meta.url), "utf8");
  assert.doesNotMatch(raw, SINGLE_AGENT_RE);
  assert.doesNotMatch(raw, FORBIDDEN_HARNESS_RE);

  const roles = getRoles();
  for (const industry of [undefined, ...getIndustries().map((i) => i.id)]) {
    const noRole = composeScenarioProfile(industry, [], roles);
    assert.doesNotMatch(noRole.outcome, SINGLE_AGENT_RE);

    for (const role of roles) {
      const singleRole = composeScenarioProfile(industry, [role.id], roles);
      assert.doesNotMatch(singleRole.outcome, SINGLE_AGENT_RE, `${industry || "cross"}:${role.id}`);
    }

    const multiRole = composeScenarioProfile(industry, ["finance", "legal", "it"], roles);
    assert.doesNotMatch(multiRole.outcome, SINGLE_AGENT_RE);
  }
});

test("all 11 product and capability deliverable modes frame titles, scenarios, diagrams, and checks accurately", async () => {
  const cases = [
    {
      name: "Copilot Studio custom agent",
      products: ["copilot-studio"],
      harness: "standard",
      ...pickFeatures("copilot-studio", (f) => f.level === 100),
      expectedMode: DELIVERABLE_MODES.COPILOT_STUDIO_AGENT,
      isAgent: true,
      titleMatch: /^Financial Services: Build a Finance Close Assistant/,
    },
    {
      name: "M365 Copilot declarative agent authoring",
      products: ["m365-copilot-agent-builder"],
      ...pickFeatures("m365-copilot-agent-builder", (f) => f.level === 100),
      expectedMode: DELIVERABLE_MODES.DECLARATIVE_AGENT,
      isAgent: true,
      titleMatch: /Declarative Agent for Microsoft 365 Copilot/,
    },
    {
      name: "M365 Copilot declarative agent governance",
      products: ["m365-copilot-agent-builder"],
      level: 300,
      features: ["dca-admin-agent-settings", "dca-admin-agent-registry"],
      expectedMode: DELIVERABLE_MODES.DECLARATIVE_AGENT_GOVERNANCE,
      isAgent: false,
      titleMatch: /Govern Declarative Agents/,
    },
    {
      name: "Microsoft 365 Copilot hub tenant governance",
      products: ["m365-copilot-hub"],
      ...pickFeatures("m365-copilot-hub", (f) => f.level === 200),
      expectedMode: DELIVERABLE_MODES.M365_COPILOT_GOVERNANCE,
      isAgent: false,
      titleMatch: /Govern Microsoft 365 Copilot with a Finance Close Copilot Governance Plan/,
    },
    {
      name: "Power Platform AI Hub prompts and AI Builder models",
      products: ["power-platform-ai-hub"],
      ...pickFeatures("power-platform-ai-hub", (f) => f.category !== "administration" && f.level === 200),
      expectedMode: DELIVERABLE_MODES.POWER_PLATFORM_AI_BUILDER,
      isAgent: false,
      titleMatch: /Build a Finance Close AI Automation with AI Builder/,
    },
    {
      name: "Power Platform AI Hub administration and ALM",
      products: ["power-platform-ai-hub"],
      ...pickFeatures("power-platform-ai-hub", (f) => f.category === "administration"),
      expectedMode: DELIVERABLE_MODES.POWER_PLATFORM_AI_GOVERNANCE,
      isAgent: false,
      titleMatch: /Govern AI Builder with a Finance Close AI Builder Governance Plan/,
    },
    {
      name: "SharePoint AI site-grounded agent",
      products: ["sharepoint-ai"],
      level: 100,
      features: ["spai-build-agent-sharepoint-content", "spai-share-agent-and-manage-access"],
      expectedMode: DELIVERABLE_MODES.SHAREPOINT_AGENT,
      isAgent: true,
      titleMatch: /Build a Finance Close SharePoint Agent in SharePoint/,
    },
    {
      name: "SharePoint AI content intelligence (autofill & document processing)",
      products: ["sharepoint-ai"],
      level: 200,
      features: ["spai-autofill-columns", "spai-prebuilt-document-processing"],
      expectedMode: DELIVERABLE_MODES.SHAREPOINT_CONTENT_AI,
      isAgent: false,
      titleMatch: /Configure a Finance Close SharePoint Content Pipeline with SharePoint AI/,
    },
    {
      name: "SharePoint Advanced Management governance",
      products: ["sharepoint-ai"],
      level: 300,
      features: ["spai-content-management-assessment", "spai-restricted-content-discovery"],
      expectedMode: DELIVERABLE_MODES.SHAREPOINT_GOVERNANCE,
      isAgent: false,
      titleMatch: /Govern SharePoint Content with a Finance Close SharePoint Governance Plan/,
    },
    {
      name: "Microsoft Foundry model deployment and platform governance",
      products: ["ai-foundry"],
      level: 100,
      features: ["fdy-create-foundry-project", "fdy-deploy-test-model"],
      expectedMode: DELIVERABLE_MODES.FOUNDRY_MODELS_PLATFORM,
      isAgent: false,
      titleMatch: /Deploy a Finance Close Foundry Model Workspace in Microsoft Foundry/,
    },
    {
      name: "Microsoft Foundry agent development and evaluation",
      products: ["ai-foundry"],
      level: 200,
      features: ["fdy-create-prompt-agent", "fdy-agent-ai-search"],
      expectedMode: DELIVERABLE_MODES.FOUNDRY_AGENT,
      isAgent: true,
      titleMatch: /Build a Finance Close Foundry Agent in Microsoft Foundry/,
    },
  ];

  const outRoot = mkdtempSync(join(tmpdir(), "narrative-credibility-"));
  try {
    for (const c of cases) {
      const request = {
        products: c.products,
        ...(c.harness ? { harness: c.harness } : {}),
        level: c.level,
        features: c.features,
        industry: "financial-services",
        roles: ["finance"],
      };
      const result = await generateLab(request, {
        useLearnMcp: false,
        useLlm: false,
        write: true,
        outputRoot: outRoot,
      });

      assert.equal(result.status, "complete", c.name);
      assert.equal(result.plan.deliverable.mode, c.expectedMode, `${c.name}: deliverable mode`);
      assert.equal(result.plan.deliverable.isAgent, c.isAgent, `${c.name}: isAgent`);
      assert.match(result.plan.title, c.titleMatch, `${c.name}: title`);
      assert.doesNotMatch(result.markdown, SINGLE_AGENT_RE, `${c.name}: no 'a single agent'`);
      assert.doesNotMatch(result.markdown, FORBIDDEN_HARNESS_RE, `${c.name}: no forbidden harness name`);
      assert.match(result.markdown, /### Solution Architecture\s+[\s\S]*```mermaid\s+flowchart LR/, `${c.name}: Mermaid architecture diagram`);

      if (!c.isAgent) {
        for (const bad of NON_AGENT_CHATBOT_PATTERNS) {
          assert.doesNotMatch(result.markdown, bad, `${c.name}: must not contain chatbot framing ${bad}`);
        }
      }
      if (!c.products.includes("copilot-studio")) {
        assert.doesNotMatch(
          result.markdown,
          /\ba Microsoft Copilot Studio agent\b|When Copilot Studio asks you to describe the agent|\bin Microsoft Copilot Studio\b/i,
          `${c.name}: must not frame lab as a Copilot Studio agent`,
        );
      }
      if (c.products[0] === "ai-foundry") {
        assert.doesNotMatch(result.markdown, /Power Platform admin|connector\(s\) this lab uses/i, `${c.name}: no Power Platform connector prereq on Foundry`);
      }

      const validation = validateLabDir(result.outputDir, { labId: result.labId, title: result.plan.title });
      assert.equal(validation.failed, 0, `${c.name}: structural validator passed`);
      assert.equal(result.qa.grade, "Excellent", `${c.name}: QA grade Excellent (got ${result.qa.score}: ${JSON.stringify(result.qa.findings)})`);
      assert.ok(result.qa.score >= 95, `${c.name}: QA score >= 95 (got ${result.qa.score})`);
      assert.equal(
        result.qa.findings.filter((f) => f.rule === "product-deliverable-alignment").length,
        0,
        `${c.name}: zero product-deliverable-alignment findings`,
      );
    }
  } finally {
    rmSync(outRoot, { recursive: true, force: true });
  }
});

test("all 6 products compose cleanly across all 7 industries, all 12 departments, multi-department, and no-vertical combinations", () => {
  const singleRoleSets = getRoles().map((r) => [r.id]);
  const roleSets = [[], ...singleRoleSets, ["operations", "legal"], ["sales", "marketing", "sustainability"]];
  const industries = [undefined, ...getIndustries().map((i) => i.id)];

  for (const product of getProducts()) {
    const sample = pickFeatures(product.id, () => true, 1);
    for (const industry of industries) {
      for (const roles of roleSets) {
        const plan = planLab({
          products: [product.id],
          ...(product.hasHarnesses ? { harness: "microsoft-copilot" } : {}),
          level: sample.level,
          features: sample.features,
          ...(industry ? { industry } : {}),
          roles,
        });
        assert.doesNotMatch(plan.title, SINGLE_AGENT_RE);
        assert.doesNotMatch(plan.profile.outcome, SINGLE_AGENT_RE);
        assert.doesNotMatch(plan.profile.problem, FORBIDDEN_HARNESS_RE);

        const mode = resolveDeliverableMode([product.id], plan.features);
        assert.equal(plan.deliverable.mode, mode);
        if (product.id === "m365-copilot-hub" || product.id === "power-platform-ai-hub") {
          assert.equal(plan.deliverable.isAgent, false);
          assert.doesNotMatch(plan.profile.agentName, /\bAssistant$/);
        }
      }
    }
  }
});

test("qa.js product-deliverable-alignment flags chatbot framing on non-agent products and 'a single agent' boilerplate", async () => {
  const hubPick = pickFeatures("m365-copilot-hub", (f) => f.level === 200, 1);
  const clean = await generateLab(
    {
      products: ["m365-copilot-hub"],
      level: hubPick.level,
      features: hubPick.features,
      industry: "healthcare",
      roles: ["it"],
    },
    { useLearnMcp: false, useLlm: false, write: false },
  );
  assert.equal(clean.qa.findings.filter((f) => f.rule === "product-deliverable-alignment").length, 0);

  const corrupted = clean.markdown
    .replace(/^# .+$/m, "# Healthcare: Build an IT Service Desk Assistant with Copilot Licenses")
    .replace("## Validation / Success Criteria", "**Questions the finished agent should answer**\n\nAsk the published agent \"test\" in Copilot Studio with a single agent.\n\n## Validation / Success Criteria");

  const flagged = assessLab(corrupted, {
    expectedTopics: clean.plan.features.filter((f) => !f.prerequisite),
    products: ["m365-copilot-hub"],
    isAgentDeliverable: false,
  });
  const alignmentFindings = flagged.findings.filter((f) => f.rule === "product-deliverable-alignment");
  assert.equal(alignmentFindings.length, 1);
  assert.equal(alignmentFindings[0].severity, "error");
  assert.match(alignmentFindings[0].message, /single agent/i);
  assert.match(alignmentFindings[0].message, /Copilot Studio/i);
  assert.match(alignmentFindings[0].message, /Questions the finished agent should answer/i);
  assert.match(alignmentFindings[0].message, /titles a non-agent lab as building an Assistant/i);
  assert.ok(flagged.score < clean.qa.score);
});
