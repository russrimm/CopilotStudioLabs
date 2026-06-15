# 🧰 Lab 12: ServiceNow Integration with Copilot Studio

*Connect Copilot Studio to enterprise ITSM workflows with secure OAuth, premium connectors, and single sign-on.*

| | |
|---|---|
| ⭐ **DIFFICULTY** | Advanced (Level 300) |
| ⏱️ **TIME** | 90 minutes |
| 🧩 **PRODUCTS** | Microsoft Copilot Studio, ServiceNow, Microsoft Entra ID, Power Automate |
| 🏷️ **TAGS** | ServiceNow, ITSM, OAuth, SSO, Premium Connectors, Enterprise Integration |
| 🏭 **INDUSTRY** | Cross-industry (IT Operations, Healthcare, Financial Services) |
| 👤 **PERSONA** | ITSM Architect / Maker / Security Reviewer |
| 📋 **STATUS** | Supplementary |

---

## 🗺️ Lab Flow

```mermaid
flowchart LR
  A["Request ServiceNow PDI"] --> B["Seed Incidents + Knowledge"]
  B --> C["Register Entra Apps"]
  C --> D["Configure ServiceNow OIDC"]
  D --> E["Create Power Platform Connection"]
  E --> F["Add ServiceNow Tools"]
  F --> G["Test Lookup + Create"]
  G --> H["Enable SSO in Supported Channel"]
```

---

## ⚡ Why this lab matters

ServiceNow remains one of the most common enterprise systems behind incident management, request fulfillment, and internal support processes.
When a Copilot can talk to ServiceNow securely, it stops being just an FAQ surface and starts becoming an operational assistant.
This lab shows how to move from a free developer instance to a governed, user-friendly integration pattern built on premium connectors, OAuth, and SSO.

---

## 🌍 Real-world example

Imagine a hospital support desk where clinicians need quick help without opening a separate ITSM portal.
A nurse asks a Copilot in Teams whether an EHR device issue is already tracked, creates a new incident when needed, and reads a knowledge article on password reset without leaving the conversation.
That experience only works if identity, connector setup, and ServiceNow records are all configured deliberately.

---

## 🏗️ What you'll build

| Layer | What you will build |
|---|---|
| **Sandbox** | A free ServiceNow Personal Developer Instance with seeded incidents and knowledge articles |
| **Identity layer** | An Entra ID-backed OAuth design using App A, App B, and a ServiceNow OIDC provider |
| **Power Platform connection** | A premium ServiceNow connector connection tested before agent authoring |
| **Agent experience** | A Copilot Studio agent that can look up incidents, create incidents, and search knowledge |
| **Sign-in experience** | An SSO plan for supported host channels such as Teams, SharePoint, Custom Website, or Omnichannel |

---

## 🎯 What you will learn

1. Provision and baseline a free ServiceNow developer instance for safe experimentation.
2. Explain the four ServiceNow connector authentication methods and implement an Entra-based path.
3. Add ServiceNow as a tool in Copilot Studio and shape lookup and creation experiences.
4. Design SSO so users authenticate once and understand channel support boundaries.
5. Document licensing, plugin, redirect URI, and domain gotchas before they derail a pilot.

---

## 🧠 Core concepts overview

| Concept | What it means in this lab |
|---|---|
| **Premium connector** | The ServiceNow connector requires premium Power Platform licensing. |
| **PDI** | A Personal Developer Instance is a free ServiceNow sandbox that hibernates after inactivity. |
| **App A** | The Entra app that represents ServiceNow as the trusted OIDC resource side of the design. |
| **App B** | The connector client app that presents credentials or certificate material during connection creation. |
| **OIDC provider** | The ServiceNow configuration that trusts the Entra tenant metadata endpoint. |
| **Delegated user login** | The simplified auth path that can reuse the Microsoft 1P App ID for connector sign-in. |
| **Knowledge plugin** | The `sn_km_api` capability required for knowledge article scenarios. |
| **Redirect URI** | A frequent OAuth gotcha; the exact decoded URI must be registered if the connector reports `invalid_redirect_uri`. |
| **Agent SSO** | Copilot Studio authentication that reduces repeated prompts in supported host channels. |
| **Connectivity choice** | For ServiceNow, the prebuilt connector is the fastest path; flows can be added later for orchestration or approval logic. |

---

## 📚 Documentation

- [ServiceNow connector reference](https://learn.microsoft.com/en-us/connectors/service-now/)
- [Add tools to custom agents](https://learn.microsoft.com/en-us/microsoft-copilot-studio/add-tools-custom-agent)
- [Configure single sign-on with Microsoft Entra ID](https://learn.microsoft.com/en-us/microsoft-copilot-studio/configure-sso)
- [Configure generic OAuth 2 provider SSO](https://learn.microsoft.com/en-us/microsoft-copilot-studio/configure-sso-3p)
- [Use agent flows in Copilot Studio](https://learn.microsoft.com/en-us/training/modules/use-agent-flows/)

---

## ✅ Prerequisites

- Access to Microsoft Copilot Studio in an environment where you can create agents and connections.
- Permission to register Entra ID applications or support from an identity administrator.
- A ServiceNow developer account and ability to request a free PDI from developer.servicenow.com.
- Power Automate access if you want to wrap ServiceNow calls in flows later.
- A supported SSO host channel available for testing, such as Teams, SharePoint, Custom Website, or Omnichannel.

---

## 💳 Licensing and access planning

| Component | What you need to know |
|---|---|
| **ServiceNow PDI** | Free for development and learning. Expect hibernation after about 10 days of inactivity; wake it before demos. |
| **Power Platform premium connector** | Required. Common options include Power Apps Premium, Power Automate Premium, or pay-as-you-go. |
| **Copilot Studio** | Requires tenant and user licensing; remember that trial chat experiences have publishing limitations. |
| **Power Apps Developer Plan** | Useful for personal experimentation because it includes premium connectors for developer use. |
| **Power Automate trial** | A 90-day full-premium option that can help during workshops or evaluation periods. |

---

## 🗺️ Use cases covered

| # | Use case | Time | Required |
|---|---|---|---|
| 1 | Set Up a ServiceNow Developer Instance | 20 min | ✅ |
| 2 | Configure OAuth Authentication | 30 min | ✅ |
| 3 | Build a ServiceNow-Connected Agent | 25 min | ✅ |
| 4 | Enable SSO Between Copilot Studio and ServiceNow | 15 min | ✅ |

---

# 🧪 Use Case #1 — Set Up a ServiceNow Developer Instance (20 min)

> 🎯 **Objective:** Provision a free Personal Developer Instance (PDI), load realistic test data, and enable the APIs you need before you touch Copilot Studio.

| | |
|---|---|
| **Goal** | Create a working ServiceNow sandbox that behaves like a lightweight ITSM tenant. |
| **Outcome** | You have a running instance URL, admin access, sample incidents, and the knowledge API plugin enabled. |
| **Why it matters** | A clean sandbox lets you validate connector actions, authentication, and topic prompts without waiting on a production admin. |

### Scenario

Your service desk wants a Copilot that can look up incidents, create requests, and search knowledge articles.
Before you wire up OAuth or author topics, you need a ServiceNow instance that you control end to end.
A free PDI gives you exactly that, but only if you seed it with realistic records and enable the right plugin set.

### Step 1 — Request your free PDI

1. Open [developer.servicenow.com](https://developer.servicenow.com) and sign in or create a developer account.
2. Navigate to **Manage** → **Instance** and request a new **Personal Developer Instance**.
3. Select the latest generally available family unless your workshop requires a specific release.
4. Record the instance URL in this pattern:

```text
https://<your-instance>.service-now.com
```

5. Save the generated admin username and password in your approved password manager.

> 💡 **Tip:** PDIs are perfect for labs because they are free and isolated, but they hibernate after roughly 10 days of inactivity. Wake the instance before each workshop so your URLs, credentials, and sample data are still valid.

### Step 2 — Wake, verify, and baseline the instance

1. Sign in as the admin user and confirm the home page loads without setup warnings.
2. Open **System Diagnostics** and verify the instance is fully awake before running imports or plugin activation.
3. Change the admin password if your organization requires rotation before demos or shared learning sessions.
4. Capture the exact instance family and build number in your lab notes so everyone on your team knows what they are testing against.

> ⚠️ **Warning:** The Power Platform ServiceNow connector only supports tenants in the `service-now.com` domain family. If your enterprise uses a different vanity domain, confirm the connector path early instead of discovering it during connection setup.

### Step 3 — Create realistic sample ITSM data

1. Open the **Incidents** list and create at least five test incidents that reflect common requests in your environment.
2. Include a mix of priorities, states, categories, and assignment groups so your agent has meaningful examples.
3. Create a few request items or catalog tasks if you plan to expand the lab later into service-request scenarios.
4. Add a test caller and a test fulfiller account so you can model user-facing and operator-facing prompts.

Suggested sample incidents:

| Number | Short description | Priority | State | Assignment group |
|---|---|---|---|---|
| `INC0010101` | VPN token expired for field nurse | 2 - High | In Progress | Identity Operations |
| `INC0010102` | EHR workstation frozen in triage | 1 - Critical | New | Clinical Support |
| `INC0010103` | Laptop missing BitLocker key prompt | 3 - Moderate | On Hold | Endpoint Engineering |
| `INC0010104` | Badge access issue in datacenter | 2 - High | New | Facilities Security |
| `INC0010105` | Password reset request for kiosk user | 4 - Low | Resolved | Service Desk |

> 💡 **Tip:** Use sample data that resembles the industry story in your lab. Better prompts come from better records.

### Step 4 — Activate knowledge support

1. In the application navigator, search for **Plugins**.
2. Locate the `sn_km_api` plugin or the Knowledge API package your instance exposes under that name.
3. Select **Activate** and wait for the installation to complete.
4. Create or verify at least two knowledge articles so the agent can test knowledge lookups later.

> ⚠️ **Warning:** Without the knowledge API plugin, the connector can still work for incidents, but knowledge article actions may fail or never appear. Enable the plugin before you troubleshoot Copilot Studio.

### Step 5 — Document the instance contract for the rest of the lab

1. Record the instance URL, admin contact, available tables, and any plugin assumptions.
2. Decide whether you will use a dedicated **system user** for connector access or test directly with the admin account first.
3. Note any IP, SSO, or MFA policies that could affect later OAuth testing.
4. Verify that the instance responds from an incognito browser session to rule out cached credentials masking setup issues.

### Verification checklist

- You can sign in to the instance with an administrator account.
- At least five incident records and two knowledge articles exist for testing.
- The `sn_km_api` capability is active or otherwise confirmed available.
- The instance URL ends with `.service-now.com` and is reachable from your browser.

### Troubleshooting

- If the PDI is unavailable, return to the developer portal and explicitly wake or reclaim the instance before retrying.
- If plugin activation is slow, refresh the plugin page only after the installation job completes to avoid duplicate clicks.
- If lists appear empty, confirm you created records in the correct scope and did not filter them out accidentally.
- If login fails after a long idle period, the PDI might have been reset; verify whether your instance was rebuilt.

### Challenge

- Create one sample incident that should be escalated automatically by a future agent topic.
- Add one knowledge article with step-by-step troubleshooting and one article with a policy-oriented answer so you can compare response styles later.
- Tag your test records with a lab-specific category so you can clean them up quickly after the workshop.

### Key takeaways

- A good ServiceNow integration starts with realistic tables and records, not just credentials.
- PDIs are free and fast, but they are ephemeral enough that you should document them carefully.
- Knowledge scenarios depend on plugin readiness as much as connector readiness.

### Evidence to capture

- Screenshot of the PDI home page or instance information panel.
- Screenshot of the incident list showing at least three seeded records.
- Screenshot or note proving the knowledge API plugin is active.

### Stakeholder discussion prompts

- Would your production ServiceNow team allow a dedicated non-admin integration user for this pattern?
- Which tables besides Incident and Knowledge would matter most for your business process?
- How often would test data need to be refreshed to keep demos believable?

### ✅ You've completed Use Case #1

You now have the sandbox foundation required to configure a trustworthy ServiceNow connection instead of testing blind against an empty tenant.

---

# 🧪 Use Case #2 — Configure OAuth Authentication (30 min)

> 🎯 **Objective:** Choose the right ServiceNow authentication pattern, register the required Entra ID apps, and validate a Power Platform connection.

| | |
|---|---|
| **Goal** | Stand up a secure connector path that can be reused by Copilot Studio and Power Automate. |
| **Outcome** | You understand all four ServiceNow connector auth methods and have one working connection strategy implemented. |
| **Why it matters** | Authentication is the most common integration blocker; solving it once with a repeatable pattern saves hours later. |

### Scenario

Your security team wants modern authentication and traceability instead of a shared admin password.
The ServiceNow connector supports multiple patterns, but the Entra ID-based options are the most reusable for enterprise design.
This use case walks through both the full certificate-based design and the simplified user-login option so you can choose intentionally.

### Step 1 — Choose the ServiceNow connector authentication method

The connector supports these four patterns:

| Method | Best fit | Notes |
|---|---|---|
| **Basic** | Fast lab validation | Useful for smoke tests, but rarely the production target. |
| **Entra ID OAuth (Certificate)** | Service-to-service or managed enterprise setup | Uses **App A** and **App B** plus a certificate. |
| **Entra ID User Login** | User-delegated setup with less ceremony | Uses the Microsoft 1P App ID `c26b24aa-7874-4e06-ad55-7d06b1f79b63` as **App B**. |
| **OAuth2 (ServiceNow native)** | Existing ServiceNow OAuth design | Useful if your ServiceNow team already standardized on native OAuth. |

1. Decide whether you want **delegated user access** or a **certificate-based app flow** for the lab.
2. If you are new to the connector, complete the certificate path once so you understand every moving part.
3. If time is limited for a workshop, use the **Entra ID User Login** option for the actual connection after you discuss the full pattern.

> 💡 **Tip:** Document *why* you chose the auth method. That decision affects connector ownership, support model, and how you explain security boundaries to reviewers.

### Step 2 — Register App A in Microsoft Entra ID

1. Open the Microsoft Entra admin center and create an app registration named something like:

```text
ServiceNow Representative App A
```

2. Configure token claims so ServiceNow receives the values it expects, especially `aud`, `email`, and `upn`.
3. Record the **tenant ID**, **client ID**, and any certificate thumbprints or secrets used during your chosen design.
4. Confirm that your organization allows the instance to trust Entra-issued tokens for this app.

> ⚠️ **Warning:** If the wrong claims are emitted, sign-in can appear to work while authorization inside ServiceNow still fails. Treat claim mapping as part of the identity contract, not optional polish.

### Step 3 — Register the OIDC provider in ServiceNow

1. In ServiceNow, navigate to **System OAuth** → **Application Registry**.
2. Select **New** and choose the option to **Configure an OIDC provider**.
3. Use this metadata URL format:

```text
https://login.microsoftonline.com/{tenantID}/.well-known/openid-configuration
```

4. Substitute your real tenant ID and complete the OIDC provider wizard.
5. Map the incoming identity claims to the ServiceNow user fields you want to trust, usually `email` or `user_name` plus `upn`.

> 💡 **Tip:** Create a screenshot checklist for the OIDC provider wizard. It becomes a lifesaver when you need to rebuild the design in production.

### Step 4 — Register App B and configure the connector client

1. For the certificate-based path, create a second Entra app registration such as:

```text
ServiceNow Connector Client App B
```

2. Upload the certificate you will use for connector authentication.
3. Grant the permissions required by the ServiceNow design and document who owns certificate rotation.
4. For the simplified **Entra ID User Login** path, note that the connector can use the Microsoft 1P App ID:

```text
c26b24aa-7874-4e06-ad55-7d06b1f79b63
```

5. Decide whether the workshop will demonstrate both paths or only the one your audience is most likely to implement.

### Step 5 — Create a ServiceNow system user and the Power Platform connection

1. In ServiceNow, create a dedicated **system user** if you want a non-human identity for connector testing.
2. Assign only the roles needed for the tables and actions used in the lab.
3. In Power Platform or Copilot Studio, start creating a new **ServiceNow** connection.
4. Select the auth method you prepared and paste the required tenant, client, and instance values.
5. Complete sign-in and confirm the connection status changes to **Connected**.

> ⚠️ **Warning:** If a browser pop-up shows `invalid_redirect_uri`, copy the encoded redirect URI, decode it, and add that exact value to the OAuth application registry entry in ServiceNow before retrying.

### Step 6 — Validate with a safe read operation first

1. Use the connection in a simple Power Automate test or connector test pane before you author the full agent.
2. Start with a read-only action such as **Get incident by number** or **List incidents**.
3. Confirm the returned payload contains the fields you expect, including caller, assignment group, state, and short description.
4. Only after read tests succeed should you move to create or update actions.

### Verification checklist

- You can explain the difference between Basic, Entra certificate, Entra user login, and ServiceNow native OAuth.
- App A is registered and the OIDC provider in ServiceNow points to the correct tenant metadata URL.
- App B or the Microsoft 1P App ID is selected intentionally for the connector path.
- A Power Platform ServiceNow connection completes and can execute at least one read action.

### Troubleshooting

- If sign-in loops or claims map incorrectly, verify the OIDC provider points to the correct tenant and not a copied sample value.
- If ServiceNow rejects the redirect URI, decode the URI shown in the error pop-up and register that exact value.
- If the connector never loads the instance, confirm the URL is in the supported `service-now.com` domain family.
- If actions return authorization errors, review the ServiceNow user's roles and the claim-to-user mapping.

### Challenge

- Implement the certificate-based method and the user-login method, then compare the user experience for connection creation.
- Document which pattern your security team would likely approve first and why.
- Design a minimal role set for a connector user that can read incidents and create incidents but cannot administer the platform.

### Key takeaways

- The full Entra ID pattern is more work up front, but it is easier to govern later.
- Redirect URI registration is a practical gotcha, not an edge case; expect to handle it.
- Testing a read action first reduces risk before you let an agent write to ServiceNow.

### Evidence to capture

- Screenshot of the Entra app registration overview for App A or App B.
- Screenshot of the ServiceNow OIDC provider configuration page.
- Screenshot of a successful connector test or Power Platform connection status.

### Stakeholder discussion prompts

- Who will own certificate rotation, application registration lifecycle, and connection renewal in production?
- Would your enterprise prefer user-delegated access or a shared service identity for ITSM operations?
- What audit evidence would the ServiceNow team require before enabling create or update actions?

### ✅ You've completed Use Case #2

You now have a secure, tested ServiceNow connection pattern that can be reused by Copilot Studio rather than a one-off experiment.

---

# 🧪 Use Case #3 — Build a ServiceNow-Connected Agent (25 min)

> 🎯 **Objective:** Add the ServiceNow connector as a tool, create lookup and creation behaviors, and shape the user experience for authenticated actions.

| | |
|---|---|
| **Goal** | Deliver an agent that can answer incident questions and create new tickets without leaving the Copilot experience. |
| **Outcome** | You have a Copilot Studio agent wired to ServiceNow actions and tested with realistic prompts. |
| **Why it matters** | This is the step where connector plumbing becomes business value. |

### Scenario

Your frontline users do not care how elegant the OAuth setup was.
They care whether the agent can find their ticket, create a new incident, and explain what happened next.
In this use case you turn the connection into a practical ITSM assistant with guardrails.

### Step 1 — Create or open the Copilot Studio agent

1. Open [Copilot Studio](https://copilotstudio.microsoft.com/) and create a new agent or reuse a workshop agent.
2. Give the agent a focused name such as:

```text
ServiceNow Support Agent
```

3. In the instructions, explain that the agent should help users search incidents, create incidents, and use ServiceNow knowledge where available.
4. Tell the agent to ask for missing details one at a time and to avoid promising updates it cannot verify from ServiceNow.

Suggested instruction starter:

```text
You are a support operations assistant. Help users look up ServiceNow incidents, create new incidents, and summarize next steps. Ask for the minimum information needed. Confirm the number, status, and assignment group when results are found. If information is missing or the action fails, explain what to do next instead of inventing a resolution.
```

### Step 2 — Add the ServiceNow tool

1. Open the agent's **Tools** area and select **Add a tool**.
2. Choose the **ServiceNow** connector from the tool catalog.
3. Reuse the connection you created in Use Case #2.
4. Add the read and write actions you want to expose, such as **list incidents**, **get incident**, and **create record**.
5. If the knowledge plugin is enabled, add one knowledge action as well so you can compare transactional and content-based answers.

> 💡 **Tip:** Keep the first version of the agent narrow. Three well-described actions usually outperform a cluttered toolset of fifteen actions.

### Step 3 — Describe the tools so orchestration can choose well

1. Edit each tool description so the planner understands when to call it.
2. Include the business boundary, expected inputs, and what the action returns.
3. Add negative guidance where helpful, for example: do not create an incident when the user only wants a status update.

Example description for a lookup action:

```text
Use this action when the user provides a ServiceNow incident number or asks for incident status. Returns short description, caller, state, priority, and assignment details. Do not use this action to create new records.
```

### Step 4 — Build the core conversation paths

1. Create one topic or instruction pattern for **incident lookup**.
2. Create one topic or instruction pattern for **incident creation**.
3. For lookup, require the incident number before calling the action.
4. For creation, collect at minimum the short description, impact or urgency, contact method, and any location context your service desk needs.
5. After the create action returns, echo back the new record number and set expectations on follow-up.

Prompt ideas for testing:

```text
Check the status of INC0010102.
Create a new incident for a triage workstation that freezes whenever I print labels.
Find a knowledge article for resetting a VPN token.
```

### Step 5 — Handle authentication and graceful failure

1. Decide whether the connector action should run under the maker's connection or the signed-in user's connection.
2. Tell the agent how to respond if the user must authenticate before a tool can run.
3. Add a short fallback message for common failures such as missing incident number, access denied, or no matching record.
4. Test one success path and one failure path for each action.

> ⚠️ **Warning:** Connector actions can fail for identity reasons that look like business errors. Always differentiate **record not found** from **you are not authorized** in the user experience.

### Step 6 — Test end to end in the Copilot Studio pane

1. Start a new test chat session to avoid old context influencing the planner.
2. Ask for a known incident and confirm the response includes record-backed details.
3. Create a new incident from the agent and verify the record appears in ServiceNow.
4. Trigger one intentional failure, such as an invalid ticket number, and inspect how the tool path appears in the activity map.

### Verification checklist

- The agent has at least one lookup action and one create action connected to ServiceNow.
- A lookup prompt returns real incident data from the PDI.
- A create prompt successfully generates a new ServiceNow record.
- The agent distinguishes user guidance for missing data versus access problems.

### Troubleshooting

- If the planner does not select the tool, strengthen the tool description and the topic description with clearer usage boundaries.
- If the create action fails, inspect required ServiceNow fields that may not be obvious from the connector UI.
- If knowledge lookups fail while incident actions work, revisit plugin activation and the actions you added.
- If responses sound confident but omit record details, verify the tool actually executed in the activity map.

### Challenge

- Add a branch that asks whether the user wants to attach a business impact statement before incident creation.
- Create a short summary card or formatted response that shows number, state, priority, assignment group, and next step.
- Design a topic that converts a knowledge answer into a ticket only if the user says the article did not solve the issue.

### Key takeaways

- Tool descriptions are as important as the connection itself.
- Incident lookup and creation are separate experiences and deserve separate prompts and checks.
- Testing failure paths early prevents misleading user trust later.

### Evidence to capture

- Screenshot of the configured ServiceNow tools list in Copilot Studio.
- Transcript excerpt showing a successful incident lookup.
- Screenshot of the new incident created from the chat flow.

### Stakeholder discussion prompts

- Which ServiceNow fields should be mandatory before a ticket is created from chat in your organization?
- Should the agent ever auto-create incidents, or should it always confirm first?
- How should handoff to a live agent or service desk team appear after ticket creation?

### ✅ You've completed Use Case #3

You now have a functioning ITSM copilot pattern that can read and write real ServiceNow records instead of staying trapped in a demo script.

---

# 🧪 Use Case #4 — Enable SSO Between Copilot Studio and ServiceNow (15 min)

> 🎯 **Objective:** Configure Copilot Studio single sign-on so users authenticate once, understand supported channels, and reduce repeated sign-in friction.

| | |
|---|---|
| **Goal** | Move from a manually authenticated demo to an enterprise-ready sign-in story. |
| **Outcome** | You know the five-step SSO pattern for Copilot Studio and how it intersects with downstream ServiceNow access. |
| **Why it matters** | A good integration still fails adoption if users are repeatedly prompted to sign in. |

### Scenario

Your pilot works, but testers complain that they already signed in to Teams or the custom website and still get extra prompts.
Copilot Studio SSO solves that at the agent layer when you follow the documented pattern and use a supported channel.
This use case focuses on the planning and configuration checkpoints that make SSO dependable.

### Step 1 — Confirm your channel supports SSO

Supported channels for the documented Entra ID SSO pattern include:

- **Custom Website**
- **Teams**
- **SharePoint**
- **Omnichannel**

Not supported for this pattern:

- **Facebook**
- **Mobile App**
- **Azure Bot Service**
- **Demo Website**
- **Power Pages**

1. Decide which supported channel will host the pilot.
2. Confirm the same channel will be used during user acceptance testing so you do not validate the wrong path.

> ⚠️ **Warning:** Do not assume the test canvas proves SSO behavior. Validate on the real hosting channel.

### Step 2 — Follow the five high-level SSO steps in Copilot Studio

1. **Enable manual authentication** for the agent.
2. **Create the authentication app registration** in Entra ID.
3. **Create the canvas app registration** used by the client-side host experience.
4. **Define the custom scope and Token Exchange URL** exactly as required by the SSO documentation.
5. **Configure the client-side code** in the supported channel so the signed-in user token is handed to the agent correctly.

### Step 3 — Map the SSO design to your ServiceNow connector strategy

1. Decide whether the downstream ServiceNow action should execute with the signed-in user's identity or a shared connection.
2. If you use delegated user access, make sure the ServiceNow side can map that user consistently.
3. If you use a shared system connection, explain clearly to users what data is still filtered by the app experience versus by ServiceNow roles.
4. Document where a second sign-in could still happen and whether that is acceptable for the pilot.

> 💡 **Tip:** SSO to the agent and delegated access to the downstream connector are related but not identical. Treat them as two linked design decisions.

### Step 4 — Test seamless access

1. Sign in to the supported host channel as a normal pilot user.
2. Launch the agent and ask for an action that requires authentication.
3. Verify whether the action runs without an extra prompt.
4. Test a second user with different permissions to confirm authorization changes are respected.

Suggested validation prompts:

```text
Show my incident INC0010101.
Create a ticket for my kiosk login problem.
Find the knowledge article for password reset.
```

### Step 5 — Capture the residual sign-in and support story

1. Write down exactly where users still might see an auth prompt, if anywhere.
2. Add troubleshooting guidance for expired sessions, permission errors, and unsupported channels.
3. Decide what your help desk will say if a user launches the agent from an unsupported host experience.
4. Create a simple pilot FAQ for sign-in expectations.

### Verification checklist

- You can state which channels support the Copilot Studio SSO pattern and which do not.
- The five SSO configuration steps are documented for your team.
- A supported host channel is selected for pilot testing.
- You have a clear explanation for whether downstream ServiceNow actions run as the user or a shared identity.

### Troubleshooting

- If SSO works in one host but not another, confirm the failing host is actually supported by the documented pattern.
- If the user still sees a prompt, inspect the client-side code and the custom scope/token exchange configuration first.
- If the agent is authenticated but the connector prompts, revisit whether the ServiceNow connection is delegated or shared.
- If authorization differs between users, that may be correct behavior; verify permissions instead of assuming the configuration is broken.

### Challenge

- Create a one-page pilot support guide that distinguishes authentication failures from authorization failures.
- List the pros and cons of delegated ServiceNow access versus a shared service connection in your environment.
- Plan a test matrix covering Teams, SharePoint, and one unsupported host so your stakeholders understand the boundaries.

### Key takeaways

- SSO is a user-experience capability and a security architecture decision at the same time.
- Supported hosting channels matter as much as the app registration steps.
- Downstream connector identity still needs explicit design even when the agent itself supports SSO.

### Evidence to capture

- Screenshot of the host channel where the pilot will run.
- Configuration notes or screenshots for the app registrations and token exchange values.
- Transcript excerpt showing a successful authenticated action from the supported host.

### Stakeholder discussion prompts

- Which host channel will drive the most adoption for this ServiceNow scenario in your company?
- Does the business need full per-user ServiceNow authorization, or is a shared support queue identity acceptable?
- What user-facing language should explain why some hosts support seamless sign-in and others do not?

### ✅ You've completed Use Case #4

You now have a practical SSO plan that makes the ServiceNow-enabled agent feel like part of the employee workflow instead of a disconnected extra sign-in surface.

---

# 🙋 Summary

### What you accomplished

| Step | What you did |
|---|---|
| **Prepare** | Provisioned a ServiceNow PDI and seeded realistic incident and knowledge data |
| **Secure** | Configured an Entra-backed OAuth pattern for the ServiceNow connector |
| **Build** | Added ServiceNow tools to a Copilot Studio agent and tested read/write scenarios |
| **Improve adoption** | Planned SSO so users can launch the agent from supported channels with less friction |

### Why this matters in the real world

- ITSM copilots deliver value only when they can work inside the real incident system, not beside it.
- Modern authentication and SSO are adoption enablers as much as security requirements.
- Testing with a free PDI helps you surface connector, plugin, and redirect issues before you involve production admins.

### 🪙 Golden rules

1. Start with a narrow ServiceNow scope: one or two read actions and one create action beat an overloaded toolset.
2. Treat OAuth claims, redirect URIs, and role mapping as part of the business solution, not low-level plumbing.
3. Always test a read-only action before you allow the agent to create or update records.
4. Enable the `sn_km_api` plugin early if knowledge scenarios matter to your pilot.
5. Differentiate authentication failure, authorization failure, and record-not-found in the user experience.
6. Validate SSO only in supported host channels; the test canvas is not the final truth for sign-in behavior.

### Recommended next steps

- Wrap a ServiceNow create action inside a Power Automate approval flow for higher-risk request types.
- Add post-ticket notifications to Teams or email once incident creation works reliably.
- Expand from incidents to change requests, catalog items, or knowledge workflows only after the core pattern is stable.

> 🔐 **Final thought:** The best ServiceNow copilot is not the one with the most actions; it is the one your security team trusts and your employees actually use.

