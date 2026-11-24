// Getting to a Copilot Studio harness and proving the page is in it, on this computer. harness.mjs says what a harness is (names, the
// landmarks, the path to the classic experience); this file does it: the switch to the classic experience, the way back to the default
// experience, the landmark reading that proves which harness a page is in, and the proof a picture carries to the portal.
//
// The harness is a requirement of the shot, enforced and verified here, never guessed from whatever page happened to open:
//   - Standard (Classic): switch first (click the ellipsis in the lower left corner, click Open classic experience, click Skip feedback),
//     then prove the classic landmark (side navigation with Overview and more) before any picture. The switch lasts for the browser session
//     only, so it is made once per page and the landmark is checked again before every Classic picture (and the switch is redone when the page fell back).
//   - Microsoft Copilot: no switch. A page that is still in the classic experience goes back to the default experience (DEFAULT_EXPERIENCE_URL)
//     and is proven again (the Build, Preview, Evaluate, and Monitor tabs); when it cannot get back the shot stops.
//   - Customer Conversation: no switch and no creation by the computer; the Deploy tab proves it.
//
// NOT VERIFIED ON A REAL TENANT: the accessible names of the ellipsis, the menu item, the feedback prompt, and the control names read to prove
// a screen outside any agent (Home, the Agents list). Every one has several candidate names, the click is allowed only on those names
// (guard.mjs, action "switch-experience"), and a page that cannot be proven stops the shot instead of being photographed.

import { CLASSIC_NAV, CLASSIC_SWITCH, CUSTOMER_CONVERSATION, CUSTOMER_ONLY_TABS, DEFAULT_EXPERIENCE_URL, EITHER, HARNESS_LABELS, HARNESS_PROOF_VERSION, HARNESS_SHORT, MICROSOFT_COPILOT, NEWER_TABS, STANDARD, harnessFromLandmarks, harnessFromPoweredBy, harnessGapMessage as gapSentence, normalizeHarness, wrongHarnessMessage } from "./harness.mjs";
import { createExecutor, readState } from "./executor.mjs";
import { normalizeControlName } from "./guard.mjs";
import { findControls } from "./locator.mjs";
import { readinessBudgets, waitUntilReady } from "./readiness.mjs";
import { sanitizeSteps } from "./setup-steps.mjs";
import { COPILOT_STUDIO_SCREENS, parseCopilotStudioAddress } from "./targets.mjs";

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
  return `${wrongHarness(null, wanted)} It showed neither the Build, Preview, Evaluate, and Monitor tabs nor the classic side navigation.`;
}

/** What a status line says once the harness is proven: "Proved the Standard (Classic) harness: Overview, Knowledge, Topics". */
export const provedLine = (id, landmarks) => `Proved the ${HARNESS_LABELS[id]}: ${landmarks.join(", ")}`;

/** The proof a picture carries (see sanitizeHarnessProof in harness.mjs). Only ever built from a harness that was PROVEN. */
export function harnessEvidence({ id, landmarks, switched = false, wanted = null }) {
  const proven = normalizeHarness(id);
  const seen = (Array.isArray(landmarks) ? landmarks : []).map((l) => String(l ?? "").trim()).filter(Boolean).slice(0, 8);
  if (!proven || proven === EITHER || !seen.length) return null;
  const want = normalizeHarness(wanted);
  return { version: HARNESS_PROOF_VERSION, id: proven, proof: "landmarks", landmarks: seen, switched: switched === true, ...(want && want !== EITHER ? { wanted: want } : {}) };
}

/**
 * Microsoft Copilot (and Customer Conversation) shots first, Standard (Classic) shots last. The switch to the classic experience lasts for
 * the browser session and there is no safe way back inside it, so every shot that needs the default experience is taken before it.
 * The order inside each group is unchanged.
 */
export function orderByHarness(items, pick = (item) => item) {
  const list = Array.isArray(items) ? items : [];
  const classic = (item) => wantedHarness(pick(item)) === STANDARD;
  return [...list.filter((item) => !classic(item)), ...list.filter(classic)];
}

// ── What this browser session has done ─────────────────────────────────────

/**
 * What the companion did to the experience of one page (one browser session): whether it switched to the classic experience. A page that is
 * closed and opened again is a new session and starts with nothing, so the switch is made again.
 */
export function harnessState(session, page) {
  if (!session.harness) session.harness = { pages: new WeakMap(), loose: { classic: false, switches: 0 } };
  const memo = session.harness;
  if (!page || (typeof page !== "object" && typeof page !== "function")) return memo.loose;
  if (!memo.pages.has(page)) memo.pages.set(page, { classic: false, switches: 0 });
  return memo.pages.get(page);
}

const homeUrlFor = (session) => {
  const parsed = parseCopilotStudioAddress(session?.cs?.envBase ? `${session.cs.envBase}/home` : session?.values?.copilotStudioUrl || session?.values?.copilotStudioAgentUrl || "");
  return parsed.envBase ? `${parsed.envBase}/home` : DEFAULT_EXPERIENCE_URL;
};

// ── Reading the page ───────────────────────────────────────────────────────

const TAB_NAMES = Object.freeze([...NEWER_TABS, ...CUSTOMER_ONLY_TABS]);
const NAV_NAMES = Object.freeze([...CLASSIC_NAV.required, ...CLASSIC_NAV.anyOf]);
const NAV_ROLES = Object.freeze(["link", "tab", "treeitem", "menuitem"]);

/**
 * The control names an agent page shows: the tabs of the tab strip and the items of the side navigation. Only roles and names are read,
 * never page text. `includeHidden` also reads what a dialog hides from the accessibility tree (the page is still drawn behind it).
 * @returns {Promise<{tabs: string[], nav: string[], seen: {harness: string, landmarks: string[]}|null}>}
 */
export async function readLandmarks(page, { includeHidden = false } = {}) {
  const tabs = [];
  // Reading never clicks, so a control named like a write ("Deploy") is still a landmark.
  for (const name of TAB_NAMES) {
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
 * Runs in the page: the "Powered by" cell of the Agents list row for one agent (the text of that cell only), or null.
 */
export function poweredByInPage(agentName) {
  const wanted = String(agentName || "").toLowerCase().trim();
  if (!wanted) return null;
  const cells = (row) => [...row.querySelectorAll("th, td, [role=columnheader], [role=cell], [role=gridcell]")];
  for (const head of document.querySelectorAll("th, [role=columnheader]")) {
    if (!/^\s*powered by\s*$/i.test(String(head.textContent || ""))) continue;
    const headRow = head.closest("tr, [role=row]");
    if (!headRow) continue;
    const index = cells(headRow).indexOf(head);
    const table = head.closest("table, [role=table], [role=grid], [role=treegrid]") || document;
    for (const row of table.querySelectorAll("tr, [role=row]")) {
      if (row === headRow || !String(row.textContent || "").toLowerCase().includes(wanted)) continue;
      const cell = cells(row)[index];
      if (cell) return String(cell.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60);
    }
  }
  return null;
}

/** The harness the Agents list names for an agent (its "Powered by" column), or null when the list has no such column or row. */
export async function readPoweredBy(page, agentName) {
  try {
    const text = await page.evaluate(poweredByInPage, agentName);
    return harnessFromPoweredBy(text);
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
  menu: () => [{ id: "switch-menu", action: "switch-experience", intent: "open", say: "Opening the menu in the lower left corner", note: "Opened the ellipsis menu in the lower left corner", target: { role: "button", ...nameSet(CLASSIC_SWITCH.menu.names), within: "nav", corner: "lower-left" }, timeoutMs: 12_000, retries: 1 }],
  item: () => [{ id: "switch-item", action: "switch-experience", intent: "choose", say: "Choosing Open classic experience", note: "Chose Open classic experience", target: { ...nameSet(CLASSIC_SWITCH.item.names, 4), within: "any" }, soft: true, timeoutMs: 2500, retries: 0 }],
  skip: () => [{ id: "switch-skip", action: "switch-experience", intent: "choose", say: "Choosing Skip feedback", note: "Chose Skip feedback", target: { role: "button", ...nameSet(CLASSIC_SWITCH.skipFeedback.names), within: "any" }, soft: true, timeoutMs: 2500, retries: 0 }],
  toggle: () => [{ id: "switch-toggle", action: "switch-experience", intent: "choose", say: "Turning off the New experience switch", note: "Turned off the New experience switch", target: { ...nameSet(CLASSIC_SWITCH.toggle.names), within: "any" }, onlyIfOn: true, timeoutMs: 8000, retries: 0 }],
});

const compile = (raw) => sanitizeSteps(raw, { product: "copilot-studio", internal: true });

function makeExecutor({ page, session, trace, log, sleep, deps, shot }) {
  const make = deps?.createExecutor || createExecutor;
  return make({ page, autonomy: session.autonomy, product: "copilot-studio", practice: {}, trace, log, sleep, terms: session.terms || [], home: session.home || null, shot, companion: session.companionVersion || "", onProgress: session.onProgress, shouldStop: session.shouldStop, effectMs: session.effectMs, findMs: session.findMs });
}

async function anyVisible(page, list, roles) {
  for (const name of names(list)) {
    if (!normalizeControlName(name)) continue;
    const found = await findControls(page, name, { roles });
    if (found.length) return true;
  }
  return false;
}

/** Wait (a few seconds) for the command to be listed in the menu that was just opened. */
async function commandOffered(page, { sleep, waitMs }) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (await anyVisible(page, CLASSIC_SWITCH.item.names, CLASSIC_SWITCH.item.roles)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(250);
  }
}

async function closeMenu(page, executor, { sleep }) {
  await Promise.resolve(page.keyboard?.press?.("Escape")).catch(() => {});
  await sleep(150);
  const open = (await readState(page).catch(() => ({ dialogs: [] }))).dialogs.some((d) => d.kind === "menu");
  if (open) await executor.cleanup().catch(() => {});
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
 * Switch this browser session to the classic experience, the way the owner does by hand: Home, the ellipsis in the lower left corner,
 * Open classic experience, Skip feedback. Made once per page; `force` makes it again (the page fell back). The result is NOT yet a proof:
 * the harness is proven by the landmarks before any picture.
 * @returns {Promise<{ok: boolean, switched: boolean, reused?: boolean, already?: boolean, signIn?: object, cause?: string, error?: string}>}
 */
export async function ensureClassicExperience({ page, session, go, trace = null, log = null, sleep = sleepDefault, readiness = {}, force = false, deps = null }) {
  const state = harnessState(session, page);
  if (state.classic && !force) return { ok: true, switched: false, reused: true };
  state.classic = false;
  log?.(`  Switching to the classic experience: ${CLASSIC_SWITCH.path}`);
  const opened = await go(homeUrlFor(session), "the Copilot Studio home page");
  if (opened.signIn) return { ok: false, switched: false, signIn: opened.signIn };
  // The start address sends the browser to the environment's home page: the environment is learned here, so no later step opens the start address
  // again (that address is the way back to the default experience).
  const landed = parseCopilotStudioAddress(page.url?.() || "");
  if (landed.envBase && !String(landed.envId || "").startsWith("~") && session.cs && !session.cs.envBase) session.cs.envBase = landed.envBase;
  await waitUntilReady(page, { budgets: readinessBudgets(readiness), sleep, trace, shot: "switch-classic" });
  const executor = makeExecutor({ page, session, trace, log, sleep, deps, shot: "switch-classic" });
  const promptMs = session.promptMs ?? 2500;
  const failed = (error, cause = "harness-switch-failed") => ({ ok: false, switched: false, cause, error });
  const menu = await executor.run(compile(SWITCH_STEPS.menu()));
  if (menu.halted) return failed(menu.halted, "run-stopped");
  if (menu.ok) {
    if (!(await commandOffered(page, { sleep, waitMs: Math.min(session.findMs ?? 3000, 3000) }))) {
      // The menu is open and does not list the command: the session is already in the classic experience.
      await closeMenu(page, executor, { sleep });
      state.classic = true;
      trace?.event("classic-switch", { result: "already-classic" });
      log?.("  The command Open classic experience is not offered, so this session is already in the classic experience.");
      return { ok: true, switched: false, already: true };
    }
    const chosen = await executor.run(compile(SWITCH_STEPS.item()));
    if (chosen.halted) return failed(chosen.halted, "run-stopped");
    if (!chosen.ok) {
      await executor.cleanup().catch(() => {});
      return failed("The computer opened the menu in the lower left corner but could not click Open classic experience. Switch to the classic experience yourself, then use “Retake guided”.");
    }
    const prompt = await handleFeedbackPrompt({ page, executor, sleep, waitMs: promptMs, trace });
    if (!prompt.ok) return failed(prompt.error, prompt.cause);
  } else {
    // An older build had a New experience switch on the Home page instead of the menu.
    const toggled = await executor.run(compile(SWITCH_STEPS.toggle()));
    if (!toggled.ok) {
      await executor.cleanup().catch(() => {});
      return failed("The computer could not find the ellipsis in the lower left corner (or the New experience switch), so it did not switch to the classic experience. Switch yourself, then use “Retake guided”.");
    }
  }
  await waitUntilReady(page, { budgets: readinessBudgets(readiness), sleep, trace, shot: "switch-classic" });
  state.classic = true;
  state.switches += 1;
  trace?.event("classic-switch", { result: "switched", times: state.switches });
  return { ok: true, switched: true };
}

/**
 * Go back to the default experience (the Microsoft Copilot harness) when this session was switched to the classic one: open
 * DEFAULT_EXPERIENCE_URL. `force` does it even when this companion did not switch (the page was found in the classic experience).
 * @returns {Promise<{ok: boolean, returned: boolean, signIn?: object}>}
 */
export async function ensureDefaultExperience({ page, session, go, trace = null, log = null, sleep = sleepDefault, readiness = {}, force = false }) {
  const state = harnessState(session, page);
  if (!state.classic && !force) return { ok: true, returned: false };
  log?.(`  Going back to the default experience: ${DEFAULT_EXPERIENCE_URL}`);
  const opened = await go(DEFAULT_EXPERIENCE_URL, "Copilot Studio");
  if (opened.signIn) return { ok: false, returned: false, signIn: opened.signIn };
  state.classic = false;
  await waitUntilReady(page, { budgets: readinessBudgets(readiness), sleep, trace, shot: "default-experience" });
  trace?.event("default-experience", { forced: force });
  return { ok: true, returned: true };
}

// ── Proof: a screen outside any agent ──────────────────────────────────────

/**
 * Which experience a page outside any agent (Home, the Agents list) is in. There is no tab strip there, so the proof is one of:
 *   - the Home "New experience" switch (an older build): off is the classic experience, on is the default one; read without touching it;
 *   - the side bar menu (the ellipsis in the lower left corner), opened and closed again: when it does not offer Open classic experience the
 *     session is in the classic experience, when it does the session is in the default one.
 * Nothing is clicked when `allowClicks` is false (a person set the screen up): then only the switch can be read.
 * NOT VERIFIED on a real tenant (see the top of this file). A menu that cannot be opened and read proves nothing.
 * @returns {Promise<{harness: string, landmarks: string[]}|null>}
 */
export async function proveEnvironmentPage(page, { session, allowClicks = true, sleep = sleepDefault, trace = null, log = null, deps = null } = {}) {
  for (const name of names(CLASSIC_SWITCH.toggle.names)) {
    const found = await findControls(page, name, { roles: CLASSIC_SWITCH.toggle.roles });
    if (!found.length) continue;
    const locator = found[0].locator;
    const on = typeof locator.isChecked === "function" ? await locator.isChecked().catch(() => null) : null;
    if (on === null) continue;
    return { harness: on ? MICROSOFT_COPILOT : STANDARD, landmarks: [`${name}: ${on ? "on" : "off"}`] };
  }
  if (!allowClicks) return null;
  const executor = makeExecutor({ page, session, trace, log, sleep, deps, shot: "prove-experience" });
  const menu = await executor.run(compile(SWITCH_STEPS.menu()));
  if (!menu.ok) {
    await executor.cleanup().catch(() => {});
    return null;
  }
  const opened = (await readState(page).catch(() => ({ dialogs: [] }))).dialogs.some((d) => d.kind === "menu");
  if (!opened) {
    await executor.cleanup().catch(() => {});
    return null;
  }
  const offered = await commandOffered(page, { sleep, waitMs: 800 });
  await closeMenu(page, executor, { sleep });
  return { harness: offered ? MICROSOFT_COPILOT : STANDARD, landmarks: ["Menu in the lower left corner", offered ? "Open classic experience offered" : "No Open classic experience command"] };
}

// ── Proof: the gate before a picture ───────────────────────────────────────

/** Whether a shot's screen is an agent page (it has a tab strip or side navigation) or a page outside any agent (Home, the Agents list). */
export function harnessScopeOf(shot) {
  const route = shot?.capture?.route;
  const screen = route?.kind === "copilot-studio" ? COPILOT_STUDIO_SCREENS[route.screen] : null;
  return screen?.scope === "environment" ? "environment" : "agent";
}

/**
 * Prove that the page is in the harness the shot needs. Reads landmarks only; clicks nothing unless `allowClicks` (and then only the
 * sanctioned switch controls: the side bar menu to read a page outside any agent, Skip feedback on a feedback prompt left on screen).
 * @returns {Promise<{ok: true, proof: object, found: string, landmarks: string[]}|{ok: false, code: "wrong-harness"|"harness-unproven", found: string|null, message: string}>}
 */
export async function proveHarness({ page, session, wanted, scope = "agent", allowClicks = true, switched = false, sleep = sleepDefault, trace = null, log = null, waitMs = undefined, deps = null }) {
  let found = null;
  // A feedback prompt left on the page hides it: it is skipped (and only skipped) before anything is read.
  if (wanted === STANDARD && allowClicks && (await readFeedbackPrompt(page)).skip) {
    const executor = makeExecutor({ page, session, trace, log, sleep, deps, shot: "switch-classic" });
    await handleFeedbackPrompt({ page, executor, sleep, waitMs: 0, trace });
  }
  if (scope === "environment") {
    found = await proveEnvironmentPage(page, { session, allowClicks, sleep, trace, log, deps });
  } else {
    const seen = await proveAgentPage(page, { sleep, waitMs: waitMs ?? session?.landmarkMs ?? 10_000, settleMs: session?.landmarkSettleMs ?? 1500 });
    found = seen ? { harness: seen.harness, landmarks: seen.landmarks } : null;
  }
  trace?.event("harness-proof", { wanted, found: found?.harness || null, scope, landmarks: found?.landmarks?.length || 0 });
  if (!found) return { ok: false, code: "harness-unproven", found: null, message: unprovenMessage(wanted) };
  if (found.harness !== wanted) return { ok: false, code: "wrong-harness", found: found.harness, message: wrongHarness(found.harness, wanted) };
  return { ok: true, found: found.harness, landmarks: found.landmarks, proof: harnessEvidence({ id: found.harness, landmarks: found.landmarks, switched, wanted }) };
}

/**
 * Get a shot's page into its harness and prove it, once more after a recovery when the page was found in the wrong one:
 *   - Standard: the switch is made again (the page fell back) and the screen is opened again, only when this shot reused an earlier switch;
 *   - Microsoft Copilot: back to the default experience, then the screen is opened again.
 * `reopen` opens the screen again and returns `{ok: true}` (or `{signIn}`). Customer Conversation has no recovery.
 * @returns {Promise<object>} the result of `proveHarness`, plus `signIn` when a page needed a sign-in on the way, and `recovered`
 */
export async function proveWithRecovery({ page, session, wanted, scope, allowClicks, go, reopen, reusedSwitch = false, trace, log, sleep, readiness, deps }) {
  const state = harnessState(session, page);
  const proofArgs = () => ({ page, session, wanted, scope, allowClicks, switched: wanted === STANDARD && state.switches > 0, sleep, trace, log, deps });
  const first = await proveHarness(proofArgs());
  if (first.ok || !allowClicks || first.code === "harness-unproven" && wanted !== STANDARD) return first;
  const canRecover = wanted === MICROSOFT_COPILOT || (wanted === STANDARD && reusedSwitch);
  if (!canRecover) return first;
  if (wanted === STANDARD) {
    const again = await ensureClassicExperience({ page, session, go, trace, log, sleep, readiness, force: true, deps });
    if (again.signIn) return { ok: false, signIn: again.signIn, code: "sign-in", found: null, message: "" };
    if (!again.ok) return { ok: false, code: again.cause || "harness-switch-failed", found: first.found, message: again.error };
  } else {
    const back = await ensureDefaultExperience({ page, session, go, trace, log, sleep, readiness, force: true });
    if (back.signIn) return { ok: false, signIn: back.signIn, code: "sign-in", found: null, message: "" };
  }
  const reopened = typeof reopen === "function" ? await reopen() : { ok: true };
  if (reopened?.signIn) return { ok: false, signIn: reopened.signIn, code: "sign-in", found: null, message: "" };
  const second = await proveHarness(proofArgs());
  return { ...second, recovered: true };
}
