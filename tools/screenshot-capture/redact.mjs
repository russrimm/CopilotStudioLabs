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

/** Replace anything sensitive in a string (used before text is sent to the portal as evidence). */
export function scrubSensitiveText(text, terms = []) {
  return String(text ?? "").replace(buildSensitiveRegExp(terms), "[hidden]");
}

/**
 * Runs inside the page. Draws a solid block over every account control and over
 * every piece of visible text that matches `pattern`, and returns how many it drew.
 * It must stay self-contained: Playwright serializes it into the browser.
 */
export function maskSensitiveInPage({ selectors, pattern, flags }) {
  const FILL = "#6b7280";
  let masked = 0;
  let controls = 0;
  let texts = 0;
  const overlay = (rect, kind) => {
    if (!rect || rect.width < 2 || rect.height < 2) return;
    if (rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth) return;
    const block = document.createElement("div");
    block.setAttribute("data-capture-overlay", kind);
    block.setAttribute("aria-hidden", "true");
    block.style.cssText =
      `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;` +
      `background:${FILL};z-index:2147483647;pointer-events:none;border-radius:4px;`;
    document.documentElement.appendChild(block);
    masked += 1;
  };

  for (const selector of selectors) {
    let nodes;
    try {
      nodes = document.querySelectorAll(selector);
    } catch {
      continue;
    }
    for (const node of nodes) {
      const rect = node.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        overlay(rect, "control");
        controls += 1;
      }
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
      const range = document.createRange();
      range.setStart(node, match.index);
      range.setEnd(node, match.index + match[0].length);
      for (const rect of range.getClientRects()) overlay(rect, "text");
      texts += 1;
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
  return { masked, controls, texts };
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

/** Mask account controls and any email address or tenant name on the page. Returns what the companion reports as evidence. */
export async function applyRedaction(page, { terms = [] } = {}) {
  const re = buildSensitiveRegExp(terms);
  const results = await everyFrame(page, maskSensitiveInPage, { selectors: [...ACCOUNT_CONTROL_SELECTORS], pattern: re.source, flags: re.flags });
  const masked = results.reduce((sum, r) => sum + Number(r?.masked || 0), 0);
  return { applied: results.length > 0, masked };
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
