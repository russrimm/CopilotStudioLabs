/**
 * Data for the Use Case Builder.
 *
 * Everything the generator knows lives in JSON next to this file: the goals and
 * data sources it offers, the capabilities a use case can need (each mapped to
 * catalog features), the use case patterns, and one context per industry and
 * department with the vocabulary that makes a pattern read like that business.
 * The industry and department lists come from scenarios.json so the portal has
 * one list of each.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getIndustries, getRoles } from "../scenarios.js";

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "data");

export const COPILOT_STUDIO = "copilot-studio";
export const AGENT_BUILDER = "m365-copilot-agent-builder";

/** The platform choice on the request, as the products it covers. */
export const PLATFORM_PRODUCTS = Object.freeze({
  both: [COPILOT_STUDIO, AGENT_BUILDER],
  "copilot-studio": [COPILOT_STUDIO],
  "agent-builder": [AGENT_BUILDER],
});

export const LEVELS = [100, 200, 300];
/** Most use cases a response lists; the rest are counted, not sent. */
export const MAX_RESULTS = 40;
/** Fewest use cases a product gets when anything exists for it, even from nearby levels. */
export const MIN_PER_PRODUCT = 3;

/** Slots every industry and department context fills, and the industry-wide vocabulary. */
export const SLOT_KEYS = ["who", "topic", "docs", "work", "data", "kpi", "ask"];
export const VOCAB_KEYS = ["org", "customer", "customers", "site", "regulations"];
export const CAPABILITY_KINDS = ["setup", "knowledge", "tool", "integration", "channel", "quality", "governance"];

let cached = null;

function readJson(...parts) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, ...parts), "utf8"));
}

function loadContexts(industries) {
  const contexts = new Map();
  for (const industry of industries) {
    const file = path.join(DATA_DIR, "industries", `${industry.id}.json`);
    if (fs.existsSync(file)) contexts.set(industry.id, JSON.parse(fs.readFileSync(file, "utf8")));
  }
  return contexts;
}

/** The loaded data. Loaded once; treat it as read-only. */
export function getUseCaseData() {
  if (cached) return cached;
  const industries = getIndustries();
  const departments = getRoles();
  const facets = readJson("facets.json");
  const capabilityFile = readJson("capabilities.json");
  const patterns = [
    ...readJson("patterns-copilot-studio.json").patterns,
    ...readJson("patterns-agent-builder.json").patterns,
    ...readJson("patterns-industry.json").patterns,
  ].map((pattern, order) => ({ ...pattern, order }));

  cached = {
    goals: facets.goals,
    dataSources: facets.dataSources,
    platforms: facets.platforms,
    efforts: facets.efforts,
    capabilities: capabilityFile.capabilities,
    bases: capabilityFile.bases,
    patterns,
    contexts: loadContexts(industries),
    industries,
    departments,
  };
  return cached;
}

export function getIndustryContext(industryId) {
  return getUseCaseData().contexts.get(industryId) || null;
}
