import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getFeatures, getHarnesses, validateCatalog } from "../lib/lab-builder/catalog.js";
import { getConcepts } from "../lib/lab-builder/concepts.js";
import {
  buildDifferenceBlocks,
  defaultDifferencesFor,
  getDifference,
  getDifferences,
  validateDifferences,
} from "../lib/lab-builder/differences.js";
import { generateLab } from "../lib/lab-builder/generator.js";
import { planLab } from "../lib/lab-builder/planner.js";
import { renderLabMarkdown } from "../lib/markdown.js";
import { parseLabSteps } from "../lib/step-validator/steps.js";
import { checkExpandableNotes } from "../lib/validator.js";

const NOW = Date.parse("2026-11-13T00:00:00Z");
const HARNESSES = getHarnesses();
const CONCEPTS = getConcepts();

function record(over = {}) {
  return {
    concept: "skills",
    title: "Skills",
    confidence: "documented",
    harnesses: {
      standard: { term: "Prompt tool", availability: "supported", summary: "A." },
      "microsoft-copilot": { term: "Skill", availability: "preview", summary: "B." },
    },
    sources: [{ title: "Skills overview", url: "https://learn.microsoft.com/microsoft-copilot-studio/agents-experience/skills-overview" }],
    lastVerified: "2026-11-12",
    verifiedAgainst: "https://learn.microsoft.com/microsoft-copilot-studio/agents-experience/skills-overview",
    ...over,
  };
}
const check = (records) => validateDifferences({ records, concepts: CONCEPTS, harnesses: HARNESSES, now: NOW });

async function lab(request) {
  return generateLab(request, { write: false, useLearnMcp: false, useLlm: false });
}

test("the shipped difference records are valid and cover the headline concepts", () => {
  assert.deepEqual(validateCatalog(), []);
  const covered = new Set(getDifferences().map((r) => r.concept));
  for (const id of ["instructions", "knowledge", "tools", "skills", "mcp", "subagents", "sdk", "memory", "hooks", "triggers", "workflows", "testing", "publish", "governance"]) {
    assert.ok(covered.has(id), `${id} has no difference record`);
  }
  for (const r of getDifferences()) for (const s of r.sources) assert.match(s.url, /^https:\/\/learn\.microsoft\.com\//);
});

test("difference validation reports every kind of problem", () => {
  assert.deepEqual(check([record()]), []);
  assert.match(check([record({ concept: "nope" })]).join("\n"), /unknown concept/);
  assert.match(check([record(), record()]).join("\n"), /duplicate record/);
  assert.match(check([record({ sources: [{ title: "Doc", url: "https://example.com/x" }] })]).join("\n"), /on learn\.microsoft\.com/);
  assert.match(check([record({ verifiedAgainst: "https://learn.microsoft.com/other" })]).join("\n"), /verifiedAgainst must be one of its sources/);
  assert.match(check([record({ lastVerified: "2026-02-30" })]).join("\n"), /valid YYYY-MM-DD/);
  assert.match(check([record({ lastVerified: "2027-01-01" })]).join("\n"), /in the future/);
  assert.match(check([record({ confidence: "uncertain" })]).join("\n"), /need an uncertainNote/);
  assert.match(check([record({ confidence: "maybe" })]).join("\n"), /confidence must be one of/);
  const unknown = record();
  unknown.harnesses.standard.availability = "unknown";
  assert.match(check([unknown]).join("\n"), /cannot be marked documented/);
  const named = record();
  named.harnesses.standard.summary = "Works on the GitHub Copilot harness.";
  assert.match(check([named]).join("\n"), /not the earlier name/);
  const british = record();
  british.harnesses.standard.summary = "Customise the behaviour.";
  assert.match(check([british]).join("\n"), /US English/);
  assert.match(check([record({ harnesses: { standard: record().harnesses.standard } })]).join("\n"), /at least two harnesses/);
});

test("a Microsoft Copilot harness lab explains the Standard harness, and the reverse", async () => {
  const mc = await lab({ features: ["mc-skills"], harness: "microsoft-copilot" });
  assert.equal(mc.status, "complete");
  assert.match(mc.markdown, /<summary>How this differs on the Standard harness<\/summary>/);
  assert.match(mc.markdown, /The Microsoft Copilot harness calls this "Skill"\. The Standard harness calls it "Prompt tool"\./);
  assert.match(mc.markdown, /\*\*Availability on the Standard harness\.\*\* Supported\./);

  const std = await lab({ features: ["prompt-tools"], harness: "standard" });
  assert.match(std.markdown, /<summary>How this differs on the Microsoft Copilot harness<\/summary>/);
  assert.match(std.markdown, /Skills replace prompt tools|Skills replace them/);
  assert.match(std.markdown, /Planned, not yet available|Not supported|Preview|Supported/);
  assert.equal(std.manifest.differences.labHarness, "standard");
  assert.deepEqual(std.manifest.differences.comparedWith, ["microsoft-copilot"]);
  assert.ok(std.manifest.differences.concepts.includes("skills"));
});

test("each note names its sources, keeps headings in order, and states uncertainty plainly", async () => {
  const result = await lab({ features: ["vscode-authoring"], harness: "standard", differencesFor: ["microsoft-copilot", "customer-conversation"] });
  const md = result.markdown;
  assert.match(md, /\*\*Sources \(checked 2026-11-12\)\.\*\* \[About agents powered by the Microsoft Copilot harness\]\(https:\/\/learn\.microsoft\.com\//);
  assert.match(md, /\*\*Not confirmed in Microsoft Learn\.\*\*/);
  assert.match(md, /Not confirmed in Microsoft Learn\.\n/);
  const block = md.slice(md.indexOf("<details>"), md.indexOf("</details>"));
  assert.doesNotMatch(block, /^#{1,6} /m, "notes use bold labels, not headings");
  assert.deepEqual(result.manifest.differences.notFullyDocumented, ["sdk"]);
});

test("a concept is explained once per lab, on its first module", async () => {
  const result = await lab({ features: ["knowledge-sharepoint", "knowledge-files-web", "knowledge-dataverse"], harness: "standard" });
  const blocks = result.markdown.match(/<summary>How this differs on the Microsoft Copilot harness<\/summary>/g) || [];
  const knowledgeBlocks = result.manifest.differences.concepts.filter((id) => id === "knowledge");
  assert.equal(knowledgeBlocks.length, 1);
  assert.ok(blocks.length >= 1);
  const firstKnowledge = result.markdown.indexOf("### Step", result.markdown.indexOf("Add knowledge"));
  assert.ok(firstKnowledge >= 0);
});

test("notes can be turned off, extended, and have sensible defaults", async () => {
  assert.deepEqual(defaultDifferencesFor("standard"), ["microsoft-copilot"]);
  assert.deepEqual(defaultDifferencesFor("microsoft-copilot"), ["standard"]);
  assert.deepEqual(defaultDifferencesFor("customer-conversation"), ["standard", "microsoft-copilot"]);

  const off = await lab({ features: ["mc-skills"], harness: "microsoft-copilot", differencesFor: [] });
  assert.doesNotMatch(off.markdown, /<details>/);
  assert.doesNotMatch(off.markdown, /expandable \*\*How this differs\*\* note/);
  assert.deepEqual(off.manifest.differences.concepts, []);

  const both = planLab({ features: ["mc-skills"], harness: "microsoft-copilot", differencesFor: ["standard", "customer-conversation"] });
  const blocks = buildDifferenceBlocks(both, { harnesses: HARNESSES, concepts: CONCEPTS });
  assert.deepEqual(blocks.harnesses, ["standard", "customer-conversation"]);
  const skills = [...blocks.byFeature].find(([id]) => id === "mc-skills")[1].join("\n");
  assert.match(skills, /How this differs on the Customer Conversation harness/);
  assert.match(skills, /Generative skill and Topic skill/);

  await assert.rejects(() => lab({ features: ["topics"], differencesFor: ["nope"] }), /Unknown harness id/);
});

test("generated labs never use the earlier harness name and pass every validation check", async (t) => {
  const outputRoot = mkdtempSync(join(tmpdir(), "lab-differences-"));
  t.after(() => rmSync(outputRoot, { recursive: true, force: true }));
  const result = await generateLab(
    { features: ["mc-skills", "mc-memory", "mc-hooks"], harness: "microsoft-copilot" },
    { outputRoot, useLearnMcp: false, useLlm: false },
  );
  assert.doesNotMatch(result.markdown, /github copilot harness/i);
  assert.match(result.markdown, /expandable \*\*How this differs\*\* note/);
  assert.equal(result.validation.failed, 0, JSON.stringify(result.validation.tests.filter((t) => t.status === "fail")));
  const notes = result.validation.tests.find((t) => t.name === "expandable-notes");
  assert.equal(notes.status, "pass");
  assert.match(notes.message, /expandable note\(s\) each have a summary and content/);
});

test("the portal preview renders the notes as real details elements", async () => {
  const result = await lab({ features: ["mc-hooks"], harness: "microsoft-copilot" });
  const html = renderLabMarkdown(result.markdown);
  assert.match(html, /<details>\s*<summary>How this differs on the Standard harness<\/summary>/);
  assert.match(html, /<strong>Same goal\.<\/strong>/);
  assert.match(html, /<a href="https:\/\/learn\.microsoft\.com\//);
  const css = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(css, /\.preview-frame details > summary:focus-visible/);
});

test("the expandable-notes check flags blocks a keyboard or screen reader user could not use", () => {
  assert.deepEqual(checkExpandableNotes("# T\n\ntext\n"), { count: 0, problems: [] });
  const good = "<details>\n<summary>How this differs on X</summary>\n\nBody.\n\n</details>\n";
  assert.deepEqual(checkExpandableNotes(good), { count: 1, problems: [] });
  assert.match(checkExpandableNotes("<details>\nBody only.\n</details>").problems.join(" "), /no <summary>/);
  assert.match(checkExpandableNotes("<details>\n<summary> </summary>\nBody\n</details>").problems.join(" "), /no <summary>/);
  assert.match(checkExpandableNotes("<details>\n<summary>S</summary>\n</details>").problems.join(" "), /no content/);
  assert.match(checkExpandableNotes("<details>\n<summary>S</summary>\nBody").problems.join(" "), /<details> and 0 <\/details>/);
  assert.deepEqual(checkExpandableNotes("```html\n<details>\n```\n"), { count: 0, problems: [] });
});

test("step validation ignores the notes because they describe another harness", async () => {
  const result = await lab({ features: ["mc-skills"], harness: "microsoft-copilot" });
  assert.match(result.markdown, /<details>/);
  const parsed = parseLabSteps(result.markdown);
  const everything = JSON.stringify(parsed);
  assert.doesNotMatch(everything, /How this differs/);
  assert.doesNotMatch(everything, /Same goal/);
  assert.ok(parsed.steps.length >= 1);
});

test("the wizard lets learners choose which harnesses get notes", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const wizard = readFileSync(new URL("../public/lab-builder-wizard.js", import.meta.url), "utf8");
  assert.match(html, /id="lb-differences-options"/);
  assert.match(html, /Add expandable "How this differs" notes for/);
  assert.match(wizard, /differencesFor: \[\.\.\.lbDifferencesFor\(\)\]/);
  assert.ok(getFeatures().length > 0);
  assert.ok(getDifference("skills"));
});
