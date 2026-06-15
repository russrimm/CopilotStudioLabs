# Tooling Mechanics Report — setup.js and screenshot-capture

Owner: Dallas (Backend Dev)  
Requested by: Russ Rimmerman  
Date: 2026-06-13

## Scope reviewed

- `setup.js` end-to-end.
- Root `package.json` setup/capture scripts.
- `tools/screenshot-capture/package.json`, `capture.js`, `shots.json`, `.gitignore`, and README.
- Root `.gitignore` / `.gitattributes` for merge and user-state clues.

## 1. Idempotency audit of `setup.js`

### Overall answer

Running `npm run setup` twice with the same config is mostly filesystem-idempotent for the current implementation, but only because the script is destructive and only replaces the original template defaults. It does not track prior customization state, does not regenerate removed files, and has replacement-order edge cases.

### Code path walkthrough

1. Config loading and prompts (`setup.js` lines 73-99)
   - Reads only the selected JSON config.
   - In non-dry-run mode, always prompts before writing.
   - No persisted state is read or written, so the script has no memory of prior runs.

2. Replacement map (`setup.js` lines 101-127)
   - Builds replacements only from hard-coded `DEFAULTS` values at lines 24-34 to current config values.
   - If config values equal defaults, no replacement is added.
   - On a second run with the same config, files already changed from defaults to custom values usually no longer contain the `from` strings, so no further text edits happen.

3. Lab selection/removal (`setup.js` lines 129-149)
   - `allLabs` is computed from folders currently on disk.
   - `includedLabs = labConfig.include || allLabs` at line 137.
   - `excludedLabs = allLabs.filter(...)` at line 138.
   - First run deletes excluded lab directories using `rmSync(..., { recursive: true, force: true })` at line 147.
   - Second run cannot delete those same labs again because they are no longer present in `allLabs`.
   - This is idempotent in the narrow sense, but destructive.

4. Markdown replacements (`setup.js` lines 152-189)
   - Walks `labs/` recursively for `.md` files and adds root `README.md`.
   - Skips dot-directories and `node_modules` at line 54.
   - Uses literal string splitting/joining at lines 64-67, not regex.
   - Writes changed Markdown files in place at line 185.
   - Same-config second run usually produces no changes because defaults were already removed.

5. README lab references (`setup.js` lines 191-217)
   - Despite the script comment, it does not regenerate the full README lab table. It only removes rows/sections for `excludedLabs`.
   - This block only runs when `excludedLabs.length > 0` at line 192.
   - Second run after deletion has `excludedLabs = []`, so the README cleanup does not run.

### Non-idempotent or fragile behavior

- Replacement chaining can happen within a single run. Replacements are applied sequentially at lines 172-174. If a replacement target contains another replacement source, the newly inserted text can be replaced again. Example: setting `organization.name` to `Contoso Energy` while also changing `organization.fullName` can cause the org-name replacement to be transformed by the full-name replacement.
- The script cannot distinguish template defaults from user-authored text. Any matching default string in user edits is replaced on every run where it exists.
- README cleanup is not a true table regeneration. It removes excluded references but cannot restore or normalize the table.
- If all lab folders are manually removed or `labs/` disappears, `walkFiles(join(ROOT, "labs"), [".md"])` at line 154 can throw because the call is not guarded by `existsSync`.

## 2. Re-run-with-different-config audit

### Config A then config B behavior

If a user runs setup with config A, then later runs setup with config B:

- Existing content customized to A generally stays as A.
- The replacement map for config B still searches only for original default strings from `DEFAULTS` (lines 24-34), not for prior config A values.
- Old org names from A can remain throughout existing Markdown files.
- Any remaining original default strings are replaced with B, creating a mixed A/B repository.
- If config B values overlap with default strings, replacement-order chaining can produce unexpected substitutions.

### Previously removed labs

Previously removed labs do not come back.

- Labs are deleted from disk at line 147.
- Later, `allLabs` is derived from current disk state at lines 131-135.
- If config B includes a lab removed by config A, the script has no source from which to restore it.
- A fork-pull or manual restore from git is required before setup can process that lab again.

### Double replacement risk

The script does not generally double-replace A to B because it does not search for A. However, double replacement can occur in the same run when a replacement output equals or contains a later replacement input, due to sequential replacement order at lines 172-174.

## 3. Fork-pull-then-setup audit

Scenario: user customized `Contoso Energy` to `Contoso`, then pulls upstream template updates that add new files containing `Contoso Energy`.

### What works

- Re-running setup with the same Contoso config will scan all current lab Markdown files and root `README.md` at lines 153-156.
- Any newly pulled Markdown file containing original default strings is customized cleanly.
- Existing customized files usually remain unchanged.

### What does not work

- Only `.md` files under `labs/` and root `README.md` are processed. New default strings introduced into JSON, JS, YAML, screenshots metadata, docs outside `labs/`, or tool configs are not customized.
- If upstream reintroduces a lab directory that the fork had previously excluded, re-running setup will delete it again if it is not in `labs.include`.
- If upstream changes README lab-table structure, the regex row removal at line 198 may miss rows or remove too much.
- If the fork had manually edited README text containing default strings, those edits can be rewritten.

## 4. Dedup / merge surfaces

### Append vs replace

I did not find any append behavior in `setup.js`.

- Markdown content is rewritten in place only when replacements change content (`writeFileSync` line 185).
- README excluded-lab cleanup rewrites the entire README content (`writeFileSync` line 213).
- Lab directories are deleted with `rmSync` line 147.
- No config files are appended or mutated by setup.

### Dedup safety

- Since there are no append points, setup itself does not create duplicate blocks like an append-only changelog might.
- README removal is not dedup-aware because it is regex deletion, not parse/regenerate. Duplicate table rows that match excluded labs will all be removed by the global regex; duplicate included rows are untouched.
- Root `.gitattributes` uses union merge only for Squad state files, not setup-managed files. There is no special merge driver for README or labs.

## 5. User-state blast radius

### Files/directories `setup.js` writes

- Every Markdown file under `labs/**` after excluded labs are removed (`setup.js` lines 153-185).
- Root `README.md` during text replacement (`setup.js` lines 153-185).
- Root `README.md` during excluded-lab cleanup (`setup.js` lines 191-213).

### Files/directories `setup.js` deletes

- Any direct child directory under `labs/` not listed in `template.config.json` `labs.include` (`setup.js` lines 129-149).
- Deletion is recursive and forced, so it includes each excluded lab's:
  - `index.md`
  - assets/screenshots
  - local notes or user additions inside that lab folder
  - any nested files, regardless of extension

### User-state-likely paths and risk

| Path / state | Setup action | Risk |
|---|---:|---|
| `labs/<included-lab>/**/*.md` | Rewrites matching default strings | Medium: user-authored Markdown can be changed if it contains defaults. |
| `labs/<excluded-lab>/**` | Recursive delete | High: custom edits, screenshots, and added files are lost unless recoverable from git. |
| New custom lab under `labs/` not in `labs.include` | Recursive delete | High: custom lab additions can be removed accidentally. |
| `README.md` | Rewrites matching defaults; removes excluded lab rows/sections | High: user README edits can be changed or removed. |
| `labs/<lab>/assets/**` | Deleted only if containing lab excluded | Medium/High: captured screenshots are lost with excluded lab. |
| `tools/screenshot-capture/.auth/` | Not traversed or written | Low: setup does not touch it. |
| `tools/screenshot-capture/shots.json` | Not written | Low for setup; still an upgrade/merge surface if upstream changes shot definitions. |
| `tools/screenshot-capture/node_modules/` | Not written | Low; setup skips `node_modules` in walks. |
| Root `template.config.json` | Read only | Low; setup does not persist current/previous config. |
| Root/package tool files | Not written | Low for setup. |

## 6. Screenshot-capture tool

### Setup corruption risk

Re-running `setup.js` should not corrupt the screenshot-capture tool's runtime state.

- `setup.js` only walks `labs/` and `README.md`; it does not walk `tools/`.
- `tools/screenshot-capture/.auth/` is not touched by setup and is ignored by the tool `.gitignore`.
- `shots.json` is not touched by setup.
- Captured PNGs are written to the configured lab assets directory by `capture.js`, currently `labs/04-energy-census-advanced-agent/assets` from `shots.json`. Those PNGs can be deleted if that lab is excluded by setup.

### Its own upgrade surface

- `tools/screenshot-capture` has a separate `package.json` and `package-lock.json`.
- The README instructs users to run `npm install` and `npx playwright install chromium` from that subdirectory.
- If upstream changes `tools/screenshot-capture/package.json`, fork users may need to run `npm install` in `tools/screenshot-capture` after pulling.
- If upstream changes Playwright version, users may also need to rerun `npx playwright install chromium`.
- `shots.json` is user-editable configuration. Upstream changes can conflict with user edits; setup provides no merge or validation support for it.

## 7. Recommended hardening

1. Add prior-config/state awareness before public template-fork support.
   - Current issue: replacements only search hard-coded defaults (lines 24-34 and 101-127), so config A then B leaves mixed content.
   - Recommendation: write a small `.template-state.json` or similar containing the last applied values, then replace both defaults and previous values safely. Keep secrets out of this state file.

2. Replace sequential replacement with collision-safe tokenization.
   - Current issue: sequential `replaceAll` loop at lines 172-174 can replace text inserted by an earlier replacement.
   - Recommendation: first replace known defaults with temporary sentinels, then replace sentinels with target values, or use an ordered non-overlapping transform that guarantees inserted text is not reprocessed.

3. Change lab exclusion from destructive delete to quarantine/manifest-based removal.
   - Current issue: `rmSync` at line 147 permanently removes excluded lab folders and any user files inside them.
   - Recommendation: add `--delete-excluded` for destructive behavior; default to README filtering plus a generated include manifest, or move excluded labs to a recoverable `.excluded-labs/` folder that is clearly documented.

4. Make README handling a true generated block.
   - Current issue: line 191 says update table, but code only removes excluded references via regex lines 196-206.
   - Recommendation: wrap generated README lab table/sections in explicit markers and regenerate only that block from lab metadata. Preserve user-authored README sections outside markers.

5. Add dry-run diff and blast-radius warnings.
   - Current issue: dry-run lists excluded labs and replacement counts but does not enumerate all files that would be deleted or warn about custom labs.
   - Recommendation: before line 147 deletion, detect untracked/modified files under excluded labs using git status or file listing and print a hard warning. In non-interactive CI mode, fail unless `--force` is supplied.

## Bottom line

`setup.js` is acceptable as a first-run template customizer. It is not yet safe as an upgrade/re-sync command for long-lived forks because it has no memory of prior config, cannot restore removed labs, destructively deletes lab directories, and uses broad literal replacements over user-editable Markdown.
