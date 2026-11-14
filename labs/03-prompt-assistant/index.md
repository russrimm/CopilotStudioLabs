# Lab 03: Prompt Assistant

*Use Prompt Assistant to draft, refine, and test higher-quality instructions and prompts in Copilot Studio.*

| Field | Details |
|---|---|
| ⭐ **DIFFICULTY** | Beginner to Intermediate (100-200) |
| ⏱️ **TIME** | 45 minutes |
| 🧩 **PRODUCTS** | Microsoft Copilot Studio |
| 🏷️ **TAGS** | Prompt Assistant, Prompt Engineering, Instructions |
| 🏭 **INDUSTRIES** | Cross-industry |

---

## Overview

Prompt quality strongly influences reliability, tone, and task completion. In this lab, you will use **Prompt Assistant** in Copilot Studio to generate better drafts, tighten intent boundaries, and test revisions with repeatable prompts.

## Learning Objectives

1. Use Prompt Assistant to generate draft prompts.
2. Refine prompts for clarity, constraints, and output quality.
3. Add domain context and guardrails.
4. Test prompt variants against realistic scenarios.
5. Standardize a prompt review checklist for your team.

## Prerequisites

- Access to Copilot Studio on the [standard harness](https://learn.microsoft.com/microsoft-copilot-studio/harnesses-overview#standard-harness) (or Power Apps / Power Automate **AI hub**) with [Prompt assistant](https://learn.microsoft.com/microsoft-copilot-studio/prompt-assistant) and [Prompt builder](https://learn.microsoft.com/microsoft-copilot-studio/nlu-prompt-node) available.
- Dataverse provisioned in the environment and Copilot Credits available for prompt testing.
- A known scenario where response quality needs improvement.
- Example user prompts and desired outcomes.
- Permission to modify prompts, instructions, and topics.

> 💡 **Known Prompt assistant boundaries:** **Prompt assistant** generates a new prompt draft from a concise natural-language description (4 to 500 characters). It can't edit an existing prompt in place and can't generate grounded prompts directly — after you select **Keep it**, you add input variables, knowledge data, and output formatting in Prompt builder.

## Step-by-Step

### Step 1 - Capture baseline behavior

1. Open your target agent or existing prompt tool in Copilot Studio.
2. Run five representative prompts and save outputs.
3. Note issues such as vague responses or missing actions.
4. Label each issue by type (clarity, grounding, tone, structure).
5. Save baseline results for later comparison.

### Step 2 - Generate improved drafts with Prompt Assistant

1. Open **Tools** → **New tool** → **Prompt** (or **AI hub** → **Prompts** → **Build your own prompt**) and select **Prompt assistant**.
2. Enter a 4–500 character description covering the business goal, user persona, constraints, and desired output structure, then select **Submit**.
3. Review the generated prompt draft and regenerate or refine your description across two to three candidate drafts.
4. Select **Keep it** on the strongest draft to load it into Prompt builder, then add any dynamic inputs, knowledge references, and **Output** format (**Text**, **JSON**, or **Document**).
5. Test the draft in Prompt builder's **Test** panel and save it as your working version.

### Step 3 - Add practical guardrails

1. Add scope boundaries for what the agent should not do.
2. Add required output elements (for example, summary plus next action).
3. Add style guidance for concise, professional tone.
4. Add escalation behavior for unknown or risky requests.
5. Save the revised prompt to your agent instructions.

### Step 4 - Compare prompt variants

1. Re-run your original five prompts.
2. Compare outputs against baseline responses.
3. Score each variant for quality and consistency.
4. Identify tradeoffs such as precision versus verbosity.
5. Select the variant that best meets business goals.

### Step 5 - Publish a prompt review standard

1. Create a short prompt review checklist.
2. Include required items: scope, constraints, fallback, tone.
3. Define who approves prompt changes.
4. Add a lightweight regression check step.
5. Share the standard with your maker team.

## Validation / Success Criteria

- Prompt Assistant produced at least one improved prompt draft.
- Revised prompts show measurable quality gains in test outputs.
- Scope and escalation guardrails are explicitly documented.
- A reusable prompt review checklist is available to the team.

## Lab Complete

You used Prompt Assistant to create clearer, more reliable instruction patterns for Copilot Studio agents.

> 🔗 **Related scenario lab:** [Lab 13: Master Prompt Engineering with Prompt Builder and Agent Flow Nodes](../13-prompt-builder-agent-flows/index.md) — the end-to-end prompt-and-flows scenario. See also [Lab 14: Agent Flows - Prompt Nodes](../14-agent-flows-prompt-nodes/index.md) for the prompt-node deep-dive.

Suggested next labs:

- [Lab 13: Master Prompt Engineering with Prompt Builder and Agent Flow Nodes](../13-prompt-builder-agent-flows/index.md)
- [Lab 14: Agent Flows - Prompt Nodes](../14-agent-flows-prompt-nodes/index.md)
