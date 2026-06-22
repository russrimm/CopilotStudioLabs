# Lab 28: Agent Flows - M365 Copilot Nodes

*Integrate Microsoft 365 Copilot capabilities into Copilot Studio agent flows using M365 Copilot nodes.*

| | |
|---|---|
| ⭐ **DIFFICULTY** | Advanced (300) |
| ⏱️ **TIME** | 75 minutes |
| 🧩 **PRODUCTS** | Microsoft Copilot Studio, Microsoft 365 |
| 🏷️ **TAGS** | Agent Flows, M365 Copilot, Knowledge Work |
| 🏭 **INDUSTRIES** | Cross-industry |

---

## Overview

This lab teaches you how to use **M365 Copilot nodes** inside Copilot Studio agent flows for research, summarization, and productivity-centric workflows. You will add node orchestration, pass context cleanly, and validate enterprise-ready output quality.

## Learning Objectives

1. Add M365 Copilot nodes to an agent flow.
2. Pass business context and task intent into nodes.
3. Validate output quality for decision-support scenarios.
4. Handle missing data and permission-related constraints.
5. Build a reusable M365 node orchestration pattern.

## Prerequisites

- Access to Copilot Studio with agent flows.
- Access to Microsoft 365 data relevant to your scenario.
- Appropriate permissions for M365 Copilot-connected tasks.
- A workflow requiring research or summary synthesis.

## Step-by-Step

### Step 1 - Define the M365-supported workflow

1. Select a scenario needing M365-derived context.
2. Identify expected data sources (mail, docs, meetings, etc.).
3. Define required output for business decisions.
4. Capture sensitivity constraints for enterprise data.
5. Set acceptance criteria for response usefulness.

### Step 2 - Add and configure M365 Copilot nodes

1. Open your flow and add an M365 Copilot node.
2. Configure node objective and output expectations.
3. Bind incoming context variables to the node.
4. Add a concise instruction for response format.
5. Save and run an initial test.

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

- M365 Copilot node executes with correct context mapping.
- Permission-related edge cases are handled gracefully.
- Output quality is validated against your acceptance criteria.
- A reusable integration template is documented.

## Lab Complete

You built an enterprise-ready **M365 Copilot node** pattern for Copilot Studio agent flows.

Suggested next labs:

- [Lab 08: Supercharge Agents with Work IQ and Microsoft 365 Intelligence](../08-work-iq-m365-intelligence/index.md)
- [Lab 29: Agent Flows - Async Responses](../29-agent-flows-async-responses/index.md)
