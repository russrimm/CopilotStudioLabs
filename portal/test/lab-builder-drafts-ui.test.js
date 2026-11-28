/**
 * Save and resume in the wizard: the real wizard script and the real drafts script, running in node:vm against the
 * fake DOM, the real markup of the Lab Builder panel from index.html, and a real drafts server (the real routes and
 * store on a throwaway folder). Recommendations and previews come from the real code, over made-up Microsoft Learn topics.
 * Nothing touches a browser or a network. Only made-up names appear here (contoso, fabrikam).
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import vm from "node:vm";
import express from "express";

import { getFeatures, getFeaturesByCategory, getHarnesses } from "../lib/lab-builder/catalog.js";
import { defaultDifferencesFor } from "../lib/lab-builder/differences.js";
import { getProducts } from "../lib/lab-builder/products.js";
import { recommend } from "../lib/lab-builder/recommend.js";
import { planLab } from "../lib/lab-builder/planner.js";
import { listHash } from "../lib/lab-builder/topic-snapshot.js";
import { resetTopicSource, setTopicSource } from "../lib/lab-builder/topic-store.js";
import { topicId } from "../lib/lab-builder/topic-sanitize.js";
import { draftsDirFor, MAX_DRAFTS } from "../lib/lab-builder/drafts.js";
import { registerDraftRoutes } from "../lib/lab-builder/drafts-api.js";
import { createRateLimiter, positiveIntFromEnv } from "../lib/rate-limit.js";
import { getIndustries, getRoles } from "../lib/scenarios.js";
import { createFakeDom } from "./fixtures/fake-dom.js";
import { installInnerHtml, parseHtml } from "./fixtures/fake-html.js";

process.env.LAB_BUILDER_LINK_CHECK = "off";

const portalRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (name) => readFileSync(join(portalRoot, "public", name), "utf8");
const WIZARD = read("lab-builder-wizard.js");
const DRAFTS = read("lab-builder-drafts.js");
const HTML = read("index.html");
const STAGE = HTML.slice(HTML.indexOf('<div class="lb-wizard-stage"'), HTML.indexOf('<div class="panel" id="lb-result-panel"'));
const DRAFTS_SECTION = HTML.slice(HTML.indexOf('<section class="lb-generated-section" id="lb-drafts-section"'), HTML.indexOf("</section>", HTML.indexOf('id="lb-drafts-section"')) + "</section>".length);

const BASE = "https://learn.microsoft.com/microsoft-copilot-studio";
const urlOf = (slug) => `${BASE}/${slug}`;

function learnTopic(slug, title, subs = []) {
  const url = urlOf(slug);
  const subtopics = subs.map((sub) => ({ id: topicId(urlOf(sub.slug)), title: sub.title, url: urlOf(sub.slug) }));
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
  };
}

const ALPHA = learnTopic("alpha-trigger", "Alpha trigger", [
  { slug: "alpha-trigger-overview", title: "Alpha trigger overview" },
  { slug: "alpha-trigger-examples", title: "Alpha trigger examples" },
  { slug: "alpha-trigger-limits", title: "Alpha trigger limits" },
]);
const PLAIN = learnTopic("plain-topic", "Plain topic");
const TOPICS = [ALPHA, PLAIN];

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const reply = (status, payload) => ({ ok: status >= 200 && status < 300, status, json: async () => clone(payload) });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const cleanups = [];
after(() => {
  for (const clean of cleanups.reverse()) clean();
});

/** A drafts server (the real routes and store) that several "page loads" can share, like one portal and one browser profile. */
async function startDrafts() {
  const dir = mkdtempSync(join(tmpdir(), "lb-drafts-ui-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const app = express();
  app.use("/api/lab-builder/drafts", express.json({ limit: "320kb" }));
  const store = registerDraftRoutes(app, { dataDir: dir, createRateLimiter, positiveIntFromEnv });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  cleanups.push(() => server.close());
  const folder = join(draftsDirFor(dir), "local");
  return { base: `http://127.0.0.1:${server.address().port}`, store, folder, files: () => readdirSync(folder) };
}

/** One page load: a fresh fake document and a fresh wizard script talking to the shared drafts server. */
async function makePage(t, drafts, { loaded = true } = {}) {
  const snapshot = { schemaVersion: 1, generatedAt: "2026-11-13T12:00:00Z", source: "test", catalogVersion: "test", topics: TOPICS, catalog: [], pageHashes: {} };
  snapshot.listHash = listHash(snapshot);
  setTopicSource({ source: "cache", snapshot });
  t.after(() => resetTopicSource());
  const learn = { topics: snapshot.topics, checks: [], updatedWindowDays: 30, now: Date.parse("2026-11-18T12:00:00Z") };

  const dom = createFakeDom();
  installInnerHtml(dom);
  const { document, FakeEvent } = dom;
  for (const node of parseHtml(`${STAGE}${DRAFTS_SECTION}`, document)) document.body.appendChild(node);

  const h = { document, FakeEvent, toasts: [], previewCalls: [], recommendCalls: [], draftCalls: [] };
  const harnesses = getHarnesses();
  const plan = (request) => {
    const p = planLab(request);
    return {
      title: p.title, slug: p.slug, difficulty: p.difficulty, duration: p.duration, totalMinutes: p.totalMinutes, estimate: p.estimate,
      agentName: p.profile.agentName,
      scenario: { problem: p.profile.problem, outcome: p.profile.outcome, sampleQuestions: p.profile.sampleQuestions },
      modules: p.features.map((f) => ({
        id: f.id, order: f.order, stepOrder: f.stepOrder ?? null, recapOrder: f.recapOrder ?? null, stepLabel: f.stepLabel, name: f.name,
        category: f.category, level: f.level, role: f.prerequisite ? "prerequisite" : "level", minutes: f.minutes, summary: f.summary,
        ...(f.harnessPart ? { harnessPart: f.harnessPart } : {}),
        docUrls: f.docUrls || [], learnLinks: f.learnLinks || [],
        ...(f.learnTopic?.subtopicChoices?.length ? { subtopics: f.learnTopic.subtopicChoices } : {}),
      })),
      level: p.level, products: p.products, productNames: p.productNames, harness: p.harness,
      ...(p.harnessParts ? { harnessMode: p.harnessMode, harnesses: p.harnesses, harnessParts: p.harnessParts } : {}),
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
      if (String(url).startsWith("/api/lab-builder/drafts")) {
        h.draftCalls.push({ method: init.method || "GET", url: String(url), body: init.body ? JSON.parse(init.body) : undefined });
        return fetch(`${drafts.base}${url}`, init);
      }
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
      if (String(url).startsWith("/api/lab-builder/")) return reply(200, { topics: [], checks: [], labs: [] });
      throw new Error(`Unexpected fetch ${url}`);
    },
  });
  vm.runInContext(WIZARD, context, { filename: "lab-builder-wizard.js" });
  vm.runInContext(DRAFTS, context, { filename: "lab-builder-drafts.js" });
  context.__seed = {
    products: getProducts(),
    harnesses,
    categories: getFeaturesByCategory(),
    industries: getIndustries(),
    roles: getRoles(),
    levels: [{ level: 100, label: "Beginner" }, { level: 200, label: "Intermediate" }, { level: 300, label: "Advanced" }],
    differenceDefaults: Object.fromEntries(harnesses.map((x) => [x.id, defaultDifferencesFor(x.id)])),
    learn: { topics: snapshot.topics, checks: [] },
  };
  vm.runInContext("Object.assign(labBuilder, __seed); labBuilder.loaded = true; lbBindTopicEvents(); lbRenderAllSteps();", context);
  h.context = context;
  h.run = (code) => vm.runInContext(code, context);
  h.state = (expr) => clone(vm.runInContext(`(${expr})`, context));
  h.settle = async () => {
    for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  /** Wait for something that depends on the real server (a click starts a request that settles a little later). */
  h.until = async (check, label = "the page to settle") => {
    const deadline = Date.now() + 5000;
    for (;;) {
      await h.settle();
      if (await check()) return;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
      await wait(15);
    }
  };
  h.refresh = async () => {
    await h.run("lbRefresh()");
    await h.settle();
  };
  h.byId = (id) => document.getElementById(id);
  h.text = (id) => h.byId(id).textContent;
  h.click = async (el) => {
    assert.ok(el, "the control exists");
    el.click();
    await h.settle();
  };
  h.press = (id, init) => h.byId(id).dispatchEvent(new FakeEvent("keydown", init));
  h.rows = () => [...document.querySelectorAll("#lb-drafts-list [data-draft-id]")];
  h.rowButton = (draftId, action) => h.rows().find((row) => row.dataset.draftId === draftId)?.querySelector(`[data-draft-action="${action}"]`);
  h.rowText = (draftId) => h.rows().find((row) => row.dataset.draftId === draftId)?.textContent || "";
  h.focusedId = () => document.activeElement?.id || "";
  /** Run an element's inline handler (`onclick="..."`, `onkeydown="..."`) the way a browser does; the fake DOM does not run attributes. */
  h.inline = (id, attribute, init = {}) => {
    const code = document.getElementById(id)?.getAttribute(attribute);
    assert.ok(code, `#${id} has an inline ${attribute}`);
    return vm.runInContext(`(function (event) { ${code} })`, context)(init);
  };
  /** Freeze "now" inside the page so default draft names are predictable. */
  h.freezeClock = (when) => {
    context.__now = when.getTime();
    vm.runInContext("globalThis.Date = (() => { const Real = Date; return class extends Real { constructor(...args) { super(...(args.length ? args : [__now])); } static now() { return __now; } }; })()", context);
  };
  if (loaded) {
    await h.run("lbDraftsInit()");
    await h.settle();
  }
  return h;
}

const catalogIds = (level = 200) => {
  const rec = recommend({ products: ["copilot-studio"], level, harness: "standard" }, { topics: TOPICS, checks: [], now: Date.parse("2026-11-18T12:00:00Z") });
  return rec.concepts.flatMap((c) => c.topics).filter((t) => t.source !== "learn").map((t) => t.id);
};
const CATALOG = catalogIds();
const LEVEL_300 = getFeatures().find((f) => (f.product || "copilot-studio") === "copilot-studio" && f.level === 300 && (f.harness || []).includes("standard"));
const INDUSTRY = getIndustries()[0].id;
const ROLES = getRoles().slice(0, 2).map((r) => r.id);

const REMOVED_NAME = getFeatures().find((f) => f.id === CATALOG[1]).name;

/** Build a rich, partly finished lab through the wizard's own state, the way the steps would leave it. */
async function richState(h, { step = 3 } = {}) {
  h.context.__rich = { industry: INDUSTRY, roles: ROLES, catalogA: CATALOG[0], catalogB: CATALOG[1], alpha: ALPHA.id, plain: PLAIN.id, sub: ALPHA.subtopics[0].id, removedName: REMOVED_NAME, step };
  h.run(`
    labBuilder.selectedProducts = new Set(["copilot-studio", "sharepoint-ai"]);
    labBuilder.industry = __rich.industry;
    labBuilder.selectedRoles = new Set(__rich.roles);
    labBuilder.level = 200;
    labBuilder.harness = "standard";
    labBuilder.differencesFor = new Set(["microsoft-copilot"]);
    labBuilder.chosenSteps = new Set(["product", "tailor", "topics"]);
    labBuilder.picked = new Set([__rich.catalogA, __rich.alpha, __rich.plain]);
    labBuilder.excluded = new Set([__rich.catalogB]);
    labBuilder.excludedSubtopics = new Set([__rich.sub]);
    labBuilder.step7Removed = new Map([[__rich.catalogB, { id: __rich.catalogB, name: __rich.removedName, summary: "", level: 200, role: "level", minutes: 20, docUrls: [], learnLinks: [], wasPicked: true }]]);
    labBuilder.moduleOrder = [__rich.plain, __rich.catalogA];
    labBuilder.brand.profileId = "profile-contoso";
    labBuilder.brand.overrides = { companyName: "Contoso", tagline: "Learn by doing" };
    lbSetFormValue("lb-title", "Contoso support lab");
    lbSetFormValue("lb-time", 180);
    lbSetFormValue("lb-agent-name", "Contoso Assistant");
    lbSetFormValue("lb-sharepoint-site-name", "Contoso Team");
    lbSetFormValue("lb-sharepoint-site-url", "https://contoso.sharepoint.com/sites/team");
    lbSetFormValue("lb-use-learn", false);
    lbSetFormValue("lb-use-llm", false);
    lbSetFormValue("lb-include-knowledge-check", true);
  `);
  await h.refresh();
  h.run(`labBuilder.furthest = LB_STEP.review; lbGoToStep(${step});`);
  await h.settle();
}

const NAME_BUTTON = "lb-draft-name-save";
async function saveVia(h, name) {
  h.run("lbDraftOpenSave()");
  if (name !== undefined) h.byId("lb-draft-name").value = name;
  h.byId("lb-draft-name-form").dispatchEvent(new h.FakeEvent("submit"));
  await h.until(() => !h.byId("lb-draft-name-dialog").open, "the save dialog to close");
  await h.settle();
}

// ── Round trip ──────────────────────────────────────────────────────────────

test("a rich wizard state survives Save and finish later and Resume exactly", async (t) => {
  const drafts = await startDrafts();
  const h = await makePage(t, drafts);
  await richState(h, { step: 3 });
  const before = h.state("lbDraftContent()");
  assert.equal(before.selections.products.length, 2);
  assert.deepEqual(before.selections.excludedSubtopics, [ALPHA.subtopics[0].id]);
  assert.deepEqual(before.wizard.removed, [{ id: CATALOG[1], wasPicked: true }]);

  await saveVia(h, "Contoso pilot");
  const saved = drafts.store.list("local").drafts;
  assert.equal(saved.length, 1);
  assert.equal(saved[0].name, "Contoso pilot");

  // A new page load, then Resume from the Saved drafts panel.
  const page = await makePage(t, drafts);
  await page.click(page.rowButton(saved[0].id, "resume"));
  await page.until(() => page.state("labBuilder.step") === 3, "the draft to open");
  const after = page.state("lbDraftContent()");
  assert.deepEqual(after.selections, before.selections, "every choice, in every step, comes back as it was");
  assert.deepEqual(after.wizard, before.wizard, "the step, the answered steps, the picks, and the removed modules too");
  assert.deepEqual(after.labels, before.labels);
  assert.equal(page.state("labBuilder.step7Removed.size"), 1);
  assert.deepEqual(page.state("[...labBuilder.excludedSubtopics]"), [ALPHA.subtopics[0].id]);
  assert.equal(page.state("labBuilder.picked === null"), false);
  assert.equal(page.byId("lb-title").value, "Contoso support lab");
  assert.equal(page.byId("lb-sharepoint-site-url").value, "https://contoso.sharepoint.com/sites/team");
  assert.equal(page.byId("lb-use-learn").checked, false);
  assert.equal(page.byId("lb-include-knowledge-check").checked, true);
  assert.equal(page.state("labBuilder.brand.overrides.companyName"), "Contoso");
  assert.equal(page.state("lbDraft.activeId"), saved[0].id, "the draft stays and is the one open now");
  assert.equal(drafts.store.list("local").drafts.length, 1, "resuming never removes the draft");
});

test("following a draft's saved picks is kept apart from the learner's own picks", async (t) => {
  const drafts = await startDrafts();
  const h = await makePage(t, drafts);
  h.run(`labBuilder.selectedProducts = new Set(["copilot-studio"]); labBuilder.chosenSteps = new Set(["product"]);`);
  await h.refresh();
  const content = h.state("lbDraftContent()");
  assert.equal(content.wizard.picked, null, "no picks of their own yet: the recommendation is followed");
  await saveVia(h, "Only a product");
  const page = await makePage(t, drafts);
  await page.run(`lbDraftApply(${JSON.stringify(content)}, { id: null, name: "x", headline: "Resumed." })`);
  assert.equal(page.state("labBuilder.picked"), null);
  assert.equal(page.state("labBuilder.step"), 1);
});

test("resuming moves focus to the step heading, announces it, and goes back and forth like any step", async (t) => {
  const drafts = await startDrafts();
  const h = await makePage(t, drafts);
  await richState(h, { step: 3 });
  await saveVia(h, "Focus check");
  const page = await makePage(t, drafts);
  const id = drafts.store.list("local").drafts[0].id;
  await page.click(page.rowButton(id, "resume"));
  await page.until(() => page.state("labBuilder.step") === 3);
  assert.equal(page.focusedId(), "lb-heading-3", "focus lands on the heading of the step the person left off");
  assert.match(page.text("lb-heading-3"), /^Step 3 of 4: /);
  assert.match(page.text("lb-draft-announce"), /^Resumed "Focus check"\. You are on Step 3 of 4: Topics\.$/);
  assert.equal(page.byId("lb-draft-announce").getAttribute("aria-live"), "polite");
  assert.ok(page.byId("lb-draft-announce").classList.contains("sr-only"), "the words are on screen once, in the notice");
  const notice = page.byId("lb-draft-notice");
  assert.equal(notice.hidden, false);
  assert.equal(notice.getAttribute("role"), "region");
  assert.match(notice.textContent, /Resumed "Focus check"/);
  assert.doesNotMatch(notice.textContent, /could not be restored/, "nothing was dropped, so no warning");
  await page.run("lbPrevStep()");
  assert.equal(page.state("labBuilder.step"), 2);
  await page.run("lbNextStep()");
  assert.equal(page.state("labBuilder.step"), 3);
  assert.equal(page.state("labBuilder.furthest"), 4, "how far the person had got is kept");
  await page.click(notice.querySelector("[data-draft-dismiss]"));
  assert.equal(notice.hidden, true);
  assert.equal(page.focusedId(), "lb-heading-3");
});

test("a draft saved on Review reopens Review with the removed modules listed", async (t) => {
  const drafts = await startDrafts();
  const h = await makePage(t, drafts);
  await richState(h, { step: 4 });
  await saveVia(h, "On review");
  const page = await makePage(t, drafts);
  await page.click(page.rowButton(drafts.store.list("local").drafts[0].id, "resume"));
  await page.until(() => page.state("labBuilder.step") === 4 && page.state("labBuilder.previewModules.length") > 0, "Review to open");
  assert.equal(page.focusedId(), "lb-heading-4");
  assert.match(page.text("lb-preview"), /Removed from curriculum \(1\)/);
  assert.match(page.text("lb-preview"), new RegExp(REMOVED_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.deepEqual(page.state("labBuilder.moduleOrder"), [PLAIN.id, CATALOG[0]], "the module order is kept");
});

// ── Drift ───────────────────────────────────────────────────────────────────

test("on resume, what no longer exists is dropped and said in plain words, and nothing else changes", async (t) => {
  const drafts = await startDrafts();
  const gone = "learn-vanished-topic";
  const goneRemoved = "learn-vanished-module";
  const content = {
    selections: {
      products: ["copilot-studio", "custom-fabrikam-gone"],
      industry: "industry-that-is-gone",
      roles: [ROLES[0], "role-that-is-gone"],
      level: 200,
      harness: "standard",
      differencesFor: null,
      features: [CATALOG[0], ALPHA.id],
      excluded: [goneRemoved],
      excludedSubtopics: [ALPHA.subtopics[1].id, "learn-sub-that-is-gone"],
      moduleOrder: [ALPHA.id, CATALOG[0]],
      targetMinutes: 120,
      customTitle: "Keep this title",
      agentName: null,
      sharepointSiteName: null,
      sharepointSiteUrl: null,
      useLearnMcp: true,
      useLlm: true,
      includeKnowledgeCheck: false,
      brandProfileId: null,
      brandOverrides: {},
    },
    wizard: {
      step: 4,
      furthest: 4,
      chosenSteps: ["product", "tailor", "topics"],
      picked: [CATALOG[0], ALPHA.id, gone, LEVEL_300.id],
      removed: [{ id: goneRemoved, wasPicked: true }],
    },
    labels: { [gone]: "Vanished topic", [goneRemoved]: "Gone module", "custom-fabrikam-gone": "Fabrikam Studio" },
  };
  const h = await makePage(t, drafts);
  const { lines } = await h.run(`lbDraftApply(${JSON.stringify(content)}, { id: null, name: "Old one", headline: 'Resumed "Old one".' })`);
  await h.settle();

  const said = lines.join("\n");
  assert.match(said, /1 product is no longer available \("Fabrikam Studio"\), so it was left out\./);
  assert.match(said, /The industry you chose is no longer offered, so the lab is for every industry now\./);
  assert.match(said, /1 department you chose is no longer offered and was left out\./);
  assert.match(said, /1 topic you chose is no longer listed in the catalog or on Microsoft Learn, so it was left out: "Vanished topic"\./);
  assert.match(said, new RegExp(`1 topic you chose now belongs to a different level than Level 200 \\(Intermediate\\) and is not included: "${LEVEL_300.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\. Change the level in Step 2 or choose other topics in Step 3\\.`));
  assert.match(said, /1 module you removed in Review is no longer listed \("Gone module"\), so the removal was dropped\./);
  assert.match(said, /1 sub-topic choice was dropped because Microsoft Learn no longer lists that sub-topic\./);
  assert.equal(lines.length, 7, "one sentence for each kind of change, and no more");
  assert.doesNotMatch(said, /undefined|\[object|draft-|learn-vanished|custom-fabrikam/, "no codes in what a person reads");

  // Everything that still exists is exactly as saved.
  assert.deepEqual(h.state("[...labBuilder.selectedProducts]"), ["copilot-studio"]);
  assert.deepEqual(h.state("[...labBuilder.selectedRoles]"), [ROLES[0]]);
  assert.equal(h.state("labBuilder.industry"), null);
  assert.equal(h.state("labBuilder.level"), 200);
  assert.deepEqual(h.state("[...labBuilder.picked]"), [CATALOG[0], ALPHA.id, LEVEL_300.id], "only the vanished topic was removed from the picks");
  assert.deepEqual(h.state("[...labBuilder.excludedSubtopics]"), [ALPHA.subtopics[1].id]);
  assert.equal(h.state("labBuilder.step7Removed.size"), 0);
  assert.equal(h.byId("lb-title").value, "Keep this title");
  assert.equal(h.byId("lb-time").value, 120);
  assert.deepEqual(h.state("[...labBuilder.rec.selectedIds].sort()"), [ALPHA.id, CATALOG[0]].sort(), "the level-300 topic is not built at Level 200");
  assert.equal(h.state("labBuilder.step"), 4);

  const notice = h.byId("lb-draft-notice");
  assert.match(notice.textContent, /Not everything could be restored:/);
  assert.equal(notice.querySelectorAll("li").length, 7);
  assert.match(h.text("lb-draft-announce"), /7 choices could not be restored\./, "the live region announces it too");
});

test("a draft whose products are all gone asks for a product instead of crashing or picking one", async (t) => {
  const drafts = await startDrafts();
  const h = await makePage(t, drafts);
  const content = { selections: { products: ["custom-fabrikam-gone"], level: 200, features: [] }, wizard: { step: 3, furthest: 3, chosenSteps: ["product", "topics"] }, labels: { "custom-fabrikam-gone": "Fabrikam Studio" } };
  const { lines } = await h.run(`lbDraftApply(${JSON.stringify({ selections: { industry: null, roles: [], harness: null, differencesFor: null, excluded: [], excludedSubtopics: [], moduleOrder: [], ...content.selections }, wizard: content.wizard, labels: content.labels })}, { name: "Gone", headline: 'Resumed "Gone".' })`);
  assert.deepEqual(h.state("[...labBuilder.selectedProducts]"), [], "nothing was chosen for them");
  assert.equal(h.state("labBuilder.step"), 1);
  assert.match(lines.join(" "), /None of the products in this draft are available anymore\. Choose a product to continue\./);
  assert.equal(h.focusedId(), "lb-heading-1");
});

test("a draft left on a late step with no topics left opens on Topics and says why", async (t) => {
  const drafts = await startDrafts();
  const h = await makePage(t, drafts);
  const content = {
    selections: { products: ["copilot-studio"], industry: null, roles: [], level: 200, harness: "standard", differencesFor: null, features: ["learn-vanished-topic"], excluded: [], excludedSubtopics: [], moduleOrder: [] },
    wizard: { step: 4, furthest: 4, chosenSteps: ["product", "tailor", "topics"], picked: ["learn-vanished-topic"], removed: [] },
    labels: { "learn-vanished-topic": "Vanished topic" },
  };
  const { lines } = await h.run(`lbDraftApply(${JSON.stringify(content)}, { name: "Late", headline: 'Resumed "Late".' })`);
  await h.settle();
  assert.equal(h.state("labBuilder.step"), 3);
  assert.match(lines.join("\n"), /This draft was on Step 4 of 4: Review and build, but none of its topics are left, so it opened on the Topics step\./);
  assert.equal(h.text("lb-topic-error"), "", "no red error greets a person who did nothing wrong");
  assert.equal(h.focusedId(), "lb-heading-3");
});

test("a draft that cannot be opened is listed with a plain message, keeps its file, and can only be deleted", async (t) => {
  const drafts = await startDrafts();
  const good = drafts.store.create("local", { name: "Fine one", content: { selections: { products: ["copilot-studio"] } } });
  const damagedId = "draft-aaaaaaaaaaaaaaaaaaaaaaaa";
  const futureId = "draft-bbbbbbbbbbbbbbbbbbbbbbbb";
  writeFileSync(join(drafts.folder, `${damagedId}.json`), "{ not json");
  const future = { ...JSON.parse(readFileSync(join(drafts.folder, `${good.id}.json`), "utf8")), id: futureId, schemaVersion: 99 };
  writeFileSync(join(drafts.folder, `${futureId}.json`), JSON.stringify(future));
  const before = readFileSync(join(drafts.folder, `${futureId}.json`), "utf8");

  const h = await makePage(t, drafts);
  assert.equal(h.rows().length, 3, "one bad file never hides the others");
  assert.equal(h.text("lb-drafts-badge"), "3");
  assert.match(h.rowText(good.id), /Fine one/);
  assert.match(h.rowText(damagedId), /This draft file could not be read\. The file has not been changed\. You can delete it\./);
  assert.match(h.rowText(futureId), /newer version of the portal, so it cannot be opened here/);
  for (const id of [damagedId, futureId]) {
    assert.ok(!h.rowButton(id, "resume"), "no Resume for a draft that cannot be opened");
    assert.ok(h.rowButton(id, "delete"));
  }
  await h.run(`lbDraftResume(${JSON.stringify(futureId)})`);
  assert.match(h.toasts.at(-1).message, /newer version of the portal/);
  assert.equal(h.state("labBuilder.selectedProducts.size"), 0, "the wizard was not touched");
  assert.equal(readFileSync(join(drafts.folder, `${futureId}.json`), "utf8"), before);

  await h.click(h.rowButton(damagedId, "delete"));
  assert.equal(h.byId("lb-draft-delete-dialog").open, true);
  await h.click(h.byId("lb-draft-delete-confirm"));
  await h.until(() => h.rows().length === 2, "the damaged draft to go");
  assert.equal(drafts.files().includes(`${damagedId}.json`), false);
});

// ── The panel and its actions ───────────────────────────────────────────────

test("Saved drafts starts collapsed, explains itself when empty, and keeps a live count", async (t) => {
  const drafts = await startDrafts();
  const h = await makePage(t, drafts);
  const details = h.byId("lb-drafts-details");
  assert.equal(details.hasAttribute("open"), false, "collapsed by default, like Previously generated labs");
  assert.ok(HTML.indexOf('id="lb-drafts-section"') < HTML.indexOf('id="lb-generated-details"'), "next to Previously generated labs, above it");
  assert.equal(h.text("lb-drafts-badge"), "0");
  assert.equal(h.byId("lb-drafts-badge").getAttribute("aria-hidden"), "true", "the count is also in the live region, so it is not read twice");
  assert.equal(h.byId("lb-drafts-count").getAttribute("aria-live"), "polite");
  assert.equal(h.text("lb-drafts-count"), "No saved drafts yet.");
  assert.match(h.text("lb-drafts-list"), /^When you choose Save and finish later in the wizard, the lab you have set up so far appears here, ready to resume\.$/);
  assert.match(DRAFTS_SECTION, /A draft is a lab you have only partly set up\./);
});

test("each draft shows its name, products, level, how far it got, and when it was saved, with Resume, Rename, Duplicate, and Delete", async (t) => {
  const drafts = await startDrafts();
  const make = (name, products, level, step, features) => drafts.store.create("local", { name, content: { selections: { products, level, features }, wizard: { step, furthest: step } } });
  const a = make("Contoso support pilot", ["copilot-studio"], 200, 3, ["a", "b", "c"]);
  const b = make("Fabrikam knowledge lab", ["sharepoint-ai"], 100, 3, []);
  const c = make("Early start", ["copilot-studio", "sharepoint-ai"], null, 2, []);
  const h = await makePage(t, drafts);
  assert.equal(h.text("lb-drafts-badge"), "3");
  assert.equal(h.text("lb-drafts-count"), "3 saved drafts. You can keep up to 50.");
  const rowA = h.rowText(a.id);
  assert.match(rowA, /Contoso support pilot/);
  assert.match(rowA, /Copilot Studio · Level 200 \(Intermediate\) · Step 3 of 4: Topics · 3 topics/);
  assert.match(rowA, /Saved today at /);
  assert.match(h.rowText(b.id), /SharePoint AI · Level 100 \(Beginner\) · Step 3 of 4: Topics · No topics yet/, "the step count is the same whether or not a product has harnesses");
  assert.match(h.rowText(c.id), /Step 2 of 4: Tailor it/);
  const lost = drafts.store.create("local", { name: "Mixed", content: { selections: { products: ["copilot-studio", "custom-fabrikam-gone"] } } });
  await h.run("lbDraftReload()");
  assert.match(h.rowText(lost.id), /Copilot Studio and 1 product that is no longer available · /, "a removed product is named in plain words, never by id");
  for (const action of ["resume", "rename", "duplicate", "delete"]) {
    const button = h.rowButton(a.id, action);
    assert.ok(button, action);
    assert.match(button.getAttribute("aria-label"), /Contoso support pilot/, "each button says which draft it acts on");
  }
  assert.match(HTML, /id="lb-drafts-heading" tabindex="-1"/);
  for (const row of h.rows()) assert.doesNotMatch(row.textContent, /draft-[0-9a-f]{8}/, "no id is shown");
});

test("Delete asks first and keeps focus sensible; Rename and Duplicate work from the list", async (t) => {
  const drafts = await startDrafts();
  const first = drafts.store.create("local", { name: "First draft", content: { selections: { products: ["copilot-studio"] } } });
  const second = drafts.store.create("local", { name: "Second draft", content: { selections: { products: ["copilot-studio"] } } });
  const h = await makePage(t, drafts);

  await h.click(h.rowButton(first.id, "delete"));
  const dialog = h.byId("lb-draft-delete-dialog");
  assert.equal(dialog.open, true);
  assert.equal(h.text("lb-draft-delete-title"), 'Delete "First draft"?');
  assert.match(h.text("lb-draft-delete-desc"), /cannot be undone\. Labs already built from it are not changed\./);
  assert.equal(h.focusedId(), "lb-draft-delete-cancel", "the safe choice has focus");
  await h.click(h.byId("lb-draft-delete-cancel"));
  assert.equal(drafts.store.list("local").drafts.length, 2, "Cancel deletes nothing");

  await h.click(h.rowButton(first.id, "rename"));
  assert.equal(h.text("lb-draft-name-heading"), "Rename draft");
  assert.equal(h.byId("lb-draft-name").value, "First draft");
  h.byId("lb-draft-name").value = "Renamed draft";
  h.byId("lb-draft-name-form").dispatchEvent(new h.FakeEvent("submit"));
  await h.until(() => drafts.store.get("local", first.id).name === "Renamed draft", "the rename");
  await h.until(() => h.rowText(first.id).includes("Renamed draft"));
  assert.match(h.text("lb-drafts-count"), /Renamed to "Renamed draft"\./);
  assert.equal(h.byId("lb-draft-name-dialog").open, false);

  await h.click(h.rowButton(second.id, "duplicate"));
  await h.until(() => h.rows().length === 3, "the copy");
  assert.ok(drafts.store.list("local").drafts.some((d) => d.name === "Copy of Second draft"));
  assert.match(h.text("lb-drafts-count"), /Duplicated as "Copy of Second draft"\./);

  await h.click(h.rowButton(second.id, "delete"));
  await h.click(h.byId("lb-draft-delete-confirm"));
  await h.until(() => h.rows().length === 2, "the delete");
  assert.match(h.text("lb-drafts-count"), /Deleted "Second draft"\. 2 saved drafts left\./);
  assert.equal(drafts.store.list("local").drafts.some((d) => d.id === second.id), false);
});

test("a built draft stays listed as Built, with a link to the lab while the lab exists", async (t) => {
  const drafts = await startDrafts();
  const d = drafts.store.create("local", { name: "Built from this", content: { selections: { products: ["copilot-studio"] } } });
  drafts.store.markBuilt("local", d.id, "contoso-lab-1");
  const h = await makePage(t, drafts, { loaded: false });
  h.run('var lbGen = { labs: [{ labId: "contoso-lab-1" }] };');
  await h.run("lbDraftsInit()");
  assert.match(h.rowText(d.id), /Built/);
  assert.match(h.rowText(d.id), /Built today at /);
  assert.ok(h.rowButton(d.id, "open-lab"), "the link to the lab is there while the lab exists");
  assert.ok(h.rowButton(d.id, "resume"), "it can still be resumed to build a variation");
  assert.ok(h.rowButton(d.id, "delete"), "and removed");
  h.run('lbGen.labs = [];');
  h.run("lbDraftRenderList()");
  assert.match(h.rowText(d.id), /Built/);
  assert.ok(!h.rowButton(d.id, "open-lab"), "no dead link once the lab was deleted");
});

test("Start over asks first: nothing is cleared and the autosave slot is untouched until the person confirms, and saved drafts are never deleted", async (t) => {
  const drafts = await startDrafts();
  const h = await makePage(t, drafts);
  await richState(h, { step: 3 });
  await saveVia(h, "Safe from Start over");
  const savedId = h.state("lbDraft.activeId");
  assert.ok(savedId);
  h.run(`lbSetFormValue("lb-title", "Edited after saving")`);
  await tick(h, 3);
  await h.until(() => drafts.store.getUnsaved("local") !== null, "the autosave");
  const calls = h.draftCalls.length;

  // The markup: the button asks, and the question is a labeled group that Esc closes.
  const button = h.byId("lb-start-over");
  const box = h.byId("lb-start-over-confirm");
  assert.equal(button.hidden, false);
  assert.equal(button.getAttribute("onclick"), "lbAskStartOver()");
  assert.equal(button.getAttribute("aria-expanded"), "false");
  assert.equal(button.getAttribute("aria-controls"), "lb-start-over-confirm");
  assert.equal(box.hidden, true);
  assert.equal(box.getAttribute("role"), "group");
  assert.equal(box.getAttribute("aria-labelledby"), "lb-start-over-confirm-text");
  assert.equal(h.text("lb-start-over-confirm-text"), "Start over? This clears your choices. Your saved drafts are kept.");
  assert.match(HTML, /id="lb-start-over"[^>]*title="Asks first, then clears your choices in the wizard\. Your saved drafts are never deleted\."/);
  assert.match(HTML, /id="lb-start-over-hint" class="sr-only">Asks first, then clears your choices in the wizard\. Your saved drafts are never deleted\.</);

  // The first click only asks. Nothing is cleared and the autosave slot is not deleted.
  h.inline("lb-start-over", "onclick");
  await h.settle();
  assert.equal(box.hidden, false);
  assert.equal(button.getAttribute("aria-expanded"), "true");
  assert.equal(h.focusedId(), "lb-start-over-keep", "focus moves to the safe choice");
  assert.equal(h.text("lb-draft-announce"), "Start over? This clears your choices. Your saved drafts are kept.", "a screen reader is told; the words are on screen once, in the confirm");
  assert.doesNotMatch(h.text("lb-draft-status"), /Start over\?/, "the visible status does not repeat the question");
  assert.equal(h.state("labBuilder.selectedProducts.size"), 2);
  assert.equal(h.state("labBuilder.step"), 3);
  assert.equal(h.state("lbDraft.activeId"), savedId);
  assert.notEqual(drafts.store.getUnsaved("local"), null, "the autosave slot is untouched");
  assert.equal(h.draftCalls.slice(calls).filter((call) => call.method === "DELETE").length, 0, "nothing was deleted on the server");
  assert.equal(drafts.store.list("local").drafts.length, 1);

  // Keep working closes the question, says so, and puts focus back on Start over.
  h.inline("lb-start-over-keep", "onclick");
  assert.equal(box.hidden, true);
  assert.equal(button.getAttribute("aria-expanded"), "false");
  assert.equal(h.text("lb-draft-status"), "Kept your choices.");
  assert.equal(h.focusedId(), "lb-start-over");
  assert.equal(h.state("labBuilder.selectedProducts.size"), 2);
  assert.notEqual(drafts.store.getUnsaved("local"), null);

  // Esc inside the question cancels it the same way; other keys do nothing.
  h.inline("lb-start-over", "onclick");
  assert.equal(box.hidden, false);
  h.inline("lb-start-over-confirm", "onkeydown", { key: "Enter" });
  assert.equal(box.hidden, false, "only Esc closes it");
  h.inline("lb-start-over-confirm", "onkeydown", { key: "Escape" });
  assert.equal(box.hidden, true);
  assert.equal(h.text("lb-draft-status"), "Kept your choices.");
  assert.equal(h.focusedId(), "lb-start-over");
  assert.equal(h.state("labBuilder.selectedProducts.size"), 2);
  assert.equal(h.draftCalls.slice(calls).filter((call) => call.method === "DELETE").length, 0);

  // Confirming does what Start over always did: the wizard resets, the autosave slot is cleared, and the saved draft stays.
  h.inline("lb-start-over", "onclick");
  assert.equal(h.byId("lb-start-over-yes").textContent, "Start over");
  await h.inline("lb-start-over-yes", "onclick");
  await h.until(() => drafts.store.getUnsaved("local") === null, "the autosave slot to be cleared");
  assert.equal(h.state("labBuilder.selectedProducts.size"), 0);
  assert.equal(h.state("labBuilder.step"), 1);
  assert.equal(h.state("lbDraft.activeId"), null, "the draft that was open is no longer what is on screen");
  assert.equal(box.hidden, true);
  assert.equal(button.getAttribute("aria-expanded"), "false");
  assert.equal(button.hidden, true, "with nothing left to clear, Start over goes away");
  assert.equal(h.text("lb-draft-status"), "Started over. Your saved drafts are kept.");
  assert.equal(drafts.store.list("local").drafts.length, 1, "the saved draft is untouched");
  assert.equal(drafts.store.get("local", savedId).content.selections.customTitle, "Contoso support lab", "and holds what was saved, not the edit after it");
  assert.equal(h.rows().length, 1);
});

// ── Save and finish later ───────────────────────────────────────────────────

test("Save and finish later is on every step, names the draft, confirms in words, and shows the time", async (t) => {
  const drafts = await startDrafts();
  const h = await makePage(t, drafts);
  assert.match(HTML, /id="lb-save-draft"[^>]*>Save and finish later<\/button>/);
  assert.ok(h.byId("lb-sticky-nav").contains(h.byId("lb-save-draft")), "it sits in the summary bar that every step shows");
  assert.equal(h.byId("lb-save-draft").closest("#lb-wizard-sticky") !== null, true);

  h.run("lbDraftOpenSave()");
  assert.equal(h.byId("lb-draft-name-dialog").open, false, "nothing to save before a product is chosen");
  assert.match(h.text("lb-draft-status"), /^Choose at least one product first, then you can save your progress\.$/);

  await richState(h, { step: 3 });
  h.run("lbDraftOpenSave()");
  const dialog = h.byId("lb-draft-name-dialog");
  assert.equal(dialog.open, true);
  assert.equal(h.text("lb-draft-name-heading"), "Save and finish later");
  assert.match(h.byId("lb-draft-name").value, /^Copilot Studio and SharePoint AI · [A-Z][a-z]{2} \d{1,2}$/, "named from the products and the date");
  assert.equal(h.focusedId(), "lb-draft-name");
  assert.equal(h.byId("lb-draft-name-copy").hidden, true, "no 'save as new' until a draft is open");

  h.byId("lb-draft-name").value = "";
  h.byId("lb-draft-name-form").dispatchEvent(new h.FakeEvent("submit"));
  await h.settle();
  assert.equal(h.text("lb-draft-name-error"), "Give the draft a name.");
  assert.equal(h.byId("lb-draft-name").getAttribute("aria-invalid"), "true");
  assert.equal(dialog.open, true);

  h.byId("lb-draft-name").value = "Contoso pilot";
  h.byId("lb-draft-name-form").dispatchEvent(new h.FakeEvent("submit"));
  await h.until(() => !dialog.open, "the dialog to close");
  await h.until(() => h.rows().length === 1, "the list to update");
  assert.match(h.text("lb-draft-status"), /^Saved\. You can pick this up later under Saved drafts\. "Contoso pilot" was saved today at /);
  assert.equal(h.toasts.at(-1).message, "Saved. You can pick this up later under Saved drafts.");
  assert.equal(h.byId("lb-draft-status").getAttribute("aria-live"), "polite");
  assert.equal(h.focusedId(), "lb-save-draft", "focus returns to the button that opened the dialog");
  assert.equal(h.state("lbDraft.activeName"), "Contoso pilot");
});

test("Save and finish later waits for a product, and Ctrl+S and lbDraftOpenSave still answer plainly without saving anything", async (t) => {
  const drafts = await startDrafts();
  const h = await makePage(t, drafts);
  assert.match(HTML, /id="lb-save-draft"[^>]*\shidden\s/, "the button starts hidden in the markup");
  assert.equal(h.byId("lb-save-draft").hidden, true);

  // The keyboard shortcut is still taken over (so the browser's Save page never opens) and says what is missing.
  const event = new h.FakeEvent("keydown", { key: "s", ctrlKey: true });
  h.byId("lb-title").dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.byId("lb-draft-name-dialog").open, false);
  assert.equal(h.text("lb-draft-status"), "Choose at least one product first, then you can save your progress.");
  assert.equal(h.toasts.at(-1).type, "info");
  h.run("lbDraftOpenSave()");
  assert.equal(h.byId("lb-draft-name-dialog").open, false);
  assert.equal(h.draftCalls.filter((call) => call.method === "POST" || call.method === "PUT").length, 0, "nothing was sent");
  assert.equal(drafts.store.list("local").drafts.length, 0);
  assert.equal(drafts.store.getUnsaved("local"), null);

  // The first product brings the button; taking it away again hides it.
  h.run(`lbToggleProduct("copilot-studio", true)`);
  await h.settle();
  assert.equal(h.byId("lb-save-draft").hidden, false);
  h.run("lbDraftOpenSave()");
  assert.equal(h.byId("lb-draft-name-dialog").open, true, "with a product the dialog opens");
  h.byId("lb-draft-name-cancel").click();
  h.run(`lbToggleProduct("copilot-studio", false)`);
  await h.settle();
  assert.equal(h.byId("lb-save-draft").hidden, true);
});

test("saving again updates the draft that was resumed; Save as a new draft keeps both", async (t) => {
  const drafts = await startDrafts();
  const h = await makePage(t, drafts);
  await richState(h, { step: 3 });
  await saveVia(h, "Original");
  const id = drafts.store.list("local").drafts[0].id;

  h.run(`lbSetFormValue("lb-title", "Changed after saving")`);
  h.run("lbDraftOpenSave()");
  assert.equal(h.byId("lb-draft-name").value, "Original", "the open draft's name is offered again");
  assert.equal(h.byId("lb-draft-name-copy").hidden, false);
  h.byId("lb-draft-name-form").dispatchEvent(new h.FakeEvent("submit"));
  await h.until(() => !h.byId("lb-draft-name-dialog").open);
  assert.equal(drafts.store.list("local").drafts.length, 1, "one draft, updated");
  assert.equal(drafts.store.get("local", id).content.selections.customTitle, "Changed after saving");
  assert.equal(h.draftCalls.filter((c) => c.method === "PUT" && c.url.endsWith(id)).length, 1);

  h.run(`lbSetFormValue("lb-title", "A variation")`);
  h.run("lbDraftOpenSave()");
  h.byId("lb-draft-name").value = "Variation";
  await h.click(h.byId("lb-draft-name-copy"));
  await h.until(() => drafts.store.list("local").drafts.length === 2, "the second draft");
  assert.equal(drafts.store.get("local", id).content.selections.customTitle, "Changed after saving", "the first draft is as it was");
  assert.equal(h.state("lbDraft.activeName"), "Variation");
});

test("Ctrl+S inside the wizard opens the save dialog instead of the browser's own Save", async (t) => {
  const drafts = await startDrafts();
  const h = await makePage(t, drafts);
  await richState(h, { step: 3 });
  const event = new h.FakeEvent("keydown", { key: "s", ctrlKey: true });
  h.byId("lb-draft-name").dispatchEvent(new h.FakeEvent("keydown", { key: "s", ctrlKey: true }));
  assert.equal(h.byId("lb-draft-name-dialog").open, false, "outside the wizard the keys are left alone");
  h.byId("lb-title").dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.byId("lb-draft-name-dialog").open, true);
  const plain = new h.FakeEvent("keydown", { key: "s" });
  h.byId("lb-title").dispatchEvent(plain);
  assert.equal(plain.defaultPrevented, false, "typing the letter s is never intercepted");
});

test("a full list says so plainly and keeps the dialog open", async (t) => {
  const drafts = await startDrafts();
  for (let i = 0; i < MAX_DRAFTS; i += 1) drafts.store.create("local", { name: `Fill ${i}`, content: { selections: { products: ["copilot-studio"] } } });
  const h = await makePage(t, drafts);
  await richState(h, { step: 3 });
  h.run("lbDraftOpenSave()");
  h.byId("lb-draft-name-form").dispatchEvent(new h.FakeEvent("submit"));
  await h.until(() => h.text("lb-draft-name-error") !== "", "the message");
  assert.equal(h.text("lb-draft-name-error"), "You already have 50 saved drafts. Delete one you no longer need, then save again.");
  assert.equal(h.byId("lb-draft-name-dialog").open, true, "nothing is lost: the person can cancel and delete one");
});

test("resuming over unsaved choices asks first; a saved or unchanged wizard does not", async (t) => {
  const drafts = await startDrafts();
  const target = drafts.store.create("local", { name: "Target", content: { selections: { products: ["sharepoint-ai"], level: 100, features: [] }, wizard: { step: 2, furthest: 2, chosenSteps: ["product"] } } });
  const h = await makePage(t, drafts);
  await richState(h, { step: 3 });
  await h.click(h.rowButton(target.id, "resume"));
  const dialog = h.byId("lb-draft-replace-dialog");
  assert.equal(dialog.open, true, "the current choices are not saved, so it asks");
  assert.equal(h.state("labBuilder.step"), 3, "and has not changed anything yet");
  await h.click(h.byId("lb-draft-replace-cancel"));
  assert.equal(dialog.open, false);
  assert.equal(h.state("labBuilder.selectedProducts.size"), 2);

  await saveVia(h, "Mine, saved");
  await h.click(h.rowButton(target.id, "resume"));
  assert.equal(dialog.open, false, "once saved there is nothing to lose");
  await h.until(() => h.state("labBuilder.level") === 100 && h.state("labBuilder.step") === 2, "the other draft to open");
});

test("default draft names are unique: the date, then the time, then a counter", async (t) => {
  const drafts = await startDrafts();
  const when = new Date(2026, 10, 20, 21, 14);
  const date = when.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const time = when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const label = "Copilot Studio and SharePoint AI";
  // Each save is a fresh page load in the same minute, with the default name accepted as offered.
  const saveWithDefault = async () => {
    const page = await makePage(t, drafts);
    page.freezeClock(when);
    await richState(page, { step: 3 });
    page.run("lbDraftOpenSave()");
    const offered = page.byId("lb-draft-name").value;
    page.byId("lb-draft-name-form").dispatchEvent(new page.FakeEvent("submit"));
    await page.until(() => !page.byId("lb-draft-name-dialog").open, "the save dialog to close");
    return offered;
  };
  assert.equal(await saveWithDefault(), `${label} · ${date}`, "the existing format comes first");
  assert.equal(await saveWithDefault(), `${label} · ${date}, ${time}`, "the same day again adds the time");
  assert.equal(await saveWithDefault(), `${label} · ${date}, ${time} (2)`, "the same minute again adds a counter");
  assert.equal(await saveWithDefault(), `${label} · ${date}, ${time} (3)`);
  const names = drafts.store.list("local").drafts.map((draft) => draft.name);
  assert.equal(names.length, 4);
  assert.equal(new Set(names.map((name) => name.toLowerCase())).size, 4, "every saved draft has its own name");

  // A name that fits in 80 characters is still unique when the products make it long.
  const page = await makePage(t, drafts);
  page.freezeClock(when);
  assert.equal(page.run("lbDraftUniqueName('Contoso pilot')"), "Contoso pilot");
  drafts.store.create("local", { name: "Contoso pilot", content: { selections: { products: ["copilot-studio"] } } });
  await page.run("lbDraftReload()");
  assert.equal(page.run("lbDraftUniqueName('contoso PILOT')"), "contoso PILOT (2)", "matching ignores case");
  assert.equal(page.run("lbDraftNameTaken('CONTOSO pilot')"), true);
  const id = drafts.store.list("local").drafts.find((draft) => draft.name === "Contoso pilot").id;
  assert.equal(page.run(`lbDraftNameTaken('Contoso pilot', ${JSON.stringify(id)})`), false, "a draft does not clash with itself");
  assert.equal(page.run("lbDraftNameTaken('')"), false);
});

test("a typed draft name that another draft has is accepted unchanged with a gentle note, and a draft never clashes with itself", async (t) => {
  const drafts = await startDrafts();
  drafts.store.create("local", { name: "Fabrikam demo", content: { selections: { products: ["copilot-studio"] } } });
  const h = await makePage(t, drafts);
  await richState(h, { step: 3 });
  const note = () => h.text("lb-draft-name-note");
  const type = (value) => {
    h.byId("lb-draft-name").value = value;
    h.byId("lb-draft-name").dispatchEvent(new h.FakeEvent("input"));
  };
  const NOTE = "Another draft already has this name. You can keep it, or add a few words to tell them apart.";

  h.run("lbDraftOpenSave()");
  assert.equal(note(), "", "the offered default is unique, so there is nothing to say");
  type("Fabrikam demo");
  assert.equal(note(), NOTE);
  assert.equal(h.byId("lb-draft-name-note").getAttribute("role"), "status");
  assert.equal(h.byId("lb-draft-name").getAttribute("aria-describedby").includes("lb-draft-name-note"), true);
  type("fabrikam DEMO");
  assert.equal(note(), NOTE, "case does not matter");
  type("Fabrikam demo, take two");
  assert.equal(note(), "", "a different name clears the note");
  type("Fabrikam demo");

  // The note never blocks saving, and the typed name is saved exactly as typed.
  h.byId("lb-draft-name-form").dispatchEvent(new h.FakeEvent("submit"));
  await h.until(() => !h.byId("lb-draft-name-dialog").open, "the save dialog to close");
  assert.equal(h.text("lb-draft-name-error"), "");
  const post = h.draftCalls.filter((call) => call.method === "POST").at(-1);
  assert.equal(post.body.name, "Fabrikam demo", "no counter and no time was added to what the person typed");
  assert.deepEqual(drafts.store.list("local").drafts.map((draft) => draft.name).sort(), ["Fabrikam demo", "Fabrikam demo"]);
  assert.equal(h.state("lbDraft.activeName"), "Fabrikam demo");

  // The offered name is still another draft's name (it was saved as a duplicate on purpose), so the note is honest about it.
  h.run("lbDraftOpenSave()");
  assert.equal(h.byId("lb-draft-name").value, "Fabrikam demo");
  assert.equal(note(), NOTE, "the note says so, and still never blocks saving");
  type("Fabrikam demo (mine)");
  assert.equal(note(), "");
  h.byId("lb-draft-name-form").dispatchEvent(new h.FakeEvent("submit"));
  await h.until(() => !h.byId("lb-draft-name-dialog").open, "the update to finish");
  const own = drafts.store.list("local").drafts.find((draft) => draft.id === h.state("lbDraft.activeId"));
  assert.equal(own.name, "Fabrikam demo (mine)", "updating keeps the draft that was open");
  assert.equal(drafts.store.list("local").drafts.length, 2);

  // Updating the draft that is open offers its own name without a note: a draft never clashes with itself.
  h.run("lbDraftOpenSave()");
  assert.equal(h.byId("lb-draft-name").value, "Fabrikam demo (mine)");
  assert.equal(note(), "");
  h.byId("lb-draft-name-cancel").click();

  // Rename: its own name is fine; the name of a different draft gets the note; the typed name is kept as typed.
  await h.until(() => h.rowButton(own.id, "rename"), "the list to show the draft");
  await h.click(h.rowButton(own.id, "rename"));
  assert.equal(h.byId("lb-draft-name").value, "Fabrikam demo (mine)");
  assert.equal(note(), "", "renaming a draft to its own name is not a clash");
  type("Contoso pilot");
  assert.equal(note(), "", "a name no draft has");
  type("fabrikam demo");
  assert.equal(note(), NOTE, "a name another draft has, ignoring case");
  h.byId("lb-draft-name-form").dispatchEvent(new h.FakeEvent("submit"));
  await h.until(() => !h.byId("lb-draft-name-dialog").open, "the rename dialog to close");
  const put = h.draftCalls.filter((call) => call.method === "PUT").at(-1);
  assert.equal(put.body.name, "fabrikam demo", "the typed name is never rewritten");
  assert.equal(drafts.store.get("local", own.id).name, "fabrikam demo");
});

test("saving as a new draft with the offered name adds a counter, but a different typed name is kept as typed", async (t) => {
  const drafts = await startDrafts();
  const h = await makePage(t, drafts);
  await richState(h, { step: 3 });
  await saveVia(h, "Original");
  h.run(`lbSetFormValue("lb-title", "A variation")`);
  h.run("lbDraftOpenSave()");
  assert.equal(h.byId("lb-draft-name").value, "Original");
  await h.click(h.byId("lb-draft-name-copy"));
  await h.until(() => drafts.store.list("local").drafts.length === 2, "the second draft");
  assert.deepEqual(drafts.store.list("local").drafts.map((draft) => draft.name).sort(), ["Original", "Original (2)"], "two identical rows would be confusing");

  h.run(`lbSetFormValue("lb-title", "Another variation")`);
  h.run("lbDraftOpenSave()");
  assert.equal(h.byId("lb-draft-name").value, "Original (2)", "the open draft's name is offered");
  h.byId("lb-draft-name").value = "Original";
  h.byId("lb-draft-name").dispatchEvent(new h.FakeEvent("input"));
  assert.match(h.text("lb-draft-name-note"), /^Another draft already has this name\./);
  await h.click(h.byId("lb-draft-name-copy"));
  await h.until(() => drafts.store.list("local").drafts.length === 3, "the third draft");
  assert.equal(drafts.store.list("local").drafts.filter((draft) => draft.name === "Original").length, 2, "the person's typed name is kept, even as a duplicate");
});

// ── Autosave ────────────────────────────────────────────────────────────────

const tick = async (h, times = 1) => {
  for (let i = 0; i < times; i += 1) {
    h.run("lbDraftAutosaveTick()");
    await h.settle();
  }
};

test("autosave never saves an empty wizard, waits until the page is quiet, and does not repeat itself", async (t) => {
  const drafts = await startDrafts();
  const h = await makePage(t, drafts);
  await tick(h, 3);
  assert.equal(h.draftCalls.filter((c) => c.method === "PUT").length, 0, "nothing to save while the wizard is empty");

  h.run(`labBuilder.selectedProducts = new Set(["copilot-studio"]); labBuilder.chosenSteps = new Set(["product"]);`);
  await h.refresh();
  await tick(h);
  assert.equal(h.draftCalls.filter((c) => c.method === "PUT").length, 0, "the first tick only notices the change");
  h.run(`labBuilder.industry = ${JSON.stringify(INDUSTRY)};`);
  await tick(h);
  assert.equal(h.draftCalls.filter((c) => c.method === "PUT").length, 0, "still changing: wait");
  await tick(h);
  await h.until(() => drafts.store.getUnsaved("local") !== null, "the autosave");
  const puts = h.draftCalls.filter((c) => c.method === "PUT");
  assert.equal(puts.length, 1);
  assert.equal(puts[0].url, "/api/lab-builder/drafts/unsaved");
  assert.equal(drafts.store.getUnsaved("local").content.selections.industry, INDUSTRY);
  await tick(h, 3);
  assert.equal(h.draftCalls.filter((c) => c.method === "PUT").length, 1, "no change, no write");
  assert.equal(drafts.store.list("local").drafts.length, 0, "it is not a draft");
});

test("autosave never overwrites a named draft, and saving on purpose clears the unsaved copy", async (t) => {
  const drafts = await startDrafts();
  const h = await makePage(t, drafts);
  await richState(h, { step: 3 });
  await saveVia(h, "On purpose");
  const id = drafts.store.list("local").drafts[0].id;
  const savedFile = readFileSync(join(drafts.folder, `${id}.json`), "utf8");

  h.run(`lbSetFormValue("lb-title", "Edited but not saved")`);
  await tick(h, 3);
  await h.until(() => drafts.store.getUnsaved("local") !== null, "the autosave");
  assert.equal(drafts.store.getUnsaved("local").basedOn, id, "it remembers which draft it was working from");
  assert.equal(drafts.store.getUnsaved("local").content.selections.customTitle, "Edited but not saved");
  assert.equal(readFileSync(join(drafts.folder, `${id}.json`), "utf8"), savedFile, "the named draft is byte for byte the same");

  await saveVia(h, "On purpose");
  await h.until(() => drafts.store.getUnsaved("local") === null, "the unsaved copy to go");
  assert.equal(drafts.store.get("local", id).content.selections.customTitle, "Edited but not saved");
});

test("a person who changes only the step is not shown unsaved work for a draft that is already saved", async (t) => {
  const drafts = await startDrafts();
  const h = await makePage(t, drafts);
  await richState(h, { step: 3 });
  await saveVia(h, "Saved at Topics");
  h.run("lbGoToStep(4)");
  await h.settle();
  await tick(h, 3);
  assert.equal(h.draftCalls.filter((c) => c.url.endsWith("/unsaved") && c.method === "PUT").length, 0, "moving between steps changes where you are, not what you chose");
});

test("after a reload one calm banner offers the unsaved work; Resume restores it, and nothing overwrites it while the wizard is empty", async (t) => {
  const drafts = await startDrafts();
  const first = await makePage(t, drafts);
  await richState(first, { step: 3 });
  await tick(first, 3);
  await first.until(() => drafts.store.getUnsaved("local") !== null, "the autosave");
  const before = first.state("lbDraftContent()");

  const page = await makePage(t, drafts);
  const banner = page.byId("lb-unsaved-banner");
  assert.equal(banner.hidden, false);
  assert.match(page.text("lb-unsaved-banner-text"), /^You have unsaved work from today at .+\. Resume or discard\.$/);
  assert.equal(banner.getAttribute("role"), "region");
  assert.equal(page.byId("lb-unsaved-resume").getAttribute("aria-label"), "Resume your unsaved work");
  assert.equal(page.byId("lb-unsaved-discard").getAttribute("aria-label"), "Discard your unsaved work");

  const before2 = drafts.store.getUnsaved("local").updatedAt;
  await tick(page, 3);
  assert.equal(drafts.store.getUnsaved("local").updatedAt, before2, "while the banner waits on an empty wizard, nothing is written over the saved copy");
  assert.equal(banner.hidden, false, "and the banner stays");
  assert.equal(drafts.store.list("local").drafts.length, 0, "nothing was turned into a draft either");
  await page.click(page.byId("lb-unsaved-resume"));
  await page.until(() => banner.hidden && page.state("labBuilder.step") === 3, "the work to come back");
  const after = page.state("lbDraftContent()");
  assert.deepEqual(after.selections, before.selections);
  assert.deepEqual(after.wizard, before.wizard);
  assert.match(page.text("lb-draft-announce"), /^Resumed your unsaved work from today at .+\. You are on Step 3 of 4: Topics\.$/);
  assert.equal(page.focusedId(), "lb-heading-3");
  assert.equal(page.state("lbDraftDirty()"), true, "it is still not a saved draft, so replacing it would ask");
});

test("Discard removes the unsaved copy; no banner appears when there is none or the wizard already has work", async (t) => {
  const drafts = await startDrafts();
  const first = await makePage(t, drafts);
  assert.equal(first.byId("lb-unsaved-banner").hidden, true, "no unsaved work, no banner");
  await richState(first, { step: 2 });
  await tick(first, 3);
  await first.until(() => drafts.store.getUnsaved("local") !== null);

  const page = await makePage(t, drafts);
  assert.equal(page.byId("lb-unsaved-banner").hidden, false);
  await page.click(page.byId("lb-unsaved-discard"));
  await page.until(() => drafts.store.getUnsaved("local") === null, "the discard");
  assert.equal(page.byId("lb-unsaved-banner").hidden, true);
  assert.match(page.text("lb-draft-status"), /^Discarded your unsaved work\.$/);

  const busy = await makePage(t, drafts, { loaded: false });
  await richState(busy, { step: 2 });
  await tick(busy, 0);
  drafts.store.saveUnsaved("local", { content: first.state("lbDraftContent()") });
  await busy.run("lbDraftsInit()");
  assert.equal(busy.byId("lb-unsaved-banner").hidden, true, "work already in the wizard is never covered by an offer");
});

test("work started while the unsaved-work banner is open keeps the offered work as a draft, closes the banner, and autosave carries on", async (t) => {
  const drafts = await startDrafts();
  const first = await makePage(t, drafts);
  await richState(first, { step: 3 });
  await tick(first, 3);
  await first.until(() => drafts.store.getUnsaved("local") !== null, "the autosave");
  const offered = first.state("lbDraftContent()");

  // A reload with an empty wizard offers it, and an idle wizard keeps the offer.
  const page = await makePage(t, drafts);
  assert.equal(page.byId("lb-unsaved-banner").hidden, false);
  assert.equal(page.state("lbDraft.bannerOpen"), true);
  await tick(page, 2);
  assert.equal(page.byId("lb-unsaved-banner").hidden, false);
  assert.equal(drafts.store.list("local").drafts.length, 0);

  // The person ignores the banner and starts something new. Before the fix the banner stayed for the whole session and the new work was never saved.
  page.run(`labBuilder.selectedProducts = new Set(["sharepoint-ai"]); labBuilder.chosenSteps = new Set(["product"]);`);
  await page.refresh();
  await tick(page);
  await page.until(() => drafts.store.list("local").drafts.length === 1 && page.byId("lb-unsaved-banner").hidden, "the offered work to be kept");
  const kept = drafts.store.list("local").drafts[0];
  assert.match(kept.name, /^Recovered work, today at .+$/);
  assert.deepEqual(drafts.store.get("local", kept.id).content.selections, { ...offered.selections, ai: { enabled: false, model: null, scope: ["lab", "training", "labday"] } }, "the older work is saved as it was, with AI writing off");
  assert.equal(drafts.store.getUnsaved("local"), null, "the autosave slot was cleared");
  assert.equal(page.state("lbDraft.bannerOpen"), false);
  assert.equal(page.state("lbDraft.rescueFailed"), false);
  assert.equal(page.text("lb-draft-status"), `Your earlier unsaved work was kept as "${kept.name}" under Saved drafts.`);
  await page.until(() => page.rows().length === 1, "the list to show it");
  assert.match(page.rowText(kept.id), /Recovered work/);
  assert.equal(page.state("labBuilder.selectedProducts.size"), 1, "the work in progress is untouched");

  // Autosave resumes on the next ticks and saves the new work, and the banner does not come back.
  await tick(page, 3);
  await page.until(() => drafts.store.getUnsaved("local") !== null, "the autosave of the new work");
  assert.deepEqual(drafts.store.getUnsaved("local").content.selections.products, ["sharepoint-ai"]);
  page.run("lbGoToStep(2)");
  await page.settle();
  assert.equal(page.byId("lb-unsaved-banner").hidden, true, "no stale banner on a later step");
  assert.equal(drafts.store.list("local").drafts.length, 1, "the new work is not turned into a draft behind the person's back");
});

test("if the offered work cannot be kept as a draft, the banner stays, autosave stays paused, and nothing retries in a loop", async (t) => {
  const drafts = await startDrafts();
  const first = await makePage(t, drafts);
  await richState(first, { step: 3 });
  drafts.store.saveUnsaved("local", { content: first.state("lbDraftContent()") });
  for (let i = 0; i < MAX_DRAFTS; i += 1) drafts.store.create("local", { name: `Fill ${i}`, content: { selections: { products: ["copilot-studio"] } } });

  const page = await makePage(t, drafts);
  assert.equal(page.byId("lb-unsaved-banner").hidden, false);
  page.run(`labBuilder.selectedProducts = new Set(["sharepoint-ai"]); labBuilder.chosenSteps = new Set(["product"]);`);
  await page.refresh();
  await tick(page, 6);
  await page.until(() => page.state("lbDraft.rescueFailed") === true, "the attempt to fail");
  await tick(page, 4);

  assert.equal(page.byId("lb-unsaved-banner").hidden, false, "the offer stays");
  assert.equal(page.state("lbDraft.bannerOpen"), true);
  assert.equal(page.text("lb-draft-status"), "Your earlier unsaved work could not be kept as a draft yet. Choose Resume or Discard to continue autosaving.");
  assert.notEqual(drafts.store.getUnsaved("local"), null, "the offered work is still in the slot");
  const posts = page.draftCalls.filter((call) => call.method === "POST" && call.url === "/api/lab-builder/drafts");
  assert.equal(posts.length, 1, "one attempt, then no retry loop");
  assert.equal(page.draftCalls.filter((call) => call.method === "GET" && call.url.endsWith("/unsaved")).length, 1);
  assert.equal(page.draftCalls.filter((call) => call.method === "PUT" && call.url.endsWith("/unsaved")).length, 0, "autosave stays paused rather than overwrite the offer");
  assert.equal(drafts.store.list("local").drafts.length, MAX_DRAFTS, "no draft was added");

  // Choosing Discard ends the pause: the slot goes, the banner closes, and autosave saves the new work.
  await page.click(page.byId("lb-unsaved-discard"));
  await page.until(() => page.byId("lb-unsaved-banner").hidden && drafts.store.getUnsaved("local") === null, "the discard");
  await tick(page, 3);
  await page.until(() => drafts.store.getUnsaved("local") !== null, "autosave to carry on");
  assert.deepEqual(drafts.store.getUnsaved("local").content.selections.products, ["sharepoint-ai"]);
});

test("building a lab clears the unsaved copy and marks the draft that was resumed as Built, keeping it", async (t) => {
  const drafts = await startDrafts();
  const h = await makePage(t, drafts);
  await richState(h, { step: 3 });
  await saveVia(h, "Source draft");
  const id = drafts.store.list("local").drafts[0].id;
  h.run(`lbSetFormValue("lb-title", "Tweaked")`);
  await tick(h, 3);
  await h.until(() => drafts.store.getUnsaved("local") !== null);

  await h.run(`lbDraftsAfterBuild({ labId: "contoso-lab-7", title: "Built lab" })`);
  await h.until(() => drafts.store.getUnsaved("local") === null, "the unsaved copy to go");
  const draft = drafts.store.get("local", id);
  assert.equal(draft.builtLabId, "contoso-lab-7");
  assert.ok(draft.builtAt);
  assert.equal(drafts.store.list("local").drafts.length, 1, "the draft is kept");
  assert.match(h.rowText(id), /Built/);
  assert.match(h.text("lb-draft-status"), /Your lab is built\. "Source draft" is marked Built and stays under Saved drafts until you delete it\./);
  await tick(h, 3);
  assert.equal(drafts.store.getUnsaved("local"), null, "the built state is not autosaved again");
});

test("when the wizard script builds a lab it tells the drafts script", () => {
  const app = readFileSync(join(portalRoot, "public", "app.js"), "utf8");
  assert.match(app, /if \(typeof lbDraftsAfterBuild === "function"\) void lbDraftsAfterBuild\(data\);/);
  assert.match(WIZARD, /if \(typeof lbDraftsInit === "function"\) lbDraftsInit\(\);/);
  assert.match(WIZARD, /if \(typeof lbDraftsOnReset === "function"\) lbDraftsOnReset\(\);/);
  assert.match(HTML, /<script src="lab-builder-drafts\.js" defer><\/script>/);
  assert.ok(HTML.indexOf('src="lab-builder-drafts.js"') > HTML.indexOf('src="lab-builder-wizard.js"'), "after the wizard script");
});

test("the drafts script writes nothing to the clipboard or local storage and keeps the print rules where they were", () => {
  assert.doesNotMatch(DRAFTS, /clipboard|localStorage|sessionStorage|navigator\.sendBeacon/);
  const printBlocks = [...HTML.matchAll(/@media print/g)].length;
  assert.ok(printBlocks >= 1);
  const screenCss = HTML.slice(0, HTML.indexOf("@media print"));
  assert.match(screenCss, /\.lb-status \{/, "the draft styles are screen CSS, before the first print block");
  assert.match(screenCss, /\.lb-draft-notice\[hidden\] \{/);
});

// ── Both harnesses, one after another ───────────────────────────────────────

/** The "Both, one after another" radio, and the radios for each harness, from the rendered Tailor it step. */
const bothRadio = (h) => h.byId("lb-harness-options").querySelector('input[value="both"]');
const harnessRadio = (h, id) => h.byId("lb-harness-options").querySelector(`input[value="${id}"]`);
async function choose(h, input) {
  input.value = input.getAttribute("value");
  input.checked = true;
  input.dispatchEvent(new h.FakeEvent("change"));
  await h.settle();
}
const tailorWithCopilotStudio = (h) => h.run(`labBuilder.selectedProducts = new Set(["copilot-studio"]); labBuilder.chosenSteps = new Set(["product"]); labBuilder.level = 100; lbRenderHarnesses();`);

test("Tailor it offers 'Both, one after another' next to the single harnesses, with a plain hint, and a single harness is unchanged", async (t) => {
  const drafts = await startDrafts();
  const h = await makePage(t, drafts);
  tailorWithCopilotStudio(h);

  const radios = h.byId("lb-harness-options").querySelectorAll("input[type=radio]");
  assert.deepEqual([...radios].map((r) => r.getAttribute("value")), ["standard", "microsoft-copilot", "customer-conversation", "both"], "the choice sits after the single harnesses, in the same radio group");
  assert.ok([...radios].every((r) => r.getAttribute("name") === "lb-harness"), "one radio group, so the arrow keys move between all four");
  assert.equal(bothRadio(h).checked, false);
  const label = bothRadio(h).parentNode.textContent;
  assert.match(label, /Both, one after another/);
  assert.match(label, /Covers the Standard \(Classic\) harness first, then the Microsoft Copilot harness\. Shared topics appear once\./);
  assert.match(label, /\d+ Level 100 \(Beginner\) topics/);
  assert.equal(h.byId("lb-harness-order").hidden, true, "the order line waits for the choice");

  // A single harness: exactly the request it always sent.
  assert.equal(h.state("lbRequest().harness"), "standard");
  assert.deepEqual(h.state("lbRequest().differencesFor"), ["microsoft-copilot"]);
  assert.equal(h.state('"harnessMode" in lbRequest() || "harnesses" in lbRequest()'), false);
  assert.equal(h.state("lbAnswers().harness"), "standard");
  assert.equal(h.state('"harnessMode" in lbAnswers()'), false);
  assert.equal(harnessRadio(h, "standard").checked, true);
});

test("choosing Both sets the request, the topic list, the review summary, the order line, and hides the comparison notes; Swap order reverses it", async (t) => {
  const drafts = await startDrafts();
  const h = await makePage(t, drafts);
  tailorWithCopilotStudio(h);
  await choose(h, bothRadio(h));
  await h.until(() => h.recommendCalls.some((c) => c.harnessMode === "both"), "the topic list to ask for both harnesses");

  assert.equal(h.state("lbIsBoth()"), true);
  // The fake DOM has no radio groups, so a render (which the page does on the next change) shows what is selected.
  h.run("lbRenderHarnesses()");
  assert.equal(bothRadio(h).checked, true);
  assert.equal(harnessRadio(h, "standard").checked, false, "a single harness is no longer selected");
  const request = h.state("lbRequest()");
  assert.equal(request.harnessMode, "both");
  assert.deepEqual(request.harnesses, ["standard", "microsoft-copilot"], "Standard (Classic) first by default");
  assert.ok(!("harness" in request) && !("differencesFor" in request), "no single harness, and no comparison notes");
  const asked = h.recommendCalls.at(-1);
  assert.deepEqual([asked.harnessMode, asked.harnesses, asked.harness], ["both", ["standard", "microsoft-copilot"], undefined]);

  assert.equal(h.byId("lb-harness-order").hidden, false);
  assert.equal(h.text("lb-harness-order-text"), "Order: Standard (Classic) first, then Microsoft Copilot.");
  assert.match(h.text("lb-harness-hint"), /Both harnesses are selected, Standard \(Classic\) first, then Microsoft Copilot\. A topic that is the same in both is covered once\./);
  assert.match(h.text("lb-summary"), /Both: Standard \(Classic\), then Microsoft Copilot/);
  assert.equal(h.byId("lb-differences-options").querySelectorAll("input").length, 0, "the comparison notes are not offered: both harnesses are taught");

  // The topic list shows both harnesses' topics, each tagged.
  const ids = h.state("labBuilder.rec.concepts.flatMap((c) => c.topics.map((t) => t.id))");
  assert.ok(ids.includes("create-agent") && ids.includes("mc-create-agent") && ids.includes("mc-harness-choice"));
  assert.equal(h.state("lbTopicHarnessTag({ harnesses: ['standard'] })"), "Standard (Classic)");
  assert.equal(h.state("lbTopicHarnessTag({ harnesses: ['microsoft-copilot'] })"), "Microsoft Copilot");
  assert.equal(h.state("lbTopicHarnessTag({ harnesses: ['standard', 'microsoft-copilot'] })"), "Either harness");

  // Swap order.
  await h.click(h.byId("lb-harness-swap"));
  assert.equal(h.text("lb-harness-order-text"), "Order: Microsoft Copilot first, then Standard (Classic).");
  assert.deepEqual(h.state("lbRequest().harnesses"), ["microsoft-copilot", "standard"]);
  assert.match(h.byId("lb-harness-swap").getAttribute("aria-label"), /Swap the order: teach Standard \(Classic\) first, then Microsoft Copilot/);
  await h.until(() => h.recommendCalls.at(-1)?.harnesses?.[0] === "microsoft-copilot", "the topic list to follow the order");

  // Back to one harness: the old request returns and the order line goes away.
  await choose(h, harnessRadio(h, "microsoft-copilot"));
  assert.equal(h.state("lbRequest().harness"), "microsoft-copilot");
  assert.equal(h.state('"harnessMode" in lbRequest()'), false);
  assert.equal(h.byId("lb-harness-order").hidden, true);
  assert.deepEqual(h.state("lbAnswers().harness"), "microsoft-copilot");
});

test("the review outline groups a combined lab into parts, and the preview request carries both harnesses", async (t) => {
  const drafts = await startDrafts();
  const h = await makePage(t, drafts);
  tailorWithCopilotStudio(h);
  await choose(h, bothRadio(h));
  h.run(`labBuilder.picked = new Set(["create-agent", "mc-create-agent", "mc-harness-choice"]); labBuilder.chosenSteps = new Set(["product", "tailor", "topics"]); labBuilder.level = 100;`);
  await h.refresh();
  await h.run("lbPreview()");
  await h.until(() => h.previewCalls.length > 0, "the preview");
  assert.equal(h.previewCalls.at(-1).harnessMode, "both");
  await h.until(() => /lb-outline-part-row/.test(h.byId("lb-preview").innerHTML), "the outline");
  const html = h.byId("lb-preview").innerHTML;
  assert.match(html, /Part 1: Shared foundations \(works in either harness\)/);
  assert.match(html, /Part 2: Standard \(Classic\) harness/);
  assert.match(html, /Part 3: Microsoft Copilot harness/);
});

test("a draft keeps 'Both, one after another' and its order through Save and finish later and Resume", async (t) => {
  const drafts = await startDrafts();
  const h = await makePage(t, drafts);
  tailorWithCopilotStudio(h);
  await choose(h, bothRadio(h));
  await h.click(h.byId("lb-harness-swap"));
  const before = h.state("lbDraftContent()");
  assert.equal(before.selections.harnessMode, "both");
  assert.deepEqual(before.selections.harnesses, ["microsoft-copilot", "standard"]);

  await saveVia(h, "Both harnesses pilot");
  const saved = drafts.store.list("local").drafts;
  assert.equal(saved.length, 1);
  assert.equal(saved[0].harnessMode, "both", "the Saved drafts list knows");
  assert.deepEqual(saved[0].harnesses, ["microsoft-copilot", "standard"]);
  const onDisk = JSON.parse(readFileSync(join(drafts.folder, `${saved[0].id}.json`), "utf8"));
  assert.equal(onDisk.schemaVersion, 4);
  assert.equal(onDisk.content.selections.harnessMode, "both");

  const page = await makePage(t, drafts);
  await page.click(page.rowButton(saved[0].id, "resume"));
  await page.until(() => page.state("labBuilder.harnessMode") === "both", "the draft to open");
  assert.equal(page.state("lbIsBoth()"), true);
  assert.deepEqual(page.state("labBuilder.harnessOrder"), ["microsoft-copilot", "standard"], "the order comes back as it was saved");
  assert.deepEqual(page.state("lbDraftContent().selections"), before.selections, "every choice comes back exactly");
  assert.equal(page.state("lbRequest().harnessMode"), "both");
  assert.equal(page.byId("lb-harness-order").hidden, false);
  assert.equal(page.text("lb-harness-order-text"), "Order: Microsoft Copilot first, then Standard (Classic).");
  assert.equal(bothRadio(page).checked, true);

  // Start over goes back to Standard, one harness, the default order.
  page.run("lbResetAnswers()");
  assert.equal(page.state("labBuilder.harnessMode"), "single");
  assert.deepEqual(page.state("labBuilder.harnessOrder"), ["standard", "microsoft-copilot"]);
});

test("a draft saved before the option opens as a single-harness draft, and a lab built with Both re-opens as Both", async (t) => {
  const drafts = await startDrafts();
  const h = await makePage(t, drafts);
  tailorWithCopilotStudio(h);
  await saveVia(h, "Older draft");
  const [{ id }] = drafts.store.list("local").drafts;
  // Rewrite the file the way version 2 saved it: no harness mode and no pair.
  const file = join(drafts.folder, `${id}.json`);
  const record = JSON.parse(readFileSync(file, "utf8"));
  delete record.content.selections.harnessMode;
  delete record.content.selections.harnesses;
  writeFileSync(file, JSON.stringify({ ...record, schemaVersion: 2 }));
  const page = await makePage(t, drafts);
  await page.click(page.rowButton(id, "resume"));
  await page.until(() => page.state("labBuilder.step") >= 1 && page.state("labBuilder.selectedProducts.size") === 1, "the draft to open");
  assert.equal(page.state("labBuilder.harnessMode"), "single");
  assert.equal(page.state("lbIsBoth()"), false);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).schemaVersion, 2, "reading never rewrites the file");

  // "Edit selections" of a built lab: the saved selections name both harnesses.
  const apply = page.run(`lbApplySavedSelections({ industry: null, roles: [], level: 100, products: ["copilot-studio"], harness: null, harnessMode: "both", harnesses: ["microsoft-copilot", "standard"], features: ["create-agent", "mc-create-agent"], excluded: [], excludedSubtopics: [], moduleOrder: [], differencesFor: null })`);
  assert.ok(apply, "nothing was left out");
  assert.equal(page.state("lbIsBoth()"), true);
  assert.deepEqual(page.state("labBuilder.harnessOrder"), ["microsoft-copilot", "standard"]);
});

test("the harness choice is keyboard and screen reader friendly, and its styles live in their own block, before print, with a narrow-screen rule", () => {
  assert.match(STAGE, /<div class="lb-tailor-row" id="lb-harness-row" role="radiogroup" aria-labelledby="lb-harness-label"/);
  assert.match(STAGE, /<p id="lb-harness-order-text" class="lb-tailor-hint" role="status" aria-live="polite"><\/p>/, "the order is announced when it changes");
  assert.match(STAGE, /<button class="btn lb-harness-swap" type="button" id="lb-harness-swap">Swap order<\/button>/, "a real button, so it works with the keyboard");
  assert.match(WIZARD, /swap\.setAttribute\("aria-label", `Swap the order: teach/, "the button says what it does");
  const screenCss = HTML.slice(0, HTML.indexOf("@media print"));
  assert.match(screenCss, /\/\* ── Both harnesses, one after another: the order line and its Swap button ── \*\//);
  assert.match(screenCss, /\.lb-harness-order \{[^}]*border: 1px solid var\(--border\);[^}]*background: var\(--bg\);/, "theme variables, so light and dark both work");
  assert.match(screenCss, /@media \(max-width: 560px\) \{\s*\.lb-harness-swap \{ width: 100%; min-height: 44px; \}/, "a full-width, touch-sized button on a narrow screen");
  assert.doesNotMatch(screenCss.slice(screenCss.indexOf("Both harnesses, one after another")).slice(0, 900), /border-(left|right|top|bottom)\s*:\s*[2-9]px|border-(left|right)-width\s*:\s*[2-9]/, "no thick side stripe");
  assert.doesNotMatch(WIZARD.slice(WIZARD.indexOf("// ── \"Both, one after another\"")).slice(0, 4000), /[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/u, "plain text, no emoji");
});
