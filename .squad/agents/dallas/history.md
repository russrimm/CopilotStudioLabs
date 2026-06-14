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
