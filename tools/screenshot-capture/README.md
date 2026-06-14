# Copilot Studio Labs — Screenshot Capture Tool

Interactive Playwright script that helps you capture every screenshot referenced in a lab's `index.md`, with the exact filenames already wired into the markdown.

## What it does

1. Launches a real Chromium window (not headless) so you can sign in to Copilot Studio normally.
2. Walks you through each shot in [`shots.json`](./shots.json) one at a time:
   - Prints the section it belongs to
   - Prints the setup steps you need to perform in the Copilot Studio UI
   - Waits for you to press **Enter**, then snaps the active tab and saves to `labs/<lab>/assets/<filename>.png`
3. Persists your sign-in state in `./.auth` so you only log in once.

The script never types anything into Copilot Studio — you drive the UI, it just snaps and files screenshots correctly.

## One-time setup

```powershell
cd tools/screenshot-capture
npm install
npx playwright install chromium
```

## Usage

```powershell
# Capture every shot that doesn't exist on disk yet
npm run capture

# See which shots already exist and which are missing
npm run list

# Re-capture even shots that already exist
node capture.js --all

# Only capture specific shot IDs
node capture.js --only=3,7,12

# Capture an inclusive range of IDs
node capture.js --range=5-10
```

> ⚠️ **Heads up:** npm 11 strips unknown flags like `--all` from `npm run capture -- --all`. Use the direct `node capture.js …` form when passing flags. `npm run capture` and `npm run list` are wired in `package.json` so they work as-is.

## During a capture session

For each shot the script prints something like:

```
────────────────────────────────────────────────────────────────────────
Shot #2  →  adaptive-card-json-editor.png
Section: Use Case #1, Step 3

Setup steps:
  • Open the Service Territory Lookup topic and add an 'Ask with adaptive card' node.
  • Open the card editor and switch to the JSON view.
  • Paste the city/state/zipCode payload from the lab so the JSON is fully visible.

Press [Enter] to capture, [s] to skip, [f] for fullscreen+capture, [q] to quit:
```

Get the Copilot Studio UI into the right state in the browser window the script opened, then press Enter back in the terminal. The script captures the **active tab** (the one in front), so feel free to use multiple tabs.

- `Enter` — capture the visible viewport of the active tab
- `s` — skip this shot, move to the next
- `f` — try to make the active tab fullscreen first, capture, then exit fullscreen
- `q` — quit the run, leave the browser open

## What gets saved

PNGs land directly in:

```
labs/04-energy-census-advanced-agent/assets/
```

with the exact filename declared in `shots.json` — those filenames are the ones already referenced in the lab's `index.md`, so the images render automatically as soon as they exist.

## Notes

- Login state is stored in `tools/screenshot-capture/.auth/`. That directory is git-ignored — never commit it.
- The browser stays open after the run finishes so any in-progress lab work isn't lost. Close it manually when you're done.
- If you want to add or change shots, edit [`shots.json`](./shots.json) — `id`, `filename`, `section`, and `instructions` are all the script needs.
- This tool is currently configured for Lab 04 only. To use it for another lab, change the `lab`, `assetsDir`, and `shots` keys in `shots.json` (or copy the folder to a per-lab path).
