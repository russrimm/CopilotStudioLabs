/**
 * The standalone "Prerequisites checklist": only what a customer must have ready before
 * a workshop, written for the people who host it, with nothing else from the lab.
 *
 * `buildPrerequisitesChecklist()` reads a generated lab's manifest and index.md (so labs built
 * before this feature work too), reuses the administrator prerequisites model from
 * `admin-prereqs.js`, and returns a plain, JSON-serializable model. The renderers
 * (`renderPrerequisitesChecklistMarkdown`, plus the HTML, Word, and PDF writers beside this file)
 * only format that model, so every format says the same thing.
 *
 * What never reaches the model: module steps, quizzes and answer keys, facilitator content,
 * screenshot placeholders, builder notes, generation metadata, lab or manifest ids, and tenant
 * identifiers (site addresses, environment addresses, GUIDs).
 *
 * Pure and dependency-free apart from sibling lab-builder modules, so the offline CLI can use it.
 */

import { buildAdminPrerequisites } from "./admin-prereqs.js";
import { repairConnectorNames, rewriteConnectorValue } from "./connector-names.js";
import { cleanText } from "./brand-theme.js";
import { isDefaultCompanyName } from "../product-name.js";
import { DEFAULT_PRODUCT, getProduct, joinNames } from "./products.js";
import { getIndustries, getRoles } from "../scenarios.js";

export const PREREQ_CHECKLIST_SCHEMA_VERSION = 1;

export const CHECKLIST_TITLE = "Prerequisites checklist";
export const CHECKLIST_BANNER = "Please complete before the workshop";
export const CONFIRM_WITH_MICROSOFT = "Confirm with your Microsoft representative";

const GUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const GUID_TEST_RE = new RegExp(GUID_RE.source, "i");
// A tenant's own SharePoint or Dynamics address names the customer's tenant, so it never goes in the document.
const TENANT_ADDRESS_RE = /https?:\/\/[a-z0-9-]+\.(?:sharepoint\.com|(?:api\.)?crm\d*\.dynamics\.com)[^\s)\]]*/gi;
const UNCONFIRMED_RE = /Not confirmed in Microsoft Learn(?: by this builder)?/i;

// ── Who does the work ───────────────────────────────────────────────────────

export const CHECKLIST_ROLES = Object.freeze({
  "tenant-admin": {
    label: "Microsoft 365 tenant admin",
    does: "Assigns licenses and turns on tenant-wide settings.",
    order: 1,
  },
  "identity-admin": {
    label: "Identity admin (Microsoft Entra)",
    does: "Registers apps and grants the identity permissions the workshop needs.",
    order: 2,
  },
  "power-platform-admin": {
    label: "Power Platform admin",
    does: "Prepares the workshop environment, data policies, and connectors.",
    order: 3,
  },
  "sharepoint-admin": {
    label: "SharePoint admin",
    does: "Sets up the SharePoint site and permissions the workshop uses.",
    order: 4,
  },
  "security-admin": {
    label: "Security and compliance admin",
    does: "Reviews data protection and governance settings.",
    order: 5,
  },
  "azure-admin": {
    label: "Azure subscription owner",
    does: "Prepares the Azure subscription, access, and quota.",
    order: 6,
  },
  "network-admin": {
    label: "Network or IT security contact",
    does: "Allows the web addresses the workshop uses.",
    order: 7,
  },
  "content-owner": {
    label: "Content owner",
    does: "Provides the sample documents and data the workshop uses.",
    order: 8,
  },
  "workshop-host": {
    label: "Workshop host",
    does: "Confirms the practical details and the accounts attendees will use.",
    order: 9,
  },
  attendee: {
    label: "Each attendee",
    does: "Has the account, browser, and tools to take part.",
    order: 10,
  },
});

const SECTION_DEFS = [
  {
    id: "licenses",
    title: "Licenses and subscriptions",
    why: "Without the right license, attendees cannot create or run what the workshop builds.",
  },
  {
    id: "tenant",
    title: "Tenant, identity, and cloud admin settings",
    why: "Some steps need tenant-level permission that attendees do not have.",
  },
  {
    id: "environment",
    title: "Environment and data loss prevention settings",
    why: "This is where attendees build and test during the workshop.",
  },
  {
    id: "connectors",
    title: "Connectors and connections",
    why: "Agents use these connections to reach data and services.",
  },
  {
    id: "data",
    title: "Data and content for the workshop",
    why: "Attendees use this content during the hands-on steps.",
  },
  {
    id: "attendees",
    title: "What each attendee needs",
    why: "Each attendee needs this to take part.",
  },
  {
    id: "knowledge",
    title: "What attendees should already know",
    why: "The workshop builds on this and does not teach it from the beginning.",
  },
  {
    id: "network",
    title: "Network and allow-list needs",
    why: "Blocked addresses stop the hands-on steps from working.",
  },
];

// ── Microsoft Learn pages (each was checked when this table was written) ────

const LEARN = {
  dlp: { label: "Data policies in Power Platform", url: "https://learn.microsoft.com/power-platform/admin/wp-data-loss-prevention" },
  copilotDlp: { label: "Data policies for Copilot Studio", url: "https://learn.microsoft.com/microsoft-copilot-studio/admin-data-loss-prevention" },
  endpointFiltering: { label: "Connector endpoint filtering", url: "https://learn.microsoft.com/power-platform/admin/connector-endpoint-filtering" },
  managedEnvironments: { label: "Managed Environments overview", url: "https://learn.microsoft.com/power-platform/admin/managed-environment-overview" },
  capacity: { label: "Capacity and storage in Power Platform", url: "https://learn.microsoft.com/power-platform/admin/capacity-storage" },
  securityRoles: { label: "Security roles in Dataverse", url: "https://learn.microsoft.com/power-platform/admin/database-security" },
  customConnectors: { label: "Custom connectors overview", url: "https://learn.microsoft.com/connectors/custom-connectors/" },
  gateway: { label: "On-premises data gateway", url: "https://learn.microsoft.com/data-integration/gateway/service-gateway-onprem" },
  entraApps: { label: "Register an application in Microsoft Entra ID", url: "https://learn.microsoft.com/entra/identity-platform/quickstart-register-app" },
  entraAgentId: { label: "What is Microsoft Entra Agent ID", url: "https://learn.microsoft.com/entra/agent-id/what-is-microsoft-entra-agent-id" },
  teamsCustomApps: { label: "Custom app policies in Teams", url: "https://learn.microsoft.com/microsoftteams/teams-custom-app-policies-and-settings" },
  purviewAi: { label: "Data Security Posture Management for AI", url: "https://learn.microsoft.com/purview/dspm-for-ai" },
  sam: { label: "SharePoint Advanced Management", url: "https://learn.microsoft.com/sharepoint/advanced-management" },
  foundryRbac: { label: "Role-based access control for Microsoft Foundry", url: "https://learn.microsoft.com/azure/foundry/concepts/rbac-foundry" },
  vnet: { label: "Virtual Network support for Power Platform", url: "https://learn.microsoft.com/power-platform/admin/vnet-support-overview" },
  codeApps: { label: "Power Apps code apps overview", url: "https://learn.microsoft.com/power-apps/developer/code-apps/overview" },
  credits: { label: "Copilot Studio billing and licensing", url: "https://learn.microsoft.com/microsoft-copilot-studio/billing-licensing" },
  aiBuilderRegion: { label: "Feature availability by region", url: "https://learn.microsoft.com/ai-builder/availability-region" },
  promptRegion: { label: "Prompt model availability by region and updates", url: "https://learn.microsoft.com/microsoft-copilot-studio/prompt-model-availability" },
  aiBuilderAdmin: { label: "Administer AI Builder", url: "https://learn.microsoft.com/ai-builder/administer" },
  aiBuilderBuild: { label: "Build a model in AI Builder", url: "https://learn.microsoft.com/ai-builder/build-model" },
  createEnvironment: { label: "Create and manage environments in the Power Platform admin center", url: "https://learn.microsoft.com/power-platform/admin/create-environment" },
  environmentRegion: { label: "Choose the region when setting up an environment", url: "https://learn.microsoft.com/power-platform/admin/regions-overview" },
  aiBuilderSamples: { label: "Start using AI Builder with sample data", url: "https://learn.microsoft.com/ai-builder/samples" },
  aiBuilderLicensing: { label: "Overview of AI Builder licensing", url: "https://learn.microsoft.com/ai-builder/administer-licensing" },
  aiBuilderCredits: { label: "Licensing and AI Builder credits", url: "https://learn.microsoft.com/ai-builder/credit-management" },
  agentFlowTool: { label: "Create an agent flow as a tool", url: "https://learn.microsoft.com/microsoft-copilot-studio/advanced-flow-create" },
  teamsEnvironment: { label: "About the Microsoft Dataverse for Teams environment", url: "https://learn.microsoft.com/power-platform/admin/about-teams-environment" },
};

// ── What each administrator prerequisite means to a customer ────────────────
// Keyed by the ids `buildAdminPrerequisites()` emits. An id that is not listed here still appears,
// using its own title and details, so a new prerequisite is never silently dropped.

const ADMIN_COPY = {
  "microsoft-dataverse": {
    section: "connectors", role: "power-platform-admin", order: 10, title: "Microsoft Dataverse",
    text: "Allow the Microsoft Dataverse connector for the workshop environment.",
    why: "Agents, solutions, and knowledge tables are stored in Dataverse.",
  },
  sharepoint: {
    section: "connectors", role: "power-platform-admin", order: 11, title: "SharePoint and OneDrive for Business",
    text: "Allow the SharePoint and OneDrive for Business connectors so agents can read and search library files.",
    why: "Agents look up documents in SharePoint.",
  },
  "office365-teams-outlook": {
    section: "connectors", role: "power-platform-admin", order: 12, title: "Microsoft Teams, Office 365 Outlook, and Office 365 Users",
    text: "Allow these three connectors and keep them in the same data policy group as Dataverse and SharePoint.",
    why: "Triggers, notifications, and profile lookups use them.",
  },
  approvals: {
    section: "connectors", role: "power-platform-admin", order: 13, title: "Standard approvals",
    text: "Make sure the Standard approvals connector is available in the environment and sits in the same data policy group as Dataverse and Teams.",
    why: "Approval steps in agents and flows use it.",
  },
  "content-conversion": {
    section: "connectors", role: "power-platform-admin", order: 13.5, title: "Content Conversion (Preview)",
    text: "Allow the Content Conversion connector, which turns an email body into plain text before an AI Builder action reads it, and keep it in the same data policy group as Office 365 Outlook and Dataverse. Learn says it is no longer available in US Government (GCC and GCC High) regions for creating new implementations.",
    why: "The email routing flow converts the message body to plain text with it.",
  },
  "power-automate-agent-flows": {
    section: "connectors", role: "power-platform-admin", order: 14, title: "Power Automate cloud flows and agent flows",
    text: "Allow cloud flows and agent flows in your data policies, and confirm makers are allowed to create flows.",
    why: "Flows run the automated steps in the workshop.",
  },
  "prebuilt-power-platform-connectors": {
    section: "connectors", role: "power-platform-admin", order: 15, title: "Prebuilt connectors used as tools",
    text: "Allow the prebuilt connectors the workshop uses as tools (for example HTTP with Microsoft Entra ID (preauthorized), MSN Weather, or SQL Server) in the same data policy group as the other workshop connectors.",
    why: "Agents call these connectors as tools.",
  },
  "custom-connectors-openapi": {
    section: "connectors", role: "power-platform-admin", order: 16, title: "Custom connectors",
    text: "Allow custom connectors, and add a rule for the host name of the API the workshop calls above any rule that blocks everything else.",
    why: "Custom connectors let agents call your own APIs.",
    learn: LEARN.customConnectors,
  },
  "mcp-server-endpoints": {
    section: "connectors", role: "power-platform-admin", order: 17, title: "Model Context Protocol (MCP) server",
    text: "Allow outbound secure web traffic to the MCP server the workshop uses, in your data policies and your firewall.",
    why: "Agents reach tools on the MCP server.",
  },
  "microsoft-copilot-graph-connectors": {
    section: "connectors", role: "tenant-admin", order: 18, title: "Microsoft 365 Copilot connectors",
    text: "Confirm the connection used in the workshop shows Ready, that its items carry the right permissions for test attendees, and that external results are turned on.",
    why: "Agents search the content these connections index.",
  },
  servicenow: vendorCopy("ServiceNow", 20),
  snowflake: vendorCopy("Snowflake", 21),
  "sap-erp-odata": vendorCopy("SAP ERP and SAP OData", 22),
  salesforce: vendorCopy("Salesforce", 23),
  jira: vendorCopy("Jira", 24),
  "epic-fhir": vendorCopy("Epic FHIR (healthcare)", 25, "Use synthetic patient data only."),
  shopify: vendorCopy("Shopify", 26),
  "on-premises-data-gateway": {
    section: "connectors", role: "power-platform-admin", order: 30, title: "On-premises data gateway",
    text: "Install and register a gateway on a Windows machine on the same network as your data source, in the same region as the workshop environment, and let makers use it.",
    why: "The gateway lets agents reach data that is not on the internet.",
    learn: LEARN.gateway,
  },
  "foundry-project-connections": {
    section: "connectors", role: "azure-admin", order: 31, title: "Microsoft Foundry project connections",
    text: "Attach the Azure AI Search, Azure Storage, and model deployments to the Foundry project, using Microsoft Entra ID sign-in instead of keys.",
    why: "Foundry agents read their data through these connections.",
  },
  "dlp-business-group-alignment": {
    section: "environment", role: "power-platform-admin", order: 20, title: "Group the workshop connectors together in your data policies",
    text: "In every data policy that covers the workshop environment, put the workshop connectors in the same group (usually Business) and confirm none are blocked.",
    why: "Connectors in different groups cannot be used together.",
    learn: LEARN.dlp,
  },
  "dlp-endpoint-filtering": {
    section: "environment", role: "power-platform-admin", order: 21, title: "Allow the external addresses the workshop uses",
    text: "If your policies filter connector endpoints, add Allow rules for each external host the workshop uses, above any rule that denies everything else.",
    why: "A catch-all deny rule would otherwise block the workshop's services.",
    learn: LEARN.endpointFiltering,
  },
  "acp-managed-environment-policies": {
    section: "environment", role: "power-platform-admin", order: 22, title: "Managed Environment and agent governance rules",
    text: "Check that your sharing and publishing rules let makers create, test, share, and publish agents in the workshop environment.",
    why: "Strict governance rules can block the workshop's agents.",
    learn: LEARN.managedEnvironments,
  },
  "dlp-auth-and-channel-rules": {
    section: "environment", role: "power-platform-admin", order: 23, title: "Sign-in and channel rules",
    text: "Make sure the Copilot Studio sign-in and channel connectors (Microsoft authentication, web channel, and the Microsoft Teams channel) are not blocked.",
    why: "Attendees publish and test agents through these channels.",
    learn: LEARN.copilotDlp,
  },
  "dataverse-database-and-storage": {
    section: "environment", role: "power-platform-admin", order: 10, title: "A Dataverse database with free storage",
    text: "The workshop environment has an active Dataverse database and at least 1 GB of free database and file storage.",
    why: "Running out of capacity blocks creating or publishing agents and flows.",
    learn: LEARN.capacity,
  },
  "code-apps-and-pcf-components": {
    section: "environment", role: "power-platform-admin", order: 11, title: "Power Apps component framework and code apps",
    text: "Turn on \"Power Apps component framework for canvas apps\" and \"Code apps\" under Settings > Product > Features for the workshop environment.",
    why: "Custom components and code-first apps need them to publish and run.",
    learn: LEARN.codeApps,
  },
  "generative-ai-and-region-movement": {
    section: "environment", role: "power-platform-admin", order: 12, title: "Generative AI features and data movement across regions",
    text: "Turn on the generative AI features, including \"Move data across regions\" if your environment relies on another region's AI capacity, and public website (web) search.",
    why: "Generative orchestration, prompts, and web grounding depend on these settings.",
  },
  "code-interpreter-python-execution": {
    section: "environment", role: "power-platform-admin", order: 13, title: "Code interpreter",
    text: "Turn on code interpreter so agents can run Python for data analysis, charts, and file output.",
    why: "The data analysis steps run code in a protected sandbox.",
  },
  "computer-use-toggle": {
    section: "environment", role: "power-platform-admin", order: 14, title: "Computer use",
    text: "Turn on computer use in a supported environment, and set up either hosted browser capacity or a registered Windows machine group.",
    why: "Computer use agents operate a browser or desktop for the workshop.",
  },
  "alm-and-security-roles": {
    section: "environment", role: "power-platform-admin", order: 15, title: "Maker roles for attendees",
    text: "Give each attendee the Environment Maker role in the workshop environment. Add System Customizer if they create tables, environment variables, or custom connectors in solutions.",
    why: "Attendees cannot create agents or solutions without a maker role.",
    learn: LEARN.securityRoles,
  },
  "voice-contact-center-environment": {
    section: "environment", role: "power-platform-admin", order: 16, title: "Voice channel and Azure Communication Services",
    text: "Provision Dynamics 365 Contact Center (or Customer Service omnichannel voice), link an Azure Communication Services resource with a phone number or a voice test client, and install the Copilot Studio telephony solutions.",
    why: "Voice agents need a phone channel to take calls.",
  },
  "vnet-enterprise-policy": {
    section: "environment", role: "azure-admin", order: 17, title: "Azure virtual network and Power Platform enterprise policy",
    text: "Delegate the primary and failover Azure subnets to Microsoft.PowerPlatform/enterprisePolicies, and link the virtual network enterprise policy to a Managed Environment.",
    why: "Private connectivity must exist before it can be tested.",
    learn: LEARN.vnet,
  },
  "copilot-credits-ai-builder-capacity": {
    section: "licenses", role: "power-platform-admin", order: 20, title: "Copilot Credits or AI Builder capacity for the environment",
    text: "Allocate prepaid Copilot Credits, pay-as-you-go billing, or AI Builder credits to the workshop environment.",
    why: "Without capacity, prompts, custom models, and autonomous runs are throttled.",
    learn: LEARN.credits,
  },
  "ai-builder-agent-tools-environment": {
    section: "environment", role: "power-platform-admin", order: 10.7, title: "Copilot Studio access and a Dataverse environment for agent tools",
    text: "Give the people who build the agent access to Copilot Studio with a license that includes the use of flows in Copilot Studio, in a Dataverse environment that is not a Dataverse for Teams environment.",
    check: `Ask your Power Platform admin to confirm the workshop environment is a Dataverse environment and not a Dataverse for Teams environment, which Learn says does not support agent flows or agent flow tools (${learnLink(LEARN.agentFlowTool)}). Learn explains how to upgrade one in ${learnLink(LEARN.teamsEnvironment)}. Confirm each builder's Copilot Studio license with your Microsoft 365 admin.`,
    why: "Agent flows and agent flow tools need Copilot Studio access with a license that includes flows, and a Dataverse environment.",
    learn: LEARN.agentFlowTool,
  },
  "ai-builder-flow-license": {
    section: "licenses", role: "tenant-admin", order: 6, title: "Power Automate license for flows that use AI Builder actions",
    text: "Confirm which Power Automate license the people who build and run the workshop's flows need. Not confirmed in Microsoft Learn: whether a flow that uses an AI Builder action is a premium flow, because two Learn pages disagree.",
    check: `Read the AI Builder Capability Rate table in ${learnLink(LEARN.aiBuilderLicensing)}, which says a flow that uses any AI Builder action is a premium flow, and ${learnLink(LEARN.aiBuilderCredits)}, which says adding an AI Builder action does not transform a flow into a premium flow. Ask your Microsoft representative which applies to your licenses, then check each builder's licenses on the Active users page of the Microsoft 365 admin center.`,
    why: "Attendees cannot build or run the workshop's flows without a Power Automate license that covers every action in them.",
    learn: LEARN.aiBuilderLicensing,
  },
  "ai-builder-model-region-availability": {
    section: "environment", role: "power-platform-admin", order: 7, title: "AI Builder models are available in the environment's region",
    text: "Find the region of the workshop environment and confirm that each AI Builder model the workshop uses is available there. Write down whether each one is generally available (GA) or in preview.",
    check: `Sign in to the Power Platform admin center, select Manage, then Environments, and read the Region column for the workshop environment (${learnLink(LEARN.environmentRegion)}). Open ${learnLink(LEARN.aiBuilderRegion)} and find that region in the Custom models and Prebuilt models tables. GA means generally available, Preview means preview, and a dash means the feature is not available. Use the US Government tables for a government cloud environment.`,
    why: "AI Builder models run in the region that hosts the environment. Availability and release status differ by region, so a model can be missing, or preview only, where attendees build.",
    learn: LEARN.aiBuilderRegion,
  },
  "ai-builder-prompt-model-availability": {
    section: "environment", role: "power-platform-admin", order: 8, title: "Prompt models are available in the environment's region",
    text: "If the workshop uses prompts, confirm the prompt models are available in the environment's region, and note which are generally available (GA) and which are experimental.",
    check: `Open ${learnLink(LEARN.promptRegion)}, find the Public availability table, and read the column for the environment's region. A model marked cross-geo might process data outside of your region. For a US Government environment, read the US Government availability table instead.`,
    why: "Prompts run on generative AI models. Which models are offered, and at what release stage, depends on the region.",
    learn: LEARN.promptRegion,
  },
  "ai-builder-us-government-limits": {
    section: "environment", role: "power-platform-admin", order: 9, title: "US Government limits for AI Builder",
    text: "If the workshop environment is in a US Government cloud (GCC, GCC High, or DoD), check the US Government tables and plan around the features that are not available there.",
    check: `On ${learnLink(LEARN.aiBuilderRegion)}, open the US Government section. The Custom models and Prebuilt models tables list GCC, GCC High, and DoD, and DoD shows a dash for every listed feature. The US Government feature limitations list names what is missing: 30-day user trials, copying AI models across cloud boundaries, Document Automation (GCC and GCC High), and adding an image or document input to a prompt (GCC and GCC High).`,
    why: "Some AI Builder features in the commercial cloud are not available to US Government customers, and workshop steps that use them cannot be completed there.",
    learn: LEARN.aiBuilderRegion,
  },
  "ai-builder-enabled-for-environment": {
    section: "environment", role: "power-platform-admin", order: 10.5, title: "AI Builder is turned on for the workshop environment",
    text: "Confirm the workshop environment has a Dataverse database and that AI Builder is enabled for it. If the workshop uses prompts, check that the AI prompts setting is on. If it uses preview models, check that Preview and experimental AI models is on. Credits and capacity are a separate item: see Copilot Credits or AI Builder capacity for the environment. Not confirmed in Microsoft Learn: a separate switch that turns AI Builder itself on for an environment, beyond these settings.",
    check: `The environment needs a Dataverse database (see the item about a Dataverse database with free storage). In the Power Platform admin center, open the environment, then Settings > Product > Features and check the AI prompts toggle under AI Builder. For preview models, open Manage > Environments, select the environment, then Settings > Features and check Let people use AI models that are experimental or in preview under Preview and experimental AI models. That setting does not appear when the environment has no Dataverse or is not in a supported region. See ${learnLink(LEARN.aiBuilderAdmin)} and ${learnLink(LEARN.aiBuilderBuild)}.`,
    why: "AI Builder needs Dataverse and must be enabled for the environment, or attendees do not get its features. Prompts stop working when AI prompts is off, and preview models stop working when Preview and experimental AI models is off.",
    learn: LEARN.aiBuilderBuild,
  },
  "ai-builder-sample-data": {
    section: "environment", role: "power-platform-admin", order: 10.6, title: "Deploy sample apps and data when you create the environment",
    text: "When you create a new environment for the workshop, you can set Deploy sample apps and data to Yes to add Microsoft's sample apps and data for exploring AI Builder.",
    check: `In the Power Platform admin center, select Manage, then Environments, then New. Set Add a Dataverse data store to Yes, select Next, and set Deploy sample apps and data to Yes. The setting appears only when Enable Dynamics 365 apps is No (${learnLink(LEARN.createEnvironment)}). For an environment that already exists, download the sample data and upload it instead (${learnLink(LEARN.aiBuilderSamples)}).`,
    why: "Sample data gives attendees something to experiment with, so the first steps work before they have data of their own.",
    learn: LEARN.aiBuilderBuild,
  },
  "entra-app-registration-sso": {
    section: "tenant", role: "identity-admin", order: 10, title: "Permission to register apps in Microsoft Entra ID",
    text: "Give the people running the workshop the Application Developer (or Cloud Application Administrator) role, or register the apps with them. They need to register apps, set redirect addresses, expose scopes, and grant admin consent.",
    why: "Single sign-on and API connections need a registered app.",
    learn: LEARN.entraApps,
  },
  "entra-agent-identities": {
    section: "tenant", role: "identity-admin", order: 11, title: "Microsoft Entra Agent ID access",
    text: "Give the people running the workshop the AI Administrator or Privileged Role Administrator role so they can inspect agent identities and review Conditional Access for autonomous agents.",
    why: "Agents that act on their own get their own identity.",
    learn: LEARN.entraAgentId,
  },
  "m365-copilot-and-teams-sideloading": {
    section: "tenant", role: "tenant-admin", order: 12, title: "Microsoft 365 Copilot licenses and custom app upload in Teams",
    text: "Assign Microsoft 365 Copilot licenses where the workshop needs them, allow declarative and custom agents in Copilot settings, and turn on \"Upload custom apps\" in the Teams setup policies for attendees.",
    why: "Attendees install and test their agents in Copilot and Teams.",
    learn: LEARN.teamsCustomApps,
  },
  "purview-dlp-dspm-roles": {
    section: "tenant", role: "security-admin", order: 13, title: "Microsoft Purview roles for data protection",
    text: "Give the people running the workshop the Compliance Administrator or Purview Data Security AI Admin role so they can set sensitivity label enforcement, read prompt and response audit logs, and test Copilot data loss prevention policies.",
    why: "These roles are needed to configure and check data protection.",
    learn: LEARN.purviewAi,
  },
  "sharepoint-site-and-sam-permissions": {
    section: "tenant", role: "sharepoint-admin", order: 14, title: "SharePoint administrator role and SharePoint Advanced Management",
    text: "Give the people running the workshop the SharePoint Administrator role, and confirm SharePoint Advanced Management is active (it is included with Microsoft 365 Copilot licensing or available as an add-on).",
    why: "Oversharing reports, restricted content discovery, and site lifecycle policies need it.",
    learn: LEARN.sam,
  },
  "azure-foundry-rbac-and-quota": {
    section: "tenant", role: "azure-admin", order: 15, title: "Azure subscription, Microsoft Foundry access, and model quota",
    text: "Give attendees the Azure AI Developer and Cognitive Services OpenAI User roles (or Azure AI Administrator if they create hubs, projects, and role assignments) on the Foundry project's resource group, and check the regional token quota for the chat, reasoning, and embedding models.",
    why: "Foundry agents cannot be created or run without access and quota.",
    learn: LEARN.foundryRbac,
  },
};

function vendorCopy(name, order, extra = "") {
  return {
    section: "connectors",
    role: "power-platform-admin",
    order,
    title: name,
    text: `Allow the ${name} connector, and provide a test (non-production) ${name} account or instance with sign-in the workshop can use.${extra ? ` ${extra}` : ""}`,
    why: `Agents call ${name} through this connector.`,
  };
}

/** "Technical name: shared_x." for one connector, "Technical names: A is shared_a; B is shared_b." for several. */
export function technicalNameSentence(refs) {
  if (refs.length === 1) return `Technical name: ${refs[0].apiName}.`;
  return `Technical names: ${refs.map((ref) => `${ref.displayName} is ${ref.apiName}`).join("; ")}.`;
}

/** A Microsoft Learn page as an inline Markdown link, for text that sits in a sentence. */
function learnLink(ref) {
  return `[${ref.label}](${ref.url})`;
}

/** What a "Required if" status means to someone who is not reading the lab. */
function conditionFor(status) {
  const text = String(status || "");
  if (/enforced in tenant/i.test(text)) return "Only if your tenant enforces this.";
  if (/^required if us government/i.test(text)) return "Only if your environment is in a US Government cloud (GCC, GCC High, or DoD).";
  if (/^optional/i.test(text)) return "Only if you want it (optional).";
  if (/custom ui|pcf/i.test(text) && /^required if/i.test(text)) return "Only if you use custom screens or components.";
  if (/^verify/i.test(text)) return "Check only if you embed the agent in a custom app.";
  if (/^required if/i.test(text)) return `Only if ${text.replace(/^required if\s+/i, "").toLowerCase()}.`;
  return "";
}

// ── Text helpers ────────────────────────────────────────────────────────────

/** One line of plain text safe for any format: no HTML, no backticks, no GUIDs, no builder markers. */
export function cleanChecklistText(value) {
  return String(value ?? "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\\([\\`*_{}[\]()#+\-.!|])/g, "$1")
    .replace(/`/g, "")
    .replace(TENANT_ADDRESS_RE, "")
    .replace(GUID_RE, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Keep Microsoft Learn links; show every other link as its label so no address from the lab leaks. */
function stripOtherLinks(text) {
  return String(text || "").replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (whole, label, url) => (isLearnUrl(url) ? whole : label));
}

function lowerFirst(text) {
  const value = String(text || "");
  if (/^[A-Z][a-z]/.test(value)) return value.charAt(0).toLowerCase() + value.slice(1);
  return value;
}

function ensurePeriod(text) {
  const value = String(text || "").trim();
  if (!value) return "";
  return /[.!?:]$/.test(value) ? value : `${value}.`;
}

function isLearnUrl(url) {
  try {
    return new URL(url).hostname === "learn.microsoft.com";
  } catch {
    return false;
  }
}

/** Move the first Microsoft Learn link out of the text so it can sit in its own place. */
function pullLearnLink(text) {
  let learn = null;
  const stripped = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (whole, label, url) => {
    if (!learn && isLearnUrl(url)) {
      learn = { label: cleanChecklistText(label), url };
      return label;
    }
    return whole;
  });
  return { text: stripped, learn };
}

/** Split "Not confirmed in Microsoft Learn" sentences out into a customer-facing confirm line. */
function splitConfirm(text) {
  if (!UNCONFIRMED_RE.test(text)) return { text, confirm: "" };
  const sentences = text.split(/(?<=[.!?])\s+/);
  const keep = [];
  const notes = [];
  for (const sentence of sentences) {
    if (!UNCONFIRMED_RE.test(sentence)) {
      keep.push(sentence);
      continue;
    }
    const note = sentence
      .replace(UNCONFIRMED_RE, " ")
      .replace(/\s+(is|are)\s*([,;:.]|$)/gi, "$2")
      .replace(/^[\s:;,.-]+|[\s:;,.-]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (note) notes.push(note);
  }
  const confirm = notes.length
    ? `${CONFIRM_WITH_MICROSOFT} (not confirmed in Microsoft Learn): ${notes.map((n) => lowerFirst(n.replace(/[.;]+$/, ""))).join("; ")}.`
    : `${CONFIRM_WITH_MICROSOFT} (not confirmed in Microsoft Learn).`;
  return { text: keep.join(" ").trim(), confirm };
}

function neededForFrom(requiredBy) {
  const names = [];
  for (const entry of Array.isArray(requiredBy) ? requiredBy : []) {
    const name = cleanChecklistText(entry).replace(/^(?:Step|Recap)\s+\d+\s+[—–-]\s+/i, "");
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/** "Needed for: A, B, and 2 more." (never more than three names). */
export function describeNeededFor(names) {
  const list = (names || []).filter(Boolean);
  if (!list.length) return "";
  const shown = list.slice(0, 3);
  const extra = list.length - shown.length;
  const phrase = extra > 0 ? `${shown.join(", ")}, and ${extra} more` : joinNames(shown);
  return `Needed for: ${phrase}.`;
}

// ── Reading the lab's own Prerequisites block ───────────────────────────────

function sectionBody(markdown, heading) {
  const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => new RegExp(`^##\\s+${heading}\\s*$`, "i").test(line));
  if (start === -1) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out;
}

/** The lab text says "lab"; the customer hosts a workshop. */
function workshopWording(text) {
  return String(text || "")
    .replace(/\blabs\b/g, "workshops")
    .replace(/\bLabs\b/g, "Workshops")
    .replace(/\blab\b/g, "workshop")
    .replace(/\bLab\b/g, "Workshop");
}

/** The administrator model says "learners"; an administrator's document says "attendees". */
function adminWording(text) {
  return workshopWording(text)
    .replace(/\blearners\b/g, "attendees")
    .replace(/\bLearners\b/g, "Attendees")
    .replace(/\blearner\b/g, "attendee")
    .replace(/\bLearner\b/g, "Attendee");
}

function readLabPrerequisites(markdown) {
  const result = { main: [], data: [], licensing: [], dataNote: "" };
  let state = "main";
  let current = null;
  const lines = sectionBody(markdown, "Prerequisites");
  const flush = () => {
    if (current !== null) {
      const text = workshopWording(current.trim());
      if (text) result[state === "other" ? "main" : state].push(text);
    }
    current = null;
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    const bold = line.match(/^\*\*(.+?)\*\*\s*:?\s*$/);
    if (bold) {
      flush();
      state = /scenario data/i.test(bold[1]) ? "data" : /licens/i.test(bold[1]) ? "licensing" : "other";
      continue;
    }
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    if (bullet) {
      flush();
      current = bullet[1];
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    if (/^you do not need production data/i.test(line.trim())) {
      flush();
      result.dataNote = cleanChecklistText(workshopWording(line));
      continue;
    }
    if (current !== null && /^\s+\S/.test(line)) current += ` ${line.trim()}`;
    else flush();
  }
  flush();
  return result;
}

// ── Sorting free-text prerequisites into sections and roles ─────────────────

const HOST_RE = /^(?:[a-z0-9*-]+\.)+[a-z]{2,}$/i;

/** First matching rule wins. `covers` names the administrator item that already says the same thing. */
const BULLET_RULES = [
  { re: /^target sharepoint site:/i, kind: "sharepoint-site" },
  { re: /^access to at least one knowledge source/i, kind: "knowledge-source", section: "data", role: "content-owner", order: 9 },
  { re: /sharepoint administrator access/i, section: "tenant", role: "sharepoint-admin", order: 8, why: "Admin-level reports and policies need the SharePoint Administrator role." },
  { re: /permission to create connections/i, section: "connectors", role: "power-platform-admin", title: "Permission to create connections", why: "Agents use connections to reach data and services.", order: 5 },
  { re: /sandbox or developer account/i, section: "connectors", role: "workshop-host", title: "Test accounts for outside systems", why: "Agents connect to these systems during the hands-on steps.", order: 6 },
  { re: /on-premises data gateway/i, covers: "on-premises-data-gateway", section: "connectors", role: "power-platform-admin", order: 7 },
  { re: /virtual networks and delegate subnets/i, covers: "vnet-enterprise-policy", section: "environment", role: "azure-admin", order: 8 },
  { re: /register an application in microsoft entra id/i, covers: "entra-app-registration-sso", section: "tenant", role: "identity-admin", order: 8 },
  { re: /entra admin center with permission to view agent identities/i, covers: "entra-agent-identities", section: "tenant", role: "identity-admin", order: 9 },
  { re: /power platform admin center access/i, section: "tenant", role: "power-platform-admin", title: "Power Platform admin center access", order: 9 },
  { re: /environment where you are at least an environment maker/i, covers: "alm-and-security-roles", section: "environment", role: "power-platform-admin", order: 5, why: "Attendees build and test their agents here." },
  { re: /environment (?:you can create agents in|with a microsoft dataverse)/i, section: "environment", role: "power-platform-admin", order: 5, why: "Attendees build and test their agents here." },
  { re: /azure (?:account|subscription)/i, section: "licenses", role: "azure-admin", order: 6, why: "Foundry resources are created in an Azure subscription." },
  { re: /\badmin(?:istrator)? (?:account|center|role)|ai administrator|license administrator/i, section: "tenant", role: "tenant-admin", order: 7, why: "Some settings can be changed only by a tenant admin." },
  { re: /\blicen[sc]e|credits|pay-as-you-go|billing|eligible prerequisite plan/i, section: "licenses", role: "tenant-admin", order: 5, why: "Attendees need it to create and run agents." },
  { re: /quota|supported region/i, section: "tenant", role: "azure-admin", order: 16, why: "Model deployments need quota in a supported region." },
  { re: /sharepoint site and a document library/i, covers: "sharepoint-test-site", section: "data", role: "sharepoint-admin", order: 5 },
  { re: /visual studio code|browser|sign(?:ed)?[- ]in|access to (?:microsoft|the)|^sign-in/i, section: "attendees", role: "attendee", order: 5 },
];

function classifyBullet(text) {
  return BULLET_RULES.find((rule) => rule.re.test(text)) || null;
}

/** "Agents Toolkit: Visual Studio Code ..., and a tenant where an admin enabled Upload custom apps" is two jobs for two people. */
function splitCompound(text) {
  if (/visual studio code/i.test(text) && /upload custom apps/i.test(text)) {
    return [
      { text: "Visual Studio Code with the Microsoft 365 Agents Toolkit extension.", rule: { section: "attendees", role: "attendee", order: 6 } },
      {
        text: "Turn on \"Upload custom apps\" in the Teams admin center (Teams apps > Setup policies > Global (Org-wide default)).",
        rule: { section: "tenant", role: "tenant-admin", order: 12 },
        covers: "m365-copilot-and-teams-sideloading",
      },
    ];
  }
  return null;
}

// ── Reading the lab ─────────────────────────────────────────────────────────

function firstHeading(markdown) {
  const match = String(markdown || "").match(/^#\s+(.+?)\s*$/m);
  return match ? cleanChecklistText(match[1]) : "";
}

function productRecords(manifest) {
  const ids = Array.isArray(manifest?.products) && manifest.products.length
    ? manifest.products
    : manifest?.product
      ? [manifest.product]
      : [DEFAULT_PRODUCT];
  return ids.map((id) => {
    const product = getProduct(id);
    return { id, name: product?.name || cleanChecklistText(id), shortName: product?.shortName || product?.name || cleanChecklistText(id), licenseNote: product?.licenseNote || "" };
  });
}

function audienceOf(manifest) {
  const request = manifest?.request || {};
  const roleIds = Array.isArray(manifest?.roles) && manifest.roles.length ? manifest.roles : Array.isArray(request.roles) ? request.roles : [];
  const industryId = manifest?.industry || request.industry || "";
  let roleNames = [];
  let industryName = "";
  try {
    const known = new Map(getRoles().map((r) => [r.id, r.name]));
    roleNames = roleIds.map((id) => known.get(id) || cleanChecklistText(String(id).replace(/-/g, " "))).filter(Boolean);
    industryName = industryId ? getIndustries().find((i) => i.id === industryId)?.name || cleanChecklistText(String(industryId).replace(/-/g, " ")) : "";
  } catch {
    roleNames = roleIds.map((id) => cleanChecklistText(String(id).replace(/-/g, " ")));
    industryName = cleanChecklistText(String(industryId).replace(/-/g, " "));
  }
  const parts = [];
  if (roleNames.length) parts.push(`${joinNames(roleNames)} teams`);
  if (industryName) parts.push(industryName);
  return parts.length ? parts.join(", ") : "Workshop attendees";
}

function recapModules(manifest) {
  const mods = Array.isArray(manifest?.modules) ? manifest.modules : [];
  return mods
    .filter((m) => m && (m.prerequisite === true || m.role === "prerequisite" || /^recap\b/i.test(String(m.stepLabel || ""))))
    .map((m) => ({ name: cleanChecklistText(m.name || m.id), url: (m.sources || []).map((s) => s?.url).find(isLearnUrl) || "" }))
    .filter((m) => m.name);
}

function assumedFromMarkdown(bullets) {
  const found = [];
  for (const bullet of bullets) {
    const match = bullet.match(/you have already completed these topics[^:]*:\s*(.+)$/i);
    if (!match) continue;
    for (const part of match[1].split(/;\s+/)) {
      const name = cleanChecklistText(part.replace(/\s*\(needed by[^)]*\)\.?$/i, "").replace(/\.$/, ""));
      if (name) found.push(name);
    }
  }
  return found;
}

function hostOf(endpoint) {
  const text = String(endpoint || "").trim();
  if (!text || /[<>]/.test(text)) return null;
  const cleaned = text.replace(/^outbound tcp 443 to\s+/i, "").replace(/^https?:\/\//i, "").split(/[/?#]/)[0].trim();
  return HOST_RE.test(cleaned) ? cleaned.toLowerCase() : null;
}

function formatDate(now) {
  const date = now instanceof Date ? now : new Date(now || Date.now());
  const safe = Number.isNaN(date.getTime()) ? new Date() : date;
  return safe.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

// ── The model ───────────────────────────────────────────────────────────────

/**
 * @param {object} input
 * @param {object} [input.manifest] the lab's manifest.json
 * @param {string} [input.markdown] the lab's index.md (branding tokens already applied)
 * @param {object} [input.brand] the resolved brand (see `resolveLabBrand`), only used for the customer name and contact
 * @param {Date|string|number} [input.now]
 * @param {Record<string,string>} [input.replacements] term replacements the export request supplied
 */
export function buildPrerequisitesChecklist({ manifest = {}, markdown = "", brand = null, now = new Date(), replacements = {} } = {}) {
  // A lab saved with a connector's internal name in its text shows the display name here too.
  markdown = repairConnectorNames(markdown);
  const man = manifest && typeof manifest === "object" ? rewriteConnectorValue(manifest) : {};
  const title = cleanChecklistText(man.title) || firstHeading(markdown) || "Workshop";
  const products = productRecords(man);
  const admin = man.adminPrerequisites && typeof man.adminPrerequisites === "object"
    ? man.adminPrerequisites
    : buildAdminPrerequisites({ manifest: man, markdown });
  const lab = readLabPrerequisites(markdown);

  const sections = new Map(SECTION_DEFS.map((def) => [def.id, { ...def, intro: "", items: [] }]));
  const adminIds = new Set();
  const addItem = (sectionId, item) => {
    const section = sections.get(sectionId);
    if (!section) return;
    section.items.push({
      role: item.role,
      title: item.title || "",
      text: item.text || "",
      check: item.check || "",
      why: item.why || "",
      neededFor: item.neededFor || [],
      learn: item.learn || null,
      confirm: item.confirm || "",
      condition: item.condition || "",
      where: item.where || "",
      // Extra fields for the Administrator setup guide. The checklist writers ignore them.
      phase: item.phase || sectionId,
      detail: item.detail || "",
      endpoints: item.endpoints || [],
      ownSystem: Boolean(item.ownSystem),
      adminId: item.adminId || "",
      order: item.order ?? 50,
    });
  };

  // 1. Administrator prerequisites (connectors, data policies, environment, tenant and cloud).
  const adminGroups = [admin.tenantAndCloud, admin.dlpAndAcp, admin.environmentSettings, admin.connectors];
  const hosts = new Map();
  let ownSystems = false;
  for (const group of adminGroups) {
    for (const entry of Array.isArray(group) ? group : []) {
      if (!entry || !entry.id) continue;
      adminIds.add(entry.id);
      const copy = ADMIN_COPY[entry.id];
      const isSite = entry.id === "sharepoint-site-and-sam-permissions";
      const siteOnly = isSite && !/advanced management|sharepoint administrator/i.test(String(entry.title || ""));
      const rawTitle = entry.title || entry.name;
      let item;
      if (siteOnly) {
        adminIds.add("sharepoint-test-site");
        item = {
          role: "sharepoint-admin",
          title: "A SharePoint test site",
          text: "Provide a non-production SharePoint site with sample document libraries where attendees are Site Owners (to create agents, columns, and flows) or Members (to test security-trimmed citations).",
          why: "Agents ground their answers in this site's documents.",
          order: 6,
        };
      } else if (copy) {
        item = { ...copy };
      } else {
        item = {
          role: group === admin.tenantAndCloud ? "tenant-admin" : "power-platform-admin",
          title: cleanChecklistText(rawTitle),
          text: ensurePeriod(stripOtherLinks(cleanChecklistText(entry.details))),
          why: "",
          order: 80,
        };
      }
      const split = splitConfirm(item.text || "");
      item.text = split.text;
      item.confirm = split.confirm;
      // The display name leads; the technical name is a secondary detail that helps an administrator find the connector in a
      // solution or a connection reference, and the connector's Microsoft Learn page is the source link.
      const connectorRefs = Array.isArray(entry.connectors) ? entry.connectors : [];
      if (connectorRefs.length) {
        item.text = `${item.text} ${technicalNameSentence(connectorRefs)}`.trim();
        if (!item.learn) item.learn = { label: `${connectorRefs[0].displayName} connector reference`, url: connectorRefs[0].learnUrl };
      }
      item.where = cleanChecklistText(entry.adminPath);
      item.neededFor = neededForFrom(entry.requiredBy);
      item.condition = conditionFor(entry.status);
      item.adminId = entry.id;
      if (group === admin.dlpAndAcp) item.phase = "policies";
      const fullDetail = ensurePeriod(adminWording(stripOtherLinks(cleanChecklistText(entry.details))));
      item.detail = fullDetail && !UNCONFIRMED_RE.test(fullDetail) ? fullDetail : "";
      const entryHosts = [];
      for (const endpoint of Array.isArray(entry.endpoints) ? entry.endpoints : []) {
        const host = hostOf(endpoint);
        if (host) entryHosts.push(host);
        else if (/[<>]/.test(String(endpoint))) item.ownSystem = true;
      }
      item.endpoints = entryHosts;
      if (entry.id === "dlp-business-group-alignment" && Array.isArray(admin.connectors) && admin.connectors.length) {
        const names = admin.connectors.filter((c) => c.dataGroup === "Business").map((c) => cleanChecklistText(c.name));
        if (names.length) item.text = `${item.text} Connectors in this workshop: ${joinNames(names)}.`;
      }
      let sectionId = copy?.section || (group === admin.tenantAndCloud ? "tenant" : group === admin.connectors ? "connectors" : "environment");
      if (siteOnly) sectionId = "data";
      addItem(sectionId, item);

      for (const endpoint of Array.isArray(entry.endpoints) ? entry.endpoints : []) {
        const host = hostOf(endpoint);
        if (host) {
          if (!hosts.has(host)) hosts.set(host, []);
          const label = cleanChecklistText(copy?.title || entry.name || entry.title);
          if (label && !hosts.get(host).includes(label)) hosts.get(host).push(label);
        } else if (/[<>]/.test(String(endpoint))) {
          ownSystems = true;
        }
      }
    }
  }

  // 2. The lab's own Prerequisites bullets.
  const handled = [];
  const productByShortName = new Map(products.map((p) => [p.shortName.toLowerCase(), p]));
  const hasScenarioData = lab.data.length > 0;
  for (const raw of lab.main) {
    const cleaned = cleanChecklistText(raw);
    if (!cleaned) continue;
    if (/you have already completed these topics/i.test(cleaned)) {
      handled.push(cleaned);
      continue;
    }
    const compound = splitCompound(cleaned);
    const pieces = compound
      ? compound.map((c) => ({ text: c.text, rule: c.rule, covers: c.covers }))
      : [{ text: cleaned, rule: classifyBullet(cleaned) || { section: "attendees", role: "workshop-host", order: 8 }, covers: null }];
    for (const piece of pieces) {
      const rule = piece.rule;
      if (rule.kind === "knowledge-source" && hasScenarioData) continue;
      if (rule.kind === "sharepoint-site") {
        const nameMatch =
          piece.text.match(/^target sharepoint site:\s*\[([^\]]+)\]/i) || piece.text.match(/^target sharepoint site:\s*([^—–]+?)\s+[—–-]\s/i);
        const label = nameMatch ? nameMatch[1].trim() : "";
        const named = label && !/[/.]/.test(label) ? ` named "${label}"` : "";
        addItem("data", {
          role: "sharepoint-admin",
          title: "The SharePoint site for the workshop",
          text: `Create the SharePoint site${named}, or confirm attendees can open it with the permissions the workshop needs. Your workshop contact will confirm the address.`,
          why: "Agents ground their answers in this site's documents.",
          order: 4,
        });
        continue;
      }
      const { text: bare, learn } = pullLearnLink(piece.text);
      const split = splitConfirm(bare);
      const coveredBy = piece.covers || rule.covers;
      if (coveredBy && adminIds.has(coveredBy) && !split.confirm) continue;
      addItem(rule.section || "attendees", {
        role: rule.role || "workshop-host",
        title: rule.title || "",
        text: ensurePeriod(split.text.replace(/^for admin (?:labs|workshops):\s*/i, "")),
        why: rule.why || "",
        learn,
        confirm: split.confirm,
        order: rule.order ?? 50,
      });
    }
  }

  // 3. Licensing bullets: one item per product license, and the preview caution as a note.
  const licenseNotes = [];
  for (const raw of lab.licensing) {
    const cleaned = cleanChecklistText(raw);
    const labeled = cleaned.match(/^(?:\*\*)?(License|Role|Preview features)(?:\s*\(([^)]+)\))?\.?(?:\*\*)?\s*(.*)$/i);
    if (!labeled) continue;
    const kind = labeled[1].toLowerCase();
    const body = labeled[3].replace(/\bModules that need more are called out in the list above\.?/i, "").trim();
    if (kind === "preview features") {
      licenseNotes.push(ensurePeriod(body.replace(/\bSome modules\b/, "Some topics")));
      continue;
    }
    const { text: bare, learn } = pullLearnLink(body);
    const split = splitConfirm(bare);
    if (kind === "role") {
      if (adminIds.has("alm-and-security-roles")) continue;
      addItem("attendees", {
        role: "power-platform-admin",
        title: "Permission to create agents",
        text: ensurePeriod(split.text),
        why: "Attendees cannot create agents without it.",
        learn,
        confirm: split.confirm,
        order: 4,
      });
      continue;
    }
    const productLabel = labeled[2] ? productByShortName.get(labeled[2].toLowerCase())?.name || labeled[2] : productByShortName.get("copilot studio")?.name || "Microsoft Copilot Studio";
    addItem("licenses", {
      role: "tenant-admin",
      title: `License for ${productLabel}`,
      text: ensurePeriod(split.text),
      why: `Needed so attendees can use ${productLabel}.`,
      learn,
      confirm: split.confirm,
      order: 3,
    });
  }
  if (!lab.licensing.length) {
    for (const product of products) {
      const split = splitConfirm(cleanChecklistText(product.licenseNote));
      if (!split.text && !split.confirm) continue;
      addItem("licenses", { role: "tenant-admin", title: `License for ${product.name}`, text: ensurePeriod(split.text), confirm: split.confirm, order: 3 });
    }
  }
  if (licenseNotes.length) sections.get("licenses").intro = licenseNotes.join(" ");

  // 4. Scenario data.
  for (const raw of lab.data) {
    const text = cleanChecklistText(pullLearnLink(raw).text);
    if (!text) continue;
    addItem("data", { role: "content-owner", text: ensurePeriod(text), why: "", order: 10 });
  }
  if (lab.dataNote) sections.get("data").intro = ensurePeriod(lab.dataNote.replace(/\bevery module\b/i, "every topic"));

  // 5. What attendees should already know.
  const recaps = recapModules(man);
  const assumed = assumedFromMarkdown(handled);
  const known = new Set();
  for (const recap of recaps) {
    if (known.has(recap.name.toLowerCase())) continue;
    known.add(recap.name.toLowerCase());
    addItem("knowledge", {
      role: "attendee",
      title: recap.name,
      text: "",
      why: "A short refresher is included in the workshop.",
      learn: recap.url ? { label: "Read on Microsoft Learn", url: recap.url } : null,
      order: 10,
    });
  }
  for (const name of assumed) {
    if (known.has(name.toLowerCase())) continue;
    known.add(name.toLowerCase());
    addItem("knowledge", {
      role: "attendee",
      title: name,
      text: "",
      why: "The workshop builds on it and does not teach it.",
      order: 11,
    });
  }
  if (sections.get("knowledge").items.length) {
    sections.get("knowledge").intro = "Attendees should already know the topics below, so please confirm they do or ask them to read the linked article first.";
  }

  // 6. Network and allow-list needs.
  for (const [host, usedBy] of [...hosts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    addItem("network", {
      role: "network-admin",
      title: host,
      text: `Allow outbound secure web traffic (HTTPS, port 443) to ${host}.`,
      why: usedBy.length ? `Used by: ${joinNames(usedBy.slice(0, 3))}${usedBy.length > 3 ? `, and ${usedBy.length - 3} more` : ""}.` : "",
      order: 10,
    });
  }
  if (ownSystems) {
    addItem("network", {
      role: "network-admin",
      title: "Addresses of your own systems",
      text: "The workshop connects to systems you own or choose, such as a custom API, an MCP server, or a software-as-a-service instance. Allow outbound secure web traffic to each address; your workshop contact will confirm the exact addresses.",
      why: "Blocked addresses stop the hands-on steps from working.",
      order: 90,
    });
  }

  // 7. Number the items: by section, then who does them, then the order the work should happen.
  const sectionList = [];
  let n = 0;
  for (const def of SECTION_DEFS) {
    const section = sections.get(def.id);
    if (!section.items.length) continue;
    section.items.sort((a, b) => {
      const roleDiff = (CHECKLIST_ROLES[a.role]?.order ?? 99) - (CHECKLIST_ROLES[b.role]?.order ?? 99);
      return roleDiff || a.order - b.order;
    });
    for (const item of section.items) {
      n += 1;
      item.n = n;
      item.roleLabel = CHECKLIST_ROLES[item.role]?.label || "Workshop host";
      if (!item.why) item.why = def.why;
      item.text = cleanChecklistText(item.text);
      item.check = cleanChecklistText(item.check);
      delete item.order;
    }
    sectionList.push({ id: section.id, title: section.title, intro: section.intro, items: section.items });
  }

  // 8. Who needs to be involved.
  const roleItems = new Map();
  for (const section of sectionList) {
    for (const item of section.items) {
      if (!roleItems.has(item.role)) roleItems.set(item.role, []);
      roleItems.get(item.role).push(item.n);
    }
  }
  const roles = [...roleItems.entries()]
    .sort((a, b) => (CHECKLIST_ROLES[a[0]]?.order ?? 99) - (CHECKLIST_ROLES[b[0]]?.order ?? 99))
    .map(([id, numbers]) => ({
      id,
      label: CHECKLIST_ROLES[id]?.label || "Workshop host",
      does: CHECKLIST_ROLES[id]?.does || "",
      items: numbers.sort((a, b) => a - b),
    }));

  const itemCount = n;
  const adminCount = roles.filter((r) => r.id !== "attendee").reduce((sum, r) => sum + r.items.length, 0);
  const attendeeCount = roleItems.get("attendee")?.length || 0;
  const hasConditions = sectionList.some((s) => s.items.some((i) => i.condition));
  const hasConfirm = sectionList.some((s) => s.items.some((i) => i.confirm));

  const brandInfo = brand && typeof brand === "object" ? brand : {};
  const customerName = cleanText(brandInfo.companyName) && !isDefaultCompanyName(brandInfo.companyName) ? cleanText(brandInfo.companyName) : "";
  const support = {
    name: cleanText(brandInfo.supportName),
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(brandInfo.supportEmail || "")) ? String(brandInfo.supportEmail) : "",
  };
  const moreInfoUrl = /^https:\/\//i.test(String(brandInfo.moreInfoUrl || "")) ? String(brandInfo.moreInfoUrl) : "";

  const summaryParts = [
    `Before the workshop "${title}", a few things need to be ready so attendees can build and test without waiting.`,
    itemCount
      ? `This checklist lists ${itemCount} item${itemCount === 1 ? "" : "s"} for ${roles.length} role${roles.length === 1 ? "" : "s"}, covering ${joinNames(products.map((p) => p.name))}.`
      : `This workshop covers ${joinNames(products.map((p) => p.name))}.`,
  ];
  if (itemCount && adminCount && attendeeCount) {
    summaryParts.push(`Most are one-time settings for your IT admins; ${attendeeCount} ${attendeeCount === 1 ? "applies" : "apply"} to each attendee.`);
  } else if (itemCount && adminCount) {
    summaryParts.push("Most are one-time settings for your IT admins.");
  }
  summaryParts.push("Please complete every item, tick it off, and send the checklist back before the workshop date.");

  const howToUse = [];
  if (roles.length > 1) howToUse.push("Send each person only their part: the \"Who needs to be involved\" table lists the item numbers for each role.");
  howToUse.push("Tick the box and write your name or the date in \"Done by / date\" when an item is ready.");
  if (hasConfirm) howToUse.push(`Where an item says \"${CONFIRM_WITH_MICROSOFT}\", ask them before the workshop: Microsoft Learn does not confirm it yet.`);
  if (hasConditions) howToUse.push("Items marked \"Only if\" apply to some organizations. Skip them if they do not apply to you.");

  const model = {
    schemaVersion: PREREQ_CHECKLIST_SCHEMA_VERSION,
    documentTitle: CHECKLIST_TITLE,
    banner: CHECKLIST_BANNER,
    title,
    products: products.map((p) => p.name),
    audience: audienceOf(man),
    dateText: formatDate(now),
    customerName,
    summary: summaryParts.join(" "),
    howToUse,
    roles,
    sections: sectionList,
    itemCount,
    contact: {
      name: support.name,
      email: support.email,
      moreInfo: moreInfoUrl ? { label: cleanText(brandInfo.moreInfoLabel) || "More information", url: moreInfoUrl } : null,
    },
    footerText: cleanText(brandInfo.footerText),
    confirm: {
      line: support.name || support.email
        ? `When every item is ticked, send this checklist back to ${[support.name, support.email].filter(Boolean).join(" at ")}.`
        : "When every item is ticked, send this checklist back to your workshop contact.",
      fields: ["Completed by (name)", "Date", "Workshop date"],
    },
  };
  return applyReplacements(model, replacements);
}

function applyReplacements(model, replacements) {
  const entries = Object.entries(replacements || {}).filter(([k, v]) => k && v && k !== v);
  if (!entries.length) return model;
  const walk = (value) => {
    if (typeof value === "string") return entries.reduce((text, [search, replace]) => text.split(search).join(replace), value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    return value;
  };
  return walk(model);
}

/** "1, 3-5, 9" */
export function formatItemNumbers(numbers) {
  const list = [...numbers].sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < list.length; ) {
    let j = i;
    while (j + 1 < list.length && list[j + 1] === list[j] + 1) j += 1;
    parts.push(j - i >= 2 ? `${list[i]}\u2013${list[j]}` : list.slice(i, j + 1).join(", "));
    i = j + 1;
  }
  return parts.join(", ");
}

/** Plain text of one checklist item, shared by the Markdown, PDF, and Word writers. */
export function checklistItemParts(item) {
  const why = [item.why, describeNeededFor(item.neededFor)].filter(Boolean).join(" ");
  return {
    title: item.title,
    text: item.text,
    where: item.where ? `Where: ${item.where}` : "",
    check: item.check || "",
    condition: item.condition,
    why,
    learn: item.learn,
    confirm: item.confirm,
  };
}

/**
 * Split a model string into plain, bold, and link pieces: `[label](https://...)` and `**bold**`.
 * Only http and https links survive, so no other scheme can reach a document.
 */
export function checklistInlineSegments(text) {
  const out = [];
  const source = String(text ?? "");
  const re = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|\*\*([^*]+)\*\*/g;
  let last = 0;
  let match;
  while ((match = re.exec(source)) !== null) {
    if (match.index > last) out.push({ text: source.slice(last, match.index) });
    if (match[1] !== undefined) out.push({ text: match[1], href: match[2] });
    else out.push({ text: match[3], bold: true });
    last = re.lastIndex;
  }
  if (last < source.length) out.push({ text: source.slice(last) });
  return out.filter((seg) => seg.text);
}

/** Text of a string with its link and bold marks removed (for labels and footers). */
export function checklistPlainText(text) {
  return checklistInlineSegments(text).map((seg) => seg.text).join("");
}
/** The file name a customer sees: "<Lab title> - Prerequisites checklist". */
export function checklistBaseName(title) {
  const clean = String(title || "Workshop").replace(/[<>:"/\\|?*\u0000-\u001F\u007F]+/g, " ").replace(/\s+/g, " ").trim().replace(/[. ]+$/g, "");
  const capped = (clean.length > 80 ? clean.slice(0, 80).trim() : clean) || "Workshop";
  return `${capped} - ${CHECKLIST_TITLE}`;
}

// ── Markdown ────────────────────────────────────────────────────────────────

function mdEscape(text) {
  return String(text || "").replace(/([\\*_[\]|])/g, "\\$1").replace(/\r?\n/g, " ");
}

/** The model as Markdown: a checklist per section, with who, why, and a blank "Done by" line on each item. */
export function renderPrerequisitesChecklistMarkdown(model) {
  const lines = [`# ${model.documentTitle}`, "", `**${model.title}**`, "", `_${model.banner}_`, ""];
  lines.push(`- **Products:** ${model.products.map(mdEscape).join("; ")}`);
  lines.push(`- **Audience:** ${mdEscape(model.audience)}`);
  lines.push(`- **Date:** ${model.dateText}`);
  if (model.customerName) lines.push(`- **Prepared for:** ${mdEscape(model.customerName)}`);
  lines.push("", model.summary, "", "## How to use this checklist", "", ...model.howToUse.map((line) => `- ${line}`), "");

  if (model.roles.length) {
    lines.push("## Who needs to be involved", "", "| Who | What they do | Items |", "|---|---|---|");
    for (const role of model.roles) {
      lines.push(`| ${mdEscape(role.label)} | ${mdEscape(role.does)} | ${formatItemNumbers(role.items)} |`);
    }
    lines.push("");
  }

  for (const section of model.sections) {
    lines.push(`## ${section.title}`, "");
    if (section.intro) lines.push(section.intro, "");
    for (const item of section.items) {
      const parts = checklistItemParts(item);
      const lead = parts.title ? `**${item.n}. ${mdEscape(parts.title)}**${parts.text ? ` \u2014 ${parts.text}` : ""}` : `**${item.n}.** ${parts.text}`;
      lines.push(`- [ ] ${lead}`);
      const meta = [`*Who:* ${mdEscape(item.roleLabel)}`];
      if (parts.where) meta.push(`*${mdEscape(parts.where)}*`);
      if (parts.check) meta.push(`*How to check:* ${parts.check}`);
      if (parts.condition) meta.push(`*${mdEscape(parts.condition)}*`);
      if (parts.why) meta.push(`*Why:* ${mdEscape(parts.why)}`);
      if (parts.learn) meta.push(`[${mdEscape(parts.learn.label)}](${parts.learn.url})`);
      if (parts.confirm) meta.push(`**${mdEscape(parts.confirm)}**`);
      meta.push("*Done by / date:* ____________");
      lines.push(`  ${meta.join(" \u00b7 ")}`, "");
    }
  }

  lines.push("## Confirm and return", "", model.confirm.line, "", ...model.confirm.fields.map((f) => `- ${f}: ____________`), "");
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

/** Whether a line of the rendered document would break the "only prerequisites" promise. Used by tests and the CLI. */
export function leakedBuilderContent(text) {
  const checks = [
    [/Screenshot to add/i, "screenshot placeholder"],
    [GUID_TEST_RE, "GUID"],
    [/\bStep \d+\b/i, "module step label"],
    [/Answer Key|Knowledge Check/i, "quiz content"],
    [/Facilitator/i, "facilitator content"],
    [/manifest\.json|shots\.json|generated-labs/i, "builder file name"],
  ];
  return checks.filter(([re]) => re.test(text)).map(([, label]) => label);
}
