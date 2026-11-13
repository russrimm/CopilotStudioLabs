/**
 * Topic discovery: enumerate the current Copilot Studio documentation on
 * Microsoft Learn and compare it with the static catalog.
 *
 * The walk starts at the documentation hub and the harness overview pages,
 * follows their links, runs targeted searches for each concept, and reads each
 * page once. Every page contributes a title, a summary, availability when the
 * page states it, and a content hash so a later run can tell what changed.
 *
 * Each discovered topic is classified against the catalog:
 *   covered  its page is one of a catalog feature's documentation pages
 *   new      it is not in the catalog; the wizard offers it as "New from Learn"
 * and each catalog feature is checked the other way round:
 *   stale    every one of its documentation pages is gone from Learn
 *   updated  a page it cites changed since the last run
 *
 * Everything fetched is untrusted text. It is sanitized and capped on the way
 * in (see topic-sanitize.js) and is only ever stored and displayed as data.
 * The run has a call budget and a deadline; if either runs out the result is
 * flagged `partial` and earlier topics are carried forward instead of dropped.
 * A run that cannot reach Learn at all throws, so a failure is never stored.
 */

import {
  LEARN_HOST,
  MAX_SUMMARY,
  MAX_TITLE,
  cleanText,
  contentHash,
  isCopilotStudioDoc,
  matchKey,
  normalizeLearnUrl,
  topicId,
} from "./topic-sanitize.js";
import { DEFAULT_HARNESS_IDS, SNAPSHOT_SCHEMA_VERSION, UNCATEGORIZED, listHash } from "./topic-snapshot.js";

export const LEARN_DOCS_HUB = `https://${LEARN_HOST}/en-us/microsoft-copilot-studio/`;

const SEEDS = [
  LEARN_DOCS_HUB,
  `https://${LEARN_HOST}/microsoft-copilot-studio/harnesses-overview`,
  `https://${LEARN_HOST}/microsoft-copilot-studio/agents-experience/overview`,
  `https://${LEARN_HOST}/microsoft-copilot-studio/agents-experience/overview-customer-conversation`,
];

const CUSTOMER_CONVERSATION_QUERIES = [
  "Copilot Studio Customer Conversation harness overview",
  "Copilot Studio Customer Assist Agent build a new agent Customer Conversation harness",
  "Copilot Studio Customer Conversation harness deploy agent voice chat",
  "Copilot Studio Customer Conversation harness evaluate and monitor",
];

export const DEFAULT_LIMITS = {
  maxCalls: 500,
  maxTopicPages: 250,
  maxTopics: 400,
  concurrency: 4,
  deadlineMs: 4 * 60000,
  maxConsecutiveErrors: 8,
  minTopics: 10,
};

export class DiscoveryError extends Error {
  constructor(message, reason) {
    super(message);
    this.name = "DiscoveryError";
    this.reason = reason;
  }
}

class BudgetStop extends Error {}

// Pages that are not something a lab can teach: release notes, adoption and guidance material, samples, and compliance pages.
const EXCLUDED_PATH =
  /\/(whats-new|release-plans?|troubleshoot[\w-]*|faq[\w-]*|toc|index|guidance|apps-experience)(\/|$)|\/(adoption-[\w-]+|kit-[\w-]+|agent-samples|fundamentals-support|admin-certification|data-location|geo-data-residency)$/;

/** Which concept a new topic belongs to, by its URL and title. The first matching rule wins. */
const CONCEPT_RULES = [
  ["choose-harness", /harness(es)?-overview|choose[- ]your[- ]harness|which[- ]harness/],
  ["mcp", /\bmcp\b|model[- ]context[- ]protocol/],
  ["hooks", /\bhooks?\b/],
  ["skills", /\bskills?\b|prompt[- ](tool|node)|custom[- ]prompt/],
  ["memory", /\bmemory\b/],
  ["files-code", /created[- ]files|code[- ]interpreter|code[- ]execution|\bfiles?\b/],
  ["subagents", /sub-?agents?|connected[- ]agents?|agent[- ]to[- ]agent|add[- ]agent/],
  ["triggers", /\btriggers?\b/],
  ["workflows", /workflows?|\bflows?\b/],
  ["knowledge", /knowledge|sharepoint|foundry[- ]iq|grounding|generative[- ]answers/],
  ["billing", /billing|credits?|licens|usage[- ]estimator|capacity/],
  ["testing", /\btest|evaluat|debug|activity[- ]trace|preview[- ]/],
  ["monitor", /analytics|monitor|transcripts?|insights|conversation[- ]history/],
  ["publish", /publish|channels?|deploy|\bshare\b|teams|whatsapp|facebook|telephony|voice|website|sms/],
  ["security", /authenticat|security|content[- ]moderation|safety|single[- ]sign|\bsso\b|\bauth\b/],
  ["governance", /govern|data[- ]loss|\bdlp\b|\balm\b|solutions?|admin|environment|compliance|inventory|identit/],
  ["integrations", /integrat|salesforce|servicenow|\bsap\b|jira|gateway|microsoft[- ]365|work[- ]iq|dataverse|power[- ]automate/],
  ["sdk", /\bsdk\b|extension|\bapi\b|visual[- ]studio|vs[- ]code|developer/],
  ["tools", /connectors?|\btools?\b|plugins?|actions?|computer[- ]use/],
  ["conversation-design", /topics?|entit|slot|adaptive[- ]card|power[- ]fx|variables?|\bnodes?\b|trigger[- ]phrase|conversation/],
  ["instructions", /instructions?/],
  ["model-orchestration", /\bmodels?\b|orchestrat|generative/],
  ["create-agent", /create|build|get[- ]started|first[- ]bot|quickstart|overview|what[- ]is/],
];

const INTRO_LEVEL = /overview|what-is|get-started|build-new|quickstart|first-bot|about/;
const ADVANCED_LEVEL = /govern|admin|security|vnet|\bsdk\b|\balm\b|\bdlp\b|network|custom-connector/;

// ── Parsing ──────────────────────────────────────────────────────────────────

// Lead-in sentences that appear on many pages and say nothing about the topic.
const BOILERPLATE = /powered by the (standard|microsoft copilot|customer conversation) harness\.?$|^applies to\b|^this article (is|was) (updated|archived)/i;

/** Every `[text](url)` link with the headings in force where it appears, so a section can say which harness a link belongs to. */
export function extractLinks(markdown, baseUrl) {
  const links = [];
  let h2 = "";
  let h3 = "";
  for (const line of String(markdown || "").split(/\r?\n/)) {
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      if (heading[1].length <= 2) {
        h2 = heading[2];
        h3 = "";
      } else if (heading[1].length === 3) h3 = heading[2];
      continue;
    }
    for (const match of line.matchAll(/(!?)\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      if (match[1]) continue;
      const url = normalizeLearnUrl(match[3], baseUrl);
      if (url) links.push({ url, text: cleanText(match[2], MAX_TITLE), heading: `${h2} ${h3}` });
    }
  }
  return links;
}

function parsePage(markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  const titleIndex = lines.findIndex((line) => /^#\s+\S/.test(line));
  const rawTitle = titleIndex >= 0 ? lines[titleIndex].replace(/^#\s+/, "") : "";
  let summary = "";
  for (const line of lines.slice(titleIndex + 1)) {
    const text = line.trim();
    if (!text) continue;
    if (/^(#|>|\||!\[|[-*]\s|\d+\.\s|\[This article|(?:Note|Important|Tip|Caution|Warning|Applies to)\b)/i.test(text)) continue;
    const cleaned = cleanText(text, MAX_SUMMARY);
    if (BOILERPLATE.test(cleaned)) continue;
    if (cleaned.length >= 40) {
      summary = cleaned;
      break;
    }
  }
  const head = lines.slice(0, 12).join(" ");
  return { title: cleanText(rawTitle, MAX_TITLE), rawTitle, summary, head };
}

/** Availability only when the page says so. Silence is `null`, never a guess. */
export function availabilityOf(rawTitle, head) {
  if (/\(retired\)|\(deprecated\)/i.test(rawTitle)) return "retired";
  if (/(this (feature|article|connector|capability)|it)\b.{0,40}\b(has been|was|is) (retired|deprecated)\b/i.test(head)) return "retired";
  if (/\(preview\)/i.test(rawTitle) || /prerelease documentation/i.test(head)) return "preview";
  return null;
}

function hintFromHeading(heading) {
  const hints = new Set();
  if (/customer conversation/i.test(heading)) hints.add("customer-conversation");
  if (/(microsoft|github) copilot harness/i.test(heading)) hints.add("microsoft-copilot");
  if (/standard harness/i.test(heading)) hints.add("standard");
  return hints;
}

/** The harnesses a topic belongs to, from the sections that link it, its path, and its title. */
export function harnessesFor({ url, title = "", hints = new Set() }) {
  const found = new Set(hints);
  const path = matchKey(new URL(url).pathname);
  const key = `${path} ${title}`.toLowerCase();
  if (/customer-conversation|customer conversation/.test(key)) found.add("customer-conversation");
  else if (/\/(agents|workflows)-experience\//.test(path) || /\(microsoft copilot\)/i.test(title)) found.add("microsoft-copilot");
  if (/standard harness/i.test(title)) found.add("standard");
  if (!found.size) found.add("standard");
  return DEFAULT_HARNESS_IDS.filter((id) => found.has(id));
}

export function conceptFor({ url, title = "" }) {
  const key = `${matchKey(new URL(url).pathname).replace(/^\/microsoft-copilot-studio\//, "")} ${title}`.toLowerCase();
  for (const [concept, pattern] of CONCEPT_RULES) if (pattern.test(key)) return concept;
  return UNCATEGORIZED;
}

function medianLevel(levels) {
  if (!levels.length) return 200;
  const sorted = [...levels].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function levelFor({ url, conceptId }, conceptLevels) {
  const slug = matchKey(new URL(url).pathname);
  if (INTRO_LEVEL.test(slug)) return 100;
  if (ADVANCED_LEVEL.test(slug)) return 300;
  return conceptLevels.get(conceptId) || 200;
}

function parseSearch(result) {
  const text = (result?.content || []).filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n");
  try {
    const parsed = JSON.parse(text);
    const items = Array.isArray(parsed) ? parsed : parsed?.results || [];
    return items.map((item) => ({
      title: String(item?.title || ""),
      url: String(item?.contentUrl || item?.url || ""),
      excerpt: String(item?.content || ""),
    }));
  } catch {
    return [];
  }
}

// ── Budgeted access to the Learn MCP server ─────────────────────────────────

function abortError(reason) {
  return new DOMException(String(reason || "Operation cancelled"), "AbortError");
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function createContext({ session, limits, signal, now }) {
  const ctx = {
    session,
    limits,
    signal,
    calls: 0,
    errors: 0,
    consecutive: 0,
    partial: null,
    deadlineAt: now() + limits.deadlineMs,
    now,
    pages: new Map(),
  };

  ctx.call = async (name, args) => {
    if (signal?.aborted) throw abortError(signal.reason);
    if (ctx.partial) throw new BudgetStop(ctx.partial);
    if (ctx.calls >= limits.maxCalls) {
      ctx.partial = "call-budget";
      throw new BudgetStop(ctx.partial);
    }
    if (ctx.now() >= ctx.deadlineAt) {
      ctx.partial = "deadline";
      throw new BudgetStop(ctx.partial);
    }
    ctx.calls += 1;
    try {
      const result = await session.call(name, args);
      ctx.consecutive = 0;
      return result;
    } catch (err) {
      if (err?.name === "AbortError") throw err;
      ctx.errors += 1;
      ctx.consecutive += 1;
      if (ctx.consecutive >= limits.maxConsecutiveErrors) {
        ctx.partial = "errors";
        throw new BudgetStop(ctx.partial);
      }
      throw err;
    }
  };

  /** Read one page once per run. `missing` means Learn said the page does not exist; `error` is anything transient. */
  ctx.page = async (url) => {
    if (ctx.pages.has(url)) return ctx.pages.get(url);
    let page;
    try {
      const result = await ctx.call("microsoft_docs_fetch", { url });
      const text = (result?.content || []).filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n");
      if (!text.trim()) page = { state: "error", markdown: "" };
      else if (text.length < 400 && /not a valid microsoft documentation|page (was )?not found|could not (find|be found)|does not exist/i.test(text)) page = { state: "missing", markdown: "" };
      else page = { state: "ok", markdown: text, hash: contentHash(text) };
    } catch (err) {
      if (err?.name === "AbortError") throw err;
      page = { state: err instanceof BudgetStop ? "skipped" : "error", markdown: "" };
    }
    // A failed read is not remembered as a result: only the run's own pages map holds it, for this run.
    ctx.pages.set(url, page);
    return page;
  };

  ctx.search = async (query) => {
    try {
      return parseSearch(await ctx.call("microsoft_docs_search", { query }));
    } catch (err) {
      if (err?.name === "AbortError") throw err;
      return [];
    }
  };
  return ctx;
}

// ── The run ──────────────────────────────────────────────────────────────────

function day(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * @param {object} options
 * @param {{ok:boolean, call:Function}} options.session an open Learn MCP session
 * @param {{features:object[], concepts:object[], version?:string, endpoint?:string}} options.catalog
 * @param {object|null} [options.previous] the last good snapshot, for change detection
 * @returns {Promise<object>} a snapshot (see topic-snapshot.js)
 */
export async function discoverSnapshot({
  session,
  catalog,
  previous = null,
  limits: limitOverrides = {},
  signal,
  now = Date.now,
  onProgress,
}) {
  if (!session?.ok) throw new DiscoveryError(`Microsoft Learn is not reachable${session?.error ? `: ${session.error}` : ""}`, "unreachable");
  const limits = { ...DEFAULT_LIMITS, ...limitOverrides };
  const ctx = createContext({ session, limits, signal, now });
  const today = day(now());
  const features = catalog.features || [];
  const concepts = catalog.concepts || [];

  const levelsByConcept = new Map();
  for (const concept of concepts) {
    levelsByConcept.set(concept.id, medianLevel((concept.features || []).map((id) => features.find((f) => f.id === id)?.level).filter(Boolean)));
  }
  const conceptOfFeature = new Map(concepts.flatMap((c) => (c.features || []).map((id) => [id, c.id])));

  // Which catalog features cite which page. The old harness name in a URL matches the new one.
  const featuresByPage = new Map();
  const catalogUrls = new Map();
  for (const feature of features) {
    for (const raw of feature.docUrls || []) {
      const url = normalizeLearnUrl(raw);
      if (!url) continue;
      const key = matchKey(url);
      if (!featuresByPage.has(key)) featuresByPage.set(key, new Set());
      featuresByPage.get(key).add(feature.id);
      catalogUrls.set(key, url);
    }
  }

  const candidates = new Map();
  const addCandidate = (url, { title = "", hints = new Set(), excerpt = "", priority, retain = false }) => {
    if (!isCopilotStudioDoc(url) || EXCLUDED_PATH.test(url) || candidates.size >= limits.maxTopics * 2) return;
    const key = matchKey(url);
    const existing = candidates.get(key);
    if (existing) {
      for (const hint of hints) existing.hints.add(hint);
      existing.priority = Math.min(existing.priority, priority);
      existing.retain = existing.retain || retain;
      if (!existing.title && title) existing.title = title;
      if (!existing.excerpt && excerpt) existing.excerpt = excerpt;
      return;
    }
    candidates.set(key, { url, title, hints: new Set(hints), excerpt, priority, retain });
  };

  // A. Section index pages.
  onProgress?.("Reading the Copilot Studio documentation index");
  let hubOk = false;
  for (const seed of SEEDS) {
    const page = await ctx.page(seed);
    if (page.state !== "ok") continue;
    if (seed === LEARN_DOCS_HUB) hubOk = true;
    const seedUrl = normalizeLearnUrl(seed);
    if (seedUrl) addCandidate(seedUrl, { priority: 0 });
    for (const link of extractLinks(page.markdown, seed)) {
      addCandidate(link.url, { title: link.text, hints: hintFromHeading(link.heading), priority: 0 });
    }
  }
  if (!hubOk) throw new DiscoveryError("The Copilot Studio documentation index could not be read from Microsoft Learn.", "index-unavailable");

  // B. Targeted searches, so pages the index does not link are still found.
  onProgress?.("Searching Microsoft Learn for each concept");
  const queries = [
    ...concepts.flatMap((concept) => [
      `Microsoft Copilot Studio ${concept.name} Microsoft Copilot harness`,
      `Microsoft Copilot Studio ${concept.name} standard harness`,
    ]),
    ...CUSTOMER_CONVERSATION_QUERIES,
  ];
  const found = await mapLimit(queries, limits.concurrency, (query) => ctx.search(query));
  found.forEach((items) => {
    for (const item of items) {
      const url = normalizeLearnUrl(item.url);
      if (url) addCandidate(url, { title: cleanText(item.title, MAX_TITLE), excerpt: cleanText(item.excerpt, MAX_SUMMARY), priority: 1 });
    }
  });

  // Topics from the last good run are re-read directly, so a search that happens to return different results
  // cannot make a topic flap in and out of the list. A topic leaves only when Learn says its page is gone.
  for (const before of previous?.topics || []) {
    const url = before.urls?.[0];
    if (url) addCandidate(url, { title: before.title, excerpt: before.summary, hints: new Set(before.harnesses), priority: 2, retain: true });
  }

  // C. The pages the catalog cites, to see which still exist and which changed.
  onProgress?.("Checking the pages the catalog cites");
  await mapLimit([...catalogUrls.values()], limits.concurrency, (url) => ctx.page(url));

  // D. Every candidate page, index-linked ones first, then search hits, then pages they link to.
  onProgress?.("Reading the discovered pages");
  const processed = new Set();
  let pagesRead = 0;
  while (pagesRead < limits.maxTopicPages && !ctx.partial) {
    const batch = [...candidates.values()]
      .filter((c) => !processed.has(matchKey(c.url)) && !ctx.pages.has(c.url))
      .sort((a, b) => a.priority - b.priority)
      .slice(0, Math.min(limits.concurrency * 4, limits.maxTopicPages - pagesRead));
    if (!batch.length) break;
    await mapLimit(batch, limits.concurrency, async (candidate) => {
      processed.add(matchKey(candidate.url));
      const page = await ctx.page(candidate.url);
      pagesRead += 1;
      if (page.state === "ok" && candidate.priority < 2) {
        for (const link of extractLinks(page.markdown, candidate.url)) addCandidate(link.url, { title: link.text, priority: 2 });
      }
    });
  }

  // E. Build topics.
  const previousTopics = new Map((previous?.topics || []).map((t) => [t.id, t]));
  const topics = [];
  const seenIds = new Set();
  for (const candidate of candidates.values()) {
    const page = ctx.pages.get(candidate.url);
    if (page?.state === "missing") continue;
    // A page only linked from another article has nothing but link text to go on, which is too thin to offer as a topic.
    if (page?.state !== "ok" && candidate.priority >= 2 && !candidate.retain) continue;
    const parsed = page?.state === "ok" ? parsePage(page.markdown) : null;
    const title = parsed?.title || candidate.title;
    if (!title) continue;
    const id = topicId(candidate.url);
    if (seenIds.has(id)) continue;
    seenIds.add(id);

    const summary = parsed?.summary || candidate.excerpt || `${title}: see the linked Microsoft Learn article.`;
    const harnesses = harnessesFor({ url: candidate.url, title: parsed?.rawTitle || title, hints: candidate.hints });
    const coveredBy = [...(featuresByPage.get(matchKey(candidate.url)) || [])];
    const conceptId = coveredBy.length ? conceptOfFeature.get(coveredBy[0]) || UNCATEGORIZED : conceptFor({ url: candidate.url, title });
    const hash = page?.state === "ok" ? page.hash : contentHash(`${title}\n${summary}`);
    const before = previousTopics.get(id);
    topics.push({
      id,
      title,
      summary: cleanText(summary, MAX_SUMMARY),
      urls: [candidate.url],
      harnesses,
      conceptId,
      availability: parsed ? availabilityOf(parsed.rawTitle, parsed.head) : null,
      status: coveredBy.length ? "covered" : "new",
      featureIds: coveredBy.sort(),
      level: levelFor({ url: candidate.url, conceptId }, levelsByConcept),
      firstSeen: before?.firstSeen || today,
      lastSeen: today,
      changedAt: before && before.contentHash !== hash ? today : before?.changedAt ?? null,
      contentHash: hash,
    });
    if (topics.length >= limits.maxTopics) break;
  }

  // A partial run keeps what earlier runs knew instead of silently dropping it.
  if (ctx.partial) {
    for (const before of previousTopics.values()) if (!seenIds.has(before.id)) topics.push(before);
  }
  if (topics.length < limits.minTopics) {
    throw new DiscoveryError(`Only ${topics.length} topic(s) were found, which is too few to trust, so the list was not updated.`, "too-few");
  }

  // F. Catalog features checked against what Learn still serves.
  const previousChecks = new Map((previous?.catalog || []).map((c) => [c.featureId, c]));
  const checks = features.map((feature) => {
    const urls = [...new Set((feature.docUrls || []).map((u) => normalizeLearnUrl(u)).filter(Boolean))];
    const pages = urls.map((url) => ({ url, page: ctx.pages.get(catalogUrls.get(matchKey(url)) || url) }));
    const ok = pages.filter((p) => p.page?.state === "ok");
    const missing = pages.filter((p) => p.page?.state === "missing").map((p) => p.url);
    const before = previousChecks.get(feature.id);
    if (!urls.length || (!ok.length && missing.length !== urls.length)) {
      return { featureId: feature.id, status: before?.status === "stale" ? "stale" : "unknown", contentHash: before?.contentHash ?? null, changedAt: before?.changedAt ?? null, missing: before?.missing || [] };
    }
    if (!ok.length) return { featureId: feature.id, status: "stale", contentHash: null, changedAt: before?.changedAt ?? null, missing: missing.sort() };
    const combined = contentHash(ok.map((p) => `${p.url}:${p.page.hash}`).sort().join("|"));
    const changed = Boolean(before?.contentHash) && before.contentHash !== combined;
    return {
      featureId: feature.id,
      status: changed ? "updated" : before?.status === "updated" && before.contentHash === combined ? "updated" : "current",
      contentHash: combined,
      changedAt: changed ? today : before?.changedAt ?? null,
      missing: missing.sort(),
    };
  });

  const pageHashes = {};
  for (const [url, page] of [...ctx.pages].sort(([a], [b]) => a.localeCompare(b))) if (page.state === "ok" && normalizeLearnUrl(url) === url) pageHashes[url] = page.hash;

  topics.sort((a, b) => a.id.localeCompare(b.id));
  const snapshot = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    generatedAt: new Date(now()).toISOString(),
    source: "microsoft-learn-mcp",
    catalogVersion: catalog.version ?? null,
    partial: Boolean(ctx.partial),
    partialReason: ctx.partial,
    stats: { calls: ctx.calls, errors: ctx.errors, pagesRead, searches: queries.length },
    topics,
    catalog: checks.sort((a, b) => a.featureId.localeCompare(b.featureId)),
    pageHashes,
  };
  snapshot.listHash = listHash(snapshot);
  return snapshot;
}
