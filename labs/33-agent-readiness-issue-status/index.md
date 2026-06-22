# Lab 33: Agent Readiness / Issue Status

*Build a readiness model that combines quality signals, open issues, and release gates for Copilot Studio agents.*

| | |
|---|---|
| ⭐ **DIFFICULTY** | Intermediate (200) |
| ⏱️ **TIME** | 60 minutes |
| 🧩 **PRODUCTS** | Microsoft Copilot Studio, Azure DevOps or GitHub |
| 🏷️ **TAGS** | Readiness, Release Gates, Issue Tracking |
| 🏭 **INDUSTRIES** | Cross-industry |

---

## Overview

Teams need a simple answer to: "Is this agent ready to ship?" In this lab, you will build an **agent readiness / issue status** model that blends evaluations, open defects, and governance checks into a clear release decision.

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

1. Create readiness categories: quality, reliability, governance, support.
2. Define measurable criteria for each category.
3. Assign category owners and approvers.
4. Define acceptable evidence for each criterion.
5. Document non-negotiable release blockers.

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

## Lab Complete

You established a clear **agent readiness / issue status** process for release decisions.

Suggested next labs:

- [Lab 19: Agent Evaluations (GA)](../19-agent-evaluations-ga/index.md)
- [Lab 32: Agent Inventory Schema](../32-agent-inventory-schema/index.md)
