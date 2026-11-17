# Microsoft AI Training Generator — Screenshot Capture Tool

Interactive Playwright script that helps you capture every screenshot referenced in a lab's `index.md`, with the exact filenames already wired into the markdown.

## What it does

1. Launches headed Chromium so you can sign in normally, then persists auth in `./.auth`.
2. Walks [`shots.json`](./shots.json) one shot at a time, printing the section and setup steps.
3. Optionally navigates, sets viewport/zoom, and best-effort dismisses cookie banners, teaching tips, popovers, and toasts before prompting.
4. Waits for your keystroke, captures the active tab, saves to `labs/<lab>/assets/<filename>.png`, and verifies the PNG.

The script never types into Copilot Studio or configures the agent — you drive sign-in, UI setup, and final shot approval.

## Local Capture Companion (capture from the portal)

The Azure-hosted portal has no browser and no way to sign in to your tenant, so it cannot capture screenshots itself. The **Local Capture Companion** (`companion.mjs`) runs on your own computer instead: the portal queues a capture job, the companion steps through each shot in a headed Chromium window, checks every image, hides account details, and uploads it back. The portal verifies the image again, then updates the lab's HTML, Word, and PowerPoint files and its Microsoft Learn sync state automatically. Paste or upload in the portal is the fallback for any single shot.

### Quick start

1. In the portal, open the Screenshot Center, select **Connect a computer**, and download the companion (or use this folder from the repository). You need Node.js 20 or later.
2. Run the launcher for your system. It installs what is missing the first time (`npm install` and `npx playwright install chromium`):

   ```powershell
   .\start-companion.cmd --portal=https://<your-portal> --code=ABCD-EFGH     # Windows (or start-companion.ps1)
   ```

   ```bash
   ./start-companion.sh --portal=https://<your-portal> --code=ABCD-EFGH     # macOS and Linux
   ```

   Or, from the repository: `cd tools/screenshot-capture && npm install && npx playwright install chromium && npm run companion -- --portal=<address> --code=<code>`. Without `--portal` and `--code` it asks for them. The pairing code works once and expires in 10 minutes.
3. Leave the window open. The portal shows **Companion connected**. Queue a capture there for a lab or for the shared library; the companion picks it up within a few seconds.
4. The first time a product needs sign-in, a browser window opens. Sign in yourself; the profile is saved in `.auth/<product>/` and reused, so you sign in once per product. If a shot ends on a Microsoft sign-in page, the companion refuses it, tells the portal, and you queue the shot again after signing in.

| Command | What it does |
| --- | --- |
| `node companion.mjs` or `--watch` | Keep polling the portal and run queued or stale jobs as they arrive (default). |
| `node companion.mjs --once [--wait=60]` | Run one queued job, then exit. `--wait` keeps asking for that many seconds before giving up. |
| `--status` | Show the connection, when the pairing expires, and which products you are signed in to. |
| `--check` / `--install-browser` | Check this computer is ready (Node, Playwright, Chromium) / install Chromium. |
| `--callouts=sidecar\|burn\|none` | Numbered callouts: positions saved next to the image (default), drawn on the image, or skipped. |
| `--mask=Contoso,contoso.com` | Extra text to hide, such as your tenant name. `--no-redact` turns masking off (not recommended). |
| `--headless` | No visible window. It cannot sign in, so use it only for public pages and automated checks. |
| `--unpair` | Forget this computer's pairing. Select **Disconnect** in the portal to remove it there too. |

Press Ctrl+C once to stop after the current screenshot; twice to quit now. Canceling a job in the portal also stops the companion between shots.

### Security model

- **Paired, scoped, revocable.** A one-time code is traded for a capture token (`cap_...`). The portal keeps only a hash of the code and the token, compares them in constant time, extends the token while you use it, and lets you disconnect the computer at any time. The token opens only the companion endpoints; it is not a portal sign-in and cannot read or change anything else. A revoked or expired token is refused and the companion tells you to pair again.
- **Nothing secret in the download or in git.** The portal's download and this folder contain no tokens. The pairing file `.companion.json`, your browser sign-ins (`.auth/`), and in-progress captures (`.captures/`) stay on your computer and are git-ignored. The token is saved with owner-only permissions where the system supports it and is never printed.
- **Your credentials never leave your computer.** You sign in yourself in a real browser window. Only screenshots, page addresses (without query strings), the page title, and visible control names are sent, and only to the portal you paired with. Portal addresses must be `https` (`http` is allowed for `localhost` only).
- **It never types into tenant pages and never deletes.** Steps are limited to opening an `https` page, waiting, dismissing banners, and clicking or focusing a labeled control. It skips any control whose name says delete, remove, erase, purge, destroy, disconnect, unregister, revoke, or reset, whatever the portal asks for.
- **Account details are hidden.** Before each picture it draws a solid block over the account control and over any email address, tenant host name (`*.onmicrosoft.com`, SharePoint admin and personal hosts), or `--mask` term on the page, then removes the blocks. Text sent to the portal as evidence is scrubbed the same way. Always look at a screenshot before you publish it.
- **Verified twice.** Both the companion and the portal check magic bytes (PNG, JPEG, WebP), size (5 KB to 8 MB), dimensions, blank or sign-in pages, and a match with the expected control names. The portal never trusts what the companion reports for a security decision.
- **Tenant addresses.** A job can carry `CAPTURE_*` addresses (https only) for your tenant, for example from the lab's brand profile. They override same-named variables on your computer for that job only.

### Troubleshooting

| What you see | What to do |
| --- | --- |
| `The Playwright package is not installed` or `The Chromium browser is not installed` | In this folder run `npm install` then `npx playwright install chromium`, or run with `--install-browser`. |
| `Node.js 20 or later is required` | Install a current Node.js LTS from nodejs.org. |
| `Cannot reach the portal at ...` | Check your internet connection or VPN and the portal address. In watch mode the companion keeps trying and backs off up to a minute. |
| `That pairing code is not valid` or `expired` | Select **Connect a computer** in the portal for a new code. Codes work once and last 10 minutes. Several wrong codes in a row pause pairing for a few minutes. |
| `This computer was disconnected in the portal` or `connection expired` | Pair again with a new code. The old token is deleted from `.companion.json`. |
| A shot says you were not signed in | Sign in in the browser window the companion opened (it waits up to 10 minutes, `--sign-in-wait`), then queue the shot again. |
| `The picture came out blank` | The page did not finish loading. The companion retries once; if it still fails, make sure the page opens for your account, then queue it again. |
| A shot is `skipped` and names a `CAPTURE_...` variable | That screen needs your tenant address. Add it to the job (or set the variable on this computer) and queue it again. |
| A shot is `manual` | It is outside the browser (a terminal or Visual Studio Code). Capture it with an OS screenshot tool and upload it in the portal. |
| The portal shows a shot as `needs review` | The image passed the hard checks but has a warning (for example, few expected labels were visible). Look at it in the portal, then accept it or retake it. |

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

- Login state is stored in `tools/screenshot-capture/.auth/` (feature tour: `.auth/<product>/`). That directory is git-ignored — never commit it. The Local Capture Companion uses the same folder, so a sign-in made with either tool works for both. Its pairing file `.companion.json` and `.captures/` are git-ignored too. The first Copilot Studio feature tour run after upgrading asks you to sign in again, because it now uses `.auth/copilot-studio/`.
- PNGs land directly in `labs/06-energy-weather-agent/assets/` with filenames declared in `shots.json`.
- The default manifest is currently configured for Lab 06. Use `--manifest=<path>` for another lab instead of rewriting the default catalog.
- Tests (`node --test "test/*.test.mjs"`) are hermetic: they run `--dry-run` and use temporary fixture images, so they need neither Playwright nor a tenant.
