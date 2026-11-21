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

test("the wizard has four steps, in the required order", () => {
  const headings = [...builderPanel.matchAll(/id="lb-heading-(\d)"[^>]*>([^<]+)</g)].map((m) => [Number(m[1]), m[2]]);
  assert.deepEqual(headings.map(([n]) => n), [1, 2, 3, 4]);
  const order = ["products", "Tailor it", "topics", "Review and build"];
  headings.forEach(([n, text], i) => {
    assert.match(text, new RegExp(`Step ${n} of 4`));
    assert.match(text, new RegExp(order[i], "i"));
  });
});

test("the step list is real buttons with the current step announced", () => {
  const list = builderPanel.match(/<ol class="lb-steps"[\s\S]*?<\/ol>/)?.[0];
  assert.ok(list, "the stepper is an ordered list");
  assert.equal([...list.matchAll(/<button\b/g)].length, 4);
  assert.deepEqual([...list.matchAll(/<\/span> ([^<]+)<\/button>/g)].map((m) => m[1]), ["Product", "Tailor it", "Topics", "Review and build"]);
  assert.match(list, /aria-current="step"/);
  assert.match(builderPanel, /<nav aria-label="Lab builder steps">/);
  assert.match(wizard, /setAttribute\("aria-current", "step"\)/);
  assert.match(wizard, /document\.getElementById\(`lb-heading-\$\{step\}`\)\?\.focus\(\)/);
});

test("each pane heading can take focus so a step change is announced", () => {
  for (let n = 1; n <= 4; n += 1) {
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

test("Your lab so far stays sticky at the top of the wizard stage, Previously generated labs starts collapsed, and Review and build has an accessible generation progress card", () => {
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

test("topics are checkboxes, and Back to suggested, Select all, Clear, and group actions sit behind Change", () => {
  const pane = builderPanel.match(/id="lb-pane-3"[\s\S]*?<!-- Step 4: review and build -->/)?.[0] || "";
  assert.match(pane, /<button[^>]*id="lb-topic-change"[^>]*aria-expanded="false"[^>]*aria-controls="lb-topic-tools"[^>]*>Change<\/button>/);
  const tools = pane.match(/<div id="lb-topic-tools"[^>]*>[\s\S]*?<details class="lb-topic-help"/)?.[0] || "";
  assert.match(tools, /^<div id="lb-topic-tools"[^>]*\shidden>/, "the tools start hidden");
  for (const label of ["Back to suggested", "Select all", "Clear"]) assert.match(tools, new RegExp(`>${label}<`), `${label} is inside the tools`);
  assert.match(tools, /onclick="lbSelectRecommended\(\)">Back to suggested</);
  assert.doesNotMatch(builderPanel, /Select recommended|Reset to my answers/, "Back to suggested replaces both");
  assert.doesNotMatch(wizard, /function lbResetTopics|lbResetTopics\(/);
  assert.match(wizard, /type="checkbox" data-topic=/);
  assert.match(wizard, /data-group-action="select"/);
  assert.match(wizard, /<details class="lb-concept" data-concept=/);
  assert.doesNotMatch(wizard, /<fieldset class="lb-concept">/);
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

test("the Topics step badges 3rd-party connectors as optional, offers a 3rd-party filter, keeps them unchecked by default, and includes them only when checked", async () => {
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
    labBuilder.step = 3;
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

  // Intro is one sentence about the suggestion; the optional 3rd-party rule lives in the closed help and in each row's details.
  assert.equal(element("lb-topic-intro").textContent, "Suggested for Level 200: the usual starting topics. Uncheck anything you do not need.");
  assert.match(builderPanel, /<summary>How suggestions work<\/summary>[\s\S]*?Optional 3rd-party connectors are never selected for you\./);

  // Neither the default suggestion nor Back to suggested selects SAP or Salesforce.
  const thirdPartyIds = ["sap-integration", "salesforce-integration", "servicenow-integration", "snowflake-integration", "jira-integration"];
  const currentFeatures = () => JSON.parse(vm.runInContext("JSON.stringify(lbRequest().features)", context));
  assert.equal(vm.runInContext("labBuilder.pickedAuto", context), true, "Topics arrives with the suggestion selected");
  assert.ok(currentFeatures().length > 0, "the suggestion is not empty");
  for (const id of thirdPartyIds) assert.equal(currentFeatures().includes(id), false, `${id} must not be selected by default`);

  vm.runInContext("lbSelectRecommended()", context);
  await settle();
  for (const id of thirdPartyIds) assert.equal(currentFeatures().includes(id), false, `${id} must not be selected by Back to suggested`);

  // Filtering to "third-party" shows only the 5 Level 200 optional 3rd-party connector rows with one chip and a relevance note in the details.
  vm.runInContext('labBuilder.filter = "third-party"; lbRenderTopics();', context);
  const filteredHtml = element("lb-topic-groups").innerHTML;
  assert.match(element("lb-topic-count").textContent, /Showing 5 topics for Level 200 that match your search or filter \(of 24\)\./);
  assert.match(filteredHtml, /<span class="lb-badge ?">Optional 3rd-party connector<\/span>/);
  assert.match(filteredHtml, /Optional 3rd-party connector \(relevant to Retail, Sales, and Customer Service\) — not selected by default/);
  assert.match(filteredHtml, /Custom labs use 1st-party Microsoft connectors unless you select this topic/);
  assert.doesNotMatch(filteredHtml, /lb-concept-muted/);
  assert.doesNotMatch(filteredHtml, /data-topic="connector-tools"/);
  assert.doesNotMatch(filteredHtml, /\schecked[\s">]/);

  // At Level 100, the "third-party" filter explains that optional 3rd-party connectors live at Levels 200 and 300.
  vm.runInContext("labBuilder.level = 100; lbRefresh();", context);
  await settle();
  assert.match(element("lb-topic-groups").innerHTML, /No optional 3rd-party connector topics are listed at Level 100/);

  // Explicitly checking SAP and Salesforce on the Topics step at Level 200 adds them to lbRequest().features.
  vm.runInContext('labBuilder.level = 200; labBuilder.filter = "all"; lbRefresh();', context);
  await settle();
  vm.runInContext('lbSetTopic("sap-integration", true, false);', context);
  await settle();
  vm.runInContext('lbSetTopic("salesforce-integration", true, false);', context);
  await settle();
  assert.equal(currentFeatures().includes("sap-integration"), true);
  assert.equal(currentFeatures().includes("salesforce-integration"), true);
});

test("the Topics step uses closed help, one summary line, search and filters behind Change, Selected/Suggested filters, and compact rows with details", async () => {
  const pane6 = builderPanel.match(/id="lb-pane-3"[\s\S]*?<!-- Step 4: review and build -->/)?.[0] || "";
  assert.ok(pane6, "the Topics pane must exist");

  // Collapsible progressive-disclosure help replaces the long explainer.
  const helpDetails = pane6.match(/<details class="lb-topic-help"[^>]*>/)?.[0];
  assert.ok(helpDetails, "Topics must include collapsible <details class=\"lb-topic-help\">");
  assert.doesNotMatch(helpDetails, /\bopen\b/, "Topics help details must start collapsed");
  assert.match(pane6, /<summary>How suggestions work<\/summary>/);

  // One summary line replaces the scorecard; #lb-topic-count stays a live region.
  assert.match(pane6, /<p id="lb-topic-summary" class="lb-topic-summary" role="status" aria-live="polite"><\/p>/);
  assert.match(pane6, /id="lb-topic-count"[^>]*aria-live="polite"/);
  assert.doesNotMatch(pane6, /lb-topic-scorecard|lb-topic-scorebar|data-scorecard-action/);
  assert.doesNotMatch(wizard, /lbRenderTopicScorecard|lbJumpToPrerequisites|lbSetTopicFilter|data-scorecard-action/);

  // Search, filters, and bulk actions are one tools region, hidden until Change is pressed, in two zones so the search never clips.
  assert.match(pane6, /<button[^>]*id="lb-topic-change"[^>]*aria-expanded="false"[^>]*aria-controls="lb-topic-tools"/);
  const tools = pane6.match(/<div id="lb-topic-tools"[\s\S]*?<details class="lb-topic-help"/)?.[0] || "";
  assert.match(tools, /^<div id="lb-topic-tools" class="lb-topic-tools" role="region" aria-label="Search, filter, and choose topics" hidden>/);
  assert.match(tools, /class="lb-toolbar-find"[\s\S]*?class="lb-toolbar-actions"/);
  for (const val of ["all", "selected", "recommended", "new", "updated", "moved", "third-party"]) {
    assert.match(tools, new RegExp(`<option value="${val}">`), `#lb-topic-filter should offer ${val}`);
  }
  assert.match(tools, /<option value="recommended">Suggested topics<\/option>/);
  assert.match(html, /\.lb-toolbar-search-field\s*\{[^}]*min-width:\s*220px/);

  // Block hierarchy for the details panel, and the compact row's own layout.
  assert.match(html, /\.lb-feature-body\s*\{[^}]*display:\s*flex;\s*flex-direction:\s*column/);
  assert.match(html, /\.lb-feature-name\s*\{[^}]*display:\s*block/);
  assert.match(html, /\.lb-feature-badges\s*\{[^}]*display:\s*flex;\s*flex-wrap:\s*wrap/);
  assert.match(html, /\.lb-feature-summary\s*\{[^}]*display:\s*block/);
  assert.match(html, /\.lb-feature-note\s*\{[^}]*display:\s*block/);
  assert.match(html, /\.lb-topic-reason\s*\{[^}]*display:\s*block/);
  assert.match(html, /\.lb-concept-toolbar\s*\{[^}]*display:\s*flex/);
  assert.match(html, /\.lb-row-details\[hidden\]\s*\{\s*display:\s*none/);
  assert.match(html, /\.lb-topic-tools\[hidden\]\s*\{\s*display:\s*none/);

  const vm = await import("node:vm");
  const elements = new Map();
  const listeners = new Map();
  const filterOptions = [{ value: "all", textContent: "All topics" }];
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
        addEventListener(type, fn) {
          listeners.set(`${id}:${type}`, fn);
        },
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
    labBuilder.selectedProducts = new Set(["copilot-studio", "sharepoint-ai", "power-platform-ai-hub"]);
    labBuilder.industry = "retail";
    labBuilder.selectedRoles = new Set(["sales", "operations"]);
    labBuilder.level = 200;
    labBuilder.harness = "standard";
    labBuilder.step = 3;
    lbBindTopicEvents();
    `,
    context,
  );
  await vm.runInContext("lbRefresh()", context);

  // Dynamic filter options include selected, recommended, and third-party idempotently.
  for (const val of ["selected", "recommended", "third-party"]) {
    assert.equal(filterOptions.filter((o) => o.value === val).length, 1, `${val} option should be present once`);
  }
  vm.runInContext("lbRenderTopics(); lbRenderTopics();", context);
  for (const val of ["selected", "recommended", "third-party"]) {
    assert.equal(filterOptions.filter((o) => o.value === val).length, 1, `${val} option stays single after re-rendering`);
  }

  // Compact rows: the visible label holds the checkbox, title, time, and at most one chip; everything longer is in the row's details.
  const allHtml = element("lb-topic-groups").innerHTML;
  const firstRow = allHtml.match(/<div class="lb-feature lb-row[^"]*">\s*<label class="lb-feature-main lb-row-main">([\s\S]*?)<\/label>\s*<button type="button" class="lb-row-toggle"[^>]*>Details<\/button>\s*<div class="lb-row-details" id="lb-row-details-[^"]+" hidden>([\s\S]*?)<\/div>\s*<\/div>/);
  assert.ok(firstRow, "a row is the label, a Details button, and a hidden details panel");
  assert.match(firstRow[1], /<input type="checkbox" data-topic=/);
  assert.match(firstRow[1], /<span class="lb-feature-name lb-row-title">[^<]+<\/span>\s*<span class="lb-row-meta">about \d+ min<\/span>/);
  assert.ok([...firstRow[1].matchAll(/class="lb-badge/g)].length <= 1, "one status chip at most");
  assert.doesNotMatch(firstRow[1], /lb-feature-summary|lb-topic-reason|lb-feature-body|Why:/);
  assert.match(firstRow[2], /<span class="lb-feature-body">[\s\S]*?<span id="lb-topic-desc-[^"]+" class="lb-feature-summary">/);
  assert.match(allHtml, /<details class="lb-concept" data-concept="[^"]+">\s*<summary class="lb-category-title"><h4 class="lb-category-name">[^<]+<\/h4>/, "concept groups start collapsed");
  assert.match(allHtml, /<div class="lb-concept-toolbar">/);

  // One summary line says what the lab is; the count line stays a plain count while nothing narrows the list.
  const totals = JSON.parse(vm.runInContext("JSON.stringify(labBuilder.rec.totals)", context));
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  assert.equal(
    element("lb-topic-summary").textContent,
    `Suggested lab: ${plural(totals.selectedCount, "topic", "topics")}${totals.prerequisiteCount ? ` + ${plural(totals.prerequisiteCount, "refresher", "refreshers")}` : ""}, about ${totals.duration}.`,
  );
  assert.match(element("lb-topic-count").textContent, /^\d+ topics( and \d+ sub-topics?)? for Level 200\.$/);

  // The Show filter narrows to selected rows only and says so in the live count.
  const filterChange = listeners.get("lb-topic-filter:change");
  assert.ok(filterChange, "the filter listener must be registered");
  filterChange({ target: { value: "selected" } });
  assert.equal(vm.runInContext("labBuilder.filter", context), "selected");
  const selectedHtml = element("lb-topic-groups").innerHTML;
  assert.match(selectedHtml, /class="lb-feature lb-row checked"/);
  assert.doesNotMatch(selectedHtml, /class="lb-feature lb-row"/);
  assert.match(element("lb-topic-count").textContent, /that match your search or filter/);
  assert.match(selectedHtml, /<details class="lb-concept" data-concept="[^"]+" open>/, "a filter opens the groups that match");

  // The scorecard is gone with its jump and filter helpers.
  for (const name of ["lbRenderTopicScorecard", "lbJumpToPrerequisites", "lbSetTopicFilter", "lbResetTopics"]) {
    assert.equal(vm.runInContext(`typeof ${name}`, context), "undefined", `${name} no longer exists`);
  }

  // Clearing all selections while on "selected" filter renders a clear, helpful empty message; the summary says how to start.
  vm.runInContext("lbClearTopics()", context);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(element("lb-topic-summary").textContent, "No topics selected yet. Choose Change to pick some.");
  assert.match(element("lb-topic-groups").innerHTML, /No topics are currently selected\. Switch Show back to All topics to browse, or choose Back to suggested\./);

  // Back to suggested restores the suggestion and the summary says so again.
  vm.runInContext("lbSelectRecommended()", context);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.match(element("lb-topic-summary").textContent, /^Suggested lab: /);
});

