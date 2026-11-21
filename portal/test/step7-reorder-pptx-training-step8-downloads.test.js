import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import vm from "node:vm";

import { planLab } from "../lib/lab-builder/planner.js";
import { generateLab } from "../lib/lab-builder/generator.js";
import { listGeneratedLabs, readGeneratedLab } from "../lib/lab-builder/generated-labs.js";
import { resolveTopicTrainingDigest } from "../lib/lab-builder/topic-training.js";
import {
  parseTopicMarkdownStructure,
  renderTopicToPptxBuffer,
} from "../lib/lab-builder/pptx-builder.js";

process.env.LAB_BUILDER_LINK_CHECK = "off";
process.env.LAB_BUILDER_VENDOR_DOCS = "off";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");

function tempDir(prefix = "step7-pptx-step8-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on("error", reject);
  });
}

async function startPortalServer(generatedLabsDir) {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.js"], {
    cwd: join(__dirname, ".."),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      PORTAL_AUTH_DISABLED: "true",
      AZURE_KEYVAULT_URL: "",
      LAB_BUILDER_OUTPUT_DIR: generatedLabsDir,
      LAB_BUILDER_LINK_CHECK: "off",
      LAB_BUILDER_VENDOR_DOCS: "off",
    },
    stdio: "ignore",
  });

  const startedAt = Date.now();
  while (Date.now() - startedAt < 15000) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${child.exitCode}`);
    try {
      const res = await fetch(`${baseUrl}/api/config`);
      if (res.ok) break;
    } catch {
      // Wait until Express is listening.
    }
    await new Promise((r) => setTimeout(r, 120));
  }

  return {
    baseUrl,
    stop: () =>
      new Promise((resolve) => {
        if (child.killed || child.exitCode !== null) return resolve();
        child.once("exit", () => resolve());
        child.kill();
      }),
  };
}

function parseZipArchive(buffer) {
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  assert.notEqual(eocdOffset, -1, "Expected valid ZIP EOCD signature");
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const cdOffset = buffer.readUInt32LE(eocdOffset + 16);

  const files = new Map();
  let offset = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50, "Expected Central Directory header");
    const method = buffer.readUInt16LE(offset + 10);
    const compSize = buffer.readUInt32LE(offset + 20);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLen).toString("utf8");

    assert.equal(buffer.readUInt32LE(localHeaderOffset), 0x04034b50, `Expected Local File header for ${name}`);
    const localNameLen = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localHeaderOffset + 28);
    const flag = buffer.readUInt16LE(localHeaderOffset + 6);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const actualCompSize = (flag & 0x08) !== 0 ? compSize : buffer.readUInt32LE(localHeaderOffset + 18) || compSize;
    const rawSlice = buffer.subarray(dataStart, dataStart + actualCompSize);
    const content = method === 8 ? inflateRawSync(rawSlice) : method === 0 ? Buffer.from(rawSlice) : null;
    assert.ok(content !== null, `Unsupported ZIP compression method ${method} on ${name}`);
    files.set(name, content);

    offset += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

function assertWellFormedXml(xmlText, entryName) {
  assert.match(xmlText, /^<\?xml version="1\.0" encoding="UTF-8"/, `${entryName} must start with XML declaration`);
  const stripped = xmlText
    .replace(/^<\?xml[^>]*\?>\s*/, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  const badAmp = stripped.match(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/);
  assert.equal(badAmp, null, `${entryName} contains unescaped '&': ${badAmp?.[0]}`);

  const stack = [];
  const tagRegex = /<\/?([A-Za-z_][\w:.-]*)(\s[^<>]*?)?(\/?)>/g;
  let match;
  while ((match = tagRegex.exec(stripped)) !== null) {
    const full = match[0];
    const tagName = match[1];
    const selfClosing = match[3] === "/";
    if (full.startsWith("</")) {
      const top = stack.pop();
      assert.equal(top, tagName, `${entryName}: closing </${tagName}> did not match open <${top}>`);
    } else if (!selfClosing) {
      stack.push(tagName);
    }
  }
  assert.deepEqual(stack, [], `${entryName}: unclosed XML tags remaining: ${stack.join(", ")}`);
}

// ── 1. Review and build: backend module reordering ──────────────────────────

test("Review and build moduleOrder reorders modules, renumbers steps/recaps, persists selections, and warns on prerequisite inversion", async () => {
  const { dir, cleanup } = tempDir("step7-reorder-backend-");
  try {
    const baseReq = {
      title: "Custom Order Retail Lab",
      products: ["copilot-studio"],
      industry: "retail",
      levels: [100, 200],
      harness: "standard",
      features: ["create-agent", "knowledge-sharepoint", "agent-instructions"],
      includeCore: false,
    };

    const defaultPlan = planLab(baseReq);
    assert.deepEqual(
      defaultPlan.features.map((m) => m.id),
      ["create-agent", "agent-instructions", "knowledge-sharepoint"],
    );
    assert.equal(defaultPlan.warnings.length, 0);

    // Move "knowledge-sharepoint" and "agent-instructions" ahead of prerequisite "create-agent",
    // and include an unknown/excluded stale ID to verify graceful filtering.
    const customOrder = ["knowledge-sharepoint", "stale-unknown-topic", "agent-instructions", "create-agent"];
    const reorderedPlan = planLab({ ...baseReq, moduleOrder: customOrder });

    assert.deepEqual(
      reorderedPlan.features.map((m) => m.id),
      ["knowledge-sharepoint", "agent-instructions", "create-agent"],
    );
    assert.deepEqual(
      reorderedPlan.features.map((m) => m.order),
      [1, 2, 3],
    );
    assert.deepEqual(
      reorderedPlan.features.map((m) => m.stepLabel),
      ["Step 1", "Step 2", "Step 3"],
    );
    assert.deepEqual(
      reorderedPlan.request.moduleOrder,
      ["knowledge-sharepoint", "agent-instructions", "create-agent"],
    );
    assert.ok(
      reorderedPlan.warnings.some((w) => /places ".*" before its prerequisite "Create an agent"/i.test(w)),
      `Expected prerequisite order warning in: ${JSON.stringify(reorderedPlan.warnings)}`,
    );

    // Also verify mixed Step + Recap renumbering when Level 200 brings in Level 100 prerequisites as Recaps
    const recapPlan = planLab({
      title: "Recap Order Check",
      products: ["copilot-studio"],
      industry: "retail",
      level: 200,
      harness: "standard",
      features: ["generative-orchestration"],
      includeCore: true,
      moduleOrder: ["generative-orchestration", "create-agent"],
    });
    const goIndex = recapPlan.features.findIndex((m) => m.id === "generative-orchestration");
    const caIndex = recapPlan.features.findIndex((m) => m.id === "create-agent");
    assert.ok(goIndex !== -1 && caIndex !== -1, "Expected both generative-orchestration and create-agent in recapPlan");
    assert.ok(goIndex < caIndex, "Expected custom moduleOrder to place generative-orchestration before create-agent");
    assert.equal(recapPlan.features[goIndex].stepLabel, "Step 1");
    assert.match(recapPlan.features[caIndex].stepLabel, /^Recap \d+$/);

    // Generate full lab and verify Markdown order, topicDocuments numbering, manifest, and savedSelections
    const generated = await generateLab(
      { ...baseReq, moduleOrder: ["knowledge-sharepoint", "agent-instructions", "create-agent"] },
      { outputRoot: dir, useLearnMcp: false, useLlm: false },
    );

    const stepHeadings = [...generated.markdown.matchAll(/^### (Step \d+\s*-\s*.+)$/gm)].map((m) => m[1]);
    assert.equal(stepHeadings.length, 3);
    assert.match(stepHeadings[0], /^Step 1\s*-\s*.*SharePoint/i);
    assert.match(stepHeadings[1], /^Step 2\s*-\s*.*instruction/i);
    assert.match(stepHeadings[2], /^Step 3\s*-\s*.*Create an agent/i);

    assert.deepEqual(
      generated.topicDocuments.map((d) => `${d.order}:${d.id}:${d.stepLabel}`),
      [
        "1:knowledge-sharepoint:Step 1",
        "2:agent-instructions:Step 2",
        "3:create-agent:Step 3",
      ],
    );
    assert.match(generated.topicDocuments[0].pptxFileName, /Step 01/);
    assert.match(generated.topicDocuments[1].pptxFileName, /Step 02/);
    assert.match(generated.topicDocuments[2].pptxFileName, /Step 03/);

    assert.deepEqual(generated.manifest.request.moduleOrder, [
      "knowledge-sharepoint",
      "agent-instructions",
      "create-agent",
    ]);

    const loaded = readGeneratedLab(dir, generated.labId);
    assert.equal(loaded.status, 200);
    assert.deepEqual(loaded.body.selections.moduleOrder, [
      "knowledge-sharepoint",
      "agent-instructions",
      "create-agent",
    ]);

    const listed = listGeneratedLabs(dir).labs;
    assert.equal(listed.length, 1);
    assert.deepEqual(listed[0].selections.moduleOrder, [
      "knowledge-sharepoint",
      "agent-instructions",
      "create-agent",
    ]);
  } finally {
    cleanup();
  }
});

// ── 2. Review and build: UI controls, persistence & keyboard focus ──────────

test("Review and build wizard hides Move up/down controls until Edit order is on, then renders them accessibly, disables boundaries, persists moduleOrder, and restores focus", async () => {
  const wizardSource = readFileSync(join(PUBLIC_DIR, "lab-builder-wizard.js"), "utf8");
  const storage = new Map();
  let focusedSelector = null;
  let lastPreviewBody = null;

  function makeElement(id = "") {
    return {
      id,
      innerHTML: "",
      textContent: "",
      value: "",
      hidden: false,
      disabled: false,
      checked: false,
      style: {},
      dataset: {},
      classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
      setAttribute() {},
      removeAttribute() {},
      addEventListener() {},
      contains: () => false,
      closest: () => null,
      focus() {},
      querySelector(sel) {
        const moveMatch = sel.match(
          /button\[data-outline-module="([^"]+)"\]\[data-outline-move="([^"]+)"\](:not\(:disabled\))?/,
        );
        if (moveMatch) {
          const [, modId, dir, requireEnabled] = moveMatch;
          const btnRegex = new RegExp(
            `<button[^>]*data-outline-move="${dir}"[^>]*data-outline-module="${modId}"[^>]*>|<button[^>]*data-outline-module="${modId}"[^>]*data-outline-move="${dir}"[^>]*>`,
          );
          const tag = this.innerHTML.match(btnRegex)?.[0];
          if (!tag) return null;
          const isDisabled = /\bdisabled\b/.test(tag);
          if (requireEnabled && isDisabled) return null;
          return {
            disabled: isDisabled,
            focus() {
              focusedSelector = `${modId}:${dir}`;
            },
          };
        }
        return null;
      },
      querySelectorAll: () => [],
    };
  }

  const elements = new Map([
    ["lb-preview", makeElement("lb-preview")],
    ["lb-custom-title", makeElement("lb-custom-title")],
    ["lb-org-name", makeElement("lb-org-name")],
    ["lb-agent-name", makeElement("lb-agent-name")],
    ["lb-primary-domain", makeElement("lb-primary-domain")],
    ["lb-user-prompt", makeElement("lb-user-prompt")],
    ["lb-sharepoint-site-name", makeElement("lb-sharepoint-site-name")],
    ["lb-sharepoint-site-url", makeElement("lb-sharepoint-site-url")],
  ]);

  const baseModules = [
    { id: "create-agent", name: "Create an agent", role: "level", level: 100, minutes: 10, product: "copilot-studio" },
    { id: "knowledge-sharepoint", name: "Ground on SharePoint", role: "level", level: 200, minutes: 15, product: "copilot-studio" },
    { id: "agent-instructions", name: "Agent instructions", role: "level", level: 100, minutes: 15, product: "copilot-studio" },
  ];

  const context = {
    console,
    setTimeout,
    clearTimeout,
    toast: () => {},
    CSS: { escape: (s) => String(s) },
    escapeHtml: (s) =>
      String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]),
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    document: {
      getElementById: (id) => {
        if (!elements.has(id)) elements.set(id, makeElement(id));
        return elements.get(id);
      },
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    fetch: async (url, init) => {
      if (String(url).includes("/api/lab-builder/recommend")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            selectedIds: baseModules.map((m) => m.id),
            recommendedIds: baseModules.map((m) => m.id),
            preselectedIds: baseModules.map((m) => m.id),
            concepts: [],
            answers: { level: 200 },
            totals: { selectedCount: baseModules.length, prerequisiteCount: 0, duration: "40 minutes" },
            prerequisites: { topics: [], selectedCount: 0, minutes: 0 },
            levelUnknown: { topics: [], selectedCount: 0 },
            filter: { droppedSelections: [] },
          }),
        };
      }
      const reqBody = JSON.parse(init?.body || "{}");
      lastPreviewBody = reqBody;
      let ordered = [...baseModules];
      if (Array.isArray(reqBody.moduleOrder) && reqBody.moduleOrder.length) {
        const byId = new Map(ordered.map((m) => [m.id, m]));
        ordered = reqBody.moduleOrder.map((id) => byId.get(id)).filter(Boolean);
      }
      const modules = ordered.map((m, i) => ({
        ...m,
        order: i + 1,
        stepOrder: i + 1,
        stepLabel: `Step ${i + 1}`,
      }));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          title: "Workshop Preview",
          difficulty: "Intermediate",
          level: 200,
          duration: "40 minutes",
          totalMinutes: 40,
          agentName: "Store Operations Copilot",
          includeKnowledgeCheck: true,
          scenario: {
            org: "Contoso Retail",
            problem: "Help retail store associates answer policy questions accurately.",
          },
          prerequisites: [],
          warnings: [],
          decisions: [],
          moduleOrder: reqBody.moduleOrder || [],
          modules,
        }),
      };
    },
  };

  vm.createContext(context);
  vm.runInContext(
    `${wizardSource}
    globalThis.__wizard = {
      labBuilder,
      LB_STEP,
      lbPreview,
      lbMoveOutlineModule,
      lbResetModuleOrder,
      lbSaveSelections,
      lbLoadSelections,
      lbResetAnswers,
      lbRequest,
    };`,
    context,
  );

  const wiz = context.__wizard;
  wiz.labBuilder.loaded = true;
  wiz.labBuilder.products = [{ id: "copilot-studio", name: "Copilot Studio", shortName: "Copilot Studio", hasHarnesses: true }];
  wiz.labBuilder.harnesses = [{ id: "standard", name: "Standard harness" }];
  wiz.labBuilder.levels = [{ id: 100, name: "Beginner" }, { id: 200, name: "Intermediate" }];
  wiz.labBuilder.features = [...baseModules];
  wiz.labBuilder.selectedProducts = new Set(["copilot-studio"]);
  wiz.labBuilder.level = 200;
  wiz.labBuilder.harness = "standard";
  wiz.labBuilder.step = wiz.LB_STEP.review;
  wiz.labBuilder.picked = new Set(baseModules.map((m) => m.id));
  wiz.labBuilder.rec = { selectedIds: baseModules.map((m) => m.id), concepts: [] };

  await wiz.lbPreview();
  const defaultHtml = elements.get("lb-preview").innerHTML;

  // The rows stay quiet until Edit order is on: no Move up / Move down controls yet.
  assert.equal(wiz.labBuilder.editOrder, false);
  assert.doesNotMatch(defaultHtml, /data-outline-move|lb-outline-order-controls|aria-label="Move /);
  assert.match(defaultHtml, /data-outline-action="toggle-edit" aria-expanded="false">Edit order<\/button>/);

  wiz.labBuilder.editOrder = true;
  await wiz.lbPreview();
  const initialHtml = elements.get("lb-preview").innerHTML;

  // Verify accessible Move up / Move down buttons and disabled boundary states
  assert.match(initialHtml, /data-outline-action="toggle-edit" aria-expanded="true">Done<\/button>/);
  assert.match(initialHtml, /aria-label="Move Create an agent up"[^>]*disabled/);
  assert.doesNotMatch(
    initialHtml.match(/<button[^>]*aria-label="Move Create an agent down"[^>]*>/)?.[0] || "",
    /\bdisabled\b/,
  );
  assert.match(initialHtml, /aria-label="Move Agent instructions down"[^>]*disabled/);
  assert.doesNotMatch(initialHtml, /data-outline-action="reset-order"/);

  // Move middle topic ("knowledge-sharepoint") up to row 0 -> "up" hits top boundary so focus falls back to "down"!
  await wiz.lbMoveOutlineModule("knowledge-sharepoint", "up");

  assert.deepEqual(Array.from(wiz.labBuilder.moduleOrder), [
    "knowledge-sharepoint",
    "create-agent",
    "agent-instructions",
  ]);
  assert.deepEqual(Array.from(lastPreviewBody.moduleOrder), [
    "knowledge-sharepoint",
    "create-agent",
    "agent-instructions",
  ]);
  assert.equal(focusedSelector, "knowledge-sharepoint:down");

  const reorderedHtml = elements.get("lb-preview").innerHTML;
  assert.match(reorderedHtml, /data-outline-action="reset-order"/);
  assert.match(reorderedHtml, /Reset default order/);

  // Verify lbSaveSelections / lbResetAnswers / lbLoadSelections round-trips moduleOrder
  const savedSnapshot = wiz.lbSaveSelections();
  assert.deepEqual(Array.from(savedSnapshot.moduleOrder), [
    "knowledge-sharepoint",
    "create-agent",
    "agent-instructions",
  ]);

  // Reset default order clears moduleOrder and removes Reset button
  await wiz.lbResetModuleOrder();
  assert.deepEqual(Array.from(wiz.labBuilder.moduleOrder), []);
  assert.equal(wiz.lbRequest().moduleOrder, undefined);
  assert.doesNotMatch(elements.get("lb-preview").innerHTML, /data-outline-action="reset-order"/);

  // Restoring saved selections brings back custom moduleOrder
  await wiz.lbLoadSelections({ labId: "saved-lab", title: "Saved Lab", selections: savedSnapshot });
  await new Promise((r) => setTimeout(r, 25));
  assert.deepEqual(Array.from(wiz.labBuilder.moduleOrder), [
    "knowledge-sharepoint",
    "create-agent",
    "agent-instructions",
  ]);
  await wiz.lbResetAnswers();
  await new Promise((r) => setTimeout(r, 25));
  assert.deepEqual(Array.from(wiz.labBuilder.moduleOrder), []);
});

// ── 3. Substantive Topic Training PowerPoint (.pptx) Slides ─────────────────

test("PowerPoint topic deck generates rich, multi-slide training content with ECMA-376 valid XML and clickable Learn links", () => {
  const sampleTopicMarkdown = `## Step 1: Ground on SharePoint Online

> **Level 200 · ~20 minutes** · Grounded on [Add SharePoint as a knowledge source](https://learn.microsoft.com/en-us/microsoft-copilot-studio/knowledge-add-sharepoint)

### Why this matters

Grounding your agent on SharePoint Online lets employees ask natural-language questions over governed intranet sites and document libraries while enforcing each user's Microsoft Entra ID permissions at query time.

### Key concepts

- **Delegated user identity** — Copilot Studio queries Microsoft Graph using the signed-in user's identity so restricted files never leak across departments.
- **Semantic indexing and citations** — Responses include inline SharePoint document citations so business users can verify every claim.

### In your scenario

Configure Contoso Retail's Store Operations agent to answer store return policy and merchandising questions directly from the Store Operations SharePoint site.

### Walkthrough

1. Open **Copilot Studio** and select **Knowledge** -> **+ Add knowledge**.
2. Choose **SharePoint** and paste \`https://contoso.sharepoint.com/sites/StoreOperations\`.
   > **Expected:** The SharePoint site appears in your Knowledge list with status **Ready**.
3. Open the **Test your agent** pane and ask a policy question to verify inline citations.

### Prompt to try

\`\`\`text
What is our store manager approval threshold for cash refunds without a receipt, and which policy document defines it?
\`\`\`

### Check your work

- [ ] SharePoint knowledge source status shows **Ready**
- [ ] Test pane response includes a clickable citation to the SharePoint policy document

### Troubleshooting

- **Agent returns no SharePoint results:** Confirm the signed-in test user has at least Read permission on the SharePoint library and that the URL has no query string.

### Knowledge check

**Question:** Which identity does Copilot Studio use by default when querying a SharePoint knowledge source?

- A) Anonymous public guest access
- B) The signed-in end user's Microsoft Entra ID identity (Correct)
- C) An unauthenticated webhook

> **Answer:** B — Delegated Microsoft Entra ID authentication preserves per-user document ACLs.

### References

- [Add SharePoint as a knowledge source](https://learn.microsoft.com/en-us/microsoft-copilot-studio/knowledge-add-sharepoint)
`;

  const parsedTopic = parseTopicMarkdownStructure(sampleTopicMarkdown, {
    labTitle: "Contoso Retail Knowledge Workshop",
    stepLabel: "Step 1",
    topicTitle: "Ground on SharePoint Online",
  });
  const digest = resolveTopicTrainingDigest(parsedTopic, {
    featureId: "knowledge-sharepoint",
    harness: "standard",
  });
  assert.ok(digest, "Expected topic training digest for knowledge-sharepoint");
  assert.ok(digest.learningObjectives.length >= 3, "Expected >= 3 learning objectives");
  assert.ok(digest.architectureFlow.length >= 3, "Expected >= 3 runtime architecture steps");
  assert.deepEqual(digest.governanceRows, [], "administrator settings are never part of a learner deck");
  assert.doesNotMatch(digest.availabilityGuidance, /DLP|RBAC|polic/i, "availability wording lists no administrator settings");

  const pptxBuffer = renderTopicToPptxBuffer(sampleTopicMarkdown, {
    labTitle: "Contoso Retail Knowledge Workshop",
    stepLabel: "Step 1",
    topicTitle: "Ground on SharePoint Online",
    featureId: "knowledge-sharepoint",
    harness: "standard",
    trainingDigest: digest,
  });

  assert.equal(pptxBuffer.subarray(0, 2).toString("ascii"), "PK");
  const archive = parseZipArchive(pptxBuffer);

  // Every XML & .rels entry must be 100% well-formed XML
  for (const [entryName, rawBuf] of archive.entries()) {
    if (entryName.endsWith(".xml") || entryName.endsWith(".rels")) {
      assertWellFormedXml(rawBuf.toString("utf8"), entryName);
    }
  }

  const slideNames = [...archive.keys()]
    .filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));

  assert.ok(
    slideNames.length >= 8,
    `Expected a substantive >= 8-slide training deck per topic, got ${slideNames.length} slides`,
  );

  const allSlideXml = slideNames.map((n) => archive.get(n).toString("utf8")).join("\n");
  const allSlideRelsXml = [...archive.keys()]
    .filter((k) => /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/.test(k))
    .map((n) => archive.get(n).toString("utf8"))
    .join("\n");

  // Verify rich training sections are present on slides
  assert.match(allSlideXml, /Learning Objectives/);
  assert.match(allSlideXml, /Core Concepts/);
  assert.match(allSlideXml, /Runtime Execution Lifecycle/);
  assert.match(allSlideXml, /When to Use It &amp; Design Best Practices|Implementation Best Practices/);
  assert.match(allSlideXml, /Availability &amp; Cautions/);
  assert.doesNotMatch(allSlideXml, /Admin Prerequisites|DLP &amp; Guardrails|Additional Admin/, "the administrator's settings are in the Administrator setup guide, not in the learner deck");
  assert.match(allSlideXml, /Prompt to try|Configuration Summary/);
  assert.match(allSlideXml, /HANDS-ON WALKTHROUGH|Step-by-Step Instructions/);
  assert.match(allSlideXml, /VERIFICATION &amp; TROUBLESHOOTING|Check Your Work &amp; Troubleshooting/);
  assert.match(allSlideXml, /Knowledge Check/);
  assert.match(allSlideXml, /Microsoft Learn References/);
  assert.match(allSlideXml, /<a:tbl>/, "Expected native OOXML tables for governance/comparisons");
  assert.match(allSlideXml, /<a:hlinkClick r:id="rId\d+"/, "Expected clickable OOXML hyperlinks");
  assert.match(
    allSlideRelsXml,
    /Target="https:\/\/learn\.microsoft\.com\/[^"]+" TargetMode="External"/,
    "Expected external hyperlink relationship to learn.microsoft.com",
  );
});

// ── 4. Lab result: clean lab title + associated file download links (E2E + UI) ──

test("the lab result UI shows Lab Title and clean associated file download links without raw filenames or host paths, and server exports all formats cleanly", async () => {
  const { dir, cleanup } = tempDir("step8-downloads-e2e-");
  let server = null;
  try {
    const generated = await generateLab(
      {
        title: "Contoso Executive Copilot Workshop",
        products: ["copilot-studio"],
        industry: "financial-services",
        levels: [100, 200],
        harness: "standard",
        features: ["create-agent", "knowledge-sharepoint"],
        includeCore: false,
      },
      { outputRoot: dir, useLearnMcp: false, useLlm: false },
    );

    // 4a. Inspect the lab result UI rendering in generated-labs.js + app.js
    const generatedLabsSource = readFileSync(join(PUBLIC_DIR, "generated-labs.js"), "utf8");
    const appSource = readFileSync(join(PUBLIC_DIR, "app.js"), "utf8");

    assert.doesNotMatch(appSource, /Saved to <code>generated-labs\//);
    assert.doesNotMatch(generatedLabsSource, /Saved to <code>generated-labs\//);
    assert.doesNotMatch(generatedLabsSource, /lb-topic-doc-files/);

    const uiContext = {
      console,
      CSS: { escape: (s) => String(s) },
      labBuilder: { industries: [], levels: [], harnesses: [], products: [], editing: null },
      escapeHtml: (s) =>
        String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]),
      lbFormatMinutes: (m) => `${m} min`,
      document: { getElementById: () => null, querySelector: () => null },
    };
    vm.createContext(uiContext);
    vm.runInContext(
      `${generatedLabsSource}
      globalThis.__step8Ui = {
        lbGeneratedActionButtonsHtml,
        lbRenderTopicDocumentsHtml,
        lbGenItemHtml,
      };`,
      uiContext,
    );

    const labTitle = generated.manifest.title;
    assert.equal(labTitle, "Contoso Executive Copilot Workshop");

    const actionsHtml = uiContext.__step8Ui.lbGeneratedActionButtonsHtml(
      generated.labId,
      labTitle,
    );
    const actionsVisibleText = actionsHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

    assert.match(actionsHtml, /Download Lab Files/);
    assert.match(actionsHtml, /Interactive Web Lab \(\.html\)/);
    assert.match(actionsHtml, /Word Guide \(\.docx\)/);
    assert.match(actionsHtml, /PowerPoint Deck \(\.pptx\)/);
    assert.match(actionsHtml, /PDF Guide \(\.pdf\)/);
    assert.match(actionsHtml, /Markdown \(\.md\)/);
    assert.match(actionsHtml, /Complete Lab Package \(\.zip\)/);
    assert.match(actionsHtml, /export\?format=docx/);
    assert.match(actionsHtml, /export\?format=pptx/);
    assert.match(actionsHtml, /export\?format=pdf/);
    assert.match(actionsHtml, /export\?format=html/);
    assert.match(actionsHtml, /export\?format=md/);
    assert.match(actionsHtml, /download="Contoso Executive Copilot Workshop\.docx"/);
    assert.match(actionsHtml, /download="Contoso Executive Copilot Workshop\.pptx"/);
    assert.doesNotMatch(actionsVisibleText, new RegExp(generated.labId));
    assert.doesNotMatch(actionsVisibleText, /Contoso Executive Copilot Workshop\.docx/);

    const topicDocsHtml = uiContext.__step8Ui.lbRenderTopicDocumentsHtml(
      generated.labId,
      generated.topicDocuments,
    );
    const topicVisibleText = topicDocsHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    assert.match(topicDocsHtml, /Word \(\.docx\)/);
    assert.match(topicDocsHtml, /PowerPoint \(\.pptx\)/);
    assert.match(topicDocsHtml, /download="Contoso Executive Copilot Workshop - Step 01 - /);
    assert.doesNotMatch(topicVisibleText, /Contoso Executive Copilot Workshop - Step/);
    assert.doesNotMatch(topicVisibleText, /generated-labs\//);

    const savedRowHtml = uiContext.__step8Ui.lbGenItemHtml({
      labId: generated.labId,
      title: labTitle,
      generatedAt: "2026-11-16T00:00:00Z",
      totalMinutes: 30,
      moduleCount: 2,
      selections: {},
    });
    const savedRowVisible = savedRowHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    assert.match(savedRowHtml, /<h4 class="lb-gen-title">Contoso Executive Copilot Workshop<\/h4>/);
    assert.doesNotMatch(savedRowVisible, new RegExp(generated.labId));

    // 4b. Verify HTTP server endpoints for preview moduleOrder and direct single-file exports
    server = await startPortalServer(dir);

    const previewRes = await fetch(`${server.baseUrl}/api/lab-builder/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        products: ["copilot-studio"],
        industry: "financial-services",
        levels: [100, 200],
        harness: "standard",
        features: ["create-agent", "knowledge-sharepoint"],
        includeCore: false,
        moduleOrder: ["knowledge-sharepoint", "create-agent"],
      }),
    });
    assert.equal(previewRes.status, 200);
    const previewJson = await previewRes.json();
    assert.deepEqual(previewJson.moduleOrder, ["knowledge-sharepoint", "create-agent"]);
    assert.deepEqual(
      previewJson.modules.map((m) => m.id),
      ["knowledge-sharepoint", "create-agent"],
    );

    for (const [fmt, expectedMagic] of [
      ["docx", "PK"],
      ["pptx", "PK"],
      ["pdf", "%PDF"],
      ["html", "<!DOCTYPE html"],
      ["md", "# Contoso Executive Copilot Workshop"],
    ]) {
      const res = await fetch(
        `${server.baseUrl}/api/lab-builder/generated/${encodeURIComponent(generated.labId)}/export?format=${fmt}`,
      );
      assert.equal(res.status, 200, `Expected 200 for format=${fmt}`);
      const disp = res.headers.get("content-disposition") || "";
      assert.match(disp, /attachment;/);
      assert.match(disp, /Contoso%20Executive%20Copilot%20Workshop/);
      const buf = Buffer.from(await res.arrayBuffer());
      assert.ok(buf.length > 200, `Expected non-empty payload for format=${fmt}`);
      assert.ok(
        buf.subarray(0, expectedMagic.length).toString("utf8").startsWith(expectedMagic),
        `Expected ${fmt} payload to start with ${expectedMagic}`,
      );
    }
  } finally {
    if (server) await server.stop();
    cleanup();
  }
});
