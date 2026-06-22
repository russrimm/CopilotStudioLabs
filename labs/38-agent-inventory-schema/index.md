# Lab 38: Agent Inventory Schema

*Create a structured inventory schema to track agent capabilities, ownership, risk, and lifecycle status.*

| | |
|---|---|
| ⭐ **DIFFICULTY** | Intermediate (200) |
| ⏱️ **TIME** | 50 minutes |
| 🧩 **PRODUCTS** | Microsoft Copilot Studio, Dataverse or SharePoint |
| 🏷️ **TAGS** | Governance, Inventory, Schema, Operations |
| 🏭 **INDUSTRIES** | Cross-industry |

---

## Overview

As agent portfolios grow, teams need a consistent way to answer basic governance questions quickly. In this lab, you will build an **agent inventory schema** that captures ownership, purpose, integrations, release state, and operational risk.

## Learning Objectives

1. Define a minimum viable inventory schema for agents.
2. Capture ownership and lifecycle metadata consistently.
3. Record integration and dependency details.
4. Add governance fields for risk and review status.
5. Prepare the schema for ongoing portfolio operations.

## Prerequisites

- Access to your current list of Copilot Studio agents.
- A storage destination (Dataverse table or SharePoint list).
- Agreement on who owns governance data upkeep.
- Basic understanding of your release and support process.

## Step-by-Step

### Step 1 - Define core schema fields

1. Create required identity fields: name, ID, environment.
2. Add business fields: purpose, user group, primary scenario.
3. Add ownership fields: product owner, technical owner, support owner.
4. Add lifecycle fields: draft, pilot, production, retired.
5. Add review-date field for governance recertification.

### Step 2 - Add technical and dependency fields

1. Add connected tools and knowledge-source fields.
2. Add external dependency and integration fields.
3. Add authentication and data-sensitivity fields.
4. Add last-publish date and version reference fields.
5. Add runbook or documentation link fields.

### Step 3 - Capture risk and compliance metadata

1. Add risk tier field with clear tier definitions.
2. Add approval status and approver fields.
3. Add incident escalation contact field.
4. Add policy exceptions field with expiry date.
5. Add audit evidence link field.

### Step 4 - Populate and validate sample inventory

1. Populate at least ten existing agents into the schema.
2. Check for missing required fields.
3. Validate owner fields with real teams.
4. Correct inconsistent lifecycle statuses.
5. Confirm schema supports filtering and reporting.

### Step 5 - Operationalize inventory maintenance

1. Define who updates records on each publish.
2. Add a monthly recertification review process.
3. Define stale-record detection rules.
4. Add reporting views for leadership and operations.
5. Publish maintenance guidance and owners.

## Validation / Success Criteria

- Inventory schema includes ownership, lifecycle, and risk metadata.
- Sample agent records are populated and validated.
- Governance and recertification workflow is documented.
- Inventory supports operational filtering and reporting.

## Lab Complete

You created a practical **agent inventory schema** for portfolio governance and lifecycle operations.

Suggested next labs:

- [Lab 39: Agent Readiness / Issue Status](../39-agent-readiness-issue-status/index.md)
- [Lab 40: Entra Agent Identities (Preview)](../40-entra-agent-identities-preview/index.md)
