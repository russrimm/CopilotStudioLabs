# Lab 04 Accuracy Audit
Date: 2026-06-15T00:18:00-05:00
Author: Kane
Audited file: labs/04-energy-census-advanced-agent/index.md

## Summary
- ✅ Verified accurate: 66
- 🟡 Drift / minor (still works but doc-wording is stale): 8
- 🔴 Wrong / broken (will block or mislead a user): 3
- ❓ Could not verify: 4

Verification methods used: `curl -I -L` for URLs, GET fallback where HEAD was unsupported, Census API discovery/variables endpoints, Census county code files, npm/PyPI metadata, and current Microsoft Learn documentation.

## Findings (grouped by severity, then category)

### 🔴 Critical
- **[MCP / Copilot Studio]** [Lines 958-960, 1008-1014]: claim says to stand up a local MCP server and register it in Copilot Studio → current Microsoft Learn says Copilot Studio connects to MCP servers through the MCP onboarding wizard using a **Server URL** and currently supports **Streamable** transport; it does not document local stdio command registration for Copilot Studio → recommended fix: change the optional section to a reachable Streamable HTTP MCP server (or custom connector) and cite the wizard fields.
- **[MCP / Configuration]** [Lines 1017-1031]: sample `mcpServers` JSON uses `command`, `args`, and `env` for a local `node` process → that is a desktop/VS Code-style stdio client configuration, not the Copilot Studio MCP wizard shape documented by Microsoft Learn → recommended fix: remove it from Copilot Studio instructions or explicitly label it as non-Copilot-Studio local-client config, then add Copilot Studio fields: server name, description, server URL, auth type.
- **[MCP / Runtime validation]** [Lines 1033-1039]: test steps assume Copilot Studio can discover and invoke tools from the local stdio server as written → because Copilot Studio docs require a connected MCP server/connector over supported transport, these runtime steps will not work from the provided local config → recommended fix: test after registering a Streamable HTTP MCP server/connector and adding its tools/resources to the agent.

### 🟡 Minor
- **[URL / HEAD behavior]** [Line 200]: `https://copilotstudio.microsoft.com/` returned `405` to `curl -I -L`, but `GET` returned `200` at the same final URL → link works for users, but it does not satisfy strict HEAD checking → recommended fix: note that this app endpoint blocks HEAD or validate with GET.
- **[Copilot Studio UI wording]** [Lines 200-204]: lab says users land on **What would you like to build?** with **Start building from scratch** tiles → current Learn quickstart documents landing on **Home** and creating via a natural-language description; exact tile wording wasn't documented → recommended fix: soften to “Home page/create experience may vary; choose Agent or describe the agent.”
- **[Copilot Studio HTTP tooling]** [Lines 523-525, 555-559]: lab says open **Tools** > **Add tool** and choose an **HTTP action** → current Learn documents direct REST calls as an **HTTP Request** node under **Advanced** > **Send HTTP request**; connector/flow tools are added from Tools → recommended fix: distinguish “HTTP Request node in a topic” from “custom connector/flow tool.”
- **[Evaluation UI wording]** [Lines 873-883]: lab says **Create a test set** and methods **Similarity / General quality / Keyword match** → current Learn says **New evaluation** > **Single response** and lists **Text similarity** in the UI table, while CSV import accepts `Similarity` → recommended fix: use “New evaluation > Single response” and “Text similarity (Similarity in import files).”
- **[Economic Census dataset year]** [Lines 93, 111, 356]: `/data/{year}/ecnbasic` exists for valid Economic Census years checked (`2022`, `2017`) but `2023/ecnbasic` returns `404` → recommended fix: say Economic Census is year-specific and use `2022/ecnbasic` in examples rather than implying the ACS default year works.
- **[Power Automate creation path]** [Lines 721-723]: trigger/action names are correct, but current Copilot Studio Learn emphasizes creating an **Agent flow** from Copilot Studio **Flows** > **New flow** > **Agent flow**; Power Automate route may be tenant-dependent → recommended fix: prefer the Copilot Studio flow creation path or add as an alternative.
- **[Census wording]** [Line 132]: `state:06 county:113` verifies as Contra Costa County, California; the lab phrase “energy corridor county” is not an official Census designation → recommended fix: either name the county or call it a sample county.
- **[MCP docs nuance]** [Line 1042]: lab says schemas become discoverable at runtime → Learn confirms MCP tools/resources expose names, descriptions, inputs, and outputs and update dynamically; “schemas” is acceptable but imprecise → recommended fix: use “tool/resource metadata and input/output schemas.”

### ✅ Verified (one-line list, no detail needed)
- [Line 8]: 15 + 150 + 15 = 180 minutes = 3 hours.
- [Line 92]: ACS 5-Year endpoint path `/data/2023/acs/acs5` exists (`200`).
- [Line 94]: FIPS state/county code length claim matches Census convention (state 2 digits, county 3 digits).
- [Line 95]: Census geography hierarchy state → county → tract → block group is valid for ACS geographies.
- [Line 108]: URL `https://api.census.gov/data/` → `200`.
- [Line 109]: URL `https://api.census.gov/data/key_signup.html` → `200`, title `Key Signup`.
- [Lines 120-125]: key signup form has Organization Name, Email Address, terms checkbox, Request Key button, and no payment fields.
- [Line 112]: Census variable `B01003_001E` → concept `Total Population`; matches lab claim “Population.”
- [Line 113]: Census variable `B19013_001E` → median household income concept/label; matches lab claim.
- [Line 114]: Census variable `B25001_001E` → concept `Housing Units`; matches lab claim.
- [Line 115]: Census variable `B25024_001E` → concept `Units in Structure`; matches lab claim.
- [Line 116]: Census variable `C24050_001E` → total row for civilian employed population 16+ by industry/occupation; matches lab intent.
- [Line 117]: Census variable `C24050_004E` → label includes `Manufacturing`; matches lab claim.
- [Line 118]: Census variable `B08301_001E` → concept `Means of Transportation to Work`; matches commute-pattern claim.
- [Line 130]: sample ACS county population URL shape returns Census `Invalid Key` page with fake key, confirming endpoint/parameter shape is valid.
- [Line 132]: sample ACS income URL shape returns Census `Invalid Key` page with fake key, confirming endpoint/parameter shape is valid.
- [Line 134]: sample ACS housing URL shape returns Census `Invalid Key` page with fake key, confirming endpoint/parameter shape is valid.
- [Line 136]: Census API invalid/missing key responses are HTML, while valid data API responses are documented as array-style rows; row-0 header/row-1 value guidance is consistent.
- [Line 142]: URL `https://learn.microsoft.com/en-us/microsoft-copilot-studio/authoring-create-edit-topics` → `200`.
- [Line 143]: URL `https://learn.microsoft.com/en-us/microsoft-copilot-studio/authoring-variables-about` → `200`.
- [Line 144]: URL `https://learn.microsoft.com/en-us/microsoft-copilot-studio/authoring-add-other-agents` → `200`.
- [Line 145]: URL `https://learn.microsoft.com/en-us/microsoft-copilot-studio/flows-overview` → `200`.
- [Line 146]: URL `https://learn.microsoft.com/en-us/microsoft-copilot-studio/advanced-use-flow` → `200`.
- [Line 147]: URL `https://learn.microsoft.com/en-us/microsoft-copilot-studio/authoring-select-agent-model` → `200`.
- [Line 148]: URL `https://learn.microsoft.com/en-us/microsoft-copilot-studio/agent-extend-action-mcp` → `200`.
- [Line 149]: URL `https://learn.microsoft.com/en-us/microsoft-copilot-studio/analytics-agent-evaluation-intro` → `200`.
- [Line 150]: URL `https://learn.microsoft.com/en-us/microsoft-copilot-studio/analytics-agent-evaluation-results` → `200`.
- [Line 151]: URL `https://api.census.gov/data.html` → `200`.
- [Line 152]: URL `https://www.census.gov/data/developers/guidance/api-user-guide.html` → `200`.
- [Line 153]: URL `https://api.census.gov/data/key_signup.html` → `200`.
- [Line 161]: URL `https://api.census.gov/data/key_signup.html` → `200`.
- [Line 164]: npm package `@modelcontextprotocol/sdk` exists; current metadata shows Node engine `>=18`.
- [Line 164]: PyPI package `mcp` exists; current metadata shows Python requirement `>=3.10`.
- [Line 221]: current Learn documents **Add a topic** > **From blank**.
- [Line 241]: current Learn documents **Message** node for sending messages.
- [Line 245]: current Learn documents **Ask with Adaptive Card** / **Adaptive Card** node.
- [Line 249]: URL `https://adaptivecards.io/schemas/adaptive-card.json` → `200`.
- [Lines 251-295]: Adaptive Card payload uses schema version 1.5 and valid `Input.Text` / `Action.Submit` properties; Copilot Studio docs support Adaptive Cards 1.6 and earlier, with Teams/live chat limited to 1.5.
- [Line 300]: current Learn says Copilot Studio automatically creates output variables based on Adaptive Card inputs.
- [Lines 304-307]: mapping Adaptive Card inputs to topic variables is consistent with Adaptive Card output-variable behavior.
- [Line 317]: current Learn documents **Set variable value** node.
- [Line 318]: current Learn documents using **Power Fx formula** for variable values.
- [Lines 321-330]: Power Fx `Switch(Upper(...), ...)` syntax is valid Power Fx pattern.
- [Line 340]: Cypress, TX / ZIP 77433 spot-check is consistent with Harris County, TX.
- [Line 342]: “Jefferson County” non-unique warning is accurate; multiple states have a Jefferson County.
- [Lines 430-431]: `System.Activity.Text` and `System.Conversation.Id` are current documented system variables.
- [Line 479]: county demographics URL template shape validates against ACS 2023 with fake key (`Invalid Key`, not malformed URL).
- [Line 485]: state employment URL template shape validates against ACS 2023 with fake key (`Invalid Key`, not malformed URL).
- [Line 558]: county demographics endpoint pattern validates against ACS 2023 with fake key (`Invalid Key`, not malformed URL).
- [Line 599]: state employment endpoint pattern validates against ACS 2023 with fake key (`Invalid Key`, not malformed URL).
- [Lines 607-608]: Texas state FIPS `48` and Harris County FIPS `201` verified via Census county code file.
- [Line 672]: connected agent prerequisites verified: same environment, published, configured to allow connections.
- [Lines 677-678]: current Learn documents **Agents** page and **Add an agent** for connected agents.
- [Lines 721-724]: current Learn verifies trigger name **When an agent calls the flow**.
- [Line 742]: Power Automate inline expression form `@{triggerBody()['dataYear']}` is consistent with Workflow Definition Language interpolation syntax.
- [Line 747]: Power Automate inline expression form `@{triggerBody()['stateFips']}` / `apiKey` is consistent with WDL interpolation syntax.
- [Line 768]: current Learn verifies response action name **Respond to the agent**.
- [Line 819]: model availability varies by region/tenant; current Learn model table confirms regional and release-type variation.
- [Lines 831-843]: quality/speed/cost model tradeoff guidance aligns with current Learn model categories (Deep/General/Auto latency and cost tradeoffs).
- [Lines 873-921]: Evaluation page, pass/fail results, activity map, pass rate, failed cases, and run flow are documented in current Learn.
- [Line 896]: 10-question table contains exactly 10 test questions.
- [Line 984]: npm package `@modelcontextprotocol/sdk` exists; import path family is consistent with current SDK package naming.
- [Line 998]: ESM note is accurate for `.js` files using `import` syntax in Node.
- [Line 1037]: Tarrant County, Texas FIPS `439` verified via Census county code file.
- [Line 1085]: URL `https://learn.microsoft.com/en-us/microsoft-copilot-studio/visual-studio-code-extension-install-configure` → `200`.
- [Line 1103]: URL `https://learn.microsoft.com/en-us/microsoft-copilot-studio/visual-studio-code-extension-edit-agent-components` → `200`.

### ❓ Could not verify
- **[Copilot Studio tenant UI]** [Lines 200-204]: exact home-page tile text **What would you like to build?**, **Start building from scratch**, **Agent**, **Computer-using agent**, **Create workflow** → not all exact strings appear in public Learn pages fetched; requires live tenant UI check → suggested next step: have Lambert/Dallas confirm against current lab tenant screenshot.
- **[Census API key email delivery]** [Lines 122-124]: delivery by email and no published exact SLA are plausible and consistent with signup flow, but I did not receive a real key email during audit → suggested next step: verify with a disposable/test signup if required.
- **[Copilot Studio card mapping UI]** [Lines 304-309]: exact panel label **Save user response as** for Adaptive Card output mapping was not confirmed in current Learn text, though output variables are documented → suggested next step: verify in tenant UI.
- **[Copilot Studio VS Code commands]** [Lines 1089-1091, 1107-1109]: Learn pages resolve, but exact command-palette command names and sync prompts were not exhaustively checked because the extension was not installed in this environment → suggested next step: verify in VS Code extension UI during lab dry run.

## Re-audit after Dallas MCP rewrite (2026-06-15T00:35:00-05:00)

### Original criticals → resolution verdict
- **Local stdio server registered in Copilot Studio** → 🟢 Resolved. Use Case #8 now correctly says Copilot Studio needs a reachable URL and can't start a local `node server.js` process.
- **Desktop-client `mcpServers` command/args/env JSON used as Copilot Studio config** → 🟢 Resolved. The JSON block is gone and the section now uses the MCP onboarding wizard fields: Server name, Server description, Server URL, and auth type.
- **Runtime validation assumes Copilot Studio can discover/invoke from local stdio config** → 🟡 Partially resolved. The test path now targets the Copilot Studio MCP wizard and reachable Streamable HTTP endpoint, but the provided Node Streamable HTTP sample is not actually usable for discovery/invocation as written.

### New findings introduced/remaining in Use Case #8
- 🔴 **[MCP SDK / Streamable HTTP sample]** Lines 1061-1066 create one singleton `StreamableHTTPServerTransport`, connect it once, then reuse it for every HTTP request. With `@modelcontextprotocol/sdk@1.29.0`, this pattern initializes successfully but subsequent `notifications/initialized` and `tools/list` POSTs return `500` in a smoke test. The SDK v1.x stateless example creates a fresh `McpServer` and `StreamableHTTPServerTransport({ sessionIdGenerator: undefined })` per POST and calls `transport.handleRequest(req, res, req.body)`; the stateful example stores transports by `mcp-session-id`. Recommended fix: replace the singleton Node `http` sample with the official stateless or stateful pattern.
- 🟡 **[Dev tunnels / reachability nuance]** Lines 1087-1088 are directionally correct, but `devtunnel host --port 3000` and VS Code port forwarding are private/authenticated by default. Copilot Studio cloud reachability requires a public/anonymous tunnel URL or an auth mechanism Copilot Studio can supply. The VS Code line says set visibility appropriately and troubleshooting mentions interactive sign-in, so this is minor wording rather than a blocker.

### Checks with no new issue
- Microsoft Learn URLs in Use Case #8 returned `200` with `curl -I -L` and canonicalized to `/en-us/...`.
- The ngrok, VS Code port forwarding, and Azure Dev Tunnels documentation URLs returned `200` with `curl -I -L`.
- Copilot Studio wizard field names and path match current Learn: Tools → Add a tool → New tool → Model Context Protocol; required fields Server name, Server description, Server URL; auth types None, API key, OAuth 2.0; Add tool connection flow.
- `npm i @modelcontextprotocol/sdk zod` is accurate; npm currently reports `@modelcontextprotocol/sdk` version `1.29.0`, Node engine `>=18`, and peer dependency `zod ^3.25 || ^4.0`.

### Overall section verdict
🔴 Use Case #8 is still not shippable as-is because the core MCP server code sample does not support the post-initialize tool discovery request sequence with SDK 1.29.0.

## Re-audit after Ripley MCP fix (2026-06-15T00:50:00-05:00)

- 🔴 **SDK pattern** → 🟢 Resolved. Current Use Case #8 now uses the stateless per-request Express + `StreamableHTTPServerTransport({ sessionIdGenerator: undefined })` pattern: each POST creates a fresh `McpServer`, connects a fresh transport, and calls `transport.handleRequest(req, res, req.body)`. I smoke-tested the same pattern in `%LOCALAPPDATA%\Temp\kane-mcp-smoke` with a no-op `get_population` tool and no Census key. Results:
  - `initialize` POST: HTTP `200`; SSE response included `protocolVersion: "2025-06-18"`, `capabilities.tools.listChanged: true`, and server info `kane-smoke-mcp`.
  - `notifications/initialized` POST: HTTP `202`; empty body, which is expected for the notification.
  - `tools/list` POST: HTTP `200`; SSE response listed the no-op `get_population` tool and its input schema.
  - No `500` responses, no hangs, and server stderr was empty. Smoke-test directory cleanup: cleaned.
- 🟡 **dev-tunnel default privacy nuance** → 🟢 Resolved. Current text explicitly says VS Code forwarded ports are private by default and must be made public, and that `devtunnel host -p 3000` creates a private tunnel by default. It gives the correct short-lab command, `devtunnel host -p 3000 --allow-anonymous`, unless configuring an auth mechanism Copilot Studio can supply.
- **Overall Use Case #8:** 🟢 Ship. The two previously open MCP accuracy items are resolved, and the stateless Streamable HTTP sample passed the canonical initialize → initialized notification → tools/list sequence.
