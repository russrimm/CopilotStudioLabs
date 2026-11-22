// Masks account details and draws numbered callout markers on the live page,
// right before the companion takes a screenshot. Everything here is an overlay
// drawn on top of the page (nothing is typed, clicked, or edited in the tenant
// UI) and every overlay is removed again after the screenshot.

/** Controls that show who is signed in: the Microsoft 365 account manager, profile pictures, persona badges. */
export const ACCOUNT_CONTROL_SELECTORS = Object.freeze([
  "#O365_MainLink_Me",
  "#meControl",
  "#mectrl_main_trigger",
  "[id^='mectrl_']",
  "[data-testid='mectrl_headerPicture']",
  "[data-id='mectrl_headerPicture']",
  "[data-automation-id='meControl']",
  "[data-testid='AccountManager']",
  "[data-testid='account-manager']",
  "[data-testid*='persona' i]",
  "button[aria-label*='Account manager' i]",
  "[aria-label^='Account manager for']",
  "[aria-label^='Open account menu' i]",
  // The environment picker's label carries the environment's name ("Switch environment (current: <name>)").
  "[aria-label^='Switch environment' i]",
  "[aria-label*='current environment' i]",
  "button[aria-label*='profile' i][aria-label*='account' i]",
  "img[alt*='profile picture' i]",
  "[class*='userPhoto' i]",
  "[class*='AccountManager' i]",
  "[class*='ProfileButton' i]",
]);

/** Regular-expression sources (kept as strings so they can be sent into the page). */
export const UPN_SOURCE = "[A-Za-z0-9._%+'-]{1,64}@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)+";
export const TENANT_SOURCE = "[A-Za-z0-9-]+\\.onmicrosoft\\.com|[A-Za-z0-9-]+-admin\\.sharepoint\\.com|[A-Za-z0-9-]+-my\\.sharepoint\\.com";

const escapeRe = (term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One regular expression covering email addresses, tenant host names, and any extra terms to hide. */
export function buildSensitiveRegExp(terms = []) {
  const extra = terms.map((t) => String(t || "").trim()).filter((t) => t.length >= 3).map(escapeRe);
  return new RegExp([UPN_SOURCE, TENANT_SOURCE, ...extra].join("|"), "gi");
}

/** The pieces of `text` that must be hidden. */
export function findSensitiveSpans(text, terms = []) {
  const re = buildSensitiveRegExp(terms);
  const spans = [];
  const value = String(text ?? "");
  let match;
  while ((match = re.exec(value)) !== null) {
    spans.push({ start: match.index, end: match.index + match[0].length, text: match[0] });
    if (match[0].length === 0) re.lastIndex += 1;
  }
  return spans;
}

/** A greeting that names the signed-in person ("Hey Ada, ready to ...", "Welcome, Ada!", "Hello, Ada", "Good morning, Ada"): group 1 is the name. */
export const GREETING_SOURCE = "\\b(?:[Hh]ey|[Hh]i|[Hh]ello|[Ww]elcome(?: back)?|[Gg]ood (?:morning|afternoon|evening)),?\\s+(\\p{Lu}[\\p{L}'’.-]*(?:\\s+\\p{Lu}[\\p{L}'’.-]*)?)(?=\\s*[,!.?]|\\s*$)";

/** An account chip whose whole text names the person: "Work Ada", "Personal Ada Lovelace", "School Ada". */
export const ACCOUNT_CHIP_SOURCE = "^(?:Work|Personal|School)\\s+\\p{Lu}[\\p{L}'’.-]*(?:\\s+\\p{Lu}[\\p{L}'’.-]*)?$";

/** A license or plan chip beside the account ("M365 Copilot (Premium)", "Copilot (Pro)"). */
export const PLAN_CHIP_SOURCE = "^.{0,40}\\((?:Premium|Pro|Free|Basic|Plus|Business|Enterprise|Standard|Trial)\\)$";

/** An environment display name as the Power Platform shows it ("Contoso (default)"). */
export const ENVIRONMENT_NAME_SOURCE = "^.{1,60}\\s\\([Dd]efault\\)$";

/** The heading of a list of a person's own items or chats: Recent, Your recent, Last opened, Pinned, Chat history, the dated groups of a history. */
export const LIST_HEADING_SOURCE = "^(?:recents?|your recent(?: \\w+)?|recent (?:chats|agents|apps|items|files|conversations|searches)|recently (?:opened|used|visited)|last opened|pinned(?: chats| agents| items)?|chat history|conversation history|your chats|chats|conversations|yesterday|previous \\d+ days|last \\d+ days|earlier)$";

/** Replace anything sensitive in a string (used before text is sent to the portal as evidence). */
export function scrubSensitiveText(text, terms = []) {
  return String(text ?? "")
    .replace(buildSensitiveRegExp(terms), "[hidden]")
    .replace(new RegExp(GREETING_SOURCE, "gu"), (whole, name) => `${whole.slice(0, whole.lastIndexOf(name))}[hidden]`)
    .replace(new RegExp(ACCOUNT_CHIP_SOURCE, "u"), "[hidden]")
    .replace(new RegExp(ENVIRONMENT_NAME_SOURCE, "u"), "[hidden]");
}

/**
 * Runs inside the page. Draws a solid block over every account control, over every piece of visible text that matches `pattern`, and
 * over the personal text a page shows beside the product: the name in a greeting ("Welcome, Ada!"), an account chip ("Work Ada"), a
 * license chip ("M365 Copilot (Premium)"), the environment's display name, a profile picture or initials avatar, and the items of
 * lists of the person's own things (Recent, Last opened, Pinned, chat history): the item text is covered and the layout stays.
 * Returns what it found and covered. It must stay self-contained: Playwright serializes it into the browser.
 */
export function maskSensitiveInPage({ selectors, pattern, flags, greetingSource, chipSource, planSource, environmentSource, listHeadingSource }) {
  const FILL = "#6b7280";
  let masked = 0;
  let controls = 0;
  let texts = 0;
  let lists = 0;
  let listsMasked = 0;
  const HEADER = 150;
  const overlay = (rect, kind) => {
    if (!rect || rect.width < 2 || rect.height < 2) return false;
    if (rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth) return false;
    const block = document.createElement("div");
    block.setAttribute("data-capture-overlay", kind);
    block.setAttribute("aria-hidden", "true");
    block.style.cssText =
      `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;` +
      `background:${FILL};z-index:2147483647;pointer-events:none;border-radius:4px;`;
    document.documentElement.appendChild(block);
    masked += 1;
    return true;
  };
  const coverNode = (node, start, end) => {
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    let drawn = false;
    for (const rect of range.getClientRects()) drawn = overlay(rect, "text") || drawn;
    return drawn;
  };
  const visible = (rect) => rect.width > 0 && rect.height > 0;
  const small = (rect) => rect.width * rect.height < innerWidth * innerHeight * 0.4;

  const marked = new Set();
  for (const selector of selectors) {
    let nodes;
    try {
      nodes = document.querySelectorAll(selector);
    } catch {
      continue;
    }
    for (const node of nodes) {
      const rect = node.getBoundingClientRect();
      if (visible(rect) && small(rect) && !marked.has(node)) {
        marked.add(node);
        overlay(rect, "control");
        controls += 1;
      }
    }
  }

  // A profile picture or an initials avatar near the top right: a small round or square button, an image, or one to three letters.
  const everything = Array.from(document.querySelectorAll("button,[role='button'],a,div,span,img")).slice(0, 4000);
  for (const node of everything) {
    const rect = node.getBoundingClientRect();
    if (!visible(rect) || rect.top > 110 || rect.right < innerWidth - 240 || rect.width < 18 || rect.width > 64 || rect.height < 18 || rect.height > 64 || Math.abs(rect.width - rect.height) > 6) continue;
    if ([...marked].some((m) => m.contains(node) || node.contains(m))) continue;
    const style = getComputedStyle(node);
    const radius = parseFloat(style.borderTopLeftRadius) || 0;
    const round = /%/.test(style.borderTopLeftRadius) ? radius >= 40 : radius >= Math.min(rect.width, rect.height) * 0.4;
    const initials = /^[\p{L}]{1,3}$/u.test((node.textContent || "").trim()) && node.children.length === 0;
    const picture = node.tagName === "IMG" || (style.backgroundImage && style.backgroundImage !== "none");
    const isButton = node.tagName === "BUTTON" || node.getAttribute("role") === "button";
    if ((round && (initials || picture)) || (initials && isButton)) {
      marked.add(node);
      overlay(rect, "control");
      controls += 1;
    }
  }

  const re = new RegExp(pattern, flags);
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const parent = node.parentElement;
    if (!parent || /^(?:SCRIPT|STYLE|NOSCRIPT|TEXTAREA)$/.test(parent.tagName)) continue;
    if (node.nodeValue && node.nodeValue.trim()) nodes.push(node);
  }
  for (const node of nodes) {
    const value = node.nodeValue;
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(value)) !== null) {
      if (coverNode(node, match.index, match.index + match[0].length)) texts += 1;
      if (match[0].length === 0) re.lastIndex += 1;
    }
  }
  for (const input of document.querySelectorAll("input, textarea")) {
    re.lastIndex = 0;
    if (input.value && re.test(String(input.value))) {
      overlay(input.getBoundingClientRect(), "input");
      texts += 1;
    }
  }
  // A greeting that names the signed-in person ("Hey Ada, ready to ..."): the name is covered, the rest stays.
  const greeting = new RegExp(greetingSource, "gu");
  for (const node of nodes) {
    const value = node.nodeValue;
    greeting.lastIndex = 0;
    let match;
    while ((match = greeting.exec(value)) !== null) {
      const at = match.index + match[0].lastIndexOf(match[1]);
      if (coverNode(node, at, at + match[1].length)) texts += 1;
    }
  }

  // Chips beside the account: the whole short text names the person, the plan, or the environment, so all of it is covered.
  const chip = new RegExp(chipSource, "u");
  const plan = new RegExp(planSource, "u");
  const environment = new RegExp(environmentSource, "u");
  for (const node of nodes) {
    const text = node.nodeValue.trim();
    if (text.length > 64) continue;
    const top = node.parentElement.getBoundingClientRect().top;
    if ((chip.test(text) && top < HEADER) || (plan.test(text) && top < HEADER + 60) || (environment.test(text) && top < HEADER)) {
      if (coverNode(node, 0, node.nodeValue.length)) texts += 1;
    }
  }

  // Lists of the person's own items: cover the item text and keep the layout (the heading, the rows, and the spacing stay).
  const headingRe = new RegExp(listHeadingSource, "i");
  const HEADING_TAG = /^H[1-6]$/;
  const isHeading = (el) => HEADING_TAG.test(el.tagName) || el.getAttribute("role") === "heading";
  const KEEP = /^(?:see all|view all|show more|show less|more|clear|new chat|new agent|search|filter)$/i;
  const coverTexts = (container, from, stopAtHeading = true) => {
    let found = 0;
    let drawn = false;
    let started = !from;
    const inner = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    while (inner.nextNode()) {
      const node = inner.currentNode;
      const value = node.nodeValue;
      if (!value || !value.trim()) continue;
      if (!started) {
        if (node === from) started = true;
        continue;
      }
      const parent = node.parentElement;
      if (!parent || /^(?:SCRIPT|STYLE|NOSCRIPT|TEXTAREA)$/.test(parent.tagName)) continue;
      if (stopAtHeading && parent !== from.parentElement && isHeading(parent) && !headingRe.test(value.trim())) break;
      if (KEEP.test(value.trim())) continue;
      found += 1;
      drawn = coverNode(node, 0, value.length) || drawn;
    }
    return { found, drawn };
  };
  const IN_TABLE = "td,th,[role='cell'],[role='gridcell'],[role='columnheader']";
  for (const node of nodes) {
    if (!headingRe.test(node.nodeValue.trim())) continue;
    const heading = node.parentElement;
    // A table's own column heading and its cells are handled with the table below.
    if (heading.closest(IN_TABLE)) continue;
    let container = heading.parentElement;
    for (let up = 0; up < 4 && container && container !== document.body; up += 1) {
      const items = container.querySelectorAll("li,[role='listitem'],[role='option'],[role='treeitem'],a[href],tr,[role='row'],button");
      const count = Array.from(items).filter((el) => !heading.contains(el)).length;
      if (count >= 2) break;
      container = container.parentElement;
    }
    // A heading with no items under it (an empty Recent list) has nothing to hide. A list too big to cover safely is left, and counted as not hidden.
    const coverable = container && container !== document.body && small(container.getBoundingClientRect());
    const result = coverable ? coverTexts(container, node) : { found: 1, drawn: false };
    if (!result.found) continue;
    lists += 1;
    if (result.drawn) listsMasked += 1;
  }
  // A table that lists the person's agents or files by when they were last opened: every body cell is covered, the header stays.
  for (const table of document.querySelectorAll("table,[role='grid'],[role='table']")) {
    const heads = Array.from(table.querySelectorAll("th,[role='columnheader']"));
    if (!heads.some((h) => /^last opened$/i.test((h.textContent || "").replace(/\s+/g, " ").trim()))) continue;
    let found = 0;
    let drawn = false;
    for (const cell of table.querySelectorAll("td,[role='gridcell'],[role='cell']")) {
      const cellWalker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
      while (cellWalker.nextNode()) {
        const node = cellWalker.currentNode;
        if (node.nodeValue && node.nodeValue.trim()) {
          found += 1;
          drawn = coverNode(node, 0, node.nodeValue.length) || drawn;
        }
      }
    }
    if (!found) continue;
    lists += 1;
    if (drawn) listsMasked += 1;
  }
  // A navigation or list the page itself names as the person's recent items or chat history.
  for (const region of document.querySelectorAll("[aria-label]")) {
    if (!/\b(?:chat history|recent chats|recent items|recent agents|conversation history|pinned chats)\b/i.test(region.getAttribute("aria-label") || "")) continue;
    if (!visible(region.getBoundingClientRect()) || !small(region.getBoundingClientRect())) continue;
    const result = coverTexts(region, null, false);
    if (!result.found) continue;
    lists += 1;
    if (result.drawn) listsMasked += 1;
  }
  return { masked, controls, texts, lists, listsMasked };
}

/**
 * Runs inside the page, draws nothing: whether the page offers a Sign in button at the top and whether any account control (the account
 * manager, a profile picture, an initials avatar) is showing. Self-contained like `maskSensitiveInPage` (Playwright serializes it).
 */
export function pageSignalsInPage({ selectors }) {
  const visible = (rect) => rect.width > 0 && rect.height > 0;
  let accountControl = false;
  for (const selector of selectors) {
    let found;
    try {
      found = document.querySelectorAll(selector);
    } catch {
      continue;
    }
    for (const node of found) {
      const rect = node.getBoundingClientRect();
      if (visible(rect) && rect.width * rect.height < innerWidth * innerHeight * 0.4) accountControl = true;
    }
    if (accountControl) break;
  }
  if (!accountControl) {
    for (const node of Array.from(document.querySelectorAll("button,[role='button'],a,div,span,img")).slice(0, 4000)) {
      const rect = node.getBoundingClientRect();
      if (!visible(rect) || rect.top > 110 || rect.right < innerWidth - 240 || rect.width < 18 || rect.width > 64 || rect.height < 18 || rect.height > 64 || Math.abs(rect.width - rect.height) > 6) continue;
      const style = getComputedStyle(node);
      const radius = parseFloat(style.borderTopLeftRadius) || 0;
      const round = /%/.test(style.borderTopLeftRadius) ? radius >= 40 : radius >= Math.min(rect.width, rect.height) * 0.4;
      const initials = /^[\p{L}]{1,3}$/u.test((node.textContent || "").trim()) && node.children.length === 0;
      const picture = node.tagName === "IMG" || (style.backgroundImage && style.backgroundImage !== "none");
      const isButton = node.tagName === "BUTTON" || node.getAttribute("role") === "button";
      if ((round && (initials || picture)) || (initials && isButton)) {
        accountControl = true;
        break;
      }
    }
  }
  let signInVisible = false;
  for (const node of document.querySelectorAll("button,a,[role='button'],[role='link']")) {
    const rect = node.getBoundingClientRect();
    if (!visible(rect) || rect.top > 120) continue;
    if (/^(?:sign in|log in|sign in now)$/i.test((node.innerText || node.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim())) {
      signInVisible = true;
      break;
    }
  }
  return { signInVisible, accountControl };
}

/** Runs inside the page: draws an outline and a numbered badge for each resolved callout. */
export function drawCalloutMarkersInPage({ callouts, width, height }) {
  let drawn = 0;
  for (const callout of callouts) {
    if (!callout.rect) continue;
    const left = callout.rect.x * width;
    const top = callout.rect.y * height;
    const box = document.createElement("div");
    box.setAttribute("data-capture-overlay", "callout");
    box.setAttribute("aria-hidden", "true");
    box.style.cssText =
      `position:fixed;left:${left}px;top:${top}px;width:${callout.rect.w * width}px;height:${callout.rect.h * height}px;` +
      "border:2px solid #d13438;border-radius:4px;z-index:2147483646;pointer-events:none;box-sizing:border-box;";
    const badge = document.createElement("div");
    badge.textContent = String(callout.n);
    badge.style.cssText =
      "position:absolute;left:-12px;top:-12px;width:22px;height:22px;border-radius:50%;background:#d13438;color:#fff;" +
      "font:700 13px/22px Segoe UI,Arial,sans-serif;text-align:center;";
    box.appendChild(badge);
    document.documentElement.appendChild(box);
    drawn += 1;
  }
  return drawn;
}

/** Runs inside the page: removes every overlay this module drew. */
export function clearOverlaysInPage() {
  for (const node of document.querySelectorAll("[data-capture-overlay]")) node.remove();
}

/** Runs inside the page: the visible labels of controls and headings, for label matching. */
export function collectVisibleLabelsInPage() {
  const seen = new Set();
  const out = [];
  const nodes = document.querySelectorAll("[role='tab'],[role='menuitem'],[role='treeitem'],[role='heading'],button,a,h1,h2,h3,label,[aria-label]");
  for (const node of nodes) {
    const rect = node.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;
    const raw = (node.innerText || node.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
    if (!raw || raw.length > 80) continue;
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
    if (out.length >= 250) break;
  }
  return out;
}

async function everyFrame(page, fn, arg) {
  const frames = typeof page.frames === "function" ? page.frames() : [page];
  const results = [];
  for (const frame of frames) {
    try {
      results.push(await frame.evaluate(fn, arg));
    } catch {
      // A frame that navigated away or blocks scripts is skipped.
    }
  }
  return results;
}

const MASK_ARGS = (terms) => {
  const re = buildSensitiveRegExp(terms);
  return {
    selectors: [...ACCOUNT_CONTROL_SELECTORS],
    pattern: re.source,
    flags: re.flags,
    greetingSource: GREETING_SOURCE,
    chipSource: ACCOUNT_CHIP_SOURCE,
    planSource: PLAN_CHIP_SOURCE,
    environmentSource: ENVIRONMENT_NAME_SOURCE,
    listHeadingSource: LIST_HEADING_SOURCE,
  };
};

/**
 * Mask account controls, greetings, chips, avatars, lists of the person's recent items, and any email address or tenant name on the
 * page. Returns what the companion reports as evidence: whether masking ran, how much it covered, how many account controls the page
 * had, and how many list-type regions it found and covered.
 */
export async function applyRedaction(page, { terms = [] } = {}) {
  const results = await everyFrame(page, maskSensitiveInPage, MASK_ARGS(terms));
  const total = (key) => results.reduce((sum, r) => sum + Number(r?.[key] || 0), 0);
  return { applied: results.length > 0, masked: total("masked"), controls: total("controls"), lists: total("lists"), listsMasked: total("listsMasked") };
}

/**
 * What the page says about who is signed in, read without changing it: whether it offers a Sign in button at the top and whether any
 * account control (the account manager, a profile picture, an initials avatar) is showing. `signedOut` is true only when it offers
 * Sign in and shows no account: the product's own public page, not the product. Returns null when the page could not be read.
 */
export async function readPageSignals(page) {
  const frame = typeof page.mainFrame === "function" ? page.mainFrame() : page;
  let found = null;
  try {
    found = await frame.evaluate(pageSignalsInPage, { selectors: [...ACCOUNT_CONTROL_SELECTORS] });
  } catch {
    return null;
  }
  if (!found || typeof found !== "object" || typeof found.accountControl !== "boolean") return null;
  const signInVisible = found.signInVisible === true;
  return { signInVisible, accountControl: found.accountControl, signedOut: signInVisible && !found.accountControl };
}

/** Draw numbered callout markers into the page so they are part of the screenshot. */
export async function burnCalloutMarkers(page, callouts, viewport) {
  const frame = typeof page.mainFrame === "function" ? page.mainFrame() : page;
  try {
    return Number(await frame.evaluate(drawCalloutMarkersInPage, { callouts, width: viewport.width, height: viewport.height })) || 0;
  } catch {
    return 0;
  }
}

export async function clearOverlays(page) {
  await everyFrame(page, clearOverlaysInPage);
}

/** The visible labels on the page with any account detail scrubbed out. */
export async function collectVisibleLabels(page, { terms = [] } = {}) {
  const frames = typeof page.mainFrame === "function" ? [page.mainFrame()] : [page];
  let labels = [];
  for (const frame of frames) {
    try {
      labels = await frame.evaluate(collectVisibleLabelsInPage);
    } catch {
      labels = [];
    }
  }
  return (Array.isArray(labels) ? labels : []).map((l) => scrubSensitiveText(l, terms)).filter(Boolean).slice(0, 250);
}
