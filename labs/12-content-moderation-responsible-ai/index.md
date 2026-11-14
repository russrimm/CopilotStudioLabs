# Lab 12: Content Moderation, Guardrails & Responsible AI

*Configure moderation, grounding, and safety boundaries so your agent answers responsibly and predictably.*

| Field | Details |
|---|---|
| ⭐ **DIFFICULTY** | Intermediate (200) |
| ⏱️ **TIME** | 45 minutes |
| 🧩 **PRODUCTS** | Microsoft Copilot Studio |
| 🏷️ **TAGS** | Responsible AI, Content Moderation, Guardrails, Grounding, Safety |
| 🏭 **INDUSTRIES** | Cross-industry |

---

## Overview

A capable agent must also be a **safe** agent. In this lab you configure Copilot Studio's **content moderation** controls, tighten **grounding** so the agent stays on approved knowledge, and define explicit **safety boundaries** in the agent's instructions. You then validate that the guardrails actually hold by testing out-of-scope and adversarial prompts.

## 🎯 Learning Objectives

1. Locate and adjust **content moderation** levels in Generative AI settings.
2. Constrain answers to approved knowledge with **grounding** controls.
3. Author explicit **safety and scope boundaries** in agent instructions.
4. Test refusal behavior with out-of-scope and adversarial prompts.
5. Document a lightweight **Responsible AI** review checklist for the agent.

## Prerequisites

- A Copilot Studio agent on the [standard harness](https://learn.microsoft.com/microsoft-copilot-studio/harnesses-overview#standard-harness) with at least one knowledge source.
- Permission to edit **Settings → Generative AI**, topic generative answers nodes, and prompt tools. See [Knowledge source agent settings — Moderation](https://learn.microsoft.com/microsoft-copilot-studio/knowledge-copilot-studio#moderation) and [FAQ for generative answers](https://learn.microsoft.com/microsoft-copilot-studio/faqs-generative-answers).
- A short list of in-scope and out-of-scope example questions.

## Step-by-Step

### Step 1 — Review Generative AI settings

1. Open your agent and go to **Settings → Generative AI**.
2. Review the available **content moderation** controls (ranging from **Lowest** to **Highest**, with **High** as the default) and knowledge grounding toggles (**Use information from the web** and **Allow ungrounded responses**).
3. Note how precedence works at runtime: a [topic-level generative answers node moderation setting](https://learn.microsoft.com/microsoft-copilot-studio/nlu-boost-node#content-moderation) overrides the agent-level **Generative AI** setting, and [prompt tools have their own moderation level](https://learn.microsoft.com/microsoft-copilot-studio/prompt-model-settings#content-moderation-level) under **… → Settings** in Prompt builder.

![Settings → Generative AI with moderation controls](assets/generative-ai-settings.png)

### Step 2 — Set the content moderation level

1. Adjust the agent-level **content moderation** level between **Lowest** and **Highest** (keep **High** or **Highest** for stricter enterprise scenarios) and remember that Copilot Studio checks both user input and generated output for harmful content, jailbreaks, and prompt injection.
2. Understand the tradeoff: **Highest** applies the strictest filter against harmful content and generates fewer answers, while lower levels generate more answers at greater risk.
3. Select **Save**.

![Content moderation level selector](assets/content-moderation-level.png)

### Step 3 — Constrain grounding

1. Turn off **Allow ungrounded responses** in the **Knowledge** section of **Settings → Generative AI** if your scenario requires every answer turn to use a configured knowledge source or tool and include an in-text citation (note that follow-up turns relying only on prior chat history without calling a knowledge source or tool will route to Fallback when this is off).
2. Turn off **Use information from the web** (**Web Search** on **Overview**) when answers must stay strictly within approved enterprise sources.
3. Confirm citations are returned for grounded responses.

### Step 4 — Author safety boundaries

1. In the agent **Instructions**, add explicit scope and refusal rules (what the agent must not do).
2. Specify escalation language for requests outside its domain.
3. Save and publish the updated instructions.

### Step 5 — Test the guardrails

1. In the **Test** pane, submit an in-scope question and confirm a grounded, cited answer.
2. Submit an out-of-scope or adversarial prompt and confirm a safe refusal.
3. Capture the refusal transcript for your review record.

![Test canvas showing a guardrail-enforced refusal](assets/test-guardrail-response.png)

## ✅ Validation / Success Criteria

- Content moderation is set intentionally and saved.
- The agent answers in-scope questions with citations from approved knowledge.
- The agent safely refuses or redirects at least two out-of-scope prompts.
- You documented a short Responsible AI review checklist.

## Documentation

- [Copilot Studio system and service card — Safety components and mitigations](https://learn.microsoft.com/microsoft-copilot-studio/system-service-card-copilot-studio#safety-components-and-mitigations)
- [Troubleshoot Responsible AI filter errors in Copilot Studio](https://learn.microsoft.com/troubleshoot/power-platform/copilot-studio/generative-answers/agent-response-filtered-by-responsible-ai)

## ✅ Lab Complete

Your agent now behaves **responsibly and predictably**, staying within its approved knowledge and safely declining out-of-scope requests. These guardrails are prerequisites for any production rollout.

**Suggested next labs:**

- [Lab 08: Agent Evaluations (GA)](../08-agent-evaluations-ga/index.md) — measure quality and catch regressions.
- [Lab 35: Data Loss Prevention (DLP) & Governance Policies](../35-dlp-governance-policies/index.md) — extend safety to tenant-level governance.

> 🔗 **Related lab:** [Lab 07: Monitor Performance and Evaluate Contoso Agent Quality](../07-agent-analytics-evaluations/index.md) — verify guardrails hold over time with evaluations.

---

*Screenshots in this lab are placeholders. Capture live images with the [screenshot tool](../../tools/screenshot-capture/) (`shots.json` is wired for this lab).*
