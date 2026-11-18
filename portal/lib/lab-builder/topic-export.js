/**
 * Export All Topics: every available topic and sub-topic for the products a
 * learner chose, as one flat table that opens in Excel (CSV), reads as an
 * outline (Markdown), or feeds other tools (JSON).
 *
 * The rows are the union of what the wizard lists at each level, so the export
 * and Step 6 can never disagree: it calls `recommend()` once per level and
 * once for topics whose level is unknown. It is independent of the search, the
 * filter, the single-level view, and the current selection. The selection
 * only fills the "Selected in my lab" column (`applySelection`).
 *
 * `portal/public/lab-builder-wizard.js` builds the same files in the browser
 * from the dataset this module returns, so an export keeps working offline;
 * a test compares the two implementations byte for byte.
 */

import { recommend } from "./recommend.js";
import { getHarnesses } from "./catalog.js";
import { getConcepts } from "./concepts.js";
import { DEFAULT_PRODUCT, getProduct, getProducts, joinNames, productHasHarnesses, productName } from "./products.js";
import { UNCATEGORIZED } from "./topic-snapshot.js";

export const EXPORT_FORMATS = ["csv", "markdown", "json"];
export const EXPORT_SCHEMA_VERSION = 1;
const LEVELS = [100, 200, 300];
const MAX_SELECTION_IDS = 2000;

/** Column key, header, in the order the CSV lists them. */
export const EXPORT_COLUMNS = [
  ["product", "Product"],
  ["group", "Topic group"],
  ["topic", "Topic"],
  ["subtopic", "Sub-topic"],
  ["type", "Type"],
  ["level", "Level"],
  ["levelBasis", "Level basis"],
  ["minutes", "Approx. minutes"],
  ["harnesses", "Harness applicability"],
  ["availability", "Availability"],
  ["learnStatus", "Learn status"],
  ["thirdParty", "Optional 3rd-party connector"],
  ["requiredPrerequisite", "Required prerequisite"],
  ["recommended", "Recommended"],
  ["recommendedWhy", "Why recommended"],
  ["requires", "Prerequisites"],
  ["requiredBy", "Required by"],
  ["urls", "Microsoft Learn URL(s)"],
  ["source", "Source"],
  ["selected", "Selected in my lab"],
];

const AVAILABILITY_LABEL = { ga: "GA", preview: "Preview", retired: "Retired" };
const LEARN_STATUS_LABEL = { new: "New from Learn", updated: "Updated", stale: "Docs moved" };
const BASIS_LABEL = { declared: "Declared", estimated: "Estimated", unknown: "Unknown" };

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function httpsUrls(list) {
  const seen = new Set();
  const out = [];
  for (const raw of list || []) {
    let url;
    try {
      url = new URL(String(raw));
    } catch {
      continue;
    }
    if (url.protocol !== "https:" || url.username || url.password) continue;
    if (!seen.has(url.href)) {
      seen.add(url.href);
      out.push(url.href);
    }
  }
  return out;
}

function toIdList(value, name) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string")) {
    throw new Error(`${name} must be an array of strings.`);
  }
  if (value.length > MAX_SELECTION_IDS) throw new Error(`${name} may contain at most ${MAX_SELECTION_IDS} items.`);
  return [...new Set(value.map((id) => id.trim()).filter(Boolean))];
}

/** The request body of the export endpoint and the CLI, validated: products, harness, answers, selection, format (`dataset` returns the rows the wizard builds its own files from). */
export function normalizeExportRequest(body = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("The export request must be a JSON object.");
  const products = toIdList(body.products === undefined ? [DEFAULT_PRODUCT] : body.products, "products");
  if (!products.length) throw new Error("Select at least one product to export.");
  const unknown = products.filter((id) => !getProduct(id));
  if (unknown.length) throw new Error(`Unknown product id(s): ${unknown.join(", ")}.`);
  const format = body.format === undefined || body.format === null ? "dataset" : String(body.format).toLowerCase();
  if (format !== "dataset" && !EXPORT_FORMATS.includes(format)) {
    throw new Error(`format must be one of ${[...EXPORT_FORMATS, "dataset"].join(", ")}.`);
  }
  for (const key of ["harness", "industry"]) {
    if (body[key] !== undefined && body[key] !== null && typeof body[key] !== "string") throw new Error(`${key} must be a string.`);
  }
  return {
    products,
    harness: body.harness ? String(body.harness) : undefined,
    industry: body.industry ? String(body.industry) : undefined,
    departments: toIdList(body.departments, "departments"),
    format,
    selection: {
      selectedIds: toIdList(body.selectedIds, "selectedIds"),
      requiredIds: toIdList(body.requiredIds, "requiredIds"),
      excludedSubtopics: toIdList(body.excludedSubtopics, "excludedSubtopics"),
    },
  };
}

function relatedNames(list) {
  return (list || []).map((item) => item.name).join("; ");
}

function topicRowOf(topic, concept, harnessLabel) {
  const subtopics = topic.learn?.subtopics || [];
  const known = topic.level ? topic.levelBasis || "declared" : "unknown";
  return {
    type: "topic",
    id: topic.id,
    parentId: "",
    productId: topic.product,
    product: topic.productName,
    groupId: concept.id,
    group: concept.name,
    topic: topic.name,
    subtopic: "",
    level: topic.level || null,
    levelBasis: known,
    minutes: topic.minutes,
    harnesses: harnessLabel(topic),
    availability: topic.availability || "",
    learnStatus: topic.learn?.status && topic.learn.status !== "current" ? topic.learn.status : "",
    thirdParty: Boolean(topic.thirdPartyConnector),
    recommended: Boolean(topic.recommended),
    recommendedWhy: topic.recommended ? (topic.reasons || []).filter((reason) => !/^Required by\s/i.test(reason)).join(" ") : "",
    requires: relatedNames(topic.related?.requires),
    requiredBy: relatedNames(topic.related?.requiredBy),
    urls: httpsUrls(topic.source === "learn" ? topic.learn?.urls?.slice(0, 1) : topic.docUrls),
    source: topic.source === "learn" ? "Microsoft Learn" : "Reviewed catalog",
    subtopicCount: subtopics.length,
  };
}

function subtopicRowOf(parent, sub) {
  const own = sub.level ? sub.levelBasis : null;
  return {
    type: "sub-topic",
    id: sub.id,
    parentId: parent.id,
    productId: parent.productId,
    product: parent.product,
    groupId: parent.groupId,
    group: parent.group,
    topic: parent.topic,
    subtopic: sub.title,
    // A sub-topic with no level of its own takes its topic's level, and says that is an estimate.
    level: sub.level || parent.level,
    levelBasis: own || (parent.level ? "estimated" : "unknown"),
    minutes: sub.minutes,
    harnesses: parent.harnesses,
    availability: sub.availability || parent.availability,
    learnStatus: parent.learnStatus,
    thirdParty: parent.thirdParty,
    recommended: parent.recommended,
    recommendedWhy: parent.recommendedWhy,
    requires: "",
    requiredBy: "",
    urls: httpsUrls([sub.url]),
    source: "Microsoft Learn",
    subtopicCount: 0,
  };
}

/**
 * Build the export dataset.
 *
 * @param {object} options
 * @param {string[]} options.products the products chosen in Step 1
 * @param {string} [options.harness] the Copilot Studio harness chosen in Step 5
 * @param {string} [options.industry] vertical, only for "recommended and why"
 * @param {string[]} [options.departments] departments, only for "recommended and why"
 * @param {object} [options.learn] what Microsoft Learn discovery found (see `recommend`)
 * @param {number} [options.now] clock for the generated date
 */
export function buildTopicExport({ products, harness, industry, departments, learn = {}, now = Date.now() } = {}) {
  const answers = { products, harness, industry, departments };
  const seen = new Map();
  const topics = [];
  let scopeProducts = [];
  let scopeHarness = null;
  const harnessNames = new Map(getHarnesses().map((h) => [h.id, h.name]));
  // A topic whose level is unknown stays in its own concept group here, with a blank level.
  const concepts = new Map(getConcepts().map((concept) => [concept.id, concept]));
  const unknownGroup = (topic) =>
    concepts.get(topic.conceptId) || { id: UNCATEGORIZED, name: "New from Learn: not yet grouped", order: 999 };
  for (const level of LEVELS) {
    const rec = recommend({ ...answers, level }, learn);
    scopeProducts = rec.answers.products;
    scopeHarness = rec.answers.harness;
    const groups = [...rec.concepts.map((concept) => [() => concept, concept.topics]), [(topic) => unknownGroup(topic), rec.levelUnknown.topics]];
    for (const [conceptOf, list] of groups) {
      for (const topic of list) {
        if (seen.has(topic.id)) continue;
        seen.set(topic.id, true);
        topics.push({ topic, concept: conceptOf(topic) });
      }
    }
  }

  const harnessLabel = (topic) => {
    if (!topic.harnesses?.length) return productHasHarnesses(topic.product) ? "All harnesses" : "Not harness-specific";
    return topic.harnesses.map((id) => harnessNames.get(id) || id).join("; ");
  };
  const productOrder = getProducts().map((p) => p.id);
  const rows = [];
  const parents = topics
    .map(({ topic, concept }) => ({ row: topicRowOf(topic, concept, harnessLabel), topic, order: concept.order ?? 999 }))
    .sort(
      (a, b) =>
        productOrder.indexOf(a.row.productId) - productOrder.indexOf(b.row.productId) ||
        a.order - b.order ||
        a.row.group.localeCompare(b.row.group) ||
        (a.row.level || 999) - (b.row.level || 999) ||
        a.row.topic.localeCompare(b.row.topic),
    );
  for (const { row, topic } of parents) {
    rows.push(row);
    for (const sub of topic.learn?.subtopics || []) rows.push(subtopicRowOf(row, sub));
  }

  const counts = { topics: 0, subTopics: 0, rows: rows.length, byProduct: {}, byLevel: {} };
  for (const row of rows) {
    const key = row.type === "topic" ? "topics" : "subTopics";
    counts[key] += 1;
    const product = (counts.byProduct[row.productId] ||= { topics: 0, subTopics: 0 });
    product[key] += 1;
    const level = (counts.byLevel[row.level || "unknown"] ||= { topics: 0, subTopics: 0 });
    level[key] += 1;
  }
  const harnessName = scopeHarness && scopeProducts.some((id) => productHasHarnesses(id)) ? harnessNames.get(scopeHarness) || scopeHarness : null;
  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    generatedAt: new Date(now).toISOString(),
    scope: {
      products: scopeProducts.map((id) => ({ id, name: productName(id), shortName: getProduct(id)?.shortName || productName(id) })),
      harness: scopeHarness || null,
      harnessName,
      allLevels: true,
      industry: industry || null,
      departments: departments || [],
      text: `All topics and sub-topics for ${joinNames(scopeProducts.map((id) => getProduct(id)?.shortName || productName(id)))}${harnessName ? ` (${harnessName})` : ""}, all levels: ${rows.length} rows (${counts.topics} topics, ${counts.subTopics} sub-topics).`,
    },
    counts,
    rows,
  };
}

/** Rows with the "Selected in my lab" and "Required prerequisite" columns filled from a selection. */
export function applySelection(rows, selection = {}) {
  const selected = new Set(selection.selectedIds || []);
  const required = new Set(selection.requiredIds || []);
  const left = new Set(selection.excludedSubtopics || []);
  return rows.map((row) => {
    const isSub = row.type === "sub-topic";
    const picked = isSub ? selected.has(row.parentId) && !left.has(row.id) : selected.has(row.id);
    return { ...row, selected: picked, requiredPrerequisite: !isSub && picked && required.has(row.id) };
  });
}

// ── Serializers ─────────────────────────────────────────────────────────────

const yesNo = (value) => (value ? "Yes" : "No");

/** The text of one cell, before CSV quoting. */
export function cellText(row, key) {
  switch (key) {
    case "level":
      return row.level ? String(row.level) : "";
    case "levelBasis":
      return BASIS_LABEL[row.levelBasis] || "";
    case "minutes":
      return row.minutes ? String(row.minutes) : "";
    case "availability":
      return AVAILABILITY_LABEL[row.availability] || "";
    case "learnStatus":
      return LEARN_STATUS_LABEL[row.learnStatus] || "";
    case "thirdParty":
    case "requiredPrerequisite":
    case "recommended":
    case "selected":
      return yesNo(row[key]);
    case "urls":
      return (row.urls || []).join(" ");
    case "type":
      return row.type === "topic" ? "Topic" : "Sub-topic";
    default:
      return clean(row[key]);
  }
}

/** A cell that starts with =, +, -, @, a tab, or a carriage return is read as a formula by Excel; a leading apostrophe makes it text. */
export function protectFormula(text) {
  return /^[\t\r]|^\s*[=+\-@]/.test(text) ? `'${text}` : text;
}

export function csvField(text) {
  const safe = protectFormula(String(text));
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** UTF-8 with a byte order mark, comma separated, CRLF line endings: opens in Excel with accents intact. */
export function toCsv(dataset, selection = {}) {
  const rows = applySelection(dataset.rows, selection);
  const lines = [EXPORT_COLUMNS.map(([, header]) => csvField(header)).join(",")];
  for (const row of rows) lines.push(EXPORT_COLUMNS.map(([key]) => csvField(cellText(row, key))).join(","));
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

function mdText(value) {
  return clean(value).replace(/[\\`*_{}[\]<>|#]/g, "\\$&");
}

function mdUrl(url) {
  return String(url).replace(/[()\s]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

function mdFacts(row) {
  const facts = [];
  if (row.level) facts.push(`Level ${row.level}${row.levelBasis === "estimated" ? " (estimated)" : ""}`);
  if (row.minutes) facts.push(`about ${row.minutes} min`);
  if (AVAILABILITY_LABEL[row.availability]) facts.push(AVAILABILITY_LABEL[row.availability]);
  if (LEARN_STATUS_LABEL[row.learnStatus]) facts.push(LEARN_STATUS_LABEL[row.learnStatus]);
  if (row.thirdParty) facts.push("optional 3rd-party connector");
  if (row.requiredPrerequisite) facts.push("required prerequisite");
  if (row.recommended && row.type === "topic") facts.push(`recommended${row.recommendedWhy ? `: ${row.recommendedWhy}` : ""}`);
  if (row.type === "topic") {
    if (row.requires) facts.push(`requires ${row.requires}`);
    if (row.requiredBy) facts.push(`required by ${row.requiredBy}`);
  }
  facts.push(`selected in my lab: ${row.selected ? "yes" : "no"}`);
  return facts.map(mdText).join("; ");
}

/** A grouped outline: product, then topic group, then each topic with its sub-topics nested beneath it. */
export function toMarkdown(dataset, selection = {}) {
  const rows = applySelection(dataset.rows, selection);
  const lines = [`# Topic export: ${mdText(joinNames(dataset.scope.products.map((p) => p.shortName)))}`, "", mdText(dataset.scope.text), "", `Generated ${dataset.generatedAt.slice(0, 10)}.`];
  let product = null;
  let group = null;
  for (const row of rows) {
    if (row.productId !== product) {
      product = row.productId;
      group = null;
      lines.push("", `## ${mdText(row.product)}`);
    }
    if (row.groupId !== group) {
      group = row.groupId;
      lines.push("", `### ${mdText(row.group)}`, "");
    }
    const name = row.type === "topic" ? row.topic : row.subtopic;
    const label = row.urls[0] ? `[${mdText(name)}](${mdUrl(row.urls[0])})` : mdText(name);
    lines.push(`${row.type === "topic" ? "-" : "  -"} ${row.type === "topic" ? "" : "Sub-topic: "}${label} - ${mdFacts(row)}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Structured JSON: product, then topic group, then topic with its `subTopics`. */
export function toJson(dataset, selection = {}) {
  const rows = applySelection(dataset.rows, selection);
  const products = [];
  const leaf = (row) => ({
    id: row.id,
    name: row.type === "topic" ? row.topic : row.subtopic,
    type: row.type,
    level: row.level,
    levelBasis: row.levelBasis,
    approxMinutes: row.minutes || null,
    harnesses: row.harnesses,
    availability: row.availability || null,
    learnStatus: row.learnStatus || null,
    optionalThirdPartyConnector: Boolean(row.thirdParty),
    requiredPrerequisite: Boolean(row.requiredPrerequisite),
    recommended: Boolean(row.recommended),
    recommendedWhy: row.recommendedWhy || null,
    prerequisites: row.requires,
    requiredBy: row.requiredBy,
    urls: row.urls,
    source: row.source,
    selected: Boolean(row.selected),
  });
  let topic = null;
  for (const row of rows) {
    let productEntry = products.find((entry) => entry.id === row.productId);
    if (!productEntry) products.push((productEntry = { id: row.productId, name: row.product, groups: [] }));
    let groupEntry = productEntry.groups.find((entry) => entry.id === row.groupId);
    if (!groupEntry) productEntry.groups.push((groupEntry = { id: row.groupId, name: row.group, topics: [] }));
    if (row.type === "topic") {
      topic = { ...leaf(row), subTopics: [] };
      groupEntry.topics.push(topic);
    } else if (topic && topic.id === row.parentId) {
      topic.subTopics.push(leaf(row));
    }
  }
  return `${JSON.stringify({ schemaVersion: dataset.schemaVersion, generatedAt: dataset.generatedAt, scope: dataset.scope, counts: dataset.counts, products }, null, 2)}\n`;
}

export function serialize(format, dataset, selection) {
  if (format === "csv") return toCsv(dataset, selection);
  if (format === "markdown") return toMarkdown(dataset, selection);
  return toJson(dataset, selection);
}

export const EXPORT_MIME = { csv: "text/csv; charset=utf-8", markdown: "text/markdown; charset=utf-8", json: "application/json; charset=utf-8" };
export const EXPORT_EXTENSION = { csv: "csv", markdown: "md", json: "json" };

/** `all-topics-copilot-studio-sharepoint-ai-2026-11-18.csv` */
export function exportFileName(dataset, format) {
  const slug = dataset.scope.products.map((p) => p.id).join("-").replace(/[^a-z0-9-]+/g, "-").slice(0, 80);
  return `all-topics-${slug}-${dataset.generatedAt.slice(0, 10)}.${EXPORT_EXTENSION[format] || "json"}`;
}
