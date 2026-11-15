/**
 * Dynamic Connectors, Environment, and Tenant Prerequisites builder.
 *
 * Inspects a lab's actual products, harness, and selected modules to produce an
 * accurate pre-flight checklist of:
 *   1. Connectors and endpoints to allow
 *   2. DLP, Agent Control Plane (ACP), and Managed Environment governance rules
 *   3. Power Platform / product environment and feature toggles (Dataverse
 *      storage, Code apps, PCF components, Generative AI, Code Interpreter,
 *      Computer Use, ALM solutions, Voice/Contact Center)
 *   4. Tenant, identity, and cloud administrator prerequisites (Entra ID app
 *      registrations, Agent Identities, M365 Copilot / Agent 365 roles, Purview
 *      DLP/DSPM, SharePoint admin/SAM, Azure & Microsoft Foundry RBAC/quota)
 *
 * Pure and dependency-free (zero npm packages) so `tools/lab-builder/build.mjs`
 * runs offline in bare Node before `npm ci`.
 */

import { getFeature, getHarnesses } from "./catalog.js";
import { DEFAULT_PRODUCT, productOf, productsPhrase } from "./products.js";

function normalizeModules(input = {}) {
  if (Array.isArray(input.features) && input.features.length) {
    return input.features.map((f, idx) => {
      const catalogFeature = getFeature(f.id) || {};
      return {
        ...catalogFeature,
        ...f,
        id: f.id,
        name: f.name || catalogFeature.name || f.id,
        order: Number(f.order) || idx + 1,
        product: f.product || productOf(f) || DEFAULT_PRODUCT,
        category: f.category || catalogFeature.category || "foundations",
      };
    });
  }

  const manifestModules = input.manifest?.modules;
  if (Array.isArray(manifestModules) && manifestModules.length) {
    return manifestModules.map((m, idx) => {
      const catalogFeature = getFeature(m.id) || {};
      return {
        ...catalogFeature,
        ...m,
        id: m.id,
        name: m.name || catalogFeature.name || m.id,
        order: Number(m.order) || idx + 1,
        product: m.product || catalogFeature.product || DEFAULT_PRODUCT,
        category: m.category || catalogFeature.category || "foundations",
      };
    });
  }

  // Fallback for legacy generated labs that only have index.md on disk.
  const markdown = String(input.markdown || "");
  if (markdown) {
    const matches = [...markdown.matchAll(/^###\s+(Step|Recap)\s+(\d+)\s+[—–-]\s+(.+?)\s*$/gim)];
    return matches.map((match, idx) => {
      const kind = match[1].toLowerCase();
      const num = Number(match[2]);
      const rawTitle = match[3].trim();
      const isRecap = kind === "recap" || /^recap:\s+/i.test(rawTitle);
      const rawName = rawTitle.replace(/^recap:\s+/i, "").replace(/\s*\(Recap\)\s*$/i, "").trim();
      return {
        id: `${isRecap ? "recap" : "step"}-${num}`,
        name: rawName,
        order: idx + 1,
        stepOrder: isRecap ? null : num,
        recapOrder: isRecap ? num : null,
        stepLabel: isRecap ? `Recap ${num}` : `Step ${num}`,
        prerequisite: isRecap,
        role: isRecap ? "prerequisite" : "level",
        product: input.manifest?.product || DEFAULT_PRODUCT,
        category: "foundations",
      };
    });
  }

  return [];
}

function stepLabel(mod) {
  if (mod.stepLabel) return `${mod.stepLabel} - ${mod.name}`;
  if (mod.prerequisite || mod.role === "prerequisite") {
    return `Recap ${mod.recapOrder ?? mod.order} - ${mod.name}`;
  }
  return `Step ${mod.stepOrder ?? mod.order} - ${mod.name}`;
}

function uniqueLabels(mods) {
  const seen = new Set();
  const out = [];
  for (const mod of mods) {
    const label = typeof mod === "string" ? mod : stepLabel(mod);
    if (!seen.has(label)) {
      seen.add(label);
      out.push(label);
    }
  }
  return out;
}

function matchModules(modules, predicate) {
  return modules.filter((mod) => predicate(mod));
}

function hasId(SetOrIds, mod, ids) {
  return ids.includes(mod.id);
}

/**
 * Derive structured administrator prerequisites from a plan or `{ manifest, markdown }`.
 *
 * @param {object} input `plan` at compose time, or `{ manifest, markdown }` on read/export
 * @returns {object} JSON-serializable prerequisites model
 */
export function buildAdminPrerequisites(input = {}) {
  const modules = normalizeModules(input);
  const rawProducts =
    (Array.isArray(input.products) && input.products.length && input.products) ||
    (Array.isArray(input.manifest?.products) && input.manifest.products.length && input.manifest.products) ||
    (input.manifest?.product ? [input.manifest.product] : null) ||
    [...new Set(modules.map((m) => m.product).filter(Boolean))];
  const products = rawProducts.length ? rawProducts : [DEFAULT_PRODUCT];

  const harness =
    input.harness ||
    input.request?.harness ||
    input.manifest?.request?.harness ||
    input.manifest?.differences?.labHarness ||
    (products.includes("copilot-studio") ? "standard" : null);

  const harnessInfo = harness ? getHarnesses().find((h) => h.id === harness) : null;

  const hasProduct = (id) => products.includes(id) || modules.some((m) => m.product === id);
  const hasPowerPlatform = hasProduct("copilot-studio") || hasProduct("power-platform-ai-hub");
  const hasCopilotStudio = hasProduct("copilot-studio");
  const hasAiHub = hasProduct("power-platform-ai-hub");
  const hasAgentBuilder = hasProduct("m365-copilot-agent-builder");
  const hasSharePointProduct = hasProduct("sharepoint-ai");
  const hasFoundry = hasProduct("ai-foundry");
  const hasM365Hub = hasProduct("m365-copilot-hub");

  const connectors = [];
  const dlpAndAcp = [];
  const environmentSettings = [];
  const tenantAndCloud = [];

  const addConnector = (entry, matchingMods) => {
    if (!matchingMods.length) return;
    connectors.push({
      ...entry,
      requiredBy: uniqueLabels(matchingMods),
    });
  };

  const addItem = (target, entry, matchingMods) => {
    if (!matchingMods.length) return;
    target.push({
      ...entry,
      requiredBy: uniqueLabels(matchingMods),
    });
  };

  // ── 1. Connectors & Endpoints to Allow ───────────────────────────────────

  const dataverseMods = matchModules(
    modules,
    (m) =>
      hasId(null, m, [
        "knowledge-dataverse",
        "alm-solutions",
        "prompt-tools",
        "agent-flows",
        "autonomous-triggers",
        "variables-entities",
      ]) ||
      m.product === "power-platform-ai-hub" ||
      m.product === "copilot-studio" ||
      /\bdataverse\b/i.test(m.name),
  );
  addConnector(
    {
      id: "microsoft-dataverse",
      name: "Microsoft Dataverse",
      classification: "Standard / Core Platform",
      dataGroup: "Business",
      adminPath: "Power Platform admin center > Policies > Data policies",
      details:
        "Required for storing solution components, agent definitions, knowledge tables, conversation transcripts, and AI Builder prompt or model metadata.",
      endpoints: ["*.crm.dynamics.com"],
    },
    dataverseMods,
  );

  const sharePointMods = matchModules(
    modules,
    (m) =>
      hasId(null, m, [
        "knowledge-sharepoint",
        "dca-create-agent-builder",
        "dca-knowledge-sharepoint-onedrive",
        "mc-knowledge-enterprise",
        "ppai-document-processing-model",
      ]) ||
      m.product === "sharepoint-ai" ||
      /\bsharepoint|onedrive\b/i.test(m.name),
  );
  addConnector(
    {
      id: "sharepoint",
      name: "SharePoint (and OneDrive for Business)",
      classification: "Standard",
      dataGroup: "Business",
      adminPath: "Power Platform admin center > Policies > Data policies",
      details:
        "Allow SharePoint read/search actions in the Business DLP group so delegated user identity or site-scoped grounding can retrieve library items.",
      endpoints: ["*.sharepoint.com"],
    },
    sharePointMods,
  );

  const m365CollabMods = matchModules(
    modules,
    (m) =>
      hasId(null, m, [
        "channel-teams",
        "autonomous-triggers",
        "human-in-the-loop",
        "agent-flows",
        "dca-workflows-agent",
        "mc-publish-m365-channels",
        "mc-knowledge-enterprise",
        "cc-handoff-human",
        "ppai-summarize-emails-teams",
      ]) ||
      harness === "microsoft-copilot" ||
      /\bteams|outlook|email\b/i.test(m.name),
  );
  addConnector(
    {
      id: "office365-teams-outlook",
      name: "Microsoft Teams, Office 365 Outlook, and Office 365 Users",
      classification: "Standard",
      dataGroup: "Business",
      adminPath: "Power Platform admin center > Policies > Data policies",
      details:
        "Place Microsoft Teams, Office 365 Outlook, and Office 365 Users in the same Business DLP group as Dataverse and SharePoint so triggers, notifications, and profile lookups succeed.",
      endpoints: ["graph.microsoft.com", "outlook.office365.com"],
    },
    m365CollabMods,
  );

  const approvalsMods = matchModules(modules, (m) =>
    hasId(null, m, [
      "human-in-the-loop",
      "ppai-ai-approvals",
      "sp-ai-page-approval-flow",
      "dca-workflows-agent",
    ]) || /\bapproval|human-in-the-loop\b/i.test(m.name),
  );
  addConnector(
    {
      id: "approvals",
      name: "Approvals",
      classification: "Standard",
      dataGroup: "Business",
      adminPath: "Power Platform admin center > Policies > Data policies",
      details:
        "Ensure the Approvals connector is provisioned in the environment and placed in the Business DLP group alongside Dataverse and Microsoft Teams.",
      endpoints: [],
    },
    approvalsMods,
  );

  const flowMods = matchModules(modules, (m) =>
    hasId(null, m, [
      "agent-flows",
      "autonomous-triggers",
      "human-in-the-loop",
      "ppai-use-prompt-in-flow-and-app",
      "ppai-ai-approvals",
      "sp-ai-metadata-autofill",
      "sp-ai-content-assembly",
      "sp-ai-page-approval-flow",
      "dca-workflows-agent",
    ]) || /\bflows?\b/i.test(m.name),
  );
  addConnector(
    {
      id: "power-automate-agent-flows",
      name: "Power Automate Management / Agent Flows Runtime",
      classification: "Standard",
      dataGroup: "Business",
      adminPath: "Power Platform admin center > Policies > Data policies",
      details:
        "Allow cloud flow and agent flow triggers/actions in the environment's DLP policy and verify cloud flow creation is not disabled for makers.",
      endpoints: ["api.flow.microsoft.com"],
    },
    flowMods,
  );

  const genericConnectorMods = matchModules(modules, (m) =>
    hasId(null, m, ["connector-tools", "mc-tools-connectors"]),
  );
  addConnector(
    {
      id: "prebuilt-power-platform-connectors",
      name: "Prebuilt Power Platform Connectors (HTTP with Microsoft Entra ID / MSN Weather / SQL)",
      classification: "Standard / Premium",
      dataGroup: "Business",
      adminPath: "Power Platform admin center > Policies > Data policies",
      details:
        "Ensure the prebuilt connector used in the tool action (such as MSN Weather for no-auth testing or HTTP with Microsoft Entra ID for internal APIs) is placed in the Business DLP group.",
      endpoints: [],
    },
    genericConnectorMods,
  );

  const customConnectorMods = matchModules(modules, (m) =>
    hasId(null, m, [
      "custom-connectors",
      "dca-api-plugins",
      "dca-toolkit-api-plugin-typespec",
      "dca-toolkit-typespec-agent",
      "fdy-toolbox-tools",
      "fnd-agent-mcp-openapi-tools",
    ]) || /\bcustom connector|openapi|api plugin\b/i.test(m.name),
  );
  addConnector(
    {
      id: "custom-connectors-openapi",
      name: "Custom Connectors (OpenAPI / REST API Host)",
      classification: "Custom / Premium",
      dataGroup: "Business",
      adminPath: "Power Platform admin center > Policies > Data policies > Custom connector patterns",
      details:
        "Allow Custom Connectors in the Business DLP group and add an explicit host URL pattern rule (for example https://api.contoso.com/*) above any catch-all Deny rule.",
      endpoints: ["https://<your-api-host>/*"],
    },
    customConnectorMods,
  );

  const mcpMods = matchModules(modules, (m) =>
    hasId(null, m, [
      "mcp-servers",
      "mc-tools-mcp",
      "cc-mcp-server",
      "dca-toolkit-mcp-plugin",
      "fnd-agent-mcp-openapi-tools",
    ]) || /\bmcp\b|model context protocol/i.test(m.name),
  );
  addConnector(
    {
      id: "mcp-server-endpoints",
      name: "Model Context Protocol (MCP) Server Endpoint",
      classification: "MCP / Custom Endpoint",
      dataGroup: "Business",
      adminPath: "Power Platform admin center > Policies > Data policies > Connector endpoint filtering",
      details:
        "Allow outbound HTTPS Streamable HTTP / SSE traffic to your MCP server host in DLP connector endpoint filtering and network firewall rules.",
      endpoints: ["https://<your-mcp-server-host>/mcp"],
    },
    mcpMods,
  );

  const graphConnectorMods = matchModules(modules, (m) =>
    hasId(null, m, [
      "knowledge-graph-connectors",
      "dca-copilot-connectors-knowledge",
      "m365h-copilot-connectors",
    ]) || /\bcopilot connectors?|graph connectors?\b/i.test(m.name),
  );
  addConnector(
    {
      id: "microsoft-copilot-graph-connectors",
      name: "Microsoft 365 Copilot Connectors (Microsoft Graph Connectors)",
      classification: "Enterprise Search Connection",
      dataGroup: "Business",
      adminPath: "Microsoft 365 admin center > Search & intelligence > Data sources",
      details:
        "Confirm the target Graph / Copilot connector connection is in the Ready state, indexed items carry ACL permissions for test learners, and external item results are enabled.",
      endpoints: ["graph.microsoft.com/v1.0/external/connections/*"],
    },
    graphConnectorMods,
  );

  const vendorSpecs = [
    {
      featureId: "servicenow-integration",
      id: "servicenow",
      name: "ServiceNow",
      classification: "Premium Enterprise Connector",
      endpoints: ["https://<instance>.service-now.com/*"],
      details:
        "Allow the ServiceNow connector in the Business DLP group and configure OAuth 2.0 client credentials or Entra SSO against a ServiceNow developer/sandbox instance.",
    },
    {
      featureId: "snowflake-integration",
      id: "snowflake",
      name: "Snowflake",
      classification: "Premium Enterprise Connector",
      endpoints: ["https://<account>.snowflakecomputing.com/*"],
      details:
        "Allow the Snowflake connector in the Business DLP group, configure External OAuth with Microsoft Entra ID, and assign a default warehouse and role to test users.",
    },
    {
      featureId: "sap-integration",
      name: "SAP ERP / SAP OData",
      id: "sap-erp-odata",
      classification: "Premium Enterprise Connector",
      endpoints: ["https://<sap-gateway-host>/sap/opu/odata/*"],
      details:
        "Allow SAP ERP and SAP OData connectors in the Business DLP group, verify SAP Gateway OData service activation, and configure Principal Propagation or On-Premises Data Gateway if private.",
    },
    {
      featureId: "salesforce-integration",
      id: "salesforce",
      name: "Salesforce",
      classification: "Premium Enterprise Connector",
      endpoints: ["https://*.my.salesforce.com/*"],
      details:
        "Allow the Salesforce connector in the Business DLP group and enable a Salesforce External Client App / Connected App with OAuth `api` and `refresh_token` scopes.",
    },
    {
      featureId: "jira-integration",
      id: "jira",
      name: "Jira",
      classification: "Premium Enterprise Connector",
      endpoints: ["https://api.atlassian.com/*", "https://*.atlassian.net/*"],
      details:
        "Allow the Jira connector in the Business DLP group and configure Atlassian Cloud OAuth 2.0 (3LO) or scoped API tokens for a non-production project.",
    },
    {
      featureId: "epic-fhir-integration",
      id: "epic-fhir",
      name: "Epic FHIRlink / HL7 FHIR",
      classification: "Premium Healthcare Connector",
      endpoints: ["https://fhir.epic.com/*"],
      details:
        "Allow FHIRlink / custom SMART-on-FHIR connectors in the Business DLP group and register a non-production Epic on FHIR application using synthetic patient data only.",
    },
    {
      featureId: "shopify-integration",
      id: "shopify",
      name: "Shopify (GraphQL Admin / Storefront Custom Connector)",
      classification: "Custom / Premium Connector",
      endpoints: ["https://*.myshopify.com/admin/api/*"],
      details:
        "Allow Custom Connectors and HTTP with Microsoft Entra ID in the Business DLP group and allowlist your Shopify development store domain.",
    },
  ];

  for (const vendor of vendorSpecs) {
    const mods = matchModules(modules, (m) => m.id === vendor.featureId);
    addConnector(
      {
        id: vendor.id,
        name: vendor.name,
        classification: vendor.classification,
        dataGroup: "Business",
        adminPath: "Power Platform admin center > Policies > Data policies",
        details: vendor.details,
        endpoints: vendor.endpoints,
      },
      mods,
    );
  }

  const gatewayMods = matchModules(modules, (m) =>
    hasId(null, m, ["on-prem-data-gateway", "sap-integration"]),
  );
  addConnector(
    {
      id: "on-premises-data-gateway",
      name: "On-Premises Data Gateway",
      classification: "Hybrid Connectivity",
      dataGroup: "Business",
      adminPath: "Power Platform admin center > Data > On-premises data gateways",
      details:
        "Install and register an On-Premises Data Gateway cluster in the same region as the target Power Platform environment and grant makers Can use (+ Can share where needed) gateway permissions.",
      endpoints: ["Outbound TCP 443 to *.servicebus.windows.net"],
    },
    gatewayMods,
  );

  const foundrySearchMods = matchModules(
    modules,
    (m) =>
      hasId(null, m, [
        "fnd-azure-ai-search-rag",
        "fnd-agent-file-search-code-interpreter",
        "fnd-create-agent",
      ]) || m.product === "ai-foundry",
  );
  addConnector(
    {
      id: "foundry-project-connections",
      name: "Microsoft Foundry Project Connections (Azure OpenAI / Azure AI Search / Azure Blob Storage)",
      classification: "Azure Resource Connection",
      dataGroup: "Foundry Project Scope",
      adminPath: "Microsoft Foundry portal > Management center > Connected resources",
      details:
        "Ensure connected Azure AI Search, Azure Storage, and model deployment endpoints are attached to the Foundry project with Microsoft Entra ID (keyless RBAC) authentication enabled.",
      endpoints: ["*.openai.azure.com", "*.services.ai.azure.com", "*.search.windows.net"],
    },
    foundrySearchMods,
  );

  // ── 2. DLP, Agent Control Plane (ACP), and Governance Policies ───────────

  if (hasPowerPlatform || connectors.some((c) => c.dataGroup === "Business")) {
    const ppMods = modules.filter(
      (m) => m.product === "copilot-studio" || m.product === "power-platform-ai-hub",
    );
    const activeConnectorNames = connectors
      .filter((c) => c.dataGroup === "Business")
      .map((c) => c.name);
    addItem(
      dlpAndAcp,
      {
        id: "dlp-business-group-alignment",
        title: "DLP Policy: Co-locate Lab Connectors in the Business Data Group",
        adminPath: "Power Platform admin center > Policies > Data policies",
        status: "Required",
        details: `Assign ${
          activeConnectorNames.length ? activeConnectorNames.join(", ") : "all required lab connectors"
        } to the Business data group in every tenant-level and environment-level DLP policy targeting the lab environment, and confirm none are in Blocked.`,
      },
      ppMods.length ? ppMods : modules,
    );
  }

  const endpointFilterMods = matchModules(modules, (m) =>
    hasId(null, m, [
      "custom-connectors",
      "mcp-servers",
      "mc-tools-mcp",
      "cc-mcp-server",
      "dca-toolkit-mcp-plugin",
      "dca-api-plugins",
      "knowledge-public-websites",
      "servicenow-integration",
      "snowflake-integration",
      "sap-integration",
      "salesforce-integration",
      "jira-integration",
      "epic-fhir-integration",
      "shopify-integration",
    ]),
  );
  addItem(
    dlpAndAcp,
    {
      id: "dlp-endpoint-filtering",
      title: "DLP Connector Endpoint Filtering & Custom Host Allowlist",
      adminPath: "Power Platform admin center > Policies > Data policies > Connector endpoint filtering",
      status: "Required",
      details:
        "If tenant DLP policies enforce HTTP, Custom Connector, MCP, or public website endpoint filtering, add explicit Allow rules ordered above the default `*` Deny rule for every external host used in this lab.",
    },
    endpointFilterMods,
  );

  const acpMods = matchModules(
    modules,
    (m) =>
      m.product === "copilot-studio" ||
      hasId(null, m, [
        "dlp-governance",
        "publish-agent",
        "channel-teams",
        "channel-web-sdk",
        "agent-inventory",
        "entra-agent-identities",
        "autonomous-triggers",
        "connected-agents",
        "agent-to-agent",
        "m365h-agent-registry",
      ]),
  );
  addItem(
    dlpAndAcp,
    {
      id: "acp-managed-environment-policies",
      title: "Agent Control Plane (ACP) and Managed Environment Governance",
      adminPath: "Power Platform admin center > Manage > Environments > Edit Managed Environments & Copilot > Governance",
      status: modules.some((m) =>
        hasId(null, m, ["dlp-governance", "agent-inventory", "entra-agent-identities", "m365h-agent-registry"]),
      )
        ? "Required"
        : "Required if Enforced in Tenant",
      details:
        "Verify Managed Environment / Agent Control Plane (ACP) sharing and publishing rules permit makers in the lab environment to create, test, share, and publish agents to the selected channels without blocking unapproved connectors or autonomous triggers.",
    },
    acpMods,
  );

  const authChannelPolicyMods = matchModules(modules, (m) =>
    hasId(null, m, [
      "authentication",
      "cc-authentication",
      "cc-biometric-auth",
      "publish-agent",
      "channel-teams",
      "channel-web-sdk",
      "mc-publish-m365-channels",
    ]),
  );
  addItem(
    dlpAndAcp,
    {
      id: "dlp-auth-and-channel-rules",
      title: "Authentication Enforcement and Channel Publishing DLP Rules",
      adminPath: "Power Platform admin center > Policies > Data policies (Copilot Studio authentication & channel connectors)",
      status: "Required",
      details:
        "Confirm Copilot Studio DLP connectors (such as Authenticate with Microsoft, Direct Line / Web channel, Microsoft Teams channel, and Knowledge sources with authentication) are not blocked unless a module explicitly tests blocking them.",
    },
    authChannelPolicyMods,
  );

  // ── 3. Environment and Feature Settings ──────────────────────────────────

  if (hasPowerPlatform) {
    const ppMods = modules.filter(
      (m) => m.product === "copilot-studio" || m.product === "power-platform-ai-hub",
    );
    const needsExtraFileStorage = modules.some((m) =>
      hasId(null, m, ["knowledge-files", "mc-knowledge-files", "alm-solutions", "ppai-document-processing-model"]),
    );
    addItem(
      environmentSettings,
      {
        id: "dataverse-database-and-storage",
        title: "Dataverse Database Provisioned with Available Storage Capacity",
        adminPath: "Power Platform admin center > Manage > Environments > [Environment] > Resources > Capacity",
        status: "Required",
        details: `Target environment must have an active Microsoft Dataverse database and at least 1 GB of free Database and File storage capacity${
          needsExtraFileStorage
            ? " (file capacity is actively consumed by uploaded knowledge documents, AI Builder training files, and solution packages)"
            : " (tenant Dataverse capacity overages block creating or publishing new agents and flows)"
        }.`,
      },
      ppMods,
    );
  }

  const codeAppsAndPcfMods = matchModules(modules, (m) =>
    hasId(null, m, [
      "channel-web-sdk",
      "mc-sdk-agent",
      "adaptive-cards",
      "power-fx",
      "ppai-use-prompt-in-flow-and-app",
      "ppai-powerfx-ai-models-in-canvas-app",
      "dca-agents-toolkit-vscode",
      "dca-toolkit-typespec-agent",
      "dca-toolkit-api-plugin-typespec",
      "fdy-deploy-hosted-agent",
      "alm-solutions",
    ]),
  );
  if (codeAppsAndPcfMods.length || hasPowerPlatform) {
    const strictlyRequired = codeAppsAndPcfMods.some((m) => m.id !== "alm-solutions");
    addItem(
      environmentSettings,
      {
        id: "code-apps-and-pcf-components",
        title: "Enable Power Apps Component Framework (PCF) for Canvas Apps and Code Apps",
        adminPath: "Power Platform admin center > Manage > Environments > [Environment] > Settings > Product > Features",
        status: strictlyRequired
          ? "Required"
          : codeAppsAndPcfMods.length
          ? "Required if Solution Contains Custom UI / PCF"
          : "Verify if Embedding Custom UI or PCF Controls",
        details: strictlyRequired
          ? "Turn ON 'Power Apps component framework for canvas apps' and enable 'Code apps' in the environment's Product > Features settings so custom canvas components, embedded agent SDK hosts, Adaptive Card / Power Fx app surfaces, and code-first UI packages can publish and render."
          : "If learners embed the agent in a custom canvas app, import solutions containing PCF controls, or deploy Power Apps Code apps alongside this lab, turn ON 'Power Apps component framework for canvas apps' and 'Code apps' under Settings > Product > Features.",
      },
      codeAppsAndPcfMods.length
        ? codeAppsAndPcfMods
        : modules.filter((m) => m.product === "copilot-studio" || m.product === "power-platform-ai-hub"),
    );
  }

  const genAiMods = matchModules(
    modules,
    (m) =>
      hasId(null, m, [
        "generative-orchestration",
        "knowledge-public-websites",
        "connected-agents",
        "agent-to-agent",
        "deep-reasoning-models",
        "prompt-tools",
        "evaluations",
        "autonomous-triggers",
      ]) ||
      m.product === "copilot-studio" ||
      m.product === "power-platform-ai-hub",
  );
  if (genAiMods.length && hasPowerPlatform) {
    addItem(
      environmentSettings,
      {
        id: "generative-ai-and-region-movement",
        title: "Generative AI Features, Generative Orchestration, and Cross-Geo Data Movement",
        adminPath: "Power Platform admin center > Manage > Environments > [Environment] > Generative AI features",
        status: "Required",
        details:
          "Enable 'Move data across regions' (when the environment region relies on cross-geo Azure OpenAI capacity) and 'Bing Search / Public website search' so generative orchestration, prompt tools, and web grounding are selectable.",
      },
      genAiMods,
    );
  }

  const aiCreditsMods = matchModules(
    modules,
    (m) =>
      m.product === "power-platform-ai-hub" ||
      hasId(null, m, [
        "prompt-tools",
        "deep-reasoning-models",
        "autonomous-triggers",
        "evaluations",
        "computer-use",
      ]),
  );
  addItem(
    environmentSettings,
    {
      id: "copilot-credits-ai-builder-capacity",
      title: "Copilot Credits / AI Builder Capacity Allocated to the Environment",
      adminPath: "Power Platform admin center > Resources > Capacity > Copilot Studio / AI Builder",
      status: "Required",
      details:
        "Allocate Prepaid Copilot Credits, Pay-As-You-Go billing, or AI Builder add-on credits to the target environment so prompt execution, custom models, and autonomous runs are not throttled.",
    },
    aiCreditsMods,
  );

  const codeInterpreterMods = matchModules(modules, (m) =>
    hasId(null, m, [
      "ppai-code-interpreter-prompts",
      "mc-created-files",
      "fnd-agent-file-search-code-interpreter",
    ]),
  );
  addItem(
    environmentSettings,
    {
      id: "code-interpreter-python-execution",
      title: "Code Interpreter (Sandboxed Python Execution) Enabled",
      adminPath: hasFoundry && !hasPowerPlatform
        ? "Microsoft Foundry portal > Agents > Tool configuration (Code Interpreter)"
        : "Power Platform admin center > Manage > Environments > [Environment] > Settings > Features > Code interpreter",
      status: "Required",
      details:
        "Enable Code Interpreter in the environment or agent runtime settings so Python data analysis, chart generation, and structured file output (CSV/XLSX/DOCX/PDF) are permitted.",
    },
    codeInterpreterMods,
  );

  const computerUseMods = matchModules(modules, (m) => m.id === "computer-use");
  addItem(
    environmentSettings,
    {
      id: "computer-use-toggle",
      title: "Computer Use Preview / Hosted Browser or Machine Group Provisioned",
      adminPath: "Power Platform admin center > Manage > Environments > [Environment] > Generative AI features",
      status: "Required",
      details:
        "Enable Computer Use in a supported US/preview environment and provision either a Hosted Browser capacity pool or a registered Windows desktop machine group for UI automation.",
    },
    computerUseMods,
  );

  const almMods = matchModules(modules, (m) =>
    hasId(null, m, ["alm-solutions", "custom-connectors", "knowledge-dataverse"]),
  );
  addItem(
    environmentSettings,
    {
      id: "alm-and-security-roles",
      title: "Environment Maker / System Customizer Security Roles and Solution Publisher",
      adminPath: "Power Platform admin center > Manage > Environments > [Environment] > Settings > Users + permissions > Security roles",
      status: "Required",
      details:
        "Assign learners at least Environment Maker (and System Customizer when creating custom Dataverse tables, connection references, environment variables, or custom connectors inside Dataverse solutions).",
    },
    almMods.length
      ? almMods
      : hasPowerPlatform
      ? modules.filter((m) => m.product === "copilot-studio" || m.product === "power-platform-ai-hub")
      : [],
  );

  const voiceMods = matchModules(
    modules,
    (m) =>
      harness === "customer-conversation" ||
      hasId(null, m, [
        "voice-agents",
        "cc-voice-dtmf-bargein",
        "cc-handoff-human",
        "cc-authentication",
        "cc-biometric-auth",
        "cc-mcp-server",
      ]),
  );
  addItem(
    environmentSettings,
    {
      id: "voice-contact-center-environment",
      title: "Dynamics 365 Contact Center / Voice Channel and Azure Communication Services",
      adminPath: "Copilot Service admin center > Channels > Voice & Azure Communication Services",
      status: "Required",
      details:
        "Provision Dynamics 365 Contact Center (or Customer Service omnichannel voice), link an Azure Communication Services resource with an active phone number or voice test client, and install the Copilot Studio telephony extension solutions.",
    },
    voiceMods,
  );

  const vnetMods = matchModules(modules, (m) => m.id === "vnet-private-connectivity");
  addItem(
    environmentSettings,
    {
      id: "vnet-enterprise-policy",
      title: "Azure Virtual Network Subnet Injection and Power Platform Enterprise Policy",
      adminPath: "Azure portal + Power Platform admin center > Policies > Enterprise policies",
      status: "Required",
      details:
        "Delegate primary and failover Azure VNet subnets to `Microsoft.PowerPlatform/enterprisePolicies` and link the VNet enterprise policy to a Managed Environment before testing private endpoints.",
    },
    vnetMods,
  );

  // ── 4. Tenant, Identity, and Cloud Admin Prerequisites ───────────────────

  const entraAppMods = matchModules(modules, (m) =>
    hasId(null, m, [
      "authentication",
      "cc-authentication",
      "cc-biometric-auth",
      "channel-web-sdk",
      "custom-connectors",
      "mcp-servers",
      "mc-sdk-agent",
      "dca-api-plugins",
      "servicenow-integration",
      "snowflake-integration",
      "salesforce-integration",
    ]),
  );
  addItem(
    tenantAndCloud,
    {
      id: "entra-app-registration-sso",
      title: "Microsoft Entra ID App Registration and Delegated API Consent",
      adminPath: "Microsoft Entra admin center > Identity > Applications > App registrations",
      status: "Required",
      details:
        "Grant Application Developer (or Cloud Application Administrator) permissions to register client/API apps, configure redirect URIs, expose custom scopes (`api://...`), and grant admin consent for OAuth 2.0 / SSO flows.",
    },
    entraAppMods,
  );

  const agentIdentityMods = matchModules(modules, (m) =>
    hasId(null, m, ["entra-agent-identities", "agent-inventory", "m365h-agent-registry"]),
  );
  addItem(
    tenantAndCloud,
    {
      id: "entra-agent-identities",
      title: "Microsoft Entra Agent ID / Workload Identity Governance",
      adminPath: "Microsoft Entra admin center > Agent ID / Enterprise applications",
      status: "Required",
      details:
        "Assign AI Administrator / Privileged Role Administrator permissions to inspect Entra Agent Identities, assign least-privilege RBAC/Graph scopes, and review Conditional Access policies for autonomous agents.",
    },
    agentIdentityMods,
  );

  const m365CopilotMods = matchModules(
    modules,
    (m) =>
      harness === "microsoft-copilot" ||
      m.product === "m365-copilot-agent-builder" ||
      m.product === "m365-copilot-hub" ||
      hasId(null, m, [
        "channel-teams",
        "mc-publish-m365-channels",
        "dca-create-agent-builder",
        "dca-agents-toolkit-vscode",
      ]),
  );
  addItem(
    tenantAndCloud,
    {
      id: "m365-copilot-and-teams-sideloading",
      title: "Microsoft 365 Copilot Licensing, Agent Store Access, and Teams Custom App Upload",
      adminPath: "Microsoft 365 admin center > Copilot > Settings & Teams admin center > Teams apps > Setup policies",
      status: "Required",
      details:
        "Assign Microsoft 365 Copilot licenses (where required by M365 Copilot or Agent Builder modules), allow declarative/custom agents in Copilot settings, and enable 'Upload custom apps' in Teams setup policies for learners.",
    },
    m365CopilotMods,
  );

  const purviewMods = matchModules(modules, (m) =>
    hasId(null, m, [
      "dlp-governance",
      "m365h-dlp-for-copilot",
      "m365h-dspm-copilot-risk",
      "epic-fhir-integration",
    ]),
  );
  addItem(
    tenantAndCloud,
    {
      id: "purview-dlp-dspm-roles",
      title: "Microsoft Purview DLP, Sensitivity Labels, and DSPM for AI Roles",
      adminPath: "Microsoft Purview portal (purview.microsoft.com) > Solutions > DSPM for AI & Data Loss Prevention",
      status: "Required",
      details:
        "Assign Compliance Administrator or Purview Data Security AI Admin roles so learners can configure sensitivity-label enforcement, inspect prompt/response audit logs, and test Copilot DLP policies.",
    },
    purviewMods,
  );

  if (sharePointMods.length) {
    const needsSam = modules.some(
      (m) =>
        /^sp(?:ai)?-sam-/.test(m.id) ||
        /^spai-(?:restricted-|site-access-review|site-lifecycle-policies|content-management-assessment)/.test(m.id) ||
        /\bsharepoint advanced management|restricted content\b/i.test(m.name),
    );
    addItem(
      tenantAndCloud,
      {
        id: "sharepoint-site-and-sam-permissions",
        title: needsSam
          ? "SharePoint Administrator Role and SharePoint Advanced Management (SAM)"
          : "SharePoint Site Owner / Member Permissions on a Test Site",
        adminPath: needsSam
          ? "SharePoint admin center > Policies / Reports (SharePoint Advanced Management)"
          : "SharePoint site > Settings > Site permissions",
        status: "Required",
        details: needsSam
          ? "Assign the SharePoint Administrator role and confirm SharePoint Advanced Management (included with M365 Copilot licensing or SAM add-on) is active for oversharing reports, Restricted Content Discovery, and site lifecycle policies."
          : "Provide a non-production SharePoint site with sample document libraries where learners hold Site Owner (for creating agents/columns/flows) or Member read access (for testing security-trimmed citations).",
      },
      sharePointMods,
    );
  }

  const foundryCloudMods = matchModules(
    modules,
    (m) =>
      m.product === "ai-foundry" ||
      hasId(null, m, ["deep-reasoning-models", "vnet-private-connectivity"]),
  );
  addItem(
    tenantAndCloud,
    {
      id: "azure-foundry-rbac-and-quota",
      title: "Azure Subscription, Microsoft Foundry Project RBAC, and Model TPM Quota",
      adminPath: "Azure portal & Microsoft Foundry portal (ai.azure.com) > Access control (IAM) + Quotas",
      status: "Required",
      details:
        "Assign learners `Azure AI Developer` and `Cognitive Services OpenAI User` (or `Azure AI Administrator` when creating hubs/projects and RBAC bindings) on the Foundry project resource group, and verify regional TPM quota for the selected chat, reasoning, and embedding models.",
    },
    foundryCloudMods,
  );

  const productListText = productsPhrase(products);
  const harnessText = harnessInfo?.name ? ` (${harnessInfo.name})` : "";
  const summary =
    `Complete this pre-flight checklist in a non-production environment before running the lab across ${productListText}${harnessText}: ` +
    `${connectors.length} connector/endpoint rule${connectors.length === 1 ? "" : "s"}, ` +
    `${dlpAndAcp.length} DLP/ACP governance check${dlpAndAcp.length === 1 ? "" : "s"}, ` +
    `${environmentSettings.length} environment/feature setting${environmentSettings.length === 1 ? "" : "s"}, and ` +
    `${tenantAndCloud.length} tenant/cloud role prerequisite${tenantAndCloud.length === 1 ? "" : "s"}.`;

  return {
    version: 1,
    products,
    harness: harness || null,
    harnessName: harnessInfo?.name || null,
    summary,
    connectors,
    dlpAndAcp,
    environmentSettings,
    tenantAndCloud,
  };
}

function escapePipe(text) {
  return String(text || "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function renderChecklistItems(items) {
  return items.map((item) => {
    const req = item.requiredBy?.length ? ` *(Required by: ${item.requiredBy.join("; ")})*` : "";
    return `- [ ] **${item.title}** (*${item.status}* — \`${item.adminPath}\`): ${item.details}${req}`;
  });
}

/**
 * Render the structured prerequisites model as a Markdown section for `index.md`
 * and standalone overview exports.
 *
 * Avoids any broken relative links, TODO-style markers, or UK spellings so
 * `validator.js`, `qa.js`, `step-validator`, and `validate_labs.py` pass cleanly.
 *
 * @param {object} prereqs output of `buildAdminPrerequisites`
 * @returns {string}
 */
export function renderAdminPrerequisitesMarkdown(prereqs) {
  if (!prereqs || typeof prereqs !== "object") return "";
  const lines = [
    "## Connectors, Environment, and Tenant Prerequisites",
    "",
    prereqs.summary,
    "",
  ];

  if (Array.isArray(prereqs.connectors) && prereqs.connectors.length) {
    lines.push(
      "### Connectors and Endpoints to Allow",
      "",
      "| Connector / Endpoint | Classification | Target Policy Scope | Required By | Configuration Notes |",
      "|---|---|---|---|---|",
      ...prereqs.connectors.map((c) => {
        const endpoints = c.endpoints?.length ? ` Endpoints: \`${c.endpoints.join("`, `")}\`.` : "";
        return `| **${escapePipe(c.name)}** | ${escapePipe(c.classification)} | ${escapePipe(c.dataGroup)} | ${escapePipe(
          (c.requiredBy || []).join(", "),
        )} | ${escapePipe(`${c.details}${endpoints}`)} |`;
      }),
      "",
    );
  }

  if (Array.isArray(prereqs.dlpAndAcp) && prereqs.dlpAndAcp.length) {
    lines.push(
      "### DLP, Agent Control Plane (ACP), and Governance Policies",
      "",
      ...renderChecklistItems(prereqs.dlpAndAcp),
      "",
    );
  }

  if (Array.isArray(prereqs.environmentSettings) && prereqs.environmentSettings.length) {
    lines.push(
      "### Environment and Feature Settings",
      "",
      ...renderChecklistItems(prereqs.environmentSettings),
      "",
    );
  }

  if (Array.isArray(prereqs.tenantAndCloud) && prereqs.tenantAndCloud.length) {
    lines.push(
      "### Tenant, Identity, and Cloud Admin Prerequisites",
      "",
      ...renderChecklistItems(prereqs.tenantAndCloud),
      "",
    );
  }

  return lines.join("\n").trimEnd();
}
