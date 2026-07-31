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

import { getFeature, expandPrereqs, orderFeatures, getCoreFeatures } from "./catalog.js";
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

  const requested = (request.features || []).filter(Boolean);
  if (!requested.length) {
    throw new Error("Select at least one Copilot Studio feature to build a lab.");
  }

  const seedIds = request.includeCore === false
    ? requested
    : [...new Set([...getCoreFeatures().filter((f) => f.level === 100).map((f) => f.id), ...requested])];

  const unknown = requested.filter((id) => !getFeature(id));
  for (const id of unknown) warnings.push(`Unknown feature "${id}" — ignored.`);

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
      return { id: f.id, name: f.name, minutes: f.minutes, summary: f.summary };
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
