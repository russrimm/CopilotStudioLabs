# Lab 14: Agent Flows - Prompt Nodes

*Use prompt nodes to generate structured, context-aware outputs inside Copilot Studio agent flows.*

| Field | Details |
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

- Access to Copilot Studio agent flow authoring on the [standard harness](https://learn.microsoft.com/microsoft-copilot-studio/harnesses-overview#standard-harness) with Dataverse and Copilot Credits available. See [Add a prompt node to an agent flow](https://learn.microsoft.com/microsoft-copilot-studio/prompt-node-workflow) and [Use prompts to make your agent or agent flow perform specific tasks](https://learn.microsoft.com/microsoft-copilot-studio/nlu-prompt-node).
- A scenario requiring classification, summarization, translation, or structured extraction without external tool orchestration (prompt nodes support Code interpreter and Dataverse knowledge only).
- A sample set of varied user inputs.
- Permission to edit prompts and flow branches.

> ℹ️ **Harness note:** The **Run a prompt** node is available in agent flows on the **standard harness**. In workflows powered by the **Microsoft Copilot harness**, add an **Agent** node with your instructions and leave agent tools unconfigured to achieve equivalent single-prompt behavior.

## Step-by-Step

### Step 1 - Select the prompt-node use case

1. Choose one single-turn transformation task suited to prompting (such as field extraction, classification, translation, or summarization).
2. Define required output fields for downstream logic and choose the matching **Output** shape (**Text**, **JSON**, or **Document**).
3. Document examples of correct and incorrect outputs.
4. Identify guardrails needed for safe output.
5. Set a target response quality threshold.

### Step 2 - Build and configure the prompt node

1. In Copilot Studio, go to **Flows**, open or create your agent flow on the **Build** tab, select **Add a new action**, and under **AI capabilities** select **Run a prompt**.
2. Write focused instructions in the **Instructions** box, choose an appropriate model from the upper-right model dropdown, and set **Output** to **JSON** (for structured fields), **Text**, or **Document**.
3. Insert upstream tokens into **Instructions** using `/` → **Insert dynamic content** (remembering that prompt nodes only see what is passed in **Instructions** plus any configured Dataverse reference).
4. Add fallback instructions (such as returning `"Not provided"` for missing fields) to handle ambiguous input deterministically.
5. Select **Save** and test with baseline examples.

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

- [Lab 03: Prompt Assistant](../03-prompt-assistant/index.md)
- [Lab 16: Agent Flows - Microsoft 365 Copilot Nodes](../16-agent-flows-m365-copilot-nodes/index.md)
