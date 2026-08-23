/**
 * Lab planner.
 *
 * Turns a wizard request (industry, roles, features, options) into a concrete,
 * ordered lab plan: scenario framing, prerequisite-expanded feature order,
 * time budget, difficulty, and per-step numbering.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getFeature, getFeatures, expandPrereqs, orderFeatures, getCoreFeatures } from "./catalog.js";
import { getIndustries, getRoles } from "../scenarios.js";

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

  const features = stringList(request.features, "features", getFeatures().length);
  if (!features.length) {
    throw new Error("Select at least one Copilot Studio feature to build a lab.");
  }
  const unknownFeatures = features.filter((id) => !getFeature(id));
  if (unknownFeatures.length) {
    throw new Error(`Unknown feature id(s): ${unknownFeatures.join(", ")}.`);
  }

  let timeBudget;
  if (request.timeBudget !== undefined && request.timeBudget !== null && request.timeBudget !== "") {
    timeBudget = Number(request.timeBudget);
    if (!Number.isInteger(timeBudget) || timeBudget < 30 || timeBudget > 1440) {
      throw new Error("timeBudget must be a whole number from 30 to 1440 minutes.");
    }
  }

  if (request.includeCore !== undefined && typeof request.includeCore !== "boolean") {
    throw new Error("includeCore must be a boolean.");
  }

  return {
    industry: optionalText(request.industry, "industry"),
    roles: stringList(request.roles, "roles", getRoles().length),
    features,
    timeBudget,
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

/**
 * @param {object} request
 * @param {string} [request.industry]        industry id from portal/lib/scenarios.json
 * @param {string[]} [request.roles]         role ids
 * @param {string[]} request.features        feature ids from the catalog
 * @param {number} [request.timeBudget]      max minutes; extra features are deferred
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

  const requested = request.features;

  const seedIds = request.includeCore === false
    ? requested
    : [...new Set([...getCoreFeatures().filter((f) => f.level === 100).map((f) => f.id), ...requested])];

  const expanded = expandPrereqs(seedIds);
  const addedPrereqs = expanded.filter((id) => !seedIds.includes(id));
  if (addedPrereqs.length) {
    warnings.push(
      `Added ${addedPrereqs.length} prerequisite module(s) so the lab stands on its own: ${addedPrereqs
        .map((id) => getFeature(id).name)
        .join(", ")}.`,
    );
  }

  const ordered = orderFeatures(expanded);

  // Apply the time budget, but never drop a feature another kept feature depends on.
  const budget = Number(request.timeBudget) > 0 ? Number(request.timeBudget) : Infinity;
  const kept = [];
  const deferred = [];
  let running = 0;
  for (const id of ordered) {
    const feature = getFeature(id);
    const required = feature.prereqs?.some((p) => kept.includes(p)) || feature.level === 100;
    if (running + feature.minutes <= budget || (kept.length === 0 && required)) {
      kept.push(id);
      running += feature.minutes;
    } else {
      deferred.push(id);
    }
  }
  // Drop anything whose prerequisite got deferred.
  const keptSet = new Set(kept);
  const finalIds = kept.filter((id) => (getFeature(id).prereqs || []).every((p) => !ordered.includes(p) || keptSet.has(p)));
  const finalDeferred = [...deferred, ...kept.filter((id) => !finalIds.includes(id))];
  if (!finalIds.length) {
    throw new Error("The time budget is too small for the selected modules. Increase it or include core modules.");
  }

  if (finalDeferred.length) {
    warnings.push(
      `${finalDeferred.length} module(s) did not fit the ${budget}-minute budget and are listed as next steps: ${finalDeferred
        .map((id) => getFeature(id).name)
        .join(", ")}.`,
    );
  }

  const features = finalIds.map((id, index) => {
    const feature = getFeature(id);
    return { ...feature, order: index + 1 };
  });

  const totalMinutes = features.reduce((sum, f) => sum + f.minutes, 0);
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
      timeBudget: Number.isFinite(budget) ? budget : null,
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
    deferred: finalDeferred.map((id) => {
      const f = getFeature(id);
      return {
        id: f.id,
        name: f.name,
        minutes: f.minutes,
        summary: f.summary,
        // Dropping something the learner explicitly asked for is a decision;
        // dropping a module we added on their behalf is only a note.
        requested: requested.includes(id),
        reason: "time-budget",
      };
    }),
    categories,
    totalMinutes,
    duration: formatDuration(totalMinutes),
    difficulty: DIFFICULTY_BY_LEVEL[maxLevel] || "Intermediate",
    level: maxLevel,
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
  plan.level = plan.features.reduce((max, feature) => Math.max(max, feature.level), 100);
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
