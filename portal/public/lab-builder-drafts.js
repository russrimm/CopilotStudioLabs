// ── Saved drafts and the autosave safety net ────────────────────────────────
// "Save and finish later" keeps every wizard choice made so far as a named draft; "Saved drafts" lists them with
// Resume, Rename, Duplicate, and Delete; and a quiet autosave keeps one "unsaved work" copy so a refresh or a closed
// tab never costs anyone their place. Drafts live on the server (see portal/lib/lab-builder/drafts.js), private to the
// signed-in person. This file only serializes the wizard's state (`labBuilder`) and puts it back through the wizard's
// own rehydration path (lbApplySavedSelections, the one "Edit selections" uses), so a draft and a built lab's saved
// selections share one schema. Loaded after lab-builder-wizard.js, which calls the lbDraftsOn... hooks when they exist.

const LB_DRAFT_API = "/api/lab-builder/drafts";
const LB_DRAFT_AUTOSAVE_MS = 2000;
const LB_DRAFT_CHOSEN_ORDER = ["product", "tailor", "topics"];

const lbDraft = {
  drafts: [],
  limit: 50,
  loaded: false,
  loadError: "",
  // The saved draft the wizard is on, and the wizard's choices (see lbDraftKey) right after the last save, resume, or build.
  activeId: null,
  activeName: "",
  baselineKey: null,
  // What the autosave slot holds, what the previous tick saw (a change must hold still for one tick), and whether a slot exists.
  autosaved: null,
  lastSeen: null,
  slotExists: false,
  unsaved: null,
  bannerOpen: false,
  rescueFailed: false,
  busy: false,
  mode: "save",
  targetId: null,
  deleting: null,
  pendingResume: null,
  bound: false,
  timer: null,
};

// ── Serializing the wizard ──────────────────────────────────────────────────
/** The id-to-name index for everything the wizard can name right now, so a draft can say what it lost later. */
function lbDraftNames() {
  const names = new Map();
  for (const feature of lbFeatureList()) names.set(feature.id, feature.name);
  for (const row of lbTopicRows()) names.set(row.id, row.name);
  for (const row of labBuilder.rec?.prerequisites?.topics || []) names.set(row.id, row.name);
  for (const [id, item] of labBuilder.step7Removed) if (item?.name) names.set(id, item.name);
  return names;
}

/** Everything that defines the lab request so far, in the shape the server stores (see drafts.js). */
function lbDraftContent() {
  const sp = lbReadSharepointRawInputs();
  const checkedUrl = lbValidateSharepointSiteUrl(sp.rawUrl);
  const time = Number(document.getElementById("lb-time")?.value || 0);
  const text = (id) => String(document.getElementById(id)?.value || "").trim() || null;
  const products = lbSelectedProductList().map((p) => p.id);
  const features = labBuilder.rec ? [...labBuilder.rec.selectedIds] : [...(labBuilder.picked || [])];
  const picked = labBuilder.picked ? [...labBuilder.picked] : null;
  const removed = [...labBuilder.step7Removed].map(([id, item]) => ({ id, wasPicked: item?.wasPicked !== false }));
  const content = {
    selections: {
      products,
      industry: labBuilder.industry || null,
      roles: [...labBuilder.selectedRoles],
      level: labBuilder.level,
      harness: lbHasHarnessProduct() ? labBuilder.harness : null,
      harnessMode: lbHasHarnessProduct() ? labBuilder.harnessMode : "single",
      harnesses: [...labBuilder.harnessOrder],
      differencesFor: labBuilder.differencesFor ? [...labBuilder.differencesFor] : null,
      features,
      excluded: [...labBuilder.excluded],
      excludedSubtopics: lbExcludedSubtopicList(),
      moduleOrder: [...labBuilder.moduleOrder],
      targetMinutes: time > 0 ? Math.round(time) : null,
      customTitle: text("lb-title"),
      agentName: text("lb-agent-name"),
      sharepointSiteName: lbNormalizeSharepointSiteName(sp.rawName) || null,
      sharepointSiteUrl: (checkedUrl.valid ? checkedUrl.url : String(sp.rawUrl || "").trim()) || null,
      useLearnMcp: document.getElementById("lb-use-learn")?.checked !== false,
      useLlm: document.getElementById("lb-use-llm")?.checked !== false,
      includeKnowledgeCheck: lbIncludeKnowledgeCheck(),
      brandProfileId: labBuilder.brand.profileId || null,
      ...(typeof lbAiDraftChoice === "function" ? { ai: lbAiDraftChoice() } : {}),
      brandOverrides: lbBrandOverrides(),
    },
    wizard: {
      step: labBuilder.step,
      furthest: Math.max(labBuilder.step, labBuilder.furthest),
      chosenSteps: LB_DRAFT_CHOSEN_ORDER.filter((id) => labBuilder.chosenSteps.has(id)),
      picked,
      removed,
    },
    labels: {},
  };
  const names = lbDraftNames();
  for (const id of new Set([...features, ...(picked || []), ...content.selections.excluded, ...removed.map((r) => r.id)])) {
    const name = names.get(id);
    if (name && name !== id) content.labels[id] = name;
  }
  for (const id of products) {
    const product = lbProduct(id);
    if (product) content.labels[id] = product.shortName || product.name;
  }
  return content;
}

/** What identifies a state for "has it changed?", position included. Names are left out: they never change a choice. */
function lbDraftSignature(content = lbDraftContent()) {
  return JSON.stringify({ selections: content.selections, wizard: content.wizard });
}

/** The choices alone: moving between steps changes where a person is, not what they chose. */
function lbDraftKey(content = lbDraftContent()) {
  const { picked, removed, chosenSteps } = content.wizard;
  return JSON.stringify({ selections: content.selections, wizard: { picked, removed, chosenSteps } });
}

function lbDraftHasWork() {
  return labBuilder.selectedProducts.size > 0;
}

/** Choices in the wizard that are not in a saved draft, a built lab, or (after resuming unsaved work) nowhere safe but the autosave. */
function lbDraftDirty() {
  return lbDraftHasWork() && lbDraftKey() !== lbDraft.baselineKey;
}

// ── Wording helpers ─────────────────────────────────────────────────────────
function lbDraftTimeText(iso) {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return "a while ago";
  const time = when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (when.toDateString() === new Date().toDateString()) return `today at ${time}`;
  return `${when.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })} at ${time}`;
}

/** "Step 3 of 4: Topics" for a draft's step, numbered the way the wizard numbers its steps. */
function lbDraftProgress(step) {
  const entry = LB_STEPS.find((s) => s.id >= step) || LB_STEPS[LB_STEPS.length - 1];
  return `Step ${LB_STEPS.indexOf(entry) + 1} of ${LB_STEPS.length}: ${entry.label}`;
}

function lbDraftProductNames(ids) {
  const known = (ids || []).map((id) => lbProduct(id)).filter(Boolean).map((product) => product.shortName || product.name);
  const gone = (ids || []).length - known.length;
  if (gone) known.push(`${gone} product${gone === 1 ? " that is" : "s that are"} no longer available`);
  return known;
}

/** "Copilot Studio · Nov 20". When a draft already has that name, the time is added, then a counter, so every default name is unique. */
function lbDraftDefaultName() {
  const now = new Date();
  const date = now.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const time = now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const label = lbProductsLabel();
  const taken = new Set((lbDraft.drafts || []).map((draft) => String(draft.name || "").trim().toLowerCase()));
  const fit = (suffix) => `${label.slice(0, Math.max(10, 80 - suffix.length))}${suffix}`;
  for (const suffix of [` · ${date}`, ` · ${date}, ${time}`]) {
    const name = fit(suffix);
    if (!taken.has(name.toLowerCase())) return name;
  }
  for (let count = 2; ; count += 1) {
    const name = fit(` · ${date}, ${time} (${count})`);
    if (!taken.has(name.toLowerCase())) return name;
  }
}

/** A name no other draft has: the base itself, or the base with a counter. */
function lbDraftUniqueName(base) {
  const clipped = String(base || "").slice(0, 70).trim();
  if (!lbDraftNameTaken(clipped)) return clipped;
  for (let count = 2; ; count += 1) {
    const name = `${clipped} (${count})`;
    if (!lbDraftNameTaken(name)) return name;
  }
}

/** True when another saved draft already has this name. The draft being renamed or updated does not count. */
function lbDraftNameTaken(name, exceptId = null) {
  const wanted = String(name || "").trim().toLowerCase();
  return Boolean(wanted) && (lbDraft.drafts || []).some((draft) => draft.id !== exceptId && String(draft.name || "").trim().toLowerCase() === wanted);
}

/** A gentle note under the name field when it matches another draft. It never blocks saving. */
function lbDraftSyncNameNote() {
  const note = document.getElementById("lb-draft-name-note");
  const input = document.getElementById("lb-draft-name");
  if (!note || !input) return;
  const except = lbDraft.mode === "rename" ? lbDraft.targetId : lbDraft.activeId;
  note.textContent = lbDraftNameTaken(input.value, except) ? "Another draft already has this name. You can keep it, or add a few words to tell them apart." : "";
}

function lbDraftPlural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

/** Up to five names, then "and N more". Ids with no saved name are counted but not named. */
function lbDraftNameList(ids, labels) {
  const named = ids.map((id) => labels?.[id]).filter(Boolean);
  const shown = named.slice(0, 5).map((name) => `"${name}"`);
  const more = named.length - shown.length;
  return shown.length ? `${shown.join(", ")}${more > 0 ? `, and ${more} more` : ""}` : "";
}

function lbDraftAnnounce(message) {
  const el = document.getElementById("lb-draft-status");
  if (el) el.textContent = message || "";
  lbDraftSurfaceIfCovered(el, message);
}

/**
 * The status slot shows one message at a time, so a plain status can wait behind a question or a banner that needs an answer.
 * When that happens, a screen reader still hears it and a short notice shows, so a result such as "Saved" is never lost.
 */
function lbDraftSurfaceIfCovered(el, message) {
  if (!el || !message || typeof getComputedStyle !== "function") return;
  if (getComputedStyle(el).display !== "none") return;
  lbDraftSay(message);
  if (typeof toast === "function") toast(message, "info");
}

/** Said to a screen reader only: the same words are already on screen in the notice. */
function lbDraftSay(message) {
  const el = document.getElementById("lb-draft-announce");
  if (el) el.textContent = message || "";
}

function lbDraftStatusSaved(name, savedAt) {
  lbDraftAnnounce(`Saved. You can pick this up later under Saved drafts. "${name}" was saved ${lbDraftTimeText(savedAt)}.`);
}

// ── Talking to the server ───────────────────────────────────────────────────
async function lbDraftCall(path, method = "GET", body, options = {}) {
  const res = await fetch(`${LB_DRAFT_API}${path}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(options.keepalive ? { keepalive: true } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || "Your drafts could not be reached. Check your connection and try again.");
    error.status = res.status;
    error.code = data.code || "";
    throw error;
  }
  return data;
}

async function lbDraftReload() {
  try {
    const data = await lbDraftCall("");
    lbDraft.drafts = data.drafts || [];
    lbDraft.limit = data.limit || 50;
    lbDraft.loadError = "";
    lbDraft.unsaved = data.unsaved || null;
    lbDraft.loaded = true;
    // The portal moved drafts saved before browsers had their own space to this browser: say so once.
    if (data.adoptedDrafts > 0) {
      lbDraftAnnounce("Your saved drafts from before this update are now in this browser.");
    }
  } catch (err) {
    lbDraft.loadError = err.message;
  }
  lbDraftRenderList();
}

// ── The Saved drafts panel ──────────────────────────────────────────────────
function lbDraftItemHtml(draft) {
  const id = escapeHtml(draft.id);
  if (draft.unavailable) {
    return `
    <li class="lb-gen-item" data-draft-id="${id}">
      <h4 class="lb-gen-title">A draft that cannot be opened</h4>
      <p class="lb-gen-meta">${escapeHtml(draft.message || "This draft file could not be read.")} The file has not been changed. You can delete it.</p>
      <div class="lb-gen-actions">
        <button type="button" class="btn btn-sm" data-draft-action="delete" aria-label="Delete the draft that cannot be opened">Delete</button>
      </div>
    </li>`;
  }
  const name = String(draft.name || "Untitled draft");
  const title = escapeHtml(name);
  const parts = [
    lbJoinNames(lbDraftProductNames(draft.products)) || "No products",
    draft.level ? lbLevelName(draft.level) : "",
    lbDraftProgress(draft.step),
    draft.topicCount ? lbDraftPlural(draft.topicCount, "topic", "topics") : "No topics yet",
  ].filter(Boolean);
  const labExists = Boolean(draft.builtLabId) && typeof lbGen !== "undefined" && (lbGen.labs || []).some((lab) => lab.labId === draft.builtLabId);
  const built = draft.builtAt
    ? `<span class="tag tag-success lb-draft-built">Built</span>`
    : "";
  const openLab = labExists
    ? `<button type="button" class="btn btn-sm" data-draft-action="open-lab" data-lab-id="${escapeHtml(draft.builtLabId)}" aria-label="Open the lab built from ${title}">Open the lab</button>`
    : "";
  return `
    <li class="lb-gen-item" data-draft-id="${id}">
      <h4 class="lb-gen-title">${title}${built}</h4>
      <p class="lb-gen-meta">${escapeHtml(parts.join(" · "))}</p>
      <p class="lb-gen-meta">Saved <time datetime="${escapeHtml(draft.updatedAt || "")}">${escapeHtml(lbDraftTimeText(draft.updatedAt))}</time>${draft.builtAt ? ` · Built <time datetime="${escapeHtml(draft.builtAt)}">${escapeHtml(lbDraftTimeText(draft.builtAt))}</time>` : ""}${lbDraft.activeId === draft.id ? " · Open in the wizard now" : ""}</p>
      <div class="lb-gen-actions">
        <button type="button" class="btn btn-sm btn-primary" data-draft-action="resume" aria-label="Resume ${title}">Resume</button>
        <button type="button" class="btn btn-sm" data-draft-action="rename" aria-label="Rename ${title}">Rename</button>
        <button type="button" class="btn btn-sm" data-draft-action="duplicate" aria-label="Duplicate ${title}">Duplicate</button>
        <button type="button" class="btn btn-sm" data-draft-action="delete" aria-label="Delete ${title}">Delete</button>
        ${openLab}
      </div>
    </li>`;
}

function lbDraftRenderList(message) {
  const list = document.getElementById("lb-drafts-list");
  const badge = document.getElementById("lb-drafts-badge");
  const count = document.getElementById("lb-drafts-count");
  if (badge) badge.textContent = String(lbDraft.drafts.length);
  if (!list) return;
  if (lbDraft.loadError) {
    list.className = "scenario-empty";
    list.innerHTML = `<span role="alert">Could not list your saved drafts: ${escapeHtml(lbDraft.loadError)}</span> <button type="button" class="btn btn-sm" data-draft-action="retry">Try again</button>`;
    if (count) count.textContent = "";
    return;
  }
  const total = lbDraft.drafts.length;
  if (count) count.textContent = message || (total ? `${lbDraftPlural(total, "saved draft", "saved drafts")}. You can keep up to ${lbDraft.limit}.` : "No saved drafts yet.");
  if (!total) {
    list.className = "scenario-empty";
    list.textContent = "When you choose Save and finish later in the wizard, the lab you have set up so far appears here, ready to resume.";
    return;
  }
  list.className = "";
  list.innerHTML = `<ul class="lb-gen-list" aria-label="Saved drafts">${lbDraft.drafts.map(lbDraftItemHtml).join("")}</ul>`;
}

function lbDraftFocusItem(id, action) {
  const row = [...document.querySelectorAll("#lb-drafts-list [data-draft-id]")].find((el) => el.dataset.draftId === id);
  const target = row?.querySelector(`[data-draft-action="${action}"]`);
  if (target) target.focus();
  else document.getElementById("lb-drafts-heading")?.focus();
}

// ── Save and finish later ───────────────────────────────────────────────────
function lbDraftShowDialog(mode, draft) {
  const dialog = document.getElementById("lb-draft-name-dialog");
  if (!dialog) return;
  lbDraft.mode = mode;
  lbDraft.targetId = draft?.id || null;
  const input = document.getElementById("lb-draft-name");
  const renaming = mode === "rename";
  document.getElementById("lb-draft-name-heading").textContent = renaming ? "Rename draft" : "Save and finish later";
  document.getElementById("lb-draft-name-save").textContent = renaming ? "Rename" : "Save draft";
  const copy = document.getElementById("lb-draft-name-copy");
  if (copy) copy.hidden = renaming || !lbDraft.activeId;
  document.getElementById("lb-draft-name-hint").textContent = renaming
    ? "Up to 80 characters. Only the name changes."
    : lbDraft.activeId
      ? "Up to 80 characters. Saving updates the draft you resumed. Choose Save as a new draft to keep it as it is."
      : "Up to 80 characters. You can pick this up later under Saved drafts.";
  document.getElementById("lb-draft-name-error").textContent = "";
  input.removeAttribute?.("aria-invalid");
  input.value = renaming ? draft?.name || "" : lbDraft.activeName || lbDraftDefaultName();
  lbDraftSyncNameNote();
  dialog.showModal();
  input.focus();
  input.select?.();
}

/** Open the save dialog from the summary bar (or Ctrl+S inside the wizard). */
function lbDraftOpenSave() {
  if (!lbDraftHasWork()) {
    const message = "Choose at least one product first, then you can save your progress.";
    lbDraftAnnounce(message);
    toast(message, "info");
    return;
  }
  lbDraftShowDialog("save");
}

async function lbDraftSubmitName(event, asNew = false) {
  event?.preventDefault?.();
  const input = document.getElementById("lb-draft-name");
  const error = document.getElementById("lb-draft-name-error");
  const typed = String(input.value || "").trim();
  // Saving the resumed draft's own name as a new draft would make two identical rows, so the offered name gets a counter.
  const name = asNew && typed === String(lbDraft.activeName || "").trim() && lbDraftNameTaken(typed) ? lbDraftUniqueName(typed) : typed;
  if (!name) {
    error.textContent = "Give the draft a name.";
    input.setAttribute("aria-invalid", "true");
    input.focus();
    return;
  }
  if (name.length > 80) {
    error.textContent = "Use 80 characters or fewer for the draft name.";
    input.setAttribute("aria-invalid", "true");
    input.focus();
    return;
  }
  input.removeAttribute("aria-invalid");
  const buttons = ["lb-draft-name-save", "lb-draft-name-copy"].map((id) => document.getElementById(id));
  buttons.forEach((button) => button && (button.disabled = true));
  try {
    if (lbDraft.mode === "rename") {
      const data = await lbDraftCall(`/${encodeURIComponent(lbDraft.targetId)}`, "PUT", { name });
      if (lbDraft.activeId === data.draft.id) lbDraft.activeName = data.draft.name;
      document.getElementById("lb-draft-name-dialog").close();
      await lbDraftReload();
      lbDraftRenderList(`Renamed to "${data.draft.name}".`);
      lbDraftFocusItem(data.draft.id, "rename");
      return;
    }
    const content = lbDraftContent();
    const signature = lbDraftSignature(content);
    const update = lbDraft.activeId && !asNew;
    const data = update
      ? await lbDraftCall(`/${encodeURIComponent(lbDraft.activeId)}`, "PUT", { name, content })
      : await lbDraftCall("", "POST", { name, content });
    lbDraft.activeId = data.draft.id;
    lbDraft.activeName = data.draft.name;
    lbDraft.baselineKey = lbDraftKey(content);
    lbDraft.autosaved = null;
    lbDraft.lastSeen = signature;
    document.getElementById("lb-draft-name-dialog").close();
    lbDraftStatusSaved(data.draft.name, data.draft.updatedAt);
    toast("Saved. You can pick this up later under Saved drafts.", "success");
    await lbDraftClearSlot();
    await lbDraftReload();
  } catch (err) {
    error.textContent = lbDraft.mode !== "rename" && err.status === 404
      ? "That draft was deleted somewhere else. Choose Save as a new draft to keep your choices."
      : err.message;
    if (lbDraft.mode !== "rename" && err.status === 404) {
      document.getElementById("lb-draft-name-copy").hidden = false;
    }
  } finally {
    buttons.forEach((button) => button && (button.disabled = false));
  }
}

// ── Resume ──────────────────────────────────────────────────────────────────
/** Plain sentences for what a resumed draft could not keep. Empty when everything came back. */
function lbDraftDriftMessages(report, labels) {
  const lines = [];
  const named = (ids) => lbDraftNameList(ids, labels);
  if (report.noProducts) {
    lines.push("None of the products in this draft are available anymore. Choose a product to continue.");
  } else if (report.products.length) {
    const names = named(report.products);
    lines.push(`${lbDraftPlural(report.products.length, "product is", "products are")} no longer available${names ? ` (${names})` : ""}, so ${report.products.length === 1 ? "it was" : "they were"} left out.`);
  }
  if (report.industry) lines.push("The industry you chose is no longer offered, so the lab is for every industry now.");
  if (report.roles.length) lines.push(`${lbDraftPlural(report.roles.length, "department you chose is", "departments you chose are")} no longer offered and ${report.roles.length === 1 ? "was" : "were"} left out.`);
  if (report.harness) lines.push(`The harness you chose is no longer available, so ${lbHarnessName(labBuilder.harness)} is selected now.`);
  if (report.brand) lines.push("The brand profile you chose no longer exists, so this lab uses the active brand profile.");
  if (report.topics.length) {
    const names = named(report.topics);
    lines.push(`${lbDraftPlural(report.topics.length, "topic you chose is", "topics you chose are")} no longer listed in the catalog or on Microsoft Learn, so ${report.topics.length === 1 ? "it was" : "they were"} left out${names ? `: ${names}` : ""}.`);
  }
  if (report.productTopics.length) {
    const names = named(report.productTopics);
    lines.push(`${lbDraftPlural(report.productTopics.length, "topic belongs", "topics belong")} to a product that was left out, so ${report.productTopics.length === 1 ? "it was" : "they were"} not included${names ? `: ${names}` : ""}.`);
  }
  if (report.offLevel.length) {
    const names = report.offLevel.map((topic) => `"${topic.name}"`).slice(0, 5).join(", ");
    lines.push(`${lbDraftPlural(report.offLevel.length, "topic you chose now belongs", "topics you chose now belong")} to a different level than ${lbLevelName(labBuilder.level)} and ${report.offLevel.length === 1 ? "is" : "are"} not included: ${names}. Change the level in Step 2 or choose other topics in Step 3.`);
  }
  if (report.removed.length) {
    const names = named(report.removed);
    lines.push(`${lbDraftPlural(report.removed.length, "module you removed in Review is", "modules you removed in Review are")} no longer listed${names ? ` (${names})` : ""}, so the removal was dropped.`);
  }
  if (report.subtopics > 0) lines.push(`${lbDraftPlural(report.subtopics, "sub-topic choice was", "sub-topic choices were")} dropped because Microsoft Learn no longer lists ${report.subtopics === 1 ? "that sub-topic" : "those sub-topics"}.`);
  if (report.fallback) lines.push(report.fallback);
  return lines;
}

function lbDraftHideNotice() {
  const el = document.getElementById("lb-draft-notice");
  if (!el) return;
  el.hidden = true;
  el.innerHTML = "";
}

function lbDraftShowNotice(headline, lines) {
  const el = document.getElementById("lb-draft-notice");
  if (!el) return;
  el.hidden = false;
  el.classList.toggle("lb-draft-notice-warn", lines.length > 0);
  const list = lines.length
    ? `<p>Not everything could be restored:</p><ul>${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>`
    : "";
  el.innerHTML = `<p><strong>${escapeHtml(headline)}</strong></p>${list}<button type="button" class="btn btn-sm" data-draft-dismiss>Dismiss</button>`;
  el.querySelector("[data-draft-dismiss]")?.addEventListener("click", () => {
    lbDraftHideNotice();
    document.getElementById(`lb-heading-${labBuilder.step}`)?.focus();
  });
}

/**
 * Put a draft's content back into the wizard and open the step where the person left off.
 * Whatever Microsoft Learn, the catalog, or the product list no longer has is dropped and reported in plain words;
 * nothing else changes.
 */
async function lbDraftApply(content, { id = null, name = "", headline = "" } = {}) {
  if (typeof setActiveTab === "function") setActiveTab("labbuilder");
  if (!labBuilder.loaded && !labBuilder.products.length) await lbLoadCatalog();
  if (!labBuilder.loaded && !labBuilder.products.length) throw new Error("The lab builder catalog is not available.");
  const selections = content.selections;
  const wizard = content.wizard;
  const labels = content.labels || {};
  lbStopEditing(true);
  lbDraftHideNotice();
  lbDraft.bannerOpen = false;
  const banner = document.getElementById("lb-unsaved-banner");
  if (banner) banner.hidden = true;

  const dropped = lbApplySavedSelections(selections, wizard);
  const report = { products: dropped.products, noProducts: !labBuilder.selectedProducts.size, industry: dropped.industry, roles: dropped.roles, harness: dropped.harness, brand: false, topics: [], productTopics: [], offLevel: [], removed: [], subtopics: 0, fallback: "" };

  const store = lbBrandStore();
  if (store && labBuilder.brand.profileId && !store.profiles.some((p) => p.id === labBuilder.brand.profileId)) {
    labBuilder.brand.profileId = null;
    report.brand = true;
  }
  // A topic that belongs to a product that was left out is not carried along.
  if (report.products.length && labBuilder.picked) {
    const productOf = new Map(lbFeatureList().map((f) => [f.id, f.product || LB_DEFAULT_PRODUCT]));
    for (const topicId of [...labBuilder.picked]) {
      const owner = productOf.get(topicId);
      if (owner && !labBuilder.selectedProducts.has(owner)) {
        labBuilder.picked.delete(topicId);
        report.productTopics.push(topicId);
      }
    }
  }

  lbRenderAllSteps();
  await lbRefresh();

  for (const warning of labBuilder.rec?.warnings || []) {
    const match = /^Unknown topic "(.+)" was ignored\.$/.exec(String(warning));
    if (match) {
      labBuilder.picked?.delete(match[1]);
      report.topics.push(match[1]);
    }
  }
  report.offLevel = labBuilder.rec?.filter?.droppedSelections || [];
  report.subtopics = selections.excludedSubtopics.length - labBuilder.excludedSubtopics.size;

  // Modules taken out in Review come back as "Removed from curriculum", unless Microsoft Learn no longer lists them.
  const known = new Set([...lbDraftNames().keys(), ...(labBuilder.learn?.topics || []).map((t) => t.id)]);
  for (const entry of wizard.removed || []) {
    if (!labBuilder.excluded.has(entry.id)) continue;
    if (labBuilder.learn && !known.has(entry.id)) {
      report.removed.push(entry.id);
      continue;
    }
    labBuilder.step7Removed.set(entry.id, { ...lbLookupModuleMeta(entry.id), wasPicked: entry.wasPicked });
  }
  lbRenderSummary();

  let target = labBuilder.selectedProducts.size ? wizard.step : LB_STEP.product;
  if (target > LB_STEP.topics && !lbSelectedCount()) {
    target = LB_STEP.topics;
    report.fallback = `This draft was on ${lbDraftProgress(wizard.step)}, but none of its topics are left, so it opened on the Topics step.`;
  }
  lbGoToStep(target);
  if (labBuilder.step !== target) {
    lbGoToStep(LB_STEP.review);
  }
  for (const errorId of ["lb-topic-error", "lb-review-error"]) {
    const el = document.getElementById(errorId);
    if (el) el.textContent = "";
  }

  lbDraft.activeId = id;
  lbDraft.activeName = name;
  lbDraft.baselineKey = lbDraftKey();
  lbDraft.lastSeen = lbDraftSignature();
  lbDraft.autosaved = null;
  const lines = lbDraftDriftMessages(report, labels);
  const where = lbDraftProgress(labBuilder.step);
  const summary = `${headline} You are on ${where}.`;
  lbDraftShowNotice(summary, lines);
  lbDraftAnnounce("");
  lbDraftSay(lines.length ? `${summary} ${lbDraftPlural(lines.length, "choice", "choices")} could not be restored. The details are in the notice below your lab summary.` : summary);
  lbDraftRenderList();
  document.getElementById("lb-wizard-stage")?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  document.getElementById(`lb-heading-${labBuilder.step}`)?.focus();
  return { report, lines };
}

async function lbDraftResume(id, { confirmed = false } = {}) {
  if (lbDraft.busy) return;
  if (!confirmed && lbDraftDirty()) {
    lbDraft.pendingResume = id;
    document.getElementById("lb-draft-replace-dialog")?.showModal();
    document.getElementById("lb-draft-replace-cancel")?.focus();
    return;
  }
  lbDraft.busy = true;
  try {
    const data = await lbDraftCall(`/${encodeURIComponent(id)}`);
    const draft = data.draft;
    await lbDraftApply(draft.content, { id: draft.id, name: draft.name, headline: `Resumed "${draft.name}".` });
  } catch (err) {
    lbDraftAnnounce(err.message);
    toast(err.message, "error");
    await lbDraftReload();
    lbDraftFocusItem(id, "resume");
  } finally {
    lbDraft.busy = false;
  }
}

// ── Duplicate, delete ───────────────────────────────────────────────────────
async function lbDraftDuplicate(id) {
  try {
    const data = await lbDraftCall(`/${encodeURIComponent(id)}/duplicate`, "POST");
    await lbDraftReload();
    lbDraftRenderList(`Duplicated as "${data.draft.name}".`);
    lbDraftFocusItem(data.draft.id, "resume");
  } catch (err) {
    toast(err.message, "error");
    lbDraftAnnounce(err.message);
  }
}

function lbDraftAskDelete(id) {
  const draft = lbDraft.drafts.find((item) => item.id === id);
  const dialog = document.getElementById("lb-draft-delete-dialog");
  if (!draft || !dialog) return;
  lbDraft.deleting = id;
  const label = draft.unavailable ? "this draft" : `"${draft.name}"`;
  document.getElementById("lb-draft-delete-title").textContent = draft.unavailable ? "Delete this draft?" : `Delete "${draft.name}"?`;
  document.getElementById("lb-draft-delete-desc").textContent = `This permanently removes ${label} from your saved drafts. It cannot be undone. Labs already built from it are not changed.`;
  document.getElementById("lb-draft-delete-error").textContent = "";
  dialog.showModal();
  document.getElementById("lb-draft-delete-cancel").focus();
}

async function lbDraftConfirmDelete() {
  const id = lbDraft.deleting;
  const draft = lbDraft.drafts.find((item) => item.id === id);
  if (!draft) return;
  const confirm = document.getElementById("lb-draft-delete-confirm");
  const error = document.getElementById("lb-draft-delete-error");
  confirm.disabled = true;
  try {
    try {
      await lbDraftCall(`/${encodeURIComponent(id)}`, "DELETE");
    } catch (err) {
      if (err.status !== 404) throw err;
    }
    const index = lbDraft.drafts.findIndex((item) => item.id === id);
    lbDraft.drafts = lbDraft.drafts.filter((item) => item.id !== id);
    if (lbDraft.activeId === id) {
      lbDraft.activeId = null;
      lbDraft.activeName = "";
    }
    document.getElementById("lb-draft-delete-dialog").close();
    lbDraft.deleting = null;
    const left = lbDraft.drafts.length;
    lbDraftRenderList(`Deleted ${draft.unavailable ? "the draft" : `"${draft.name}"`}. ${lbDraftPlural(left, "saved draft", "saved drafts")} left.`);
    const next = lbDraft.drafts[Math.min(index, left - 1)];
    if (next) lbDraftFocusItem(next.id, "resume");
    else document.getElementById("lb-drafts-heading")?.focus();
    toast("Draft deleted", "success");
  } catch (err) {
    error.textContent = `Could not delete the draft: ${err.message}`;
  } finally {
    confirm.disabled = false;
  }
}

// ── Autosave: the "unsaved work" slot ───────────────────────────────────────
async function lbDraftClearSlot() {
  if (!lbDraft.slotExists && !lbDraft.unsaved) return;
  lbDraft.slotExists = false;
  lbDraft.unsaved = null;
  try {
    await lbDraftCall("/unsaved", "DELETE");
  } catch {
    /* a leftover slot only offers itself again on the next visit */
  }
}

function lbDraftSendAutosave(content, signature, keepalive) {
  lbDraft.autosaved = signature;
  lbDraft.slotExists = true;
  return lbDraftCall("/unsaved", "PUT", { content, basedOn: lbDraft.activeId }, { keepalive }).catch(() => {
    // Not saved: try again on the next tick.
    if (lbDraft.autosaved === signature) lbDraft.autosaved = null;
  });
}

/** Work began while the banner still offered older unsaved work: keep the older work as a draft, then close the banner so autosave can carry on. */
async function lbDraftKeepOfferedWork() {
  if (lbDraft.busy || lbDraft.rescueFailed) return;
  lbDraft.busy = true;
  try {
    const data = await lbDraftCall("/unsaved");
    let name = "";
    if (data.unsaved) {
      name = lbDraftUniqueName(`Recovered work, ${lbDraftTimeText(data.unsaved.updatedAt)}`);
      await lbDraftCall("", "POST", { name, content: data.unsaved.content });
    }
    await lbDraftClearSlot();
    lbDraft.bannerOpen = false;
    const banner = document.getElementById("lb-unsaved-banner");
    if (banner) banner.hidden = true;
    lbDraftAnnounce(name ? `Your earlier unsaved work was kept as "${name}" under Saved drafts.` : "");
    await lbDraftReload();
  } catch {
    // The offer stays until the person chooses Resume or Discard, and autosave stays paused rather than overwrite it.
    lbDraft.rescueFailed = true;
    lbDraftAnnounce("Your earlier unsaved work could not be kept as a draft yet. Choose Resume or Discard to continue autosaving.");
  } finally {
    lbDraft.busy = false;
  }
}

/** Runs every couple of seconds: saves the wizard once it has held still, and never while the wizard is empty. */
function lbDraftAutosaveTick() {
  if (!lbDraft.loaded || lbDraft.busy) return;
  // The banner offers older work only while the wizard is empty. Once someone starts something new, the older work is kept as a draft and the banner goes.
  if (lbDraft.bannerOpen) {
    if (lbDraftHasWork()) void lbDraftKeepOfferedWork();
    return;
  }
  if (!lbDraftHasWork()) {
    lbDraft.lastSeen = null;
    return;
  }
  const content = lbDraftContent();
  const signature = lbDraftSignature(content);
  if (lbDraftKey(content) === lbDraft.baselineKey || signature === lbDraft.autosaved) {
    lbDraft.lastSeen = signature;
    return;
  }
  if (signature !== lbDraft.lastSeen) {
    lbDraft.lastSeen = signature;
    return;
  }
  void lbDraftSendAutosave(content, signature, false);
}

/** The page is being hidden or closed: send what has not been saved yet. */
function lbDraftFlush() {
  if (!lbDraft.loaded || lbDraft.bannerOpen || lbDraft.busy || !lbDraftHasWork()) return;
  const content = lbDraftContent();
  const signature = lbDraftSignature(content);
  if (lbDraftKey(content) === lbDraft.baselineKey || signature === lbDraft.autosaved) return;
  void lbDraftSendAutosave(content, signature, true);
}

function lbDraftShowBanner() {
  const banner = document.getElementById("lb-unsaved-banner");
  const text = document.getElementById("lb-unsaved-banner-text");
  if (!banner || !text || !lbDraft.unsaved) return;
  text.textContent = `You have unsaved work from ${lbDraftTimeText(lbDraft.unsaved.updatedAt)}. Resume or discard.`;
  banner.hidden = false;
  lbDraft.bannerOpen = true;
}

async function lbDraftResumeUnsaved() {
  if (lbDraft.busy) return;
  lbDraft.busy = true;
  try {
    const data = await lbDraftCall("/unsaved");
    if (!data.unsaved) {
      lbDraft.bannerOpen = false;
      document.getElementById("lb-unsaved-banner").hidden = true;
      toast("That unsaved work is no longer there.", "info");
      return;
    }
    const based = lbDraft.drafts.find((draft) => draft.id === data.unsaved.basedOn);
    await lbDraftApply(data.unsaved.content, {
      id: based ? based.id : null,
      name: based ? based.name : "",
      headline: `Resumed your unsaved work from ${lbDraftTimeText(data.unsaved.updatedAt)}.`,
    });
    // The slot already holds exactly this work, so it is not written again until something changes.
    lbDraft.autosaved = lbDraftSignature();
    lbDraft.baselineKey = null;
  } catch (err) {
    toast(err.message, "error");
  } finally {
    lbDraft.busy = false;
  }
}

async function lbDraftDiscardUnsaved() {
  await lbDraftClearSlot();
  lbDraft.bannerOpen = false;
  const banner = document.getElementById("lb-unsaved-banner");
  if (banner) banner.hidden = true;
  lbDraftAnnounce("Discarded your unsaved work.");
  document.getElementById(`lb-heading-${labBuilder.step}`)?.focus();
}

// ── Hooks the wizard and the build call ─────────────────────────────────────
/** A fresh start (Start over, the Use Case Builder): the draft that was open is no longer what is on screen. */
function lbDraftsOnReset() {
  lbDraft.activeId = null;
  lbDraft.activeName = "";
  lbDraft.baselineKey = null;
  lbDraft.autosaved = null;
  lbDraft.lastSeen = null;
  lbDraftHideNotice();
  lbDraftAnnounce("");
  const banner = document.getElementById("lb-unsaved-banner");
  if (banner) banner.hidden = true;
  lbDraft.bannerOpen = false;
  void lbDraftClearSlot();
  lbDraftRenderList();
}

/** "Edit selections" replaces the wizard's choices, so the draft that was open is not on screen anymore. */
function lbDraftsOnReplace() {
  lbDraft.activeId = null;
  lbDraft.activeName = "";
  lbDraft.baselineKey = null;
  lbDraftHideNotice();
}

/** A lab was built: its choices now live in the lab, so the unsaved copy goes, and a resumed draft is marked Built and kept. */
async function lbDraftsAfterBuild(result) {
  if (!lbDraft.loaded) return;
  lbDraft.baselineKey = lbDraftKey();
  lbDraft.autosaved = null;
  await lbDraftClearSlot();
  if (!lbDraft.activeId || !result?.labId) return;
  const name = lbDraft.activeName;
  try {
    await lbDraftCall(`/${encodeURIComponent(lbDraft.activeId)}/built`, "POST", { labId: result.labId });
    lbDraftAnnounce(`Your lab is built. "${name}" is marked Built and stays under Saved drafts until you delete it.`);
  } catch {
    /* the lab is built either way; the draft just keeps its old label */
  }
  await lbDraftReload();
}

// ── Wiring ──────────────────────────────────────────────────────────────────
function lbDraftsBind() {
  if (lbDraft.bound) return;
  const section = document.getElementById("lb-drafts-section");
  if (!section) return;
  lbDraft.bound = true;
  section.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-draft-action]");
    if (!button) return;
    const id = button.closest("[data-draft-id]")?.dataset.draftId;
    switch (button.dataset.draftAction) {
      case "resume": lbDraftResume(id); break;
      case "rename": lbDraftShowDialog("rename", lbDraft.drafts.find((draft) => draft.id === id)); break;
      case "duplicate": lbDraftDuplicate(id); break;
      case "delete": lbDraftAskDelete(id); break;
      case "open-lab": if (typeof lbOpenGenerated === "function") lbOpenGenerated(button.dataset.labId); break;
      case "retry": lbDraftReload(); break;
    }
  });
  const byId = (id) => document.getElementById(id);
  byId("lb-draft-name-form")?.addEventListener("submit", (event) => lbDraftSubmitName(event, false));
  byId("lb-draft-name")?.addEventListener("input", lbDraftSyncNameNote);
  byId("lb-draft-name-copy")?.addEventListener("click", () => lbDraftSubmitName(null, true));
  byId("lb-draft-name-cancel")?.addEventListener("click", () => byId("lb-draft-name-dialog").close());
  byId("lb-draft-delete-cancel")?.addEventListener("click", () => byId("lb-draft-delete-dialog").close());
  byId("lb-draft-delete-confirm")?.addEventListener("click", lbDraftConfirmDelete);
  byId("lb-draft-replace-cancel")?.addEventListener("click", () => {
    lbDraft.pendingResume = null;
    byId("lb-draft-replace-dialog").close();
  });
  byId("lb-draft-replace-confirm")?.addEventListener("click", () => {
    const id = lbDraft.pendingResume;
    lbDraft.pendingResume = null;
    byId("lb-draft-replace-dialog").close();
    if (id) lbDraftResume(id, { confirmed: true });
  });
  // Closing a dialog with Esc skips its buttons, and focus would otherwise land nowhere.
  byId("lb-draft-name-dialog")?.addEventListener("close", () => {
    const target = lbDraft.mode === "rename" ? lbDraft.targetId : null;
    if (target) lbDraftFocusItem(target, "rename");
    else byId("lb-save-draft")?.focus();
  });
  byId("lb-draft-delete-dialog")?.addEventListener("close", () => {
    if (lbDraft.deleting) lbDraftFocusItem(lbDraft.deleting, "delete");
    lbDraft.deleting = null;
  });
  byId("lb-unsaved-resume")?.addEventListener("click", lbDraftResumeUnsaved);
  byId("lb-unsaved-discard")?.addEventListener("click", lbDraftDiscardUnsaved);
  // Ctrl+S (Command+S) inside the wizard saves a draft instead of the browser's own "Save page".
  byId("lb-wizard-stage")?.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && String(event.key || "").toLowerCase() === "s") {
      event.preventDefault();
      lbDraftOpenSave();
    }
  });
  if (typeof setInterval === "function") lbDraft.timer = setInterval(lbDraftAutosaveTick, LB_DRAFT_AUTOSAVE_MS);
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("pagehide", lbDraftFlush);
    document.addEventListener?.("visibilitychange", () => {
      if (document.visibilityState === "hidden") lbDraftFlush();
    });
  }
}

/** Called once the wizard's catalog has loaded: show the drafts and, when the wizard is empty, offer unsaved work. */
async function lbDraftsInit() {
  lbDraftsBind();
  await lbDraftReload();
  if (lbDraft.unsaved && !lbDraftHasWork()) lbDraftShowBanner();
}
