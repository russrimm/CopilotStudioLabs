# Lab Validation Rubric Schema

Rubrics are authored in YAML. YAML is easier for lab authors and instructors to read, comment, and review in pull requests than JSON, while still mapping cleanly to JSON if automation is added later.

## File naming

Use:

```text
docs/validation-rubrics/<lab-id>.rubric.yaml
```

Example:

```text
docs/validation-rubrics/lab-01-energy-ops-agent.rubric.yaml
```

## Top-level structure

```yaml
schemaVersion: 1
rubricId: lab-01-energy-ops-agent
lab:
  id: "01"
  slug: 01-energy-ops-agent
  title: "Lab 01: Build a Custom IT Operations Agent for Contoso Energy"
  agentNamePattern: "Contoso IT Operations Agent"
validation:
  mode: copilot-studio-agent-evaluation
  overallPassingScore: 0.80
  criticalCriteriaMustPass: true
  recommendedTestSetName: "Lab 01 — Energy Ops Validation"
  testSetCsv: "lab-01-energy-ops-agent.testset.csv"
learningObjectives:
  - id: objective-id
    description: "Objective from the lab README"
    mappedCriteria:
      - criterion-id
criteria:
  - id: criterion-id
    name: "Human-readable criterion name"
    objectiveIds:
      - objective-id
    evaluatorType: llm-as-judge
    copilotStudioMethod: General quality
    weight: 1
    critical: false
    passingScore: 0.80
    expectedBehavior: "What a good agent response must do"
    sampleInputs:
      - "Learner-facing test question"
    scoringGuidance:
      pass: "What counts as pass"
      fail: "What counts as fail"
    requiredEvidence:
      - type: knowledge-source
        description: "Expected citation, source, topic, or tool evidence"
```

## Required fields

| Field | Type | Required | Description |
|---|---:|:---:|---|
| `schemaVersion` | number | Yes | Schema version. Start with `1`. |
| `rubricId` | string | Yes | Stable ID matching the file name without extension. |
| `lab.id` | string | Yes | Two-digit lab number. |
| `lab.slug` | string | Yes | Folder name under `labs/`. |
| `lab.title` | string | Yes | Lab title as shown in the lab README/index. |
| `lab.agentNamePattern` | string | Yes | Expected agent name or prefix learners will see. |
| `validation.mode` | string | Yes | Use `copilot-studio-agent-evaluation`. |
| `validation.overallPassingScore` | number | Yes | Overall pass threshold from `0` to `1`. |
| `validation.criticalCriteriaMustPass` | boolean | Yes | Whether all `critical: true` criteria must pass. |
| `validation.recommendedTestSetName` | string | Yes | Name learners should use in Copilot Studio. |
| `validation.testSetCsv` | string | Yes | Relative CSV file to import. |
| `learningObjectives` | array | Yes | Objectives copied or summarized from the lab. |
| `criteria` | array | Yes | Evaluation criteria that implement the rubric. |

## Criterion fields

| Field | Type | Required | Description |
|---|---:|:---:|---|
| `id` | string | Yes | Stable criterion ID. |
| `name` | string | Yes | Short readable criterion name. |
| `objectiveIds` | array | Yes | Learning objectives this criterion validates. |
| `evaluatorType` | enum | Yes | One of `llm-as-judge`, `regex`, `contains-string`, `tool-call-check`. |
| `copilotStudioMethod` | string | Yes | Matching Copilot Studio method. |
| `weight` | number | Yes | Relative weighting for manual rollups. |
| `critical` | boolean | Yes | If true, a failure blocks completion. |
| `passingScore` | number | Yes | Criterion-level threshold from `0` to `1`. |
| `expectedBehavior` | string | Yes | Behavior an LLM judge or human reviewer should look for. |
| `sampleInputs` | array | Yes | One or more user questions. |
| `scoringGuidance.pass` | string | Yes | Pass condition. |
| `scoringGuidance.fail` | string | Yes | Fail condition. |
| `requiredEvidence` | array | No | Expected knowledge source, citation, topic, action, or tool evidence. |

## Evaluator type guidance

| `evaluatorType` | Use when | Copilot Studio mapping |
|---|---|---|
| `llm-as-judge` | Open-ended response quality, groundedness, safety, procedural completeness | General quality, Compare meaning, Custom |
| `regex` | A required pattern must appear, such as a ticket ID format, FIPS code, or exact URL shape | Exact match, Keyword match, or Custom |
| `contains-string` | The answer must include required terms, caveats, or source names | Keyword match |
| `tool-call-check` | The agent must use a topic, tool, action, flow, connected agent, or knowledge source | Capability use or activity-map review |

## CSV format

Copilot Studio CSV import expects at least:

```csv
question,expectedResponse
"Question the evaluation asks","Expected behavior or answer used by the selected method"
```

Keep CSV test cases under Copilot Studio limits taught in Lab 02: up to 100 questions per file and up to 1,000 characters per question.
