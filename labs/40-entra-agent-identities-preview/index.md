# Lab 40: Entra Agent Identities (Preview)

*Configure preview Entra-based identity patterns for Copilot Studio agents with least-privilege principles.*

| | |
|---|---|
| ⭐ **DIFFICULTY** | Advanced (300) |
| ⏱️ **TIME** | 75 minutes |
| 🧩 **PRODUCTS** | Microsoft Copilot Studio, Microsoft Entra ID |
| 🏷️ **TAGS** | Entra ID, Identity, Preview, Governance |
| 🏭 **INDUSTRIES** | Cross-industry |

---

## Overview

Identity design is foundational to secure agent operations. In this lab, you will explore **Entra agent identities (preview)** and apply least-privilege controls for connected resources in Copilot Studio scenarios.

## Learning Objectives

1. Understand Entra identity patterns for agents in preview.
2. Configure identity assignments for target integrations.
3. Apply least-privilege access controls.
4. Validate identity-based access outcomes.
5. Document preview limitations and governance controls.

## Prerequisites

- Access to Copilot Studio and Microsoft Entra administration context.
- A preview-enabled environment for identity capabilities.
- A target agent with at least one protected integration.
- Alignment with identity and security stakeholders.

## Step-by-Step

### Step 1 - Define identity and access goals

1. Identify which resources the agent must access.
2. Map required permissions for each resource.
3. Define least-privilege principles for the pilot.
4. Document separation-of-duty requirements.
5. Confirm preview usage approval with security owners.

### Step 2 - Configure Entra identity assignments

1. Open identity configuration for your pilot setup.
2. Assign the intended Entra identity pattern.
3. Bind required roles and permissions only.
4. Remove broad or inherited permissions not required.
5. Save and capture identity configuration evidence.

### Step 3 - Validate access boundaries

1. Test allowed operations from the agent path.
2. Test denied operations to confirm enforcement.
3. Validate behavior when tokens or sessions expire.
4. Confirm error messaging is actionable and safe.
5. Record all pass/fail outcomes.

### Step 4 - Harden governance controls

1. Add periodic access review checkpoints.
2. Define identity rotation and break-glass procedures.
3. Add monitoring for anomalous access patterns.
4. Document incident response ownership.
5. Align controls with your security baseline.

### Step 5 - Publish preview readiness notes

1. Document preview-specific constraints.
2. Record unsupported production assumptions.
3. Define pilot-only rollout boundaries.
4. Capture go/no-go criteria for expansion.
5. Share findings with security and platform teams.

## Validation / Success Criteria

- Entra identity configuration is applied and tested.
- Least-privilege access boundaries are verified.
- Denied-access behavior is validated safely.
- Preview risks and operational controls are documented.

## Lab Complete

You completed a controlled **Entra agent identities (preview)** implementation pattern for Copilot Studio scenarios.

Suggested next labs:

- [Lab 21: Custom Connectors & OAuth for Copilot Studio](../21-custom-connectors-oauth/index.md)
- [Lab 38: Agent Inventory Schema](../38-agent-inventory-schema/index.md)
