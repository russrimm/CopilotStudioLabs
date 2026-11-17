/**
 * Integrity checks for the Use Case Builder data. Returns human-readable
 * problems (an empty array means the data is sound). Tests run it against the
 * shipped data so a mistyped id, an unsupported combination, or a template slot
 * with no value fails in CI instead of in front of a user.
 */

import { getHarnesses } from "../lab-builder/catalog.js";
import { getProduct, productHasHarnesses } from "../lab-builder/products.js";
import { AGENT_BUILDER, CAPABILITY_KINDS, COPILOT_STUDIO, SLOT_KEYS, VOCAB_KEYS, getUseCaseData } from "./data.js";
import { catalogFeature, resolvePattern } from "./resolve.js";
import { templateSlots } from "./templates.js";

const SLUG = /^[a-z][a-z0-9-]*$/;
// A small guard for the US English rule; extend it when a new slip is found.
const NON_US_SPELLING = /\b(?:behaviour|colour|organis(?:e|ation|ed)|practis(?:e|ed|ing)|catalogue|centre|licence|favour(?:ite)?|customis(?:e|ation)|recognis(?:e|ed)|analys(?:e|ed)|prioritis(?:e|ed)|summaris(?:e|ed)|standardis(?:e|ed))\b/i;
const AGENT_BUILDER_SOURCES = new Set(["sharepoint", "web", "teams", "email", "none"]);
const KNOWN_SLOTS = new Set([...SLOT_KEYS, ...VOCAB_KEYS, "dept", "industry"]);
const CONTEXT_SLOTS = new Set([...SLOT_KEYS, "regulations", "industry"]);

function textFields(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((entry) => textFields(entry, out));
  else if (value && typeof value === "object") Object.values(value).forEach((entry) => textFields(entry, out));
  return out;
}

export function validateUseCaseData() {
  const data = getUseCaseData();
  const problems = [];
  const departmentIds = data.departments.map((d) => d.id);
  const industryIds = data.industries.map((i) => i.id);
  const goalIds = new Set(data.goals.map((g) => g.id));
  const sourceIds = new Set(data.dataSources.map((s) => s.id));
  const effortIds = new Set(data.efforts.map((e) => e.id));

  for (const [label, list] of [["goal", data.goals], ["data source", data.dataSources], ["platform", data.platforms]]) {
    const seen = new Set();
    for (const entry of list) {
      if (!SLUG.test(entry.id || "")) problems.push(`${label} "${entry.id}": id must be a lower-case slug`);
      if (seen.has(entry.id)) problems.push(`${label} ${entry.id}: duplicate id`);
      seen.add(entry.id);
      if (!entry.label?.trim() || !entry.description?.trim()) problems.push(`${label} ${entry.id}: needs a label and a description`);
    }
  }
  for (const goal of data.goals) if (!goal.outcome?.trim()) problems.push(`goal ${goal.id}: needs an outcome`);

  // Industry and department contexts.
  for (const industryId of industryIds) {
    const context = data.contexts.get(industryId);
    if (!context) {
      problems.push(`industry ${industryId}: missing data/industries/${industryId}.json`);
      continue;
    }
    for (const key of VOCAB_KEYS) if (!context.vocab?.[key]?.trim()) problems.push(`industry ${industryId}: vocab needs ${key}`);
    for (const departmentId of departmentIds) {
      const slots = context.departments?.[departmentId];
      if (!slots) {
        problems.push(`industry ${industryId}: missing department ${departmentId}`);
        continue;
      }
      for (const key of SLOT_KEYS) if (!slots[key]?.trim()) problems.push(`industry ${industryId}, department ${departmentId}: needs ${key}`);
    }
    for (const extra of Object.keys(context.departments || {})) {
      if (!departmentIds.includes(extra)) problems.push(`industry ${industryId}: unknown department ${extra}`);
    }
  }
  // Industries must read differently: no slot value repeats across industries for a department.
  for (const departmentId of departmentIds) {
    for (const key of SLOT_KEYS) {
      const seen = new Map();
      for (const industryId of industryIds) {
        const value = data.contexts.get(industryId)?.departments?.[departmentId]?.[key];
        if (!value) continue;
        if (seen.has(value)) problems.push(`department ${departmentId}, ${key}: "${value}" repeats in ${seen.get(value)} and ${industryId}`);
        seen.set(value, industryId);
      }
    }
  }

  // Capabilities.
  for (const [id, cap] of Object.entries(data.capabilities)) {
    const label = `capability ${id}`;
    if (!SLUG.test(id)) problems.push(`${label}: id must be a lower-case slug`);
    if (![COPILOT_STUDIO, AGENT_BUILDER].includes(cap.product)) problems.push(`${label}: product must be copilot-studio or m365-copilot-agent-builder`);
    if (!CAPABILITY_KINDS.includes(cap.kind)) problems.push(`${label}: unknown kind "${cap.kind}"`);
    if (!cap.label?.trim() || !cap.summary?.trim()) problems.push(`${label}: needs a label and a summary`);
    if (!Array.isArray(cap.features) || !cap.features.length) problems.push(`${label}: needs at least one catalog feature`);
    for (const featureId of cap.features || []) {
      const feature = catalogFeature(featureId);
      if (!feature) problems.push(`${label}: catalog has no feature "${featureId}"`);
      else if ((feature.product || COPILOT_STUDIO) !== cap.product) problems.push(`${label}: feature ${featureId} belongs to another product`);
    }
    if (cap.forcesCopilotStudio && cap.product !== COPILOT_STUDIO) problems.push(`${label}: only a Copilot Studio capability can force Copilot Studio`);
    if (cap.forcesCopilotStudio && !cap.fit?.trim()) problems.push(`${label}: a capability that forces Copilot Studio needs a fit clause`);
  }
  for (const [product, byHarness] of Object.entries(data.bases)) {
    for (const [harness, featureIds] of Object.entries(byHarness)) {
      for (const featureId of featureIds) if (!catalogFeature(featureId)) problems.push(`base ${product}/${harness}: catalog has no feature "${featureId}"`);
    }
  }

  // Patterns.
  const seenPatterns = new Set();
  for (const pattern of data.patterns) {
    const label = `pattern ${pattern.id}`;
    if (!SLUG.test(pattern.id || "")) problems.push(`${label}: id must be a lower-case slug`);
    if (seenPatterns.has(pattern.id)) problems.push(`${label}: duplicate id`);
    seenPatterns.add(pattern.id);
    if (!getProduct(pattern.product)) {
      problems.push(`${label}: unknown product`);
      continue;
    }
    const resolved = resolvePattern(pattern);
    problems.push(...resolved.problems);
    if (resolved.ok && !getProduct(pattern.product).levels.includes(resolved.level)) problems.push(`${label}: level ${resolved.level} is not a ${pattern.product} level`);
    if (productHasHarnesses(pattern.product) && !getHarnesses().some((h) => h.id === pattern.harness)) problems.push(`${label}: needs a harness`);

    for (const [field, valid, name] of [["goals", goalIds, "goal"], ["dataSources", sourceIds, "data source"]]) {
      if (!Array.isArray(pattern[field]) || !pattern[field].length) problems.push(`${label}: ${field} needs at least one value`);
      for (const id of pattern[field] || []) if (!valid.has(id)) problems.push(`${label}: unknown ${name} "${id}"`);
    }
    if (!effortIds.has(pattern.effort)) problems.push(`${label}: unknown effort "${pattern.effort}"`);
    if (!Array.isArray(pattern.departments) || !pattern.departments.length) problems.push(`${label}: departments needs "*" or department ids`);
    for (const id of pattern.departments || []) if (id !== "*" && !departmentIds.includes(id)) problems.push(`${label}: unknown department "${id}"`);
    for (const id of pattern.industries || []) if (id !== "*" && !industryIds.includes(id)) problems.push(`${label}: unknown industry "${id}"`);
    if (!Array.isArray(pattern.titles) || !pattern.titles.length || pattern.titles.length > 3) problems.push(`${label}: titles needs one to three templates`);
    for (const field of ["description", "instructions"]) if (!pattern[field]?.trim()) problems.push(`${label}: needs ${field}`);

    for (const template of [...(pattern.titles || []), pattern.description, pattern.instructions, ...Object.values(pattern.toolNotes || {})].filter(Boolean)) {
      for (const slot of templateSlots(template)) {
        if (!KNOWN_SLOTS.has(slot[0].toLowerCase() + slot.slice(1))) problems.push(`${label}: unknown template slot {${slot}}`);
      }
    }
    // A general pattern's title or description with no industry or department slot would read the same in every industry.
    const general = !pattern.industries || pattern.industries.includes("*");
    for (const template of general ? [...(pattern.titles || []), pattern.description].filter(Boolean) : []) {
      if (!templateSlots(template).some((slot) => CONTEXT_SLOTS.has(slot[0].toLowerCase() + slot.slice(1)))) {
        problems.push(`${label}: "${template.slice(0, 50)}" has no industry or department slot, so it would repeat in every industry`);
      }
    }
    for (const id of Object.keys(pattern.toolNotes || {})) if (!pattern.needs?.includes(id)) problems.push(`${label}: toolNotes names ${id}, which the pattern does not need`);

    const caps = (pattern.needs || []).map((id) => data.capabilities[id]).filter(Boolean);
    if (pattern.product === AGENT_BUILDER) {
      for (const id of pattern.dataSources || []) if (!AGENT_BUILDER_SOURCES.has(id)) problems.push(`${label}: Agent Builder cannot use the ${id} data source`);
      if (caps.some((cap) => cap.forcesCopilotStudio)) problems.push(`${label}: an Agent Builder pattern cannot need a Copilot Studio capability`);
    } else if (!caps.some((cap) => cap.forcesCopilotStudio) && !pattern.fit?.trim()) {
      problems.push(`${label}: a Copilot Studio pattern with no capability that forces it needs its own fit sentence`);
    }
  }

  for (const text of textFields([data.goals, data.dataSources, data.platforms, data.capabilities, data.patterns, [...data.contexts.values()]])) {
    const hit = NON_US_SPELLING.exec(text);
    if (hit) problems.push(`use US English ("${hit[0]}") in: ${text.slice(0, 70)}`);
  }
  return problems;
}
