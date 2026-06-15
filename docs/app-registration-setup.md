# App registration setup for MCP-server-dependent labs

## 1. Overview

An app registration is the Microsoft Entra ID identity used by code or automation to request OAuth tokens. Russ is storing this identity in `.env.local` as:

```text
AZURE_TENANT_ID=
AZURE_CLIENT_ID=
AZURE_CLIENT_SECRET=
```

Those values enable **client-credentials / service-principal** authentication. That flow never falls back to device-code or browser sign-in, so anything that needs a user context must be authenticated separately.

This audit covers only:

- `labs\03-account-orchestration-agent\index.md`
- `labs\05-copilot-studio-vscode-agent-management\index.md`
- `labs\07-agent-to-agent-protocol\index.md`

No Node.js, TypeScript, `manifest.json`, or lab-local `.mcp` configuration files were found under those three lab folders; each folder currently contains `index.md` only. Root-level clues were also checked: `.env.local.example`, `.mcp.json`, `setup.js`, `docs\codespaces.md`, and portal auth/provisioning helpers.

High-level finding: **Lab 03 has Dataverse/MCP pieces that can use service-principal-style access only when the app is also created as a Dataverse application user in the target environment. Lab 05 and most Lab 07 authoring steps require delegated user sign-in and can't be completed with client credentials alone.**

## 2. Required API permissions per lab

### Lab 03 — Account orchestration agent

Evidence found:

- Products include Copilot Studio, Dataverse, Microsoft 365 / SharePoint Work IQ, MCP, and MSN Weather (`labs\03-account-orchestration-agent\index.md`, lines 7-10).
- The lab requires a Power Platform environment where the maker can edit Dataverse views and settings as **System Administrator** or **System Customizer** (`index.md`, lines 95-102).
- Use Case 3 enables **Dataverse intelligence / Work IQ** and **Dataverse Model Context Protocol** features (`index.md`, lines 314-321).
- The lab adds **Microsoft Dataverse MCP Server** and exercises `read_query` and `search` (`index.md`, lines 347-353, 375-406).
- It adds SharePoint knowledge through Work IQ (`index.md`, lines 355-361) and MSN Weather with **Maker** authentication (`index.md`, lines 339-345).
- It adds sample **Order Management MCP Server** and **Warehouse MCP Server** connections with **no credentials required** (`index.md`, lines 459-479).

| API / resource | Permission or access needed | Application vs delegated | Admin consent required? | Notes |
|---|---|---:|---:|---|
| Dataverse / Common Data Service | **No useful Dataverse application permission to add for client credentials.** Instead create a Dataverse **application user** for the app registration and assign environment security roles. | Application identity, enforced by Dataverse application user | Not an API-permission consent item; environment role assignment is required | Needed only if Russ's custom backend/MCP server calls Dataverse Web API directly. The Copilot Studio-hosted Dataverse MCP tool uses the connection selected in the maker UI. |
| Dataverse environment roles | Minimum for the lab's reads: read access to Account, Contact, and metadata/search. Practical lab setup: **System Customizer**; broad fallback: **System Administrator**. | Environment application user or signed-in maker | N/A | The lab prerequisites explicitly call for System Administrator or System Customizer maker access. For app-only Dataverse Web API, assign roles to the application user in PPAC. |
| Power Platform API (`https://api.powerplatform.com`) | For service principals, Microsoft documents RBAC role assignment instead of application permissions. Use **Power Platform reader** for validation/listing, **Power Platform contributor** only if automation manages resources. | Application identity with Power Platform RBAC | N/A for application permissions; RBAC assignment required | Lab 03 itself doesn't call this API from repo code. Root `portal\lib\auth.js` has delegated `https://api.powerplatform.com/.default`; portal provisioning is separate from the lab. |
| Microsoft Graph | None for the Lab 03 walkthrough itself. | N/A | N/A | SharePoint knowledge is configured through Copilot Studio/Work IQ UI. If using the root portal's Graph email, add Graph **Mail.Send** Application; if automating SharePoint provisioning, `portal\lib\provisioner.js` comments mention **Sites.FullControl.All**. |
| Copilot Studio APIs | No separate app permission found in this lab. | Maker delegated UI | N/A | Creating/publishing agents and adding tools happen in Copilot Studio as the signed-in maker. |
| MSN Weather connector | Connector connection in Copilot Studio; anonymous/Maker auth. | Maker connection | No | No Entra app permission. |
| Order Management / Warehouse sample MCP | No credentials required in the lab. | Connection created by maker | No | Lab says create the connections; no secret/API key is requested. |
| Third-party APIs | None found for Lab 03. | N/A | N/A | ServiceNow/Snowflake are in other labs, not this audit. |

**Can Lab 03 work with client credentials alone?** Partially. A custom backend or MCP server can use client credentials for Dataverse only after the app is added as a Dataverse application user with security roles. The Copilot Studio authoring steps, connector creation, SharePoint knowledge selection, and publishing still require a maker/user session in the UI.

### Lab 05 — Copilot Studio VS Code agent management

Evidence found:

- The lab installs the Copilot Studio VS Code extension and requires a **Microsoft account signed into VS Code** with access to a Copilot Studio environment (`labs\05-copilot-studio-vscode-agent-management\index.md`, lines 69-75, 83-93).
- It clones, edits, applies changes, and publishes through the VS Code extension and Copilot Studio browser UI (`index.md`, lines 95-115, 237-249).
- Microsoft Learn for the extension says first launch prompts **Sign In** in the browser and requests permissions to read/write Copilot Studio agents, access environment information, and sync files to cloud.

| API / resource | Permission or access needed | Application vs delegated | Admin consent required? | Notes |
|---|---|---:|---:|---|
| Copilot Studio extension / Power Platform | Signed-in user with read/write access to target agents and environment. | Delegated | Tenant policy may require admin consent for the extension, but Russ's client secret is not used | This is interactive/browser sign-in from VS Code. |
| Dataverse / Graph / ARM / third-party APIs | None found in the lab content. | N/A | N/A | The lab edits YAML/tool metadata for an existing agent; specific tool APIs depend on whatever existing agent Russ clones. |

**Can Lab 05 work with client credentials alone?** No. The documented workflow is delegated user authentication through the VS Code extension plus browser-based Copilot Studio publishing.

### Lab 07 — Agent-to-Agent protocol

Evidence found:

- Products are Copilot Studio, Microsoft Fabric, and A2A (`labs\07-agent-to-agent-protocol\index.md`, lines 7-10).
- Prerequisites require Copilot Studio access and the ability to connect other agents, plus access to Microsoft Fabric and a Fabric Data Agent or equivalent A2A endpoint (`index.md`, lines 95-100).
- The lab says to check whether **additional consent or delegated authorization** is needed for the connection (`index.md`, lines 238-245).
- Copilot Studio A2A setup supports authentication methods **None**, **API key**, and **OAuth 2.0** for the external endpoint.

| API / resource | Permission or access needed | Application vs delegated | Admin consent required? | Notes |
|---|---|---:|---:|---|
| Copilot Studio authoring | Signed-in maker with permission to add/connect agents. | Delegated | Depends on tenant policy | Adding the external agent is done in the Copilot Studio UI. |
| Microsoft Fabric / Fabric Data Agent | Access to the Fabric workspace/Data Agent and any semantic models/datasets it exposes. | Usually delegated user access; exact model depends on the Fabric/A2A endpoint | Depends on Fabric/Entra policy | The lab doesn't define exact Fabric API scopes. Do not invent them; coordinate with the Fabric owner. |
| A2A external endpoint | Depends on endpoint auth: **None**, **API key**, or **OAuth 2.0**. | Depends on endpoint | Depends on endpoint | If OAuth 2.0 is selected, the external agent owner must provide client ID, client secret, auth URL, token URL, and refresh URL. |
| Dataverse / Graph / ARM / third-party APIs | None directly found in the lab content. | N/A | N/A | The internal specialist reused from Lab 03 may have its own Dataverse/connector requirements. |

**Can Lab 07 work with client credentials alone?** No for the Copilot Studio/Fabric authoring flow. A client secret might be part of an external A2A OAuth configuration, but the lab still requires a signed-in user to create the connection and a Fabric user/owner context to prepare the Fabric Data Agent.

### Root-level files and non-lab clues

| File | Finding | Permission implication |
|---|---|---|
| `.env.local.example` | Defines Azure tenant/client/secret, subscription ID, SMTP settings, and `MCP_SERVER_URL`; notes Power Platform uses delegated auth/device code. | The repo already distinguishes app secrets from Power Platform delegated auth. |
| `.mcp.json` | Configures only `squad_state` using `@bradygaster/squad-cli`; no lab MCP server credentials. | No Azure/Graph/Dataverse permissions. |
| `setup.js` | Template customization only. | No API permissions. |
| `docs\codespaces.md` | Notes Lab 03 requires Power Platform tenant features/connectors; Lab 05 cloud auth/publishing happen against Copilot Studio; Lab 07 has no local MCP server code found. | Confirms labs are primarily UI/cloud-authoring flows. |
| `portal\lib\auth.js` | Uses MSAL device-code delegated auth with scopes for Power Platform, BAP, Graph, and Dynamics. | Not compatible with client secret alone for those delegated portal flows. |
| `portal\lib\mailer.js` | Uses client credentials for Graph token with `https://graph.microsoft.com/.default` and calls `/users/{MAIL_FROM}/sendMail`. | Requires Microsoft Graph **Mail.Send** Application if Graph email transport is used. |
| `portal\lib\provisioner.js` | Uses `az` CLI for Azure deployment; comment says SharePoint creation requires Graph **Sites.FullControl.All**; code gets Graph token with client credentials and reads `/sites/root`. | Portal automation is separate from labs 03/05/07, but Graph permissions may be needed if Russ uses the portal. |

## 3. App Registration Setup Steps

### A. Register the app

1. Go to **Azure portal** → **Microsoft Entra ID** → **App registrations**.
2. Select **New registration**.
3. Name it something recognizable, for example `CopilotStudioLabs Local Automation`.
4. Supported account types: **Accounts in this organizational directory only**.
5. Redirect URI: leave blank for client-credentials-only use.
6. Select **Register**.
7. Copy:
   - **Directory (tenant) ID** → `AZURE_TENANT_ID`
   - **Application (client) ID** → `AZURE_CLIENT_ID`

### B. Add API permissions only where they are actually used

For the three audited labs, there is no single app-permission bundle that makes all authoring work app-only. Add only the permissions matching the automation Russ will run:

1. **Microsoft Graph email from the root portal** (not required by Labs 03/05/07 walkthroughs):
   - **API permissions** → **Add a permission** → **Microsoft Graph** → **Application permissions**.
   - Search: `Mail.Send`.
   - Add **Mail.Send**.
   - Select **Grant admin consent**.
2. **SharePoint provisioning through root portal automation** (not directly used by Labs 03/05/07):
   - **Microsoft Graph** → **Application permissions**.
   - Search: `Sites.FullControl.All`.
   - Add only if you will automate SharePoint site/file provisioning.
   - Select **Grant admin consent**.
3. **Power Platform API service-principal calls** (only if custom automation calls `https://api.powerplatform.com`):
   - Microsoft documentation says Power Platform API exposes delegated permissions; for service principals, assign Power Platform RBAC roles instead of relying on app permissions.
   - Give the service principal **Power Platform reader** for read-only validation/listing, or **Power Platform contributor** for management automation.
4. **Dataverse Web API / Dataverse MCP backend service**:
   - Do **not** rely on `Dynamics CRM / user_impersonation` for client credentials; it is delegated and does not grant app-only Dataverse data access by itself.
   - Create the Dataverse application user in PPAC and assign security roles as described below.

### C. Create a client secret

1. In the app registration, open **Certificates & secrets**.
2. Select **New client secret**.
3. Choose an expiration appropriate for the lab window.
4. Copy the **Value** immediately → `AZURE_CLIENT_SECRET`.
5. Do not use the Secret ID as the secret value.

### D. Grant admin consent

1. In **API permissions**, select **Grant admin consent for &lt;tenant&gt;** after adding any Microsoft Graph application permissions.
2. Confirm the status column shows granted/admin consent.
3. If no Graph delegated/application permissions were added for this app-only lab scenario, there may be nothing meaningful to consent to.

### E. Populate `.env.local`

Copy `.env.local.example` to `.env.local` and set at least:

```text
AZURE_TENANT_ID=<directory tenant id>
AZURE_CLIENT_ID=<application client id>
AZURE_CLIENT_SECRET=<client secret value>
```

Optional, depending on what Russ runs:

```text
AZURE_SUBSCRIPTION_ID=<subscription id for Azure provisioning>
MAIL_FROM=<mailbox UPN used by Graph sendMail>
MCP_SERVER_URL=<public MCP endpoint if a lab/server needs one>
```

## 4. Power Platform Tenant Setup

For Dataverse app-only access, the app registration is not enough. Create an application user in the target environment:

1. Go to **Power Platform admin center** → **Manage** → **Environments**.
2. Select the lab environment.
3. Select **Settings** → **Users + permissions** → **Application users**.
4. Select **New app user**.
5. Select **Add an app** and search by the app registration name or `AZURE_CLIENT_ID`.
6. Choose the correct **Business Unit**.
7. Add an email address for the application user.
8. Assign security roles:
   - For lab testing/ease: **System Customizer** is usually enough for schema/table customization and read scenarios; **System Administrator** is the broad fallback if the lab needs environment settings or broad Dataverse actions.
   - For production: create a custom least-privilege role with table-level read/search privileges for Account, Contact, relevant activity/metadata, and any MCP write actions you intentionally expose.
9. Select **Create**.

Environment settings required by Lab 03:

1. **Dataverse Search** enabled (`labs\03...\index.md`, lines 126-137).
2. Correct Quick Find columns for Account and Contact (`index.md`, lines 139-163).
3. **Dataverse intelligence (Work IQ)** enabled (`index.md`, lines 314-320).
4. **Dataverse Model Context Protocol** GA client enabled (`index.md`, lines 314-321).
5. The maker running the lab must still have permission to create agents, add tools, create connections, add SharePoint knowledge, and publish.

For Power Platform API service-principal automation, assign Power Platform RBAC separately from Dataverse security roles:

- **Power Platform reader**: validation/list environments.
- **Power Platform contributor**: management automation.
- **Power Platform owner** or **Power Platform role-based access control administrator**: only for role assignment administration.

## 5. Validation Steps

Use the repo verification script from the repository root. It loads `.env.local`, checks `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, and `AZURE_CLIENT_SECRET`, requests a client-credentials token, and optionally validates Dataverse application-user access with `WhoAmI`.

Token-only Power Platform check:

```powershell
npm run verify:appreg
```

Expected token-only output includes:

```text
✅ Loaded .env.local
✅ AZURE_TENANT_ID: <guid>
✅ AZURE_CLIENT_ID: <guid>
✅ AZURE_CLIENT_SECRET present: ********
✅ Token acquired (Bearer, eyJ...)
⚠️ No --env-url provided. Token acquisition for Power Platform succeeded, but Dataverse WhoAmI was not checked.
```

Full Dataverse validation:

```powershell
npm run verify:appreg -- --env-url https://YOURORG.crm.dynamics.com
```

Expected full-success output includes:

```text
✅ Token acquired (Bearer, eyJ...)
✅ Dataverse WhoAmI succeeded — application user is provisioned and authorized.
UserId: <guid>
BusinessUnitId: <guid>
OrganizationId: <guid>
✅ Full validation succeeded.
```

Common failure output:

- `❌ AZURE_TENANT_ID is missing or empty` or `malformed (must be a GUID)`: fix `.env.local`.
- `AADSTS7000215`: invalid client secret. Verify `AZURE_CLIENT_SECRET` is the **Secret Value**, not the Secret ID.
- `AADSTS700016`: application not found. Verify `AZURE_CLIENT_ID` belongs to `AZURE_TENANT_ID`.
- `AADSTS90002`: tenant not found. Verify `AZURE_TENANT_ID`.
- `AADSTS65001`: admin consent required. Grant admin consent in Azure portal → API permissions.
- Dataverse `401`: token rejected by Dataverse, likely because the app has not been created as a PPAC application user. Follow Section 4.
- Dataverse `403`: token accepted but no permissions. Assign **System Customizer** or the required least-privilege security role to the application user in PPAC.

The script masks secrets and truncates token display. It exits `0` on successful validation and `1` on failures, so it can be used in CI.

## 6. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `AADSTS7000215: Invalid client secret` | Secret value is wrong, expired, or Secret ID was copied instead of Value. | Create a new secret and copy **Value** immediately into `.env.local`. |
| `AADSTS700016: Application with identifier ... was not found` | Client ID is from another tenant or typo. | Verify app registration tenant and `AZURE_TENANT_ID`. |
| `AADSTS70011: invalid_scope` | Scope/resource is wrong for the token request. | Use exact scopes: `https://graph.microsoft.com/.default`, `https://api.powerplatform.com/.default`, or `<Dataverse environment URL>/.default`. |
| Token succeeds but Graph `sendMail` returns 403 | Missing Graph **Mail.Send** Application or admin consent; mailbox restrictions may also apply. | Add **Mail.Send** Application, grant admin consent, and verify `MAIL_FROM` mailbox exists. |
| Power Platform API token succeeds but API returns 401/403 | Service principal has no Power Platform RBAC role. | Assign **Power Platform reader** or **contributor** at tenant/environment scope. |
| Dataverse Web API returns unauthorized / principal not found | App registration isn't configured as a Dataverse application user in the environment. | PPAC → Environment → Settings → Users + permissions → Application users → New app user. |
| Dataverse query returns empty or schema/search issues in Lab 03 | Dataverse Search, Quick Find views, Work IQ, or Dataverse MCP feature not configured. | Follow Lab 03 environment setup lines 126-163 and 314-321. |
| Copilot Studio says `Connection Required` at runtime | Tool connection not created or wrong auth mode. | Reopen tool details; for Weather use **Maker** + connection; for Dataverse MCP pick/create a Dataverse connection. |
| VS Code extension sign-in loops or cannot list environments | Lab 05 uses delegated extension sign-in, not client secret. | Sign into VS Code/browser with a licensed user who has environment and agent permissions. |
| A2A external agent does not appear or validate | Endpoint/agent card/auth details wrong, or user lacks permission. | Verify endpoint, `/.well-known/agent.json`, selected auth method, and Fabric/A2A owner permissions. |

## 7. Labs That Need Delegated Auth Instead

- **Lab 05 definitely requires delegated auth.** The Copilot Studio VS Code extension signs in through the browser and operates as the user. Client credentials in `.env.local` won't clone, apply, or publish agents.
- **Lab 07 requires delegated authoring access.** Creating a Copilot Studio A2A connection and preparing a Fabric Data Agent require signed-in user permissions. Client credentials might be used only as part of a separate OAuth setup for an external A2A endpoint, if that endpoint owner requires it.
- **Lab 03 requires delegated maker access for the Copilot Studio UI steps.** Client credentials can help only for custom backend/MCP Dataverse calls after application-user setup. The built-in Copilot Studio tool/connection workflow is still maker/user-driven.

## Immediate app registration cheat sheet

If Russ wants the broadest useful app registration for local automation around these labs:

1. Create a single-tenant Entra app registration and client secret; store tenant ID, client ID, and **secret value** in `.env.local`.
2. For Dataverse app-only calls, create a PPAC **application user** for the app in the target environment and assign **System Customizer** or a least-privilege custom role. Use **System Administrator** only as a lab fallback.
3. Do **not** expect `Dynamics CRM / user_impersonation` delegated permission to make client credentials work for Dataverse.
4. If using root portal email, add Microsoft Graph **Mail.Send** Application and grant admin consent.
5. If using Power Platform API automation, assign Power Platform RBAC (**reader** or **contributor**) to the service principal; don't look for application permissions in the API picker.
