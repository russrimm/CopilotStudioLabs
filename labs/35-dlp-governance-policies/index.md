# Lab 35: Data Loss Prevention (DLP) & Governance Policies

*Apply tenant-level governance so agents and makers can only use approved connectors and data flows.*

| Field | Details |
|---|---|
| ⭐ **DIFFICULTY** | Advanced (300) |
| ⏱️ **TIME** | 60 minutes |
| 🧩 **PRODUCTS** | Microsoft Copilot Studio, Power Platform admin center |
| 🏷️ **TAGS** | Governance, DLP, Data Loss Prevention, Connectors, Compliance |
| 🏭 **INDUSTRIES** | Cross-industry |

---

## Overview

As agent building scales across an organization, **governance** keeps it safe. **Data policies** (Data Loss Prevention / DLP) in the Power Platform admin center control which connectors, channels, HTTP endpoints, knowledge endpoints, and triggers makers and agents may use or combine—preventing sensitive data from flowing to unapproved destinations. Since early 2025, data policy enforcement is mandatory across all Copilot Studio tenants and agent-level exemptions are no longer supported (see [Configure data policies for agents](https://learn.microsoft.com/microsoft-copilot-studio/admin-data-loss-prevention)). In this lab you create a data policy, classify connectors and Copilot Studio governance virtual connectors, scope the policy to an environment, and verify real-time enforcement in Copilot Studio.

## 🎯 Learning Objectives

1. Navigate **DLP policies** in the Power Platform admin center (PPAC).
2. Classify connectors into **Business**, **Non-business**, and **Blocked** groups.
3. Scope a policy to specific **environments**.
4. Understand how DLP affects **agent tools and flows** at design and run time.
5. Document a governance baseline and exception process.

## Prerequisites

- **Power Platform administrator** (or equivalent) access to PPAC.
- A non-production environment to test policy effects safely.
- A list of approved vs. restricted connectors for your organization.

## Step-by-Step

### Step 1 — Open data policies in PPAC

1. Sign in to the [Power Platform admin center](https://admin.powerplatform.microsoft.com/), select **Security** → **Data and privacy** on the sidebar, and open **Data policies** on the **Data protection and privacy** page (or **Policies** → **Data policies** in classic navigation).
2. Review any existing policies, their default connector group, and their environment scopes.
3. Select **New Policy** and give the policy a clear name.

> Screenshot intentionally omitted until a current, sanitized capture is available. Follow the numbered PPAC navigation in your tenant.

### Step 2 — Classify connectors and Copilot Studio controls

1. Place approved enterprise connectors in the **Business** group and general non-sensitive connectors in **Non-business** (data cannot be shared across different groups in the same agent or flow).
2. Move restricted connectors into the **Blocked** group—including Copilot Studio governance connectors when policy requires it:
   - **Chat without Microsoft Entra ID authentication in Copilot Studio** (prevents publishing agents set to `No authentication`).
   - Channel connectors such as **Direct Line channels in Copilot Studio**, **Microsoft Teams + Microsoft 365 Channel in Copilot Studio**, **SharePoint channel in Copilot Studio**, **Omnichannel in Copilot Studio**, **WhatsApp channel in Copilot Studio**, or **Facebook channel in Copilot Studio**.
   - **HTTP** (or select **⋮** → **Configure connector** → **Connector endpoints** to allow/deny specific HTTP, SharePoint, or public website endpoints), **Microsoft Copilot Studio** (governs event triggers and authenticated automated evaluations), and **Skills with Copilot Studio**.
3. Note that blocking Power Platform connectors also blocks connected **MCP servers** that rely on those connectors for connectivity.

> Screenshot intentionally omitted until a current, sanitized capture is available. Verify the connector groups directly in the policy editor.

### Step 3 — Scope the policy

1. Choose whether the policy applies to **all environments**, **specific environments**, or **all except**.
2. Scope this test policy to your **non-production** environment.
3. Save and publish the policy.

> Screenshot intentionally omitted until a current, sanitized capture is available. Verify the saved environment scope directly in PPAC.

### Step 4 — Observe real-time enforcement on agents

1. In the scoped environment, open an agent in Copilot Studio and attempt to add or publish with a **Blocked** capability (for example a blocked connector tool, `No authentication`, or a denied HTTP endpoint).
2. Confirm disabled capabilities show a policy restriction tooltip during authoring, and existing violations disable **Publish** and display an error banner (expand **Details** → **Download** on the **Channels** page to inspect violation rows).
3. Confirm an approved **Business** connector continues to work normally.
4. *(Optional)* Note that tenant admins can attach a custom support email and governance URL to policy error banners with `New-PowerAppDlpErrorSettings` / `Set-PowerAppDlpErrorSettings`.

### Step 5 — Document governance baseline

1. Record the connector classification rationale.
2. Define an **exception request** process for new connectors.
3. Set a review cadence for the policy.

## Documentation

- [Security and governance in Copilot Studio](https://learn.microsoft.com/microsoft-copilot-studio/security-and-governance)
- [Configure data policies for agents](https://learn.microsoft.com/microsoft-copilot-studio/admin-data-loss-prevention)
- [Troubleshoot data policy enforcement for Copilot Studio](https://learn.microsoft.com/microsoft-copilot-studio/admin-dlp-troubleshooting)
- [Connector endpoint filtering](https://learn.microsoft.com/power-platform/admin/connector-endpoint-filtering)

## ✅ Validation / Success Criteria

- A DLP policy exists with connectors classified into the three groups.
- The policy is scoped to the intended environment(s).
- A blocked connector is demonstrably prevented in an agent.
- You documented a governance baseline and exception process.

## ✅ Lab Complete

You established **tenant-level governance** with DLP policies, ensuring agents across your organization use only approved connectors and data flows — a cornerstone of safe, scalable agent adoption.

**Suggested next labs:**

- [Lab 38: Agent Inventory Schema](../38-agent-inventory-schema/index.md) — track ownership and risk across all agents.
- [Lab 39: Agent Readiness / Issue Status](../39-agent-readiness-issue-status/index.md) — gate releases on readiness criteria.

> 🔗 **Related lab:** [Lab 34: Authentication & End-User Sign-In Configuration](../34-authentication-end-user-signin/index.md) — pair connector governance with user authentication.

---

*Screenshots in this lab are placeholders. Capture live images with the [screenshot tool](../../tools/screenshot-capture/) (`shots.json` is wired for this lab).*
