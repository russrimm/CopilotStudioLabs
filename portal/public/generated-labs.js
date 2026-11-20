// Build a Lab: the "Previously generated labs" list and its actions
// (open, edit selections, rename, delete). Loaded after lab-builder-wizard.js,
// whose `labBuilder` state, `lbFormatMinutes`, and `lbLoadSelections` it uses.

const lbGen = {
  labs: [],
  loaded: false,
  query: "",
  driftFilter: "all",
  sort: "newest",
  bound: false,
  deleting: null,
  renaming: null,
  opened: null,
  lastBulkScanAt: null,
  driftBusy: false,
  driftBusyLabId: null,
  driftStatusMessage: "",
  driftStatusVariant: "",
};

function lbNormalizeLabLearnDrift(lab) {
  const d = lab?.learnDrift && typeof lab.learnDrift === "object" ? lab.learnDrift : null;
  if (d && typeof d.status === "string") {
    return {
      status: d.status,
      lastCheckedAt: typeof d.lastCheckedAt === "string" && d.lastCheckedAt ? d.lastCheckedAt : null,
      driftedModuleCount: Math.max(0, Number(d.driftedModuleCount || 0)),
      driftedModules: Array.isArray(d.driftedModules) ? d.driftedModules : [],
      missingScreenshotCount: Math.max(0, Number(d.missingScreenshotCount || 0)),
      moduleCount: Math.max(0, Number(d.moduleCount ?? lab?.moduleCount ?? 0)),
    };
  }
  const shots = lab?.screenshots && typeof lab.screenshots === "object" ? lab.screenshots : null;
  const stale = Math.max(0, Number(shots?.stale || 0));
  const pending = Math.max(0, Number(shots?.pending || 0));
  const rawStatus = shots?.learnSyncStatus || "";
  // Without a drift record there is no proof the lab was ever checked, so "up-to-date" is never assumed.
  const checked = shots?.checkState === "up-to-date" || Boolean(shots?.lastRevalidatedAt);
  let status = "not-checked";
  if (rawStatus === "docs-updated" || stale > 0) status = "docs-updated";
  else if (rawStatus === "ungrounded") status = "ungrounded";
  else if (rawStatus === "missing-screenshot" && checked) status = "missing-screenshot";
  else if (rawStatus === "up-to-date" && checked) status = pending > 0 ? "missing-screenshot" : "up-to-date";
  return {
    status,
    lastCheckedAt: null,
    driftedModuleCount: status === "docs-updated" ? Math.max(1, stale) : 0,
    driftedModules: [],
    missingScreenshotCount: pending,
    moduleCount: Math.max(0, Number(lab?.moduleCount || 0)),
  };
}

function lbDriftSortPriority(lab) {
  const status = lbNormalizeLabLearnDrift(lab).status;
  if (status === "docs-updated") return 0;
  if (status === "missing-screenshot") return 1;
  if (status === "not-checked" || status === "ungrounded") return 2;
  return 3;
}

function lbDriftMatchesFilter(lab, filter) {
  if (!filter || filter === "all") return true;
  const drift = lbNormalizeLabLearnDrift(lab);
  if (filter === "docs-updated") return drift.status === "docs-updated";
  if (filter === "missing-screenshot") return drift.status === "missing-screenshot";
  if (filter === "up-to-date") return drift.status === "up-to-date";
  if (filter === "not-checked") return drift.status === "not-checked" || drift.status === "ungrounded";
  return true;
}

const LB_GEN_SORTS = {
  newest: (a, b) => lbGenTime(b) - lbGenTime(a),
  "needs-update": (a, b) => {
    const prioDiff = lbDriftSortPriority(a) - lbDriftSortPriority(b);
    if (prioDiff !== 0) return prioDiff;
    const countDiff =
      lbNormalizeLabLearnDrift(b).driftedModuleCount - lbNormalizeLabLearnDrift(a).driftedModuleCount;
    if (countDiff !== 0) return countDiff;
    return lbGenTime(b) - lbGenTime(a);
  },
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
  return [
    lab.title,
    lab.notes,
    lab.labId,
    lab.sharepointSite?.label || "",
    lab.sharepointSite?.name || "",
    lab.sharepointSite?.url || "",
    lbGenIndustryName(lab.vertical),
    lbGenHarnessName(lab.harness),
    lbGenLevelName(lab.level),
    ...lbGenProductNames(lab),
  ]
    .join(" ")
    .toLowerCase();
}

function lbGenSafeExternalUrl(rawUrl) {
  if (typeof rawUrl !== "string") return "";
  const cleaned = rawUrl.trim();
  if (!cleaned || /[\u0000-\u001F\u007F<>"`\s]/.test(cleaned)) return "";
  try {
    const parsed = new URL(cleaned);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "";
    if (parsed.username || parsed.password) return "";
    return parsed.href;
  } catch {
    return "";
  }
}

function lbRenderTextWithSafeLinks(rawText) {
  const source = String(rawText ?? "");
  if (!source) return "";
  const linkRe = /\[((?:\\.|[^\]])+)\]\((https?:\/\/[^\s)]+)\)/gi;
  let cursor = 0;
  let html = "";
  let match;
  while ((match = linkRe.exec(source)) !== null) {
    if (match.index > cursor) {
      html += escapeHtml(source.slice(cursor, match.index));
    }
    const rawLabel = match[1].replace(/\\([[\]()\\])/g, "$1");
    const safeUrl = lbGenSafeExternalUrl(match[2]);
    if (safeUrl) {
      html += `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(rawLabel)}</a>`;
    } else {
      html += escapeHtml(match[0]);
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < source.length) {
    html += escapeHtml(source.slice(cursor));
  }
  return html;
}

function lbGenVisible() {
  const query = lbGen.query.trim().toLowerCase();
  const filter = lbGen.driftFilter || "all";
  const labs = lbGen.labs.filter((lab) => {
    if (!lbDriftMatchesFilter(lab, filter)) return false;
    if (query && !lbGenSearchText(lab).includes(query)) return false;
    return true;
  });
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
  const hasQuery = Boolean(lbGen.query.trim());
  const hasDriftFilter = Boolean(lbGen.driftFilter && lbGen.driftFilter !== "all");
  if (hasQuery && !hasDriftFilter && !shown) return `No generated labs match "${lbGen.query.trim()}". ${total} saved in all.`;
  if ((hasQuery || hasDriftFilter) && !shown) return `No generated labs match the current filters. ${total} saved in all.`;
  if (hasQuery || hasDriftFilter) return `Showing ${shown} of ${total} generated lab${total === 1 ? "" : "s"}.`;
  return `${total} generated lab${total === 1 ? "" : "s"}.`;
}

function lbSanitizeFileBase(rawTitle, fallback = "lab") {
  const cleaned = String(rawTitle ?? "")
    .replace(/[<>:"/\\|?*\u0000-\u001F\u007F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
    .slice(0, 80)
    .trim();
  return cleaned || String(fallback || "lab").trim() || "lab";
}

function lbResolveDisplayLabTitle(labId, explicitTitle) {
  const candidate =
    String(explicitTitle || "").trim() ||
    String(lbGenFind(labId)?.title || "").trim() ||
    (typeof document !== "undefined"
      ? String(document.querySelector?.("#lb-result-meta .lb-result-title")?.textContent || "").trim()
      : "");
  return candidate || "Lab";
}

function lbZipFormatSelectHtml(labId, title, scopePrefix) {
  const safeId = escapeHtml(labId);
  const safeTitle = escapeHtml(title || "Lab");
  const selectId = `${scopePrefix}-${safeId}`;
  return `
    <span class="lb-export-zip-group">
      <label class="sr-only" for="${selectId}">Export format for ${safeTitle}</label>
      <select id="${selectId}" class="lb-zip-format-select" data-zip-format-select data-lab-id="${safeId}" aria-label="Module document format for ${safeTitle} ZIP">
        <option value="all">All formats (.docx, .pptx, .pdf, .html)</option>
        <option value="docx">Word (.docx)</option>
        <option value="pptx">PowerPoint (.pptx)</option>
        <option value="pdf">PDF (.pdf)</option>
        <option value="html">HTML (.html)</option>
      </select>
      <button type="button" class="btn btn-sm" data-gen-action="export-zip" data-lab-id="${safeId}" aria-label="Download Complete Lab Package (.zip) for ${safeTitle}">📦 Complete Lab Package (.zip)</button>
    </span>`;
}

/** The prerequisites checklist on its own: one download with a format picker, and a preview of what the customer gets. */
function lbPrerequisitesGroupHtml(labId, title, scopePrefix) {
  const safeId = escapeHtml(labId);
  const safeTitle = escapeHtml(title || "Lab");
  const base = `${scopePrefix}-prereq-${safeId}`;
  return `
    <div class="lb-prereq-group" role="group" aria-label="Prerequisites checklist for ${safeTitle}" aria-describedby="${base}-note">
      <span class="lb-download-files-label">Prerequisites checklist</span>
      <p class="lb-prereq-note" id="${base}-note">Only the prerequisites, safe to send to the customer.</p>
      <div class="lb-download-files-links">
        <label class="sr-only" for="${base}-format">Format of the prerequisites checklist for ${safeTitle}</label>
        <select id="${base}-format" class="lb-zip-format-select" data-prereq-format-select data-lab-id="${safeId}">
          <option value="docx">Word (.docx), recommended</option>
          <option value="pdf">PDF (.pdf)</option>
          <option value="html">Web page (.html)</option>
          <option value="md">Markdown (.md)</option>
        </select>
        <button type="button" class="btn btn-sm btn-primary" data-gen-action="export-prereqs" data-lab-id="${safeId}" aria-label="Download prerequisites checklist for ${safeTitle}">Download prerequisites checklist</button>
        <button type="button" class="btn btn-sm" data-gen-action="preview-prereqs" data-lab-id="${safeId}" aria-label="Preview the prerequisites checklist for ${safeTitle}">Preview</button>
      </div>
    </div>`;
}

/**
 * Everything meant for the administrator, together and clearly named: the Administrator setup guide and the
 * Prerequisites checklist. Admin settings never appear in the learner guides, so this is the only place they are offered.
 */
function lbAdministratorGroupHtml(labId, title, scopePrefix) {
  const safeId = escapeHtml(labId);
  const safeTitle = escapeHtml(title || "Lab");
  const base = `${scopePrefix}-admin-${safeId}`;
  return `
    <div class="lb-admin-docs" role="group" aria-labelledby="${base}-title" aria-describedby="${base}-note">
      <span class="lb-download-files-label" id="${base}-title">For the administrator</span>
      <p class="lb-admin-note" id="${base}-note">Admin settings only. Not part of the learner guides.</p>
      <div class="lb-admin-guide-group" role="group" aria-label="Administrator setup guide for ${safeTitle}">
        <span class="lb-download-files-label">Administrator setup guide</span>
        <p class="lb-admin-note">Every administrator setting, grouped by role and in the order to do the work.</p>
        <div class="lb-download-files-links">
          <label class="sr-only" for="${base}-format">Format of the administrator setup guide for ${safeTitle}</label>
          <select id="${base}-format" class="lb-zip-format-select" data-admin-guide-format-select data-lab-id="${safeId}">
            <option value="docx">Word (.docx), recommended</option>
            <option value="pdf">PDF (.pdf)</option>
            <option value="html">Web page (.html)</option>
            <option value="md">Markdown (.md)</option>
          </select>
          <button type="button" class="btn btn-sm btn-primary" data-gen-action="export-admin-guide" data-lab-id="${safeId}" aria-label="Download administrator setup guide for ${safeTitle}">Download administrator setup guide</button>
          <button type="button" class="btn btn-sm" data-gen-action="preview-admin-guide" data-lab-id="${safeId}" aria-label="Preview the administrator setup guide for ${safeTitle}">Preview</button>
        </div>
      </div>
      ${lbPrerequisitesGroupHtml(labId, title, scopePrefix)}
    </div>`;
}

function lbGeneratedActionButtonsHtml(labId, title, options = {}) {
  const safeId = escapeHtml(labId);
  const encodedId = encodeURIComponent(labId);
  const displayTitle = String(title || "Lab").trim() || "Lab";
  const safeTitle = escapeHtml(displayTitle);
  const fileBase = escapeHtml(lbSanitizeFileBase(displayTitle, labId));
  const scopePrefix = options.scopePrefix || "lb-zip-fmt-result";
  return `
    <div class="lb-download-files-group" role="group" aria-label="Download associated files for ${safeTitle}">
      <span class="lb-download-files-label">Download Lab Files</span>
      <div class="lb-download-files-links">
        <a class="btn btn-sm lb-download-link" href="/api/lab-builder/generated/${encodedId}/export?format=html" download="${fileBase}.html" data-gen-action="export-html" data-lab-id="${safeId}" aria-label="Download Interactive Web Lab (.html) for ${safeTitle}">🌐 Interactive Web Lab (.html)</a>
        <a class="btn btn-sm lb-download-link" href="/api/lab-builder/generated/${encodedId}/export?format=docx" download="${fileBase}.docx" aria-label="Download Word Guide (.docx) for ${safeTitle}">📝 Word Guide (.docx)</a>
        <a class="btn btn-sm lb-download-link" href="/api/lab-builder/generated/${encodedId}/export?format=pptx" download="${fileBase}.pptx" aria-label="Download PowerPoint Deck (.pptx) for ${safeTitle}">📊 PowerPoint Deck (.pptx)</a>
        <a class="btn btn-sm lb-download-link" href="/api/lab-builder/generated/${encodedId}/export?format=pdf" download="${fileBase}.pdf" aria-label="Download PDF Guide (.pdf) for ${safeTitle}">📕 PDF Guide (.pdf)</a>
        <a class="btn btn-sm lb-download-link" href="/api/lab-builder/generated/${encodedId}/export?format=md" download="${fileBase}.md" data-gen-action="download" data-lab-id="${safeId}" aria-label="Download Markdown (.md) for ${safeTitle}">📄 Markdown (.md)</a>
        <a class="btn btn-sm lb-download-link" href="/api/lab-builder/generated/${encodedId}/export?format=facilitator-docx" download="${fileBase} - Facilitator Guide.docx" aria-label="Download Facilitator Guide (.docx) for ${safeTitle}">🎓 Facilitator Guide (.docx)</a>
        <a class="btn btn-sm lb-download-link" href="/api/lab-builder/generated/${encodedId}/export?format=facilitator-pdf" download="${fileBase} - Facilitator Guide.pdf" aria-label="Download Facilitator Guide (.pdf) for ${safeTitle}">🎓 Facilitator Guide (.pdf)</a>
        ${lbZipFormatSelectHtml(labId, displayTitle, scopePrefix)}
      </div>
    </div>
    ${lbAdministratorGroupHtml(labId, displayTitle, scopePrefix)}
    <div class="lb-result-utility-actions" role="group" aria-label="Lab tools for ${safeTitle}">
      <button type="button" class="btn btn-sm" data-gen-action="print" data-lab-id="${safeId}" aria-label="Print or save ${safeTitle} as PDF">🖨️ Print</button>
      <button type="button" class="btn btn-sm" data-gen-action="validate" data-lab-id="${safeId}" aria-label="Validate ${safeTitle}">🧪 Validate</button>
      <button type="button" class="btn btn-sm" data-gen-action="shot-checklist" data-lab-id="${safeId}" aria-label="Show the screenshots still to capture for ${safeTitle}">📋 Screenshots left</button>
    </div>`;
}

function lbRenderTopicDocumentsHtml(labId, topicDocuments) {
  if (!labId || !Array.isArray(topicDocuments) || !topicDocuments.length) return "";
  const encodedLabId = encodeURIComponent(labId);

  const itemsHtml = topicDocuments
    .map((doc) => {
      const order = Number(doc.order) || 1;
      const stepLabel = String(doc.stepLabel || `Step ${order}`);
      const isRecap = /^recap\b/i.test(stepLabel);
      const badgeMod = isRecap ? " lb-prereq-req-badge-recap" : "";
      const title = String(doc.title || stepLabel);
      const baseName = String(doc.fileBaseName || `${labId} - ${stepLabel} - ${title}`);
      const docxFileName = String(doc.docxFileName || `${baseName}.docx`);
      const pptxFileName = String(doc.pptxFileName || `${baseName}.pptx`);
      const encodedOrder = encodeURIComponent(String(order));
      const docxHref = `/api/lab-builder/generated/${encodedLabId}/topics/${encodedOrder}/docx`;
      const pptxHref = `/api/lab-builder/generated/${encodedLabId}/topics/${encodedOrder}/pptx`;

      return `
        <li class="lb-topic-doc-item">
          <div class="lb-topic-doc-info">
            <div class="lb-topic-doc-head">
              <span class="lb-prereq-req-badge${badgeMod}">${escapeHtml(stepLabel)}</span>
              <strong class="lb-topic-doc-title">${escapeHtml(title)}</strong>
            </div>
          </div>
          <div class="lb-topic-doc-actions">
            <a class="btn btn-sm lb-topic-doc-btn" href="${docxHref}" download="${escapeHtml(docxFileName)}" aria-label="Download Word guide for ${escapeHtml(stepLabel)}: ${escapeHtml(title)}">📝 Word (.docx)</a>
            <a class="btn btn-sm lb-topic-doc-btn" href="${pptxHref}" download="${escapeHtml(pptxFileName)}" aria-label="Download PowerPoint deck for ${escapeHtml(stepLabel)}: ${escapeHtml(title)}">📊 PowerPoint (.pptx)</a>
          </div>
        </li>`;
    })
    .join("");

  return `
    <section class="lb-topic-docs" aria-labelledby="lb-topic-docs-heading">
      <div class="lb-topic-docs-header">
        <h4 id="lb-topic-docs-heading">📄 Topic Word Documents &amp; PowerPoint Slides</h4>
        <div class="scenario-pill-list">
          <span class="scenario-pill">${topicDocuments.length} topic${topicDocuments.length === 1 ? "" : "s"}</span>
        </div>
      </div>
      <p class="lb-topic-docs-intro">
        Download standalone Word guides and PowerPoint training slide decks for individual topics.
      </p>
      <ul class="lb-topic-docs-list" aria-label="Per-topic Word documents and PowerPoint slides">${itemsHtml}</ul>
    </section>`;
}

const LB_PREREQ_STEP_PREFIX_RE = /^(Step|Recap)\s+(\d+)\s+[—–-]\s+(.+)$/i;

function lbRenderRequiredByItemHtml(rawEntry) {
  const text = String(rawEntry ?? "").trim();
  if (!text) return "";
  const match = text.match(LB_PREREQ_STEP_PREFIX_RE);
  if (match) {
    const isRecap = /^recap$/i.test(match[1]);
    const badgeLabel = `${isRecap ? "Recap" : "Step"} ${match[2]}`;
    const badgeMod = isRecap ? " lb-prereq-req-badge-recap" : "";
    return `<li class="lb-prereq-req-item"><span class="lb-prereq-req-badge${badgeMod}">${escapeHtml(badgeLabel)}</span><span class="lb-prereq-req-title">${escapeHtml(match[3].trim())}</span></li>`;
  }
  return `<li class="lb-prereq-req-item lb-prereq-req-item-general"><span class="lb-prereq-req-title">${escapeHtml(text)}</span></li>`;
}

function lbRenderRequiredByHtml(requiredBy, { visibleLimit = 4 } = {}) {
  const entries = (Array.isArray(requiredBy) ? requiredBy : [])
    .map((entry) => String(entry ?? "").trim())
    .filter(Boolean);
  if (!entries.length) return "";

  const limit = Number.isFinite(visibleLimit) && visibleLimit > 0 ? Math.floor(visibleLimit) : 4;
  const visible = entries.slice(0, limit);
  const hidden = entries.slice(limit);
  const visibleListHtml = `<ul class="lb-prereq-req-list">${visible.map(lbRenderRequiredByItemHtml).join("")}</ul>`;
  if (!hidden.length) {
    return visibleListHtml;
  }

  const moreWord = hidden.length === 1 ? "module" : "modules";
  const hiddenListHtml = `<ul class="lb-prereq-req-list">${hidden.map(lbRenderRequiredByItemHtml).join("")}</ul>`;
  return `${visibleListHtml}<details class="lb-prereq-req-more"><summary>+${hidden.length} more ${moreWord} (${entries.length} total)</summary>${hiddenListHtml}</details>`;
}

function lbRenderAdminPrerequisitesHtml(prereqs) {
  if (!prereqs || typeof prereqs !== "object") return "";
  const connectors = Array.isArray(prereqs.connectors) ? prereqs.connectors : [];
  const dlpAndAcp = Array.isArray(prereqs.dlpAndAcp) ? prereqs.dlpAndAcp : [];
  const environmentSettings = Array.isArray(prereqs.environmentSettings) ? prereqs.environmentSettings : [];
  const tenantAndCloud = Array.isArray(prereqs.tenantAndCloud) ? prereqs.tenantAndCloud : [];
  if (!connectors.length && !dlpAndAcp.length && !environmentSettings.length && !tenantAndCloud.length) {
    return "";
  }

  const spSite = prereqs.sharepointSite && typeof prereqs.sharepointSite === "object" ? prereqs.sharepointSite : null;
  const spSafeUrl = lbGenSafeExternalUrl(spSite?.url || "");
  const spDisplayLabel = spSite?.label || spSite?.name || spSafeUrl;
  const spCalloutHtml = spSafeUrl
    ? `<div class="lb-prereq-sp-callout"><strong>Target SharePoint Site:</strong> <a href="${escapeHtml(spSafeUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(spDisplayLabel)}</a> — open or provision this SharePoint site before starting the workshop.</div>`
    : spSite?.name
    ? `<div class="lb-prereq-sp-callout"><strong>Target SharePoint Site:</strong> ${escapeHtml(spSite.name)}</div>`
    : "";

  const renderSettingItems = (items) =>
    items
      .map((item) => {
        const reqHtml = lbRenderRequiredByHtml(item.requiredBy);
        return `
        <li class="lb-prereq-card">
          <div class="lb-prereq-card-head">
            <strong>${escapeHtml(item.title || "")}</strong>
            ${item.status ? `<span class="tag">${escapeHtml(item.status)}</span>` : ""}
          </div>
          ${item.adminPath ? `<div class="lb-prereq-path">Admin path: <code>${escapeHtml(item.adminPath)}</code></div>` : ""}
          <p class="lb-prereq-detail">${lbRenderTextWithSafeLinks(item.details || item.detail || "")}</p>
          ${
            reqHtml
              ? `<div class="lb-prereq-card-req">
                  <span class="lb-prereq-card-req-label">Required by:</span>
                  <div class="lb-prereq-card-req-body">${reqHtml}</div>
                </div>`
              : ""
          }
        </li>`;
      })
      .join("");

  const connectorRows = connectors
    .map((c) => {
      const reqHtml = lbRenderRequiredByHtml(c.requiredBy);
      return `
      <tr>
        <td>
          <strong>${escapeHtml(c.name || "")}</strong>
          ${c.endpoints?.length ? `<div class="lb-prereq-path"><code>${escapeHtml(c.endpoints.join(", "))}</code></div>` : ""}
        </td>
        <td><span class="tag">${escapeHtml(c.classification || c.tier || "Standard")}</span></td>
        <td><code>${escapeHtml(c.dataGroup || "Business")}</code></td>
        <td class="lb-prereq-col-req">${reqHtml || '<span class="lb-prereq-req-empty">—</span>'}</td>
        <td>${lbRenderTextWithSafeLinks(c.details || c.purpose || "")}</td>
      </tr>`;
    })
    .join("");

  return `
    <section class="lb-admin-prereqs" aria-labelledby="lb-admin-prereqs-heading">
      <div class="lb-admin-prereqs-header">
        <h4 id="lb-admin-prereqs-heading">🔐 Connectors, Environment, and Tenant Prerequisites</h4>
        <div class="scenario-pill-list">
          <span class="scenario-pill">${connectors.length} connector${connectors.length === 1 ? "" : "s"} to allow</span>
          <span class="scenario-pill">${dlpAndAcp.length} DLP / ACP polic${dlpAndAcp.length === 1 ? "y" : "ies"}</span>
          <span class="scenario-pill">${environmentSettings.length} environment setting${environmentSettings.length === 1 ? "" : "s"}</span>
          <span class="scenario-pill">${tenantAndCloud.length} tenant &amp; cloud prerequisite${tenantAndCloud.length === 1 ? "" : "s"}</span>
        </div>
      </div>
      <p class="lb-admin-prereqs-intro">
        <strong>For the administrator.</strong> These settings are not part of the learner guides. Hand them to your Power Platform, Microsoft Entra, Microsoft 365, and Azure administrators before the workshop so every connector, DLP/ACP rule, environment toggle, and storage allocation is ready. Download the Administrator setup guide or the Prerequisites checklist from <strong>For the administrator</strong> above; the Lab ZIP carries both in its <code>For the administrator</code> folder.
      </p>
      ${spCalloutHtml}

      ${
        connectors.length
          ? `<div class="lb-prereq-group">
              <h5>Connectors to Allow (DLP Allowlist)</h5>
              <div class="lb-prereq-table-wrap" role="region" aria-label="Connectors to allow (scroll sideways to see every column)" tabindex="0">
                <table class="lb-prereq-table">
                  <thead>
                    <tr>
                      <th scope="col">Connector / Endpoint</th>
                      <th scope="col">Tier</th>
                      <th scope="col">DLP Group</th>
                      <th scope="col" class="lb-prereq-col-req">Required By</th>
                      <th scope="col">Scope &amp; Notes</th>
                    </tr>
                  </thead>
                  <tbody>${connectorRows}</tbody>
                </table>
              </div>
            </div>`
          : ""
      }

      ${
        dlpAndAcp.length
          ? `<div class="lb-prereq-group">
              <h5>DLP, Agent Control Plane (ACP), and Channel Policies</h5>
              <ul class="lb-prereq-list">${renderSettingItems(dlpAndAcp)}</ul>
            </div>`
          : ""
      }

      ${
        environmentSettings.length
          ? `<div class="lb-prereq-group">
              <h5>Power Platform Environment and Feature Settings</h5>
              <ul class="lb-prereq-list">${renderSettingItems(environmentSettings)}</ul>
            </div>`
          : ""
      }

      ${
        tenantAndCloud.length
          ? `<div class="lb-prereq-group">
              <h5>Tenant, Identity, and Cloud Admin Prerequisites</h5>
              <ul class="lb-prereq-list">${renderSettingItems(tenantAndCloud)}</ul>
            </div>`
          : ""
      }
    </section>`;
}

function lbFormatDriftTimestamp(isoString) {
  if (!isoString) return "";
  const dt = new Date(isoString);
  if (Number.isNaN(dt.getTime())) return "";
  return dt.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function lbComputeFleetDriftCounts(labs) {
  const counts = {
    total: 0,
    upToDate: 0,
    docsUpdated: 0,
    missingScreenshots: 0,
    notChecked: 0,
    ungrounded: 0,
  };
  for (const lab of Array.isArray(labs) ? labs : []) {
    const status = lbNormalizeLabLearnDrift(lab).status;
    counts.total += 1;
    if (status === "up-to-date") counts.upToDate += 1;
    else if (status === "docs-updated") counts.docsUpdated += 1;
    else if (status === "missing-screenshot") counts.missingScreenshots += 1;
    else if (status === "ungrounded") counts.ungrounded += 1;
    else counts.notChecked += 1;
  }
  return counts;
}

function lbGenRenderDriftDashboard() {
  const dashboard = document.getElementById("lb-gen-drift-dashboard");
  if (!dashboard) return;
  const hasLabs = lbGen.labs.length > 0;
  dashboard.hidden = !hasLabs;
  if (!hasLabs) return;

  const counts = lbComputeFleetDriftCounts(lbGen.labs);
  const uncheckedDisplay = counts.notChecked + counts.ungrounded;

  const setStat = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = String(val);
  };
  setStat("lb-drift-stat-total", counts.total);
  setStat("lb-drift-stat-uptodate", counts.upToDate);
  setStat("lb-drift-stat-drifted", counts.docsUpdated);
  setStat("lb-drift-stat-shots", counts.missingScreenshots);
  setStat("lb-drift-stat-unchecked", uncheckedDisplay);

  const lastScanEl = document.getElementById("lb-gen-drift-last-scan");
  if (lastScanEl) {
    const formatted = lbFormatDriftTimestamp(lbGen.lastBulkScanAt);
    lastScanEl.textContent = formatted ? `Last bulk scan: ${formatted}` : "Last bulk scan: Not run yet";
  }

  const scanBtn = document.getElementById("lb-gen-drift-scan-btn");
  if (scanBtn) {
    scanBtn.disabled = Boolean(lbGen.driftBusy);
    if (lbGen.driftBusy && !lbGen.driftBusyLabId) {
      scanBtn.setAttribute("aria-busy", "true");
      scanBtn.textContent = "⏳ Checking labs against Microsoft Learn...";
    } else {
      scanBtn.removeAttribute("aria-busy");
      scanBtn.textContent = "🔄 Check all labs against Microsoft Learn";
    }
  }

  const updateBtn = document.getElementById("lb-gen-drift-update-btn");
  if (updateBtn) {
    const hasDrifted = counts.docsUpdated > 0;
    updateBtn.hidden = !hasDrifted;
    updateBtn.disabled = Boolean(lbGen.driftBusy) || !hasDrifted;
    if (lbGen.driftBusy && hasDrifted) {
      updateBtn.setAttribute("aria-busy", "true");
    } else {
      updateBtn.removeAttribute("aria-busy");
    }
    updateBtn.textContent = `⚡ Update all labs that changed (${counts.docsUpdated})`;
    updateBtn.setAttribute(
      "aria-label",
      `Update all ${counts.docsUpdated} lab${counts.docsUpdated === 1 ? "" : "s"} that changed on Microsoft Learn`,
    );
  }

  const statusEl = document.getElementById("lb-gen-drift-status");
  if (statusEl) {
    if (lbGen.driftStatusMessage) {
      statusEl.hidden = false;
      statusEl.className = [
        "lb-gen-drift-status",
        lbGen.driftStatusVariant === "ok"
          ? "lb-gen-drift-status-ok"
          : lbGen.driftStatusVariant === "warn"
          ? "lb-gen-drift-status-warn"
          : "",
      ]
        .filter(Boolean)
        .join(" ");
      statusEl.textContent = lbGen.driftStatusMessage;
    } else {
      statusEl.hidden = true;
      statusEl.textContent = "";
    }
  }
}

function lbRenderLabCardDriftHtml(lab, rawTitle) {
  const drift = lbNormalizeLabLearnDrift(lab);
  const safeId = escapeHtml(lab.labId);
  const safeTitle = escapeHtml(rawTitle || "Untitled Lab");
  const checkedText = lbFormatDriftTimestamp(drift.lastCheckedAt);

  let badgeClass = "lb-gen-drift-badge";
  let badgeText = "Not checked against Microsoft Learn yet";
  let ariaText = `Microsoft Learn sync status for ${rawTitle}: not checked yet`;
  let detailHtml = "";
  let quickActionHtml = "";

  if (drift.status === "docs-updated") {
    const count = Math.max(1, Number(drift.driftedModuleCount || 1));
    const topicWord = count === 1 ? "topic" : "topics";
    badgeClass = "lb-gen-drift-badge lb-gen-drift-badge-warn";
    badgeText = `⚠ ${count} ${topicWord} updated on Microsoft Learn`;
    const driftedNames = drift.driftedModules
      .map((m) => String(m?.title || m?.moduleId || "").trim())
      .filter(Boolean);
    const namesSummary = driftedNames.length ? ` (${driftedNames.slice(0, 3).join(", ")}${driftedNames.length > 3 ? ", ..." : ""})` : "";
    ariaText = `Microsoft Learn sync status for ${rawTitle}: ${count} ${topicWord} updated on Microsoft Learn${namesSummary}`;
    if (driftedNames.length) {
      detailHtml = `<span class="lb-gen-drift-detail">Updated: ${escapeHtml(driftedNames.slice(0, 3).join(", "))}${driftedNames.length > 3 ? ` +${driftedNames.length - 3} more` : ""}</span>`;
    }
    const isThisLabBusy = Boolean(lbGen.driftBusy && (!lbGen.driftBusyLabId || lbGen.driftBusyLabId === lab.labId));
    quickActionHtml = `<button type="button" class="btn btn-sm btn-primary lb-gen-quick-drift-btn" data-gen-action="quick-learn-update" data-lab-id="${safeId}" ${
      lbGen.driftBusy ? "disabled" : ""
    }${isThisLabBusy ? ' aria-busy="true"' : ""} aria-label="Update ${safeTitle} from Microsoft Learn">${
      isThisLabBusy && lbGen.driftBusyLabId === lab.labId ? "⏳ Updating..." : "⚡ Update from Microsoft Learn"
    }</button>`;
  } else if (drift.status === "up-to-date") {
    badgeClass = "lb-gen-drift-badge lb-gen-drift-badge-ok";
    badgeText = "✓ Microsoft Learn up to date";
    ariaText = `Microsoft Learn sync status for ${rawTitle}: up to date${checkedText ? `, checked ${checkedText}` : ""}`;
    if (checkedText) {
      detailHtml = `<span class="lb-gen-drift-detail">Checked ${escapeHtml(checkedText)}</span>`;
    }
  } else if (drift.status === "missing-screenshot") {
    const missing = Math.max(1, Number(drift.missingScreenshotCount || 1));
    badgeClass = "lb-gen-drift-badge";
    badgeText = `✓ Microsoft Learn up to date · ${missing} screenshot${missing === 1 ? "" : "s"} pending`;
    ariaText = `Microsoft Learn sync status for ${rawTitle}: documentation up to date, ${missing} screenshot${missing === 1 ? "" : "s"} pending`;
  } else if (drift.status === "ungrounded") {
    badgeClass = "lb-gen-drift-badge";
    badgeText = "No Microsoft Learn sources to check";
    ariaText = `Microsoft Learn sync status for ${rawTitle}: no Microsoft Learn reference URLs recorded`;
  }

  return `
      <div class="lb-gen-drift-row">
        <span class="${badgeClass}" aria-label="${escapeHtml(ariaText)}">${escapeHtml(badgeText)}</span>
        ${detailHtml}
        ${quickActionHtml}
      </div>`;
}

function lbGenItemHtml(lab) {
  const id = escapeHtml(lab.labId);
  const rawTitle = String(lab.title || "Untitled Lab").trim() || "Untitled Lab";
  const title = escapeHtml(lab.title || rawTitle);
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
  const spRowUrl = lbGenSafeExternalUrl(lab.sharepointSite?.url || "");
  const spRowLabel = lab.sharepointSite?.label || lab.sharepointSite?.name || spRowUrl;
  if (spRowUrl) {
    chips.push(`SharePoint: <a href="${escapeHtml(spRowUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(spRowLabel)}</a>`);
  } else if (lab.sharepointSite?.name) {
    chips.push(`SharePoint: ${escapeHtml(lab.sharepointSite.name)}`);
  }
  const chipHtml = chips.map((chip) => `<li>${chip}</li>`).join("");
  let validation = '<li>Checks not recorded</li>';
  if (lab.validation) {
    validation = lab.validation.failed
      ? `<li class="lb-gen-chip-fail">Checks: ${Number(lab.validation.failed)} failed, ${Number(lab.validation.passed)} passed</li>`
      : `<li>Checks: all ${Number(lab.validation.passed)} passed</li>`;
  }
  let screenshotChip = "";
  if (lab.screenshots && Number.isFinite(lab.screenshots.total) && lab.screenshots.total > 0) {
    screenshotChip = `<li>Screenshots: ${Number(lab.screenshots.captured || 0)}/${Number(lab.screenshots.total)} captured</li>`;
  }
  const readyChip = typeof lbChecklistChipHtml === "function" ? lbChecklistChipHtml(lab) : "";
  const driftRowHtml = lbRenderLabCardDriftHtml(lab, rawTitle);
  const editable = Boolean(lab.selections);
  const legacy = editable
    ? ""
    : `<p class="lb-gen-legacy">This lab was built before its choices were saved, so its selections cannot be edited. You can open, export, print, validate, rename, or delete it, or start a new lab in the wizard.</p>`;
  const edit = editable
    ? `<button type="button" class="btn btn-sm" data-gen-action="edit" aria-label="Edit selections for ${title}">Edit selections</button>`
    : `<button type="button" class="btn btn-sm" data-gen-action="new" aria-label="Start a new lab in the wizard">Start a new lab</button>`;
  // The lab shown in the result panel already offers open, export, print, and validate there.
  // Repeating them on its row would show the same buttons twice, so the row only keeps what the panel lacks.
  const isOpen = lbGen.opened === lab.labId;
  const sharedActions = isOpen
    ? `<button type="button" class="btn btn-sm" data-gen-action="close" aria-label="Close the preview of ${title}">Close preview</button>
        ${edit}
        <span class="lb-gen-open-note">Open above. Download, print, and validate are in the lab panel.</span>`
    : `<button type="button" class="btn btn-sm" data-gen-action="open" aria-label="Open ${title}">Open</button>
        ${edit}
        ${lbGeneratedActionButtonsHtml(lab.labId, rawTitle, { scopePrefix: "lb-zip-fmt-item" })}`;
  return `
    <li class="lb-gen-item" data-lab-id="${id}">
      <h4 class="lb-gen-title">${title}</h4>
      <p class="lb-gen-meta">Created <time datetime="${escapeHtml(lab.generatedAt || "")}">${escapeHtml(createdText)}</time>${lab.updatedAt ? " · edited" : ""}</p>
      ${driftRowHtml}
      <ul class="lb-gen-chips" aria-label="Details for ${title}">${chipHtml}${validation}${screenshotChip}${readyChip}</ul>
      ${lab.notes ? `<p class="lb-gen-notes">${escapeHtml(lab.notes)}</p>` : ""}
      ${legacy}
      <div class="lb-gen-actions">
        ${sharedActions}
        ${!isOpen ? `<button type="button" class="btn btn-sm" data-gen-action="screenshots" aria-label="Open the Screenshot Center for ${title}">📸 Screenshots</button>` : ""}
        <button type="button" class="btn btn-sm" data-gen-action="rename" aria-label="Rename ${title}">Rename</button>
        <button type="button" class="btn btn-sm" data-gen-action="delete" aria-label="Delete ${title}">Delete</button>
      </div>
    </li>`;
}

function lbGenSyncBadge() {
  const badge = document.getElementById("lb-gen-badge");
  if (badge) badge.textContent = String(lbGen.labs.length);
}

function lbGenRender(message) {
  const list = document.getElementById("lb-generated-list");
  const toolbar = document.getElementById("lb-gen-toolbar");
  lbGenSyncBadge();
  lbGenRenderDriftDashboard();
  if (!list) return;
  if (toolbar) toolbar.hidden = !lbGen.labs.length;
  if (!lbGen.labs.length) {
    list.className = "scenario-empty";
    list.textContent = "None yet. Build one above and it will appear here.";
    lbGenAnnounce(message || "No generated labs yet.");
    return;
  }
  const visible = lbGenVisible();
  if (!visible.length) {
    list.className = "scenario-empty";
    list.textContent =
      lbGen.driftFilter && lbGen.driftFilter !== "all"
        ? "No generated labs match your search or Microsoft Learn status filter. Reset the filters to see them all."
        : "No generated labs match your search. Clear the search to see them all.";
  } else {
    list.className = "";
    list.innerHTML = `<ul class="lb-gen-list" aria-label="Generated labs">${visible.map(lbGenItemHtml).join("")}</ul>`;
  }
  lbGenAnnounce(message || lbGenCountMessage(visible.length));
}

async function lbLoadFleetDriftMeta() {
  try {
    const res = await fetch("/api/lab-builder/learn-drift");
    if (!res.ok) return;
    const data = await res.json().catch(() => null);
    if (data && typeof data === "object") {
      if (typeof data.lastBulkScanAt === "string" && data.lastBulkScanAt) {
        lbGen.lastBulkScanAt = data.lastBulkScanAt;
      }
      if (Array.isArray(data.labs)) {
        const driftById = new Map(
          data.labs
            .filter((item) => item && typeof item.labId === "string")
            .map((item) => [item.labId, item.learnDrift || item]),
        );
        for (const lab of lbGen.labs) {
          if (driftById.has(lab.labId)) {
            lab.learnDrift = driftById.get(lab.labId);
          }
        }
      }
      lbGenRenderDriftDashboard();
    }
  } catch {
    /* Optional metadata hydration; list already includes per-lab learnDrift */
  }
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
    void lbLoadFleetDriftMeta();
  } catch (err) {
    const toolbar = document.getElementById("lb-gen-toolbar");
    if (toolbar) toolbar.hidden = true;
    const dashboard = document.getElementById("lb-gen-drift-dashboard");
    if (dashboard) dashboard.hidden = true;
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

/** Downloading or printing a lab counts toward its "Finish your lab" checklist. */
function lbChecklistShared(labId) {
  if (typeof lbChecklistMarkShared === "function") lbChecklistMarkShared(labId);
}

// ── Open ────────────────────────────────────────────────────────────────────
async function lbOpenGenerated(labId) {
  const lab = lbGenFind(labId);
  const panel = document.getElementById("lb-result-panel");
  const meta = document.getElementById("lb-result-meta");
  const body = document.getElementById("lb-result-body");
  if (!lab || !panel || !meta || !body) return;
  lbGen.opened = labId;
  lbGenRender(`Opened "${lab.title}".`);
  const spOpenUrl = lbGenSafeExternalUrl(lab.sharepointSite?.url || "");
  const spOpenLabel = lab.sharepointSite?.label || lab.sharepointSite?.name || spOpenUrl;
  const spOpenPill = spOpenUrl
    ? `<span class="scenario-pill">SharePoint site: <a href="${escapeHtml(spOpenUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(spOpenLabel)}</a></span>`
    : lab.sharepointSite?.name
    ? `<span class="scenario-pill">SharePoint site: ${escapeHtml(lab.sharepointSite.name)}</span>`
    : "";
  const labTitle = String(lab.title || "Generated Lab").trim() || "Generated Lab";
  meta.innerHTML = `
    <div class="lb-result-header-block">
      <h4 class="lb-result-title">${escapeHtml(labTitle)}</h4>
      <div class="scenario-pill-list">
        ${lab.difficulty ? `<span class="scenario-pill">${escapeHtml(lab.difficulty)}</span>` : ""}
        <span class="scenario-pill">About ${escapeHtml(lbFormatMinutes(lab.totalMinutes || 0))}</span>
        <span class="scenario-pill">${Number(lab.moduleCount) || 0} topics</span>
        ${spOpenPill}
      </div>
      ${lab.notes ? `<p class="lb-gen-notes" style="margin-top: 10px;">${escapeHtml(lab.notes)}</p>` : ""}
    </div>
    <div class="lb-result-actions">
      ${lbGeneratedActionButtonsHtml(lab.labId, labTitle)}
    </div>`;
  body.innerHTML = `
    <div id="lb-result-checklist"></div>
    <div id="lb-result-validation" role="region" aria-label="Generated lab validation results" aria-live="polite"></div>
    <div id="lb-result-topic-docs"></div>
    <div id="lb-result-screenshots"></div>
    <div id="lb-result-preview" class="preview-frame" aria-label="Lab preview"><p class="scenario-empty">Loading the preview...</p></div>
    <div id="lb-result-admin-prereqs"></div>
    <details class="lb-advanced">
      <summary>View the Markdown source</summary>
      <pre id="lb-result-source" style="white-space: pre-wrap; font-size: 12px; line-height: 1.6;"></pre>
    </details>`;
  panel.style.display = "";
  panel.scrollIntoView({ behavior: "smooth", block: "start" });
  document.getElementById("lb-result-heading")?.focus({ preventScroll: true });
  if (typeof lbRenderLabChecklist === "function") lbRenderLabChecklist(labId);
  if (typeof lbRenderLabCustomizeSection === "function") lbRenderLabCustomizeSection(labId);
  await lbLoadResultPreview(labId);
}

async function lbDownloadGeneratedHtml(labId) {
  if (!labId) return;
  try {
    const res = await fetch(`/api/lab-builder/generated/${encodeURIComponent(labId)}/export?format=html`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Download failed (${res.status})`);
    }
    const htmlContent = await res.text();
    const labTitle = lbResolveDisplayLabTitle(labId);
    const fileBase = lbSanitizeFileBase(labTitle, labId);
    const blob = new Blob([htmlContent], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${fileBase}.html`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    toast(`Downloaded Interactive Web Lab for "${labTitle}"`, "success");
  } catch (err) {
    toast(`Could not download HTML: ${err.message}`, "error");
  }
}

async function lbExportGeneratedZip(labId, triggerEl) {
  if (!labId) return;
  const scope = triggerEl?.closest?.(".lb-export-zip-group, .lb-result-actions, .lb-gen-actions, .lb-gen-item");
  const select =
    scope?.querySelector?.("[data-zip-format-select]") ||
    document.querySelector(`[data-zip-format-select][data-lab-id="${CSS.escape(labId)}"]`);
  const formats = String(select?.value || "all").trim().toLowerCase() || "all";
  try {
    const res = await fetch(
      `/api/lab-builder/generated/${encodeURIComponent(labId)}/export?format=zip&formats=${encodeURIComponent(formats)}`,
    );
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Export failed (${res.status})`);
    }
    const labTitle = lbResolveDisplayLabTitle(labId);
    const fileBase = lbSanitizeFileBase(labTitle, labId);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const suffix = formats !== "all" ? `-${formats}` : "";
    const fileName = `${fileBase}${suffix}.zip`;
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    toast(`Downloaded Complete Lab Package for "${labTitle}"`, "success");
  } catch (err) {
    toast(`Could not export ZIP: ${err.message}`, "error");
  }
}

// ── Prerequisites checklist and Administrator setup guide ───────────────────
// Both are for the administrator. They share one preview dialog.
const LB_PREREQ_FORMATS = ["docx", "pdf", "html", "md"];
const lbPrereq = { labId: null, format: "docx", kind: "checklist", trigger: null };

function lbPrereqFormatFor(triggerEl) {
  const select = triggerEl?.closest?.(".lb-prereq-group")?.querySelector?.("[data-prereq-format-select]");
  const value = String(select?.value || "docx").toLowerCase();
  return LB_PREREQ_FORMATS.includes(value) ? value : "docx";
}

function lbAdminGuideFormatFor(triggerEl) {
  const select = triggerEl?.closest?.(".lb-admin-guide-group")?.querySelector?.("[data-admin-guide-format-select]");
  const value = String(select?.value || "docx").toLowerCase();
  return LB_PREREQ_FORMATS.includes(value) ? value : "docx";
}

/** Download the prerequisites checklist (Word, PDF, web page, or Markdown) with no other lab content. */
async function lbDownloadPrerequisites(labId, format = "docx") {
  if (!labId) return;
  const kind = LB_PREREQ_FORMATS.includes(format) ? format : "docx";
  try {
    const res = await fetch(`/api/lab-builder/generated/${encodeURIComponent(labId)}/export?format=prerequisites-${kind}`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Download failed (${res.status})`);
    }
    const blob = await res.blob();
    const labTitle = lbResolveDisplayLabTitle(labId);
    lbDownloadText(`${lbSanitizeFileBase(labTitle, labId)} - Prerequisites checklist.${kind}`, blob, blob.type || "application/octet-stream");
    toast(`Downloaded the prerequisites checklist for "${labTitle}"`, "success");
  } catch (err) {
    toast(`Could not download the prerequisites checklist: ${err.message}`, "error");
  }
}

/** Download the Administrator setup guide (Word, PDF, web page, or Markdown): admin settings only. */
async function lbDownloadAdminGuide(labId, format = "docx") {
  if (!labId) return;
  const kind = LB_PREREQ_FORMATS.includes(format) ? format : "docx";
  try {
    const res = await fetch(`/api/lab-builder/generated/${encodeURIComponent(labId)}/export?format=admin-guide-${kind}`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Download failed (${res.status})`);
    }
    const blob = await res.blob();
    const labTitle = lbResolveDisplayLabTitle(labId);
    lbDownloadText(`${lbSanitizeFileBase(labTitle, labId)} - Administrator setup guide.${kind}`, blob, blob.type || "application/octet-stream");
    toast(`Downloaded the administrator setup guide for "${labTitle}"`, "success");
  } catch (err) {
    toast(`Could not download the administrator setup guide: ${err.message}`, "error");
  }
}

/** Show the document in a dialog before it is sent: the customer's checklist, or the administrator's guide. */
async function lbOpenAdminPreview(kind, labId, triggerEl) {
  const dialog = document.getElementById("lb-prereq-preview-dialog");
  if (!labId || !dialog) return;
  const isGuide = kind === "admin-guide";
  const frame = document.getElementById("lb-prereq-preview-frame");
  const desc = document.getElementById("lb-prereq-preview-desc");
  const error = document.getElementById("lb-prereq-preview-error");
  const heading = document.getElementById("lb-prereq-preview-title");
  const download = document.getElementById("lb-prereq-preview-download");
  lbPrereq.labId = labId;
  lbPrereq.kind = isGuide ? "admin-guide" : "checklist";
  lbPrereq.format = isGuide ? lbAdminGuideFormatFor(triggerEl) : lbPrereqFormatFor(triggerEl);
  lbPrereq.trigger = triggerEl || null;
  if (heading) heading.textContent = isGuide ? "Administrator setup guide preview" : "Prerequisites checklist preview";
  if (download) download.textContent = isGuide ? "Download administrator setup guide" : "Download prerequisites checklist";
  if (frame) frame.title = isGuide ? "Preview of the administrator setup guide" : "Preview of the prerequisites checklist";
  error.textContent = "";
  desc.textContent = "Loading the preview...";
  frame.srcdoc = "";
  if (!dialog.open) dialog.showModal();
  document.getElementById("lb-prereq-preview-close")?.focus();
  try {
    const res = await fetch(`/api/lab-builder/generated/${encodeURIComponent(labId)}/${isGuide ? "admin-guide" : "prerequisites"}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    const items = `${Number(data.itemCount) || 0} item${Number(data.itemCount) === 1 ? "" : "s"} across ${(data.roles || []).length} role${(data.roles || []).length === 1 ? "" : "s"}`;
    desc.textContent = isGuide
      ? `This is the administrator's copy: ${items}. Admin settings only. It is not part of the learner guides.`
      : `This is what the customer gets: ${items}, and nothing else from the lab.`;
    frame.srcdoc = String(data.html || "");
  } catch (err) {
    desc.textContent = "";
    error.textContent = `Could not load the preview: ${err.message}`;
  }
}

/** Show exactly what the customer will receive, in a dialog, before it is sent. */
function lbPreviewPrerequisites(labId, triggerEl) {
  return lbOpenAdminPreview("checklist", labId, triggerEl);
}

/** Show the Administrator setup guide in a dialog before it is handed over. */
function lbPreviewAdminGuide(labId, triggerEl) {
  return lbOpenAdminPreview("admin-guide", labId, triggerEl);
}

async function lbPrintGenerated(labId) {
  if (!labId) return;
  const preview = document.getElementById("lb-result-preview");
  const panel = document.getElementById("lb-result-panel");
  const needsLoad =
    lbGen.opened !== labId ||
    !panel ||
    panel.style.display === "none" ||
    !preview ||
    Boolean(preview.querySelector(".scenario-empty"));
  if (needsLoad) {
    if (lbGenFind(labId)) {
      await lbOpenGenerated(labId);
    } else {
      await lbLoadResultPreview(labId);
    }
  }
  const closedPrereqDetails = [
    ...(document.querySelectorAll?.(".lb-admin-prereqs details.lb-prereq-req-more:not([open])") || []),
  ];
  closedPrereqDetails.forEach((el) => {
    el.open = true;
  });
  document.body.dataset.printTarget = "generated";
  const cleanup = () => {
    delete document.body.dataset.printTarget;
    closedPrereqDetails.forEach((el) => {
      el.open = false;
    });
  };
  window.addEventListener("afterprint", cleanup, { once: true });
  setTimeout(cleanup, 2000);
  window.print();
}

const LB_GATE_BADGE = { ready: "tag tag-success", almost: "tag tag-warning", "needs-work": "tag tag-warning", "not-ready": "tag tag-danger" };
const LB_GATE_SEVERITY = { gap: "Fix", polish: "Polish", note: "Note" };

// The lab gate report: what a teacher would trip over, in plain language. Notes stay folded away.
function lbRenderLabHealthHtml(health) {
  if (!health || !health.grade) return "";
  const important = (health.findings || []).filter((item) => item.severity !== "note");
  const notes = (health.findings || []).filter((item) => item.severity === "note");
  const row = (item) =>
    `<li><strong>${escapeHtml(LB_GATE_SEVERITY[item.severity] || item.severity)}.</strong> ${escapeHtml(item.message)} <span class="lb-learn-status">${escapeHtml(item.fix || "")}</span></li>`;
  const shown = important.slice(0, 10).map(row).join("");
  const more = important.length > 10 ? `<li>${important.length - 10} more items. Run <code>npm run lab-gate</code> for the full list.</li>` : "";
  const noteList = notes.length
    ? `<details style="margin-top: 8px;"><summary>${notes.length} passage${notes.length === 1 ? " is" : "s are"} flagged as not confirmed</summary><ul style="padding-left: 20px;">${notes.map(row).join("")}</ul></details>`
    : "";
  return `
    <section class="lb-lab-health" aria-label="Lab health" style="margin-bottom: 16px;">
      <p style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 0 0 6px;">
        <span class="${LB_GATE_BADGE[health.grade] || "tag"}">Lab health: ${escapeHtml(health.label || health.grade)}</span>
        <span style="font-size: 13px; color: var(--text-muted);">${escapeHtml(health.summary || "")}</span>
      </p>
      ${important.length ? `<ul style="margin: 6px 0 0; padding-left: 20px; font-size: 13px; line-height: 1.65;">${shown}${more}</ul>` : ""}
      ${noteList}
    </section>`;
}

function lbRenderGeneratedValidationHtml(report) {
  const failed = Number(report.failed) || 0;
  const warnings = Number(report.warnings) || 0;
  const passed = Number(report.passed) || 0;
  const total = Number(report.total) || 0;
  const badgeClass = failed ? "tag tag-danger" : warnings ? "tag tag-warning" : "tag tag-success";
  const summaryLabel = failed
    ? `${failed} failed, ${passed}/${total} passed`
    : warnings
    ? `All ${passed}/${total} passed (${warnings} warning${warnings === 1 ? "" : "s"})`
    : `All ${passed}/${total} structural checks passed`;
  const rows = (report.tests || [])
    .map((item) => {
      const icon = item.status === "fail" ? "❌" : item.status === "warn" ? "⚠️" : "✅";
      return `<li>${icon} <code>${escapeHtml(item.name)}</code> — ${escapeHtml(item.message || "")}</li>`;
    })
    .join("");
  return `${lbRenderLabHealthHtml(report.health)}
    <details class="lb-advanced" style="margin-bottom: 16px;" ${failed || warnings ? "open" : ""}>
      <summary style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
        <span class="${badgeClass}">${escapeHtml(summaryLabel)}</span>
        <span style="font-size: 13px; color: var(--text-muted);">Validated ${escapeHtml(report.title || report.labId)}</span>
      </summary>
      <ul style="margin-top: 10px; padding-left: 20px; font-size: 13px; line-height: 1.65;">${rows}</ul>
    </details>`;
}

function lbRenderChecklistHtml(list) {
  const total = Number(list?.counts?.missing) || 0;
  if (!total) {
    return `<div class="lb-checklist"><p class="lb-checklist-done">Nothing is left. Every picture in this lab is a real screenshot.</p></div>`;
  }
  const item = (entry, withSteps) => {
    const name = `${entry.figure ? `Figure ${escapeHtml(entry.figure)}: ` : ""}${escapeHtml(entry.caption || entry.filename)}`;
    if (!withSteps) return `<li>${name} <code>${escapeHtml(entry.filename)}</code></li>`;
    const steps = (entry.steps || []).map((step) => `<li>${escapeHtml(step)}</li>`).join("");
    return `<li><details><summary>${name}</summary>
      ${entry.shows ? `<p><strong>It should show:</strong> ${escapeHtml(entry.shows)}</p>` : ""}
      ${entry.why ? `<p><strong>Why it needs you:</strong> ${escapeHtml(entry.why)}</p>` : ""}
      ${steps ? `<ol>${steps}</ol>` : ""}
      <p class="lb-checklist-file">File: <code>${escapeHtml(entry.filename)}</code></p></details></li>`;
  };
  const you = (list.you || []).map((entry) => item(entry, true)).join("");
  const computer = (list.computer || []).map((entry) => item(entry, false)).join("");
  return `<div class="lb-checklist">
    <p class="lb-checklist-lead"><strong>${total} picture${total === 1 ? "" : "s"} still to capture.</strong> ${list.counts.computer ? `Your computer can capture ${list.counts.computer} of them. ` : ""}${list.counts.you ? `${list.counts.you} need${list.counts.you === 1 ? "s" : ""} you.` : ""}</p>
    <div class="lb-checklist-actions">
      <button type="button" class="btn btn-sm" data-gen-action="shot-checklist-download" data-lab-id="${escapeHtml(list.labId)}">Download checklist (.md)</button>
      <button type="button" class="btn btn-sm" data-gen-action="screenshots" data-lab-id="${escapeHtml(list.labId)}">📸 Open the Screenshot Center</button>
    </div>
    ${you ? `<h4>Only you can do these (${list.counts.you})</h4><ul class="lb-checklist-list">${you}</ul>` : ""}
    ${computer ? `<h4>Your computer will capture these (${list.counts.computer})</h4><ul class="lb-checklist-list">${computer}</ul>` : ""}
  </div>`;
}

async function lbShowScreenshotChecklist(labId) {
  if (!labId) return;
  const panel = document.getElementById("lb-result-panel");
  if ((lbGen.opened !== labId || !panel || panel.style.display === "none") && lbGenFind(labId)) {
    await lbOpenGenerated(labId);
  }
  const host = document.getElementById("lb-result-validation");
  if (host) host.innerHTML = '<p class="lb-learn-status">Checking which screenshots are left...</p>';
  try {
    const res = await fetch(`/api/lab-builder/generated/${encodeURIComponent(labId)}/screenshots/checklist`);
    const list = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(list.error || `Checklist failed (${res.status})`);
    lbGen.checklist = { labId, markdown: list.markdown || "" };
    if (host) {
      host.innerHTML = lbRenderChecklistHtml(list);
      host.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  } catch (err) {
    if (host) host.innerHTML = `<p class="lb-error" role="alert">Could not build the checklist: ${escapeHtml(err.message)}</p>`;
  }
}

function lbDownloadScreenshotChecklist(labId) {
  const markdown = lbGen.checklist?.labId === labId ? lbGen.checklist.markdown : "";
  if (!markdown) return;
  const fileBase = lbSanitizeFileBase(lbResolveDisplayLabTitle(labId), labId);
  const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${fileBase} - screenshot checklist.md`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function lbValidateGenerated(labId) {
  if (!labId) return;
  const panel = document.getElementById("lb-result-panel");
  if ((lbGen.opened !== labId || !panel || panel.style.display === "none") && lbGenFind(labId)) {
    await lbOpenGenerated(labId);
  }
  const host = document.getElementById("lb-result-validation");
  if (host) {
    host.innerHTML = '<p class="lb-learn-status">Running structural validation checks...</p>';
  }
  try {
    const res = await fetch(`/api/lab-builder/generated/${encodeURIComponent(labId)}/validate`);
    const report = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(report.error || `Validation failed (${res.status})`);
    if (host) {
      host.innerHTML = lbRenderGeneratedValidationHtml(report);
      host.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    const existing = lbGenFind(labId);
    if (existing) {
      existing.validation = {
        status: report.failed ? "failed" : "passed",
        passed: report.passed,
        failed: report.failed,
        checkedAt: report.timestamp || new Date().toISOString(),
      };
      lbGenRender();
    }
    toast(
      report.failed
        ? `Validation found ${report.failed} issue${report.failed === 1 ? "" : "s"} in ${labId}`
        : `All ${report.passed} checks passed for ${labId}`,
      report.failed ? "error" : "success",
    );
  } catch (err) {
    if (host) {
      host.innerHTML = `<p class="lb-error" role="alert">Could not validate lab: ${escapeHtml(err.message)}</p>`;
    }
    toast(`Validation error: ${err.message}`, "error");
  }
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
    `This permanently removes "${lab.title}" and its associated files. It cannot be undone. Hand-written labs are not affected.`;
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
  const root = document.getElementById("panel-labbuilder");
  if (!root) return;
  lbGen.bound = true;
  root.addEventListener("click", (event) => {
    const driftBtn = event.target.closest("[data-drift-action]");
    if (driftBtn) {
      const action = driftBtn.dataset.driftAction;
      if (action === "scan-all") {
        lbScanFleetLearnDrift({ autoUpdate: false });
      } else if (action === "update-drifted") {
        const driftedIds = lbGen.labs
          .filter((lab) => lbNormalizeLabLearnDrift(lab).status === "docs-updated")
          .map((lab) => lab.labId);
        if (driftedIds.length) {
          lbScanFleetLearnDrift({ labIds: driftedIds, autoUpdate: true });
        }
      }
      return;
    }
    const button = event.target.closest("[data-gen-action]");
    if (!button) return;
    if (button.tagName === "A") event.preventDefault();
    const labId = button.closest("[data-lab-id]")?.dataset.labId || button.dataset.labId;
    switch (button.dataset.genAction) {
      case "open": lbOpenGenerated(labId); break;
      case "screenshots": lbOpenGeneratedScreenshots(labId); break;
      case "quick-learn-update": lbQuickUpdateLabFromLearn(labId); break;
      case "close":
        lbGenCloseOpened(labId);
        lbGenRender(`Closed the preview.`);
        lbGenFocusAction(labId, "open");
        break;
      case "edit": lbEditGenerated(labId); break;
      case "export-zip": lbExportGeneratedZip(labId, button); lbChecklistShared(labId); break;
      case "export-html": lbDownloadGeneratedHtml(labId); lbChecklistShared(labId); break;
      case "export-prereqs": lbDownloadPrerequisites(labId, lbPrereqFormatFor(button)); break;
      case "preview-prereqs": lbPreviewPrerequisites(labId, button); break;
      case "export-admin-guide": lbDownloadAdminGuide(labId, lbAdminGuideFormatFor(button)); break;
      case "preview-admin-guide": lbPreviewAdminGuide(labId, button); break;
      case "download": lbDownload(labId); lbChecklistShared(labId); break;
      case "print": lbPrintGenerated(labId); lbChecklistShared(labId); break;
      case "validate": lbValidateGenerated(labId); break;
      case "shot-checklist": lbShowScreenshotChecklist(labId); break;
      case "shot-checklist-download": lbDownloadScreenshotChecklist(labId); break;
      case "rename": lbGenAskRename(labId); break;
      case "delete": lbGenAskDelete(labId); break;
      case "retry": lbLoadGenerated(); break;
      case "new": lbStartNewLab(); break;
    }
  });
  document.getElementById("lb-gen-search")?.addEventListener("input", (event) => {
    lbGen.query = event.target.value;
    lbGenRender();
  });
  document.getElementById("lb-gen-drift-filter")?.addEventListener("change", (event) => {
    lbGen.driftFilter = event.target.value || "all";
    const selectedLabel = event.target.selectedOptions?.[0]?.textContent || lbGen.driftFilter;
    lbGenRender(`Filtered by Microsoft Learn status: ${selectedLabel}.`);
  });
  document.getElementById("lb-gen-sort")?.addEventListener("change", (event) => {
    lbGen.sort = event.target.value;
    lbGenRender(`Sorted: ${event.target.selectedOptions[0].textContent}.`);
  });
  document.getElementById("lb-prereq-preview-close")?.addEventListener("click", () => document.getElementById("lb-prereq-preview-dialog").close());
  document.getElementById("lb-prereq-preview-download")?.addEventListener("click", () =>
    lbPrereq.kind === "admin-guide" ? lbDownloadAdminGuide(lbPrereq.labId, lbPrereq.format) : lbDownloadPrerequisites(lbPrereq.labId, lbPrereq.format),
  );
  // Closing with Esc skips the Close button, so focus returns to the button that opened the preview either way.
  document.getElementById("lb-prereq-preview-dialog")?.addEventListener("close", () => {
    document.getElementById("lb-prereq-preview-frame").srcdoc = "";
    lbPrereq.trigger?.focus?.();
    lbPrereq.trigger = null;
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
  let autoSetPrintTarget = false;
  window.addEventListener("beforeprint", () => {
    if (document.body.dataset.printTarget) return;
    const builderActive = document.getElementById("panel-labbuilder")?.classList.contains("active");
    const resultPanel = document.getElementById("lb-result-panel");
    if (builderActive && resultPanel && resultPanel.style.display !== "none") {
      document.body.dataset.printTarget = "generated";
      autoSetPrintTarget = true;
    }
  });
  window.addEventListener("afterprint", () => {
    if (autoSetPrintTarget) {
      delete document.body.dataset.printTarget;
      autoSetPrintTarget = false;
    }
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

// ── Screenshot Center ───────────────────────────────────────────────────────
// The panel itself lives in screenshot-center.js (rendering), screenshot-center-jobs.js
// (network), and screenshot-center-core.js (decisions). These are the entry points the
// rest of the page calls.

function lbRenderLabScreenshotsPanel(host, labId, state, lastOutcome = null) {
  if (typeof scRenderCenter === "function") scRenderCenter(host, labId, state, lastOutcome);
}

async function lbRefreshLabScreenshotsPanel(labId, lastOutcome = null) {
  if (!labId) return;
  const host = document.getElementById("lb-result-screenshots");
  if (!host) return;
  try {
    const res = await fetch(`/api/lab-builder/generated/${encodeURIComponent(labId)}/screenshots`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    lbRenderLabScreenshotsPanel(host, labId, data, lastOutcome);
  } catch (err) {
    host.replaceChildren();
    const p = document.createElement("p");
    p.className = "lb-error";
    p.setAttribute("role", "alert");
    p.textContent = `Could not load screenshot status: ${err.message}`;
    host.appendChild(p);
  }
}

async function lbOpenGeneratedScreenshots(labId) {
  await lbOpenGenerated(labId);
  document.getElementById("lb-result-screenshots")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function lbSyncSingleLabDriftFromState(labId, state, revalData = null) {
  const lab = lbGenFind(labId);
  if (!lab || !state || typeof state !== "object") return;
  const summary = state.summary || {};
  const modules = Array.isArray(state.modules) ? state.modules : [];
  const driftedModules = modules
    .filter((m) => (m?.status || m?.learnStatus) === "docs-updated")
    .map((m) => ({
      moduleId: String(m.featureId || ""),
      title: String(m.moduleTitle || m.title || m.featureId || ""),
      learnUrl: m.primaryUrl || (Array.isArray(m.urls) ? m.urls[0] : null) || null,
    }));
  const missingScreenshotCount = Math.max(0, Number(summary.missing || 0));
  const rawSync = summary.learnSyncStatus || revalData?.overallStatus || "up-to-date";
  // A lab nobody has checked against Microsoft Learn is "not-checked", never "up-to-date".
  const checkState = state.checkState || summary.checkState || revalData?.checkState || (state.lastRevalidatedAt ? "up-to-date" : "not-checked");
  let status = "up-to-date";
  if (driftedModules.length > 0 || rawSync === "docs-updated" || checkState === "docs-updated") status = "docs-updated";
  else if (rawSync === "ungrounded") status = "ungrounded";
  else if (checkState === "not-checked" || rawSync === "not-checked") status = "not-checked";
  else if (missingScreenshotCount > 0 || rawSync === "missing-screenshot") status = "missing-screenshot";

  lab.learnDrift = {
    status,
    lastCheckedAt:
      state.lastRevalidatedAt || revalData?.checkedAt || (status === "not-checked" ? null : lab.learnDrift?.lastCheckedAt || new Date().toISOString()),
    driftedModuleCount: driftedModules.length > 0 ? driftedModules.length : status === "docs-updated" ? Math.max(1, Number(summary.stale || 1)) : 0,
    driftedModules,
    missingScreenshotCount,
    moduleCount: modules.length || Number(lab.moduleCount || 0),
  };
  if (lab.screenshots) {
    lab.screenshots = {
      ...lab.screenshots,
      total: Number(summary.total ?? lab.screenshots.total ?? 0),
      captured: Number(summary.captured ?? lab.screenshots.captured ?? 0),
      pending: missingScreenshotCount,
      stale: Number(summary.stale ?? 0),
      learnSyncStatus: status,
      checkState,
      lastRevalidatedAt: state.lastRevalidatedAt || null,
    };
  }
  lbGenRender();
}

async function lbScanFleetLearnDrift({ labIds = null, autoUpdate = false } = {}) {
  if (lbGen.driftBusy) return;
  const targetCount = Array.isArray(labIds) ? labIds.length : lbGen.labs.length;
  if (!targetCount) return;

  lbGen.driftBusy = true;
  lbGen.driftBusyLabId = Array.isArray(labIds) && labIds.length === 1 ? labIds[0] : null;
  lbGen.driftStatusVariant = "";
  lbGen.driftStatusMessage = autoUpdate
    ? targetCount === 1
      ? `Updating "${lbGenFind(labIds[0])?.title || labIds[0]}" from Microsoft Learn...`
      : `Updating ${targetCount} drifted labs from Microsoft Learn...`
    : `Scanning ${targetCount} saved lab${targetCount === 1 ? "" : "s"} against live Microsoft Learn documentation...`;
  lbGenRender();

  try {
    const payload = {
      autoUpdate: Boolean(autoUpdate),
      bypassCache: true,
    };
    if (Array.isArray(labIds)) payload.labIds = labIds;

    const res = await fetch("/api/lab-builder/learn-drift/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Bulk scan failed (${res.status})`);

    if (typeof data.scannedAt === "string" && data.scannedAt) {
      lbGen.lastBulkScanAt = data.scannedAt;
    } else if (typeof data.fleet?.lastBulkScanAt === "string" && data.fleet.lastBulkScanAt) {
      lbGen.lastBulkScanAt = data.fleet.lastBulkScanAt;
    }

    const driftById = new Map();
    for (const item of data.fleet?.labs || []) {
      if (item?.labId) driftById.set(item.labId, item.learnDrift || item);
    }
    for (const resItem of data.results || []) {
      if (resItem?.labId && resItem.learnDrift) driftById.set(resItem.labId, resItem.learnDrift);
    }
    for (const lab of lbGen.labs) {
      if (driftById.has(lab.labId)) {
        lab.learnDrift = driftById.get(lab.labId);
      }
    }

    try {
      const listRes = await fetch("/api/lab-builder/generated");
      const listData = await listRes.json().catch(() => null);
      if (listRes.ok && Array.isArray(listData?.labs)) {
        lbGen.labs = listData.labs;
      }
    } catch {
      /* In-memory drift state is already updated above */
    }

    const scannedCount = Number(data.scannedCount || 0);
    const updatedCount = Number(data.updatedCount || 0);
    const errorCount = Number(data.errorCount || 0);
    const driftedRemaining = lbComputeFleetDriftCounts(lbGen.labs).docsUpdated;

    let msg = "";
    let variant = "ok";
    if (autoUpdate) {
      msg =
        targetCount === 1 && Array.isArray(labIds)
          ? `Updated "${lbGenFind(labIds[0])?.title || labIds[0]}" steps, HTML, and topic documents from Microsoft Learn.`
          : `Updated ${updatedCount} lab${updatedCount === 1 ? "" : "s"} (steps, HTML, and per-topic Word/PowerPoint files) from Microsoft Learn.`;
      if (errorCount > 0) {
        variant = "warn";
        msg += ` ${errorCount} lab${errorCount === 1 ? "" : "s"} could not be reached.`;
      }
    } else if (driftedRemaining > 0 || errorCount > 0) {
      variant = "warn";
      msg = `Scanned ${scannedCount} lab${scannedCount === 1 ? "" : "s"}: ${driftedRemaining} need${
        driftedRemaining === 1 ? "s" : ""
      } a Microsoft Learn update.`;
      if (errorCount > 0) {
        msg += ` ${errorCount} lab${errorCount === 1 ? "" : "s"} failed to check.`;
      }
    } else {
      msg = `Scanned ${scannedCount} lab${scannedCount === 1 ? "" : "s"} — all grounded topics match live Microsoft Learn documentation.`;
    }

    lbGen.driftStatusVariant = variant;
    lbGen.driftStatusMessage = msg;

    if (
      autoUpdate &&
      lbGen.opened &&
      (!Array.isArray(labIds) || labIds.includes(lbGen.opened)) &&
      typeof lbLoadResultPreview === "function"
    ) {
      await lbLoadResultPreview(lbGen.opened);
    }

    toast(msg, variant === "warn" ? "info" : "success");
  } catch (err) {
    lbGen.driftStatusVariant = "warn";
    lbGen.driftStatusMessage = `Microsoft Learn bulk scan failed: ${err.message}`;
    toast(`Microsoft Learn check failed: ${err.message}`, "error");
  } finally {
    lbGen.driftBusy = false;
    lbGen.driftBusyLabId = null;
    lbGenRender();
  }
}

async function lbQuickUpdateLabFromLearn(labId) {
  if (!labId) return;
  await lbScanFleetLearnDrift({ labIds: [labId], autoUpdate: true });
}
