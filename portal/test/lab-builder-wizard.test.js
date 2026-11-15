import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { getHarnesses } from "../lib/lab-builder/catalog.js";
import { recommend } from "../lib/lab-builder/recommend.js";
import { getKnownCoverageGaps, notApplicableReason } from "../lib/lab-builder/concepts.js";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const wizard = readFileSync(new URL("../public/lab-builder-wizard.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

const builderPanel = html.match(/id="panel-labbuilder"[\s\S]*?<!-- Preview tab -->/)?.[0] || "";

test("the wizard asks one question per step, in the required order", () => {
  const headings = [...builderPanel.matchAll(/id="lb-heading-(\d)"[^>]*>([^<]+)</g)].map((m) => [Number(m[1]), m[2]]);
  assert.deepEqual(headings.map(([n]) => n), [1, 2, 3, 4, 5, 6, 7, 8]);
  const order = ["products", "industry", "departments", "level", "harness", "topics", "Review", "Generate"];
  headings.forEach(([n, text], i) => {
    assert.match(text, new RegExp(`Step ${n} of 8`));
    assert.match(text, new RegExp(order[i], "i"));
  });
});

test("the step list is real buttons with the current step announced", () => {
  const list = builderPanel.match(/<ol class="lb-steps"[\s\S]*?<\/ol>/)?.[0];
  assert.ok(list, "the stepper is an ordered list");
  assert.equal([...list.matchAll(/<button\b/g)].length, 8);
  assert.match(list, /aria-current="step"/);
  assert.match(builderPanel, /<nav aria-label="Lab builder steps">/);
  assert.match(wizard, /setAttribute\("aria-current", "step"\)/);
  assert.match(wizard, /document\.getElementById\(`lb-heading-\$\{step\}`\)\?\.focus\(\)/);
});

test("each pane heading can take focus so a step change is announced", () => {
  for (let n = 1; n <= 8; n += 1) {
    assert.match(builderPanel, new RegExp(`id="lb-heading-${n}" tabindex="-1"`));
  }
});

test("a running total, reset affordances, and the time-as-guidance message are always shown", () => {
  assert.match(builderPanel, /id="lb-summary"[^>]*aria-live="polite"/);
  assert.match(builderPanel, /id="lb-start-over"[^>]*onclick="lbStartNewLab\(\)"[^>]*hidden[^>]*>Start over<\/button>/);
  assert.match(builderPanel, /id="lb-gen-start-new"[^>]*data-gen-action="new"[^>]*>Start new lab<\/button>/);
  assert.match(wizard, /estimate, not a limit/);
  assert.doesNotMatch(builderPanel, /Time budget/i);
  assert.doesNotMatch(wizard + app, /timeBudget/);
});

test("Your lab so far stays sticky at the top of the wizard stage, Previously generated labs starts collapsed, and Step 8 has an accessible generation progress card", () => {
  assert.match(builderPanel, /id="lb-wizard-stage"[\s\S]*?id="lb-wizard-sticky"[\s\S]*?id="lb-summary"/);
  assert.match(html, /\.lb-wizard-sticky\s*\{[^}]*position:\s*sticky;/);

  const detailsTag = builderPanel.match(/<details\b[^>]*id="lb-generated-details"[^>]*>/)?.[0];
  assert.ok(detailsTag, "Previously generated labs is wrapped in <details id=\"lb-generated-details\">");
  assert.doesNotMatch(detailsTag, /\bopen\b/, "Previously generated labs must always start collapsed");
  assert.match(builderPanel, /id="lb-gen-badge"/);

  assert.match(builderPanel, /<div id="lb-generating-card" class="lb-generating-card" hidden>/);
  assert.match(builderPanel, /id="lb-generating-stages"/);
  assert.match(builderPanel, /id="lb-generating-elapsed"/);
  assert.match(html, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(html, /@media print[\s\S]*?\.preview-frame \.lab-page\s*\{\s*display:\s*block !important;/);
});

test("wizard inputs disable browser form autocomplete restoration across soft reloads", () => {
  for (const id of ["lb-topic-search", "lb-topic-filter", "lb-time", "lb-agent-name", "lb-title", "lb-use-learn", "lb-use-llm"]) {
    assert.match(builderPanel, new RegExp(`id="${id}"[^>]*autocomplete="off"`), `${id} should have autocomplete="off"`);
  }
  assert.match(wizard, /name="lb-product"[^>]*autocomplete="off"/);
  assert.match(wizard, /name="lb-role"[^>]*autocomplete="off"/);
  assert.match(wizard, /name="lb-level"[^>]*autocomplete="off"/);
  assert.match(wizard, /name="lb-harness"[^>]*autocomplete="off"/);
  assert.match(wizard, /data-topic=[^>]*autocomplete="off"/);
  assert.match(wizard, /data-prerequisite=[^>]*autocomplete="off"/);
  assert.match(wizard, /data-outline-module=[^>]*autocomplete="off"/);
});

test("topics are checkboxes with Select recommended, Select all, Clear, Reset, and group actions", () => {
  for (const label of ["Select recommended", "Select all", "Clear", "Reset to my answers"]) assert.match(builderPanel, new RegExp(`>${label}<`));
  assert.match(wizard, /type="checkbox" data-topic=/);
  assert.match(wizard, /data-group-action="select"/);
  assert.match(wizard, /<fieldset class="lb-concept">/);
  assert.match(wizard, /Why: /);
});

test("the wizard builds exactly what the topic list shows and never adds hidden modules", () => {
  assert.match(wizard, /includeCore: false/);
  assert.match(wizard, /features: labBuilder\.rec \? labBuilder\.rec\.selectedIds : \[\]/);
  assert.match(wizard, /excluded: \[\.\.\.labBuilder\.excluded\]/);
  assert.doesNotMatch(builderPanel, /lb-include-core/);
});

test("the review outline is a table with a caption, headers, and a total", () => {
  assert.match(wizard, /<caption>Lab outline with estimated time per module<\/caption>/);
  assert.match(wizard, /<th scope="col">Estimated time<\/th>/);
  assert.match(wizard, /<tfoot>/);
});

test("the wizard script loads after app.js, and app.js no longer carries the old feature picker", () => {
  assert.ok(html.indexOf('src="lab-builder-wizard.js"') > html.indexOf('src="app.js"'));
  assert.doesNotMatch(app, /lbRenderFeatures|selectedFeatures/);
  assert.match(wizard, /\/api\/lab-builder\/recommend/);
});

test("a concept with no topic yet is reported as not available yet, not as not applicable", () => {
  // Cells listed in knownGaps are the only ones that can still be "not available yet".
  for (const cell of getKnownCoverageGaps()) {
    const [conceptId, target] = cell.split(":");
    const answers = getHarnesses().some((h) => h.id === target) ? { harness: target } : { products: [target] };
    const row = recommend(answers).concepts.find((c) => c.id === conceptId);
    assert.equal(row.notYetAvailable, true, cell);
  }
  const concept = { id: "x", features: ["f"], notApplicable: {} };
  const features = new Map([["f", { harness: ["standard"] }]]);
  assert.match(notApplicableReason(concept, "microsoft-copilot", features), /available on this harness yet/i);
  assert.equal(notApplicableReason(concept, "standard", features), null);
  const hooksOnStandard = recommend({ harness: "standard" }).concepts.find((c) => c.id === "hooks");
  assert.equal(hooksOnStandard.notYetAvailable, false);
  assert.match(hooksOnStandard.notApplicable, /topics/);
});

test("Step 6 badges 3rd-party connectors as optional, offers a 3rd-party filter, keeps them unchecked by default, and includes them only when checked", async () => {
  const vm = await import("node:vm");
  const elements = new Map();
  const filterOptions = [
    { value: "all", textContent: "All topics" },
    { value: "new", textContent: "New from Learn" },
    { value: "updated", textContent: "Updated recently" },
    { value: "moved", textContent: "Docs moved" },
  ];
  const element = (id) => {
    if (!elements.has(id)) {
      const base = {
        id,
        innerHTML: "",
        textContent: "",
        value: id === "lb-topic-filter" ? "all" : "",
        checked: true,
        hidden: false,
        style: {},
        options: id === "lb-topic-filter" ? filterOptions : [],
        contains: () => false,
        querySelector: (sel) => {
          if (id === "lb-topic-filter") {
            const m = sel.match(/option\[value="([^"]+)"\]/);
            return m ? filterOptions.find((o) => o.value === m[1]) || null : null;
          }
          return null;
        },
        querySelectorAll: () => [],
        appendChild: (opt) => {
          if (id === "lb-topic-filter") filterOptions.push(opt);
        },
        addEventListener() {},
        setAttribute() {},
        removeAttribute() {},
        classList: { toggle() {}, add() {}, remove() {} },
      };
      elements.set(id, base);
    }
    return elements.get(id);
  };
  const context = {
    document: {
      getElementById: element,
      createElement: (tag) => ({ tagName: tag.toUpperCase(), value: "", textContent: "" }),
      querySelector: () => null,
      querySelectorAll: () => [],
      activeElement: { dataset: {} },
    },
    CSS: { escape: (s) => s },
    escapeHtml: (s) => String(s),
    toast: () => {},
    fetch: async (_url, init) => ({ ok: true, json: async () => recommend(JSON.parse(init.body)) }),
    setTimeout,
    console,
  };
  vm.createContext(context);
  vm.runInContext(wizard, context);
  vm.runInContext(
    `
    labBuilder.concepts = {
      levels: [
        { id: 100, label: "Level 100 (Beginner)" },
        { id: 200, label: "Level 200 (Intermediate)" },
        { id: 300, label: "Level 300 (Advanced)" },
      ],
    };
    labBuilder.selectedProducts = new Set(["copilot-studio"]);
    labBuilder.industry = "retail";
    labBuilder.selectedRoles = new Set(["sales", "finance", "operations", "customer-service", "it"]);
    labBuilder.level = 200;
    labBuilder.harness = "standard";
    labBuilder.step = 6;
    lbBindTopicEvents();
    `,
    context,
  );
  const settle = () => new Promise((resolve) => setTimeout(resolve, 25));
  vm.runInContext("lbRefresh()", context);
  await settle();

  // Dynamic filter option is added idempotently without duplicating on re-render.
  vm.runInContext("lbRenderTopics()", context);
  assert.equal(filterOptions.filter((o) => o.value === "third-party").length, 1);
  assert.equal(filterOptions.find((o) => o.value === "third-party").textContent, "Optional 3rd-party connectors");

  // Intro explains 1st-party defaults and optional 3rd-party connectors.
  assert.match(element("lb-topic-intro").textContent, /1st-party Microsoft connectors by default/);

  // Neither default selection, Select recommended, nor Reset selects SAP or Salesforce.
  const thirdPartyIds = ["sap-integration", "salesforce-integration", "servicenow-integration", "snowflake-integration", "jira-integration"];
  const currentFeatures = () => JSON.parse(vm.runInContext("JSON.stringify(lbRequest().features)", context));
  for (const id of thirdPartyIds) assert.equal(currentFeatures().includes(id), false, `${id} must not be selected by default`);

  vm.runInContext("lbSelectRecommended()", context);
  await settle();
  for (const id of thirdPartyIds) assert.equal(currentFeatures().includes(id), false, `${id} must not be selected by Select recommended`);

  vm.runInContext("lbResetTopics()", context);
  await settle();
  for (const id of thirdPartyIds) assert.equal(currentFeatures().includes(id), false, `${id} must not be selected by Reset`);

  // Filtering to "third-party" shows only the 5 Level 200 optional 3rd-party connector cards with badges and relevance notes.
  vm.runInContext('labBuilder.filter = "third-party"; lbRenderTopics();', context);
  const filteredHtml = element("lb-topic-groups").innerHTML;
  assert.match(element("lb-topic-count").textContent, /Showing 5 topics for Level 200 that match your search or filter \(of 24\)\./);
  assert.match(filteredHtml, /<span class="lb-badge">Optional 3rd-party connector<\/span>/);
  assert.match(filteredHtml, /Optional 3rd-party connector \(relevant to Retail, Sales, and Customer Service\) — not selected by default/);
  assert.doesNotMatch(filteredHtml, /lb-concept-muted/);
  assert.doesNotMatch(filteredHtml, /data-topic="connector-tools"/);
  assert.doesNotMatch(filteredHtml, /\schecked\s/);

  // At Level 100, the "third-party" filter explains that optional 3rd-party connectors live at Levels 200 and 300.
  vm.runInContext("labBuilder.level = 100; lbRefresh();", context);
  await settle();
  assert.match(element("lb-topic-groups").innerHTML, /No optional 3rd-party connector topics are listed at Level 100/);

  // Explicitly checking SAP and Salesforce on Step 6 at Level 200 adds them to lbRequest().features.
  vm.runInContext('labBuilder.level = 200; labBuilder.filter = "all"; lbRefresh();', context);
  await settle();
  vm.runInContext('lbSetTopic("sap-integration", true, false);', context);
  await settle();
  vm.runInContext('lbSetTopic("salesforce-integration", true, false);', context);
  await settle();
  assert.equal(currentFeatures().includes("sap-integration"), true);
  assert.equal(currentFeatures().includes("salesforce-integration"), true);
});
