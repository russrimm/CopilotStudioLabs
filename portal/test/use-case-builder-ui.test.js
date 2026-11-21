/**
 * Use Case Builder UI, its hand-off to the lab builder wizard, the rename, and the
 * page's theme, print, and security rules. The real browser scripts run inside
 * node:vm against a small fake DOM, with a fake clock and a fetch that answers from
 * the real generator, so nothing touches a network or a browser.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { getFeaturesByCategory, getHarnesses } from "../lib/lab-builder/catalog.js";
import { defaultDifferencesFor } from "../lib/lab-builder/differences.js";
import { getProducts } from "../lib/lab-builder/products.js";
import { recommend } from "../lib/lab-builder/recommend.js";
import { getIndustries, getRoles } from "../lib/scenarios.js";
import { buildOptions, generateUseCases } from "../lib/use-cases/index.js";
import { createFakeDom } from "./fixtures/fake-dom.js";

const portalRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = join(portalRoot, "..");
const publicFile = (name) => readFileSync(join(portalRoot, "public", name), "utf8");
const UC_SOURCE = publicFile("use-case-builder.js");
const WIZARD_SOURCE = publicFile("lab-builder-wizard.js");
const HTML = publicFile("index.html");
const APP_SOURCE = publicFile("app.js");

const CS = "copilot-studio";
const AB = "m365-copilot-agent-builder";
const NOW = Date.parse("2026-06-01T12:00:00.000Z");
const clone = (value) => JSON.parse(JSON.stringify(value));

// ── Harness for the Use Case Builder script ─────────────────────────────────

function makeBuilder({ stored, polish = false, wizard = {}, respond } = {}) {
  const { document, FakeEvent } = createFakeDom();
  const body = document.body;
  const add = (parent, tag, id, attrs = {}) => {
    const el = document.createElement(tag);
    if (id) el.id = id;
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    parent.appendChild(el);
    return el;
  };
  add(body, "div", "uc-root");
  add(body, "div", "app-live", { role: "status", "aria-live": "polite" });
  add(body, "div", "panel-scenarios", { class: "tab-panel" });

  const clock = { now: NOW, seq: 1, timers: new Map() };
  const advance = (ms) => {
    const target = clock.now + ms;
    for (;;) {
      let next = null;
      for (const [id, t] of clock.timers) if (t.at <= target && (!next || t.at < next.t.at)) next = { id, t };
      if (!next) break;
      clock.now = next.t.at;
      clock.timers.delete(next.id);
      next.t.fn();
    }
    clock.now = target;
  };
  const storage = new Map();
  if (stored !== undefined) storage.set("cslabs.useCaseBuilder.v1", typeof stored === "string" ? stored : JSON.stringify(stored));
  const h = { document, FakeEvent, calls: [], toasts: [], handoffs: [], selectionChanges: 0, blobs: [], copied: [], storage, prints: {}, windowListeners: {} };
  const reply = (status, payload) => ({ ok: status >= 200 && status < 300, status, json: async () => clone(payload) });
  h.options = buildOptions({ polishAvailable: polish });
  h.generated = [];
  h.pending = null;
  const fetchImpl = async (url, init = {}) => {
    h.calls.push({ url: String(url), init });
    if (url === "/api/use-cases/options") return reply(200, h.options);
    if (url === "/api/use-cases/generate") {
      const request = JSON.parse(init.body);
      h.generated.push(request);
      if (respond) return respond(request, reply);
      if (h.pending) return h.pending(request, reply);
      try {
        return reply(200, generateUseCases(request));
      } catch (err) {
        return reply(err.status || 500, { error: err.message });
      }
    }
    throw new Error(`Unexpected fetch ${url}`);
  };
  class FakeURL extends URL {
    static createObjectURL(blob) {
      h.blobs.push(blob);
      return `blob:fake/${h.blobs.length}`;
    }

    static revokeObjectURL() {}
  }
  const context = {
    document,
    window: { addEventListener: (type, fn) => (h.windowListeners[type] ||= []).push(fn) },
    fetch: fetchImpl,
    setTimeout: (fn, ms) => {
      const id = clock.seq++;
      clock.timers.set(id, { fn, at: clock.now + ms });
      return id;
    },
    clearTimeout: (id) => clock.timers.delete(id),
    URL: FakeURL,
    Blob,
    console,
    navigator: { clipboard: { writeText: async (text) => void h.copied.push(text) } },
    localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) },
    toast: (message, type) => h.toasts.push({ message, type }),
    scenarioSelectionChanged: () => {
      h.selectionChanges += 1;
    },
    lbHasProgress: () => Boolean(wizard.progress),
    lbPrefillFromUseCases: async (plan) => {
      h.handoffs.push(plan);
      if (wizard.fail) throw new Error(wizard.fail);
      return wizard.result || { selected: 4, level: plan.level, harness: plan.harness, skipped: { level: [], harness: [], product: [], unknown: 0 } };
    },
  };
  vm.createContext(context);
  vm.runInContext(UC_SOURCE, context, { filename: "use-case-builder.js" });
  h.context = context;
  h.run = (code) => vm.runInContext(code, context);
  h.advance = advance;
  h.flush = async (rounds = 8) => {
    for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  h.settle = async () => {
    advance(400);
    await h.flush();
    advance(0);
    await h.flush();
  };
  h.open = async () => {
    h.run("ucOnTabShown()");
    await h.flush();
    advance(10);
    await h.flush();
    return h;
  };
  h.byId = (id) => document.getElementById(id);
  h.text = (id) => h.byId(id)?.textContent ?? null;
  h.click = async (el) => {
    assert.ok(el, "element to click must exist");
    el.click();
    await h.settle();
  };
  h.choice = (group, id) => document.getElementById(group).querySelectorAll("button").find((b) => b.getAttribute("data-uc-id") === id);
  h.industry = (id) => h.choice("uc-industry-grid", id);
  h.department = (id) => h.choice("uc-department-chips", id);
  h.goal = (id) => h.choice("uc-goal-chips", id);
  h.source = (id) => h.choice("uc-source-chips", id);
  h.radio = (group, value) => document.getElementById(group).querySelectorAll("input").find((i) => i.value === String(value));
  h.set = async (el, value, type = "input") => {
    el.value = value;
    el.dispatchEvent(new FakeEvent(type));
    await h.settle();
  };
  h.check = async (el, on) => {
    el.checked = on;
    el.dispatchEvent(new FakeEvent("change"));
    await h.settle();
  };
  h.cards = (product) => (product ? document.getElementById(`uc-section-${product}`)?.querySelectorAll(".uc-card") : document.getElementById("uc-sections").querySelectorAll(".uc-card")) || [];
  h.titles = (product) => h.cards(product).map((card) => card.querySelector(".uc-card-title").textContent);
  h.addButton = (card) => card.querySelectorAll("button").find((b) => b.hasAttribute("data-uc-add"));
  h.choose = async (industry, departments = []) => {
    await h.click(h.industry(industry));
    for (const id of departments) await h.click(h.department(id));
  };
  h.lastBlobText = async () => h.blobs.at(-1).text();
  return h;
}

// ── Empty, results, and live updates ────────────────────────────────────────

test("with nothing chosen the page asks for an industry in plain words and builds no list", async () => {
  const h = await makeBuilder().open();
  assert.equal(h.text("uc-count"), "Choose an industry to build your use case list.");
  assert.match(h.text("uc-empty"), /Choose an industry above and your use cases build here/);
  assert.equal(h.cards().length, 0);
  assert.equal(h.byId("uc-toolbar").hidden, true);
  assert.equal(h.calls.filter((c) => c.url.endsWith("/generate")).length, 0, "nothing is requested until there is an industry");
  assert.equal(h.byId("uc-polish-wrap").hidden, true, "AI polish is hidden when no model is configured");
});

test("the inputs are real controls: industry cards, chips with pressed state, and radio groups, all labeled", async () => {
  const h = await makeBuilder().open();
  assert.equal(h.byId("uc-industry-grid").querySelectorAll("button").length, 7);
  assert.equal(h.byId("uc-department-chips").querySelectorAll("button").length, 12);
  assert.equal(h.byId("uc-goal-chips").querySelectorAll("button").length, 7);
  assert.equal(h.byId("uc-source-chips").querySelectorAll("button").length, 7);
  for (const button of h.byId("uc-root").querySelectorAll("button")) {
    assert.equal(button.getAttribute("type"), "button");
    if (button.hasAttribute("aria-pressed")) assert.equal(button.getAttribute("aria-pressed"), "false");
  }
  const legends = h.byId("uc-inputs").querySelectorAll("legend").map((l) => l.textContent);
  assert.deepEqual(legends, ["Industry", "Departments", "Business goals", "Data and channels you already have", "Platform focus", "Skill level"]);
  assert.equal(h.byId("uc-platform-options").getAttribute("role"), "radiogroup");
  assert.deepEqual(h.byId("uc-platform-options").querySelectorAll("input").map((i) => [i.type, i.checked]), [["radio", true], ["radio", false], ["radio", false]]);
  assert.deepEqual(h.byId("uc-level-options").querySelectorAll("input").map((i) => i.checked), [true, false, false, false], "Any is the default level");
  const labelsFor = new Set(h.byId("uc-toolbar").querySelectorAll("label").map((l) => l.getAttribute("for")));
  for (const id of ["uc-search", "uc-filter-product", "uc-filter-level", "uc-filter-department", "uc-filter-goal", "uc-sort"]) assert.ok(labelsFor.has(id), `${id} has a label`);
});

test("choosing an industry builds the list live, and the count is a polite live region with the scope in it", async () => {
  const h = await makeBuilder().open();
  const count = h.byId("uc-count");
  assert.equal(count.getAttribute("role"), "status");
  assert.equal(count.getAttribute("aria-live"), "polite");
  await h.choose("healthcare", ["customer-service"]);
  const response = generateUseCases({ industry: "healthcare", departments: ["customer-service"] });
  assert.equal(count.textContent, `Showing ${response.useCases.length} of ${response.useCases.length} use cases for Healthcare, Customer Service.`);
  assert.equal(h.industry("healthcare").getAttribute("aria-pressed"), "true");
  assert.equal(h.department("customer-service").getAttribute("aria-pressed"), "true");
  assert.equal(h.byId("uc-toolbar").hidden, false);
  assert.equal(h.byId("uc-section-copilot-studio").querySelector("h4").textContent.startsWith("Copilot Studio use cases"), true);
  assert.equal(h.byId("uc-section-m365-copilot-agent-builder").querySelector("h4").textContent.startsWith("Agent Builder use cases"), true);
  assert.ok(h.cards(CS).length > 0 && h.cards(AB).length > 0);
  const best = h.byId("uc-best");
  assert.equal(best.hidden, false);
  assert.equal(best.querySelectorAll(".uc-best-item").length, 6);
  assert.ok(h.selectionChanges >= 2, "the provisioning section is told about each change");
  assert.equal(h.run("ucSelectedIndustryId()"), "healthcare");
  assert.deepEqual(clone(h.run("ucSelectedDepartmentIds()")), ["customer-service"]);

  // Everything in the request comes from the controls.
  await h.click(h.goal("grow-revenue"));
  await h.click(h.source("web"));
  await h.check(h.radio("uc-platform-options", "agent-builder"), true);
  await h.check(h.radio("uc-level-options", 200), true);
  assert.deepEqual(h.generated.at(-1), { industry: "healthcare", departments: ["customer-service"], goals: ["grow-revenue"], dataSources: ["web"], platform: "agent-builder", level: 200, polish: false });
  assert.equal(h.cards(CS).length, 0);
  assert.ok(h.cards(AB).length >= 3);
  assert.equal(h.goal("grow-revenue").getAttribute("aria-pressed"), "true");
});

test("rapid changes send one request, and a slow answer to an older choice never overwrites a newer one", async () => {
  const h = await makeBuilder().open();
  await h.click(h.industry("retail"));
  const before = h.generated.length;
  h.industry("manufacturing").click();
  h.department("operations").click();
  h.department("finance").click();
  h.advance(100);
  assert.equal(h.generated.length, before, "still waiting out the debounce");
  await h.settle();
  assert.equal(h.generated.length, before + 1);
  assert.deepEqual(h.generated.at(-1).departments, ["finance", "operations"]);

  // A stale answer arrives after a newer request was made.
  const releases = [];
  h.pending = (request, reply) => new Promise((resolve) => releases.push(() => resolve(reply(200, generateUseCases(request)))));
  h.industry("education").click();
  h.advance(300);
  await h.flush();
  h.industry("nonprofit").click();
  h.advance(300);
  await h.flush();
  assert.equal(releases.length, 2);
  releases[1]();
  await h.flush();
  releases[0]();
  await h.flush();
  assert.match(h.text("uc-count"), /^Showing 40 of 40 use cases for Nonprofit, Finance, Operations\./);
  h.pending = null;
});

test("a failed request shows a clear error with Try again, and keeps the page usable", async () => {
  let fail = true;
  const h = await makeBuilder({ respond: (request, reply) => (fail ? reply(500, { error: "Could not generate use cases." }) : reply(200, generateUseCases(request))) }).open();
  await h.click(h.industry("retail"));
  assert.equal(h.text("uc-count"), "The use case list could not be built.");
  assert.match(h.text("uc-empty"), /Could not build the use cases\. Could not generate use cases\./);
  assert.equal(h.byId("uc-empty").querySelector(".uc-empty").getAttribute("role"), "alert");
  fail = false;
  await h.click(h.byId("uc-retry"));
  assert.match(h.text("uc-count"), /^Showing \d+ of \d+ use cases for Retail\./);
});

test("when the options cannot load, the page says so and offers a retry", async () => {
  const h = makeBuilder();
  h.run("fetch = async () => ({ ok: false, status: 503, json: async () => ({ error: 'Service unavailable' }) })");
  await h.open();
  assert.match(h.byId("uc-root").textContent, /Could not load the Use Case Builder: Service unavailable/);
  assert.equal(h.byId("uc-root").querySelector("p").getAttribute("role"), "alert");
});

// ── Filters, sorting, paging ────────────────────────────────────────────────

test("filters, search, and sort change what is shown and keep the count honest", async () => {
  const h = await makeBuilder().open();
  await h.choose("retail", ["sales", "marketing"]);
  const response = generateUseCases({ industry: "retail", departments: ["sales", "marketing"] });
  const total = response.useCases.length;
  assert.match(h.text("uc-count"), new RegExp(`^Showing ${total} of ${total} use cases for Retail, Sales, Marketing\\.`));

  await h.set(h.byId("uc-filter-product"), AB, "change");
  assert.equal(h.cards(CS).length, 0);
  assert.equal(h.byId("uc-section-copilot-studio"), null);
  assert.equal(h.cards(AB).length, Math.min(12, response.useCases.filter((u) => u.product === AB).length));
  assert.equal(h.byId("uc-best").hidden, true, "Best matches steps aside while filters are on");

  await h.set(h.byId("uc-filter-level"), "100", "change");
  assert.ok(h.cards(AB).length > 0);
  assert.ok(h.cards(AB).every((card) => card.querySelector(".uc-badges").textContent.includes("Level 100")));
  await h.set(h.byId("uc-filter-product"), "all", "change");
  await h.set(h.byId("uc-filter-level"), "all", "change");

  await h.set(h.byId("uc-filter-department"), "marketing", "change");
  const marketingCount = response.useCases.filter((u) => u.departments.includes("marketing")).length;
  assert.match(h.text("uc-count"), new RegExp(`^Showing ${marketingCount} of ${total} use cases`));
  await h.set(h.byId("uc-filter-department"), "all", "change");

  await h.set(h.byId("uc-filter-goal"), "grow-revenue", "change");
  const goalCount = response.useCases.filter((u) => u.goals.includes("grow-revenue")).length;
  assert.match(h.text("uc-count"), new RegExp(`^Showing ${goalCount} of ${total}`));
  await h.set(h.byId("uc-filter-goal"), "all", "change");

  await h.set(h.byId("uc-search"), "spreadsheet");
  const found = response.useCases.filter((u) => /spreadsheet/i.test(`${u.title} ${u.description}`)).length;
  assert.ok(found > 0);
  const shown = Number(/^Showing (\d+) of/.exec(h.text("uc-count"))[1]);
  assert.ok(shown >= found && shown < total, "search also reads goals, tools, and departments");
  assert.ok(h.cards().length > 0 && h.cards().length <= shown);
  await h.set(h.byId("uc-search"), "zzzz-no-such-thing");
  assert.match(h.text("uc-empty"), /No use cases match these filters or that search\./);
  await h.click(h.byId("uc-clear-filters"));
  assert.equal(h.byId("uc-search").value, "");
  assert.match(h.text("uc-count"), new RegExp(`^Showing ${total} of ${total}`));

  await h.set(h.byId("uc-sort"), "level", "change");
  const levels = h.cards(CS).map((card) => Number(/Level (\d)00/.exec(card.querySelector(".uc-badges").textContent)[1]));
  assert.deepEqual(levels, [...levels].sort((a, b) => a - b));
  await h.set(h.byId("uc-sort"), "effort", "change");
  const order = { "A few hours": 1, "A few days": 2, "A few weeks": 3 };
  const efforts = h.cards(AB).map((card) => order[/Effort: (A few \w+)/.exec(card.querySelector(".uc-badges").textContent)[1]]);
  assert.deepEqual(efforts, [...efforts].sort((a, b) => a - b));
});

test("long lists page: 12 at a time with Show more, and the cap is explained", async () => {
  const h = await makeBuilder().open();
  await h.click(h.industry("education"));
  const response = generateUseCases({ industry: "education" });
  assert.equal(response.summary.capped, true);
  assert.match(h.text("uc-count"), new RegExp(`^Showing 40 of 40 use cases for Education\\. These are the best 40 of ${response.summary.matched} matches\\.$`));
  assert.equal(h.cards(CS).length, 12);
  const more = h.byId("uc-more-copilot-studio");
  assert.equal(more.textContent, "Show more (8 more)");
  await h.click(more);
  assert.equal(h.cards(CS).length, 20);
  assert.equal(h.byId("uc-more-copilot-studio"), null);
  assert.ok(h.byId("uc-notes").querySelectorAll(".uc-note").some((n) => /Showing the best 40 of \d+ matching use cases/.test(n.textContent)));
  assert.equal(h.byId("uc-section-copilot-studio").querySelector(".uc-section-sub").textContent, "20 of 20 shown");
});

// ── Cards ───────────────────────────────────────────────────────────────────

test("each card carries the title, badges, description, goals, details, shortlist checkbox, and a clear primary action", async () => {
  const h = await makeBuilder().open();
  await h.choose("healthcare", ["customer-service"]);
  const response = generateUseCases({ industry: "healthcare", departments: ["customer-service"] });
  const cs = response.useCases.find((u) => u.product === CS && u.harness === "standard" && u.knowledgeSources.length && u.toolsAndActions.length);
  const card = h.cards(CS).find((c) => c.getAttribute("data-uc-id") === cs.id);
  assert.ok(card);
  const text = card.textContent;
  for (const expected of [cs.title, cs.description, "Copilot Studio", "Standard harness", `Level ${cs.level}`, `Effort: ${cs.effort.label}`, "Shortlist", "Add to my lab plan", "Why this product", cs.whyProduct, "Starter instructions", cs.instructions, "Knowledge sources", "Tools, connectors, and actions", "Recommended lab topics", "Microsoft Learn", cs.knowledgeSources[0].label]) {
    assert.ok(text.includes(expected), `card shows "${expected.slice(0, 40)}"`);
  }
  for (const id of cs.goals) assert.ok(text.includes(h.run(`ucOptionName(ucState.options.goals, ${JSON.stringify(id)}, "label")`)));
  assert.equal(card.getAttribute("aria-labelledby"), card.querySelector(".uc-card-title").id);
  assert.equal(card.querySelector("details").hasAttribute("open"), false, "details start closed");
  assert.equal(card.querySelector(".uc-check input").type, "checkbox");
  assert.equal(h.addButton(card).getAttribute("aria-pressed"), "false");
  assert.equal(h.addButton(card).getAttribute("aria-describedby"), card.querySelector(".uc-card-title").id);
  const links = card.querySelectorAll("a");
  assert.ok(links.length >= 1);
  for (const link of links) {
    assert.match(link.getAttribute("href"), /^https:\/\/learn\.microsoft\.com\//);
    assert.equal(link.getAttribute("target"), "_blank");
    assert.equal(link.getAttribute("rel"), "noopener noreferrer");
    assert.match(link.textContent, /\(opens in a new tab\)$/);
  }
  const preview = response.useCases.find((u) => u.flags.preview);
  const previewCard = h.byId("uc-sections").querySelectorAll(".uc-card").find((c) => c.getAttribute("data-uc-id") === preview?.id);
  if (previewCard) assert.ok(previewCard.querySelector(".uc-badges").textContent.includes("Preview"));
});

test("hostile text from the server is only ever text: no element, no script, no unsafe link", async () => {
  const payload = `<img src=x onerror="alert(1)"><script>alert(2)</script>`;
  const h = await makeBuilder({
    respond: (request, reply) => {
      const response = generateUseCases(request);
      const hostile = response.useCases.slice(0, 3).map((u, index) => ({
        ...u,
        title: `${payload} ${u.title}`,
        description: payload,
        instructions: payload,
        whyProduct: payload,
        knowledgeSources: [{ id: "k", label: payload, example: payload }],
        toolsAndActions: [{ id: "t", label: payload, kind: "tool", note: payload, preview: false, thirdParty: false }],
        labTopics: [{ id: "x", name: payload, level: 200, minutes: 5, base: false, preview: false, thirdParty: false }],
        learnLinks: [
          { url: "javascript:alert(1)", title: payload },
          { url: "http://learn.microsoft.com/insecure", title: "Insecure link" },
          { url: "https://evil.example/phish", title: "Off-site link" },
          { url: "https://learn.microsoft.com/microsoft-copilot-studio/ok", title: index === 0 ? payload : "Good link" },
        ],
        value: { kpis: [payload], outcomes: [payload] },
      }));
      response.useCases.splice(0, 3, ...hostile);
      return reply(200, response);
    },
  }).open();
  await h.choose("retail");
  await h.set(h.byId("uc-search"), payload);
  await h.set(h.byId("uc-search"), "");
  const body = h.document.body;
  for (const tag of ["img", "script", "iframe", "svg"]) assert.equal(body.querySelectorAll(tag).length, 0, `no <${tag}> element`);
  assert.ok(body.textContent.includes(payload), "the payload is shown as text");
  const hrefs = body.querySelectorAll("a").map((a) => a.getAttribute("href"));
  assert.ok(hrefs.length > 0);
  for (const href of hrefs) assert.match(href, /^https:\/\/learn\.microsoft\.com\//);
  assert.equal(body.querySelectorAll("a").filter((a) => /evil\.example|javascript:|http:\/\//.test(a.getAttribute("href"))).length, 0);
  assert.ok(!/<img|<script/.test(h.text("uc-count")), "the count never repeats typed text as markup");
  for (const el of body.querySelectorAll("*")) for (const name of el.attributes.keys()) assert.ok(!/^on/i.test(name), `no ${name} attribute`);
});

// ── Shortlist, export, and storage ──────────────────────────────────────────

test("the checkbox and the primary action are one shortlist, and Select all shown and Clear work on what is on screen", async () => {
  const h = await makeBuilder().open();
  await h.choose("healthcare", ["hr"]);
  const first = h.cards(CS)[0];
  const id = first.getAttribute("data-uc-id");
  assert.equal(h.byId("uc-shortlist-count").textContent, "0 shortlisted");
  assert.equal(h.byId("uc-build-lab").disabled, true);
  await h.check(first.querySelector(".uc-check input"), true);
  assert.equal(h.addButton(first).getAttribute("aria-pressed"), "true");
  assert.ok(first.classList.contains("is-shortlisted"));
  assert.equal(h.byId("uc-shortlist-count").textContent, "1 shortlisted");
  assert.equal(h.byId("uc-build-lab").disabled, false);
  assert.match(h.byId("uc-shortlist-list").textContent, /Copilot Studio, Level \d00/);
  assert.match(h.text("uc-announce"), /Added to your lab plan: .*\. 1 use case shortlisted\./);

  await h.click(h.addButton(first));
  assert.equal(first.querySelector(".uc-check input").checked, false, "the button removes it again");
  assert.equal(h.byId("uc-shortlist-count").textContent, "0 shortlisted");
  await h.click(h.addButton(first));
  assert.equal(first.querySelector(".uc-check input").checked, true);
  assert.equal(h.byId("uc-best").querySelectorAll("[data-uc-add]").filter((b) => b.getAttribute("data-uc-add") === id)[0]?.getAttribute("aria-pressed") ?? "true", "true", "the Best matches strip stays in sync");

  await h.set(h.byId("uc-filter-product"), AB, "change");
  await h.click(h.byId("uc-select-all"));
  const shownAb = Math.min(12, h.cards(AB).length);
  assert.equal(h.byId("uc-shortlist-count").textContent, `${shownAb + 1} shortlisted`, "only what is shown was added, plus the earlier one");
  await h.click(h.byId("uc-clear-selection"));
  assert.equal(h.byId("uc-shortlist-count").textContent, "0 shortlisted");
  assert.equal(h.byId("uc-shortlist-list").querySelectorAll("li").length, 0);
  assert.ok(h.cards().every((card) => !card.classList.contains("is-shortlisted")));
});

test("the shortlist keeps items while the inputs change, removes one at a time, and stops at 40", async () => {
  const h = await makeBuilder().open();
  await h.choose("retail", ["sales"]);
  await h.click(h.addButton(h.cards(CS)[0]));
  await h.click(h.industry("education"));
  assert.equal(h.byId("uc-shortlist-count").textContent, "1 shortlisted", "a change of industry does not lose the shortlist");
  assert.equal(h.byId("uc-shortlist-list").querySelectorAll("li").length, 1);
  const remove = h.byId("uc-shortlist-list").querySelector("button");
  assert.equal(remove.getAttribute("aria-label"), `Remove ${clone(h.run("[...ucState.shortlist.values()][0].title"))} from the shortlist`);
  await h.click(remove);
  assert.equal(h.byId("uc-shortlist-count").textContent, "0 shortlisted");
  assert.equal(h.byId("uc-shortlist-list").querySelectorAll("li").length, 0);

  // A shortlist that already holds 39 takes one more and then says it is full.
  const healthcare = generateUseCases({ industry: "healthcare" }).useCases.slice(0, 39);
  const full = await makeBuilder({ stored: { v: 1, inputs: { industry: "retail", departments: [], goals: [], dataSources: [], platform: "both", level: null, polish: false }, shortlist: healthcare } }).open();
  assert.equal(full.byId("uc-shortlist-count").textContent, "39 shortlisted");
  await full.click(full.addButton(full.cards(CS)[0]));
  assert.equal(full.byId("uc-shortlist-count").textContent, "40 shortlisted");
  await full.click(full.addButton(full.cards(CS)[1]));
  assert.equal(full.byId("uc-shortlist-count").textContent, "40 shortlisted");
  assert.match(full.text("uc-announce"), /Your shortlist is full at 40 use cases\. Remove one to add another\./);
  assert.equal(full.cards(CS)[1].querySelector(".uc-check input").checked, false);
});

test("Markdown and CSV exports carry every field, escape markup, and defuse spreadsheet formulas", async () => {
  const h = await makeBuilder().open();
  await h.choose("financial-services", ["customer-service"]);
  const response = generateUseCases({ industry: "financial-services", departments: ["customer-service"] });
  const cs = response.useCases.find((u) => u.product === CS && u.harness === "standard" && u.knowledgeSources.length);
  const ab = response.useCases.find((u) => u.product === AB && u.knowledgeSources.length);
  for (const u of [cs, ab]) await h.click(h.addButton(h.cards().find((card) => card.getAttribute("data-uc-id") === u.id)));

  await h.click(h.byId("uc-copy-md"));
  const markdown = h.copied.at(-1);
  assert.match(markdown, /^# Use case shortlist: Financial Services, Customer Service\n/);
  assert.match(markdown, /2 use cases\. Built with the Use Case Builder\./);
  for (const u of [cs, ab]) {
    assert.ok(markdown.includes(`## ${[cs, ab].indexOf(u) + 1}. ${u.title}`));
    assert.ok(markdown.includes(`- **Product:** ${u.product === CS ? "Copilot Studio (Standard harness)" : "Agent Builder"}`));
    assert.ok(markdown.includes(`- **Level:** Level ${u.level}`));
    assert.ok(markdown.includes(u.description));
    assert.ok(markdown.includes("**Why this product**") && markdown.includes(u.whyProduct));
    assert.ok(markdown.includes(`\`\`\`\n${u.instructions}\n\`\`\``), "instructions are fenced");
    assert.ok(markdown.includes(`- ${u.labTopics[0].name} (Level ${u.labTopics[0].level}`));
    assert.ok(markdown.includes(`](${u.learnLinks[0].url})`));
  }
  assert.match(h.text("uc-handoff-status"), /Copied the shortlist as Markdown\./);

  await h.click(h.byId("uc-download-md"));
  assert.equal(h.blobs.at(-1).type, "text/markdown;charset=utf-8");
  assert.equal(await h.lastBlobText(), markdown);
  await h.click(h.byId("uc-download-csv"));
  assert.equal(h.blobs.at(-1).type, "text/csv;charset=utf-8");
  const csv = await h.lastBlobText();
  const rows = csv.trimEnd().split("\r\n");
  assert.equal(rows.length, 3);
  assert.equal(rows[0], '"Id","Title","Product","Harness","Level","Build effort","Departments","Goals","Description","KPIs","Knowledge sources","Tools and actions","Why this product","Recommended lab topics","Learn links"');
  assert.ok(rows[1].startsWith(`"${cs.id}","${cs.title}","Copilot Studio","Standard harness","Level ${cs.level} (`));

  // Hostile and formula-like text.
  const evil = { id: "retail.sales.cs-evil", title: '=HYPERLINK("http://evil","x")', description: 'He said "hi" <b>x</b>', product: CS, level: 200, industry: "retail", departments: ["sales"], goals: [], effort: "+cmd", kpis: ["@sum"], instructions: "``` fence-breaker ```", topics: [{ id: "agent-flows", name: "Agent flows", level: 200 }], links: [] };
  const evilItem = `ucSanitizeSnapshot(${JSON.stringify(evil)})`;
  const evilMd = h.run(`ucBuildMarkdown([${evilItem}], "Scope <i>")`);
  assert.ok(!evilMd.includes("<b>") && evilMd.includes("&lt;b&gt;x&lt;/b&gt;"));
  assert.ok(evilMd.includes("# Use case shortlist: Scope &lt;i&gt;"));
  assert.ok(evilMd.includes("````\n``` fence-breaker ```\n````"), "a longer fence survives backticks in the text");
  const evilCsv = h.run(`ucBuildCsv([${evilItem}])`).split("\r\n")[1];
  assert.ok(evilCsv.includes(`"'=HYPERLINK(""http://evil"",""x"")"`), "leading = is defused and quotes are doubled");
  assert.ok(evilCsv.includes(`"'+cmd"`) && evilCsv.includes(`"'@sum"`));
  assert.ok(!evilCsv.includes("\n"), "no raw newline inside a row");
  assert.equal(h.run('ucCsvCell("line one\\nline two")'), '"line one line two"');
  assert.equal(h.run('ucCsvCell("\\tTabbed")'), `"'\tTabbed"`);
});

test("choices and the shortlist are saved, restored after validation, and corrupted data is ignored", async () => {
  const h = await makeBuilder().open();
  await h.choose("nonprofit", ["finance", "hr"]);
  await h.click(h.goal("reduce-cost"));
  await h.click(h.source("none"));
  await h.check(h.radio("uc-level-options", 100), true);
  await h.click(h.addButton(h.cards(AB)[0]));
  const saved = JSON.parse(h.storage.get("cslabs.useCaseBuilder.v1"));
  assert.equal(saved.v, 1);
  assert.deepEqual(saved.inputs, { industry: "nonprofit", departments: ["finance", "hr"], goals: ["reduce-cost"], dataSources: ["none"], platform: "both", level: 100, polish: false });
  assert.equal(saved.shortlist.length, 1);

  const restored = await makeBuilder({ stored: saved }).open();
  assert.equal(restored.industry("nonprofit").getAttribute("aria-pressed"), "true");
  assert.equal(restored.department("finance").getAttribute("aria-pressed"), "true");
  assert.equal(restored.goal("reduce-cost").getAttribute("aria-pressed"), "true");
  assert.equal(restored.radio("uc-level-options", 100).checked, true);
  assert.equal(restored.byId("uc-shortlist-count").textContent, "1 shortlisted");
  await restored.settle();
  assert.deepEqual(restored.generated.at(-1).departments, ["finance", "hr"]);
  assert.match(restored.text("uc-count"), /for Nonprofit, Finance, HR\.$/);

  for (const corrupt of ["{not json", "null", "[]", '"text"', '{"v":2}', "123"]) {
    const clean = await makeBuilder({ stored: corrupt }).open();
    assert.equal(clean.text("uc-count"), "Choose an industry to build your use case list.", `ignored ${corrupt}`);
    assert.equal(clean.byId("uc-shortlist-count").textContent, "0 shortlisted");
  }
  const invalid = await makeBuilder({
    stored: {
      v: 1,
      inputs: { industry: "mining", departments: ["finance", "nope", 7, "finance"], goals: "reduce-cost", dataSources: ["web", "<b>"], platform: "excel", level: 7, polish: true },
      shortlist: [
        { id: "bad id", title: "x", product: CS, level: 200 },
        { id: "retail.sales.cs-ok", title: "Kept: <img src=x>", product: CS, level: 200, industry: "retail", departments: ["sales", "<x>"], goals: ["reduce-cost"], topics: [{ id: "agent-flows", name: "Agent flows", level: 200 }, { id: "BAD ID" }], links: [{ url: "https://learn.microsoft.com/ok", title: "ok" }, { url: "javascript:alert(1)", title: "bad" }, { url: "https://evil.example", title: "off" }] },
        { id: "retail.sales.cs-ok", title: "Duplicate", product: CS, level: 200 },
        { id: "retail.sales.cs-wrong", title: "Wrong product", product: "excel", level: 200 },
        null,
        "text",
      ],
    },
  }).open();
  const inputs = clone(invalid.run("ucState.inputs"));
  assert.deepEqual(inputs, { industry: "", departments: ["finance"], goals: [], dataSources: ["web"], platform: "both", level: null, polish: false });
  const kept = clone(invalid.run("[...ucState.shortlist.values()]"));
  assert.equal(kept.length, 1);
  assert.equal(kept[0].title, "Kept: <img src=x>");
  assert.deepEqual(kept[0].departments, ["sales"]);
  assert.deepEqual(kept[0].topics, [{ id: "agent-flows", name: "Agent flows", level: 200 }]);
  assert.deepEqual(kept[0].links, [{ url: "https://learn.microsoft.com/ok", title: "ok" }]);
  assert.equal(invalid.document.body.querySelectorAll("img").length, 0, "a stored title is shown as text");
});

// ── Hand-off to the lab builder ─────────────────────────────────────────────

test("Build a lab from my shortlist plans one lab from a mixed shortlist and hands it to the wizard", async () => {
  const h = await makeBuilder().open();
  await h.choose("healthcare", ["customer-service"]);
  const response = generateUseCases({ industry: "healthcare", departments: ["customer-service"] });
  const picks = [
    response.useCases.find((u) => u.patternId === "cs-knowledge-assistant"),
    response.useCases.find((u) => u.patternId === "cs-guided-intake"),
    response.useCases.find((u) => u.patternId === "ab-sharepoint-guide"),
  ];
  for (const u of picks) await h.click(h.addButton(h.cards().find((card) => card.getAttribute("data-uc-id") === u.id)));
  await h.click(h.byId("uc-build-lab"));
  assert.equal(h.handoffs.length, 1);
  const plan = clone(h.handoffs[0]);
  assert.deepEqual(plan.products, [CS, AB]);
  assert.equal(plan.industry, "healthcare");
  assert.deepEqual(plan.departments, ["customer-service"]);
  assert.equal(plan.harness, "standard");
  const topicIds = [...new Set(picks.flatMap((u) => u.labTopics.map((t) => t.id)))];
  assert.deepEqual(plan.topicIds, topicIds);
  assert.equal(plan.level, 200, "two of the three use cases are Level 200");
  assert.equal(plan.title, "Healthcare Customer Service: Copilot Studio and Agent Builder use cases");
  assert.match(h.text("uc-handoff-status"), /Lab builder pre-filled from your shortlist: Copilot Studio and Agent Builder, Level 200 \(Intermediate\), 4 topics selected\./);
  assert.match(h.text("app-live"), /Lab builder pre-filled from your shortlist/);
  assert.equal(h.toasts.at(-1).type, "info");
  assert.match(h.toasts.at(-1).message, /You are on the Topics step\. Change anything before you build\./);

  // The Lab level choice shows what each level would hold, and wins over the automatic pick.
  const options = h.byId("uc-lab-level").querySelectorAll("option").map((o) => [o.value, o.textContent]);
  assert.deepEqual(options.map(([value]) => value), ["auto", "100", "200", "300"]);
  assert.equal(options[0][1], "Automatic: Level 200 (Intermediate)");
  const countAt = (level) => new Set(picks.flatMap((u) => u.labTopics.filter((t) => t.level === level).map((t) => t.id))).size;
  for (const [value, text] of options.slice(1)) assert.equal(text, `Level ${value} (${{ 100: "Beginner", 200: "Intermediate", 300: "Advanced" }[value]}): ${countAt(Number(value))} topic${countAt(Number(value)) === 1 ? "" : "s"} from your shortlist`);
  await h.set(h.byId("uc-lab-level"), "100", "change");
  await h.click(h.byId("uc-build-lab"));
  assert.equal(h.handoffs.at(-1).level, 100);
  await h.set(h.byId("uc-lab-level"), "auto", "change");
  await h.click(h.byId("uc-build-lab"));
  assert.equal(h.handoffs.at(-1).level, 200);
});

test("the plan follows the wizard's rules: one harness, the harness most Copilot Studio use cases share, no harness without Copilot Studio", () => {
  const h = makeBuilder();
  const item = (over) => ({ id: "x.y.z", title: "T", product: CS, harness: "standard", industry: "retail", departments: ["sales"], goals: [], level: 200, topics: [{ id: "a", name: "A", level: 200 }], ...over });
  h.run("ucState.options = " + JSON.stringify(h.options));
  const plan = (items, input) => clone(h.run(`ucPlanLab(${JSON.stringify(items)}, ${JSON.stringify(input || {})})`));
  assert.equal(plan([item({ harness: "microsoft-copilot" }), item({ harness: "microsoft-copilot" }), item({})]).harness, "microsoft-copilot");
  assert.equal(plan([item({ harness: "customer-conversation" }), item({ harness: "microsoft-copilot" })]).harness, "microsoft-copilot", "a tie goes to the earlier harness in the wizard's order");
  const builderOnly = plan([item({ product: AB, harness: null })]);
  assert.deepEqual(builderOnly.products, [AB]);
  assert.equal(builderOnly.harness, null);
  assert.equal(plan([item({ industry: "retail" }), item({ industry: "retail" }), item({ industry: "education" })]).industry, "retail");
  assert.deepEqual(plan([item({ departments: ["it"] }), item({ departments: ["sales", "it"] })]).departments, ["sales", "it"]);
  assert.equal(plan([item({ level: 100 }), item({ level: 100 }), item({ level: 300 })]).level, 100, "most use cases are Level 100");
  assert.equal(plan([item({ level: 200 }), item({ level: 300 })]).level, 300, "a tie goes to the higher level");
  assert.equal(plan([item({})], { level: 300 }).level, 300, "an explicit lab level wins");
  assert.match(plan([item({ departments: ["sales", "it", "hr"] })]).title, /^Retail cross-department: Copilot Studio use cases$/);
  assert.match(plan([item({ departments: [] })]).title, /^Retail: Copilot Studio use cases$/);
});

test("a wizard with answers already in it asks before it is replaced, and Keep leaves everything alone", async () => {
  const h = await makeBuilder({ wizard: { progress: true } }).open();
  await h.choose("retail", ["sales"]);
  await h.click(h.addButton(h.cards(CS)[0]));
  await h.click(h.byId("uc-build-lab"));
  assert.equal(h.handoffs.length, 0, "nothing is replaced yet");
  const dialog = h.byId("uc-confirm").querySelector(".uc-confirm");
  assert.equal(dialog.getAttribute("role"), "alertdialog");
  assert.equal(dialog.getAttribute("aria-labelledby"), "uc-confirm-text");
  assert.match(dialog.textContent, /The lab builder already has answers\. Building from your shortlist replaces them, and your saved labs are not touched\./);
  assert.equal(h.document.activeElement, h.byId("uc-confirm-replace"), "focus moves into the question");
  await h.click(h.byId("uc-confirm-keep"));
  assert.equal(h.byId("uc-confirm").querySelectorAll("*").length, 0);
  assert.equal(h.handoffs.length, 0);
  assert.equal(h.document.activeElement, h.byId("uc-build-lab"));
  await h.click(h.byId("uc-build-lab"));
  await h.click(h.byId("uc-confirm-replace"));
  assert.equal(h.handoffs.length, 1);
  assert.equal(h.byId("uc-confirm").querySelectorAll("*").length, 0);
});

test("the hand-off reports skipped topics and a failing wizard without losing the shortlist", async () => {
  const skipped = { selected: 2, level: 200, harness: "standard", skipped: { level: ["A", "B", "C"], harness: ["D"], product: [], unknown: 0 } };
  const h = await makeBuilder({ wizard: { result: skipped } }).open();
  await h.choose("retail", ["sales"]);
  await h.click(h.addButton(h.cards(CS)[0]));
  await h.click(h.byId("uc-build-lab"));
  const status = h.text("uc-handoff-status");
  assert.match(status, /2 topics selected\./);
  assert.match(status, /3 recommended topics from other levels were not selected\. Lower-level topics your selection needs are added as short refreshers\./);
  assert.match(status, /1 topic for another agent experience \(harness\) was skipped\./);

  const failing = await makeBuilder({ wizard: { fail: "The lab builder catalog is not available." } }).open();
  await failing.choose("retail", ["sales"]);
  await failing.click(failing.addButton(failing.cards(CS)[0]));
  await failing.click(failing.byId("uc-build-lab"));
  assert.equal(failing.text("uc-handoff-status"), "Could not start the lab: The lab builder catalog is not available.");
  assert.equal(failing.byId("uc-shortlist-count").textContent, "1 shortlisted");
});

test("printing from the tab prints the results expanded, then puts everything back", async () => {
  const h = await makeBuilder().open();
  await h.choose("retail", ["sales"]);
  const panel = h.byId("panel-scenarios");
  panel.classList.add("active");
  const details = h.cards().map((card) => card.querySelector("details"));
  const [before] = h.windowListeners.beforeprint;
  const [after] = h.windowListeners.afterprint;
  before();
  assert.equal(h.document.body.dataset.printTarget, "usecases");
  assert.ok(details.every((d) => d.open));
  after();
  assert.equal(h.document.body.dataset.printTarget, undefined);
  assert.ok(details.every((d) => !d.open));
  panel.classList.remove("active");
  before();
  assert.equal(h.document.body.dataset.printTarget, undefined, "other tabs print as before");
});

// ── The wizard side of the hand-off ─────────────────────────────────────────

function makeWizard() {
  const { document } = createFakeDom();
  const body = document.body;
  const original = document.getElementById.bind(document);
  document.getElementById = (id) => {
    const found = original(id);
    if (found) return found;
    const el = document.createElement(/^lb-(title|time|agent-name|topic-search|sharepoint-site-(name|url))$/.test(id) ? "input" : "div");
    el.id = id;
    body.appendChild(el);
    return el;
  };
  const recommendCalls = [];
  const toasts = [];
  const tabs = [];
  const reply = (payload) => ({ ok: true, status: 200, json: async () => payload });
  const harnesses = getHarnesses();
  const context = vm.createContext({
    console,
    document,
    window: { scrollTo() {}, addEventListener() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    CSS: { escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&") },
    URL,
    setTimeout,
    escapeHtml: (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]),
    toast: (message, type) => toasts.push({ message, type }),
    setActiveTab: (tab) => tabs.push(tab),
    fetch: async (url, init = {}) => {
      if (url === "/api/lab-builder/recommend") {
        const body = JSON.parse(init.body || "{}");
        recommendCalls.push(body);
        return reply(recommend(body, {}));
      }
      if (String(url).includes("/api/lab-builder/")) return reply({ topics: [], checks: [], labs: [] });
      throw new Error(`Unexpected fetch ${url}`);
    },
  });
  vm.runInContext(WIZARD_SOURCE, context, { filename: "lab-builder-wizard.js" });
  context.__seed = {
    products: getProducts(),
    harnesses,
    categories: getFeaturesByCategory(),
    industries: getIndustries(),
    roles: getRoles(),
    levels: [{ level: 100, label: "Beginner" }, { level: 200, label: "Intermediate" }, { level: 300, label: "Advanced" }],
    differenceDefaults: Object.fromEntries(harnesses.map((h) => [h.id, defaultDifferencesFor(h.id)])),
  };
  vm.runInContext(
    `Object.assign(labBuilder, __seed); labBuilder.loaded = true;`,
    context,
  );
  const run = (code) => vm.runInContext(code, context);
  return { run, state: (expr) => clone(run(`(${expr})`)), recommendCalls, toasts, tabs, document, context };
}

const settleWizard = () => new Promise((resolve) => setTimeout(resolve, 30));

test("the wizard pre-fills from a plan and obeys its own level, harness, and product rules", async () => {
  const w = makeWizard();
  const plan = {
    products: [CS, AB],
    industry: "healthcare",
    departments: ["customer-service", "hr"],
    level: 200,
    harness: "standard",
    topicIds: ["knowledge-sharepoint", "agent-flows", "connector-tools", "dca-agent-builder-knowledge", "dca-agent-builder-first-agent", "mc-skills", "no-such-topic"],
    title: "Healthcare Customer Service: Copilot Studio and Agent Builder use cases",
  };
  const result = clone(await w.context.lbPrefillFromUseCases(plan));
  await settleWizard();
  const state = w.state("({ products: [...labBuilder.selectedProducts], industry: labBuilder.industry, roles: [...labBuilder.selectedRoles], level: labBuilder.level, harness: labBuilder.harness, picked: [...labBuilder.picked], excluded: [...labBuilder.excluded], chosen: [...labBuilder.chosenSteps], step: labBuilder.step, furthest: labBuilder.furthest })");
  assert.deepEqual(state.products.sort(), [CS, AB].sort());
  assert.equal(state.industry, "healthcare");
  assert.deepEqual(state.roles.sort(), ["customer-service", "hr"]);
  assert.equal(state.level, 200);
  assert.equal(state.harness, "standard");
  assert.deepEqual(state.picked.sort(), ["agent-flows", "connector-tools", "dca-agent-builder-knowledge"].sort(), "only level 200 topics on the chosen harness and products");
  assert.deepEqual(state.excluded, []);
  for (const step of ["product", "tailor", "topics"]) assert.ok(state.chosen.includes(step), step);
  assert.equal(state.step, w.state("LB_STEP.topics"), "lands on the Topics step");
  assert.equal(state.furthest, w.state("LB_STEP.topics"));
  assert.equal(w.document.getElementById("lb-harness-row").hidden, false, "Copilot Studio is chosen, so Tailor it shows the harness choice");
  assert.deepEqual(result.skipped.level.sort(), ["Build your first agent in Agent Builder", "SharePoint knowledge"]);
  assert.deepEqual(result.skipped.harness, ["Skills (Microsoft Copilot harness)"]);
  assert.equal(result.skipped.unknown, 1);
  assert.equal(result.selected, 3);
  assert.equal(result.level, 200);
  assert.equal(result.harness, "standard");
  assert.equal(w.document.getElementById("lb-title").value, plan.title);
  assert.deepEqual(w.tabs, ["labbuilder"]);

  // What the wizard would build is what it shows: the recommendation for those answers and picks.
  const request = w.state("lbRequest()");
  const call = w.recommendCalls.at(-1);
  assert.deepEqual(call.selected.sort(), state.picked.sort());
  assert.equal(call.level, 200);
  assert.equal(call.harness, "standard");
  assert.deepEqual(call.products.sort(), [CS, AB].sort());
  assert.deepEqual(request.features.filter((id) => state.picked.includes(id)).sort(), state.picked.sort());
  assert.ok(request.features.length >= state.picked.length, "prerequisite recaps may join, nothing else does");
  assert.equal(request.level, 200);
  assert.equal(request.harness, "standard");
});

test("a Microsoft Copilot harness plan keeps its harness topics and skips standard-only ones", async () => {
  const w = makeWizard();
  const result = clone(await w.context.lbPrefillFromUseCases({ products: [CS], industry: "retail", departments: [], level: 200, harness: "microsoft-copilot", topicIds: ["mc-skills", "mc-knowledge", "knowledge-dataverse", "agent-flows"] }));
  await settleWizard();
  assert.equal(w.state("labBuilder.harness"), "microsoft-copilot");
  assert.deepEqual(w.state("[...labBuilder.picked]"), ["mc-skills"], "mc-knowledge is level 100; the standard-only topics do not belong");
  assert.deepEqual(result.skipped.level, ["Add knowledge (Microsoft Copilot harness)"]);
  assert.deepEqual(result.skipped.harness.sort(), ["Agent flows", "Dataverse knowledge"].sort());
});

test("a plan with no Copilot Studio drops the harness, skips Copilot Studio topics, and repairs bad answers", async () => {
  const w = makeWizard();
  const result = clone(await w.context.lbPrefillFromUseCases({ products: [AB, "not-a-product"], industry: "mining", departments: ["hr", "wizard"], level: 7, harness: "microsoft-copilot", topicIds: ["dca-agent-builder-first-agent", "agent-flows", "dca-agent-builder-knowledge"] }));
  await settleWizard();
  assert.deepEqual(w.state("[...labBuilder.selectedProducts]"), [AB]);
  assert.equal(w.state("labBuilder.industry"), null);
  assert.deepEqual(w.state("[...labBuilder.selectedRoles]"), ["hr"]);
  assert.equal(w.state("labBuilder.level"), 100, "an invalid level falls back to 100");
  assert.equal(w.state("labBuilder.harness"), "standard");
  assert.equal(w.document.getElementById("lb-harness-row").hidden, true, "Tailor it hides the harness choice for a product without harnesses");
  assert.equal(w.document.getElementById("lb-harness-options").innerHTML, "");
  assert.deepEqual(w.state("[...labBuilder.picked]"), ["dca-agent-builder-first-agent"]);
  assert.deepEqual(result.skipped.product, ["Agent flows"]);
  assert.equal(result.harness, null);
  assert.equal("harness" in w.recommendCalls.at(-1), false, "no harness is sent for Agent Builder alone");
  await assert.rejects(() => w.context.lbPrefillFromUseCases({ products: ["nothing"], topicIds: [] }), /None of the shortlisted products can be built into a lab/);
});

test("starting from a shortlist replaces earlier answers and stops editing a saved lab", async () => {
  const w = makeWizard();
  w.run(`
    labBuilder.selectedProducts = new Set(["sharepoint-ai"]);
    labBuilder.industry = "retail";
    labBuilder.level = 300;
    labBuilder.picked = new Set(["old"]);
    labBuilder.excluded = new Set(["gone"]);
    labBuilder.step7Removed = new Map([["x", {}]]);
    labBuilder.editing = { labId: "lab-1", title: "Saved lab" };
  `);
  await w.context.lbPrefillFromUseCases({ products: [CS], industry: "education", departments: [], level: 100, harness: "standard", topicIds: ["create-agent"] });
  await settleWizard();
  assert.deepEqual(w.state("[...labBuilder.selectedProducts]"), [CS]);
  assert.equal(w.state("labBuilder.industry"), "education");
  assert.equal(w.state("labBuilder.level"), 100);
  assert.deepEqual(w.state("[...labBuilder.excluded]"), []);
  assert.equal(w.state("labBuilder.step7Removed.size"), 0);
  assert.equal(w.state("labBuilder.editing"), null);
  assert.deepEqual(w.state("[...labBuilder.picked]"), ["create-agent"]);
});

// ── The rename, aliases, and page rules ─────────────────────────────────────

test("the tab is the Use Case Builder, with the same ids and two friendly addresses", () => {
  assert.match(HTML, /<button class="tab" id="tab-scenarios" role="tab" aria-selected="false" aria-controls="panel-scenarios" tabindex="-1" data-tab="scenarios" data-group="build">💡 Use Case Builder<\/button>/);
  assert.match(HTML, /<div class="tab-panel" id="panel-scenarios" role="tabpanel" aria-labelledby="tab-scenarios" aria-hidden="true">/);
  assert.match(HTML, /<h3 id="uc-heading" tabindex="-1">💡 Use Case Builder<\/h3>/);
  assert.match(HTML, /<div id="uc-root">/);
  assert.match(HTML, /Also set up the provisioning labs for this scenario/);
  assert.match(HTML, /onclick="applyScenarioConfig\(\)">Apply scenario to Lab setup<\/button>/);
  for (const id of ["scenario-selected-title", "scenario-description", "scenario-categories", "scenario-kpis", "scenario-labs-preview", "scenario-apply-status"]) {
    assert.match(HTML, new RegExp(`id="${id}"`), `${id} is kept so nothing is lost`);
  }
  assert.ok(HTML.indexOf('src="use-case-builder.js"') > HTML.indexOf('src="app.js"'));
  assert.match(APP_SOURCE, /hint: "Create a lab step by step, or build a list of use cases for your scenario\."/);

  const snippet = /const TAB_ALIASES = [\s\S]*?\nfunction resolveTabAlias\(name\) \{[\s\S]*?\n\}/.exec(APP_SOURCE)?.[0];
  assert.ok(snippet, "alias table and resolver exist");
  const resolve = vm.runInNewContext(`${snippet}; resolveTabAlias`);
  assert.equal(resolve("usecases"), "scenarios");
  assert.equal(resolve("use-case-builder"), "scenarios");
  assert.equal(resolve("scenarios"), "scenarios");
  assert.equal(resolve("labbuilder"), "labbuilder");
  assert.equal(resolve("constructor"), "constructor", "inherited object keys are not aliases");
  assert.equal(resolve(""), "");
  assert.match(APP_SOURCE, /const requested = resolveTabAlias\(window\.location\.hash\.slice\(1\)\);/);
  assert.match(APP_SOURCE, /const fromHash = resolveTabAlias\(window\.location\.hash\.slice\(1\)\);/);
  assert.match(APP_SOURCE, /if \(typeof ucOnTabShown === "function"\) ucOnTabShown\(\);/);
});

test("no UI copy or document still calls it Industry scenarios, except the one note that says what it used to be called", () => {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(html|js|md)$/.test(name)) files.push(path);
    }
  };
  walk(join(portalRoot, "public"));
  walk(join(repoRoot, "docs"));
  files.push(join(repoRoot, "README.md"), join(portalRoot, "README.md"));
  const hits = [];
  for (const file of files) {
    for (const [index, line] of readFileSync(file, "utf8").split(/\r?\n/).entries()) {
      if (/industry[- ]scenario/i.test(line)) hits.push(`${relative(repoRoot, file).replace(/\\/g, "/")}:${index + 1}: ${line.trim()}`);
    }
  }
  assert.equal(hits.length, 1, hits.join("\n"));
  assert.match(hits[0], /^docs\/lab-builder\.md:\d+: .*formerly/i);
  assert.doesNotMatch(HTML, /🏢 Industry|Scenario Planner/i);
});

test("the Use Case Builder script builds DOM safely: no HTML parsing, links only to Microsoft Learn, noopener on every new tab", () => {
  for (const forbidden of [/\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write/, /\beval\(/, /new Function\(/, /setTimeout\(\s*["'`]/]) {
    assert.doesNotMatch(UC_SOURCE, forbidden, String(forbidden));
  }
  assert.match(UC_SOURCE, /target: "_blank", rel: "noopener noreferrer"/);
  assert.match(UC_SOURCE, /parsed\.hostname !== "learn\.microsoft\.com"/);
  assert.match(UC_SOURCE, /parsed\.protocol !== "https:"/);
  assert.match(UC_SOURCE, /aria-live": "polite"/);
});

const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const luminance = (rgb) => {
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [l1, l2] = [luminance(hexToRgb(a)), luminance(hexToRgb(b))];
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};
const tokens = (block) => Object.fromEntries([...block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)].map((m) => [m[1], m[2].trim()]));

test("the Use Case Builder's colors meet WCAG AA in dark and light, and the OS-light block matches the light theme", () => {
  const style = HTML.match(/<style>([\s\S]*?)<\/style>/)[1];
  const dark = tokens(style.match(/:root\s*\{([^}]*)\}/)[1]);
  const light = tokens(style.match(/:root\[data-theme="light"\],\s*body\[data-theme="light"\]\s*\{([^}]*)\}/)[1]);
  const media = tokens(style.match(/@media \(prefers-color-scheme: light\) \{\s*:root:not\(\[data-theme="dark"\]\) \{([^}]*)\}/)[1]);
  const ucTokens = Object.keys(dark).filter((name) => name.startsWith("--uc-"));
  assert.deepEqual(ucTokens.sort(), ["--uc-ab-bg", "--uc-ab-border", "--uc-ab-fg", "--uc-chip-on-bg", "--uc-chip-on-border", "--uc-chip-on-fg", "--uc-cs-bg", "--uc-cs-border", "--uc-cs-fg"]);
  for (const name of ucTokens) assert.equal(media[name], light[name], `${name} is the same in the OS-light block`);
  for (const [theme, t] of [["dark", dark], ["light", light]]) {
    for (const [fg, bg] of [["--uc-cs-fg", "--uc-cs-bg"], ["--uc-ab-fg", "--uc-ab-bg"], ["--uc-chip-on-fg", "--uc-chip-on-bg"], ["--stat-chip-text", "--stat-chip-bg"], ["--sc-warn-fg", "--sc-warn-bg"], ["--sc-info-fg", "--sc-info-bg"], ["--text", "--lb-card-checked-bg"], ["--text-muted", "--bg"], ["--text-muted", "--surface"], ["--link-color", "--lb-card-checked-bg"], ["--link-color", "--bg"], ["--text", "--code-bg"]]) {
      assert.ok(contrast(t[fg], t[bg]) >= 4.5, `${theme}: ${fg} on ${bg} is ${contrast(t[fg], t[bg]).toFixed(2)}:1`);
    }
    for (const border of ["--uc-cs-border", "--uc-ab-border", "--border-strong"]) {
      for (const surface of ["--surface", "--bg"]) assert.ok(contrast(t[border], t[surface]) >= 3, `${theme}: ${border} on ${surface}`);
    }
    // The selected chip is told apart from an unselected one by more than color: a check mark, and a stronger fill.
    assert.ok(contrast(t["--uc-chip-on-bg"], t["--bg"]) >= 1.5);
  }
});

test("Copy as Markdown and Copy instructions confirm visibly with a checkmark and words, fade after 3 seconds, and explain a blocked clipboard", async () => {
  const h = await makeBuilder().open();
  await h.choose("healthcare", ["customer-service"]);
  const response = generateUseCases({ industry: "healthcare", departments: ["customer-service"] });
  const first = h.cards()[0];
  await h.click(h.addButton(first));

  const ackText = (el) => (el.querySelector(".sc-copy-ack-text") || { textContent: "" }).textContent;
  await h.click(h.byId("uc-copy-md"));
  const shortlistAck = h.byId("uc-copy-md-ack");
  assert.match(shortlistAck.className, /sc-copy-ack-ok/);
  assert.equal(ackText(shortlistAck), "Shortlist copied to your clipboard");
  assert.ok(shortlistAck.querySelector("svg.sc-copy-ack-icon"), "a checkmark icon sits next to the words");
  assert.equal(shortlistAck.querySelector("svg").getAttribute("aria-hidden"), "true");
  assert.equal(h.text("uc-handoff-status"), "Copied the shortlist as Markdown.", "the existing status line and announcement are unchanged");
  h.advance(3100);
  assert.equal(shortlistAck.className, "sc-copy-ack", "the confirmation clears after about 3 seconds");
  assert.equal(shortlistAck.children.length, 0);

  const instructionsButton = first.querySelector(".uc-code-copy");
  assert.ok(instructionsButton, "the Copy instructions button is built with the card");
  const instructionsAck = first.querySelector(".sc-copy-ack");
  assert.ok(instructionsAck, "an empty confirmation element sits with the Copy instructions button");
  assert.equal(instructionsAck.className, "sc-copy-ack");
  await h.click(instructionsButton);
  assert.match(instructionsAck.className, /sc-copy-ack-ok/);
  assert.equal(ackText(instructionsAck), "Instructions copied to your clipboard");
  assert.equal(h.copied.at(-1), response.useCases.find((u) => u.id === first.getAttribute("data-uc-id")).instructions);
  assert.match(h.text("uc-announce"), /Instructions copied to your clipboard\./);

  h.context.navigator.clipboard.writeText = async () => {
    throw new Error("blocked");
  };
  await h.click(instructionsButton);
  assert.match(instructionsAck.className, /sc-copy-ack-fail/);
  assert.equal(ackText(instructionsAck), "Couldn't copy. Select the instructions and press Ctrl+C.");
  assert.doesNotMatch(instructionsAck.className, /sc-copy-ack-ok/, "a failure is never green");
  await h.click(h.byId("uc-copy-md"));
  assert.match(h.byId("uc-copy-md-ack").className, /sc-copy-ack-fail/);
  assert.match(h.text("uc-handoff-status"), /Copy is not available in this browser\. Use Download Markdown instead\./);
});

test("the Use Case Builder's copy confirmation reuses the shared confirmation styles and is hidden when printing", () => {
  const css = HTML.slice(HTML.indexOf(".sc-copy-ack {"), HTML.indexOf("@keyframes sc-copy-ack-fade"));
  assert.match(css, /\.sc-copy-ack-ok \{[^}]*--sc-ok-bg[^}]*--sc-ok-fg/s);
  const printBlock = HTML.slice(HTML.indexOf("@media print"));
  assert.match(printBlock.slice(0, printBlock.indexOf("</style>")), /\.sc-copy-ack\b/);
});

test("print rules for the Use Case Builder live in the one existing print block, and screen rules sit next to the scenario rules", () => {
  const style = HTML.match(/<style>([\s\S]*?)<\/style>/)[1];
  assert.equal((style.match(/@media print/g) || []).length, 1, "exactly one print block, so tests that split at it keep working");
  const [screen, print] = style.split("@media print");
  assert.match(print, /body\[data-print-target="usecases"\] \.tab-panel:not\(#panel-scenarios\) \{\s*display: none !important;/);
  assert.match(print, /body\[data-print-target="usecases"\] #panel-scenarios\.tab-panel \{\s*display: block !important;/);
  assert.match(print, /#panel-scenarios \.uc-inputs,[\s\S]*?#panel-scenarios \.uc-toolbar,[\s\S]*?#panel-scenarios \.uc-card-actions,[\s\S]*?display: none !important;/);
  assert.match(print, /#panel-scenarios \.uc-card,[\s\S]*?break-inside: avoid;[\s\S]*?background: #fff !important;[\s\S]*?color: #000 !important;/);
  assert.ok(print.indexOf('body[data-print-target="usecases"] #panel-scenarios.tab-panel') > print.indexOf("body:not([data-print-target=\"generated\"]) .tab-panel:not(#panel-preview)"), "later in the block, so it wins the tie");
  assert.doesNotMatch(screen, /print-target="usecases"/);
  assert.ok(!/\.uc-[a-z-]+\s*\{/.test(print.replace(/#panel-scenarios \.uc-[a-z-]+/g, "")), "print rules are scoped to the panel");
  assert.ok(screen.indexOf(".scenario-empty {") < screen.indexOf(".uc-chip {") && screen.indexOf(".uc-chip {") < screen.indexOf("/* ── Lab builder wizard"), "next to the existing scenario rules");
  assert.match(screen, /@media \(max-width: 560px\) \{\s*\.uc-card \{ padding: 12px; \}/, "small screens are handled");
  assert.match(screen, /:where\(a, button, input, select, textarea, summary, \[tabindex\]\):focus-visible/, "the global visible focus ring covers every control");
  assert.match(screen, /@media \(prefers-reduced-motion: reduce\) \{\s*\*, \*::before, \*::after \{/, "reduced motion is honored everywhere");
  assert.doesNotMatch(screen.slice(screen.indexOf(".uc-intro"), screen.indexOf("/* ── Lab builder wizard")), /#[0-9a-f]{3,8}\b/i, "the new screen rules use theme variables, not fixed colors");
});
