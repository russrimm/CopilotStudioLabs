// "Is the page ready to photograph?" Single-page apps keep the network busy for a long time and paint a
// skeleton or spinner before their content, so the network going quiet says little. A page counts as ready when
// all of these hold: it has loaded, no loading indicator is visible (aria-busy, progressbar, skeleton or spinner),
// the page has stopped changing for a quiet window, and two pictures in a row are identical.
// Every budget can be changed, and what was waited for is written to the trace.

import crypto from "node:crypto";

import { isBrowserClosedError } from "./lifecycle.mjs";

export const READY_DEFAULTS = Object.freeze({
  maxMs: 20_000,
  loadMs: 8_000,
  quietMs: 700,
  pollMs: 250,
  stableFrames: 2,
  frameGapMs: 350,
});

/** Budgets for an attempt: the defaults, then the caller's, with each retry waiting longer. */
export function readinessBudgets(options = {}, attempt = 1) {
  const merged = { ...READY_DEFAULTS };
  for (const key of Object.keys(READY_DEFAULTS)) {
    const value = Number(options?.[key]);
    if (Number.isFinite(value) && value >= 0) merged[key] = value;
  }
  const factor = attempt > 1 ? 2 : 1;
  return { ...merged, maxMs: Math.min(120_000, merged.maxMs * factor), quietMs: merged.quietMs * (attempt > 1 ? 1.5 : 1) };
}

/**
 * Runs inside the page (it must stay self-contained). Installs a change watcher once and reports how many
 * loading indicators are visible and how long the page has been quiet. Changes inside the companion's own
 * toolbar do not count.
 */
export function readinessProbeInPage() {
  const w = window;
  if (!w.__captureQuiet) {
    const state = { last: Date.now(), count: 0 };
    w.__captureQuiet = state;
    try {
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          const target = record.target && record.target.nodeType === 1 ? record.target : record.target && record.target.parentElement;
          if (target && target.closest && target.closest("[data-capture-ui]")) continue;
          state.last = Date.now();
          state.count += 1;
          break;
        }
      });
      observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    } catch {
      // A page that cannot be observed is judged by its indicators and pictures only.
    }
  }
  const selector = '[aria-busy="true"], [role="progressbar"], progress, [class*="skeleton" i], [class*="spinner" i], [class*="shimmer" i], [class*="loading" i], [data-loading="true"]';
  let busy = 0;
  for (const el of document.querySelectorAll(selector)) {
    if (el.closest('[hidden], [aria-hidden="true"], [data-capture-ui]')) continue;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0") busy += 1;
  }
  return { state: document.readyState, busy, quietFor: Date.now() - w.__captureQuiet.last, changes: w.__captureQuiet.count, text: (document.body && document.body.innerText ? document.body.innerText.length : 0) };
}

const hash = (buffer) => crypto.createHash("sha1").update(buffer).digest("hex");

async function takeFrame(page) {
  const frame = await page.screenshot({ type: "jpeg", quality: 35 });
  return Buffer.isBuffer(frame) ? hash(frame) : null;
}

/**
 * Wait until the page is ready, or the budget runs out. Never throws for a slow page; a closed browser throws.
 * @returns {Promise<{ready: boolean, waitedMs: number, loaded: boolean, busy: number, quietFor: number|null, framesStable: boolean|null, skipped?: boolean}>}
 */
export async function waitUntilReady(page, { budgets = READY_DEFAULTS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now(), trace = null, shot = null, attempt = 1 } = {}) {
  const started = now();
  // Time is the larger of the clock and the waits themselves, so a caller that skips real sleeping (a test) cannot spin.
  let slept = 0;
  const nap = async (ms) => {
    await sleep(ms);
    slept += ms;
  };
  const elapsed = () => Math.max(now() - started, slept);
  const result = { ready: false, waitedMs: 0, loaded: false, busy: 0, quietFor: null, framesStable: null };
  if (typeof page?.evaluate !== "function") {
    return { ...result, ready: true, skipped: true };
  }
  try {
    if (typeof page.waitForLoadState === "function") {
      await page.waitForLoadState("load", { timeout: budgets.loadMs }).then(
        () => {
          result.loaded = true;
        },
        (err) => {
          if (isBrowserClosedError(err)) throw err;
        },
      );
    }
    for (;;) {
      let probe = null;
      try {
        probe = await page.evaluate(readinessProbeInPage);
      } catch (err) {
        // The page moved on while it was being read (a navigation): look again.
        if (isBrowserClosedError(err)) throw err;
      }
      if (probe) {
        result.busy = probe.busy;
        result.quietFor = probe.quietFor;
        if (probe.state === "complete") result.loaded = true;
        if (probe.busy === 0 && probe.quietFor >= budgets.quietMs && result.loaded) {
          const frames = [];
          for (let i = 0; i < Math.max(1, budgets.stableFrames); i += 1) {
            if (i > 0) await nap(budgets.frameGapMs);
            frames.push(await takeFrame(page).catch((err) => {
              if (isBrowserClosedError(err)) throw err;
              return null;
            }));
          }
          result.framesStable = frames.every((f) => f !== null && f === frames[0]);
          if (result.framesStable) {
            result.ready = true;
            break;
          }
        }
      }
      if (elapsed() >= budgets.maxMs) break;
      await nap(budgets.pollMs);
    }
  } finally {
    result.waitedMs = elapsed();
    trace?.event("ready-wait", { shot, attempt, ready: result.ready, waitedMs: result.waitedMs, loaded: result.loaded, indicatorsVisible: result.busy, quietMs: result.quietFor, framesStable: result.framesStable, maxMs: budgets.maxMs, quietNeededMs: budgets.quietMs });
  }
  return result;
}
