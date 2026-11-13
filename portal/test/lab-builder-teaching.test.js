import { test } from "node:test";
import assert from "node:assert/strict";
import { generateLab } from "../lib/lab-builder/generator.js";
import { assessLab } from "../lib/lab-builder/qa.js";

const OPTS = { write: false, useLearnMcp: false, useLlm: false, checkLinks: false };

async function build(request) {
  return generateLab(request, OPTS);
}

test("every module teaches: expected result, troubleshooting, knowledge check, and a scenario thread", async () => {
  const { markdown } = await build({ industry: "retail", features: ["create-agent", "agent-instructions", "test-agent"], includeCore: false });
  const modules = markdown.split(/^### Step /m).slice(1);
  assert.equal(modules.length, 3);
  for (const part of modules) {
    assert.match(part, /\*\*What you should see\.\*\*/);
    assert.match(part, /\*\*Troubleshooting\*\*/);
    assert.match(part, /<summary>Knowledge check:/);
    assert.match(part, /\*\*In your scenario\.\*\*/);
  }
});

test("sample input is tailored to the vertical and cannot break out of its code fence", async () => {
  const { markdown } = await build({
    industry: "healthcare",
    features: ["create-agent", "agent-instructions"],
    includeCore: false,
    agentName: "Bot ``` <b>x</b>",
    audience: "staff ``` | admins",
  });
  assert.match(markdown, /Help with clinical and administrative support/);
  const fences = markdown.match(/^```/gm) || [];
  assert.equal(fences.length % 2, 0);
  assert.doesNotMatch(markdown, /(^|[^\\])<b>x/);
});

test("objectives name their step, and the lab gains licensing, cleanup, glossary, and further reading", async () => {
  const { markdown } = await build({ industry: "retail", features: ["create-agent", "publish-agent"], includeCore: false });
  assert.match(markdown, /^- \*\*Step 1 - Create an agent:\*\*/m);
  assert.match(markdown, /\*\*Licensing and permissions\*\*/);
  assert.match(markdown, /^## Cleanup$/m);
  assert.match(markdown, /^## Glossary$/m);
  assert.match(markdown, /\*\*Further reading on Microsoft Learn\*\*/);
  assert.match(markdown, /^## Where to Go Next$/m);
});

test("a generated lab scores well on its own QA and keeps its time estimates consistent", async () => {
  const { markdown, plan } = await build({ industry: "manufacturing", features: ["create-agent", "agent-instructions", "publish-agent"], includeCore: false });
  const report = assessLab(markdown, { expectedTopics: plan.features });
  assert.ok(report.score >= 90, `${report.score}: ${JSON.stringify(report.findings.map((f) => f.message))}`);
  assert.equal(report.checks.find((c) => c.id === "time-consistency").status, "pass");
  assert.equal(report.checks.find((c) => c.id === "topics-covered").status, "pass");
});

test("no content is dropped when a short time target is set", async () => {
  const short = await build({ industry: "retail", features: ["create-agent", "agent-instructions", "publish-agent"], includeCore: false, targetMinutes: 5 });
  const none = await build({ industry: "retail", features: ["create-agent", "agent-instructions", "publish-agent"], includeCore: false });
  assert.equal((short.markdown.match(/^### Step /gm) || []).length, (none.markdown.match(/^### Step /gm) || []).length);
  assert.equal((short.markdown.match(/<summary>Knowledge check/g) || []).length, (none.markdown.match(/<summary>Knowledge check/g) || []).length);
});
