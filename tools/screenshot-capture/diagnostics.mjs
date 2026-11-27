// When a setup step cannot be completed, this writes a small file that says why, without anything private: the
// roles and names of the visible controls around the step, the address's host and path (ids masked), the step and
// the strategies that were tried, and the timings. No cookies, no page text, no query strings, no account or
// tenant names. The person can attach it to a report; `--diagnose` writes the same file for the page that is
// open in a live browser.

import fs from "node:fs";
import path from "node:path";

import { normalizeControlName } from "./guard.mjs";
import { scrubSensitiveText } from "./redact.mjs";
import { maskedPath } from "./targets.mjs";
import { redactTraceText } from "./trace.mjs";

export const DIAGNOSTIC_VERSION = 1;
const MAX_CONTROLS = 60;

/** Runs in each frame (it must stay self-contained): the visible interactive controls, by role and name only. */
export function interactiveControlsInPage(max) {
  const selector = 'button, a[href], [role=button], [role=link], [role=tab], [role=menuitem], [role=menuitemradio], [role=treeitem], [role=option], [role=radio], [role=checkbox], [role=switch], input:not([type=hidden]), textarea, select, summary, [contenteditable=""], [contenteditable=true]';
  const out = [];
  const roleOf = (el) => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.toLowerCase();
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const type = String(el.getAttribute("type") || "text").toLowerCase();
      return type === "checkbox" ? "checkbox" : type === "radio" ? "radio" : type === "search" ? "searchbox" : type === "button" || type === "submit" ? "button" : "textbox";
    }
    return "generic";
  };
  const areaOf = (el) => (el.closest("dialog, [role=dialog], [role=alertdialog], [aria-modal=true]") ? "dialog" : el.closest("nav, [role=navigation], [role=tablist], [role=tree], [role=menu]") ? "nav" : el.closest("header, [role=banner]") ? "header" : el.closest("main, [role=main]") ? "main" : "other");
  // The heading of the card or panel a control sits in (the nearest ancestor that holds one): which of two look-alike boxes it is.
  const sectionOf = (el) => {
    for (let node = el.parentElement; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
      const heading = node.querySelector("h1, h2, h3, h4, h5, h6, [role=heading]");
      if (heading && !heading.contains(el)) return String(heading.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40);
    }
    return "";
  };
  for (const el of document.querySelectorAll(selector)) {
    if (out.length >= max) break;
    if (el.closest("[data-capture-ui]")) continue;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (rect.width < 4 || rect.height < 4 || style.visibility === "hidden" || style.display === "none") continue;
    const labelledBy = String(el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean).map((id) => (document.getElementById(id) || {}).textContent || "").join(" ");
    const name = el.getAttribute("aria-label") || labelledBy || (el.tagName === "INPUT" || el.tagName === "TEXTAREA" ? "" : el.innerText || el.textContent) || el.getAttribute("title") || el.getAttribute("placeholder") || "";
    out.push({
      role: roleOf(el),
      name: String(name).replace(/\s+/g, " ").trim().slice(0, 80),
      area: areaOf(el),
      section: sectionOf(el),
      disabled: Boolean(el.disabled) || el.getAttribute("aria-disabled") === "true",
      selected: el.getAttribute("aria-selected") === "true" || el.getAttribute("aria-expanded") === "true" || (Boolean(el.getAttribute("aria-current")) && el.getAttribute("aria-current") !== "false"),
      x: Math.round(rect.left / 40),
      y: Math.round(rect.top / 40),
    });
  }
  const dialogs = [];
  for (const el of document.querySelectorAll("dialog[open], [role=dialog], [role=alertdialog], [aria-modal=true]")) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 20 || rect.height < 20 || el.hasAttribute("hidden")) continue;
    dialogs.push(String(el.getAttribute("aria-label") || (el.querySelector("h1,h2,h3,[role=heading]") || {}).textContent || "").replace(/\s+/g, " ").trim().slice(0, 60));
  }
  return { controls: out, dialogs: dialogs.slice(0, 4) };
}

const PERSONAL_NAME_PATTERNS = Object.freeze([
  [/^(.*?\b(?:account|profile|user)\b.*?\bfor)\s+.+$/i, "$1 {name}"],
  [/^(.*?\((?:current|selected|signed in as)\s*:?)\s*.+\)$/i, "$1 {name})"],
  [/^(.*?\bsigned in as)\s+.+$/i, "$1 {name}"],
]);

/**
 * Product menus name the signed-in person or the environment in the control's label ("Open account menu for <person>",
 * "Switch environment (current: <name>)"). Those labels are kept without the name, so a diagnostic never carries it.
 */
export function genericControlName(raw) {
  for (const [pattern, replacement] of PERSONAL_NAME_PATTERNS) {
    if (pattern.test(raw)) return raw.replace(pattern, replacement);
  }
  return raw;
}

/** A control name is only kept when it is a UI label: never an address, an email, an id, or a long number. */
export function cleanControlName(name, terms = []) {
  const raw = genericControlName(String(name ?? "").replace(/\s+/g, " ").trim());
  // A name that contained anything sensitive (an account, a tenant, a term to hide) is not a UI label: leave it out whole.
  if (!raw || scrubSensitiveText(raw, terms) !== raw) return "";
  if (/[^\s@]+@[^\s@]+/.test(raw) || /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(raw) || /\d{6,}/.test(raw) || /https?:\/\//i.test(raw)) return "";
  return raw.slice(0, 60);
}

/** The bundle from what was seen: pure, so a test can check that nothing private survives. */
export function buildDiagnosticBundle({ url = "", frames = [], step = null, attempts = [], product = "", shot = "", timings = {}, terms = [], companion = "", cause = "" } = {}) {
  let host = "";
  try {
    host = new URL(url).host.replace(/^[^.]*-admin\./, "{tenant}-admin.").replace(/^(?!\{tenant\})[^.]+(?=\.sharepoint\.com$)/, "{tenant}");
  } catch {
    host = "";
  }
  const controls = [];
  const dialogs = [];
  for (const frame of frames) {
    for (const c of frame.controls || []) {
      if (controls.length >= MAX_CONTROLS) break;
      const name = cleanControlName(c.name, terms);
      controls.push({ role: String(c.role || "").slice(0, 20), name, area: String(c.area || "").slice(0, 10), ...(c.section ? { section: cleanControlName(c.section, terms) } : {}), ...(c.disabled ? { disabled: true } : {}), ...(c.selected ? { selected: true } : {}), frame: frame.index || 0 });
    }
    for (const title of frame.dialogs || []) {
      const clean = cleanControlName(title, terms);
      if (clean) dialogs.push(clean);
    }
  }
  return {
    version: DIAGNOSTIC_VERSION,
    createdAt: new Date().toISOString(),
    companion: String(companion).slice(0, 20),
    product: String(product).slice(0, 60),
    shot: String(shot).slice(0, 128),
    cause: String(cause).slice(0, 40),
    page: { host, path: maskedPath(url).split("/").slice(1).map((s) => redactTraceText(s, terms)).join("/") },
    step: step
      ? {
          id: String(step.id || "").slice(0, 24),
          action: String(step.action || "").slice(0, 24),
          tier: Number.isInteger(step.tier) ? step.tier : null,
          target: step.target ? { role: step.target.role || null, name: cleanControlName(step.target.name, terms), alt: (step.target.alt || []).map((n) => cleanControlName(n, terms)).filter(Boolean), within: step.target.within || "any", ...(step.target.section ? { section: cleanControlName(step.target.section, terms) } : {}) } : null,
          expect: step.expect ? Object.keys(step.expect) : [],
        }
      : null,
    attempts: attempts.slice(0, 12).map((a) => ({
      strategy: String(a.strategy || "").slice(0, 24),
      found: Number(a.found) || 0,
      tried: Number(a.tried) || 0,
      blocked: String(a.blocked || "").slice(0, 40),
      effect: typeof a.effect === "boolean" ? a.effect : null,
      note: redactTraceText(a.note || "", terms).slice(0, 80),
      // How many controls with the step's name were there but disabled, and how many sat in another card or panel than the step names.
      ...(Number(a.disabled) ? { disabled: Number(a.disabled) } : {}),
      ...(Number(a.skippedOtherSection) ? { skippedOtherSection: Number(a.skippedOtherSection) } : {}),
      // Which text box received the typed text: its name, role, and card, whether it was in the Test panel, and whether the text read back from it.
      ...(a.typedInto && typeof a.typedInto === "object"
        ? { typedInto: { name: cleanControlName(a.typedInto.name, terms), role: String(a.typedInto.role || "").slice(0, 20), section: cleanControlName(a.typedInto.section, terms), inTestPane: a.typedInto.inTestPane === true, readback: ["ok", "mismatch", "pending"].includes(a.typedInto.readback) ? a.typedInto.readback : "pending", length: Number(a.typedInto.length) || 0 } }
        : {}),
    })),
    timings: Object.fromEntries(Object.entries(timings).slice(0, 12).map(([k, v]) => [String(k).slice(0, 24), Number(v) || 0])),
    dialogs: dialogs.slice(0, 4),
    controls,
  };
}

/** Read the visible controls of every frame of a live page. */
export async function readFrames(page, { max = MAX_CONTROLS } = {}) {
  const frames = [];
  const list = typeof page?.frames === "function" ? page.frames() : [page];
  for (const [index, frame] of list.slice(0, 6).entries()) {
    try {
      const read = await frame.evaluate(interactiveControlsInPage, max);
      frames.push({ index, controls: read.controls, dialogs: read.dialogs });
    } catch {
      // A frame that is gone or cross-origin and closed contributes nothing.
    }
  }
  return frames;
}

/** Collect and write the diagnostic bundle for a page. Returns `{file, bundle}`; the file is null when it could not be written. */
export async function writeDiagnostic({ page, home, step = null, attempts = [], product = "", shot = "", timings = {}, terms = [], companion = "", cause = "", now = () => Date.now() } = {}) {
  const frames = await readFrames(page);
  const bundle = buildDiagnosticBundle({ url: typeof page?.url === "function" ? page.url() : "", frames, step, attempts, product, shot, timings, terms, companion, cause });
  if (!home) return { file: null, bundle };
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, "-");
  const base = normalizeControlName(shot || "page").replace(/\s+/g, "-").slice(0, 60) || "page";
  const file = path.join(home, ".captures", "diagnostics", `${base}-${stamp}.json`);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600 });
    return { file, bundle };
  } catch {
    return { file: null, bundle };
  }
}

/** The one sentence that tells the person what to do with the file. */
export function diagnosticAdvice(file) {
  return file ? `A diagnostic file with only control names and page paths was saved: ${file}. Attach it to a report so the step can be fixed.` : "A diagnostic could not be saved.";
}
