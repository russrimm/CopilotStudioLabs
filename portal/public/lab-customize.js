/**
 * Saved-lab "Customize" section: shows a generated lab's brand profile and
 * per-lab overrides, and offers "Save", "Update from profile", and "Reset to
 * profile". Loaded after generated-labs.js, which calls
 * `lbRenderLabCustomizeSection(labId)` when a lab is opened.
 */

const LB_GL_OVERRIDE_KEYS = [
  "companyName",
  "tagline",
  "moreInfoUrl",
  "moreInfoLabel",
  "supportName",
  "supportEmail",
  "footerText",
  "defaultSharepointSiteName",
  "defaultSharepointSiteUrl",
];

const LB_GL_FIELD_LABELS = {
  companyName: "Company name",
  tagline: "Tagline",
  moreInfoUrl: "More information URL",
  moreInfoLabel: "More information label",
  supportName: "Support contact name",
  supportEmail: "Support email",
  footerText: "Footer text",
  defaultSharepointSiteName: "SharePoint site name",
  defaultSharepointSiteUrl: "SharePoint site URL",
};

const lbCustomizeState = { labId: null, open: false, busy: false };

function lbGlEscape(value) {
  return typeof escapeHtml === "function"
    ? escapeHtml(value)
    : String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

function lbRenderLabCustomizeHtml(data, profiles) {
  const options = profiles
    .map((p) => {
      const selected = p.id === data.profileId ? " selected" : "";
      return `<option value="${lbGlEscape(p.id)}"${selected}>${lbGlEscape(p.name)}${p.id === data.activeProfileId ? " (active)" : ""}</option>`;
    })
    .join("");
  const missing = data.profileId && !profiles.some((p) => p.id === data.profileId)
    ? `<option value="${lbGlEscape(data.profileId)}" selected>${lbGlEscape(data.profileName || data.profileId)} (deleted)</option>`
    : "";
  const noProfile = !data.customized ? '<option value="" selected>Follows the active profile</option>' : "";
  const fields = LB_GL_OVERRIDE_KEYS.map((key) => {
    const value = data.overrides?.[key] || "";
    const inherited = data.effective?.[key] ? String(data.effective[key]) : "Uses the profile value";
    const inputType = key === "supportEmail" ? "email" : "text";
    return `<div class="form-group">
        <label for="gl-ov-${key}">${lbGlEscape(LB_GL_FIELD_LABELS[key])}</label>
        <input type="${inputType}" id="gl-ov-${key}" data-gl-ov="${key}" autocomplete="off" value="${lbGlEscape(value)}" placeholder="${lbGlEscape(inherited)}" aria-describedby="gl-ov-${key}-error" />
        <p class="bp-error" id="gl-ov-${key}-error" role="alert"></p>
      </div>`;
  }).join("");
  const notes = [];
  if (data.customized && !data.profileExists) {
    notes.push("The profile this lab used was deleted. The lab keeps its saved copy; choose another profile to refresh it.");
  } else if (data.profileChangedSinceSnapshot) {
    notes.push("The profile changed after this lab was built. Use “Update from profile” to apply the changes.");
  }
  if (!data.customized) notes.push("This lab has no saved customization yet, so it follows the active profile.");
  const preview = typeof renderBrandPreviewHtml === "function" && data.effective
    ? `<div><h5 class="bp-pv-heading">Cover preview</h5>${renderBrandPreviewHtml(data.effective, { labTitle: "" })}</div>`
    : "";
  return `<summary>Customize this lab (branding)</summary>
    <div class="gl-customize-body">
      <p class="hint" style="margin: 0;">Pick a brand profile and override details for this lab only. Leave a field blank to use the profile value.</p>
      ${notes.map((n) => `<p class="lb-feature-note" role="status">${lbGlEscape(n)}</p>`).join("")}
      <div class="form-grid">
        <div class="form-group">
          <label for="gl-brand-profile">Brand profile</label>
          <select id="gl-brand-profile">${noProfile}${missing}${options}</select>
        </div>
        ${fields}
      </div>
      <div class="branding-actions">
        <button type="button" class="btn btn-primary btn-sm" data-gl-customize="save">Save customization</button>
        <button type="button" class="btn btn-sm" data-gl-customize="update-from-profile"${data.customized && data.profileExists ? "" : " disabled"}>Update from profile</button>
        <button type="button" class="btn btn-sm" data-gl-customize="reset"${data.customized && data.profileExists ? "" : " disabled"}>Reset to profile</button>
        <span id="gl-customize-status" role="status" aria-live="polite" style="font-size: 13px; color: var(--text-muted);"></span>
      </div>
      ${preview}
    </div>`;
}

async function lbFetchJson(url, init) {
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || `Request failed (${res.status})`);
    error.fieldErrors = data.errors || null;
    throw error;
  }
  return data;
}

function lbCustomizeStatus(message) {
  const el = document.getElementById("gl-customize-status");
  if (el) el.textContent = message;
}

/** Collect the profile choice and non-blank overrides from the section. */
function lbReadCustomizeForm() {
  const select = document.getElementById("gl-brand-profile");
  const overrides = {};
  let firstInvalid = null;
  for (const key of LB_GL_OVERRIDE_KEYS) {
    const input = document.getElementById(`gl-ov-${key}`);
    const errorEl = document.getElementById(`gl-ov-${key}-error`);
    const value = String(input?.value ?? "").trim();
    const message = value && typeof brandValidateField === "function" ? brandValidateField(key, value) : "";
    if (errorEl) errorEl.textContent = message;
    if (message) {
      input?.setAttribute("aria-invalid", "true");
      if (!firstInvalid) firstInvalid = input;
    } else {
      input?.removeAttribute("aria-invalid");
    }
    if (value) overrides[key] = value;
  }
  return { profileId: select?.value || undefined, overrides, firstInvalid };
}

async function lbSubmitCustomize(labId, action) {
  if (lbCustomizeState.busy) return;
  let body;
  if (action === "save") {
    const form = lbReadCustomizeForm();
    if (form.firstInvalid) {
      form.firstInvalid.focus();
      lbCustomizeStatus("Fix the highlighted fields and try again.");
      return;
    }
    body = { overrides: form.overrides, ...(form.profileId ? { profileId: form.profileId } : {}) };
  } else {
    body = { action };
  }
  lbCustomizeState.busy = true;
  lbCustomizeStatus("Saving...");
  try {
    await lbFetchJson(`/api/lab-builder/generated/${encodeURIComponent(labId)}/customization`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    lbCustomizeState.busy = false;
    await lbRenderLabCustomizeSection(labId);
    lbCustomizeStatus(action === "save" ? "Customization saved." : action === "reset" ? "Reset to the profile." : "Updated from the profile.");
    if (typeof toast === "function") toast("Lab customization saved.", "success");
    if (typeof lbLoadResultPreview === "function") lbLoadResultPreview(labId).catch(() => {});
  } catch (err) {
    lbCustomizeState.busy = false;
    for (const [key, message] of Object.entries(err.fieldErrors || {})) {
      const errorEl = document.getElementById(`gl-ov-${key}-error`);
      if (errorEl) errorEl.textContent = message;
      document.getElementById(`gl-ov-${key}`)?.setAttribute("aria-invalid", "true");
    }
    lbCustomizeStatus(err.message);
  }
}

/** Render (or refresh) the Customize disclosure above the preview of an opened lab. */
async function lbRenderLabCustomizeSection(labId) {
  const body = document.getElementById("lb-result-body");
  if (!body || !labId) return;
  let host = document.getElementById("lb-result-customize");
  if (!host) {
    host = document.createElement("details");
    host.id = "lb-result-customize";
    host.className = "lb-advanced gl-customize";
    const anchor = document.getElementById("lb-result-preview");
    if (anchor) body.insertBefore(host, anchor);
    else body.appendChild(host);
  }
  if (lbCustomizeState.labId !== labId) lbCustomizeState.open = false;
  lbCustomizeState.labId = labId;
  const wasOpen = lbCustomizeState.open || host.open;
  host.setAttribute("aria-busy", "true");
  try {
    const [data, profileList] = await Promise.all([
      lbFetchJson(`/api/lab-builder/generated/${encodeURIComponent(labId)}/customization`),
      lbFetchJson("/api/branding/profiles"),
    ]);
    if (lbCustomizeState.labId !== labId) return;
    host.innerHTML = lbRenderLabCustomizeHtml({ ...data, activeProfileId: data.activeProfileId || profileList.activeProfileId }, profileList.profiles || []);
    host.open = wasOpen;
    host.addEventListener("toggle", () => {
      lbCustomizeState.open = host.open;
    });
    host.querySelectorAll("[data-gl-customize]").forEach((button) => {
      button.addEventListener("click", () => lbSubmitCustomize(labId, button.dataset.glCustomize));
    });
  } catch (err) {
    host.innerHTML = `<summary>Customize this lab (branding)</summary><p class="lb-error" role="alert">Could not load the customization: ${lbGlEscape(err.message)}</p>`;
  } finally {
    host.removeAttribute("aria-busy");
  }
}
