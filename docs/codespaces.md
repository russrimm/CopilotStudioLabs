# Open Copilot Studio Labs in GitHub Codespaces

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/russrimm/CopilotStudioLabs?quickstart=1)

Use Codespaces when you want to run the Node.js-based lab tooling without installing Node.js, GitHub CLI, `jq`, or VS Code extensions locally.

## What the Codespace includes

- Node.js 20 LTS
- GitHub CLI (`gh`), `jq`, Python 3, zip/unzip, and common Linux utilities
- VS Code extensions for GitHub Copilot, Copilot Chat, Power Platform Tools, Markdown, and Node.js
- Forwarded ports for common lab servers:
  - `3005` — provisioning portal
  - `3001` — alternate/secondary Node service
  - `5173` — Lab 18 Vite web SDK sample
  - `8080` — alternate web service
- Post-create dependency install for the root template, portal, PDF tool, and screenshot tool

## Start a Codespace

1. Select the badge above, or open the repository on GitHub and choose **Code > Codespaces > Create codespace on main**.
2. Wait for the post-create install tasks to finish.
3. Open the lab Markdown file you want to run from the `labs` folder.

If you use this repo as a template or fork, update the badge URL to your repository:

```markdown
[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/OWNER/REPO?quickstart=1)
```

## Lab notes

- **Lab 03** uses Copilot Studio-hosted Dataverse and sample MCP connectors. Codespaces supplies the Node/VS Code environment, but the lab still requires the Power Platform tenant features and connector availability described in the lab.
- **Lab 04 optional MCP section** can be built directly in Codespaces. Run the sample MCP server on port `3000`, then make the forwarded port public before using the HTTPS URL plus `/mcp` in Copilot Studio.
- **Lab 05** benefits from the Power Platform VS Code extension in the container. Cloud authentication and publishing still happen against your Copilot Studio environment.
- **Lab 07** is primarily an A2A/Copilot Studio + Fabric walkthrough. No local MCP server code was found, but the Codespace is ready for any supporting Node experiments.
- **Lab 18** has a Vite sample under `labs/32-embed-agent-web-sdk/sample` and uses forwarded port `5173`, but its current `@microsoft/agents-copilotstudio-client@^0.5.0` dependency was not available from npm during validation. Update that package version before relying on the sample in Codespaces.

## Follow-up items

- Codespaces does not provision a Power Platform environment, Copilot Studio license, Dataverse MCP feature, Fabric agent, or public MCP authentication policy.
- Copilot Studio can only call an MCP server through a reachable URL. For short labs, use the public Codespaces forwarded URL for port `3000`; for production or shared classrooms, deploy the MCP server to Azure Container Apps or App Service.
