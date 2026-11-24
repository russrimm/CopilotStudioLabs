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
export function createFakePlaywright({ labels = ["Settings", "Memory", "Home"], rewriteUrl = (u) => u, screenshot = null, title = "Copilot Studio", pageLabels = ["Settings", "Memory", "Home", "Signed in as ada@contoso.com"], controlDetails = {}, launchError = null, gotoFailure = null, experience = "microsoft-copilot" } = {}) {
  const log = { launched: [], goto: [], clicks: [], evaluations: [], screenshots: 0, closed: 0, order: [] };
  let requestedUrl = "about:blank";

  // The experience the pretend product is in: the default one shows the tab strip (Build, Preview, Evaluate, Monitor) and a side bar menu in the lower left corner
  // that offers "Open classic experience"; clicking that command shows the classic one (side navigation, and a menu without the command). `experience` is
  // where the page starts, so a Microsoft Copilot picture passes at once and a Standard (Classic) picture goes through the switch, like a person would.
  const MC_TABS = ["Build", "Preview", "Evaluate", "Monitor"];
  const CLASSIC_NAV = ["Overview", "Knowledge", "Topics", "Tools", "Analytics", "Channels"];
  const ELLIPSIS = ["More", "More options", "...", "…", "Settings and more", "Options"];
  const shown = { experience, menuOpen: false, changes: 0 };
  const same = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
  // The control the experience adds for a role and a name, or null when it adds none.
  const experienceControl = (role, label) => {
    if (role === "tab" && shown.experience !== "classic" && MC_TABS.some((t) => same(t, label))) return { kind: "tab", region: "nav" };
    if (["link", "tab", "treeitem", "menuitem"].includes(role) && shown.experience === "classic" && CLASSIC_NAV.some((t) => same(t, label))) return { kind: "nav", region: "nav", selected: same(label, "Overview") };
    if (role === "button" && ELLIPSIS.some((t) => same(t, label))) return { kind: "ellipsis", region: "nav", box: { x: 24, y: 840, width: 36, height: 36 } };
    if (role === "menuitem" && shown.menuOpen && shown.experience !== "classic" && same(label, "Open classic experience")) return { kind: "classic-command", region: "other" };
    return null;
  };
  // A name that a role-and-name pattern would match among the controls this fake knows.
  const nameFor = (role, raw) => {
    if (!(raw instanceof RegExp)) return raw ? String(raw) : "";
    const known = [...MC_TABS, ...CLASSIC_NAV, ...ELLIPSIS, "Open classic experience"].find((n) => raw.test(n) && experienceControl(role, n));
    if (known) return known;
    // The runner matches names exactly with a regular expression; the fake wants the plain label back.
    return raw.source.replace(/^\^\\s\*/, "").replace(/\\s\*\$$/, "").replace(/\\(.)/g, "$1");
  };

  const locatorFor = (label, role = "") => {
    const added = role ? experienceControl(role, label) : null;
    const visible = Boolean(added) || (Boolean(label) && labels.some((l) => String(label).toLowerCase() === l.toLowerCase() || String(label).toLowerCase().includes(l.toLowerCase())));
    const item = {
      async isVisible() {
        return visible;
      },
      async click() {
        log.clicks.push(label);
        if (added?.kind === "ellipsis") {
          shown.menuOpen = !shown.menuOpen;
          shown.changes += 1;
        } else if (added?.kind === "classic-command") {
          shown.experience = "classic";
          shown.menuOpen = false;
          shown.changes += 1;
        }
      },
      async evaluate() {
        return { ...(controlDetails[label] || { text: label, aria: "", title: "", href: "" }), ...(added ? { region: added.region, selected: Boolean(added.selected) } : {}) };
      },
      async scrollIntoViewIfNeeded() {},
      async boundingBox() {
        return added?.box || { x: 100, y: 80, width: 120, height: 36 };
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
    getByRole(role, opts) {
      return locatorFor(nameFor(role, opts?.name), role);
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
      if (fn.name === "readinessProbeInPage") return { state: "complete", busy: 0, quietFor: 60_000, changes: shown.changes, text: 200 };
      if (fn.name === "dialogsInPage") return shown.menuOpen ? [{ kind: "menu", title: "More options menu" }] : [];
      if (fn.name === "findInterstitialsInPage" || fn.name === "fuzzyListInPage") return [];
      if (fn.name === "unexpectedPromptInPage" || fn.name === "poweredByInPage") return null;
      if (fn.name === "feedbackPromptInPage") return { prompt: false, skip: false, submit: false };
      return undefined;
    },
    keyboard: {
      async press(key) {
        if (key === "Escape") shown.menuOpen = false;
      },
    },
    viewportSize() {
      return { width: 1440, height: 900 };
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
