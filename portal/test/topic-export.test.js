/**
 * Export All Topics: the dataset, the three file formats, the endpoint, and the CLI.
 * Hermetic: the topic list is a scripted snapshot; the real portal server runs on a random
 * port with throwaway storage for the HTTP checks.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer as createNetServer } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

import { recommend } from "../lib/lab-builder/recommend.js";
import { getProducts } from "../lib/lab-builder/products.js";
import { listHash } from "../lib/lab-builder/topic-snapshot.js";
import { resetTopicSource, setTopicSource, createTopicService } from "../lib/lab-builder/topic-store.js";
import { registerTopicRoutes } from "../lib/lab-builder/topic-api.js";
import { topicId } from "../lib/lab-builder/topic-sanitize.js";
import { createRateLimiter, positiveIntFromEnv } from "../lib/rate-limit.js";
import {
  EXPORT_COLUMNS,
  applySelection,
  buildTopicExport,
  csvField,
  exportFileName,
  normalizeExportRequest,
  protectFormula,
  serialize,
  toCsv,
  toJson,
  toMarkdown,
} from "../lib/lab-builder/topic-export.js";

process.env.LAB_BUILDER_LINK_CHECK = "off";
process.env.LAB_BUILDER_VENDOR_DOCS = "off";

const portalRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = join(portalRoot, "..");
const BASE = "https://learn.microsoft.com/microsoft-copilot-studio";
const urlOf = (slug) => `${BASE}/${slug}`;
const committed = JSON.parse(readFileSync(join(portalRoot, "lib", "lab-builder", "learn-topics.snapshot.json"), "utf8"));

function topic(slug, title, subs = [], extra = {}) {
  const subtopics = subs.map((sub) => ({ id: topicId(sub.url || urlOf(sub.slug)), title: sub.title, url: sub.url || urlOf(sub.slug), ...(sub.summary ? { summary: sub.summary } : {}) }));
  return {
    id: topicId(urlOf(slug)),
    title,
    summary: `${title} is a topic from Microsoft Learn.`,
    urls: [urlOf(slug), ...subtopics.filter((s) => s.url.startsWith("https://")).map((s) => s.url)],
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

const learnOf = (topics) => ({ topics, checks: [], updatedWindowDays: 30, now: Date.parse("2026-11-18T12:00:00Z") });
const ALL_PRODUCTS = getProducts().map((p) => p.id);
const NOW = Date.parse("2026-11-18T12:00:00Z");

/** RFC 4180 parser, to check the CSV the way Excel and other readers would read it. */
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

// ── The dataset is what the wizard shows ────────────────────────────────────

test("the export holds every topic Step 6 lists at each level, for every product", () => {
  const learn = learnOf(committed.topics);
  const dataset = buildTopicExport({ products: ALL_PRODUCTS, harness: "standard", learn, now: NOW });
  const exported = dataset.rows.filter((row) => row.type === "topic");
  let listed = 0;
  for (const level of [100, 200, 300]) {
    const rec = recommend({ products: ALL_PRODUCTS, harness: "standard", level }, learn);
    const ids = rec.concepts.flatMap((concept) => concept.topics.map((t) => t.id));
    listed += ids.length;
    assert.deepEqual(
      exported.filter((row) => row.level === level && row.groupId !== "level-unknown").map((row) => row.id).sort(),
      ids.sort(),
      `Level ${level}: the export and the wizard list the same topics`,
    );
  }
  const unknown = recommend({ products: ALL_PRODUCTS, harness: "standard", level: 100 }, learn).levelUnknown.topics.length;
  assert.equal(exported.length, listed + unknown);
  assert.equal(dataset.counts.topics, exported.length);
  assert.equal(dataset.counts.rows, dataset.rows.length);
  assert.deepEqual(Object.keys(dataset.counts.byProduct).sort(), [...ALL_PRODUCTS].sort(), "every chosen product has rows");
});

test("every sub-topic of every exported topic is a row of its own, right under its topic", () => {
  const dataset = buildTopicExport({ products: ["copilot-studio"], harness: "microsoft-copilot", learn: learnOf(committed.topics), now: NOW });
  const standard = buildTopicExport({ products: ["copilot-studio"], harness: "standard", learn: learnOf(committed.topics), now: NOW });
  const withSubs = committed.topics.filter((t) => t.status === "new" && t.subtopics?.length);
  assert.ok(withSubs.length >= 6, "the committed snapshot has merged topics");
  for (const parent of withSubs) {
    const ds = parent.harnesses.includes("microsoft-copilot") ? dataset : standard;
    const at = ds.rows.findIndex((row) => row.id === parent.id);
    assert.ok(at >= 0, `${parent.title} is exported`);
    parent.subtopics.forEach((sub, offset) => {
      const row = ds.rows[at + 1 + offset];
      assert.equal(row.id, sub.id);
      assert.equal(row.type, "sub-topic");
      assert.equal(row.parentId, parent.id);
      assert.equal(row.subtopic, sub.title);
      assert.equal(row.topic, parent.title, "a sub-topic row names its topic");
      assert.deepEqual(row.urls, [sub.url]);
    });
  }
});

test("each row carries product, group, level and its basis, minutes, harnesses, status, relations, URLs, and source", () => {
  const dataset = buildTopicExport({
    products: ["copilot-studio"],
    harness: "standard",
    industry: "healthcare",
    departments: ["customer-service"],
    learn: learnOf([topic("alpha", "Alpha", [{ slug: "alpha-a", title: "Alpha A", summary: "About A." }], { availability: "preview" })]),
    now: NOW,
  });
  assert.deepEqual(EXPORT_COLUMNS.map(([, header]) => header), [
    "Product", "Topic group", "Topic", "Sub-topic", "Type", "Level", "Level basis", "Approx. minutes", "Harness applicability", "Availability",
    "Learn status", "Optional 3rd-party connector", "Required prerequisite", "Recommended", "Why recommended", "Prerequisites", "Required by",
    "Microsoft Learn URL(s)", "Source", "Selected in my lab",
  ]);
  const alpha = dataset.rows.find((row) => row.topic === "Alpha" && row.type === "topic");
  assert.equal(alpha.product, "Microsoft Copilot Studio");
  assert.equal(alpha.group, "MCP servers");
  assert.equal(alpha.level, 200);
  assert.equal(alpha.availability, "preview");
  assert.equal(alpha.learnStatus, "new");
  assert.equal(alpha.source, "Microsoft Learn");
  assert.equal(alpha.harnesses, "Standard harness");
  assert.equal(alpha.minutes, 20);
  const sub = dataset.rows.find((row) => row.subtopic === "Alpha A");
  assert.equal(sub.minutes, 10);
  assert.equal(sub.levelBasis, "estimated", "a sub-topic with no level of its own takes its topic's level, as an estimate");
  assert.equal(sub.availability, "preview");
  const catalog = dataset.rows.find((row) => row.source === "Reviewed catalog" && row.requires);
  assert.ok(catalog.requires.length > 0, "a catalog topic lists what it requires");
  assert.ok(dataset.rows.some((row) => row.requiredBy), "and what requires it");
  assert.ok(dataset.rows.some((row) => row.recommended && row.recommendedWhy), "recommended topics say why");
  assert.ok(dataset.rows.some((row) => row.thirdParty), "optional 3rd-party connectors are flagged");
  assert.ok(dataset.rows.every((row) => row.urls.every((url) => url.startsWith("https://"))));
});

test("the scope says what it covers, with the row count", () => {
  const dataset = buildTopicExport({ products: ["sharepoint-ai", "copilot-studio"], harness: "microsoft-copilot", learn: learnOf([]), now: NOW });
  assert.match(dataset.scope.text, /^All topics and sub-topics for Copilot Studio and SharePoint AI \(Microsoft Copilot harness\), all levels: \d+ rows \(\d+ topics, 0 sub-topics\)\.$/);
  assert.deepEqual(dataset.scope.products.map((p) => p.id), ["copilot-studio", "sharepoint-ai"], "in catalog order");
  const sharepointOnly = buildTopicExport({ products: ["sharepoint-ai"], learn: learnOf([]), now: NOW });
  assert.equal(sharepointOnly.scope.harness, null, "a product without harnesses has no harness rule");
  assert.match(sharepointOnly.scope.text, /^All topics and sub-topics for SharePoint AI, all levels: /);
  assert.ok(sharepointOnly.rows.every((row) => row.productId === "sharepoint-ai"));
});

test("the harness rule applies to Copilot Studio: another harness lists other topics", () => {
  const learn = learnOf(committed.topics);
  const standard = buildTopicExport({ products: ["copilot-studio"], harness: "standard", learn, now: NOW });
  const copilot = buildTopicExport({ products: ["copilot-studio"], harness: "microsoft-copilot", learn, now: NOW });
  assert.notDeepEqual(standard.rows.map((r) => r.id), copilot.rows.map((r) => r.id));
  assert.ok(standard.rows.every((row) => /Standard harness/.test(row.harnesses)));
  assert.ok(copilot.rows.every((row) => /Microsoft Copilot harness/.test(row.harnesses)));
});

test("selection fills Selected in my lab and Required prerequisite without changing which rows exist", () => {
  const alpha = topic("alpha", "Alpha", [{ slug: "alpha-a", title: "Alpha A" }, { slug: "alpha-b", title: "Alpha B" }]);
  const dataset = buildTopicExport({ products: ["copilot-studio"], harness: "standard", learn: learnOf([alpha]), now: NOW });
  const none = applySelection(dataset.rows, {});
  assert.equal(none.length, dataset.rows.length);
  assert.ok(none.every((row) => row.selected === false));
  const [a, b] = alpha.subtopics;
  const picked = applySelection(dataset.rows, { selectedIds: [alpha.id, "mc-instructions"], requiredIds: [alpha.id], excludedSubtopics: [a.id] });
  assert.equal(picked.length, dataset.rows.length);
  assert.equal(picked.find((row) => row.id === alpha.id).selected, true);
  assert.equal(picked.find((row) => row.id === alpha.id).requiredPrerequisite, true);
  assert.equal(picked.find((row) => row.id === a.id).selected, false);
  assert.equal(picked.find((row) => row.id === b.id).selected, true);
  assert.equal(picked.find((row) => row.id === b.id).requiredPrerequisite, false, "only topics are prerequisites");
  const unselectedParent = applySelection(dataset.rows, { selectedIds: [] });
  assert.ok(unselectedParent.filter((row) => row.type === "sub-topic").every((row) => row.selected === false));
});

// ── CSV ─────────────────────────────────────────────────────────────────────

test("CSV is UTF-8 with a BOM, CRLF, quoted where needed, and one record per row", () => {
  const nasty = topic("nasty", 'He said "hi", then left\nthe room', [{ slug: "nasty-a", title: "Café, naïve" }], { summary: "Line one\nline two" });
  const dataset = buildTopicExport({ products: ["copilot-studio"], harness: "standard", learn: learnOf([nasty]), now: NOW });
  const csv = toCsv(dataset, { selectedIds: [nasty.id] });
  assert.equal(csv.charCodeAt(0), 0xfeff, "starts with a byte order mark");
  assert.deepEqual([...Buffer.from(csv.slice(0, 1), "utf8")], [0xef, 0xbb, 0xbf]);
  assert.equal(csv.endsWith("\r\n"), true);
  assert.equal(/(?<!\r)\n/.test(csv.replace(/"(?:[^"]|"")*"/g, "")), false, "outside quotes every line break is CRLF");
  const rows = parseCsv(csv.slice(1));
  assert.equal(rows.length, dataset.rows.length + 1);
  assert.ok(rows.every((row) => row.length === EXPORT_COLUMNS.length), "no field spills into another column");
  const row = rows.find((r) => r[2].startsWith("He said"));
  assert.equal(row[2], 'He said "hi", then left the room', "quotes and commas survive, and a newline in a title becomes a space");
  assert.equal(row[3], "");
  const sub = rows.find((r) => r[3] === "Café, naïve");
  assert.equal(sub[3], "Café, naïve");
  assert.equal(sub[19], "Yes");
  assert.equal(csvField('a,"b"'), '"a,""b"""');
  assert.equal(csvField("plain"), "plain");
});

test("CSV cells that spreadsheets read as formulas get a leading apostrophe", () => {
  for (const [input, expected] of [
    ["=1+1", "'=1+1"],
    ["+SUM(A1)", "'+SUM(A1)"],
    ["-2+3", "'-2+3"],
    ["@cmd", "'@cmd"],
    ["\t=x", "'\t=x"],
    ["\r=x", "'\r=x"],
    ["  =x", "'  =x"],
    ["Plain", "Plain"],
    ["Level 200", "Level 200"],
    ["a=b", "a=b"],
  ]) assert.equal(protectFormula(input), expected);

  const hostile = topic("hostile", '=HYPERLINK("https://evil.example","x")', [{ slug: "hostile-a", title: "@SUM(A1)" }, { slug: "hostile-b", title: "\t=cmd" }]);
  const dataset = buildTopicExport({ products: ["copilot-studio"], harness: "standard", learn: learnOf([hostile]), now: NOW });
  const rows = parseCsv(toCsv(dataset).slice(1)).slice(1);
  for (const row of rows) for (const value of row) assert.equal(/^[=+\-@\t\r]/.test(value), false, `unprotected: ${JSON.stringify(value)}`);
  assert.ok(rows.some((row) => row[2] === `'=HYPERLINK("https://evil.example","x")`));
});

test("only https Microsoft Learn URLs are exported", () => {
  const odd = topic("odd", "Odd", [
    { id: "learn-odd-http", slug: "odd-http", title: "Plain http", url: "http://learn.microsoft.com/microsoft-copilot-studio/odd-http" },
    { id: "learn-odd-js", slug: "odd-js", title: "Script", url: "javascript:alert(1)" },
    { slug: "odd-ok", title: "Fine" },
  ]);
  const dataset = buildTopicExport({ products: ["copilot-studio"], harness: "standard", learn: learnOf([odd]), now: NOW });
  const subs = dataset.rows.filter((row) => row.type === "sub-topic");
  assert.deepEqual(subs.map((row) => row.urls.length), [0, 0, 1]);
  const csv = toCsv(dataset);
  assert.ok(!/http:\/\//.test(csv) && !csv.includes("javascript:"));
  for (const row of dataset.rows) for (const url of row.urls) assert.match(url, /^https:\/\//);
});

// ── Markdown and JSON ───────────────────────────────────────────────────────

test("Markdown is a grouped outline with links, and text cannot break out of it", () => {
  const md = buildTopicExport({
    products: ["copilot-studio"],
    harness: "standard",
    learn: learnOf([topic("md", "Use *stars* and [brackets] | pipes", [{ slug: "md-a", title: "<b>x</b> _y_" }])]),
    now: NOW,
  });
  const text = toMarkdown(md, { selectedIds: [] });
  assert.match(text, /^# Topic export: Copilot Studio\n\nAll topics and sub-topics for Copilot Studio/);
  assert.match(text, /\n## Microsoft Copilot Studio\n/);
  assert.match(text, /\n### MCP servers\n\n/);
  assert.match(text, /\n- \[Use stars and \\\[brackets\\\] pipes\]\(https:\/\/learn\.microsoft\.com\/microsoft-copilot-studio\/md\) - Level 200/, "the data layer already strips emphasis marks from titles; brackets are escaped");
  assert.match(text, /\n  - Sub-topic: \[\\<b\\>x\\<\/b\\> \\_y\\_\]\(https:\/\/learn\.microsoft\.com\/microsoft-copilot-studio\/md-a\) - Level 200 \(estimated\)/);
  assert.ok(!text.includes("<b>"), "markup is escaped");
  assert.ok(text.endsWith("\n"));
});

test("JSON is product, then group, then topic with its subTopics", () => {
  const dataset = buildTopicExport({
    products: ["copilot-studio", "sharepoint-ai"],
    harness: "standard",
    learn: learnOf([topic("j", "Jay", [{ slug: "j-a", title: "Jay A" }, { slug: "j-b", title: "Jay B" }])]),
    now: NOW,
  });
  const parsed = JSON.parse(toJson(dataset, { selectedIds: [topicId(urlOf("j"))], excludedSubtopics: [topicId(urlOf("j-b"))] }));
  assert.deepEqual(Object.keys(parsed), ["schemaVersion", "generatedAt", "scope", "counts", "products"]);
  assert.deepEqual(parsed.products.map((p) => p.id), ["copilot-studio", "sharepoint-ai"]);
  const jay = parsed.products[0].groups.flatMap((g) => g.topics).find((x) => x.name === "Jay");
  assert.deepEqual(jay.subTopics.map((s) => [s.name, s.selected, s.type]), [["Jay A", true, "sub-topic"], ["Jay B", false, "sub-topic"]]);
  assert.equal(jay.selected, true);
  assert.equal(jay.subTopics[0].level, 200);
  for (const key of ["id", "name", "type", "level", "levelBasis", "approxMinutes", "harnesses", "availability", "learnStatus", "optionalThirdPartyConnector", "requiredPrerequisite", "recommended", "recommendedWhy", "prerequisites", "requiredBy", "urls", "source", "selected"]) assert.ok(key in jay, `${key} is in a topic`);
  assert.equal(parsed.counts.rows, dataset.rows.length);
  assert.equal(parsed.products.flatMap((p) => p.groups).flatMap((g) => g.topics).length, dataset.counts.topics);
  assert.equal(serialize("json", dataset), toJson(dataset));
});

test("file names say the products and the date", () => {
  const dataset = buildTopicExport({ products: ["copilot-studio", "sharepoint-ai"], harness: "standard", learn: learnOf([]), now: NOW });
  assert.equal(exportFileName(dataset, "csv"), "all-topics-copilot-studio-sharepoint-ai-2026-11-18.csv");
  assert.equal(exportFileName(dataset, "markdown"), "all-topics-copilot-studio-sharepoint-ai-2026-11-18.md");
  assert.equal(exportFileName(dataset, "json"), "all-topics-copilot-studio-sharepoint-ai-2026-11-18.json");
});

test("large exports build quickly", () => {
  const many = Array.from({ length: 300 }, (_, i) => topic(`bulk-${i}`, `Bulk topic ${i}`, Array.from({ length: 4 }, (__, j) => ({ slug: `bulk-${i}-${j}`, title: `Bulk ${i}.${j}` }))));
  const started = Date.now();
  const dataset = buildTopicExport({ products: ALL_PRODUCTS, harness: "standard", learn: learnOf(many), now: NOW });
  const csv = toCsv(dataset);
  assert.ok(dataset.rows.length > 1500);
  assert.ok(csv.length > 200000);
  assert.ok(Date.now() - started < 5000, "well under a few seconds");
});

// ── Request validation and the route ────────────────────────────────────────

test("the request is validated before anything is built", () => {
  assert.throws(() => normalizeExportRequest([]), /must be a JSON object/);
  assert.throws(() => normalizeExportRequest({ products: [] }), /at least one product/);
  assert.throws(() => normalizeExportRequest({ products: ["nope"] }), /Unknown product id\(s\): nope/);
  assert.throws(() => normalizeExportRequest({ products: "copilot-studio" }), /products must be an array/);
  assert.throws(() => normalizeExportRequest({ format: "xlsx" }), /format must be one of csv, markdown, json, dataset/);
  assert.throws(() => normalizeExportRequest({ harness: 5 }), /harness must be a string/);
  assert.throws(() => normalizeExportRequest({ selectedIds: [1] }), /selectedIds must be an array of strings/);
  assert.throws(() => normalizeExportRequest({ excludedSubtopics: Array.from({ length: 2001 }, (_, i) => `x${i}`) }), /at most 2000/);
  const ok = normalizeExportRequest({});
  assert.deepEqual(ok.products, ["copilot-studio"]);
  assert.equal(ok.format, "dataset");
});

async function startApi(t, { max = 3, limit = "64kb" } = {}) {
  const snapshot = { schemaVersion: 1, generatedAt: "2026-11-13T12:00:00Z", source: "test", catalogVersion: "test", topics: [topic("alpha", "Alpha", [{ slug: "alpha-a", title: "Alpha A" }])], catalog: [], pageHashes: {} };
  snapshot.listHash = listHash(snapshot);
  setTopicSource({ source: "cache", snapshot });
  t.after(() => resetTopicSource());
  const service = createTopicService({
    discover: async () => assert.fail("no refresh here"),
    config: { cachePath: join(tmpdir(), "unused-cache.json"), snapshotPath: join(tmpdir(), "unused-snapshot.json"), ttlMs: 86400000, disabled: true, autoRefresh: false, autoRefreshMs: 1, minRefreshIntervalMs: 1, breakerFailures: 3, breakerCooldownMs: 1, updatedWindowDays: 30 },
    now: () => NOW,
  });
  const entry = { source: "cache", snapshot };
  service.view = () => ({ source: entry.source, snapshot, refreshedAt: snapshot.generatedAt, ageMs: 0, stale: false, refreshing: false, offline: false, disabled: true, lastError: null, circuitOpen: false, retryAfterSec: 0 });
  service.revalidateIfStale = () => false;
  const app = express();
  app.use(express.json({ limit }));
  app.use("/api", (req, res, next) => (req.headers.authorization ? ((req.user = { oid: req.headers.authorization }), next()) : res.status(401).json({ error: "Authentication required" })));
  process.env.LAB_BUILDER_TOPICS_EXPORT_RATE_MAX = String(max);
  registerTopicRoutes(app, { getService: () => service, createRateLimiter, positiveIntFromEnv });
  delete process.env.LAB_BUILDER_TOPICS_EXPORT_RATE_MAX;
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    call: (body, { auth = "user-1", raw } = {}) =>
      fetch(`${url}/api/lab-builder/topics/export`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
        body: raw ?? JSON.stringify(body),
      }),
  };
}

test("POST export needs sign-in, validates its input, and answers each format", async (t) => {
  const { call } = await startApi(t, { max: 50 });
  assert.equal((await call({}, { auth: null })).status, 401);
  for (const [body, pattern] of [
    [{ products: ["nope"] }, /Unknown product/],
    [{ format: "pdf" }, /format must be one of/],
    [{ products: [] }, /at least one product/],
    [{ harness: "standard", products: ["sharepoint-ai"], format: "csv" }, null],
    [{ harness: "nonsense" }, /Unknown harness/],
    [{ products: ["sharepoint-ai"], harness: "standard", format: "dataset" }, null],
  ]) {
    const res = await call(body);
    if (pattern) {
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.match((await res.json()).error, pattern);
    } else assert.equal(res.status, 200, JSON.stringify(body));
  }
  assert.equal((await call(null, { raw: "{ nope" })).status, 400);

  const dataset = await (await call({ products: ["copilot-studio"], harness: "standard" })).json();
  assert.ok(dataset.dataset.rows.length > 40);
  assert.ok(dataset.dataset.rows.some((row) => row.subtopic === "Alpha A"));

  const csv = await call({ products: ["copilot-studio"], harness: "standard", format: "csv", selectedIds: [topicId(urlOf("alpha"))] });
  assert.equal(csv.status, 200);
  assert.equal(csv.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.match(csv.headers.get("content-disposition"), /^attachment; filename="all-topics-copilot-studio-\d{4}-\d{2}-\d{2}\.csv"$/);
  assert.equal(csv.headers.get("cache-control"), "no-store");
  const bytes = Buffer.from(await csv.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const rows = parseCsv(bytes.toString("utf8").slice(1));
  assert.equal(rows.find((row) => row[2] === "Alpha" && row[3] === "")[19], "Yes");
  assert.equal(rows.find((row) => row[3] === "Alpha A")[19], "Yes");

  const md = await call({ products: ["copilot-studio"], harness: "standard", format: "markdown" });
  assert.equal(md.headers.get("content-type"), "text/markdown; charset=utf-8");
  assert.match(await md.text(), /^# Topic export: Copilot Studio/);
  const json = await call({ products: ["copilot-studio"], harness: "standard", format: "json" });
  assert.equal(json.headers.get("content-type"), "application/json; charset=utf-8");
  assert.ok(JSON.parse(await json.text()).products.length);
});

test("POST export is rate limited and takes at most a 64 KB body", async (t) => {
  const { call } = await startApi(t, { max: 2, limit: "1kb" });
  assert.equal((await call({ products: ["sharepoint-ai"] })).status, 200);
  assert.equal((await call({ products: ["sharepoint-ai"] })).status, 200);
  assert.equal((await call({ pad: "x".repeat(4000) })).status, 413, "an oversized body is refused before it is read");
  const limited = await call({ products: ["sharepoint-ai"] });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
  assert.match((await limited.json()).error, /Export rate limit exceeded/);
  assert.equal((await call({ products: ["sharepoint-ai"] }, { auth: "someone-else" })).status, 200, "the limit is per person");
});

// ── The real server ─────────────────────────────────────────────────────────

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on("error", reject);
  });
}

async function startPortal(t) {
  const root = mkdtempSync(join(tmpdir(), "subtopic-portal-"));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.js"], {
    cwd: portalRoot,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      PORTAL_AUTH_DISABLED: "true",
      PORTAL_STORAGE_ROOT: root,
      AZURE_KEYVAULT_URL: "",
      LAB_BUILDER_OUTPUT_DIR: join(root, "generated-labs"),
      LAB_BUILDER_TOPICS_DISABLED: "1",
      LAB_BUILDER_TOPICS_CACHE: join(root, "topics-cache.json"),
      LAB_BUILDER_LINK_CHECK: "off",
      LAB_BUILDER_VENDOR_DOCS: "off",
    },
    stdio: "ignore",
  });
  t.after(async () => {
    child.kill();
    await new Promise((resolve) => (child.exitCode === null ? child.once("exit", resolve) : resolve()));
    rmSync(root, { recursive: true, force: true });
  });
  const startedAt = Date.now();
  let ready = false;
  while (!ready && Date.now() - startedAt < 40000) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${child.exitCode}`);
    try {
      ready = (await fetch(`${base}/api/config`)).ok;
    } catch {
      /* wait for the listener */
    }
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 150));
  }
  assert.ok(ready, "the portal server started");
  const post = (route, body, raw) => fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: raw ?? JSON.stringify(body) });
  return { base, post, get: (route) => fetch(`${base}${route}`) };
}

const MCP = committed.topics.find((x) => x.id === "learn-mcp-server-certification");
const MCP_SUB = MCP.subtopics[0];

test("the real server takes excludedSubtopics on recommend and preview, rejects unknown ids with a 400, and exports", async (t) => {
  const { post } = await startPortal(t);
  const answers = { products: ["copilot-studio"], harness: "standard", level: 200 };

  const rec = await post("/api/lab-builder/recommend", { ...answers, selected: [MCP.id], excludedSubtopics: [MCP_SUB.id] });
  assert.equal(rec.status, 200);
  const body = await rec.json();
  const row = body.concepts.flatMap((c) => c.topics).find((x) => x.id === MCP.id);
  assert.deepEqual(row.learn.subtopics.map((s) => [s.id, s.included]), [[MCP_SUB.id, false]]);
  assert.ok(row.learn.subtopics[0].summary || row.learn.subtopics[0].title);
  assert.equal(body.totals.subtopicCount, 0);

  const bad = await post("/api/lab-builder/recommend", { ...answers, excludedSubtopics: ["learn-nope"] });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /Unknown sub-topic id\(s\): learn-nope/);

  const preview = await post("/api/lab-builder/preview", { ...answers, features: [MCP.id], excludedSubtopics: [MCP_SUB.id] });
  assert.equal(preview.status, 200);
  const plan = await preview.json();
  assert.deepEqual(plan.excludedSubtopics, [MCP_SUB.id]);
  assert.deepEqual(plan.modules[0].subtopics.map((s) => [s.id, s.included]), [[MCP_SUB.id, false]]);
  assert.ok(plan.modules[0].minutes < 20);
  const full = await (await post("/api/lab-builder/preview", { ...answers, features: [MCP.id] })).json();
  assert.equal(full.modules[0].minutes, 20, "an old client's request is planned as before");
  assert.deepEqual(full.modules[0].subtopics.map((s) => s.included), [true]);

  for (const route of ["/api/lab-builder/preview", "/api/lab-builder/generate"]) {
    const unknown = await post(route, { ...answers, features: [MCP.id], excludedSubtopics: ["learn-nope"] });
    assert.equal(unknown.status, 400, route);
    assert.match((await unknown.json()).error, /Unknown sub-topic id/);
    const notArray = await post(route, { ...answers, features: [MCP.id], excludedSubtopics: "learn-nope" });
    assert.equal(notArray.status, 400, route);
  }

  const exported = await post("/api/lab-builder/topics/export", { products: ["copilot-studio"], harness: "standard", format: "csv", selectedIds: [MCP.id], excludedSubtopics: [MCP_SUB.id] });
  assert.equal(exported.status, 200);
  const rows = parseCsv(Buffer.from(await exported.arrayBuffer()).toString("utf8").slice(1));
  assert.equal(rows.find((r) => r[3] === MCP_SUB.title)[19], "No");
  assert.equal(rows.find((r) => r[2] === MCP.title && r[3] === "")[19], "Yes");
  const tooBig = await post("/api/lab-builder/topics/export", null, JSON.stringify({ products: ["copilot-studio"], pad: "x".repeat(70 * 1024) }));
  assert.equal(tooBig.status, 413, "the body limit is 64 KB");
});

test("a lab built with a left-out sub-topic records it, and Edit and rebuild gets it back", async (t) => {
  const { post, get } = await startPortal(t);
  const request = { products: ["copilot-studio"], harness: "standard", level: 200, features: [MCP.id], excludedSubtopics: [MCP_SUB.id], useLearnMcp: false, useLlm: false };
  const res = await post("/api/lab-builder/generate", request);
  assert.equal(res.status, 200);
  const lab = await res.json();
  assert.equal(lab.status, "complete");
  assert.deepEqual(lab.manifest.request.excludedSubtopics, [MCP_SUB.id]);
  assert.ok(!lab.markdown.includes(MCP_SUB.url), "the left-out page is not in the lab");
  assert.ok(!lab.markdown.includes("Sub-topic 1 of"), "and it has no section");
  assert.deepEqual(lab.manifest.modules[0].subtopics.map((s) => [s.id, s.included]), [[MCP_SUB.id, false]]);
  const loaded = await (await get(`/api/lab-builder/generated/${lab.labId}`)).json();
  assert.deepEqual(loaded.selections.excludedSubtopics, [MCP_SUB.id]);
  const listed = await (await get("/api/lab-builder/generated")).json();
  assert.deepEqual((listed.labs || listed).find((l) => l.labId === lab.labId || l.id === lab.labId).selections.excludedSubtopics, [MCP_SUB.id]);

  const plain = await (await post("/api/lab-builder/generate", { ...request, excludedSubtopics: undefined })).json();
  assert.equal(plain.manifest.request.excludedSubtopics, undefined);
  assert.match(plain.markdown, /#### Sub-topic 1 of 1 - /, "included by default, as a section of its own");
});

// ── The command line ────────────────────────────────────────────────────────

test("the command line writes the same files, and says what is wrong with bad input", () => {
  const dir = mkdtempSync(join(tmpdir(), "export-cli-"));
  try {
    const script = join(repoRoot, "tools", "lab-builder", "export-topics.mjs");
    const out = join(dir, "topics.csv");
    // A runtime topic cache from a local portal run would add newer topics; the library side below uses the committed snapshot only.
    const env = { ...process.env, LAB_BUILDER_TOPICS_CACHE: join(dir, "no-topics-cache.json") };
    const ok = spawnSync(process.execPath, [script, "--products", "copilot-studio,sharepoint-ai", "--format", "csv", "--out", out, "--selected", "mc-instructions"], { encoding: "utf8", env });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stderr, /All topics and sub-topics for Copilot Studio and SharePoint AI \(Standard harness\), all levels: \d+ rows/);
    const csv = readFileSync(out);
    assert.deepEqual([...csv.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const direct = toCsv(buildTopicExport({ products: ["copilot-studio", "sharepoint-ai"], harness: "standard", learn: learnOf(committed.topics), now: Date.now() }), { selectedIds: ["mc-instructions"] });
    assert.equal(csv.toString("utf8").split("\r\n").length, direct.split("\r\n").length, "same rows as the library builds");

    const md = spawnSync(process.execPath, [script, "--products=sharepoint-ai", "--format=markdown", "--out", "-"], { encoding: "utf8", env });
    assert.equal(md.status, 0);
    assert.match(md.stdout, /^# Topic export: SharePoint AI/);

    for (const [args, pattern] of [
      [["--products", "nope"], /Unknown product id\(s\): nope/],
      [["--format", "pdf"], /format must be one of/],
      [["--bogus"], /Unknown flag --bogus/],
      [["--format", "dataset"], /format must be one of csv, markdown, json/],
    ]) {
      const bad = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
      assert.equal(bad.status, 1, args.join(" "));
      assert.match(bad.stderr, pattern);
    }
    writeFileSync(join(dir, "marker"), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
