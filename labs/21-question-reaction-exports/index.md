# Lab 21: Question/Reaction Exports

*Export and analyze user questions and reactions to prioritize high-impact improvements in Copilot Studio.*

| | |
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

- Access to Copilot Studio analytics for a deployed or tested agent.
- Enough recent interaction volume to analyze patterns.
- A spreadsheet or BI tool for filtering and grouping.
- A team backlog where actions can be tracked.

## Step-by-Step

### Step 1 - Export question and reaction data

1. Open your agent analytics in Copilot Studio.
2. Locate export options for user questions and reactions.
3. Export data for a defined window (for example, last 14 days).
4. Save files with date-stamped names.
5. Confirm all expected columns were included.

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

- [Lab 19: Agent Evaluations (GA)](../19-agent-evaluations-ga/index.md)
- [Lab 31: Custom Analytics Metrics](../31-custom-analytics-metrics/index.md)
