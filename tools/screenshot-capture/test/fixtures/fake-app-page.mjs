// A small pretend single-page app for the step runner tests: screens with visible text and controls, the
// controls know where a click leads, and nothing needs a real browser. It answers the few Playwright calls the
// runner makes (role locators with a name pattern, evaluate by function name, navigation, screenshots, the
// guided toolbar's exposed functions), and records what was opened and clicked.
//
// It can have more than one tab, like the real product: `app.openTab(url)` opens another tab in the same browser context (the way the product opens the
// classic experience), and `page.context()` lists the tabs and tells a listener about a new one. All tabs share the screens and the log.

import fs from "node:fs";

import { makePng } from "./png.mjs";

/**
 * @param {object} options
 * @param {Record<string, {text?: string[], controls?: object[], busy?: number, agentHarness?: Record<string, {column?: string, texts: string[]}>, feedback?: object}>} options.screens by address ("https://host/path", no query)
 *   a control is `{role, name, region, selected?, href?, type?, goto?: address, select?: boolean, opensTab?: address}`:
 *   `goto` opens another screen, `select` marks the control selected, `opensTab` opens that address in a NEW TAB, none of them means the click changes nothing
 *   `agentHarness` maps an agent name to what the Agents list's harness column says for it (`{column: "agent-harness", texts: ["Standard<tooltip>"]}`)
 * @param {Record<string, string>} [options.redirects] an address that ends up somewhere else
 * @param {(url: string, attempt: number) => Error|null} [options.gotoFailure]
 */
export function createFakeApp({ screens, redirects = {}, gotoFailure = null }) {
  const log = { goto: [], clicks: [], screenshots: 0, evaluations: [], tabs: 0, closedTabs: 0 };
  const exposed = new Map();
  const tabs = [];
  const listeners = new Set();
  const matches = (name, pattern) => (pattern instanceof RegExp ? pattern.test(name) : String(pattern) === name);

  const makePage = () => {
    const state = { current: "about:blank", changes: 0, closed: false, selected: new Set() };
    const screenNow = () => screens[state.current.split(/[?#]/)[0]] || { text: [], controls: [] };

    const locatorFor = (controls) => ({
      async count() {
        return controls.length;
      },
      nth(i) {
        const control = controls[i];
        return {
          async isVisible() {
            return control.hidden !== true;
          },
          async click() {
            log.clicks.push(control.name);
            if (control.opensTab) {
              app.openTab(control.opensTab);
            } else if (control.goto) {
              state.current = redirects[control.goto] || control.goto;
              state.changes += 1;
            } else if (control.select) {
              state.selected.add(control);
              state.changes += 1;
            }
          },
          async scrollIntoViewIfNeeded() {},
          async evaluate() {
            return { text: control.name, aria: "", title: "", href: control.href || "", type: control.type || "", inForm: false, region: control.region || "other", selected: Boolean(control.selected || state.selected.has(control)) };
          },
        };
      },
    });

    const page = {
      async goto(url) {
        const failure = gotoFailure ? gotoFailure(url, log.goto.length) : null;
        log.goto.push(url);
        if (failure) throw failure;
        state.current = redirects[url] || url;
        state.changes += 1;
      },
      url: () => state.current,
      async title() {
        return "App";
      },
      async setViewportSize() {},
      async waitForLoadState() {},
      async waitForTimeout() {},
      async bringToFront() {
        log.front = (log.front || 0) + 1;
        page.fronted = true;
      },
      async close() {
        if (state.closed) return;
        state.closed = true;
        log.closedTabs += 1;
      },
      isClosed: () => state.closed,
      context: () => context,
      on() {},
      once() {},
      off() {},
      getByRole(role, { name } = {}) {
        return locatorFor((screenNow().controls || []).filter((c) => c.role === role && matches(c.name, name)));
      },
      getByText() {
        return locatorFor([]);
      },
      async exposeFunction(name, fn) {
        exposed.set(name, fn);
      },
      async addInitScript() {},
      async evaluate(fn, arg) {
        log.evaluations.push(fn.name);
        if (fn.name === "readinessProbeInPage") {
          const screen = screenNow();
          const busy = Number(screen.busy || 0);
          if (screen.busy > 0) screen.busy -= 1;
          return { state: "complete", busy, quietFor: 5000, changes: state.changes, text: 100 };
        }
        if (fn.name === "collectVisibleLabelsInPage") return [...(screenNow().text || [])];
        if (fn.name === "maskSensitiveInPage") return { masked: 0, controls: 0, texts: 0, selectors: 0 };
        // The names of the tabs the page draws (its tab strip): the controls with the role tab.
        if (fn.name === "tabNamesInPage") return (screenNow().controls || []).filter((c) => c.role === "tab" && c.hidden !== true).map((c) => c.name);
        // The harness cell of an agent's row in the Agents list: `agentHarness` maps an agent name to `{column, texts}`.
        if (fn.name === "agentHarnessInPage") return (screenNow().agentHarness || {})[arg] ?? null;
        // A feedback prompt on the screen: `feedback` is what the page shows (`{prompt, skip, submit}`).
        if (fn.name === "feedbackPromptInPage") return screenNow().feedback || { prompt: false, skip: false, submit: false };
        return undefined;
      },
      async screenshot(options = {}) {
        if (options.type === "jpeg") return Buffer.from(`frame ${state.changes}`);
        log.screenshots += 1;
        const bytes = makePng({ mode: "ui", seed: log.screenshots });
        if (options.path) fs.writeFileSync(options.path, bytes);
        return bytes;
      },
      locator() {
        return locatorFor([]);
      },
    };
    tabs.push(page);
    return { page, state };
  };

  const context = {
    pages: () => tabs.filter((p) => !p.isClosed()),
    async newPage() {
      log.newPages = (log.newPages || 0) + 1;
      return makePage().page;
    },
    on(event, listener) {
      if (event === "page") listeners.add(listener);
    },
    off(event, listener) {
      if (event === "page") listeners.delete(listener);
    },
    removeListener(event, listener) {
      if (event === "page") listeners.delete(listener);
    },
  };

  const first = makePage();

  const app = {
    page: first.page,
    log,
    state: first.state,
    /** The product opens another tab (at `url`, after any redirect) and tells whoever listens for new pages. */
    openTab(url) {
      const tab = makePage();
      tab.state.current = redirects[url] || url;
      tab.state.changes += 1;
      log.tabs += 1;
      for (const listener of [...listeners]) listener(tab.page);
      return tab.page;
    },
    /** The person presses a button on the toolbar (once it is on the page). */
    pressToolbar: async (action) => {
      for (let i = 0; i < 100 && !exposed.has("__captureGuidedAction"); i += 1) await new Promise((r) => setTimeout(r, 2));
      await new Promise((r) => setTimeout(r, 10));
      return exposed.get("__captureGuidedAction")?.(action);
    },
    toolbarShown: () => exposed.has("__captureGuidedAction"),
    /** The browser window is closed. */
    close: () => {
      first.state.closed = true;
    },
    context,
  };
  return app;
}
