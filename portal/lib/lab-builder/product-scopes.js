/**
 * What a person chooses when they add a product they found by searching Microsoft Learn (see product-api.js).
 *
 * A search hit is one page, but a product is a documentation hub: "use everything under" an address on Learn. Each page's
 * address holds several such addresses (its path prefixes), and topic discovery follows only links under the one chosen, so a
 * wider address means more topics from more areas and a narrower one means fewer, more focused topics. This module turns the
 * hits into one group per hub, each with the possible scopes from widest to narrowest, a plain name for each, one recommended
 * choice, and the scopes that an existing product already covers. Pages that are not product documentation are left out.
 *
 * The recommendation (the same rule is written in docs/lab-builder.md), applied to the scopes no product covers yet:
 *   1. The shallowest one that is a reviewed hub (an entry of product-picklist.json). A reviewed hub is known to be a product.
 *   2. Otherwise the shallowest one that is not a single-level umbrella root. relevance.js lists the roots (azure,
 *      microsoft-365, dynamics365, power-platform, and so on) that hold many unrelated products, so choosing one would pull
 *      in topics from all of them. Going shallow-first also never picks the deepest level over a wider real hub, and that
 *      deepest level is usually a folder of a few articles.
 *   3. When only umbrella roots are left, the narrowest of them (it is then the only honest answer, and its note says it is broad).
 * Nothing that an existing product covers is ever recommended. When every scope is covered the group offers nothing to add.
 */

import { isUmbrellaRoot } from "./relevance.js";
import { cleanText, MAX_TITLE, normalizeLearnUrl } from "./topic-sanitize.js";

const HOST = "https://learn.microsoft.com";

/** How many path prefixes of one page's address are offered as scopes, shortest first. */
export const MAX_SCOPES = 4;

/**
 * First path segments on Microsoft Learn that are not product documentation, with the plain name shown in the one quiet
 * "Hidden" line. A hit under one of these is not offered, and the add route refuses the address: Q&A threads are questions
 * and answers from people, training modules and learning paths teach one course each (their pages are units, not a
 * documentation set), and the others are events, videos, code browsers, profiles, or lists. A search for "sharepoint" returns
 * a Q&A thread (/answers/a/...), and one for "Dynamics 365 Sales" returns mostly training modules and paths.
 */
const NOT_DOCUMENTATION = new Map([
  ["answers", "Microsoft Q&A threads"],
  ["community", "community posts"],
  ["events", "events"],
  ["shows", "videos and shows"],
  ["training", "training modules and learning paths"],
  ["credentials", "certifications"],
  ["certifications", "certifications"],
  ["samples", "code samples"],
  ["users", "profiles"],
  ["collections", "collections"],
  ["assessments", "assessments"],
  ["lifecycle", "support lifecycle pages"],
]);

function segmentsOf(url) {
  return new URL(url).pathname.split("/").filter(Boolean);
}

/** The plain name of what a Learn address is when it is not product documentation, or null when it may be a product. */
export function nonDocumentationKind(rawUrl) {
  const normalized = normalizeLearnUrl(String(rawUrl || ""));
  if (!normalized) return null;
  return NOT_DOCUMENTATION.get(segmentsOf(normalized)[0]) || null;
}

/**
 * The addresses a page could be the start of: its path prefixes, shortest first, at most four. A page's own address is one of
 * them only when it starts a folder: the address ends with a slash (training modules and documentation landing pages do) or
 * is a single segment. An article's own address is not a hub, and offering it would add one page as a product.
 */
export function candidateRoots(rawUrl) {
  const normalized = normalizeLearnUrl(String(rawUrl || ""));
  if (!normalized) return [];
  const segments = segmentsOf(normalized);
  let startsFolder = segments.length === 1;
  try {
    startsFolder = startsFolder || new URL(String(rawUrl).trim()).pathname.endsWith("/");
  } catch {
    /* normalizeLearnUrl already accepted it */
  }
  const depth = Math.min(MAX_SCOPES, startsFolder ? segments.length : segments.length - 1);
  const roots = [];
  for (let level = 1; level <= depth; level += 1) roots.push(`${HOST}/${segments.slice(0, level).join("/")}`);
  return roots;
}

// ── Readable names ────────────────────────────────────────────────────────────

const WHOLE_SEGMENTS = new Map(
  Object.entries({
    sharepoint: "SharePoint",
    onedrive: "OneDrive",
    powershell: "PowerShell",
    devops: "DevOps",
    github: "GitHub",
    dotnet: ".NET",
    aspnet: "ASP.NET",
    microsoftteams: "Microsoft Teams",
    m365: "Microsoft 365",
    dynamics365: "Dynamics 365",
    "sp-add-ins": "SharePoint Add-ins",
  }),
);

const WORDS = new Map(
  Object.entries({
    ai: "AI",
    api: "API",
    apis: "APIs",
    bi: "BI",
    cli: "CLI",
    iot: "IoT",
    mcp: "MCP",
    ml: "ML",
    sdk: "SDK",
    sql: "SQL",
    sso: "SSO",
    ui: "UI",
    vm: "VM",
    vms: "VMs",
    sharepoint: "SharePoint",
    onedrive: "OneDrive",
    powershell: "PowerShell",
    github: "GitHub",
    devops: "DevOps",
  }),
);

const SMALL_WORDS = new Set(["a", "an", "and", "as", "at", "by", "for", "in", "of", "on", "or", "the", "to", "with"]);

/** One path segment as a person would write it: "host-integration-server" is "Host Integration Server". */
export function humanizeSegment(segment) {
  let text = String(segment || "");
  try {
    text = decodeURIComponent(text);
  } catch {
    /* keep it as it came */
  }
  text = text.toLowerCase().slice(0, 60);
  if (WHOLE_SEGMENTS.has(text)) return WHOLE_SEGMENTS.get(text);
  const words = text
    .replace(/add-ins?/g, (match) => (match.endsWith("s") ? "addins" : "addin"))
    .replace(/how-to/g, "howto")
    .replace(/([a-z])(\d)/g, "$1-$2")
    .split(/[-_\s.]+/)
    .filter(Boolean);
  return words
    .map((word, index) => {
      if (word === "addins") return "Add-ins";
      if (word === "addin") return "Add-in";
      if (word === "howto") return "How-to";
      if (WORDS.has(word)) return WORDS.get(word);
      if (index > 0 && SMALL_WORDS.has(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

/**
 * A function that names a Learn address in plain words. A reviewed hub, a built-in product, or a product you added is named
 * for itself ("Dynamics 365 Sales"); an address under a reviewed hub or one of your products reads "Dynamics 365 Sales >
 * Administer"; anything else is its path read as words ("Host Integration Server > Core").
 * @param {{ named?: Array<{name: string, root: string}>, products?: Array<{name: string, learnRoots?: string[]}> }} sources
 *   `named`: the reviewed picklist and the products you added (they can also name what is under them);
 *   `products`: every product, whose names are used for an exact match only.
 */
export function createNamer({ named = [], products = [] } = {}) {
  const exact = new Map();
  for (const product of products) {
    for (const raw of product.learnRoots || []) {
      const root = normalizeLearnUrl(raw);
      if (root && !exact.has(root)) exact.set(root, product.name);
    }
  }
  const ancestors = [];
  for (const entry of named) {
    const root = normalizeLearnUrl(entry.root);
    if (!root || !entry.name) continue;
    exact.set(root, entry.name);
    ancestors.push({ root, name: entry.name });
  }
  ancestors.sort((a, b) => b.root.length - a.root.length);
  return (root) => {
    if (exact.has(root)) return exact.get(root);
    const parent = ancestors.find((entry) => root.startsWith(`${entry.root}/`));
    const rest = segmentsOf(root).slice(parent ? segmentsOf(parent.root).length : 0);
    const path = rest.map(humanizeSegment).join(" > ");
    return parent ? `${parent.name} > ${path}` : path;
  };
}

// ── A product you added, as its card describes it ─────────────────────────────

/**
 * Titles of landing pages that say nothing about a product. A product added from a hub is named for the hub page's title, so
 * one of these (or a question, see looksGenericName) can end up as a product's name.
 */
const GENERIC_NAMES = new Set([
  "browse",
  "documentation",
  "docs",
  "get started",
  "getting started",
  "home",
  "index",
  "introduction",
  "learn",
  "microsoft learn",
  "overview",
  "start here",
  "tutorials",
  "welcome",
]);

/** True for a name that does not say what the product is: a question ("What do you need help with today?") or a bare landing page title ("Overview"). */
export function looksGenericName(name) {
  const text = String(name || "").replace(/\s+/g, " ").trim();
  return Boolean(text) && (text.endsWith("?") || GENERIC_NAMES.has(text.toLowerCase().replace(/[.!:]+$/, "")));
}

/** A Learn address the way a person reads it, without the scheme: "learn.microsoft.com/power-bi". */
export function learnAddress(rawUrl) {
  const normalized = normalizeLearnUrl(String(rawUrl || ""));
  return normalized ? normalized.replace(/^https:\/\//, "") : "";
}

/**
 * What the Product step shows about a product you added, beyond what is saved: its address, when it was added (the saved entry
 * has `addedAt`; an older one may not), the plain name of what its address is when that is not product documentation (the same
 * rule that refuses to add one, so a product added before the rule existed is flagged, never changed or removed), and, for a
 * generic name, the product's address read as words so the person can tell what it is.
 * @param {{name: string, learnHubUrl?: string, learnRoots?: string[], addedAt?: string}} product
 * @param {(root: string) => string} nameOf a namer from createNamer
 */
export function describeAddedProduct(product, nameOf) {
  const roots = [...new Set([product.learnHubUrl, ...(product.learnRoots || [])].filter(Boolean))];
  const notDocumentation = roots.map(nonDocumentationKind).find(Boolean) || null;
  const readable = !notDocumentation && looksGenericName(product.name) && roots[0] ? nameOf(normalizeLearnUrl(roots[0]) || roots[0]) : "";
  const added = Date.parse(product.addedAt || "");
  const plain = (text) => String(text).trim().replace(/[.?!:]+$/, "").toLowerCase();
  return {
    address: learnAddress(roots[0]),
    addedAt: Number.isFinite(added) ? new Date(added).toISOString() : null,
    notDocumentation,
    alsoKnownAs: readable && plain(readable) !== plain(product.name) ? readable : null,
  };
}

// ── The recommended scope ─────────────────────────────────────────────────────

/** True for a one-level address such as /azure whose documentation holds many unrelated products, unless it is a reviewed hub. */
function isBroadUmbrella(scope, hubRoots) {
  return scope.depth === 1 && isUmbrellaRoot(segmentsOf(scope.root)[0]) && !hubRoots.has(scope.root);
}

/** The scope to preselect (see the rule at the top of this file), or null when every scope is covered. `scopes` run shallow to deep. */
export function pickRecommended(scopes, hubRoots = new Set()) {
  const open = scopes.filter((scope) => !scope.coveredBy);
  if (!open.length) return null;
  return open.find((scope) => hubRoots.has(scope.root)) || open.find((scope) => !isBroadUmbrella(scope, hubRoots)) || open[open.length - 1];
}

const NOTES = {
  recommended: "Everything in this product's documentation: the best size for one product.",
  recommendedBroad: "The only choice left, and it is broad: this area holds many separate products.",
  broad: "Very broad: this area holds many separate products, so you would get topics from all of them.",
  wider: "Wider than the recommendation: more topics, from more areas.",
  narrower: "Only this part: fewer, more focused topics.",
};

function describeScopes(scopes, { nameOf, hubRoots }) {
  const pick = pickRecommended(scopes, hubRoots);
  const at = pick ? scopes.indexOf(pick) : -1;
  return scopes.map((scope, index) => {
    let kind = "covered";
    let note = `Already covered by ${scope.coveredBy}.`;
    if (!scope.coveredBy) {
      kind = index === at ? "recommended" : index > at ? "narrower" : isBroadUmbrella(scope, hubRoots) ? "broad" : "wider";
      note = kind === "recommended" && isBroadUmbrella(scope, hubRoots) ? NOTES.recommendedBroad : NOTES[kind];
    }
    return {
      root: scope.root,
      path: new URL(scope.root).pathname,
      label: nameOf(scope.root),
      kind,
      note,
      coveredBy: scope.coveredBy || null,
      recommended: index === at,
    };
  });
}

/**
 * Group search hits by documentation hub.
 * @param {Array<{title?: string, url?: string}>} found the pages Learn returned, best match first
 * @param {{ coveredBy: (root: string) => string|null, nameOf: (root: string) => string, hubRoots?: Set<string> }} context
 *   `coveredBy` names the existing product whose Learn roots overlap an address (or null); `nameOf` is a namer from createNamer;
 *   `hubRoots` holds the reviewed hubs' addresses.
 * @returns {{ groups: Array<object>, hidden: { count: number, kinds: string[] } }} groups with a choice come first (best match first),
 *   then groups that are fully covered; `hidden` counts the pages left out because they are not product documentation.
 */
export function groupSearchResults(found, { coveredBy, nameOf, hubRoots = new Set() }) {
  const hiddenKinds = new Map();
  let hiddenCount = 0;
  const seen = new Set();
  const groups = new Map();
  for (const item of found || []) {
    const url = normalizeLearnUrl(String(item?.url || ""));
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const kind = nonDocumentationKind(url);
    if (kind) {
      hiddenCount += 1;
      hiddenKinds.set(kind, (hiddenKinds.get(kind) || 0) + 1);
      continue;
    }
    const scopes = candidateRoots(String(item.url)).map((root) => ({ root, depth: segmentsOf(root).length, coveredBy: coveredBy(root) }));
    if (!scopes.length) continue;
    // Pages whose best scope is the same address are one hub; a page with nothing left to add is grouped by its widest address.
    const key = (pickRecommended(scopes, hubRoots) || scopes[0]).root;
    if (!groups.has(key)) groups.set(key, { key, pages: [], scopes: new Map() });
    const group = groups.get(key);
    group.pages.push({ title: cleanText(String(item?.title || ""), MAX_TITLE) || url, url });
    for (const scope of scopes) if (!group.scopes.has(scope.root)) group.scopes.set(scope.root, scope);
  }

  const built = [...groups.values()].map((group) => {
    const ordered = [...group.scopes.values()].sort((a, b) => a.depth - b.depth || a.root.localeCompare(b.root));
    const scopes = describeScopes(ordered, { nameOf, hubRoots });
    const allCovered = !scopes.some((scope) => scope.recommended);
    return {
      key: group.key,
      name: nameOf(group.key),
      pages: group.pages,
      allCovered,
      coveredBy: [...new Set(scopes.map((scope) => scope.coveredBy).filter(Boolean))],
      scopes,
    };
  });
  const kinds = [...hiddenKinds.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([kind]) => kind);
  return { groups: [...built.filter((group) => !group.allCovered), ...built.filter((group) => group.allCovered)], hidden: { count: hiddenCount, kinds } };
}
