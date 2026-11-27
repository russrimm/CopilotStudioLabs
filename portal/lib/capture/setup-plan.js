/**
 * Builds the `setup` plan of a shot: the ordered steps that put the screen into the state the picture needs
 * (open a section, open a dialog, ask the test pane a question, select a tab). The steps come, in this order, from
 * (a) a recipe a person shared for this shot slot, (b) a built-in recipe for the known product screens, and
 * (c) the shot's own labels (its callouts and bold UI names). Test inputs are the lab's own sample question, never
 * personal data. Steps that need a practice agent are included only when the job may carry them.
 *
 * The plan is data. The companion checks every step again before it touches a page.
 */

import { checkTypedText } from "../../../tools/screenshot-capture/guard.mjs";
import { cleanExpectedLabels } from "../../../tools/screenshot-capture/labels.mjs";
import { matchBuiltinRecipe } from "../../../tools/screenshot-capture/recipes-builtin.mjs";
import { recipeKeyForShot } from "../../../tools/screenshot-capture/recipes.mjs";
import { sanitizeSetup, sanitizeSteps, stepsFromReveal } from "../../../tools/screenshot-capture/setup-steps.mjs";

const BOLD_RE = /\*\*([^*]{1,80})\*\*/g;
const clean = (value, max = 200) => String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const OPENER_RE = /^(?:add|new|select|choose|open|manage|configure|edit|connect|browse)\b/i;

function boldLabels(lines) {
  const out = [];
  for (const line of Array.isArray(lines) ? lines : []) for (const match of String(line).matchAll(BOLD_RE)) out.push(match[1]);
  return out;
}

/**
 * The sample text each kind of step types: the lab's own question when it gives one, otherwise a plain question that
 * does not depend on the tenant. Always short and free of personal data.
 */
export function sampleInputsFor(shot, { labTitle = "" } = {}) {
  const lines = [...(shot.instructions || []), shot.caption || "", shot.alt || ""].map((l) => String(l).replace(/\*\*/g, ""));
  const words = lines.join(" ");
  let question = "";
  for (const line of lines) {
    const quoted = line.match(/[“"]([^”"]{8,160}\?)[”"]/);
    // The lab's own question is typed only when it is a clean sample; otherwise a plain one is used.
    if (quoted && checkTypedText(quoted[1]).ok) {
      question = quoted[1];
      break;
    }
  }
  if (!question) {
    if (/\b(?:citations?|cited|knowledge|sources?|documents?)\b/i.test(words)) question = "Summarize what our documents say about our main policies.";
    else question = "What can you help me with?";
  }
  const topic = clean(labTitle, 80);
  const description = topic ? "An agent that helps my team answer common questions about our policies." : "An agent that answers common questions for my team.";
  const search = clean(boldLabels(shot.instructions)[0] || "", 60);
  const inputs = {};
  for (const [kind, text] of Object.entries({ question, description, search, instruction: "Answer briefly and politely, and only from approved documents." })) {
    const checked = checkTypedText(text);
    if (checked.ok) inputs[kind] = checked.text;
  }
  return inputs;
}

/** An opener for a dialog the shot shows, from its own labels (never a button that creates or saves). */
function deriveOpenerSteps(shot, product) {
  const labels = cleanExpectedLabels([...(shot.callouts || []).map((c) => c.text || c.label), ...boldLabels(shot.instructions)], { max: 8 });
  for (const label of labels) {
    if (!OPENER_RE.test(label)) continue;
    const steps = sanitizeSteps([{ id: "open-dialog", action: "open", intent: "open", target: { name: label, within: "main" }, expect: { dialog: true } }], { product });
    if (steps.length && steps[0].tier <= 1) return steps;
  }
  return [];
}

/** Labels the lab tells the learner to select or open (a verb and a bold name), for products with no known screens. */
function verbReveals(shot) {
  const out = [];
  for (const line of shot.instructions || []) {
    for (const match of String(line).matchAll(/\b(?:select|open|choose|go to|expand|switch to)\s+(?:the\s+)?\*\*([^*]{1,60})\*\*/gi)) out.push({ action: "reveal", label: match[1], required: false });
  }
  const labels = cleanExpectedLabels(out.map((r) => r.label), { max: 3 });
  return out.filter((r) => labels.includes(r.label)).slice(0, 3);
}

/**
 * The setup plan of one shot.
 * @param {object} shot a lab or library shot
 * @param {object} options
 * @param {object} options.capture the shot's classification (see classify.js)
 * @param {boolean} [options.allowPractice] the job may carry steps that need a practice agent
 * @param {{get: (key: object) => object|null}} [options.sharedRecipes]
 * @returns {object|null} a sanitized setup (see setup-steps.mjs), or null when nothing needs doing
 */
export function buildSetupPlan(shot, { capture, allowPractice = false, sharedRecipes = null, labTitle = "" } = {}) {
  if (!capture || capture.mode === "manual") return null;
  const product = capture.product || shot.product || "copilot-studio";
  const facts = { product, filename: shot.filename, kind: shot.kind, section: shot.section || capture.section, caption: shot.caption, alt: shot.alt, instructions: shot.instructions, callouts: shot.callouts };
  const key = recipeKeyForShot({ ...shot, capture });
  let source = "derived";
  let rawSteps = [];
  let final;

  const shared = sharedRecipes?.get?.(key);
  const builtin = shared ? null : matchBuiltinRecipe(facts);
  if (shared) {
    source = `shared:${key.slot}`;
    rawSteps = shared.steps;
    final = shared.final;
  } else if (builtin) {
    source = `builtin:${builtin.id}`;
    rawSteps = builtin.rawSteps;
  } else {
    const derived = [];
    const reveal = capture.reveal?.length ? capture.reveal : product === "copilot-studio" ? [] : verbReveals(shot);
    if (reveal.length) derived.push(...stepsFromReveal(reveal, product));
    if (/\b(?:dialog|pop-?up|wizard|panel)\b/i.test(`${shot.caption || ""} ${shot.alt || ""}`) || shot.kind === "dialog") derived.push(...deriveOpenerSteps(shot, product));
    rawSteps = derived;
  }
  if (!rawSteps.length) return null;
  return sanitizeSetup({ source, steps: rawSteps, final, inputs: sampleInputsFor(shot, { labTitle }) }, { allowPractice, product });
}
