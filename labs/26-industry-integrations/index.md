# 🏭 Lab 17: Industry-Specific 3rd Party Integrations

*Design Copilot Studio integrations that respect the realities of healthcare, finance, retail, manufacturing, public sector, and technology ecosystems.*

## Metadata

| | |
|---|---|
| ⭐ **DIFFICULTY** | Advanced (Level 300) |
| ⏱️ **TIME** | 2 hours |
| 🧩 **PRODUCTS** | Microsoft Copilot Studio, Various 3rd Party Connectors, Power Automate, Custom Connectors |
| 🏷️ **TAGS** | Healthcare, Financial Services, Retail, Manufacturing, Public Sector, Epic, SAP, Shopify, Jira, FHIR |
| 🏭 **INDUSTRY** | Multi-industry |

---

## 🗺️ Lab Flow

```mermaid
flowchart LR
  A["Pick industry scenario"] --> B["Choose auth model"]
  B --> C["Choose connector pattern"]
  C --> D["Add tool or flow"]
  D --> E["Design topic"]
  E --> F["Apply compliance guardrails"]
  F --> G["Validate with sample prompts"]
```

---

## ⚡ Why this lab matters

Copilot Studio is not one market.
It is a platform.
What makes a great agent in healthcare is not the same thing that makes a great agent in retail or public sector.
Different industries use different systems,
different auth models,
different compliance controls,
and different licensing assumptions.

This lab helps you move beyond generic “connect an API” thinking.
Instead, you will practice how to choose connector types, OAuth patterns, trial environments, and topic designs that fit real industry platforms.
You will also learn where no certified connector exists and a **custom connector** is mandatory.
That matters a lot in sectors such as healthcare and manufacturing, where critical systems often expose standards-based APIs but not Power Platform-friendly connector packages.

The goal is not to memorize one integration per industry.
The goal is to build your architectural judgment.
When a customer says “we use Epic,”
“we need SAP,”
“we are in GCC,”
or “our developers live in Jira and GitHub,”
you should know what to ask next,
which pattern to recommend,
and which compliance constraints to surface early.

---

## 🌍 Real-world example

A systems integrator is designing six Copilot Studio pilots for six customers.
A hospital wants patient lookup over Epic FHIR.
A bank wants financial data surfaced from SAP BTP APIs.
A retailer wants order and inventory support through Shopify.
A manufacturer wants machine alerts through PTC ThingWorx.
A county government wants citizen inquiries routed into Tyler or Salesforce Government Cloud.
A software company wants development-support agents that speak Jira and GitHub.

The integrator cannot use one universal pattern.
Healthcare needs SMART on FHIR OAuth and HIPAA guardrails.
Public sector needs cloud-boundary awareness and FedRAMP-aligned planning.
Technology teams care about token models and connector cost.
This lab walks through one scenario per industry so you can see those differences in practice.

---

## 🎯 Objectives

By the end of this lab you will be able to:

1. ✅ Choose between prebuilt connectors, custom connectors, and flow-based integration patterns per industry.
2. ✅ Explain why Epic and Cerner/Oracle Health typically require custom connectors against FHIR APIs.
3. ✅ Design a SAP integration strategy for financial or manufacturing scenarios without assuming the Logic Apps SAP connector is available in Power Apps or Copilot Studio.
4. ✅ Use the Shopify connector for common retail operations.
5. ✅ Design custom API patterns for industrial and IoT systems.
6. ✅ Recognize GCC and government-cloud limitations that affect public sector integrations.
7. ✅ Combine Jira and GitHub into practical developer-support scenarios.
8. ✅ Document licensing, trial setup, authentication, topic patterns, and compliance notes for each industry.

---

## 🧠 Core concepts overview

| Concept | What it means in this lab |
|---|---|
| **FHIR R4** | The healthcare interoperability standard commonly used for patient, encounter, and observation APIs. |
| **SMART on FHIR** | OAuth-based authorization pattern used by many healthcare APIs such as Epic and Cerner/Oracle Health. |
| **Premium connector** | A connector that generally requires premium licensing, important for Salesforce, Jira, Shopify, and many custom connectors. |
| **Custom connector** | The default answer when a critical industry platform has an API but no usable certified connector. |
| **API token auth** | Common in developer tools such as Jira, where an API token often replaces a password. |
| **Government cloud boundary** | The cloud environment limitations that determine whether a connector or SaaS service is appropriate for public sector tenants. |
| **Intermediary pattern** | A design where you place a compliant API façade, integration service, or Azure-hosted broker between Copilot Studio and the source system. |
| **Topic pattern** | The conversation flow that translates a user request into a constrained connector call and a safe response. |

---

## 📚 Documentation

- [Custom connectors overview](https://learn.microsoft.com/en-us/connectors/custom-connectors/)
- [Authenticate your API and connector with Microsoft Entra ID](https://learn.microsoft.com/en-us/connectors/custom-connectors/azure-active-directory-authentication)
- [Create a custom connector from an OpenAPI definition](https://learn.microsoft.com/en-us/connectors/custom-connectors/define-openapi-definition)
- [Shopify connector reference](https://learn.microsoft.com/en-us/connectors/shopify/)
- [Jira connector reference](https://learn.microsoft.com/en-us/connectors/jira/)
- [GitHub connector reference](https://learn.microsoft.com/en-us/connectors/github/)
- [Configure single sign-on with Microsoft Entra ID in Copilot Studio](https://learn.microsoft.com/en-us/microsoft-copilot-studio/configure-sso)
- [Azure Health Data Services documentation](https://learn.microsoft.com/en-us/azure/healthcare-apis/)

---

## ✅ Prerequisites

- Access to Copilot Studio and a Power Platform environment that supports premium connectors.
- Permission to create or use custom connectors and app registrations where needed.
- At least one safe test tenant, developer sandbox, or trial account for the target third-party platform.
- A clear data-minimization policy for what the agent may return in chat.
- Approval to work only with nonproduction or masked sample data for regulated scenarios.

> ⚠️ **Important:** Industry demos become risky fast if you use real PHI, PCI, CJIS, or production citizen data.
Use synthetic or masked data for labs.

### Cross-industry licensing quick reference

| Integration type | Typical licensing implication |
|---|---|
| Custom connector | Premium licensing required in most Power Platform scenarios |
| Salesforce-based connectors | Often premium |
| Jira connector | Premium |
| GitHub connector | Standard / included in many Microsoft 365 contexts |
| Shopify connector | Premium |
| SAP enterprise connector paths | Often enterprise-tier or custom integration work |

---

## 🗺️ Use cases covered

| # | Use Case | What you will do | Time |
|---|---|---|---|
| 1 | Healthcare: Epic / FHIR | Design a SMART on FHIR custom connector and patient lookup topic | 20 min |
| 2 | Financial Services: SAP | Use SAP BTP or S/4HANA APIs through a custom connector | 20 min |
| 3 | Retail: Shopify | Use the certified connector for order and inventory scenarios | 20 min |
| 4 | Manufacturing: IoT data | Connect to PTC ThingWorx or Azure-hosted operational APIs with custom connectors | 20 min |
| 5 | Public Sector: Citizen services | Evaluate Salesforce Government Cloud and Tyler patterns with GCC considerations | 20 min |
| 6 | Technology: Jira and GitHub | Combine premium and standard developer-tool connectors in one support scenario | 20 min |

---

# 🧪 Use Case #1 — Healthcare: Epic / FHIR Integration

> 🎯 **Objective:** Design a healthcare-safe patient lookup pattern by using a custom connector against FHIR R4 APIs and SMART on FHIR OAuth.

### Scenario

A hospital wants a Copilot Studio assistant for care coordinators.
There is no certified Epic or Cerner connector for this use case.
The integration must rely on FHIR R4 APIs and a healthcare-specific OAuth pattern.

### Step 1 — Set up a trial or sandbox path

1. Request access to an Epic sandbox such as the public developer resources at **fhir.epic.com** when available for testing.
2. If Epic is not available, use another FHIR sandbox or synthetic dataset.
3. Consider **Azure Health Data Services** as an intermediary when direct EHR coupling is too complex for the first pilot.

### Step 2 — Configure authentication

1. Use **SMART on FHIR OAuth** rather than a generic API key pattern.
2. Register the app with the healthcare platform.
3. Capture scopes such as patient read permissions appropriate for the use case.
4. Document token audience, redirect URI, and user-consent behavior.

### Step 3 — Build the connector configuration

1. Create a **custom connector** from an OpenAPI 2.0 document that wraps the relevant FHIR endpoints.
2. Start narrowly with endpoints such as:
   - Patient search.
   - Encounter lookup.
   - Observation summary.
3. Normalize the parameter names so clinicians or analysts do not see raw API jargon.
4. Hide write operations during the first pilot.

### Step 4 — Create the Copilot Studio topic

1. Build a topic called **Find patient care summary**.
2. Ask for the patient MRN or another approved identifier.
3. Call the patient lookup action.
4. Return a safe summary such as patient demographics, recent encounter date, or non-sensitive care-team context as approved.
5. Never echo access tokens, raw identifiers beyond need, or unsupported clinical detail in general chat.

> 💡 **Tip:** Start with read-only demographics or scheduling-adjacent scenarios before attempting richer clinical summaries.

> ⚠️ **Warning:** A chat response that contains too much patient detail can create privacy and retention concerns even if the API call itself was allowed.

#### Sample Copilot Studio topic starter

```text
When a care coordinator asks for a patient summary, collect the approved patient identifier, retrieve the patient and recent encounter data through the FHIR connector, summarize only the allowed fields, and remind the user that the response is for care coordination support and not a diagnostic record.
```

### Licensing requirements

| Item | Guidance |
|---|---|
| Power Platform custom connector | Premium licensing required |
| Copilot Studio | Tenant and user licensing apply |
| Epic / FHIR sandbox | Depends on partner program or customer agreement |
| Azure Health Data Services intermediary | Azure consumption charges apply if used |

### Compliance notes

- Treat **HIPAA** and local privacy laws as first-class design constraints.
- Use least-privilege scopes.
- Minimize PHI returned into chat.
- Consider whether transcript retention must be restricted.

### Troubleshooting

- If auth works but data is denied, verify SMART scopes and patient-context requirements.
- If the API feels too raw, place an intermediary API in Azure that simplifies the FHIR contract before exposing it to makers.
- If compliance reviewers object to direct EHR chat access, narrow the scenario to scheduling or care-team lookup first.

### Challenge

Design a second topic for **appointment preparation** that shows only scheduling and location details, not broader clinical history.
Explain why that narrower scope may be easier to approve.

### ✅ You've completed Use Case #1

You now have a realistic pattern for healthcare interoperability without assuming a nonexistent certified connector.

---

# 🧪 Use Case #2 — Financial Services: SAP Integration

> 🎯 **Objective:** Build a finance-friendly SAP pattern by using SAP BTP or S/4HANA APIs through a custom connector rather than assuming the Logic Apps SAP connector is available everywhere.

### Scenario

A bank wants a Copilot Studio agent that can answer questions about payment status, general ledger exceptions, or customer onboarding tasks.
The source system is SAP.
The team initially assumes the SAP connector used in Logic Apps will appear directly in Power Apps and Copilot Studio.
It does not.

### Step 1 — Set up a trial or sandbox path

1. Request a SAP sandbox or BTP developer access from the customer or partner team.
2. Identify the actual API surface you can call:
   - SAP BTP OData APIs.
   - S/4HANA REST or OData services.
3. Avoid designing against screenshots or static docs alone.
Test the real endpoint behavior early.

### Step 2 — Configure authentication

1. Determine whether the SAP API uses OAuth,
   basic auth behind an approved proxy,
   or another enterprise token pattern.
2. Prefer OAuth or an enterprise identity broker where possible.
3. Document token lifetime, network requirements, and service-account ownership.

### Step 3 — Build the connector configuration

1. Create a **custom connector** for the SAP API surface.
2. Wrap only the business operations the agent truly needs, such as:
   - Get payment exception by ID.
   - List pending approvals.
   - Retrieve invoice summary.
3. Simplify complex SAP response bodies into cleaner objects where possible.
4. If the source API is too complex, use a middleware façade.

### Step 4 — Create the Copilot Studio topic

1. Build a topic called **Check payment exception**.
2. Ask for the payment or document number.
3. Call the SAP connector.
4. Summarize the status, owner, and next action.
5. Never expose raw financial payloads or sensitive fields not needed in the conversation.

> 💡 **Tip:** Many SAP programs succeed faster when they expose a narrow finance-specific façade API instead of handing the agent a giant raw SAP contract.

> ⚠️ **Warning:** Even “read-only” finance data can trigger audit concerns if account numbers, balances, or exception reasons are overexposed in chat transcripts.

#### Sample Copilot Studio topic starter

```text
When a finance operations user asks about a payment exception, collect the document identifier, call the SAP finance connector, summarize the current exception status, owner, due date, and next action, and avoid returning raw ledger lines unless the user is authorized and specifically requests them.
```

### Licensing requirements

| Item | Guidance |
|---|---|
| Power Platform custom connector | Premium licensing required |
| SAP API access | Depends on customer SAP licensing and API exposure strategy |
| Middleware or APIM layer | Additional platform cost if used |
| Copilot Studio | Standard tenant and user licensing considerations apply |

### Compliance notes

- Treat **PCI-adjacent** or financial data controls seriously even if the exact dataset is not cardholder data.
- Limit transcript exposure of account numbers or settlement details.
- Use approval workflows for actions that could change financial state.

### Troubleshooting

- If stakeholders insist on the Logic Apps SAP connector, explain that this lab focuses on Copilot Studio and Power Platform runtime options, where **custom connectors against SAP APIs** are often the practical path.
- If SAP responses are too complex, do not force the agent to parse everything; simplify upstream.
- If auth is brittle, review whether the integration should be brokered through an enterprise API layer.

### Challenge

Add a second topic for **invoice approval status** and explain whether it should remain read-only or trigger an approval flow instead of a direct action.

### ✅ You've completed Use Case #2

You now have a more realistic SAP integration approach for finance-focused Copilot Studio scenarios.

---

# 🧪 Use Case #3 — Retail: Shopify Integration

> 🎯 **Objective:** Use a certified retail connector to create fast value for order lookup and inventory support scenarios.

### Scenario

A retailer wants a customer-service assistant that checks order status and product inventory.
Unlike some other industries, retail often has strong SaaS APIs and usable certified connectors.
Shopify is a good example.

### Step 1 — Set up a trial or sandbox path

1. Create or obtain a **Shopify** development store.
2. Populate a few sample orders and products.
3. Create a test account with limited support permissions.

### Step 2 — Configure authentication

1. Use the **Shopify connector** and complete the OAuth setup required by the connector.
2. Decide whether each support user authenticates individually or whether a shared service connection is acceptable for the support desk model.
3. Document rate limits and app scopes.

### Step 3 — Build the connector configuration

1. Add the certified Shopify connector to the environment.
2. Create or reuse a connection.
3. Expose actions such as:
   - Get order.
   - List products.
   - Check inventory.
4. If the raw connector operations are too broad, wrap them in a flow that returns a cleaner summary.

### Step 4 — Create the Copilot Studio topic

1. Build a topic called **Check order and inventory**.
2. Ask for the order number or SKU.
3. Call the appropriate Shopify action.
4. Return fulfillment status, shipping state, or stock availability.
5. Suggest the next best support action.

> 💡 **Tip:** Retail support scenarios usually become more useful when the answer includes one recommended next action, not just raw order facts.

> ⚠️ **Warning:** Refund, cancellation, and address-change actions should usually be separated from simple lookup topics until approval and fraud controls are clear.

#### Sample Copilot Studio topic starter

```text
When a retail support user asks about an order or inventory, collect the order number or product SKU, retrieve the order or stock details from Shopify, summarize the status in plain language, and recommend whether the user should reassure the customer, escalate to fulfillment, or propose an alternative product.
```

### Licensing requirements

| Item | Guidance |
|---|---|
| Shopify connector | Premium connector licensing applies |
| Shopify dev store | Use Shopify partner or development-store options |
| Copilot Studio | Tenant and user licensing apply |
| Optional flow wrapper | Premium flow licensing may also apply depending on design |

### Compliance notes

- Treat customer contact details as personal data.
- Do not return full payment artifacts in chat.
- Align responses with order-management and refund policy.

### Troubleshooting

- If the connector works but the agent returns too much detail, use a flow wrapper or topic logic to reduce the response.
- If support users need broader actions, separate read-only lookup topics from action-taking topics.
- If the retailer wants omnichannel scale, test the experience in the actual support channel early.

### Challenge

Extend the topic so it suggests one alternative in-stock product when the requested SKU is unavailable.
Explain whether that logic belongs in the agent, a flow, or an external recommendation API.

### ✅ You've completed Use Case #3

You now have a practical retail integration pattern that delivers quick operational value.

---

# 🧪 Use Case #4 — Manufacturing: IoT Data with Custom APIs

> 🎯 **Objective:** Surface industrial telemetry safely by using custom connectors against IoT or machine-data APIs such as PTC ThingWorx or Azure-hosted operational APIs.

### Scenario

A manufacturer wants supervisors to ask an agent for machine temperature, downtime, or alert summaries.
The source platform might be **PTC ThingWorx**,
custom plant APIs,
or Azure-hosted services that aggregate IoT data.
There is rarely a perfect off-the-shelf connector for the exact factory schema.

### Step 1 — Set up a trial or sandbox path

1. Obtain a **PTC ThingWorx** sandbox or a sample Azure-hosted telemetry API.
2. Seed sample machine, line, or sensor data.
3. Define a narrow nonproduction dataset that contains no sensitive production formulas or trade secrets.

### Step 2 — Configure authentication

1. Determine whether the platform uses API keys,
   OAuth,
   or a custom identity pattern.
2. Prefer OAuth or token-based access where possible.
3. Keep plant-floor credentials out of the agent project itself.

### Step 3 — Build the connector configuration

1. Create a **custom connector** for the telemetry API.
2. Start with low-risk read operations such as:
   - Get line health summary.
   - Get machine temperature.
   - List active alerts.
3. Normalize units and timestamps so the responses are consistent.
4. Filter high-volume event streams before they reach Copilot Studio.

### Step 4 — Create the Copilot Studio topic

1. Build a topic called **Check machine health**.
2. Ask for the machine ID or production line.
3. Call the telemetry connector.
4. Summarize the latest readings and active alerts.
5. Suggest whether the supervisor should inspect, schedule maintenance, or escalate.

> 💡 **Tip:** Supervisors usually need a concise exception summary, not a firehose of raw telemetry points.

> ⚠️ **Warning:** Do not let a first-release chat agent send machine-control commands unless your safety and engineering review explicitly approve it.

#### Sample Copilot Studio topic starter

```text
When a supervisor asks about a machine or production line, collect the approved asset identifier, retrieve current telemetry and active alerts from the manufacturing API, summarize the health state and recommended next step, and avoid exposing raw event floods or unsupported maintenance instructions.
```

### Licensing requirements

| Item | Guidance |
|---|---|
| Power Platform custom connector | Premium licensing required |
| PTC ThingWorx or custom IoT platform | Depends on customer platform licensing |
| Azure-hosted intermediary APIs | Azure consumption charges may apply |
| Copilot Studio | Tenant and user licensing apply |

### Compliance notes

- Protect proprietary production data and line-performance metrics.
- Avoid letting the agent trigger machine-control actions in the first release.
- Review worker safety implications before the agent gives maintenance-style guidance.

### Troubleshooting

- If telemetry is too noisy, aggregate upstream before exposing it to the connector.
- If supervisors want trend analysis, consider whether the result should come from a flow or analytics service instead of the raw API.
- If network latency to plant systems is high, add caching or an intermediary service.

### Challenge

Design a second topic that compares **two lines** over the last shift.
Decide whether the comparison should happen in Copilot Studio, in a flow, or in an external analytics endpoint.

### ✅ You've completed Use Case #4

You now have a manufacturing integration pattern that respects both operational reality and safety concerns.

---

# 🧪 Use Case #5 — Public Sector: Citizen Services Portal

> 🎯 **Objective:** Design a public-sector-safe pattern using Salesforce Government Cloud or Tyler Technologies APIs while accounting for GCC limitations and compliance review.

### Scenario

A county agency wants a citizen-services assistant.
Some cases live in **Salesforce Government Cloud**.
Other records live in **Tyler Technologies** systems such as Munis or New World.
The tenant also has government-cloud constraints.

### Step 1 — Set up a trial or sandbox path

1. Confirm whether the customer uses **GCC**, **GCC High**, or another government environment.
2. For Salesforce scenarios, verify whether the target connector pattern is appropriate for the cloud boundary.
3. For Tyler scenarios, obtain a test API endpoint or synthetic API façade.
4. Avoid public demos with real citizen records.

### Step 2 — Configure authentication

1. For Salesforce Government Cloud, use the supported enterprise auth pattern for that tenant and verify cloud compatibility.
2. For Tyler or municipal APIs, determine whether OAuth,
   API key,
   or another approved auth model is available.
3. Record data-residency and identity-boundary assumptions early.

### Step 3 — Build the connector configuration

1. Use a **Salesforce-based connector** when the tenant and connector support line up.
2. Use a **custom connector** for Tyler Technologies or municipal REST APIs.
3. Expose narrow operations such as:
   - Look up permit status.
   - Retrieve case summary.
   - Check citizen-request status.
4. Keep write actions out of the first pilot unless there is strong approval workflow.

### Step 4 — Create the Copilot Studio topic

1. Build a topic called **Check citizen request status**.
2. Ask for the case number or permit number.
3. Call the appropriate connector.
4. Return the current status, responsible department, and next expected step.
5. Use citizen-safe language and avoid unnecessary internal comments.

> 💡 **Tip:** Citizen-facing scenarios are easier to approve when they focus on status transparency rather than discretionary case actions.

> ⚠️ **Warning:** Public sector deployments often fail at the cloud-boundary review stage, not at the connector stage, so confirm tenant and compliance fit early.

#### Sample Copilot Studio topic starter

```text
When a citizen services agent asks for the status of a permit, case, or municipal request, collect the request identifier, retrieve the approved summary from the government system, explain the current stage and next step in plain language, and avoid exposing sensitive internal routing notes.
```

### Licensing requirements

| Item | Guidance |
|---|---|
| Salesforce Government Cloud connector path | Premium licensing typically applies and tenant compatibility must be verified |
| Tyler custom connector | Premium licensing required |
| Government cloud hosting constraints | May affect connector and channel choices |
| Copilot Studio | Tenant and user licensing apply |

### Compliance notes

- Review **FedRAMP**, CJIS-adjacent, state, and agency-specific requirements as applicable.
- Verify whether the target SaaS is supported in the customer's government cloud boundary.
- Limit transcript retention and internal-note exposure.

### Troubleshooting

- If the desired SaaS is not supported in the target government cloud, stop and redesign rather than forcing parity with commercial cloud.
- If agencies want public access, clarify whether the channel and auth pattern are acceptable in the compliance model.
- If multiple systems are involved, use a flow or intermediary API to unify the citizen-safe response.

### Challenge

Design a decision tree that tells the team when to use **Salesforce Government Cloud** directly,
when to wrap **Tyler APIs** with a custom connector,
and when to place a compliant intermediary service in front of both.

### ✅ You've completed Use Case #5

You now have a public-sector integration pattern that surfaces cloud-boundary and citizen-data concerns early.

---

# 🧪 Use Case #6 — Technology: Jira & GitHub DevOps

> 🎯 **Objective:** Combine a premium developer-tool connector and a standard connector into a practical DevOps support experience.

### Scenario

A software company wants an engineering support agent.
It should check **Jira** incident work items and **GitHub** pull request status.
This industry is interesting because the APIs are mature, but auth and licensing still differ.

### Step 1 — Set up a trial or sandbox path

1. Create a Jira test project.
2. Create a GitHub repository with sample issues and pull requests.
3. Use a nonproduction engineering workspace for the pilot.

### Step 2 — Configure authentication

1. For **Jira**, use the connector's supported auth pattern and remember that **API token auth** is used instead of a password for many setups.
2. For **GitHub**, configure the standard connector with the required repository permissions.
3. Decide whether each engineer uses their own connection or whether a service connection is acceptable for the support bot.

### Step 3 — Build the connector configuration

1. Add the **Jira** premium connector.
2. Add the **GitHub** standard connector.
3. Expose only the operations the support scenario needs, such as:
   - Get issue.
   - Search issues by key.
   - Get pull request.
   - List pull requests for a repo.
4. If needed, wrap both in a Power Automate flow so the agent receives one consolidated payload.

### Step 4 — Create the Copilot Studio topic

1. Build a topic called **Check incident and PR status**.
2. Ask for the Jira key, GitHub PR number, or incident identifier.
3. Retrieve the linked work item and PR state.
4. Summarize blockers, reviewers, and suggested next action.
5. Keep the answer concise enough for support engineers to act quickly.

> 💡 **Tip:** DevOps users usually value a concise blocker summary more than a long reproduction of every ticket field.

> ⚠️ **Warning:** Avoid exposing private repository names, security findings, or privileged incident notes to users who do not need them.

#### Sample Copilot Studio topic starter

```text
When an engineer asks for the status of a Jira issue, incident, or GitHub pull request, collect the work item identifier, retrieve the linked ticket and repository details, summarize blockers and review status, and suggest whether the engineer should merge, request review, reopen the issue, or escalate the incident.
```

### Licensing requirements

| Item | Guidance |
|---|---|
| Jira connector | Premium licensing required |
| GitHub connector | Standard connector and often a lower-friction option |
| Power Automate flow wrapper | May require premium licensing depending on other connectors used |
| Copilot Studio | Tenant and user licensing apply |

### Compliance notes

- Protect internal repository names and security-sensitive issue content.
- Separate engineering-support topics from privileged production-access topics.
- Review whether code-scanning or vulnerability details should be summarized in chat.

### Troubleshooting

- If Jira auth fails, confirm the API token pattern and connector documentation rather than trying a normal password.
- If GitHub data returns but Jira does not, test the connectors independently before debugging the combined topic.
- If the response becomes too verbose, have a flow or API wrapper consolidate the result into a support-friendly summary.

### Challenge

Extend the pattern so one topic can answer:
“What Jira incident is linked to PR 214, and is it ready to merge?”
Explain whether the correlation logic belongs in Copilot Studio,
a flow,
or an external service.

### ✅ You've completed Use Case #6

You now have a technology-industry pattern that balances licensing, auth, and developer workflow reality.

---

## ✅ Validation

Use this checklist to validate your cross-industry integration design outputs:

- Each industry use case has a documented connector pattern (prebuilt, custom, or intermediary).
- Authentication model is defined per scenario (for example SMART on FHIR OAuth, SAP OAuth/client credentials, Jira token).
- Licensing assumptions are captured (premium vs standard where applicable).
- Compliance constraints and safe-data boundaries are explicitly stated for each design.
- Topic prompt starter exists and is scoped to least-privilege, read-first behavior.

# 🙋 Summary

### What you accomplished

| Step | What you did |
|---|---|
| **Healthcare** | Designed a SMART on FHIR custom connector pattern |
| **Financial Services** | Built a realistic SAP API strategy for Copilot Studio |
| **Retail** | Applied a certified Shopify connector for support operations |
| **Manufacturing** | Exposed IoT telemetry through custom APIs safely |
| **Public Sector** | Evaluated citizen-services integrations with cloud-boundary awareness |
| **Technology** | Combined Jira and GitHub into a practical DevOps support scenario |

### Golden rules

1. **Do not assume a certified connector exists.** Many critical industry systems still require custom connectors.
2. **Start with the API contract and auth model.** The connector choice follows from those realities.
3. **Keep the first topic narrow.** Read-only lookups are easier to secure and approve than write operations.
4. **Use intermediaries when the source API is too raw or too sensitive.** Simplify upstream where needed.
5. **Treat industry compliance as a design input, not a postscript.** HIPAA, PCI, FedRAMP, and sector rules shape the architecture.
6. **Separate demo data from production data.** Industry labs should never normalize unsafe testing habits.
7. **Document licensing early.** Premium connector surprises derail pilots.

### Recommended next steps

- Pick one industry most relevant to your customers and turn its scenario into a full working pilot.
- Create a reusable industry questionnaire that asks about API availability, auth, licensing, compliance, and cloud boundary.
- Build one intermediary API example that simplifies a complex industry schema before exposing it through a connector.
- Add evaluation prompts that test both factual accuracy and safe-data handling for each industry topic.

> 🌐 **Final thought:** Industry integration success comes from respecting each system's constraints.
The agent is the conversational front door,
but the quality of the experience depends on the architecture behind it.

---

## 📎 Appendix A — Industry connector decision prompts

- Does a usable certified connector already exist?
- If not, can we wrap the API with a custom connector safely?
- Should we put a flow or intermediary API in front of the source system?
- What auth model does the system truly support?
- Which data fields are safe to return in chat?
- What licensing surprise is most likely to block rollout?

## 📎 Appendix B — Trial and sandbox starter list

| Industry | Trial or sandbox hint |
|---|---|
| Healthcare | Epic developer/FHIR sandbox or synthetic FHIR server |
| Financial Services | Customer SAP sandbox or BTP developer tenant |
| Retail | Shopify development store |
| Manufacturing | ThingWorx sandbox or sample Azure-hosted telemetry API |
| Public Sector | Agency nonproduction API or compliant synthetic façade |
| Technology | Jira test project and GitHub sample repository |

## 📎 Appendix C — Sample executive questions

- Which industry scenario gives us the fastest time to value?
- Which scenario has the highest compliance burden?
- Where do we need a partner or vendor team involved earliest?
- Which connector investments could be reused across multiple customers?

## 📎 Appendix D — Prompt bank

- Find the patient care summary for MRN 20491 using the approved FHIR connector.
- Check payment exception 883021 in SAP and tell me the next action.
- Look up Shopify order 100245 and summarize shipping status.
- What is the current temperature and alert state for line MIX-14?
- Check permit case CIV-2026-117 and summarize the current stage.
- Is Jira issue OPS-412 still blocking GitHub PR 214?
