/**
 * The harness of a generated lab's pictures: which harness each shot needs, which one each picture was taken in, and whether they agree.
 *
 * A lab is built for one harness (the one the person chose, or the one most of its modules are written for), and that harness is the
 * authority: every Copilot Studio picture of the lab is taken in it. A module written for another harness is a gap, reported and never
 * captured in the wrong harness. This file holds the lab-level pieces the Screenshot Center, the capture plan, and lab-gate share.
 */

import fs from "node:fs";
import path from "node:path";

import { getFeature } from "./catalog.js";
import { capturedImage, capturedScreenshotsDirs, labPictureHarness, setLabSlotHarnessResolver } from "./captured.js";
import { combinedHarnessOrder, harnessForModule, isCombinedHarnessMode } from "./harness-parts.js";
import { DEFAULT_PRODUCT } from "./products.js";
import { slotNeedFor, slotsForFeature } from "./slots.js";
import { combinedHarnessStatement, harnessLabel, isSpecificHarness, labHarnessStatement, normalizeHarness, pictureFitsSlot } from "../../../tools/screenshot-capture/harness.mjs";

/**
 * The lab's harness as the lab data records it: `{ id, label, source, statement }` or null for a lab with no Copilot Studio part.
 * `source` says how it was decided: "chosen" (the person picked it), "inferred" (most of the lab's single-harness modules are written for it),
 * "default" (nothing said, so Standard), or "saved" (a lab built before this was recorded, read from its manifest).
 *
 * A lab that covers both harnesses one after another has no single harness: pass its `order` and the answer is
 * `{ id: null, mode: "both", order, label, source, statement }`, where each picture's harness is that of the part it sits in.
 */
export function labHarnessInfo(id, source = "saved", { order = null } = {}) {
  const both = (Array.isArray(order) ? order : []).map(normalizeHarness).filter(isSpecificHarness);
  if (both.length === 2) {
    return { id: null, mode: "both", order: both, label: `Both harnesses: ${harnessLabel(both[0])}, then ${harnessLabel(both[1])}`, source, statement: combinedHarnessStatement(both) };
  }
  const harness = normalizeHarness(id);
  if (!harness || harness === "either") return null;
  return { id: harness, label: harnessLabel(harness), source, statement: labHarnessStatement(harness) };
}

/** The two harnesses a plan (a planner plan, a shots.json, or a manifest) covers one after another, in order, or an empty list for any other lab. */
export function labHarnessOrder(plan) {
  const fromPlan = combinedHarnessOrder(plan);
  if (fromPlan.length === 2) return fromPlan;
  const info = plan?.harnessInfo;
  return info?.mode === "both" && Array.isArray(info.order) && info.order.length === 2 ? [...info.order] : [];
}

/**
 * The harness a feature's pictures are taken in. For a single-harness lab that is the lab's harness. For a combined lab it is the harness of
 * the part the feature sits in; a shared part (a topic that is the same in both harnesses) is taken in the first harness of the order, so it
 * has exactly one harness and never crosses. Reads the part through `harnessForModule`, never from the feature's catalog tags.
 * @param {object} plan a planner plan, a shots.json, or a manifest (`harnessMode`/`harnesses`, or `harness`)
 * @param {{id?: string, harnessPart?: string}} feature the feature or module (only its id and part are read)
 */
export function featureLabHarness(plan, feature) {
  const order = labHarnessOrder(plan);
  if (order.length !== 2) return plan?.harness ?? null;
  const read = harnessForModule({ harnessMode: "both", harnesses: order, harnessParts: plan?.harnessParts }, { id: feature?.id, harnessPart: feature?.harnessPart });
  return read.harness || read.harnesses?.[0] || order[0];
}

/**
 * What one saved shot needs, worked out from the catalog and the lab's harness (never trusted from an older shots.json, which could hold a
 * guess): `{ id, source, gap }`. A shot of a topic that came from Microsoft Learn is not in the catalog; its own saved feature harness is used.
 */
export function shotHarnessNeed(shot, { labHarness = null } = {}) {
  const product = shot?.product || DEFAULT_PRODUCT;
  const feature = getFeature(shot?.featureId || shot?.feature) || null;
  const tags = Array.isArray(feature?.harness) ? feature.harness : Array.isArray(shot?.featureHarness) ? shot.featureHarness : [];
  const slot = (feature ? slotsForFeature(feature).find((s) => s.filename === shot?.filename) : null) || { harness: shot?.slotHarness };
  return slotNeedFor({ product, harness: tags }, slot, { labHarness });
}

/**
 * Fill every shot of a lab's plan with the harness it needs (`harness`, `harnessLabel`, `harnessSource`, and a `harnessGap` when the shot's
 * feature is not written for the lab's harness), and the plan with the lab's harness. Changes the plan it is given and returns it.
 */
export function withShotHarness(shotsPlan) {
  if (!shotsPlan || typeof shotsPlan !== "object") return shotsPlan;
  const order = labHarnessOrder(shotsPlan);
  const hasCopilotStudio = (shotsPlan.shots || []).some((s) => (s.product || DEFAULT_PRODUCT) === "copilot-studio") || (shotsPlan.products || []).includes("copilot-studio");
  if (order.length === 2 && hasCopilotStudio) {
    // A lab that covers both harnesses has no single harness: each shot needs the harness of the part it sits in.
    shotsPlan.harnessMode = "both";
    shotsPlan.harnesses = order;
    shotsPlan.harness = null;
    shotsPlan.harnessInfo = labHarnessInfo(null, shotsPlan.harnessInfo?.source || "saved", { order });
    shotsPlan.harnessLabel = shotsPlan.harnessInfo.label;
    for (const shot of shotsPlan.shots || []) {
      const need = shotHarnessNeed(shot, { labHarness: featureLabHarness(shotsPlan, { id: shot.featureId || shot.feature, harnessPart: shot.harnessPart }) });
      applyNeed(shot, need);
    }
    return shotsPlan;
  }
  const lab = normalizeHarness(shotsPlan.harnessInfo?.id ?? shotsPlan.harness);
  const labHarness = lab && lab !== "either" ? lab : null;
  shotsPlan.harness = labHarness || (hasCopilotStudio ? "standard" : null);
  shotsPlan.harnessInfo = labHarnessInfo(shotsPlan.harness, shotsPlan.harnessInfo?.source || (labHarness ? "saved" : "default"));
  if (shotsPlan.harnessInfo) shotsPlan.harnessLabel = shotsPlan.harnessInfo.label;
  for (const shot of shotsPlan.shots || []) applyNeed(shot, shotHarnessNeed(shot, { labHarness: shotsPlan.harness }));
  return shotsPlan;
}

function applyNeed(shot, need) {
  shot.harness = need.id;
  shot.harnessLabel = harnessLabel(need.id);
  shot.harnessSource = need.source;
  if (need.gap) shot.harnessGap = need.gap;
  else delete shot.harnessGap;
}

const slotHarnessCache = new Map();

/** The harness a lab's slot needs, for a lookup that is given only the lab and the file name (see `setLabSlotHarnessResolver`). Cached until the plan changes. */
function labSlotHarness(labDir, filename) {
  const file = path.join(labDir, "screenshots", "shots.json");
  let info;
  try {
    info = fs.statSync(file);
  } catch {
    return null;
  }
  const key = `${info.size}:${info.mtimeMs}`;
  let hit = slotHarnessCache.get(file);
  if (!hit || hit.key !== key) {
    const map = new Map();
    try {
      const plan = withShotHarness(JSON.parse(fs.readFileSync(file, "utf8")));
      for (const shot of plan.shots || []) map.set(shot.filename, shot.harness || null);
    } catch {
      // A damaged plan names no harness; the lookup then reads the picture as it is.
    }
    if (slotHarnessCache.size > 100) slotHarnessCache.clear();
    hit = { key, map };
    slotHarnessCache.set(file, hit);
  }
  return hit.map.get(filename) ?? null;
}

setLabSlotHarnessResolver(labSlotHarness);

/**
 * What a lab's pictures say about its harness, for the Screenshot Center and lab-gate: how many pictures have no harness recorded, how many
 * are from the wrong harness, how many slots are a gap (their module is not written for the lab's harness), and whether the lab shows
 * pictures from more than one harness where it should have only its own.
 * @param {string|null} labHarness the lab's harness
 * @param {Array<{filename: string, harnessState?: string, pictureHarness?: string|null, harnessGap?: object|null}>} shots a lab status's shots
 */
export function labHarnessSummary(labHarness, shots, { order = [] } = {}) {
  const lab = normalizeHarness(labHarness);
  const both = (Array.isArray(order) ? order : []).map(normalizeHarness).filter(isSpecificHarness);
  const combined = both.length === 2;
  const specific = !combined && isSpecificHarness(lab);
  const list = Array.isArray(shots) ? shots : [];
  const files = (state) => list.filter((s) => s.harnessState === state).map((s) => s.filename);
  const notRecordedFiles = files("not-recorded");
  const wrongFiles = files("wrong-harness");
  const gapFiles = list.filter((s) => s.harnessGap).map((s) => s.filename);
  const seen = [...new Set(list.map((s) => normalizeHarness(s.pictureHarness)).filter(isSpecificHarness))];
  const other = specific ? seen.filter((h) => h !== lab) : [];
  // A combined lab is expected to show both harnesses, each in its own part, so "mixed" never applies to it: every part is checked against
  // its own harness instead (the wrong pictures above, and the per-part counts below).
  const mixed = specific && (other.length > 0 || seen.length > 1);
  const names = (ids) => ids.map(harnessLabel);
  const mixedMessage = !mixed
    ? ""
    : `This lab is built for the ${harnessLabel(lab)}, but it has pictures from ${seen.length > 1 ? `both the ${names(seen).join(" and the ")}` : `the ${names(other).join(" and the ")}`}. A lab must only show pictures from its own harness. Retake the ones from the other harness.`;
  const parts = combined
    ? both.map((id) => {
        const own = list.filter((s) => normalizeHarness(s.harness) === id);
        return {
          harness: id,
          label: harnessLabel(id),
          shots: own.length,
          taken: own.filter((s) => s.harnessState === "ok").length,
          wrong: own.filter((s) => s.harnessState === "wrong-harness").length,
          notRecorded: own.filter((s) => s.harnessState === "not-recorded").length,
        };
      })
    : [];
  return {
    labHarness: specific ? lab : null,
    ...(combined ? { combined: true, order: both, parts } : {}),
    statement: combined ? combinedHarnessStatement(both) : specific ? labHarnessStatement(lab) : "",
    notRecorded: notRecordedFiles.length,
    wrong: wrongFiles.length,
    gaps: gapFiles.length,
    notRecordedFiles,
    wrongFiles,
    gapFiles,
    harnessesSeen: seen,
    mixed,
    mixedMessage,
  };
}

/**
 * Read a lab folder and say how its pictures stand against the lab's harness (the lab-gate rule). Reads only; returns null for a folder with no
 * shot plan (a hand-written lab) or a lab with no Copilot Studio part.
 * @returns {{labHarness: string|null, shots: Array<object>, summary: object}|null}
 */
export function scanLabHarness(labDir, { capturedDir = capturedScreenshotsDirs() } = {}) {
  const dir = path.resolve(labDir);
  let plan;
  try {
    plan = withShotHarness(JSON.parse(fs.readFileSync(path.join(dir, "screenshots", "shots.json"), "utf8")));
  } catch {
    return null;
  }
  if (!plan.harnessInfo) return null;
  const shots = (plan.shots || []).map((shot) => {
    const need = normalizeHarness(shot.harness);
    const own = isSpecificHarness(need) ? capturedImage(path.join(dir, "assets"), shot.filename) : null;
    const pictureHarness = own ? labPictureHarness(dir, shot.filename, { capturedDir, need }) : null;
    const state = !isSpecificHarness(need) ? "none" : !own ? "pending" : pictureFitsSlot(need, pictureHarness).code;
    return { filename: shot.filename, harness: need, harnessGap: shot.harnessGap || null, pictureHarness, harnessState: state };
  });
  return { labHarness: plan.harness, order: labHarnessOrder(plan), shots, summary: labHarnessSummary(plan.harness, shots, { order: labHarnessOrder(plan) }) };
}
