/**
 * The screenshot to-do list: exactly which pictures of a lab are still missing, which ones the computer can capture,
 * and which ones only a person can, with the steps for each.
 *
 * It reads the same plan the Screenshot Center runs (`buildLabJobPlan`), so the list and the jobs never disagree about
 * what is left or who has to do it. Nothing here starts a capture or touches a browser.
 */

import { buildLabJobPlan } from "./plan.js";
import { loadShotSlots } from "../lab-builder/pending-shot-card.js";

/** The line every guided plan ends with; the printed list says where to do it instead. */
const COMPANION_LAST_STEP = /^When the screen looks right, press Capture this screen\.?$/i;

// The agent page has the top tabs Build, Preview, Evaluate, and Monitor, so a lead of "Open your agent, then Overview." sends a
// person looking for a page that is not there. The shot's own steps name the tab; the lead only has to say which agent.
const OVERVIEW_LEAD = /^Open your agent((?: [\u201c"][^\u201d"]*[\u201d"])?), then Overview\.?$/i;

function figureOrder(item) {
  const [a, b] = String(item.figure || "999.999").split(".").map((n) => Number.parseInt(n, 10) || 0);
  return a * 1000 + b;
}

/**
 * @param {{generatedRoot: string, labId: string, values?: object, capturedDir?: string}} input
 * @returns {{status: number, error?: string, ...}}
 */
export function buildLabChecklist({ generatedRoot, labId, values = {}, capturedDir } = {}) {
  const plan = buildLabJobPlan({ generatedRoot, labId, scope: { mode: "missing", filenames: [], featureIds: [] }, values, ...(capturedDir ? { capturedDir } : {}) });
  if (plan.status !== 200) return { status: plan.status, error: plan.error };
  const slots = loadShotSlots(plan.labDir);
  const items = plan.shots.map((shot) => {
    const slot = slots.get(shot.filename) || {};
    const mode = shot.capture?.mode || "guided";
    const guide = (shot.capture?.guide || []).filter((line) => !COMPANION_LAST_STEP.test(line)).map((line) => line.replace(OVERVIEW_LEAD, "Open your agent$1 in Copilot Studio."));
    // A shot with no guide still has its authored instructions.
    const steps = guide.length ? guide : (slot.instructions || shot.instructions || []).map((line) => String(line).replace(/\*\*/g, ""));
    return {
      filename: shot.filename,
      figure: slot.figure || null,
      module: shot.moduleTitle || null,
      caption: shot.caption || slot.caption || null,
      shows: slot.alt || shot.caption || null,
      // The harness the picture must be taken in (null for a product with no harnesses), and a gap when the module is not written for the lab's harness.
      harness: shot.harness || null,
      harnessLabel: shot.harnessLabel || null,
      harnessGapNote: shot.harnessGapNote || null,
      who: shot.harnessGap ? "you" : mode === "auto" ? "computer" : "you",
      mode,
      why: shot.harnessGapNote || shot.capture?.why || "",
      steps,
      needsSettings: (shot.capture?.missing || []).length > 0,
    };
  });
  const sorted = [...items].sort((a, b) => figureOrder(a) - figureOrder(b));
  const computer = sorted.filter((item) => item.who === "computer");
  const you = sorted.filter((item) => item.who === "you");
  return {
    status: 200,
    labId: plan.labId,
    title: plan.title,
    // The harness every Copilot Studio picture of this lab is taken in, in one sentence.
    labHarness: plan.labHarness || null,
    counts: { missing: sorted.length, computer: computer.length, you: you.length },
    computer,
    you,
  };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The checklist as Markdown a person can print, paste into a ticket, or keep next to the lab. */
export function renderChecklistMarkdown(list, { generatedAt = new Date().toISOString().slice(0, 10) } = {}) {
  const lines = [`# Screenshot to-do list: ${list.title}`, "", `${generatedAt}. ${plural(list.counts.missing, "picture")} still to capture.`, ""];
  if (list.labHarness?.statement) lines.push(`**${list.labHarness.statement}**`, "");
  if (!list.counts.missing) {
    lines.push("Nothing is left. Every picture in this lab is a real screenshot.", "");
    return lines.join("\n");
  }
  lines.push("## Start here", "");
  const first = [];
  if (list.counts.computer) {
    first.push(`Open **Screenshots** for this lab in the portal. If it says your computer is not connected, select **Connect your computer** and follow the steps. Then select the main capture button at the top of the page. Your computer captures ${plural(list.counts.computer, "picture")} for you.`);
  }
  if (list.counts.you) {
    first.push(`Then do the ${plural(list.counts.you, "picture")} below that only you can set up. For each one, capture the screen and upload or paste the picture in the Screenshot Center (select the picture, then **Upload** or **Paste**), or select **Capture this screen** when the companion has opened it for you.`);
  }
  first.forEach((line, index) => lines.push(`${index + 1}. ${line}`));
  lines.push("");

  if (list.you.length) {
    lines.push(`## Only you can do these (${list.you.length})`, "");
    for (const item of list.you) {
      lines.push(`### ${item.figure ? `Figure ${item.figure}: ` : ""}${item.caption || item.filename}`, "");
      lines.push(`- **File:** \`${item.filename}\``);
      if (item.harnessLabel) lines.push(`- **Harness:** ${item.harnessLabel}`);
      if (item.module) lines.push(`- **Module:** ${item.module}`);
      if (item.shows) lines.push(`- **It should show:** ${item.shows}`);
      if (item.why) lines.push(`- **Why it needs you:** ${item.why}`);
      if (item.steps.length) {
        lines.push("- **Steps:**");
        item.steps.forEach((step, index) => lines.push(`  ${index + 1}. ${step}`));
      }
      lines.push("");
    }
  }
  if (list.computer.length) {
    lines.push(`## The computer will capture these (${list.computer.length})`, "");
    for (const item of list.computer) {
      lines.push(`- ${item.figure ? `Figure ${item.figure}: ` : ""}${item.caption || item.filename} (\`${item.filename}\`${item.harnessLabel ? `, ${item.harnessLabel}` : ""})${item.needsSettings ? " — needs your Copilot Studio address in the Screenshot Center settings first" : ""}`);
    }
    lines.push("");
  }
  lines.push("A picture only counts when it is a real screenshot of the product: a placeholder never does, and the Screenshot Center checks every upload.", "");
  return lines.join("\n");
}
