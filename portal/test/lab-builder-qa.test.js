import { test } from "node:test";
import assert from "node:assert/strict";
import { assessLab, formatQaReport, parseMinutes, readingLevel } from "../lib/lab-builder/qa.js";

const ALT = "The Copilot Studio Overview page showing the agent name and instructions";

function lab({ extraStep = "", alt = ALT, time = "30 minutes", header = "About 30 minutes", extra = "" } = {}) {
  return `# Retail: Store Support Assistant

| Field | Details |
|---|---|
| ⭐ **DIFFICULTY** | Beginner |
| ⏱️ **TIME** | ${header} (estimate, not a limit) |

## Overview

Build the assistant.

## Learning Objectives

- Create an agent (Step 1)
- Publish it (Step 2)

## Time Estimate

| Step | Module | Level | Estimated time |
|---|---|---|---|
| 1 | Create an agent | 100 | about 20 min |
| 2 | Publish the agent | 100 | about 10 min |
| | **Total** | | **about ${time}** |

## Prerequisites

- A Copilot Studio license or trial, and the Environment Maker role.

## The Scenario

You support store associates.

## Step-by-Step

### Step 1 - Create an agent

*Level 100 · about 20 minutes*

1. Open **Home**.
2. Select **Create**.

**What you should see:** the Overview page.

![${alt}](assets/a.png)

*Figure 1.1. Overview.*

<details>
<summary>Knowledge check: why environments?</summary>

Because they scope connectors.

</details>

**Troubleshooting**

- Create is greyed out: check your role.

**In your scenario.** Name it Store Support Assistant.

**Check your work**

- [ ] The agent exists.

[Authoring](https://learn.microsoft.com/microsoft-copilot-studio/authoring-first-bot)

### Step 2 - Publish the agent

*Level 100 · about 10 minutes*

1. Select **Publish**.
2. Confirm.
${extraStep}
## Validation / Success Criteria

- [ ] Works.

## Where to Go Next

Read [Publish](https://learn.microsoft.com/microsoft-copilot-studio/publication-fundamentals-publish-channels).

## Troubleshooting

See each module.
${extra}`;
}

const rule = (report, id) => report.checks.find((c) => c.id === id);

test("a complete module passes its checklist and an incomplete one is named", () => {
  const report = assessLab(lab());
  const [one, two] = report.topics;
  assert.ok(one.checklist.filter((c) => c.pass).length >= 8, JSON.stringify(one.checklist));
  assert.equal(one.checklist.find((c) => c.id === "expected-results").pass, true);
  assert.equal(two.checklist.find((c) => c.id === "expected-results").pass, false);
  assert.match(report.findings.find((f) => f.rule === "module-expected-results").message, /Step 2/);
});

test("images without specific alt text are errors with line numbers", () => {
  const report = assessLab(lab({ alt: "screenshot of the page" }));
  const finding = report.findings.find((f) => f.rule === "image-alt-text" && f.line);
  assert.equal(finding.severity, "error");
  assert.match(finding.message, /screenshot of/);
  assert.equal(rule(report, "image-alt-text").status, "fail");
  assert.equal(rule(assessLab(lab({ alt: "" })), "image-alt-text").ratio, 0);
});

test("time estimates must agree, and a disagreement never asks for content to be cut", () => {
  assert.equal(rule(assessLab(lab()), "time-consistency").status, "pass");
  const bad = assessLab(lab({ time: "45 minutes" }));
  assert.equal(rule(bad, "time-consistency").status, "fail");
  const fix = bad.findings.find((f) => f.rule === "time-consistency").fix;
  assert.match(fix, /never trim content/);
});

test("terminology and US English are enforced outside code only", () => {
  const bad = assessLab(lab({ extra: "\nThe GitHub Copilot harness has a nice colour.\n" }));
  assert.equal(rule(bad, "terminology").status, "fail");
  assert.equal(rule(bad, "us-english").status, "fail");
  const fenced = assessLab(lab({ extra: "\n```text\nGitHub Copilot harness colour\n```\n" }));
  assert.equal(rule(fenced, "terminology").status, "pass");
  assert.equal(rule(fenced, "us-english").status, "pass");
});

test("heading order, repeated paragraphs, and missing topics are reported", () => {
  const skipped = assessLab(lab({ extra: "\n### Deep\n\nBody text here.\n" }));
  assert.equal(rule(skipped, "heading-order").status, "pass");
  assert.equal(rule(assessLab(lab({ extra: "\n##### Deeper\n\nBody.\n" })), "heading-order").status, "fail");

  const para = "This paragraph is deliberately long enough to count as repeated content when it appears twice.";
  assert.notEqual(rule(assessLab(lab({ extra: `\n${para}\n\n${para}\n` })), "duplicate-content").status, "pass");

  const missing = assessLab(lab(), { expectedTopics: [{ name: "Create an agent" }, { name: "Evaluations" }] });
  const finding = missing.findings.find((f) => f.rule === "topics-covered");
  assert.equal(finding.severity, "error");
  assert.match(finding.message, /Evaluations/);
});

test("the score is deterministic, bounded, and rewards a more complete lab", () => {
  const a = assessLab(lab());
  assert.deepEqual(assessLab(lab()), a);
  const bare = assessLab("# T\n\n## Overview\n\nHi.\n");
  assert.ok(bare.score >= 0 && bare.score < a.score && a.score <= 100);
  assert.match(formatQaReport(a), /^Quality \d+\/100/);
});

test("helpers parse durations and estimate reading level", () => {
  assert.equal(parseMinutes("About 1 hour 20 minutes (estimate)"), 80);
  assert.equal(parseMinutes("45 min"), 45);
  assert.equal(parseMinutes("soon"), null);
  const easy = readingLevel("Open the page. Select Create. Type a name.");
  assert.ok(easy.avgSentenceWords <= 4);
});
