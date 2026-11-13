// Build a Lab: the "Previously generated labs" list and its actions
// (open, edit selections, rename, delete). Loaded after lab-builder-wizard.js,
// whose `labBuilder` state, `lbFormatMinutes`, and `lbLoadSelections` it uses.

const lbGen = {
  labs: [],
  loaded: false,
  query: "",
  sort: "newest",
  bound: false,
  deleting: null,
  renaming: null,
  opened: null,
};

const LB_GEN_SORTS = {
  newest: (a, b) => lbGenTime(b) - lbGenTime(a),
  oldest: (a, b) => lbGenTime(a) - lbGenTime(b),
  title: (a, b) => String(a.title).localeCompare(String(b.title), undefined, { sensitivity: "base" }),
  longest: (a, b) => (b.totalMinutes || 0) - (a.totalMinutes || 0),
  shortest: (a, b) => (a.totalMinutes || 0) - (b.totalMinutes || 0),
};

function lbGenTime(lab) {
  const time = Date.parse(lab.generatedAt);
  return Number.isFinite(time) ? time : 0;
}

function lbGenIndustryName(id) {
  if (!id) return "Cross-industry";
  return labBuilder.industries.find((i) => i.id === id)?.name || id;
}

function lbGenLevelName(level) {
  if (!level) return "";
  const label = labBuilder.levels.find((l) => l.level === level)?.label;
  return label ? `Level ${level}: ${label}` : `Level ${level}`;
}

function lbGenHarnessName(id) {
  return id ? labBuilder.harnesses.find((h) => h.id === id)?.name || id : "";
}

/** The product names a lab covers. A lab saved before products existed is a Copilot Studio lab. */
function lbGenProductNames(lab) {
  const ids = Array.isArray(lab.products) && lab.products.length ? lab.products : [lab.product || "copilot-studio"];
  return ids.map((id) => labBuilder.products.find((p) => p.id === id)?.shortName || id);
}

function lbGenSearchText(lab) {
  return [lab.title, lab.notes, lab.labId, lbGenIndustryName(lab.vertical), lbGenHarnessName(lab.harness), lbGenLevelName(lab.level), ...lbGenProductNames(lab)]
    .join(" ")
    .toLowerCase();
}

function lbGenVisible() {
  const query = lbGen.query.trim().toLowerCase();
  const labs = query ? lbGen.labs.filter((lab) => lbGenSearchText(lab).includes(query)) : [...lbGen.labs];
  return labs.sort(LB_GEN_SORTS[lbGen.sort] || LB_GEN_SORTS.newest);
}

function lbGenFind(labId) {
  return lbGen.labs.find((lab) => lab.labId === labId);
}

function lbGenAnnounce(message) {
  const el = document.getElementById("lb-gen-count");
  if (el) el.textContent = message;
}

function lbGenCountMessage(shown) {
  const total = lbGen.labs.length;
  if (lbGen.query.trim() && !shown) return `No generated labs match "${lbGen.query.trim()}". ${total} saved in all.`;
  if (lbGen.query.trim()) return `Showing ${shown} of ${total} generated lab${total === 1 ? "" : "s"}.`;
  return `${total} generated lab${total === 1 ? "" : "s"}.`;
}

function lbGenItemHtml(lab) {
  const id = escapeHtml(lab.labId);
  const title = escapeHtml(lab.title || lab.labId);
  const created = new Date(lab.generatedAt);
  const createdText = Number.isNaN(created.getTime()) ? "date unknown" : created.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  const chips = [...lbGenProductNames(lab).map((name) => escapeHtml(name)), escapeHtml(lbGenIndustryName(lab.vertical))];
  if (lab.level) chips.push(escapeHtml(lbGenLevelName(lab.level)));
  else chips.push("Level not recorded");
  if (lab.harness) chips.push(escapeHtml(lbGenHarnessName(lab.harness)));
  chips.push(`About ${escapeHtml(lbFormatMinutes(lab.totalMinutes || 0))} (estimate)`);
  const recaps = Number(lab.prerequisiteCount) || 0;
  const topics = Math.max((Number(lab.moduleCount) || 0) - recaps, 0);
  chips.push(`${topics} topic${topics === 1 ? "" : "s"}`);
  if (recaps) chips.push(`${recaps} prerequisite recap${recaps === 1 ? "" : "s"}`);
  const chipHtml = chips.map((chip) => `<li>${chip}</li>`).join("");
  let validation = '<li>Checks not recorded</li>';
  if (lab.validation) {
    validation = lab.validation.failed
      ? `<li class="lb-gen-chip-fail">Checks: ${Number(lab.validation.failed)} failed, ${Number(lab.validation.passed)} passed</li>`
      : `<li>Checks: all ${Number(lab.validation.passed)} passed</li>`;
  }
  const editable = Boolean(lab.selections);
  const legacy = editable
    ? ""
    : `<p class="lb-gen-legacy">This lab was built before its choices were saved, so its selections cannot be edited. You can open, rename, or delete it, or start a new lab in the wizard.</p>`;
  const edit = editable
    ? `<button type="button" class="btn btn-sm" data-gen-action="edit" aria-label="Edit selections for ${title}">Edit selections</button>`
    : `<button type="button" class="btn btn-sm" data-gen-action="new" aria-label="Start a new lab in the wizard">Start a new lab</button>`;
  return `
    <li class="lb-gen-item" data-lab-id="${id}">
      <h4 class="lb-gen-title">${title}</h4>
      <p class="lb-gen-meta">Created <time datetime="${escapeHtml(lab.generatedAt || "")}">${escapeHtml(createdText)}</time>${lab.updatedAt ? " · edited" : ""}</p>
      <ul class="lb-gen-chips" aria-label="Details for ${title}">${chipHtml}${validation}</ul>
      ${lab.notes ? `<p class="lb-gen-notes">${escapeHtml(lab.notes)}</p>` : ""}
      ${legacy}
      <div class="lb-gen-actions">
        <button type="button" class="btn btn-sm" data-gen-action="open" aria-label="Open ${title}">Open</button>
        ${edit}
        <button type="button" class="btn btn-sm" data-gen-action="rename" aria-label="Rename ${title}">Rename</button>
        <button type="button" class="btn btn-sm" data-gen-action="delete" aria-label="Delete ${title}">Delete</button>
      </div>
    </li>`;
}

function lbGenRender(message) {
  const list = document.getElementById("lb-generated-list");
  const toolbar = document.getElementById("lb-gen-toolbar");
  if (!list) return;
  toolbar.hidden = !lbGen.labs.length;
  if (!lbGen.labs.length) {
    list.className = "scenario-empty";
    list.textContent = "None yet. Build one above and it will appear here.";
    lbGenAnnounce(message || "No generated labs yet.");
    return;
  }
  const visible = lbGenVisible();
  if (!visible.length) {
    list.className = "scenario-empty";
    list.textContent = "No generated labs match your search. Clear the search to see them all.";
  } else {
    list.className = "";
    list.innerHTML = `<ul class="lb-gen-list" aria-label="Generated labs">${visible.map(lbGenItemHtml).join("")}</ul>`;
  }
  lbGenAnnounce(message || lbGenCountMessage(visible.length));
}

async function lbLoadGenerated() {
  const list = document.getElementById("lb-generated-list");
  if (!list) return;
  lbGenBind();
  try {
    const res = await fetch("/api/lab-builder/generated");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    lbGen.labs = data.labs || [];
    lbGen.loaded = true;
    lbGenRender();
  } catch (err) {
    document.getElementById("lb-gen-toolbar").hidden = true;
    lbGenAnnounce("");
    list.className = "scenario-empty";
    list.innerHTML = `<span role="alert">Could not list generated labs: ${escapeHtml(err.message)}</span> <button type="button" class="btn btn-sm" data-gen-action="retry">Try again</button>`;
  }
}

function lbGenFocusAfterRemoval(index) {
  const items = [...document.querySelectorAll("#lb-generated-list .lb-gen-item")];
  const next = items[Math.min(index, items.length - 1)];
  const target = next?.querySelector('[data-gen-action="open"]') || document.getElementById("lb-generated-heading");
  target?.focus();
}

function lbGenFocusAction(labId, action) {
  document.querySelector(`#lb-generated-list [data-lab-id="${CSS.escape(labId)}"] [data-gen-action="${action}"]`)?.focus();
}

// ── Open ────────────────────────────────────────────────────────────────────
async function lbOpenGenerated(labId) {
  const lab = lbGenFind(labId);
  const panel = document.getElementById("lb-result-panel");
  const meta = document.getElementById("lb-result-meta");
  const body = document.getElementById("lb-result-body");
  if (!lab || !panel || !meta || !body) return;
  lbGen.opened = labId;
  meta.innerHTML = `
    <div style="font-size: 16px; font-weight: 600;">${escapeHtml(lab.title)}</div>
    <div class="scenario-pill-list">
      <span class="scenario-pill">${escapeHtml(lab.difficulty || "")}</span>
      <span class="scenario-pill">About ${escapeHtml(lbFormatMinutes(lab.totalMinutes || 0))}</span>
      <span class="scenario-pill">${Number(lab.moduleCount) || 0} topics</span>
    </div>
    ${lab.notes ? `<p class="lb-gen-notes" style="margin-top: 10px;">${escapeHtml(lab.notes)}</p>` : ""}
    <div style="margin-top: 10px; font-size: 12px; color: var(--text-muted);">
      Saved to <code>generated-labs/${escapeHtml(lab.labId)}</code> on the portal host.
    </div>
    <div style="margin-top: 12px; display: flex; gap: 10px; flex-wrap: wrap;">
      <button type="button" class="btn btn-sm" data-gen-action="download" data-lab-id="${escapeHtml(lab.labId)}">⬇️ Download index.md</button>
    </div>`;
  body.innerHTML = `
    <div id="lb-result-preview" class="preview-frame" aria-label="Lab preview"><p class="scenario-empty">Loading the preview...</p></div>
    <details class="lb-advanced">
      <summary>View the Markdown source</summary>
      <pre id="lb-result-source" style="white-space: pre-wrap; font-size: 12px; line-height: 1.6;"></pre>
    </details>`;
  panel.style.display = "";
  panel.scrollIntoView({ behavior: "smooth", block: "start" });
  document.getElementById("lb-result-heading")?.focus({ preventScroll: true });
  await lbLoadResultPreview(labId);
}

function lbGenCloseOpened(labId) {
  if (lbGen.opened !== labId) return;
  lbGen.opened = null;
  const panel = document.getElementById("lb-result-panel");
  if (panel) panel.style.display = "none";
}

// ── Delete ──────────────────────────────────────────────────────────────────
function lbGenAskDelete(labId) {
  const lab = lbGenFind(labId);
  const dialog = document.getElementById("lb-gen-delete-dialog");
  if (!lab || !dialog) return;
  lbGen.deleting = labId;
  document.getElementById("lb-gen-delete-title").textContent = `Delete "${lab.title}"?`;
  document.getElementById("lb-gen-delete-desc").textContent =
    `This permanently removes the lab and its images from the portal host (generated-labs/${lab.labId}). It cannot be undone. Hand-written labs are not affected.`;
  document.getElementById("lb-gen-delete-error").textContent = "";
  dialog.showModal();
  document.getElementById("lb-gen-delete-cancel").focus();
}

async function lbGenConfirmDelete() {
  const labId = lbGen.deleting;
  const lab = lbGenFind(labId);
  if (!lab) return;
  const confirm = document.getElementById("lb-gen-delete-confirm");
  const error = document.getElementById("lb-gen-delete-error");
  confirm.disabled = true;
  confirm.setAttribute("aria-busy", "true");
  try {
    const res = await fetch(`/api/lab-builder/generated/${encodeURIComponent(labId)}`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 404) throw new Error(data.error || `Request failed (${res.status})`);
    const index = lbGenVisible().findIndex((item) => item.labId === labId);
    lbGen.labs = lbGen.labs.filter((item) => item.labId !== labId);
    lbGenCloseOpened(labId);
    if (labBuilder.editing?.labId === labId) lbStopEditing(true);
    document.getElementById("lb-gen-delete-dialog").close();
    lbGen.deleting = null;
    lbGenRender(`Deleted "${lab.title}". ${lbGen.labs.length} generated lab${lbGen.labs.length === 1 ? "" : "s"} left.`);
    lbGenFocusAfterRemoval(index);
    toast(`Deleted "${lab.title}"`, "success");
  } catch (err) {
    error.textContent = `Could not delete the lab: ${err.message}`;
  } finally {
    confirm.disabled = false;
    confirm.removeAttribute("aria-busy");
  }
}

// ── Rename ──────────────────────────────────────────────────────────────────
function lbGenAskRename(labId) {
  const lab = lbGenFind(labId);
  const dialog = document.getElementById("lb-gen-rename-dialog");
  if (!lab || !dialog) return;
  lbGen.renaming = labId;
  document.getElementById("lb-gen-rename-title").value = lab.title || "";
  document.getElementById("lb-gen-rename-notes").value = lab.notes || "";
  document.getElementById("lb-gen-rename-error").textContent = "";
  dialog.showModal();
  const input = document.getElementById("lb-gen-rename-title");
  input.focus();
  input.select();
}

async function lbGenSubmitRename(event) {
  event.preventDefault();
  const labId = lbGen.renaming;
  const lab = lbGenFind(labId);
  if (!lab) return;
  const titleInput = document.getElementById("lb-gen-rename-title");
  const error = document.getElementById("lb-gen-rename-error");
  const title = titleInput.value.trim();
  if (!title) {
    error.textContent = "Enter a title.";
    titleInput.setAttribute("aria-invalid", "true");
    titleInput.focus();
    return;
  }
  titleInput.removeAttribute("aria-invalid");
  const save = document.getElementById("lb-gen-rename-save");
  save.disabled = true;
  save.setAttribute("aria-busy", "true");
  try {
    const res = await fetch(`/api/lab-builder/generated/${encodeURIComponent(labId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, notes: document.getElementById("lb-gen-rename-notes").value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    const index = lbGen.labs.findIndex((item) => item.labId === labId);
    lbGen.labs[index] = data.lab;
    if (labBuilder.editing?.labId === labId) lbSetEditing(data.lab);
    document.getElementById("lb-gen-rename-dialog").close();
    lbGen.renaming = null;
    lbGenRender(`Saved "${data.lab.title}".`);
    lbGenFocusAction(labId, "rename");
    if (lbGen.opened === labId) lbOpenGenerated(labId);
  } catch (err) {
    error.textContent = `Could not save: ${err.message}`;
  } finally {
    save.disabled = false;
    save.removeAttribute("aria-busy");
  }
}

// ── Wiring ──────────────────────────────────────────────────────────────────
function lbGenBind() {
  if (lbGen.bound) return;
  lbGen.bound = true;
  const root = document.getElementById("panel-labbuilder");
  root?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-gen-action]");
    if (!button) return;
    const labId = button.closest("[data-lab-id]")?.dataset.labId || button.dataset.labId;
    switch (button.dataset.genAction) {
      case "open": lbOpenGenerated(labId); break;
      case "edit": lbEditGenerated(labId); break;
      case "rename": lbGenAskRename(labId); break;
      case "delete": lbGenAskDelete(labId); break;
      case "download": lbDownload(labId); break;
      case "retry": lbLoadGenerated(); break;
      case "new": lbStartNewLab(); break;
    }
  });
  document.getElementById("lb-gen-search")?.addEventListener("input", (event) => {
    lbGen.query = event.target.value;
    lbGenRender();
  });
  document.getElementById("lb-gen-sort")?.addEventListener("change", (event) => {
    lbGen.sort = event.target.value;
    lbGenRender(`Sorted: ${event.target.selectedOptions[0].textContent}.`);
  });
  document.getElementById("lb-gen-delete-cancel")?.addEventListener("click", () => document.getElementById("lb-gen-delete-dialog").close());
  document.getElementById("lb-gen-delete-confirm")?.addEventListener("click", lbGenConfirmDelete);
  document.getElementById("lb-gen-rename-cancel")?.addEventListener("click", () => document.getElementById("lb-gen-rename-dialog").close());
  document.getElementById("lb-gen-rename-form")?.addEventListener("submit", lbGenSubmitRename);
  // Closing with Esc skips the buttons, and focus would otherwise land nowhere.
  document.getElementById("lb-gen-delete-dialog")?.addEventListener("close", () => {
    if (lbGen.deleting) lbGenFocusAction(lbGen.deleting, "delete");
    lbGen.deleting = null;
  });
  document.getElementById("lb-gen-rename-dialog")?.addEventListener("close", () => {
    if (lbGen.renaming) lbGenFocusAction(lbGen.renaming, "rename");
    lbGen.renaming = null;
  });
}

/** Reload the list and open the wizard pre-filled from a saved lab. */
async function lbEditGenerated(labId) {
  const lab = lbGenFind(labId);
  if (!lab?.selections) return;
  try {
    await lbLoadSelections(lab);
  } catch (err) {
    toast(`Could not open the lab's selections: ${err.message}`, "error");
  }
}
