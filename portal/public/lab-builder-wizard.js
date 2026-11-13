// ── Guided lab builder wizard ───────────────────────────────────────────────
// One question per step: product, vertical, departments, level, harness (only
// when a selected product has harnesses), topics, review, generate. Each answer
// feeds the topic recommendations through /api/lab-builder/recommend, so the
// server owns every rule and this file only renders. Time is guidance
// everywhere: nothing here limits a lab.
// The generate, decision, and result functions live in app.js.

const LB_STEPS = [
  { id: 1, label: "Product" },
  { id: 2, label: "Vertical" },
  { id: 3, label: "Departments" },
  { id: 4, label: "Level" },
  { id: 5, label: "Harness" },
  { id: 6, label: "Topics" },
  { id: 7, label: "Review" },
  { id: 8, label: "Generate" },
];

// Named step ids, so no rule below depends on a bare number.
const LB_STEP = { product: 1, vertical: 2, departments: 3, level: 4, harness: 5, topics: 6, review: 7, generate: 8 };
const LB_DEFAULT_PRODUCT = "copilot-studio";

const labBuilder = {
  loaded: false,
  industries: [],
  roles: [],
  categories: [],
  products: [],
  harnesses: [],
  levels: [],
  industry: null,
  // Copilot Studio is the default, so the wizard behaves as it always did until another product is chosen.
  selectedProducts: new Set([LB_DEFAULT_PRODUCT]),
  selectedRoles: new Set(),
  level: 100,
  harness: "standard",
  // null means "the default counterpart harness"; a Set is the learner's own choice.
  differencesFor: null,
  differenceDefaults: {},
  // null means "the recommendation as computed"; a Set is the learner's own picks.
  picked: null,
  excluded: new Set(),
  rec: null,
  search: "",
  filter: "all",
  // Freshness of the Microsoft Learn topic list, and the busy and error state of its refresh.
  learn: null,
  learnNew: {},
  learnBusy: false,
  step: 1,
  furthest: 1,
  busy: false,
  controller: null,
  // The generated lab whose choices were loaded for editing, or null.
  editing: null,
  // Set when a level change removed the learner's own topic picks, so they can be restored.
  levelNotice: null,
  // Whether the collapsed prerequisite and unknown-level groups are open; kept across re-renders.
  prereqOpen: false,
  unknownOpen: false,
};

function lbFormatMinutes(minutes) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${rest} min`;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

function lbFeatureList() {
  return labBuilder.categories.flatMap((cat) => cat.features);
}

function lbHarnessName(id) {
  return labBuilder.harnesses.find((h) => h.id === id)?.name || id;
}

function lbProduct(id) {
  return labBuilder.products.find((p) => p.id === id) || null;
}

/** The product a harness belongs to. */
function lbHarnessOwner(harnessId) {
  return labBuilder.harnesses.find((h) => h.id === harnessId)?.product || LB_DEFAULT_PRODUCT;
}

/** The products picked in the first step, in catalog order. */
function lbSelectedProductList() {
  const known = labBuilder.products.filter((p) => labBuilder.selectedProducts.has(p.id));
  return known.length ? known : [{ id: LB_DEFAULT_PRODUCT, name: "Microsoft Copilot Studio", shortName: "Copilot Studio", hasHarnesses: true }];
}

/** A harness only exists for a product that has harnesses; the harness step and its answers apply only then. */
function lbHasHarnessProduct() {
  return lbSelectedProductList().some((p) => p.hasHarnesses);
}

/** The steps the learner walks through, in order. The harness step is skipped when no selected product has harnesses. */
function lbVisibleStepIds() {
  return LB_STEPS.map((s) => s.id).filter((id) => id !== LB_STEP.harness || lbHasHarnessProduct());
}

/** The next (direction 1) or previous (direction -1) visible step, or the same step at either end. */
function lbAdjacentStep(from, direction) {
  const ids = lbVisibleStepIds();
  const index = ids.indexOf(from);
  if (index === -1) return ids.find((id) => (direction > 0 ? id > from : id < from)) ?? from;
  return ids[Math.min(Math.max(index + direction, 0), ids.length - 1)];
}

/** "Copilot Studio", "Copilot Studio and SharePoint AI", "A, B, and C". */
function lbJoinNames(names) {
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

function lbProductsLabel() {
  return lbJoinNames(lbSelectedProductList().map((p) => p.shortName || p.name));
}

function lbLevelLabel(level) {
  const entry = labBuilder.levels.find((l) => l.level === level);
  return entry ? entry.label : "";
}

/** "Level 100 (Beginner)" */
function lbLevelName(level) {
  const label = lbLevelLabel(level);
  return label ? `Level ${level} (${label})` : `Level ${level}`;
}

function lbAnswers() {
  const answers = {
    industry: labBuilder.industry || undefined,
    departments: [...labBuilder.selectedRoles],
    products: lbSelectedProductList().map((p) => p.id),
    level: labBuilder.level,
  };
  if (lbHasHarnessProduct()) answers.harness = labBuilder.harness;
  return answers;
}

async function lbRecommend(extra = {}) {
  const res = await fetch("/api/lab-builder/recommend", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...lbAnswers(), ...extra }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/** Recompute the recommendation for the current answers and the learner's own picks. */
async function lbRefresh() {
  const extra = { excluded: [...labBuilder.excluded] };
  if (labBuilder.picked) extra.selected = [...labBuilder.picked];
  const token = Symbol("refresh");
  labBuilder.refreshToken = token;
  try {
    const rec = await lbRecommend(extra);
    if (labBuilder.refreshToken !== token) return;
    labBuilder.rec = rec;
  } catch (err) {
    if (labBuilder.refreshToken !== token) return;
    labBuilder.rec = null;
    toast(`Could not update the topics: ${err.message}`, "error");
  }
  lbRenderSummary();
  if (labBuilder.step === LB_STEP.topics) lbRenderTopics();
}

/** An answer in the first steps changed: topic choices start over from the new recommendation. */
function lbAnswersChanged() {
  const hadOwnPicks = Boolean(labBuilder.picked) || labBuilder.excluded.size > 0;
  labBuilder.picked = null;
  labBuilder.excluded.clear();
  labBuilder.rec = null;
  lbRenderSummary();
  lbRefresh();
  if (hadOwnPicks) toast("Your topic choices were reset to match your new answers.", "info");
}

/** Names of the topics a rec would build for its level, for the removal notice. */
function lbSelectedNames(rec) {
  if (!rec) return [];
  const level = (rec.concepts || []).flatMap((c) => c.topics).filter((t) => t.selected);
  const unknown = (rec.levelUnknown?.topics || []).filter((t) => t.selected);
  return [...level, ...unknown].map((t) => ({ id: t.id, name: t.name }));
}

/**
 * Step 3 is the single source of truth for level. Changing it drops the learner's own
 * topic picks (they belonged to the old level), says exactly what was removed, and keeps
 * them so one button restores them.
 */
function lbLevelChanged(previous) {
  const hadOwnPicks = Boolean(labBuilder.picked) || labBuilder.excluded.size > 0;
  const removed = hadOwnPicks ? lbSelectedNames(labBuilder.rec) : [];
  labBuilder.levelNotice = hadOwnPicks
    ? {
        from: previous,
        to: labBuilder.level,
        removed,
        stash: { picked: labBuilder.picked ? new Set(labBuilder.picked) : null, excluded: new Set(labBuilder.excluded) },
      }
    : null;
  labBuilder.picked = null;
  labBuilder.excluded.clear();
  labBuilder.rec = null;
  lbRenderHarnesses();
  lbRenderLearnBar();
  lbRenderLevelNotice();
  lbRenderSummary();
  lbRefresh();
}

function lbRestoreLevelChoices() {
  const notice = labBuilder.levelNotice;
  if (!notice) return;
  labBuilder.level = notice.from;
  labBuilder.picked = notice.stash.picked;
  labBuilder.excluded = notice.stash.excluded;
  labBuilder.levelNotice = null;
  labBuilder.rec = null;
  lbRenderLevels();
  lbRenderHarnesses();
  lbRenderLearnBar();
  lbRenderLevelNotice(`Restored your ${lbLevelName(notice.from)} topic choices.`);
  lbRenderSummary();
  lbRefresh();
}

/** The visible, announced notice shown on the level and topics steps. */
function lbRenderLevelNotice(restoredMessage) {
  const notice = labBuilder.levelNotice;
  for (const id of ["lb-level-notice-4", "lb-level-notice-6"]) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (!notice) {
      el.innerHTML = restoredMessage ? `<div class="lb-warning">${escapeHtml(restoredMessage)}</div>` : "";
      continue;
    }
    const names = notice.removed.map((t) => t.name);
    const list = names.length ? ` Removed: ${names.map(escapeHtml).join(", ")}.` : "";
    el.innerHTML = `<div class="lb-warning">
      <strong>The level changed from ${escapeHtml(lbLevelName(notice.from))} to ${escapeHtml(lbLevelName(notice.to))}.</strong>
      Your own topic choices for ${escapeHtml(lbLevelName(notice.from))} were removed, and the topics below were recalculated for ${escapeHtml(lbLevelName(notice.to))}.${list}
      <button type="button" class="btn btn-small" data-level-restore>Restore my ${escapeHtml(lbLevelName(notice.from))} choices</button>
    </div>`;
    el.querySelector("[data-level-restore]")?.addEventListener("click", lbRestoreLevelChoices);
  }
}

async function lbLoadCatalog() {
  if (labBuilder.loaded) return;
  try {
    const res = await fetch("/api/lab-builder/features");
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
    const data = await res.json();
    labBuilder.industries = data.industries || [];
    labBuilder.roles = data.roles || [];
    labBuilder.categories = data.categories || [];
    labBuilder.products = data.products || [];
    labBuilder.harnesses = data.harnesses || [];
    labBuilder.levels = data.levels || [];
    labBuilder.differenceDefaults = data.differenceDefaults || {};
    labBuilder.learnNew = data.learnNewByHarnessLevel || {};
    labBuilder.loaded = true;
    lbBindTopicEvents();
    lbRenderProducts();
    lbRenderIndustries();
    lbRenderRoles();
    lbRenderLevels();
    lbRenderHarnesses();
    lbRenderStepper();
    lbRenderSummary();
    lbRefresh();
    lbLoadLearn();
    lbLoadGenerated();
  } catch (err) {
    document.getElementById("lb-industry-grid").innerHTML =
      `<div class="scenario-empty" role="alert">Could not load the feature catalog: ${escapeHtml(err.message)}</div>`;
  }
}

// ── Step 1: product ─────────────────────────────────────────────────────────
/** What a product offers at each level, in words: "Level 100: 2, Level 200: 3". */
function lbProductLevelCounts(product) {
  const counts = {};
  for (const feature of lbFeatureList()) {
    if (feature.product === product.id) counts[feature.level] = (counts[feature.level] || 0) + 1;
  }
  const parts = labBuilder.levels.filter((l) => counts[l.level]).map((l) => `Level ${l.level}: ${counts[l.level]}`);
  return parts.length ? parts.join(", ") : "No topics yet";
}

function lbRenderProducts() {
  const el = document.getElementById("lb-product-options");
  if (!el) return;
  const focused = el.contains(document.activeElement) ? document.activeElement.value : null;
  el.innerHTML = labBuilder.products
    .map((p) => {
      const checked = labBuilder.selectedProducts.has(p.id);
      const hub = lbLearnUrl(p.learnHubUrl);
      return `
      <label class="scenario-role">
        <input type="checkbox" name="lb-product" value="${escapeHtml(p.id)}" ${checked ? "checked" : ""}>
        <span>
          <span style="font-weight: 600;">${escapeHtml(p.name)}</span>
          ${p.hasHarnesses ? '<span class="lb-badge">Has harnesses</span>' : ""}
          <div class="scenario-card-desc">${escapeHtml(p.summary)}</div>
          <div class="scenario-card-desc">${escapeHtml(p.featureCount)} topics. ${escapeHtml(lbProductLevelCounts(p))}.${
            hub ? ` <a href="${escapeHtml(hub)}" target="_blank" rel="noopener noreferrer">Microsoft Learn for ${escapeHtml(p.shortName)} (opens in a new tab)</a>` : ""
          }</div>
        </span>
      </label>`;
    })
    .join("");
  el.querySelectorAll("input[type=checkbox]").forEach((input) => {
    input.addEventListener("change", () => lbToggleProduct(input.value, input.checked));
  });
  if (focused) el.querySelector(`input[value="${CSS.escape(focused)}"]`)?.focus();
}

function lbToggleProduct(id, checked) {
  const error = document.getElementById("lb-product-error");
  if (error) error.textContent = "";
  if (checked) labBuilder.selectedProducts.add(id);
  else if (labBuilder.selectedProducts.size > 1) labBuilder.selectedProducts.delete(id);
  else {
    // A lab needs a product. Say so, and keep the last one selected.
    if (error) error.textContent = "Choose at least one product. Select another product before you clear this one.";
    lbRenderProducts();
    return;
  }
  lbProductsChanged();
}

/** The product choice changed: the harness step may appear or disappear, and every list below restarts from the new products. */
function lbProductsChanged() {
  lbRenderProducts();
  lbRenderHarnesses();
  lbRenderLevels();
  lbRenderLearnBar();
  lbRenderStepper();
  lbAnswersChanged();
}

// ── Step 2: vertical ────────────────────────────────────────────────────────
function lbRenderIndustries() {
  const el = document.getElementById("lb-industry-grid");
  if (!el) return;
  const cards = [
    { id: "", name: "Cross-industry", icon: "🌐", description: "A general scenario that is not tied to one industry. This is the default." },
    ...labBuilder.industries,
  ];
  el.innerHTML = cards
    .map((i) => {
      const active = (i.id || null) === labBuilder.industry;
      return `
      <button type="button" class="scenario-card ${active ? "active" : ""}" data-industry="${escapeHtml(i.id)}" aria-pressed="${active}">
        <div class="scenario-card-title">
          <span style="font-size: 22px;" aria-hidden="true">${escapeHtml(i.icon || "")}</span>
          <span>${escapeHtml(i.name)}</span>
        </div>
        <div class="scenario-card-desc">${escapeHtml(i.description || "")}</div>
      </button>`;
    })
    .join("");
  el.querySelectorAll("[data-industry]").forEach((button) => {
    button.addEventListener("click", () => lbSelectIndustry(button.dataset.industry));
  });
}

function lbSelectIndustry(id) {
  const next = id || null;
  if (next === labBuilder.industry) return;
  labBuilder.industry = next;
  lbRenderIndustries();
  const pressed = document.querySelector(`#lb-industry-grid [data-industry="${CSS.escape(id)}"]`);
  pressed?.focus();
  lbAnswersChanged();
}

// ── Step 3: departments ─────────────────────────────────────────────────────
function lbRenderRoles() {
  const el = document.getElementById("lb-role-list");
  if (!el) return;
  el.innerHTML = labBuilder.roles
    .map(
      (r) => `
      <label class="scenario-role">
        <input type="checkbox" value="${escapeHtml(r.id)}" ${labBuilder.selectedRoles.has(r.id) ? "checked" : ""}>
        <span>
          <span style="font-weight: 600;"><span aria-hidden="true">${escapeHtml(r.icon || "")}</span> ${escapeHtml(r.name)}</span>
          <div class="scenario-card-desc">${escapeHtml(r.description || "")}</div>
        </span>
      </label>`
    )
    .join("");
  el.querySelectorAll("input[type=checkbox]").forEach((input) => {
    input.addEventListener("change", () => lbToggleRole(input.value, input.checked));
  });
}

function lbToggleRole(id, checked) {
  if (checked) labBuilder.selectedRoles.add(id);
  else labBuilder.selectedRoles.delete(id);
  lbAnswersChanged();
}

// ── Step 4: level ───────────────────────────────────────────────────────────
async function lbRenderLevels() {
  const el = document.getElementById("lb-level-options");
  if (!el) return;
  const hint = {};
  const gaps = {};
  try {
    const recs = await Promise.all(labBuilder.levels.map((l) => lbRecommend({ level: l.level })));
    labBuilder.levels.forEach((l, i) => {
      const totals = recs[i].totals;
      const recaps = totals.prerequisiteCount ? `, plus ${totals.prerequisiteCount} short prerequisite recap${totals.prerequisiteCount === 1 ? "" : "s"}` : "";
      hint[l.level] = `About ${totals.selectedCount} topics at this level${recaps}, around ${totals.duration} (an estimate)`;
      // A selected product with nothing at this level is named, so a short list is never a mystery.
      gaps[l.level] = (recs[i].products || []).filter((p) => !p.atLevel).map((p) => p.shortName);
    });
  } catch {
    /* the hint is a nicety; the choice still works without it */
  }
  const focused = el.contains(document.activeElement) ? document.activeElement.value : null;
  el.innerHTML = labBuilder.levels
    .map(
      (l) => `
      <label class="scenario-role">
        <input type="radio" name="lb-level" value="${l.level}" ${labBuilder.level === l.level ? "checked" : ""}>
        <span>
          <span style="font-weight: 600;">Level ${l.level}: ${escapeHtml(l.label)}</span>
          <div class="scenario-card-desc">${escapeHtml(l.description)}</div>
          ${hint[l.level] ? `<div class="scenario-card-desc">${escapeHtml(hint[l.level])}</div>` : ""}
          ${gaps[l.level]?.length ? `<div class="scenario-card-desc">No Level ${l.level} topics yet for ${escapeHtml(lbJoinNames(gaps[l.level]))}.</div>` : ""}
        </span>
      </label>`
    )
    .join("");
  el.querySelectorAll("input[type=radio]").forEach((input) => {
    input.addEventListener("change", () => {
      const previous = labBuilder.level;
      labBuilder.level = Number(input.value);
      if (labBuilder.level !== previous) lbLevelChanged(previous);
    });
  });
  if (focused) el.querySelector(`input[value="${focused}"]`)?.focus();
  lbRenderLevelNotice();
}

// ── Step 5: harness (only for products that have harnesses) ────────────────
function lbRenderHarnesses() {
  const el = document.getElementById("lb-harness-options");
  if (!el) return;
  const features = lbFeatureList();
  const level = labBuilder.level;
  el.innerHTML = labBuilder.harnesses
    .filter((h) => labBuilder.selectedProducts.has(h.product || LB_DEFAULT_PRODUCT))
    .map((h) => {
      const onHarness = features.filter((f) => (f.harness || []).includes(h.id));
      const atLevel = onHarness.filter((f) => f.level === level).length;
      const fromLearn = lbLearnNewCount(h.id, level);
      // A harness is only unavailable when it has no topic at any level; a level with none is explained instead.
      const unavailable = onHarness.length + lbLearnNewCount(h.id) === 0;
      const shown = atLevel + fromLearn;
      return `
      <label class="scenario-role ${unavailable ? "lb-unavailable" : ""}">
        <input type="radio" name="lb-harness" value="${escapeHtml(h.id)}" ${labBuilder.harness === h.id ? "checked" : ""} ${unavailable ? "disabled" : ""}>
        <span>
          <span style="font-weight: 600;">${escapeHtml(h.name)}</span>
          <div class="scenario-card-desc">${escapeHtml(h.description)}</div>
          <div class="scenario-card-desc">${
            unavailable
              ? "No lab topics are available for this harness yet, so it cannot be selected."
              : shown
              ? `${shown} ${lbLevelName(level)} topics available${fromLearn ? `, ${fromLearn} of them new from Microsoft Learn` : ""}.`
              : `No ${lbLevelName(level)} topics are available for this harness yet.`
          } <a href="${escapeHtml(h.learnUrl)}" target="_blank" rel="noopener noreferrer">Learn about the ${escapeHtml(h.name)} (opens in a new tab)</a></div>
        </span>
      </label>`;
    })
    .join("");
  el.querySelectorAll("input[type=radio]").forEach((input) => {
    input.addEventListener("change", () => {
      labBuilder.harness = input.value;
      labBuilder.differencesFor = null;
      lbRenderDifferenceOptions();
      lbRenderLearnBar();
      lbAnswersChanged();
    });
  });
  lbRenderDifferenceOptions();
}

/** The other harnesses whose differences get expandable notes. */
function lbDifferencesFor() {
  return labBuilder.differencesFor || new Set(labBuilder.differenceDefaults[labBuilder.harness] || []);
}

function lbRenderDifferenceOptions() {
  const el = document.getElementById("lb-differences-options");
  if (!el) return;
  const chosen = lbDifferencesFor();
  el.innerHTML = labBuilder.harnesses
    .filter((h) => h.id !== labBuilder.harness && (h.product || LB_DEFAULT_PRODUCT) === (lbHarnessOwner(labBuilder.harness) || LB_DEFAULT_PRODUCT))
    .map(
      (h) => `
      <label class="scenario-role">
        <input type="checkbox" value="${escapeHtml(h.id)}" ${chosen.has(h.id) ? "checked" : ""}>
        <span><span style="font-weight: 600;">${escapeHtml(h.name)}</span></span>
      </label>`
    )
    .join("");
  el.querySelectorAll("input[type=checkbox]").forEach((input) => {
    input.addEventListener("change", () => {
      const next = new Set(lbDifferencesFor());
      if (input.checked) next.add(input.value);
      else next.delete(input.value);
      labBuilder.differencesFor = next;
    });
  });
}

// ── Microsoft Learn topic list: freshness, refresh, and badges ──────────────
function lbLearnUrl(url) {
  return typeof url === "string" && url.startsWith("https://learn.microsoft.com/") ? url : null;
}

function lbAgo(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} days ago`;
}

/** New-from-Learn topics per harness and level, for topics whose level could be resolved. */
function lbLearnNewByHarness(topics) {
  const counts = {};
  for (const topic of topics || []) {
    if (topic.source !== "learn" || ![100, 200, 300].includes(topic.level)) continue;
    for (const harness of topic.harnesses) {
      counts[harness] ||= {};
      counts[harness][topic.level] = (counts[harness][topic.level] || 0) + 1;
    }
  }
  return counts;
}

/** Count at one level, or across all levels when no level is given. */
function lbLearnNewCount(harness, level) {
  const byLevel = labBuilder.learnNew[harness] || {};
  if (level) return byLevel[level] || 0;
  return Object.values(byLevel).reduce((sum, n) => sum + n, 0);
}

function lbApplyLearn(data) {
  labBuilder.learn = data;
  labBuilder.learnNew = lbLearnNewByHarness(data.topics);
  lbRenderLearnBar();
  lbRenderHarnesses();
}

function lbRenderLearnBar() {
  const status = document.getElementById("lb-learn-status");
  const button = document.getElementById("lb-learn-refresh");
  if (!status || !button) return;
  const learn = labBuilder.learn;
  button.disabled = labBuilder.learnBusy || Boolean(learn?.disabled);
  button.setAttribute("aria-busy", String(labBuilder.learnBusy));
  if (labBuilder.learnBusy) {
    status.textContent = "Refreshing the topic list from Microsoft Learn. This can take up to a minute.";
    return;
  }
  if (!learn) {
    status.textContent = "Checking when the topic list was last refreshed from Microsoft Learn...";
    return;
  }
  const newCount = learn.topics.filter((t) => t.source === "learn").length;
  const parts = [];
  if (!learn.refreshedAt) {
    parts.push("Microsoft Learn topics are not available, so only the built-in catalog is shown.");
  } else {
    const when = new Date(learn.refreshedAt);
    const stamp = when.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    const label = learn.source === "cache" ? "Last refreshed from Microsoft Learn" : "Built-in Microsoft Learn snapshot";
    parts.push(`${label}: ${stamp} (${lbAgo(learn.ageMs)}).`);
    if (lbHasHarnessProduct()) {
      parts.push(`${newCount} new topic${newCount === 1 ? "" : "s"} from Learn, ${lbLearnNewCount(labBuilder.harness, labBuilder.level)} at ${lbLevelName(labBuilder.level)}.`);
    } else {
      parts.push("Live discovery of new Microsoft Learn topics covers Copilot Studio only so far; the other products use the built-in catalog.");
    }
  }
  if (learn.disabled) parts.push("Refreshing is turned off on this server.");
  else if (learn.refreshing) parts.push("A refresh is running in the background.");
  else if (learn.stale && learn.refreshedAt) parts.push("This list is older than the refresh interval.");
  if (learn.offline) parts.push("Microsoft Learn could not be reached, so the last saved list is shown.");
  if (learn.partial) parts.push("The last refresh was cut short, so some pages may be missing.");
  status.textContent = parts.join(" ");
}

async function lbLoadLearn() {
  try {
    const res = await fetch("/api/lab-builder/topics");
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
    lbApplyLearn(await res.json());
  } catch (err) {
    const status = document.getElementById("lb-learn-status");
    if (status) status.textContent = "The Microsoft Learn topic list is unavailable right now. The built-in catalog is shown.";
  }
}

async function lbRefreshLearn() {
  if (labBuilder.learnBusy) return;
  const error = document.getElementById("lb-learn-error");
  if (error) error.textContent = "";
  labBuilder.learnBusy = true;
  lbRenderLearnBar();
  try {
    const res = await fetch("/api/lab-builder/topics/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* a non-JSON failure is reported by status below */
    }
    if (data?.topics) lbApplyLearn(data);
    if (!res.ok) {
      const wait = res.headers.get("Retry-After");
      throw new Error(`${data?.error || `Request failed (${res.status})`}${wait ? ` Try again in ${wait} seconds.` : ""}`);
    }
    toast(data.refresh?.changed ? "The topic list was refreshed from Microsoft Learn." : "Refreshed. Nothing changed on Microsoft Learn.", "success");
  } catch (err) {
    if (error) error.textContent = `Could not refresh from Microsoft Learn: ${String(err.message).replace(/[.\s]*$/, ".")} Your last saved topic list is still in use.`;
  } finally {
    labBuilder.learnBusy = false;
    lbRenderLearnBar();
    await lbRefresh();
  }
}

/** Text badges, so meaning never rests on color alone. */
function lbLearnBadges(topic) {
  const learn = topic.learn;
  if (!learn) return "";
  if (learn.status === "new") {
    return `<span class="lb-badge lb-badge-new">New from Learn</span>${learn.updated ? '<span class="lb-badge lb-badge-updated">Updated</span>' : ""}`;
  }
  if (learn.status === "updated") return '<span class="lb-badge lb-badge-updated">Updated</span>';
  if (learn.status === "stale") return '<span class="lb-badge lb-badge-moved">Docs moved</span>';
  return "";
}

function lbMatchesFilter(topic) {
  const status = topic.learn?.status;
  if (labBuilder.filter === "new") return status === "new";
  if (labBuilder.filter === "updated") return status === "updated" || topic.learn?.updated === true;
  if (labBuilder.filter === "moved") return status === "stale";
  return true;
}

// ── Step 6: topics ──────────────────────────────────────────────────────────
function lbSelectedCount() {
  return labBuilder.rec ? labBuilder.rec.selectedIds.length : 0;
}

/** Make the learner's picks explicit, starting from what is currently selected. */
function lbOwnPicks() {
  if (!labBuilder.picked) {
    const rows = [...(labBuilder.rec?.concepts || []).flatMap((c) => c.topics), ...(labBuilder.rec?.levelUnknown?.topics || [])];
    labBuilder.picked = new Set(rows.filter((t) => t.selected && !t.required).map((t) => t.id));
  }
  return labBuilder.picked;
}

function lbSetTopic(id, checked, required) {
  const picks = lbOwnPicks();
  if (checked) {
    picks.add(id);
    labBuilder.excluded.delete(id);
  } else if (required) {
    labBuilder.excluded.add(id);
  } else {
    picks.delete(id);
  }
  lbRefresh();
}

/** A lower-level prerequisite is never a pick of its own: turning it off marks it as already known. */
function lbSetPrerequisite(id, checked) {
  if (checked) labBuilder.excluded.delete(id);
  else labBuilder.excluded.add(id);
  lbRefresh();
}

function lbSetGroup(conceptId, checked) {
  const concept = labBuilder.rec?.concepts.find((c) => c.id === conceptId);
  if (!concept) return;
  const picks = lbOwnPicks();
  for (const topic of concept.topics) {
    if (checked) {
      picks.add(topic.id);
      labBuilder.excluded.delete(topic.id);
    } else {
      picks.delete(topic.id);
      if (topic.required) labBuilder.excluded.add(topic.id);
    }
  }
  lbRefresh();
}

function lbSelectAllTopics() {
  // Only the level's own topics; "Level unknown" topics are never added in bulk.
  const all = (labBuilder.rec?.concepts || []).flatMap((c) => c.topics.map((t) => t.id));
  labBuilder.picked = new Set(all);
  labBuilder.excluded.clear();
  lbRefresh();
}

function lbClearTopics() {
  labBuilder.picked = new Set();
  labBuilder.excluded.clear();
  lbRefresh();
}

/** Select every topic the rules recommend for these answers. Only this deliberate action adds the level's baseline picks. */
function lbSelectRecommended() {
  labBuilder.picked = new Set(labBuilder.rec?.recommendedIds || []);
  labBuilder.excluded.clear();
  lbRefresh();
}

/** Back to what the learner's answers pre-select (nothing, unless a vertical or department points at a topic). */
function lbResetTopics() {
  labBuilder.picked = null;
  labBuilder.excluded.clear();
  lbRefresh();
}

function lbBindTopicEvents() {
  const groups = document.getElementById("lb-topic-groups");
  groups?.addEventListener("change", (event) => {
    const prerequisite = event.target.closest("input[data-prerequisite]");
    if (prerequisite) {
      lbSetPrerequisite(prerequisite.dataset.prerequisite, prerequisite.checked);
      return;
    }
    const input = event.target.closest("input[data-topic]");
    if (input) lbSetTopic(input.dataset.topic, input.checked, input.dataset.required === "true");
  });
  groups?.addEventListener(
    "toggle",
    (event) => {
      if (event.target.id === "lb-prereq-group") labBuilder.prereqOpen = event.target.open;
      if (event.target.id === "lb-unknown-group") labBuilder.unknownOpen = event.target.open;
    },
    true
  );
  groups?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-group-action]");
    if (button) lbSetGroup(button.dataset.concept, button.dataset.groupAction === "select");
  });
  document.getElementById("lb-topic-search")?.addEventListener("input", (event) => {
    labBuilder.search = event.target.value.trim().toLowerCase();
    lbRenderTopics();
  });
  document.getElementById("lb-topic-filter")?.addEventListener("change", (event) => {
    labBuilder.filter = event.target.value;
    lbRenderTopics();
  });
}

/** Level as text, never color alone. A level worked out from the docs rubric says so. */
function lbLevelBadge(t) {
  if (!t.level) return '<span class="lb-badge">Level unknown</span>';
  return `<span class="lb-badge">Level ${t.level}</span>${t.levelBasis === "estimated" ? '<span class="lb-badge">Estimated level</span>' : ""}`;
}

function lbTopicCard(t) {
  return `
            <label class="lb-feature ${t.selected ? "checked" : ""}">
              <input type="checkbox" data-topic="${escapeHtml(t.id)}" data-required="${t.required}" ${t.selected ? "checked" : ""}
                     aria-describedby="lb-topic-desc-${escapeHtml(t.id)}">
              <span>
                <span class="lb-feature-name">${escapeHtml(t.name)}${t.productName ? `<span class="lb-badge lb-badge-product">${escapeHtml(lbProduct(t.product)?.shortName || t.productName)}</span>` : ""}${lbLevelBadge(t)}<span class="lb-badge">about ${t.minutes} min</span>${
                  t.required ? '<span class="lb-badge lb-badge-required">Required prerequisite</span>' : ""
                }${t.recommended && !t.selected ? '<span class="lb-badge">Recommended, not selected</span>' : ""}${
                  t.availability ? `<span class="lb-badge lb-badge-${escapeHtml(t.availability)}">${t.availability === "ga" ? "GA" : escapeHtml(t.availability.charAt(0).toUpperCase() + t.availability.slice(1))}</span>` : ""
                }${lbLearnBadges(t)}</span>
                <span id="lb-topic-desc-${escapeHtml(t.id)}" class="lb-feature-summary">${escapeHtml(t.summary)}</span>
                ${t.source === "learn" && lbLearnUrl(t.learn?.url)
                  ? `<span class="lb-feature-note">Source: Microsoft Learn, not yet reviewed for this repository. <a class="lb-learn-source" href="${escapeHtml(t.learn.url)}" target="_blank" rel="noopener noreferrer">Read the article (opens in a new tab)</a></span>`
                  : ""}
                ${t.learn?.status === "stale" ? '<span class="lb-feature-note">The Microsoft Learn pages this topic cites could not be found. Its steps are checked against Learn when the lab is built.</span>' : ""}
                ${t.reasons.length ? `<span class="lb-topic-reason">Why: ${escapeHtml(t.reasons.join(". "))}</span>` : ""}
                ${t.harnessNote ? `<span class="lb-feature-note">${escapeHtml(t.harnessNote)}</span>` : ""}
              </span>
            </label>`;
}

/** How many topic cards the current search and filter leave visible in the level's own concept groups. */
function lbVisibleTopicCount(rec, query) {
  return rec.concepts.reduce(
    (sum, concept) =>
      sum +
      concept.topics.filter(
        (t) => lbMatchesFilter(t) && (!query || t.name.toLowerCase().includes(query) || t.summary.toLowerCase().includes(query) || t.id.includes(query))
      ).length,
    0
  );
}

function lbRenderTopics() {
  const el = document.getElementById("lb-topic-groups");
  const rec = labBuilder.rec;
  if (!el) return;
  if (!rec) {
    el.innerHTML = '<div class="scenario-empty">Loading topics...</div>';
    return;
  }
  const activeId = document.activeElement?.dataset?.topic || null;
  const activeAction = document.activeElement?.dataset?.groupAction
    ? `${document.activeElement.dataset.concept}:${document.activeElement.dataset.groupAction}`
    : null;
  const query = labBuilder.search;
  const onlyCopilotStudio = (rec.answers.products || [LB_DEFAULT_PRODUCT]).every((id) => id === LB_DEFAULT_PRODUCT);
  // Copilot Studio alone is described by its harness, as before; any other selection is described by its products.
  const scopeName = onlyCopilotStudio && rec.answers.harness ? `the ${lbHarnessName(rec.answers.harness)}` : lbJoinNames((rec.products || []).map((p) => p.shortName));

  const html = rec.concepts
    .map((concept) => {
      if (!concept.topics.length) {
        if (query) return "";
        const others = concept.otherHarnessTopics.map((t) => t.name).join(", ");
        const where = onlyCopilotStudio ? "on this harness" : "for these products";
        return `
        <section class="lb-concept lb-concept-muted" aria-label="${escapeHtml(concept.name)} (${concept.notYetAvailable ? "not available yet" : "not applicable"})">
          <div class="lb-category-title">${escapeHtml(concept.name)} <span class="lb-badge">${concept.notYetAvailable ? `Not available yet ${where}` : `Not applicable ${where}`}</span></div>
          <div class="lb-category-desc">${escapeHtml(concept.notApplicable || "")}${others ? ` Available at other levels or for other harnesses: ${escapeHtml(others)}.` : ""}</div>
        </section>`;
      }
      const topics = concept.topics.filter(
        (t) =>
          lbMatchesFilter(t) &&
          (!query || t.name.toLowerCase().includes(query) || t.summary.toLowerCase().includes(query) || t.id.includes(query))
      );
      if (!topics.length) return "";
      return `
      <fieldset class="lb-concept">
        <legend class="lb-category-title">${escapeHtml(concept.name)}
          <span class="lb-concept-count">${concept.selectedCount} of ${concept.topics.length} selected${concept.minutes ? `, about ${lbFormatMinutes(concept.minutes)}` : ""}</span>
        </legend>
        <div class="lb-category-desc">${escapeHtml(concept.summary)}</div>
        <div class="lb-group-actions">
          <button type="button" class="btn btn-small" data-group-action="select" data-concept="${escapeHtml(concept.id)}" aria-label="Select all ${escapeHtml(concept.name)} topics">Select group</button>
          <button type="button" class="btn btn-small" data-group-action="clear" data-concept="${escapeHtml(concept.id)}" aria-label="Clear all ${escapeHtml(concept.name)} topics">Clear group</button>
        </div>
        <div class="lb-feature-grid">
          ${topics.map(lbTopicCard).join("")}
        </div>
      </fieldset>`;
    })
    .join("");

  // Lower-level topics that the selected topics need: separate, collapsed, and each one can be turned off.
  const prereqs = rec.prerequisites?.topics || [];
  const prereqHtml =
    prereqs.length && !query && labBuilder.filter === "all"
      ? `
      <details class="lb-concept lb-prereq-group" id="lb-prereq-group" ${labBuilder.prereqOpen ? "open" : ""}>
        <summary class="lb-category-title">Prerequisites from lower levels (included automatically)
          <span class="lb-concept-count">${rec.prerequisites.selectedCount} of ${prereqs.length} included${rec.prerequisites.minutes ? `, about ${lbFormatMinutes(rec.prerequisites.minutes)}` : ""}</span>
        </summary>
        <p class="lb-category-desc">These are not ${escapeHtml(lbLevelName(rec.answers.level))} topics. Topics you selected build on them, so the lab includes each one as a short, labeled recap. Uncheck one if your learners already know it: the lab then assumes it.</p>
        <div class="lb-feature-grid">
          ${prereqs
            .map(
              (p) => `
            <label class="lb-feature ${p.selected ? "checked" : ""}">
              <input type="checkbox" data-prerequisite="${escapeHtml(p.id)}" ${p.selected ? "checked" : ""} aria-describedby="lb-prereq-desc-${escapeHtml(p.id)}">
              <span>
                <span class="lb-feature-name">${escapeHtml(p.name)}<span class="lb-badge">Level ${p.level}</span><span class="lb-badge">Prerequisite recap</span><span class="lb-badge">about ${p.minutes} min</span></span>
                <span id="lb-prereq-desc-${escapeHtml(p.id)}" class="lb-feature-summary">${escapeHtml(p.summary)}</span>
                <span class="lb-topic-reason">Why: ${escapeHtml(p.reason)}</span>
              </span>
            </label>`
            )
            .join("")}
        </div>
      </details>`
      : "";

  // Learn topics whose level could not be worked out. They are never recommended and stay collapsed.
  const unknown = (rec.levelUnknown?.topics || []).filter(
    (t) => lbMatchesFilter(t) && (!query || t.name.toLowerCase().includes(query) || t.summary.toLowerCase().includes(query) || t.id.includes(query))
  );
  const unknownHtml = unknown.length
    ? `
      <details class="lb-concept lb-unknown-group" id="lb-unknown-group" ${labBuilder.unknownOpen ? "open" : ""}>
        <summary class="lb-category-title">Level unknown (${unknown.length})
          <span class="lb-concept-count">${rec.levelUnknown.selectedCount} selected</span>
        </summary>
        <p class="lb-category-desc">These topics were found on Microsoft Learn, but we could not tell which level they belong to, so they are not recommended for ${escapeHtml(lbLevelName(rec.answers.level))}. Add one only if you have checked its article and want it in this lab.</p>
        <div class="lb-feature-grid">${unknown.map(lbTopicCard).join("")}</div>
      </details>`
    : "";

  const shown = lbVisibleTopicCount(rec, query);
  const narrowed = Boolean(query) || labBuilder.filter !== "all";
  const levelName = lbLevelName(rec.answers.level);
  const countText = rec.filter.shown
    ? `Showing ${shown} topic${shown === 1 ? "" : "s"} for ${levelName}${narrowed ? ` that match your search or filter (of ${rec.filter.shown})` : ""}.`
    : `No ${levelName} topics are available for ${scopeName} yet.`;
  const count = document.getElementById("lb-topic-count");
  if (count && count.textContent !== countText) count.textContent = countText;

  // What each selected product offers, and why a list may be short: never a dead end.
  const notes = document.getElementById("lb-product-notes");
  if (notes) {
    const thin = (rec.products || []).filter((p) => !p.atLevel);
    notes.innerHTML = thin.map((p) => `<div class="lb-warning" role="status">${escapeHtml(p.message)}</div>`).join("");
  }

  const empty = rec.filter.shown
    ? "No topics match that search."
    : `No ${escapeHtml(levelName)} topics are available for ${escapeHtml(scopeName)} yet. ${(rec.products || [])
        .map((p) => escapeHtml(p.message))
        .join(" ")} Go back and choose another level${onlyCopilotStudio ? " or harness" : ", product, or harness"}.`;
  el.innerHTML = html + prereqHtml + unknownHtml || `<div class="scenario-empty">${empty}</div>`;

  const warnings = document.getElementById("lb-topic-warnings");
  if (warnings) {
    const dropped = rec.filter.droppedSelections || [];
    warnings.innerHTML = [
      ...(dropped.length
        ? [
            `<div class="lb-warning" role="status">These selected topics belong to another level, so they are not part of this ${escapeHtml(levelName)} lab: ${dropped
              .map((t) => `${escapeHtml(t.name)} (Level ${t.level})`)
              .join(", ")}.</div>`,
          ]
        : []),
      ...rec.dependencyWarnings.map((w) => `<div class="lb-warning" role="status">${escapeHtml(w.message)}</div>`),
      ...rec.warnings.map((w) => `<div class="lb-warning" role="status">${escapeHtml(w)}</div>`),
    ].join("");
  }
  const intro = document.getElementById("lb-topic-intro");
  if (intro) {
    const recaps = rec.totals.prerequisiteCount ? `, plus ${rec.totals.prerequisiteCount} short prerequisite recap${rec.totals.prerequisiteCount === 1 ? "" : "s"}` : "";
    const pre = (rec.preselectedIds || []).length;
    const origin = rec.totals.selectedCount
      ? labBuilder.picked
        ? ""
        : pre
        ? ` ${pre} ${pre === 1 ? "was" : "were"} pre-selected because of the vertical or departments you chose; uncheck any you do not want.`
        : ""
      : " Nothing is selected yet: check the topics you want, or use Select recommended.";
    intro.textContent = `${levelName} topics for ${scopeName}, grouped by concept. ${rec.totals.selectedCount} selected${recaps}, about ${rec.totals.duration} (an estimate, not a limit).${origin}`;
  }
  const error = document.getElementById("lb-topic-error");
  if (error && lbSelectedCount()) error.textContent = "";

  if (activeId) el.querySelector(`input[data-topic="${CSS.escape(activeId)}"]`)?.focus();
  else if (activeAction) {
    const [concept, action] = activeAction.split(":");
    el.querySelector(`button[data-concept="${CSS.escape(concept)}"][data-group-action="${action}"]`)?.focus();
  }
}

// ── Summary and stepper ─────────────────────────────────────────────────────
function lbRenderSummary() {
  const el = document.getElementById("lb-summary");
  if (!el) return;
  const industry = labBuilder.industries.find((i) => i.id === labBuilder.industry);
  const departments = labBuilder.roles.filter((r) => labBuilder.selectedRoles.has(r.id)).map((r) => r.name);
  const parts = [
    lbProductsLabel(),
    industry ? industry.name : "Cross-industry",
    departments.length ? `Departments: ${departments.join(", ")}` : "All departments",
    lbLevelName(labBuilder.level),
    ...(lbHasHarnessProduct() ? [lbHarnessName(labBuilder.harness)] : []),
  ];
  const totals = labBuilder.rec?.totals;
  const recaps = totals?.prerequisiteCount ? ` + ${totals.prerequisiteCount} prerequisite recap${totals.prerequisiteCount === 1 ? "" : "s"}` : "";
  const time = totals
    ? totals.selectedCount
      ? `${totals.selectedCount} topic${totals.selectedCount === 1 ? "" : "s"}${recaps}, about ${totals.duration} (estimate, not a limit)`
      : "No topics selected yet"
    : "Calculating topics...";
  el.innerHTML = `<strong>Your lab so far:</strong> ${parts.map(escapeHtml).join(" · ")} · ${escapeHtml(time)}`;
}

/** Number the visible steps again, hide the harness step when it does not apply, and keep each heading's "Step n of m" true. */
function lbRenderStepper() {
  const visible = lbVisibleStepIds();
  document.querySelectorAll("#lb-steps [data-lb-step]").forEach((button) => {
    const step = Number(button.dataset.lbStep);
    const shown = visible.includes(step);
    const item = button.closest("li");
    if (item) item.hidden = !shown;
    const number = button.querySelector("span[aria-hidden]");
    if (number && shown) number.textContent = String(visible.indexOf(step) + 1);
    const reachable = step <= labBuilder.furthest;
    button.disabled = !reachable;
    button.classList.toggle("active", step === labBuilder.step);
    button.classList.toggle("done", step < labBuilder.step);
    if (step === labBuilder.step) button.setAttribute("aria-current", "step");
    else button.removeAttribute("aria-current");
  });
  for (const step of visible) {
    const heading = document.getElementById(`lb-heading-${step}`);
    if (heading) heading.textContent = heading.textContent.replace(/^Step \d+ of \d+/, `Step ${visible.indexOf(step) + 1} of ${visible.length}`);
  }
}

/** The step after or before the current one, skipping a step that does not apply. */
function lbNextStep() {
  if (labBuilder.step === LB_STEP.product && !labBuilder.selectedProducts.size) {
    const error = document.getElementById("lb-product-error");
    if (error) error.textContent = "Choose at least one product to continue.";
    return;
  }
  lbGoToStep(lbAdjacentStep(labBuilder.step, 1));
}

function lbPrevStep() {
  lbGoToStep(lbAdjacentStep(labBuilder.step, -1));
}

function lbGoToStep(step) {
  step = Math.min(Math.max(step, 1), LB_STEPS.length);
  // The harness step does not exist for a lab with no harness product: land on the step after it.
  if (step === LB_STEP.harness && !lbHasHarnessProduct()) step = LB_STEP.topics;
  if (step > LB_STEP.topics && !lbSelectedCount()) {
    const error = document.getElementById("lb-topic-error");
    if (error) error.textContent = "Choose at least one topic before you review the lab.";
    step = LB_STEP.topics;
  }
  labBuilder.step = step;
  labBuilder.furthest = Math.max(labBuilder.furthest, step);
  for (const { id } of LB_STEPS) {
    const pane = document.getElementById(`lb-pane-${id}`);
    if (pane) pane.style.display = id === step ? "" : "none";
  }
  lbRenderStepper();
  document.getElementById(`lb-heading-${step}`)?.focus();
  // The Level step's next button names whichever step follows it.
  const afterLevel = document.getElementById("lb-next-from-level");
  if (afterLevel) afterLevel.textContent = lbHasHarnessProduct() ? "Next: Harness →" : "Next: Topics →";
  if (step === LB_STEP.level) lbRenderLevels();
  if (step === LB_STEP.topics) {
    lbRenderLevelNotice();
    lbRenderTopics();
  }
  if (step === LB_STEP.review) lbPreview();
}

// ── Re-opening a generated lab's choices ────────────────────────────────────
function lbSetEditing(lab) {
  labBuilder.editing = { labId: lab.labId, title: lab.title };
  const banner = document.getElementById("lb-edit-banner");
  document.getElementById("lb-edit-banner-text").textContent =
    `Editing the choices behind "${lab.title}". On the last step you choose whether to save a new lab or replace this one. Nothing changes until you build.`;
  if (banner) banner.hidden = false;
  document.getElementById("lb-save-mode-title").textContent = `"${lab.title}"`;
  const fieldset = document.getElementById("lb-save-mode");
  if (fieldset) fieldset.hidden = false;
}

function lbStopEditing(silent) {
  if (!labBuilder.editing) return;
  labBuilder.editing = null;
  const banner = document.getElementById("lb-edit-banner");
  if (banner) banner.hidden = true;
  const fieldset = document.getElementById("lb-save-mode");
  if (fieldset) fieldset.hidden = true;
  const keepNew = document.querySelector('input[name="lb-save-mode"][value="new"]');
  if (keepNew) keepNew.checked = true;
  if (!silent) {
    toast("Stopped editing. The saved lab was not changed, and your next build is saved as a new lab.", "info");
    document.getElementById(`lb-heading-${labBuilder.step}`)?.focus();
  }
}

/** The `replaceLabId` to send, only when the learner explicitly chose to replace. */
function lbReplaceTarget() {
  if (!labBuilder.editing) return undefined;
  return document.querySelector('input[name="lb-save-mode"]:checked')?.value === "replace" ? labBuilder.editing.labId : undefined;
}

function lbSetFormValue(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  if (el.type === "checkbox") el.checked = value;
  else el.value = value ?? "";
}

function lbRenderAllSteps() {
  lbRenderIndustries();
  lbRenderProducts();
  lbRenderIndustries();
  lbRenderRoles();
  lbRenderLevels();
  lbRenderHarnesses();
  lbRenderStepper();
  lbRenderSummary();
}

/** Back to the wizard's starting answers, without touching any saved lab. */
function lbResetAnswers() {
  labBuilder.selectedProducts = new Set([LB_DEFAULT_PRODUCT]);
  labBuilder.industry = null;
  labBuilder.selectedRoles = new Set();
  labBuilder.level = 100;
  labBuilder.harness = "standard";
  labBuilder.differencesFor = null;
  labBuilder.picked = null;
  labBuilder.excluded = new Set();
  labBuilder.rec = null;
  labBuilder.furthest = 1;
  labBuilder.levelNotice = null;
  lbRenderLevelNotice();
  for (const [id, value] of [["lb-time", ""], ["lb-title", ""], ["lb-agent-name", ""], ["lb-use-learn", true], ["lb-use-llm", true]]) {
    lbSetFormValue(id, value);
  }
}

async function lbStartNewLab() {
  setActiveTab("labbuilder");
  await lbLoadCatalog();
  lbStopEditing(true);
  lbResetAnswers();
  lbRenderAllSteps();
  lbRefresh();
  lbGoToStep(LB_STEP.product);
}

/**
 * The level a saved lab was built for. Labs saved before the level was recorded take the
 * highest level among their topics, so editing them still lists and builds one level.
 */
function lbSavedLevel(saved) {
  if ([100, 200, 300].includes(saved.level)) return saved.level;
  const levels = new Map(lbFeatureList().map((f) => [f.id, f.level]));
  return Math.max(100, ...saved.features.map((id) => levels.get(id) || 0));
}

/** Pre-fill every step from a generated lab's saved choices and jump to Review. */
async function lbLoadSelections(lab) {
  const saved = lab?.selections;
  if (!saved) throw new Error("This lab has no saved selections.");
  setActiveTab("labbuilder");
  await lbLoadCatalog();
  if (!labBuilder.loaded) throw new Error("The lab builder catalog is not available.");

  const knownRoles = new Set(labBuilder.roles.map((r) => r.id));
  const industryKnown = labBuilder.industries.some((i) => i.id === saved.industry);
  const harnessKnown = labBuilder.harnesses.some((h) => h.id === saved.harness);
  // A lab saved before products existed is a Copilot Studio lab.
  const savedProducts = (saved.products || []).filter((id) => lbProduct(id));
  labBuilder.selectedProducts = new Set(savedProducts.length ? savedProducts : [LB_DEFAULT_PRODUCT]);
  labBuilder.industry = industryKnown ? saved.industry : null;
  labBuilder.selectedRoles = new Set(saved.roles.filter((id) => knownRoles.has(id)));
  labBuilder.level = lbSavedLevel(saved);
  labBuilder.levelNotice = null;
  labBuilder.harness = harnessKnown ? saved.harness : "standard";
  labBuilder.differencesFor = saved.differencesFor ? new Set(saved.differencesFor) : null;
  labBuilder.picked = new Set(saved.features);
  labBuilder.excluded = new Set(saved.excluded);
  labBuilder.rec = null;
  lbSetFormValue("lb-time", saved.targetMinutes || "");
  lbSetFormValue("lb-title", saved.customTitle || "");
  lbSetFormValue("lb-agent-name", saved.agentName || "");
  lbSetFormValue("lb-use-learn", saved.useLearnMcp !== false);
  lbSetFormValue("lb-use-llm", saved.useLlm !== false);
  labBuilder.furthest = LB_STEP.review;
  lbRenderAllSteps();
  lbSetEditing(lab);
  await lbRefresh();
  lbGoToStep(LB_STEP.review);
  const dropped = labBuilder.rec?.filter?.droppedSelections || [];
  toast(
    dropped.length
      ? `Loaded the choices from "${lab.title}" for ${lbLevelName(labBuilder.level)}. ${dropped.length} saved topic${dropped.length === 1 ? " belongs" : "s belong"} to another level and ${dropped.length === 1 ? "was" : "were"} not loaded: ${dropped.map((t) => t.name).join(", ")}.`
      : `Loaded the choices from "${lab.title}". Change anything, then build.`,
    "info"
  );
}

// ── Review and request ──────────────────────────────────────────────────────
function lbRequest() {
  const time = Number(document.getElementById("lb-time")?.value || 0);
  const request = {
    industry: labBuilder.industry || undefined,
    roles: [...labBuilder.selectedRoles],
    products: lbSelectedProductList().map((p) => p.id),
    level: labBuilder.level,
    // What you see in the topic list is what gets built; prerequisites you turned off are assumed.
    features: labBuilder.rec ? labBuilder.rec.selectedIds : [],
    excluded: [...labBuilder.excluded],
    includeCore: false,
    targetMinutes: time > 0 ? time : undefined,
    title: document.getElementById("lb-title")?.value.trim() || undefined,
    agentName: document.getElementById("lb-agent-name")?.value.trim() || undefined,
    useLearnMcp: document.getElementById("lb-use-learn")?.checked !== false,
    useLlm: document.getElementById("lb-use-llm")?.checked !== false,
    // A harness, and the notes comparing harnesses, only exist for a product that has harnesses.
    ...(lbHasHarnessProduct() ? { harness: labBuilder.harness, differencesFor: [...lbDifferencesFor()] } : {}),
  };
  return request;
}

async function lbPreview() {
  const el = document.getElementById("lb-preview");
  if (!el) return;
  el.innerHTML = '<div class="scenario-empty" role="status">Planning your lab...</div>';
  try {
    const res = await fetch("/api/lab-builder/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(lbRequest()),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);

    const recaps = data.modules.filter((m) => m.role === "prerequisite").length;
    const own = data.modules.length - recaps;
    el.innerHTML = `
      <div style="font-size: 16px; font-weight: 600; margin-bottom: 6px;">${escapeHtml(data.title)}</div>
      <div class="scenario-pill-list">
        <span class="scenario-pill">${escapeHtml(data.difficulty)}</span>
        <span class="scenario-pill">${escapeHtml(lbLevelName(data.level))}</span>
        <span class="scenario-pill">About ${escapeHtml(data.duration)} (estimate, not a limit)</span>
        <span class="scenario-pill">${own} module${own === 1 ? "" : "s"}${recaps ? ` + ${recaps} prerequisite recap${recaps === 1 ? "" : "s"}` : ""}</span>
        <span class="scenario-pill">Agent: ${escapeHtml(data.agentName)}</span>
      </div>
      <div style="margin-top: 14px; font-size: 13px; color: var(--text-muted);">${escapeHtml(data.scenario.problem)}</div>
      <table class="lb-outline">
        <caption>Lab outline with estimated time per module</caption>
        <thead><tr><th scope="col">Step</th><th scope="col">Module</th><th scope="col">Level</th><th scope="col">Estimated time</th></tr></thead>
        <tbody>
          ${data.modules
            .map(
              (m) =>
                `<tr><td>${m.order}</td><th scope="row">${m.role === "prerequisite" ? "Recap: " : ""}${escapeHtml(m.name)}<div class="lb-feature-summary">${escapeHtml(m.summary)}</div></th><td>${m.level}${
                  m.role === "prerequisite" ? " (prerequisite recap)" : ""
                }</td><td>about ${m.minutes} min</td></tr>`
            )
            .join("")}
        </tbody>
        <tfoot><tr><th scope="row" colspan="3">Total (estimate)</th><td>about ${escapeHtml(data.duration)}</td></tr></tfoot>
      </table>
      ${(data.estimate?.suggestedParts || [])
        .map((part) => `<div class="lb-feature-note">Optional part ${part.part}: ${part.ids.length} module${part.ids.length === 1 ? "" : "s"}, about ${escapeHtml(part.duration)}</div>`)
        .join("")}
      ${data.warnings.map((w) => `<div class="lb-warning" role="status">${escapeHtml(w)}</div>`).join("")}
    `;
  } catch (err) {
    el.innerHTML = `<div class="scenario-empty" role="alert">Could not plan the lab: ${escapeHtml(err.message)}</div>`;
  }
}
