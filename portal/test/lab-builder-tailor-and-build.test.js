/**
 * The four-step wizard in the real wizard script: Product, Tailor it, Topics, and Review and build.
 *
 * The browser script runs inside node:vm against the fake DOM, the real markup of the Lab Builder stage from
 * index.html, and a fetch that answers from the real recommend and planner code. Nothing touches a network or a
 * browser. Only made-up names appear here (contoso, fabrikam).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import vm from "node:vm";

import { getFeaturesByCategory, getHarnesses } from "../lib/lab-builder/catalog.js";
import { defaultDifferencesFor } from "../lib/lab-builder/differences.js";
import { getProducts } from "../lib/lab-builder/products.js";
import { planLab } from "../lib/lab-builder/planner.js";
import { recommend } from "../lib/lab-builder/recommend.js";
import { getIndustries, getRoles } from "../lib/scenarios.js";
import { createFakeDom } from "./fixtures/fake-dom.js";
import { installInnerHtml, parseHtml } from "./fixtures/fake-html.js";

process.env.LAB_BUILDER_LINK_CHECK = "off";

const portalRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (name) => readFileSync(join(portalRoot, "public", name), "utf8");
const WIZARD = read("lab-builder-wizard.js");
const HTML = read("index.html");
const STAGE = HTML.slice(HTML.indexOf('<div class="lb-wizard-stage"'), HTML.indexOf('<div class="panel" id="lb-result-panel"'));

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const reply = (status, payload) => ({ ok: status >= 200 && status < 300, status, json: async () => clone(payload) });

function makeWizard() {
  const dom = createFakeDom();
  installInnerHtml(dom);
  const { document, FakeEvent } = dom;
  for (const node of parseHtml(STAGE, document)) document.body.appendChild(node);

  const h = { document, FakeEvent, recommendCalls: [], previewCalls: [], toasts: [] };
  const plan = (request) => {
    const p = planLab(request);
    return {
      title: p.title, slug: p.slug, difficulty: p.difficulty, duration: p.duration, totalMinutes: p.totalMinutes, estimate: p.estimate,
      agentName: p.profile.agentName,
      scenario: { problem: p.profile.problem, outcome: p.profile.outcome, sampleQuestions: p.profile.sampleQuestions },
      modules: p.features.map((f) => ({
        id: f.id, order: f.order, stepOrder: f.stepOrder ?? null, recapOrder: f.recapOrder ?? null, stepLabel: f.stepLabel, name: f.name,
        category: f.category, level: f.level, role: f.prerequisite ? "prerequisite" : "level", minutes: f.minutes, summary: f.summary,
        docUrls: f.docUrls || [], learnLinks: f.learnLinks || [],
      })),
      level: p.level, products: p.products, productNames: p.productNames, harness: p.harness,
      includeKnowledgeCheck: Boolean(p.includeKnowledgeCheck), requiresSharepointSite: false,
      sharepointSite: { name: null, url: null, label: null, configured: false },
      droppedOutOfLevel: [], moduleOrder: [], excludedSubtopics: p.request.excludedSubtopics || [],
      deferred: [], assumedPrereqs: [], relatedLabs: [], warnings: p.warnings,
    };
  };
  const context = vm.createContext({
    console,
    document,
    window: { scrollTo() {}, addEventListener() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    CSS: { escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&") },
    URL,
    Blob,
    setTimeout,
    escapeHtml: (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]),
    toast: (message, type) => h.toasts.push({ message, type }),
    setActiveTab() {},
    fetch: async (url, init = {}) => {
      const request = init.body ? JSON.parse(init.body) : {};
      if (url === "/api/lab-builder/recommend") {
        h.recommendCalls.push(request);
        try {
          return reply(200, recommend(request, { topics: [], checks: [] }));
        } catch (err) {
          return reply(400, { error: err.message });
        }
      }
      if (url === "/api/lab-builder/preview") {
        h.previewCalls.push(request);
        try {
          return reply(200, plan(request));
        } catch (err) {
          return reply(400, { error: err.message });
        }
      }
      if (String(url).startsWith("/api/lab-builder/")) return reply(200, { topics: [], checks: [], labs: [] });
      throw new Error(`Unexpected fetch ${url}`);
    },
  });
  vm.runInContext(WIZARD, context, { filename: "lab-builder-wizard.js" });
  const harnesses = getHarnesses();
  context.__seed = {
    products: getProducts(),
    harnesses,
    categories: getFeaturesByCategory(),
    industries: getIndustries(),
    roles: getRoles(),
    levels: [{ level: 100, label: "Beginner" }, { level: 200, label: "Intermediate" }, { level: 300, label: "Advanced" }],
    differenceDefaults: Object.fromEntries(harnesses.map((x) => [x.id, defaultDifferencesFor(x.id)])),
    learn: { topics: [], checks: [] },
  };
  vm.runInContext("Object.assign(labBuilder, __seed); labBuilder.loaded = true; lbBindTopicEvents(); lbRenderAllSteps();", context);

  h.context = context;
  h.run = (code) => vm.runInContext(code, context);
  h.state = (expr) => clone(vm.runInContext(`(${expr})`, context));
  h.settle = async () => {
    for (let i = 0; i < 16; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  h.byId = (id) => document.getElementById(id);
  h.text = (id) => h.byId(id).textContent;
  h.all = (selector) => [...document.querySelectorAll(selector)];
  h.change = async (el, mutate) => {
    assert.ok(el, "the control exists");
    // The fake DOM does not read a control's value from its attribute the way a browser does.
    if (el.value === "" && el.getAttribute("value")) el.value = el.getAttribute("value");
    mutate?.(el);
    el.dispatchEvent(new FakeEvent("change"));
    await h.settle();
  };
  h.click = async (el) => {
    assert.ok(el, "the control exists");
    el.click();
    await h.settle();
  };
  /** Choose products the way a person does: one click on each product card's checkbox. */
  h.chooseProducts = async (...ids) => {
    for (const id of ids) {
      const box = h.all("#lb-product-options input").find((input) => input.getAttribute("value") === id);
      await h.change(box, (el) => {
        el.checked = true;
      });
    }
  };
  h.step = () => h.state("labBuilder.step");
  h.lastRecommend = () => h.recommendCalls[h.recommendCalls.length - 1];
  return h;
}

const valueOf = (el) => el.getAttribute("value");
const radiosOf = (h, name) => h.all(`input[name="${name}"]`);
const checkedValue = (h, name) => {
  const found = radiosOf(h, name).find((input) => input.checked);
  return found ? valueOf(found) : null;
};

test("the wizard has four steps and every heading says Step N of 4", async () => {
  const h = makeWizard();
  await h.chooseProducts("copilot-studio");
  const labels = h.all("#lb-steps button").map((b) => b.textContent.replace(/^\d+\s*/, "").trim());
  assert.deepEqual(labels, ["Product", "Tailor it", "Topics", "Review and build"]);
  assert.deepEqual([1, 2, 3, 4].map((n) => h.text(`lb-heading-${n}`).match(/^Step \d of \d+/)[0]), ["Step 1 of 4", "Step 2 of 4", "Step 3 of 4", "Step 4 of 4"]);
  assert.equal(h.text("lb-sticky-next"), "Next: Tailor it →");
  await h.run("lbNextStep()");
  assert.equal(await h.step(), 2);
  assert.equal(h.text("lb-sticky-next"), "Next: Topics →");
  assert.equal(h.byId("lb-pane-2").style.display, "");
  assert.equal(h.byId("lb-pane-1").style.display, "none");
});

test("Tailor it shows every default selected and says so in one line each", async () => {
  const h = makeWizard();
  await h.chooseProducts("copilot-studio");
  await h.run("lbNextStep()");
  await h.settle();

  assert.equal(h.byId("lb-industry-select").value, "", "Cross-industry is the selected option");
  assert.equal(h.text("lb-industry-hint"), "Cross-industry is selected. Not sure? Keep it.");

  assert.equal(h.byId("lb-role-all").checked, true, "All departments is visibly selected");
  assert.equal(radiosOf(h, "lb-role").filter((input) => input.checked).length, 0);
  assert.match(h.text("lb-role-hint"), /^All departments is selected\. Not sure\? Keep it\./);

  assert.equal(checkedValue(h, "lb-level"), "100", "the default level is selected");
  assert.match(h.text("lb-level-hint"), /^Level 100 \(Beginner\) is selected\./);
  assert.ok(h.all("#lb-level-options .lb-seg-count").every((el) => /· \d+ topics?$|No topics yet$/.test(el.textContent)), "each level shows its topic count inline");

  assert.equal(h.byId("lb-harness-row").hidden, false);
  assert.equal(checkedValue(h, "lb-harness"), "standard");
  assert.equal(h.text("lb-harness-hint"), "Standard harness is selected. Not sure? Keep it.");
  const differences = h.all("#lb-differences-options input");
  assert.deepEqual(differences.filter((el) => el.checked).map(valueOf), ["microsoft-copilot"]);
  assert.match(h.byId("lb-differences-options").innerHTML, /Compare with <strong>Microsoft Copilot harness<\/strong>/);

  assert.match(h.text("lb-summary"), /Copilot Studio · Cross-industry · All departments · Level 100 \(Beginner\) · Standard harness/);
});

test("a product without harnesses never shows the harness choice, and the request carries no harness", async () => {
  const h = makeWizard();
  await h.chooseProducts("sharepoint-ai");
  await h.run("lbNextStep()");
  await h.settle();
  assert.equal(h.byId("lb-harness-row").hidden, true);
  assert.equal(h.byId("lb-harness-options").innerHTML.trim(), "");
  assert.equal(h.lastRecommend().harness, undefined);
  assert.equal(h.state("lbRequest().harness"), undefined);
  assert.doesNotMatch(h.text("lb-summary"), /harness/i);

  // Adding a product that has harnesses brings the choice back, with its default selected.
  await h.run("lbPrevStep()");
  await h.chooseProducts("copilot-studio");
  await h.run("lbNextStep()");
  await h.settle();
  assert.equal(h.byId("lb-harness-row").hidden, false);
  assert.equal(checkedValue(h, "lb-harness"), "standard");
  assert.equal(h.lastRecommend().harness, "standard");
});

test("every Tailor answer refreshes the recommendation, and the summary follows", async () => {
  const h = makeWizard();
  await h.chooseProducts("copilot-studio");
  await h.run("lbNextStep()");
  await h.settle();

  const industry = h.byId("lb-industry-select");
  await h.change(industry, (el) => {
    el.value = "retail";
  });
  assert.equal(h.lastRecommend().industry, "retail");
  assert.equal(h.text("lb-industry-hint"), "Retail is selected. The scenario, sample questions, and vocabulary follow it.");

  const sales = radiosOf(h, "lb-role").find((input) => valueOf(input) === "sales");
  await h.change(sales, (el) => {
    el.checked = true;
  });
  assert.deepEqual(h.lastRecommend().departments, ["sales"]);
  assert.equal(h.byId("lb-role-all").checked, false, "All departments lets go once a department is chosen");
  assert.match(h.text("lb-role-hint"), /^Sales is selected\./);

  await h.change(h.byId("lb-role-all"), (el) => {
    el.checked = true;
  });
  assert.deepEqual(h.lastRecommend().departments, []);
  assert.equal(radiosOf(h, "lb-role").filter((input) => input.checked).length, 0);

  const level200 = radiosOf(h, "lb-level").find((input) => valueOf(input) === "200");
  await h.change(level200, (el) => {
    el.checked = true;
  });
  assert.equal(h.lastRecommend().level, 200);
  assert.match(h.text("lb-level-hint"), /^Level 200 \(Intermediate\) is selected\./);

  const microsoftCopilot = radiosOf(h, "lb-harness").find((input) => valueOf(input) === "microsoft-copilot");
  await h.change(microsoftCopilot, (el) => {
    el.checked = true;
  });
  assert.equal(h.lastRecommend().harness, "microsoft-copilot");
  assert.equal(h.text("lb-harness-hint"), "Microsoft Copilot harness is selected.");

  assert.match(h.text("lb-summary"), /Copilot Studio · Retail · All departments · Level 200 \(Intermediate\) · Microsoft Copilot harness/);
  const request = h.state("lbRequest()");
  assert.deepEqual([request.industry, request.roles, request.level, request.harness], ["retail", [], 200, "microsoft-copilot"]);
});

test("Topics arrives with the suggestion selected, and a level change only announces the person's own picks", async () => {
  const h = makeWizard();
  await h.chooseProducts("copilot-studio");
  await h.run("lbNextStep()");
  await h.settle();

  // Arriving on Topics with nothing chosen yet selects the suggestion; nobody clicked Select recommended.
  await h.run("lbNextStep()");
  await h.settle();
  assert.equal(await h.step(), 3);
  const suggested = h.state("labBuilder.rec.recommendedIds");
  assert.ok(suggested.length > 0);
  assert.deepEqual(h.state("[...labBuilder.picked]"), suggested);
  assert.equal(h.state("labBuilder.pickedAuto"), true);
  assert.match(h.text("lb-topic-summary"), /^Suggested lab: \d+ topics?/);

  // An untouched suggestion is not "the person's choices": changing the level just recomputes it, with no notice.
  await h.run("lbGoToStep(2)");
  await h.settle();
  await h.change(radiosOf(h, "lb-level").find((input) => valueOf(input) === "200"), (el) => {
    el.checked = true;
  });
  assert.equal(h.byId("lb-level-notice-2").textContent, "");
  assert.equal(h.state("labBuilder.picked"), null);
  await h.run("lbNextStep()");
  await h.settle();
  assert.deepEqual(h.state("[...labBuilder.picked]"), h.state("labBuilder.rec.recommendedIds"), "Level 200 starts from its own suggestion");

  // Back to Level 100, then change one pick: now there is something of the person's to announce and restore.
  await h.run("lbGoToStep(2)");
  await h.settle();
  await h.change(radiosOf(h, "lb-level").find((input) => valueOf(input) === "100"), (el) => {
    el.checked = true;
  });
  await h.run("lbNextStep()");
  await h.settle();
  const own = h.state("[...labBuilder.picked]");
  await h.run(`lbSetTopic(${JSON.stringify(own[0])}, false, false)`);
  await h.settle();
  assert.equal(h.state("labBuilder.pickedAuto"), false);
  assert.match(h.text("lb-topic-summary"), /^Your lab: /);
  const expected = h.state("[...labBuilder.picked]");

  await h.run("lbGoToStep(2)");
  await h.settle();
  await h.change(radiosOf(h, "lb-level").find((input) => valueOf(input) === "200"), (el) => {
    el.checked = true;
  });
  const notice = h.byId("lb-level-notice-2");
  assert.match(notice.textContent, /The level changed from Level 100 \(Beginner\) to Level 200 \(Intermediate\)\./);
  assert.match(notice.textContent, /Restore my Level 100 \(Beginner\) choices/);
  assert.equal(h.state("labBuilder.picked"), null);

  await h.click(notice.querySelector("[data-level-restore]"));
  assert.equal(await h.state("labBuilder.level"), 100);
  assert.equal(checkedValue(h, "lb-level"), "100", "Tailor it shows the restored level");
  assert.deepEqual(h.state("[...labBuilder.picked]"), expected, "the person's own picks come back exactly");
});

test("Review and build is one screen with one primary button, and the harness-era controls are gone", async () => {
  const h = makeWizard();
  assert.equal(h.byId("lb-generate-btn").textContent, "Build my lab");
  for (const id of ["lb-next-from-review", "lb-next-from-level", "lb-sharepoint-site-prompt", "lb-sharepoint-site-skip", "lb-step8-sharepoint-summary", "lb-step8-customize-summary", "lb-next-heading"]) {
    assert.equal(h.byId(id), null, `${id} no longer exists`);
  }
  const pane = h.byId("lb-pane-4");
  const primary = pane.querySelectorAll(".btn-primary");
  assert.equal(primary.length, 1, "exactly one primary button on Review and build");
  assert.equal(primary[0].id, "lb-generate-btn");
  assert.equal(h.byId("lb-customize-card").hidden, true, "the brand card stays closed until it is asked for");
  assert.equal(h.byId("lb-brand-change").getAttribute("aria-expanded"), "false");
  await h.click(h.byId("lb-brand-change"));
  assert.equal(h.byId("lb-customize-card").hidden, false);
  assert.equal(h.byId("lb-brand-change").getAttribute("aria-expanded"), "true");
  assert.equal(h.byId("lb-brand-change").textContent, "Hide");
  await h.click(h.byId("lb-brand-change"));
  assert.equal(h.byId("lb-customize-card").hidden, true);

  await h.chooseProducts("copilot-studio");
  await h.run("lbGoToStep(3); lbSelectRecommended()");
  await h.settle();
  await h.run("lbNextStep()");
  await h.settle();
  assert.equal(await h.step(), 4);
  assert.equal(h.text("lb-sticky-next"), "Build my lab");
  assert.equal(h.byId("lb-pane-4").style.display, "");
});

test("the SharePoint site is optional: a blank site never blocks a build, a typed bad address does", async () => {
  const h = makeWizard();
  await h.chooseProducts("sharepoint-ai");
  await h.run("lbGoToStep(3); lbSelectRecommended()");
  await h.settle();
  await h.run("lbNextStep()");
  await h.settle();
  assert.equal(await h.step(), 4);
  assert.equal(h.byId("lb-sharepoint-site-card").hidden, false);
  assert.match(h.text("lb-sharepoint-site-hint"), /Leave both blank\. Learners then see placeholder instructions/);
  assert.equal(h.byId("lb-sharepoint-site-hint").hidden, false);

  assert.equal(h.run("lbValidateSharepointSiteForBuild()"), true, "blank is fine");
  assert.equal(h.text("lb-sharepoint-site-error"), "");
  assert.equal(await h.step(), 4, "nothing moved the person to another step");
  assert.equal(h.state("lbRequest().sharepointSiteUrl"), undefined);

  const url = h.byId("lb-sharepoint-site-url");
  url.value = "not a url";
  assert.equal(h.run("lbValidateSharepointSiteForBuild()"), false);
  assert.match(h.text("lb-sharepoint-site-error"), /valid/);
  assert.equal(url.getAttribute("aria-invalid"), "true");

  url.value = "https://fabrikam.sharepoint.com/sites/Training";
  url.dispatchEvent(new h.FakeEvent("input"));
  assert.equal(h.run("lbValidateSharepointSiteForBuild()"), true);
  assert.equal(h.byId("lb-sharepoint-site-hint").hidden, true, "the hint goes away once a site is entered");
  assert.equal(h.state("lbRequest().sharepointSiteUrl"), "https://fabrikam.sharepoint.com/sites/Training");
});

test("lbPlainText says catalog ids and the lab's own 'recap' word in plain words, and leaves everything else alone", async () => {
  const h = makeWizard();
  const plain = (text) => h.run(`lbPlainText(${JSON.stringify(text)})`);
  const nameOf = (id) => getFeaturesByCategory().flatMap((category) => category.features).find((feature) => feature.id === id).name;

  // Catalog ids become the topic's name in quotes; an id the catalog does not know becomes "the matching topic".
  assert.equal(plain("see mc-knowledge for those steps"), `see "${nameOf("mc-knowledge")}" for those steps`);
  assert.equal(plain("Uses mc-knowledge and mc-skills."), `Uses "${nameOf("mc-knowledge")}" and "${nameOf("mc-skills")}".`);
  assert.equal(plain("see mc-not-a-topic for those steps"), "see the matching topic for those steps");
  assert.equal(plain("Compare standard and microsoft-copilot"), "Compare standard and microsoft-copilot", "other hyphenated words are not ids");
  assert.equal(plain("The semc-knowledge mc_knowledge"), "The semc-knowledge mc_knowledge", "only whole mc- ids are replaced");

  // 'recap' is the lab file's word; the portal says refresher, keeping the case of the first letter and the plural.
  assert.equal(plain("The recap covers it. Recaps are short."), "The refresher covers it. Refreshers are short.");
  assert.equal(plain("A prerequisite recap helps. Prerequisite recaps too."), "A refresher helps. Refreshers too.");
  assert.equal(plain("Added 2 prerequisite recap(s) and a Recap(s)."), "Added 2 refresher(s) and a Refresher(s).");
  assert.equal(plain("Recap: Create an agent"), "Refresher: Create an agent");
  assert.equal(plain("recapitulate the recapped steps"), "recapitulate the recapped steps", "only the word recap");

  // The catalog's own wording about itself.
  assert.equal(plain("It is not in this repository's reviewed catalog."), "It is not in the reviewed catalog.");

  for (const empty of ["", null, undefined]) assert.equal(h.run(`lbPlainText(${JSON.stringify(empty ?? null)})`), "");
  assert.equal(plain("Nothing to change here."), "Nothing to change here.");
});

test("row reasons, harness notes, and every warning on Topics and Review and build go through lbPlainText", async () => {
  const h = makeWizard();
  await h.chooseProducts("copilot-studio");
  const knowledge = getFeaturesByCategory().flatMap((category) => category.features).find((feature) => feature.id === "mc-knowledge").name;
  const escapedKnowledge = knowledge.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  // A row's Why: and harness note, in its details.
  const row = h.run(`lbTopicCard(${JSON.stringify({
    id: "demo-topic", name: "Demo topic", summary: "A demo.", minutes: 10, level: 200, selected: true, required: false, source: "catalog",
    reasons: ["Required by Contoso topic; see mc-knowledge for those steps. A recap helps.", "Recommended for level 200"],
    harnessNote: "On this harness use mc-skills instead.",
  })})`);
  assert.match(row, new RegExp(`<span class="lb-topic-reason">Why: Required by Contoso topic; see &quot;${escapedKnowledge.replace(/[()]/g, "\\$&")}&quot; for those steps\\. A refresher helps\\.</span>`));
  assert.doesNotMatch(row, /Recommended for level|mc-knowledge|recap/i);
  assert.match(row, /<span class="lb-feature-note">On this harness use &quot;[^&]+&quot; instead\.<\/span>/);

  // Topics warnings: dependency warnings and the recommendation's own.
  const rec = recommend({ products: ["copilot-studio"], level: 200, harness: "standard" }, { topics: [], checks: [] });
  rec.warnings = ["Added 2 recaps; see mc-knowledge for those steps."];
  rec.dependencyWarnings = [{ message: "The prerequisite recap needs mc-unknown-topic." }];
  h.context.__rec = rec;
  h.run("labBuilder.rec = __rec; lbRenderTopics()");
  const warnings = h.text("lb-topic-warnings");
  assert.match(warnings, new RegExp(`Added 2 refreshers; see "${knowledge.replace(/[()]/g, "\\$&")}" for those steps\\.`));
  assert.match(warnings, /The refresher needs the matching topic\./);
  assert.doesNotMatch(warnings, /recap|mc-/i);

  // Review and build warnings come back from the plan with the lab's wording.
  const real = h.context.fetch;
  h.context.fetch = async (url, init) => {
    const res = await real(url, init);
    if (url !== "/api/lab-builder/preview") return res;
    const data = await res.json();
    return reply(200, { ...data, warnings: [...data.warnings, "Added 1 prerequisite recap; see mc-knowledge for those steps."] });
  };
  h.run(`labBuilder.picked = new Set(["create-agent"]); labBuilder.chosenSteps = new Set(["product", "tailor", "topics"]);`);
  await h.run("lbRefresh()");
  await h.settle();
  await h.run("lbGoToStep(4)");
  await h.settle();
  const review = h.text("lb-preview");
  assert.match(review, /Added 1 refresher; see ".+" for those steps\./);
  assert.doesNotMatch(review, /recap|mc-knowledge/i);
});

test("lbModuleLabel maps the lab's Step and Recap labels to Part and Refresher, and only at the start of the label", async () => {
  const h = makeWizard();
  const label = (text) => h.run(`lbModuleLabel(${JSON.stringify(text)})`);
  assert.equal(label("Step 3"), "Part 3");
  assert.equal(label("Recap 1"), "Refresher 1");
  assert.equal(label("step 12 - Add knowledge"), "Part 12 - Add knowledge");
  assert.equal(label("  Recap 2: Create an agent"), "Refresher 2: Create an agent");
  assert.equal(label("Module 4"), "Module 4", "other labels are left alone");
  assert.equal(label("Optional Step 2"), "Optional Step 2", "only a leading Step or Recap is mapped");
  assert.equal(label("Stepping up"), "Stepping up", "a word that starts with Step is not a step label");
  assert.equal(h.run("lbModuleLabel(null)"), "");
  assert.equal(h.run("lbModuleLabel(undefined)"), "");
});

test("the Review outline's Edit order column is headed Part and says Part N and Refresher N, and the split note says session", async () => {
  const h = makeWizard();
  await h.chooseProducts("copilot-studio");
  h.run(`labBuilder.level = 200; labBuilder.picked = new Set(["connector-tools"]); labBuilder.chosenSteps = new Set(["product", "tailor", "topics"]);`);
  h.byId("lb-time").value = "30";
  await h.run("lbRefresh()");
  await h.settle();
  await h.run("lbGoToStep(4)");
  await h.settle();

  const headers = () => h.all("#lb-preview thead th").map((th) => th.textContent);
  const partCells = () => h.all("#lb-preview tbody tr").filter((tr) => tr.querySelector("input[data-outline-module]")).map((tr) => tr.querySelectorAll("td")[2]?.textContent);
  assert.deepEqual(headers(), ["Include", "Module", "Estimated time"], "compact by default");
  assert.deepEqual(partCells(), [undefined, undefined, undefined, undefined]);

  await h.click(h.byId("lb-preview").querySelector('button[data-outline-action="toggle-edit"]'));
  assert.deepEqual(headers(), ["Include", "Order", "Part", "Module", "Estimated time"]);
  assert.deepEqual(partCells(), ["Refresher 1", "Refresher 2", "Part 1", "Part 2"], "refreshers first, then the lab's own parts");
  const titles = h.all("#lb-preview tbody label.lb-outline-module-label").map((label) => label.textContent);
  assert.deepEqual(titles.map((title) => title.startsWith("Refresher: ")), [true, true, false, false]);
  const preview = h.text("lb-preview");
  assert.match(preview, /Optional session \d+: \d+ modules?, about /, "the split note calls each piece a session");
  assert.doesNotMatch(preview, /Optional part|\bStep \d|\bRecap \d/);
});

test("a refresher removed from the outline is listed as a Refresher, with the refresher wording in its note", async () => {
  const h = makeWizard();
  await h.chooseProducts("copilot-studio");
  h.run(`labBuilder.level = 200; labBuilder.picked = new Set(["connector-tools"]); labBuilder.chosenSteps = new Set(["product", "tailor", "topics"]);`);
  await h.run("lbRefresh()");
  await h.settle();
  await h.run("lbGoToStep(4)");
  await h.settle();
  await h.run(`lbSetOutlineModule("create-agent", false)`);
  await h.run(`lbSetOutlineModule("connector-tools", false)`);
  await h.settle();

  const removed = h.byId("lb-preview").querySelector(".lb-removed-section");
  assert.ok(removed, "the Removed from curriculum section is listed");
  const item = removed.querySelector('input[data-outline-module="create-agent"]').closest("label");
  assert.match(item.querySelector(".lb-feature-name").textContent, /^Refresher: /);
  assert.equal(item.querySelector(".lb-badge-recap").textContent, "Refresher");
  assert.equal(item.querySelector(".lb-feature-summary").textContent, "Included as a refresher once a dependent Level 200 module is selected, or select Restore all.");
  assert.doesNotMatch(removed.textContent, /recap/i);
});

test("a product that comes in more than one agent experience says so on its card", async () => {
  const h = makeWizard();
  const card = (id) => h.all("#lb-product-options label").find((label) => label.querySelector(`input[value="${id}"]`));
  const badge = card("copilot-studio").querySelector(".lb-badge-harness");
  assert.equal(badge.textContent.replace(/\.$/, ""), "Choose an agent experience");
  assert.match(badge.getAttribute("title"), /more than one agent experience, called a harness\. You choose one on the next step\./);
  assert.equal(card("sharepoint-ai").querySelector(".lb-badge-harness"), null, "a product without harnesses has no such badge");
  assert.doesNotMatch(h.byId("lb-product-options").innerHTML, /Has harnesses/);
});

test("the summary bar stays out of the way until a product is chosen, appears with the first one, and goes again when none is left", async () => {
  const h = makeWizard();
  const bar = h.byId("lb-summary").closest(".lb-summary-bar");
  assert.ok(bar, "the summary and its buttons share one bar");
  assert.equal(bar.hidden, true, "nothing to summarize yet, so no bar");
  assert.equal(h.text("lb-summary"), "Your lab so far: nothing yet.", "the text is still there for a screen reader that reaches it");
  assert.equal(h.byId("lb-save-draft").hidden, true);
  assert.match(HTML, /\.lb-summary-bar\[hidden\]\s*\{\s*display:\s*none;\s*\}/, "a hidden bar takes no space");

  await h.chooseProducts("copilot-studio");
  assert.equal(bar.hidden, false);
  assert.equal(h.text("lb-summary"), "Your lab so far: Copilot Studio");
  assert.equal(h.byId("lb-save-draft").hidden, false, "Save and finish later appears with the first product");

  // Taking the product away again empties the wizard, so the bar goes too.
  const box = h.all("#lb-product-options input").find((input) => input.getAttribute("value") === "copilot-studio");
  await h.change(box, (el) => {
    el.checked = false;
  });
  assert.equal(h.state("labBuilder.selectedProducts.size"), 0);
  assert.equal(bar.hidden, true);
  assert.equal(h.byId("lb-save-draft").hidden, true);

  // Start over ends in the same place: an empty wizard with no bar.
  await h.chooseProducts("sharepoint-ai");
  assert.equal(bar.hidden, false);
  await h.run("lbStartNewLab()");
  await h.settle();
  assert.equal(bar.hidden, true);
  assert.equal(h.text("lb-summary"), "Your lab so far: nothing yet.");
});

test("Edit selections on a built lab still opens Review and build with every choice filled in", async () => {
  const h = makeWizard();
  const lab = {
    labId: "contoso-lab",
    title: "Contoso lab",
    selections: {
      products: ["copilot-studio"],
      industry: "healthcare",
      roles: ["sales", "it"],
      level: 200,
      harness: "microsoft-copilot",
      differencesFor: ["standard"],
      features: recommend({ products: ["copilot-studio"], level: 200, harness: "microsoft-copilot" }).recommendedIds.slice(0, 3),
      excluded: [],
      excludedSubtopics: [],
      moduleOrder: [],
      targetMinutes: 120,
      customTitle: "Contoso support lab",
      agentName: "Contoso Assistant",
      sharepointSiteName: "Contoso Team",
      sharepointSiteUrl: "https://contoso.sharepoint.com/sites/team",
      useLearnMcp: false,
      useLlm: false,
      includeKnowledgeCheck: true,
    },
  };
  await h.run(`lbLoadSelections(${JSON.stringify(lab)})`);
  await h.settle();

  assert.equal(await h.step(), 4, "it lands on Review and build");
  assert.equal(h.byId("lb-pane-4").style.display, "");
  assert.equal(h.text("lb-heading-4"), "Step 4 of 4: Review and build your lab");
  assert.equal(h.byId("lb-edit-banner").hidden, false);

  assert.equal(h.byId("lb-industry-select").value, "healthcare");
  assert.deepEqual(radiosOf(h, "lb-role").filter((input) => input.checked).map(valueOf).sort(), ["it", "sales"]);
  assert.equal(h.byId("lb-role-all").checked, false);
  assert.equal(checkedValue(h, "lb-level"), "200");
  assert.equal(checkedValue(h, "lb-harness"), "microsoft-copilot");
  assert.deepEqual(h.all("#lb-differences-options input").filter((el) => el.checked).map(valueOf), ["standard"]);
  assert.equal(h.byId("lb-title").value, "Contoso support lab");
  assert.equal(h.byId("lb-agent-name").value, "Contoso Assistant");
  assert.equal(h.byId("lb-time").value, 120);
  assert.equal(h.byId("lb-include-knowledge-check").checked, true);
  assert.equal(h.byId("lb-sharepoint-site-name").value, "Contoso Team");
  assert.equal(h.byId("lb-sharepoint-site-url").value, "https://contoso.sharepoint.com/sites/team");
  assert.equal(h.previewCalls.length > 0, true, "the outline was planned from the saved choices");
});
