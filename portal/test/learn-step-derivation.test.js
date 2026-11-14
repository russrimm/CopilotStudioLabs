import { test } from "node:test";
import assert from "node:assert/strict";

import { deriveSteps, extractProcedures, isVerifiedCanonicalArticle } from "../lib/lab-builder/steps.js";
import { BLOCKER_CODES, MAX_VERIFIED_CURATED_DAYS, isCuratedFresh } from "../lib/lab-builder/blockers.js";
import { generateLab } from "../lib/lab-builder/generator.js";

test("extractProcedures keeps ordered lists intact across unindented screenshots, callouts, blockquotes, and tables", () => {
  const md = [
    "# Create an autofill column in SharePoint",
    "",
    "## Create a new autofill column",
    "",
    "1. In a SharePoint document library, select **Add column**.",
    "",
    ":::image type=\"content\" source=\"media/add-column.png\" alt-text=\"Add column menu.\":::",
    "",
    "2. In the panel, enter a **Name** and select **Autofill**.",
    "",
    "> [!NOTE]",
    "> Autofill requires pay-as-you-go billing or SharePoint Advanced Management.",
    "",
    "3. Under **Prompt**, enter instructions telling SharePoint what information to extract.",
    "",
    "| Field | Example |",
    "|---|---|",
    "| Contract Date | Extract the effective date in YYYY-MM-DD format |",
    "",
    "4. Select **Test** on a sample file in the library, then select **Save**.",
  ].join("\n");

  const procedures = extractProcedures(md);
  assert.equal(procedures.length, 1);
  assert.equal(procedures[0].items.length, 4);
  assert.match(procedures[0].items[0][0], /\*\*Add column\*\*/);
  assert.match(procedures[0].items[3][0], /\*\*Save\*\*/);
});

test("deriveSteps prefers UI portal tabs over Python/CLI tabs and falls through to runner-up procedures when ranked[0] fails a gate", () => {
  const feature = {
    id: "fdy-deploy-test-model",
    name: "Deploy a model and test in playground",
    summary: "Deploy a foundation model in the Microsoft Foundry portal and validate prompts in the playground.",
    steps: [
      "Open Microsoft Foundry portal.",
      "Select Model catalog.",
      "Choose a model and select Deploy.",
      "Configure deployment name and quota.",
      "Select Deploy and open in Playground.",
      "Submit a test prompt and inspect the output.",
    ],
  };

  const md = [
    "# Deploy models in Microsoft Foundry",
    "",
    "## Deploy a model",
    "",
    "# [Python SDK](#tab/python)",
    "",
    "1. Install the `azure-ai-projects` package in your virtual environment.",
    "2. Authenticate with `DefaultAzureCredential()` in your script.",
    "3. Call `project_client.deployments.begin_create()` with your SKU.",
    "4. Print the response status from the terminal.",
    "",
    "# [Foundry portal](#tab/foundry-portal)",
    "",
    "1. Sign in to the **Microsoft Foundry** portal and open your project.",
    "2. In the left pane, select **Model catalog**, then choose the model you want to deploy.",
    "3. Select **Deploy**, confirm the **Deployment name** and tokens-per-minute quota, and select **Deploy**.",
    "4. When deployment succeeds, select **Open in playground** and submit a test prompt to verify responses.",
    "",
    "---",
  ].join("\n");

  const result = deriveSteps(md, feature, "https://learn.microsoft.com/en-us/azure/foundry/how-to/deploy-models-openai");
  assert.equal(result.ok, true, `expected ok=true, got reason=${result.reason}`);
  assert.equal(result.steps.length, 4, "4-step complete UI procedure passes scaled completeness against 6-step catalog");
  assert.match(result.steps[0], /\*\*Microsoft Foundry\*\*/);
  assert.doesNotMatch(result.steps.join(" "), /pip|DefaultAzureCredential/);
});

test("extractProcedures supports ### Step N headings and guarded UI action bullets while rejecting conceptual bullet lists", () => {
  const stepHeadingMd = [
    "# Configure license assignments",
    "",
    "## Assign Microsoft 365 Copilot licenses",
    "",
    "### Step 1: Open the Licenses page",
    "In the Microsoft 365 admin center, go to **Billing** > **Licenses**.",
    "",
    "### Step 2: Select Microsoft 365 Copilot",
    "Select **Microsoft 365 Copilot** from the product list.",
    "",
    "### Step 3: Assign users or groups",
    "Select **Assign licenses**, add your pilot security group, and select **Assign**.",
  ].join("\n");

  const fromHeadings = extractProcedures(stepHeadingMd);
  assert.equal(fromHeadings.length, 1);
  assert.equal(fromHeadings[0].kind, "step-headings");
  assert.equal(fromHeadings[0].items.length, 3);
  assert.match(fromHeadings[0].items[0][0], /\*\*Open the Licenses page\.\*\*/);

  const actionBulletsMd = [
    "# Configure agent availability",
    "",
    "## Configure agent access in the admin center",
    "",
    "- Sign in to the **Microsoft 365 admin center** as an AI Administrator.",
    "- Navigate to **Agents** > **All agents** in the left navigation.",
    "- Select the target agent from the inventory table.",
    "- Select **Manage availability**, choose the allowed security group, and select **Save**.",
    "",
    "## Key benefits of agent governance",
    "",
    "- **Visibility:** Administrators can see every agent in one inventory.",
    "- **Compliance:** Policies align with Microsoft Purview audit logs.",
    "- **Lifecycle:** Stale or ownerless agents can be blocked centrally.",
    "- **Adoption:** Usage metrics show active users per department.",
  ].join("\n");

  const fromBullets = extractProcedures(actionBulletsMd);
  assert.equal(fromBullets.length, 1, "only the UI action-bullet section is extracted; conceptual bullets are ignored");
  assert.equal(fromBullets[0].kind, "action-bullets");
  assert.equal(fromBullets[0].heading, "Configure agent access in the admin center");
});

test("live conceptual canonical Learn page with fresh curated steps (<= 180 days) completes cleanly with explicit provenance instead of steps-not-derived blocker", async () => {
  const conceptualArticle = [
    "# Choose between authoring harnesses in Microsoft Copilot Studio",
    "",
    "## Overview of Copilot Studio harnesses",
    "",
    "Microsoft Copilot Studio provides distinct authoring harnesses so makers can match orchestration, memory, skills, and channel behavior to their scenario.",
    "Choosing between the Standard harness and the Microsoft Copilot harness shapes how instructions, tools, and lifecycle hooks work across the agent.",
    "",
    "## Compare harness capabilities",
    "",
    "| Capability | Standard harness | Microsoft Copilot harness |",
    "|---|---|---|",
    "| Orchestration | Topics, triggers, and generative actions | Instructions, skills, and lifecycle hooks |",
    "| Memory | Conversation and custom variables | Built-in memory and workspace context |",
    "",
    "## When to choose each harness",
    "",
    "Select the harness before building production workflows so your team designs instructions, connectors, and governance controls for the right runtime.",
  ].join("\n");

  const mockConnect = async () => ({
    ok: true,
    endpoint: "https://learn.microsoft.com/api/mcp",
    call: async (toolName) => {
      if (toolName === "microsoft_docs_search") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify([
                {
                  title: "Choose between authoring harnesses in Microsoft Copilot Studio",
                  contentUrl: "https://learn.microsoft.com/en-us/microsoft-copilot-studio/authoring-harnesses",
                  content: "Compare authoring harnesses in Microsoft Copilot Studio.",
                },
              ]),
            },
          ],
        };
      }
      if (toolName === "microsoft_docs_fetch") {
        return { content: [{ type: "text", text: conceptualArticle }] };
      }
      return { content: [] };
    },
  });

  // Fresh curated steps (within 180 days of 2026-11-12): no blocker, explicit provenance!
  const freshNow = Date.parse("2026-12-15T00:00:00Z");
  const prevLinkCheck = process.env.LAB_BUILDER_LINK_CHECK;
  process.env.LAB_BUILDER_LINK_CHECK = "on";
  try {
    const cleanBuild = await generateLab(
      {
        products: ["copilot-studio"],
        harness: "microsoft-copilot",
        level: 100,
        features: ["mc-harness-choice"],
        industry: "healthcare",
        roles: ["it"],
      },
      {
        useLearnMcp: true,
        useLlm: false,
        write: false,
        now: freshNow,
        connect: mockConnect,
        checkLink: async (url) => ({ url, status: 200, ok: true }),
      },
    );

    assert.equal(cleanBuild.status, "complete");
    assert.deepEqual(cleanBuild.blockers, []);
    assert.equal(cleanBuild.manifest.grounding.verifiedCuratedModules, 1);
    assert.equal(cleanBuild.manifest.modules[0].steps.reason, "conceptual-page-curated");
    assert.equal(cleanBuild.manifest.modules[0].steps.canonicalVerified, true);
    assert.match(cleanBuild.markdown, /confirmed live on \d{4}-\d{2}-\d{2}/);
    assert.match(cleanBuild.markdown, /presents conceptual or reference guidance rather than a single numbered checklist/);

    // Genuine risk 1: curated steps stale (> 180 days) -> MUST raise steps-not-derived blocker!
    const staleNow = Date.parse("2027-08-01T00:00:00Z");
    assert.equal(isCuratedFresh({ lastVerified: "2026-11-12" }, staleNow), false);
    assert.equal(MAX_VERIFIED_CURATED_DAYS, 180);

    const staleBlocked = await generateLab(
      {
        products: ["copilot-studio"],
        harness: "microsoft-copilot",
        level: 100,
        features: ["mc-harness-choice"],
        industry: "healthcare",
        roles: ["it"],
      },
      {
        useLearnMcp: true,
        useLlm: false,
        write: false,
        now: staleNow,
        connect: mockConnect,
        checkLink: async (url) => ({ url, status: 200, ok: true }),
      },
    );
    assert.equal(staleBlocked.status, "blocked");
    assert.equal(staleBlocked.blockers[0].code, BLOCKER_CODES.STEPS_NOT_DERIVED);

    // Genuine risk 2: canonical verifiedAgainst URL returns HTTP 404 -> MUST raise steps-not-derived blocker!
    const deadCanonicalBlocked = await generateLab(
      {
        products: ["copilot-studio"],
        harness: "microsoft-copilot",
        level: 100,
        features: ["mc-harness-choice"],
        industry: "healthcare",
        roles: ["it"],
      },
      {
        useLearnMcp: true,
        useLlm: false,
        write: false,
        now: freshNow,
        connect: mockConnect,
        checkLink: async (url) => ({ url, status: 404, ok: false }),
      },
    );
    assert.equal(deadCanonicalBlocked.status, "blocked");
    assert.equal(deadCanonicalBlocked.blockers[0].code, BLOCKER_CODES.STEPS_NOT_DERIVED);
  } finally {
    process.env.LAB_BUILDER_LINK_CHECK = prevLinkCheck;
  }

  // Genuine risk 3: short stub or off-topic page is rejected by isVerifiedCanonicalArticle
  assert.equal(
    isVerifiedCanonicalArticle("# 404 Page not found\n\n## Missing\n\nSorry, the requested page was not found.", {
      name: "Choose a harness",
      summary: "Choose between authoring harnesses in Copilot Studio.",
    }),
    false,
  );
});
