# ⚡ Microsoft AI Training Generator — Provisioning Portal

A web-based lab operations portal for building, customizing, validating, previewing, provisioning, approving, exporting, and supporting training labs across Microsoft Copilot Studio, Agent Builder and declarative agents, SharePoint AI, Microsoft Foundry, the Microsoft 365 Copilot hub, and the Power Platform AI hub (AI Builder).

## Features

- **🧬 Lab Builder** — 8-step wizard across 6 Microsoft AI products and 195 capabilities (product, industry/vertical, departments, level, harness, topics, review, generate), grounded on Microsoft Learn with canonical URL deduplication, SharePoint site configuration, opt-in multiple-choice Knowledge Check mini-quizzes, and `Required By` admin prerequisites (see [`docs/lab-builder.md`](../docs/lab-builder.md))
- **📚 Chapter Management** — Explicitly include or exclude hand-written lab chapters under **Lab chapters** on the Lab setup tab (nothing is auto-selected initially; the level for a generated lab is chosen in wizard Step 4)
- **🗂️ Generated Lab Management & Multi-Format Exports** — Open, preview as interactive paged HTML (with `localStorage` checkable task lists and Knowledge Check mini-quizzes), export as `.zip` (`formats=all|docx|pptx|pdf|html`), `.html`, `.docx`, `.pdf`, `.pptx`, `.md`, or per-topic `.docx`/`.pptx` files (`<Lab Name> - Step NN - <Topic Name>`), print/save as PDF, run structural validation, rename, delete, or re-open saved selections
- **🗺️ Lab Flow Diagrams** — Render Mermaid diagrams inside lab previews to visualize architecture and process flow
- **🗺️ Lab Dependency Map** — View a structured dependency and sequence map showing recommended lab order and independent tracks
- **🎨 Customization** — Replace organization names, industry context, compliance terms, agent names, end-user roles, and branding
- **💡 Use Case Builder** — Pick an industry, departments, goals, the data you already have, a platform, and a skill level, and get a live, ranked list of Copilot Studio and Agent Builder use cases (each with starter instructions, knowledge, tools, a product-fit rationale, lab topics, and Microsoft Learn links). Shortlist them, export Markdown or CSV, or pre-fill the lab builder wizard from your shortlist. The scenario setup for the provisioning labs is kept in a secondary section ([`docs/lab-builder.md`](../docs/lab-builder.md#use-case-builder))
- **👁️ Lab Preview** — Read fully rendered paginated labs in the browser with table of contents, chapter jumper, image lightbox, print/save as PDF, and walkthrough PDF download links ([`tools/lab-pdf`](../tools/lab-pdf/README.md)) where available
- **👍 Inline Feedback** — Capture thumbs up/down feedback on sections and checkpoints
- **🐛 Issue Reporting** — Open a GitHub issue with current lab context in one click
- **🖨️ Print Support** — Clean `@media print` styling for both hand-written lab previews and generated custom labs
- **📥 Export** — Build ZIP packages with customized content replacements and company branding for selected static chapters or generated labs
- **📧 Email** — Send lab bundles through SMTP or Microsoft Graph
- **☁️ Azure Resources** — Check prerequisites, inspect resource manifests, deploy resources, monitor progress, and destroy environments
- **⚡ Power Platform** — Use device code auth to list, create, and delete environments, inspect Secure Score, review recommendations, remediate issues, and schedule admin activities
- **🔐 Approval Workflows** — Gate environment provisioning with None, Portal, Power Automate, Logic Apps, Copilot Studio, or Teams Adaptive Card approvals
- **📢 Notifications** — Send approval lifecycle notifications via Teams Adaptive Cards and email
- **🤖 Agent Chat** — Embed a Copilot Studio agent chat widget for real-time lab guidance and troubleshooting
- **🧪 Validation** — Run documentation smoke tests across all labs or a single lab, plus a step-level accuracy check of every lab step against current Microsoft Learn content
- **⚙️ Configuration** — Review Azure, Key Vault, SMTP, branding, and deployment settings in one place
- **✅ Setup Checklist** — At the top of Configuration, eight plain-language setup tasks with live status and one fix-it button each: brand profile, learner links, tenant addresses, screenshot computer, product sign-ins, screenshot library, storage, and Microsoft Learn freshness. A short banner on the Build tab points to it until the recommended steps are done or you dismiss it. Nothing on it ever blocks building a lab (see [First-time setup](../docs/lab-builder.md#first-time-setup))
- **📸 Screenshot Center** — Capture tenant screenshots on your own computer with the Local Capture Companion, or paste and upload them, then check each lab against Microsoft Learn (see [`tools/screenshot-capture/README.md`](../tools/screenshot-capture/README.md))
- **🐳 Cloud & Container-Ready** — Run locally on port `3005`, in Docker (with `/healthz` readiness checks), on **Azure Container Apps** via `azd`, or in Azure App Service

## Quick Start

### Local development

```bash
cd portal
npm install
cp .env.template .env
# For loopback-only local development, set PORTAL_AUTH_DISABLED=true in .env.
# Never disable authentication on a deployed or network-accessible listener.
npm run dev
```

Open [http://localhost:3005](http://localhost:3005)

### Docker deployment

```bash
cd portal
docker compose up --build

# Or build/run directly from the repository root (required so labs/, docs/, and scripts/ are in context)
docker build -t copilot-labs-portal -f portal/Dockerfile .
docker run -p 3005:3005 --env-file portal/.env copilot-labs-portal
```

`portal/Dockerfile` builds on `node:24-alpine`, runs as the non-root `node` user on `HOST=0.0.0.0` and `PORT=3005`, and configures a container `HEALTHCHECK` against `http://127.0.0.1:3005/healthz`.

The image copies `portal/`, `labs/`, `docs/feature-tour/screenshots/`, `tools/feature-tour/`, and `tools/screenshot-capture/`, minus what `.dockerignore` excludes (tests, `node_modules`, `.env` files, and a developer's `.auth/`, `.companion.json`, and `.captures/` folders, so no sign-in or pairing token can end up in an image). The portal builds the Local Capture Companion download (`GET /api/capture/companion.zip`) from those folders at request time. `portal/test/container-readiness.test.js` stages only those paths, boots the server, and checks that the Screenshot Center scripts, the brand profile routes, and a complete, secret-free companion download are served.

### Deploy to Azure (Azure Container Apps + `azd`)

The recommended cloud deployment uses [Azure Developer CLI (`azd`)](https://learn.microsoft.com/azure/developer/azure-developer-cli/) with [`../azure.yaml`](../azure.yaml) and the Bicep templates under [`../infra/`](../infra/):

- **`azure.yaml`** — Defines `name: copilot-studio-labs-portal` and the `portal` service (`host: containerapp`, `project: ./portal`, `docker.path: ./Dockerfile`, `docker.context: ..`, `docker.remoteBuild: true`).
- **`infra/main.bicep` & `infra/modules/`** — Subscription-scoped Bicep deployment creating:
  - Resource Group (`rg-<environmentName>`)
  - Log Analytics Workspace and Application Insights (`APPLICATIONINSIGHTS_CONNECTION_STRING`)
  - Azure Container Registry (`adminUserEnabled: false`)
  - User-Assigned Managed Identity + System-Assigned Managed Identity granted `AcrPull` on ACR (keyless image pull, no admin credentials, no circular dependency)
  - Container Apps Managed Environment and the `portal` Container App (`targetPort: 3005`, external HTTPS ingress, `0.5` vCPU / `1Gi` RAM, `1`–`3` HTTP-scaled replicas, `/healthz` health check)

Run the two-step deployment from the **repository root**:

```bash
azd auth login
azd env new <environment-name>

# 1. Provision Azure resources (deploys a bootstrap image so ACR + AcrPull exist first)
azd provision

# 2. Remotely build portal/Dockerfile in ACR and deploy the portal Container App revision
azd deploy
```

> [!NOTE]
> `infra/main.bicep` defaults `portalAuthDisabled` to `true` (`PORTAL_AUTH_DISABLED=true`) for demo and evaluation environments. Before exposing a shared deployment to untrusted networks, configure Entra ID authentication (see [`../docs/app-registration-setup.md`](../docs/app-registration-setup.md)) and set `azd env set AZURE_PORTAL_AUTH_DISABLED false` prior to `azd provision`. Use `azd down` to delete provisioned resources.

### Alternative: Azure App Service (Web App for Containers)

```bash
az acr build --registry <acr-name> --image copilot-labs-portal:latest -f portal/Dockerfile .

az webapp create \
  --resource-group <rg-name> \
  --plan <plan-name> \
  --name <app-name> \
  --deployment-container-image-name <acr-name>.azurecr.io/copilot-labs-portal:latest
```

## Configuration Reference

All configuration is provided through environment variables (see `.env.template`).

> [!IMPORTANT]
> The current browser client does not acquire or attach Microsoft Entra bearer tokens. An auth-enabled shared deployment therefore requires an authenticated reverse-proxy/BFF integration or a browser MSAL implementation. Do not work around this by setting `PORTAL_AUTH_DISABLED=true` outside loopback-only local development.

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Portal port (default: `3005`) |
| `HOST` | No | Listener address (default: `127.0.0.1`; container image and Container Apps use `0.0.0.0`) |
| `PORTAL_BASE_URL` | For approval links | Public portal URL used for approval callback and review links |
| `PORTAL_AUTH_DISABLED` | Local / demo only | Set to `true` to bypass Entra bearer-token authentication (`requireAuth()`); keep disabled (`false`) on shared production listeners |
| `PORTAL_API_AUDIENCE` | For authenticated deployment | Expected Entra access-token audience (`aud` claim, e.g. `api://<AZURE_CLIENT_ID>`) |
| `PORTAL_ALLOWED_USERS` | Optional | Comma-separated user allowlist (`upn` / `preferred_username`) |
| `PORTAL_ALLOWED_GROUPS` | Optional | Comma-separated Entra group object-ID allowlist |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | Optional | Azure Application Insights connection string (set automatically by `infra/main.bicep` on Container Apps) |
| **Azure / Entra ID** | | |
| `AZURE_TENANT_ID` | For Graph email / delegated auth | Entra tenant ID |
| `AZURE_CLIENT_ID` | For Graph email / delegated auth | App registration client ID |
| `AZURE_CLIENT_SECRET` | For Graph email | App registration secret |
| `AZURE_SUBSCRIPTION_ID` | For Azure deploy | Subscription for resource deployment |
| **Azure Key Vault** | | |
| `AZURE_KEYVAULT_URL` | Optional | Load secrets from Azure Key Vault instead of only `.env` |
| **SMTP** | | |
| `SMTP_HOST` | For SMTP email | SMTP hostname |
| `SMTP_PORT` | No | SMTP port (default: `587`) |
| `SMTP_SECURE` | No | Use SMTPS / secure transport |
| `SMTP_USER` | For SMTP auth | SMTP username |
| `SMTP_PASS` | For SMTP auth | SMTP password |
| `MAIL_FROM` | Yes for email | Sender address for SMTP or Graph |
| `EMAIL_RECIPIENT_ALLOWLIST` | Optional | Comma-separated extra recipients: exact addresses or `@domain` suffixes. Signed-in users can always email themselves |
| `EMAIL_RATE_WINDOW_MS` | No | Email rate-limit window (default: `3600000`) |
| `EMAIL_RATE_MAX` | No | Emails allowed per window (default: `10`) |
| **Deployment / Hosting** | | |
| `AZURE_WEBAPP_NAME` | Optional | Azure App Service name |
| `AZURE_RESOURCE_GROUP` | Optional | Resource group used by deployment |
| `AZURE_ACR_NAME` | Optional | Azure Container Registry name |
| `AZURE_ACR_IMAGE` | No | Image tag pushed to ACR |
| `MCP_SERVER_URL` | Optional | MCP server endpoint |
| **Power Platform** | | |
| `POWER_PLATFORM_ENV` | Optional | Default Power Platform environment URL |
| `POWER_PLATFORM_TENANT_ID` | Optional | Tenant ID override for Power Platform admin operations |
| `PP_CLIENT_ID` | Optional | Separate client ID for Power Platform device code auth |
| `PP_TENANT_ID` | Optional | Separate tenant ID for Power Platform device code auth |
| **Lab Builder** | | |
| `LEARN_MCP_URL` | No | Microsoft Learn MCP endpoint (default: `https://learn.microsoft.com/api/mcp`) |
| `LEARN_MCP_TIMEOUT_MS` | No | Learn MCP request timeout (default: `30000`) |
| `LAB_BUILDER_OUTPUT_DIR` | No | Output directory for generated labs (default: `../generated-labs`) |
| `LAB_BUILDER_MAX_ACTIVE` | No | Concurrent lab generations before the API returns HTTP 429 (default: `2`) |
| `LAB_BUILDER_RATE_MAX` | No | Lab generations allowed per user per window (default: `10`) |
| `LAB_BUILDER_RATE_WINDOW_MS` | No | Lab generation rate-limit window (default: `3600000`) |
| `LAB_BUILDER_MANAGE_RATE_MAX` | No | Generated-lab export/validate/rename/delete calls allowed per window (default: `60`) |
| `LAB_BUILDER_MANAGE_RATE_WINDOW_MS` | No | Generated-lab management rate-limit window (default: `3600000`) |
| `LAB_BUILDER_BODY_LIMIT` | No | Maximum JSON body size on `/api/lab-builder` routes (default: `64kb`) |
| `LAB_BUILDER_CONCURRENCY` | No | Modules grounded, derived, and enriched in parallel within one build (default: `4`) |
| `LAB_BUILDER_LINK_CHECK` | No | Set to `off` to skip citation liveness checks |
| `LAB_BUILDER_LINK_TIMEOUT_MS` | No | Citation liveness check timeout (default: `8000`) |
| `LAB_BUILDER_VENDOR_DOCS` | No | Set to `off` to skip fetching allowlisted third-party vendor documentation |
| `LAB_BUILDER_VENDOR_TIMEOUT_MS` | No | Vendor documentation fetch timeout (default: `10000`) |
| `LAB_BUILDER_TOPICS_FILE` | No | Snapshot cache path for discovered Microsoft Learn topics |
| `LAB_BUILDER_TOPICS_MAX_AGE_MS` | No | Maximum age before a discovered Learn topic snapshot is treated as stale (default: `604800000` / 7 days) |
| `LAB_BUILDER_TOPICS_REFRESH_MAX` | No | Topic discovery refreshes allowed per window (default: `6`) |
| `LAB_BUILDER_TOPICS_REFRESH_WINDOW_MS` | No | Topic discovery refresh rate-limit window (default: `3600000`) |
| `LAB_BUILDER_LLM` | No | Set to `off` to force deterministic composition |
| `LAB_BUILDER_LLM_TIMEOUT_MS` | No | Language model call timeout (default: `60000`) |
| `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT` | Optional | Azure OpenAI resource for LLM-drafted narrative |
| `AZURE_OPENAI_API_KEY` or `AZURE_OPENAI_AD_TOKEN` | With Azure OpenAI | API key, or a Microsoft Entra access token for a resource with key auth disabled |
| `AZURE_OPENAI_API_VERSION` | No | Azure OpenAI API version (default: `2024-10-21`) |
| `GITHUB_TOKEN` or `GITHUB_MODELS_TOKEN` | Optional | GitHub Models token, used when Azure OpenAI is not configured |
| `GITHUB_MODELS_MODEL`, `GITHUB_MODELS_ENDPOINT` | No | GitHub Models model and endpoint overrides |
| **Step validation** | | |
| `STEP_VALIDATION_MIN_INTERVAL_MS` | No | Minimum gap between Microsoft Learn calls (default: `250`) |
| `STEP_VALIDATION_MAX_CALLS` | No | Learn calls allowed per run before remaining claims become "unable to verify" (default: `2500`) |
| `STEP_VALIDATION_CACHE_DIR` | No | Directory for a persistent Learn response cache shared across runs (default: memory only) |
| `STEP_VALIDATION_CACHE_TTL_MS` | No | Cache lifetime for Learn responses (default: `86400000`) |
| `STEP_VALIDATION_RATE_MAX` | No | Runs that can be started per window (default: `20`) |
| `STEP_VALIDATION_RATE_WINDOW_MS` | No | Start rate-limit window (default: `3600000`) |
| **Feature Flags** | | |
| `ENABLE_GRAPH_EMAIL` | Optional | Force/enable Graph email usage |
| `ENABLE_AZURE_DEPLOY` | Optional | Enable Azure deployment workflows |

## API Endpoints

All `/api/*` routes pass through `requireAuth()` unless `PORTAL_AUTH_DISABLED=true` is set for local development or demo evaluation.

### Health Check

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/healthz` | Unauthenticated container liveness and readiness probe returning `{ "status": "ok" }` |

### Labs

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/labs` | List all labs with metadata |
| `GET` | `/api/labs/:id` | Get rendered lab HTML and branded markdown |
| `GET` | `/api/labs/:id/pdf` | Download a pre-generated lab walkthrough PDF |

### Feedback

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/feedback` | Save thumbs up/down feedback for a lab section |
| `GET` | `/api/feedback/:labId` | Retrieve feedback entries for a lab |

### Branding and brand profiles

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/branding` | Get the active profile's branding (company, tagline, color, logo, and the extended profile fields) |
| `POST` | `/api/branding` | Save company name, color, and tagline on the active profile |
| `POST` | `/api/branding/logo` | Upload a logo for the active profile |
| `DELETE` | `/api/branding/logo` | Remove the active profile's logo |
| `GET` / `POST` | `/api/branding/profiles` | List or create brand profiles |
| `GET` / `PATCH` / `DELETE` | `/api/branding/profiles/:id` | Read, update, or delete a profile |
| `POST` / `DELETE` | `/api/branding/profiles/:id/logo` | Upload or remove a profile logo |
| `POST` | `/api/branding/profiles/:id/activate` | Make a profile the active one |
| `POST` | `/api/branding/profiles/:id/duplicate` | Copy a profile |
| `GET` / `PATCH` | `/api/lab-builder/generated/:labId/customization` | Read or change a generated lab's profile and overrides (also at `/api/generated-labs/:labId/customization`) |

See [Brand profiles and lab customization](../docs/lab-builder.md#brand-profiles-and-lab-customization) for fields, tokens, and resolution order.

### Export / Email

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/export` | Build and download a customized ZIP package |
| `POST` | `/api/email` | Email a customized ZIP package |

### Validation

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/validate` | Run smoke tests across all labs |
| `GET` | `/api/validate/:labId` | Run smoke tests for a single lab |

These run the `lib/validator.js` rule set, the same one every generated lab must pass. `npm test` holds every lab under `labs/` to it, so a failing lab on the dashboard is a regression, not a standing state. [`../scripts/lab-validation-rules.json`](../scripts/lab-validation-rules.json) lists each rule and whether `validate_labs.py` checks it too.

Those checks are structural and finish instantly. The step-level check below goes further: it reads each lab's instructions and verifies what they say against Microsoft Learn.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/step-validation` | Start a run. Body: `{ "labIds": ["35-dlp-governance-policies"] }` (omit for all labs). Returns `202` with a `jobId`; `409` if a run is already active; `429` when rate limited |
| `GET` | `/api/step-validation/:jobId` | Progress (`labsDone`, `stepsDone`, current step and message) plus results so far (`completedLabs`, `currentLab`) and, when finished, the report summary |
| `DELETE` | `/api/step-validation/:jobId` | Cancel a running job; completed labs are kept |

In the **Validation** tab, **Run All Tests** runs the structural tests and then the step check, a lab's **Run** button does the same for that lab, and **Check all steps** runs only the step check. Progress is shown per lab and per step, and results stream in as each lab finishes. How it works, what each status means, the CLI, and the limits are in [`../docs/step-validation.md`](../docs/step-validation.md).

### Config / Key Vault

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/config` | Current non-secret portal configuration summary |
| `GET` | `/api/keyvault/status` | Key Vault status and secret mapping summary |
| `POST` | `/api/keyvault/provision` | Provision a Key Vault |
| `POST` | `/api/keyvault/sync` | Sync supported secrets to Key Vault |

### Power Platform

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/pp/auth/status` | Check delegated auth status and pending device code |
| `POST` | `/api/pp/auth/logout` | Clear cached device code tokens |
| `GET` | `/api/pp/environments` | List environments |
| `GET` | `/api/pp/environments/:id` | Get environment details |
| `POST` | `/api/pp/environments` | Create an environment |
| `DELETE` | `/api/pp/environments/:id` | Delete an environment |
| `GET` | `/api/pp/secure-score` | Get Power Platform Secure Score |
| `GET` | `/api/pp/recommendations` | Get security recommendations |
| `POST` | `/api/pp/remediate` | Apply a remediation action |
| `GET` | `/api/pp/tenant-settings` | Retrieve tenant settings |

### Approvals

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/pp/approval-config` | Get approval workflow settings |
| `POST` | `/api/pp/approval-config` | Save approval workflow settings |
| `GET` | `/api/pp/approval-requests` | List approval requests |
| `POST` | `/api/pp/approval-requests` | Submit an environment request |
| `GET` | `/api/pp/approval-requests/:id` | Get a single approval request |
| `POST` | `/api/pp/approval-requests/:id/approve` | Approve a request |
| `POST` | `/api/pp/approval-requests/:id/reject` | Reject a request |
| `GET` | `/api/pp/approval-callback` | Handle approval link callbacks |
| `POST` | `/api/pp/approval-callback` | Receive external approval decisions |

### Agent Chat

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/agent-chat/config` | Load the embedded Copilot Studio chat config |
| `POST` | `/api/agent-chat/config` | Save the token endpoint and display name |
| `DELETE` | `/api/agent-chat/config` | Disconnect the agent and clear stored config |

### Provisioning

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/provision/resources` | List resource requirements for all labs |
| `GET` | `/api/provision/resources/:labId` | List resources for a single lab |
| `GET` | `/api/provision/prerequisites` | Check Azure provisioning prerequisites |
| `POST` | `/api/provision/deploy` | Start Azure resource deployment |
| `GET` | `/api/provision/progress/:jobId` | Poll live deployment progress |
| `POST` | `/api/provision/destroy` | Destroy deployed Azure resources |
| `GET` | `/api/provision/status/:baseName` | Get current deployment status by base name |

### Use Case Builder and scenario setup

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/use-cases/options` | Use Case Builder inputs: industries, departments, goals, data sources, platforms, levels, limits, and whether AI polish is available |
| `POST` | `/api/use-cases/generate` | Ranked Copilot Studio and Agent Builder use cases for `{ industry, departments[], goals[], dataSources[], platform, level, polish }` (strict validation, 64 KB body, rate limited per user) |
| `GET` | `/api/scenarios` | List industry and role scenarios |
| `GET` | `/api/scenarios/:type/:id` | Get a single industry or role scenario |
| `POST` | `/api/scenarios/configure` | Build a suggested configuration overlay (used by **Apply scenario to Lab setup**) |

The request and response are documented in [`docs/lab-builder.md`](../docs/lab-builder.md#use-case-builder-api).

### Lab Builder

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/lab-builder/features` | Products (`6`), industries, roles, harnesses, levels, and the `195`-capability catalog |
| `POST` | `/api/lab-builder/recommend` | Compute level-filtered topic recommendations, prerequisite recaps, and dependency reasons |
| `GET` | `/api/lab-builder/topics` | Read discovered Microsoft Learn topics and snapshot freshness (optional `?product=<id>`) |
| `POST` | `/api/lab-builder/topics/refresh` | Crawl Microsoft Learn to refresh discovered topics for a product (`{ "product": "<id>" }`) |
| `POST` | `/api/lab-builder/preview` | Plan a lab (modules, recaps, estimated time, deliverable framing) without generating files |
| `POST` | `/api/lab-builder/generate` | Build a lab into `generated-labs/` (returns `complete`, `blocked`, or `cancelled`); supports `includeKnowledgeCheck`, SharePoint site inputs, `decisions`, and optional `replaceLabId` |
| `GET` | `/api/lab-builder/generated` | List generated labs (with saved selections, module counts, and per-topic document metadata) |
| `GET` | `/api/lab-builder/generated/:labId` | Read one generated lab (rendered HTML, branded Markdown, `adminPrerequisites`, and `topicDocuments`) |
| `GET` | `/api/lab-builder/generated/:labId/assets/:file` | Serve a generated lab screenshot or image asset (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`) |
| `GET` / `POST` | `/api/lab-builder/generated/:labId/export` | Export a generated lab as `format=zip` (default; accepts `formats=all\|docx\|pptx\|pdf\|html` for per-module titled folders), `html` (standalone paged HTML), `docx`, `pptx`, `pdf`, or `md` (also aliased at `/api/generated-labs/:labId/export`) |
| `GET` | `/api/lab-builder/generated/:labId/topics/:order/:format` | Download an individual module or recap handout/deck (`format=docx\|pptx`) named `<Lab Name> - Step NN - <Topic Name>.<ext>` (also aliased at `/api/generated-labs/:labId/topics/:order/:format`) |
| `GET` | `/api/lab-builder/generated/:labId/validate` | Run structural validation against a generated lab (also aliased at `/api/generated-labs/:labId/validate`) |
| `PATCH` | `/api/lab-builder/generated/:labId` | Rename a generated lab (`title` and/or `notes`) and sync `index.html` + per-topic `.docx`/`.pptx` files |
| `DELETE` | `/api/lab-builder/generated/:labId` | Delete a generated lab (never a hand-written one) |

Request and response shapes are documented in [`docs/lab-builder.md`](../docs/lab-builder.md#api).

## Architecture

```
azure.yaml                 Azure Developer CLI (azd) service manifest (Container Apps)
infra/
├── main.bicep             Subscription-scoped resource group, monitoring, ACR, RBAC, and Container App
└── modules/               Log Analytics + App Insights, ACR (adminUserEnabled: false), Managed Identity AcrPull, Container App
portal/
├── server.js              Express API (/healthz + /api/*) and static file server (port 3005)
├── lib/
│   ├── labs.js            Lab discovery and metadata extraction (40 hand-written labs)
│   ├── exporter.js        ZIP, HTML, DOCX, PPTX, PDF, and Markdown export for static and generated labs
│   ├── mailer.js          SMTP and Microsoft Graph email transport
│   ├── validator.js       Lab documentation smoke tests (structural, static + generated labs)
│   ├── step-validator/    Step-level accuracy check against Microsoft Learn (parser, claims, matcher, runner, jobs)
│   ├── markdown.js        Markdown rendering and HTML sanitization
│   ├── branding.js        Single-brand API (reads and writes the active brand profile), banner, and {{TOKEN}} replacement
│   ├── branding-profiles.js  Brand profiles, per-lab customization, and the CAPTURE_* environment mapping
│   ├── branding-routes.js    Brand profile and per-lab customization routes
│   ├── capture/           Screenshot capture platform: pairing, job queue, upload verification, companion download, routes
│   ├── scenarios.js       Industry and department scenario templates (also the Use Case Builder's industry and department lists)
│   ├── use-cases/         Use Case Builder: JSON data (capabilities, patterns, industries), generator, ranking, optional AI wording, routes
│   ├── provisioner.js     Azure resource provisioning engine
│   ├── keyvault.js        Azure Key Vault secret management
│   ├── powerplatform.js   Power Platform API (environments, Secure Score)
│   ├── auth.js            MSAL device code delegated auth
│   ├── require-auth.js    Entra ID bearer-token API middleware
│   ├── rate-limit.js      Fixed-window in-memory API rate limiter
│   ├── validate-id.js     Input validation for az CLI arguments
│   ├── approvals.js       Environment approval workflow engine
│   ├── agent-chat.js      Copilot Studio agent chat config
│   └── lab-builder/       6-product catalog (195 capabilities), planner, Learn MCP grounding, canonical URL dedup,
│                          admin-prereqs, interactive paged HTML, pure-Node DOCX/PDF/PPTX & per-topic document builders
├── test/                  Node test suites (npm test)
├── public/
│   ├── index.html             Single-page app UI (tabs, forms, preview, print styles)
│   ├── app.js                 Core portal frontend logic (pagination, checklists, mini-quizzes)
│   ├── lab-builder-wizard.js  8-step custom lab builder wizard UI (Step 7 includes Customize this lab)
│   ├── use-case-builder.js    Use Case Builder: live inputs, ranked use case cards, shortlist, Markdown/CSV export, and the hand-off to the wizard
│   ├── generated-labs.js      Generated lab manager, multi-format/per-topic export, print, and validation UI
│   ├── brand-ui.js            Brand validation, contrast, and live preview helpers shared by the UI
│   ├── lab-customize.js       Saved-lab Customize section (profile, overrides, Update from profile, Reset)
│   ├── screenshot-center*.js  Screenshot Center: pure decisions, network calls (pairing, jobs, uploads), and rendering
│   ├── lab-checklist.js       "Finish your lab" checklist and the "N of 5 ready" chip on saved-lab cards
│   ├── readiness-hub.js       Setup checklist (Configuration) and first-run banner (Build)
│   ├── step-validation.js     Step validation UI (progress and results)
│   ├── step-validation.css    Step validation styles
│   ├── theme.js               Light/dark color theme toggle and persistence
│   └── vendor/
│       └── mermaid.min.js     Mermaid diagram renderer
├── data/                  Runtime data (feedback, branding and brand profiles, approvals, agent config)
├── Dockerfile             Production container build (node:24-alpine, port 3005, /healthz)
├── docker-compose.yml     Local container orchestration
└── .env.template          Configuration template
```
