# Project Context

- **Project:** CopilotStudioLabs
- **User:** Russ Rimmerman
- **Description:** Hands-on Copilot Studio labs for energy company customers.
- **Tech Stack:** Markdown content, US Census Bureau APIs, Power Automate flows, MCP servers (Node.js), Microsoft Copilot Studio
- **Initialized:** 2026-06-12T23:54:28-05:00

## 2026-06-13T23:58:38-05:00

- Collaborated on the upgrade test plan for `setup.js` and `tools/screenshot-capture`. Artifacts live in `.squad/files/upgrade-test-plan-architecture.md`, `.squad/files/upgrade-test-tooling-mechanics.md`, `.squad/files/upgrade-test-matrix.md`, and `.squad/files/upgrade-test-content-contract.md`; session context is logged in `.squad/log/2026-06-13T23-58-38Z-upgrade-test-plan.md`.

## 2026-06-14T01:06:33-05:00

- Fixed the provisioning portal scenario-selection bug by making scenario cards and role checkboxes explicitly selectable; changes touched `portal/public/app.js` and `portal/public/index.html` and were verified with `node --check` plus a live API smoke test.

## 2026-06-14T02:14:00-05:00

- Added Deployment Configuration card provenance tooltips across the portal. Summary cards and config fields now expose configured-at and monitored-at locations with clickable links; implementation touched `portal/public/app.js` and `portal/public/index.html`. Scribe merged the decision into `.squad/decisions.md` and logged the session in `.squad/log/2026-06-14T02-14-00-05-00-deployment-config-tooltips.md`.

## 2026-06-14T03:08:00-05:00

- Fixed broken lab screenshots in the portal by mounting `labs/` as `/labs` in `portal/server.js` and rewriting rendered `/api/labs/:id` local relative `<img>`/`<a>` URLs to `/labs/<labId>/<asset-path>`. Verification reported: `node --check` passed, asset GET returned `200 image/png`, `/api/labs/:id` returned `200`, lab 04 had 18 rewritten image sources, and 0 unrewritten relative sources remained. Scribe merged the decision into `.squad/decisions.md` and logged the session in `.squad/log/2026-06-14T03-08-00-05-00-portal-lab-asset-paths.md`.

## 2026-06-14T03:24:00-05:00

- Applied Kane's Lab 04 screenshot remediation worklist by updating 17 `tools/screenshot-capture/shots.json` entries (ids 1-17), deleting the 17 placeholder/wrong PNGs under `labs/04-energy-census-advanced-agent/assets`, and validating `shots.json` parseability. Remaining user action is to run `npm run capture` while signed into Copilot Studio.



## 2026-06-14T10:55:00-05:00

- Enhanced `tools/screenshot-capture/capture.js` and its README with per-shot optional `url`/`viewport`/`zoom` fields, reserved future `highlight` support, overlay auto-dismissal, single-key human-in-the-loop controls, PNG verification after capture, dry-run/missing/from/help flags, and session summaries. Also re-deleted the 17 Lab 04 placeholder/wrong PNGs that had reappeared so only `copilot-studio-home.png` remains; `npm run verify` now correctly reports 17 critical missing-image-file findings and `node capture.js --dry-run --missing` queues all 17. The reappearance is a state-regression signal for a future workflow guardrail such as `.gitignore` or pre-commit/pre-restore reminders.

## 2026-06-14T20:16:00-05:00

- Shipped Lab 04 screenshot deeplinks by adding per-shot `section` navigation for all 18 shots, absolute `url` targets for Copilot Studio home and Power Automate, and `capture.js` support that rewrites the current agent URL to the requested section with an operator hint fallback. Observed the third placeholder-restoration regression in 24 hours, re-deleted the 16 restored placeholder PNGs while preserving Russ's real `topic-add-from-blank.png` and good `copilot-studio-home.png`, and installed the guardrail: README warning plus `verify-shots.js --check-state` CRITICAL `restored-placeholder` detection. Scribe merged both decisions and logged the session in `.squad/log/2026-06-14T20-16-00-05-00-dallas-deeplinks-placeholder-guardrail.md`.

## 2026-06-14T20:50:00-05:00

- Shipped lab walkthrough PDF generation under `tools/lab-pdf/`, including Markdown rendering through `marked`, Playwright Chromium PDF printing, inline screenshots scaled to 720px, missing-image placeholders, and a full-size screenshot appendix with thumbnail/back-link navigation. The portal now exposes `GET /api/labs/:id/pdf` for fresh pre-generated PDFs and adds a download button plus a vanilla-JS screenshot lightbox with wheel zoom, pan, keyboard controls, and focus trapping. Lab 04 PDF generation and endpoint headers were verified; Scribe merged the decision and logged the session in `.squad/log/2026-06-14T20-50-00-05-00-dallas-lab-pdf-generator.md`.

## 2026-06-15T00:55:00-05:00

- Authored the first Lab 04 MCP rewrite after Kane's critical audit: removed the incorrect local stdio Copilot Studio pattern and desktop-client `mcpServers` JSON, reframed Use Case #8 around a reachable Streamable HTTP server and the Copilot Studio MCP onboarding wizard fields, added dependency/run/reachability guidance, and verified relevant Microsoft Learn pages plus MCP SDK package metadata. Dallas was then locked out after Kane rejected the singleton transport sample.

## 2026-06-15T01:59:09-05:00

- Implemented R1 (Codespaces devcontainer for MCP labs): Created `.devcontainer/devcontainer.json` with Node.js 20 LTS baseline and port forwarding for 3000, 3001, 5173, 8080. Added `.devcontainer/Dockerfile` with jq, Python 3, zip/unzip utilities. Updated `README.md` with Codespaces quickstart and authored `docs/codespaces.md`. Post-create commands install root, portal, lab PDF tooling, and screenshot tooling dependencies. Verified labs 03, 04, 05, 07; Lab 18 flagged for `@microsoft/agents-copilotstudio-client@^0.5.0` dependency follow-up. Decision merged to `.squad/decisions.md`; orchestration log written.

## 2026-06-15T10:48:18-05:00

- Audited app registration permission requirements for Labs 03, 05, 07. Authored `docs/app-registration-setup.md` documenting auth patterns: Lab 03 viable with app-only Dataverse (application user + security roles) for MCP custom calls; Labs 05 and 07 require delegated auth (VS Code extension sign-in and Copilot Studio/Fabric authoring access respectively). Key finding: `Dynamics CRM / user_impersonation` is delegated-only, not app-only; Power Platform API uses RBAC roles; Microsoft Graph `Mail.Send` is portal-only. Decision merged to `.squad/decisions.md`; session logged in `.squad/log/2026-06-15T10-48-18Z-app-reg-audit.md` and orchestration log written.

## 2026-06-15T12:21:41-05:00

- Built `scripts/verify-app-reg.js`: Node script (native `fetch`, no new root deps) that validates app registration setup by testing AAD token acquisition and Dataverse WhoAmI calls. Script supports optional `.env.local` loading via `dotenv` (portal dep) with fallback built-in parser; token-only validation mode (default) and Dataverse mode (with `--env-url`); surfaces AADSTS error codes with remediation guidance. Updated `package.json` with `verify:appreg` script; updated `docs/app-registration-setup.md` Section 5 with usage. Decision merged to `.squad/decisions.md`; logs written to `.squad/log/` and `.squad/orchestration-log/`.

## 2026-06-15T12:34:51-05:00

- Changed portal default port from 3000 to 3005 across server, Docker, devcontainer, Codespaces docs, approval link fallbacks, and portal Azure Bicep IaC. Left Lab 04 MCP sample instructions on port 3000 (correct for sample server, not portal) and Lab 06 account 30001234 unchanged. Validated: git diff --check, node --check, JSON parse all PASSED. Flagged for follow-up: Entra app registration redirect/reply URLs if pointing to localhost:3000 require external update to localhost:3005. Decision merged to `.squad/decisions.md`; orchestration and brief logs written.

## 2026-06-22T00:00:00Z

- Generalized the lab helper scripts to cover labs 01-35. `edit_labs.py` now discovers `labs/NN-*` folders by scanning instead of `range(2,19)`, and normalization is idempotent/safe (inserts `## Metadata` only when neither a Metadata heading nor emoji metadata table exists; renames "What you'll learn" to `## 🎯 Objectives` only when no canonical Objectives heading exists; never touches well-formed labs or `> 🔗 Related lab:` callouts). Consolidated both validators into a single `validate_labs.py` (union of section checks; metadata passes on either a `## Metadata` heading or emoji metadata table; README `labs/...` links resolved against disk; intentional duplicate lab `01` reported as expected via ALLOWED_DUPLICATE_NUMBERS={1}). Deleted `validate_labs_new.py`. Ran both scripts; final state 36/36 PASS. Decision merged to `.squad/decisions.md`; orchestration and session logs written.
