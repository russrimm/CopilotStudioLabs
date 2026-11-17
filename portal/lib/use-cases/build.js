/**
 * Builds one use case from a pattern, an industry, and a department.
 *
 * The text comes from the pattern's templates filled with that industry and
 * department's context. Everything factual (the product, harness, level, lab
 * topics, knowledge, tools, Learn links, preview and third-party flags, and the
 * product-fit rationale) is derived from the catalog through resolve.js.
 */

import { getHarnesses } from "../lab-builder/catalog.js";
import { getProduct } from "../lab-builder/products.js";
import { COPILOT_STUDIO, getIndustryContext, getUseCaseData } from "./data.js";
import { harnessNotesFor, harnessName, learnLinksFor, levelLabel, resolvePattern } from "./resolve.js";
import { joinClauses, renderTemplate, stableHash } from "./templates.js";

const TOOL_KINDS = new Set(["tool", "integration", "channel"]);
const PRACTICE_KINDS = new Set(["quality", "governance"]);

const capitalize = (text) => (text ? text[0].toUpperCase() + text.slice(1) : text);

export function useCaseId(industryId, departmentId, patternId) {
  return `${industryId}.${departmentId}.${patternId}`;
}

/** The values a pattern's templates may use for one industry and department. */
export function slotsFor(industryId, departmentId) {
  const data = getUseCaseData();
  const context = getIndustryContext(industryId);
  const industry = data.industries.find((i) => i.id === industryId);
  const department = data.departments.find((d) => d.id === departmentId);
  return { ...context.vocab, ...context.departments[departmentId], dept: department.name, industry: industry.name };
}

function featureFlags(features) {
  return {
    preview: features.filter((f) => f.availability === "preview"),
    thirdParty: features.filter((f) => f.thirdPartyConnector),
  };
}

function capabilityFlags(capability, featuresById) {
  const own = capability.features.map((id) => featuresById.get(id)).filter(Boolean);
  return {
    preview: own.some((f) => f.availability === "preview"),
    thirdParty: own.some((f) => f.thirdPartyConnector),
  };
}

/** Why this product, from what the use case needs and what the catalog says each product covers. */
function productFit(pattern, resolved) {
  const caps = resolved.capabilities;
  if (pattern.product === COPILOT_STUDIO) {
    const forced = caps.filter((cap) => cap.forcesCopilotStudio && cap.fit);
    const parts = [];
    if (forced.length) {
      parts.push(
        `Copilot Studio is the right fit because this agent ${joinClauses(forced.slice(0, 4).map((cap) => cap.fit))}. The Agent Builder topics in the catalog cover instructions, supported knowledge, and built-in capabilities, not these.`,
      );
    }
    if (pattern.fit) parts.push(pattern.fit);
    else {
      const extra = caps.filter((cap) => !cap.forcesCopilotStudio && cap.fit);
      if (extra.length) parts.push(`It also ${joinClauses(extra.map((cap) => cap.fit))}.`);
    }
    return parts.join(" ");
  }
  const clauses = ["is built from instructions", ...caps.filter((cap) => cap.fit).map((cap) => cap.fit)];
  const parts = [
    `Agent Builder is enough here: this agent ${joinClauses(clauses)}. It needs no external-system actions, workflows, or channels, which is when Microsoft's guidance points to Copilot Studio.`,
  ];
  if (pattern.fit) parts.push(pattern.fit);
  return parts.join(" ");
}

function prerequisitesFor(pattern, resolved, slots) {
  const product = getProduct(pattern.product);
  const notes = [product.licenseNote];
  for (const cap of resolved.capabilities) if (cap.prerequisite) notes.push(renderTemplate(cap.prerequisite, slots));
  const { preview, thirdParty } = featureFlags(resolved.features);
  if (preview.length) {
    notes.push(`Includes Preview capabilities (${joinClauses(preview.map((f) => f.name))}). Availability and behavior can change before general availability.`);
  }
  if (thirdParty.length) {
    notes.push(`Uses a third-party connector (${joinClauses(thirdParty.map((f) => f.name))}). Confirm the connection and licensing with the vendor.`);
  }
  return [...new Set(notes)];
}

function valueFor(pattern, industryId, departmentId, slots) {
  const data = getUseCaseData();
  const role = data.departments.find((d) => d.id === departmentId);
  const industry = data.industries.find((i) => i.id === industryId);
  const kpis = [...new Set([capitalize(slots.kpi), ...(role.kpis || []).slice(0, 2), ...(industry.kpis || []).slice(0, 1)])].slice(0, 4);
  const outcomes = pattern.goals.map((id) => data.goals.find((g) => g.id === id)?.outcome).filter(Boolean);
  return { kpis, outcomes };
}

/**
 * @param {{pattern: object, industryId: string, departmentId: string}} input
 * @returns {object} a use case without ranking fields
 */
export function buildUseCase({ pattern, industryId, departmentId }) {
  const data = getUseCaseData();
  const resolved = resolvePattern(pattern);
  if (!resolved.ok) throw new Error(`Pattern ${pattern.id} does not resolve: ${resolved.problems.join("; ")}`);
  const slots = slotsFor(industryId, departmentId);
  const id = useCaseId(industryId, departmentId, pattern.id);
  const featuresById = new Map(resolved.features.map((f) => [f.id, f]));
  const title = renderTemplate(pattern.titles[stableHash(id) % pattern.titles.length], slots);
  const noteFor = (cap) => (pattern.toolNotes?.[cap.id] ? renderTemplate(pattern.toolNotes[cap.id], slots) : cap.example ? renderTemplate(cap.example, slots) : cap.summary);
  const asEntry = (cap) => ({ id: cap.id, label: cap.label, kind: cap.kind, note: noteFor(cap), ...capabilityFlags(cap, featuresById) });

  const labTopics = resolved.features.map((f) => ({
    id: f.id,
    name: f.name,
    level: f.level,
    minutes: f.minutes,
    base: resolved.baseIds.includes(f.id),
    preview: f.availability === "preview",
    thirdParty: Boolean(f.thirdPartyConnector),
  }));
  const flags = featureFlags(resolved.features);
  const harness = resolved.harness;
  const harnessInfo = harness ? getHarnesses().find((h) => h.id === harness) : null;
  const effort = data.efforts.find((e) => e.id === pattern.effort);

  return {
    id,
    patternId: pattern.id,
    title,
    description: renderTemplate(pattern.description, slots),
    product: pattern.product,
    productName: getProduct(pattern.product).shortName,
    harness,
    harnessName: harness ? harnessName(harness) : null,
    harnessPreview: Boolean(harnessInfo && resolved.features.every((f) => f.availability === "preview")),
    industry: industryId,
    departments: [departmentId],
    goals: [...pattern.goals],
    dataSources: [...pattern.dataSources],
    level: resolved.level,
    levelLabel: levelLabel(resolved.level),
    effort: { id: effort.id, label: effort.label },
    value: valueFor(pattern, industryId, departmentId, slots),
    instructions: renderTemplate(pattern.instructions, slots),
    knowledgeSources: resolved.capabilities
      .filter((cap) => cap.kind === "knowledge")
      .map((cap) => ({ id: cap.id, label: cap.label, example: cap.example ? renderTemplate(cap.example, slots) : cap.summary })),
    toolsAndActions: resolved.capabilities.filter((cap) => TOOL_KINDS.has(cap.kind)).map(asEntry),
    qualityAndGovernance: resolved.capabilities.filter((cap) => PRACTICE_KINDS.has(cap.kind)).map(asEntry),
    whyProduct: productFit(pattern, resolved),
    harnessNotes: harnessNotesFor(resolved),
    prerequisites: prerequisitesFor(pattern, resolved, slots),
    labTopics,
    labMinutes: labTopics.reduce((sum, t) => sum + t.minutes, 0),
    learnLinks: learnLinksFor(resolved),
    flags: { preview: flags.preview.length > 0, thirdParty: flags.thirdParty.length > 0 },
  };
}
