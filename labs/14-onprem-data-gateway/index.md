# 🌉 Lab 14: On-Premises Data Gateway for Copilot Studio

*Bridge Copilot Studio to on-premises systems with secure outbound-only hybrid connectivity and reusable agent flows.*

| | |
|---|---|
| ⭐ **DIFFICULTY** | Advanced (Level 300) |
| ⏱️ **TIME** | 75 minutes |
| 🧩 **PRODUCTS** | Microsoft Copilot Studio, Power Platform On-Premises Data Gateway, Power Automate, SQL Server |
| 🏷️ **TAGS** | On-Premises, Data Gateway, Hybrid Connectivity, SQL Server, Power Automate |
| 🏭 **INDUSTRY** | Manufacturing, Public Sector, and any organization with on-premises data |
| 👤 **PERSONA** | Hybrid Integration Architect / Maker / Infrastructure Reviewer |
| 📋 **STATUS** | Supplementary |

---

## 🗺️ Lab Flow

```mermaid
flowchart LR
  A["Validate Gateway Host"] --> B["Install Standard Gateway"]
  B --> C["Register in Admin Center"]
  C --> D["Create SQL Data Source"]
  D --> E["Build Power Automate Flow"]
  E --> F["Add Flow to Copilot Studio"]
  F --> G["Test Hybrid Query"]
  G --> H["Compare Gateway Models"]
```

---

## ⚡ Why this lab matters

Many organizations still keep their most operationally important data inside on-premises SQL Server, ERP systems, file shares, or legacy line-of-business applications.
Copilot Studio can still participate in those processes, but usually through Power Automate or connector paths that depend on the on-premises data gateway.
This lab shows how to install the gateway, connect to SQL Server, route the data through a flow, and choose the right gateway model for long-term supportability.

---

## 🌍 Real-world example

Think about a manufacturing supervisor who needs open work orders from a plant-floor SQL Server database, or a public-sector case worker who must retrieve records from a datacenter-bound application.
A conversational agent is compelling only if it can securely reach those systems without punching inbound holes into the network.
The gateway provides that bridge through outbound Azure Relay communication and managed cloud orchestration.

---

## 🏗️ What you'll build

| Layer | What you will build |
|---|---|
| **Hybrid bridge** | A standard-mode on-premises data gateway registered to your Power Platform tenant |
| **Data path** | A SQL Server data source connected through the gateway |
| **Automation layer** | A Power Automate flow that reads on-premises data and returns compact JSON |
| **Conversation layer** | A Copilot Studio agent that calls the flow and summarizes results |
| **Architecture decision** | A comparison of Standard, Personal, and VNet Data Gateway options |

---

## 🎯 What you will learn

1. Install and register the on-premises data gateway on a suitable always-on Windows host.
2. Create a gateway-backed SQL Server connection and understand the performance and payload considerations.
3. Use Power Automate as the bridge between Copilot Studio and on-premises data.
4. Compare Standard gateway, Personal gateway, and VNet Data Gateway in a structured decision framework.
5. Place the gateway in the broader context of Copilot Studio connectivity methods.

---

## 🧠 Core concepts overview

| Concept | What it means in this lab |
|---|---|
| **Outbound-only bridge** | The gateway opens outbound connections through Azure Relay so you do not expose inbound ports from the cloud. |
| **TLS 1.2** | Modern encrypted transport is a baseline prerequisite for gateway traffic. |
| **Standard gateway** | The enterprise multi-user model and the correct fit for Copilot Studio plus Power Automate patterns. |
| **Personal gateway** | A Power BI-only convenience mode that is not suitable for shared Copilot workloads. |
| **VNet Data Gateway** | A managed alternative that reduces host maintenance but changes the operational model. |
| **Cluster** | Multiple gateway nodes joined together for resilience and capacity. |
| **Payload limits** | Design around roughly 2 MB writes and 8 MB reads in common gateway-backed scenarios. |
| **Always-on host** | A core operational requirement; sleeping laptops and unstable VMs make bad gateways. |
| **Agent flow pattern** | Copilot Studio usually consumes on-premises data through flows or custom connectors that use the gateway. |
| **Connectivity toolbox** | Gateway is one of six Copilot Studio connectivity methods and should be chosen intentionally. |

---

## 📚 Documentation

- [What is an on-premises data gateway?](https://learn.microsoft.com/en-us/data-integration/gateway/service-gateway-onprem)
- [On-premises data gateway architecture](https://learn.microsoft.com/en-us/data-integration/gateway/service-gateway-onprem-indepth)
- [Install an on-premises data gateway](https://learn.microsoft.com/en-us/data-integration/gateway/service-gateway-install)
- [Add tools to custom agents](https://learn.microsoft.com/en-us/microsoft-copilot-studio/add-tools-custom-agent)
- [Use agent flows in Copilot Studio](https://learn.microsoft.com/en-us/training/modules/use-agent-flows/)

---

## ✅ Prerequisites

- A supported 64-bit Windows host with .NET Framework 4.8 installed.
- Administrative rights to install software on the gateway host.
- A Microsoft 365 account with permission to register gateways in the target tenant.
- A reachable on-premises SQL Server instance and credentials approved for the lab.
- Copilot Studio and Power Automate access in an environment where premium connectors are allowed.

---

## 💳 Licensing and access planning

| Component | What you need to know |
|---|---|
| **Gateway software** | The on-premises data gateway itself is free to install and register. |
| **Premium connectors** | SQL Server and related hybrid automation paths still require the right Power Platform premium licensing. |
| **Copilot Studio** | Agent licensing applies separately from gateway setup. |
| **Infrastructure cost** | You still own the Windows host, patching, monitoring, and high-availability design. |
| **Managed alternatives** | VNet Data Gateway can reduce self-hosted maintenance where it fits your platform standards. |

---

## 🗺️ Use cases covered

| # | Use case | Time | Required |
|---|---|---|---|
| 1 | Install and Configure the Gateway | 20 min | ✅ |
| 2 | Connect to On-Premises SQL Server | 20 min | ✅ |
| 3 | Build a Gateway-Connected Agent Flow | 20 min | ✅ |
| 4 | Compare Gateway Options | 15 min | ✅ |

---

# 🧪 Use Case #1 — Install and Configure the Gateway (20 min)

> 🎯 **Objective:** Install the standard on-premises data gateway, register it to your tenant, and prepare a cluster design for high availability.

| | |
|---|---|
| **Goal** | Create a reliable bridge between cloud automation and on-premises systems. |
| **Outcome** | You have a registered gateway, a recovery key, and a clear hosting design. |
| **Why it matters** | Everything else in the lab depends on the gateway being stable and supportable. |

### Scenario

Your organization still runs critical SQL Server and line-of-business systems inside the datacenter.
Copilot Studio cannot talk to those systems directly, so you need a trusted bridge.
The on-premises data gateway provides that bridge using outbound-only connectivity and Azure Relay.

### Step 1 — Validate the host machine

1. Choose a **64-bit Windows 10** or **Windows Server 2019+** machine that is always on.
2. Confirm **.NET Framework 4.8** is installed.
3. Check CPU and memory; the recommended baseline for serious workloads is roughly **8 cores** and **8 GB RAM**.
4. Ensure the machine can reach the internet over outbound TLS 1.2.

> ⚠️ **Warning:** Do not install the gateway on a domain controller or a laptop. Those hosts create avoidable reliability and security problems.

### Step 2 — Download and install the gateway

1. Download the gateway from the Microsoft Learn installation page or the official gateway download link.
2. Run the installer and choose **Standard mode** for enterprise and multi-user scenarios.
3. Sign in with your Microsoft 365 account that has access to the target Power Platform tenant.
4. Register a new gateway and provide a memorable gateway name.
5. Set a strong **recovery key** and store it in an approved secret-management location.

> 💡 **Tip:** The recovery key is part of your disaster recovery story. Treat it like production infrastructure, not a throwaway workshop value.

### Step 3 — Verify registration in the admin center

1. Open the Power Platform admin center and locate the **Gateways** area.
2. Confirm the new gateway appears as **Online**.
3. Review who the gateway admins are and remove any unnecessary broad ownership.
4. Capture the exact region and tenant where the gateway is registered.

### Step 4 — Plan for clustering and high availability

1. Decide whether this pilot needs a second gateway node for resilience.
2. If yes, install a second gateway on another supported always-on machine and join it to the same gateway cluster using the recovery key.
3. Document which node is primary for operations and how failover will be tested.

> 💡 **Tip:** Even if you do not build the second node in the lab, write down the cluster plan now. Most successful pilots become production requests quickly.

### Step 5 — Understand the security and traffic model

1. Review the outbound-only architecture: cloud services communicate through **Azure Relay**; no inbound firewall opening is required.
2. Confirm that data is encrypted in transit and that TLS 1.2 is enforced.
3. Note that this gateway pattern is different from the **VNet Data Gateway**, which is managed and does not require you to install software.
4. Record whether your environment uses private networking features that could conflict with gateway assumptions, including the note that some Private Link scenarios cannot coexist with gateway-based access paths.

### Verification checklist

- The gateway host meets the OS, .NET, and availability prerequisites.
- A standard-mode gateway is installed and shows as online in the admin center.
- The recovery key is stored securely.
- A cluster or high-availability plan is documented.

### Troubleshooting

- If the gateway will not register, confirm outbound TLS 1.2 access and tenant sign-in permissions.
- If the admin center does not show the gateway, verify you signed in with the same tenant account used during installation.
- If performance looks poor on day one, check host sizing before blaming the connectors.
- If the gateway is installed on an unreliable workstation, move it now instead of trying to engineer around a bad host choice.

### Challenge

- Document a standard naming convention for gateway hosts, clusters, and recovery keys in your organization.
- Plan a quarterly patching process that minimizes downtime for gateway-connected flows.
- Create a one-paragraph explanation of the outbound-only architecture for a security reviewer.

### Key takeaways

- Gateway host selection is an architectural decision, not a convenience decision.
- Standard mode is the enterprise baseline for shared workloads and Copilot-related integrations.
- Recovery keys and cluster planning are part of production readiness from the start.

### Evidence to capture

- Screenshot of the gateway registration confirmation or admin center listing.
- Screenshot of host prerequisites or system information.
- Written note of the recovery key storage location and cluster intent.

### Stakeholder discussion prompts

- Which team should own the gateway lifecycle: data platform, infrastructure, or automation center of excellence?
- How much downtime is acceptable for gateway maintenance in your business process?
- Would production require a two-node cluster immediately?

### ✅ You've completed Use Case #1

You now have the hybrid bridge required to connect Copilot-driven automation to on-premises systems in a supportable way.

---

# 🧪 Use Case #2 — Connect to On-Premises SQL Server (20 min)

> 🎯 **Objective:** Add an on-premises SQL Server data source through the gateway, test connectivity, and understand payload constraints.

| | |
|---|---|
| **Goal** | Expose a governed SQL data source that flows and agents can use safely. |
| **Outcome** | You have a working SQL Server connection backed by the gateway and a clear understanding of gateway limits. |
| **Why it matters** | Most hybrid Copilot patterns start with SQL because it is structured, familiar, and still heavily on-premises in many organizations. |

### Scenario

Your manufacturing or public-sector team stores the source-of-truth data in an on-prem SQL Server instance.
The gateway lets cloud services reach it securely without direct inbound access.
This use case prepares the database connection that the agent will call through a flow.

### Step 1 — Create the SQL data source on the gateway

1. In the Power Platform admin center or gateway management experience, choose **Add data source**.
2. Select **SQL Server** as the data source type.
3. Enter the server name, database name, and authentication method approved for the lab.
4. Bind the data source to the gateway or cluster created in Use Case #1.

### Step 2 — Test connectivity

1. Select **Test connection** and confirm the gateway can authenticate to SQL Server.
2. If possible, validate with a low-risk read operation against a known table.
3. Confirm the SQL Server firewall and local permissions allow the gateway host to reach the database.

> 💡 **Tip:** Use a dedicated SQL login or service account with least privilege. Do not rely on a personal DBA credential for anything beyond a one-time smoke test.

### Step 3 — Review common supported on-premises sources

The gateway can support many data sources beyond SQL Server, including:

- Oracle
- SAP HANA
- MySQL
- PostgreSQL
- Teradata
- IBM DB2
- ODBC
- File System
- SharePoint on-premises
- Active Directory-related patterns

1. Note which of these matter in your environment even if the lab focuses on SQL Server.
2. Decide whether your future Copilot flows will stay SQL-centric or need a multi-source design.

### Step 4 — Understand gateway payload and design limits

1. Document the approximate payload limits: around **2 MB for writes** and **8 MB for reads** in common gateway-backed scenarios.
2. Design queries to be selective rather than returning entire tables.
3. Prefer server-side filtering, stored procedures, and pagination over oversized result sets.
4. Recognize that gateway throughput and concurrency depend on host sizing and query efficiency.

> ⚠️ **Warning:** A query that works in SSMS may still be a poor fit for a gateway-backed agent if it returns too much data or takes too long to serialize.

### Step 5 — Capture a safe query shape for the agent flow

1. Choose one table or view the agent will read through Power Automate.
2. Define the minimum columns needed, such as work order ID, plant, status, last update, and owner.
3. Decide whether the flow should call a stored procedure, a parameterized query, or a filtered list action.
4. Verify that the result shape is easy for Copilot Studio to summarize later.

### Verification checklist

- A SQL Server data source is attached to the gateway and passes connection testing.
- You can name the exact table, view, or stored procedure that the agent flow will use.
- The design accounts for payload-size and performance constraints.
- Least-privilege access for the database connection is documented.

### Troubleshooting

- If connection testing fails, check SQL authentication, server name resolution, and whether the gateway host can reach the database port.
- If queries are slow, inspect indexing and result size before changing gateway settings.
- If a read works in SSMS but not through the gateway, confirm the gateway data source uses the same database and permissions.
- If results are truncated or errors mention payload size, narrow the selected columns and row count.

### Challenge

- Create one stored procedure that returns a compact result tailored for conversational use.
- List three columns from the target table that should *not* be exposed to a chatbot audience.
- Design a paging strategy for a future scenario that could return hundreds of rows.

### Key takeaways

- Gateway-backed SQL should be designed for conversational retrieval, not generic database browsing.
- Performance and payload constraints shape the user experience as much as connectivity does.
- A well-scoped data source is easier to secure and explain.

### Evidence to capture

- Screenshot of the SQL Server data source test result.
- Screenshot or note showing the chosen table, view, or stored procedure.
- Written summary of the payload and query-shaping decisions.

### Stakeholder discussion prompts

- Which on-premises data source should be the first production candidate after SQL Server?
- Would your DBAs prefer stored procedures, views, or direct table access from flows?
- How much data should a frontline user ever be able to retrieve in one conversation?

### ✅ You've completed Use Case #2

You now have a governed SQL data path that the next use case can call from Power Automate and Copilot Studio.

---

# 🧪 Use Case #3 — Build a Gateway-Connected Agent Flow (20 min)

> 🎯 **Objective:** Create a Power Automate flow that uses the gateway-backed SQL connection and call it from a Copilot Studio agent.

| | |
|---|---|
| **Goal** | Bridge Copilot Studio to on-premises data without exposing the database directly to the agent. |
| **Outcome** | You have a reusable agent flow that returns filtered on-premises records to the conversation. |
| **Why it matters** | Agent flows are the most practical way to use gateway-backed data from Copilot Studio today. |

### Scenario

Your users want a chatbot, but your data lives inside the plant or datacenter.
Copilot Studio can reach that data through a cloud flow that uses the gateway-backed SQL connector.
This use case creates the full hybrid pattern end to end.

### Step 1 — Create the flow

1. Open Power Automate and create an instant or agent-triggered cloud flow.
2. Define inputs such as **Plant**, **Work Order ID**, or **Status** depending on your scenario.
3. Add a SQL Server action that uses the data source created through the gateway.

Example flow purpose:

```text
Given a plant code and optional status, return the top five active work orders from the on-premises operations database.
```

### Step 2 — Shape the SQL result for conversational use

1. Avoid returning raw database payloads with dozens of columns.
2. Use **Select**, **Compose**, or an equivalent transformation step to map results into a clean JSON shape.
3. Keep field names business-friendly, such as `workOrderId`, `plant`, `status`, `owner`, and `lastUpdated`.

> 💡 **Tip:** The more structured your flow output is, the less the agent has to guess when summarizing results.

### Step 3 — Return compact JSON to Copilot Studio

1. Add a final **Respond** action or the equivalent output step supported by agent flows.
2. Return a concise object or array instead of the full connector response envelope.
3. Include a small row count so the agent can say whether the result was partial or complete.

Suggested output shape:

```json
{
  "plant": "Plant-07",
  "returnedCount": 3,
  "workOrders": [
    { "workOrderId": "WO-1042", "status": "Open", "owner": "A. Chen", "lastUpdated": "2026-06-14T08:15:00Z" }
  ]
}
```

### Step 4 — Call the flow from Copilot Studio

1. Add the flow as a tool in your agent.
2. Describe exactly when it should be used, for example when a user asks for plant work orders or shop-floor status.
3. Test a prompt like:

```text
Show me the open work orders for Plant-07.
```

4. Verify the agent summarizes the output rather than dumping JSON to the user.

### Step 5 — Add failure and timeout guidance

1. Create a fallback message for situations where the gateway is offline or the database times out.
2. Tell the agent to suggest a narrower filter if too many results would be returned.
3. Decide what should happen if no records are found versus if the flow itself fails.

> ⚠️ **Warning:** Hybrid flows fail in more ways than cloud-native connectors. Timeouts, host patching, network hiccups, and SQL locks all show up as user-visible issues unless you plan the messages carefully.

### Verification checklist

- The flow accepts inputs, uses the gateway-backed SQL connection, and returns a compact output.
- The agent can call the flow successfully from a prompt.
- The result is summarized in user-friendly language.
- A fallback path exists for no-results and flow-failure cases.

### Troubleshooting

- If the flow runs manually but not from the agent, inspect the tool description and the flow input schema.
- If the gateway reports offline during testing, confirm the host machine is awake and the gateway service is running.
- If the agent exposes raw JSON, improve the instructions and the final response shaping in the flow.
- If SQL locks or timeouts occur, narrow filters or move expensive logic into optimized database objects.

### Challenge

- Add a second flow action that writes a follow-up note to a collaboration system when a critical work order is found.
- Create a version of the flow that accepts a work-order ID and returns a single detailed record.
- Design a flow output contract that a Power BI or API consumer could reuse later.

### Key takeaways

- Power Automate is the practical control plane between Copilot Studio and gateway-backed systems.
- Compact, clean flow outputs make conversational responses better and safer.
- Failure messaging is essential in hybrid automation because the dependency chain is longer.

### Evidence to capture

- Screenshot of the flow run history showing a successful gateway-backed execution.
- Transcript excerpt of the agent returning on-premises data.
- Screenshot of the tool definition in Copilot Studio.

### Stakeholder discussion prompts

- Which hybrid use case should come next after read-only work-order lookup?
- What business SLA should apply if the gateway or database is temporarily unavailable?
- Should critical records trigger downstream notifications or just a chat response?

### ✅ You've completed Use Case #3

You now have the core hybrid pattern for Copilot Studio: cloud conversation, gateway-backed flow, and on-premises data returned in a governed way.

---

# 🧪 Use Case #4 — Compare Gateway Options (15 min)

> 🎯 **Objective:** Understand when to use Standard gateway, Personal gateway, or VNet Data Gateway, and plan a migration path where appropriate.

| | |
|---|---|
| **Goal** | Choose the right connectivity model for your workload instead of defaulting to whatever was installed first. |
| **Outcome** | You have a decision framework for hybrid connectivity patterns in Copilot Studio and Power Platform. |
| **Why it matters** | The wrong gateway choice creates avoidable support debt and redesign later. |

### Scenario

Your pilot works, but architecture reviewers want to know whether the gateway model you chose is the long-term answer.
Power Platform offers multiple connectivity patterns, and each fits different governance and ownership models.
This final use case helps you translate technical setup into a clear decision memo.

### Step 1 — Compare the three main models

| Option | Best fit | Key tradeoff |
|---|---|---|
| **Standard gateway** | Shared enterprise workloads, flows, and multi-user scenarios | You manage the host and patching. |
| **Personal gateway** | Individual Power BI use only | Not suitable for shared Copilot Studio or enterprise automation patterns. |
| **VNet Data Gateway** | Managed private connectivity where supported | Requires different setup assumptions and less local-host control. |

1. Mark **Standard gateway** as the default for this lab and most Copilot-connected enterprise scenarios.
2. Treat **Personal mode** as out of scope for Copilot Studio because it is a Power BI-focused convenience model.
3. Note where **VNet Data Gateway** could reduce operational burden if your environment and source systems support it.

### Step 2 — Decide when to keep the standard gateway

Keep the standard gateway when:

- You need broad connector support today.
- You already have Windows infrastructure ownership and patching processes.
- Your on-premises source systems are easiest to reach from a datacenter host you control.

### Step 3 — Decide when to evaluate VNet Data Gateway

Consider VNet Data Gateway when:

- You want a more managed experience with less host maintenance.
- Your security model emphasizes Azure-native networking and private connectivity.
- Your connector and regional support matrix aligns with the managed option.

> 💡 **Tip:** Gateway choice is often driven more by operational ownership and networking policy than by the chatbot itself.

### Step 4 — Build a migration path

1. Document your current gateway-hosted flows, connectors, and dependent data sources.
2. Identify which flows could be moved to a VNet-based pattern without changing the agent prompts.
3. Separate changes into **connection changes**, **flow changes**, and **user-experience changes** so stakeholders understand the blast radius.
4. Define a rollback plan before any migration test.

### Step 5 — Revisit the six Copilot Studio connectivity methods

Use this lab to place the gateway in the broader connectivity toolbox:

1. **Prebuilt Connector** — fast when a supported connector exists.
2. **Custom Connector** — best for REST APIs that need a governed wrapper.
3. **Agent Flow** — ideal when orchestration or gateway access is required.
4. **REST API tool** — useful for OpenAPI-described services where preview support is acceptable.
5. **MCP Server** — strong fit for discoverable tool ecosystems and modern extensibility.
6. **Computer Use** — last resort for GUI-only systems.

> ⚠️ **Warning:** Do not use a gateway just because a system is old. If a clean API or managed VNet pattern exists, compare it honestly before locking in operational overhead.

### Verification checklist

- You can explain why Standard gateway is the right choice for this lab.
- You can explain why Personal mode is not appropriate for Copilot Studio enterprise scenarios.
- You have a short migration plan for evaluating VNet Data Gateway later if needed.
- You can place the gateway pattern inside the broader Copilot Studio connectivity landscape.

### Troubleshooting

- If architecture reviewers challenge the gateway choice, bring the comparison back to ownership, connector support, and network posture rather than preference.
- If your team confuses Personal and Standard gateways, emphasize the multi-user and enterprise governance distinction.
- If a VNet migration seems attractive, verify connector support and regional availability before promising timelines.
- If the source system already exposes a secure API, reassess whether the gateway should be a temporary bridge instead of the final architecture.

### Challenge

- Create a one-page decision memo recommending Standard gateway, VNet Data Gateway, or a non-gateway pattern for one real workload.
- Pick one legacy system in your organization and classify which of the six Copilot connectivity methods fits best today.
- List the operational tasks that disappear if you migrate from a self-hosted gateway to a managed pattern.

### Key takeaways

- Gateway choice should be intentional and documented.
- Standard gateway is powerful, but it comes with host ownership responsibilities.
- Agent Flows plus gateway access are often the right bridge, not necessarily the forever architecture.

### Evidence to capture

- Comparison table or screenshot used in your architecture review.
- Draft migration path notes for a future VNet evaluation.
- Short rationale for why this lab uses Standard gateway.

### Stakeholder discussion prompts

- What operational burden is your team willing to own for hybrid connectivity?
- Would a managed VNet pattern reduce security-review friction enough to justify migration work?
- Which legacy systems should stay on gateway access versus move to APIs or custom connectors over time?

### ✅ You've completed Use Case #4

You now have a practical framework for choosing the right hybrid connectivity model rather than treating all gateway patterns as interchangeable.

---

# 🙋 Summary

### What you accomplished

| Step | What you did |
|---|---|
| **Install** | Validated a host and registered a standard gateway to the Power Platform tenant |
| **Connect** | Created a gateway-backed SQL Server data source with least-privilege access |
| **Automate** | Built a Power Automate flow that returns on-premises data to Copilot Studio |
| **Decide** | Compared self-hosted and managed gateway options for future-state architecture |

### Why this matters in the real world

- Hybrid connectivity keeps copilots relevant in organizations where key systems are still on-premises.
- The gateway is secure by design when hosted and governed correctly because it relies on outbound Azure Relay communication.
- The strongest production patterns use Power Automate or curated connectors to shape data before it reaches the conversation.

### 🪙 Golden rules

1. Never install a production-grade gateway on a laptop or domain controller.
2. Use Standard gateway for shared enterprise automation; Personal mode is not the Copilot Studio answer.
3. Keep gateway-backed queries selective and compact so payload and latency stay under control.
4. Use Power Automate to shape, validate, and summarize on-premises data before the agent speaks it back.
5. Plan high availability and recovery keys early; hybrid automation becomes business-critical faster than most pilots expect.
6. Always compare the gateway against APIs, custom connectors, VNet options, MCP, or computer use before deciding it is the final pattern.

### Recommended next steps

- Add a second gateway node and test failover if the pilot is headed toward production.
- Expand the flow to return richer operational context, such as owner notes or maintenance priority, while still keeping payloads small.
- Evaluate whether one or more legacy workloads should move from gateway access to a managed VNet or API pattern over time.

> 🌐 **Final thought:** A hybrid copilot succeeds when cloud convenience and on-premises control meet in a design that operations teams can actually support.

