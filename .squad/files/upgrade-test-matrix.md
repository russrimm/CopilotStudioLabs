# CopilotStudioLabs Upgrade Test Matrix

Owner: Kane (Tester)  
Requested by: Russ Rimmerman  
Created: 2026-06-13T23:58:38-05:00  
Model: Brady Gaster / Squad upgrade-testing pattern: three tiers, fan-out agents, clone/copy → upgrade → snapshot → verify must-change / must-NOT-change / idempotency → cleanup.

## Goal

Build an executable, repeatable upgrade/re-setup test plan for CopilotStudioLabs forks. The plan validates that `setup.js`, `template.config.json`, lab content, README updates, and `tools/screenshot-capture/` survive real fork drift without damaging user-owned work.

Target release-gate framing: **roughly 200-300 checks, under 10 minutes wall-clock, 99.6%+ pass rate**, with zero remote writes.

## Definitions

- **Candidate command**: the command under test, usually `node setup.js`, `node setup.js --dry-run`, or `npm run setup` with stdin confirmation.
- **Template-owned paths**: root `README.md`, `setup.js`, `package.json`, `template.config.schema.json` if present, `labs/<template-lab>/**`, and `tools/screenshot-capture/**` except ignored runtime state.
- **User-owned paths**: customized config, custom notes, custom labs, screenshots/exports, `.auth`, `.env*`, untracked work, and hand-edited markdown outside explicit placeholder replacement scope.
- **Snapshot**: both `git status --porcelain=v1 -uall` and a file hash manifest.
- **Second run**: repeat the same candidate command after the first successful run and verify idempotency.

## Tier 1 — Synthetic scenario matrix

All Tier 1 scenarios run in throwaway local sandboxes created by copying the repository working tree or cloning a local bare mirror. Do not run destructive tests in the live checkout.

Recommended command conventions:

```powershell
# Non-interactive real setup run
"y" | node setup.js

# Dry-run
node setup.js --dry-run

# Custom config
"y" | node setup.js --config .\template.config.json
```

| ID | Scenario | Starting state | Action | Expected diff | Edge-case category |
|---|---|---|---|---|---|
| S01 | Fresh fork, default config, first setup run | Clean checkout; default `template.config.json`; labs 01-05 present; no local edits. | `"y" | node setup.js` | Exit 0. Since config equals defaults, no markdown replacements. `git status --porcelain` should remain clean, unless setup normalizes README excluded-lab text unexpectedly. No lab directories removed. | Baseline / first run |
| S02 | Re-run with identical config | Start from S01 after first run; commit or snapshot after first run. | `"y" | node setup.js` twice | Second run produces zero file changes and no additional README whitespace/table drift. Console reports 0 replacements and 0 excluded labs. | Idempotency |
| S03 | Re-run with changed `organization.name` only | First run already applied config A with `organization.name = Contoso Energy`; then edit config to `organization.name = Fabrikam Grid` only. | `"y" | node setup.js` | Current implementation likely leaves `Contoso Energy` in existing markdown because replacements search only default `Contoso Energy`. Record as expected current limitation unless upgrade logic is added. Must not mix default and B values in newly untouched files. | Prior-config drift |
| S04 | Re-run with subset of labs excluded | Clean checkout; config `labs.include` contains only `01-energy-ops-agent` and `05-copilot-studio-vscode-agent-management`. | `"y" | node setup.js` | `labs\02-*`, `labs\03-*`, `labs\04-*` absent. `README.md` no longer links to excluded labs. Included labs remain. Second run is clean. | Destructive lab exclusion |
| S05 | Re-run after user manually edited lab markdown | Clean checkout; edit `labs\01-energy-ops-agent\index.md` adding a customer paragraph containing both ordinary text and the default string `Contoso Energy`. Config changes `organization.name` to `Contoso Energy`. | `"y" | node setup.js` | Template placeholders in lab markdown change to `Contoso Energy`. User paragraph with literal default string is also changed by current implementation; flag as 🟡 or 🔴 depending intended ownership. No unrelated lines change. | User markdown preservation |
| S06 | Re-run after custom file in included lab | Add `labs\01-energy-ops-agent\custom-notes.md` with customer notes, including one default token and one unique sentinel. Config changes org to `Contoso Energy`; lab 01 included. | `"y" | node setup.js` | File must still exist. Unique sentinel survives. Current implementation scans all `labs/**/*.md`, so default token inside `custom-notes.md` changes; flag as user-owned-content risk. | Custom file survival |
| S07 | Re-run after user added whole new lab dir | Add `labs\06-my-lab\index.md`, `labs\06-my-lab\assets\diagram.png`, and `labs\06-my-lab\custom-notes.md`; config includes only official labs 01-05. | `"y" | node setup.js` | Current implementation deletes `labs\06-my-lab\` because it is not in `labs.include`; flag as 🔴 if custom labs must be preserved/quarantined. README should not mention lab 06 unless user added it. | Custom lab deletion |
| S08 | Unicode/emoji orgName | Clean checkout; config `organization.name = "Société Générale 株式会社 ⚡"`; other fields default. | `"y" | node setup.js` | Markdown and README occurrences of `Contoso Energy` become exact Unicode string; UTF-8 preserved; no mojibake; second run zero diff. | Unicode / encoding |
| S09 | Special chars in orgName | Clean checkout; config `organization.name = "R&D \"Grid/AI\" & Co."`; optionally include apostrophe/backslash variants in a separate run. | `"y" | node setup.js` | Literal replacement succeeds without regex escaping issues. Markdown remains valid enough to render. No path creation from orgName. Second run zero diff. | Punctuation / escaping |
| S10 | Read-only file in labs, Windows + Unix | Set read-only on `labs\01-energy-ops-agent\index.md` (`attrib +R`) and, on Unix agent, `chmod a-w labs/01-energy-ops-agent/index.md`. Config changes org. | `"y" | node setup.js` | Either friendly non-zero failure before partial corruption or successful write only if platform permits owner override. Verify snapshot for partial changes. Cleanup resets permissions (`attrib -R`, `chmod u+w`). | Permission / locked file |
| S11 | Missing `template.config.json` | Rename `template.config.json` to `template.config.json.bak`; otherwise clean checkout. | `node setup.js` | Exit 1. Console says config file not found. Zero file changes. Restore config during cleanup. | Missing config |
| S12 | Corrupted/invalid JSON config | Replace `template.config.json` with invalid JSON such as `{ "organization": `. | `node setup.js` | Exit 1. Console reports setup failed / JSON parse error. Zero file changes. Restore config during cleanup. | Invalid config |
| S13 | `--dry-run` produces zero file changes | Config changes org, parent, tagline, and excludes labs 02-04. Snapshot before. | `node setup.js --dry-run` | Exit 0. Console lists intended replacements/exclusions. `git status` and hash manifest exactly match before snapshot. Labs 02-04 still exist. | Dry-run safety |
| S14 | Excluded lab dir does not exist already | Delete `labs\04-energy-census-advanced-agent\` before run. Config includes labs 01,02,03,05 only. | `"y" | node setup.js` | Exit 0. Missing excluded lab is tolerated. README references to lab 04 may remain because `excludedLabs` derives from on-disk labs; flag as bug if README must match config. Second run clean. | Partial old fork / already deleted |
| S15 | Empty `labs.include` means no labs | Clean checkout; config has `"labs": { "include": [] }`. | `"y" | node setup.js` | All direct `labs\*` dirs removed. README lab table/sections removed. `labs\` directory may remain empty. Second run clean. Verify this behavior is intentionally allowed before shipping. | Boundary config |
| S16 | Screenshot manifest hand-edited | Add custom entry to `tools\screenshot-capture\shots.json`; create matching fake PNG under configured assets; create `tools\screenshot-capture\.auth\sentinel.txt`. Run setup with org change. | `"y" | node setup.js`; optionally `cd tools\screenshot-capture; npm run list` | Setup must not modify `tools\screenshot-capture\shots.json` or `.auth`. If target lab is excluded, PNGs under that lab assets are deleted; flag according to lab-exclusion policy. `npm run list` is read-only. | Screenshot tool user state |

## Tier verification checklists

### Tier 1 synthetic checklist

#### Must-change, when applicable

- `README.md`
  - Default organization tokens are replaced when config changes values.
  - Lab links/rows for excluded labs are removed.
  - No links remain to deleted lab directories.
- `labs\01-energy-ops-agent\index.md`
- `labs\02-agent-analytics-evaluations\index.md`
- `labs\03-account-orchestration-agent\index.md`
- `labs\04-energy-census-advanced-agent\index.md`
- `labs\05-copilot-studio-vscode-agent-management\index.md`
  - Configured replacements appear exactly where default placeholders existed.
- Excluded directories such as:
  - `labs\02-agent-analytics-evaluations\`
  - `labs\03-account-orchestration-agent\`
  - `labs\04-energy-census-advanced-agent\`
  are absent only when explicitly excluded.

#### Must-NOT-change

- `template.config.json` must be read-only from setup's perspective.
- `setup.js` must not rewrite itself.
- `package.json` must not change.
- `tools\screenshot-capture\shots.json` must not change during setup.
- `tools\screenshot-capture\.auth\**` must not change or become tracked.
- `.squad\**`, `.github\**`, `.gitignore`, `.gitattributes`, `portal\**`, `scripts\**` must not change during setup.
- Custom files in retained labs must still exist, especially:
  - `labs\01-energy-ops-agent\custom-notes.md`
  - `labs\01-energy-ops-agent\assets\customer-screenshot.png`
- Custom lab directories such as `labs\06-my-lab\` must survive unless the current destructive deletion behavior is explicitly accepted and documented.
- Invalid/missing config and dry-run scenarios must leave the entire hash manifest unchanged.

#### Must-survive-second-run

- `git status --porcelain=v1 -uall` after second run matches the post-first-run expected state.
- Hash manifest after second run equals hash manifest after first run, excluding allowed runtime logs if any.
- No duplicate README lab rows.
- No repeated blank-line growth in `README.md`.
- No second deletion/failure for already absent excluded lab dirs.
- No replacement of replacement output, including Unicode and punctuation org names.

### Tier 2 known/internal repos checklist

Run the same workflow against read-only local clones of approved known repos.

#### Must-change

- Upstream template-owned files advance when a resync simulation is part of the test:
  - `setup.js`
  - `package.json`
  - `README.md` template-owned generated areas
  - `labs\<template-lab>\index.md` if unmodified by user
  - `tools\screenshot-capture\capture.js`
  - `tools\screenshot-capture\package.json`
  - `tools\screenshot-capture\package-lock.json`
  - `tools\screenshot-capture\README.md`
- Re-running setup applies defaults to newly pulled template Markdown containing original tokens.

#### Must-NOT-change

- Customer `template.config.json` values.
- Customer-authored files under retained labs.
- Customer screenshots/assets under retained labs.
- `tools\screenshot-capture\.auth\**`.
- Hand-edited `tools\screenshot-capture\shots.json` unless the test explicitly simulates resolving upstream manifest changes.
- `.env`, `.env.local`, ignored browser/auth state, and private content.
- Git remotes/branches in the source repo; only mutate the disposable clone.

#### Must-survive-second-run

- Applying the same setup/resync operation twice is a no-op.
- No conflict markers remain: `<<<<<<<`, `=======`, `>>>>>>>`.
- No duplicate package scripts, README entries, shot IDs, or lab sections.
- Existing excluded labs remain absent without failing.

### Tier 3 public forks checklist

Tier 3 is read-only remote interaction. The local clone can be mutated and deleted; the remote must never be touched.

#### Must-change

- In local clone only, setup/resync produces expected template-owned updates for the repo's apparent state.
- If the repo is still default/unmodified, behavior matches Tier 1 baseline.
- If the repo is customized, only template-owned default placeholders should change.

#### Must-NOT-change

- No `git push`, no `gh pr create`, no issues, no comments, no branches on remote.
- No report should copy customer content; record only repo slug, scenario class, changed path categories, and pass/fail counts.
- Local clone cleanup removes all public-repo workspaces after result emission.
- Do not commit generated screenshots or auth/browser state.

#### Must-survive-second-run

- Same as Tier 2: second local setup/resync run must produce no additional diff beyond allowed expected changes.
- Public forks with missing config or incompatible old structure should fail safely and be triaged, not forced.

## Tier 2 — Our repos / known customer instances

Russ should fill or approve the final manifest before any run involving private customer repositories.

| Slot | Repo / instance | Why include | Status |
|---|---|---|---|
| K01 | `russrimm/CopilotStudioLabs` | Canonical source; validates clean default template and self-resync behavior. | Ready |
| K02 | `raju-metgiri/CopilotStudioLabs` or another known public demo fork Russ approves | External-shaped fork with likely drift; safe if public and read-only. | Placeholder; verify accessibility |
| K03 | `<RUSS_FILL_IN: recent customer/demo CopilotStudioLabs fork>` | Recently created fork; catches onboarding/default assumptions. | Placeholder |
| K04 | `<RUSS_FILL_IN: older customer/demo fork at least one month behind>` | Resync/upgrade drift coverage. | Placeholder |
| K05 | `<RUSS_FILL_IN: heavily customized industry fork>` | Custom notes, custom screenshots, and changed branding coverage. | Placeholder |

For the under-10-minute gate, pick 2-3 of K01-K05 per run. Keep private repo logs content-scrubbed.

## Tier 3 — Public forks discovery queries

Use GitHub code search and repository search. The template is newer than Squad's, so the fork/install pool may be small or zero. If fewer than 16 targets are found, run all discovered targets and fill remaining public shards with additional synthetic variants.

Exact GitHub code search queries to try:

```text
path:template.config.json "Delivering energy with purpose"
```

```text
filename:template.config.json "sdge-energy-ops-agent"
```

```text
filename:template.config.json "Contoso Energy" "IT Operations Agent"
```

```text
filename:setup.js "Copilot Studio Labs — Template Setup Script"
```

```text
filename:package.json "copilot-studio-labs" "setup:dry-run"
```

```text
path:tools/screenshot-capture filename:shots.json "04-energy-census-advanced-agent"
```

```text
filename:README.md "01-energy-ops-agent" "05-copilot-studio-vscode-agent-management"
```

```text
"Delivering energy with purpose — powered by AI" "template.config.json"
```

```text
"A large multi-subsidiary energy company delivering energy with purpose" filename:template.config.json
```

Repository search fallback:

```text
CopilotStudioLabs in:name,description,readme
```

Selection rules:

1. Prefer forks/installs with recent commits and visible customization.
2. Prefer diversity: default forks, customized orgs, missing labs, edited screenshots, older commits.
3. Exclude archived repos unless testing legacy behavior deliberately.
4. Stop at 16 public repos per run.
5. Never push or open PRs/issues/comments.

## Fan-out execution script pseudo-spec

### Agent layout

Target: **9 parallel agents**, wall-clock under 10 minutes.

| Agent | Workload | Target count |
|---|---|---:|
| A1 | Synthetic baseline/idempotency | S01-S03 |
| A2 | Synthetic lab exclusion/custom content | S04-S07 |
| A3 | Synthetic encoding/config failures | S08-S14 |
| A4 | Synthetic screenshot/empty-labs/read-only variants | S10, S15-S16 plus OS-specific permission pass |
| A5 | Known repos | 2-3 approved repos |
| A6 | Public forks shard 1 | up to 4 repos |
| A7 | Public forks shard 2 | up to 4 repos |
| A8 | Public forks shard 3 | up to 4 repos |
| A9 | Public forks shard 4 | up to 4 repos |

If public pool is zero, reassign A6-A9 to duplicate Tier 1 with randomized configs and old-fork simulations.

### Per-agent workflow

1. Create a sandbox under a project-controlled folder such as `.squad\work\upgrade-tests\<run-id>\<agent-id>\<case-id>\`. Do not use `/tmp`.
2. For synthetic cases, copy the repo excluding `.git`, `node_modules`, and previous `.squad\work` outputs, or clone a local mirror.
3. For known/public repos, shallow clone read-only:
   ```powershell
   git clone --depth 1 https://github.com/<owner>/<repo>.git .\target
   ```
4. Record metadata:
   - repo slug or synthetic scenario ID
   - commit SHA: `git rev-parse HEAD`
   - node version: `node --version`
   - platform: `$PSVersionTable.OS` or `process.platform`
5. Capture before snapshot:
   ```powershell
   git status --porcelain=v1 -uall
   node .\verify-upgrade.js snapshot --root . --out .\.upgrade-test\before.hashes.json
   ```
6. Mutate starting state for the scenario, if synthetic:
   - edit `template.config.json`
   - add custom files
   - delete lab dirs
   - set read-only permissions
7. Capture pre-action snapshot after scenario setup:
   ```powershell
   git status --porcelain=v1 -uall > .\.upgrade-test\pre-action.status.txt
   node .\verify-upgrade.js snapshot --root . --out .\.upgrade-test\pre-action.hashes.json
   ```
8. Run candidate action with timeout:
   ```powershell
   # Real run
   "y" | node setup.js *> .\.upgrade-test\run1.log

   # Or dry-run
   node setup.js --dry-run *> .\.upgrade-test\run1.log
   ```
9. Capture after-first-run snapshot:
   ```powershell
   git status --porcelain=v1 -uall > .\.upgrade-test\after1.status.txt
   node .\verify-upgrade.js snapshot --root . --out .\.upgrade-test\after1.hashes.json
   ```
10. Verify must-change and must-NOT-change rules for that case.
11. Run the same action a second time:
   ```powershell
   "y" | node setup.js *> .\.upgrade-test\run2.log
   ```
12. Capture after-second-run snapshot and verify idempotency:
   ```powershell
   git status --porcelain=v1 -uall > .\.upgrade-test\after2.status.txt
   node .\verify-upgrade.js snapshot --root . --out .\.upgrade-test\after2.hashes.json
   ```
13. Emit one JSON result per scenario:
   ```json
   {
     "scenario": "S08-unicode-org",
     "target": "synthetic",
     "commit": "<sha>",
     "checksPassed": 14,
     "checksFailed": 0,
     "classification": "green",
     "failures": [],
     "changedPaths": ["README.md", "labs\\01-energy-ops-agent\\index.md"],
     "durationSeconds": 18
   }
   ```
14. Cleanup:
   - reset read-only bits before deletion:
     ```powershell
     Get-ChildItem -Recurse -Force . | ForEach-Object { try { $_.IsReadOnly = $false } catch {} }
     ```
   - delete sandbox only under `.squad\work\upgrade-tests\<run-id>`.
   - never delete outside the run root.

### Snapshot manifest rules

Hash every regular file except volatile or heavy/generated locations:

- Exclude `.git\**`
- Exclude `node_modules\**`
- Exclude `.squad\work\**`
- Exclude `.upgrade-test\**`
- Exclude `tools\screenshot-capture\.auth\**` from content logs, but record existence and file count.
- Optional: hash PNGs by default; for privacy-safe reports, record only path and hash, never content.

Manifest entry format:

```json
{
  "path": "labs\\01-energy-ops-agent\\index.md",
  "sha256": "...",
  "bytes": 12345,
  "readonly": false
}
```

## Pass criteria and bug triage rubric

### Release gate math

Mirror the blog's framing. Example target:

- 24 targets total:
  - 16 synthetic shards/check groups
  - 3 known repos
  - 5 public forks if available, or more synthetic fillers
- 245 assertions total.
- Pass target: **244/245 or better = 99.6%+**, provided no ship-blocker exists.

A run can be green with one accepted 🟡 follow-up, but never with a 🔴 ship-blocker.

### 🔴 Ship-blocker

Stop ship / fix before release when any of these occur:

- Data loss in user-owned paths without explicit destructive opt-in:
  - custom lab `labs\06-my-lab\` deleted
  - custom notes/screenshots under retained labs deleted
  - `tools\screenshot-capture\shots.json` overwritten unexpectedly
- `--dry-run` changes any file.
- Missing/corrupt config causes partial writes before failing.
- Same-command second run produces new diffs in template-owned files.
- README/lab navigation points to deleted labs after a successful run.
- Unicode or special characters corrupt file encoding.
- Any remote write is attempted against a public/known repo.
- Secrets or private content are printed into aggregate reports.
- Conflict markers remain after a workflow reports success.

### 🟡 Follow-up

Track, but not necessarily ship-blocking if documented and low blast-radius:

- User-authored markdown containing a default token is replaced, if current documented contract says all lab markdown is template-owned.
- Config A → config B does not rewrite prior A values, if no upgrade-state feature is promised yet.
- README whitespace normalization changes are harmless and idempotent.
- Empty `labs.include` behavior is surprising but explicitly documented.
- Public fork has missing legacy structure and fails safely with no file changes.
- Screenshot `npm run list` has cosmetic output differences but no file changes.

### 🟢 Expected / acceptable

- Excluded official labs are deleted when destructive exclusion remains the documented behavior.
- Default config fresh run makes no changes.
- Second run reports 0 replacements.
- Dry-run logs planned changes but leaves hashes unchanged.
- Public fork pool is small or zero; synthetic fillers are used.
- Read-only scenario fails before writing, with clear non-zero exit and preserved snapshot.

## Reusable verification helper pseudocode

Agents can drop either helper into a sandbox. Prefer JavaScript for cross-platform hashing; PowerShell wrapper is fine for orchestration.

### `verify-upgrade.js` pseudocode

```javascript
#!/usr/bin/env node
import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { join, relative } from "path";
import { spawnSync } from "child_process";

const args = process.argv.slice(2);
const cmd = args[0];
const root = valueAfter("--root") || process.cwd();
const out = valueAfter("--out");

const EXCLUDES = [
  `${sep()}.git${sep()}`,
  `${sep()}node_modules${sep()}`,
  `${sep()}.squad${sep()}work${sep()}`,
  `${sep()}.upgrade-test${sep()}`,
  `${sep()}tools${sep()}screenshot-capture${sep()}.auth${sep()}`
];

function valueAfter(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

function sep() { return process.platform === "win32" ? "\\" : "/"; }
function norm(p) { return p.split("/").join(sep()).split("\\").join(sep()); }

function shouldSkip(abs) {
  const p = sep() + relative(root, abs).split("/").join(sep());
  return EXCLUDES.some(x => p.includes(x));
}

function walk(dir, rows = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (shouldSkip(abs)) continue;
    if (entry.isDirectory()) walk(abs, rows);
    else if (entry.isFile()) {
      const buf = readFileSync(abs);
      const st = statSync(abs);
      rows.push({
        path: relative(root, abs).split("/").join("\\"),
        sha256: createHash("sha256").update(buf).digest("hex"),
        bytes: st.size,
        readonly: !(st.mode & 0o200)
      });
    }
  }
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}

function gitStatus() {
  const r = spawnSync("git", ["status", "--porcelain=v1", "-uall"], { cwd: root, encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function assertExists(path) {
  if (!existsSync(join(root, path))) throw new Error(`Expected path to exist: ${path}`);
}

function assertNotExists(path) {
  if (existsSync(join(root, path))) throw new Error(`Expected path to be absent: ${path}`);
}

function assertFileContains(path, text) {
  const body = readFileSync(join(root, path), "utf8");
  if (!body.includes(text)) throw new Error(`Expected ${path} to contain ${text}`);
}

function assertFileNotContains(path, text) {
  const body = readFileSync(join(root, path), "utf8");
  if (body.includes(text)) throw new Error(`Expected ${path} not to contain ${text}`);
}

function loadManifest(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function compareManifests(aPath, bPath, allowedChangedPaths = []) {
  const allowed = new Set(allowedChangedPaths.map(norm));
  const a = new Map(loadManifest(aPath).map(x => [norm(x.path), x]));
  const b = new Map(loadManifest(bPath).map(x => [norm(x.path), x]));
  const failures = [];
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const left = a.get(key);
    const right = b.get(key);
    const changed = !left || !right || left.sha256 !== right.sha256 || left.bytes !== right.bytes;
    if (changed && !allowed.has(key)) failures.push(key);
  }
  return failures;
}

if (cmd === "snapshot") {
  const rows = walk(root);
  if (out) writeFileSync(out, JSON.stringify(rows, null, 2));
  else console.log(JSON.stringify(rows, null, 2));
} else if (cmd === "status") {
  console.log(JSON.stringify(gitStatus(), null, 2));
} else {
  console.error("Usage: node verify-upgrade.js snapshot --root . --out .\\.upgrade-test\\before.hashes.json");
  process.exit(2);
}
```

### `verify-upgrade.ps1` orchestration pseudocode

```powershell
param(
  [Parameter(Mandatory=$true)][string]$Root,
  [Parameter(Mandatory=$true)][string]$Scenario,
  [string]$Action = '"y" | node setup.js',
  [string[]]$AllowedSecondRunChanges = @()
)

$ErrorActionPreference = "Stop"
$testDir = Join-Path $Root ".upgrade-test"
New-Item -ItemType Directory -Force -Path $testDir | Out-Null

function Snapshot($Name) {
  git -C $Root status --porcelain=v1 -uall | Set-Content -Encoding UTF8 (Join-Path $testDir "$Name.status.txt")
  node (Join-Path $Root "verify-upgrade.js") snapshot --root $Root --out (Join-Path $testDir "$Name.hashes.json")
}

function Run-Action($Name) {
  Push-Location $Root
  try {
    powershell -NoProfile -Command $Action *> (Join-Path $testDir "$Name.log")
    $code = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  return $code
}

Snapshot "before"
$code1 = Run-Action "run1"
Snapshot "after1"
$code2 = Run-Action "run2"
Snapshot "after2"

# Scenario-specific assertions would be invoked here:
# - Assert paths exist / do not exist
# - Compare after1.hashes.json to after2.hashes.json
# - Verify dry-run before == after1
# - Verify no conflict markers
# - Verify no remote writes occurred

$result = [ordered]@{
  scenario = $Scenario
  root = $Root
  firstExitCode = $code1
  secondExitCode = $code2
  statusAfterSecond = Get-Content (Join-Path $testDir "after2.status.txt") -Raw
}
$result | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 (Join-Path $testDir "result.json")
```

## Copy-paste run manifest skeleton

```json
{
  "runId": "upgrade-YYYYMMDD-HHMM",
  "maxWallClockMinutes": 10,
  "agents": 9,
  "publicRemotePolicy": "read-only; no pushes; no issues; no PRs",
  "tiers": {
    "tier1Synthetic": ["S01", "S02", "S03", "S04", "S05", "S06", "S07", "S08", "S09", "S10", "S11", "S12", "S13", "S14", "S15", "S16"],
    "tier2KnownRepos": ["russrimm/CopilotStudioLabs", "<RUSS_FILL_IN>", "<RUSS_FILL_IN>"],
    "tier3PublicForks": "discover via listed GitHub code search queries; cap 16"
  },
  "success": {
    "minimumPassRate": 0.996,
    "shipBlockersAllowed": 0,
    "remoteWritesAllowed": 0
  }
}
```

## Notes for future implementation

The current `setup.js` behavior is intentionally captured, including likely product risks: destructive lab deletion, broad markdown replacement, no prior-config state, and README cleanup derived from on-disk labs. The test plan should initially distinguish **current observed behavior** from **desired upgrade-safe behavior** so the team can decide whether to harden implementation or document limitations.
