# ⚡ Copilot Studio Labs — Provisioning Portal

A web-based lab provisioning and de-provisioning tool for managing Copilot Studio training labs at scale.

## Features

- **📚 Chapter Management** — Include/exclude lab chapters with one click based on topic, difficulty, and audience
- **🎨 Customization** — Replace organization names, industry, compliance standards, and branding across all content
- **📥 Export** — Download customized lab packages as ZIP
- **📧 Email** — Send lab packages to any number of recipients (SMTP or Microsoft Graph)
- **⚙️ Configuration Dashboard** — Manage Azure, email, MCP, and deployment settings
- **🐳 Container-Ready** — Deploy as a Docker container in any tenant

## Quick Start

### Local development

```bash
cd portal
npm install
cp .env.template .env     # edit with your settings
npm run dev                # starts with --watch for auto-reload
```

Open [http://localhost:3000](http://localhost:3000)

### Docker deployment

```bash
# Build and run
cd portal
docker compose up --build

# Or build the image directly
docker build -t copilot-labs-portal -f portal/Dockerfile .
docker run -p 3000:3000 --env-file portal/.env copilot-labs-portal
```

### Azure Web App deployment

```bash
# Build and push to ACR
az acr build --registry <acr-name> --image copilot-labs-portal:latest -f portal/Dockerfile .

# Create or update the Web App
az webapp create \
  --resource-group <rg-name> \
  --plan <plan-name> \
  --name <app-name> \
  --deployment-container-image-name <acr-name>.azurecr.io/copilot-labs-portal:latest
```

## Configuration Reference

All configuration is via environment variables (see `.env.template`):

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Portal port (default: 3000) |
| **Azure / Entra ID** | | |
| `AZURE_TENANT_ID` | For Graph email | Azure AD tenant ID |
| `AZURE_CLIENT_ID` | For Graph email | App registration client ID |
| `AZURE_CLIENT_SECRET` | For Graph email | App registration secret |
| `AZURE_SUBSCRIPTION_ID` | For deployment | Azure subscription |
| **Email (SMTP)** | | |
| `SMTP_HOST` | For SMTP email | SMTP server hostname |
| `SMTP_PORT` | No | SMTP port (default: 587) |
| `SMTP_USER` | For SMTP auth | SMTP username |
| `SMTP_PASS` | For SMTP auth | SMTP password |
| `MAIL_FROM` | Yes | Sender email address |
| **Deployment** | | |
| `AZURE_WEBAPP_NAME` | For Azure deploy | App Service name |
| `AZURE_RESOURCE_GROUP` | For Azure deploy | Resource group |
| `AZURE_ACR_NAME` | For container push | Container registry name |
| `MCP_SERVER_URL` | For MCP integration | MCP server endpoint |
| `POWER_PLATFORM_ENV` | For agent provisioning | Power Platform environment URL |

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/labs` | List all labs with metadata |
| `GET` | `/api/labs/:id` | Get lab content as HTML |
| `POST` | `/api/export` | Download ZIP of selected labs |
| `POST` | `/api/email` | Email lab package to recipients |
| `GET` | `/api/config` | Current configuration status |

## Architecture

```
portal/
├── server.js              Express API + static file server
├── lib/
│   ├── labs.js            Lab discovery and metadata extraction
│   ├── exporter.js        ZIP archive generation with text customization
│   └── mailer.js          SMTP and Microsoft Graph email transport
├── public/
│   ├── index.html         Single-page app UI
│   └── app.js             Frontend logic
├── Dockerfile             Production container build
├── docker-compose.yml     Container orchestration
└── .env.template          Configuration template
```
