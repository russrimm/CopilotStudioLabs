# Lab Validation Rubrics

Lab Validation Rubrics turn each hands-on CopilotStudioLabs build into a repeatable quality check. A rubric is a structured set of evaluation criteria that a learner, instructor, or lab author can run against a completed Copilot Studio agent to verify that it meets the lab's stated objectives. The framework repurposes the Copilot Studio Agent Evaluation features taught in Lab 02: test sets, expected responses, evaluator methods, pass rates, evaluator reasoning, activity maps, run comparison, and result export.

This is intentionally a content framework, not a new test runner. Rubrics define what to test and how to judge it; Copilot Studio executes the evaluation.

## Why this matters

The competitive scan in `.squad/decisions.md` identified AI agent output validation as an unmet market need. Most lab platforms can check infrastructure state or quiz answers, but they do not validate whether an AI agent behaves correctly after a learner builds it. Copilot Studio already has the evaluation engine; these rubrics give every lab a consistent assessment layer.

## Files in this folder

| File | Purpose |
|---|---|
| `schema.md` | Rubric structure specification and field definitions |
| `authoring-guide.md` | Step-by-step instructions for lab authors |
| `learner-guide.md` | Step-by-step instructions for learners running a rubric |
| `lab-01-energy-ops-agent.rubric.yaml` | Worked rubric example for Lab 01 |
| `lab-01-energy-ops-agent.testset.csv` | Importable Copilot Studio test set for Lab 01 |

## What a rubric contains

A rubric captures:

- The lab ID and completed agent being validated
- The lab learning objectives being assessed
- Success criteria and pass/fail thresholds
- Sample test inputs and expected behavior descriptions
- The intended evaluator type for each criterion: `llm-as-judge`, `regex`, `contains-string`, or `tool-call-check`
- The Copilot Studio evaluation method to use, such as General quality, Compare meaning, Keyword match, Exact match, Similarity, Capability use, Custom, or knowledge-source/citation review

## Mapping to Copilot Studio evaluation features

| Rubric concept | Copilot Studio feature |
|---|---|
| Test input | Evaluation **test case question** |
| Expected behavior | `expectedResponse` in CSV, plus evaluator reasoning review |
| Reusable assessment set | Evaluation **test set** |
| LLM-as-judge criteria | Copilot Studio **generative evaluators**, especially **General quality** or **Compare meaning** test methods |
| Contains-string / keyword requirement | **Keyword match** test method |
| Exact compliance phrase | **Exact match** test method |
| Semantic answer comparison | **Similarity** or **Compare meaning** test method |
| Tool/action invocation requirement | **Capability use** method or activity-map review |
| Lab-specific judge rubric | **Custom evaluator** when the tenant supports it, otherwise General quality plus manual reasoning review |
| Knowledge/citation requirement | **Knowledge source evaluation** through result detail: citations, source evidence, and activity map |
| Cohort evidence | **Export test results** CSV and run comparison |
| Regression gate | **Compare with** previous runs |

## Recommended pass/fail model

Use both an overall score and objective-specific gates:

- **Overall pass:** usually 80% or higher across the rubric test set
- **Critical criteria:** must pass 100% when they cover safety, security, compliance, PII, access control, or required tool use
- **Knowledge grounding:** should pass only when the response uses or cites the expected source, not merely when the prose sounds plausible
- **Regression:** do not accept a new run if a previously passing critical case fails

## Instructor use at cohort scale

Instructors can provide the rubric YAML and CSV with the lab materials, ask learners to import the CSV into their completed agent, and require an exported evaluation result as the completion artifact. For large cohorts, instructors can group results by lab ID, learner, test set name, pass rate, critical failures, and run date. The exported CSV plus the rubric file becomes evidence that the learner's agent met the lab's intended outcomes, not just that they clicked through the steps.

## Future integration: Validate Your Lab

Each lab README can add a short **Validate Your Lab** section after `Lab Complete`. That section should link to the lab's rubric file, link to its importable test-set CSV, state the passing score, and tell learners to run Copilot Studio Evaluation before moving on. Lab 01 in this folder is the template for that future rollout; the remaining 17 labs can adopt the same structure in a follow-up content task.
