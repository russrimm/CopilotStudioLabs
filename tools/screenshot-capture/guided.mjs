// Guided capture: the companion takes the browser as close to the screen as it can, then shows a small toolbar
// on the page with plain instructions and three buttons: Capture this screen, Skip, and Stop. The person sets up
// whatever the computer should not (a test conversation, a dialog, a publish) and captures when it looks right.
//
// The toolbar is the companion's own: it shows only the text of the instruction, never reads the page, never
// touches an input, and is removed from the page before the picture is taken.

export const GUIDED_KEYS = Object.freeze({ capture: "Alt+Shift+C", skip: "Alt+Shift+X" });
export const GUIDED_ACTIONS = Object.freeze(["capture", "skip", "stop"]);

/**
 * Runs in the page (it must stay self-contained). Defines `window.__captureRenderGuided(config)`, and shows the
 * toolbar again after a full page load while a guided shot is waiting.
 */
export function guidedInstallInPage() {
  const w = window;
  if (w.__captureRenderGuided) return;
  const remove = () => document.querySelectorAll("[data-capture-ui]").forEach((n) => n.remove());
  w.__captureRemoveGuided = remove;
  w.__captureRenderGuided = function render(config) {
    remove();
    if (!config || !document.documentElement) return;
    const host = document.createElement("div");
    host.setAttribute("data-capture-ui", "guided");
    host.style.cssText = "all:initial;position:fixed;z-index:2147483647;right:16px;bottom:16px;";
    const root = host.attachShadow({ mode: "open" });
    const el = (tag, props, children) => {
      const node = document.createElement(tag);
      for (const [key, value] of Object.entries(props || {})) {
        if (key === "text") node.textContent = value;
        else if (key === "style") node.style.cssText = value;
        else node.setAttribute(key, value);
      }
      for (const child of children || []) node.appendChild(child);
      return node;
    };
    const button = (label, action, primary) => {
      const b = el("button", { type: "button", text: label, style: `font:600 14px Segoe UI,Arial,sans-serif;padding:8px 12px;border-radius:6px;cursor:pointer;border:2px solid ${primary ? "#ffffff" : "#9ca3af"};background:${primary ? "#0b5cad" : "#111827"};color:#ffffff;` });
      b.addEventListener("click", () => {
        if (typeof w.__captureGuidedAction === "function") w.__captureGuidedAction(action);
      });
      return b;
    };
    const lines = Array.isArray(config.lines) ? config.lines.slice(0, 6) : [];
    const panel = el("div", { role: "region", "aria-label": "Screenshot helper", style: "box-sizing:border-box;width:340px;max-width:calc(100vw - 32px);padding:14px;border-radius:10px;background:#111827;color:#ffffff;border:2px solid #ffffff;font:14px/1.4 Segoe UI,Arial,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.45);" }, [
      el("div", { text: String(config.title || "Set up this screen"), style: "font-weight:700;font-size:15px;margin-bottom:6px;" }),
      ...(lines.length ? [el("ol", { style: "margin:0 0 10px 18px;padding:0;" }, lines.map((line) => el("li", { text: String(line), style: "margin:2px 0;" })))] : []),
      el("div", { style: "display:flex;gap:8px;flex-wrap:wrap;" }, [button("Capture this screen", "capture", true), button("Skip", "skip", false), button("Stop", "stop", false)]),
      el("div", { text: `Shortcut: ${config.captureKey || "Alt+Shift+C"} captures, ${config.skipKey || "Alt+Shift+X"} skips. This panel is not part of the screenshot.`, style: "margin-top:8px;font-size:12px;color:#d1d5db;" }),
    ]);
    root.appendChild(panel);
    document.documentElement.appendChild(host);
    if (!w.__captureGuidedKeys) {
      w.__captureGuidedKeys = true;
      window.addEventListener(
        "keydown",
        (event) => {
          if (!event.altKey || !event.shiftKey || typeof w.__captureGuidedAction !== "function") return;
          if (event.code === "KeyC") {
            event.preventDefault();
            w.__captureGuidedAction("capture");
          } else if (event.code === "KeyX") {
            event.preventDefault();
            w.__captureGuidedAction("skip");
          }
        },
        true,
      );
    }
  };
  document.addEventListener("DOMContentLoaded", () => {
    if (window !== window.top || typeof w.__captureGuidedState !== "function") return;
    Promise.resolve(w.__captureGuidedState()).then((config) => {
      if (config) w.__captureRenderGuided(config);
    });
  });
}

const controllers = new WeakMap();

/** Remove the toolbar from the page and confirm it is gone. Throws when it cannot be removed. */
export async function removeGuidedToolbar(page) {
  const controller = controllers.get(page);
  if (controller) controller.config = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const left = await page.evaluate(() => {
      document.querySelectorAll("[data-capture-ui]").forEach((n) => n.remove());
      return document.querySelectorAll("[data-capture-ui]").length;
    });
    if (!left) return true;
  }
  throw new Error("The helper panel could not be removed from the page, so the screenshot was not taken.");
}

async function prepare(page) {
  let controller = controllers.get(page);
  if (controller) return controller;
  controller = { config: null, resolve: null };
  controllers.set(page, controller);
  await page.exposeFunction("__captureGuidedAction", (action) => {
    if (GUIDED_ACTIONS.includes(action) && controller.resolve) controller.resolve(action);
  });
  await page.exposeFunction("__captureGuidedState", () => controller.config);
  await page.addInitScript(guidedInstallInPage);
  await page.evaluate(guidedInstallInPage);
  return controller;
}

/**
 * Show the toolbar and wait for the person.
 * @param {object} page
 * @param {object} options
 * @param {{title: string, lines: string[]}} options.config what the toolbar says
 * @param {number} options.timeoutMs how long to wait for someone who is not there
 * @param {() => boolean} [options.shouldStop] true when the job was canceled
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @returns {Promise<"capture"|"skip"|"stop"|"timeout"|"closed"|"cancelled">}
 */
export async function waitForGuidedAction(page, { config, timeoutMs, shouldStop = () => false, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = 250, now = () => Date.now() }) {
  const controller = await prepare(page);
  controller.config = { ...config, captureKey: GUIDED_KEYS.capture, skipKey: GUIDED_KEYS.skip };
  await page.evaluate((c) => window.__captureRenderGuided(c), controller.config);
  let result = null;
  controller.resolve = (action) => {
    result = action;
  };
  const onClose = () => {
    result = result || "closed";
  };
  page.once?.("close", onClose);
  const startedAt = now();
  let waited = 0;
  try {
    while (!result) {
      if (shouldStop()) return "cancelled";
      // The larger of the clock and the waits themselves, so skipping real sleeping (a test) cannot spin.
      if (Math.max(now() - startedAt, waited) >= timeoutMs) return "timeout";
      await sleep(pollMs);
      waited += pollMs;
      if (!result && typeof page.isClosed === "function" && page.isClosed()) result = "closed";
    }
    return result;
  } finally {
    controller.resolve = null;
    page.off?.("close", onClose);
    if (result !== "closed") await removeGuidedToolbar(page).catch(() => {});
  }
}
