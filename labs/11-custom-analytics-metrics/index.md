# Lab 11: Custom Analytics Metrics (Preview)

*Define transcript-based custom metrics that reflect real business outcomes for your Copilot Studio agent.*

| | |
|---|---|
| ⭐ **DIFFICULTY** | Intermediate to Advanced (200-300) |
| ⏱️ **TIME** | 45 minutes plus metric-processing time |
| 🧩 **PRODUCTS** | Microsoft Copilot Studio |
| 🏷️ **TAGS** | Analytics, Custom Metrics, KPI, Preview |
| 🏭 **INDUSTRIES** | Cross-industry |

---

## Overview

Copilot Studio custom metrics are a preview analytics capability. You can define up to three natural-language metrics that Copilot Studio evaluates against a sample of conversation transcripts. In this lab, you will define measurable criteria, generate the metrics, review sampled evidence, and decide how the results should influence agent improvements.

> [!IMPORTANT]
> Custom metrics are preview, transcript-sampled signals. They aren't a complete audit of every conversation and must not be the only production quality or compliance gate.

## Learning Objectives

1. Define up to three clear natural-language metrics.
2. Generate custom metrics from eligible conversation transcripts.
3. Review sampled evidence and challenge false positives or negatives.
4. Compare the custom signal with standard analytics and manual review.
5. Establish ownership and a review cadence.

## Prerequisites

- Access to a published Copilot Studio agent and its **Analytics** page.
- Eligible conversations from supported published channels; test-pane conversations don't appear in Analytics.
- Permission to use the custom metrics preview in your environment.
- A non-sensitive scenario with clear success and failure criteria.

## Step-by-Step

### Step 1 - Define measurable outcomes

1. Select one to three outcomes that can be judged from a conversation transcript.
2. Write each metric as a concise natural-language criterion.
3. Avoid criteria that require data the transcript can't show, such as a downstream business outcome that isn't returned to the conversation.
4. Identify an owner who will review the metric and its evidence.

Example criteria:

- `The agent gave a grounded answer and cited an approved source.`
- `The agent escalated when the request required account changes or privileged access.`
- `The user received a clear next step when the agent couldn't complete the request.`

### Step 2 - Create the metrics

1. Open the agent's **Analytics** page and locate **Custom metrics**.
2. Create each metric using the approved criterion.
3. Review the generated interpretation before saving.
4. Keep the set to three or fewer metrics and avoid overlapping definitions.
5. Start metric generation and record when processing began.

### Step 3 - Review sampled evidence

1. When results are available, review the reported rate for each metric.
2. Open representative supporting transcripts where your permissions allow.
3. Check several positive and negative classifications manually.
4. Record ambiguous examples, false positives, and false negatives.
5. Refine the metric wording if reviewers interpret it inconsistently.

> [!NOTE]
> Results are based on sampled transcripts and can change as the conversation population changes. Treat small movements cautiously.

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
