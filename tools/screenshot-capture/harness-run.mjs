// Getting to a Copilot Studio harness and proving the page is in it, on this computer. harness.mjs says what a harness is (names, the
// landmarks, the path to the classic experience); this file does it: the switch to the classic experience, the way back to the default
// experience, the landmark reading that proves which harness a page is in, and the proof a picture carries to the portal.
//
// The harness is a requirement of the shot, enforced and verified here, never guessed from whatever page happened to open:
//   - Standard (Classic): switch first (click the ellipsis in the lower left corner, click Open classic experience, click Skip feedback). The click
//     OPENS A NEW BROWSER TAB on copilotstudio.preview.microsoft.com and leaves the first tab on the default address (observed on a real tenant on
//     2026-11-24), so the new tab is FOUND and FOLLOWED: the rest of the picture, and every later Standard picture, is taken in it. A same-tab switch is
//     tolerated, and when the click path produces no classic page the preview address is opened directly in a new tab (recorded as the way used).
//     The page's own landmarks (the tab strip: Overview, Knowledge, Tools, ...) prove the harness before any picture; the switch is checked again before
//     every Classic picture (and made again when the classic tab is gone).
//   - Microsoft Copilot: no switch. The default address (copilotstudio.microsoft.com) is used, an extra classic tab from an earlier picture is closed,
//     and the Build, Preview, Evaluate, and Monitor tabs prove the harness.
//   - Customer Conversation: no switch and no creation by the computer; the Deploy tab proves it.
//
// What cannot be proven: a screen outside any agent (Home, the Agents list). It looks the same in every harness, and the "More options" menu offers
// Open classic experience in EVERY experience, so the menu proves nothing. Such a screen is taken on the host that matches the lab's harness, stamped
// with that host and how the page was reached, and never counted as proven: it is saved for review (see reachedEnvironment).
//
// NOT VERIFIED ON A REAL TENANT: the accessible name of the page's tab strip when the product repeats a label (it is read by accessible name), and the
// control names read to put the Standard practice agent on the page after "Agent, Standard" (practice.mjs, scratch.mjs).

import { CLASSIC_NAV, CLASSIC_SWITCH, CLASSIC_TABS, CUSTOMER_CONVERSATION, CUSTOMER_ONLY_TABS, DEFAULT_EXPERIENCE_URL, EITHER, HARNESS_LABELS, HARNESS_PROOF_VERSION, HARNESS_SHORT, MICROSOFT_COPILOT, NEWER_TABS, STANDARD, experienceHostKind, harnessFromAgentHarness, harnessFromLandmarks, harnessFromPoweredBy, harnessGapMessage as gapSentence, normalizeHarness, wrongHarnessMessage } from "./harness.mjs";
import { allowPopups, createExecutor } from "./executor.mjs";
import { normalizeControlName } from "./guard.mjs";
import { findControls } from "./locator.mjs";
import { readinessBudgets, waitUntilReady } from "./readiness.mjs";
import { sanitizeSteps } from "./setup-steps.mjs";
import { COPILOT_STUDIO_SCREENS, addressForHarness, parseCopilotStudioAddress } from "./targets.mjs";

const sleepDefault = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── What a shot asks for ───────────────────────────────────────────────────

/**
 * The harness a shot must be taken in: a specific harness id, or null when the shot has none to enforce (a product other than Copilot Studio,
 * a screen outside the agent marked "either", or a plan from a portal that does not say). Those shots behave exactly as they always did.
 */
export function wantedHarness(shot) {
  const product = String(shot?.capture?.product || shot?.product || "copilot-studio");
  if (product !== "copilot-studio") return null;
  const id = normalizeHarness(shot?.harness ?? shot?.capture?.harness);
  return id && id !== EITHER ? id : null;
}

/** The layout a harness has: the classic side navigation for Standard, the tab strip for the Microsoft Copilot and Customer Conversation harnesses. */
export const layoutForHarness = (harness) => (harness === STANDARD ? "classic" : "newer");

/**
 * Why a shot cannot be taken in its lab's harness: its feature is not written for that harness (the portal says so in `shot.harnessGap`).
 * The companion never tries the other harness. The sentence is the one the portal shows (harnessGapMessage in harness.mjs).
 * @returns {string|null} the plain sentence, or null when there is no gap
 */
export function harnessGapMessage(shot) {
  const gap = shot?.harnessGap;
  if (!gap || typeof gap !== "object") return null;
  const lab = normalizeHarness(gap.lab);
  if (!lab || lab === EITHER) return null;
  const feature = (Array.isArray(gap.feature) ? gap.feature : [gap.feature]).map(normalizeHarness).filter((h) => h && h !== EITHER);
  return gapSentence({ lab, feature }) || null;
}

/** The fix that goes after a wrong-harness sentence when the agent is one the person chose. */
export const chooseAgentFix = (wanted) => `Choose a ${HARNESS_SHORT[wanted] || "matching"} agent, or let the computer create one.`;

/** The sentence for a page in another harness than the picture needs, as plain words ("... needs the Standard (Classic) harness."). */
export function wrongHarness(found, wanted) {
  // wrongHarnessMessage ends with "<label> harness." and every label already says harness, so the last word is dropped when it repeats.
  return wrongHarnessMessage(found, wanted).replace(/(harness(?: \(preview\))?) harness\.$/, "$1.");
}

/** Plain sentence for a page whose harness could not be read at all. */
export function unprovenMessage(wanted) {
  return `${wrongHarness(null, wanted)} It showed neither the Build, Preview, Evaluate, and Monitor tabs nor the Standard tab strip (Overview, Knowledge, Tools, and more).`;
}

/** What a status line says once the harness is proven: "Proved the Standard (Classic) harness: Overview, Knowledge, Topics". */
export const provedLine = (id, landmarks) => `Proved the ${HARNESS_LABELS[id]}: ${landmarks.join(", ")}`;

/** The host name of a page when it is one of the two Copilot Studio hosts, else "" (nothing else is ever kept). */
export function copilotHostOf(address) {
  try {
    const host = new URL(String(address || "")).hostname.toLowerCase();
    return experienceHostKind(host) ? host : "";
  } catch {
    return "";
  }
}

/**
 * The proof a picture carries (see sanitizeHarnessProof in harness.mjs). Only ever built from a harness that was PROVEN. `host` is the Copilot Studio host the
 * page was on, and `via` how that page was reached (the click path, the preview address, the default address).
 */
export function harnessEvidence({ id, landmarks, switched = false, wanted = null, host = "", via = "" }) {
  const proven = normalizeHarness(id);
  const seen = (Array.isArray(landmarks) ? landmarks : []).map((l) => String(l ?? "").trim()).filter(Boolean).slice(0, 8);
  if (!proven || proven === EITHER || !seen.length) return null;
  const want = normalizeHarness(wanted);
  return { version: HARNESS_PROOF_VERSION, id: proven, proof: "landmarks", landmarks: seen, switched: switched === true, ...(want && want !== EITHER ? { wanted: want } : {}), ...(host ? { host } : {}), ...(via ? { via } : {}) };
}

/**
 * One harness at a time, in the order each harness first appears, so the experience changes once between them: the switch to the classic experience
 * lasts for the browser session, and going back to the default one is a navigation. A shot with no harness (or "either") stays with the shot before it.
 * The order inside each group is unchanged, so a plan that is already one harness at a time keeps its order (creation step first inside each).
 */
export function orderByHarness(items, pick = (item) => item) {
  const list = Array.isArray(items) ? items : [];
  const groups = new Map();
  let last = "none";
  for (const item of list) {
    const wanted = wantedHarness(pick(item));
    if (wanted) last = wanted;
    if (!groups.has(last)) groups.set(last, []);
    groups.get(last).push(item);
  }
  return [...groups.values()].flat();
}

// ── What this browser session has done ─────────────────────────────────────

/**
 * What the companion did to the experience of one page (one browser session): whether it switched to the classic experience. A page that is
 * closed and opened again is a new session and starts with nothing, so the switch is made again. The session also remembers the CLASSIC TAB (the page
 * the click opened, where every Standard picture is taken), the page the switch started from, and how the classic page was reached.
 */
export function harnessState(session, page) {
  if (!session.harness) session.harness = { pages: new WeakMap(), loose: { classic: false, switches: 0 }, classicPage: null, classicVia: "", origin: null };
  const memo = session.harness;
  if (!page || (typeof page !== "object" && typeof page !== "function")) return memo.loose;
  if (!memo.pages.has(page)) memo.pages.set(page, { classic: false, switches: 0 });
  return memo.pages.get(page);
}

const isClosed = (page) => {
  try {
    return typeof page?.isClosed === "function" && page.isClosed();
  } catch {
    return true;
  }
};

const addressOf = (page) => {
  try {
    return typeof page?.url === "function" ? String(page.url() || "") : "";
  } catch {
    return "";
  }
};

const contextOf = (page) => {
  try {
    return typeof page?.context === "function" ? page.context() : null;
  } catch {
    return null;
  }
};

const livePages = (context) => {
  try {
    return (typeof context?.pages === "function" ? context.pages() : []).filter((p) => !isClosed(p));
  } catch {
    return [];
  }
};

/** The classic tab of this session when it is still open, else null. */
export function classicPageOf(session) {
  harnessState(session, null);
  const page = session.harness.classicPage;
  return page && !isClosed(page) ? page : null;
}

/** How the classic page of this session was reached: "click-path", "preview-address", or "" when there is none. */
export const classicViaOf = (session) => (classicPageOf(session) ? session.harness.classicVia || "" : "");

/** Forget the classic tab (it crashed, or a retry opens a new one). The tab itself is closed when it is not `keep`. */
export async function forgetClassicPage(session, { keep = null } = {}) {
  harnessState(session, null);
  const page = session.harness.classicPage;
  session.harness.classicPage = null;
  session.harness.classicVia = "";
  if (page && page !== keep && !isClosed(page)) await Promise.resolve(page.close?.()).catch(() => {});
}

/** The job is over: close the classic tab that is not the page the person works in. Best effort. */
export async function releaseHarnessPages(session, { keep = null } = {}) {
  if (!session?.harness) return;
  await forgetClassicPage(session, { keep });
}

/** The default address's home page for the environment known so far (the start of the click path), never the preview host. */
const homeUrlFor = (session) => {
  const parsed = parseCopilotStudioAddress(session?.cs?.envBase ? `${session.cs.envBase}/home` : session?.values?.copilotStudioUrl || session?.values?.copilotStudioAgentUrl || "");
  return parsed.envBase ? addressForHarness(`${parsed.envBase}/home`, MICROSOFT_COPILOT) : DEFAULT_EXPERIENCE_URL;
};

/** The preview address (the classic experience) for the environment known so far: its Agents list, or its start page when no environment is known. */
const previewUrlFor = (session) => {
  const parsed = parseCopilotStudioAddress(session?.cs?.envBase ? `${session.cs.envBase}/agents` : session?.values?.copilotStudioUrl || session?.values?.copilotStudioAgentUrl || "");
  return parsed.envBase && !String(parsed.envId || "").startsWith("~") ? addressForHarness(`${parsed.envBase}/agents`, STANDARD) : addressForHarness(DEFAULT_EXPERIENCE_URL, STANDARD);
};

// ── Reading the page ───────────────────────────────────────────────────────

const TAB_NAMES = Object.freeze([...NEWER_TABS, ...CUSTOMER_ONLY_TABS, ...CLASSIC_TABS.required, ...CLASSIC_TABS.anyOf]);
const NAV_NAMES = Object.freeze([...CLASSIC_NAV.required, ...CLASSIC_NAV.anyOf]);
const NAV_ROLES = Object.freeze(["link", "tab", "treeitem", "menuitem"]);

/**
 * Runs in the page (self-contained): the names of the tabs the page draws, by their ACCESSIBLE name (the aria-label, else the tab's text). The product can
 * repeat a tab's label in its text (OverviewOverview: a visible label and a hidden copy that keeps the tab from changing width when it is selected), so a name
 * made of the same word twice is read as that one word. `includeHidden` also reads tabs behind an open dialog (the page is still drawn). Only names are
 * returned, never other page text.
 */
export function tabNamesInPage(options) {
  const includeHidden = Boolean(options && options.includeHidden);
  const out = [];
  for (const el of document.querySelectorAll('[role="tab"]')) {
    if (el.closest("[data-capture-ui]") || el.hasAttribute("hidden")) continue;
    if (!includeHidden && el.closest('[aria-hidden="true"], [inert]')) continue;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (rect.width < 8 || rect.height < 8 || style.visibility === "hidden" || style.display === "none") continue;
    let name = String(el.getAttribute("aria-label") || el.textContent || "").replace(/\s+/g, " ").trim();
    const doubled = /^(.{2,}?)\s?\1$/.exec(name);
    if (doubled) name = doubled[1].trim();
    if (name && name.length <= 40) out.push(name);
  }
  return out;
}

async function readTabNames(page, includeHidden) {
  if (typeof page?.evaluate !== "function") return [];
  try {
    const names = await page.evaluate(tabNamesInPage, { includeHidden });
    return Array.isArray(names) ? names.map((n) => String(n).toLowerCase()) : [];
  } catch {
    return [];
  }
}

/**
 * The control names an agent page shows: the tabs of the tab strip (a Standard agent: Overview, Knowledge, Tools, ...; a Microsoft Copilot agent: Build,
 * Preview, Evaluate, Monitor) and, for an older build, the items of the side navigation. Only roles and names are read, never page text. `includeHidden`
 * also reads what a dialog hides from the accessibility tree (the page is still drawn behind it).
 * @returns {Promise<{tabs: string[], nav: string[], seen: {harness: string, landmarks: string[]}|null}>}
 */
export async function readLandmarks(page, { includeHidden = false } = {}) {
  const tabs = [];
  const drawn = await readTabNames(page, includeHidden);
  // Reading never clicks, so a control named like a write ("Deploy") is still a landmark.
  for (const name of TAB_NAMES) {
    if (drawn.includes(name.toLowerCase())) {
      tabs.push(name);
      continue;
    }
    const found = await findControls(page, name, { roles: ["tab"], includeHidden });
    if (found.length) tabs.push(name);
  }
  const nav = [];
  // The side navigation only matters when the tab strip is not there: the tabs win.
  if (!NEWER_TABS.every((name) => tabs.includes(name))) {
    for (const name of NAV_NAMES) {
      const found = await findControls(page, name, { roles: NAV_ROLES, regions: ["nav"], includeHidden });
      if (found.length) nav.push(name);
    }
  }
  return { tabs, nav, seen: harnessFromLandmarks({ tabs, nav }) };
}

/**
 * Wait for an agent page to show its landmarks and say which harness they prove. The tabs of the tab strip count at once; the classic side
 * navigation counts once it has stayed for a moment (the tab strip is drawn after it, when there is one). The waiting never touches the page.
 * @returns {Promise<{harness: string, landmarks: string[], tabs: string[], nav: string[]}|null>} null when the page shows neither
 */
export async function proveAgentPage(page, { sleep = sleepDefault, waitMs = 10_000, settleMs = 1500 } = {}) {
  const deadline = Date.now() + waitMs;
  let classicSince = 0;
  for (;;) {
    let read = await readLandmarks(page);
    // A dialog can hide the page from the accessibility tree while it is still drawn: look again at what is drawn.
    if (!read.seen) read = await readLandmarks(page, { includeHidden: true });
    if (read.seen) {
      if (read.seen.harness === STANDARD) {
        classicSince = classicSince || Date.now();
        if (Date.now() - classicSince >= settleMs || Date.now() >= deadline) return { ...read.seen, tabs: read.tabs, nav: read.nav };
      } else return { ...read.seen, tabs: read.tabs, nav: read.nav };
    } else classicSince = 0;
    if (Date.now() >= deadline) return null;
    await sleep(400);
  }
}

/**
 * Runs in the page (self-contained): is a feedback prompt showing, and which of its buttons are there? Only yes or no for each, never the words.
 */
export function feedbackPromptInPage() {
  const visible = (el) => {
    if (el.closest("[data-capture-ui]") || el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width >= 12 && rect.height >= 8 && style.visibility !== "hidden" && style.display !== "none";
  };
  const nameOf = (el) => String(el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || el.getAttribute("value") || "").replace(/\s+/g, " ").trim();
  const containers = document.querySelectorAll('dialog[open], [role=dialog], [role=alertdialog], [role=alert], [role=status], [role=region], aside, [aria-label*="feedback" i], [id*="feedback" i], [class*="feedback" i]');
  let prompt = false;
  let skip = false;
  let submit = false;
  for (const el of containers) {
    if (!visible(el)) continue;
    const label = `${el.getAttribute("aria-label") || ""} ${el.id || ""} ${typeof el.className === "string" ? el.className : ""} ${String(el.innerText || "").slice(0, 400)}`;
    if (!/feedback/i.test(label)) continue;
    const buttons = [...el.querySelectorAll("button, [role=button], input[type=submit], input[type=button]")].filter(visible).map(nameOf);
    if (!buttons.length) continue;
    prompt = true;
    if (buttons.some((n) => /^skip feedback$/i.test(n))) skip = true;
    if (buttons.some((n) => /^(?:submit|send)(?: feedback)?$/i.test(n))) submit = true;
  }
  return { prompt, skip, submit };
}

async function readFeedbackPrompt(page) {
  try {
    return (await page.evaluate(feedbackPromptInPage)) || { prompt: false, skip: false, submit: false };
  } catch {
    return { prompt: false, skip: false, submit: false };
  }
}

/**
 * Runs in the page: the harness cell of the Agents list for one agent. The list (the same on both hosts, observed 2026-11-24) is a table whose "Agent harness"
 * column holds "Microsoft Copilot" or "Standard" with a tooltip appended to the cell's text; an older build had a "Powered by" column. A row is the agent's
 * when its Open button ("Open <name>") or its first cell has exactly that name; failing that, when its text has the name (a name that is part of another
 * name is only a fallback). Returns the cell texts of the matching rows (the start of each, so the tooltip is never needed), or null.
 */
export function agentHarnessInPage(agentName) {
  const norm = (text) => String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
  const wanted = norm(agentName);
  if (!wanted) return null;
  const cells = (row) => [...row.querySelectorAll("th, td, [role=columnheader], [role=cell], [role=gridcell], [role=rowheader]")];
  const nameOfRow = (row) => {
    for (const el of row.querySelectorAll("button, [role=button], a")) {
      const open = /^open (.+)$/i.exec(String(el.getAttribute("aria-label") || "").trim());
      if (open) return norm(open[1]);
    }
    const first = cells(row)[0];
    return first ? norm(first.textContent) : "";
  };
  for (const [column, pattern] of [["agent-harness", /^agent\s+harness\s*(?:agent\s+harness)?$/], ["powered-by", /^powered\s+by\s*(?:powered\s+by)?$/]]) {
    for (const head of document.querySelectorAll("th, [role=columnheader]")) {
      if (!pattern.test(norm(head.textContent))) continue;
      const headRow = head.closest("tr, [role=row]");
      if (!headRow) continue;
      const index = cells(headRow).indexOf(head);
      const table = head.closest("table, [role=table], [role=grid], [role=treegrid]") || document;
      const rows = [...table.querySelectorAll("tr, [role=row]")].filter((row) => row !== headRow);
      const exact = rows.filter((row) => nameOfRow(row) === wanted);
      const chosen = exact.length ? exact : rows.filter((row) => norm(row.textContent).includes(wanted));
      const texts = chosen.map((row) => cells(row)[index]).filter(Boolean).map((cell) => String(cell.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80));
      if (texts.length) return { column, texts };
    }
  }
  return null;
}

/**
 * The harness the Agents list names for an agent: its "Agent harness" cell (an older build: "Powered by"), or null when the list has no such column or row,
 * or when rows with that name disagree (two agents with one name in different harnesses: the page's own landmarks decide then).
 */
export async function readAgentHarness(page, agentName) {
  try {
    const found = await page.evaluate(agentHarnessInPage, agentName);
    if (!found || !Array.isArray(found.texts)) return null;
    const read = found.column === "powered-by" ? harnessFromPoweredBy : harnessFromAgentHarness;
    const seen = [...new Set(found.texts.map((t) => read(t)).filter(Boolean))];
    return seen.length === 1 ? seen[0] : null;
  } catch {
    return null;
  }
}

// ── The switch to the classic experience (and back) ────────────────────────

/** Names the executor can use: those that have a word in them (a bare ellipsis is found by its glyph through `alt`, which keeps it). */
const names = (list) => [...new Set((Array.isArray(list) ? list : []).map((n) => String(n).trim()).filter(Boolean))];

/** Up to six names for a step (the first is the name, the rest are alternates); the glyph names stay in so an unnamed ellipsis can be found. */
function nameSet(list, max = 6) {
  const all = names(list);
  const glyphs = all.filter((n) => !normalizeControlName(n));
  const words = all.filter((n) => normalizeControlName(n));
  const [first, ...rest] = [...words.slice(0, 2), ...glyphs, ...words.slice(2)].slice(0, max);
  return { name: first, alt: rest };
}

/** Steps (see setup-steps.mjs): open the ellipsis menu in the lower left corner, choose Open classic experience, click Skip feedback. */
export const SWITCH_STEPS = Object.freeze({
  menu: () => [{ id: "switch-menu", action: "switch-experience", intent: "open", say: "Opening the menu in the lower left corner", note: "Opened the ellipsis menu in the lower left corner", target: { role: "button", ...nameSet(CLASSIC_SWITCH.menu.names), within: "any", corner: "lower-left" }, timeoutMs: 12_000, retries: 1 }],
  item: () => [{ id: "switch-item", action: "switch-experience", intent: "choose", say: "Choosing Open classic experience", note: "Chose Open classic experience", target: { ...nameSet(CLASSIC_SWITCH.item.names, 4), within: "any" }, soft: true, timeoutMs: 2500, retries: 0 }],
  skip: () => [{ id: "switch-skip", action: "switch-experience", intent: "choose", say: "Choosing Skip feedback", note: "Chose Skip feedback", target: { role: "button", ...nameSet(CLASSIC_SWITCH.skipFeedback.names), within: "any" }, soft: true, timeoutMs: 2500, retries: 0 }],
  toggle: () => [{ id: "switch-toggle", action: "switch-experience", intent: "choose", say: "Turning off the New experience switch", note: "Turned off the New experience switch", target: { ...nameSet(CLASSIC_SWITCH.toggle.names), within: "any" }, onlyIfOn: true, timeoutMs: 8000, retries: 0 }],
});

const compile = (raw) => sanitizeSteps(raw, { product: "copilot-studio", internal: true });

function makeExecutor({ page, session, trace, log, sleep, deps, shot }) {
  const make = deps?.createExecutor || createExecutor;
  return make({ page, autonomy: session.autonomy, product: "copilot-studio", practice: {}, trace, log, sleep, terms: session.terms || [], home: session.home || null, shot, companion: session.companionVersion || "", onProgress: session.onProgress, shouldStop: session.shouldStop, effectMs: session.effectMs, findMs: session.findMs });
}

/**
 * Wait for one of the controls to be on the page. A real Copilot Studio page takes 15 to 30 seconds to draw its controls (observed 2026-11-24), so the
 * switch waits for the "More options" button before it clicks anything. The waiting never touches the page.
 */
async function waitForControl(page, list, roles, { sleep, waitMs }) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    for (const name of names(list)) {
      if (!normalizeControlName(name)) continue;
      if ((await findControls(page, name, { roles })).length) return true;
    }
    if (Date.now() >= deadline) return false;
    await sleep(500);
  }
}

/** Close a tab this companion opened (or was handed) and no longer needs. Best effort: a tab that is already gone is fine. */
async function closeTab(page) {
  if (!page || isClosed(page)) return false;
  await Promise.resolve(page.close?.()).catch(() => {});
  return true;
}

/**
 * Handle the feedback prompt that follows Open classic experience. It does not always appear: when it does, "Skip feedback" is the only
 * button ever clicked. A prompt that has no Skip feedback button (only Submit) stops here: the computer never submits feedback.
 * @returns {Promise<{ok: boolean, shown: boolean, skipped: boolean, cause?: string, error?: string}>}
 */
export async function handleFeedbackPrompt({ page, executor, sleep = sleepDefault, waitMs = 2500, trace = null }) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const prompt = await readFeedbackPrompt(page);
    if (prompt.prompt) {
      if (!prompt.skip) {
        trace?.event("feedback-prompt", { shown: true, skip: false, submit: prompt.submit });
        return { ok: false, shown: true, skipped: false, cause: "harness-switch-failed", error: "A feedback prompt appeared after Open classic experience, but it has no Skip feedback button. The computer never submits feedback, so it stopped. Click Skip feedback yourself, then use “Retake guided”." };
      }
      const done = await executor.run(compile(SWITCH_STEPS.skip()));
      trace?.event("feedback-prompt", { shown: true, skip: true, skipped: done.ok });
      // The click is the step; that the prompt is gone is looked at here (the page may also reload, which the executor cannot tell from nothing happening).
      let gone = false;
      if (done.ok) {
        const until = Date.now() + 3000;
        for (;;) {
          if (!(await readFeedbackPrompt(page)).prompt) {
            gone = true;
            break;
          }
          if (Date.now() >= until) break;
          await sleep(200);
        }
      }
      if (!done.ok || !gone) return { ok: false, shown: true, skipped: false, cause: "harness-switch-failed", error: "A feedback prompt appeared after Open classic experience, and the computer could not skip it with Skip feedback. It never submits feedback, so it stopped. Click Skip feedback yourself, then use “Retake guided”." };
      return { ok: true, shown: true, skipped: true };
    }
    if (Date.now() >= deadline) return { ok: true, shown: false, skipped: false };
    await sleep(250);
  }
}

/**
 * Find the page the "Open classic experience" click opened. The product opens the classic experience in a NEW browser tab on the preview host and leaves the
 * first tab where it was (observed on a real tenant on 2026-11-24); a same-tab switch is tolerated. A feedback prompt can show first, on the first tab
 * (Skip feedback is the only button ever clicked; the first tab is handled by the caller); one that shows in the new tab is skipped there.
 * @returns {Promise<{ok: true, page: object, how: "new-tab"|"same-tab"}|{ok: false, cause?: string, error?: string, seen?: boolean}>}
 */
async function awaitClassicPage({ from, context, before, opened, session, deps, sleep, trace, log, waitMs }) {
  const deadline = Date.now() + waitMs;
  const handled = new WeakSet();
  let seen = false;
  for (;;) {
    const fresh = [...new Set([...opened, ...livePages(context)])].filter((p) => !before.has(p) && p !== from && !isClosed(p));
    if (fresh.length) seen = true;
    for (const tab of fresh) {
      if (experienceHostKind(addressOf(tab)) === "classic") {
        // Any other tab the click opened is not needed: the classic tab is the one that is followed.
        for (const other of fresh) if (other !== tab) await closeTab(other);
        return { ok: true, page: tab, how: "new-tab" };
      }
    }
    if (experienceHostKind(addressOf(from)) === "classic") return { ok: true, page: from, how: "same-tab" };
    for (const tab of fresh) {
      if (handled.has(tab)) continue;
      if (!(await readFeedbackPrompt(tab)).prompt) continue;
      handled.add(tab);
      const prompt = await handleFeedbackPrompt({ page: tab, executor: makeExecutor({ page: tab, session, trace, log, sleep, deps, shot: "switch-classic" }), sleep, waitMs: 0, trace });
      if (!prompt.ok) return { ok: false, cause: prompt.cause, error: prompt.error, seen };
    }
    if (Date.now() >= deadline) return { ok: false, seen };
    await sleep(300);
  }
}

/** The Copilot Studio host a page is on and how the page was reached, for the proof a picture carries. */
export function hostAndVia(page, session, harness) {
  const host = copilotHostOf(addressOf(page));
  const kind = experienceHostKind(host);
  if (harness === STANDARD) return { host, kind, via: classicPageOf(session) === page ? session.harness.classicVia || "" : kind === "classic" ? "preview-address" : "" };
  return { host, kind, via: kind === "default" ? "default-address" : "" };
}

/**
 * Switch this browser session to the classic experience, the way the owner does by hand: Home on the default address, the ellipsis ("More options") in the
 * lower left corner, Open classic experience, Skip feedback. The click opens the classic experience IN A NEW TAB on the preview host (observed on a real
 * tenant on 2026-11-24): this function finds that tab (a page that appeared after the click, or the same tab when the product navigates in place), waits
 * until it is on the preview host and drawn, brings it to the front, and returns it as `page`: every Standard picture is taken in it. `setPage` is told
 * when the page in use changes. When the click path produces no classic page the preview address is opened directly in a new tab (`via: "preview-address"`).
 * Made once; `force` makes it again (the classic tab is gone or fell back). The result is NOT yet a proof: the harness is proven by the landmarks.
 * @returns {Promise<{ok: boolean, switched: boolean, reused?: boolean, page?: object, via?: string, how?: string, signIn?: object, cause?: string, error?: string}>}
 */
export async function ensureClassicExperience({ page, session, go, trace = null, log = null, sleep = sleepDefault, readiness = {}, force = false, deps = null, setPage = null }) {
  harnessState(session, null);
  const memo = session.harness;
  const known = classicPageOf(session);
  if (known && !force) {
    if (known !== page) setPage?.(known);
    return { ok: true, switched: false, reused: true, page: known, via: memo.classicVia };
  }
  if (!force && harnessState(session, page).classic) return { ok: true, switched: false, reused: true, page, via: memo.classicVia };
  // A forced switch starts again from the page the first switch started from (the default experience), and the old classic tab is closed.
  const from = force && memo.origin && !isClosed(memo.origin) ? memo.origin : page;
  memo.origin = from;
  if (force) await forgetClassicPage(session, { keep: from });
  harnessState(session, from).classic = false;
  log?.(`  Switching to the classic experience: ${CLASSIC_SWITCH.path}`);
  const failed = (error, cause = "harness-switch-failed") => ({ ok: false, switched: false, cause, error });
  const nav = await go(homeUrlFor(session), "the Copilot Studio home page", { on: from, exact: true });
  if (nav.signIn) return { ok: false, switched: false, signIn: nav.signIn };
  // The start address sends the browser to the environment's home page: the environment is learned here, so no later step opens the start address
  // again (that address is the way back to the default experience).
  const landed = parseCopilotStudioAddress(addressOf(from));
  if (landed.envBase && !String(landed.envId || "").startsWith("~") && session.cs && !session.cs.envBase) session.cs.envBase = landed.envBase;
  await waitUntilReady(from, { budgets: readinessBudgets(readiness), sleep, trace, shot: "switch-classic" });
  // The page takes 15 to 30 seconds to draw its controls: wait for the "More options" button before anything is clicked.
  const drawn = await waitForControl(from, CLASSIC_SWITCH.menu.names, ["button"], { sleep, waitMs: session.switchWaitMs ?? 45_000 });
  trace?.event("classic-switch-controls", { drawn });
  const executor = makeExecutor({ page: from, session, trace, log, sleep, deps, shot: "switch-classic" });
  const promptMs = session.promptMs ?? 2500;
  const context = contextOf(from);
  const before = new Set(livePages(context));
  const opened = [];
  const watch = (tab) => opened.push(tab);
  context?.on?.("page", watch);
  // The click that opens the classic experience opens a new tab: the page guards, which close every other new tab, let this one stay.
  const releasePopups = allowPopups(from);
  let found = null;
  let via = "click-path";
  try {
    const menu = await executor.run(compile(SWITCH_STEPS.menu()));
    if (menu.halted) return failed(menu.halted, "run-stopped");
    if (menu.ok) {
      const chosen = await executor.run(compile(SWITCH_STEPS.item()));
      if (chosen.halted) return failed(chosen.halted, "run-stopped");
      if (!chosen.ok) {
        // The menu opened but the item was not found or not clicked: the address is the way in that does not depend on that one control.
        await executor.cleanup().catch(() => {});
        log?.("  The computer opened the menu in the lower left corner but could not click Open classic experience.");
        trace?.event("classic-switch", { result: "item-not-clicked" });
      } else {
        // The feedback prompt shows on the first tab, and the classic experience opens after it is skipped.
        const prompt = await handleFeedbackPrompt({ page: from, executor, sleep, waitMs: promptMs, trace });
        if (!prompt.ok) return failed(prompt.error, prompt.cause);
        found = await awaitClassicPage({ from, context, before, opened, session, deps, sleep, trace, log, waitMs: session.switchTabMs ?? 30_000 });
        if (found.cause) return failed(found.error, found.cause);
      }
    } else {
      // An older build had a New experience switch on the Home page instead of the menu: it turns the experience in this tab.
      const toggled = await executor.run(compile(SWITCH_STEPS.toggle()));
      if (toggled.ok) found = { ok: true, page: from, how: "same-tab" };
      else {
        await executor.cleanup().catch(() => {});
        log?.("  The computer could not find the ellipsis in the lower left corner (or the New experience switch).");
        trace?.event("classic-switch", { result: "no-control" });
      }
    }
  } finally {
    releasePopups();
    if (typeof context?.off === "function") context.off("page", watch);
    else context?.removeListener?.("page", watch);
  }
  if (!found?.ok) {
    // The click path produced no classic page: the preview address loads directly with the same sign-in, so it is opened in a new tab and the way used is recorded.
    log?.(`  The click did not open the classic experience, so the computer opens its address directly (${CLASSIC_SWITCH.host}).`);
    trace?.event("classic-switch", { result: "click-path-failed", tabSeen: found?.seen === true });
    const tab = typeof context?.newPage === "function" ? await context.newPage() : null;
    const target = tab || from;
    const direct = await go(previewUrlFor(session), "the Copilot Studio classic experience", { on: target, exact: true });
    if (direct.signIn) return { ok: false, switched: false, signIn: direct.signIn };
    if (experienceHostKind(addressOf(target)) !== "classic") {
      if (tab) await closeTab(tab);
      return failed(`The classic experience did not open: neither the click path nor the address ${CLASSIC_SWITCH.host} led to a classic page. Switch to the classic experience yourself, then use “Retake guided”.`);
    }
    found = { ok: true, page: target, how: tab ? "new-tab" : "same-tab" };
    via = "preview-address";
  }
  const classic = found.page;
  await Promise.resolve(classic.bringToFront?.()).catch(() => {});
  await waitUntilReady(classic, { budgets: readinessBudgets(readiness), sleep, trace, shot: "switch-classic" });
  memo.classicPage = classic;
  memo.classicVia = via;
  const state = harnessState(session, classic);
  state.classic = true;
  state.switches += 1;
  trace?.event("classic-switch", { result: "switched", how: found.how, via, host: copilotHostOf(addressOf(classic)), times: state.switches });
  log?.(`  The classic experience is open ${found.how === "new-tab" ? "in a new tab" : "in the same tab"} (${copilotHostOf(addressOf(classic)) || CLASSIC_SWITCH.host}), reached by ${via === "click-path" ? "the click path" : "the preview address"}.`);
  if (classic !== page) setPage?.(classic);
  return { ok: true, switched: true, page: classic, via, how: found.how };
}

/**
 * Use the default experience (the Microsoft Copilot harness). A classic TAB from an earlier picture is a different tab from this page and is no longer
 * needed: it is closed, and this page (on the default address) is used. A page that is itself in the classic experience (a same-tab switch, or a page found
 * on the preview host) goes back to DEFAULT_EXPERIENCE_URL in place. `force` navigates even when nothing says the page is in the classic experience.
 * @returns {Promise<{ok: boolean, returned: boolean, closedTab?: boolean, page?: object, signIn?: object}>}
 */
export async function ensureDefaultExperience({ page, session, go, trace = null, log = null, sleep = sleepDefault, readiness = {}, force = false, setPage = null }) {
  harnessState(session, null);
  const memo = session.harness;
  const classic = classicPageOf(session);
  let closedTab = false;
  let use = page;
  if (classic && classic !== page) {
    // The page in hand is the other tab: when it is the classic tab's opener it is on the default address already; the classic tab is closed.
    closedTab = await closeTab(classic);
    memo.classicPage = null;
    memo.classicVia = "";
    log?.("  Closed the classic tab: this picture is taken in the default experience.");
    trace?.event("classic-tab-closed", { reason: "microsoft-copilot-picture" });
  }
  if (isClosed(use)) {
    // The page in hand was the classic tab (closed with it): the page the switch started from is the default-experience page.
    const origin = memo.origin && !isClosed(memo.origin) ? memo.origin : null;
    if (origin) {
      use = origin;
      setPage?.(use);
    }
  }
  const state = harnessState(session, use);
  const onClassicHost = experienceHostKind(addressOf(use)) === "classic";
  if (!state.classic && !force && !onClassicHost) return { ok: true, returned: false, closedTab, page: use };
  log?.(`  Changing experience: going back to the default experience for the Microsoft Copilot harness (${DEFAULT_EXPERIENCE_URL}).`);
  const opened = await go(DEFAULT_EXPERIENCE_URL, "Copilot Studio", { on: use, exact: true });
  if (opened.signIn) return { ok: false, returned: false, signIn: opened.signIn };
  state.classic = false;
  if (memo.classicPage === use) {
    memo.classicPage = null;
    memo.classicVia = "";
  }
  await waitUntilReady(use, { budgets: readinessBudgets(readiness), sleep, trace, shot: "default-experience" });
  trace?.event("default-experience", { forced: force });
  return { ok: true, returned: true, closedTab, page: use };
}

// ── Proof: a screen outside any agent ──────────────────────────────────────

/**
 * What can be said about a screen outside any agent (Home, the Agents list): NOTHING that proves the harness. Such a screen looks the same in every harness,
 * and the "More options" menu offers Open classic experience in EVERY experience (observed 2026-11-24), so the menu proves nothing either. The one thing that
 * can be checked is the corroboration: the page is on the host that matches the harness the picture needs (Standard: the preview host, after the switch;
 * Microsoft Copilot and Customer Conversation: the default host). The host and how the page was reached are stamped on the picture, and the picture is never
 * counted as proven: it is saved for review, so a person accepts it.
 * @returns {{host: string, kind: string|null, via: string, hostMatches: boolean}}
 */
export function reachedEnvironment({ page, session, wanted }) {
  const { host, kind, via } = hostAndVia(page, session, wanted);
  return { host, kind, via, hostMatches: Boolean(kind) && kind === (wanted === STANDARD ? "classic" : "default") };
}

// ── Proof: the gate before a picture ───────────────────────────────────────

/** Whether a shot's screen is an agent page (it has a tab strip or side navigation) or a page outside any agent (Home, the Agents list). */
export function harnessScopeOf(shot) {
  const route = shot?.capture?.route;
  const screen = route?.kind === "copilot-studio" ? COPILOT_STUDIO_SCREENS[route.screen] : null;
  return screen?.scope === "environment" ? "environment" : "agent";
}

/**
 * Prove that the page is in the harness the shot needs. Reads landmarks only; clicks nothing unless `allowClicks` (and then only Skip feedback on a feedback
 * prompt left on screen). A screen outside any agent (`scope: "environment"`) is NOT proven: it is checked against the host that matches the harness, and the
 * result carries `reached` (the harness, host, and how the page was reached) and no proof, so the picture goes to review (see reachedEnvironment).
 * @returns {Promise<{ok: true, proof: object|null, found: string, landmarks: string[], reached?: object, proven?: false}|{ok: false, code: "wrong-harness"|"harness-unproven", found: string|null, message: string}>}
 */
export async function proveHarness({ page, session, wanted, scope = "agent", allowClicks = true, switched = false, sleep = sleepDefault, trace = null, log = null, waitMs = undefined, deps = null }) {
  // A feedback prompt left on the page hides it: it is skipped (and only skipped) before anything is read.
  if (wanted === STANDARD && allowClicks && (await readFeedbackPrompt(page)).skip) {
    const executor = makeExecutor({ page, session, trace, log, sleep, deps, shot: "switch-classic" });
    await handleFeedbackPrompt({ page, executor, sleep, waitMs: 0, trace });
  }
  if (scope === "environment") {
    const reached = reachedEnvironment({ page, session, wanted });
    trace?.event("harness-reached", { wanted, host: reached.host || null, via: reached.via || null, hostMatches: reached.hostMatches });
    if (!reached.kind) return { ok: false, code: "harness-unproven", found: null, message: `${wrongHarness(null, wanted)} The page is not on a Copilot Studio address, and a screen outside the agent shows no landmarks.` };
    if (!reached.hostMatches) {
      const found = reached.kind === "classic" ? STANDARD : MICROSOFT_COPILOT;
      return { ok: false, code: "wrong-harness", found, message: `This page is on ${reached.host}, which is the ${HARNESS_LABELS[found]} experience; this picture needs the ${HARNESS_LABELS[wanted]}.` };
    }
    return { ok: true, found: wanted, landmarks: [], proof: null, proven: false, reached: { id: wanted, host: reached.host, via: reached.via } };
  }
  const seen = await proveAgentPage(page, { sleep, waitMs: waitMs ?? session?.landmarkMs ?? 10_000, settleMs: session?.landmarkSettleMs ?? 1500 });
  const found = seen ? { harness: seen.harness, landmarks: seen.landmarks } : null;
  trace?.event("harness-proof", { wanted, found: found?.harness || null, scope, landmarks: found?.landmarks?.length || 0 });
  if (!found) return { ok: false, code: "harness-unproven", found: null, message: unprovenMessage(wanted) };
  if (found.harness !== wanted) return { ok: false, code: "wrong-harness", found: found.harness, message: wrongHarness(found.harness, wanted) };
  const where = hostAndVia(page, session, wanted);
  return { ok: true, found: found.harness, landmarks: found.landmarks, proof: harnessEvidence({ id: found.harness, landmarks: found.landmarks, switched, wanted, host: where.host, via: where.via }) };
}

/**
 * Get a shot's page into its harness and prove it, once more after a recovery when the page was found in the wrong one:
 *   - Standard: the switch is made again (the classic tab fell back) and the screen is opened again, only when this shot reused an earlier switch;
 *   - Microsoft Copilot: back to the default experience (a classic tab is closed), then the screen is opened again.
 * `reopen` opens the screen again and returns `{ok: true}` (or `{signIn}`). `setPage` is told when the page in use changes (a new classic tab). Customer
 * Conversation has no recovery.
 * @returns {Promise<object>} the result of `proveHarness`, plus `signIn` when a page needed a sign-in on the way, and `recovered`
 */
export async function proveWithRecovery({ page, session, wanted, scope, allowClicks, go, reopen, reusedSwitch = false, trace, log, sleep, readiness, deps, setPage = null }) {
  let current = page;
  const follow = (next) => {
    current = next;
    setPage?.(next);
  };
  const proofArgs = () => ({ page: current, session, wanted, scope, allowClicks, switched: wanted === STANDARD && harnessState(session, current).switches > 0, sleep, trace, log, deps });
  const first = await proveHarness(proofArgs());
  if (first.ok || !allowClicks || first.code === "harness-unproven" && wanted !== STANDARD) return first;
  const canRecover = wanted === MICROSOFT_COPILOT || (wanted === STANDARD && reusedSwitch);
  if (!canRecover) return first;
  if (wanted === STANDARD) {
    const again = await ensureClassicExperience({ page: current, session, go, trace, log, sleep, readiness, force: true, deps, setPage: follow });
    if (again.signIn) return { ok: false, signIn: again.signIn, code: "sign-in", found: null, message: "" };
    if (!again.ok) return { ok: false, code: again.cause || "harness-switch-failed", found: first.found, message: again.error };
  } else {
    const back = await ensureDefaultExperience({ page: current, session, go, trace, log, sleep, readiness, force: true, setPage: follow });
    if (back.signIn) return { ok: false, signIn: back.signIn, code: "sign-in", found: null, message: "" };
    if (back.page && back.page !== current) follow(back.page);
  }
  const reopened = typeof reopen === "function" ? await reopen() : { ok: true };
  if (reopened?.signIn) return { ok: false, signIn: reopened.signIn, code: "sign-in", found: null, message: "" };
  const second = await proveHarness(proofArgs());
  return { ...second, recovered: true };
}
