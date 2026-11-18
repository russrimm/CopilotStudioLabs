/**
 * Step 6 sub-topics, the Review step, and Export All Topics in the real wizard script.
 *
 * The browser scripts run inside node:vm against the fake DOM (with the small HTML parser from
 * fixtures/fake-html.js), the real markup of Steps 6 and 7 from index.html, and a fetch that answers
 * from the real recommend, planner, and export code. Nothing touches a network or a browser.
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
import { recommend } from "../lib/lab-builder/recommend.js";
import { planLab } from "../lib/lab-builder/planner.js";
import { listHash } from "../lib/lab-builder/topic-snapshot.js";
import { resetTopicSource, setTopicSource } from "../lib/lab-builder/topic-store.js";
import { topicId } from "../lib/lab-builder/topic-sanitize.js";
import { buildTopicExport, exportFileName, normalizeExportRequest, toCsv, toJson, toMarkdown } from "../lib/lab-builder/topic-export.js";
import { getIndustries, getRoles } from "../lib/scenarios.js";
import { createFakeDom } from "./fixtures/fake-dom.js";
import { installInnerHtml, parseHtml } from "./fixtures/fake-html.js";

process.env.LAB_BUILDER_LINK_CHECK = "off";

const portalRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (name) => readFileSync(join(portalRoot, "public", name), "utf8");
const WIZARD = read("lab-builder-wizard.js");
const HTML = read("index.html");
const PANES = HTML.slice(HTML.indexOf("<!-- Step 6: topics -->"), HTML.indexOf("<!-- Step 8: generate -->"));

const BASE = "https://learn.microsoft.com/microsoft-copilot-studio";
const urlOf = (slug) => `${BASE}/${slug}`;

function topic(slug, title, subs = [], extra = {}) {
  const url = urlOf(slug);
  const subtopics = subs.map((sub) => ({
    id: sub.id || topicId(urlOf(sub.slug)),
    title: sub.title,
    url: sub.url || urlOf(sub.slug),
    ...(sub.summary ? { summary: sub.summary } : {}),
  }));
  return {
    id: topicId(url),
    title,
    summary: `${title} is a topic from Microsoft Learn.`,
    urls: [url, ...subtopics.map((sub) => sub.url)],
    harnesses: ["standard"],
    conceptId: "mcp",
    availability: null,
    status: "new",
    featureIds: [],
    level: 200,
    firstSeen: "2026-11-01",
    lastSeen: "2026-11-13",
    changedAt: null,
    contentHash: "aaaaaaaaaaaaaaaa",
    ...(subtopics.length ? { subtopics } : {}),
    ...extra,
  };
}

const ALPHA = topic("alpha-trigger", "Alpha trigger", [
  { slug: "alpha-trigger-overview", title: "Alpha trigger overview", summary: "What an alpha trigger is for." },
  { slug: "alpha-trigger-examples", title: "Alpha trigger examples", summary: "Three worked examples." },
  { slug: "alpha-trigger-limits", title: "Alpha trigger limits" },
]);
const BIG = topic(
  "big-topic",
  "Big topic",
  Array.from({ length: 9 }, (_, index) => ({ slug: `big-topic-part-${index + 1}`, title: `Big topic part ${index + 1}`, summary: index === 8 ? "The zebra stripes chapter." : undefined })),
);
const PLAIN = topic("plain-topic", "Plain topic");
const HOSTILE = topic("hostile-topic", "Hostile topic", [
  { id: "learn-hostile-js", title: "<img src=x onerror=alert(1)>", url: "javascript:alert(1)", summary: "<b>bold</b> & \"quoted\"" },
  { slug: "hostile-two", title: "\"><script>alert(2)</script>" },
]);
const FORMULAS = topic("formula-topic", '=HYPERLINK("https://evil.example","click")', [
  { slug: "formula-plus", title: "+cmd|' /C calc'!A0" },
  { slug: "formula-minus", title: "-2+3" },
  { slug: "formula-at", title: "@SUM(1+1)" },
]);
const TOPICS = [ALPHA, BIG, PLAIN, HOSTILE, FORMULAS];
const SUBTOPIC_TOTAL = TOPICS.reduce((sum, t) => sum + (t.subtopics?.length || 0), 0);

function snapshotOf(topics) {
  const snapshot = { schemaVersion: 1, generatedAt: "2026-11-13T12:00:00Z", source: "test", catalogVersion: "test", topics, catalog: [], pageHashes: {} };
  snapshot.listHash = listHash(snapshot);
  return snapshot;
}

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const reply = (status, payload) => ({ ok: status >= 200 && status < 300, status, json: async () => clone(payload) });

// ── The harness ─────────────────────────────────────────────────────────────

function makeWizard(t) {
  const snapshot = snapshotOf(TOPICS);
  setTopicSource({ source: "cache", snapshot });
  t.after(() => resetTopicSource());
  const learn = { topics: snapshot.topics, checks: [], updatedWindowDays: 30, now: Date.parse("2026-11-18T12:00:00Z") };

  const dom = createFakeDom();
  installInnerHtml(dom);
  const { document, FakeEvent } = dom;
  const body = document.body;
  for (const node of parseHtml(PANES, document)) body.appendChild(node);
  const original = document.getElementById.bind(document);
  document.getElementById = (id) => {
    const found = original(id);
    if (found) return found;
    const el = document.createElement(/^lb-(title|time|agent-name|topic-search|sharepoint-site-(name|url))$/.test(id) ? "input" : "div");
    el.id = id;
    body.appendChild(el);
    return el;
  };

  const h = { document, FakeEvent, recommendCalls: [], previewCalls: [], exportCalls: [], blobs: [], downloads: [], toasts: [], offline: false };
  const harnesses = getHarnesses();
  const plan = (request) => {
    const p = planLab(request);
    return {
      title: p.title,
      slug: p.slug,
      difficulty: p.difficulty,
      duration: p.duration,
      totalMinutes: p.totalMinutes,
      estimate: p.estimate,
      agentName: p.profile.agentName,
      scenario: { problem: p.profile.problem, outcome: p.profile.outcome, sampleQuestions: p.profile.sampleQuestions },
      modules: p.features.map((f) => ({
        id: f.id,
        order: f.order,
        stepOrder: f.stepOrder ?? null,
        recapOrder: f.recapOrder ?? null,
        stepLabel: f.stepLabel,
        name: f.name,
        category: f.category,
        level: f.level,
        role: f.prerequisite ? "prerequisite" : "level",
        minutes: f.minutes,
        summary: f.summary,
        docUrls: f.docUrls || [],
        learnLinks: f.learnLinks || [],
        ...(f.learnTopic?.subtopicChoices?.length ? { subtopics: f.learnTopic.subtopicChoices } : {}),
      })),
      level: p.level,
      products: p.products,
      productNames: p.productNames,
      harness: p.harness,
      includeKnowledgeCheck: Boolean(p.includeKnowledgeCheck),
      requiresSharepointSite: false,
      sharepointSite: { name: null, url: null, label: null, configured: false },
      droppedOutOfLevel: [],
      moduleOrder: [],
      excludedSubtopics: p.request.excludedSubtopics || [],
      deferred: [],
      assumedPrereqs: [],
      relatedLabs: [],
      warnings: p.warnings,
    };
  };
  class FakeURL extends URL {
    static createObjectURL(blob) {
      h.blobs.push(blob);
      return `blob:fake/${h.blobs.length}`;
    }

    static revokeObjectURL() {}
  }
  const realCreate = document.createElement.bind(document);
  document.createElement = (tag) => {
    const el = realCreate(tag);
    if (String(tag).toLowerCase() === "a") h.downloads.push(el);
    return el;
  };
  const context = vm.createContext({
    console,
    document,
    window: { scrollTo() {}, addEventListener() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    CSS: { escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&") },
    URL: FakeURL,
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
          return reply(200, recommend(request, learn));
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
      if (url === "/api/lab-builder/topics/export") {
        h.exportCalls.push(request);
        if (h.offline) throw new TypeError("Failed to fetch");
        try {
          return reply(200, { dataset: buildTopicExport({ ...normalizeExportRequest(request), learn }) });
        } catch (err) {
          return reply(400, { error: err.message });
        }
      }
      if (String(url).startsWith("/api/lab-builder/")) return reply(200, { topics: [], checks: [], labs: [] });
      throw new Error(`Unexpected fetch ${url}`);
    },
  });
  vm.runInContext(WIZARD, context, { filename: "lab-builder-wizard.js" });
  context.__seed = {
    products: getProducts(),
    harnesses,
    categories: getFeaturesByCategory(),
    industries: getIndustries(),
    roles: getRoles(),
    levels: [{ level: 100, label: "Beginner" }, { level: 200, label: "Intermediate" }, { level: 300, label: "Advanced" }],
    differenceDefaults: Object.fromEntries(harnesses.map((x) => [x.id, defaultDifferencesFor(x.id)])),
  };
  vm.runInContext(
    `Object.assign(labBuilder, __seed);
     labBuilder.loaded = true;
     labBuilder.selectedProducts = new Set(["copilot-studio"]);
     labBuilder.level = 200;
     labBuilder.harness = "standard";
     labBuilder.step = LB_STEP.topics;
     lbBindTopicEvents();`,
    context,
  );
  h.context = context;
  h.run = (code) => vm.runInContext(code, context);
  h.state = (expr) => clone(vm.runInContext(`(${expr})`, context));
  h.settle = async () => {
    for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  h.refresh = async () => {
    h.run("lbRefresh()");
    await h.settle();
  };
  h.byId = (id) => document.getElementById(id);
  h.q = (selector) => h.byId("lb-topic-groups").querySelector(selector);
  h.qa = (selector) => h.byId("lb-topic-groups").querySelectorAll(selector);
  h.sub = (id) => h.q(`input[data-subtopic="${id}"]`);
  h.parent = (id) => h.q(`input[data-topic="${id}"]`);
  /** What a click on a checkbox does: toggle it, then tell the page. */
  h.toggle = async (input) => {
    assert.ok(input, "the checkbox exists");
    input.checked = !input.checked;
    input.dispatchEvent(new FakeEvent("change"));
    await h.settle();
  };
  h.press = async (el, key) => {
    el.dispatchEvent(new FakeEvent("keydown", { key }));
    await h.settle();
  };
  return h;
}

const subIds = (t) => t.subtopics.map((sub) => sub.id);

// ── Step 6: nested, individually checkable sub-topics ───────────────────────

test("every sub-topic of every listed topic is its own checkbox inside a labeled group", async (t) => {
  const h = makeWizard(t);
  await h.refresh();
  const total = h.qa("input[data-subtopic]").length;
  // BIG shows its first six and a button for the other three, so everything else is on the page at once.
  assert.equal(total, SUBTOPIC_TOTAL - 3);
  for (const topicRow of [ALPHA, HOSTILE, FORMULAS]) {
    const group = h.q(`fieldset#lb-subtopics-${topicRow.id}`);
    assert.ok(group, `${topicRow.title} has a sub-topic group`);
    assert.equal(group.querySelector("legend").textContent.startsWith(`${topicRow.subtopics.length} sub-topic`), true);
    assert.equal(group.querySelectorAll("input[type=checkbox]").length, topicRow.subtopics.length);
    for (const sub of topicRow.subtopics) assert.ok(h.sub(sub.id), `${sub.title} is a checkbox`);
  }
  assert.equal(h.q(`fieldset#lb-subtopics-${PLAIN.id}`), null, "a topic without sub-topics keeps its plain card");
  assert.ok(h.parent(PLAIN.id).closest("label.lb-feature"), "and its checkbox is still the whole card's label");
  const parentCard = h.parent(ALPHA.id).closest(".lb-feature-parent");
  assert.ok(parentCard.contains(h.sub(subIds(ALPHA)[0])));
  for (const input of h.qa("input[data-subtopic]")) {
    assert.ok(input.closest("label"), "each sub-topic checkbox has a label");
    const described = input.getAttribute("aria-describedby");
    if (described) assert.ok(h.byId(described), `aria-describedby ${described} points at a real element`);
  }
});

test("a long sub-topic list shows its first few and says how many more, and nothing is silently dropped", async (t) => {
  const h = makeWizard(t);
  await h.refresh();
  assert.equal(h.qa(`#lb-subtopics-${BIG.id} input[data-subtopic]`).length, 6);
  const more = h.q(`button[data-subtopic-more="${BIG.id}"]`);
  assert.equal(more.textContent, "Show 3 more sub-topics");
  assert.equal(more.getAttribute("aria-expanded"), "false");
  assert.equal(more.getAttribute("aria-controls"), `lb-subtopics-${BIG.id}`);
  more.focus();
  more.dispatchEvent(new h.FakeEvent("click"));
  await h.settle();
  assert.equal(h.qa(`#lb-subtopics-${BIG.id} input[data-subtopic]`).length, 9);
  const fewer = h.q(`button[data-subtopic-more="${BIG.id}"]`);
  assert.equal(fewer.textContent, "Show fewer sub-topics");
  assert.equal(fewer.getAttribute("aria-expanded"), "true");
  assert.equal(h.byId("lb-topic-count").textContent.includes(`${SUBTOPIC_TOTAL} sub-topics`), true, "the status line counts all of them, shown or not");
});

test("selecting a topic selects all of its sub-topics, and the topic's checkbox is checked", async (t) => {
  const h = makeWizard(t);
  await h.refresh();
  await h.toggle(h.parent(ALPHA.id));
  assert.equal(h.parent(ALPHA.id).checked, true);
  assert.equal(h.parent(ALPHA.id).indeterminate === true, false);
  assert.equal(h.parent(ALPHA.id).getAttribute("data-subtopic-state"), "all");
  for (const sub of ALPHA.subtopics) assert.equal(h.sub(sub.id).checked, true);
  assert.deepEqual(h.recommendCalls.at(-1).selected, [ALPHA.id]);
  assert.equal(h.recommendCalls.at(-1).excludedSubtopics, undefined, "no exclusion is sent when every sub-topic is included");
  assert.equal(h.state("labBuilder.rec.totals.subtopicCount"), 3);
});

test("unchecking a sub-topic leaves the topic in the mixed state and sends the exclusion", async (t) => {
  const h = makeWizard(t);
  await h.refresh();
  await h.toggle(h.parent(ALPHA.id));
  const [first, second, third] = subIds(ALPHA);
  await h.toggle(h.sub(first));
  assert.equal(h.sub(first).checked, false);
  assert.equal(h.sub(second).checked, true);
  assert.equal(h.parent(ALPHA.id).indeterminate, true);
  assert.equal(h.parent(ALPHA.id).checked, false, "a mixed checkbox is not also checked, so one click selects all");
  assert.equal(h.parent(ALPHA.id).getAttribute("data-subtopic-state"), "some");
  assert.deepEqual(h.recommendCalls.at(-1).excludedSubtopics, [first]);
  assert.equal(h.byId("lb-subtopics-" + ALPHA.id).querySelector("legend").textContent, "3 sub-topics from Microsoft Learn: 2 included");

  await h.toggle(h.sub(second));
  await h.toggle(h.sub(third));
  assert.equal(h.parent(ALPHA.id).indeterminate, true, "with every sub-topic left out the topic's own article is still included");
  assert.equal(h.state("labBuilder.rec.selectedIds").includes(ALPHA.id), true);
  assert.equal(h.state("labBuilder.rec.totals.subtopicCount"), 0);

  await h.toggle(h.sub(first));
  await h.toggle(h.sub(second));
  await h.toggle(h.sub(third));
  assert.equal(h.parent(ALPHA.id).checked, true, "checking them all again restores the checked state");
  assert.equal(h.parent(ALPHA.id).indeterminate === true, false);
  assert.equal(h.state("labBuilder.excludedSubtopics.size"), 0);
});

test("toggling the topic toggles all of its sub-topics; checking one under an unselected topic selects the topic with only that one", async (t) => {
  const h = makeWizard(t);
  await h.refresh();
  const [first, second, third] = subIds(ALPHA);
  await h.toggle(h.sub(second));
  assert.equal(h.parent(ALPHA.id).checked, false);
  assert.equal(h.parent(ALPHA.id).indeterminate, true);
  assert.equal(h.sub(second).checked, true);
  assert.equal(h.sub(first).checked, false);
  assert.deepEqual(h.recommendCalls.at(-1).excludedSubtopics, [first, third].sort());
  assert.deepEqual(h.recommendCalls.at(-1).selected, [ALPHA.id]);

  await h.toggle(h.parent(ALPHA.id));
  assert.equal(h.parent(ALPHA.id).checked, true, "a click on a mixed checkbox selects all");
  for (const id of subIds(ALPHA)) assert.equal(h.sub(id).checked, true);

  await h.toggle(h.parent(ALPHA.id));
  assert.equal(h.parent(ALPHA.id).checked, false);
  for (const id of subIds(ALPHA)) assert.equal(h.sub(id).checked, false, "unchecking the topic unchecks every sub-topic");
  assert.equal(h.state("labBuilder.excludedSubtopics.size"), 0, "and starts it clean for next time");
});

test("Select all, Clear, Select recommended, Reset, and the group buttons all understand sub-topics", async (t) => {
  const h = makeWizard(t);
  await h.refresh();
  await h.toggle(h.sub(subIds(ALPHA)[0]));
  assert.equal(h.state("labBuilder.excludedSubtopics.size") > 0, true);

  h.run("lbSelectAllTopics()");
  await h.settle();
  assert.equal(h.state("labBuilder.excludedSubtopics.size"), 0, "Select all includes every sub-topic");
  assert.equal(h.sub(subIds(ALPHA)[0]).checked, true);
  assert.equal(h.state("labBuilder.rec.totals.subtopicCount"), SUBTOPIC_TOTAL);

  await h.toggle(h.sub(subIds(ALPHA)[1]));
  h.run("lbClearTopics()");
  await h.settle();
  assert.equal(h.state("labBuilder.excludedSubtopics.size"), 0, "Clear forgets sub-topic choices");
  assert.equal(h.sub(subIds(ALPHA)[0]).checked, false);
  assert.equal(h.state("labBuilder.rec.totals.subtopicCount"), 0);

  await h.toggle(h.sub(subIds(ALPHA)[2]));
  h.run("lbSelectRecommended()");
  await h.settle();
  assert.equal(h.state("labBuilder.excludedSubtopics.size"), 0);
  h.run("lbResetTopics()");
  await h.settle();
  assert.equal(h.state("labBuilder.excludedSubtopics.size"), 0);

  await h.toggle(h.sub(subIds(ALPHA)[0]));
  await h.toggle(h.sub(subIds(ALPHA)[1]));
  const group = h.state(`labBuilder.rec.concepts.find((c) => c.topics.some((x) => x.id === ${JSON.stringify(ALPHA.id)})).id`);
  h.run(`lbSetGroup(${JSON.stringify(group)}, true)`);
  await h.settle();
  assert.equal(h.sub(subIds(ALPHA)[0]).checked, true, "Select group includes every sub-topic of its topics");
  h.run(`lbSetGroup(${JSON.stringify(group)}, false)`);
  await h.settle();
  assert.equal(h.sub(subIds(ALPHA)[0]).checked, false);
  assert.equal(h.state("labBuilder.excludedSubtopics.size"), 0);
});

test("the scorecard, the status line, and the live region count sub-topics", async (t) => {
  const h = makeWizard(t);
  await h.refresh();
  const shown = h.state("labBuilder.rec.filter.shown");
  assert.equal(h.byId("lb-topic-count").textContent, `Showing ${shown} topics and ${SUBTOPIC_TOTAL} sub-topics for Level 200 (Intermediate).`);
  assert.equal(h.byId("lb-topic-count").getAttribute("aria-live"), "polite");
  assert.equal(h.byId("lb-topic-scorecard").textContent.includes("sub-topics included"), false, "no sub-topic chip until a topic with sub-topics is selected");

  await h.toggle(h.parent(BIG.id));
  assert.match(h.byId("lb-topic-scorecard").textContent, /1\s*selected/);
  assert.match(h.byId("lb-topic-scorecard").textContent, /9 of 9 sub-topics included/);

  await h.toggle(h.sub(subIds(BIG)[0]));
  assert.match(h.byId("lb-topic-scorecard").textContent, /8 of 9 sub-topics included/);
  assert.equal(h.byId("lb-topic-announce").textContent, "Big topic part 1 left out. 8 of 9 sub-topics included under Big topic.");
  assert.equal(h.byId("lb-topic-announce").getAttribute("aria-live"), "polite");

  await h.toggle(h.sub(subIds(BIG)[0]));
  assert.equal(h.byId("lb-topic-announce").textContent, "Big topic part 1 included. 9 of 9 sub-topics included under Big topic.");
});

test("a search reveals a sub-topic match under its topic, even in a collapsed list", async (t) => {
  const h = makeWizard(t);
  await h.refresh();
  const search = h.byId("lb-topic-search");
  search.value = "zebra";
  search.dispatchEvent(new h.FakeEvent("input"));
  await h.settle();
  const cards = h.qa("input[data-topic]");
  assert.deepEqual([...cards].map((input) => input.dataset.topic), [BIG.id], "only the topic holding the match is shown");
  const ninth = h.sub(subIds(BIG)[8]);
  assert.ok(ninth, "the ninth sub-topic is shown although the list is normally collapsed");
  const row = ninth.closest("li");
  assert.ok(row.classList.contains("lb-subtopic-match"));
  assert.match(row.textContent, /Matches your search/);
  assert.equal(h.byId("lb-topic-count").textContent, `Showing 1 topic and 9 sub-topics for Level 200 (Intermediate) that match your search or filter (of ${h.state("labBuilder.rec.filter.shown")}).`);
});

test("a sub-topic checkbox keeps keyboard focus when the list redraws, and the topic checkbox is a real checkbox", async (t) => {
  const h = makeWizard(t);
  await h.refresh();
  const input = h.sub(subIds(ALPHA)[0]);
  assert.equal(input.tagName, "INPUT");
  assert.equal(input.type, "checkbox");
  input.focus();
  await h.toggle(input);
  assert.equal(h.document.activeElement.dataset.subtopic, subIds(ALPHA)[0], "focus is back on the same sub-topic after the redraw");
  const parent = h.parent(ALPHA.id);
  assert.equal(parent.type, "checkbox");
  assert.equal(parent.getAttribute("aria-controls"), `lb-subtopics-${ALPHA.id}`);
});

test("sub-topic titles, summaries, and links are escaped, and an unsafe link is never rendered", async (t) => {
  const h = makeWizard(t);
  await h.refresh();
  const group = h.q(`fieldset#lb-subtopics-${HOSTILE.id}`);
  assert.equal(group.querySelectorAll("img").length, 0, "no element is built from a title");
  assert.equal(group.querySelectorAll("script").length, 0);
  const names = [...group.querySelectorAll(".lb-subtopic-name")].map((el) => el.textContent);
  assert.deepEqual(names, ["<img src=x onerror=alert(1)>", "\"><script>alert(2)</script>"], "titles are shown as text");
  const summary = group.querySelector(".lb-feature-summary").textContent;
  assert.equal(summary, "<b>bold</b> & \"quoted\"");
  const rows = group.querySelectorAll("li");
  assert.equal(rows[0].querySelectorAll("a").length, 0, "a javascript: URL gets no link");
  const links = rows[1].querySelectorAll("a");
  assert.equal(links.length, 1);
  assert.equal(links[0].getAttribute("href"), urlOf("hostile-two"));
  assert.equal(links[0].getAttribute("target"), "_blank");
  assert.equal(links[0].getAttribute("rel"), "noopener noreferrer");
  assert.equal(links[0].closest("label"), null, "the link is outside the label, so following it never toggles the checkbox");
  assert.ok(!h.byId("lb-topic-groups").innerHTML.includes("<script>"));
  assert.ok(!h.byId("lb-topic-groups").innerHTML.includes("<img src=x"));
});

test("a topic card lists its own Microsoft Learn page, and its sub-topics keep their links to themselves", async (t) => {
  const h = makeWizard(t);
  await h.refresh();
  const card = h.parent(ALPHA.id).closest(".lb-feature-main");
  const own = [...card.querySelectorAll("a.lb-learn-source")].map((a) => a.getAttribute("href"));
  assert.deepEqual(own, [ALPHA.urls[0]]);
  const row = h.sub(subIds(ALPHA)[0]).closest("li");
  assert.deepEqual([...row.querySelectorAll("a")].map((a) => a.getAttribute("href")), [ALPHA.subtopics[0].url]);
});

// ── The request, saved selections, and Edit and rebuild ─────────────────────

test("the request carries the exclusions, and saved selections round trip them", async (t) => {
  const h = makeWizard(t);
  await h.refresh();
  const [first] = subIds(ALPHA);
  await h.toggle(h.parent(ALPHA.id));
  await h.toggle(h.sub(first));
  const request = h.state("lbRequest()");
  assert.deepEqual(request.excludedSubtopics, [first]);
  assert.ok(request.features.includes(ALPHA.id));
  assert.deepEqual(h.state("lbSaveSelections().excludedSubtopics"), [first]);

  h.run("lbResetAnswers()");
  assert.equal(h.state("labBuilder.excludedSubtopics.size"), 0);
  assert.equal(h.state("lbRequest().excludedSubtopics"), undefined, "a request with no exclusion omits the field, as old clients do");

  h.run("labBuilder.rec = null");
  await h.run(`lbLoadSelections({ title: "Saved lab", selections: { industry: null, roles: [], products: ["copilot-studio"], features: [${JSON.stringify(ALPHA.id)}], excluded: [], moduleOrder: [], excludedSubtopics: [${JSON.stringify(first)}, "learn-gone-since-then"], harness: "standard", level: 200, differencesFor: null, targetMinutes: null, customTitle: null, agentName: null, sharepointSiteName: "", sharepointSiteUrl: "", useLearnMcp: false, useLlm: false, includeKnowledgeCheck: false } })`);
  await h.settle();
  assert.deepEqual(h.state("[...labBuilder.excludedSubtopics]"), [first], "an id Microsoft Learn no longer lists is dropped, so it cannot block the rebuild");
  assert.deepEqual(h.recommendCalls.at(-1).excludedSubtopics, [first], "the request that stuck leaves it out");
  assert.equal(h.toasts.some((toast) => toast.type === "error"), false, "the learner sees no error for it");
  assert.notEqual(h.state("labBuilder.rec"), null, "and the topics loaded");
  assert.deepEqual(h.state("lbRequest().excludedSubtopics"), [first]);
});

test("the server's 400 for an unknown sub-topic id is a clear message", async (t) => {
  const h = makeWizard(t);
  await h.refresh();
  const res = await h.context.fetch("/api/lab-builder/recommend", { method: "POST", body: JSON.stringify({ products: ["copilot-studio"], level: 200, harness: "standard", excludedSubtopics: ["learn-nope"] }) });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Unknown sub-topic id\(s\): learn-nope/);
});

// ── Step 7: the Review step ─────────────────────────────────────────────────

test("Review shows every sub-topic under its module, and leaving one out there stays in sync with Step 6", async (t) => {
  const h = makeWizard(t);
  await h.refresh();
  await h.toggle(h.parent(ALPHA.id));
  h.run("labBuilder.step = LB_STEP.review; lbPreview()");
  await h.settle();
  const preview = h.byId("lb-preview");
  const rows = preview.querySelectorAll("input[data-outline-subtopic]");
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.checked, true);
    assert.equal(row.getAttribute("data-outline-parent"), ALPHA.id);
    assert.ok(preview.querySelector(`label[for="${row.id}"]`), "each has a label");
  }
  assert.match(preview.textContent, /3 of 3 sub-topics included/);
  assert.deepEqual(h.previewCalls.at(-1).excludedSubtopics, undefined);

  const first = subIds(ALPHA)[0];
  const box = preview.querySelector(`input[data-outline-subtopic="${first}"]`);
  box.checked = false;
  box.dispatchEvent(new h.FakeEvent("change"));
  await h.settle();
  assert.deepEqual(h.previewCalls.at(-1).excludedSubtopics, [first], "Review plans the lab without it");
  assert.equal(h.state("labBuilder.excludedSubtopics.has(" + JSON.stringify(first) + ")"), true, "Step 6 holds the same choice");
  const after = h.byId("lb-preview");
  assert.equal(after.querySelector(`input[data-outline-subtopic="${first}"]`).checked, false);
  assert.match(after.textContent, /2 of 3 sub-topics included/);
  assert.match(after.querySelector(`input[data-outline-subtopic="${first}"]`).closest("tr").textContent, /left out/);
  assert.equal(h.document.activeElement.dataset.outlineSubtopic, first, "focus returns to the checkbox after the plan redraws");

  h.run("labBuilder.step = LB_STEP.topics; lbRenderTopics()");
  assert.equal(h.sub(first).checked, false, "going back to Step 6 shows it unchecked");
  assert.equal(h.parent(ALPHA.id).indeterminate, true);

  const again = h.byId("lb-preview").querySelector(`input[data-outline-subtopic="${first}"]`);
  h.run("labBuilder.step = LB_STEP.review");
  again.checked = true;
  again.dispatchEvent(new h.FakeEvent("change"));
  await h.settle();
  assert.equal(h.state("labBuilder.excludedSubtopics.size"), 0);
});

// ── Export All Topics ───────────────────────────────────────────────────────

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\r" && text[i + 1] === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 1;
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// Blob.text() drops a byte order mark, so read the bytes: the BOM is part of the file.
const exportedText = async (h, index = h.blobs.length - 1) => Buffer.from(await h.blobs[index].arrayBuffer()).toString("utf8");

test("Export All Topics sits in the Step 6 toolbar with a format menu, CSV by default", async (t) => {
  const h = makeWizard(t);
  await h.refresh();
  const main = h.byId("lb-export-main");
  assert.equal(main.textContent, "Export All Topics");
  assert.equal(main.closest(".lb-topic-toolbar") !== null, true, "it is in the toolbar next to the bulk buttons");
  const toggle = h.byId("lb-export-toggle");
  assert.equal(toggle.getAttribute("aria-haspopup"), "menu");
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.ok(toggle.getAttribute("aria-label"));
  const items = h.byId("lb-export-menu").querySelectorAll("[data-export-format]");
  assert.deepEqual([...items].map((el) => [el.dataset.exportFormat, el.textContent]), [["csv", "CSV (opens in Excel)"], ["markdown", "Markdown"], ["json", "JSON"]]);
  assert.equal(h.byId("lb-export-menu").hidden, true);
  assert.equal(h.byId("lb-export-status").getAttribute("aria-live"), "polite");
});

test("the scope note says exactly what will be exported, and counts the rows once they are loaded", async (t) => {
  const h = makeWizard(t);
  await h.refresh();
  const dataset = h.state("labBuilder.exportData");
  assert.ok(dataset, "the rows were loaded when Step 6 opened");
  assert.equal(
    h.byId("lb-export-scope").textContent,
    `${dataset.scope.text} It ignores your search, filter, and level, and marks what you selected.`,
  );
  assert.match(dataset.scope.text, /^All topics and sub-topics for Copilot Studio \(Standard harness\), all levels: \d+ rows \(\d+ topics, \d+ sub-topics\)\.$/);
  assert.equal(dataset.counts.subTopics >= SUBTOPIC_TOTAL, true);
  assert.deepEqual(h.exportCalls.at(-1), { products: ["copilot-studio"], departments: [], harness: "standard", format: "dataset" });
});

test("exporting writes a CSV Blob that matches the server's file byte for byte, and says how many rows", async (t) => {
  const h = makeWizard(t);
  await h.refresh();
  await h.toggle(h.parent(ALPHA.id));
  await h.toggle(h.sub(subIds(ALPHA)[0]));
  h.byId("lb-export-main").dispatchEvent(new h.FakeEvent("click"));
  await h.settle();
  assert.equal(h.blobs.length, 1);
  const dataset = h.state("labBuilder.exportData");
  const selection = h.state("lbExportSelection()");
  const text = await exportedText(h);
  assert.equal(text, toCsv(dataset, selection), "the browser and the CLI/API write the same CSV");
  assert.equal(h.blobs[0].type, "text/csv;charset=utf-8");
  const bytes = Buffer.from(await h.blobs[0].arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "UTF-8 with a byte order mark");
  const link = h.downloads.at(-1);
  assert.equal(link.download, exportFileName(dataset, "csv"));
  assert.match(link.download, /^all-topics-copilot-studio-\d{4}-\d{2}-\d{2}\.csv$/);
  assert.equal(link.getAttribute("href") || link.href, "blob:fake/1");
  const status = h.byId("lb-export-status").textContent;
  assert.equal(status, `Exported ${dataset.counts.rows} rows (${dataset.counts.topics} topics and ${dataset.counts.subTopics} sub-topics) to ${link.download}.`);
  assert.equal(h.byId("lb-export-status").getAttribute("role"), "status");
});

test("the CSV has a header, quotes correctly, ends lines with CRLF, and marks my selection", async (t) => {
  const h = makeWizard(t);
  await h.refresh();
  await h.toggle(h.parent(ALPHA.id));
  await h.toggle(h.sub(subIds(ALPHA)[0]));
  h.run("lbExportAllTopics('csv')");
  await h.settle();
  const text = await exportedText(h);
  assert.equal(text.startsWith("\uFEFFProduct,Topic group,Topic,Sub-topic,Type,Level,Level basis,Approx. minutes,Harness applicability,Availability,Learn status,Optional 3rd-party connector,Required prerequisite,Recommended,Why recommended,Prerequisites,Required by,Microsoft Learn URL(s),Source,Selected in my lab\r\n"), true);
  assert.equal(/[^\r]\n/.test(text.replace(/"[^"]*"/g, "")), false, "every line break outside a quoted field is CRLF");
  const rows = parseCsv(text.slice(1));
  const dataset = h.state("labBuilder.exportData");
  assert.equal(rows.length, dataset.rows.length + 1, "one row per topic and sub-topic, plus the header");
  assert.ok(rows.every((row) => row.length === 20), "every row has every column");
  const selected = (name) => rows.find((row) => row[2] === ALPHA.title && row[3] === name);
  assert.equal(selected("")[19], "Yes", "the selected topic");
  assert.equal(selected(ALPHA.subtopics[0].title) [19], "No", "a sub-topic I left out");
  assert.equal(selected(ALPHA.subtopics[1].title) [19], "Yes", "a sub-topic I kept");
  assert.equal(rows.find((row) => row[2] === BIG.title && row[3] === "")[19], "No", "an unselected topic");
  assert.equal(rows.find((row) => row[2] === ALPHA.title && row[3] === "")[4], "Topic");
  assert.equal(selected(ALPHA.subtopics[1].title)[4], "Sub-topic");
});

test("cells that would run as spreadsheet formulas are protected", async (t) => {
  const h = makeWizard(t);
  await h.refresh();
  h.run("lbExportAllTopics('csv')");
  await h.settle();
  const rows = parseCsv((await exportedText(h)).slice(1));
  const cell = (row, column) => row[column];
  const formulaTopic = rows.find((row) => row[2].includes("HYPERLINK"));
  assert.equal(cell(formulaTopic, 2), `'=HYPERLINK("https://evil.example","click")`);
  const subs = rows.filter((row) => row[2].includes("HYPERLINK") && row[4] === "Sub-topic").map((row) => row[3]);
  assert.deepEqual(subs.sort(), ["'+cmd|' /C calc'!A0", "'-2+3", "'@SUM(1+1)"].sort());
  for (const row of rows.slice(1)) for (const value of row) assert.equal(/^[=+\-@\t\r]/.test(value), false, `unprotected cell: ${value}`);
});

test("Markdown and JSON exports match the server's files and have the documented shape", async (t) => {
  const h = makeWizard(t);
  await h.refresh();
  await h.toggle(h.parent(ALPHA.id));
  h.run("lbExportAllTopics('markdown')");
  await h.settle();
  h.run("lbExportAllTopics('json')");
  await h.settle();
  const dataset = h.state("labBuilder.exportData");
  const selection = h.state("lbExportSelection()");
  const markdown = await exportedText(h, 0);
  const json = await exportedText(h, 1);
  assert.equal(markdown, toMarkdown(dataset, selection));
  assert.equal(json, toJson(dataset, selection));
  assert.equal(h.blobs[0].type, "text/markdown;charset=utf-8");
  assert.equal(h.blobs[1].type, "application/json;charset=utf-8");
  assert.match(h.downloads.at(-2).download, /\.md$/);
  assert.match(h.downloads.at(-1).download, /\.json$/);

  assert.match(markdown, /^# Topic export: Copilot Studio\n/);
  assert.match(markdown, /\n## Microsoft Copilot Studio\n/);
  assert.match(markdown, /\n  - Sub-topic: \[Alpha trigger overview\]\(https:\/\/learn\.microsoft\.com\/microsoft-copilot-studio\/alpha-trigger-overview\) - Level \d+/);
  assert.match(markdown, /selected in my lab: yes/);

  const parsed = JSON.parse(json);
  const alpha = parsed.products[0].groups.flatMap((g) => g.topics).find((x) => x.name === "Alpha trigger");
  assert.deepEqual(alpha.subTopics.map((s) => s.name), ALPHA.subtopics.map((s) => s.title));
  assert.equal(alpha.selected, true);
  assert.ok(alpha.subTopics.every((s) => s.selected && s.type === "sub-topic" && s.urls.every((u) => u.startsWith("https://"))));
  assert.equal(parsed.counts.rows, dataset.rows.length);
});

test("the export ignores the search, the filter, and the level, and every sub-topic is in it", async (t) => {
  const h = makeWizard(t);
  await h.refresh();
  h.run("lbExportAllTopics('json')");
  await h.settle();
  const baseline = await exportedText(h, 0);
  const calls = h.exportCalls.length;

  h.run('labBuilder.search = "zzzz-no-match"; labBuilder.filter = "selected"; labBuilder.level = 100; labBuilder.rec = null');
  h.run("lbExportAllTopics('json')");
  await h.settle();
  const narrowed = await exportedText(h, 1);
  assert.equal(narrowed, baseline, "same rows however the list is narrowed");
  assert.equal(h.exportCalls.length, calls, "and the rows were not loaded again");

  const dataset = h.state("labBuilder.exportData");
  const ids = new Set(dataset.rows.map((row) => row.id));
  for (const sub of TOPICS.flatMap((x) => x.subtopics || [])) assert.ok(ids.has(sub.id || topicId(sub.url)) || sub.url.startsWith("javascript:"), `${sub.title} is in the export`);
  const levels = new Set(dataset.rows.map((row) => row.level));
  assert.deepEqual([...levels].filter(Boolean).sort(), [100, 200, 300], "all levels are there, with a Level column");
});

test("what the wizard lists at a level is what the export holds", async (t) => {
  const h = makeWizard(t);
  await h.refresh();
  const listed = new Set([...h.qa("input[data-topic]")].map((el) => el.dataset.topic));
  const listedSubs = new Set([...h.qa("input[data-subtopic]")].map((el) => el.dataset.subtopic));
  const dataset = h.state("labBuilder.exportData");
  const exported = new Set(dataset.rows.filter((row) => row.type === "topic").map((row) => row.id));
  for (const id of listed) assert.ok(exported.has(id), `${id} is listed in Step 6 and exported`);
  const exportedSubs = new Set(dataset.rows.filter((row) => row.type === "sub-topic").map((row) => row.id));
  for (const id of listedSubs) assert.ok(exportedSubs.has(id), `${id} is listed in Step 6 and exported`);
  const atLevel = dataset.rows.filter((row) => row.type === "topic" && row.level === 200).length;
  assert.equal(atLevel, h.state("labBuilder.rec.filter.shown"), "the export has as many Level 200 topics as Step 6 shows at Level 200");
});

test("exporting keeps working offline once the rows are loaded, and says so plainly when they are not", async (t) => {
  const h = makeWizard(t);
  await h.refresh();
  h.offline = true;
  h.run("lbExportAllTopics('csv')");
  await h.settle();
  assert.equal(h.blobs.length, 1, "the loaded rows are enough");
  assert.match(h.byId("lb-export-status").textContent, /^Exported \d+ rows/);

  h.run('labBuilder.selectedProducts = new Set(["copilot-studio", "sharepoint-ai"]); lbRenderTopics()');
  await h.settle();
  assert.match(h.byId("lb-export-scope").textContent, /could not be loaded/);
  h.run("lbExportAllTopics('csv')");
  await h.settle();
  assert.equal(h.blobs.length, 1, "nothing partial is ever written");
  assert.match(h.byId("lb-export-status").textContent, /^Could not export the topics: Failed to fetch\. Check your connection and try again\.$/);

  h.offline = false;
  h.run("lbExportAllTopics('csv')");
  await h.settle();
  assert.equal(h.blobs.length, 2);
  assert.match(h.byId("lb-export-scope").textContent, /Copilot Studio and SharePoint AI/);
});

test("the export covers the products chosen in Step 1, each with its own rows", async (t) => {
  const h = makeWizard(t);
  h.run('labBuilder.selectedProducts = new Set(["copilot-studio", "sharepoint-ai"])');
  await h.refresh();
  const dataset = h.state("labBuilder.exportData");
  assert.deepEqual(dataset.scope.products.map((p) => p.id), ["copilot-studio", "sharepoint-ai"]);
  assert.match(dataset.scope.text, /^All topics and sub-topics for Copilot Studio and SharePoint AI \(Standard harness\), all levels: \d+ rows/);
  assert.ok(dataset.counts.byProduct["sharepoint-ai"].topics > 0);
  assert.ok(dataset.counts.byProduct["copilot-studio"].topics > 0);
  assert.equal(Object.keys(dataset.counts.byProduct).length, 2);
});

test("the format menu opens and closes from the keyboard", async (t) => {
  const h = makeWizard(t);
  await h.refresh();
  const toggle = h.byId("lb-export-toggle");
  const menu = h.byId("lb-export-menu");
  toggle.focus();
  await h.press(toggle, "ArrowDown");
  assert.equal(menu.hidden, false);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  const items = [...menu.querySelectorAll("[data-export-format]")];
  assert.equal(h.document.activeElement, items[0]);
  await h.press(items[0], "ArrowDown");
  assert.equal(h.document.activeElement, items[1]);
  await h.press(items[1], "ArrowUp");
  await h.press(items[0], "ArrowUp");
  assert.equal(h.document.activeElement, items[2], "the arrows wrap around");
  await h.press(items[2], "Escape");
  assert.equal(menu.hidden, true);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(h.document.activeElement, toggle, "Escape returns focus to the button");

  toggle.dispatchEvent(new h.FakeEvent("click"));
  assert.equal(menu.hidden, false);
  h.document.listeners.click.forEach((fn) => fn({ target: h.document.body }));
  assert.equal(menu.hidden, true, "a click outside closes it");

  toggle.dispatchEvent(new h.FakeEvent("click"));
  items[1].dispatchEvent(new h.FakeEvent("click"));
  await h.settle();
  assert.equal(menu.hidden, true, "choosing a format closes the menu");
  assert.equal(h.blobs.length, 1);
  assert.match(h.downloads.at(-1).download, /\.md$/);
});

test("with no product chosen, the export says what to do and does nothing", async (t) => {
  const h = makeWizard(t);
  h.run("labBuilder.selectedProducts = new Set(); lbRenderTopics()");
  assert.equal(h.byId("lb-export-scope").textContent, "Choose at least one product in Step 1 to export its topics.");
  assert.equal(h.byId("lb-export-main").disabled, true);
  h.run("lbExportAllTopics('csv')");
  await h.settle();
  assert.equal(h.blobs.length, 0);
  assert.equal(h.exportCalls.length, 0);
});

test("the markup and styles keep print rules in the one print block, and the new controls follow the page's patterns", () => {
  const firstPrint = HTML.indexOf("@media print");
  const screenCss = HTML.slice(0, firstPrint);
  for (const selector of [".lb-subtopics", ".lb-subtopic", ".lb-export-menu", ".lb-export-main", ".lb-subtopic-match"]) assert.ok(screenCss.includes(selector), `${selector} is screen CSS`);
  assert.equal(HTML.match(/@media print/g).length, 1, "there is still exactly one print block");
  const printCss = HTML.slice(firstPrint);
  for (const selector of [".lb-export,", ".lb-export-scope,", ".lb-export-status,"]) assert.ok(printCss.includes(selector), `${selector} is hidden in print`);
  assert.match(HTML, /id="lb-topic-announce" class="sr-only" role="status" aria-live="polite"/);
  assert.match(HTML, /id="lb-export-status" class="lb-export-status" role="status" aria-live="polite"/);
  // Text colors come from the theme tokens that every other card uses, so contrast follows them in light and dark.
  const rule = (name) => screenCss.match(new RegExp(`${name.replaceAll(".", "\\.")}\\s*\\{[^}]*\\}`))?.[0] || "";
  for (const name of [".lb-subtopic-name", ".lb-subtopics-legend", ".lb-export-menu button"]) assert.match(rule(name), /color:\s*var\(--text\)/, `${name} uses the primary text token`);
  assert.match(screenCss.match(/\.lb-export-scope,\s*\.lb-export-status\s*\{[^}]*\}/)?.[0] || "", /color:\s*var\(--text-muted\)/);
  assert.ok(!/@keyframes|animation:/.test(rule(".lb-subtopic")), "no new motion");
  assert.match(rule(".lb-subtopic"), /transition: border-color var\(--dur-fast\)/, "transitions use the token that reduced-motion turns off");
});
