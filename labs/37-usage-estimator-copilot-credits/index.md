# Lab 37: Usage Estimator & Copilot Credits

*Estimate workload cost and capacity using usage estimator patterns and Copilot Credits planning.*

| Field | Details |
|---|---|
| ⭐ **DIFFICULTY** | Intermediate (200) |
| ⏱️ **TIME** | 45 minutes |
| 🧩 **PRODUCTS** | Microsoft Copilot Studio |
| 🏷️ **TAGS** | Usage Estimator, Copilot Credits, Capacity Planning |
| 🏭 **INDUSTRIES** | Cross-industry |

---

## Overview

Operational readiness requires cost and capacity clarity. In this lab, you will use the [Microsoft agent usage estimator](https://learn.microsoft.com/microsoft-copilot-studio/agent-usage-estimator) and documented [Copilot Credits billing rates](https://learn.microsoft.com/microsoft-copilot-studio/requirements-messages-management) to model expected demand, distinguish Microsoft 365 Copilot USL-included employee usage from metered workloads, identify high-variance cost drivers, and define rollout guardrails.

| Capability / Event | Documented Copilot Credits Rate | Microsoft 365 Copilot USL Notes |
|---|---|---|
| **Classic answer** | `1` credit per authored non-generative response | Included (`0` credits) for authenticated USL users in M365 channels |
| **Generative answer** | `2` credits per generative answer over knowledge/instructions | Included (`0` credits) for authenticated USL users in M365 channels |
| **Agent action** | `5` credits per orchestrated topic, tool, connector, flow, or autonomous trigger | Interactive M365 turns included for USL users; autonomous triggers always metered |
| **Tenant graph grounding** | `10` credits per message grounded in Microsoft Graph tenant data | Included (`0` credits) for authenticated USL users in M365 channels |
| **Agent flows** | `13` credits per `100` executed flow actions (including trigger checks) | Always metered across all users and channels |
| **Text & generative AI tools** | `1` (basic) / `15` (standard) per `10` responses, or `10` per `1,000` tokens (premium/reasoning) | Always metered based on model tier |
| **Content processing** | `8` credits per processed page | Always metered |
| **Voice** | `10` (classic), `35` (generative), or `75` (real-time speech) credits per minute | Metered on voice channels |
| **Computer use (preview)** | `5` (basic) or `15` (standard) credits per step | Always metered |

> [!IMPORTANT]
> Estimator outputs are informational planning aids, not price quotes or guarantees. Microsoft Learn recommends adding a **10–20% variance buffer** and validating assumptions against actual telemetry in the Power Platform admin center (**Licensing** → **Copilot Studio**). Prepaid capacity packs enforce monthly throttling at **125%** of allocated capacity unless a pay-as-you-go billing plan is linked as overflow.

## Learning Objectives

1. Build a demand model for your Copilot Studio agent.
2. Estimate usage against Copilot Credits assumptions.
3. Identify high-variance usage drivers.
4. Define pilot and scale rollout thresholds.
5. Create a lightweight cost-governance cadence.

## Prerequisites

- Access to recent usage metrics or pilot demand assumptions.
- A target agent with known business scenarios.
- Stakeholder alignment on budget and adoption targets.
- A worksheet or dashboard for estimation tracking.

## Step-by-Step

### Step 1 - Build a usage baseline model

1. Estimate active users by role and day.
2. Estimate average conversations per user.
3. Estimate average turns per conversation.
4. Document seasonal spikes and campaign effects.
5. Record model assumptions with owner names.

### Step 2 - Estimate Copilot Credits consumption

1. Open the [Microsoft agent usage estimator](https://microsoft.github.io/copilot-studio-estimator/) alongside [Estimate Copilot Studio agent usage](https://learn.microsoft.com/microsoft-copilot-studio/agent-usage-estimator) and review its assumptions and disclaimer.
2. Separate authenticated **Microsoft 365 Copilot** licensed employee sessions on Microsoft 365 channels from unauthenticated, external-channel, autonomous-trigger, and agent-flow workloads.
3. Map each scenario's expected mix of classic answers (`1`), generative answers (`2`), agent actions (`5`), tenant graph grounding (`10`), agent flow actions (`13` per `100`), AI tool responses/tokens, and specialized voice or computer-use steps.
4. Calculate best-case, expected, and peak monthly scenarios, then add a **10–20% variance buffer** for multi-step orchestration retries and estimator uncertainty.
5. Document confidence levels for each assumption and decide whether to allocate prepaid **Copilot Credit capacity packs** (`25,000` credits/pack/month), **pay-as-you-go** overflow, or both.

### Step 3 - Identify optimization opportunities

1. Find high-turn scenarios likely to inflate cost.
2. Identify intents suitable for shorter guided paths.
3. Identify low-value interactions that can be deflected.
4. Prioritize improvements with highest cost impact.
5. Add owners and target completion dates.

### Step 4 - Define guardrails and thresholds

1. Set weekly budget warning thresholds.
2. Set action thresholds for rapid demand spikes.
3. Define who gets notified on threshold breaches.
4. Add a rollback or throttling plan for emergencies.
5. Publish the governance checklist.

### Step 5 - Create an ongoing review cadence

1. Schedule recurring estimator reviews.
2. Compare actuals to model assumptions.
3. Update the model based on observed usage.
4. Capture lessons learned after each review.
5. Share a concise monthly status update.

## Validation / Success Criteria

- A baseline usage and credits model exists.
- Peak and expected scenarios are quantified.
- The estimator disclaimer and a variance buffer are recorded with the forecast.
- Optimization and governance actions are assigned.
- A recurring review cadence is documented.

## References

- [Estimate Copilot Studio agent usage](https://learn.microsoft.com/microsoft-copilot-studio/agent-usage-estimator)
- [Copilot Studio licensing and Copilot Credits billing rates](https://learn.microsoft.com/microsoft-copilot-studio/requirements-messages-management)
- [Billing and Copilot Credit management](https://learn.microsoft.com/microsoft-copilot-studio/agents-experience/billing-credit-overview)

## Lab Complete

You established a practical planning model for **usage estimator and Copilot Credits** readiness.

Suggested next labs:

- [Lab 11: Custom Analytics Metrics](../11-custom-analytics-metrics/index.md)
- [Lab 39: Agent Readiness / Issue Status](../39-agent-readiness-issue-status/index.md)
