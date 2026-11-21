// ── Use Case Builder ────────────────────────────────────────────────────────
// Pick an industry, departments, goals, the data you already have, a platform,
// and a skill level; a ranked list of Copilot Studio and Agent Builder use cases
// builds itself as you change any of them (POST /api/use-cases/generate). The
// server owns every rule about what each product can do; this file draws the
// results, keeps a shortlist, exports it, and hands it to the lab builder wizard.
//
// Every node is built with createElement and textContent. Nothing generated or
// typed here is ever parsed as HTML, so a hostile title or search term is only text.

const UC_STORAGE_KEY = "cslabs.useCaseBuilder.v1";
const UC_DEBOUNCE_MS = 250;
const UC_PAGE_SIZE = 12;
const UC_MAX_SHORTLIST = 40;
const UC_PRODUCTS = ["copilot-studio", "m365-copilot-agent-builder"];
const UC_PRODUCT_NAMES = { "copilot-studio": "Copilot Studio", "m365-copilot-agent-builder": "Agent Builder" };
const UC_PRODUCT_SECTION_TITLES = { "copilot-studio": "Copilot Studio use cases", "m365-copilot-agent-builder": "Agent Builder use cases" };
const UC_HARNESS_ORDER = ["standard", "microsoft-copilot", "customer-conversation"];
const UC_EFFORT_ORDER = { hours: 1, days: 2, weeks: 3 };
const UC_LEVELS = [100, 200, 300];
const UC_ID_PATTERN = /^[a-z0-9-]+\.[a-z0-9-]+\.[a-z0-9-]+$/;
const UC_SLUG = /^[a-z][a-z0-9-]*$/;

const ucState = {
  initialized: false,
  loading: false,
  options: null,
  inputs: { industry: "", departments: [], goals: [], dataSources: [], platform: "both", level: null, polish: false },
  response: null,
  error: "",
  busy: false,
  token: 0,
  timer: null,
  controller: null,
  view: { query: "", product: "all", level: "all", department: "all", goal: "all", sort: "best", shown: {} },
  shortlist: new Map(),
  refs: { industry: new Map(), departments: new Map(), goals: new Map(), dataSources: new Map(), platform: new Map(), level: new Map() },
  cards: new Map(),
  labLevel: "auto",
  lastCount: "",
  listenersBound: false,
};

// ── Small DOM helpers ───────────────────────────────────────────────────────
function ucEl(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "checked") {
      el.checked = Boolean(value);
    } else if (key === "value") {
      el.value = value;
    } else if (value === undefined || value === null || value === false) {
      continue;
    } else if (key === "text") {
      el.textContent = value;
    } else if (key === "class") {
      el.className = value;
    } else if (/^on[A-Z]/.test(key)) {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else {
      el.setAttribute(key, value === true ? "" : String(value));
    }
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return el;
}

function ucById(id) {
  return document.getElementById(id);
}

function ucClear(el) {
  if (el) el.replaceChildren();
}

function ucAnnounce(message, { page = false } = {}) {
  const el = (page && ucById("app-live")) || ucById("uc-announce") || ucById("app-live");
  if (!el || !message) return;
  const flip = el.dataset?.flip === "1";
  if (el.dataset) el.dataset.flip = flip ? "0" : "1";
  el.textContent = flip ? String(message) : `${message}\u00a0`;
}

// ── Copy confirmation ───────────────────────────────────────────────────────
// A copy click is acknowledged next to its button with a checkmark plus words (never color alone),
// using the same .sc-copy-ack look as the Screenshot Center. Screen readers hear it through ucAnnounce.
const UC_SVG_NS = "http://www.w3.org/2000/svg";
const UC_COPY_OK_MS = 3000;
const UC_COPY_FAIL_MS = 8000;
const ucCopyTimers = new WeakMap();

function ucCopyAckIcon(ok) {
  const svg = document.createElementNS(UC_SVG_NS, "svg");
  for (const [name, value] of Object.entries({ class: "sc-copy-ack-icon", viewBox: "0 0 16 16", width: "14", height: "14", "aria-hidden": "true", focusable: "false" })) {
    svg.setAttribute(name, value);
  }
  const path = document.createElementNS(UC_SVG_NS, "path");
  const shape = ok ? { d: "M3 8.5l3.2 3.2L13 4.8" } : { d: "M8 3.5v5.2M8 12.2v.1" };
  for (const [name, value] of Object.entries({ ...shape, fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round" })) {
    path.setAttribute(name, value);
  }
  svg.appendChild(path);
  return svg;
}

function ucShowCopyAck(el, ok, text) {
  if (!el) return;
  clearTimeout(ucCopyTimers.get(el));
  el.className = `sc-copy-ack ${ok ? "sc-copy-ack-ok" : "sc-copy-ack-fail"}`;
  el.replaceChildren(ucCopyAckIcon(ok), ucEl("span", { class: "sc-copy-ack-text", text }));
  ucCopyTimers.set(
    el,
    setTimeout(() => {
      el.className = "sc-copy-ack";
      el.replaceChildren();
    }, ok ? UC_COPY_OK_MS : UC_COPY_FAIL_MS),
  );
}

/** Copies text and shows the visible confirmation (or a clear fallback) next to the button. */
async function ucCopyText(text, ackEl, okText, failText) {
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    ok = false;
  }
  ucShowCopyAck(ackEl, ok, ok ? okText : failText);
  return ok;
}

function ucPlural(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

function ucUnique(values) {
  return [...new Set(values)];
}

function ucLevelText(level) {
  const label = { 100: "Beginner", 200: "Intermediate", 300: "Advanced" }[level];
  return label ? `Level ${level} (${label})` : `Level ${level}`;
}

/** Only https links on Microsoft Learn are ever drawn as links. */
function ucLearnHref(url) {
  try {
    const parsed = new URL(String(url));
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) return null;
    if (parsed.hostname !== "learn.microsoft.com") return null;
    return parsed.href;
  } catch {
    return null;
  }
}

// ── Option lookups ──────────────────────────────────────────────────────────
function ucOptionName(list, id, field = "name") {
  return (list || []).find((entry) => entry.id === id)?.[field] || id;
}

function ucSelectedIndustryId() {
  return ucState.inputs.industry;
}

function ucSelectedDepartmentIds() {
  return [...ucState.inputs.departments];
}

function ucScopeLabel() {
  const options = ucState.options;
  if (!options || !ucState.inputs.industry) return "";
  const parts = [ucOptionName(options.industries, ucState.inputs.industry)];
  for (const id of ucState.inputs.departments) parts.push(ucOptionName(options.departments, id));
  return parts.join(", ");
}

// ── Saved choices ───────────────────────────────────────────────────────────
function ucText(value, max) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "";
}

function ucSanitizeSnapshot(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = ucText(raw.id, 120);
  if (!UC_ID_PATTERN.test(id)) return null;
  const title = ucText(raw.title, 200);
  if (!title || !UC_PRODUCTS.includes(raw.product) || !UC_LEVELS.includes(raw.level)) return null;
  const list = (value, max, map) => (Array.isArray(value) ? value.slice(0, max).map(map).filter(Boolean) : []);
  const slug = (value) => (typeof value === "string" && UC_SLUG.test(value) ? value : "");
  return {
    id,
    title,
    description: ucText(raw.description, 900),
    product: raw.product,
    harness: slug(raw.harness) || null,
    harnessName: ucText(raw.harnessName, 80) || null,
    industry: slug(raw.industry),
    departments: list(raw.departments, 12, slug),
    goals: list(raw.goals, 7, slug),
    level: raw.level,
    effort: ucText(raw.effort, 40),
    kpis: list(raw.kpis, 4, (k) => ucText(k, 120) || null),
    whyProduct: ucText(raw.whyProduct, 900),
    instructions: ucText(raw.instructions, 1600),
    knowledge: list(raw.knowledge, 8, (k) => ucText(k, 160) || null),
    tools: list(raw.tools, 12, (k) => ucText(k, 160) || null),
    topics: list(raw.topics, 24, (t) => {
      const topicId = t && slug(t.id);
      return topicId ? { id: topicId, name: ucText(t.name, 120) || topicId, level: UC_LEVELS.includes(t.level) ? t.level : 100 } : null;
    }),
    links: list(raw.links, 3, (l) => {
      const href = l && ucLearnHref(l.url);
      return href ? { url: href, title: ucText(l.title, 160) || href } : null;
    }),
    preview: raw.preview === true,
  };
}

function ucSnapshot(useCase) {
  return ucSanitizeSnapshot({
    id: useCase.id,
    title: useCase.title,
    description: useCase.description,
    product: useCase.product,
    harness: useCase.harness,
    harnessName: useCase.harnessName,
    industry: useCase.industry,
    departments: useCase.departments,
    goals: useCase.goals,
    level: useCase.level,
    effort: useCase.effort?.label,
    kpis: useCase.value?.kpis,
    whyProduct: useCase.whyProduct,
    instructions: useCase.instructions,
    knowledge: (useCase.knowledgeSources || []).map((k) => `${k.label}: ${k.example}`),
    tools: (useCase.toolsAndActions || []).map((t) => `${t.label}: ${t.note}`),
    topics: (useCase.labTopics || []).map((t) => ({ id: t.id, name: t.name, level: t.level })),
    links: useCase.learnLinks,
    preview: Boolean(useCase.flags?.preview),
  });
}

/** Validate what was saved: ids must still exist, lists are capped, and anything odd is dropped. */
function ucSanitizeStored(raw, options) {
  const clean = { inputs: { industry: "", departments: [], goals: [], dataSources: [], platform: "both", level: null, polish: false }, shortlist: [] };
  if (!raw || typeof raw !== "object" || raw.v !== 1) return clean;
  const known = (list) => new Set((list || []).map((entry) => entry.id));
  const pick = (value, allowed) => {
    const wanted = new Set(Array.isArray(value) ? value.filter((id) => typeof id === "string") : []);
    return (allowed || []).map((entry) => entry.id).filter((id) => wanted.has(id));
  };
  const saved = raw.inputs && typeof raw.inputs === "object" ? raw.inputs : {};
  if (typeof saved.industry === "string" && known(options.industries).has(saved.industry)) clean.inputs.industry = saved.industry;
  clean.inputs.departments = pick(saved.departments, options.departments);
  clean.inputs.goals = pick(saved.goals, options.goals);
  clean.inputs.dataSources = pick(saved.dataSources, options.dataSources);
  if (typeof saved.platform === "string" && known(options.platforms).has(saved.platform)) clean.inputs.platform = saved.platform;
  if (UC_LEVELS.includes(saved.level)) clean.inputs.level = saved.level;
  clean.inputs.polish = saved.polish === true && Boolean(options.polish?.available);
  const seen = new Set();
  for (const entry of Array.isArray(raw.shortlist) ? raw.shortlist.slice(0, UC_MAX_SHORTLIST) : []) {
    const snapshot = ucSanitizeSnapshot(entry);
    if (snapshot && !seen.has(snapshot.id)) {
      seen.add(snapshot.id);
      clean.shortlist.push(snapshot);
    }
  }
  return clean;
}

function ucPersist() {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(UC_STORAGE_KEY, JSON.stringify({ v: 1, inputs: ucState.inputs, shortlist: [...ucState.shortlist.values()] }));
  } catch {
    // Storage can be full or blocked; the builder still works without it.
  }
}

function ucRestore(options) {
  let raw = null;
  try {
    if (typeof localStorage === "undefined") return;
    const text = localStorage.getItem(UC_STORAGE_KEY);
    if (!text) return;
    raw = JSON.parse(text);
  } catch {
    try {
      localStorage.removeItem?.(UC_STORAGE_KEY);
    } catch {
      // Nothing more to do.
    }
    return;
  }
  const clean = ucSanitizeStored(raw, options);
  ucState.inputs = clean.inputs;
  ucState.shortlist = new Map(clean.shortlist.map((snapshot) => [snapshot.id, snapshot]));
}

// ── Page skeleton ───────────────────────────────────────────────────────────
function ucChoiceChip(group, entry, labelOf) {
  const mark = ucEl("span", { class: "uc-chip-mark", "aria-hidden": "true", text: "\u2713", hidden: true });
  const button = ucEl(
    "button",
    { type: "button", class: "uc-chip", "aria-pressed": "false", "data-uc-id": entry.id, title: entry.description || false },
    mark,
    ucEl("span", { text: labelOf(entry) }),
  );
  button.addEventListener("click", () => ucToggleChoice(group, entry.id));
  ucState.refs[group].set(entry.id, { button, mark });
  return button;
}

function ucFieldset(legend, hint, body) {
  return ucEl("fieldset", { class: "uc-fieldset" }, ucEl("legend", { text: legend }), hint ? ucEl("p", { class: "uc-hint", text: hint }) : null, body);
}

function ucField(id, labelText, control, className = "") {
  return ucEl("div", { class: `form-group ${className}`.trim() }, ucEl("label", { for: id, text: labelText }), control);
}

function ucSelect(id, onChange) {
  const select = ucEl("select", { id });
  select.addEventListener("change", () => onChange(select.value));
  return select;
}

function ucSetOptions(select, entries, current) {
  ucClear(select);
  for (const [value, label] of entries) select.appendChild(ucEl("option", { value, text: label }));
  select.value = entries.some(([value]) => value === current) ? current : entries[0][0];
}

function ucBuildInputs(options) {
  const industryGrid = ucEl("div", { id: "uc-industry-grid", class: "uc-industry-grid", role: "group", "aria-label": "Industry" });
  for (const industry of options.industries) {
    const card = ucEl(
      "button",
      { type: "button", class: "scenario-card", "aria-pressed": "false", "data-uc-id": industry.id },
      ucEl("div", { class: "scenario-card-title" }, ucEl("span", { "aria-hidden": "true", style: "font-size: 22px;", text: industry.icon || "" }), ucEl("span", { text: industry.name })),
      ucEl("div", { class: "scenario-card-desc", text: industry.description || "" }),
    );
    card.addEventListener("click", () => ucSetIndustry(industry.id));
    ucState.refs.industry.set(industry.id, { button: card });
    industryGrid.appendChild(card);
  }

  const chips = (group, id, list, labelOf) => ucEl("div", { id, class: "uc-chip-group", role: "group" }, list.map((entry) => ucChoiceChip(group, entry, labelOf)));
  const platformGroup = ucEl("div", { id: "uc-platform-options", class: "uc-radio-group", role: "radiogroup", "aria-label": "Platform focus" });
  for (const platform of options.platforms) platformGroup.appendChild(ucRadioFor("platform", "uc-platform", platform.id, platform.label, platform.description));
  const levelGroup = ucEl("div", { id: "uc-level-options", class: "uc-radio-group", role: "radiogroup", "aria-label": "Skill level" });
  for (const level of options.levels) levelGroup.appendChild(ucRadioFor("level", "uc-level", level.value, level.label, level.description));

  const polishInput = ucEl("input", { type: "checkbox", id: "uc-polish", autocomplete: "off" });
  polishInput.addEventListener("change", () => {
    ucState.inputs.polish = polishInput.checked;
    ucInputsChanged();
  });
  const polish = ucEl(
    "label",
    { class: "uc-inline-check", id: "uc-polish-wrap", hidden: !options.polish?.available },
    polishInput,
    ucEl("span", { text: "Polish wording with AI (optional). Rewrites titles and descriptions only; products, features, and links never change." }),
  );
  const reset = ucEl("button", { type: "button", class: "btn btn-sm", id: "uc-reset", text: "Reset choices" });
  reset.addEventListener("click", ucResetInputs);

  return ucEl(
    "div",
    { class: "panel uc-inputs", id: "uc-inputs" },
    ucEl("h3", { text: "1. Your scenario" }),
    ucFieldset("Industry", "Choose one. The industry sets the vocabulary, systems, and examples in every use case.", industryGrid),
    ucFieldset("Departments", "Optional. Choose any number. Leave all off to see use cases from every department.", chips("departments", "uc-department-chips", options.departments, (d) => `${d.icon ? `${d.icon} ` : ""}${d.name}`)),
    ucFieldset("Business goals", "Optional. Goals move matching use cases up the list.", chips("goals", "uc-goal-chips", options.goals, (g) => g.label)),
    ucFieldset("Data and channels you already have", "Optional. Use cases that fit what you have rank higher. Choose None yet to favor use cases that need no prepared data.", chips("dataSources", "uc-source-chips", options.dataSources, (s) => s.label)),
    ucEl("div", { class: "uc-row" }, ucFieldset("Platform focus", null, platformGroup), ucFieldset("Skill level", "Beginner builds from instructions; Advanced adds custom connectors, governance, and channels.", levelGroup)),
    ucEl("div", { class: "uc-input-actions" }, polish, reset),
  );
}

function ucRadioFor(group, name, value, label, description) {
  const input = ucEl("input", { type: "radio", name, value: String(value ?? "any"), autocomplete: "off" });
  input.addEventListener("change", () => ucSetSingle(group, value));
  const wrapper = ucEl("label", { class: "uc-radio", title: description || false }, input, ucEl("span", { text: label }));
  ucState.refs[group].set(value, { input, wrapper });
  return wrapper;
}

function ucBuildResults() {
  const view = ucState.view;
  const search = ucEl("input", { type: "search", id: "uc-search", autocomplete: "off", placeholder: "Title, goal, tool, or keyword", value: view.query });
  search.addEventListener("input", () => {
    view.query = search.value;
    view.shown = {};
    ucRenderResults();
  });
  const filter = (id, key) => {
    const select = ucSelect(id, (value) => {
      view[key] = value;
      view.shown = {};
      ucRenderResults();
    });
    return select;
  };
  const sort = ucSelect("uc-sort", (value) => {
    view.sort = value;
    ucRenderResults();
  });
  ucSetOptions(sort, [["best", "Best match"], ["level", "Level, lowest first"], ["effort", "Effort, quickest first"]], view.sort);

  const selectAll = ucEl("button", { type: "button", class: "btn btn-sm", id: "uc-select-all", text: "Select all shown" });
  selectAll.addEventListener("click", ucSelectAllShown);
  const clearSelection = ucEl("button", { type: "button", class: "btn btn-sm", id: "uc-clear-selection", text: "Clear selection" });
  clearSelection.addEventListener("click", ucClearShortlist);
  const goTo = ucEl("button", { type: "button", class: "btn btn-sm", id: "uc-goto-shortlist", text: "Go to shortlist" });
  goTo.addEventListener("click", () => {
    const heading = ucById("uc-shortlist-heading");
    heading?.scrollIntoView?.({ block: "start" });
    heading?.focus();
  });

  const toolbar = ucEl(
    "div",
    { class: "uc-toolbar", id: "uc-toolbar", role: "group", "aria-label": "Filter, sort, and select use cases", hidden: true },
    ucField("uc-search", "Search", search, "uc-search"),
    ucField("uc-filter-product", "Product", filter("uc-filter-product", "product")),
    ucField("uc-filter-level", "Level", filter("uc-filter-level", "level")),
    ucField("uc-filter-department", "Department", filter("uc-filter-department", "department")),
    ucField("uc-filter-goal", "Goal", filter("uc-filter-goal", "goal")),
    ucField("uc-sort", "Sort by", sort),
    ucEl("div", { class: "uc-toolbar-buttons" }, selectAll, clearSelection, ucEl("span", { id: "uc-shortlist-count", class: "uc-hint", text: "0 shortlisted" }), goTo),
  );

  return ucEl(
    "div",
    { class: "panel uc-results", id: "uc-results", "aria-busy": "false" },
    ucEl("h3", { id: "uc-results-heading", tabindex: "-1", text: "2. Your use cases" }),
    ucEl("p", { class: "uc-count", id: "uc-count", role: "status", "aria-live": "polite" }),
    toolbar,
    ucEl("div", { class: "uc-notes", id: "uc-notes" }),
    ucEl("section", { class: "uc-best", id: "uc-best", "aria-labelledby": "uc-best-title", hidden: true }, ucEl("h4", { class: "uc-section-title", id: "uc-best-title", text: "Best matches" }), ucEl("div", { class: "uc-best-list", id: "uc-best-list" })),
    ucEl("div", { id: "uc-sections" }),
    ucEl("div", { id: "uc-empty" }),
  );
}

function ucBuildShortlistPanel() {
  const status = ucEl("p", { class: "uc-status", id: "uc-handoff-status", role: "status", "aria-live": "polite" });
  const button = (id, text, onClick, primary = false) => {
    const el = ucEl("button", { type: "button", class: primary ? "btn btn-primary" : "btn", id, text });
    el.addEventListener("click", onClick);
    return el;
  };
  return ucEl(
    "div",
    { class: "panel uc-shortlist", id: "uc-shortlist" },
    ucEl("h3", { id: "uc-shortlist-heading", tabindex: "-1", text: "3. Your shortlist" }),
    ucEl("p", { class: "uc-hint", id: "uc-shortlist-hint" }),
    ucEl("ul", { class: "uc-shortlist-list", id: "uc-shortlist-list", "aria-label": "Shortlisted use cases" }),
    ucEl(
      "div",
      { class: "uc-lab-level" },
      ucField(
        "uc-lab-level",
        "Lab level for the lab builder",
        ucSelect("uc-lab-level", (value) => {
          ucState.labLevel = value;
        }),
      ),
      ucEl("p", { class: "uc-hint", text: "The lab builder builds one level. Recommended topics from other levels are not selected; lower-level topics they need are added as short refreshers." }),
    ),
    ucEl(
      "div",
      { class: "uc-shortlist-actions" },
      button("uc-build-lab", "Build a lab from my shortlist", () => ucStartLab(false), true),
      button("uc-copy-md", "Copy as Markdown", () => ucCopy()),
      ucEl("span", { class: "sc-copy-ack", id: "uc-copy-md-ack" }),
      button("uc-download-md", "Download Markdown", () => ucDownloadAs("md")),
      button("uc-download-csv", "Download CSV", () => ucDownloadAs("csv")),
      button("uc-clear-shortlist", "Clear shortlist", ucClearShortlist),
    ),
    ucEl("div", { id: "uc-confirm" }),
    status,
  );
}

function ucBuildPage() {
  const root = ucById("uc-root");
  if (!root) return false;
  ucClear(root);
  const announce = ucEl("p", { id: "uc-announce", class: "sr-only", role: "status", "aria-live": "polite" });
  root.appendChild(announce);
  root.appendChild(ucBuildInputs(ucState.options));
  root.appendChild(ucBuildResults());
  root.appendChild(ucBuildShortlistPanel());
  ucState.lastCount = "";
  return true;
}

// ── Loading ─────────────────────────────────────────────────────────────────
function ucOnTabShown() {
  if (ucState.initialized || ucState.loading) return;
  ucInit();
}

async function ucInit() {
  const root = ucById("uc-root");
  if (!root) return;
  ucState.loading = true;
  try {
    const res = await fetch("/api/use-cases/options");
    const options = await res.json();
    if (!res.ok) throw new Error(options.error || `Request failed (${res.status})`);
    ucState.options = options;
    ucRestore(options);
    ucBuildPage();
    ucState.initialized = true;
    ucBindPrintHooks();
    ucSyncInputs();
    ucRenderShortlist();
    ucRenderResults();
    if (typeof scenarioSelectionChanged === "function") scenarioSelectionChanged();
    if (ucState.inputs.industry) ucScheduleGenerate(true);
  } catch (err) {
    ucClear(root);
    root.appendChild(
      ucEl(
        "div",
        { class: "panel" },
        ucEl("p", { class: "scenario-empty", role: "alert", text: `Could not load the Use Case Builder: ${err.message}` }),
        ucEl("button", { type: "button", class: "btn btn-sm", id: "uc-retry-load", text: "Try again", onClick: () => ucInit() }),
      ),
    );
  } finally {
    ucState.loading = false;
  }
}

// ── Inputs ──────────────────────────────────────────────────────────────────
function ucSyncInputs() {
  const { inputs, refs } = ucState;
  for (const [id, { button }] of refs.industry) button.setAttribute("aria-pressed", String(inputs.industry === id));
  for (const group of ["departments", "goals", "dataSources"]) {
    for (const [id, { button, mark }] of refs[group]) {
      const on = inputs[group].includes(id);
      button.setAttribute("aria-pressed", String(on));
      mark.hidden = !on;
    }
  }
  for (const [value, { input }] of refs.platform) input.checked = value === inputs.platform;
  for (const [value, { input }] of refs.level) input.checked = value === inputs.level;
  const polish = ucById("uc-polish");
  if (polish) polish.checked = inputs.polish;
}

function ucInputsChanged() {
  ucSyncInputs();
  ucPersist();
  if (typeof scenarioSelectionChanged === "function") scenarioSelectionChanged();
  ucState.view.shown = {};
  ucScheduleGenerate(false);
}

function ucSetIndustry(id) {
  ucState.inputs.industry = id;
  ucInputsChanged();
}

function ucToggleChoice(group, id) {
  const list = ucState.inputs[group];
  const next = new Set(list.includes(id) ? list.filter((entry) => entry !== id) : [...list, id]);
  // Keep the options' own order, so the request, the count line, and the saved choices read the same however the chips were clicked.
  ucState.inputs[group] = (ucState.options?.[group] || []).map((entry) => entry.id).filter((entryId) => next.has(entryId));
  ucInputsChanged();
}

function ucSetSingle(group, value) {
  if (group === "platform") ucState.inputs.platform = value;
  else ucState.inputs.level = value;
  ucInputsChanged();
}

function ucResetInputs() {
  ucState.inputs = { industry: "", departments: [], goals: [], dataSources: [], platform: "both", level: null, polish: false };
  ucInputsChanged();
  ucAnnounce("Choices reset. Choose an industry to build your use case list.");
}

// ── Generating ──────────────────────────────────────────────────────────────
function ucRequest() {
  const { industry, departments, goals, dataSources, platform, level, polish } = ucState.inputs;
  return { industry, departments, goals, dataSources, platform, level, polish };
}

function ucScheduleGenerate(immediate) {
  if (ucState.timer) clearTimeout(ucState.timer);
  ucState.timer = null;
  if (!ucState.inputs.industry) {
    ucState.token += 1;
    ucState.controller?.abort?.();
    ucState.response = null;
    ucState.error = "";
    ucState.busy = false;
    ucRenderResults();
    return;
  }
  ucState.timer = setTimeout(ucGenerate, immediate ? 0 : UC_DEBOUNCE_MS);
}

async function ucGenerate() {
  ucState.timer = null;
  if (!ucState.inputs.industry) return;
  const token = ++ucState.token;
  ucState.controller?.abort?.();
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  ucState.controller = controller;
  ucState.busy = true;
  ucById("uc-results")?.setAttribute("aria-busy", "true");
  try {
    const res = await fetch("/api/use-cases/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ucRequest()),
      signal: controller?.signal,
    });
    const data = await res.json();
    if (token !== ucState.token) return;
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    ucState.response = data;
    ucState.error = "";
  } catch (err) {
    if (token !== ucState.token || err?.name === "AbortError") return;
    ucState.error = err?.message || "Could not build the use cases.";
  }
  ucState.busy = false;
  ucById("uc-results")?.setAttribute("aria-busy", "false");
  ucRenderResults();
}

// ── Filtering and sorting ───────────────────────────────────────────────────
function ucSearchText(u) {
  const options = ucState.options;
  return [
    u.title,
    u.description,
    u.productName,
    u.harnessName,
    ...(u.goals || []).map((id) => ucOptionName(options?.goals, id, "label")),
    ...(u.departments || []).map((id) => ucOptionName(options?.departments, id)),
    ...(u.knowledgeSources || []).map((k) => k.label),
    ...(u.toolsAndActions || []).map((t) => t.label),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function ucFiltersActive() {
  const v = ucState.view;
  return Boolean(v.query.trim()) || v.product !== "all" || v.level !== "all" || v.department !== "all" || v.goal !== "all";
}

function ucMatchesView(u) {
  const v = ucState.view;
  if (v.product !== "all" && u.product !== v.product) return false;
  if (v.level !== "all" && String(u.level) !== v.level) return false;
  if (v.department !== "all" && !u.departments.includes(v.department)) return false;
  if (v.goal !== "all" && !u.goals.includes(v.goal)) return false;
  const query = v.query.trim().toLowerCase();
  return !query || ucSearchText(u).includes(query);
}

function ucSorted(list) {
  const rank = (a, b) => a.match.rank - b.match.rank;
  const sort = ucState.view.sort;
  const copy = [...list];
  if (sort === "level") copy.sort((a, b) => a.level - b.level || rank(a, b));
  else if (sort === "effort") copy.sort((a, b) => (UC_EFFORT_ORDER[a.effort.id] || 9) - (UC_EFFORT_ORDER[b.effort.id] || 9) || rank(a, b));
  else copy.sort(rank);
  return copy;
}

function ucVisibleByProduct() {
  const all = ucState.response?.useCases || [];
  return Object.fromEntries(UC_PRODUCTS.map((product) => [product, ucSorted(all.filter((u) => u.product === product && ucMatchesView(u)))]));
}

// ── Rendering results ───────────────────────────────────────────────────────
function ucSetCount(text) {
  const el = ucById("uc-count");
  if (!el || ucState.lastCount === text) return;
  ucState.lastCount = text;
  el.textContent = text;
}

function ucRefreshFilterOptions() {
  const response = ucState.response;
  const view = ucState.view;
  const options = ucState.options;
  const setFilter = (id, key, entries) => {
    const select = ucById(id);
    if (!select) return;
    if (!entries.some(([value]) => value === view[key])) view[key] = "all";
    ucSetOptions(select, entries, view[key]);
  };
  const products = UC_PRODUCTS.filter((p) => (response?.facets?.products?.[p] || 0) > 0);
  setFilter("uc-filter-product", "product", [["all", "All products"], ...products.map((p) => [p, UC_PRODUCT_NAMES[p]])]);
  setFilter("uc-filter-level", "level", [["all", "All levels"], ...UC_LEVELS.filter((l) => response?.facets?.levels?.[l]).map((l) => [String(l), ucLevelText(l)])]);
  setFilter("uc-filter-department", "department", [["all", "All departments"], ...Object.keys(response?.facets?.departments || {}).map((id) => [id, ucOptionName(options.departments, id)])]);
  setFilter("uc-filter-goal", "goal", [["all", "All goals"], ...Object.keys(response?.facets?.goals || {}).map((id) => [id, ucOptionName(options.goals, id, "label")])]);
  const sort = ucById("uc-sort");
  if (sort) sort.value = view.sort;
  const search = ucById("uc-search");
  if (search && search.value !== view.query) search.value = view.query;
}

function ucRenderEmpty(kind) {
  const host = ucById("uc-empty");
  ucClear(host);
  if (!host || !kind) return;
  if (kind === "choose") {
    host.appendChild(ucEl("div", { class: "uc-empty" }, ucEl("p", { text: "Choose an industry above and your use cases build here. Add departments, goals, or the data you already have to focus the list." })));
  } else if (kind === "filtered") {
    const clear = ucEl("button", { type: "button", class: "btn btn-sm", id: "uc-clear-filters", text: "Clear filters" });
    clear.addEventListener("click", () => {
      Object.assign(ucState.view, { query: "", product: "all", level: "all", department: "all", goal: "all", shown: {} });
      ucRenderResults();
      ucAnnounce("Filters cleared.");
    });
    host.appendChild(ucEl("div", { class: "uc-empty" }, ucEl("p", { text: "No use cases match these filters or that search." }), clear));
  } else if (kind === "error") {
    const retry = ucEl("button", { type: "button", class: "btn btn-sm", id: "uc-retry", text: "Try again" });
    retry.addEventListener("click", () => ucScheduleGenerate(true));
    host.appendChild(ucEl("div", { class: "uc-empty", role: "alert" }, ucEl("p", { text: `Could not build the use cases. ${ucState.error}` }), retry));
  } else if (kind === "none") {
    host.appendChild(ucEl("div", { class: "uc-empty" }, ucEl("p", { text: "No use cases matched these choices. Remove a goal or data source, or set the level to Any." })));
  }
}

function ucRenderResults() {
  ucState.cards = new Map();
  const toolbar = ucById("uc-toolbar");
  const sections = ucById("uc-sections");
  const notes = ucById("uc-notes");
  const best = ucById("uc-best");
  if (!sections || !notes || !toolbar || !best) return;
  ucClear(sections);
  ucClear(notes);
  const { response, inputs } = ucState;

  if (!inputs.industry) {
    toolbar.hidden = true;
    best.hidden = true;
    ucSetCount("Choose an industry to build your use case list.");
    ucRenderEmpty("choose");
    ucUpdateShortlistCount();
    return;
  }
  if (ucState.error && !response) {
    toolbar.hidden = true;
    best.hidden = true;
    ucSetCount("The use case list could not be built.");
    ucRenderEmpty("error");
    return;
  }
  if (!response) {
    toolbar.hidden = true;
    best.hidden = true;
    ucSetCount("Building your use cases...");
    ucRenderEmpty(null);
    return;
  }

  ucRefreshFilterOptions();
  toolbar.hidden = response.useCases.length === 0;
  const visible = ucVisibleByProduct();
  const shownTotal = UC_PRODUCTS.reduce((sum, p) => sum + visible[p].length, 0);
  const total = response.useCases.length;
  let count = `Showing ${shownTotal} of ${total} use cases for ${ucScopeLabel()}`;
  if (response.summary?.capped) count += `. These are the best ${total} of ${response.summary.matched} matches`;
  ucSetCount(`${count}.`);

  if (ucState.error) notes.appendChild(ucEl("p", { class: "uc-note uc-note-warn", role: "alert", text: `The list could not be refreshed: ${ucState.error}` }));
  for (const note of response.coverage?.notes || []) notes.appendChild(ucEl("p", { class: "uc-note", text: note }));
  if (response.polish?.requested && response.polish.note) notes.appendChild(ucEl("p", { class: "uc-note", text: response.polish.note }));

  ucRenderBest(response, best);
  if (!total) ucRenderEmpty("none");
  else if (!shownTotal) ucRenderEmpty("filtered");
  else ucRenderEmpty(null);

  for (const product of UC_PRODUCTS) {
    const all = response.useCases.filter((u) => u.product === product);
    if (!all.length || ucState.view.product !== "all" && ucState.view.product !== product) continue;
    sections.appendChild(ucRenderSection(product, visible[product], all.length));
  }
  ucUpdateShortlistCount();
}

function ucRenderBest(response, best) {
  const list = ucById("uc-best-list");
  ucClear(list);
  const byId = new Map(response.useCases.map((u) => [u.id, u]));
  const items = (response.bestMatches || []).map((id) => byId.get(id)).filter(Boolean);
  best.hidden = !items.length || ucFiltersActive();
  if (best.hidden) return;
  for (const u of items) {
    const why = u.match?.reasons?.[0] || "A strong fit for your choices";
    const titleId = `uc-best-title-${u.id}`;
    const button = ucAddButton(u, titleId);
    list.appendChild(
      ucEl("div", { class: "uc-best-item", "data-uc-id": u.id }, ucEl("h5", { class: "uc-card-title", id: titleId, text: u.title }), ucBadges(u), ucEl("p", { class: "uc-best-why", text: why }), button),
    );
  }
}

function ucRenderSection(product, visible, totalForProduct) {
  const view = ucState.view;
  const limit = view.shown[product] || UC_PAGE_SIZE;
  const headingId = `uc-section-title-${product}`;
  const list = ucEl("div", { class: "uc-list" });
  for (const u of visible.slice(0, limit)) list.appendChild(ucCard(u));
  const section = ucEl(
    "section",
    { class: "uc-section", id: `uc-section-${product}`, "aria-labelledby": headingId },
    ucEl("h4", { class: "uc-section-title", id: headingId }, UC_PRODUCT_SECTION_TITLES[product], ucEl("span", { class: "uc-section-sub", text: `${visible.length} of ${totalForProduct} shown` })),
    visible.length ? list : ucEl("p", { class: "uc-hint", text: "No use cases in this section match the filters." }),
  );
  if (visible.length > limit) {
    const more = ucEl("button", { type: "button", class: "btn uc-more", id: `uc-more-${product}`, text: `Show more (${visible.length - limit} more)` });
    more.addEventListener("click", () => {
      view.shown[product] = limit + UC_PAGE_SIZE;
      ucRenderResults();
      ucById(`uc-more-${product}`)?.focus();
    });
    section.appendChild(more);
  }
  return section;
}

function ucBadges(u) {
  const badges = [ucEl("span", { class: `uc-badge ${u.product === "copilot-studio" ? "uc-badge-cs" : "uc-badge-ab"}`, text: UC_PRODUCT_NAMES[u.product] || u.productName })];
  if (u.harnessName) badges.push(ucEl("span", { class: "uc-badge", text: u.harnessName }));
  badges.push(ucEl("span", { class: "uc-badge", text: ucLevelText(u.level) }));
  badges.push(ucEl("span", { class: "uc-badge", text: `Effort: ${u.effort.label}` }));
  if (u.flags?.preview) badges.push(ucEl("span", { class: "uc-badge uc-badge-warn", text: "Preview" }));
  if (u.flags?.thirdParty) badges.push(ucEl("span", { class: "uc-badge uc-badge-warn", text: "Third-party connector" }));
  if (u.match?.levelFit === "nearby") badges.push(ucEl("span", { class: "uc-badge uc-badge-warn", text: "Nearby level" }));
  if (u.polished) badges.push(ucEl("span", { class: "uc-badge", text: "Reworded with AI" }));
  return ucEl("div", { class: "uc-badges" }, badges);
}

function ucAddButton(u, titleId) {
  const mark = ucEl("span", { class: "uc-chip-mark", "aria-hidden": "true", text: "\u2713 ", hidden: !ucState.shortlist.has(u.id) });
  const button = ucEl("button", { type: "button", class: "btn btn-primary btn-sm", "aria-pressed": String(ucState.shortlist.has(u.id)), "aria-describedby": titleId, "data-uc-add": u.id }, mark, ucEl("span", { text: "Add to my lab plan" }));
  button.addEventListener("click", () => ucSetShortlisted(u, !ucState.shortlist.has(u.id)));
  const refs = ucState.cards.get(u.id) || [];
  refs.push({ button, mark });
  ucState.cards.set(u.id, refs);
  return button;
}

function ucBlock(title, ...content) {
  return ucEl("div", { class: "uc-detail-block" }, ucEl("h5", { text: title }), ...content);
}

function ucBullets(items) {
  return ucEl("ul", {}, items.map((text) => ucEl("li", { text })));
}

function ucDetails(u, titleId) {
  const instructionsId = `uc-instructions-${u.id}`;
  const copy = ucEl("button", { type: "button", class: "btn btn-sm uc-code-copy", "aria-describedby": titleId, text: "Copy instructions" });
  const copyAck = ucEl("span", { class: "sc-copy-ack" });
  copy.addEventListener("click", async () => {
    const okText = "Instructions copied to your clipboard";
    const failText = "Couldn't copy. Select the instructions and press Ctrl+C.";
    const ok = await ucCopyText(u.instructions, copyAck, okText, failText);
    ucAnnounce(ok ? `${okText}.` : failText);
  });
  const blocks = [
    ucBlock("Why this product", ucEl("p", { text: u.whyProduct })),
    ucBlock("Business value", ucBullets([...(u.value?.kpis || []).map((k) => `KPI: ${k}`), ...(u.value?.outcomes || [])])),
    ucBlock(
      "Knowledge sources",
      u.knowledgeSources?.length ? ucBullets(u.knowledgeSources.map((k) => `${k.label}: ${k.example}`)) : ucEl("p", { text: "None needed. The agent works from its instructions." }),
    ),
    ucBlock("Tools, connectors, and actions", u.toolsAndActions?.length ? ucBullets(u.toolsAndActions.map((t) => `${t.label}: ${t.note}${t.preview ? " (preview)" : ""}${t.thirdParty ? " (third-party)" : ""}`)) : ucEl("p", { text: "None needed." })),
  ];
  if (u.qualityAndGovernance?.length) blocks.push(ucBlock("Quality and governance", ucBullets(u.qualityAndGovernance.map((t) => `${t.label}: ${t.note}`))));
  blocks.push(ucBlock("Starter instructions", ucEl("pre", { class: "uc-code", id: instructionsId, text: u.instructions }), copy, copyAck));
  const before = [...(u.prerequisites || []), ...(u.harnessNotes || [])];
  if (before.length) blocks.push(ucBlock("Before you start", ucBullets(before)));
  blocks.push(ucBlock("Recommended lab topics", ucBullets((u.labTopics || []).map((t) => `${t.name} (${ucLevelText(t.level)}, about ${t.minutes} min)${t.preview ? ", preview" : ""}`))));
  if (u.match?.reasons?.length) blocks.push(ucBlock("Why it matched", ucBullets(u.match.reasons)));

  const links = (u.learnLinks || []).map((link) => ({ href: ucLearnHref(link.url), title: String(link.title || "Microsoft Learn") }));
  blocks.push(
    ucBlock(
      "Microsoft Learn",
      ucEl(
        "ul",
        {},
        links.map((link) =>
          ucEl("li", {}, link.href ? ucEl("a", { href: link.href, target: "_blank", rel: "noopener noreferrer", text: `${link.title} (opens in a new tab)` }) : link.title),
        ),
      ),
    ),
  );
  return ucEl("details", { class: "uc-details" }, ucEl("summary", { text: "Details: instructions, knowledge, tools, and why this product" }), blocks);
}

function ucCard(u) {
  const titleId = `uc-title-${u.id}`;
  const checkId = `uc-check-${u.id}`;
  const check = ucEl("input", { type: "checkbox", id: checkId, autocomplete: "off", "aria-describedby": titleId, checked: ucState.shortlist.has(u.id) });
  check.addEventListener("change", () => ucSetShortlisted(u, check.checked));
  const goals = ucEl("ul", { class: "uc-goals", "aria-label": "Goals this use case supports" }, (u.goals || []).map((id) => ucEl("li", { class: "uc-goal", text: ucOptionName(ucState.options?.goals, id, "label") })));
  const reasons = u.match?.missingData?.length ? ucEl("p", { class: "uc-why-matched", text: `Needs data you did not list: ${u.match.missingData.map((id) => ucOptionName(ucState.options?.dataSources, id, "label")).join(", ")}.` }) : null;
  const card = ucEl(
    "article",
    { class: `uc-card${ucState.shortlist.has(u.id) ? " is-shortlisted" : ""}`, "data-uc-id": u.id, "aria-labelledby": titleId },
    ucEl("div", { class: "uc-card-top" }, ucBadges(u), ucEl("label", { class: "uc-check", for: checkId }, check, ucEl("span", { text: "Shortlist" }))),
    ucEl("h5", { class: "uc-card-title", id: titleId, text: u.title }),
    ucEl("p", { class: "uc-desc", text: u.description }),
    goals,
    reasons,
    ucDetails(u, titleId),
    ucEl("div", { class: "uc-card-actions" }, ucAddButton(u, titleId)),
  );
  const refs = ucState.cards.get(u.id) || [];
  refs.push({ card, check });
  ucState.cards.set(u.id, refs);
  return card;
}

// ── Shortlist ───────────────────────────────────────────────────────────────
function ucShortlistItems() {
  return [...ucState.shortlist.values()];
}

function ucSyncCardState(id) {
  const on = ucState.shortlist.has(id);
  for (const ref of ucState.cards.get(id) || []) {
    if (ref.card) ref.card.classList.toggle("is-shortlisted", on);
    if (ref.check) ref.check.checked = on;
    if (ref.button) {
      ref.button.setAttribute("aria-pressed", String(on));
      ref.mark.hidden = !on;
    }
  }
}

function ucSetShortlisted(useCase, on) {
  if (on && !ucState.shortlist.has(useCase.id)) {
    if (ucState.shortlist.size >= UC_MAX_SHORTLIST) {
      ucAnnounce(`Your shortlist is full at ${UC_MAX_SHORTLIST} use cases. Remove one to add another.`);
      ucSyncCardState(useCase.id);
      return;
    }
    const snapshot = ucSnapshot(useCase);
    if (!snapshot) return;
    ucState.shortlist.set(useCase.id, snapshot);
  } else if (!on) {
    ucState.shortlist.delete(useCase.id);
  }
  ucSyncCardState(useCase.id);
  ucAfterShortlistChange(on ? `Added to your lab plan: ${useCase.title}.` : `Removed from your lab plan: ${useCase.title}.`);
}

function ucAfterShortlistChange(message) {
  ucPersist();
  ucRenderShortlist();
  ucUpdateShortlistCount();
  if (message) ucAnnounce(`${message} ${ucPlural(ucState.shortlist.size, "use case")} shortlisted.`);
}

function ucSelectAllShown() {
  const visible = ucVisibleByProduct();
  let added = 0;
  for (const product of UC_PRODUCTS) {
    const limit = ucState.view.shown[product] || UC_PAGE_SIZE;
    for (const u of visible[product].slice(0, limit)) {
      if (ucState.shortlist.has(u.id) || ucState.shortlist.size >= UC_MAX_SHORTLIST) continue;
      const snapshot = ucSnapshot(u);
      if (snapshot) {
        ucState.shortlist.set(u.id, snapshot);
        ucSyncCardState(u.id);
        added += 1;
      }
    }
  }
  ucAfterShortlistChange(added ? `Added ${ucPlural(added, "use case")}.` : "Everything shown is already shortlisted.");
}

function ucClearShortlist() {
  const ids = [...ucState.shortlist.keys()];
  ucState.shortlist.clear();
  ids.forEach(ucSyncCardState);
  ucHideConfirm();
  ucAfterShortlistChange(ids.length ? "Shortlist cleared." : "The shortlist is already empty.");
}

function ucUpdateShortlistCount() {
  const el = ucById("uc-shortlist-count");
  if (el) el.textContent = `${ucState.shortlist.size} shortlisted`;
  const clear = ucById("uc-clear-selection");
  if (clear) clear.disabled = ucState.shortlist.size === 0;
}

function ucRenderShortlist() {
  const list = ucById("uc-shortlist-list");
  if (!list) return;
  ucClear(list);
  const items = ucShortlistItems();
  const hint = ucById("uc-shortlist-hint");
  if (hint) {
    hint.textContent = items.length
      ? `${ucPlural(items.length, "use case")} on your lab plan. Build a lab from them, or export the list.`
      : "Use Add to my lab plan on any use case. Your shortlist is saved in this browser.";
  }
  for (const item of items) {
    const remove = ucEl("button", { type: "button", class: "btn btn-sm", text: "Remove", "aria-label": `Remove ${item.title} from the shortlist` });
    remove.addEventListener("click", () => {
      ucState.shortlist.delete(item.id);
      ucSyncCardState(item.id);
      ucAfterShortlistChange(`Removed from your lab plan: ${item.title}.`);
      ucById("uc-shortlist-heading")?.focus();
    });
    list.appendChild(ucEl("li", { class: "uc-shortlist-item" }, ucEl("span", { text: `${item.title} (${UC_PRODUCT_NAMES[item.product]}, ${ucLevelText(item.level)})` }), remove));
  }
  for (const id of ["uc-build-lab", "uc-copy-md", "uc-download-md", "uc-download-csv", "uc-clear-shortlist"]) {
    const button = ucById(id);
    if (button) button.disabled = items.length === 0;
  }
  ucRenderLabLevel(items);
}

function ucRenderLabLevel(items) {
  const select = ucById("uc-lab-level");
  if (!select) return;
  const counts = ucTopicCountsByLevel(items);
  const entries = [["auto", items.length ? `Automatic: ${ucLevelText(ucBestLevel(items))}` : "Automatic"]];
  for (const level of UC_LEVELS) entries.push([String(level), `${ucLevelText(level)}: ${ucPlural(counts[level], "topic")} from your shortlist`]);
  if (!entries.some(([value]) => value === ucState.labLevel)) ucState.labLevel = "auto";
  ucSetOptions(select, entries, ucState.labLevel);
  select.disabled = items.length === 0;
}

// ── Export ──────────────────────────────────────────────────────────────────
function ucMdText(text) {
  return String(text ?? "").replace(/[\r\n]+/g, " ").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function ucFence(text) {
  const longest = Math.max(2, ...[...String(text).matchAll(/`+/g)].map((m) => m[0].length));
  return "`".repeat(longest + 1);
}

function ucScopeFor(items) {
  const options = ucState.options;
  const industries = ucUnique(items.map((i) => i.industry)).map((id) => ucOptionName(options?.industries, id));
  const departments = ucUnique(items.flatMap((i) => i.departments)).map((id) => ucOptionName(options?.departments, id));
  return [...industries, ...departments].join(", ");
}

/** The shortlist as Markdown. Text is plain; angle brackets are escaped so a renderer never sees markup. */
function ucBuildMarkdown(items, scope = ucScopeFor(items)) {
  const options = ucState.options;
  const lines = [`# Use case shortlist${scope ? `: ${ucMdText(scope)}` : ""}`, "", `${ucPlural(items.length, "use case")}. Built with the Use Case Builder. Verify product details on Microsoft Learn before you commit.`, ""];
  items.forEach((u, index) => {
    lines.push(`## ${index + 1}. ${ucMdText(u.title)}`, "");
    lines.push(`- **Product:** ${UC_PRODUCT_NAMES[u.product] || u.product}${u.harnessName ? ` (${ucMdText(u.harnessName)})` : ""}`);
    lines.push(`- **Level:** ${ucLevelText(u.level)}`);
    if (u.effort) lines.push(`- **Build effort:** ${ucMdText(u.effort)}`);
    if (u.departments.length) lines.push(`- **Departments:** ${u.departments.map((id) => ucMdText(ucOptionName(options?.departments, id))).join(", ")}`);
    if (u.goals.length) lines.push(`- **Goals:** ${u.goals.map((id) => ucMdText(ucOptionName(options?.goals, id, "label"))).join(", ")}`);
    if (u.preview) lines.push("- **Note:** Includes Preview capabilities.");
    lines.push("", ucMdText(u.description), "");
    if (u.kpis.length) lines.push("**Business value (KPIs)**", "", ...u.kpis.map((k) => `- ${ucMdText(k)}`), "");
    if (u.whyProduct) lines.push("**Why this product**", "", ucMdText(u.whyProduct), "");
    if (u.knowledge.length) lines.push("**Knowledge sources**", "", ...u.knowledge.map((k) => `- ${ucMdText(k)}`), "");
    if (u.tools.length) lines.push("**Tools, connectors, and actions**", "", ...u.tools.map((t) => `- ${ucMdText(t)}`), "");
    if (u.instructions) {
      const fence = ucFence(u.instructions);
      lines.push("**Starter instructions**", "", fence, u.instructions, fence, "");
    }
    if (u.topics.length) lines.push("**Recommended lab topics**", "", ...u.topics.map((t) => `- ${ucMdText(t.name)} (${ucLevelText(t.level)})`), "");
    if (u.links.length) lines.push("**Microsoft Learn**", "", ...u.links.map((l) => `- [${ucMdText(l.title).replace(/[[\]]/g, "")}](${l.url})`), "");
  });
  return `${lines.join("\n").trimEnd()}\n`;
}

/** One CSV cell: always quoted, and a leading = + - @ tab or return is defused so a spreadsheet never runs it as a formula. */
function ucCsvCell(value) {
  let text = String(value ?? "").replace(/\r?\n/g, " ");
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function ucBuildCsv(items) {
  const options = ucState.options;
  const header = ["Id", "Title", "Product", "Harness", "Level", "Build effort", "Departments", "Goals", "Description", "KPIs", "Knowledge sources", "Tools and actions", "Why this product", "Recommended lab topics", "Learn links"];
  const rows = items.map((u) => [
    u.id,
    u.title,
    UC_PRODUCT_NAMES[u.product] || u.product,
    u.harnessName || "",
    ucLevelText(u.level),
    u.effort,
    u.departments.map((id) => ucOptionName(options?.departments, id)).join("; "),
    u.goals.map((id) => ucOptionName(options?.goals, id, "label")).join("; "),
    u.description,
    u.kpis.join("; "),
    u.knowledge.join("; "),
    u.tools.join("; "),
    u.whyProduct,
    u.topics.map((t) => t.name).join("; "),
    u.links.map((l) => l.url).join(" "),
  ]);
  return [header, ...rows].map((row) => row.map(ucCsvCell).join(",")).join("\r\n") + "\r\n";
}

async function ucCopy() {
  const items = ucShortlistItems();
  if (!items.length) return;
  const failText = "Couldn't copy. Use Download Markdown instead.";
  const ok = await ucCopyText(ucBuildMarkdown(items), ucById("uc-copy-md-ack"), "Shortlist copied to your clipboard", failText);
  const message = ok ? "Copied the shortlist as Markdown." : "Copy is not available in this browser. Use Download Markdown instead.";
  ucSetStatus(message);
  ucAnnounce(message);
}

function ucDownloadAs(kind) {
  const items = ucShortlistItems();
  if (!items.length) return;
  const isCsv = kind === "csv";
  const text = isCsv ? ucBuildCsv(items) : ucBuildMarkdown(items);
  const blob = new Blob([text], { type: isCsv ? "text/csv;charset=utf-8" : "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = ucEl("a", { href: url, download: `use-case-shortlist.${isCsv ? "csv" : "md"}` });
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  ucSetStatus(`Downloaded the shortlist as ${isCsv ? "CSV" : "Markdown"}.`);
  ucAnnounce(`Downloaded the shortlist as ${isCsv ? "CSV" : "Markdown"}.`);
}

function ucSetStatus(text) {
  const el = ucById("uc-handoff-status");
  if (el) el.textContent = text;
}

// ── Hand-off to the lab builder wizard ──────────────────────────────────────
function ucMostCommon(values, order, fallback) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  const best = Math.max(0, ...counts.values());
  const top = [...counts].filter(([, n]) => n === best).map(([value]) => value);
  if (!top.length) return fallback;
  return order ? [...top].sort((a, b) => order.indexOf(a) - order.indexOf(b))[0] : top[0];
}

/** The level most shortlisted use cases are at; a tie goes to the higher level, since lower-level topics arrive as refreshers. */
function ucBestLevel(items) {
  const counts = new Map(UC_LEVELS.map((level) => [level, 0]));
  for (const item of items) counts.set(item.level, (counts.get(item.level) || 0) + 1);
  let best = 100;
  for (const level of UC_LEVELS) if (counts.get(level) >= counts.get(best)) best = level;
  return best;
}

/** How many distinct recommended topics the shortlist has at each level, for the Lab level choice. */
function ucTopicCountsByLevel(items) {
  const byLevel = new Map(UC_LEVELS.map((level) => [level, new Set()]));
  for (const item of items) for (const topic of item.topics) byLevel.get(topic.level)?.add(topic.id);
  return Object.fromEntries(UC_LEVELS.map((level) => [level, byLevel.get(level).size]));
}

/**
 * Turn a shortlist into wizard answers. The wizard builds one lab at one level
 * on one harness, so a mixed shortlist resolves to the level most of its use
 * cases are at (or the Lab level you pick) and the harness most of its Copilot
 * Studio use cases share. The wizard then skips any topic its own rules do not
 * allow and says so.
 */
function ucPlanLab(items, { level = null, industry = "" } = {}) {
  const options = ucState.options;
  const products = UC_PRODUCTS.filter((p) => items.some((i) => i.product === p));
  const industryId = ucMostCommon(items.map((i) => i.industry).filter(Boolean), null, industry) || industry;
  const knownDepartments = (options?.departments || []).map((d) => d.id);
  const departments = knownDepartments.filter((id) => items.some((i) => i.departments.includes(id)));
  const labLevel = UC_LEVELS.includes(level) ? level : ucBestLevel(items);
  const harness = ucMostCommon(items.filter((i) => i.harness).map((i) => i.harness), UC_HARNESS_ORDER, null);
  const topicIds = ucUnique(items.flatMap((i) => i.topics.map((t) => t.id)));

  const industryName = ucOptionName(options?.industries, industryId);
  const productNames = products.map((p) => UC_PRODUCT_NAMES[p]);
  const productPhrase = productNames.length > 1 ? `${productNames.slice(0, -1).join(", ")} and ${productNames.at(-1)}` : productNames[0] || "AI agent";
  const departmentNames = departments.map((id) => ucOptionName(options?.departments, id));
  const scope = departmentNames.length === 0 ? industryName : departmentNames.length <= 2 ? `${industryName} ${departmentNames.join(" and ")}` : `${industryName} cross-department`;
  const title = `${scope}: ${productPhrase} use cases`.slice(0, 150);
  return { products, industry: industryId, departments, level: labLevel, harness, topicIds, title };
}

function ucWizardHasProgress() {
  return typeof lbHasProgress === "function" && lbHasProgress();
}

function ucHideConfirm() {
  ucClear(ucById("uc-confirm"));
}

function ucShowConfirm() {
  const host = ucById("uc-confirm");
  if (!host) return;
  ucClear(host);
  const replace = ucEl("button", { type: "button", class: "btn btn-primary btn-sm", id: "uc-confirm-replace", text: "Replace and continue" });
  replace.addEventListener("click", () => ucStartLab(true));
  const keep = ucEl("button", { type: "button", class: "btn btn-sm", id: "uc-confirm-keep", text: "Keep my current lab" });
  keep.addEventListener("click", () => {
    ucHideConfirm();
    ucById("uc-build-lab")?.focus();
    ucAnnounce("Kept your current lab. Nothing changed.");
  });
  host.appendChild(
    ucEl(
      "div",
      { class: "uc-confirm", role: "alertdialog", "aria-labelledby": "uc-confirm-text" },
      ucEl("p", { id: "uc-confirm-text", text: "The lab builder already has answers. Building from your shortlist replaces them, and your saved labs are not touched." }),
      ucEl("div", { class: "uc-confirm-actions" }, replace, keep),
    ),
  );
  replace.focus();
}

function ucHandoffMessage(plan, result) {
  const names = plan.products.map((p) => UC_PRODUCT_NAMES[p]).join(" and ");
  const skipped = result.skipped.level.length + result.skipped.harness.length + result.skipped.product.length;
  const parts = [`Lab builder pre-filled from your shortlist: ${names}, ${ucLevelText(result.level)}, ${ucPlural(result.selected, "topic")} selected.`];
  if (result.skipped.level.length) {
    parts.push(`${ucPlural(result.skipped.level.length, "recommended topic")} from other levels ${result.skipped.level.length === 1 ? "was" : "were"} not selected. Lower-level topics your selection needs are added as short refreshers.`);
  }
  if (result.skipped.harness.length) parts.push(`${ucPlural(result.skipped.harness.length, "topic")} for another agent experience (harness) ${result.skipped.harness.length === 1 ? "was" : "were"} skipped.`);
  if (!result.selected && skipped) parts.push("On the Tailor it step, choose a different level or agent experience to see them.");
  parts.push("You are on the Topics step. Change anything before you build.");
  return parts.join(" ");
}

async function ucStartLab(force) {
  const items = ucShortlistItems();
  if (!items.length) return;
  if (!force && ucWizardHasProgress()) {
    ucShowConfirm();
    return;
  }
  ucHideConfirm();
  if (typeof lbPrefillFromUseCases !== "function") {
    ucSetStatus("The lab builder is not available on this page.");
    return;
  }
  const plan = ucPlanLab(items, { level: ucState.labLevel === "auto" ? null : Number(ucState.labLevel), industry: ucState.inputs.industry });
  try {
    const result = await lbPrefillFromUseCases(plan);
    const message = ucHandoffMessage(plan, result);
    ucSetStatus(message);
    ucAnnounce(message, { page: true });
    if (typeof toast === "function") toast(message, "info");
  } catch (err) {
    ucSetStatus(`Could not start the lab: ${err.message}`);
    ucAnnounce(`Could not start the lab: ${err.message}`);
  }
}

// ── Printing ────────────────────────────────────────────────────────────────
// Printing from this tab prints the results with every card expanded and without the controls.
function ucBindPrintHooks() {
  if (ucState.listenersBound || typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  ucState.listenersBound = true;
  let opened = [];
  let owned = false;
  window.addEventListener("beforeprint", () => {
    if (!document.getElementById("panel-scenarios")?.classList.contains("active") || document.body.dataset.printTarget) return;
    document.body.dataset.printTarget = "usecases";
    owned = true;
    opened = [...(document.querySelectorAll(".uc-details") || [])].filter((el) => !el.open);
    opened.forEach((el) => {
      el.open = true;
    });
  });
  window.addEventListener("afterprint", () => {
    if (!owned) return;
    delete document.body.dataset.printTarget;
    opened.forEach((el) => {
      el.open = false;
    });
    opened = [];
    owned = false;
  });
}
