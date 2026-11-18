// Screenshot Center: everything that talks to the portal. Capture status, pairing a
// computer, capture jobs (live events with a polling fallback), uploads, pastes,
// retakes, Microsoft Learn re-checks, and the shared library.
// Rendering lives in screenshot-center.js; pure decisions live in screenshot-center-core.js.

const SC_STATUS_TTL_MS = 8000;
const SC_POLL_MS = 2000;
const SC_PAIR_POLL_SECONDS = 3;

const scState = {
  status: null,
  statusError: "",
  statusAt: 0,
  statusPromise: null,
  labs: {},
  pairing: null,
  copyAck: null,
  library: { loaded: false, loading: false, error: "", summary: null, shots: [] },
};

function scLab(key) {
  if (!scState.labs[key]) {
    scState.labs[key] = {
      state: null,
      outcome: null,
      job: null,
      lastJob: null,
      phase: "",
      lastDone: -1,
      lastAnnounceAt: 0,
      selected: null,
      lightbox: null,
      feedback: {},
      uploading: {},
      brand: null,
      targets: null,
      needsAddress: null,
      busy: "",
      resumeAt: 0,
      eventSource: null,
      pollTimer: null,
      tickTimer: null,
      finishing: false,
      ui: {
        advancedOpen: false,
        scope: "missing",
        callouts: "sidecar",
        redact: true,
        tenantSource: "lab",
        onlyAttention: false,
        picks: new Set(),
        mode: SC_DEFAULT_CAPTURE_MODE,
        consentOpen: false,
        consentDraft: { practice: false, url: "", agreed: false, error: "" },
        shareRecipe: false,
        background: false,
        causesOpen: new Set(),
        targetDraft: {},
        targetErrors: {},
        targetFormError: null,
        alsoProfile: new Set(),
      },
    };
  }
  return scState.labs[key];
}

async function scFetchJson(url, init) {
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  return { ok: Boolean(res.ok), status: res.status, data: data && typeof data === "object" ? data : {} };
}

function scJsonInit(method, body) {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) };
}

function scAnnounce(message) {
  const el = document.getElementById("lb-screenshots-live") || document.getElementById("app-live");
  if (!el || !message) return;
  const flip = el.dataset.flip === "1";
  el.dataset.flip = flip ? "0" : "1";
  el.textContent = flip ? String(message) : `${message}\u00a0`;
}

// ── Capture status ──────────────────────────────────────────────────────────

async function scLoadStatus(force = false) {
  if (!force && scState.status && Date.now() - scState.statusAt < SC_STATUS_TTL_MS) return scState.status;
  if (scState.statusPromise) return scState.statusPromise;
  scState.statusPromise = (async () => {
    try {
      const { ok, status, data } = await scFetchJson("/api/capture/status");
      if (!ok) throw new Error(data.error || `Request failed (${status})`);
      scState.status = data;
      scState.statusError = "";
      scState.statusAt = Date.now();
    } catch (err) {
      scState.statusError = err.message || "Could not load the capture status.";
    } finally {
      scState.statusPromise = null;
    }
    return scState.status;
  })();
  return scState.statusPromise;
}

function scIsConnected() {
  return Boolean(scState.status?.companion?.connected);
}

function scLimits() {
  const limits = scState.status?.limits;
  return {
    maxUploadBytes: Number(limits?.maxUploadBytes) > 0 ? Number(limits.maxUploadBytes) : SC_DEFAULT_LIMITS.maxUploadBytes,
    acceptedTypes: Array.isArray(limits?.acceptedTypes) && limits.acceptedTypes.length ? limits.acceptedTypes : [...SC_DEFAULT_LIMITS.acceptedTypes],
  };
}

/** Re-render everything that depends on whether a computer is connected. */
function scNotifyStatusChanged() {
  if (typeof scRerenderOpenCenter === "function") scRerenderOpenCenter();
  if (typeof scSyncCaptureOnBuild === "function") scSyncCaptureOnBuild({ fetch: false });
  if (typeof rhOnStatusChanged === "function") rhOnStatusChanged();
}

// ── Pairing a computer ──────────────────────────────────────────────────────

function scStopPairingTimer() {
  const p = scState.pairing;
  if (p?.timer) {
    clearInterval(p.timer);
    p.timer = null;
  }
}

function scClosePairing() {
  scStopPairingTimer();
  scState.pairing = null;
  if (typeof scClearCopyAck === "function") scClearCopyAck();
  if (typeof scRefreshPairingUi === "function") scRefreshPairingUi();
}

async function scStartPairing(context = {}) {
  scStopPairingTimer();
  if (typeof scClearCopyAck === "function") scClearCopyAck();
  const p = {
    status: "issuing",
    code: "",
    expiresAt: "",
    command: "",
    portalUrl: "",
    baselineIds: new Set(),
    deviceName: "",
    error: "",
    tick: 0,
    polling: false,
    timer: null,
    context,
  };
  scState.pairing = p;
  scRefreshPairingUi();
  try {
    const status = await scLoadStatus(true);
    p.baselineIds = new Set((status?.companion?.devices || []).map((d) => d.id));
    const { ok, status: code, data } = await scFetchJson("/api/capture/pair", scJsonInit("POST", {}));
    if (scState.pairing !== p) return;
    if (!ok) throw new Error(data.error || `Request failed (${code})`);
    p.code = String(data.code || "");
    p.expiresAt = String(data.expiresAt || "");
    p.command = String(data.command || "");
    p.portalUrl = String(data.portalUrl || "");
    p.status = "waiting";
    scAnnounce("Your pairing code is ready. Enter it in the companion on your computer.");
    p.timer = setInterval(scPairingTick, 1000);
    p.timer?.unref?.();
  } catch (err) {
    if (scState.pairing !== p) return;
    p.status = "error";
    p.error = err.message || "Could not get a pairing code.";
    scAnnounce(`Could not get a pairing code. ${p.error}`);
  }
  scRefreshPairingUi();
  if (typeof scFocusPairing === "function") scFocusPairing();
}

function scPairingTick() {
  const p = scState.pairing;
  if (!p || p.status !== "waiting") return;
  if (!document.querySelector("[data-sc-pairing-host]")) {
    scClosePairing();
    return;
  }
  p.tick += 1;
  const left = scCountdown(p.expiresAt);
  for (const el of document.querySelectorAll("[data-sc-pair-timer]")) el.textContent = left.expired ? "This code expired." : `Code expires in ${left.text}`;
  if (left.expired) {
    p.status = "expired";
    scStopPairingTimer();
    scAnnounce("That pairing code expired. Get a new code.");
    scRefreshPairingUi();
    return;
  }
  if (p.tick % SC_PAIR_POLL_SECONDS === 0) void scPollForPairing();
}

async function scPollForPairing() {
  const p = scState.pairing;
  if (!p || p.polling || p.status !== "waiting") return;
  p.polling = true;
  try {
    const status = await scLoadStatus(true);
    const fresh = (status?.companion?.devices || []).find((d) => !p.baselineIds.has(d.id));
    if (fresh && scState.pairing === p) scPairingSucceeded(fresh);
  } finally {
    p.polling = false;
  }
}

function scPairingSucceeded(device) {
  const p = scState.pairing;
  if (!p) return;
  p.status = "connected";
  p.deviceName = String(device?.name || "your computer");
  scStopPairingTimer();
  scAnnounce(`Connected: ${p.deviceName}. You are ready to capture screenshots.`);
  scRefreshPairingUi();
  scNotifyStatusChanged();
  if (typeof p.context?.onConnected === "function") p.context.onConnected(device);
}

async function scDisconnectDevice(deviceId) {
  const { ok, data, status } = await scFetchJson(`/api/capture/devices/${encodeURIComponent(deviceId)}`, { method: "DELETE" });
  if (!ok) {
    scAnnounce(data.error || `Could not disconnect that computer (${status}).`);
    return false;
  }
  await scLoadStatus(true);
  scAnnounce("Computer disconnected.");
  scNotifyStatusChanged();
  return true;
}

// ── Capture jobs: live events with a polling fallback ───────────────────────

function scParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function scStopTracking(key) {
  const lab = scLab(key);
  if (lab.eventSource) {
    try {
      lab.eventSource.close();
    } catch {
      /* already closed */
    }
    lab.eventSource = null;
  }
  clearTimeout(lab.pollTimer);
  clearInterval(lab.tickTimer);
  lab.pollTimer = null;
  lab.tickTimer = null;
}

function scTrackJob(key, job, { announce = true, note = "" } = {}) {
  const lab = scLab(key);
  scStopTracking(key);
  lab.job = job;
  lab.phase = "";
  lab.lastDone = -1;
  lab.finishing = false;
  scSubscribeJob(key, job.id);
  lab.tickTimer = setInterval(() => scUpdateProgress(key), 1000);
  lab.tickTimer?.unref?.();
  scApplyJob(key, job, { full: true, silent: !announce });
  scRerender(key);
  if (announce) scAnnounce(`Capture started for ${scPlural(scCount(job.progress?.total ?? job.shots?.length), "screenshot")}.${note ? ` ${note}` : ""}`);
}

function scSubscribeJob(key, jobId) {
  const lab = scLab(key);
  if (typeof EventSource === "function") {
    let source = null;
    try {
      source = new EventSource(`/api/capture/jobs/${encodeURIComponent(jobId)}/events`);
    } catch {
      source = null;
    }
    if (source) {
      lab.eventSource = source;
      source.addEventListener("snapshot", (event) => {
        const data = scParse(event.data);
        if (data?.job) scApplyJob(key, data.job, { full: true });
      });
      source.addEventListener("update", (event) => {
        const data = scParse(event.data);
        if (data?.job) scApplyJob(key, scMergeJobUpdate(lab.job, data), { full: false });
      });
      source.addEventListener("end", () => {
        source.close();
        if (lab.eventSource === source) lab.eventSource = null;
        void scPollJobOnce(key, jobId);
      });
      source.onerror = () => {
        if (lab.eventSource !== source) return;
        source.close();
        lab.eventSource = null;
        scStartPolling(key, jobId);
      };
      return;
    }
  }
  scStartPolling(key, jobId);
}

function scStartPolling(key, jobId) {
  const lab = scLab(key);
  clearTimeout(lab.pollTimer);
  const loop = async () => {
    if (lab.job?.id !== jobId) return;
    await scPollJobOnce(key, jobId);
    if (lab.job?.id === jobId && !scIsFinishedJob(lab.job)) {
      lab.pollTimer = setTimeout(loop, SC_POLL_MS);
      lab.pollTimer?.unref?.();
    }
  };
  void loop();
}

async function scPollJobOnce(key, jobId) {
  try {
    const { ok, status, data } = await scFetchJson(`/api/capture/jobs/${encodeURIComponent(jobId)}`);
    if (!ok) {
      if (status === 404) scJobGone(key);
      return;
    }
    if (data.job) scApplyJob(key, data.job, { full: true });
  } catch {
    /* a missed poll is retried by the next one */
  }
}

function scJobGone(key) {
  const lab = scLab(key);
  scStopTracking(key);
  lab.job = null;
  lab.outcome = { type: "job", variant: "warn", message: "This capture is no longer available. If screenshots are still missing, start a new capture.", jobId: null, actions: [] };
  scAnnounce(lab.outcome.message);
  scRerender(key);
}

function scApplyJob(key, job, { full = true, silent = false } = {}) {
  const lab = scLab(key);
  if (!job || typeof job !== "object") return;
  // A job that already finished is settled; late events about it must not bring its card back.
  if (lab.lastJob?.id === job.id && lab.job?.id !== job.id) return;
  if (scIsFinishedJob(job) && !full) {
    lab.job = job;
    void scPollJobOnce(key, job.id);
    return;
  }
  lab.job = job;
  if (scIsFinishedJob(job)) {
    void scFinishJob(key, job);
    return;
  }
  const view = scDescribeJob(job, {
    companionConnected: scState.status?.companion ? Boolean(scState.status.companion.connected) : null,
    nowMs: Date.now(),
    onlineWindowSec: Number(scState.status?.companion?.onlineWindowSec) || 90,
  });
  const phaseChanged = view.phase !== lab.phase;
  const progressed = view.counts.done !== lab.lastDone;
  if (!silent && phaseChanged && lab.phase) scAnnounce(`${view.headline}. ${view.detail}`);
  else if (!silent && progressed && lab.lastDone >= 0 && Date.now() - lab.lastAnnounceAt > 4000) {
    scAnnounce(`${view.counts.done} of ${view.counts.total} screenshots done.`);
    lab.lastAnnounceAt = Date.now();
  }
  lab.phase = view.phase;
  lab.lastDone = view.counts.done;
  scUpdateProgress(key);
  if (typeof scApplyJobToCards === "function") scApplyJobToCards(key);
}

async function scFinishJob(key, job) {
  const lab = scLab(key);
  if (lab.finishing) return;
  lab.finishing = true;
  scStopTracking(key);
  lab.lastJob = job;
  lab.job = null;
  lab.phase = "";
  lab.outcome = scOutcomeFromJob(job);
  scAnnounce(lab.outcome.message);
  try {
    if (key === "library") {
      await Promise.all([scLoadLibrary(true), scLoadStatus(true)]);
      scRerender(key);
    } else {
      scRerender(key);
      await scRefreshLab(key);
    }
  } finally {
    lab.finishing = false;
  }
}

async function scCancelJob(key, { pause = false } = {}) {
  const lab = scLab(key);
  const job = lab.job;
  if (!job) return;
  const { ok, status, data } = await scFetchJson(`/api/capture/jobs/${encodeURIComponent(job.id)}/cancel`, scJsonInit("POST", pause ? { pause: true } : {}));
  if (ok && data.job) {
    scAnnounce(data.job.status === "cancelled" ? "Capture canceled." : pause ? "Pause requested. Your computer stops after the screenshot it is working on, and the rest wait for Resume." : "Cancel requested. Your computer stops after the screenshot it is working on.");
    scApplyJob(key, { ...lab.job, ...data.job, shots: data.job.shots || lab.job.shots }, { full: true });
  } else if (status === 409) {
    await scPollJobOnce(key, job.id);
  } else {
    scAnnounce(data.error || `Could not cancel (${status}).`);
  }
}

// ── Automatic capture: what the person allowed ──────────────────────────────

/** Save the consent card: the one-time yes, and (only if they ticked it) the practice environment. */
async function scSaveConsent(labId) {
  const lab = scLab(labId);
  const draft = lab.ui.consentDraft;
  if (!draft.agreed) {
    draft.error = "Tick the box to confirm you understand what the computer may and may not do.";
    scRerender(labId);
    return false;
  }
  if (draft.practice && !String(draft.url || "").trim()) {
    draft.error = "Add the address of the practice environment, or untick the practice agent option.";
    scRerender(labId);
    return false;
  }
  draft.error = "";
  const body = { consented: true, level: draft.practice ? "practice" : "read-only", practiceEnvironmentUrl: draft.practice ? String(draft.url).trim() : "" };
  const { ok, data } = await scFetchJson("/api/capture/consent", scJsonInit("PUT", body));
  if (!ok) {
    draft.error = String(data.error || "The choice could not be saved.");
    scRerender(labId);
    return false;
  }
  await scLoadStatus(true);
  lab.ui.consentOpen = false;
  draft.agreed = false;
  scAnnounce(draft.practice ? "Automatic capture is on. It may also create one practice agent." : "Automatic capture is on. It never creates anything.");
  scRerender(labId);
  return true;
}

/** Turn automatic capture off. The computer asks again before the next automatic capture. */
async function scRevokeConsent(labId) {
  const { ok } = await scFetchJson("/api/capture/consent", { method: "DELETE" });
  if (ok) {
    await scLoadStatus(true);
    scAnnounce("Automatic capture is off.");
    scRerender(labId);
  }
  return ok;
}

async function scTrackJobById(key, jobId) {
  if (!SC_JOB_ID.test(String(jobId || ""))) return false;
  if (scLab(key).job?.id === jobId) return true;
  const { ok, data } = await scFetchJson(`/api/capture/jobs/${encodeURIComponent(jobId)}`);
  if (!ok || !data.job) return false;
  if (scIsActiveJob(data.job)) scTrackJob(key, data.job, { announce: false });
  return scIsActiveJob(data.job);
}

/** A capture queued during the build: show its live progress right away. */
async function scAttachBuildJob(labId, jobId) {
  await scTrackJobById(labId, jobId);
  if (typeof scFocusProgress === "function") scFocusProgress(labId);
}

/** Pick up a capture that is already running for this lab (after a reload, or one queued by a build). */
async function scResumeJobs(labId) {
  const lab = scLab(labId);
  if (lab.job || Date.now() - lab.resumeAt < 15000) return;
  lab.resumeAt = Date.now();
  try {
    const pending = lab.outcome?.jobId;
    if (pending && (await scTrackJobById(labId, pending))) return;
    const { ok, data } = await scFetchJson(`/api/capture/jobs?labId=${encodeURIComponent(labId)}&limit=5`);
    if (!ok) return;
    const active = (Array.isArray(data.jobs) ? data.jobs : []).find((j) => scIsActiveJob(j));
    if (active) await scTrackJobById(labId, active.id);
  } catch {
    /* resuming is a convenience, never an error */
  }
}

// ── Queue a capture ─────────────────────────────────────────────────────────

function scTenantFields(labId) {
  const source = scLab(labId).ui.tenantSource || "lab";
  if (source === "none") return { useLabCustomization: false };
  if (source.startsWith("profile:")) return { brandProfileId: source.slice("profile:".length) };
  return {};
}

function scScopeBody(scope, filenames) {
  if (scope === "selected") return { mode: "selected", filenames };
  return { mode: scope === "stale" || scope === "all" ? scope : "missing" };
}

/**
 * Queue a capture for one lab. Returns true when a job is now being tracked.
 * @param {string} labId
 * @param {{ scope?: string, filenames?: string[], mode?: string }} request `mode` defaults to the lab's choice
 */
async function scQueueCapture(labId, { scope = "missing", filenames = [], mode, record = null } = {}) {
  const lab = scLab(labId);
  lab.outcome = null;
  lab.busy = "queue";
  scRerender(labId);
  let needsAddress = false;
  try {
    const body = {
      target: { type: "lab", labId },
      scope: scScopeBody(scope, filenames),
      options: { callouts: lab.ui.callouts, redact: lab.ui.redact, ...scModeRequest(mode ?? lab.ui.mode), ...(lab.ui.background === true ? { background: true } : {}), ...(record ? { record: { share: record.share === true } } : {}) },
      ...scTenantFields(labId),
    };
    const { ok, status, data } = await scFetchJson("/api/capture/jobs", scJsonInit("POST", body));
    if (!ok) {
      lab.outcome = { type: "job", variant: "error", message: `Could not start the capture. ${data.error || `Request failed (${status}).`}`, jobId: null, actions: [] };
    } else if (data.needsConsent) {
      // Nothing was queued: the person has not allowed automatic capture yet, so show the card that asks.
      lab.ui.consentOpen = true;
      lab.outcome = { type: "job", variant: "warn", message: String(data.message || "Allow automatic capture first."), jobId: null, actions: [] };
      await scLoadStatus(true);
      scAnnounce(lab.outcome.message);
      lab.busy = "";
      scRerender(labId);
      if (typeof scFocusConsent === "function") scFocusConsent(labId);
      return false;
    } else if (data.needsAddress) {
      // Nothing was queued: every selected screenshot waits for an address, so ask for it here.
      needsAddress = true;
      lab.needsAddress = Array.isArray(data.missing) ? data.missing : [];
      lab.outcome = { type: "job", variant: "warn", message: String(data.message || "These screenshots need an address before they can be captured."), jobId: null, actions: [] };
      void scLoadTargets(labId, { force: true });
    } else if (data.nothingToCapture) {
      lab.outcome = { type: "job", variant: "ok", message: "Nothing to capture. Every selected screenshot already exists.", jobId: null, actions: [] };
    } else if (data.job) {
      lab.busy = "";
      const held = scMissingRequirements(null, data.missing);
      lab.needsAddress = held.length ? data.missing : null;
      if (held.length) void scLoadTargets(labId, { force: true });
      const waiting = held.reduce((sum, view) => sum + view.count, 0);
      if (data.existing) scAnnounce("This capture is already running. Showing its progress.");
      if (data.downgraded?.message) scAnnounce(scText(data.downgraded.message, 300));
      scTrackJob(labId, data.job, { announce: !data.existing, note: [waiting ? `${scPlural(waiting, "screenshot")} ${waiting === 1 ? "is" : "are"} waiting for an address.` : "", data.downgraded?.message ? scText(data.downgraded.message, 300) : ""].filter(Boolean).join(" ") });
      if (typeof scFocusProgress === "function") scFocusProgress(labId);
      return true;
    }
  } catch (err) {
    lab.outcome = { type: "job", variant: "error", message: `Could not start the capture. ${err.message}`, jobId: null, actions: [] };
  }
  lab.busy = "";
  scAnnounce(lab.outcome?.message || "");
  scRerender(labId);
  if (needsAddress && typeof scFocusNeeds === "function") scFocusNeeds(labId);
  return false;
}

// ── Upload, paste, accept, discard, retake ──────────────────────────────────

function scSetFeedback(labId, filename, feedback) {
  const lab = scLab(labId);
  if (feedback) lab.feedback[filename] = feedback;
  else delete lab.feedback[filename];
  if (typeof scRefreshCard === "function") scRefreshCard(labId, filename);
}

function scFeedbackFromVerification(headline, verification, variant) {
  const summary = scVerificationSummary(verification, scLimits());
  return { variant, headline: headline || summary.headline, items: summary.items };
}

/** Send one image (a file, a drop, or a clipboard paste) to a screenshot slot. */
async function scUploadImage(labId, filename, file) {
  const lab = scLab(labId);
  const check = scValidateImageFile(file, scLimits());
  if (!check.ok) {
    scSetFeedback(labId, filename, { variant: "bad", headline: "This file cannot be used.", items: [{ level: "fail", text: check.message }] });
    scAnnounce(`This file cannot be used. ${check.message}`);
    return false;
  }
  let objectUrl = "";
  try {
    objectUrl = typeof URL !== "undefined" && typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : "";
  } catch {
    objectUrl = "";
  }
  lab.uploading[filename] = { objectUrl };
  scSetFeedback(labId, filename, null);
  scAnnounce("Uploading and checking your image.");
  try {
    const { ok, status, data } = await scFetchJson(scScreenshotApi(labId, filename), { method: "PUT", headers: { "Content-Type": file.type }, body: file });
    if (status === 200 && data.outcome === "accepted") {
      scSetFeedback(labId, filename, { variant: "ok", headline: "Added to your lab.", items: scVerificationSummary(data.verification, scLimits()).items.filter((i) => i.level !== "pass") });
      scAnnounce("Image added to your lab. The lab files are updated.");
      if (data.state) await scApplyNewState(labId, data.state);
      else await scRefreshLab(labId);
      return true;
    }
    if (status === 202 || data.outcome === "needs-review") {
      scSetFeedback(labId, filename, scFeedbackFromVerification("Saved for review. Check it, then accept or retake it.", data.verification, "warn"));
      scAnnounce("Image saved for review. Check it, then accept or retake it.");
      await scRefreshLabState(labId);
      return true;
    }
    if (status === 422 || data.outcome === "rejected") {
      scSetFeedback(labId, filename, scFeedbackFromVerification("This image was not accepted.", data.verification, "bad"));
      scAnnounce("This image was not accepted. Nothing was changed.");
      return false;
    }
    const message = scUploadErrorText(status, data, scLimits());
    scSetFeedback(labId, filename, { variant: "bad", headline: "The upload did not work.", items: [{ level: "fail", text: message }] });
    scAnnounce(message);
    return ok;
  } catch (err) {
    scSetFeedback(labId, filename, { variant: "bad", headline: "The upload did not work.", items: [{ level: "fail", text: `Check your connection and try again. (${err.message})` }] });
    scAnnounce("The upload did not work. Check your connection and try again.");
    return false;
  } finally {
    delete lab.uploading[filename];
    if (objectUrl && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(objectUrl);
    if (typeof scRefreshCard === "function") scRefreshCard(labId, filename);
  }
}

async function scPasteFromClipboard(labId, filename) {
  const hint = "Your browser did not let us read the clipboard. Click this screenshot, then press Ctrl+V.";
  try {
    if (typeof navigator === "undefined" || typeof navigator.clipboard?.read !== "function") throw new Error("unsupported");
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find((t) => /^image\/(png|jpeg|webp)$/.test(t));
      if (!type) continue;
      const blob = await item.getType(type);
      const file = typeof File === "function" ? new File([blob], `pasted.${type.split("/")[1]}`, { type }) : blob;
      return scUploadImage(labId, filename, file);
    }
    scSetFeedback(labId, filename, { variant: "warn", headline: "No image on the clipboard.", items: [{ level: "warn", text: "Copy a screenshot first, then choose Paste image again." }] });
    scAnnounce("No image on the clipboard. Copy a screenshot first.");
  } catch {
    scSetFeedback(labId, filename, { variant: "warn", headline: "Paste with the keyboard instead.", items: [{ level: "warn", text: hint }] });
    scAnnounce(hint);
  }
  return false;
}

async function scAcceptShot(labId, filename) {
  const { ok, data, status } = await scFetchJson(scScreenshotApi(labId, filename, "/accept"), scJsonInit("POST", {}));
  if (ok && data.outcome === "accepted") {
    scSetFeedback(labId, filename, { variant: "ok", headline: "Added to your lab.", items: [] });
    scAnnounce("Screenshot accepted and added to your lab.");
    if (data.state) await scApplyNewState(labId, data.state);
    else await scRefreshLab(labId);
    return true;
  }
  const items = data.verification ? scVerificationSummary(data.verification, scLimits()).items : [{ level: "fail", text: String(data.error || `Could not accept it (${status}).`) }];
  scSetFeedback(labId, filename, { variant: "bad", headline: "This screenshot could not be accepted.", items });
  scAnnounce("This screenshot could not be accepted.");
  return false;
}

/** Discard a staged image, or reset a captured one to "Pending" so it can be retaken. */
async function scResetShot(labId, filename, { announce = "Screenshot removed. It is pending again." } = {}) {
  const { ok, data, status } = await scFetchJson(scScreenshotApi(labId, filename), { method: "DELETE" });
  if (!ok) {
    scSetFeedback(labId, filename, { variant: "bad", headline: "Could not remove it.", items: [{ level: "fail", text: String(data.error || `Request failed (${status}).`) }] });
    return false;
  }
  scSetFeedback(labId, filename, null);
  if (announce) scAnnounce(announce);
  if (data.state) await scApplyNewState(labId, data.state);
  else await scRefreshLab(labId);
  return true;
}

/** Retake screenshots: discard the picture a screenshot has now, then queue a new capture for all of them. `record` is "Show me once". */
async function scRetakeShots(labId, filenames, { mode, record = null } = {}) {
  const lab = scLab(labId);
  const status = await scLoadStatus(true);
  if (!status?.companion?.connected) {
    const many = filenames.length > 1;
    const announce = `Retake needs your computer. Connect it first, or paste or upload ${many ? "new images" : "a new image"} instead.`;
    if (many) {
      lab.outcome = { type: "job", variant: "warn", message: `${announce} Your current images were not changed.`, jobId: null, actions: [] };
      scRerender(labId);
    } else {
      scSetFeedback(labId, filenames[0], {
        variant: "warn",
        headline: "Retake needs your computer.",
        items: [{ level: "warn", text: "Connect your computer first, or paste or upload a new image instead. Your current image was not changed." }],
      });
    }
    scAnnounce(announce);
    scNotifyStatusChanged();
    return false;
  }
  // Only a screenshot that has a picture (accepted or waiting for review) has something to discard.
  const replace = filenames.filter((name) => (lab.state?.shots || []).some((s) => s.filename === name && (s.captured || s.needsReview)));
  for (const name of replace) {
    if (!(await scResetShot(labId, name, { announce: "" }))) return false;
  }
  return scQueueCapture(labId, { scope: "selected", filenames, mode, record });
}

function scRetakeShot(labId, filename, options) {
  return scRetakeShots(labId, [filename], options);
}

/** Make sure a computer is connected before capture; when none is, say so and open the pairing card. */
async function scEnsureConnected(labId) {
  const status = await scLoadStatus(true);
  if (status?.companion?.connected) return true;
  const lab = scLab(labId);
  lab.outcome = { type: "job", variant: "warn", message: "Connect your computer first. Capture runs on your computer.", jobId: null, actions: [] };
  scAnnounce(lab.outcome.message);
  scNotifyStatusChanged();
  await scStartPairing({ source: "lab" });
  return false;
}

/** Continue a paused capture: queue the screenshots that were waiting. */
async function scResumeCapture(labId, filenames) {
  if (!filenames.length || !(await scEnsureConnected(labId))) return false;
  return scQueueCapture(labId, { scope: "selected", filenames });
}

// ── Keeping the lab in sync ─────────────────────────────────────────────────

async function scApplyNewState(labId, state) {
  scLab(labId).state = state;
  if (typeof lbSyncSingleLabDriftFromState === "function") lbSyncSingleLabDriftFromState(labId, state);
  scRerender(labId);
  if (typeof lbChecklistRefresh === "function") lbChecklistRefresh(labId);
  if (typeof lbLoadResultPreview === "function" && typeof lbGen !== "undefined" && lbGen?.opened === labId) await lbLoadResultPreview(labId);
}

async function scRefreshLabState(labId) {
  const { ok, data } = await scFetchJson(`/api/lab-builder/generated/${encodeURIComponent(labId)}/screenshots`);
  if (ok) await scApplyNewState(labId, data);
}

/** Reload the lab preview, the screenshot panel, the saved-lab list, and the checklist. */
async function scRefreshLab(labId) {
  const opened = typeof lbGen !== "undefined" && lbGen?.opened === labId;
  if (opened && typeof lbLoadResultPreview === "function") await lbLoadResultPreview(labId);
  else if (typeof lbRefreshLabScreenshotsPanel === "function") await lbRefreshLabScreenshotsPanel(labId);
  if (typeof lbLoadGenerated === "function") await lbLoadGenerated();
  if (typeof lbChecklistRefresh === "function") lbChecklistRefresh(labId);
}

// ── Check against Microsoft Learn ───────────────────────────────────────────

/** Re-check a lab against live Microsoft Learn, optionally updating its steps. Retaking pictures is a separate, visible step. */
async function scRecheck(labId, { autoUpdate = false } = {}) {
  const lab = scLab(labId);
  if (lab.busy) return;
  lab.busy = "recheck";
  lab.outcome = null;
  scRerender(labId);
  scAnnounce(autoUpdate ? "Checking Microsoft Learn and updating the steps. This can take a minute." : "Checking this lab against Microsoft Learn. This can take a minute.");
  try {
    const { ok, status, data } = await scFetchJson(
      `/api/lab-builder/generated/${encodeURIComponent(labId)}/screenshots/revalidate`,
      scJsonInit("POST", { autoUpdate, updateSteps: autoUpdate, autoCapture: false, onlyStale: true }),
    );
    if (!ok) throw new Error(data.error || `The check failed (${status}).`);
    const changed = scCount(data.counts?.docsUpdated);
    const updated = Array.isArray(data.updatedModuleIds) ? data.updatedModuleIds.length : 0;
    let variant = "ok";
    let message;
    if (autoUpdate) {
      message = updated
        ? `Updated ${scPlural(updated, "topic")} from Microsoft Learn. Retake any outdated screenshots so they match the new steps.`
        : "Checked Microsoft Learn. The steps already match, so nothing changed.";
      if (updated) variant = "warn";
    } else if (changed > 0) {
      variant = "warn";
      message = `${scPlural(changed, "module")} changed on Microsoft Learn since this lab was built. Update the steps, then retake the outdated screenshots.`;
    } else if (data.overallStatus === "ungrounded") {
      message = "No Microsoft Learn pages are recorded for this lab, so there was nothing to compare.";
    } else {
      message = `Checked just now. All ${scPlural(scCount(data.counts?.upToDate), "module")} match live Microsoft Learn documentation.`;
    }
    lab.outcome = {
      type: "recheck",
      variant,
      message,
      jobId: null,
      actions: changed > 0 && !autoUpdate ? [{ id: "recheck-update", label: "Update the steps" }] : [],
    };
    scAnnounce(message);
    lab.busy = "";
    if (data.state) await scApplyNewState(labId, data.state);
    if (autoUpdate && typeof lbLoadGenerated === "function") await lbLoadGenerated();
  } catch (err) {
    lab.outcome = { type: "recheck", variant: "error", message: `The Microsoft Learn check did not finish. ${err.message}`, jobId: null, actions: [] };
    scAnnounce(lab.outcome.message);
  } finally {
    lab.busy = "";
    scRerender(labId);
  }
}

// ── Capture settings: where should we capture? ──────────────────────────────

function scTargetsUrl(labId) {
  return `/api/lab-builder/generated/${encodeURIComponent(labId)}/capture-targets`;
}

/** Load the addresses and names this lab captures with, and what its screenshots still need. A failed reload keeps what was shown. */
async function scLoadTargets(labId, { force = false } = {}) {
  const lab = scLab(labId);
  if (lab.targets?.loading || (lab.targets?.loaded && !force)) return;
  const previous = lab.targets?.data || null;
  lab.targets = { loading: true, loaded: false, loadedAt: 0, data: previous };
  let data = previous;
  try {
    const result = await scFetchJson(scTargetsUrl(labId));
    if (result.ok && Array.isArray(result.data.fields)) {
      data = result.data;
      // What the portal reports now is the truth; the refused request that came first was only a hint.
      lab.needsAddress = null;
    }
  } catch {
    /* the settings stay as they were */
  }
  lab.targets = { loading: false, loaded: true, loadedAt: Date.now(), data };
  scRerender(labId);
}

/**
 * Save addresses and names for this lab (and, with `alsoProfile`, on the active brand profile too).
 * An empty string clears a setting. Returns `{ ok }`; field errors are kept in `lab.ui.targetErrors`,
 * and an error with no field to blame in `lab.ui.targetFormError` for the block named by `scope`.
 */
async function scSaveTargets(labId, targets, { alsoProfile = false, scope = "settings" } = {}) {
  const lab = scLab(labId);
  lab.ui.targetErrors = {};
  lab.ui.targetFormError = null;
  const waitingBefore = scMissingRequirements(lab.targets?.data, lab.needsAddress).reduce((sum, view) => sum + view.count, 0);
  let result;
  try {
    result = await scFetchJson(scTargetsUrl(labId), scJsonInit("PUT", { targets, alsoProfile }));
  } catch (err) {
    result = { ok: false, status: 0, data: { error: `Check your connection and try again. (${err.message})` } };
  }
  const { ok, status, data } = result;
  if (!ok) {
    const errors = data.errors && typeof data.errors === "object" ? data.errors : {};
    for (const [field, message] of Object.entries(errors)) {
      if (SC_TARGET_FIELD_ID.test(field) && scText(message, 300)) lab.ui.targetErrors[field] = scText(message, 300);
    }
    if (!Object.keys(lab.ui.targetErrors).length) {
      lab.ui.targetFormError = { scope, message: scText(data.error, 300) || `Could not save (${status || "no connection"}). Try again.` };
    }
    scAnnounce("Could not save. Check the message next to the field.");
    scRerender(labId);
    return { ok: false };
  }
  for (const id of Object.keys(targets)) delete lab.ui.targetDraft[id];
  lab.needsAddress = null;
  lab.targets = { loading: false, loaded: true, loadedAt: Date.now(), data };
  const waitingAfter = scMissingRequirements(data, null).reduce((sum, view) => sum + view.count, 0);
  const ready = Math.max(0, waitingBefore - waitingAfter);
  scAnnounce(
    waitingAfter
      ? `Saved. ${scPlural(waitingAfter, "screenshot")} still ${waitingAfter === 1 ? "needs" : "need"} an address.`
      : ready
        ? `Saved. ${scPlural(ready, "screenshot")} can be captured now.`
        : "Saved.",
  );
  // The saved addresses change what each screenshot can do, what the strip says, and which names the tenant step lists.
  lab.brand = null;
  await Promise.all([scRefreshLabState(labId), scLoadLabBrand(labId), alsoProfile && typeof bpEnsureLoaded === "function" ? bpEnsureLoaded(true).catch(() => {}) : null]);
  scRerender(labId);
  return { ok: true };
}

// ── Lab branding (tenant addresses) ─────────────────────────────────────────

async function scLoadLabBrand(labId) {
  const lab = scLab(labId);
  if (lab.brand?.loaded || lab.brand?.loading) return;
  lab.brand = { loading: true, loaded: false, customized: false, names: [], profileName: "" };
  try {
    const { ok, data } = await scFetchJson(`/api/lab-builder/generated/${encodeURIComponent(labId)}/customization`);
    lab.brand = {
      loading: false,
      loaded: true,
      loadedAt: Date.now(),
      customized: ok && Boolean(data.customized),
      names: ok && data.customized ? scAddressNames(data.effective || {}) : [],
      profileName: ok ? String(data.profileName || "") : "",
      profileChanged: ok && Boolean(data.profileChangedSinceSnapshot),
      profileId: ok ? String(data.profileId || "") : "",
    };
  } catch {
    lab.brand = { loading: false, loaded: true, loadedAt: Date.now(), customized: false, names: [], profileName: "" };
  }
  scRerender(labId);
  if (typeof lbChecklistRefresh === "function") lbChecklistRefresh(labId);
}

// ── Shared screenshot library ───────────────────────────────────────────────

async function scLoadLibrary(force = false) {
  const library = scState.library;
  if (library.loading || (library.loaded && !force)) return;
  library.loading = true;
  if (typeof scRenderLibraryHost === "function") scRenderLibraryHost();
  try {
    const { ok, status, data } = await scFetchJson("/api/capture/library");
    if (!ok) throw new Error(data.error || `Request failed (${status})`);
    library.summary = data.summary || null;
    library.shots = Array.isArray(data.shots) ? data.shots : [];
    library.error = "";
    library.loaded = true;
  } catch (err) {
    library.error = err.message || "Could not load the shared library.";
  } finally {
    library.loading = false;
  }
}

/** Coverage per product from the library's slot list. */
function scLibraryByProduct(shots) {
  const rows = new Map();
  for (const shot of Array.isArray(shots) ? shots : []) {
    const product = String(shot.product || "");
    if (!/^[a-z0-9-]{1,60}$/.test(product)) continue;
    if (!rows.has(product)) rows.set(product, { product, total: 0, captured: 0, missing: 0, needsReview: 0 });
    const row = rows.get(product);
    row.total += 1;
    if (shot.captured) row.captured += 1;
    else row.missing += 1;
    if (shot.needsReview) row.needsReview += 1;
  }
  return [...rows.values()].sort((a, b) => a.product.localeCompare(b.product));
}

async function scQueueLibraryCapture(product) {
  const lab = scLab("library");
  lab.outcome = null;
  try {
    const body = { target: { type: "library", products: [product] }, scope: { mode: "missing" }, options: { callouts: "sidecar", redact: true, mode: SC_DEFAULT_CAPTURE_MODE } };
    const { ok, status, data } = await scFetchJson("/api/capture/jobs", scJsonInit("POST", body));
    if (!ok) {
      lab.outcome = { type: "job", variant: "error", message: `Could not start the capture. ${data.error || `Request failed (${status}).`}`, jobId: null, actions: [] };
    } else if (data.nothingToCapture) {
      lab.outcome = { type: "job", variant: "ok", message: "Nothing to capture. Every screenshot for that product already exists.", jobId: null, actions: [] };
    } else if (data.job) {
      scTrackJob("library", data.job, { announce: !data.existing });
      return true;
    }
  } catch (err) {
    lab.outcome = { type: "job", variant: "error", message: `Could not start the capture. ${err.message}`, jobId: null, actions: [] };
  }
  scAnnounce(lab.outcome?.message || "");
  scRerender("library");
  return false;
}
