/**
 * The "Administrator setup guide": every administrator setting a lab needs, in one document for the administrator.
 *
 * Learner guides never list these settings (see `learner-guide.js`). This guide is the full version and the
 * Prerequisites checklist is the short one. Both read the same data: `buildPrerequisitesChecklist()` already
 * turns `admin-prereqs.js` (the single source of connectors, data policies, environment, tenant, and cloud
 * settings), the saved manifest, and the lab's Prerequisites text into customer-ready items. This module regroups
 * those items by who does the work, orders them by the work order, and adds the exact portal location and the
 * steps, so the two documents cannot disagree. A lab built before this guide existed works too, because only the
 * saved manifest and `index.md` are read.
 *
 * What never reaches the model: module steps, quizzes, facilitator content, screenshot placeholders, builder notes,
 * lab or manifest ids, and tenant identifiers (the checklist model already removes them).
 *
 * Pure and dependency-free apart from sibling lab-builder modules, so the offline CLI can use it.
 */

import {
  CHECKLIST_ROLES,
  buildPrerequisitesChecklist,
  checklistPlainText,
  describeNeededFor,
  formatItemNumbers,
} from "./prereq-checklist.js";
import { ADMIN_GUIDE_TITLE } from "./learner-guide.js";
import { joinNames } from "./products.js";

export const ADMIN_GUIDE_SCHEMA_VERSION = 1;
export const ADMIN_GUIDE_BANNER = "For the administrator. Not part of the learner guides.";

/** The work order: earlier stages unblock later ones, so doing them in this order avoids rework. */
export const ADMIN_STAGES = Object.freeze([
  { id: "licenses", title: "Licenses and capacity", order: 1 },
  { id: "tenant", title: "Tenant, identity, and cloud admin settings", order: 2 },
  { id: "environment", title: "Environment settings", order: 3 },
  { id: "policies", title: "Data policies and governance", order: 4 },
  { id: "connectors", title: "Connectors and connections", order: 5 },
  { id: "data", title: "Data and content for the workshop", order: 6 },
  { id: "network", title: "Network and allow-list needs", order: 7 },
]);

const STAGE_BY_ID = new Map(ADMIN_STAGES.map((stage) => [stage.id, stage]));
/** Checklist sections that are about attendees, not administrators. */
const ATTENDEE_PHASES = new Set(["attendees", "knowledge"]);
const CONFIRM_TAIL_RE = /\(not confirmed in Microsoft Learn\)(?::\s*(.*))?$/i;

/** "File name" form of the guide's title, matching the checklist's "<Lab title> - Prerequisites checklist". */
export function adminGuideBaseName(title) {
  const clean = String(title || "Workshop").replace(/[<>:"/\\|?*\u0000-\u001F\u007F]+/g, " ").replace(/\s+/g, " ").trim().replace(/[. ]+$/g, "");
  const capped = (clean.length > 80 ? clean.slice(0, 80).trim() : clean) || "Workshop";
  return `${capped} - ${ADMIN_GUIDE_TITLE}`;
}

/** The checklist asks the customer to confirm with Microsoft; an administrator is told to check their own tenant. */
function adminConfirm(confirm) {
  if (!confirm) return "";
  const match = String(confirm).match(CONFIRM_TAIL_RE);
  const notes = match?.[1] ? match[1].trim() : "";
  const tail = "Check this in your own tenant, or with your Microsoft representative, before you rely on it.";
  return notes ? `Not confirmed in Microsoft Learn: ${notes} ${tail}` : `Not confirmed in Microsoft Learn. ${tail}`;
}

function firstSentence(text, max = 120) {
  const clean = checklistPlainText(String(text || "")).replace(/\s+/g, " ").trim();
  const sentence = clean.match(/^.+?[.!?](?=\s|$)/)?.[0] || clean;
  const body = sentence.replace(/[.!?]+$/, "");
  if (body.length <= max) return body;
  const cut = body.slice(0, max - 1);
  const wordEnd = cut.lastIndexOf(" ");
  return `${(wordEnd > max * 0.6 ? cut.slice(0, wordEnd) : cut).trim()}\u2026`;
}

/** A short heading for a lab requirement that has no title of its own: the first clause, or the sentence cut on a word. */
function shortTitle(text, max = 90) {
  const sentence = firstSentence(text, 400);
  if (sentence.length <= max) return sentence;
  const cuts = [sentence.indexOf(" ("), sentence.indexOf(", "), sentence.indexOf(": "), sentence.indexOf(" \u2014 ")].filter((i) => i >= 24 && i <= max);
  if (cuts.length) return sentence.slice(0, Math.min(...cuts)).trim();
  return firstSentence(sentence, max);
}

/** "Power Platform admin center > Policies > Data policies" becomes the two steps that get an administrator to the setting. */
function locationSteps(where) {
  const clean = String(where || "").replace(/\[Environment\]/gi, "your workshop environment").trim();
  if (!clean) return { where: "", steps: [] };
  const parts = clean.split(/\s+>\s+/).map((part) => part.trim()).filter(Boolean);
  const place = parts[0];
  const path = parts.slice(1).join(" > ");
  return { where: clean, steps: path ? [`Open the ${place}.`, `Go to ${path}.`] : [`Open the ${place}.`] };
}

function sameText(a, b) {
  const norm = (value) => checklistPlainText(String(value || "")).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return norm(a) === norm(b);
}

/** Whether `detail` only repeats the words already in `text` (so the guide does not say the same thing twice). */
function mostlyRepeats(detail, text) {
  const words = (value) => new Set(checklistPlainText(String(value || "")).toLowerCase().match(/[a-z0-9]{4,}/g) || []);
  const known = words(text);
  const wanted = [...words(detail)];
  if (!wanted.length) return true;
  return wanted.filter((word) => known.has(word)).length / wanted.length >= 0.7;
}

const HOST_TITLE_RE = /^(?:[a-z0-9*-]+\.)+[a-z]{2,}$/i;

/**
 * The checklist lists one network item per host so each can be ticked off. In the guide they are one item for the
 * network contact, with every address in it.
 */
function mergeNetworkItems(collected) {
  const network = collected.filter((entry) => entry.stage.id === "network");
  if (network.length < 2) return collected;
  const endpoints = [];
  let ownSystem = false;
  let neededFor = [];
  for (const { item } of network) {
    if (HOST_TITLE_RE.test(item.title)) {
      const used = String(item.why || "").match(/^Used by:\s*(.+?)\.?$/i)?.[1];
      endpoints.push(used ? `${item.title} (${used})` : item.title);
    } else if (/own systems/i.test(item.title)) {
      ownSystem = true;
    } else {
      endpoints.push(item.title);
    }
    neededFor = neededFor.concat(item.neededFor || []);
  }
  const first = network[0];
  const merged = {
    item: {
      ...first.item,
      title: "Allow the web addresses the workshop uses",
      text: "Allow outbound secure web traffic (HTTPS, port 443) to each address listed here, on the network attendees use.",
      why: "Blocked addresses stop the hands-on steps from working.",
      endpoints,
      ownSystem,
      detail: "",
      where: "",
      neededFor: [],
      learn: null,
      confirm: "",
      condition: "",
    },
    stage: first.stage,
    sequence: first.sequence,
  };
  return [...collected.filter((entry) => entry.stage.id !== "network"), merged];
}

/**
 * @param {object} input the same input as `buildPrerequisitesChecklist`
 * @param {object} [input.manifest] the lab's manifest.json
 * @param {string} [input.markdown] the lab's index.md
 * @param {object} [input.brand] the resolved brand, only used for the customer name, contact, and footer
 * @param {Date|string|number} [input.now]
 * @param {Record<string,string>} [input.replacements]
 */
export function buildAdministratorSetupGuide(input = {}) {
  const checklist = buildPrerequisitesChecklist(input);

  // 1. Keep what an administrator does; the checklist's attendee and background-knowledge items stay in the checklist only.
  const intros = new Map();
  let collected = [];
  let sequence = 0;
  for (const section of checklist.sections) {
    for (const item of section.items) {
      if (item.role === "attendee" || ATTENDEE_PHASES.has(item.phase)) continue;
      const stage = STAGE_BY_ID.get(item.phase) || STAGE_BY_ID.get(section.id) || STAGE_BY_ID.get("environment");
      if (section.intro && !intros.has(section.id)) intros.set(section.id, section.intro);
      collected.push({ item, stage, sequence: (sequence += 1) });
    }
  }
  collected = mergeNetworkItems(collected);

  // 2. Number the items in the work order: stage, then who does it, then the order the work should happen.
  collected.sort((a, b) => {
    const stageDiff = a.stage.order - b.stage.order;
    if (stageDiff) return stageDiff;
    const roleDiff = (CHECKLIST_ROLES[a.item.role]?.order ?? 99) - (CHECKLIST_ROLES[b.item.role]?.order ?? 99);
    return roleDiff || a.sequence - b.sequence;
  });

  const items = collected.map(({ item, stage }, index) => {
    const { where, steps } = locationSteps(item.where);
    const detail = item.detail && !sameText(item.detail, item.text) && !mostlyRepeats(item.detail, item.text) ? item.detail : "";
    // A lab requirement with no title of its own becomes its own title, and is not said twice.
    const title = item.title || shortTitle(item.text);
    const text = !item.title && sameText(title, item.text) ? "" : item.text;
    return {
      n: index + 1,
      adminId: item.adminId || "",
      role: item.role,
      roleLabel: CHECKLIST_ROLES[item.role]?.label || item.roleLabel || "Workshop host",
      stageId: stage.id,
      stageTitle: stage.title,
      title,
      text,
      check: item.check || "",
      where,
      steps,
      detail,
      endpoints: item.endpoints || [],
      ownSystem: Boolean(item.ownSystem),
      why: item.why || "",
      neededFor: item.neededFor || [],
      learn: item.learn || null,
      confirm: adminConfirm(item.confirm),
      condition: item.condition || "",
    };
  });

  // 3. Group by who does the work. The numbers stay in work order, so a role's items read in the order to do them.
  const byRole = new Map();
  for (const item of items) {
    if (!byRole.has(item.role)) byRole.set(item.role, []);
    byRole.get(item.role).push(item);
  }
  const roleIds = [...byRole.keys()].sort((a, b) => (CHECKLIST_ROLES[a]?.order ?? 99) - (CHECKLIST_ROLES[b]?.order ?? 99));
  const sections = roleIds.map((id) => ({
    id,
    title: CHECKLIST_ROLES[id]?.label || "Workshop host",
    intro: CHECKLIST_ROLES[id]?.does || "",
    items: byRole.get(id),
  }));
  const roles = sections.map((section) => ({
    id: section.id,
    label: section.title,
    does: section.intro,
    items: section.items.map((item) => item.n),
  }));

  const workOrder = items.map((item) => ({
    n: item.n,
    title: item.title,
    roleLabel: item.roleLabel,
    stageTitle: item.stageTitle,
    where: item.where,
  }));
  const stages = ADMIN_STAGES.filter((stage) => items.some((item) => item.stageId === stage.id)).map((stage) => ({
    id: stage.id,
    title: stage.title,
    items: items.filter((item) => item.stageId === stage.id).map((item) => item.n),
  }));

  const hasConfirm = items.some((item) => item.confirm);
  const hasConditions = items.some((item) => item.condition);
  const notes = [intros.get("licenses"), intros.get("data")].filter(Boolean);
  const itemCount = items.length;

  const summaryParts = [
    `This guide lists every administrator setting needed before the workshop "${checklist.title}", so attendees can build and test without waiting.`,
    itemCount
      ? `It has ${itemCount} item${itemCount === 1 ? "" : "s"} for ${roles.length} role${roles.length === 1 ? "" : "s"}, covering ${joinNames(checklist.products)}, each with where to make the change and why it is needed.`
      : `This workshop covers ${joinNames(checklist.products)} and needs no administrator settings beyond a standard environment.`,
    "Make the changes in a non-production environment.",
  ];

  const howToUse = [];
  if (itemCount) {
    howToUse.push("Do the items in number order: the \"Order of work\" table shows the sequence that avoids rework, from licenses and tenant settings to connectors and network access.");
    if (roles.length > 1) howToUse.push("Send each person only their part: the \"Who does what\" table lists the item numbers for each role.");
    howToUse.push("Each item names where to make the change. Tick the box and write your name or the date in \"Done by / date\" when it is finished.");
  }
  if (hasConfirm) howToUse.push("Where an item says \"Not confirmed in Microsoft Learn\", check it in your own tenant before you rely on it: Microsoft Learn does not confirm it yet.");
  if (hasConditions) howToUse.push("Items marked \"Only if\" apply to some organizations. Skip them if they do not apply to you.");
  howToUse.push("These settings are for administrators only. Attendees get their own guides, which do not list them.");

  return {
    schemaVersion: ADMIN_GUIDE_SCHEMA_VERSION,
    documentTitle: ADMIN_GUIDE_TITLE,
    banner: ADMIN_GUIDE_BANNER,
    title: checklist.title,
    products: checklist.products,
    audience: checklist.audience,
    dateText: checklist.dateText,
    customerName: checklist.customerName,
    summary: summaryParts.join(" "),
    howToUse,
    notes,
    roles,
    stages,
    workOrder,
    sections,
    itemCount,
    contact: checklist.contact,
    footerText: checklist.footerText,
    confirm: {
      line: checklist.confirm.line.replace(/this checklist/i, "this guide"),
      fields: checklist.confirm.fields,
    },
  };
}

/** Plain text of one item, shared by the Markdown, PDF, Word, and web page writers. */
export function adminGuideItemParts(item) {
  return {
    title: item.title,
    stage: `Stage: ${item.stageTitle}`,
    steps: item.steps,
    whatLabel: item.steps.length ? "What to set up" : "What to have ready",
    text: item.text,
    check: item.check || "",
    detail: item.detail,
    endpoints: item.endpoints.length
      ? `Allow these addresses (HTTPS, port 443): ${item.endpoints.join("; ")}.${item.ownSystem ? " Also allow the addresses of your own systems; your workshop contact will confirm them." : ""}`
      : item.ownSystem
        ? "Allow the addresses of your own systems; your workshop contact will confirm them."
        : "",
    why: [item.why, describeNeededFor(item.neededFor)].filter(Boolean).join(" "),
    learn: item.learn,
    confirm: item.confirm,
    condition: item.condition,
  };
}

// ── Markdown ────────────────────────────────────────────────────────────────

function mdEscape(text) {
  return String(text || "").replace(/([\\*_[\]|])/g, "\\$1").replace(/\r?\n/g, " ");
}

/** The guide as Markdown: a section per role, each item a checkbox with where, steps, why, and a blank "Done by" line. */
export function renderAdministratorSetupGuideMarkdown(model) {
  const lines = [`# ${model.documentTitle}`, "", `**${mdEscape(model.title)}**`, "", `_${model.banner}_`, ""];
  lines.push(`- **Products:** ${model.products.map(mdEscape).join("; ")}`);
  lines.push(`- **Audience:** ${mdEscape(model.audience)}`);
  lines.push(`- **Date:** ${model.dateText}`);
  if (model.customerName) lines.push(`- **Prepared for:** ${mdEscape(model.customerName)}`);
  lines.push("", model.summary, "", "## How to use this guide", "", ...model.howToUse.map((line) => `- ${line}`), "");
  if (model.notes.length) lines.push(...model.notes.map((note) => `> ${note}`), "");

  if (model.workOrder.length) {
    lines.push("## Order of work", "", "| # | Setting | Stage | Who |", "|---|---|---|---|");
    for (const row of model.workOrder) {
      lines.push(`| ${row.n} | ${mdEscape(row.title)} | ${mdEscape(row.stageTitle)} | ${mdEscape(row.roleLabel)} |`);
    }
    lines.push("");
  }

  if (model.roles.length) {
    lines.push("## Who does what", "", "| Who | What they do | Items |", "|---|---|---|");
    for (const role of model.roles) {
      lines.push(`| ${mdEscape(role.label)} | ${mdEscape(role.does)} | ${formatItemNumbers(role.items)} |`);
    }
    lines.push("");
  }

  for (const section of model.sections) {
    lines.push(`## ${section.title}`, "");
    if (section.intro) lines.push(section.intro, "");
    for (const item of section.items) {
      const parts = adminGuideItemParts(item);
      lines.push(`- [ ] **${item.n}. ${mdEscape(parts.title)}**`);
      const meta = [`*${mdEscape(parts.stage)}*`];
      if (parts.condition) meta.push(`*${mdEscape(parts.condition)}*`);
      lines.push(`  ${meta.join(" \u00b7 ")}`, "");
      parts.steps.forEach((step, i) => lines.push(`  ${i + 1}. ${step}`));
      if (parts.steps.length) lines.push("");
      if (parts.text) lines.push(`  **${parts.whatLabel}:** ${parts.text}`, "");
      if (parts.check) lines.push(`  **How to check:** ${parts.check}`, "");
      if (parts.detail) lines.push(`  **Details:** ${parts.detail}`, "");
      if (parts.endpoints) lines.push(`  ${parts.endpoints}`, "");
      if (parts.why) lines.push(`  **Why:** ${mdEscape(parts.why)}`, "");
      if (parts.learn) lines.push(`  [${mdEscape(parts.learn.label)}](${parts.learn.url})`, "");
      if (parts.confirm) lines.push(`  **${mdEscape(parts.confirm)}**`, "");
      lines.push("  *Done by / date:* ____________", "");
    }
  }

  lines.push("## Confirm and return", "", model.confirm.line, "", ...model.confirm.fields.map((f) => `- ${f}: ____________`), "");
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}
