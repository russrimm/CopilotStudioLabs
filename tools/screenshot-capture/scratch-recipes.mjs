// The steps of the lab walkthrough, as plain data: the same declarative steps a recorded recipe holds (see setup-steps.mjs),
// written against the product's own labels, with alternates for renamed buttons, for the NEWER agent layout (Build,
// Preview, Evaluate, and Monitor tabs) and the classic layout (a side navigation) as a fallback. The companion runs them
// through the executor, which checks every control against the action tiers before it touches it and proves each step
// did something, so a label that changed is a diagnosed failure and never a wrong picture.
//
// Two kinds of steps: `prepare` steps change the practice agent (create it, set its instructions, add knowledge, publish)
// and run once, then are remembered; `show` steps only put a screen into the state a picture needs and run for every shot.

import { CREATE_OPTIONS, MICROSOFT_COPILOT, STANDARD, splitTaggedName } from "./harness.mjs";
import { sanitizeSteps } from "./setup-steps.mjs";

const T = (role, name, alt = [], within = "any", section = "") => ({ ...(role ? { role } : {}), name, ...(alt.length ? { alt } : {}), within, ...(section ? { section } : {}) });
const TEST_INPUT = ["Chat message input", "Type your message", "Ask a question or describe what you need", "Type a message", "Ask a question", "Send a message", "Message", "Ask anything"];
const CHAT_INPUT = T("textbox", TEST_INPUT[0], TEST_INPUT.slice(1), "chat");
// The Standard agent's Test panel (observed 2026-11-26): a panel headed "Test your agent" on every tab, with a text box named "Ask a question or describe what you need, <agent name>"
// and a Send button. The panel is told apart from the Instructions editor (also a "describe" box) by its heading, never by a loose name.
export const CLASSIC_TEST_SECTION = "Test your agent";
const CLASSIC_CHAT_INPUT = T("textbox", "Ask a question or describe what you need", [], "any", CLASSIC_TEST_SECTION);

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

/**
 * How long the Agents list is waited for to draw its "More create options" button. A real list draws its controls 15 to 30 seconds after its address opens
 * (observed 2026-11-27), so the default wait of a step (7 seconds) is far too short: a button that is not there yet must be waited for, never replaced by another control.
 */
export const CREATE_MENU_WAIT_MS = 60_000;

/**
 * How the new-agent flow is started for a harness. The Agents list has a "More create options" button whose menu offers "Agent, uses Copilot Credits" (the
 * Microsoft Copilot harness), "Customer conversation agent, uses Copilot Credits", and "Agent, Standard" (observed on a real tenant, 2026-11-24; nothing was
 * created). A Standard practice agent starts from "Agent, Standard" and a Microsoft Copilot one from "Agent, uses Copilot Credits"; the computer never builds
 * a Customer Conversation agent. NOT VERIFIED on a real tenant: what the flow shows after an option is chosen, so the steps after it are the existing ones
 * (a Name field, then Save or Create), each of which stops with the exact step when its control is not there.
 * The menu step finds "More create options" by its exact name only (waiting for the list to draw) and is OK only when the menu that opened lists the harness's option:
 * a different control or dialog (the lower left "More options", the Account flyout) can never count as the create menu.
 * `fallback` is the older single-button way (the Microsoft Copilot harness only: in the default experience that button makes a Microsoft Copilot agent).
 */
export function createAgentOpenPlan(harness, { waitMs = CREATE_MENU_WAIT_MS } = {}) {
  const option = harness === STANDARD || harness === MICROSOFT_COPILOT ? CREATE_OPTIONS[harness].names[0] : null;
  if (!option) return { menu: null, option: null, fallback: CREATE_AGENT_OPEN };
  const menuName = CREATE_OPTIONS.menu.names[0];
  return {
    option,
    menuName,
    menu: [
      { id: "create-menu", action: "create", intent: "open", exact: true, say: "Opening More create options", note: "Opened the create options on the Agents list", target: T("button", menuName, [], "any"), expect: { dialog: true, menuItems: [option] }, findMs: waitMs, timeoutMs: 20_000, retries: 0 },
      { id: "create-option", action: "create", intent: "choose", exact: true, say: `Choosing ${option}`, note: `Chose ${option} to create the practice agent`, target: T("menuitem", option, [], "any"), timeoutMs: 10_000, retries: 0 },
    ],
    fallback: harness === MICROSOFT_COPILOT ? CREATE_AGENT_OPEN : null,
  };
}

/** Seconds, as a plain number for a sentence. */
const secondsOf = (ms) => Math.max(1, Math.round(Number(ms || 0) / 1000));

/**
 * The plain reason the create menu could not be used, from what the executor saw (a clause: it reads on its own and inside a longer sentence).
 * `menuOpen` is whether a menu or a dialog is open after the failure.
 */
export function createFailureReason({ failed, stage, option, menuName = "More create options", menuOpen = true, waitMs = CREATE_MENU_WAIT_MS }) {
  if (stage === "menu") {
    if (failed?.missing) return `“${menuName}” was not on the Agents list after waiting ${secondsOf(failed.waitedMs || waitMs)} seconds (the list may still have been loading, or this account may not be allowed to create agents)`;
    return failed?.why || `“${menuName}” could not be opened`;
  }
  if (!menuOpen) return `the “${menuName}” menu was not open when “${option}” was to be chosen, so nothing was chosen`;
  if (failed?.missing) return `the “${menuName}” menu is open but does not list “${option}”`;
  return failed?.why || `“${option}” could not be chosen`;
}

/**
 * Start the new-agent flow on the Agents list for a harness: "More create options", then the harness's option; a Microsoft Copilot agent falls back to the older
 * New agent button only when the create menu itself is not there. Returns the executor's result with `via` ("create-option" or "new-agent-button"), and on a
 * failure `stage` ("menu", "option", or "button"), the `option` that was looked for, and a plain `reason` (see createFailureReason), so the message names the exact step.
 */
export async function openCreateFlow({ executor, harness = null, trace = null, log = null, product = "copilot-studio", waitMs = CREATE_MENU_WAIT_MS }) {
  const plan = createAgentOpenPlan(harness, { waitMs });
  let menuReason = "";
  if (plan.menu) {
    const steps = sanitizeSteps(plan.menu, { product });
    // A step the safety rules dropped must never be skipped quietly: the flow would look opened when it was not.
    if (steps.length !== plan.menu.length) return { ok: false, steps: [], failed: { id: "create-option", why: "a safety rule did not allow the step" }, via: "create-option", stage: "option", option: plan.option, reason: "a safety rule did not allow the step" };
    const made = await executor.run(steps);
    if (made.halted || made.ok) {
      trace?.event("create-option", { harness, option: plan.option, ok: Boolean(made.ok) });
      return { ...made, via: "create-option" };
    }
    const stage = made.failed?.id === "create-option" ? "option" : "menu";
    // A menu that is still showing something (a menu, a dialog) is not "not open": the reason tells the two apart.
    const overlays = stage === "option" ? await Promise.resolve(executor.readOverlays?.()).catch(() => null) : null;
    const menuOpen = Array.isArray(overlays) ? overlays.some((d) => d.kind === "menu" || d.kind === "dialog") : true;
    const reason = createFailureReason({ failed: made.failed, stage, option: plan.option, menuName: plan.menuName, menuOpen, waitMs });
    trace?.event("create-option", { harness, option: plan.option, ok: false, stage, missing: Boolean(made.failed?.missing), menuOpen });
    await Promise.resolve(executor.cleanup?.()).catch(() => {});
    // Only an exact "More create options" that is not on the list falls back to the older button: a wrong menu that opened is a failure, never a reason to click something else.
    if (stage !== "menu" || !plan.fallback || !made.failed?.missing) return { ...made, via: "create-option", stage, option: plan.option, reason };
    log?.("  More create options was not on the Agents list, so the older New agent button is used.");
    menuReason = reason;
  }
  const old = await executor.run(sanitizeSteps(plan.fallback, { product }));
  const why = old.failed?.why || "the New agent button could not be used";
  return { ...old, via: "new-agent-button", stage: "button", option: plan.option, reason: menuReason ? `${menuReason}, and the older “New agent” button did not work either (${why})` : why };
}

export const CREATE_AGENT_FILL = Object.freeze([
  { id: "create-name", action: "type", intent: "type", say: "Naming the agent", note: "Named the practice agent", target: T("textbox", "Name", ["Agent name", "Name your agent", "Enter a name", "Give your agent a name"], "any"), text: { sample: "agentName" }, timeoutMs: 20_000 },
]);

export const CREATE_AGENT_COMMIT = Object.freeze([
  { id: "create-commit", action: "create", intent: "confirm", say: "Creating the agent", note: "Created the practice agent", target: T("button", "Save", ["Create", "Create agent", "Save agent", "Save icon"], "any"), timeoutMs: 20_000, retries: 0 },
]);

/**
 * Find the practice agent in the Agents list by its own name: filter the list, then open its row. Nothing is changed. The row is the agent's "Open <name>" button (observed on the real
 * list; `by: "name"` is the older list, where the name itself is the link), found by that exact name only, and a name that two rows have is never guessed. The top bar's "Open account
 * menu for <person>" can never be a row: only "Open " followed by the agent's whole name is.
 */
export function findAgentSteps(name, { by = "open-button", waitMs = 15_000 } = {}) {
  const rowName = by === "name" ? name : `Open ${name}`;
  return [
    { id: "find-search", action: "type", intent: "type", say: "Looking for the practice agent in the list", target: T("searchbox", "Search agents by name", ["Search agents", "Search"], "any"), text: { literal: name }, optional: true },
    { id: "find-open", action: "open-item", intent: "navigate", say: "Opening the practice agent", target: T(undefined, rowName, [], "main"), exact: true, unique: true, findMs: waitMs, timeoutMs: 15_000 },
  ];
}

export const SET_INSTRUCTIONS = Object.freeze([
  { id: "instructions-type", action: "type", intent: "type", say: "Setting the instructions", note: "Set the agent's instructions from the lab", target: T("textbox", "Agent instructions", ["Instructions", "Add instructions", "Edit instructions", "Give your agent instructions", "Instructions for your agent"], "main"), text: { sample: "instructions" } },
  { id: "instructions-save", action: "confirm", intent: "confirm", say: "Saving the instructions", note: "Saved the agent", target: T("button", "Save", ["Save agent", "Save changes", "Save icon"], "any"), soft: true },
  // The Save button is available only while there is something unsaved: it being unavailable again is the proof of the save.
  { id: "instructions-saved", action: "verify", say: "Checking that the instructions were saved", target: T("button", "Save", ["Save agent", "Save changes", "Save icon"], "any"), expect: { disabled: true }, timeoutMs: 8000 },
]);

// ── The Standard (Classic) agent page, as OBSERVED on a real tenant on 2026-11-26 (read only) ─────────────────────────────────────────────
//
// The agent page has a TAB STRIP across the top (Overview, Knowledge, Tools, Agents, Topics, and an overflow tab named "N more options" whose menu holds Activity, Evaluation,
// Monitor, and Channels; at 1440 pixels wide Activity and Evaluation are tabs of their own and the overflow says "+2 more options"), the top bar buttons Search your agent, Publish,
// Settings, Options, and Test, and the Test your agent panel on the right of every tab. There is no side navigation. Every name below was read from the real page.

/** The tabs a Standard agent shows at every width. */
export const CLASSIC_DIRECT_TABS = Object.freeze(["Overview", "Knowledge", "Tools", "Agents", "Topics"]);
/** The tabs that can sit in the overflow menu: Activity and Evaluation fall into it at a narrower window, Monitor and Channels are in it at every width seen. */
export const CLASSIC_OVERFLOW_TABS = Object.freeze(["Activity", "Evaluation", "Monitor", "Channels"]);
/** The overflow control is named by how many tabs it holds ("4 more options", "+2 more options"); a plain "More options" is the lower left menu and is never this control. */
export const CLASSIC_OVERFLOW_NAMES = Object.freeze(["2 more options", "3 more options", "4 more options", "5 more options", "6 more options", "1 more option"]);

const slug = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * Open a tab of a Standard agent by its name. A tab that is on the strip is clicked; one that is not (it is in the overflow menu at this window width) is reached by opening the
 * overflow control and choosing the item, so the same steps work at every width. The tab strip being drawn is waited for first (it takes about six seconds after the agent opens).
 * Overview, Knowledge, Tools, Agents, and Topics are always on the strip and are clicked directly.
 */
export function classicTabSteps(tab, { alt = [] } = {}) {
  const name = String(tab);
  const id = `cl-${slug(name)}`;
  const names = [name, ...alt];
  const onStrip = T("tab", name, alt, "tablist");
  if (!CLASSIC_OVERFLOW_TABS.includes(name)) {
    return [
      { id: `${id}-tab`, action: "select-tab", say: `Opening the ${name} tab`, target: onStrip, findMs: 20_000 },
      { id: `${id}-tab-open`, action: "verify", target: onStrip, expect: { selected: true }, timeoutMs: 8000 },
    ];
  }
  const [more, ...moreAlt] = CLASSIC_OVERFLOW_NAMES;
  return [
    { id: `${id}-tabs`, action: "verify", say: "Waiting for the tab strip to be drawn", target: T("tab", "Overview", [], "tablist"), timeoutMs: 20_000 },
    // On the strip: click it. Not on the strip: these steps are left out, and the overflow steps below run instead.
    { id: `${id}-tab`, action: "select-tab", say: `Opening the ${name} tab`, target: onStrip, skipUnlessPresent: onStrip, findMs: 1500 },
    { id: `${id}-more`, action: "reveal", intent: "open", say: `Opening the more options menu to reach ${name}`, note: `Opened the more options menu to reach ${name}`, target: T(undefined, more, moreAlt, "any"), expect: { dialog: true }, skipIfPresent: onStrip, findMs: 8000, timeoutMs: 5000 },
    { id: `${id}-item`, action: "open-nav", say: `Choosing ${name} in the menu`, target: { role: "menuitem", name: names[0], ...(names.length > 1 ? { alt: names.slice(1) } : {}), within: "any" }, skipIfPresent: onStrip, timeoutMs: 6000 },
    // The chosen item may or may not be drawn as a tab afterwards: it is checked only when it is a tab.
    { id: `${id}-tab-open`, action: "verify", target: onStrip, expect: { selected: true }, skipUnlessPresent: onStrip, timeoutMs: 8000 },
  ];
}

const CLASSIC_EDITOR_NAME = "Describe what you want this agent to do, its tone, and rules";
const CLASSIC_EDITOR = T("textbox", CLASSIC_EDITOR_NAME, [], "main", "Instructions");
const CLASSIC_SAVE = T("button", "Save", [], "main", "Instructions");

/**
 * Set the instructions of a Standard agent (observed 2026-11-26). The Overview tab's Instructions card has a button named "Edit Instructions". It opens an inline editor: a text box
 * (a contenteditable box with the role textbox) named "Describe what you want this agent to do, its tone, and rules", and the buttons Cancel and Save. Save is DISABLED until the text
 * changes (typing or filling enables it; clearing the text disables it again). The Test panel has a second box that also says "describe", so the editor is named by its full name and by
 * the Instructions card, and the text is read back from it before anything is saved.
 *   1. click Edit Instructions (the page draws its buttons several seconds after its tabs, so it is waited for);
 *   2. check that the editor is open, type the lab's instructions into it, and read the text back;
 *   3. check that Save became available, and if it did not say so plainly ("Save is disabled: the text did not register in the Instructions editor");
 *   4. click Save;
 *   5. check that Save is disabled again (or the editor closed): the product's own proof that the change was saved.
 */
export const SET_INSTRUCTIONS_CLASSIC = Object.freeze([
  { id: "instr-edit", action: "open", intent: "open", say: "Opening the Instructions editor", note: "Opened the Instructions editor", target: T("button", "Edit Instructions", [], "main"), skipIfPresent: CLASSIC_EDITOR, findMs: 25_000, timeoutMs: 8000 },
  { id: "instr-editor", action: "verify", say: "Checking that the Instructions editor is open", target: CLASSIC_EDITOR, timeoutMs: 10_000 },
  { id: "instr-type", action: "type", intent: "type", say: "Setting the instructions", note: "Set the agent's instructions from the lab", target: CLASSIC_EDITOR, text: { sample: "instructions" } },
  { id: "instr-enabled", action: "verify", say: "Checking that the text registered (Save is available)", target: CLASSIC_SAVE, expect: { enabled: true }, ifDisabled: "the text did not register in the Instructions editor", timeoutMs: 6000 },
  { id: "instr-save", action: "confirm", intent: "confirm", say: "Saving the instructions", note: "Saved the agent", target: CLASSIC_SAVE, soft: true, ifDisabled: "the text did not register in the Instructions editor" },
  { id: "instr-saved", action: "verify", say: "Checking that the instructions were saved", target: CLASSIC_SAVE, expect: { disabled: true }, orGone: true, timeoutMs: 10_000 },
]);

/**
 * Leave the Instructions editor without saving, after a step failed with text in it: Cancel, then Discard on the confirmation that follows (a dialog with Close, Discard, and Cancel,
 * observed 2026-11-26). Both are optional (a closed editor, or no confirmation, is fine), so this never fails a run.
 */
export const ABANDON_INSTRUCTIONS_EDIT = Object.freeze([
  { id: "instr-cancel", action: "click", intent: "close", say: "Closing the Instructions editor without saving", note: "Closed the Instructions editor", target: T("button", "Cancel", [], "main", "Instructions"), skipUnlessPresent: CLASSIC_EDITOR, optional: true, retries: 0 },
  { id: "instr-discard", action: "discard", intent: "close", say: "Leaving without saving", note: "Left the unsaved Instructions text", target: T("button", "Discard", [], "dialog"), optional: true, retries: 0 },
]);

/** The top bar's Settings button opens a full page (.../manage/advancedSettings) with a list of links on the left; the page has its own Close and Save. */
export const CLASSIC_SETTINGS_LINKS = Object.freeze(["Generative AI", "Agent details", "Security", "Connected Agents", "Connection Settings", "Authoring Canvas", "Entities", "Skills", "Voice", "Languages", "Language understanding", "Component collections", "Advanced"]);
export const CLASSIC_OPEN_SETTINGS = Object.freeze([
  { id: "classic-settings-open", action: "open-nav", say: "Opening Settings", note: "Opened the agent's Settings page", target: T("button", "Settings", [], "any"), expect: { urlPath: "advancedSettings" }, findMs: 20_000, timeoutMs: 8000 },
]);

/** The link of the Settings page a picture is about, from the words of the picture (null: the page opens on its first link and is shown as it is). */
export function classicSettingsLinkFor(words) {
  const text = String(words || "").toLowerCase();
  const table = [
    [/\b(?:generative|orchestration|moderation|model|web search)\b/, "Generative AI"],
    [/\b(?:authentication|security|access|sharing|privacy|data loss)\b/, "Security"],
    [/\bconnected agents?\b/, "Connected Agents"],
    [/\bconnection settings?\b/, "Connection Settings"],
    [/\bauthoring canvas\b/, "Authoring Canvas"],
    [/\bentities\b/, "Entities"],
    [/\bskills?\b/, "Skills"],
    [/\bvoice\b/, "Voice"],
    [/\blanguage understanding\b/, "Language understanding"],
    [/\blanguages?\b/, "Languages"],
    [/\bcomponent collections?\b/, "Component collections"],
    [/\b(?:advanced|solution|schema)\b/, "Advanced"],
    [/\b(?:agent details|agent name)\b/, "Agent details"],
  ];
  for (const [re, link] of table) if (re.test(text)) return link;
  return null;
}

/** Open one link of the Standard Settings page (the page is already open). */
export function classicSettingsLinkSteps(link) {
  if (!link) return [];
  return [{ id: "classic-settings-link", action: "open-nav", say: `Opening ${link} in Settings`, note: `Opened ${link} in Settings`, target: T(undefined, link, [], "any"), findMs: 10_000, timeoutMs: 6000 }];
}

/**
 * The slots of a Standard (Classic) lab that the walkthrough would take by itself (it has a stage and a recipe family) but whose recipe cannot be written from what was seen on a real
 * tenant. Each one ends as Needs you with its exact reason, and is listed in docs/standard-capture-slots.md with the read-only checks that would settle it. By file name.
 */
export const CLASSIC_UNSEEN_SLOTS = Object.freeze({
  "publish-confirmation.png": "The top bar's Publish button of a Standard agent was never clicked, so whether it opens a dialog or publishes at once, and what its confirmation says, are unknown. A publish is not read-only, so the computer does not guess.",
  "test-agent-panel.png": "This picture needs the Test panel's More menu showing Track between topics. The More button was seen, but its menu items were never read on a Standard agent.",
  "activity-map-plan.png": "This picture needs the activity map. No control for it was seen among the Test panel's buttons (Chat mode, More, Expand test pane, Upload file, Send), so the computer does not guess one.",
  "generative-orchestration-setting.png": "Settings has a Generative AI link on a Standard agent, but the orchestration choice (its control and its current value) was never read, and this picture shows it selected, which is a change. The computer does not guess it.",
  "content-moderation-level.png": "Settings has a Generative AI link on a Standard agent, but the content moderation control inside it was never read, so the computer does not guess it.",
  "grounding-general-knowledge-off.png": "Settings has a Generative AI link on a Standard agent, but its knowledge controls (allow ungrounded responses, use information from the web) were never read, and this picture turns them off and saves, which is a change.",
  "security-authentication-page.png": "Settings has a Security link on a Standard agent, but its Authentication entry and its options were never read, so the computer does not guess them.",
  "entra-auth-config.png": "This picture needs Authenticate manually selected (a change) and an app registration that a person prepares. The fields of that form were never read on a Standard agent.",
  "knowledge-sharepoint-add.png": "The Add knowledge dialog of a Standard agent has not been seen yet (its tiles, fields, and buttons), so a recipe cannot pick a source or type an address. It also needs a SharePoint site that the practice agent may read.",
  "knowledge-answer-citation.png": "This picture needs a SharePoint knowledge source on the practice agent, and the Add knowledge dialog that adds one has not been seen on a Standard agent yet. Without that source the answer has no citation.",
  "knowledge-sources-list.png": "This picture needs documents and a public website already listed on the Knowledge tab. The computer never uploads files, and the Add knowledge dialog that adds a website has not been seen on a Standard agent yet.",
  "tool-add-connector.png": "The Add a tool dialog of a Standard agent has not been seen yet (its categories, connector list, and buttons), so a recipe cannot pick a category or a tool.",
  "analytics-dashboard.png": "Monitor is in the more options menu of a Standard agent's tab strip, but the Monitor page itself (its reporting period and its sections) was never read, and a practice agent that was only tested shows empty metrics.",
  "eval-test-set.png": "The Evaluation tab of a Standard agent was seen, but its new-evaluation form, test methods, and test set list were not, and a test set has to be saved to appear, which is a write.",
});

/** The plain reason a Standard slot ends as Needs you, by its file name (null when it has a recipe or another reason). A harness-tagged library name (x.classic.png) counts as the plain one. */
export const classicUnseenReason = (filename) => CLASSIC_UNSEEN_SLOTS[splitTaggedName(String(filename || "")).base] || null;

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
/** The Standard Overview tab's model list is a combobox ("Select your agent's model", read as "Select a model" in an older read): opened to show the list, and left as it is. */
export const CLASSIC_OPEN_MODEL_LIST = Object.freeze([{ id: "classic-model-open", action: "open", intent: "open", say: "Opening the model list", note: "Opened the model list", target: T("combobox", "Select your agent's model", ["Select a model"], "main"), findMs: 20_000 }]);

// The model list is a menu that opens beside the button, so the button being open is the proof.
export const OPEN_MODEL_LIST = Object.freeze([{ id: "model-open", action: "open", intent: "open", say: "Opening the model list", target: T("button", "Model: Auto", ["Model", "Select a model", "Choose a model", "Model selector", "Change model", "Agent model"], "main") }]);

/** Ask the test pane a question (the lab's own, an out-of-scope one, or the plain request that shows a refusal) and wait for the finished answer. */
export function askSteps({ outOfScope = false, openTest = false, question = null, classic = false } = {}) {
  const sample = question === "guardrail" ? "guardrail" : question === "outOfScope" || outOfScope ? "outOfScope" : "question";
  // The Standard agent's Test panel is told apart by its heading (it is on every tab), not by a loose name: the Instructions editor also says "describe".
  const input = classic ? CLASSIC_CHAT_INPUT : CHAT_INPUT;
  const send = classic ? T("button", "Send", ["Send message", "Submit", "Submit message"], "any", CLASSIC_TEST_SECTION) : T("button", "Send", ["Send message", "Submit", "Submit message", "Send (Enter)", "Ask", "Send prompt"], "chat");
  return [
    ...(openTest ? [{ id: "test-open", action: "open", intent: "open", say: "Opening the test pane", optional: true, target: T("button", "Test", ["Test your agent", "Test agent", "Open test pane", "Test pane"], "any"), skipIfPresent: input }] : []),
    { id: "ask-type", action: "type", intent: "type", say: "Typing a sample question in the test pane", target: input, text: { sample } },
    { id: "ask-send", action: "send", intent: "send", say: "Asking the test pane a sample question", target: send },
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
