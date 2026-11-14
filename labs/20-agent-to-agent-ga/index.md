# Lab 20: Agent-to-agent (GA)

*Implement production-ready multi-agent collaboration using generally available agent-to-agent capabilities.*

| Field | Details |
|---|---|
| ⭐ **DIFFICULTY** | Advanced (300) |
| ⏱️ **TIME** | 75 minutes |
| 🧩 **PRODUCTS** | Microsoft Copilot Studio |
| 🏷️ **TAGS** | Agent-to-Agent, Orchestration, Delegation |
| 🏭 **INDUSTRIES** | Cross-industry |

---

## Overview

In this lab, you will implement **agent-to-agent (GA)** collaboration patterns in Copilot Studio. You will design role boundaries, configure delegation paths, test handoffs, and verify that routed tasks are completed with clear ownership and reliable outcomes.

## Learning Objectives

1. Design specialized agent roles for collaboration.
2. Configure delegation and routing behavior.
3. Validate handoff quality and completion rates.
4. Detect and fix routing ambiguity.
5. Establish operating guidance for multi-agent teams.

## Prerequisites

- Access to Copilot Studio with multi-agent capabilities enabled. See [Add other agents overview](https://learn.microsoft.com/microsoft-copilot-studio/authoring-add-other-agents), [Connect to an existing Copilot Studio agent](https://learn.microsoft.com/microsoft-copilot-studio/add-agent-copilot-studio-agent), and [Connect an agent available over the Agent2Agent (A2A) protocol](https://learn.microsoft.com/microsoft-copilot-studio/add-agent-agent-to-agent).
- One primary orchestrator agent and at least two published specialist agents in the same environment (or one internal Copilot Studio specialist plus one A2A specialist).
- A target scenario that benefits from specialized sub-agents (for example, independent team ownership, independent ALM/channels, or splitting an agent approaching 30–40 tools/actions).
- Permission to edit **Instructions**, **Agents**, and **Settings** on both the orchestrator and specialists.

> ℹ️ **Key multi-agent platform rules:** Connected Copilot Studio agents must be **published**, live in the **same environment**, and have **Settings** → **Let other agents connect to and use this one** enabled. An agent that already acts as a *main agent* with connected agents cannot itself be attached as a connected agent under another main agent. Also ensure each connected agent either answers from its tools/knowledge or has **Allow ungrounded responses** enabled — otherwise ungrounded answers from a connected agent are silently discarded.

## Step-by-Step

### Step 1 - Define your agent collaboration design

1. Choose one orchestrator agent and two specialist agents (deciding whether lightweight in-agent [child agents](https://learn.microsoft.com/microsoft-copilot-studio/add-agent-child-agent) or independent connected agents fit each role).
2. Write a clear one-sentence mission for each specialist.
3. Define which requests should stay in the orchestrator and never be delegated.
4. Decide whether conversation history should be shared with each specialist (**Pass conversation history to this agent**) or restricted to the explicit task.
5. Save this design as the handoff contract.

### Step 2 - Configure connected agents and routing hints

1. Open each specialist agent, verify **Settings** → **Let other agents connect to and use this one** is **On**, and **Publish** the specialist.
2. On the orchestrator's **Agents** page, select **Add** next to **Add an agent**, and select each specialist under **Select an agent in your environment** (or **A2A agent** for an external A2A endpoint).
3. Refine each connected agent's local **Description** on the orchestrator (note that later description edits on the source agent do not auto-sync to the orchestrator — you manage the local routing description here) and configure **Pass conversation history to this agent**.
4. On the orchestrator's **Overview** page, update **Instructions** with delegation boundaries — optionally typing `/` to reference a child or connected agent directly.
5. Save and publish the orchestrator configuration.

### Step 3 - Execute handoff test scenarios

1. Create at least ten prompts that should route across specialists.
2. Run prompts in test mode and inspect activity traces.
3. Confirm each request reaches the intended specialist.
4. Verify returned output meets the handoff contract.
5. Capture misroutes and incomplete responses.

### Step 4 - Fix routing quality issues

1. Tighten descriptions where overlap causes confusion.
2. Refine orchestrator instructions for clearer delegation triggers.
3. Add clarifying prompts before uncertain handoffs.
4. Re-test the failed scenarios.
5. Confirm completion quality improved after fixes.

### Step 5 - Operationalize multi-agent governance

1. Define owners for orchestrator and each specialist.
2. Create a routing quality dashboard or checklist.
3. Add regression tests for the top delegation paths.
4. Define escalation behavior when handoffs fail.
5. Publish team guidance for future agent additions.

## Validation / Success Criteria

- Requests route to the correct specialist in your test suite.
- Handoff outputs match expected contracts.
- Routing ambiguity and misroutes were reduced measurably.
- Governance guidance exists for ongoing multi-agent operations.

## Lab Complete

You implemented a practical **agent-to-agent (GA)** operating pattern with testable delegation behavior in Copilot Studio.

> 🔗 **Related scenario lab:** [Lab 19: Connect Agents Across Platforms with the Agent-to-Agent (A2A) Protocol](../19-agent-to-agent-protocol/index.md) — the end-to-end cross-platform A2A orchestration scenario.

Suggested next labs:

- [Lab 19: Connect Agents Across Platforms with the Agent-to-Agent (A2A) Protocol](../19-agent-to-agent-protocol/index.md)
- [Lab 39: Agent Readiness / Issue Status](../39-agent-readiness-issue-status/index.md)
