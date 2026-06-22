# Squad Decisions

## 2026-06-15 — 2026-06-15T12:34:51-05:00: Dallas portal port change

Owner: Dallas
Merged by: Scribe
Source: .squad/decisions/inbox/dallas-port-change.md
Requested by: Russ Rimmerman

### Decision summary

Changed CopilotStudioLabs portal defaults and deployment config from port 3000 to 3005.

Key decisions:

- Portal runtime, Docker, devcontainer, Codespaces docs, approval link fallbacks, and portal Azure IaC defaults were updated.
- Lab 04 MCP sample instructions still use port 3000 because those references are for a separate sample MCP server, not the portal.
- Lab 06 account number 30001234 was left unchanged.

### Follow-up

If any Entra/Azure AD app registration redirect/reply URL points to http://localhost:3000, Russ should update it externally to http://localhost:3005.

### Validation

- `git diff --check` passed
- `node --check` passed
- JSON parse validation passed

---

## 2026-06-15 — 2026-06-15T12:21:41-05:00: Dallas verify-app-reg script

Owner: Dallas
Merged by: Scribe
Source: .squad/decisions/inbox/dallas-verify-script.md
Requested by: Russ Rimmerman

### Decision summary

Built `scripts/verify-app-reg.js` (Node, no new deps, uses native fetch). Tests AAD token acquisition + Dataverse WhoAmI; surfaces AADSTS error codes with fixes.

Key decisions:

- Used native Node 18 `fetch` for OAuth token acquisition instead of adding `@azure/identity`, because the root package does not depend on `@azure/identity` and the task asked to stay dependency-light.
- The script tries to load `.env.local` with `dotenv` when available, including the existing portal dependency if installed, then falls back to a small built-in parser so `npm run verify:appreg` can run from the repo root without adding a new root dependency.
- Default token-only validation uses `https://service.flow.microsoft.com/.default`; Dataverse validation switches to `{envUrl}/.default` and calls `WhoAmI` only when `--env-url` is provided.

### Files modified

- `scripts/verify-app-reg.js` — new script
- `package.json` — added `verify:appreg` script
- `docs/app-registration-setup.md` — updated Section 5 with script usage

---

## 2026-06-15 — 2026-06-15T10:48:18-05:00: Dallas app registration audit — Labs 03, 05, 07

Owner: Dallas
Merged by: Scribe
Source: .squad/decisions/inbox/dallas-app-reg-audit.md
Requested by: Russ Rimmerman

### Decision summary

Created `docs\app-registration-setup.md` after auditing Labs 03, 05, and 07 plus root-level auth clues.

Key decisions recorded in the doc:

- Lab 03 is the only audited lab with Dataverse/MCP runtime relevance. Client credentials can help only for custom backend/MCP Dataverse calls after creating a Dataverse application user and assigning environment security roles.
- Lab 05 requires delegated VS Code extension sign-in; client credentials alone cannot clone/apply/publish agents.
- Lab 07 requires delegated Copilot Studio/Fabric authoring access; client credentials may only be part of a separate external A2A OAuth endpoint configuration.
- Do not tell Russ to rely on `Dynamics CRM / user_impersonation` for app-only Dataverse access; it is delegated. For app-only Dataverse, the environment application user and security roles are the controlling access path.
- Microsoft Graph `Mail.Send` Application is needed only for the root portal Graph email path, not directly for Labs 03/05/07.
- Power Platform API service-principal access uses Power Platform RBAC roles rather than application permissions.

### Evidence highlights

- Lab 03: `labs\03-account-orchestration-agent\index.md` lines 314-353 enable Dataverse Intelligence/MCP and add Microsoft Dataverse MCP Server; lines 459-479 add sample Order/Warehouse MCP connections with no credentials required.
- Lab 05: `labs\05-copilot-studio-vscode-agent-management\index.md` lines 69-75 and 83-93 require Microsoft account/VS Code sign-in and environment access.
- Lab 07: `labs\07-agent-to-agent-protocol\index.md` lines 95-100 require Copilot Studio/Fabric access; lines 238-245 explicitly call out possible additional consent or delegated authorization.
- Root: `.env.local.example` notes Power Platform uses delegated auth/device code; `portal\lib\auth.js` uses MSAL device code; `portal\lib\mailer.js` uses Graph client credentials; `portal\lib\provisioner.js` comments on Graph SharePoint permissions.

---

## 2026-06-15 — 2026-06-15T00:15:18-05:00: User directive

## 2026-06-15 — 2026-06-15T00:15:18-05:00: User directive

Owner: Russ Rimmerman
Merged by: Scribe
Source: .squad/decisions/inbox/copilot-directive-2026-06-15T00-15-18.md

### Preserved inbox entry

### 2026-06-15T00:15:18-05:00: User directive
**By:** Russ Rimmerman (via Copilot)
**What:** Maximize end-user smoothness across all labs — eliminate sticking points, surface every prerequisite/gotcha up front. Every claim in every lab must be verified to 100% accuracy before shipping.
**Why:** User request — captured for team memory. Applies to ALL labs (01-05) and any future lab content. Lambert (content) and Kane (verification) should default to "would a first-timer get stuck here?" as the bar.

## 2026-06-15 — Lambert Lab 04 smoothness pass

Owner: Lambert
Merged by: Scribe
Source: .squad/decisions/inbox/lambert-lab04-smoothness-pass.md

### Preserved inbox entry

# Lambert Lab 04 smoothness pass

Requested by: Russ Rimmerman
Timestamp: 2026-06-15T00:15:18-05:00

## Summary

- Added a `What to expect when requesting a Census API key` callout in `labs/04-energy-census-advanced-agent/index.md` lines 120-125.
- The callout explains the signup form fields, no credit-card/payment step, email delivery, activation link requirement, expected wait guidance, and URL-encoding caution for reserved URL characters.
- Reinforced the activated-key handoff at line 445 so users paste only the activated key value into `Global.APIKey`, not the activation URL.

## Other sticking-point fixes

- Line 243: fixed the opening message typo (`I can help you look up...`).
- Line 245: added guidance for tenants that label the Adaptive Card node differently.
- Lines 322-340: corrected variable references and routing instructions from inconsistent `Topic.state`/`Topic.city`/`Topic.zipCode` usage to `Topic.StateInput`/`Topic.City`/`Topic.ZipCode`, and clarified `Topic.StateFIPS` as the target variable.
- Line 435: added fallback guidance for creating global variables from a **Set variable value** node if the variable management surface is not obvious.
- Line 723: added a Power Automate trigger-location hint for tenants that group triggers by connector.

## Verification

- Final diff stat for lab file: `labs/04-energy-census-advanced-agent/index.md | 31 ++++++++++++++++-----------` (`19 insertions(+), 12 deletions(-)`).
- Markdown fence count checked: 72 fences, even/closed.
- Image references checked: 18 image references, 0 missing. Confirmed key assets still exist, including `copilot-studio-home.png`, `topic-add-from-blank.png`, `adaptive-card-json-editor.png`, `adaptive-card-preview.png`, `adaptive-card-output-mapping.png`, and `state-fips-switch-powerfx.png`.

## Follow-up notes

- I did not add an exact Census email delivery time because the signup page does not publish an SLA; the lab now uses cautious guidance instead.
- I did not restructure the optional MCP section or Power Automate parsing section; those could benefit from a deeper pass, but would exceed a surgical smoothness edit.

## 2026-06-15 — Kane Lab 04 Accuracy Audit Summary

Owner: Kane
Merged by: Scribe
Source: .squad/decisions/inbox/kane-lab04-accuracy-audit.md

### Preserved inbox entry

# Kane Lab 04 Accuracy Audit Summary
Date: 2026-06-15T00:18:00-05:00
Author: Kane

Audit written: `C:\repos\CopilotStudioLabs\.squad\files\lab-04-accuracy-audit.md`

Severity counts:
- ✅ Verified accurate: 66
- 🟡 Drift / minor: 8
- 🔴 Wrong / broken: 3
- ❓ Could not verify: 4

Top 3 critical findings:
1. **[MCP / Copilot Studio]** [Lines 958-960, 1008-1014]: claim says to stand up a local MCP server and register it in Copilot Studio → current Microsoft Learn says Copilot Studio connects to MCP servers through the MCP onboarding wizard using a **Server URL** and currently supports **Streamable** transport; it does not document local stdio command registration for Copilot Studio → recommended fix: change the optional section to a reachable Streamable HTTP MCP server (or custom connector) and cite the wizard fields.
2. **[MCP / Configuration]** [Lines 1017-1031]: sample `mcpServers` JSON uses `command`, `args`, and `env` for a local `node` process → that is a desktop/VS Code-style stdio client configuration, not the Copilot Studio MCP wizard shape documented by Microsoft Learn → recommended fix: remove it from Copilot Studio instructions or explicitly label it as non-Copilot-Studio local-client config, then add Copilot Studio fields: server name, description, server URL, auth type.
3. **[MCP / Runtime validation]** [Lines 1033-1039]: test steps assume Copilot Studio can discover and invoke tools from the local stdio server as written → because Copilot Studio docs require a connected MCP server/connector over supported transport, these runtime steps will not work from the provided local config → recommended fix: test after registering a Streamable HTTP MCP server/connector and adding its tools/resources to the agent.

Corrections inbox written: `C:\repos\CopilotStudioLabs\.squad\decisions\inbox\kane-lab04-critical-corrections.md`

## 2026-06-15 — Kane Lab 04 Critical Corrections

Owner: Kane
Merged by: Scribe
Source: .squad/decisions/inbox/kane-lab04-critical-corrections.md

### Preserved inbox entry

# Kane Lab 04 Critical Corrections
Date: 2026-06-15T00:18:00-05:00
Author: Kane
Audited file: labs/04-energy-census-advanced-agent/index.md

- **[MCP / Copilot Studio]** [Lines 958-960, 1008-1014]: claim says to stand up a local MCP server and register it in Copilot Studio → current Microsoft Learn says Copilot Studio connects to MCP servers through the MCP onboarding wizard using a **Server URL** and currently supports **Streamable** transport; it does not document local stdio command registration for Copilot Studio → recommended fix: change the optional section to a reachable Streamable HTTP MCP server (or custom connector) and cite the wizard fields.
- **[MCP / Configuration]** [Lines 1017-1031]: sample `mcpServers` JSON uses `command`, `args`, and `env` for a local `node` process → that is a desktop/VS Code-style stdio client configuration, not the Copilot Studio MCP wizard shape documented by Microsoft Learn → recommended fix: remove it from Copilot Studio instructions or explicitly label it as non-Copilot-Studio local-client config, then add Copilot Studio fields: server name, description, server URL, auth type.
- **[MCP / Runtime validation]** [Lines 1033-1039]: test steps assume Copilot Studio can discover and invoke tools from the local stdio server as written → because Copilot Studio docs require a connected MCP server/connector over supported transport, these runtime steps will not work from the provided local config → recommended fix: test after registering a Streamable HTTP MCP server/connector and adding its tools/resources to the agent.

## 2026-06-15 — Dallas Lab 04 MCP Rewrite

Owner: Dallas
Merged by: Scribe
Source: .squad/decisions/inbox/dallas-lab04-mcp-rewrite.md

### Preserved inbox entry

# Dallas Lab 04 MCP Rewrite
Date: 2026-06-15T00:25:00-05:00
Author: Dallas
File: labs/04-energy-census-advanced-agent/index.md

## Correction summary

Use Case #8 was rewritten to remove the incorrect local stdio MCP pattern for Copilot Studio. Copilot Studio does not register a local `node` process through `command` / `args` / `env` JSON. Current Microsoft Learn documents connecting MCP servers through Copilot Studio's MCP onboarding wizard with a reachable **Server URL** and **Streamable** transport.

## Changes made

- Replaced `StdioServerTransport` with `StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk/server/streamableHttp.js`.
- Added explicit `npm i @modelcontextprotocol/sdk zod` setup and `node server.js` run steps.
- Kept the four Census MCP tools: `get_population`, `get_median_income`, `get_housing_stats`, and `get_employment_by_industry`.
- Removed the desktop-client `mcpServers` JSON config block entirely to avoid reintroducing the known-wrong Copilot Studio pattern.
- Added cloud-to-local reachability guidance: ngrok, VS Code port forwarding, Azure Dev Tunnels, or Azure deployment.
- Updated Copilot Studio registration steps to match Learn: **Tools** > **Add a tool** > **New tool** > **Model Context Protocol**, then **Server name**, **Server description**, **Server URL**, and auth type (**None**, **API key**, or **OAuth 2.0**).
- Updated runtime test and troubleshooting to validate the reachable Streamable HTTP endpoint rather than a local stdio process.

## Sources verified

- Microsoft Learn: `agent-extend-action-mcp`, `mcp-add-existing-server-to-agent`, `mcp-add-components-to-agent`, and `mcp-create-new-server`.
- MCP SDK package metadata: `@modelcontextprotocol/sdk@1.29.0`; `StreamableHTTPServerTransport` constructor accepts options and request handling is via `handleRequest(req, res, parsedBody?)`.

## 2026-06-15 — Kane: Lab 04 MCP section still broken after Dallas rewrite

Owner: Kane
Merged by: Scribe
Source: .squad/decisions/inbox/kane-lab04-mcp-still-broken.md

### Preserved inbox entry

# Kane: Lab 04 MCP section still broken after Dallas rewrite

Use Case #8's architecture and Copilot Studio wizard guidance are materially improved, but the Node.js Streamable HTTP sample is still a blocker.

## Critical issue

The sample creates a singleton `StreamableHTTPServerTransport`:

```js
const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
await server.connect(transport);

http.createServer(async (req, res) => {
  if (req.url?.startsWith("/mcp")) {
    await transport.handleRequest(req, res);
  }
}).listen(3000);
```

With `@modelcontextprotocol/sdk@1.29.0`, a smoke test showed the initial `initialize` POST returns `200`, but subsequent `notifications/initialized` and `tools/list` POSTs return `500`, so Copilot Studio discovery/invocation will fail.

## Recommended correction

Use the SDK v1.x official pattern:

- **Stateless:** create a fresh `McpServer` and `StreamableHTTPServerTransport({ sessionIdGenerator: undefined })` per POST and pass the parsed request body to `handleRequest(req, res, req.body)`; or
- **Stateful:** create transports on initialize, store them by `mcp-session-id`, and route subsequent GET/POST/DELETE requests to the stored transport.

Also tighten dev-tunnel wording: `devtunnel host -p 3000` and VS Code forwarded ports are private by default; Copilot Studio needs a public/anonymous URL or an auth mechanism it can supply.

## 2026-06-15 — Ripley: Lab 04 MCP Streamable HTTP fix

Owner: Ripley
Merged by: Scribe
Source: .squad/decisions/inbox/ripley-lab04-mcp-streamable-http-fix.md

### Preserved inbox entry

# Ripley: Lab 04 MCP Streamable HTTP fix

Updated `labs/04-energy-census-advanced-agent/index.md` Use Case #8 to replace the singleton `StreamableHTTPServerTransport` sample with the SDK v1.x stateless Streamable HTTP pattern.

## Fix summary

- Chose stateless Streamable HTTP: each POST creates a fresh `McpServer` and `StreamableHTTPServerTransport({ sessionIdGenerator: undefined })`, then calls `transport.handleRequest(req, res, req.body)`.
- Used Express with `express.json()` so the JSON-RPC request body is parsed before it is passed to the SDK transport.
- Added the requested inline comment to prevent future maintainers from changing the sample back to a singleton transport.
- Updated install guidance to include `express`.
- Tightened tunnel guidance:
  - `devtunnel host -p 3000` is private by default.
  - short lab use should use `devtunnel host -p 3000 --allow-anonymous`, unless configuring an auth mechanism Copilot Studio can supply.
  - VS Code forwarded ports are private by default and must be made public for Copilot Studio.
  - ngrok `ngrok http 3000` provides a public HTTPS forwarding URL once the agent is connected; if traffic policy/OAuth is added, Copilot Studio must be configured with compatible auth.

## Source mirrored

Mirrored the official MCP TypeScript SDK v1.x stateless example: `src/examples/server/simpleStatelessStreamableHttp.ts` in the `modelcontextprotocol/typescript-sdk` repository. That example uses Express, creates a server and `StreamableHTTPServerTransport` per POST, disables session IDs with `sessionIdGenerator: undefined`, and passes `req.body` to `handleRequest`.

Also checked Microsoft Learn dev tunnels CLI reference, which documents `devtunnel host -p 3000` for a temporary tunnel and `devtunnel host -p 3000 --allow-anonymous` to enable anonymous client access.

## 2026-06-14 — Lambert decision: Lab 2 incorporation from Microsoft Copilot Studio analytics/evaluations lab

Owner: Lambert
Merged by: Scribe
Source: .squad/decisions/inbox/lambert-lab2-mslearn-incorporation.md

### Preserved inbox entry

# Lambert decision: Lab 2 incorporation from Microsoft Copilot Studio analytics/evaluations lab

Requested by: Russ Rimmerman
Source reviewed: https://microsoft.github.io/mcs-labs/labs/core-concepts-analytics-evaluations/
Target reviewed: `labs\02-agent-analytics-evaluations\index.md`

## Side-by-side diff

| Practice / concept in Microsoft lab | What Lab 2 already covered | Gap / decision |
|---|---|---|
| Analytics dashboard access after publishing; 24-48 hour data delay; deployed-channel requirement | Covered with Contoso-specific prerequisite, empty dashboard warning, and troubleshooting | No content change needed |
| Summary metrics: sessions, engagement, date ranges, conversation outcomes | Covered with Contoso examples for field crews, outage cycles, and weekly 7-day review cadence | No content change needed |
| Topic / agent performance, child and connected agent success rate | Covered; tied to Lab 03 child/connected agent routing | No content change needed |
| Generated answer rate and quality: answered/unanswered, source use trend, source errors | Covered in detail with NERC CIP and Field Operations Remote Access Guide examples | No content change needed |
| Escalation and abandonment analysis | Covered with Contoso helpdesk/flow-design framing | No content change needed |
| Prioritized improvement list: high-volume/low-satisfaction, unrecognized phrases, abandonment | Covered with a Contoso table and before/after measurement guidance | No content change needed |
| Evaluation is preview and may not appear in all tenants/regions | Covered in prerequisites and Use Case #2 | No content change needed; retained Preview warning |
| Four test-set creation methods: quick question set, CSV import, test-canvas capture, manual entry | Covered, but Use Cases table inaccurately said “four test sets” even though the flow creates three sets plus one manual case | Incorporated: corrected table wording |
| Test-method selection: General quality baseline; Compare meaning when expected responses exist; strict methods for factual checks | Covered but could be more explicit about quality objective to method mapping | Incorporated: added Contoso test-set design checkpoint table |
| CSV import format and limits; methods configured after import | Covered; retained our Contoso `EvaluationAlwaysFail.csv` unchanged | No asset change needed |
| Always Fail adversarial set teaches guardrail assessment | Covered and differentiated with Contoso/Contoso Energy phishing, ESA bypass, SCADA, PII, NERC CIP examples | Keep as differentiation; no asset change |
| Test-canvas capture creates an Always Pass set from real conversation responses | Covered and Contoso-framed with VPN, NERC CIP, ESA password, field guide questions | No content change needed |
| Manual DLP policy test case | Covered and Contoso-scoped | No content change needed |
| Results review: pass rate, actual response, result, activity map | Covered | No content change needed |
| Evaluation reasoning and feedback buttons help identify false positive/negative judgments | Covered, but more shallowly than the Microsoft lab’s results feedback workflow | Incorporated: added “Judge sanity check” guidance for AI-judged methods |
| Compare runs: green improvements, red regressions, no-change indicators | Covered, but release decision criteria were implicit | Incorporated: added Contoso regression decision rule table |
| Export results for stakeholder reporting and documentation | Covered with Contoso Energy leadership, Contoso Cybersecurity, NERC CIP audit framing | No content change needed |
| Golden rules: review cadence, prioritize impact, build test sets, compare runs, close loop | Covered with Contoso-specific rules | Incorporated one additional rule: strict methods for strict facts |

## Practices Lab 2 covers beyond Microsoft lab

- Contoso/Contoso Energy IT Operations scenario and cross-lab continuity with Labs 01 and 03.
- Contoso-specific analytics examples: storm season, wildfire response, regulatory filing deadlines, NERC CIP remote-access questions.
- Contoso `EvaluationAlwaysFail.csv` adversarial set covering phishing, authentication bypass, SCADA alarms, credentials, PII exfiltration, discriminatory content, jailbreak attempts, and NERC CIP noncompliance.
- Stronger compliance/audit framing for NERC CIP, Contoso Cybersecurity, data governance, and stakeholder reporting.
- Lab-specific guidance for analytics not appearing until published real conversations exist.

## Incorporated

1. Clarified that Use Case #2 builds three test sets plus one targeted manual case, not four separate test sets.
2. Added AI/judge-assisted scoring as a core concept and learning objective.
3. Added a Contoso test-set design checkpoint mapping quality questions to set patterns and evaluation methods.
4. Added a judge sanity-check section for General quality / Compare meaning results, including false positives, false negatives, and human review for audit-sensitive cases.
5. Added a Contoso regression decision rule table for publish/no-publish decisions after comparing runs.
6. Added a golden rule about strict methods for strict facts.

## Deferred

- No new MS Learn example agent or tenant names were introduced; that would dilute the Contoso scenario.
- No changes to `assets\EvaluationAlwaysFail.csv`; Microsoft’s source CSV purpose is already represented by our stronger Contoso adversarial rows.
- No separate “MS Learn section” was added; additions were woven into the existing flow.
- No extra screenshots or docs were added.

## Edited target areas

Approximate final line ranges in `index.md`:

- Lines 48-55: learning objectives.
- Lines 67-69: core concepts table.
- Line 99: Use Cases table correction.
- Lines 239-250: test-set design checkpoint and Microsoft source callout.
- Lines 378-384: judge sanity-check guidance.
- Lines 420-429: regression decision rule table.
- Lines 473-477: golden rules update.

## 2026-06-14 — Lab PDF generator and screenshot zoom

Owner: Dallas
Merged by: Scribe
Source: `.squad/decisions/inbox/dallas-lab-pdf-generator.md`

### Decision summary

Implement lab walkthrough PDFs as a build-time tool under `tools/lab-pdf/`, serve only pre-generated PDFs from the portal, and provide interactive screenshot zoom in the portal HTML viewer.

Architecture summary:

1. `tools/lab-pdf/` reads each lab `index.md`, renders Markdown to print-friendly HTML with `marked`, rewrites local images to `file://` URIs, scales inline screenshots to at most 720px, replaces missing screenshots with clear placeholders, and prints PDFs through Playwright headless Chromium with cover, TOC, header, and footer.
2. Generated PDFs embed screenshots inline and add a "Screenshots — Full Size" appendix. Inline thumbnails link to appendix anchors, and appendix pages link back to their inline reference.
3. The portal serves `GET /api/labs/:id/pdf` only when the generated PDF is fresh relative to the lab markdown and PNG assets. It returns `503` if the PDF is missing or stale instead of launching Playwright from an HTTP request.
4. The portal HTML preview owns true interactive zoom: a reusable vanilla-JS lightbox supports mouse-wheel zoom, panning, keyboard controls, focus trapping, and Escape-to-close.

Rationale: PDF readers do not reliably support JavaScript-driven image zoom across browsers, Adobe Reader, Preview, Edge, and mobile viewers. The portable PDF answer is high-quality embedded images plus clickable thumbnail-to-full-page anchors. Native, rich zoom belongs in the in-browser portal experience where JavaScript interaction is predictable.

## 2026-06-14 — Lab 04 screenshot section deeplinks

Owner: Dallas
Merged by: Scribe
Source: `.squad/decisions/inbox/dallas-shots-section-deeplinks.md`

### Decision summary

Added current-agent section navigation for Lab 04 screenshot capture. `section` now carries the Copilot Studio navigation target (`topics`, `actions`, `agents`, `settings`, `evaluations`, or `home`/`powerautomate` when an absolute URL wins), while `labSection` preserves the former use-case step label for operator prompts.

Mapping summary:
- Home: shot 0 uses `url: https://copilotstudio.microsoft.com/`.
- Topics/editor modal shots: 1-5 use `section: topics`.
- Variables/settings/model/sharing shots: 6, 10, 14 use `section: settings`.
- HTTP tools, variable picker, and MCP discovery: 7-9 and 17 use `section: actions`.
- Connected agents list: 11 uses `section: agents`.
- Power Automate flow shots: 12-13 use `url: https://make.powerautomate.com/`.
- Evaluations/test results: 15-16 use `section: evaluations`.

Capture behavior: absolute `url` wins. Otherwise, if the current page is a Copilot Studio `/environments/{envId}/bots/{botId}/...` URL, capture replaces the suffix with `section`; if not, it prints a hint asking the operator to open any agent first.

## 2026-06-14 — Lab 04 placeholder restoration guardrail

Owner: Dallas
Merged by: Scribe
Source: `.squad/decisions/inbox/dallas-placeholder-guardrail.md`

### Decision summary

Regression pattern: the 16 Lab 04 placeholder PNGs are committed in repository history, so `git restore`, VS Code `Discard Changes`, or `Discard All Changes` can re-materialize them until the deletions and replacement captures are committed together.

Guardrails added:

1. README warning: `tools/screenshot-capture/README.md` now has `## Heads-up: commit deletions promptly`, explaining that placeholder deletions should be staged with good captures and committed promptly.
2. Verification flag: `tools/screenshot-capture/verify-shots.js --check-state` now checks Lab 04 PNG byte sizes against Kane's known-placeholder denylist and emits CRITICAL `restored-placeholder` findings for exact matches.

Limits: the `--check-state` fingerprint is a byte-size heuristic. A real capture could theoretically have an identical size, but that should be extremely unlikely and should trigger manual inspection/re-capture.

## 2026-06-14 — Screenshot capture workflow enhancements

Owner: Dallas
Merged by: Scribe
Source: `.squad/decisions/inbox/dallas-capture-js-enhancements.md`

### Decision summary

Implemented a faster human-in-the-loop screenshot UX for `tools/screenshot-capture/capture.js`.

- The tool now handles safe setup before each shot: optional per-shot URL navigation, viewport/zoom reset and overrides, and best-effort dismissal of cookie banners, teaching tips, popovers, and toast overlays.
- Russ remains in control of sign-in, Copilot Studio/Power Automate UI state, and final capture approval.
- The capture prompt is now single-key raw input: Space snaps, `r` retries, `n` skips, `q` quits and persists auth, `?` reprints instructions.
- Saved files are immediately verified as PNGs larger than 5 KB, with an inline retry option on failure.
- New non-browser workflow flags: `--help`, `--dry-run`, `--missing`, and `--from=<id>`.
- Selection flags are mutually exclusive while documenting intended precedence: `--only` > `--range` > `--from` > `--missing` default.
- The shot schema now reserves optional `url`, `viewport`, `zoom`, and future `highlight: { selector, label }` fields without requiring existing catalog changes.

## 2026-06-14 — Screenshot consistency verifier

Owner: Kane
Merged by: Scribe
Source: `.squad/decisions/inbox/kane-shots-verify-tool.md`

### Decision summary

- Added `tools\screenshot-capture\verify-shots.js` as a dependency-free Node.js read-only check for lab screenshot drift.
- The verifier validates `shots.json` schema, markdown-to-catalog coverage, catalog-to-markdown coverage, image file existence, zero-byte files, PNG/JPEG/GIF/WebP signatures, tiny PNG placeholder suspects, and orphan PNG/JPEG assets under `labs\<lab>\assets`.
- CRITICAL by default: schema violations, missing lab image files, invalid image signatures, zero-byte images, and markdown/catalog coverage mismatches.
- WARNING by default: orphan assets and `tiny-suspect-placeholder` PNGs; pass `--strict` to make warnings fail the run.
- Run from `tools\screenshot-capture` with `npm run verify`, or directly with `node verify-shots.js --json`, `--lab=<id>`, and/or `--strict`.

### Current verification state

- `npm run verify` currently exits 1 on the post-Dallas-cleanup repo because Lab 04 has 16 missing screenshot files awaiting re-capture.
- The verifier also reports one warning for the Lab 01 orphan asset `issues-banner.png`.

## 2026-06-14 — Lab 04 screenshot audit and cleanup

Owner: Kane / Dallas
Merged by: Scribe
Source: `.squad/decisions/inbox/kane-lab04-screenshot-audit.md`

## 2026-06-15 — 2026-06-15T01:32:53-05:00: Competitive feature gap analysis — hands-on lab platforms

Owner: Ripley (Lead)
Merged by: Scribe
Source: .squad/decisions/inbox/ripley-competitive-scan.md

### Preserved inbox entry

### 2026-06-15T01:32:53-05:00: Competitive feature gap analysis — hands-on lab platforms
**By:** Ripley (Lead), requested by Russ Rimmerman
**What:** Surveyed 13 lab provisioning platforms (Skillable, CloudShare, Instruqt, Strigo, Appsembler, Whizlabs, KodeKloud, Hyperskill, Microsoft Learn, AWS Skill Builder, Google Skills Boost, GitHub Codespaces, Gitpod, Educative). Identified table-stakes features, unmet demand, and gaps vs. CopilotStudioLabs.

**Key decisions / strategy conclusions:**

- **D1 — Copilot Studio labs are a genuine white space.** Zero competitors offer provisioned Microsoft Copilot Studio or Power Platform sandbox environments. CopilotStudioLabs is the only hands-on lab platform purpose-built for this surface. Protect and extend this niche aggressively.
- **D2 — Immediate priority: AI agent output validation rubric.** The #2 industry unmet need (after native sandboxes) is automated validation of AI agent behavior. Build a structured "Lab Validation Rubric" system using Copilot Studio's own evaluation tooling (Lab 02) applied to learner-built agents. First-in-market.
- **D3 — GitHub Codespaces integration for MCP labs.** Labs 03, 05, 07 require Node.js/MCP servers. Add `.devcontainer` config to eliminate setup friction. 1–2 days of work; addresses the industry's #1 lab pain point (setup time).
- **D4 — Publish the Scenario Matrix as a marketing asset.** Industry scenario coverage (18 labs across Energy, Manufacturing, Healthcare, Financial Services, Government) is unique. Map labs to industries and compliance frameworks (NERC CIP, HIPAA, CMMC, ISO 55001) and publish as a product page.
- **D5 — Monitor Microsoft for Applied Skills Copilot Studio credential.** Skillable powers Microsoft's Applied Skills labs. When/if Microsoft adds Copilot Studio credentials, position CopilotStudioLabs to complement (not compete) by going deeper and more industry-specific.
- **D6 — Tenant provisioning is the long game.** "Clean Copilot Studio tenant per learner" is the holy grail. Monitor Microsoft Build / Ignite 2026 for Power Platform trial tenant provisioning APIs. Would unlock event-scale delivery.

**Top 10 table-stakes features (must-haves, 3+ platforms):** browser-based delivery; auto provision/teardown; progress analytics; LMS/LTI; automated task validation; SSO; VILT + self-paced; cost controls / idle timeout; embeddable labs; audit/compliance reporting. *CopilotStudioLabs currently has 0 of 10 natively.*

**Top 10 unmet-demand features (gaps in the market):** native Power Platform / Copilot Studio sandbox; AI agent output validation; AI-assisted lab authoring; branching/adaptive paths; per-learner cloud budget caps; mobile-first experience; offline mode; industry-specific scenario libraries; cross-tenant multi-learner agent collaboration; persistent state with retake/branching.

**Research sources:** Vendor sites (instruqt.com, cloudshare.com, skillable.com, strigo.io, kodekloud.com, learn.microsoft.com, cloudskillsboost.google, aws.amazon.com/training, github.com/features/codespaces, gitpod.io, educative.io, hyperskill.org); SlashData 2026 State of Developer Adoption (424 practitioners, March 2026); G2 Fall 2025 Virtual IT Labs category. Full citation list in session report.

**Why:** Inform feature investment priorities for CopilotStudioLabs based on competitive landscape and unmet customer demand.

### Decision summary

Completed triaged audit for all 18 Lab 04 screenshots.

Verdict counts:
- ✅ Correct: 1
- 🟡 Stale/low-fidelity: 0
- 🔴 Wrong: 7
- ⚫ Placeholder: 10
- ❓ Unverifiable: 0

Worklist length: 17 screenshots need re-capture.

### Worklist files

1. adaptive-card-json-editor.png
2. adaptive-card-preview.png
3. adaptive-card-output-mapping.png
4. state-fips-switch-powerfx.png
5. variable-picker-in-url.png
6. tool-county-demographics-test.png
7. connected-agent-sharing-enabled.png
8. flow-agent-trigger.png
9. flow-state-summary-canvas.png
10. evaluation-results.png
11. topic-add-from-blank.png
12. global-variables-list.png
13. tool-county-demographics-inputs.png
14. connected-agent-config.png
15. model-selection-comparison.png
16. eval-test-methods.png
17. mcp-tool-discovery.png

### Paired cleanup

- Dallas applied Kane's 17 `shots.json` instruction patches for ids 1-17 and validated `tools/screenshot-capture/shots.json` as parseable JSON.
- Dallas deleted the 17 placeholder/wrong Lab 04 PNGs so `npm run capture` will regenerate them.
- Only `copilot-studio-home.png` remains on disk because Kane verified it as correct.
- Outstanding user action: run `cd tools\screenshot-capture; npm run capture` while signed into Copilot Studio.

### Notes

No markdown/catalog blockers: all 18 markdown image references have matching `shots.json` entries, and all 18 `shots.json` filenames are referenced by markdown.

Full audit: `.squad/files/lab-04-screenshot-audit.md`

## 2026-06-14 — Portal lab asset paths

Owner: Dallas
Merged by: Scribe
Source: `.squad/decisions/inbox/dallas-portal-lab-asset-paths.md`

### Portal lab asset paths

- Serve lab files from the portal under `/labs` using the repository/image layout path `resolve(import.meta.dirname, "..", "labs")`.
- Mounted `labs/` with `app.use("/labs", express.static(labsRoot))` next to the existing `public/` static middleware.
- Rewrites rendered lab HTML after `marked.parse(content)` for `<img src="...">` and `<a href="...">` local relative URLs.
- Relative references are normalized against the lab root and emitted as `/labs/<labId>/<asset-path>`.
- Leaves `http:`, `https:`, other schemes, protocol-relative URLs, root-relative URLs, anchors, and `../` references that would escape the lab directory unchanged.

## 2026-06-14 — Lab 2 analytics/evaluations alignment

Owner: Lambert
Merged by: Scribe
Source: `.squad/decisions/inbox/lambert-lab2-analytics-evals.md`

### Lab 2 Analytics/Evaluations Alignment

- Adapted the upstream Microsoft Copilot Agents Labs analytics/evaluations practices into the Contoso Lab 2 voice rather than copying generic content.
- Preserved the existing `assets/EvaluationAlwaysFail.csv` reference and did not change the CSV; the current upstream lab still uses only `question` and `expectedResponse` for import, with methods configured after import.
- Added missing operational practices around session/transcript review, citation/source evidence, severity-based triage, run comparison, export/sharing, and governance handling for transcripts/results.

## 2026-06-14 — Dallas deployment configuration tooltips

Owner: Dallas
Merged by: Scribe
Source: `.squad/decisions/inbox/dallas-deployment-config-tooltips.md`

### Deployment configuration tooltips

- Added a single `CONFIG_PROVENANCE` lookup in `portal/public/app.js` rather than scattering tooltip text through the HTML.
- Static Deployment Configuration form cards declare `data-config-key`; generated status cards use the same keys through `configStatusCard()`.
- Tooltips are custom HTML so their links are clickable and stay open for hover/focus interaction.

# Decision: Upgrade Test Architecture Surface

Decision owner: Ripley
Date: 2026-06-13

We will treat `setup.js` re-run as the primary upgrade contract for CopilotStudioLabs because the repo has no formal upgrade command yet. The secondary upgrade surfaces are `tools/screenshot-capture/` refresh/re-run and manual template pull/fork resync.

Rationale:

- Users fork the template and run `npm run setup`; re-running that command after customization is the closest equivalent to upgrade.
- Pulling upstream template changes is the real-world path users will use to get fixes and new labs.
- Screenshot capture has separate dependencies, state (`.auth`), and generated outputs, so it needs its own preservation contract.

Implication:

Architecture, test tooling, and detailed test cases should verify MUST-change, MUST-NOT-change, and idempotency across all three surfaces rather than only checking command success.


# Dallas tooling mechanics decisions

Date: 2026-06-13
Owner: Dallas

## Decision

`setup.js` should be treated as a first-run template customizer, not as a safe long-lived fork upgrade command, until it is hardened for idempotent re-runs and fork resyncs.

## Rationale

- It replaces only hard-coded template defaults, so config A then config B leaves existing A-customized content in place.
- It recursively deletes excluded lab folders, so previously removed labs cannot be restored by later config changes unless git/upstream restores the files.
- It rewrites user-editable Markdown broadly and cannot distinguish template defaults from user-authored content.
- It does not regenerate README content from a canonical model; it only removes excluded lab references by regex.

## Implication

Upgrade test planning should require a hardening work item before promising public template-fork support: prior-config state, collision-safe replacements, non-destructive lab exclusion or explicit force mode, and generated README markers.


# Kane decision note — upgrade test matrix

Requested by: Russ Rimmerman
Date: 2026-06-13

## Testing decisions recorded

1. Treat the current upgrade surface as `setup.js` re-run, screenshot tool state preservation, and fork-resync simulation, because there is no dedicated upgrade command yet.
2. Use three tiers modeled on the referenced blog: synthetic scenarios, known/internal repos, and discovered public forks.
3. Set the release-gate target at under 10 minutes wall-clock with 9 fan-out agents and a 99.6%+ pass-rate framing, while making any ship-blocker override aggregate pass rate.
4. Include current known-risk behavior in the matrix instead of hiding it: destructive deletion of unknown/excluded lab directories, broad markdown replacement across custom `.md` files, and no prior-config memory for config A → config B.
5. Require `--dry-run` and invalid/missing config scenarios to prove zero file changes using both `git status --porcelain` and a SHA-256 file manifest.
6. For public forks, enforce read-only remote behavior: zero pushes, zero PRs, zero issues, zero comments, and content-scrubbed reporting.
7. Prefer JavaScript for reusable hash/snapshot helpers because it is cross-platform; use PowerShell only as orchestration glue for Windows-heavy agent runs.


# Lambert decision note — content upgrade contract

Requested by: Russ Rimmerman
Date: 2026-06-13

## Content-policy decisions recorded

1. Treat `template.config.json` as user-owned state. Upstream/template updates may suggest migrations but must not replace it wholesale.
2. Treat any user-edited path under `labs\` after initial setup as protected content. Upstream prose, sample-data, and screenshot updates should apply only when the target file or hunk still matches the previous template baseline.
3. Treat user-added files and user-added lab folders under `labs\` as protected content, even when they are inside template-managed directories.
4. Do not use current `labs.include` absence alone as permission to delete a lab folder. Only known template-managed labs should be removable, and unknown/custom labs must survive setup re-runs.
5. Root README updates should be bounded to explicit generated regions, especially the lab table. User-authored sections below the autogenerated lab table must survive.
6. Lab directory names that include organization slugs are a content-risk area. Either make lab IDs/path names stable and non-branded going forward, or add explicit rename detection/mapping before setup touches `labs\`.
7. Broad string replacement across all Markdown is unsafe for content preservation. Replacement should be scoped to managed files/blocks and avoid code fences, URLs, Markdown link targets, and user-added Markdown unless opted in.
8. Screenshot and sample-data updates require hash/manifest checks. User-replaced images and customized CSV/Markdown sample files must not be overwritten by upstream refreshes.


# Dallas decision note — scenario selection fix

Requested by: Russ Rimmerman
Date: 2026-06-14

## Decision

Make the scenario planner bind selection behavior with JavaScript event listeners after rendering, render industry options as real buttons, attach explicit listeners to role checkboxes, and escape rendered scenario detail/chip text.

## Rationale

The provisioning portal showed scenario details, but the selectable controls depended on fragile dynamic inline handlers and under-bound checkbox behavior. Real buttons plus explicit post-render listeners make scenario and role selection reliable and keyboard-accessible, while escaping scenario text preserves correct rendering and avoids markup injection.


## 2026-06-15 — Dallas Codespaces devcontainer

Owner: Dallas
Merged by: Scribe
Source: .squad/decisions/inbox/dallas-devcontainer.md

### Preserved inbox entry

# Dallas — Codespaces devcontainer for MCP labs

Date: 2026-06-15T01:59:09-05:00
Requested by: Russ Rimmerman

## Decision

Added a root `.devcontainer` configuration for GitHub Codespaces using Node.js 20 LTS, not Node.js 22.

## Rationale

- The root project, portal, and lab PDF tooling declare `node >=18.0.0`; no inspected `package.json` requires Node 22.
- Lab 04's optional MCP server section calls for Node.js 18+ and uses a Streamable HTTP server on port 3000.
- Lab 18's Vite sample targets a standard Vite workflow on port 5173, but dependency resolution needs follow-up before it can be considered Codespaces-ready.
- Node 20 is an LTS baseline and satisfies all discovered Node requirements while minimizing version churn for learners.

## Implementation notes

- Created `.devcontainer/devcontainer.json` with Codespaces-friendly port forwarding for 3000, 3001, 5173, and 8080.
- Created `.devcontainer/Dockerfile` to add `jq`, Python 3, and zip/unzip beyond the Node 20 devcontainer base image.
- Used the GitHub CLI and common-utils devcontainer features for `gh` and standard learner utilities.
- Post-create commands install dependencies for root, portal, lab PDF tooling, and screenshot tooling.
- Lab 18 was inspected because it has Node/Vite tooling, but its current `@microsoft/agents-copilotstudio-client@^0.5.0` dependency was unavailable from npm during validation, so it is documented as follow-up rather than included in post-create setup.


## 2026-06-15 — Lambert validation rubric framework

Owner: Lambert
Merged by: Scribe
Source: .squad/decisions/inbox/lambert-validation-rubric.md

### Preserved inbox entry

# Lambert validation rubric framework

Requested by: Russ Rimmerman
Timestamp: 2026-06-15T01:59:09-05:00

## Structural decisions

- Created a new top-level documentation area at `docs/validation-rubrics/` for a reusable Lab Validation Rubric framework.
- Chose YAML for rubric files because lab authors and instructors can read, comment, and review YAML more easily than JSON, while preserving a structure that can be converted to JSON later if automation is added.
- Kept Copilot Studio's native CSV import shape (`question,expectedResponse`) for learner-facing test sets so learners can import directly into the Evaluation feature taught in Lab 02.
- Supported four rubric evaluator types: `llm-as-judge`, `regex`, `contains-string`, and `tool-call-check`.
- Mapped those evaluator types to Copilot Studio methods: General quality, Compare meaning, Similarity, Keyword match, Exact match, Capability use, Custom, and activity-map/knowledge-source review.
- Used Lab 01 as the first worked example because Lab 02 already evaluates the Lab 01 agent and because Lab 01 produces a knowledge-grounded Contoso IT Operations agent with clear source, safety, and troubleshooting outcomes.

## Files added

- `docs/validation-rubrics/README.md`
- `docs/validation-rubrics/schema.md`
- `docs/validation-rubrics/authoring-guide.md`
- `docs/validation-rubrics/learner-guide.md`
- `docs/validation-rubrics/lab-01-energy-ops-agent.rubric.yaml`
- `docs/validation-rubrics/lab-01-energy-ops-agent.testset.csv`

## Rationale

The competitive scan identified automated AI-agent behavior validation as a first-in-market opportunity. This framework uses Copilot Studio's own Agent Evaluation tooling as the execution engine rather than adding code or scripts. Rubrics define the quality bar; Copilot Studio provides test sets, evaluator methods, scoring, activity maps, run comparison, and exportable completion evidence.

## 2026-06-22 — 2026-06-22T00:00:00Z: Lab helper scripts generalized to 01-35 and validators consolidated

Owner: Dallas (Backend Dev)
Merged by: Scribe
Source: .squad/decisions/inbox/dallas-lab-scripts.md
Requested by: Russ Rimmerman [MSFT]

### Decision summary

- `edit_labs.py` now discovers `labs/NN-*` folders by scanning (covers 01-35 incl. both `01-*`) instead of `range(2,19)`. Normalization is idempotent/safe: it inserts `## Metadata` ONLY when neither a Metadata heading nor an emoji metadata table exists, and renames a "What you will/'ll learn" heading to `## 🎯 Objectives` ONLY when no canonical Objectives heading exists. Existing well-formed labs (emoji metadata table convention) and `> 🔗 **Related lab:**` callouts are never touched.
- Consolidated both validators into a single `validate_labs.py` (union of section checks: title, metadata, overview, objectives, prerequisites, steps, validation, completion). Metadata passes on either a `## Metadata` heading OR an emoji metadata table. README `labs/...` links are resolved against disk. Numbering collisions are flagged EXCEPT the intentional duplicate `01` (ALLOWED_DUPLICATE_NUMBERS = {1}), which is reported as "expected".
- Deleted `validate_labs_new.py`.

**Why:** Repo grew from 18 to 35 labs; hardcoded ranges no longer covered new content, and two near-duplicate validators were a maintenance hazard. Treating the normalized structure as intentional across all labs.

**Decision note:** Duplicate lab number `01` is treated as expected (not a failure). Running the normalizer renamed `labs/01-intro-workshop` "What You'll Learn" -> "## 🎯 Objectives" (only edit made).

## 2026-06-22 — 2026-06-22T00:00:00Z: Lab content-quality stub replacement

Owner: Lambert (Content Dev)
Merged by: Scribe
Source: .squad/decisions/inbox/lambert-content-quality.md
Requested by: Russ Rimmerman [MSFT]

### Decision summary

Replaced all low-quality placeholder stubs in `labs/` with real, lab-specific content and filled the two validator-flagged gaps in the two Lab 01 variants. Validator (`validate_labs.py`) now reports 36/36 PASS.

**Why:** Russ chose "Standardize all labs (keep + improve)" — keep the standardized `labs/NN-slug/index.md` structure but replace placeholder/stub bodies with genuine content.

### Key decisions

- For labs 06-10, the empty `## Metadata` heading and the placeholder `## 🎯 Objectives` ("Learner objective 1/2") were fixed by *relocating* each lab's existing metadata table directly under `## Metadata` (matching the convention in labs 02/03/04/11) and writing 4 real, lab-specific objectives under Objectives. Chose to move the table rather than delete the heading, to keep structure consistent across labs.
- For labs 05/12/13, replaced "Verify that the agent works as expected." with concrete, checkable success criteria specific to each lab (VS Code agent-as-code, ServiceNow integration, Snowflake analytics).
- Lab 01-energy-ops-agent: added a `## ✅ Validation — Success Criteria` section before Lab Complete with checks tied to the four knowledge sources, grounding/citations, web-search-off, and safety boundaries.
- Lab 01-intro-workshop: replaced the inline `**Duration:** ... **Level:** ...` line with a proper emoji-prefixed Metadata table; added `## ✅ Validation` and `## ✅ Lab Complete` (summary + suggested next labs).
- Preserved all six `> 🔗 **Related lab:** / **Related feature labs:**` cross-link callouts exactly. No README, Python script, or folder/file structure changes.

