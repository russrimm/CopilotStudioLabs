/**
 * Pills in the Screenshot Center, for the browser test that checks none of them is cut off (test/screenshot-center-pills-browser.test.js)
 * and for the before and after pictures: the functions below run inside the page, so each one stands alone (Playwright serializes it).
 * Everything here is synthetic: no real tenant, name, or picture.
 */

/** Every kind of pill the Screenshot Center and the lab list put on a card, a step, or a header. */
export const PILL_SELECTOR = ".sc-chip, .sc-fig, .sc-thumb-busy, .sc-copy-ack, .lb-brand-chip, .lb-gen-chips li";

/** The nearest box a pill has to stay inside. */
export const PILL_HOLDER_SELECTOR = ".sc-card, .sc-cause, .sc-step, .sc-module, .sc-center, .lb-check-item, .rh-row, .lb-gen-item";

/** The words the wide pills carry in the real product, plus a worst case: one long word with no spaces. */
export const PILL_REASONS = Object.freeze([
  "This screen has not been seen in the product yet",
  "This screen needs another Microsoft product and a second sign-in first",
  "Needs-a-practice-agent-in-another-environment-before-it-can-be-captured",
]);

/**
 * Make the first cards look like the one a person reported: queued, a figure number, and an amber reason that is wider than a narrow card.
 * It changes the Center's own state and draws it again with the real code, so the markup and the classes are the ones people get.
 */
export function showPillScenario({ labId, reasons }) {
  const lab = scLab(labId);
  const shots = lab.state.shots;
  const person = (label) => ({
    mode: "autonomous",
    automation: {
      state: "person",
      reason: "unseen",
      reasonLabel: label,
      why: "The computer has not seen this screen in the real product, so it does not guess which controls to use.",
      manual: ["Choose Show me once and set the screen up the way you normally would.", "Press Capture this screen."],
    },
  });
  reasons.forEach((label, index) => {
    const shot = shots[index];
    if (!shot) return;
    shot.captured = false;
    shot.needsReview = false;
    shot.figure = `4.${index + 1}`;
    shot.caption = index === 0 ? "Part 4 \u00b7 Topics & trigger phrases" : shot.caption;
    shot.capture = person(label);
  });
  lab.job = { status: "running", shots: shots[0] ? [{ filename: shots[0].filename, status: "pending" }] : [] };
  scRenderInto(document.getElementById("lb-result-screenshots"), labId);
}

/** Put one long text in every visible pill (the words inside a Copy confirmation, not its icon). Returns how many it changed. */
export function stretchPills({ selector, text }) {
  let changed = 0;
  for (const el of document.querySelectorAll(selector)) {
    if (!el.getClientRects().length) continue;
    const target = el.querySelector(".sc-copy-ack-text") || el;
    if (target.children.length) continue;
    target.textContent = text;
    changed += 1;
  }
  return changed;
}

/** For each visible pill: how wide its text wants to be against how wide it is, and where it sits against the box that holds it. */
export function measurePills({ selector, holderSelector }) {
  const rows = [];
  for (const el of document.querySelectorAll(selector)) {
    if (!el.getClientRects().length) continue;
    const box = el.getBoundingClientRect();
    const holder = el.parentElement?.closest(holderSelector);
    const held = holder?.getBoundingClientRect();
    const style = getComputedStyle(el);
    rows.push({
      cls: String(el.className || el.tagName),
      text: el.textContent.trim().slice(0, 40),
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      left: box.left,
      right: box.right,
      width: box.width,
      height: box.height,
      holder: holder ? String(holder.className || holder.tagName) : "",
      holderLeft: held ? held.left : null,
      holderRight: held ? held.right : null,
      radius: parseFloat(style.borderTopLeftRadius) || 0,
      lineHeight: parseFloat(style.lineHeight) || 0,
    });
  }
  return rows;
}

/** A pill's width on one line, whatever room it has: what "compact" means for a short pill. */
export function naturalPillWidth(el) {
  const keep = el.getAttribute("style");
  el.style.whiteSpace = "nowrap";
  el.style.width = "max-content";
  el.style.maxWidth = "none";
  const width = el.getBoundingClientRect().width;
  if (keep === null) el.removeAttribute("style");
  else el.setAttribute("style", keep);
  return width;
}
