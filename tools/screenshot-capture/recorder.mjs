// "Show me once": when automation cannot set a screen up, the person does it by hand in the companion's window while
// this records it as tier-checked, declarative steps (a control's role, its name, and the area it is in), so the
// computer can do it by itself next time.
//
// What is never recorded: coordinates, selectors, typed text beyond a harmless kind of sample (a question, a search),
// passwords or anything that looks like a secret, account information, the names of items in a list (an agent's own
// name), and anything the computer never does (sign out, delete, share...). Those are skipped, and the person is told.

import { classifyControl, describeControlForGate, TIER } from "./guard.mjs";
import { sanitizeSteps } from "./setup-steps.mjs";
import { readState } from "./executor.mjs";
import { parseCopilotStudioAddress } from "./targets.mjs";

const RECORDER_KEY = "__captureRecordEvent";
const controllers = new WeakMap();

/** Runs in the page (it must stay self-contained). Reports clicks, finished edits, and the Escape key to the companion. */
export function recorderInstallInPage() {
  const w = window;
  if (w.__captureRecorderInstalled) return;
  w.__captureRecorderInstalled = true;
  const send = (event) => {
    if (typeof w.__captureRecordEvent === "function") Promise.resolve(w.__captureRecordEvent(event)).catch(() => {});
  };
  const target = (event) => {
    const path = event.composedPath ? event.composedPath() : [event.target];
    return path[0] && path[0].nodeType === 1 ? path[0] : event.target;
  };
  const insideOwnUi = (el, event) => (event && event.composedPath ? event.composedPath() : [el]).some((node) => node && node.nodeType === 1 && node.hasAttribute && node.hasAttribute("data-capture-ui"));
  document.addEventListener(
    "click",
    (event) => {
      const el = target(event);
      if (!el || insideOwnUi(el, event) || typeof w.__captureDescribe !== "function") return;
      const control = el.closest ? el.closest("button, a, [role=button], [role=tab], [role=menuitem], [role=treeitem], [role=option], [role=radio], [role=checkbox], [role=switch], [role=link], summary, input, textarea, select") : null;
      if (!control) return;
      const desc = w.__captureDescribe(control);
      const inList = Boolean(control.closest && control.closest("li, tr, [role=row], [role=listitem], [role=gridcell]"));
      let index = 0;
      if (inList) {
        const container = control.closest("ul, ol, table, [role=list], [role=grid], [role=table]");
        const items = container ? Array.from(container.querySelectorAll("li, tr, [role=row], [role=listitem]")) : [];
        const own = control.closest("li, tr, [role=row], [role=listitem]");
        index = Math.max(0, items.indexOf(own));
      }
      send({ type: "click", desc, inList, index });
    },
    true,
  );
  document.addEventListener(
    "change",
    (event) => {
      const el = target(event);
      if (!el || insideOwnUi(el, event) || typeof w.__captureDescribe !== "function") return;
      const tag = String(el.tagName || "").toLowerCase();
      if (!(tag === "input" || tag === "textarea" || el.isContentEditable)) return;
      const type = String(el.getAttribute("type") || "text").toLowerCase();
      if (type === "password" || type === "file") {
        send({ type: "input", desc: w.__captureDescribe(el), value: "", skipped: type });
        return;
      }
      send({ type: "input", desc: w.__captureDescribe(el), value: String(el.value ?? el.textContent ?? "").slice(0, 300) });
    },
    true,
  );
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Escape" && event.key !== "Enter") return;
      const el = target(event);
      if (!el || insideOwnUi(el, event) || typeof w.__captureDescribe !== "function") return;
      send({ type: "key", key: event.key, desc: w.__captureDescribe(el) });
    },
    true,
  );
}

const SEND_NAMES = /^(?:send|submit|ask)(?: message)?$/i;

/** Whether the page is inside the given agent (its own address, not a page that mentions it). */
export function insidePracticeAgent(page, botId) {
  try {
    const parsed = parseCopilotStudioAddress(typeof page.url === "function" ? page.url() : "");
    return Boolean(parsed.ok && parsed.botId && parsed.botId.toLowerCase() === String(botId || "").toLowerCase());
  } catch {
    return false;
  }
}

function areaOf(desc) {
  if (desc.inTestPane) return "chat";
  if (desc.inDialog) return "dialog";
  if (desc.role === "tab") return "tablist";
  if (desc.inNav) return "nav";
  if (desc.inHeader) return "header";
  return "main";
}

const nameOf = (desc) => String(desc.name || desc.aria || desc.text || desc.title || desc.placeholder || "").replace(/\s+/g, " ").trim().slice(0, 80);

/**
 * Turn one reported interaction into a step, or explain why it is not recorded. Pure, so a test can check redaction and
 * tier filtering without a browser.
 * @returns {{step?: object, skipped?: string}}
 */
export function stepFromEvent(event, { product = "", dialogOpened = false, panelOpened = false } = {}) {
  const desc = event?.desc;
  if (!desc) return { skipped: "unknown" };
  const opened = dialogOpened || panelOpened;
  if (event.type === "key") {
    if (event.key === "Escape") return { step: { action: "press", key: "Escape", intent: "close" } };
    return { skipped: "enter" };
  }
  if (event.type === "input") {
    if (event.skipped) return { skipped: `A ${event.skipped} field was not recorded.` };
    const name = nameOf(desc);
    const seen = classifyControl({ ...desc, name: name || desc.placeholder }, { action: "type", intent: "type", product });
    if (seen.tier >= TIER.NEVER) return { skipped: seen.reason };
    // The text itself is never kept (only the kind of sample), so what was typed does not need to be clean to record that a question was asked.
    const sample = desc.inTestPane ? "question" : /search|filter|find/i.test(`${name} ${desc.placeholder}`) || desc.role === "searchbox" ? "search" : /describe|description|what would you like/i.test(`${name} ${desc.placeholder}`) ? "description" : /instruction/i.test(name) ? "instruction" : null;
    if (!sample) return { skipped: "Typed text is only recorded as a kind of sample (a question, a search), so this field was left out." };
    return { step: { action: "type", intent: "type", target: { role: desc.role === "searchbox" ? "searchbox" : "textbox", name: name || undefined, within: areaOf(desc) }, text: { sample } }, tier: seen.tier };
  }
  const name = nameOf(desc);
  const verdict = classifyControl(desc, { action: "click", intent: opened ? "open" : "click", product, expectsOverlay: opened });
  if (verdict.tier >= TIER.NEVER) return { skipped: `${verdict.reason} It was not recorded.` };
  const within = areaOf(desc);
  const role = ["button", "link", "tab", "menuitem", "treeitem", "option", "radio", "checkbox", "switch"].includes(desc.role) ? desc.role : undefined;
  // Items in a list are the person's own data (an agent's name): record "the first item", never its name.
  if (event.inList && within === "main" && (desc.role === "link" || desc.role === "button")) {
    return { step: { action: "open-item", intent: "navigate", target: { within: "main", nth: Math.min(5, Math.max(0, event.index || 0)) } } };
  }
  if (!name) return { skipped: "A control with no name cannot be recorded." };
  const target = { ...(role ? { role } : {}), name, within };
  if (desc.role === "tab") return { step: { action: "select-tab", target }, tier: verdict.tier };
  if (desc.inTestPane && SEND_NAMES.test(name)) return { step: { action: "send", intent: "send", target }, after: { action: "wait-answer" }, tier: verdict.tier };
  if (verdict.category === "cancel") return { step: { action: "close", intent: "close", target }, tier: verdict.tier };
  if (within === "nav" && verdict.tier === TIER.LOOK) return { step: { action: "open-nav", target }, tier: verdict.tier };
  if (verdict.tier >= TIER.PRACTICE) return { step: { action: "confirm", intent: "confirm", target }, tier: verdict.tier };
  if (within === "dialog") return { step: { action: "choose", intent: "choose", target }, tier: verdict.tier };
  const opens = opened || verdict.category === "opens-dialog";
  return { step: { action: opens ? "open" : "click", intent: opens ? "open" : "click", target, ...(dialogOpened ? { expect: { dialog: true } } : panelOpened ? { expect: { panel: true } } : {}) }, tier: verdict.tier };
}

/**
 * Start recording what a person does in `page`. `stop()` returns the steps and what was left out and why. With a
 * `practiceAgentId` (a from-scratch run), a step that changes something is recorded only while the page is inside that agent.
 */
export async function startRecorder(page, { product = "", log = null, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), practiceAgentId = null } = {}) {
  let controller = controllers.get(page);
  if (!controller) {
    controller = { handler: null };
    controllers.set(page, controller);
    await page.exposeFunction(RECORDER_KEY, (event) => controller.handler?.(event));
    await page.addInitScript(`window.__captureDescribe = ${describeControlForGate.toString()};`);
    await page.addInitScript(recorderInstallInPage);
  }
  await page.evaluate(`window.__captureDescribe = ${describeControlForGate.toString()};`);
  await page.evaluate(recorderInstallInPage);

  const steps = [];
  const skipped = [];
  const kindCounts = (list) => ({ dialog: list.filter((d) => d.kind === "dialog" || d.kind === "menu").length, panel: list.filter((d) => d.kind === "panel").length });
  let before = kindCounts((await readState(page).catch(() => ({ dialogs: [] }))).dialogs);
  let pending = Promise.resolve();
  controller.handler = (event) => {
    pending = pending.then(async () => {
      // After a click, a dialog, menu, or panel that was not there before means the click opened it.
      let dialogOpened = false;
      let panelOpened = false;
      if (event.type === "click") {
        await sleep(450);
        const after = kindCounts((await readState(page).catch(() => ({ dialogs: [] }))).dialogs);
        dialogOpened = after.dialog > before.dialog;
        panelOpened = !dialogOpened && after.panel > before.panel;
        before = after;
      }
      const made = stepFromEvent(event, { product, dialogOpened, panelOpened });
      if (made.step && practiceAgentId && made.tier >= TIER.PRACTICE && !insidePracticeAgent(page, practiceAgentId)) {
        made.step = undefined;
        made.skipped = "This changes something, and the page is not inside the practice agent, so it was not recorded.";
      }
      if (made.skipped) {
        skipped.push(made.skipped);
        log?.(`  Not recorded: ${made.skipped}`);
        return;
      }
      const last = steps.at(-1);
      // Typing then leaving the field fires twice; a repeated identical step is one step.
      if (last && JSON.stringify(last) === JSON.stringify(made.step)) return;
      steps.push(made.step);
      if (made.after) steps.push(made.after);
    });
  };
  return {
    async stop() {
      await pending;
      controller.handler = null;
      return { steps: sanitizeSteps(steps, { product }), skipped: [...new Set(skipped)].slice(0, 6) };
    },
  };
}
