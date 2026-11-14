# Lab 15: Agent Flows - Agent Nodes

*Orchestrate Copilot Studio workflows that call specialized agents through agent nodes.*

| Field | Details |
|---|---|
| ⭐ **DIFFICULTY** | Intermediate to Advanced (200-300) |
| ⏱️ **TIME** | 75 minutes |
| 🧩 **PRODUCTS** | Microsoft Copilot Studio |
| 🏷️ **TAGS** | Agent Flows, Agent Nodes, Orchestration |
| 🏭 **INDUSTRIES** | Cross-industry |

---

## Overview

Agent nodes let you compose workflows that invoke specialized agents at the right moment. In this lab, you will build an **agent flow with agent nodes**, pass structured context, and verify deterministic transitions from one node to the next.

## Learning Objectives

1. Build an agent flow that uses agent nodes.
2. Pass context safely between nodes.
3. Define entry and exit contracts for node transitions.
4. Validate routing and fallback behavior.
5. Tune flow design for clarity and maintainability.

## Prerequisites

- Access to Copilot Studio agent flow authoring (**Flows** → **Designer**). See [Add an agent node to an agent flow](https://learn.microsoft.com/microsoft-copilot-studio/agent-node-workflow) and [Agent flows overview](https://learn.microsoft.com/microsoft-copilot-studio/flows-overview).
- One published specialist agent equipped with the required instructions, knowledge (such as SharePoint or public websites), or tools (connectors and MCP servers) — or permission to create a new agent from the node.
- A scenario requiring multi-turn reasoning, grounded knowledge, or tool orchestration beyond a single-turn prompt node.
- Permission to edit flow nodes, connections, and variables.

## Step-by-Step

### Step 1 - Design your flow contract

1. Map the user request lifecycle across flow stages: intake/normalization steps first, agent reasoning in the middle, and deterministic system updates after.
2. Confirm the stage truly needs an **agent node** (multi-step reasoning, MCP/connector tools, SharePoint/web grounding, or human escalation) rather than a lightweight prompt node.
3. Specify the runtime tokens you will pass into the node's **Message** field.
4. Specify the expected structure in **agent response** for downstream steps.
5. Decide whether to turn on **Request human assistance when unsure** (which emails the connection owner for input when the agent can't proceed safely on its own).

### Step 2 - Build the flow and insert an agent node

1. In Copilot Studio, go to **Flows**, open or create your agent flow on the **Designer** page, and add initial actions for request intake and normalization.
2. Select **Insert a new action** at the reasoning step, and under **AI capabilities** select **Run an agent**.
3. Under **Agent**, choose **Select an existing agent** to pick your published specialist (or **New** to build and publish one in a new tab, or configure an inline workflow-scoped agent if authoring on the Microsoft Copilot harness).
4. In the **Message** field, write the task instruction for this run and insert upstream values from the dynamic content picker; toggle **Request human assistance when unsure** if human escalation is required.
5. In downstream actions, open the dynamic content picker and bind **agent response** from the **Run an agent** step.

### Step 3 - Add validation and branching logic

1. Add checks for missing or malformed node output.
2. Create a branch for valid specialist responses.
3. Create a branch for low-confidence or empty responses.
4. Add a user-facing clarification path where needed.
5. Save and test each branch path.

### Step 4 - Run end-to-end tests

1. Execute at least eight test scenarios.
2. Confirm agent node is called only when expected.
3. Verify output mapping into later nodes.
4. Capture failures in node contract handling.
5. Refine mappings and rerun failed scenarios.

### Step 5 - Harden for team reuse

1. Document the node input and output contract.
2. Add naming conventions for flow variables.
3. Add a quick troubleshooting note for common failures.
4. Create a reusable starter template for similar flows.
5. Share the pattern with your maker team.

## Validation / Success Criteria

- Agent node executes with correct input bindings.
- Output variables map correctly to downstream nodes.
- Fallback and clarification branches work as designed.
- The flow contract is documented for reuse.

## Lab Complete

You implemented a robust **agent-flow agent node** pattern for modular orchestration in Copilot Studio.

Suggested next labs:

- [Lab 14: Agent Flows - Prompt Nodes](../14-agent-flows-prompt-nodes/index.md)
- [Lab 17: Agent Flows - Async Responses](../17-agent-flows-async-responses/index.md)
