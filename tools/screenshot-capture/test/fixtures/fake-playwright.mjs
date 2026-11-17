// A fake Playwright for the companion tests. It records what the companion does
// to the page (clicks, evaluations, screenshots) and returns canned content, so
// no real browser or tenant is involved.

import fs from "node:fs";
import { makePng } from "./png.mjs";

/**
 * @param {object} [options]
 * @param {string[]} [options.labels] visible controls on every page
 * @param {(url: string) => string} [options.rewriteUrl] change where a navigation ends up (for sign-in redirects)
 * @param {(n: number, url: string) => Buffer} [options.screenshot] the Nth screenshot (default: a busy image)
 * @param {string} [options.title]
 * @param {string[]} [options.pageLabels] text returned by the visible-labels evaluation
 * @param {Record<string, object>} [options.controlDetails] what a control looks like to the click guard (`{text, aria, title, href}`), by label
 * @param {Error|((dir: string, options: object) => Error|null)|null} [options.launchError] make opening a profile fail (for a missing browser)
 * @param {((url: string, attempt: number) => Error|null)|null} [options.gotoFailure] make opening an address fail (an interrupted navigation, a closed window)
 */
export function createFakePlaywright({ labels = ["Settings", "Memory", "Home"], rewriteUrl = (u) => u, screenshot = null, title = "Copilot Studio", pageLabels = ["Settings", "Memory", "Home", "Signed in as ada@contoso.com"], controlDetails = {}, launchError = null, gotoFailure = null } = {}) {
  const log = { launched: [], goto: [], clicks: [], evaluations: [], screenshots: 0, closed: 0, order: [] };
  let requestedUrl = "about:blank";

  const locatorFor = (label) => {
    const visible = Boolean(label) && labels.some((l) => String(label).toLowerCase() === l.toLowerCase() || String(label).toLowerCase().includes(l.toLowerCase()));
    const item = {
      async isVisible() {
        return visible;
      },
      async click() {
        log.clicks.push(label);
      },
      async evaluate() {
        return controlDetails[label] || { text: label, aria: "", title: "", href: "" };
      },
      async scrollIntoViewIfNeeded() {},
      async boundingBox() {
        return { x: 100, y: 80, width: 120, height: 36 };
      },
    };
    return {
      async count() {
        return visible ? 1 : 0;
      },
      nth() {
        return item;
      },
    };
  };

  const page = {
    async goto(url) {
      // A test can make the browser fail to open an address, for example an interrupted navigation or a closed window.
      const failure = typeof gotoFailure === "function" ? gotoFailure(url, log.goto.length) : null;
      log.goto.push(url);
      if (failure) throw failure;
      requestedUrl = url;
    },
    // Evaluated on every read, so a test can flip "signed in" while the page is open.
    url() {
      return requestedUrl === "about:blank" ? requestedUrl : rewriteUrl(requestedUrl);
    },
    async title() {
      return title;
    },
    async setViewportSize() {},
    async waitForLoadState() {},
    async waitForTimeout() {},
    async bringToFront() {},
    isClosed: () => false,
    on() {},
    once() {},
    off() {},
    async exposeFunction() {},
    async addInitScript() {},
    getByRole(_role, opts) {
      const raw = opts?.name;
      // The runner matches names exactly with a regular expression; the fake wants the plain label back.
      const label = raw instanceof RegExp ? raw.source.replace(/^\^\\s\*/, "").replace(/\\s\*\$$/, "").replace(/\\(.)/g, "$1") : raw ? String(raw) : "";
      return locatorFor(label);
    },
    getByText(text) {
      return locatorFor(String(text));
    },
    locator() {
      return locatorFor("");
    },
    frames() {
      return [page];
    },
    mainFrame() {
      return page;
    },
    async evaluate(fn, arg) {
      log.evaluations.push(fn.name);
      log.order.push(fn.name);
      if (fn.name === "maskSensitiveInPage") return { masked: 3, controls: 1, texts: 2, selectors: arg?.selectors?.length ?? 0 };
      if (fn.name === "collectVisibleLabelsInPage") return pageLabels;
      if (fn.name === "drawCalloutMarkersInPage") return (arg?.callouts || []).filter((c) => c.rect).length;
      if (fn.name === "readinessProbeInPage") return { state: "complete", busy: 0, quietFor: 60_000, changes: 0, text: 200 };
      return undefined;
    },
    async screenshot(options = {}) {
      // The readiness check takes two small pictures to see that the page has stopped changing; they are not shots.
      if (options.type === "jpeg") return Buffer.from("steady frame");
      log.screenshots += 1;
      log.order.push("screenshot");
      const bytes = screenshot ? screenshot(log.screenshots, page.url()) : makePng({ mode: "ui", seed: log.screenshots });
      if (options.path) fs.writeFileSync(options.path, bytes);
      return bytes;
    },
  };

  // Cookies live in the context like in a real browser: persistent ones survive closing a profile, session ones do not.
  const profiles = new Map();
  const live = { context: null };
  const playwright = {
    chromium: {
      async launchPersistentContext(dir, options) {
        log.launched.push({ dir, options });
        const failure = typeof launchError === "function" ? launchError(dir, options) : launchError;
        if (failure) throw failure;
        const jar = [...(profiles.get(dir) || [])];
        const context = {
          jar,
          added: [],
          pages: () => [page],
          async newPage() {
            log.newPages = (log.newPages || 0) + 1;
            return page;
          },
          async addCookies(cookies) {
            context.added.push(...cookies);
            jar.push(...cookies);
          },
          async cookies() {
            return [...jar];
          },
          async storageState() {
            return { cookies: [...jar], origins: [] };
          },
          async close() {
            log.closed += 1;
            profiles.set(dir, jar.filter((c) => c.expires !== -1));
          },
        };
        live.context = context;
        return context;
      },
    },
  };
  /** The person signs in: the browser now holds an Entra session cookie. */
  const signIn = ({ persistent = false } = {}) => {
    live.context?.jar.push({ name: persistent ? "ESTSAUTHPERSISTENT" : "ESTSAUTH", value: "secret-session-value", domain: "login.microsoftonline.com", path: "/", expires: persistent ? 4102444800 : -1, httpOnly: true, secure: true, sameSite: "None" });
  };
  return { playwright, page, log, signIn, live };
}
