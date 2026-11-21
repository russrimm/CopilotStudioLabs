import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import vm from "node:vm";

import { getFeatures, getFeaturesByCategory, getHarnesses } from "../lib/lab-builder/catalog.js";
import { getProducts } from "../lib/lab-builder/products.js";
import { recommend } from "../lib/lab-builder/recommend.js";
import {
  SHAREPOINT_FEATURE_IDS,
  deriveSharepointSiteLabel,
  escapeMarkdownLinkLabel,
  featureRequiresSharepointSite,
  labRequiresSharepointSite,
  normalizeSharepointSiteUrl,
  resolveSharepointSite,
  validateSharepointSiteUrl,
} from "../lib/lab-builder/sharepoint-site.js";
import { planLab } from "../lib/lab-builder/planner.js";
import { generateLab } from "../lib/lab-builder/generator.js";
import { listGeneratedLabs, readGeneratedLab } from "../lib/lab-builder/generated-labs.js";
import { renderLabMarkdown } from "../lib/markdown.js";
import { renderStandaloneLabHtml } from "../lib/lab-builder/html-lab.js";
import { renderMarkdownToDocxBuffer } from "../lib/lab-builder/docx-builder.js";
import { renderMarkdownToPdfBuffer } from "../lib/lab-builder/pdf-builder.js";
import { renderMarkdownToPptxBuffer } from "../lib/lab-builder/pptx-builder.js";

process.env.LAB_BUILDER_LINK_CHECK = "off";
process.env.LAB_BUILDER_VENDOR_DOCS = "off";

const INDEX_HTML = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const WIZARD_JS = readFileSync(new URL("../public/lab-builder-wizard.js", import.meta.url), "utf8");
const APP_JS = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const GEN_LABS_JS = readFileSync(new URL("../public/generated-labs.js", import.meta.url), "utf8");

function tempDir(prefix = "sp-site-lab-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
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

function createWizardVm({ withGenerate = false } = {}) {
  const elements = new Map();
  let focusedId = null;
  let scrolledId = null;
  const storage = new Map();

  function element(id) {
    if (!elements.has(id)) {
      const attrs = new Map();
      const classes = new Set();
      const el = {
        id,
        value: id === "lb-extra-checks" || id === "lb-extra-quizzes" ? "0" : "",
        checked: id === "lb-use-learn",
        disabled: false,
        hidden:
          id === "lb-start-over" ||
          id === "lb-sharepoint-site-card" ||
          id === "lb-sharepoint-site-preview",
        innerHTML: "",
        textContent: "",
        href: "",
        dataset: id === "lb-sharepoint-site-card" ? { sharepointPromptCard: "true" } : {},
        style: {},
        contains: () => false,
        classList: {
          add: (...names) => names.forEach((n) => classes.add(n)),
          remove: (...names) => names.forEach((n) => classes.delete(n)),
          toggle: (name, force) => {
            const on = force === undefined ? !classes.has(name) : Boolean(force);
            if (on) classes.add(name);
            else classes.delete(name);
            return on;
          },
          contains: (name) => classes.has(name),
        },
        setAttribute: (k, v) => attrs.set(k, String(v)),
        getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
        removeAttribute: (k) => attrs.delete(k),
        addEventListener: (evt, handler) => {
          el._listeners = el._listeners || {};
          el._listeners[evt] = el._listeners[evt] || [];
          el._listeners[evt].push(handler);
        },
        dispatch: (evt) => {
          for (const fn of el._listeners?.[evt] || []) fn({ target: el, preventDefault() {} });
        },
        focus: () => {
          focusedId = id;
        },
        scrollIntoView: () => {
          scrolledId = id;
        },
        querySelector: () => null,
        querySelectorAll: () => [],
        closest: () => null,
      };
      elements.set(id, el);
    }
    return elements.get(id);
  }

  // Pre-mount the SharePoint site card so it starts hidden, as it does in the markup.
  element("lb-sharepoint-site-card");

  const context = {
    document: {
      getElementById: element,
      querySelector: () => null,
      querySelectorAll: () => [],
      activeElement: { dataset: {} },
    },
    window: {
      matchMedia: () => ({ matches: true }),
      addEventListener() {},
    },
    CSS: { escape: (s) => s },
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    escapeHtml: (s) =>
      String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;"),
    renderMermaidIn: () => {},
    toast: () => {},
    fetch: async (url, init) => {
      const body = JSON.parse(init?.body || "{}");
      if (String(url).includes("/api/lab-builder/recommend")) {
        return { ok: true, json: async () => recommend(body) };
      }
      if (String(url).includes("/api/lab-builder/preview")) {
        const plan = planLab(body);
        return {
          ok: true,
          json: async () => ({
            title: plan.title,
            difficulty: plan.difficulty,
            totalMinutes: plan.totalMinutes,
            duration: plan.estimate.duration,
            estimate: plan.estimate,
            products: plan.products,
            productNames: plan.productNames,
            deliverable: plan.deliverable,
            requiresSharepointSite: plan.requiresSharepointSite,
            sharepointSite: {
              name: plan.sharepointSite.name,
              url: plan.sharepointSite.url,
              label: plan.sharepointSite.label,
              configured: plan.sharepointSite.configured,
            },
            level: plan.level,
            prerequisites: plan.prerequisites,
            modules: plan.features.map((f) => ({
              id: f.id,
              name: f.name,
              product: f.product,
              stepLabel: f.stepLabel,
              minutes: f.minutes,
              level: f.level,
              role: f.prerequisite ? "prerequisite" : "level",
              summary: f.summary,
            })),
            warnings: plan.warnings,
          }),
        };
      }
      return { ok: false, status: 500, json: async () => ({ error: "stub" }) };
    },
    AbortController,
    URL,
    setTimeout: (fn) => {
      fn();
      return 1;
    },
    clearTimeout: () => {},
    console,
  };

  vm.createContext(context);
  vm.runInContext(WIZARD_JS, context);
  if (withGenerate) {
    const genStart = APP_JS.indexOf("async function lbGenerate()");
    const showEnd = APP_JS.indexOf("function lbResetWizard()", genStart);
    const slice = APP_JS.slice(genStart, showEnd > genStart ? showEnd : undefined);
    vm.runInContext(slice, context);
  }
  const run = (code) => vm.runInContext(code, context);
  run(`labBuilder.categories = ${JSON.stringify(getFeaturesByCategory())};`);
  run(`labBuilder.products = ${JSON.stringify(getProducts())};`);
  run(`labBuilder.harnesses = ${JSON.stringify(getHarnesses())};`);
  run("lbBindSharepointSiteControls()");

  return {
    context,
    run,
    element,
    storage,
    getFocusedId: () => focusedId,
    getScrolledId: () => scrolledId,
    resetFocusTracking: () => {
      focusedId = null;
      scrolledId = null;
    },
  };
}

test("SharePoint site requirement detection matches across all 6 products and mirrors 100% between backend and wizard", () => {
  const { context } = createWizardVm();
  const allFeatures = getFeatures();
  assert.ok(allFeatures.length > 40, "Expected full multi-product feature catalog");

  // Every single shipped feature must produce identical SharePoint requirement verdicts in backend & wizard!
  for (const feature of allFeatures) {
    assert.equal(
      context.lbFeatureRequiresSharepointSite(feature),
      featureRequiresSharepointSite(feature),
      `Backend/wizard parity mismatch on feature ${feature.id} (${feature.product})`,
    );
  }

  // 1. sharepoint-ai product always requires a SharePoint site.
  const firstSpAiFeature = allFeatures.find((f) => f.product === "sharepoint-ai" && f.level === 100);
  assert.ok(firstSpAiFeature, "Expected at least one Level 100 sharepoint-ai feature");
  assert.equal(labRequiresSharepointSite({ products: ["sharepoint-ai"], features: [] }), true);
  assert.equal(
    planLab({ products: ["sharepoint-ai"], features: [firstSpAiFeature.id], level: 100 }).requiresSharepointSite,
    true,
  );

  // 2. Cross-product SharePoint topics require a SharePoint site across Copilot Studio, Agent Builder, M365 Copilot, Power Platform AI, Foundry, and GitHub Copilot.
  const catalogByProductWithSharepoint = ["copilot-studio", "m365-copilot-agent-builder", "sharepoint-ai", "m365-copilot-hub", "power-platform-ai-hub"];
  for (const pid of catalogByProductWithSharepoint) {
    const spFeats = allFeatures.filter((f) => (f.product || "copilot-studio") === pid && featureRequiresSharepointSite(f));
    assert.ok(spFeats.length >= 1, `Expected at least one SharePoint-requiring feature in product ${pid}`);
  }
  for (const explicitId of SHAREPOINT_FEATURE_IDS) {
    const feat = allFeatures.find((f) => f.id === explicitId);
    if (feat) {
      assert.equal(featureRequiresSharepointSite(feat), true, `Expected ${explicitId} to require SharePoint site`);
    }
  }

  // Synthetic / discovered Foundry & GitHub Copilot topics that ground on SharePoint also trigger detection.
  const foundrySpTopic = {
    id: "disc-foundry-sp-connector",
    product: "ai-foundry",
    name: "Ground a Foundry agent on a SharePoint document library",
    summary: "Index documents from a SharePoint site library for grounded agent answers.",
    prerequisites: ["A SharePoint site with sample policy PDFs"],
  };
  const ghCopilotSpTopic = {
    id: "disc-gh-copilot-spfx",
    product: "github-copilot",
    name: "Build a SharePoint Framework web part with GitHub Copilot",
    summary: "Scaffold and test a web part against your SharePoint site workbench.",
  };
  assert.equal(featureRequiresSharepointSite(foundrySpTopic), true);
  assert.equal(context.lbFeatureRequiresSharepointSite(foundrySpTopic), true);
  assert.equal(featureRequiresSharepointSite(ghCopilotSpTopic), true);
  assert.equal(context.lbFeatureRequiresSharepointSite(ghCopilotSpTopic), true);

  // 3. Non-SharePoint topics and PAYG billing-only mentions do NOT trigger false positives.
  const nonSharepointCandidates = [
    allFeatures.find((f) => f.id === "create-agent"),
    allFeatures.find((f) => (f.product || "") === "ai-foundry"),
    {
      id: "billing-payg-only",
      product: "copilot-studio",
      name: "Configure pay-as-you-go billing",
      summary: "Connect an Azure subscription to meter Copilot Studio and SharePoint agents.",
      steps: ["Open Power Platform admin center and link a billing plan."],
    },
  ].filter(Boolean);
  for (const feat of nonSharepointCandidates) {
    assert.equal(featureRequiresSharepointSite(feat), false, `Expected ${feat.id} NOT to require SharePoint site`);
    assert.equal(context.lbFeatureRequiresSharepointSite(feat), false);
  }
  assert.equal(
    planLab({ products: ["copilot-studio"], features: ["create-agent"], level: 100 }).requiresSharepointSite,
    false,
  );
});

test("SharePoint URL validation normalizes bare hostnames, derives labels, escapes Markdown, and blocks XSS schemes", () => {
  assert.deepEqual(validateSharepointSiteUrl("https://contoso.sharepoint.com/sites/OperationsHub"), {
    valid: true,
    url: "https://contoso.sharepoint.com/sites/OperationsHub",
    error: null,
  });
  assert.deepEqual(validateSharepointSiteUrl("contoso.sharepoint.com/sites/OperationsHub"), {
    valid: true,
    url: "https://contoso.sharepoint.com/sites/OperationsHub",
    error: null,
  });
  assert.equal(
    normalizeSharepointSiteUrl("contoso.sharepoint.com/sites/OperationsHub"),
    "https://contoso.sharepoint.com/sites/OperationsHub",
  );

  // Derive readable label when site name is omitted
  assert.equal(
    deriveSharepointSiteLabel("https://contoso.sharepoint.com/sites/OperationsHub"),
    "OperationsHub (contoso.sharepoint.com)",
  );
  const urlOnly = resolveSharepointSite({
    sharepointSiteName: "",
    sharepointSiteUrl: "https://contoso.sharepoint.com/sites/HR_Onboarding",
  });
  assert.equal(urlOnly.configured, true);
  assert.equal(urlOnly.label, "HR_Onboarding (contoso.sharepoint.com)");
  assert.equal(
    urlOnly.markdownLink,
    "[HR_Onboarding (contoso.sharepoint.com)](https://contoso.sharepoint.com/sites/HR_Onboarding)",
  );

  // Escape brackets and encode parentheses in hrefs so Markdown links cannot be broken or injected
  const bracketed = resolveSharepointSite({
    sharepointSiteName: "Contoso [Ops] | Prod",
    sharepointSiteUrl: "https://contoso.sharepoint.com/sites/Ops(Prod)",
  });
  assert.equal(escapeMarkdownLinkLabel("Contoso [Ops] | Prod"), "Contoso \\[Ops\\] \\| Prod");
  assert.equal(
    bracketed.markdownLink,
    "[Contoso \\[Ops\\] \\| Prod](https://contoso.sharepoint.com/sites/Ops%28Prod%29)",
  );

  // Reject unsafe schemes, protocol-relative URLs, credentials, and malformed inputs
  const unsafeInputs = [
    "javascript:alert(1)",
    "JAVASCRIPT:alert(document.cookie)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///C:/Windows/System32/drivers/etc/hosts",
    "//evil.example.com/sites/Fake",
    "https://user:secret@contoso.sharepoint.com/sites/Ops",
    "https://contoso.sharepoint.com/sites/Ops\"><script>alert(1)</script>",
    "not a valid url",
  ];
  for (const bad of unsafeInputs) {
    const check = validateSharepointSiteUrl(bad);
    assert.equal(check.valid, false, `Expected URL "${bad}" to be rejected`);
    assert.ok(check.error, `Expected readable error message for "${bad}"`);
    const cfg = resolveSharepointSite({ sharepointSiteName: "Ops", sharepointSiteUrl: bad });
    assert.equal(cfg.url, null, `Unsafe URL "${bad}" must never survive into resolved config`);
    assert.throws(
      () => resolveSharepointSite({ sharepointSiteName: "Ops", sharepointSiteUrl: bad }, { strict: true }),
      /SharePoint site/i,
    );
  }
});

test("Review and build SharePoint site card is optional: visibility, no prompt, a typed bad URL still blocks, and the site is passed through and persisted end to end", async () => {
  // 1. Static HTML structure: card is inside #lb-pane-4 directly BEFORE <details class="lb-advanced"> (not hidden inside <details>).
  const pane4Start = INDEX_HTML.indexOf('id="lb-pane-4"');
  const resultStart = INDEX_HTML.indexOf('id="lb-result-panel"');
  assert.ok(pane4Start > 0 && resultStart > pane4Start);
  const pane4Html = INDEX_HTML.slice(pane4Start, resultStart);
  const spCardIdx = pane4Html.indexOf('id="lb-sharepoint-site-card"');
  const advancedIdx = pane4Html.indexOf('<details class="lb-advanced">');
  assert.ok(spCardIdx > 0, "Expected #lb-sharepoint-site-card inside #lb-pane-4");
  assert.ok(spCardIdx < advancedIdx, "Expected #lb-sharepoint-site-card above <details class=\"lb-advanced\">");
  assert.match(pane4Html, /SharePoint site \(optional\)/);
  assert.match(pane4Html, /id="lb-sharepoint-site-hint"/);
  for (const removed of ["lb-sharepoint-site-prompt", "lb-sharepoint-site-skip", "lb-step8-sharepoint-summary", "lb-step8-customize-summary"]) {
    assert.ok(!INDEX_HTML.includes(`id="${removed}"`), `#${removed} is gone: the site is optional, so there is no prompt and no second summary`);
  }
  assert.match(INDEX_HTML, /@media print[\s\S]*\.lb-sharepoint-site-card/);

  // 2. Non-SharePoint selection hides #lb-sharepoint-site-card and never asks about a site.
  const { context, run, element, getFocusedId, resetFocusTracking } = createWizardVm({ withGenerate: true });
  const generateCalls = [];
  const previewCalls = [];
  const stubbedFetch = context.fetch;
  context.fetch = async (url, init) => {
    if (String(url).includes("/api/lab-builder/generate")) {
      generateCalls.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ status: "cancelled" }) };
    }
    if (String(url).includes("/api/lab-builder/preview")) previewCalls.push(JSON.parse(init.body));
    return stubbedFetch(url, init);
  };
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  run("lbToggleProduct('copilot-studio', true)");
  await run("lbRefresh()");
  run("labBuilder.picked = new Set(['create-agent']); labBuilder.rec.selectedIds = ['create-agent'];");
  run("lbGoToStep(4)");
  assert.equal(run("labBuilder.step"), 4);
  assert.equal(element("lb-sharepoint-site-card").hidden, true);
  assert.equal(run("lbValidateSharepointSiteForBuild()"), true, "Non-SharePoint labs build without a word about a site");
  assert.equal(run("lbNextActionLabel(4)"), "Build my lab");

  // 3. Selecting a SharePoint topic reveals #lb-sharepoint-site-card. The site is optional: a blank site never blocks and nothing prompts.
  run("labBuilder.level = 100; labBuilder.picked = new Set(['create-agent', 'knowledge-sharepoint']);");
  await run("lbRefresh()");
  run("lbSyncSharepointSiteUi()");
  assert.equal(element("lb-sharepoint-site-card").hidden, false);
  assert.equal(element("lb-sharepoint-site-hint").hidden, false, "A calm hint says a blank site is fine while the field is empty");
  assert.equal(run("typeof lbValidateOrPromptSharepointSite"), "undefined", "The blocking prompt is gone");
  assert.equal(run("typeof lbClearSharepointSkipFlag"), "undefined", "So is the skip flag");
  assert.equal(run("'sharepointPromptSkipped' in labBuilder"), false);
  assert.equal(run("'sharepointPromptPendingAction' in labBuilder"), false);

  resetFocusTracking();
  assert.equal(run("lbValidateSharepointSiteForBuild()"), true, "Blank SharePoint fields never block a build");
  assert.equal(run("labBuilder.step"), 4);
  assert.equal(getFocusedId(), null, "Nothing steals focus to ask about the site");
  assert.equal(element("lb-sharepoint-site-error").textContent, "");

  // Build my lab with both fields blank goes straight to the build, with no site in the request, and no second warning.
  await context.lbGenerate();
  assert.equal(generateCalls.length, 1);
  assert.equal(generateCalls[0].sharepointSiteName, undefined);
  assert.equal(generateCalls[0].sharepointSiteUrl, undefined);
  assert.equal(getFocusedId(), null);
  assert.equal(element("lb-sharepoint-site-error").textContent, "");

  // The sticky primary on this step builds the same way, and Next from Topics opens this step without asking.
  await run("lbStickyPrimaryAction()");
  assert.equal(generateCalls.length, 2);
  run("lbGoToStep(3)");
  resetFocusTracking();
  run("lbNextStep()");
  assert.equal(run("labBuilder.step"), 4, "Next from Topics opens Review and build while the site is blank");
  assert.equal(getFocusedId(), "lb-heading-4");

  // A name with no URL is still fine, and the hint goes away once something is entered.
  element("lb-sharepoint-site-name").value = "Contoso Operations Hub";
  element("lb-sharepoint-site-name").dispatch("input");
  assert.equal(element("lb-sharepoint-site-hint").hidden, true);
  resetFocusTracking();
  assert.equal(run("lbValidateSharepointSiteForBuild()"), true, "A name alone never blocks");
  assert.equal(getFocusedId(), null);

  // 4. A typed invalid/XSS URL still blocks the build with the inline error, marks the field, and focuses it.
  element("lb-sharepoint-site-url").value = "javascript:alert(1)";
  element("lb-sharepoint-site-url").dispatch("input");
  resetFocusTracking();
  const callsBeforeBlocked = generateCalls.length;
  await context.lbGenerate();
  assert.equal(generateCalls.length, callsBeforeBlocked, "An address that cannot be used never reaches the build");
  assert.equal(run("labBuilder.step"), 4);
  assert.ok(element("lb-sharepoint-site-error").textContent.length > 0);
  assert.equal(element("lb-sharepoint-site-url").getAttribute("aria-invalid"), "true");
  assert.equal(getFocusedId(), "lb-sharepoint-site-url");
  resetFocusTracking();
  await run("lbStickyPrimaryAction()");
  assert.equal(generateCalls.length, callsBeforeBlocked, "The sticky primary is blocked the same way");
  assert.equal(getFocusedId(), "lb-sharepoint-site-url");

  // 5. Clearing the invalid URL lifts the block with no skip step: the build goes ahead with the name only.
  element("lb-sharepoint-site-url").value = "";
  element("lb-sharepoint-site-url").dispatch("input");
  assert.equal(element("lb-sharepoint-site-error").textContent, "");
  assert.equal(element("lb-sharepoint-site-url").getAttribute("aria-invalid"), null);
  await context.lbGenerate();
  assert.equal(generateCalls.length, callsBeforeBlocked + 1);
  assert.equal(generateCalls.at(-1).sharepointSiteName, "Contoso Operations Hub");
  assert.equal(generateCalls.at(-1).sharepointSiteUrl, undefined);

  // Changing products or topics never raises a SharePoint prompt either.
  const firstSpAiId = getFeatures().find((f) => f.product === "sharepoint-ai" && f.level === 100).id;
  run("lbToggleProduct('sharepoint-ai', true)");
  run(`labBuilder.picked = new Set(['create-agent', 'knowledge-sharepoint', '${firstSpAiId}']);`);
  await run("lbRefresh()");
  assert.equal(run("lbValidateSharepointSiteForBuild()"), true);
  assert.equal(run("'sharepointPromptSkipped' in labBuilder"), false);

  // 6. Entering bare hostname auto-normalizes on blur, renders a live clickable preview, is sent with the preview and the build, and persists.
  run("lbGoToStep(4)");
  assert.equal(run("labBuilder.step"), 4);
  element("lb-sharepoint-site-url").value = "contoso.sharepoint.com/sites/OperationsHub";
  element("lb-sharepoint-site-url").dispatch("blur");
  assert.equal(element("lb-sharepoint-site-url").value, "https://contoso.sharepoint.com/sites/OperationsHub");
  assert.equal(element("lb-sharepoint-site-preview").hidden, false);
  assert.equal(
    element("lb-sharepoint-site-preview-link").href,
    "https://contoso.sharepoint.com/sites/OperationsHub",
  );
  assert.equal(element("lb-sharepoint-site-preview-link").textContent, "Contoso Operations Hub");
  await settle();
  assert.equal(previewCalls.at(-1).sharepointSiteName, "Contoso Operations Hub");
  assert.equal(previewCalls.at(-1).sharepointSiteUrl, "https://contoso.sharepoint.com/sites/OperationsHub");

  const reqPayload = context.lbCollectRequest();
  assert.equal(reqPayload.sharepointSiteName, "Contoso Operations Hub");
  assert.equal(reqPayload.sharepointSiteUrl, "https://contoso.sharepoint.com/sites/OperationsHub");

  const callsBeforeValid = generateCalls.length;
  await context.lbGenerate();
  assert.equal(generateCalls.length, callsBeforeValid + 1, "A valid site never blocks the build");
  assert.equal(generateCalls.at(-1).sharepointSiteName, "Contoso Operations Hub");
  assert.equal(generateCalls.at(-1).sharepointSiteUrl, "https://contoso.sharepoint.com/sites/OperationsHub");

  // Verify reset + lbLoadSelections round-trip
  context.lbResetWizard();
  assert.equal(run("labBuilder.sharepointSiteName"), "");
  assert.equal(run("labBuilder.sharepointSiteUrl"), "");
  assert.equal(element("lb-sharepoint-site-name").value, "");
  assert.equal(element("lb-sharepoint-site-url").value, "");

  await context.lbLoadSelections({
    labId: "saved-sp-lab",
    title: "Saved SharePoint Lab",
    selections: {
      products: ["sharepoint-ai"],
      roles: [],
      features: [firstSpAiId],
      excluded: [],
      level: 100,
      sharepointSiteName: "Fabrikam Knowledge Portal",
      sharepointSiteUrl: "https://fabrikam.sharepoint.com/sites/KnowledgePortal",
    },
  });
  assert.equal(run("labBuilder.sharepointSiteName"), "Fabrikam Knowledge Portal");
  assert.equal(run("labBuilder.sharepointSiteUrl"), "https://fabrikam.sharepoint.com/sites/KnowledgePortal");
  assert.equal(element("lb-sharepoint-site-name").value, "Fabrikam Knowledge Portal");
  assert.equal(element("lb-sharepoint-site-url").value, "https://fabrikam.sharepoint.com/sites/KnowledgePortal");
});

test("Generated SharePoint lab embeds clickable hyperlinks across Markdown, Portal preview, HTML, DOCX, PDF, PPTX, manifest, and Generated Labs UI", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const spName = "Contoso Operations Hub";
    const spUrl = "https://contoso.sharepoint.com/sites/OperationsHub";

    const result = await generateLab(
      {
        products: ["copilot-studio"],
        features: ["create-agent", "knowledge-sharepoint"],
        level: 100,
        harness: "standard",
        industry: "healthcare",
        sharepointSiteName: spName,
        sharepointSiteUrl: spUrl,
      },
      { outputRoot: dir, useLearnMcp: false, useLlm: false },
    );

    assert.equal(result.status, "complete");
    assert.equal(result.validation.failed, 0);

    // 1. Markdown (.md): Overview, Scenario, Admin Prerequisites, and SharePoint module walkthrough all carry the clickable link!
    const mdLink = `[${spName}](${spUrl})`;
    assert.ok(result.markdown.includes(`**Target SharePoint Site:** ${mdLink}`), "Expected Target SharePoint Site in Lab Overview");
    assert.ok(result.markdown.includes(mdLink), "Expected Markdown hyperlink in lab guide");

    // Module-specific check: knowledge-sharepoint gets the SharePoint walkthrough callout, while Recap create-agent does not.
    const spModuleIdx = result.markdown.indexOf("### Ground on SharePoint") !== -1
      ? result.markdown.indexOf("### Ground on SharePoint")
      : result.markdown.indexOf("SharePoint");
    assert.ok(spModuleIdx > 0);
    assert.match(
      result.markdown,
      /Target SharePoint site:\*\* \[Contoso Operations Hub\]\(https:\/\/contoso\.sharepoint\.com\/sites\/OperationsHub\)/,
    );

    // 2. Portal Markdown preview (renderLabMarkdown) opens external SharePoint link safely in a new tab.
    const previewHtml = renderLabMarkdown(result.markdown);
    assert.match(
      previewHtml,
      /<a href="https:\/\/contoso\.sharepoint\.com\/sites\/OperationsHub"[^>]*target="_blank"[^>]*rel="noopener noreferrer"[^>]*>Contoso Operations Hub<\/a>/,
    );

    // 3. Standalone HTML export (index.html & renderStandaloneLabHtml) renders clickable <a> tag.
    const standaloneHtml = renderStandaloneLabHtml(result.markdown, { title: result.plan.title, labId: "test-lab" });
    assert.match(
      standaloneHtml,
      /<a href="https:\/\/contoso\.sharepoint\.com\/sites\/OperationsHub"[^>]*>Contoso Operations Hub<\/a>/,
    );
    const diskHtml = readFileSync(join(result.outputDir, "index.html"), "utf8");
    assert.match(diskHtml, /https:\/\/contoso\.sharepoint\.com\/sites\/OperationsHub/);

    // 4. Word (.docx): whole-lab DOCX + generated per-topic SharePoint DOCX carry External relationship & <w:hyperlink>.
    const fullDocxBuf = renderMarkdownToDocxBuffer(result.markdown, { title: result.plan.title });
    const docxZip = parseZipArchive(fullDocxBuf);
    const docxRels = docxZip.get("word/_rels/document.xml.rels")?.toString("utf8") || "";
    const docxXml = docxZip.get("word/document.xml")?.toString("utf8") || "";
    assert.match(docxRels, /Target="https:\/\/contoso\.sharepoint\.com\/sites\/OperationsHub"[^>]*TargetMode="External"/);
    assert.match(docxXml, /<w:hyperlink r:id="rId(?:Link)?\d+">/);
    assert.match(docxXml, /Contoso Operations Hub/);

    const topicsDir = join(result.outputDir, "topics");
    const topicFiles = readdirSync(topicsDir);
    const spDocxFile = topicFiles.find((f) => /SharePoint/i.test(f) && f.endsWith(".docx"));
    assert.ok(spDocxFile, `Expected per-topic SharePoint .docx in ${topicFiles.join(", ")}`);
    const spTopicDocxZip = parseZipArchive(readFileSync(join(topicsDir, spDocxFile)));
    assert.match(
      spTopicDocxZip.get("word/_rels/document.xml.rels")?.toString("utf8") || "",
      /Target="https:\/\/contoso\.sharepoint\.com\/sites\/OperationsHub"/,
    );

    // 5. PDF (.pdf): contains clickable /Subtype /Link annotation with /URI pointing to the SharePoint site URL.
    const pdfBuf = renderMarkdownToPdfBuffer(result.markdown, { title: result.plan.title });
    const pdfLatin1 = pdfBuf.toString("latin1");
    assert.match(pdfLatin1, /^%PDF-1\.4/);
    assert.match(pdfLatin1, /\/Subtype \/Link/);
    assert.ok(
      pdfLatin1.includes(`/URI (${spUrl})`),
      "Expected clickable /URI annotation for SharePoint URL in generated PDF",
    );

    // 6. PowerPoint (.pptx): whole-lab PPTX + per-topic SharePoint PPTX contain <a:hlinkClick> + External slide rels!
    const fullPptxBuf = renderMarkdownToPptxBuffer(result.markdown, { title: result.plan.title });
    const pptxZip = parseZipArchive(fullPptxBuf);
    const allSlideRels = [...pptxZip.entries()]
      .filter(([name]) => /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/.test(name))
      .map(([, buf]) => buf.toString("utf8"))
      .join("\n");
    const allSlideXml = [...pptxZip.entries()]
      .filter(([name]) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .map(([, buf]) => buf.toString("utf8"))
      .join("\n");
    assert.match(allSlideRels, /Target="https:\/\/contoso\.sharepoint\.com\/sites\/OperationsHub"[^>]*TargetMode="External"/);
    assert.match(allSlideXml, /<a:hlinkClick r:id="rId\d+"[^>]*\/>/);

    const spPptxFile = topicFiles.find((f) => /SharePoint/i.test(f) && f.endsWith(".pptx"));
    assert.ok(spPptxFile, `Expected per-topic SharePoint .pptx in ${topicFiles.join(", ")}`);
    const spTopicPptxZip = parseZipArchive(readFileSync(join(topicsDir, spPptxFile)));
    const spTopicRels = [...spTopicPptxZip.entries()]
      .filter(([name]) => /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/.test(name))
      .map(([, buf]) => buf.toString("utf8"))
      .join("\n");
    assert.match(spTopicRels, /Target="https:\/\/contoso\.sharepoint\.com\/sites\/OperationsHub"/);

    // 7. Manifest persistence + listGeneratedLabs + readGeneratedLab + generated-labs.js UI rendering
    const manifest = JSON.parse(readFileSync(join(result.outputDir, "manifest.json"), "utf8"));
    assert.equal(manifest.requiresSharepointSite, true);
    assert.equal(manifest.request.sharepointSiteName, spName);
    assert.equal(manifest.request.sharepointSiteUrl, spUrl);
    assert.deepEqual(manifest.sharepointSite, { name: spName, url: spUrl, label: spName });

    const [listed] = listGeneratedLabs(dir).labs;
    assert.deepEqual(listed.sharepointSite, { name: spName, url: spUrl, label: spName });
    assert.equal(listed.selections.sharepointSiteName, spName);
    assert.equal(listed.selections.sharepointSiteUrl, spUrl);

    const openedRes = readGeneratedLab(dir, listed.labId, renderLabMarkdown);
    assert.equal(openedRes.status, 200);
    const opened = openedRes.body;
    assert.deepEqual(opened.sharepointSite, { name: spName, url: spUrl, label: spName });

    // Verify generated-labs.js renders clickable <a> links in Admin Prerequisites, lab list chips, and search text, while rejecting unsafe URLs!
    const genContext = {
      escapeHtml: (s) =>
        String(s ?? "")
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;"),
      labBuilder: { industries: [], levels: [], harnesses: [], products: [] },
      lbFormatMinutes: (m) => `${m} min`,
      document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
      window: { addEventListener() {} },
      fetch: async () => ({ ok: true, json: async () => ({ labs: [] }) }),
      toast: () => {},
      URL,
    };
    vm.createContext(genContext);
    vm.runInContext(
      `${GEN_LABS_JS}\nglobalThis.__gen = { lbRenderAdminPrerequisitesHtml, lbGenItemHtml, lbGenSearchText, lbRenderTextWithSafeLinks };`,
      genContext,
    );

    const adminHtml = genContext.__gen.lbRenderAdminPrerequisitesHtml(opened.adminPrerequisites);
    assert.match(adminHtml, /class="lb-prereq-sp-callout"/);
    assert.match(
      adminHtml,
      /<a href="https:\/\/contoso\.sharepoint\.com\/sites\/OperationsHub" target="_blank" rel="noopener noreferrer">Contoso Operations Hub<\/a>/,
    );

    const itemHtml = genContext.__gen.lbGenItemHtml(listed);
    assert.match(
      itemHtml,
      /SharePoint: <a href="https:\/\/contoso\.sharepoint\.com\/sites\/OperationsHub" target="_blank" rel="noopener noreferrer">Contoso Operations Hub<\/a>/,
    );
    assert.match(genContext.__gen.lbGenSearchText(listed), /contoso operations hub/);

    // XSS check on lbRenderTextWithSafeLinks
    const xssAttempt = genContext.__gen.lbRenderTextWithSafeLinks(
      'Click [Evil](javascript:alert(1)) or [Safe](https://contoso.sharepoint.com/sites/Safe) <img src=x onerror=alert(1)>',
    );
    assert.doesNotMatch(xssAttempt, /href="javascript:/i);
    assert.doesNotMatch(xssAttempt, /<img/);
    assert.match(xssAttempt, /<a href="https:\/\/contoso\.sharepoint\.com\/sites\/Safe"/);
  } finally {
    cleanup();
  }
});

test("/api/lab-builder/preview returns synchronized requiresSharepointSite and sanitized sharepointSite metadata", async () => {
  const port = await new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });

  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      AZURE_KEYVAULT_URL: "",
      PORTAL_AUTH_DISABLED: "true",
      LAB_BUILDER_LINK_CHECK: "off",
    },
    stdio: "ignore",
  });

  try {
    const deadline = Date.now() + 15000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`Server exited early with code ${child.exitCode}`);
      try {
        await fetch(`${base}/api/config`);
        break;
      } catch {
        if (Date.now() > deadline) throw new Error("Timed out waiting for portal server to start");
        await new Promise((r) => setTimeout(r, 150));
      }
    }

    const postPreview = async (body) => {
      const res = await fetch(`${base}/api/lab-builder/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 200);
      return res.json();
    };

    const spAiFeatureId = getFeatures().find((f) => f.product === "sharepoint-ai" && f.level === 100).id;
    const spPreview = await postPreview({
      products: ["sharepoint-ai"],
      features: [spAiFeatureId],
      level: 100,
      sharepointSiteName: "Contoso Intranet",
      sharepointSiteUrl: "contoso.sharepoint.com/sites/Intranet",
    });
    assert.equal(spPreview.requiresSharepointSite, true);
    assert.equal(spPreview.sharepointSite.configured, true);
    assert.equal(spPreview.sharepointSite.name, "Contoso Intranet");
    assert.equal(spPreview.sharepointSite.url, "https://contoso.sharepoint.com/sites/Intranet");

    const xssRes = await fetch(`${base}/api/lab-builder/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        products: ["copilot-studio"],
        features: ["knowledge-sharepoint"],
        level: 100,
        sharepointSiteName: "Ops",
        sharepointSiteUrl: "javascript:alert(1)",
      }),
    });
    assert.equal(xssRes.status, 400);
    const xssBody = await xssRes.json();
    assert.match(xssBody.error, /SharePoint site/i);

    const nonSpPreview = await postPreview({
      products: ["copilot-studio"],
      features: ["create-agent"],
      level: 100,
    });
    assert.equal(nonSpPreview.requiresSharepointSite, false);
  } finally {
    child.kill();
  }
});
