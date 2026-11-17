// A small pretend single-page app for the step runner tests: screens with visible text and controls, the
// controls know where a click leads, and nothing needs a real browser. It answers the few Playwright calls the
// runner makes (role locators with a name pattern, evaluate by function name, navigation, screenshots, the
// guided toolbar's exposed functions), and records what was opened and clicked.

import fs from "node:fs";

import { makePng } from "./png.mjs";

/**
 * @param {object} options
 * @param {Record<string, {text?: string[], controls?: object[], busy?: number}>} options.screens by address ("https://host/path", no query)
 *   a control is `{role, name, region, selected?, href?, type?, goto?: address, select?: boolean}`:
 *   `goto` opens another screen, `select` marks the control selected, neither means the click changes nothing
 * @param {Record<string, string>} [options.redirects] an address that ends up somewhere else
 * @param {(url: string, attempt: number) => Error|null} [options.gotoFailure]
 */
export function createFakeApp({ screens, redirects = {}, gotoFailure = null }) {
  const log = { goto: [], clicks: [], screenshots: 0, evaluations: [] };
  const state = { current: "about:blank", changes: 0, closed: false, selected: new Set() };
  const exposed = new Map();

  const screenNow = () => screens[state.current.split(/[?#]/)[0]] || { text: [], controls: [] };
  const matches = (name, pattern) => (pattern instanceof RegExp ? pattern.test(name) : String(pattern) === name);

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
          if (control.goto) {
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
    async bringToFront() {},
    isClosed: () => state.closed,
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
    async evaluate(fn) {
      log.evaluations.push(fn.name);
      if (fn.name === "readinessProbeInPage") {
        const screen = screenNow();
        const busy = Number(screen.busy || 0);
        if (screen.busy > 0) screen.busy -= 1;
        return { state: "complete", busy, quietFor: 5000, changes: state.changes, text: 100 };
      }
      if (fn.name === "collectVisibleLabelsInPage") return [...(screenNow().text || [])];
      if (fn.name === "maskSensitiveInPage") return { masked: 0, controls: 0, texts: 0, selectors: 0 };
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

  return {
    page,
    log,
    state,
    /** The person presses a button on the toolbar (once it is on the page). */
    pressToolbar: async (action) => {
      for (let i = 0; i < 100 && !exposed.has("__captureGuidedAction"); i += 1) await new Promise((r) => setTimeout(r, 2));
      await new Promise((r) => setTimeout(r, 10));
      return exposed.get("__captureGuidedAction")?.(action);
    },
    toolbarShown: () => exposed.has("__captureGuidedAction"),
    /** The browser window is closed. */
    close: () => {
      state.closed = true;
    },
    context: {
      pages: () => [page],
      async newPage() {
        log.newPages = (log.newPages || 0) + 1;
        return page;
      },
    },
  };
}
