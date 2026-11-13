// ── Guided lab builder wizard ───────────────────────────────────────────────
// One question per step: vertical, departments, level, harness, topics, review,
// generate. Each answer feeds the topic recommendations through
// /api/lab-builder/recommend, so the server owns every rule and this file only
// renders. Time is guidance everywhere: nothing here limits a lab.
// The generate, decision, and result functions live in app.js.

const LB_STEPS = [
  { id: 1, label: "Vertical" },
  { id: 2, label: "Departments" },
  { id: 3, label: "Level" },
  { id: 4, label: "Harness" },
  { id: 5, label: "Topics" },
  { id: 6, label: "Review" },
  { id: 7, label: "Generate" },
];

const labBuilder = {
  loaded: false,
  industries: [],
  roles: [],
  categories: [],
  harnesses: [],
  levels: [],
  industry: null,
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

function lbLevelLabel(level) {
  const entry = labBuilder.levels.find((l) => l.level === level);
  return entry ? entry.label : "";
}

function lbAnswers() {
  return {
    industry: labBuilder.industry || undefined,
    departments: [...labBuilder.selectedRoles],
    level: labBuilder.level,
    harness: labBuilder.harness,
  };
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
  if (labBuilder.step === 5) lbRenderTopics();
}

/** An answer in steps 1-4 changed: topic choices start over from the new recommendation. */
function lbAnswersChanged() {
  const hadOwnPicks = Boolean(labBuilder.picked) || labBuilder.excluded.size > 0;
  labBuilder.picked = null;
  labBuilder.excluded.clear();
  labBuilder.rec = null;
  lbRenderSummary();
  lbRefresh();
  if (hadOwnPicks) toast("Your topic choices were reset to match your new answers.", "info");
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
    labBuilder.harnesses = data.harnesses || [];
    labBuilder.levels = data.levels || [];
    labBuilder.differenceDefaults = data.differenceDefaults || {};
    labBuilder.learnNew = data.learnNewByHarness || {};
    labBuilder.loaded = true;
    lbBindTopicEvents();
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

// ── Step 1: vertical ────────────────────────────────────────────────────────
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

// ── Step 2: departments ─────────────────────────────────────────────────────
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

// ── Step 3: level ───────────────────────────────────────────────────────────
async function lbRenderLevels() {
  const el = document.getElementById("lb-level-options");
  if (!el) return;
  const hint = {};
  try {
    const recs = await Promise.all(labBuilder.levels.map((l) => lbRecommend({ level: l.level })));
    labBuilder.levels.forEach((l, i) => {
      hint[l.level] = `About ${recs[i].totals.selectedCount} topics, around ${recs[i].totals.duration} (an estimate)`;
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
        </span>
      </label>`
    )
    .join("");
  el.querySelectorAll("input[type=radio]").forEach((input) => {
    input.addEventListener("change", () => {
      labBuilder.level = Number(input.value);
      lbAnswersChanged();
    });
  });
  if (focused) el.querySelector(`input[value="${focused}"]`)?.focus();
}

// ── Step 4: harness ─────────────────────────────────────────────────────────
function lbRenderHarnesses() {
  const el = document.getElementById("lb-harness-options");
  if (!el) return;
  const features = lbFeatureList();
  el.innerHTML = labBuilder.harnesses
    .map((h) => {
      const count = features.filter((f) => (f.harness || []).includes(h.id)).length;
      const fromLearn = labBuilder.learnNew[h.id] || 0;
      const unavailable = count + fromLearn === 0;
      return `
      <label class="scenario-role ${unavailable ? "lb-unavailable" : ""}">
        <input type="radio" name="lb-harness" value="${escapeHtml(h.id)}" ${labBuilder.harness === h.id ? "checked" : ""} ${unavailable ? "disabled" : ""}>
        <span>
          <span style="font-weight: 600;">${escapeHtml(h.name)}</span>
          <div class="scenario-card-desc">${escapeHtml(h.description)}</div>
          <div class="scenario-card-desc">${
            unavailable
              ? "No lab topics are available for this harness yet, so it cannot be selected."
              : `${count + fromLearn} topics available${fromLearn ? `, ${fromLearn} of them new from Microsoft Learn` : ""}.`
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
    .filter((h) => h.id !== labBuilder.harness)
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

function lbLearnNewByHarness(topics) {
  const counts = {};
  for (const topic of topics || []) {
    if (topic.source !== "learn") continue;
    for (const harness of topic.harnesses) counts[harness] = (counts[harness] || 0) + 1;
  }
  return counts;
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
    parts.push(`${newCount} new topic${newCount === 1 ? "" : "s"} from Learn.`);
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
    if (error) error.textContent = `Could not refresh from Microsoft Learn: ${err.message} Your last saved topic list is still in use.`;
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

// ── Step 5: topics ──────────────────────────────────────────────────────────
function lbSelectedCount() {
  return labBuilder.rec ? labBuilder.rec.selectedIds.length : 0;
}

/** Make the learner's picks explicit, starting from what is currently selected. */
function lbOwnPicks() {
  if (!labBuilder.picked) {
    labBuilder.picked = new Set(
      (labBuilder.rec?.concepts || []).flatMap((c) => c.topics).filter((t) => t.selected && !t.required).map((t) => t.id)
    );
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

function lbResetTopics() {
  labBuilder.picked = null;
  labBuilder.excluded.clear();
  lbRefresh();
}

function lbBindTopicEvents() {
  const groups = document.getElementById("lb-topic-groups");
  groups?.addEventListener("change", (event) => {
    const input = event.target.closest("input[data-topic]");
    if (input) lbSetTopic(input.dataset.topic, input.checked, input.dataset.required === "true");
  });
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
  const harnessName = lbHarnessName(rec.answers.harness);

  const html = rec.concepts
    .map((concept) => {
      if (!concept.topics.length) {
        if (query) return "";
        const others = concept.otherHarnessTopics.map((t) => t.name).join(", ");
        return `
        <section class="lb-concept lb-concept-muted" aria-label="${escapeHtml(concept.name)} (${concept.notYetAvailable ? "not available yet" : "not applicable"})">
          <div class="lb-category-title">${escapeHtml(concept.name)} <span class="lb-badge">${concept.notYetAvailable ? "Not available yet on this harness" : "Not applicable on this harness"}</span></div>
          <div class="lb-category-desc">${escapeHtml(concept.notApplicable || "")}${others ? ` Available on other harnesses: ${escapeHtml(others)}.` : ""}</div>
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
          ${topics
            .map(
              (t) => `
            <label class="lb-feature ${t.selected ? "checked" : ""}">
              <input type="checkbox" data-topic="${escapeHtml(t.id)}" data-required="${t.required}" ${t.selected ? "checked" : ""}
                     aria-describedby="lb-topic-desc-${escapeHtml(t.id)}">
              <span>
                <span class="lb-feature-name">${escapeHtml(t.name)}<span class="lb-badge">Level ${t.level}</span><span class="lb-badge">about ${t.minutes} min</span>${
                  t.required ? '<span class="lb-badge lb-badge-required">Required prerequisite</span>' : ""
                }${
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
            </label>`
            )
            .join("")}
        </div>
      </fieldset>`;
    })
    .join("");

  el.innerHTML = html || '<div class="scenario-empty">No topics match that search.</div>';

  const warnings = document.getElementById("lb-topic-warnings");
  if (warnings) {
    warnings.innerHTML = [
      ...rec.dependencyWarnings.map((w) => `<div class="lb-warning" role="status">${escapeHtml(w.message)}</div>`),
      ...rec.warnings.map((w) => `<div class="lb-warning" role="status">${escapeHtml(w)}</div>`),
    ].join("");
  }
  const intro = document.getElementById("lb-topic-intro");
  if (intro) {
    intro.textContent = `Topics for the ${harnessName}, grouped by concept. ${rec.totals.selectedCount} selected, about ${rec.totals.duration} (an estimate, not a limit).`;
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
    industry ? industry.name : "Cross-industry",
    departments.length ? `Departments: ${departments.join(", ")}` : "All departments",
    `Level ${labBuilder.level} ${lbLevelLabel(labBuilder.level)}`.trim(),
    lbHarnessName(labBuilder.harness),
  ];
  const totals = labBuilder.rec?.totals;
  const time = totals
    ? `${totals.selectedCount} topic${totals.selectedCount === 1 ? "" : "s"}, about ${totals.duration} (estimate, not a limit)`
    : "Calculating topics...";
  el.innerHTML = `<strong>Your lab so far:</strong> ${parts.map(escapeHtml).join(" · ")} · ${escapeHtml(time)}`;
}

function lbRenderStepper() {
  document.querySelectorAll("#lb-steps [data-lb-step]").forEach((button) => {
    const step = Number(button.dataset.lbStep);
    const reachable = step <= labBuilder.furthest;
    button.disabled = !reachable;
    button.classList.toggle("active", step === labBuilder.step);
    button.classList.toggle("done", step < labBuilder.step);
    if (step === labBuilder.step) button.setAttribute("aria-current", "step");
    else button.removeAttribute("aria-current");
  });
}

function lbGoToStep(step) {
  step = Math.min(Math.max(step, 1), LB_STEPS.length);
  if (step > 5 && !lbSelectedCount()) {
    const error = document.getElementById("lb-topic-error");
    if (error) error.textContent = "Choose at least one topic before you review the lab.";
    step = 5;
  }
  labBuilder.step = step;
  labBuilder.furthest = Math.max(labBuilder.furthest, step);
  for (const { id } of LB_STEPS) {
    const pane = document.getElementById(`lb-pane-${id}`);
    if (pane) pane.style.display = id === step ? "" : "none";
  }
  lbRenderStepper();
  document.getElementById(`lb-heading-${step}`)?.focus();
  if (step === 3) lbRenderLevels();
  if (step === 5) lbRenderTopics();
  if (step === 6) lbPreview();
}

// ── Review and request ──────────────────────────────────────────────────────
function lbRequest() {
  const time = Number(document.getElementById("lb-time")?.value || 0);
  return {
    industry: labBuilder.industry || undefined,
    roles: [...labBuilder.selectedRoles],
    harness: labBuilder.harness,
    level: labBuilder.level,
    differencesFor: [...lbDifferencesFor()],
    // What you see in the topic list is what gets built; prerequisites you turned off are assumed.
    features: labBuilder.rec ? labBuilder.rec.selectedIds : [],
    excluded: [...labBuilder.excluded],
    includeCore: false,
    targetMinutes: time > 0 ? time : undefined,
    title: document.getElementById("lb-title")?.value.trim() || undefined,
    agentName: document.getElementById("lb-agent-name")?.value.trim() || undefined,
    useLearnMcp: document.getElementById("lb-use-learn")?.checked !== false,
    useLlm: document.getElementById("lb-use-llm")?.checked !== false,
  };
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

    el.innerHTML = `
      <div style="font-size: 16px; font-weight: 600; margin-bottom: 6px;">${escapeHtml(data.title)}</div>
      <div class="scenario-pill-list">
        <span class="scenario-pill">${escapeHtml(data.difficulty)}</span>
        <span class="scenario-pill">About ${escapeHtml(data.duration)} (estimate, not a limit)</span>
        <span class="scenario-pill">${data.modules.length} modules</span>
        <span class="scenario-pill">Agent: ${escapeHtml(data.agentName)}</span>
      </div>
      <div style="margin-top: 14px; font-size: 13px; color: var(--text-muted);">${escapeHtml(data.scenario.problem)}</div>
      <table class="lb-outline">
        <caption>Lab outline with estimated time per module</caption>
        <thead><tr><th scope="col">Step</th><th scope="col">Module</th><th scope="col">Level</th><th scope="col">Estimated time</th></tr></thead>
        <tbody>
          ${data.modules
            .map(
              (m) => `<tr><td>${m.order}</td><th scope="row">${escapeHtml(m.name)}<div class="lb-feature-summary">${escapeHtml(m.summary)}</div></th><td>${m.level}</td><td>about ${m.minutes} min</td></tr>`
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
