# Lab 40: Microsoft Entra Agent Identities

*Inspect, govern, and enforce least-privilege access for Copilot Studio agents using individual Microsoft Entra Agent IDs.*

| Field | Details |
|---|---|
| ⭐ **DIFFICULTY** | Advanced (300) |
| ⏱️ **TIME** | 75 minutes |
| 🧩 **PRODUCTS** | Microsoft Copilot Studio, Microsoft Entra ID, Microsoft Agent 365 |
| 🏷️ **TAGS** | Entra Agent ID, Identity, Conditional Access, Governance |
| 🏭 **INDUSTRIES** | Cross-industry |

---

## Overview

Identity isolation is foundational to secure enterprise agent operations. Since May 2026, Microsoft Copilot Studio automatically assigns each new agent its own **Microsoft Entra Agent ID** instead of sharing a single environment-wide application identity (see [Manage and govern agent identities](https://learn.microsoft.com/microsoft-copilot-studio/govern-agents-identities-overview) and [Use Microsoft Entra Agent ID with Copilot Studio agents](https://learn.microsoft.com/microsoft-copilot-studio/admin-use-entra-agent-identities)):

- **Provisioning by harness:** agents on the **standard harness** receive their Entra Agent ID at creation time; agents on the **Microsoft Copilot harness** receive their Entra Agent ID on first publish. Pre-rollout agents can be migrated using the Power Platform migration API ([Migrate existing agents to individual Entra agent identities](https://learn.microsoft.com/microsoft-copilot-studio/govern-migrate-api-entra-agent-identity)).
- **Secretless blueprint architecture:** every Copilot Studio agent identity is created under the tenant's **Copilot Studio Agent Identity Blueprint** (`25664c89-cea5-4ab6-b924-a54fd8a19ae0`) and authenticates with **Federated Identity Credentials**—eliminating client secrets to store or rotate.
- **Sponsor lifecycle:** the agent's creator and co-authors are recorded as **sponsors** on the Entra Agent ID (updating on ownership transfer, or falling back to tenant administrators if the original creator leaves the organization).
- **Visibility vs. Conditional Access scope:** publishing an agent attaches API permissions for its configured connectors to its Entra Agent ID for sign-in and audit visibility across all channels, while runtime **Conditional Access** policy enforcement for agent identities currently applies to the **Microsoft Teams** channel (with **Microsoft Agent 365** licensing required for Entra security capabilities).

## Learning Objectives

1. Locate and inspect an agent's individual Microsoft Entra Agent ID in Copilot Studio and the Microsoft Entra admin center.
2. Verify blueprint lineage, Federated Identity Credentials, sponsor assignments, and attached connector API permissions.
3. Apply least-privilege RBAC and Conditional Access controls for target integrations.
4. Validate allowed and denied access paths, sign-in logs, and channel enforcement boundaries.
5. Plan migration for legacy shared-identity agents and monitor Microsoft Entra directory object quotas.

## Prerequisites

- Access to Copilot Studio and the **Microsoft Entra admin center** (**Agent ID Administrator**, **Application Administrator**, or **Cloud Application Administrator** role for Entra inspection/governance).
- **Microsoft Agent 365** licensing when testing Microsoft Entra Conditional Access and identity protection features for agents.
- A non-production Copilot Studio agent with at least one connector integration and the **Microsoft Teams** channel enabled.
- Alignment with identity and security stakeholders on directory quota and Conditional Access testing.

## Step-by-Step

### Step 1 - Locate the agent's Microsoft Entra Agent ID and sponsor metadata

1. Open your target agent in Copilot Studio (if testing a Microsoft Copilot harness agent, publish it once so its identity is provisioned).
2. Navigate to **Settings** → **Advanced** → **Metadata** and copy the **Entra Agent ID** GUID.
3. Select the **Entra Agent ID** link (or open the **Microsoft Entra admin center** → **Entra ID** → **Agent ID** → **All agent identities**) to inspect the identity record.
4. Confirm the identity derives from the **Copilot Studio Agent Identity Blueprint** (`25664c89-cea5-4ab6-b924-a54fd8a19ae0`) using Federated Identity Credentials with zero client secrets.
5. Verify the **Sponsors** tab lists the expected maker/co-authors and review how sponsor fallback behaves when an owner leaves the organization.

### Step 2 - Scope connector permissions and least-privilege access

1. Publish the agent after adding your target connector tool so Copilot Studio registers the connector's API permissions on the agent's Entra Agent ID.
2. In the Microsoft Entra admin center, inspect the agent identity's assigned API permissions, Azure RBAC roles, or security group memberships.
3. Scope downstream resource access to only the specific SharePoint site, API scope, or Azure resource group required by this agent—never grant tenant-wide write permissions to an individual agent identity.
4. Document separation-of-duty rules between agent makers and Entra identity administrators who approve privileged scopes.
5. Capture screenshots or exported JSON of the identity's role and permission bindings.

### Step 3 - Validate access boundaries and Conditional Access behavior

1. Invoke an allowed connector operation through **Microsoft Teams** and confirm the request succeeds and logs against the agent's unique `entraAgentId` in Microsoft Entra sign-in and audit logs.
2. Attempt an out-of-scope resource call to verify least-privilege denial.
3. If your tenant has **Microsoft Agent 365** licensing, test a scoped **Conditional Access** policy targeting the agent identity on the **Microsoft Teams** channel and confirm block/grant enforcement behaves as expected.
4. Verify non-Teams channels you publish to: sign-in visibility still flows to Entra, while runtime Conditional Access enforcement currently applies only to Microsoft Teams—pair non-Teams channels with [Data policies](../35-dlp-governance-policies/index.md) and [end-user sign-in](../34-authentication-end-user-signin/index.md).
5. Confirm error messaging surfaced to users on denied access is safe and actionable.

### Step 4 - Harden lifecycle, migration, and quota governance

1. Query `microsoft.copilotstudio/agents` in tenant inventory (see [Lab 38](../38-agent-inventory-schema/index.md)) to identify pre-May 2026 agents without an individual `entraAgentId` and schedule migration via the [Power Platform migration API](https://learn.microsoft.com/microsoft-copilot-studio/govern-migrate-api-entra-agent-identity).
2. Monitor **Microsoft Entra directory object quotas**—every provisioned agent consumes directory objects, so pair identity governance with stale-agent retirement policies.
3. Establish periodic Microsoft Entra access reviews for agent identities and sponsor assignments.
4. Define emergency containment runbooks (disabling or blocking a compromised agent identity in Entra alongside quarantining the agent in Power Platform).
5. Route Entra agent sign-in logs to Microsoft Sentinel or your SIEM for anomalous activity detection.

### Step 5 - Publish identity governance standards

1. Document current channel enforcement boundaries (Conditional Access runtime enforcement on Microsoft Teams versus Entra visibility across all channels).
2. Record required licensing (**Microsoft Agent 365** for Entra security policies) and admin role responsibilities.
3. Publish a maker-to-security approval checklist for agents requesting high-privilege API scopes or Azure RBAC roles.
4. Define go/no-go identity criteria for promoting an agent from pilot to production.
5. Share the governance standard with platform, identity, and SOC teams.

## Validation / Success Criteria

- The agent's individual `Entra Agent ID`, blueprint lineage, Federated Identity Credentials, and sponsors are verified in Copilot Studio and Microsoft Entra admin center.
- Least-privilege resource bindings are applied without client secrets.
- Allowed and denied operations are validated and correlated in Microsoft Entra sign-in logs.
- Channel Conditional Access scope, legacy agent migration plan, and directory object quota controls are documented.

## References

- [Manage and govern agent identities](https://learn.microsoft.com/microsoft-copilot-studio/govern-agents-identities-overview)
- [Use Microsoft Entra Agent ID with Copilot Studio agents](https://learn.microsoft.com/microsoft-copilot-studio/admin-use-entra-agent-identities)
- [Migrate existing agents to individual Entra agent identities](https://learn.microsoft.com/microsoft-copilot-studio/govern-migrate-api-entra-agent-identity)
- [Microsoft Entra Agent ID for AI agents](https://learn.microsoft.com/entra/agent-id/identity-professional/microsoft-entra-agent-identities-for-ai-agents)

## Lab Complete

You inspected and governed individual **Microsoft Entra Agent Identities** for Copilot Studio agents with secretless authentication and least-privilege controls.

Suggested next labs:

- [Lab 21: Custom Connectors & OAuth for Copilot Studio](../21-custom-connectors-oauth/index.md)
- [Lab 38: Agent Inventory Schema](../38-agent-inventory-schema/index.md)
