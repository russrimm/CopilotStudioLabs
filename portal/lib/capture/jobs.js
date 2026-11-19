/**
 * Persisted screenshot capture job queue.
 *
 * A job is one request to capture a set of shots for a single lab or for the
 * shared library. The portal queues it; the Local Capture Companion claims it,
 * reports progress shot by shot, uploads each image, and completes it. Every job
 * keeps per-shot results, progress counters, timestamps, and an event log.
 *
 * Files live in `<data dir>/capture/jobs/` (`<id>.json` for state, `<id>.plan.json`
 * for the shot plan the companion runs), so they follow the Azure Blob mirror.
 * State is read from disk on every call, so nothing is cached across a restart.
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

import { cleanText, readJson, writeJsonAtomic } from "./store-util.js";
import { cleanAccount, cleanNeedsAccount } from "./account.js";
import { CAUSES, causeForVerification, describeCause } from "../../../tools/screenshot-capture/causes.mjs";
import { sanitizeSetupEvidence } from "../../../tools/screenshot-capture/image-verify.mjs";
import { REQUIREMENTS, effectiveModeFor, missingRequirements, targetValuesFromJob, validateTargets } from "../../../tools/screenshot-capture/targets.mjs";
import { BLOCKERS, STAGES } from "../../../tools/screenshot-capture/walkthrough.mjs";

export const JOB_STATUSES = Object.freeze(["queued", "claimed", "running", "done", "failed", "cancelled"]);
export const TERMINAL_JOB_STATUSES = Object.freeze(["done", "failed", "cancelled"]);
export const SHOT_STATUSES = Object.freeze([
  "pending",
  "running",
  "captured",
  "needs-review",
  "failed",
  "auth-required",
  "needs-account",
  "manual-required",
  "skipped",
  "cancelled",
  "needs-you",
  "paused",
]);
const TERMINAL_SHOT_STATUSES = new Set(["captured", "needs-review", "failed", "auth-required", "needs-account", "manual-required", "skipped", "cancelled", "needs-you", "paused"]);
export const SCOPE_MODES = Object.freeze(["missing", "stale", "all", "selected"]);
export const TARGET_TYPES = Object.freeze(["lab", "library"]);
export const CALLOUT_MODES = Object.freeze(["sidecar", "burn", "none"]);
/** How a capture runs: the computer sets everything up itself, the computer does only what needs no setup, the person sets up each screen, or a mix. */
export const CAPTURE_MODES = Object.freeze(["autonomous", "auto", "guided", "smart"]);

export const CLAIM_STALE_MS = 5 * 60 * 1000;
export const QUEUED_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const MAX_RETAINED_JOBS = 200;
// A companion that keeps asking for the same unfinished job without finishing a shot is stuck: stop handing it the job.
export const MAX_RESUMES = 3;
const SIGN_IN_NEED_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_EVENTS = 300;
const MAX_SHOTS = 400;
const SAFE_LAB_ID = /^[a-z0-9][a-z0-9-]{0,99}$/i;
const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(?:png|jpe?g|webp)$/i;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const ENV_NAME_RE = /^CAPTURE_[A-Z0-9_]{1,80}$/;
const JOB_ID_RE = /^job_[a-f0-9]{16}$/;

/** Whether a job id has the shape the store generates (guards file paths). */
export function isJobId(value) {
  return JOB_ID_RE.test(String(value ?? ""));
}

/**
 * Validate the CAPTURE_* environment a job may carry (tenant addresses).
 * Names must start with CAPTURE_; values must be https URLs without credentials.
 */
export function validateCaptureEnv(env) {
  if (env === undefined || env === null) return { ok: true, env: {}, errors: [] };
  if (typeof env !== "object" || Array.isArray(env)) return { ok: false, env: {}, errors: ["env must be an object of CAPTURE_* variables."] };
  const entries = Object.entries(env);
  if (entries.length > 40) return { ok: false, env: {}, errors: ["env has too many variables (limit 40)."] };
  const clean = {};
  const errors = [];
  for (const [name, value] of entries) {
    if (!ENV_NAME_RE.test(name)) {
      errors.push(`${cleanText(name, 60)} is not allowed: names must start with CAPTURE_ and use capital letters, digits, and underscores.`);
      continue;
    }
    if (typeof value !== "string" || value.length > 2048 || !/^https:\/\/[^\s]+$/.test(value)) {
      errors.push(`${name} must be an https URL.`);
      continue;
    }
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password || !url.hostname) throw new Error("bad");
    } catch {
      errors.push(`${name} must be an https URL without a user name or password.`);
      continue;
    }
    clean[name] = value;
  }
  return { ok: errors.length === 0, env: clean, errors };
}

function cleanList(value, { max, pattern }) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const out = [];
  for (const item of value.slice(0, max)) {
    const text = String(item ?? "").trim();
    if (!pattern.test(text)) return null;
    if (!out.includes(text)) out.push(text);
  }
  return out;
}

/**
 * Validate a job request body into the normalized target, scope, and options.
 * Returns `{ok: false, errors}` instead of throwing.
 */
export function normalizeJobRequest(body = {}) {
  const errors = [];
  const src = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const targetIn = src.target && typeof src.target === "object" ? src.target : {};
  const typeRaw = String(targetIn.type ?? (src.labId ? "lab" : "")).toLowerCase();
  const type = typeRaw === "shared" || typeRaw === "shared-library" ? "library" : typeRaw;
  if (!TARGET_TYPES.includes(type)) errors.push('target.type must be "lab" or "library".');
  const target = { type };
  if (type === "lab") {
    const labId = String(targetIn.labId ?? src.labId ?? "").trim();
    if (!SAFE_LAB_ID.test(labId)) errors.push("target.labId is required and must be a valid lab id.");
    target.labId = labId;
  } else if (type === "library") {
    const products = cleanList(targetIn.products ?? (targetIn.product ? [targetIn.product] : src.products), { max: 12, pattern: /^[a-z0-9-]{1,60}$/ });
    if (products === null) errors.push("target.products must be a list of product ids.");
    target.products = products || [];
  }

  const scopeIn = src.scope && typeof src.scope === "object" ? src.scope : { mode: src.scope };
  const mode = String(scopeIn.mode ?? "missing").toLowerCase();
  if (!SCOPE_MODES.includes(mode)) errors.push(`scope must be one of: ${SCOPE_MODES.join(", ")}.`);
  const filenames = cleanList(scopeIn.filenames ?? src.filenames, { max: MAX_SHOTS, pattern: SAFE_FILENAME });
  const featureIds = cleanList(scopeIn.featureIds ?? src.featureIds, { max: 100, pattern: SAFE_TOKEN });
  if (filenames === null) errors.push("filenames must be a list of valid screenshot file names.");
  if (featureIds === null) errors.push("featureIds must be a list of feature ids.");
  if (mode === "selected" && !(filenames?.length || featureIds?.length)) errors.push('scope "selected" needs filenames or featureIds.');
  const scope = { mode, filenames: filenames || [], featureIds: featureIds || [] };

  const envCheck = validateCaptureEnv(src.env);
  errors.push(...envCheck.errors);

  const optionsIn = src.options && typeof src.options === "object" ? src.options : {};
  const callouts = String(optionsIn.callouts ?? "sidecar").toLowerCase();
  if (!CALLOUT_MODES.includes(callouts)) errors.push(`options.callouts must be one of: ${CALLOUT_MODES.join(", ")}.`);
  const maskTerms = cleanList(optionsIn.maskTerms, { max: 20, pattern: /^[^\u0000-\u001f]{3,80}$/ });
  if (maskTerms === null) errors.push("options.maskTerms must be a list of text to hide (3 to 80 characters each).");
  const modeRaw = String(optionsIn.mode ?? "default").toLowerCase();
  if (modeRaw !== "default" && !CAPTURE_MODES.includes(modeRaw)) errors.push(`options.mode must be one of: ${CAPTURE_MODES.join(", ")}.`);
  // `mode: null` means "not said": the portal picks autonomous when the person has consented, and smart (the older behavior) otherwise.
  const autonomyIn = optionsIn.autonomy && typeof optionsIn.autonomy === "object" && !Array.isArray(optionsIn.autonomy) ? optionsIn.autonomy : null;
  const options = { callouts, redact: optionsIn.redact !== false, maskTerms: maskTerms || [], mode: CAPTURE_MODES.includes(modeRaw) ? modeRaw : null, autonomy: autonomyIn?.level === "read-only" ? { level: "read-only" } : null, record: normalizeRecord(optionsIn.record), background: optionsIn.background === true, agent: optionsIn.agent === "existing" ? "existing" : optionsIn.agent === "scratch" ? "scratch" : null, startFresh: optionsIn.startFresh === true };

  const targetsIn = src.targets === undefined || src.targets === null ? {} : src.targets;
  const targetsCheck = validateTargets(targetsIn);
  if (typeof targetsIn !== "object" || Array.isArray(targetsIn)) errors.push("targets must be an object of capture settings.");
  else errors.push(...Object.values(targetsCheck.errors));

  return { ok: errors.length === 0, errors, target, scope, env: envCheck.env, targets: targetsCheck.values, options };
}

/** "Show me once": a retake in which the person sets the screen up and the computer learns it. `share` is their explicit choice to share the recipe. */
function normalizeRecord(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return { share: raw.share === true };
}

/** What was built from scratch, as the portal keeps it: a name, a date, the environment choice, and what is done. Never an address or an id. */
export function cleanScratch(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const name = plainText(raw.name, 80);
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(raw.createdAt || "")) ? String(raw.createdAt) : null;
  const stopped = plainText(raw.stopped, 200);
  return {
    ...(name ? { name } : {}),
    ...(day ? { createdAt: day } : {}),
    reused: raw.reused === true,
    environment: raw.environment === "set" ? "set" : "default",
    stages: (Array.isArray(raw.stages) ? raw.stages : []).map((s) => cleanText(s, 24)).filter((s) => /^[a-z-]{2,24}$/.test(s)).slice(0, 12),
    ...(stopped ? { stopped } : {}),
  };
}

/** What the companion made during a job, as the portal keeps it: a kind, a name, and a sentence. Never an address or an id. */
export function cleanCreated(list) {
  return (Array.isArray(list) ? list : []).slice(0, 20).map((item) => ({
    kind: ["agent", "change"].includes(item?.kind) ? item.kind : "change",
    name: cleanText(item?.name, 80),
    what: cleanText(item?.what, 120),
    reused: item?.reused === true,
  })).filter((item) => item.what);
}

const SIGN_IN_CHECK_IDS = new Set(["waiting-for-you", "synced-profile", "cookies-blocked", "conditional-access", "clock-skew", "stale-session", "popups-tracking", "automation-browser", "client-loop", "mfa"]);
/** Plain text from a companion: no addresses, no email addresses, bounded. */
const plainText = (value, max) => cleanText(String(value ?? "").replace(/https?:\/\/\S+/gi, "").replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, ""), max);

/**
 * Why a sign-in did not work, as the companion explains it: a code, a summary, the next step, and the checks it ran.
 * Only sentences and known ids are kept; anything shaped like an address or an account is dropped.
 */
export function cleanSignIn(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const summary = plainText(raw.summary, 400);
  const nextStep = plainText(raw.nextStep, 300);
  if (!summary && !nextStep) return null;
  return {
    product: /^[a-z0-9-]{1,60}$/i.test(String(raw.product || "")) ? String(raw.product) : "",
    code: /^[a-z-]{1,24}$/.test(String(raw.code || "")) ? String(raw.code) : "sign-in",
    aadsts: /^AADSTS\d{3,7}$/.test(String(raw.aadsts || "")) ? String(raw.aadsts) : null,
    summary,
    nextStep,
    checks: (Array.isArray(raw.checks) ? raw.checks : [])
      .map((check) => ({ id: SIGN_IN_CHECK_IDS.has(check?.id) ? check.id : "other", level: check?.level === "likely" ? "likely" : "possible", title: plainText(check?.title, 100), fix: plainText(check?.fix, 260) }))
      .filter((check) => check.title)
      .slice(0, 8),
  };
}

/** What the plan says the computer will do for one shot, in plain words: its stage of the lab, or why it needs a person. */
function plannedSetupLines(capture) {
  const scratch = capture?.scratch;
  if (scratch?.blocker && BLOCKERS[scratch.blocker]) return [cleanText(BLOCKERS[scratch.blocker].reason, 160)];
  if (scratch?.scoped) {
    const stage = STAGES.find((s) => s.id === scratch.stage);
    return [`Builds the practice agent as far as this step needs${stage ? `, then: ${stage.label.toLowerCase()}` : ""}`];
  }
  return Array.isArray(capture?.setup?.summary) ? capture.setup.summary.map((s) => cleanText(s, 120)).slice(0, 10) : [];
}

function countShots(shots) {
  const counts = { total: shots.length, captured: 0, needsReview: 0, failed: 0, manual: 0, skipped: 0, running: 0, pending: 0, cancelled: 0, needsYou: 0, paused: 0 };
  for (const shot of shots) {
    if (shot.status === "captured") counts.captured += 1;
    else if (shot.status === "needs-review") counts.needsReview += 1;
    else if (shot.status === "failed" || shot.status === "auth-required" || shot.status === "needs-account") counts.failed += 1;
    else if (shot.status === "manual-required") counts.manual += 1;
    else if (shot.status === "skipped") counts.skipped += 1;
    else if (shot.status === "cancelled") counts.cancelled += 1;
    else if (shot.status === "needs-you") counts.needsYou += 1;
    else if (shot.status === "paused") counts.paused += 1;
    else if (shot.status === "running") counts.running += 1;
    else counts.pending += 1;
  }
  counts.done = counts.total - counts.running - counts.pending;
  counts.percent = counts.total ? Math.round((counts.done / counts.total) * 100) : 100;
  return counts;
}

/** Why a shot ended the way it did: the cause the companion reported, or one worked out from its status and checks. */
export function causeOf(row) {
  if (row.cause && CAUSES[row.cause]) return row.cause;
  if (row.status === "auth-required") return "sign-in";
  if (row.status === "needs-account") return "needs-account";
  if (row.status === "manual-required") return "manual";
  if (row.status === "needs-you") return "needs-you";
  if (row.status === "paused") return "browser-closed";
  if (row.status === "needs-review") return causeForVerification(row.verification?.reasons);
  if (row.status === "skipped") return "no-address";
  if (row.status === "failed") return causeForVerification(row.verification?.reasons) || "unknown";
  return null;
}

/**
 * Group the shots that did not end well by cause, one entry per cause with the one thing to do about it:
 * "No agent address set: 12 screenshots" instead of twelve separate lines.
 * @returns {Array<{cause: string, title: string, fix: string, fixAction: string, tone: string, count: number, filenames: string[]}>}
 */
export function summarizeCauses(shots) {
  const groups = new Map();
  for (const row of Array.isArray(shots) ? shots : []) {
    if (row.status === "captured" || row.status === "pending" || row.status === "running" || row.status === "cancelled") continue;
    const code = causeOf(row);
    if (!code) continue;
    if (!groups.has(code)) groups.set(code, { ...describeCause(code), count: 0, filenames: [] });
    const group = groups.get(code);
    group.count += 1;
    if (group.filenames.length < 100) group.filenames.push(row.filename);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

/** The steps a companion reports for one shot, bounded: names the lab gave and masked addresses, never page text. */
export function cleanSteps(steps) {
  return (Array.isArray(steps) ? steps : []).slice(0, 14).map((s) => ({
    action: cleanText(s?.action, 24),
    label: s?.label ? cleanText(s.label, 80) : undefined,
    found: s?.found === true,
    ok: s?.ok === true,
    urlBefore: s?.urlBefore ? cleanText(String(s.urlBefore).split(/[?#]/)[0], 200) : undefined,
    urlAfter: s?.urlAfter ? cleanText(String(s.urlAfter).split(/[?#]/)[0], 200) : undefined,
    note: s?.note ? cleanText(s.note, 80) : undefined,
  }));
}

/** "Opened Copilot Studio, then your agent, then Settings, then selected Generative AI." */
export function plainOutcome(path, steps, mode, setup = null) {
  const parts = Array.isArray(path) ? path.filter(Boolean) : [];
  const picked = (Array.isArray(steps) ? steps : []).filter((s) => s?.action === "reveal" && s.ok && s.tried > 0).map((s) => s.label);
  const opened = parts.length ? `Opened ${parts.join(", then ")}` : "Opened the page";
  const did = Array.isArray(setup?.summary) && setup.summary.length ? `, then ${setup.summary.map((s) => cleanText(s, 120).replace(/^(\w)/, (c) => c.toLowerCase())).join(", then ")}` : "";
  const limited = setup?.limitedBy === "practice-agent" ? " It needs a practice agent to show the final state." : "";
  return `${opened}${picked.length ? `, then selected ${picked.join(" and ")}` : ""}${did}.${mode === "guided" ? " You set up the screen." : ""}${limited}`;
}

function joinNames(names) {
  const list = names.filter(Boolean);
  if (list.length <= 1) return list[0] || "your Microsoft account";
  return `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;
}

/**
 * Which products need a sign-in on the person's computer, from the shots that ended `auth-required`.
 * Returns null when no shot needs one. `message` is the sentence to show: what to do, then how many shots to retry.
 */
export function summarizeSignInNeeds(shots, labelFor = (id) => id) {
  const waiting = (Array.isArray(shots) ? shots : []).filter((shot) => shot.status === "auth-required");
  if (!waiting.length) return null;
  const counts = new Map();
  for (const shot of waiting) {
    const id = shot.product || "microsoft-365";
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  const products = [...counts].map(([id, count]) => ({ id, label: cleanText(labelFor(id), 80) || id, count }));
  const total = waiting.length;
  return {
    count: total,
    products,
    message: `Sign in to ${joinNames(products.map((p) => p.label))} on your computer, then retry the ${total} screenshot${total === 1 ? "" : "s"}.`,
  };
}

function summarize(job, labelFor) {
  const { shots, events, ...rest } = job;
  const needsSignIn = summarizeSignInNeeds(shots, labelFor);
  return { ...rest, progress: countShots(shots || []), causes: summarizeCauses(shots), ...(needsSignIn ? { needsSignIn } : {}) };
}

/**
 * @param {object} options
 * @param {string} options.dir the `<data dir>/capture` folder
 * @param {() => number} [options.now]
 * @param {(product: string) => string} [options.productLabel] readable product names for sign-in messages
 */
export function createJobStore({
  dir,
  now = () => Date.now(),
  claimStaleMs = CLAIM_STALE_MS,
  queuedMaxAgeMs = QUEUED_MAX_AGE_MS,
  maxRetained = MAX_RETAINED_JOBS,
  productLabel = (id) => id,
} = {}) {
  const jobsDir = path.join(dir, "jobs");
  const emitter = new EventEmitter();
  emitter.setMaxListeners(200);

  const jobFile = (id) => path.join(jobsDir, `${id}.json`);
  const planFile = (id) => path.join(jobsDir, `${id}.plan.json`);
  const iso = () => new Date(now()).toISOString();

  function readJob(id) {
    if (!isJobId(id)) return null;
    const job = readJson(jobFile(id), null);
    return job && job.id === id ? job : null;
  }

  function persist(job, event = null) {
    job.updatedAt = iso();
    writeJsonAtomic(jobFile(job.id), job);
    emitter.emit(job.id, { type: event?.type || "update", job: summarize(job, productLabel), event });
  }

  function addEvent(job, type, message, data = null) {
    const event = { at: iso(), type, message: cleanText(message, 400) };
    if (data) event.data = data;
    job.events.push(event);
    if (job.events.length > MAX_EVENTS) job.events.splice(0, job.events.length - MAX_EVENTS);
    return event;
  }

  function finalize(job, status, message) {
    job.status = status;
    job.finishedAt = iso();
    job.progress = countShots(job.shots);
    const event = addEvent(job, status, message);
    persist(job, event);
  }

  function expireIfStale(job) {
    if (TERMINAL_JOB_STATUSES.includes(job.status)) return job;
    const t = now();
    if (job.status === "queued") {
      if (t - Date.parse(job.createdAt) > queuedMaxAgeMs) {
        for (const shot of job.shots) if (!TERMINAL_SHOT_STATUSES.has(shot.status)) shot.status = "cancelled";
        job.error = "No companion picked up this job within 24 hours.";
        finalize(job, "failed", job.error);
      }
      return job;
    }
    const last = Date.parse(job.claim?.lastActivityAt || job.claim?.claimedAt || job.updatedAt);
    if (t - last > claimStaleMs) {
      for (const shot of job.shots) if (!TERMINAL_SHOT_STATUSES.has(shot.status)) shot.status = "cancelled";
      if (job.cancelRequested) {
        finalize(job, "cancelled", "Canceled. The companion had stopped responding.");
      } else {
        job.error = "The companion stopped responding. Start it again and queue a new job for the missing shots.";
        finalize(job, "failed", job.error);
      }
    }
    return job;
  }

  function prune() {
    if (!existsSync(jobsDir)) return;
    const ids = readdirSync(jobsDir)
      .filter((name) => /^job_[a-f0-9]{16}\.json$/.test(name))
      .map((name) => name.slice(0, -5));
    if (ids.length <= maxRetained) return;
    const jobs = ids.map((id) => readJson(jobFile(id), null)).filter(Boolean).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    let excess = jobs.length - maxRetained;
    for (const job of jobs) {
      if (excess <= 0) break;
      if (!TERMINAL_JOB_STATUSES.includes(job.status)) continue;
      rmSync(jobFile(job.id), { force: true });
      rmSync(planFile(job.id), { force: true });
      excess -= 1;
    }
  }

  /**
   * Queue a job. `request` is a validated `normalizeJobRequest()` result and
   * `plan.shots` the shot plan the companion will run (filename, startUrl, steps...).
   */
  function create({ target, scope, env = {}, targets = {}, options = {}, plan, createdBy = null, autonomy = null }) {
    const shots = (plan?.shots || []).slice(0, MAX_SHOTS);
    const id = `job_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const t = iso();
    const mode = CAPTURE_MODES.includes(options.mode) ? options.mode : "smart";
    const values = targetValuesFromJob(env, targets);
    // What the job may do on its own. The job record keeps only the level; the practice environment address stays in the plan file, for the companion.
    const carried = mode === "autonomous" && autonomy ? { version: autonomy.version || 1, consented: true, level: ["practice", "scratch"].includes(autonomy.level) ? autonomy.level : "read-only" } : null;
    const withEnvironment = carried && carried.level !== "read-only";
    const job = {
      schema: 1,
      id,
      status: "queued",
      createdAt: t,
      updatedAt: t,
      startedAt: null,
      finishedAt: null,
      createdBy: createdBy ? cleanText(createdBy, 120) : null,
      target,
      scope,
      options: { ...options, mode, autonomy: carried },
      envNames: Object.keys(env).sort(),
      targetNames: Object.keys(targets).sort(),
      claim: null,
      cancelRequested: false,
      error: null,
      result: null,
      shots: shots.map((shot) => shotRow(shot, mode, values, carried)),
      events: [],
    };
    job.progress = countShots(job.shots);
    writeJsonAtomic(planFile(id), { schema: 1, id, env, targets, shots, options: job.options, autonomy: carried ? { ...carried, practiceEnvironmentUrl: withEnvironment ? autonomy.practiceEnvironmentUrl || "" : "", ...(carried.level === "scratch" ? { scratchContext: autonomy.scratchContext || null, startFresh: autonomy.startFresh === true } : {}) } : null });
    const event = addEvent(job, "queued", `Queued ${shots.length} shot${shots.length === 1 ? "" : "s"}.`);
    persist(job, event);
    prune();
    return summarizeFull(job);
  }

  /**
   * One shot's row. A shot that cannot run is settled at once and says why: outside the browser, waiting for an
   * address, or a screen that needs the person in a mode that does not ask them.
   */
  function shotRow(shot, mode, values, autonomy = null) {
    const capture = shot.capture || null;
    const row = {
      filename: shot.filename,
      shotId: shot.shotId ?? null,
      featureId: shot.featureId ?? null,
      product: shot.product ?? null,
      status: "pending",
      attempts: 0,
      startedAt: null,
      finishedAt: null,
      message: null,
      error: null,
      verification: null,
      mode: capture?.mode ?? null,
      modeWhy: capture?.why ? cleanText(capture.why, 300) : null,
      path: Array.isArray(capture?.path) ? capture.path.map((p) => cleanText(p, 60)).slice(0, 6) : [],
      cause: null,
      outcome: null,
      steps: [],
      setup: null,
      // What the plan says the computer will do, in plain words, before it does it.
      plannedSetup: plannedSetupLines(capture),
      needsPractice: capture?.setup?.needsPractice === true || (capture?.scratch?.scoped === true && !capture.scratch.blocker),
    };
    const effective = effectiveModeFor(shot, mode);
    if (effective === "manual") {
      row.status = "manual-required";
      row.cause = "manual";
      row.message = "This screen is outside the browser. Capture it with an OS screenshot tool and upload it.";
    } else if (effective === "needs-you") {
      row.status = "needs-you";
      row.cause = "needs-you";
      row.message = "This screen needs you to set it up. Automatic mode skips it. Use “Retake guided”, or choose Smart.";
    } else if (effective === "auto" || effective === "autonomous") {
      // A shot that runs in the practice agent does not need the person's own agent. Built from scratch, no shot does.
      const scratchRun = effective === "autonomous" && autonomy?.level === "scratch";
      const practiceRun = scratchRun || (effective === "autonomous" && autonomy?.level === "practice" && capture?.setup?.needsPractice === true);
      const needed = effective === "autonomous" ? [...new Set([...(capture?.needs || []), ...(capture?.agentNeeds || [])])] : capture?.needs || [];
      const missing = missingRequirements(needed, values).filter((id) => !(practiceRun && id === "copilot-studio-agent"));
      if (missing.length) {
        const requirement = REQUIREMENTS[missing[0]];
        row.status = "skipped";
        row.cause = requirement.cause;
        row.message = `This screenshot needs your ${requirement.noun}. Add it in Capture settings, then retake.`;
      }
    }
    if (row.status !== "pending") row.finishedAt = iso();
    return row;
  }

  function summarizeFull(job) {
    const needsSignIn = summarizeSignInNeeds(job.shots, productLabel);
    return { ...job, progress: countShots(job.shots), causes: summarizeCauses(job.shots), ...(needsSignIn ? { needsSignIn } : {}) };
  }

  function get(id) {
    const job = readJob(id);
    return job ? summarizeFull(expireIfStale(job)) : null;
  }

  /** The shot plan and CAPTURE_* environment, for the companion only. */
  function getPlan(id) {
    return isJobId(id) ? readJson(planFile(id), null) : null;
  }

  function list({ limit = 25, status = null, labId = null } = {}) {
    if (!existsSync(jobsDir)) return [];
    const jobs = readdirSync(jobsDir)
      .filter((name) => /^job_[a-f0-9]{16}\.json$/.test(name))
      .map((name) => readJob(name.slice(0, -5)))
      .filter(Boolean)
      .map(expireIfStale)
      .filter((job) => (!status || job.status === status) && (!labId || job.target?.labId === labId))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, Math.max(1, Math.min(200, Number(limit) || 25)));
    return jobs.map((job) => summarize(job, productLabel));
  }

  /** Counts of jobs waiting and running, for the portal status. */
  function activity() {
    const jobs = list({ limit: 200 });
    return {
      queued: jobs.filter((j) => j.status === "queued").length,
      active: jobs.filter((j) => j.status === "claimed" || j.status === "running").length,
    };
  }

  /**
   * The most recent job that ended with shots waiting for a sign-in the person has not made yet.
   * `signedInProducts` is what the companion reports: once a product shows up there, its need is gone.
   * Returns `{ jobId, count, products, message }` or null.
   */
  function latestSignInNeed({ signedInProducts = [] } = {}) {
    const signedIn = new Set(signedInProducts);
    const cutoff = now() - SIGN_IN_NEED_MAX_AGE_MS;
    for (const job of list({ limit: 20 })) {
      const needs = job.needsSignIn;
      if (!needs) continue;
      const lastWord = Date.parse(job.finishedAt || job.updatedAt || job.createdAt);
      if (Number.isFinite(lastWord) && lastWord < cutoff) continue;
      const products = needs.products.filter((p) => !signedIn.has(p.id));
      if (!products.length) continue;
      const count = products.reduce((n, p) => n + p.count, 0);
      return {
        jobId: job.id,
        count,
        products,
        message: `Sign in to ${joinNames(products.map((p) => p.label))} on your computer, then retry the ${count} screenshot${count === 1 ? "" : "s"}.`,
      };
    }
    return null;
  }

  /**
   * Give a device its next job. A device that asks again while it still holds
   * an unfinished job gets that job back (a restarted companion resumes it).
   */
  function claimNext(device) {
    if (!existsSync(jobsDir)) return null;
    const all = readdirSync(jobsDir)
      .filter((name) => /^job_[a-f0-9]{16}\.json$/.test(name))
      .map((name) => readJob(name.slice(0, -5)))
      .filter(Boolean)
      .map(expireIfStale);
    const resumable = all.find((job) => (job.status === "claimed" || job.status === "running") && job.claim?.deviceId === device.id);
    let job = resumable;
    if (resumable) {
      resumable.claim.resumes = (resumable.claim.resumes || 0) + 1;
      if (resumable.claim.resumes > MAX_RESUMES) {
        // The same companion keeps asking for this job without finishing a shot. Stop the loop instead of resuming it again.
        for (const shot of resumable.shots) if (!TERMINAL_SHOT_STATUSES.has(shot.status)) shot.status = "cancelled";
        resumable.error = "The companion picked this job up several times without finishing it. Check the companion window for the reason, then queue the capture again.";
        finalize(resumable, "failed", resumable.error);
        job = null;
      }
    }
    if (!job) {
      job = all.filter((j) => j.status === "queued").sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];
      if (!job) return null;
      job.status = "claimed";
      job.claim = { deviceId: device.id, deviceName: cleanText(device.name, 80), claimedAt: iso(), lastActivityAt: iso(), resumes: 0 };
      persist(job, addEvent(job, "claimed", `Picked up by ${job.claim.deviceName || "a companion"}.`));
    } else {
      job.claim.lastActivityAt = iso();
      persist(job, addEvent(job, "resumed", "The companion resumed this job."));
    }
    return { job: summarizeFull(job), plan: getPlan(job.id), resumed: Boolean(job === resumable) };
  }

  function ownedBy(job, deviceId) {
    return Boolean(job && job.claim?.deviceId === deviceId && !TERMINAL_JOB_STATUSES.includes(job.status));
  }

  /** The companion says what it is doing; this updates one shot and the log. */
  function reportProgress(id, deviceId, { shot = null, message = null } = {}) {
    const job = readJob(id);
    if (!job) return { ok: false, status: 404, error: "Job not found." };
    expireIfStale(job);
    if (!ownedBy(job, deviceId)) return { ok: false, status: 409, error: "This job is not assigned to this companion or has already finished." };
    if (job.status === "claimed") {
      job.status = "running";
      job.startedAt = iso();
    }
    job.claim.lastActivityAt = iso();
    let event = null;
    if (shot && SAFE_FILENAME.test(String(shot.filename || ""))) {
      const row = job.shots.find((s) => s.filename === shot.filename);
      const status = SHOT_STATUSES.includes(shot.status) ? shot.status : null;
      if (row && status) {
        const wasTerminal = TERMINAL_SHOT_STATUSES.has(row.status);
        if (!wasTerminal || status === row.status || status === "failed" || status === "auth-required" || status === "needs-account") {
          row.status = status;
        }
        if (status === "running") {
          row.attempts += 1;
          row.startedAt = iso();
        } else if (TERMINAL_SHOT_STATUSES.has(status)) {
          row.finishedAt = iso();
          job.claim.resumes = 0;
        }
        if (shot.error) row.error = status === "needs-account" ? plainText(shot.error, 400) : cleanText(shot.error, 400);
        if (shot.message) row.message = status === "needs-account" ? plainText(shot.message, 300) : cleanText(shot.message, 300);
        // What the companion learned about how it went: the cause, how the screen was reached, and the steps.
        if (typeof shot.cause === "string" && CAUSES[shot.cause]) row.cause = shot.cause;
        if (["auto", "guided", "manual", "autonomous"].includes(shot.mode)) row.mode = shot.mode;
        if (Array.isArray(shot.path)) row.path = shot.path.map((p) => cleanText(p, 60)).filter(Boolean).slice(0, 6);
        if (shot.setup && typeof shot.setup === "object") {
          row.setup = sanitizeSetupEvidence(shot.setup);
          if (shot.setup.failedStep && typeof shot.setup.failedStep === "object") row.setup = { ...row.setup, failedStep: { id: cleanText(shot.setup.failedStep.id, 24), action: cleanText(shot.setup.failedStep.action, 24), note: cleanText(shot.setup.failedStep.note, 120) } };
        }
        if (typeof shot.outcome === "string") row.outcome = cleanText(shot.outcome, 300);
        if (Array.isArray(shot.steps)) row.steps = cleanSteps(shot.steps);
        event = addEvent(job, `shot-${status}`, `${row.filename}: ${cleanText(shot.message || shot.error || status, 300)}`);
      }
    }
    if (message) event = addEvent(job, "info", message);
    persist(job, event);
    return { ok: true, cancelRequested: job.cancelRequested, job: summarizeFull(job) };
  }

  /** Record the outcome of an uploaded image for one shot (`captured`, `needs-review`, or `failed`). */
  function recordShotResult(id, deviceId, filename, { status, verification = null, message = null, error = null }) {
    const job = readJob(id);
    if (!job) return { ok: false, status: 404, error: "Job not found." };
    expireIfStale(job);
    if (!ownedBy(job, deviceId)) return { ok: false, status: 409, error: "This job is not assigned to this companion or has already finished." };
    const row = job.shots.find((s) => s.filename === filename);
    if (!row) return { ok: false, status: 404, error: "That screenshot is not part of this job." };
    if (job.status === "claimed") {
      job.status = "running";
      job.startedAt = iso();
    }
    row.status = status;
    row.finishedAt = iso();
    row.verification = verification;
    row.message = message ? cleanText(message, 300) : null;
    row.error = error ? cleanText(error, 400) : null;
    // How the screen was reached, from what the companion reported with the picture (never from page text).
    const route = verification?.capture;
    if (route?.mode) {
      row.mode = route.mode === "guided" ? "guided" : route.mode === "autonomous" ? "autonomous" : route.mode === "auto" ? "auto" : row.mode;
      row.steps = cleanSteps(route.steps);
      row.setup = route.setup ? sanitizeSetupEvidence(route.setup) : row.setup;
      row.outcome = plainOutcome(row.path, row.steps, route.mode, row.setup);
    }
    const cause = causeForVerification(verification?.reasons);
    row.cause = status === "captured" ? null : cause || (status === "failed" ? "rejected" : null);
    job.claim.lastActivityAt = iso();
    job.claim.resumes = 0;
    const event = addEvent(job, `shot-${status}`, `${filename}: ${cleanText(message || error || status, 300)}`);
    persist(job, event);
    return { ok: true, cancelRequested: job.cancelRequested, job: summarizeFull(job) };
  }

  /** A heartbeat from a companion that is working on a job keeps the claim fresh. */
  function touch(id, deviceId) {
    const job = readJob(id);
    if (!ownedBy(job, deviceId)) return { cancelRequested: false };
    job.claim.lastActivityAt = iso();
    writeJsonAtomic(jobFile(id), job);
    return { cancelRequested: job.cancelRequested };
  }

  /** The companion is done: pick the final state from what happened. */
  function complete(id, deviceId, summary = {}) {
    const job = readJob(id);
    if (!job) return { ok: false, status: 404, error: "Job not found." };
    expireIfStale(job);
    if (!ownedBy(job, deviceId)) return { ok: false, status: 409, error: "This job is not assigned to this companion or has already finished." };
    // Pause is a cancel that keeps the rest of the shots for Resume.
    const pausing = job.pauseRequested === true;
    const paused = summary.paused && typeof summary.paused === "object" ? summary.paused : pausing ? { reason: "stopped", message: "You paused the capture. Select Resume to continue where it stopped." } : null;
    const pausedCause = paused?.reason === "stopped" ? "stopped" : "browser-closed";
    const cancelled = job.cancelRequested && !pausing;
    for (const shot of job.shots) {
      if (!TERMINAL_SHOT_STATUSES.has(shot.status)) {
        // A capture the person paused (closed the window, pressed Stop) is paused, not failed: it can be resumed.
        shot.status = cancelled ? "cancelled" : paused ? "paused" : "skipped";
        if (!cancelled) shot.cause = paused ? pausedCause : "unknown";
        if (paused && !cancelled) shot.message = cleanText(paused.message, 300) || CAUSES[pausedCause].title;
        shot.finishedAt = iso();
      }
    }
    const counts = countShots(job.shots);
    const good = counts.captured + counts.needsReview;
    const needsSignIn = summarizeSignInNeeds(job.shots, productLabel);
    const created = cleanCreated(summary.created);
    const scratch = cleanScratch(summary.scratch);
    const signIn = needsSignIn || counts.failed ? cleanSignIn(summary.signIn) : null;
    // Which account the screenshots came from (flags only), and why a capture stopped before it started.
    const account = cleanAccount(summary.account);
    const stoppedAccount = job.shots.some((s) => s.status === "needs-account") ? cleanNeedsAccount(summary.needsAccount) : null;
    job.result = {
      ...counts,
      partial: good > 0 && good < counts.total,
      message: cleanText(summary.message, 300) || null,
      ...(needsSignIn ? { needsSignIn } : {}),
      ...(created.length ? { created } : {}),
      ...(scratch ? { scratch } : {}),
      ...(signIn ? { signIn } : {}),
      ...(account ? { account } : {}),
      ...(stoppedAccount ? { needsAccount: stoppedAccount } : {}),
      ...(counts.paused ? { paused: counts.paused, pausedReason: pausedCause, resumable: true } : {}),
    };
    // Nothing the companion had to do: every shot was settled when the job was queued (outside the browser, waiting for an address, needs a person).
    const settledAtQueue = counts.failed === 0 && counts.paused === 0;
    if (cancelled) finalize(job, "cancelled", "Canceled. The companion stopped between shots.");
    else if (summary.fatalError) {
      job.error = cleanText(summary.fatalError, 400);
      finalize(job, good > 0 ? "done" : "failed", `The companion stopped early: ${job.error}`);
    } else if (counts.paused) {
      const why = cleanText(paused?.message, 300) || CAUSES[pausedCause].title;
      if (good === 0) job.error = why;
      finalize(job, good > 0 ? "done" : "failed", `Paused. ${counts.captured} captured, ${counts.needsReview} need review, ${counts.paused} paused. ${why}`);
    } else if (good > 0 || counts.total === 0 || counts.manual === counts.total || settledAtQueue) {
      finalize(job, "done", `Finished: ${counts.captured} captured, ${counts.needsReview} need review, ${counts.failed} failed${counts.needsYou ? `, ${counts.needsYou} need you` : ""}${counts.skipped ? `, ${counts.skipped} skipped` : ""}.${needsSignIn ? ` ${needsSignIn.message}` : ""}`);
    } else if (needsSignIn && needsSignIn.count === counts.failed) {
      // Every shot failed for the same reason: the browser was not signed in. Say what to do instead of "failed".
      job.error = needsSignIn.message;
      finalize(job, "failed", `Finished with no new screenshots. ${needsSignIn.message}`);
    } else if (stoppedAccount) {
      // The capture stopped on purpose before the first screenshot: the account was the wrong one. Say so.
      job.error = stoppedAccount.message;
      finalize(job, "failed", `Finished with no new screenshots. ${stoppedAccount.message}`);
    } else {
      finalize(job, "failed", `Finished with no new screenshots: ${counts.failed} failed.`);
    }
    return { ok: true, job: summarizeFull(job) };
  }

  /** Ask for a job to stop. A queued job stops now; a running one stops between shots. With `pause`, the shots not yet captured wait for Resume. */
  function cancel(id, { pause = false } = {}) {
    const job = readJob(id);
    if (!job) return { ok: false, status: 404, error: "Job not found." };
    expireIfStale(job);
    if (TERMINAL_JOB_STATUSES.includes(job.status)) return { ok: false, status: 409, error: "This job has already finished.", job: summarizeFull(job) };
    job.cancelRequested = true;
    if (job.status === "queued") {
      for (const shot of job.shots) if (!TERMINAL_SHOT_STATUSES.has(shot.status)) shot.status = "cancelled";
      finalize(job, "cancelled", "Canceled before a companion picked it up.");
    } else {
      if (pause) job.pauseRequested = true;
      persist(job, addEvent(job, pause ? "pause-requested" : "cancel-requested", pause ? "Pause requested. The companion stops after the current shot, and the rest wait for Resume." : "Cancel requested. The companion stops after the current shot."));
    }
    return { ok: true, job: summarizeFull(job) };
  }

  /** Subscribe to one job's changes (server-sent events). Returns an unsubscribe function. */
  function subscribe(id, listener) {
    emitter.on(id, listener);
    return () => emitter.off(id, listener);
  }

  return { create, get, getPlan, list, activity, latestSignInNeed, claimNext, reportProgress, recordShotResult, touch, complete, cancel, subscribe };
}
