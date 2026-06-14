# Squad Decisions

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

- Adapted the upstream Microsoft Copilot Agents Labs analytics/evaluations practices into the Sempra Lab 2 voice rather than copying generic content.
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

