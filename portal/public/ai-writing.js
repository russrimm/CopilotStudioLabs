// Optional AI writing, on the Review and build step of the lab builder.
//
// The control shows only when /api/ai/status says AI is possible here: a person can turn it on and pick a model, or sign in
// first. When the server has it switched off, one calm line says so. When it cannot work for this visitor at all (the SDK is
// missing, an open portal, a request that is not from this PC in local mode), nothing shows.
//
// Only the choice is kept: on, a model id, and the parts of the lab AI writes. It is saved with a draft and with a built lab,
// and it is sent in the build request as `ai`. No token, key or prompt ever reaches this page.

const LB_AI_SCOPES = [
  ["lab", "The lab text"],
  ["training", "The training decks"],
  ["labday", "The lab-day decks"],
];
const LB_AI_ALL_SCOPES = LB_AI_SCOPES.map(([id]) => id);
const LB_AI_PART_WORDS = { lab: "the lab text", training: "the training decks", labday: "the lab-day decks" };
// Used only until /api/ai/status delivers the measured numbers (lib/ai/estimate.js); the same formula lives there.
const LB_AI_ESTIMATE_FALLBACK = {
  lab: { base: 1, perModule: 0.55 },
  labday: { base: 0.5, perModule: 0.3 },
  training: { base: 3, perModule: 3.5 },
  retryShare: 0.1,
};

const labBuilderAi = {
  status: null,
  models: [],
  modelsFor: "",
  loading: false,
  enabled: false,
  model: "",
  scope: [...LB_AI_ALL_SCOPES],
  error: "",
  bound: false,
  signInTimer: null,
  progressTimer: null,
  progress: null,
};

function lbAiEl(id) {
  return document.getElementById(id);
}

function lbAiSetHidden(id, hidden) {
  const el = lbAiEl(id);
  if (el) el.hidden = Boolean(hidden);
}

function lbAiSetText(id, text) {
  const el = lbAiEl(id);
  if (el && el.textContent !== text) el.textContent = text;
}

/** What AI would do for this build, in the words of the review summary. Empty when it is off. */
function lbAiSummaryText() {
  if (!labBuilderAi.enabled) return "";
  const model = labBuilderAi.models.find((m) => m.id === labBuilderAi.model);
  if (!model) return "AI writing is on. Pick a model.";
  const parts = LB_AI_ALL_SCOPES.filter((id) => labBuilderAi.scope.includes(id)).map((id) => LB_AI_PART_WORDS[id]);
  if (!parts.length) return "AI writing is on. Choose what it writes.";
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `AI writing is on: ${model.name} will reword ${list}.`;
}

/** The short fact the lab outline adds when AI is on. */
function lbAiFactText() {
  if (!labBuilderAi.enabled || !labBuilderAi.status?.available) return "";
  const model = labBuilderAi.models.find((m) => m.id === labBuilderAi.model);
  return model ? `Written with AI (${model.name})` : "";
}

/** How many modules the lab has, refreshers included, from the outline the wizard already planned; 0 until it is ready. */
function lbAiModuleCount() {
  const modules = typeof labBuilder !== "undefined" && Array.isArray(labBuilder?.previewModules) ? labBuilder.previewModules : [];
  return modules.length;
}

/** The same formula as lib/ai/estimate.js: prompts for this lab with the parts chosen, or 0 when there is nothing to count. */
function lbAiEstimatePrompts(modules, scope, params) {
  const p = params || labBuilderAi.status?.estimate || LB_AI_ESTIMATE_FALLBACK;
  const count = Math.max(1, Math.floor(Number(modules) || 0));
  const chosen = new Set(scope);
  const part = (x) => x.base + x.perModule * count;
  const lab = chosen.has("lab") ? part(p.lab) : 0;
  const labday = chosen.has("labday") && !chosen.has("lab") ? part(p.labday) : 0;
  const training = chosen.has("training") ? part(p.training) : 0;
  const raw = lab + labday + training;
  return raw ? Math.ceil(raw * (1 + p.retryShare)) : 0;
}

/** "About 13 prompts for this lab...", in plain words, with the honest note about cost. Empty until there is something to say. */
function lbAiEstimateText() {
  if (!labBuilderAi.enabled || !labBuilderAi.scope.length) return "";
  const modules = lbAiModuleCount();
  if (!modules) return "";
  const prompts = lbAiEstimatePrompts(modules, labBuilderAi.scope);
  if (!prompts) return "";
  const model = labBuilderAi.models.find((m) => m.id === labBuilderAi.model);
  const about = `About ${prompts} ${prompts === 1 ? "prompt" : "prompts"} for this lab with the parts ticked above.`;
  if (model && Number.isFinite(model.multiplier)) {
    const premium = Math.round(prompts * model.multiplier * 10) / 10;
    return `${about} At ${model.multiplier} of a premium request each, that is about ${premium} premium ${premium === 1 ? "request" : "requests"}.`;
  }
  return `${about} Cost is not reported by GitHub; each prompt counts against your Copilot allowance.`;
}

/** The model's name for the picker: the recommended one says so. */
function lbAiModelLabel(model) {
  return model.recommended ? `${model.name} (recommended)` : model.name;
}

function lbAiRender() {
  const status = labBuilderAi.status;
  const card = lbAiEl("lb-ai-card");
  if (!card) return;
  lbAiRefreshOutlineFact();
  const off = Boolean(status) && status.state === "off";
  const possible = Boolean(status) && status.possible === true;
  card.hidden = !(off || possible);
  lbAiSetHidden("lb-ai-off-note", !off);
  lbAiSetHidden("lb-ai-body", !possible);
  if (off) lbAiSetText("lb-ai-off-note", status.message || "AI writing is turned off on this server.");
  if (!possible) return;

  const box = lbAiEl("lb-ai-enabled");
  if (box) {
    box.checked = labBuilderAi.enabled;
    box.setAttribute?.("aria-expanded", labBuilderAi.enabled ? "true" : "false");
  }
  lbAiSetHidden("lb-ai-options", !labBuilderAi.enabled);
  lbAiSetText("lb-ai-status", status.message || "");
  const needsSignIn = status.needsSignIn === true;
  lbAiSetHidden("lb-ai-signin", !(needsSignIn && status.signInUrl));
  lbAiSetHidden("lb-ai-model-group", needsSignIn);
  lbAiSetHidden("lb-ai-scope", needsSignIn);

  const select = lbAiEl("lb-ai-model");
  if (select && !needsSignIn) {
    const options = labBuilderAi.models.map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(lbAiModelLabel(m))}</option>`);
    select.innerHTML = [`<option value="">Choose a model</option>`, ...options].join("");
    select.value = labBuilderAi.models.some((m) => m.id === labBuilderAi.model) ? labBuilderAi.model : "";
  }
  const chosen = labBuilderAi.models.find((m) => m.id === labBuilderAi.model);
  lbAiSetText("lb-ai-model-cost", chosen ? [chosen.cost, chosen.warning].filter(Boolean).join(". ") : labBuilderAi.loading ? "Loading the models available to you." : "");
  lbAiSetText("lb-ai-model-why", chosen?.recommended && chosen.recommendedWhy ? `Recommended: ${chosen.recommendedWhy}` : "");
  lbAiSetText("lb-ai-estimate", lbAiEstimateText());
  for (const [id] of LB_AI_SCOPES) {
    const input = lbAiEl(`lb-ai-scope-${id}`);
    if (input) input.checked = labBuilderAi.scope.includes(id);
  }
  lbAiSetText("lb-ai-sends", status.sends || "");
  lbAiSetText("lb-ai-summary", lbAiSummaryText());
  lbAiSetText("lb-ai-error", labBuilderAi.error);
}

/** Keeps the outline's one-line facts in step with the choice, without rebuilding the outline. */
function lbAiRefreshOutlineFact() {
  const fact = lbAiFactText();
  lbAiSetText("lb-outline-ai-fact", fact ? ` · ${fact}` : "");
}

async function lbAiLoadStatus() {
  try {
    const res = await fetch("/api/ai/status", { cache: "no-store" });
    labBuilderAi.status = res?.ok ? await res.json() : null;
  } catch {
    labBuilderAi.status = null;
  }
  if (!labBuilderAi.status?.available) {
    labBuilderAi.models = [];
    labBuilderAi.modelsFor = "";
  }
  lbAiRender();
  if (labBuilderAi.enabled && labBuilderAi.status?.available) await lbAiLoadModels();
}

async function lbAiLoadModels() {
  if (!labBuilderAi.status?.available || labBuilderAi.loading) return;
  labBuilderAi.loading = true;
  labBuilderAi.error = "";
  lbAiRender();
  try {
    const res = await fetch("/api/ai/models", { cache: "no-store" });
    const data = res?.ok ? await res.json() : null;
    if (!data) {
      const failure = res ? await res.json().catch(() => ({})) : {};
      throw new Error(failure.error || "The model list could not be read.");
    }
    labBuilderAi.models = Array.isArray(data.models) ? data.models : [];
    if (labBuilderAi.model && !labBuilderAi.models.some((m) => m.id === labBuilderAi.model)) {
      labBuilderAi.error = "The model saved with this choice is not available to you now. Pick another.";
      labBuilderAi.model = "";
    }
    if (!labBuilderAi.model && labBuilderAi.models.length === 1) labBuilderAi.model = labBuilderAi.models[0].id;
    // The recommended model is ready to use: one less thing to decide. A saved choice is never replaced.
    if (!labBuilderAi.model) {
      const recommended = labBuilderAi.models.find((m) => m.recommended);
      if (recommended) labBuilderAi.model = recommended.id;
    }
  } catch (err) {
    labBuilderAi.models = [];
    labBuilderAi.error = err.message || "The model list could not be read.";
  } finally {
    labBuilderAi.loading = false;
    lbAiRender();
  }
}

/** Called when the Review step opens and when the choice changes: the status is read fresh, the models only when needed. */
async function lbAiRefresh() {
  lbAiBind();
  await lbAiLoadStatus();
}

function lbAiSetEnabled(enabled) {
  labBuilderAi.enabled = Boolean(enabled);
  labBuilderAi.error = "";
  lbAiRender();
  if (labBuilderAi.enabled && labBuilderAi.status?.available && !labBuilderAi.models.length) void lbAiLoadModels();
}

function lbAiSetModel(id) {
  labBuilderAi.model = String(id || "");
  labBuilderAi.error = "";
  lbAiRender();
}

function lbAiSetScope(id, checked) {
  const set = new Set(labBuilderAi.scope);
  if (checked) set.add(id);
  else set.delete(id);
  labBuilderAi.scope = LB_AI_ALL_SCOPES.filter((item) => set.has(item));
  labBuilderAi.error = "";
  lbAiRender();
}

function lbAiBind() {
  if (labBuilderAi.bound) return;
  const box = lbAiEl("lb-ai-enabled");
  if (!box?.addEventListener) return;
  labBuilderAi.bound = true;
  box.addEventListener("change", () => lbAiSetEnabled(box.checked));
  lbAiEl("lb-ai-model")?.addEventListener("change", (event) => lbAiSetModel(event.target?.value ?? lbAiEl("lb-ai-model").value));
  for (const [id] of LB_AI_SCOPES) {
    const input = lbAiEl(`lb-ai-scope-${id}`);
    input?.addEventListener("change", () => lbAiSetScope(id, input.checked));
  }
  lbAiEl("lb-ai-signin")?.addEventListener("click", () => void lbAiSignIn());
}

/** Per-user mode: send the visitor to GitHub in a window of their own, then watch for the sign-in to finish. */
async function lbAiSignIn() {
  const status = labBuilderAi.status;
  if (!status?.signInUrl) return;
  labBuilderAi.error = "";
  try {
    const res = await fetch(status.signInUrl, { method: "POST" });
    const data = await res.json();
    if (!res.ok || !data.url) throw new Error(data.error || "Signing in with GitHub is not available.");
    globalThis.open?.(data.url, "ai-sign-in");
    if (labBuilderAi.signInTimer) clearInterval(labBuilderAi.signInTimer);
    let tries = 0;
    labBuilderAi.signInTimer = setInterval(async () => {
      tries += 1;
      await lbAiLoadStatus();
      if (labBuilderAi.status?.available || tries > 90) {
        clearInterval(labBuilderAi.signInTimer);
        labBuilderAi.signInTimer = null;
      }
    }, 2000);
    labBuilderAi.signInTimer?.unref?.();
  } catch (err) {
    labBuilderAi.error = err.message || "Signing in with GitHub is not available.";
    lbAiRender();
  }
}

/** `{ ai: ... }` for the build request, or nothing when AI is off, unavailable, or incomplete. */
function lbAiRequestField() {
  if (!labBuilderAi.enabled || !labBuilderAi.status?.available || !labBuilderAi.model || !labBuilderAi.scope.length) return {};
  return {
    ai: {
      enabled: true,
      provider: labBuilderAi.status.mode === "byok" ? "byok" : "github-copilot",
      model: labBuilderAi.model,
      scope: [...labBuilderAi.scope],
    },
  };
}

/** A plain message when the person turned AI on but the build cannot use it yet, or "" when the build may go ahead. */
function lbAiCheckBeforeBuild() {
  if (!labBuilderAi.enabled) return "";
  const status = labBuilderAi.status;
  if (!status?.available) return status?.needsSignIn ? "Sign in with GitHub to write with AI, or turn Write with AI off." : "AI writing is not available right now. Turn Write with AI off to build the standard lab.";
  if (!labBuilderAi.model) return "Pick an AI model, or turn Write with AI off.";
  if (!labBuilderAi.scope.length) return "Choose what AI writes, or turn Write with AI off.";
  return "";
}

function lbAiShowBuildError(message) {
  labBuilderAi.error = message;
  lbAiRender();
  lbAiEl("lb-ai-error")?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
}

/** What a draft or a built lab remembers: the choice only. */
function lbAiDraftChoice() {
  return { enabled: labBuilderAi.enabled, model: labBuilderAi.model || null, scope: [...labBuilderAi.scope] };
}

function lbAiApplySaved(saved) {
  const ai = saved && typeof saved === "object" ? saved : {};
  labBuilderAi.enabled = ai.enabled === true;
  labBuilderAi.model = typeof ai.model === "string" ? ai.model : "";
  const scope = Array.isArray(ai.scope) ? ai.scope.filter((id) => LB_AI_ALL_SCOPES.includes(id)) : [...LB_AI_ALL_SCOPES];
  labBuilderAi.scope = LB_AI_ALL_SCOPES.filter((id) => scope.includes(id));
  labBuilderAi.error = "";
  lbAiRender();
}

function lbAiReset() {
  labBuilderAi.enabled = false;
  labBuilderAi.model = "";
  labBuilderAi.scope = [...LB_AI_ALL_SCOPES];
  labBuilderAi.error = "";
  lbAiRender();
}

// ── While the lab is being built ────────────────────────────────────────────
function lbAiProgressText() {
  const p = labBuilderAi.progress;
  if (!p || !(p.total > 0) || p.finished) return "";
  const part = LB_AI_PART_WORDS[p.stage] || "the lab";
  const prompts = Number(p.prompts) > 0 ? ` ${p.prompts} ${Number(p.prompts) === 1 ? "prompt" : "prompts"} used so far.` : "";
  return `Writing ${part} with AI: ${p.done} of ${p.total} passages done.${prompts}`;
}

function lbAiOnBuildStart(ticket) {
  lbAiOnBuildEnd();
  if (!ticket || !lbAiRequestField().ai) return;
  let asking = false;
  const poll = async () => {
    if (asking) return;
    asking = true;
    try {
      const res = await fetch(`/api/ai/progress/${encodeURIComponent(ticket)}`, { cache: "no-store" });
      const data = res?.ok ? await res.json() : null;
      if (!data) return;
      const before = lbAiProgressText();
      labBuilderAi.progress = data;
      const text = lbAiProgressText();
      const line = lbAiEl("lb-status");
      if (text && text !== before && line) line.textContent = text;
    } catch {
      /* the next check tries again */
    } finally {
      asking = false;
    }
  };
  labBuilderAi.progressTimer = setInterval(poll, 1500);
  labBuilderAi.progressTimer?.unref?.();
}

function lbAiOnBuildEnd() {
  if (labBuilderAi.progressTimer) clearInterval(labBuilderAi.progressTimer);
  labBuilderAi.progressTimer = null;
  labBuilderAi.progress = null;
}
