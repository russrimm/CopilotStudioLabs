# Lab 27: Work IQ MCP (Preview)

*Connect Work IQ context through MCP in a preview workflow to enrich Copilot Studio agent grounding.*

| Field | Details |
|---|---|
| ⭐ **DIFFICULTY** | Advanced (300) |
| ⏱️ **TIME** | 75 minutes |
| 🧩 **PRODUCTS** | Microsoft Copilot Studio, MCP-capable tools |
| 🏷️ **TAGS** | Work IQ, MCP, Contextual Grounding |
| 🏭 **INDUSTRIES** | Cross-industry |

---

## Overview

This lab explores connecting agents and MCP clients to the [Work IQ MCP server](https://learn.microsoft.com/microsoft-365/copilot/extensibility/work-iq/mcp/overview) for contextual grounding over Microsoft 365 and enterprise business data.

> 💡 **Availability & architecture distinction:** Built-in Work IQ tools inside Copilot Studio are generally available on the **Microsoft Copilot harness** for Microsoft 365 workloads (covered in [Lab 05](../05-work-iq-m365-intelligence/index.md), with connected Dynamics 365 and Power Apps business app workloads in preview; see [Add Work IQ to custom agents](https://learn.microsoft.com/microsoft-copilot-studio/agents-experience/add-work-iq)). Separately, the **Work IQ MCP server** exposes Microsoft 365 and workplace context over the Model Context Protocol (MCP) using three tool groups documented in the [Work IQ MCP tool reference](https://learn.microsoft.com/microsoft-365/copilot/extensibility/work-iq/mcp/tool-reference): **Entity tools** (`fetch`, `fetch_blob`, `create_entity`, `update_entity`, `delete_entity`, `do_action`, `call_function` over relative resource paths such as `/me/messages`), **Copilot tools** (`ask`, `list_agents`, and `retrieve`, which is in **public preview**), and **Schema tools** (`get_schema`, `search_paths`).

## Learning Objectives

1. Distinguish built-in Work IQ tools on the Microsoft Copilot harness from direct [Work IQ MCP server](https://learn.microsoft.com/microsoft-365/copilot/extensibility/work-iq/mcp/overview) integration.
2. Verify tenant enablement, Microsoft Entra ID OAuth 2.0 discovery, and MCP server governance in the Microsoft 365 admin center.
3. Map Entity, Copilot (`ask` and preview `retrieve`), and Schema MCP tools to a bounded business workflow.
4. Design prompts that retrieve workplace context selectively and preserve per-user permission boundaries.
5. Validate response quality, latency tradeoffs, and preview support boundaries before pilot rollout.

## Prerequisites

- Access to Copilot Studio and a usage-based Copilot Credits billing plan linked to an Azure subscription (see [Enable your tenant for Work IQ](https://learn.microsoft.com/microsoft-365/copilot/extensibility/work-iq/enable-work-iq)).
- One-time Global Administrator provisioning of the Work IQ service principal (`fdcc1f02-fc51-4226-8753-f668596af7f7`) in Microsoft Entra ID and MCP server approval in the Microsoft 365 admin center (**Agents** → **Manage** → **MCP servers**).
- Familiarity with [connecting to Model Context Protocol servers in Copilot Studio](https://learn.microsoft.com/microsoft-copilot-studio/agent-extend-action-mcp).
- Stakeholder alignment on using preview capabilities (such as the Work IQ MCP `retrieve` tool or connected business app workloads).

## Step-by-Step

### Step 1 - Define the pilot scope and tool selection

1. Identify one workflow where workplace context materially improves decisions (for example account preparation, incident handoff, or project status synthesis).
2. Decide which Work IQ MCP tool category fits each task:
   - `search_paths` and `get_schema` to discover supported relative resource paths and parameters dynamically.
   - `fetch` (read-only Entity tool) for targeted Microsoft 365 items such as `/me/messages` or `/me/events`, keeping write operations (`create_entity`, `update_entity`, `delete_entity`, `do_action`) out of scope for a read-first pilot.
   - `ask` for synthesized workplace Q&A or `retrieve` when testing semantic grounding chunks in a pilot workflow.
3. Document what data is in-scope and out-of-scope for the pilot.
4. Capture rollback criteria and confirm governance sign-off with your Microsoft 365 and Power Platform administrators.

### Step 2 - Configure MCP server connectivity and authentication

1. Confirm the Work IQ resource service principal (`fdcc1f02-fc51-4226-8753-f668596af7f7`) is provisioned in your tenant and allowed under Microsoft 365 admin center MCP governance.
2. Connect the MCP tool surface using delegated Microsoft Entra ID OAuth 2.0 (Work IQ MCP supports OAuth metadata discovery via `/.well-known/oauth-protected-resource` so tokens run in the signed-in user's permission context).
3. In your agent's **Tools** configuration, attach the approved MCP connection and verify that tool discovery succeeds.
4. Disable or omit write/mutation tools (`create_entity`, `update_entity`, `delete_entity`, `do_action`) so the pilot operates strictly read-only.
5. Save and document the connection ownership, Entra scopes, and billing plan settings.

### Step 3 - Design context-aware prompt behavior

1. Update agent instructions so the orchestrator discovers paths with `search_paths` / `get_schema` when needed and calls `fetch`, `ask`, or `retrieve` selectively rather than on greeting or purely static policy turns.
2. Add a fallback instruction when the signed-in user has no matching items or when an MCP call times out.
3. Require concise source attribution (for example referencing the meeting, thread, or document title) without echoing raw JSON payloads.
4. Avoid broad, unbounded multi-workload fetches when a narrow relative path or targeted query answers the user's question.
5. Save your instruction updates and prepare a repeatable evaluation prompt set.

### Step 4 - Test with and without Work IQ MCP context

1. Run your baseline prompt set with the Work IQ MCP tool disabled.
2. Enable the Work IQ MCP tool and run the identical prompt set as an authorized test user.
3. Compare answer relevance, citation specificity, and actionability across both runs.
4. Measure turn latency and Copilot Credit consumption tradeoffs on multi-tool turns.
5. Capture side-by-side transcripts showing where permission-trimmed workplace context improved the outcome.

### Step 5 - Publish pilot readiness and governance notes

1. Document which capabilities in your design are generally available versus preview (such as the Work IQ MCP `retrieve` tool or connected business app sources).
2. Define operational monitoring signals, including MCP error rates, Entra sign-in logs, and usage-based Copilot Credit spend.
3. Create a support runbook covering token consent failures, admin MCP server blocks, and empty-context fallbacks.
4. Record clear promotion criteria for expanding beyond the pilot group.
5. Share the readiness package with security, compliance, and platform stakeholders.

## References

- [Work IQ MCP server overview](https://learn.microsoft.com/microsoft-365/copilot/extensibility/work-iq/mcp/overview)
- [Work IQ MCP tool reference](https://learn.microsoft.com/microsoft-365/copilot/extensibility/work-iq/mcp/tool-reference)
- [Enable your tenant for Work IQ](https://learn.microsoft.com/microsoft-365/copilot/extensibility/work-iq/enable-work-iq)
- [Add Work IQ to custom agents in Copilot Studio](https://learn.microsoft.com/microsoft-copilot-studio/agents-experience/add-work-iq)
- [Connect to Model Context Protocol servers in Copilot Studio](https://learn.microsoft.com/microsoft-copilot-studio/agent-extend-action-mcp)

## Validation / Success Criteria

- MCP context integration is configured and tested.
- You can show before/after quality differences for pilot prompts.
- Preview limitations and mitigations are documented.
- A controlled rollout plan exists for the pilot scenario.

## Lab Complete

You implemented and validated a **Work IQ MCP (preview)** pilot pattern for Copilot Studio.

> 🔗 **Related scenario lab:** [Lab 05: Supercharge Agents with Work IQ and Microsoft 365 Intelligence](../05-work-iq-m365-intelligence/index.md) — the end-to-end Work IQ + Microsoft 365 grounding scenario this preview feature fits into.

Suggested next labs:

- [Lab 05: Supercharge Agents with Work IQ and Microsoft 365 Intelligence](../05-work-iq-m365-intelligence/index.md)
- [Lab 11: Custom Analytics Metrics](../11-custom-analytics-metrics/index.md)
