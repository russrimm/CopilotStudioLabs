# Lab 11: Custom Analytics Metrics (Preview)

*Define transcript-based custom metrics that reflect real business outcomes for your Copilot Studio agent.*

| Field | Details |
|---|---|
| ⭐ **DIFFICULTY** | Intermediate to Advanced (200-300) |
| ⏱️ **TIME** | 45 minutes plus metric-processing time |
| 🧩 **PRODUCTS** | Microsoft Copilot Studio |
| 🏷️ **TAGS** | Analytics, Custom Metrics, KPI, Preview |
| 🏭 **INDUSTRIES** | Cross-industry |

---

## Overview

Copilot Studio [custom metrics (preview)](https://learn.microsoft.com/microsoft-copilot-studio/analytics-custom-metrics) let you define natural-language evaluation criteria — formatted as **Binary classification**, **Multiclass classification** (up to 10 categories), or **Numeric score** — on the **Monitor** page of a standard-harness agent. During **Preview**, Copilot Studio tests your criterion on a sample of historical sessions; once saved, custom metrics are calculated across **all applicable sessions from the preceding seven days** and then **daily** for new sessions. In this lab, you will define measurable criteria, preview and save the metrics, review session evidence, and decide how the results should influence agent improvements.

> [!IMPORTANT]
> Custom metrics are a **preview** capability on the standard harness (not supported for autonomous agents or flows), require the **Bot Transcript Viewer** security role to inspect session messages, and delete historical metric data whenever you edit and recreate a saved metric. Never use a custom metric as your sole production quality or compliance gate.

## Learning Objectives

1. Define one to three clear natural-language metrics using Binary, Multiclass, or Numeric formats.
2. Preview criteria on sampled sessions and save custom metrics on the **Monitor** page.
3. Review session-level evidence and challenge false positives or negatives.
4. Compare the custom signal with standard analytics and Agent Evaluations.
5. Establish ownership and a review cadence.

## Prerequisites

- Access to a published conversational Copilot Studio agent (standard harness) and its **Monitor** page (formerly **Analytics**). See [Analyze agent performance](https://learn.microsoft.com/microsoft-copilot-studio/analytics-overview).
- The **Bot Transcript Viewer** security role so you can inspect supporting session transcripts.
- Eligible conversations from supported published channels; test-pane conversations and autonomous agent runs don't appear in custom metrics.
- Permission to use the custom metrics preview in your environment.
- A non-sensitive scenario with clear success and failure criteria.

## Step-by-Step

### Step 1 - Define measurable outcomes

1. Select one to three outcomes that can be judged directly from a conversation transcript, and choose the right output type for each (**Binary classification**, **Multiclass classification** with up to 10 categories, or **Numeric score**).
2. Write each metric description in clear natural language.
3. Avoid criteria that require data the transcript can't show, such as a downstream business outcome that isn't returned to the conversation.
4. Identify an owner who will review the metric and its evidence.

Example criteria:

- `The agent gave a grounded answer and cited an approved source.` (Binary classification)
- `Classify the primary escalation reason in this session (up to 10 categories).` (Multiclass classification)
- `Score how clearly the agent stated the user's next step from 1 to 5.` (Numeric score)

### Step 2 - Preview and save the metrics

1. Open the agent's **Monitor** page, locate **Custom metrics** above the **Summary** card, and select **Create a custom metric**.
2. Enter the metric name, format (**Binary classification**, **Multiclass classification**, or **Numeric score**), and natural-language instructions, then select **Next**.
3. Run **Preview** and inspect both the **Results** tab (sampled historical sessions) and the **Prompt** tab (the generated evaluator prompt) to tune wording before saving — remember that editing a metric later recreates it and deletes its history.
4. Select **Save metric** and record when calculation started (initial calculation covers applicable sessions from the preceding 7 days, followed by daily updates).

### Step 3 - Review session evidence

1. When results are available on the **Monitor** page, review the reported rate, category distribution, or score trend for each metric.
2. Open representative supporting session messages (requires **Bot Transcript Viewer**).
3. Check several positive and negative classifications manually.
4. Record ambiguous examples, false positives, and false negatives.
5. Only recreate a metric when wording defects justify resetting its historical trend.

> [!NOTE]
> **Preview** evaluates a sample of historical sessions, whereas saved metrics run across applicable sessions from the past 7 days and then daily. Treat early trends cautiously while volume builds.

### Step 4 - Triangulate the result

1. Compare the custom metric with standard analytics such as resolution, escalation, or abandonment.
2. Compare it with a manually reviewed evaluation set.
3. Investigate material disagreement rather than choosing the more favorable number.
4. Document the sample window, metric wording, and known limitations with every decision.

### Step 5 - Establish a review cadence

1. Assign an owner for each metric.
2. Define when wording changes require a new baseline.
3. Set a recurring review that includes transcript sampling and standard analytics.
4. Link findings to specific knowledge, instruction, topic, or tool improvements.
5. Retire metrics that no longer support a decision.

## Validation / Success Criteria

- One to three custom metrics are defined with observable criteria.
- Results were generated from eligible published-channel conversations.
- A reviewer checked supporting transcript samples for classification quality.
- Findings were compared with standard analytics or a manual evaluation set.
- Owners, limitations, and the next review date are documented.

## Documentation

- [Analyze your agent with custom metrics (preview)](https://learn.microsoft.com/microsoft-copilot-studio/analytics-custom-metrics)

## Lab Complete

You created a reviewable custom-metrics pilot without treating sampled preview analytics as a complete production audit.

Suggested next labs:

- [Lab 10: Question/Reaction Exports](../10-question-reaction-exports/index.md)
- [Lab 39: Agent Readiness / Issue Status](../39-agent-readiness-issue-status/index.md)
