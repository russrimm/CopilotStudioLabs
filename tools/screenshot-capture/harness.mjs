// The one place that knows what a Copilot Studio "harness" means for a screenshot. The portal (labels, slot matching, the
// shared library) and the Local Capture Companion (the switch to the Classic harness and the proof that the page is in the
// right one) both import it, so a picture can never be called one harness by one side and another by the other.
//
// Facts this file rests on (Microsoft Learn):
//   - A new agent is a Microsoft Copilot harness agent by default; a Standard (Classic) harness agent is reached by switching to the
//     classic experience first: Home, the three dots (...) at the bottom of the side bar, Open classic experience. The switch lasts for
//     the current Copilot Studio session only.
//     https://learn.microsoft.com/microsoft-copilot-studio/agents-experience/switch-experiences
//   - A Microsoft Copilot harness agent has the tabs Build, Preview, Evaluate, and Monitor.
//     https://learn.microsoft.com/microsoft-copilot-studio/agents-experience/overview
//   - A Customer Conversation harness agent has Build, Preview, Evaluate, Deploy, and Monitor (it is not part of the switch).
//     https://learn.microsoft.com/microsoft-copilot-studio/agents-experience/overview-customer-conversation
//   - The Agents list has a "Powered by" column naming the harness of each agent, and a Standard harness agent opens in the classic experience.
//     https://learn.microsoft.com/microsoft-copilot-studio/agents-experience/agents-page
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
  [STANDARD]: "Switch to the classic experience first: click the ellipsis in the lower left corner, click Open classic experience, then click Skip feedback.",
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
  return `${left}; this picture needs the ${need && need !== EITHER ? HARNESS_LABELS[need] : "right"} harness.`;
}

// ── What proves the page is in a harness (read by the companion) ───────────

/** The tabs of the newer layout. Both the Microsoft Copilot harness and the Customer Conversation harness have them; only the second has Deploy. */
export const NEWER_TABS = Object.freeze(["Build", "Preview", "Evaluate", "Monitor"]);
export const CUSTOMER_ONLY_TABS = Object.freeze(["Deploy"]);
/** Side navigation items of the classic layout. Overview must be there, plus at least one more of these. */
export const CLASSIC_NAV = Object.freeze({
  required: ["Overview"],
  anyOf: ["Knowledge", "Tools", "Actions", "Topics", "Analytics", "Channels", "Settings", "Evaluation", "Evaluations"],
});

const lower = (list) => new Set((Array.isArray(list) ? list : []).map((v) => String(v).trim().toLowerCase()));

/**
 * Which harness an agent page is in, from the control names it shows: the tabs of the tab strip and the items of the side navigation.
 * Only control names are read, never page text. Returns `null` when the page shows neither layout (not an agent page, or not drawn yet).
 * @param {{tabs?: string[], nav?: string[]}} seen
 * @returns {{harness: string, landmarks: string[]}|null}
 */
export function harnessFromLandmarks({ tabs = [], nav = [] } = {}) {
  const tabSet = lower(tabs);
  const navSet = lower(nav);
  const newer = NEWER_TABS.every((name) => tabSet.has(name.toLowerCase()));
  if (newer) {
    const deploy = CUSTOMER_ONLY_TABS.every((name) => tabSet.has(name.toLowerCase()));
    return deploy
      ? { harness: CUSTOMER_CONVERSATION, landmarks: [...NEWER_TABS, ...CUSTOMER_ONLY_TABS] }
      : { harness: MICROSOFT_COPILOT, landmarks: [...NEWER_TABS] };
  }
  if (CLASSIC_NAV.required.every((name) => navSet.has(name.toLowerCase()))) {
    const others = CLASSIC_NAV.anyOf.filter((name) => navSet.has(name.toLowerCase()));
    if (others.length) return { harness: STANDARD, landmarks: [...CLASSIC_NAV.required, ...others.slice(0, 4)] };
  }
  return null;
}

/** The one-line proof a plan prints for each harness: the landmark the companion looks for before it takes the picture. */
export const HARNESS_PROOF = Object.freeze({
  [STANDARD]: "Side navigation with Overview and at least one of Knowledge, Tools, Topics, Analytics, or Channels, and no Build, Preview, Evaluate, and Monitor tab strip.",
  [MICROSOFT_COPILOT]: "The Build, Preview, Evaluate, and Monitor tabs, and no Deploy tab.",
  [CUSTOMER_CONVERSATION]: "The Build, Preview, Evaluate, Deploy, and Monitor tabs.",
  [EITHER]: "None needed: the screen is outside the agent.",
});

/**
 * The switch to the classic experience, exactly as the owner does it by hand: click the ellipsis (three dots) in the LOWER LEFT corner of the
 * page, click "Open classic experience", then click "Skip feedback" on the feedback prompt that follows (never submit feedback). The same path
 * is documented on Microsoft Learn (Home, the three dots at the bottom of the side bar, Open classic experience). The switch lasts for the
 * browser session, so it is made once and the landmark is checked again before every Classic picture.
 *
 * The visible words "Open classic experience" and "Skip feedback" are the owner's; the ellipsis has no visible name, so its accessible
 * names are a short list of candidates tried in order. They are NOT verified on a real tenant. An older build had a "New experience" toggle
 * on the Home page instead; it is kept only as a fallback.
 */
export const CLASSIC_SWITCH = Object.freeze({
  menu: { names: ["More", "More options", "Settings and more", "Options", "Menu", "...", "\u2026"], within: "nav", corner: "lower-left" },
  item: { names: ["Open classic experience", "Classic experience", "Switch to classic experience", "Open classic"], roles: ["menuitem", "button", "link"] },
  skipFeedback: { names: ["Skip feedback"], roles: ["button"], never: ["Submit", "Submit feedback", "Send feedback"] },
  toggle: { names: ["New experience"], roles: ["switch", "checkbox"], expect: "off" },
  // After the switch, the classic experience is offered as already open: the menu no longer lists the command, or the toggle is off.
  gone: ["Open classic experience"],
  path: "ellipsis in the lower left corner > Open classic experience > Skip feedback",
  sources: [HARNESS_SOURCES.switch],
});

/** Where a Microsoft Copilot harness picture starts: the default experience. A page found in the classic experience goes back here. */
export const DEFAULT_EXPERIENCE_URL = "https://copilotstudio.microsoft.com/";
/** The same place as a host name, for the plan's sentences (a plan names no address, so it says the host the way a person would). */
export const DEFAULT_EXPERIENCE_HOST = "copilotstudio.microsoft.com";

/**
 * What the capture plan says for a harness: the step that gets the page into it, and the landmark that proves it. `switch` is false for a
 * harness the companion never switches to (the default one, or one with its own creation path).
 * @returns {{harness: string, label: string, switch: boolean, switchStep: string, proof: string}|null}
 */
export function harnessPlan(harness) {
  const id = normalizeHarness(harness);
  if (!id) return null;
  if (id === STANDARD) {
    return { harness: id, label: HARNESS_LABELS[id], switch: true, switchStep: `Switch: ${CLASSIC_SWITCH.path}.`, proof: HARNESS_PROOF[id] };
  }
  if (id === MICROSOFT_COPILOT) {
    return { harness: id, label: HARNESS_LABELS[id], switch: false, switchStep: `No switch: open ${DEFAULT_EXPERIENCE_HOST} (the default experience). A page found in the classic experience goes back there; the classic experience is never used for this picture.`, proof: HARNESS_PROOF[id] };
  }
  if (id === CUSTOMER_CONVERSATION) {
    return { harness: id, label: HARNESS_LABELS[id], switch: false, switchStep: "No switch: the agent is created on the Customer Conversation harness (preview), which is not part of the classic switch.", proof: HARNESS_PROOF[id] };
  }
  return { harness: id, label: HARNESS_LABELS[id], switch: false, switchStep: "No switch needed.", proof: HARNESS_PROOF[id] };
}

/** The "Powered by" cell of the Agents list, as the harness it names (null when the text names none). */
export function harnessFromPoweredBy(text) {
  const value = String(text ?? "").toLowerCase();
  if (!value.trim()) return null;
  if (/customer\s+conversation|customer\s+assist/.test(value)) return CUSTOMER_CONVERSATION;
  if (/microsoft\s+copilot|github\s+copilot/.test(value)) return MICROSOFT_COPILOT;
  if (/\bstandard\b|\bclassic\b/.test(value)) return STANDARD;
  return null;
}

// ── The proof a companion sends with a picture ─────────────────────────────

/** Version of the `evidence.harness` block (separate from the evidence version, so older pictures are never re-judged by it). */
export const HARNESS_PROOF_VERSION = 1;
/** The first companion that proves the harness before it takes a picture. */
export const HARNESS_MIN_COMPANION = "1.8.0";

/**
 * Clean the harness proof a companion reports. Returns null for anything that is not a complete, current proof.
 * `id` is the harness the page was proven to be in; `wanted` is what the slot needed.
 */
export function sanitizeHarnessProof(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = normalizeHarness(raw.id);
  if (!id || id === EITHER) return null;
  if (!Number.isInteger(raw.version) || raw.version < HARNESS_PROOF_VERSION) return null;
  if (raw.proof !== "landmarks") return null;
  const landmarks = (Array.isArray(raw.landmarks) ? raw.landmarks : []).slice(0, 8).map((l) => String(l ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 60)).filter(Boolean);
  if (!landmarks.length) return null;
  const wanted = normalizeHarness(raw.wanted);
  return { version: HARNESS_PROOF_VERSION, id, proof: "landmarks", landmarks, switched: raw.switched === true, ...(wanted ? { wanted } : {}) };
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
