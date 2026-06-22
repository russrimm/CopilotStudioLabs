# ⚡ Copilot Studio Labs

**Hands-on labs for building AI-powered agents with Microsoft Copilot Studio — no coding required.**

---

## What is this?

Copilot Studio Labs is a series of practical, scenario-driven labs that teach you how to design, build, and deploy intelligent agents using Microsoft Copilot Studio. Each lab is grounded in a real-world business scenario and walks you step-by-step through the agent authoring experience — from natural language prompts to enterprise knowledge sources.

These labs are designed for a wide range of learners: IT professionals, business analysts, operations leads, and anyone who wants to put AI to work without needing a background in software development.

---

## 🏭 Who are these labs for?

These labs are designed for anyone working in or alongside industries where operational complexity, field-based workforces, and compliance requirements create real demand for faster, smarter information access — including:

- **Energy & Utilities** — Energy Support App operations, NERC CIP compliance, field crew support
- **Manufacturing** — plant floor IT, equipment maintenance, safety procedures
- **Healthcare** — clinical IT support, policy lookup, device troubleshooting
- **Financial Services** — compliance Q&A, internal helpdesk, onboarding assistance
- **Government & Public Sector** — citizen services, internal operations, regulatory guidance

The lab scenarios are easily adapted. Swap the industry, the data sources, and the agent's instructions — and you have a completely different agent purpose-built for your context.

---

## 🤖 You don't need to know how to code

One of the most transformative things about tools like Microsoft Copilot Studio is what they make possible for people who have never written a line of code — and what they amplify for those who have.

In the past, building a functional IT operations assistant, a compliance Q&A bot, or a field technician support agent required weeks of development work, a team of engineers, and a significant budget. Today, a well-constructed natural language prompt — a few sentences describing what you want — can generate a fully functional, enterprise-ready agent in minutes.

That agent can:
- Search internal SharePoint sites, uploaded policy documents, and public websites
- Reason over multiple knowledge sources simultaneously
- Follow structured troubleshooting flows
- Enforce security boundaries and escalation paths
- Respond in a professional, context-aware tone

The barrier to entry has fundamentally shifted. You no longer need to know *how* to build software — you need to know *what* you want it to do. That insight, that domain knowledge, that understanding of how your organization works — that's what you bring. The AI handles the rest.

This isn't just about saving developer time. It's about unlocking the ability to build for yourself, your team, and your organization — faster, cheaper, and with fewer dependencies than ever before.

---

## 🧪 Copilot Studio Labs

| # | Lab | Industry | Scenario | Difficulty | Time |
|---|-----|----------|----------|------------|------|
| 01 | [Build a Custom IT Operations Agent for Contoso Energy](./labs/04-energy-ops-agent/index.md) | Energy & Utilities (Contoso Energy) | Build a knowledge-powered IT support agent for field technicians — grounded in SharePoint, internal documents, Microsoft Support, and NERC CIP compliance standards | Intermediate | 75 min |
| 02 | [Monitor Performance and Evaluate Contoso Agent Quality](./labs/07-agent-analytics-evaluations/index.md) | Energy & Utilities (Contoso) | Use analytics on the Lab 01 agent to find improvement opportunities, then build evaluation test sets (auto-generated, CSV import, test-canvas capture, manual) to systematically verify quality and catch regressions | Intermediate (200) | 30 min |
| 03 | [Orchestration with Copilot Studio for Contoso](./labs/18-account-orchestration-agent/index.md) | Energy & Utilities (Contoso) | Stand up a Contoso Customer Account Lookup connected agent, tune the planner with Instructions and Descriptions, then build a new-type Customer Operations Assistant that uses the New Orchestrator (Agentic Reasoning Loop) and a reusable Skill to chain Dataverse MCP, custom MCP servers, internal vs. customer-facing knowledge, and live weather across a single turn | Advanced (300) | 60 min |
| 04 | [**Build an Energy Operations Weather Intelligence Agent with MSN Weather**](./labs/06-energy-weather-agent/index.md) | Energy / Utilities | Build a full-stack agent integrating the MSN Weather connector for grid-operations weather awareness — covering topics, variables (with Adaptive Cards), connector tools, custom prompt tools, connected agents, agent flows, model selection, and agent evaluations. Includes 15 min intro and 15 min Q&A wrap-up. Optional: MCP servers and a pointer to **Lab 05 (Advanced)** for VS Code-based agent management. | Intermediate (200) | **3 hours** (+25 min optional) |
| 05 | [Clone, Modify, and Republish Agents with VS Code](./labs/36-copilot-studio-vscode-agent-management/index.md) | Energy & Utilities | Clone a Copilot Studio agent to VS Code, modify topics, instructions, and tools using agent skill commands, republish to the cloud, and verify changes in the test chat | Advanced (300) | 45 min |
| 06 | [Build a Computer-Using Agent for Desktop Automation](./labs/28-computer-use-agents/index.md) | Energy & Utilities | Build a Computer-Using Agent that automates a utility billing portal, scale execution with Cloud PC pools, package reusable computer-use tools, and monitor governed UI automation | Advanced (300) | 2 hours |
| 07 | [Connect Agents Across Platforms with the Agent-to-Agent (A2A) Protocol](./labs/19-agent-to-agent-protocol/index.md) | Energy & Utilities | Connect Copilot Studio and Fabric specialists through A2A, then build and validate a cross-platform orchestration pattern for utility analytics and operations | Advanced (300) | 90 min |
| 08 | [Supercharge Agents with Work IQ and Microsoft 365 Intelligence](./labs/05-work-iq-m365-intelligence/index.md) | Energy & Utilities | Ground an operations briefing agent in Microsoft 365 signals, SharePoint knowledge, and curated external energy sources | Intermediate (200) | 60 min |
| 09 | [Master Prompt Engineering with Prompt Builder and Agent Flow Nodes](./labs/13-prompt-builder-agent-flows/index.md) | Energy & Utilities | Create reusable prompts, embed them in agent flows, add M365 Copilot research, and tune moderation plus performance for utility scenarios | Intermediate to Advanced (200-300) | 90 min |
| 10 | [Build Real-Time Voice Agents for Telephony and Contact Center](./labs/30-realtime-voice-agents/index.md) | Energy & Utilities | Build, tune, test, and deploy a real-time voice agent for outage and billing scenarios with hold/resume, post-call actions, and recording consent | Advanced (300) | 2 hours |
| 11 | [Build a Power Apps Code App with Dataverse](./labs/33-power-apps-code-apps/index.md) | Energy & Utilities | Build a supplier onboarding dashboard using Bring Your Own Code (BYOC) in Power Apps — clone a starter template, connect to Dataverse, and use GitHub Copilot to add business logic | Intermediate (200) | 45 min |
| 12 | [ServiceNow Integration with Copilot Studio](./labs/22-servicenow-integration/index.md) | Cross-industry | Connect ServiceNow ITSM to Copilot Studio with OAuth, SSO, and Entra ID integration for incident management and knowledge lookups | Advanced (300) | 90 min |
| 13 | [Snowflake Data Integration with Copilot Studio](./labs/23-snowflake-data-integration/index.md) | Cross-industry | Query Snowflake data warehouses from Copilot Studio using OAuth with Entra ID, with optional VNet private connectivity | Advanced (300) | 90 min |
| 14 | [On-Premises Data Gateway for Copilot Studio](./labs/24-onprem-data-gateway/index.md) | Manufacturing, Public Sector | Bridge on-premises SQL Server and legacy systems to Copilot Studio through the Power Platform On-Premises Data Gateway and Power Automate flows | Advanced (300) | 75 min |
| 15 | [Azure VNet & Private Connectivity for Power Platform](./labs/25-vnet-private-connectivity/index.md) | Financial Services, Healthcare | Configure Azure VNet subnet delegation for Power Platform to enable private, no-public-internet connectivity for Copilot Studio connectors | Advanced (300) | 90 min |
| 16 | [Custom Connectors & OAuth for Copilot Studio](./labs/21-custom-connectors-oauth/index.md) | Technology, Cross-industry | Build custom Power Platform connectors from OpenAPI specs with OAuth 2.0 and SSO, and connect them to Copilot Studio agents | Intermediate-Advanced (250) | 75 min |
| 17 | [Industry-Specific 3rd Party Integrations](./labs/26-industry-integrations/index.md) | Multi-industry | Industry roundup covering Epic FHIR (Healthcare), SAP (Financial), Shopify (Retail), IoT (Manufacturing), Salesforce Gov (Public Sector), and Jira/GitHub (Technology) integrations | Advanced (300) | 2 hrs |
| 18 | [Embed a Copilot Studio Agent in a Web Page with the Client SDK](./labs/32-embed-agent-web-sdk/index.md) | Cross-industry | Embed your published agent in a custom-branded web chat using the Copilot Studio Client SDK (`@microsoft/agents-copilotstudio-client`) with MSAL.js + Entra ID authentication — covers Entra app registration, delegated auth, conversation lifecycle, suggested actions, adaptive card fallback, and full UI branding | Intermediate–Advanced (250) | 75 min |
| 19 | [Agent Evaluations (GA)](./labs/08-agent-evaluations-ga/index.md) | Cross-industry | Use generally available evaluations to baseline quality, detect regressions, and validate prompt or flow improvements before release | Intermediate (200) | 60 min |
| 20 | [Multi-turn Conversation Tests](./labs/09-multi-turn-conversation-tests/index.md) | Cross-industry | Design and run multi-turn conversation regression scripts to validate context retention, branching behavior, and completion quality | Intermediate (200) | 60 min |
| 21 | [Question/Reaction Exports](./labs/10-question-reaction-exports/index.md) | Cross-industry | Export question and reaction analytics, identify recurring issues, and turn findings into prioritized improvement backlog items | Intermediate (200) | 45 min |
| 22 | [Prompt Assistant](./labs/03-prompt-assistant/index.md) | Cross-industry | Use Prompt Assistant to generate, refine, and compare prompt drafts with practical guardrails and measurable output quality gains | Beginner-Intermediate (100-200) | 45 min |
| 23 | [Work IQ MCP (Preview)](./labs/27-work-iq-mcp-preview/index.md) | Cross-industry | Pilot Work IQ MCP preview integration for contextual grounding, compare before/after response quality, and document preview risk controls | Advanced (300) | 75 min |
| 24 | [Agent-to-agent (GA)](./labs/20-agent-to-agent-ga/index.md) | Cross-industry | Implement generally available multi-agent delegation patterns with clear role boundaries, routing hints, and handoff validation | Advanced (300) | 75 min |
| 25 | [Computer Use (GA)](./labs/29-computer-use-ga/index.md) | Cross-industry | Build generally available desktop automation patterns, improve reliability through retries and checkpoints, and define operational governance | Advanced (300) | 90 min |
| 26 | [Agent Flows: Agent Nodes](./labs/15-agent-flows-agent-nodes/index.md) | Cross-industry | Create agent flows that invoke specialist agent nodes with explicit input/output contracts and fallback paths | Intermediate-Advanced (200-300) | 75 min |
| 27 | [Agent Flows: Prompt Nodes](./labs/14-agent-flows-prompt-nodes/index.md) | Cross-industry | Build prompt-node patterns for classification and synthesis with structured outputs and validation branches | Intermediate (200) | 60 min |
| 28 | [Agent Flows: M365 Copilot Nodes](./labs/16-agent-flows-m365-copilot-nodes/index.md) | Cross-industry | Integrate M365 Copilot nodes into agent flows for research and summarization with permission-safe branching | Advanced (300) | 75 min |
| 29 | [Agent Flows: Async Responses](./labs/17-agent-flows-async-responses/index.md) | Cross-industry | Design async response patterns for long-running workflows with acknowledgement, completion, timeout, and failure handling | Advanced (300) | 75 min |
| 30 | [Usage Estimator & Copilot Credits](./labs/37-usage-estimator-copilot-credits/index.md) | Cross-industry | Estimate demand and Copilot Credits usage, identify cost drivers, and establish rollout guardrails and monitoring cadence | Intermediate (200) | 45 min |
| 31 | [Custom Analytics Metrics](./labs/11-custom-analytics-metrics/index.md) | Cross-industry | Define custom KPI metrics, map them to observable events, and operationalize threshold-based performance reviews | Intermediate-Advanced (200-300) | 60 min |
| 32 | [Agent Inventory Schema](./labs/38-agent-inventory-schema/index.md) | Cross-industry | Build an inventory schema for agent ownership, lifecycle, dependencies, risk tiers, and governance recertification | Intermediate (200) | 50 min |
| 33 | [Agent Readiness / Issue Status](./labs/39-agent-readiness-issue-status/index.md) | Cross-industry | Combine evaluation outcomes and issue-tracker status into a readiness scorecard with release gate decisions | Intermediate (200) | 60 min |
| 34 | [Entra Agent Identities (Preview)](./labs/40-entra-agent-identities-preview/index.md) | Cross-industry | Configure preview Entra identity patterns with least-privilege controls, access-boundary validation, and governance notes | Advanced (300) | 75 min |
| 35 | [Real-time Voice Agents (Preview)](./labs/31-realtime-voice-agents-preview/index.md) | Cross-industry | Prototype preview real-time voice call flows, tune turn-taking behavior, and validate fallback and pilot-readiness constraints | Advanced (300) | 75 min |

### 🧭 Planned Labs (Backlog: 19-35)

Planned topics are numbered and reserved for future authoring. See `.squad/files/labs-topic-expansion-plan.md` for the full numbering and naming map.

| # | Planned topic |
|---|---|
| 19 | Agent evaluations (GA) |
| 20 | Multi-turn conversation tests |
| 21 | Question/reaction exports |
| 22 | Prompt assistant |
| 23 | Work IQ MCP (Preview) |
| 24 | Agent-to-agent (GA) |
| 25 | Computer use (GA) |
| 26 | Agent flows: agent nodes |
| 27 | Agent flows: prompt nodes |
| 28 | Agent flows: M365 Copilot nodes |
| 29 | Agent flows: async responses |
| 30 | Usage estimator and Copilot Credits |
| 31 | Custom analytics metrics |
| 32 | Agent inventory schema |
| 33 | Agent readiness and issue status |
| 34 | Entra agent identities (Preview) |
| 35 | Real-time voice agents (Preview) |

> **Lab 11 note:** This lab complements the no-code agent labs with a pro-code Power Apps + Dataverse build path, making it a strong bridge for teams pairing Copilot Studio agents with custom web or business applications.

---

## ⚡ Portal Features

The repository also includes a full **Copilot Studio Labs portal** for delivering and operating the labs:

- 🤖 Embedded Copilot Studio **Agent Chat** for real-time learner support
- 🔐 **Approval workflows** for Power Platform environment provisioning
- 👍 **Inline feedback** capture and 🐛 one-click issue reporting
- 👁️ Rendered **lab preview** with Mermaid diagrams, TOC, and image lightbox
- 🧪 **Validation** smoke tests for lab documentation quality
- ☁️ **Azure provisioning** plus ⚡ **Power Platform** environment management
- 📥 **ZIP export**, 📧 **email delivery**, and 🎨 **branding/customization**

---

## Lab 01 — Build a Custom IT Operations Agent

**Industry:** Energy & Utilities  
**Scenario:** Contoso Energy, a large multi-subsidiary energy company, needs a way to help field technicians resolve IT issues — VPN connectivity, Energy Support App login failures, remote device access, and NERC CIP compliance questions — without waiting on hold with the helpdesk.

**What you'll build:** A fully functional **Contoso IT Operations Agent** in Microsoft Copilot Studio, grounded in four real knowledge sources:

- 🌐 **Microsoft Support** — for Microsoft product and device troubleshooting
- 📋 **NERC CIP Standards** — for energy industry cybersecurity compliance questions
- 🗂️ **SharePoint** — for internal VPN guides, Energy Support App onboarding, and IT policies
- 📄 **Uploaded document** — the Contoso Energy Field Operations Remote Access Guide

**How it can be adapted:** The same lab structure applies to virtually any support or knowledge-access scenario. Replace the SharePoint site and uploaded document with content from your own organization. Update the agent's instructions to reflect your domain. Change the knowledge sources to match your compliance standards or internal systems. The result is an agent tailored entirely to your context — built in an afternoon.

➡️ [Start Lab 01](./labs/04-energy-ops-agent/index.md)

---

## 🚀 Getting started

### Prerequisites

- Access to [Microsoft Copilot Studio](https://copilotstudio.microsoft.com)
- A Power Platform environment (trial or licensed)
- A SharePoint site for lab 01 (instructions included in the lab)
- Node.js 18+ (for the template setup script)
- Prefer zero local setup for Node.js/MCP labs? See [Open in GitHub Codespaces](./docs/codespaces.md).

### How to use these labs

- **For the full hands-on experience**, start with **Lab 04** — it is self-contained and covers all major Copilot Studio capabilities in 3 hours.
- **For a shorter introduction**, start with **Lab 01** to build a knowledge-grounded agent, then continue with Labs 02 and 03 for analytics, evaluations, and orchestration.
- **Lab 05** is the **Advanced** follow-on for Lab 04 — it takes the agent you built and walks teams through managing it as code through the Copilot Studio extension for VS Code (clone, modify, validate, republish).
- **Labs 06-10** extend the series into computer use, cross-platform orchestration, Microsoft 365 intelligence, prompt engineering, and real-time voice scenarios.
- **Lab 11** introduces **Power Apps Code Apps (BYOC)** — a code-first approach to building custom web apps connected to Dataverse, complementing the no-code agent building in earlier labs.
- Use the **portal** to preview labs, apply branding, validate content, export ZIP bundles, email packages, manage approval workflows, provision environments, and connect an embedded Copilot Studio support agent for learners and provisioners.

---

## 🎨 Deploy as a customizable template

This repository is designed as a **GitHub Template** — you can create your own copy and customize it for any organization, industry, or scenario.

### Quick start

1. Click **"Use this template"** on GitHub (or fork the repo)
2. Edit `template.config.json` to match your organization:

```json
{
  "industryPreset": "manufacturing",
  "organization": {
    "name": "Contoso",
    "fullName": "Contoso Energy Corp",
    "parent": "Contoso Holdings",
    "industry": "Manufacturing"
  },
  "scenario": {
    "agentName": "Plant Floor Support Agent",
    "endUsers": "plant operators"
  },
  "labs": {
    "include": [
      "04-energy-ops-agent",
      "06-energy-weather-agent"
    ]
  }
}
```

> **`industryPreset`** is the easiest way to re-theme every lab. Pick one of `energy`, `manufacturing`, `healthcare`, `financial`, `government`, `retail`, `logistics`, `legal`, `education`, `realestate`, `travel`, `automotive`, `media`, `agriculture`, `publicsafety`, `sports`, `research`, or `insurance` and `setup.js` rewrites energy-specific scenario language (e.g. "Energy Operations", "grid operations", "outage management", "field technicians", "NERC CIP") to the chosen industry's equivalents across **all** labs. Anything you set explicitly under `organization`/`scenario`/`knowledgeSources` overrides the preset. The presets live in [`industry-presets.json`](./industry-presets.json) — add or tune term mappings there.

3. Run the setup script:

```bash
npm run setup             # interactive — confirms before writing
npm run setup -- --dry-run  # preview changes without modifying files
```

### What gets customized

| Area | What changes |
|------|-------------|
| **Industry preset** | `industryPreset` rewrites energy-specific scenario language (Energy Operations, grid operations, outages, field crews, compliance, etc.) to the selected industry across every lab |
| **Organization** | Company name, parent company, and subsidiary references across all lab content |
| **Industry** | Industry labels in metadata tables and scenario descriptions |
| **Branding** | Tagline and color references |
| **Scenario** | Agent name, end-user role, and compliance standard references |
| **Lab selection** | Labs not listed in `labs.include` are removed from the filesystem and README |

### Configuration reference

See [`template.config.json`](./template.config.json) for the full schema. Key sections:

- **`industryPreset`** — one of `energy`, `manufacturing`, `healthcare`, `financial`, `government`, `retail`, `logistics`, `legal`, `education`, `realestate`, `travel`, `automotive`, `media`, `agriculture`, `publicsafety`, `sports`, `research`, `insurance` (see [`industry-presets.json`](./industry-presets.json))
- **`organization`** — name, fullName, parent, industry, subsidiaries
- **`branding`** — logoPath, primaryColor, tagline
- **`scenario`** — domain, agentName, endUsers, useCases
- **`knowledgeSources`** — sharePointUrl, publicWebsites, complianceStandard, uploadedDocuments
- **`labs.include`** — array of lab folder names to keep (others are removed)
- **`deployment`** — repoName, repoDescription, powerPlatformEnvironment

---

## 📝 Automated documentation changelog

Every pull request automatically generates a **Documentation Change Summary** comment that includes:

- 📄 **Documentation files** modified (`.md` files)
- 🖼️ **Screenshots / images** modified — with a reviewer warning to verify they match the current UI
- 🧪 **Lab content** affected — grouped by lab folder
- ⚙️ **Template / infrastructure** changes
- ✅ **Reviewer checklist** — auto-generated with screenshot verification if images changed

This is powered by the [`doc-changelog.yml`](./.github/workflows/doc-changelog.yml) workflow and runs on every PR.

### Screenshot management

Screenshots are managed via the [screenshot capture tool](./tools/screenshot-capture/):

```bash
cd tools/screenshot-capture
npm install
npm run capture    # interactive — walks through each shot
npm run list       # list all configured shots
```

The tool uses Playwright to capture screenshots from the live Copilot Studio UI. Shot definitions live in `shots.json` and map to specific lab steps. When lab content changes, update the relevant shots and re-run the capture tool — the changelog workflow will flag screenshot changes in the PR for reviewer verification.

---

## 📚 Resources

🔗 [Microsoft Copilot Studio documentation](https://learn.microsoft.com/microsoft-copilot-studio/)  
🔗 [Quickstart: Create and deploy an agent](https://learn.microsoft.com/microsoft-copilot-studio/fundamentals-get-started)  
🔗 [Add knowledge to your agent](https://learn.microsoft.com/microsoft-copilot-studio/knowledge-add-existing-copilot)  
📺 [AI in Action: Copilot Studio series](https://aka.ms/ai-in-action/copilot-studio/ep1)

---

*Built for the Microsoft Agent Academy — empowering every practitioner to build with AI.*
