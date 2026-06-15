import { readFileSync } from "fs";

const SCENARIOS_PATH = new URL("./scenarios.json", import.meta.url);

const LAB_ALIAS_MAP = {
  "lab-1": "01-energy-ops-agent",
  "lab-2": "02-agent-analytics-evaluations",
  "lab-3": "03-account-orchestration-agent",
  "lab-4": "04-energy-census-advanced-agent",
  "lab-5": "05-copilot-studio-vscode-agent-management",
};

const INDUSTRY_COLORS = {
  manufacturing: "#f59e0b",
  retail: "#ec4899",
  "financial-services": "#22c55e",
  healthcare: "#ef4444",
  "energy-resources": "#06b6d4",
  education: "#8b5cf6",
  nonprofit: "#10b981",
};

let cache;

function loadScenarios() {
  if (!cache) {
    cache = JSON.parse(readFileSync(SCENARIOS_PATH, "utf-8"));
  }
  return cache;
}

function normalizeType(type) {
  if (type === "industry" || type === "industries") return "industries";
  if (type === "role" || type === "roles") return "roles";
  return null;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function toTitleList(items) {
  if (!items.length) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

function buildDescription(industry, roles) {
  const roleNames = roles.map((role) => role.name);
  return roleNames.length
    ? `${industry.description} tailored for ${toTitleList(roleNames)}.`
    : industry.description;
}

function buildTagline(industry, roles) {
  const roleNames = roles.map((role) => role.name.toLowerCase());
  return roleNames.length
    ? `Accelerating ${industry.name.toLowerCase()} outcomes for ${roleNames.join(", ")} with AI`
    : `Accelerating ${industry.name.toLowerCase()} outcomes with AI`;
}

function buildDomain(industry, roles) {
  return roles.length
    ? `${industry.name} ${roles[0].name}`
    : industry.name;
}

function buildAgentName(industry, roles) {
  return roles.length
    ? `${industry.name} ${roles[0].name} Copilot`
    : `${industry.name} Copilot`;
}

function buildEndUsers(roles) {
  if (!roles.length) return "business teams";
  if (roles.length === 1) return `${roles[0].name.toLowerCase()} teams`;
  return `${roles[0].name.toLowerCase()} and cross-functional teams`;
}

export function getIndustries() {
  return loadScenarios().industries;
}

export function getRoles() {
  return loadScenarios().roles;
}

export function getScenario(type, id) {
  const bucket = normalizeType(type);
  if (!bucket) return null;
  return loadScenarios()[bucket].find((item) => item.id === id) || null;
}

export function getSuggestedConfig(industryId, roleIds = []) {
  const industry = getScenario("industry", industryId);
  if (!industry) return null;

  const roles = roleIds
    .map((roleId) => getScenario("role", roleId))
    .filter(Boolean);

  const suggestedLabAliases = unique([
    ...industry.suggestedLabs,
    ...roles.flatMap((role) => role.suggestedLabs || []),
  ]);

  const useCases = unique([
    ...industry.categories.map((category) => category.description),
    ...roles.flatMap((role) => role.categories.map((category) => category.description)),
  ]);

  const kpis = unique([
    ...industry.kpis,
    ...roles.flatMap((role) => role.kpis || []),
  ]);

  return {
    organization: {
      industry: industry.name,
      description: buildDescription(industry, roles),
    },
    branding: {
      primaryColor: INDUSTRY_COLORS[industry.id] || "#4f8ff7",
      tagline: buildTagline(industry, roles),
    },
    scenario: {
      industry: industry.id,
      roles: roles.map((role) => role.id),
      kpis,
      description: buildDescription(industry, roles),
      domain: buildDomain(industry, roles),
      agentName: buildAgentName(industry, roles),
      endUsers: buildEndUsers(roles),
      useCases,
    },
    labs: {
      include: suggestedLabAliases.map((labId) => LAB_ALIAS_MAP[labId]).filter(Boolean),
      suggested: suggestedLabAliases,
    },
  };
}
