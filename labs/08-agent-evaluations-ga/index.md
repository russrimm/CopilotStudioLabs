# Lab 08: Agent Evaluations (GA)

*Use generally available evaluation tooling to measure quality, catch regressions, and improve Copilot Studio agent responses.*

| | |
|---|---|
| ⭐ **DIFFICULTY** | Intermediate (200) |
| ⏱️ **TIME** | 60 minutes |
| 🧩 **PRODUCTS** | Microsoft Copilot Studio |
| 🏷️ **TAGS** | Agent Evaluations, Quality, Regression Testing |
| 🏭 **INDUSTRIES** | Cross-industry |

---

## Overview

In this lab, you will operationalize **Agent Evaluations (GA)** in Copilot Studio for repeatable quality checks. You will define evaluation goals, generate and curate a test set, run baseline and post-change evaluations, and interpret score deltas so your team can make safe improvements with evidence.

## Learning Objectives

1. Configure an evaluation-ready Copilot Studio agent.
2. Create and curate a realistic evaluation test set.
3. Run baseline and comparison evaluations.
4. Interpret score changes and failure clusters.
5. Convert evaluation findings into targeted prompt and flow improvements.

## Prerequisites

- Access to Copilot Studio with permission to run evaluations.
- A published or test-ready agent with at least one business scenario.
- A documented quality target (for example, groundedness and task completion).
- Sample prompts from real user questions.

## Step-by-Step

### Step 1 - Define your evaluation scope

1. Open your target agent in Copilot Studio.
2. List the top three user intents you must evaluate first.
3. Define pass thresholds for quality dimensions your team cares about.
4. Record known risk areas such as ambiguous prompts or policy-heavy answers.
5. Save this scope in your project notes before creating tests.

### Step 2 - Build a baseline test set

1. Open the evaluations area and create a new test set.
2. Add at least 15 prompts across your three priority intents.
3. Include edge cases such as incomplete requests and conflicting constraints.
4. Add expected outcomes or acceptance notes for each prompt.
5. Tag prompts by intent so failures can be grouped later.

### Step 3 - Run the baseline evaluation

1. Execute an evaluation run using your baseline test set.
2. Wait for scoring to complete and open the run summary.
3. Identify the lowest-scoring dimensions first.
4. Capture at least five failing examples with transcript excerpts.
5. Export or document results so you can compare after changes.

### Step 4 - Improve and rerun

1. Apply one focused improvement (instructions, topic logic, or tool routing).
2. Republish or save your updated agent configuration.
3. Run the same test set again for an apples-to-apples comparison.
4. Compare new and baseline scores by dimension and by intent.
5. Confirm whether improvements helped without causing regressions elsewhere.

### Step 5 - Operationalize evaluation cadence

1. Define when evaluations run (for example, before each publish).
2. Set minimum acceptance thresholds for go/no-go decisions.
3. Create a triage list for recurring failure patterns.
4. Assign owners for prompt, flow, and knowledge-source fixes.
5. Document the next evaluation date and target improvements.

## Validation / Success Criteria

- You completed at least one baseline and one comparison run.
- You can show measurable score change for at least one quality dimension.
- You documented top failure patterns and corresponding action items.
- You established a repeatable evaluation cadence for your team.

## Lab Complete

You implemented a practical **Agent Evaluations (GA)** workflow in Copilot Studio. Your team can now improve agent quality based on measurable outcomes instead of intuition.

> 🔗 **Related scenario lab:** [Lab 07: Monitor Performance and Evaluate Contoso Agent Quality](../07-agent-analytics-evaluations/index.md) — the end-to-end analytics-and-evaluation scenario this feature plugs into. Related analytics feature labs: [Lab 10: Question & Reaction Exports](../10-question-reaction-exports/index.md) and [Lab 11: Custom Analytics Metrics](../11-custom-analytics-metrics/index.md).

Suggested next labs:

- [Lab 09: Multi-turn Conversation Tests](../09-multi-turn-conversation-tests/index.md)
- [Lab 11: Custom Analytics Metrics](../11-custom-analytics-metrics/index.md)
