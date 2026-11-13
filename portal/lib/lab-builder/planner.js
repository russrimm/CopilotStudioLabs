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
import { defaultDifferencesFor } from "./differences.js";
import { getIndustries, getRoles } from "../scenarios.js";
import { countNewTopics } from "./topic-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const profiles = JSON.parse(fs.readFileSync(path.join(__dirname, "scenario-profiles.json"), "utf8"));

const DEFAULT_PROFILE = {
  agentName: "Team Assistant",
  domain: "everyday team operations",
  audience: "the team that owns the process",
  problem:
    "People answer the same questions repeatedly from documents and systems that live in different places, so answers are slow and inconsistent.",
  outcome:
    "a single agent that answers grounded questions, retrieves records from a system of record, and takes action on the user's behalf",
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
    throw new Error("Select at least one Copilot Studio feature to build a lab.");
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

  let harness;
  if (request.harness !== undefined && request.harness !== null && request.harness !== "") {
    harness = String(request.harness);
    if (!getHarnesses().some((h) => h.id === harness)) throw new Error(`Unknown harness "${harness}".`);
  }

  let level;
  if (request.level !== undefined && request.level !== null && request.level !== "") {
    level = Number(request.level);
    if (![100, 200, 300].includes(level)) throw new Error("level must be 100, 200, or 300.");
  }

  // Which other harnesses get expandable "How this differs" notes. Omitted means
  // the default counterpart; an empty list turns the notes off.
  let differencesFor;
  if (request.differencesFor !== undefined && request.differencesFor !== null) {
    differencesFor = stringList(request.differencesFor, "differencesFor", getHarnesses().length);
    const unknown = differencesFor.filter((id) => !getHarnesses().some((h) => h.id === id));
    if (unknown.length) throw new Error(`Unknown harness id(s) in differencesFor: ${unknown.join(", ")}.`);
  }

  return {
    industry: optionalText(request.industry, "industry"),
    roles: stringList(request.roles, "roles", getRoles().length),
    features,
    excluded,
    harness,
    level,
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
  const bySection = features.map((f) => ({ id: f.id, name: f.name, level: f.level, minutes: f.minutes }));

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
function coreSeedIds(requested, harness) {
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
  return getCoreFeatures()
    .filter((f) => f.level === 100 && harnessesOf(f).some((h) => targets.has(h)))
    .map((f) => f.id);
}

/**
 * @param {object} request
 * @param {string} [request.industry]        industry id from portal/lib/scenarios.json
 * @param {string[]} [request.roles]         role ids
 * @param {string[]} request.features        feature ids from the catalog
 * @param {number} [request.targetMinutes]   advisory length; only sets when a split is suggested (alias: timeBudget)
 * @param {boolean} [request.includeCore]    force-include core foundation features
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

  const requested = request.features.filter((id) => !request.excluded.includes(id));
  if (!requested.length) {
    throw new Error("Every selected topic was also marked as excluded. Keep at least one topic to build a lab.");
  }

  const seedIds = request.includeCore === false
    ? requested
    : [...new Set([...coreSeedIds(requested, request.harness), ...requested])].filter((id) => !request.excluded.includes(id));

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
  const addedPrereqs = expanded.filter((id) => !seedIds.includes(id));
  if (addedPrereqs.length) {
    warnings.push(
      `Added ${addedPrereqs.length} prerequisite module(s) so the lab stands on its own: ${addedPrereqs
        .map((id) => getFeature(id).name)
        .join(", ")}.`,
    );
  }

  const ordered = orderFeatures(expanded);

  const harnessesUsed = new Set(
    ordered.map((id) => getFeature(id)?.harness || []).filter((tags) => tags.length === 1).map((tags) => tags[0]),
  );
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
    return { ...feature, order: index + 1 };
  });

  const totalMinutes = features.reduce((sum, f) => sum + f.minutes, 0);
  const estimate = buildEstimate(features, request.targetMinutes);
  if (estimate.splitSuggestion) warnings.push(estimate.splitSuggestion);

  // The harness the lab is written for: the one chosen, or the one most of its
  // single-harness modules belong to. Modules tagged for both stay neutral.
  const harnessVotes = new Map();
  for (const f of features) if (f.harness?.length === 1) harnessVotes.set(f.harness[0], (harnessVotes.get(f.harness[0]) || 0) + 1);
  const labHarness = request.harness || [...harnessVotes].sort((a, b) => b[1] - a[1])[0]?.[0] || "standard";
  const differencesFor = (request.differencesFor ?? defaultDifferencesFor(labHarness)).filter((id) => id !== labHarness);
  const maxLevel = features.reduce((max, f) => Math.max(max, f.level), 100);
  const profile = getScenarioProfile(industry?.id);

  const roleProfiles = roles.map((r) => ({ ...r, ...(getRoleProfile(r.id) || {}) }));
  const focusNames = requested
    .map((id) => getFeature(id))
    .filter(Boolean)
    .map((f) => f.name);

  const industryName = industry?.name || "Cross-industry";
  const headline = focusNames.slice(0, 2).join(" and ") || "Copilot Studio";
  const title = request.title || `${industryName}: Build a ${profile.agentName} with ${headline}`;

  const categories = [...new Set(features.map((f) => f.category))];

  return {
    request: {
      industry: industry?.id || null,
      roles: roles.map((r) => r.id),
      features: requested,
      excluded: request.excluded,
      harness: request.harness || null,
      level: request.level || null,
      differencesFor: request.differencesFor ?? null,
      targetMinutes: request.targetMinutes ?? null,
    },
    title,
    slug: slugify(`${industry?.id || "custom"}-${profile.agentName}-${headline}`),
    industry,
    roles: roleProfiles,
    profile: {
      ...profile,
      agentName: request.agentName || profile.agentName,
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
    harness: labHarness,
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

  // Cascade: a module whose prerequisite is going must go too.
  for (let changed = true; changed; ) {
    changed = false;
    for (const feature of plan.features) {
      if (drop.has(feature.id)) continue;
      if ((feature.prereqs || []).some((prereq) => drop.has(prereq))) {
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
  plan.level = plan.request.level || plan.features.reduce((max, feature) => Math.max(max, feature.level), 100);
  plan.difficulty = DIFFICULTY_BY_LEVEL[plan.level] || "Intermediate";
  plan.categories = [...new Set(plan.features.map((feature) => feature.category))];
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
