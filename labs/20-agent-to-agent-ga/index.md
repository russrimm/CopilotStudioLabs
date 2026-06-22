# Lab 20: Agent-to-agent (GA)

*Implement production-ready multi-agent collaboration using generally available agent-to-agent capabilities.*

| | |
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

- Access to Copilot Studio with multi-agent capabilities enabled.
- At least one existing agent to use as the orchestrator.
- A target scenario that benefits from specialized sub-agents.
- Permission to edit instructions and connected-agent settings.

## Step-by-Step

### Step 1 - Define your agent collaboration design

1. Choose one orchestrator agent and two specialist agents.
2. Write a clear one-sentence mission for each specialist.
3. Define which requests should never be delegated.
4. Define expected outputs from each specialist.
5. Save this design as the handoff contract.

### Step 2 - Configure connected agents and routing hints

1. Connect specialist agents to the orchestrator.
2. Add concise descriptions that differentiate each specialist.
3. Update orchestrator instructions for delegation boundaries.
4. Add fallback behavior for uncertain routing cases.
5. Save and publish testable configuration.

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
