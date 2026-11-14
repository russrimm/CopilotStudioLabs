/**
 * Lab planner.
 *
 * Turns a wizard request (industry, roles, features, options) into a concrete,
 * ordered lab plan: scenario framing, prerequisite-expanded feature order,
 * time estimate, difficulty, and per-step numbering. Nothing here caps the
 * lab: duration is guidance, and quality and completeness win.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getFeature, getFeatures, getHarnesses, orderFeatures, getCoreFeatures } from "./catalog.js";
import { getProducts, productHasHarnesses, productName, productOf, productsPhrase } from "./products.js";
import { defaultDifferencesFor } from "./differences.js";
import { getIndustries, getRoles } from "../scenarios.js";
import { countNewTopics } from "./topic-store.js";
import { atLevel, isLevel, levelName, PREREQ_RECAP_MINUTES } from "./levels.js";
import {
  adaptProfileForDeliverable,
  buildDeliverableTitle,
  isAgentDeliverable,
  resolveDeliverableMode,
  roleDesignNoteForDeliverable,
} from "./deliverable.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const profiles = JSON.parse(fs.readFileSync(path.join(__dirname, "scenario-profiles.json"), "utf8"));

const DEFAULT_PROFILE = {
  agentName: "Team Assistant",
  domain: "everyday team operations",
  audience: "the team that owns the process",
  problem:
    "People answer the same questions repeatedly from documents and systems that live in different places, so answers are slow and inconsistent.",
  outcome:
    "an end-to-end agent that answers grounded questions, retrieves records from a system of record, and takes action on the user's behalf",
  knowledgeSources: [
    "A SharePoint library of policy and procedure documents",
    "A public product or support website",
    "A Dataverse table holding your operational records"
  ],
  sampleQuestions: [
    "What is our policy on this?",
    "What is the status of my request?",
    "Who do I contact about this?"
  ],
  entities: ["request number", "department", "date"],
  terms: ["request", "policy", "record", "approval"],
  kpi: "time spent searching for answers",
};

export const DIFFICULTY_BY_LEVEL = { 100: "Beginner", 200: "Intermediate", 300: "Advanced" };
const DEPARTMENT_ALIASES = {
  "it-operations": "it",
  "human-resources": "hr",
  support: "customer-service",
  comms: "communications",
};

function levelList(value, name) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error(`${name} must be an array.`);
  if (!value.length) return undefined;
  const nums = value.map((item) => Number(item));
  if (nums.some((n) => ![100, 200, 300].includes(n))) {
    throw new Error(`${name} must contain only 100, 200, or 300.`);
  }
  return [...new Set(nums)].sort((a, b) => a - b);
}
const MAX_TEXT_LENGTHS = {
  industry: 100,
  title: 160,
  agentName: 128,
  audience: 300,
};

function optionalText(value, name) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string.`);
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > MAX_TEXT_LENGTHS[name]) {
    throw new Error(`${name} must be at most ${MAX_TEXT_LENGTHS[name]} characters.`);
  }
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new Error(`${name} must not contain control characters or newlines.`);
  }
  return trimmed;
}

function stringList(value, name, maxItems) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array.`);
  if (value.length > maxItems) throw new Error(`${name} may contain at most ${maxItems} items.`);
  if (value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${name} must contain only non-empty strings.`);
  }
  return [...new Set(value.map((item) => item.trim()))];
}

export function normalizeLabRequest(request = {}) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("Lab request must be a JSON object.");
  }

  const features = stringList(request.features, "features", getFeatures().length + countNewTopics());
  if (!features.length) {
    throw new Error("Select at least one topic to build a lab.");
  }
  const unknownFeatures = features.filter((id) => !getFeature(id));
  if (unknownFeatures.length) {
    throw new Error(`Unknown feature id(s): ${unknownFeatures.join(", ")}.`);
  }

  // `timeBudget` is the older name. Either one is advisory: it only sets the
  // length at which the planner suggests splitting the lab into parts.
  let targetMinutes;
  const rawTarget = request.targetMinutes ?? request.timeBudget;
  if (rawTarget !== undefined && rawTarget !== null && rawTarget !== "") {
    targetMinutes = Number(rawTarget);
    if (!Number.isInteger(targetMinutes) || targetMinutes < 1) {
      throw new Error("targetMinutes must be a whole number of minutes greater than zero.");
    }
  }

  if (request.includeCore !== undefined && typeof request.includeCore !== "boolean") {
    throw new Error("includeCore must be a boolean.");
  }

  const excluded = stringList(request.excluded, "excluded", getFeatures().length + countNewTopics());
  const unknownExcluded = excluded.filter((id) => !getFeature(id));
  if (unknownExcluded.length) {
    throw new Error(`Unknown excluded feature id(s): ${unknownExcluded.join(", ")}.`);
  }

  let harnesses;
  if (request.harnesses !== undefined && request.harnesses !== null) {
    harnesses = stringList(request.harnesses, "harnesses", getHarnesses().length);
    for (const h of harnesses) {
      if (!getHarnesses().some((known) => known.id === h)) throw new Error(`Unknown harness "${h}".`);
    }
  }

  let harness;
  if (request.harness !== undefined && request.harness !== null && request.harness !== "") {
    harness = String(request.harness);
    if (!getHarnesses().some((h) => h.id === harness)) throw new Error(`Unknown harness "${harness}".`);
  } else if (harnesses?.length) {
    harness = harnesses[0];
  }

  // The products the lab covers. Omitted means the products of the selected topics, so older callers keep working.
  const knownProducts = getProducts();
  const topicProducts = [...new Set([...features, ...excluded].map((id) => productOf(getFeature(id))))];
  let products;
  if (request.products !== undefined && request.products !== null) {
    products = stringList(request.products, "products", knownProducts.length);
    const unknown = products.filter((id) => !knownProducts.some((p) => p.id === id));
    if (unknown.length) throw new Error(`Unknown product id(s): ${unknown.join(", ")}.`);
    if (!products.length) throw new Error("Select at least one product to build a lab.");
    const outside = features.filter((id) => !products.includes(productOf(getFeature(id))));
    if (outside.length) {
      throw new Error(`Topic(s) ${outside.join(", ")} belong to a product that is not selected. Add that product or remove the topic.`);
    }
  } else {
    products = knownProducts.filter((p) => topicProducts.includes(p.id)).map((p) => p.id);
  }
  // A harness only exists for a product that has harnesses. For any other lab it is not an error to send one, but it is dropped.
  let harnessDropped = false;
  if ((harness || harnesses?.length) && !products.some((id) => productHasHarnesses(id))) {
    harness = undefined;
    harnesses = undefined;
    harnessDropped = true;
  }
  const harnessOwner = harness ? getHarnesses().find((h) => h.id === harness)?.product : null;
  if (harness && harnessOwner && !products.includes(harnessOwner)) {
    throw new Error(`The harness "${harness}" belongs to ${productName(harnessOwner)}, which is not selected.`);
  }

  const levels = levelList(request.levels, "levels");
  let level;
  if (request.level !== undefined && request.level !== null && request.level !== "") {
    level = Number(request.level);
    if (![100, 200, 300].includes(level)) throw new Error("level must be 100, 200, or 300.");
  } else if (levels?.length === 1) {
    level = levels[0];
  }

  // Which other harnesses get expandable "How this differs" notes. Omitted means
  // the default counterpart; an empty list turns the notes off.
  let differencesFor;
  if (request.differencesFor !== undefined && request.differencesFor !== null) {
    differencesFor = stringList(request.differencesFor, "differencesFor", getHarnesses().length);
    const unknown = differencesFor.filter((id) => !getHarnesses().some((h) => h.id === id));
    if (unknown.length) throw new Error(`Unknown harness id(s) in differencesFor: ${unknown.join(", ")}.`);
  } else if (harnesses && harnesses.length > 1) {
    differencesFor = harnesses.slice(1);
  }

  const rawDepartments = stringList(request.departments, "departments", 50);
  const normalizedDepartments = rawDepartments.map((id) => DEPARTMENT_ALIASES[id] || id);
  const rawRoles = stringList(request.roles, "roles", 50);
  const combinedRoles = [...new Set([...normalizedDepartments, ...rawRoles])];

  return {
    industry: optionalText(request.industry, "industry"),
    departments: normalizedDepartments,
    roles: combinedRoles,
    products,
    features,
    excluded,
    harness,
    harnesses,
    harnessDropped,
    level,
    levels,
    differencesFor,
    targetMinutes,
    title: optionalText(request.title, "title"),
    agentName: optionalText(request.agentName, "agentName"),
    audience: optionalText(request.audience, "audience"),
    includeCore: request.includeCore,
  };
}

export function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function getScenarioProfile(industryId) {
  return profiles.industries[industryId] || DEFAULT_PROFILE;
}

export function getRoleProfile(roleId) {
  return profiles.roles[roleId] || null;
}

const joinWith = (items, sep = "; ") => items.join(sep);

function listNames(names) {
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/** Take items from each list in turn, so every selected department is represented before any gets a second item. */
function interleave(lists, limit) {
  const out = [];
  for (let i = 0; out.length < limit && lists.some((l) => i < l.length); i += 1) {
    for (const list of lists) if (i < list.length && out.length < limit) out.push(list[i]);
  }
  return [...new Set(out)];
}

/**
 * The scenario a lab is written around. The vertical sets the setting; the departments set the
 * use case (agent, problem, outcome, sample questions, sample data, vocabulary, and measure).
 * With no department the vertical's own scenario is used unchanged, and nothing from a
 * department that was not selected ever appears.
 */
export function composeScenarioProfile(industryId, departmentIds = [], roleOrder = [], options = {}) {
  const base = getScenarioProfile(industryId);
  const known = new Set(departmentIds);
  const depts = (roleOrder.length ? roleOrder : departmentIds)
    .filter((id) => known.has(id) && profiles.departments?.[id])
    .map((id) => profiles.departments[id]);
  const mode =
    options?.mode ||
    (options?.products || options?.features ? resolveDeliverableMode(options.products || [], options.features || []) : null);
  if (!depts.length) {
    return mode ? adaptProfileForDeliverable(base, mode) : base;
  }

  const setting = profiles.settings?.[industryId] || profiles.defaultSetting || "your organization";
  const atSetting = (text) => text.replace(/\{setting\}/g, setting);
  const names = depts.map((d) => d.name);
  const several = depts.length > 1;
  const agentName = !several ? depts[0].agentName : depts.length <= 3 ? `${listNames(names)} Assistant` : "Cross-Functional Assistant";
  const capabilities = several
    ? interleave(depts.map((d) => d.capabilities), 4)
    : depts[0].capabilities;
  const crowded = depts.length > 2;
  const composed = {
    ...base,
    agentName,
    domain: `${crowded ? `shared work across ${listNames(names)}` : joinWith(depts.map((d) => d.domain))}${industryId ? ` in ${setting}` : ""}`,
    audience: `${crowded ? `${listNames(names)} teams` : joinWith(depts.map((d) => d.audience))}${industryId ? ` in ${setting}` : ""}`,
    problem: several ? depts.map((d) => `For ${d.name}: ${atSetting(d.problem)}`).join(" ") : atSetting(depts[0].problem),
    outcome: `an end-to-end agent that ${listNames(capabilities)}`,
    knowledgeSources: interleave(depts.map((d) => d.knowledgeSources), several ? 6 : 3),
    sampleQuestions: interleave(depts.map((d) => d.sampleQuestions), several ? 6 : 3),
    entities: interleave(depts.map((d) => d.entities), 6),
    terms: interleave([...depts.map((d) => d.terms), industryId ? base.terms.slice(0, 2) : []], 8),
    kpi: joinWith(depts.slice(0, 3).map((d) => d.kpi)),
  };
  return mode ? adaptProfileForDeliverable(composed, mode, { capabilities }) : composed;
}

function formatDuration(minutes) {
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const hourLabel = `${hours} hour${hours === 1 ? "" : "s"}`;
  return rest ? `${hourLabel} ${rest} minutes` : hourLabel;
}

/** Length, in minutes, above which a lab gets a suggestion to split. Guidance only. */
export const SPLIT_SUGGESTION_MINUTES = 240;

/**
 * Time estimate for a planned lab. Every number is guidance: nothing is removed
 * to meet it. When the lab runs past the advisory length it also proposes
 * split points, cut between modules in plan order, so a module never lands in a
 * part before its prerequisites.
 */
export function buildEstimate(features, targetMinutes) {
  const totalMinutes = features.reduce((sum, f) => sum + f.minutes, 0);
  const target = targetMinutes || SPLIT_SUGGESTION_MINUTES;
  const bySection = features.map((f) => ({
    id: f.id,
    name: f.name,
    level: f.level,
    minutes: f.minutes,
    ...(f.prerequisite ? { prerequisite: true } : {}),
  }));

  let parts = [];
  if (totalMinutes > target) {
    const count = Math.ceil(totalMinutes / target);
    const goal = totalMinutes / count;
    let current = { part: 1, ids: [], minutes: 0 };
    for (const f of features) {
      const overshoot = current.minutes + f.minutes - goal;
      if (current.ids.length && overshoot > 0 && overshoot > goal - current.minutes && parts.length < count - 1) {
        parts.push(current);
        current = { part: parts.length + 1, ids: [], minutes: 0 };
      }
      current.ids.push(f.id);
      current.minutes += f.minutes;
    }
    parts.push(current);
    parts = parts.map((part) => ({ ...part, duration: formatDuration(part.minutes) }));
  }

  const splitSuggestion = parts.length > 1
    ? `This lab runs about ${formatDuration(totalMinutes)}. Consider splitting it into ${parts.length} parts of roughly ${formatDuration(
        Math.round(totalMinutes / parts.length),
      )} each. This is only a suggestion: every module you selected is included.`
    : null;

  return {
    totalMinutes,
    duration: formatDuration(totalMinutes),
    isEstimate: true,
    targetMinutes: target,
    bySection,
    suggestedParts: parts.length > 1 ? parts : [],
    splitSuggestion,
  };
}

/**
 * The level 100 core modules that match the harness the lab is about. A feature
 * with one harness tag decides it; features tagged for both harnesses stay
 * neutral, and untagged features count as standard.
 */
function coreSeedIds(requested, harness, products) {
  const harnessesOf = (feature) => (feature?.harness?.length ? feature.harness : ["standard"]);
  const targets = new Set();
  if (harness) targets.add(harness);
  else {
    for (const id of requested) {
      const tags = harnessesOf(getFeature(id));
      if (getFeature(id) && tags.length === 1) targets.add(tags[0]);
    }
  }
  if (!targets.size) targets.add("standard");
  // Core foundations are Copilot Studio modules: another product's lab never gets them as a seed.
  return getCoreFeatures()
    .filter((f) => products.includes(productOf(f)) && f.level === 100 && harnessesOf(f).some((h) => targets.has(h)))
    .map((f) => f.id);
}

/**
 * @param {object} request
 * @param {string} [request.industry]        industry id from portal/lib/scenarios.json
 * @param {string[]} [request.roles]         role ids
 * @param {string[]} request.features        feature ids from the catalog
 * @param {number} [request.targetMinutes]   advisory length; only sets when a split is suggested (alias: timeBudget)
 * @param {boolean} [request.includeCore]    add the level 100 core foundation modules. Off unless true: nothing is added that was not asked for.
 * @param {string} [request.title]           override the generated title
 * @param {string} [request.agentName]       override the scenario agent name
 * @param {string} [request.audience]        override the audience line
 */
export function planLab(request = {}) {
  request = normalizeLabRequest(request);
  const warnings = [];

  const industries = getIndustries();
  const roleCatalog = getRoles();

  const industry = industries.find((i) => i.id === request.industry) || null;
  if (request.industry && !industry) warnings.push(`Unknown industry "${request.industry}" — using a generic scenario.`);

  const roles = (request.roles || [])
    .map((id) => {
      const match = roleCatalog.find((r) => r.id === id);
      if (!match) warnings.push(`Unknown role "${id}" — ignored.`);
      return match;
    })
    .filter(Boolean);

  // The level is the single source of truth: a topic from another level is not
  // built, however it got into the request (an older saved selection, an API
  // caller). A lower-level topic comes back below only as a prerequisite recap.
  // Without a level the request is built as given, for older callers.
  const requestedLevel = request.level;
  const allowedLevels = request.levels?.length ? request.levels : requestedLevel ? [requestedLevel] : null;
  const minRequestedLevel = allowedLevels ? Math.min(...allowedLevels) : null;
  const levelSummaryLabel = allowedLevels
    ? allowedLevels.map((lvl) => levelName(lvl)).join(" / ")
    : null;
  const droppedOutOfLevel = [];
  let requested = request.features.filter((id) => !request.excluded.includes(id));
  if (allowedLevels) {
    requested = requested.filter((id) => {
      const feature = getFeature(id);
      // A Learn topic whose level could not be resolved is built only because the learner picked it from the "Level unknown" group.
      if (allowedLevels.some((lvl) => atLevel(feature, lvl)) || !isLevel(feature?.level)) return true;
      droppedOutOfLevel.push({ id, name: feature.name, level: feature.level });
      return false;
    });
    if (droppedOutOfLevel.length) {
      warnings.push(
        `${droppedOutOfLevel.length} selected topic(s) belong to another level and were not built for ${levelSummaryLabel}: ${droppedOutOfLevel
          .map((d) => `${d.name} (Level ${d.level})`)
          .join(", ")}.`,
      );
    }
    if (!requested.length) {
      throw new Error(
        `None of the selected topics are at ${levelSummaryLabel}. Choose at least one Level ${allowedLevels.join(" or ")} topic.`,
      );
    }
  }
  if (!requested.length) {
    throw new Error("Every selected topic was also marked as excluded. Keep at least one topic to build a lab.");
  }

  // Core foundations are level 100 modules. They are a seed only when the lab is at that level
  // (or has no level); at a higher level the ones a topic needs arrive as prerequisite recaps.
  // They are never added on their own: only an explicit includeCore: true brings them in, and the lab says so.
  const seedIds =
    request.includeCore !== true
      ? requested
      : [
          ...new Set([
            ...coreSeedIds(requested, request.harness, request.products).filter(
              (id) => !allowedLevels || allowedLevels.some((lvl) => atLevel(getFeature(id), lvl)),
            ),
            ...requested,
          ]),
        ].filter((id) => !request.excluded.includes(id));

  // Prerequisites join automatically so the lab stands on its own, except the
  // ones the learner explicitly turned off. Those are assumed to be done already
  // and the lab says so, instead of teaching them.
  const excludedSet = new Set(request.excluded);
  const expanded = [];
  const needers = new Map();
  const place = (id, trail) => {
    const feature = getFeature(id);
    if (!feature || expanded.includes(id) || trail.has(id)) return;
    trail.add(id);
    for (const pre of feature.prereqs || []) {
      if (excludedSet.has(pre) && !seedIds.includes(pre)) {
        if (!needers.has(pre)) needers.set(pre, []);
        needers.get(pre).push(feature.name);
        continue;
      }
      place(pre, trail);
    }
    expanded.push(id);
  };
  for (const id of seedIds) place(id, new Set());
  const assumedPrereqs = [...needers].map(([id, neededBy]) => {
    const f = getFeature(id);
    return { id, name: f.name, minutes: f.minutes, neededBy: [...new Set(neededBy)] };
  });
  if (assumedPrereqs.length) {
    warnings.push(
      `You turned off ${assumedPrereqs.length} prerequisite(s) that other topics build on, so this lab assumes learners have already done them: ${assumedPrereqs
        .map((a) => `${a.name} (needed by ${a.neededBy.join(", ")})`)
        .join("; ")}.`,
    );
  }
  const isRecap = (id) => {
    const level = getFeature(id)?.level;
    return Boolean(minRequestedLevel) && isLevel(level) && level < minRequestedLevel;
  };
  const addedCore = request.includeCore === true ? seedIds.filter((id) => !requested.includes(id)) : [];
  if (addedCore.length) {
    warnings.push(
      `Added ${addedCore.length} core foundation module(s) because you asked to include them: ${addedCore.map((id) => getFeature(id).name).join(", ")}.`,
    );
  }
  const addedPrereqs = expanded.filter((id) => !seedIds.includes(id));
  const addedSameLevel = addedPrereqs.filter((id) => !isRecap(id));
  const addedRecaps = addedPrereqs.filter(isRecap);
  if (addedSameLevel.length) {
    warnings.push(
      `Added ${addedSameLevel.length} prerequisite module(s) so the lab stands on its own: ${addedSameLevel
        .map((id) => getFeature(id).name)
        .join(", ")}.`,
    );
  }
  if (addedRecaps.length) {
    warnings.push(
      `Added ${addedRecaps.length} short prerequisite recap(s) from lower levels because topics you selected depend on them: ${addedRecaps
        .map((id) => `${getFeature(id).name} (Level ${getFeature(id).level})`)
        .join(", ")}. They are labeled as recaps, not Level ${minRequestedLevel} content, and you can turn any of them off.`,
    );
  }

  // Recaps come first. Each recap depends only on lower-level modules, so putting them ahead
  // keeps every prerequisite before the module that needs it.
  const topological = orderFeatures(expanded);
  const ordered = minRequestedLevel ? [...topological.filter(isRecap), ...topological.filter((id) => !isRecap(id))] : topological;

  const harnessesUsed = new Set(
    ordered.map((id) => getFeature(id)?.harness || []).filter((tags) => tags.length === 1).map((tags) => tags[0]),
  );
  if (request.harnessDropped) {
    warnings.push("A harness was ignored because none of the selected products has harnesses.");
  }
  if (harnessesUsed.size > 1 && !request.harness) {
    const names = [...harnessesUsed].map((id) => getHarnesses().find((h) => h.id === id)?.name || id);
    warnings.push(
      `This lab mixes ${names.join(" and ")} modules. Their steps follow different authoring surfaces, so consider building one lab per harness.`,
    );
  }
  // Length is guidance, never a limit: every selected module and every
  // prerequisite stays in the lab. A long lab only gets a suggestion to split.
  const features = ordered.map((id, index) => {
    const feature = getFeature(id);
    if (!isRecap(id)) return { ...feature, order: index + 1 };
    return {
      ...feature,
      order: index + 1,
      prerequisite: true,
      fullMinutes: feature.minutes,
      minutes: Math.min(feature.minutes, PREREQ_RECAP_MINUTES),
    };
  });

  const totalMinutes = features.reduce((sum, f) => sum + f.minutes, 0);
  const estimate = buildEstimate(features, request.targetMinutes);
  if (estimate.splitSuggestion) warnings.push(estimate.splitSuggestion);

  // The harness the lab is written for: the one chosen, or the one most of its
  // single-harness modules belong to. Modules tagged for both stay neutral.
  // A lab with no product that has harnesses has no harness at all.
  const planProducts = getProducts().map((p) => p.id).filter((id) => request.products.includes(id) || features.some((f) => productOf(f) === id));
  const harnessVotes = new Map();
  for (const f of features) if (f.harness?.length === 1) harnessVotes.set(f.harness[0], (harnessVotes.get(f.harness[0]) || 0) + 1);
  const hasHarnessProduct = planProducts.some((id) => productHasHarnesses(id));
  const labHarness = hasHarnessProduct ? request.harness || [...harnessVotes].sort((a, b) => b[1] - a[1])[0]?.[0] || "standard" : null;
  const differencesFor = labHarness ? (request.differencesFor ?? defaultDifferencesFor(labHarness)).filter((id) => id !== labHarness) : [];
  const maxLevel = features.filter((f) => !f.prerequisite).reduce((max, f) => Math.max(max, f.level || 0), 100);
  const deliverableMode = resolveDeliverableMode(planProducts, features);
  const profile = composeScenarioProfile(
    industry?.id,
    roles.map((r) => r.id),
    roleCatalog.map((r) => r.id),
    { mode: deliverableMode },
  );

  const roleProfiles = roles.map((r) => {
    const merged = { ...r, ...(getRoleProfile(r.id) || {}) };
    return { ...merged, designNote: roleDesignNoteForDeliverable(merged, deliverableMode) };
  });
  const focusNames = requested
    .map((id) => getFeature(id))
    .filter(Boolean)
    .map((f) => f.name);

  const finalAgentName = request.agentName || profile.agentName;
  const industryName = industry?.name || "Cross-industry";
  const headline = focusNames.slice(0, 2).join(" and ") || productsPhrase(planProducts) || "Microsoft AI";
  const title =
    request.title ||
    buildDeliverableTitle({
      mode: deliverableMode,
      industryName,
      deliverableName: finalAgentName,
      headline,
    });

  const categories = [...new Set(features.map((f) => f.category))];

  return {
    request: {
      industry: industry?.id || null,
      roles: roles.map((r) => r.id),
      products: planProducts,
      features: requested,
      excluded: request.excluded,
      harness: request.harness || null,
      level: request.level || null,
      droppedOutOfLevel,
      differencesFor: request.differencesFor ?? null,
      targetMinutes: request.targetMinutes ?? null,
    },
    title,
    slug: slugify(`${industry?.id || "custom"}-${finalAgentName}-${headline}`),
    industry,
    roles: roleProfiles,
    deliverable: {
      mode: deliverableMode,
      isAgent: isAgentDeliverable(deliverableMode),
    },
    profile: {
      ...profile,
      agentName: finalAgentName,
      audience: request.audience || profile.audience,
    },
    features,
    // Modules taken out after planning (see dropModules). Planning itself never defers a module.
    deferred: [],
    categories,
    totalMinutes,
    duration: formatDuration(totalMinutes),
    estimate,
    assumedPrereqs,
    prerequisites: features.filter((f) => f.prerequisite).map((f) => f.id),
    harness: labHarness,
    products: planProducts,
    productNames: planProducts.map((id) => productName(id)),
    differencesFor,
    difficulty: DIFFICULTY_BY_LEVEL[request.level || maxLevel] || "Intermediate",
    level: request.level || maxLevel,
    relatedLabs: [...new Set(features.flatMap((f) => f.relatedLabs || []))],
    tags: [...new Set([...categories, ...(industry ? [industry.id] : []), ...roles.map((r) => r.id)])],
    warnings,
  };
}

export { formatDuration };

/**
 * Remove modules from an existing plan, cascading to anything that depends on
 * them, and recompute every derived field.
 *
 * Used when a human resolves the `modules-ungrounded` blocker by dropping the
 * modules that found no documentation. The title and slug are left alone: they
 * describe what the learner asked for, not what survived.
 *
 * @param {object} plan   a plan from planLab()
 * @param {string[]} ids  module ids to remove
 * @param {string} [reason] recorded on each removed module
 * @returns {object} the same plan object, updated in place
 */
export function dropModules(plan, ids, reason = "removed") {
  const drop = new Set((ids || []).filter(Boolean));
  if (!drop.size) return plan;

  // Cascade: a module whose prerequisite is going must go too. A prerequisite recap is
  // the exception: losing a short recap never removes the module that builds on it, so the
  // lab assumes the learner already knows it instead.
  const recapIds = new Set(plan.features.filter((feature) => feature.prerequisite).map((feature) => feature.id));
  const recapsDropped = [...drop].filter((id) => recapIds.has(id));
  for (let changed = true; changed; ) {
    changed = false;
    for (const feature of plan.features) {
      if (drop.has(feature.id)) continue;
      if ((feature.prereqs || []).some((prereq) => drop.has(prereq) && !recapIds.has(prereq))) {
        drop.add(feature.id);
        changed = true;
      }
    }
  }

  const kept = plan.features.filter((feature) => !drop.has(feature.id));
  if (!kept.length) {
    throw new Error("Removing those modules would leave an empty lab. Choose a different option.");
  }

  const removed = plan.features.filter((feature) => drop.has(feature.id));
  plan.features = kept.map((feature, index) => ({ ...feature, order: index + 1 }));
  plan.deferred = [
    ...plan.deferred,
    ...removed.map((feature) => ({
      id: feature.id,
      name: feature.name,
      minutes: feature.minutes,
      summary: feature.summary,
      requested: (plan.request.features || []).includes(feature.id),
      reason,
    })),
  ];

  plan.totalMinutes = plan.features.reduce((sum, feature) => sum + feature.minutes, 0);
  plan.duration = formatDuration(plan.totalMinutes);
  plan.estimate = buildEstimate(plan.features, plan.request.targetMinutes);
  plan.level = plan.request.level || plan.features.filter((feature) => !feature.prerequisite).reduce((max, feature) => Math.max(max, feature.level || 0), 100);
  plan.difficulty = DIFFICULTY_BY_LEVEL[plan.level] || "Intermediate";
  plan.prerequisites = plan.features.filter((feature) => feature.prerequisite).map((feature) => feature.id);
  for (const id of recapsDropped) {
    const gone = removed.find((feature) => feature.id === id);
    const needers = plan.features.filter((feature) => (feature.prereqs || []).includes(id)).map((feature) => feature.name);
    plan.assumedPrereqs = [...(plan.assumedPrereqs || []), { id, name: gone.name, minutes: gone.minutes, neededBy: needers }];
  }
  plan.categories = [...new Set(plan.features.map((feature) => feature.category))];
  const nextMode = resolveDeliverableMode(plan.products, plan.features);
  plan.deliverable = { mode: nextMode, isAgent: isAgentDeliverable(nextMode) };
  plan.relatedLabs = [...new Set(plan.features.flatMap((feature) => feature.relatedLabs || []))];
  plan.tags = [
    ...new Set([
      ...plan.categories,
      ...(plan.industry ? [plan.industry.id] : []),
      ...plan.roles.map((role) => role.id),
    ]),
  ];

  return plan;
}
