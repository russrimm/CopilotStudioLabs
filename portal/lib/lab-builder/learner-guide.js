/**
 * Keeps administrator setup out of the learner guides.
 *
 * The administrator settings for a lab (connectors, data policies, environment, tenant, and cloud settings)
 * live only in the Administrator setup guide and the Prerequisites checklist. A learner guide gets at most one
 * plain line saying the setup was completed. Labs built before this split carry the old admin section at the end
 * of `index.md`, so every learner-facing reader calls `learnerGuideMarkdown()` to hide it. It works on the text in
 * memory (nothing is rewritten on disk) and is safe to run more than once.
 *
 * Pure and dependency-free, so the offline CLI can use it.
 */

import { currentProductName } from "../product-name.js";

/** The heading the old generator wrote at the end of `index.md`. */
export const ADMIN_SECTION_HEADING = "Connectors, Environment, and Tenant Prerequisites";

export const ADMIN_GUIDE_TITLE = "Administrator setup guide";

/** The folder at the top of an exported archive that holds everything meant for the administrator. */
export const ADMIN_FOLDER_NAME = "For the administrator";

/**
 * Topics whose subject is administrator work. A person who deliberately selects one keeps it as a lab module
 * (the settings the generator adds for lab setup move to the Administrator setup guide, but a topic that teaches
 * admin work is the lesson itself). Such a module is labeled so the learner knows the audience.
 */
export const ADMIN_AUDIENCE_TOPIC_IDS = Object.freeze(["dlp-governance", "alm-solutions", "agent-inventory", "entra-agent-identities", "vnet-private-connectivity"]);
const ADMIN_AUDIENCE_CATEGORIES = Object.freeze(["copilot-admin", "administration"]);
export const ADMIN_AUDIENCE_LABEL = "Audience: administrators";

/** @param {{ id?: string, category?: string }} feature a catalog topic or a manifest module */
export function isAdminAudienceTopic(feature) {
  if (!feature || typeof feature !== "object") return false;
  return ADMIN_AUDIENCE_TOPIC_IDS.includes(feature.id) || ADMIN_AUDIENCE_CATEGORIES.includes(feature.category);
}

/** The only mention of administrator setup in a learner guide. It lists no settings and asks learners to do nothing. */
export const LEARNER_SETUP_NOTE = `Your administrator has completed the setup for this lab (see the ${ADMIN_GUIDE_TITLE}).`;

const ADMIN_H2_RE = /^##\s+Connectors,\s*Environment,\s*and\s*Tenant\s*Prerequisites\s*$/i;
const PREREQUISITES_H2_RE = /^##\s+Prerequisites\s*$/i;
const ANY_H2_RE = /^##\s+\S/;

/** Heading lines found outside code fences: `{ index, text }` for every level-two heading. */
function levelTwoHeadings(lines) {
  const out = [];
  let fence = null;
  for (let i = 0; i < lines.length; i += 1) {
    const fenceMatch = lines[i].match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      continue;
    }
    if (ANY_H2_RE.test(lines[i])) out.push({ index: i, text: lines[i] });
  }
  return out;
}

/** Whether `index.md` still carries the old administrator section. */
export function hasAdminSetupSection(markdown) {
  return levelTwoHeadings(String(markdown ?? "").split(/\r?\n/)).some((h) => ADMIN_H2_RE.test(h.text));
}

/**
 * A copy of a manifest for a learner-facing bundle: without the administrator model and without the older saved
 * per-topic governance rows. The administrator documents rebuild what they need from the module list.
 *
 * @param {object} manifest a lab's parsed `manifest.json`
 * @returns {object}
 */
export function learnerSafeManifest(manifest) {
  if (!manifest || typeof manifest !== "object") return manifest;
  const copy = { ...manifest };
  delete copy.adminPrerequisites;
  // A lab saved before the product was renamed carries the earlier name; the copy a learner receives shows the current one.
  if ("generator" in copy) copy.generator = currentProductName(copy.generator);
  const snapshot = copy.customization?.profileSnapshot;
  if (snapshot && typeof snapshot === "object" && "companyName" in snapshot) {
    copy.customization = { ...copy.customization, profileSnapshot: { ...snapshot, companyName: currentProductName(snapshot.companyName) } };
  }
  if (Array.isArray(copy.modules)) {
    copy.modules = copy.modules.map((mod) => {
      if (!mod?.trainingDigest || typeof mod.trainingDigest !== "object" || !("governance" in mod.trainingDigest)) return mod;
      const { governance, ...digest } = mod.trainingDigest;
      void governance;
      return { ...mod, trainingDigest: digest };
    });
  }
  return copy;
}

/**
 * The learner version of a lab guide: the administrator section removed and, when something was removed,
 * the one-line pointer added at the end of the Prerequisites section. Text that has no admin section comes back unchanged.
 *
 * @param {string} markdown a lab's `index.md` (or any text built from it)
 * @returns {string}
 */
export function learnerGuideMarkdown(markdown) {
  const source = String(markdown ?? "");
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  const headings = levelTwoHeadings(lines);
  const adminIdx = headings.findIndex((h) => ADMIN_H2_RE.test(h.text));
  if (adminIdx === -1) return source;

  const start = headings[adminIdx].index;
  const end = adminIdx + 1 < headings.length ? headings[adminIdx + 1].index : lines.length;
  let kept = [...lines.slice(0, start), ...lines.slice(end)];

  // The section sat at the end, so drop the blank lines and rule it leaves behind and end the file with one newline.
  if (end >= lines.length) {
    while (kept.length && /^\s*(?:---+)?\s*$/.test(kept[kept.length - 1])) kept.pop();
    kept.push("");
  } else if (start > 0 && kept[start - 1] !== "" && kept[start] !== "") {
    kept.splice(start, 0, "");
  }

  if (!kept.some((line) => line.includes(LEARNER_SETUP_NOTE))) {
    const prereq = levelTwoHeadings(kept).find((h) => PREREQUISITES_H2_RE.test(h.text));
    if (prereq) {
      const next = levelTwoHeadings(kept).find((h) => h.index > prereq.index);
      let at = next ? next.index : kept.length;
      while (at > prereq.index + 1 && kept[at - 1].trim() === "") at -= 1;
      kept.splice(at, 0, "", LEARNER_SETUP_NOTE);
      if (next && kept[at + 2] !== "") kept.splice(at + 2, 0, "");
    }
  }
  return kept.join(eol);
}
