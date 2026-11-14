# Lab 16: Agent Flows - Microsoft 365 Copilot Nodes

*Integrate Microsoft 365 Copilot capabilities into Copilot Studio agent flows using Microsoft 365 Copilot nodes.*

| Field | Details |
|---|---|
| ⭐ **DIFFICULTY** | Advanced (300) |
| ⏱️ **TIME** | 75 minutes |
| 🧩 **PRODUCTS** | Microsoft Copilot Studio, Microsoft 365 |
| 🏷️ **TAGS** | Agent Flows, Microsoft 365 Copilot, Knowledge Work |
| 🏭 **INDUSTRIES** | Cross-industry |

---

## Overview

This lab teaches you how to use the **Copilot node** inside Copilot Studio workflows (powered by the **Microsoft Copilot harness**) to run **Copilot Chat** — optionally targeting specialized agents such as **Researcher**, **Analyst**, or custom **Agent Builder** agents — or to delegate multi-app work through a **Cowork** task grounded in the connected user's mail, files, calendar, and chats. You will configure node connections, pass runtime tokens cleanly, and validate enterprise-ready output quality.

## Learning Objectives

1. Add a **Copilot** node to a Copilot Studio workflow on the Microsoft Copilot harness.
2. Choose between **Run Copilot Chat** (including **Researcher**, **Analyst**, or **Agent Builder** agents) and **Run a Cowork task** (new or resumed).
3. Pass dynamic context into **Message** or **Task instructions** and consume **Response** downstream.
4. Handle missing data and connection-account permission boundaries safely.
5. Build a reusable Microsoft 365 Copilot workflow orchestration pattern.

## Prerequisites

> ℹ️ **Harness, billing, and data-access note:** Workflows that use the **Copilot node** run on the [Microsoft Copilot harness](https://learn.microsoft.com/microsoft-copilot-studio/harnesses-overview) and use usage-based billing — building, testing, and running Chat or Cowork steps consumes [Copilot Credits](https://learn.microsoft.com/microsoft-copilot-studio/agents-experience/billing-credit-overview). The node runs on behalf of the Microsoft 365 account selected in **Connection**, so choose that account with least privilege in mind. See [Add a Copilot node to a workflow (Microsoft Copilot)](https://learn.microsoft.com/microsoft-copilot-studio/workflows-experience/microsoft-365-copilot-node-workflow).

- Access to Copilot Studio workflows (**Flows** → **Build** tab) on the Microsoft Copilot harness.
- A Microsoft 365 account with appropriate access to the mail, files, calendar, and chats needed for your test scenario.
- Appropriate permissions and Copilot Credits for Microsoft 365 Copilot-connected workflow runs.
- A workflow requiring grounded research, spreadsheet analysis, summary synthesis, or multi-step Cowork artifact creation.

## Step-by-Step

### Step 1 - Define the M365-supported workflow

1. Select a scenario needing Microsoft 365-derived context (for example, opportunity briefing, audit response drafting, monthly close review, or weekly account review).
2. Decide whether the step fits **Run Copilot Chat** (general Chat, **Researcher** for deep web + M365 synthesis, **Analyst** for data/spreadsheet reasoning, or a custom **Agent Builder** agent) or **Run a Cowork task** (multi-app artifact delegation).
3. Identify expected data sources (mail, SharePoint/OneDrive files, meetings, Teams chats) and verify what the **Connection** account is permitted to read.
4. Define the exact output format required by downstream steps.
5. Set acceptance criteria for response usefulness and grounding accuracy.

### Step 2 - Add and configure the Copilot node

1. In Copilot Studio, go to **Flows**, open or create your workflow on the **Build** tab, and select the **Copilot** icon on the Add panel.
2. In **Connection**, select or create the Microsoft 365 connection whose mail, files, calendar, and chats the node should ground on.
3. Under **What would you like to do?**, choose **Run Copilot Chat** (optionally picking **Researcher**, **Analyst**, or an **Agent Builder** agent in **Agent**) or **Run a Cowork task** (leaving **Task** empty to start a new task, or selecting an existing Cowork task to resume).
4. Enter explicit instructions and output formatting in **Message** (for Chat) or **Task instructions** (for Cowork), using **Insert token** to bind dynamic content from earlier steps.
5. Bind the Copilot node's **Response** token into a downstream action (such as **Send an email** or **Post a message in Teams**), save, and run an initial test.

### Step 3 - Build permission-safe branches

1. Add a branch for successful node responses.
2. Add a branch for limited or unavailable data.
3. Add user-facing guidance when context is insufficient.
4. Prevent downstream nodes from using empty payloads.
5. Re-test with accounts of varying permissions.

### Step 4 - Validate quality and actionability

1. Run at least eight representative scenarios.
2. Score outputs for relevance and decision utility.
3. Identify repetitive low-value output patterns.
4. Adjust node prompts and context mapping.
5. Re-run and compare quality improvements.

### Step 5 - Package the integration pattern

1. Document node configuration choices that worked best.
2. Create a flow template with placeholder variables.
3. Add a troubleshooting section for permission errors.
4. Define ownership for future maintenance.
5. Share the template with your implementation team.

## Validation / Success Criteria

- Microsoft 365 Copilot node executes with correct context mapping.
- Permission-related edge cases are handled gracefully.
- Output quality is validated against your acceptance criteria.
- A reusable integration template is documented.

## References

- [Agent flows overview](https://learn.microsoft.com/microsoft-copilot-studio/flows-overview)
- [Add a Copilot node to a workflow (Microsoft Copilot)](https://learn.microsoft.com/microsoft-copilot-studio/workflows-experience/microsoft-365-copilot-node-workflow)
- [Billing and Copilot Credit management](https://learn.microsoft.com/microsoft-copilot-studio/agents-experience/billing-credit-overview)

## Lab Complete

You built a governed **Microsoft 365 Copilot node** pilot pattern for Copilot Studio agent flows.

Suggested next labs:

- [Lab 05: Supercharge Agents with Work IQ and Microsoft 365 Intelligence](../05-work-iq-m365-intelligence/index.md)
- [Lab 17: Agent Flows - Async Responses](../17-agent-flows-async-responses/index.md)
