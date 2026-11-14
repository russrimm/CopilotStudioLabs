import assert from "node:assert/strict";
import { test } from "node:test";

import { extractClaims } from "../../../portal/lib/step-validator/claims.js";
import { buildEvidence, evaluateClaim } from "../../../portal/lib/step-validator/matcher.js";

const LEARN = "https://learn.microsoft.com/en-us/microsoft-copilot-studio/doc";
const evidence = (text, url = LEARN) => [buildEvidence({ url, title: "Doc", text, source: "page" })];

test("findPaths splits alternative navigation clauses instead of glueing across 'or go to'", () => {
  const step = {
    id: "step-1",
    title: "Step 1 — Open Registry",
    items: [
      {
        text: "Select **Explore All agents** > **Registry**, or go to **Agents** > **All Agents** > **Registry**.",
        line: 12,
        kind: "ordered",
      },
    ],
  };
  const paths = extractClaims(step)
    .claims.filter((c) => c.kind === "nav-path")
    .map((c) => c.term);
  assert.deepEqual(paths, [
    "Explore All agents > Registry",
    "Agents > All Agents > Registry",
  ]);
});

test("evaluateAvailability ignores '(preview)' inside unrelated inline links and after contrast phrases", () => {
  const claim = { kind: "availability", term: "Model selection", state: "ga" };
  const doc = evidence(
    "Primary model selection is separate from the settings for [deep reasoning (preview)](authoring-reasoning-models), [generative responses (preview)](nlu-preview-model), and [prompt builder models](prompt-model-settings).",
    "https://learn.microsoft.com/en-us/microsoft-copilot-studio/authoring-select-agent-model",
  );
  const res = evaluateClaim(claim, doc);
  assert.equal(res.rule, "no-support");
  assert.notEqual(res.status, "stale");

  // Positive control: direct subject preview link or prose still marks GA claim as stale.
  assert.equal(
    evaluateClaim(claim, evidence("Configure [Model selection (preview)](authoring-select-agent-model) in Settings.")).rule,
    "availability-changed",
  );
  assert.equal(
    evaluateClaim(claim, evidence("Model selection is in preview.")).rule,
    "availability-changed",
  );
});

test("findNameStale ignores generic 'Registry' and bare/child-record 'removed' while keeping real deprecations", () => {
  const registryDoc = evidence(
    [
      "Select Agents > All Agents > Registry to view agents.",
      "### Registry entry removed",
      "Triggered when an entry is deleted from the registry.",
    ].join("\n\n"),
    "https://learn.microsoft.com/en-us/microsoft-agent-365/builder/agent-registry",
  );
  const navClaim = {
    kind: "nav-path",
    term: "Agents > All Agents > Registry",
    segments: ["Agents", "All Agents", "Registry"],
  };
  assert.equal(evaluateClaim(navClaim, registryDoc).status, "verified");

  assert.equal(
    evaluateClaim(
      { kind: "ui-label", term: "Microsoft Copilot" },
      evidence("Open **Microsoft Copilot** readiness. Users who are assigned a Microsoft Copilot license are removed from consideration."),
    ).status,
    "verified",
  );
  assert.equal(
    evaluateClaim({ kind: "ui-label", term: "Classic chatbots" }, evidence("Classic chatbots are deprecated.")).rule,
    "deprecated",
  );
  assert.equal(
    evaluateClaim({ kind: "ui-label", term: "Legacy feature" }, evidence("Legacy feature has been removed.")).rule,
    "deprecated",
  );
});

test("findNameStale ignores product-prefix suffix renames and image alt captions", () => {
  const copilotDoc = evidence(
    [
      "Select Copilot in the left navigation.",
      "Microsoft 365 Copilot is now named Microsoft Copilot, and Microsoft 365 Copilot Chat is now named Microsoft Copilot Chat.",
    ].join("\n\n"),
  );
  assert.equal(evaluateClaim({ kind: "ui-label", term: "Copilot" }, copilotDoc).status, "verified");
  assert.equal(evaluateClaim({ kind: "term", term: "Microsoft 365 Copilot" }, copilotDoc).rule, "renamed");
  assert.equal(
    evaluateClaim(
      { kind: "ui-label", term: "Copilot" },
      evidence('Select **Copilot** in the menu. The metric previously known as "Copilot Chat (web)" is now **Copilot Chat (legacy web)**.'),
    ).status,
    "verified",
  );

  const approvalDoc = evidence(
    [
      "Select Approval in the flow designer.",
      "![Screenshot of the left pane in the flow designer with the approval renamed.](media/approval-renamed.png)",
    ].join("\n\n"),
  );
  assert.equal(evaluateClaim({ kind: "ui-label", term: "Approval" }, approvalDoc).status, "verified");
  assert.equal(
    evaluateClaim({ kind: "ui-label", term: "Power Virtual Agents" }, evidence("Power Virtual Agents was renamed to Copilot Studio.")).rule,
    "renamed",
  );
});
