/**
 * Product- and capability-aware deliverable framing.
 *
 * The lab generator spans six Microsoft AI products and ten distinct capability
 * tracks: building custom agents in Microsoft Copilot Studio, authoring
 * declarative agents on the Microsoft 365 Copilot orchestrator, governing
 * Microsoft 365 Copilot across a tenant, automating processes with AI Builder
 * prompts and models, configuring SharePoint AI agents / content intelligence /
 * SharePoint Advanced Management governance, and provisioning Microsoft Foundry
 * models or agents.
 *
 * Framing every lab as "Build an <X> Assistant" with "a single agent that..."
 * misrepresents non-agent products and capabilities. This module resolves the
 * selected products and modules into a concrete deliverable descriptor used by
 * the planner, composer, teaching blocks, LLM prompts, and QA checks.
 */

import { DEFAULT_PRODUCT, getProduct, productName, productOf, productsPhrase } from "./products.js";

export const DELIVERABLE_MODES = Object.freeze({
  COPILOT_STUDIO_AGENT: "copilot-studio-agent",
  DECLARATIVE_AGENT: "declarative-agent",
  DECLARATIVE_AGENT_GOVERNANCE: "declarative-agent-governance",
  M365_COPILOT_GOVERNANCE: "m365-copilot-governance",
  POWER_PLATFORM_AI_BUILDER: "power-platform-ai-builder",
  POWER_PLATFORM_AI_GOVERNANCE: "power-platform-ai-governance",
  SHAREPOINT_AGENT: "sharepoint-agent",
  SHAREPOINT_CONTENT_AI: "sharepoint-content-ai",
  SHAREPOINT_GOVERNANCE: "sharepoint-governance",
  FOUNDRY_AGENT: "foundry-agent",
  FOUNDRY_MODELS_PLATFORM: "foundry-models-platform",
});

const AGENT_MODES = new Set([
  DELIVERABLE_MODES.COPILOT_STUDIO_AGENT,
  DELIVERABLE_MODES.DECLARATIVE_AGENT,
  DELIVERABLE_MODES.SHAREPOINT_AGENT,
  DELIVERABLE_MODES.FOUNDRY_AGENT,
]);

const DCA_ADMIN_GOVERNANCE_IDS = new Set([
  "dca-admin-agent-settings",
  "dca-admin-agent-registry",
]);

const SHAREPOINT_AGENT_IDS = new Set([
  "spai-build-agent-sharepoint-content",
  "spai-share-agent-and-manage-access",
  "spai-agent-sharepoint-knowledge-sources",
  "spai-upgrade-agent-files",
]);

const SHAREPOINT_CONTENT_IDS = new Set([
  "spai-copilot-in-sharepoint-overview",
  "spai-autofill-columns",
  "spai-prebuilt-document-processing",
  "spai-copilot-credits-advanced-work",
  "spai-manage-copilot-availability",
]);

const SHAREPOINT_GOVERNANCE_IDS = new Set([
  "spai-sam-overview-and-licensing",
  "spai-content-management-assessment",
  "spai-restricted-content-discovery",
  "spai-restricted-access-control",
  "spai-site-access-review",
  "spai-site-lifecycle-policies",
  "spai-control-agent-access",
  "spai-agent-insights-reports",
  "spai-sharepoint-admin-agent",
]);

const FOUNDRY_AGENT_CATEGORIES = new Set(["foundry-agents", "foundry-operate"]);

function articleFor(phrase) {
  return /^[aeiou]/i.test(String(phrase || "").trim()) ? "an" : "a";
}

function baseScopeFromName(agentName) {
  const cleaned = String(agentName || "Enterprise Assistant")
    .trim()
    .replace(/\s+Assistant$/i, "")
    .trim();
  return cleaned || "Enterprise";
}

/** Sanitize untrusted/scenario text before placing it inside a Mermaid node label. */
function mermaidSafe(text, maxLen = 56) {
  const clean = String(text || "")
    .replace(/[`"'<>[\]{}()|\\;\r\n#*~_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length <= maxLen) return clean;
  const sliced = clean.slice(0, maxLen - 3);
  const boundary = sliced.lastIndexOf(" ");
  return `${(boundary > 20 ? sliced.slice(0, boundary) : sliced).replace(/[,;:\s]+$/, "")}...`;
}

/** Choose the dominant product from active modules, preserving product order on ties. */
function dominantProduct(productIds, features) {
  const ids = productIds?.length ? productIds : [DEFAULT_PRODUCT];
  if (ids.length === 1) return ids[0];
  const active = (features || []).filter((f) => f && !f.prerequisite);
  const pool = active.length ? active : features || [];
  if (!pool.length) return ids[0];

  const counts = new Map(ids.map((id) => [id, 0]));
  for (const feature of pool) {
    const pid = productOf(feature);
    counts.set(pid, (counts.get(pid) || 0) + 1);
  }
  if ((counts.get(DEFAULT_PRODUCT) || 0) > 0 && ids.includes(DEFAULT_PRODUCT)) {
    const csCount = counts.get(DEFAULT_PRODUCT) || 0;
    const maxCount = Math.max(...counts.values());
    if (csCount === maxCount) return DEFAULT_PRODUCT;
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || ids[0];
}

/**
 * Determine the deliverable mode for a set of products and feature objects.
 *
 * @param {string[]} productIds
 * @param {Array<object>} features
 * @returns {string} one of DELIVERABLE_MODES
 */
export function resolveDeliverableMode(productIds = [DEFAULT_PRODUCT], features = []) {
  const ids = productIds?.length ? productIds : [DEFAULT_PRODUCT];
  const active = (features || []).filter((f) => f && !f.prerequisite);
  const pool = active.length ? active : features || [];
  const primary = dominantProduct(ids, pool);

  if (primary === DEFAULT_PRODUCT) {
    return DELIVERABLE_MODES.COPILOT_STUDIO_AGENT;
  }

  if (primary === "m365-copilot-hub") {
    return DELIVERABLE_MODES.M365_COPILOT_GOVERNANCE;
  }

  if (primary === "m365-copilot-agent-builder") {
    const onlyGovernance =
      pool.length > 0 &&
      pool.every((f) => DCA_ADMIN_GOVERNANCE_IDS.has(f.id));
    return onlyGovernance
      ? DELIVERABLE_MODES.DECLARATIVE_AGENT_GOVERNANCE
      : DELIVERABLE_MODES.DECLARATIVE_AGENT;
  }

  if (primary === "power-platform-ai-hub") {
    const onlyAdmin =
      pool.length > 0 &&
      pool.every((f) => f.category === "administration");
    return onlyAdmin
      ? DELIVERABLE_MODES.POWER_PLATFORM_AI_GOVERNANCE
      : DELIVERABLE_MODES.POWER_PLATFORM_AI_BUILDER;
  }

  if (primary === "sharepoint-ai") {
    if (pool.some((f) => SHAREPOINT_AGENT_IDS.has(f.id))) {
      return DELIVERABLE_MODES.SHAREPOINT_AGENT;
    }
    const hasExtraction = pool.some((f) => f.id === "spai-autofill-columns" || f.id === "spai-prebuilt-document-processing");
    if (!hasExtraction && pool.some((f) => SHAREPOINT_GOVERNANCE_IDS.has(f.id))) {
      return DELIVERABLE_MODES.SHAREPOINT_GOVERNANCE;
    }
    if (pool.some((f) => SHAREPOINT_CONTENT_IDS.has(f.id))) {
      return DELIVERABLE_MODES.SHAREPOINT_CONTENT_AI;
    }
    return DELIVERABLE_MODES.SHAREPOINT_GOVERNANCE;
  }

  if (primary === "ai-foundry") {
    if (pool.some((f) => FOUNDRY_AGENT_CATEGORIES.has(f.category))) {
      return DELIVERABLE_MODES.FOUNDRY_AGENT;
    }
    return DELIVERABLE_MODES.FOUNDRY_MODELS_PLATFORM;
  }

  return DELIVERABLE_MODES.COPILOT_STUDIO_AGENT;
}

export function isAgentDeliverable(mode) {
  return AGENT_MODES.has(mode);
}

/** Build the product-accurate deliverable name from a base scenario agent name. */
export function formatDeliverableName(baseAgentName, mode) {
  const scope = baseScopeFromName(baseAgentName);
  switch (mode) {
    case DELIVERABLE_MODES.COPILOT_STUDIO_AGENT:
      return `${scope} Assistant`;
    case DELIVERABLE_MODES.DECLARATIVE_AGENT:
      return `${scope} Declarative Agent`;
    case DELIVERABLE_MODES.DECLARATIVE_AGENT_GOVERNANCE:
      return `${scope} Declarative Agent Governance Plan`;
    case DELIVERABLE_MODES.M365_COPILOT_GOVERNANCE:
      return `${scope} Copilot Governance Plan`;
    case DELIVERABLE_MODES.POWER_PLATFORM_AI_BUILDER:
      return `${scope} AI Automation`;
    case DELIVERABLE_MODES.POWER_PLATFORM_AI_GOVERNANCE:
      return `${scope} AI Builder Governance Plan`;
    case DELIVERABLE_MODES.SHAREPOINT_AGENT:
      return `${scope} SharePoint Agent`;
    case DELIVERABLE_MODES.SHAREPOINT_CONTENT_AI:
      return `${scope} SharePoint Content Pipeline`;
    case DELIVERABLE_MODES.SHAREPOINT_GOVERNANCE:
      return `${scope} SharePoint Governance Plan`;
    case DELIVERABLE_MODES.FOUNDRY_AGENT:
      return `${scope} Foundry Agent`;
    case DELIVERABLE_MODES.FOUNDRY_MODELS_PLATFORM:
      return `${scope} Foundry Model Workspace`;
    default:
      return `${scope} Assistant`;
  }
}

/** Build a crisp, product-accurate lab title. */
export function buildDeliverableTitle({ mode, industryName, deliverableName, headline }) {
  const prefix = industryName || "Cross-industry";
  const art = articleFor(deliverableName);
  switch (mode) {
    case DELIVERABLE_MODES.COPILOT_STUDIO_AGENT:
      return `${prefix}: Build ${art} ${deliverableName} with ${headline}`;
    case DELIVERABLE_MODES.DECLARATIVE_AGENT:
      return `${prefix}: Build ${art} ${deliverableName} for Microsoft 365 Copilot — ${headline}`;
    case DELIVERABLE_MODES.DECLARATIVE_AGENT_GOVERNANCE:
      return `${prefix}: Govern Declarative Agents with ${art} ${deliverableName} — ${headline}`;
    case DELIVERABLE_MODES.M365_COPILOT_GOVERNANCE:
      return `${prefix}: Govern Microsoft 365 Copilot with ${art} ${deliverableName} — ${headline}`;
    case DELIVERABLE_MODES.POWER_PLATFORM_AI_BUILDER:
      return `${prefix}: Build ${art} ${deliverableName} with AI Builder — ${headline}`;
    case DELIVERABLE_MODES.POWER_PLATFORM_AI_GOVERNANCE:
      return `${prefix}: Govern AI Builder with ${art} ${deliverableName} — ${headline}`;
    case DELIVERABLE_MODES.SHAREPOINT_AGENT:
      return `${prefix}: Build ${art} ${deliverableName} in SharePoint — ${headline}`;
    case DELIVERABLE_MODES.SHAREPOINT_CONTENT_AI:
      return `${prefix}: Configure ${art} ${deliverableName} with SharePoint AI — ${headline}`;
    case DELIVERABLE_MODES.SHAREPOINT_GOVERNANCE:
      return `${prefix}: Govern SharePoint Content with ${art} ${deliverableName} — ${headline}`;
    case DELIVERABLE_MODES.FOUNDRY_AGENT:
      return `${prefix}: Build ${art} ${deliverableName} in Microsoft Foundry — ${headline}`;
    case DELIVERABLE_MODES.FOUNDRY_MODELS_PLATFORM:
      return `${prefix}: Deploy ${art} ${deliverableName} in Microsoft Foundry — ${headline}`;
    default:
      return `${prefix}: Build ${art} ${deliverableName} with ${headline}`;
  }
}

/** Adapt a base scenario profile's problem and outcome to the selected deliverable mode. */
export function adaptProfileForDeliverable(baseProfile, mode) {
  const domain = baseProfile.domain || "business operations";
  const audience = baseProfile.audience || "business users";
  const terms = (baseProfile.terms || []).slice(0, 3);
  const termPhrase = terms.length ? terms.join(", ") : domain;
  const deliverableName = formatDeliverableName(baseProfile.agentName, mode);

  switch (mode) {
    case DELIVERABLE_MODES.COPILOT_STUDIO_AGENT:
      return {
        ...baseProfile,
        agentName: deliverableName,
      };

    case DELIVERABLE_MODES.DECLARATIVE_AGENT:
      return {
        ...baseProfile,
        agentName: deliverableName,
        outcome:
          `a declarative agent running on the Microsoft 365 Copilot orchestrator for ${domain}, configured with scoped knowledge, tailored instructions, and governed capabilities or actions`,
      };

    case DELIVERABLE_MODES.DECLARATIVE_AGENT_GOVERNANCE:
      return {
        ...baseProfile,
        agentName: deliverableName,
        problem:
          `${baseProfile.problem} Before makers publish declarative agents for ${audience}, administrators must verify Copilot connector prerequisites, review submissions, and enforce access boundaries in the Microsoft 365 admin center.`,
        outcome:
          `a governance workflow in the Microsoft 365 admin center for declarative agents supporting ${domain}, covering connector readiness, submission review, and scoped availability`,
      };

    case DELIVERABLE_MODES.M365_COPILOT_GOVERNANCE:
      return {
        ...baseProfile,
        agentName: deliverableName,
        problem:
          `${baseProfile.problem} Rolling out Microsoft 365 Copilot to ${audience} safely requires tenant administrators to assign licenses and billing guardrails, prevent oversharing across ${domain} content, govern agent availability, and measure adoption.`,
        outcome:
          `a Microsoft 365 Copilot tenant governance and rollout baseline for ${domain} covering license and billing controls, data protection policies, governed agent inventory rules, and adoption reporting`,
      };

    case DELIVERABLE_MODES.POWER_PLATFORM_AI_BUILDER:
      return {
        ...baseProfile,
        agentName: deliverableName,
        problem:
          `${baseProfile.problem} Instead of triaging ${termPhrase} documents, messages, and records manually, the team needs repeatable AI Builder prompts, extraction or prediction models, and automated Power Platform workflows.`,
        outcome:
          `an AI Builder automation solution for ${domain} that processes incoming documents and text with governed prompts and models, triggers Power Automate cloud flows, and surfaces structured outputs in Power Apps`,
      };

    case DELIVERABLE_MODES.POWER_PLATFORM_AI_GOVERNANCE:
      return {
        ...baseProfile,
        agentName: deliverableName,
        problem:
          `${baseProfile.problem} Scaling AI Builder prompts and models across ${domain} requires administrators to manage Copilot Credit capacity, enforce environment security roles, monitor AI activity, and package models cleanly across environments.`,
        outcome:
          `an AI Builder administration and ALM baseline for ${domain} with governed environment access, credit and licensing controls, activity monitoring, and solution-based model distribution`,
      };

    case DELIVERABLE_MODES.SHAREPOINT_AGENT:
      return {
        ...baseProfile,
        agentName: deliverableName,
        outcome:
          `a site-grounded SharePoint agent for ${domain} scoped to approved libraries and folders, shared with appropriate permissions, and validated on ${termPhrase} questions`,
      };

    case DELIVERABLE_MODES.SHAREPOINT_CONTENT_AI:
      return {
        ...baseProfile,
        agentName: deliverableName,
        problem:
          `${baseProfile.problem} Document libraries for ${domain} accumulate unstructured files without consistent metadata, forcing ${audience} to open each document by hand to find ${termPhrase} details.`,
        outcome:
          `a SharePoint AI content intelligence pipeline for ${domain} that extracts structured metadata with autofill columns, processes uploaded documents in libraries, and tracks Copilot Credit usage`,
      };

    case DELIVERABLE_MODES.SHAREPOINT_GOVERNANCE:
      return {
        ...baseProfile,
        agentName: deliverableName,
        problem:
          `${baseProfile.problem} Before scaling Copilot and SharePoint agents across ${domain} sites, SharePoint administrators must identify overshared libraries, restrict discovery of sensitive sites, enforce lifecycle reviews, and audit agent usage.`,
        outcome:
          `a SharePoint Advanced Management governance baseline for ${domain} with oversharing assessments, Restricted Content Discovery or access controls, site lifecycle policies, and agent insights reporting`,
      };

    case DELIVERABLE_MODES.FOUNDRY_AGENT:
      return {
        ...baseProfile,
        agentName: deliverableName,
        outcome:
          `an evaluated Microsoft Foundry agent for ${domain} backed by a deployed Foundry model, grounded search or tools, tracing, and operational telemetry`,
      };

    case DELIVERABLE_MODES.FOUNDRY_MODELS_PLATFORM:
      return {
        ...baseProfile,
        agentName: deliverableName,
        problem:
          `${baseProfile.problem} Engineering and platform teams supporting ${audience} need a governed Microsoft Foundry workspace with the right foundation model deployment, regional quota, cost visibility, safety guardrails, and least-privilege Azure RBAC.`,
        outcome:
          `a governed Microsoft Foundry project and model deployment for ${domain} with verified model selection, quota and cost guardrails, content safety filters, and role-based access control`,
      };

    default:
      return { ...baseProfile, agentName: deliverableName };
  }
}

const ROLE_NOTES_NON_AGENT = {
  executives: {
    governance: "Prioritize executive-briefing libraries in sensitivity label and oversharing policies, and surface concise adoption scorecards.",
    automation: "Format prompt and model outputs with the headline figure, date, and source document first so leadership digests need no manual editing.",
    platform: "Track token throughput, latency, and cost-per-briefing metrics so leadership workloads remain predictable.",
  },
  sales: {
    governance: "Scope CRM and proposal libraries with sensitivity labels and verify seller license readiness before enabling external-facing workflows.",
    automation: "Extract account, opportunity stage, and pricing fields cleanly so follow-up flows draft accurate customer responses.",
    platform: "Benchmark model latency and groundedness on account-summary prompts so seller workflows stay responsive.",
  },
  marketing: {
    governance: "Keep brand-approved asset libraries discoverable while restricting unapproved draft folders from Copilot grounding.",
    automation: "Constrain AI Builder prompt instructions to approved brand tone and require source attribution on campaign claims.",
    platform: "Configure content safety guardrails and prompt templates to keep generated campaign assets on brand.",
  },
  "customer-service": {
    governance: "Ensure support playbooks are permissioned accurately while protecting customer case attachments with DLP controls.",
    automation: "Classify incoming case priority and sentiment automatically, and route low-confidence items to a human reviewer.",
    platform: "Evaluate model accuracy and safety filters against realistic customer escalation prompts before rollout.",
  },
  legal: {
    governance: "Enforce strict Restricted Content Discovery, sensitivity labels, and Purview audit retention across matter and contract repositories.",
    automation: "Extract clause types, effective dates, and counterparties with confidence thresholds and mandatory human review.",
    platform: "Apply least-privilege Azure RBAC, network/data guardrails, and strict groundedness checks for legal workloads.",
  },
  finance: {
    governance: "Protect financial close sites with sensitivity labels and DLP rules, and align Copilot Credit budgets with cost centers.",
    automation: "Extract structured invoice numbers, amounts, and variances into typed fields rather than free-text summaries.",
    platform: "Set strict budget alerts, cost meters, and deterministic temperature settings for financial analysis workloads.",
  },
  hr: {
    governance: "Lock down employee-relations and compensation sites with Restricted Access Control and verify privacy boundaries in Purview.",
    automation: "Process onboarding and leave requests with environment security roles that isolate personal employee records.",
    platform: "Enforce strict RBAC separation and safety guardrails so sensitive people data never leaks across projects.",
  },
  it: {
    governance: "Automate agent inventory rules, license assignment groups, and audit monitoring so tenant controls stay repeatable.",
    automation: "Package prompts, models, and cloud flows inside Power Platform solutions with environment variables from day one.",
    platform: "Standardize project provisioning, RBAC role assignments, and quota monitoring for repeatable operations.",
  },
  communications: {
    governance: "Separate embargoed leadership drafts from published announcement sites before rolling out tenant-wide Copilot access.",
    automation: "Use structured AI Builder prompt templates with fixed output sections so multi-channel announcements stay consistent.",
    platform: "Benchmark tone consistency and safety filters across announcement-drafting prompts in the playground.",
  },
  operations: {
    governance: "Align license rollout and SharePoint library permissions with frontline shift leads and operational site owners.",
    automation: "Trigger cloud flows automatically when new forms or supplier files arrive so frontline teams avoid re-keying status updates.",
    platform: "Size deployment quota for peak shift handoff windows and monitor endpoint latency.",
  },
  sustainability: {
    governance: "Preserve audit trails and source-document permissions across facility emissions and supplier evidence libraries.",
    automation: "Extract facility metrics, reporting periods, and units from utility and supplier PDFs into structured tables.",
    platform: "Tag Foundry resources by reporting program and verify source attribution on analytical prompts.",
  },
  accessibility: {
    governance: "Verify accessible onboarding guidance and assistive-technology compatibility across pilot user cohorts.",
    automation: "Design prompt templates that output plain-language summaries and structured alternative text descriptions.",
    platform: "Test model outputs for plain-language readability and clear structure compatible with assistive technologies.",
  },
};

/** Return a role design note matched to the deliverable mode rather than assuming a chat bot. */
export function roleDesignNoteForDeliverable(role, mode) {
  if (!role) return "";
  if (isAgentDeliverable(mode)) {
    if (mode === DELIVERABLE_MODES.DECLARATIVE_AGENT && role.id === "it") {
      return "Validate manifest capabilities, Copilot connector permissions, and admin center publishing scope early.";
    }
    if (mode === DELIVERABLE_MODES.SHAREPOINT_AGENT && role.id === "operations") {
      return "Scope the SharePoint agent to the exact operational libraries frontline teams already open in SharePoint and Teams.";
    }
    return role.designNote || "";
  }

  const bucket =
    mode === DELIVERABLE_MODES.POWER_PLATFORM_AI_BUILDER || mode === DELIVERABLE_MODES.SHAREPOINT_CONTENT_AI
      ? "automation"
      : mode === DELIVERABLE_MODES.FOUNDRY_MODELS_PLATFORM
      ? "platform"
      : "governance";
  return ROLE_NOTES_NON_AGENT[role.id]?.[bucket] || role.designNote || "";
}

/** Descriptor with prose hooks used across composer.js, teaching.js, generator.js, and qa.js. */
export function describeDeliverable(plan) {
  const products = plan.products?.length ? plan.products : [DEFAULT_PRODUCT];
  const mode = plan.deliverable?.mode || resolveDeliverableMode(products, plan.features);
  const csOnly = products.every((id) => id === DEFAULT_PRODUCT);
  const phrase = productsPhrase(products);
  const shortProduct = getProduct(products[0])?.shortName || productName(products[0]);

  const byMode = {
    [DELIVERABLE_MODES.COPILOT_STUDIO_AGENT]: {
      mode,
      isAgent: true,
      kindLabel: csOnly ? "a Microsoft Copilot Studio agent" : `an agent solution with ${phrase}`,
      actionVerb: "building",
      pastVerb: "built",
      progressionNoun: "agent",
      overviewLead: (name, prodPhrase) =>
        csOnly
          ? `In this lab you build **${name}** in Microsoft Copilot Studio`
          : `In this lab you build **${name}** with ${prodPhrase}`,
      subtitle: (name) =>
        `Build ${name} ${csOnly ? "in Microsoft Copilot Studio" : `with ${phrase}`}, one grounded module at a time.`,
      progressionClause: "building on the same agent the whole way",
      scenarioLead: (name, audience) => `You are building **${name}** for ${audience}.`,
      sampleQuestionsHeading: "Questions the finished agent should answer",
      validationLead: (questions) =>
        questions.map(
          (q) => `Ask the published agent "${q}" and confirm the answer is correct, grounded, and cites a source where one applies.`,
        ),
      cleanupLead: (name) => [
        `In Copilot Studio, open **${name}** and remove it from the **Agents** page if you only created it for this exercise, or unpublish it from test channels first.`,
      ],
      nextStepsExtension:
        "Extend the scenario by adding a second knowledge source, wiring a system-of-record action, or adding automated evaluation test sets.",
      closingTakeaway:
        "More importantly, you can now explain *why* each of those pieces exists, which makes the next agent faster to design and govern than this one was.",
      llmNoun: "agent",
    },
    [DELIVERABLE_MODES.DECLARATIVE_AGENT]: {
      mode,
      isAgent: true,
      kindLabel: "a declarative agent for Microsoft 365 Copilot",
      actionVerb: "authoring",
      pastVerb: "built",
      progressionNoun: "declarative agent",
      overviewLead: (name) =>
        `In this lab you author **${name}** in Microsoft 365 Copilot`,
      subtitle: (name) =>
        `Author ${name} on the Microsoft 365 Copilot orchestrator, one grounded module at a time.`,
      progressionClause: "refining the same declarative agent on the Microsoft 365 Copilot orchestrator from first draft to governed release",
      scenarioLead: (name, audience) =>
        `You are authoring **${name}**, a declarative agent in Microsoft 365 Copilot for ${audience}.`,
      sampleQuestionsHeading: "Prompts the declarative agent should handle in Microsoft 365 Copilot",
      validationLead: (questions) =>
        questions.map(
          (q) => `In Microsoft 365 Copilot or the Agent Builder **Try it** pane, submit "${q}" and confirm the response follows your instructions, stays within scoped knowledge, and cites its source.`,
        ),
      cleanupLead: (name) => [
        `In Microsoft 365 Copilot (**Create** -> **My agents**) or Microsoft 365 Agents Toolkit, delete **${name}** if you created it only for this lab, and revoke any temporary sharing links.`,
      ],
      nextStepsExtension:
        "Extend this declarative agent by scoping a Microsoft 365 Copilot connector, adding an API or MCP action in Microsoft 365 Agents Toolkit, or submitting it for organization-wide approval in the Microsoft 365 admin center.",
      closingTakeaway:
        "More importantly, you now understand how instructions, scoped knowledge, capabilities, and actions fit together on the Microsoft 365 Copilot orchestrator.",
      llmNoun: "declarative agent",
    },
    [DELIVERABLE_MODES.DECLARATIVE_AGENT_GOVERNANCE]: {
      mode,
      isAgent: false,
      kindLabel: "a declarative agent governance plan in the Microsoft 365 admin center",
      actionVerb: "configuring",
      pastVerb: "configured",
      progressionNoun: "declarative agent governance plan",
      overviewLead: (name) =>
        `In this lab you configure **${name}** in the Microsoft 365 admin center`,
      subtitle: (name) =>
        `Configure ${name} across the Microsoft 365 admin center, one grounded module at a time.`,
      progressionClause: "assembling one cohesive admin governance workflow step by step",
      scenarioLead: (name, audience) =>
        `You are configuring **${name}** to govern declarative agents serving ${audience}.`,
      sampleQuestionsHeading: "Employee Copilot prompts and workflows your governance rules protect",
      validationLead: (questions) =>
        questions.map(
          (q) => `Verify in the Microsoft 365 admin center that declarative agents handling prompts such as "${q}" enforce your connector, publishing, and user-assignment policies.`,
        ),
      cleanupLead: (name) => [
        `In the Microsoft 365 admin center (**Agents**), revert any temporary test block or pilot user-assignment rules you applied while validating **${name}**.`,
      ],
      nextStepsExtension:
        "Extend this governance baseline by pairing agent submission reviews with Microsoft Purview sensitivity labels and recurring adoption reviews.",
      closingTakeaway:
        "More importantly, you can now explain *why* each administrative gate exists before a declarative agent reaches users across your tenant.",
      llmNoun: "governance plan",
    },
    [DELIVERABLE_MODES.M365_COPILOT_GOVERNANCE]: {
      mode,
      isAgent: false,
      kindLabel: "a Microsoft 365 Copilot tenant governance and rollout plan",
      actionVerb: "configuring",
      pastVerb: "configured",
      progressionNoun: "Microsoft 365 Copilot governance plan",
      overviewLead: (name) =>
        `In this lab you configure **${name}** across the Microsoft 365 admin center and Microsoft Purview`,
      subtitle: (name) =>
        `Configure ${name} across the Microsoft 365 admin center and Microsoft Purview, one grounded module at a time.`,
      progressionClause: "building out one cohesive tenant governance and rollout baseline step by step",
      scenarioLead: (name, audience) =>
        `You are configuring **${name}** in the Microsoft 365 Copilot hub to govern and roll out Copilot for ${audience}.`,
      sampleQuestionsHeading: "Employee Copilot prompts and workflows you are governing",
      validationLead: (questions) =>
        questions.map(
          (q) => `Confirm that your licensing, data security, and agent policies govern how pilot users run workflows such as "${q}" without oversharing restricted content.`,
        ),
      cleanupLead: (name) => [
        `In the Microsoft 365 admin center and Microsoft Purview, remove any temporary test billing policies, pilot license group assignments, or test agent blocks created for **${name}**.`,
      ],
      nextStepsExtension:
        "Extend this governance baseline by expanding pilot license cohorts, reviewing DSPM for AI posture reports in Microsoft Purview, and scheduling monthly Copilot adoption reviews.",
      closingTakeaway:
        "More importantly, you can now explain *why* each licensing, security, agent-registry, and adoption control exists before scaling Microsoft 365 Copilot across the tenant.",
      llmNoun: "governance plan",
    },
    [DELIVERABLE_MODES.POWER_PLATFORM_AI_BUILDER]: {
      mode,
      isAgent: false,
      kindLabel: "an AI Builder intelligent automation solution in Power Platform",
      actionVerb: "building",
      pastVerb: "built",
      progressionNoun: "AI Builder automation",
      overviewLead: (name) =>
        `In this lab you build **${name}** in the Power Platform AI Hub`,
      subtitle: (name) =>
        `Build ${name} in the Power Platform AI Hub with AI Builder prompts, models, and flows, one grounded module at a time.`,
      progressionClause: "connecting AI Builder prompts, models, and Power Platform automation into one end-to-end pipeline",
      scenarioLead: (name, audience) =>
        `You are building **${name}** in the Power Platform AI Hub to automate document, text, and record workflows for ${audience}.`,
      sampleQuestionsHeading: "Incoming requests and business questions your AI prompts and models automate",
      validationLead: (questions) =>
        questions.map(
          (q) => `Run a sample record or request representing "${q}" through your AI Builder prompt, model, flow, or app and confirm structured outputs, confidence scores, and review rules behave as configured.`,
        ),
      cleanupLead: (name) => [
        `In the Power Platform AI Hub, delete any draft prompts or test AI Builder models created for **${name}** so they do not consume Copilot Credits during scheduled runs.`,
      ],
      nextStepsExtension:
        "Extend this automation by adding human-in-the-loop approval stages in Power Automate, packaging prompts and models in a Power Platform solution, and monitoring Copilot Credit consumption.",
      closingTakeaway:
        "More importantly, you can now explain *why* each prompt setting, extraction model, and Power Platform integration pattern fits its job, making your next automation faster to deliver.",
      llmNoun: "AI Builder automation",
    },
    [DELIVERABLE_MODES.POWER_PLATFORM_AI_GOVERNANCE]: {
      mode,
      isAgent: false,
      kindLabel: "an AI Builder administration and ALM governance baseline",
      actionVerb: "configuring",
      pastVerb: "configured",
      progressionNoun: "AI Builder governance baseline",
      overviewLead: (name) =>
        `In this lab you configure **${name}** in the Power Platform admin center`,
      subtitle: (name) =>
        `Configure ${name} across the Power Platform admin center and AI Hub, one grounded module at a time.`,
      progressionClause: "establishing a complete AI Builder capacity, security, monitoring, and ALM baseline step by step",
      scenarioLead: (name, audience) =>
        `You are configuring **${name}** to govern AI Builder prompts and models used by ${audience}.`,
      sampleQuestionsHeading: "Business automation scenarios governed by your AI Builder policies",
      validationLead: (questions) =>
        questions.map(
          (q) => `Confirm that environment roles, Copilot Credit allocations, and ALM rules cleanly govern automations handling scenarios such as "${q}".`,
        ),
      cleanupLead: (name) => [
        `In the Power Platform admin center, remove any temporary test capacity allocations, security role overrides, or unmanaged scratch solutions created for **${name}**.`,
      ],
      nextStepsExtension:
        "Extend this governance baseline by automating solution promotion across dev, test, and production environments and reviewing AI activity logs monthly.",
      closingTakeaway:
        "More importantly, you can now explain *why* each capacity, security, monitoring, and ALM control matters before scaling AI Builder across environments.",
      llmNoun: "AI Builder governance baseline",
    },
    [DELIVERABLE_MODES.SHAREPOINT_AGENT]: {
      mode,
      isAgent: true,
      kindLabel: "a SharePoint agent grounded in site and library content",
      actionVerb: "building",
      pastVerb: "built",
      progressionNoun: "SharePoint agent",
      overviewLead: (name) =>
        `In this lab you build **${name}** in SharePoint`,
      subtitle: (name) =>
        `Build and share ${name} directly on your SharePoint sites and document libraries, one grounded module at a time.`,
      progressionClause: "scoping, sharing, and governing the same SharePoint agent step by step",
      scenarioLead: (name, audience) =>
        `You are building **${name}** on SharePoint sites and document libraries for ${audience}.`,
      sampleQuestionsHeading: "Questions the SharePoint agent should answer from scoped site content",
      validationLead: (questions) =>
        questions.map(
          (q) => `Ask your SharePoint agent "${q}" from a user account with expected library permissions and confirm the answer cites only approved SharePoint files.`,
        ),
      cleanupLead: (name) => [
        `In the SharePoint document library where you created **${name}**, delete or unshare the test \`.agent\` file if it was created only for this exercise.`,
      ],
      nextStepsExtension:
        "Extend this SharePoint agent by pairing it with SharePoint Advanced Management oversharing controls, autofill metadata columns on its source library, or Teams channel sharing.",
      closingTakeaway:
        "More importantly, you can now explain how SharePoint permissions, scoped sources, and site governance shape every answer a SharePoint agent gives.",
      llmNoun: "SharePoint agent",
    },
    [DELIVERABLE_MODES.SHAREPOINT_CONTENT_AI]: {
      mode,
      isAgent: false,
      kindLabel: "a SharePoint AI content intelligence configuration",
      actionVerb: "configuring",
      pastVerb: "configured",
      progressionNoun: "SharePoint content intelligence pipeline",
      overviewLead: (name) =>
        `In this lab you configure **${name}** in SharePoint document libraries`,
      subtitle: (name) =>
        `Configure ${name} across SharePoint document libraries with autofill columns and document processing, one grounded module at a time.`,
      progressionClause: "configuring SharePoint library metadata extraction, processing, and readiness step by step",
      scenarioLead: (name, audience) =>
        `You are configuring **${name}** in SharePoint document libraries serving ${audience}.`,
      sampleQuestionsHeading: "Content lookups and library questions your SharePoint AI metadata supports",
      validationLead: (questions) =>
        questions.map(
          (q) => `Upload or reprocess sample library files and verify the extracted SharePoint columns make questions such as "${q}" answerable directly from library views.`,
        ),
      cleanupLead: (name) => [
        `In your test SharePoint document library, remove any temporary autofill columns or test document-processing rules created for **${name}** if you do not plan to keep them.`,
      ],
      nextStepsExtension:
        "Extend this SharePoint AI pipeline by adding Restricted Content Discovery checks on sensitive sites, refining autofill prompts on additional libraries, or monitoring Copilot Credit consumption.",
      closingTakeaway:
        "More importantly, you can now explain how autofill columns, document processing models, and billing controls turn unstructured SharePoint libraries into structured business data.",
      llmNoun: "SharePoint content intelligence pipeline",
    },
    [DELIVERABLE_MODES.SHAREPOINT_GOVERNANCE]: {
      mode,
      isAgent: false,
      kindLabel: "a SharePoint Advanced Management governance plan",
      actionVerb: "configuring",
      pastVerb: "configured",
      progressionNoun: "SharePoint governance plan",
      overviewLead: (name) =>
        `In this lab you configure **${name}** in the SharePoint admin center`,
      subtitle: (name) =>
        `Enforce ${name} with SharePoint Advanced Management in the SharePoint admin center, one grounded module at a time.`,
      progressionClause: "layering SharePoint oversharing, access, lifecycle, and agent governance controls step by step",
      scenarioLead: (name, audience) =>
        `You are configuring **${name}** in the SharePoint admin center to govern content and AI access for ${audience}.`,
      sampleQuestionsHeading: "Employee lookups and site prompts governed by your SharePoint policies",
      validationLead: (questions) =>
        questions.map(
          (q) => `Verify in the SharePoint admin center that site discovery, access review, and agent policies govern how users retrieve answers to prompts such as "${q}".`,
        ),
      cleanupLead: (name) => [
        `In the SharePoint admin center, revert any temporary Restricted Content Discovery, Restricted Access Control, or test lifecycle rules applied to pilot sites for **${name}**.`,
      ],
      nextStepsExtension:
        "Extend this governance baseline by scheduling recurring data access governance reports, delegating site access reviews to site owners, and pairing SAM policies with Microsoft Purview labels.",
      closingTakeaway:
        "More importantly, you can now explain *why* SharePoint content governance is the foundation for safe Copilot and agent experiences across the tenant.",
      llmNoun: "SharePoint governance plan",
    },
    [DELIVERABLE_MODES.FOUNDRY_AGENT]: {
      mode,
      isAgent: true,
      kindLabel: "a Microsoft Foundry agent",
      actionVerb: "building",
      pastVerb: "built",
      progressionNoun: "Microsoft Foundry agent",
      overviewLead: (name) =>
        `In this lab you build and evaluate **${name}** in Microsoft Foundry`,
      subtitle: (name) =>
        `Build, evaluate, and operate ${name} in Microsoft Foundry, one grounded module at a time.`,
      progressionClause: "building, grounding, evaluating, and operating the same Microsoft Foundry agent step by step",
      scenarioLead: (name, audience) =>
        `You are building **${name}** in Microsoft Foundry for ${audience}.`,
      sampleQuestionsHeading: "Prompts the Microsoft Foundry agent should handle and pass in evaluation",
      validationLead: (questions) =>
        questions.map(
          (q) => `Run "${q}" in the Microsoft Foundry agent playground or evaluation dataset and verify groundedness, tool execution traces, and safety metrics.`,
        ),
      cleanupLead: (name) => [
        `In the Microsoft Foundry portal, delete the test agent **${name}**, any unused model deployments, and temporary Azure AI Search indices so they stop incurring Azure charges.`,
      ],
      nextStepsExtension:
        "Extend this Microsoft Foundry agent by expanding your evaluation dataset, tightening content safety guardrails, or monitoring live production traces and token costs.",
      closingTakeaway:
        "More importantly, you can now explain how projects, model deployments, grounding indices, traces, and evaluations work together in Microsoft Foundry.",
      llmNoun: "Microsoft Foundry agent",
    },
    [DELIVERABLE_MODES.FOUNDRY_MODELS_PLATFORM]: {
      mode,
      isAgent: false,
      kindLabel: "a governed Microsoft Foundry project and model workspace",
      actionVerb: "provisioning",
      pastVerb: "provisioned",
      progressionNoun: "Microsoft Foundry workspace",
      overviewLead: (name) =>
        `In this lab you provision **${name}** in Microsoft Foundry`,
      subtitle: (name) =>
        `Provision, deploy, and govern ${name} in Microsoft Foundry, one grounded module at a time.`,
      progressionClause: "provisioning, deploying, securing, and governing the same Microsoft Foundry workspace step by step",
      scenarioLead: (name, audience) =>
        `You are provisioning **${name}** in Microsoft Foundry to serve workloads for ${audience}.`,
      sampleQuestionsHeading: "Benchmark prompts to validate your deployed Microsoft Foundry model",
      validationLead: (questions) =>
        questions.map(
          (q) => `Test "${q}" against your deployed model in the Microsoft Foundry playground and confirm latency, safety guardrail filtering, quota usage, and RBAC boundaries.`,
        ),
      cleanupLead: (name) => [
        `In the Microsoft Foundry portal and Azure portal, delete any test model deployments, provisioned throughput reservations, or temporary Foundry projects created for **${name}** to stop ongoing Azure charges.`,
      ],
      nextStepsExtension:
        "Extend this Microsoft Foundry workspace by comparing candidate models side by side, setting Azure Monitor cost alerts, or building a grounded prompt agent on top of your deployment.",
      closingTakeaway:
        "More importantly, you can now explain how project isolation, model selection, regional quota, cost tracking, safety guardrails, and Azure RBAC fit together in Microsoft Foundry.",
      llmNoun: `Microsoft Foundry workspace (${shortProduct})`,
    },
  };

  return byMode[mode] || byMode[DELIVERABLE_MODES.COPILOT_STUDIO_AGENT];
}

/**
 * Build a product- and capability-accurate Mermaid architecture diagram block
 * for `## The Scenario` (`### Solution Architecture`).
 */
export function buildArchitectureBlock(plan, u) {
  const info = describeDeliverable(plan);
  const profile = plan.profile || {};
  const name = mermaidSafe(profile.agentName || "Solution");
  const audience = mermaidSafe(profile.audience || "Users", 56);
  const primarySource = mermaidSafe(profile.knowledgeSources?.[0] || "Enterprise data", 56);
  const secondarySource = mermaidSafe(profile.knowledgeSources?.[2] || profile.knowledgeSources?.[1] || "Business records", 56);
  const kpi = mermaidSafe(profile.kpi || "Operational outcome", 50);

  let lead = "";
  let diagram = [];

  switch (info.mode) {
    case DELIVERABLE_MODES.M365_COPILOT_GOVERNANCE:
      lead = `How **${u.esc(profile.agentName)}** governs Microsoft 365 Copilot access, data security, and adoption across your tenant:`;
      diagram = [
        "flowchart LR",
        `  Admin["IT and AI Admins"] --> Hub["M365 Admin Center Copilot Hub"]`,
        `  Hub --> Lic["Licenses and PAYG Billing"]`,
        `  Hub --> Reg["Agent Registry and Access Rules"]`,
        `  Purview["Microsoft Purview and SharePoint SAM"] --> Data["${primarySource}"]`,
        `  Lic --> Users["${audience}"]`,
        `  Reg --> Users`,
        `  Data --> Users`,
        `  Hub --> Metrics["Adoption Reports: ${kpi}"]`,
      ];
      break;

    case DELIVERABLE_MODES.DECLARATIVE_AGENT_GOVERNANCE:
      lead = `How **${u.esc(profile.agentName)}** governs declarative agent readiness, review, and tenant availability:`;
      diagram = [
        "flowchart LR",
        `  Makers["Agent Makers"] --> Submit["Declarative Agent Package"]`,
        `  Submit --> Admin["M365 Admin Center Agent Registry"]`,
        `  Conn["Copilot Connector Prerequisites"] --> Admin`,
        `  Admin --> Scope["Scoped User and Group Access"]`,
        `  Scope --> Users["${audience}"]`,
      ];
      break;

    case DELIVERABLE_MODES.POWER_PLATFORM_AI_BUILDER:
      lead = `How **${u.esc(profile.agentName)}** processes incoming content with AI Builder prompts, models, and Power Platform workflows:`;
      diagram = [
        "flowchart LR",
        `  Input["Incoming Docs and Requests"] --> Hub["Power Platform AI Hub"]`,
        `  Source["${primarySource}"] --> Hub`,
        `  Hub --> AI["AI Builder Prompts and Models"]`,
        `  AI --> Flow["Power Automate Cloud Flows and Power Fx"]`,
        `  Flow --> Data["${secondarySource}"]`,
        `  Flow --> Users["${audience}"]`,
      ];
      break;

    case DELIVERABLE_MODES.POWER_PLATFORM_AI_GOVERNANCE:
      lead = `How **${u.esc(profile.agentName)}** governs AI Builder capacity, security, monitoring, and ALM across environments:`;
      diagram = [
        "flowchart LR",
        `  Admin["Power Platform Admins"] --> PPAC["Power Platform Admin Center"]`,
        `  PPAC --> Credits["Copilot Credits and Capacity"]`,
        `  PPAC --> Sec["Environment Roles and Data Policies"]`,
        `  Sec --> AIHub["AI Builder Prompts and Models"]`,
        `  Credits --> AIHub`,
        `  AIHub --> ALM["Managed Solutions and Activity Logs"]`,
      ];
      break;

    case DELIVERABLE_MODES.SHAREPOINT_CONTENT_AI:
      lead = `How **${u.esc(profile.agentName)}** extracts structured metadata and processes files in SharePoint libraries:`;
      diagram = [
        "flowchart LR",
        `  Upload["Uploaded Library Documents"] --> Lib["${primarySource}"]`,
        `  Lib --> SPAI["SharePoint AI Autofill and Document Processing"]`,
        `  Credits["Copilot Credits Billing"] --> SPAI`,
        `  SPAI --> Cols["Structured Library Columns and Views"]`,
        `  Cols --> Users["${audience}"]`,
      ];
      break;

    case DELIVERABLE_MODES.SHAREPOINT_GOVERNANCE:
      lead = `How **${u.esc(profile.agentName)}** enforces oversharing, lifecycle, and agent access controls across SharePoint sites:`;
      diagram = [
        "flowchart LR",
        `  SPAdmin["SharePoint Admins"] --> SAM["SharePoint Advanced Management"]`,
        `  SAM --> Assess["DAG Oversharing and Access Reviews"]`,
        `  SAM --> Policy["RCD, RAC, and Site Lifecycle Policies"]`,
        `  Policy --> Sites["${primarySource}"]`,
        `  Sites --> Users["${audience}"]`,
      ];
      break;

    case DELIVERABLE_MODES.SHAREPOINT_AGENT:
      lead = `How **${u.esc(profile.agentName)}** grounds answers strictly in permission-trimmed SharePoint site content:`;
      diagram = [
        "flowchart LR",
        `  Users["${audience}"] --> Agent["${name}"]`,
        `  Agent --> Perms["SharePoint Permission Trimming"]`,
        `  Perms --> Lib["${primarySource}"]`,
        `  Admin["SharePoint Site and SAM Controls"] --> Lib`,
      ];
      break;

    case DELIVERABLE_MODES.DECLARATIVE_AGENT:
      lead = `How **${u.esc(profile.agentName)}** runs on the Microsoft 365 Copilot orchestrator with scoped grounding and actions:`;
      diagram = [
        "flowchart LR",
        `  Users["${audience}"] --> M365["Microsoft 365 Copilot Chat"]`,
        `  M365 --> Orch["M365 Copilot Orchestrator"]`,
        `  Orch --> Decl["${name}: Instructions and Capabilities"]`,
        `  Decl --> Know["${primarySource}"]`,
        `  Decl --> Act["Governed Plugins and Connectors"]`,
      ];
      break;

    case DELIVERABLE_MODES.FOUNDRY_MODELS_PLATFORM:
      lead = `How **${u.esc(profile.agentName)}** organizes models, guardrails, quota, and RBAC in Microsoft Foundry:`;
      diagram = [
        "flowchart LR",
        `  Team["${audience}"] --> Proj["${name}"]`,
        `  RBAC["Azure RBAC and Cost Budgets"] --> Proj`,
        `  Proj --> Cat["Foundry Model Catalog and Quota"]`,
        `  Cat --> Deploy["Model Deployment + Safety Guardrails"]`,
        `  Deploy --> Eval["Playground Benchmark: ${kpi}"]`,
      ];
      break;

    case DELIVERABLE_MODES.FOUNDRY_AGENT:
      lead = `How **${u.esc(profile.agentName)}** combines Microsoft Foundry model deployments, grounding, tools, and evaluation:`;
      diagram = [
        "flowchart LR",
        `  Users["${audience}"] --> FAgent["${name}"]`,
        `  FAgent --> Model["Deployed Foundry Model + Guardrails"]`,
        `  FAgent --> Search["${primarySource}"]`,
        `  FAgent --> Tools["Foundry Tools and Tracing"]`,
        `  Tools --> Eval["Evaluations and Monitoring"]`,
      ];
      break;

    case DELIVERABLE_MODES.COPILOT_STUDIO_AGENT:
    default:
      lead = `How **${u.esc(profile.agentName)}** connects channel users, orchestration, grounded knowledge, and enterprise actions:`;
      diagram = [
        "flowchart LR",
        `  Users["${audience}"] --> Chan["Teams and M365 Channels"]`,
        `  Chan --> Agent["${name}"]`,
        `  Agent --> Know["${primarySource}"]`,
        `  Agent --> Data["${secondarySource}"]`,
        `  Gov["Authentication, DLP, and Analytics"] --> Agent`,
      ];
      break;
  }

  return ["", "### Solution Architecture", "", lead, "", "```mermaid", ...diagram, "```"];
}

/**
 * Capability-specific, non-repetitive deterministic "In your scenario." passage
 * for one module (`featureSection` in `composer.js`).
 */
export function buildFeatureScenarioNote(feature, plan, u) {
  const info = describeDeliverable(plan);
  const profile = plan.profile || {};
  const idx = Math.max(0, (feature.order || 1) - 1);
  const name = `**${u.esc(profile.agentName)}**`;
  const audience = u.esc(profile.audience || "your target users");
  const domain = profile.domain || "this business workflow";
  const sources = profile.knowledgeSources?.length ? profile.knowledgeSources : ["your approved SharePoint library"];
  const source = u.lowerFirst(sources[idx % sources.length]);
  const questions = profile.sampleQuestions?.length ? profile.sampleQuestions : ["a representative user request"];
  const question = questions[idx % questions.length];
  const entities = profile.entities?.length ? profile.entities : profile.terms || ["record ID"];
  const entityList = entities.slice(0, 3).join(", ");
  const terms = (profile.terms || []).slice(0, 3).join(", ");
  const kpi = profile.kpi || "operational efficiency";
  const summaryClause = u.lowerFirst(String(feature.summary || feature.name).replace(/\.$/, ""));
  const cat = String(feature.category || "");
  const id = String(feature.id || "");

  if (info.mode === DELIVERABLE_MODES.M365_COPILOT_GOVERNANCE) {
    if (cat === "m365h-licensing" || /license|pay-as-you-go|payg|billing/.test(id)) {
      return `Apply this control in ${name} by scoping license or pay-as-you-go meter assignments to ${audience} first, then tracking seat utilization against *${kpi}* before expanding tenant-wide.`;
    }
    if (cat === "m365h-security" || /dlp|dspm|secure|audit|overshar|restricted-content|data-access|sensitivity/.test(id)) {
      return `For ${name}, focus this data-protection step on ${source} so sensitive ${domain} records (${entityList}) stay permission-trimmed when ${audience} prompt Copilot with questions like "${question}".`;
    }
    if (cat === "m365h-agents" || /agent-inventory|agent-availability|agent-lifecycle|agent-management|approve-agent/.test(id)) {
      return `In ${name}, use this registry control to review which agents can access ${domain} data, approve or block submissions affecting ${audience}, and record accountable owners for ${terms || domain} workflows.`;
    }
    if (cat === "m365h-analytics" || /adoption|usage|report|dashboard/.test(id)) {
      return `Use these adoption and usage signals inside ${name} to compare active Microsoft 365 Copilot usage among ${audience} against your target measure of success: *${kpi}*.`;
    }
    return `Configure this Microsoft 365 admin center setting as part of ${name}: ${summaryClause} for ${audience}, keeping governance aligned with ${source} and *${kpi}*.`;
  }

  if (info.mode === DELIVERABLE_MODES.POWER_PLATFORM_AI_BUILDER || info.mode === DELIVERABLE_MODES.POWER_PLATFORM_AI_GOVERNANCE) {
    if (cat === "prompts" || /prompt/.test(id)) {
      return `In ${name}, author this prompt for ${domain} using ${entityList} as structured inputs and keep domain terms (${terms}) explicit so ${audience} receive consistent outputs for requests like "${question}".`;
    }
    if (cat === "documents" || /document|receipt|invoice|extract/.test(id)) {
      return `Configure this extraction workflow in ${name} against sample files modeled on ${source}, mapping extracted fields (${entityList}) into structured columns so ${audience} stop re-keying records by hand.`;
    }
    if (cat === "models" || /sentiment|category|entity|prediction|key-phrase/.test(id)) {
      return `Apply this AI Builder model in ${name} to incoming ${domain} items (${entityList}) so records behind questions such as "${question}" are classified or scored automatically toward *${kpi}*.`;
    }
    if (cat === "apps-flows" || /flow|app|power-fx/.test(id)) {
      return `Wire this Power Platform integration into ${name} so ${audience} get automated updates from ${source} without switching tools, directly improving *${kpi}*.`;
    }
    return `Apply this AI Hub governance step to ${name}: ${summaryClause}, ensuring ${audience} run ${domain} automations within approved capacity and ALM boundaries.`;
  }

  if (info.mode === DELIVERABLE_MODES.SHAREPOINT_CONTENT_AI) {
    if (/autofill/.test(id)) {
      return `On ${source}, configure ${name} to populate SharePoint columns for ${entityList} automatically on upload, using ${terms} terminology so ${audience} can filter and sort without opening every file.`;
    }
    if (/document-processing/.test(id)) {
      return `Use this document processing rule in ${name} on ${source} to classify incoming ${domain} files and extract ${entityList}, cutting manual triage toward *${kpi}*.`;
    }
    return `Apply this SharePoint AI readiness step to ${name}: ${summaryClause} across ${source} so ${audience} can rely on consistent ${domain} metadata.`;
  }

  if (info.mode === DELIVERABLE_MODES.SHAREPOINT_GOVERNANCE || info.mode === DELIVERABLE_MODES.DECLARATIVE_AGENT_GOVERNANCE) {
    if (/restricted-content|restricted-access|assessment|access-review/.test(id)) {
      return `Target ${source} first as you build ${name}: verify whether ${domain} files containing ${entityList} are overshared before ${audience} query them through Copilot or SharePoint agents.`;
    }
    if (/lifecycle/.test(id)) {
      return `In ${name}, apply site lifecycle and ownership policies to inactive ${domain} sites so stale ${terms} documents do not pollute search or Copilot grounding for ${audience}.`;
    }
    return `Record this governance control in ${name}: ${summaryClause} for ${domain} sites serving ${audience}, tracking progress via *${kpi}*.`;
  }

  if (info.mode === DELIVERABLE_MODES.FOUNDRY_MODELS_PLATFORM) {
    if (/explore-model|deploy-test-model/.test(id)) {
      return `In ${name}, evaluate candidate models against ${domain} prompts such as "${question}" and verify accuracy on ${terms} terminology before committing capacity for ${audience}.`;
    }
    if (/quota|cost/.test(id)) {
      return `Size quota and cost thresholds in ${name} around expected ${domain} request volume from ${audience}, tying spend visibility directly to *${kpi}*.`;
    }
    if (/guardrail|rbac/.test(id)) {
      return `Enforce least-privilege roles and safety guardrails in ${name} so workloads touching ${source} (${entityList}) stay isolated and policy-compliant.`;
    }
    return `Configure this workspace foundation in ${name}: ${summaryClause} to support ${domain} workloads for ${audience}.`;
  }

  if (info.mode === DELIVERABLE_MODES.DECLARATIVE_AGENT) {
    if (/instructions|first-agent|templates/.test(id)) {
      return `Author ${name} for ${audience} on the Microsoft 365 Copilot orchestrator: ground its instructions in ${domain}, use ${terms} consistently, and define clear scope boundaries around requests like "${question}".`;
    }
    if (/knowledge|connector/.test(id)) {
      return `Scope ${name} to ${source} so Microsoft 365 Copilot grounds ${domain} answers in approved records (${entityList}) with permission-trimmed citations.`;
    }
    if (/plugin|mcp|skills|capabilities/.test(id)) {
      return `Extend ${name} with this capability or action so ${audience} can inspect or update ${entityList} directly from Microsoft 365 Copilot chat while tracking *${kpi}*.`;
    }
    return `Apply this step to ${name}: ${summaryClause} so ${audience} get reliable ${domain} support inside Microsoft 365 Copilot.`;
  }

  if (info.mode === DELIVERABLE_MODES.SHAREPOINT_AGENT) {
    return `Apply this step to ${name} on ${source}: ${summaryClause} so ${audience} get permission-trimmed answers on ${terms} questions such as "${question}".`;
  }

  if (info.mode === DELIVERABLE_MODES.FOUNDRY_AGENT) {
    if (/evaluate|trace|monitor/.test(id)) {
      return `Run this quality and observability check on ${name} using ${domain} test prompts like "${question}", verifying grounded citations from ${source} and tracking *${kpi}*.`;
    }
    return `Configure this capability on ${name} in Microsoft Foundry: ${summaryClause} over ${source} (${entityList}) so ${audience} receive traceable ${domain} results.`;
  }

  // Default: copilot-studio-agent — varied by capability category so multi-module labs never repeat one rigid paragraph.
  if (cat === "knowledge") {
    return `Connect ${source} to ${name} so answers about ${entityList} are grounded in approved ${domain} content with citations when ${audience} ask "${question}".`;
  }
  if (cat === "tools" || cat === "automation" || cat === "integrations") {
    return `Wire this action into ${name} using fields such as ${entityList} so ${audience} can complete ${domain} tasks end to end, directly improving *${kpi}*.`;
  }
  if (cat === "governance" || cat === "security" || cat === "alm" || /auth|dlp|alm|inventory/.test(id)) {
    return `Apply this control to ${name} so ${domain} records (${entityList}) stay authenticated, auditable, and policy-compliant for ${audience}.`;
  }
  if (cat === "analytics" || cat === "testing" || /test|eval|analytics/.test(id)) {
    return `Exercise ${name} with ${domain} prompts such as "${question}" and measure quality and deflection against *${kpi}*.`;
  }
  return `Do this for ${name}: ${summaryClause}, grounded in the ${domain} content from **The Scenario** (${source}) and keeping terminology consistent (${terms}) for ${audience}.`;
}
