/**
 * Decides how each screenshot is captured, honestly:
 *
 *   auto    the screen can be reached by its address and read-only navigation, so the computer does it and
 *           the address is checked afterwards
 *   guided  the screen needs something the computer should not create (a test conversation, an open dialog,
 *           a publish, a result): the companion opens the closest page and the person captures it
 *   manual  the screen is outside the browser (a terminal, Visual Studio Code)
 *
 * The result is the `capture` descriptor a plan carries: the mode and why, the settings it needs, the route
 * to the screen in plain language and as data, what address to expect, which labels to bring into view, and
 * what to tell a person in guided mode. It is data only; the companion decides how to follow it.
 */

import { readCaptureConfig, sectionConfig } from "../../../tools/feature-tour/lib/products.mjs";
import { cleanExpectedLabels } from "../../../tools/screenshot-capture/labels.mjs";
import {
  COPILOT_STUDIO_SCREENS,
  REQUIREMENTS,
  REQUIREMENT_FOR_ENV,
  copilotStudioScreenUrl,
  describePath,
  missingRequirements,
  parseCopilotStudioAddress,
} from "../../../tools/screenshot-capture/targets.mjs";

export const CAPTURE_DESCRIPTOR_VERSION = 1;

const BOLD_RE = /\*\*([^*]{1,80})\*\*/g;
const text = (value, max = 300) => String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

// Things only a person (or an earlier action) puts on a screen.
const TRANSIENT_RE = /\b(?:test pane|test your agent|activity map|conversation|chat|answers?|answered|responds?|response|publish(?:ed|ing)? (?:confirmation|message|successfully)|confirmation message|confirmation|dialog|pop-?up|wizard|toast|notification|streaming|citations?|trace|run history|results?)\b/i;

const DIRECT_SECTIONS = new Set(["home", "admin", "admin-center", "sharepoint-admin-center", "m365-admin-center", "m365-apps-admin-center", "purview", "azure-portal", "classic-portal", "sharepoint-site", "copilot-app"]);

const COPILOT_STUDIO_SECTION_SCREEN = {
  home: "home",
  agents: null,
  overview: "overview",
  knowledge: "knowledge",
  tools: "tools",
  topics: "topics",
  analytics: "analytics",
  channels: "channels",
  evaluations: "evaluations",
  evaluate: "evaluations",
  settings: "settings",
  test: "overview",
  deploy: "overview",
  preview: "overview",
  monitor: "overview",
  build: "home",
  custom: "home",
  solutions: "home",
};

let cachedConfig = null;
function captureConfig() {
  cachedConfig ??= readCaptureConfig();
  return cachedConfig;
}

function boldLabels(lines) {
  const labels = [];
  for (const line of Array.isArray(lines) ? lines : []) for (const match of String(line).matchAll(BOLD_RE)) labels.push(match[1]);
  return labels;
}

/**
 * The labels a finished screenshot of this shot should show, as a soft hint for verification: the shot's own
 * callouts and bold labels, never the labels of the module's other steps, which belong to other screens.
 */
export function expectedLabelsForShot(shot, { extra = [] } = {}) {
  const labels = [];
  for (const callout of shot?.callouts || []) labels.push(callout.text || callout.label);
  labels.push(...boldLabels(shot?.instructions));
  labels.push(...extra);
  return cleanExpectedLabels(labels, { max: 12 });
}

/** Which Copilot Studio screen a shot shows, from its section and what the lab says about it. */
function copilotStudioScreen(shot) {
  const section = text(shot.section, 60).toLowerCase();
  const words = `${text(shot.caption)} ${text(shot.alt)} ${(shot.instructions || []).join(" ")}`;
  let id = COPILOT_STUDIO_SECTION_SCREEN[section];
  let ambiguous = false;
  if (id === undefined || id === null) {
    // "agents" names the Agents list for some shots and a place inside an agent for others.
    if (/\bhome\b/i.test(words)) id = "home";
    else if (/\b(?:list of agents|agents page|agent list|all agents)\b/i.test(words)) id = "agents";
    else if (/\bsettings\b/i.test(words)) id = "settings";
    else if (/\boverview\b/i.test(words)) id = "overview";
    else {
      id = "overview";
      ambiguous = true;
    }
  }
  return { id, ambiguous };
}

function modeFor(shot, { section, ambiguous = false, directOk = true, itemLevel = false }) {
  const kind = text(shot.kind, 30).toLowerCase();
  const words = `${text(shot.caption)} ${text(shot.alt)} ${(shot.instructions || []).join(" ")}`;
  if (kind === "test-result" || section === "test") return { mode: "guided", why: "This shows a test conversation, so a question has to be asked in the test pane first. You set it up and capture it." };
  if (kind === "dialog") return { mode: "guided", why: "A dialog has to be opened first, so you open it and capture it." };
  if (kind === "error-state") return { mode: "guided", why: "This shows an error or a blocked state, which has to be set up first." };
  if (ambiguous) return { mode: "guided", why: "This screen could be in a few places, so I open the closest page and you confirm it." };
  if (!directOk) return { mode: "guided", why: "This screen has no direct address. I open the closest page and you open the screen." };
  if (itemLevel && (kind === "settings" || kind === "after")) return { mode: "guided", why: "This shows the details of one item (a tool, a knowledge source, a panel), so you open it and capture it." };
  if (TRANSIENT_RE.test(words) && kind !== "ui-location" && kind !== "settings") return { mode: "guided", why: "This shows the result of an action (a published agent, a message, a result), so you set it up and capture it." };
  return { mode: "auto", why: "The computer can open this screen by its address and take the picture, then check the address." };
}

function guideLines(shot, path, firstStep) {
  const lines = [];
  if (firstStep) lines.push(firstStep);
  else if (path?.length > 1) lines.push(`Open ${path.slice(1).join(" > ")}.`);
  for (const line of (shot.instructions || []).slice(0, 3)) {
    const clean = text(line.replace(/\*\*/g, ""), 200);
    if (clean && !lines.includes(clean)) lines.push(clean);
  }
  lines.push("When the screen looks right, press Capture this screen.");
  return lines.slice(0, 6);
}

function revealStepsFor(shot, screen) {
  if (!screen || screen.scope !== "agent") return [];
  const skip = new Set([...(screen.navLabels || []), screen.short].map((l) => l.toLowerCase()));
  const instruction = (shot.instructions || []).join(" ").toLowerCase();
  const steps = [];
  for (const raw of [...(shot.callouts || []).map((c) => c.text || c.label), ...boldLabels(shot.instructions)]) {
    const [label] = cleanExpectedLabels([raw], { max: 1 });
    if (!label || skip.has(label.toLowerCase()) || steps.some((s) => s.label.toLowerCase() === label.toLowerCase())) continue;
    steps.push({ action: "reveal", label, required: instruction.includes(label.toLowerCase()) });
    if (steps.length >= 3) break;
  }
  return steps;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/**
 * Classify one shot.
 * @param {object} shot a shot from a lab's `screenshots/shots.json` (or the feature tour's shot list)
 * @param {{values?: Record<string, string>, config?: object}} [options] `values` are the capture settings in effect
 * @returns {object} the `capture` descriptor
 */
export function classifyShot(shot, { values = {}, config = captureConfig() } = {}) {
  const product = text(shot.product, 60) || "copilot-studio";
  const section = text(shot.section, 60).toLowerCase();
  const cfg = sectionConfig(config, product, section);
  const base = { version: CAPTURE_DESCRIPTOR_VERSION, product, section: section || null };

  if (shot.manual || cfg.manual) {
    return { ...base, mode: "manual", why: "This screen is outside the browser (a terminal or Visual Studio Code). Capture it with an OS screenshot tool and upload it.", needs: [], missing: [], ready: true, route: { kind: "none" }, path: [], expect: null, reveal: [], landmarks: [], guide: [] };
  }

  // ── Copilot Studio: environment and agent screens ──
  if (product === "copilot-studio" && !(cfg.url && section === "admin")) {
    const { id, ambiguous } = copilotStudioScreen(shot);
    const screen = COPILOT_STUDIO_SCREENS[id];
    const itemLevel = ["tools", "knowledge", "agents", "evaluations", "topics", "channels"].includes(id);
    const { mode, why } = modeFor(shot, { section, ambiguous, itemLevel });
    const needs = mode === "auto" && screen.scope === "agent" ? ["copilot-studio-agent"] : [];
    // In autonomous mode every agent screen needs the agent, including the ones a person would have to set up by hand.
    const agentNeeds = screen.scope === "agent" ? ["copilot-studio-agent"] : [];
    const missing = missingRequirements(needs, values);
    const reveal = revealStepsFor(shot, screen);
    const path = describePath(id);
    const known = copilotStudioScreenUrl(id, parseCopilotStudioAddress(values.copilotStudioAgentUrl || values.copilotStudioUrl || ""));
    return {
      ...base,
      mode,
      why: mode === "auto" && reveal.length ? `${why} It also selects ${reveal.map((s) => s.label).join(", ")}.` : why,
      needs,
      missing,
      agentNeeds,
      agentMissing: missingRequirements(agentNeeds, values),
      ready: missing.length === 0,
      route: { kind: "copilot-studio", screen: id, scope: screen.scope },
      screen: { id, label: screen.label },
      path,
      expect: { family: "copilot-studio", scope: screen.scope, paths: screen.paths, label: screen.label, strict: mode === "auto" },
      reveal,
      landmarks: expectedLabelsForShot(shot, { extra: [screen.short] }),
      guide: guideLines(shot, path, screen.scope === "agent" ? `Open your agent${values.copilotStudioAgentName ? ` “${text(values.copilotStudioAgentName, 60)}”` : ""}, then ${screen.short}.` : `Open ${screen.short}.`),
      knownUrl: known,
    };
  }

  // ── Every other product: the section's own address ──
  const productCfg = config.products?.[product] || {};
  const envName = cfg.urlEnv || null;
  const startEnv = productCfg.startUrlEnv || null;
  const requirementId = envName && !cfg.url ? REQUIREMENT_FOR_ENV[envName] : null;
  const needs = requirementId ? [requirementId] : [];
  const publicUrl = cfg.url || productCfg.startUrl || null;
  const direct = DIRECT_SECTIONS.has(section);
  const { mode: rawMode, why } = modeFor(shot, { section, directOk: direct, itemLevel: true });
  const missing = rawMode === "auto" ? missingRequirements(needs, values) : [];
  const agentBuilder = product === "m365-copilot-agent-builder";
  const mode = agentBuilder && rawMode === "auto" ? "guided" : rawMode;
  const modeWhy = agentBuilder && rawMode === "auto" ? "Agent Builder opens inside Microsoft 365 Copilot and has no direct address. I open Microsoft 365 Copilot and you open your agent and Agent Builder." : why;
  // A section reached through the person's own address (a SharePoint site, a Foundry project) lands on that host, not the product's public one.
  const tenantUrl = requirementId ? (REQUIREMENTS[requirementId]?.fields || []).map((field) => values[field]).find(Boolean) : null;
  const resolvedHost = hostOf(tenantUrl) || hostOf(publicUrl);
  const path = [text(config.products?.[product]?.label || product, 80), ...(cfg.hint ? [] : [section.replace(/-/g, " ")].filter(Boolean))];
  return {
    ...base,
    mode,
    why: modeWhy,
    needs: mode === "auto" || requirementId ? needs : [],
    missing,
    agentNeeds: requirementId ? needs : [],
    agentMissing: requirementId ? missingRequirements(needs, values) : [],
    ready: missing.length === 0,
    route: { kind: "url", url: publicUrl, urlEnv: envName || startEnv || null, direct },
    screen: { id: section || "start", label: text(cfg.hint ? `the ${section.replace(/-/g, " ")} screen` : `the ${text(productCfg.label || product, 60)} page`) },
    path,
    expect: resolvedHost ? { family: "url", host: resolvedHost, label: `a page of ${text(productCfg.label || product, 60)}`, strict: mode === "auto" } : null,
    reveal: [],
    landmarks: expectedLabelsForShot(shot),
    guide: guideLines(shot, path, cfg.hint ? text(cfg.hint, 220) : null),
  };
}

/** The settings (addresses and names) that apply to a plan, as classification input. */
export function describeShotCapture(shot, values) {
  const capture = classifyShot(shot, { values });
  return { mode: capture.mode, why: capture.why, path: capture.path, needs: capture.needs, missing: capture.missing, ready: capture.ready, screen: capture.screen || null };
}

/** Group the shots that cannot run for a missing setting: `[{id, label, noun, cause, prompt, product, count, filenames}]`. */
export function summarizeMissing(shots) {
  const groups = new Map();
  for (const shot of shots) {
    for (const id of shot.capture?.missing || []) {
      const requirement = REQUIREMENTS[id];
      if (!requirement) continue;
      if (!groups.has(id)) groups.set(id, { id, label: requirement.label, noun: requirement.noun, cause: requirement.cause, prompt: requirement.prompt, product: requirement.product, fields: requirement.fields, count: 0, filenames: [] });
      const group = groups.get(id);
      group.count += 1;
      group.filenames.push(shot.filename);
    }
  }
  return [...groups.values()];
}
