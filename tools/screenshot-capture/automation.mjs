// Which screenshots the computer can take by itself, and why the others need a person. Pure functions only (no files, no
// browser), shared by the portal (which labels every shot when a plan is built and writes the dry plan) and the companion
// (which decides again on this computer before it touches a page).
//
// A shot is in one of two states:
//   automatic   the computer takes it, with a RECIPE FAMILY: a generic, parameterized set of steps (ask the test pane a question
//               and open a panel, open a dialog and cancel it, open the first item, check the screen by its landmarks). A family says
//               whether it was ever proven on a real tenant (`verified`) and how the finished screen is judged (`review`): a recipe
//               that was never proven is tried, checked by what the screen shows, and the picture is saved as "Needs review" (never
//               accepted blindly) when the screen is not what it expects.
//   person      the computer does not try it, for ONE reason from a small fixed set (REASONS). The reason is shown on the shot, with
//               the exact steps to take.
//
// Nothing here decides what a click is allowed to do: that is the action tiers in guard.mjs, checked again at every click.

export const AUTOMATION_VERSION = 1;

const clean = (value, max = 200) => String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/**
 * Why a shot needs a person: the fixed set. `label` is the words on the shot's card; `noun` is the pair of words the summary counts
 * ("3 admin screens"); `steps` are the exact steps to take. The shot's own instructions are shown after them.
 */
export const REASONS = Object.freeze({
  credits: {
    code: "credits",
    label: "Needs Copilot Credits",
    noun: ["Copilot Credits run", "Copilot Credits runs"],
    why: "Running or generating an evaluation uses Copilot Credits, and the computer does not spend credits for you.",
    steps: ["Open your practice agent and the Evaluate tab.", "Run the evaluation yourself. This spends Copilot Credits from your demo tenant.", "When the results show, press Capture this screen."],
  },
  admin: {
    code: "admin",
    label: "Needs an admin screen",
    noun: ["admin screen", "admin screens"],
    why: "This is a tenant, environment, admin, security, or billing screen, and the computer never opens or changes those.",
    steps: ["Sign in to the admin center with an account that has admin access.", "Open the screen the lab describes. Change nothing.", "Press Capture this screen."],
  },
  "other-product": {
    code: "other-product",
    label: "Needs another Microsoft product",
    noun: ["other product", "other products"],
    why: "This screen is in another product (Microsoft 365 Copilot Agent Builder, Power Automate, Teams, Microsoft Foundry, Visual Studio Code). The computer builds its practice agent only in Copilot Studio, so it does not create or open anything there.",
    steps: ["Open the other product in the browser the companion opened, and sign in there.", "Open the screen the lab describes.", "Press Capture this screen, or choose Show me once so the computer can learn the steps."],
  },
  "real-users": {
    code: "real-users",
    label: "Needs real users in a channel",
    noun: ["channel with real users", "channels with real users"],
    why: "This shows a channel (Teams, a website, email) or sessions that appear only after people use the published agent, and the computer only ever publishes to the agent's own default channel.",
    steps: ["Publish the agent to the channel yourself and have someone use it.", "Open the screen the lab describes.", "Press Capture this screen."],
  },
  connection: {
    code: "connection",
    label: "Needs your own connection",
    noun: ["connection", "connections"],
    why: "This needs a connection, credentials, or data of your own that you must allow, and the computer never creates connections or signs in to other services.",
    steps: ["Add the tool, connection, or data source yourself and sign in to the other service when it asks.", "Use it as the lab describes.", "Press Capture this screen."],
  },
  "other-agent": {
    code: "other-agent",
    label: "Needs another agent",
    noun: ["other agent", "other agents"],
    why: "Connected agents involve other agents, and the computer never touches an agent that is not its own practice agent.",
    steps: ["Set up the second agent yourself.", "Connect it as the lab describes.", "Press Capture this screen."],
  },
  files: {
    code: "files",
    label: "Needs your sample files",
    noun: ["file step", "file steps"],
    why: "This step needs sample files in a SharePoint library or a file upload, and the computer never uploads files.",
    steps: ["Put the sample files in place.", "Open the screen the lab describes.", "Press Capture this screen."],
  },
  "build-first": {
    code: "build-first",
    label: "Needs something built first",
    noun: ["screen that needs something built first", "screens that need something built first"],
    why: "This shows a prompt, a topic, or a flow that a person builds. The computer does not create these: a prompt is shared across the environment, and a topic or flow needs editing screens it has not seen yet.",
    steps: ["Build the prompt, topic, or flow in your practice agent as the lab describes.", "Open the screen the lab describes.", "Press Capture this screen."],
  },
  "error-state": {
    code: "error-state",
    label: "Needs an error to happen first",
    noun: ["error state", "error states"],
    why: "This shows an error or a blocked state, and the computer never causes one on purpose.",
    steps: ["Set the screen up yourself so the error or block shows.", "Press Capture this screen."],
  },
  "outside-browser": {
    code: "outside-browser",
    label: "Outside the browser",
    noun: ["outside the browser", "outside the browser"],
    why: "This screen is outside the browser (a terminal or Visual Studio Code).",
    steps: ["Capture it with an operating system screenshot tool.", "Upload the picture in the Screenshot Center."],
  },
  unseen: {
    code: "unseen",
    label: "This screen has not been seen in the product yet",
    noun: ["screen not seen in the product yet", "screens not seen in the product yet"],
    why: "The computer has not seen this screen in the real product, so it does not guess which controls to use.",
    steps: ["Choose Show me once and set the screen up the way you normally would, so the computer learns the steps.", "Or choose Retake guided and press Capture this screen."],
  },
});

export const REASON_ORDER = Object.freeze(["admin", "other-product", "connection", "other-agent", "real-users", "credits", "files", "build-first", "error-state", "outside-browser", "unseen"]);

/** The reason a walkthrough blocker belongs to (the blocker codes come from walkthrough.mjs). */
export const BLOCKER_REASON = Object.freeze({
  connection: "connection",
  files: "files",
  credits: "credits",
  channel: "real-users",
  admin: "admin",
  "other-product": "other-product",
  "error-state": "error-state",
  "other-agent": "other-agent",
  "build-first": "build-first",
  "outside-agent": "unseen",
  unseen: "unseen",
});

export const reasonInfo = (code) => REASONS[code] || null;

/** "3 admin screens, 2 other products": the counts of a list of reason codes, in the fixed order, as words. */
export function describeReasonCounts(codes) {
  const counts = new Map();
  for (const raw of codes || []) {
    const code = REASONS[raw] ? raw : "unseen";
    counts.set(code, (counts.get(code) || 0) + 1);
  }
  return REASON_ORDER.filter((code) => counts.has(code))
    .map((code) => `${counts.get(code)} ${REASONS[code].noun[counts.get(code) === 1 ? 0 : 1]}`)
    .join(", ");
}

// ── Families ────────────────────────────────────────────────────────────────

/**
 * The recipe families. `maxTier` is the most a family's steps may do (1 = open, ask, close; nothing is saved): the executor is given
 * that ceiling, so a step that would exceed it is refused even in a job that allows a practice agent.
 */
export const FAMILIES = Object.freeze({
  conversation: { id: "conversation", label: "Test conversation", maxTier: 1, summary: "Asks the test pane a sample question, waits for the answer, and opens the panel the picture shows." },
  dialog: { id: "dialog", label: "Dialog first", maxTier: 1, summary: "Opens the dialog by its button label, takes the picture, and cancels it." },
  item: { id: "item", label: "Item details", maxTier: 1, summary: "Opens the first item the practice agent already has and leaves without saving." },
  testset: { id: "testset", label: "Sample test set", maxTier: 2, summary: "Adds one sample question to a new evaluation test set in the practice agent. It never runs it." },
  locate: { id: "locate", label: "Check by landmarks", maxTier: 1, summary: "Opens the closest page and checks it by what it shows; a screen that does not match is saved for review." },
  navigate: { id: "navigate", label: "Move by labels", maxTier: 1, summary: "Moves through the product's own tabs and menus by their visible labels, then checks the screen by what it shows." },
});

export const FAMILY_IDS = Object.freeze(Object.keys(FAMILIES));

/** The things the computer may add to the practice agent beyond the agent itself. The consent card lists each one; the practice report records each one. */
export const OBJECTS = Object.freeze({
  "evaluation-test-set": { id: "evaluation-test-set", label: "One evaluation test set with one sample question (it is never run, so it spends no Copilot Credits)", stage: "testset" },
});

// Panels of the test pane that a picture can show. None of these has been proven on a real tenant yet; the names come from Microsoft Learn
// ("Review agent activity", "Test your agent", "Use the activity trace"). `review` says how the finished screen is judged:
// "landmark" (the panel's own label must be showing, or the picture is saved as Needs review) or "always" (the computer cannot tell
// whether the screen shows what the picture is about, so a person checks every picture).
export const PANELS = Object.freeze({
  "activity-map": { id: "activity-map", label: "Activity map", names: ["Activity map", "Show activity map", "Open activity map"], landmark: "Activity map", review: "landmark" },
  trace: { id: "trace", label: "Activity trace", names: [], landmark: "Activity trace", review: "landmark" },
  citation: { id: "citation", label: "Citations", names: [], landmark: null, review: "always", note: "The computer asked the question and took the picture, but it cannot tell whether the answer shows a citation. Check the picture." },
  refusal: { id: "refusal", label: "Refusal", names: [], landmark: null, review: "always", note: "The computer asked the question and took the picture, but it cannot tell whether the agent refused. Check the picture." },
  "topic-trace": { id: "topic-trace", label: "Track between topics", names: [], landmark: null, review: "always", note: "The computer asked the question and took the picture, but it cannot tell whether Track between topics is on. Check the picture." },
});

/** The dialogs the computer opens and cancels, by the button that opens them. `proven`: seen working on a real tenant. */
export const OPENERS = Object.freeze({
  knowledge: { id: "knowledge", label: "Add knowledge", proven: true },
  tool: { id: "tool", label: "Add a tool", proven: true },
  skill: { id: "skill", label: "Add a skill", proven: true },
  publish: { id: "publish", label: "Publish", proven: true },
  model: { id: "model", label: "the model list", proven: true },
  evaluation: { id: "evaluation", label: "New evaluation", proven: false },
  settings: { id: "settings", label: "Settings", proven: true },
  generic: { id: "generic", label: "the button the lab names", proven: false },
});

const strip = (value) => String(value ?? "").replace(/\*\*/g, "");
const lower = (value) => strip(value).toLowerCase();

/** What a shot is about, in the words a rule reads: the picture's own words and the lab's instructions, separately. */
export function shotFacts(shot) {
  const kind = String(shot?.kind || "").toLowerCase();
  const section = String(shot?.section || "").toLowerCase();
  const feature = String(shot?.featureId || shot?.feature || "").toLowerCase();
  const picture = [shot?.caption, shot?.alt, ...((shot?.callouts || []).map((c) => c.text || c.label))].map(lower).join(" ");
  const instructions = (shot?.instructions || []).map(lower).join(" ");
  return { kind, section, feature, picture, instructions, all: `${picture} ${instructions}` };
}

const TEST_PANE_RE = /\b(?:test pane|test panel|test chat|test your agent|preview tab|try it)\b/;
const ANSWER_RE = /\b(?:answer(?:ed|s)?|response|responds?|reply|refusal|refuses?|conversation|citation|activity map|activity trace)\b/;
const REFUSAL_RE = /\b(?:refus\w*|adversarial|jailbreak|guardrails?|blocked? (?:response|prompt)|safe completion)\b/;

/**
 * Whether a shot shows a test conversation (a question asked in the test pane and its answer), and which panel it shows beside it.
 * @returns {{panel: string|null, question: "question"|"outOfScope"|"guardrail"}|null}
 */
export function conversationOf(facts) {
  const { kind, section, picture, instructions, all } = facts;
  if (kind === "dialog" || kind === "error-state") return null;
  const byKind = kind === "test-result" || section === "test" || section === "preview";
  // A picture that names the test pane and an answer, even when the lab's step only says "Capture ..." ("Guardrail refusal in the Test pane").
  const byWords = kind !== "settings" && TEST_PANE_RE.test(all) && ANSWER_RE.test(picture);
  if (!byKind && !byWords) return null;
  const refusal = REFUSAL_RE.test(picture) || REFUSAL_RE.test(instructions);
  let panel = null;
  if (/\bactivity map\b/.test(all)) panel = "activity-map";
  else if (/\bactivity trace\b/.test(all)) panel = "trace";
  else if (/\btrack(?:ing)? between topics\b/.test(all)) panel = "topic-trace";
  else if (/\bcitations?\b|\bcited\b/.test(picture)) panel = "citation";
  else if (refusal) panel = "refusal";
  const outOfScope = /\b(?:out-of-scope|out of scope|decline|declin|redirect)/.test(all);
  return { panel, question: refusal ? "guardrail" : outOfScope ? "outOfScope" : "question" };
}

const DIALOG_RE = /\b(?:dialog|pop-?up|picker|wizard|gallery)\b/;
const OPENER_LABEL_RE = /^(?:add|new|select|choose|open|manage|configure|browse)\b/i;
const TESTSET_RE = /\btest sets?\b|\btest cases?\b/;
const RESULT_RE = /\b(?:results?|pass rate|scores?|passed|finished|completed)\b/;
const ITEM_RE = /\b(?:details?|properties|inputs?)\b/;

/** The button that opens the dialog a shot shows, when it can be named: a known one, or the first callout that starts like a button. */
export function openerOf(facts, stage, shot) {
  const { feature, picture } = facts;
  if (stage === "knowledge" || /\badd knowledge\b|knowledge source dialog/.test(picture)) return { opener: "knowledge" };
  if (stage === "publish" || /\bpublish (?:dialog|panel|agent)\b/.test(picture)) return { opener: "publish" };
  if (stage === "evaluate") return { opener: "evaluation" };
  if (stage === "model") return { opener: "model" };
  if (stage === "settings") return { opener: "settings" };
  if (stage === "tools") return { opener: /(?:^|-)skills?$/.test(feature) || /\badd skill\b/.test(picture) ? "skill" : "tool" };
  const label = (shot?.callouts || []).map((c) => clean(strip(c.text || c.label), 40)).find((l) => OPENER_LABEL_RE.test(l));
  return label ? { opener: "generic", label } : { opener: null };
}

/** The labels inside a dialog the picture shows (a tab, a tile): callouts that are not the opener or the stage's own words. */
function choicesOf(shot, opener, label) {
  const skip = new Set([OPENERS[opener]?.label, label, "Build", "Tools", "Knowledge", "Overview", "Settings", "Preview", "Evaluate", "Monitor", "Add", "Skills", "Publish", "Publish agent", "Add a tool", "Add tool", "Add skill", "Add knowledge", "Featured"].filter(Boolean).map((l) => l.toLowerCase()));
  return (shot?.callouts || [])
    .map((c) => clean(strip(c.text || c.label), 40))
    .filter((l) => l && !skip.has(l.toLowerCase()) && !OPENER_LABEL_RE.test(l))
    .slice(0, 1);
}

/**
 * The recipe family of a shot that belongs to the agent in the browser. `stage` is the walkthrough stage the shot's feature belongs to
 * (see walkthrough.mjs); `labels` are the labels the finished screen should show (the shot's own callouts and bold names).
 * Returns null when no family fits (the shot keeps the walkthrough's own steps for its stage).
 * @returns {{family: string, verified: boolean, review: "never"|"landmark"|"always", landmarks: string[], objects: string[], maxTier: number, panel?: string, question?: string, opener?: string, label?: string, choices?: string[]}|null}
 */
export function detectFamily(shot, { stage = null, labels = [] } = {}) {
  const facts = shotFacts(shot);
  const conversation = conversationOf(facts);
  if (conversation && stage !== "evaluate") {
    const panel = conversation.panel ? PANELS[conversation.panel] : null;
    // A plain question and its answer is the part that has been proven on a real tenant; a panel or a refusal is not yet.
    const verified = !panel && conversation.question !== "guardrail";
    return { family: "conversation", verified, review: panel ? panel.review : "never", landmarks: panel?.landmark ? [panel.landmark] : [], objects: [], maxTier: 1, ...(panel ? { panel: panel.id } : {}), question: conversation.question };
  }
  if (facts.kind === "dialog" || (DIALOG_RE.test(facts.picture) && facts.kind !== "settings")) {
    const found = openerOf(facts, stage, shot);
    if (found.opener) {
      const info = OPENERS[found.opener];
      const choices = choicesOf(shot, found.opener, found.label);
      const verified = info.proven && !choices.length;
      return { family: "dialog", verified, review: verified ? "never" : "landmark", landmarks: choices, objects: [], maxTier: 1, opener: found.opener, ...(found.label ? { label: found.label } : {}), ...(choices.length ? { choices } : {}) };
    }
  }
  if (stage === "evaluate" && TESTSET_RE.test(facts.picture) && !RESULT_RE.test(facts.picture) && ["settings", "after", "ui-location", "before"].includes(facts.kind)) {
    return { family: "testset", verified: false, review: "landmark", landmarks: ["Evaluation"], objects: ["evaluation-test-set"], maxTier: 2 };
  }
  if (["knowledge", "tools"].includes(stage) && ["settings", "after"].includes(facts.kind) && ITEM_RE.test(facts.picture)) {
    return { family: "item", verified: false, review: "landmark", landmarks: labels.slice(0, 3), objects: [], maxTier: 1 };
  }
  return null;
}

/** A plain list of what the computer does for a family, for the dry plan and the shot card. */
export function describeFamily(found) {
  if (!found) return [];
  if (found.family === "conversation") {
    const panel = found.panel ? PANELS[found.panel] : null;
    return [
      "Open the Preview tab.",
      found.question === "guardrail" ? "Ask one plain request to ignore its instructions, to show how the agent refuses." : found.question === "outOfScope" ? "Ask a question outside the agent's scope." : "Ask the lab's own sample question.",
      "Wait for the answer to finish.",
      ...(panel?.names?.length ? [`Open the ${panel.label}, if it is not already showing.`] : []),
      ...(panel?.landmark ? [`Check that “${panel.landmark}” is showing. If it is not, the picture is saved for your review.`] : []),
      ...(panel?.review === "always" ? ["Take the picture and save it for your review, because the computer cannot check this screen itself."] : ["Take the picture. Nothing is saved to the agent."]),
    ];
  }
  if (found.family === "dialog") {
    const name = found.label || OPENERS[found.opener]?.label || "the dialog";
    return [`Open the page that has ${name}.`, `Open ${name} by its label.`, ...(found.choices?.length ? [`Choose “${found.choices[0]}” in the dialog (nothing is confirmed).`] : []), "Take the picture.", "Close the dialog with Cancel and check that it closed and nothing changed."];
  }
  if (found.family === "testset") return ["Open the Evaluate tab.", "If there is no test set yet, add one with one sample question (it is not run, so it spends no Copilot Credits).", "Take the picture."];
  if (found.family === "item") return ["Open the page that lists the items.", "Open the first item the practice agent already has.", "Take the picture.", "Leave without saving."];
  if (found.family === "locate") return ["Open the closest page.", "Check it by the labels the lab names. If they are not showing, the picture is saved for your review."];
  if (found.family === "navigate") return ["Move through the product's own tabs and menus by their visible labels.", "Check the screen by the labels the lab names. If they are not showing, the picture is saved for your review."];
  return [];
}

/** The plain note a picture carries when the screen was not what the family expects. */
export function landmarkNote(missing) {
  const list = (Array.isArray(missing) ? missing : []).map((l) => clean(l, 60)).filter(Boolean).slice(0, 3);
  return `The screen did not show what the computer expected${list.length ? ` (missing: ${list.join(", ")})` : ""}. The picture was saved so you can check it.`;
}
