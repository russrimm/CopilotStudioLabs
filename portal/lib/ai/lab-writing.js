/**
 * AI writing for the lab document: which passages the model may reword, and how its answers are put back.
 *
 * The composer stays the only thing that writes the lab. This module asks it for the deterministic text of each passage
 * (composer.js featureAiSources and defaultOverviewIntro), sends them as blocks, and returns the accepted rewordings as
 * `enrichment` fields the composer already knows how to place: the overview, and per module `applied` (the "In your
 * scenario" paragraph), `why`, `steps`, `concepts` and `troubleshooting`. Whatever the model returns then goes through the
 * same final steps as the standard text: plain text (no emoji), connector display names, the lab gate.
 */

import { defaultOverviewIntro, featureAiSources } from "../lab-builder/composer.js";
import { levelName } from "../lab-builder/levels.js";
import { knownNames } from "./names.js";

export { knownNames, resetKnownNames } from "./names.js";

function contextOf(plan, feature) {
  const profile = plan.profile || {};
  return {
    industry: plan.industry?.name || "Cross-industry",
    audience: plan.roles?.length ? plan.roles.map((r) => r.name).join(", ") : "a general business audience",
    agentName: profile.agentName || "",
    domain: profile.domain || "",
    problem: profile.problem || "",
    outcome: profile.outcome || "",
    level: plan.level ? levelName(plan.level) : "",
    ...(feature ? { module: feature.name, moduleSummary: feature.summary || "" } : {}),
  };
}

function allowedText(context) {
  // The level is context for the writer, not a fact it may quote.
  const { level, ...rest } = context;
  return Object.values(rest).join(" ");
}

function textBlock(id, kind, source, extra = {}) {
  return { id, kind, type: "text", source, names: knownNames(), ...extra };
}

function listBlock(id, kind, sources, extra = {}) {
  return { id, kind, type: "list", sources, itemKind: kind, names: knownNames(), ...extra };
}

/**
 * The units of a lab: one for the overview, one per module.
 *
 * @param {object} input
 * @param {object} input.plan
 * @param {Map<string, object>} input.stepsByFeature
 * @param {string[]} input.scope  the parts of the lab AI may write ("lab", "labday")
 */
export function buildLabUnits({ plan, stepsByFeature, scope }) {
  const writesLab = scope.includes("lab");
  const writesConcepts = writesLab || scope.includes("labday");
  const units = [];

  if (writesLab) {
    const context = contextOf(plan, null);
    units.push({
      id: "lab.overview",
      context,
      blocks: [textBlock("lab.overview", "overview", defaultOverviewIntro(plan), { allowed: allowedText(context) })],
    });
  }

  for (const feature of plan.features) {
    if (feature.prerequisite) continue;
    const sources = featureAiSources(feature, plan, stepsByFeature.get(feature.id));
    const context = contextOf(plan, feature);
    const allowed = allowedText(context);
    const blocks = [];
    if (writesLab && sources.why) blocks.push(textBlock(`lab.${feature.id}.why`, "why", sources.why, { allowed }));
    if (writesLab && sources.scenario) blocks.push(textBlock(`lab.${feature.id}.scenario`, "scenario", sources.scenario, { allowed }));
    if (writesLab && sources.steps?.length) {
      blocks.push(listBlock(`lab.${feature.id}.steps`, "step", sources.steps, { allowed, ui: [feature.name], multiline: sources.steps.some((s) => s.includes("\n")) }));
    }
    if (writesConcepts && sources.concepts?.length) blocks.push(listBlock(`lab.${feature.id}.concepts`, "concept", sources.concepts, { allowed }));
    if (writesLab && sources.troubleshooting?.length) {
      blocks.push(listBlock(`lab.${feature.id}.trouble`, "trouble", sources.troubleshooting.flatMap((t) => [t.symptom, t.fix]), { allowed }));
    }
    if (blocks.length) units.push({ id: `lab.${feature.id}`, context, blocks });
  }
  return units;
}

/**
 * Put the accepted answers where the composer reads them. Blocks that kept the standard text are simply left alone.
 *
 * @returns {{conceptMaps: Map<string, Array<{from: string, to: string}>>, written: object}}
 */
export function applyLabResults({ plan, stepsByFeature, results, enrichment, scope }) {
  const writesLab = scope.includes("lab");
  const conceptMaps = new Map();
  const written = {};
  const accepted = (id) => {
    const result = results.get(id);
    return result && (result.status === "ai" || result.status === "cached") ? result : null;
  };

  if (writesLab) {
    const overview = accepted("lab.overview");
    if (overview?.text) {
      enrichment.overview = overview.text;
      written["lab.overview"] = overview.text;
    }
  }
  if (!enrichment.byFeature) enrichment.byFeature = new Map();

  for (const feature of plan.features) {
    if (feature.prerequisite) continue;
    const sources = featureAiSources(feature, plan, stepsByFeature.get(feature.id));
    const entry = { ...(enrichment.byFeature.get(feature.id) || {}) };
    let changed = false;
    const take = (suffix) => {
      const result = accepted(`lab.${feature.id}.${suffix}`);
      if (result) written[`lab.${feature.id}.${suffix}`] = result.text ?? result.items;
      return result;
    };

    if (writesLab) {
      const why = take("why");
      if (why?.text) {
        entry.why = why.text;
        changed = true;
      }
      const scenario = take("scenario");
      if (scenario?.text) {
        entry.applied = scenario.text;
        changed = true;
      }
      const steps = take("steps");
      if (steps?.items?.length === sources.steps?.length) {
        entry.steps = steps.items;
        changed = true;
      }
      const trouble = take("trouble");
      if (trouble?.items?.length === sources.troubleshooting.length * 2) {
        entry.troubleshooting = sources.troubleshooting.map((_, i) => ({ symptom: trouble.items[i * 2], fix: trouble.items[i * 2 + 1] }));
        changed = true;
      }
    }
    const concepts = scope.includes("lab") || scope.includes("labday") ? take("concepts") : null;
    if (concepts?.items?.length === sources.concepts?.length) {
      if (writesLab) {
        entry.concepts = concepts.items;
        changed = true;
      }
      conceptMaps.set(feature.id, sources.concepts.map((from, i) => ({ from, to: concepts.items[i] })));
    }
    if (changed) enrichment.byFeature.set(feature.id, entry);
  }
  return { conceptMaps, written };
}
