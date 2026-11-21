/**
 * The dry plan: what a capture of a lab (or the shared library) will do before anything runs, read from the plan the portal would send. Which
 * screenshots the computer takes by itself, in which order and with which recipe, which objects it adds to the practice agent for them, and
 * which ones stay with a person and why. It changes nothing and needs no browser, so the owner can read it before a real-tenant run.
 */

import { FAMILIES, OBJECTS, REASONS, describeReasonCounts } from "../../../tools/screenshot-capture/automation.mjs";
import { SCRATCH_CREATES_LIST } from "../../../tools/screenshot-capture/guard.mjs";

const text = (value, max = 200) => String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/**
 * @param {{labId?: string, title?: string, shots: object[]}} plan a plan from `buildLabJobPlan` or `buildLibraryJobPlan`
 */
export function buildDryPlan(plan) {
  const shots = Array.isArray(plan?.shots) ? plan.shots : [];
  const automatic = [];
  const manual = [];
  const objects = new Map();
  let order = 0;
  for (const shot of shots) {
    const a = shot.capture?.automation;
    if (!a) continue;
    if (a.state === "automatic") {
      order += 1;
      automatic.push({
        order,
        filename: shot.filename,
        caption: text(shot.caption, 160),
        via: a.via,
        family: a.family || null,
        familyLabel: a.family ? FAMILIES[a.family]?.label || a.family : a.via === "address" ? "Opened by its address" : "Lab walkthrough",
        verified: a.verified !== false,
        review: a.review || "never",
        maxTier: a.maxTier ?? 1,
        steps: (a.steps || []).slice(0, 8),
        objects: a.objects || [],
      });
      for (const id of a.objects || []) {
        if (!objects.has(id)) objects.set(id, { id, label: OBJECTS[id]?.label || id, shots: [] });
        objects.get(id).shots.push(shot.filename);
      }
    } else {
      manual.push({ filename: shot.filename, caption: text(shot.caption, 160), reason: a.reason || "unseen", reasonLabel: a.reasonLabel || REASONS[a.reason]?.label || "", why: a.why || "", steps: (a.manual || []).slice(0, 6) });
    }
  }
  const reasons = Object.keys(REASONS)
    .map((code) => ({ reason: code, label: REASONS[code].label, count: manual.filter((m) => m.reason === code).length }))
    .filter((r) => r.count);
  const unverified = automatic.filter((s) => s.family && !s.verified).length;
  return {
    labId: plan?.labId || null,
    title: text(plan?.title, 160),
    totals: { total: automatic.length + manual.length, automatic: automatic.length, needYou: manual.length, unverified },
    // What the computer builds first for a from-scratch capture: the practice agent, then the objects below for the shots that need them.
    practiceAgent: [...SCRATCH_CREATES_LIST],
    automatic,
    objects: [...objects.values()],
    manual,
    reasons,
    summary: manual.length ? `${manual.length} need you: ${describeReasonCounts(manual.map((m) => m.reason))}` : "Nothing needs you.",
  };
}

/** The dry plan as plain lines, for the command line. */
export function formatDryPlan(dry) {
  const lines = [];
  lines.push(`Dry plan${dry.title ? `: ${dry.title}` : ""}`);
  lines.push(`${dry.totals.automatic} of ${dry.totals.total} screenshots run automatically (${dry.totals.unverified} with a recipe that was not seen on a real tenant yet). ${dry.summary}`);
  lines.push("", "The computer builds first (from scratch, in the practice environment):");
  for (const line of dry.practiceAgent) lines.push(`  - ${line}`);
  lines.push("", "Runs automatically, in this order:");
  for (const s of dry.automatic) {
    lines.push(`  ${String(s.order).padStart(2)}. ${s.filename}  [${s.familyLabel}${s.family && !s.verified ? ", not seen on a real tenant yet" : ""}${s.review === "always" ? ", always saved for your review" : s.review === "landmark" ? ", checked by what the screen shows" : ""}]`);
    for (const step of s.steps) lines.push(`        - ${step}`);
  }
  if (dry.objects.length) {
    lines.push("", "Added to the practice agent for these screenshots:");
    for (const o of dry.objects) lines.push(`  - ${o.label}: ${o.shots.join(", ")}`);
  } else lines.push("", "Nothing is added to the practice agent for these screenshots beyond what the lab itself builds.");
  lines.push("", "Stays with a person:");
  for (const m of dry.manual) lines.push(`  - ${m.filename}: ${m.reasonLabel}`);
  return lines.join("\n");
}
