/**
 * Request handling for the Learn topic routes, kept out of server.js so the
 * routes stay a few lines each and can be tested without starting the portal.
 */

import { getFeatures, getHarnesses } from "./catalog.js";
import { getConcepts } from "./concepts.js";
import { isThirdPartyConnectorTopic } from "./topic-feature.js";
import { summarize } from "./topic-snapshot.js";
import { DEFAULT_PRODUCT, getProducts } from "./products.js";
import { tidySummary } from "./topic-sanitize.js";
import { resolveTopicLevel } from "./levels.js";
import { describeSubtopics } from "./subtopics.js";
import { EXPORT_MIME, buildTopicExport, exportFileName, normalizeExportRequest, serialize } from "./topic-export.js";

const DAY_MS = 86400000;

/** The view of every product that has a list: Copilot Studio (service.view()), then the others. */
function viewsOf(service) {
  const others = typeof service.views === "function" ? service.views().filter((v) => v.product && v.product !== DEFAULT_PRODUCT) : [];
  return [service.view(), ...others];
}

/** Every product's snapshot that has one. */
function snapshotsOf(service) {
  return viewsOf(service).map((v) => v.snapshot).filter(Boolean);
}

/** What `recommend` needs from discovery. Also nudges a stale list to refresh in the background. */
export function learnContext(service) {
  service.revalidateIfStale();
  const snapshots = snapshotsOf(service);
  return {
    topics: snapshots.flatMap((snapshot) => snapshot.topics || []),
    checks: snapshots.flatMap((snapshot) => snapshot.catalog || []),
    updatedWindowDays: service.config.updatedWindowDays,
  };
}

/** How many Learn-only topics each harness has, so the harness step can offer one the catalog has no topic for yet. */
export function newTopicCounts(service) {
  const counts = {};
  for (const topic of service.view().snapshot?.topics || []) {
    if (topic.status !== "new") continue;
    for (const harness of topic.harnesses) counts[harness] = (counts[harness] || 0) + 1;
  }
  return counts;
}

/** The same counts split by level, so the harness step can count only what the chosen level offers. Topics with no resolvable level are not counted. */
export function newTopicCountsByLevel(service) {
  const counts = {};
  for (const topic of service.view().snapshot?.topics || []) {
    if (topic.status !== "new") continue;
    const { level } = resolveTopicLevel(topic);
    if (!level) continue;
    for (const harness of topic.harnesses) {
      counts[harness] ||= {};
      counts[harness][level] = (counts[harness][level] || 0) + 1;
    }
  }
  return counts;
}

function freshness(service) {
  const view = service.view();
  return {
    source: view.source,
    refreshedAt: view.refreshedAt,
    ageMs: view.ageMs,
    stale: view.stale,
    refreshing: view.refreshing,
    offline: view.offline,
    disabled: view.disabled,
    circuitOpen: view.circuitOpen,
    retryAfterSec: view.retryAfterSec,
    partial: Boolean(view.snapshot?.partial),
    lastError: view.lastError,
    ttlMs: service.config.ttlMs,
    updatedWindowDays: service.config.updatedWindowDays,
  };
}

/** How fresh each product's topic list is, so the wizard can say it for the products the lab covers. */
function productFreshness(service) {
  const result = {};
  const byProduct = new Map(viewsOf(service).map((v, index) => [index === 0 ? DEFAULT_PRODUCT : v.product, v]));
  for (const { id, shortName } of getProducts()) {
    const view = byProduct.get(id);
    if (!view) continue;
    result[id] = {
      name: shortName,
      source: view.source,
      refreshedAt: view.refreshedAt,
      ageMs: view.ageMs,
      stale: view.stale,
      refreshing: view.refreshing,
      offline: view.offline,
      partial: Boolean(view.snapshot?.partial),
      newTopics: (view.snapshot?.topics || []).filter((topic) => topic.status === "new").length,
    };
  }
  return result;
}

/**
 * The merged topic list: every static catalog feature, then every topic that
 * is new on Microsoft Learn. Each says where it came from and what state it is in.
 */
export function topicsPayload(service, now = Date.now()) {
  const view = service.view();
  const snapshot = view.snapshot;
  const snapshots = snapshotsOf(service);
  const checks = new Map(snapshots.flatMap((s) => s.catalog || []).map((c) => [c.featureId, c]));
  const windowMs = service.config.updatedWindowDays * DAY_MS;
  const recent = (day) => Boolean(day) && now - Date.parse(`${day}T00:00:00Z`) <= windowMs;
  const conceptOf = new Map(getConcepts().flatMap((c) => c.features.map((id) => [id, c.id])));

  const catalog = getFeatures().map((feature) => {
    const check = checks.get(feature.id);
    const status = check?.status === "stale" ? "stale" : check?.status === "updated" && recent(check.changedAt) ? "updated" : "current";
    return {
      id: feature.id,
      title: feature.name,
      summary: feature.summary,
      source: "catalog",
      status,
      conceptId: conceptOf.get(feature.id) || null,
      harnesses: feature.harness || [],
      level: feature.level,
      availability: feature.availability || null,
      thirdPartyConnector: Boolean(feature.thirdPartyConnector),
      urls: feature.docUrls || [],
      changedAt: check?.changedAt ?? null,
    };
  });

  const discovered = snapshots
    .flatMap((s) => s.topics || [])
    .filter((topic) => topic.status === "new")
    .map((topic) => ({
      id: topic.id,
      title: topic.title,
      summary: tidySummary(topic.summary),
      source: "learn",
      ...(topic.product && topic.product !== DEFAULT_PRODUCT ? { product: topic.product } : {}),
      status: recent(topic.changedAt) ? "updated" : "new",
      conceptId: topic.conceptId,
      harnesses: topic.harnesses,
      level: resolveTopicLevel(topic).level,
      availability: topic.availability,
      thirdPartyConnector: isThirdPartyConnectorTopic(topic),
      urls: topic.urls,
      ...(topic.subtopics?.length ? { subtopics: describeSubtopics(topic) } : {}),
      changedAt: topic.changedAt,
      firstSeen: topic.firstSeen,
      lastSeen: topic.lastSeen,
    }));

  return {
    ...freshness(service),
    products: productFreshness(service),
    harnesses: getHarnesses().map((h) => h.id),
    counts: snapshot ? summarize(snapshot, getFeatures()) : {},
    topics: [...catalog, ...discovered],
  };
}

const STATUS_BY_REASON = { disabled: 503, "too-soon": 429, "circuit-open": 429, failed: 502 };

/**
 * Run a refresh and shape the response. A failed refresh still returns the
 * list in use, so the wizard keeps working on the last good data.
 */
export async function refreshResponse(service, products = [DEFAULT_PRODUCT]) {
  const wanted = [...new Set(products.length ? products : [DEFAULT_PRODUCT])];
  const results = {};
  for (const product of wanted) results[product] = await service.refresh(product === DEFAULT_PRODUCT ? {} : { product });
  // One result keeps the original shape; several report each product and succeed only when every one did.
  const failed = Object.entries(results).find(([, r]) => !r.ok);
  const result =
    wanted.length === 1
      ? results[wanted[0]]
      : { ok: !failed, changed: Object.values(results).some((r) => r.changed), products: results, ...(failed ? { reason: failed[1].reason, error: failed[1].error, retryAfterSec: failed[1].retryAfterSec } : {}) };
  const body = { ...topicsPayload(service), refresh: result };
  if (result.ok) return { status: 200, headers: {}, body };
  const headers = result.retryAfterSec ? { "Retry-After": String(result.retryAfterSec) } : {};
  return { status: STATUS_BY_REASON[result.reason] || 502, headers, body: { ...body, error: result.error } };
}

/**
 * Mount the topic routes on an Express app. The caller mounts authentication
 * ahead of this, exactly as it does for the other lab builder routes.
 *
 * @param {import("express").Express} app
 * @param {{getService: () => object, createRateLimiter: Function, positiveIntFromEnv: Function}} deps
 */
export function registerTopicRoutes(app, { getService, createRateLimiter, positiveIntFromEnv }) {
  const rateCheck = createRateLimiter({
    windowMs: positiveIntFromEnv(process.env.LAB_BUILDER_TOPICS_RATE_WINDOW_MS, 3600000),
    max: positiveIntFromEnv(process.env.LAB_BUILDER_TOPICS_RATE_MAX, 6),
  });
  const exportRateCheck = createRateLimiter({
    windowMs: positiveIntFromEnv(process.env.LAB_BUILDER_TOPICS_EXPORT_RATE_WINDOW_MS, 3600000),
    max: positiveIntFromEnv(process.env.LAB_BUILDER_TOPICS_EXPORT_RATE_MAX, 60),
  });

  /** GET /api/lab-builder/topics: the static catalog plus topics discovered on Microsoft Learn, with freshness. */
  app.get("/api/lab-builder/topics", (_req, res) => {
    try {
      const service = getService();
      service.revalidateIfStale();
      res.json(topicsPayload(service));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /** POST /api/lab-builder/topics/refresh: re-read the topic list from Microsoft Learn. */
  app.post("/api/lab-builder/topics/refresh", async (req, res) => {
    const body = req.body;
    const known = new Set(getProducts().map((p) => p.id));
    const keys = body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body) : [];
    const bad = body !== undefined && body !== null && (typeof body !== "object" || Array.isArray(body) || keys.some((key) => key !== "products"));
    const products = body?.products;
    if (bad || (products !== undefined && (!Array.isArray(products) || products.length > known.size || products.some((id) => !known.has(id))))) {
      return res.status(400).json({ error: "The refresh request takes only an optional list of product ids (products)." });
    }
    const rate = rateCheck(String(req.user?.oid || req.user?.upn || req.ip || "anonymous").toLowerCase());
    if (!rate.allowed) {
      res.setHeader("Retry-After", String(rate.retryAfterSec));
      return res.status(429).json({ error: `Refresh rate limit exceeded. Try again in ${rate.retryAfterSec}s.` });
    }
    try {
      const { status, headers, body: payload } = await refreshResponse(getService(), products || [DEFAULT_PRODUCT]);
      for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
      res.status(status).json(payload);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/lab-builder/topics/export: every available topic and sub-topic for the chosen products, at every level,
   * independent of any search, filter, or selection. `format` is csv, markdown, or json (a file) or dataset (the rows the
   * wizard builds its own files from). `selectedIds`, `requiredIds`, and `excludedSubtopics` only fill "Selected in my lab".
   */
  app.post("/api/lab-builder/topics/export", (req, res) => {
    const rate = exportRateCheck(String(req.user?.oid || req.user?.upn || req.ip || "anonymous").toLowerCase());
    if (!rate.allowed) {
      res.setHeader("Retry-After", String(rate.retryAfterSec));
      return res.status(429).json({ error: `Export rate limit exceeded. Try again in ${rate.retryAfterSec}s.` });
    }
    let request;
    try {
      request = normalizeExportRequest(req.body);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    try {
      const dataset = buildTopicExport({ ...request, learn: learnContext(getService()) });
      if (request.format === "dataset") return res.json({ dataset });
      res.setHeader("Content-Type", EXPORT_MIME[request.format]);
      res.setHeader("Content-Disposition", `attachment; filename="${exportFileName(dataset, request.format)}"`);
      res.setHeader("Cache-Control", "no-store");
      return res.send(serialize(request.format, dataset, request.selection));
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  });
}
