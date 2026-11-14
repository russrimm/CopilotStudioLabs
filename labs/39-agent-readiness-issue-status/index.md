# Lab 39: Agent Readiness / Issue Status

*Build a readiness model that combines quality signals, open issues, and release gates for Copilot Studio agents.*

| Field | Details |
|---|---|
| ⭐ **DIFFICULTY** | Intermediate (200) |
| ⏱️ **TIME** | 60 minutes |
| 🧩 **PRODUCTS** | Microsoft Copilot Studio, Azure DevOps or GitHub |
| 🏷️ **TAGS** | Readiness, Release Gates, Issue Tracking |
| 🏭 **INDUSTRIES** | Cross-industry |

---

## Overview

Teams need a clear, repeatable answer to: *"Is this agent ready to ship?"* On the **standard harness**, Copilot Studio includes a built-in [Agent status (preview)](https://learn.microsoft.com/microsoft-copilot-studio/authoring-agent-status) check on the agent **Overview** page (**Copilot details** → **Agent status** → **Review**) that flags configuration and data-policy issues by severity (`Blocking`, `Warning`, `Info`) and affected state (`Draft`, `Published`, `Both`), highlights blocked items on the **Tools** and **Channels** tabs, and surfaces up to 400 characters of custom **Maker guidance** configured by administrators in the Power Platform admin center (**Copilot** → **Settings** → **Maker guidance**).

In this lab, you combine those in-product status signals with [automated agent evaluations](https://learn.microsoft.com/microsoft-copilot-studio/analytics-agent-evaluation-intro), open engineering defects in Azure DevOps or GitHub, and operational readiness checks into a single go/no-go release scorecard.

> **Facilitated workshop:** This lab is a governance design exercise, not a deployable scorecard or automation template. A facilitator should provide the issue-tracker view and scorecard workspace, then guide participants to define thresholds and release gates that match their organization's policies.

## Learning Objectives

1. Define readiness dimensions for agent release.
2. Link open issues to readiness status.
3. Build a traffic-light readiness scorecard.
4. Create release gate criteria for publish decisions.
5. Operationalize readiness review ceremonies.

## Prerequisites

- Access to Copilot Studio evaluation and analytics outputs.
- Access to issue tracking (Azure DevOps or GitHub).
- A release process requiring sign-off.
- Stakeholder agreement on release quality thresholds.

## Step-by-Step

### Step 1 - Define readiness dimensions

1. Create four readiness categories: **Quality** (evaluation pass rates), **Configuration & Policy** (Copilot Studio Agent status `Blocking` / `Warning` findings and DLP compliance), **Reliability**, and **Support**.
2. Define measurable criteria for each category (for example, zero `Blocking` findings in **Overview** → **Copilot details** → **Agent status** across `Draft` and `Published` states).
3. Assign category owners and release approvers.
4. Define acceptable evidence for each criterion (evaluation run ID, Agent status export/screenshot, DLP check, support runbook).
5. Document non-negotiable release blockers and configure optional tenant **Maker guidance** messaging if you administer the environment.

### Step 2 - Link issue status to readiness

1. Define severity levels for agent-related issues.
2. Map severity to readiness impact rules.
3. Link issue tracker queries to your readiness view.
4. Separate known accepted risks from active blockers.
5. Validate issue data freshness.

### Step 3 - Build readiness scorecard

1. Create a green/yellow/red scorecard template.
2. Add metric fields for each readiness category.
3. Add blocker count and aging fields.
4. Add owner, target date, and next action fields.
5. Populate scorecard for one pilot agent.

### Step 4 - Run a readiness review

1. Convene a release readiness review with owners.
2. Walk through scorecard evidence and open blockers.
3. Record go/no-go decision and rationale.
4. Assign closure actions for unresolved risks.
5. Set follow-up review date.

### Step 5 - Automate ongoing status checks

1. Create recurring readiness reports.
2. Add alerts for blocker-age and severity changes.
3. Add pre-publish gate checks to your process.
4. Document emergency rollback criteria.
5. Share scorecard view with stakeholders.

## Validation / Success Criteria

- Readiness dimensions and criteria are defined and approved.
- Issue status is linked to readiness outcomes.
- A traffic-light scorecard is populated for a real agent.
- Release gate decisions can be made with clear evidence.

## References

- [Agent status (preview) in Copilot Studio](https://learn.microsoft.com/microsoft-copilot-studio/authoring-agent-status)
- [Agent evaluation overview](https://learn.microsoft.com/microsoft-copilot-studio/analytics-agent-evaluation-intro)
- [Configure data policies for agents](https://learn.microsoft.com/microsoft-copilot-studio/admin-data-loss-prevention)

## Lab Complete

You established a clear **agent readiness / issue status** process for release decisions.

Suggested next labs:

- [Lab 08: Agent Evaluations (GA)](../08-agent-evaluations-ga/index.md)
- [Lab 38: Agent Inventory Schema](../38-agent-inventory-schema/index.md)
