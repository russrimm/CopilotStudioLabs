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
 */
export function createFakePlaywright({ labels = ["Settings", "Memory", "Home"], rewriteUrl = (u) => u, screenshot = null, title = "Copilot Studio", pageLabels = ["Settings", "Memory", "Home", "Signed in as ada@contoso.com"] } = {}) {
  const log = { launched: [], goto: [], clicks: [], evaluations: [], screenshots: 0, closed: 0, order: [] };
  let currentUrl = "about:blank";

  const locatorFor = (label) => {
    const visible = Boolean(label) && labels.some((l) => String(label).toLowerCase() === l.toLowerCase() || String(label).toLowerCase().includes(l.toLowerCase()));
    const item = {
      async isVisible() {
        return visible;
      },
      async click() {
        log.clicks.push(label);
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
      log.goto.push(url);
      currentUrl = rewriteUrl(url);
    },
    url() {
      return currentUrl;
    },
    async title() {
      return title;
    },
    async setViewportSize() {},
    async waitForLoadState() {},
    async waitForTimeout() {},
    async bringToFront() {},
    getByRole(_role, opts) {
      return locatorFor(opts?.name ? String(opts.name) : "");
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
      return undefined;
    },
    async screenshot(options = {}) {
      log.screenshots += 1;
      log.order.push("screenshot");
      const bytes = screenshot ? screenshot(log.screenshots, currentUrl) : makePng({ mode: "ui", seed: log.screenshots });
      if (options.path) fs.writeFileSync(options.path, bytes);
      return bytes;
    },
  };

  const playwright = {
    chromium: {
      async launchPersistentContext(dir, options) {
        log.launched.push({ dir, options });
        return {
          pages: () => [page],
          async newPage() {
            return page;
          },
          async close() {
            log.closed += 1;
          },
        };
      },
    },
  };
  return { playwright, page, log };
}
