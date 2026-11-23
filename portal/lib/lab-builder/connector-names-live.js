/**
 * Connector names that are not in the curated table: look them up once, remember the answer, never guess.
 *
 * Build time only. The page named by the id (`https://learn.microsoft.com/connectors/<name>/`) is read through the same
 * Learn reader every lab build uses (its request cap, single flight and polite retry apply), at most `MAX_LOOKUPS` pages
 * per build, and the answer is kept in a small file in the portal's data folder so the next build reads nothing. A page
 * that cannot be read, or that is not a connector reference page, leaves the id unresolved: the lab then says
 * "a connector (<id>)" and the id is listed for the table. A failed lookup is remembered for a day so a missing page is
 * not asked for again on every build.
 */

import path from "node:path";

import { readJsonOr, writeJsonAtomic } from "../concurrency/atomic-file.js";
import { resolvePortalDataDir } from "../storage-config.js";
import { fetchDocPage } from "./learn-mcp.js";
import { collectUnknownConnectorIds, connectorLearnUrl, resolveConnector, rewriteConnectorText, rewriteConnectorValue } from "./connector-names.js";

const MAX_LOOKUPS = 12;
const FOUND_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const MISSING_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_VERSION = 1;

/** Where answers are kept. */
export function connectorCachePath(env = process.env) {
  return env.LAB_BUILDER_CONNECTOR_CACHE || path.join(resolvePortalDataDir(env), "lab-builder", "connector-names-cache.json");
}

/** The first heading of a connector reference page, or null when the page is not one (a missing page, an overview). */
export function connectorPageTitle(markdown) {
  const text = String(markdown || "");
  const heading = /^#\s+(.+)$/m.exec(text);
  if (!heading) return null;
  // Every connector reference page says this; an overview, a search page or an error page does not.
  if (!/This connector is available in the following products and regions/i.test(text)) return null;
  const title = heading[1].replace(/\\([\\`*_{}\[\]()#+\-.!|<>])/g, "$1").replace(/\s+/g, " ").trim();
  return title || null;
}

/**
 * @param {string[]} ids lowercased `shared_<name>` ids that are not in the table
 * @param {{session?: object, fetchPage?: Function, env?: object, now?: number, cacheFile?: string, maxLookups?: number}} [options]
 * @returns {Promise<{resolved: Map<string, {apiName: string, displayName: string, learnUrl: string, verifiedAt: string}>, unresolved: string[], lookups: number}>}
 */
export async function resolveUnknownConnectors(ids, { session, fetchPage = fetchDocPage, env = process.env, now = Date.now(), cacheFile = connectorCachePath(env), maxLookups = MAX_LOOKUPS } = {}) {
  const resolved = new Map();
  const unresolved = [];
  const wanted = [...new Set((ids || []).map((id) => String(id).toLowerCase()))].filter((id) => !resolveConnector(id));
  if (!wanted.length) return { resolved, unresolved, lookups: 0 };

  const cache = readJsonOr(cacheFile, null);
  const entries = cache && cache.version === CACHE_VERSION && cache.entries && typeof cache.entries === "object" ? { ...cache.entries } : {};
  let dirty = false;
  let lookups = 0;

  for (const id of wanted) {
    const known = entries[id];
    const age = known ? now - Date.parse(known.checkedAt || known.verifiedAt || "") : Number.POSITIVE_INFINITY;
    if (known?.displayName && age < FOUND_TTL_MS) {
      resolved.set(id, { apiName: id, displayName: known.displayName, learnUrl: known.learnUrl, verifiedAt: known.verifiedAt });
      continue;
    }
    if (known?.missing && age < MISSING_TTL_MS) {
      unresolved.push(id);
      continue;
    }
    const url = connectorLearnUrl(id);
    if (!session?.ok || !url || lookups >= maxLookups) {
      unresolved.push(id);
      continue;
    }
    lookups += 1;
    const page = await fetchPage(session, url);
    const title = page.error ? null : connectorPageTitle(page.markdown);
    // A failed read is a statement about this network, not about the connector, so it is not remembered.
    if (page.error) {
      unresolved.push(id);
      continue;
    }
    const checkedAt = new Date(now).toISOString();
    if (!title) {
      entries[id] = { missing: true, checkedAt };
      dirty = true;
      unresolved.push(id);
      continue;
    }
    entries[id] = { displayName: title, learnUrl: url, verifiedAt: checkedAt.slice(0, 10), checkedAt };
    dirty = true;
    resolved.set(id, { apiName: id, displayName: title, learnUrl: url, verifiedAt: checkedAt.slice(0, 10) });
  }

  if (dirty) {
    try {
      writeJsonAtomic(cacheFile, { version: CACHE_VERSION, entries });
    } catch {
      /* the answers are still used for this build */
    }
  }
  return { resolved, unresolved, lookups };
}

/** True when `value` (any nesting of Maps, arrays and objects) holds a string that could carry a connector id. */
function hasHint(value, seen = new Set()) {
  if (typeof value === "string") return /shared[_-][a-z0-9]/i.test(value);
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  const children = value instanceof Map ? [...value.values()] : Array.isArray(value) ? value : Object.values(value);
  return children.some((child) => hasHint(child, seen));
}

/**
 * Show the display name wherever the material a lab is composed from carries a connector id: the plan, the steps read from
 * Learn, the grounding excerpts, the vendor excerpts and the narrative. Unknown ids are looked up once (see
 * `resolveUnknownConnectors`); one that cannot be resolved becomes "a connector (<id>)". Everything is changed in place and
 * nothing is done (and nothing fetched) when no id is present.
 *
 * @returns {Promise<{rewrite: (text: string) => string, rewriteValue: (value: any) => any, resolved: string[], unresolved: string[]}>}
 */
export async function applyConnectorNames({ session, plan, groundingByFeature, stepsByFeature, vendorByFeature, enrichment, resolveOptions = {} }) {
  const parts = [plan?.features, plan?.warnings, groundingByFeature, stepsByFeature, vendorByFeature, enrichment];
  const present = parts.some((part) => hasHint(part));
  let resolved = new Map();
  let unresolved = [];
  if (present) {
    const unknown = collectUnknownConnectorIds(
      parts.map((part) => (part instanceof Map ? [...part.values()] : part)),
    );
    ({ resolved, unresolved } = await resolveUnknownConnectors(unknown, { session, ...resolveOptions }));
  }
  const options = { resolved, neutral: true };
  const rewriteValue = (value) => rewriteConnectorValue(value, options);
  const rewrite = (text) => rewriteConnectorText(text, options);
  if (present) {
    if (plan?.features) plan.features = rewriteValue(plan.features);
    if (plan?.warnings) plan.warnings = rewriteValue(plan.warnings);
    for (const map of [groundingByFeature, stepsByFeature, vendorByFeature]) {
      if (map instanceof Map) for (const [key, value] of map) map.set(key, rewriteValue(value));
    }
    if (enrichment) {
      if (typeof enrichment.overview === "string") enrichment.overview = rewrite(enrichment.overview);
      if (enrichment.byFeature instanceof Map) for (const [key, value] of enrichment.byFeature) enrichment.byFeature.set(key, rewriteValue(value));
    }
  }
  return { rewrite, rewriteValue, resolved: [...resolved.keys()].sort(), unresolved: [...unresolved].sort() };
}
