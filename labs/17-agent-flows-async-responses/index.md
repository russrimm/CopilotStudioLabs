# Lab 17: Agent Flows - Async Responses

*Design resilient asynchronous response patterns in Copilot Studio agent flows for long-running work.*

| Field | Details |
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
- A flow that uses **When an agent calls the flow** and **Respond to the agent**.
- A Power Automate environment running on the [new infrastructure](https://learn.microsoft.com/power-automate/environment-architecture).

> ⚠️ **Channel limitation:** Callback support is fully supported in Teams, isn't formally tested in other channels, and isn't supported in Microsoft 365 Copilot or telephony. Validate the target channel before selecting this pattern. See [Asynchronous response support for agent flows](https://learn.microsoft.com/microsoft-copilot-studio/flow-asynchronous-response).

## Step-by-Step

### Step 1 - Choose async callback vs. immediate response

1. Choose one agent flow that uses **When an agent calls the flow** and runs longer than the default **two-minute** synchronous limit.
2. Decide between the two documented patterns in [Asynchronous response support for agent flows](https://learn.microsoft.com/microsoft-copilot-studio/flow-asynchronous-response):
   - **Asynchronous callback (`Asynchronous response` = On):** Keep **Respond to the agent** so the flow runs past two minutes and sends a callback response when finished (fully supported in **Microsoft Teams**; not supported in **Microsoft 365 Copilot** or telephony).
   - **Immediate fire-and-forget response:** Remove the **Respond to the agent** action if you want the agent to reply immediately after triggering the flow while background work continues separately.
3. Define how the agent should handle interim user turns (while an async flow is still running, if the user sends another message, the agent responds to the new message immediately without waiting for the flow to finish).
4. Define maximum wait thresholds, external dependency timeouts, and failure notifications.
5. Document which structured outputs **Respond to the agent** will return on completion.

### Step 2 - Enable Asynchronous response on Respond to the agent

1. Open your agent flow in Copilot Studio and confirm the trigger is **When an agent calls the flow**.
2. Select the **Respond to the agent** action at the end of the flow to open its configuration pane.
3. Select **Settings**, turn on **Asynchronous response**, and define the output fields returned to the calling agent.
4. Attach the flow as a tool on your agent (see [Call an agent flow from an agent](https://learn.microsoft.com/microsoft-copilot-studio/advanced-use-flow)) with clear description metadata explaining that the action is long-running.
5. Save and publish the flow, then test that runs exceeding two minutes complete and deliver the callback response in Teams.

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

- [Lab 15: Agent Flows - Agent Nodes](../15-agent-flows-agent-nodes/index.md)
- [Lab 39: Agent Readiness / Issue Status](../39-agent-readiness-issue-status/index.md)
