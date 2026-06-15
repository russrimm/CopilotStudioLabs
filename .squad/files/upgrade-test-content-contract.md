# Lambert content-contract & preservation report

Requested by: Russ Rimmerman  
Date: 2026-06-13  
Scope: `labs\01-energy-ops-agent` through `labs\05-copilot-studio-vscode-agent-management`, root `README.md`, and `template.config.json` as content-state context.

## Labs surveyed

I sampled the lab tree just enough to characterize the content surface:

- Overall inventory under `labs\`: 5 lab folders, 6 Markdown files, 1 CSV sample data file, 19 PNG assets, and nested asset directories.
- `labs\01-energy-ops-agent\`
  - `index.md`: long step-by-step Copilot Studio lab with scenario prose, agent prompts, knowledge-source instructions, SharePoint/public-link guidance, Markdown links, and Contoso Energy/Contoso/subsidiary names embedded throughout.
  - `assets\Contoso_Field_Operations_Remote_Access_Guide.md`: sample internal policy/runbook content with VPN steps, device requirements, portal URLs, regional gateway names, and org-specific references.
  - `assets\images\issues-banner.png`: screenshot/image asset.
- `labs\02-agent-analytics-evaluations\`
  - `index.md`: analytics/evaluation lab tied to Lab 01, with cross-lab links, preview warnings, evaluation methods, and step-by-step UI prose.
  - `assets\EvaluationAlwaysFail.csv`: sample evaluation/test-set CSV with harmful/request-denial expected responses containing Contoso Energy/Contoso references.
- `labs\03-account-orchestration-agent\`
  - `index.md`: orchestration lab adapted from Microsoft sample content, with Dataverse/sample-data setup, tool/child-agent/Skill descriptions, internal-vs-customer policy framing, and many step-by-step UI instructions.
- `labs\04-energy-census-advanced-agent\`
  - `index.md`: largest advanced lab with API URLs, Census variable names, architecture text diagrams, topics, variables, HTTP tools, connected agents, flows, model selection, evaluations, optional MCP/VS Code sections.
  - `assets\*.png`: numerous UI screenshots used by Markdown image references.
- `labs\05-copilot-studio-vscode-agent-management\`
  - `index.md`: optional VS Code extension lab covering clone/modify/publish/verify workflow, with agent-as-code terminology, command names, and cross-lab links.

## 1. Customization surfaces

Typical fork owners will edit or add content in these categories:

1. Prose and scenario framing
   - Change Contoso Energy/Contoso/energy language to their organization, industry, customer personas, internal systems, escalation policy, and compliance regime.
   - Rewrite opening scenarios, objectives, examples, callouts, and executive/value statements.

2. Step-by-step operational instructions
   - Add tenant-specific Copilot Studio setup notes, environment names, Power Platform permissions, SharePoint library paths, Dataverse table/view names, VPN tooling, ITSM processes, or approval workflows.
   - Insert warnings about internal governance, review gates, or facilitator-only notes.

3. Prompts, agent instructions, test questions, and expected answers
   - Replace sample prompts, evaluation CSV rows, safety responses, agent names, tool descriptions, and expected outputs.
   - Add proprietary regression questions that should not be overwritten or globally string-replaced later.

4. Sample data and knowledge-source files
   - Replace `assets\Contoso_Field_Operations_Remote_Access_Guide.md` with local policy/runbook content.
   - Add PDFs/Markdown/CSV files used as uploaded documents, test sets, or workshop handouts.

5. Screenshots and visual assets
   - Add or replace PNGs under `assets\`, `assets\images\`, or custom `screenshots\` folders.
   - Update Markdown alt text and image paths to match tenant-specific UI, branding, or localized screenshots.

6. Lab structure and sequencing
   - Add new lab folders such as `labs\06-internal-only-lab\`.
   - Remove irrelevant labs, split a long lab, or add facilitator/participant variants.

7. README and navigation
   - Edit root lab table, add custom onboarding instructions below the generated table, add internal SharePoint/Teams links, prerequisites, workshop schedules, and support contacts.

8. Translation/localization
   - Translate `index.md` files in place, create localized copies, or add culture-specific screenshots and terms.

9. Internal links and external references
   - Replace Microsoft/public sample links with company intranet, Learn paths, partner portals, or internal compliance references.

## 2. Must-NOT-change list from a content perspective

Upgrade tooling and tests should treat these as preserved user state:

1. Any file path under `labs\` manually edited since `setup.js` ran.
   - Examples: edited `labs\01-energy-ops-agent\index.md`, translated `labs\02-agent-analytics-evaluations\index.md`, customized `labs\01-energy-ops-agent\assets\Contoso_Field_Operations_Remote_Access_Guide.md`, changed `labs\02-agent-analytics-evaluations\assets\EvaluationAlwaysFail.csv`.
   - Content should not be overwritten by upstream prose/screenshot refresh unless the merge strategy can prove the user did not change the same file or hunk.

2. Any user-added files inside template-managed directories.
   - Examples: `labs\01-energy-ops-agent\custom-notes.md`, `labs\01-energy-ops-agent\screenshots\my-screenshot.png`, `labs\04-energy-census-advanced-agent\assets\customer-territory-map.png`, `labs\02-agent-analytics-evaluations\assets\PartnerEvalSet.csv`.
   - `setup.js` currently walks all Markdown files under `labs\`, so user-added `.md` files are at risk from broad replacement.

3. Any user-added lab folder.
   - Example: `labs\06-internal-only-lab\`.
   - Current `setup.js` computes `allLabs` from every directory in `labs\` and removes any not in `template.config.json` `labs.include`. That means a custom lab folder can be deleted on re-run unless it is manually added to `labs.include`.

4. The user's `template.config.json` itself.
   - It is user state, not template content. It records org, lab include list, branding, knowledge-source choices, and deployment intent.
   - Upstream schema/default changes should be offered as migrations, not direct replacement.

5. README sections the user added below the autogenerated lab table.
   - Root `README.md` has generated/templated lab navigation and also human-authored getting-started, deployment, changelog, screenshot, and workflow content.
   - Partners may add workshop schedules, support contacts, internal setup instructions, or localized notes below the lab table; those additions must survive setup re-runs and template pulls.
   - Safer contract: only rewrite a bounded generated block marked by explicit begin/end comments, not arbitrary matching sections.

## 3. Must-change list when template upstream updates ship

These changes should flow to forks when safe:

1. New lab folders introduced upstream
   - If upstream adds `labs\06-new-template-lab\`, upgrade should add it unless the fork explicitly opts out.
   - It must not collide with a user-added folder of the same name without conflict reporting.

2. Bug fixes and typo fixes in existing lab prose
   - Apply automatically only when the target file/hunk is still template-derived.
   - Detection options: baseline manifest from last setup/template version, per-file hashes, per-block hashes, or a three-way merge using `base template -> upstream template -> user fork`.
   - If the user edited the same file or nearby hunk, report a content conflict and leave user text intact.

3. Updated screenshots in `assets\`
   - Replace only screenshots that still match the previous template-managed asset hash.
   - Preserve user-added images and user-replaced images. If an upstream asset path matches a user-modified file, flag for review rather than overwrite.
   - Validate Markdown image links after any asset update.

4. README generated lab table changes
   - Add rows for new upstream labs and update labels/times/links only inside a generated block.
   - Preserve user-authored README content outside that block.

5. Setup/schema improvements
   - New `template.config.schema.json` defaults or optional fields may be suggested or merged carefully, but never replace the user's config wholesale.

## 4. Gotchas specific to this repo

1. Broad string replacement is unsafe.
   - `setup.js` uses simple `content.split(searchValue).join(replaceValue)` across every `.md` file under `labs\` plus `README.md`.
   - There is no boundary awareness for code fences, URLs, image alt text, CSV content, file names, or user-added Markdown files.

2. `Contoso Energy` appears in many semantic roles.
   - It appears in prose, prompt examples, expected safety responses, links/paths, screenshot alt text, and lab directory names like `01-energy-ops-agent`.
   - Replacing visible text without renaming directories creates mixed branding: content may say Contoso while paths still say `sdge`.
   - Renaming directories without updating links/config creates broken navigation.

3. Lab directory names contain org slugs.
   - `template.config.json` `labs.include` lists exact folder names.
   - If a user renames `labs\01-energy-ops-agent\` to `labs\01-contoso-energy-ops-agent\`, a setup re-run sees it as a lab directory. Unless included exactly, it can be deleted as an excluded lab. The original upstream name may also be missing, so cross-lab links can break.
   - Current `setup.js` does not rename lab folders; it only removes excluded folders and text-replaces Markdown.

4. Multi-word names risk partial-match corruption.
   - Names such as `Contoso`, `Pacific Coast Electric`, `Western Gas & Energy`, `LoneStar Grid`, and `Contoso Energy` can occur in examples, legal/company descriptions, URLs, or file content where replacement might not be intended.
   - Short replacements can produce awkward grammar or broken possessives. Long replacements can break Markdown table width/readability but not syntax.

5. Markdown link integrity is fragile.
   - Cross-lab links use relative paths such as `../01-energy-ops-agent/index.md` and root README uses `./labs/01-energy-ops-agent/index.md`.
   - If folder names, file names, or headings change, links and anchors can break.
   - Tests should scan Markdown links after setup and after upgrade.

6. Non-Markdown content is not consistently customized.
   - Current replacement touches `.md` and root `README.md`, not `.csv` or images. The Lab 02 CSV still contains Contoso Energy/Contoso strings and may remain stale after setup.
   - Screenshots can contain embedded old org/UI text that string replacement cannot update.

7. Exclusion is destructive.
   - `setup.js` removes labs not listed in `labs.include` via recursive delete. In a fork, this can delete custom labs or user-added lab copies.

## 5. Content survival test scenarios for Kane

1. Partner edits Lab 01 VPN steps in place
   - Setup: After initial setup, edit `labs\01-energy-ops-agent\index.md` Step 3 to add the partner's VPN tool, portal URL, and helpdesk escalation.
   - Expected survival: Re-running setup or pulling upstream typo fixes must not overwrite the edited step. If upstream also changed that step, report a conflict.

2. Partner adds screenshots under a new screenshots folder
   - Setup: Add `labs\01-energy-ops-agent\screenshots\my-vpn-login.png` and link it from Lab 01 Markdown.
   - Expected survival: File and link remain after setup re-run and template pull. No broad delete of unknown asset folders.

3. Partner translates Lab 02 in place
   - Setup: Translate `labs\02-agent-analytics-evaluations\index.md` to Spanish while preserving relative links.
   - Expected survival: Setup re-run must not re-English the file or inject new org replacements into translated text. Upstream changes to Lab 02 should be conflict/suggestion, not overwrite.

4. Partner adds proprietary Lab 06
   - Setup: Add `labs\06-internal-only-lab\index.md` plus `assets\private-workflow.png`; optionally add README row.
   - Expected survival: Setup re-run must not delete the folder even if absent from original `labs.include`. Upgrade should not treat it as an excluded template lab.

5. Partner customizes Lab 02 evaluation CSV
   - Setup: Replace rows in `labs\02-agent-analytics-evaluations\assets\EvaluationAlwaysFail.csv` with partner policy examples and expected refusal messages.
   - Expected survival: Upstream CSV changes should not overwrite partner test data. If setup supports replacements in CSV later, it must respect user-modified file hashes.

6. Partner changes root README after the generated lab table
   - Setup: Add workshop dates, Teams channel, facilitator roster, and internal prerequisite links below the lab table.
   - Expected survival: README lab-table regeneration should preserve all custom sections outside the generated block.

7. Partner renames Lab 01 folder to remove Contoso Energy slug
   - Setup: Rename `labs\01-energy-ops-agent\` to `labs\01-contoso-energy-ops-agent\`, update README and cross-lab links, and update `template.config.json` include list.
   - Expected survival: Setup re-run must not delete the renamed folder or recreate conflicting paths. If folder renames are unsupported, tooling should detect and warn before touching `labs\`.

8. Partner replaces Lab 04 screenshots but keeps same filenames
   - Setup: Replace `labs\04-energy-census-advanced-agent\assets\copilot-studio-home.png` and several tool screenshots with tenant-specific captures.
   - Expected survival: Upstream screenshot refresh should not overwrite user-replaced images unless the prior hash matches the known template hash. Report stale screenshot conflicts for manual review.

## 6. Recommended content-side hardening

1. Add user-edit detection before rewriting.
   - Record a manifest after setup with path, file type, size, hash, and template version.
   - On re-run or upgrade, compare current files to the manifest. If a file changed since setup, do not blindly rewrite it.

2. Introduce template-managed markers.
   - Add a manifest such as `.template-managed.json` or `.squad`-compatible state file that records template-owned files and generated blocks.
   - Use explicit README markers, for example `<!-- BEGIN TEMPLATE LAB TABLE -->` and `<!-- END TEMPLATE LAB TABLE -->`, so updates are bounded.

3. Stop treating every directory under `labs\` as removable template state.
   - Distinguish known upstream lab IDs from user-added lab folders.
   - Only delete a lab if it is known template-managed and intentionally excluded.
   - Never delete unknown folders without a clear warning/opt-in.

4. Address lab-directory rename explicitly.
   - Preferred: keep stable lab IDs and avoid org names in folder names going forward.
   - If renames are supported, centralize path mapping and update README/cross-lab links/config atomically.
   - If unsupported, detect renamed/missing expected lab folders and fail safely before deleting anything.

5. Use three-way merge semantics for upstream updates.
   - Treat current fork as user branch, previous template as base, and new template as upstream.
   - Apply clean hunks automatically; preserve user hunks; report conflicts with file/hunk context.

6. Restrict replacement scope.
   - Replace only in known template-managed Markdown blocks/files unless the user opts in.
   - Avoid replacement inside code fences, URLs, Markdown link targets, and generated data files unless explicitly designed.
   - Extend tests to CSV and screenshot-alt/link integrity because current `.md`-only replacement leaves mixed-brand CSV content.

7. Add content validation tests.
   - Markdown link checker for root README and all lab `index.md` files.
   - Image existence check for every Markdown image reference.
   - Manifest-based survival checks for user-added files, translated files, custom labs, and renamed lab paths.
   - Mixed-brand scan that reports remaining old org strings in managed content without rewriting user content.

## Content-side contract summary

The content upgrade contract should be: upstream may add new template labs and safely patch unchanged template-owned content, but it must preserve any user-authored lab content, user-added files/folders, user config, and README custom sections. Current `setup.js` is not safe enough for that contract because it performs broad Markdown replacement and destructive lab exclusion without a managed-file baseline.
