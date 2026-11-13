import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

import { getFeatures, getFeature, expandPrereqs } from "../lib/lab-builder/catalog.js";
import { recommend } from "../lib/lab-builder/recommend.js";
import { planLab } from "../lib/lab-builder/planner.js";
import { generateLab } from "../lib/lab-builder/generator.js";
import { selectionsFromManifest } from "../lib/lab-builder/generated-labs.js";
import { classifyByRubric, resolveTopicLevel, PREREQ_RECAP_MINUTES } from "../lib/lab-builder/levels.js";
import { resetTopicSource, setTopicSource } from "../lib/lab-builder/topic-store.js";

const LEVELS = [100, 200, 300];
const HARNESSES = ["standard", "microsoft-copilot", "customer-conversation"];

const listed = (rec) => rec.concepts.flatMap((c) => c.topics);

function learnTopic(over = {}) {
  return {
    id: "learn-example-topic",
    title: "Example topic",
    summary: "An example topic found on Microsoft Learn.",
    urls: ["https://learn.microsoft.com/microsoft-copilot-studio/example-topic"],
    harnesses: ["standard"],
    conceptId: "knowledge",
    status: "new",
    level: 200,
    firstSeen: "2026-11-01",
    lastSeen: "2026-11-10",
    changedAt: null,
    availability: null,
    ...over,
  };
}

// ── Server: recommendations ─────────────────────────────────────────────────

test("at each level only that level's topics are listed and selected, on every harness", () => {
  for (const harness of HARNESSES) {
    for (const level of LEVELS) {
      const rec = recommend({ harness, level });
      const topics = listed(rec);
      assert.ok(topics.every((t) => t.level === level), `${harness} level ${level} lists another level`);
      assert.equal(rec.filter.level, level);
      assert.equal(rec.filter.shown, topics.length);
      const byId = new Map(topics.map((t) => [t.id, t]));
      for (const id of rec.selectedIds) assert.equal(byId.get(id)?.level, level, `${id} is selected but not at level ${level}`);
      assert.equal(rec.totals.selectedCount, rec.selectedIds.length);
    }
  }
});

test("prerequisites from lower levels are separate, brief, and counted in the totals", () => {
  const level100 = recommend({ harness: "standard", level: 100 });
  assert.equal(level100.prerequisites.topics.length, 0, "Level 100 has no lower level to recap");

  for (const level of [200, 300]) {
    const rec = recommend({ harness: "standard", level });
    const pre = rec.prerequisites;
    assert.ok(pre.topics.length > 0, `Level ${level} depends on lower levels`);
    for (const p of pre.topics) {
      assert.ok(p.level < level, `${p.id} is a lower-level topic`);
      assert.ok(p.neededBy.length > 0 && /Needed by/.test(p.reason), `${p.id} says what needs it`);
      assert.ok(p.minutes <= PREREQ_RECAP_MINUTES && p.minutes <= p.fullMinutes);
      assert.ok(!listed(rec).some((t) => t.id === p.id), `${p.id} is not mixed into the main list`);
      assert.ok(!rec.selectedIds.includes(p.id), `${p.id} is not a pick of its own`);
    }
    const levelMinutes = listed(rec).filter((t) => t.selected).reduce((sum, t) => sum + t.minutes, 0);
    assert.equal(rec.totals.minutes, levelMinutes + pre.minutes);
    assert.equal(rec.totals.prerequisiteCount, pre.selectedCount);
  }
});

test("turning a prerequisite off keeps it listed, unselected, and only warns", () => {
  const base = recommend({ harness: "standard", level: 200 });
  const victim = base.prerequisites.topics[0].id;
  const off = recommend({ harness: "standard", level: 200, excluded: [victim] });
  const row = off.prerequisites.topics.find((p) => p.id === victim);
  assert.equal(row.selected, false, "it stays in the group so it can be turned back on");
  assert.ok(off.dependencyWarnings.some((w) => w.id === victim));
  assert.equal(off.totals.prerequisiteCount, base.totals.prerequisiteCount - 1);
});

test("a selection that names other levels is filtered, not trusted, so older saved choices still work", () => {
  const legacy = ["create-agent", "agent-instructions", "generative-orchestration", "connector-tools", "custom-connectors"];
  const rec = recommend({ harness: "standard", level: 200, selected: legacy });
  assert.deepEqual(rec.selectedIds.sort(), ["connector-tools", "generative-orchestration"]);
  assert.ok(rec.prerequisites.selectedIds.includes("create-agent"), "a needed lower-level topic comes back as a prerequisite");
  assert.deepEqual(rec.filter.droppedSelections.map((d) => d.id), ["custom-connectors"], "an unneeded other-level topic is reported");
});

test("an industry or department boost never lists a topic from another level", () => {
  const rec = recommend({ industry: "healthcare", departments: ["it"], harness: "standard", level: 100 });
  assert.ok(listed(rec).every((t) => t.level === 100));
  assert.ok(!listed(rec).some((t) => t.id === "epic-fhir-integration"));
});

// ── Server: topics discovered on Microsoft Learn ────────────────────────────

test("Learn topics are listed only at their own level, and an unresolvable level is shown apart and never recommended", () => {
  const topics = [
    learnTopic({ id: "learn-at-200", title: "At two hundred", level: 200 }),
    learnTopic({ id: "learn-at-100", title: "At one hundred", level: 100 }),
    learnTopic({
      id: "learn-estimated",
      title: "Use tools with your agent",
      urls: ["https://learn.microsoft.com/microsoft-copilot-studio/agent-tools"],
      level: undefined,
    }),
    learnTopic({
      id: "learn-unknown",
      title: "Something unclassifiable",
      urls: ["https://learn.microsoft.com/microsoft-copilot-studio/zzz"],
      level: undefined,
    }),
  ];
  const at = (level, extra = {}) => recommend({ harness: "standard", level, ...extra }, { topics });

  const level200 = at(200);
  assert.ok(listed(level200).some((t) => t.id === "learn-at-200"));
  assert.ok(!listed(level200).some((t) => t.id === "learn-at-100"));
  const estimated = listed(level200).find((t) => t.id === "learn-estimated");
  assert.equal(estimated.level, 200);
  assert.equal(estimated.levelBasis, "estimated");
  assert.equal(listed(level200).find((t) => t.id === "learn-at-200").selected, false, "Learn topics are never pre-selected");

  assert.ok(listed(at(100)).some((t) => t.id === "learn-at-100"));
  assert.ok(!listed(at(100)).some((t) => t.id === "learn-at-200"));

  for (const level of LEVELS) {
    const rec = at(level);
    assert.deepEqual(rec.levelUnknown.topics.map((t) => t.id), ["learn-unknown"], `level ${level} offers it only in the unknown group`);
    assert.ok(!listed(rec).some((t) => t.id === "learn-unknown"));
    assert.equal(rec.levelUnknown.topics[0].selected, false);
    assert.ok(!rec.selectedIds.includes("learn-unknown"));
  }

  const picked = at(200, { selected: ["learn-unknown"] });
  assert.deepEqual(picked.selectedIds, ["learn-unknown"], "the learner can still pick it on purpose");
  assert.equal(picked.levelUnknown.selectedCount, 1);
});

test("the docs rubric classifies a Learn page by its address and title", () => {
  assert.equal(classifyByRubric({ url: "https://learn.microsoft.com/x/get-started-overview", title: "Overview" }), 100);
  assert.equal(classifyByRubric({ url: "https://learn.microsoft.com/x/mcp-servers", title: "Add MCP servers" }), 200);
  assert.equal(classifyByRubric({ url: "https://learn.microsoft.com/x/custom-connector", title: "Custom connectors" }), 300);
  assert.equal(classifyByRubric({ url: "https://learn.microsoft.com/x/zzz", title: "Zzz" }), null);
  assert.deepEqual(resolveTopicLevel({ level: 300 }), { level: 300, basis: "declared" });
  assert.deepEqual(resolveTopicLevel({ level: 5, urls: ["https://learn.microsoft.com/x/zzz"], title: "Zzz" }), { level: null, basis: "unknown" });
});

// ── Server: planner and generator ───────────────────────────────────────────

test("the planner builds one level, with lower-level prerequisites as labeled recaps", () => {
  for (const level of LEVELS) {
    const rec = recommend({ harness: "standard", level });
    const plan = planLab({ level, harness: "standard", features: rec.selectedIds, includeCore: false });
    const own = plan.features.filter((f) => !f.prerequisite);
    const recaps = plan.features.filter((f) => f.prerequisite);
    assert.ok(own.every((f) => f.level === level), `level ${level} plan has a module from another level`);
    assert.ok(recaps.every((f) => f.level < level && f.minutes <= PREREQ_RECAP_MINUTES));
    assert.equal(plan.level, level);
    assert.deepEqual(plan.prerequisites, recaps.map((f) => f.id));
    assert.equal(plan.totalMinutes, rec.totals.minutes, "the Review totals match the recommendation");
    const firstOwn = plan.features.findIndex((f) => !f.prerequisite);
    assert.ok(plan.features.slice(0, firstOwn).every((f) => f.prerequisite), "recaps come first");
  }
});

test("the planner drops other-level topics the client did not filter, and refuses a lab with none at the level", () => {
  const plan = planLab({ level: 200, harness: "standard", features: ["connector-tools", "custom-connectors", "topics"], includeCore: false });
  assert.deepEqual(plan.request.droppedOutOfLevel.map((d) => d.id).sort(), ["custom-connectors", "topics"]);
  assert.ok(plan.warnings.some((w) => /another level/.test(w)));
  assert.ok(plan.features.filter((f) => !f.prerequisite).every((f) => f.level === 200));
  assert.throws(() => planLab({ level: 100, harness: "standard", features: ["connector-tools"] }), /None of the selected topics are at Level 100/);
});

test("at a higher level the core foundations arrive only as the prerequisites a topic needs", () => {
  const plan = planLab({ level: 200, harness: "standard", features: ["connector-tools"] });
  const wanted = expandPrereqs(["connector-tools"]).filter((id) => id !== "connector-tools");
  assert.deepEqual(plan.features.map((f) => f.id).sort(), [...wanted, "connector-tools"].sort());
  assert.ok(plan.features.filter((f) => f.prerequisite).every((f) => f.level < 200));
});

test("a request with no level is built as given, for older callers", () => {
  const plan = planLab({ harness: "standard", features: ["connector-tools"], includeCore: false });
  assert.ok(plan.features.every((f) => !f.prerequisite));
  assert.ok(plan.features.some((f) => f.level === 100), "its lower-level prerequisites are ordinary modules");
  assert.equal(plan.level, 200);
  assert.equal(plan.request.level, null);
});

test("a dropped prerequisite recap never removes the module that builds on it", async (t) => {
  const { dropModules } = await import("../lib/lab-builder/planner.js");
  const plan = planLab({ level: 200, harness: "standard", features: ["connector-tools"], includeCore: false });
  const recap = plan.features.find((f) => f.prerequisite);
  dropModules(plan, [recap.id], "ungrounded");
  assert.ok(plan.features.some((f) => f.id === "connector-tools"));
  assert.ok(plan.assumedPrereqs.some((a) => a.id === recap.id));
  assert.ok(!plan.prerequisites.includes(recap.id));
});

test("a generated lab holds only the chosen level plus labeled recaps, and says its level", async () => {
  for (const level of LEVELS) {
    const rec = recommend({ harness: "standard", level });
    const result = await generateLab(
      { level, harness: "standard", features: rec.selectedIds, includeCore: false },
      { useLearnMcp: false, useLlm: false, write: false },
    );
    assert.equal(result.status, "complete");
    const { manifest, markdown } = result;
    assert.equal(manifest.level, level);
    assert.equal(manifest.request.level, level);
    const own = manifest.modules.filter((m) => m.role === "level");
    const recaps = manifest.modules.filter((m) => m.role === "prerequisite");
    assert.ok(own.length > 0 && own.every((m) => m.level === level));
    assert.ok(recaps.every((m) => m.level < level));
    assert.deepEqual(manifest.prerequisites, recaps.map((m) => m.id));
    assert.match(markdown, new RegExp(`\\| 🎚️ \\*\\*LEVEL\\*\\* \\| Level ${level} \\(`));

    const recapHeadings = [...markdown.matchAll(/^### Step \d+ - Recap: /gm)];
    assert.equal(recapHeadings.length, recaps.length);
    const stepHeadings = [...markdown.matchAll(/^### Step \d+ - /gm)];
    assert.equal(stepHeadings.length, manifest.modules.length);
    assert.equal(manifest.totalMinutes, rec.totals.minutes);
    if (recaps.length) assert.match(markdown, /prerequisite recap/i);
    assert.doesNotMatch(markdown, /GitHub Copilot harness/);
  }
});

test("a saved lab round-trips its level, including one recorded only in the manifest", () => {
  const manifest = { request: { features: ["connector-tools"], level: 200, roles: [], excluded: [] }, harness: "standard", options: {} };
  assert.equal(selectionsFromManifest(manifest).level, 200);
  assert.equal(selectionsFromManifest({ ...manifest, request: { ...manifest.request, level: null }, level: 300 }).level, 300);
  assert.equal(selectionsFromManifest({ ...manifest, request: { ...manifest.request, level: undefined } }).level, null, "older labs have no level");
});

// ── Client logic, run for real against the server's recommendations ─────────

function loadWizard() {
  const wizardSource = readFileSync(new URL("../public/lab-builder-wizard.js", import.meta.url), "utf8");
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) {
      elements.set(id, { id, innerHTML: "", textContent: "", hidden: false, style: {}, contains: () => false, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, setAttribute() {}, removeAttribute() {}, classList: { toggle() {}, add() {}, remove() {} } });
    }
    return elements.get(id);
  };
  const context = {
    document: { getElementById: element, querySelector: () => null, querySelectorAll: () => [], activeElement: { dataset: {} } },
    CSS: { escape: (s) => s },
    escapeHtml: (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]),
    toast: () => {},
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      return { ok: true, json: async () => recommend({ ...body, selected: body.selected }) };
    },
    setTimeout,
    console,
  };
  vm.createContext(context);
  vm.runInContext(wizardSource, context);
  const run = (code) => vm.runInContext(code, context);
  return { run, element, context };
}

const levelsFixture = [
  { level: 100, label: "Beginner" },
  { level: 200, label: "Intermediate" },
  { level: 300, label: "Advanced" },
];

test("changing the level drops the learner's own picks, announces what was removed, and restores on request", async () => {
  const { run, element } = loadWizard();
  run(`labBuilder.levels = ${JSON.stringify(levelsFixture)}; labBuilder.level = 200;`);
  run("lbRefresh()");
  await new Promise((r) => setImmediate(r));
  await run("Promise.resolve(labBuilder.rec)");
  assert.equal(run("labBuilder.rec.answers.level"), 200);

  run("labBuilder.picked = new Set(['mcp-servers', 'connector-tools']); labBuilder.excluded = new Set(['agent-instructions'])");
  run("labBuilder.rec = " + JSON.stringify(recommend({ harness: "standard", level: 200, selected: ["mcp-servers", "connector-tools"] })));
  run("labBuilder.level = 100; lbLevelChanged(200)");
  await new Promise((r) => setImmediate(r));

  const notice = run("labBuilder.levelNotice");
  assert.equal(notice.from, 200);
  assert.equal(notice.to, 100);
  assert.ok(notice.removed.some((t) => t.id === "mcp-servers"));
  assert.equal(run("labBuilder.picked"), null, "picks start over from the new level's recommendation");
  assert.equal(run("labBuilder.excluded.size"), 0);
  assert.match(element("lb-level-notice-4").innerHTML, /changed from Level 200 \(Intermediate\) to Level 100 \(Beginner\)/);
  assert.match(element("lb-level-notice-4").innerHTML, /Restore my Level 200 \(Intermediate\) choices/);
  assert.equal(run("labBuilder.rec.answers.level"), 100, "recommendations are recomputed for the new level");

  run("lbRestoreLevelChoices()");
  assert.equal(run("labBuilder.level"), 200);
  assert.deepEqual(JSON.parse(run("JSON.stringify([...labBuilder.picked].sort())")), ["connector-tools", "mcp-servers"]);
  assert.deepEqual(JSON.parse(run("JSON.stringify([...labBuilder.excluded])")), ["agent-instructions"]);
  assert.equal(run("labBuilder.levelNotice"), null);
  await new Promise((r) => setTimeout(r, 20));
});

test("changing the level without any own picks shows no removal notice but still recomputes", async () => {
  const { run } = loadWizard();
  run(`labBuilder.levels = ${JSON.stringify(levelsFixture)}; labBuilder.level = 300; lbLevelChanged(100)`);
  await new Promise((r) => setImmediate(r));
  assert.equal(run("labBuilder.levelNotice"), null);
  assert.equal(run("labBuilder.rec.answers.level"), 300);
});

test("the topics step lists the level's topics, announces the count, and collapses the prerequisites group", async () => {
  const { run, element } = loadWizard();
  const rec = recommend({ harness: "standard", level: 200 });
  run(`labBuilder.levels = ${JSON.stringify(levelsFixture)}; labBuilder.harnesses = [{ id: "standard", name: "Standard harness" }]; labBuilder.level = 200; labBuilder.rec = ${JSON.stringify(rec)};`);
  run("lbRenderTopics()");

  const html = element("lb-topic-groups").innerHTML;
  const [main, afterMain] = html.split('<details class="lb-concept lb-prereq-group"');
  assert.ok(afterMain, "the prerequisites group is rendered");
  assert.doesNotMatch(main, /Level 100|Level 300/, "no other level in the main list");
  assert.match(main, /Level 200/);
  assert.match(afterMain, /^ id="lb-prereq-group" >/, "the group starts collapsed");
  assert.match(afterMain, /Prerequisites from lower levels \(included automatically\)/);
  assert.match(afterMain, /data-prerequisite="agent-instructions"/);
  assert.match(afterMain, /Prerequisite recap/);
  assert.equal(element("lb-topic-count").textContent, `Showing ${rec.filter.shown} topics for Level 200 (Intermediate).`);
  assert.match(element("lb-topic-intro").textContent, /Level 200 \(Intermediate\) topics/);
});

test("a Learn topic of unknown level renders in its own collapsed group with a text label", () => {
  const { run, element } = loadWizard();
  const rec = recommend({ harness: "standard", level: 100 }, { topics: [learnTopic({ id: "learn-unknown", level: undefined, urls: ["https://learn.microsoft.com/x/zzz"], title: "Zzz" })] });
  run(`labBuilder.levels = ${JSON.stringify(levelsFixture)}; labBuilder.harnesses = [{ id: "standard", name: "Standard harness" }]; labBuilder.level = 100; labBuilder.rec = ${JSON.stringify(rec)};`);
  run("lbRenderTopics()");
  const html = element("lb-topic-groups").innerHTML;
  const unknown = html.split('id="lb-unknown-group"')[1];
  assert.ok(unknown, "the unknown-level group is rendered");
  assert.match(unknown, /^ >/, "collapsed by default");
  assert.match(unknown, /Level unknown/);
  assert.match(unknown, /not recommended for Level 100 \(Beginner\)/);
  assert.doesNotMatch(html.split('id="lb-unknown-group"')[0], /learn-unknown/);
});

test("older saved labs without a level take the highest level among their topics", () => {
  const { run } = loadWizard();
  run(`labBuilder.categories = ${JSON.stringify([{ features: getFeatures().map((f) => ({ id: f.id, level: f.level })) }])};`);
  assert.equal(run("lbSavedLevel({ level: 300, features: [] })"), 300);
  assert.equal(run("lbSavedLevel({ level: null, features: ['create-agent', 'connector-tools'] })"), 200);
  assert.equal(run("lbSavedLevel({ level: null, features: ['create-agent'] })"), 100);
});

test("the harness step counts only the chosen level's Learn topics", () => {
  const { run } = loadWizard();
  const counts = run(`lbLearnNewByHarness(${JSON.stringify([
    { source: "learn", level: 100, harnesses: ["standard"] },
    { source: "learn", level: 200, harnesses: ["standard", "microsoft-copilot"] },
    { source: "learn", level: null, harnesses: ["standard"] },
    { source: "catalog", level: 100, harnesses: ["standard"] },
  ])})`);
  assert.deepEqual(JSON.parse(JSON.stringify(counts)), { standard: { 100: 1, 200: 1 }, "microsoft-copilot": { 200: 1 } });
});

test("the topics step has no level selector of its own, and its counts and notices are announced", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const topicsPane = html.match(/id="lb-pane-6"[\s\S]*?<!-- Step 7: review -->/)?.[0] || "";
  assert.ok(topicsPane);
  assert.doesNotMatch(topicsPane, /name="lb-level"|id="lb-topic-level"|lb-level-filter/i);
  assert.match(topicsPane, /id="lb-topic-count"[^>]*aria-live="polite"/);
  assert.match(topicsPane, /id="lb-level-notice-6"[^>]*aria-live="polite"/);
  assert.match(html, /id="lb-level-notice-4"[^>]*aria-live="polite"/);
  const wizard = readFileSync(new URL("../public/lab-builder-wizard.js", import.meta.url), "utf8");
  assert.doesNotMatch(wizard, /GitHub Copilot harness/);
});

test("Learn topics keep a level only when the snapshot or the rubric gives one", async (t) => {
  t.after(resetTopicSource);
  setTopicSource({ source: "cache", snapshot: { topics: [learnTopic({ id: "learn-unresolved", level: undefined, urls: ["https://learn.microsoft.com/x/zzz"], title: "Zzz" })] } });
  const feature = getFeature("learn-unresolved");
  assert.equal(feature.level, null);
  assert.equal(feature.levelBasis, "unknown");
  assert.ok(getFeatures().every((f) => f.level));
});
