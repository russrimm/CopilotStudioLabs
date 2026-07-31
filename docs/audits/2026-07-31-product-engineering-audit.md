# CopilotStudioLabs Product and Engineering Audit

**Audit date:** July 31, 2026  
**Repository:** `russrimm/CopilotStudioLabs`  
**Branch:** `russrimm-audit-copilot-studio-labs`  
**Implementation commits:**

| Commit | Purpose |
|---|---|
| `d2a820d56b062af8bce118d4fa10ff1f3f4c7922` | Portal hardening, curriculum corrections, tooling, CI, dependencies, screenshots, and documentation |
| `b57f4962296c3e4a37c398aaf1ae7e9c4fa6a79d` | Learn-MCP drift correction, official-document follow-up, intentional orphan classification, and immutable GitHub Actions pins |

## Executive summary

This audit covered all 40 labs, the provisioning portal, PDF and screenshot tooling, lab-accuracy automation, repository setup, CI workflows, dependencies, accessibility, learner safety, and documentation maintainability.

The work prioritized:

1. Misleading or unsafe learner instructions.
2. Reproducible portal security and runtime defects.
3. Broken links, fake screenshots, and stale feature-status claims.
4. Cross-platform tooling failures.
5. Automated checks that could report false success.
6. Low-risk controls that prevent regressions.

The audit did not use tenant credentials, publish agents, deploy applications, or change Azure, Microsoft 365, Power Platform, or Copilot Studio resources.

## Scope and method

The repository was reviewed in four independent tracks:

- Labs 01-20.
- Labs 21-40.
- Portal product and engineering behavior.
- Repository tooling, CI, PDF generation, screenshot capture, dependencies, and root documentation.

Technical claims were checked against current Microsoft Learn content or current repository and package evidence. Changes were made only when the correction was high-confidence and low-risk. Tenant-dependent UI, preview behavior, and curriculum positioning that could not be verified without product-owner or tenant access were left as explicit follow-up recommendations.

## Implemented changes

### 1. Portal security and runtime hardening

#### Closed lab-ID path traversal

The portal previously accepted decoded values such as `../portal` in lab route parameters and export selections. A live request to `/api/validate/..%2Fportal` escaped the `labs` directory, and a malicious export selection could make the server archive unintended repository content.

Implemented controls:

- Added centralized lab-ID validation in `portal/lib/labs.js`.
- Restricted IDs to letters, digits, and hyphens.
- Resolved paths beneath the canonical `labs` root and rejected invalid paths.
- Reused the guarded path resolver from portal validation and export code.
- Validated export and email lab selections against the discovered lab inventory before creating an archive.
- Returned `400` for malformed IDs and `404` for valid but unknown labs.
- Applied the same validation to lab feedback routes.
- Added unit and live HTTP regression coverage.

#### Hardened approval notifications

- Escaped all request-controlled values before inserting them into approval email HTML.
- Added regression coverage for stored HTML and script payloads.
- Made `PORTAL_BASE_URL` take precedence when generating approval links.
- Documented that deployed approval workflows require an explicit public base URL.

#### Updated archive and upload dependencies

- Upgraded `archiver` to 8.x and migrated export code to `ZipArchive`.
- Upgraded `nodemailer` to 9.x.
- Updated `multer` to 2.2.
- Applied compatible transitive dependency fixes.
- Added a real ZIP-generation test so future archive API changes cannot pass unnoticed.
- Reduced the portal production dependency audit to zero known vulnerabilities at audit time.

#### Fixed container and static-asset behavior

- Set `HOST=0.0.0.0` in the portal container image and Compose configuration while preserving the loopback default for local bare-metal runs.
- Added explicit `404` handling for missing `/labs` and `/uploads` assets so the SPA fallback no longer masks missing files as `200 text/html`.
- Added `portal/.env.template` with non-secret placeholders and local-development warnings.
- Documented the production authentication limitation rather than recommending disabled authentication.

#### Improved portal accessibility and loading

- Added tablist, tab, and tabpanel semantics.
- Added `aria-selected`, `aria-controls`, `aria-labelledby`, and active-tab keyboard state.
- Added Arrow, Home, and End keyboard navigation.
- Added a `prefers-reduced-motion` fallback for the animated background.
- Deferred the large Mermaid and application scripts without changing initialization order.

#### Preserved explicit production-auth limitation

The browser client still does not acquire or attach Microsoft Entra bearer tokens. The documentation now states that an auth-enabled shared deployment requires either:

- MSAL Browser integration, or
- An authenticated BFF/reverse-proxy/session pattern such as an approved Easy Auth design.

The audit did not implement a speculative authentication architecture.

### 2. Curriculum accuracy, safety, and progression

| Lab | Changes |
|---|---|
| 01 | Replaced hard-coded model-version lists with environment, region, licensing, and release-aware guidance; linked current model-selection documentation; restored Lab 02 as the next fundamentals step. |
| 04 | Reconciled the solution name; replaced the fake tenant SharePoint URL with tenant/instructor guidance; corrected the uploaded guide description; clarified the scenario purpose; labeled the remote-access guide as synthetic; removed instructions that normalized password, OTP, MFA approval, recovery-code, or hardware-token disclosure. |
| 05 | Strengthened the Work IQ preview warning and prohibited unapproved production use. |
| 06 | Fixed a paste typo and duplicate city/state instructions; removed manually invented connector output paths; instructed learners to use the output picker; corrected current-weather field guidance; removed fake UI screenshots and replaced them with explicit screenshot-pending callouts. |
| 07 | Removed stale Agent Evaluation preview labeling; updated `Similarity` to `Text similarity` and `Capability use` to `Tool use`; retained manual review as a production quality gate; fixed the Copilot Studio What's New link. |
| 10 | Corrected the prerequisite to require a published agent and supported-channel conversations; clarified that test-pane activity does not appear in Analytics. |
| 11 | Rewrote the lab around the actual Custom Metrics preview: up to three natural-language transcript-based metrics, sampled evidence review, false-positive/negative checking, comparison with standard analytics, and explicit limitations. |
| 13 | Added the Microsoft 365 Copilot node/new workflow preview warning and corrected the official documentation URL. |
| 16 | Added the same preview and fallback boundary; changed the completion claim from enterprise-ready to a governed pilot pattern. |
| 17 | Added required agent-flow triggers, new-infrastructure prerequisites, and channel limitations for asynchronous callbacks. |
| 18 | Removed the claim that activity traces expose private chain-of-thought; limited the expectation to tool steps, parameters, and results. |
| 19 | Added Fabric Data Agent preview status; clarified A2A message endpoint versus agent-card URL; documented supported authentication categories without placing credentials in the lab. |
| 23 | Added China Cloud operated by 21Vianet to the Snowflake connector's unsupported Copilot Studio clouds in every affected section. |
| 25 | Added the current dedicated Copilot Studio Virtual Network guidance to the existing Power Platform and Azure network references. |
| 26 | Removed the dead Microsoft Shopify connector reference and the assumption that a certified connector exists; reframed the retail exercise around a governed Shopify Admin API custom connector or flow wrapper. |
| 28 | Replaced the invented executable hostname with an explicit approved nonproduction URL placeholder; front-loaded preview warnings for Cloud PC pools and standalone computer-use tools. |
| 30 | Updated model-specific real-time voice regional processing guidance and corrected the EU Data Boundary limitation. |
| 32 | Corrected the starter from Lab 18 to Lab 32; upgraded the unavailable Client SDK `^0.5.0` dependency to `^1.7.1`; migrated the changed SDK API; added a lockfile and default SVG avatar; fixed missing image requests, input labeling, avatar text alternatives, type safety, and raw client-error disclosure; updated the lab snippets to match the working sample. |
| 33 | Removed the recommendation to bypass PowerShell execution policy on managed devices; replaced a dead Code Apps link with the current official overview. |
| 34 | Made federated credentials the recommended manual Entra authentication pattern; retained client secrets only as an approved fallback; added the official authentication guide; removed fake screenshots. |
| 35 | Corrected the overbroad DLP connector-group statement; required validation in the scoped environment; removed fake screenshots. |
| 36 | Added current official VS Code extension overview and agent-cloning references. |
| 37 | Added the official agent usage estimator, its non-contractual disclaimer, and a required forecast variance buffer. |

### 3. Screenshot and asset integrity

- Removed 16 known placeholder PNGs from Lab 06.
- Removed three placeholder authentication images and the obsolete manifest from Lab 34.
- Removed three placeholder DLP images and the obsolete manifest from Lab 35.
- Replaced removed instructional images with explicit callouts instead of presenting placeholders as product UI.
- Reconciled the default Lab 06 screenshot manifest to the two real images still referenced by the lab.
- Enabled known-placeholder state checking in the monthly screenshot audit.
- Added strict manifest `lab`, `assetsDir`, and output-filename validation.
- Prevented screenshot manifests from writing outside their intended lab asset directory.
- Supported both repository-relative lab manifests and local generated-lab manifests.
- Added and committed deterministic screenshot-tool dependencies.

#### Intentional `issues-banner.png` retention

`labs/04-energy-ops-agent/assets/images/issues-banner.png` is not referenced by the current lab Markdown, but it was not deleted.

Evidence:

- Git history shows the file was deliberately added in commit `67e6316`.
- `.squad/files/upgrade-test-content-contract.md` explicitly identifies it as a preserved screenshot/image asset.

The verifier now classifies this exact path as an intentional orphan instead of repeatedly warning on it.

### 4. PDF and cross-platform tooling

- Fixed Linux/Codespaces image resolution in `tools/lab-pdf/generate.js`.
- Declared Playwright directly in the PDF tool instead of relying on a sibling tool's installation.
- Added a deterministic PDF-tool lockfile.
- Fixed the same forward-slash Markdown image handling in portal validation.
- Added a cross-platform regression test for Markdown image paths.
- Added explicit Chromium installation to the devcontainer setup.

### 5. Lab-accuracy automation

#### Prevented false monthly success

`build-issue.mjs` now sets `needs_action=true` when:

- The accuracy report is missing.
- The screenshot report is missing.
- The URL smoke report is missing.
- Learn MCP is unavailable.
- Screenshot verification is unavailable.

The Windows report output path now uses `fileURLToPath`, eliminating the malformed `C:\C:\...` path.

#### Corrected Learn-MCP drift detection

The initial corrected link run reported 23 drift warnings. Triage showed two automation defects:

1. The current Learn MCP response is wrapped as `{ "results": [...] }`, but the client treated that envelope as a single empty result.
2. The comparison treated localized `/en-us/` links as different pages from canonical Learn URLs.

Implemented:

- Unwrapped the current `results` response envelope while preserving compatibility with array responses.
- Normalized locale prefixes during Learn URL comparison.
- Added three regression tests.
- Updated the warning text to state that links still resolve and request a relevance review rather than implying deprecation.

Result:

- Broken external links: `0`.
- Drift warnings: reduced from `23` to `8`.

Remaining warning classification:

| Lab | Classification | Decision |
|---|---|---|
| 01 | Broad search query ranks connector pages above the cited model page | False-positive ranking signal; model link resolves; no edit |
| 04 | Broad custom-agent query ranks newer topical pages above valid foundation links | False-positive ranking signal; no speculative rewrite |
| 16 | Preview Microsoft 365 Copilot workflow page does not rank in generic agent-flow results | Preview-dependent; keep current cited page |
| 22 | Generic ServiceNow query favors Microsoft 365 and Security Copilot integrations over the valid connector reference | False-positive ranking signal |
| 23 | Generic Snowflake query favors Copilot Studio security pages over the valid Snowflake/VNet references | False-positive ranking signal |
| 26 | Multi-industry query cannot rank all intentionally cross-product references | False-positive ranking signal |
| 30 | Generic voice/telephony search does not rank every real-time voice page | Region/preview-dependent; retain current references |
| 32 | Search favors Microsoft 365 Agents SDK and custom canvas guidance over the current Client SDK sample | Product-owner architecture choice; no automatic migration |

### 6. CI and dependency maintenance

- Added `.github/workflows/validate-content.yml`.
- Added Dependabot coverage for the portal, lab accuracy, PDF, screenshot tool, Lab 32 sample, and GitHub Actions.
- Added deterministic lockfiles for previously unlocked Node tools.
- Added PR/main validation for:
  - All lab structures and README lab links.
  - Template setup dry run.
  - Offline lab-builder dry run.
  - Screenshot manifests and assets.
  - Portal installation, tests, and high-severity dependency audit.
  - Tool syntax.
  - Lab-accuracy parser tests.
- Hardened the documentation changelog workflow by moving PR-controlled file lists into environment variables and printing them as data rather than interpolating them into shell source.

#### Immutable GitHub Actions pins

Every workflow action reference was resolved through GitHub and pinned to the verified commit:

| Action | Verified ref | Immutable commit |
|---|---|---|
| `actions/checkout` | `v4` | `11d5960a326750d5838078e36cf38b85af677262` |
| `actions/setup-node` | `v4` | `49933ea5288caeca8642d1e84afbd3f7d6820020` |
| `actions/setup-python` | `v5` | `a26af69be951a213d495a4c3e4e4022e16d87065` |
| `actions/upload-artifact` | `v4` | `ea165f8d65b6e75b540449e92b4886f43607fa02` |
| `actions/github-script` | `v7` | `f28e40c7f34bde8b3046d885e986cb6290c5673b` |
| `marocchino/sticky-pull-request-comment` | `v2` branch | `773744901bac0e8cbb5a0dc842800d45e9b2b405` |

No mutable `@vN`, `@main`, or `@master` workflow references remain.

### 7. Template and repository maintainability

- Added `template.config.schema.json`.
- Added editor-visible validation for organization, branding, scenarios, knowledge sources, lab IDs, deployment values, and industry presets.
- Added runtime setup validation for:
  - Non-array `labs.include`.
  - Unknown lab IDs.
  - Duplicate lab IDs.
- Kept destructive setup changes behind the existing confirmation and dry-run behavior.
- Updated `validate_labs.py` from stale 01-35/duplicate-01 wording to the actual 40-lab inventory.
- Removed the stale root README backlog that labeled implemented labs as planned.
- Corrected README progression and the `35+` count to 40.
- Corrected Codespaces references from Lab 18 to Lab 32 for the Vite sample and repaired other stale lab-number mappings.
- Rewrote personalized audit prose in `docs/app-registration-setup.md` as durable operator guidance.
- Removed tracked Python bytecode and added Python cache patterns to `.gitignore`.

## Validation evidence

| Validation | Result |
|---|---|
| Lab structure | 40/40 labs pass |
| README lab links | 0 broken |
| Lab numbering | 0 collisions |
| External official/reference links | 0 broken |
| Learn-MCP drift | 23 initial warnings reduced to 8 classified relevance warnings |
| Screenshot verifier with state checks | 0 critical, 0 warnings |
| Screenshot freshness audit | 0 missing, 0 stale, 0 recapture required |
| Portal tests | 28/28 pass |
| Portal dependency audit | 0 vulnerabilities |
| Lab 32 sample build | TypeScript and Vite production build pass |
| Lab 32 dependency audit | 0 vulnerabilities |
| Tool dependency audits | 0 vulnerabilities |
| URL smoke test | 1/1 documented start URL reachable |
| PDF generation | 563.5 KB PDF generated; 3 images embedded; 0 missing |
| Template setup | Dry run pass |
| Lab builder | Offline deterministic dry run pass |
| Workflow YAML | All workflow files parse |
| Action pins | All six unique action commits resolve through GitHub |
| Diff and syntax checks | Pass |

### Live portal security probes

| Probe | Expected/result |
|---|---|
| Portal root | `200` |
| `/api/validate/..%2Fportal` | `400` |
| Export with `{"labs":[".."]}` | `400` |
| Known lab API | `200` |
| Missing lab asset | `404` |

## Deferred recommendations

These items require product-owner, architecture, instructor, or tenant validation and were intentionally not changed speculatively.

### Priority 1: Portal production architecture

- Implement browser MSAL or an approved BFF/Easy Auth pattern.
- Bind Power Platform delegated tokens to the authenticated user instead of a process-wide singleton.
- Add an administrator role/app-role check for shared configuration, branding, approval, Key Vault, and provisioning mutations.
- Document single-instance limitations before enabling App Service scale-out.

### Priority 2: Lab product-owner validation

- Lab 18: provide/import instructor-provisioned Dataverse records, MCP connectors, connected agents, and sample assets, or mark the lab explicitly instructor-provisioned.
- Lab 20: resolve whether it is a named GA A2A lab or a connected-agent orchestration lab.
- Lab 27: verify current Work IQ MCP UI, roles, regions, and implementation steps.
- Lab 31: resolve the scope distinction between real-time voice and digital messaging preview.
- Lab 33: validate the current Code Apps command path and decide when to migrate from PAC CLI to the newer npm CLI.
- Lab 36: validate clone/apply/publish commands against the current extension in a tenant.
- Labs 38-39: add runnable templates/assets or relabel them as facilitated governance workshops.
- Lab 40: verify current preview identity navigation, roles, and region support.

### Priority 3: Workshop delivery

- Treat Lab 07 analytics as a two-session exercise or provide sanitized pre-generated evidence because analytics can take 24-48 hours.
- Reassess Labs 22-25 time estimates after an instructor run; third-party provisioning, networking, gateways, and identity preparation should be completed before workshop active time.
- Capture current sanitized UI evidence for Labs 06, 34, and 35 if visual checkpoints are required.

## Blockers and intentional non-actions

- No implementation blocker remains in the audited code.
- No cloud resource, tenant setting, connection, app registration, or deployed agent was changed.
- No credentialed UI validation was performed.
- The remaining eight Learn-MCP warnings are not broken links; they require search-relevance, preview, or product-direction judgment.
- `issues-banner.png` was preserved based on repository history and the explicit content-preservation contract.

## Final repository state

The implementation and follow-up are preserved in separate commits:

1. `d2a820d` - core product and engineering audit changes.
2. `b57f496` - Learn-MCP triage, official-document additions, intentional orphan handling, and immutable Actions pins.

This audit document records those changes without modifying either preserved commit.
