/**
 * Decides which screenshots look like the WRONG screen, from what the portal can see without reading the picture's text.
 *
 * A picture is judged by four kinds of evidence, in this order of trust:
 *
 *   1. The check saved when it was captured (`verification.json`, `library-verification.json`): the page address, the steps the
 *      computer took, whether account details were masked, and (newer companions) what the page showed.
 *   2. What the SLOT expects: a start page (home, the list of agents), an agent's main page, one page of the product, or a deeper
 *      screen (a dialog, a panel, a result, another product's section). It comes from the capture plan (classify.js).
 *   3. The picture itself, as a fingerprint (fingerprint.mjs): two slots that hold the same picture are suspicious.
 *   4. What the other pictures show.
 *
 * What this cannot do: it does not read text in a picture. It cannot see a name, a greeting, an account chip, or a list of recent
 * chats; it can only tell when the evidence says one may be there (an older companion could not mask them) or when masking was
 * requested and not applied. It cannot tell a signed-out page from a signed-in one unless the check recorded a sign-in cue or no
 * account control was found. Everything it cannot decide is "probable" (a person looks), never "definite".
 *
 * Levels:
 *   definite  the evidence says the picture cannot show the screen its slot describes (it never left the start page, it is the
 *             same picture as other slots that cannot all be right, a sign-in page, masking was not applied)
 *   probable  a person should glance at it (the same picture under slots that might truly share a screen, no account control found,
 *             a start page an older companion could not mask)
 *   A picture a person marked "Keep this one" (a Confirmed mark on its exact bytes) is never flagged.
 */

import { NEAR_DISTANCE, distance, isFingerprint } from "../../../tools/screenshot-capture/fingerprint.mjs";
import { harnessLabel, harnessReview, isSpecificHarness, normalizeHarness } from "../../../tools/screenshot-capture/harness.mjs";
import { parseCopilotStudioAddress } from "../../../tools/screenshot-capture/targets.mjs";

export const FLAGS = Object.freeze({
  HARNESS_MIXED: "HARNESS_MIXED",
  HARNESS_MISMATCH: "HARNESS_MISMATCH",
  DUPLICATE_ACROSS_SLOTS: "DUPLICATE_ACROSS_SLOTS",
  NEAR_DUPLICATE: "NEAR_DUPLICATE",
  SIGNED_OUT_OR_MARKETING: "SIGNED_OUT_OR_MARKETING",
  LANDING_PAGE: "LANDING_PAGE",
  WRONG_PRODUCT: "WRONG_PRODUCT",
  POSSIBLE_IDENTITY: "POSSIBLE_IDENTITY",
});

/** The order a picture's reasons are shown in: the plainest, most certain reason first. */
export const FLAG_ORDER = Object.freeze([FLAGS.HARNESS_MISMATCH, FLAGS.HARNESS_MIXED, FLAGS.SIGNED_OUT_OR_MARKETING, FLAGS.LANDING_PAGE, FLAGS.DUPLICATE_ACROSS_SLOTS, FLAGS.NEAR_DUPLICATE, FLAGS.WRONG_PRODUCT, FLAGS.POSSIBLE_IDENTITY]);

/** The companion version that first reported what the page showed (see EVIDENCE_VERSION in image-verify.mjs). */
export const CURRENT_EVIDENCE_VERSION = 2;

const clean = (value, max = 200) => String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

// ── The page a picture shows, from its address ──────────────────────────────

/** The family of a host name: "make.powerapps.com" -> "powerapps.com". */
export function hostFamily(host) {
  const parts = String(host || "").toLowerCase().split(".").filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join(".") : parts.join(".");
}

const HOST_ALIASES = [
  ["powerapps.com", "powerautomate.com", "powerplatform.com"],
  ["microsoft.com", "cloud.microsoft", "office.com", "microsoft365.com", "microsoftonline.com"],
  ["azure.com", "microsoft.com"],
];

/** Whether two host families are the same product's (Power Apps and Power Automate are one platform; so are the Microsoft 365 hosts). */
export function sameHostFamily(first, second) {
  if (!first || !second) return false;
  if (first === second) return true;
  return HOST_ALIASES.some((group) => group.includes(first) && group.includes(second));
}

function parseUrl(raw) {
  try {
    return new URL(String(raw ?? ""));
  } catch {
    return null;
  }
}

const GENERIC_LANDING_PATH = /^(?:|home|start|chat|welcome|nextgen|overview|dashboard)$/i;

/** Whether an address is a product's start page: its home, its chat start, or the list of agents. */
export function isLandingUrl(raw) {
  const url = parseUrl(raw);
  if (!url) return false;
  const cs = parseCopilotStudioAddress(url.href);
  if (cs.ok) {
    if (!cs.envId) return true;
    return !cs.botId && (cs.area === null || cs.area === "home" || cs.area === "agents");
  }
  const segments = url.pathname.split("/").filter(Boolean);
  // Power Apps and Power Automate keep the environment in the path: /environments/<id>/home.
  const rest = segments[0] === "environments" ? segments.slice(2) : segments;
  return rest.length <= 1 && GENERIC_LANDING_PATH.test(rest[0] || "");
}

/** A page type that lists a person's recent items or chats: a greeting, a "Recent" list, chat history. */
const GREETING_HOSTS = [/(^|\.)copilot\.cloud\.microsoft$/i, /(^|\.)m365\.cloud\.microsoft$/i, /(^|\.)microsoft365\.com$/i, /(^|\.)office\.com$/i];
export function isHistoryPageUrl(raw) {
  const url = parseUrl(raw);
  if (!url || !GREETING_HOSTS.some((re) => re.test(url.hostname))) return false;
  return /^\/(?:|home|chat|search)\/?$/i.test(url.pathname) || /^\/chat\//i.test(url.pathname);
}

// ── What a slot expects ─────────────────────────────────────────────────────

/**
 * How deep a slot's screen is, from the capture plan's classification:
 *   landing     a product start page (home, the list of agents)
 *   agent-page  an agent's own main page (Overview, Build, instructions)
 *   page        one page of the product that has its own address (Analytics, an admin center page)
 *   deep        anything that needs more than opening a page: a dialog, a panel, a result, an item, another product's section
 *   outside     outside the browser (a terminal, Visual Studio Code)
 * @param {object} capture the slot's `classifyShot` result
 * @param {{section?: string}} [shot]
 */
export function slotDepth(capture, shot = {}) {
  if (!capture) return "deep";
  if (capture.mode === "manual") return "outside";
  const screen = capture.screen?.id || "";
  const section = String(shot.section || capture.section || "").toLowerCase();
  if (capture.product === "copilot-studio") {
    if (screen === "home" || screen === "agents") return "landing";
    if (capture.mode === "auto") return screen === "overview" ? "agent-page" : "page";
    if (screen === "overview" && /^(?:agents?|overview|build|)$/.test(section) && !["dialog", "test-result", "error-state"].includes(String(shot.kind || ""))) return "agent-page";
    return "deep";
  }
  if (capture.mode === "auto") return section === "home" || screen === "start" || section === "" ? "landing" : "page";
  return "deep";
}

/** The plain name of a depth, for a sentence: "the Power Apps start page" is built from the product, not from here. */
export const DEPTH_WORDS = Object.freeze({ landing: "a start page", "agent-page": "an agent's main page", page: "one page of the product", deep: "a screen inside the product", outside: "a screen outside the browser" });

// ── What a picture reached, from the check saved when it was captured ───────

const PASSIVE_ACTIONS = new Set(["screenshot", "verify", "wait-for"]);
const TAB_ACTIONS = new Set(["select-tab"]);
const NAV_ACTIONS = new Set(["navigate", "reveal", "open-agent"]);

/**
 * How far the computer took the screen before the picture, from the steps saved in its check:
 *   landing  it opened the product's start page and took the picture
 *   tab      it selected a tab of the agent (Build) and took the picture
 *   page     it opened one specific page by its address, or by the product's own navigation
 *   deep     it opened or typed or chose something (or a person set the screen up)
 *   unknown  the check does not say (a picture put in by hand, an old check)
 * @returns {{reach: "landing"|"tab"|"page"|"deep"|"unknown", why: string}}
 */
export function reachOf(record) {
  if (!record || typeof record !== "object") return { reach: "unknown", why: "There is no saved check for this picture." };
  const capture = record.capture;
  if (!capture || typeof capture !== "object") return { reach: "unknown", why: "The saved check does not say how the picture was taken." };
  if (capture.mode === "guided") return { reach: "deep", why: "A person set the screen up." };
  const steps = Array.isArray(capture.steps) ? capture.steps.filter((s) => s && typeof s === "object") : [];
  if (!steps.length) return { reach: "unknown", why: "The saved check has no steps." };
  // A step with an address before it is the computer opening a page; the others are clicks inside it.
  const ui = steps.filter((s) => s.ok !== false && !s.urlBefore && !PASSIVE_ACTIONS.has(s.action));
  if (ui.some((s) => !TAB_ACTIONS.has(s.action) && !NAV_ACTIONS.has(s.action))) return { reach: "deep", why: "The computer opened or chose something on the page." };
  if (ui.some((s) => NAV_ACTIONS.has(s.action))) return { reach: "page", why: "The computer used the product's own navigation." };
  if (ui.some((s) => TAB_ACTIONS.has(s.action))) {
    // In the newer agent layout Analytics is the Monitor tab and its address says so: that is one page of the product, not the agent's main tab.
    const parsed = parseCopilotStudioAddress(record.finalUrl);
    if (parsed.ok && parsed.botId && parsed.section && parsed.section !== "overview") return { reach: "page", why: "The computer selected a tab and the page address names that page." };
    return { reach: "tab", why: "The computer selected a tab and took the picture." };
  }
  if (!record.finalUrl) return { reach: "unknown", why: "The saved check has no page address." };
  return isLandingUrl(record.finalUrl) ? { reach: "landing", why: "The computer opened the start page and took the picture." } : { reach: "page", why: "The computer opened one page by its address." };
}

/** Whether a picture that reached `reach` can truthfully be the screen of a slot of this depth. Unknown evidence never rules a slot out. */
export function canExpect(depth, reach) {
  if (reach === "unknown") return true;
  if (depth === "outside") return false;
  if (depth === "landing") return true;
  if (depth === "agent-page") return reach !== "landing";
  if (depth === "page") return reach === "page" || reach === "deep";
  return reach === "deep";
}

// ── The assessment ──────────────────────────────────────────────────────────

const hasReason = (record, code) => Array.isArray(record?.reasons) && record.reasons.some((r) => r?.code === code);
const SIGN_IN_TITLE = /^\s*(?:sign in|sign in to your account|pick an account)\s*$/i;

function labelOf(item) {
  return clean(item.slot?.label || item.filename, 120);
}

function othersOf(members, self, max = 6) {
  const seen = new Set([self.filename]);
  const out = [];
  for (const member of members) {
    if (seen.has(member.filename)) continue;
    seen.add(member.filename);
    out.push({ filename: member.filename, label: labelOf(member) });
    if (out.length >= max) break;
  }
  return out;
}

function listNames(others, total) {
  const names = others.map((o) => o.label);
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, 2).join(", ")}, and ${total - 2} other${total - 2 === 1 ? "" : "s"}`;
}

/**
 * Assess every picture against the others.
 *
 * @param {Array<{id: string, scope: "library"|"lab", labId?: string|null, filename: string, sha256: string, fingerprint?: object|null, record?: object|null, confirmed?: boolean, slot?: {product?: string, depth?: string, label?: string}|null}>} pictures
 * @param {{nearDistance?: number, productHosts?: Record<string, string[]>}} [options] `productHosts`: product id -> host families the product's pages live on
 * @returns {Array<{id: string, level: "definite"|"probable"|null, flags: Array<{code: string, level: "definite"|"probable", message: string, others?: Array<{filename: string, label: string}>}>, reach: string, depth: string|null, cluster: string|null}>}
 */
export function assessPictures(pictures, { nearDistance = NEAR_DISTANCE, productHosts = {} } = {}) {
  const items = pictures.map((p) => ({ ...p }));

  // A picture copied into a lab has no check of its own: it takes the check saved for the same bytes elsewhere.
  const recordBySha = new Map();
  for (const item of items) {
    if (item.record && item.record.sha256 === item.sha256 && !recordBySha.has(item.sha256)) recordBySha.set(item.sha256, item.record);
  }
  for (const item of items) {
    item.effective = item.record && item.record.sha256 === item.sha256 ? item.record : recordBySha.get(item.sha256) || null;
    item.reachInfo = reachOf(item.effective);
    item.depth = item.slot?.depth || null;
    item.flags = [];
  }

  // Clusters: the same bytes, or a fingerprint that looks the same.
  const bySha = new Map();
  for (const item of items) {
    if (!bySha.has(item.sha256)) bySha.set(item.sha256, []);
    bySha.get(item.sha256).push(item);
  }
  const unique = [...bySha.keys()];
  const parent = new Map(unique.map((sha) => [sha, sha]));
  const find = (sha) => {
    let root = sha;
    while (parent.get(root) !== root) root = parent.get(root);
    let walk = sha;
    while (parent.get(walk) !== root) {
      const next = parent.get(walk);
      parent.set(walk, root);
      walk = next;
    }
    return root;
  };
  const prints = unique.map((sha) => ({ sha, fp: bySha.get(sha).find((i) => isFingerprint(i.fingerprint))?.fingerprint || null })).filter((p) => p.fp);
  for (let i = 0; i < prints.length; i += 1) {
    for (let j = i + 1; j < prints.length; j += 1) {
      const gap = distance(prints[i].fp, prints[j].fp);
      if (gap !== null && gap <= nearDistance) parent.set(find(prints[j].sha), find(prints[i].sha));
    }
  }
  const clusters = new Map();
  for (const item of items) {
    const root = find(item.sha256);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(item);
  }

  let clusterNumber = 0;
  for (const members of clusters.values()) {
    const slots = new Set(members.map((m) => m.filename));
    if (slots.size < 2) continue;
    clusterNumber += 1;
    const id = `c${clusterNumber}`;
    for (const member of members) member.cluster = id;
    // One picture can show only one harness: the same picture under a Standard (Classic) slot and a Microsoft Copilot slot is wrong for one of them,
    // and a person's "Keep this one" does not change that.
    const harnessOf = (m) => normalizeHarness(m.slot?.harness);
    const harnesses = new Set(members.map(harnessOf).filter(isSpecificHarness));
    if (harnesses.size > 1) {
      for (const member of members) {
        const mine = harnessOf(member);
        if (!isSpecificHarness(mine)) continue;
        const others = othersOf(members.filter((m) => harnessOf(m) !== mine && isSpecificHarness(harnessOf(m))), member);
        const names = listNames(others, others.length);
        member.flags.push({
          code: FLAGS.HARNESS_MIXED,
          level: "definite",
          message: `This is the same picture that is used for ${names} in the ${[...harnesses].filter((h) => h !== mine).map(harnessLabel).join(" and the ")}. A picture can show only one harness, and this screenshot needs the ${harnessLabel(mine)}.`,
          others,
        });
      }
    }
    // Which slots can truthfully show this picture? A slot that expects a deeper screen than the picture reached cannot.
    const truthful = members.filter((m) => m.confirmed || !m.depth || canExpect(m.depth, m.reachInfo.reach));
    const truthfulSlots = new Set(truthful.map((m) => m.filename));
    for (const member of members) {
      if (member.confirmed) continue;
      const inTruth = truthful.includes(member);
      if (inTruth && truthfulSlots.size <= 1) continue;
      const others = othersOf(members, member);
      const total = [...slots].filter((name) => name !== member.filename).length;
      const identical = members.some((m) => m !== member && m.filename !== member.filename && m.sha256 === member.sha256);
      const level = inTruth ? "probable" : "definite";
      const names = listNames(others, total);
      const message = inTruth
        ? `This ${identical ? "is the same picture as" : "looks the same as"} ${names}. They may show the same screen; check that each one shows what its lab describes.`
        : `This ${identical ? "is the same picture as" : "looks the same as"} ${names}, so it cannot show the screen this lab describes${member.depth && member.depth !== "landing" ? ` (${DEPTH_WORDS[member.depth] || "a deeper screen"})` : ""}.`;
      member.flags.push({ code: identical ? FLAGS.DUPLICATE_ACROSS_SLOTS : FLAGS.NEAR_DUPLICATE, level, message, others });
    }
  }

  for (const item of items) {
    // A picture taken in another harness than its slot needs is wrong for the slot, and a person's "Keep this one" does not change that.
    const needs = normalizeHarness(item.slot?.harness);
    const mismatch = harnessMismatch(item, needs);
    if (mismatch) {
      item.flags.push({ code: FLAGS.HARNESS_MISMATCH, level: "definite", message: mismatch.message });
      item.harnessSeen = { id: mismatch.found, source: mismatch.source };
    }
    if (item.confirmed) continue;
    const record = item.effective;
    const { reach } = item.reachInfo;
    const evidenceVersion = Number(record?.evidenceVersion || 1);

    // A start page (or the agent's main tab) for a slot that describes something deeper. A label matching is no defense: the start page shows
    // the product's own navigation, so "AI hub" or "Settings" is on it too (half of the expected labels matched on pictures that were start pages).
    if (item.depth && reach !== "unknown" && !canExpect(item.depth, reach)) {
      const where = reach === "landing" ? "the product's start page" : reach === "tab" ? "the agent's main tab" : "one page of the product";
      item.flags.push({
        code: FLAGS.LANDING_PAGE,
        level: "definite",
        message: `This shows ${where}, but its lab describes ${DEPTH_WORDS[item.depth] || "a deeper screen"}${item.slot?.label ? ` (${item.slot.label})` : ""}. The computer never opened that screen.`,
      });
    }

    // A page that is not the product: a sign-in cue was recorded, or no account control was found on the page at all.
    const title = clean(record?.pageTitle, 120);
    const signedOutSignals = record?.signals?.signInVisible === true && record?.signals?.accountControl === false;
    const cue = hasReason(record, "sign-in-page") || hasReason(record, "signed-out-page") || signedOutSignals || SIGN_IN_TITLE.test(title);
    if (cue) {
      item.flags.push({ code: FLAGS.SIGNED_OUT_OR_MARKETING, level: "definite", message: "This shows a sign-in or public page, not the product. The browser was not signed in when it was taken." });
    } else if (record && record.redaction && record.redaction.applied === true && Number(record.redaction.masked) === 0 && record.mode !== "guided" && evidenceVersion < CURRENT_EVIDENCE_VERSION) {
      item.flags.push({
        code: FLAGS.SIGNED_OUT_OR_MARKETING,
        level: "probable",
        message: "No account menu was found on this page, so the browser may not have been signed in (a public page shows a Sign in button instead). It may also be an account control the masking did not recognize.",
      });
    }

    // Evidence that the product is not the slot's product.
    const slotHosts = (productHosts[item.slot?.product] || []).map((h) => hostFamily(h));
    const url = parseUrl(record?.finalUrl);
    if (url && slotHosts.length) {
      const family = hostFamily(url.hostname);
      if (!/(^|\.)(?:microsoftonline|live)\.com$/i.test(url.hostname) && !slotHosts.some((h) => sameHostFamily(h, family))) {
        item.flags.push({ code: FLAGS.WRONG_PRODUCT, level: "probable", message: `The page address (${clean(url.hostname, 80)}) is not one of this product's pages.` });
      }
    }

    // Identity: what the evidence says could not be hidden.
    if (record && (record.redaction?.applied === false || hasReason(record, "not-redacted"))) {
      item.flags.push({ code: FLAGS.POSSIBLE_IDENTITY, level: "definite", message: "Hiding account details was requested but not applied, so a name or an email address may show." });
    } else if (record?.redaction && Number(record.redaction.lists) > Number(record.redaction.listsMasked || 0)) {
      item.flags.push({ code: FLAGS.POSSIBLE_IDENTITY, level: "definite", message: "This page lists recent items or chats, and the list was not hidden." });
    } else if (record && evidenceVersion < CURRENT_EVIDENCE_VERSION && (reach === "landing" || isHistoryPageUrl(record.finalUrl))) {
      item.flags.push({
        code: FLAGS.POSSIBLE_IDENTITY,
        level: "probable",
        message: "A start page can show a greeting with your name, your account, and recent items or chats. The companion that took this picture could not hide those, and the portal cannot read the picture to check.",
      });
    }
  }

  return items.map((item) => {
    // The most certain reason first: a definite one before a probable one, then the plainest kind.
    item.flags.sort((a, b) => (a.level === b.level ? 0 : a.level === "definite" ? -1 : 1) || FLAG_ORDER.indexOf(a.code) - FLAG_ORDER.indexOf(b.code));
    const level = item.flags.some((f) => f.level === "definite") ? "definite" : item.flags.length ? "probable" : null;
    return { id: item.id, level, flags: item.flags, reach: item.reachInfo.reach, reachWhy: item.reachInfo.why, depth: item.depth, cluster: item.cluster || null, harnessSeen: item.harnessSeen || null };
  });
}

/**
 * Whether a picture was taken in another harness than its slot needs, and which one it shows. The harness a picture shows is read in this order:
 *   1. the stamp, when it was proven by landmarks (the companion read the tabs of the page);
 *   2. the harness the shape of the address in its saved check names (an agent page at /agents/<id> is Microsoft Copilot, at /bots/<id> Standard),
 *      which can only contradict the slot, and which wins over a person's word: a person who accepted it in review did not see the address;
 *   3. a stamp that a person (or the library) put on it.
 * @returns {{found: string, source: "proof"|"address"|"person"|"library", message: string}|null}
 */
function harnessMismatch(item, needs) {
  if (!isSpecificHarness(needs)) return null;
  const stamp = normalizeHarness(item.harnessStamp);
  const stamped = isSpecificHarness(stamp) ? stamp : null;
  const proof = stamped && item.harnessProof === "landmarks" ? stamped : null;
  const review = harnessReview({ slotHarness: needs, proof, finalUrl: item.effective?.finalUrl });
  if (review.code === "wrong-harness") {
    // What the companion read from the page keeps the plain sentence it always had; an address is named for what it is.
    return { found: review.found, source: review.source, message: review.source === "proof" ? `This picture was taken in the ${harnessLabel(review.found)}, but this screenshot needs the ${harnessLabel(needs)}.` : review.message };
  }
  if (review.code === "harness-unproven" && stamped && stamped !== needs) {
    return { found: stamped, source: item.harnessProof === "library" ? "library" : "person", message: `This picture was taken in the ${harnessLabel(stamped)}, but this screenshot needs the ${harnessLabel(needs)}.` };
  }
  return null;
}

/** A few words for each kind of finding, for a one-line report. */
export const FLAG_SHORT = Object.freeze({
  [FLAGS.HARNESS_MISMATCH]: "taken in the other harness",
  [FLAGS.HARNESS_MIXED]: "the same picture is used for two harnesses",
  [FLAGS.LANDING_PAGE]: "shows a start page, not the screen it should show",
  [FLAGS.DUPLICATE_ACROSS_SLOTS]: "the same picture as other screenshots",
  [FLAGS.NEAR_DUPLICATE]: "looks the same as other screenshots",
  [FLAGS.SIGNED_OUT_OR_MARKETING]: "may not have been signed in",
  [FLAGS.WRONG_PRODUCT]: "from a page of another product",
  [FLAGS.POSSIBLE_IDENTITY]: "may show account details",
});

/** The reasons of a flagged picture in a few words: "shows a start page, not the screen it should show; the same picture as other screenshots". */
export function shortReason(flags) {
  return [...new Set((flags || []).map((f) => FLAG_SHORT[f.code]).filter(Boolean))].slice(0, 2).join("; ");
}

/** The one sentence a person reads for a flagged picture: its first (most certain) reason. */
export function plainReason(result) {
  return result?.flags?.[0]?.message || "";
}

/** The counts the notice and the report use. */
export function countFlags(results) {
  const counts = { total: 0, definite: 0, probable: 0, byFlag: {} };
  for (const result of results) {
    if (!result.level) continue;
    counts.total += 1;
    counts[result.level] += 1;
    for (const flag of result.flags) counts.byFlag[flag.code] = (counts.byFlag[flag.code] || 0) + 1;
  }
  return counts;
}

/** "3 pictures look like the wrong screen. Review them." */
export function noticeText(count) {
  if (!count) return "";
  return `${count} ${count === 1 ? "picture looks" : "pictures look"} like the wrong screen. Review ${count === 1 ? "it" : "them"}.`;
}
