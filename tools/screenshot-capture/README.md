# Microsoft AI Training Generator — Screenshot Capture Tool

Interactive Playwright script that helps you capture every screenshot referenced in a lab's `index.md`, with the exact filenames already wired into the markdown.

## What it does

1. Launches headed Chromium so you can sign in normally, then persists auth in `./.auth`.
2. Walks [`shots.json`](./shots.json) one shot at a time, printing the section and setup steps.
3. Optionally navigates, sets viewport/zoom, and best-effort dismisses cookie banners, teaching tips, popovers, and toasts before prompting.
4. Waits for your keystroke, captures the active tab, saves to `labs/<lab>/assets/<filename>.png`, and verifies the PNG.

The script never types into Copilot Studio or configures the agent — you drive sign-in, UI setup, and final shot approval.

## One-time setup

```powershell
cd tools/screenshot-capture
npm install
npx playwright install chromium
```

## Usage

```powershell
npm run capture              # capture shots missing on disk
npm run list                 # show existing/missing shots
node capture.js --help       # show all flags and keystrokes
node capture.js --dry-run --missing  # validate catalog without launching Playwright
node capture.js --all        # re-capture everything
node capture.js --only=3,7   # capture specific shot IDs
node capture.js --range=5-10 # capture an inclusive ID range
node capture.js --from=5     # start at shot ID 5
```

Selection precedence is `--only` > `--range` > `--from` > `--missing` default; conflicting selection flags are rejected.

### Verify screenshot consistency

```powershell
npm run verify
node verify-shots.js --lab=06-energy-weather-agent
node verify-shots.js --json
node verify-shots.js --strict
```

`verify-shots.js` scans lab markdown, `shots.json`, and lab assets for schema drift, missing or invalid image files, markdown/catalog mismatches, tiny placeholder-like PNGs, and orphan PNG/JPEG assets. It exits `0` when there are no critical findings, `1` when critical findings exist; `--strict` also fails on warnings.

Use `node verify-shots.js --check-state` before committing Lab 06 screenshot work to add a byte-size denylist check for known placeholder PNG fingerprints. The heuristic reports CRITICAL `restored-placeholder` findings for Lab 06 PNGs whose file size exactly matches one of the known-bad placeholders. A false positive is possible if a real capture lands on the exact same byte size, but that is extremely unlikely; inspect and re-capture if it happens.

## Heads-up: commit deletions promptly

Deleted Lab 06 placeholder PNGs still exist in git history. `git restore`, VS Code **Discard Changes**, or **Discard All Changes** can restore them into the working tree; run the state check before committing screenshot changes.

> ⚠️ **Heads up:** npm 11 strips unknown flags like `--all` from `npm run capture -- --all`. Use the direct `node capture.js …` form when passing flags. `npm run capture` and `npm run list` are wired in `package.json` so they work as-is.

## During a capture session

Get the browser into the right state, then use the terminal keystrokes shown in the one-line prompt:

- `Space` — snap, verify, save, and advance
- `r` — retry/re-snap the current shot after you tweak the UI
- `n` — skip this shot without saving
- `q` — quit gracefully, close Chromium, and persist auth
- `?` — re-print the current instructions

Each exit path prints snapped/skipped/retried/failed-verify counts and the remaining missing filenames.

## Optional `shots.json` fields

Each shot still requires `id`, `filename`, `section`, and `instructions`. Optional fields are:

```json
{
  "section": "topics",
  "url": "https://copilotstudio.microsoft.com/...",
  "labSection": "Use Case #1, Step 2",
  "viewport": { "width": 1440, "height": 900 },
  "zoom": 1.0,
  "highlight": { "selector": "[data-id='target']", "label": "Future callout" }
}
```

`url` navigates before prompting when the active page is elsewhere. When `url` is absent, `section` is treated as a current-agent section such as `topics`, `actions`, `agents`, `settings`, or `evaluations`; if the browser is already under `/environments/.../bots/.../`, the tool keeps the current environment/agent and replaces only the trailing section. Absolute `url` values win over `section`. If no current agent is open, the tool prints a hint and waits for manual navigation. `labSection` keeps the human lab step label for prompts. `viewport` and `zoom` reset to 1440x900 / 1.0 between shots before applying shot overrides. `highlight` is reserved for future callout-arrow work and is not implemented yet.

## Feature tour screenshots (all six products)

The feature tour has one generated shot list per product, with one or more shots for every feature in the lab builder catalog (`npm run feature-tour:build` regenerates them; CI fails if they are stale):

| Product id | Shot list | Shots |
| --- | --- | --- |
| `copilot-studio` | `feature-shots.json` | 136 |
| `m365-copilot-agent-builder` | `feature-shots.m365-copilot-agent-builder.json` | 43 |
| `sharepoint-ai` | `feature-shots.sharepoint-ai.json` | 31 |
| `ai-foundry` | `feature-shots.ai-foundry.json` | 38 |
| `m365-copilot-hub` | `feature-shots.m365-copilot-hub.json` | 33 |
| `power-platform-ai-hub` | `feature-shots.power-platform-ai-hub.json` | 44 |

**No real screenshots exist yet for any of them**: `docs/feature-tour/screenshots/` is empty, so every shot is pending. The tools never sign in for you and never fabricate images; you capture them against your own test tenants.

Every list writes PNGs to the same folder, `docs/feature-tour/screenshots/`, and each product keeps its own browser profile in `.auth/<product>/`, so you sign in once per product and tenant. The GitHub Pages feature tour and the lab generator pick captured images up with no code changes.

```bash
npm run status                                          # captured vs pending per product, and the exact next command
node status.mjs --product=sharepoint-ai                 # per feature for one product (--detail for all, --json, --strict)
node capture.js --features --list                       # every product's shots, with section names
node capture.js --product=sharepoint-ai --missing       # capture one product's missing shots
node capture.js --product=sharepoint-ai --section=sharepoint-admin-center --missing   # one portal area
node capture.js --product=ai-foundry --feature=<feature-id>   # specific features
node capture.js --product=all --missing                 # every product in turn
node capture.js --product=<id> --dry-run                # print the plan, no browser
node verify-shots.js --features --missing               # every product's pending shots
node verify-shots.js --product=<id> --strict-missing    # fail while that product has pending shots
```

`--features` alone means `--product=copilot-studio` (`--harness=standard|both|microsoft-copilot|customer-conversation` applies to Copilot Studio only, the one product with harnesses). With `--list` or `--dry-run` and no `--product`, `--features` covers every product. `--feature`, `--section`, and `--harness` filters combine with `--missing`, `--all`, `--only`, `--range`, and `--from`; shot ids are per product.

Feature shots also print the steps to reach the screen and the numbered callouts. After each snap the tool writes `<name>.callouts.json` with the position of every callout so the site can draw hotspots (this works the same for every product). A shot marked `manual` (a terminal or Visual Studio Code) is not screenshotted by the tool: save the image at the printed path, then press `Space` to verify it. Missing feature screenshots are reported as pending, not failures; add `--strict-missing` to `verify-shots.js` to fail on them.

### Tenant-specific addresses

Public sign-in and portal addresses come from Microsoft Learn and live in [`tools/feature-tour/capture-products.json`](../feature-tour/capture-products.json). For an address that is yours, set an environment variable before the run; it must be an `https` URL.

| Variable | Used for |
| --- | --- |
| `CAPTURE_COPILOT_STUDIO_START_URL` | Copilot Studio start page (regional or government host). |
| `CAPTURE_M365_AGENT_BUILDER_START_URL` | Agent Builder start page. |
| `CAPTURE_SHAREPOINT_AI_START_URL` | SharePoint AI start page. |
| `CAPTURE_SHAREPOINT_SITE_URL` | A SharePoint site you own (site, library, and agent builder shots). |
| `CAPTURE_SHAREPOINT_ADMIN_URL` | `https://<TenantName>-admin.sharepoint.com` (SharePoint admin center shots). |
| `CAPTURE_M365_ADMIN_URL` | A specific Microsoft 365 admin center address. |
| `CAPTURE_FOUNDRY_START_URL` | Foundry start page. |
| `CAPTURE_FOUNDRY_PROJECT_URL` | Your Foundry project page (project and agent shots). |
| `CAPTURE_M365_COPILOT_HUB_START_URL` | Copilot hub start page. |
| `CAPTURE_POWER_PLATFORM_START_URL` | Your Power Platform environment, for example `https://make.powerapps.com/environments/<environment-id>/home`. |

`--dry-run` shows which variable each shot uses and whether it is set. The step-by-step guide for each product (tenant, licenses, roles, preview features, sample data, capture order) and a checklist are in [`docs/feature-tour.md`](../../docs/feature-tour.md).

## Notes

- Login state is stored in `tools/screenshot-capture/.auth/` (feature tour: `.auth/<product>/`). That directory is git-ignored — never commit it. The first Copilot Studio feature tour run after upgrading asks you to sign in again, because it now uses `.auth/copilot-studio/`.
- PNGs land directly in `labs/06-energy-weather-agent/assets/` with filenames declared in `shots.json`.
- The default manifest is currently configured for Lab 06. Use `--manifest=<path>` for another lab instead of rewriting the default catalog.
- Tests (`node --test "test/*.test.mjs"`) are hermetic: they run `--dry-run` and use temporary fixture images, so they need neither Playwright nor a tenant.
