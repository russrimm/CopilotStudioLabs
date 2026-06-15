# Project Context

- **Project:** CopilotStudioLabs
- **User:** Russ Rimmerman
- **Description:** Hands-on Copilot Studio labs for energy company customers.
- **Tech Stack:** Markdown content, US Census Bureau APIs, Power Automate flows, MCP servers (Node.js), Microsoft Copilot Studio
- **Initialized:** 2026-06-12T23:54:28-05:00

## History

- 2026-06-13: Audited all 5 lab files for screenshot placement. Identified ~197 specific locations where screenshots should be added, covering screen changes and potentially confusing UI moments.

## 2026-06-13T23:58:38-05:00

- Collaborated on the upgrade test plan for `setup.js` and `tools/screenshot-capture`. Artifacts live in `.squad/files/upgrade-test-plan-architecture.md`, `.squad/files/upgrade-test-tooling-mechanics.md`, `.squad/files/upgrade-test-matrix.md`, and `.squad/files/upgrade-test-content-contract.md`; session context is logged in `.squad/log/2026-06-13T23-58-38Z-upgrade-test-plan.md`.

## 2026-06-14T02:36:00-05:00

- Resumed and completed the earlier interrupted Lab 2 analytics/evaluations task by incorporating Microsoft Learn "Monitor Performance and Evaluate Agent Quality" practices into `labs/02-agent-analytics-evaluations/index.md`.
- Added guidance for transcript/session review, citation-gap remediation, score/citation interpretation, severity triage, governance/export handling, and citation/transcript golden rules.
- Verification reported: `git diff --check` passed and Markdown fences are balanced; `assets/EvaluationAlwaysFail.csv` remained unchanged because upstream still uses `question`/`expectedResponse`.

## 2026-06-15T00:55:00-05:00

- Completed the Lab 04 smoothness pass under Russ's standing directive: added Census API key signup/activation expectations, reinforced activated-key paste into `Global.APIKey`, fixed a first-message typo, clarified Adaptive Card node labeling, repaired StateInput/City/ZipCode to StateFIPS flow guidance, added global-variable fallback instructions, and noted Power Automate trigger-location variance. Lambert also had a pre-existing Lab 2 Microsoft Learn incorporation decision merged from inbox in this Scribe pass.

## 2026-06-15T01:59:09-05:00

- Implemented R2 (Validation Rubric framework): Created `docs/validation-rubrics/` with reusable lab-validation ecosystem including `README.md`, `schema.md`, `authoring-guide.md`, and `learner-guide.md`. Designed four evaluator types (`llm-as-judge`, `regex`, `contains-string`, `tool-call-check`) mapped to Copilot Studio native methods. Authored Lab 01 worked example: `lab-01-energy-ops-agent.rubric.yaml` (YAML for author readability) and `lab-01-energy-ops-agent.testset.csv` (CSV native import format). Framework addresses competitive scan finding on automated agent-behavior validation using Copilot Studio's native Agent Evaluation tooling. Decision merged to `.squad/decisions.md`; orchestration log written.
