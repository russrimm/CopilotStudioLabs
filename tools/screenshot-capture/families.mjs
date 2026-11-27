// The steps of the recipe families, for the lab walkthrough (see automation.mjs for what the families are and how a shot is matched to one).
// Each family is generic and parameterized: it takes the shot's automation descriptor (the family, the panel, the dialog's opener, the
// labels to check) and the agent's layout, and returns plain declarative steps in the same format as every other recipe (setup-steps.mjs),
// so the executor checks each control against the action tiers at the click and proves each step did something.
//
// A family never decides on its own what is allowed: `maxTier` is a ceiling the caller gives the executor (1 = open, ask, and close; nothing
// is saved), and a step that would exceed it is refused even in a job that allows a practice agent.

import { OPENERS, PANELS } from "./automation.mjs";
import { STANDARD, isSpecificHarness } from "./harness.mjs";
import * as R from "./scratch-recipes.mjs";

const MCP_FEATURE_RE = /(?:^|-)(?:tools-mcp|mcp-servers?)$/;

/** A page of the classic layout, reached by its navigation item (an older build) and proved by that control being the selected one. */
function classicNav(name, alt = []) {
  const id = name.toLowerCase();
  return [
    { id: `${id}-nav`, action: "open-nav", target: { name, alt, within: "nav" } },
    { id: `${id}-nav-open`, action: "verify", target: { name, alt, within: "nav" }, expect: { selected: true }, timeoutMs: 8000 },
  ];
}

/**
 * The page of a tab (newer layout) or of the classic layout that holds the things a family opens. A Standard (Classic) agent (`standard`) has a tab strip with an overflow menu
 * (see classicTabSteps in scratch-recipes.mjs); only an agent with no harness recorded may still have the side navigation of an older classic build.
 */
function pageSteps(newer, tab, navName, navAlt = [], standard = false) {
  if (newer) return R.tabSteps(tab);
  return standard ? R.classicTabSteps(navName, { alt: navAlt }) : classicNav(navName, navAlt);
}

function conversation({ automation, newer, standard }) {
  const panel = automation.panel ? PANELS[automation.panel] : null;
  const asked = newer ? [...R.tabSteps("Preview"), ...R.askSteps({ question: automation.question })] : R.askSteps({ question: automation.question, openTest: true, classic: standard });
  return { steps: [...asked, ...(panel ? R.panelSteps(panel.names, panel.label) : [])], landmarks: automation.landmarks, note: panel ? `Asked a question and showed the ${panel.label}` : "Asked a sample question" };
}

function dialog({ automation, newer, shot, standard }) {
  const feature = String(shot?.featureId || shot?.feature || "").toLowerCase();
  const choices = automation.choices || [];
  const inner = choices.length ? R.innerTabSteps(choices, { required: false }) : [];
  let steps = null;
  switch (automation.opener) {
    case "knowledge":
      steps = [...pageSteps(newer, "Build", "Knowledge", [], standard), ...R.OPEN_ADD_KNOWLEDGE, ...inner];
      break;
    case "tool":
      steps = [...pageSteps(newer, "Build", "Tools", ["Actions"], standard), ...R.OPEN_ADD_TOOL, ...(newer && MCP_FEATURE_RE.test(feature) ? R.innerTabSteps(["MCP"], { required: true }) : inner)];
      break;
    case "skill":
      steps = newer ? [...R.tabSteps("Build"), ...R.OPEN_ADD_SKILL, ...inner] : null;
      break;
    case "publish":
      steps = [...(newer ? R.tabSteps("Build") : []), ...R.OPEN_PUBLISH_DIALOG];
      break;
    case "model":
      steps = newer ? [...R.tabSteps("Build"), ...R.OPEN_MODEL_LIST] : standard ? [...R.classicTabSteps("Overview"), ...R.CLASSIC_OPEN_MODEL_LIST] : null;
      break;
    case "evaluation":
      // The new evaluation form of a Standard agent was not seen yet: no recipe is written for it (see classicGapFor in scratch.mjs).
      steps = standard ? null : [...pageSteps(newer, "Evaluate", "Evaluation", ["Evaluations"]), ...R.OPEN_NEW_EVALUATION, ...inner];
      break;
    case "settings":
      // A Standard agent's Settings is a full page reached from the top bar, with its own list of links on the left (not a dialog).
      steps = newer ? [...R.tabSteps("Build"), ...R.OPEN_AGENT_SETTINGS, ...inner] : standard ? [...R.CLASSIC_OPEN_SETTINGS, ...R.classicSettingsLinkSteps(R.classicSettingsLinkFor(`${automation.label || ""} ${choices.join(" ")}`))] : null;
      break;
    case "generic":
      steps = automation.label
        ? [...(newer ? R.tabSteps("Build") : []), { id: "dialog-open", action: "open", intent: "open", say: `Opening “${automation.label}”`, target: { name: automation.label, within: "main" }, expect: { dialog: true } }, ...inner]
        : null;
      break;
    default:
      steps = null;
  }
  const unproven = OPENERS[automation.opener] && !OPENERS[automation.opener].proven;
  return steps ? { steps, landmarks: automation.landmarks, note: `Opened ${automation.label || OPENERS[automation.opener]?.label || "the dialog"}${unproven ? " (not seen on a real tenant yet)" : ""}` } : null;
}

function item({ newer, stage, standard }) {
  const page = stage === "tools" ? pageSteps(newer, "Build", "Tools", ["Actions"], standard) : pageSteps(newer, "Build", "Knowledge", [], standard);
  return { steps: [...page, ...R.OPEN_FIRST_ITEM], landmarks: [], note: "Opened the first item to show its details" };
}

function testset({ newer, standard }) {
  return { steps: pageSteps(newer, "Evaluate", "Evaluation", ["Evaluations"], standard), landmarks: [], note: "Showed the Evaluate tab with the sample test set" };
}

/**
 * The steps that put the screen of a family shot into the state its picture needs. The harness decides them (the Standard (Classic) harness has the
 * tab strip with an overflow menu; the Microsoft Copilot and Customer Conversation harnesses have the Build, Preview, Evaluate, and Monitor tabs); `layout` is only for a caller with no harness.
 * @param {{automation: object, shot: object, layout?: "newer"|"classic", harness?: string|null, stage: string}} input
 * @returns {{steps: object[], landmarks: string[], note: string}|null} null when the family has no steps for this layout (the shot is left to a person)
 */
export function familyShowSteps({ automation, shot = {}, layout, harness = null, stage = "" }) {
  const newer = isSpecificHarness(harness) ? harness !== STANDARD : layout === "newer";
  const standard = harness === STANDARD;
  switch (automation?.family) {
    case "conversation":
      return conversation({ automation, newer, standard });
    case "dialog":
      return dialog({ automation, newer, shot, standard });
    case "item":
      return item({ newer, stage, standard });
    case "testset":
      return testset({ newer, standard });
    default:
      return null;
  }
}

/** A short key for "the same recipe" (a family, and the panel or dialog it is about): a recipe that failed twice in a job is not tried again for another shot. */
export function familyKey(automation) {
  if (!automation?.family) return "";
  return [automation.family, automation.panel || automation.opener || ""].filter(Boolean).join(":");
}
