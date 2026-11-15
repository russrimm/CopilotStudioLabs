import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

import { getHarnesses, getFeaturesByCategory } from "../lib/lab-builder/catalog.js";
import { LEVEL_VALUES, LEVEL_LABELS } from "../lib/lab-builder/levels.js";
import { getProducts } from "../lib/lab-builder/products.js";
import { recommend } from "../lib/lab-builder/recommend.js";
import { planLab } from "../lib/lab-builder/planner.js";
import { generateLab } from "../lib/lab-builder/generator.js";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const wizardSource = readFileSync(new URL("../public/lab-builder-wizard.js", import.meta.url), "utf8");
const pane7 = html.match(/id="lb-pane-7"[\s\S]*?<!-- Step 8: generate -->/)?.[0] || "";

function previewPayload(request) {
  const plan = planLab(request);
  return {
    title: plan.title,
    slug: plan.slug,
    level: plan.level,
    difficulty: plan.difficulty,
    duration: plan.duration,
    totalMinutes: plan.totalMinutes,
    estimate: plan.estimate,
    harness: plan.harness,
    products: plan.products,
    productNames: plan.productNames,
    agentName: plan.profile.agentName,
    scenario: {
      problem: plan.profile.problem,
      outcome: plan.profile.outcome,
      sampleQuestions: plan.profile.sampleQuestions,
    },
    droppedOutOfLevel: plan.request.droppedOutOfLevel || [],
    deferred: plan.deferred,
    assumedPrereqs: plan.assumedPrereqs,
    relatedLabs: plan.relatedLabs,
    modules: plan.features.map((f) => ({
      id: f.id,
      order: f.order,
      stepOrder: f.stepOrder,
      recapOrder: f.recapOrder,
      stepLabel: f.stepLabel,
      name: f.name,
      category: f.category,
      level: f.level,
      role: f.prerequisite ? "prerequisite" : "level",
      minutes: f.minutes,
      summary: f.summary,
    })),
    warnings: plan.warnings,
  };
}

function loadStep7Harness() {
  const elements = new Map();
  const stepButtons = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => {
    const li = { hidden: false };
    const span = { textContent: String(n) };
    return {
      dataset: { lbStep: String(n) },
      disabled: n > 1,
      closest: (sel) => (sel === "li" ? li : null),
      querySelector: (sel) => (sel === "span[aria-hidden]" ? span : null),
      setAttribute() {},
      removeAttribute() {},
      classList: { toggle() {}, add() {}, remove() {} },
    };
  });
  const summaryMirror = { innerHTML: "" };
  const previewCalls = [];

  const element = (id) => {
    if (!elements.has(id)) {
      const listeners = new Map();
      let focused = null;
      const node = {
        id,
        innerHTML: "",
        textContent: id.startsWith("lb-heading-") ? `Step ${id.slice(-1)} of 8: Heading` : "",
        value: "",
        type: id === "lb-use-learn" || id === "lb-use-llm" ? "checkbox" : "text",
        checked: id === "lb-use-learn" || id === "lb-use-llm",
        hidden: false,
        disabled: false,
        style: {},
        contains: () => false,
        focus: () => {
          focused = id;
        },
        get lastFocused() {
          return focused;
        },
        querySelector: (selector) => {
          const matchMod = selector.match(/input\[data-outline-module="([^"]+)"\]/);
          if (matchMod) {
            const modId = matchMod[1];
            if (node.innerHTML.includes(`data-outline-module="${modId}"`)) {
              return {
                focus: () => {
                  focused = modId;
                },
              };
            }
            return null;
          }
          if (selector === "input[data-outline-module]" && node.innerHTML.includes("data-outline-module=")) {
            return {
              focus: () => {
                focused = "first-module";
              },
            };
          }
          return null;
        },
        querySelectorAll: () => [],
        addEventListener: (type, handler) => {
          if (!listeners.has(type)) listeners.set(type, []);
          listeners.get(type).push(handler);
        },
        dispatch: async (type, target) => {
          for (const handler of listeners.get(type) || []) {
            await handler({ target });
          }
        },
        setAttribute() {},
        removeAttribute() {},
        classList: { toggle() {}, add() {}, remove() {} },
      };
      elements.set(id, node);
    }
    return elements.get(id);
  };

  for (const id of [
    "lb-summary",
    "lb-preview",
    "lb-topic-groups",
    "lb-topic-intro",
    "lb-topic-count",
    "lb-topic-warnings",
    "lb-topic-error",
    "lb-review-error",
    "lb-next-from-review",
    "lb-generate-btn",
    "lb-time",
    "lb-title",
    "lb-agent-name",
    "lb-use-learn",
    "lb-use-llm",
  ]) {
    element(id);
  }

  const context = {
    document: {
      getElementById: element,
      querySelector: () => null,
      querySelectorAll: (selector) => {
        if (selector === "#lb-steps [data-lb-step]") return stepButtons;
        if (selector === "[data-lb-step-summary]") return [summaryMirror];
        return [];
      },
      activeElement: { dataset: {} },
    },
    CSS: { escape: (s) => s },
    escapeHtml: (s) =>
      String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]),
    toast: () => {},
    fetch: async (url, init) => {
      const body = JSON.parse(init.body || "{}");
      if (url === "/api/lab-builder/recommend") {
        return { ok: true, status: 200, json: async () => recommend({ ...body, selected: body.selected }) };
      }
      if (url === "/api/lab-builder/preview") {
        previewCalls.push(body);
        try {
          const payload = previewPayload(body);
          return { ok: true, status: 200, json: async () => payload };
        } catch (err) {
          return { ok: false, status: 400, json: async () => ({ error: err.message }) };
        }
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    },
    setTimeout,
    console,
  };

  vm.createContext(context);
  vm.runInContext(wizardSource, context);
  const run = (code) => vm.runInContext(code, context);

  context.__seed = {
    products: getProducts(),
    harnesses: getHarnesses(),
    levels: LEVEL_VALUES.map((level) => ({ level, label: LEVEL_LABELS[level] })),
    categories: getFeaturesByCategory(),
  };
  run(`
    labBuilder.products = __seed.products;
    labBuilder.harnesses = __seed.harnesses;
    labBuilder.levels = __seed.levels;
    labBuilder.categories = __seed.categories;
    labBuilder.selectedProducts = new Set([LB_DEFAULT_PRODUCT]);
    labBuilder.chosenSteps = new Set(["product", "level", "harness", "topics"]);
    labBuilder.level = 200;
    labBuilder.harness = "standard";
  `);

  return { run, context, element, stepButtons, summaryMirror, previewCalls };
}

function activeOutlineModuleIds(previewHtml) {
  const tableHtml = previewHtml.match(/<table class="lb-outline">[\s\S]*?<\/table>/)?.[0] || "";
  return [...tableHtml.matchAll(/data-outline-module="([^"]+)"/g)].map((m) => m[1]);
}

function removedSectionModuleIds(previewHtml) {
  const sectionHtml = previewHtml.match(/<section class="lb-removed-section"[\s\S]*?<\/section>/)?.[0] || "";
  return [...sectionHtml.matchAll(/data-outline-module="([^"]+)"/g)].map((m) => m[1]);
}

test("Step 7 markup explains module deselection, clarifies time guidance, and exposes accessible review controls", () => {
  assert.match(pane7, /Uncheck any module or prerequisite recap you do not want to remove it from the lab\./);
  assert.match(pane7, /id="lb-review-error"[^>]*role="alert"/);
  assert.match(pane7, /id="lb-next-from-review"/);
  assert.match(pane7, /Time guidance never drops modules: every module kept in your outline stays in the lab\./);
  assert.doesNotMatch(pane7, /Nothing is removed: every topic you choose stays in the lab/);
});

test("deselecting modules and prerequisite recaps on Step 7 removes them everywhere and omits them from generated labs", async () => {
  const { run, context, element, summaryMirror } = loadStep7Harness();

  // Start with Level 200 Connector tools, which pulls in Generative orchestration (200)
  // plus two Level 100 prerequisite recaps (Create an agent, Write agent instructions).
  run(`labBuilder.picked = new Set(["connector-tools"]);`);
  element("lb-time").value = "30";
  await context.lbRefresh();
  context.lbGoToStep(7);
  await new Promise((r) => setImmediate(r));

  let previewHtml = element("lb-preview").innerHTML;
  assert.deepEqual(activeOutlineModuleIds(previewHtml), [
    "create-agent",
    "agent-instructions",
    "generative-orchestration",
    "connector-tools",
  ]);
  const initialStepLabels = [...previewHtml.matchAll(/<\/td><td>([^<]+)<\/td><th scope="row">/g)].map((m) => m[1]);
  assert.deepEqual(initialStepLabels, ["Recap 1", "Recap 2", "Step 1", "Step 2"]);
  assert.match(previewHtml, /2 modules \+ 2 prerequisite recaps/);
  assert.match(previewHtml, /About 55 minutes/);
  assert.match(previewHtml, /Optional part 2:/, "55 min against 30 min target suggests a split initially");
  assert.equal(removedSectionModuleIds(previewHtml).length, 0);

  // 1) Uncheck same-level required module "generative-orchestration" via delegated change event on #lb-preview.
  await element("lb-preview").dispatch("change", {
    closest: (sel) =>
      sel === "input[data-outline-module]"
        ? { dataset: { outlineModule: "generative-orchestration" }, checked: false }
        : null,
  });

  previewHtml = element("lb-preview").innerHTML;
  assert.deepEqual(
    activeOutlineModuleIds(previewHtml),
    ["create-agent", "agent-instructions", "connector-tools"],
    "single uncheck removes generative-orchestration while keeping un-excluded transitive recaps",
  );
  // Recaps stay Recap 1..2 while remaining main module renumbers cleanly to Step 1.
  const stepCellsAfterFirst = [...previewHtml.matchAll(/<\/td><td>([^<]+)<\/td><th scope="row">/g)].map((m) => m[1]);
  assert.deepEqual(stepCellsAfterFirst, ["Recap 1", "Recap 2", "Step 1"]);
  assert.match(previewHtml, /1 module \+ 2 prerequisite recaps/);
  assert.match(previewHtml, /Total \(estimate\)<\/th><td>about 35 minutes<\/td>/);
  assert.deepEqual(removedSectionModuleIds(previewHtml), ["generative-orchestration"]);
  assert.equal(element("lb-preview").lastFocused, "generative-orchestration", "keyboard focus stays on the toggled module");

  // Sticky summary bar, step summary mirror, and Step 6 checkboxes all match Step 7.
  assert.match(element("lb-summary").innerHTML, /1 topic \+ 2 prerequisite recaps, about 35 min/);
  assert.equal(summaryMirror.innerHTML, element("lb-summary").innerHTML);
  context.lbRenderTopics();
  const topicsHtmlAfterFirst = element("lb-topic-groups").innerHTML;
  assert.match(topicsHtmlAfterFirst, /data-topic="connector-tools"[^>]*checked/);
  assert.doesNotMatch(topicsHtmlAfterFirst, /data-topic="generative-orchestration"[^>]*checked/);

  // 2) Uncheck lower-level prerequisite recap "agent-instructions" on Step 7.
  await context.lbSetOutlineModule("agent-instructions", false);
  previewHtml = element("lb-preview").innerHTML;
  assert.deepEqual(activeOutlineModuleIds(previewHtml), ["create-agent", "connector-tools"]);
  const stepCellsAfterSecond = [...previewHtml.matchAll(/<\/td><td>([^<]+)<\/td><th scope="row">/g)].map((m) => m[1]);
  assert.deepEqual(stepCellsAfterSecond, ["Recap 1", "Step 1"]);
  assert.match(previewHtml, /1 module \+ 1 prerequisite recap/);
  assert.match(previewHtml, /Total \(estimate\)<\/th><td>about 30 minutes<\/td>/);
  assert.doesNotMatch(previewHtml, /Optional part 2:/, "30 min now fits the 30 min target without split parts");
  assert.deepEqual(removedSectionModuleIds(previewHtml), ["generative-orchestration", "agent-instructions"]);
  assert.match(element("lb-summary").innerHTML, /1 topic \+ 1 prerequisite recap, about 30 min/);

  context.lbRenderTopics();
  const topicsHtmlAfterSecond = element("lb-topic-groups").innerHTML;
  assert.match(topicsHtmlAfterSecond, /data-prerequisite="create-agent"[^>]*checked/);
  assert.doesNotMatch(topicsHtmlAfterSecond, /data-prerequisite="agent-instructions"[^>]*checked/);

  // 3) Step 8 lab generation builds ONLY the remaining active curriculum modules; excluded prerequisites never sneak back in.
  const req = JSON.parse(run("JSON.stringify(lbRequest())"));
  assert.deepEqual(req.features, ["connector-tools"]);
  assert.deepEqual(req.excluded.sort(), ["agent-instructions", "generative-orchestration"]);
  const built = await generateLab(req, { useLearnMcp: false, useLlm: false, write: false });
  assert.equal(built.status, "complete");
  assert.deepEqual(
    built.manifest.modules.map((m) => m.id),
    ["create-agent", "connector-tools"],
  );
  assert.equal(built.manifest.totalMinutes, 30);
  assert.doesNotMatch(built.markdown, /### (?:Step|Recap) \d+ - (?:Recap: )?Generative orchestration/);
  assert.doesNotMatch(built.markdown, /### (?:Step|Recap) \d+ - (?:Recap: )?Write agent instructions/);
  assert.match(built.markdown, /### Recap 1 - Create an agent/);
  assert.match(built.markdown, /### Step 1 - Connector tools/);
  assert.match(built.markdown, /- \*\*Step 1 - Connector tools:\*\*/);

  // 4) Re-select a prerequisite recap individually on Step 7 without flagging off-level dropped selections, then Restore all.
  await context.lbSetOutlineModule("agent-instructions", true);
  assert.deepEqual(run("labBuilder.rec.filter.droppedSelections"), []);
  assert.deepEqual(activeOutlineModuleIds(element("lb-preview").innerHTML), [
    "create-agent",
    "agent-instructions",
    "connector-tools",
  ]);
  assert.deepEqual(removedSectionModuleIds(element("lb-preview").innerHTML), ["generative-orchestration"]);

  await element("lb-preview").dispatch("click", {
    closest: (sel) => (sel === "button[data-outline-action]" ? { dataset: { outlineAction: "restore-all" } } : null),
  });
  previewHtml = element("lb-preview").innerHTML;
  assert.deepEqual(activeOutlineModuleIds(previewHtml), [
    "create-agent",
    "agent-instructions",
    "generative-orchestration",
    "connector-tools",
  ]);
  assert.equal(removedSectionModuleIds(previewHtml).length, 0);
});

test("unchecking the last remaining module on Step 7 keeps the learner on Review, blocks Generate, and lets them re-select immediately", async () => {
  const { run, context, element, stepButtons, previewCalls } = loadStep7Harness();

  run(`labBuilder.picked = new Set(["connector-tools"]);`);
  await context.lbRefresh();
  context.lbGoToStep(7);
  await new Promise((r) => setImmediate(r));
  assert.equal(run("labBuilder.step"), 7);
  const callsBeforeEmpty = previewCalls.length;

  // Uncheck the sole picked level module.
  await context.lbSetOutlineModule("connector-tools", false);

  assert.equal(run("labBuilder.step"), 7, "must stay on Step 7 rather than bouncing back to Step 6");
  assert.equal(previewCalls.length, callsBeforeEmpty, "empty curriculum renders client-side without a 400 preview call");
  const emptyHtml = element("lb-preview").innerHTML;
  assert.match(emptyHtml, /No modules remain in your curriculum\./);
  assert.match(emptyHtml, /Re-select at least one module below or go back to Topics\./);
  assert.deepEqual(removedSectionModuleIds(emptyHtml), ["connector-tools"]);
  assert.match(element("lb-summary").innerHTML, /No topics selected yet/);
  assert.equal(element("lb-next-from-review").disabled, true);
  assert.equal(element("lb-generate-btn").disabled, true);

  // Attempting to advance to Step 8 via Next or stepper stays on Step 7 with an alert message.
  context.lbNextStep();
  assert.equal(run("labBuilder.step"), 7);
  assert.match(element("lb-review-error").textContent, /at least one module before generating/i);

  run("labBuilder.furthest = 8; lbRenderStepper();");
  const step8Btn = stepButtons.find((b) => Number(b.dataset.lbStep) === 8);
  assert.equal(step8Btn.disabled, true, "Step 8 stepper button is disabled while 0 modules remain");
  context.lbGoToStep(8);
  assert.equal(run("labBuilder.step"), 7);

  // Meanwhile, Step 6 -> Step 7 guard with 0 topics still stays on Step 6 as before.
  context.lbGoToStep(6);
  assert.equal(run("labBuilder.step"), 6);
  context.lbGoToStep(7);
  assert.equal(run("labBuilder.step"), 6);
  assert.match(element("lb-topic-error").textContent, /Choose at least one topic before you review the lab\./);

  // Return to Step 7 after re-checking on Step 7: simulate re-selecting from the empty state on Step 7.
  run(`labBuilder.picked = new Set(["connector-tools"]); labBuilder.excluded.clear();`);
  await context.lbRefresh();
  context.lbGoToStep(7);
  await new Promise((r) => setImmediate(r));
  await context.lbSetOutlineModule("connector-tools", false);
  assert.equal(element("lb-next-from-review").disabled, true);

  // Re-check connector-tools right on Step 7.
  await context.lbSetOutlineModule("connector-tools", true);
  assert.equal(element("lb-next-from-review").disabled, false);
  assert.equal(element("lb-generate-btn").disabled, false);
  assert.equal(element("lb-review-error").textContent, "");
  assert.deepEqual(activeOutlineModuleIds(element("lb-preview").innerHTML), [
    "create-agent",
    "agent-instructions",
    "generative-orchestration",
    "connector-tools",
  ]);
});

test("deselecting prerequisite recaps on Step 7 preserves Step 1..M numbering for all main modules", async () => {
  const { context, element, run } = loadStep7Harness();

  run(`labBuilder.picked = new Set(["generative-orchestration", "connector-tools"]);`);
  await context.lbRefresh();
  context.lbGoToStep(7);
  await new Promise((r) => setImmediate(r));

  const stepCellsOf = (htmlSnippet) =>
    [...htmlSnippet.matchAll(/<\/td><td>([^<]+)<\/td><th scope="row">/g)].map((m) => m[1]);

  assert.deepEqual(stepCellsOf(element("lb-preview").innerHTML), ["Recap 1", "Recap 2", "Step 1", "Step 2"]);

  // Uncheck first prerequisite recap: remaining recap becomes Recap 1, main modules stay Step 1, Step 2.
  await context.lbSetOutlineModule("create-agent", false);
  assert.deepEqual(activeOutlineModuleIds(element("lb-preview").innerHTML), [
    "agent-instructions",
    "generative-orchestration",
    "connector-tools",
  ]);
  assert.deepEqual(stepCellsOf(element("lb-preview").innerHTML), ["Recap 1", "Step 1", "Step 2"]);

  // Uncheck second prerequisite recap too: main modules still stay Step 1, Step 2.
  await context.lbSetOutlineModule("agent-instructions", false);
  assert.deepEqual(activeOutlineModuleIds(element("lb-preview").innerHTML), [
    "generative-orchestration",
    "connector-tools",
  ]);
  assert.deepEqual(stepCellsOf(element("lb-preview").innerHTML), ["Step 1", "Step 2"]);
});
