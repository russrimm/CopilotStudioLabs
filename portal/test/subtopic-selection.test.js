/**
 * Sub-topics are real selection options, end to end.
 *
 * Covers the data (consolidation keeps every companion page, snapshot validation,
 * the API and recommendation rows), the planner and generator (an included
 * sub-topic becomes its own section with its own grounding; an excluded one
 * contributes nothing), and the manifest round trip that "Edit and rebuild" uses.
 * Hermetic: Microsoft Learn is a scripted fake session.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { consolidateTopics } from "../lib/lab-builder/topic-consolidate.js";
import { topicId } from "../lib/lab-builder/topic-sanitize.js";
import { MAX_SUBTOPICS, listHash, validateSnapshot } from "../lib/lab-builder/topic-snapshot.js";
import { resetTopicSource, setTopicSource } from "../lib/lab-builder/topic-store.js";
import { topicsPayload } from "../lib/lab-builder/topic-api.js";
import { topicMinutes } from "../lib/lab-builder/subtopics.js";
import { recommend } from "../lib/lab-builder/recommend.js";
import { planLab } from "../lib/lab-builder/planner.js";
import { generateLab } from "../lib/lab-builder/generator.js";
import { selectionsFromManifest } from "../lib/lab-builder/generated-labs.js";
import { getFeature, expandPrereqs } from "../lib/lab-builder/catalog.js";
import { getProducts } from "../lib/lab-builder/products.js";
import { parseTopicMarkdownStructure } from "../lib/lab-builder/pptx-builder.js";

process.env.LAB_BUILDER_LINK_CHECK = "off";
process.env.LAB_BUILDER_VENDOR_DOCS = "off";

const BASE = "https://learn.microsoft.com/microsoft-copilot-studio";
const urlOf = (slug) => `${BASE}/${slug}`;

function rawTopic(slug, title, extra = {}) {
  const url = urlOf(slug);
  return {
    id: topicId(url),
    title,
    summary: `${title} explains how to work with it in Copilot Studio.`,
    urls: [url],
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
    ...extra,
  };
}

/** A discovered topic that already carries sub-topics, the way a snapshot stores one. */
function mergedTopic(slug, title, subs) {
  const subtopics = subs.map((sub) => ({
    id: topicId(urlOf(sub.slug)),
    title: sub.title,
    url: urlOf(sub.slug),
    ...(sub.summary ? { summary: sub.summary } : {}),
  }));
  return rawTopic(slug, title, { urls: [urlOf(slug), ...subtopics.map((s) => s.url)], subtopics });
}

function snapshotOf(topics) {
  const snapshot = { schemaVersion: 1, generatedAt: "2026-11-13T12:00:00Z", source: "test", catalogVersion: "test", topics, catalog: [], pageHashes: {} };
  snapshot.listHash = listHash(snapshot);
  return snapshot;
}

function useSnapshot(t, topics) {
  const snapshot = snapshotOf(topics);
  setTopicSource({ source: "cache", snapshot });
  t.after(() => resetTopicSource());
  return snapshot;
}

const COMPANION_TITLES = [
  "Event trigger overview",
  "Event trigger introduction",
  "Event trigger examples",
  "Event trigger intro",
  "What is an event trigger",
  "About event triggers",
  "Event trigger key concepts",
  "Event trigger example",
];

// ── Consolidation and the snapshot keep every sub-topic ─────────────────────

test("consolidation keeps every companion page as a sub-topic, however many there are", () => {
  const raw = [
    rawTopic("event-trigger", "Event trigger"),
    ...COMPANION_TITLES.map((title, index) => rawTopic(`event-trigger-page-${index + 1}`, title)),
  ];
  const out = consolidateTopics(raw);
  const merged = out.find((topic) => topic.id === raw[0].id);
  assert.equal(out.length, 1, "nine pages about one subject are one topic");
  assert.equal(merged.subtopics.length, 8, "all eight companions are kept (the old cap kept four)");
  assert.equal(merged.urls.length, 9);
  assert.deepEqual(
    merged.subtopics.map((sub) => sub.id).sort(),
    raw.slice(1).map((topic) => topic.id).sort(),
  );
  assert.deepEqual(validateSnapshot(snapshotOf(out)), []);
  assert.deepEqual(consolidateTopics(out), out, "consolidating again changes nothing");
});

test("a sub-topic keeps its own level and availability when the page had them", () => {
  const out = consolidateTopics([
    rawTopic("event-trigger", "Event trigger"),
    rawTopic("event-trigger-overview", "Event trigger overview", { level: 100, availability: "preview" }),
  ]);
  const [sub] = out[0].subtopics;
  assert.equal(sub.level, 100);
  assert.equal(sub.availability, "preview");
  assert.deepEqual(validateSnapshot(snapshotOf(out)), []);
});

test("a group larger than the bound is split into more topics, so no page is ever dropped", () => {
  const raw = [
    rawTopic("event-trigger", "Event trigger"),
    ...Array.from({ length: MAX_SUBTOPICS + 9 }, (_, index) => rawTopic(`event-trigger-overview-${index + 1}`, "Event trigger overview")),
  ];
  const out = consolidateTopics(raw);
  const merged = out.find((topic) => topic.id === raw[0].id);
  assert.equal(merged.subtopics.length, MAX_SUBTOPICS);
  const everyId = new Set([...out.map((topic) => topic.id), ...out.flatMap((topic) => (topic.subtopics || []).map((sub) => sub.id))]);
  assert.deepEqual([...everyId].sort(), raw.map((topic) => topic.id).sort(), "every page is a topic or a sub-topic");
  assert.equal(out.length, 1 + 9, "the nine extra pages come back as topics of their own");
  assert.deepEqual(validateSnapshot(snapshotOf(out)), []);
  assert.deepEqual(consolidateTopics(out).map((topic) => topic.id).sort(), out.map((topic) => topic.id).sort());
});

test("when the catalog covers a merged topic's own page, its other sub-topics stay available as topics", () => {
  const merged = mergedTopic("event-trigger", "Event trigger", [
    { slug: "event-trigger-overview", title: "Event trigger overview" },
    { slug: "event-trigger-examples", title: "Event trigger examples" },
  ]);
  const catalogConcepts = [];
  const coveredOwnPage = consolidateTopics([merged], { catalogFeatures: [{ id: "cat-event", docUrls: [urlOf("event-trigger")] }], catalogConcepts });
  assert.equal(coveredOwnPage.find((topic) => topic.id === merged.id).status, "covered");
  const stillAvailable = coveredOwnPage.filter((topic) => topic.status === "new").flatMap((topic) => [topic.id, ...(topic.subtopics || []).map((sub) => sub.id)]);
  assert.deepEqual(stillAvailable.sort(), merged.subtopics.map((sub) => sub.id).sort(), "the companion pages are not lost with the covered page");
  const coveredCompanion = consolidateTopics([merged], { catalogFeatures: [{ id: "cat-event", docUrls: [urlOf("event-trigger-examples")] }], catalogConcepts });
  const stillNew = coveredCompanion.find((topic) => topic.id === merged.id);
  assert.equal(stillNew.status, "new", "a covered companion does not hide the topic's own page");
  assert.equal(stillNew.subtopics.length, 2);
});

test("the snapshot validator accepts many sub-topics and rejects a malformed sub-topic level", () => {
  const many = mergedTopic(
    "big-topic",
    "Big topic",
    Array.from({ length: 12 }, (_, index) => ({ slug: `big-topic-part-${index + 1}`, title: `Big topic part ${index + 1}` })),
  );
  assert.deepEqual(validateSnapshot(snapshotOf([many])), []);
  const bad = structuredClone(many);
  bad.subtopics[0].level = 250;
  assert.match(validateSnapshot(snapshotOf([bad])).join("\n"), /level must be 100, 200, or 300/);
});

// ── The API and the recommendation carry complete sub-topic objects ─────────

const ALPHA = mergedTopic("alpha-trigger", "Alpha trigger", [
  { slug: "alpha-trigger-overview", title: "Alpha trigger overview", summary: "What an alpha trigger is for." },
  { slug: "alpha-trigger-examples", title: "Alpha trigger examples", summary: "Three worked alpha trigger examples." },
]);

function fakeService(snapshot) {
  return {
    config: { updatedWindowDays: 30, ttlMs: 86400000 },
    view: () => ({ snapshot, source: "cache", refreshedAt: snapshot.generatedAt, ageMs: 0, stale: false, refreshing: false, offline: false, disabled: false, circuitOpen: false, retryAfterSec: 0, lastError: null }),
  };
}

test("GET topics passes whole sub-topic objects, not just id, title, and url", (t) => {
  const snapshot = useSnapshot(t, [ALPHA]);
  const payload = topicsPayload(fakeService(snapshot));
  const alpha = payload.topics.find((topic) => topic.id === ALPHA.id);
  assert.equal(alpha.subtopics.length, 2);
  const [first] = alpha.subtopics;
  assert.deepEqual(Object.keys(first).sort(), ["availability", "id", "included", "level", "levelBasis", "minutes", "summary", "title", "url"]);
  assert.equal(first.summary, "What an alpha trigger is for.");
  assert.equal(first.included, true);
  assert.ok([100, 200, 300].includes(first.level), "a level is worked out from the page when the snapshot has none");
});

test("recommend lists every sub-topic as included by default and counts them", (t) => {
  const snapshot = useSnapshot(t, [ALPHA]);
  const rec = recommend({ level: 200, harness: "standard", selected: [ALPHA.id] }, { topics: snapshot.topics });
  const row = rec.concepts.flatMap((c) => c.topics).find((topic) => topic.id === ALPHA.id);
  assert.equal(row.learn.subtopics.length, 2);
  assert.ok(row.learn.subtopics.every((sub) => sub.included && sub.summary));
  assert.equal(row.minutes, 20, "all sub-topics included keeps the estimate a topic has always had");
  assert.equal(rec.totals.subtopicCount, 2);
  assert.equal(rec.totals.subtopicTotal, 2);
  assert.deepEqual(rec.selectedSubtopicIds.sort(), ALPHA.subtopics.map((s) => s.id).sort());
  assert.deepEqual(rec.answers.excludedSubtopics, []);
});

test("recommend leaves out the excluded sub-topics and shrinks the estimate; unknown ids are rejected", (t) => {
  const snapshot = useSnapshot(t, [ALPHA]);
  const [first, second] = ALPHA.subtopics;
  const rec = recommend({ level: 200, harness: "standard", selected: [ALPHA.id], excludedSubtopics: [first.id] }, { topics: snapshot.topics });
  const row = rec.concepts.flatMap((c) => c.topics).find((topic) => topic.id === ALPHA.id);
  assert.deepEqual(row.learn.subtopics.map((s) => [s.id, s.included]), [[first.id, false], [second.id, true]]);
  assert.equal(row.minutes, topicMinutes(2, 1));
  assert.ok(row.minutes < 20);
  assert.equal(rec.totals.subtopicCount, 1);
  assert.deepEqual(rec.selectedSubtopicIds, [second.id]);
  assert.deepEqual(row.learn.urls, [ALPHA.urls[0], second.url], "the excluded page is not one of the topic's pages");

  assert.throws(() => recommend({ level: 200, harness: "standard", excludedSubtopics: ["learn-not-a-subtopic"] }, { topics: snapshot.topics }), /Unknown sub-topic id\(s\): learn-not-a-subtopic/);
  assert.throws(() => recommend({ level: 200, harness: "standard", excludedSubtopics: [ALPHA.id] }, { topics: snapshot.topics }), /Unknown sub-topic id/, "a topic id is not a sub-topic id");
  assert.throws(() => recommend({ level: 200, harness: "standard", excludedSubtopics: "x" }, { topics: snapshot.topics }), /must be an array/);
});

// ── The planner ─────────────────────────────────────────────────────────────

test("planLab includes every sub-topic by default, exactly as before", (t) => {
  useSnapshot(t, [ALPHA]);
  const plan = planLab({ features: [ALPHA.id], harness: "standard", level: 200 });
  const [module] = plan.features;
  assert.deepEqual(module.docUrls, ALPHA.urls);
  assert.equal(module.learnTopic.subtopics.length, 2);
  assert.equal(module.minutes, 20);
  assert.equal(plan.request.excludedSubtopics, undefined, "an old client's plan records nothing new");
  assert.ok(!plan.warnings.some((w) => /left out/.test(w)));
});

test("planLab drops an excluded sub-topic from the module's pages, estimate, and record", (t) => {
  useSnapshot(t, [ALPHA]);
  const [first, second] = ALPHA.subtopics;
  const plan = planLab({ features: [ALPHA.id], harness: "standard", level: 200, excludedSubtopics: [first.id] });
  const [module] = plan.features;
  assert.deepEqual(module.docUrls, [ALPHA.urls[0], second.url]);
  assert.deepEqual(module.learnTopic.subtopics.map((s) => s.id), [second.id]);
  assert.deepEqual(module.learnTopic.subtopicChoices.map((c) => [c.id, c.included]), [[first.id, false], [second.id, true]]);
  assert.equal(module.minutes, topicMinutes(2, 1));
  assert.equal(plan.totalMinutes, module.minutes);
  assert.deepEqual(plan.request.excludedSubtopics, [first.id]);
  assert.ok(plan.warnings.some((w) => w.includes("1 sub-topic was left out") && w.includes("Alpha trigger overview")));
  assert.ok(!module.learnLinks.some((link) => link.url === first.url), "the excluded page is not a reference");
  assert.ok(!module.concepts.some((line) => line.includes("Alpha trigger overview") || line.includes("What an alpha trigger is for")));
});

test("planLab validates excludedSubtopics strictly", (t) => {
  useSnapshot(t, [ALPHA]);
  const request = { features: [ALPHA.id], harness: "standard", level: 200 };
  assert.throws(() => planLab({ ...request, excludedSubtopics: ["learn-nope"] }), /Unknown sub-topic id\(s\): learn-nope/);
  assert.throws(() => planLab({ ...request, excludedSubtopics: "learn-nope" }), /must be an array/);
  assert.throws(() => planLab({ ...request, excludedSubtopics: [1] }), /non-empty strings/);
  assert.throws(() => planLab({ ...request, excludedSubtopics: Array.from({ length: 5001 }, (_, i) => `learn-x-${i}`) }), /at most 5000/);
  assert.doesNotThrow(() => planLab({ ...request, excludedSubtopics: [] }));
});

// ── Generation: an included sub-topic is its own section; an excluded one contributes nothing ──

const STEPS_A = [
  "## Enable access to Copilot Studio MCP",
  "",
  "1. Sign in to the **Power Platform admin center** and open **Environments**.",
  "2. Select your target environment and open **Settings** > **Features**.",
  "3. Turn on **Copilot Studio MCP** and select **Save**.",
  "4. Open **Copilot Studio**, select **Settings**, and copy the connection URL.",
].join("\n");
const STEPS_B = STEPS_A.replace("Enable access", "Zeta access").replace("Power Platform admin center", "ZETA-ONLY-CONSOLE");

let fakeCount = 0;

function learnFake(pages) {
  const fetched = [];
  // The page cache is keyed by endpoint, so every fake gets its own and no test sees another's pages.
  fakeCount += 1;
  return {
    fetched,
    session: {
      ok: true,
      endpoint: `fake://learn/${fakeCount}`,
      async call(name, args) {
        if (name !== "microsoft_docs_fetch") return { content: [] };
        fetched.push(args.url);
        const text = pages[args.url] ?? "";
        return { content: [{ type: "text", text }] };
      },
    },
  };
}

const MCP = mergedTopic("mcp-access", "Connect to Copilot Studio with MCP", [
  { slug: "mcp-access-configure", title: "Configure access to Copilot Studio MCP", summary: "Turn on MCP access and copy the connection URL for Copilot Studio." },
  { slug: "mcp-access-zeta", title: "Zeta access to Copilot Studio MCP", summary: "Zeta access for Copilot Studio MCP in your environment." },
]);
const MCP_PAGES = {
  [urlOf("mcp-access")]: "# Connect to Copilot Studio with MCP\n\nCopilot Studio MCP connects developer tools to agents.\n\n## Architecture\n\nThe MCP endpoint exposes environment discovery to clients.\n",
  [urlOf("mcp-access-configure")]: `# Configure access to Copilot Studio MCP\n\nTurn on MCP access.\n\n${STEPS_A}\n`,
  [urlOf("mcp-access-zeta")]: `# Zeta access to Copilot Studio MCP\n\nZeta access.\n\n${STEPS_B}\n`,
};

async function build(request, pages = MCP_PAGES) {
  const fake = learnFake(pages);
  const result = await generateLab(
    { features: [MCP.id], harness: "standard", level: 200, includeCore: false, ...request },
    { useLearnMcp: true, connect: async () => fake.session, useLlm: false, write: false },
  );
  return { result, fetched: fake.fetched };
}

test("each included sub-topic becomes a headed section read from its own article, with a citation", async (t) => {
  useSnapshot(t, [MCP]);
  const { result, fetched } = await build({});
  assert.equal(result.status, "complete");
  const md = result.markdown;
  assert.match(md, /#### Sub-topic 1 of 2 - Configure access to Copilot Studio MCP/);
  assert.match(md, /#### Sub-topic 2 of 2 - Zeta access to Copilot Studio MCP/);
  assert.match(md, /Power Platform admin center/);
  assert.match(md, /ZETA-ONLY-CONSOLE/);
  assert.match(md, new RegExp(`Read from \\[[^\\]]+\\]\\(${urlOf("mcp-access-configure").replaceAll(".", "\\.")}\\)`), "its own article is cited next to its steps");
  assert.ok(fetched.includes(urlOf("mcp-access-configure")) && fetched.includes(urlOf("mcp-access-zeta")));
  const [module] = result.manifest.modules;
  assert.deepEqual(module.subtopics.map((s) => [s.id, s.included]), MCP.subtopics.map((s) => [s.id, true]));
  assert.ok(module.subtopics.every((s) => s.steps.source === "doc-derived" && s.steps.count >= 3));
  assert.equal(module.steps.source, "doc-derived", "the module counts as read from the documentation");
  assert.match(md, /procedures are in the sub-topic sections below/, "the module says where its procedures are");
});

test("an excluded sub-topic is never fetched and leaves no trace in the lab", async (t) => {
  useSnapshot(t, [MCP]);
  const [configure, zeta] = MCP.subtopics;
  const { result, fetched } = await build({ excludedSubtopics: [zeta.id] });
  assert.equal(result.status, "complete");
  const md = result.markdown;
  assert.match(md, /#### Sub-topic 1 of 1 - Configure access to Copilot Studio MCP/);
  assert.match(md, /Power Platform admin center/);
  for (const absent of ["ZETA-ONLY-CONSOLE", "Zeta access", zeta.url, "mcp-access-zeta"]) assert.ok(!md.includes(absent), `the lab must not mention ${absent}`);
  assert.ok(!fetched.includes(zeta.url), "the excluded article was not read");
  assert.ok(!JSON.stringify(result.manifest.modules[0].sources).includes("mcp-access-zeta"), "it is not a cited source");
  const [module] = result.manifest.modules;
  assert.deepEqual(module.subtopics.map((s) => [s.id, s.included]), [[configure.id, true], [zeta.id, false]]);
  assert.equal(module.minutes, topicMinutes(2, 1));
  assert.deepEqual(result.manifest.request.excludedSubtopics, [zeta.id]);
});

test("the manifest keeps the choice, and Edit and rebuild restores it", async (t) => {
  useSnapshot(t, [MCP]);
  const zeta = MCP.subtopics[1];
  const { result } = await build({ excludedSubtopics: [zeta.id] });
  const selections = selectionsFromManifest(result.manifest);
  assert.deepEqual(selections.excludedSubtopics, [zeta.id]);
  assert.deepEqual(selections.features, [MCP.id]);

  const { result: plain } = await build({});
  assert.deepEqual(selectionsFromManifest(plain.manifest).excludedSubtopics, [], "a lab built without a choice restores all sub-topics");
  assert.equal(plain.manifest.request.excludedSubtopics, undefined, "and its manifest is unchanged");

  const oldManifest = structuredClone(plain.manifest);
  delete oldManifest.request.excludedSubtopics;
  assert.deepEqual(selectionsFromManifest(oldManifest).excludedSubtopics, []);
});

test("when no article of a topic has a procedure, the existing gate still asks, and unverified text is never presented as read", async (t) => {
  useSnapshot(t, [MCP]);
  const pages = { ...MCP_PAGES, [urlOf("mcp-access-configure")]: "# Configure access to Copilot Studio MCP\n\nProse only, no procedure here.\n" };
  const blocked = await build({ excludedSubtopics: [MCP.subtopics[1].id] }, pages);
  assert.equal(blocked.result.status, "blocked", "an unread module is still a decision for a person, exactly as before");
  assert.equal(blocked.result.blockers[0].code, "steps-not-derived");

  const fake = learnFake(pages);
  const result = await generateLab(
    { features: [MCP.id], harness: "standard", level: 200, includeCore: false, excludedSubtopics: [MCP.subtopics[1].id] },
    { useLearnMcp: true, connect: async () => fake.session, useLlm: false, write: false, decisions: { "steps-not-derived": "proceed-catalog" } },
  );
  assert.equal(result.status, "complete");
  assert.match(result.markdown, /\[Unverified\] No procedure could be read from this sub-topic's article/);
  assert.match(result.markdown, /\[Unverified\] Open the Microsoft Learn article \*\*Configure access to Copilot Studio MCP\*\*/);
  assert.equal(result.manifest.modules[0].subtopics[0].steps.source, "catalog-fallback");
});

test("the per-topic document parser reads a sub-topic's steps as part of its module, and an excluded one is absent", async (t) => {
  useSnapshot(t, [MCP]);
  const section = (markdown) => markdown.slice(markdown.indexOf("### Step 1"), markdown.indexOf("\n## Validation"));
  const included = parseTopicMarkdownStructure(section((await build({})).result.markdown));
  assert.ok(included.steps.some((step) => /Power Platform admin center/.test(step.text)), "the sub-topic's steps are in the module's steps");
  assert.ok(included.steps.some((step) => /ZETA-ONLY-CONSOLE/.test(step.text)));
  const excluded = parseTopicMarkdownStructure(section((await build({ excludedSubtopics: [MCP.subtopics[1].id] })).result.markdown));
  assert.ok(excluded.steps.some((step) => /Power Platform admin center/.test(step.text)));
  assert.ok(!JSON.stringify(excluded).includes("ZETA-ONLY-CONSOLE"), "nothing of the left-out sub-topic reaches the per-topic documents");
  assert.ok(!JSON.stringify(excluded).includes("mcp-access-zeta"));
});

// ── Reviewed catalog topics: the same completeness rule for their related items ─────────────

test("every prerequisite of a listed catalog topic is in the list or in the recap group, and each card says so", () => {
  let selected = 0;
  let relations = 0;
  for (const product of getProducts()) {
    const harnesses = product.hasHarnesses ? ["standard", "microsoft-copilot", "customer-conversation"] : [null];
    for (const harness of harnesses) {
      for (const level of [100, 200, 300]) {
        const answers = { products: [product.id], level, ...(harness ? { harness } : {}) };
        const ids = recommend(answers, {}).concepts.flatMap((c) => c.topics.map((topic) => topic.id));
        const rec = recommend({ ...answers, selected: ids }, {});
        const listed = new Set(rec.concepts.flatMap((c) => c.topics.map((topic) => topic.id)));
        const recaps = new Set(rec.prerequisites.topics.map((p) => p.id));
        for (const row of rec.concepts.flatMap((c) => c.topics).filter((topic) => topic.selected)) {
          selected += 1;
          const feature = getFeature(row.id);
          assert.deepEqual(row.related.requires.map((r) => r.id), (feature.prereqs || []).filter((id) => getFeature(id)), `${row.id} lists what it requires`);
          for (const relation of row.related.requires) {
            relations += 1;
            assert.ok(["selected", "recap"].includes(relation.state), `${row.id} requires ${relation.id}, which is ${relation.state}`);
            assert.ok(relation.state === "selected" ? listed.has(relation.id) : recaps.has(relation.id), `${relation.id} is visible where the card says it is`);
          }
          for (const id of expandPrereqs([row.id]).filter((other) => other !== row.id)) {
            if (getFeature(id).thirdPartyConnector && !feature.thirdPartyConnector) continue;
            assert.ok(listed.has(id) || recaps.has(id), `${product.id}/${harness}/Level ${level}: ${id} (needed by ${row.id}) is neither listed nor a recap`);
          }
          for (const dependent of row.related.requiredBy) assert.ok((getFeature(dependent.id).prereqs || []).includes(row.id), `${dependent.id} really requires ${row.id}`);
        }
      }
    }
  }
  assert.ok(selected >= 150 && relations >= 100, `audited ${selected} topics and ${relations} requirements`);
});

test("a card names what it requires and what requires it, with where each one shows up", () => {
  const ids = recommend({ products: ["copilot-studio"], harness: "standard", level: 200 }, {}).concepts.flatMap((c) => c.topics.map((topic) => topic.id));
  const rec = recommend({ products: ["copilot-studio"], harness: "standard", level: 200, selected: ids, excluded: [] }, {});
  const withBoth = rec.concepts.flatMap((c) => c.topics).find((topic) => topic.related.requires.length && topic.related.requiredBy.length);
  assert.ok(withBoth, "some topic has both kinds of relative");
  for (const relative of [...withBoth.related.requires, ...withBoth.related.requiredBy]) {
    assert.ok(relative.id && relative.name);
    assert.ok(["selected", "recap", "assumed", "available", "other-level", "other-harness", "other-product"].includes(relative.state));
  }
});

