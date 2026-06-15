# Copilot Studio Labs — Screenshot Capture Tool

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
node verify-shots.js --lab=04-energy-weather-agent
node verify-shots.js --json
node verify-shots.js --strict
```

`verify-shots.js` scans lab markdown, `shots.json`, and lab assets for schema drift, missing or invalid image files, markdown/catalog mismatches, tiny placeholder-like PNGs, and orphan PNG/JPEG assets. It exits `0` when there are no critical findings, `1` when critical findings exist; `--strict` also fails on warnings.

Use `node verify-shots.js --check-state` before committing Lab 04 screenshot work to add a byte-size denylist check for Kane's known placeholder PNG fingerprints. The heuristic reports CRITICAL `restored-placeholder` findings for Lab 04 PNGs whose file size exactly matches one of the known-bad placeholders. A false positive is possible if a real capture lands on the exact same byte size, but that is extremely unlikely; inspect and re-capture if it happens.

## Heads-up: commit deletions promptly

The deleted Lab 04 placeholder PNGs still exist in git history. Until both the deletions and the replacement captures are committed, `git restore`, VS Code **Discard Changes**, or **Discard All Changes** can restore those placeholder files into the working tree. Stage the placeholder deletions and good captures together, commit them promptly, and then continue capturing the remaining screenshots.

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

## Notes

- Login state is stored in `tools/screenshot-capture/.auth/`. That directory is git-ignored — never commit it.
- PNGs land directly in `labs/04-energy-weather-agent/assets/` with filenames declared in `shots.json`.
- This tool is currently configured for Lab 04 only. To use another lab, change `lab`, `assetsDir`, and `shots` in `shots.json`.
