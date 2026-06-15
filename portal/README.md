# ⚡ Copilot Studio Labs — Provisioning Portal

A web-based lab operations portal for customizing, validating, previewing, provisioning, approving, exporting, and supporting Copilot Studio training labs at scale.

## Features

- **📚 Chapter Management** — Include or exclude lab chapters from the package with one click
- **🗺️ Lab Flow Diagrams** — Render Mermaid diagrams inside lab previews to visualize architecture and process flow
- **🗺️ Lab Dependency Map** — View a top-level Mermaid sequence map showing recommended lab order
- **🎨 Customization** — Replace organization names, industry context, compliance terms, agent names, end-user roles, and branding
- **🏢 Industry Scenario Planner** — Apply preconfigured industry and role templates to lab selection and content defaults
- **👁️ Lab Preview** — Read fully rendered labs in the browser with table of contents, image lightbox, and PDF download links where available
- **👍 Inline Feedback** — Capture thumbs up/down feedback on sections and checkpoints
- **🐛 Issue Reporting** — Open a GitHub issue with current lab context in one click
- **🖨️ Print Support** — Clean print styling for exported or previewed lab walkthroughs
- **📥 Export** — Build ZIP packages with customized content replacements
- **📧 Email** — Send lab bundles through SMTP or Microsoft Graph
- **☁️ Azure Resources** — Check prerequisites, inspect resource manifests, deploy resources, monitor progress, and destroy environments
- **⚡ Power Platform** — Use device code auth to list, create, and delete environments, inspect Secure Score, review recommendations, remediate issues, and schedule admin activities
- **🔐 Approval Workflows** — Gate environment provisioning with None, Portal, Power Automate, Logic Apps, Copilot Studio, or Teams Adaptive Card approvals
- **📢 Notifications** — Send approval lifecycle notifications via Teams Adaptive Cards and email
- **🤖 Agent Chat** — Embed a Copilot Studio agent chat widget for real-time lab guidance and troubleshooting
- **🧪 Validation** — Run documentation smoke tests across all labs or a single lab
- **⚙️ Configuration** — Review Azure, Key Vault, SMTP, branding, and deployment settings in one place
- **🐳 Container-Ready** — Run locally, in Docker, or in Azure App Service

## Quick Start

### Local development

```bash
cd portal
npm install
cp .env.template .env
npm run dev
```

Open [http://localhost:3005](http://localhost:3005)

### Docker deployment

```bash
cd portal
docker compose up --build

# Or build/run directly
docker build -t copilot-labs-portal -f portal/Dockerfile .
docker run -p 3005:3005 --env-file portal/.env copilot-labs-portal
```

### Azure Web App deployment

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

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Portal port (default: `3005`) |
| `PORTAL_BASE_URL` | For approval links | Public portal URL used for approval callback and review links |
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
| **Feature Flags** | | |
| `ENABLE_GRAPH_EMAIL` | Optional | Force/enable Graph email usage |
| `ENABLE_AZURE_DEPLOY` | Optional | Enable Azure deployment workflows |

## API Endpoints

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

### Branding

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/branding` | Get current branding |
| `POST` | `/api/branding` | Save company name, color, and tagline |
| `POST` | `/api/branding/logo` | Upload a logo |
| `DELETE` | `/api/branding/logo` | Remove the uploaded logo |

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

### Scenario Planner

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/scenarios` | List industry and role scenarios |
| `GET` | `/api/scenarios/:type/:id` | Get a single industry or role scenario |
| `POST` | `/api/scenarios/configure` | Build a suggested configuration overlay |

## Architecture

```
portal/
├── server.js              Express API + static file server
├── lib/
│   ├── labs.js            Lab discovery and metadata extraction
│   ├── exporter.js        ZIP archive generation with text customization
│   ├── mailer.js          SMTP and Microsoft Graph email transport
│   ├── validator.js       Lab documentation smoke tests
│   ├── branding.js        Company branding management
│   ├── scenarios.js       Industry scenario templates
│   ├── provisioner.js     Azure resource provisioning engine
│   ├── keyvault.js        Azure Key Vault secret management
│   ├── powerplatform.js   Power Platform API (environments, Secure Score)
│   ├── auth.js            MSAL device code delegated auth
│   ├── approvals.js       Environment approval workflow engine
│   └── agent-chat.js      Copilot Studio agent chat config
├── public/
│   ├── index.html         Single-page app UI (tabs, forms, preview)
│   ├── app.js             Frontend logic
│   └── vendor/
│       └── mermaid.min.js Mermaid diagram renderer
├── data/                  Runtime data (feedback, branding, approvals, agent config)
├── Dockerfile             Production container build
├── docker-compose.yml     Container orchestration
└── .env.template          Configuration template
```
