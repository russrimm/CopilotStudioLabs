# Lab 26: Agent Flows - Agent Nodes

*Orchestrate Copilot Studio workflows that call specialized agents through agent nodes.*

| | |
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

- Access to Copilot Studio agent flow authoring.
- One orchestrator agent and one specialist agent.
- A scenario requiring structured multi-step processing.
- Permission to edit flow nodes and variables.

## Step-by-Step

### Step 1 - Design your flow contract

1. Map the user request lifecycle across flow stages.
2. Define which stage requires a specialist agent call.
3. Specify required input variables for the agent node.
4. Specify expected output schema from the node.
5. Record fallback behavior for node failures.

### Step 2 - Build the flow and insert an agent node

1. Create a new agent flow for your scenario.
2. Add initial nodes for request intake and normalization.
3. Insert an agent node where specialist reasoning is needed.
4. Bind required input variables to the node.
5. Connect output variables to downstream steps.

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

- [Lab 27: Agent Flows - Prompt Nodes](../27-agent-flows-prompt-nodes/index.md)
- [Lab 29: Agent Flows - Async Responses](../29-agent-flows-async-responses/index.md)
