/**
 * Copilot Studio feature catalog.
 *
 * Loads `features.json` and exposes lookup / dependency helpers used by the
 * lab planner, the portal wizard, and the CLI.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = path.join(__dirname, "features.json");

let cached = null;

function index(raw) {
  const categories = raw.categories || [];
  const features = raw.features || [];

  const byId = new Map(features.map((f) => [f.id, f]));
  const categoryIds = new Set(categories.map((c) => c.id));

  return {
    version: raw.version,
    product: raw.product,
    docsReviewed: raw.docsReviewed || null,
    vendorHosts: raw.vendorHosts || [],
    categories,
    features,
    byId,
    categoryIds,
  };
}

function load() {
  if (cached) return cached;
  cached = index(JSON.parse(fs.readFileSync(CATALOG_PATH, "utf8")));
  return cached;
}

export function getCatalog() {
  return load();
}

export function getCategories() {
  const { categories, features } = load();
  return categories.map((cat) => ({
    ...cat,
    featureCount: features.filter((f) => f.category === cat.id).length,
  }));
}

export function getFeatures() {
  return load().features;
}

export function getFeature(id) {
  return load().byId.get(id) || null;
}

export function getCoreFeatures() {
  return load().features.filter((f) => f.core);
}

/** Features grouped by category, in catalog order — the shape the wizard renders. */
export function getFeaturesByCategory() {
  const { categories, features } = load();
  return categories.map((cat) => ({
    ...cat,
    features: features
      .filter((f) => f.category === cat.id)
      .map((f) => ({
        id: f.id,
        name: f.name,
        level: f.level,
        minutes: f.minutes,
        core: Boolean(f.core),
        summary: f.summary,
        prereqs: f.prereqs || [],
        relatedLabs: f.relatedLabs || [],
      })),
  }));
}

/**
 * Expand a set of feature ids to include every transitive prerequisite.
 * Unknown ids are dropped. Returns ids only.
 */
export function expandPrereqs(ids) {
  const { byId } = load();
  const out = new Set();

  const visit = (id, seen) => {
    const feature = byId.get(id);
    if (!feature || out.has(id) || seen.has(id)) return;
    seen.add(id);
    for (const prereq of feature.prereqs || []) visit(prereq, seen);
    out.add(id);
  };

  for (const id of ids || []) visit(id, new Set());
  return [...out];
}

/**
 * Topologically order feature ids so prerequisites always come first, then by
 * level, then by catalog order. Assumes ids are already prereq-expanded.
 */
export function orderFeatures(ids) {
  const { byId, features, categories } = load();
  const catalogOrder = new Map(features.map((f, i) => [f.id, i]));
  const categoryOrder = new Map(categories.map((c, i) => [c.id, i]));
  const phaseWeight = { build: 0, deploy: 1 };
  const wanted = new Set(ids.filter((id) => byId.has(id)));

  const ordered = [];
  const placed = new Set();
  const visiting = new Set();

  const rank = (id) => {
    const f = byId.get(id);
    return [
      phaseWeight[f.phase] ?? 0,
      categoryOrder.get(f.category) ?? 99,
      f.level,
      catalogOrder.get(id),
    ];
  };

  const candidates = [...wanted].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i += 1) {
      if (ra[i] !== rb[i]) return ra[i] - rb[i];
    }
    return 0;
  });

  const visit = (id) => {
    if (placed.has(id) || visiting.has(id)) return;
    visiting.add(id);
    const feature = byId.get(id);
    for (const prereq of feature.prereqs || []) {
      if (wanted.has(prereq)) visit(prereq);
    }
    visiting.delete(id);
    placed.add(id);
    ordered.push(id);
  };

  for (const id of candidates) visit(id);
  return ordered;
}

const HOST_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const LEARN_HOST = "learn.microsoft.com";
const SOURCE_FIELDS = ["vendor", "title", "url", "stability"];

/**
 * Check the vendor allowlist and every feature's `thirdPartySources` against it.
 *
 * The allowlist is the builder's whole trust boundary for non-Microsoft
 * content, so it is held tight: exact host names only, each with a reason, and
 * no entry that no feature uses.
 */
function validateVendorSources(features, vendorHosts, problems) {
  const allowed = new Map();
  if (!Array.isArray(vendorHosts)) {
    problems.push("vendorHosts must be an array of { host, reason } entries");
    vendorHosts = [];
  }
  vendorHosts.forEach((entry, position) => {
    const host = typeof entry?.host === "string" ? entry.host : "";
    if (!HOST_NAME.test(host)) {
      problems.push(`vendorHosts[${position}]: "${host}" must be a lower-case host name with no scheme, port, path, or wildcard`);
      return;
    }
    if (host === LEARN_HOST) {
      problems.push(`vendorHosts: ${host} is Microsoft Learn; cite it through docUrls, not as a vendor host`);
      return;
    }
    if (allowed.has(host)) problems.push(`vendorHosts: duplicate host ${host}`);
    if (typeof entry.reason !== "string" || !entry.reason.trim()) problems.push(`vendorHosts: ${host} needs a reason`);
    allowed.set(host, 0);
  });

  for (const f of features) {
    if (f.thirdPartySources === undefined) continue;
    if (!Array.isArray(f.thirdPartySources)) {
      problems.push(`${f.id}: thirdPartySources must be an array`);
      continue;
    }
    const urls = new Set();
    f.thirdPartySources.forEach((source, position) => {
      const label = `${f.id}: thirdPartySources[${position}]`;
      for (const field of SOURCE_FIELDS) {
        if (typeof source?.[field] !== "string" || !source[field].trim()) problems.push(`${label} needs a ${field}`);
      }
      if (typeof source?.title === "string" && /^https?:\/\//i.test(source.title.trim())) {
        problems.push(`${label}: title becomes the link text, so it must name the page rather than repeat a URL`);
      }
      if (typeof source?.url !== "string") return;

      let url;
      try {
        url = new URL(source.url);
      } catch {
        problems.push(`${label}: "${source.url}" is not a valid URL`);
        return;
      }
      if (url.protocol !== "https:") problems.push(`${label}: ${source.url} must use https`);
      if (url.username || url.password) problems.push(`${label}: ${source.url} must not carry credentials`);
      if (url.port) problems.push(`${label}: ${source.url} must use the default port`);
      if (url.hostname === LEARN_HOST) problems.push(`${label}: Microsoft Learn pages belong in docUrls`);
      else if (!allowed.has(url.hostname)) problems.push(`${label}: ${url.hostname} is not in vendorHosts`);
      else allowed.set(url.hostname, allowed.get(url.hostname) + 1);
      if (urls.has(source.url)) problems.push(`${label}: duplicate url ${source.url}`);
      urls.add(source.url);
    });
  }

  for (const [host, uses] of allowed) {
    if (!uses) problems.push(`vendorHosts: ${host} is not used by any feature's thirdPartySources; remove it`);
  }
}

/**
 * Validate catalog integrity. Returns an array of human-readable problems.
 *
 * @param {object} [raw] a parsed catalog to check instead of features.json
 */
export function validateCatalog(raw) {
  const { features, byId, categoryIds, vendorHosts } = raw ? index(raw) : load();
  const problems = [];
  const seen = new Set();

  for (const f of features) {
    if (seen.has(f.id)) problems.push(`Duplicate feature id: ${f.id}`);
    seen.add(f.id);

    if (!categoryIds.has(f.category)) problems.push(`${f.id}: unknown category "${f.category}"`);
    if (![100, 200, 300].includes(f.level)) problems.push(`${f.id}: level must be 100, 200, or 300`);
    if (!Number.isFinite(f.minutes) || f.minutes <= 0) problems.push(`${f.id}: minutes must be positive`);
    if (!f.summary) problems.push(`${f.id}: missing summary`);
    if (!f.whyItMatters) problems.push(`${f.id}: missing whyItMatters`);
    if (!f.concepts?.length) problems.push(`${f.id}: needs at least one concept`);
    if (!f.steps?.length) problems.push(`${f.id}: needs at least one step`);
    if (!f.validation?.length) problems.push(`${f.id}: needs at least one validation check`);
    if (!f.learnQueries?.length) problems.push(`${f.id}: needs at least one learnQuery`);
    if (!f.docUrls?.length) problems.push(`${f.id}: needs at least one docUrl fallback`);

    for (const prereq of f.prereqs || []) {
      if (!byId.has(prereq)) problems.push(`${f.id}: unknown prereq "${prereq}"`);
      if (prereq === f.id) problems.push(`${f.id}: is its own prereq`);
    }
  }

  // Detect prerequisite cycles.
  const state = new Map();
  const walk = (id, trail) => {
    if (state.get(id) === "done") return;
    if (state.get(id) === "open") {
      problems.push(`Prerequisite cycle: ${[...trail, id].join(" -> ")}`);
      return;
    }
    state.set(id, "open");
    for (const prereq of byId.get(id)?.prereqs || []) {
      if (byId.has(prereq)) walk(prereq, [...trail, id]);
    }
    state.set(id, "done");
  };
  for (const f of features) walk(f.id, []);

  validateVendorSources(features, vendorHosts, problems);

  return problems;
}
