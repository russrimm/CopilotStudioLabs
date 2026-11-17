// Finding the right control. A label like "Knowledge" can be a navigation item, a card on the home page, and a
// heading all at once, and clicking the wrong one is how the capture ended up on a page that creates apps. The
// policy is strict and always the same:
//
//   1. Only a control whose accessible name IS the label (ignoring case and spacing) is a candidate. Never a
//      control that merely contains the words, and never plain text that happens to match.
//   2. Candidates must be visible, and must not be off limits (delete, sign out, publish, create, save...).
//   3. Candidates in the expected landmark (the navigation, a tab list, a menu) come first.
//   4. A click that changes nothing is not success: the next candidate is tried.
//
// Every decision is returned as a record, so the trace and the portal can say what was done and why.

import { controlIsOffLimits, describeControlInPage } from "./guard.mjs";
import { labelIsVisible, visibleWordSet } from "./labels.mjs";
import { isBrowserClosedError } from "./lifecycle.mjs";
import { readinessProbeInPage } from "./readiness.mjs";
import { maskedPath } from "./targets.mjs";

const escapeRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A case-insensitive, whole-name match for an accessible name. */
export function exactName(label) {
  return new RegExp(`^\\s*${escapeRegex(String(label).trim().replace(/\s+/g, " "))}\\s*$`, "i");
}

export const NAVIGATION_ROLES = Object.freeze(["link", "tab", "treeitem", "menuitem", "button"]);
const MAX_PER_ROLE = 4;

const REGION_RANK = { nav: 0, main: 1, other: 2, header: 3, dialog: 4 };

/**
 * Every visible control named exactly `label`, with where it is and whether it is allowed.
 * `regions` limits where a control may be (for example only the navigation).
 * @returns {Promise<Array<{locator: object, role: string, region: string, selected: boolean, off: object|null, href: string}>>}
 */
export async function findControls(page, label, { roles = NAVIGATION_ROLES, regions = null } = {}) {
  const found = [];
  if (!label || typeof page?.getByRole !== "function") return found;
  const name = exactName(label);
  for (const role of roles) {
    let list;
    try {
      list = page.getByRole(role, { name });
    } catch (err) {
      if (isBrowserClosedError(err)) throw err;
      continue;
    }
    const count = Math.min(await list.count().catch(() => 0), MAX_PER_ROLE);
    for (let i = 0; i < count; i += 1) {
      const item = list.nth(i);
      let visible = false;
      try {
        visible = await item.isVisible();
      } catch (err) {
        if (isBrowserClosedError(err)) throw err;
      }
      if (!visible) continue;
      let description = null;
      try {
        description = typeof item.evaluate === "function" ? await item.evaluate(describeControlInPage) : null;
      } catch (err) {
        if (isBrowserClosedError(err)) throw err;
      }
      const region = description?.region || "other";
      if (regions && !regions.includes(region)) continue;
      found.push({ locator: item, role, region, selected: Boolean(description?.selected), off: controlIsOffLimits(description), href: description?.href || "" });
    }
  }
  return found.sort((a, b) => (REGION_RANK[a.region] ?? 9) - (REGION_RANK[b.region] ?? 9));
}

/** Where the page is now, as a masked address, for records. */
function here(page) {
  try {
    return typeof page.url === "function" ? maskedPath(page.url()) : "";
  } catch {
    return "";
  }
}

async function domChanges(page) {
  if (typeof page.evaluate !== "function") return null;
  try {
    // Installs the change watcher on first use, so the count is comparable before and after a click.
    const probe = await page.evaluate(readinessProbeInPage);
    return typeof probe?.changes === "number" ? probe.changes : null;
  } catch (err) {
    if (isBrowserClosedError(err)) throw err;
    return null;
  }
}

/** Whether a control now says it is the open tab or section. */
async function isNowSelected(candidate) {
  try {
    const description = typeof candidate.locator.evaluate === "function" ? await candidate.locator.evaluate(describeControlInPage) : null;
    return Boolean(description?.selected);
  } catch {
    return false;
  }
}

/** Click one candidate and say whether the page changed (a new address, a changed page, or the control now open). */
async function clickAndObserve(page, candidate, { stepTimeoutMs = 3000, sleep }) {
  const urlBefore = typeof page.url === "function" ? page.url() : "";
  const changesBefore = await domChanges(page);
  try {
    await candidate.locator.scrollIntoViewIfNeeded?.({ timeout: stepTimeoutMs }).catch(() => {});
    await candidate.locator.click({ timeout: stepTimeoutMs });
  } catch (err) {
    if (isBrowserClosedError(err)) throw err;
    return { clicked: false, changed: false, error: String(err?.message || err).split("\n")[0].slice(0, 160) };
  }
  await page.waitForLoadState?.("domcontentloaded", { timeout: 4000 }).catch(() => {});
  await sleep(450);
  const urlAfter = typeof page.url === "function" ? page.url() : "";
  const changesAfter = await domChanges(page);
  const changed = urlAfter !== urlBefore || (changesBefore !== null && changesAfter !== null && changesAfter > changesBefore) || (!candidate.selected && (await isNowSelected(candidate)));
  return { clicked: true, changed, urlChanged: urlAfter !== urlBefore };
}

/**
 * Open a navigation item by its exact name, trying the next candidate when a click changes nothing.
 * @returns {Promise<{action: string, label: string, found: boolean, ok: boolean, urlBefore: string, urlAfter: string, tried: number, note?: string}>}
 */
export async function openNavigationItem(page, label, { roles = ["link", "tab", "treeitem", "menuitem"], regions = ["nav"], sleep, trace = null, stepTimeoutMs = 3000, action = "open" } = {}) {
  const record = { action, label, found: false, ok: false, urlBefore: here(page), urlAfter: here(page), tried: 0 };
  const candidates = await findControls(page, label, { roles, regions });
  const allowed = candidates.filter((c) => !c.off);
  for (const blocked of candidates.filter((c) => c.off)) trace?.event("click-blocked", { label, reason: `control ${blocked.off.why} is ${blocked.off.reason}` });
  if (!allowed.length) {
    record.note = candidates.length ? "every control with that name is off limits" : "no control with that exact name in the navigation";
    trace?.event("step", record);
    return record;
  }
  record.found = true;
  for (const candidate of allowed.slice(0, 3)) {
    if (candidate.selected) {
      record.ok = true;
      record.note = "already open";
      break;
    }
    record.tried += 1;
    const outcome = await clickAndObserve(page, candidate, { stepTimeoutMs, sleep });
    record.urlAfter = here(page);
    if (outcome.clicked && outcome.changed) {
      record.ok = true;
      break;
    }
    record.note = outcome.error ? "the click failed" : "the click changed nothing";
  }
  trace?.event("step", record);
  return record;
}

/** The visible words on the page, for deciding whether a label is already showing. */
export async function visibleWords(page, collect) {
  const lines = await collect(page).catch(() => []);
  return visibleWordSet(lines);
}

/**
 * Make a label showing: nothing to do when it is already on screen as the open tab or section, otherwise click
 * the navigation item or tab with that exact name. A label that is plain text (a heading) counts as showing
 * when its words are visible.
 * @returns {Promise<{action: string, label: string, found: boolean, ok: boolean, required: boolean, urlBefore: string, urlAfter: string, tried: number, note?: string}>}
 */
export async function revealLabel(page, label, { required = false, collect, sleep, trace = null, stepTimeoutMs = 3000 } = {}) {
  const record = { action: "reveal", label, found: false, ok: false, required: Boolean(required), urlBefore: here(page), urlAfter: here(page), tried: 0 };
  const candidates = (await findControls(page, label, { roles: ["tab", "treeitem", "menuitem", "link", "button"], regions: ["nav"] })).filter((c) => !c.off);
  if (candidates.length) {
    record.found = true;
    for (const candidate of candidates.slice(0, 3)) {
      if (candidate.selected) {
        record.ok = true;
        record.note = "already open";
        break;
      }
      record.tried += 1;
      const outcome = await clickAndObserve(page, candidate, { stepTimeoutMs, sleep });
      record.urlAfter = here(page);
      if (outcome.clicked && outcome.changed) {
        record.ok = true;
        break;
      }
      record.note = outcome.error ? "the click failed" : "the click changed nothing";
    }
  } else {
    const words = await visibleWords(page, collect);
    if (words.size && labelIsVisible(label, words)) {
      record.found = true;
      record.ok = true;
      record.note = "already visible";
    } else {
      record.note = "not on the screen and no control with that exact name";
    }
  }
  trace?.event("step", record);
  return record;
}
