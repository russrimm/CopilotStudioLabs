// Screenshot Center helpers. Pure functions with no DOM access, shared by the
// Screenshot Center (screenshot-center.js), the "Finish your lab" checklist
// (lab-checklist.js), and the saved-lab cards (generated-labs.js).
// Loaded as a classic script: every name is global, so each one starts with "sc".

const SC_DEFAULT_LIMITS = Object.freeze({
  maxUploadBytes: 8 * 1024 * 1024,
  acceptedTypes: Object.freeze(["image/png", "image/jpeg", "image/webp"]),
});
const SC_SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const SC_SAFE_LAB_ID = /^[a-z0-9][a-z0-9-]{0,99}$/i;
const SC_JOB_ID = /^job_[a-f0-9]{16}$/;
const SC_ACTIVE_JOB_STATUSES = Object.freeze(["queued", "claimed", "running"]);
const SC_FINISHED_JOB_STATUSES = Object.freeze(["done", "failed", "cancelled"]);
const SC_ADDRESS_FIELDS = Object.freeze([
  ["copilotStudioUrl", "Copilot Studio"],
  ["powerPlatformEnvUrl", "Power Platform"],
  ["sharepointSiteUrl", "SharePoint site"],
  ["sharepointAdminUrl", "SharePoint admin"],
  ["m365AdminUrl", "Microsoft 365 admin"],
  ["foundryProjectUrl", "Foundry project"],
]);

function scCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function scPlural(n, singular, plural) {
  return `${n} ${n === 1 ? singular : plural || `${singular}s`}`;
}

function scIsActiveJob(job) {
  return Boolean(job) && SC_ACTIVE_JOB_STATUSES.includes(job.status);
}

function scIsFinishedJob(job) {
  return Boolean(job) && SC_FINISHED_JOB_STATUSES.includes(job.status);
}

/** Only https links, never credentials or other schemes. Returns "" when the address is not safe to link. */
function scSafeHttpsUrl(value) {
  if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f<>"`\s]/.test(value.trim())) return "";
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return "";
    return parsed.href;
  } catch {
    return "";
  }
}

function scSafeLearnUrl(value) {
  const href = scSafeHttpsUrl(value);
  return href && /^https:\/\/learn\.microsoft\.com\//i.test(href) ? href : "";
}

/** A same-origin portal path (never a full URL), or the fallback. */
function scSafePortalPath(value, fallback) {
  return typeof value === "string" && /^\/api\/[A-Za-z0-9\-._~/]*$/.test(value) ? value : fallback;
}

function scAssetUrl(labId, filename, version) {
  if (!SC_SAFE_LAB_ID.test(String(labId || "")) || !SC_SAFE_FILENAME.test(String(filename || ""))) return "";
  const base = `/api/lab-builder/generated/${encodeURIComponent(labId)}/assets/${encodeURIComponent(filename)}`;
  return version ? `${base}?v=${encodeURIComponent(String(version).slice(0, 40))}` : base;
}

function scScreenshotApi(labId, filename, suffix = "") {
  return `/api/lab-builder/generated/${encodeURIComponent(labId)}/screenshots/${encodeURIComponent(filename)}${suffix}`;
}

function scProductName(id) {
  const value = String(id || "");
  const known = typeof labBuilder !== "undefined" && Array.isArray(labBuilder?.products) ? labBuilder.products.find((p) => p.id === value) : null;
  if (known) return known.shortName || known.name || value;
  return value
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function scJoinNames(names, max = 3) {
  const list = names.filter(Boolean);
  if (list.length <= max) {
    if (list.length <= 1) return list.join("");
    return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
  }
  return `${list.slice(0, max).join(", ")} and ${list.length - max} more`;
}

function scFormatDuration(totalSeconds) {
  const sec = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

function scTimeAgo(iso, nowMs = Date.now()) {
  const then = Date.parse(iso || "");
  if (!Number.isFinite(then)) return "";
  const sec = Math.max(0, Math.round((nowMs - then) / 1000));
  if (sec < 45) return "just now";
  if (sec < 3600) return `${Math.max(1, Math.round(sec / 60))} min ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)} hr ago`;
  return `${Math.round(sec / 86400)} days ago`;
}

function scCountdown(expiresAt, nowMs = Date.now()) {
  const end = Date.parse(expiresAt || "");
  const seconds = Number.isFinite(end) ? Math.max(0, Math.ceil((end - nowMs) / 1000)) : 0;
  return { seconds, expired: seconds <= 0, text: scFormatDuration(seconds) };
}

// ── Copy confirmations ──────────────────────────────────────────────────────

const SC_COPY_OK_MS = 3000;
// A failure tells the person what to do next, so it stays long enough to read and act on.
const SC_COPY_FAIL_MS = 8000;
const SC_COPY_NOUN = Object.freeze({ "pair-copy-code": "code", "pair-copy-command": "command", "copy-cli": "command" });

/** The words for a finished copy: `text` is shown next to the button, `announce` goes to the live region. */
function scCopyMessage(key, ok) {
  const noun = SC_COPY_NOUN[key] || "command";
  const text = ok ? `${noun === "code" ? "Code" : "Command"} copied to your clipboard` : `Couldn't copy. Select the ${noun} and press Ctrl+C.`;
  return { text, announce: ok ? `${text}.` : text };
}

// ── Honest Microsoft Learn check state ──────────────────────────────────────

/** `not-checked`, `up-to-date`, or `docs-updated`. A lab nobody has checked is never "up-to-date". */
function scCheckStateOf(state) {
  const raw = state?.checkState || state?.summary?.checkState;
  if (raw === "not-checked" || raw === "up-to-date" || raw === "docs-updated") return raw;
  const summary = state?.summary || {};
  if (scCount(summary.stale) > 0 || summary.learnSyncStatus === "docs-updated") return "docs-updated";
  return state?.lastRevalidatedAt || summary.lastRevalidatedAt ? "up-to-date" : "not-checked";
}

function scCheckTone(checkState) {
  return checkState === "up-to-date" ? "ok" : checkState === "docs-updated" ? "warn" : "neutral";
}

function scCheckLabel(checkState, changedCount = 0) {
  if (checkState === "up-to-date") return "Up to date";
  if (checkState === "docs-updated") return `${scPlural(Math.max(1, scCount(changedCount)), "module")} changed`;
  return "Not checked yet";
}

// ── Shot status ─────────────────────────────────────────────────────────────

const SC_STATUS_LABELS = Object.freeze({
  captured: { label: "Captured", tone: "ok" },
  "needs-review": { label: "Needs review", tone: "warn" },
  outdated: { label: "Outdated", tone: "warn" },
  pending: { label: "Pending", tone: "neutral" },
  failed: { label: "Failed", tone: "bad" },
  manual: { label: "Manual", tone: "info" },
  capturing: { label: "Capturing now", tone: "info" },
  queued: { label: "Queued", tone: "info" },
});

/**
 * The one status a screenshot shows: Captured, Needs review, Outdated, Pending, Failed,
 * Manual, and, while a capture job holds it, Capturing now or Queued.
 * @param {object} shot a shot from `GET .../screenshots`
 * @param {string|null} [jobShotStatus] that shot's status in the active job
 * @param {object|null} [attempt] that shot's failed row in the last finished job
 */
function scShotStatus(shot, jobShotStatus = null, attempt = null) {
  let key;
  if (jobShotStatus === "running") key = "capturing";
  else if (jobShotStatus === "pending") key = "queued";
  else if (shot?.needsReview) key = "needs-review";
  else if (!shot?.captured) {
    const last = shot?.lastAttemptStatus;
    if (last === "failed" || last === "auth-required" || last === "browser-unavailable" || attempt) key = "failed";
    else key = shot?.manual ? "manual" : "pending";
  } else key = shot?.stale ? "outdated" : "captured";
  return { key, ...SC_STATUS_LABELS[key] };
}

/** Instruction lines arrive as light Markdown; show them as plain text. */
function scPlainInstruction(line) {
  return String(line ?? "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(?<![\w*])\*([^*\s][^*]*)\*(?![\w*])/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

/** Counts the primary action and the checklist decide from. Manual shots are never auto-captured. */
function scCounts(state) {
  const shots = Array.isArray(state?.shots) ? state.shots : [];
  const counts = { total: shots.length, captured: 0, upToDate: 0, toCapture: 0, manual: 0, outdated: 0, needsReview: 0, failed: 0 };
  if (!shots.length) {
    const s = state?.summary || {};
    counts.total = scCount(s.total);
    counts.captured = scCount(s.captured);
    counts.outdated = scCount(s.stale);
    counts.needsReview = scCount(s.needsReview);
    counts.toCapture = Math.max(0, scCount(s.missing) - counts.needsReview);
    counts.upToDate = Math.max(0, counts.captured - counts.outdated);
    return counts;
  }
  for (const shot of shots) {
    const { key } = scShotStatus(shot);
    if (shot.captured) counts.captured += 1;
    if (key === "captured") counts.upToDate += 1;
    else if (key === "outdated") counts.outdated += 1;
    else if (key === "needs-review") counts.needsReview += 1;
    else if (key === "manual") counts.manual += 1;
    else if (key === "failed") {
      counts.failed += 1;
      if (shot.manual) counts.manual += 1;
      else counts.toCapture += 1;
    } else if (key === "pending") counts.toCapture += 1;
  }
  return counts;
}

// ── Plain-language verification feedback ────────────────────────────────────

function scReasonText(reason, verification = null, limits = SC_DEFAULT_LIMITS) {
  const labels = verification?.labels;
  const megabytes = Math.max(1, Math.round((limits?.maxUploadBytes || SC_DEFAULT_LIMITS.maxUploadBytes) / 1048576));
  switch (reason?.code) {
    case "bad-filename":
      return "This file name cannot be used for a screenshot.";
    case "bad-signature":
      return "This file is not a PNG, JPEG, or WebP image.";
    case "extension-mismatch":
      return "The file type does not match its name. Use a real PNG, JPEG, or WebP image.";
    case "empty":
      return "The file is empty.";
    case "too-large":
      return `The image is larger than ${megabytes} MB. Use a smaller capture.`;
    case "too-small":
      return "The image is tiny (under 5 KB), so it is probably a placeholder or an empty page.";
    case "corrupt":
      return "The image file is damaged and cannot be read.";
    case "truncated":
      return "The image was cut off before it finished saving.";
    case "trailing-data":
      return "The file has extra data after the image, so it was not accepted.";
    case "embedded-markup":
      return "The file contains hidden web code, so it was not accepted.";
    case "dimensions-small":
      return "The image is smaller than 200 by 120 pixels.";
    case "dimensions-large":
      return "The image is larger than 10,000 by 10,000 pixels.";
    case "blank":
      return "The image is blank or a single color. The page may not have loaded.";
    case "near-uniform":
      return "Almost the whole image is one color. The page may not have finished loading.";
    case "not-analyzed":
      return "This image could not be checked automatically. Look at it yourself before you use it.";
    case "sign-in-page":
      return "This looks like the Microsoft sign-in page, not the product.";
    case "not-a-web-page":
      return "The browser was not on a web page when this was taken.";
    case "labels-missing":
      return labels && Number.isFinite(Number(labels.expected)) && Number(labels.expected) > 0
        ? `Only ${scCount(labels.matched)} of ${scCount(labels.expected)} expected labels are visible. Check that this is the screen the lab describes.`
        : "Few of the expected labels are visible. Check that this is the screen the lab describes.";
    case "not-redacted":
      return "Account details may be visible. Check the image for names and email addresses.";
    case "no-page-address":
      return "We could not confirm which page this shows.";
    case "no-evidence":
      return "This image came without page details, so it was checked as a picture only.";
    default:
      return String(reason?.message || "This image needs a closer look.").slice(0, 300);
  }
}

/** `{ level, headline, items: [{ level, text }] }` for a shot's `verification` record. */
function scVerificationSummary(verification, limits = SC_DEFAULT_LIMITS) {
  if (!verification || typeof verification !== "object") return { level: "none", headline: "", items: [] };
  const reasons = Array.isArray(verification.reasons) ? verification.reasons : [];
  const seen = new Set();
  const items = [];
  for (const reason of [...reasons].sort((a, b) => (a.level === "fail" ? 0 : 1) - (b.level === "fail" ? 0 : 1))) {
    const text = scReasonText(reason, verification, limits);
    if (seen.has(text)) continue;
    seen.add(text);
    items.push({ level: reason.level === "fail" ? "fail" : "warn", text });
  }
  const level = verification.level === "fail" || items.some((i) => i.level === "fail") ? "fail" : items.length || verification.level === "warn" ? "warn" : "pass";
  if (verification.redaction?.applied && level !== "fail") {
    items.push({ level: "pass", text: "Account details were hidden before the picture was taken." });
  }
  const headline =
    level === "fail"
      ? "This image cannot be used."
      : level === "warn"
        ? "Please check this image before you use it."
        : "This image passed every check.";
  return { level, headline, items: items.slice(0, 7) };
}

/** Plain sentences for an upload that came back 413, 415, 404, 422, 429, or another error. */
function scUploadErrorText(status, data, limits = SC_DEFAULT_LIMITS) {
  const megabytes = Math.max(1, Math.round((limits?.maxUploadBytes || SC_DEFAULT_LIMITS.maxUploadBytes) / 1048576));
  if (status === 413) return `That image is larger than ${megabytes} MB. Use a smaller capture.`;
  if (status === 415) return "That file type is not supported. Use a PNG, JPEG, or WebP image.";
  if (status === 404) return "This screenshot slot no longer exists in the lab. Reload the lab and try again.";
  if (status === 429) return String(data?.error || "Too many uploads right now. Wait a moment and try again.");
  return String(data?.error || `The upload failed (${status || "no connection"}). Try again.`);
}

function scValidateImageFile(file, limits = SC_DEFAULT_LIMITS) {
  const accepted = Array.isArray(limits?.acceptedTypes) && limits.acceptedTypes.length ? limits.acceptedTypes : SC_DEFAULT_LIMITS.acceptedTypes;
  const max = Number(limits?.maxUploadBytes) > 0 ? Number(limits.maxUploadBytes) : SC_DEFAULT_LIMITS.maxUploadBytes;
  if (!file || !Number.isFinite(Number(file.size))) return { ok: false, message: "No image was found." };
  if (file.size <= 0) return { ok: false, message: "That file is empty." };
  if (!accepted.includes(String(file.type || "").toLowerCase())) return { ok: false, message: "Use a PNG, JPEG, or WebP image." };
  if (file.size > max) {
    return { ok: false, message: `That image is ${(file.size / 1048576).toFixed(1)} MB. The limit is ${Math.round(max / 1048576)} MB.` };
  }
  return { ok: true, message: "" };
}

// ── Grouping and the primary action ─────────────────────────────────────────

/** Shots grouped by module for the gallery, in lab order. */
function scGroupShots(state) {
  const shots = (Array.isArray(state?.shots) ? state.shots : []).filter((s) => s && SC_SAFE_FILENAME.test(String(s.filename || "")));
  const modules = Array.isArray(state?.modules) ? state.modules : [];
  const byFeature = new Map();
  for (const shot of shots) {
    const id = shot.featureId || "__other";
    if (!byFeature.has(id)) byFeature.set(id, []);
    byFeature.get(id).push(shot);
  }
  const groups = [];
  const used = new Set();
  for (const mod of modules) {
    const list = byFeature.get(mod.featureId) || [];
    if (!list.length) continue;
    used.add(mod.featureId);
    groups.push({
      featureId: mod.featureId,
      order: mod.moduleOrder ?? list[0].moduleOrder ?? groups.length + 1,
      stepLabel: mod.stepLabel || list[0].stepLabel || "",
      title: mod.moduleTitle || list[0].moduleTitle || mod.featureId,
      checkState: mod.checkState || (mod.status === "docs-updated" ? "docs-updated" : "not-checked"),
      learnUrl: mod.primaryUrl || "",
      diff: mod.diff || null,
      shots: list,
    });
  }
  for (const [id, list] of byFeature) {
    if (used.has(id)) continue;
    groups.push({
      featureId: id,
      order: list[0].moduleOrder ?? groups.length + 1,
      stepLabel: list[0].stepLabel || "",
      title: list[0].moduleTitle || id,
      checkState: list.some((s) => s.checkState === "docs-updated") ? "docs-updated" : list[0].checkState || "not-checked",
      learnUrl: "",
      diff: null,
      shots: list,
    });
  }
  return groups;
}

/**
 * The one button to show. `model`: counts, checkState, connected, statusLoading, job, and driftedModules.
 * Order: connect, capture missing, retake outdated, review, add by hand, check, then "up to date".
 */
function scPrimaryAction(model) {
  const c = model.counts || {};
  const retakeNeeded = scCount(c.outdated);
  const captureNeeded = scCount(c.toCapture);
  if (scIsActiveJob(model.job)) {
    return { action: "busy", label: "Capturing screenshots", help: "Your computer is working. Progress is shown below.", disabled: true };
  }
  if (model.statusLoading && (captureNeeded || retakeNeeded)) {
    return { action: "wait", label: "Checking your setup", help: "One moment.", disabled: true };
  }
  if ((captureNeeded || retakeNeeded) && !model.connected) {
    return {
      action: "connect",
      label: "Connect your computer",
      help: "One-time setup, about two minutes. After that, screenshots are captured for you.",
      disabled: false,
    };
  }
  if (captureNeeded) {
    return {
      action: "capture-missing",
      label: `Capture ${scPlural(captureNeeded, "missing screenshot")}`,
      help: "Your computer opens each screen, takes the picture, checks it, and adds it to this lab.",
      disabled: false,
    };
  }
  if (retakeNeeded) {
    return {
      action: "capture-stale",
      label: `Retake ${scPlural(retakeNeeded, "outdated screenshot")}`,
      help: "Microsoft Learn changed these topics. New pictures replace the old ones.",
      disabled: false,
    };
  }
  if (scCount(c.needsReview)) {
    return {
      action: "review",
      label: `Review ${scPlural(scCount(c.needsReview), "screenshot")}`,
      help: "These were saved but need a quick look before they go into the lab.",
      disabled: false,
    };
  }
  if (scCount(c.manual)) {
    return {
      action: "manual",
      label: `Add ${scPlural(scCount(c.manual), "screenshot")} by hand`,
      help: "These screens need a person. Take each one yourself, then paste or upload it.",
      disabled: false,
    };
  }
  if (model.checkState === "not-checked") {
    return {
      action: "check",
      label: "Check against Microsoft Learn",
      help: "Looks for documentation changes since this lab was built. Nothing changes until you choose to update.",
      disabled: false,
    };
  }
  if (model.checkState === "docs-updated") {
    return {
      action: "update",
      label: "Update this lab from Microsoft Learn",
      help: "Microsoft Learn changed some topics. This refreshes the steps in your lab.",
      disabled: false,
    };
  }
  return {
    action: "done",
    label: scCount(c.total) ? "All screenshots up to date" : "No screenshots needed",
    help: "Nothing to do. You can check again any time under Advanced options.",
    disabled: true,
  };
}

// ── Readiness steps ─────────────────────────────────────────────────────────

/** The tenant addresses a lab or profile has, as readable names. */
function scAddressNames(brand) {
  const names = [];
  for (const [field, label] of SC_ADDRESS_FIELDS) {
    if (scSafeHttpsUrl(brand?.[field])) names.push(label);
  }
  return names;
}

/**
 * The three setup steps and their live state.
 * @param {object} m `statusLoading`, `statusError`, `connected`, `deviceNames`, `signedIn`, `products`, `needsComputer`, `tenant`
 */
function scBuildSteps(m) {
  const tenant = m.tenant || { names: [], serverSet: false, suggestion: null };
  const connect = { id: "connect", title: "Connect this computer", state: "todo", detail: "", action: null };
  if (m.statusLoading) {
    connect.state = "loading";
    connect.detail = "Checking your setup.";
  } else if (m.statusError) {
    connect.state = "error";
    connect.detail = "We could not check your setup. Try again in a moment.";
    connect.action = { id: "retry-status", label: "Try again" };
  } else if (m.connected) {
    connect.state = "done";
    const names = (m.deviceNames || []).filter(Boolean);
    connect.detail = names.length ? `Connected: ${scJoinNames(names, 2)}.` : "Your computer is connected.";
    connect.action = { id: "pair-another", label: "Add another computer" };
  } else {
    connect.detail = "Not connected yet. A small app on your computer takes the screenshots for you.";
    // The big button below says the same thing, so the step only repeats it when that button is busy with something else.
    if (m.primaryAction !== "connect") connect.action = { id: "connect", label: "Connect your computer" };
  }

  const addresses = { id: "tenant", title: "Add your tenant addresses", state: "optional", detail: "", action: null };
  if (tenant.names.length) {
    addresses.state = "done";
    addresses.detail = `${tenant.names.length} of ${SC_ADDRESS_FIELDS.length} addresses are set: ${scJoinNames(tenant.names, 3)}.`;
    addresses.action = { id: "edit-addresses", label: "Change addresses" };
  } else if (tenant.suggestion) {
    addresses.detail = `Your ${tenant.suggestion.name} profile has ${scPlural(tenant.suggestion.names.length, "address", "addresses")}. Use them for this lab.`;
    addresses.action = { id: "use-profile", label: "Use these addresses", profileId: tenant.suggestion.id };
  } else if (tenant.serverSet) {
    addresses.state = "done";
    addresses.detail = "Your portal administrator already set default addresses.";
  } else {
    addresses.detail = "Optional. Add your Copilot Studio, Power Platform, or SharePoint addresses so screenshots show your own tenant.";
    addresses.action = { id: "add-addresses", label: "Add addresses" };
  }

  const signIn = { id: "signin", title: "Sign in once per product", state: "todo", detail: "", action: null };
  const products = m.products || [];
  const signedIn = new Set(m.signedIn || []);
  if (!m.connected) {
    signIn.state = "locked";
    signIn.detail = "Connect your computer first.";
  } else if (!products.length) {
    signIn.state = "done";
    signIn.detail = "No sign-in is needed for this lab.";
  } else {
    const missing = products.filter((p) => !signedIn.has(p.id));
    const names = (list) => scJoinNames(list.map((p) => p.name), 3);
    if (!missing.length) {
      signIn.state = "done";
      signIn.detail = `Signed in to ${names(products)}.`;
    } else {
      const have = products.filter((p) => signedIn.has(p.id));
      signIn.detail =
        `${have.length ? `Signed in to ${names(have)}. ` : ""}Still to sign in: ${names(missing)}. ` +
        "The first time, a browser window opens on your computer. Sign in there and capture continues by itself.";
    }
  }
  return [connect, addresses, signIn];
}

// ── Job progress ────────────────────────────────────────────────────────────

function scProgressFromShots(shots) {
  const counts = { total: 0, done: 0, captured: 0, needsReview: 0, failed: 0, manual: 0, skipped: 0, running: 0, pending: 0, cancelled: 0 };
  for (const shot of Array.isArray(shots) ? shots : []) {
    counts.total += 1;
    switch (shot.status) {
      case "captured": counts.captured += 1; break;
      case "needs-review": counts.needsReview += 1; break;
      case "failed":
      case "auth-required": counts.failed += 1; break;
      case "manual-required": counts.manual += 1; break;
      case "skipped": counts.skipped += 1; break;
      case "cancelled": counts.cancelled += 1; break;
      case "running": counts.running += 1; break;
      default: counts.pending += 1;
    }
  }
  counts.done = counts.total - counts.running - counts.pending;
  counts.percent = counts.total ? Math.round((counts.done / counts.total) * 100) : 100;
  return counts;
}

/**
 * Fold a server-sent `update` (`{ job: summary, event }`) into the job we already hold.
 * The summary has no shot list, so the event's file name moves one shot.
 */
function scMergeJobUpdate(job, update) {
  const summary = update?.job && typeof update.job === "object" ? update.job : {};
  const merged = { ...(job || {}), ...summary };
  merged.shots = Array.isArray(summary.shots) ? summary.shots : Array.isArray(job?.shots) ? job.shots.map((s) => ({ ...s })) : [];
  merged.events = Array.isArray(job?.events) ? job.events.slice(-60) : [];
  const event = update?.event;
  if (event && typeof event === "object") {
    merged.events.push(event);
    const match = /^shot-([a-z-]+)$/.exec(String(event.type || ""));
    const filename = /^([A-Za-z0-9][A-Za-z0-9._-]{0,120}):/.exec(String(event.message || ""))?.[1];
    if (match && filename) {
      const row = merged.shots.find((s) => s.filename === filename);
      if (row) row.status = match[1];
    }
  }
  if (!summary.progress && merged.shots.length) merged.progress = scProgressFromShots(merged.shots);
  return merged;
}

/**
 * What a job is doing, in words a person can act on.
 * @returns {{ phase: string, percent: number, counts: object, currentFilename: string|null, headline: string, detail: string, tone: string }}
 */
function scDescribeJob(job, { companionConnected = null, nowMs = Date.now(), onlineWindowSec = 90 } = {}) {
  const counts = job?.progress && typeof job.progress.total === "number" ? job.progress : scProgressFromShots(job?.shots);
  const shots = Array.isArray(job?.shots) ? job.shots : [];
  const current = shots.find((s) => s.status === "running") || shots.find((s) => s.status === "pending") || null;
  const base = { percent: scCount(counts.percent), counts, currentFilename: current?.filename || null };
  const total = scCount(counts.total);

  if (job?.status === "done") {
    const parts = [`${scCount(counts.captured)} captured`];
    if (scCount(counts.needsReview)) parts.push(`${scCount(counts.needsReview)} need review`);
    if (scCount(counts.failed)) parts.push(`${scCount(counts.failed)} failed`);
    if (scCount(counts.manual)) parts.push(`${scCount(counts.manual)} need to be added by hand`);
    return { ...base, phase: "done", tone: scCount(counts.failed) || scCount(counts.needsReview) ? "warn" : "ok", headline: "Capture finished", detail: `${parts.join(", ")}.` };
  }
  if (job?.status === "cancelled") {
    return { ...base, phase: "cancelled", tone: "neutral", headline: "Capture canceled", detail: `${scCount(counts.captured)} of ${total} were captured before you stopped it.` };
  }
  if (job?.status === "failed") {
    return {
      ...base,
      phase: "failed",
      tone: "bad",
      headline: "Capture did not finish",
      detail: String(job.error || "Your computer stopped before any screenshot was captured. Check that the companion is running, then try again.").slice(0, 300),
    };
  }
  if (job?.cancelRequested) {
    return { ...base, phase: "cancelling", tone: "neutral", headline: "Canceling", detail: "Your computer stops after the screenshot it is working on." };
  }
  if (job?.status === "queued") {
    if (companionConnected === false) {
      return {
        ...base,
        phase: "queued-offline",
        tone: "warn",
        headline: "Waiting for your computer",
        detail: "No computer is connected right now. Start the companion on your computer, or connect it again. This capture starts as soon as it checks in.",
      };
    }
    return { ...base, phase: "queued", tone: "info", headline: "Waiting for your computer to pick this up", detail: "This usually takes a few seconds." };
  }
  const lastActivity = Date.parse(job?.claim?.lastActivityAt || job?.claim?.claimedAt || "");
  if (Number.isFinite(lastActivity) && nowMs - lastActivity > onlineWindowSec * 1000) {
    return {
      ...base,
      phase: "offline",
      tone: "warn",
      headline: "Your computer stopped responding",
      detail: "Check that the companion is still running and that the computer is awake. If it comes back, capture continues. You can also cancel and queue the rest again.",
    };
  }
  if (shots.some((s) => s.status === "auth-required")) {
    return {
      ...base,
      phase: "auth-required",
      tone: "warn",
      headline: "Sign-in needed on your computer",
      detail: "A browser window should be open on your computer. Sign in there. Capture continues by itself, and any screenshot that was skipped can be retaken afterward.",
    };
  }
  return {
    ...base,
    phase: job?.status === "claimed" ? "starting" : "running",
    tone: "info",
    headline: job?.status === "claimed" ? "Your computer is getting ready" : "Capturing screenshots",
    detail: "Keep the browser window your computer opened until this finishes.",
  };
}

/** The result banner shown after a job ends. */
function scOutcomeFromJob(job) {
  const view = scDescribeJob(job);
  const counts = view.counts;
  let variant = "ok";
  if (view.phase === "failed") variant = "error";
  else if (view.phase === "cancelled" || view.tone === "warn") variant = "warn";
  const message =
    view.phase === "done"
      ? `Capture finished: ${view.detail}`
      : view.phase === "cancelled"
        ? `Capture canceled. ${view.detail}`
        : `${view.headline}. ${view.detail}`;
  const failedFiles = (Array.isArray(job?.shots) ? job.shots : []).filter((s) => s.status === "failed" || s.status === "auth-required").map((s) => s.filename);
  const actions = [];
  if (failedFiles.length) actions.push({ id: "retry-failed", label: `Retry ${scPlural(failedFiles.length, "screenshot")}`, filenames: failedFiles });
  if (scCount(counts.needsReview)) actions.push({ id: "review", label: `Review ${scPlural(scCount(counts.needsReview), "screenshot")}` });
  return { type: "job", variant, message, jobId: job?.id || null, actions };
}

/** Plain explanation for why a build did not queue a capture. */
function scBuildCaptureOutcome(data) {
  if (!data) return null;
  const requested = Boolean(data.screenshotCapture) || data.captureQueued !== undefined;
  if (data.captureQueued && SC_JOB_ID.test(String(data.captureJobId || ""))) {
    return { type: "build-capture", variant: "ok", message: "Your lab is built. Screenshots are being captured on your computer now.", jobId: data.captureJobId, actions: [] };
  }
  if (!requested || !data.captureReason) return null;
  const messages = {
    "no-companion": "Your lab is built, but your computer is not connected, so no screenshots were captured. Connect it here to capture them.",
    "nothing-to-capture": "Your lab is built. Every screenshot already exists, so there was nothing to capture.",
  };
  return {
    type: "build-capture",
    variant: "warn",
    message: messages[data.captureReason] || "Your lab is built, but the screenshots could not be queued. You can capture them from here.",
    jobId: null,
    actions: [],
  };
}
