# 🔌 Lab 21: Custom Connectors & OAuth for Copilot Studio

*Turn any well-described REST API into a Copilot Studio tool, secure it with OAuth, and deliver a smoother sign-in experience with SSO.*

## Metadata

| | |
|---|---|
| ⭐ **DIFFICULTY** | Intermediate-Advanced (Level 250) |
| ⏱️ **TIME** | 75 minutes |
| 🧩 **PRODUCTS** | Microsoft Copilot Studio, Power Platform Custom Connectors, Microsoft Entra ID |
| 🏷️ **TAGS** | Custom Connectors, OAuth 2.0, SSO, OpenAPI, REST API, Entra ID |
| 🏭 **INDUSTRY** | Technology and cross-industry REST API integrations |

---

## 🗺️ Lab Flow

```mermaid
flowchart LR
  A["Choose connectivity method"] --> B["Import OpenAPI"]
  B --> C["Configure security"]
  C --> D["Create connection"]
  D --> E["Add tool to agent"]
  E --> F["Enable SSO"]
  F --> G["Test custom website and Teams"]
```

---

## ⚡ Why this lab matters

Most enterprise systems are not available as first-party Copilot Studio tools on day one.
Some have prebuilt connectors.
Many do not.
When you need to call a homegrown API, a niche SaaS platform, or a partner service, **custom connectors** are the fastest way to expose that API across Power Automate, Power Apps, and Copilot Studio.

Custom connectors matter for Copilot Studio because they become reusable enterprise actions.
You define the API once.
You secure it once.
Then you can use it in flows, apps, and agents.
For organizations standardizing on REST APIs, this is the difference between isolated demos and governed platform integration.

Security is the second half of the story.
If your connector is not authenticated correctly, it is either useless or dangerous.
Microsoft Entra ID OAuth 2.0 is the recommended pattern for most enterprise APIs because it supports delegated user access, central app governance, and familiar token controls.
You also need to understand the **per-connector redirect URI** requirement introduced for OAuth connectors, because older global redirect assumptions cause broken sign-in experiences.

Finally, a secure connector still creates friction if users must sign in repeatedly.
That is where Copilot Studio **single sign-on (SSO)** enters the design.
When configured correctly, an already-signed-in user on a custom website, Teams, SharePoint, or Omnichannel can reach an authenticated agent experience with less interruption.

---

## 🌍 Real-world example

A software company wants a Copilot Studio support agent that can retrieve GitHub pull-request metadata and Jira issue details.
GitHub already has a standard connector.
A private internal engineering API does not.
The company imports an OpenAPI definition into a custom connector, secures it with Microsoft Entra ID OAuth, and then adds it as a tool to the support agent.
The agent is published on an internal engineering portal where employees are already signed in.
SSO removes the repeated sign-in prompts and makes the experience feel native to the portal.

The same pattern works for HR systems,
financial APIs,
healthcare interoperability services,
and regulated line-of-business platforms.

---

## 🎯 Objectives

By the end of this lab you will be able to:

1. ✅ Compare six Copilot Studio connectivity methods and choose the right one for a given integration.
2. ✅ Import an OpenAPI definition into a Power Platform custom connector.
3. ✅ Understand the requirement for **OpenAPI 2.0** in custom connectors.
4. ✅ Configure connector operations, summaries, visibility, and test behavior.
5. ✅ Register an app in Microsoft Entra ID for OAuth-secured custom connectors.
6. ✅ Configure connector security with **OAuth 2.0** and the correct redirect URI.
7. ✅ Recognize the post-February-2024 **unique per-connector redirect URL** requirement.
8. ✅ Add the custom connector to Copilot Studio as a tool and test it in a topic or orchestration flow.
9. ✅ Configure Copilot Studio SSO using the five-step pattern for Entra ID.
10. ✅ Explain Teams-specific SSO requirements and supported versus unsupported channels.
11. ✅ Account for premium licensing requirements before rollout.

---

## 🧠 Core concepts overview

| Concept | What it means in this lab |
|---|---|
| **Prebuilt connector** | A Microsoft or partner-maintained connector you can add from the connector catalog. |
| **Custom connector** | A reusable wrapper around a REST API described by OpenAPI or Postman, available across Power Platform and Copilot Studio. |
| **Agent flow** | A Power Automate-backed pattern used when you need orchestration, transformations, approvals, or gateway-connected data access. |
| **REST API tool (preview)** | A direct Copilot Studio tool that can upload OpenAPI v2 or v3, with platform conversion and lighter-weight API use. |
| **MCP server** | A Model Context Protocol endpoint for tool-style interactions over Streamable HTTP; useful for specialized action surfaces. |
| **Computer Use** | A GUI automation approach for systems that lack usable APIs. Powerful, but usually the last choice when an API exists. |
| **OAuth 2.0** | A delegated authorization framework. In this lab, Microsoft Entra ID is the recommended identity provider for enterprise APIs. |
| **Redirect URI** | The callback URL used during OAuth authorization. For custom connectors, use the connector-specific redirect URI. |
| **SSO** | Single sign-on that lets already-signed-in users access the agent experience with less sign-in friction on supported channels. |
| **Connection ownership** | The decision about whether credentials are supplied by the end user or by the maker/admin. It affects security, licensing, and support. |

---

## 📚 Documentation

- [Custom connectors overview](https://learn.microsoft.com/en-us/connectors/custom-connectors/)
- [Create a custom connector from an OpenAPI definition](https://learn.microsoft.com/en-us/connectors/custom-connectors/define-openapi-definition)
- [Authenticate your API and connector with Microsoft Entra ID](https://learn.microsoft.com/en-us/connectors/custom-connectors/azure-active-directory-authentication)
- [Submit your connector for certification](https://learn.microsoft.com/en-us/connectors/custom-connectors/submit-certification)
- [Configure single sign-on with Microsoft Entra ID in Copilot Studio](https://learn.microsoft.com/en-us/microsoft-copilot-studio/configure-sso)
- [Configure single sign-on for agents in Microsoft Teams](https://learn.microsoft.com/en-us/microsoft-copilot-studio/configure-sso-teams)
- [Configure single sign-on with generic OAuth providers](https://learn.microsoft.com/en-us/microsoft-copilot-studio/configure-sso-3p)
- [Use connectors in Copilot Studio](https://learn.microsoft.com/en-us/microsoft-copilot-studio/advanced-connectors)

---

## ✅ Prerequisites

- Access to **Microsoft Copilot Studio**.
- Access to **Power Automate** or **Power Apps** to build and test a custom connector.
- Permission to create or use **Microsoft Entra ID app registrations**.
- A sample REST API and OpenAPI document.
- A browser session where you can test sign-in and redirect behavior.

> 💡 **Recommended lab API:** Use a low-risk public API such as **JSONPlaceholder** for structural testing, or the **GitHub REST API** if you want a realistic auth-based example.

> ⚠️ **Important:** For Power Platform custom connectors, your imported definition must be **OpenAPI 2.0**.
If your source spec is OpenAPI 3.x, convert it before import.
The Copilot Studio REST API tool preview can accept v2 or v3, but this lab focuses on the **custom connector** path.

### Licensing quick reference

| Capability | Licensing note |
|---|---|
| Custom connectors in Copilot Studio | Usually requires premium connector entitlement in the environment |
| Power Apps Premium | Common licensing path for premium connector use |
| Power Automate Premium | Common licensing path for premium connector and flow use |
| Power Apps Developer Plan | Free for personal development and experimentation, including premium connectors for personal use |
| Power Automate Trial | 90-day premium trial suitable for labs |
| Copilot Studio | Tenant and user licensing apply; review current Copilot Studio billing in your tenant |

---

## 🗺️ Use cases covered

| # | Use Case | What you will do | Time |
|---|---|---|---|
| 1 | Build a custom connector from OpenAPI | Import, review, and test a connector built from an API definition | 20 min |
| 2 | Add OAuth 2.0 authentication | Register an app, configure security, and handle the unique redirect URI requirement | 20 min |
| 3 | Connect the custom connector to Copilot Studio | Add the connector as a tool and use it in topics or orchestration | 15 min |
| 4 | Enable SSO for seamless authentication | Configure Entra ID SSO for a custom website and review Teams-specific considerations | 20 min |

---

## 🔀 Connectivity methods comparison

| Method | Best when | Authentication choices | Tradeoffs |
|---|---|---|---|
| **Prebuilt connector** | A supported connector already exists | User auth or maker-provided credentials | Fastest path, but limited to published connector capabilities |
| **Custom connector** | You have any REST API with a stable contract | Entra ID OAuth 2.0, generic OAuth 2.0, API key, basic auth | Best balance of reuse and control, but requires premium licensing and definition maintenance |
| **Agent flow** | You need orchestration, approvals, transforms, or gateway-backed access | Depends on connectors used inside the flow | Strong process control, but more moving parts and latency |
| **REST API tool (preview)** | You want a lightweight API tool directly inside Copilot Studio | None, API key, OAuth, basic auth | Fast for direct tooling, but preview and different governance surface |
| **MCP server** | You expose tools via Model Context Protocol | None, API key, OAuth | Great for specialized server-side tools; requires MCP host and governance |
| **Computer Use** | No usable API exists and UI automation is acceptable | App sign-in or desktop identity | Powerful fallback, but brittle compared to APIs |

> 💡 **Tip:** Prefer the **highest-governance API-first option** that solves the problem.
Usually that means prebuilt connector first,
custom connector second,
agent flow when process logic is needed,
and UI automation only when there is no better contract.

---

# 🧪 Use Case #1 — Build a Custom Connector from OpenAPI

> 🎯 **Objective:** Import an API definition, review the generated connector metadata, and test a working operation before involving Copilot Studio.

### Scenario

You want a Copilot Studio agent to call a REST API that is not available as a prebuilt connector.
The API is documented with Swagger or OpenAPI.
Your job is to wrap it as a custom connector that other makers can reuse.

### Step 1 — Choose the API and definition source

1. Pick a lab-safe REST API.
2. For a public example, use **JSONPlaceholder** for anonymous testing or **GitHub REST API** for more realistic auth and throttling behavior.
3. Obtain or generate an **OpenAPI 2.0** document.
4. If your source definition is OpenAPI 3.x, convert it before import.
5. Keep the file under the platform size limits and review it for unnecessary operations.

### Step 2 — Import the OpenAPI definition

1. In **Power Apps** or **Power Automate**, open **Data** > **Custom connectors**.
2. Select **New custom connector** > **Import an OpenAPI file**.
3. Provide a meaningful connector name such as **EngineeringSupportAPI**.
4. Upload the definition and continue.
5. Review the imported icon, description, host, and base URL.

### Step 3 — Review the General page carefully

1. Confirm the title and description are understandable to other makers.
2. Confirm the **host** and **base URL** match the API.
3. Remove operations that should not be exposed.
4. Add branding and internal owner notes where useful.
5. Save the connector once the metadata is clean.

> 💡 **Tip:** A custom connector is a shared product, not just a lab artifact.
Name it like something other teams could discover and trust.

### Step 4 — Review the Definition page

1. Inspect each operation summary.
2. Rename cryptic operation IDs to human-readable actions.
3. Mark required parameters clearly.
4. Add sample descriptions for inputs that makers might misuse.
5. Hide operations that do not belong in self-service use.

#### Example operation cleanup checklist

- Replace `getRepoPulls` with **List repository pull requests**.
- Replace `id` with **Repository owner** or **Issue number** where possible.
- Add descriptions that mention rate limits and paging.
- Remove admin-only operations from the connector definition.

### Step 5 — Test the connector operation

1. Create the connector.
2. Open the **Test** tab.
3. Create a new connection if required.
4. Run a simple operation such as:
   - Get a placeholder record.
   - List GitHub issues.
   - Retrieve a repo summary.
5. Confirm the response schema and payload shape are usable.

> ⚠️ **Warning:** Do not expose every operation in a large public API “just because the spec imported cleanly.”
Each operation you leave visible becomes part of your governance surface.

### Validation checklist

- The connector imports successfully.
- The host and base path are correct.
- Operation names are readable.
- At least one operation runs successfully in the Test tab.

### Troubleshooting

- If import fails, inspect the definition for unsupported constructs and confirm it is OpenAPI 2.0.
- If the connector imports but operations look wrong, simplify the spec rather than fighting every generated field manually.
- If responses are too noisy, create a narrower API wrapper instead of exposing a massive public API directly.

### Challenge

Import a second API definition and compare the maker experience.
Which spec is easier to govern?
Which one would be safer to expose to a wide internal audience?

### ✅ You've completed Use Case #1

You now have a reusable API wrapper and a baseline for secure authentication.

---

# 🧪 Use Case #2 — Add OAuth 2.0 Authentication

> 🎯 **Objective:** Secure the connector with Microsoft Entra ID OAuth 2.0 and avoid the most common redirect-URI mistakes.

### Scenario

Your API should not be anonymous.
You need delegated user access, central app governance, and a repeatable sign-in experience.
Microsoft Entra ID is the preferred identity provider for this scenario.

### Step 1 — Register the application in Microsoft Entra ID

1. Open the **Azure portal**.
2. Go to **Microsoft Entra ID** > **App registrations**.
3. Create a new app registration for the API access pattern.
4. Capture the **Application (client) ID**.
5. Add the required API permissions for the underlying API.
6. Create a **client secret** if your pattern requires it.
7. Record the **tenant ID**, **client ID**, and **client secret** securely.

### Step 2 — Configure OAuth on the connector Security tab

1. Edit the custom connector.
2. Open the **Security** tab.
3. Choose **OAuth 2.0**.
4. Choose **Microsoft Entra ID** as the identity provider when applicable.
5. Enter the required values such as:
   - Client ID.
   - Client secret.
   - Authorization URL.
   - Token URL.
   - Refresh URL if required.
   - Resource URL or scope configuration required by the API.
6. Save the connector.

### Step 3 — Capture the unique redirect URI

1. After saving, review the generated **Redirect URL**.
2. Copy that exact connector-specific redirect URI.
3. Return to the Entra app registration.
4. Add the connector-specific redirect URI to the app registration.
5. Save the registration.

> ⚠️ **Warning:** Do **not** rely on the old shared or global redirect URI assumption.
Custom connectors that use OAuth require the **unique per-connector redirect URL** pattern.

### Step 4 — Apply the post-February-2024 redirect requirement

1. On the **Security** tab, check the box labeled **Update to unique redirect URL** if you are modernizing an older connector.
2. Save the connector.
3. Remove the obsolete global redirect URI from the Entra app if your organization no longer needs it.
4. Update any deployment documentation so future admins use the unique redirect URI only.

### Step 5 — Create and test the connection

1. Open the connector **Test** tab.
2. Create a new connection.
3. Complete the sign-in flow.
4. Run a simple authenticated operation.
5. Confirm the token is valid and the response matches the signed-in user's permissions.

> 💡 **Tip:** Test the OAuth connection with the smallest safe read operation first.
It is much easier to debug auth with a simple `GET` than with a complex multi-parameter action.

### Step 6 — Review alternate auth choices

1. Record why **Entra ID OAuth 2.0** is preferred for enterprise APIs.
2. Record when you might still use:
   - **Generic OAuth 2.0** for third-party APIs.
   - **API key** for simple service access.
   - **Basic auth** only when required by the target system and approved by policy.
3. Decide whether the connection should be **user-provided** or **maker-provided**.

| Auth type | When to use it | Governance note |
|---|---|---|
| Entra ID OAuth 2.0 | Internal or Entra-integrated APIs | Best for enterprise governance and delegated access |
| Generic OAuth 2.0 | Third-party OAuth APIs | Strong option when Entra is not the identity provider |
| API key | Simple service-level access | Easier to set up, but weaker for delegated identity scenarios |
| Basic auth | Legacy systems only | Use sparingly and review credential handling carefully |

### Validation checklist

- Entra app registration exists.
- Connector security is configured correctly.
- Unique redirect URI is registered.
- An authenticated connection can be created successfully.

### Troubleshooting

- If sign-in loops, verify the redirect URI exactly matches the connector-generated value.
- If consent succeeds but calls fail, review scopes, resource URL, and delegated permissions.
- If the connector was created before the redirect-URI change and new connections fail, update it to the per-connector redirect mode immediately.
- If a third-party OAuth provider behaves differently, document its token and redirect expectations separately from the Entra pattern.

### Challenge

Configure a second connector that uses **Generic OAuth 2.0** instead of Entra ID.
Compare the configuration experience.
Which settings were harder to standardize?
Which approach would you support at scale more easily?

### ✅ You've completed Use Case #2

You now have an authenticated connector and a documented OAuth pattern your team can reuse.

---

# 🧪 Use Case #3 — Connect Custom Connector to Copilot Studio

> 🎯 **Objective:** Add the custom connector as a tool, decide how credentials will be supplied, and build a topic that uses the operation safely.

### Scenario

The connector works in the Test tab.
Now you want the agent to call it during real conversations.
You also need to decide whether the user or the maker supplies the credentials.

### Step 1 — Add the connector as a tool

1. Open the target agent in Copilot Studio.
2. Go to **Tools**.
3. Add a **Connector** tool.
4. Select your custom connector.
5. Pick the operation or operations you want to expose.
6. Write clear descriptions so the planner knows when to call them.

### Step 2 — Choose the connection model

1. Decide between **user authentication** and **maker-provided credentials**.
2. Choose **user authentication** when the API should respect each user's identity and permissions.
3. Choose **maker-provided credentials** only when a shared service identity is appropriate and approved.
4. Document the tradeoff:
   - User auth is usually safer and more auditable.
   - Maker-provided credentials may simplify onboarding but can broaden access if not carefully scoped.

### Step 3 — Create the topic or prompt pattern

1. Build a topic such as **Check engineering issue status**.
2. Ask the user for the issue number or repository name.
3. Call the connector action.
4. Summarize the response in plain language.
5. Return only the fields that make sense in conversation.

#### Sample Copilot Studio topic starter

```text
When a user asks about an engineering issue, GitHub pull request, or internal support ticket, collect the identifier, call the appropriate custom connector action, summarize the current status, and suggest the next step without exposing raw tokens or unnecessary API payload fields.
```

### Step 4 — Test the tool behavior

1. Use the Copilot Studio test chat.
2. Ask a direct question that should trigger the tool.
3. Review the activity map.
4. Confirm the tool fired and returned the expected operation.
5. Adjust the tool description if the planner misses the action.

### Step 5 — Review sharing and permissions

1. Ensure the connector is shared appropriately.
2. Confirm makers who need the tool have permission to view and use the connector.
3. Avoid sharing edit rights broadly.
4. Record the connector owner and support contact.

> 💡 **Tip:** Treat the connector owner like an application owner.
Someone must own schema changes, secret rotation, and support questions long after the lab ends.

> ⚠️ **Warning:** A working connector does not guarantee a good orchestration experience.
Poor tool descriptions can cause the planner to ignore the connector or call it at the wrong time.

### Validation checklist

- The connector appears as a tool in Copilot Studio.
- The chosen auth model is documented.
- A topic or prompt pattern calls the connector successfully.
- Test chat shows the expected operation in the activity map.

### Troubleshooting

- If the tool never fires, sharpen the tool description and the topic description.
- If the tool fires but returns unauthorized, recheck the connection type and signed-in user context.
- If the payload is too large, reduce the response shape in the API or a flow wrapper rather than dumping raw JSON into the chat.

### Challenge

Expose two operations from the same connector.
Then test whether the agent chooses the correct one based on the user's request.
If not, revise the descriptions until routing becomes reliable.

### ✅ You've completed Use Case #3

You now have an authenticated API surface available to your Copilot Studio agent.

---

# 🧪 Use Case #4 — Enable SSO for Seamless Authentication

> 🎯 **Objective:** Configure SSO so users already signed in to a supported channel can authenticate with less friction when using your Copilot Studio agent.

### Scenario

Your agent is published to an internal website.
Employees are already signed in to the site with Entra ID.
You want the agent to reuse that identity rather than forcing a separate sign-in prompt every time.

### Step 1 — Review the five-step SSO model

1. Enable **manual authentication** for the agent with Microsoft Entra ID.
2. Create an **authentication app registration** for the agent.
3. Create a separate **canvas app registration** for the website or client surface.
4. Define a **custom scope** and **token exchange URL**.
5. Configure the client-side code so the custom website passes the token to the agent experience.

> ⚠️ **Warning:** Do **not** reuse the same app registration for both the agent and the website or canvas.
Microsoft explicitly recommends separate app registrations.

### Step 2 — Verify channel support

1. Confirm that SSO is supported for:
   - **Custom Website**.
   - **Microsoft Teams**.
   - **SharePoint**.
   - **Omnichannel**.
2. Confirm that SSO is not supported for:
   - **Facebook**.
   - **Mobile App**.
   - **Azure Bot Service channels**.
   - **Demo Website**.
   - **Power Pages**.
3. Document the channel constraints in your rollout plan.

### Step 3 — Configure the authentication app

1. In Azure, create or verify the app registration used for the agent's Entra authentication.
2. Under **Expose an API**, create the custom scope.
3. Copy the scope value.
4. In Copilot Studio, open **Settings** > **Security** > **Authentication**.
5. Paste the scope into **Token exchange URL**.
6. Save the authentication settings.

### Step 4 — Configure the canvas app registration

1. Create a second app registration for the website or SPA.
2. Add a **SPA** platform configuration.
3. Add the website redirect URI.
4. Enable **Access tokens** and **ID tokens** for implicit/hybrid flows if the implementation requires the documented sample pattern.
5. Under the authentication app registration, add the canvas app as an **Authorized client application**.

### Step 5 — Update the client-side code

1. Copy the **token endpoint URL** from the Copilot Studio channel settings.
2. Configure the MSAL client in your website code with:
   - The canvas app **client ID**.
   - The tenant-specific **authority** URL.
3. Set the token endpoint URL in the sample code.
4. Apply a custom prefix to `userId` if you want stable identifiers.
5. Test the sign-in flow.

### Step 6 — Review Teams-specific considerations

1. If you publish to **Microsoft Teams**, follow the separate Teams SSO guidance.
2. Do not assume the custom website steps are sufficient for Teams.
3. Verify Teams client settings before pilot rollout.
4. Test in the Teams client, not only in a browser.

> 💡 **Tip:** SSO success is measured by **the absence of an extra sign-in prompt** for already-signed-in users.
If the chat still asks users to sign in and paste a validation code, your SSO configuration is incomplete.

### Validation checklist

- Manual auth is enabled.
- Separate authentication and canvas app registrations exist.
- Token exchange URL is configured.
- Website or client code uses MSAL and the Copilot Studio token endpoint.
- Supported channel tests succeed without unnecessary sign-in prompts.

### Troubleshooting

- If the user sees a validation code prompt, review the five SSO steps end to end.
- If Teams fails but the website works, revisit the Teams-specific documentation.
- If guest users cannot reach AI-generated answers from SharePoint or Graph Connector sources, treat that as a known platform behavior and design accordingly.
- If engineers reused one app registration for both website and agent, split the registrations before continuing.

### Challenge

Document a rollout plan for two channels:
**Custom Website** and **Teams**.
List which artifacts are shared,
which settings differ,
and which team owns testing for each channel.

### ✅ You've completed Use Case #4

You now have the pieces required for secure connector-based actions and a smoother sign-in experience in supported channels.

---

# 🙋 Summary

### What you accomplished

| Step | What you did |
|---|---|
| **Compare** | Evaluated six connectivity methods for Copilot Studio |
| **Build** | Imported and refined a custom connector from OpenAPI |
| **Secure** | Configured OAuth 2.0 with Microsoft Entra ID and the correct redirect URI |
| **Connect** | Added the connector to Copilot Studio as a tool |
| **Streamline** | Planned and tested SSO for supported channels |

### Golden rules

1. **Choose the simplest integration method that preserves governance.** Prebuilt first, then custom connector, then heavier patterns.
2. **Treat the OpenAPI definition as a product artifact.** Clean names and clean schemas improve adoption.
3. **Use Microsoft Entra ID when possible.** It is usually the most governable enterprise auth model.
4. **Always use the connector-specific redirect URI.** Old global redirect assumptions create avoidable outages.
5. **Keep tool descriptions precise.** Good routing depends on clear descriptions as much as good APIs.
6. **Separate website and agent app registrations for SSO.** Reuse creates security and support problems.
7. **Test auth at three layers.** Connector test tab, Copilot Studio tool invocation, and end-user channel experience.

### Recommended next steps

- Add a second operation to your connector and test planner selection quality.
- Evaluate whether the API should stay a custom connector or graduate to a certified connector strategy.
- Build a support document for secret rotation, app registration ownership, and redirect URI maintenance.
- Pilot the same pattern on a second channel such as SharePoint or Teams.

> 🔐 **Final thought:** A great custom connector is not just a wrapper around an API.
It is a reusable, secure, and well-described capability that makes your Copilot Studio agents much more valuable.

---

## 📎 Appendix A — Connector certification discussion prompts

- Should this API stay internal, or could it become a broader certified connector investment?
- Which operations are safe for wide reuse, and which should stay admin-only?
- How will client-secret rotation be handled without breaking user connections?
- Should the API return raw data, or should an API wrapper simplify the schema first?

## 📎 Appendix B — Sample prompt bank

- Look up issue 412 and summarize the current owner and status.
- Check pull request 97 in the engineering tools repository and tell me whether it is blocked.
- Retrieve the latest deployment health summary from the engineering support API.
- Explain why I was asked to sign in again even though I am already on the intranet.
- Compare whether this integration should use a custom connector, REST API tool, or agent flow.

## 📎 Appendix C — OAuth setup checklist

- [ ] App registration created.
- [ ] Required API permissions granted.
- [ ] Client secret stored securely.
- [ ] Connector Security tab completed.
- [ ] Unique redirect URI copied.
- [ ] Redirect URI added to app registration.
- [ ] Test connection created.
- [ ] One authenticated operation verified.

## 📎 Appendix D — SSO readiness checklist

- [ ] Manual auth enabled for the agent.
- [ ] Authentication app registration created.
- [ ] Separate canvas app registration created.
- [ ] Custom scope defined.
- [ ] Token exchange URL configured.
- [ ] Client-side MSAL settings updated.
- [ ] Supported channel tested.
- [ ] Teams-specific settings reviewed if applicable.
