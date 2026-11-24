/**
 * Combined-harness labs: one package that covers two Copilot Studio harnesses one after another.
 *
 * A request with `harnessMode: "both"` and an ordered pair of harness ids (default: Standard, then Microsoft Copilot)
 * is planned as ordered parts, and every module sits in exactly one part:
 *
 *   shared       topics tagged for both harnesses whose prerequisites are also shared (taught once, first)
 *   <first>      topics that apply only to the first harness
 *   <second>     topics that apply only to the second harness
 *   shared-late  a shared topic that builds on a harness-specific topic, so it must come after both harness parts
 *
 * A topic is never repeated. Where both harnesses have their own version of the same idea (two catalog topics of one
 * concept, one per harness) each version stays in its own harness part and the pair is marked as "differs", so the
 * lab and the training decks say what is different instead of explaining the idea twice.
 *
 * This file is the one place that knows how a module's harness is read, so other code (screenshot labels, decks,
 * guides) asks `harnessForModule` instead of guessing. Pure: reads only the bundled catalog.
 */

import { expandPrereqs, getFeature, getHarnesses } from "./catalog.js";
import { getConceptForFeature } from "./concepts.js";

export const COMBINED_HARNESS_MODE = "both";
export const DEFAULT_COMBINED_ORDER = Object.freeze(["standard", "microsoft-copilot"]);
export const SHARED_PART = "shared";
export const SHARED_LATE_PART = "shared-late";
export const SHARED_NOTE = "Works in either harness";

const HARNESS_TITLES = {
  standard: "Standard (Classic) harness",
  "microsoft-copilot": "Microsoft Copilot harness",
  "customer-conversation": "Customer Conversation harness",
};
const HARNESS_SHORT = {
  standard: "Standard (Classic)",
  "microsoft-copilot": "Microsoft Copilot",
  "customer-conversation": "Customer Conversation",
};
const PART_LABELS = {
  [SHARED_PART]: "Shared foundations",
  [SHARED_LATE_PART]: "Shared wrap-up",
};

/** "Standard (Classic) harness": the name a part, divider, or agenda row carries. */
export function harnessTitle(id) {
  return HARNESS_TITLES[id] || getHarnesses().find((h) => h.id === id)?.name || String(id || "");
}

/** "Standard (Classic)": the short form for tags and side-by-side columns. */
export function harnessShortName(id) {
  return HARNESS_SHORT[id] || harnessTitle(id).replace(/\s+harness$/i, "");
}

/** The label of a part: a harness title, or "Shared foundations" and "Shared wrap-up". */
export function partLabel(partId) {
  return PART_LABELS[partId] || harnessTitle(partId);
}

/** The harness tags a feature carries, with the catalog's own rule that an untagged feature is Standard. */
export function featureHarnessTags(feature) {
  return feature?.harness?.length ? feature.harness : ["standard"];
}

/** True when a plan, request, or manifest asks for the combined layout. */
export function isCombinedHarnessMode(source) {
  const mode = source?.harnessMode ?? source?.request?.harnessMode ?? source?.harnessParts?.mode;
  return mode === COMBINED_HARNESS_MODE || mode === "combined";
}

/** The ordered pair of harnesses a combined lab covers, or an empty list for any other lab. */
export function combinedHarnessOrder(source) {
  if (!isCombinedHarnessMode(source)) return [];
  const list = source?.harnesses ?? source?.request?.harnesses ?? source?.harnessParts?.order;
  return Array.isArray(list) && list.length === 2 ? [...list] : [];
}

/**
 * Split ordered module ids into the parts of a combined lab. The relative order inside a part is the order given,
 * so prerequisites (and any explicit module order) are kept. A module that belongs to neither harness is `dropped`.
 *
 * @param {string[]} orderedIds  prerequisite-expanded, ordered ids
 * @param {string[]} order       the two harness ids, first one first
 * @returns {{ids: string[], parts: {id: string, harness: string|null, label: string, ids: string[]}[], dropped: string[]}}
 */
export function partitionIntoHarnessParts(orderedIds, order = DEFAULT_COMBINED_ORDER) {
  const [first, second] = order;
  const klass = new Map();
  const dropped = [];
  for (const id of orderedIds) {
    const tags = featureHarnessTags(getFeature(id));
    const onFirst = tags.includes(first);
    const onSecond = tags.includes(second);
    if (onFirst && onSecond) klass.set(id, SHARED_PART);
    else if (onFirst) klass.set(id, first);
    else if (onSecond) klass.set(id, second);
    else dropped.push(id);
  }
  const kept = orderedIds.filter((id) => klass.has(id));

  // A shared topic that builds on a topic of only one harness cannot lead the lab: it moves after both harness parts.
  const late = new Set();
  for (let changed = true; changed; ) {
    changed = false;
    for (const id of kept) {
      if (klass.get(id) !== SHARED_PART || late.has(id)) continue;
      const needs = expandPrereqs(getFeature(id)?.prereqs || []).filter((pre) => pre !== id && klass.has(pre));
      if (needs.some((pre) => klass.get(pre) !== SHARED_PART || late.has(pre))) {
        late.add(id);
        changed = true;
      }
    }
  }
  const partOf = (id) => (late.has(id) ? SHARED_LATE_PART : klass.get(id));
  const sequence = [SHARED_PART, first, second, SHARED_LATE_PART];
  const parts = sequence
    .map((partId) => ({
      id: partId,
      harness: partId === SHARED_PART || partId === SHARED_LATE_PART ? null : partId,
      label: partLabel(partId),
      ids: kept.filter((id) => partOf(id) === partId),
    }))
    .filter((part) => part.ids.length);
  return { ids: parts.flatMap((part) => part.ids), parts, dropped };
}

/**
 * For each concept that has a topic on both harnesses (a topic of its own for each, not a shared one), the ids on each
 * side. These are the "Same idea, different place" pairs. A concept with a topic on one harness only, or only shared
 * topics, is not a pair.
 *
 * @param {string[]} ids    module ids of the lab
 * @param {string[]} order  the two harness ids
 * @returns {{conceptId: string, sides: Record<string, string[]>}[]} in first-seen order
 */
export function harnessConceptPairs(ids, order = DEFAULT_COMBINED_ORDER) {
  const [first, second] = order;
  const byConcept = new Map();
  for (const id of ids) {
    const feature = getFeature(id);
    const concept = getConceptForFeature(id);
    if (!feature || !concept) continue;
    const tags = featureHarnessTags(feature);
    const side = tags.length === 1 ? tags[0] : null;
    if (side !== first && side !== second) continue;
    if (!byConcept.has(concept.id)) byConcept.set(concept.id, { conceptId: concept.id, sides: { [first]: [], [second]: [] } });
    byConcept.get(concept.id).sides[side].push(id);
  }
  return [...byConcept.values()].filter((pair) => pair.sides[first].length && pair.sides[second].length);
}

/**
 * The record a combined lab keeps in its manifest (`manifest.harnessParts`) and in its plan. `features` are the planned
 * features after numbering, so every module order is known.
 */
export function describeHarnessParts(partitionParts, features, order = DEFAULT_COMBINED_ORDER) {
  const byId = new Map(features.map((f) => [f.id, f]));
  const parts = partitionParts.map((part, index) => {
    const mods = part.ids.map((id) => byId.get(id)).filter(Boolean);
    return {
      id: part.id,
      n: index + 1,
      label: part.label,
      harness: part.harness,
      scope: part.harness ? "harness" : "shared",
      note: part.harness ? null : SHARED_NOTE,
      moduleIds: mods.map((f) => f.id),
      orders: mods.map((f) => f.order),
      minutes: mods.reduce((sum, f) => sum + (f.minutes || 0), 0),
    };
  });
  const pairs = harnessConceptPairs(features.map((f) => f.id), order).map((pair) => ({
    concept: pair.conceptId,
    modules: Object.fromEntries(Object.entries(pair.sides).map(([h, ids]) => [h, ids])),
  }));
  return { mode: COMBINED_HARNESS_MODE, order: [...order], parts, differs: pairs };
}

/**
 * The harness fields a combined lab keeps on each manifest module record. A module written for one harness names it;
 * a shared module has `harness: null`, lists both in `harnesses`, and says "Works in either harness" (`harnessNote`).
 */
export function moduleHarnessRecord(harnessParts, feature) {
  const part = harnessParts?.parts?.find((p) => p.id === feature.harnessPart || (p.moduleIds || []).includes(feature.id));
  if (!part) return {};
  if (part.harness) return { harness: part.harness, harnessPart: part.id, harnessScope: "harness" };
  return { harness: null, harnessPart: part.id, harnessScope: "shared", harnesses: [...harnessParts.order], harnessNote: SHARED_NOTE };
}

/**
 * Which harness a module belongs to, in one answer every reader can use:
 *
 *   { part, scope, harness, harnesses, label, note }
 *
 * `scope` is "harness" for a module written for one harness, "shared" for a module that is the same in both harnesses of
 * a combined lab (`harness` is then null, `harnesses` lists both, and `note` reads "Works in either harness"), and null
 * for a lab with no harness. For a single-harness lab every module reports the lab's harness.
 *
 * @param {object} manifest   a lab's manifest.json (or a plan)
 * @param {object|number|string} ref  a manifest module record, its order number, or its id
 */
export function harnessForModule(manifest, ref) {
  const modules = Array.isArray(manifest?.modules) ? manifest.modules : Array.isArray(manifest?.features) ? manifest.features : [];
  const mod =
    ref && typeof ref === "object"
      ? ref
      : modules.find((m) => (typeof ref === "number" ? Number(m.order) === ref : m.id === ref || String(m.order) === String(ref))) || null;
  const combined = isCombinedHarnessMode(manifest);
  if (combined) {
    const order = combinedHarnessOrder(manifest);
    const part = mod?.harnessPart || manifest?.harnessParts?.parts?.find((p) => (p.moduleIds || []).includes(mod?.id))?.id || null;
    if (part === SHARED_PART || part === SHARED_LATE_PART) {
      return { part, scope: "shared", harness: null, harnesses: order, label: partLabel(part), note: SHARED_NOTE };
    }
    const harness = mod?.harness || part || null;
    return { part: part || harness, scope: harness ? "harness" : null, harness, harnesses: harness ? [harness] : order, label: harness ? harnessTitle(harness) : "", note: null };
  }
  const harness = mod?.harness || manifest?.request?.harness || manifest?.differences?.labHarness || manifest?.harness || null;
  return { part: harness, scope: harness ? "harness" : null, harness, harnesses: harness ? [harness] : [], label: harness ? harnessTitle(harness) : "", note: null };
}

/** The single harness a non-combined lab was written for, or null (a combined lab has no single harness). */
export function singleLabHarness(manifest) {
  if (isCombinedHarnessMode(manifest)) return null;
  return manifest?.request?.harness || manifest?.differences?.labHarness || manifest?.harness || null;
}

/**
 * The harness a module's text is read against when a document or deck is built: in a combined lab the module's own (a
 * shared module reads against the first harness); in any other lab the lab's harness, exactly as before.
 */
export function moduleReadingHarness(manifest, moduleRecord = null) {
  if (isCombinedHarnessMode(manifest)) return moduleRecord?.harness || combinedHarnessOrder(manifest)[0] || null;
  return manifest?.request?.harness || manifest?.differences?.labHarness || null;
}

/** The harnesses a lab covers, in order: the two of a combined lab, the one of a single-harness lab, or none. */
export function labHarnesses(manifest) {
  if (isCombinedHarnessMode(manifest)) return combinedHarnessOrder(manifest);
  const one = singleLabHarness(manifest);
  return one ? [one] : [];
}
