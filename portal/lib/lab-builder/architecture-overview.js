/**
 * Dynamic, plan-driven Solution Architecture Overview model and multi-surface
 * blueprint renderers for generated labs.
 *
 * Replaces static, mode-only Mermaid flowcharts in `### Solution Architecture`
 * with a deterministic architecture model derived from the exact lab plan:
 * selected products (including multi-product labs), harness, level, industry,
 * roles, deliverable mode, scenario profile, and every included lab module
 * (`Step 1..M` and `Recap 1..K`).
 *
 * Zero npm dependencies: imports only local `./products.js` (which uses only
 * built-in `node:*` modules) so offline and standalone lab-builder checks pass.
 */

import { DEFAULT_PRODUCT, getProduct, productOf, productsPhrase } from "./products.js";

export const ARCHITECTURE_FENCE_LANG = "lab-architecture";

const HARNESS_LABELS = Object.freeze({
  standard: "Standard harness",
  "microsoft-copilot": "Microsoft Copilot harness",
  "customer-conversation": "Customer Conversation harness (preview)",
});

const LEVEL_NAMES = Object.freeze({
  100: "Beginner",
  200: "Intermediate",
  300: "Advanced",
});

const MODE_META = Object.freeze({
  "copilot-studio-agent": {
    kindLabel: "Copilot Studio Agent Architecture",
    isAgent: true,
    laneTitles: [
      "Audience & Channel Entry Points",
      "Core Agent & Orchestration Engine",
      "Grounded Knowledge, Tools & Actions",
    ],
    laneSubtitles: [
      "Who initiates requests and which conversational or SDK channels host the experience",
      "Instructions, reasoning model, topics, skills, and multi-agent orchestration built in this lab",
      "Permission-trimmed knowledge sources, connectors, MCP tools, workflows, and enterprise systems",
    ],
    defaultSurface: (harness) => {
      if (harness === "customer-conversation") {
        return {
          icon: "phone",
          title: "Voice, Web Chat & Omnichannel Surface",
          role: "Customer-facing chat and voice entry point routing live inquiries into the primary agent.",
        };
      }
      if (harness === "microsoft-copilot") {
        return {
          icon: "chat",
          title: "Microsoft 365 Copilot & Teams Chat",
          role: "Enterprise chat surface where signed-in users invoke the agent in daily flow of work.",
        };
      }
      return {
        icon: "chat",
        title: "Copilot Studio Test Pane & Published Channels",
        role: "Interactive conversation canvas and published Microsoft 365 or web channels.",
      };
    },
    anchorRole: (domain, productsText, harnessLabel) =>
      `${productsText} solution${harnessLabel ? ` on the ${harnessLabel}` : ""} orchestrating ${domain}.`,
  },
  "declarative-agent": {
    kindLabel: "Declarative Agent Blueprint (Microsoft 365 Copilot)",
    isAgent: true,
    laneTitles: [
      "Users & Authoring Surfaces",
      "Declarative Agent & Orchestrator",
      "Scoped Knowledge, Plugins & MCP Actions",
    ],
    laneSubtitles: [
      "Target Microsoft 365 users, Copilot Chat host, and maker or pro-code authoring tools",
      "Microsoft 365 Copilot orchestrator paired with declarative instructions, templates, and skills",
      "Scoped SharePoint, Graph, API plugins, OAuth MCP servers, and built-in capabilities",
    ],
    defaultSurface: () => ({
      icon: "chat",
      title: "Microsoft 365 Copilot Chat",
      role: "In-context Copilot Chat experience where licensed users @mention and run the declarative agent.",
    }),
    anchorRole: (domain) =>
      `Declarative agent running on the Microsoft 365 Copilot orchestrator for ${domain}.`,
  },
  "declarative-agent-governance": {
    kindLabel: "Declarative Agent Governance Blueprint",
    isAgent: false,
    laneTitles: [
      "Administrators, Makers & Users",
      "Agent Registry & Governance Controls",
      "Scoped Catalog, Access & Data Prerequisites",
    ],
    laneSubtitles: [
      "IT administrators, agent makers, and target business groups governed by tenant policy",
      "Microsoft 365 admin center registry, submission review, owner rules, and sharing policies",
      "Approved org catalog distribution, user/group scoping, and Copilot connector prerequisites",
    ],
    defaultSurface: () => ({
      icon: "admin",
      title: "Microsoft 365 Admin Center",
      role: "Administrative control plane for reviewing declarative agent submissions, owners, and policies.",
    }),
    anchorRole: (domain) =>
      `Tenant governance operating model controlling declarative agent publishing and access for ${domain}.`,
  },
  "m365-copilot-governance": {
    kindLabel: "Microsoft 365 Copilot Governance Blueprint",
    isAgent: false,
    laneTitles: [
      "Administrators & Licensed Workforce",
      "Copilot Hub & Policy Control Plane",
      "Protected Tenant Data & Agent Controls",
    ],
    laneSubtitles: [
      "Tenant administrators configuring controls and business teams consuming Microsoft 365 Copilot",
      "Copilot control system pillars: licensing, PAYG billing, agent lifecycle, and chat policies",
      "SharePoint oversharing remediation, Restricted Content Discovery, web grounding, and Purview DLP",
    ],
    defaultSurface: () => ({
      icon: "admin",
      title: "Microsoft 365 Admin Center (Copilot Hub)",
      role: "Centralized hub for Copilot readiness, licensing, security posture, and agent governance.",
    }),
    anchorRole: (domain) =>
      `Tenant-wide Microsoft 365 Copilot governance, data protection, and adoption baseline for ${domain}.`,
  },
  "power-platform-ai-builder": {
    kindLabel: "Power Platform AI Builder Blueprint",
    isAgent: false,
    laneTitles: [
      "Business Apps, Makers & Triggers",
      "AI Hub Prompts & Custom AI Models",
      "Cloud Flows, Dataverse & Downstream Actions",
    ],
    laneSubtitles: [
      "Business users, canvas apps, and incoming documents or records triggering intelligent processing",
      "AI Builder prompt builder, prebuilt models, custom document/prediction models, and human review",
      "Power Automate orchestration, Power Fx bindings, Dataverse tables, and structured outputs",
    ],
    defaultSurface: () => ({
      icon: "app",
      title: "Power Platform Maker Portal & AI Hub",
      role: "Authoring and invocation surface for AI Builder prompts, models, apps, and cloud flows.",
    }),
    anchorRole: (domain) =>
      `AI Builder intelligent automation pipeline processing structured prompts and models for ${domain}.`,
  },
  "power-platform-ai-governance": {
    kindLabel: "Power Platform AI Governance Blueprint",
    isAgent: false,
    laneTitles: [
      "Platform Admins & Maker Teams",
      "Environment Governance & Capacity Plane",
      "Governed AI Models, DLP & Managed Solutions",
    ],
    laneSubtitles: [
      "Power Platform administrators and environment makers operating governed AI workloads",
      "Feature toggles, security roles, Copilot Credits allocation, and capacity enforcement",
      "Protected AI Builder prompts/models, DLP connector boundaries, activity logs, and solution ALM",
    ],
    defaultSurface: () => ({
      icon: "admin",
      title: "Power Platform Admin Center",
      role: "Environment administration console for AI Builder governance, credits, roles, and policies.",
    }),
    anchorRole: (domain) =>
      `Environment governance, credit management, and ALM control plane supporting ${domain}.`,
  },
  "sharepoint-agent": {
    kindLabel: "SharePoint Grounded Agent Blueprint",
    isAgent: true,
    laneTitles: [
      "Site Members & Collaboration Surfaces",
      "SharePoint Agent & Access Scoping",
      "Permission-Trimmed Sites & Libraries",
    ],
    laneSubtitles: [
      "Site visitors, content owners, and Teams or SharePoint pages where questions are asked",
      "SharePoint-authored agent instructions, .agent lifecycle, and site-scoped sharing rules",
      "Approved SharePoint sites, document libraries, metadata columns, and SAM access boundaries",
    ],
    defaultSurface: () => ({
      icon: "sharepoint",
      title: "SharePoint Sites & Microsoft Teams",
      role: "In-place site and chat experience respecting each signed-in user's SharePoint permissions.",
    }),
    anchorRole: (domain) =>
      `SharePoint-grounded agent answering questions strictly from permission-trimmed content for ${domain}.`,
  },
  "sharepoint-content-ai": {
    kindLabel: "SharePoint Content Intelligence Blueprint",
    isAgent: false,
    laneTitles: [
      "Content Contributors & Library Views",
      "SharePoint AI Extraction & Processing",
      "Document Libraries & Structured Metadata",
    ],
    laneSubtitles: [
      "Information workers uploading files and consuming enriched SharePoint library views",
      "Autofill metadata prompts and prebuilt document processing models powered by Copilot Credits",
      "Target SharePoint document libraries, extracted structured columns, and site governance rules",
    ],
    defaultSurface: () => ({
      icon: "sharepoint",
      title: "SharePoint Document Libraries",
      role: "Upload and review workspace where unstructured files become structured library metadata.",
    }),
    anchorRole: (domain) =>
      `Automated SharePoint document classification and metadata extraction pipeline for ${domain}.`,
  },
  "sharepoint-governance": {
    kindLabel: "SharePoint Advanced Management Blueprint",
    isAgent: false,
    laneTitles: [
      "SharePoint Admins & Site Owners",
      "SharePoint Advanced Management (SAM)",
      "Governed Sites, Access Reviews & Lifecycle",
    ],
    laneSubtitles: [
      "SharePoint administrators and delegated site owners governing Copilot content readiness",
      "Oversharing assessments, Restricted Content Discovery, Restricted Access Control, and Admin Agent",
      "High-business-impact SharePoint sites, agent reach policies, and inactive site lifecycle rules",
    ],
    defaultSurface: () => ({
      icon: "admin",
      title: "SharePoint Admin Center (SAM)",
      role: "Administrative workspace for oversharing reports, site access policies, and AI readiness.",
    }),
    anchorRole: (domain) =>
      `SharePoint Advanced Management governance framework protecting content discovery for ${domain}.`,
  },
  "foundry-agent": {
    kindLabel: "Microsoft Foundry Agent Blueprint",
    isAgent: true,
    laneTitles: [
      "Developers, Playground & Published Channels",
      "Foundry Project, Agent Service & Models",
      "Search Indexes, File Grounding & Toolboxes",
    ],
    laneSubtitles: [
      "AI engineers, playground test harnesses, and published Microsoft Copilot or Teams endpoints",
      "Microsoft Foundry project, Agent Service instructions, hosted code agents, and model deployments",
      "Azure AI Search hybrid indexes, grounded file search, shared Foundry toolboxes, and CS bridges",
    ],
    defaultSurface: () => ({
      icon: "code",
      title: "Microsoft Foundry Portal & Agent Playground",
      role: "Interactive engineering workspace for testing prompts, tool calls, and agent runs.",
    }),
    anchorRole: (domain) =>
      `Microsoft Foundry Agent Service solution combining deployed models, grounding, and tools for ${domain}.`,
  },
  "foundry-models-platform": {
    kindLabel: "Microsoft Foundry Platform & Model Blueprint",
    isAgent: false,
    laneTitles: [
      "AI Engineers, Stakeholders & Playground",
      "Foundry Project & Model Deployments",
      "Quota, Guardrails & Workload Endpoints",
    ],
    laneSubtitles: [
      "Engineering teams provisioning workspaces and benchmarking candidate models in the playground",
      "Microsoft Foundry project or hub isolation, model catalog selection, and managed deployments",
      "Regional quota allocation, safety guardrails, RBAC boundaries, and downstream workload endpoints",
    ],
    defaultSurface: () => ({
      icon: "code",
      title: "Microsoft Foundry Portal & Playground",
      role: "Workspace for model catalog evaluation, parameter tuning, and benchmark prompt validation.",
    }),
    anchorRole: (domain) =>
      `Governed Microsoft Foundry project and model deployment workspace serving ${domain}.`,
  },
});

/**
 * Curated mapping from catalog feature IDs to architecture blueprint placement.
 * Every rule specifies:
 *   - `zone`: `"experience"` | `"orchestration"` | `"grounding"` | `"foundation"` | `"anchor"`
 *   - `group`: merge key so closely paired harness variants share one clean card while
 *     distinct architectural capabilities remain independent cards!
 *   - `icon`: semantic SVG icon key
 *   - `title`: concise component name (US English, current Microsoft product terminology)
 *   - `role`: function `(ctx) => string` describing the component's concrete role in this lab
 */
const FEATURE_RULES = Object.freeze({
  // ── Anchor / Core Creation & Workspace Setup (attaches badges to primary anchor card) ──
  "create-agent": { zone: "anchor" },
  "mc-create-agent": { zone: "anchor" },
  "cc-create-agent": { zone: "anchor" },
  "mc-harness-choice": { zone: "anchor" },
  "cc-harness-choice": { zone: "anchor" },
  "dca-declarative-agents-overview": { zone: "anchor" },
  "dca-licensing-and-environment": { zone: "anchor" },
  "dca-agent-builder-first-agent": { zone: "anchor" },
  "spai-build-agent-sharepoint-content": { zone: "anchor" },
  "spai-sam-overview-and-licensing": { zone: "anchor" },
  "fdy-create-foundry-project": { zone: "anchor" },
  "fdy-create-hub-based-project": { zone: "anchor" },
  "fdy-create-prompt-agent": { zone: "anchor" },
  "ppai-explore-ai-hub-models": { zone: "anchor" },
  "ppai-check-region-and-prerequisites": { zone: "anchor" },

  // ── Lane 1: Audience & Experience / Entry Points ──────────────────────────
  "publish-agent": {
    zone: "experience",
    group: "exp-publish-channels",
    icon: "channel",
    title: "Published Agent Channels",
    role: (c) => `Publishes ${c.name} from draft authoring to live channels for ${c.audience}.`,
  },
  "mc-publish-agent": {
    zone: "experience",
    group: "exp-m365-teams",
    icon: "chat",
    title: "Microsoft 365 Copilot & Teams Channels",
    role: (c) => `Publishes ${c.name} on the Microsoft Copilot harness for ${c.audience}.`,
  },
  "channel-teams": {
    zone: "experience",
    group: "exp-m365-teams",
    icon: "chat",
    title: "Microsoft Teams & Microsoft 365 Chat",
    role: (c) => `Delivers conversational access inside Teams chats, channels, and Microsoft 365 Copilot for ${c.audience}.`,
  },
  "fdy-publish-agent-copilot-teams": {
    zone: "experience",
    group: "exp-m365-teams",
    icon: "chat",
    title: "Microsoft Copilot & Teams Channel Publication",
    role: (c) => `Exposes the Microsoft Foundry agent directly inside Microsoft Copilot and Teams for ${c.audience}.`,
  },
  "fdy-troubleshoot-publishing": {
    zone: "experience",
    group: "exp-m365-teams",
    icon: "chat",
    title: "Published Channel Diagnostics",
    role: () => "Verifies channel registration, health, and end-user reachability after publication.",
  },
  "channel-web-sdk": {
    zone: "experience",
    group: "exp-web-sdk",
    icon: "code",
    title: "Web, Native App & Microsoft 365 Agents SDK",
    role: (c) => `Embeds ${c.name} into custom web or native client experiences via the Agents SDK.`,
  },
  "mc-sdk-agent": {
    zone: "experience",
    group: "exp-web-sdk",
    icon: "code",
    title: "Microsoft 365 Agents SDK Host Connection",
    role: () => "Connects a custom-coded Microsoft 365 Agents SDK endpoint into the Copilot experience.",
  },
  "voice-agents": {
    zone: "experience",
    group: "exp-voice",
    icon: "phone",
    title: "Real-Time Interactive Voice Channel",
    role: (c) => `Handles spoken caller turns with speech recognition, barge-in, and low-latency synthesis for ${c.domain}.`,
  },
  "cc-voice-settings": {
    zone: "experience",
    group: "exp-voice",
    icon: "phone",
    title: "Customer Voice & Speech Persona",
    role: () => "Configures voice synthesis profiles, speaking rate, and speech-specific turn handling.",
  },
  "cc-teams-phone": {
    zone: "experience",
    group: "exp-teams-phone",
    icon: "phone",
    title: "Microsoft Teams Phone PSTN Channel",
    role: (c) => `Routes inbound telephony calls through Teams Phone queues directly to ${c.name}.`,
  },
  "cc-deploy-channels": {
    zone: "experience",
    group: "exp-cc-web",
    icon: "channel",
    title: "Demo Website & Embedded Web Chat",
    role: (c) => `Deploys ${c.name} to web chat widgets and stakeholder validation portals.`,
  },
  "cc-contact-center": {
    zone: "experience",
    group: "exp-contact-center",
    icon: "phone",
    title: "Dynamics 365 Contact Center",
    role: () => "Connects omnichannel queues, routing rules, and live supervisor handoff workspaces.",
  },
  "vscode-authoring": {
    zone: "experience",
    group: "exp-procode-authoring",
    icon: "code",
    title: "VS Code Agent Authoring",
    role: () => "Synchronizes declarative definitions and source-controlled agent assets in Visual Studio Code.",
  },
  "dca-toolkit-typespec-agent": {
    zone: "experience",
    group: "exp-procode-authoring",
    icon: "code",
    title: "Microsoft 365 Agents Toolkit & TypeSpec",
    role: () => "Defines strongly typed declarative agent manifests and capabilities in TypeSpec.",
  },
  "dca-toolkit-json-capabilities-action": {
    zone: "experience",
    group: "exp-procode-authoring",
    icon: "code",
    title: "Agents Toolkit JSON Manifests",
    role: () => "Authors raw declarative manifest JSON with explicit capabilities and API action bindings.",
  },
  "dca-toolkit-developer-mode": {
    zone: "experience",
    group: "exp-procode-debug",
    icon: "code",
    title: "Copilot Developer Mode Diagnostics",
    role: () => "Inspects orchestrator plugin selection, grounding hits, and execution payloads in Copilot Chat.",
  },
  "dca-agent-builder-share-agent": {
    zone: "experience",
    group: "exp-dca-share",
    icon: "channel",
    title: "Scoped Sharing & Co-Owner Access",
    role: (c) => `Distributes ${c.name} to designated security groups and co-owners in Microsoft 365.`,
  },
  "dca-agent-builder-share-and-catalog": {
    zone: "experience",
    group: "exp-dca-catalog",
    icon: "channel",
    title: "Organization Agent Catalog",
    role: (c) => `Publishes ${c.name} to the tenant-approved catalog in Microsoft 365 Copilot Chat.`,
  },
  "spai-copilot-in-sharepoint-overview": {
    zone: "experience",
    group: "exp-sp-surface",
    icon: "sharepoint",
    title: "Copilot in SharePoint Experience",
    role: (c) => `Entry point across modern SharePoint sites, pages, and document libraries for ${c.audience}.`,
  },
  "spai-share-agent-and-manage-access": {
    zone: "experience",
    group: "exp-sp-share",
    icon: "sharepoint",
    title: "SharePoint Site & Teams Sharing",
    role: (c) => `Shares ${c.name} across site navigation and Teams chats while honoring site permissions.`,
  },
  "spai-manage-copilot-availability": {
    zone: "experience",
    group: "exp-sp-availability",
    icon: "admin",
    title: "SharePoint Copilot Availability Controls",
    role: () => "Scopes where Copilot in SharePoint surfaces are enabled across sites and user groups.",
  },
  "m365h-copilot-controls-overview": {
    zone: "experience",
    group: "exp-m365-hub",
    icon: "admin",
    title: "Microsoft 365 Admin Center Copilot Hub",
    role: () => "Administrative command center spanning security, management, and measurement pillars.",
  },
  "m365h-tour-copilot-settings": {
    zone: "experience",
    group: "exp-m365-hub",
    icon: "admin",
    title: "Microsoft 365 Copilot Tenant Settings",
    role: () => "Configures tenant-wide Copilot feature switches, grounding toggles, and admin roles.",
  },
  "m365h-pin-copilot-chat": {
    zone: "experience",
    group: "exp-copilot-chat-pin",
    icon: "chat",
    title: "Pinned Microsoft 365 Copilot Chat",
    role: (c) => `Pins Copilot Chat across Teams, Outlook, and Microsoft 365 apps for ${c.audience}.`,
  },
  "m365h-restrict-copilot-chat-access": {
    zone: "experience",
    group: "exp-copilot-chat-pin",
    icon: "chat",
    title: "Scoped Copilot Chat Access Policy",
    role: (c) => `Controls which user populations in ${c.audience} can launch Copilot Chat surfaces.`,
  },
  "ppai-use-prompt-in-flow-and-app": {
    zone: "experience",
    group: "exp-pp-apps",
    icon: "app",
    title: "Power Apps & Power Automate Host Surfaces",
    role: (c) => `Surfaces AI Builder prompt outputs inside interactive apps and business flows for ${c.audience}.`,
  },
  "ppai-powerfx-ai-models-in-canvas-app": {
    zone: "experience",
    group: "exp-pp-canvas",
    icon: "app",
    title: "Power Apps Canvas App (Power Fx)",
    role: (c) => `Invokes AI Builder models inline from canvas app controls via Power Fx formulas for ${c.audience}.`,
  },
  "fdy-orient-foundry": {
    zone: "experience",
    group: "exp-foundry-portal",
    icon: "code",
    title: "Microsoft Foundry Portal & Workspace",
    role: () => "Unified engineering portal for model catalogs, playgrounds, agents, evaluations, and tracing.",
  },

  // ── Lane 2: Core Deliverable & Orchestration Engine ───────────────────────
  "agent-instructions": {
    zone: "orchestration",
    group: "orch-instructions",
    icon: "spark",
    title: "Instructions, Persona & Scope Boundaries",
    role: (c) => `Defines tone, domain rules, and explicit out-of-scope guardrails for ${c.domain}.`,
  },
  "mc-instructions": {
    zone: "orchestration",
    group: "orch-instructions",
    icon: "spark",
    title: "Agent Details & System Instructions",
    role: (c) => `Steers reasoning behavior, citations, and refusal boundaries on the Microsoft Copilot harness.`,
  },
  "cc-instructions": {
    zone: "orchestration",
    group: "orch-instructions",
    icon: "spark",
    title: "Speech & Chat Instructions",
    role: (c) => `Tailors separate voice and chat guidance for customer conversations in ${c.domain}.`,
  },
  "dca-write-agent-instructions": {
    zone: "orchestration",
    group: "orch-instructions",
    icon: "spark",
    title: "Declarative Instructions & Conversation Starters",
    role: (c) => `Guides the Microsoft 365 Copilot orchestrator on workflow steps and boundaries for ${c.domain}.`,
  },
  "dca-agent-builder-templates-icon-mode": {
    zone: "orchestration",
    group: "orch-dca-template",
    icon: "cpu",
    title: "Agent Template, Branding & Response Mode",
    role: () => "Configures starter template metadata, visual identity, and orchestrator response mode.",
  },
  "dca-agent-builder-vs-copilot-studio": {
    zone: "orchestration",
    group: "orch-upgrade-bridge",
    icon: "cpu",
    title: "Agent Builder to Copilot Studio Promotion",
    role: () => "Evaluates architectural fit and promotes declarative agents into full Copilot Studio workflows.",
  },
  "mc-upgrade-from-standard": {
    zone: "orchestration",
    group: "orch-upgrade-bridge",
    icon: "cpu",
    title: "Standard to Microsoft Copilot Harness Upgrade",
    role: () => "Migrates a classic standard-harness agent onto the reasoning-centric Microsoft Copilot harness.",
  },
  "spai-upgrade-agent-files": {
    zone: "orchestration",
    group: "orch-upgrade-bridge",
    icon: "cpu",
    title: "Legacy .agent to Agent Builder Upgrade",
    role: () => "Upgrades classic SharePoint .agent definitions into modern Agent Builder declarative agents.",
  },
  "generative-orchestration": {
    zone: "orchestration",
    group: "orch-generative",
    icon: "cpu",
    title: "Generative Orchestration Planner",
    role: () => "Dynamically selects topics, knowledge sources, and tools per turn from descriptions and context.",
  },
  "model-selection": {
    zone: "orchestration",
    group: "orch-model-choice",
    icon: "cpu",
    title: "Foundation Model Selection",
    role: (c) => `Chooses the reasoning model balancing latency, accuracy, and cost for ${c.domain}.`,
  },
  "mc-model-selection": {
    zone: "orchestration",
    group: "orch-model-choice",
    icon: "cpu",
    title: "Reasoning Model Selection",
    role: (c) => `Selects the primary reasoning model powering ${c.name} on the Microsoft Copilot harness.`,
  },
  "cc-model-mode": {
    zone: "orchestration",
    group: "orch-model-choice",
    icon: "cpu",
    title: "Customer Conversation Model Mode",
    role: () => "Balances real-time conversational responsiveness and deep reasoning across voice and chat.",
  },
  topics: {
    zone: "orchestration",
    group: "orch-topics",
    icon: "branch",
    title: "Structured Topics & Trigger Phrases",
    role: (c) => `Deterministic conversation paths for high-compliance or multi-step ${c.domain} dialogs.`,
  },
  "entities-variables": {
    zone: "orchestration",
    group: "orch-entities",
    icon: "branch",
    title: "Entities, Slot Filling & Variables",
    role: () => "Extracts structured business identifiers, dates, and state across multi-turn dialogs.",
  },
  "adaptive-cards": {
    zone: "orchestration",
    group: "orch-adaptive-cards",
    icon: "app",
    title: "Adaptive Cards & Interactive Forms",
    role: () => "Renders rich visual summaries and structured confirmation inputs inside conversation turns.",
  },
  "power-fx": {
    zone: "orchestration",
    group: "orch-powerfx",
    icon: "code",
    title: "Power Fx Topic Expressions",
    role: () => "Evaluates conditional branching, data transformations, and validation rules inline.",
  },
  "cc-events": {
    zone: "orchestration",
    group: "orch-events",
    icon: "branch",
    title: "Conversation Lifecycle Events",
    role: () => "Handles session start, silence timeouts, and state transitions during customer calls.",
  },
  "mc-memory": {
    zone: "orchestration",
    group: "orch-memory",
    icon: "spark",
    title: "Cross-Session Agent Memory",
    role: () => "Retains user context and prior interaction summaries within governed retention windows.",
  },
  "cc-memory": {
    zone: "orchestration",
    group: "orch-memory",
    icon: "spark",
    title: "Customer Profile & History Memory",
    role: () => "Recalls returning customer profile attributes and open intents across conversations.",
  },
  "mc-created-files": {
    zone: "orchestration",
    group: "orch-created-files",
    icon: "file",
    title: "Generated Document & File Outputs",
    role: () => "Produces downloadable reports and structured artifacts directly from agent reasoning.",
  },
  "mc-skills": {
    zone: "orchestration",
    group: "orch-skills",
    icon: "spark",
    title: "Reusable Agent Skills",
    role: (c) => `Packages modular instructions and tools into composable skills for ${c.domain}.`,
  },
  "cc-skills": {
    zone: "orchestration",
    group: "orch-skills",
    icon: "spark",
    title: "Customer Conversation Skills",
    role: (c) => `Encapsulates repeatable customer resolution procedures for ${c.domain}.`,
  },
  "dca-agent-builder-skills": {
    zone: "orchestration",
    group: "orch-skills",
    icon: "spark",
    title: "Agent Builder Modular Skills",
    role: () => "Attaches reusable specialized skills to extend declarative agent reasoning.",
  },
  "prompt-tools": {
    zone: "orchestration",
    group: "orch-prompts",
    icon: "spark",
    title: "Custom Prompt Tools",
    role: (c) => `Executes parameterized generative prompts with structured outputs for ${c.domain}.`,
  },
  "ppai-build-custom-prompt": {
    zone: "orchestration",
    group: "orch-prompts",
    icon: "spark",
    title: "AI Builder Custom Prompt",
    role: (c) => `Authors reusable prompt instructions grounded in ${c.domain} inputs and formatting rules.`,
  },
  "ppai-prompt-inputs-and-model-settings": {
    zone: "orchestration",
    group: "orch-prompt-tuning",
    icon: "cpu",
    title: "Prompt Inputs & Model Parameters",
    role: () => "Binds runtime input variables, temperature, and model selection for consistent outputs.",
  },
  "ppai-human-review-prompt-output": {
    zone: "orchestration",
    group: "orch-human-review",
    icon: "users",
    title: "Human-in-the-Loop Approval Gate",
    role: () => "Routes AI-generated prompt outputs to a human reviewer before committing business actions.",
  },
  "ppai-migrate-from-text-generation": {
    zone: "orchestration",
    group: "orch-prompt-migration",
    icon: "spark",
    title: "Modern Prompt Builder Migration",
    role: () => "Replaces legacy text-generation actions with governed prompt builder templates.",
  },
  "ppai-predict-action-dynamic-model": {
    zone: "orchestration",
    group: "orch-dynamic-predict",
    icon: "branch",
    title: "Dynamic Runtime Model Routing (Predict)",
    role: () => "Selects the target AI Builder model dynamically at run time using the Predict action.",
  },
  "ppai-prebuilt-sentiment-analysis": {
    zone: "orchestration",
    group: "orch-ppai-sentiment",
    icon: "cpu",
    title: "Prebuilt Sentiment Analysis Model",
    role: () => "Scores positive, neutral, and negative sentiment signals across incoming text.",
  },
  "ppai-prebuilt-receipt-processing-flow": {
    zone: "orchestration",
    group: "orch-ppai-receipt",
    icon: "file",
    title: "Prebuilt Receipt Processing Model",
    role: () => "Extracts merchant, line-item, tax, and total fields from uploaded receipt images.",
  },
  "ppai-document-processing-model": {
    zone: "orchestration",
    group: "orch-ppai-doc",
    icon: "file",
    title: "Custom Document Processing Model",
    role: (c) => `Trains and publishes a custom layout extraction model for ${c.domain} documents.`,
  },
  "ppai-category-classification-model": {
    zone: "orchestration",
    group: "orch-ppai-classify",
    icon: "branch",
    title: "Custom Category Classification Model",
    role: (c) => `Classifies incoming ${c.domain} records into business routing categories.`,
  },
  "ppai-prediction-model": {
    zone: "orchestration",
    group: "orch-ppai-predict-model",
    icon: "cpu",
    title: "Historical Dataverse Prediction Model",
    role: () => "Predicts business outcomes from historical Microsoft Dataverse table patterns.",
  },
  "spai-autofill-columns": {
    zone: "orchestration",
    group: "orch-spai-autofill",
    icon: "spark",
    title: "SharePoint AI Autofill Columns",
    role: () => "Runs natural-language extraction prompts to populate library metadata columns automatically.",
  },
  "spai-prebuilt-document-processing": {
    zone: "orchestration",
    group: "orch-spai-docproc",
    icon: "file",
    title: "SharePoint Prebuilt Document Processing",
    role: () => "Extracts structured contract, invoice, or receipt fields directly on library upload.",
  },
  "fdy-explore-model-catalog": {
    zone: "orchestration",
    group: "orch-fdy-catalog",
    icon: "cpu",
    title: "Foundry Model Catalog Selection",
    role: (c) => `Evaluates benchmark, modality, and licensing fit across candidate models for ${c.domain}.`,
  },
  "fdy-deploy-test-model": {
    zone: "orchestration",
    group: "orch-fdy-deploy",
    icon: "cpu",
    title: "Deployed Foundry Model Endpoint",
    role: () => "Hosts the selected foundation model deployment and validates responses in the playground.",
  },
  "fdy-deploy-hosted-agent": {
    zone: "orchestration",
    group: "orch-fdy-hosted",
    icon: "code",
    title: "Hosted Container Agent (Azure Developer CLI)",
    role: () => "Packages and deploys custom containerized agent runtime code via Azure Developer CLI.",
  },
  "connected-agents": {
    zone: "orchestration",
    group: "orch-subagents",
    icon: "network",
    title: "Connected Specialist Agents",
    role: () => "Delegates domain-specific requests to child or peer specialist agents.",
  },
  "mc-connected-agents": {
    zone: "orchestration",
    group: "orch-subagents",
    icon: "network",
    title: "Connected Specialist Agents",
    role: () => "Routes specialized subtasks to connected agents on the Microsoft Copilot harness.",
  },
  "cc-sub-agents": {
    zone: "orchestration",
    group: "orch-subagents",
    icon: "network",
    title: "Customer Conversation Sub-Agents",
    role: () => "Hands off specialized intents to modular sub-agents within the same customer session.",
  },
  "agent-to-agent": {
    zone: "orchestration",
    group: "orch-a2a",
    icon: "network",
    title: "Agent2Agent (A2A) Protocol Federation",
    role: () => "Interoperates securely with external remote agents over the Agent2Agent protocol.",
  },
  "cc-connected-agent": {
    zone: "orchestration",
    group: "orch-foundry-bridge",
    icon: "network",
    title: "Microsoft Foundry Connected Agent",
    role: () => "Invokes a specialized Microsoft Foundry agent from the Customer Conversation orchestrator.",
  },
  "fdy-connect-agent-to-copilot-studio": {
    zone: "orchestration",
    group: "orch-foundry-bridge",
    icon: "network",
    title: "Foundry-to-Copilot Studio Agent Bridge",
    role: () => "Connects a Microsoft Foundry agent into Copilot Studio channels and orchestration.",
  },
  "mc-triggers": {
    zone: "orchestration",
    group: "orch-triggers",
    icon: "bolt",
    title: "Event Triggers & Autonomous Runs",
    role: () => "Wakes the agent automatically on system, schedule, or data events without user prompts.",
  },
  "mc-hooks": {
    zone: "orchestration",
    group: "orch-hooks",
    icon: "shield",
    title: "Execution Lifecycle Hooks",
    role: () => "Intercepts pre- and post-execution steps to validate inputs, context, or policy rules.",
  },
  // Governance-mode core engines (when governance modules ARE the primary orchestration plane)
  "m365h-assign-copilot-licenses": {
    zone: "orchestration",
    group: "orch-m365-licensing",
    icon: "key",
    title: "Microsoft Copilot License Provisioning",
    role: (c) => `Assigns seat licenses and prerequisite service plans to ${c.audience}.`,
  },
  "m365h-review-agent-inventory": {
    zone: "orchestration",
    group: "orch-m365-registry",
    icon: "admin",
    title: "Tenant Agent Registry & Inventory",
    role: () => "Catalogs every first-party, partner, and custom agent active across the tenant.",
  },
  "m365h-control-agent-availability": {
    zone: "orchestration",
    group: "orch-m365-availability",
    icon: "admin",
    title: "Agent Access & Availability Rules",
    role: (c) => `Scopes which agents are enabled for specific user groups in ${c.audience}.`,
  },
  "m365h-approve-agent-requests": {
    zone: "orchestration",
    group: "orch-m365-approval",
    icon: "shield",
    title: "Policy-Driven Agent Approval Workflow",
    role: () => "Evaluates maker submissions against policy templates before org-wide publication.",
  },
  "m365h-agent-lifecycle-actions": {
    zone: "orchestration",
    group: "orch-m365-lifecycle",
    icon: "admin",
    title: "Agent Block, Restore & Owner Reassignment",
    role: () => "Enforces lifecycle interventions for non-compliant or ownerless tenant agents.",
  },
  "m365h-agent-management-rules": {
    zone: "orchestration",
    group: "orch-m365-rules",
    icon: "bolt",
    title: "Automated Governance Rules & Tags",
    role: () => "Automates governance tagging, feedback controls, and policy enforcement at scale.",
  },
  "dca-admin-agent-settings": {
    zone: "orchestration",
    group: "orch-dca-admin-settings",
    icon: "admin",
    title: "Declarative Agent Sharing & Feedback Policy",
    role: () => "Governs tenant-wide agent sharing boundaries, user access, and feedback collection.",
  },
  "dca-admin-agent-registry": {
    zone: "orchestration",
    group: "orch-dca-admin-registry",
    icon: "admin",
    title: "Declarative Agent Registry & Custom Uploads",
    role: () => "Manages registry ownership, custom manifest uploads, and catalog approvals.",
  },
  "spai-sharepoint-admin-agent": {
    zone: "orchestration",
    group: "orch-sp-admin-agent",
    icon: "spark",
    title: "SharePoint Admin Agent",
    role: () => "Assists SharePoint administrators with automated governance triage and site remediation.",
  },

  // ── Lane 3: Grounded Knowledge, Tools & Enterprise Actions ─────────────────
  "knowledge-sharepoint": {
    zone: "grounding",
    group: "gnd-sharepoint",
    icon: "sharepoint",
    title: "SharePoint Document & Site Grounding",
    role: (c) => `Retrieves permission-trimmed passages with citations from ${c.primarySource}.`,
  },
  "spai-agent-sharepoint-knowledge-sources": {
    zone: "grounding",
    group: "gnd-sharepoint",
    icon: "sharepoint",
    title: "Scoped SharePoint Sites, Folders & Files",
    role: (c) => `Pins authoritative SharePoint sites and libraries (${c.primarySource}) as grounding scope.`,
  },
  "knowledge-dataverse": {
    zone: "grounding",
    group: "gnd-dataverse",
    icon: "database",
    title: "Microsoft Dataverse Knowledge Tables",
    role: (c) => `Queries structured Dataverse business rows and synonyms for ${c.secondarySource}.`,
  },
  "knowledge-files-web": {
    zone: "grounding",
    group: "gnd-files-web",
    icon: "file",
    title: "Uploaded Reference Files & Public Websites",
    role: (c) => `Grounds answers in curated policy documents and approved web domains for ${c.domain}.`,
  },
  "fdy-agent-file-search": {
    zone: "grounding",
    group: "gnd-foundry-files",
    icon: "file",
    title: "Foundry Vector File Search",
    role: (c) => `Chunks, embeds, and retrieves grounded passages from uploaded ${c.primarySource} files.`,
  },
  "fdy-agent-ai-search": {
    zone: "grounding",
    group: "gnd-ai-search",
    icon: "database",
    title: "Azure AI Search Hybrid & Semantic Index",
    role: (c) => `Performs vector and semantic ranking retrieval across indexed ${c.primarySource} content.`,
  },
  "mc-foundry-iq": {
    zone: "grounding",
    group: "gnd-foundry-iq",
    icon: "database",
    title: "Foundry IQ Knowledge Bases",
    role: (c) => `Connects enterprise-indexed Foundry IQ knowledge bases for high-precision grounding.`,
  },
  "mc-knowledge": {
    zone: "grounding",
    group: "gnd-scoped-knowledge",
    icon: "database",
    title: "Scoped Enterprise Knowledge Sources",
    role: (c) => `Grounds Microsoft Copilot harness responses in ${c.primarySource} with source citations.`,
  },
  "cc-knowledge": {
    zone: "grounding",
    group: "gnd-scoped-knowledge",
    icon: "database",
    title: "Customer Knowledge Grounding",
    role: (c) => `Supplies verified support articles and policy answers from ${c.primarySource}.`,
  },
  "dca-agent-builder-knowledge": {
    zone: "grounding",
    group: "gnd-scoped-knowledge",
    icon: "database",
    title: "Declarative Knowledge Sources",
    role: (c) => `Scopes SharePoint, OneDrive, and Copilot connector knowledge to ${c.primarySource}.`,
  },
  "dca-toolkit-knowledge-capabilities": {
    zone: "grounding",
    group: "gnd-typespec-knowledge",
    icon: "database",
    title: "TypeSpec Scoped Knowledge Capabilities",
    role: (c) => `Declares SharePoint, web, and Copilot connector grounding scopes in code.`,
  },
  "knowledge-tuning": {
    zone: "grounding",
    group: "gnd-tuning",
    icon: "spark",
    title: "Grounding Precision & Citation Tuning",
    role: () => "Refines source descriptions, strictness thresholds, and citation fidelity.",
  },
  "work-iq": {
    zone: "grounding",
    group: "gnd-work-iq",
    icon: "network",
    title: "Work IQ (Microsoft Graph Context)",
    role: () => "Incorporates permission-scoped Microsoft 365 meetings, mail, files, and collaboration signals.",
  },
  "m365h-control-web-search": {
    zone: "grounding",
    group: "gnd-web-policy",
    icon: "shield",
    title: "Public Web Search & Grounding Policy",
    role: () => "Governs whether and how Copilot queries external Bing web search alongside tenant data.",
  },
  "connector-tools": {
    zone: "grounding",
    group: "act-connectors",
    icon: "plug",
    title: "Power Platform Prebuilt Connector Tools",
    role: (c) => `Executes authenticated read/write business operations supporting ${c.domain}.`,
  },
  "mc-tools": {
    zone: "grounding",
    group: "act-connectors",
    icon: "plug",
    title: "Configured Action Tools",
    role: (c) => `Attaches governed connector actions and tool definitions from the Add a tool catalog.`,
  },
  "cc-add-tools": {
    zone: "grounding",
    group: "act-connectors",
    icon: "plug",
    title: "Customer Service Action Tools",
    role: (c) => `Invokes backend lookups and account updates during live ${c.domain} sessions.`,
  },
  "custom-connectors": {
    zone: "grounding",
    group: "act-custom-api",
    icon: "plug",
    title: "Custom OpenAPI Connectors & OAuth 2.0",
    role: (c) => `Wraps internal REST APIs with OAuth 2.0 security and schema validation for ${c.domain}.`,
  },
  "dca-toolkit-api-plugin-typespec": {
    zone: "grounding",
    group: "act-custom-api",
    icon: "plug",
    title: "TypeSpec REST API Plugin Actions",
    role: (c) => `Exposes typed OpenAPI operations with adaptive confirmation cards to the orchestrator.`,
  },
  "mcp-servers": {
    zone: "grounding",
    group: "act-mcp",
    icon: "plug",
    title: "Model Context Protocol (MCP) Servers",
    role: () => "Discovers and invokes live tools and structured resources exposed over MCP.",
  },
  "mc-tools-mcp": {
    zone: "grounding",
    group: "act-mcp",
    icon: "plug",
    title: "MCP Tool Servers (Microsoft Copilot Harness)",
    role: () => "Binds external Model Context Protocol servers as governed reasoning tools.",
  },
  "cc-mcp-server": {
    zone: "grounding",
    group: "act-mcp",
    icon: "plug",
    title: "MCP Server Integration",
    role: () => "Connects standardized MCP tool endpoints into customer conversation workflows.",
  },
  "dca-toolkit-mcp-plugin": {
    zone: "grounding",
    group: "act-mcp",
    icon: "plug",
    title: "OAuth-Secured MCP Plugin",
    role: () => "Connects declarative agents to remote Model Context Protocol servers using OAuth.",
  },
  "fdy-toolbox-tools": {
    zone: "grounding",
    group: "act-fdy-toolbox",
    icon: "plug",
    title: "Microsoft Foundry Shared Toolbox",
    role: () => "Publishes and shares reusable governed tools across agents inside the Foundry project.",
  },
  "dca-agent-builder-capabilities": {
    zone: "grounding",
    group: "act-code-interpreter",
    icon: "code",
    title: "Code Interpreter & Image Generator",
    role: () => "Runs sandboxed Python data analysis, charting, and visual asset generation.",
  },
  "ppai-code-interpreter-prompts": {
    zone: "grounding",
    group: "act-code-interpreter",
    icon: "code",
    title: "Prompt Code Interpreter Execution",
    role: () => "Executes deterministic Python calculations and structured transformations inside prompts.",
  },
  "computer-use": {
    zone: "grounding",
    group: "act-computer-use",
    icon: "app",
    title: "Computer-Using UI Automation",
    role: () => "Navigates legacy web or desktop interfaces lacking APIs under visual supervision.",
  },
  "cc-escalate-human": {
    zone: "grounding",
    group: "act-human-escalation",
    icon: "users",
    title: "Human Representative Escalation",
    role: () => "Transfers complex or out-of-scope conversations to a live representative with full transcript.",
  },
  "agent-flows": {
    zone: "grounding",
    group: "act-flows",
    icon: "bolt",
    title: "Deterministic Agent Flows",
    role: (c) => `Runs multi-step Power Platform automation, approvals, and system updates for ${c.domain}.`,
  },
  "mc-workflows-tool": {
    zone: "grounding",
    group: "act-flows",
    icon: "bolt",
    title: "Workflows as Agent Tools",
    role: (c) => `Invokes structured multi-step workflows from the Microsoft Copilot harness for ${c.domain}.`,
  },
  "cc-workflow-tool": {
    zone: "grounding",
    group: "act-flows",
    icon: "bolt",
    title: "Customer Workflow Tool",
    role: (c) => `Executes backend fulfillment workflows triggered during customer interactions.`,
  },
  "flow-prompt-nodes": {
    zone: "grounding",
    group: "act-flow-prompts",
    icon: "spark",
    title: "AI Prompt Nodes in Agent Flows",
    role: () => "Embeds structured generative reasoning steps inside deterministic flow branches.",
  },
  "flow-async": {
    zone: "grounding",
    group: "act-flow-async",
    icon: "bolt",
    title: "Asynchronous Long-Running Flow Callbacks",
    role: () => "Handles long-running approvals or batch jobs without timing out the conversation turn.",
  },
  // Explicit opt-in 3rd-party & hybrid enterprise integrations (ONLY shown when selected!)
  "servicenow-integration": {
    zone: "grounding",
    group: "int-servicenow",
    icon: "plug",
    title: "ServiceNow ITSM Integration",
    role: () => "Queries knowledge articles and creates or updates ServiceNow incidents and requests.",
  },
  "snowflake-integration": {
    zone: "grounding",
    group: "int-snowflake",
    icon: "database",
    title: "Snowflake Data Cloud Integration",
    role: () => "Runs governed analytical queries against enterprise Snowflake warehouses.",
  },
  "sap-integration": {
    zone: "grounding",
    group: "int-sap",
    icon: "plug",
    title: "SAP ERP & OData Integration",
    role: () => "Reads and updates SAP business orders, inventory, or finance records via OData connectors.",
  },
  "salesforce-integration": {
    zone: "grounding",
    group: "int-salesforce",
    icon: "plug",
    title: "Salesforce CRM Integration",
    role: () => "Retrieves and updates Salesforce accounts, opportunities, and service cases.",
  },
  "jira-integration": {
    zone: "grounding",
    group: "int-jira",
    icon: "plug",
    title: "Jira Issue Tracking Integration",
    role: () => "Searches engineering backlogs and creates or transitions Jira issues.",
  },
  "epic-fhir-integration": {
    zone: "grounding",
    group: "int-epic",
    icon: "plug",
    title: "Epic on FHIR Clinical Integration",
    role: () => "Accesses HL7 FHIR clinical resources with strict healthcare authorization scopes.",
  },
  "shopify-integration": {
    zone: "grounding",
    group: "int-shopify",
    icon: "plug",
    title: "Shopify Admin API Integration",
    role: () => "Looks up commerce orders, catalog inventory, and customer fulfillment status.",
  },
  "onprem-data-gateway": {
    zone: "grounding",
    group: "int-onprem-gateway",
    icon: "network",
    title: "On-Premises Data Gateway",
    role: () => "Bridges cloud connectors securely to private internal SQL, file, or line-of-business systems.",
  },
  "vnet-private-connectivity": {
    zone: "grounding",
    group: "int-vnet",
    icon: "network",
    title: "Azure Virtual Network Private Connectivity",
    role: () => "Routes outbound agent and connector traffic over private VNet endpoints without public exposure.",
  },
  // Governed content & site targets (for SharePoint SAM & M365 Copilot governance labs)
  "m365h-secure-copilot-data": {
    zone: "grounding",
    group: "gov-data-oversharing",
    icon: "shield",
    title: "Oversharing Remediation & Data Hygiene",
    role: (c) => `Tightens SharePoint and Microsoft 365 permissions across ${c.primarySource} before Copilot indexing.`,
  },
  "m365h-data-access-governance-reports": {
    zone: "grounding",
    group: "gov-dag-reports",
    icon: "chart",
    title: "Data Access Governance (DAG) Reports",
    role: () => "Identifies overshared SharePoint sites with broad Everyone or external sharing links.",
  },
  "spai-content-management-assessment": {
    zone: "grounding",
    group: "gov-dag-reports",
    icon: "chart",
    title: "Copilot Content Management Assessment",
    role: () => "Evaluates site permission hygiene and oversharing exposure prior to Copilot rollout.",
  },
  "m365h-restricted-content-discovery": {
    zone: "grounding",
    group: "gov-rcd",
    icon: "shield",
    title: "Restricted Content Discovery (RCD)",
    role: () => "Excludes sensitive SharePoint sites from tenant-wide Copilot search and grounding.",
  },
  "spai-restricted-content-discovery": {
    zone: "grounding",
    group: "gov-rcd",
    icon: "shield",
    title: "Restricted Content Discovery (RCD)",
    role: () => "Prevents Copilot and tenant search from surfacing high-risk SharePoint sites.",
  },
  "spai-restricted-access-control": {
    zone: "grounding",
    group: "gov-rac",
    icon: "key",
    title: "Restricted Access Control (RAC)",
    role: () => "Limits site access strictly to named security groups regardless of broken link inheritance.",
  },
  "spai-site-access-review": {
    zone: "grounding",
    group: "gov-access-review",
    icon: "users",
    title: "Delegated Site Access Reviews",
    role: () => "Delegates periodic permission attestation of overshared sites to business site owners.",
  },
  "spai-site-lifecycle-policies": {
    zone: "grounding",
    group: "gov-site-lifecycle",
    icon: "file",
    title: "Inactive Site Lifecycle Policies",
    role: () => "Archives or cleans up stale SharePoint sites so outdated content never grounds AI answers.",
  },
  "spai-control-agent-access": {
    zone: "grounding",
    group: "gov-sp-agent-access",
    icon: "key",
    title: "SharePoint Agent Reach & Access Policy",
    role: () => "Controls who can create or invoke SharePoint agents and which sites they can query.",
  },

  // ── Zone 4: Cross-Cutting Governance, Trust, Evaluation & Outcome Rail ─────
  authentication: {
    zone: "foundation",
    group: "fnd-auth",
    icon: "key",
    title: "User Authentication & Entra ID SSO",
    detail: "Enforces signed-in user identity and delegated OAuth tokens for permission-trimmed access.",
  },
  "cc-authentication": {
    zone: "foundation",
    group: "fnd-auth",
    icon: "key",
    title: "Customer Authentication Profiles",
    detail: "Verifies customer identity before surfacing account-specific records or actions.",
  },
  "cc-biometric-auth": {
    zone: "foundation",
    group: "fnd-biometric",
    icon: "key",
    title: "Voice Biometric Caller Verification",
    detail: "Authenticates inbound voice callers biometrically prior to sensitive account operations.",
  },
  "entra-agent-identities": {
    zone: "foundation",
    group: "fnd-entra-agent-id",
    icon: "key",
    title: "Microsoft Entra Agent Identities",
    detail: "Assigns dedicated, auditable workload identities and least-privilege scopes to agents.",
  },
  "fdy-foundry-rbac": {
    zone: "foundation",
    group: "fnd-rbac",
    icon: "key",
    title: "Azure RBAC & Foundry Project Roles",
    detail: "Separates admin, developer, and reader permissions across Foundry hubs and projects.",
  },
  "content-moderation": {
    zone: "foundation",
    group: "fnd-safety",
    icon: "shield",
    title: "Content Moderation & Safety Guardrails",
    detail: "Filters harmful content, prompt injection attempts, and ungrounded fabrications.",
  },
  "fdy-configure-guardrails": {
    zone: "foundation",
    group: "fnd-safety",
    icon: "shield",
    title: "Foundry Content Safety Guardrails",
    detail: "Applies input/output harm filters, jailbreak shields, and groundedness guardrails.",
  },
  "dlp-governance": {
    zone: "foundation",
    group: "fnd-dlp",
    icon: "shield",
    title: "Power Platform DLP & Environment Governance",
    detail: "Classifies Business vs. Non-Business connectors and blocks unauthorized data exfiltration.",
  },
  "m365h-dlp-for-copilot": {
    zone: "foundation",
    group: "fnd-purview-dlp",
    icon: "shield",
    title: "Microsoft Purview DLP for Copilot",
    detail: "Prevents sensitivity-labeled or regulated content from entering unauthorized Copilot sessions.",
  },
  "ppai-admin-governance-security": {
    zone: "foundation",
    group: "fnd-dlp",
    icon: "shield",
    title: "AI Builder Feature Toggles, DLP & Roles",
    detail: "Governs environment-level AI Builder switches, security roles, and connector DLP policies.",
  },
  "m365h-audit-copilot-interactions": {
    zone: "foundation",
    group: "fnd-purview-audit",
    icon: "shield",
    title: "Microsoft Purview Interaction Auditing",
    detail: "Captures immutable compliance audit logs of Copilot and agent prompts and responses.",
  },
  "m365h-dspm-copilot-risk": {
    zone: "foundation",
    group: "fnd-dspm",
    icon: "shield",
    title: "Purview DSPM for AI Risk Posture",
    detail: "Monitors sensitive data exposure, oversharing risk, and policy gaps across AI usage.",
  },
  "mc-agent-settings-security": {
    zone: "foundation",
    group: "fnd-agent-settings",
    icon: "shield",
    title: "Agent Security & Runtime Settings",
    detail: "Hardens sharing scopes, knowledge boundaries, and runtime security settings.",
  },
  "alm-solutions": {
    zone: "foundation",
    group: "fnd-alm",
    icon: "layers",
    title: "Managed Solutions & Environment ALM",
    detail: "Packages components with connection references and environment variables for promotion.",
  },
  "ppai-alm-distribute-models": {
    zone: "foundation",
    group: "fnd-alm",
    icon: "layers",
    title: "Solution ALM for AI Builder Models",
    detail: "Transports custom prompts and trained AI models safely across dev, test, and prod.",
  },
  "cc-export-import": {
    zone: "foundation",
    group: "fnd-alm",
    icon: "layers",
    title: "Agent Package Export & Import",
    detail: "Promotes validated Customer Conversation agent definitions across environments.",
  },
  "agent-inventory": {
    zone: "foundation",
    group: "fnd-inventory",
    icon: "admin",
    title: "Agent Inventory & Ownership Compliance",
    detail: "Tracks active agents, accountable business owners, and orphan remediation.",
  },
  "readiness-scorecard": {
    zone: "foundation",
    group: "fnd-readiness",
    icon: "check",
    title: "Release Readiness Scorecard",
    detail: "Gates production go-live on security, accuracy, latency, and support sign-off.",
  },
  "test-agent": {
    zone: "foundation",
    group: "fnd-preview-test",
    icon: "check",
    title: "Interactive Test Pane & Diagnostics",
    detail: "Verifies grounded answers, topic transitions, and out-of-scope refusals in real time.",
  },
  "mc-preview-test": {
    zone: "foundation",
    group: "fnd-preview-test",
    icon: "check",
    title: "Preview & Reasoning Verification",
    detail: "Tests live prompt handling, tool selection, and boundary refusals prior to publishing.",
  },
  "cc-preview-test": {
    zone: "foundation",
    group: "fnd-preview-test",
    icon: "check",
    title: "Voice & Chat Preview Testing",
    detail: "Simulates customer speech and chat turns to validate accuracy before deployment.",
  },
  evaluations: {
    zone: "foundation",
    group: "fnd-evals",
    icon: "check",
    title: "Automated Agent Evaluations",
    detail: "Scores groundedness, completeness, and safety across repeatable test datasets.",
  },
  "mc-evaluate": {
    zone: "foundation",
    group: "fnd-evals",
    icon: "check",
    title: "Automated Evaluation Suites",
    detail: "Runs batch test sets against authenticated user profiles on the Microsoft Copilot harness.",
  },
  "cc-evaluate": {
    zone: "foundation",
    group: "fnd-evals",
    icon: "check",
    title: "Customer Conversation Evaluations",
    detail: "Benchmarks resolution quality and policy adherence across structured test sets.",
  },
  "fdy-evaluate-agent": {
    zone: "foundation",
    group: "fnd-evals",
    icon: "check",
    title: "Foundry Quality & Safety Evaluations",
    detail: "Evaluates groundedness, relevance, tool call accuracy, and safety metrics in Foundry.",
  },
  "ppai-evaluate-version-retrain-models": {
    zone: "foundation",
    group: "fnd-evals",
    icon: "check",
    title: "Model Accuracy Evaluation & Versioning",
    detail: "Measures accuracy scores, manages model versions, and retrains as data evolves.",
  },
  "multiturn-tests": {
    zone: "foundation",
    group: "fnd-multiturn",
    icon: "check",
    title: "Multi-Turn Conversation Regression Tests",
    detail: "Validates end-to-end slot filling, context retention, and escalation across turns.",
  },
  "dca-agent-builder-troubleshooting": {
    zone: "foundation",
    group: "fnd-diagnostics",
    icon: "check",
    title: "Validation & Error Diagnostics",
    detail: "Resolves manifest limits, grounding mismatches, and runtime validation errors.",
  },
  "m365h-troubleshoot-copilot-access": {
    zone: "foundation",
    group: "fnd-diagnostics",
    icon: "check",
    title: "Copilot Access & License Diagnostics",
    detail: "Diagnoses user licensing, network, and policy blockers preventing Copilot access.",
  },
  analytics: {
    zone: "foundation",
    group: "fnd-telemetry",
    icon: "chart",
    title: "Conversation Analytics & CSAT Telemetry",
    detail: "Monitors resolution rates, abandonment, escalation drivers, and user satisfaction.",
  },
  "mc-monitor": {
    zone: "foundation",
    group: "fnd-telemetry",
    icon: "chart",
    title: "Agent Performance & Usage Monitoring",
    detail: "Tracks active sessions, tool success rates, and user feedback signals.",
  },
  "cc-monitor": {
    zone: "foundation",
    group: "fnd-telemetry",
    icon: "chart",
    title: "Omnichannel Session & Queue Monitoring",
    detail: "Tracks containment rate, handle time, and human transfer trends across channels.",
  },
  "fdy-monitor-agent-dashboard": {
    zone: "foundation",
    group: "fnd-telemetry",
    icon: "chart",
    title: "Foundry Agent Monitoring Dashboard",
    detail: "Observes live token throughput, latency percentiles, error rates, and safety triggers.",
  },
  "ppai-monitor-ai-activity": {
    zone: "foundation",
    group: "fnd-telemetry",
    icon: "chart",
    title: "AI Builder Activity & Audit Monitoring",
    detail: "Reviews model execution logs, prompt run history, and environment activity data.",
  },
  "spai-agent-insights-reports": {
    zone: "foundation",
    group: "fnd-telemetry",
    icon: "chart",
    title: "SharePoint Agent Insights Reports",
    detail: "Analyzes agent adoption, active sites, and governance coverage across SharePoint.",
  },
  "m365h-measure-copilot-adoption": {
    zone: "foundation",
    group: "fnd-telemetry",
    icon: "chart",
    title: "Copilot Readiness & Adoption Scorecards",
    detail: "Measures active usage, assisted hours, and department adoption trends.",
  },
  "fdy-trace-agent": {
    zone: "foundation",
    group: "fnd-tracing",
    icon: "chart",
    title: "Application Insights Distributed Tracing",
    detail: "Captures step-by-step OpenTelemetry spans across model calls, tools, and retrieval.",
  },
  "usage-credits": {
    zone: "foundation",
    group: "fnd-cost",
    icon: "coin",
    title: "Copilot Credits & Capacity Estimation",
    detail: "Forecasts message and autonomous action consumption against environment capacity.",
  },
  "mc-credit-billing": {
    zone: "foundation",
    group: "fnd-cost",
    icon: "coin",
    title: "Copilot Credits & Cost Controls",
    detail: "Enforces billing caps, usage budgets, and credit governance on the Microsoft Copilot harness.",
  },
  "cc-credit-billing": {
    zone: "foundation",
    group: "fnd-cost",
    icon: "coin",
    title: "Customer Conversation Credit Controls",
    detail: "Tracks voice and chat Copilot Credit burn rates and budget thresholds.",
  },
  "ppai-credits-licensing-transition": {
    zone: "foundation",
    group: "fnd-cost",
    icon: "coin",
    title: "AI Builder & Copilot Credits Capacity",
    detail: "Manages credit allocation, overage protection, and licensing transitions.",
  },
  "spai-copilot-credits-advanced-work": {
    zone: "foundation",
    group: "fnd-cost",
    icon: "coin",
    title: "SharePoint Pay-As-You-Go Credit Billing",
    detail: "Links Azure subscription meters for SharePoint agents and autofill processing.",
  },
  "m365h-pay-as-you-go-billing": {
    zone: "foundation",
    group: "fnd-cost",
    icon: "coin",
    title: "Microsoft 365 Copilot Pay-As-You-Go Billing",
    detail: "Configures metered billing policies and departmental cost guardrails.",
  },
  "fdy-manage-quota": {
    zone: "foundation",
    group: "fnd-quota",
    icon: "coin",
    title: "Regional Model Quota Governance",
    detail: "Manages tokens-per-minute allocations and regional deployment capacity.",
  },
  "fdy-manage-costs": {
    zone: "foundation",
    group: "fnd-cost",
    icon: "coin",
    title: "Foundry Cost Estimation & Budgets",
    detail: "Tracks Azure token spend, throughput reservations, and budget alerts.",
  },
});

function cleanText(value, fallback = "") {
  const s = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s || fallback;
}

function firstSentence(text, fallback = "") {
  const cleaned = cleanText(text, fallback);
  const match = cleaned.match(/^.*?[.!?](?=\s|$)/);
  return match ? match[0].trim() : cleaned;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function resolveModeFallback(planProducts, features) {
  const prods = planProducts.length ? planProducts : [DEFAULT_PRODUCT];
  if (prods.length === 1) {
    const only = prods[0];
    if (only === "m365-copilot-hub") return "m365-copilot-governance";
    if (only === "m365-copilot-agent-builder") {
      const govOnly =
        features.length > 0 &&
        features.every((f) => f.id === "dca-admin-agent-settings" || f.id === "dca-admin-agent-registry");
      return govOnly ? "declarative-agent-governance" : "declarative-agent";
    }
    if (only === "power-platform-ai-hub") {
      const govOnly = features.length > 0 && features.every((f) => f.category === "administration");
      return govOnly ? "power-platform-ai-governance" : "power-platform-ai-builder";
    }
    if (only === "sharepoint-ai") {
      const hasAgent = features.some((f) =>
        ["spai-build-agent-sharepoint-content", "spai-agent-sharepoint-knowledge-sources"].includes(f.id),
      );
      if (hasAgent) return "sharepoint-agent";
      const hasContent = features.some((f) =>
        ["spai-autofill-columns", "spai-prebuilt-document-processing"].includes(f.id),
      );
      return hasContent ? "sharepoint-content-ai" : "sharepoint-governance";
    }
    if (only === "ai-foundry") {
      const hasAgent = features.some(
        (f) => f.category === "foundry-agents" || f.id === "fdy-evaluate-agent" || f.id === "fdy-trace-agent",
      );
      return hasAgent ? "foundry-agent" : "foundry-models-platform";
    }
  }
  return "copilot-studio-agent";
}

function classifyFallbackFeature(feature) {
  const cat = String(feature.category || "").toLowerCase();
  const id = String(feature.id || "").toLowerCase();
  const name = cleanText(feature.name, feature.id || "Lab Module");
  const summary = firstSentence(
    feature.summary || feature.whyItMatters,
    `Configured during this lab module to support the solution architecture.`,
  );

  if (cat === "channels" || /\b(channel|teams-phone|publish|portal|toolkit)\b/.test(id)) {
    return {
      zone: "experience",
      group: `dyn-${feature.id}`,
      icon: "channel",
      title: name,
      role: () => summary,
    };
  }
  if (
    cat === "governance" ||
    cat === "analytics" ||
    cat === "administration" ||
    cat === "copilot-admin" ||
    cat === "dca-distribute-govern" ||
    cat === "foundry-operate" ||
    /\b(dlp|rbac|audit|eval|monitor|trace|credit|quota|security|auth|alm|govern)\b/.test(id)
  ) {
    return {
      zone: "foundation",
      group: `dyn-${feature.id}`,
      icon: /\b(eval|test)\b/.test(id) ? "check" : /\b(monitor|trace|analytic)\b/.test(id) ? "chart" : "shield",
      title: name,
      detail: summary,
    };
  }
  if (
    cat === "knowledge" ||
    cat === "tools" ||
    cat === "integrations" ||
    cat === "automation" ||
    cat === "dca-actions" ||
    cat === "apps-flows" ||
    /\b(knowledge|search|mcp|connector|flow|workflow|integration|gateway|vnet)\b/.test(id)
  ) {
    return {
      zone: "grounding",
      group: `dyn-${feature.id}`,
      icon: cat === "knowledge" ? "database" : cat === "automation" ? "bolt" : "plug",
      title: name,
      role: () => summary,
    };
  }
  return {
    zone: "orchestration",
    group: `dyn-${feature.id}`,
    icon: "cpu",
    title: name,
    role: () => summary,
  };
}

function normalizePlanFeatures(rawFeatures = []) {
  let recapIdx = 0;
  let stepIdx = 0;
  return rawFeatures.filter(Boolean).map((f) => {
    const isPrereq = Boolean(f.prerequisite || f.role === "prerequisite");
    if (isPrereq) recapIdx += 1;
    else stepIdx += 1;
    const stepLabel = cleanText(f.stepLabel, isPrereq ? `Recap ${recapIdx}` : `Step ${stepIdx}`);
    return {
      ...f,
      isPrereq,
      stepLabel,
      productId: productOf(f),
    };
  });
}

function deriveFlowLabels(mode, lane1Cards, lane2Cards, lane3Cards, guardrails) {
  const isGovMode = [
    "m365-copilot-governance",
    "declarative-agent-governance",
    "power-platform-ai-governance",
    "sharepoint-governance",
  ].includes(mode);

  const hasVoice = lane1Cards.some((c) => c.icon === "phone");
  const hasProCode = lane1Cards.some((c) => c.icon === "code" && /Toolkit|VS Code|Foundry/i.test(c.title));

  let flow1to2 = "Prompts & User Context";
  if (isGovMode) flow1to2 = "Admin Policies & Scope";
  else if (mode === "sharepoint-content-ai") flow1to2 = "Uploaded Files & Schemas";
  else if (mode === "power-platform-ai-builder") flow1to2 = "Structured Inputs & Triggers";
  else if (mode === "foundry-models-platform") flow1to2 = "Benchmark Prompts & Config";
  else if (hasVoice) flow1to2 = "Voice & Chat Streams";
  else if (hasProCode && mode === "declarative-agent") flow1to2 = "Prompts & Manifests";

  const hasKnowledge = lane3Cards.some((c) => c.icon === "database" || c.icon === "sharepoint" || c.icon === "file");
  const hasMcp = lane3Cards.some((c) => /\bMCP\b|Model Context Protocol/i.test(c.title));
  const hasFlows = lane3Cards.some((c) => c.icon === "bolt");
  const hasTools = lane3Cards.some((c) => c.icon === "plug" || c.icon === "app" || c.icon === "code");

  let flow2to3 = "Grounded Retrieval & Actions";
  if (isGovMode) flow2to3 = "Access, DLP & Site Enforcement";
  else if (mode === "sharepoint-content-ai") flow2to3 = "Metadata Extraction & Views";
  else if (mode === "foundry-models-platform") flow2to3 = "Quota, Safety & Endpoints";
  else if (hasKnowledge && hasMcp) flow2to3 = "Citations & MCP Tool Calls";
  else if (hasKnowledge && hasFlows) flow2to3 = "Grounding & Workflow Runs";
  else if (hasKnowledge && !hasTools && !hasFlows) flow2to3 = "Permission-Trimmed Grounding";
  else if (!hasKnowledge && (hasTools || hasFlows)) flow2to3 = "Authenticated Tool & Flow Calls";

  const hasEvals = guardrails.some((g) => g.icon === "check");
  const hasTelemetry = guardrails.some((g) => g.icon === "chart" || g.icon === "coin");
  const hasSecurity = guardrails.some((g) => g.icon === "shield" || g.icon === "key");

  const railParts = [];
  if (hasSecurity) railParts.push("Identity & Policy Guardrails");
  if (hasEvals) railParts.push("Evaluation Gates");
  if (hasTelemetry) railParts.push("Telemetry & Cost Controls");
  const railFlow = railParts.length ? railParts.join(" · ") : "Tenant Trust, Safety & Operational Telemetry";

  return { flow1to2, flow2to3, railFlow };
}

/**
 * Construct a deterministic, zero-dependency architecture overview model
 * tailored to the exact lab plan.
 *
 * @param {object} plan
 * @returns {object}
 */
export function buildArchitectureModel(plan = {}) {
  const features = normalizePlanFeatures(plan.features || []);
  const rawProducts =
    Array.isArray(plan.products) && plan.products.length
      ? plan.products
      : plan.product
        ? [plan.product]
        : [...new Set(features.map((f) => f.productId))];
  const productIds = rawProducts.length ? [...new Set(rawProducts)] : [DEFAULT_PRODUCT];
  const products = productIds.map((id) => {
    const p = getProduct(id);
    return {
      id,
      name: p?.name || id,
      shortName: p?.shortName || p?.name || id,
    };
  });

  const mode = cleanText(plan.deliverable?.mode, resolveModeFallback(productIds, features));
  const modeMeta = MODE_META[mode] || MODE_META["copilot-studio-agent"];

  const harnessId = plan.harness || null;
  const harness = harnessId
    ? {
        id: harnessId,
        label: HARNESS_LABELS[harnessId] || harnessId,
      }
    : null;

  const levelNum = Number(plan.level) || 200;
  const levelLabelName = cleanText(plan.difficulty || plan.levelName, LEVEL_NAMES[levelNum] || "Intermediate");

  const profile = plan.profile || {};
  const deliverableName = cleanText(profile.agentName, cleanText(plan.title, "Microsoft AI Solution"));
  const domain = cleanText(profile.domain, "enterprise operations");
  const audience = cleanText(profile.audience, "Target business users and operators");
  const primarySource = cleanText(profile.knowledgeSources?.[0], "approved enterprise knowledge sources");
  const secondarySource = cleanText(
    profile.knowledgeSources?.[1] || profile.knowledgeSources?.[2],
    "structured business records",
  );
  const kpi = cleanText(profile.kpi, "Measurable improvement in cycle time, quality, and user satisfaction");
  const outOfScope = cleanText(
    profile.outOfScope,
    "enforce tenant access boundaries and escalate unsupported actions",
  );

  const industryLabel =
    typeof plan.industry === "string"
      ? cleanText(plan.industry)
      : cleanText(plan.industry?.name, "Cross-industry");

  const roleNames = (Array.isArray(plan.roles) ? plan.roles : [])
    .map((r) => (typeof r === "string" ? cleanText(r) : cleanText(r?.name || r?.id)))
    .filter(Boolean);

  const stepCount = features.filter((f) => !f.isPrereq).length;
  const recapCount = features.filter((f) => f.isPrereq).length;
  const duration = cleanText(plan.duration, "");

  const ctx = {
    name: deliverableName,
    domain,
    audience,
    primarySource,
    secondarySource,
    kpi,
    industryLabel,
    roleNames,
  };

  const anchorBadges = [];
  const expGroups = new Map();
  const orchGroups = new Map();
  const gndGroups = new Map();
  const fndGroups = new Map();

  const pushToGroup = (map, key, entry, stepLabel) => {
    if (!map.has(key)) {
      map.set(key, {
        ...entry,
        badges: stepLabel ? [stepLabel] : [],
      });
    } else if (stepLabel && !map.get(key).badges.includes(stepLabel)) {
      map.get(key).badges.push(stepLabel);
    }
  };

  for (const feature of features) {
    const rule = FEATURE_RULES[feature.id] || classifyFallbackFeature(feature);
    if (rule.zone === "anchor") {
      if (feature.stepLabel && !anchorBadges.includes(feature.stepLabel)) {
        anchorBadges.push(feature.stepLabel);
      }
      continue;
    }
    if (rule.zone === "experience") {
      pushToGroup(
        expGroups,
        rule.group,
        {
          id: rule.group,
          icon: rule.icon || "channel",
          title: rule.title,
          role: typeof rule.role === "function" ? rule.role(ctx) : cleanText(rule.role),
        },
        feature.stepLabel,
      );
      continue;
    }
    if (rule.zone === "orchestration") {
      pushToGroup(
        orchGroups,
        rule.group,
        {
          id: rule.group,
          icon: rule.icon || "cpu",
          title: rule.title,
          role: typeof rule.role === "function" ? rule.role(ctx) : cleanText(rule.role),
        },
        feature.stepLabel,
      );
      continue;
    }
    if (rule.zone === "grounding") {
      pushToGroup(
        gndGroups,
        rule.group,
        {
          id: rule.group,
          icon: rule.icon || "database",
          title: rule.title,
          role: typeof rule.role === "function" ? rule.role(ctx) : cleanText(rule.role),
        },
        feature.stepLabel,
      );
      continue;
    }
    if (rule.zone === "foundation") {
      pushToGroup(
        fndGroups,
        rule.group,
        {
          id: rule.group,
          icon: rule.icon || "shield",
          title: rule.title,
          detail: typeof rule.detail === "function" ? rule.detail(ctx) : cleanText(rule.detail),
        },
        feature.stepLabel,
      );
    }
  }

  // ── Assemble Lane 1 (Audience & Entry Points) ─────────────────────────────
  const roleContextBits = [];
  if (industryLabel && industryLabel !== "Cross-industry") roleContextBits.push(industryLabel);
  if (roleNames.length) roleContextBits.push(roleNames.join(", "));
  const audienceScopePrefix = roleContextBits.length ? `${roleContextBits.join(" · ")} — ` : "";

  const lane1Cards = [
    {
      id: "target-audience",
      icon: "users",
      title: audience,
      role: `${audienceScopePrefix}Primary stakeholders initiating or benefiting from ${domain} workflows.`,
      badges: [],
    },
    ...expGroups.values(),
  ];

  if (expGroups.size === 0) {
    const defSurface = modeMeta.defaultSurface(harnessId);
    lane1Cards.push({
      id: "default-surface",
      icon: defSurface.icon,
      title: defSurface.title,
      role: defSurface.role,
      badges: [],
    });
  }

  // ── Assemble Lane 2 (Core Deliverable & Orchestration Engine) ─────────────
  const productsText = productsPhrase(productIds) || products.map((p) => p.name).join(" + ");
  const isMultiProduct = productIds.length > 1;
  const anchorRoleText = isMultiProduct
    ? `Multi-product architecture (${products.map((p) => p.shortName).join(" + ")}) coordinating ${domain}.`
    : modeMeta.anchorRole(domain, productsText, harness?.label || "");

  const lane2Cards = [
    {
      id: "core-deliverable",
      icon: modeMeta.isAgent ? "bot" : "layers",
      title: deliverableName,
      role: anchorRoleText,
      badges: anchorBadges,
      isPrimary: true,
    },
    ...orchGroups.values(),
  ];

  // ── Assemble Lane 3 (Grounded Knowledge, Tools & Enterprise Actions) ──────
  const lane3Cards = [...gndGroups.values()];
  if (lane3Cards.length === 0) {
    if (mode === "foundry-models-platform") {
      lane3Cards.push({
        id: "baseline-foundry-endpoint",
        icon: "database",
        title: "Governed Model Inference Endpoints",
        role: `Serves validated completions for ${domain} workloads within project quota and safety limits.`,
        badges: [],
      });
    } else if (
      [
        "m365-copilot-governance",
        "declarative-agent-governance",
        "power-platform-ai-governance",
        "sharepoint-governance",
      ].includes(mode)
    ) {
      lane3Cards.push({
        id: "baseline-governed-estate",
        icon: "shield",
        title: `Scoped Tenant Estate (${primarySource})`,
        role: `Protected content repositories, environments, and catalog assets governed for ${domain}.`,
        badges: [],
      });
    } else if (mode === "sharepoint-content-ai") {
      lane3Cards.push({
        id: "baseline-sp-library",
        icon: "sharepoint",
        title: primarySource,
        role: "Target SharePoint document library storing uploaded files and extracted metadata columns.",
        badges: [],
      });
    } else if (mode === "power-platform-ai-builder") {
      lane3Cards.push({
        id: "baseline-pp-data",
        icon: "database",
        title: primarySource,
        role: `Structured business inputs and downstream records supporting ${domain}.`,
        badges: [],
      });
    } else {
      lane3Cards.push({
        id: "baseline-scenario-scope",
        icon: "database",
        title: `Instruction-Scoped Context (${primarySource})`,
        role: "Operates within authored instructions and tenant permissions; external connectors can be layered on later.",
        badges: [],
      });
    }
  }

  // ── Assemble Zone 4 (Governance, Evaluation & Target Outcome Rail) ────────
  const guardrails = [...fndGroups.values()];
  if (guardrails.length === 0) {
    guardrails.push({
      id: "baseline-tenant-trust",
      icon: "shield",
      title: "Microsoft Entra Identity & Tenant Boundaries",
      detail: "Inherits signed-in user permissions, tenant compliance boundaries, and out-of-scope refusal rules.",
      badges: [],
    });
  }

  const flows = deriveFlowLabels(mode, lane1Cards, lane2Cards, lane3Cards, guardrails);

  const moduleCountParts = [];
  if (stepCount > 0) moduleCountParts.push(`${stepCount} ${stepCount === 1 ? "Step" : "Steps"}`);
  if (recapCount > 0) moduleCountParts.push(`${recapCount} ${recapCount === 1 ? "Recap" : "Recaps"}`);
  const modulesLabel = moduleCountParts.length ? moduleCountParts.join(" + ") : "Custom Plan";

  const contextParts = [industryLabel, `Domain: ${domain}`];
  if (duration) contextParts.push(duration);

  return {
    version: 1,
    deliverableName,
    mode,
    kindLabel: isMultiProduct
      ? `Multi-Product Architecture (${products.map((p) => p.shortName).join(" + ")})`
      : modeMeta.kindLabel,
    contextLine: contextParts.filter(Boolean).join(" · "),
    domain,
    industryLabel,
    audience,
    roles: roleNames,
    products,
    ...(harness ? { harness } : {}),
    level: {
      number: levelNum,
      label: `Level ${levelNum} · ${levelLabelName}`,
    },
    moduleSummary: {
      total: features.length,
      steps: stepCount,
      recaps: recapCount,
      label: modulesLabel,
      duration,
    },
    lanes: [
      {
        id: "experience",
        stage: "01",
        title: modeMeta.laneTitles[0],
        subtitle: modeMeta.laneSubtitles[0],
        accent: "cyan",
        icon: "users",
        flowOut: flows.flow1to2,
        cards: lane1Cards,
      },
      {
        id: "orchestration",
        stage: "02",
        title: modeMeta.laneTitles[1],
        subtitle: modeMeta.laneSubtitles[1],
        accent: "blue",
        icon: "cpu",
        flowOut: flows.flow2to3,
        cards: lane2Cards,
      },
      {
        id: "grounding-actions",
        stage: "03",
        title: modeMeta.laneTitles[2],
        subtitle: modeMeta.laneSubtitles[2],
        accent: "indigo",
        icon: "database",
        flowOut: null,
        cards: lane3Cards,
      },
    ],
    foundation: {
      title: "Governance, Trust, Evaluation & Target Outcome",
      flowLabel: flows.railFlow,
      guardrails,
      outcome: {
        kpi,
        boundary: `Scope guardrail: Must ${outOfScope.replace(/\.$/, "")}.`,
      },
    },
  };
}

/**
 * Serialize an architecture model safely for embedding inside a
 * ```` ```lab-architecture ```` fenced block in `index.md`.
 */
export function serializeArchitectureBlock(model) {
  return JSON.stringify(model, null, 2)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\*/g, "\\u002a")
    .replace(/`/g, "\\u0060")
    .replace(/~/g, "\\u007e");
}

/**
 * Parse a serialized `lab-architecture` JSON payload safely.
 * Returns `null` if input is malformed or missing required `lanes`.
 */
export function parseArchitectureBlock(rawText) {
  if (!rawText) return null;
  if (typeof rawText === "object" && Array.isArray(rawText.lanes)) return rawText;
  try {
    const parsed = JSON.parse(String(rawText).trim());
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.lanes)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Crisp inline 16x16 / 18x18 stroke SVG icons (`aria-hidden="true"`).
 * Uses only `<svg>`, `<path>`, `<circle>`, `<rect>`, `<line>`, `<polyline>`
 * with safe stroke attributes allowed by `sanitizeLabHtml`.
 */
function renderArchIconSvg(iconName, className = "lab-arch-svg") {
  const attrs = `class="${escapeHtml(className)}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"`;
  switch (iconName) {
    case "users":
      return `<svg ${attrs}><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`;
    case "chat":
    case "channel":
      return `<svg ${attrs}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;
    case "phone":
      return `<svg ${attrs}><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.12.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.58 2.81.7A2 2 0 0 1 22 16.92z"/></svg>`;
    case "bot":
      return `<svg ${attrs}><rect x="3" y="8" width="18" height="12" rx="3"/><line x1="12" y1="3" x2="12" y2="8"/><circle cx="9" cy="14" r="1.5"/><circle cx="15" cy="14" r="1.5"/></svg>`;
    case "cpu":
      return `<svg ${attrs}><rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="2" x2="9" y2="5"/><line x1="15" y1="2" x2="15" y2="5"/><line x1="9" y1="19" x2="9" y2="22"/><line x1="15" y1="19" x2="15" y2="22"/><line x1="2" y1="9" x2="5" y2="9"/><line x1="2" y1="15" x2="5" y2="15"/><line x1="19" y1="9" x2="22" y2="9"/><line x1="19" y1="15" x2="22" y2="15"/></svg>`;
    case "spark":
      return `<svg ${attrs}><path d="M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3L12 3z"/></svg>`;
    case "branch":
      return `<svg ${attrs}><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>`;
    case "database":
      return `<svg ${attrs}><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5"/><path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3"/></svg>`;
    case "sharepoint":
    case "layers":
      return `<svg ${attrs}><polyline points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>`;
    case "file":
      return `<svg ${attrs}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="14" y2="17"/></svg>`;
    case "plug":
      return `<svg ${attrs}><path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a6 6 0 0 1-12 0V8z"/></svg>`;
    case "bolt":
      return `<svg ${attrs}><polyline points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`;
    case "network":
      return `<svg ${attrs}><circle cx="12" cy="5" r="3"/><circle cx="5" cy="19" r="3"/><circle cx="19" cy="19" r="3"/><line x1="10.5" y1="7.5" x2="6.5" y2="16.5"/><line x1="13.5" y1="7.5" x2="17.5" y2="16.5"/></svg>`;
    case "code":
      return `<svg ${attrs}><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`;
    case "app":
      return `<svg ${attrs}><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/></svg>`;
    case "admin":
    case "shield":
      return `<svg ${attrs}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`;
    case "key":
      return `<svg ${attrs}><circle cx="7.5" cy="15.5" r="5.5"/><path d="M21 2l-9.6 9.6"/><path d="M15.5 7.5l3 3L22 7l-3-3"/></svg>`;
    case "check":
      return `<svg ${attrs}><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`;
    case "chart":
      return `<svg ${attrs}><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>`;
    case "coin":
      return `<svg ${attrs}><circle cx="12" cy="12" r="9"/><path d="M14.5 9.5a2.5 2.5 0 0 0-5 0c0 2.5 5 2 5 4.5a2.5 2.5 0 0 1-5 0"/><line x1="12" y1="6" x2="12" y2="18"/></svg>`;
    case "arrow-right":
      return `<svg ${attrs}><line x1="4" y1="12" x2="20" y2="12"/><polyline points="14 6 20 12 14 18"/></svg>`;
    case "target":
      return `<svg ${attrs}><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/></svg>`;
    default:
      return `<svg ${attrs}><rect x="4" y="4" width="16" height="16" rx="3"/></svg>`;
  }
}

function renderBadgesHtml(badges = []) {
  if (!Array.isArray(badges) || badges.length === 0) return "";
  const chips = badges
    .map((b) => {
      const label = cleanText(b);
      if (!label) return "";
      const isRecap = /^recap\b/i.test(label);
      const cls = isRecap ? "lab-arch-chip lab-arch-chip-recap" : "lab-arch-chip lab-arch-chip-step";
      return `<span class="${cls}">${escapeHtml(label)}</span>`;
    })
    .filter(Boolean)
    .join("");
  return chips ? `<span class="lab-arch-badges">${chips}</span>` : "";
}

/**
 * Render an executive-grade HTML architecture blueprint (`<figure class="lab-arch">`)
 * from either a parsed model object or a raw `lab-architecture` JSON string.
 *
 * Emits zero `<h1>`-`<h6>` elements so Markdown heading hierarchy never skips.
 */
export function renderArchitectureOverviewHtml(modelOrRaw) {
  const model = parseArchitectureBlock(modelOrRaw);
  if (!model) {
    return `<pre class="lab-arch-fallback"><code>${escapeHtml(String(modelOrRaw ?? ""))}</code></pre>`;
  }

  const productPills = (model.products || [])
    .map(
      (p) =>
        `<span class="lab-arch-pill lab-arch-pill-product">${escapeHtml(p.shortName || p.name || p.id)}</span>`,
    )
    .join("");
  const harnessPill = model.harness?.label
    ? `<span class="lab-arch-pill lab-arch-pill-harness">${escapeHtml(model.harness.label)}</span>`
    : "";
  const levelPill = model.level?.label
    ? `<span class="lab-arch-pill lab-arch-pill-level">${escapeHtml(model.level.label)}</span>`
    : "";
  const modulesPill = model.moduleSummary?.label
    ? `<span class="lab-arch-pill lab-arch-pill-modules">${escapeHtml(model.moduleSummary.label)}</span>`
    : "";

  const lanesHtml = model.lanes
    .map((lane) => {
      const accent = ["cyan", "blue", "indigo", "emerald"].includes(lane.accent) ? lane.accent : "blue";
      const cardsHtml = (lane.cards || [])
        .map((card) => {
          const cardCls = card.isPrimary ? "lab-arch-card lab-arch-card-primary" : "lab-arch-card";
          return `<li class="${cardCls}">
            <div class="lab-arch-card-head">
              <span class="lab-arch-card-icon">${renderArchIconSvg(card.icon)}</span>
              <strong class="lab-arch-card-title">${escapeHtml(card.title)}</strong>
            </div>
            <span class="lab-arch-card-role">${escapeHtml(card.role)}</span>
            ${renderBadgesHtml(card.badges)}
          </li>`;
        })
        .join("\n");

      const sectionHtml = `<section class="lab-arch-lane lab-arch-lane-${accent}" aria-label="Stage ${escapeHtml(lane.stage || "")}: ${escapeHtml(lane.title)}">
        <div class="lab-arch-lane-head">
          <div class="lab-arch-lane-title-row">
            <span class="lab-arch-stage-num">${escapeHtml(lane.stage || "")}</span>
            <span class="lab-arch-lane-icon">${renderArchIconSvg(lane.icon)}</span>
            <strong class="lab-arch-lane-title">${escapeHtml(lane.title)}</strong>
          </div>
          <span class="lab-arch-lane-sub">${escapeHtml(lane.subtitle || "")}</span>
        </div>
        <ul class="lab-arch-cards">
          ${cardsHtml}
        </ul>
      </section>`;

      const connectorHtml = lane.flowOut
        ? `<div class="lab-arch-connector" aria-hidden="true">
            <span class="lab-arch-connector-line"></span>
            <span class="lab-arch-connector-badge">
              ${renderArchIconSvg("arrow-right", "lab-arch-arrow-svg")}
              <span class="lab-arch-connector-text">${escapeHtml(lane.flowOut)}</span>
            </span>
            <span class="lab-arch-connector-line"></span>
          </div>`
        : "";

      return `${sectionHtml}\n${connectorHtml}`;
    })
    .join("\n");

  const foundation = model.foundation || {};
  const guardrailsHtml = (foundation.guardrails || [])
    .map(
      (g) => `<li class="lab-arch-guardrail">
        <div class="lab-arch-guardrail-head">
          <span class="lab-arch-card-icon">${renderArchIconSvg(g.icon || "shield")}</span>
          <strong class="lab-arch-guardrail-title">${escapeHtml(g.title)}</strong>
        </div>
        <span class="lab-arch-guardrail-detail">${escapeHtml(g.detail || "")}</span>
        ${renderBadgesHtml(g.badges)}
      </li>`,
    )
    .join("\n");

  const outcome = foundation.outcome || {};

  return `<figure class="lab-arch" role="region" aria-label="Solution architecture overview: ${escapeHtml(model.deliverableName)}">
  <figcaption class="lab-arch-header">
    <div class="lab-arch-title-block">
      <span class="lab-arch-eyebrow">${renderArchIconSvg("layers", "lab-arch-eyebrow-svg")}<span>Solution Architecture Blueprint · ${escapeHtml(model.kindLabel)}</span></span>
      <strong class="lab-arch-title">${escapeHtml(model.deliverableName)}</strong>
      <span class="lab-arch-subtitle">${escapeHtml(model.contextLine || "")}</span>
    </div>
    <div class="lab-arch-pills">
      ${productPills}${harnessPill}${levelPill}${modulesPill}
    </div>
  </figcaption>
  <div class="lab-arch-flow">
    ${lanesHtml}
  </div>
  <div class="lab-arch-rail-bridge" aria-hidden="true">
    <span class="lab-arch-rail-line"></span>
    <span class="lab-arch-rail-badge">${renderArchIconSvg("shield", "lab-arch-eyebrow-svg")}<span>${escapeHtml(foundation.flowLabel || "Governance, Security & Telemetry")}</span></span>
    <span class="lab-arch-rail-line"></span>
  </div>
  <div class="lab-arch-foundation">
    <section class="lab-arch-guardrails-section" aria-label="${escapeHtml(foundation.title || "Governance and evaluation controls")}">
      <div class="lab-arch-kicker">${renderArchIconSvg("shield", "lab-arch-eyebrow-svg")}<span>${escapeHtml(foundation.title || "Governance, Trust & Evaluation")}</span></div>
      <ul class="lab-arch-guardrails">
        ${guardrailsHtml}
      </ul>
    </section>
    <section class="lab-arch-outcome" aria-label="Target business outcome">
      <div class="lab-arch-outcome-kicker">${renderArchIconSvg("target", "lab-arch-eyebrow-svg")}<span>Target Business Outcome</span></div>
      <strong class="lab-arch-outcome-kpi">${escapeHtml(outcome.kpi || "")}</strong>
      ${outcome.boundary ? `<span class="lab-arch-outcome-boundary">${escapeHtml(outcome.boundary)}</span>` : ""}
    </section>
  </div>
</figure>`;
}

/**
 * Convert a parsed or serialized `lab-architecture` block into structured rows
 * for Word (`.docx`) and Adobe PDF (`.pdf`) exports so document downloads render
 * a formatted architecture overview table and outcome callout instead of raw JSON.
 */
export function buildArchitectureDocumentRows(modelOrRaw) {
  const model = parseArchitectureBlock(modelOrRaw);
  if (!model) return null;

  const metaPills = [
    ...(model.products || []).map((p) => p.name || p.shortName || p.id),
    model.harness?.label || null,
    model.level?.label || null,
    model.moduleSummary?.label ? `Active Lab Scope: ${model.moduleSummary.label}` : null,
  ].filter(Boolean);

  const rows = [];
  for (const lane of model.lanes || []) {
    const layerLabel = `${lane.stage ? `${lane.stage}. ` : ""}${lane.title}`;
    const flowText = lane.flowOut || model.foundation?.flowLabel || "Governed Execution";
    for (const card of lane.cards || []) {
      rows.push({
        layer: layerLabel,
        componentTitle: cleanText(card.title),
        componentRole: cleanText(card.role),
        modules: Array.isArray(card.badges) && card.badges.length ? card.badges.join(", ") : "Scenario baseline",
        flow: flowText,
      });
    }
  }

  for (const g of model.foundation?.guardrails || []) {
    rows.push({
      layer: "04. Governance & Evaluation",
      componentTitle: cleanText(g.title),
      componentRole: cleanText(g.detail),
      modules: Array.isArray(g.badges) && g.badges.length ? g.badges.join(", ") : "Platform baseline",
      flow: model.foundation?.flowLabel || "Policy, Identity & Telemetry",
    });
  }

  return {
    deliverableName: model.deliverableName,
    kindLabel: model.kindLabel,
    contextLine: model.contextLine || "",
    metaSummary: metaPills.join(" · "),
    rows,
    kpi: model.foundation?.outcome?.kpi || "",
    boundary: model.foundation?.outcome?.boundary || "",
  };
}

function escapePipeCell(text) {
  return cleanText(text).replace(/\|/g, "\\|").replace(/\*/g, "\\*");
}

/**
 * Format a `lab-architecture` block as clean Markdown blocks (callout + 4-column
 * pipe table + target outcome callout) for document renderers such as `pdf-builder.js`.
 */
export function renderArchitectureDocumentMarkdown(modelOrRaw) {
  const doc = buildArchitectureDocumentRows(modelOrRaw);
  if (!doc) return "";

  const lines = [
    `> **${escapePipeCell(doc.deliverableName)} — ${escapePipeCell(doc.kindLabel)}**`,
    doc.metaSummary ? `> ${escapePipeCell(doc.metaSummary)}` : null,
    doc.contextLine ? `> *${escapePipeCell(doc.contextLine)}*` : null,
    "",
    "| Architecture Layer | Component & Role in Scenario | Lab Modules | Data / Control Flow |",
    "| --- | --- | --- | --- |",
    ...doc.rows.map(
      (r) =>
        `| **${escapePipeCell(r.layer)}** | **${escapePipeCell(r.componentTitle)}** — ${escapePipeCell(r.componentRole)} | ${escapePipeCell(r.modules)} | ${escapePipeCell(r.flow)} |`,
    ),
    "",
  ];

  if (doc.kpi) {
    lines.push(`> **Target Business Outcome (KPI):** ${escapePipeCell(doc.kpi)}`);
    if (doc.boundary) {
      lines.push(`> ${escapePipeCell(doc.boundary)}`);
    }
  }

  return lines.filter((l) => l !== null).join("\n");
}
