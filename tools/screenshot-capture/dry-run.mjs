// `--dry-run-plan`: print every step the computer would take, tier by tier, without opening a browser. It reads the
// steps from a job file the portal gave (a saved copy of what the companion would claim) or, with no file, lists the
// built-in recipes. The same checks run here as in a real job, so what is printed is what would be allowed.

import fs from "node:fs";

import { TIER_TABLE, NEVER_LIST, resolveAutonomy } from "./guard.mjs";
import { listBuiltinRecipes } from "./recipes-builtin.mjs";
import { groupStepsByTier, sanitizeSetup } from "./setup-steps.mjs";

const TIER_HEADINGS = Object.freeze({
  0: "Tier 0, look (always allowed)",
  1: "Tier 1, try (allowed in automatic mode)",
  2: "Tier 2, practice agent (only after you opt in, and only inside the practice agent)",
});

/** The groups to print for a list of titled step lists. */
export function dryRunLines(items, { autonomy = null } = {}) {
  const lines = [];
  const rule = autonomy ? resolveAutonomy(autonomy, { allowPracticeWrites: autonomy.level === "practice" }) : null;
  lines.push("Plan for autonomous capture, without opening a browser.");
  if (rule) lines.push(`This job: ${rule.consented ? (rule.level === "practice" ? "may use one practice agent" : "never creates or changes anything") : "carries no consent, so only tier 0 would run"}.`);
  lines.push("");
  for (const item of items) {
    lines.push(item.title);
    if (item.limited) lines.push(`  Limited: ${item.limited}`);
    const groups = groupStepsByTier(item.steps);
    for (const tier of [0, 1, 2]) {
      const list = groups.get(tier) || [];
      if (!list.length) continue;
      lines.push(`  ${TIER_HEADINGS[tier]}`);
      for (const step of list) lines.push(`    - ${step.note}${step.target?.name ? ` [${step.target.within || "any"}]` : ""}${step.practiceOnly ? " (practice agent only)" : ""}`);
    }
    if (!item.steps.length) lines.push("  (no steps: the screen opens by its address)");
    lines.push("");
  }
  lines.push("Tier 3 is never done, whatever a lab or a recorded recipe says:");
  for (const never of NEVER_LIST) lines.push(`  - ${never}`);
  lines.push("");
  lines.push(TIER_TABLE.map((t) => `Tier ${t.tier}: ${t.label}`).join("; "));
  return lines;
}

/** Steps from a saved job (the JSON the portal hands the companion), shot by shot. */
export function dryRunItemsFromJob(job) {
  const shots = Array.isArray(job?.shots) ? job.shots : Array.isArray(job) ? job : [];
  const allowPractice = job?.job?.options?.autonomy?.level === "practice" || job?.autonomy?.level === "practice";
  return shots.map((shot) => {
    const setup = sanitizeSetup(shot.capture?.setup, { allowPractice: true, product: shot.capture?.product || shot.product || "" });
    const limited = !allowPractice && setup?.needsPractice ? "steps that need a practice agent are left out" : shot.capture?.setup?.limited ? "steps that need a practice agent are left out" : "";
    const kept = allowPractice ? setup?.steps || [] : (setup?.steps || []).filter((s) => s.tier < 2 && !s.practiceOnly);
    return { title: `${shot.filename || "a screenshot"}${setup?.source ? `  (${setup.source})` : ""}`, steps: kept, limited };
  });
}

/** Everything `--dry-run-plan` can print. `file` is a job file path, or true for the built-in recipes. */
export function dryRunPlan(file) {
  if (typeof file === "string" && file) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      return { ok: false, lines: [`The plan file could not be read: ${String(err.message || err).split("\n")[0]}`] };
    }
    return { ok: true, lines: dryRunLines(dryRunItemsFromJob(parsed), { autonomy: parsed?.job?.options?.autonomy || parsed?.autonomy || null }) };
  }
  const items = listBuiltinRecipes().map((recipe) => ({ title: `${recipe.id}: ${recipe.title}`, steps: recipe.steps, limited: recipe.practice ? "the last part needs a practice agent" : "" }));
  return { ok: true, lines: dryRunLines(items) };
}
