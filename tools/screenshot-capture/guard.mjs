// What the Local Capture Companion must never click. It signs in to nothing and signs out of
// nothing: the person signs in themselves, and a step in a lab that says "Sign out" or "Switch
// account" is documentation for the learner, not something to do to the capture browser.
//
// Shared by the companion, the lab runner, and the portal's step derivation, so a step that
// would leave the signed-in state is dropped when the plan is built and again on this computer.

/** Controls that delete or undo something in the tenant. */
export const DESTRUCTIVE_LABEL_RE = /\b(?:delete|remove|erase|purge|destroy|disconnect|unregister|revoke|reset all|delete all)\b/i;

/**
 * Controls that create, change, or publish something. The companion looks at a tenant; it never changes it,
 * so a control named like this is never clicked, even when a lab step says "select Publish".
 */
export const WRITE_LABEL_RE = new RegExp(
  `^\\s*(?:publish|republish|unpublish|create|save|submit|send|deploy|apply|confirm|install|upload|import|generate|activate|deactivate|enable|disable|turn\\s+(?:on|off)|rename|share|invite|add|new|edit|update|connect|authori[sz]e|grant|approve|reject|run|start\\s+building|get\\s+started|try\\s+it)\\b`,
  "i",
);

// Reading "Sign-in logs" or "Sign-in policies" in an admin center is not signing in.
const SIGN_IN_NOUNS = "logs?|activity|events?|reports?|risk|polic(?:y|ies)|frequency|options?|branding|page|experience";
const ACCOUNT_NOUNS = "accounts?|users?|profiles?|directory|directories|tenants?|organi[sz]ations?";

/** Control names that start a sign-in, end one, or change who is signed in. */
export const ACCOUNT_LABEL_RE = new RegExp(
  [
    `^\\s*(?:sign|log)[\\s-]*(?:in|on|out|off)\\b(?!\\s+(?:${SIGN_IN_NOUNS})\\b)`,
    `^\\s*switch\\s+(?:to\\s+)?(?:another\\s+|a\\s+different\\s+)?(?:${ACCOUNT_NOUNS})\\b`,
    "^\\s*(?:use|sign in with|sign in as)\\s+(?:another|a\\s+different)\\s+(?:account|user)\\b",
    "^\\s*(?:add|remove|forget)\\s+(?:an?\\s+)?(?:another\\s+|work\\s+|school\\s+|personal\\s+|new\\s+)?account\\b",
    "^\\s*(?:pick|choose|select|change)\\s+(?:an?\\s+|your\\s+|the\\s+)?account\\b",
    "^\\s*(?:account\\s+manager|my\\s+account|view\\s+account|manage\\s+(?:my\\s+)?account|profile\\s+(?:picture|photo)|account\\s+menu|profile\\s+menu)\\b",
  ].join("|"),
  "i",
);

/** A whole sentence that tells the learner to leave the signed-in state. Plain "sign in" does not count: the click targets are the bold labels. */
export const ACCOUNT_INSTRUCTION_RE = new RegExp(
  [
    "\\b(?:sign|log)[\\s-]*(?:out|off)\\b",
    `\\bswitch\\s+(?:to\\s+)?(?:another\\s+|a\\s+different\\s+)?(?:${ACCOUNT_NOUNS})\\b`,
    "\\buse\\s+another\\s+account\\b",
    "\\bsign\\s+in\\s+(?:with|as)\\s+(?:another|a\\s+different)\\b",
    "\\b(?:add|remove|forget)\\s+(?:an?\\s+)?(?:another\\s+)?account\\b",
  ].join("|"),
  "i",
);

// Links that log out or start a fresh sign-in: checked on the control the companion is about to click.
const ACCOUNT_LINK_RE = /(?:^|[/?&#=_.-])(?:sign[-_]?out|log[-_]?out|log[-_]?off|logoff|switch[-_]?account|select_account|use[-_]?another[-_]?account)(?:$|[/?&#=_.-])|\/oauth2\/(?:v2\.0\/)?logout|prompt=(?:login|select_account)/i;

/** Why a control name or sentence is off limits: "destructive", "account", "write", or null when it is fine. */
export function blockedLabelReason(label) {
  const text = String(label ?? "");
  if (DESTRUCTIVE_LABEL_RE.test(text)) return "destructive";
  if (ACCOUNT_LABEL_RE.test(text)) return "account";
  if (WRITE_LABEL_RE.test(text)) return "write";
  return null;
}

/** A whole sentence from a lab step. It is documentation, so only a request to delete or to leave the account blocks it. */
export function blockedInstructionReason(instruction) {
  const text = String(instruction ?? "");
  if (DESTRUCTIVE_LABEL_RE.test(text)) return "destructive";
  if (ACCOUNT_INSTRUCTION_RE.test(text)) return "account";
  return null;
}

/** Whether a link target signs out, switches the account, or forces a new sign-in. */
export function isAccountLink(href) {
  return ACCOUNT_LINK_RE.test(String(href ?? ""));
}

/**
 * Runs inside the page (it must stay self-contained): the text, label, link, and surroundings of a control, so the
 * companion can refuse a control whose visible name matched something harmless but whose target is not, and can
 * tell a navigation item from an unrelated link that happens to share its name.
 */
export function describeControlInPage(element) {
  const link = element.closest ? element.closest("a, [href]") : null;
  const closest = (selector) => (element.closest ? Boolean(element.closest(selector)) : false);
  const region = closest("dialog, [role=dialog], [role=alertdialog]")
    ? "dialog"
    : closest("nav, [role=navigation], [role=tablist], [role=tree], [role=menu], [role=menubar]")
    ? "nav"
    : closest("main, [role=main]")
    ? "main"
    : closest("header, [role=banner]")
    ? "header"
    : "other";
  return {
    text: String(element.innerText || element.textContent || "").slice(0, 200),
    aria: String(element.getAttribute?.("aria-label") || "").slice(0, 200),
    title: String(element.getAttribute?.("title") || "").slice(0, 200),
    href: String(link?.getAttribute?.("href") || "").slice(0, 600),
    type: String(element.getAttribute?.("type") || "").slice(0, 20),
    inForm: closest("form"),
    region,
    selected:
      element.getAttribute?.("aria-selected") === "true" ||
      element.getAttribute?.("aria-pressed") === "true" ||
      element.getAttribute?.("aria-expanded") === "true" ||
      (Boolean(element.getAttribute?.("aria-current")) && element.getAttribute?.("aria-current") !== "false"),
  };
}

/** Pure check of what `describeControlInPage` returned. */
export function controlIsOffLimits(description) {
  if (!description) return null;
  for (const name of [description.text, description.aria, description.title]) {
    const reason = name ? blockedLabelReason(String(name).trim()) : null;
    if (reason) return { reason, why: "name" };
  }
  if (description.href && isAccountLink(description.href)) return { reason: "account", why: "link" };
  // A button that submits a form saves something, whatever it says.
  if (String(description.type || "").toLowerCase() === "submit") return { reason: "write", why: "type" };
  return null;
}

// ── Action tiers (autonomous capture) ───────────────────────────────────────
//
// What the computer may do on its own, and what it may never do. This is the single source of truth: the
// executor asks it before every click and every keystroke, the portal's planner uses it to label each step,
// and the Screenshot Center shows the same table to the person who consents.
//
//   0  look      open pages and sections, expand, select tabs, scroll, hover. Nothing changes.
//   1  try       open menus, dialogs, panels, and pickers; ask the test chat a sample question; type in a search
//                box; fill a dialog's fields without confirming it; close or cancel; discard unsaved edits.
//   2  practice  create, edit, save, or publish, only inside a practice agent the companion made itself, and only
//                after the person opted in.
//   3  never     sign out or switch accounts; delete or remove anything; share, invite, or send to other people;
//                publish to a channel; tenant, environment, admin, billing, licensing, security, DLP, or
//                permission settings; installing or consenting to apps; connections with credentials; uploading
//                or downloading files; anything outside the allowed product hosts.

export const TIER = Object.freeze({ LOOK: 0, TRY: 1, PRACTICE: 2, NEVER: 3 });

export const TIER_TABLE = Object.freeze([
  { tier: 0, id: "look", label: "Look", allowed: "always", summary: "Open pages and sections, expand items, select tabs, scroll, and hover. Nothing changes.", examples: ["Open Knowledge", "Select the Settings tab", "Open an item to see its details"] },
  { tier: 1, id: "try", label: "Try", allowed: "automatic mode", summary: "Open menus, dialogs, and panels, ask the test pane a sample question, type in a search box, and fill in a dialog without confirming it. Dialogs are canceled afterward.", examples: ["Open the Add knowledge dialog", "Ask the test pane a sample question", "Close the dialog with Cancel"] },
  { tier: 2, id: "practice", label: "Practice agent", allowed: "only after you opt in", summary: "Create, edit, save, or publish, only inside a practice agent that the computer made itself in the practice environment you choose.", examples: ["Create the practice agent", "Save an instruction in it", "Publish it (the default internal publish only)"] },
  { tier: 3, id: "never", label: "Never", allowed: "never", summary: "Things the computer will never do, whatever a lab says.", examples: [] },
]);

/** Plain-language list of what is never done, for the consent card and the docs. */
export const NEVER_LIST = Object.freeze([
  "Sign out, switch accounts, or sign in for you",
  "Delete or remove anything, including cleaning up after itself",
  "Share an agent, invite people, or send a message or email to anyone",
  "Publish to a channel such as Teams or a website",
  "Change tenant, environment, admin, billing, licensing, security, data policy, or permission settings",
  "Install or consent to apps, or create connections with credentials",
  "Upload or download your files",
  "Touch any agent that is not its own practice agent, or leave the Microsoft product sites",
]);

/** What "build the agent from scratch" creates and changes, in plain words: the consent card lists exactly this. */
export const SCRATCH_CREATES_LIST = Object.freeze([
  "One new agent named “Lab screenshots - <short lab title>” in the environment you choose (or the one Copilot Studio opens for this account)",
  "That agent's instructions and description, using the text from your lab",
  "Knowledge sources it adds: a public website taken from the lab's Microsoft Learn links, or the SharePoint site you gave (it only reads it)",
  "That agent's settings that the lab turns on or off",
  "Test conversations in the agent's test pane, and one evaluation test set if the lab has one",
  "Publishing the agent to its own default (internal) channel, and nothing else",
]);

/** What each tier allows, as plain objects the portal can send to the browser. */
export function describeTiers() {
  return TIER_TABLE.map((row) => ({ tier: row.tier, id: row.id, label: row.label, allowed: row.allowed, summary: row.summary, examples: [...row.examples] }));
}

/** The base tier of each setup action, before the control it acts on is looked at. */
export const ACTION_TIERS = Object.freeze({
  navigate: 0,
  "open-nav": 0,
  "select-tab": 0,
  reveal: 0,
  expand: 0,
  "open-item": 0,
  scroll: 0,
  hover: 0,
  "wait-for": 0,
  "wait-answer": 0,
  open: 1,
  choose: 1,
  type: 1,
  send: 1,
  close: 1,
  discard: 1,
  press: 1,
  click: 1,
  confirm: 2,
  create: 2,
  // Looks for a control without touching it: the walkthrough uses it to prove a screen is the one it expects.
  verify: 0,
});

const PROTECTED_BRANDS = /\b(?:SharePoint|OneDrive|OneNote|PowerPoint|PowerApps|PowerBI|PowerShell|PowerPlatform|LinkedIn|YouTube|GitHub|DevOps|ServiceNow|WhatsApp|OpenAI|Dataverse|ChatGPT|Salesforce)\b/gi;

/** Lower-case words with accents, symbols, and camelCase removed: the form every name is compared in. */
export function normalizeControlName(value) {
  return String(value ?? "")
    .replace(PROTECTED_BRANDS, (brand) => brand.toLowerCase())
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const escapeForRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isCjk = (text) => /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/u.test(text);

/** A matcher for whole words (or phrases) in normalized text. Terms in scripts without spaces match as substrings. */
function wordMatcher(terms, { start = false } = {}) {
  const normalized = [...new Set(terms.map(normalizeControlName).filter(Boolean))];
  const spaced = normalized.filter((t) => !isCjk(t)).sort((a, b) => b.length - a.length);
  const cjk = normalized.filter(isCjk);
  const re = spaced.length ? new RegExp(`${start ? "^" : "(?<![\\p{L}\\p{N}])"}(?:${spaced.map(escapeForRegex).join("|")})(?![\\p{L}\\p{N}])`, "u") : null;
  return (text) => Boolean((re && re.test(text)) || cjk.some((term) => text.includes(term)));
}

const ACCOUNT_TERMS = ["sign out", "log out", "logout", "signout", "log off", "sign off", "switch account", "switch user", "use another account", "use a different account", "add account", "remove account", "forget account", "se deconnecter", "deconnexion", "abmelden", "ausloggen", "cerrar sesion", "disconnetti", "esci dall account", "terminar sessao", "sair da conta", "uitloggen", "afmelden", "サインアウト", "ログアウト", "ログオフ", "退出登录", "注销", "登出", "changer de compte", "konto wechseln", "cambiar de cuenta", "cambia account", "trocar de conta", "アカウントを切り替え", "切换账户"];
const DESTRUCTIVE_TERMS = ["delete", "remove", "erase", "purge", "destroy", "disconnect", "unregister", "revoke", "uninstall", "wipe", "trash", "recycle bin", "archive", "reset all", "clear all data", "cancel subscription", "cancel plan", "cancel license", "cancel licence", "cancel order", "unsubscribe", "supprimer", "retirer", "effacer", "loschen", "löschen", "entfernen", "eliminar", "borrar", "quitar", "elimina", "rimuovi", "cancella", "excluir", "remover", "apagar", "verwijderen", "verwijder", "削除", "删除", "移除", "삭제"];
const EXTERNAL_TERMS = ["share", "sharing", "invite", "collaborate", "add people", "add members", "add collaborators", "manage access", "grant access", "request access", "send email", "send an email", "send invitation", "send invite", "send link", "email link", "submit for approval", "make available", "distribute", "partager", "teilen", "compartir", "condividi", "compartilhar", "delen", "共有", "共享", "inviter", "einladen", "invitar", "invita", "convidar", "uitnodigen", "招待", "邀请", "邀請"];
const CHANNEL_PUBLISH_RE = /(?<![\p{L}\p{N}])(?:publish|deploy|turn on|connect|add)\s+(?:to|on|for)?\s*(?:the\s+)?(?:channels?|teams|microsoft teams|demo website|custom website|website|web chat|sharepoint|facebook|slack|telegram|line|twilio|whatsapp|sms|email|direct line|m365(?: copilot)?|microsoft 365(?: copilot)?|office 365|outlook|dynamics)(?![\p{L}\p{N}])/u;
const CONSENT_TERMS = ["install", "consent", "authorize", "authorise", "allow access", "grant", "accept permissions", "add to teams", "add to outlook", "get it now", "uninstall"];
// A name that begins with one of these asks for a connection, a permission, or a hand-off to another product: never done, whatever a lab says.
const CONNECTION_START_TERMS = ["connect", "create connection", "new connection", "add connection", "add a connection", "sign in to", "allow", "allow all", "allow once", "always allow", "approve access", "accept and continue"];
const LEAVE_PRODUCT_TERMS = ["open in power apps", "open in power automate", "open in teams", "open in microsoft teams", "open in vs code", "open in visual studio code", "open in excel", "open in sharepoint", "open in the admin center", "open admin center", "open in azure", "open in the azure portal", "open in dataverse", "open in outlook"];
const CREDENTIAL_TERMS = ["password", "secret", "api key", "access key", "client secret", "token", "credential", "credentials", "connection string"];
const FILE_TERMS = ["upload", "download", "export", "browse files", "choose file", "choose files", "select file", "select files", "attach file", "attach files", "import file"];
const ENVIRONMENT_TERMS = ["switch environment", "change environment", "switch tenant", "change tenant", "switch directory", "change directory", "switch organization", "change organization"];
const COMMIT_TERMS = ["publish", "republish", "unpublish", "create", "save", "submit", "confirm", "apply", "update", "deploy", "generate", "activate", "deactivate", "enable", "disable", "turn on", "turn off", "rename", "connect", "approve", "reject", "run", "start building", "get started", "try it", "ok", "okay", "done", "yes", "finish", "continue", "accept", "add to agent", "add to this agent", "add to", "enregistrer", "speichern", "guardar", "salva", "salvar", "opslaan", "保存", "créer", "erstellen", "crear", "crea", "criar", "maken", "作成", "publier", "veröffentlichen", "publicar", "pubblica", "publiceren", "公開", "発行"];
const OPENER_TERMS = ["add", "new", "more", "more actions", "more options", "show", "view", "open", "manage", "configure", "choose", "select", "browse", "test", "try", "preview", "edit", "see", "details", "options", "settings", "filter", "search", "sort", "columns", "expand", "collapse", "learn more", "next", "back", "previous", "details", "info", "help", "menu", "agent", "agents", "topics", "tools", "knowledge", "channels", "analytics", "overview", "home"];
const NEXT_TERMS = ["next", "back", "previous", "go back", "continue to next"];
const CANCEL_NAMES = new Set(["cancel", "close", "dismiss", "no", "not now", "no thanks", "never mind", "maybe later", "back", "go back", "keep", "keep editing", "stay", "stay on this page", "don t delete", "do not delete", "don t remove", "do not remove", "don t sign out", "close dialog", "close panel", "close pane", "close window", "dismiss dialog", "x", "cancel and close", "got it", "annuler", "abbrechen", "cancelar", "annulla", "annuleren", "キャンセル", "取消", "fermer", "schliessen", "schließen", "cerrar", "chiudi", "fechar", "sluiten", "閉じる", "关闭"]);
const LEAVE_NAMES = new Set(["discard", "discard changes", "leave", "leave page", "leave without saving", "don t save", "do not save", "discard edits", "exit without saving", "close without saving"]);
const SEND_NAMES = new Set(["send", "submit", "ask", "send message", "submit message", "enter"]);
const CHAT_HOUSEKEEPING = new Set(["new chat", "new conversation", "start over", "reset", "reset conversation", "clear chat", "clear conversation", "refresh", "start a new chat", "new test conversation", "close", "minimize", "expand", "collapse"]);
const HAZARD_DIALOG_TERMS = ["delete", "remove", "sign out", "disconnect", "permanently", "reset", "uninstall", "share", "invite", "publish to", "channel", "channels", "permissions", "manage access", "collaborators", "tenant", "license", "licence", "billing", "security", "data policy", "data policies", "dlp", "admin", "consent", "permissions requested", "credentials", "connection", "connections", "sign in", "install"];
const UNSAVED_DIALOG_TERMS = ["unsaved", "leave", "discard changes", "are you sure you want to leave", "save changes", "exit", "changes you made"];

const isAccountName = wordMatcher(ACCOUNT_TERMS);
const isDestructiveName = wordMatcher(DESTRUCTIVE_TERMS);
const isExternalName = wordMatcher(EXTERNAL_TERMS);
const isConsentName = wordMatcher(CONSENT_TERMS);
// Links into the tenant's admin area (a path segment or host named admin): never followed by an action.
const ADMIN_LINK_RE = /(?:^|\/\/)admin\.|\/(?:admin|tenantsettings|tenant-settings|billing|licenses?|security-center)(?:[/?#]|$)/i;

// Known dialogs in which a write may be confirmed while building from scratch. A dialog with another title is never confirmed.
const WRITE_DIALOG_TITLES = ["add knowledge", "add a knowledge", "knowledge source", "add website", "public website", "public websites", "website", "publish", "new agent", "create an agent", "create agent", "name your agent", "rename", "instructions", "new evaluation", "create evaluation", "evaluation", "test set", "test case", "add test", "generate", "agent details", "create blank agent"];
const isKnownWriteDialog = wordMatcher(WRITE_DIALOG_TITLES);
const isConnectionName = wordMatcher(CONNECTION_START_TERMS, { start: true });
const isLeaveProductName = wordMatcher(LEAVE_PRODUCT_TERMS);
const isCredentialName = wordMatcher(CREDENTIAL_TERMS);
const isFileName = wordMatcher(FILE_TERMS, { start: true });
const isEnvironmentName = wordMatcher(ENVIRONMENT_TERMS);
const startsWithCommit = wordMatcher(COMMIT_TERMS, { start: true });
const startsWithStrictCommit = wordMatcher(["publish", "republish", "unpublish", "save", "submit", "confirm", "apply", "deploy", "ok", "okay", "done", "yes", "finish", "accept", "enregistrer", "speichern", "guardar", "salva", "salvar", "opslaan", "保存", "publier", "veröffentlichen", "publicar", "pubblica", "publiceren", "公開", "発行"], { start: true });
const startsWithOpener = wordMatcher(OPENER_TERMS, { start: true });
const isNextName = wordMatcher(NEXT_TERMS, { start: true });
// Boxes on a start page that only hold a draft until Submit is pressed.
const isDraftFieldName = wordMatcher(["describe your agent", "describe the agent", "describe what you want", "what would you like to build", "describe your agent you want", "describe the agent you want", "ask me anything", "describe your idea"]);
const isHazardDialogTitle = wordMatcher(HAZARD_DIALOG_TERMS);
const isUnsavedDialogTitle = wordMatcher(UNSAVED_DIALOG_TERMS);
const isDestructiveDialogTitle = wordMatcher(["delete", "remove", "sign out", "disconnect", "permanently", "uninstall"]);

/** Button names that open a dialog or a draft instead of committing, by product. A step must also say it opens something. */
export const OPEN_BY_COMMIT_NAME = Object.freeze(["publish", "publish agent", "publish this agent"]);
const OPEN_BY_COMMIT_FOR_PRODUCT = Object.freeze({ "m365-copilot-agent-builder": ["publish", "create agent", "new agent", "create an agent", "create"] });

const NAV_ROLES = new Set(["link", "tab", "treeitem", "menuitem", "menuitemradio", "option", "listitem", "row", "cell", "gridcell", "heading"]);
const CHOICE_ROLES = new Set(["radio", "checkbox", "option", "tab", "menuitemradio", "menuitemcheckbox", "combobox", "listbox", "switch"]);
const TEXT_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);

function verdict(tier, category, reason, extra = {}) {
  return { tier, category, reason, needsPractice: tier === 2, ...extra };
}

/**
 * Runs inside the page (it must stay self-contained): everything the gate needs to know about a control and where
 * it sits, as plain data. No page text beyond the control's own names is read, and nothing is kept.
 */
export function describeControlForGate(element) {
  // Ancestors are followed through shadow roots, so a control inside a web component's dialog is still known to be in that dialog.
  const up = (node) => node.parentElement || (node.parentNode && node.parentNode.host) || null;
  const closest = (selector) => {
    for (let node = element; node; node = up(node)) if (node.matches && node.matches(selector)) return node;
    return null;
  };
  const textOf = (node) => String((node && (node.innerText || node.textContent)) || "").replace(/\s+/g, " ").trim().slice(0, 160);
  const labelOf = (node) => {
    if (!node || !node.getAttribute) return "";
    const direct = node.getAttribute("aria-label");
    if (direct) return direct.trim().slice(0, 160);
    const ids = String(node.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
    const joined = ids.map((id) => textOf(document.getElementById(id))).filter(Boolean).join(" ");
    return joined.slice(0, 160);
  };
  const tag = String(element.tagName || "").toLowerCase();
  const explicitRole = String(element.getAttribute?.("role") || "").toLowerCase();
  const inputType = String(element.getAttribute?.("type") || (tag === "input" ? "text" : "")).toLowerCase();
  const implicitRole = tag === "a" ? "link" : tag === "button" ? "button" : tag === "select" ? "combobox" : tag === "textarea" ? "textbox" : tag === "input" ? (inputType === "checkbox" ? "checkbox" : inputType === "radio" ? "radio" : inputType === "search" ? "searchbox" : inputType === "button" || inputType === "submit" ? "button" : "textbox") : "";
  const dialog = closest("dialog, [role=dialog], [role=alertdialog], [aria-modal=true]");
  let dialogTitle = "";
  if (dialog) {
    dialogTitle = labelOf(dialog);
    if (!dialogTitle) dialogTitle = textOf(dialog.querySelector("h1, h2, h3, [role=heading]"));
  }
  const landmarks = [];
  for (let node = up(element); node && landmarks.length < 6; node = up(node)) {
    const role = String(node.getAttribute?.("role") || "").toLowerCase();
    const nodeTag = String(node.tagName || "").toLowerCase();
    if (["region", "complementary", "form", "search", "navigation", "toolbar", "menu", "tablist", "dialog", "alertdialog", "main", "log", "feed"].includes(role) || ["aside", "nav", "form", "dialog", "section", "header"].includes(nodeTag)) {
      const label = labelOf(node) || String(node.id || "");
      if (label) landmarks.push(label.slice(0, 80));
    }
  }
  const chatPattern = /\btest\s+(?:your\s+)?(?:agent|copilot|bot|chat)\b|\btest[-_ ]?(?:pane|panel)\b|\bplayground\b/i;
  // In the newer agent layout the test pane is a whole tab: Preview. A control on that tab, outside a dialog and the navigation, is in it.
  const selectedTab = document.querySelector('[role=tab][aria-selected=true]');
  const previewTab = Boolean(selectedTab && /^\s*(?:preview|test)\b/i.test(String(selectedTab.getAttribute("aria-label") || selectedTab.innerText || selectedTab.textContent || "")));
  const onPreviewTab = previewTab && !dialog && !closest("nav, [role=navigation], [role=tablist], [role=menu], header, [role=banner]");
  const inTestPane = landmarks.some((label) => chatPattern.test(label)) || chatPattern.test(String(closest("[data-testid],[id],[class]")?.getAttribute?.("data-testid") || "")) || onPreviewTab;
  const name = labelOf(element) || (tag === "input" || tag === "textarea" ? "" : textOf(element)) || String(element.getAttribute?.("title") || "") || String(element.getAttribute?.("alt") || "") || String(element.getAttribute?.("placeholder") || "") || String(element.getAttribute?.("value") || "");
  const link = closest("a, [href]");
  return {
    name: name.slice(0, 160),
    text: textOf(element),
    aria: String(element.getAttribute?.("aria-label") || "").slice(0, 160),
    title: String(element.getAttribute?.("title") || "").slice(0, 160),
    placeholder: String(element.getAttribute?.("placeholder") || "").slice(0, 160),
    tag,
    role: explicitRole || implicitRole,
    inputType,
    href: String(link?.getAttribute?.("href") || "").slice(0, 600),
    inDialog: Boolean(dialog),
    dialogTitle: dialogTitle.slice(0, 160),
    landmarks,
    inTestPane,
    inNav: Boolean(closest("nav, [role=navigation], [role=tablist], [role=tree], [role=menu], [role=menubar]")),
    inHeader: Boolean(closest("header, [role=banner]")),
    inForm: Boolean(closest("form")),
    hasPopup: Boolean(element.getAttribute?.("aria-haspopup") && element.getAttribute("aria-haspopup") !== "false"),
    expanded: element.getAttribute?.("aria-expanded") === "true",
    selected: element.getAttribute?.("aria-selected") === "true" || element.getAttribute?.("aria-pressed") === "true" || (Boolean(element.getAttribute?.("aria-current")) && element.getAttribute?.("aria-current") !== "false"),
    checked: element.getAttribute?.("aria-checked") === "true" || element.checked === true,
    editable: tag === "input" || tag === "textarea" || element.isContentEditable === true,
    disabled: Boolean(element.disabled) || element.getAttribute?.("aria-disabled") === "true",
  };
}

/** Names of a described control, normalized and without repeats. */
function namesOf(desc) {
  return [...new Set([desc?.name, desc?.aria, desc?.text, desc?.title, desc?.placeholder].map(normalizeControlName).filter(Boolean))];
}

/**
 * Decide the tier of one action on one control. Pure: the description comes from `describeControlForGate`
 * (or a test), and nothing here touches a page.
 * @param {object} desc what the page said about the control
 * @param {{action?: string, intent?: string}} [options] the step's action and what it is meant to do
 * @returns {{tier: 0|1|2|3, category: string, reason: string, needsPractice: boolean, conditional?: string}}
 */
export function classifyControl(desc, { action = "click", intent = "", product = "", expectsOverlay = false } = {}) {
  if (!desc || typeof desc !== "object") return verdict(TIER.NEVER, "unknown", "The control could not be described, so it is not touched.");
  const names = namesOf(desc);
  const role = String(desc.role || "").toLowerCase();
  const inputType = String(desc.inputType || "").toLowerCase();
  const dialogTitle = normalizeControlName(desc.dialogTitle);
  const inDialog = Boolean(desc.inDialog);
  const isText = TEXT_ROLES.has(role) || desc.editable;
  const wanted = intent || action;

  if (inputType === "file") return verdict(TIER.NEVER, "file", "Uploading or choosing your files is never done.");
  if (inputType === "password") return verdict(TIER.NEVER, "credential", "Password fields are never touched.");
  if (desc.href && isAccountLink(desc.href)) return verdict(TIER.NEVER, "account", "This link signs out or switches the account.");
  if (names.some(isAccountName) || names.some((n) => ACCOUNT_LABEL_RE.test(n))) return verdict(TIER.NEVER, "account", "Signing out or switching accounts is never done.");
  if (isText && (names.some(isCredentialName) || /secret|password|token|api[-_ ]?key/i.test(String(desc.placeholder || "")))) return verdict(TIER.NEVER, "credential", "Credential fields are never filled in.");

  if (!names.length) return verdict(TIER.NEVER, "unnamed", "A control with no name cannot be checked, so it is not touched.");

  const cancel = names.some((n) => CANCEL_NAMES.has(n));
  const leave = names.some((n) => LEAVE_NAMES.has(n));

  // A way out is always allowed first: "Don't delete" must not be mistaken for "Delete".
  if (cancel) return verdict(TIER.TRY, "cancel", "Closing or canceling is safe.");
  if (leave) {
    const unsaved = inDialog && isUnsavedDialogTitle(dialogTitle) && !isDestructiveDialogTitle(dialogTitle);
    return unsaved ? verdict(TIER.TRY, "discard-unsaved", "Leaving an unsaved edit without saving it is safe.") : verdict(TIER.NEVER, "discard", "Discarding is only done from a leave-page prompt.");
  }

  if (names.some(isDestructiveName)) return verdict(TIER.NEVER, "destructive", "Deleting or removing anything is never done.");
  if (names.some(isExternalName) || names.some((n) => CHANNEL_PUBLISH_RE.test(n))) return verdict(TIER.NEVER, "external", "Sharing, inviting, sending to other people, or publishing to a channel is never done.");
  if (names.some(isEnvironmentName)) return verdict(TIER.NEVER, "environment", "Switching the environment or tenant is never done.");
  if (names.some(isConsentName) && !names.some((n) => /^(?:install(?:ed)? apps?|installed)$/.test(n))) return verdict(TIER.NEVER, "consent", "Installing or consenting to apps is never done.");
  if (names.some(isConnectionName)) return verdict(TIER.NEVER, "connection", "Connections and permissions need a sign-in or a consent only you can give, so they are never created.");
  if (names.some(isLeaveProductName)) return verdict(TIER.NEVER, "leaves-product", "This hands off to another product, which the computer never opens.");
  if (desc.href && ADMIN_LINK_RE.test(String(desc.href))) return verdict(TIER.NEVER, "admin", "Admin pages are never opened or changed.");
  if (names.some(isFileName)) return verdict(TIER.NEVER, "file", "Uploading or downloading files is never done.");

  if (inDialog && dialogTitle && isHazardDialogTitle(dialogTitle) && !isText) {
    if (!(role === "tab" || role === "radio")) return verdict(TIER.NEVER, "dialog-hazard", "This dialog is about something that must never be confirmed, so only Cancel or Close is used.");
  }

  // The test pane: a conversation that is not saved to the agent.
  if (desc.inTestPane) {
    if (isText) return verdict(TIER.TRY, "chat-input", "Typing a sample question in the test pane is safe.");
    if (names.some((n) => SEND_NAMES.has(n)) || names.some((n) => CHAT_HOUSEKEEPING.has(n))) return verdict(TIER.TRY, "chat-send", "Sending a test message does not change the agent.");
  } else if (names.some((n) => SEND_NAMES.has(n)) && !isText) {
    return verdict(TIER.NEVER, "send-outside-chat", "Sending is only done in the test pane.");
  }

  // Search and filter boxes read; they do not change anything.
  if (isText) {
    if (role === "searchbox" || inputType === "search" || names.some((n) => /(?:^| )(?:search|filter|find)(?: |$)/.test(n))) return verdict(TIER.TRY, "search", "Typing in a search box is safe.");
    if (inDialog) return verdict(TIER.TRY, "dialog-field", "Filling a dialog field without confirming it is safe.");
    if (names.some(isDraftFieldName)) return verdict(TIER.TRY, "draft-field", "Typing a description that is not submitted changes nothing.");
    return verdict(TIER.PRACTICE, "edit-field", "Typing into a field edits the agent, so it needs the practice agent.");
  }

  const commit = names.some(startsWithCommit);
  // Moving around the product reads. Only a name that is itself a commit ("Publish", "Save", "Done") is not navigation.
  const navigating = action === "open-nav" || action === "select-tab" || action === "expand" || action === "open-item" || action === "reveal";
  if (navigating && !inDialog && (NAV_ROLES.has(role) || role === "button" || role === "") && !names.some(startsWithStrictCommit)) {
    return verdict(TIER.LOOK, "navigate", "Opening a page, tab, or item only reads.");
  }
  if (commit) {
    const openers = [...OPEN_BY_COMMIT_NAME, ...(OPEN_BY_COMMIT_FOR_PRODUCT[product] || [])];
    if (!inDialog && wanted === "open" && names.some((n) => openers.includes(n)) && !desc.inForm) {
      return verdict(TIER.TRY, "opens-dialog", "This button opens a confirmation dialog; the dialog is canceled afterward.", { conditional: "dialog-must-open" });
    }
    return verdict(TIER.PRACTICE, "commit", "This creates, saves, or publishes something, so it needs the practice agent.");
  }

  if (CHOICE_ROLES.has(role) && (role === "switch" || role === "checkbox") && !inDialog) return verdict(TIER.PRACTICE, "toggle", "Changing a setting needs the practice agent.");
  if (inDialog) {
    if (names.some(isNextName)) return verdict(TIER.TRY, "dialog-next", "Moving between steps of a dialog is safe.");
    if (CHOICE_ROLES.has(role) || NAV_ROLES.has(role) || wanted === "choose") return verdict(TIER.TRY, "dialog-choice", "Choosing an option in a dialog is safe until it is confirmed.");
    return verdict(TIER.PRACTICE, "dialog-confirm", "A button in a dialog may confirm it, so it needs the practice agent.");
  }

  if (action === "open-nav" || action === "select-tab" || action === "expand" || action === "open-item") {
    return verdict(TIER.LOOK, "navigate", "Opening a page, tab, or item only reads.");
  }
  if (NAV_ROLES.has(role) && desc.inNav) return verdict(TIER.LOOK, "navigate", "Opening a page, tab, or item only reads.");
  if (role === "tab") return verdict(TIER.LOOK, "navigate", "Selecting a tab only reads.");
  if (wanted === "open" && (names.some(startsWithOpener) || desc.hasPopup)) return verdict(TIER.TRY, "opens-dialog", "This opens a menu, dialog, or panel; it is closed afterward.");
  if (wanted === "choose") return verdict(TIER.TRY, "choice", "Choosing an option is safe until it is confirmed.");
  // A control that is not otherwise known but is declared (and then checked) to open a dialog or panel: the opened overlay is closed afterward, and a click that opens nothing fails the step.
  if (expectsOverlay && wanted === "open" && !inDialog) return verdict(TIER.TRY, "opens-dialog", "This control opens a dialog or panel; it is closed afterward.", { conditional: "dialog-must-open" });
  if (wanted === "open" || action === "click") return verdict(TIER.PRACTICE, "unknown", "This control is not known to be safe, so it needs the practice agent.");
  return verdict(TIER.PRACTICE, "unknown", "This control is not known to be safe, so it needs the practice agent.");
}

/**
 * Typed text must be a harmless sample: short, plain, and free of anything that identifies a person or a tenant.
 * @returns {{ok: boolean, text: string, reason?: string}}
 */
export function checkTypedText(raw, { max = 200 } = {}) {
  const text = String(raw ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return { ok: false, text: "", reason: "empty" };
  if (text.length > max) return { ok: false, text: "", reason: "too-long" };
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(text)) return { ok: false, text: "", reason: "email" };
  if (/https?:\/\/|www\./i.test(text)) return { ok: false, text: "", reason: "url" };
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(text)) return { ok: false, text: "", reason: "guid" };
  if (/\d{8,}/.test(text.replace(/[\s-]/g, ""))) return { ok: false, text: "", reason: "number" };
  if (/\b(?:password|passwd|secret|token|bearer|api[-_ ]?key|apikey|sas|sig=|eyJ[a-z0-9_-]{10,})\b/i.test(text) || /[A-Za-z0-9+/_-]{32,}/.test(text)) return { ok: false, text: "", reason: "secret" };
  return { ok: true, text };
}

/**
 * A public website the computer may add as a knowledge source: https, a Microsoft documentation host, no sign-in
 * details, no query (a query can carry a token), and nothing that identifies a person or a tenant.
 * @returns {{ok: boolean, url: string, reason?: string}}
 */
export function checkPublicWebsite(raw) {
  let url;
  try {
    url = new URL(String(raw ?? "").trim());
  } catch {
    return { ok: false, url: "", reason: "not-a-url" };
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return { ok: false, url: "", reason: "not-https" };
  if (!/(?:^|\.)(?:learn\.microsoft\.com|docs\.microsoft\.com|support\.microsoft\.com|microsoft\.com)$/i.test(url.hostname)) return { ok: false, url: "", reason: "not-public-docs" };
  if (url.search || /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(url.pathname)) return { ok: false, url: "", reason: "identifier" };
  const clean = `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  return clean.length <= 200 ? { ok: true, url: clean } : { ok: false, url: "", reason: "too-long" };
}

// ── Hosts ───────────────────────────────────────────────────────────────────

const SIGN_IN_HOSTS = ["login.microsoftonline.com", "login.live.com", "login.microsoft.com", "account.microsoft.com", "aadcdn.msauth.net", "aadcdn.msftauth.net"];
const PRODUCT_HOSTS = Object.freeze({
  "copilot-studio": ["copilotstudio.microsoft.com", "copilotstudio.preview.microsoft.com", "web.powerva.microsoft.com", "make.powerapps.com", "make.powerautomate.com", "powerva.microsoft.com"],
  "m365-copilot-agent-builder": ["m365.cloud.microsoft", "copilot.cloud.microsoft", "www.microsoft365.com", "microsoft365.com", "office.com", "www.office.com", "copilot.microsoft.com"],
  "m365-copilot-hub": ["m365.cloud.microsoft", "admin.cloud.microsoft", "admin.microsoft.com", "copilot.cloud.microsoft", "www.microsoft365.com", "microsoft365.com", "office.com"],
  "sharepoint-ai": ["sharepoint.com", "sharepoint-df.com", "admin.microsoft.com", "admin.cloud.microsoft", "m365.cloud.microsoft", "microsoft365.com"],
  "power-platform-ai-hub": ["make.powerapps.com", "make.powerautomate.com", "admin.powerplatform.microsoft.com", "copilotstudio.microsoft.com", "powerapps.com", "powerplatform.microsoft.com"],
  "ai-foundry": ["ai.azure.com", "portal.azure.com", "azure.com", "oai.azure.com"],
});

/** Whether a host belongs to a product (or to its sign-in). A host matches itself and its subdomains. */
export function isAllowedHost(host, product = "") {
  const name = String(host || "").toLowerCase().replace(/\.$/, "");
  if (!name) return false;
  const list = [...SIGN_IN_HOSTS, ...(PRODUCT_HOSTS[product] || Object.values(PRODUCT_HOSTS).flat())];
  return list.some((allowed) => name === allowed || name.endsWith(`.${allowed}`));
}

/** The page address's host is inside the product's allowed hosts (a page that is not a web page is not). */
export function isAllowedUrl(rawUrl, product = "") {
  try {
    const url = new URL(String(rawUrl ?? ""));
    if (url.protocol === "about:") return true;
    return url.protocol === "https:" && isAllowedHost(url.hostname, product);
  } catch {
    return false;
  }
}

// ── The gate ────────────────────────────────────────────────────────────────

/**
 * What a job lets the computer do. `consented` is the person's one-time yes; `level` is "read-only" (tiers 0 and 1,
 * nothing is created), "practice" (tier 2 too, only in a practice agent in the practice environment the job names), or
 * "scratch" (the same, in a practice agent the computer builds itself, in the environment the person chose or the one
 * the product opens). Without consent nothing beyond tier 0 runs. Tier 2 also needs this computer's own say-so:
 * `--allow-practice-writes`, or the one-time local opt-in (`localOptIn`) that is stored on this computer.
 */
export function resolveAutonomy(raw, { allowPracticeWrites = false, localOptIn = false } = {}) {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const consented = src.consented === true;
  const wantsScratch = src.level === "scratch";
  const wantsPractice = src.level === "practice" || wantsScratch;
  const practiceEnvironmentUrl = typeof src.practiceEnvironmentUrl === "string" && /^https:\/\/\S+$/.test(src.practiceEnvironmentUrl) ? src.practiceEnvironmentUrl : "";
  const allowed = allowPracticeWrites === true || localOptIn === true;
  // A from-scratch job may leave the environment open (the product's own default); a practice job must name one.
  const practice = consented && wantsPractice && allowed && (wantsScratch || Boolean(practiceEnvironmentUrl));
  const maxTier = !consented ? TIER.LOOK : practice ? TIER.PRACTICE : TIER.TRY;
  let refusedPractice = null;
  if (consented && wantsPractice && !practice) {
    refusedPractice = !allowed
      ? wantsScratch
        ? "This job asks the computer to build a practice agent, but this computer has not agreed to that yet, so nothing is created. Agree once when the companion asks, or run it with --allow-practice-writes."
        : "This job allows a practice agent, but this companion was not started with --allow-practice-writes, so nothing is created."
      : "This job allows a practice agent but did not say which environment to use, so nothing is created.";
  }
  const scratch = practice && wantsScratch;
  return {
    consented,
    level: scratch ? "scratch" : practice ? "practice" : "read-only",
    maxTier,
    practiceEnvironmentUrl: practice ? practiceEnvironmentUrl : "",
    scratch,
    startFresh: scratch && src.startFresh === true,
    // What the lab says about the agent (its name, instructions, sample questions): sanitized again where it is used.
    scratchContext: scratch && src.scratchContext && typeof src.scratchContext === "object" && !Array.isArray(src.scratchContext) ? src.scratchContext : null,
    refusedPractice,
  };
}

/**
 * The one choke point: may this step touch this control now? Every click, keystroke, and navigation of the
 * executor asks here first, and the answer is written to the trace.
 * @param {object} input
 * @param {{action: string, intent?: string}} input.step
 * @param {object|null} input.desc the control as `describeControlForGate` returned it (null for a navigation by address)
 * @param {ReturnType<typeof resolveAutonomy>} input.autonomy
 * @param {{onPracticeAgent?: boolean, creatingPracticeAgent?: boolean}} [input.practice] where the page is now
 * @returns {{allowed: boolean, tier: number, category: string, reason: string, denied?: string}}
 */
export function authorizeStep({ step, desc = null, autonomy, practice = {}, product = "" }) {
  const action = String(step?.action || "click");
  const declared = ACTION_TIERS[action] ?? TIER.PRACTICE;
  if (!desc) {
    const tier = declared;
    if (tier >= TIER.NEVER) return { allowed: false, tier, category: "unknown", reason: "This action is never done.", denied: "never" };
    return tier <= autonomy.maxTier ? { allowed: true, tier, category: action, reason: "Allowed." } : { allowed: false, tier, category: action, reason: tier === TIER.PRACTICE ? "This needs a practice agent, which was not allowed." : "This job does not allow that yet.", denied: "consent" };
  }
  const seen = classifyControl(desc, { action, intent: step?.intent, product, expectsOverlay: Boolean(step?.expect?.dialog || step?.expect?.panel) });
  const tier = Math.max(declared, seen.tier);
  const base = { tier, category: seen.category, reason: seen.reason };
  if (tier >= TIER.NEVER) return { ...base, allowed: false, denied: "never" };
  if (tier === TIER.PRACTICE) {
    if (autonomy.maxTier < TIER.PRACTICE) return { ...base, allowed: false, denied: "needs-practice" };
    if (!practice.onPracticeAgent && !practice.creatingPracticeAgent) return { ...base, allowed: false, tier: TIER.NEVER, denied: "not-practice-agent", reason: "This would change something outside the practice agent, so it is never done." };
    // Building from scratch is stricter: a write is confirmed only in a dialog the computer knows. Anything else is never confirmed.
    if (autonomy.scratch && desc.inDialog && !isKnownWriteDialog(normalizeControlName(desc.dialogTitle))) return { ...base, allowed: false, tier: TIER.NEVER, category: "unknown-dialog", denied: "unknown-dialog", reason: "This dialog is not one the computer knows, so it is never confirmed." };
    return { ...base, allowed: true };
  }
  if (tier > autonomy.maxTier) return { ...base, allowed: false, denied: "consent" };
  return { ...base, allowed: true };
}
