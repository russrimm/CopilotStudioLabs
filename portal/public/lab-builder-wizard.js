// ── Guided lab builder wizard ───────────────────────────────────────────────
// Four steps: product, tailor it (industry, departments, level, and the harness only when a
// selected product has harnesses, every default visibly selected), topics, then review and build.
// Each answer feeds the topic recommendations through /api/lab-builder/recommend, so the
// server owns every rule and this file only renders. Time is guidance
// everywhere: nothing here limits a lab.
// The generate, decision, and result functions live in app.js.

const LB_STEPS = [
  { id: 1, label: "Product" },
  { id: 2, label: "Tailor it" },
  { id: 3, label: "Topics" },
  { id: 4, label: "Review and build" },
];

// Named step ids, so no rule below depends on a bare number.
const LB_STEP = { product: 1, tailor: 2, topics: 3, review: 4 };
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
  // Start with no products selected so learners explicitly choose the product(s) for their lab.
  selectedProducts: new Set(),
  selectedRoles: new Set(),
  // Tracks which wizard steps the learner has explicitly chosen or confirmed so
  // "Your lab so far" never shows default values for unvisited steps.
  chosenSteps: new Set(),
  level: 100,
  harness: "standard",
  // "single" builds for the harness chosen above. "both" covers two harnesses one after another in one lab (see lbIsBoth).
  harnessMode: "single",
  // The two harnesses a "both" lab covers, in the order they are taught: Standard (Classic) first, then Microsoft Copilot.
  harnessOrder: ["standard", "microsoft-copilot"],
  // null means "the default counterpart harness"; a Set is the learner's own choice.
  differencesFor: null,
  differenceDefaults: {},
  // null means "the recommendation as computed"; a Set is the learner's own picks.
  picked: null,
  excluded: new Set(),
  // Sub-topic ids the learner left out. Every sub-topic of a selected topic is included unless it is named here.
  excludedSubtopics: new Set(),
  // Topics whose long sub-topic list is shown in full ("Show N more sub-topics").
  expandedSubtopics: new Set(),
  // The concept groups and topic rows the person opened on the Topics step, kept across re-renders.
  openGroups: new Set(),
  openRows: new Set(),
  // Review and build: whether the order controls, step numbers, and Microsoft Learn links are shown on the outline.
  editOrder: false,
  // True while the picks are the suggestion and have not been touched (see lbIsSuggestedSelection).
  pickedAuto: false,
  // Export All Topics: the full dataset for the chosen products, keyed by the answers it was built for.
  exportData: null,
  exportSignature: null,
  exportBusy: false,
  exportFailedSignature: null,
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
  // Set when unchecking a topic keeps it checked as a required prerequisite of another selected topic.
  prereqNotice: null,
  pendingUncheckIds: [],
  // Modules deselected on the review step so people can re-select them right in the outline.
  step7Removed: new Map(),
  moduleOrder: [],
  previewModules: [],
  previewToken: null,
  // Whether the collapsed prerequisite and unknown-level groups are open; kept across re-renders.
  prereqOpen: false,
  unknownOpen: false,
  // Opt-in per-lesson multiple-choice Knowledge Check mini-quiz (off by default on a fresh wizard start).
  includeKnowledgeCheck: false,
  // SharePoint training target site details (optional; a blank site builds with placeholder instructions).
  sharepointSiteName: "",
  sharepointSiteUrl: "",
  sharepointPromptBound: false,
  previewRequiresSharepointSite: null,
  // Brand profile and per-lab overrides chosen in "Review and build" (Brand: ... Change).
  // profileId null follows the active profile; prefilled remembers the SharePoint default last copied into the field.
  brand: { profileId: null, overrides: {}, prefilled: { name: "", url: "" }, bound: false },
};

const LB_SHAREPOINT_STORAGE_KEY = "cslabs.labBuilder.sharepointSite";
const LB_CONTROL_CHARS_RE = /[\u0000-\u001F\u007F]/g;
const LB_SHAREPOINT_FEATURE_IDS = new Set([
  "knowledge-sharepoint",
  "mc-knowledge",
  "mc-knowledge-enterprise",
  "dca-agent-builder-knowledge",
  "dca-toolkit-knowledge-capabilities",
  "dca-knowledge-sharepoint-onedrive",
  "m365h-data-access-governance-reports",
  "m365h-restricted-content-discovery",
  "m365h-secure-copilot-data",
  "ppai-document-processing-model",
  "sp-ai-page-approval-flow",
]);
const LB_SHAREPOINT_STEP_ACTION_RE =
  /\b(?:create|open|navigate\s+to|go\s+to|enter|paste|provide|type|connect|ground|restrict|govern|assess|review|run\s+data\s+access\s+governance\s+reports\s+for)\b[^.]{0,90}\bsharepoint\s+(?:site|sites|url|urls|document\s+library|library|libraries|list|lists|page|pages|team\s+site|communication\s+site)\b|\bsharepoint\.com\/(?:sites|teams)\b|\bOneDriveAndSharePoint\b/i;
const LB_SHAREPOINT_CAPABILITY_RE = /^(?:sharepoint|onedriveandsharepoint|sharepoint-online|spo|sam)$/i;
const LB_BARE_HOSTNAME_URL_RE =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+(?:\/.*)?$/i;
const LB_UNSAFE_URL_SCHEME_RE = /^\s*(?:javascript|data|vbscript|file|blob):/i;

/** Mirrors `featureRequiresSharepointSite` in `portal/lib/lab-builder/sharepoint-site.js`. */
function lbFeatureRequiresSharepointSite(feature) {
  if (!feature) return false;
  if (typeof feature === "string") {
    const rawId = feature.trim();
    if (!rawId) return false;
    return (
      LB_SHAREPOINT_FEATURE_IDS.has(rawId) ||
      /^sp(?:ai|-ai)-/i.test(rawId) ||
      /\bsharepoint\b/i.test(rawId)
    );
  }
  if (typeof feature !== "object") return false;
  if (feature.requiresSharepointSite === true) return true;

  const id = String(feature.id || "").trim();
  const product = String(feature.product || "").trim();
  if (product === "sharepoint-ai") return true;
  if (
    id &&
    (LB_SHAREPOINT_FEATURE_IDS.has(id) || /^sp(?:ai|-ai)-/i.test(id) || /\bsharepoint\b/i.test(id))
  ) {
    return true;
  }

  const name = String(feature.name || "");
  if (/\bsharepoint\b/i.test(name)) return true;

  const summaryWithoutBillingService = String(feature.summary || "").replace(
    /\bsharepoint\s+agents\b/gi,
    ""
  );
  if (/\bsharepoint\b|\bOneDriveAndSharePoint\b/i.test(summaryWithoutBillingService)) {
    return true;
  }

  for (const list of [feature.tags, feature.capabilities, feature.connectors]) {
    if (!Array.isArray(list)) continue;
    if (
      list.some((item) => {
        const token = String(item || "").trim();
        return LB_SHAREPOINT_CAPABILITY_RE.test(token) || /\bsharepoint\b/i.test(token);
      })
    ) {
      return true;
    }
  }

  if (Array.isArray(feature.prerequisites)) {
    if (feature.prerequisites.some((entry) => /\bsharepoint\b/i.test(String(entry || "")))) {
      return true;
    }
  }

  if (Array.isArray(feature.steps)) {
    if (feature.steps.some((step) => LB_SHAREPOINT_STEP_ACTION_RE.test(String(step || "")))) {
      return true;
    }
  }

  if (Array.isArray(feature.screenshots)) {
    if (feature.screenshots.some((shot) => /^sharepoint-/i.test(String(shot?.section || "")))) {
      return true;
    }
  }

  return false;
}

/** Whether the current product + topic selection requires having or creating a SharePoint site. */
function lbRequiresSharepointSite() {
  if (labBuilder.selectedProducts.has("sharepoint-ai")) return true;
  if (!labBuilder.selectedProducts.size && !labBuilder.picked?.size) return false;
  if (labBuilder.rec?.requiresSharepointSite === true && lbSelectedCount() > 0) return true;
  if (labBuilder.previewRequiresSharepointSite === true && lbSelectedCount() > 0) return true;

  const catalogById = new Map(lbFeatureList().map((f) => [f.id, f]));
  const recById = new Map([
    ...(labBuilder.rec?.concepts || []).flatMap((c) => c.topics).map((t) => [t.id, t]),
    ...(labBuilder.rec?.levelUnknown?.topics || []).map((t) => [t.id, t]),
    ...(labBuilder.rec?.prerequisites?.topics || []).map((p) => [p.id, p]),
  ]);

  const activeIds = labBuilder.rec
    ? [...(labBuilder.rec.selectedIds || []), ...(labBuilder.rec.prerequisites?.selectedIds || [])]
    : [...(labBuilder.picked || [])].filter((id) => !labBuilder.excluded.has(id));

  for (const id of activeIds) {
    const recItem = recById.get(id);
    if (recItem && lbFeatureRequiresSharepointSite(recItem)) return true;
    const catItem = catalogById.get(id);
    if (catItem && lbFeatureRequiresSharepointSite(catItem)) return true;
    if (lbFeatureRequiresSharepointSite(id)) return true;
  }
  return false;
}

function lbNormalizeSharepointSiteName(rawName) {
  if (typeof rawName !== "string") return "";
  return rawName
    .replace(LB_CONTROL_CHARS_RE, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function lbValidateSharepointSiteUrl(rawUrl) {
  if (rawUrl === undefined || rawUrl === null) {
    return { valid: true, url: "", error: null };
  }
  if (typeof rawUrl !== "string") {
    return {
      valid: false,
      url: "",
      error:
        "Enter a valid http:// or https:// SharePoint site URL (for example, https://contoso.sharepoint.com/sites/OperationsHub).",
    };
  }
  const cleaned = rawUrl.replace(LB_CONTROL_CHARS_RE, "").trim();
  if (!cleaned) return { valid: true, url: "", error: null };

  if (LB_UNSAFE_URL_SCHEME_RE.test(cleaned) || cleaned.startsWith("//") || /[<>"`\s]/.test(cleaned)) {
    return {
      valid: false,
      url: "",
      error:
        "Enter a valid http:// or https:// SharePoint site URL (for example, https://contoso.sharepoint.com/sites/OperationsHub).",
    };
  }

  let candidate = cleaned;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(candidate)) {
    if (LB_BARE_HOSTNAME_URL_RE.test(candidate)) {
      candidate = `https://${candidate}`;
    } else {
      return {
        valid: false,
        url: "",
        error:
          "Enter a valid http:// or https:// SharePoint site URL (for example, https://contoso.sharepoint.com/sites/OperationsHub).",
      };
    }
  }

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return {
      valid: false,
      url: "",
      error:
        "Enter a valid http:// or https:// SharePoint site URL (for example, https://contoso.sharepoint.com/sites/OperationsHub).",
    };
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return {
      valid: false,
      url: "",
      error:
        "SharePoint site URL must start with https:// or http:// (for example, https://contoso.sharepoint.com/sites/OperationsHub).",
    };
  }
  if (parsed.username || parsed.password) {
    return {
      valid: false,
      url: "",
      error: "SharePoint site URL must not include embedded credentials.",
    };
  }

  const host = parsed.hostname || "";
  if (!host || !host.includes(".") || host.startsWith(".") || host.endsWith(".") || host.includes("..")) {
    return {
      valid: false,
      url: "",
      error:
        "Enter a complete SharePoint site domain and URL (for example, https://contoso.sharepoint.com/sites/OperationsHub).",
    };
  }

  const rawAfterOrigin = candidate.replace(/^https?:\/\/[^/?#]+/i, "");
  const hadExplicitRootSlash = rawAfterOrigin.startsWith("/");
  const normalized =
    parsed.pathname === "/" && !hadExplicitRootSlash && !parsed.search && !parsed.hash
      ? parsed.origin
      : `${parsed.origin}${parsed.pathname}${parsed.search}${parsed.hash}`;

  return { valid: true, url: normalized, error: null };
}

function lbDeriveSharepointSiteLabel(validUrl) {
  if (!validUrl) return "";
  try {
    const parsed = new URL(validUrl);
    const segments = parsed.pathname
      .split("/")
      .map((seg) => {
        try {
          return decodeURIComponent(seg).trim();
        } catch {
          return seg.trim();
        }
      })
      .filter(Boolean);
    const sitesIdx = segments.findIndex((seg) => /^(?:sites|teams)$/i.test(seg));
    const candidate =
      sitesIdx >= 0 && segments[sitesIdx + 1]
        ? segments[sitesIdx + 1]
        : segments.length
        ? segments[segments.length - 1]
        : "";
    if (candidate && !/\.(?:aspx|html?|pdf|docx?)$/i.test(candidate)) {
      const humanized = candidate
        .replace(/[-_]+/g, " ")
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/\s+/g, " ")
        .trim();
      if (humanized) return `${humanized} (${parsed.hostname})`;
    }
    return parsed.hostname || validUrl;
  } catch {
    return validUrl;
  }
}

function lbReadSharepointRawInputs() {
  const nameEl = document.getElementById("lb-sharepoint-site-name");
  const urlEl = document.getElementById("lb-sharepoint-site-url");
  const rawName = typeof nameEl?.value === "string" ? nameEl.value : labBuilder.sharepointSiteName || "";
  const rawUrl = typeof urlEl?.value === "string" ? urlEl.value : labBuilder.sharepointSiteUrl || "";
  return { nameEl, urlEl, rawName, rawUrl };
}

function lbResolveSharepointSiteState() {
  const requiresSharepointSite = lbRequiresSharepointSite();
  const { nameEl, urlEl, rawName, rawUrl } = lbReadSharepointRawInputs();
  const name = lbNormalizeSharepointSiteName(rawName);
  const checkedUrl = lbValidateSharepointSiteUrl(rawUrl);
  const url = checkedUrl.valid ? checkedUrl.url : "";
  const label = name || lbDeriveSharepointSiteLabel(url) || "";
  return {
    requiresSharepointSite,
    nameEl,
    urlEl,
    rawName,
    rawUrl: typeof rawUrl === "string" ? rawUrl.replace(LB_CONTROL_CHARS_RE, "").trim() : "",
    name,
    url,
    label,
    validUrl: checkedUrl.valid,
    urlError: checkedUrl.error,
    configured: Boolean(name || url),
  };
}

/** Forget what the last preview said about SharePoint, so the next answer is worked out again from the topics. */
function lbInvalidateSharepointPreview() {
  labBuilder.previewRequiresSharepointSite = null;
}

function lbSaveSelections() {
  const { rawName, rawUrl } = lbReadSharepointRawInputs();
  const name = lbNormalizeSharepointSiteName(rawName);
  const checkedUrl = lbValidateSharepointSiteUrl(rawUrl);
  const storedUrl = checkedUrl.valid ? checkedUrl.url : String(rawUrl || "").trim();
  labBuilder.sharepointSiteName = name;
  labBuilder.sharepointSiteUrl = storedUrl;
  const snapshot = {
    products: lbSelectedProductList().map((p) => p.id),
    industry: labBuilder.industry || null,
    roles: [...labBuilder.selectedRoles],
    level: labBuilder.level,
    harness: lbHasHarnessProduct() ? labBuilder.harness : null,
    harnessMode: lbHasHarnessProduct() ? labBuilder.harnessMode : "single",
    harnesses: [...labBuilder.harnessOrder],
    features: labBuilder.rec ? [...labBuilder.rec.selectedIds] : [...(labBuilder.picked || [])],
    excluded: [...labBuilder.excluded],
    excludedSubtopics: lbExcludedSubtopicList(),
    moduleOrder: [...labBuilder.moduleOrder],
    includeKnowledgeCheck: Boolean(labBuilder.includeKnowledgeCheck),
    sharepointSiteName: name,
    sharepointSiteUrl: storedUrl,
  };
  try {
    if (typeof localStorage !== "undefined" && typeof localStorage?.setItem === "function") {
      if (name || storedUrl) {
        localStorage.setItem(
          LB_SHAREPOINT_STORAGE_KEY,
          JSON.stringify({ sharepointSiteName: name, sharepointSiteUrl: storedUrl })
        );
      } else if (typeof localStorage?.removeItem === "function") {
        localStorage.removeItem(LB_SHAREPOINT_STORAGE_KEY);
      }
    }
  } catch {
    // Ignore storage quota or privacy-mode errors.
  }
  return snapshot;
}

function lbRestoreSavedSharepointSite() {
  try {
    if (typeof localStorage === "undefined" || typeof localStorage?.getItem !== "function") return;
    const raw = localStorage.getItem(LB_SHAREPOINT_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;
    const savedName = lbNormalizeSharepointSiteName(parsed.sharepointSiteName || "");
    const checkedUrl = lbValidateSharepointSiteUrl(parsed.sharepointSiteUrl || "");
    const savedUrl = checkedUrl.valid ? checkedUrl.url : "";
    if (!labBuilder.sharepointSiteName && savedName) {
      lbSetFormValue("lb-sharepoint-site-name", savedName);
    }
    if (!labBuilder.sharepointSiteUrl && savedUrl) {
      lbSetFormValue("lb-sharepoint-site-url", savedUrl);
    }
  } catch {
    // Ignore malformed storage data.
  }
}

function lbSyncSharepointSiteUi() {
  const state = lbResolveSharepointSiteState();
  const card = document.getElementById("lb-sharepoint-site-card");
  if (card) card.hidden = !state.requiresSharepointSite;

  const previewEl = document.getElementById("lb-sharepoint-site-preview");
  const previewLink = document.getElementById("lb-sharepoint-site-preview-link");
  if (previewEl && previewLink) {
    if (state.requiresSharepointSite && state.validUrl && state.url) {
      previewLink.href = state.url;
      previewLink.textContent = state.label || state.url;
      previewEl.hidden = false;
    } else {
      previewEl.hidden = true;
    }
  }

  const errEl = document.getElementById("lb-sharepoint-site-error");
  if (errEl && (!state.requiresSharepointSite || (state.validUrl && errEl.textContent))) {
    errEl.textContent = "";
    state.urlEl?.removeAttribute?.("aria-invalid");
  }

  // The one calm hint under the field goes away once a site is entered.
  const hintEl = document.getElementById("lb-sharepoint-site-hint");
  if (hintEl) hintEl.hidden = state.configured;
}

/**
 * The SharePoint site is optional: a blank site builds with placeholder instructions and never blocks a build.
 * Only an address that was typed and cannot be used stops the build, so it is never sent by mistake.
 */
function lbValidateSharepointSiteForBuild() {
  const state = lbResolveSharepointSiteState();
  if (!state.requiresSharepointSite) {
    lbSyncSharepointSiteUi();
    return true;
  }
  const card = document.getElementById("lb-sharepoint-site-card");
  const errEl = document.getElementById("lb-sharepoint-site-error");
  if (!state.validUrl) {
    if (labBuilder.step !== LB_STEP.review) lbGoToStep(LB_STEP.review);
    if (card) card.hidden = false;
    if (errEl) errEl.textContent = state.urlError || "Enter a valid https:// SharePoint site URL, or clear the field to use a placeholder.";
    state.urlEl?.setAttribute?.("aria-invalid", "true");
    card?.scrollIntoView?.({ behavior: "smooth", block: "center" });
    state.urlEl?.focus?.();
    return false;
  }
  if (errEl) errEl.textContent = "";
  state.urlEl?.removeAttribute?.("aria-invalid");
  if (state.url && state.urlEl && state.urlEl.value !== state.url) state.urlEl.value = state.url;
  lbSaveSelections();
  lbSyncSharepointSiteUi();
  return true;
}

function lbBindSharepointSiteControls() {
  if (labBuilder.sharepointPromptBound) return;
  labBuilder.sharepointPromptBound = true;
  lbRestoreSavedSharepointSite();

  const nameEl = document.getElementById("lb-sharepoint-site-name");
  const urlEl = document.getElementById("lb-sharepoint-site-url");

  nameEl?.addEventListener("input", (event) => {
    labBuilder.sharepointSiteName = lbNormalizeSharepointSiteName(event?.target?.value ?? nameEl.value);
    lbSaveSelections();
    lbSyncSharepointSiteUi();
    lbRenderSummary();
  });

  urlEl?.addEventListener("input", (event) => {
    const raw = String(event?.target?.value ?? urlEl.value ?? "");
    const checked = lbValidateSharepointSiteUrl(raw);
    labBuilder.sharepointSiteUrl = checked.valid ? checked.url : raw.trim();
    const errEl = document.getElementById("lb-sharepoint-site-error");
    if (checked.valid && errEl) {
      errEl.textContent = "";
      urlEl.removeAttribute?.("aria-invalid");
    }
    lbSaveSelections();
    lbSyncSharepointSiteUi();
    lbRenderSummary();
  });

  const handleUrlCommit = () => {
    const raw = String(urlEl.value || "").trim();
    if (!raw) {
      labBuilder.sharepointSiteUrl = "";
      const errEl = document.getElementById("lb-sharepoint-site-error");
      if (errEl) errEl.textContent = "";
      urlEl.removeAttribute?.("aria-invalid");
      lbSaveSelections();
      lbSyncSharepointSiteUi();
      lbRenderSummary();
      return;
    }
    const checked = lbValidateSharepointSiteUrl(raw);
    const errEl = document.getElementById("lb-sharepoint-site-error");
    if (!checked.valid) {
      labBuilder.sharepointSiteUrl = raw;
      if (errEl) errEl.textContent = checked.error;
      urlEl.setAttribute?.("aria-invalid", "true");
    } else {
      labBuilder.sharepointSiteUrl = checked.url;
      if (urlEl.value !== checked.url) urlEl.value = checked.url;
      if (errEl) errEl.textContent = "";
      urlEl.removeAttribute?.("aria-invalid");
    }
    lbSaveSelections();
    lbSyncSharepointSiteUi();
    lbRenderSummary();
    if (labBuilder.step === LB_STEP.review && checked.valid) lbPreview();
  };
  urlEl?.addEventListener("change", handleUrlCommit);
  urlEl?.addEventListener("blur", handleUrlCommit);

  nameEl?.addEventListener("change", () => {
    lbSaveSelections();
    lbSyncSharepointSiteUi();
    lbRenderSummary();
    if (labBuilder.step === LB_STEP.review) lbPreview();
  });

  lbSyncSharepointSiteUi();
}

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

// ── "Both, one after another": two harnesses in one lab ─────────────────────
const LB_BOTH = "both";
const LB_HARNESS_SHORT = {
  standard: "Standard (Classic)",
  "microsoft-copilot": "Microsoft Copilot",
  "customer-conversation": "Customer Conversation",
};

/** "Standard (Classic)": the short form used in the choice, the order line, and the topic rows. */
function lbHarnessShort(id) {
  return LB_HARNESS_SHORT[id] || lbHarnessName(id).replace(/\s+harness$/i, "");
}

/** True while the product that owns both harnesses is chosen, so "Both, one after another" can be offered. */
function lbBothAvailable() {
  if (!lbHasHarnessProduct()) return false;
  const order = labBuilder.harnessOrder;
  return (
    Array.isArray(order) &&
    order.length === 2 &&
    order.every((id) => labBuilder.harnesses.some((h) => h.id === id && labBuilder.selectedProducts.has(h.product || LB_DEFAULT_PRODUCT)))
  );
}

/** True when the lab covers two harnesses one after another. */
function lbIsBoth() {
  return labBuilder.harnessMode === LB_BOTH && lbBothAvailable();
}

/** The harness choice in words: "Standard harness", or "Both: Standard (Classic), then Microsoft Copilot". */
function lbHarnessChoiceName() {
  return lbIsBoth() ? `Both: ${labBuilder.harnessOrder.map(lbHarnessShort).join(", then ")}` : lbHarnessName(labBuilder.harness);
}

/** Which harness a topic row is for, in a lab that covers both: its own, or "Either harness" when it is tagged for both. */
function lbTopicHarnessTag(topic) {
  if (!lbIsBoth()) return "";
  const tags = (topic.harnesses || []).filter((id) => labBuilder.harnessOrder.includes(id));
  if (tags.length > 1) return "Either harness";
  return tags.length === 1 ? lbHarnessShort(tags[0]) : "";
}

/** The products picked in the first step, in catalog order. */
function lbSelectedProductList() {
  if (!labBuilder.selectedProducts.size) return [];
  const catalogProducts = labBuilder.products.filter((p) => p && typeof p === "object" && p.id);
  if (catalogProducts.length) {
    return catalogProducts.filter((p) => labBuilder.selectedProducts.has(p.id));
  }
  return [...labBuilder.selectedProducts].map((id) =>
    id === LB_DEFAULT_PRODUCT
      ? { id, name: "Microsoft Copilot Studio", shortName: "Copilot Studio", hasHarnesses: true }
      : { id, name: id, shortName: id, hasHarnesses: false }
  );
}

/** A harness only exists for a product that has harnesses; the harness step and its answers apply only then. */
function lbHasHarnessProduct() {
  return lbSelectedProductList().some((p) => p.hasHarnesses);
}

/** The steps the person walks through, in order. The harness choice lives inside Tailor it, so every step always applies. */
function lbVisibleStepIds() {
  return LB_STEPS.map((s) => s.id);
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
  const names = lbSelectedProductList().map((p) => p.shortName || p.name);
  return names.length ? lbJoinNames(names) : "No products selected";
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
  if (lbHasHarnessProduct()) {
    if (lbIsBoth()) {
      answers.harnessMode = LB_BOTH;
      answers.harnesses = [...labBuilder.harnessOrder];
    } else {
      answers.harness = labBuilder.harness;
    }
  }
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
  const token = Symbol("refresh");
  labBuilder.refreshToken = token;
  if (!lbSelectedProductList().length) {
    labBuilder.pendingUncheckIds = [];
    labBuilder.rec = null;
    lbRenderSummary();
    lbSyncReviewControls();
    if (labBuilder.step === LB_STEP.topics) lbRenderTopics();
    return;
  }
  const extra = { excluded: [...labBuilder.excluded] };
  const leftOut = lbExcludedSubtopicList();
  if (leftOut.length) extra.excludedSubtopics = leftOut;
  if (labBuilder.picked) extra.selected = [...labBuilder.picked];
  try {
    const rec = await lbRecommend(extra);
    if (labBuilder.refreshToken !== token) return;
    labBuilder.rec = rec;
    // Arriving on Topics (or answering while there) with nothing chosen yet: start from the suggestion.
    if (labBuilder.step >= LB_STEP.topics && lbNeedsSuggestion()) {
      lbPickSuggested();
      return lbRefresh();
    }
    const activeIds = new Set([
      ...(rec?.selectedIds || []),
      ...(rec?.prerequisites?.selectedIds || []),
    ]);
    for (const id of [...labBuilder.step7Removed.keys()]) {
      if (activeIds.has(id)) labBuilder.step7Removed.delete(id);
    }
    const uncheckedIds = Array.isArray(labBuilder.pendingUncheckIds) ? labBuilder.pendingUncheckIds : [];
    labBuilder.pendingUncheckIds = [];
    if (uncheckedIds.length && rec) {
      const allTopics = [
        ...(rec.concepts || []).flatMap((c) => c.topics),
        ...(rec.levelUnknown?.topics || []),
      ];
      const keptPrereqs = uncheckedIds
        .map((uid) => allTopics.find((t) => t.id === uid && t.selected && t.required))
        .filter(Boolean);
      if (keptPrereqs.length) {
        const notices = keptPrereqs.map((topic) => {
          const reqReason = (topic.reasons || []).find((r) => /^Required by\s+/i.test(r));
          const dependents = reqReason
            ? reqReason.replace(/^Required by\s+/i, "").replace(/\.$/, "")
            : "another selected topic";
          return `"${topic.name}" is required by ${dependents}. Uncheck ${dependents} first to remove it, or uncheck "${topic.name}" again to exclude it and assume learners already completed it.`;
        });
        labBuilder.prereqNotice = notices.join(" ");
        toast(labBuilder.prereqNotice, "info");
      }
    }
  } catch (err) {
    if (labBuilder.refreshToken !== token) return;
    // A saved lab can name a sub-topic Microsoft Learn no longer lists. Drop what the server says is unknown and ask again.
    const stale = /Unknown sub-topic id\(s\): ([^.]*)\./.exec(String(err.message));
    if (stale) {
      let removed = false;
      for (const id of stale[1].split(",").map((part) => part.trim())) removed = labBuilder.excludedSubtopics.delete(id) || removed;
      if (removed) return lbRefresh();
    }
    labBuilder.pendingUncheckIds = [];
    labBuilder.rec = null;
    toast(`Could not update the topics: ${err.message}`, "error");
  }
  lbRenderSummary();
  lbSyncReviewControls();
  if (labBuilder.step === LB_STEP.topics) lbRenderTopics();
}

/** An answer in the first steps changed: topic choices start over from the new recommendation. */
function lbAnswersChanged() {
  const hadOwnPicks =
    (Boolean(labBuilder.picked) && !labBuilder.pickedAuto) ||
    labBuilder.excluded.size > 0 ||
    labBuilder.excludedSubtopics.size > 0 ||
    labBuilder.step7Removed.size > 0;
  lbInvalidateSharepointPreview();
  labBuilder.picked = null;
  labBuilder.pickedAuto = false;
  labBuilder.excluded.clear();
  labBuilder.excludedSubtopics.clear();
  labBuilder.step7Removed.clear();
  labBuilder.previewModules = [];
  labBuilder.chosenSteps.delete("topics");
  labBuilder.prereqNotice = null;
  labBuilder.pendingUncheckIds = [];
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
 * Level (on Tailor it) is the single source of truth for level. Changing it drops the learner's own
 * topic picks (they belonged to the old level), says exactly what was removed, and keeps
 * them so one button restores them.
 */
function lbLevelChanged(previous) {
  const hadOwnPicks =
    (Boolean(labBuilder.picked) && !labBuilder.pickedAuto) ||
    labBuilder.excluded.size > 0 ||
    labBuilder.excludedSubtopics.size > 0 ||
    labBuilder.step7Removed.size > 0;
  const removed = hadOwnPicks ? lbSelectedNames(labBuilder.rec) : [];
  labBuilder.levelNotice = hadOwnPicks
    ? {
        from: previous,
        to: labBuilder.level,
        removed,
        stash: {
          picked: labBuilder.picked ? new Set(labBuilder.picked) : null,
          excluded: new Set(labBuilder.excluded),
          excludedSubtopics: new Set(labBuilder.excludedSubtopics),
          step7Removed: new Map(labBuilder.step7Removed),
        },
      }
    : null;
  labBuilder.picked = null;
  labBuilder.pickedAuto = false;
  labBuilder.excluded.clear();
  labBuilder.excludedSubtopics.clear();
  labBuilder.step7Removed.clear();
  labBuilder.previewModules = [];
  labBuilder.chosenSteps.delete("topics");
  labBuilder.prereqNotice = null;
  labBuilder.pendingUncheckIds = [];
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
  labBuilder.chosenSteps.add("tailor");
  labBuilder.picked = notice.stash.picked;
  labBuilder.pickedAuto = false;
  labBuilder.excluded = notice.stash.excluded;
  labBuilder.excludedSubtopics = notice.stash.excludedSubtopics || new Set();
  labBuilder.step7Removed = new Map(notice.stash.step7Removed || []);
  if (labBuilder.picked || labBuilder.excluded.size) labBuilder.chosenSteps.add("topics");
  labBuilder.levelNotice = null;
  labBuilder.rec = null;
  lbRenderLevels();
  lbRenderHarnesses();
  lbRenderLearnBar();
  lbRenderLevelNotice(`Restored your ${lbLevelName(notice.from)} topic choices.`);
  lbRenderSummary();
  lbRefresh();
}

/** The visible, announced notice shown on the Tailor it and Topics steps. */
function lbRenderLevelNotice(restoredMessage) {
  const notice = labBuilder.levelNotice;
  for (const id of ["lb-level-notice-2", "lb-level-notice-3"]) {
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
  if (typeof lbGenBind === "function") lbGenBind();
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
    if (typeof lbDraftsInit === "function") lbDraftsInit();
  } catch (err) {
    const target = document.getElementById("lb-product-options");
    if (target) {
      target.innerHTML = `<div class="scenario-empty" role="alert">Could not load the feature catalog: ${escapeHtml(err.message)}</div>`;
    }
  }
}

// ── Step 1: product ─────────────────────────────────────────────────────────
/** Non-zero topic counts per catalog level for a product: [{ level: 100, count: 20 }, ...]. */
function lbProductLevelEntries(product) {
  const counts = {};
  for (const feature of lbFeatureList()) {
    if ((feature.product || LB_DEFAULT_PRODUCT) === product.id) {
      counts[feature.level] = (counts[feature.level] || 0) + 1;
    }
  }
  return labBuilder.levels
    .filter((l) => counts[l.level])
    .map((l) => ({ level: l.level, count: counts[l.level] }));
}

/** What a product offers at each level, in words: "Level 100: 2, Level 200: 3". */
function lbProductLevelCounts(product) {
  const entries = lbProductLevelEntries(product);
  return entries.length ? entries.map((e) => `Level ${e.level}: ${e.count}`).join(", ") : "No topics yet";
}

/** Scannable two-tier stat layout for a product card: headline total row + per-level breakdown grid. */
function lbRenderProductStats(product) {
  const entries = lbProductLevelEntries(product);
  const derivedTotal = entries.reduce((sum, e) => sum + e.count, 0);
  const rawTotal = Number(product?.featureCount);
  const total = Number.isFinite(rawTotal) ? rawTotal : derivedTotal;
  if (total <= 0 && !entries.length) {
    return `<div class="lb-product-stats"><div class="lb-stat-total-row"><span class="lb-stat-chip lb-stat-chip-empty">No topics yet<span class="sr-only">.</span></span></div></div>`;
  }
  const totalRow = `<div class="lb-stat-total-row"><span class="lb-stat-chip lb-stat-chip-total"><strong>${escapeHtml(total)}</strong> total ${total === 1 ? "topic" : "topics"}<span class="sr-only">.</span></span></div>`;
  if (!entries.length) {
    return `<div class="lb-product-stats">${totalRow}</div>`;
  }
  const cols = Math.min(entries.length, 3);
  const levelTiles = entries.map((entry, idx) => {
    const punct = idx === entries.length - 1 ? "." : ",";
    return `<span class="lb-stat-chip lb-stat-chip-level"><span class="lb-stat-level-label">Level ${escapeHtml(entry.level)}<span class="sr-only">:</span></span> <strong>${escapeHtml(entry.count)}</strong><span class="sr-only">${punct}</span></span>`;
  });
  return `<div class="lb-product-stats">${totalRow} <div class="lb-stat-level-grid lb-stat-level-grid-${cols}">${levelTiles.join(" ")}</div></div>`;
}

/** A product added from Learn has no reviewed topics: say how many topics Microsoft Learn gave it, or how to get them. */
function lbRenderCustomProductStats(product) {
  const info = labBuilder.learn?.products?.[product.id];
  const text = info?.newTopics
    ? `<strong>${escapeHtml(info.newTopics)}</strong> ${info.newTopics === 1 ? "topic" : "topics"} from Microsoft Learn, not reviewed`
    : "No Microsoft Learn topics read yet. Choose Refresh from Microsoft Learn in the Topics step.";
  return `<div class="lb-product-stats"><div class="lb-stat-total-row"><span class="lb-stat-chip lb-stat-chip-total">${text}<span class="sr-only">.</span></span></div></div>`;
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
      <label class="scenario-role${checked ? " checked" : ""}">
        <input type="checkbox" name="lb-product" value="${escapeHtml(p.id)}" autocomplete="off" ${checked ? "checked" : ""}>
        <span class="lb-card-body">
          <span class="lb-card-head">
            <span class="lb-card-title">${escapeHtml(p.name)}<span class="sr-only">.</span></span>
            ${p.hasHarnesses ? '<span class="lb-badge lb-badge-harness" title="This product comes in more than one agent experience, called a harness. You choose one on the next step.">Choose an agent experience<span class="sr-only">.</span></span>' : ""}
            ${p.custom ? '<span class="lb-badge lb-badge-new">Added by you<span class="sr-only">.</span></span>' : ""}
          </span>
          ${p.summary ? `<div class="scenario-card-desc">${escapeHtml(p.summary)}</div>` : ""}
          <div class="lb-card-footer">
            ${p.custom ? lbRenderCustomProductStats(p) : lbRenderProductStats(p)}
            ${
              hub
                ? `<div class="lb-card-learn"><a href="${escapeHtml(hub)}" target="_blank" rel="noopener noreferrer">Microsoft Learn for ${escapeHtml(p.shortName)} (opens in a new tab)</a></div>`
                : ""
            }
          </div>
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
  if (checked) {
    labBuilder.selectedProducts.add(id);
    labBuilder.chosenSteps.add("product");
  } else {
    labBuilder.selectedProducts.delete(id);
    if (!labBuilder.selectedProducts.size) {
      labBuilder.chosenSteps.clear();
      labBuilder.furthest = LB_STEP.product;
    }
  }
  lbProductsChanged();
}

/** The product choice changed: the harness choice may appear or disappear, and every list below restarts from the new products. */
function lbProductsChanged() {
  lbInvalidateSharepointPreview();
  lbRenderProducts();
  lbRenderHarnesses();
  lbRenderLevels();
  lbRenderLearnBar();
  lbRenderStepper();
  lbAnswersChanged();
}

// ── Step 2: tailor it (industry) ────────────────────────────────────────────
function lbRenderIndustries() {
  const select = document.getElementById("lb-industry-select");
  if (!select) return;
  const options = [{ id: "", name: "Cross-industry" }, ...labBuilder.industries];
  select.innerHTML = options.map((i) => `<option value="${escapeHtml(i.id)}">${escapeHtml(i.name)}</option>`).join("");
  select.value = labBuilder.industry || "";
  const hint = document.getElementById("lb-industry-hint");
  if (hint) {
    const industry = labBuilder.industries.find((i) => i.id === labBuilder.industry);
    hint.textContent = industry
      ? `${industry.name} is selected. The scenario, sample questions, and vocabulary follow it.`
      : "Cross-industry is selected. Not sure? Keep it.";
  }
}

function lbSelectIndustry(id) {
  const next = id || null;
  labBuilder.chosenSteps.add("tailor");
  if (next === labBuilder.industry) {
    lbRenderIndustries();
    lbRenderSummary();
    return;
  }
  labBuilder.industry = next;
  lbRenderIndustries();
  lbAnswersChanged();
}

// ── Step 2: tailor it (departments) ─────────────────────────────────────────
function lbRenderRoles() {
  const el = document.getElementById("lb-role-list");
  if (!el) return;
  const active = el.contains?.(document.activeElement) ? document.activeElement : null;
  const focusKey = active ? (active.id === "lb-role-all" ? "" : active.value ?? null) : null;
  const none = labBuilder.selectedRoles.size === 0;
  el.innerHTML = [
    `<label class="lb-chip lb-chip-all"><input type="checkbox" id="lb-role-all" autocomplete="off" ${none ? "checked" : ""}><span>All departments</span></label>`,
    ...labBuilder.roles.map((r) => {
      const checked = labBuilder.selectedRoles.has(r.id);
      return `<label class="lb-chip"><input type="checkbox" name="lb-role" value="${escapeHtml(r.id)}" autocomplete="off" ${checked ? "checked" : ""}><span>${escapeHtml(r.name)}</span></label>`;
    }),
  ].join("");
  el.querySelector("#lb-role-all")?.addEventListener("change", (event) => {
    if (event.target.checked) lbClearRoles();
    // With no department chosen, All departments is the answer: it cannot be unchecked on its own.
    else lbRenderRoles();
  });
  el.querySelectorAll("input[name=lb-role]").forEach((input) => {
    input.addEventListener("change", () => lbToggleRole(input.value, input.checked));
  });
  if (focusKey !== null) {
    const target = focusKey === "" ? el.querySelector("#lb-role-all") : el.querySelector(`input[value="${CSS.escape(focusKey)}"]`);
    target?.focus?.();
  }
  const hint = document.getElementById("lb-role-hint");
  if (hint) {
    const names = labBuilder.roles.filter((r) => labBuilder.selectedRoles.has(r.id)).map((r) => r.name);
    hint.textContent = names.length
      ? `${lbJoinNames(names)} ${names.length === 1 ? "is" : "are"} selected. Their topics and design guidance are added. Choose All departments to go back to a general lab.`
      : "All departments is selected. Not sure? Keep it. Choose departments to add the topics their teams use most.";
  }
}

function lbToggleRole(id, checked) {
  if (checked) labBuilder.selectedRoles.add(id);
  else labBuilder.selectedRoles.delete(id);
  labBuilder.chosenSteps.add("tailor");
  lbRenderRoles();
  lbAnswersChanged();
}

function lbClearRoles() {
  labBuilder.chosenSteps.add("tailor");
  if (!labBuilder.selectedRoles.size) {
    lbRenderRoles();
    return;
  }
  labBuilder.selectedRoles.clear();
  lbRenderRoles();
  lbAnswersChanged();
}

// ── Step 2: tailor it (level) ───────────────────────────────────────────────
async function lbRenderLevels() {
  const el = document.getElementById("lb-level-options");
  if (!el) return;
  const token = Symbol("levels");
  labBuilder.levelsToken = token;
  const counts = {};
  const gaps = {};
  if (lbSelectedProductList().length) {
    try {
      const recs = await Promise.all(labBuilder.levels.map((l) => lbRecommend({ level: l.level })));
      if (labBuilder.levelsToken !== token) return;
      labBuilder.levels.forEach((l, i) => {
        counts[l.level] = recs[i].filter?.shown ?? 0;
        // A selected product with nothing at this level is named, so a short list is never a mystery.
        gaps[l.level] = (recs[i].products || []).filter((p) => !p.atLevel).map((p) => p.shortName);
      });
    } catch {
      /* the counts are a nicety; the choice still works without them */
    }
  }
  labBuilder.levelGaps = gaps;
  const focused = el.contains(document.activeElement) ? document.activeElement.value : null;
  el.innerHTML = labBuilder.levels
    .map((l) => {
      const checked = labBuilder.level === l.level;
      const count = counts[l.level];
      const countText = count === undefined ? "" : count > 0 ? `${count} ${count === 1 ? "topic" : "topics"}` : "No topics yet";
      const detail = [l.label, countText].filter(Boolean).join(" · ");
      return `
      <label class="lb-seg-option">
        <input type="radio" name="lb-level" value="${l.level}" autocomplete="off" ${checked ? "checked" : ""}>
        <span class="lb-seg-title">Level ${l.level}</span>
        <span class="lb-seg-count">${escapeHtml(detail)}</span>
      </label>`;
    })
    .join("");
  el.querySelectorAll("input[type=radio]").forEach((input) => {
    input.addEventListener("change", () => lbSelectLevel(Number(input.value)));
  });
  if (focused) el.querySelector(`input[value="${focused}"]`)?.focus();
  lbRenderLevelHint();
  lbRenderLevelNotice();
}

/** One line under the level choice: what is selected, and which chosen product has nothing at it. */
function lbRenderLevelHint() {
  const hint = document.getElementById("lb-level-hint");
  if (!hint) return;
  const gaps = labBuilder.levelGaps?.[labBuilder.level] || [];
  const gap = gaps.length ? ` No ${lbLevelName(labBuilder.level)} topics yet for ${lbJoinNames(gaps)}.` : "";
  hint.textContent = `${lbLevelName(labBuilder.level)} is selected. The lab lists and builds only this level, and a topic that builds on a lower level gets a short refresher you can turn off.${gap}`;
}

function lbSelectLevel(level) {
  const nextLevel = Number(level);
  const previous = labBuilder.level;
  labBuilder.chosenSteps.add("tailor");
  labBuilder.level = nextLevel;
  lbRenderLevelHint();
  if (labBuilder.level !== previous) lbLevelChanged(previous);
  else lbRenderSummary();
}

// ── Step 2: tailor it (harness, only for products that have harnesses) ─────
const lbBoundSwapButtons = new WeakSet();
function lbRenderHarnesses() {
  const row = document.getElementById("lb-harness-row");
  const hasHarness = lbHasHarnessProduct();
  if (row) row.hidden = !hasHarness;
  const el = document.getElementById("lb-harness-options");
  if (!el) return;
  if (!hasHarness) {
    el.innerHTML = "";
    lbRenderDifferenceOptions();
    return;
  }
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
      const checked = labBuilder.harness === h.id && !unavailable && !lbIsBoth();
      const meta = unavailable
        ? "No lab topics yet, so it cannot be selected"
        : shown
          ? `${shown} ${lbLevelName(level)} ${shown === 1 ? "topic" : "topics"}`
          : `No ${lbLevelName(level)} topics yet`;
      const description = String(h.description || "");
      const lead = description.split(/(?<=\.)\s+/)[0] || "";
      const preview = /\bPreview\b\./.test(description) ? ' <span class="lb-badge lb-badge-warn">Preview</span>' : "";
      return `
      <label class="lb-radio-option${unavailable ? " lb-unavailable" : ""}">
        <input type="radio" name="lb-harness" value="${escapeHtml(h.id)}" autocomplete="off" ${checked ? "checked" : ""} ${unavailable ? "disabled" : ""}>
        <span class="lb-radio-name">${escapeHtml(h.name)}${preview} <span class="lb-seg-count">· ${escapeHtml(meta)}</span></span>
        <span class="lb-radio-desc">${escapeHtml(lead)}</span>
      </label>`;
    })
    .join("") + lbBothOptionHtml(features, level);
  el.querySelectorAll("input[type=radio]").forEach((input) => {
    input.addEventListener("change", () => lbSelectHarness(input.value));
  });
  const swap = document.getElementById("lb-harness-swap");
  if (swap && !lbBoundSwapButtons.has(swap)) {
    lbBoundSwapButtons.add(swap);
    swap.addEventListener("click", lbSwapHarnessOrder);
  }
  lbRenderHarnessHint();
  lbRenderHarnessOrder();
  lbRenderDifferenceOptions();
}

/** The "Both, one after another" choice, next to the single-harness choices. */
function lbBothOptionHtml(features, level) {
  if (!lbBothAvailable()) return "";
  const order = labBuilder.harnessOrder;
  const either = features.filter((f) => (f.harness || []).some((id) => order.includes(id)));
  const shown = either.filter((f) => f.level === level).length + order.reduce((sum, id) => sum + lbLearnNewCount(id, level), 0);
  const meta = shown ? `${shown} ${lbLevelName(level)} ${shown === 1 ? "topic" : "topics"}` : `No ${lbLevelName(level)} topics yet`;
  const checked = lbIsBoth();
  return `
      <label class="lb-radio-option lb-radio-both">
        <input type="radio" name="lb-harness" value="${LB_BOTH}" autocomplete="off" ${checked ? "checked" : ""}>
        <span class="lb-radio-name">Both, one after another <span class="lb-seg-count">· ${escapeHtml(meta)}</span></span>
        <span class="lb-radio-desc">Covers the ${escapeHtml(lbHarnessShort(order[0]))} harness first, then the ${escapeHtml(lbHarnessShort(order[1]))} harness. Shared topics appear once.</span>
      </label>`;
}

/** The order line and its Swap button, shown only while "Both" is chosen. */
function lbRenderHarnessOrder() {
  const box = document.getElementById("lb-harness-order");
  const text = document.getElementById("lb-harness-order-text");
  const swap = document.getElementById("lb-harness-swap");
  if (!box) return;
  const both = lbIsBoth();
  box.hidden = !both;
  if (!both) return;
  const [first, second] = labBuilder.harnessOrder;
  if (text) text.textContent = `Order: ${lbHarnessShort(first)} first, then ${lbHarnessShort(second)}.`;
  if (swap) swap.setAttribute("aria-label", `Swap the order: teach ${lbHarnessShort(second)} first, then ${lbHarnessShort(first)}`);
}

/** Teach the other harness first. */
function lbSwapHarnessOrder() {
  labBuilder.harnessOrder = [...labBuilder.harnessOrder].reverse();
  labBuilder.chosenSteps.add("tailor");
  lbRenderHarnessHint();
  lbRenderHarnessOrder();
  lbAnswersChanged();
}

function lbRenderHarnessHint() {
  const hint = document.getElementById("lb-harness-hint");
  if (!hint) return;
  if (lbIsBoth()) {
    hint.textContent = `Both harnesses are selected, ${lbHarnessShort(labBuilder.harnessOrder[0])} first, then ${lbHarnessShort(labBuilder.harnessOrder[1])}. A topic that is the same in both is covered once.`;
    return;
  }
  hint.textContent = labBuilder.harness === "standard"
    ? `${lbHarnessName(labBuilder.harness)} is selected. Not sure? Keep it.`
    : `${lbHarnessName(labBuilder.harness)} is selected.`;
}

function lbSelectHarness(id) {
  const previousMode = labBuilder.harnessMode;
  const previous = labBuilder.harness;
  labBuilder.chosenSteps.add("tailor");
  if (id === LB_BOTH) {
    labBuilder.harnessMode = LB_BOTH;
  } else {
    labBuilder.harnessMode = "single";
    labBuilder.harness = id;
  }
  if (labBuilder.harness !== previous || labBuilder.harnessMode !== previousMode) {
    labBuilder.differencesFor = null;
    lbRenderHarnessHint();
    lbRenderHarnessOrder();
    lbRenderDifferenceOptions();
    lbRenderLearnBar();
    lbAnswersChanged();
  } else {
    lbRenderSummary();
  }
}

/** The other harnesses whose differences get expandable notes. */
function lbDifferencesFor() {
  return labBuilder.differencesFor || new Set(labBuilder.differenceDefaults[labBuilder.harness] || []);
}

function lbRenderDifferenceOptions() {
  const el = document.getElementById("lb-differences-options");
  if (!el) return;
  // A lab that covers both harnesses teaches the other one itself, so the comparison notes are not offered.
  const more = typeof el.closest === "function" ? el.closest("details") : null;
  if (more) more.hidden = lbIsBoth();
  if (!lbHasHarnessProduct() || lbIsBoth()) {
    el.innerHTML = "";
    return;
  }
  const chosen = lbDifferencesFor();
  el.innerHTML = labBuilder.harnesses
    .filter((h) => h.id !== labBuilder.harness && (h.product || LB_DEFAULT_PRODUCT) === (lbHarnessOwner(labBuilder.harness) || LB_DEFAULT_PRODUCT))
    .map((h) => {
      const checked = chosen.has(h.id);
      return `
      <label class="lb-check-option">
        <input type="checkbox" name="lb-differences" value="${escapeHtml(h.id)}" autocomplete="off" ${checked ? "checked" : ""}>
        <span>Compare with <strong>${escapeHtml(h.name)}</strong></span>
      </label>`;
    })
    .join("");
  el.querySelectorAll("input[type=checkbox]").forEach((input) => {
    input.addEventListener("change", () => {
      const next = new Set(lbDifferencesFor());
      if (input.checked) next.add(input.value);
      else next.delete(input.value);
      labBuilder.differencesFor = next;
      labBuilder.chosenSteps.add("tailor");
      lbRenderSummary();
    });
  });
}

// ── Microsoft Learn topic list: freshness, refresh, and badges ──────────────
const LB_LEARN_TRACKING_PARAMS = new Set([
  "wt.mc_id",
  "ocid",
  "tabs",
  "pivots",
  "source",
  "ns-enrollment-type",
  "ns-enrollment-id",
]);

const LB_LEARN_TERM_CASE = new Map([
  ["ai", "AI"],
  ["mcp", "MCP"],
  ["mcps", "MCPs"],
  ["api", "API"],
  ["apis", "APIs"],
  ["sso", "SSO"],
  ["dlp", "DLP"],
  ["rbac", "RBAC"],
  ["alm", "ALM"],
  ["m365", "M365"],
  ["rest", "REST"],
  ["oauth", "OAuth"],
  ["http", "HTTP"],
  ["https", "HTTPS"],
  ["json", "JSON"],
  ["sql", "SQL"],
  ["url", "URL"],
  ["urls", "URLs"],
  ["ui", "UI"],
  ["ux", "UX"],
  ["cli", "CLI"],
  ["sdk", "SDK"],
  ["sdks", "SDKs"],
  ["ide", "IDE"],
  ["ides", "IDEs"],
  ["pr", "PR"],
  ["prs", "PRs"],
  ["gpt", "GPT"],
  ["nlu", "NLU"],
  ["faq", "FAQ"],
  ["faqs", "FAQs"],
  ["cua", "CUA"],
  ["iva", "IVA"],
  ["ivr", "IVR"],
  ["sap", "SAP"],
  ["fhir", "FHIR"],
  ["a2a", "A2A"],
  ["byom", "BYOM"],
  ["vnet", "VNet"],
  ["vnets", "VNets"],
  ["entra", "Entra"],
  ["id", "ID"],
  ["sharepoint", "SharePoint"],
  ["onedrive", "OneDrive"],
  ["onenote", "OneNote"],
  ["dataverse", "Dataverse"],
  ["powerfx", "Power Fx"],
  ["powershell", "PowerShell"],
  ["github", "GitHub"],
  ["openapi", "OpenAPI"],
  ["graphql", "GraphQL"],
  ["servicenow", "ServiceNow"],
  ["dynamics365", "Dynamics 365"],
  ["copilot", "Copilot"],
  ["microsoft", "Microsoft"],
  ["azure", "Azure"],
  ["foundry", "Foundry"],
  ["teams", "Teams"],
  ["vscode", "VS Code"],
  ["javascript", "JavaScript"],
  ["typescript", "TypeScript"],
  ["nodejs", "Node.js"],
  ["yaml", "YAML"],
  ["xml", "XML"],
  ["csv", "CSV"],
  ["html", "HTML"],
  ["css", "CSS"],
  ["pdf", "PDF"],
  ["docx", "DOCX"],
  ["pptx", "PPTX"],
  ["jwt", "JWT"],
  ["saml", "SAML"],
  ["oidc", "OIDC"],
  ["pii", "PII"],
  ["phi", "PHI"],
]);

const LB_MINOR_TITLE_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "by",
  "for",
  "from",
  "in",
  "into",
  "nor",
  "of",
  "on",
  "or",
  "per",
  "the",
  "to",
  "up",
  "via",
  "vs",
  "with",
]);

const LB_GENERIC_LEARN_SLUGS = new Set([
  "overview",
  "index",
  "quickstart",
  "get-started",
  "getting-started",
  "whats-new",
  "faq",
  "faqs",
  "introduction",
  "readme",
]);

const LB_STRUCTURAL_SEGMENTS = new Set([
  "concepts",
  "how-to",
  "quickstarts",
  "tutorials",
  "guidance",
  "reference",
  "includes",
]);

function lbParseLearnUrlParts(url) {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!trimmed.startsWith("https://learn.microsoft.com/")) return null;
  const match = /^https:\/\/learn\.microsoft\.com(\/[^\s<>"'`\\\u0000-\u001f]*)$/.exec(trimmed);
  if (!match) return null;
  const rawAfterHost = match[1];
  const hashIdx = rawAfterHost.indexOf("#");
  const withoutHash = hashIdx >= 0 ? rawAfterHost.slice(0, hashIdx) : rawAfterHost;
  const queryIdx = withoutHash.indexOf("?");
  const rawPath = queryIdx >= 0 ? withoutHash.slice(0, queryIdx) : withoutHash;
  const rawQuery = queryIdx >= 0 ? withoutHash.slice(queryIdx + 1) : "";

  const collapsedPath = rawPath.replace(/\/{2,}/g, "/");
  if (collapsedPath.split("/").some((seg) => seg === "..")) return null;
  const localeStripped = collapsedPath.replace(/^\/[a-z]{2}-[a-z]{2,4}(?=\/|$)/i, "") || "/";
  const canonicalPath = localeStripped.replace(/\/+$/, "");
  if (!canonicalPath || canonicalPath === "/") return null;
  const hadTrailingSlash = localeStripped.endsWith("/");

  const keptParams = [];
  if (rawQuery) {
    for (const part of rawQuery.split("&")) {
      if (!part) continue;
      const eqIdx = part.indexOf("=");
      const rawKey = eqIdx >= 0 ? part.slice(0, eqIdx) : part;
      const rawVal = eqIdx >= 0 ? part.slice(eqIdx + 1) : "";
      let decodedKey = rawKey;
      try {
        decodedKey = decodeURIComponent(rawKey.replace(/\+/g, " "));
      } catch {
        /* keep raw key */
      }
      const lowerKey = decodedKey.toLowerCase();
      if (lowerKey.startsWith("utm_") || LB_LEARN_TRACKING_PARAMS.has(lowerKey)) continue;
      keptParams.push([lowerKey, rawKey, rawVal]);
    }
  }
  keptParams.sort((a, b) => a[0].localeCompare(b[0]) || a[2].localeCompare(b[2]));
  const cleanQuery = keptParams
    .map(([, k, v]) => (v ? `${k}=${v}` : k))
    .join("&");
  const querySuffix = cleanQuery ? `?${cleanQuery}` : "";

  return {
    canonicalPath,
    canonicalUrl: `https://learn.microsoft.com${canonicalPath}${querySuffix}`,
    preservedUrl: `https://learn.microsoft.com${canonicalPath}${hadTrailingSlash ? "/" : ""}${querySuffix}`,
    dedupeKey: `https://learn.microsoft.com${canonicalPath.toLowerCase()}${querySuffix.toLowerCase()}`,
  };
}

function lbLearnUrl(url, options) {
  const parts = lbParseLearnUrlParts(url);
  if (!parts) return null;
  return options && options.stripTrailingSlash ? parts.canonicalUrl : parts.preservedUrl;
}

function lbLearnPathSegments(url) {
  const parts = lbParseLearnUrlParts(url);
  if (!parts) return [];
  return parts.canonicalPath
    .split("/")
    .filter(Boolean)
    .map((seg) => {
      try {
        return decodeURIComponent(seg);
      } catch {
        return seg;
      }
    });
}

function lbHumanizeLearnSegment(segment) {
  const cleaned = String(segment || "")
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[-_]+/g, " ")
    .trim();
  if (!cleaned) return "";
  const words = cleaned.split(/\s+/);
  return words
    .map((word, idx) => {
      const lower = word.toLowerCase();
      if (LB_LEARN_TERM_CASE.has(lower)) return LB_LEARN_TERM_CASE.get(lower);
      if (idx > 0 && idx < words.length - 1 && LB_MINOR_TITLE_WORDS.has(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

function lbLearnSlugTitle(url) {
  const segments = lbLearnPathSegments(url);
  if (!segments.length) return "Microsoft Learn Documentation";
  const leaf = segments[segments.length - 1];
  const leafClean = leaf.replace(/\.[a-z0-9]+$/i, "").toLowerCase();
  const leafTitle = lbHumanizeLearnSegment(leaf);
  if (!leafTitle) return "Microsoft Learn Documentation";
  if (LB_GENERIC_LEARN_SLUGS.has(leafClean) && segments.length >= 2) {
    let parentIdx = segments.length - 2;
    while (parentIdx > 0 && LB_STRUCTURAL_SEGMENTS.has(segments[parentIdx].toLowerCase())) {
      parentIdx -= 1;
    }
    const parentTitle = lbHumanizeLearnSegment(segments[parentIdx]);
    if (parentTitle && parentTitle.toLowerCase() !== leafTitle.toLowerCase()) {
      return `${parentTitle}: ${leafTitle}`;
    }
  }
  return leafTitle;
}

function lbCollectRawLearnCandidates(source) {
  if (!source || typeof source !== "object") return [];
  const raw = [];
  if (Array.isArray(source.learnLinks)) {
    for (const link of source.learnLinks) {
      if (link && typeof link === "object" && link.url) {
        raw.push({ url: link.url, title: link.title || "" });
      }
    }
  }
  const dyn = source.learn || source.learnTopic || null;
  const primaryDynUrl =
    typeof dyn?.url === "string"
      ? dyn.url
      : Array.isArray(dyn?.urls) && typeof dyn.urls[0] === "string"
      ? dyn.urls[0]
      : null;
  if (primaryDynUrl) {
    const primaryTitle = dyn?.title || (source.source === "learn" ? source.name : "") || "";
    raw.push({ url: primaryDynUrl, title: primaryTitle });
  }
  if (Array.isArray(dyn?.subtopics)) {
    for (const sub of dyn.subtopics) {
      if (sub && typeof sub === "object" && sub.url) {
        raw.push({ url: sub.url, title: sub.title || "" });
      }
    }
  }
  if (Array.isArray(dyn?.urls)) {
    for (const url of dyn.urls) {
      raw.push({ url, title: "" });
    }
  }
  if (Array.isArray(source.docUrls)) {
    for (const url of source.docUrls) {
      raw.push({ url, title: "" });
    }
  }
  if (typeof source.verifiedAgainst === "string" && source.verifiedAgainst) {
    raw.push({ url: source.verifiedAgainst, title: "" });
  }
  return raw;
}

function lbResolveLearnLinks(item) {
  if (!item || typeof item !== "object") return [];
  const rawCandidates = lbCollectRawLearnCandidates(item);
  if (!rawCandidates.some((c) => lbLearnUrl(c.url)) && item.id) {
    const recTopic = [
      ...(labBuilder.rec?.concepts || []).flatMap((c) => c.topics),
      ...(labBuilder.rec?.levelUnknown?.topics || []),
    ].find((t) => t.id === item.id);
    const recPrereq = (labBuilder.rec?.prerequisites?.topics || []).find((p) => p.id === item.id);
    const catFeature = lbFeatureList().find((f) => f.id === item.id);
    for (const fallback of [recTopic, recPrereq, catFeature]) {
      rawCandidates.push(...lbCollectRawLearnCandidates(fallback));
    }
  }

  const byKey = new Map();
  const order = [];
  for (const candidate of rawCandidates) {
    const parts = lbParseLearnUrlParts(candidate?.url);
    if (!parts) continue;
    const cleanUrl = parts.canonicalUrl;
    const key = parts.dedupeKey;
    const rawTitle = String(candidate?.title || "")
      .replace(/\s*[|—–-]\s*Microsoft Learn\s*$/i, "")
      .replace(/\s+/g, " ")
      .trim();
    const hasExplicitTitle = Boolean(rawTitle) && !/^https?:\/\//i.test(rawTitle);

    if (!byKey.has(key)) {
      byKey.set(key, { url: cleanUrl, explicitTitle: hasExplicitTitle ? rawTitle : "" });
      order.push(key);
    } else {
      const prev = byKey.get(key);
      if (!prev.url.includes("?view=") && cleanUrl.includes("?view=")) {
        prev.url = cleanUrl;
      }
      if (!prev.explicitTitle && hasExplicitTitle) {
        prev.explicitTitle = rawTitle;
      }
    }
  }

  const results = order.map((key) => {
    const entry = byKey.get(key);
    return {
      url: entry.url,
      title: entry.explicitTitle || lbLearnSlugTitle(entry.url),
    };
  });

  const groupsByTitle = new Map();
  results.forEach((entry, idx) => {
    const norm = entry.title.toLowerCase();
    if (!groupsByTitle.has(norm)) groupsByTitle.set(norm, []);
    groupsByTitle.get(norm).push(idx);
  });
  for (const indices of groupsByTitle.values()) {
    if (indices.length < 2) continue;
    const segLists = indices.map((idx) => lbLearnPathSegments(results[idx].url).slice(0, -1));
    for (let pos = 0; pos < indices.length; pos += 1) {
      const idx = indices[pos];
      const ownSegs = segLists[pos];
      let qualifier = "";
      for (let depth = ownSegs.length - 1; depth >= 0; depth -= 1) {
        const candidateSeg = ownSegs[depth];
        if (LB_STRUCTURAL_SEGMENTS.has(candidateSeg.toLowerCase())) continue;
        const differs = segLists.some(
          (otherSegs, otherPos) =>
            otherPos !== pos &&
            (otherSegs[otherSegs.length - (ownSegs.length - depth)] || "").toLowerCase() !==
              candidateSeg.toLowerCase()
        );
        if (differs) {
          qualifier = lbHumanizeLearnSegment(candidateSeg);
          break;
        }
      }
      if (!qualifier && ownSegs.length) {
        qualifier = ownSegs.map(lbHumanizeLearnSegment).filter(Boolean).join(" / ");
      }
      if (qualifier) {
        results[idx].title = `${results[idx].title} (${qualifier})`;
      }
    }
  }

  return results;
}

function lbRenderLearnLinks(item, options = {}) {
  // A topic's sub-topics show their own links, so the topic's own list leaves them out instead of repeating them.
  const hidden = new Set((options.hide || []).map((url) => lbParseLearnUrlParts(url)?.dedupeKey).filter(Boolean));
  const links = lbResolveLearnLinks(item).filter((link) => !hidden.has(lbParseLearnUrlParts(link.url)?.dedupeKey));
  if (!links.length) return "";
  const anchors = links
    .map(
      (link) =>
        `<a class="lb-learn-source" href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(link.title)} — Microsoft Learn (opens in a new tab)">${escapeHtml(link.title)}</a>`
    )
    .join('<span class="lb-learn-sep" aria-hidden="true">·</span>');
  return `<span class="lb-learn-links"><span class="lb-learn-links-label">Microsoft Learn:</span>${anchors}</span>`;
}

let lbGuardedCheckboxState = null;

function lbClearGuardedCheckboxSoon() {
  Promise.resolve().then(() => {
    lbGuardedCheckboxState = null;
  });
}

function lbShouldIgnoreGuardedChange(input) {
  if (!input || !lbGuardedCheckboxState) return false;
  if (lbGuardedCheckboxState.checkbox !== input) return false;
  input.checked = lbGuardedCheckboxState.checked;
  lbGuardedCheckboxState = null;
  return true;
}

function lbBindLearnLinkGuard(container) {
  if (!container || container._lbLearnGuardBound || typeof container.addEventListener !== "function") return;
  container._lbLearnGuardBound = true;
  container.addEventListener(
    "click",
    (event) => {
      if (lbGuardedCheckboxState && event.target === lbGuardedCheckboxState.checkbox) {
        lbGuardedCheckboxState.checkbox.checked = lbGuardedCheckboxState.checked;
        event.preventDefault?.();
        event.stopImmediatePropagation?.();
        event.stopPropagation?.();
        return;
      }
      const link = event.target?.closest?.("a.lb-learn-source");
      if (!link) return;
      const label = link.closest?.("label");
      const checkbox = label?.querySelector?.('input[type="checkbox"]');
      if (checkbox) {
        lbGuardedCheckboxState = { checkbox, checked: Boolean(checkbox.checked) };
        lbClearGuardedCheckboxSoon();
      }
    },
    true
  );
  container.addEventListener("click", (event) => {
    if (event.target?.closest?.("a.lb-learn-source")) {
      event.stopPropagation?.();
      return;
    }
    if (event.target?.closest?.(".lb-learn-links")) {
      event.preventDefault?.();
      event.stopPropagation?.();
    }
  });
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

/** New-from-Learn topics at a level for the harness choice: the chosen harness, or both when the lab covers both. */
function lbLearnNewForChoice(level) {
  return (lbIsBoth() ? labBuilder.harnessOrder : [labBuilder.harness]).reduce((sum, id) => sum + lbLearnNewCount(id, level), 0);
}

function lbApplyLearn(data) {
  labBuilder.learn = data;
  labBuilder.learnNew = lbLearnNewByHarness(data.topics);
  lbRenderLearnBar();
  lbRenderHarnesses();
  // A product added from Learn shows how many topics Microsoft Learn gave it, so its card follows the list.
  if (labBuilder.products.some((p) => p.custom)) lbRenderProducts();
  if (typeof lbMineRender === "function") lbMineRender();
}

function lbRenderLearnBar() {
  const status = document.getElementById("lb-learn-status");
  const button = document.getElementById("lb-learn-refresh");
  if (!status || !button) return;
  const learn = labBuilder.learn;
  button.disabled = labBuilder.learnBusy || Boolean(learn?.disabled);
  button.setAttribute("aria-busy", String(labBuilder.learnBusy));
  if (labBuilder.learnBusy) {
    status.textContent = `Refreshing the topic list from Microsoft Learn${lbSelectedProductList().length > 1 ? " for each product you chose" : ""}. This can take up to a minute for each product.`;
    return;
  }
  if (!learn) {
    status.textContent = "Checking when the topic list was last refreshed from Microsoft Learn...";
    return;
  }
  const newCount = learn.topics.filter((t) => t.source === "learn" && !t.product).length;
  const parts = [];
  // The Copilot Studio list is described only when Copilot Studio is part of the lab (or nothing is chosen yet).
  const showCopilotStudio = lbHasHarnessProduct() || !lbSelectedProductList().length;
  if (!showCopilotStudio) {
    /* the chosen products are described one by one below */
  } else if (!learn.refreshedAt) {
    parts.push("Microsoft Learn topics are not available, so only the built-in catalog is shown.");
  } else {
    const when = new Date(learn.refreshedAt);
    const stamp = when.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    const label = learn.source === "cache" ? "Last refreshed from Microsoft Learn" : "Built-in Microsoft Learn snapshot";
    parts.push(`${label}: ${stamp} (${lbAgo(learn.ageMs)}).`);
    if (lbHasHarnessProduct()) {
      parts.push(`${newCount} new topic${newCount === 1 ? "" : "s"} from Learn, ${lbLearnNewForChoice(labBuilder.level)} at ${lbLevelName(labBuilder.level)}.`);
    }
  }
  // Every other selected product has its own list from Microsoft Learn, with its own refresh time.
  const others = lbSelectedProductList().filter((p) => !p.hasHarnesses);
  for (const product of others) {
    const info = learn.products?.[product.id];
    if (!info?.refreshedAt) {
      parts.push(`${product.shortName}: no Microsoft Learn topic list yet, so only the built-in catalog is shown. Refresh to read one.`);
      continue;
    }
    const stamp = new Date(info.refreshedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    const label = info.source === "cache" ? "Last refreshed from Microsoft Learn" : "Built-in Microsoft Learn snapshot";
    parts.push(`${product.shortName}: ${label}: ${stamp} (${lbAgo(info.ageMs)}). ${info.newTopics} new topic${info.newTopics === 1 ? "" : "s"} from Learn.`);
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
      body: JSON.stringify(lbSelectedProductList().length ? { products: lbSelectedProductList().map((p) => p.id) } : {}),
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
    return `<span class="lb-badge lb-badge-new">${learn.userAdded ? "Added by you" : "New from Learn"}</span>${learn.updated ? '<span class="lb-badge lb-badge-updated">Updated</span>' : ""}`;
  }
  if (learn.status === "updated") return '<span class="lb-badge lb-badge-updated">Updated</span>';
  if (learn.status === "stale") return '<span class="lb-badge lb-badge-moved">Docs moved</span>';
  return "";
}

function lbEnsureTopicFilterOptions() {
  const select = document.getElementById("lb-topic-filter");
  if (!select || typeof document.createElement !== "function" || typeof select.appendChild !== "function") return;
  const extraOptions = [
    ["selected", "Selected topics"],
    ["recommended", "Recommended topics"],
    ["third-party", "Optional 3rd-party connectors"],
  ];
  for (const [value, label] of extraOptions) {
    if (typeof select.querySelector === "function" && select.querySelector(`option[value="${value}"]`)) continue;
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
  }
}

function lbEnsureThirdPartyFilterOption() {
  lbEnsureTopicFilterOptions();
}

function lbMatchesFilter(topic) {
  if (labBuilder.filter === "selected") return Boolean(topic.selected);
  if (labBuilder.filter === "recommended") return Boolean(topic.recommended);
  if (labBuilder.filter === "third-party") return Boolean(topic.thirdPartyConnector);
  const status = topic.learn?.status;
  if (labBuilder.filter === "new") return status === "new";
  if (labBuilder.filter === "updated") return status === "updated" || topic.learn?.updated === true;
  if (labBuilder.filter === "moved") return status === "stale";
  return true;
}

/** True while the picks are exactly what the rules suggest and the person has not changed them. */
function lbIsSuggestedSelection() {
  return Boolean(labBuilder.pickedAuto) && Boolean(labBuilder.picked);
}

/** "Suggested lab: 8 topics + 2 refreshers, about 2 h 20 min." The one line that says what the lab is right now. */
function lbRenderTopicSummary(rec) {
  const summary = document.getElementById("lb-topic-summary");
  if (!summary) return;
  if (!rec || !lbSelectedProductList().length) {
    summary.textContent = "";
    return;
  }
  const { selectedCount, prerequisiteCount, duration, subtopicTotal, subtopicCount } = rec.totals;
  if (!selectedCount) {
    summary.textContent = "No topics selected yet. Choose Change to pick some.";
    return;
  }
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const refreshers = prerequisiteCount ? ` + ${plural(prerequisiteCount, "refresher", "refreshers")}` : "";
  const subs = subtopicTotal ? `, ${subtopicCount} of ${plural(subtopicTotal, "sub-topic", "sub-topics")} included` : "";
  const label = lbIsSuggestedSelection() ? "Suggested lab" : "Your lab";
  summary.textContent = `${label}: ${plural(selectedCount, "topic", "topics")}${refreshers}, about ${duration}${subs}.`;
}

/** One sentence that says why the suggestion looks the way it does, so no row has to repeat it. */
function lbSuggestionReason(rec) {
  const level = lbLevelName(rec.answers.level);
  const industry = labBuilder.industries.find((i) => i.id === labBuilder.industry);
  const departments = labBuilder.roles.filter((r) => labBuilder.selectedRoles.has(r.id)).map((r) => r.name);
  const follows = [industry?.name, departments.length ? lbJoinNames(departments) : ""].filter(Boolean);
  return follows.length
    ? `Suggested for ${level}, with topics that follow ${lbJoinNames(follows)}.`
    : `Suggested for ${level}: the usual starting topics.`;
}

// ── Topics step ─────────────────────────────────────────────────────────────
function lbSelectedCount() {
  return labBuilder.rec ? labBuilder.rec.selectedIds.length : 0;
}

// ── Topics step: sub-topics ─────────────────────────────────────────────────
// A topic from Microsoft Learn can carry sub-topics: the companion articles merged under it. Each is its own
// checkbox. Every sub-topic of a selected topic is included unless the learner unchecks it (`excludedSubtopics`).
const LB_SUBTOPIC_PREVIEW = 6;

/** Every topic row the Topics step can show, at the chosen level and with an unknown level. */
function lbTopicRows() {
  return [...(labBuilder.rec?.concepts || []).flatMap((c) => c.topics), ...(labBuilder.rec?.levelUnknown?.topics || [])];
}

/** The ids of every sub-topic Microsoft Learn lists, from the loaded topic list and the current recommendation. */
function lbKnownSubtopicIds() {
  const ids = new Set();
  for (const topic of labBuilder.learn?.topics || []) for (const sub of topic.subtopics || []) ids.add(sub.id);
  for (const row of lbTopicRows()) for (const sub of row.learn?.subtopics || []) ids.add(sub.id);
  return ids;
}

/** Keep only ids that are still sub-topics, so a stale id from a saved lab can never make a request fail. Without a loaded list they all pass. */
function lbKnownSubtopics(ids) {
  const list = Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : [];
  if (!labBuilder.learn && !labBuilder.rec) return list;
  const known = lbKnownSubtopicIds();
  return list.filter((id) => known.has(id));
}

/** The exclusions to send with a request. */
function lbExcludedSubtopicList() {
  return lbKnownSubtopics([...labBuilder.excludedSubtopics]).sort();
}

function lbClearSubtopicExclusions(topic) {
  for (const sub of topic?.learn?.subtopics || []) labBuilder.excludedSubtopics.delete(sub.id);
}

/** What a topic card shows for its sub-topics, or null for a topic without any. */
function lbSubtopicView(t) {
  const subs = (t.learn?.subtopics || []).filter((s) => s && s.id && s.title);
  if (t.source !== "learn" || !subs.length) return null;
  const included = t.selected ? subs.filter((s) => s.included).length : 0;
  return { subs, total: subs.length, included, state: !t.selected ? "none" : included === subs.length ? "all" : "some" };
}

function lbAnnounce(message) {
  const el = document.getElementById("lb-topic-announce");
  if (el) el.textContent = message;
}

/** Check or uncheck one sub-topic. Checking one under an unselected topic selects the topic with only that sub-topic. */
function lbSetSubtopic(subId, parentId, checked) {
  const parent = lbTopicRows().find((t) => t.id === parentId);
  const sub = parent?.learn?.subtopics?.find((s) => s.id === subId);
  if (!parent || !sub) return;
  lbInvalidateSharepointPreview();
  labBuilder.chosenSteps.add("topics");
  labBuilder.prereqNotice = null;
  labBuilder.pendingUncheckIds = [];
  if (checked) {
    if (!parent.selected) {
      lbOwnPicks().add(parentId);
      labBuilder.excluded.delete(parentId);
      for (const other of parent.learn.subtopics) if (other.id !== subId) labBuilder.excludedSubtopics.add(other.id);
    }
    labBuilder.excludedSubtopics.delete(subId);
  } else {
    labBuilder.excludedSubtopics.add(subId);
  }
  const total = parent.learn.subtopics.length;
  const included = parent.learn.subtopics.filter((s) => !labBuilder.excludedSubtopics.has(s.id)).length;
  lbAnnounce(`${sub.title} ${checked ? "included" : "left out"}. ${included} of ${total} sub-topic${total === 1 ? "" : "s"} included under ${parent.name}.`);
  lbRefresh();
}

/** Show or hide the rest of a long sub-topic list. */
function lbToggleSubtopicList(parentId) {
  if (labBuilder.expandedSubtopics.has(parentId)) labBuilder.expandedSubtopics.delete(parentId);
  else labBuilder.expandedSubtopics.add(parentId);
  lbRenderTopics();
}

/** Make the learner's picks explicit, starting from what is currently selected. Touching a pick makes it theirs, not the suggestion. */
function lbOwnPicks() {
  if (!labBuilder.picked) {
    const rows = [...(labBuilder.rec?.concepts || []).flatMap((c) => c.topics), ...(labBuilder.rec?.levelUnknown?.topics || [])];
    labBuilder.picked = new Set(rows.filter((t) => t.selected && !t.required).map((t) => t.id));
  }
  labBuilder.pickedAuto = false;
  return labBuilder.picked;
}

function lbSetTopic(id, checked, required) {
  lbInvalidateSharepointPreview();
  labBuilder.chosenSteps.add("topics");
  const picks = lbOwnPicks();
  labBuilder.prereqNotice = null;
  // Toggling a topic toggles all of its sub-topics: a selected topic starts with every sub-topic included.
  lbClearSubtopicExclusions(lbTopicRows().find((t) => t.id === id));
  if (checked) {
    picks.add(id);
    labBuilder.excluded.delete(id);
    labBuilder.pendingUncheckIds = [];
  } else if (required) {
    labBuilder.excluded.add(id);
    labBuilder.pendingUncheckIds = [];
  } else {
    picks.delete(id);
    labBuilder.pendingUncheckIds = [id];
  }
  lbRefresh();
}

/** A lower-level prerequisite is never a pick of its own: turning it off marks it as already known. */
function lbSetPrerequisite(id, checked) {
  lbInvalidateSharepointPreview();
  labBuilder.chosenSteps.add("topics");
  labBuilder.prereqNotice = null;
  labBuilder.pendingUncheckIds = [];
  if (checked) labBuilder.excluded.delete(id);
  else labBuilder.excluded.add(id);
  lbRefresh();
}

function lbSetGroup(conceptId, checked) {
  const concept = labBuilder.rec?.concepts.find((c) => c.id === conceptId);
  if (!concept) return;
  lbInvalidateSharepointPreview();
  labBuilder.chosenSteps.add("topics");
  labBuilder.prereqNotice = null;
  const unchecked = [];
  const picks = lbOwnPicks();
  for (const topic of concept.topics) {
    lbClearSubtopicExclusions(topic);
    if (checked) {
      picks.add(topic.id);
      labBuilder.excluded.delete(topic.id);
    } else {
      if (topic.selected && !topic.required) unchecked.push(topic.id);
      picks.delete(topic.id);
      if (topic.required) labBuilder.excluded.add(topic.id);
    }
  }
  labBuilder.pendingUncheckIds = unchecked;
  lbRefresh();
}

function lbSelectAllTopics() {
  // Only the level's own topics; "Level unknown" topics are never added in bulk.
  lbInvalidateSharepointPreview();
  labBuilder.chosenSteps.add("topics");
  const all = (labBuilder.rec?.concepts || []).flatMap((c) => c.topics.map((t) => t.id));
  labBuilder.picked = new Set(all);
  labBuilder.pickedAuto = false;
  labBuilder.excluded.clear();
  labBuilder.excludedSubtopics.clear();
  labBuilder.step7Removed.clear();
  labBuilder.prereqNotice = null;
  labBuilder.pendingUncheckIds = [];
  lbRefresh();
}

function lbClearTopics() {
  lbInvalidateSharepointPreview();
  labBuilder.chosenSteps.add("topics");
  labBuilder.picked = new Set();
  labBuilder.pickedAuto = false;
  labBuilder.excluded.clear();
  labBuilder.excludedSubtopics.clear();
  labBuilder.step7Removed.clear();
  labBuilder.prereqNotice = null;
  labBuilder.pendingUncheckIds = [];
  lbRefresh();
}

/** Choose the suggested topics (what the rules recommend for these answers) and drop every other choice. */
function lbPickSuggested() {
  labBuilder.picked = new Set(labBuilder.rec?.recommendedIds || []);
  labBuilder.pickedAuto = true;
  labBuilder.excluded.clear();
  labBuilder.excludedSubtopics.clear();
  labBuilder.step7Removed.clear();
  labBuilder.prereqNotice = null;
  labBuilder.pendingUncheckIds = [];
}

/** "Back to suggested": the suggested topics again, whatever was changed since. This also replaces the old Reset to my answers. */
function lbSelectRecommended() {
  lbInvalidateSharepointPreview();
  labBuilder.chosenSteps.add("topics");
  lbPickSuggested();
  lbRefresh();
}

/**
 * Topics arrives with the suggested topics already selected, unless the person already made choices (a saved draft,
 * Edit selections, a restored level, or their own picks): those are never replaced.
 */
function lbNeedsSuggestion() {
  return (
    !labBuilder.picked &&
    !labBuilder.chosenSteps.has("topics") &&
    labBuilder.excluded.size === 0 &&
    labBuilder.excludedSubtopics.size === 0 &&
    labBuilder.step7Removed.size === 0 &&
    (labBuilder.rec?.recommendedIds || []).length > 0
  );
}

/** Show or hide the search, filter, and choose-topics tools behind the Change button. */
function lbToggleTopicTools(force) {
  const tools = document.getElementById("lb-topic-tools");
  const button = document.getElementById("lb-topic-change");
  if (!tools || !button) return;
  const open = typeof force === "boolean" ? force : tools.hidden;
  tools.hidden = !open;
  button.setAttribute("aria-expanded", String(open));
  if (open) document.getElementById("lb-topic-search")?.focus?.();
}

function lbBindTopicEvents() {
  lbEnsureThirdPartyFilterOption();
  lbBindExportEvents();
  lbBindBrandToggle();
  document.getElementById("lb-industry-select")?.addEventListener("change", (event) => lbSelectIndustry(event.target.value));
  lbEnsurePreviewEvents(document.getElementById("lb-preview"));
  lbBindSharepointSiteControls();
  const groups = document.getElementById("lb-topic-groups");
  lbBindLearnLinkGuard(groups);
  groups?.addEventListener("change", (event) => {
    const prerequisite = event.target.closest("input[data-prerequisite]");
    if (prerequisite) {
      if (lbShouldIgnoreGuardedChange(prerequisite)) return;
      lbSetPrerequisite(prerequisite.dataset.prerequisite, prerequisite.checked);
      return;
    }
    const subtopic = event.target.closest("input[data-subtopic]");
    if (subtopic) {
      lbSetSubtopic(subtopic.dataset.subtopic, subtopic.dataset.parent, subtopic.checked);
      return;
    }
    const input = event.target.closest("input[data-topic]");
    if (input) {
      if (lbShouldIgnoreGuardedChange(input)) return;
      lbSetTopic(input.dataset.topic, input.checked, input.dataset.required === "true");
    }
  });
  groups?.addEventListener(
    "toggle",
    (event) => {
      const id = event.target.id;
      if (id === "lb-prereq-group") labBuilder.prereqOpen = event.target.open;
      else if (id === "lb-unknown-group") labBuilder.unknownOpen = event.target.open;
      else if (event.target.dataset?.concept && !lbForceGroupsOpen()) {
        // A group opened by a search or filter is not the person's choice, so it is not remembered.
        if (event.target.open) labBuilder.openGroups.add(event.target.dataset.concept);
        else labBuilder.openGroups.delete(event.target.dataset.concept);
      }
    },
    true
  );
  groups?.addEventListener("click", (event) => {
    const more = event.target.closest("button[data-subtopic-more]");
    if (more) {
      lbToggleSubtopicList(more.dataset.subtopicMore);
      return;
    }
    const rowToggle = event.target.closest("button[data-row-toggle]");
    if (rowToggle) {
      lbToggleRowDetails(rowToggle.dataset.rowToggle);
      return;
    }
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
  document.getElementById("lb-include-knowledge-check")?.addEventListener("change", (event) => {
    lbSetIncludeKnowledgeCheck(Boolean(event.target?.checked));
  });
  lbSetFormValue("lb-include-knowledge-check", Boolean(labBuilder.includeKnowledgeCheck));
}

/** Level as text, never color alone. A level worked out from the docs rubric says so. */
function lbLevelBadge(t) {
  if (!t.level) return '<span class="lb-badge lb-badge-warn">Level unknown</span>';
  return `<span class="lb-badge lb-badge-level">Level ${t.level}</span>${t.levelBasis === "estimated" ? '<span class="lb-badge lb-badge-warn">Estimated level</span>' : ""}`;
}

function lbMatchesQuery(t, query) {
  if (!query) return true;
  if (t.name.toLowerCase().includes(query) || t.summary.toLowerCase().includes(query) || t.id.includes(query)) {
    return true;
  }
  return (t.learn?.subtopics || []).some((s) => lbSubtopicMatches(s, query));
}

/** A sub-topic matches a search by its title, summary, or id, so a search can reveal it under its topic. */
function lbSubtopicMatches(s, query) {
  if (!query) return false;
  return (
    (s.title || "").toLowerCase().includes(query) ||
    (s.summary || "").toLowerCase().includes(query) ||
    (s.id || "").includes(query)
  );
}

function lbThirdPartyNote(t) {
  if (!t.thirdPartyConnector) return "";
  const context = Array.isArray(t.optionalFor) && t.optionalFor.length
    ? ` (relevant to ${escapeHtml(lbJoinNames(t.optionalFor))})`
    : "";
  return `<span class="lb-feature-note">Optional 3rd-party connector${context} — not selected by default. Custom labs use 1st-party Microsoft connectors unless you select this topic.</span>`;
}

const LB_RELATED_STATE = {
  selected: "selected",
  recap: "included as a refresher",
  assumed: "turned off, so the lab assumes it is known",
  available: "listed here, not selected",
  "other-level": "taught at another level",
  "other-harness": "for another harness",
  "other-product": "in a product you did not choose",
};

/** The topics this one requires and the topics that require it, each with where it shows up, so none is invisible. */
function lbRelatedNote(t) {
  const related = t.related;
  if (!related) return "";
  const part = (label, list) => {
    if (!list?.length) return "";
    const shown = list.slice(0, 4).map((r) => `${escapeHtml(r.name)} (${escapeHtml(LB_RELATED_STATE[r.state] || r.state)})`);
    const more = list.length > 4 ? `, and ${list.length - 4} more` : "";
    return `${label} ${shown.join("; ")}${more}`;
  };
  const parts = [part("Requires:", related.requires), part("Required by:", related.requiredBy)].filter(Boolean);
  return parts.length ? `<span class="lb-feature-note lb-feature-related">${parts.join(" · ")}</span>` : "";
}

function lbSubtopicBadges(s) {
  const level = s.level
    ? `<span class="lb-badge lb-badge-level">Level ${escapeHtml(s.level)}</span>${s.levelBasis === "estimated" ? '<span class="lb-badge lb-badge-warn">Estimated level</span>' : ""}`
    : "";
  const availability = s.availability
    ? `<span class="lb-badge lb-badge-${escapeHtml(s.availability)}">${s.availability === "ga" ? "GA" : escapeHtml(s.availability.charAt(0).toUpperCase() + s.availability.slice(1))}</span>`
    : "";
  const time = s.minutes ? `<span class="lb-badge lb-badge-time">about ${escapeHtml(s.minutes)} min</span>` : "";
  return `${level}${time}${availability}`;
}

/** One sub-topic as its own checkbox. Its Microsoft Learn link sits beside the label, so following it never toggles the checkbox. */
function lbSubtopicRow(t, s, query) {
  const checked = t.selected && s.included;
  const match = lbSubtopicMatches(s, query);
  const url = lbLearnUrl(s.url);
  const describedBy = s.summary ? ` aria-describedby="lb-subtopic-desc-${escapeHtml(s.id)}"` : "";
  const link = url
    ? `<a class="lb-learn-source lb-subtopic-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(s.title)} on Microsoft Learn (opens in a new tab)">Microsoft Learn</a>`
    : "";
  return `
              <li class="lb-subtopic${checked ? " checked" : ""}${match ? " lb-subtopic-match" : ""}">
                <label class="lb-subtopic-label">
                  <input type="checkbox" data-subtopic="${escapeHtml(s.id)}" data-parent="${escapeHtml(t.id)}" autocomplete="off" ${checked ? "checked" : ""}${describedBy}>
                  <span class="lb-subtopic-body">
                    <span class="lb-subtopic-name">${escapeHtml(s.title)}</span>
                    <span class="lb-feature-badges">${lbSubtopicBadges(s)}</span>
                    ${s.summary ? `<span id="lb-subtopic-desc-${escapeHtml(s.id)}" class="lb-feature-summary">${escapeHtml(s.summary)}</span>` : ""}
                    ${match ? '<span class="lb-feature-note lb-subtopic-match-note">Matches your search</span>' : ""}
                  </span>
                </label>
                ${link}
              </li>`;
}

/** The nested, individually checkable sub-topics of a topic card. A long list shows its first few with a button for the rest; a search shows them all. */
function lbRenderSubtopics(t, view, query) {
  const expanded = labBuilder.expandedSubtopics.has(t.id) || Boolean(query);
  const shown = expanded ? view.subs : view.subs.slice(0, LB_SUBTOPIC_PREVIEW);
  const hidden = view.total - shown.length;
  const plural = (n) => (n === 1 ? "" : "s");
  const legend = `${view.total} sub-topic${plural(view.total)} from Microsoft Learn${
    t.selected ? `: ${view.included} included` : ": select the topic or check one to include it"
  }`;
  const toggle = hidden
    ? `<button type="button" class="btn btn-small lb-subtopic-more" data-subtopic-more="${escapeHtml(t.id)}" aria-expanded="false" aria-controls="lb-subtopics-${escapeHtml(t.id)}">Show ${hidden} more sub-topic${plural(hidden)}</button>`
    : expanded && !query && view.total > LB_SUBTOPIC_PREVIEW
    ? `<button type="button" class="btn btn-small lb-subtopic-more" data-subtopic-more="${escapeHtml(t.id)}" aria-expanded="true" aria-controls="lb-subtopics-${escapeHtml(t.id)}">Show fewer sub-topics</button>`
    : "";
  return `
            <fieldset class="lb-subtopics" id="lb-subtopics-${escapeHtml(t.id)}">
              <legend class="lb-subtopics-legend">${escapeHtml(legend)}</legend>
              <ul class="lb-subtopic-list">${shown.map((s) => lbSubtopicRow(t, s, query)).join("")}
              </ul>
              ${toggle}
            </fieldset>`;
}

/** True while a search or a filter is on: every group that has a match opens, so the matches are on screen. */
function lbForceGroupsOpen() {
  return Boolean(labBuilder.search) || labBuilder.filter !== "all";
}

/** The one status chip a compact row carries. Everything else about the topic is in its details. */
function lbRowChip(t) {
  if (t.required) return { cls: "lb-badge-required", text: "Required prerequisite" };
  if (t.learn?.status === "new") return { cls: "lb-badge-new", text: t.learn.userAdded ? "Added by you" : "New from Learn" };
  if (t.learn?.status === "updated") return { cls: "lb-badge-updated", text: "Updated" };
  if (t.learn?.status === "stale") return { cls: "lb-badge-moved", text: "Docs moved" };
  if (!t.level) return { cls: "lb-badge-warn", text: "Level unknown" };
  if (t.thirdPartyConnector) return { cls: "", text: "Optional 3rd-party connector" };
  if (t.recommended) return { cls: "lb-badge-recommended", text: t.selected ? "Suggested" : "Suggested, not selected" };
  return null;
}

/** Open or close one row's details without drawing the list again. */
function lbToggleRowDetails(topicId) {
  const open = !labBuilder.openRows.has(topicId);
  if (open) labBuilder.openRows.add(topicId);
  else labBuilder.openRows.delete(topicId);
  const panel = document.getElementById(`lb-row-details-${topicId}`);
  const button = document.querySelector(`#lb-topic-groups button[data-row-toggle="${CSS.escape(topicId)}"]`);
  if (panel) panel.hidden = !open;
  if (button) {
    button.setAttribute("aria-expanded", String(open));
    button.textContent = open ? "Hide details" : "Details";
  }
}

/**
 * Catalog and server sentences name a topic by its internal id ("see mc-knowledge") and use the lab's own word "recap".
 * The portal says it in plain words instead; the catalog ids, the generated lab, and the exports keep their wording.
 */
function lbPlainText(text) {
  const names = new Map(lbFeatureList().map((feature) => [feature.id, feature.name]));
  return String(text || "")
    .replace(/\bmc-[a-z0-9]+(?:-[a-z0-9]+)*\b/g, (id) => (names.has(id) ? `"${names.get(id)}"` : "the matching topic"))
    .replace(/\b(?:prerequisite )?recap\(s\)/gi, (m) => (m[0] === m[0].toUpperCase() ? "Refresher(s)" : "refresher(s)"))
    .replace(/\b(?:prerequisite )?recap(s)?\b/gi, (m, plural) => `${m[0] === m[0].toUpperCase() ? "Refresher" : "refresher"}${plural ? "s" : ""}`)
    .replace(/this repository's reviewed catalog/gi, (m) => (m[0] === "T" ? "The reviewed catalog" : "the reviewed catalog"));
}

/** A topic as one compact row: checkbox, title, time, and one status chip, with everything else behind Details. */
function lbTopicCard(t) {
  const view = lbSubtopicView(t);
  const query = labBuilder.search;
  const chip = lbRowChip(t);
  const id = escapeHtml(t.id);
  const open = labBuilder.openRows.has(t.id) || Boolean(view && query && view.subs.some((s) => lbSubtopicMatches(s, query)));
  // The generic "Recommended for level N" reason is said once, in the suggestion sentence, not on every row.
  const reasons = (t.reasons || []).filter((reason) => !/^Recommended for level \d+/i.test(reason));
  const subtitle = `${view ? ` · ${view.included} of ${view.total} sub-topics` : ""}${lbTopicHarnessTag(t) ? ` · ${lbTopicHarnessTag(t)}` : ""}`;
  const details = `
              <div class="lb-row-details" id="lb-row-details-${id}"${open ? "" : " hidden"}>
                <span class="lb-feature-body">
                  <span class="lb-feature-badges">${!t.level || t.levelBasis === "estimated" ? lbLevelBadge(t) : ""}${t.availability ? `<span class="lb-badge lb-badge-${escapeHtml(t.availability)}">${t.availability === "ga" ? "GA" : escapeHtml(t.availability.charAt(0).toUpperCase() + t.availability.slice(1))}</span>` : ""}${lbLearnBadges(t)}</span>
                  <span id="lb-topic-desc-${id}" class="lb-feature-summary">${escapeHtml(t.summary)}</span>
                  ${reasons.length ? `<span class="lb-topic-reason">Why: ${escapeHtml(lbPlainText(reasons.join(". ")))}</span>` : ""}
                  ${lbThirdPartyNote(t)}
                  ${t.source === "learn" ? '<span class="lb-feature-note">Source: Microsoft Learn. Check each article before you teach it.</span>' : ""}
                  ${lbRelatedNote(t)}
                  ${lbRenderLearnLinks(t, view ? { hide: view.subs.map((s) => s.url) } : undefined)}
                  ${t.learn?.status === "stale" ? '<span class="lb-feature-note">The Microsoft Learn pages this topic cites could not be found. Its steps are checked against Learn when the lab is built.</span>' : ""}
                  ${t.harnessNote ? `<span class="lb-feature-note">${escapeHtml(lbPlainText(t.harnessNote))}</span>` : ""}
                </span>${view ? lbRenderSubtopics(t, view, query) : ""}
              </div>`;
  const checkbox = view
    ? `<input type="checkbox" data-topic="${id}" data-required="${t.required}" data-subtopic-state="${view.state}" autocomplete="off" ${view.state === "all" ? "checked" : ""} aria-describedby="lb-topic-desc-${id}" aria-controls="lb-subtopics-${id}">`
    : `<input type="checkbox" data-topic="${id}" data-required="${t.required}" autocomplete="off" ${t.selected ? "checked" : ""} aria-describedby="lb-topic-desc-${id}">`;
  return `
            <div class="lb-feature lb-row${t.selected ? " checked" : ""}${view ? " lb-feature-parent" : ""}">
              <label class="lb-feature-main lb-row-main">
                ${checkbox}
                <span class="lb-feature-name lb-row-title">${escapeHtml(t.name)}</span>
                <span class="lb-row-meta">about ${escapeHtml(t.minutes)} min${escapeHtml(subtitle)}</span>
                ${chip ? `<span class="lb-badge ${chip.cls}">${escapeHtml(chip.text)}</span>` : ""}
              </label>
              <button type="button" class="lb-row-toggle" data-row-toggle="${id}" aria-expanded="${open}" aria-controls="lb-row-details-${id}">${open ? "Hide details" : "Details"}</button>${details}
            </div>`;
}

/** How many topic cards the current search and filter leave visible in the level's own concept groups. */
function lbVisibleTopicCount(rec, query) {
  return rec.concepts.reduce(
    (sum, concept) =>
      sum +
      concept.topics.filter(
        (t) => lbMatchesFilter(t) && lbMatchesQuery(t, query)
      ).length,
    0
  );
}

/** How many sub-topics the visible cards list (a card lists all of its sub-topics). */
function lbVisibleSubtopicCount(rec, query) {
  return rec.concepts.reduce(
    (sum, concept) =>
      sum +
      concept.topics
        .filter((t) => lbMatchesFilter(t) && lbMatchesQuery(t, query))
        .reduce((inner, t) => inner + (lbSubtopicView(t)?.total || 0), 0),
    0
  );
}

function lbRenderTopics() {
  lbEnsureThirdPartyFilterOption();
  const el = document.getElementById("lb-topic-groups");
  const rec = labBuilder.rec;
  lbRenderTopicSummary(rec);
  lbSyncExportScope();
  if (!el) return;
  if (!lbSelectedProductList().length) {
    el.innerHTML = '<div class="scenario-empty">Choose at least one product in Step 1 to see available topics.</div>';
    return;
  }
  if (!rec) {
    el.innerHTML = '<div class="scenario-empty">Loading topics...</div>';
    return;
  }
  const activeId = document.activeElement?.dataset?.topic || null;
  const activeSubtopic = document.activeElement?.dataset?.subtopic || null;
  const activeMore = document.activeElement?.dataset?.subtopicMore || null;
  const activeRowToggle = document.activeElement?.dataset?.rowToggle || null;
  const activeAction = document.activeElement?.dataset?.groupAction
    ? `${document.activeElement.dataset.concept}:${document.activeElement.dataset.groupAction}`
    : null;
  const query = labBuilder.search;
  const forceOpen = lbForceGroupsOpen();
  const onlyCopilotStudio = (rec.answers.products || [LB_DEFAULT_PRODUCT]).every((id) => id === LB_DEFAULT_PRODUCT);
  // Copilot Studio alone is described by its harness, as before; any other selection is described by its products.
  const scopeName = onlyCopilotStudio && rec.answers.harnessMode === LB_BOTH ? "both harnesses" : onlyCopilotStudio && rec.answers.harness ? `the ${lbHarnessName(rec.answers.harness)}` : lbJoinNames((rec.products || []).map((p) => p.shortName));

  // Groups with no topic for these answers share one closed disclosure, so they never push the real groups down.
  const mutedItems = [];
  const groupHtml = rec.concepts
    .map((concept) => {
      if (!concept.topics.length) {
        if (query || labBuilder.filter !== "all") return "";
        const others = concept.otherHarnessTopics.map((t) => t.name).join(", ");
        const where = onlyCopilotStudio ? "on this harness" : "for these products";
        mutedItems.push(`
          <li class="lb-concept-muted" aria-label="${escapeHtml(concept.name)} (${concept.notYetAvailable ? "not available yet" : "not applicable"})">
            <strong>${escapeHtml(concept.name)}</strong> <span class="lb-badge">${concept.notYetAvailable ? `Not available yet ${where}` : `Not applicable ${where}`}</span>
            <span class="lb-category-desc">${escapeHtml(concept.notApplicable || "")}${others ? ` Available at other levels or for other harnesses: ${escapeHtml(others)}.` : ""}</span>
          </li>`);
        return "";
      }
      const topics = concept.topics.filter(
        (t) => lbMatchesFilter(t) && lbMatchesQuery(t, query)
      );
      if (!topics.length) return "";
      const open = forceOpen || labBuilder.openGroups.has(concept.id);
      return `
      <details class="lb-concept" data-concept="${escapeHtml(concept.id)}"${open ? " open" : ""}>
        <summary class="lb-category-title"><h4 class="lb-category-name">${escapeHtml(concept.name)}</h4>
          <span class="lb-concept-count${concept.selectedCount ? " lb-concept-count-active" : ""}">${concept.selectedCount} of ${concept.topics.length} selected${concept.minutes ? `, about ${lbFormatMinutes(concept.minutes)}` : ""}</span>
        </summary>
        <div class="lb-concept-toolbar">
          <div class="lb-category-desc">${escapeHtml(concept.summary)}</div>
          <div class="lb-group-actions${concept.topics.length === 1 ? " lb-group-actions-single" : ""}">
            <button type="button" class="btn btn-small" data-group-action="select" data-concept="${escapeHtml(concept.id)}" aria-label="Select all ${escapeHtml(concept.name)} topics">Select group</button>
            <button type="button" class="btn btn-small" data-group-action="clear" data-concept="${escapeHtml(concept.id)}" aria-label="Clear all ${escapeHtml(concept.name)} topics">Clear group</button>
          </div>
        </div>
        <div class="lb-feature-grid">
          ${topics.map(lbTopicCard).join("")}
        </div>
      </details>`;
    })
    .join("");
  const html =
    groupHtml +
    (mutedItems.length
      ? `
      <details class="lb-concept lb-concept-muted-group">
        <summary class="lb-category-title"><span class="lb-category-name">${mutedItems.length} more ${mutedItems.length === 1 ? "group has" : "groups have"} nothing for these answers</span></summary>
        <ul class="lb-concept-muted-list">${mutedItems.join("")}</ul>
      </details>`
      : "");

  // Lower-level topics that the selected topics need: separate, collapsed, and each one can be turned off.
  const prereqs = rec.prerequisites?.topics || [];
  const visiblePrereqs = labBuilder.filter === "selected" ? prereqs.filter((p) => p.selected) : prereqs;
  const showPrereqs =
    visiblePrereqs.length && !query && (labBuilder.filter === "all" || labBuilder.filter === "selected");
  const prereqHtml = showPrereqs
    ? `
      <details class="lb-concept lb-prereq-group" id="lb-prereq-group" ${labBuilder.prereqOpen ? "open" : ""}>
        <summary class="lb-category-title"><span class="lb-category-name">Refreshers from lower levels (included automatically)</span>
          <span class="lb-concept-count${rec.prerequisites.selectedCount ? " lb-concept-count-active" : ""}">${rec.prerequisites.selectedCount} of ${prereqs.length} included${rec.prerequisites.minutes ? `, about ${lbFormatMinutes(rec.prerequisites.minutes)}` : ""}</span>
        </summary>
        <p class="lb-category-desc">These are not ${escapeHtml(lbLevelName(rec.answers.level))} topics. Topics you selected build on them, so the lab includes each one as a short refresher. Uncheck one if your learners already know it: the lab then assumes it.</p>
        <div class="lb-feature-grid">
          ${visiblePrereqs
            .map((p) => {
              const open = labBuilder.openRows.has(p.id);
              return `
            <div class="lb-feature lb-row${p.selected ? " checked" : ""}">
              <label class="lb-feature-main lb-row-main">
                <input type="checkbox" data-prerequisite="${escapeHtml(p.id)}" autocomplete="off" ${p.selected ? "checked" : ""} aria-describedby="lb-prereq-desc-${escapeHtml(p.id)}">
                <span class="lb-feature-name lb-row-title">${escapeHtml(p.name)}</span>
                <span class="lb-row-meta">about ${escapeHtml(p.minutes)} min</span>
                <span class="lb-badge lb-badge-recap">Refresher</span>
              </label>
              <button type="button" class="lb-row-toggle" data-row-toggle="${escapeHtml(p.id)}" aria-expanded="${open}" aria-controls="lb-row-details-${escapeHtml(p.id)}">${open ? "Hide details" : "Details"}</button>
              <div class="lb-row-details" id="lb-row-details-${escapeHtml(p.id)}"${open ? "" : " hidden"}>
                <span class="lb-feature-body">
                  <span id="lb-prereq-desc-${escapeHtml(p.id)}" class="lb-feature-summary">${escapeHtml(p.summary)}</span>
                  <span class="lb-topic-reason">Why: ${escapeHtml(lbPlainText(p.reason))}</span>
                  ${lbRenderLearnLinks(p)}
                </span>
              </div>
            </div>`;
            })
            .join("")}
        </div>
      </details>`
    : "";

  // Learn topics whose level could not be worked out. They are never suggested and stay collapsed.
  const unknown = (rec.levelUnknown?.topics || []).filter(
    (t) => lbMatchesFilter(t) && lbMatchesQuery(t, query)
  );
  const unknownHtml = unknown.length
    ? `
      <details class="lb-concept lb-unknown-group" id="lb-unknown-group" ${labBuilder.unknownOpen ? "open" : ""}>
        <summary class="lb-category-title"><span class="lb-category-name">Level unknown (${unknown.length})</span>
          <span class="lb-concept-count${rec.levelUnknown.selectedCount ? " lb-concept-count-active" : ""}">${rec.levelUnknown.selectedCount} selected</span>
        </summary>
        <p class="lb-category-desc">These topics were found on Microsoft Learn, but we could not tell which level they belong to, so they are not suggested for ${escapeHtml(lbLevelName(rec.answers.level))}. Add one only if you have checked its article and want it in this lab.</p>
        <div class="lb-feature-grid">${unknown.map(lbTopicCard).join("")}</div>
      </details>`
    : "";

  const shown = lbVisibleTopicCount(rec, query);
  const shownSubtopics = lbVisibleSubtopicCount(rec, query);
  const narrowed = Boolean(query) || labBuilder.filter !== "all";
  const levelName = lbLevelName(rec.answers.level);
  const shownLabel = `${shown} topic${shown === 1 ? "" : "s"}${shownSubtopics ? ` and ${shownSubtopics} sub-topic${shownSubtopics === 1 ? "" : "s"}` : ""}`;
  const countText = rec.filter.shown
    ? narrowed
      ? `Showing ${shownLabel} for ${levelName} that match your search or filter (of ${rec.filter.shown}).`
      : `${shownLabel} for ${levelName}.`
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
    ? labBuilder.filter === "selected" && !query
      ? "No topics are currently selected. Switch Show back to All topics to browse, or choose Back to suggested."
      : labBuilder.filter === "recommended" && !query
      ? `No topics are suggested for your current answers at ${escapeHtml(levelName)}. Switch Show back to All topics to browse all available topics.`
      : labBuilder.filter === "third-party" && !query
      ? `No optional 3rd-party connector topics are listed at ${escapeHtml(levelName)}. Custom labs use 1st-party Microsoft connectors by default; optional 3rd-party connector topics are available at Level 200 and Level 300.`
      : "No topics match that search or filter."
    : `No ${escapeHtml(levelName)} topics are available for ${escapeHtml(scopeName)} yet. ${(rec.products || [])
        .map((p) => escapeHtml(p.message))
        .join(" ")} Go back and choose another level${onlyCopilotStudio ? " or harness" : ", product, or harness"}.`;
  el.innerHTML = html + prereqHtml + unknownHtml || `<div class="scenario-empty">${empty}</div>`;
  // A topic with some of its sub-topics left out shows the mixed state, which only a script can set.
  for (const box of el.querySelectorAll?.('input[data-subtopic-state="some"]') || []) box.indeterminate = true;

  const warnings = document.getElementById("lb-topic-warnings");
  if (warnings) {
    const dropped = rec.filter.droppedSelections || [];
    warnings.innerHTML = [
      ...(labBuilder.prereqNotice
        ? [`<div class="lb-warning lb-prereq-notice" role="status">${escapeHtml(labBuilder.prereqNotice)}</div>`]
        : []),
      ...(dropped.length
        ? [
            `<div class="lb-warning" role="status">These selected topics belong to another level, so they are not part of this ${escapeHtml(levelName)} lab: ${dropped
              .map((t) => `${escapeHtml(t.name)} (Level ${t.level})`)
              .join(", ")}.</div>`,
          ]
        : []),
      ...rec.dependencyWarnings.map((w) => `<div class="lb-warning" role="status">${escapeHtml(lbPlainText(w.message))}</div>`),
      ...rec.warnings.map((w) => `<div class="lb-warning" role="status">${escapeHtml(lbPlainText(w))}</div>`),
    ].join("");
  }
  const intro = document.getElementById("lb-topic-intro");
  if (intro) {
    const lead = lbIsSuggestedSelection() ? `${lbSuggestionReason(rec)} Uncheck anything you do not need.` : `${levelName} topics for ${scopeName}.`;
    intro.textContent = lead;
  }
  const error = document.getElementById("lb-topic-error");
  if (error && lbSelectedCount()) error.textContent = "";

  if (activeId) el.querySelector(`input[data-topic="${CSS.escape(activeId)}"]`)?.focus();
  else if (activeSubtopic) el.querySelector(`input[data-subtopic="${CSS.escape(activeSubtopic)}"]`)?.focus();
  else if (activeMore) el.querySelector(`button[data-subtopic-more="${CSS.escape(activeMore)}"]`)?.focus();
  else if (activeRowToggle) el.querySelector(`button[data-row-toggle="${CSS.escape(activeRowToggle)}"]`)?.focus();
  else if (activeAction) {
    const [concept, action] = activeAction.split(":");
    el.querySelector(`button[data-concept="${CSS.escape(concept)}"][data-group-action="${action}"]`)?.focus();
  }
}

// ── Topics step: Export All Topics ──────────────────────────────────────────
// Every topic and sub-topic for the chosen products, at every level, whatever the search, filter, or selection.
// The server builds the rows (POST /api/lab-builder/topics/export); the files are built here from those rows, so an
// export keeps working offline once the rows are loaded. The same files come out of portal/lib/lab-builder/topic-export.js.
const LB_EXPORT_COLUMNS = [
  ["product", "Product"],
  ["group", "Topic group"],
  ["topic", "Topic"],
  ["subtopic", "Sub-topic"],
  ["type", "Type"],
  ["level", "Level"],
  ["levelBasis", "Level basis"],
  ["minutes", "Approx. minutes"],
  ["harnesses", "Harness applicability"],
  ["availability", "Availability"],
  ["learnStatus", "Learn status"],
  ["thirdParty", "Optional 3rd-party connector"],
  ["requiredPrerequisite", "Required prerequisite"],
  ["recommended", "Recommended"],
  ["recommendedWhy", "Why recommended"],
  ["requires", "Prerequisites"],
  ["requiredBy", "Required by"],
  ["urls", "Microsoft Learn URL(s)"],
  ["source", "Source"],
  ["selected", "Selected in my lab"],
];
const LB_EXPORT_AVAILABILITY = { ga: "GA", preview: "Preview", retired: "Retired" };
const LB_EXPORT_LEARN_STATUS = { new: "New from Learn", updated: "Updated", stale: "Docs moved" };
const LB_EXPORT_BASIS = { declared: "Declared", estimated: "Estimated", unknown: "Unknown" };
const LB_EXPORT_MIME = { csv: "text/csv;charset=utf-8", markdown: "text/markdown;charset=utf-8", json: "application/json;charset=utf-8" };
const LB_EXPORT_EXTENSION = { csv: "csv", markdown: "md", json: "json" };
const LB_EXPORT_FORMAT_NAMES = { csv: "CSV", markdown: "Markdown", json: "JSON" };
const LB_EXPORT_CHUNK = 400;

let lbExportInflight = null;

function lbExportClean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

/** The answers that decide which topics the export covers. The selection is not part of it. */
function lbExportScopeRequest() {
  const request = { products: lbSelectedProductList().map((p) => p.id), departments: [...labBuilder.selectedRoles].sort() };
  if (lbHasHarnessProduct()) request.harness = labBuilder.harness;
  if (labBuilder.industry) request.industry = labBuilder.industry;
  return request;
}

/** What the export fills into "Selected in my lab": the topics and sub-topics the lab would build now. */
function lbExportSelection() {
  const rec = labBuilder.rec;
  const recaps = rec?.prerequisites?.selectedIds || [];
  return {
    selectedIds: [...(rec?.selectedIds || []), ...recaps],
    requiredIds: [...lbTopicRows().filter((t) => t.required && t.selected).map((t) => t.id), ...recaps],
    excludedSubtopics: [...labBuilder.excludedSubtopics],
  };
}

function lbExportApplySelection(rows, selection) {
  const selected = new Set(selection.selectedIds || []);
  const required = new Set(selection.requiredIds || []);
  const left = new Set(selection.excludedSubtopics || []);
  return rows.map((row) => {
    const isSub = row.type === "sub-topic";
    const picked = isSub ? selected.has(row.parentId) && !left.has(row.id) : selected.has(row.id);
    return { ...row, selected: picked, requiredPrerequisite: !isSub && picked && required.has(row.id) };
  });
}

function lbExportCell(row, key) {
  switch (key) {
    case "level":
      return row.level ? String(row.level) : "";
    case "levelBasis":
      return LB_EXPORT_BASIS[row.levelBasis] || "";
    case "minutes":
      return row.minutes ? String(row.minutes) : "";
    case "availability":
      return LB_EXPORT_AVAILABILITY[row.availability] || "";
    case "learnStatus":
      return LB_EXPORT_LEARN_STATUS[row.learnStatus] || "";
    case "thirdParty":
    case "requiredPrerequisite":
    case "recommended":
    case "selected":
      return row[key] ? "Yes" : "No";
    case "urls":
      return (row.urls || []).join(" ");
    case "type":
      return row.type === "topic" ? "Topic" : "Sub-topic";
    default:
      return lbExportClean(row[key]);
  }
}

/** A cell that starts with =, +, -, @, a tab, or a carriage return is read as a formula by Excel; a leading apostrophe makes it text. */
function lbExportProtect(text) {
  return /^[\t\r]|^\s*[=+\-@]/.test(text) ? `'${text}` : text;
}

function lbCsvField(text) {
  const safe = lbExportProtect(String(text));
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function lbExportYield() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** UTF-8 with a byte order mark, comma separated, CRLF line endings. Long exports give the page a turn between chunks. */
async function lbExportCsv(dataset, selection) {
  const rows = lbExportApplySelection(dataset.rows, selection);
  const lines = [LB_EXPORT_COLUMNS.map(([, header]) => lbCsvField(header)).join(",")];
  for (let i = 0; i < rows.length; i += 1) {
    lines.push(LB_EXPORT_COLUMNS.map(([key]) => lbCsvField(lbExportCell(rows[i], key))).join(","));
    if (i % LB_EXPORT_CHUNK === LB_EXPORT_CHUNK - 1) await lbExportYield();
  }
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

function lbMdText(value) {
  return lbExportClean(value).replace(/[\\`*_{}[\]<>|#]/g, "\\$&");
}

function lbMdUrl(url) {
  return String(url).replace(/[()\s]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

function lbMdFacts(row) {
  const facts = [];
  if (row.level) facts.push(`Level ${row.level}${row.levelBasis === "estimated" ? " (estimated)" : ""}`);
  if (row.minutes) facts.push(`about ${row.minutes} min`);
  if (LB_EXPORT_AVAILABILITY[row.availability]) facts.push(LB_EXPORT_AVAILABILITY[row.availability]);
  if (LB_EXPORT_LEARN_STATUS[row.learnStatus]) facts.push(LB_EXPORT_LEARN_STATUS[row.learnStatus]);
  if (row.thirdParty) facts.push("optional 3rd-party connector");
  if (row.requiredPrerequisite) facts.push("required prerequisite");
  if (row.recommended && row.type === "topic") facts.push(`recommended${row.recommendedWhy ? `: ${row.recommendedWhy}` : ""}`);
  if (row.type === "topic") {
    if (row.requires) facts.push(`requires ${row.requires}`);
    if (row.requiredBy) facts.push(`required by ${row.requiredBy}`);
  }
  facts.push(`selected in my lab: ${row.selected ? "yes" : "no"}`);
  return facts.map(lbMdText).join("; ");
}

/** A grouped outline: product, then topic group, then each topic with its sub-topics nested beneath it. */
async function lbExportMarkdown(dataset, selection) {
  const rows = lbExportApplySelection(dataset.rows, selection);
  const names = dataset.scope.products.map((p) => p.shortName);
  const lines = [`# Topic export: ${lbMdText(lbJoinNames(names))}`, "", lbMdText(dataset.scope.text), "", `Generated ${dataset.generatedAt.slice(0, 10)}.`];
  let product = null;
  let group = null;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (row.productId !== product) {
      product = row.productId;
      group = null;
      lines.push("", `## ${lbMdText(row.product)}`);
    }
    if (row.groupId !== group) {
      group = row.groupId;
      lines.push("", `### ${lbMdText(row.group)}`, "");
    }
    const name = row.type === "topic" ? row.topic : row.subtopic;
    const label = row.urls[0] ? `[${lbMdText(name)}](${lbMdUrl(row.urls[0])})` : lbMdText(name);
    lines.push(`${row.type === "topic" ? "-" : "  -"} ${row.type === "topic" ? "" : "Sub-topic: "}${label} - ${lbMdFacts(row)}`);
    if (i % LB_EXPORT_CHUNK === LB_EXPORT_CHUNK - 1) await lbExportYield();
  }
  return `${lines.join("\n")}\n`;
}

/** Structured JSON: product, then topic group, then topic with its `subTopics`. */
async function lbExportJson(dataset, selection) {
  const rows = lbExportApplySelection(dataset.rows, selection);
  const products = [];
  const leaf = (row) => ({
    id: row.id,
    name: row.type === "topic" ? row.topic : row.subtopic,
    type: row.type,
    level: row.level,
    levelBasis: row.levelBasis,
    approxMinutes: row.minutes || null,
    harnesses: row.harnesses,
    availability: row.availability || null,
    learnStatus: row.learnStatus || null,
    optionalThirdPartyConnector: Boolean(row.thirdParty),
    requiredPrerequisite: Boolean(row.requiredPrerequisite),
    recommended: Boolean(row.recommended),
    recommendedWhy: row.recommendedWhy || null,
    prerequisites: row.requires,
    requiredBy: row.requiredBy,
    urls: row.urls,
    source: row.source,
    selected: Boolean(row.selected),
  });
  let topic = null;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    let productEntry = products.find((entry) => entry.id === row.productId);
    if (!productEntry) products.push((productEntry = { id: row.productId, name: row.product, groups: [] }));
    let groupEntry = productEntry.groups.find((entry) => entry.id === row.groupId);
    if (!groupEntry) productEntry.groups.push((groupEntry = { id: row.groupId, name: row.group, topics: [] }));
    if (row.type === "topic") {
      topic = { ...leaf(row), subTopics: [] };
      groupEntry.topics.push(topic);
    } else if (topic && topic.id === row.parentId) {
      topic.subTopics.push(leaf(row));
    }
    if (i % LB_EXPORT_CHUNK === LB_EXPORT_CHUNK - 1) await lbExportYield();
  }
  return `${JSON.stringify({ schemaVersion: dataset.schemaVersion, generatedAt: dataset.generatedAt, scope: dataset.scope, counts: dataset.counts, products }, null, 2)}\n`;
}

function lbExportFileName(dataset, format) {
  const slug = dataset.scope.products.map((p) => p.id).join("-").replace(/[^a-z0-9-]+/g, "-").slice(0, 80);
  return `all-topics-${slug}-${dataset.generatedAt.slice(0, 10)}.${LB_EXPORT_EXTENSION[format] || "json"}`;
}

/** The dataset for the chosen products, loaded once per set of answers and kept, so exporting works offline afterwards. */
function lbLoadExportData() {
  const request = lbExportScopeRequest();
  const signature = JSON.stringify(request);
  if (labBuilder.exportData && labBuilder.exportSignature === signature) return Promise.resolve(labBuilder.exportData);
  if (lbExportInflight && lbExportInflight.signature === signature) return lbExportInflight.promise;
  const promise = (async () => {
    labBuilder.exportBusy = true;
    lbRenderExportScope();
    try {
      const res = await fetch("/api/lab-builder/topics/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...request, format: "dataset" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      labBuilder.exportData = data.dataset;
      labBuilder.exportSignature = signature;
      labBuilder.exportFailedSignature = null;
      return data.dataset;
    } catch (err) {
      labBuilder.exportFailedSignature = signature;
      throw err;
    } finally {
      labBuilder.exportBusy = false;
      lbExportInflight = null;
      lbRenderExportScope();
    }
  })();
  lbExportInflight = { signature, promise };
  return promise;
}

/** The scope note under the toolbar: exactly what Export All Topics will write. */
function lbRenderExportScope() {
  const note = document.getElementById("lb-export-scope");
  const main = document.getElementById("lb-export-main");
  const toggle = document.getElementById("lb-export-toggle");
  const products = lbSelectedProductList();
  const request = lbExportScopeRequest();
  const signature = JSON.stringify(request);
  const ready = Boolean(labBuilder.exportData) && labBuilder.exportSignature === signature;
  let text;
  if (!products.length) text = "Choose at least one product in Step 1 to export its topics.";
  else if (ready) text = `${labBuilder.exportData.scope.text} It ignores your search, filter, and level, and marks what you selected.`;
  else if (labBuilder.exportBusy) text = `Export scope: all topics and sub-topics for ${lbJoinNames(products.map((p) => p.shortName))}, all levels. Counting rows...`;
  else if (labBuilder.exportFailedSignature === signature) text = "The full topic list could not be loaded, so Export All Topics is not ready. Choose it to try again.";
  else text = `Export scope: all topics and sub-topics for ${lbJoinNames(products.map((p) => p.shortName))}, all levels.`;
  if (note && note.textContent !== text) note.textContent = text;
  const disabled = !products.length;
  for (const button of [main, toggle]) {
    if (!button) continue;
    button.disabled = disabled;
    button.setAttribute?.("aria-busy", String(Boolean(labBuilder.exportBusy)));
  }
}

/** Called on every render of the Topics step: updates the note and starts loading the rows when the answers changed. */
function lbSyncExportScope() {
  lbRenderExportScope();
  if (!lbSelectedProductList().length) return;
  const signature = JSON.stringify(lbExportScopeRequest());
  const ready = labBuilder.exportData && labBuilder.exportSignature === signature;
  if (ready || labBuilder.exportBusy || labBuilder.exportFailedSignature === signature) return;
  lbLoadExportData().catch(() => {});
}

function lbDownloadText(fileName, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  link.hidden = true;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function lbSetExportMenu(open) {
  const menu = document.getElementById("lb-export-menu");
  const toggle = document.getElementById("lb-export-toggle");
  if (!menu || !toggle) return;
  menu.hidden = !open;
  toggle.setAttribute("aria-expanded", String(open));
}

/** Build and download the export. CSV is the default; the menu offers Markdown and JSON. */
async function lbExportAllTopics(format = "csv") {
  const status = document.getElementById("lb-export-status");
  const chosen = LB_EXPORT_MIME[format] ? format : "csv";
  lbSetExportMenu(false);
  if (!lbSelectedProductList().length) return;
  if (status) status.textContent = `Preparing the ${LB_EXPORT_FORMAT_NAMES[chosen]} export...`;
  try {
    const dataset = await lbLoadExportData();
    const selection = lbExportSelection();
    const build = { csv: lbExportCsv, markdown: lbExportMarkdown, json: lbExportJson }[chosen];
    const text = await build(dataset, selection);
    const fileName = lbExportFileName(dataset, chosen);
    lbDownloadText(fileName, text, LB_EXPORT_MIME[chosen]);
    const { topics, subTopics, rows } = dataset.counts;
    if (status) status.textContent = `Exported ${rows} rows (${topics} topic${topics === 1 ? "" : "s"} and ${subTopics} sub-topic${subTopics === 1 ? "" : "s"}) to ${fileName}.`;
  } catch (err) {
    if (status) status.textContent = `Could not export the topics: ${String(err.message || err).replace(/[.\s]*$/, ".")} Check your connection and try again.`;
  }
}

function lbBindExportEvents() {
  const root = document.getElementById("lb-export");
  if (!root || root._lbExportBound || typeof root.addEventListener !== "function") return;
  root._lbExportBound = true;
  const items = () => [...(root.querySelectorAll?.("[data-export-format]") || [])];
  root.addEventListener("click", (event) => {
    const item = event.target?.closest?.("[data-export-format]");
    if (item) {
      lbExportAllTopics(item.dataset.exportFormat);
      document.getElementById("lb-export-toggle")?.focus?.();
      return;
    }
    if (event.target?.closest?.("#lb-export-main")) {
      lbExportAllTopics("csv");
      return;
    }
    if (event.target?.closest?.("#lb-export-toggle")) {
      const menu = document.getElementById("lb-export-menu");
      lbSetExportMenu(Boolean(menu?.hidden));
      if (menu && !menu.hidden) items()[0]?.focus?.();
    }
  });
  root.addEventListener("keydown", (event) => {
    const menu = document.getElementById("lb-export-menu");
    const open = Boolean(menu) && !menu.hidden;
    if (event.key === "Escape" && open) {
      event.preventDefault?.();
      lbSetExportMenu(false);
      document.getElementById("lb-export-toggle")?.focus?.();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const toggle = document.getElementById("lb-export-toggle");
    if (event.target === toggle || event.target?.id === "lb-export-toggle") {
      event.preventDefault?.();
      lbSetExportMenu(true);
      items()[event.key === "ArrowUp" ? items().length - 1 : 0]?.focus?.();
      return;
    }
    const list = items();
    const index = list.indexOf(event.target);
    if (index < 0) return;
    event.preventDefault?.();
    list[(index + (event.key === "ArrowDown" ? 1 : list.length - 1)) % list.length]?.focus?.();
  });
  document.addEventListener?.("click", (event) => {
    if (!root.contains?.(event.target)) lbSetExportMenu(false);
  });
}

// ── Summary and stepper ─────────────────────────────────────────────────────
function lbIsStepChosen(stepKey) {
  switch (stepKey) {
    case "product":
      return lbSelectedProductList().length > 0;
    case "tailor":
      // Tailor it shows every default selected, so once it has been seen the summary can name them all.
      return (
        labBuilder.chosenSteps.has("tailor") ||
        labBuilder.step >= LB_STEP.tailor ||
        labBuilder.furthest >= LB_STEP.tailor ||
        labBuilder.industry !== null ||
        labBuilder.selectedRoles.size > 0 ||
        labBuilder.level !== 100 ||
        (lbHasHarnessProduct() && (labBuilder.harness !== "standard" || labBuilder.harnessMode !== "single" || labBuilder.differencesFor !== null))
      );
    case "topics":
      return (
        labBuilder.step >= LB_STEP.topics ||
        labBuilder.chosenSteps.has("topics") ||
        labBuilder.picked !== null ||
        labBuilder.excluded.size > 0
      );
    default:
      return false;
  }
}

function lbHasProgress() {
  return (
    labBuilder.selectedProducts.size > 0 ||
    labBuilder.chosenSteps.size > 0 ||
    labBuilder.industry !== null ||
    labBuilder.selectedRoles.size > 0 ||
    labBuilder.level !== 100 ||
    labBuilder.harness !== "standard" ||
    labBuilder.harnessMode !== "single" ||
    labBuilder.differencesFor !== null ||
    labBuilder.picked !== null ||
    labBuilder.excluded.size > 0 ||
    labBuilder.excludedSubtopics.size > 0 ||
    Boolean(labBuilder.sharepointSiteName) ||
    Boolean(labBuilder.sharepointSiteUrl) ||
    labBuilder.furthest > 1 ||
    labBuilder.step > 1 ||
    labBuilder.editing !== null
  );
}

function lbSyncResetButton() {
  const btn = document.getElementById("lb-start-over");
  const progress = lbHasProgress();
  if (btn) btn.hidden = !progress;
  if (!progress) lbHideStartOverConfirm();
  // Saving needs a product, so the button waits for one instead of answering with a refusal.
  const save = document.getElementById("lb-save-draft");
  if (save) save.hidden = labBuilder.selectedProducts.size === 0;
}

function lbSyncStepSummaryMirrors(summaryHtml) {
  if (typeof document === "undefined" || typeof document.querySelectorAll !== "function") return;
  document.querySelectorAll("[data-lb-step-summary]").forEach((node) => {
    node.innerHTML = summaryHtml;
  });
}

function lbRenderSummary() {
  lbSyncResetButton();
  const el = document.getElementById("lb-summary");
  let summaryHtml;
  if (!lbIsStepChosen("product")) {
    summaryHtml = "<strong>Your lab so far:</strong> nothing yet.";
  } else {
    const parts = [escapeHtml(lbProductsLabel())];
    if (lbIsStepChosen("tailor")) {
      const industry = labBuilder.industries.find((i) => i.id === labBuilder.industry);
      parts.push(escapeHtml(industry ? industry.name : "Cross-industry"));
      const departments = labBuilder.roles.filter((r) => labBuilder.selectedRoles.has(r.id)).map((r) => r.name);
      parts.push(escapeHtml(departments.length ? `Departments: ${departments.join(", ")}` : "All departments"));
      parts.push(escapeHtml(lbLevelName(labBuilder.level)));
      if (lbHasHarnessProduct()) parts.push(escapeHtml(lbHarnessChoiceName()));
    }
    // Topics and Review and build say the topic count, the time, the quiz choice, and the SharePoint site on the screen itself, so the bar does not repeat them there.
    const onTopicsOrReview = labBuilder.step === LB_STEP.topics || labBuilder.step === LB_STEP.review;
    if (lbIsStepChosen("topics") && !onTopicsOrReview) {
      const totals = labBuilder.rec?.totals;
      const recaps = totals?.prerequisiteCount ? ` + ${totals.prerequisiteCount} refresher${totals.prerequisiteCount === 1 ? "" : "s"}` : "";
      const time = totals
        ? totals.selectedCount
          ? `${totals.selectedCount} topic${totals.selectedCount === 1 ? "" : "s"}${recaps}, about ${totals.duration} (estimate, not a limit)`
          : "No topics selected yet"
        : "Calculating topics...";
      parts.push(escapeHtml(time));
    }
    if (lbIncludeKnowledgeCheck() && labBuilder.step !== LB_STEP.review) {
      parts.push(escapeHtml("Knowledge checks: mini-quizzes on"));
    }
    const spState = lbResolveSharepointSiteState();
    if (spState.requiresSharepointSite && spState.configured && labBuilder.step !== LB_STEP.review) {
      parts.push(escapeHtml(`SharePoint site: ${spState.label || spState.name || spState.url}`));
    }
    const brandChip = lbBrandSummaryChip();
    if (brandChip) parts.push(brandChip);
    summaryHtml = `<strong>Your lab so far:</strong> ${parts.join(" · ")}`;
  }
  if (el) el.innerHTML = summaryHtml;
  // With no product chosen there is nothing to summarize, so the bar stays out of the way until there is.
  const bar = el?.closest?.(".lb-summary-bar");
  if (bar) bar.hidden = !lbIsStepChosen("product");
  lbSyncStepSummaryMirrors(summaryHtml);
  lbSyncSharepointSiteUi();
}

/** Keep every heading's "Step n of m" true and mark which steps are current, done, and reachable. */
function lbRenderStepper() {
  const visible = lbVisibleStepIds();
  document.querySelectorAll("#lb-steps [data-lb-step]").forEach((button) => {
    const step = Number(button.dataset.lbStep);
    const shown = visible.includes(step);
    const item = button.closest("li");
    if (item) item.hidden = !shown;
    const number = button.querySelector("span[aria-hidden]");
    if (number && shown) number.textContent = String(visible.indexOf(step) + 1);
    const reachable = step === LB_STEP.product || (labBuilder.selectedProducts.size > 0 && step <= labBuilder.furthest);
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
  lbSyncReviewControls();
}

/** Label for the primary forward CTA from any wizard step. */
function lbNextActionLabel(step) {
  if (step === LB_STEP.review) return "Build my lab";
  const nextId = lbAdjacentStep(step, 1);
  const nextStep = LB_STEPS.find((s) => s.id === nextId);
  return nextStep ? `Next: ${nextStep.label} →` : "Next →";
}

/** Keep sticky top navigation and bottom step footers synchronized across all steps. */
function lbSyncNavControls() {
  const step = labBuilder.step;
  const empty = Boolean(labBuilder.rec) && lbSelectedCount() === 0;
  const genBtn = document.getElementById("lb-generate-btn");
  if (genBtn && !labBuilder.busy) genBtn.disabled = empty;

  const stickyBack = document.getElementById("lb-sticky-back");
  if (stickyBack) {
    stickyBack.hidden = step <= LB_STEP.product;
    stickyBack.disabled = Boolean(labBuilder.busy);
  }
  const stickyNext = document.getElementById("lb-sticky-next");
  if (stickyNext) {
    stickyNext.textContent = lbNextActionLabel(step);
    stickyNext.disabled = Boolean(labBuilder.busy) || (step === LB_STEP.review && empty);
  }
  lbObserveStepFooter();
}

/**
 * Every step has its Back and Next in the step footer, which sticks to the bottom of the viewport.
 * The sticky bar repeats them only as a fallback: while the footer is on screen the sticky copy is
 * covered (invisible and not focusable) so one copy of each action shows; if the footer is ever out
 * of view (for example a step scrolled far past) the sticky copy takes over.
 */
const lbNavCoverage = { observer: null, target: null, topInset: 0 };

function lbSetStickyNavCovered(covered) {
  const group = document.getElementById("lb-sticky-nav");
  if (group?.classList) group.classList.toggle("lb-sticky-nav-covered", covered);
}

function lbObserveStepFooter() {
  if (typeof IntersectionObserver === "undefined" || typeof document?.getElementById !== "function") {
    lbSetStickyNavCovered(false);
    return;
  }
  const pane = document.getElementById(`lb-pane-${labBuilder.step}`);
  const footer = pane?.querySelector?.("[data-lb-step-footer]") || null;
  // The portal header always overlays the top of the viewport, so the footer counts as visible below it.
  const headerBottom = Math.max(0, Math.round(document.querySelector("header")?.getBoundingClientRect?.().bottom || 0));
  // The summary bar sticks just below the header, whatever height the header wraps to.
  document.documentElement?.style?.setProperty?.("--lb-header-h", `${headerBottom}px`);
  const topInset = headerBottom;
  if (lbNavCoverage.observer && lbNavCoverage.target === footer && Math.abs(lbNavCoverage.topInset - topInset) < 6) return;
  lbNavCoverage.observer?.disconnect();
  lbNavCoverage.observer = null;
  lbNavCoverage.target = footer;
  lbNavCoverage.topInset = topInset;
  if (!footer) {
    lbSetStickyNavCovered(false);
    return;
  }
  lbNavCoverage.observer = new IntersectionObserver(
    (entries) => {
      const latest = entries[entries.length - 1];
      if (latest) lbSetStickyNavCovered(latest.isIntersecting);
    },
    { rootMargin: `-${topInset}px 0px 0px 0px`, threshold: 0 }
  );
  lbNavCoverage.observer.observe(footer);
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("resize", lbObserveStepFooter);
}

function generateCustomLab() {
  if (typeof lbGenerate === "function") return lbGenerate();
  document.getElementById("lb-generate-btn")?.click?.();
  return undefined;
}

function lbStickyPrimaryAction() {
  if (labBuilder.step === LB_STEP.review) {
    return generateCustomLab();
  }
  return lbNextStep();
}

/** Move forward one step, saving what the current one decided. The last step builds instead (see lbStickyPrimaryAction). */
function lbNextStep() {
  if (labBuilder.step === LB_STEP.product) {
    if (!labBuilder.selectedProducts.size) {
      const error = document.getElementById("lb-product-error");
      if (error) {
        error.textContent = "Choose at least one product to continue.";
        error.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
      }
      return;
    }
    labBuilder.chosenSteps.add("product");
  } else if (labBuilder.step === LB_STEP.tailor) {
    labBuilder.chosenSteps.add("tailor");
  } else if (labBuilder.step === LB_STEP.topics && lbSelectedCount() > 0) {
    labBuilder.chosenSteps.add("topics");
  }
  lbRenderSummary();
  lbGoToStep(lbAdjacentStep(labBuilder.step, 1));
}

function lbPrevStep() {
  lbGoToStep(lbAdjacentStep(labBuilder.step, -1));
}

function lbGoToStep(step) {
  step = Math.min(Math.max(step, 1), LB_STEPS.length);
  if (step > LB_STEP.product && !labBuilder.selectedProducts.size) {
    const error = document.getElementById("lb-product-error");
    if (error) {
      error.textContent = "Choose at least one product to continue.";
      error.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
    }
    step = LB_STEP.product;
  }
  if (step > LB_STEP.topics && !lbSelectedCount()) {
    if (labBuilder.step === LB_STEP.review) {
      // Already on Review and build with every module unchecked: stay, so the modules can be re-selected right there.
      const error = document.getElementById("lb-review-error");
      if (error) {
        error.textContent = "Keep or re-select at least one module before building your lab.";
        error.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
      }
      step = LB_STEP.review;
    } else {
      const error = document.getElementById("lb-topic-error");
      if (error) {
        error.textContent = "Choose at least one topic before you review the lab.";
        error.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
      }
      step = LB_STEP.topics;
    }
  }
  labBuilder.step = step;
  labBuilder.furthest = Math.max(labBuilder.furthest, step);
  for (const { id } of LB_STEPS) {
    const pane = document.getElementById(`lb-pane-${id}`);
    if (pane) pane.style.display = id === step ? "" : "none";
  }
  lbRenderStepper();
  lbRenderSummary();
  lbSyncResetButton();
  document.getElementById(`lb-heading-${step}`)?.focus();
  if (step === LB_STEP.tailor) lbRenderLevels();
  if (step === LB_STEP.topics) {
    lbRenderLevelNotice();
    lbRenderTopics();
    if (lbNeedsSuggestion()) {
      lbPickSuggested();
      lbRefresh();
    }
  }
  if (step === LB_STEP.review) {
    lbSyncSharepointSiteUi();
    lbSyncCustomizeCard();
    lbSyncCustomizeSummary();
    lbPreview();
    if (typeof scSyncCaptureOnBuild === "function") void scSyncCaptureOnBuild();
    if (typeof lbAiRefresh === "function") void lbAiRefresh();
  }
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

function lbIncludeKnowledgeCheck() {
  return Boolean(labBuilder.includeKnowledgeCheck);
}

function lbSetIncludeKnowledgeCheck(checked) {
  lbSetFormValue("lb-include-knowledge-check", Boolean(checked));
  lbRenderSummary();
  if (labBuilder.step === LB_STEP.review) lbPreview();
}

function lbSetFormValue(id, value) {
  if (id === "lb-include-knowledge-check") {
    labBuilder.includeKnowledgeCheck = Boolean(value);
  } else if (id === "lb-sharepoint-site-name") {
    labBuilder.sharepointSiteName = lbNormalizeSharepointSiteName(String(value ?? ""));
  } else if (id === "lb-sharepoint-site-url") {
    const raw = String(value ?? "").trim();
    const checked = lbValidateSharepointSiteUrl(raw);
    labBuilder.sharepointSiteUrl = checked.valid ? checked.url : raw;
  }
  const el = document.getElementById(id);
  if (!el) return;
  if (el.type === "checkbox" || typeof value === "boolean") el.checked = Boolean(value);
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
  labBuilder.selectedProducts = new Set();
  labBuilder.industry = null;
  labBuilder.selectedRoles = new Set();
  labBuilder.chosenSteps = new Set();
  labBuilder.level = 100;
  labBuilder.harness = "standard";
  labBuilder.harnessMode = "single";
  labBuilder.harnessOrder = ["standard", "microsoft-copilot"];
  labBuilder.differencesFor = null;
  labBuilder.picked = null;
  labBuilder.pickedAuto = false;
  labBuilder.excluded = new Set();
  labBuilder.excludedSubtopics = new Set();
  labBuilder.expandedSubtopics = new Set();
  labBuilder.openGroups = new Set();
  labBuilder.openRows = new Set();
  labBuilder.editOrder = false;
  labBuilder.step7Removed = new Map();
  labBuilder.moduleOrder = [];
  labBuilder.previewModules = [];
  labBuilder.rec = null;
  labBuilder.search = "";
  labBuilder.filter = "all";
  labBuilder.prereqOpen = false;
  labBuilder.unknownOpen = false;
  labBuilder.includeKnowledgeCheck = false;
  labBuilder.sharepointSiteName = "";
  labBuilder.sharepointSiteUrl = "";
  labBuilder.previewRequiresSharepointSite = null;
  labBuilder.brand.profileId = null;
  labBuilder.brand.overrides = {};
  labBuilder.brand.prefilled = { name: "", url: "" };
  labBuilder.step = LB_STEP.product;
  labBuilder.furthest = LB_STEP.product;
  labBuilder.levelNotice = null;
  labBuilder.prereqNotice = null;
  labBuilder.pendingUncheckIds = [];
  try {
    if (typeof localStorage !== "undefined" && typeof localStorage?.removeItem === "function") {
      localStorage.removeItem(LB_SHAREPOINT_STORAGE_KEY);
    }
  } catch {
    // Ignore storage errors.
  }
  lbRenderLevelNotice();
  for (const id of [
    "lb-product-error",
    "lb-topic-error",
    "lb-learn-error",
    "lb-review-error",
    "lb-sharepoint-site-error",
  ]) {
    const errEl = document.getElementById(id);
    if (errEl) errEl.textContent = "";
  }
  document.getElementById("lb-sharepoint-site-url")?.removeAttribute?.("aria-invalid");
  for (const [id, value] of [
    ["lb-time", ""],
    ["lb-title", ""],
    ["lb-agent-name", ""],
    ["lb-sharepoint-site-name", ""],
    ["lb-sharepoint-site-url", ""],
    ["lb-use-learn", true],
    ["lb-use-llm", true],
    ["lb-include-knowledge-check", false],
    ["lb-topic-search", ""],
    ["lb-topic-filter", "all"],
  ]) {
    lbSetFormValue(id, value);
  }
  lbSyncSharepointSiteUi();
  if (typeof lbAiReset === "function") lbAiReset();
  // A fresh start is no longer the draft that was open, and there is nothing left to autosave.
  if (typeof lbDraftsOnReset === "function") lbDraftsOnReset();
}

function lbResetWizard() {
  lbStopEditing(true);
  lbResetAnswers();
  lbRenderAllSteps();
}

async function lbStartNewLab() {
  if (typeof setActiveTab === "function") setActiveTab("labbuilder");
  if (!labBuilder.loaded && !labBuilder.products.length) await lbLoadCatalog();
  lbHideStartOverConfirm();
  lbStopEditing(true);
  lbResetAnswers();
  lbRenderAllSteps();
  await lbRefresh();
  lbGoToStep(LB_STEP.product);
  document.getElementById("lb-pane-1")?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  toast("Started a fresh lab. Choose one or more products to begin.", "info");
}

// ── Start over asks first ───────────────────────────────────────────────────
// The summary bar's Start over opens a small inline question. Nothing is cleared, and the autosave slot is left alone,
// until the person confirms; Keep working (or Esc) closes it and puts focus back on Start over.
function lbHideStartOverConfirm() {
  const box = document.getElementById("lb-start-over-confirm");
  if (box) box.hidden = true;
  document.getElementById("lb-start-over")?.setAttribute?.("aria-expanded", "false");
}

function lbAskStartOver() {
  const box = document.getElementById("lb-start-over-confirm");
  if (!box) {
    void lbStartNewLab();
    return;
  }
  box.hidden = false;
  document.getElementById("lb-start-over")?.setAttribute?.("aria-expanded", "true");
  // The question is already on screen, so only a screen reader is told: the confirm group is named by its own text.
  if (typeof lbDraftSay === "function") lbDraftSay("Start over? This clears your choices. Your saved drafts are kept.");
  document.getElementById("lb-start-over-keep")?.focus();
}

function lbCancelStartOver() {
  lbHideStartOverConfirm();
  if (typeof lbDraftAnnounce === "function") lbDraftAnnounce("Kept your choices.");
  document.getElementById("lb-start-over")?.focus();
}

async function lbConfirmStartOver() {
  await lbStartNewLab();
  if (typeof lbDraftAnnounce === "function") lbDraftAnnounce("Started over. Your saved drafts are kept.");
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

/**
 * Put saved choices into the wizard's state and form fields. A built lab's saved selections ("Edit selections") and a
 * saved draft share this path. `draft` is passed only for a draft: it restores the learner's own topic picks, the
 * answered steps, and the furthest step exactly, instead of working them out from the topic list.
 * Returns what could not be restored, so the caller can say so in plain words.
 */
function lbApplySavedSelections(saved, draft = null) {
  const knownRoles = new Set(labBuilder.roles.map((r) => r.id));
  const industryKnown = labBuilder.industries.some((i) => i.id === saved.industry);
  const harnessKnown = labBuilder.harnesses.some((h) => h.id === saved.harness);
  const requestedProducts = saved.products || [];
  const savedProducts = requestedProducts.filter((id) => lbProduct(id));
  const dropped = { products: requestedProducts.filter((id) => !lbProduct(id)), industry: null, roles: [], harness: null };
  // A lab saved before products existed is a Copilot Studio lab. A draft whose products are all gone asks again.
  labBuilder.selectedProducts = new Set(savedProducts.length || draft ? savedProducts : [LB_DEFAULT_PRODUCT]);
  labBuilder.industry = industryKnown ? saved.industry : null;
  if (saved.industry && !industryKnown) dropped.industry = saved.industry;
  labBuilder.selectedRoles = new Set(saved.roles.filter((id) => knownRoles.has(id)));
  dropped.roles = saved.roles.filter((id) => !knownRoles.has(id));
  labBuilder.level = lbSavedLevel(saved);
  labBuilder.levelNotice = null;
  // A draft keeps its harness only while the product that owns it is still chosen.
  const harnessUsable = harnessKnown && (!draft || labBuilder.selectedProducts.has(lbHarnessOwner(saved.harness)));
  if (draft && lbHasHarnessProduct() && !harnessUsable) {
    labBuilder.harness = labBuilder.harnesses.find((h) => labBuilder.selectedProducts.has(h.product || LB_DEFAULT_PRODUCT))?.id || "standard";
    if (saved.harness) dropped.harness = saved.harness;
  } else {
    labBuilder.harness = harnessUsable ? saved.harness : "standard";
  }
  labBuilder.differencesFor = saved.differencesFor ? new Set(saved.differencesFor) : null;
  // A lab or draft that covers both harnesses comes back as "Both, one after another", in the order it was saved.
  const savedOrder = Array.isArray(saved.harnesses) ? saved.harnesses : null;
  const orderKnown = Boolean(savedOrder) && savedOrder.length === 2 && new Set(savedOrder).size === 2 && savedOrder.every((id) => labBuilder.harnesses.some((h) => h.id === id));
  labBuilder.harnessOrder = orderKnown ? [...savedOrder] : ["standard", "microsoft-copilot"];
  labBuilder.harnessMode = saved.harnessMode === LB_BOTH && orderKnown && lbBothAvailable() ? LB_BOTH : "single";
  if (saved.harnessMode === LB_BOTH && labBuilder.harnessMode !== LB_BOTH && lbHasHarnessProduct()) dropped.harness = "both harnesses";
  labBuilder.picked = draft ? (draft.picked ? new Set(draft.picked) : null) : new Set(saved.features);
  labBuilder.pickedAuto = false;
  labBuilder.excluded = new Set(saved.excluded);
  // Restore the saved sub-topic choices. An id Microsoft Learn no longer lists as a sub-topic is dropped, so it cannot block the rebuild.
  labBuilder.excludedSubtopics = new Set(lbKnownSubtopics(saved.excludedSubtopics));
  labBuilder.step7Removed = new Map();
  labBuilder.moduleOrder = Array.isArray(saved.moduleOrder) ? [...saved.moduleOrder] : [];
  labBuilder.previewModules = [];
  labBuilder.chosenSteps = new Set(draft ? draft.chosenSteps : ["product", "tailor", "topics"]);
  labBuilder.rec = null;
  lbSetFormValue("lb-time", saved.targetMinutes || "");
  lbSetFormValue("lb-title", saved.customTitle || "");
  lbSetFormValue("lb-agent-name", saved.agentName || "");
  const loadedSpName = lbNormalizeSharepointSiteName(saved.sharepointSiteName || "");
  const loadedSpUrlCheck = lbValidateSharepointSiteUrl(saved.sharepointSiteUrl || "");
  labBuilder.sharepointSiteName = loadedSpName;
  // A draft keeps a half-typed address exactly as it was; a built lab only ever saved a valid one.
  labBuilder.sharepointSiteUrl = loadedSpUrlCheck.valid ? loadedSpUrlCheck.url : draft ? String(saved.sharepointSiteUrl || "").trim() : "";
  lbSetFormValue("lb-sharepoint-site-name", loadedSpName);
  lbSetFormValue("lb-sharepoint-site-url", labBuilder.sharepointSiteUrl);
  lbSetFormValue("lb-use-learn", saved.useLearnMcp !== false);
  lbSetFormValue("lb-use-llm", saved.useLlm !== false);
  lbSetFormValue("lb-include-knowledge-check", Boolean(saved.includeKnowledgeCheck));
  if (typeof lbAiApplySaved === "function") lbAiApplySaved(saved.ai);
  labBuilder.brand.profileId = typeof saved.brandProfileId === "string" ? saved.brandProfileId : null;
  labBuilder.brand.overrides = saved.brandOverrides && typeof saved.brandOverrides === "object" ? { ...saved.brandOverrides } : {};
  labBuilder.brand.prefilled = { name: "", url: "" };
  labBuilder.previewRequiresSharepointSite = null;
  lbSaveSelections();
  labBuilder.furthest = draft ? draft.furthest : LB_STEP.review;
  return dropped;
}

/** Pre-fill every step from a generated lab's saved choices and jump to Review. */
async function lbLoadSelections(lab) {
  const saved = lab?.selections;
  if (!saved) throw new Error("This lab has no saved selections.");
  if (typeof setActiveTab === "function") setActiveTab("labbuilder");
  if (!labBuilder.loaded && !labBuilder.products.length) await lbLoadCatalog();
  if (!labBuilder.loaded && !labBuilder.products.length) throw new Error("The lab builder catalog is not available.");

  if (typeof lbDraftsOnReplace === "function") lbDraftsOnReplace();
  lbApplySavedSelections(saved);
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

// ── Starting a lab from the Use Case Builder ────────────────────────────────
/**
 * Pre-fill the wizard from a Use Case Builder shortlist and open the Topics step.
 * The wizard's own rules stay in charge: the level is the single source of truth,
 * so recommended topics from other levels are not selected (a lower-level topic a
 * selected topic needs still arrives as a short refresher), and a topic that does not
 * belong to the chosen harness or to a chosen product is skipped. Everything stays
 * changeable on the steps that follow.
 *
 * @param {{products: string[], industry?: string, departments?: string[], level?: number, harness?: string, topicIds?: string[], title?: string}} plan
 * @returns {Promise<{selected: number, level: number, harness: string|null, skipped: {level: string[], harness: string[], product: string[], unknown: number}}>}
 */
async function lbPrefillFromUseCases(plan) {
  if (typeof setActiveTab === "function") setActiveTab("labbuilder");
  if (!labBuilder.loaded && !labBuilder.products.length) await lbLoadCatalog();
  if (!labBuilder.loaded && !labBuilder.products.length) throw new Error("The lab builder catalog is not available.");

  const products = (plan?.products || []).filter((id) => lbProduct(id));
  if (!products.length) throw new Error("None of the shortlisted products can be built into a lab.");

  lbStopEditing(true);
  lbResetAnswers();
  labBuilder.selectedProducts = new Set(products);
  labBuilder.industry = labBuilder.industries.some((i) => i.id === plan.industry) ? plan.industry : null;
  labBuilder.selectedRoles = new Set((plan.departments || []).filter((id) => labBuilder.roles.some((r) => r.id === id)));
  labBuilder.level = [100, 200, 300].includes(plan.level) ? plan.level : 100;
  const harnessUsable = lbHasHarnessProduct() && labBuilder.harnesses.some((h) => h.id === plan.harness && labBuilder.selectedProducts.has(lbHarnessOwner(h.id)));
  labBuilder.harness = harnessUsable ? plan.harness : "standard";

  const known = new Map(lbFeatureList().map((f) => [f.id, f]));
  const skipped = { level: [], harness: [], product: [], unknown: 0 };
  const keep = [];
  for (const id of plan.topicIds || []) {
    const feature = known.get(id);
    if (!feature) {
      skipped.unknown += 1;
      continue;
    }
    const product = feature.product || LB_DEFAULT_PRODUCT;
    if (!labBuilder.selectedProducts.has(product)) skipped.product.push(feature.name);
    else if (lbProduct(product)?.hasHarnesses && !(feature.harness || []).includes(labBuilder.harness)) skipped.harness.push(feature.name);
    else if (feature.level !== labBuilder.level) skipped.level.push(feature.name);
    else keep.push(id);
  }
  labBuilder.picked = new Set(keep);
  labBuilder.excluded = new Set();
  labBuilder.excludedSubtopics = new Set();
  labBuilder.chosenSteps = new Set(["product", "tailor", "topics"]);
  if (plan.title) lbSetFormValue("lb-title", String(plan.title).replace(LB_CONTROL_CHARS_RE, " ").trim().slice(0, 160));
  labBuilder.furthest = LB_STEP.topics;
  lbSaveSelections();
  lbRenderAllSteps();
  await lbRefresh();
  lbGoToStep(LB_STEP.topics);
  return { selected: keep.length, level: labBuilder.level, harness: lbHasHarnessProduct() ? labBuilder.harness : null, skipped };
}

// ── Review and request ──────────────────────────────────────────────────────
function lbRequest() {
  const time = Number(document.getElementById("lb-time")?.value || 0);
  const spState = lbResolveSharepointSiteState();
  const includeSharepoint =
    spState.requiresSharepointSite ||
    (!labBuilder.selectedProducts.size && (spState.name || spState.rawUrl));
  const spUrlValue = spState.validUrl ? spState.url : spState.rawUrl;
  const request = {
    industry: labBuilder.industry || undefined,
    roles: [...labBuilder.selectedRoles],
    products: lbSelectedProductList().map((p) => p.id),
    level: labBuilder.level,
    // What you see in the topic list is what gets built; prerequisites you turned off are assumed.
    features: labBuilder.rec ? labBuilder.rec.selectedIds : [],
    excluded: [...labBuilder.excluded],
    ...(lbExcludedSubtopicList().length ? { excludedSubtopics: lbExcludedSubtopicList() } : {}),
    ...(labBuilder.moduleOrder.length ? { moduleOrder: [...labBuilder.moduleOrder] } : {}),
    includeCore: false,
    targetMinutes: time > 0 ? time : undefined,
    title: document.getElementById("lb-title")?.value.trim() || undefined,
    agentName: document.getElementById("lb-agent-name")?.value.trim() || undefined,
    ...(includeSharepoint && spState.name ? { sharepointSiteName: spState.name } : {}),
    ...(includeSharepoint && spUrlValue ? { sharepointSiteUrl: spUrlValue } : {}),
    useLearnMcp: document.getElementById("lb-use-learn")?.checked !== false,
    useLlm: document.getElementById("lb-use-llm")?.checked !== false,
    includeKnowledgeCheck: lbIncludeKnowledgeCheck(),
    // Optional AI writing (ai-writing.js): present only when the person turned it on and the server can do it.
    ...(typeof lbAiRequestField === "function" ? lbAiRequestField() : {}),
    // A harness, and the notes comparing harnesses, only exist for a product that has harnesses. A lab that covers both
    // harnesses names them in order and carries no comparison notes: it teaches the other harness itself.
    ...(lbHasHarnessProduct()
      ? lbIsBoth()
        ? { harnessMode: LB_BOTH, harnesses: [...labBuilder.harnessOrder] }
        : { harness: labBuilder.harness, differencesFor: [...lbDifferencesFor()] }
      : {}),
  };
  return request;
}

function lbCollectRequest() {
  return lbRequest();
}

function lbSyncReviewControls() {
  const empty = Boolean(labBuilder.rec) && lbSelectedCount() === 0;
  lbSyncNavControls();
  lbSyncSharepointSiteUi();
  if (!empty) {
    const reviewError = document.getElementById("lb-review-error");
    if (reviewError) reviewError.textContent = "";
  }
}

function lbLookupModuleMeta(id) {
  const fromPreview = labBuilder.previewModules.find((m) => m.id === id);
  if (fromPreview) {
    return {
      id: fromPreview.id,
      name: fromPreview.name,
      summary: fromPreview.summary || "",
      level: fromPreview.level ?? null,
      role:
        fromPreview.role ||
        ([100, 200, 300].includes(fromPreview.level) && fromPreview.level < labBuilder.level ? "prerequisite" : "level"),
      minutes: fromPreview.minutes ?? null,
      docUrls: fromPreview.docUrls || [],
      learnLinks: lbResolveLearnLinks(fromPreview),
    };
  }
  const fromRemoved = labBuilder.step7Removed.get(id);
  if (fromRemoved) {
    return { ...fromRemoved, learnLinks: lbResolveLearnLinks(fromRemoved) };
  }
  const recTopics = [
    ...(labBuilder.rec?.concepts || []).flatMap((c) => c.topics),
    ...(labBuilder.rec?.levelUnknown?.topics || []),
  ];
  const recTopic = recTopics.find((t) => t.id === id);
  if (recTopic) {
    return {
      id: recTopic.id,
      name: recTopic.name,
      summary: recTopic.summary || "",
      level: recTopic.level ?? null,
      role: "level",
      minutes: recTopic.minutes ?? null,
      docUrls: recTopic.docUrls || [],
      learnLinks: lbResolveLearnLinks(recTopic),
    };
  }
  const recPrereq = (labBuilder.rec?.prerequisites?.topics || []).find((p) => p.id === id);
  if (recPrereq) {
    return {
      id: recPrereq.id,
      name: recPrereq.name,
      summary: recPrereq.summary || "",
      level: recPrereq.level ?? null,
      role: "prerequisite",
      minutes: recPrereq.minutes ?? null,
      docUrls: recPrereq.docUrls || [],
      learnLinks: lbResolveLearnLinks(recPrereq),
    };
  }
  const catalogFeature = lbFeatureList().find((f) => f.id === id);
  if (catalogFeature) {
    const isPrereq = [100, 200, 300].includes(catalogFeature.level) && catalogFeature.level < labBuilder.level;
    return {
      id: catalogFeature.id,
      name: catalogFeature.name,
      summary: catalogFeature.summary || "",
      level: catalogFeature.level ?? null,
      role: isPrereq ? "prerequisite" : "level",
      minutes: catalogFeature.minutes ?? null,
      docUrls: catalogFeature.docUrls || [],
      learnLinks: lbResolveLearnLinks(catalogFeature),
    };
  }
  return { id, name: id, summary: "", level: labBuilder.level, role: "level", minutes: null, docUrls: [], learnLinks: [] };
}

function lbRemovedCurriculumItems() {
  const rec = labBuilder.rec;
  const activeIds = new Set([
    ...(rec?.selectedIds || []),
    ...(rec?.prerequisites?.selectedIds || []),
  ]);
  const byId = new Map();
  for (const [id, item] of labBuilder.step7Removed.entries()) {
    if (!activeIds.has(id)) {
      byId.set(id, { ...item, learnLinks: lbResolveLearnLinks(item) });
    }
  }
  for (const prereq of rec?.prerequisites?.topics || []) {
    if (!prereq.selected && labBuilder.excluded.has(prereq.id) && !byId.has(prereq.id)) {
      byId.set(prereq.id, {
        id: prereq.id,
        name: prereq.name,
        summary: prereq.summary || "",
        level: prereq.level ?? null,
        role: "prerequisite",
        minutes: prereq.minutes ?? null,
        docUrls: prereq.docUrls || [],
        learnLinks: lbResolveLearnLinks(prereq),
        wasPicked: false,
      });
    }
  }
  for (const topic of [
    ...(rec?.concepts || []).flatMap((c) => c.topics),
    ...(rec?.levelUnknown?.topics || []),
  ]) {
    if (!topic.selected && labBuilder.excluded.has(topic.id) && !byId.has(topic.id)) {
      byId.set(topic.id, {
        id: topic.id,
        name: topic.name,
        summary: topic.summary || "",
        level: topic.level ?? null,
        role: "level",
        minutes: topic.minutes ?? null,
        docUrls: topic.docUrls || [],
        learnLinks: lbResolveLearnLinks(topic),
        wasPicked: false,
      });
    }
  }
  const neededPrereqIds = new Set((rec?.prerequisites?.topics || []).map((p) => p.id));
  return [...byId.values()].map((item) => {
    const isPrereqRecap =
      item.role === "prerequisite" || ([100, 200, 300].includes(item.level) && item.level < labBuilder.level);
    const canRestoreAlone = !isPrereqRecap || neededPrereqIds.has(item.id);
    return { ...item, role: isPrereqRecap ? "prerequisite" : "level", canRestoreAlone };
  });
}

function lbRenderRemovedSection() {
  const removed = lbRemovedCurriculumItems();
  if (!removed.length) return "";
  return `
    <section class="lb-removed-section" aria-labelledby="lb-removed-heading">
      <div class="lb-removed-header">
        <h4 id="lb-removed-heading" class="lb-removed-title">Removed from curriculum (${removed.length})</h4>
        <button type="button" class="btn btn-small" data-outline-action="restore-all">Restore all</button>
      </div>
      <p class="lb-removed-desc">Check a module below to add it back to this lab, or restore all removed modules.</p>
      <div class="lb-removed-list">
        ${removed
          .map((item) => {
            const levelBadge = item.level ? `<span class="lb-badge lb-badge-level">Level ${item.level}</span>` : '<span class="lb-badge lb-badge-warn">Level unknown</span>';
            const roleBadge = item.role === "prerequisite" ? '<span class="lb-badge lb-badge-recap">Refresher</span>' : "";
            const timeBadge = item.minutes ? `<span class="lb-badge lb-badge-time">about ${item.minutes} min</span>` : "";
            const note = item.canRestoreAlone
              ? item.summary
              : `Included as a refresher once a dependent Level ${labBuilder.level} module is selected, or select Restore all.`;
            return `
              <label class="lb-removed-item ${item.canRestoreAlone ? "" : "lb-removed-disabled"}">
                <input type="checkbox" data-outline-module="${escapeHtml(item.id)}" data-outline-role="${escapeHtml(item.role)}" autocomplete="off" ${
                  item.canRestoreAlone ? "" : "disabled"
                } aria-describedby="lb-removed-desc-${escapeHtml(item.id)}">
                <span class="lb-feature-body">
                  <span class="lb-feature-name">${item.role === "prerequisite" ? "Refresher: " : ""}${escapeHtml(item.name)}</span>
                  <span class="lb-feature-badges">${levelBadge}${roleBadge}${timeBadge}</span>
                  <span id="lb-removed-desc-${escapeHtml(item.id)}" class="lb-feature-summary">${escapeHtml(note)}</span>
                  ${lbRenderLearnLinks(item)}
                </span>
              </label>`;
          })
          .join("")}
      </div>
    </section>`;
}

/** A sub-topic under its module in the Review table: its own checkbox, so it can be left out here as well as on the Topics step. */
function lbRenderOutlineSubtopic(module, sub) {
  const id = `lb-outline-sub-${escapeHtml(sub.id)}`;
  const edit = Boolean(labBuilder.editOrder);
  const url = lbLearnUrl(sub.url);
  const link = edit && url
    ? `<a class="lb-learn-source" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(sub.title)} on Microsoft Learn (opens in a new tab)">Microsoft Learn</a>`
    : "";
  const spacer = edit ? '<td class="lb-outline-order-cell"></td><td></td>' : "";
  return `<tr class="lb-outline-subrow${sub.included ? "" : " lb-outline-subrow-off"}"><td class="lb-outline-include-cell"><input type="checkbox" class="lb-outline-check" id="${id}" data-outline-subtopic="${escapeHtml(sub.id)}" data-outline-parent="${escapeHtml(module.id)}" autocomplete="off" ${sub.included ? "checked" : ""}></td>${spacer}<th scope="row" class="lb-outline-subhead"><label class="lb-outline-module-label" for="${id}"><span class="lb-outline-subtag">Sub-topic:</span> ${escapeHtml(sub.title)}</label> ${link}</th><td>${sub.included ? `about ${escapeHtml(sub.minutes || 5)} min` : "left out"}</td></tr>`;
}

/** A lab module's label as the portal shows it: "Step" belongs to the wizard alone, so a module is "Part 3" and a recap is "Refresher 1". The lab file keeps its own headings. */
function lbModuleLabel(label) {
  return String(label || "")
    .replace(/^\s*Step\s+(\d+)/i, "Part $1")
    .replace(/^\s*Recap\s+(\d+)/i, "Refresher $1");
}

function lbRenderOutlineOrderControls(moduleOrId, index, total, maybeName) {
  const mod =
    moduleOrId && typeof moduleOrId === "object"
      ? moduleOrId
      : { id: moduleOrId, name: maybeName || moduleOrId };
  const safeId = escapeHtml(mod.id || "");
  const safeName = escapeHtml(mod.name || mod.id || "module");
  const disableUp = index <= 0 ? " disabled" : "";
  const disableDown = index >= total - 1 ? " disabled" : "";
  return `<td class="lb-outline-order-cell"><div class="lb-outline-order-controls" role="group" aria-label="Reorder ${safeName}"><button type="button" class="btn btn-sm lb-outline-move-btn" data-outline-move="up" data-outline-module="${safeId}" aria-label="Move ${safeName} up" title="Move up"${disableUp}><span aria-hidden="true">↑</span></button><button type="button" class="btn btn-sm lb-outline-move-btn" data-outline-move="down" data-outline-module="${safeId}" aria-label="Move ${safeName} down" title="Move down"${disableDown}><span aria-hidden="true">↓</span></button></div></td>`;
}

function lbRenderOutlineOrderToolbar() {
  if (!Array.isArray(labBuilder.moduleOrder) || !labBuilder.moduleOrder.length) return "";
  return `<div class="lb-outline-order-bar"><span class="lb-outline-order-status">Custom module order active</span><button type="button" class="btn btn-small lb-outline-reset-btn" data-outline-action="reset-order">Reset default order</button></div>`;
}

async function lbMoveOutlineModule(id, direction) {
  if (!id || (direction !== "up" && direction !== "down")) return;
  const baseIds =
    Array.isArray(labBuilder.previewModules) && labBuilder.previewModules.length
      ? labBuilder.previewModules.map((m) => m.id)
      : [...(labBuilder.moduleOrder || [])];
  const index = baseIds.indexOf(id);
  if (index < 0) return;
  const targetIndex = direction === "up" ? index - 1 : index + 1;
  if (targetIndex < 0 || targetIndex >= baseIds.length) return;
  const nextIds = [...baseIds];
  [nextIds[index], nextIds[targetIndex]] = [nextIds[targetIndex], nextIds[index]];
  labBuilder.moduleOrder = nextIds;
  lbSaveSelections();
  if (labBuilder.step === LB_STEP.review) {
    await lbPreview({ focusMove: { id, direction } });
  }
}

async function lbResetModuleOrder() {
  if (!labBuilder.moduleOrder.length) return;
  labBuilder.moduleOrder = [];
  lbSaveSelections();
  if (labBuilder.step === LB_STEP.review) {
    await lbPreview({ focusFirstModule: true });
  }
}

function lbFocusOutlineAfterPreview(el, options = {}) {
  if (!el || typeof el.querySelector !== "function") return;
  const cssEscape =
    typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape.bind(CSS)
      : (val) => String(val).replace(/["\\]/g, "\\$&");
  if (options.focusEditToggle) {
    el.querySelector('button[data-outline-action="toggle-edit"]')?.focus?.();
    return;
  }
  if (options.focusMove?.id) {
    const { id, direction } = options.focusMove;
    const escapedId = cssEscape(id);
    const primary = el.querySelector(
      `button[data-outline-module="${escapedId}"][data-outline-move="${direction === "down" ? "down" : "up"}"]`
    );
    if (primary && !primary.disabled) {
      primary.focus?.();
      return;
    }
    const fallbackDir = direction === "down" ? "up" : "down";
    const fallback = el.querySelector(
      `button[data-outline-module="${escapedId}"][data-outline-move="${fallbackDir}"]`
    );
    if (fallback && !fallback.disabled) {
      fallback.focus?.();
      return;
    }
  }
  if (options.focusSubtopicId) {
    el.querySelector(`input[data-outline-subtopic="${cssEscape(options.focusSubtopicId)}"]`)?.focus?.();
    return;
  }
  if (options.focusModuleId) {
    el.querySelector(`input[data-outline-module="${cssEscape(options.focusModuleId)}"]`)?.focus?.();
  } else if (options.focusFirstModule) {
    el.querySelector("input[data-outline-module]")?.focus?.();
  }
}

function lbEnsurePreviewEvents(el) {
  if (!el || el._lbOutlineBound || typeof el.addEventListener !== "function") return;
  el._lbOutlineBound = true;
  lbBindLearnLinkGuard(el);
  el.addEventListener("change", (event) => {
    const sub = event.target?.closest?.("input[data-outline-subtopic]");
    if (sub) return lbSetOutlineSubtopic(sub.dataset.outlineSubtopic, Boolean(sub.checked));
    const input = event.target?.closest?.("input[data-outline-module]");
    if (!input) return undefined;
    if (lbShouldIgnoreGuardedChange(input)) return undefined;
    return lbSetOutlineModule(input.dataset.outlineModule, Boolean(input.checked));
  });
  el.addEventListener("click", (event) => {
    const moveBtn = event.target?.closest?.("button[data-outline-move]");
    if (moveBtn) {
      if (moveBtn.disabled) return undefined;
      return lbMoveOutlineModule(moveBtn.dataset.outlineModule, moveBtn.dataset.outlineMove);
    }
    const actionBtn = event.target?.closest?.("button[data-outline-action]");
    if (!actionBtn) return undefined;
    const action = actionBtn.dataset.outlineAction;
    if (action === "toggle-edit") {
      labBuilder.editOrder = !labBuilder.editOrder;
      return lbPreview({ focusEditToggle: true });
    }
    if (action === "reset-order") return lbResetModuleOrder();
    if (action === "restore-all") return lbRestoreRemovedModules();
    if (action === "back-to-topics") return lbGoToStep(LB_STEP.topics);
    return undefined;
  });
}

/**
 * Toggle a planned curriculum module directly on the Review and build step.
 * A single uncheck removes the module immediately from the curriculum and marks it
 * excluded so prerequisite expansion does not add it back.
 */
async function lbSetOutlineModule(id, checked) {
  if (!id) return;
  lbInvalidateSharepointPreview();
  const meta = lbLookupModuleMeta(id);
  const picks = lbOwnPicks();
  const wasPicked = picks.has(id);
  const isPrereqRecap =
    meta.role === "prerequisite" || ([100, 200, 300].includes(meta.level) && meta.level < labBuilder.level);
  labBuilder.chosenSteps.add("topics");
  labBuilder.prereqNotice = null;
  labBuilder.pendingUncheckIds = [];
  if (!checked) {
    picks.delete(id);
    labBuilder.excluded.add(id);
    labBuilder.step7Removed.set(id, { ...meta, role: isPrereqRecap ? "prerequisite" : "level", wasPicked });
  } else {
    labBuilder.excluded.delete(id);
    labBuilder.step7Removed.delete(id);
    if (!isPrereqRecap) {
      const sameLevelTopic = (labBuilder.rec?.concepts || []).flatMap((c) => c.topics).find((t) => t.id === id);
      if (wasPicked || meta.wasPicked || !sameLevelTopic?.required) {
        picks.add(id);
      }
    }
  }
  await lbRefresh();
  if (checked && !isPrereqRecap && !(labBuilder.rec?.selectedIds || []).includes(id)) {
    lbOwnPicks().add(id);
    await lbRefresh();
  }
  lbRenderStepper();
  lbSyncReviewControls();
  if (labBuilder.step === LB_STEP.review) {
    await lbPreview({ focusModuleId: id });
  }
}

/**
 * Include or leave out one sub-topic from Review and build. It changes the same choice the Topics step holds, so the two steps never disagree.
 */
async function lbSetOutlineSubtopic(subId, checked) {
  if (!subId) return;
  lbInvalidateSharepointPreview();
  labBuilder.chosenSteps.add("topics");
  if (checked) labBuilder.excludedSubtopics.delete(subId);
  else labBuilder.excludedSubtopics.add(subId);
  await lbRefresh();
  lbRenderStepper();
  lbSyncReviewControls();
  if (labBuilder.step === LB_STEP.review) {
    await lbPreview({ focusSubtopicId: subId });
  }
}

async function lbRestoreRemovedModules() {
  const removed = lbRemovedCurriculumItems();
  if (!removed.length) return;
  lbInvalidateSharepointPreview();
  const picks = lbOwnPicks();
  labBuilder.chosenSteps.add("topics");
  labBuilder.prereqNotice = null;
  labBuilder.pendingUncheckIds = [];
  const anyWasPicked = removed.some((item) => item.wasPicked);
  for (const item of removed) {
    labBuilder.excluded.delete(item.id);
    const isPrereqRecap =
      item.role === "prerequisite" || ([100, 200, 300].includes(item.level) && item.level < labBuilder.level);
    if (!isPrereqRecap && (item.wasPicked || (!anyWasPicked && !lbSelectedCount()))) {
      picks.add(item.id);
    }
  }
  labBuilder.step7Removed.clear();
  await lbRefresh();
  const stillMissingLevel = removed.filter(
    (item) => item.role !== "prerequisite" && !(labBuilder.rec?.selectedIds || []).includes(item.id)
  );
  if (stillMissingLevel.length) {
    const nextPicks = lbOwnPicks();
    for (const item of stillMissingLevel) nextPicks.add(item.id);
    await lbRefresh();
  }
  lbRenderStepper();
  lbSyncReviewControls();
  if (labBuilder.step === LB_STEP.review) {
    await lbPreview({ focusFirstModule: true });
  }
}

async function lbPreview(options = {}) {
  const el = document.getElementById("lb-preview");
  if (!el) return;
  lbEnsurePreviewEvents(el);
  lbSyncReviewControls();
  const token = Symbol("preview");
  labBuilder.previewToken = token;

  if (labBuilder.rec && lbSelectedCount() === 0) {
    labBuilder.previewModules = [];
    el.innerHTML = `
      <div class="lb-warning lb-empty-curriculum" role="status">
        <p style="margin: 0 0 8px;"><strong>No modules remain in your curriculum.</strong> Re-select at least one module below or go back to Topics.</p>
        <button type="button" class="btn btn-small" data-outline-action="back-to-topics">← Back to Topics</button>
      </div>
      ${lbRenderRemovedSection()}
    `;
    if (options.focusModuleId && typeof CSS !== "undefined" && typeof CSS.escape === "function") {
      el.querySelector?.(`input[data-outline-module="${CSS.escape(options.focusModuleId)}"]`)?.focus?.();
    }
    return;
  }

  el.innerHTML = '<div class="scenario-empty" role="status">Planning your lab...</div>';
  try {
    const res = await fetch("/api/lab-builder/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(lbRequest()),
    });
    const data = await res.json();
    if (labBuilder.previewToken !== token) return;
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);

    labBuilder.previewModules = Array.isArray(data.modules) ? data.modules : [];
    // The AI card's prompt estimate counts these modules.
    if (typeof lbAiRender === "function") lbAiRender();
    labBuilder.previewRequiresSharepointSite =
      typeof data.requiresSharepointSite === "boolean" ? data.requiresSharepointSite : null;
    lbSyncSharepointSiteUi();
    const recaps = data.modules.filter((m) => m.role === "prerequisite").length;
    const own = data.modules.length - recaps;
    const edit = Boolean(labBuilder.editOrder);
    let recapCount = 0;
    let stepCount = 0;
    let lastPart = null;
    const moduleRowsHtml = data.modules
      .map((m, idx) => {
        const isRecap = m.role === "prerequisite";
        if (isRecap) recapCount += 1;
        else stepCount += 1;
        // A lab that covers both harnesses starts each part with a heading row, so the order reads as parts.
        const part = m.harnessPart && m.harnessPart !== lastPart ? data.harnessParts?.parts?.find((p) => p.id === m.harnessPart) : null;
        if (m.harnessPart) lastPart = m.harnessPart;
        const partRow = part
          ? `<tr class="lb-outline-part-row"><th scope="colgroup" colspan="${edit ? 5 : 3}">Part ${escapeHtml(part.n)}: ${escapeHtml(part.label)}${part.harness ? "" : " (works in either harness)"}</th></tr>`
          : "";
        const stepLabel = lbModuleLabel(
          m.stepLabel ||
            (isRecap ? `Recap ${m.recapOrder ?? recapCount}` : `Step ${m.stepOrder ?? stepCount}`),
        );
        // Rows are the checkbox, the title, and the time. The order controls, step numbers, descriptions, and Microsoft Learn links come with Edit order.
        const orderCells = edit ? `${lbRenderOutlineOrderControls(m, idx, data.modules.length)}<td>${escapeHtml(stepLabel)}</td>` : "";
        const detail = edit ? `<div id="lb-outline-desc-${escapeHtml(m.id)}" class="lb-feature-summary">${escapeHtml(m.summary)}</div>${lbRenderLearnLinks(m)}` : "";
        const describedBy = edit ? ` aria-describedby="lb-outline-desc-${escapeHtml(m.id)}"` : "";
        return `${partRow}<tr><td class="lb-outline-include-cell"><input type="checkbox" class="lb-outline-check" id="lb-outline-mod-${escapeHtml(m.id)}" data-outline-module="${escapeHtml(m.id)}" data-outline-role="${escapeHtml(m.role)}" autocomplete="off" checked${describedBy}></td>${orderCells}<th scope="row"><label class="lb-outline-module-label" for="lb-outline-mod-${escapeHtml(m.id)}">${isRecap ? "Refresher: " : ""}${escapeHtml(m.name)}</label>${detail}</th><td>about ${m.minutes} min</td></tr>${(m.subtopics || []).map((sub) => lbRenderOutlineSubtopic(m, sub)).join("")}`;
      })
      .join("");
    const subtopicTotal = data.modules.reduce((sum, m) => sum + (m.subtopics || []).length, 0);
    const subtopicIncluded = data.modules.reduce((sum, m) => sum + (m.subtopics || []).filter((s) => s.included).length, 0);
    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    const facts = [
      `${plural(own, "module", "modules")}${recaps ? ` + ${plural(recaps, "refresher", "refreshers")}` : ""}, about ${data.duration}`,
      lbLevelName(data.level),
      ...(subtopicTotal ? [`${subtopicIncluded} of ${plural(subtopicTotal, "sub-topic", "sub-topics")} included`] : []),
    ];
    // The AI choice changes without the outline being rebuilt, so it sits in a span of its own that ai-writing.js keeps current.
    const aiFact = typeof lbAiFactText === "function" ? `<span id="lb-outline-ai-fact">${escapeHtml(lbAiFactText() ? ` · ${lbAiFactText()}` : "")}</span>` : "";
    el.innerHTML = `
      <div class="lb-outline-title">${escapeHtml(data.title)}</div>
      <p class="lb-outline-facts">${escapeHtml(facts.join(" · "))}${aiFact}. Times are estimates, not limits.</p>
      <div class="lb-outline-tools">
        ${lbRenderOutlineOrderToolbar()}
        <button type="button" class="lb-link-btn" data-outline-action="toggle-edit" aria-expanded="${edit}">${edit ? "Done" : "Edit order"}</button>
      </div>
      <table class="lb-outline">
        <caption>Lab outline with estimated time per module</caption>
        <thead><tr><th scope="col" class="lb-outline-include-col">Include</th>${edit ? '<th scope="col" class="lb-outline-order-col">Order</th><th scope="col">Part</th>' : ""}<th scope="col">Module</th><th scope="col">Estimated time</th></tr></thead>
        <tbody>
          ${moduleRowsHtml}
        </tbody>
        <tfoot><tr><th scope="row" colspan="${edit ? 4 : 2}">Total (estimate)</th><td>about ${escapeHtml(data.duration)}</td></tr></tfoot>
      </table>
      ${(data.estimate?.suggestedParts || [])
        .map((part) => `<div class="lb-feature-note">Optional session ${part.part}: ${part.ids.length} module${part.ids.length === 1 ? "" : "s"}, about ${escapeHtml(part.duration)}</div>`)
        .join("")}
      ${data.warnings.map((w) => `<div class="lb-warning" role="status">${escapeHtml(lbPlainText(w))}</div>`).join("")}
      ${lbRenderRemovedSection()}
    `;
    lbFocusOutlineAfterPreview(el, options);
  } catch (err) {
    if (labBuilder.previewToken !== token) return;
    el.innerHTML = `<div class="scenario-empty" role="alert">Could not plan the lab: ${escapeHtml(err.message)}</div>`;
  }
}

// ── Review and build: brand profile and per-lab overrides ("Brand: ... Change") ──
const LB_OVERRIDE_KEYS = ["companyName", "tagline", "moreInfoUrl", "moreInfoLabel", "supportName", "supportEmail", "footerText"];

/** The loaded profile list from the Configuration tab code, or null before it is available. */
function lbBrandStore() {
  return typeof brandProfiles !== "undefined" && brandProfiles && brandProfiles.loaded ? brandProfiles : null;
}

/** The profile this lab uses: the chosen one, else the active profile. */
function lbBrandProfile() {
  const store = lbBrandStore();
  if (!store) return null;
  return (
    store.profiles.find((p) => p.id === labBuilder.brand.profileId) ||
    store.profiles.find((p) => p.id === store.activeProfileId) ||
    null
  );
}

function lbBrandOverrides() {
  const overrides = {};
  for (const key of LB_OVERRIDE_KEYS) {
    const value = typeof labBuilder.brand.overrides[key] === "string" ? labBuilder.brand.overrides[key].trim() : "";
    if (value) overrides[key] = value;
  }
  return overrides;
}

function lbEffectiveBrand() {
  const profile = lbBrandProfile();
  if (!profile || typeof brandMergeOverrides !== "function") return null;
  return brandMergeOverrides(profile, lbBrandOverrides());
}

/** HTML for the "Brand: <profile>" chip in the summary bar. Empty until the profiles have loaded, for the built-in Default, and on Review and build, where the brand line is already on screen. */
function lbBrandSummaryChip() {
  const profile = lbBrandProfile();
  if (!profile || labBuilder.step === LB_STEP.review) return "";
  if (profile.id === "default" && !Object.keys(lbBrandOverrides()).length) return "";
  return `<span class="lb-brand-chip">Brand: ${escapeHtml(profile.name)}</span>`;
}

/** The `brandProfileId` and `overrides` sent with the generate request (nothing until profiles have loaded). */
function lbBrandRequestFields() {
  const profile = lbBrandProfile();
  if (!profile) return {};
  return { brandProfileId: profile.id, overrides: lbBrandOverrides() };
}

/** Copy the profile's default SharePoint site into the SharePoint field, unless the person already chose a site. */
function lbPrefillSharepointFromProfile(profile) {
  const name = profile?.defaultSharepointSiteName || "";
  const url = profile?.defaultSharepointSiteUrl || "";
  const previous = labBuilder.brand.prefilled || { name: "", url: "" };
  const nameEl = document.getElementById("lb-sharepoint-site-name");
  const urlEl = document.getElementById("lb-sharepoint-site-url");
  let changed = false;
  if (nameEl) {
    const current = String(nameEl.value || "").trim();
    if ((!current || current === previous.name) && current !== name) {
      lbSetFormValue("lb-sharepoint-site-name", name);
      changed = true;
    }
  }
  if (urlEl) {
    const current = String(urlEl.value || "").trim();
    if ((!current || current === previous.url) && current !== url) {
      lbSetFormValue("lb-sharepoint-site-url", url);
      changed = true;
    }
  }
  labBuilder.brand.prefilled = { name, url };
  if (changed) {
    lbSyncSharepointSiteUi();
    if (typeof lbSaveSelections === "function") lbSaveSelections();
  }
}

function lbSyncCustomizeSummary() {
  const el = document.getElementById("lb-brand-summary");
  if (!el) return;
  const profile = lbBrandProfile();
  if (!profile) {
    el.textContent = "Brand: Default";
    return;
  }
  const overrideNames = typeof brandOverrideNames === "function" ? brandOverrideNames(lbBrandOverrides()) : [];
  el.textContent = overrideNames.length
    ? `Brand: ${profile.name} (changed for this lab: ${overrideNames.join(", ")})`
    : `Brand: ${profile.name}`;
}

function lbSyncCustomizeSite() {
  const el = document.getElementById("lb-customize-site");
  if (!el) return;
  const state = lbResolveSharepointSiteState();
  if (!state.requiresSharepointSite) {
    el.textContent = "The topics you picked do not need a SharePoint site.";
  } else if (state.name || state.url) {
    el.textContent = `SharePoint site for this lab: ${state.label || state.name || state.url}. Change it in the SharePoint site field above; the profile's default site pre-fills it.`;
  } else {
    el.textContent = "Add the SharePoint site in the SharePoint site field above. The profile has no default site.";
  }
}

function lbRenderCustomizePreview() {
  const preview = document.getElementById("lb-customize-preview");
  const brand = lbEffectiveBrand();
  if (!preview || !brand || typeof renderBrandPreviewHtml !== "function") return;
  preview.innerHTML = renderBrandPreviewHtml(brand, { labTitle: document.getElementById("lb-title")?.value?.trim() || "" });
}

/** "Brand: Default [Change]" opens and closes the brand card; it works even before the brand profiles have loaded. */
function lbBindBrandToggle() {
  const button = document.getElementById("lb-brand-change");
  if (!button || button._lbBound) return;
  button._lbBound = true;
  button.addEventListener("click", () => {
    const card = document.getElementById("lb-customize-card");
    if (!card) return;
    card.hidden = !card.hidden;
    button.setAttribute("aria-expanded", String(!card.hidden));
    button.textContent = card.hidden ? "Change" : "Hide";
  });
}

function lbBindCustomizeControls() {
  if (labBuilder.brand.bound) return;
  const select = document.getElementById("lb-brand-profile");
  if (!select || typeof select.addEventListener !== "function") return;
  labBuilder.brand.bound = true;

  select.addEventListener("change", () => {
    labBuilder.brand.profileId = select.value || null;
    lbSyncCustomizeCard();
    lbRenderSummary();
  });
  for (const key of LB_OVERRIDE_KEYS) {
    const input = document.getElementById(`lb-ov-${key}`);
    input?.addEventListener?.("input", () => {
      const value = String(input.value || "");
      labBuilder.brand.overrides[key] = value;
      const message = typeof brandValidateField === "function" ? brandValidateField(key, value) : "";
      const errorEl = document.getElementById(`lb-ov-${key}-error`);
      if (errorEl) errorEl.textContent = message;
      if (message) input.setAttribute("aria-invalid", "true");
      else input.removeAttribute("aria-invalid");
      lbRenderCustomizePreview();
      lbSyncCustomizeSummary();
    });
  }
  document.getElementById("lb-manage-profiles")?.addEventListener?.("click", (event) => {
    event.preventDefault();
    if (typeof setActiveTab === "function") setActiveTab("config");
    document.getElementById("bp-editor-heading")?.focus?.();
  });
  for (const id of ["lb-sharepoint-site-name", "lb-sharepoint-site-url", "lb-title"]) {
    document.getElementById(id)?.addEventListener?.("input", () => {
      lbSyncCustomizeSite();
      lbRenderCustomizePreview();
    });
  }
}

/** Render the picker, the override fields, the cover preview, and the brand line from the current choices. */
function lbSyncCustomizeCard() {
  if (typeof bpEnsureLoaded !== "function") return;
  const select = document.getElementById("lb-brand-profile");
  if (!select) return;
  lbBindCustomizeControls();
  const store = lbBrandStore();
  if (!store) {
    bpEnsureLoaded()
      .then(() => {
        lbSyncCustomizeCard();
        lbRenderSummary();
      })
      .catch(() => {});
    return;
  }

  if (!store.profiles.some((p) => p.id === labBuilder.brand.profileId)) labBuilder.brand.profileId = store.activeProfileId;
  select.innerHTML = store.profiles
    .map(
      (p) =>
        `<option value="${escapeHtml(p.id)}"${p.id === labBuilder.brand.profileId ? " selected" : ""}>${escapeHtml(p.name)}${
          p.id === store.activeProfileId ? " (active)" : ""
        }</option>`,
    )
    .join("");
  select.value = labBuilder.brand.profileId;

  const profile = lbBrandProfile();
  for (const key of LB_OVERRIDE_KEYS) {
    const input = document.getElementById(`lb-ov-${key}`);
    if (!input) continue;
    input.value = labBuilder.brand.overrides[key] || "";
    input.placeholder = profile?.[key] ? String(profile[key]) : "Uses the profile value";
  }
  lbPrefillSharepointFromProfile(profile);
  lbSyncCustomizeSite();
  lbRenderCustomizePreview();
  lbSyncCustomizeSummary();
  lbRenderSummary();
}
