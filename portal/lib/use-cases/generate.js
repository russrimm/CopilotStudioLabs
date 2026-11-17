/**
 * Use case generation: validate the request, build every candidate, score and
 * rank it, pick a varied top list per product, and describe what was and was
 * not covered. Pure, deterministic, and offline: the same request always gives
 * the same list in the same order.
 *
 * Ranking is a sum of explainable matches (industry, department, goals, data
 * sources, level) minus small penalties for Preview, third-party, and data the
 * user did not list. Ties break on level, then pattern order, then id. A
 * variety pass then spreads the list across patterns and departments so a broad
 * selection is not twelve copies of one idea.
 */

import { getProduct } from "../lab-builder/products.js";
import { buildUseCase, useCaseId } from "./build.js";
import { LEVELS, MAX_RESULTS, MIN_PER_PRODUCT, PLATFORM_PRODUCTS, getUseCaseData } from "./data.js";
import { levelLabel, resolvePattern } from "./resolve.js";

export const REQUEST_FIELDS = Object.freeze(["industry", "departments", "goals", "dataSources", "platform", "level", "polish"]);

/** A request the caller can fix: the API answers it with HTTP 400. */
export class UseCaseRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = "UseCaseRequestError";
    this.status = 400;
  }
}

/** A value from the request, made safe to quote back in an error message. */
function quoted(value) {
  const text = String(value).slice(0, 40);
  return `"${/^[A-Za-z0-9_-]*$/.test(text) ? text : "(invalid value)"}"`;
}

export function limits() {
  const data = getUseCaseData();
  return {
    maxDepartments: data.departments.length,
    maxGoals: data.goals.length,
    maxDataSources: data.dataSources.length,
    maxResults: MAX_RESULTS,
    maxBodyBytes: 64 * 1024,
  };
}

function idList(value, { name, singular, allowed, max }) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new UseCaseRequestError(`${name} must be an array of ids.`);
  if (value.length > max) throw new UseCaseRequestError(`${name} can include at most ${max} values.`);
  const known = new Set(allowed);
  const picked = new Set();
  for (const entry of value) {
    if (typeof entry !== "string") throw new UseCaseRequestError(`${name} must contain only text ids.`);
    if (!known.has(entry)) throw new UseCaseRequestError(`Unknown ${singular} ${quoted(entry)}. Valid values: ${allowed.join(", ")}.`);
    picked.add(entry);
  }
  // Canonical order, so the same selection always gives the same list.
  return allowed.filter((id) => picked.has(id));
}

/**
 * Validate and normalize a request. Throws UseCaseRequestError on any unknown or
 * malformed value; nothing is guessed or silently dropped.
 */
export function normalizeRequest(input) {
  const data = getUseCaseData();
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new UseCaseRequestError("The request body must be a JSON object.");
  for (const key of Object.keys(input)) {
    if (!REQUEST_FIELDS.includes(key)) throw new UseCaseRequestError(`Unknown field ${quoted(key)}. Allowed fields: ${REQUEST_FIELDS.join(", ")}.`);
  }

  const industryIds = data.industries.map((i) => i.id);
  if (typeof input.industry !== "string" || !input.industry) throw new UseCaseRequestError("industry is required.");
  if (!industryIds.includes(input.industry)) throw new UseCaseRequestError(`Unknown industry ${quoted(input.industry)}. Valid values: ${industryIds.join(", ")}.`);

  const platform = input.platform === undefined || input.platform === null ? "both" : input.platform;
  if (typeof platform !== "string" || !Object.hasOwn(PLATFORM_PRODUCTS, platform)) {
    throw new UseCaseRequestError(`Unknown platform ${quoted(platform)}. Valid values: ${Object.keys(PLATFORM_PRODUCTS).join(", ")}.`);
  }
  const level = input.level === undefined || input.level === null ? null : input.level;
  if (level !== null && !LEVELS.includes(level)) throw new UseCaseRequestError(`level must be null, ${LEVELS.join(", ")}.`);
  if (input.polish !== undefined && typeof input.polish !== "boolean") throw new UseCaseRequestError("polish must be true or false.");

  return {
    industry: input.industry,
    departments: idList(input.departments, { name: "departments", singular: "department", allowed: data.departments.map((d) => d.id), max: data.departments.length }),
    goals: idList(input.goals, { name: "goals", singular: "goal", allowed: data.goals.map((g) => g.id), max: data.goals.length }),
    dataSources: idList(input.dataSources, { name: "dataSources", singular: "data source", allowed: data.dataSources.map((s) => s.id), max: data.dataSources.length }),
    platform,
    level,
    polish: input.polish === true,
  };
}

const appliesToIndustry = (pattern, industryId) => !pattern.industries || pattern.industries.includes("*") || pattern.industries.includes(industryId);
const appliesToDepartment = (pattern, departmentId) => pattern.departments.includes("*") || pattern.departments.includes(departmentId);
const isIndustrySpecific = (pattern) => Boolean(pattern.industries && !pattern.industries.includes("*"));
const isDepartmentSpecific = (pattern) => !pattern.departments.includes("*") && pattern.departments.length <= 4;

/** Score one candidate and say why. Every term is a reason the UI can show. */
function score(request, pattern, resolved, departmentId, data) {
  const goalLabel = (id) => data.goals.find((g) => g.id === id).label;
  const sourceLabel = (id) => data.dataSources.find((s) => s.id === id).label;
  const departmentName = data.departments.find((d) => d.id === departmentId).name;
  const reasons = [];
  let total = 20;

  if (isIndustrySpecific(pattern)) {
    total += 12;
    reasons.push(`Written for ${data.industries.find((i) => i.id === request.industry).name}`);
  }
  if (request.departments.length) {
    total += 16;
    reasons.push(`Built for ${departmentName}`);
  }
  if (isDepartmentSpecific(pattern)) total += 2;

  for (const goal of request.goals) {
    if (pattern.goals[0] === goal) {
      total += 16;
      reasons.push(`Main goal: ${goalLabel(goal)}`);
    } else if (pattern.goals.includes(goal)) {
      total += 10;
      reasons.push(`Also supports: ${goalLabel(goal)}`);
    }
  }

  const wanted = request.dataSources.filter((id) => id !== "none");
  const missingData = [];
  if (wanted.length) {
    const matched = wanted.filter((id) => pattern.dataSources.includes(id));
    for (const id of matched) {
      total += 10;
      reasons.push(`Uses ${sourceLabel(id)}`);
    }
    if (!matched.length && !pattern.dataSources.includes("none")) {
      total -= 10;
      missingData.push(...pattern.dataSources.filter((id) => id !== "none"));
    }
  }
  if (request.dataSources.includes("none")) {
    if (pattern.dataSources.includes("none")) {
      total += 14;
      reasons.push("Works before any data is prepared");
    } else {
      total -= 6;
      missingData.push(...pattern.dataSources.filter((id) => id !== "none"));
    }
  }

  if (request.level && resolved.level === request.level) {
    total += 12;
    reasons.push(`Matches your skill level (${levelLabel(request.level)})`);
  }

  const flagged = resolved.features;
  if (flagged.some((f) => f.availability === "preview")) total -= 4;
  if (flagged.some((f) => f.thirdPartyConnector)) {
    // A third-party connector is optional unless the user said they have a line-of-business system.
    if (request.dataSources.includes("lob")) total += 6;
    else total -= 4;
  }

  return { score: total, reasons, missingData: [...new Set(missingData)] };
}

function allocate(sizes, max) {
  const keys = Object.keys(sizes);
  const half = Math.floor(max / keys.length);
  const caps = Object.fromEntries(keys.map((key) => [key, Math.min(sizes[key], half)]));
  let spare = max - keys.reduce((sum, key) => sum + caps[key], 0);
  for (const key of keys) {
    const extra = Math.min(spare, sizes[key] - caps[key]);
    caps[key] += extra;
    spare -= extra;
  }
  return caps;
}

const byRank = (a, b) => b.score - a.score || a.level - b.level || a.pattern.order - b.pattern.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The best candidates first, with repeats of one pattern or department pushed down so the list stays varied. */
function pickVaried(pool, cap, accept) {
  const remaining = [...pool].sort(byRank);
  const patterns = new Map();
  const departments = new Map();
  const picked = [];
  while (picked.length < cap && remaining.length) {
    let bestIndex = 0;
    let bestValue = -Infinity;
    remaining.forEach((candidate, index) => {
      const value = candidate.score - 6 * (patterns.get(candidate.pattern.id) || 0) - 2 * (departments.get(candidate.departmentId) || 0);
      if (value > bestValue) {
        bestValue = value;
        bestIndex = index;
      }
    });
    const [candidate] = remaining.splice(bestIndex, 1);
    if (!accept(candidate)) continue;
    picked.push(candidate);
    patterns.set(candidate.pattern.id, (patterns.get(candidate.pattern.id) || 0) + 1);
    departments.set(candidate.departmentId, (departments.get(candidate.departmentId) || 0) + 1);
  }
  return picked;
}

function countBy(items, keyOf) {
  const counts = {};
  for (const item of items) for (const key of [].concat(keyOf(item))) counts[key] = (counts[key] || 0) + 1;
  return counts;
}

function plural(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

function coverageNotes({ request, data, matched, returned, levelNotes, excluded, useCases }) {
  const notes = [];
  if (!request.departments.length) notes.push("No department is selected, so the list spans every department. Pick one or more departments to focus it.");
  if (matched > returned) notes.push(`Showing the best ${returned} of ${matched} matching use cases. Narrow the departments, goals, or level to see the rest.`);
  notes.push(...levelNotes);

  const wantsAgentBuilder = request.platform !== "copilot-studio";
  const unsupported = request.dataSources.filter((id) => id === "dataverse" || id === "lob");
  if (wantsAgentBuilder && unsupported.length) {
    const names = unsupported.map((id) => data.dataSources.find((s) => s.id === id).label).join(" and ");
    notes.push(
      `Agent Builder works with SharePoint and OneDrive content, public websites, Teams chats and meetings, email, and uploaded files. ${names} ${unsupported.length === 1 ? "is" : "are"} reached through Copilot Studio, so those use cases appear under Copilot Studio.`,
    );
  }
  if (request.platform === "agent-builder" && unsupported.length === request.dataSources.filter((id) => id !== "none").length && unsupported.length) {
    notes.push("None of the data you listed can be used by Agent Builder directly, so these use cases start from documents, public websites, Teams, or email instead.");
  }
  const missing = useCases.filter((u) => u.match.missingData.length).length;
  if (missing) notes.push(`${plural(missing, "use case")} need${missing === 1 ? "s" : ""} data you did not list. They rank lower and are marked.`);
  const preview = useCases.filter((u) => u.flags.preview).length;
  if (preview) notes.push(`${plural(preview, "use case")} include${preview === 1 ? "s" : ""} Preview capabilities. Their availability and behavior can change.`);
  const thirdParty = useCases.filter((u) => u.flags.thirdParty).length;
  if (thirdParty) notes.push(`${plural(thirdParty, "use case")} use${thirdParty === 1 ? "s" : ""} a third-party connector. Confirm the connection and licensing with the vendor.`);
  if (excluded) notes.push(`${plural(excluded, "pattern")} ${excluded === 1 ? "was" : "were"} left out because the feature catalog does not support ${excluded === 1 ? "it" : "them"} on the chosen harness.`);
  return notes;
}

/**
 * Generate the ranked use cases for a request.
 *
 * @param {object} input the raw request; validated by normalizeRequest
 * @returns {object} the response: useCases, groups, bestMatches, facets, coverage, labels
 */
export function generateUseCases(input) {
  const request = normalizeRequest(input);
  const data = getUseCaseData();
  const products = PLATFORM_PRODUCTS[request.platform];
  const departments = request.departments.length ? request.departments : data.departments.map((d) => d.id);

  let excluded = 0;
  const candidates = [];
  for (const pattern of data.patterns) {
    if (!products.includes(pattern.product) || !appliesToIndustry(pattern, request.industry)) continue;
    const resolved = resolvePattern(pattern);
    if (!resolved.ok) {
      excluded += 1;
      continue;
    }
    for (const departmentId of departments) {
      if (!appliesToDepartment(pattern, departmentId)) continue;
      candidates.push({
        pattern,
        resolved,
        departmentId,
        id: useCaseId(request.industry, departmentId, pattern.id),
        level: resolved.level,
        levelFit: "exact",
        ...score(request, pattern, resolved, departmentId, data),
      });
    }
  }

  // The level is strict where it can be. A product with fewer than three exact matches borrows the nearest levels, marked as nearby.
  const levelNotes = [];
  const pools = {};
  for (const product of products) {
    const own = candidates.filter((c) => c.pattern.product === product);
    if (!request.level) {
      pools[product] = own;
      continue;
    }
    const exact = own.filter((c) => c.level === request.level);
    const need = Math.max(0, MIN_PER_PRODUCT - exact.length);
    const nearby = own
      .filter((c) => c.level !== request.level)
      .map((c) => ({ ...c, levelFit: "nearby", score: c.score - 25, reasons: [...c.reasons, `Nearby level (${levelLabel(c.level)})`] }))
      .sort((a, b) => Math.abs(a.level - request.level) - Math.abs(b.level - request.level) || byRank(a, b))
      .slice(0, need);
    pools[product] = [...exact, ...nearby];
    if (nearby.length) {
      levelNotes.push(
        `Only ${plural(exact.length, "use case")} for ${getProduct(product).shortName} match ${levelLabel(request.level)} exactly, so ${nearby.length} from the nearest ${nearby.length === 1 ? "level" : "levels"} ${nearby.length === 1 ? "fills" : "fill"} in. ${nearby.length === 1 ? "It is" : "They are"} marked as a nearby level.`,
      );
    }
  }

  const sizes = Object.fromEntries(products.map((product) => [product, pools[product].length]));
  const matched = Object.values(sizes).reduce((sum, n) => sum + n, 0);
  const caps = allocate(sizes, MAX_RESULTS);

  const useCases = [];
  const groups = {};
  const titles = new Set();
  for (const product of products) {
    let rank = 0;
    const picked = pickVaried(pools[product], caps[product], (candidate) => {
      const built = buildUseCase({ pattern: candidate.pattern, industryId: request.industry, departmentId: candidate.departmentId });
      const key = built.title.toLowerCase();
      if (titles.has(key)) return false;
      titles.add(key);
      candidate.built = built;
      return true;
    });
    groups[product] = [];
    for (const candidate of picked) {
      rank += 1;
      useCases.push({
        ...candidate.built,
        match: { rank, score: candidate.score, reasons: candidate.reasons, missingData: candidate.missingData, levelFit: candidate.levelFit },
      });
      groups[product].push(candidate.built.id);
    }
  }

  const bestMatches = products.flatMap((product) => groups[product].slice(0, request.platform === "both" ? 3 : 4));
  const industry = data.industries.find((i) => i.id === request.industry);
  return {
    version: 1,
    query: request,
    labels: {
      industry: industry.name,
      departments: request.departments.map((id) => data.departments.find((d) => d.id === id).name),
      goals: request.goals.map((id) => data.goals.find((g) => g.id === id).label),
      dataSources: request.dataSources.map((id) => data.dataSources.find((s) => s.id === id).label),
      platform: data.platforms.find((p) => p.id === request.platform).label,
      level: request.level ? levelLabel(request.level) : null,
    },
    summary: {
      matched,
      returned: useCases.length,
      capped: matched > useCases.length,
      byProduct: Object.fromEntries(products.map((product) => [product, { matched: sizes[product], returned: groups[product].length }])),
    },
    bestMatches,
    groups,
    useCases,
    facets: {
      products: countBy(useCases, (u) => u.product),
      levels: countBy(useCases, (u) => u.level),
      departments: countBy(useCases, (u) => u.departments),
      goals: countBy(useCases, (u) => u.goals),
      dataSources: countBy(useCases, (u) => u.dataSources),
      harnesses: countBy(useCases.filter((u) => u.harness), (u) => u.harness),
      efforts: countBy(useCases, (u) => u.effort.id),
    },
    coverage: {
      notes: coverageNotes({ request, data, matched, returned: useCases.length, levelNotes, excluded, useCases }),
      excludedPatterns: excluded,
    },
    polish: { requested: request.polish, applied: false },
  };
}
