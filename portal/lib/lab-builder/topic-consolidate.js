/**
 * Consolidation and alias resolution for Microsoft Learn topics.
 *
 * Microsoft Learn often splits a single Copilot Studio capability across an
 * overview or conceptual article and a procedural how-to or examples article
 * (for example, `/mcp-certification` "Microsoft MCP server certification
 * overview (preview)" alongside `/mcp-server-certification` "Microsoft MCP
 * server certification"). Surfacing each page as its own Step 6 card creates
 * duplicate topics in the wizard and splits grounding context across cards.
 *
 * This module:
 *   1. Recognizes Microsoft Learn include-banner boilerplate so preview and
 *      billing disclaimers never overwrite real article summaries.
 *   2. Syncs catalog `docUrls` coverage on cached snapshots so companion pages
 *      folded into curated features stop appearing as separate "New from Learn"
 *      cards even before the next live refresh.
 *   3. Merges duplicate and overview-plus-detail Learn topics (within the same
 *      product and compatible harnesses) into one canonical topic whose `urls`
 *      and `subtopics` list every merged page (nothing is truncated; a group
 *      beyond `MAX_SUBTOPICS` is split into more than one topic), keeping
 *      `urls[0]` aligned with `topic.id` so `validateSnapshot()` invariants hold.
 *   4. Resolves legacy or merged `learn-*` IDs back to their canonical topic or
 *      covering catalog feature so saved selections and API requests keep working.
 *
 * Kept free of imports from `catalog.js` and `topic-store.js` so both can call
 * into it without circular dependencies.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readCatalogFile } from "./catalog-source.js";
import { DEFAULT_PRODUCT, productOf } from "./products.js";
import { MAX_SUMMARY, MAX_TITLE, cleanText, matchKey, normalizeLearnUrl, topicId } from "./topic-sanitize.js";
import { AVAILABILITY_VALUES, DEFAULT_HARNESS_IDS, MAX_SUBTOPICS, SUBTOPIC_LEVELS, listHash } from "./topic-snapshot.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UNCATEGORIZED = "uncategorized";

/**
 * Paragraph patterns from Microsoft Learn include-banners and chrome that
 * appear above an article's real lead summary.
 *
 * Note: the Copilot Studio `[!INCLUDE [preview-banner]]` expands to three
 * separate paragraphs ("This article contains ... preview documentation...",
 * "Preview features aren't meant for production use...", and "If you're
 * building a production-ready agent, see..."). All three must be skipped so
 * `parsePage()` reaches the actual opening paragraph of the article.
 */
export const BOILERPLATE_SUMMARY_PATTERNS = [
  /^(?:in this article|applies to|table of contents|prerequisites|next steps|related content|see also|feedback|choose a tab|select a tab)\b/i,
  /^\[!?(?:include|div|note|tip|important|warning|caution)\b/i,
  /^(?:last updated|article\s*[•·])/i,
  /^this article (?:contains|is|describes)\b[\s\S]{0,160}\b(?:preview|prerelease) documentation\b/i,
  /^preview features aren['’]t meant for production use\b/i,
  /^if you['’]re building a production-ready agent,\s*see\b/i,
  /^the harness used to build this (?:agent|workflow|automation|solution) uses usage-based billing\b/i,
  /^this article includes information about azure bot service skills\b[\s\S]{0,260}\bshouldn['’]t be confused with agentic skills\b/i,
];

const PLACEHOLDER_SUMMARY_RE = /:\s*see the linked microsoft learn article\.?$/i;

export function isBoilerplateSummary(text) {
  const s = String(text || "").trim();
  if (!s) return true;
  if (PLACEHOLDER_SUMMARY_RE.test(s)) return true;
  return BOILERPLATE_SUMMARY_PATTERNS.some((re) => re.test(s));
}

/** Normalize a Learn URL for cross-harness rename matching (matches `topic-discovery.js`). */
export function urlMatchKey(rawUrl) {
  const normalized = normalizeLearnUrl(rawUrl);
  if (!normalized) return null;
  return matchKey(normalized).replace("/m365-copilot-harness/", "/agents-experience/");
}

/**
 * Curated companion groups of Microsoft Learn pages that teach one combined
 * topic. Within each group, URLs are ordered with the canonical primary URL
 * first (`urls[0]`), followed by overview, configuration, or examples pages.
 */
export const COMPANION_URL_GROUPS = [
  [
    "https://learn.microsoft.com/microsoft-copilot-studio/mcp-server-certification",
    "https://learn.microsoft.com/microsoft-copilot-studio/mcp-certification",
  ],
  [
    "https://learn.microsoft.com/microsoft-copilot-studio/code-interpreter-for-prompts",
    "https://learn.microsoft.com/microsoft-copilot-studio/code-interpreter-prompts-examples",
  ],
  [
    "https://learn.microsoft.com/microsoft-copilot-studio/authoring-trigger-event",
    "https://learn.microsoft.com/microsoft-copilot-studio/authoring-triggers-about",
  ],
  [
    "https://learn.microsoft.com/microsoft-copilot-studio/agents-experience/copilot-studio-mcp",
    "https://learn.microsoft.com/microsoft-copilot-studio/agents-experience/copilot-studio-mcp-configure",
    "https://learn.microsoft.com/microsoft-copilot-studio/agents-experience/copilot-studio-mcp-vscode-copilot-cli",
  ],
  [
    "https://learn.microsoft.com/microsoft-copilot-studio/configuration-add-skills",
    "https://learn.microsoft.com/microsoft-copilot-studio/advanced-use-skills",
  ],
  [
    "https://learn.microsoft.com/microsoft-copilot-studio/advanced-hand-off",
    "https://learn.microsoft.com/microsoft-copilot-studio/configure-generic-handoff",
  ],
  [
    "https://learn.microsoft.com/microsoft-copilot-studio/knowledge-copilot-connectors",
    "https://learn.microsoft.com/microsoft-copilot-studio/knowledge-graph-vs-power-platform-connectors",
  ],
  [
    "https://learn.microsoft.com/microsoft-copilot-studio/analytics-transcripts-studio",
    "https://learn.microsoft.com/microsoft-copilot-studio/analytics-transcripts-powerapps",
  ],
];

const GROUP_BY_URL_KEY = new Map();
COMPANION_URL_GROUPS.forEach((urls, groupIndex) => {
  urls.forEach((url, rank) => {
    const key = urlMatchKey(url);
    if (key) GROUP_BY_URL_KEY.set(key, { groupIndex, rank, urls });
  });
});

let cachedStaticCatalog = null;

function loadStaticCatalog() {
  if (cachedStaticCatalog) return cachedStaticCatalog;
  const catalogDoc = readCatalogFile(path.join(__dirname, "features.json"));
  const conceptsDoc = JSON.parse(fs.readFileSync(path.join(__dirname, "concepts.json"), "utf8"));
  cachedStaticCatalog = {
    version: catalogDoc.version || null,
    features: catalogDoc.features || [],
    concepts: conceptsDoc.concepts || [],
  };
  return cachedStaticCatalog;
}

function hashHex(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function topicProduct(topic) {
  return topic?.product || DEFAULT_PRODUCT;
}

/**
 * True only when `topic.id` is derived from `topic.urls[0]`. Hand-crafted unit
 * test fixtures sometimes reuse a placeholder URL across distinct synthetic IDs
 * (`learn-at-100`, `learn-at-200`), and those must never be merged or rewritten.
 */
function isCanonicalLearnTopic(topic) {
  if (!topic || typeof topic.id !== "string" || !Array.isArray(topic.urls) || !topic.urls.length) return false;
  const primaryUrl = normalizeLearnUrl(topic.urls[0]);
  if (!primaryUrl) return false;
  return topicId(primaryUrl) === topic.id;
}

function sameHarnesses(a = [], b = []) {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  return b.every((h) => setA.has(h));
}

function mergeHarnesses(lists) {
  const present = new Set(lists.flat());
  const ordered = DEFAULT_HARNESS_IDS.filter((h) => present.has(h));
  for (const h of present) if (!ordered.includes(h)) ordered.push(h);
  return ordered;
}

const COMPANION_TITLE_RE = /\b(?:overview|introduction|intro|what\s+is|about|examples?|key\s+concepts)\b/i;
const COMPANION_SLUG_RE = /(?:^|-)(?:overview|about|intro|introduction|what-is|examples?|key-concepts)(?:-|$)/i;

/** True when a topic's title or URL slug marks it as an overview, about, intro, or examples companion page. */
export function isCompanionVariant(topic) {
  const title = String(topic?.title || "");
  const url = String(topic?.urls?.[0] || "");
  const slug = url.split("/").pop() || "";
  return COMPANION_TITLE_RE.test(title) || COMPANION_SLUG_RE.test(slug);
}

const TITLE_NOISE_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "by",
  "for",
  "from",
  "how",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
  "your",
  "microsoft",
  "copilot",
  "studio",
  "overview",
  "introduction",
  "intro",
  "what",
  "about",
  "example",
  "examples",
  "concept",
  "concepts",
  "key",
  "preview",
  "prerelease",
  "deprecated",
  "retired",
]);

const LEADING_ACTION_VERBS = new Set([
  "add",
  "configure",
  "connect",
  "enable",
  "extend",
  "get",
  "learn",
  "manage",
  "set",
  "understand",
  "use",
  "work",
]);

function stemWord(word) {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith("es") && /(?:shes|ches|xes|zes|ses)$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

function normalizedTitleStem(title, { stripLeadingVerb = false } = {}) {
  const cleaned = String(title || "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\bmodel context protocol\s*\(?\s*mcp\s*\)?/g, "mcp")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  let words = cleaned ? cleaned.split(/\s+/) : [];
  if (stripLeadingVerb && words.length > 2 && LEADING_ACTION_VERBS.has(words[0])) {
    words = words.slice(1);
    if (words[0] === "up") words = words.slice(1);
  }
  const filtered = words
    .map(stemWord)
    .filter((w) => w.length >= 2 && !TITLE_NOISE_WORDS.has(w));
  return [...new Set(filtered)].sort();
}

const SLUG_PREFIX_RE = /^(?:authoring|configuration|advanced|fundamentals|guidance|administration|admin)-/;
const SLUG_NOISE_WORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "from",
  "in",
  "of",
  "on",
  "the",
  "to",
  "with",
  "overview",
  "about",
  "intro",
  "introduction",
  "what",
  "is",
  "example",
  "examples",
  "add",
  "configure",
  "use",
]);

function normalizedSlugStem(url) {
  const slug = (String(url || "").toLowerCase().split("/").pop() || "").replace(SLUG_PREFIX_RE, "");
  const words = slug
    .split(/[^a-z0-9]+/)
    .map(stemWord)
    .filter((w) => w.length >= 2 && !SLUG_NOISE_WORDS.has(w));
  return [...new Set(words)].sort();
}

function sameTokenSet(a, b) {
  return a.length >= 2 && a.length === b.length && a.every((token, index) => token === b[index]);
}

/**
 * Conservative heuristic for newly discovered Learn pages not yet listed in
 * `COMPANION_URL_GROUPS`: merges two `new` topics in the same product, harness
 * scope, and concept only when one is an explicit overview/about/examples
 * companion of the exact same multi-word subject stem.
 */
function shouldAutoMergeTopics(a, b) {
  if (topicProduct(a) !== topicProduct(b)) return false;
  if (!sameHarnesses(a.harnesses || [], b.harnesses || [])) return false;
  if (
    a.conceptId !== b.conceptId &&
    a.conceptId !== UNCATEGORIZED &&
    b.conceptId !== UNCATEGORIZED
  ) {
    return false;
  }

  const aCompanion = isCompanionVariant(a);
  const bCompanion = isCompanionVariant(b);
  if (!aCompanion && !bCompanion) return false;

  const aStrict = normalizedTitleStem(a.title, { stripLeadingVerb: false });
  const bStrict = normalizedTitleStem(b.title, { stripLeadingVerb: false });
  if (sameTokenSet(aStrict, bStrict)) return true;

  // Allow "Event trigger overview" <-> "Add an event trigger" when one side is an overview/companion.
  if (aCompanion !== bCompanion) {
    const aRelaxed = normalizedTitleStem(a.title, { stripLeadingVerb: !aCompanion });
    const bRelaxed = normalizedTitleStem(b.title, { stripLeadingVerb: !bCompanion });
    if (sameTokenSet(aRelaxed, bRelaxed)) return true;
  }

  const aSlug = normalizedSlugStem(a.urls?.[0]);
  const bSlug = normalizedSlugStem(b.urls?.[0]);
  if (sameTokenSet(aSlug, bSlug)) return true;

  return false;
}

function rankPrimaryCandidate(topic, explicitRank = null) {
  if (explicitRank !== null && explicitRank !== undefined) {
    return [0, explicitRank, 0, 0, topic.id];
  }
  const companionPenalty = isCompanionVariant(topic) ? 1 : 0;
  const availabilityPenalty = topic.availability === "retired" ? 2 : topic.availability === "preview" ? 1 : 0;
  const boilerplatePenalty = isBoilerplateSummary(topic.summary) ? 1 : 0;
  const urlLength = String(topic.urls?.[0] || "").length;
  return [1, companionPenalty, availabilityPenalty, boilerplatePenalty, urlLength, topic.id];
}

function compareRanks(ra, rb) {
  const len = Math.min(ra.length, rb.length);
  for (let i = 0; i < len; i += 1) {
    if (ra[i] === rb[i]) continue;
    return ra[i] < rb[i] ? -1 : 1;
  }
  return 0;
}

function pickSummary(orderedTopics) {
  const clean = orderedTopics.find((t) => !isBoilerplateSummary(t.summary));
  if (clean) return cleanText(clean.summary, MAX_SUMMARY);
  const nonEmpty = orderedTopics.find((t) => typeof t.summary === "string" && t.summary.trim());
  if (nonEmpty) return cleanText(nonEmpty.summary, MAX_SUMMARY);
  return `${orderedTopics[0].title}: see the linked Microsoft Learn article.`;
}

function minDate(dates) {
  const valid = dates.filter((d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  return valid[0] || "1970-01-01";
}

function maxDate(dates) {
  const valid = dates.filter((d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  return valid.length ? valid[valid.length - 1] : null;
}

function standaloneFromSubtopic(parent, sub) {
  const level = SUBTOPIC_LEVELS.includes(sub.level) ? sub.level : parent.level;
  return {
    id: sub.id,
    title: cleanText(sub.title || sub.id, MAX_TITLE),
    ...(parent.product ? { product: parent.product } : {}),
    summary: sub.summary ? cleanText(sub.summary, MAX_SUMMARY) : `${cleanText(sub.title || sub.id, MAX_TITLE)}: see the linked Microsoft Learn article.`,
    urls: [sub.url],
    harnesses: [...(parent.harnesses || [])],
    conceptId: parent.conceptId || UNCATEGORIZED,
    availability: AVAILABILITY_VALUES.includes(sub.availability) ? sub.availability : parent.availability ?? null,
    status: "new",
    featureIds: [],
    ...(level !== undefined ? { level } : {}),
    firstSeen: parent.firstSeen,
    lastSeen: parent.lastSeen,
    changedAt: parent.changedAt ?? null,
    contentHash: hashHex(`${sub.id}:${sub.url}`),
  };
}

/**
 * Merge a group of related Learn topics into one primary topic whose companion pages become sub-topics.
 * Returns the merged topic first. A group that holds more pages than a topic may carry (`MAX_URLS`) is split:
 * the extra pages come back as standalone topics, so no page is ever dropped.
 */
function mergeGroup(members, explicitGroupIndex = null) {
  if (members.length === 1) return [members[0]];

  const ranked = [...members].sort((a, b) => {
    const rankA =
      explicitGroupIndex !== null
        ? GROUP_BY_URL_KEY.get(urlMatchKey(a.urls?.[0]))?.rank ?? 99
        : null;
    const rankB =
      explicitGroupIndex !== null
        ? GROUP_BY_URL_KEY.get(urlMatchKey(b.urls?.[0]))?.rank ?? 99
        : null;
    return compareRanks(rankPrimaryCandidate(a, rankA), rankPrimaryCandidate(b, rankB));
  });

  const primary = ranked[0];
  const companions = ranked.slice(1);

  const seenUrlKeys = new Set();
  const mergedUrls = [];
  const subtopicMap = new Map();

  const pushUrl = (rawUrl) => {
    const url = normalizeLearnUrl(rawUrl);
    const key = urlMatchKey(url);
    if (!url || !key || seenUrlKeys.has(key)) return null;
    seenUrlKeys.add(key);
    mergedUrls.push(url);
    return url;
  };

  pushUrl(primary.urls[0]);

  const registerSubtopic = (sub) => {
    const url = pushUrl(sub.url);
    if (!url) return;
    const id = topicId(url);
    if (!id || id === primary.id || subtopicMap.has(id)) return;
    const title = cleanText(sub.title || id, MAX_TITLE);
    const summary = !isBoilerplateSummary(sub.summary) ? cleanText(sub.summary, MAX_SUMMARY) : "";
    subtopicMap.set(id, {
      id,
      title,
      url,
      ...(summary ? { summary } : {}),
      ...(SUBTOPIC_LEVELS.includes(sub.level) ? { level: sub.level } : {}),
      ...(AVAILABILITY_VALUES.includes(sub.availability) ? { availability: sub.availability } : {}),
    });
  };
  const companionPage = (comp) => ({
    url: comp.urls[0],
    title: comp.title,
    summary: comp.summary,
    level: comp.level,
    availability: comp.availability,
  });

  for (const existingSub of primary.subtopics || []) registerSubtopic(existingSub);
  for (const extraUrl of primary.urls.slice(1)) {
    if (!seenUrlKeys.has(urlMatchKey(extraUrl))) {
      registerSubtopic({ url: extraUrl, title: primary.title, summary: "" });
    }
  }
  for (const comp of companions) {
    registerSubtopic(companionPage(comp));
    for (const existingSub of comp.subtopics || []) registerSubtopic(existingSub);
    for (const extraUrl of comp.urls.slice(1)) {
      if (!seenUrlKeys.has(urlMatchKey(extraUrl))) {
        registerSubtopic({ url: extraUrl, title: comp.title, summary: "" });
      }
    }
  }

  const conceptId =
    primary.conceptId && primary.conceptId !== UNCATEGORIZED
      ? primary.conceptId
      : companions.find((c) => c.conceptId && c.conceptId !== UNCATEGORIZED)?.conceptId || UNCATEGORIZED;

  const validLevels = new Set([100, 200, 300]);
  const level = validLevels.has(primary.level)
    ? primary.level
    : companions.find((c) => validLevels.has(c.level))?.level;

  const allSubtopics = [...subtopicMap.values()];
  const subtopics = allSubtopics.slice(0, MAX_SUBTOPICS);
  const keptUrls = new Set([mergedUrls[0], ...subtopics.map((s) => s.url)]);
  const combinedHash = hashHex(
    ranked
      .map((t) => `${t.id}:${t.contentHash || ""}`)
      .sort()
      .join("|"),
  );

  const merged = {
    ...primary,
    title: cleanText(primary.title, MAX_TITLE),
    summary: pickSummary(ranked),
    urls: mergedUrls.filter((url) => keptUrls.has(url)),
    ...(subtopics.length ? { subtopics } : {}),
    harnesses: mergeHarnesses(ranked.map((t) => t.harnesses || [])),
    conceptId,
    availability: primary.availability ?? null,
    ...(level !== undefined ? { level } : {}),
    firstSeen: minDate(ranked.map((t) => t.firstSeen)),
    lastSeen: maxDate(ranked.map((t) => t.lastSeen)) || primary.lastSeen,
    changedAt: maxDate(ranked.map((t) => t.changedAt)),
    contentHash: combinedHash,
  };
  if (!subtopics.length) delete merged.subtopics;
  const overflow = allSubtopics.slice(MAX_SUBTOPICS).map((sub) => standaloneFromSubtopic(merged, sub));
  return [merged, ...overflow];
}

function buildCatalogCoverageIndex(features, concepts) {
  const byUrlKey = new Map();
  const conceptByFeature = new Map(
    (concepts || []).flatMap((c) => (c.features || []).map((id) => [id, c.id])),
  );
  for (const feature of features || []) {
    const product = productOf(feature);
    for (const raw of feature.docUrls || []) {
      const key = urlMatchKey(raw);
      if (!key) continue;
      const bucket = byUrlKey.get(key) || { byProduct: new Map() };
      const prodEntry = bucket.byProduct.get(product) || { featureIds: new Set(), conceptId: null };
      prodEntry.featureIds.add(feature.id);
      if (!prodEntry.conceptId && conceptByFeature.has(feature.id)) {
        prodEntry.conceptId = conceptByFeature.get(feature.id);
      }
      bucket.byProduct.set(product, prodEntry);
      byUrlKey.set(key, bucket);
    }
  }
  return byUrlKey;
}

/**
 * Consolidate duplicate and overview-companion Learn topics and (when enabled)
 * sync catalog `docUrls` coverage. Pure and idempotent.
 */
export function consolidateTopics(
  topics = [],
  { catalogFeatures, catalogConcepts, syncCatalogCoverage = false } = {},
) {
  if (!Array.isArray(topics) || !topics.length) return [];

  let coverageIndex = null;
  if (syncCatalogCoverage || Array.isArray(catalogFeatures)) {
    const fallback = !catalogFeatures || !catalogConcepts ? loadStaticCatalog() : null;
    coverageIndex = buildCatalogCoverageIndex(
      catalogFeatures || fallback.features,
      catalogConcepts || fallback.concepts,
    );
  }

  // 1. Sync catalog docUrls coverage on canonical Learn topics when requested. A merged topic is judged by its
  // own (primary) page: when the catalog covers that page, the sub-topics the catalog does not cover leave the
  // merged topic as standalone topics instead of vanishing with it.
  const prepared = topics.flatMap((raw) => {
    const topic = {
      ...raw,
      ...(typeof raw.summary === "string" && raw.summary.length > MAX_SUMMARY
        ? { summary: cleanText(raw.summary, MAX_SUMMARY) }
        : {}),
      urls: Array.isArray(raw.urls) ? [...raw.urls] : [],
      harnesses: Array.isArray(raw.harnesses) ? [...raw.harnesses] : [],
      ...(Array.isArray(raw.featureIds) ? { featureIds: [...raw.featureIds] } : {}),
      ...(Array.isArray(raw.subtopics) ? { subtopics: raw.subtopics.map((s) => ({ ...s })) } : {}),
    };
    const released = [];
    if (coverageIndex && isCanonicalLearnTopic(topic)) {
      const product = topicProduct(topic);
      const matchedFeatures = new Set(topic.featureIds || []);
      let matchedConcept = null;
      const hitFor = (url) => coverageIndex.get(urlMatchKey(url))?.byProduct.get(product);
      for (const url of topic.subtopics?.length ? [topic.urls[0]] : topic.urls) {
        const hit = hitFor(url);
        if (!hit) continue;
        for (const id of hit.featureIds) matchedFeatures.add(id);
        if (!matchedConcept && hit.conceptId) matchedConcept = hit.conceptId;
      }
      if (matchedFeatures.size > 0) {
        topic.status = "covered";
        topic.featureIds = [...matchedFeatures].sort();
        if ((!topic.conceptId || topic.conceptId === UNCATEGORIZED) && matchedConcept) {
          topic.conceptId = matchedConcept;
        }
        for (const sub of topic.subtopics || []) {
          if (!hitFor(sub.url)) released.push(standaloneFromSubtopic(raw, sub));
        }
        if (topic.subtopics) topic.urls = [topic.urls[0]];
        delete topic.subtopics;
      }
    }
    return [topic, ...released];
  });

  // 2. Partition into mergeable (`new` canonical Learn topics) vs pass-through.
  const passthrough = [];
  const candidates = [];
  for (const topic of prepared) {
    if (topic.status === "new" && isCanonicalLearnTopic(topic)) {
      candidates.push(topic);
    } else {
      passthrough.push(topic);
    }
  }

  if (candidates.length <= 1) {
    return [...passthrough, ...candidates].sort((a, b) => a.id.localeCompare(b.id));
  }

  // Union-Find over `candidates` indices.
  const parent = candidates.map((_, idx) => idx);
  const explicitGroupOfRoot = new Map();

  const find = (i) => {
    let cur = i;
    while (parent[cur] !== cur) {
      parent[cur] = parent[parent[cur]];
      cur = parent[cur];
    }
    return cur;
  };

  const union = (i, j, groupIndex = null) => {
    const ri = find(i);
    const rj = find(j);
    if (ri === rj) {
      if (groupIndex !== null) explicitGroupOfRoot.set(ri, groupIndex);
      return;
    }
    parent[rj] = ri;
    const inherited = groupIndex ?? explicitGroupOfRoot.get(ri) ?? explicitGroupOfRoot.get(rj) ?? null;
    if (inherited !== null) explicitGroupOfRoot.set(ri, inherited);
  };

  // 2a. Explicit curated companion URL groups (within same product and compatible harnesses).
  const byExplicitGroup = new Map();
  candidates.forEach((topic, idx) => {
    for (const url of topic.urls) {
      const info = GROUP_BY_URL_KEY.get(urlMatchKey(url));
      if (!info) continue;
      const key = `${topicProduct(topic)}:${info.groupIndex}`;
      const list = byExplicitGroup.get(key) || [];
      if (!list.includes(idx)) list.push(idx);
      byExplicitGroup.set(key, list);
      explicitGroupOfRoot.set(find(idx), info.groupIndex);
    }
  });
  for (const [, indices] of byExplicitGroup) {
    for (let k = 1; k < indices.length; k += 1) {
      const first = candidates[indices[0]];
      const next = candidates[indices[k]];
      if (
        sameHarnesses(first.harnesses, next.harnesses) ||
        first.harnesses.some((h) => next.harnesses.includes(h))
      ) {
        const info = GROUP_BY_URL_KEY.get(urlMatchKey(first.urls[0]));
        union(indices[0], indices[k], info?.groupIndex ?? null);
      }
    }
  }

  // 2b. Conservative overview/companion stem heuristic for future Learn topics.
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      if (find(i) === find(j)) continue;
      if (shouldAutoMergeTopics(candidates[i], candidates[j])) {
        union(i, j);
      }
    }
  }

  const buckets = new Map();
  candidates.forEach((topic, idx) => {
    const root = find(idx);
    const list = buckets.get(root) || [];
    list.push(topic);
    buckets.set(root, list);
  });

  const mergedNew = [];
  for (const [root, members] of buckets) {
    const explicitIdx = explicitGroupOfRoot.get(root) ?? null;
    mergedNew.push(...mergeGroup(members, explicitIdx));
  }

  return [...passthrough, ...mergedNew].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Consolidate a full snapshot object and recompute `listHash` so `validateSnapshot`
 * continues to pass on legacy cached snapshots loaded from disk.
 */
export function consolidateSnapshot(snapshot, options = {}) {
  if (!snapshot || typeof snapshot !== "object" || !Array.isArray(snapshot.topics)) return snapshot;
  const syncCatalogCoverage =
    options.syncCatalogCoverage !== undefined
      ? Boolean(options.syncCatalogCoverage)
      : snapshot.catalogVersion !== "test";
  const topics = consolidateTopics(snapshot.topics, { ...options, syncCatalogCoverage });
  const next = { ...snapshot, topics };
  if (typeof snapshot.listHash === "string") {
    next.listHash = listHash(next);
  }
  return next;
}

/**
 * Resolve a potentially merged or catalog-covered `learn-*` topic ID to its
 * active canonical ID.
 *
 * Resolution order:
 *   1. Exact match on a `status: "new"` topic ID -> returns that ID.
 *   2. Match on `subtopic.id` of a consolidated `status: "new"` topic -> returns
 *      the consolidated parent topic's ID.
 *   3. Match on a `COMPANION_URL_GROUPS` companion URL whose primary topic is
 *      active in `topics` -> returns the primary topic's ID.
 *   4. (When `allowCoveredFeature` is true) Match on a `status: "covered"` topic
 *      with `featureIds` -> returns the best matching catalog feature ID (preferring
 *      `harness` when supplied).
 *   5. Otherwise returns `null`.
 */
export function resolveTopicAlias(
  id,
  { topics = [], harness = null, allowCoveredFeature = false, catalogFeatures = null } = {},
) {
  if (typeof id !== "string" || !id.startsWith("learn-")) return null;

  const newTopics = topics.filter((t) => t?.status === "new");
  const direct = newTopics.find((t) => t.id === id);
  if (direct) return direct.id;

  for (const topic of newTopics) {
    if ((topic.subtopics || []).some((sub) => sub.id === id)) {
      return topic.id;
    }
    for (const url of (topic.urls || []).slice(1)) {
      const normalized = normalizeLearnUrl(url);
      if (normalized && topicId(normalized) === id) {
        return topic.id;
      }
    }
  }

  // Check explicit companion groups in case the caller holds an unmerged topic list.
  for (const group of COMPANION_URL_GROUPS) {
    const matchesGroup = group.some((url) => topicId(url) === id);
    if (!matchesGroup) continue;
    for (const url of group) {
      const candidateId = topicId(url);
      const active = newTopics.find((t) => t.id === candidateId);
      if (active) return active.id;
    }
  }

  if (allowCoveredFeature) {
    const covered = topics.find((t) => t?.status === "covered" && t.id === id && t.featureIds?.length);
    if (covered) {
      if (harness) {
        const features = catalogFeatures || loadStaticCatalog().features;
        const byHarness = covered.featureIds.find((fid) =>
          features.find((f) => f.id === fid)?.harness?.includes(harness),
        );
        if (byHarness) return byHarness;
      }
      return covered.featureIds[0];
    }
  }

  return null;
}
