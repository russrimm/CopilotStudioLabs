# Lab 38: Agent Inventory Schema

*Create a structured inventory schema to track agent capabilities, ownership, risk, and lifecycle status.*

| Field | Details |
|---|---|
| ⭐ **DIFFICULTY** | Intermediate (200) |
| ⏱️ **TIME** | 50 minutes |
| 🧩 **PRODUCTS** | Microsoft Copilot Studio, Dataverse or SharePoint |
| 🏷️ **TAGS** | Governance, Inventory, Schema, Operations |
| 🏭 **INDUSTRIES** | Cross-industry |

---

## Overview

As agent portfolios grow, teams need a consistent way to answer governance questions quickly. Power Platform automatically exposes a tenant-wide `microsoft.copilotstudio/agents` inventory (refreshed within ~15–20 minutes in the Power Platform admin center under **Manage** → **Tenant-wide inventory**, via the Power Platform API, and in Azure Resource Graph; see [View your agent inventory](https://learn.microsoft.com/microsoft-copilot-studio/admin-agent-inventory) and [Copilot Studio agent inventory schema](https://learn.microsoft.com/power-platform/admin/inventory-schema)):

- **Generally available system fields:** `id`, `displayName`, `environmentId`, `properties.harness` (`standard` or Microsoft Copilot harness), `createdBy` / `modifiedBy`, `usageType`, `lastActivityTime`, and Microsoft Entra identity links (`entraAgentId`, `entraAgentBlueprintId`, `entraAppId`).
- **Preview posture fields in `inventory-schema`:** `isQuarantined`, `orchestration`, `model`, `authentication`, `channels`, `powerPlatformConnectors`, and `IsWebSearchEnabledForKnowledge`.
- **Operational limits:** the Power Platform admin center UI displays up to **200** resources (use CSV export, the Power Platform API, or Azure Resource Graph for larger tenants), and legacy V1 classic bots are excluded.

In this lab, you design a complementary **governance inventory schema** in Dataverse or SharePoint that joins `microsoft.copilotstudio/agents` system metadata with business context—product and support owners, risk tier, exception expiry, and recertification dates—that automated discovery cannot infer on its own.

> **Facilitated workshop:** This lab is a governance design exercise, not a deployable template. A facilitator should provide the chosen Dataverse table or SharePoint list and guide participants to adapt the field definitions, approval states, and ownership model to their organization's policies.

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

1. Create required identity keys matching `microsoft.copilotstudio/agents`: `id` (bot GUID), `displayName`, `environmentId`, `properties.harness`, and `entraAgentId`.
2. Add business fields: purpose, target user group, and primary business scenario.
3. Add ownership fields beyond `createdBy`: product owner, technical owner, and support escalation owner.
4. Add lifecycle fields: draft, pilot, production, quarantined, or retired.
5. Add a review-date field for governance recertification.

### Step 2 - Add technical and dependency fields

1. Map automated posture fields where available (`orchestration`, `model`, `authentication`, `channels`, `powerPlatformConnectors`, `IsWebSearchEnabledForKnowledge`).
2. Add knowledge-source classification and external API / MCP server dependency fields.
3. Add data-sensitivity classification and authentication mode fields.
4. Add `lastActivityTime`, last-publish date, and solution version reference fields.
5. Add runbook and architecture documentation link fields.

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

## References

- [View your agent inventory](https://learn.microsoft.com/microsoft-copilot-studio/admin-agent-inventory)
- [Power Platform tenant-wide inventory](https://learn.microsoft.com/power-platform/admin/power-platform-inventory)
- [Copilot Studio agent inventory schema](https://learn.microsoft.com/power-platform/admin/inventory-schema)

## Lab Complete

You created a practical **agent inventory schema** for portfolio governance and lifecycle operations.

Suggested next labs:

- [Lab 39: Agent Readiness / Issue Status](../39-agent-readiness-issue-status/index.md)
- [Lab 40: Microsoft Entra Agent Identities](../40-entra-agent-identities-preview/index.md)
