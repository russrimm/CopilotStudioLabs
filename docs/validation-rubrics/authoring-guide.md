# Authoring Guide: Create a Lab Validation Rubric

Use this guide when adding a validation rubric for a CopilotStudioLabs lab.

## 1. Start from the lab outcomes

Read the lab's `index.md` and copy the objectives, completed solution components, and final test prompts. A rubric should validate the agent the learner actually built, not introduce a new scenario.

Capture:

- Lab ID, slug, and title
- Expected agent name or naming pattern
- Learning objectives
- Required knowledge sources, topics, tools, flows, connected agents, or actions
- Safety, compliance, privacy, or access-control boundaries
- Existing test prompts in the lab

## 2. Decide the validation shape

Group criteria by objective. Most labs should include 6-12 criteria:

- 3-5 common user-success cases
- 1-2 ambiguity or missing-information cases
- 1-2 grounding/citation cases
- 1-2 safety, compliance, or refusal cases
- Tool/action criteria where the lab builds tools, flows, connectors, connected agents, or MCP servers

Mark a criterion as `critical: true` when failure means the learner should not claim completion.

## 3. Choose evaluator types

Use the least subjective evaluator that fits the criterion.

| Need | Use |
|---|---|
| Open-ended helpful response | `llm-as-judge` + General quality |
| Compare against an expected answer | `llm-as-judge` + Compare meaning |
| Required phrase, URL, or caveat | `contains-string` + Keyword match |
| Exact code, ID, URL, or compliance phrase | `regex` or Exact match |
| Topic/tool/action/flow must run | `tool-call-check` + Capability use or activity-map review |

For regulated scenarios, combine LLM judgment with required keywords and source/citation review.

## 4. Write expected behavior, not only expected text

AI agents may answer correctly using different wording. Good expected behavior descriptions state what must be present:

- Intent recognized correctly
- Required steps or facts included
- Required source or citation used
- Unsafe request refused
- Missing information requested before answering
- Tool/action used when deterministic data is required

Avoid brittle wording unless the exact phrase matters.

## 5. Build the importable CSV

Create a CSV next to the rubric:

```text
docs/validation-rubrics/<lab-id>.testset.csv
```

Use the Copilot Studio format taught in Lab 02:

```csv
question,expectedResponse
```

The `expectedResponse` cell can contain a concise expected behavior description. After import, configure the test methods in Copilot Studio according to the rubric.

## 6. Set thresholds

Recommended defaults:

- Overall pass: `0.80`
- Critical criteria: `1.00` and must pass
- Safety/security/compliance refusal cases: must pass
- Tool-call cases: must show expected tool/action/topic evidence in the activity map

If a lab is introductory, keep the threshold lower but require critical safety cases. If a lab is advanced or compliance-heavy, use a higher threshold.

## 7. Add a future lab integration note

When the rubric is ready, add a future **Validate Your Lab** section to the lab README in a separate content pass. It should link to the rubric YAML, the CSV, and the learner guide, and state the pass threshold.

## Authoring checklist

- [ ] Rubric has lab ID, slug, title, and agent name pattern
- [ ] Every learning objective maps to at least one criterion
- [ ] Critical criteria are marked explicitly
- [ ] CSV imports with `question,expectedResponse`
- [ ] Expected behavior fits Copilot Studio evaluation methods
- [ ] Learner instructions tell users which methods to configure after import
- [ ] Instructor guidance includes export and cohort evidence expectations
