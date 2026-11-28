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

/** The one Microsoft 365 Copilot Agent Builder slot a recipe reaches: the start screen (the picture of the New agent page). */
export const AGENT_BUILDER_START_SLOT = "dca-new-agent-page.png";
/** What the start screen shows that no other screen does (its message box): when it is already there, the click path is not needed. */
const AGENT_BUILDER_START_MARK = { role: "textbox", name: "Message Agent Builder", within: "any" };
/** What the finished start screen must show: its heading (the lab's picture is checked by it, and a picture without it is saved for review). */
export const AGENT_BUILDER_START_LANDMARKS = Object.freeze(["Build your own specialist agent"]);

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
      title: "Open the Agent Builder start screen from Microsoft 365 Copilot: the Agents menu, then New agent",
      products: ["m365-copilot-agent-builder"],
      // By its file name, not by words: only this screen was read on a real tenant (2026-11-27). Every later screen of Agent Builder ends as Needs you (AGENT_BUILDER_UNSEEN_SLOTS).
      when: { files: [AGENT_BUILDER_START_SLOT] },
      // OBSERVED on a real tenant (2026-11-27, 1440 by 900, read only): the start page copilot.cloud.microsoft/home has a side bar BUTTON named Agents. It does not navigate: it opens a flyout, a
      // dialog named "Agents menu" that lists the person's agents as links, then a LINK named "New agent" (to /agents/new) and a link "More agents & plugins". That link goes to
      // copilot.cloud.microsoft/agents/new: the heading "Build your own specialist agent", a text box "Message Agent Builder", and no Describe or Configure tab. Nothing is typed,
      // chosen, or sent: no template, Skip, Send, or Add and manage sources is clicked. Already on that screen (a person is there), the click path is left out.
      steps: [
        { id: "agents-flyout-open", action: "open", intent: "open", say: "Opening the Agents menu in the side bar", target: { role: "button", name: "Agents", within: "any" }, expect: { dialog: true }, skipIfPresent: AGENT_BUILDER_START_MARK, findMs: 20_000 },
        { id: "agents-menu-shown", action: "verify", say: "Checking that the Agents menu dialog is open", target: { role: "dialog", name: "Agents menu", within: "any" }, skipIfPresent: AGENT_BUILDER_START_MARK, timeoutMs: 6000 },
        { id: "new-agent-open", action: "open-nav", say: "Opening New agent in the Agents menu", target: { role: "link", name: "New agent", within: "dialog" }, expect: { urlPath: "/agents/new" }, skipIfPresent: AGENT_BUILDER_START_MARK, timeoutMs: 12_000 },
        { id: "builder-address", action: "wait-for", say: "Checking that the address is the New agent page", expect: { urlPath: "/agents/new" }, timeoutMs: 15_000 },
        { id: "builder-start-shown", action: "verify", say: "Checking that the New agent start screen is showing", target: { name: "Build your own specialist agent", alt: ["Message Agent Builder"], within: "any" }, timeoutMs: 20_000 },
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

// ── Microsoft 365 Copilot Agent Builder: the screens that were never read ───

// A job row shows at most 300 characters of a message, and “Use “Retake guided”, or upload the picture.” is added to the reason, so a reason stays within 256 characters (the tests check it).
const LATER_SCREENS = "Skip, a sent message, and every screen after the start screen were never read, and it has no Describe or Configure tab.";
const STOPPED = "The computer does not guess.";
/** A screen that comes after the start screen: what it needs, and why no recipe can reach it. */
const later = (need) => `This picture needs ${need}. ${LATER_SCREENS} ${STOPPED}`;
const visualStudioCode = (what) => `This picture is ${what} in Visual Studio Code, outside the browser, so the computer does not take it.`;
const toolkitChat = (what) => `This picture needs ${what} from an agent that a person built and provisioned in Visual Studio Code. The computer never does that, and a chat with such an agent was never read.`;
const adminScreen = (what) => `This picture is ${what}, an admin screen. The computer never opens or changes admin or tenant settings.`;

/**
 * The slots of Microsoft 365 Copilot Agent Builder (the dca- pictures) whose screen was never read on a real tenant, with the exact plain reason each one ends as Needs you.
 * Only the start screen has a recipe (AGENT_BUILDER_START_SLOT), read on 2026-11-27: the Agents side bar button opens a flyout dialog "Agents menu" with a link "New agent", which opens
 * copilot.cloud.microsoft/agents/new. Everything after it is unread, so it is never guessed. Listed in docs/m365-agent-builder-capture-slots.md with the read-only checks that would settle it. By file name.
 */
export const AGENT_BUILDER_UNSEEN_SLOTS = Object.freeze({
  "dca-review-existing-agents.png": "This picture needs the page that lists agents already available to you. The Agents menu was read (your agents, New agent, More agents & plugins), but the page that More agents & plugins opens was never read. The computer does not guess.",
  "dca-upload-custom-apps-policy.png": adminScreen("the Teams admin center setup policy with Upload custom apps turned On (a change)"),
  "dca-copy-to-copilot-studio-menu.png": later("an agent's More options menu showing Copy to Copilot Studio"),
  "dca-copy-environment-picker.png": later("the environment step of Copy to Copilot Studio, a hand-off the computer never starts"),
  "dca-configure-tab-prepopulated.png": later("an agent's Configure view (name, description, instructions, knowledge, starter prompts)"),
  "dca-try-it-response.png": later("an agent's Try it view with one prompt and its response"),
  "dca-template-gallery.png": "This picture needs the template list of the start screen. It has the tabs Templates and My agents and template buttons, but which tab is selected on arrival and what View all opens were never read, and a template is never clicked.",
  "dca-icon-and-response-mode.png": later("an agent's icon and Model section (Auto, Quick response, Think deeper)"),
  "dca-instructions-field.png": later("an agent's Instructions field holding the lab's instructions, which is a change"),
  "dca-instructions-test-result.png": later("the Try it view with a response that follows the instructions"),
  "dca-knowledge-section.png": "This picture needs an agent's Knowledge section (Search, Enter URL, Browse, Upload). The start screen has Add and manage sources and a source filter strip, but neither was clicked, and the lab's options were never read. The computer does not guess.",
  "dca-knowledge-sources-added.png": "This picture needs an agent's Knowledge section listing a website, a SharePoint source, and an uploaded file. Adding sources is a change, the computer never uploads files, and that section was never read.",
  "dca-knowledge-test-result.png": later("the Try it view with an answer that only an added knowledge source can give"),
  "dca-capability-toggles.png": later("an agent's capability toggles (Create documents, charts, and code; Create images)"),
  "dca-code-interpreter-chart.png": later("the Try it view with the Fibonacci prompt, a line chart, and the code button"),
  "dca-skill-attached.png": later("an agent's Skills section with the new skill listed, which is a change"),
  "dca-skill-test-result.png": later("the Try it view with output produced by the skill"),
  "dca-get-support-details.png": later("the Get support section of the Help menu, whose IDs must be masked by hand"),
  "dca-toolkit-create-agent-options.png": visualStudioCode("the prompt that offers Start with TypeSpec for Microsoft 365 Copilot"),
  "dca-toolkit-lifecycle-provision.png": visualStudioCode("the Agents Toolkit pane with Lifecycle and Provision"),
  "dca-typespec-instructions-result.png": toolkitChat("Copilot Chat with My Agent answering by the new instructions"),
  "dca-json-capabilities-array.png": visualStudioCode("the declarativeAgent.json file with its capabilities array"),
  "dca-json-api-selection.png": visualStudioCode("the dialog that lists the APIs found in posts-api.yml"),
  "dca-json-plugin-response.png": toolkitChat("an answer in Copilot Chat with content returned by the API plugin"),
  "dca-typespec-capabilities-code.png": visualStudioCode("the main.tsp file with its knowledge capabilities"),
  "dca-typespec-knowledge-answer.png": toolkitChat("Copilot Chat answering from a SharePoint source"),
  "dca-devmode-preview-f5.png": visualStudioCode("the Agents Toolkit pane with Preview your app (F5) and the Debug panel"),
  "dca-devmode-debug-card.png": toolkitChat("the debug card returned after a developer mode request"),
  "dca-api-plugin-namespace-code.png": visualStudioCode("the main.tsp file with the PostsAPI namespace"),
  "dca-api-plugin-confirmation.png": toolkitChat("the first-use confirmation that asks to send data to the plugin"),
  "dca-api-plugin-list-result.png": toolkitChat("the table of blog posts that the plugin returns"),
  "dca-mcp-auth-type-prompt.png": visualStudioCode("the Select Authentication Type prompt for an MCP server"),
  "dca-mcp-agent-response.png": toolkitChat("the response with data from the MCP server after sign-in"),
  "dca-share-dialog.png": "This picture is an agent's Share dialog. The computer never shares an agent or invites people (its safety rules refuse a Share button), and the dialog was never read.",
  "dca-add-people-panel.png": "This picture is the Add people panel of an agent's Share dialog. The computer never shares an agent or invites people (its safety rules refuse it), and the panel was never read.",
  "dca-about-this-agent.png": later("the About this agent dialog from an agent's More menu, with four fields filled in"),
  "dca-submit-catalog-dialog.png": "This picture is the Submit to your org catalog dialog. It sends the agent to an admin for approval, which the computer never does, and the dialog was never read.",
  "dca-catalog-approved-status.png": "This picture needs an agent an admin approved for the org catalog (Approved banner, Go to Agent Store). Only a person's tenant has that state, and the computer never submits an agent.",
  "dca-admin-agent-settings-page.png": adminScreen("the Agent settings page of the Microsoft 365 admin center"),
  "dca-admin-sharing-setting.png": adminScreen("the Sharing setting of the Microsoft 365 admin center"),
  "dca-admin-registry-list.png": adminScreen("the agent Registry list of the Microsoft 365 admin center"),
  "dca-admin-upload-agent.png": adminScreen("the Add agent flow of the Microsoft 365 admin center (it uploads a package)"),
});

const isAgentBuilderShot = (shot) => String(shot?.capture?.product || shot?.product || "") === "m365-copilot-agent-builder";
const slotFile = (shot) => splitTaggedName(String(shot?.filename || "").toLowerCase()).base;

/** Whether the shot is the Agent Builder start screen, the one screen of the product that has a recipe. */
export const isAgentBuilderStartShot = (shot) => isAgentBuilderShot(shot) && slotFile(shot) === AGENT_BUILDER_START_SLOT;

/** The plain reason an Agent Builder slot ends as Needs you, by its file name (null when it has a recipe or is not a slot of that product). */
export const agentBuilderUnseenReason = (shot) => (isAgentBuilderShot(shot) ? AGENT_BUILDER_UNSEEN_SLOTS[slotFile(shot)] || null : null);
