// "Finish your lab" checklist: five plain steps shown above an opened lab, plus the
// small "N of 5 ready" chip on each saved-lab card. It reads what the Screenshot
// Center already knows (scLab, scCounts, scCheckStateOf) and falls back to the
// saved-lab list when a lab has not been opened yet.

const LB_CHECKLIST_TOTAL = 5;
const lbChecklistMemoryFlags = new Map();

function lbChecklistFlag(labId, name) {
  const key = `lb-lab-flag:${labId}:${name}`;
  try {
    return localStorage.getItem(key) === "1" || lbChecklistMemoryFlags.get(key) === true;
  } catch {
    return lbChecklistMemoryFlags.get(key) === true;
  }
}

function lbChecklistSetFlag(labId, name) {
  const key = `lb-lab-flag:${labId}:${name}`;
  lbChecklistMemoryFlags.set(key, true);
  try {
    localStorage.setItem(key, "1");
  } catch {
    /* storage unavailable: the flag lasts for this page view */
  }
}

/**
 * The five steps and where each stands.
 * @param {object} input `reviewed`, `shared`, `branding` ({ customized, profileName, profileChanged }),
 *   `shots` (scCounts; `total` and `captured` give the "N of M captured" count), `check` ({ state: not-checked|up-to-date|docs-updated|ungrounded, changed })
 */
function lbChecklistItems(input) {
  const shots = input.shots || {};
  const items = [];

  items.push(
    input.reviewed
      ? { id: "review", title: "Review the lab", status: "done", detail: "You read through the lab.", action: "Read it again" }
      : { id: "review", title: "Review the lab", status: "todo", detail: "Read through the lab and make sure it fits your audience.", action: "Go to the preview" },
  );

  const branding = input.branding || {};
  if (branding.customized && branding.profileChanged) {
    items.push({
      id: "branding",
      title: "Customize branding",
      status: "attention",
      detail: `The ${branding.profileName || "brand"} profile changed after this lab was built. Update the lab from the profile.`,
      action: "Open customization",
      chip: branding.profileName || "",
    });
  } else if (branding.customized) {
    items.push({
      id: "branding",
      title: "Customize branding",
      status: "done",
      detail: branding.profileName ? `Using the ${branding.profileName} brand profile.` : "This lab has its own branding.",
      action: "Open customization",
      chip: branding.profileName || "",
    });
  } else {
    items.push({
      id: "branding",
      title: "Customize branding",
      status: "todo",
      detail: "This lab uses the default look. Pick a brand profile to add your logo and colors.",
      action: "Open customization",
      chip: "",
    });
  }

  const waiting = scCount(shots.toCapture) + scCount(shots.manual);
  const outdated = scCount(shots.outdated);
  const review = scCount(shots.needsReview);
  // The same "N of M captured" the lab card and the Screenshot Center show, from the same helper.
  const progress = scCaptureProgress({ total: shots.total, captured: shots.captured });
  if (shots.unknown) {
    items.push({ id: "screenshots", title: "Capture screenshots", status: "todo", detail: "Open the Screenshot Center to see which screenshots are captured.", action: "Open Screenshot Center" });
  } else if (!scCount(shots.total)) {
    items.push({ id: "screenshots", title: "Capture screenshots", status: "done", detail: "This lab has no screenshots to capture.", action: "Open Screenshot Center" });
  } else if (!waiting && !outdated && !review) {
    items.push({ id: "screenshots", title: "Capture screenshots", status: "done", detail: `${progress.text}. Nothing is left to capture.`, action: "Open Screenshot Center" });
  } else {
    const parts = [];
    if (waiting) parts.push(`${waiting} pending`);
    if (outdated) parts.push(`${outdated} outdated`);
    if (review) parts.push(`${review} need review`);
    items.push({
      id: "screenshots",
      title: "Capture screenshots",
      status: outdated || review ? "attention" : "todo",
      detail: `${progress.text}. ${parts.join(", ")}. Capture them on your computer or add them by hand.`,
      action: "Open Screenshot Center",
    });
  }

  const check = input.check || { state: "not-checked", changed: 0 };
  if (check.state === "up-to-date") {
    items.push({ id: "check", title: "Check against Microsoft Learn", status: "done", detail: "Checked. This lab matches the current Microsoft Learn pages.", action: "Check again" });
  } else if (check.state === "ungrounded") {
    items.push({ id: "check", title: "Check against Microsoft Learn", status: "done", detail: "No Microsoft Learn pages are recorded for this lab, so there is nothing to compare.", action: "Check again" });
  } else if (check.state === "docs-updated") {
    items.push({
      id: "check",
      title: "Check against Microsoft Learn",
      status: "attention",
      detail: `${scPlural(Math.max(1, scCount(check.changed)), "module")} changed on Microsoft Learn since this lab was built.`,
      action: "Update the lab",
    });
  } else {
    items.push({ id: "check", title: "Check against Microsoft Learn", status: "todo", detail: "Not checked yet. Compare this lab with the current Microsoft Learn pages.", action: "Check now" });
  }

  items.push(
    input.shared
      ? { id: "share", title: "Download or share", status: "done", detail: "You downloaded or printed this lab.", action: "Go to downloads" }
      : { id: "share", title: "Download or share", status: "todo", detail: "Download it as a ZIP, Word, PowerPoint, or HTML file, or print it.", action: "Go to downloads" },
  );
  return items;
}

function lbChecklistDoneCount(items) {
  return items.filter((item) => item.status === "done").length;
}

function lbChecklistListLab(labId) {
  return typeof lbGenFind === "function" ? lbGenFind(labId) : null;
}

/** Input for a saved lab from the list data alone (no network, no open panel). */
function lbChecklistInputFromListLab(lab) {
  const shots = lab?.screenshots || {};
  const drift = typeof lbNormalizeLabLearnDrift === "function" ? lbNormalizeLabLearnDrift(lab) : { status: "not-checked", driftedModuleCount: 0 };
  const checkState =
    drift.status === "docs-updated" ? "docs-updated" : drift.status === "ungrounded" ? "ungrounded" : drift.status === "up-to-date" || drift.status === "missing-screenshot" ? "up-to-date" : "not-checked";
  return {
    reviewed: lbChecklistFlag(lab?.labId, "reviewed"),
    shared: lbChecklistFlag(lab?.labId, "shared"),
    branding: { customized: Boolean(lab?.selections?.brandProfileId), profileName: "", profileChanged: false },
    shots: {
      unknown: !lab?.screenshots,
      total: scCount(shots.total),
      captured: scCaptureProgress(shots).captured,
      toCapture: scCount(shots.pending),
      manual: 0,
      outdated: scCount(shots.stale),
      needsReview: 0,
    },
    check: { state: checkState, changed: drift.driftedModuleCount },
  };
}

/** Input for an opened lab: the live Screenshot Center state when it has loaded, else the list data. */
function lbChecklistInput(labId) {
  const base = lbChecklistInputFromListLab(lbChecklistListLab(labId) || { labId });
  const center = typeof scLab === "function" ? scLab(labId) : null;
  if (center?.state) {
    const changed = scCount(center.state.summary?.docsUpdatedModules) || scCount(center.state.summary?.stale);
    base.shots = scCounts(center.state);
    base.check = { state: scCheckStateOf(center.state), changed };
  }
  if (center?.brand?.loaded) {
    base.branding = { customized: Boolean(center.brand.customized), profileName: center.brand.profileName || "", profileChanged: Boolean(center.brand.profileChanged) };
  }
  return base;
}

function lbChecklistChipText(lab) {
  return `${lbChecklistDoneCount(lbChecklistItems(lbChecklistInputFromListLab(lab)))} of ${LB_CHECKLIST_TOTAL} ready`;
}

/** The small readiness chip on a saved-lab card. */
function lbChecklistChipHtml(lab) {
  const text = lbChecklistChipText(lab);
  const done = lbChecklistDoneCount(lbChecklistItems(lbChecklistInputFromListLab(lab)));
  return `<li class="lb-gen-ready-chip" data-ready="${done}" aria-label="Lab checklist: ${done} of ${LB_CHECKLIST_TOTAL} steps done">${text}</li>`;
}

const LB_CHECKLIST_ICONS = Object.freeze({ done: "\u25cf", todo: "\u25cb", attention: "!" });
const LB_CHECKLIST_STATUS_TEXT = Object.freeze({ done: "Done", todo: "To do", attention: "Needs attention" });
const LB_CHECKLIST_STATUS_TONE = Object.freeze({ done: "ok", todo: "neutral", attention: "warn" });

function lbBuildChecklist(labId, items) {
  const done = lbChecklistDoneCount(items);
  const section = scEl("section", { class: "lb-checklist", attrs: { "aria-labelledby": "lb-checklist-heading" }, data: { labId } });
  const head = scEl("div", { class: "lb-checklist-head" });
  head.appendChild(scEl("h4", { id: "lb-checklist-heading", class: "lb-checklist-title", text: "Finish your lab", attrs: { tabindex: "-1" } }));
  head.appendChild(scEl("span", { class: "lb-checklist-summary", text: `${done} of ${items.length} done` }));
  section.appendChild(head);
  const bar = scEl("div", {
    class: "lb-checklist-bar",
    attrs: { role: "progressbar", "aria-labelledby": "lb-checklist-heading", "aria-valuemin": "0", "aria-valuemax": String(items.length), "aria-valuenow": String(done), "aria-valuetext": `${done} of ${items.length} steps done` },
  });
  const fill = scEl("div", { class: "lb-checklist-bar-fill" });
  fill.style.width = `${Math.round((done / items.length) * 100)}%`;
  bar.appendChild(fill);
  section.appendChild(bar);

  const list = scEl("ol", { class: "lb-checklist-list" });
  // Only the next thing to do is a primary button, so the result never shows several competing calls to action.
  const next = items.find((item) => item.status === "attention") || items.find((item) => item.status !== "done");
  for (const item of items) {
    const li = scEl("li", { class: "lb-check-item", data: { status: item.status, item: item.id } });
    li.appendChild(scEl("span", { class: "lb-check-icon", text: LB_CHECKLIST_ICONS[item.status], attrs: { "aria-hidden": "true" } }));
    const body = scEl("div", { class: "lb-check-body" });
    const title = scEl("p", { class: "lb-check-title" });
    title.appendChild(scEl("strong", { text: item.title }));
    title.appendChild(scChip(LB_CHECKLIST_STATUS_TEXT[item.status], LB_CHECKLIST_STATUS_TONE[item.status]));
    if (item.chip) title.appendChild(scEl("span", { class: "lb-brand-chip", text: `Brand: ${item.chip}` }));
    body.appendChild(title);
    body.appendChild(scEl("p", { class: "lb-check-detail", text: item.detail }));
    li.appendChild(body);
    li.appendChild(
      scEl("button", {
        class: `btn btn-sm${item === next ? " btn-primary" : ""}`,
        text: item.action,
        attrs: { type: "button", "aria-label": `${item.action}: ${item.title}` },
        data: { clAction: item.id, labId },
      }),
    );
    list.appendChild(li);
  }
  section.appendChild(list);
  section.addEventListener("click", (event) => {
    const button = event.target?.closest?.("[data-cl-action]");
    if (button) lbChecklistGo(labId, button.dataset.clAction);
  });
  return section;
}

/** Draw the checklist for an opened lab into `#lb-result-checklist`. */
function lbRenderLabChecklist(labId) {
  const host = document.getElementById("lb-result-checklist");
  if (!host || !labId) return;
  const focusKey = host.contains(document.activeElement) ? document.activeElement?.dataset?.clAction : "";
  host.replaceChildren(lbBuildChecklist(labId, lbChecklistItems(lbChecklistInput(labId))));
  if (focusKey) {
    for (const button of host.querySelectorAll("[data-cl-action]")) {
      if (button.dataset.clAction === focusKey) button.focus({ preventScroll: true });
    }
  }
  lbChecklistRefreshChips(labId);
}

function lbChecklistRefreshChips(labId) {
  const lab = lbChecklistListLab(labId);
  if (!lab || typeof document.querySelectorAll !== "function") return;
  for (const chip of document.querySelectorAll(`#lb-generated-list [data-lab-id="${labId}"] .lb-gen-ready-chip`)) {
    const done = lbChecklistDoneCount(lbChecklistItems(lbChecklistInputFromListLab(lab)));
    chip.textContent = `${done} of ${LB_CHECKLIST_TOTAL} ready`;
    chip.setAttribute("aria-label", `Lab checklist: ${done} of ${LB_CHECKLIST_TOTAL} steps done`);
  }
}

/** Called whenever a lab's screenshot state or branding changes. */
function lbChecklistRefresh(labId) {
  if (typeof lbGen !== "undefined" && lbGen?.opened && lbGen.opened !== labId) return;
  lbRenderLabChecklist(labId);
}

function lbChecklistMarkShared(labId) {
  if (!labId) return;
  lbChecklistSetFlag(labId, "shared");
  lbRenderLabChecklist(labId);
  lbChecklistRefreshChips(labId);
}

function lbChecklistFocus(el) {
  if (!el) return false;
  if (!el.hasAttribute("tabindex") && !/^(button|a|input|select|summary)$/i.test(String(el.tagName))) el.setAttribute("tabindex", "-1");
  el.scrollIntoView?.({ behavior: "smooth", block: "start" });
  el.focus?.({ preventScroll: true });
  return true;
}

/** Scroll to and focus the section an item is about. */
function lbChecklistGo(labId, id) {
  switch (id) {
    case "review":
      lbChecklistSetFlag(labId, "reviewed");
      lbChecklistFocus(document.getElementById("lb-result-preview"));
      lbRenderLabChecklist(labId);
      return;
    case "branding": {
      const open = () => {
        const details = document.getElementById("lb-result-customize");
        if (!details) return false;
        details.open = true;
        lbChecklistFocus(details.querySelector("summary") || details);
        return true;
      };
      if (!open() && typeof lbRenderLabCustomizeSection === "function") Promise.resolve(lbRenderLabCustomizeSection(labId)).then(open);
      return;
    }
    case "screenshots":
      lbChecklistFocus(document.getElementById("lb-screenshots-heading"));
      return;
    case "check": {
      const host = document.getElementById("lb-result-screenshots");
      const primary = host?.querySelector('[data-sc-action="primary-check"], [data-sc-action="primary-update"]');
      if (primary) {
        lbChecklistFocus(primary);
        return;
      }
      const advanced = host?.querySelector("[data-sc-advanced]");
      if (advanced) {
        advanced.open = true;
        if (typeof scLab === "function") scLab(labId).ui.advancedOpen = true;
      }
      lbChecklistFocus(host?.querySelector('[data-sc-action="recheck"]') || document.getElementById("lb-screenshots-heading"));
      return;
    }
    case "share":
      lbChecklistFocus(document.querySelector("#lb-result-meta .lb-result-actions button, #lb-result-meta .lb-result-actions a"));
      return;
    default:
  }
}
