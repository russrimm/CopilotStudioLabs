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
  let status = "not-checked";
  if (rawStatus === "docs-updated" || stale > 0) status = "docs-updated";
  else if (rawStatus === "ungrounded") status = "ungrounded";
  else if (rawStatus === "missing-screenshot") status = "missing-screenshot";
  else if (rawStatus === "up-to-date") status = pending > 0 ? "missing-screenshot" : "up-to-date";
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
      <button type="button" class="btn btn-sm btn-primary" data-gen-action="export-zip" data-lab-id="${safeId}" aria-label="Download Complete Lab Package (.zip) for ${safeTitle}">📦 Complete Lab Package (.zip)</button>
    </span>`;
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
    <div class="lb-result-utility-actions" role="group" aria-label="Lab tools for ${safeTitle}">
      <button type="button" class="btn btn-sm" data-gen-action="print" data-lab-id="${safeId}" aria-label="Print or save ${safeTitle} as PDF">🖨️ Print</button>
      <button type="button" class="btn btn-sm" data-gen-action="validate" data-lab-id="${safeId}" aria-label="Validate ${safeTitle}">🧪 Validate</button>
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
        Share this checklist with your Power Platform, Microsoft Entra, Microsoft 365, and Azure administrators before running the workshop so every connector, DLP/ACP rule, environment toggle, and storage allocation is ready. It is also included inside the lab guide and packaged in <code>00 - Overview and Admin Prerequisites</code> when you export the Lab ZIP.
      </p>
      ${spCalloutHtml}

      ${
        connectors.length
          ? `<div class="lb-prereq-group">
              <h5>Connectors to Allow (DLP Allowlist)</h5>
              <div class="lb-prereq-table-wrap">
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
      scanBtn.textContent = "⏳ Scanning labs against MS Learn...";
    } else {
      scanBtn.removeAttribute("aria-busy");
      scanBtn.textContent = "🔄 Scan all labs against MS Learn";
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
    updateBtn.textContent = `⚡ Update all drifted labs (${counts.docsUpdated})`;
    updateBtn.setAttribute(
      "aria-label",
      `Update all ${counts.docsUpdated} drifted lab${counts.docsUpdated === 1 ? "" : "s"} from Microsoft Learn`,
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
  let badgeText = "MS Learn not re-checked";
  let ariaText = `Microsoft Learn sync status for ${rawTitle}: not re-checked since generation`;
  let detailHtml = "";
  let quickActionHtml = "";

  if (drift.status === "docs-updated") {
    const count = Math.max(1, Number(drift.driftedModuleCount || 1));
    const topicWord = count === 1 ? "topic" : "topics";
    badgeClass = "lb-gen-drift-badge lb-gen-drift-badge-warn";
    badgeText = `⚠ ${count} ${topicWord} updated on MS Learn`;
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
      isThisLabBusy && lbGen.driftBusyLabId === lab.labId ? "⏳ Updating..." : "⚡ Update from MS Learn"
    }</button>`;
  } else if (drift.status === "up-to-date") {
    badgeClass = "lb-gen-drift-badge lb-gen-drift-badge-ok";
    badgeText = "✓ MS Learn up to date";
    ariaText = `Microsoft Learn sync status for ${rawTitle}: up to date${checkedText ? `, checked ${checkedText}` : ""}`;
    if (checkedText) {
      detailHtml = `<span class="lb-gen-drift-detail">Checked ${escapeHtml(checkedText)}</span>`;
    }
  } else if (drift.status === "missing-screenshot") {
    const missing = Math.max(1, Number(drift.missingScreenshotCount || 1));
    badgeClass = "lb-gen-drift-badge";
    badgeText = `✓ MS Learn up to date · ${missing} screenshot${missing === 1 ? "" : "s"} pending`;
    ariaText = `Microsoft Learn sync status for ${rawTitle}: documentation up to date, ${missing} screenshot${missing === 1 ? "" : "s"} pending`;
  } else if (drift.status === "ungrounded") {
    badgeClass = "lb-gen-drift-badge";
    badgeText = "MS Learn ungrounded";
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
      <ul class="lb-gen-chips" aria-label="Details for ${title}">${chipHtml}${validation}${screenshotChip}</ul>
      ${lab.notes ? `<p class="lb-gen-notes">${escapeHtml(lab.notes)}</p>` : ""}
      ${legacy}
      <div class="lb-gen-actions">
        ${sharedActions}
        ${!isOpen ? `<button type="button" class="btn btn-sm" data-gen-action="screenshots" aria-label="Manage Playwright screenshots and Microsoft Learn sync for ${title}">📸 Screenshots &amp; Learn Sync</button>` : ""}
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
        ? "No generated labs match your search or MS Learn status filter. Reset the filters to see them all."
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
  return `
    <details class="lb-advanced" style="margin-bottom: 16px;" ${failed || warnings ? "open" : ""}>
      <summary style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
        <span class="${badgeClass}">${escapeHtml(summaryLabel)}</span>
        <span style="font-size: 13px; color: var(--text-muted);">Validated ${escapeHtml(report.title || report.labId)}</span>
      </summary>
      <ul style="margin-top: 10px; padding-left: 20px; font-size: 13px; line-height: 1.65;">${rows}</ul>
    </details>`;
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
      case "revalidate-learn": lbRevalidateLabLearn(labId, { autoUpdate: false }); break;
      case "revalidate-autoupdate": lbRevalidateLabLearn(labId, { autoUpdate: true }); break;
      case "capture-lab-shots": lbCaptureLabScreenshots(labId); break;
      case "capture-module-shot":
        lbCaptureLabScreenshots(labId, { featureIds: button.dataset.featureId ? [button.dataset.featureId] : [] });
        break;
      case "copy-capture-cmd": lbCopyCaptureCommand(button.dataset.captureCmd || ""); break;
      case "close":
        lbGenCloseOpened(labId);
        lbGenRender(`Closed the preview.`);
        lbGenFocusAction(labId, "open");
        break;
      case "edit": lbEditGenerated(labId); break;
      case "export-zip": lbExportGeneratedZip(labId, button); break;
      case "export-html": lbDownloadGeneratedHtml(labId); break;
      case "download": lbDownload(labId); break;
      case "print": lbPrintGenerated(labId); break;
      case "validate": lbValidateGenerated(labId); break;
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
    lbGenRender(`Filtered by MS Learn status: ${selectedLabel}.`);
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

// ── Per-lab Playwright Screenshots & Microsoft Learn Sync ───────────────────
const lbShotUiState = {
  busyLabId: null,
  modeByLab: {},
  scopeByLab: {},
  lastOutcomeByLab: {},
};

function lbCreateTag(text, variant = "") {
  const span = document.createElement("span");
  span.className = variant ? `tag ${variant}` : "tag";
  span.textContent = text;
  return span;
}

function lbRenderLabScreenshotsPanel(host, labId, state, lastOutcome = null) {
  if (!host || !labId) return;
  if (lastOutcome) {
    lbShotUiState.lastOutcomeByLab[labId] = lastOutcome;
  }
  const outcome = lastOutcome || lbShotUiState.lastOutcomeByLab[labId] || null;
  host.replaceChildren();
  if (!state || typeof state !== "object") return;

  const summary = state.summary || {
    total: 0,
    captured: 0,
    missing: 0,
    stale: 0,
    upToDate: 0,
    learnSyncStatus: "up-to-date",
  };
  const shots = Array.isArray(state.shots) ? state.shots : [];
  const modules = Array.isArray(state.modules) ? state.modules : [];
  const isBusy = lbShotUiState.busyLabId === labId;

  const section = document.createElement("section");
  section.className = "lb-screenshots-panel";
  section.dataset.labId = labId;
  section.setAttribute("aria-labelledby", "lb-screenshots-heading");

  const header = document.createElement("div");
  header.className = "lb-screenshots-header";

  const heading = document.createElement("h4");
  heading.id = "lb-screenshots-heading";
  heading.textContent = "📸 Playwright Screenshots & Microsoft Learn Sync";
  header.appendChild(heading);

  const pills = document.createElement("div");
  pills.className = "scenario-pill-list";
  pills.appendChild(
    lbCreateTag(
      `${Number(summary.captured || 0)} of ${Number(summary.total || 0)} screenshots captured`,
      summary.total > 0 && summary.captured === summary.total ? "tag-success" : "",
    ),
  );
  if (Number(summary.missing || 0) > 0) {
    pills.appendChild(lbCreateTag(`${Number(summary.missing)} screenshot${Number(summary.missing) === 1 ? "" : "s"} pending`, "tag-warning"));
  }
  if (summary.learnSyncStatus === "docs-updated" || Number(summary.stale || 0) > 0) {
    const staleCount = Math.max(1, Number(summary.stale || 0));
    pills.appendChild(lbCreateTag(`MS Learn Updated (${staleCount} module${staleCount === 1 ? "" : "s"})`, "tag-warning"));
  } else {
    pills.appendChild(lbCreateTag("MS Learn Up to Date", "tag-success"));
  }
  if (state.lastRevalidatedAt) {
    const checkedDate = new Date(state.lastRevalidatedAt);
    if (!Number.isNaN(checkedDate.getTime())) {
      pills.appendChild(lbCreateTag(`Checked ${checkedDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`));
    }
  }
  header.appendChild(pills);
  section.appendChild(header);

  const intro = document.createElement("p");
  intro.className = "lb-screenshots-intro";
  intro.textContent =
    "Generate Playwright step-through screenshots for this individual lab or re-validate live Microsoft Learn documentation to detect updated UI procedures and automatically refresh drifted steps, PNG assets, HTML, Word, PDF, and PowerPoint exports.";
  section.appendChild(intro);

  const toolbar = document.createElement("div");
  toolbar.className = "lb-screenshots-toolbar";

  const actions = document.createElement("div");
  actions.className = "lb-screenshots-actions";

  const revalidateBtn = document.createElement("button");
  revalidateBtn.type = "button";
  revalidateBtn.className = "btn btn-sm";
  revalidateBtn.dataset.genAction = "revalidate-learn";
  revalidateBtn.dataset.labId = labId;
  revalidateBtn.disabled = isBusy;
  revalidateBtn.textContent = "🔍 Re-validate MS Learn Docs";
  actions.appendChild(revalidateBtn);

  const autoUpdateBtn = document.createElement("button");
  autoUpdateBtn.type = "button";
  autoUpdateBtn.className =
    summary.learnSyncStatus === "docs-updated" || Number(summary.stale || 0) > 0
      ? "btn btn-sm btn-primary"
      : "btn btn-sm";
  autoUpdateBtn.dataset.genAction = "revalidate-autoupdate";
  autoUpdateBtn.dataset.labId = labId;
  autoUpdateBtn.disabled = isBusy;
  autoUpdateBtn.textContent = "🔄 Re-validate & Auto-Update Steps & Screenshots";
  actions.appendChild(autoUpdateBtn);

  const captureBtn = document.createElement("button");
  captureBtn.type = "button";
  captureBtn.className =
    summary.learnSyncStatus !== "docs-updated" && Number(summary.missing || 0) > 0
      ? "btn btn-sm btn-primary"
      : "btn btn-sm";
  captureBtn.dataset.genAction = "capture-lab-shots";
  captureBtn.dataset.labId = labId;
  captureBtn.disabled = isBusy;
  captureBtn.textContent = "🎭 Generate Lab Screenshots (Playwright)";
  actions.appendChild(captureBtn);

  toolbar.appendChild(actions);

  const controls = document.createElement("div");
  controls.className = "lb-screenshots-controls";

  const scopeSelectId = `lb-shot-scope-${labId}`;
  const scopeLabel = document.createElement("label");
  scopeLabel.className = "sr-only";
  scopeLabel.htmlFor = scopeSelectId;
  scopeLabel.textContent = "Screenshot capture scope";
  const scopeSelect = document.createElement("select");
  scopeSelect.id = scopeSelectId;
  scopeSelect.className = "lb-screenshots-select";
  scopeSelect.setAttribute("aria-label", "Screenshot capture scope");
  scopeSelect.disabled = isBusy;
  for (const opt of [
    { value: "missing", label: "Pending / updated shots only" },
    { value: "all", label: "All lab shots (re-capture)" },
  ]) {
    const o = document.createElement("option");
    o.value = opt.value;
    o.textContent = opt.label;
    o.selected = (lbShotUiState.scopeByLab[labId] || "missing") === opt.value;
    scopeSelect.appendChild(o);
  }
  scopeSelect.addEventListener("change", () => {
    lbShotUiState.scopeByLab[labId] = scopeSelect.value;
  });
  controls.appendChild(scopeLabel);
  controls.appendChild(scopeSelect);

  const modeSelectId = `lb-shot-mode-${labId}`;
  const modeLabel = document.createElement("label");
  modeLabel.className = "sr-only";
  modeLabel.htmlFor = modeSelectId;
  modeLabel.textContent = "Playwright browser mode";
  const modeSelect = document.createElement("select");
  modeSelect.id = modeSelectId;
  modeSelect.className = "lb-screenshots-select";
  modeSelect.setAttribute("aria-label", "Playwright browser mode");
  modeSelect.disabled = isBusy;
  for (const opt of [
    { value: "auto", label: "Auto (headless with saved .auth)" },
    { value: "headed", label: "Headed browser (sign-in / assisted)" },
  ]) {
    const o = document.createElement("option");
    o.value = opt.value;
    o.textContent = opt.label;
    o.selected = (lbShotUiState.modeByLab[labId] || "auto") === opt.value;
    modeSelect.appendChild(o);
  }
  modeSelect.addEventListener("change", () => {
    lbShotUiState.modeByLab[labId] = modeSelect.value;
  });
  controls.appendChild(modeLabel);
  controls.appendChild(modeSelect);

  toolbar.appendChild(controls);
  section.appendChild(toolbar);

  const banner = document.createElement("div");
  banner.id = `lb-screenshots-status-${labId}`;
  banner.setAttribute("role", "status");
  banner.setAttribute("aria-live", "polite");
  if (outcome?.message) {
    banner.className = `lb-screenshots-banner ${outcome.variant === "warn" ? "lb-screenshots-banner-warn" : outcome.variant === "ok" ? "lb-screenshots-banner-ok" : ""}`.trim();
    banner.textContent = outcome.message;
  } else {
    banner.hidden = true;
  }
  section.appendChild(banner);

  const cliCmd =
    outcome?.capture?.cliCommandHeaded ||
    outcome?.capture?.cliCommand ||
    state.cliCommand ||
    state.cliCommands?.headed ||
    `node tools/screenshot-capture/capture.js --generated-lab=${labId} --headed`;
  const needsInteractiveHint =
    Boolean(outcome?.capture?.authRequiredCount) ||
    Boolean(outcome?.capture?.browserUnavailableCount) ||
    Number(summary.missing || 0) > 0;
  const cliDetails = document.createElement("details");
  cliDetails.className = "lb-screenshots-cli";
  if (Boolean(outcome?.capture?.authRequiredCount) || Boolean(outcome?.capture?.browserUnavailableCount)) {
    cliDetails.open = true;
  }
  const cliSummary = document.createElement("summary");
  cliSummary.textContent = needsInteractiveHint
    ? "Local Playwright CLI command (use for Microsoft 365 / Copilot Studio tenant sign-in)"
    : "Local Playwright CLI command";
  cliDetails.appendChild(cliSummary);
  const cliRow = document.createElement("div");
  cliRow.className = "lb-screenshots-cli-row";
  const cliCode = document.createElement("code");
  cliCode.textContent = cliCmd;
  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "btn btn-sm";
  copyBtn.dataset.genAction = "copy-capture-cmd";
  copyBtn.dataset.captureCmd = cliCmd;
  copyBtn.setAttribute("aria-label", "Copy local headed Playwright capture command");
  copyBtn.textContent = "📋 Copy Command";
  cliRow.appendChild(cliCode);
  cliRow.appendChild(copyBtn);
  cliDetails.appendChild(cliRow);
  section.appendChild(cliDetails);

  if (modules.length || shots.length) {
    const list = document.createElement("ul");
    list.className = "lb-shot-module-list";
    list.setAttribute("aria-label", "Module screenshot and Microsoft Learn sync status");

    const shotsByFeature = new Map();
    for (const shot of shots) {
      const fid = shot.featureId || "__unmapped";
      if (!shotsByFeature.has(fid)) shotsByFeature.set(fid, []);
      shotsByFeature.get(fid).push(shot);
    }

    const revalByFeature = new Map();
    for (const modReport of outcome?.revalidation?.modules || []) {
      if (modReport?.featureId) revalByFeature.set(modReport.featureId, modReport);
    }

    const rows = modules.length
      ? modules
      : [...shotsByFeature.entries()].map(([featureId, featureShots], idx) => ({
          featureId,
          order: featureShots[0]?.moduleOrder || idx + 1,
          title: featureShots[0]?.moduleTitle || featureId,
          learnStatus: featureShots.some((s) => s.stale) ? "docs-updated" : "up-to-date",
          urls: featureShots[0]?.learnBaseline?.urls || [],
        }));

    for (const mod of rows) {
      const modShots = shotsByFeature.get(mod.featureId) || [];
      const reval = revalByFeature.get(mod.featureId) || null;
      const capturedCount = modShots.filter((s) => s.captured).length;
      const modStatus = mod.status || mod.learnStatus;
      const modOrder = mod.moduleOrder ?? mod.order ?? 1;
      const modTitle = mod.moduleTitle || mod.title || mod.featureId;
      const stale = modStatus === "docs-updated" || modShots.some((s) => s.stale) || reval?.status === "docs-updated";
      const li = document.createElement("li");
      li.className = "lb-shot-module-item";

      const main = document.createElement("div");
      main.className = "lb-shot-module-main";

      const head = document.createElement("div");
      head.className = "lb-shot-module-head";

      const stepBadge = document.createElement("span");
      stepBadge.className = "lb-prereq-req-badge";
      stepBadge.textContent = `Step ${Number(modOrder)}`;
      head.appendChild(stepBadge);

      const titleStrong = document.createElement("strong");
      titleStrong.textContent = modTitle;
      head.appendChild(titleStrong);

      if (stale) {
        head.appendChild(lbCreateTag("MS Learn Updated", "tag-warning"));
      } else {
        head.appendChild(lbCreateTag("Learn Up to Date", "tag-success"));
      }

      if (!modShots.length) {
        head.appendChild(lbCreateTag("No screenshot slot"));
      } else if (capturedCount === modShots.length && !stale) {
        head.appendChild(lbCreateTag(`Captured (${capturedCount}/${modShots.length})`, "tag-success"));
      } else if (capturedCount === modShots.length && stale) {
        head.appendChild(lbCreateTag("Needs Re-capture", "tag-warning"));
      } else {
        head.appendChild(
          lbCreateTag(
            `Pending (${capturedCount}/${modShots.length} captured)`,
            "tag-warning",
          ),
        );
      }
      main.appendChild(head);

      const metaLine = document.createElement("div");
      metaLine.className = "lb-shot-module-meta";
      const shotNames = modShots.map((s) => s.filename).join(", ");
      const lastResult = modShots.find((s) => {
        const st = s.lastAttemptStatus || s.lastCaptureStatus;
        return st && st !== "captured";
      });
      const lastAttemptStatus = lastResult?.lastAttemptStatus || lastResult?.lastCaptureStatus || null;
      const parts = [];
      if (shotNames) parts.push(`Assets: ${shotNames}`);
      if (lastAttemptStatus === "auth-required") {
        parts.push("Tenant sign-in required — use Headed mode or local CLI command");
      } else if (lastAttemptStatus === "browser-unavailable") {
        parts.push("Playwright Chromium not installed on server — run local CLI command");
      }
      metaLine.textContent = parts.join(" · ") || `Module ID: ${mod.featureId}`;
      main.appendChild(metaLine);

      const diffObj = reval?.diff || mod.diff || null;
      const diffSummary = reval?.diffSummary || mod.lastDriftSummary || null;
      if ((diffObj || diffSummary) && (stale || reval?.stepsUpdated)) {
        const diffBox = document.createElement("div");
        diffBox.className = "lb-shot-module-diff";
        const diffBits = [];
        if (reval?.stepsUpdated) {
          diffBits.push("Steps updated from live Microsoft Learn.");
        } else {
          diffBits.push("Live Microsoft Learn documentation changed since baseline.");
        }
        const addedStepsCount = diffObj ? (diffObj.addedSteps || []).length : Number(diffSummary?.addedStepCount || 0);
        const removedStepsCount = diffObj ? (diffObj.removedSteps || []).length : Number(diffSummary?.removedStepCount || 0);
        if (addedStepsCount > 0 || removedStepsCount > 0) {
          diffBits.push(
            `Procedure diff: +${addedStepsCount} updated / -${removedStepsCount} prior step(s).`,
          );
        }
        const addedHeadings = diffObj?.changedHeadings?.added || diffSummary?.addedHeadings || [];
        if (Array.isArray(addedHeadings) && addedHeadings.length) {
          diffBits.push(`New section(s): ${addedHeadings.join(", ")}.`);
        }
        diffBox.textContent = diffBits.join(" ");
        main.appendChild(diffBox);
      }

      li.appendChild(main);

      const rowActions = document.createElement("div");
      rowActions.className = "lb-shot-module-actions";
      const primaryUrl = mod.primaryUrl || (Array.isArray(mod.urls) && mod.urls[0]) || reval?.liveUrl || "";
      if (/^https:\/\/learn\.microsoft\.com\//i.test(primaryUrl)) {
        const docLink = document.createElement("a");
        docLink.className = "btn btn-sm";
        docLink.href = primaryUrl;
        docLink.target = "_blank";
        docLink.rel = "noopener noreferrer";
        docLink.textContent = "Learn Docs ↗";
        docLink.setAttribute("aria-label", `Open Microsoft Learn documentation for ${modTitle}`);
        rowActions.appendChild(docLink);
      }
      if (modShots.length && mod.featureId) {
        const modCapBtn = document.createElement("button");
        modCapBtn.type = "button";
        modCapBtn.className = "btn btn-sm";
        modCapBtn.dataset.genAction = "capture-module-shot";
        modCapBtn.dataset.labId = labId;
        modCapBtn.dataset.featureId = mod.featureId;
        modCapBtn.disabled = isBusy;
        modCapBtn.setAttribute("aria-label", `Capture Playwright screenshot for ${modTitle}`);
        modCapBtn.textContent = capturedCount === modShots.length && !stale ? "🎭 Re-capture" : "🎭 Capture";
        rowActions.appendChild(modCapBtn);
      }
      li.appendChild(rowActions);
      list.appendChild(li);
    }

    section.appendChild(list);
  }

  host.appendChild(section);
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
  let status = "up-to-date";
  if (driftedModules.length > 0 || rawSync === "docs-updated") status = "docs-updated";
  else if (rawSync === "ungrounded") status = "ungrounded";
  else if (rawSync === "not-checked") status = "not-checked";
  else if (missingScreenshotCount > 0 || rawSync === "missing-screenshot") status = "missing-screenshot";

  lab.learnDrift = {
    status,
    lastCheckedAt: state.lastRevalidatedAt || revalData?.checkedAt || lab.learnDrift?.lastCheckedAt || new Date().toISOString(),
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
    toast(`MS Learn scan failed: ${err.message}`, "error");
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

async function lbRevalidateLabLearn(labId, { autoUpdate = false } = {}) {
  if (!labId || lbShotUiState.busyLabId) return;
  lbShotUiState.busyLabId = labId;
  const mode = lbShotUiState.modeByLab[labId] || "auto";
  const host = document.getElementById("lb-result-screenshots");
  const statusBanner = document.getElementById(`lb-screenshots-status-${labId}`);
  if (statusBanner) {
    statusBanner.hidden = false;
    statusBanner.className = "lb-screenshots-banner";
    statusBanner.textContent = autoUpdate
      ? "Checking live Microsoft Learn documentation, updating any drifted steps, and running Playwright screenshot capture..."
      : "Checking live Microsoft Learn documentation against this lab's baseline...";
  }
  try {
    const res = await fetch(`/api/lab-builder/generated/${encodeURIComponent(labId)}/screenshots/revalidate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        autoUpdate,
        updateSteps: autoUpdate,
        autoCapture: autoUpdate,
        onlyStale: true,
        mode,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Re-validation failed (${res.status})`);
    const counts = data.counts || {};
    let message = "";
    let variant = "ok";
    if (autoUpdate) {
      const capCount = Number(data.capture?.capturedCount || 0);
      const updCount = Array.isArray(data.updatedModuleIds) ? data.updatedModuleIds.length : 0;
      if (data.capture?.authRequiredCount) {
        variant = "warn";
        message = `Updated ${updCount} drifted module(s) from Microsoft Learn. ${data.capture.authRequiredCount} screenshot(s) need tenant sign-in — switch mode to Headed or run the CLI command below.`;
      } else if (data.capture?.browserUnavailableCount) {
        variant = "warn";
        message = `Updated ${updCount} drifted module(s) from Microsoft Learn. Playwright Chromium is not installed on this host — run the CLI command below locally.`;
      } else {
        message = `Microsoft Learn sync complete: ${updCount} module(s) updated, ${capCount} screenshot(s) captured, and exports refreshed.`;
      }
    } else if (Number(counts.docsUpdated) > 0) {
      variant = "warn";
      message = `${counts.docsUpdated} module(s) have updated Microsoft Learn documentation since this lab was built. Click "Re-validate & Auto-Update Steps & Screenshots" to refresh them.`;
    } else {
      message = `All ${Number(counts.upToDate || 0)} grounded module(s) match live Microsoft Learn documentation.`;
    }
    const outcome = {
      type: "revalidate",
      variant,
      message,
      revalidation: data,
      capture: data.capture || null,
    };
    if (host && data.state) {
      lbRenderLabScreenshotsPanel(host, labId, data.state, outcome);
    }
    if (data.state) {
      lbSyncSingleLabDriftFromState(labId, data.state, data);
    }
    if (autoUpdate) {
      await lbLoadResultPreview(labId);
    }
    if (typeof lbLoadGenerated === "function") await lbLoadGenerated();
    toast(message, variant === "warn" ? "info" : "success");
  } catch (err) {
    toast(`MS Learn re-validation failed: ${err.message}`, "error");
    await lbRefreshLabScreenshotsPanel(labId, {
      type: "error",
      variant: "warn",
      message: `Could not re-validate Microsoft Learn docs: ${err.message}`,
    });
  } finally {
    lbShotUiState.busyLabId = null;
  }
}

async function lbCaptureLabScreenshots(labId, { featureIds = null } = {}) {
  if (!labId || lbShotUiState.busyLabId) return;
  lbShotUiState.busyLabId = labId;
  const mode = lbShotUiState.modeByLab[labId] || "auto";
  const scope = lbShotUiState.scopeByLab[labId] || "missing";
  const host = document.getElementById("lb-result-screenshots");
  const statusBanner = document.getElementById(`lb-screenshots-status-${labId}`);
  if (statusBanner) {
    statusBanner.hidden = false;
    statusBanner.className = "lb-screenshots-banner";
    statusBanner.textContent = "Running Playwright step-through to capture lab screenshots...";
  }
  try {
    const payload = { mode, onlyMissing: Array.isArray(featureIds) && featureIds.length ? false : scope === "missing" };
    if (Array.isArray(featureIds) && featureIds.length) payload.featureIds = featureIds;
    const res = await fetch(`/api/lab-builder/generated/${encodeURIComponent(labId)}/screenshots/capture`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Screenshot capture failed (${res.status})`);
    const cap = data.capture || {};
    let variant = "ok";
    let message = `Captured ${Number(cap.capturedCount || 0)} screenshot(s) and refreshed HTML, Word, PDF, and PowerPoint exports.`;
    if (Number(cap.authRequiredCount) > 0) {
      variant = "warn";
      message = `Captured ${Number(cap.capturedCount || 0)} screenshot(s); ${Number(cap.authRequiredCount)} shot(s) require tenant sign-in. Choose Headed browser mode or copy the CLI command below.`;
    } else if (Number(cap.browserUnavailableCount) > 0) {
      variant = "warn";
      message = `Playwright Chromium is not available on this host (${cap.browserError || "install playwright"}). Run the CLI command below on a machine with Playwright installed.`;
    } else if (Number(cap.capturedCount || 0) === 0 && Number(cap.attempted || 0) === 0) {
      message = "All targeted screenshots for this lab are already captured and up to date.";
    }
    const outcome = { type: "capture", variant, message, capture: cap };
    if (host && data.state) {
      lbRenderLabScreenshotsPanel(host, labId, data.state, outcome);
    }
    if (data.state) {
      lbSyncSingleLabDriftFromState(labId, data.state, data);
    }
    await lbLoadResultPreview(labId);
    if (typeof lbLoadGenerated === "function") await lbLoadGenerated();
    toast(message, variant === "warn" ? "info" : "success");
  } catch (err) {
    toast(`Playwright capture failed: ${err.message}`, "error");
    await lbRefreshLabScreenshotsPanel(labId, {
      type: "error",
      variant: "warn",
      message: `Playwright screenshot capture failed: ${err.message}`,
    });
  } finally {
    lbShotUiState.busyLabId = null;
  }
}

async function lbCopyCaptureCommand(commandText) {
  if (!commandText) return;
  try {
    await navigator.clipboard.writeText(commandText);
    toast("Copied Playwright capture command to clipboard", "success");
  } catch {
    toast(`Run locally: ${commandText}`, "info");
  }
}
