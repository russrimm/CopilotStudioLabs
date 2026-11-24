// The steps of the lab walkthrough, as plain data: the same declarative steps a recorded recipe holds (see setup-steps.mjs),
// written against the product's own labels, with alternates for renamed buttons, for the NEWER agent layout (Build,
// Preview, Evaluate, and Monitor tabs) and the classic layout (a side navigation) as a fallback. The companion runs them
// through the executor, which checks every control against the action tiers before it touches it and proves each step
// did something, so a label that changed is a diagnosed failure and never a wrong picture.
//
// Two kinds of steps: `prepare` steps change the practice agent (create it, set its instructions, add knowledge, publish)
// and run once, then are remembered; `show` steps only put a screen into the state a picture needs and run for every shot.

const T = (role, name, alt = [], within = "any") => ({ ...(role ? { role } : {}), name, ...(alt.length ? { alt } : {}), within });
const TEST_INPUT = ["Chat message input", "Type your message", "Ask a question or describe what you need", "Type a message", "Ask a question", "Send a message", "Message", "Ask anything"];
const CHAT_INPUT = T("textbox", TEST_INPUT[0], TEST_INPUT.slice(1), "chat");

const tabNames = Object.freeze({ Build: ["Build", "Design", "Configure"], Preview: ["Preview", "Test"], Evaluate: ["Evaluate", "Evaluation"], Monitor: ["Monitor", "Analytics"] });

/** Select a tab of the newer layout and prove it is the one open. */
export function tabSteps(tab, id = tab.toLowerCase()) {
  const [name, ...alt] = tabNames[tab] || [tab];
  return [
    { id: `${id}-tab`, action: "select-tab", say: `Opening the ${name} tab`, target: T("tab", name, alt, "tablist") },
    { id: `${id}-tab-open`, action: "verify", target: T("tab", name, alt, "tablist"), expect: { selected: true }, timeoutMs: 8000 },
  ];
}

/**
 * The agent page's landmarks (the tab strip of the Build, Preview, Evaluate, and Monitor tabs, or the classic side navigation) are what prove which harness
 * an agent is in (see harness-run.mjs). This pair of names is only the quick probe a caller with no harness can use; the harness decides the steps, not the probe.
 */
export const LAYOUT_PROBE = Object.freeze({ newer: T("tab", "Build", ["Design", "Configure"], "tablist"), classic: T("link", "Overview", [], "nav") });

// ── Prepare: the steps that change the practice agent ───────────────────────

/**
 * Making the agent takes three runs, so the registry can say "a Create click may have happened" only at the last one:
 * open the new-agent page (nothing exists yet), name it, then the one click that makes it (Save in the newer layout, Create on the classic form).
 * All three run in the sanctioned create flow only.
 */
export const CREATE_AGENT_OPEN = Object.freeze([
  { id: "create-open", action: "create", intent: "open", say: "Opening the new agent page", target: T("button", "New agent", ["Create agent", "Create an agent", "Create new agent", "Create blank agent"], "any"), timeoutMs: 20_000, retries: 0 },
]);

export const CREATE_AGENT_FILL = Object.freeze([
  { id: "create-name", action: "type", intent: "type", say: "Naming the agent", note: "Named the practice agent", target: T("textbox", "Name", ["Agent name", "Name your agent", "Enter a name", "Give your agent a name"], "any"), text: { sample: "agentName" }, timeoutMs: 20_000 },
]);

export const CREATE_AGENT_COMMIT = Object.freeze([
  { id: "create-commit", action: "create", intent: "confirm", say: "Creating the agent", note: "Created the practice agent", target: T("button", "Save", ["Create", "Create agent", "Save agent", "Save icon"], "any"), timeoutMs: 20_000, retries: 0 },
]);

/** Find the practice agent in the Agents list by its own name: filter the list, then open the row. Nothing is changed. */
export function findAgentSteps(name) {
  return [
    { id: "find-search", action: "type", intent: "type", say: "Looking for the practice agent in the list", target: T("searchbox", "Search agents by name", ["Search agents", "Search"], "any"), text: { sample: "agentName" }, optional: true },
    { id: "find-open", action: "open-item", intent: "navigate", say: "Opening the practice agent", target: T(undefined, name, [], "main"), timeoutMs: 15_000 },
  ];
}

export const SET_INSTRUCTIONS = Object.freeze([
  { id: "instructions-type", action: "type", intent: "type", say: "Setting the instructions", note: "Set the agent's instructions from the lab", target: T("textbox", "Agent instructions", ["Instructions", "Add instructions", "Edit instructions", "Give your agent instructions", "Instructions for your agent"], "main"), text: { sample: "instructions" } },
  { id: "instructions-save", action: "confirm", intent: "confirm", say: "Saving the instructions", note: "Saved the agent", target: T("button", "Save", ["Save agent", "Save changes", "Save icon"], "any"), soft: true },
  // The Save button is available only while there is something unsaved: it being unavailable again is the proof of the save.
  { id: "instructions-saved", action: "verify", say: "Checking that the instructions were saved", target: T("button", "Save", ["Save agent", "Save changes", "Save icon"], "any"), expect: { disabled: true }, timeoutMs: 8000 },
]);

/** Add a public website as a knowledge source: open Add knowledge, choose Public websites, type the address, Add, then Add to agent. */
export const ADD_WEBSITE_KNOWLEDGE = Object.freeze([
  { id: "knowledge-open", action: "open", intent: "open", say: "Opening Add knowledge", target: T("button", "Add knowledge", ["Add knowledge source", "Add a knowledge source", "+ Add knowledge"], "main"), expect: { dialog: true } },
  { id: "knowledge-source", action: "choose", intent: "choose", say: "Choosing a public website", target: T("button", "Add Public websites", ["Public websites", "Public website", "Website", "Websites"], "dialog") },
  // The address field stays off while "Search all websites" is on: turn it off so a particular website can be added.
  { id: "knowledge-all-off", action: "choose", intent: "choose", say: "Choosing one website instead of all websites", target: T("switch", "Search all websites", ["All websites"], "dialog"), onlyIfOn: true, optional: true },
  { id: "knowledge-url", action: "type", intent: "type", say: "Typing the website address", note: "Added a public website as knowledge", target: T("textbox", "Add public websites", ["Website URL", "URL", "Enter a website URL", "Website address", "Public website URL", "Add a website URL"], "dialog"), text: { sample: "website" } },
  { id: "knowledge-add-url", action: "confirm", intent: "confirm", say: "Adding the website to the list", target: T("button", "Add", [], "dialog"), soft: true },
  { id: "knowledge-add", action: "confirm", intent: "confirm", say: "Adding the knowledge source", note: "Added a public website as knowledge", target: T("button", "Add to agent", ["Add knowledge source"], "dialog") },
  { id: "knowledge-closed", action: "wait-for", say: "Waiting for the knowledge source to be added", timeoutMs: 15_000, expect: { noDialog: true } },
  // The agent keeps the knowledge only after it is saved (the same Save as for the instructions): its going inactive is the proof, and the listed item is the second proof.
  { id: "knowledge-save", action: "confirm", intent: "confirm", say: "Saving the agent", note: "Saved the agent", target: T("button", "Save", ["Save agent", "Save changes", "Save icon"], "any"), soft: true, optional: true },
  { id: "knowledge-saved", action: "verify", say: "Checking that the knowledge was saved", target: T("button", "Save", ["Save agent", "Save changes", "Save icon"], "any"), expect: { disabled: true }, timeoutMs: 10_000 },
  { id: "knowledge-listed", action: "wait-for", say: "Checking that the website is listed as knowledge", expect: { removable: true }, timeoutMs: 25_000, retries: 0 },
]);

/** Publish only the practice agent, once, to its default state: open the dialog, prove it is the plain one, click Publish agent a single time, and wait for the product's own confirmation. */
export const PUBLISH_AGENT = Object.freeze([
  { id: "publish-open", action: "open", intent: "open", say: "Opening the Publish dialog", target: T("button", "Publish", [], "header"), expect: { dialog: true } },
  // Only the plain dialog (an Add channel button and Publish agent, nothing chosen, no warning) is confirmed; any other control stops the run.
  { id: "publish-plain", action: "verify", say: "Checking that the Publish dialog is the plain one", target: T("button", "Publish agent", [], "dialog"), expect: { dialogControls: ["Close", "Cancel", "Dismiss", "Close dialog", "Add channel", "Publish agent"], dialogRequired: ["Publish agent"] }, timeoutMs: 8000 },
  { id: "publish-confirm", action: "confirm", intent: "confirm", say: "Publishing the practice agent", note: "Published the practice agent to its default state", target: T("button", "Publish agent", [], "dialog"), once: "publish", retries: 0, timeoutMs: 20_000, soft: true },
  { id: "publish-wait", action: "wait-for", say: "Waiting for the publish confirmation", expect: { text: ["published"] }, timeoutMs: 60_000, retries: 0 },
]);

// ── Show: the steps that put a screen into the state a picture needs ────────

export const OPEN_PUBLISH_DIALOG = Object.freeze([{ id: "publish-open", action: "open", intent: "open", say: "Opening the Publish dialog", target: T("button", "Publish", ["Publish agent"], "header"), expect: { dialog: true } }]);
export const OPEN_ADD_KNOWLEDGE = Object.freeze([{ id: "knowledge-open", action: "open", intent: "open", say: "Opening Add knowledge", target: T("button", "Add knowledge", ["Add knowledge source", "Add a knowledge source", "+ Add knowledge"], "main"), expect: { dialog: true } }]);
export const OPEN_ADD_TOOL = Object.freeze([{ id: "tool-open", action: "open", intent: "open", say: "Opening Add a tool", target: T("button", "Add tool", ["Add a tool", "Add tools", "Add an action", "Add action"], "main"), expect: { dialog: true } }]);
export const OPEN_ADD_SKILL = Object.freeze([{ id: "skill-open", action: "open", intent: "open", say: "Opening Add a skill", target: T("button", "Add skill", ["Add a skill", "Add skills"], "main"), expect: { dialog: true } }]);
// The model list is a menu that opens beside the button, so the button being open is the proof.
export const OPEN_MODEL_LIST = Object.freeze([{ id: "model-open", action: "open", intent: "open", say: "Opening the model list", target: T("button", "Model: Auto", ["Model", "Select a model", "Choose a model", "Model selector", "Change model", "Agent model"], "main") }]);

/** Ask the test pane a question (the lab's own, an out-of-scope one, or the plain request that shows a refusal) and wait for the finished answer. */
export function askSteps({ outOfScope = false, openTest = false, question = null } = {}) {
  const sample = question === "guardrail" ? "guardrail" : question === "outOfScope" || outOfScope ? "outOfScope" : "question";
  return [
    ...(openTest ? [{ id: "test-open", action: "open", intent: "open", say: "Opening the test pane", optional: true, target: T("button", "Test", ["Test your agent", "Test agent", "Open test pane", "Test pane"], "any"), skipIfPresent: CHAT_INPUT }] : []),
    { id: "ask-type", action: "type", intent: "type", say: "Typing a sample question in the test pane", target: CHAT_INPUT, text: { sample } },
    { id: "ask-send", action: "send", intent: "send", say: "Asking the test pane a sample question", target: T("button", "Send", ["Send message", "Submit", "Submit message", "Send (Enter)", "Ask", "Send prompt"], "chat") },
    { id: "ask-wait", action: "wait-answer", say: "Waiting for the answer to finish" },
  ];
}

/**
 * Bring up a panel of the test pane beside the answer (the activity map). Only a view is opened: nothing is changed and nothing is saved.
 * A panel that is already showing is left as it is, and a control that is not there is not an error (the picture is then judged by its landmarks).
 */
export function panelSteps(names, label) {
  const list = (Array.isArray(names) ? names : []).filter(Boolean);
  if (!list.length) return [];
  const [name, ...alt] = list;
  return [{ id: "panel-open", action: "open", intent: "open", say: `Opening the ${label || name}`, note: `Opened the ${label || name}`, optional: true, onlyIfOff: true, target: T(undefined, name, alt, "any") }];
}


// In the newer layout the agent's settings are behind the header's More options menu.
export const OPEN_AGENT_SETTINGS = Object.freeze([
  { id: "settings-menu", action: "open", intent: "open", say: "Opening the agent's menu", target: T("button", "More options", ["Agent options", "Options"], "header"), expect: { dialog: true } },
  { id: "settings-open", action: "choose", intent: "choose", say: "Opening the agent settings", target: T("menuitem", "Settings", ["Agent settings", "Open settings"], "any") },
]);

/** The Memory switch of the Build tab, turned on only when it is off, then saved when the product asks for a save (the switch alone did not persist in a real run). */
export const MEMORY_ON = Object.freeze([
  { id: "memory-on", action: "choose", intent: "choose", say: "Turning Memory on", note: "Turned Memory on", target: T("switch", "Enable memory (preview)", ["Memory", "Enable memory", "Agent memory"], "main"), onlyIfOff: true },
  { id: "memory-save", action: "confirm", intent: "confirm", say: "Saving the agent", note: "Saved the agent", target: T("button", "Save", ["Save agent", "Save changes", "Save icon"], "any"), soft: true, optional: true },
  { id: "memory-saved", action: "verify", say: "Checking that Memory was saved", target: T("button", "Save", ["Save agent", "Save changes", "Save icon"], "any"), expect: { disabled: true }, timeoutMs: 8000 },
]);

/** Generative orchestration in the classic layout's Settings page (a radio). */
export const CLASSIC_ORCHESTRATION = Object.freeze([
  { id: "genai-tab", action: "select-tab", say: "Opening the Generative AI tab", target: T("tab", "Generative AI", ["Orchestration", "Generative"], "tablist") },
  { id: "genai-yes", action: "choose", intent: "choose", say: "Turning generative orchestration on", note: "Turned generative orchestration on", target: T("radio", "Yes", ["Generative", "Use generative AI orchestration"], "main"), onlyIfOff: true, optional: true },
]);

/** Evaluate: open the new-evaluation form (nothing is saved or run: a run and a generated data set use Copilot Credits). */
export const OPEN_NEW_EVALUATION = Object.freeze([
  { id: "eval-new", action: "open", intent: "open", say: "Opening the new evaluation form", target: T("button", "Create your first evaluation", ["New evaluation", "Create evaluation", "Create an evaluation", "Create a test set", "Add evaluation"], "main") },
]);

/**
 * One evaluation test set with one sample question, written by hand ("Or, write some questions yourself"). It is saved with Save and never run:
 * a run, a generated question set, and a quick conversation set all use Copilot Credits, so none of them is ever clicked.
 * The names come from Microsoft Learn ("Create a test set for an agent"); none of this has been seen on a real tenant yet.
 */
export const CREATE_TEST_SET = Object.freeze([
  ...OPEN_NEW_EVALUATION,
  { id: "testset-manual", action: "choose", intent: "choose", say: "Choosing to write one question by hand", target: T(undefined, "Or, write some questions yourself", ["Write some questions yourself", "Write questions yourself", "Write conversations manually", "Add manually", "Write manually", "Write"], "any") },
  { id: "testset-question", action: "type", intent: "type", say: "Typing one sample question", note: "Added one sample question to a new evaluation test set", target: T("textbox", "Question", ["Enter a question", "Add a question", "Write a question", "Type a question"], "any"), text: { sample: "question" } },
  { id: "testset-name", action: "type", intent: "type", say: "Naming the test set", optional: true, target: T("textbox", "Name", ["Test set name", "Evaluation name", "Enter a name"], "any"), text: { literal: "Lab sample test set" } },
  { id: "testset-save", action: "confirm", intent: "confirm", say: "Saving the test set (without running it)", note: "Saved the evaluation test set without running it", target: T("button", "Save", ["Save test set", "Save evaluation", "Save icon"], "any"), soft: true },
  { id: "testset-saved", action: "wait-for", say: "Checking that the test set was saved", expect: { absent: ["Create your first evaluation"] }, timeoutMs: 15_000, retries: 0 },
]);

/** The first item of the page open now (a knowledge source, a tool, a topic): opened to show its details and left without changing it. */
export const OPEN_FIRST_ITEM = Object.freeze([{ id: "item-open", action: "open-item", intent: "navigate", say: "Opening the first item to show its details", note: "Opened the first item to show its details", expect: { panel: true }, timeoutMs: 8000 }]);

/** Monitor: the Sessions list, read only. */
export const MONITOR_SESSIONS = Object.freeze([
  // "See all (0)" is off until people have used a published agent in a channel: an empty list is not a picture of sessions.
  { id: "sessions-any", action: "wait-for", say: "Checking that the agent has sessions to show", expect: { absent: ["See all (0)"] }, timeoutMs: 3000, retries: 0 },
  { id: "sessions-open", action: "open", intent: "open", say: "Opening the sessions list", target: T("button", "See all", [], "main") },
]);

/** A tab inside the page open now (a settings tab such as Safety & access), selected by its own name. A tab that is asked for must be there: a picture of the wrong tab is not a picture of it. */
export function innerTabSteps(names, { required = false } = {}) {
  const list = (Array.isArray(names) ? names : [names]).filter(Boolean);
  if (!list.length) return [];
  const [name, ...alt] = list;
  return [{ id: "inner-tab", action: "select-tab", say: `Opening ${name}`, target: T(undefined, name, alt, "any"), ...(required ? {} : { optional: true }) }];
}

/** The tab of the Agent settings dialog a picture is about (the dialog opens on Agent details), from the words of the picture. */
export function settingsTabFor(words) {
  const text = String(words || "").toLowerCase();
  if (/\b(?:safety|access|authentication|authenticate|security|sharing|privacy)\b/.test(text)) return ["Safety & access", "Safety and access"];
  if (/\b(?:moderation|generative|orchestration|model|behavior|behaviour|web search|ai)\b/.test(text)) return ["AI + behavior", "AI and behavior", "Generative AI"];
  if (/\b(?:greeting|prompts?|starters?)\b/.test(text)) return ["Greeting & prompts", "Greeting and prompts"];
  if (/\b(?:advanced|solution|schema|language|telemetry)\b/.test(text)) return ["Advanced"];
  return null;
}
