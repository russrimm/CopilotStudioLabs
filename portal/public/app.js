/**
 * Copilot Studio Labs — Provisioning Portal (Frontend)
 */

// ── State ─────────────────────────────────────────────────────────────────
let labs = [];
let includedLabs = new Set();
let selectedLabId = null;
let recipients = [];
let scenarios = { industries: [], roles: [] };
let selectedIndustryId = "";
let selectedRoleIds = new Set();
let validationResults = new Map();
let validationTimestamp = "";
let activeProvisionJob = null;
let provisionPollHandle = null;
let lastProvisionTerminalState = "";

const ACTIVE_PROVISION_JOB_STORAGE_KEY = "copilot-studio-labs.activeProvisionJob";
const PROVISION_POLL_INTERVAL_MS = 5000;

const SCENARIO_LAB_MAP = {
  "lab-1": "01-sdge-energy-ops-agent",
  "lab-2": "02-sempra-agent-analytics-evaluations",
  "lab-3": "03-sempra-account-orchestration-agent",
  "lab-4": "04-energy-census-advanced-agent",
  "lab-5": "05-copilot-studio-vscode-agent-management",
};

// ── Init ──────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  setupTabs();
  refreshLabs();
  loadScenarios();
  loadConfig();
  loadResourceManifest();
  restoreActiveProvisionJob();
});

// ── Tabs ──────────────────────────────────────────────────────────────────
function setupTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => setActiveTab(tab.dataset.tab));
  });
}

function setActiveTab(tabName) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
  document.querySelector(`.tab[data-tab="${tabName}"]`)?.classList.add("active");
  document.getElementById(`panel-${tabName}`)?.classList.add("active");

  if (tabName === "validate" && !validationResults.size) {
    runValidation().catch(() => {});
  }
}

// ── Lab discovery ─────────────────────────────────────────────────────────
async function refreshLabs() {
  try {
    const res = await fetch("/api/labs");
    const data = await res.json();
    labs = data.labs || [];
    includedLabs = new Set(labs.filter((l) => l.available).map((l) => l.id));
    renderLabs();
    if (validationResults.size) renderValidationResults(buildValidationData());
    updateStatus("green", `Connected — ${labs.length} labs discovered`);
  } catch (err) {
    updateStatus("red", `Error: ${err.message}`);
    toast("Failed to load labs: " + err.message, "error");
  }
}

function renderLabs() {
  const list = document.getElementById("lab-list");
  if (!labs.length) {
    list.innerHTML = '<div style="padding: 40px 20px; text-align: center; color: var(--text-muted);">No labs found.</div>';
    renderScenarioLabPreview();
    return;
  }

  list.innerHTML = labs
    .map((lab) => {
      const included = includedLabs.has(lab.id);
      const selected = lab.id === selectedLabId;
      const number = lab.id.match(/^(\d+)/)?.[1] || "?";
      const sizeKB = lab.sizeBytes ? Math.round(lab.sizeBytes / 1024) : 0;
      return `
        <div class="lab-card ${included ? "included" : "excluded"} ${selected ? "selected" : ""}"
             data-id="${lab.id}" onclick="selectLab('${lab.id}')">
          <button class="lab-toggle ${included ? "on" : ""}"
                  onclick="event.stopPropagation(); toggleLab('${lab.id}')"
                  title="${included ? "Click to exclude" : "Click to include"}"></button>
          <div class="lab-card-title">Lab ${number}: ${lab.title || lab.id}</div>
          <div class="lab-card-meta">
            <span>⭐ ${lab.difficulty || "?"}</span>
            <span>⏱️ ${lab.time || "?"}</span>
            <span>📁 ${sizeKB} KB</span>
          </div>
          <div style="margin-top: 6px;">
            ${(lab.tags || []).slice(0, 3).map((t) => `<span class="tag">${t}</span>`).join(" ")}
          </div>
        </div>
      `;
    })
    .join("");

  updateSummary();
  renderScenarioLabPreview();
  renderPreflightStatus();
}

function toggleLab(labId) {
  if (includedLabs.has(labId)) {
    includedLabs.delete(labId);
  } else {
    includedLabs.add(labId);
  }
  renderLabs();
  renderResourceManifest();
}

function selectAll(include) {
  if (include) {
    labs.filter((l) => l.available).forEach((l) => includedLabs.add(l.id));
  } else {
    includedLabs.clear();
  }
  renderLabs();
  renderResourceManifest();
}

async function selectLab(labId) {
  selectedLabId = labId;
  renderLabs();

  // Switch to preview tab and load content
  setActiveTab("preview");

  const wrapper = document.getElementById("preview-wrapper");
  const preview = document.getElementById("preview-area");
  const toc = document.getElementById("preview-toc");
  const empty = document.getElementById("preview-empty");

  preview.innerHTML = '<div style="text-align: center; padding: 40px;"><div class="spinner"></div> Loading...</div>';
  toc.innerHTML = "";
  wrapper.style.display = "flex";
  empty.style.display = "none";

  try {
    const res = await fetch(`/api/labs/${labId}`);
    const data = await res.json();
    preview.innerHTML = data.html;
    buildPreviewToc(preview, toc);
  } catch (err) {
    preview.innerHTML = `<p style="color: var(--danger);">Failed to load: ${err.message}</p>`;
  }
}

/** Generate a collapsible multi-level table of contents from headings in the preview */
function buildPreviewToc(contentEl, tocEl) {
  const headings = contentEl.querySelectorAll("h1, h2, h3");
  if (!headings.length) {
    tocEl.style.display = "none";
    tocEl.innerHTML = "";
    tocEl.onclick = null;
    return;
  }

  const escapeHtml = (value) => value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

  const tree = [];
  let currentH1 = null;
  let currentH2 = null;

  headings.forEach((heading, index) => {
    const id = `toc-heading-${index}`;
    heading.id = id;

    const level = heading.tagName.toLowerCase();
    const node = {
      id,
      text: heading.textContent.trim(),
      level,
      children: [],
    };

    if (level === "h1") {
      tree.push(node);
      currentH1 = node;
      currentH2 = null;
      return;
    }

    if (level === "h2") {
      if (!currentH1) {
        tree.push(node);
      } else {
        currentH1.children.push(node);
      }
      currentH2 = node;
      return;
    }

    if (currentH2) {
      currentH2.children.push(node);
    } else if (currentH1) {
      currentH1.children.push(node);
    } else {
      tree.push(node);
    }
  });

  const renderNode = (node) => {
    const hasChildren = node.children.length > 0;
    const safeText = escapeHtml(node.text);
    let html = `<div class="toc-node toc-node-${node.level} ${hasChildren ? "toc-parent" : "toc-leaf"}">`;
    html += `<div class="toc-row toc-row-${node.level}">`;

    if (hasChildren) {
      html += `<button type="button" class="toc-toggle collapsed" aria-expanded="false" aria-label="Expand ${safeText}">&#9654;</button>`;
    } else {
      html += `<span class="toc-toggle-spacer" aria-hidden="true"></span>`;
    }

    html += `<a href="#${node.id}" class="toc-link toc-${node.level}" title="${safeText}">${safeText}</a>`;
    html += `</div>`;

    if (hasChildren) {
      html += `<div class="toc-children collapsed"><div class="toc-children-inner">`;
      html += node.children.map(renderNode).join("");
      html += `</div></div>`;
    }

    html += `</div>`;
    return html;
  };

  tocEl.style.display = "";
  tocEl.innerHTML = `<h4>Contents</h4>${tree.map(renderNode).join("")}`;

  tocEl.onclick = (event) => {
    const toggle = event.target.closest(".toc-toggle");
    if (toggle) {
      event.preventDefault();
      const children = toggle.closest(".toc-row")?.nextElementSibling;
      if (children && children.classList.contains("toc-children")) {
        const expanded = toggle.getAttribute("aria-expanded") === "true";
        toggle.setAttribute("aria-expanded", String(!expanded));
        toggle.setAttribute("aria-label", `${expanded ? "Expand" : "Collapse"} ${toggle.closest(".toc-row")?.querySelector(".toc-link")?.textContent.trim() || "section"}`);
        toggle.classList.toggle("collapsed", expanded);
        toggle.classList.toggle("expanded", !expanded);
        children.classList.toggle("collapsed", expanded);
        children.classList.toggle("expanded", !expanded);
      }
      return;
    }

    const link = event.target.closest("a");
    if (!link) return;

    event.preventDefault();
    const target = contentEl.querySelector(link.getAttribute("href"));
    if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
  };
}

// ── Scenarios ───────────────────────────────────────────────────────────────
async function loadScenarios() {
  try {
    const res = await fetch("/api/scenarios");
    const data = await res.json();
    scenarios = {
      industries: data.industries || [],
      roles: data.roles || [],
    };

    renderIndustryCards();
    renderRoleOptions();

    if (scenarios.industries.length && !selectedIndustryId) {
      selectIndustry(scenarios.industries[0].id);
    }
  } catch (err) {
    document.getElementById("scenario-industry-grid").innerHTML = `<div class="scenario-empty">Failed to load scenarios: ${err.message}</div>`;
    document.getElementById("scenario-role-list").innerHTML = '<div class="scenario-empty">Scenario roles unavailable.</div>';
  }
}

function renderIndustryCards() {
  const container = document.getElementById("scenario-industry-grid");
  container.innerHTML = scenarios.industries
    .map((industry) => `
      <div class="scenario-card ${industry.id === selectedIndustryId ? "active" : ""}"
           onclick="selectIndustry('${industry.id}')">
        <div class="scenario-card-title">
          <span style="font-size: 22px;">${industry.icon}</span>
          <span>${industry.name}</span>
        </div>
        <div class="scenario-card-desc">${industry.description}</div>
      </div>
    `)
    .join("");
}

function renderRoleOptions() {
  const container = document.getElementById("scenario-role-list");
  container.innerHTML = scenarios.roles
    .map((role) => `
      <label class="scenario-role">
        <input type="checkbox" ${selectedRoleIds.has(role.id) ? "checked" : ""} onchange="toggleRole('${role.id}')" />
        <div>
          <div style="font-weight: 600;">${role.icon} ${role.name}</div>
          <div style="font-size: 12px; color: var(--text-muted);">${role.description}</div>
        </div>
      </label>
    `)
    .join("");
}

function getSelectedIndustry() {
  return scenarios.industries.find((industry) => industry.id === selectedIndustryId) || null;
}

function getSelectedRoles() {
  return scenarios.roles.filter((role) => selectedRoleIds.has(role.id));
}

function getSuggestedScenarioLabIds() {
  const industry = getSelectedIndustry();
  if (!industry) return [];

  const aliases = new Set(industry.suggestedLabs || []);
  getSelectedRoles().forEach((role) => {
    (role.suggestedLabs || []).forEach((labId) => aliases.add(labId));
  });

  return [...aliases].map((labId) => SCENARIO_LAB_MAP[labId]).filter(Boolean);
}

function renderScenarioDetails() {
  const industry = getSelectedIndustry();
  const roles = getSelectedRoles();

  document.getElementById("scenario-selected-title").textContent = industry
    ? `${industry.icon} ${industry.name}`
    : "Select an industry";
  document.getElementById("scenario-description").textContent = industry
    ? industry.description
    : "Scenario guidance will appear here.";

  document.getElementById("scenario-categories").innerHTML = industry
    ? [...industry.categories, ...roles.flatMap((role) => role.categories || [])]
        .map((category) => `<span class="scenario-pill">${category.name}</span>`)
        .join("")
    : "";

  document.getElementById("scenario-kpis").innerHTML = industry
    ? [...new Set([...industry.kpis, ...roles.flatMap((role) => role.kpis || [])])]
        .map((kpi) => `<span class="scenario-pill">${kpi}</span>`)
        .join("")
    : "";
}

function renderScenarioLabPreview() {
  const container = document.getElementById("scenario-labs-preview");
  if (!container) return;

  const suggestedLabIds = getSuggestedScenarioLabIds();
  if (!suggestedLabIds.length) {
    container.innerHTML = '<div class="scenario-empty">Select an industry to see recommended labs.</div>';
    return;
  }

  container.innerHTML = suggestedLabIds
    .map((labId) => {
      const lab = labs.find((item) => item.id === labId);
      return `<div class="scenario-lab-chip">${lab?.title || labId}</div>`;
    })
    .join("");
}

function selectIndustry(id) {
  selectedIndustryId = id;
  renderIndustryCards();
  renderScenarioDetails();
  renderScenarioLabPreview();
  document.getElementById("scenario-apply-status").textContent = "";
}

function toggleRole(id) {
  if (selectedRoleIds.has(id)) {
    selectedRoleIds.delete(id);
  } else {
    selectedRoleIds.add(id);
  }

  renderRoleOptions();
  renderScenarioDetails();
  renderScenarioLabPreview();
  document.getElementById("scenario-apply-status").textContent = "";
}

async function applyScenarioConfig() {
  if (!selectedIndustryId) {
    toast("Select an industry first.", "error");
    return;
  }

  const status = document.getElementById("scenario-apply-status");
  status.innerHTML = '<span class="spinner"></span> Applying scenario...';

  try {
    const res = await fetch("/api/scenarios/configure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        industry: selectedIndustryId,
        roles: [...selectedRoleIds],
      }),
    });

    const config = await res.json();
    if (!res.ok) throw new Error(config.error || "Failed to apply scenario");

    includedLabs = new Set(config.labs?.include || []);
    renderLabs();
    renderResourceManifest();

    setSelectValue("cfg-industry", config.organization?.industry || "");
    setInputValue("cfg-agent", config.scenario?.agentName || "");
    setInputValue("cfg-users", config.scenario?.endUsers || "");
    setInputValue("cfg-tagline", config.branding?.tagline || "");

    setActiveTab("provision");
    status.textContent = `Applied ${includedLabs.size} recommended lab(s)`;
    toast("Scenario applied to lab configuration.", "success");
  } catch (err) {
    status.textContent = `❌ ${err.message}`;
    toast("Scenario apply failed: " + err.message, "error");
  }
}

// ── Customization / replacements ──────────────────────────────────────────
//
// Each token has:
//   fieldId     — the form input ID
//   legacy      — the literal string that may currently appear in lab prose
//                 (find-and-replace target for old, unmigrated content)
//   placeholder — the {{TOKEN}} form for new, migrated prose
//   fallback    — the generic, vendor-neutral default used when the user
//                 leaves the field blank
//
// The exporter applies BOTH the legacy literal -> value and the
// {{TOKEN}} -> value substitutions, so the same portal works whether a
// given lab file has been migrated to placeholders or not.
const CUSTOMIZATION_TOKENS = [
  {
    fieldId: "cfg-org-name",
    legacy: "SDG&E",
    placeholder: "{{ORG_NAME}}",
    fallback: "Contoso",
  },
  {
    fieldId: "cfg-org-full",
    legacy: "San Diego Gas & Electric",
    placeholder: "{{ORG_FULL}}",
    fallback: "Contoso Energy",
  },
  {
    fieldId: "cfg-parent",
    legacy: "Sempra",
    placeholder: "{{PARENT_COMPANY}}",
    fallback: "Contoso Energy Holdings",
  },
  {
    fieldId: "cfg-agent",
    legacy: "IT Operations Agent",
    placeholder: "{{AGENT_NAME}}",
    fallback: "IT Operations Agent",
  },
  {
    fieldId: "cfg-users",
    legacy: "field technicians",
    placeholder: "{{END_USERS}}",
    fallback: "field technicians",
  },
  {
    fieldId: "cfg-tagline",
    legacy: "Delivering energy with purpose — powered by AI",
    placeholder: "{{TAGLINE}}",
    fallback: "Delivering energy with purpose — powered by AI",
  },
];

function getReplacements() {
  const r = {};

  for (const t of CUSTOMIZATION_TOKENS) {
    const userInput = document.getElementById(t.fieldId)?.value?.trim();
    const value = userInput || t.fallback;
    // Skip true no-ops (user blank AND fallback matches legacy).
    if (value !== t.legacy) r[t.legacy] = value;
    // Always wire the placeholder so migrated lab prose renders cleanly.
    if (t.placeholder) r[t.placeholder] = value;
  }

  // Compliance standard — multi-select with a "None" option.
  // - Nothing selected     → keep default "NERC CIP" in legacy prose,
  //                          but render {{COMPLIANCE}} as "NERC CIP".
  // - Only "None" selected → replace with "None".
  // - One or more picked   → join with ", ".
  // - "None" + standards   → "None" ignored.
  const complianceSel = document.getElementById("cfg-compliance");
  let complianceValue = "NERC CIP";
  if (complianceSel) {
    const picked = [...complianceSel.selectedOptions].map((o) => o.value);
    if (picked.length) {
      const real = picked.filter((v) => v !== "__NONE__");
      if (real.length) {
        complianceValue = real.join(", ");
      } else if (picked.includes("__NONE__")) {
        complianceValue = "None";
      }
    }
  }
  if (complianceValue !== "NERC CIP") r["NERC CIP"] = complianceValue;
  r["{{COMPLIANCE}}"] = complianceValue;

  // Industry.
  const industry = document.getElementById("cfg-industry")?.value;
  const industryValue = industry || "Energy / Utilities";
  if (industryValue !== "Energy / Utilities") r["Energy / Utilities"] = industryValue;
  r["{{INDUSTRY}}"] = industryValue;

  return r;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function applyValidationSnapshot(data) {
  validationResults = new Map((data.labs || []).map((lab) => [lab.labId, lab]));
  validationTimestamp = data.timestamp || new Date().toISOString();
}

function buildValidationData() {
  const orderedIds = labs.map((lab) => lab.id);
  const ordered = orderedIds.map((labId) => validationResults.get(labId)).filter(Boolean);
  const extras = [...validationResults.values()].filter((lab) => !orderedIds.includes(lab.labId));
  const allResults = [...ordered, ...extras];

  return {
    summary: {
      total: allResults.length,
      passed: allResults.filter((lab) => lab.failed === 0).length,
      failed: allResults.filter((lab) => lab.failed > 0).length,
      warnings: allResults.filter((lab) => lab.warnings > 0).length,
    },
    labs: allResults,
    timestamp: validationTimestamp || new Date().toISOString(),
  };
}

function getValidationBadge(result) {
  if (result.failed > 0) return { text: "Fail", className: "tag-danger", icon: "❌" };
  if (result.warnings > 0) return { text: "Warn", className: "tag-warning", icon: "⚠️" };
  return { text: "Pass", className: "tag-success", icon: "✅" };
}

function renderPreflightStatus() {
  const container = document.getElementById("preflight-validation-status");
  if (!container) return;

  const selectedIds = [...includedLabs];
  if (!selectedIds.length) {
    container.innerHTML = '<span class="tag">No labs selected</span><span style="font-size: 13px; color: var(--text-muted);">Choose one or more labs to show pre-flight status.</span>';
    return;
  }

  if (!validationResults.size) {
    container.innerHTML = `<span class="tag">${selectedIds.length} selected</span><span style="font-size: 13px; color: var(--text-muted);">No validation run yet for the selected labs.</span>`;
    return;
  }

  const selectedResults = selectedIds.map((labId) => validationResults.get(labId)).filter(Boolean);
  const missing = selectedIds.filter((labId) => !validationResults.has(labId));
  const failing = selectedResults.filter((lab) => lab.failed > 0);
  const warningOnly = selectedResults.filter((lab) => lab.failed === 0 && lab.warnings > 0);
  const passing = selectedResults.filter((lab) => lab.failed === 0);

  container.innerHTML = `
    <span class="tag">${selectedIds.length} selected</span>
    <span class="tag tag-success">${passing.length} passing</span>
    <span class="tag tag-danger">${failing.length} failing</span>
    <span class="tag tag-warning">${warningOnly.length + missing.length} warning/missing</span>
    <span style="font-size: 13px; color: var(--text-muted);">
      ${validationTimestamp ? `Last run ${new Date(validationTimestamp).toLocaleString()}` : "No timestamp available"}
    </span>
    <div class="status-stack">
      ${selectedIds.map((labId) => {
        const result = validationResults.get(labId);
        const title = labs.find((lab) => lab.id === labId)?.title || labId;
        if (!result) return `<span class="tag tag-warning">${escapeHtml(title)}: not run</span>`;
        const badge = getValidationBadge(result);
        return `<span class="tag ${badge.className}">${badge.icon} ${escapeHtml(title)}</span>`;
      }).join("")}
    </div>
  `;
}

async function fetchValidationResults() {
  const res = await fetch("/api/validate");
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Validation failed");

  applyValidationSnapshot(data);
  renderValidationResults(buildValidationData());
  return buildValidationData();
}

async function runValidation() {
  const summary = document.getElementById("validation-summary");
  const results = document.getElementById("validation-results");
  if (summary) {
    summary.innerHTML = '<span class="spinner"></span><span style="font-size: 13px; color: var(--text-muted);">Running validation across all labs...</span>';
  }
  if (results) {
    results.innerHTML = '<div class="scenario-empty"><span class="spinner"></span> Running validation...</div>';
  }

  try {
    const data = await fetchValidationResults();
    toast(`Validation complete for ${data.summary.total} lab(s)`, data.summary.failed > 0 ? "error" : "success");
    return data;
  } catch (err) {
    if (summary) {
      summary.innerHTML = `<span class="tag tag-danger">Validation failed</span><span style="font-size: 13px; color: var(--danger);">${escapeHtml(err.message)}</span>`;
    }
    if (results) {
      results.innerHTML = `<div class="scenario-empty" style="color: var(--danger);">Validation failed: ${escapeHtml(err.message)}</div>`;
    }
    renderPreflightStatus();
    throw err;
  }
}

async function runLabValidation(labId) {
  const res = await fetch(`/api/validate/${labId}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Validation failed");

  validationResults.set(data.labId, data);
  validationTimestamp = data.timestamp || new Date().toISOString();
  renderValidationResults(buildValidationData());
  toast(`Validation updated for ${data.title || labId}`, data.failed > 0 ? "error" : "success");
  return data;
}

function renderValidationResults(data) {
  const summary = document.getElementById("validation-summary");
  const container = document.getElementById("validation-results");
  if (!summary || !container) return;

  const labsToRender = data?.labs || [];
  if (!labsToRender.length) {
    summary.innerHTML = '<span class="tag">No results</span><span style="font-size: 13px; color: var(--text-muted);">Run validation to populate lab results.</span>';
    container.innerHTML = '<div class="scenario-empty">Run validation to see lab smoke test results.</div>';
    renderPreflightStatus();
    return;
  }

  summary.innerHTML = `
    <span class="tag">${data.summary.total} labs</span>
    <span class="tag tag-success">${data.summary.passed} passing</span>
    <span class="tag tag-danger">${data.summary.failed} failing</span>
    <span class="tag tag-warning">${data.summary.warnings} with warnings</span>
    <span style="font-size: 13px; color: var(--text-muted);">Last run ${new Date(data.timestamp).toLocaleString()}</span>
  `;

  container.innerHTML = labsToRender
    .map((lab) => {
      const badge = getValidationBadge(lab);
      return `
        <div class="validation-card" id="validation-card-${escapeHtml(lab.labId)}">
          <div class="validation-card-header">
            <div>
              <div class="validation-card-title">${escapeHtml(lab.title || lab.labId)}</div>
              <div class="status-stack">
                <span class="tag tag-success">${lab.passed} pass</span>
                <span class="tag tag-danger">${lab.failed} fail</span>
                <span class="tag tag-warning">${lab.warnings} warn</span>
              </div>
            </div>
            <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: flex-end;">
              <span class="tag ${badge.className}">${badge.icon} ${badge.text}</span>
              <button class="btn btn-sm" onclick="runLabValidation('${lab.labId}')">Run</button>
            </div>
          </div>
          <details ${lab.failed > 0 ? "open" : ""}>
            <summary>View ${lab.total} smoke test result(s)</summary>
            <div class="validation-test-list">
              ${(lab.tests || []).map((test) => {
                const icon = test.status === "pass" ? "✅" : test.status === "warn" ? "⚠️" : "❌";
                return `
                  <div class="validation-test">
                    <span>${icon}</span>
                    <div>
                      <span class="validation-test-name">${escapeHtml(test.name)}</span>
                      <span>${escapeHtml(test.message)}</span>
                    </div>
                  </div>
                `;
              }).join("")}
            </div>
          </details>
        </div>
      `;
    })
    .join("");

  renderPreflightStatus();
}

async function ensureValidationBeforeAction(actionLabel, statusElementId) {
  const selectedIds = [...includedLabs];
  if (!selectedIds.length) return null;

  const status = document.getElementById(statusElementId);
  if (status) {
    status.innerHTML = '<span class="spinner"></span> Running pre-flight validation...';
  }

  try {
    const data = await fetchValidationResults();
    const selectedResults = data.labs.filter((lab) => selectedIds.includes(lab.labId));
    const failing = selectedResults.filter((lab) => lab.failed > 0);
    const warningOnly = selectedResults.filter((lab) => lab.failed === 0 && lab.warnings > 0);

    if (failing.length) {
      toast(`Pre-flight warning: ${failing.length} selected lab(s) failed validation. Continuing ${actionLabel}.`, "error");
    } else if (warningOnly.length) {
      toast(`Pre-flight check found warnings in ${warningOnly.length} selected lab(s).`, "success");
    }

    return { data, selectedResults, failing, warningOnly };
  } catch (err) {
    if (status) status.textContent = `⚠️ Validation unavailable: ${err.message}`;
    toast(`Pre-flight validation failed before ${actionLabel}: ${err.message}`, "error");
    return null;
  }
}

// Make the "None" option mutually exclusive with the rest of the
// compliance standard list. Picking None auto-deselects standards;
// picking any standard auto-deselects None.
(function wireComplianceExclusivity() {
  const sel = document.getElementById("cfg-compliance");
  if (!sel) return;
  sel.addEventListener("change", () => {
    const opts = [...sel.options];
    const noneOpt = opts.find((o) => o.value === "__NONE__");
    if (!noneOpt) return;
    const noneSelected = noneOpt.selected;
    const realSelected = opts.some(
      (o) => o.selected && o.value !== "__NONE__"
    );
    if (noneSelected && realSelected) {
      // Resolve in favor of whichever the user just touched. Simple
      // heuristic: if both are present, drop the "None" selection.
      noneOpt.selected = false;
    }
  });
})();

// ── Export ─────────────────────────────────────────────────────────────────
async function exportZip() {
  const selected = [...includedLabs];
  if (!selected.length) {
    toast("No labs selected for export.", "error");
    return;
  }

  const status = document.getElementById("export-status");
  await ensureValidationBeforeAction("export", "export-status");
  status.innerHTML = '<span class="spinner"></span> Generating ZIP...';

  try {
    const res = await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ labs: selected, replacements: getReplacements() }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "Export failed");
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "copilot-studio-labs.zip";
    a.click();
    URL.revokeObjectURL(url);

    status.textContent = `✅ Exported ${selected.length} lab(s)`;
    toast(`Exported ${selected.length} lab(s) as ZIP`, "success");
  } catch (err) {
    status.textContent = `❌ ${err.message}`;
    toast("Export failed: " + err.message, "error");
  }
}

// ── Email ─────────────────────────────────────────────────────────────────
function addRecipient() {
  const input = document.getElementById("email-input");
  const email = input.value.trim();
  if (!email || !email.includes("@")) {
    toast("Please enter a valid email address.", "error");
    return;
  }
  if (recipients.includes(email)) {
    toast("Email already added.", "error");
    return;
  }
  recipients.push(email);
  input.value = "";
  renderRecipients();
}

function removeRecipient(email) {
  recipients = recipients.filter((r) => r !== email);
  renderRecipients();
}

function renderRecipients() {
  const list = document.getElementById("recipients-list");
  list.innerHTML = recipients
    .map((r) => `<span class="recipient-chip">${r} <button onclick="removeRecipient('${r}')">×</button></span>`)
    .join("");
}

async function sendEmail() {
  if (!recipients.length) {
    toast("Add at least one recipient.", "error");
    return;
  }
  const selected = [...includedLabs];
  if (!selected.length) {
    toast("No labs selected to send.", "error");
    return;
  }

  const status = document.getElementById("email-status");
  status.innerHTML = '<span class="spinner"></span> Sending...';

  try {
    const res = await fetch("/api/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: recipients,
        labs: selected,
        subject: document.getElementById("email-subject").value,
        replacements: getReplacements(),
      }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Send failed");

    status.textContent = `✅ Sent to ${recipients.length} recipient(s)`;
    toast(`Email sent to ${recipients.length} recipient(s)`, "success");
  } catch (err) {
    status.textContent = `❌ ${err.message}`;
    toast("Send failed: " + err.message, "error");
  }
}

// ── Config ────────────────────────────────────────────────────────────────
async function loadConfig() {
  try {
    const res = await fetch("/api/config");
    const cfg = await res.json();

    const container = document.getElementById("config-status");
    const dot = (ok) => `<span class="status-dot ${ok ? "green" : "red"}"></span>`;

    const kvConfigured = cfg.keyVault?.configured;
    const secretSource = cfg.secretSource || "env";

    container.innerHTML = `
      <div class="config-status-item">
        <div class="label">Email Transport</div>
        <div class="value">${dot(cfg.email.transport !== "none")} ${cfg.email.transport === "none" ? "Not configured" : cfg.email.transport.toUpperCase()}</div>
      </div>
      <div class="config-status-item">
        <div class="label">Azure Tenant</div>
        <div class="value">${dot(cfg.azure.tenantId === "configured")} ${cfg.azure.tenantId}</div>
      </div>
      <div class="config-status-item">
        <div class="label">Client ID</div>
        <div class="value">${dot(cfg.azure.clientId === "configured")} ${cfg.azure.clientId}</div>
      </div>
      <div class="config-status-item">
        <div class="label">Client Secret</div>
        <div class="value">${dot(cfg.azure.clientSecret === "configured")} ${cfg.azure.clientSecret}</div>
      </div>
      <div class="config-status-item">
        <div class="label">Secret Source</div>
        <div class="value">${dot(secretSource === "keyvault")} ${secretSource === "keyvault" ? "🔐 Key Vault" : "📄 .env file"}</div>
      </div>
      <div class="config-status-item">
        <div class="label">Key Vault</div>
        <div class="value">${dot(kvConfigured)} ${kvConfigured ? cfg.keyVault.vaultName : "Not configured"}</div>
      </div>
      <div class="config-status-item">
        <div class="label">Web App</div>
        <div class="value">${dot(cfg.deployment.webAppName)} ${cfg.deployment.webAppName || "Not set"}</div>
      </div>
      <div class="config-status-item">
        <div class="label">MCP Server</div>
        <div class="value">${dot(cfg.deployment.mcpEndpoint)} ${cfg.deployment.mcpEndpoint || "Not set"}</div>
      </div>
    `;
  } catch {
    // Config endpoint unavailable — skip
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────
function updateStatus(color, text) {
  const dot = document.getElementById("status-dot");
  const label = document.getElementById("status-text");
  dot.className = `status-dot ${color}`;
  label.textContent = text;
}

function updateSummary() {
  const count = includedLabs.size;
  document.getElementById("lab-count").textContent = `${count} lab${count !== 1 ? "s" : ""}`;
  document.getElementById("selected-summary").textContent = `${count} lab${count !== 1 ? "s" : ""} selected for provisioning`;
}

function setInputValue(id, value) {
  const input = document.getElementById(id);
  if (input) input.value = value;
}

function setSelectValue(id, value) {
  const select = document.getElementById(id);
  if (!select) return;

  if (value && ![...select.options].some((option) => option.value === value)) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.appendChild(option);
  }

  select.value = value;
}

function toast(message, type = "success") {
  const container = document.getElementById("toast-container");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

function getDeployButton() {
  return document.getElementById("deploy-button");
}

function setDeployButtonBusy(isBusy) {
  const button = getDeployButton();
  if (!button) return;

  if (!button.dataset.defaultLabel) {
    button.dataset.defaultLabel = button.textContent;
  }

  button.disabled = isBusy;
  button.textContent = isBusy ? "⏳ Deploying..." : button.dataset.defaultLabel;
}

function saveActiveProvisionJob(job) {
  if (!job?.jobId || job.status !== "running") {
    localStorage.removeItem(ACTIVE_PROVISION_JOB_STORAGE_KEY);
    return;
  }

  localStorage.setItem(ACTIVE_PROVISION_JOB_STORAGE_KEY, JSON.stringify({
    jobId: job.jobId,
    baseName: job.baseName,
  }));
}

function clearActiveProvisionJob() {
  localStorage.removeItem(ACTIVE_PROVISION_JOB_STORAGE_KEY);
}

function stopProvisionPolling() {
  if (!provisionPollHandle) return;
  clearInterval(provisionPollHandle);
  provisionPollHandle = null;
}

function startProvisionPolling(jobId) {
  stopProvisionPolling();
  provisionPollHandle = window.setInterval(() => {
    refreshProvisionProgress(jobId, { silentReconnect: true }).catch((err) => {
      console.error(err);
      clearProvisionUi(`❌ ${err.message}`);
    });
  }, PROVISION_POLL_INTERVAL_MS);
}

function clearProvisionUi(statusMessage = "") {
  stopProvisionPolling();
  activeProvisionJob = null;
  clearActiveProvisionJob();
  setDeployButtonBusy(false);
  renderDeployLog([]);
  renderDeployStatus(null);
  renderProvisionStatusBar(null);

  if (statusMessage) {
    document.getElementById("deploy-status").textContent = statusMessage;
  }
}

function getProvisionStepIcon(step) {
  if (step?.status === "running") return '<span class="spinner provision-spinner"></span>';
  if (step?.status === "done") return "✅";
  if (step?.status === "failed") return "❌";
  if (step?.status === "skipped") return "⏭️";
  return "•";
}

function getProvisionStepLabel(stepName = "") {
  return stepName
    .split("-")
    .filter(Boolean)
    .map((part) => (part.length <= 3 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(" ");
}

function summarizeProvisionState(job) {
  const steps = job?.steps || [];
  const totalSteps = Math.max(job?.totalSteps || steps.length || 1, steps.length || 1);
  const completedSteps = steps.filter((step) => step.status !== "running").length;
  const currentStep = job?.currentStep || steps.find((step) => step.status === "running") || null;
  const currentStepNumber = currentStep ? Math.min(completedSteps + 1, totalSteps) : Math.min(completedSteps, totalSteps);
  const progressPercent = totalSteps ? Math.round((completedSteps / totalSteps) * 100) : 0;

  return {
    totalSteps,
    completedSteps,
    currentStep,
    currentStepNumber,
    progressPercent,
  };
}

function renderDeployLog(steps = []) {
  const logContainer = document.getElementById("deploy-log");
  const logEntries = document.getElementById("deploy-log-entries");

  if (!steps.length) {
    logEntries.innerHTML = "";
    logContainer.style.display = "none";
    return;
  }

  logContainer.style.display = "block";
  logEntries.innerHTML = steps
    .map((step) => `
      <div style="padding: 3px 0;">
        ${getProvisionStepIcon(step)}
        <strong>${escapeHtml(getProvisionStepLabel(step.step))}</strong>
        <span style="color: var(--text-muted);">— ${escapeHtml(step.detail || step.status || "")}</span>
      </div>
    `)
    .join("");
}

function renderDeployStatus(job) {
  const status = document.getElementById("deploy-status");
  if (!job) {
    status.textContent = "";
    return;
  }

  const summary = job.summary || { deployed: 0, skipped: 0, failed: 0 };
  if (job.status === "running") {
    status.innerHTML = '<span class="spinner"></span> Provisioning in progress...';
    return;
  }

  const prefix = job.status === "done" ? "✅ Done" : "❌ Failed";
  status.textContent = `${prefix} — ${summary.deployed} deployed, ${summary.skipped} skipped, ${summary.failed} failed`;
}

function renderProvisionStatusBar(job) {
  const container = document.getElementById("deploy-progress-bar");
  if (!container) return;

  if (!job) {
    container.hidden = true;
    container.innerHTML = "";
    return;
  }

  const summary = job.summary || { deployed: 0, skipped: 0, failed: 0 };
  const { totalSteps, completedSteps, currentStep, currentStepNumber, progressPercent } = summarizeProvisionState(job);
  const headline = currentStep
    ? getProvisionStepLabel(currentStep.step)
    : job.status === "done"
    ? "Deployment complete"
    : "Deployment failed";
  const detail = currentStep?.detail
    || (job.status === "done"
      ? `${summary.deployed} deployed, ${summary.skipped} skipped, ${summary.failed} failed`
      : summary.failed
      ? `${summary.failed} step(s) failed`
      : "Waiting for progress update...");
  const completedItems = (job.steps || [])
    .filter((step) => step.status !== "running")
    .map((step) => `
      <div class="provision-completed-item">
        <span class="provision-step-icon">${getProvisionStepIcon(step)}</span>
        <div>
          <div class="provision-step-title">${escapeHtml(getProvisionStepLabel(step.step))}</div>
          <div class="provision-step-detail">${escapeHtml(step.detail || step.status || "")}</div>
        </div>
      </div>
    `)
    .join("");

  const statusClass = job.status === "failed" ? "failed" : job.status === "done" ? "done" : "running";
  const statusText = job.status === "running"
    ? `Step ${Math.max(currentStepNumber, 1)} of ${totalSteps}`
    : `${completedSteps} of ${totalSteps} steps complete`;

  container.hidden = false;
  container.innerHTML = `
    <div class="provision-status-bar ${statusClass}">
      <div class="provision-status-header">
        <div>
          <div class="provision-status-label">Live provisioning status</div>
          <div class="provision-status-job">${escapeHtml(job.baseName || "copilot-labs")}</div>
        </div>
        <div class="provision-status-summary">${escapeHtml(statusText)} · ${progressPercent}%</div>
      </div>
      <div class="provision-status-current">
        <div class="provision-current-icon">${getProvisionStepIcon(currentStep || { status: job.status })}</div>
        <div class="provision-current-copy">
          <div class="provision-current-title">${escapeHtml(headline)}</div>
          <div class="provision-current-detail">${escapeHtml(detail)}</div>
        </div>
      </div>
      <div class="provision-progress-track">
        <div class="provision-progress-fill" style="width: ${Math.max(0, Math.min(progressPercent, 100))}%;"></div>
      </div>
      <div class="provision-summary-row">
        <span>✅ ${summary.deployed} deployed</span>
        <span>⏭️ ${summary.skipped} skipped</span>
        <span>❌ ${summary.failed} failed</span>
      </div>
      <div class="provision-completed-list">
        ${completedItems || '<div class="provision-empty">No completed steps yet.</div>'}
      </div>
    </div>
  `;
}

async function refreshProvisionProgress(jobId, { silentReconnect = false } = {}) {
  const res = await fetch(`/api/provision/progress/${encodeURIComponent(jobId)}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to load provisioning progress");

  const previousStatus = activeProvisionJob?.status;
  activeProvisionJob = data;

  renderDeployStatus(data);
  renderDeployLog(data.steps || []);
  renderProvisionStatusBar(data);
  setDeployButtonBusy(data.status === "running");

  if (data.status === "running") {
    saveActiveProvisionJob(data);
    if (!provisionPollHandle) {
      startProvisionPolling(data.jobId);
    }
  } else {
    stopProvisionPolling();
    clearActiveProvisionJob();
    setDeployButtonBusy(false);

    const terminalKey = `${data.jobId}:${data.status}`;
    if (lastProvisionTerminalState !== terminalKey) {
      lastProvisionTerminalState = terminalKey;
      const { deployed, skipped, failed } = data.summary || { deployed: 0, skipped: 0, failed: 0 };
      const message = `Deployment ${data.status === "done" ? "complete" : "finished with errors"}: ${deployed} deployed, ${skipped} skipped, ${failed} failed`;
      toast(message, data.status === "done" ? "success" : "error");
    }
  }

  if (!silentReconnect && data.status === "running") {
    toast(`Tracking deployment for ${data.baseName}`, "success");
  }

  return data;
}

async function restoreActiveProvisionJob() {
  const raw = localStorage.getItem(ACTIVE_PROVISION_JOB_STORAGE_KEY);
  if (!raw) return;

  try {
    const saved = JSON.parse(raw);
    if (!saved?.jobId) {
      clearActiveProvisionJob();
      return;
    }

    if (saved.baseName) {
      setInputValue("az-base-name", saved.baseName);
    }

    const job = await refreshProvisionProgress(saved.jobId, { silentReconnect: true });
    if (job.status === "running") {
      toast(`Reconnected to active deployment for ${job.baseName}`, "success");
    }
  } catch {
    clearProvisionUi();
  }
}

// ── Azure Provisioning ───────────────────────────────────────────────────
let resourceManifest = [];

async function loadResourceManifest() {
  try {
    const res = await fetch("/api/provision/resources");
    const data = await res.json();
    resourceManifest = data.labs || [];
    renderResourceManifest();
  } catch {
    // Silently fail — resources tab will show loading state
  }
}

function renderResourceManifest() {
  const container = document.getElementById("resource-manifest");
  if (!resourceManifest.length) {
    container.innerHTML = '<div style="color: var(--text-muted);">No resource data available.</div>';
    return;
  }

  const selected = [...includedLabs];
  const filtered = resourceManifest.filter((lab) => selected.includes(lab.labId));

  if (!filtered.length) {
    container.innerHTML = '<div style="color: var(--text-muted);">Select labs from the sidebar to see their resource requirements.</div>';
    return;
  }

  container.innerHTML = filtered
    .map((lab) => {
      const number = lab.labId.match(/^(\d+)/)?.[1] || "?";
      const resources = lab.resources
        .map((r) => {
          const typeIcon = {
            "resource-group": "📁",
            "sharepoint-site": "📋",
            "copilot-studio-agent": "🤖",
            "dataverse-data": "🗃️",
            "power-automate-flow": "⚡",
            "mcp-server": "🔌",
            "container-app": "📦",
            "api-key": "🔑",
            "local-tool": "🛠️",
            "app-service": "🌐",
          }[r.type] || "📎";

          const statusTag = r.manual
            ? '<span class="tag tag-warning">Manual</span>'
            : r.optional
            ? '<span class="tag">Optional</span>'
            : r.provisionable
            ? '<span class="tag tag-success">Auto</span>'
            : '<span class="tag tag-warning">Manual</span>';

          return `
            <div style="display: flex; align-items: center; gap: 10px; padding: 8px 12px; background: var(--bg); border-radius: 6px; margin-bottom: 4px;">
              <span style="font-size: 16px;">${typeIcon}</span>
              <div style="flex: 1;">
                <div style="font-size: 13px; font-weight: 500;">${r.name}</div>
                <div style="font-size: 11px; color: var(--text-muted);">${r.description}</div>
              </div>
              ${statusTag}
            </div>
          `;
        })
        .join("");

      return `
        <div style="margin-bottom: 16px;">
          <h4 style="font-size: 14px; margin-bottom: 8px;">Lab ${number}: ${lab.name}</h4>
          ${resources}
        </div>
      `;
    })
    .join("");
}

async function checkPrereqs() {
  const container = document.getElementById("prereq-results");
  container.innerHTML = '<div><span class="spinner"></span> Checking prerequisites...</div>';

  try {
    const res = await fetch("/api/provision/prerequisites");
    const data = await res.json();

    container.innerHTML = data.checks
      .map((c) => {
        const icon = c.ok ? "✅" : "❌";
        return `
          <div style="display: flex; align-items: center; gap: 8px; padding: 6px 0; font-size: 13px;">
            <span>${icon}</span>
            <strong>${c.label}</strong>
            <span style="color: var(--text-muted);">— ${c.detail}</span>
          </div>
        `;
      })
      .join("");

    if (data.ready) {
      toast("All prerequisites met — ready to deploy!", "success");
    } else {
      toast("Some prerequisites are missing. See details above.", "error");
    }
  } catch (err) {
    container.innerHTML = `<div style="color: var(--danger);">Failed: ${err.message}</div>`;
  }
}

async function deployResources() {
  if (activeProvisionJob?.status === "running") {
    toast("A deployment is already in progress.", "error");
    return;
  }

  const selected = [...includedLabs];
  if (!selected.length) {
    toast("No labs selected for deployment.", "error");
    return;
  }

  await ensureValidationBeforeAction("deployment", "deploy-status");

  const status = document.getElementById("deploy-status");
  const logContainer = document.getElementById("deploy-log");
  const logEntries = document.getElementById("deploy-log-entries");
  const baseName = document.getElementById("az-base-name").value || "copilot-labs";
  const location = document.getElementById("az-location").value;
  const subscriptionId = document.getElementById("az-subscription").value || undefined;
  const censusKey = document.getElementById("az-census-key").value || undefined;

  logContainer.style.display = "block";
  logEntries.innerHTML = "";
  status.innerHTML = '<span class="spinner"></span> Starting deployment...';
  setDeployButtonBusy(true);
  renderProvisionStatusBar({
    jobId: "pending",
    baseName,
    status: "running",
    totalSteps: 1,
    steps: [],
    summary: { deployed: 0, skipped: 0, failed: 0 },
    currentStep: { step: "starting-deployment", status: "running", detail: "Submitting deployment request..." },
  });

  try {
    const res = await fetch("/api/provision/deploy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        labs: selected,
        location,
        baseName,
        subscriptionId,
        envVars: censusKey ? { CENSUS_API_KEY: censusKey } : {},
      }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Deployment failed");

    lastProvisionTerminalState = "";
    saveActiveProvisionJob({ jobId: data.jobId, baseName, status: "running" });
    await refreshProvisionProgress(data.jobId);
  } catch (err) {
    status.textContent = `❌ ${err.message}`;
    logEntries.innerHTML += `<div style="color: var(--danger);">Error: ${escapeHtml(err.message)}</div>`;
    clearProvisionUi();
    status.textContent = `❌ ${err.message}`;
    toast("Deployment failed: " + err.message, "error");
  }
}

async function destroyResources() {
  const baseName = document.getElementById("az-base-name").value || "copilot-labs";
  if (!confirm(`This will DELETE the resource group "rg-${baseName}" and ALL resources in it. Are you sure?`)) return;

  const status = document.getElementById("deploy-status");
  status.innerHTML = '<span class="spinner"></span> Destroying resources...';

  try {
    const res = await fetch("/api/provision/destroy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseName }),
    });

    const data = await res.json();
    if (data.success) {
      status.textContent = `🗑️ ${data.detail}`;
      toast("Resource group deletion initiated", "success");
    } else {
      throw new Error(data.error || "Destroy failed");
    }
  } catch (err) {
    status.textContent = `❌ ${err.message}`;
    toast("Destroy failed: " + err.message, "error");
  }
}

async function checkDeployStatus() {
  const baseName = document.getElementById("az-base-name").value || "copilot-labs";
  const status = document.getElementById("deploy-status");
  const logContainer = document.getElementById("deploy-log");
  const logEntries = document.getElementById("deploy-log-entries");
  status.innerHTML = '<span class="spinner"></span> Checking...';

  try {
    const res = await fetch(`/api/provision/status/${baseName}`);
    const data = await res.json();

    if (!data.exists) {
      status.textContent = "ℹ️ No resources deployed yet";
      logContainer.style.display = "none";
      return;
    }

    logContainer.style.display = "block";
    logEntries.innerHTML = `
      <div style="padding: 3px 0;">📁 <strong>Resource Group:</strong> ${data.resourceGroup.name} (${data.resourceGroup.state})</div>
      <div style="padding: 3px 0;">📍 <strong>Location:</strong> ${data.resourceGroup.location}</div>
      <div style="padding: 3px 0; margin-top: 8px;"><strong>Resources (${data.resources.length}):</strong></div>
      ${data.resources
        .map((r) => {
          const icon = r.state === "Succeeded" ? "✅" : r.state === "Failed" ? "❌" : "🔄";
          const shortType = r.type.split("/").pop();
          return `<div style="padding: 2px 0;">${icon} ${r.name} <span style="color: var(--text-muted);">(${shortType})</span></div>`;
        })
        .join("")}
    `;

    status.textContent = `✅ ${data.resources.length} resource(s) in ${data.resourceGroup.name}`;
  } catch (err) {
    status.textContent = `❌ ${err.message}`;
  }
}

// ── Key Vault ─────────────────────────────────────────────────────────────
async function checkKeyVault() {
  const container = document.getElementById("keyvault-status");
  container.innerHTML = '<div><span class="spinner"></span> Checking Key Vault...</div>';

  try {
    const res = await fetch("/api/keyvault/status");
    const data = await res.json();

    if (!data.configured) {
      container.innerHTML = `
        <div style="padding: 8px 12px; background: rgba(251,191,36,0.1); border: 1px solid rgba(251,191,36,0.3); border-radius: 6px; font-size: 13px;">
          ⚠️ <strong>Key Vault not configured.</strong> Secrets are loaded from <code>.env</code> file.<br/>
          Set <code>AZURE_KEYVAULT_URL</code> in your environment to enable Key Vault integration.
        </div>`;
      return;
    }

    const secrets = data.secretMap
      .map((s) => {
        const icon = s.hasEnvValue ? "✅" : "⬜";
        return `<div style="padding: 2px 0; font-size: 13px;">${icon} <code>${s.envVar}</code> → <code>${s.secretName}</code></div>`;
      })
      .join("");

    container.innerHTML = `
      <div style="padding: 8px 12px; background: rgba(52,211,153,0.1); border: 1px solid rgba(52,211,153,0.3); border-radius: 6px; font-size: 13px;">
        🔐 <strong>Key Vault:</strong> ${data.vaultName}<br/>
        <div style="margin-top: 8px;">${secrets}</div>
      </div>`;
  } catch (err) {
    container.innerHTML = `<div style="color: var(--danger);">Failed: ${err.message}</div>`;
  }
}

async function syncToKeyVault() {
  if (!confirm("This will push your current .env secrets to Azure Key Vault. Continue?")) return;

  try {
    const res = await fetch("/api/keyvault/sync", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    const stored = data.results.filter((r) => r.status === "stored").length;
    const skipped = data.results.filter((r) => r.status === "skipped").length;
    toast(`Synced ${stored} secret(s) to Key Vault (${skipped} skipped)`, "success");
    checkKeyVault();
  } catch (err) {
    toast("Sync failed: " + err.message, "error");
  }
}

// ── Power Platform Admin ──────────────────────────────────────────────────

async function handlePPAuthResponse(res) {
  if (res.status === 401) {
    const data = await res.json();
    if (data.authRequired && data.deviceCode) {
      showDeviceCode(data.deviceCode);
      return null;
    }
  }
  return res;
}

function showDeviceCode(code) {
  const container = document.getElementById("pp-device-code");
  const msg = document.getElementById("pp-device-code-msg");
  container.style.display = "block";
  msg.innerHTML = `
    <p>To sign in, open <a href="${code.verificationUri}" target="_blank" style="color: var(--accent);">${code.verificationUri}</a> in your browser and enter code:</p>
    <div style="font-size: 24px; font-weight: 700; letter-spacing: 4px; margin: 12px 0; color: var(--accent);">${code.userCode}</div>
    <p style="font-size: 12px; color: var(--text-muted);">This code expires at ${new Date(code.expiresAt).toLocaleTimeString()}</p>
  `;
}

async function ppSignIn() {
  toast("Initiating device code sign-in... Check below for the code.", "success");
  await ppLoadEnvironments();
}

async function ppSignOut() {
  try {
    await fetch("/api/pp/auth/logout", { method: "POST" });
    document.getElementById("pp-auth-status").innerHTML = '<span class="tag tag-warning">Signed out</span>';
    document.getElementById("pp-device-code").style.display = "none";
    document.getElementById("pp-env-list").innerHTML = '<div style="text-align: center; padding: 20px; color: var(--text-muted);">Sign in to view environments</div>';
    toast("Signed out", "success");
  } catch (err) {
    toast("Sign out failed: " + err.message, "error");
  }
}

async function ppLoadEnvironments() {
  const container = document.getElementById("pp-env-list");
  container.innerHTML = '<div style="text-align: center; padding: 20px;"><span class="spinner"></span> Loading environments...</div>';

  try {
    const res = await fetch("/api/pp/environments");
    const handled = await handlePPAuthResponse(res);
    if (!handled) {
      container.innerHTML = '<div style="text-align: center; padding: 20px; color: var(--text-muted);">Complete the device code sign-in above, then click Refresh.</div>';
      return;
    }
    if (!handled.ok) throw new Error((await handled.json()).error);

    const data = await handled.json();
    const envs = data.environments || [];

    // Update auth status
    const authRes = await fetch("/api/pp/auth/status");
    const authData = await authRes.json();
    if (authData.authenticated) {
      document.getElementById("pp-auth-status").innerHTML = `<span class="tag tag-success">✅ Signed in as ${authData.user.username}</span>`;
      document.getElementById("pp-device-code").style.display = "none";
    }

    if (!envs.length) {
      container.innerHTML = '<div style="text-align: center; padding: 20px; color: var(--text-muted);">No environments found.</div>';
      return;
    }

    container.innerHTML = `
      <div style="overflow-x: auto;">
        <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
          <thead>
            <tr style="border-bottom: 1px solid var(--border);">
              <th style="padding: 8px; text-align: left; color: var(--text-muted);">Name</th>
              <th style="padding: 8px; text-align: left; color: var(--text-muted);">Type</th>
              <th style="padding: 8px; text-align: left; color: var(--text-muted);">State</th>
              <th style="padding: 8px; text-align: left; color: var(--text-muted);">Region</th>
              <th style="padding: 8px; text-align: left; color: var(--text-muted);">URL</th>
              <th style="padding: 8px; text-align: left; color: var(--text-muted);">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${envs.map((e) => `
              <tr style="border-bottom: 1px solid var(--border);">
                <td style="padding: 8px; font-weight: 500;">${e.displayName}</td>
                <td style="padding: 8px;"><span class="tag">${e.type}</span></td>
                <td style="padding: 8px;">${e.state === "Ready" ? "🟢" : "🟡"} ${e.state}</td>
                <td style="padding: 8px;">${e.region}</td>
                <td style="padding: 8px;">${e.url ? `<a href="${e.url}" target="_blank" style="color: var(--accent); font-size: 12px;">${e.domainName || "Open"}</a>` : "—"}</td>
                <td style="padding: 8px;">
                  <button class="btn btn-sm btn-danger" onclick="ppDeleteEnvironment('${e.id}', '${e.displayName.replace(/'/g, "\\'")}')">🗑️</button>
                </td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
      <div style="margin-top: 8px; font-size: 12px; color: var(--text-muted);">${envs.length} environment(s) found</div>
    `;
  } catch (err) {
    container.innerHTML = `<div style="color: var(--danger); padding: 12px;">Error: ${err.message}</div>`;
  }
}

function ppShowCreateEnv() {
  document.getElementById("pp-create-env-panel").style.display = "block";
}

async function ppCreateEnvironment() {
  const name = document.getElementById("pp-env-name").value.trim();
  if (!name) { toast("Environment name is required", "error"); return; }

  const status = document.getElementById("pp-create-status");
  status.innerHTML = '<span class="spinner"></span> Creating environment...';

  try {
    const res = await fetch("/api/pp/environments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        displayName: name,
        environmentType: document.getElementById("pp-env-type").value,
        location: document.getElementById("pp-env-region").value,
        language: document.getElementById("pp-env-lang").value,
        securityGroupId: document.getElementById("pp-env-sg").value || undefined,
      }),
    });

    const handled = await handlePPAuthResponse(res);
    if (!handled) { status.textContent = "Complete device code auth first"; return; }
    const data = await handled.json();
    if (!handled.ok) throw new Error(data.error);

    status.textContent = "✅ Environment created!";
    toast(`Environment "${name}" created successfully!`, "success");
    document.getElementById("pp-create-env-panel").style.display = "none";
    ppLoadEnvironments();
  } catch (err) {
    status.textContent = `❌ ${err.message}`;
    toast("Create failed: " + err.message, "error");
  }
}

async function ppDeleteEnvironment(envId, envName) {
  if (!confirm(`This will permanently DELETE the environment "${envName}". This cannot be undone. Are you sure?`)) return;

  try {
    const res = await fetch(`/api/pp/environments/${envId}`, { method: "DELETE" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    toast(`Environment "${envName}" deletion initiated`, "success");
    ppLoadEnvironments();
  } catch (err) {
    toast("Delete failed: " + err.message, "error");
  }
}

async function ppLoadSecureScore() {
  const container = document.getElementById("pp-secure-score");
  container.innerHTML = '<div><span class="spinner"></span> Loading Secure Score...</div>';

  try {
    const res = await fetch("/api/pp/secure-score");
    const handled = await handlePPAuthResponse(res);
    if (!handled) { container.innerHTML = "Complete device code auth first"; return; }
    const data = await handled.json();
    if (!handled.ok) throw new Error(data.error);

    if (data.source === "tenant-settings") {
      const settings = data.settings;
      const checks = [
        { label: "Trial env creation restricted", ok: settings.trialEnvironmentsDisabled },
        { label: "Production env creation restricted", ok: settings.productionEnvironmentsDisabled },
        { label: "Tenant isolation enabled", ok: settings.tenantIsolation },
        { label: "Share with Everyone disabled", ok: settings.shareWithEveryoneDisabled },
        { label: "DLP enforcement enabled", ok: settings.dlpEnabled },
      ];
      const score = Math.round((checks.filter((c) => c.ok).length / checks.length) * 100);

      container.innerHTML = `
        <div style="display: flex; align-items: center; gap: 20px; margin-bottom: 16px;">
          <div style="width: 80px; height: 80px; border-radius: 50%; border: 4px solid ${score >= 80 ? "var(--success)" : score >= 50 ? "var(--warning)" : "var(--danger)"}; display: flex; align-items: center; justify-content: center; font-size: 24px; font-weight: 700;">
            ${score}%
          </div>
          <div>
            <div style="font-size: 18px; font-weight: 600;">Security Score</div>
            <div style="color: var(--text-muted); font-size: 13px;">${checks.filter((c) => c.ok).length} of ${checks.length} checks passing</div>
          </div>
        </div>
        ${checks.map((c) => `
          <div style="display: flex; align-items: center; gap: 8px; padding: 6px 0; font-size: 13px;">
            <span>${c.ok ? "✅" : "❌"}</span>
            <span>${c.label}</span>
          </div>
        `).join("")}
      `;
    } else {
      container.innerHTML = `<pre style="font-size: 12px; color: var(--text-muted);">${JSON.stringify(data, null, 2)}</pre>`;
    }
  } catch (err) {
    container.innerHTML = `<div style="color: var(--danger);">Error: ${err.message}</div>`;
  }
}

async function ppLoadRecommendations() {
  const container = document.getElementById("pp-recommendations");
  container.innerHTML = '<div><span class="spinner"></span> Loading recommendations...</div>';

  try {
    const res = await fetch("/api/pp/recommendations");
    const handled = await handlePPAuthResponse(res);
    if (!handled) { container.innerHTML = "Complete device code auth first"; return; }
    const data = await handled.json();
    if (!handled.ok) throw new Error(data.error);

    const recs = data.recommendations || [];
    if (!recs.length) {
      container.innerHTML = '<div style="color: var(--success);">✅ No recommendations — security posture looks good!</div>';
      return;
    }

    container.innerHTML = recs.map((r) => {
      const sevColor = { High: "var(--danger)", Medium: "var(--warning)", Info: "var(--accent)" }[r.severity] || "var(--text-muted)";
      return `
        <div style="background: var(--bg); border: 1px solid var(--border); border-left: 3px solid ${sevColor}; border-radius: 8px; padding: 14px 16px; margin-bottom: 8px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
            <div style="font-weight: 600; font-size: 14px;">${r.title}</div>
            <span class="tag ${r.severity === "High" ? "tag-danger" : r.severity === "Medium" ? "tag-warning" : ""}">${r.severity}</span>
          </div>
          <div style="font-size: 13px; color: var(--text-muted); margin-bottom: 8px;">${r.description}</div>
          <div style="font-size: 12px; margin-bottom: 8px;"><strong>Remediation:</strong> ${r.remediation || "N/A"}</div>
          ${r.canAutoRemediate
            ? `<button class="btn btn-sm btn-primary" onclick="ppRemediate('${r.id}')">🔧 Auto-Remediate</button>`
            : '<span class="tag tag-warning">Manual action required</span>'}
        </div>
      `;
    }).join("");
  } catch (err) {
    container.innerHTML = `<div style="color: var(--danger);">Error: ${err.message}</div>`;
  }
}

async function ppRemediate(recId) {
  if (!confirm(`Apply remediation for "${recId}"? This will modify tenant-level settings.`)) return;

  try {
    const res = await fetch("/api/pp/remediate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recommendationId: recId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    toast("Remediation applied successfully!", "success");
    ppLoadSecureScore();
    ppLoadRecommendations();
  } catch (err) {
    toast("Remediation failed: " + err.message, "error");
  }
}

function ppScheduleTask() {
  const task = document.getElementById("pp-sched-task").value;
  const freq = document.getElementById("pp-sched-freq").value;
  const email = document.getElementById("pp-sched-email").value;
  const taskNames = {
    "env-audit": "Environment Audit",
    "security-scan": "Security Scan",
    "capacity-check": "Capacity Check",
    "cleanup-unused": "Unused Environment Cleanup",
  };

  const list = document.getElementById("pp-sched-list");
  const id = Date.now();
  list.innerHTML += `
    <div id="sched-${id}" style="display: flex; align-items: center; gap: 12px; padding: 8px 12px; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; margin-bottom: 4px; font-size: 13px;">
      <span>📅</span>
      <span style="flex: 1;"><strong>${taskNames[task]}</strong> — ${freq}${email ? ` → ${email}` : ""}</span>
      <span class="tag tag-success">Active</span>
      <button class="btn btn-sm" onclick="document.getElementById('sched-${id}').remove()">✗</button>
    </div>
  `;
  toast(`Scheduled "${taskNames[task]}" (${freq})`, "success");
}
