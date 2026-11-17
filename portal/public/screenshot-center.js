// Screenshot Center: the panel in an opened lab that captures, checks, and updates its screenshots.
// It renders the readiness strip, the one adaptive primary action, live capture
// progress, the thumbnail gallery with per-shot actions, the preview dialog, the
// Advanced options, and the capture-on-build checkbox in Step 8.
// All DOM is built with createElement and textContent; nothing from the network
// (file names, captions, messages) is ever parsed as HTML.
// Network calls live in screenshot-center-jobs.js, pure decisions in screenshot-center-core.js.

const SC_HOST_ID = "lb-result-screenshots";
const SC_CHIP_TONES = ["ok", "warn", "bad", "info", "neutral"];

// ── Small DOM helpers ───────────────────────────────────────────────────────

function scEl(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.id) el.id = props.id;
  if (props.text !== undefined && props.text !== null) el.textContent = String(props.text);
  for (const [name, value] of Object.entries(props.attrs || {})) {
    if (value !== undefined && value !== null && value !== false) el.setAttribute(name, value === true ? "" : String(value));
  }
  for (const [name, value] of Object.entries(props.data || {})) {
    if (value !== undefined && value !== null) el.dataset[name] = String(value);
  }
  for (const child of [].concat(children)) {
    if (child) el.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return el;
}

function scChip(text, tone = "neutral", extra = "") {
  return scEl("span", { class: `sc-chip sc-chip-${SC_CHIP_TONES.includes(tone) ? tone : "neutral"}${extra ? ` ${extra}` : ""}`, text });
}

function scButton(label, { action = "", data = {}, primary = false, small = true, disabled = false, aria = {}, focus = "", needsIdle = false } = {}) {
  const attrs = { type: "button", ...aria };
  if (disabled) attrs.disabled = true;
  if (needsIdle) attrs["data-sc-needs-idle"] = "1";
  return scEl("button", {
    class: `btn${small ? " btn-sm" : ""}${primary ? " btn-primary" : ""}`,
    text: label,
    attrs,
    data: { scAction: action || undefined, scFocus: focus || undefined, ...data },
  });
}

function scLabel(forId, text) {
  return scEl("label", { text, attrs: { for: forId } });
}

async function scCopyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function scHostFor(labId) {
  const host = document.getElementById(SC_HOST_ID);
  return host && host.querySelector("[data-sc-root]")?.dataset.labId === labId ? host : null;
}

function scFocusByKey(root, key) {
  if (!key || !root) return;
  for (const el of root.querySelectorAll("[data-sc-focus]")) {
    if (el.dataset.scFocus === key) {
      el.focus({ preventScroll: true });
      return;
    }
  }
}

function scActiveFocusKey(root) {
  const active = document.activeElement;
  return active && root && root.contains(active) ? active.dataset?.scFocus || "" : "";
}

// ── The model each render decides from ──────────────────────────────────────

function scProfileStore() {
  return typeof brandProfiles !== "undefined" && brandProfiles && brandProfiles.loaded ? brandProfiles : null;
}

function scTenantModel(labId) {
  const lab = scLab(labId);
  const store = scProfileStore();
  const source = lab.ui.tenantSource || "lab";
  let names = [];
  if (source.startsWith("profile:")) {
    names = scAddressNames(store?.profiles?.find((p) => p.id === source.slice("profile:".length)) || {});
  } else if (source !== "none" && lab.brand?.customized) {
    names = lab.brand.names || [];
  }
  let suggestion = null;
  if (!names.length && source !== "none" && store) {
    const active = store.profiles.find((p) => p.id === store.activeProfileId);
    const activeNames = scAddressNames(active || {});
    if (active && activeNames.length) suggestion = { id: active.id, name: active.name, names: activeNames };
  }
  return { names, serverSet: Boolean(scState.status?.tenantUrls?.set), suggestion };
}

function scProductsToSignIn(state) {
  const ids = new Set();
  for (const shot of Array.isArray(state?.shots) ? state.shots : []) {
    const { key } = scShotStatus(shot);
    if (shot.product && (key === "pending" || key === "failed" || key === "outdated")) ids.add(String(shot.product));
  }
  return [...ids].map((id) => ({ id, name: scProductName(id) }));
}

function scBuildModel(labId) {
  const lab = scLab(labId);
  const state = lab.state || {};
  const companion = scState.status?.companion || {};
  const devices = Array.isArray(companion.devices) ? companion.devices : [];
  const connected = Boolean(companion.connected);
  const model = {
    labId,
    state,
    counts: scCounts(state),
    checkState: scCheckStateOf(state),
    statusLoading: !scState.status && !scState.statusError,
    statusError: !scState.status && Boolean(scState.statusError),
    connected,
    deviceNames: devices.filter((d) => d.connected).map((d) => d.name),
    signedIn: Array.isArray(companion.signedInProducts) ? companion.signedInProducts : [],
    products: scProductsToSignIn(state),
    tenant: scTenantModel(labId),
    job: lab.job,
  };
  model.primary = scPrimaryAction(model);
  model.primaryAction = model.primary.action;
  model.steps = scBuildSteps(model);
  return model;
}

// ── Rendering ───────────────────────────────────────────────────────────────

/**
 * Render the Screenshot Center into `host`.
 * @param {HTMLElement} host the `#lb-result-screenshots` container
 * @param {string} labId
 * @param {object} state `GET .../screenshots`
 * @param {object|null} outcome a message to show: `{ type, variant, message, jobId, actions }`
 */
function scRenderCenter(host, labId, state, outcome = null) {
  if (!host || !labId) return;
  const lab = scLab(labId);
  if (!state || typeof state !== "object") {
    host.replaceChildren();
    return;
  }
  lab.state = state;
  if (outcome && typeof outcome === "object") lab.outcome = outcome;
  if (lab.brand?.loaded && Date.now() - (lab.brand.loadedAt || 0) > 20000) lab.brand = null;
  scRenderInto(host, labId);
  scEnsureSetup(labId);
  if (typeof lbChecklistRefresh === "function") lbChecklistRefresh(labId);
}

function scRenderInto(host, labId) {
  const lab = scLab(labId);
  if (!lab.state) return;
  const focusKey = scActiveFocusKey(host);
  const model = scBuildModel(labId);

  const section = scEl("section", {
    class: `sc-center${lab.ui.scope === "selected" ? " sc-selecting" : ""}`,
    attrs: { "aria-labelledby": "lb-screenshots-heading" },
    data: { scRoot: "1", labId },
  });
  section.appendChild(scBuildHeader(model));
  section.appendChild(
    scEl("p", {
      class: "sc-intro",
      text: "Real screenshots from your own tenant make this lab easy to follow. We capture them on your computer, check each one, and update your lab for you.",
    }),
  );
  const banner = scBuildBanner(labId);
  if (banner) section.appendChild(banner);
  section.appendChild(scBuildStrip(model));
  section.appendChild(scEl("div", { class: "sc-pairing-host", data: { scPairingHost: "lab" } }));
  section.appendChild(scBuildPrimary(model, lab));
  section.appendChild(scEl("div", { class: "sc-progress-host", data: { scProgressHost: labId } }));
  section.appendChild(scBuildAdvanced(labId, model));
  section.appendChild(scBuildGallery(labId, model));
  section.appendChild(scBuildLightbox(labId));
  section.appendChild(scBuildFileInput());
  scBindSection(section, labId);

  const old = host.querySelector("[data-sc-root]");
  let live = host.querySelector("#lb-screenshots-live");
  if (!live) {
    live = scEl("div", { id: "lb-screenshots-live", class: "sr-only", attrs: { role: "status", "aria-live": "polite", "aria-atomic": "true" } });
    host.replaceChildren(live);
  }
  if (old) old.replaceWith(section);
  else host.appendChild(section);
  scRefreshPairingUi();
  scUpdateProgress(labId);
  if (lab.lightbox) scOpenLightbox(labId, lab.lightbox, { restore: true });
  scFocusByKey(host, focusKey);
}

function scRerender(key) {
  if (key === "library") {
    scRenderLibraryHost();
    return;
  }
  const host = scHostFor(key);
  if (host) scRenderInto(host, key);
}

function scRerenderOpenCenter() {
  const labId = document.getElementById(SC_HOST_ID)?.querySelector("[data-sc-root]")?.dataset.labId;
  if (labId) scRerender(labId);
}

/** Load what a render needs and has not got yet, then render once more. */
function scEnsureSetup(labId) {
  const lab = scLab(labId);
  const stale = Date.now() - (scState.ensureAt || 0) > SC_STATUS_TTL_MS;
  if (!scState.status || stale) {
    scState.ensureAt = Date.now();
    const had = Boolean(scState.status);
    const before = scIsConnected();
    void scLoadStatus(true).then(() => {
      if (!had || before !== scIsConnected()) scNotifyStatusChanged();
    });
  }
  if (!lab.brand) void scLoadLabBrand(labId);
  const store = scProfileStore();
  if (!store && typeof bpEnsureLoaded === "function" && !scState.profilesRequested) {
    scState.profilesRequested = true;
    Promise.resolve(bpEnsureLoaded())
      .then(() => scRerender(labId))
      .catch(() => {});
  }
  void scResumeJobs(labId);
}

function scBuildHeader(model) {
  const { counts, checkState } = model;
  const header = scEl("div", { class: "sc-header" });
  header.appendChild(scEl("h4", { id: "lb-screenshots-heading", class: "sc-heading", text: "Screenshot Center", attrs: { tabindex: "-1" } }));
  const pills = scEl("div", { class: "sc-pills" });
  pills.appendChild(scChip(`${counts.captured} of ${counts.total} screenshots captured`, counts.total > 0 && counts.captured === counts.total && !counts.outdated ? "ok" : "neutral"));
  const waiting = counts.toCapture + counts.manual;
  if (waiting) pills.appendChild(scChip(`${waiting} waiting`, "warn"));
  if (counts.outdated) pills.appendChild(scChip(`${counts.outdated} outdated`, "warn"));
  if (counts.needsReview) pills.appendChild(scChip(`${counts.needsReview} need review`, "warn"));
  const changed = scCount(model.state?.summary?.docsUpdatedModules) || scCount(model.state?.summary?.stale);
  pills.appendChild(scChip(`Microsoft Learn: ${scCheckLabel(checkState, changed)}`, scCheckTone(checkState), "sc-chip-learn"));
  const checkedAt = model.state?.lastRevalidatedAt || model.state?.summary?.lastRevalidatedAt;
  const checkedDate = checkedAt ? new Date(checkedAt) : null;
  if (checkedDate && !Number.isNaN(checkedDate.getTime())) {
    pills.appendChild(scChip(`Checked ${checkedDate.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`, "neutral"));
  }
  header.appendChild(pills);
  return header;
}

function scBuildBanner(labId) {
  const lab = scLab(labId);
  const outcome = lab.outcome;
  if (!outcome?.message) return null;
  const variant = outcome.variant === "ok" ? "ok" : outcome.variant === "warn" ? "warn" : "error";
  const banner = scEl("div", { class: `sc-banner sc-banner-${variant}`, data: { scBanner: "1" } });
  banner.appendChild(scEl("p", { class: "sc-banner-text", text: outcome.message }));
  const actions = scEl("div", { class: "sc-banner-actions" });
  for (const act of Array.isArray(outcome.actions) ? outcome.actions : []) {
    actions.appendChild(scButton(act.label, { action: `banner-${act.id}`, data: { filenames: (act.filenames || []).join(",") } }));
  }
  actions.appendChild(scButton("Dismiss", { action: "banner-dismiss", focus: "banner-dismiss", aria: { "aria-label": "Dismiss this message" } }));
  banner.appendChild(actions);
  return banner;
}

// Readiness strip ------------------------------------------------------------

const SC_STEP_STATE_LABEL = Object.freeze({ done: "Done", todo: "To do", optional: "Optional", locked: "Waiting", loading: "Checking", error: "Problem" });
const SC_STEP_STATE_TONE = Object.freeze({ done: "ok", todo: "warn", optional: "neutral", locked: "neutral", loading: "info", error: "bad" });

function scBuildStrip(model) {
  const list = scEl("ol", { class: "sc-steps", attrs: { "aria-label": "Set up screenshot capture in three steps" } });
  model.steps.forEach((step, index) => {
    const li = scEl("li", { class: "sc-step", data: { state: step.state, step: step.id } });
    li.appendChild(scEl("span", { class: "sc-step-num", text: step.state === "done" ? "\u2713" : String(index + 1), attrs: { "aria-hidden": "true" } }));
    const body = scEl("div", { class: "sc-step-body" });
    const title = scEl("h5", { class: "sc-step-title" });
    title.appendChild(scEl("span", { text: `Step ${index + 1}: ${step.title}` }));
    title.appendChild(scChip(SC_STEP_STATE_LABEL[step.state] || "To do", SC_STEP_STATE_TONE[step.state] || "neutral"));
    body.appendChild(title);
    body.appendChild(scEl("p", { class: "sc-step-detail", text: step.detail }));
    if (step.id === "signin" && step.state === "todo") {
      body.appendChild(scEl("p", { class: "sc-step-help", text: "You only do this once for each product." }));
    }
    if (step.action) {
      body.appendChild(
        scEl("div", { class: "sc-step-actions" }, [
          scButton(step.action.label, { action: `step-${step.action.id}`, data: { profileId: step.action.profileId }, focus: `step-${step.id}` }),
        ]),
      );
    }
    if (step.id === "connect") {
      const devices = Array.isArray(scState.status?.companion?.devices) ? scState.status.companion.devices : [];
      if (devices.length) body.appendChild(scBuildDevices(devices));
    }
    li.appendChild(body);
    list.appendChild(li);
  });
  return list;
}

function scBuildDevices(devices) {
  const details = scEl("details", { class: "sc-devices" });
  details.appendChild(scEl("summary", { text: `Your computers (${devices.length})` }));
  const ul = scEl("ul", { class: "sc-device-list" });
  for (const device of devices) {
    const li = scEl("li", { class: "sc-device" });
    li.appendChild(scEl("span", { class: "sc-device-name", text: String(device.name || "Unnamed computer") }));
    li.appendChild(scChip(device.connected ? "Connected" : "Offline", device.connected ? "ok" : "neutral"));
    const seen = scTimeAgo(device.lastSeenAt);
    const meta = [device.platform ? String(device.platform) : "", seen ? `last seen ${seen}` : "not seen yet"].filter(Boolean).join(", ");
    li.appendChild(scEl("span", { class: "sc-device-meta", text: meta }));
    if (/^dev_[a-f0-9]{12}$/.test(String(device.id || ""))) {
      li.appendChild(
        scButton("Disconnect", {
          action: "disconnect-device",
          data: { deviceId: device.id, deviceName: device.name || "this computer" },
          focus: `device:${device.id}`,
          aria: { "aria-label": `Disconnect ${device.name || "this computer"}` },
        }),
      );
    }
    ul.appendChild(li);
  }
  details.appendChild(ul);
  return details;
}

// Pairing card ---------------------------------------------------------------

function scBuildPairingCard() {
  const p = scState.pairing;
  const card = scEl("div", { class: "sc-pairing", attrs: { role: "group", "aria-labelledby": "sc-pair-heading" } });
  card.appendChild(scEl("h5", { id: "sc-pair-heading", class: "sc-pair-heading", text: "Connect your computer", attrs: { tabindex: "-1" } }));

  if (p.status === "connected") {
    card.appendChild(scEl("p", { class: "sc-pair-success", text: `Connected: ${p.deviceName}. You are ready to capture screenshots.` }));
    card.appendChild(scButton("Done", { action: "pair-close", focus: "pair-close", primary: true }));
    return card;
  }
  if (p.status === "issuing") {
    card.appendChild(scEl("p", { class: "sc-pair-wait", text: "Getting your pairing code" }));
    return card;
  }
  if (p.status === "error") {
    card.appendChild(scEl("p", { class: "sc-pair-error", text: `We could not get a pairing code. ${p.error}` }));
    const row = scEl("div", { class: "sc-step-actions" });
    row.appendChild(scButton("Try again", { action: "pair-new", focus: "pair-new" }));
    row.appendChild(scButton("Close", { action: "pair-close", focus: "pair-close" }));
    card.appendChild(row);
    return card;
  }

  const steps = scEl("ol", { class: "sc-pair-steps" });
  const download = scEl("li");
  download.appendChild(scEl("span", { text: "Download the Local Capture Companion. It holds no passwords or keys. " }));
  const href = scSafePortalPath(scState.status?.companion?.downloadUrl, "/api/capture/companion.zip");
  download.appendChild(scEl("a", { class: "btn btn-sm", text: "Download the companion (ZIP)", attrs: { href, download: "" } }));
  steps.appendChild(download);

  const codeItem = scEl("li");
  codeItem.appendChild(scEl("span", { text: "Unzip it and run the launcher. When it asks for a pairing code, enter this one:" }));
  const codeRow = scEl("div", { class: "sc-code-row" });
  codeRow.appendChild(scEl("code", { class: "sc-code", text: p.code, attrs: { "aria-label": `Pairing code ${p.code.split("").join(" ")}` } }));
  codeRow.appendChild(scButton("Copy code", { action: "pair-copy-code", focus: "pair-copy-code" }));
  codeItem.appendChild(codeRow);
  steps.appendChild(codeItem);

  if (p.command) {
    const cmdItem = scEl("li");
    cmdItem.appendChild(scEl("span", { text: "Or run this ready-made command:" }));
    const cmdRow = scEl("div", { class: "sc-code-row" });
    cmdRow.appendChild(scEl("code", { class: "sc-command", text: p.command }));
    cmdRow.appendChild(scButton("Copy command", { action: "pair-copy-command", focus: "pair-copy-command" }));
    cmdItem.appendChild(cmdRow);
    steps.appendChild(cmdItem);
  }
  card.appendChild(steps);

  if (p.status === "expired") {
    card.appendChild(scEl("p", { class: "sc-pair-error", text: "This code expired. Get a new one to continue." }));
  } else {
    const left = scCountdown(p.expiresAt);
    card.appendChild(scEl("p", { class: "sc-pair-timer", text: `Code expires in ${left.text}`, data: { scPairTimer: "1" } }));
    card.appendChild(scEl("p", { class: "sc-pair-wait", text: "Waiting for your computer. This page notices the moment it connects." }));
  }
  const row = scEl("div", { class: "sc-step-actions" });
  row.appendChild(scButton("Get a new code", { action: "pair-new", focus: "pair-new" }));
  row.appendChild(scButton("Close", { action: "pair-close", focus: "pair-close" }));
  card.appendChild(row);
  return card;
}

/** Show (or clear) the pairing card in every place that can hold one. */
function scRefreshPairingUi() {
  const p = scState.pairing;
  for (const host of document.querySelectorAll("[data-sc-pairing-host]")) {
    const mine = p && (p.context?.source || "lab") === host.dataset.scPairingHost;
    const focusKey = scActiveFocusKey(host);
    if (mine) host.replaceChildren(scBuildPairingCard());
    else host.replaceChildren();
    scFocusByKey(host, focusKey);
  }
}

function scFocusPairing() {
  const heading = document.getElementById("sc-pair-heading");
  if (!heading) return;
  heading.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  heading.focus?.({ preventScroll: true });
}

// Primary action -------------------------------------------------------------

function scBuildPrimary(model, lab) {
  const primary = model.primary;
  const wrap = scEl("div", { class: "sc-primary" });
  const disabled = primary.disabled || Boolean(lab.busy);
  const busyLabel = lab.busy === "queue" ? "Starting capture" : lab.busy === "recheck" ? "Checking Microsoft Learn" : "";
  const label = busyLabel || primary.label;
  const button = scEl("button", {
    class: `btn btn-primary sc-primary-btn${primary.action === "done" ? " sc-primary-done" : ""}`,
    text: primary.action === "done" ? `\u2713 ${label}` : label,
    attrs: { type: "button", "aria-describedby": "sc-primary-help", disabled: disabled || false, "aria-busy": busyLabel || primary.action === "busy" ? "true" : false },
    data: { scAction: `primary-${primary.action}`, scFocus: "primary" },
  });
  wrap.appendChild(button);
  wrap.appendChild(scEl("p", { id: "sc-primary-help", class: "sc-primary-help", text: primary.help }));
  return wrap;
}

// Progress card --------------------------------------------------------------

function scProgressView(key) {
  const lab = scLab(key);
  const view = scDescribeJob(lab.job, {
    companionConnected: scState.status?.companion ? Boolean(scState.status.companion.connected) : null,
    nowMs: Date.now(),
    onlineWindowSec: Number(scState.status?.companion?.onlineWindowSec) || 90,
  });
  const started = Date.parse(lab.job?.startedAt || lab.job?.createdAt || "");
  view.elapsed = Number.isFinite(started) ? scFormatDuration((Date.now() - started) / 1000) : "0:00";
  return view;
}

function scCurrentShotName(key, view) {
  const shot = (scLab(key).state?.shots || []).find((s) => s.filename === view.currentFilename);
  if (!shot) return view.currentFilename || "";
  return `${shot.figure ? `Figure ${shot.figure}: ` : ""}${shot.caption || shot.filename}`;
}

function scProgressText(key, view) {
  const c = view.counts;
  const parts = [`${view.percent}%`, `${c.done} of ${c.total} done`, `Elapsed ${view.elapsed}`];
  return parts.join(" \u00b7 ");
}

function scBuildProgressCard(key, view) {
  const lab = scLab(key);
  const card = scEl("section", {
    class: `sc-progress sc-progress-${view.tone}`,
    attrs: { "aria-labelledby": `sc-progress-heading-${key}` },
    data: { phase: view.phase, jobId: lab.job.id },
  });
  card.appendChild(scEl("h5", { id: `sc-progress-heading-${key}`, class: "sc-progress-heading", text: view.headline, attrs: { tabindex: "-1" }, data: { scFocus: "progress-heading" } }));
  const bar = scEl("div", {
    class: "sc-bar",
    attrs: { role: "progressbar", "aria-label": "Capture progress", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(view.percent), "aria-valuetext": `${view.percent} percent, ${view.counts.done} of ${view.counts.total} screenshots done` },
  });
  const fill = scEl("div", { class: "sc-bar-fill" });
  fill.style.width = `${view.percent}%`;
  bar.appendChild(fill);
  card.appendChild(bar);
  card.appendChild(scEl("p", { class: "sc-progress-line", text: scProgressText(key, view), data: { scProgressLine: "1" } }));
  const now = view.phase === "running" && view.currentFilename ? scCurrentShotName(key, view) : "";
  card.appendChild(scEl("p", { class: "sc-progress-now", text: now ? `Now capturing: ${now}` : "", attrs: { hidden: !now }, data: { scProgressNow: "1" } }));
  const counts = scEl("ul", { class: "sc-progress-counts", data: { scProgressCounts: "1" } });
  scFillCounts(counts, view.counts);
  card.appendChild(counts);
  card.appendChild(scEl("p", { class: "sc-progress-detail", text: view.detail }));
  const actions = scEl("div", { class: "sc-step-actions" });
  if (view.phase === "queued-offline" && key !== "library") {
    actions.appendChild(scButton("Connect your computer", { action: "step-connect", focus: "progress-connect" }));
  }
  if (view.phase !== "cancelling") actions.appendChild(scButton("Cancel capture", { action: "job-cancel", data: { jobKey: key }, focus: "cancel" }));
  card.appendChild(actions);
  return card;
}

function scFillCounts(list, c) {
  list.replaceChildren();
  list.appendChild(scEl("li", {}, [scChip(`${c.captured} captured`, c.captured ? "ok" : "neutral")]));
  list.appendChild(scEl("li", {}, [scChip(`${c.needsReview} need review`, c.needsReview ? "warn" : "neutral")]));
  list.appendChild(scEl("li", {}, [scChip(`${c.failed} failed`, c.failed ? "bad" : "neutral")]));
}

/** Update the progress card in place; rebuild it only when the phase changes so focus is never lost. */
function scUpdateProgress(key) {
  const lab = scLab(key);
  const host = document.querySelector(`[data-sc-progress-host="${key}"]`);
  if (!host) return;
  if (!lab.job) {
    host.replaceChildren();
    return;
  }
  const view = scProgressView(key);
  const card = host.querySelector(".sc-progress");
  if (!card || card.dataset.phase !== view.phase || card.dataset.jobId !== lab.job.id) {
    const focusKey = scActiveFocusKey(host);
    host.replaceChildren(scBuildProgressCard(key, view));
    scFocusByKey(host, focusKey);
    return;
  }
  const bar = card.querySelector(".sc-bar");
  bar?.setAttribute("aria-valuenow", String(view.percent));
  bar?.setAttribute("aria-valuetext", `${view.percent} percent, ${view.counts.done} of ${view.counts.total} screenshots done`);
  const fill = card.querySelector(".sc-bar-fill");
  if (fill) fill.style.width = `${view.percent}%`;
  const headline = card.querySelector(".sc-progress-heading");
  if (headline && headline.textContent !== view.headline) headline.textContent = view.headline;
  const detail = card.querySelector(".sc-progress-detail");
  if (detail && detail.textContent !== view.detail) detail.textContent = view.detail;
  const line = card.querySelector("[data-sc-progress-line]");
  if (line) line.textContent = scProgressText(key, view);
  const now = view.phase === "running" && view.currentFilename ? scCurrentShotName(key, view) : "";
  const nowEl = card.querySelector("[data-sc-progress-now]");
  if (nowEl) {
    nowEl.textContent = now ? `Now capturing: ${now}` : "";
    nowEl.hidden = !now;
  }
  const counts = card.querySelector("[data-sc-progress-counts]");
  if (counts) scFillCounts(counts, view.counts);
}

function scFocusProgress(key) {
  const heading = document.querySelector(`[data-sc-progress-host="${key}"] .sc-progress-heading`);
  if (!heading) return;
  heading.scrollIntoView?.({ behavior: "smooth", block: "center" });
  heading.focus?.({ preventScroll: true });
}

// Advanced options -----------------------------------------------------------

function scBuildAdvanced(labId, model) {
  const lab = scLab(labId);
  const ui = lab.ui;
  const details = scEl("details", { class: "sc-advanced", data: { scAdvanced: "1" } });
  details.open = Boolean(ui.advancedOpen);
  details.appendChild(scEl("summary", { text: "Advanced options" }));
  const body = scEl("div", { class: "sc-advanced-body" });

  const grid = scEl("div", { class: "sc-adv-grid" });
  const field = (id, label, control, hint) => {
    const group = scEl("div", { class: "form-group sc-field" });
    group.appendChild(scLabel(id, label));
    group.appendChild(control);
    if (hint) {
      group.appendChild(scEl("span", { id: `${id}-hint`, class: "hint", text: hint }));
      control.setAttribute("aria-describedby", `${id}-hint`);
    }
    return group;
  };
  const select = (id, field, options, value) => {
    const el = scEl("select", { id, attrs: { autocomplete: "off" }, data: { scField: field } });
    for (const [optValue, text] of options) {
      const opt = scEl("option", { text, attrs: { value: optValue } });
      if (optValue === value) opt.selected = true;
      el.appendChild(opt);
    }
    el.value = value;
    return el;
  };

  grid.appendChild(
    field(
      "sc-adv-scope",
      "Which screenshots",
      select(
        "sc-adv-scope",
        "scope",
        [
          ["missing", "Missing ones only"],
          ["stale", "Outdated and missing"],
          ["all", "Every screenshot"],
          ["selected", "Only the ones I tick below"],
        ],
        ui.scope,
      ),
    ),
  );
  grid.appendChild(
    field(
      "sc-adv-callouts",
      "Numbered markers",
      select(
        "sc-adv-callouts",
        "callouts",
        [
          ["sidecar", "Saved next to the image (default)"],
          ["burn", "Drawn onto the image"],
          ["none", "No markers"],
        ],
        ui.callouts,
      ),
    ),
  );

  const profileOptions = [["lab", model.tenant.names.length || lab.brand?.customized ? "This lab's branding (default)" : "This lab's branding (none saved)"]];
  for (const profile of scProfileStore()?.profiles || []) {
    profileOptions.push([`profile:${profile.id}`, `Brand profile: ${profile.name}`]);
  }
  profileOptions.push(["none", "Do not use saved addresses"]);
  grid.appendChild(
    field("sc-adv-tenant", "Tenant addresses to use", select("sc-adv-tenant", "tenant", profileOptions, ui.tenantSource), "Addresses come from a brand profile. They go only to your own computer."),
  );
  body.appendChild(grid);

  const redactRow = scEl("label", { class: "sc-check", attrs: { for: "sc-adv-redact" } });
  const redact = scEl("input", { id: "sc-adv-redact", attrs: { type: "checkbox", autocomplete: "off" }, data: { scField: "redact" } });
  redact.checked = Boolean(ui.redact);
  redactRow.appendChild(redact);
  redactRow.appendChild(scEl("span", { text: "Hide account details such as names and email addresses before each picture (recommended)" }));
  body.appendChild(redactRow);

  const run = scEl("div", { class: "sc-step-actions" });
  run.appendChild(scButton("Capture with these options", { action: "advanced-capture", focus: "advanced-capture", disabled: scIsActiveJob(lab.job) || Boolean(lab.busy), needsIdle: true }));
  body.appendChild(run);

  const learn = scEl("div", { class: "sc-adv-block" });
  learn.appendChild(scEl("h6", { text: "Microsoft Learn" }));
  learn.appendChild(
    scEl("p", {
      class: "hint",
      text: "Compare this lab with the current Microsoft Learn pages. Updating changes the steps in your lab, so retake any screenshots that are marked outdated afterward.",
    }),
  );
  const learnRow = scEl("div", { class: "sc-step-actions" });
  learnRow.appendChild(scButton("Re-check against Microsoft Learn", { action: "recheck", focus: "recheck", disabled: Boolean(lab.busy) }));
  learnRow.appendChild(scButton("Re-check and update the steps", { action: "recheck-update", focus: "recheck-update", disabled: Boolean(lab.busy) }));
  learn.appendChild(learnRow);
  body.appendChild(learn);

  body.appendChild(scBuildLibrarySection());

  const cli = scEl("details", { class: "sc-cli" });
  cli.appendChild(scEl("summary", { text: "Command line (for developers)" }));
  const command = String(lab.state?.cliCommand || `node tools/screenshot-capture/capture.js --generated-lab=${labId} --headed`);
  const cliRow = scEl("div", { class: "sc-code-row" });
  cliRow.appendChild(scEl("code", { class: "sc-command", text: command }));
  cliRow.appendChild(scButton("Copy command", { action: "copy-cli", data: { command }, focus: "copy-cli" }));
  cli.appendChild(cliRow);
  body.appendChild(cli);

  details.appendChild(body);
  return details;
}

// Shared library -------------------------------------------------------------

function scBuildLibrarySection() {
  return scEl("div", { class: "sc-library sc-adv-block", data: { scLibraryHost: "1" } }, scLibraryContents());
}

function scLibraryContents() {
  const status = scState.status?.sharedLibrary;
  const library = scState.library;
  const out = [scEl("h6", { text: "Shared screenshot library" })];
  out.push(
    scEl("p", {
      class: "hint",
      text: "These pictures are shared by every lab, so a screenshot captured once is reused everywhere.",
    }),
  );
  if (status) {
    out.push(
      scEl("p", { class: "sc-library-line", text: `${status.captured} of ${status.total} captured, ${status.missing} missing, ${status.needsReview} need review.` }),
    );
    out.push(
      scEl("p", {
        class: "sc-library-line",
        text: status.persistent
          ? "Saved: these pictures are kept when the portal restarts."
          : "Not saved: these pictures can be lost when the portal restarts. Ask your administrator to turn on persistent storage.",
      }),
    );
  } else {
    out.push(scEl("p", { class: "sc-library-line", text: "Library details are loading." }));
  }
  if (library.error) out.push(scEl("p", { class: "lb-error", text: `Could not load the library. ${library.error}`, attrs: { role: "alert" } }));
  if (!library.loaded) {
    out.push(scButton("Show coverage by product", { action: "library-load", focus: "library-load", disabled: library.loading }));
  } else {
    const rows = scLibraryByProduct(library.shots);
    const list = scEl("ul", { class: "sc-library-list", attrs: { "aria-label": "Shared library coverage by product" } });
    for (const row of rows) {
      const li = scEl("li", { class: "sc-library-row" });
      li.appendChild(scEl("span", { class: "sc-library-name", text: scProductName(row.product) }));
      li.appendChild(scEl("span", { class: "sc-library-meta", text: `${row.captured} of ${row.total} captured${row.needsReview ? `, ${row.needsReview} need review` : ""}` }));
      if (row.missing) {
        li.appendChild(
          scButton(`Capture ${row.missing} missing`, {
            action: "library-capture",
            data: { product: row.product },
            focus: `library:${row.product}`,
            disabled: scIsActiveJob(scLab("library").job),
            aria: { "aria-label": `Capture ${scPlural(row.missing, "missing screenshot")} for ${scProductName(row.product)} in the shared library` },
          }),
        );
      }
      list.appendChild(li);
    }
    out.push(list);
  }
  out.push(scEl("div", { class: "sc-progress-host", data: { scProgressHost: "library" } }));
  const outcome = scLab("library").outcome;
  if (outcome?.message) out.push(scEl("p", { class: `sc-banner sc-banner-${outcome.variant === "ok" ? "ok" : outcome.variant === "warn" ? "warn" : "error"}`, text: outcome.message }));
  return out;
}

function scRenderLibraryHost() {
  const host = document.querySelector("[data-sc-library-host]");
  if (!host) return;
  const focusKey = scActiveFocusKey(host);
  host.replaceChildren(...scLibraryContents());
  scUpdateProgress("library");
  scFocusByKey(host, focusKey);
}

// Gallery --------------------------------------------------------------------

function scBuildGallery(labId, model) {
  const lab = scLab(labId);
  const section = scEl("section", { class: "sc-gallery", attrs: { "aria-labelledby": "sc-gallery-heading" } });
  const head = scEl("div", { class: "sc-gallery-head" });
  head.appendChild(scEl("h5", { id: "sc-gallery-heading", class: "sc-gallery-title", text: "Screenshots by step" }));
  const toggle = scEl("label", { class: "sc-check", attrs: { for: "sc-only-attention" } });
  const box = scEl("input", { id: "sc-only-attention", attrs: { type: "checkbox", autocomplete: "off" }, data: { scField: "only-attention" } });
  box.checked = Boolean(lab.ui.onlyAttention);
  toggle.appendChild(box);
  toggle.appendChild(scEl("span", { text: "Show only screenshots that need attention" }));
  head.appendChild(toggle);
  section.appendChild(head);
  section.appendChild(
    scEl("p", {
      class: "sc-gallery-help",
      text: "Select a picture to enlarge it. To replace one, drop an image on it, choose Upload image, or press Ctrl+V after selecting it.",
    }),
  );
  section.appendChild(scEl("p", { class: "sc-selected-hint", text: scSelectedHintText(lab), data: { scSelectedHint: "1" } }));

  const jobShots = new Map((lab.job?.shots || []).map((s) => [s.filename, s.status]));
  const groups = scGroupShots(lab.state);
  let shown = 0;
  for (const group of groups) {
    const shots = group.shots.filter((shot) => {
      if (!lab.ui.onlyAttention) return true;
      return !["captured"].includes(scShotStatus(shot).key);
    });
    if (!shots.length) continue;
    shown += shots.length;
    section.appendChild(scBuildModule(labId, group, shots, jobShots, model));
  }
  if (!groups.length) {
    section.appendChild(scEl("p", { class: "scenario-empty", text: "This lab has no screenshots to capture." }));
  } else if (!shown) {
    section.appendChild(scEl("p", { class: "scenario-empty", text: "Every screenshot looks good. Clear the filter to see them all." }));
  }
  return section;
}

function scBuildModule(labId, group, shots, jobShots, model) {
  const wrap = scEl("section", { class: "sc-module", attrs: { "aria-labelledby": `sc-module-${group.featureId}` } });
  const head = scEl("div", { class: "sc-module-head" });
  const captured = group.shots.filter((s) => s.captured).length;
  head.appendChild(scEl("h5", { id: `sc-module-${group.featureId}`, class: "sc-module-title", text: `${group.stepLabel ? `${group.stepLabel} \u00b7 ` : ""}${group.title}` }));
  const chips = scEl("div", { class: "sc-pills" });
  chips.appendChild(scChip(`${captured} of ${group.shots.length} captured`, captured === group.shots.length && group.shots.every((s) => !s.stale) ? "ok" : "neutral"));
  chips.appendChild(scChip(`Microsoft Learn: ${scCheckLabel(group.checkState, 1)}`, scCheckTone(group.checkState), "sc-chip-learn"));
  head.appendChild(chips);
  const learnUrl = scSafeLearnUrl(group.learnUrl);
  if (learnUrl) {
    head.appendChild(
      scEl("a", {
        class: "btn btn-sm",
        text: "Open on Microsoft Learn",
        attrs: { href: learnUrl, target: "_blank", rel: "noopener noreferrer", "aria-label": `Open the Microsoft Learn page for ${group.title} (opens in a new tab)` },
      }),
    );
  }
  wrap.appendChild(head);
  const diff = group.diff;
  if (group.checkState === "docs-updated" && diff) {
    const added = Array.isArray(diff.addedSteps) ? diff.addedSteps.length : 0;
    const removed = Array.isArray(diff.removedSteps) ? diff.removedSteps.length : 0;
    wrap.appendChild(
      scEl("p", {
        class: "sc-module-diff",
        text: `Microsoft Learn changed this topic${added || removed ? `: ${scPlural(added, "step")} added or changed, ${scPlural(removed, "step")} removed` : ""}.`,
      }),
    );
  }
  const list = scEl("ul", { class: "sc-grid", attrs: { "aria-label": `Screenshots for ${group.title}` } });
  for (const shot of shots) list.appendChild(scBuildCard(labId, shot, jobShots.get(shot.filename) || null));
  wrap.appendChild(list);
  return wrap;
}

function scShotLabel(shot) {
  return `${shot.figure ? `Figure ${shot.figure}` : "Screenshot"}: ${String(shot.caption || shot.alt || shot.filename)}`;
}

/** The failed row for this screenshot in the last finished capture, so the card can say why it failed. */
function scLastAttempt(labId, filename) {
  const row = (scLab(labId).lastJob?.shots || []).find((s) => s.filename === filename);
  return row && (row.status === "failed" || row.status === "auth-required") ? row : null;
}

function scStatusFor(labId, shot, jobStatus = null) {
  const live = jobStatus === "running" || jobStatus === "pending" ? jobStatus : null;
  return scShotStatus(shot, live, shot.captured ? null : scLastAttempt(labId, shot.filename));
}

function scShotImageUrl(labId, shot, status) {
  const lab = scLab(labId);
  const uploading = lab.uploading[shot.filename];
  if (uploading?.objectUrl) return uploading.objectUrl;
  if (status.key === "needs-review") return scScreenshotApi(labId, shot.filename, `/staged?t=${encodeURIComponent(String(shot.verification?.stagedAt || shot.capturedAt || "1").slice(0, 40))}`);
  if (shot.captured) return scAssetUrl(labId, shot.filename, shot.capturedAt || shot.verification?.acceptedAt || "");
  return "";
}

function scShotNote(shot, status, attempt = null) {
  switch (status.key) {
    case "needs-review": {
      const items = scVerificationSummary(shot.verification, scLimits()).items.filter((i) => i.level !== "pass");
      return items.length ? items.slice(0, 2).map((i) => i.text).join(" ") : "Saved for review. Check it, then accept or retake it.";
    }
    case "failed": {
      const why = attempt?.verification ? scVerificationSummary(attempt.verification, scLimits()).items.filter((i) => i.level !== "pass") : [];
      if (why.length) return `The last picture was not used. ${why.slice(0, 2).map((i) => i.text).join(" ")}`;
      if (attempt?.status === "auth-required" || shot.lastAttemptStatus === "auth-required") return "Sign-in was needed. Sign in on your computer, then try again.";
      return String(attempt?.error || attempt?.message || shot.lastError || "The last try did not finish. You can try again or add the image yourself.").slice(0, 200);
    }
    case "manual":
      return "This screen needs a person. Take it yourself, then paste or upload it.";
    case "outdated":
      return "Microsoft Learn changed this topic. Retake it so the picture matches.";
    case "pending":
    case "queued":
      return "Not captured yet.";
    case "captured": {
      const when = scTimeAgo(shot.capturedAt);
      const how = shot.captureSource === "companion" ? " on your computer" : shot.captureSource === "manual-upload" ? " by upload" : "";
      return when ? `Captured ${when}${how}.` : "";
    }
    default:
      return "";
  }
}

function scBuildCard(labId, shot, jobStatus) {
  const lab = scLab(labId);
  const status = scStatusFor(labId, shot, jobStatus);
  const attempt = shot.captured ? null : scLastAttempt(labId, shot.filename);
  const label = scShotLabel(shot);
  const card = scEl("li", { class: `sc-card${lab.selected === shot.filename ? " sc-selected" : ""}`, attrs: { tabindex: "-1" }, data: { filename: shot.filename, status: status.key } });
  if (lab.selected === shot.filename) card.setAttribute("aria-current", "true");

  const thumbWrap = scEl("div", { class: "sc-thumb-wrap" });
  const thumb = scEl("button", {
    class: "sc-thumb",
    attrs: { type: "button", "aria-label": `Enlarge ${label}. Status: ${status.label}.` },
    data: { scAction: "preview", filename: shot.filename, scFocus: `thumb:${shot.filename}` },
  });
  const url = scShotImageUrl(labId, shot, status);
  if (url) {
    const img = scEl("img", { class: "sc-thumb-img", attrs: { src: url, alt: "", loading: "lazy", decoding: "async" } });
    img.addEventListener?.("error", () => {
      img.replaceWith?.(scEl("span", { class: "sc-thumb-empty", text: "Pending" }));
    });
    thumb.appendChild(img);
  } else {
    thumb.appendChild(scEl("span", { class: "sc-thumb-empty", text: "Pending" }));
  }
  if (lab.uploading[shot.filename]) thumb.appendChild(scEl("span", { class: "sc-thumb-busy", text: "Uploading" }));
  thumbWrap.appendChild(thumb);
  thumbWrap.appendChild(scEl("span", { class: "sc-drop-hint", text: "Drop to replace", attrs: { "aria-hidden": "true" } }));
  const pick = scEl("label", { class: "sc-pick" });
  const pickBox = scEl("input", { attrs: { type: "checkbox", autocomplete: "off" }, data: { scField: "pick", filename: shot.filename } });
  pickBox.checked = lab.ui.picks.has(shot.filename);
  pick.appendChild(pickBox);
  pick.appendChild(scEl("span", { class: "sr-only", text: `Include ${label} in the next capture` }));
  thumbWrap.appendChild(pick);
  card.appendChild(thumbWrap);

  const body = scEl("div", { class: "sc-card-body" });
  const top = scEl("div", { class: "sc-card-head" });
  top.appendChild(scStatusChip(status));
  if (shot.figure) top.appendChild(scEl("span", { class: "sc-fig", text: `Figure ${shot.figure}` }));
  body.appendChild(top);
  body.appendChild(scEl("p", { class: "sc-caption", text: String(shot.caption || shot.alt || shot.filename) }));
  body.appendChild(scEl("p", { class: "sc-note", text: scShotNote(shot, status, attempt), data: { scNote: "1" } }));
  const feedback = scBuildFeedback(labId, shot.filename);
  if (feedback) body.appendChild(feedback);
  body.appendChild(scEl("div", { class: "sc-card-actions" }, scCardActions(labId, shot, status)));
  card.appendChild(body);
  return card;
}

function scStatusChip(status) {
  return scChip(status.label, status.tone, "sc-status-chip");
}

function scBuildFeedback(labId, filename) {
  const fb = scLab(labId).feedback[filename];
  if (!fb) return null;
  const box = scEl("div", { class: `sc-feedback sc-feedback-${fb.variant === "ok" ? "ok" : fb.variant === "warn" ? "warn" : "bad"}`, data: { filename } });
  box.appendChild(scEl("p", { class: "sc-feedback-head", text: fb.headline || "" }));
  if (Array.isArray(fb.items) && fb.items.length) {
    const ul = scEl("ul", { class: "sc-feedback-list" });
    for (const item of fb.items) ul.appendChild(scEl("li", { text: item.text }));
    box.appendChild(ul);
  }
  box.appendChild(scButton("Dismiss", { action: "dismiss-feedback", data: { filename }, focus: `dismiss:${filename}`, aria: { "aria-label": "Dismiss this message" } }));
  return box;
}

function scCardActions(labId, shot, status, { idPrefix = "card" } = {}) {
  const lab = scLab(labId);
  const label = scShotLabel(shot);
  const jobActive = scIsActiveJob(lab.job);
  const busyUpload = Boolean(lab.uploading[shot.filename]);
  const key = (name) => `${idPrefix}:${shot.filename}:${name}`;
  const buttons = [];
  const add = (text, action, opts = {}) =>
    buttons.push(
      scButton(text, {
        action,
        data: { filename: shot.filename },
        focus: key(action),
        aria: { "aria-label": `${text}: ${label}` },
        ...opts,
      }),
    );
  if (status.key === "needs-review") {
    add("Accept", "shot-accept", { primary: true, disabled: busyUpload });
    add("Discard", "shot-discard", { disabled: busyUpload });
  } else if (status.key === "pending" || status.key === "failed" || status.key === "queued") {
    add("Capture this one", "shot-capture", { disabled: jobActive || busyUpload, needsIdle: true });
  } else if (status.key === "captured" || status.key === "outdated") {
    add("Retake", "shot-retake", { primary: status.key === "outdated", disabled: jobActive || busyUpload, needsIdle: true });
  }
  add("Paste image", "shot-paste", { disabled: busyUpload });
  add("Upload image", "shot-upload", { disabled: busyUpload });
  return buttons;
}

function scBuildFileInput() {
  return scEl("input", {
    class: "sr-only sc-file",
    attrs: { type: "file", accept: scLimits().acceptedTypes.join(","), tabindex: "-1", "aria-hidden": "true", autocomplete: "off" },
  });
}

/** Rebuild one card after its state changed (an upload, a message). */
function scRefreshCard(labId, filename) {
  const host = scHostFor(labId);
  if (!host) return;
  const lab = scLab(labId);
  const shot = (lab.state?.shots || []).find((s) => s.filename === filename);
  if (!shot) return;
  for (const card of host.querySelectorAll(".sc-card")) {
    if (card.dataset.filename !== filename) continue;
    const focusKey = scActiveFocusKey(card);
    const jobStatus = new Map((lab.job?.shots || []).map((s) => [s.filename, s.status])).get(filename) || null;
    const fresh = scBuildCard(labId, shot, jobStatus);
    card.replaceWith(fresh);
    scFocusByKey(fresh, focusKey);
    if (scLab(labId).lightbox === filename) scFillLightbox(labId, filename);
  }
}

/** Reflect the live job on each card without rebuilding the gallery. */
function scApplyJobToCards(key) {
  const host = scHostFor(key);
  if (!host) return;
  const lab = scLab(key);
  const jobShots = new Map((lab.job?.shots || []).map((s) => [s.filename, s.status]));
  const idle = !scIsActiveJob(lab.job);
  for (const card of host.querySelectorAll(".sc-card")) {
    const shot = (lab.state?.shots || []).find((s) => s.filename === card.dataset.filename);
    if (!shot) continue;
    const js = jobShots.get(shot.filename);
    const status = scStatusFor(key, shot, js);
    if (card.dataset.status !== status.key) {
      card.dataset.status = status.key;
      const chip = card.querySelector(".sc-status-chip");
      if (chip) {
        chip.textContent = status.label;
        chip.className = `sc-chip sc-chip-${status.tone} sc-status-chip`;
      }
    }
    for (const btn of card.querySelectorAll("[data-sc-needs-idle]")) btn.disabled = !idle;
  }
}

// ── Selecting a screenshot, Ctrl+V, drag and drop ───────────────────────────

function scSelectedHintText(lab) {
  const shot = (lab.state?.shots || []).find((s) => s.filename === lab.selected);
  return shot ? `Selected: ${scShotLabel(shot)}. Press Ctrl+V to paste an image from your clipboard.` : "";
}

function scSelectShot(labId, filename, { announce = false } = {}) {
  const lab = scLab(labId);
  if (lab.selected === filename) return;
  lab.selected = filename;
  const host = scHostFor(labId);
  if (!host) return;
  for (const card of host.querySelectorAll(".sc-card")) {
    const on = card.dataset.filename === filename;
    card.classList.toggle("sc-selected", on);
    if (on) card.setAttribute("aria-current", "true");
    else card.removeAttribute("aria-current");
  }
  const hint = host.querySelector("[data-sc-selected-hint]");
  if (hint) hint.textContent = scSelectedHintText(lab);
  if (announce) scAnnounce(scSelectedHintText(lab));
}

function scImageFromClipboardEvent(event) {
  const data = event.clipboardData;
  if (!data) return null;
  const files = Array.from(data.files || []);
  const fromFiles = files.find((f) => /^image\//i.test(f.type));
  if (fromFiles) return fromFiles;
  for (const item of Array.from(data.items || [])) {
    if (item.kind === "file" && /^image\//i.test(item.type)) {
      const file = item.getAsFile?.();
      if (file) return file;
    }
  }
  return null;
}

function scIsTextEntry(el) {
  const tag = String(el?.tagName || "").toLowerCase();
  return tag === "textarea" || (tag === "input" && !["checkbox", "radio", "button", "file"].includes(String(el.type || "").toLowerCase())) || Boolean(el?.isContentEditable);
}

function scBindSection(section, labId) {
  const lab = scLab(labId);
  const fileInput = section.querySelector(".sc-file");
  const dropTarget = (event) => (event.target?.closest ? event.target.closest(".sc-card") : null);

  section.addEventListener("click", (event) => {
    const card = event.target?.closest?.(".sc-card");
    if (card) {
      scSelectShot(labId, card.dataset.filename);
      if (!event.target.closest("button, a, input, label, select")) card.focus?.({ preventScroll: true });
    }
    const control = event.target?.closest?.("[data-sc-action]");
    if (!control || control.disabled) return;
    const filename = control.dataset.filename || card?.dataset.filename || "";
    void scHandleAction(labId, control.dataset.scAction, control, filename, fileInput);
  });

  section.addEventListener("focusin", (event) => {
    const card = event.target?.closest?.(".sc-card");
    if (card) scSelectShot(labId, card.dataset.filename, { announce: lab.selected !== card.dataset.filename });
  });

  section.addEventListener("change", (event) => {
    const target = event.target;
    const field = target?.dataset?.scField;
    if (field === "scope") {
      lab.ui.scope = target.value;
      section.classList.toggle("sc-selecting", target.value === "selected");
    } else if (field === "callouts") lab.ui.callouts = target.value;
    else if (field === "redact") lab.ui.redact = Boolean(target.checked);
    else if (field === "tenant") {
      lab.ui.tenantSource = target.value || "lab";
      scRerender(labId);
    } else if (field === "only-attention") {
      lab.ui.onlyAttention = Boolean(target.checked);
      scRerender(labId);
    } else if (field === "pick") {
      if (target.checked) lab.ui.picks.add(target.dataset.filename);
      else lab.ui.picks.delete(target.dataset.filename);
    }
  });

  fileInput?.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    const target = lab.uploadTarget;
    fileInput.value = "";
    if (file && target) void scUploadImage(labId, target, file);
  });

  section.addEventListener("paste", (event) => {
    if (scIsTextEntry(event.target)) return;
    const file = scImageFromClipboardEvent(event);
    if (!file) return;
    event.preventDefault();
    if (!lab.selected) {
      scAnnounce("Select a screenshot first, then press Ctrl+V to paste an image.");
      return;
    }
    void scUploadImage(labId, lab.selected, file);
  });

  section.addEventListener("dragover", (event) => {
    const card = dropTarget(event);
    if (!card || !Array.from(event.dataTransfer?.types || []).includes("Files")) return;
    event.preventDefault();
    card.classList.add("sc-drop-active");
  });
  section.addEventListener("dragleave", (event) => {
    dropTarget(event)?.classList.remove("sc-drop-active");
  });
  section.addEventListener("drop", (event) => {
    const card = dropTarget(event);
    if (!card) return;
    event.preventDefault();
    card.classList.remove("sc-drop-active");
    const file = Array.from(event.dataTransfer?.files || [])[0];
    if (!file) return;
    scSelectShot(labId, card.dataset.filename);
    void scUploadImage(labId, card.dataset.filename, file);
  });

  section.querySelector("[data-sc-advanced]")?.addEventListener("toggle", (event) => {
    lab.ui.advancedOpen = Boolean(event.target.open);
  });
}

// ── Actions ─────────────────────────────────────────────────────────────────

function scOpenAddressSettings() {
  if (typeof setActiveTab === "function") setActiveTab("config");
  const input = document.getElementById("bp-copilotStudioUrl");
  input?.scrollIntoView?.({ behavior: "smooth", block: "center" });
  input?.focus?.();
}

async function scHandleAction(labId, action, control, filename, fileInput) {
  const lab = scLab(labId);
  switch (action) {
    case "primary-connect":
    case "step-connect":
    case "step-pair-another":
      await scStartPairing({ source: "lab" });
      return;
    case "step-retry-status":
      await scLoadStatus(true);
      scNotifyStatusChanged();
      return;
    case "step-add-addresses":
    case "step-edit-addresses":
      scOpenAddressSettings();
      return;
    case "step-use-profile":
      lab.ui.tenantSource = `profile:${control.dataset.profileId}`;
      scAnnounce("These addresses will be used for the next capture.");
      scRerender(labId);
      return;
    case "pair-close":
      scClosePairing();
      return;
    case "pair-new":
      await scStartPairing({ source: scState.pairing?.context?.source || "lab", onConnected: scState.pairing?.context?.onConnected });
      return;
    case "pair-copy-code":
      scAnnounce((await scCopyText(scState.pairing?.code || "")) ? "Pairing code copied." : "Could not copy. Select the code and copy it yourself.");
      return;
    case "pair-copy-command":
      scAnnounce((await scCopyText(scState.pairing?.command || "")) ? "Command copied." : "Could not copy. Select the command and copy it yourself.");
      return;
    case "disconnect-device":
      await scConfirmDisconnect(control);
      return;
    case "primary-capture-missing":
      await scQueueCapture(labId, { scope: "missing" });
      return;
    case "primary-capture-stale":
      await scQueueCapture(labId, { scope: "stale" });
      return;
    case "primary-review":
    case "banner-review":
      scFocusFirstWithStatus(labId, "needs-review");
      return;
    case "primary-manual":
      scFocusFirstWithStatus(labId, "manual");
      return;
    case "primary-check":
    case "recheck":
      await scRecheck(labId, { autoUpdate: false });
      return;
    case "primary-update":
    case "recheck-update":
    case "banner-recheck-update":
      await scRecheck(labId, { autoUpdate: true });
      return;
    case "advanced-capture":
      await scRunAdvancedCapture(labId);
      return;
    case "banner-retry-failed":
      await scQueueCapture(labId, { scope: "selected", filenames: String(control.dataset.filenames || "").split(",").filter(Boolean) });
      return;
    case "banner-dismiss":
      lab.outcome = null;
      scRerender(labId);
      return;
    case "job-cancel":
      await scCancelJob(control.dataset.jobKey || labId);
      return;
    case "copy-cli":
      scAnnounce((await scCopyText(control.dataset.command || "")) ? "Command copied." : "Could not copy. Select the command and copy it yourself.");
      return;
    case "preview":
      scOpenLightbox(labId, filename);
      return;
    case "shot-capture":
      await scCaptureOne(labId, filename);
      return;
    case "shot-retake":
      await scRetakeShot(labId, filename);
      return;
    case "shot-paste":
      await scPasteFromClipboard(labId, filename);
      return;
    case "shot-upload":
      lab.uploadTarget = filename;
      fileInput?.click?.();
      return;
    case "shot-accept":
      await scAcceptShot(labId, filename);
      return;
    case "shot-discard":
      await scResetShot(labId, filename, { announce: "Staged image discarded." });
      return;
    case "dismiss-feedback":
      scSetFeedback(labId, filename, null);
      return;
    case "library-load":
      await scLoadLibrary(true);
      scRenderLibraryHost();
      return;
    case "library-capture":
      await scQueueLibraryCapture(control.dataset.product);
      return;
    case "lightbox-close":
      scCloseLightbox(labId);
      return;
    case "lightbox-prev":
      scStepLightbox(labId, -1);
      return;
    case "lightbox-next":
      scStepLightbox(labId, 1);
      return;
    default:
  }
}

async function scConfirmDisconnect(button) {
  if (button.dataset.confirm !== "1") {
    button.dataset.confirm = "1";
    button.textContent = "Confirm disconnect";
    scAnnounce(`Select Confirm disconnect to disconnect ${button.dataset.deviceName}.`);
    const reset = setTimeout(() => {
      button.dataset.confirm = "0";
      button.textContent = "Disconnect";
    }, 6000);
    reset?.unref?.();
    return;
  }
  await scDisconnectDevice(button.dataset.deviceId);
}

function scFocusFirstWithStatus(labId, statusKey) {
  const host = scHostFor(labId);
  if (!host) return;
  for (const card of host.querySelectorAll(".sc-card")) {
    if (card.dataset.status !== statusKey) continue;
    card.scrollIntoView?.({ behavior: "smooth", block: "center" });
    const first = card.querySelector("button");
    (first || card).focus?.({ preventScroll: true });
    return;
  }
}

async function scCaptureOne(labId, filename) {
  const status = await scLoadStatus(true);
  if (!status?.companion?.connected) {
    scSetFeedback(labId, filename, {
      variant: "warn",
      headline: "Connect your computer first.",
      items: [{ level: "warn", text: "Capture runs on your computer. Connect it, then try again. You can also paste or upload an image now." }],
    });
    scNotifyStatusChanged();
    await scStartPairing({ source: "lab" });
    return;
  }
  await scQueueCapture(labId, { scope: "selected", filenames: [filename] });
}

async function scRunAdvancedCapture(labId) {
  const lab = scLab(labId);
  const scope = lab.ui.scope;
  const status = await scLoadStatus(true);
  if (!status?.companion?.connected) {
    lab.outcome = { type: "job", variant: "warn", message: "Connect your computer first. Capture runs on your computer.", jobId: null, actions: [] };
    scAnnounce(lab.outcome.message);
    scNotifyStatusChanged();
    await scStartPairing({ source: "lab" });
    return;
  }
  if (scope === "selected" && !lab.ui.picks.size) {
    lab.outcome = { type: "job", variant: "warn", message: "Tick at least one screenshot below, then try again.", jobId: null, actions: [] };
    scAnnounce(lab.outcome.message);
    scRerender(labId);
    return;
  }
  await scQueueCapture(labId, { scope, filenames: [...lab.ui.picks] });
}

// ── Preview dialog ──────────────────────────────────────────────────────────

function scBuildLightbox(labId) {
  const dialog = scEl("dialog", {
    class: "sc-lightbox",
    attrs: { "aria-labelledby": "sc-lb-title" },
    data: { scLightbox: "1" },
  });
  const head = scEl("div", { class: "sc-lb-head" });
  head.appendChild(scEl("h5", { id: "sc-lb-title", class: "sc-lb-title", text: "" }));
  head.appendChild(scButton("\u2715", { action: "lightbox-close", focus: "lb-close", aria: { "aria-label": "Close the preview" }, small: false }));
  dialog.appendChild(head);
  const main = scEl("div", { class: "sc-lb-main" });
  main.appendChild(scButton("\u2039", { action: "lightbox-prev", focus: "lb-prev", aria: { "aria-label": "Previous screenshot" }, small: false }));
  main.appendChild(scEl("figure", { class: "sc-lb-figure", data: { scLbFigure: "1" } }));
  main.appendChild(scButton("\u203a", { action: "lightbox-next", focus: "lb-next", aria: { "aria-label": "Next screenshot" }, small: false }));
  dialog.appendChild(main);
  dialog.appendChild(scEl("div", { class: "sc-lb-info", data: { scLbInfo: "1" } }));

  dialog.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      scStepLightbox(labId, -1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      scStepLightbox(labId, 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      scStepLightbox(labId, "first");
    } else if (event.key === "End") {
      event.preventDefault();
      scStepLightbox(labId, "last");
    } else if (event.key === "Escape") {
      event.preventDefault();
      scCloseLightbox(labId);
    }
  });
  dialog.addEventListener("close", () => scOnLightboxClosed(labId));
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault?.();
    scCloseLightbox(labId);
  });
  return dialog;
}

function scLightboxDialog(labId) {
  return scHostFor(labId)?.querySelector("[data-sc-lightbox]") || null;
}

function scOpenLightbox(labId, filename, { restore = false } = {}) {
  const lab = scLab(labId);
  const dialog = scLightboxDialog(labId);
  if (!dialog || !(lab.state?.shots || []).some((s) => s.filename === filename)) return;
  lab.lightbox = filename;
  if (!restore) lab.lightboxOpener = filename;
  scFillLightbox(labId, filename);
  if (!dialog.open) {
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }
  scFocusByKey(dialog, "lb-close");
}

function scCloseLightbox(labId) {
  const dialog = scLightboxDialog(labId);
  if (dialog?.open && typeof dialog.close === "function") dialog.close();
  else scOnLightboxClosed(labId);
}

function scOnLightboxClosed(labId) {
  const lab = scLab(labId);
  const opener = lab.lightboxOpener || lab.lightbox;
  lab.lightbox = null;
  lab.lightboxOpener = null;
  const host = scHostFor(labId);
  if (host && opener) scFocusByKey(host, `thumb:${opener}`);
}

function scStepLightbox(labId, direction) {
  const lab = scLab(labId);
  const order = (lab.state?.shots || []).map((s) => s.filename).filter((n) => SC_SAFE_FILENAME.test(String(n)));
  if (!order.length) return;
  const at = Math.max(0, order.indexOf(lab.lightbox));
  let next = at;
  if (direction === "first") next = 0;
  else if (direction === "last") next = order.length - 1;
  else next = (at + direction + order.length) % order.length;
  lab.lightbox = order[next];
  lab.lightboxOpener = order[next];
  scFillLightbox(labId, order[next]);
  scSelectShot(labId, order[next]);
}

function scLbSection(title, content) {
  const wrap = scEl("div", { class: "sc-lb-section" });
  wrap.appendChild(scEl("h6", { text: title }));
  wrap.appendChild(content);
  return wrap;
}

function scFillLightbox(labId, filename) {
  const lab = scLab(labId);
  const dialog = scLightboxDialog(labId);
  const shots = lab.state?.shots || [];
  const shot = shots.find((s) => s.filename === filename);
  if (!dialog || !shot) return;
  const status = scStatusFor(labId, shot, null);
  const label = scShotLabel(shot);
  const title = dialog.querySelector("#sc-lb-title");
  if (title) title.textContent = label;

  const figure = dialog.querySelector("[data-sc-lb-figure]");
  figure.replaceChildren();
  const url = scShotImageUrl(labId, shot, status);
  if (url) figure.appendChild(scEl("img", { class: "sc-lb-img", attrs: { src: url, alt: String(shot.alt || shot.caption || label) } }));
  else figure.appendChild(scEl("div", { class: "sc-lb-empty", text: "Pending. This screenshot has not been captured yet." }));
  figure.appendChild(scEl("figcaption", { class: "sc-lb-caption", text: String(shot.caption || "") }));

  const info = dialog.querySelector("[data-sc-lb-info]");
  info.replaceChildren();
  const position = shots.findIndex((s) => s.filename === filename) + 1;
  const meta = scEl("p", { class: "sc-lb-meta" });
  meta.appendChild(scStatusChip(status));
  meta.appendChild(scEl("span", { text: ` Screenshot ${position} of ${shots.length}` }));
  info.appendChild(meta);

  if (Array.isArray(shot.instructions) && shot.instructions.length) {
    const ol = scEl("ol", { class: "sc-lb-list" });
    for (const line of shot.instructions) ol.appendChild(scEl("li", { text: scPlainInstruction(line) }));
    info.appendChild(scLbSection("What to show", ol));
  } else if (shot.navHint) {
    info.appendChild(scLbSection("What to show", scEl("p", { text: String(shot.navHint) })));
  }
  info.appendChild(scLbSection("Alt text", scEl("p", { text: String(shot.alt || "") })));

  const summary = scVerificationSummary(shot.verification || (shot.captured ? null : scLastAttempt(labId, filename)?.verification), scLimits());
  if (summary.level !== "none") {
    const box = scEl("div");
    box.appendChild(scEl("p", { class: `sc-lb-verdict sc-lb-verdict-${summary.level}`, text: summary.headline }));
    const ul = scEl("ul", { class: "sc-lb-list" });
    for (const item of summary.items) ul.appendChild(scEl("li", { text: item.text }));
    box.appendChild(ul);
    info.appendChild(scLbSection("Check results", box));
  }
  const fileLine = [shot.filename, shot.capturedAt ? `captured ${scTimeAgo(shot.capturedAt)}` : ""].filter(Boolean).join(", ");
  info.appendChild(scEl("p", { class: "sc-lb-file", text: fileLine }));
  info.appendChild(scEl("div", { class: "sc-card-actions" }, scCardActions(labId, shot, status, { idPrefix: "lb" })));
}

// ── Step 8: capture when the lab is built ───────────────────────────────────

/** Enable the "Capture screenshots" checkbox only while a computer is connected. */
async function scSyncCaptureOnBuild({ fetch: refresh = true } = {}) {
  const box = document.getElementById("lb-capture-on-build");
  if (!box) return;
  if (refresh) await scLoadStatus(true);
  const connected = scIsConnected();
  const statusEl = document.getElementById("lb-capture-on-build-status");
  const setup = document.getElementById("lb-capture-on-build-setup");
  box.disabled = !connected;
  if (!connected) box.checked = false;
  if (statusEl) {
    const names = (scState.status?.companion?.devices || []).filter((d) => d.connected).map((d) => d.name);
    statusEl.textContent = connected
      ? `${names.length ? `Connected: ${scJoinNames(names, 2)}. ` : "Your computer is connected. "}Screenshots are captured on your computer right after your lab is built.`
      : scState.statusError && !scState.status
        ? "We could not check whether a computer is connected. You can still build your lab and capture screenshots afterward."
        : "Your computer is not connected yet, so this is turned off. You can connect it now (about two minutes), or capture screenshots after the lab is built.";
  }
  if (setup) setup.hidden = connected;
}

function scStartBuildPairing() {
  return scStartPairing({
    source: "build",
    onConnected: () => {
      const box = document.getElementById("lb-capture-on-build");
      if (box && !box.disabled) box.checked = true;
    },
  });
}

function scInitBuildCapture() {
  const setup = document.getElementById("lb-capture-on-build-setup");
  setup?.addEventListener("click", () => void scStartBuildPairing());
  const pairingHost = document.getElementById("lb-capture-on-build-pairing");
  pairingHost?.addEventListener("click", (event) => {
    const control = event.target?.closest?.("[data-sc-action]");
    if (!control) return;
    void scHandleAction("", control.dataset.scAction, control, "", null);
  });
  const stepVisible = () => {
    const pane = document.getElementById("lb-pane-8");
    return Boolean(pane) && pane.style.display !== "none";
  };
  window.addEventListener("focus", () => {
    if (stepVisible()) {
      void scSyncCaptureOnBuild();
      return;
    }
    if (!document.getElementById(SC_HOST_ID)?.querySelector("[data-sc-root]")) return;
    const before = scIsConnected();
    void scLoadStatus(true).then(() => {
      if (before !== scIsConnected()) scNotifyStatusChanged();
    });
  });
}

if (typeof document !== "undefined" && typeof window !== "undefined" && document.getElementById) scInitBuildCapture();
