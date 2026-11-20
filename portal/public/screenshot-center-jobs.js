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
        onlyUnconfirmed: false,
        // A question shown before something that affects other labs: `{ kind, filename|null, title, text, yes, run }`.
        ask: null,
        shareLabResult: null,
        picks: new Set(),
        mode: SC_DEFAULT_CAPTURE_MODE,
        consentOpen: false,
        consentDraft: { practice: false, scratch: false, url: "", agreed: false, error: "" },
        // Which agent the lab's screenshots use, this visit: "created" (the practice agent the computer creates first) or "own" (an agent the person chose). Null until chosen here:
        // the choice saved with the lab decides, then the default. Only the word is saved (with the lab's capture settings), never an address.
        agentSource: null,
        agentSwitched: "",
        startFresh: false,
        queueAfterConsent: false,
        shareRecipe: false,
        background: false,
        causesOpen: new Set(),
        accountBusy: false,
        accountMessage: "",
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
    p.launcher = data.launcher && typeof data.launcher === "object" ? data.launcher : null;
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

// ── Choosing which account to use ───────────────────────────────────────────

const SC_ACCOUNT_POLL_MS = 3000;
const SC_ACCOUNT_POLL_MAX = 200;
const SC_ACCOUNT_DONE = Object.freeze(["done", "failed", "needs-account"]);

/** The product the account is chosen for: Copilot Studio when the lab uses it, otherwise the first product that needs a sign-in. */
function scAccountProduct(labId) {
  let products = [];
  try {
    products = scProductsToSignIn(scLab(labId).state || {});
  } catch {
    products = [];
  }
  if (products.some((p) => p.id === "copilot-studio")) return "copilot-studio";
  return products[0]?.id || "copilot-studio";
}

/** Watch the computer's account setup until it ends, announcing each change once. The page notices it without a reload. */
function scPollAccountSetup() {
  clearTimeout(scState.accountTimer);
  let attempts = 0;
  let last = "";
  const tick = async () => {
    attempts += 1;
    await scLoadStatus(true);
    const setup = scState.status?.companion?.accountSetup || null;
    const line = typeof scAccountSetupLine === "function" ? scAccountSetupLine(setup) : null;
    const key = line ? `${line.state}:${line.text}` : "";
    if (key && key !== last) {
      last = key;
      scAnnounce(line.text);
    }
    scNotifyStatusChanged();
    if ((line && SC_ACCOUNT_DONE.includes(line.state)) || attempts >= SC_ACCOUNT_POLL_MAX) {
      scState.accountTimer = null;
      return;
    }
    scState.accountTimer = setTimeout(tick, SC_ACCOUNT_POLL_MS);
    scState.accountTimer?.unref?.();
  };
  scState.accountTimer = setTimeout(tick, SC_ACCOUNT_POLL_MS);
  scState.accountTimer?.unref?.();
}

/**
 * "Choose which account to use": ask the connected computer to open the sign-in window. The person signs in themselves,
 * with the account they want; nothing here picks an account.
 */
async function scRequestAccountSetup(labId) {
  const lab = scLab(labId);
  if (lab.ui.accountBusy) return;
  lab.ui.accountBusy = true;
  lab.ui.accountMessage = "";
  scRerender(labId);
  try {
    const { ok, data, status } = await scFetchJson("/api/capture/account-setup", scJsonInit("POST", { product: scAccountProduct(labId), ...(SC_SAFE_LAB_ID.test(String(labId)) ? { labId } : {}) }));
    if (!ok) {
      lab.ui.accountMessage = data.error || `Could not ask your computer to open the sign-in window (${status}).`;
      scAnnounce(lab.ui.accountMessage);
      return;
    }
    scAnnounce(data.message || "Look for a new browser window on your computer.");
    await scLoadStatus(true);
    scPollAccountSetup();
  } catch (err) {
    lab.ui.accountMessage = "Could not ask your computer to open the sign-in window. Check your connection and try again.";
    scAnnounce(lab.ui.accountMessage);
  } finally {
    lab.ui.accountBusy = false;
    scRerender(labId);
    scFocusByKey(scHostFor(labId), "account-setup");
  }
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

/** Save the consent card: the one-time yes, and (only if they chose it) a practice agent in the environment named here, or one built from scratch. */
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
  const level = draft.scratch ? "scratch" : draft.practice ? "practice" : "read-only";
  const body = { consented: true, level, practiceEnvironmentUrl: level === "read-only" ? "" : String(draft.url || "").trim() };
  const { ok, data } = await scFetchJson("/api/capture/consent", scJsonInit("PUT", body));
  if (!ok) {
    draft.error = String(data.error || "The choice could not be saved.");
    scRerender(labId);
    return false;
  }
  await scLoadStatus(true);
  lab.ui.consentOpen = false;
  draft.agreed = false;
  if (level === "scratch") lab.ui.agentSource = "created";
  scAnnounce(level === "scratch" ? "Automatic capture is on. It will build a practice agent from scratch and list what it made." : level === "practice" ? "Automatic capture is on. It may also create one practice agent." : "Automatic capture is on. It never creates anything.");
  scRerender(labId);
  // The person chose "Build the agent from scratch": confirming it is the go-ahead, so the capture starts now.
  if (level === "scratch" && lab.ui.queueAfterConsent) {
    lab.ui.queueAfterConsent = false;
    return scQueueCapture(labId, { scope: "missing" });
  }
  return true;
}

// The fields where a person gives their own agent: typing in one while the created agent is selected switches the choice to "An agent I choose".
const SC_OWN_AGENT_FIELDS = Object.freeze(["copilotStudioAgentUrl", "copilotStudioAgentName"]);

/** Remember which agent the lab's screenshots use, with the lab's capture settings. A failed save keeps the choice for this visit. */
async function scSaveAgentSource(labId, source) {
  const lab = scLab(labId);
  try {
    const result = await scFetchJson(scTargetsUrl(labId), scJsonInit("PUT", { agentSource: source }));
    if (result.ok && Array.isArray(result.data.fields)) {
      lab.targets = { loading: false, loaded: true, loadedAt: Date.now(), data: result.data };
      scRerender(labId);
    }
  } catch {
    /* the choice still applies to this visit */
  }
}

/** "The agent created earlier in this capture" or "An agent I choose": the person picked one of the two. */
async function scChooseAgentSource(labId, source) {
  const lab = scLab(labId);
  const next = scAgentSourceOrNull(source);
  if (!next) return;
  lab.ui.agentSource = next;
  lab.ui.agentSwitched = "";
  scAnnounce(next === "own" ? "Using an agent you choose. Add its address or name below." : "Using the practice agent the computer creates first. There is nothing to type.");
  scRerender(labId);
  if (next === "own" && typeof scFocusNeeds === "function") scFocusNeeds(labId);
  await scSaveAgentSource(labId, next);
}

/** The person typed their own agent's address or name while the created agent was selected: switch to "An agent I choose", and say so. */
function scSwitchToOwnAgent(labId) {
  const lab = scLab(labId);
  lab.ui.agentSource = "own";
  lab.ui.agentSwitched = "Switched to An agent I choose, because you added your own agent's address or name.";
  scAnnounce(lab.ui.agentSwitched);
  scRerender(labId);
}

/** The created agent needs the computer's one-time OK to create it: show exactly what it will create and never do, and start the capture once the person agrees. */
async function scAllowAgentCreation(labId) {
  const lab = scLab(labId);
  const consent = scConsentModel(scState.status?.autonomy);
  lab.ui.agentSource = "created";
  if (consent.consented && consent.level === "scratch") {
    await scQueueCapture(labId, { scope: "missing" });
    return;
  }
  lab.ui.consentOpen = true;
  lab.ui.queueAfterConsent = true;
  lab.ui.consentDraft = { practice: false, scratch: true, url: consent.practiceEnvironmentUrl || "", agreed: false, error: "", touched: true };
  scRerender(labId);
  if (typeof scFocusConsent === "function") scFocusConsent(labId);
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
async function scQueueCapture(labId, { scope = "missing", filenames = [], mode, record = null, retake = false } = {}) {
  const lab = scLab(labId);
  lab.outcome = null;
  lab.busy = "queue";
  scRerender(labId);
  let needsAddress = false;
  try {
    const body = {
      target: { type: "lab", labId },
      scope: scScopeBody(scope, filenames),
      options: {
        callouts: lab.ui.callouts,
        redact: lab.ui.redact,
        ...scModeRequest(mode ?? lab.ui.mode),
        ...(lab.ui.background === true ? { background: true } : {}),
        ...(record ? { record: { share: record.share === true } } : {}),
        // A retake may replace the shared library's picture (never one that is marked accurate); an ordinary capture never does.
        ...(retake ? { retake: true } : {}),
        // Which agent the screenshots use, when the person chose here (the created practice agent is the default, and the lab's saved choice applies when nothing is said).
        ...(scAgentSourceOrNull(lab.ui.agentSource) ? { agentSource: lab.ui.agentSource } : {}),
        ...(lab.ui.startFresh === true ? { startFresh: true } : {}),
      },
      ...scTenantFields(labId),
    };
    const { ok, status, data } = await scFetchJson("/api/capture/jobs", scJsonInit("POST", body));
    if (!ok) {
      lab.outcome = { type: "job", variant: "error", message: `Could not start the capture. ${data.error || `Request failed (${status}).`}`, jobId: null, actions: [] };
    } else if (data.needsNewerCompanion) {
      // Nothing was queued: this computer's companion is too old to build an agent from scratch.
      lab.outcome = { type: "job", variant: "warn", message: scText(data.message, 400) || "Download the Local Capture Companion again to build the agent from scratch.", jobId: null, actions: [] };
    } else if (data.needsConsent) {
      // Nothing was queued: the person has not allowed automatic capture yet, so show the card that asks. With the created agent chosen, it asks for exactly that.
      lab.ui.consentOpen = true;
      if (scAgentSourceOf(lab) === "created" && lab.ui.mode === "autonomous") {
        lab.ui.consentDraft = { practice: false, scratch: true, url: scConsentModel(scState.status?.autonomy).practiceEnvironmentUrl || "", agreed: false, error: "", touched: true };
        lab.ui.queueAfterConsent = true;
      }
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
      // A fresh practice agent was asked for once: it is now on its way, so the switch is off again.
      if (lab.ui.startFresh) {
        lab.ui.startFresh = false;
        scAnnounce("The capture will build a new practice agent.");
      }
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
  return scQueueCapture(labId, { scope: "selected", filenames, mode, record, retake: true });
}

function scRetakeShot(labId, filename, options) {
  return scRetakeShots(labId, [filename], options);
}

// ── "Mark as accurate", sharing, and the questions asked first ──────────────

/** After a confirmation or a share, the shared library's counts changed: show them again. */
function scRefreshLibraryNumbers() {
  scState.library.loaded = false;
  void scLoadStatus(true).then(() => {
    if (typeof scRenderLibraryHost === "function") scRenderLibraryHost();
  });
}

const scShotOf = (labId, filename) => (scLab(labId).state?.shots || []).find((s) => s.filename === filename) || null;

/** "Mark as accurate": a person says this picture is right. Optional, and it never blocks the lab or an export. */
async function scConfirmShot(labId, filename) {
  const { ok, data, status } = await scFetchJson(scScreenshotApi(labId, filename, "/confirm"), scJsonInit("POST", {}));
  if (!ok || data.outcome !== "confirmed") {
    scSetFeedback(labId, filename, { variant: "bad", headline: "Could not mark it as accurate.", items: [{ level: "fail", text: String(data.error || `Request failed (${status}).`) }] });
    scAnnounce("Could not mark this screenshot as accurate.");
    return false;
  }
  scSetFeedback(labId, filename, null);
  scAnnounce(data.scope === "library" ? "Marked as accurate for every lab that uses the shared picture." : "Marked as accurate.");
  if (data.state) await scApplyNewState(labId, data.state);
  else await scRefreshLabState(labId);
  scRefreshLibraryNumbers();
  return true;
}

/** "Clear confirmation". */
async function scUnconfirmShot(labId, filename) {
  const { ok, data, status } = await scFetchJson(scScreenshotApi(labId, filename, "/confirm"), { method: "DELETE" });
  if (!ok) {
    scSetFeedback(labId, filename, { variant: "bad", headline: "Could not clear the confirmation.", items: [{ level: "fail", text: String(data.error || `Request failed (${status}).`) }] });
    return false;
  }
  scAnnounce("Confirmation cleared.");
  if (data.state) await scApplyNewState(labId, data.state);
  else await scRefreshLabState(labId);
  scRefreshLibraryNumbers();
  return true;
}

/** Show a question before something that affects other labs. `run` is what "yes" does. */
function scOpenAsk(labId, ask) {
  const lab = scLab(labId);
  lab.ui.ask = ask;
  scAnnounce(`${ask.title} ${ask.text}`);
  scRerender(labId);
  const host = typeof scHostFor === "function" ? scHostFor(labId) : null;
  if (host && typeof scFocusByKey === "function") scFocusByKey(host, ask.filename ? `ask-cancel:${ask.filename}` : "ask-cancel");
}

function scCancelAsk(labId) {
  const lab = scLab(labId);
  const back = lab.ui.ask?.focusBack || "";
  lab.ui.ask = null;
  scRerender(labId);
  const host = typeof scHostFor === "function" ? scHostFor(labId) : null;
  if (host && back && typeof scFocusByKey === "function") scFocusByKey(host, back);
}

async function scAnswerAsk(labId) {
  const lab = scLab(labId);
  const ask = lab.ui.ask;
  if (!ask) return;
  lab.ui.ask = null;
  scRerender(labId);
  if (typeof ask.run === "function") await ask.run();
}

/**
 * Before a retake replaces a picture other labs use, say so. Returns true when a question was opened (nothing happens until the
 * person answers), false when the retake can go ahead now. `run` is what "yes" does.
 */
async function scAskBeforeRetake(labId, filenames, run) {
  const shared = filenames.map((name) => scShotOf(labId, name)).filter((shot) => shot?.share && ["shared", "differs"].includes(shot.share.state));
  if (!shared.length) return false;
  let otherLabs = 0;
  let confirmed = 0;
  let unknown = false;
  for (const shot of shared.slice(0, 20)) {
    try {
      const { ok, data } = await scFetchJson(`/api/capture/library/screenshots/${encodeURIComponent(shot.filename)}/usage?labId=${encodeURIComponent(labId)}`);
      if (!ok) unknown = true;
      else {
        otherLabs = Math.max(otherLabs, scCount(data.otherLabs));
        if (data.confirmed === true) confirmed += 1;
      }
    } catch {
      unknown = true;
    }
  }
  const text = scRetakeAskText({ otherLabs, confirmed, unknown, many: shared.length > 1 });
  if (!text) return false;
  const first = filenames.length === 1 ? filenames[0] : null;
  scOpenAsk(labId, {
    kind: "retake",
    filename: first,
    title: confirmed ? "This shared picture is marked accurate." : "Other labs use this picture.",
    text,
    yes: confirmed ? "Retake for this lab" : "Yes, retake it",
    focusBack: first ? `card:${first}:shot-retake` : "primary",
    run,
  });
  return true;
}

/** "Use this one for every lab": asks first, then puts this lab's own picture in the shared library. */
function scAskShareShot(labId, filename) {
  const shot = scShotOf(labId, filename);
  const offer = shot ? scShareOffer(shot) : null;
  if (!offer) return;
  const replaces = offer.state === "differs";
  scOpenAsk(labId, {
    kind: "share",
    filename,
    title: offer.libraryConfirmed ? "This replaces a picture marked accurate." : "Use this picture for every lab?",
    text: `${offer.libraryConfirmed ? "The shared picture is marked accurate. Replacing it clears that mark. " : ""}Every lab that has no picture of its own will show this one${replaces ? ", and the shared picture it replaces is kept as a backup" : ""}. Check that it shows no account names, email addresses, or customer data.`,
    yes: "Yes, use it for every lab",
    focusBack: `card:${filename}:shot-share`,
    run: () => scShareShot(labId, filename, { replaceConfirmed: offer.libraryConfirmed }),
  });
}

async function scShareShot(labId, filename, { replaceConfirmed = false } = {}) {
  const { data, status } = await scFetchJson(scScreenshotApi(labId, filename, "/share"), scJsonInit("POST", { confirm: true, replaceConfirmed }));
  const worked = status === 200 && ["shared", "replaced", "already-shared"].includes(data.outcome);
  const message = worked ? (data.outcome === "already-shared" ? "The shared library already has this picture." : "Every lab can now use this picture.") : String(data.message || data.error || `Could not share it (${status}).`);
  scSetFeedback(labId, filename, { variant: worked ? "ok" : "warn", headline: message, items: [] });
  scAnnounce(message);
  if (data.state) await scApplyNewState(labId, data.state);
  else await scRefreshLabState(labId);
  scRefreshLibraryNumbers();
  return worked;
}

/** "Share this lab's captured screenshots": every eligible picture, nothing overwritten, a plain report of what was skipped. */
function scAskShareLab(labId) {
  scOpenAsk(labId, {
    kind: "share-lab",
    filename: null,
    title: "Share this lab's screenshots with every lab?",
    text: "This adds this lab's checked pictures to the shared library. Pictures that show account details, that the library already has, or that belong only to this lab are skipped. Nothing in the library is replaced.",
    yes: "Yes, share them",
    focusBack: "share-lab",
    run: () => scShareLab(labId),
  });
}

async function scShareLab(labId) {
  const lab = scLab(labId);
  lab.ui.shareLabResult = { busy: true, message: "Sharing this lab's screenshots.", items: [] };
  scRerender(labId);
  try {
    const { ok, data, status } = await scFetchJson(`/api/lab-builder/generated/${encodeURIComponent(labId)}/screenshots/share`, scJsonInit("POST", {}));
    if (!ok) throw new Error(String(data.error || `Request failed (${status}).`));
    const counts = data.counts || {};
    const items = (Array.isArray(data.skipped) ? data.skipped : []).slice(0, 12).map((s) => ({ text: `${scText(s.filename, 80)}: ${scText(s.message, 200)}` }));
    const message = `${scPlural(scCount(counts.promoted), "screenshot")} shared. ${scCount(counts.alreadyShared)} already in the library. ${scCount(counts.skipped)} skipped.`;
    lab.ui.shareLabResult = { busy: false, variant: "ok", message, items };
    scAnnounce(message);
    if (data.state) await scApplyNewState(labId, data.state);
    scRefreshLibraryNumbers();
  } catch (err) {
    lab.ui.shareLabResult = { busy: false, variant: "bad", message: `Could not share the screenshots. ${err.message}`, items: [] };
    scAnnounce(lab.ui.shareLabResult.message);
  }
  scRerender(labId);
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
  // The person gave their own agent: that is the agent these screenshots use, and it is remembered with the lab's other capture settings.
  const ownAgentGiven = SC_OWN_AGENT_FIELDS.some((id) => String(targets[id] || "").trim());
  try {
    result = await scFetchJson(scTargetsUrl(labId), scJsonInit("PUT", { targets, alsoProfile, ...(ownAgentGiven ? { agentSource: "own" } : {}) }));
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
  if (ownAgentGiven) lab.ui.agentSource = "own";
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
    if (!rows.has(product)) rows.set(product, { product, total: 0, captured: 0, missing: 0, needsReview: 0, confirmed: 0 });
    const row = rows.get(product);
    row.total += 1;
    if (shot.captured) row.captured += 1;
    else row.missing += 1;
    if (shot.needsReview) row.needsReview += 1;
    if (shot.captured && shot.confirmed) row.confirmed += 1;
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
