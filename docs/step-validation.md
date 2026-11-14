# Step-level lab validation

The portal's structural validation (`portal/lib/validator.js`, `validate_labs.py`) checks headings, the metadata table, links, and screenshot files. It cannot tell you whether a lab's instructions are still **accurate**: that the menu still exists, the button is still called that, the feature is still in preview.

Step validation closes that gap. It reads each lab's step-by-step instructions, extracts the claims in every step, and checks each claim against current [Microsoft Learn](https://learn.microsoft.com) content through the Learn MCP server.

This is **phase 1 (documentation check)**. Phase 2 (running the steps in Copilot Studio with browser automation) is designed for but not implemented. See [Phase 2](#phase-2-live-execution-not-implemented).

## What it reports

For each lab, each step, and each claim:

| Status | Meaning |
|---|---|
| **Verified** | A documented rule found supporting text in Learn. The Learn URL and the matching excerpt are attached. |
| **Unverified** | The Learn lookups worked, but no supporting text was found. This is not proof the step is wrong: the doc may word it differently, or the UI may be newer than the docs. |
| **Likely stale** | A named rule found Learn text that contradicts the lab (renamed, deprecated, different availability stage, different limit). Citation and excerpt attached. |
| **Unable to verify** | A Learn lookup failed (outage, timeout, budget exhausted, circuit breaker open). This is never reported as a pass. |
| **Nothing to check / No steps found** | The step has no checkable claims, or the lab has no recognizable step structure (for example, it links to a separate guide). Also never a pass. |

A step's status is the worst of its claims (stale > unable > unverified > verified). Low-confidence claims, such as a bold word with no UI context, are still reported, but they cannot turn an otherwise verified step into an unverified one on their own.

## How it works

No LLM decides pass or fail. Extraction and matching are deterministic and every verdict names the rule that produced it.

1. **Parse steps** (`portal/lib/step-validator/steps.js`). Labs are written in several shapes, so the parser tries them from most to least specific and records which one matched (`stepSource`): `### Step N` / `### Task N` / `### Exercise N` / `### Part N` / `### Section N: ...` / `### Module N: ...` headings (`step-headings` / section headings), numbered headings (`### 1.1 ...`, `numbered-headings`), `## Use Case #N` headings (`use-cases`), and `**1. Title**` prose steps (`bold-numbered`). Non-instructional top-level sections and sub-sections (`Summary`, `Appendix`, `Cleanup` / `Lab Complete`, `Troubleshooting`, `Sample Prompts`, `Expected Results`, `Validation Checklist`, `Next Steps`, `Related Labs`, `Further Reading`, `References`, plus code fences and expandable harness-difference notes) are excluded automatically. `## Prerequisites`, the lab title (for a `(Preview)` or `(GA)` marker), and `## Overview` (when instructional or overview claims are present before or without explicit step claims) are checked as extra sections rather than numbered step units.
2. **Extract claims** (`claims.js`). Only text Microsoft Learn can confirm or contradict becomes a claim:

   | Kind | Example in a lab | Confidence |
   |---|---|---|
   | `nav-path` | Go to **Settings → Generative AI** | high |
   | `setting` | Set **Content moderation** to **High** | high |
   | `ui-label` | Select **+ Add a tool** | high (bold or quoted text after a UI verb, or before a UI noun such as "tab") |
   | `requirement` | requires a **Microsoft 365 Copilot** license | high |
   | `limit` | files up to 25 MB | high with a bold subject, otherwise low |
   | `availability` | "(Preview)" in a title, "is currently in preview" | high |
   | `term` | other bold feature names, or prose fallback tokens | low |

   When a section uses plain prose instead of bold UI labels, `extractProseItemClaims` extracts recognized Microsoft AI product and capability terms, non-generic Markdown link labels (`[Title](https://...)`), and official CLI/SDK/system code tokens (such as `` `@microsoft/...` ``, `` `@azure/...` ``, `` `pac ...` ``, `` `power.config.json` ``, `` `System.*` ``, and `` `User.*` ``). Text the learner types or names (`named **Operations Briefing Agent**`, `Enter ...`, anything in a code block, placeholders such as `<environment-id>`, and organization names such as Contoso) is never a claim. Skipped candidates are listed on each step with the reason, so extraction is auditable. At most 12 claims are kept per step, highest-value kinds first; `truncated` records how many were dropped.
3. **Gather evidence**, cheapest first, and only while claims remain unresolved: the Learn pages the lab itself cites (read once per lab), then one targeted Learn search for the step, then a second search on the still-unresolved terms, then the single most relevant hit fetched in full.
4. **Match** (`matcher.js`). Text is normalized (case, markdown, quotes, arrow styles, singular and plural). Contradicting text wins over supporting text.

   | Rule | Outcome | What it checks |
   |---|---|---|
   | `exact-phrase` | verified | The exact wording appears in Learn text |
   | `exact-phrase-bold` | verified | Single-word or very short names must appear in bold, as Learn formats UI labels, so "Save" cannot match ordinary prose |
   | `path-in-order` | verified | Every segment of a menu path appears in order in one passage |
   | `path-suffix-in-order` | verified | A path of three or more segments appears in order after its first segment, and the same page names that first segment |
   | `setting-and-value` | verified | The setting and its value appear together in one sentence |
   | `requirement-wording` | verified | The role, license, or product appears next to requirement wording |
   | `limit-match` | verified | A sentence on the same subject states the same number and unit |
   | `availability-match` | verified | Learn gives the same stage (preview or generally available) |
   | `renamed` | stale | Learn says the name was renamed, replaced, rebranded, or is "formerly" something else |
   | `deprecated` | stale | Learn says the item is deprecated, retired, removed, or no longer supported, near the name |
   | `availability-changed` | stale | Learn gives a different stage than the lab states |
   | `limit-mismatch` | stale | A sentence on the same subject states a different number for the same unit. Subjects are matched by shared keywords, so confirm it is the same limit |
   | `partial-support` | unverified | Related text exists but not enough to confirm the whole claim (for example, only some path segments) |
   | `mixed-evidence` | unverified | Learn text mixes preview and generally available wording; a person decides |
   | `no-support` | unverified | No supporting text found |
   | `lookup-failed` | unable | A Learn lookup failed, so the claim could not be fully checked |

   The staleness rules are heuristics over text. They explain themselves and cite their evidence, but a `stale` result means "a person should look", not "the lab is wrong".

## Running it

### Portal

In the **Validation** tab, **Run All Tests** runs the structural tests and then the step check. Each lab's **Run** button does the same for that lab, and **Check all steps** runs only the step check. A progress bar and status line show the current lab and step ("Lab 3 of 40 · section 2 of 6"), results stream in as each lab finishes, and **Cancel** stops the run while keeping completed labs. Pressing it while the run is still starting is remembered and applied as soon as the server has started the run, so a click is never silently dropped. The API is documented in [`portal/README.md`](../portal/README.md#validation).

The pre-flight check that gates export and provisioning stays structural-only, so exporting a lab never waits on network calls.

### CLI and CI

```bash
cd tools/lab-accuracy
npm run steps -- --lab=35                  # one lab by number or folder name
npm run steps                              # every lab
node check-steps.mjs --fail-on=unverified  # also fail on unverified claims
node check-steps.mjs --markdown            # also write out/step-accuracy.md
```

| Option | Purpose |
|---|---|
| `--lab=<id>` | Lab folder name or numeric prefix. Repeatable. Default: all labs |
| `--fail-on=stale\|unverified\|none` | What counts as a finding. Default: `stale` |
| `--allow-unavailable` | Do not fail when Learn could not be reached for some claims |
| `--markdown`, `--json` | Also write a Markdown report, or print the JSON report |
| `--out=<dir>` | Output directory (default `tools/lab-accuracy/out`) |
| `--cache-dir=<dir>`, `--no-cache` | Persistent Learn cache location (default `out/learn-cache`), or memory only |
| `--max-calls=<n>`, `--min-interval-ms=<n>` | Call budget and spacing |
| `--quiet` | Suppress per-step output |

The report is written to `out/step-accuracy.json`. Exit codes: `0` no findings and everything checkable; `1` likely-stale claims (or unverified ones with `--fail-on=unverified`); `2` Learn was unavailable for some claims; `3` usage or internal error.

The CLI is syntax-checked and unit tested in the pull request workflow. It is deliberately **not** a required gate: the monthly audit is the natural place to run it, for example as an extra step after `check-accuracy.mjs` using `node check-steps.mjs --markdown --allow-unavailable`, with `out/step-accuracy.md` attached to the tracking issue. A full run makes several hundred Learn calls, so persist `out/learn-cache` between runs if you add it to CI.

## Reliability and safety

- **Cache.** Learn responses are cached for 24 hours in memory and, when `STEP_VALIDATION_CACHE_DIR` (or `--cache-dir`) is set, on disk. Failures are never cached.
- **Rate limit.** One Learn call at a time, at least 250 ms apart (`STEP_VALIDATION_MIN_INTERVAL_MS`), with a per-run call budget (`STEP_VALIDATION_MAX_CALLS`, default 2,500). The transport (timeouts, retry on 429 and 5xx) is the existing Learn client in `portal/lib/lab-builder/learn-mcp.js`.
- **Graceful degradation.** After five consecutive failed searches, a circuit breaker ends further lookups for the run quickly instead of timing out on every claim. Claims that could not be checked are `unable`, the CLI exits `2`, and the portal shows them separately from passes.
- **One run at a time** in the portal, because the Learn MCP is a shared service. Starting a second run returns `409`.
- **Fetched docs are untrusted data.** Only `https://learn.microsoft.com` URLs are accepted. Results from other hosts are dropped. Text is capped, stripped of HTML and control characters, and used only as strings for matching and display. Nothing from Learn is executed, interpolated into a prompt, or followed as instructions. The portal renders it with escaping, and links are created only for Learn URLs.

## Limitations

- Learn does not describe every UI label, and its search returns short chunks. Many correct steps will be **unverified**; that means "no supporting doc found", not "wrong". Cited pages and a fetched page per step reduce this but cannot remove it.
- Matching is textual. It does not understand that "Policies > Data policies" and "Data policies under Policies" mean the same thing, and the staleness rules can misfire on similar wording about different features.
- Steps written purely as free prose with no recognizable UI labels, product terms, links, or CLI/SDK tokens, or kept only in an external document, have little or nothing to extract and report `no-steps` or `no-claims`. (All 40 labs in `labs/` parse steps and verifiable claims.)
- Instructions in tables and screenshots are only partly covered (table rows are read; image text is not).
- Learn describes the product as it is documented, which can lag or lead what a given tenant sees. Only live execution can settle that.

## Report model

```text
report { schemaVersion, generatedAt, methods: ["docs"], source, summary, labs[] }
lab    { labId, title, status, stepSource, citedPages[], notes[], steps[], counts, coverage }
step   { id, number, title, group, line, status, counts,
         checks: { docs: { status, claims[], skipped[], truncated, queries[], pagesFetched[] },
                   live: { status: "not-run" } } }
claim  { id, kind, term, confidence, line, context, status, rule, explanation,
         evidence: [{ url, title, excerpt }] }
```

## Phase 2: live execution (not implemented)

Phase 2 would run each step in a real Copilot Studio tenant with browser automation (Playwright) and record what actually happened. The report model already has the slot for it: every step carries `checks`, a map keyed by method. Phase 1 fills `checks.docs`; phase 2 would fill `checks.live` with the same status vocabulary (plus `skipped` for steps that cannot be automated) and its own evidence (a screenshot path, the locator that matched or failed, console and network errors). The step's top-level `status` is derived from whichever checks ran (`combineChecks` in `report.js`), so adding a method does not change any consumer.

What phase 2 would need:

1. **A dedicated test tenant and environment** with seed data, licenses, and a service identity. Never a production tenant.
2. **Authentication.** A stored Playwright auth state (`.auth/`, already ignored by the screenshot tooling) refreshed by an interactive sign-in, or a test user with conditional-access exemptions and MFA handled out of band.
3. **A step-to-action mapping.** Phase 1 already extracts the nav paths, button labels, settings, and values. Phase 2 would turn each claim into a locator (role and accessible name first), reusing `tools/screenshot-capture` and `shots.json` start URLs and selectors where they exist. Steps with no mappable action would be reported `skipped`, not passed.
4. **Safety rules.** An allowlist of environments, a destructive-action guard (delete, publish, send, deploy require an explicit per-step opt-in), unique name suffixes for created resources, and teardown of what a run creates.
5. **Resilience.** Copilot Studio is a fast-moving single-page app: waits on network idle and visible state, retries on transient failures, and failure classification that separates "the lab is wrong" from "the environment was not ready" so flaky infrastructure is reported as `unable`, not `stale`.
6. **Runtime budget.** Live runs are slow and billable, so they would be opt-in per lab or per step, run on a schedule rather than per pull request, and reuse the same job store, progress events, and UI.
