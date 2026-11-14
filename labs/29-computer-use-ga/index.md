# Lab 29: Computer Use — Production Governance & Reliability

*Configure, test, and govern computer use automations in Copilot Studio with accurate GA vs. preview boundaries, credit budgeting, and environment controls.*

| Field | Details |
|---|---|
| ⭐ **DIFFICULTY** | Advanced (300) |
| ⏱️ **TIME** | 90 minutes |
| 🧩 **PRODUCTS** | Microsoft Copilot Studio, Power Platform Admin Center |
| 🏷️ **TAGS** | Computer Use, UI Automation, Governance |
| 🏭 **INDUSTRIES** | Cross-industry |

---

## Overview

**Computer use** in Microsoft Copilot Studio lets agents powered by the **standard harness** (with **generative orchestration** turned on) automate websites and Windows desktop applications using Computer-Using Agent (CUA) vision models and a virtual mouse and keyboard — no API or fragile DOM/CSS selectors required.

Before rolling computer use toward production, architects and makers must distinguish between **generally available (GA)** capabilities and **preview** or **experimental** options documented on Microsoft Learn:

| Capability / Component | Microsoft Learn Status | Production & Licensing Guidance |
|---|---|---|
| **In-agent computer use on a registered Windows machine** (**Bring-your-own machine** via Power Automate for desktop 2.61.132.25266+) | **Generally available** | Supported for production on dedicated, isolated machines with least-privilege accounts. |
| **Standard GA models**: OpenAI `Computer-Using Agent (CUA)`, OpenAI `GPT-6 Sol`, Anthropic `Claude Sonnet 4.5` | **Generally available** | Billed through the Agent action feature at **5 Copilot Credits per step** (Anthropic models require admin enablement of external models). |
| **Experimental models**: Anthropic `Claude Sonnet 4.6` (Standard) and `Claude Opus 4.6` (Premium) | **Experimental** | `Claude Sonnet 4.6` consumes **5 Copilot Credits per step**; `Claude Opus 4.6` consumes **15 Copilot Credits per step**. Evaluate before production use. |
| **Hosted browser (preview)** and **Cloud PC pool (preview)** (powered by Windows 365 for Agents) | **Preview** | Preview features aren't meant for production use. Hosted browser is Microsoft-managed (not Entra-joined or Intune-managed) and throttled during peak demand. |
| **Standalone computer use tools (preview)** (global **Tools** library & **Run a computer use tool** in agent flows) | **Preview** | Preview and rolling out regionally; not meant for production use. |

> ⚠️ **Safety & risk posture:** Microsoft Learn notes that computer use is not intended for high-risk or irreversible financial transactions without layered controls, and **Human supervision** is **probabilistic** rather than a deterministic safety gate.

## Documentation

- [Automate web and desktop apps with computer use](https://learn.microsoft.com/microsoft-copilot-studio/computer-use)
- [Configure where computer use runs (preview)](https://learn.microsoft.com/microsoft-copilot-studio/configure-where-computer-use-runs)
- [Human supervision in computer use](https://learn.microsoft.com/microsoft-copilot-studio/human-supervision-computer-use)
- [Monitor computer use](https://learn.microsoft.com/microsoft-copilot-studio/monitor-computer-use)
- [Administer computer use](https://learn.microsoft.com/microsoft-copilot-studio/administer-computer-use)
- [Add standalone computer use tools to agents and agent flows (preview)](https://learn.microsoft.com/microsoft-copilot-studio/computer-use-standalone)

## Learning Objectives

1. Scope a candidate UI workflow and verify whether its execution target and model are **generally available**, **preview**, or **experimental**.
2. Configure an in-agent **Computer use** tool with natural-language instructions, structured JSON output, **Stored credentials**, **Access control**, and **Enforce HTTPS**.
3. Configure **Human supervision** with realistic expectations around its probabilistic detection model and reviewer visibility constraints.
4. Benchmark reliability and **Copilot Credits** consumption across repeated runs using the built-in **Test** panel and **Activity** map.
5. Apply Power Platform admin center controls (**Store logs in Dataverse**, **Send audit logs to Microsoft Purview** with `CUAOperation`, environment disablement, and tenant hosted-browser governance).

## Prerequisites

- Access to **Microsoft Copilot Studio** with an agent on the **standard harness** and **generative orchestration** turned on.
- A dedicated Windows machine registered in Power Automate (**Power Automate for desktop** version `2.61.132.25266` or later) for GA testing, or a non-production environment if evaluating preview **Hosted browser (preview)** / **Cloud PC pool (preview)**.
- A non-production target web portal or Windows app (WinForms, WPF, UWP, WinUI, or Win32) — or one of the Microsoft Learn sample portals (`https://computerusedemos.blob.core.windows.net/web/Portfolio/index.html`).
- Environment admin access (or coordination with a Power Platform admin) to review **Computer use** feature, logging, and Microsoft Purview settings.

## Step-by-Step

### Step 1 - Scope the workflow and execution target

1. Choose one repeatable, low-risk web or Windows UI workflow that lacks an API (for example, portfolio lookup or invoice intake on a test portal).
2. Confirm your agent runs on the **standard harness** with **generative orchestration** enabled.
3. Choose the execution target under **Machine** based on your stage:
   - For **production-track validation (GA)**, select a dedicated, isolated registered Windows machine (**Bring-your-own machine** via **Manage machines** in Power Automate).
   - Keep **Hosted browser (preview)**, **Cloud PC pool (preview)**, and **Standalone computer use tools (preview)** scoped strictly to non-production pilots.
4. List each screen transition from start to finish and estimate the step count to forecast cost (**5 Copilot Credits per step** on standard GA models; **15 Copilot Credits per step** on premium models).
5. Record the manual baseline completion time and confirm the target app does not rely on unsupported password surfaces (such as Citrix, Electron, Java, Unity, or CLI windows).

### Step 2 - Configure the computer use tool and access boundaries

1. Open your agent in Copilot Studio, go to the **Tools** page, and select **Add tool** → **New tool** → **Computer use**.
2. Draft clear, step-by-step natural-language instructions (include exact `https://` URLs, exact Windows app or Task Manager process names such as `Microsoft Edge` or `msedge`, and explicit completion rules such as returning valid JSON rather than relying on brittle UI selectors), then select **Add and configure**.
3. Complete the four required fields — **Name**, **Description**, **Model** (choose a GA model such as `Computer-Using Agent (CUA)`, `GPT-6 Sol`, or `Claude Sonnet 4.5`), and **Instructions** — plus dynamic **Inputs** for per-run values.
4. Under **Credentials to use**, choose **Maker-provided credentials** for background/autonomous runs (noting that anyone you share the agent with acts with the maker's machine access) or **End user credentials** when each user has credentials on the target machine; configure website/app sign-in secrets under **Stored credentials** using **Internal storage** or **Azure Key Vault**.
5. Enable **Access control** to allow-list only approved website domains (for example, `*.contoso.com`) and desktop apps, turn on **Enforce HTTPS**, and select **Save** (remembering that Access control blocks interaction on unapproved sites even if the browser navigates to them).

### Step 3 - Configure human supervision and handle UI variance

1. Open **Human supervision**, configure an authorized Outlook reviewer email and response time limit, and verify that the reviewer is the user initiating the run (other recipients typically cannot inspect the run's activity context).
2. Document in your design notes that **Human supervision** uses probabilistic detection for potentially harmful screen instructions and must be paired with least-privilege machine accounts, **Access control**, and read-only scoping rather than treated as a guaranteed fail-safe.
3. Select **Test** on the tool configuration page to open the split-pane test experience (reasoning and action log on the left, live machine preview on the right, and **Stop testing** available as an immediate kill switch).
4. Introduce minor UI variations (such as an optional banner, empty search result, or slow page load) and refine your natural-language **Instructions** so the model handles them cleanly without guessing values.
5. Verify that extracted values return in your requested plain-text or structured JSON schema before saving your baseline configuration.

### Step 4 - Run reliability and Copilot Credit benchmarks

1. Execute at least ten consecutive runs across representative inputs using **Test** or the agent test chat.
2. Inspect the **Activity** map and **Transcript** after each run to record pass/fail outcome, step count, wall-clock duration, and total **Copilot Credits** consumed (`steps × 5` for standard models).
3. Test one policy boundary intentionally — such as navigating to an `http://` URL with **Enforce HTTPS** enabled or attempting to click on a domain outside **Access control** — and confirm the run blocks interaction as expected.
4. Classify any failed or multi-retry steps (ambiguous button labels, missing URL specificity, credential domain mismatch, or expired supervision timeout).
5. Refine the **Instructions** and re-run to confirm improved reliability and predictable step counts.

### Step 5 - Apply environment governance, logging, and rollback controls

1. In the [Power Platform admin center](https://admin.powerplatform.microsoft.com/), go to **Manage** → **Environments** → select your environment → **Settings** → **Product** → **Features**, and locate **Computer use**.
2. Turn on **Store logs in Dataverse** (confirming conversation transcripts in Dataverse are also allowed), select the minimum verbosity required by your privacy posture (**All data**, **Data without screenshots**, or **Minimal**), and set an explicit **Log retention time**.
3. If your tenant uses Microsoft Purview, evaluate enabling **Send audit logs to Microsoft Purview** and document that computer-use audit events appear under the activity operation **CUAOperation**.
4. Review **Manage** → **Tenant settings** → **Hosted browser in computer use** so tenant admins consciously govern preview hosted-browser availability across environments.
5. Document your emergency break-glass procedure: disabling the tool's **Enabled** toggle on the agent **Tools** page, revoking **Stored credentials**, or turning off computer use across the environment in the admin center (or via `pac env update-settings --environment <envid> --name iscomputeruseinmcsenabled --value false`).

## Validation / Success Criteria

- Execution target and selected model are explicitly classified as **GA**, **Preview**, or **Experimental** in your rollout checklist.
- The **Computer use** tool runs with **Access control**, **Enforce HTTPS**, and governed **Stored credentials** configured.
- Ten consecutive validation runs meet your reliability target with measured step counts and **Copilot Credits** per run.
- Environment logging (**Store logs in Dataverse** / **CUAOperation**) and emergency disablement steps are verified and documented.

## Lab Complete

You configured and governed a **computer use** automation in Copilot Studio with clear GA vs. preview boundaries, credit benchmarking, and enterprise admin controls.

> 🔗 **Related scenario lab:** [Lab 28: Build a Computer-Using Agent for Desktop Automation](../28-computer-use-agents/index.md) — an end-to-end utility scenario covering in-agent computer use alongside preview Cloud PC pools and standalone computer-use tools.

Suggested next labs:

- [Lab 28: Build a Computer-Using Agent for Desktop Automation](../28-computer-use-agents/index.md)
- [Lab 39: Agent Readiness / Issue Status](../39-agent-readiness-issue-status/index.md)
