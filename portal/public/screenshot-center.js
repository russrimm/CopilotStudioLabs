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

// ── Copy confirmation ───────────────────────────────────────────────────────
// The acknowledgment lives in scState.copyAck (button key, message, expiry), not in the DOM,
// so the periodic re-renders of the pairing card and the panel never wipe it. Every copy button
// has an adjacent span.sc-copy-ack that is filled from that state whenever it is built or synced.
// Screen readers hear the same words through the polite live region (scAnnounce).

const SC_SVG_NS = "http://www.w3.org/2000/svg";

function scCopyAckIcon(ok) {
  const svg = document.createElementNS(SC_SVG_NS, "svg");
  for (const [name, value] of Object.entries({ class: "sc-copy-ack-icon", viewBox: "0 0 16 16", width: "14", height: "14", "aria-hidden": "true", focusable: "false" })) {
    svg.setAttribute(name, value);
  }
  const path = document.createElementNS(SC_SVG_NS, "path");
  const shape = ok ? { d: "M3 8.5l3.2 3.2L13 4.8" } : { d: "M8 3.5v5.2M8 12.2v.1" };
  for (const [name, value] of Object.entries({ ...shape, fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round" })) {
    path.setAttribute(name, value);
  }
  svg.appendChild(path);
  return svg;
}

/** The acknowledgment that is still within its window, or null. */
function scActiveCopyAck() {
  const ack = scState.copyAck;
  return ack && Date.now() < ack.expiresAt ? ack : null;
}

function scFillCopyAck(el) {
  const ack = scActiveCopyAck();
  const mine = ack && ack.key === el.dataset.scCopyAck;
  el.className = `sc-copy-ack${mine ? (ack.ok ? " sc-copy-ack-ok" : " sc-copy-ack-fail") : ""}`;
  el.style.animationDelay = "";
  if (!mine) {
    el.replaceChildren();
    return;
  }
  // A re-render must continue the fade where it was, not restart it.
  if (ack.ok) el.style.animationDelay = `-${Math.max(0, Date.now() - ack.startedAt)}ms`;
  el.replaceChildren(scCopyAckIcon(ack.ok), scEl("span", { class: "sc-copy-ack-text", text: ack.text }));
}

/** The element that sits next to a copy button and shows its confirmation. */
function scCopyAckEl(key) {
  const el = scEl("span", { data: { scCopyAck: key } });
  scFillCopyAck(el);
  return el;
}

function scSyncCopyAck() {
  for (const el of document.querySelectorAll("[data-sc-copy-ack]")) scFillCopyAck(el);
}

function scClearCopyAck() {
  const ack = scState.copyAck;
  if (!ack) return;
  clearTimeout(ack.timer);
  scState.copyAck = null;
  scSyncCopyAck();
}

function scShowCopyAck(key, ok) {
  const message = scCopyMessage(key, ok);
  const ms = ok ? SC_COPY_OK_MS : SC_COPY_FAIL_MS;
  const startedAt = Date.now();
  const ack = { key, ok, text: message.text, startedAt, expiresAt: startedAt + ms, timer: null };
  clearTimeout(scState.copyAck?.timer);
  scState.copyAck = ack;
  ack.timer = setTimeout(() => {
    if (scState.copyAck === ack) scClearCopyAck();
  }, ms);
  ack.timer?.unref?.();
  scSyncCopyAck();
  scAnnounce(message.announce);
}

async function scCopyWithAck(key, text) {
  scShowCopyAck(key, Boolean(text) && (await scCopyText(text)));
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
    if (shot.product && ["pending", "failed", "outdated", "needs-you", "paused"].includes(key)) ids.add(String(shot.product));
  }
  return [...ids].map((id) => ({ id, name: scProductName(id) }));
}

/** The job row that says why a screenshot is still missing after a capture: the running job first, then the last finished one. */
function scLastAttempt(labId, filename) {
  const lab = scLab(labId);
  for (const job of [lab.job, lab.lastJob]) {
    const row = (job?.shots || []).find((s) => s.filename === filename);
    if (row && SC_ATTEMPT_STATUSES.includes(row.status)) return row;
  }
  return null;
}

/** The job row of a screenshot in the job that is running or finished last, with its outcome and path. */
function scJobRow(labId, filename) {
  const lab = scLab(labId);
  for (const job of [lab.job, lab.lastJob]) {
    const row = (job?.shots || []).find((s) => s.filename === filename);
    if (row) return row;
  }
  return null;
}

/** Whether the capture settings already hold an agent address or name (the person's own agent). */
function scAgentAddressSet(lab) {
  const fields = lab.targets?.data?.fields;
  return (Array.isArray(fields) ? fields : []).some((f) => ["copilotStudioAgentUrl", "copilotStudioAgentName"].includes(f?.id) && f.set === true);
}

/** The person's way of getting an agent for this lab: built from scratch, their own, or not chosen yet (null). */
function scAgentChoiceOf(lab, consent) {
  const stored = lab.ui.agentChoice;
  if (stored === "existing") return "existing";
  // "Scratch" is final only once the computer has been allowed to do it.
  if (stored === "scratch") return consent.scratch ? "scratch" : null;
  // Nothing chosen on this visit: an agent address the person saved is their choice; otherwise the consent they gave decides.
  if (scAgentAddressSet(lab)) return "existing";
  return consent.scratch ? "scratch" : null;
}

/** What the lab's screenshots still need from the person, or null when nothing is known yet. */
function scTargetsModel(lab) {
  const data = lab.targets?.data || null;
  if (!data && !lab.needsAddress?.length) return null;
  const consent = scConsentModel(scState.status?.autonomy);
  const choice = scAgentChoiceOf(lab, consent);
  let missing = scMissingRequirements(data, lab.needsAddress);
  // The agent is not an address the person must supply: it is built from scratch, or they choose to use their own.
  let agentChoice = null;
  const agentView = missing.find((view) => view.id === "copilot-studio-agent");
  if (agentView && choice !== "existing") {
    if (choice === null) agentChoice = { count: agentView.count };
    missing = missing.filter((view) => view.id !== "copilot-studio-agent");
  }
  return { data, fields: scTargetFields(data), missing, agentChoice, choice, waiting: missing.reduce((sum, view) => sum + view.count, 0) };
}

function scBuildModel(labId) {
  const lab = scLab(labId);
  const state = lab.state || {};
  const companion = scState.status?.companion || {};
  const devices = Array.isArray(companion.devices) ? companion.devices : [];
  const connected = Boolean(companion.connected);
  const targets = scTargetsModel(lab);
  const model = {
    labId,
    state,
    counts: scCounts(state, (filename) => scLastAttempt(labId, filename)),
    checkState: scCheckStateOf(state),
    statusLoading: !scState.status && !scState.statusError,
    statusError: !scState.status && Boolean(scState.statusError),
    connected,
    deviceNames: devices.filter((d) => d.connected).map((d) => d.name),
    signedIn: Array.isArray(companion.signedInProducts) ? companion.signedInProducts : [],
    products: scProductsToSignIn(state),
    tenant: scTenantModel(labId),
    targets,
    addressWaiting: targets?.waiting || 0,
    agentChoiceWaiting: targets?.agentChoice?.count || 0,
    mode: lab.ui.mode,
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
  const accountLine = scBuildAccountLine(labId);
  if (accountLine) section.appendChild(accountLine);
  const auto = scBuildAutonomyLine(labId);
  if (auto) section.appendChild(auto);
  const agentLine = scBuildAgentLine(labId, model);
  if (agentLine) section.appendChild(agentLine);
  section.appendChild(scEl("div", { class: "sc-pairing-host", data: { scPairingHost: "lab" } }));
  section.appendChild(scBuildPrimary(model, lab));
  section.appendChild(scBuildModeChoice(labId));
  section.appendChild(scBuildBackgroundChoice(labId));
  section.appendChild(scEl("div", { class: "sc-progress-host", data: { scProgressHost: labId } }));
  const choice = scBuildAgentChoice(labId, model);
  if (choice) section.appendChild(choice);
  const needs = scBuildAddressPrompt(labId, model);
  if (needs) section.appendChild(needs);
  const settings = scBuildCaptureSettings(labId, model);
  if (settings) section.appendChild(settings);
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
  if (!lab.targets || (lab.targets.loaded && Date.now() - lab.targets.loadedAt > 20000)) void scLoadTargets(labId, { force: true });
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
  if (counts.needsYou) pills.appendChild(scChip(`${counts.needsYou} need you`, "warn"));
  if (counts.paused) pills.appendChild(scChip(`${counts.paused} paused`, "info"));
  if (model.addressWaiting) pills.appendChild(scChip(`${model.addressWaiting} need an address`, "warn"));
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
  const causes = scBuildCauses(labId, outcome.causes);
  if (causes) banner.appendChild(causes);
  const created = scBuildCreatedItems(outcome.created, outcome.scratch);
  if (created) banner.appendChild(created);
  const signIn = scBuildSignInVerdict(outcome.signIn);
  if (signIn) banner.appendChild(signIn);
  // A capture that stopped because of the account says so in one plain sentence (it is also the first line of the message when nothing was captured).
  if (outcome.needsAccount?.message && !String(outcome.message).includes(outcome.needsAccount.message)) {
    banner.appendChild(scEl("p", { class: "sc-banner-account", text: outcome.needsAccount.message, data: { scNeedsAccount: outcome.needsAccount.code } }));
  }
  const actions = scEl("div", { class: "sc-banner-actions" });
  for (const act of Array.isArray(outcome.actions) ? outcome.actions : []) {
    actions.appendChild(scButton(act.label, { action: `banner-${act.id}`, primary: Boolean(act.primary), data: { filenames: (act.filenames || []).join(",") } }));
  }
  actions.appendChild(scButton("Dismiss", { action: "banner-dismiss", focus: "banner-dismiss", aria: { "aria-label": "Dismiss this message" } }));
  banner.appendChild(actions);
  return banner;
}

const SC_CAUSE_FIX_LABELS = Object.freeze({
  settings: () => "Open capture settings",
  retry: (count) => `Retake ${scPlural(count, "screenshot")}`,
  guided: (count) => `Retake ${scPlural(count, "screenshot")} guided`,
  upload: () => "Go to the first screenshot",
  record: (count) => `Show me once for ${scPlural(count, "screenshot")}`,
  consent: () => "Allow a practice agent",
  account: () => "Choose which account to use",
});

/** Why a sign-in did not work and the one next step, in plain language. Built with text nodes only. */
function scBuildSignInVerdict(signIn) {
  if (!signIn || (!signIn.summary && !signIn.nextStep)) return null;
  const box = scEl("section", { class: "sc-signin-verdict", attrs: { "aria-labelledby": "sc-signin-heading" }, data: { scSigninVerdict: "1" } });
  box.appendChild(scEl("h6", { id: "sc-signin-heading", class: "sc-created-heading", text: "Why sign-in did not stick" }));
  if (signIn.summary) box.appendChild(scEl("p", { class: "sc-created-help", text: signIn.summary }));
  if (signIn.nextStep) box.appendChild(scEl("p", { class: "sc-signin-next", text: `Next step: ${signIn.nextStep}` }));
  const checks = Array.isArray(signIn.checks) ? signIn.checks : [];
  if (checks.length) {
    const details = scEl("details", { class: "sc-signin-checks" });
    details.appendChild(scEl("summary", { text: `Things that can cause this (${checks.length})` }));
    const list = scEl("ul", { class: "sc-created-list" });
    for (const check of checks) list.appendChild(scEl("li", { text: `${check.title}${check.level === "likely" ? " (likely)" : ""}${check.fix ? `: ${check.fix}` : ""}` }));
    details.appendChild(list);
    box.appendChild(details);
  }
  if (signIn.command) {
    const hint = scEl("p", { class: "sc-created-help" });
    hint.appendChild(document.createTextNode("To see exactly what the browser did, run this on that computer and send the file it writes: "));
    hint.appendChild(scEl("code", { text: signIn.command }));
    box.appendChild(hint);
  }
  return box;
}

/** What the computer created in the practice environment, so the person can delete it themselves. The computer never deletes. */
function scBuildCreatedItems(created, scratch = null) {
  const items = (Array.isArray(created) ? created : []).filter((item) => item?.what);
  if (!items.length && !scratch?.name) return null;
  const box = scEl("section", { class: "sc-created", attrs: { "aria-labelledby": "sc-created-heading" }, data: { scCreated: "1" } });
  box.appendChild(scEl("h6", { id: "sc-created-heading", class: "sc-created-heading", text: "What the computer created" }));
  if (scratch?.name) {
    box.appendChild(scEl("p", { class: "sc-created-agent", text: `Practice agent: ${scratch.name}${scratch.createdAt ? ` (created ${scratch.createdAt}${scratch.reused ? ", reused this time" : ""})` : ""}.`, data: { scCreatedAgent: "1" } }));
    if (scratch.stopped) box.appendChild(scEl("p", { class: "sc-created-help", text: `The run stopped early: ${scratch.stopped}` }));
  }
  box.appendChild(scEl("p", { class: "sc-created-help", text: "It never deletes anything. To remove the practice agent yourself, open Copilot Studio, find it in the Agents list, and delete it there. Its address and the full list of what the computer did are in practice-report.md next to the companion; nothing in that file ever comes to this page." }));
  if (items.length) {
    const list = scEl("ul", { class: "sc-created-list" });
    for (const item of items) list.appendChild(scEl("li", { text: `${item.what}${item.reused ? " (reused)" : ""}` }));
    box.appendChild(list);
  }
  return box;
}

/** One group per cause: the title, how many screenshots, the one fix, and the file list on request. */
function scBuildCauses(labId, causes) {
  if (!Array.isArray(causes) || !causes.length) return null;
  const lab = scLab(labId);
  const shots = lab.state?.shots || [];
  const list = scEl("ul", { class: "sc-causes", attrs: { "aria-label": "Why some screenshots were not captured" } });
  for (const cause of causes) {
    const open = lab.ui.causesOpen.has(cause.code);
    const filesId = `sc-cause-files-${cause.code}`;
    const item = scEl("li", { class: `sc-cause sc-cause-${cause.tone}`, data: { scCause: cause.code } });
    const head = scEl("div", { class: "sc-cause-head" });
    head.appendChild(scEl("strong", { class: "sc-cause-title", text: cause.title }));
    head.appendChild(scChip(scPlural(cause.count, "screenshot"), cause.tone));
    item.appendChild(head);
    if (cause.fix) item.appendChild(scEl("p", { class: "sc-cause-fix", text: cause.fix }));
    const actions = scEl("div", { class: "sc-cause-actions" });
    actions.appendChild(
      scButton(SC_CAUSE_FIX_LABELS[cause.fixAction](cause.count), {
        action: "cause-fix",
        data: { cause: cause.code },
        focus: `cause:${cause.code}:fix`,
        aria: { "aria-label": `${SC_CAUSE_FIX_LABELS[cause.fixAction](cause.count)}: ${cause.title}` },
      }),
    );
    if (cause.filenames.length) {
      actions.appendChild(
        scButton(open ? "Hide the list" : "Show which ones", {
          action: "cause-toggle",
          data: { cause: cause.code },
          focus: `cause:${cause.code}:toggle`,
          aria: { "aria-expanded": open ? "true" : "false", "aria-controls": filesId, "aria-label": `${open ? "Hide" : "Show"} the screenshots for: ${cause.title}` },
        }),
      );
    }
    item.appendChild(actions);
    if (cause.filenames.length) {
      const files = scEl("ul", { id: filesId, class: "sc-cause-files", attrs: { hidden: !open } });
      for (const filename of cause.filenames) {
        const shot = shots.find((s) => s.filename === filename);
        files.appendChild(scEl("li", { text: shot ? scShotLabel(shot) : filename }));
      }
      item.appendChild(files);
    }
    list.appendChild(item);
  }
  return list;
}

// Which account the screenshots come from ------------------------------------

/**
 * One plain line about the account the computer will use, with a warning and the one-click fix when it is not what the
 * person wants. It never shows a tenant, an account name, or an address: only what the companion reports as yes/no facts.
 */
function scBuildAccountLine(labId) {
  const lab = scLab(labId);
  const account = scAccountModel(scState.status?.companion);
  if (!account) return null;
  const wrap = scEl("div", { class: `sc-account sc-account-${account.tone}`, attrs: { role: "group", "aria-label": "Which account the screenshots come from" }, data: { scAccount: account.state } });
  const head = scEl("div", { class: "sc-account-head" });
  head.appendChild(scEl("p", { class: "sc-account-text", text: account.text, data: { scAccountText: "1" } }));
  if (account.tone === "warn") head.appendChild(scChip("Check this", "warn"));
  wrap.appendChild(head);
  if (account.help) wrap.appendChild(scEl("p", { class: "hint", text: account.help, data: { scAccountHelp: "1" } }));
  const setup = account.setup;
  const message = lab.ui.accountMessage || "";
  const status = scEl("p", { class: `sc-account-setup${setup?.state === "failed" || setup?.state === "needs-account" || message ? " sc-account-setup-warn" : ""}`, attrs: { role: "status", "aria-live": "polite", hidden: !(setup || message) }, data: { scAccountSetup: setup?.state || (message ? "message" : "") } });
  status.textContent = message || setup?.text || "";
  wrap.appendChild(status);
  if (account.fix) {
    const busy = Boolean(lab.ui.accountBusy) || Boolean(setup?.busy);
    const actions = scEl("div", { class: "sc-step-actions" });
    actions.appendChild(scButton(busy ? "Waiting for your computer" : account.fix.label, { action: "account-setup", focus: "account-setup", disabled: busy, primary: account.tone === "warn", aria: busy ? { "aria-busy": "true" } : {} }));
    wrap.appendChild(actions);
  }
  return wrap;
}

// Readiness strip ------------------------------------------------------------

const SC_STEP_STATE_LABEL = Object.freeze({ done: "Done", todo: "To do", optional: "Optional", locked: "Waiting", loading: "Checking", error: "Problem" });
const SC_STEP_STATE_TONE = Object.freeze({ done: "ok", todo: "warn", optional: "neutral", locked: "neutral", loading: "info", error: "bad" });

function scBuildStrip(model) {
  const words = { 3: "three", 4: "four" };
  const list = scEl("ol", { class: "sc-steps", attrs: { "aria-label": `Set up screenshot capture in ${words[model.steps.length]} steps` }, data: { steps: model.steps.length } });
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
  codeItem.appendChild(scEl("span", { text: "Unzip it, then run the launcher in the capture-companion/tools/screenshot-capture folder (start-companion.cmd on Windows, start-companion.sh on macOS and Linux). When it asks for a pairing code, enter this one:" }));
  const codeRow = scEl("div", { class: "sc-code-row" });
  codeRow.appendChild(scEl("code", { class: "sc-code", text: p.code, attrs: { "aria-label": `Pairing code ${p.code.split("").join(" ")}` } }));
  codeRow.appendChild(scButton("Copy code", { action: "pair-copy-code", focus: "pair-copy-code" }));
  codeRow.appendChild(scCopyAckEl("pair-copy-code"));
  codeItem.appendChild(codeRow);
  steps.appendChild(codeItem);

  const commandItem = scBuildCommandItem(p);
  if (commandItem) steps.appendChild(commandItem);
  else if (p.command) {
    // An older server sends only the command text.
    const cmdItem = scEl("li");
    cmdItem.appendChild(scEl("span", { text: "Or run this ready-made command:" }));
    const cmdRow = scEl("div", { class: "sc-code-row" });
    cmdRow.appendChild(scEl("code", { class: "sc-command", text: p.command }));
    cmdRow.appendChild(scButton("Copy command", { action: "pair-copy-command", focus: "pair-copy-command" }));
    cmdRow.appendChild(scCopyAckEl("pair-copy-command"));
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

// Capture mode ---------------------------------------------------------------

/** "How should screenshots be captured?" Used by every capture the Center queues, and by Retake. Automatic is first; the rest is under Advanced. */
function scBuildModeChoice(labId) {
  const lab = scLab(labId);
  const fieldset = scEl("fieldset", { class: "sc-mode", data: { scModeGroup: "1" } });
  fieldset.appendChild(scEl("legend", { text: "How should screenshots be captured?" }));
  const radioRow = (mode) => {
    const id = `sc-mode-${mode.id}`;
    const row = scEl("div", { class: "sc-mode-option" });
    const radio = scEl("input", {
      id,
      attrs: { type: "radio", name: "sc-capture-mode", value: mode.id, autocomplete: "off", "aria-describedby": `${id}-help` },
      data: { scField: "mode", scMode: mode.id, scFocus: `mode:${mode.id}` },
    });
    radio.checked = lab.ui.mode === mode.id;
    row.appendChild(radio);
    row.appendChild(scLabel(id, mode.label));
    row.appendChild(scEl("p", { id: `${id}-help`, class: "sc-mode-help", text: mode.help }));
    return row;
  };
  const options = scEl("div", { class: "sc-mode-options" });
  for (const mode of SC_CAPTURE_MODES.filter((m) => !m.advanced)) options.appendChild(radioRow(mode));
  fieldset.appendChild(options);
  const advanced = scEl("details", { class: "sc-mode-advanced", data: { scModeAdvanced: "1" } });
  // A choice made under Advanced keeps it open, so the selected radio is never hidden.
  advanced.open = SC_CAPTURE_MODES.some((m) => m.advanced && m.id === lab.ui.mode);
  advanced.appendChild(scEl("summary", { text: "Advanced: set up screens yourself" }));
  const more = scEl("div", { class: "sc-mode-options" });
  for (const mode of SC_CAPTURE_MODES.filter((m) => m.advanced)) more.appendChild(radioRow(mode));
  advanced.appendChild(more);
  fieldset.appendChild(advanced);
  return fieldset;
}

/** Background running: a hidden window with the saved sign-in. It is a choice about the window, not about what the computer may do, so it sits outside the mode group. */
function scBuildBackgroundChoice(labId) {
  const lab = scLab(labId);
  const row = scEl("div", { class: "sc-mode-background" });
  const box = scEl("input", { id: "sc-run-background", attrs: { type: "checkbox", autocomplete: "off", "aria-describedby": "sc-run-background-help" }, data: { scField: "background", scFocus: "background" } });
  box.checked = lab.ui.background === true;
  row.appendChild(box);
  row.appendChild(scLabel("sc-run-background", "Run in the background when already signed in"));
  row.appendChild(scEl("p", { id: "sc-run-background-help", class: "sc-mode-help", text: "A hidden window uses your saved sign-in, so you can start the capture and walk away. If Microsoft asks you to sign in again, a normal window opens instead." }));
  return row;
}

// Automatic capture: what the computer may do, and the one-time yes ------------

/** The line under the readiness strip: whether automatic capture is on, and the ways to change that. */
function scBuildAutonomyLine(labId) {
  const lab = scLab(labId);
  if (!scIsAutomaticMode(lab.ui.mode)) return null;
  const consent = scConsentModel(scState.status?.autonomy);
  const line = scAutonomyLine(consent);
  const wrap = scEl("div", { class: `sc-auto sc-auto-${line.state}`, data: { scAuto: line.state } });
  wrap.appendChild(scEl("p", { class: "sc-auto-text", text: line.text, data: { scAutoText: "1" } }));
  if (consent.loaded && !consent.companionSupported) {
    wrap.appendChild(scEl("p", { class: "sc-auto-warn", text: `Your Local Capture Companion is older than ${consent.minCompanion}, so it cannot capture on its own yet. Download it again and replace the old one. Until then, captures run the older way.`, attrs: { role: "status" }, data: { scAutoOld: "1" } }));
  }
  const actions = scEl("div", { class: "sc-step-actions" });
  if (consent.loaded && !consent.consented) actions.appendChild(scButton("Allow automatic capture", { action: "consent-open", focus: "consent-open", primary: !lab.ui.consentOpen }));
  else if (consent.consented) {
    actions.appendChild(scButton("Change what it may do", { action: "consent-open", focus: "consent-open" }));
    actions.appendChild(scButton("Turn off", { action: "consent-revoke", focus: "consent-revoke" }));
  }
  if (actions.childNodes.length) wrap.appendChild(actions);
  if (lab.ui.consentOpen) wrap.appendChild(scBuildConsentCard(labId, consent));
  return wrap;
}

/** The practice agent the latest finished capture of this lab built or reused, as the companion reported it (a name and a date, never an address). */
function scLastScratch(lab) {
  for (const job of [lab.job, lab.lastJob]) {
    const summary = scScratchSummary(job?.result?.scratch);
    if (summary?.name) return summary;
  }
  return null;
}

/** The "Agent:" line of the readiness strip, with Start fresh and the way to switch to an existing agent. */
function scBuildAgentLine(labId, model) {
  const lab = scLab(labId);
  if (!scIsAutomaticMode(lab.ui.mode)) return null;
  const consent = scConsentModel(scState.status?.autonomy);
  if (!consent.loaded || !consent.consented) return null;
  const choice = scAgentChoiceOf(lab, consent);
  const line = scAgentLine({ consent, scratchChosen: choice === "scratch", existingChosen: choice === "existing", last: scLastScratch(lab), startFresh: lab.ui.startFresh === true });
  const wrap = scEl("div", { class: `sc-agent-line sc-agent-line-${line.state}`, data: { scAgentLine: line.state } });
  wrap.appendChild(scEl("p", { class: "sc-agent-text", text: line.text, data: { scAgentText: "1" } }));
  const actions = scEl("div", { class: "sc-step-actions" });
  if (line.canStartFresh) {
    actions.appendChild(scButton(line.fresh ? "Keep the same agent" : "Start fresh", { action: "agent-start-fresh", focus: "agent-start-fresh", aria: { "aria-pressed": line.fresh ? "true" : "false" } }));
  }
  if (choice === "scratch") actions.appendChild(scButton("Use an existing agent instead", { action: "agent-existing", focus: "agent-existing" }));
  if (choice === "existing" && consent.scratch) actions.appendChild(scButton("Build the agent from scratch instead", { action: "agent-scratch", focus: "agent-scratch" }));
  if (actions.childNodes.length) wrap.appendChild(actions);
  return wrap;
}

/** The choice that replaces the old "your agent address" prompt: build the agent from scratch (recommended) or use your own. */
function scBuildAgentChoice(labId, model) {
  const choice = model.targets?.agentChoice;
  if (!choice) return null;
  const consent = scConsentModel(scState.status?.autonomy);
  const section = scEl("section", { class: "sc-agent-choice", attrs: { "aria-labelledby": "sc-agent-choice-heading" }, data: { scAgentChoice: "1" } });
  section.appendChild(scEl("h5", { id: "sc-agent-choice-heading", class: "sc-needs-heading", text: "Which agent should the screenshots use?", attrs: { tabindex: "-1" }, data: { scFocus: "agent-choice-heading" } }));
  section.appendChild(scEl("p", { class: "sc-agent-choice-lead", text: `${scPlural(choice.count, "screenshot")} ${choice.count === 1 ? "shows" : "show"} an agent. You do not need to have one: the computer can build it by following the lab.` }));
  const scratch = scEl("div", { class: "sc-agent-option" });
  scratch.appendChild(scButton("Build the agent from scratch (recommended)", { action: "agent-scratch", focus: "agent-scratch", primary: true }));
  scratch.appendChild(scEl("p", { id: "sc-agent-scratch-help", class: "hint", text: "The computer creates a new practice agent in your demo account, sets it up the way the lab does, and takes each screenshot as the lab reaches that state. You confirm once what it may create, and you can stop it at any time." }));
  section.appendChild(scratch);
  const existing = scEl("div", { class: "sc-agent-option" });
  existing.appendChild(scButton("Use an existing agent", { action: "agent-existing", focus: "agent-existing" }));
  existing.appendChild(scEl("p", { id: "sc-agent-existing-help", class: "hint", text: "Paste the address or type the name of an agent you already have, and the computer only looks at it." }));
  section.appendChild(existing);
  if (consent.loaded && !consent.scratchSupported) {
    section.appendChild(scEl("p", { class: "sc-auto-warn", text: `Your Local Capture Companion is older than ${consent.scratchMinCompanion}, so it cannot build an agent from scratch yet. Download it again and replace the old one first.`, attrs: { role: "status" }, data: { scAutoOld: "scratch" } }));
  }
  return section;
}

/** The consent card: what the computer may do, what it never does, and the separate, unticked practice agent choice. */
function scBuildConsentCard(labId, consent) {
  const lab = scLab(labId);
  const draft = lab.ui.consentDraft;
  if (!draft.touched) {
    draft.practice = consent.level === "practice";
    draft.scratch = consent.level === "scratch";
    draft.url = consent.practiceEnvironmentUrl || scSuggestedPracticeUrl(labId);
    draft.touched = true;
  }
  const building = Boolean(draft.scratch);
  const card = scEl("section", { class: `sc-consent${building ? " sc-consent-scratch" : ""}`, attrs: { "aria-labelledby": "sc-consent-heading" }, data: { scConsent: "1", scConsentMode: building ? "scratch" : draft.practice ? "practice" : "read-only" } });
  card.appendChild(scEl("h5", { id: "sc-consent-heading", class: "sc-consent-heading", text: building ? "Build the agent from scratch" : "Allow automatic capture", attrs: { tabindex: "-1" }, data: { scFocus: "consent-heading" } }));
  card.appendChild(scEl("p", { text: building ? "You sign in once. After that the computer builds a new practice agent in your demo account by following the lab, and takes each screenshot as the lab reaches that state, without you clicking anything. Here is exactly what it will create and change, and what it will never do." : "You sign in once. After that the computer takes the screenshots without you clicking anything. Here is exactly what it may and may not do." }));
  const accountModel = scAccountModel(scState.status?.companion);
  card.appendChild(
    scEl("p", {
      class: "sc-consent-account",
      text: accountModel ? `The computer will use this account: ${scAccountSentence(accountModel)}` : "The computer will use the account you sign in with in its browser window. Connect your computer to see which account that is.",
      data: { scConsentAccount: accountModel ? accountModel.state : "unknown" },
    }),
  );
  card.appendChild(scEl("p", { class: "hint", text: "Automatic capture also waits until the account is verified against your own agent or site address, or you have chosen it once with “Choose which account to use”." }));
  card.appendChild(scEl("h6", { class: "sc-consent-sub", text: "It may" }));
  const may = scEl("ul", { class: "sc-consent-list", data: { scMay: "1" } });
  for (const text of ["Open pages and sections, select tabs, and scroll", "Open dialogs and panels, and cancel them afterward", "Ask the test pane a sample question (it is not saved to your agent)", "Type a search, or fill in a dialog without confirming it"]) may.appendChild(scEl("li", { text }));
  card.appendChild(may);
  if (building) {
    card.appendChild(scEl("h6", { class: "sc-consent-sub", text: "To build the agent it will create and change" }));
    const creates = scEl("ul", { class: "sc-consent-list", data: { scCreates: "1" } });
    for (const text of consent.creates) creates.appendChild(scEl("li", { text }));
    card.appendChild(creates);
  }
  card.appendChild(scEl("h6", { class: "sc-consent-sub", text: "It never will" }));
  const never = scEl("ul", { class: "sc-consent-list", data: { scNever: "1" } });
  for (const text of consent.never) never.appendChild(scEl("li", { text }));
  card.appendChild(never);

  // Build from scratch: the recommended way to get an agent. Where it builds is optional: it is the environment Copilot Studio opens for the account.
  const scratchId = "sc-consent-scratch";
  const scratchRow = scEl("div", { class: "sc-consent-practice sc-consent-scratch-row" });
  const scratchLabel = scEl("label", { class: "sc-check", attrs: { for: scratchId } });
  const scratchBox = scEl("input", { id: scratchId, attrs: { type: "checkbox", autocomplete: "off", "aria-describedby": "sc-consent-scratch-help" }, data: { scField: "consent-scratch" } });
  scratchBox.checked = building;
  scratchLabel.appendChild(scratchBox);
  scratchLabel.appendChild(scEl("span", { text: "Build the agent from scratch (recommended): it creates one new practice agent and follows the lab on it" }));
  scratchRow.appendChild(scratchLabel);
  scratchRow.appendChild(scEl("p", { id: "sc-consent-scratch-help", class: "hint", text: "The agent is named “Lab screenshots - ” and a short title from your lab. It is the only agent the computer ever changes, it never deletes anything, and it lists what it made. The first time, your computer also asks you once to confirm this in its console window." }));
  card.appendChild(scratchRow);

  const practiceId = "sc-consent-practice";
  const practiceRow = scEl("div", { class: "sc-consent-practice" });
  const practiceLabel = scEl("label", { class: "sc-check", attrs: { for: practiceId } });
  const practiceBox = scEl("input", { id: practiceId, attrs: { type: "checkbox", autocomplete: "off", "aria-describedby": "sc-consent-practice-help" }, data: { scField: "consent-practice" } });
  practiceBox.checked = Boolean(draft.practice);
  practiceLabel.appendChild(practiceBox);
  practiceLabel.appendChild(scEl("span", { text: "Or let it create a practice agent in an environment I name, only for screens that need one (it will not delete anything, and lists what it made)" }));
  practiceRow.appendChild(practiceLabel);
  practiceRow.appendChild(scEl("p", { id: "sc-consent-practice-help", class: "hint", text: "The practice agent is named “Lab screenshots - ” and a short code. It is the only agent the computer ever changes. It never publishes to a channel or shares it with anyone. Your computer asks you once to confirm this too, or start it with --allow-practice-writes." }));
  card.appendChild(practiceRow);
  const urlId = "sc-consent-url";
  const urlGroup = scEl("div", { class: "form-group sc-field" });
  urlGroup.appendChild(scLabel(urlId, building ? "Where should it build? (optional)" : "Practice environment address"));
  const urlInput = scEl("input", {
    id: urlId,
    attrs: { type: "url", inputmode: "url", autocomplete: "off", spellcheck: "false", placeholder: "https://copilotstudio.microsoft.com/environments/<environment id>/home", maxlength: 2048, "aria-describedby": "sc-consent-url-hint" },
    data: { scField: "consent-url" },
  });
  urlInput.value = draft.url || "";
  urlInput.disabled = !(draft.practice || building);
  urlGroup.appendChild(urlInput);
  urlGroup.appendChild(scEl("span", { id: "sc-consent-url-hint", class: "hint", text: building ? "Leave this empty to use the environment Copilot Studio opens for your demo account. The computer never switches environments by itself. Use an environment you do not mind adding a test agent to." : "Use an environment you do not mind adding a test agent to. Copy the address from the address bar." }));
  card.appendChild(urlGroup);

  const agreeId = "sc-consent-agree";
  const agreeLabel = scEl("label", { class: "sc-check", attrs: { for: agreeId } });
  const agreeBox = scEl("input", { id: agreeId, attrs: { type: "checkbox", autocomplete: "off" }, data: { scField: "consent-agree" } });
  agreeBox.checked = Boolean(draft.agreed);
  agreeLabel.appendChild(agreeBox);
  agreeLabel.appendChild(scEl("span", { text: building ? "I understand what the computer will create and change, and what it will never do" : "I understand what the computer may and may not do" }));
  card.appendChild(agreeLabel);
  if (draft.error) card.appendChild(scEl("p", { class: "sc-field-error", text: draft.error, attrs: { role: "alert" }, data: { scConsentError: "1" } }));
  const actions = scEl("div", { class: "sc-step-actions" });
  actions.appendChild(scButton(building ? (lab.ui.queueAfterConsent ? "Allow and build the agent" : "Allow building the agent") : "Allow automatic capture", { action: "consent-save", focus: "consent-save", primary: true }));
  actions.appendChild(scButton("Not now", { action: "consent-close", focus: "consent-close" }));
  card.appendChild(actions);
  return card;
}

/** The practice environment from the capture settings, as a starting point for the consent card. */
function scSuggestedPracticeUrl(labId) {
  const fields = scLab(labId).targets?.data?.fields;
  const field = Array.isArray(fields) ? fields.find((f) => f?.id === "copilotStudioUrl") : null;
  return scSafeHttpsUrl(field?.value || "");
}

function scFocusConsent(labId) {
  const heading = document.getElementById("sc-consent-heading");
  if (!heading) return;
  heading.scrollIntoView?.({ behavior: "smooth", block: "center" });
  heading.focus?.({ preventScroll: true });
}

// Capture settings: the address prompt and the full panel ---------------------

/** A text box for one capture setting. Typed text is kept in `lab.ui.targetDraft`, so a re-render never loses it. */
function scBuildTargetInput(labId, field, { scope, describedBy = "", showHelp = false, source = "" }) {
  const ui = scLab(labId).ui;
  const id = `sc-${scope}-${field.id}`;
  const error = ui.targetErrors[field.id] || "";
  const group = scEl("div", { class: "form-group sc-field" });
  group.appendChild(scLabel(id, field.label));
  const describedIds = [describedBy, showHelp && field.help ? `${id}-hint` : "", source ? `${id}-source` : "", error ? `${id}-error` : ""].filter(Boolean);
  const input = scEl("input", {
    id,
    attrs: {
      type: field.kind === "url" ? "url" : "text",
      inputmode: field.kind === "url" ? "url" : "text",
      autocomplete: "off",
      spellcheck: "false",
      placeholder: field.placeholder,
      maxlength: field.kind === "url" ? 2048 : 80,
      "aria-describedby": describedIds.join(" ") || false,
      "aria-invalid": error ? "true" : false,
    },
    data: { scTargetField: field.id, scFocus: `target:${scope}:${field.id}` },
  });
  input.value = ui.targetDraft[field.id] ?? field.value;
  group.appendChild(input);
  if (showHelp && field.help) group.appendChild(scEl("span", { id: `${id}-hint`, class: "hint", text: field.help }));
  if (source) group.appendChild(scEl("span", { id: `${id}-source`, class: "sc-field-source", text: source }));
  if (error) group.appendChild(scEl("p", { id: `${id}-error`, class: "sc-field-error", text: error, attrs: { role: "alert" } }));
  return group;
}

/** The error that belongs to a whole block (a failed request with no field to blame), or null. */
function scFormError(labId, scope) {
  const error = scLab(labId).ui.targetFormError;
  return error?.scope === scope ? scEl("p", { class: "sc-field-error", text: error.message, attrs: { role: "alert" }, data: { scFormError: scope } }) : null;
}

/** One block per missing address: what is missing, how to find it, a box for it, and Save. */
function scBuildNeedBlock(labId, requirement, fields) {
  const ui = scLab(labId).ui;
  const scope = `need-${requirement.id}`;
  const titleId = `sc-need-${requirement.id}-title`;
  const helpId = `sc-need-${requirement.id}-help`;
  const block = scEl("div", { class: "sc-need", attrs: { role: "group", "aria-labelledby": titleId }, data: { scNeed: requirement.id, scScope: scope } });
  block.appendChild(scEl("p", { id: titleId, class: "sc-need-title" }, [scEl("strong", { text: requirement.message })]));
  if (requirement.prompt) block.appendChild(scEl("p", { id: helpId, class: "sc-need-help", text: requirement.prompt }));
  const inputs = scEl("div", { class: "sc-need-fields" });
  for (const id of requirement.fields) {
    const field = fields.find((f) => f.id === id) || scFallbackField(id, requirement);
    inputs.appendChild(scBuildTargetInput(labId, field, { scope, describedBy: requirement.prompt ? helpId : "" }));
  }
  block.appendChild(inputs);
  const profileId = `sc-${scope}-profile`;
  const profileRow = scEl("label", { class: "sc-check", attrs: { for: profileId } });
  const profileBox = scEl("input", { id: profileId, attrs: { type: "checkbox", autocomplete: "off" }, data: { scField: "also-profile", scScope: scope } });
  profileBox.checked = ui.alsoProfile.has(scope);
  profileRow.appendChild(profileBox);
  profileRow.appendChild(scEl("span", { text: "Use this for my other labs too" }));
  block.appendChild(profileRow);
  const form = scFormError(labId, scope);
  if (form) block.appendChild(form);
  block.appendChild(
    scEl("div", { class: "sc-step-actions" }, [
      scButton("Save", { action: "targets-save", data: { scope, fields: requirement.fields.join(",") }, focus: `targets-save:${scope}`, primary: true, aria: { "aria-label": `Save your ${requirement.noun}` } }),
    ]),
  );
  return block;
}

/** The inline card above the gallery: every address the screenshots are waiting for. */
function scBuildAddressPrompt(labId, model) {
  const targets = model.targets;
  if (!targets?.missing.length) return null;
  const section = scEl("section", { class: "sc-needs", attrs: { "aria-labelledby": "sc-needs-heading" }, data: { scNeeds: "1" } });
  section.appendChild(scEl("h5", { id: "sc-needs-heading", class: "sc-needs-heading", text: "Add what these screenshots need", attrs: { tabindex: "-1" }, data: { scFocus: "needs-heading" } }));
  for (const requirement of targets.missing) section.appendChild(scBuildNeedBlock(labId, requirement, targets.fields));
  section.appendChild(scEl("div", { class: "sc-step-actions" }, [scButton("Open all capture settings", { action: "targets-open-settings", focus: "needs-settings" })]));
  return section;
}

/** Every capture setting, grouped by product, with where its value comes from. */
function scBuildCaptureSettings(labId, model) {
  if (!model.targets?.data) return null;
  const { data, fields } = model.targets;
  const ui = scLab(labId).ui;
  const details = scEl("details", { class: "sc-settings", data: { scSettings: "1", scScope: "settings" } });
  details.open = Boolean(ui.settingsOpen);
  details.appendChild(scEl("summary", { text: "Capture settings: where should we capture?" }));
  const body = scEl("div", { class: "sc-settings-body" });
  const profile = scText(data.activeProfile?.name, 80);
  body.appendChild(
    scEl("p", {
      class: "hint",
      text: `These addresses and names tell your computer which environment and agent to open. A value saved for this lab is used before the brand profile's.${profile ? ` Active brand profile: ${profile}.` : ""}`,
    }),
  );
  for (const group of scGroupTargetFields(fields)) {
    const fieldset = scEl("fieldset", { class: "sc-settings-group" });
    fieldset.appendChild(scEl("legend", { text: group.name }));
    const grid = scEl("div", { class: "sc-adv-grid" });
    for (const field of group.fields) {
      const source = field.set ? (field.sourceLabel ? `From ${field.sourceLabel}.` : "Set.") : "Not set yet.";
      grid.appendChild(scBuildTargetInput(labId, field, { scope: "settings", showHelp: true, source }));
    }
    fieldset.appendChild(grid);
    body.appendChild(fieldset);
  }
  const fieldIds = fields.map((field) => field.id).join(",");
  const form = scFormError(labId, "settings");
  if (form) body.appendChild(form);
  body.appendChild(
    scEl("div", { class: "sc-step-actions" }, [
      scButton("Save for this lab", { action: "targets-save", data: { scope: "settings", fields: fieldIds }, focus: "targets-save:settings", primary: true }),
      scButton("Save for all labs (brand profile)", { action: "targets-save", data: { scope: "settings", fields: fieldIds, profile: "1" }, focus: "targets-save:settings-all" }),
    ]),
  );
  details.appendChild(body);
  return details;
}

function scFocusNeeds(labId) {
  const heading = scHostFor(labId)?.querySelector("#sc-needs-heading");
  if (!heading) return;
  heading.scrollIntoView?.({ behavior: "smooth", block: "center" });
  heading.focus?.({ preventScroll: true });
}

function scOpenSettings(labId) {
  const lab = scLab(labId);
  const details = scHostFor(labId)?.querySelector("[data-sc-settings]");
  if (!details) return;
  lab.ui.settingsOpen = true;
  details.open = true;
  details.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  details.querySelector("input")?.focus?.({ preventScroll: true });
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

/** The sentence the companion last reported for the screenshot it is working on, when it is one of its own progress phrases. */
function scCurrentStepText(key, view) {
  const row = (scLab(key).job?.shots || []).find((s) => s.filename === view.currentFilename);
  const text = scText(row?.message, 120);
  // Plain status words only: the first lines a companion sends ("Capturing.") say nothing a person can use.
  return text && text !== "Capturing." && row?.status === "running" ? text : "";
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
  // What the computer is doing this second ("Creating the agent", "Asking the test pane a sample question"), as it reports it.
  const step = view.phase === "running" ? scCurrentStepText(key, view) : "";
  card.appendChild(scEl("p", { class: "sc-progress-step", text: step, attrs: { hidden: !step, role: "status", "aria-live": "polite" }, data: { scProgressStep: "1" } }));
  const counts = scEl("ul", { class: "sc-progress-counts", data: { scProgressCounts: "1" } });
  scFillCounts(counts, view.counts);
  card.appendChild(counts);
  card.appendChild(scEl("p", { class: "sc-progress-detail", text: view.detail }));
  const actions = scEl("div", { class: "sc-step-actions" });
  if (view.phase === "queued-offline" && key !== "library") {
    actions.appendChild(scButton("Connect your computer", { action: "step-connect", focus: "progress-connect" }));
  }
  if (view.phase !== "cancelling") {
    // Pause stops after the current screenshot and keeps the rest for Resume; Stop drops them.
    if (view.phase === "running" || view.phase === "starting") actions.appendChild(scButton("Pause", { action: "job-pause", data: { jobKey: key }, focus: "pause" }));
    actions.appendChild(scButton(view.phase === "running" || view.phase === "starting" ? "Stop" : "Cancel capture", { action: "job-cancel", data: { jobKey: key }, focus: "cancel" }));
  }
  card.appendChild(actions);
  return card;
}

function scFillCounts(list, c) {
  list.replaceChildren();
  list.appendChild(scEl("li", {}, [scChip(`${c.captured} captured`, c.captured ? "ok" : "neutral")]));
  list.appendChild(scEl("li", {}, [scChip(`${c.needsReview} need review`, c.needsReview ? "warn" : "neutral")]));
  list.appendChild(scEl("li", {}, [scChip(`${c.failed} failed`, c.failed ? "bad" : "neutral")]));
  // These only appear when there is something to say, so the usual three chips stay as they were.
  if (scCount(c.needsYou)) list.appendChild(scEl("li", {}, [scChip(`${c.needsYou} need you`, "warn")]));
  if (scCount(c.paused)) list.appendChild(scEl("li", {}, [scChip(`${c.paused} paused`, "info")]));
  if (scCount(c.skipped)) list.appendChild(scEl("li", {}, [scChip(`${c.skipped} skipped`, "neutral")]));
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
  const stepEl = card.querySelector("[data-sc-progress-step]");
  if (stepEl) {
    const step = view.phase === "running" ? scCurrentStepText(key, view) : "";
    if (stepEl.textContent !== step) stepEl.textContent = step;
    stepEl.hidden = !step;
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
  cliRow.appendChild(scCopyAckEl("copy-cli"));
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

function scShotNote(shot, status, attempt = null, waitingNouns = []) {
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
    case "needs-you":
      // An automatic capture that could not finish says exactly where it stopped and offers "Show me once".
      if (attempt && SC_AUTOMATION_CAUSES.includes(attempt.cause)) return scText(attempt.message || attempt.error, 300) || "The computer could not set this screen up. Use Show me once, or set it up yourself with Retake guided.";
      return "This screen needs you. Select Retake guided, set up the screen yourself, and capture it.";
    case "paused":
      return "The capture paused before this one was captured. Resume the capture, or retake this one.";
    case "manual":
      return "This screen needs a person. Take it yourself, then paste or upload it.";
    case "outdated":
      return "Microsoft Learn changed this topic. Retake it so the picture matches.";
    case "pending":
    case "queued":
      if (attempt?.status === "skipped") return scText(attempt.message, 200) || "This one was skipped. Retake it when you are ready.";
      if (waitingNouns.length) return `Waiting for your ${scJoinNames(waitingNouns, 2)}. Add it above, then capture this one.`;
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

/** The nouns of the requirements a screenshot is waiting for ("agent address"), from the capture settings. */
function scWaitingNouns(labId, capture) {
  const requirements = Array.isArray(scLab(labId).targets?.data?.requirements) ? scLab(labId).targets.data.requirements : [];
  return (capture?.missing || []).map((id) => scText(requirements.find((r) => r?.id === id)?.noun, 80) || "address");
}

/** "Copilot Studio > your agent > Settings", with words for a screen reader instead of the arrows. */
function scBuildPath(path) {
  return scEl("p", { class: "sc-path", data: { scPath: "1" } }, [
    scEl("span", { class: "sr-only", text: `Path: ${path.join(", then ")}.` }),
    scEl("span", { class: "sc-path-text", text: path.join(" > "), attrs: { "aria-hidden": "true" } }),
  ]);
}

/** "Opened Copilot Studio, then your agent, then Knowledge, then opened “Add knowledge”": what the computer will do, from the plan. */
function scPlannedLine(capture) {
  const parts = [...capture.path.filter(Boolean)];
  if (!parts.length && !capture.summary.length) return "";
  const first = parts.length ? `Will open ${parts.join(", then ")}` : "Will open the page";
  const did = capture.summary.length ? `, then ${capture.summary.map((s) => s.replace(/^(\w)/, (c) => c.toLowerCase())).join(", then ")}` : "";
  return `${first}${did}.`;
}

/** Why a shot needs a practice agent, and what happens without one. */
function scPracticeNote(lab) {
  const allowed = scConsentModel(scState.status?.autonomy).level === "practice";
  return allowed && lab.ui.mode !== "autonomous-readonly"
    ? "The final state needs a practice agent. The computer creates one once in your practice environment and reuses it."
    : "The final state needs a practice agent. Without one, the picture shows this screen as far as the computer can go (for example the Publish dialog before it is confirmed) and is saved for review.";
}

function scBuildCard(labId, shot, jobStatus) {
  const lab = scLab(labId);
  const status = scStatusFor(labId, shot, jobStatus);
  const attempt = shot.captured ? null : scLastAttempt(labId, shot.filename);
  const capture = scShotCapture(shot);
  const outcome = scText(scJobRow(labId, shot.filename)?.outcome);
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
  if (capture) {
    const automatic = scIsAutomaticMode(lab.ui.mode) && capture.mode !== "manual";
    const chip = automatic ? SC_SHOT_MODES.autonomous : SC_SHOT_MODES[capture.mode];
    top.appendChild(scChip(chip.label, chip.tone, "sc-mode-chip"));
  }
  if (shot.figure) top.appendChild(scEl("span", { class: "sc-fig", text: `Figure ${shot.figure}` }));
  body.appendChild(top);
  body.appendChild(scEl("p", { class: "sc-caption", text: String(shot.caption || shot.alt || shot.filename) }));
  // In automatic mode nobody is told to set a screen up: the card says what the computer will do, and what it cannot do without a practice agent.
  const plan = capture && scIsAutomaticMode(lab.ui.mode) && capture.mode !== "manual" ? scPlannedLine(capture) : "";
  if (plan) {
    body.appendChild(scEl("p", { class: "sc-why sc-plan", text: plan, data: { scPlan: "1" } }));
    if (capture.needsPractice) body.appendChild(scEl("p", { class: "sc-practice-note", text: scPracticeNote(lab), data: { scPracticeNote: "1" } }));
  } else if (capture?.why) body.appendChild(scEl("p", { class: "sc-why", text: capture.why, data: { scWhy: "1" } }));
  if (capture?.path.length) body.appendChild(scBuildPath(capture.path));
  // While the computer works on this shot, the live message from the job says what it is doing right now.
  const running = status.key === "capturing" ? scText(scJobRow(labId, shot.filename)?.message, 200) : "";
  body.appendChild(scEl("p", { class: "sc-note", text: running || scShotNote(shot, status, attempt, scWaitingNouns(labId, capture)), data: { scNote: "1" }, attrs: running ? { role: "status" } : {} }));
  if (outcome) body.appendChild(scEl("p", { class: "sc-outcome", text: outcome, data: { scOutcome: "1" } }));
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
  const attempt = shot.captured ? null : scLastAttempt(labId, shot.filename);
  const addRetakes = (guidedFirst) => {
    add("Retake", "shot-retake", { primary: status.key === "outdated", disabled: jobActive || busyUpload, needsIdle: true });
    add("Retake guided", "shot-retake-guided", { primary: guidedFirst, disabled: jobActive || busyUpload, needsIdle: true });
  };
  if (status.key === "needs-review") {
    add("Accept", "shot-accept", { primary: true, disabled: busyUpload });
    addRetakes(false);
    add("Discard", "shot-discard", { disabled: busyUpload });
  } else if (["captured", "outdated", "failed", "needs-you", "paused"].includes(status.key) || (status.key === "pending" && attempt?.status === "skipped")) {
    addRetakes(status.key === "needs-you");
    // "Show me once" is only offered where the computer tried and could not finish: the person does it once and the computer learns it.
    if (attempt && SC_AUTOMATION_CAUSES.includes(attempt.cause) && (status.key === "needs-you" || status.key === "failed")) {
      add("Show me once", "shot-record", { primary: true, disabled: jobActive || busyUpload, needsIdle: true });
      const shareId = `sc-share-${idPrefix}-${shot.filename}`;
      const share = scEl("input", { id: shareId, attrs: { type: "checkbox", autocomplete: "off", "aria-describedby": `${shareId}-help` }, data: { scField: "share-recipe" } });
      share.checked = Boolean(lab.ui.shareRecipe);
      buttons.push(
        scEl("label", { class: "sc-check sc-share", attrs: { for: shareId } }, [
          share,
          scEl("span", { text: "Share this recipe with every lab (anonymous: it holds control names only)" }),
          scEl("span", { id: `${shareId}-help`, class: "sr-only", text: "The recipe is checked for anything that could identify you or your tenant before it is shared." }),
        ]),
      );
    }
  } else if (status.key === "pending" || status.key === "queued") {
    add("Capture this one", "shot-capture", { disabled: jobActive || busyUpload, needsIdle: true });
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
    } else if (field === "background") {
      lab.ui.background = Boolean(target.checked);
    } else if (field === "mode") {
      if (target.checked) {
        lab.ui.mode = scCaptureModeOf(target.dataset.scMode);
        scRerender(labId);
      }
    } else if (field === "consent-practice") {
      lab.ui.consentDraft.practice = Boolean(target.checked);
      if (target.checked) lab.ui.consentDraft.scratch = false;
      scRerender(labId);
    } else if (field === "consent-scratch") {
      lab.ui.consentDraft.scratch = Boolean(target.checked);
      if (target.checked) lab.ui.consentDraft.practice = false;
      scRerender(labId);
    } else if (field === "consent-agree") {
      lab.ui.consentDraft.agreed = Boolean(target.checked);
    } else if (field === "share-recipe") {
      lab.ui.shareRecipe = Boolean(target.checked);
    } else if (field === "also-profile") {
      if (target.checked) lab.ui.alsoProfile.add(target.dataset.scScope);
      else lab.ui.alsoProfile.delete(target.dataset.scScope);
    }
  });

  section.addEventListener("input", (event) => {
    const fieldId = event.target?.dataset?.scTargetField;
    if (fieldId) lab.ui.targetDraft[fieldId] = event.target.value;
    if (event.target?.dataset?.scField === "consent-url") lab.ui.consentDraft.url = event.target.value;
  });

  // Enter in an address box saves that block, like a form would.
  section.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || !event.target?.dataset?.scTargetField) return;
    const save = event.target.closest("[data-sc-scope]")?.querySelector('[data-sc-action="targets-save"]');
    if (!save) return;
    event.preventDefault?.();
    save.click();
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
  section.querySelector("[data-sc-settings]")?.addEventListener("toggle", (event) => {
    lab.ui.settingsOpen = Boolean(event.target.open);
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
    case "step-fix-addresses":
      scFocusNeeds(labId);
      return;
    case "targets-save":
      await scSaveTargetsFrom(labId, control);
      return;
    case "targets-open-settings":
      scOpenSettings(labId);
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
      await scCopyWithAck("pair-copy-code", scState.pairing?.code || "");
      return;
    case "pair-copy-command":
      await scCopyWithAck("pair-copy-command", scPairingCommandText());
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
    case "banner-resume":
      await scResumeCapture(labId, String(control.dataset.filenames || "").split(",").filter(Boolean));
      return;
    case "cause-fix":
      await scApplyCauseFix(labId, control.dataset.cause);
      return;
    case "cause-toggle":
      if (lab.ui.causesOpen.has(control.dataset.cause)) lab.ui.causesOpen.delete(control.dataset.cause);
      else lab.ui.causesOpen.add(control.dataset.cause);
      scRerender(labId);
      return;
    case "banner-dismiss":
      lab.outcome = null;
      scRerender(labId);
      return;
    case "job-cancel":
      await scCancelJob(control.dataset.jobKey || labId);
      return;
    case "job-pause":
      await scCancelJob(control.dataset.jobKey || labId, { pause: true });
      return;
    case "account-setup":
      await scRequestAccountSetup(labId);
      return;
    case "consent-open":
      lab.ui.consentOpen = true;
      lab.ui.queueAfterConsent = false;
      lab.ui.consentDraft.touched = false;
      lab.ui.consentDraft.error = "";
      scRerender(labId);
      scFocusConsent(labId);
      return;
    case "consent-close":
      lab.ui.consentOpen = false;
      lab.ui.queueAfterConsent = false;
      scRerender(labId);
      scFocusByKey(scHostFor(labId), "consent-open");
      return;
    case "consent-save":
      await scSaveConsent(labId);
      return;
    case "consent-revoke":
      await scRevokeConsent(labId);
      return;
    case "agent-scratch":
      await scChooseAgent(labId, "scratch");
      return;
    case "agent-existing":
      await scChooseAgent(labId, "existing");
      return;
    case "agent-start-fresh":
      lab.ui.startFresh = !lab.ui.startFresh;
      scAnnounce(lab.ui.startFresh ? "The next capture builds a new practice agent. The earlier one stays in your tenant." : "The next capture reuses the practice agent.");
      scRerender(labId);
      return;
    case "shot-record":
      scCloseLightboxFor(labId, control);
      await scRetakeShot(labId, filename, { mode: "guided", record: { share: lab.ui.shareRecipe } });
      return;
    case "copy-cli":
      await scCopyWithAck("copy-cli", control.dataset.command || "");
      return;
    case "preview":
      scOpenLightbox(labId, filename);
      return;
    case "shot-capture":
      scCloseLightboxFor(labId, control);
      await scCaptureOne(labId, filename);
      return;
    case "shot-retake":
      scCloseLightboxFor(labId, control);
      await scRetakeShot(labId, filename);
      return;
    case "shot-retake-guided":
      scCloseLightboxFor(labId, control);
      await scRetakeShot(labId, filename, { mode: "guided" });
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
  if (!(await scEnsureConnected(labId))) return;
  if (scope === "selected" && !lab.ui.picks.size) {
    lab.outcome = { type: "job", variant: "warn", message: "Tick at least one screenshot below, then try again.", jobId: null, actions: [] };
    scAnnounce(lab.outcome.message);
    scRerender(labId);
    return;
  }
  await scQueueCapture(labId, { scope, filenames: [...lab.ui.picks] });
}

/** Close the preview dialog when the control that was pressed sits inside it, so the progress behind it can be seen. */
function scCloseLightboxFor(labId, control) {
  if (control?.closest?.("dialog")) scCloseLightbox(labId);
}

/** Save the settings a block or the settings panel asked for. Only what was typed is sent: an untouched box keeps its value. */
async function scSaveTargetsFrom(labId, control) {
  const lab = scLab(labId);
  const ui = lab.ui;
  const scope = control.dataset.scope || "settings";
  const fieldIds = String(control.dataset.fields || "").split(",").filter(Boolean);
  const alsoProfile = control.dataset.profile === "1" || ui.alsoProfile.has(scope);
  const current = new Map(scTargetFields(lab.targets?.data).map((field) => [field.id, field.value]));
  const targets = {};
  for (const id of fieldIds) {
    if (ui.targetDraft[id] === undefined) continue;
    const value = ui.targetDraft[id].trim();
    // A prompt only adds values; the settings panel can also clear one by saving it empty.
    if (scope === "settings" ? value !== (current.get(id) || "") : value) targets[id] = value;
  }
  if (!Object.keys(targets).length) {
    ui.targetErrors = {};
    ui.targetFormError = { scope, message: scope === "settings" ? "Nothing has changed yet." : "Type or paste a value first." };
    scAnnounce(ui.targetFormError.message);
    scRerender(labId);
    scFocusByKey(scHostFor(labId), scope === "settings" ? "targets-save:settings" : `target:${scope}:${fieldIds[0]}`);
    return;
  }
  const { ok } = await scSaveTargets(labId, targets, { alsoProfile, scope });
  const host = scHostFor(labId);
  if (!host) return;
  if (!ok) {
    const invalid = host.querySelector('[data-sc-target-field][aria-invalid="true"]');
    (invalid || host.querySelector(`[data-sc-form-error="${scope}"]`))?.focus?.({ preventScroll: true });
    return;
  }
  if (scope !== "settings") {
    const next = host.querySelector("[data-sc-needs] input");
    if (next) next.focus?.({ preventScroll: true });
    else scFocusByKey(host, "primary");
  }
}

/** The one fix for a group of screenshots that were not captured. */
async function scApplyCauseFix(labId, code) {
  const lab = scLab(labId);
  const cause = (lab.outcome?.causes || []).find((c) => c.code === code);
  if (!cause) return;
  switch (cause.fixAction) {
    case "settings":
      if (scHostFor(labId)?.querySelector("[data-sc-needs]")) scFocusNeeds(labId);
      else scOpenSettings(labId);
      return;
    case "retry":
      await scRetakeShots(labId, cause.filenames);
      return;
    case "guided":
      await scRetakeShots(labId, cause.filenames, { mode: "guided" });
      return;
    case "record":
      // One Show me once at a time: the person does the first screen by hand and the computer learns it.
      await scRetakeShots(labId, cause.filenames.slice(0, 1), { mode: "guided", record: { share: lab.ui.shareRecipe } });
      return;
    case "consent":
      lab.ui.consentOpen = true;
      lab.ui.consentDraft.touched = false;
      scRerender(labId);
      scFocusConsent(labId);
      return;
    case "account":
      await scRequestAccountSetup(labId);
      return;
    case "upload": {
      const upload = scHostFor(labId)?.querySelector(`.sc-card[data-filename="${cause.filenames[0]}"] [data-sc-action="shot-upload"]`);
      upload?.scrollIntoView?.({ behavior: "smooth", block: "center" });
      upload?.focus?.({ preventScroll: true });
      return;
    }
    default:
  }
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

/** What the lab says to show for a shot, as a numbered list (or its navigation hint), or null. */
function scLbInstructions(shot) {
  if (Array.isArray(shot.instructions) && shot.instructions.length) {
    const ol = scEl("ol", { class: "sc-lb-list" });
    for (const line of shot.instructions) ol.appendChild(scEl("li", { text: scPlainInstruction(line) }));
    return ol;
  }
  return shot.navHint ? scEl("p", { text: String(shot.navHint) }) : null;
}

/** A picture waiting for review, side by side with what the lab asks for, and why they differ when the screen was wrong. */
function scBuildReviewCompare(shot, label, url) {
  const wrap = scEl("div", { class: "sc-review", data: { scReview: "1" } });
  const mismatch = scLandingSentence(shot.verification);
  if (mismatch) wrap.appendChild(scEl("p", { class: "sc-review-mismatch", text: mismatch }));
  const grid = scEl("div", { class: "sc-review-grid" });

  const captured = scEl("section", { class: "sc-review-col", attrs: { "aria-labelledby": "sc-review-captured" } });
  captured.appendChild(scEl("h6", { id: "sc-review-captured", text: "What we captured" }));
  captured.appendChild(scEl("img", { class: "sc-lb-img", attrs: { src: url, alt: String(shot.alt || shot.caption || label) } }));
  grid.appendChild(captured);

  const asks = scEl("section", { class: "sc-review-col", attrs: { "aria-labelledby": "sc-review-asks" } });
  asks.appendChild(scEl("h6", { id: "sc-review-asks", text: "What the lab asks for" }));
  if (shot.caption) asks.appendChild(scEl("p", { class: "sc-review-caption", text: String(shot.caption) }));
  const instructions = scLbInstructions(shot);
  if (instructions) asks.appendChild(instructions);
  const expected = scText(shot.verification?.landing?.expected, 120) || scShotCapture(shot)?.screenLabel;
  if (expected) asks.appendChild(scEl("p", { class: "sc-review-expected", text: `Expected screen: ${expected}.` }));
  grid.appendChild(asks);

  wrap.appendChild(grid);
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
  const comparing = status.key === "needs-review" && Boolean(url);
  if (comparing) {
    figure.appendChild(scBuildReviewCompare(shot, label, url));
  } else {
    if (url) figure.appendChild(scEl("img", { class: "sc-lb-img", attrs: { src: url, alt: String(shot.alt || shot.caption || label) } }));
    else figure.appendChild(scEl("div", { class: "sc-lb-empty", text: "Pending. This screenshot has not been captured yet." }));
    figure.appendChild(scEl("figcaption", { class: "sc-lb-caption", text: String(shot.caption || "") }));
  }

  const info = dialog.querySelector("[data-sc-lb-info]");
  info.replaceChildren();
  const position = shots.findIndex((s) => s.filename === filename) + 1;
  const meta = scEl("p", { class: "sc-lb-meta" });
  meta.appendChild(scStatusChip(status));
  meta.appendChild(scEl("span", { text: ` Screenshot ${position} of ${shots.length}` }));
  info.appendChild(meta);

  // A screenshot being reviewed already shows what the lab asks for next to the picture.
  const instructions = comparing ? null : scLbInstructions(shot);
  if (instructions) info.appendChild(scLbSection("What to show", instructions));
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
