# Upgrade / Re-setup Test Plan Architecture

Owner: Ripley  
Requested by: Russ Rimmerman  
Date: 2026-06-13

## Executive framing

CopilotStudioLabs does not have a formal `upgrade` command today. For test architecture, we treat the repo's upgrade surface as three related contracts:

1. **`setup.js` re-run** after a user has customized a fork.
2. **`tools/screenshot-capture/` refresh / re-run** after lab screenshots, manifest, or tool code changes.
3. **Template pull / fork resync** where a fork pulls upstream template changes and then re-runs setup or screenshot maintenance.

The upgrade contract is: **make template-owned content current without damaging user-owned state**. Unit tests are necessary, but they are not enough. We will adapt the blog's 3-tier model: synthetic scenarios, our known repos, and public/forked repos discovered via GitHub code search. The target benchmark mirrors the blog: about **23 targets, ~245 checks, 99.6%+ pass rate, and ~5 minutes wall-clock** with fan-out agents.

## 1. The Contract

### A. `setup.js` contract

Current behavior: `npm run setup` reads `template.config.json`, builds replacement pairs from default values, removes excluded lab directories, updates Markdown under `labs/`, and edits the README lab list.

#### MUST change

When setup is run against a fork with a valid config:

- Template default values in template-owned lab Markdown and README must be replaced with configured values:
  - `Contoso Energy` → `organization.name`
  - `Contoso Energy` → `organization.fullName`
  - `Contoso` → `organization.parent`
  - `Energy / Utilities` → `organization.industry`
  - default tagline → `branding.tagline`
  - `IT Operations Agent` → `scenario.agentName`
  - `field technicians` → `scenario.endUsers`
  - `NERC CIP` → `knowledgeSources.complianceStandard`
- README lab index/table must reflect only included labs.
- Labs omitted from `labs.include` must be absent from the rendered lab set and README navigation.
- Dry-run must print the intended changes and leave the working tree unchanged.
- Console output must clearly show config path, org, industry, agent, included labs, excluded labs, and next steps.

#### MUST NOT change

Setup must preserve user-owned state:

- `template.config.json` and any alternate config passed with `--config`.
- `.git`, `.github`, `.squad`, `portal`, `scripts`, and other non-lab project areas unless explicitly template-owned by the setup contract.
- User-created files in lab directories, especially notes, customer-specific screenshots, exports, PDFs, markdown addenda, and troubleshooting artifacts.
- User-edited content that is not a template placeholder/default token.
- Existing screenshots/assets unless a future setup option explicitly owns them.
- Labs the user deliberately deleted must not be silently resurrected by setup alone.
- Excluding a lab must not delete customer-owned files without either prior snapshot proof or a safer quarantine/delete policy.
- Privacy-sensitive strings in customer customizations must not be emitted in logs beyond file paths and counts.

#### MUST survive a second run / idempotency

After setup has already succeeded once:

- Re-running with the same config must produce no material file diff.
- README must not accumulate duplicate rows, broken table spacing, or excess blank lines.
- Excluded labs must remain absent without errors.
- Replacement output must not double-transform already-customized values.
- Custom files in retained labs must remain untouched.
- Exit code must be 0 for a valid config, including partial setups from older forks.

### B. `tools/screenshot-capture/` contract

Current behavior: `npm run capture` launches Chromium, uses `shots.json`, saves missing PNGs into `labs/04-energy-census-advanced-agent/assets`, and stores auth state in `.auth`. `npm run list` is read-only.

#### MUST change

On a tool refresh or intentional capture run:

- `npm install` must restore dependencies from the screenshot tool's own `package.json` / lock file.
- `npm run list` must report manifest entries and existing/missing screenshot status accurately.
- `npm run capture` must create only missing screenshots selected by `shots.json`.
- `node capture.js --only=...`, `--range=...`, and `--all` must affect only the selected manifest entries.
- New upstream manifest entries must result in new expected PNG targets under the configured `assetsDir`.
- Capture should create the configured assets directory if it is missing.

#### MUST NOT change

The screenshot tool must preserve:

- Existing PNGs unless `--all` or an explicit selected recapture asks to overwrite them.
- `tools/screenshot-capture/.auth/` across tool updates and normal runs.
- User-customized `shots.json` unless the user intentionally pulls upstream manifest changes and resolves conflicts.
- Screenshots outside the manifest's `assetsDir`.
- Lab Markdown and README content.
- Browser session state at the end of a capture run; the tool intentionally leaves Chromium open.
- Secrets/API keys in screenshots: tests must verify guidance and scanning workflow, not commit generated sensitive images.

#### MUST survive a second run / idempotency

- `npm run list` must be side-effect free.
- `npm run capture` with all manifest PNGs already present must exit with "Nothing to capture" and no diff.
- Re-running `--only` or `--range` without `--all` must skip already-present files.
- `.auth` must remain usable and untracked.
- Manifest ordering and shot IDs must remain stable across runs.

### C. Template-pull / fork-resync contract

Current reality: users fork this template, make changes, then may pull upstream changes manually. There is no first-class resync command yet, so tests model this as `git fetch upstream` + merge/rebase/cherry-pick + setup/screenshot validation.

#### MUST change

When a fork pulls template updates:

- Template-owned files should advance to upstream versions where there is no local customization conflict:
  - `setup.js`
  - `template.config.schema.json`
  - root `package.json` setup scripts
  - lab starter Markdown where unmodified by the user
  - screenshot capture tool code, README, package files, and manifest where unmodified
- New labs or new template-owned assets should appear only if allowed by the fork's lab inclusion policy.
- New setup capabilities must be available without requiring the user to recreate the fork.
- Documentation changes should merge without damaging customer-specific README sections.

#### MUST NOT change

Fork resync must preserve:

- Customer `template.config.json` values.
- Customer-authored lab changes, notes, screenshots, generated exports, and added files.
- Intentional lab deletions/exclusions.
- Git history, remotes, branches, and local untracked work in the test clone.
- `.auth`, `.env`, local browser profiles, and ignored files.
- Any customer branding or industry-specific wording that no longer matches template defaults.

#### MUST survive a second run / idempotency

- Applying the same upstream ref twice must be a no-op after the first successful merge.
- Re-running setup after resync must produce no additional diff beyond expected template update application.
- Conflict markers must never remain in files after the test workflow marks success.
- Dedup rules must prevent repeated README rows, gitignore entries, package scripts, or manifest entries.

## 2. Three-tier adaptation

### Tier 1 — Synthetic scenarios

Purpose: deterministic coverage of expected and edge cases before touching real repos. These should run in throwaway working directories under the repo workspace or agent-controlled scratch area, never in the live checkout.

Minimum scenarios:

1. **Clean default template** — default `template.config.json`, dry-run and real run; assert minimal/no replacements and README/lab list stability.
2. **Full custom config** — all replacement fields changed; assert every default token is replaced in template-owned Markdown and no config mutation occurs.
3. **Unicode and punctuation** — org names with emoji, accents, ampersands, apostrophes, en/em dashes, non-Latin characters, and regex-like punctuation.
4. **Partial customization** — only one or two config values changed; assert untouched defaults remain unchanged and no undefined/blank replacement occurs.
5. **Deleted/excluded labs** — config includes only labs 01 and 05; assert labs 02-04 and README references are removed without broken links.
6. **Custom files in lab dirs** — add customer notes, screenshots, exports, and Markdown addenda; assert retained labs preserve them and excluded lab deletion behavior is flagged if destructive.
7. **Already customized fork** — run setup once, commit snapshot, re-run; assert zero diff.
8. **Legacy/partial state** — missing README, missing labs directory, missing individual lab `index.md`, stale config schema, older package scripts.
9. **Malformed config** — invalid JSON, missing `organization`, empty `labs.include`, unknown lab names; assert friendly errors or safe no-op behavior.
10. **Screenshot manifest state** — all PNGs missing, all present, subset present, custom `assetsDir`, duplicate shot IDs, missing filename, custom `.auth` directory.
11. **Read-only / locked files** — simulate permission errors where feasible on Windows; assert friendly failure without partial corruption.
12. **Privacy scrub guardrail** — screenshots and Markdown containing fake API keys/emails; assert test harness detects potential leaks before declaring pass.

### Tier 2 — Our repos

Purpose: real-but-familiar repos where the team can interpret expected drift quickly. Use a manifest of approved targets and shallow clones.

Initial target set:

1. **`russrimm/CopilotStudioLabs`** — canonical template source. Test clean setup, dry-run, and template self-resync.
2. **`raju-metgiri/CopilotStudioLabs`** — public CopilotStudioLabs instance found by repository search; use as a familiar external-shaped fork if still accessible.
3. **Team-maintained customer/demo fork(s)** — any private or internal delivery repos Russ designates as safe for read-only clone testing, ideally:
   - one recently created fork,
   - one fork at least one month behind upstream,
   - one heavily customized customer/industry fork.

If private customer repos are used, the target manifest must record only repository slug, upstream ref, and expected scenario class; no customer secrets or copied content should be written into reports.

### Tier 3 — Real forks / public installs

Purpose: discover states the team did not imagine. Read-only GitHub interaction only: search, shallow clone, local test, delete clone.

Recommended GitHub code search queries:

```text
filename:template.config.json "Copilot Studio Labs" "Contoso Energy"
filename:template.config.json "Contoso Energy" "IT Operations Agent"
filename:setup.js "Copilot Studio Labs — Template Setup Script"
filename:package.json "copilot-studio-labs" "npm run setup"
path:tools/screenshot-capture filename:shots.json "04-energy-census-advanced-agent"
filename:README.md "01-energy-ops-agent" "05-copilot-studio-vscode-agent-management"
"Delivering energy with purpose — powered by AI" "template.config.json"
```

Selection rules:

- Prefer forks/installs with recent activity, visible local customization, and different degrees of drift.
- Exclude archived repos unless specifically testing legacy behavior.
- Cap public tier at 16 repos per run, like the blog's 4 agents x 4 repos pattern.
- Never push, open PRs, comment, or mutate remote state.
- Do not record private content in logs; summarize by check result and file category.

## 3. Fan-out blueprint

Use **9 parallel agents**, matching the blog's proven shape and keeping wall-clock near **5 minutes** once tooling exists.

| Agent | Scope | Targets | Primary checks |
|---|---:|---:|---|
| A1 | Synthetic setup baseline | 3 scenarios | default, full custom, dry-run |
| A2 | Synthetic edge configs | 3 scenarios | unicode, partial config, malformed config |
| A3 | Synthetic fork drift | 3 scenarios | deleted labs, custom files, legacy partial state |
| A4 | Synthetic screenshot tool | 3 scenarios | list, missing/present PNGs, `.auth`, manifest quirks |
| A5 | Our repos | 3 repos | clone, setup/resync, snapshot before/after, idempotency |
| A6 | Public repos shard 1 | 4 repos | setup/resync contract |
| A7 | Public repos shard 2 | 4 repos | setup/resync contract |
| A8 | Public repos shard 3 | 4 repos | screenshot/tool and setup contract |
| A9 | Public repos shard 4 | 4 repos | high-drift/legacy contract |

Each agent workflow:

1. Shallow clone or copy target into an isolated workspace under the project-controlled test area.
2. Capture before snapshot: file tree, hashes, selected semantic probes, git status, config summary.
3. Apply the candidate upgrade surface: setup re-run, screenshot tool refresh, or upstream template merge simulation.
4. Capture console output and after snapshot.
5. Verify MUST-change, MUST-NOT-change, and privacy rules.
6. Run the same action a second time.
7. Verify idempotency: expected zero diff or explicitly allowed diff only.
8. Emit structured result: target, scenario class, checks passed/failed, changed file categories, suspected bug, logs path.
9. Cleanup local clone/workspace.

Expected scale for a release gate:

- 12 synthetic scenarios.
- 3 our-repo targets.
- 16 public/fork targets.
- ~200-300 assertions total.
- Target wall-clock: **5 minutes** with 9 agents; fail fast on destructive-change findings.

## 4. Risk register

Ranked by blast radius:

1. **Excluded lab deletion removes customer-owned content.** `setup.js` currently deletes excluded lab directories recursively. If a customer put custom notes/screenshots/exports under an excluded lab, data is lost in the working tree.
2. **Global Markdown replacement corrupts user-authored content.** Replacing default strings across all Markdown can modify customer notes, quoted examples, changelogs, or intentionally preserved references.
3. **Template pull overwrites customized lab/README/config state.** Manual merges can blur template-owned vs user-owned files and create conflicts that users resolve incorrectly.
4. **Screenshot recapture overwrites important evidence or leaks secrets.** `--all` intentionally overwrites PNGs; screenshots can include API keys, tenant details, or customer data if guardrails are weak.
5. **Non-idempotent README/lab mutations create cumulative drift.** Duplicate rows, broken links, extra blank lines, stale lab references, or repeated package/script entries erode trust and are hard to diagnose after several pulls.

## 5. Success criteria / ship-readiness

A setup/resync release is ship-ready when:

- Overall contract pass rate is **>= 99.6%**, matching the blog's benchmark, across synthetic + our repos + public repos.
- **0 P0/P1 bugs**: no destructive user-state changes, no secret exposure, no remote mutation, no unhandled crash on normal fork states.
- **100% idempotency pass** for valid targets: second run produces no unexpected diff.
- **100% MUST-NOT-change pass** for user-owned files in retained labs, config files, auth/session directories, and custom additions.
- Public tier includes at least **16 real repos/forks** or every discoverable public install if fewer than 16 exist.
- Every failure is classified before ship: product bug, test bug, unsupported state, or expected conflict.
- Ship can proceed with at most one low-severity messaging/diagnostic issue, provided the remediation is tracked and the contract remains intact.

## Architectural decisions

- Treat `setup.js` re-run as the primary upgrade contract until a formal upgrade command exists.
- Treat template pull/fork resync as a first-class test surface even before it has first-class tooling.
- Treat user customizations as more important than template freshness; preservation failures outrank missed template updates.
- Use real public repos only through read-only shallow clones and local cleanup.
- Measure success by contract preservation, not just command exit code or test count.
