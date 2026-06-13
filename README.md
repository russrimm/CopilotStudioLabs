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

## 🧪 Labs

### ⭐ Featured: 3-Hour End-to-End Advanced Lab

| # | Lab | Industry | Scenario | Difficulty | Time |
|---|-----|----------|----------|------------|------|
| 04 | [**Build an Advanced Energy Intelligence Agent with US Census Bureau Data**](./labs/04-energy-census-advanced-agent/index.md) | Energy / Utilities | Build a full-stack agent integrating US Census Bureau APIs for service territory planning — covering topics, variables, tools, connected agents, agent flows, model selection, MCP servers, and agent evaluations. Includes 15 min intro and 15 min Q&A wrap-up. Optional: VS Code extension for agent management. | Advanced (200–300) | **3 hours** (+20 min optional) |

This is the primary lab for customers wanting a comprehensive, hands-on Copilot Studio experience. It covers all major platform capabilities in a single cohesive energy-industry scenario.

---

### 📚 Supplementary Labs

These shorter labs cover individual concepts and can be used as standalone references or warm-up exercises.

| # | Lab | Industry | Scenario | Difficulty | Time |
|---|-----|----------|----------|------------|------|
| 01 | [Build a Custom IT Operations Agent for SDG&E](./labs/01-sdge-energy-ops-agent/index.md) | Energy & Utilities (SDG&E) | Build a knowledge-powered IT support agent for field technicians — grounded in SharePoint, internal documents, Microsoft Support, and NERC CIP compliance standards | Intermediate | 75 min |
| 02 | [Monitor Performance and Evaluate Sempra Agent Quality](./labs/02-sempra-agent-analytics-evaluations/index.md) | Energy & Utilities (Sempra) | Use analytics on the Lab 01 agent to find improvement opportunities, then build evaluation test sets (auto-generated, CSV import, test-canvas capture, manual) to systematically verify quality and catch regressions | Intermediate (200) | 30 min |
| 03 | [Orchestration with Copilot Studio for Sempra](./labs/03-sempra-account-orchestration-agent/index.md) | Energy & Utilities (Sempra) | Stand up a Sempra Customer Account Lookup connected agent, tune the planner with Instructions and Descriptions, then build a new-type Customer Operations Assistant that uses the New Orchestrator (Agentic Reasoning Loop) and a reusable Skill to chain Dataverse MCP, custom MCP servers, internal vs. customer-facing knowledge, and live weather across a single turn | Advanced (300) | 60 min |
| 05 | [Clone, Modify, and Republish Agents with VS Code](./labs/05-copilot-studio-vscode-agent-management/index.md) | Energy & Utilities | Clone a Copilot Studio agent to VS Code, modify topics, instructions, and tools using agent skill commands, republish to the cloud, and verify changes in the test chat | Intermediate (200) | 45 min |

---

## Lab 01 — Build a Custom IT Operations Agent

**Industry:** Energy & Utilities  
**Scenario:** SDG&E, a large multi-subsidiary energy company, needs a way to help field technicians resolve IT issues — VPN connectivity, Energy Support App login failures, remote device access, and NERC CIP compliance questions — without waiting on hold with the helpdesk.

**What you'll build:** A fully functional **SDG&E IT Operations Agent** in Microsoft Copilot Studio, grounded in four real knowledge sources:

- 🌐 **Microsoft Support** — for Microsoft product and device troubleshooting
- 📋 **NERC CIP Standards** — for energy industry cybersecurity compliance questions
- 🗂️ **SharePoint** — for internal VPN guides, Energy Support App onboarding, and IT policies
- 📄 **Uploaded document** — the SDG&E Field Operations Remote Access Guide

**How it can be adapted:** The same lab structure applies to virtually any support or knowledge-access scenario. Replace the SharePoint site and uploaded document with content from your own organization. Update the agent's instructions to reflect your domain. Change the knowledge sources to match your compliance standards or internal systems. The result is an agent tailored entirely to your context — built in an afternoon.

➡️ [Start Lab 01](./labs/01-sdge-energy-ops-agent/index.md)

---

## 🚀 Getting started

### Prerequisites

- Access to [Microsoft Copilot Studio](https://copilotstudio.microsoft.com)
- A Power Platform environment (trial or licensed)
- A SharePoint site for lab 01 (instructions included in the lab)

### How to use these labs

- **For the full hands-on experience**, start with **Lab 04** — it is self-contained and covers all major Copilot Studio capabilities in 3 hours.
- **For a shorter introduction**, start with **Lab 01** to build a knowledge-grounded agent, then continue with Labs 02 and 03 for analytics, evaluations, and orchestration.
- **Lab 05** is an optional add-on for teams interested in managing agents as code through VS Code.

---

## 📚 Resources

🔗 [Microsoft Copilot Studio documentation](https://learn.microsoft.com/microsoft-copilot-studio/)  
🔗 [Quickstart: Create and deploy an agent](https://learn.microsoft.com/microsoft-copilot-studio/fundamentals-get-started)  
🔗 [Add knowledge to your agent](https://learn.microsoft.com/microsoft-copilot-studio/knowledge-add-existing-copilot)  
📺 [AI in Action: Copilot Studio series](https://aka.ms/ai-in-action/copilot-studio/ep1)

---

*Built for the Microsoft Agent Academy — empowering every practitioner to build with AI.*
