# Lab 09: Multi-turn Conversation Tests

*Validate how your Copilot Studio agent behaves over full conversations, not just single prompts.*

| Field | Details |
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

- Access to a Copilot Studio agent on the [standard harness](https://learn.microsoft.com/microsoft-copilot-studio/harnesses-overview#standard-harness) with topic or orchestration coverage for a full workflow. See [Evaluate agents with multi-turn conversation test sets](https://learn.microsoft.com/microsoft-copilot-studio/analytics-agent-evaluation-multi-turn).
- At least one process that requires user confirmation or follow-up.
- A baseline test set or transcript examples from prior runs.
- Permission to edit instructions, topics, and evaluations on the **Evaluation** page.

> ℹ️ **Platform limits to plan around:** Each **Conversation** test set supports up to **20 test cases**, and each conversation supports up to **12 messages (6 user-and-agent Q&A pairs)**. Multi-turn conversation evaluations are scored at the full-conversation level using **Conversation quality** and **Content safety**.

## Step-by-Step

### Step 1 - Identify multi-turn business journeys

1. Select two high-value workflows that require two to six user turns (up to 12 total messages).
2. Break each workflow into expected stages and decision points.
3. Define what context must persist between turns.
4. List where clarifying questions should appear.
5. Record failure signals such as repeated questions or missing confirmations.

### Step 2 - Author a Conversation test set

1. Open your agent's **Evaluation** page, select **New evaluation**, and choose **Conversation**.
2. Choose one of the three supported authoring paths: **Quick conversation set** (auto-generates up to 10 cases from your agent's topics and knowledge), **Full conversation set** (upload a `.csv` or `.txt` file of scripted turns), or **Use your test chat** (capture a live multi-turn test session).
3. Include at least one conversation where the user changes requirements mid-journey and one where the user supplies incomplete information.
4. Configure **Conversation quality** criteria and **Content safety** thresholds, and select a **User profile** if authenticated tools or knowledge are used.
5. Save the conversation test set (up to 20 test cases per set) with clear labels for reruns.

### Step 3 - Execute and observe conversations

1. Select **Evaluate** to run the multi-turn conversation test set (and cross-check interactive behavior in the **Test** pane where helpful).
2. Inspect each conversation transcript and activity map to spot unnecessary or duplicate questions.
3. Verify that collected values are reused correctly later in the conversation.
4. Check whether escalation or fallback appears at the right turn.
5. Export CSV results and capture transcript excerpts for failed conversations (runs remain in Copilot Studio for up to 89 days).

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

- [Lab 10: Question/Reaction Exports](../10-question-reaction-exports/index.md)
- [Lab 17: Agent Flows - Async Responses](../17-agent-flows-async-responses/index.md)
