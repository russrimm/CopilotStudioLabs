# Lab 23: Work IQ MCP (Preview)

*Connect Work IQ context through MCP in a preview workflow to enrich Copilot Studio agent grounding.*

| | |
|---|---|
| ⭐ **DIFFICULTY** | Advanced (300) |
| ⏱️ **TIME** | 75 minutes |
| 🧩 **PRODUCTS** | Microsoft Copilot Studio, MCP-capable tools |
| 🏷️ **TAGS** | Work IQ, MCP, Contextual Grounding |
| 🏭 **INDUSTRIES** | Cross-industry |

---

## Overview

This lab explores **Work IQ MCP (preview)** patterns for contextual grounding in Copilot Studio. You will connect MCP-backed context, map it to business workflows, and validate that responses improve without introducing unnecessary complexity.

## Learning Objectives

1. Understand Work IQ MCP (preview) architecture in Copilot Studio scenarios.
2. Configure MCP-backed context access for an agent workflow.
3. Design prompts that use context selectively and safely.
4. Validate response quality and traceability with context enabled.
5. Document preview risks and mitigation steps.

## Prerequisites

- Access to Copilot Studio and a preview-enabled environment.
- Access to relevant MCP-capable context sources.
- A target use case where broader work context improves outcomes.
- Stakeholder alignment on preview feature usage.

## Step-by-Step

### Step 1 - Define the preview pilot scope

1. Identify one workflow where Work IQ context could help significantly.
2. Define what context is in-scope and out-of-scope.
3. Document expected user and business outcomes.
4. Capture preview caveats and rollback criteria.
5. Align scope with your platform governance owner.

### Step 2 - Configure MCP context integration

1. Open your Copilot Studio agent configuration.
2. Add the MCP context source for the pilot workflow.
3. Validate connection status and permissions.
4. Restrict access to only necessary context surfaces.
5. Save and document configuration settings.

### Step 3 - Design context-aware prompt behavior

1. Update instructions to prefer MCP context when relevant.
2. Add a fallback when context is missing or stale.
3. Require concise attribution language where appropriate.
4. Avoid over-fetching unrelated context data.
5. Save prompt updates and prepare a test set.

### Step 4 - Test with and without Work IQ context

1. Run a baseline set of prompts with context disabled.
2. Run the same prompts with Work IQ MCP context enabled.
3. Compare answer quality, relevance, and actionability.
4. Note any latency or inconsistency tradeoffs.
5. Capture examples where context materially improved outcomes.

### Step 5 - Publish preview readiness notes

1. Document known limitations and support boundaries.
2. Define monitoring signals for pilot health.
3. Create a support playbook for common failure modes.
4. Record decision criteria for expanding the pilot.
5. Share readiness notes with stakeholders.

## Validation / Success Criteria

- MCP context integration is configured and tested.
- You can show before/after quality differences for pilot prompts.
- Preview limitations and mitigations are documented.
- A controlled rollout plan exists for the pilot scenario.

## Lab Complete

You implemented and validated a **Work IQ MCP (preview)** pilot pattern for Copilot Studio.

> 🔗 **Related scenario lab:** [Lab 08: Supercharge Agents with Work IQ and Microsoft 365 Intelligence](../08-work-iq-m365-intelligence/index.md) — the end-to-end Work IQ + Microsoft 365 grounding scenario this preview feature fits into.

Suggested next labs:

- [Lab 08: Supercharge Agents with Work IQ and Microsoft 365 Intelligence](../08-work-iq-m365-intelligence/index.md)
- [Lab 31: Custom Analytics Metrics](../31-custom-analytics-metrics/index.md)
