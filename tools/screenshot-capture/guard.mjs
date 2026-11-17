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
