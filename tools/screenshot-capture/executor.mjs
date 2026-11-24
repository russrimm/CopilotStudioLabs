// The setup executor: it puts a screen into the state a screenshot needs, step by step, and proves each step did
// something before moving on. It is built for a product it has never seen, so it is adaptive and diagnosable:
//
//   * A control is found by ranked strategies: its role and exact name in the expected area, its role and a
//     normalized name, its aria-label or title, its visible text (then the nearest control around it), and last a
//     fuzzy match over the interactive controls only. Every frame is searched, and shadow DOM is pierced.
//   * Every control is described and checked against the action tiers (guard.mjs) before it is touched, and the
//     decision is written to the trace. Anything that is not allowed is skipped, never clicked.
//   * A click that changes nothing is not success: the next candidate or the next strategy is tried. A step
//     passes only when its expected evidence (a dialog, a label, an address, a finished answer) is on the page.
//   * Cookie banners, teaching pop-ups, what's-new dialogs, toasts, and leave-the-page prompts are dismissed
//     before and between steps. Labels may have alternates (another language, a renamed button).
//   * A failed step ends the shot with the exact step that failed and a redacted diagnostic file. It never
//     blocks the next shot.

import { authorizeStep, classifyControl, describeControlForGate, isAllowedUrl, normalizeControlName, TIER } from "./guard.mjs";
import { writeDiagnostic } from "./diagnostics.mjs";
import { BrowserClosedError, classifyBrowserError, isBrowserClosedError } from "./lifecycle.mjs";
import { readinessProbeInPage } from "./readiness.mjs";
import { classifyUrl } from "./signin-url.mjs";
import { progressPhrase } from "./setup-steps.mjs";
import { maskedPath, parseCopilotStudioAddress } from "./targets.mjs";

const sleepDefault = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const escapeRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const STRATEGIES = Object.freeze(["role-exact", "role-name", "attribute", "text-ancestor", "fuzzy"]);

const ROLES_FOR = Object.freeze({
  "open-nav": ["link", "tab", "treeitem", "menuitem", "button"],
  "select-tab": ["tab", "button", "link", "menuitem"],
  reveal: ["tab", "treeitem", "menuitem", "link", "button"],
  expand: ["button", "treeitem", "link", "menuitem"],
  "open-item": ["link", "button", "row", "listitem"],
  open: ["button", "menuitem", "link", "tab"],
  choose: ["radio", "option", "button", "tab", "checkbox", "menuitem", "listitem"],
  click: ["button", "menuitem", "link", "tab"],
  confirm: ["button", "menuitem", "link"],
  create: ["button", "menuitem", "link"],
  close: ["button", "link"],
  discard: ["button", "link"],
  type: ["textbox", "searchbox", "combobox"],
  send: ["button"],
  verify: ["button", "link", "tab", "menuitem", "treeitem", "textbox", "switch", "checkbox", "heading", "region"],
  hover: ["button", "link", "tab", "menuitem", "treeitem"],
  "switch-experience": ["button", "menuitem", "link", "switch", "checkbox"],
});

const INTERACTIVE_SELECTOR = 'button, a[href], [role=button], [role=link], [role=tab], [role=menuitem], [role=menuitemradio], [role=treeitem], [role=option], [role=radio], [role=checkbox], [role=switch], input:not([type=hidden]), textarea, select, summary, [contenteditable=""], [contenteditable=true]';
const CANDIDATES_PER_LIST = 4;
const MAX_TRIES = 6;

// ── Pure helpers (tested without a browser) ─────────────────────────────────

/** Every name a step answers to: its own, then its alternates. */
export function targetNames(target) {
  return [target?.name, ...(target?.alt || [])].filter(Boolean);
}

/** A case-insensitive, whole-name match for any of the names. */
export function exactNameRegex(names) {
  const parts = names.map((n) => escapeRegex(String(n).trim().replace(/\s+/g, " ")));
  return new RegExp(`^\\s*(?:${parts.join("|")})\\s*$`, "i");
}

/** A looser match: the words in order, with any punctuation or spacing between them, as whole words. */
export function wordsRegex(names) {
  const parts = names
    .map((n) => normalizeControlName(n).split(" ").filter(Boolean).map(escapeRegex).join("[^\\p{L}\\p{N}]+"))
    .filter(Boolean);
  if (!parts.length) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${parts.join("|")})(?![\\p{L}\\p{N}])`, "iu");
}

/** How well a control's name matches the wanted names, 0 to 1 (word overlap, so a renamed button still scores). */
export function nameScore(wanted, actual) {
  const a = new Set(normalizeControlName(actual).split(" ").filter(Boolean));
  if (!a.size) return 0;
  let best = 0;
  for (const name of wanted) {
    const w = normalizeControlName(name).split(" ").filter(Boolean);
    if (!w.length) continue;
    const hits = w.filter((word) => a.has(word)).length;
    const score = (hits / w.length) * 0.7 + (hits / a.size) * 0.3;
    best = Math.max(best, score);
  }
  return Math.round(best * 100) / 100;
}

/** Whether a described control sits where the step says it should. */
export function fitsArea(desc, within = "any") {
  switch (within) {
    case "nav":
      return Boolean(desc.inNav);
    case "dialog":
      return Boolean(desc.inDialog);
    case "chat":
      return Boolean(desc.inTestPane);
    case "header":
      return Boolean(desc.inHeader);
    case "tablist":
      return desc.role === "tab" || Boolean(desc.inNav);
    case "main":
      return !desc.inDialog && !desc.inNav && !desc.inHeader;
    default:
      return true;
  }
}

/** Areas that must match: a click may never leave a dialog or the test pane it was told to stay in. */
const STRICT_AREAS = new Set(["dialog", "chat"]);

/**
 * How far a described control is from the lower left corner of the viewport, in the units of `desc.box` (6 pixels), or null when it
 * is not in the lower left quarter of the page (or its place is not known). A control that must be "in the lower left corner" is only
 * a control that is there, and the one nearest the corner is tried first.
 */
export function lowerLeftDistance(box, viewport = { width: 1440, height: 900 }) {
  const parts = String(box || "").split(":").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [x, y, , h] = parts;
  const width = (Number(viewport?.width) || 1440) / 6;
  const height = (Number(viewport?.height) || 900) / 6;
  if (x >= width / 2 || y + h <= height / 2) return null;
  return x + Math.max(0, height - (y + h));
}

/**
 * Whether what the page shows now satisfies what the step expects. `before` and `after` come from `readState`.
 * With no expectation, any visible change (address, page, selection) counts.
 */
export function effectSatisfied(expect, before, after, { selectedChanged = false } = {}) {
  const urlChanged = before.url !== after.url;
  const domChanged = after.changes !== null && before.changes !== null && after.changes > before.changes;
  if (!expect || !Object.keys(expect).length) {
    return urlChanged || domChanged || selectedChanged ? { ok: true, why: urlChanged ? "the address changed" : selectedChanged ? "the control is now open" : "the page changed" } : { ok: false, why: "nothing changed" };
  }
  if (expect.dialog) {
    const wanted = typeof expect.dialog === "string" ? normalizeControlName(expect.dialog) : "";
    const open = after.dialogs.filter((d) => d.kind === "dialog" || d.kind === "menu");
    const fresh = open.length > before.dialogs.filter((d) => d.kind === "dialog" || d.kind === "menu").length;
    const titled = wanted ? open.some((d) => normalizeControlName(d.title).includes(wanted)) : fresh || open.length > 0;
    if (!titled) return { ok: false, why: "no dialog opened" };
  }
  if (expect.panel) {
    const open = after.dialogs.filter((d) => d.kind === "panel" || d.kind === "dialog");
    if (!open.length || (open.length <= before.dialogs.filter((d) => d.kind === "panel" || d.kind === "dialog").length && !domChanged)) return { ok: false, why: "no panel opened" };
  }
  if (expect.urlPath) {
    const path = (() => {
      try {
        return new URL(after.url).pathname;
      } catch {
        return "";
      }
    })();
    if (!path.toLowerCase().includes(expect.urlPath.toLowerCase())) return { ok: false, why: "the address is not the expected one" };
  }
  if (expect.selected && !selectedChanged && !urlChanged && !domChanged) return { ok: false, why: "the control is not open" };
  return { ok: true, why: "the expected result is on the page" };
}

// ── In-page helpers (each must stay self-contained) ─────────────────────────

/** Visible dialogs, menus, and side panels of one frame, including those inside open shadow roots. */
export function dialogsInPage() {
  const out = [];
  const deepAll = (selector, root, found) => {
    for (const el of root.querySelectorAll(selector)) found.push(el);
    for (const el of root.querySelectorAll("*")) if (el.shadowRoot) deepAll(selector, el.shadowRoot, found);
    return found;
  };
  const visible = (el) => {
    if (el.closest("[data-capture-ui]") || el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width >= 20 && rect.height >= 20 && style.visibility !== "hidden" && style.display !== "none";
  };
  const title = (el) => String(el.getAttribute("aria-label") || (el.querySelector("h1,h2,h3,[role=heading]") || {}).textContent || "").replace(/\s+/g, " ").trim().slice(0, 80);
  for (const el of deepAll("dialog[open], [role=dialog], [role=alertdialog], [aria-modal=true]", document, [])) if (visible(el)) out.push({ kind: "dialog", title: title(el) });
  for (const el of deepAll("[role=menu], [role=listbox]", document, [])) if (visible(el)) out.push({ kind: "menu", title: title(el) });
  for (const el of deepAll("aside, [role=complementary]", document, [])) {
    if (!visible(el)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width > 120 && rect.height > 120) out.push({ kind: "panel", title: title(el) });
  }
  return out;
}

/** The controls of the open dialog of one frame, by their names, and whether any of them is a choice or an alert. Names only, never page text. */
export function dialogControlsInPage() {
  const deepAll = (selector, root, found) => {
    for (const el of root.querySelectorAll(selector)) found.push(el);
    for (const el of root.querySelectorAll("*")) if (el.shadowRoot) deepAll(selector, el.shadowRoot, found);
    return found;
  };
  const visible = (el) => {
    if (el.closest("[data-capture-ui]") || el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width >= 4 && rect.height >= 4 && style.visibility !== "hidden" && style.display !== "none";
  };
  const nameOf = (el) => String(el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || el.getAttribute("value") || "").replace(/\s+/g, " ").trim().slice(0, 80);
  const dialogs = deepAll("dialog[open], [role=dialog], [role=alertdialog], [aria-modal=true]", document, []).filter(visible);
  if (dialogs.length !== 1) return { dialogs: dialogs.length, controls: [], alerts: 0 };
  const root = dialogs[0];
  const controls = [];
  for (const el of deepAll("button, a[href], input, select, textarea, [role=button], [role=link], [role=checkbox], [role=radio], [role=switch], [role=combobox], [role=textbox], [role=menuitem], [role=option], [role=tab], [role=listbox], [contenteditable=true]", root, [])) {
    if (!visible(el)) continue;
    const role = String(el.getAttribute("role") || "").toLowerCase();
    const tag = el.tagName.toLowerCase();
    const choice = ["checkbox", "radio", "switch", "combobox", "textbox", "option", "listbox"].includes(role) || ["select", "textarea"].includes(tag) || (tag === "input" && !["button", "submit"].includes(String(el.getAttribute("type") || "text").toLowerCase())) || el.isContentEditable === true;
    controls.push({ name: nameOf(el), kind: choice ? "choice" : "action" });
  }
  const alerts = deepAll("[role=alert], [role=alertdialog]", root, []).filter(visible).length + (root.matches("[role=alertdialog]") ? 1 : 0);
  return { dialogs: 1, controls: controls.slice(0, 40), alerts };
}

/** How many items that can be removed (a knowledge source or a tool, by its "Remove <name>" button) are listed, not counting the built-in Work IQ tool. Names only. */
export function removableItemsInPage() {
  let count = 0;
  for (const el of document.querySelectorAll("button, [role=button]")) {
    if (el.closest("[data-capture-ui], dialog, [role=dialog], [aria-modal=true]") || el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") continue;
    const name = String(el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || "").replace(/\s+/g, " ").trim();
    if (!/^remove\s+\S/i.test(name) || /work\s*iq/i.test(name)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width >= 4 && rect.height >= 4) count += 1;
  }
  return count;
}

/** The nearest container around a field that holds a conversation: where an answer will appear. */
export function chatRootInPage(el) {
  let node = el.parentElement;
  let best = el.parentElement || el;
  while (node && node !== document.body) {
    if (node.matches("aside, [role=complementary], [role=region], [role=dialog], dialog, [aria-label]") && node.getBoundingClientRect().height > 150) return node;
    best = node;
    node = node.parentElement;
  }
  return best;
}

/** How much text a conversation holds and whether something in it is still working. */
export function conversationInPage(root) {
  const el = root || document.body;
  const busy = el.querySelectorAll('[aria-busy="true"], [role="progressbar"], progress, [class*="typing" i], [class*="dots" i], [class*="loading" i], [class*="streaming" i], [data-typing="true"], [data-loading="true"]');
  let working = 0;
  for (const item of busy) {
    if (item.closest("[hidden], [aria-hidden='true']")) continue;
    const rect = item.getBoundingClientRect();
    const style = getComputedStyle(item);
    if (rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none") working += 1;
  }
  return { length: String(el.innerText || "").length, working };
}

/** Banners, pop-ups, toasts, and prompts that stand between a step and the page. */
export function findInterstitialsInPage(selector) {
  const out = [];
  const bannerRe = /cookie|privacy|consent banner|teaching|coach ?mark|what.?s new|new feature|introducing|welcome|take a (?:quick )?tour|tour|onboarding|survey|feedback|rate your|session|expire|unsaved|leave this page|leave page|discard changes|changes you made|notification|got it/i;
  const hazardRe = /delete|remove|permission|install|sign out|sign in|publish|share|invite|admin|billing|licen[sc]e|security|connect|credential|password|upload|download|environment|tenant/i;
  document.querySelectorAll(selector).forEach((el, index) => {
    if (el.closest("[data-capture-ui]") || el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") return;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (rect.width < 20 || rect.height < 12 || style.visibility === "hidden" || style.display === "none") return;
    const head = `${el.getAttribute("aria-label") || ""} ${el.id || ""} ${typeof el.className === "string" ? el.className : ""} ${String((el.querySelector("h1,h2,h3,[role=heading]") || {}).textContent || "")} ${String(el.innerText || "").slice(0, 240)}`;
    if (!bannerRe.test(head) || hazardRe.test(head)) return;
    out.push(index);
  });
  return out.slice(0, 4);
}

const INTERSTITIAL_SELECTOR = '[id*="cookie" i], [class*="cookie" i], [aria-label*="cookie" i], [class*="teaching" i], [class*="coachmark" i], [class*="whats-new" i], [class*="whatsnew" i], [class*="onboarding" i], [class*="toast" i], [class*="snackbar" i], [data-testid*="banner" i], [role=alert], [role=status], [role=dialog], [role=alertdialog], dialog[open]';
const DISMISS_NAMES = new Set(["accept", "accept all", "got it", "ok", "okay", "dismiss", "close", "not now", "maybe later", "skip", "skip tour", "no thanks", "decline", "reject all", "remind me later", "leave", "leave page", "discard", "discard changes", "don t save", "leave without saving", "x", "close dialog", "dismiss notification"]);

/**
 * Runs in the page (it must stay self-contained): is a dialog or alert up that the computer did not expect (a license,
 * a consent or permission request, a second sign-in or MFA prompt, an admin prompt, a quota or limit error, an error)?
 * It returns only a kind, never the text: the words are matched here and not kept.
 */
export function unexpectedPromptInPage() {
  const visible = (el) => {
    if (el.closest("[data-capture-ui]") || el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width >= 20 && rect.height >= 12 && style.visibility !== "hidden" && style.display !== "none";
  };
  const kinds = [
    ["mfa", /verify your identity|multi-?factor|authenticator|approve sign.?in|enter (?:the )?code|stay signed in|keep me signed in/i],
    ["consent", /permissions? requested|needs? your permission|grant (?:access|consent)|consent on behalf|allow (?:this )?app|accept (?:the )?(?:terms|permissions)/i],
    ["license", /licen[sc]e|trial (?:has )?(?:ended|expired)|start (?:a )?(?:free )?trial|upgrade (?:your )?(?:plan|account)|purchase|subscribe|you need a (?:plan|license)/i],
    ["quota", /quota|limit (?:has been )?reached|reached (?:the|your) limit|too many requests|throttl|capacity|rate limit|exceeded|try again later|credits? (?:have )?(?:run out|are used)|out of credits/i],
    ["admin", /contact your (?:it )?admin|administrator|admin (?:approval|consent|required)|blocked by (?:your )?(?:organization|admin|policy)|data (?:loss prevention|policy)|not allowed by/i],
    ["error", /something went wrong|unexpected error|an error (?:has )?occurred|couldn.?t (?:create|save|publish|load)|failed to (?:create|save|publish|load)|can.?t (?:create|save|publish)|access denied|forbidden|not authorized|you don.?t have (?:permission|access)/i],
  ];
  for (const el of document.querySelectorAll('dialog[open], [role=dialog], [role=alertdialog], [role=alert]')) {
    if (!visible(el)) continue;
    // A dialog is judged by its title and the start of its body (long option lists mention licenses in passing); an alert by its whole message.
    const alert = el.getAttribute("role") === "alert";
    const text = `${el.getAttribute("aria-label") || ""} ${(el.querySelector("h1,h2,h3,[role=heading]") || {}).textContent || ""} ${String(el.innerText || el.textContent || "").slice(0, alert ? 300 : 120)}`;
    for (const [kind, re] of kinds) if (re.test(text)) return { kind };
  }
  return null;
}

/** The function names are `fuzzyListInPage`: interactive controls with the words in their names (self-contained). */
export function fuzzyListInPage(selector) {
  const out = [];
  document.querySelectorAll(selector).forEach((el, index) => {
    if (el.closest("[data-capture-ui]")) return;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (rect.width < 4 || rect.height < 4 || style.visibility === "hidden" || style.display === "none") return;
    const labelledBy = String(el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean).map((id) => (document.getElementById(id) || {}).textContent || "").join(" ");
    const name = el.getAttribute("aria-label") || labelledBy || (el.tagName === "INPUT" || el.tagName === "TEXTAREA" ? "" : el.innerText || el.textContent) || el.getAttribute("title") || el.getAttribute("placeholder") || "";
    out.push({ index, name: String(name).replace(/\s+/g, " ").trim().slice(0, 120) });
  });
  return out.slice(0, 400);
}

// ── Page state ──────────────────────────────────────────────────────────────

/** What a page shows now, cheaply: the address, a change counter, and the open dialogs and panels of every frame. */
export async function readState(page) {
  const state = { url: "", changes: null, text: 0, busy: 0, dialogs: [] };
  try {
    state.url = typeof page.url === "function" ? page.url() : "";
  } catch (err) {
    if (isBrowserClosedError(err)) throw err;
  }
  const frames = typeof page.frames === "function" ? page.frames().slice(0, 6) : [];
  // A change in any frame counts (a test pane in an iframe is where the answer appears).
  for (const frame of frames.length ? frames : [page]) {
    try {
      const probe = await frame.evaluate(readinessProbeInPage);
      if (typeof probe?.changes === "number") state.changes = (state.changes ?? 0) + probe.changes;
      state.text += probe?.text || 0;
      state.busy += probe?.busy || 0;
    } catch (err) {
      if (isBrowserClosedError(err)) throw err;
    }
  }
  for (const frame of frames) {
    try {
      const listed = await frame.evaluate(dialogsInPage);
      if (Array.isArray(listed)) state.dialogs.push(...listed);
    } catch (err) {
      if (isBrowserClosedError(err)) throw err;
    }
  }
  return state;
}

function framesOf(page) {
  const list = typeof page.frames === "function" ? page.frames() : [page];
  return list.length ? list : [page];
}

async function describeLocator(locator) {
  let desc = null;
  try {
    desc = await locator.evaluate(describeControlForGate, undefined, { timeout: 2500 });
  } catch (err) {
    if (isBrowserClosedError(err)) throw err;
    return null;
  }
  try {
    const box = await locator.boundingBox({ timeout: 1000 });
    desc.box = box ? `${Math.round(box.x / 6)}:${Math.round(box.y / 6)}:${Math.round(box.width / 6)}:${Math.round(box.height / 6)}` : "";
  } catch (err) {
    if (isBrowserClosedError(err)) throw err;
    desc.box = "";
  }
  return desc;
}

async function listFrom(list, strategy) {
  const found = [];
  let count = 0;
  try {
    count = Math.min(await list.count(), CANDIDATES_PER_LIST);
  } catch (err) {
    if (isBrowserClosedError(err)) throw err;
    return found;
  }
  for (let i = 0; i < count; i += 1) found.push({ locator: list.nth(i), strategy });
  return found;
}

/** The locators a strategy offers for a step, before any of them is described. */
export async function locatorsForStrategy(page, strategy, step, { names, roles }) {
  const found = [];
  for (const frame of framesOf(page)) {
    try {
      if (strategy === "role-exact" && typeof frame.getByRole === "function") {
        const re = exactNameRegex(names);
        for (const role of roles) found.push(...(await listFrom(frame.getByRole(role, { name: re }), strategy)));
      } else if (strategy === "role-name" && typeof frame.getByRole === "function") {
        const re = wordsRegex(names);
        if (re) for (const role of roles) found.push(...(await listFrom(frame.getByRole(role, { name: re }), strategy)));
      } else if (strategy === "attribute" && typeof frame.locator === "function") {
        for (const name of names) {
          const safe = String(name).replace(/["\\]/g, "\\$&");
          for (const attr of ["aria-label", "title", "placeholder", "data-testid"]) found.push(...(await listFrom(frame.locator(`[${attr}="${safe}" i]`), strategy)));
        }
      } else if (strategy === "text-ancestor" && typeof frame.getByText === "function") {
        for (const name of names) {
          const around = frame.getByText(new RegExp(`^\\s*${escapeRegex(String(name).trim())}\\s*$`, "i")).locator("xpath=ancestor-or-self::*[self::button or self::a or self::summary or @role='button' or @role='tab' or @role='menuitem' or @role='link' or @role='option' or @role='treeitem' or @tabindex][1]");
          found.push(...(await listFrom(around, strategy)));
          // A row of a list is often a plain element with a click handler: "open an item" may click the text of the row itself.
          if (step?.action === "open-item" && !found.length) found.push(...(await listFrom(frame.getByText(new RegExp(`^\\s*${escapeRegex(String(name).trim())}`, "i")), strategy)));
        }
      } else if (strategy === "fuzzy" && typeof frame.evaluate === "function") {
        const listed = await frame.evaluate(fuzzyListInPage, INTERACTIVE_SELECTOR);
        const scored = listed.map((item) => ({ ...item, score: nameScore(names, item.name) })).filter((item) => item.score >= 0.5).sort((a, b) => b.score - a.score).slice(0, CANDIDATES_PER_LIST);
        for (const item of scored) found.push({ locator: frame.locator(INTERACTIVE_SELECTOR).nth(item.index), strategy });
      }
    } catch (err) {
      if (isBrowserClosedError(err)) throw err;
    }
  }
  return found;
}

// ── Page guards: native prompts, new tabs ───────────────────────────────────

const guarded = new WeakSet();

/** Native "leave this page?" prompts are accepted (that discards unsaved edits); every other native prompt is dismissed. New tabs a click opens are closed. */
export function attachPageGuards(page, { trace = null } = {}) {
  if (!page || guarded.has(page) || typeof page.on !== "function") return;
  guarded.add(page);
  page.on("dialog", (dialog) => {
    const type = typeof dialog.type === "function" ? dialog.type() : "";
    trace?.event("native-dialog", { type, action: type === "beforeunload" ? "accepted" : "dismissed" });
    const done = type === "beforeunload" ? dialog.accept() : dialog.dismiss();
    Promise.resolve(done).catch(() => {});
  });
  page.on("popup", (popup) => {
    trace?.event("popup-closed", {});
    Promise.resolve(popup.close()).catch(() => {});
  });
}

// ── The executor ────────────────────────────────────────────────────────────

/**
 * @param {object} ctx
 * @param {object} ctx.page
 * @param {ReturnType<typeof import("./guard.mjs").resolveAutonomy>} ctx.autonomy
 * @param {string} [ctx.product]
 * @param {{agentId?: string|null, creating?: boolean}} [ctx.practice] the practice agent, when one is in use
 * @param {object} [ctx.inputs] sample text by kind (`question`, `search`...)
 */
export function createExecutor(ctx) {
  const { page, autonomy, product = "", trace = null, log = null, sleep = sleepDefault, terms = [], home = null, shot = "", companion = "" } = ctx;
  const now = ctx.now || (() => Date.now());
  const practice = ctx.practice || {};
  const stepTimeoutMs = ctx.stepTimeoutMs ?? 3000;
  const effectMs = ctx.effectMs ?? 4000;
  const answerMs = ctx.answerMs ?? 45_000;
  const answerStableMs = ctx.answerStableMs ?? 900;
  // Writes are paced and counted across every executor of a job (`ctx.writeBudget` is shared), so a runaway loop cannot make changes quickly.
  const budget = ctx.writeBudget || { count: 0, max: Infinity, gapMs: 0, last: 0 };
  const state = { chatRoot: null, lastInput: null, lenAtSend: 0, halted: null, haltKind: null, blocked: [], opened: [], observed: new Set() };

  /** Whether the page is inside the practice agent: its own address (environment and agent), not a page that merely mentions it. */
  const onPracticeAgent = () => {
    const wanted = String(practice.agentId || "").toLowerCase();
    if (!wanted) return false;
    const parsed = parseCopilotStudioAddress(page.url?.() || "");
    if (!parsed.ok || !parsed.botId || parsed.botId.toLowerCase() !== wanted) return false;
    return !practice.envId || String(parsed.envId || "").toLowerCase() === String(practice.envId).toLowerCase();
  };
  const gate = (step, desc) => {
    const decision = authorizeStep({ step, desc, autonomy, product, practice: { onPracticeAgent: onPracticeAgent(), creatingPracticeAgent: typeof practice.creating === "function" ? Boolean(practice.creating(page.url?.() || "")) : Boolean(practice.creating) } });
    // The kill switch: once the run is stopped (Stop in the portal, Ctrl+C), nothing that changes anything is done.
    if (decision.allowed && decision.tier >= TIER.PRACTICE && ctx.shouldStop?.()) return { ...decision, allowed: false, denied: "stopped", reason: "The capture was stopped, so nothing is changed." };
    if (decision.allowed && decision.tier >= TIER.PRACTICE && budget.count >= budget.max) {
      state.halted = state.halted || "The computer reached the limit of changes it makes in one job, so it stopped. Nothing else was changed.";
      state.haltKind = state.haltKind || "write-limit";
      return { ...decision, allowed: false, denied: "write-limit", reason: "The limit of changes for one job was reached." };
    }
    return decision;
  };

  /** Space writes out: at least `gapMs` after the last one, whichever executor made it. */
  async function paceWrite() {
    const wait = budget.last + (budget.gapMs || 0) - now();
    if (wait > 0) await sleep(wait);
    budget.last = now();
    budget.count += 1;
  }

  /** Stop the whole run when something nobody planned for is on the screen (a license, a consent, an MFA prompt, a quota or error message). */
  async function checkUnexpectedPrompt() {
    for (const frame of framesOf(page)) {
      let found = null;
      try {
        found = await frame.evaluate(unexpectedPromptInPage);
      } catch (err) {
        if (isBrowserClosedError(err)) throw err;
        continue;
      }
      if (found?.kind) {
        const what = { mfa: "a sign-in or identity check", consent: "a permission or consent request", license: "a license or plan prompt", quota: "a quota or limit message", admin: "an admin or policy block", error: "an error message" }[found.kind] || "an unexpected prompt";
        state.halted = `The product showed ${what} that the computer was not expecting, so it stopped instead of guessing. Nothing else was clicked.`;
        state.haltKind = `unexpected-${found.kind}`;
        trace?.event("unexpected-prompt", { kind: found.kind, shot });
        return true;
      }
    }
    return false;
  }

  async function dismissInterruptions() {
    let dismissed = 0;
    for (const frame of framesOf(page)) {
      let indexes = [];
      try {
        indexes = await frame.evaluate(findInterstitialsInPage, INTERSTITIAL_SELECTOR);
      } catch (err) {
        if (isBrowserClosedError(err)) throw err;
        continue;
      }
      for (const index of Array.isArray(indexes) ? indexes : []) {
        const container = frame.locator(INTERSTITIAL_SELECTOR).nth(index);
        const buttons = container.getByRole("button");
        let count = 0;
        try {
          count = Math.min(await buttons.count(), 6);
        } catch (err) {
          if (isBrowserClosedError(err)) throw err;
          continue;
        }
        for (let i = 0; i < count; i += 1) {
          const button = buttons.nth(i);
          const desc = await describeLocator(button);
          if (!desc) continue;
          const name = normalizeControlName(desc.name || desc.text);
          if (!DISMISS_NAMES.has(name)) continue;
          // An interstitial is not part of the product: only a name that is never allowed (sign out, delete...) stops it.
          const seen = classifyControl(desc, { action: "close", intent: "close" });
          if (seen.tier >= TIER.NEVER) continue;
          try {
            await button.click({ timeout: 1500 });
            dismissed += 1;
            trace?.event("interstitial-dismissed", { kind: name });
            await sleep(250);
            break;
          } catch (err) {
            if (isBrowserClosedError(err)) throw err;
          }
        }
      }
    }
    return dismissed;
  }

  function hostOk() {
    return isAllowedUrl(typeof page.url === "function" ? page.url() : "", product);
  }

  async function leaveIfOutside(record) {
    if (hostOk()) return true;
    record.note = "the page left the product's own sites";
    trace?.event("left-allowed-hosts", { host: maskedPath(page.url()).split("/")[0] });
    // A sign-in page (a company identity provider, for example) is left alone: a person may be signing in.
    if (classifyUrl(typeof page.url === "function" ? page.url() : "").kind === "sign-in") {
      record.note = "the page went to a sign-in page, so the computer waits";
      return false;
    }
    try {
      await page.goBack({ timeout: 8000 });
    } catch (err) {
      if (isBrowserClosedError(err)) throw err;
    }
    return false;
  }

  /** Candidates are produced lazily and strategy by strategy, so the cheap strategies win without paying for the rest. */
  async function* candidateStream(step, record) {
    const names = targetNames(step.target);
    const roles = step.target?.role ? [step.target.role] : ROLES_FOR[step.action] || ROLES_FOR.click;
    const within = step.target?.within || "any";
    const seen = new Set();
    let produced = 0;
    for (const strategy of STRATEGIES) {
      if (!names.length) break;
      const attempt = { strategy, found: 0, tried: 0, blocked: "", effect: null, note: "" };
      record.attempts.push(attempt);
      const located = await locatorsForStrategy(page, strategy, step, { names, roles });
      const described = [];
      for (const item of located) {
        let visible = false;
        try {
          visible = await item.locator.isVisible();
        } catch (err) {
          if (isBrowserClosedError(err)) throw err;
        }
        if (!visible) continue;
        const desc = await describeLocator(item.locator);
        if (!desc || desc.disabled) continue;
        // A link goes to another page; it cannot be what opens a dialog or a panel, and following it would reset the page the step is working on.
        if ((step.expect?.dialog || step.expect?.panel) && step.target?.role !== "link" && (desc.role === "link" || desc.tag === "a")) continue;
        const key = `${desc.box}|${desc.tag}|${normalizeControlName(desc.name)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (STRICT_AREAS.has(within) && !fitsArea(desc, within)) continue;
        described.push({ ...item, desc, fits: fitsArea(desc, within) });
      }
      described.sort((a, b) => Number(b.fits) - Number(a.fits));
      if (step.target?.corner === "lower-left") {
        // Only a control in the lower left corner counts, and the one nearest the corner is tried first.
        const viewport = typeof page.viewportSize === "function" ? page.viewportSize() : null;
        const placed = described.map((item) => ({ item, at: lowerLeftDistance(item.desc.box, viewport || undefined) })).filter((entry) => entry.at !== null);
        placed.sort((a, b) => a.at - b.at);
        described.length = 0;
        described.push(...placed.map((entry) => entry.item));
      }
      attempt.found = described.length;
      for (const item of described) {
        if (produced >= MAX_TRIES) return;
        produced += 1;
        yield { ...item, attempt };
      }
    }
  }

  /** The first links in the main area, for "open an item" when no name is given. */
  async function* itemStream(step, record) {
    const attempt = { strategy: "first-item", found: 0, tried: 0, blocked: "", effect: null, note: "" };
    record.attempts.push(attempt);
    for (const frame of framesOf(page)) {
      const list = frame.locator("main a[href], [role=main] a[href], table a[href], [role=row] a[href], li a[href]");
      let count = 0;
      try {
        count = Math.min(await list.count(), 8);
      } catch (err) {
        if (isBrowserClosedError(err)) throw err;
        continue;
      }
      for (let i = 0; i < count; i += 1) {
        const locator = list.nth(i);
        const desc = await describeLocator(locator);
        if (!desc || desc.disabled || desc.inNav) continue;
        // A link the safety rules would never follow (an admin page, a sign-out) is not an item: it is left out, so a list that has not drawn yet is waited for instead of failing on it.
        if (classifyControl(desc, { action: "open-item", intent: "navigate" }).tier >= TIER.NEVER) continue;
        let visible = false;
        try {
          visible = await locator.isVisible();
        } catch (err) {
          if (isBrowserClosedError(err)) throw err;
        }
        if (!visible) continue;
        attempt.found += 1;
        yield { locator, strategy: "first-item", desc, fits: true, attempt };
      }
    }
  }

  async function waitForEffect(step, before, candidate, expectOverride = null) {
    const expect = expectOverride ?? step.expect;
    const deadline = now() + (step.timeoutMs ?? effectMs);
    let last = { ok: false, why: "nothing changed" };
    let waited = 0;
    for (;;) {
      await page.waitForLoadState?.("domcontentloaded", { timeout: 1500 }).catch(() => {});
      const after = await readState(page);
      let selectedChanged = false;
      if (candidate && !candidate.desc?.expanded) {
        try {
          // The control may be gone (the click moved the page on): look for it only briefly.
          const again = await candidate.locator.evaluate(describeControlForGate, undefined, { timeout: 300 });
          selectedChanged = Boolean(again.expanded) && !candidate.desc.expanded;
        } catch (err) {
          if (isBrowserClosedError(err)) throw err;
        }
      }
      last = effectSatisfied(expect, before, after, { selectedChanged });
      if (last.ok && expect?.text?.length && !(await textsVisible(expect.text))) last = { ok: false, why: "the expected text is not showing" };
      if (last.ok && expect?.absent?.length && (await anyTextVisible(expect.absent))) last = { ok: false, why: "the old screen is still showing" };
      if (last.ok) return last;
      if (now() >= deadline || waited >= (step.timeoutMs ?? effectMs)) return last;
      await sleep(150);
      waited += 150;
    }
  }

  async function textVisible(text) {
    const re = new RegExp(escapeRegex(String(text).trim()), "i");
    for (const frame of framesOf(page)) {
      try {
        const item = frame.getByText(re).first();
        if (await item.isVisible()) return true;
      } catch (err) {
        if (isBrowserClosedError(err)) throw err;
      }
    }
    return false;
  }
  async function textsVisible(texts) {
    for (const text of texts) if (!(await textVisible(text))) return false;
    return true;
  }
  async function anyTextVisible(texts) {
    for (const text of texts) if (await textVisible(text)) return true;
    return false;
  }

  /** How much text the conversation holds now (its container, or the page when none was found): the base the answer is measured against. */
  async function conversationLength() {
    try {
      const read = state.chatRoot ? await state.chatRoot.evaluate(conversationInPage) : await page.evaluate(conversationInPage, null);
      return read.length;
    } catch (err) {
      if (isBrowserClosedError(err)) throw err;
      return 0;
    }
  }

  /** Whether the field the message was typed in is empty again (it was sent). Only what this step typed is looked at. */
  async function inputIsEmpty(locator) {
    const left = (await locator.inputValue({ timeout: 800 }).catch(() => null)) ?? (await locator.innerText({ timeout: 800 }).catch(() => ""));
    return String(left).trim() === "";
  }

  function sampleFor(step) {
    if (step.text?.literal) return step.text.literal;
    const kind = step.text?.sample || "question";
    // A name, the instructions, or a website address is never replaced by some other sample: a wrong text in the wrong field changes the agent.
    if (["agentName", "instructions", "website", "outOfScope", "guardrail"].includes(kind)) return ctx.inputs?.[kind] || "";
    return ctx.inputs?.[kind] || ctx.inputs?.question || "";
  }

  // ── One step ──────────────────────────────────────────────────────────────

  async function actOnCandidate(step, candidate, record) {
    const { locator } = candidate;
    const before = await readState(page);
    switch (step.action) {
      case "type": {
        const text = sampleFor(step);
        if (!text) return { ok: false, why: "there is no sample text for this step" };
        await locator.scrollIntoViewIfNeeded?.({ timeout: 1500 }).catch(() => {});
        await locator.click({ timeout: stepTimeoutMs }).catch(() => {});
        const plain = ["input", "textarea"].includes(candidate.desc.tag);
        const holds = async (settleMs = 0) => {
          // A rich editor can drop text that was set behind its back a moment later: look again after it had time to.
          if (settleMs) await sleep(settleMs);
          const typed = (await locator.inputValue({ timeout: 1000 }).catch(() => null)) ?? (await locator.innerText({ timeout: 1000 }).catch(() => ""));
          return String(typed).includes(text.slice(0, 20));
        };
        if (plain) await locator.fill(text, { timeout: stepTimeoutMs });
        else {
          // A rich editor takes real input events: select what is there and insert the text as typing does.
          await page.keyboard.press("Control+A").catch(() => {});
          await page.keyboard.insertText(text).catch(() => {});
        }
        let typedOk = await holds(plain ? 0 : 500);
        if (!typedOk && plain) typedOk = await holds(300);
        if (!typedOk) {
          await locator.click({ timeout: 1500 }).catch(() => {});
          await page.keyboard.press("Control+A").catch(() => {});
          await page.keyboard.type(text, { delay: 8 });
          typedOk = await holds(plain ? 0 : 500);
        }
        if (!typedOk) return { ok: false, why: "the text did not appear in the field" };
        state.lastInput = locator;
        state.chatRoot = (await locator.evaluateHandle(chatRootInPage, undefined, { timeout: 1500 }).catch(() => null)) || state.chatRoot;
        return { ok: true, why: "the field holds the text" };
      }
      case "send": {
        state.lenAtSend = await conversationLength();
        await locator.click({ timeout: stepTimeoutMs });
        const effect = await waitForEffect(step, before, candidate);
        // A click that left the message in the field did not send it.
        if (effect.ok && state.lastInput && !(await inputIsEmpty(state.lastInput))) return { ok: false, why: "the message is still in the field" };
        return effect;
      }
      case "hover": {
        await locator.scrollIntoViewIfNeeded?.({ timeout: 1500 }).catch(() => {});
        await locator.hover({ timeout: stepTimeoutMs });
        return { ok: true, why: "pointed at it" };
      }
      default: {
        await locator.scrollIntoViewIfNeeded?.({ timeout: stepTimeoutMs }).catch(() => {});
        if (candidate.desc.expanded && step.action === "expand") return { ok: true, why: "already open", already: true };
        if ((candidate.desc.role === "tab" || step.action === "open-nav") && candidate.desc.selected) return { ok: true, why: "already open", already: true };
        if (step.onlyIfOff && (candidate.desc.checked || (step.action === "open" && (candidate.desc.selected || candidate.desc.expanded)))) return { ok: true, why: "already on", already: true };
        if (step.onlyIfOn && !candidate.desc.checked) return { ok: true, why: "already off", already: true };
        await locator.click({ timeout: stepTimeoutMs });
        const effect = await waitForEffect(step, before, candidate);
        if (step.action === "open" || step.action === "choose") {
          const opened = (await readState(page)).dialogs;
          if (opened.length > before.dialogs.length) state.opened.push(step.id);
        }
        // The click was made; what it did is checked by the step after it (a save has no visible effect of its own).
        if (!effect.ok && step.soft) return { ok: true, why: "clicked (the result is checked next)", soft: true };
        return effect;
      }
    }
  }

  async function runTargetedStep(step, record) {
    const stream = step.action === "open-item" && !step.target?.name ? itemStream(step, record) : candidateStream(step, record);
    let tries = 0;
    for await (const candidate of stream) {
      const decision = gate(step, candidate.desc);
      trace?.event("gate", { shot, step: step.id, action: step.action, tier: decision.tier, category: decision.category, allowed: decision.allowed, denied: decision.denied || "", strategy: candidate.strategy, role: candidate.desc.role });
      if (!decision.allowed) {
        candidate.attempt.blocked = decision.denied || "blocked";
        state.blocked.push({ step: step.id, category: decision.category, denied: decision.denied, tier: decision.tier });
        record.blocked = { category: decision.category, denied: decision.denied, tier: decision.tier, reason: decision.reason };
        continue;
      }
      tries += 1;
      candidate.attempt.tried += 1;
      if (decision.tier >= TIER.PRACTICE) {
        if (ctx.shouldStop?.()) {
          record.note = "the capture was stopped, so nothing is changed";
          return false;
        }
        // A step that must be done once per agent (publishing) is claimed, in the local record, before the click and never again.
        if (step.once && !(practice.agentId && typeof ctx.claimOnce === "function" && ctx.claimOnce(step.once))) {
          record.note = "this was already tried once on the practice agent, so it is not clicked again";
          record.blocked = { category: "once", denied: "once-only", tier: decision.tier, reason: record.note };
          return false;
        }
        await paceWrite();
      }
      let outcome;
      try {
        outcome = await actOnCandidate(step, candidate, record);
      } catch (err) {
        if (isBrowserClosedError(err)) throw err;
        outcome = { ok: false, why: String(err?.message || err).split("\n")[0].slice(0, 120) };
      }
      candidate.attempt.effect = outcome.ok;
      candidate.attempt.note = outcome.why || "";
      if (outcome.ok) {
        record.strategy = candidate.strategy;
        record.tier = Math.max(record.tier, decision.tier);
        record.effect = outcome.why;
        if (decision.category === "opens-dialog" && decision.conditional === "dialog-must-open" && !(await readState(page)).dialogs.some((d) => d.kind === "dialog")) {
          state.halted = "A button that should open a dialog did not, so the capture stopped before anything else was clicked.";
          record.note = state.halted;
          return false;
        }
        return true;
      }
      if (!(await leaveIfOutside(record))) return false;
    }
    if (!tries && record.blocked) record.note = `blocked: ${record.blocked.reason}`;
    return false;
  }

  /**
   * The open dialog is the plain one a step expects: exactly one dialog, and every control in it is one of the allowed names. A dialog
   * with a choice (a channel, an audience, a checkbox, a field), an alert, or any other button is not the expected one, and nothing is clicked.
   */
  async function runVerifyDialogControls(step, record) {
    const allowed = new Set((step.expect.dialogControls || []).map((n) => normalizeControlName(n)));
    const required = (step.expect.dialogRequired || []).map((n) => normalizeControlName(n));
    const deadline = now() + (step.timeoutMs ?? 6000);
    for (;;) {
      let seen = null;
      for (const frame of framesOf(page)) {
        try {
          const found = await frame.evaluate(dialogControlsInPage);
          if (found?.dialogs) seen = { dialogs: (seen?.dialogs || 0) + found.dialogs, controls: [...(seen?.controls || []), ...found.controls], alerts: (seen?.alerts || 0) + found.alerts };
        } catch (err) {
          if (isBrowserClosedError(err)) throw err;
        }
      }
      if (seen && seen.dialogs === 1) {
        const names = seen.controls.map((c) => normalizeControlName(c.name));
        const unknown = seen.controls.filter((c) => c.kind === "choice" || !allowed.has(normalizeControlName(c.name)));
        const missing = required.filter((n) => !names.includes(n));
        if (!unknown.length && !missing.length && !seen.alerts) {
          record.effect = "the dialog is the plain one";
          return true;
        }
        record.note = unknown.length ? "the dialog has a control the computer does not know, so it was not confirmed" : seen.alerts ? "the dialog shows a warning, so it was not confirmed" : "the dialog is not the one expected";
        trace?.event("dialog-not-plain", { step: step.id, controls: seen.controls.length, unknown: unknown.length, alerts: seen.alerts, missing: missing.length });
      } else if (seen) record.note = seen.dialogs ? "more than one dialog is open, so nothing was confirmed" : "the expected dialog is not open";
      if (now() >= deadline) return false;
      await sleep(250);
    }
  }

  /** A control that must be on the page (and, for a tab, selected) without touching it: how a walkthrough proves it is on the screen it expects. */
  async function runVerify(step, record) {
    if (step.expect?.dialogControls) return runVerifyDialogControls(step, record);
    const deadline = now() + (step.timeoutMs ?? 6000);
    const names = targetNames(step.target);
    const roles = step.target?.role ? [step.target.role] : ROLES_FOR.verify;
    for (;;) {
      for (const strategy of ["role-exact", "role-name"]) {
        const located = await locatorsForStrategy(page, strategy, { action: "verify" }, { names, roles });
        for (const item of located) {
          let visible = false;
          try {
            visible = await item.locator.isVisible();
          } catch (err) {
            if (isBrowserClosedError(err)) throw err;
          }
          if (!visible) continue;
          const desc = await describeLocator(item.locator);
          if (!desc || !fitsArea(desc, step.target?.within || "any")) continue;
          if (step.expect?.selected && !desc.selected && !desc.expanded) continue;
          if (step.expect?.disabled && !desc.disabled) continue;
          record.strategy = strategy;
          record.effect = "it is showing";
          return true;
        }
      }
      if (now() >= deadline) {
        record.note = step.expect?.selected ? "the expected tab is not the one open" : step.expect?.disabled ? "the control is still available, so nothing was saved yet" : "the expected control is not on the page";
        return false;
      }
      await sleep(250);
    }
  }

  async function removableItems() {
    let total = 0;
    for (const frame of framesOf(page)) total += (await frame.evaluate(removableItemsInPage).catch(() => 0)) || 0;
    return total;
  }

  async function runWaitFor(step, record) {
    const deadline = now() + (step.timeoutMs ?? 8000);
    for (;;) {
      const current = await readState(page);
      const verdict = effectSatisfied({ ...(step.expect || {}) }, { ...current, changes: null, dialogs: [] }, current);
      const textOk = !step.expect?.text?.length || (await textsVisible(step.expect.text));
      const absentOk = !step.expect?.absent?.length || !(await anyTextVisible(step.expect.absent));
      const dialogOk = !step.expect?.dialog || current.dialogs.some((d) => d.kind === "dialog" || d.kind === "menu");
      const removableOk = !step.expect?.removable || (await removableItems()) > 0;
      // The opposite: nothing is open any more (a dialog was confirmed and closed).
      const closedOk = !step.expect?.noDialog || !current.dialogs.some((d) => d.kind === "dialog" || d.kind === "menu");
      if (textOk && absentOk && dialogOk && closedOk && removableOk && (verdict.ok || !step.expect?.urlPath)) {
        record.effect = "the expected result is on the page";
        return true;
      }
      if (now() >= deadline) {
        record.note = "the expected result did not appear";
        return false;
      }
      await sleep(200);
    }
  }

  async function runWaitAnswer(step, record) {
    const root = state.chatRoot;
    const deadline = now() + (step.timeoutMs ?? answerMs);
    let last = -1;
    let stable = 0;
    let grew = false;
    for (;;) {
      let read = { length: 0, working: 0 };
      try {
        read = root ? await root.evaluate(conversationInPage) : await page.evaluate(conversationInPage, null);
      } catch (err) {
        if (isBrowserClosedError(err)) throw err;
      }
      grew = grew || read.length > state.lenAtSend + 8;
      if (grew && read.working === 0 && read.length === last) {
        stable += 150;
        if (stable >= answerStableMs) {
          record.effect = "the answer finished";
          return true;
        }
      } else stable = 0;
      last = read.length;
      if (now() >= deadline) {
        record.note = grew ? "the answer was still streaming when time ran out" : "no answer appeared";
        return false;
      }
      await sleep(150);
    }
  }

  async function runPress(step, record) {
    const before = await readState(page);
    if (step.key === "Enter") {
      const active = await page.evaluate(() => document.activeElement && document.activeElement.tagName).catch(() => "");
      if (!state.lastInput || !active) return false;
    }
    await page.keyboard.press(step.key);
    const effect = await waitForEffect({ ...step, timeoutMs: 1500 }, before, null);
    record.effect = effect.why;
    return effect.ok || step.key === "Escape";
  }

  async function runClose(step, record) {
    const before = await readState(page);
    if (!before.dialogs.some((d) => d.kind === "dialog" || d.kind === "menu" || d.kind === "panel")) {
      record.effect = "nothing was open";
      return true;
    }
    const names = targetNames(step.target).length ? targetNames(step.target) : ["Cancel", "Close", "Dismiss", "Not now", "No thanks", "Close dialog"];
    const closer = { ...step, action: "close", target: { role: step.target?.role, name: names[0], alt: names.slice(1), within: "dialog" }, expect: { absent: [] } };
    if (await runTargetedStep({ ...closer, expect: undefined }, record)) {
      const after = await readState(page);
      if (after.dialogs.length < before.dialogs.length || !after.dialogs.some((d) => d.kind === "dialog")) return true;
    }
    // No button worked: Escape closes most dialogs and menus.
    await page.keyboard.press("Escape").catch(() => {});
    await sleep(300);
    const after = await readState(page);
    record.effect = after.dialogs.length < before.dialogs.length ? "closed with Escape" : "";
    return after.dialogs.length < before.dialogs.length;
  }

  /** Whether a control like this is already on the page (so a step that would open it can be skipped). */
  async function presentNow(target) {
    const names = targetNames(target);
    if (!names.length) return false;
    const roles = target.role ? [target.role] : ROLES_FOR.click;
    for (const strategy of ["role-exact", "role-name"]) {
      const located = await locatorsForStrategy(page, strategy, { action: "click" }, { names, roles });
      for (const item of located) {
        let visible = false;
        try {
          visible = await item.locator.isVisible();
        } catch (err) {
          if (isBrowserClosedError(err)) throw err;
        }
        if (!visible) continue;
        const desc = await describeLocator(item.locator);
        if (desc && fitsArea(desc, target.within || "any")) return true;
      }
    }
    return false;
  }

  async function runReveal(step, record) {
    const revealStep = { ...step, action: "reveal" };
    if (await runTargetedStep(revealStep, record)) return true;
    if (record.blocked) return false;
    // A label that is plain text (a heading) counts as showing when its words are on the page.
    for (const name of targetNames(step.target)) {
      if (await textVisible(name)) {
        record.strategy = "text";
        record.effect = "already showing";
        return true;
      }
    }
    return false;
  }

  /** Run one step with retries and backoff. Returns the record of what happened. */
  async function runStep(step) {
    const record = { id: step.id, action: step.action, tier: step.tier ?? 0, status: "failed", strategy: "", attempts: [], note: "", effect: "", ms: 0, blocked: null, summary: step.note };
    const started = now();
    const retries = step.retries ?? (step.action === "wait-answer" ? 0 : 1);
    if (!step.cleanup) ctx.onProgress?.(step.say || progressPhrase(step));
    // Never act on a sign-in page (no clicks, typing, or navigation): the person is signing in, and the sign-in check handles it.
    if (!step.cleanup && classifyUrl(typeof page.url === "function" ? page.url() : "").kind === "sign-in") {
      record.note = "the page is a sign-in page, so the computer does not touch it";
      record.effect = "sign-in-page";
      record.ms = now() - started;
      trace?.event("step-skipped-on-sign-in", { step: step.id, action: step.action });
      return record;
    }
    if (step.skipIfPresent && (await presentNow(step.skipIfPresent))) {
      record.status = "ok";
      record.effect = "already there";
      record.ms = now() - started;
      return record;
    }
    const findBudgetMs = step.findMs ?? (step.optional ? 2500 : ctx.findMs ?? 7000);
    for (let attempt = 0; ; attempt += 1) {
      await dismissInterruptions();
      let ok = false;
      const attemptsBefore = record.attempts.length;
      switch (step.action) {
        case "wait-for":
          ok = await runWaitFor(step, record);
          break;
        case "verify":
          ok = await runVerify(step, record);
          break;
        case "wait-answer":
          ok = await runWaitAnswer(step, record);
          break;
        case "press":
          ok = await runPress(step, record);
          break;
        case "scroll":
          ok = true;
          await page.mouse?.wheel?.(0, 200).catch(() => {});
          break;
        case "close":
        case "discard":
          ok = await runClose(step, record);
          break;
        case "reveal":
          ok = await runReveal(step, record);
          break;
        case "send":
          ok = step.target?.name ? await runTargetedStep(step, record) : false;
          if (!ok && !record.blocked && !state.halted) ok = await sendWithEnter(step, record);
          break;
        default:
          ok = await runTargetedStep(step, record);
      }
      if (state.halted) break;
      if (ok) {
        record.status = "ok";
        break;
      }
      // Only a step that was blocked on purpose is not worth another look.
      if (record.blocked && !record.attempts.some((a) => a.tried)) break;
      // A control that is not on the page yet (a skeleton, a slow panel) is waited for, for a bounded time; one that was there but did nothing is tried again a couple of times.
      const lookedAt = record.attempts.slice(attemptsBefore);
      const nothingThere = ["open-nav", "select-tab", "reveal", "expand", "open-item", "open", "choose", "click", "confirm", "create", "close", "discard", "type", "send", "hover", "switch-experience"].includes(step.action) && lookedAt.length > 0 && lookedAt.every((a) => a.found === 0);
      if (nothingThere) {
        if (now() - started >= findBudgetMs || ctx.shouldStop?.()) break;
        await sleep(500);
        continue;
      }
      if (attempt >= retries) break;
      await sleep(400 * 2 ** attempt);
    }
    record.attempts = record.attempts.slice(-10);
    record.ms = now() - started;
    return record;
  }

  async function sendWithEnter(step, record) {
    if (!state.lastInput) {
      record.note = "there is no message to send";
      return false;
    }
    const before = await readState(page);
    state.lenAtSend = await conversationLength();
    // A send button next to the field is the usual way; Enter is the fallback.
    const desc = await describeLocator(state.lastInput);
    const decision = gate({ ...step, action: "send" }, desc ? { ...desc, name: "Send", role: "button" } : null);
    trace?.event("gate", { shot, step: step.id, action: "send", tier: decision.tier, category: decision.category, allowed: decision.allowed, denied: decision.denied || "", strategy: "enter", role: "textbox" });
    if (!decision.allowed || !desc?.inTestPane) {
      record.blocked = { category: decision.category, denied: decision.denied || "not-test-pane", tier: decision.tier, reason: "Enter is only pressed in the test pane." };
      return false;
    }
    await state.lastInput.press("Enter", { timeout: stepTimeoutMs });
    const effect = await waitForEffect({ ...step, timeoutMs: 3000 }, before, null);
    record.strategy = "enter";
    record.effect = effect.why;
    // Enter that left the message in the field did not send it.
    if (effect.ok && !(await inputIsEmpty(state.lastInput))) {
      record.note = "the message is still in the field after Enter";
      return false;
    }
    return effect.ok;
  }

  /**
   * Run a list of steps in order. An optional step that fails is skipped; a required one ends the run.
   * @returns {Promise<{ok: boolean, steps: object[], failed: object|null, halted: string|null, blocked: object[], diagnostic: object|null}>}
   */
  async function run(steps) {
    attachPageGuards(page, { trace });
    const records = [];
    let failed = null;
    let diagnostic = null;
    for (const step of steps) {
      if (state.halted) break;
      if (ctx.shouldStop?.()) {
        failed = { id: step.id, action: step.action, why: "the capture was stopped", code: "cancelled" };
        break;
      }
      if (!hostOk()) {
        failed = { id: step.id, action: step.action, why: "the page is not on one of the product's own sites", code: "left-allowed-site" };
        break;
      }
      if (!step.cleanup && (await checkUnexpectedPrompt())) break;
      const record = await runStep(step);
      records.push(record);
      trace?.event("setup-step", { shot, step: step.id, action: step.action, status: record.status, strategy: record.strategy, tier: record.tier, attempts: record.attempts.length, ms: record.ms });
      if (!step.cleanup && !state.halted) await checkUnexpectedPrompt();
      if (state.halted) break;
      // The first time a step opens a dialog while building from scratch, its control names are kept locally (names only), so a recipe can be taught what the real dialog holds.
      if (record.status === "ok" && step.expect?.dialog && ctx.autonomy?.scratch && !state.observed.has(step.id)) {
        state.observed.add(step.id);
        await writeDiagnostic({ page, home, step, attempts: [], product, shot, terms, companion, cause: "observed" }).catch(() => {});
      }
      if (record.status !== "ok") {
        if (step.optional) {
          record.status = "skipped";
          continue;
        }
        const code = record.blocked && !record.attempts.some((a) => a.tried) ? (record.blocked.denied === "needs-practice" ? "needs-practice" : record.blocked.denied === "stopped" ? "cancelled" : "blocked") : "step-failed";
        failed = { id: step.id, action: step.action, why: record.note || (record.blocked ? record.blocked.reason : "the control was not found or did nothing"), code, blockedBy: record.blocked?.category || "" };
        if (code === "step-failed" || code === "blocked") {
          const written = await writeDiagnostic({ page, home, step, attempts: record.attempts, product, shot, timings: { stepMs: record.ms }, terms, companion, cause: code }).catch(() => ({ file: null, bundle: null }));
          diagnostic = written;
        }
        break;
      }
    }
    const haltCode = state.haltKind === "write-limit" ? "write-limit" : String(state.haltKind || "").startsWith("unexpected-") ? "unexpected-prompt" : "unexpected-effect";
    return { ok: !failed && !state.halted, steps: records, failed: state.halted ? { id: records.at(-1)?.id || "", action: records.at(-1)?.action || "", why: state.halted, code: haltCode } : failed, halted: state.halted, haltKind: state.haltKind, blocked: state.blocked.slice(0, 12), diagnostic };
  }

  /** Close what the steps opened, so the next screen starts clean. Never throws. `left` is how many dialogs or menus are still open. */
  async function cleanup() {
    try {
      await dismissInterruptions();
      const open = (await readState(page)).dialogs.filter((d) => d.kind === "dialog" || d.kind === "menu");
      if (!open.length) return { closed: false, left: 0 };
      const record = await runStep({ id: "cleanup", action: "close", intent: "close", tier: 1, cleanup: true, note: "Closed it with Cancel" });
      const left = (await readState(page)).dialogs.filter((d) => d.kind === "dialog" || d.kind === "menu").length;
      return { closed: record.status === "ok", left };
    } catch (err) {
      if (err instanceof BrowserClosedError || classifyBrowserError(err) === "browser-closed") throw err;
      return { closed: false, left: 0 };
    }
  }

  /** Make the screen quiet for the picture: no caret, no hover tooltip, nothing focused. */
  async function prepareForCapture({ keepPointer = false } = {}) {
    try {
      await page.evaluate(() => {
        const active = document.activeElement;
        if (active && active !== document.body && typeof active.blur === "function") active.blur();
      });
      if (!keepPointer) await page.mouse?.move?.(0, 0);
    } catch (err) {
      if (isBrowserClosedError(err)) throw err;
    }
  }

  return { run, runStep, cleanup, prepareForCapture, dismissInterruptions, state };
}
