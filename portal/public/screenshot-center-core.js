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

const SC_TARGET_FIELD_ID = /^[A-Za-z][A-Za-z0-9]{0,40}$/;
const SC_REQUIREMENT_ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
const SC_CAUSE_CODE = /^[a-z][a-z-]{0,30}$/;
const SC_CAUSE_FIX_ACTIONS = Object.freeze(["settings", "retry", "guided", "resume", "upload", "record", "consent", "account"]);
// Causes that mean "an address is missing": their screenshots wait for the person, they did not fail.
const SC_ADDRESS_CAUSES = Object.freeze(["no-agent", "no-site", "no-address"]);

function scCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function scPlural(n, singular, plural) {
  return `${n} ${n === 1 ? singular : plural || `${singular}s`}`;
}

/** Text from the network: one line, trimmed, and never longer than `max`. */
function scText(value, max = 300) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function scSentenceCase(text) {
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : "";
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

// ── Capture modes ───────────────────────────────────────────────────────────

// Automatic is the way captures run now: the computer sets every screen up itself. The other choices stay under Advanced.
const SC_CAPTURE_MODES = Object.freeze([
  { id: "autonomous", label: "Automatic (recommended)", help: "The computer sets up and captures every screen itself, including test conversations, dialogs, and Agent Builder, so there is nothing to do after you sign in once.", advanced: false },
  { id: "autonomous-readonly", label: "Automatic, read-only (never creates anything)", help: "The same, but it never creates a practice agent, even if you allowed one.", advanced: false },
  { id: "guided", label: "I will set up each screen", help: "The computer opens the closest page and waits while you set up the screen and capture it.", advanced: true },
  { id: "smart", label: "Smart", help: "The computer captures what it can by address and asks you for the screens that need setup.", advanced: true },
  { id: "auto", label: "Only what needs no setup", help: "The computer opens each screen by its address and skips any screen that needs setup.", advanced: true },
]);
const SC_DEFAULT_CAPTURE_MODE = "autonomous";
// How one screenshot is captured, as the server classified it.
const SC_SHOT_MODES = Object.freeze({
  auto: { label: "Automatic", tone: "info" },
  autonomous: { label: "Automatic", tone: "info" },
  guided: { label: "You set it up", tone: "neutral" },
  manual: { label: "Outside the browser", tone: "neutral" },
});

function scCaptureModeOf(value) {
  return SC_CAPTURE_MODES.some((mode) => mode.id === value) ? value : SC_DEFAULT_CAPTURE_MODE;
}

/** Whether a mode choice runs the computer on its own. */
function scIsAutomaticMode(value) {
  return value === "autonomous" || value === "autonomous-readonly";
}

/** The `options` a mode choice sends: Automatic, read-only is Automatic with a lower ceiling. */
function scModeRequest(value) {
  const mode = scCaptureModeOf(value);
  if (mode === "autonomous-readonly") return { mode: "autonomous", autonomy: { level: "read-only" } };
  return { mode };
}

/** The `capture` descriptor of a shot, trimmed to what the Center shows. Null when the server sent none. */
function scShotCapture(shot) {
  const capture = shot?.capture;
  if (!capture || typeof capture !== "object" || !SC_SHOT_MODES[capture.mode]) return null;
  const list = (value) => (Array.isArray(value) ? value.map((item) => scText(item, 80)).filter(Boolean) : []);
  return {
    mode: capture.mode,
    why: scText(capture.why),
    path: list(capture.path).slice(0, 6),
    missing: list(capture.missing),
    screenLabel: scText(capture.screen?.label, 120),
    summary: (Array.isArray(capture.setup?.summary) ? capture.setup.summary : []).map((item) => scText(item, 120)).filter(Boolean).slice(0, 8),
    needsPractice: capture.setup?.needsPractice === true,
  };
}

// ── Automatic capture: consent and the report ───────────────────────────────

/** What the server says about automatic capture (`status.autonomy`), trimmed to what the Center shows. */
function scConsentModel(autonomy) {
  const rules = autonomy?.rules && typeof autonomy.rules === "object" ? autonomy.rules : {};
  const never = (Array.isArray(rules.never) ? rules.never : []).map((item) => scText(item, 200)).filter(Boolean);
  const tiers = (Array.isArray(rules.tiers) ? rules.tiers : []).map((tier) => ({ tier: scCount(tier?.tier), label: scText(tier?.label, 40), summary: scText(tier?.summary, 300), examples: (Array.isArray(tier?.examples) ? tier.examples : []).map((e) => scText(e, 120)).filter(Boolean) }));
  return {
    loaded: Boolean(autonomy),
    consented: autonomy?.consented === true,
    level: autonomy?.level === "practice" ? "practice" : autonomy?.level === "read-only" ? "read-only" : null,
    practiceEnvironmentUrl: scSafeHttpsUrl(autonomy?.practiceEnvironmentUrl || ""),
    companionSupported: autonomy?.companionSupported !== false,
    minCompanion: scText(autonomy?.minCompanion, 20) || "1.4.0",
    never: never.length ? never : SC_NEVER_FALLBACK,
    tiers,
  };
}

const SC_NEVER_FALLBACK = Object.freeze([
  "Sign out, switch accounts, or sign in for you",
  "Delete or remove anything, including cleaning up after itself",
  "Share an agent, invite people, or send a message or email to anyone",
  "Publish to a channel such as Teams or a website",
  "Change tenant, environment, admin, billing, licensing, security, data policy, or permission settings",
  "Install or consent to apps, or create connections with credentials",
  "Upload or download your files",
  "Touch any agent that is not its own practice agent, or leave the Microsoft product sites",
]);

/** The one line that says whether the computer may capture on its own, and how far. */
function scAutonomyLine(consent) {
  if (!consent.loaded) return { state: "loading", text: "Checking automatic capture." };
  if (!consent.consented) return { state: "off", text: "Automatic capture is off. Allow it once and the computer sets up every screen by itself." };
  if (consent.level === "practice") return { state: "practice", text: "Automatic capture is on. It may also create one practice agent in your practice environment, and it lists what it made." };
  return { state: "readonly", text: "Automatic capture is on and read-only. It opens screens and tries things that change nothing, and it never creates anything." };
}

// ── Which account the screenshots come from ─────────────────────────────────

const SC_BROWSER_NAMES = Object.freeze({ edge: "Edge", chrome: "Chrome", chromium: "Chromium" });
const SC_ACCOUNT_SOURCES = Object.freeze(["windows-sso", "manual", "saved-session", "unknown"]);
const SC_ACCOUNT_SETUP_STATES = Object.freeze(["requested", "waiting-for-you", "done", "needs-account", "failed"]);
const SC_VERIFIED_FOR = Object.freeze(["agent", "environment", "site", "project"]);
const SC_ACCOUNT_FIX = Object.freeze({ id: "account-setup", label: "Choose which account to use" });

/** The yes/no facts the companion reports about its account (never a name, a tenant, or an address), trimmed to what the Center shows. */
function scAccountFacts(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    mode: raw.mode === "windows" ? "windows" : "separate",
    source: SC_ACCOUNT_SOURCES.includes(raw.source) ? raw.source : "unknown",
    verified: raw.verified === true,
    verifiedFor: SC_VERIFIED_FOR.includes(raw.verifiedFor) ? raw.verifiedFor : "",
    osWorkAccountDetected: typeof raw.osWorkAccountDetected === "boolean" ? raw.osWorkAccountDetected : null,
    browser: SC_BROWSER_NAMES[raw.browser] ? raw.browser : "",
    inOsTenant: typeof raw.inOsTenant === "boolean" ? raw.inOsTenant : null,
    inPrivate: raw.inPrivate === true,
  };
}

/** A sentence from the companion with anything shaped like an address, an account, or an id taken out, so the page can never show one. */
function scWithoutIds(text) {
  return String(text ?? "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, "")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** How the last "Choose which account to use" is going on the computer, in a sentence. */
function scAccountSetupLine(raw) {
  if (!raw || typeof raw !== "object" || !SC_ACCOUNT_SETUP_STATES.includes(raw.state)) return null;
  const said = scWithoutIds(scText(raw.message, 300));
  const fallback = {
    requested: "Waiting for your computer to open the sign-in window.",
    "waiting-for-you": "Sign in in the browser window on your computer, with the account you want. You choose the account yourself.",
    done: "The account is chosen and saved.",
    "needs-account": "That account does not fit your addresses. Choose which account to use and try again.",
    failed: "The account could not be chosen. Try again.",
  };
  return { state: raw.state, busy: raw.state === "requested" || raw.state === "waiting-for-you", text: said || fallback[raw.state] };
}

/**
 * The one line that says which account the computer will use, with its tone and the one-click fix.
 * `null` until a computer is connected. A companion from before account checks says nothing, and that is said plainly.
 * @param {object|null} companion `status.companion`
 */
function scAccountModel(companion) {
  if (!companion || companion.connected !== true) return null;
  const setup = scAccountSetupLine(companion.accountSetup);
  const facts = scAccountFacts(companion.account);
  const supported = companion.accountSupported !== false;
  const min = scText(companion.accountMinCompanion, 20) || "1.5.0";
  if (!facts) {
    return {
      state: "not-reported",
      tone: "neutral",
      text: "Account not reported (update the companion)",
      help: `Your Local Capture Companion is older than ${min}, so it cannot say which account it uses. Download it again and replace the old one. Until then, start it with --browser=chromium so a screenshot is not taken with your Windows work account.`,
      fix: null,
      setup,
      facts: null,
    };
  }
  const where = `browser: ${SC_BROWSER_NAMES[facts.browser] || "unknown"}${facts.inPrivate ? ", InPrivate" : ""}`;
  const fix = supported ? SC_ACCOUNT_FIX : null;
  if (facts.source === "windows-sso") {
    return {
      state: "windows-account",
      tone: "warn",
      text: `Account: your Windows work account (${SC_BROWSER_NAMES[facts.browser] || "browser"} single sign-on). Screenshots will come from that account.`,
      help: "If you want your demo tenant instead, choose which account to use and sign in with it yourself. Starting the companion with --browser=chromium also avoids this.",
      fix,
      setup,
      facts,
    };
  }
  const same = facts.inOsTenant === true;
  if (facts.verified) {
    const checked = facts.verifiedFor ? `verified for your ${facts.verifiedFor}` : "confirmed by you";
    const lead = facts.mode === "windows" ? `Account: the account you signed in with, with your Windows work account allowed (${where}), ${checked}.` : `Account: separate sign-in (${where}), ${checked}.`;
    return {
      state: same ? "same-as-windows" : "verified",
      tone: same ? "warn" : "ok",
      text: same ? `${lead} It is the same account Windows uses for work.` : lead,
      help: same ? "Screenshots will come from your Windows work account. If you want another account, choose it and sign in yourself." : "",
      fix: same ? fix : null,
      setup,
      facts,
    };
  }
  return {
    state: "unverified",
    tone: same ? "warn" : "neutral",
    text: `Account: separate sign-in (${where}). Account not verified.${same ? " It is the same account Windows uses for work." : ""}`,
    help: "Add your agent address in the capture settings so it can be checked each time, or choose the account once. Automatic capture waits until the account is chosen.",
    fix,
    setup,
    facts,
  };
}

/** The same line without its "Account:" lead, for a sentence that already says what it is (the consent card). */
function scAccountSentence(model) {
  if (!model) return "";
  return String(model.text).replace(/^Account:\s*/i, "").replace(/^Account not reported/i, "an account that is not reported");
}

const SC_UNFINISHED_CAUSES = Object.freeze(["automation-failed", "blocked-by-safety", "unexpected-effect", "needs-you"]);
// The causes where the computer tried and could not finish: only these get "Show me once".
const SC_AUTOMATION_CAUSES = Object.freeze(["automation-failed", "blocked-by-safety", "unexpected-effect"]);

/**
 * The outcome of a finished automatic capture, grouped the way a person thinks about it: how many are done, how many wait
 * for review, how many need a practice agent, and how many the computer could not finish (with the step it stopped at).
 */
function scAutomaticReport(job) {
  const rows = Array.isArray(job?.shots) ? job.shots : [];
  const report = { captured: 0, review: 0, practice: 0, unfinished: [], skipped: 0, manual: 0, paused: 0, failed: 0, total: rows.length, created: [] };
  for (const row of rows) {
    const needsPractice = row.cause === "needs-practice-agent" || row.setup?.limitedBy === "practice-agent";
    if (row.status === "captured") report.captured += 1;
    else if (row.status === "needs-review") {
      if (needsPractice) report.practice += 1;
      else report.review += 1;
    } else if (row.status === "needs-you" || (row.status === "failed" && SC_UNFINISHED_CAUSES.includes(row.cause))) {
      report.unfinished.push({ filename: String(row.filename || ""), step: scText(row.setup?.failedStep?.note, 120), cause: scText(row.cause, 30) });
    } else if (row.status === "failed" || row.status === "auth-required" || row.status === "needs-account") report.failed += 1;
    else if (row.status === "skipped") report.skipped += 1;
    else if (row.status === "manual-required") report.manual += 1;
    else if (row.status === "paused") report.paused += 1;
  }
  report.created = (Array.isArray(job?.result?.created) ? job.result.created : []).map((item) => ({ kind: item?.kind === "agent" ? "agent" : "change", name: scText(item?.name, 80), what: scText(item?.what, 120), reused: item?.reused === true })).filter((item) => item.what);
  return report;
}

/** "36 captured, 4 saved for your review, 2 need a practice agent, 1 could not be completed: Opened Add knowledge." */
function scAutomaticReportText(report) {
  const parts = [`${report.captured} captured`];
  if (report.review) parts.push(`${report.review} saved for your review`);
  if (report.practice) parts.push(`${report.practice} need a practice agent`);
  if (report.unfinished.length) {
    const first = report.unfinished[0].step;
    parts.push(`${report.unfinished.length} could not be completed${first ? `: ${first}` : ""}`);
  }
  if (report.failed) parts.push(`${report.failed} failed`);
  if (report.skipped) parts.push(`${report.skipped} skipped`);
  if (report.manual) parts.push(`${report.manual} need to be added by hand`);
  if (report.paused) parts.push(`${report.paused} paused`);
  return `${parts.join(", ")}.`;
}

// ── Shot status ─────────────────────────────────────────────────────────────

const SC_STATUS_LABELS = Object.freeze({
  captured: { label: "Captured", tone: "ok" },
  "needs-review": { label: "Needs review", tone: "warn" },
  "needs-you": { label: "Needs you", tone: "warn" },
  paused: { label: "Paused", tone: "info" },
  outdated: { label: "Outdated", tone: "warn" },
  pending: { label: "Pending", tone: "neutral" },
  failed: { label: "Failed", tone: "bad" },
  manual: { label: "Manual", tone: "info" },
  capturing: { label: "Capturing now", tone: "info" },
  queued: { label: "Queued", tone: "info" },
});
// The job rows that say why a screenshot is still missing after a capture.
const SC_ATTEMPT_STATUSES = Object.freeze(["failed", "auth-required", "needs-account", "needs-you", "paused", "skipped"]);

/**
 * The one status a screenshot shows: Captured, Needs review, Needs you, Paused, Outdated, Pending,
 * Failed, Manual, and, while a capture job holds it, Capturing now or Queued.
 * @param {object} shot a shot from `GET .../screenshots`
 * @param {string|null} [jobShotStatus] that shot's status in the active job
 * @param {object|null} [attempt] that shot's row in a capture job that ended without capturing it
 */
function scShotStatus(shot, jobShotStatus = null, attempt = null) {
  let key;
  if (jobShotStatus === "running") key = "capturing";
  else if (jobShotStatus === "pending") key = "queued";
  else if (shot?.needsReview) key = "needs-review";
  else if (!shot?.captured) {
    const last = attempt?.status ?? shot?.lastAttemptStatus;
    if (last === "needs-you" || last === "paused") key = last;
    else if (last === "failed" || last === "auth-required" || last === "needs-account" || last === "browser-unavailable") key = "failed";
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

/**
 * Counts the primary action and the checklist decide from. Manual shots are never auto-captured.
 * @param {object} state `GET .../screenshots`
 * @param {(filename: string) => object|null} [attemptFor] a job row that says why a screenshot is still missing
 */
function scCounts(state, attemptFor = null) {
  const shots = Array.isArray(state?.shots) ? state.shots : [];
  const counts = { total: shots.length, captured: 0, upToDate: 0, toCapture: 0, manual: 0, outdated: 0, needsReview: 0, failed: 0, needsYou: 0, paused: 0 };
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
    const { key } = scShotStatus(shot, null, shot.captured ? null : attemptFor?.(shot.filename) ?? null);
    if (shot.captured) counts.captured += 1;
    if (key === "captured") counts.upToDate += 1;
    else if (key === "outdated") counts.outdated += 1;
    else if (key === "needs-review") counts.needsReview += 1;
    else if (key === "manual") counts.manual += 1;
    else if (key === "needs-you") {
      counts.needsYou += 1;
      counts.toCapture += 1;
    } else if (key === "paused") {
      counts.paused += 1;
      counts.toCapture += 1;
    } else if (key === "failed") {
      counts.failed += 1;
      if (shot.manual) counts.manual += 1;
      else counts.toCapture += 1;
    } else if (key === "pending") counts.toCapture += 1;
  }
  return counts;
}

// ── Plain-language verification feedback ────────────────────────────────────

const SC_WRONG_SCREEN = "This is not the screen the lab asks for. Check that it is the screen the lab describes.";

/** "This is the Copilot Studio home page, not the agent's Instructions page." when the browser ended on another screen. */
function scLandingSentence(verification) {
  const landing = verification?.landing;
  const reasons = Array.isArray(verification?.reasons) ? verification.reasons : [];
  if (landing?.state !== "mismatch" && !reasons.some((reason) => reason?.code === "wrong-screen")) return "";
  const page = scText(landing?.page, 120);
  const expected = scText(landing?.expected, 120);
  return page && expected ? `This is ${page}, not ${expected}.` : SC_WRONG_SCREEN;
}

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
    case "wrong-screen":
      return scLandingSentence(verification) || SC_WRONG_SCREEN;
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
 * The one button to show. `model`: counts, checkState, connected, statusLoading, job, driftedModules, and
 * addressWaiting (how many screenshots are held back until an address is added).
 * Order: connect, capture missing, retake outdated, review, add by hand, check, then "up to date".
 */
function scPrimaryAction(model) {
  const c = model.counts || {};
  const retakeNeeded = scCount(c.outdated);
  const captureNeeded = scCount(c.toCapture);
  const waiting = scCount(model.addressWaiting);
  const waitingNote = waiting ? ` ${scPlural(waiting, "screenshot")} ${waiting === 1 ? "is" : "are"} waiting for an address and will be held back until you add it.` : "";
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
    const automatic = scIsAutomaticMode(model.mode);
    return {
      action: "capture-missing",
      label: automatic ? "Capture all screenshots automatically" : `Capture ${scPlural(captureNeeded, "missing screenshot")}`,
      help: automatic
        ? `Your computer sets up every screen itself and takes the picture, then checks it. There is nothing to do after you sign in once.${waitingNote}`
        : `Your computer opens each screen, takes the picture, checks it, and adds it to this lab.${waitingNote}`,
      disabled: false,
    };
  }
  if (retakeNeeded) {
    return {
      action: "capture-stale",
      label: scIsAutomaticMode(model.mode) ? `Retake ${scPlural(retakeNeeded, "outdated screenshot")} automatically` : `Retake ${scPlural(retakeNeeded, "outdated screenshot")}`,
      help: `Microsoft Learn changed these topics. New pictures replace the old ones.${waitingNote}`,
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

// ── Capture settings: what each screenshot needs ────────────────────────────

/**
 * One thing the person has to add before screenshots can be captured, from the capture settings
 * (`requirement`) or from a queue request that was held back (`missing` item). Null when it is unusable.
 */
function scRequirementView(requirement) {
  const id = String(requirement?.id || "");
  if (!SC_REQUIREMENT_ID.test(id)) return null;
  const filenames = (Array.isArray(requirement.filenames) ? requirement.filenames : []).filter((name) => SC_SAFE_FILENAME.test(String(name)));
  const count = scCount(requirement.waitingCount ?? requirement.count) || filenames.length;
  const noun = scText(requirement.noun, 80) || "address";
  return {
    id,
    noun,
    count,
    filenames,
    prompt: scText(requirement.prompt),
    fields: (Array.isArray(requirement.fields) ? requirement.fields : []).filter((field) => SC_TARGET_FIELD_ID.test(String(field))),
    message: scText(requirement.message, 200) || `${scPlural(count, "screenshot")} ${count === 1 ? "needs" : "need"} your ${noun}.`,
  };
}

/** The requirements still to meet. A refused queue request (`queued`) is newer than the saved settings payload. */
function scMissingRequirements(targets, queued) {
  const source = Array.isArray(queued) && queued.length ? queued : Array.isArray(targets?.missing) ? targets.missing : [];
  return source.map(scRequirementView).filter((view) => view && view.count > 0);
}

/** `Agent address: needed by 4 screenshots. SharePoint site address: needed by 8 screenshots.` */
function scMissingSummary(views) {
  return `${views.map((view) => `${scSentenceCase(view.noun)}: needed by ${scPlural(view.count, "screenshot")}`).join(". ")}.`;
}

/** Every capture setting from the payload, with only the text the Center shows. */
function scTargetFields(targets) {
  return (Array.isArray(targets?.fields) ? targets.fields : [])
    .filter((field) => SC_TARGET_FIELD_ID.test(String(field?.id)))
    .map((field) => ({
      id: field.id,
      label: scText(field.label, 120) || field.id,
      kind: field.kind === "url" ? "url" : "text",
      product: /^[a-z0-9-]{1,60}$/.test(String(field.product)) ? field.product : "other",
      placeholder: scText(field.placeholder, 200),
      help: scText(field.help),
      value: typeof field.value === "string" ? field.value.slice(0, 2048) : "",
      set: field.set === true,
      sourceLabel: scText(field.sourceLabel, 80).replace(/^from\s+/i, ""),
    }));
}

/** A setting the capture settings do not list (a refused queue request can arrive first), described from its requirement. */
function scFallbackField(fieldId, requirement) {
  const isName = /Name$/.test(fieldId);
  const base = requirement.noun.replace(/\s*(address|name)$/i, "");
  return {
    id: fieldId,
    label: scSentenceCase([base, isName ? "name" : "address"].filter(Boolean).join(" ")),
    kind: isName ? "text" : "url",
    product: "other",
    placeholder: "",
    help: "",
    value: "",
    set: false,
    sourceLabel: "",
  };
}

/** Settings grouped by product, in the order the server lists them. */
function scGroupTargetFields(fields) {
  const groups = new Map();
  for (const field of fields) {
    if (!groups.has(field.product)) groups.set(field.product, { product: field.product, name: field.product === "other" ? "Other" : scProductName(field.product), fields: [] });
    groups.get(field.product).fields.push(field);
  }
  return [...groups.values()];
}

// ── Failure groups ──────────────────────────────────────────────────────────

/** `job.causes` as the Center shows them: one group per cause with its one fix. The result banner carries the Resume button, so a group whose fix is Resume is left out. */
function scCauseGroups(job) {
  const groups = [];
  for (const cause of Array.isArray(job?.causes) ? job.causes : []) {
    const code = String(cause?.code || "");
    const filenames = (Array.isArray(cause?.filenames) ? cause.filenames : []).filter((name) => SC_SAFE_FILENAME.test(String(name)));
    if (!SC_CAUSE_CODE.test(code) || cause.fixAction === "resume") continue;
    groups.push({
      code,
      title: scText(cause.title, 160) || "The capture did not finish",
      fix: scText(cause.fix, 300),
      fixAction: SC_CAUSE_FIX_ACTIONS.includes(cause.fixAction) ? cause.fixAction : "retry",
      tone: cause.tone === "info" ? "info" : "warn",
      count: scCount(cause.count) || filenames.length,
      filenames,
    });
  }
  return groups;
}

/** How many screenshots a job held back for a missing address. */
function scAddressWaiting(job) {
  return (Array.isArray(job?.causes) ? job.causes : []).filter((cause) => SC_ADDRESS_CAUSES.includes(cause?.code)).reduce((sum, cause) => sum + scCount(cause.count), 0);
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
 * The setup steps and their live state: connect, tenant addresses, (when the capture settings loaded) the addresses
 * the screenshots need, and sign-in.
 * @param {object} m `statusLoading`, `statusError`, `connected`, `deviceNames`, `signedIn`, `products`, `needsComputer`,
 *   `tenant`, and `targets` (`{ missing: [requirement views] }`, or null before the capture settings are known)
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

  const needs = { id: "needs", title: "Addresses your screenshots need", state: "done", detail: "All set. Every screenshot has the addresses it needs.", action: null };
  const missingViews = m.targets?.missing || [];
  if (missingViews.length) {
    needs.state = "todo";
    needs.detail = scMissingSummary(missingViews);
    needs.action = { id: "fix-addresses", label: missingViews.length === 1 ? "Add the address" : "Add the addresses" };
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
  return m.targets ? [connect, addresses, needs, signIn] : [connect, addresses, signIn];
}

// ── Job progress ────────────────────────────────────────────────────────────

function scProgressFromShots(shots) {
  const counts = { total: 0, done: 0, captured: 0, needsReview: 0, failed: 0, manual: 0, skipped: 0, running: 0, pending: 0, cancelled: 0, needsYou: 0, paused: 0 };
  for (const shot of Array.isArray(shots) ? shots : []) {
    counts.total += 1;
    switch (shot.status) {
      case "captured": counts.captured += 1; break;
      case "needs-review": counts.needsReview += 1; break;
      case "failed":
      case "auth-required":
      case "needs-account": counts.failed += 1; break;
      case "manual-required": counts.manual += 1; break;
      case "skipped": counts.skipped += 1; break;
      case "cancelled": counts.cancelled += 1; break;
      case "needs-you": counts.needsYou += 1; break;
      case "paused": counts.paused += 1; break;
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

  const finished = job?.status === "done" || job?.status === "failed";
  if (finished && scCount(counts.paused) > 0) {
    const paused = scCount(counts.paused);
    const lead = job.result?.pausedReason === "stopped" ? "You pressed Stop" : "You closed the browser window";
    return { ...base, phase: "paused", tone: "warn", headline: "Capture paused", detail: `${lead}, so the capture paused. ${scPlural(paused, "screenshot")} ${paused === 1 ? "is" : "are"} waiting.` };
  }
  if (job?.status === "done") {
    // An automatic capture is reported the way a person thinks about it, with the step it stopped at.
    if (job?.options?.mode === "autonomous") {
      const report = scAutomaticReport(job);
      const attention = report.review || report.practice || report.unfinished.length || report.failed;
      return { ...base, phase: "done", tone: attention ? "warn" : "ok", headline: "Capture finished", detail: scAutomaticReportText(report) };
    }
    const waiting = scAddressWaiting(job);
    const otherSkipped = Math.max(0, scCount(counts.skipped) - waiting);
    const parts = [`${scCount(counts.captured)} captured`];
    if (scCount(counts.needsReview)) parts.push(`${scCount(counts.needsReview)} need review`);
    if (scCount(counts.failed)) parts.push(`${scCount(counts.failed)} failed`);
    if (scCount(counts.needsYou)) parts.push(`${scCount(counts.needsYou)} need you`);
    if (waiting) parts.push(`${waiting} waiting for an address`);
    if (otherSkipped) parts.push(`${otherSkipped} skipped`);
    if (scCount(counts.manual)) parts.push(`${scCount(counts.manual)} need to be added by hand`);
    const attention = scCount(counts.failed) || scCount(counts.needsReview) || scCount(counts.needsYou) || scCount(counts.skipped);
    return { ...base, phase: "done", tone: attention ? "warn" : "ok", headline: "Capture finished", detail: `${parts.join(", ")}.` };
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
  if (shots.some((s) => s.status === "needs-account")) {
    return {
      ...base,
      phase: "needs-account",
      tone: "warn",
      headline: "Wrong account on your computer",
      detail: "The capture stopped before taking pictures, because the browser is signed in to an account that does not match. Choose which account to use, then retake.",
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
  const waiting = scAddressWaiting(job);
  return {
    ...base,
    phase: job?.status === "claimed" ? "starting" : "running",
    tone: "info",
    headline: job?.status === "claimed" ? "Your computer is getting ready" : "Capturing screenshots",
    detail: `Keep the browser window your computer opened until this finishes.${waiting ? ` ${scPlural(waiting, "screenshot")} ${waiting === 1 ? "is" : "are"} waiting for an address.` : ""}`,
  };
}

/** The result banner shown after a job ends: the message, the failure groups with their one fix each, and the next actions. */
function scOutcomeFromJob(job) {
  const view = scDescribeJob(job);
  const counts = view.counts;
  let variant = "ok";
  if (view.phase === "failed") variant = "error";
  else if (view.phase === "cancelled" || view.tone === "warn") variant = "warn";
  const message =
    view.phase === "done"
      ? `Capture finished: ${view.detail}`
      : view.phase === "paused"
        ? view.detail
        : view.phase === "cancelled"
          ? `Capture canceled. ${view.detail}`
          : `${view.headline}. ${view.detail}`;
  const rows = Array.isArray(job?.shots) ? job.shots : [];
  const filenamesWith = (...statuses) => rows.filter((s) => statuses.includes(s.status)).map((s) => s.filename);
  const causes = scCauseGroups(job);
  const failedFiles = filenamesWith("failed", "auth-required", "needs-account");
  const pausedFiles = filenamesWith("paused");
  const actions = [];
  if (view.phase === "paused" && pausedFiles.length) actions.push({ id: "resume", label: "Resume", primary: true, filenames: pausedFiles });
  // The groups carry a fix for every failed shot, so the all-in-one retry is only for results that have no groups.
  if (failedFiles.length && !causes.length) actions.push({ id: "retry-failed", label: `Retry ${scPlural(failedFiles.length, "screenshot")}`, filenames: failedFiles });
  if (scCount(counts.needsReview)) actions.push({ id: "review", label: `Review ${scPlural(scCount(counts.needsReview), "screenshot")}` });
  return { type: "job", variant, message, jobId: job?.id || null, actions, causes, created: Array.isArray(job?.result?.created) ? job.result.created : [], signIn: scSignInVerdict(job?.result?.signIn), needsAccount: scNeedsAccount(job?.result?.needsAccount) };
}

/** Why a capture stopped before taking pictures because of the account: one sentence from the companion, trimmed. */
function scNeedsAccount(raw) {
  if (!raw || typeof raw !== "object") return null;
  const message = scWithoutIds(scText(raw.message, 400));
  if (!message) return null;
  return { code: ["windows-account", "wrong-account", "unverified"].includes(raw.code) ? raw.code : "wrong-account", message };
}

/** Why a sign-in did not work, from what the companion reported: the sentence, the next step, and the checks that are likely or possible. */
function scSignInVerdict(raw) {
  if (!raw || typeof raw !== "object") return null;
  const summary = scText(raw.summary, 400);
  const nextStep = scText(raw.nextStep, 300);
  if (!summary && !nextStep) return null;
  const checks = (Array.isArray(raw.checks) ? raw.checks : [])
    .map((check) => ({ level: check?.level === "likely" ? "likely" : "possible", title: scText(check?.title, 100), fix: scText(check?.fix, 260) }))
    .filter((check) => check.title)
    .slice(0, 8);
  const product = /^[a-z0-9-]{1,60}$/i.test(String(raw.product || "")) ? String(raw.product) : "copilot-studio";
  return { summary, nextStep, aadsts: /^AADSTS\d{3,7}$/.test(String(raw.aadsts || "")) ? raw.aadsts : null, checks, command: `node companion.mjs --check-signin=${product}` };
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
