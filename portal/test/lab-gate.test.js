import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanLabMarkdown, scanLabDirectory, summarizeGate, formatGateReport } from "../lib/lab-builder/lab-gate.js";
import { validateGeneratedLab } from "../lib/validator.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(9000, 7)]);

function module(label, title, { steps, check = "- [ ] The agent appears on the **Build** tab.", trouble, extra = "" }) {
  return `### ${label} - ${title}

*Level 100 · about 15 minutes*

**What you are doing.** Do the thing.

**Do this**

${steps}

**What you should see.** After the last numbered step:

- Expected outcome: it works.

**Check your work**

${check}

**Troubleshooting**

${trouble ?? "- **Printer is on fire.** Unplug it."}
${extra}
`;
}

function lab(modules, title = "Retail: Store Support Assistant") {
  return `# ${title}\n\n## Overview\n\nHello.\n\n## Step-by-Step\n\n${modules.join("\n")}\n## Validation / Success Criteria\n\n- done\n`;
}

const GOOD = module("Step 1", "Create an agent", {
  steps: "1. Select **Create**.\n2. Name it.",
  extra: "\n![The Build tab with the agent name](assets/build-tab.png)\n",
});

test("a clean generated lab reads as ready to teach", () => {
  const result = scanLabMarkdown(lab([GOOD]), { moduleIds: ["create-agent"] });
  assert.equal(result.grade, "ready");
  assert.equal(result.totals.gaps, 0);
  assert.match(result.summary, /Ready to teach/);
});

test("cut-off steps, fused sub-steps and words cut in half are gaps a learner would trip on", () => {
  const bad = module("Step 1", "Add knowledge", {
    steps: "1. Open the agent.\n2. You can: Drag files.; Search by name.; Pick a source such as **Public websites** or more...\n3. Select **Save**.",
    extra: "\n**In your scenario.** A child agent is a lightweight agent. This articl\u2026\n",
  });
  const result = scanLabMarkdown(lab([bad]), { moduleIds: ["x"] });
  const codes = result.findings.map((f) => f.code);
  assert.ok(codes.includes("cut-off-step"));
  assert.ok(codes.includes("fused-substeps"));
  assert.ok(codes.includes("cut-off-text"));
  assert.equal(result.grade, "not-ready");
  assert.equal(result.totals.cutOffSteps, 1);
});

test("a quiz whose correct answer is the Learn disclaimer is a gap and filler answers are polish", () => {
  const quiz = `
**Question 1.** Why configure **Add a child agent**?

- **A.** It bypasses environment permissions for Add a child agent.
- **B.** This topic was found on Microsoft Learn and is not yet part of this repository's reviewed catalog.

<details>
<summary>Knowledge check: Question 1 answer</summary>

**Correct answer: B.** This topic was found on Microsoft Learn and is not yet part of this repository's reviewed catalog.

</details>
`;
  const result = scanLabMarkdown(lab([module("Step 1", "Child agents", { steps: "1. Select **Add**.", extra: quiz })]), { moduleIds: ["x"] });
  const byCode = Object.fromEntries(result.findings.map((f) => [f.code, f.severity]));
  assert.equal(byCode["quiz-teaches-disclaimer"], "gap");
  assert.equal(byCode["quiz-filler-answers"], "polish");
});

test("a module with a placeholder-only check, generic troubleshooting, or no steps is reported", () => {
  const thin = module("Step 1", "Thin", {
    steps: "",
    check: "- [ ] [Unverified] You completed the procedure in the linked Microsoft Learn article and the result matches what the article describes.",
    trouble:
      "- **A step does not match your screen.** Compare with the Learn page.\n- **\"It works\" is not true yet.** Repeat the numbered steps.",
  });
  const codes = scanLabMarkdown(lab([thin]), { moduleIds: ["x"] }).findings.map((f) => f.code);
  assert.deepEqual(["no-steps", "generic-check", "generic-troubleshooting", "unverified"].filter((c) => !codes.includes(c)), []);
});

test("a module Learn says is for classic chatbots only is a gap in a harness lab, and a harness limit is only polish", () => {
  const classic = module("Step 1", "Use a classic chatbot as a skill", { steps: "1. Open the allow list.\n2. Add the bot.\n3. Save.", extra: "\n![The allow list](assets/allow.png)\n" }).replace("Do the thing.", "This article applies to classic chatbots only. This feature isn't available for Copilot Studio agents powered by the standard or Microsoft Copilot harness.");
  const found = scanLabMarkdown(lab([classic]), { moduleIds: ["learn-skill"], manifest: { request: { harness: "microsoft-copilot" }, modules: [{ id: "learn-skill" }] } });
  assert.ok(found.findings.some((f) => f.code === "topic-not-for-harness" && f.severity === "gap"));
  const limited = module("Step 1", "Share a tool", { steps: "1. Open it.\n2. Share it.\n3. Save.", extra: "\n![The tool](assets/tool.png)\n" }).replace("Do the thing.", "This feature isn't available for agents in the Microsoft Copilot harness.");
  const poly = scanLabMarkdown(lab([limited]), { moduleIds: ["x"], manifest: { request: { harness: "microsoft-copilot" }, modules: [{ id: "x" }] } });
  assert.ok(poly.findings.some((f) => f.code === "topic-harness-limit" && f.severity === "polish"));
  assert.ok(!poly.findings.some((f) => f.code === "topic-not-for-harness"));
  const standard = scanLabMarkdown(lab([limited]), { moduleIds: ["x"], manifest: { request: { harness: "standard" }, modules: [{ id: "x" }] } });
  assert.ok(!standard.findings.some((f) => /^topic-/.test(f.code)), "a limit on another harness is not reported");
});

test("Microsoft Copilot harness modules are checked for wording the product no longer uses", () => {
  const stale = module("Step 1", "Instructions", { steps: "1. Open the **Overview page** and select **Edit**." });
  const mc = scanLabMarkdown(lab([stale]), { moduleIds: ["mc-instructions"] });
  assert.ok(mc.findings.some((f) => f.code === "stale-ui-wording"));
  const standard = scanLabMarkdown(lab([stale]), { moduleIds: ["create-agent"] });
  assert.ok(!standard.findings.some((f) => f.code === "stale-ui-wording"));
});

test("pictures count as pending until a real screenshot is in the lab or the shared library", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lab-gate-"));
  const shared = path.join(root, "shared");
  fs.mkdirSync(shared);
  const labDir = path.join(root, "lab");
  fs.mkdirSync(path.join(labDir, "assets"), { recursive: true });
  const body = lab([
    module("Step 1", "Pictures", {
      steps: "1. Select **Create**.",
      extra: "\n![The Build tab](assets/build-tab.png)\n\n![The Preview tab](assets/preview-tab.png)\n",
    }),
  ]);
  fs.writeFileSync(path.join(labDir, "index.md"), body);
  fs.writeFileSync(path.join(labDir, "assets", "build-tab.png"), Buffer.alloc(600, 1));
  fs.writeFileSync(path.join(labDir, "assets", "preview-tab.png"), Buffer.alloc(600, 1));
  fs.writeFileSync(path.join(shared, "preview-tab.png"), PNG);
  const result = scanLabMarkdown(body, { labDir, capturedDir: shared });
  assert.equal(result.totals.pictures, 2);
  assert.equal(result.totals.pendingPictures, 1);
  assert.equal(result.grade, "almost");
  assert.deepEqual(summarizeGate(result), { version: 1, grade: "almost", gaps: 0, polish: 1, notes: 0, pendingPictures: 1 });
  fs.rmSync(root, { recursive: true, force: true });
});

test("a hand-written lab is scanned without the generated-lab section rules", () => {
  const result = scanLabMarkdown("# Lab 02\n\n## Step-by-Step\n\n### Step 1 \u2014 Explore\n\n1. Open **Topics**.\n2. Select **Add**.\n");
  assert.equal(result.kind, "handwritten");
  assert.equal(result.totals.gaps, 0);
  assert.equal(result.totals.steps, 2);
});

test("a very long title is polish and the plain-text report lists what to fix first", () => {
  const long = "Retail: Build a Store Support Assistant with " + "Create an agent (Microsoft Copilot harness) and ".repeat(4);
  const result = scanLabMarkdown(lab([GOOD], long), { moduleIds: ["x"] });
  assert.ok(result.findings.some((f) => f.code === "long-title"));
  assert.match(formatGateReport({ ...result, lab: "demo" }), /POLISH\s+The title is \d+ characters long/);
});

test("the validate route returns the lab health with the structural report", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lab-gate-validate-"));
  const dir = path.join(root, "demo-lab");
  fs.mkdirSync(dir);
  fs.mkdirSync(path.join(dir, "assets"));
  fs.writeFileSync(path.join(dir, "assets", "build-tab.png"), PNG);
  fs.writeFileSync(path.join(dir, "index.md"), lab([GOOD]));
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ title: "Demo", modules: [{ id: "create-agent" }] }));
  const { status, body } = validateGeneratedLab(root, "demo-lab");
  assert.equal(status, 200);
  assert.equal(body.health.grade, "ready");
  assert.equal(scanLabDirectory(dir).lab, "demo-lab");
  fs.rmSync(root, { recursive: true, force: true });
});

test("a Recap module is a short refresher and is not asked for a check, quiz, or troubleshooting", () => {
  const recap = `### Recap 1 - Create an agent\n\n**What you are doing.** Refresh the basics.\n\n1. Select **Create**.\n2. Name it.\n`;
  const result = scanLabMarkdown(`# Lab\n\n## Step-by-Step\n\n${recap}\n${GOOD}`, { moduleIds: ["create-agent", "create-agent"] });
  assert.deepEqual(result.findings.filter((f) => f.module === "Recap 1"), []);
});

test("a connector's internal name in the text is a gap, an unresolved one is polish, and display names and code are fine", () => {
  const withSteps = (steps, extra = "") => lab([module("Step 1", "Add a tool", { steps, extra: `${extra}\n![The Tools page](assets/tools.png)\n` })]);
  const clean = scanLabMarkdown(withSteps("1. Select **HTTP with Microsoft Entra ID (preauthorized)**.\n2. Select **Add**."), { moduleIds: ["connector-tools"] });
  assert.deepEqual(clean.findings.filter((f) => f.code.startsWith("connector-")), []);

  const leaked = scanLabMarkdown(withSteps("1. Select `shared_webcontents`.\n2. Select **Add**."), { moduleIds: ["connector-tools"] });
  const gap = leaked.findings.find((f) => f.code === "connector-id");
  assert.equal(gap?.severity, "gap");
  assert.match(gap.message, /shared_webcontents/);
  assert.equal(leaked.grade, "needs-work");

  const unresolved = scanLabMarkdown(withSteps("1. Select a connector (shared_contoso_crm).\n2. Select **Add**."), { moduleIds: ["connector-tools"] });
  const polish = unresolved.findings.find((f) => f.code === "connector-unresolved");
  assert.equal(polish?.severity, "polish");
  assert.match(polish.message, /shared_contoso_crm/);
  assert.equal(unresolved.findings.some((f) => f.code === "connector-id"), false);

  const literal = withSteps("1. Select **Add**.\n2. Open the address `.../connections/shared_teams/{id}/details`.", '\n```json\n{ "connectorId": "shared_webcontents" }\n```\n');
  assert.deepEqual(scanLabMarkdown(literal, { moduleIds: ["connector-tools"] }).findings.filter((f) => f.code.startsWith("connector-")), [], "fenced code and literal addresses may keep the internal name");
});
