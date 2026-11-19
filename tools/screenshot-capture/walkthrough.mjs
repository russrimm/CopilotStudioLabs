// The lab walkthrough: how a lab's modules become an ordered build of ONE practice agent, and which shots a computer can
// take on that agent by itself. Pure functions only (no files, no browser), shared by the portal (which labels each shot
// when a job is planned) and the companion (which decides again on this computer before it touches a page).
//
// A lab is cumulative: it creates an agent, sets its instructions, adds knowledge, tests it, publishes it, evaluates it,
// and reads its analytics. Every shot belongs to one STAGE of that story. Before a shot is taken, the stages before it
// are brought into place on the practice agent (created once, then verified from what the page shows, never done twice).
// Steps the computer must never do (add a tool that needs a connection, upload files, publish to a channel, change a tenant
// setting) are named here with a plain reason, so the shot ends "needs you" with one fix instead of a failed click.

import { checkPublicWebsite, checkTypedText, limitWebsiteDepth } from "./guard.mjs";

export const PRACTICE_NAME_PREFIX = "Lab screenshots - ";
export const SCRATCH_CONTEXT_VERSION = 1;
const clean = (value, max = 200) => String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/**
 * The stages of the story, in the order they are built. `tab` is the tab of the newer agent layout the stage lives on;
 * `needs` are the stages that must be in place first; `prepares` says whether the stage changes the agent.
 */
export const STAGES = Object.freeze([
  { id: "agent", order: 10, label: "Create the agent", tab: "Build", needs: [], prepares: true },
  { id: "instructions", order: 20, label: "Set the instructions", tab: "Build", needs: ["agent"], prepares: true },
  { id: "knowledge", order: 30, label: "Add knowledge", tab: "Build", needs: ["agent", "instructions"], prepares: true },
  { id: "tools", order: 40, label: "Open the tools", tab: "Build", needs: ["agent"], prepares: false },
  { id: "model", order: 50, label: "Show the model list", tab: "Build", needs: ["agent"], prepares: false },
  { id: "preview", order: 60, label: "Test in the test pane", tab: "Preview", needs: ["agent", "instructions", "knowledge"], prepares: false },
  { id: "evaluate", order: 70, label: "Open Evaluate", tab: "Evaluate", needs: ["agent", "instructions", "knowledge"], prepares: false },
  { id: "publish", order: 80, label: "Publish the agent", tab: "Build", needs: ["agent", "instructions", "knowledge"], prepares: true },
  { id: "monitor", order: 90, label: "Open Monitor", tab: "Monitor", needs: ["agent", "preview"], prepares: false },
  { id: "settings", order: 100, label: "Open the agent settings", tab: "Build", needs: ["agent"], prepares: false },
]);

const STAGE_BY_ID = new Map(STAGES.map((stage) => [stage.id, stage]));
export const stageById = (id) => STAGE_BY_ID.get(id) || null;

/** Why a shot cannot be taken by the computer, with the group it is counted in and the one thing that fixes it. */
export const BLOCKERS = Object.freeze({
  connection: { code: "needs-connection", reason: "Adding this tool needs a connection that you must allow, and the computer never creates connections or signs in to other services.", fix: "Add the tool yourself with “Retake guided”, or upload the picture." },
  files: { code: "needs-files", reason: "This step needs sample files in a SharePoint library or a file upload, and the computer never uploads files.", fix: "Put the sample files in place, then use “Retake guided”." },
  credits: { code: "needs-credits", reason: "Running or generating an evaluation uses Copilot Credits, and the computer does not spend credits for you.", fix: "Run the evaluation yourself with “Retake guided”, or upload the picture." },
  channel: { code: "needs-channel", reason: "This shows a channel (Teams, a website, email) and the computer only ever publishes to the agent's own default channel.", fix: "Set up the channel yourself with “Retake guided”." },
  admin: { code: "needs-admin", reason: "This is a tenant, environment, admin, security, or billing screen, and the computer never opens or changes those.", fix: "Capture it yourself with an account that has admin access." },
  "other-product": { code: "needs-other-product", reason: "This screen is in another product (Power Automate, Teams, Microsoft Foundry, Visual Studio Code), not in the agent.", fix: "Capture it in that product with “Retake guided”." },
  "error-state": { code: "needs-you", reason: "This shows an error or a blocked state, and the computer never causes one on purpose.", fix: "Set the screen up yourself with “Retake guided”." },
  "outside-agent": { code: "needs-you", reason: "This screen is not part of building the agent in the browser.", fix: "Use “Retake guided”, or upload the picture." },
  "other-agent": { code: "needs-you", reason: "Connected agents involve other agents, and the computer never touches an agent that is not its own practice agent.", fix: "Set up the connected agent yourself with “Retake guided”, or upload the picture." },
  unseen: { code: "needs-you", reason: "The computer has not seen this screen in the real product yet, so it does not guess which controls to use.", fix: "Use “Show me once” so it learns the step, or “Retake guided”." },
});

// What the picture itself is about (its caption, description, and callouts), not every step of the module: a module that says "publish to your channels" can still have a picture of the default Publish dialog.
const pictureWordsOf = (shot) => [shot?.caption, shot?.alt, ...((shot?.callouts || []).map((c) => c.text || c.label))].map((t) => String(t || "").replace(/\*\*/g, "")).join(" ").toLowerCase();

// The feature a shot belongs to names its stage most reliably; the section and the words are the fallback.
const FEATURE_STAGE = [
  [/(?:^|-)(?:create-agent|harness-choice)$/, "agent"],
  [/(?:^|-)instructions$/, "instructions"],
  [/(?:^|-)(?:knowledge(?:-(?:sharepoint|files-web|dataverse|tuning))?)$/, "knowledge"],
  [/(?:^|-)(?:model-selection|model-mode)$/, "model"],
  [/(?:^|-)(?:preview-test|test-agent|multiturn-tests)$/, "preview"],
  [/(?:^|-)(?:evaluate|evaluations)$/, "evaluate"],
  [/(?:^|-)publish-agent$/, "publish"],
  [/(?:^|-)(?:monitor|analytics)$/, "monitor"],
  [/(?:^|-)(?:memory|agent-settings-security|generative-orchestration|authentication|content-moderation|voice-settings)$/, "settings"],
  [/(?:^|-)(?:tools?|add-tools|connector-tools|prompt-tools|custom-connectors|mcp-servers|tools-mcp|mcp-server|skills|workflows?-tool|agent-flows|flow-prompt-nodes|flow-async)$/, "tools"],
];
// Screens whose controls have not been seen in the real product: they are never guessed.
// Other agents are never touched, so a screen that connects one is left to the person.
const FEATURE_OTHER_AGENT = /(?:^|-)(?:connected-agents?|agent-to-agent|sub-agents)$/;
const FEATURE_UNSEEN = /(?:^|-)(?:hooks|triggers|created-files)$/;
const FEATURE_OTHER = /(?:^|-)(?:dlp-governance|alm-solutions|agent-inventory|readiness-scorecard|entra-agent-identities|credit-billing|usage-credits|channel-teams|channel-web-sdk|deploy-channels|teams-phone|voice-agents|computer-use|vscode-authoring|onprem-data-gateway|vnet-private-connectivity|work-iq|sdk-agent|export-import|escalate-human|contact-center|events|foundry-iq|biometric-auth|upgrade-from-standard|[a-z]+-integration|topics|entities-variables|adaptive-cards|power-fx)$/;
const SECTION_STAGE = { build: "agent", overview: "agent", knowledge: "knowledge", tools: "tools", actions: "tools", test: "preview", preview: "preview", evaluate: "evaluate", evaluation: "evaluate", evaluations: "evaluate", deploy: "publish", publish: "publish", analytics: "monitor", monitor: "monitor", settings: "settings", topics: "other" };

/**
 * Which stage a shot belongs to, and, when the computer cannot do it, why.
 * @returns {{stage: string, order: number, scoped: boolean, blocker: string|null}}
 */
export function classifyStage(shot) {
  const feature = String(shot?.featureId || shot?.feature || "").toLowerCase();
  const section = String(shot?.section || "").toLowerCase();
  const kind = String(shot?.kind || "").toLowerCase();
  const picture = pictureWordsOf(shot);
  const product = String(shot?.product || "copilot-studio");
  // Non-Copilot-Studio products are not built from scratch; they keep their own screens.
  if (product !== "copilot-studio") return { stage: "other", order: 999, scoped: false, blocker: null };
  // The home page and the list of agents are looked at as they are; a dialog or a setting that happens to start from the list belongs to its feature.
  if (section === "home" || (section === "agents" && ["ui-location", "before", ""].includes(kind))) return { stage: "other", order: 5, scoped: false, blocker: null };
  if (["admin", "admin-center", "solutions", "custom"].includes(section) || /\b(?:admin center|power platform admin|tenant settings|dlp|purview|billing|licen[cs]es?)\b/.test(picture)) return { stage: "other", order: 999, scoped: false, blocker: "admin" };
  if (FEATURE_OTHER_AGENT.test(feature)) return { stage: "other", order: 999, scoped: false, blocker: "other-agent" };
  if (FEATURE_UNSEEN.test(feature)) return { stage: "other", order: 999, scoped: false, blocker: "unseen" };
  let stage = null;
  for (const [pattern, id] of FEATURE_STAGE) {
    if (pattern.test(feature)) {
      stage = id;
      break;
    }
  }
  if (!stage && FEATURE_OTHER.test(feature)) return { stage: "other", order: 999, scoped: false, blocker: /foundry|teams|channel|voice|vscode|sdk|computer-use|gateway|vnet/.test(feature) ? "other-product" : /dlp|alm|inventory|readiness|entra|billing|usage|credit/.test(feature) ? "admin" : "outside-agent" };
  if (!stage) stage = SECTION_STAGE[section] || null;
  if (!stage) return { stage: "other", order: 999, scoped: false, blocker: "outside-agent" };
  const info = stageById(stage);
  let blocker = null;
  // An error or blocked state is never caused on purpose, whatever the words say.
  if (kind === "error-state") blocker = "error-state";
  else if (/\b(?:microsoft teams|teams channel|web ?chat|demo website|custom website|whatsapp|facebook|slack|telegram|twilio|sms|email channel)\b/.test(picture) && ["publish", "settings", "agent"].includes(stage)) blocker = "channel";
  else if (stage === "tools" && kind !== "dialog" && /\b(?:connect(?:ed|ions?|ors?)?|sign in|authenticat\w*|oauth|credentials?|api key|mcp|power automate|flow)\b/.test(picture)) blocker = "connection";
  else if (stage === "knowledge" && kind !== "dialog" && /\b(?:upload|sample files?|csv|excel file|library of)\b/.test(picture)) blocker = "files";
  else if (stage === "evaluate" && (kind === "test-result" || /\b(?:finished|completed|results?|passed|score|scores|pass rate|run(?:ning)? (?:the |an |your )?evaluation)\b/.test(picture))) blocker = "credits";
  return { stage, order: info.order, scoped: true, blocker };
}

/** The stages that must be in place before a stage's shots, in the order they are built (the stage itself is last). */
export function stagesBefore(stageId) {
  const info = stageById(stageId);
  if (!info) return [];
  return info.needs.map((id) => stageById(id)).filter(Boolean).sort((a, b) => a.order - b.order);
}

/** Shots in the order the lab builds the agent: by module, then by the order of the stage inside it, then as the plan lists them. */
export function orderForWalkthrough(shots) {
  return (Array.isArray(shots) ? shots : [])
    .map((shot, index) => ({ shot, index, order: Number(shot.moduleOrder ?? 0) || 0, stage: classifyStage(shot).order }))
    .sort((a, b) => a.order - b.order || a.stage - b.stage || a.index - b.index)
    .map((item) => item.shot);
}

// ── The agent's own content, from the lab ───────────────────────────────────

/** The product cuts an agent's name at 30 characters, so the practice agent's whole name is kept within that. */
export const MAX_AGENT_NAME = 30;

/** "Lab screenshots - Team": the fixed prefix and a short title from the lab (a word or two, never an identifier), 30 characters at most. */
export function scratchAgentName(shortTitle) {
  const short = clean(shortTitle, 60)
    .replace(/^(?:cross-industry|[a-z -]{3,30}):\s*/i, "")
    .replace(/^(?:build|create|make)\s+(?:an?|the)\s+/i, "")
    .replace(/\s+(?:with|and|using)\s+.*$/i, "")
    .replace(/[<>"]/g, "")
    .trim();
  const room = MAX_AGENT_NAME - PRACTICE_NAME_PREFIX.length;
  let fitted = "";
  for (const word of (short || "Training lab").split(" ")) {
    const next = fitted ? `${fitted} ${word}` : word;
    if (next.length > room) break;
    fitted = next;
  }
  // A first word longer than the room is cut: a name is better short than missing.
  return `${PRACTICE_NAME_PREFIX}${(fitted || (short || "Training lab").slice(0, room)).replace(/[\s.,;:-]+$/, "")}`;
}

/** A lab or a profile key for the practice agent registry: letters, digits, dashes. */
export function scratchKey(raw) {
  const key = String(raw ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return key || "shared";
}

const OUT_OF_SCOPE_DEFAULT = "Can you recommend a good restaurant for dinner tonight?";
const QUESTION_DEFAULT = "What can you help me with?";

/**
 * The text the computer types into the practice agent, checked again here. Whatever the portal sent, it is bounded, plain,
 * and free of addresses, emails, ids, and secrets (a website must be a public Microsoft documentation address).
 * @returns {object} a context that is always usable: a missing or unsafe field gets a plain default
 */
export function sanitizeScratchContext(raw) {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const text = (value, max, fallback = "") => {
    const checked = checkTypedText(value, { max });
    return checked.ok ? checked.text : fallback;
  };
  const labTitle = clean(src.labTitle, 80).replace(/[<>]/g, "");
  const name = clean(src.agentName, 80);
  const agentName = name.startsWith(PRACTICE_NAME_PREFIX) && !/[<>"]/.test(name) ? scratchAgentName(name.slice(PRACTICE_NAME_PREFIX.length)) : scratchAgentName(src.shortTitle || labTitle);
  const questions = (Array.isArray(src.questions) ? src.questions : []).map((q) => text(q, 200)).filter(Boolean).slice(0, 4);
  const website = checkPublicWebsite(src.website);
  const sharepoint = (() => {
    try {
      const url = new URL(String(src.sharepointUrl || ""));
      return url.protocol === "https:" && /(?:^|\.)sharepoint\.com$/i.test(url.hostname) && !url.username && !url.password && !url.search ? `${url.origin}${url.pathname}`.replace(/\/+$/, "").slice(0, 200) : "";
    } catch {
      return "";
    }
  })();
  return {
    version: SCRATCH_CONTEXT_VERSION,
    key: scratchKey(src.key || labTitle),
    labTitle,
    agentName,
    description: text(src.description, 300, "An assistant that answers common questions for my team."),
    instructions: text(src.instructions, 1500, "Answer briefly and politely. Use only the knowledge you were given. If a question is outside that, say so and suggest who to ask."),
    questions: questions.length ? questions : [QUESTION_DEFAULT],
    outOfScope: text(src.outOfScope, 200, OUT_OF_SCOPE_DEFAULT),
    website: website.ok ? limitWebsiteDepth(website.url) : "",
    sharepointUrl: sharepoint,
  };
}

/** The `inputs` an executor types from, one per kind of sample. */
export function scratchInputs(context) {
  const ctx = sanitizeScratchContext(context);
  return { question: ctx.questions[0], description: ctx.description, instructions: ctx.instructions, agentName: ctx.agentName, outOfScope: ctx.outOfScope, ...(ctx.website ? { website: ctx.website } : {}), instruction: ctx.instructions.slice(0, 200) };
}

// ── What a person is told ───────────────────────────────────────────────────

/** The groups of shots that end "needs you", with one fix each: `[{code, reason, fix, count}]`. */
export function summarizeBlockers(shots) {
  const groups = new Map();
  for (const shot of shots || []) {
    const blocker = shot?.capture?.scratch?.blocker || shot?.blocker || null;
    const info = BLOCKERS[blocker];
    if (!info) continue;
    if (!groups.has(blocker)) groups.set(blocker, { code: info.code, blocker, reason: info.reason, fix: info.fix, count: 0 });
    groups.get(blocker).count += 1;
  }
  return [...groups.values()];
}

/**
 * The stage of a shot. The portal wrote its own reading of the full shot into the plan (`capture.scratch`), and the computer uses it as it is
 * when it is well formed, so what the portal showed the person and what the computer does are the same; otherwise it reads the shot itself.
 */
export function resolveStage(shot) {
  const given = shot?.capture?.scratch;
  if (given && typeof given === "object" && typeof given.scoped === "boolean") {
    const info = stageById(given.stage);
    const stage = info ? given.stage : given.stage === "other" ? "other" : null;
    const blocker = typeof given.blocker === "string" && BLOCKERS[given.blocker] ? given.blocker : null;
    if (stage && (given.scoped ? Boolean(info) : true)) return { stage, order: info ? info.order : Number(given.order) || 999, scoped: given.scoped, blocker };
  }
  return classifyStage(shot);
}

/** The descriptor a plan carries for a shot in from-scratch mode: the stage and, when there is one, the reason it needs a person. */
export function scratchDescriptor(shot) {
  const found = classifyStage(shot);
  return { stage: found.stage, order: found.order, scoped: found.scoped, ...(found.blocker ? { blocker: found.blocker } : {}) };
}
