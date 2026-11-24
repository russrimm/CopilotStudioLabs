/**
 * The dry plan: what a capture of a lab (or the shared library) will do before anything runs, read from the plan the portal would send. Which
 * screenshots the computer takes by itself, in which order and with which recipe, which objects it adds to the practice agent for them, and
 * which ones stay with a person and why. It changes nothing and needs no browser, so the owner can read it before a real-tenant run.
 */

import { FAMILIES, OBJECTS, REASONS, describeReasonCounts } from "../../../tools/screenshot-capture/automation.mjs";
import { SCRATCH_CREATES_LIST } from "../../../tools/screenshot-capture/guard.mjs";
import { CLASSIC_SWITCH, DEFAULT_EXPERIENCE_HOST, HARNESS_LABELS, STANDARD, MICROSOFT_COPILOT } from "../../../tools/screenshot-capture/harness.mjs";

/** The one practice agent a lab gets, and where it is created. A Standard (Classic) agent and a Microsoft Copilot agent are never reused for each other. */
function practiceAgentNote(harness) {
  if (harness === STANDARD) return `A ${HARNESS_LABELS[STANDARD]} practice agent, created inside the classic experience after the switch (${CLASSIC_SWITCH.path}). It is never used for a Microsoft Copilot picture.`;
  if (harness === MICROSOFT_COPILOT) return `A ${HARNESS_LABELS[MICROSOFT_COPILOT]} practice agent, created in the default experience at ${DEFAULT_EXPERIENCE_HOST} (no switch). It is never used for a Standard (Classic) picture.`;
  return `A ${HARNESS_LABELS[harness] || "practice"} agent, created on its own harness. It is never used for a picture of another harness.`;
}

const text = (value, max = 200) => String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** The harness, the step that gets the page into it, and the landmark that proves it, as one shot's plan says them (null for a shot with no harness). */
function harnessOf(shot) {
  const h = shot?.capture?.harness;
  if (!h || !h.id) return { harness: null, harnessLabel: null, switchStep: null, proof: null, switches: false };
  return { harness: h.id, harnessLabel: text(h.label, 80), switchStep: text(h.switchStep, 260), proof: text(h.proof, 260), switches: h.switch === true };
}

/**
 * @param {{labId?: string, title?: string, labHarness?: object|null, shots: object[]}} plan a plan from `buildLabJobPlan` or `buildLibraryJobPlan`
 */
export function buildDryPlan(plan) {
  const shots = Array.isArray(plan?.shots) ? plan.shots : [];
  const automatic = [];
  const manual = [];
  const gaps = [];
  const objects = new Map();
  let order = 0;
  for (const shot of shots) {
    if (shot.harnessGap) gaps.push({ filename: shot.filename, caption: text(shot.caption, 160), ...harnessOf(shot), note: text(shot.harnessGapNote, 300) });
    const a = shot.capture?.automation;
    if (!a) continue;
    if (a.state === "automatic" && !shot.harnessGap) {
      order += 1;
      automatic.push({
        order,
        filename: shot.filename,
        caption: text(shot.caption, 160),
        ...harnessOf(shot),
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
      manual.push({ filename: shot.filename, caption: text(shot.caption, 160), ...harnessOf(shot), reason: shot.harnessGap ? "harness-gap" : a.reason || "unseen", reasonLabel: shot.harnessGap ? "The module is not written for the lab's harness" : a.reasonLabel || REASONS[a.reason]?.label || "", why: shot.harnessGap ? text(shot.harnessGapNote, 300) : a.why || "", steps: (a.manual || []).slice(0, 6) });
    }
  }
  const reasons = Object.keys(REASONS)
    .map((code) => ({ reason: code, label: REASONS[code].label, count: manual.filter((m) => m.reason === code).length }))
    .filter((r) => r.count);
  if (gaps.length) reasons.push({ reason: "harness-gap", label: "The module is not written for the lab's harness", count: gaps.length });
  const unverified = automatic.filter((s) => s.family && !s.verified).length;
  const lab = plan?.labHarness && plan.labHarness.id ? { id: plan.labHarness.id, label: text(plan.labHarness.label, 80), source: plan.labHarness.source || null, statement: text(plan.labHarness.statement, 200) } : null;
  return {
    labId: plan?.labId || null,
    title: text(plan?.title, 160),
    // The lab's harness is the authority: every Copilot Studio picture of the lab is taken in it.
    labHarness: lab,
    // Which kind of practice agent the lab gets: one agent, in the lab's harness, created in the experience that harness lives in.
    practiceAgentHarness: lab ? practiceAgentNote(lab.id) : "",
    totals: { total: automatic.length + manual.length, automatic: automatic.length, needYou: manual.length, unverified, harnessGaps: gaps.length },
    // What the computer builds first for a from-scratch capture: the practice agent, then the objects below for the shots that need them.
    practiceAgent: [...SCRATCH_CREATES_LIST],
    automatic,
    objects: [...objects.values()],
    manual,
    gaps,
    reasons,
    summary: manual.length ? `${manual.length} need you: ${describeReasonCounts(manual.filter((m) => m.reason !== "harness-gap").map((m) => m.reason))}${gaps.length ? `${manual.length > gaps.length ? "; " : ""}${gaps.length} not written for the lab's harness` : ""}` : "Nothing needs you.",
  };
}

/** The dry plan as plain lines, for the command line. */
export function formatDryPlan(dry) {
  const lines = [];
  lines.push(`Dry plan${dry.title ? `: ${dry.title}` : ""}`);
  if (dry.labHarness) lines.push(dry.labHarness.statement || `This lab: ${dry.labHarness.label}.`);
  lines.push(`${dry.totals.automatic} of ${dry.totals.total} screenshots run automatically (${dry.totals.unverified} with a recipe that was not seen on a real tenant yet). ${dry.summary}`);
  lines.push("", "The computer builds first (from scratch, in the practice environment):");
  if (dry.practiceAgentHarness) lines.push(`  - ${dry.practiceAgentHarness}`);
  for (const line of dry.practiceAgent) lines.push(`  - ${line}`);
  lines.push("", "Runs automatically, in this order:");
  for (const s of dry.automatic) {
    lines.push(`  ${String(s.order).padStart(2)}. ${s.filename}  [${s.familyLabel}${s.family && !s.verified ? ", not seen on a real tenant yet" : ""}${s.review === "always" ? ", always saved for your review" : s.review === "landmark" ? ", checked by what the screen shows" : ""}]`);
    if (s.harness) {
      lines.push(`        harness: ${s.harnessLabel}`);
      lines.push(`        ${s.switchStep.replace(/^Switch:/i, "switch:").replace(/^No switch:/i, "no switch:")}`);
      lines.push(`        proof landmark: ${s.proof}`);
    }
    for (const step of s.steps) lines.push(`        - ${step}`);
  }
  if (dry.objects.length) {
    lines.push("", "Added to the practice agent for these screenshots:");
    for (const o of dry.objects) lines.push(`  - ${o.label}: ${o.shots.join(", ")}`);
  } else lines.push("", "Nothing is added to the practice agent for these screenshots beyond what the lab itself builds.");
  lines.push("", "Stays with a person:");
  for (const m of dry.manual) lines.push(`  - ${m.filename}${m.harnessLabel ? ` (${m.harnessLabel})` : ""}: ${m.reasonLabel}`);
  if (dry.gaps.length) {
    lines.push("", "Not written for the lab's harness (reported, never captured in another harness):");
    for (const g of dry.gaps) lines.push(`  - ${g.filename}: ${g.note}`);
  }
  return lines.join("\n");
}
