# Lab 29: Agent Flows - Async Responses

*Design resilient asynchronous response patterns in Copilot Studio agent flows for long-running work.*

| | |
|---|---|
| ⭐ **DIFFICULTY** | Advanced (300) |
| ⏱️ **TIME** | 75 minutes |
| 🧩 **PRODUCTS** | Microsoft Copilot Studio |
| 🏷️ **TAGS** | Agent Flows, Async Responses, Long-running Tasks |
| 🏭 **INDUSTRIES** | Cross-industry |

---

## Overview

Some workflows cannot complete within a single turn. In this lab, you will build **async response** patterns in Copilot Studio agent flows, including acknowledgement messaging, deferred completion paths, and user-safe follow-up handling.

## Learning Objectives

1. Design asynchronous flow behavior for long-running work.
2. Provide clear interim responses and completion updates.
3. Handle timeouts and delayed dependencies gracefully.
4. Validate user experience across async states.
5. Operationalize monitoring for async success and failures.

## Prerequisites

- Access to Copilot Studio flow authoring.
- A workflow known to require delayed processing.
- A test scenario with simulated slow dependencies.
- Permission to edit flow status and callback logic.

## Step-by-Step

### Step 1 - Identify async candidates and states

1. Choose one workflow with expected delayed completion.
2. Define async states: accepted, processing, completed, failed.
3. Define user-visible messages for each state.
4. Define maximum wait thresholds and timeout policy.
5. Document which events trigger completion notices.

### Step 2 - Build async acknowledgement behavior

1. Add flow logic to acknowledge request receipt immediately.
2. Include a reference ID in the acknowledgement message.
3. Store required context for deferred completion.
4. Add status update placeholders for follow-up checks.
5. Save and test acknowledgement delivery.

### Step 3 - Implement completion and timeout branches

1. Add a completion branch that returns final results.
2. Add a timeout branch with clear next actions.
3. Add a failure branch with escalation guidance.
4. Ensure each branch preserves user context.
5. Validate branch transitions using test scenarios.

### Step 4 - Test end-to-end async experience

1. Run at least six scenarios with varied completion times.
2. Verify status messages are clear and non-duplicative.
3. Confirm users receive completion or timeout outcomes.
4. Capture any confusing state transitions.
5. Refine messaging and branching logic.

### Step 5 - Set async operating standards

1. Define SLA targets for async completion.
2. Define alerting thresholds for delayed requests.
3. Add a runbook for support teams.
4. Add regression tests for async paths.
5. Publish standards for future async flows.

## Validation / Success Criteria

- Users receive immediate acknowledgement for async work.
- Completion, timeout, and failure paths are validated.
- Async status handling preserves context correctly.
- Monitoring and operational guidance are documented.

## Lab Complete

You implemented a practical **async response** flow pattern in Copilot Studio for long-running scenarios.

Suggested next labs:

- [Lab 26: Agent Flows - Agent Nodes](../26-agent-flows-agent-nodes/index.md)
- [Lab 33: Agent Readiness / Issue Status](../33-agent-readiness-issue-status/index.md)
