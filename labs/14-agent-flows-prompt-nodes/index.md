# Lab 27: Agent Flows - Prompt Nodes

*Use prompt nodes to generate structured, context-aware outputs inside Copilot Studio agent flows.*

| | |
|---|---|
| ⭐ **DIFFICULTY** | Intermediate (200) |
| ⏱️ **TIME** | 60 minutes |
| 🧩 **PRODUCTS** | Microsoft Copilot Studio |
| 🏷️ **TAGS** | Agent Flows, Prompt Nodes, Structured Output |
| 🏭 **INDUSTRIES** | Cross-industry |

---

## Overview

Prompt nodes let you run targeted prompting logic as part of a broader flow. In this lab, you will configure **prompt nodes** for classification and synthesis tasks, enforce output structure, and test reliability across varied inputs.

## Learning Objectives

1. Configure prompt nodes for reusable in-flow reasoning.
2. Enforce consistent output shape from prompt nodes.
3. Use flow variables as prompt context safely.
4. Validate prompt node behavior under edge cases.
5. Optimize node prompts for precision and speed.

## Prerequisites

- Access to Copilot Studio flow authoring.
- A scenario requiring classification, summarization, or extraction.
- A sample set of varied user inputs.
- Permission to edit prompts and flow branches.

## Step-by-Step

### Step 1 - Select the prompt-node use case

1. Choose one in-flow task suited to prompting.
2. Define required output fields for downstream logic.
3. Document examples of correct and incorrect outputs.
4. Identify guardrails needed for safe output.
5. Set a target response quality threshold.

### Step 2 - Build and configure the prompt node

1. Add a prompt node to your agent flow.
2. Write a focused prompt with explicit output format.
3. Bind flow variables into the prompt context.
4. Add fallback instructions for ambiguous input.
5. Save and test with baseline examples.

### Step 3 - Enforce structured output usage

1. Map prompt-node output fields to flow variables.
2. Add validation checks for required fields.
3. Route invalid output to a repair or clarification path.
4. Ensure downstream nodes consume validated data only.
5. Re-test with intentionally noisy inputs.

### Step 4 - Tune prompt quality and latency

1. Compare two prompt variants for quality.
2. Remove unnecessary wording that adds latency.
3. Improve few-shot examples where precision is low.
4. Re-run your test set and compare outcomes.
5. Select the best-performing variant.

### Step 5 - Standardize the prompt-node pattern

1. Create a reusable template for prompt-node design.
2. Document naming and output-schema conventions.
3. Add a checklist for quality and safety review.
4. Define when to use prompt nodes versus agent nodes.
5. Share standards with your team.

## Validation / Success Criteria

- Prompt node produces consistent structured output.
- Invalid output is detected and handled safely.
- Prompt tuning improved reliability versus baseline.
- Reusable standards were documented for future flows.

## Lab Complete

You created a reliable **prompt-node** implementation pattern for Copilot Studio agent flows.

Suggested next labs:

- [Lab 22: Prompt Assistant](../22-prompt-assistant/index.md)
- [Lab 28: Agent Flows - M365 Copilot Nodes](../28-agent-flows-m365-copilot-nodes/index.md)
