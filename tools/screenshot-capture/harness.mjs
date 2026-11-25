// The one place that knows what a Copilot Studio "harness" means for a screenshot. The portal (labels, slot matching, the
// shared library) and the Local Capture Companion (the switch to the Classic harness and the proof that the page is in the
// right one) both import it, so a picture can never be called one harness by one side and another by the other.
//
// Facts this file rests on (Microsoft Learn, and what was OBSERVED on a real tenant on 2026-11-24, read only, with the owner at the PC):
//   - The default address https://copilotstudio.microsoft.com/ is the Microsoft Copilot experience (Home, Agents, Workflows, Apps). A new agent
//     there is a Microsoft Copilot harness agent by default.
//   - The classic experience is reached by hand with three clicks: the "More options" button (the ellipsis in the lower left corner), the
//     "Open classic experience" menu item, and "Skip feedback" on the feedback prompt that follows (never Submit). The click OPENS A NEW BROWSER
//     TAB on https://copilotstudio.preview.microsoft.com/ and leaves the original tab on the default address. Both tabs share the sign-in.
//     https://learn.microsoft.com/microsoft-copilot-studio/agents-experience/switch-experiences
//   - The "More options" menu offers "Open classic experience" in EVERY experience (default, preview, and on a Standard agent page), so the menu
//     proves nothing about which experience a page is in.
//   - A Standard agent lives on the preview host at /environments/<env>/bots/<agent>/..., and opening one from the Agents list of the default address
//     redirects there by itself. Its page shows a TAB STRIP: Overview, Knowledge, Tools, Agents, Topics, Activity, Evaluation (and an overflow button).
//   - A Microsoft Copilot harness agent has the tabs Build, Preview, Evaluate, and Monitor (seen at /agents/<id>).
//     https://learn.microsoft.com/microsoft-copilot-studio/agents-experience/overview
//   - A Customer Conversation harness agent has Build, Preview, Evaluate, Deploy, and Monitor (it is not part of the switch).
//     https://learn.microsoft.com/microsoft-copilot-studio/agents-experience/overview-customer-conversation
//   - The Agents list (the same on both hosts) is a table with an "Agent harness" column whose cell says "Microsoft Copilot" or "Standard".
//     https://learn.microsoft.com/microsoft-copilot-studio/agents-experience/agents-page
//   - "More create options" on the Agents list offers "Agent, uses Copilot Credits" (Microsoft Copilot), "Customer conversation agent, uses Copilot
//     Credits", and "Agent, Standard". What the flow shows AFTER choosing one was NOT observed (nothing was created).
//
// Nothing here touches a browser or the disk: it is plain data and small pure functions, so both sides test it the same way.

export const STANDARD = "standard";
export const MICROSOFT_COPILOT = "microsoft-copilot";
export const CUSTOMER_CONVERSATION = "customer-conversation";
/** A slot whose screen is the same in every harness (a page outside the agent, such as the admin center). */
export const EITHER = "either";

/** The harnesses a picture can actually be taken in. */
export const SPECIFIC_HARNESSES = Object.freeze([STANDARD, MICROSOFT_COPILOT, CUSTOMER_CONVERSATION]);

/** Plain text, never color alone, and no emoji. */
export const HARNESS_LABELS = Object.freeze({
  [STANDARD]: "Standard (Classic) harness",
  [MICROSOFT_COPILOT]: "Microsoft Copilot harness",
  [CUSTOMER_CONVERSATION]: "Customer Conversation harness (preview)",
  [EITHER]: "Works in either harness",
});
export const NOT_RECORDED_LABEL = "Harness not recorded";

/** Short names for sentences ("a Standard (Classic) picture"). */
export const HARNESS_SHORT = Object.freeze({
  [STANDARD]: "Standard (Classic)",
  [MICROSOFT_COPILOT]: "Microsoft Copilot",
  [CUSTOMER_CONVERSATION]: "Customer Conversation",
  [EITHER]: "either harness",
});

/** What a person does to get to each harness, in one sentence (shown on cards and in the capture plan). */
export const HARNESS_HOW = Object.freeze({
  [STANDARD]: "Switch to the classic experience first: click the ellipsis in the lower left corner, click Open classic experience, then click Skip feedback. The classic experience opens in a new browser tab on copilotstudio.preview.microsoft.com, and Standard agents open there.",
  [MICROSOFT_COPILOT]: "Go to copilotstudio.microsoft.com. A new agent there is a Microsoft Copilot harness agent by default (the Build, Preview, Evaluate, and Monitor tabs). Do not switch to the classic experience.",
  [CUSTOMER_CONVERSATION]: "Create the agent on the Customer Conversation harness (preview). It has a Deploy tab and is not part of the classic switch.",
  [EITHER]: "This screen is outside the agent, so it looks the same in every harness.",
});

export const HARNESS_SOURCES = Object.freeze({
  switch: "https://learn.microsoft.com/microsoft-copilot-studio/agents-experience/switch-experiences",
  copilot: "https://learn.microsoft.com/microsoft-copilot-studio/agents-experience/overview",
  customer: "https://learn.microsoft.com/microsoft-copilot-studio/agents-experience/overview-customer-conversation",
  agentsList: "https://learn.microsoft.com/microsoft-copilot-studio/agents-experience/agents-page",
  compare: "https://learn.microsoft.com/microsoft-copilot-studio/harnesses-overview",
});

/** The harness id a value names, `"either"`, or null. Anything else (including the catalog's group name "both") is not a harness of a picture. */
export function normalizeHarness(value) {
  const id = String(value ?? "").trim().toLowerCase();
  if (id === EITHER) return EITHER;
  return SPECIFIC_HARNESSES.includes(id) ? id : null;
}

export const isSpecificHarness = (value) => SPECIFIC_HARNESSES.includes(normalizeHarness(value));

/** "Standard (Classic) harness" and so on; an empty string for a value that is not a harness (a slot of a product with no harnesses shows nothing). */
export function harnessLabel(value) {
  const id = normalizeHarness(value);
  return id ? HARNESS_LABELS[id] : "";
}

export function harnessShort(value) {
  const id = normalizeHarness(value);
  return id ? HARNESS_SHORT[id] : "";
}

/** The label of a picture's stamp: its harness, or "Harness not recorded" when nothing was stamped. */
export function pictureHarnessLabel(stamp) {
  const id = normalizeHarness(stamp);
  return id && id !== EITHER ? HARNESS_LABELS[id] : NOT_RECORDED_LABEL;
}

// ── File names ─────────────────────────────────────────────────────────────
//
// In the shared library a picture of a harness-specific slot is saved under a name that carries the harness, so the owner can tell
// them apart in a file explorer, and a Standard picture and a Microsoft Copilot picture of the same slot can sit side by side:
//   agent-overview.png  ->  agent-overview.classic.png | agent-overview.copilot.png | agent-overview.customer.png
// A name with no tag is a picture from before harnesses were recorded ("Harness not recorded"), or a slot that is the same in either harness.

export const HARNESS_TAGS = Object.freeze({ [STANDARD]: "classic", [MICROSOFT_COPILOT]: "copilot", [CUSTOMER_CONVERSATION]: "customer" });
const TAG_TO_HARNESS = Object.freeze(Object.fromEntries(Object.entries(HARNESS_TAGS).map(([id, tag]) => [tag, id])));
const TAGGED_NAME = /^(.+)\.(classic|copilot|customer)(\.[A-Za-z0-9]+)$/;

/** `agent-overview.png` + standard -> `agent-overview.classic.png`. A name that already has this harness's tag is returned as it is. */
export function taggedName(filename, harness) {
  const id = normalizeHarness(harness);
  const name = String(filename ?? "");
  if (!id || id === EITHER) return name;
  const parts = splitTaggedName(name);
  const ext = /\.[A-Za-z0-9]+$/.exec(parts.base)?.[0] || "";
  return `${parts.base.slice(0, parts.base.length - ext.length)}.${HARNESS_TAGS[id]}${ext}`;
}

/** `{ base: "agent-overview.png", harness: "standard" }` for a tagged name; the name itself and `null` when it has no tag. */
export function splitTaggedName(name) {
  const text = String(name ?? "");
  const match = TAGGED_NAME.exec(text);
  if (!match) return { base: text, harness: null };
  return { base: `${match[1]}${match[3]}`, harness: TAG_TO_HARNESS[match[2]] };
}

/** The name a slot's picture has in the shared library: tagged for a harness-specific slot, plain for any other. */
export const libraryName = (filename, slotHarness) => taggedName(filename, isSpecificHarness(slotHarness) ? slotHarness : null);

/** The harness a name carries (null for an untagged name). */
export const harnessOfName = (name) => splitTaggedName(name).harness;

// ── Which harness a slot needs ─────────────────────────────────────────────

/**
 * The harness a picture of a slot IN A LAB is taken in. The lab's chosen harness is the authority: a lab built for the Standard (Classic)
 * harness only ever takes (or reuses) Standard (Classic) pictures, for every Copilot Studio slot in it, and a lab built for the Microsoft
 * Copilot harness only Microsoft Copilot pictures. A feature that is written for another harness does not change that: it is reported
 * as a gap (see `harnessGapFor`), never captured in the wrong harness. A slot of any other product has no harness (null). A slot the
 * catalog marks `"either"` (identical in every harness; none is today) is the one exception.
 *
 * @param {{product?: string, labHarness?: string|null, slotHarness?: string|null}} input
 * @returns {{id: string|null, source: "slot"|"lab"|"default"|"none"}}
 */
export function labSlotNeed({ product = "copilot-studio", labHarness = null, slotHarness = null } = {}) {
  if (String(product || "copilot-studio") !== "copilot-studio") return { id: null, source: "none" };
  if (normalizeHarness(slotHarness) === EITHER) return { id: EITHER, source: "slot" };
  const lab = normalizeHarness(labHarness);
  if (lab && lab !== EITHER) return { id: lab, source: "lab" };
  return { id: STANDARD, source: "default" };
}

/**
 * The harnesses the shared library keeps a picture for, for one catalog slot: a slot of a feature written for one harness has one picture;
 * a slot of a feature written for both the Standard and the Microsoft Copilot harness has one picture per harness, because a lab takes
 * the one its own harness needs. `[null]` for a product with no harnesses.
 * @returns {Array<string|null>}
 */
export function libraryVariants({ product = "copilot-studio", slotHarness = null, featureHarness = null } = {}) {
  if (String(product || "copilot-studio") !== "copilot-studio") return [null];
  const own = normalizeHarness(slotHarness);
  if (own === EITHER) return [EITHER];
  if (own) return [own];
  const raw = Array.isArray(featureHarness) ? featureHarness : [featureHarness];
  const tags = [...new Set(raw.map((h) => (String(h ?? "").trim().toLowerCase() === "both" ? [STANDARD, MICROSOFT_COPILOT] : [normalizeHarness(h)])).flat().filter((h) => h && h !== EITHER))];
  const ordered = SPECIFIC_HARNESSES.filter((h) => tags.includes(h));
  return ordered.length ? ordered : [STANDARD];
}

/**
 * Whether a lab's slot needs a harness its feature is not written for (for example a Microsoft Copilot-only module in a Standard lab).
 * @returns {{feature: string[], lab: string}|null} null when there is no gap
 */
export function harnessGapFor({ product = "copilot-studio", featureHarness = null, need = null } = {}) {
  if (String(product || "copilot-studio") !== "copilot-studio") return null;
  const wanted = normalizeHarness(need);
  if (!wanted || wanted === EITHER) return null;
  const variants = libraryVariants({ product, featureHarness });
  return variants.includes(wanted) ? null : { feature: variants, lab: wanted };
}

/**
 * The statement for a lab that covers two harnesses one after another (a combined lab). The lab has no single harness: every picture is taken
 * in the harness of the part it sits in, and a shared part (taught once, the same in both) is taken in the first harness of the order.
 * @param {string[]} order the two harness ids, first one first
 */
export function combinedHarnessStatement(order) {
  const ids = (Array.isArray(order) ? order : []).map(normalizeHarness).filter(isSpecificHarness);
  if (ids.length !== 2) return "";
  return `This lab: both harnesses, one after another (${HARNESS_LABELS[ids[0]]} first, then ${HARNESS_LABELS[ids[1]]}). Each picture is taken in the harness of the part it sits in, and the two are never crossed. A shared topic is taken in the ${HARNESS_LABELS[ids[0]]}.`;
}

/** The one sentence a lab's harness is stated with, on the Screenshot Center, in the capture plan, and in the dry plan. */
export function labHarnessStatement(harness) {
  const id = normalizeHarness(harness);
  if (!id || id === EITHER) return "";
  const where = { [STANDARD]: "the Classic harness", [MICROSOFT_COPILOT]: "the Microsoft Copilot harness", [CUSTOMER_CONVERSATION]: "the Customer Conversation harness" }[id];
  return `This lab: ${HARNESS_LABELS[id]}. Every picture is taken in ${where}.`;
}

/** The plain sentence for a shot whose feature is not written for the lab's harness (a gap that is reported, never captured elsewhere). */
export function harnessGapMessage(gap) {
  if (!gap || !gap.lab) return "";
  const written = (Array.isArray(gap.feature) ? gap.feature : []).map((h) => HARNESS_LABELS[h]).filter(Boolean);
  const list = written.length > 1 ? `${written.slice(0, -1).join(", ")} and ${written.at(-1)}` : written[0] || "another harness";
  return `This module is written for the ${list}, but this lab is built for the ${HARNESS_LABELS[gap.lab]}, so its picture cannot be taken in the lab's harness. Change the lab's modules or its harness.`;
}

/**
 * The harness a Copilot Studio slot needs when no lab is involved, and why (kept for callers that only know the slot):
 *   1. the slot's own harness in the catalog, when it names one;
 *   2. otherwise the harness of its feature, when the feature is written for exactly one;
 *   3. otherwise, for a feature written for several, the lab's chosen harness when the feature covers it, else the feature's first harness;
 *   4. a Copilot Studio slot with no harness information at all is a Standard slot (what the lab builder has always assumed).
 * A slot of any other product has no harness (null).
 *
 * @param {{product?: string, slotHarness?: string|null, featureHarness?: string[]|string|null, labHarness?: string|null}} input
 * @returns {{id: string|null, source: "slot"|"feature"|"lab"|"default"|"none"}}
 */
export function resolveSlotHarness({ product = "copilot-studio", slotHarness = null, featureHarness = null, labHarness = null } = {}) {
  if (String(product || "copilot-studio") !== "copilot-studio") return { id: null, source: "none" };
  const own = normalizeHarness(slotHarness);
  if (own) return { id: own, source: "slot" };
  const tags = [...new Set((Array.isArray(featureHarness) ? featureHarness : [featureHarness]).map(normalizeHarness).filter((h) => h && h !== EITHER))];
  if (tags.length === 1) return { id: tags[0], source: "feature" };
  const lab = normalizeHarness(labHarness);
  if (tags.length > 1) return lab && tags.includes(lab) ? { id: lab, source: "lab" } : { id: tags[0], source: "feature" };
  if (lab && lab !== EITHER) return { id: lab, source: "lab" };
  return { id: STANDARD, source: "default" };
}

// ── Whether a picture may satisfy a slot (the "never mix" rule) ────────────

/**
 * The one rule. A slot that needs a harness is satisfied only by a picture stamped with that harness. A picture with no stamp is never
 * reused for a harness-specific slot. A slot that is the same in either harness (or a slot of a product with no harnesses) accepts any picture.
 *
 * @param {string|null} slotHarness what the slot needs (a harness id, `"either"`, or null)
 * @param {string|null} pictureHarness what the picture is stamped with (null: nothing recorded)
 * @returns {{ok: boolean, code: "ok"|"not-recorded"|"wrong-harness", message: string}}
 */
export function pictureFitsSlot(slotHarness, pictureHarness) {
  const need = normalizeHarness(slotHarness);
  if (!need || need === EITHER) return { ok: true, code: "ok", message: "" };
  const has = normalizeHarness(pictureHarness);
  if (!has || has === EITHER) {
    return { ok: false, code: "not-recorded", message: `This picture has no harness recorded, so it is not used for a ${HARNESS_SHORT[need]} slot until you say which harness it shows.` };
  }
  if (has !== need) {
    return { ok: false, code: "wrong-harness", message: `This picture is from the ${HARNESS_LABELS[has]}, but this slot needs the ${HARNESS_LABELS[need]}.` };
  }
  return { ok: true, code: "ok", message: "" };
}

/** The sentence the companion uses when the page is in a different harness than the picture needs. */
export function wrongHarnessMessage(found, wanted) {
  const have = normalizeHarness(found);
  const need = normalizeHarness(wanted);
  const left = have && have !== EITHER ? `This agent is in the ${HARNESS_LABELS[have]}` : "The companion could not tell which harness this agent is in";
  return `${left}; this picture needs the ${need && need !== EITHER ? HARNESS_LABELS[need] : "right harness"}.`;
}

// ── What proves the page is in a harness (read by the companion) ───────────

/** The tabs of the newer layout. Both the Microsoft Copilot harness and the Customer Conversation harness have them; only the second has Deploy. */
export const NEWER_TABS = Object.freeze(["Build", "Preview", "Evaluate", "Monitor"]);
export const CUSTOMER_ONLY_TABS = Object.freeze(["Deploy"]);
/**
 * The TAB STRIP of a Standard agent page (observed 2026-11-24 on the preview host, /bots/<id>/overview): Overview, Knowledge, Tools, Agents, Topics,
 * Activity, Evaluation, and an overflow button ("2 more options") that is not a tab. Overview must be there, plus at least `min` of `anyOf`, and none
 * of the Microsoft Copilot tabs (Build, Preview, Evaluate, Monitor).
 */
export const CLASSIC_TABS = Object.freeze({
  required: ["Overview"],
  anyOf: ["Knowledge", "Tools", "Topics", "Agents", "Activity", "Evaluation"],
  min: 2,
});
/** Side navigation items of an OLDER classic build (before the tab strip). Overview must be there, plus at least one more of these. Kept only as a fallback. */
export const CLASSIC_NAV = Object.freeze({
  required: ["Overview"],
  anyOf: ["Knowledge", "Tools", "Actions", "Topics", "Analytics", "Channels", "Settings", "Evaluation", "Evaluations"],
});

const lower = (list) => new Set((Array.isArray(list) ? list : []).map((v) => String(v).trim().toLowerCase()));

/**
 * Which harness an agent page is in, from the control names it shows: the tabs of the tab strip (and, for an older build, the items of the
 * side navigation). Only control names are read, never page text. Returns `null` when the page shows none of them (not an agent page, not drawn yet,
 * or a mix that proves nothing).
 *   - Build, Preview, Evaluate, and Monitor (all four): the Microsoft Copilot harness (with Deploy: Customer Conversation);
 *   - Overview and at least two of Knowledge, Tools, Topics, Agents, Activity, Evaluation, and none of the four above: Standard (Classic);
 *   - older builds only: a side navigation with Overview and one more item, with the four-tab strip absent: Standard (Classic).
 * @param {{tabs?: string[], nav?: string[]}} seen
 * @returns {{harness: string, landmarks: string[]}|null}
 */
export function harnessFromLandmarks({ tabs = [], nav = [] } = {}) {
  const tabSet = lower(tabs);
  const navSet = lower(nav);
  const newerSeen = NEWER_TABS.filter((name) => tabSet.has(name.toLowerCase()));
  if (newerSeen.length === NEWER_TABS.length) {
    const deploy = CUSTOMER_ONLY_TABS.every((name) => tabSet.has(name.toLowerCase()));
    return deploy
      ? { harness: CUSTOMER_CONVERSATION, landmarks: [...NEWER_TABS, ...CUSTOMER_ONLY_TABS] }
      : { harness: MICROSOFT_COPILOT, landmarks: [...NEWER_TABS] };
  }
  if (!newerSeen.length && CLASSIC_TABS.required.every((name) => tabSet.has(name.toLowerCase()))) {
    const others = CLASSIC_TABS.anyOf.filter((name) => tabSet.has(name.toLowerCase()));
    if (others.length >= CLASSIC_TABS.min) return { harness: STANDARD, landmarks: [...CLASSIC_TABS.required, ...others.slice(0, 4)] };
  }
  if (CLASSIC_NAV.required.every((name) => navSet.has(name.toLowerCase()))) {
    const others = CLASSIC_NAV.anyOf.filter((name) => navSet.has(name.toLowerCase()));
    if (others.length) return { harness: STANDARD, landmarks: [...CLASSIC_NAV.required, ...others.slice(0, 4)] };
  }
  return null;
}

/** The one-line proof a plan prints for each harness: the landmark the companion looks for before it takes the picture. */
export const HARNESS_PROOF = Object.freeze({
  [STANDARD]: "A tab strip with Overview and at least two of Knowledge, Tools, Topics, Agents, Activity, or Evaluation, and no Build, Preview, Evaluate, and Monitor tabs (an older build: a side navigation with Overview and more).",
  [MICROSOFT_COPILOT]: "The Build, Preview, Evaluate, and Monitor tabs, and no Deploy tab.",
  [CUSTOMER_CONVERSATION]: "The Build, Preview, Evaluate, Deploy, and Monitor tabs.",
  [EITHER]: "None needed: the screen is outside the agent.",
});

/** The proof line of a shot whose screen is outside any agent (Home, the Agents list): its content proves nothing, so only the address host is checked. */
export const HARNESS_PROOF_ENVIRONMENT = "None by content: this screen is outside the agent (Home or the Agents list), so only the address host is checked, and the picture is saved for review so a person accepts it.";

/** The proof line a plan prints for one shot: the harness's landmark, or the host-only note for a screen outside any agent. */
export function harnessProofFor(harness, scope = "agent") {
  const id = normalizeHarness(harness);
  return scope === "environment" && isSpecificHarness(id) ? HARNESS_PROOF_ENVIRONMENT : HARNESS_PROOF[id] || "";
}

/** Where a Microsoft Copilot harness picture starts: the default experience. A page found in the classic experience goes back here. */
export const DEFAULT_EXPERIENCE_URL = "https://copilotstudio.microsoft.com/";
/** The same place as a host name, for the plan's sentences (a plan names no address, so it says the host the way a person would). */
export const DEFAULT_EXPERIENCE_HOST = "copilotstudio.microsoft.com";
/**
 * Where the classic experience lives (observed 2026-11-24): "Open classic experience" opens it in a NEW browser tab on this host, and a Standard agent
 * opens here at /environments/<env>/bots/<agent>/overview (the default address redirects to it by itself). The address also loads directly with the same sign-in.
 */
export const CLASSIC_EXPERIENCE_URL = "https://copilotstudio.preview.microsoft.com/";
export const CLASSIC_EXPERIENCE_HOST = "copilotstudio.preview.microsoft.com";
/** The two hosts that are Copilot Studio, for every check that asks "is this the product". Neither is another tenant. */
export const COPILOT_STUDIO_HOSTS = Object.freeze([DEFAULT_EXPERIENCE_HOST, CLASSIC_EXPERIENCE_HOST]);

/** "default" for the default experience's host, "classic" for the preview host, null for anything else. Accepts a host name or an address. */
export function experienceHostKind(value) {
  let host = String(value ?? "").trim().toLowerCase();
  if (!host) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(host)) {
    try {
      host = new URL(host).hostname.toLowerCase();
    } catch {
      return null;
    }
  }
  if (host === DEFAULT_EXPERIENCE_HOST) return "default";
  if (host === CLASSIC_EXPERIENCE_HOST) return "classic";
  return null;
}

/** The address of the default start page, or of the classic one, for the harness a picture needs. A harness with no host of its own gets null. */
export function experienceOriginFor(harness) {
  const id = normalizeHarness(harness);
  if (id === STANDARD) return `https://${CLASSIC_EXPERIENCE_HOST}`;
  if (id === MICROSOFT_COPILOT || id === CUSTOMER_CONVERSATION) return `https://${DEFAULT_EXPERIENCE_HOST}`;
  return null;
}

/**
 * The switch to the classic experience, exactly as the owner does it by hand: click the ellipsis (the "More options" button) in the LOWER LEFT corner
 * of the page, click "Open classic experience", then click "Skip feedback" on the feedback prompt that follows (never submit feedback). The same path
 * is documented on Microsoft Learn (Home, the three dots at the bottom of the side bar, Open classic experience).
 *
 * OBSERVED on a real tenant on 2026-11-24 (read only): the button is named "More options" and sits at the lower left; its menu (the same in every
 * experience, so it proves nothing about the page) offers See what's new, Solutions, Open classic experience, Power Platform Admin Center, Learning
 * resources, and Session details; the click shows a feedback prompt with a "Skip feedback" button, and then OPENS THE CLASSIC EXPERIENCE IN A NEW
 * BROWSER TAB on the preview host. The original tab stays on the default address, so the rest of a Standard picture is taken in the NEW tab. The page
 * takes 15 to 30 seconds to draw its controls, so the companion waits for them.
 *
 * The other candidate names are only a fallback for another build. An older build had a "New experience" toggle on the Home page instead.
 */
export const CLASSIC_SWITCH = Object.freeze({
  menu: { names: ["More options", "More", "Settings and more", "Options", "Menu", "...", "\u2026"], within: "nav", corner: "lower-left" },
  item: { names: ["Open classic experience", "Classic experience", "Switch to classic experience", "Open classic"], roles: ["menuitem", "button", "link"] },
  skipFeedback: { names: ["Skip feedback"], roles: ["button"], never: ["Submit", "Submit feedback", "Send feedback"] },
  toggle: { names: ["New experience"], roles: ["switch", "checkbox"], expect: "off" },
  // The command stays in the menu in every experience: nothing is concluded from it being there, or not.
  path: "ellipsis in the lower left corner > Open classic experience > Skip feedback",
  // What the click does: the classic experience opens in a new browser tab on this host.
  opens: "a new browser tab",
  host: CLASSIC_EXPERIENCE_HOST,
  observed: "2026-11-24",
  sources: [HARNESS_SOURCES.switch],
});

/**
 * The create options on the Agents list ("More create options", the same on both hosts; observed 2026-11-24, nothing was created). The Standard practice
 * agent starts from "Agent, Standard", the Microsoft Copilot one from "Agent, uses Copilot Credits". NOT VERIFIED on a real tenant: what the flow shows
 * after choosing one. The names are the only controls the creation step may click for this (see guard.mjs).
 */
export const CREATE_OPTIONS = Object.freeze({
  menu: { names: ["More create options"] },
  [STANDARD]: { names: ["Agent, Standard"] },
  [MICROSOFT_COPILOT]: { names: ["Agent, uses Copilot Credits"] },
  [CUSTOMER_CONVERSATION]: { names: ["Customer conversation agent, uses Copilot Credits"] },
});

/**
 * The rule for a screen outside any agent (Home, the Agents list). Such a screen looks the same in every harness and the "More options" menu is the same
 * everywhere, so NOTHING on it proves the harness. It is taken in the experience that matches the lab's harness (Standard: on the preview host after the
 * switch; Microsoft Copilot: on the default address), stamped with the address host and how the page was reached, and never counted as proven: it is
 * saved for review, so a person looks at it and accepts it.
 */
export const ENVIRONMENT_SCREEN_RULE = "A screen outside the agent (Home, the Agents list) cannot be proven by what it shows. It is taken in the experience that matches the lab's harness (Standard (Classic): on copilotstudio.preview.microsoft.com after the switch; Microsoft Copilot: on copilotstudio.microsoft.com), stamped with the address host and how the page was reached, and saved for review so a person accepts it.";

/**
 * What the capture plan says for a harness: the step that gets the page into it, and the landmark that proves it. `switch` is false for a
 * harness the companion never switches to (the default one, or one with its own creation path).
 * @returns {{harness: string, label: string, switch: boolean, switchStep: string, proof: string, environment: string}|null}
 */
export function harnessPlan(harness) {
  const id = normalizeHarness(harness);
  if (!id) return null;
  if (id === STANDARD) {
    return { harness: id, label: HARNESS_LABELS[id], switch: true, switchStep: `Switch: ${CLASSIC_SWITCH.path}. The click opens the classic experience in a new browser tab on ${CLASSIC_EXPERIENCE_HOST}; the picture is taken in that tab, where Standard agents open.`, proof: HARNESS_PROOF[id], environment: ENVIRONMENT_SCREEN_RULE };
  }
  if (id === MICROSOFT_COPILOT) {
    return { harness: id, label: HARNESS_LABELS[id], switch: false, switchStep: `No switch: use ${DEFAULT_EXPERIENCE_HOST} (the default experience) and an agent whose Agent harness column says Microsoft Copilot. A classic tab from an earlier picture is closed first; the classic experience is never used for this picture.`, proof: HARNESS_PROOF[id], environment: ENVIRONMENT_SCREEN_RULE };
  }
  if (id === CUSTOMER_CONVERSATION) {
    return { harness: id, label: HARNESS_LABELS[id], switch: false, switchStep: "No switch: the agent is created on the Customer Conversation harness (preview), which is not part of the classic switch.", proof: HARNESS_PROOF[id], environment: ENVIRONMENT_SCREEN_RULE };
  }
  return { harness: id, label: HARNESS_LABELS[id], switch: false, switchStep: "No switch needed.", proof: HARNESS_PROOF[id], environment: "" };
}

/** The "Powered by" cell of an OLDER Agents list, as the harness it names (null when the text names none). Anywhere in the text. */
export function harnessFromPoweredBy(text) {
  const value = String(text ?? "").toLowerCase();
  if (!value.trim()) return null;
  if (/customer\s+conversation|customer\s+assist/.test(value)) return CUSTOMER_CONVERSATION;
  if (/microsoft\s+copilot|github\s+copilot/.test(value)) return MICROSOFT_COPILOT;
  if (/\bstandard\b|\bclassic\b/.test(value)) return STANDARD;
  return null;
}

/**
 * The "Agent harness" cell of the Agents list (observed 2026-11-24), as the harness it names. The cell text STARTS with "Microsoft Copilot" or "Standard" and the
 * tooltip text is appended to it ("StandardThis agent runs on the standard harness. It doesn't use Copilot Credits for users with a Microsoft 365 Copilot
 * license."), so only the start is read: the tooltip's own words never decide. Null when the cell names none.
 */
export function harnessFromAgentHarness(text) {
  const value = String(text ?? "").trim().toLowerCase();
  if (!value) return null;
  if (/^customer\s+conversation/.test(value)) return CUSTOMER_CONVERSATION;
  if (/^microsoft\s+copilot/.test(value)) return MICROSOFT_COPILOT;
  // The tooltip follows the label with no space ("StandardThis agent runs on..."), so the label is read from the start and nothing after it matters.
  if (/^(?:standard|classic)/.test(value)) return STANDARD;
  return null;
}

// ── The proof a companion sends with a picture ─────────────────────────────

/** Version of the `evidence.harness` block (separate from the evidence version, so older pictures are never re-judged by it). 2: adds `host` and `via`. */
export const HARNESS_PROOF_VERSION = 2;
/** The first companion that proves the harness the way the real product behaves (the new tab, the tab strip, the Agent harness column). */
export const HARNESS_MIN_COMPANION = "1.8.1";

/** How the page a picture was taken in was reached: the click path (More options > Open classic experience), the preview address opened directly, or the default address. */
export const HARNESS_VIA = Object.freeze(["click-path", "preview-address", "default-address"]);
/** The landmark lines of the retired menu proof (companion 1.8.0): the menu offers the command in every experience, so such a proof proves nothing and is refused. */
const RETIRED_PROOF_LANDMARK = /^(?:menu in the lower left corner|open classic experience offered|no open classic experience command)$/i;

const cleanLine = (value, max = 60) => String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
/** A host name that is Copilot Studio, or "": nothing else (no tenant name, no address) is ever kept. */
const knownHost = (value) => (COPILOT_STUDIO_HOSTS.includes(String(value ?? "").toLowerCase()) ? String(value).toLowerCase() : "");
const knownVia = (value) => (HARNESS_VIA.includes(String(value ?? "")) ? String(value) : "");

/**
 * Clean the harness proof a companion reports. Returns null for anything that is not a complete, current proof.
 * `id` is the harness the page was proven to be in; `wanted` is what the slot needed; `host` and `via` say where the page was and how it was reached.
 * A proof made of the retired menu lines (companion 1.8.0, a page outside an agent) is refused: that proof could not tell the experiences apart.
 */
export function sanitizeHarnessProof(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = normalizeHarness(raw.id);
  if (!id || id === EITHER) return null;
  if (!Number.isInteger(raw.version) || raw.version < 1) return null;
  if (raw.proof !== "landmarks") return null;
  const landmarks = (Array.isArray(raw.landmarks) ? raw.landmarks : []).slice(0, 8).map((l) => cleanLine(l)).filter(Boolean);
  if (!landmarks.length) return null;
  if (landmarks.some((l) => RETIRED_PROOF_LANDMARK.test(l))) return null;
  const wanted = normalizeHarness(raw.wanted);
  const host = knownHost(raw.host);
  const via = knownVia(raw.via);
  return { version: HARNESS_PROOF_VERSION, id, proof: "landmarks", landmarks, switched: raw.switched === true, ...(wanted ? { wanted } : {}), ...(host ? { host } : {}), ...(via ? { via } : {}) };
}

/**
 * The record a companion keeps for a screen OUTSIDE any agent (Home, the Agents list): the harness the page was taken in, the host it was on, and how it was reached.
 * It is NOT a proof (nothing on such a screen proves a harness), so a picture that has only this goes to review. Null for anything incomplete.
 */
export function sanitizeHarnessReached(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = normalizeHarness(raw.id);
  if (!id || id === EITHER) return null;
  const host = knownHost(raw.host);
  const via = knownVia(raw.via);
  if (!host || !via) return null;
  return { version: HARNESS_PROOF_VERSION, id, scope: "environment", host, via, proven: false };
}

// ── Practice agent names (added by the companion) ──────────────────────────
//
// The computer builds one practice agent per harness (a Classic agent for Standard (Classic) pictures, a Microsoft Copilot agent for Microsoft
// Copilot pictures), so the name carries a short harness marker and the two can never be mistaken for each other in the Agents list. The product cuts
// an agent's name at 30 characters, so the marker is compact and the lab's short title is cut to fit. The older name "Lab screenshots - <title>"
// belongs to agents made before harnesses were recorded; it is still recognized as ours, but such an agent is never reused for a harness-specific picture.

export const PRACTICE_AGENT_PREFIXES = Object.freeze({
  [STANDARD]: "Classic shots - ",
  [MICROSOFT_COPILOT]: "Copilot shots - ",
  [CUSTOMER_CONVERSATION]: "Customer shots - ",
});

/** The harness a practice agent's name says it was built for (null for the older name, or a name that is not ours). */
export function harnessOfPracticeName(name) {
  const text = String(name ?? "");
  for (const [id, prefix] of Object.entries(PRACTICE_AGENT_PREFIXES)) if (text.startsWith(prefix)) return id;
  return null;
}
