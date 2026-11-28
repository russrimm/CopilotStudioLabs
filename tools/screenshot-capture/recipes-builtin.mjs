// Built-in recipes: the setup steps for the screens that need more than an address. Each one is plain data (the
// same steps a recorded recipe holds) written against the product's own labels, with alternates for renamed
// buttons. The portal picks one for a shot from what the shot is about; the companion runs the steps and proves
// each one did something, so a label that has changed is a diagnosed failure, never a wrong screenshot.
//
// Steps marked `practiceOnly` (and every step that creates or saves something) run only inside a practice agent
// after the person opted in. Without that, the recipe stops at the closest screen that needs no practice agent.

import { splitTaggedName } from "./harness.mjs";
import { sanitizeSteps } from "./setup-steps.mjs";

const TEST_INPUT_NAMES = ["Type your message", "Ask a question or describe what you need", "Type a message", "Ask a question", "Send a message", "Message"];

const openTestPane = {
  id: "open-test",
  action: "open",
  intent: "open",
  optional: true,
  target: { role: "button", name: "Test", alt: ["Test your agent", "Test agent", "Open test pane", "Test pane"], within: "any" },
  skipIfPresent: { role: "textbox", name: TEST_INPUT_NAMES[0], alt: TEST_INPUT_NAMES.slice(1), within: "chat" },
};

const askTestPane = [
  { id: "type-question", action: "type", intent: "type", target: { role: "textbox", name: TEST_INPUT_NAMES[0], alt: TEST_INPUT_NAMES.slice(1), within: "chat" }, text: { sample: "question" } },
  { id: "send-question", action: "send", intent: "send", target: { role: "button", name: "Send", alt: ["Send message", "Submit"], within: "chat" } },
  { id: "wait-answer", action: "wait-answer" },
];

const addKnowledgeToPracticeAgent = [
  { id: "knowledge-nav", action: "open-nav", practiceOnly: true, target: { name: "Knowledge", within: "nav" } },
  { id: "knowledge-open", action: "open", intent: "open", practiceOnly: true, target: { role: "button", name: "Add knowledge", alt: ["Add knowledge source", "Add a knowledge source"], within: "main" }, expect: { dialog: true } },
  { id: "knowledge-source", action: "choose", intent: "choose", practiceOnly: true, target: { role: "button", name: "SharePoint", alt: ["SharePoint and OneDrive"], within: "dialog" } },
  { id: "knowledge-add", action: "confirm", intent: "confirm", target: { role: "button", name: "Add to agent", alt: ["Add", "Add knowledge"], within: "dialog" }, expect: { absent: ["Add to agent"] } },
  { id: "overview-nav", action: "open-nav", practiceOnly: true, target: { name: "Overview", within: "nav" } },
];

/**
 * @typedef {object} Recipe
 * @property {string} id
 * @property {string} title
 * @property {string[]} products products it applies to
 * @property {object} when what a shot must be about: `kinds`, `sections`, `words` (a regular expression source), `notWords`
 * @property {object[]} steps
 * @property {object} [final] what must be on the page when the steps are done
 * @property {boolean} [practice] it needs a practice agent for its last part
 */
export const BUILTIN_RECIPES = Object.freeze(
  [
    {
      id: "cs.knowledge.cited-answer",
      title: "Ask the test pane a question that the knowledge source answers",
      products: ["copilot-studio"],
      when: { words: "\\b(?:citations?|cited|sources? (?:listed|shown)|references?)\\b" },
      steps: [...addKnowledgeToPracticeAgent, openTestPane, ...askTestPane],
      practice: true,
    },
    {
      id: "cs.publish.confirmation",
      title: "Publish the practice agent and show the confirmation",
      products: ["copilot-studio"],
      when: { words: "\\b(?:publish(?:ed|ing)? (?:confirmation|message|successfully|complete)|confirmation (?:message|that)|agent (?:is|was) published|successfully published)\\b" },
      steps: [
        { id: "publish-open", action: "open", intent: "open", target: { role: "button", name: "Publish", alt: ["Publish agent"], within: "header" }, expect: { dialog: true } },
        { id: "publish-confirm", action: "confirm", intent: "confirm", target: { role: "button", name: "Publish", alt: ["Publish agent", "Confirm"], within: "dialog" } },
        { id: "publish-wait", action: "wait-for", practiceOnly: true, expect: { text: ["published"] } },
      ],
      practice: true,
    },
    {
      id: "cs.publish.dialog",
      title: "Open the Publish dialog without confirming it",
      products: ["copilot-studio"],
      when: { words: "\\bpublish (?:dialog|panel|window|pop-?up)\\b|\\bpublish this agent\\b" },
      steps: [{ id: "publish-open", action: "open", intent: "open", target: { role: "button", name: "Publish", alt: ["Publish agent"], within: "header" }, expect: { dialog: true } }],
    },
    {
      id: "cs.test-pane.ask",
      title: "Ask the test pane a sample question",
      products: ["copilot-studio"],
      when: { kinds: ["test-result"], sections: ["test"], words: "\\b(?:test pane|test your agent|activity map|conversation|answers?|answered|responds?|response|results?)\\b" },
      steps: [openTestPane, ...askTestPane],
    },
    {
      id: "cs.knowledge.add-dialog",
      title: "Open the Add knowledge dialog",
      products: ["copilot-studio"],
      when: { words: "\\badd(?:ing)? (?:a )?knowledge|knowledge source (?:dialog|picker)|add knowledge\\b" },
      notWords: "\\bdelete|remove\\b",
      steps: [{ id: "knowledge-open", action: "open", intent: "open", target: { role: "button", name: "Add knowledge", alt: ["Add knowledge source", "Add a knowledge source"], within: "main" }, expect: { dialog: true } }],
    },
    {
      id: "cs.tools.add-dialog",
      title: "Open the Add tool dialog",
      products: ["copilot-studio"],
      when: { words: "\\badd(?:ing)? (?:a |an )?(?:tool|action)|tool picker|add tool\\b" },
      steps: [{ id: "tool-open", action: "open", intent: "open", target: { role: "button", name: "Add a tool", alt: ["Add tool", "Add tools", "Add an action", "Add action"], within: "main" }, expect: { dialog: true } }],
    },
    {
      id: "cs.agents.create-options",
      title: "Open More create options on the Agents list (how a Standard agent is started) without choosing anything",
      products: ["copilot-studio"],
      // By its file name, not by words: a reused picture of the same feature (the Home or Agents list picture) carries the same lab step text, and must not open the menu.
      when: { files: ["create-agent-describe.png"], onlySections: ["agents"] },
      // OBSERVED on a real tenant (2026-11-24 and 2026-11-26): the Agents list has a "More create options" button whose menu offers "Agent, uses Copilot Credits", "Customer conversation agent,
      // uses Copilot Credits", and "Agent, Standard". The menu is opened and shown; nothing is chosen, so nothing is created.
      steps: [
        { id: "create-options-open", action: "open", intent: "open", say: "Opening More create options", target: { role: "button", name: "More create options", within: "any" }, expect: { menuItems: ["Agent, Standard"] }, findMs: 60_000 },
        { id: "create-options-shown", action: "verify", say: "Checking that the menu offers Agent, Standard", target: { role: "menuitem", name: "Agent, Standard", within: "any" }, timeoutMs: 6000 },
      ],
    },
    {
      id: "cs.home.describe",
      title: "Type the scenario into the describe box without submitting it",
      products: ["copilot-studio"],
      when: { onlySections: ["home"], words: "\\b(?:natural-language description|description box|describe (?:the|your) agent)\\b" },
      steps: [{ id: "describe-type", action: "type", intent: "type", target: { role: "textbox", name: "Describe your agent", alt: ["What would you like to build?", "Describe the agent you want", "Describe what you want"], within: "main" }, text: { sample: "description" } }],
    },
    {
      id: "cs.item.detail",
      title: "Open the first item to show its details",
      products: ["copilot-studio"],
      when: { words: "\\b(?:details? (?:panel|page|pane)|item details|open(?:ed)? (?:the |an |a )?(?:item|knowledge source|tool|topic|agent))\\b" },
      steps: [{ id: "item-open", action: "open-item", intent: "navigate", expect: { panel: true } }],
    },
    {
      id: "m365.agent-builder.open",
      title: "Open Agent Builder from Microsoft 365 Copilot",
      products: ["m365-copilot-agent-builder"],
      when: {},
      steps: [
        { id: "agents-nav", action: "open-nav", target: { name: "Agents", alt: ["Agent store", "All agents"], within: "nav" } },
        { id: "builder-open", action: "open", intent: "open", target: { role: "button", name: "Create agent", alt: ["New agent", "Create an agent"], within: "main" }, expect: { text: ["Describe", "Configure"] } },
      ],
      variants: [
        { when: { words: "\\b(?:instructions?)\\b" }, steps: [{ id: "configure-tab", action: "select-tab", target: { role: "tab", name: "Configure", within: "tablist" } }] },
        { when: { words: "\\b(?:knowledge|sources?)\\b" }, steps: [{ id: "configure-tab", action: "select-tab", target: { role: "tab", name: "Configure", within: "tablist" } }, { id: "knowledge-open", action: "open", intent: "open", target: { role: "button", name: "Add knowledge", alt: ["Add a knowledge source", "Add sources"], within: "main" }, expect: { dialog: true } }] },
        { when: { words: "\\b(?:describe|description|name)\\b" }, steps: [{ id: "describe-tab", action: "select-tab", optional: true, target: { role: "tab", name: "Describe", within: "tablist" } }] },
      ],
    },
  ].map((recipe) => Object.freeze({ ...recipe, steps: recipe.steps })),
);

const compile = (source) => {
  try {
    return source ? new RegExp(source, "i") : null;
  } catch {
    return null;
  }
};

/** What a shot is about, for matching: the product, section, kind, and the words the lab uses for it. */
function shotFacts(shot) {
  const kind = String(shot.kind || "").toLowerCase();
  const section = String(shot.section || "").toLowerCase();
  const words = [shot.caption, shot.alt, ...(shot.instructions || []), ...(shot.callouts || []).map((c) => c.text || c.label)].map((t) => String(t || "").replace(/\*\*/g, "")).join(" ").toLowerCase();
  const file = splitTaggedName(String(shot.filename || "").toLowerCase()).base;
  return { product: shot.product || "copilot-studio", kind, section, words, file };
}

function whenMatches(when, facts) {
  if (!when) return true;
  if (when.files?.length && !when.files.includes(facts.file)) return false;
  if (when.onlySections?.length && !when.onlySections.includes(facts.section)) return false;
  const hasRules = (when.kinds?.length || 0) + (when.sections?.length || 0) + (when.words ? 1 : 0) > 0;
  if (!hasRules) return true;
  // The signals are alternatives: any one of them is enough.
  if (when.kinds?.includes(facts.kind) || when.sections?.includes(facts.section)) return true;
  const re = compile(when.words);
  return Boolean(re && re.test(facts.words));
}

/**
 * The first built-in recipe whose rules fit the shot, with its steps checked and resolved (a recipe that has
 * variants adds the variant's steps that fit). Returns null when nothing fits.
 */
export function matchBuiltinRecipe(shot, { recipes = BUILTIN_RECIPES } = {}) {
  const facts = shotFacts(shot);
  for (const recipe of recipes) {
    if (!recipe.products.includes(facts.product)) continue;
    if (recipe.notWords && compile(recipe.notWords)?.test(facts.words)) continue;
    if (!whenMatches(recipe.when, facts)) continue;
    let steps = [...recipe.steps];
    for (const variant of recipe.variants || []) {
      if (whenMatches(variant.when, facts)) {
        steps = [...steps, ...variant.steps];
        break;
      }
    }
    return { id: recipe.id, title: recipe.title, practice: Boolean(recipe.practice), steps: sanitizeSteps(steps, { product: facts.product }), rawSteps: steps };
  }
  return null;
}

/** Every built-in recipe with its steps checked: what the dry run lists and what the tests walk. */
export function listBuiltinRecipes() {
  return BUILTIN_RECIPES.map((recipe) => ({ id: recipe.id, title: recipe.title, products: [...recipe.products], practice: Boolean(recipe.practice), steps: sanitizeSteps([...recipe.steps, ...(recipe.variants || []).flatMap((v) => v.steps)], { product: recipe.products[0] }) }));
}
