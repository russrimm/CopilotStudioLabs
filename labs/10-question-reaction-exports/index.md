# Lab 10: Question/Reaction Exports

*Export and analyze user questions and reactions to prioritize high-impact improvements in Copilot Studio.*

| Field | Details |
|---|---|
| ⭐ **DIFFICULTY** | Intermediate (200) |
| ⏱️ **TIME** | 45 minutes |
| 🧩 **PRODUCTS** | Microsoft Copilot Studio, Excel or Power BI |
| 🏷️ **TAGS** | Analytics, Exports, User Feedback |
| 🏭 **INDUSTRIES** | Cross-industry |

---

## Overview

Analytics exports help you move from anecdotal feedback to evidence-based prioritization. In this lab, you will generate **question and reaction exports**, classify issues, and convert findings into an improvement backlog for your Copilot Studio agent.

## Learning Objectives

1. Export question and reaction data from Copilot Studio.
2. Classify usage and feedback patterns.
3. Identify high-frequency failure themes.
4. Translate analytics into backlog-ready actions.
5. Set a repeatable review rhythm with stakeholders.

## Prerequisites

- Access to the **Monitor** page (formerly **Analytics**) for a **published** standard-harness agent with conversations in a supported channel, plus the **Bot Transcript Viewer** security role required to view and download drill-down transcripts. Test-pane activity does not appear in Monitor. See [Drill-down lists for questions, themes, and user reactions](https://learn.microsoft.com/microsoft-copilot-studio/analytics-drill-down-lists) and [Analyze agent performance](https://learn.microsoft.com/microsoft-copilot-studio/analytics-overview).
- Enough recent interaction volume within the **28-day** transcript retention window to analyze patterns.
- A spreadsheet or BI tool for filtering and grouping `.csv` exports.
- A team backlog where actions can be tracked.

## Step-by-Step

### Step 1 - Export question and reaction data

1. Open your agent's **Monitor** page in Copilot Studio and set your date filter (drill-down query and reaction lists cover up to the **past 28 days**).
2. Open the drill-down panels: select **See questions** on the **Answers** card (or **Themes** on the **Questions** card) for unanswered/answered user queries, and select **Reactions** or **Comments** on the **Satisfaction** card for thumbs-up / thumbs-down message feedback.
3. Select **Download questions** and **Download reactions** to export the `.csv` files (and optionally select **Evaluate** next to high-priority questions to seed an Agent Evaluation test set directly).
4. Save files with date-stamped names in an approved team location.
5. Confirm all expected columns were included and redact any sensitive user text before broad sharing.

### Step 2 - Prepare and normalize data

1. Load exports into Excel or Power BI.
2. Normalize timestamps and user-intent labels.
3. Remove obvious duplicates or test-only noise.
4. Add a category column for issue type.
5. Add a severity column based on business impact.

### Step 3 - Analyze top patterns

1. Group questions by intent and frequency.
2. Group reactions by positive, neutral, and negative signals.
3. Identify topics with frequent negative reactions.
4. Correlate high-frequency questions with low satisfaction.
5. Select top five improvement opportunities.

### Step 4 - Convert findings to actions

1. Create backlog items tied to specific patterns.
2. Link each item to a likely fix area (prompt, topic, tool, knowledge).
3. Assign owners and target dates.
4. Define expected measurable outcome for each item.
5. Prioritize quick wins that reduce repeated confusion.

### Step 5 - Create your recurring review loop

1. Schedule a recurring export and review cadence.
2. Define who prepares analysis and who approves changes.
3. Create a baseline dashboard for trend tracking.
4. Add a checkpoint to verify post-fix impact.
5. Share results with product and operations stakeholders.

## Validation / Success Criteria

- You exported both questions and reactions successfully.
- You identified and ranked the top improvement patterns.
- You converted findings into backlog items with owners.
- A recurring analytics review process is documented.

## Lab Complete

You established a practical analytics loop that turns agent interaction data into measurable quality improvements.

Suggested next labs:

- [Lab 08: Agent Evaluations (GA)](../08-agent-evaluations-ga/index.md)
- [Lab 11: Custom Analytics Metrics](../11-custom-analytics-metrics/index.md)
