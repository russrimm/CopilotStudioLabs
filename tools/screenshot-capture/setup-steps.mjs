// The shape of a setup plan: the ordered, declarative steps that put a screen into the state a screenshot needs
// (open a section, open a dialog, ask the test pane a question, select a tab). The portal builds them, a person's
// recorded recipe carries them, and the companion runs them. Both sides use this one module to read them, so
// anything that does not fit the shape (a free-form selector, a coordinate, a script, a long or secret-looking text)
// is dropped before it can reach a browser.
//
// A step never holds a selector or a position: it names a control by what a person sees (its role, its name, the
// area it is in), so the same step works on a different language or layout, and a recorded recipe holds nothing
// that identifies a tenant.

import { ACTION_TIERS, TIER, checkPublicWebsite, checkTypedText, classifyControl, normalizeControlName } from "./guard.mjs";

export const SETUP_VERSION = 1;
export const MAX_SETUP_STEPS = 24;
export const MAX_NAME = 80;
export const SETUP_ACTIONS = Object.freeze(Object.keys(ACTION_TIERS));
export const TARGET_ROLES = Object.freeze(["button", "link", "tab", "menuitem", "treeitem", "option", "radio", "checkbox", "switch", "textbox", "searchbox", "combobox", "listitem", "row", "heading", "dialog", "region", "log"]);
export const TARGET_AREAS = Object.freeze(["any", "nav", "main", "header", "dialog", "tablist", "chat", "menu"]);
export const SAMPLE_KINDS = Object.freeze(["question", "search", "description", "instruction", "agentName", "instructions", "website", "outOfScope"]);
export const INTENTS = Object.freeze(["navigate", "open", "choose", "type", "send", "close", "confirm"]);
const SOURCES = Object.freeze(["recipe", "derived", "shared", "local", "builtin"]);

const clean = (value, max = MAX_NAME) => String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const safeName = (value) => {
  const text = clean(value);
  // A name is a label a person reads: never an address, an email, or an id.
  if (!text || /https?:\/\/|[^\s@]+@[^\s@]+\.[^\s@]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[<>{}]/i.test(text)) return "";
  return text;
};

/** The target of a step: what to find, never how. */
export function sanitizeTarget(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const name = safeName(raw.name);
  const alt = (Array.isArray(raw.alt) ? raw.alt : []).map(safeName).filter(Boolean).filter((n, i, all) => all.indexOf(n) === i && n !== name).slice(0, 5);
  const role = TARGET_ROLES.includes(raw.role) ? raw.role : undefined;
  const within = TARGET_AREAS.includes(raw.within) ? raw.within : "any";
  const nth = Number.isInteger(raw.nth) && raw.nth >= 0 && raw.nth <= 5 ? raw.nth : undefined;
  if (!name && !alt.length && !role) return null;
  return { ...(role ? { role } : {}), ...(name ? { name } : {}), ...(alt.length ? { alt } : {}), within, ...(nth !== undefined ? { nth } : {}) };
}

function sanitizeExpect(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out = {};
  if (raw.dialog === true || (typeof raw.dialog === "string" && safeName(raw.dialog))) out.dialog = raw.dialog === true ? true : safeName(raw.dialog);
  const text = (Array.isArray(raw.text) ? raw.text : []).map(safeName).filter(Boolean).slice(0, 4);
  if (text.length) out.text = text;
  const absent = (Array.isArray(raw.absent) ? raw.absent : []).map(safeName).filter(Boolean).slice(0, 4);
  if (absent.length) out.absent = absent;
  if (typeof raw.urlPath === "string") {
    const path = raw.urlPath.split(/[?#]/)[0].replace(/[^A-Za-z0-9/_.{}-]/g, "").slice(0, 100);
    if (path) out.urlPath = path;
  }
  if (raw.selected === true) out.selected = true;
  if (raw.disabled === true) out.disabled = true;
  if (raw.noDialog === true) out.noDialog = true;
  if (raw.answer === true) out.answer = true;
  if (raw.panel === true) out.panel = true;
  // The open dialog may hold only these controls (and must hold the required ones): how a walkthrough proves a dialog is the plain one before it confirms it.
  const controls = (Array.isArray(raw.dialogControls) ? raw.dialogControls : []).map(safeName).filter(Boolean).slice(0, 12);
  if (controls.length) out.dialogControls = controls;
  const required = (Array.isArray(raw.dialogRequired) ? raw.dialogRequired : []).map(safeName).filter(Boolean).slice(0, 6);
  if (controls.length && required.length) out.dialogRequired = required;
  return Object.keys(out).length ? out : undefined;
}

/** A sample the planner fills in later (the lab's own question), or a short harmless literal. */
function sanitizeText(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  if (SAMPLE_KINDS.includes(raw.sample)) return { sample: raw.sample };
  if (typeof raw.literal === "string") {
    const checked = checkTypedText(raw.literal, { max: 200 });
    if (checked.ok) return { literal: checked.text };
  }
  return undefined;
}

/** What the computer is doing right now, as a sentence for the live progress ("Asking the test pane a sample question"). */
export function progressPhrase(step) {
  if (step.say) return step.say;
  const name = step.target?.name || step.target?.alt?.[0] || "";
  switch (step.action) {
    case "open-nav":
    case "reveal":
      return `Opening ${name || "the section"}`;
    case "select-tab":
      return `Selecting the ${name || ""} tab`.replace("  ", " ");
    case "expand":
      return `Expanding ${name || "the item"}`;
    case "open-item":
      return name ? `Opening ${name}` : "Opening the first item";
    case "open":
      return `Opening ${name ? `“${name}”` : "a dialog"}`;
    case "choose":
      return `Choosing ${name || "an option"}`;
    case "click":
      return `Clicking ${name || "a control"}`;
    case "type":
      return step.text?.sample === "question" ? "Typing a sample question in the test pane" : "Typing a sample";
    case "send":
      return "Asking the test pane a sample question";
    case "wait-answer":
      return "Waiting for the answer to finish";
    case "wait-for":
      return "Waiting for the screen to show";
    case "close":
      return "Closing the dialog";
    case "confirm":
    case "create":
      return `Working in the practice agent: ${name || "confirming"}`;
    default:
      return "Setting up the screen";
  }
}

/** What the step is called in the plan and the report: a plain sentence a person understands. */
export function describeStep(step) {
  const name = step.target?.name || step.target?.alt?.[0] || "";
  switch (step.action) {
    case "open-nav":
      return `Opened ${name || "the section"}`;
    case "reveal":
      return `Showed ${name || "the section"}`;
    case "select-tab":
      return `Selected the ${name || "tab"} tab`;
    case "expand":
      return `Expanded ${name || "the item"}`;
    case "open-item":
      return name ? `Opened ${name}` : "Opened the first item";
    case "open":
      return `Opened ${name ? `“${name}”` : "the dialog"}${step.expect?.dialog ? " (a dialog)" : ""}`;
    case "choose":
      return `Chose ${name || "an option"}`;
    case "click":
      return `Clicked ${name || "a control"}`;
    case "type":
      return step.text?.sample === "question" ? "Typed a sample question" : step.text?.sample === "description" ? "Typed the scenario description (not submitted)" : step.text?.sample === "search" ? "Typed a search" : step.text?.sample === "instructions" ? "Typed the lab's instructions" : step.text?.sample === "agentName" ? "Typed the agent's name" : step.text?.sample === "website" ? "Typed the website address" : "Typed a sample";
    case "send":
      return "Sent it to the test pane";
    case "wait-answer":
      return "Waited for the answer";
    case "wait-for":
      return `Waited for ${name || (step.expect?.text?.[0] ? `“${step.expect.text[0]}”` : "the screen")}`;
    case "close":
      return "Closed it with Cancel";
    case "discard":
      return "Left without saving";
    case "confirm":
      return `Confirmed ${name ? `“${name}”` : "it"} in the practice agent`;
    case "create":
      return `Created ${name ? `“${name}”` : "it"} in the practice agent`;
    case "press":
      return `Pressed ${step.key || "a key"}`;
    case "scroll":
      return "Scrolled to it";
    case "verify":
      return `Checked that ${name || "the screen"} is showing`;
    case "hover":
      return `Pointed at ${name || "it"}`;
    default:
      return "Did a step";
  }
}

/**
 * The tier a step needs, looked at before it runs: its action and the control it names (as a person would see
 * it, where it sits in the page). The executor checks again against the real control.
 */
export function plannedTier(step, product = "") {
  // A check looks at a control and never acts on it, whatever the control is called.
  if (step.action === "verify") return TIER.LOOK;
  const base = ACTION_TIERS[step.action] ?? TIER.PRACTICE;
  if (!step.target?.name && !step.target?.alt?.length) return base;
  const area = step.target.within;
  const names = [step.target.name, ...(step.target.alt || [])].filter(Boolean);
  let tier = base;
  for (const name of names) {
    const seen = classifyControl(
      { name, role: step.target.role || "", inDialog: area === "dialog", dialogTitle: "", inTestPane: area === "chat", inNav: area === "nav", inHeader: area === "header", landmarks: [] },
      { action: step.action, intent: step.intent, product, expectsOverlay: Boolean(step.expect?.dialog || step.expect?.panel) },
    );
    tier = Math.max(tier, seen.tier);
  }
  return tier;
}

/** One step, or null when it does not fit the shape. */
export function sanitizeStep(raw, index = 0, product = "") {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const action = String(raw.action || "");
  if (!SETUP_ACTIONS.includes(action)) return null;
  const target = sanitizeTarget(raw.target);
  const needsTarget = !["wait-answer", "press", "scroll", "send", "close", "discard", "wait-for"].includes(action);
  if (needsTarget && !target && action !== "open-item") return null;
  const step = {
    id: clean(raw.id, 24).replace(/[^A-Za-z0-9._-]/g, "") || `s${index + 1}`,
    action,
    ...(target ? { target } : {}),
  };
  if (INTENTS.includes(raw.intent)) step.intent = raw.intent;
  const text = sanitizeText(raw.text);
  if (action === "type") {
    if (!text) return null;
    step.text = text;
  }
  const expect = sanitizeExpect(raw.expect);
  if (expect) step.expect = expect;
  if (action === "press") {
    const key = ["Escape", "Enter", "Tab"].includes(raw.key) ? raw.key : null;
    if (!key) return null;
    step.key = key;
  }
  if (raw.optional === true) step.optional = true;
  if (raw.cleanup === true) step.cleanup = true;
  if (raw.practiceOnly === true) step.practiceOnly = true;
  // A click whose result is checked by the next step (a save that shows nothing by itself), and a switch that is clicked only when it is off.
  if (raw.soft === true) step.soft = true;
  if (raw.onlyIfOff === true) step.onlyIfOff = true;
  if (raw.onlyIfOn === true) step.onlyIfOn = true;
  // A click that is made once per practice agent, ever (publishing): the claim is written first and never undone.
  if (typeof raw.once === "string" && /^[a-z][a-z-]{1,19}$/.test(raw.once)) step.once = raw.once;
  const skipIfPresent = sanitizeTarget(raw.skipIfPresent);
  if (skipIfPresent) step.skipIfPresent = skipIfPresent;
  if (Number.isInteger(raw.retries) && raw.retries >= 0 && raw.retries <= 3) step.retries = raw.retries;
  if (Number.isFinite(Number(raw.timeoutMs))) step.timeoutMs = Math.max(500, Math.min(60_000, Number(raw.timeoutMs)));
  step.tier = plannedTier(step, product);
  if (step.tier >= TIER.NEVER) return null;
  const say = clean(raw.say, 80);
  if (say && !/https?:\/\/|[^\s@]+@[^\s@]+\.[^\s@]+/i.test(say)) step.say = say;
  // A plain sentence for the created-items report ("Set the agent's instructions"): the step's own wording, not an address or an id.
  const noted = safeName(clean(raw.note, 120));
  step.note = noted || describeStep(step);
  return step;
}

/** A list of steps, bounded, each one valid, with repeated ids made unique. */
export function sanitizeSteps(list, { max = MAX_SETUP_STEPS, product = "" } = {}) {
  const out = [];
  const seen = new Set();
  for (const [i, raw] of (Array.isArray(list) ? list : []).slice(0, max * 2).entries()) {
    const step = sanitizeStep(raw, i, product);
    if (!step) continue;
    let id = step.id;
    for (let n = 2; seen.has(id); n += 1) id = `${step.id}-${n}`;
    seen.add(id);
    out.push({ ...step, id });
    if (out.length >= max) break;
  }
  return out;
}

const INPUT_MAX = Object.freeze({ question: 200, search: 200, description: 300, instruction: 200, agentName: 80, instructions: 1500, outOfScope: 200 });

/**
 * The sample text a plan or a job carries, kind by kind, each checked again: short, plain, and free of anything that
 * identifies a person or a tenant. A website must be a public Microsoft documentation address.
 */
export function sanitizeInputs(raw) {
  const inputs = {};
  for (const kind of SAMPLE_KINDS) {
    if (kind === "website") {
      const site = checkPublicWebsite(raw?.website);
      if (site.ok) inputs.website = site.url;
      continue;
    }
    const checked = checkTypedText(raw?.[kind], { max: INPUT_MAX[kind] || 200 });
    if (checked.ok) inputs[kind] = checked.text;
  }
  return inputs;
}

/**
 * A setup plan as a job carries it: the steps, where they came from, and what a person can read about them.
 * Steps that need a practice agent are included only when `allowPractice` says the job may carry them.
 */
export function sanitizeSetup(raw, { allowPractice = false, product = "" } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const all = sanitizeSteps(raw.steps, { product });
  // Without a practice agent a step that creates or saves, and the steps that only make sense after it, are left out.
  const isPractice = (step) => step.tier >= TIER.PRACTICE || step.practiceOnly === true;
  const kept = allowPractice ? all : all.filter((step) => !isPractice(step));
  const left = all.filter((step) => isPractice(step));
  // A plan that was already narrowed (steps that need a practice agent left out) keeps saying so when it is read again.
  const carried = raw.limited && raw.limited.by === "practice-agent" ? { by: "practice-agent", skipped: (Array.isArray(raw.limited.skipped) ? raw.limited.skipped : []).slice(0, 6).map((s) => clean(s, 120)).filter(Boolean) } : null;
  const limited = !allowPractice && left.length ? { by: "practice-agent", skipped: left.map((s) => s.note).slice(0, 6) } : !allowPractice ? carried : null;
  const source = SOURCES.includes(String(raw.source || "").split(":")[0]) ? clean(raw.source, 60) : "derived";
  const inputs = sanitizeInputs(raw.inputs);
  const finalExpect = sanitizeExpect(raw.final);
  return {
    version: SETUP_VERSION,
    source,
    steps: kept,
    maxTier: kept.reduce((max, s) => Math.max(max, s.tier), 0),
    needsPractice: all.some((s) => isPractice(s)) || (raw.needsPractice === true && !allowPractice) || Boolean(carried && !allowPractice),
    ...(limited ? { limited } : {}),
    inputs,
    ...(finalExpect ? { final: finalExpect } : {}),
    summary: kept.map((s) => s.note).slice(0, 12),
  };
}

/** The steps of a plan, grouped by tier, as plain lines: what `--dry-run-plan` prints. */
export function groupStepsByTier(steps) {
  const groups = new Map([[0, []], [1, []], [2, []]]);
  for (const step of Array.isArray(steps) ? steps : []) groups.get(Math.min(2, step.tier ?? 0))?.push(step);
  return groups;
}

/** Run the steps of an older plan's reveal list as setup steps (a tab or navigation item to open, when the page has one). */
export function stepsFromReveal(reveal, product = "") {
  return sanitizeSteps(
    (Array.isArray(reveal) ? reveal : []).map((r, i) => ({ id: `reveal-${i + 1}`, action: "reveal", optional: !r.required, target: { name: r.label, within: "any" } })),
    { product },
  ).filter((step) => step.tier < TIER.PRACTICE);
}

/** Whether two names mean the same control for matching: case, accents, spacing, and trailing marks ignored. */
export function sameName(a, b) {
  return normalizeControlName(a) === normalizeControlName(b);
}
