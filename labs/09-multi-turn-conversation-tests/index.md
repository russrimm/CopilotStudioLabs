# Lab 20: Multi-turn Conversation Tests

*Validate how your Copilot Studio agent behaves over full conversations, not just single prompts.*

| | |
|---|---|
| ⭐ **DIFFICULTY** | Intermediate (200) |
| ⏱️ **TIME** | 60 minutes |
| 🧩 **PRODUCTS** | Microsoft Copilot Studio |
| 🏷️ **TAGS** | Multi-turn Testing, Conversation Quality, Regression |
| 🏭 **INDUSTRIES** | Cross-industry |

---

## Overview

Single-turn checks often miss real failures such as state loss, skipped confirmations, and incorrect follow-up questions. In this lab, you will design and run **multi-turn conversation tests** in Copilot Studio to verify context retention, branching behavior, and completion quality across longer user journeys.

## Learning Objectives

1. Design realistic multi-turn test conversations.
2. Validate state handling across conversation branches.
3. Detect context drift and memory loss issues.
4. Compare multi-turn outcomes across agent revisions.
5. Build a reusable conversation regression pack.

## Prerequisites

- Access to a Copilot Studio agent with topic coverage for a full workflow.
- At least one process that requires user confirmation or follow-up.
- A baseline test set or transcript examples from prior runs.
- Permission to edit instructions and topics.

## Step-by-Step

### Step 1 - Identify multi-turn business journeys

1. Select two high-value workflows that require at least four turns.
2. Break each workflow into expected stages and decision points.
3. Define what context must persist between turns.
4. List where clarifying questions should appear.
5. Record failure signals such as repeated questions or missing confirmations.

### Step 2 - Author multi-turn test scripts

1. Create test scripts with realistic user phrasing and follow-ups.
2. Include at least one branch where the user changes requirements mid-conversation.
3. Add a branch where the user provides incomplete information.
4. Define expected assistant behavior after each turn.
5. Save scripts with labels for easy reruns.

### Step 3 - Execute and observe conversations

1. Run each script in Copilot Studio test mode.
2. Capture where the agent asks unnecessary or duplicate questions.
3. Verify that collected values are reused correctly later in the flow.
4. Check whether escalation or fallback appears at the right time.
5. Document transcript excerpts for all failed turns.

### Step 4 - Fix context and branching defects

1. Update topic logic where variables are dropped or overwritten.
2. Refine instructions to improve concise follow-up behavior.
3. Add guardrails for branch transitions and edge paths.
4. Re-test the same scripts after each targeted fix.
5. Confirm no new defects appeared in previously passing paths.

### Step 5 - Build a reusable regression suite

1. Select the strongest multi-turn scripts for ongoing regression.
2. Store them in a shared team location with clear naming.
3. Define run frequency (for example, before release).
4. Add pass/fail criteria for conversation completion.
5. Assign an owner for test maintenance as scenarios evolve.

## Validation / Success Criteria

- At least two multi-turn scripts run end-to-end.
- Context retention is verified at key turns.
- You fixed at least one branching or follow-up defect.
- A reusable regression conversation pack is documented.

## Lab Complete

You created a repeatable method for validating conversation quality across full user journeys.

Suggested next labs:

- [Lab 21: Question/Reaction Exports](../21-question-reaction-exports/index.md)
- [Lab 29: Agent Flows - Async Responses](../29-agent-flows-async-responses/index.md)
