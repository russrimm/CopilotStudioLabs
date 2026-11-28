// The action tiers: what the computer may do on its own, and what it may never do. These tests are the table the
// safety model is held to, including adversarial names (icon-only controls, localized and case-varied words, and a
// neutral button inside a dialog whose title makes it destructive).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ACTION_TIERS,
  NEVER_LIST,
  TIER,
  TIER_TABLE,
  authorizeStep,
  checkTypedText,
  classifyControl,
  describeTiers,
  isAccountDialogTitle,
  isAllowedHost,
  isAllowedUrl,
  normalizeControlName,
  resolveAutonomy,
} from "../guard.mjs";

const control = (name, extra = {}) => ({ name, role: "button", ...extra });
const tierOf = (name, extra = {}, options = {}) => classifyControl(control(name, extra), options);

test("the tier table names four tiers and the things that are never done", () => {
  assert.deepEqual(TIER_TABLE.map((t) => t.tier), [0, 1, 2, 3]);
  assert.deepEqual(describeTiers().map((t) => t.id), ["look", "try", "practice", "never"]);
  assert.ok(NEVER_LIST.length >= 7);
  for (const must of [/sign out/i, /delete/i, /share/i, /channel/i, /billing/i, /install/i, /upload/i]) assert.ok(NEVER_LIST.some((line) => must.test(line)), `${must} is listed`);
  assert.equal(ACTION_TIERS.confirm, TIER.PRACTICE);
  assert.equal(ACTION_TIERS["open-nav"], TIER.LOOK);
});

test("tier 3 is never allowed, whatever the label says, in any language or case", () => {
  const never = [
    "Sign out", "SIGN OUT", "sign-out", "Log out", "Switch account", "Use another account", "Se déconnecter", "Abmelden", "Cerrar sesión", "サインアウト",
    "Delete", "DELETE", "Delete agent", "Remove", "Remove knowledge", "Supprimer", "Löschen", "Eliminar", "削除", "Cancel subscription", "Disconnect",
    "Share", "Share agent", "Invite", "Invite people", "Add people", "Manage access", "Teilen", "Partager", "Compartir", "招待",
    "Publish to channel", "Publish to Teams", "Publish to website", "Turn on Teams",
    "Install", "Allow access", "Authorize", "Grant", "Upload", "Download", "Export", "Switch environment", "Change tenant",
    "Add multi agent", "Add connected agent", "Add channel", "Add to Teams", "Open in Power Apps", "Connect", "Grant consent", "Upload a skill", "Remove Work IQ", "Publish to Microsoft 365 to enable sharing.",
  ];
  for (const name of never) assert.equal(tierOf(name).tier, TIER.NEVER, `${name} must be tier 3, got ${tierOf(name).category}`);
});

test("icon-only and camel-case control names are checked by what they say", () => {
  assert.equal(tierOf("").tier, TIER.NEVER, "a control with no name is not touched");
  assert.equal(tierOf("   ").tier, TIER.NEVER);
  assert.equal(tierOf("TrashIcon").tier, TIER.NEVER);
  assert.equal(tierOf("DeleteRegular").tier, TIER.NEVER);
  assert.equal(tierOf("SignOutFilled").tier, TIER.NEVER);
  assert.equal(tierOf("", { aria: "Delete this agent" }).tier, TIER.NEVER, "the aria-label counts when the visible name is empty");
  assert.equal(normalizeControlName("SharePoint"), "sharepoint", "a product name is not split into Share and Point");
  assert.equal(tierOf("SharePoint", { inDialog: true, dialogTitle: "Add knowledge" }, { intent: "choose" }).tier, TIER.TRY);
});

test("a way out is always allowed, and a look-alike is not mistaken for one", () => {
  for (const name of ["Cancel", "CANCEL", "Close", "Dismiss", "Not now", "No thanks", "Don't delete", "Do not remove", "Back", "Annuler", "Abbrechen", "キャンセル"]) {
    assert.equal(tierOf(name, { inDialog: true, dialogTitle: "Delete agent?" }).tier, TIER.TRY, `${name} closes a dialog`);
  }
  assert.equal(tierOf("Cancel subscription").tier, TIER.NEVER);
});

test("a neutral button inside a dialog that makes it destructive is tier 3, and only a way out is allowed", () => {
  const dialog = { inDialog: true, dialogTitle: "Delete agent?" };
  for (const name of ["OK", "Yes", "Continue", "Confirm", "Done", "Proceed"]) assert.equal(tierOf(name, dialog).tier, TIER.NEVER, `${name} in a delete dialog`);
  assert.equal(tierOf("Cancel", dialog).tier, TIER.TRY);
  for (const title of ["Share this agent", "Invite collaborators", "Publish to channels", "Sign out of your account", "Manage permissions", "Add connection", "Billing"]) {
    assert.equal(tierOf("OK", { inDialog: true, dialogTitle: title }).tier, TIER.NEVER, `OK in "${title}"`);
  }
  assert.equal(tierOf("OK", { inDialog: true, dialogTitle: "What's new" }).tier, TIER.PRACTICE, "an ordinary dialog's OK may confirm something, so it needs the practice agent");
});

test("the account flyout is never touched: its button, anything in a dialog named Account, and anything that signs out", () => {
  for (const name of ["Open account menu for Ada Lovelace", "Account menu", "Profile menu", "My account", "View account"]) assert.equal(tierOf(name).tier, TIER.NEVER, `${name} is the account control`);
  for (const title of ["Account", "Profile", "My account", "Account manager"]) {
    for (const name of ["Settings", "Close", "More options", "Ada Lovelace", "Sign out"]) assert.equal(tierOf(name, { inDialog: true, dialogTitle: title }).tier, TIER.NEVER, `${name} inside the ${title} flyout`);
  }
  assert.equal(tierOf("Close", { inDialog: true, dialogTitle: "Add knowledge" }).tier, TIER.TRY, "a dialog that merely mentions an account elsewhere is not the flyout");
  assert.equal(isAccountDialogTitle("Account"), true);
  assert.equal(isAccountDialogTitle("Account settings"), true);
  assert.equal(isAccountDialogTitle("Add account details"), false);
  assert.equal(tierOf("Open Classic shots - Energy 3k9a", {}, { action: "open-item", intent: "navigate" }).tier, TIER.LOOK, "an agent's own row is a plain navigation");
});

test("tier 2 is creating, saving, and publishing; it needs the practice agent", () => {
  for (const name of ["Create", "Create blank agent", "Save", "Publish", "Confirm", "Apply", "Update", "Rename", "Done", "Add to agent", "Enable", "Turn on", "Speichern", "Guardar", "保存"]) {
    assert.equal(tierOf(name).tier, TIER.PRACTICE, `${name} commits`);
    assert.equal(tierOf(name).needsPractice, true);
  }
  assert.equal(tierOf("Generate").tier, TIER.NEVER, "generating questions or an evaluation spends Copilot Credits, so it is never done (it was a practice-agent write before)");
  assert.equal(tierOf("Submit").tier, TIER.NEVER, "Submit outside the test pane sends something, so it is never done");
  assert.equal(tierOf("Add to agent", { inDialog: true, dialogTitle: "Add knowledge" }).tier, TIER.PRACTICE);
  assert.equal(tierOf("Instructions", { role: "textbox" }).tier, TIER.PRACTICE, "typing into a field edits the agent");
  assert.equal(tierOf("Auto-save", { role: "switch" }).tier, TIER.PRACTICE, "a toggle outside a dialog changes a setting");
});

test("a control that spends Copilot Credits is never clicked, and a view of the test pane is only a look", () => {
  for (const name of ["Evaluate", "Run evaluation", "Save and evaluate", "Quick question set", "Quick conversation set", "Full question set", "Generate 10 questions", "Add conversations"]) {
    assert.equal(tierOf(name, { inDialog: true, dialogTitle: "Configure test set" }, { action: "confirm", intent: "confirm" }).tier, TIER.NEVER, `${name} spends credits`);
    assert.equal(tierOf(name, { inDialog: true, dialogTitle: "Configure test set" }, { action: "confirm", intent: "confirm" }).category, "credits");
  }
  assert.equal(classifyControl({ name: "Evaluate", role: "tab", inNav: true }, { action: "select-tab" }).tier, TIER.LOOK, "the Evaluate tab only opens a page");
  assert.equal(classifyControl({ name: "Evaluate", role: "button" }, { action: "select-tab" }).tier, TIER.LOOK, "and so does an Evaluate button that works as a tab");
  assert.equal(tierOf("Save", { inDialog: true, dialogTitle: "Configure test set" }, { action: "confirm", intent: "confirm" }).tier, TIER.PRACTICE, "saving a test set without running it is a practice-agent write");
  for (const name of ["Activity map", "Show activity map", "Open activity map", "Activity trace"]) {
    assert.equal(tierOf(name, { inTestPane: true }, { action: "open", intent: "open" }).tier, TIER.TRY, `${name} only shows what happened`);
    assert.equal(tierOf(name, { inTestPane: true }, { action: "open", intent: "open" }).category, "test-view");
  }
  assert.equal(tierOf("Activity map", { inDialog: true, dialogTitle: "Delete agent" }, { action: "open", intent: "open" }).tier, TIER.NEVER, "inside a dialog it is judged by the dialog");
});

test("Publish opens a dialog in tier 1 only when the step says it opens one; the dialog's own Publish is tier 2", () => {
  assert.equal(tierOf("Publish", { inHeader: true }, { action: "open", intent: "open" }).tier, TIER.TRY);
  assert.equal(tierOf("Publish", { inHeader: true }, { action: "open", intent: "open" }).conditional, "dialog-must-open");
  assert.equal(tierOf("Publish", { inHeader: true }).tier, TIER.PRACTICE, "without that intent it is a commit");
  assert.equal(tierOf("Publish", { inDialog: true, dialogTitle: "Publish this agent" }, { action: "open", intent: "open" }).tier, TIER.PRACTICE);
  assert.equal(tierOf("Create agent", {}, { action: "open", intent: "open" }).tier, TIER.PRACTICE, "Create agent commits in Copilot Studio");
  assert.equal(tierOf("Create agent", {}, { action: "open", intent: "open", product: "m365-copilot-agent-builder" }).tier, TIER.TRY, "but it opens the builder in Microsoft 365 Copilot");
});

test("tier 1 is opening, choosing, the test chat, and search; tier 0 is moving around", () => {
  assert.equal(tierOf("Add knowledge", {}, { action: "open", intent: "open" }).tier, TIER.TRY);
  assert.equal(tierOf("Add a tool", {}, { action: "open", intent: "open" }).tier, TIER.TRY);
  assert.equal(tierOf("Test", {}, { action: "open", intent: "open" }).tier, TIER.TRY);
  assert.equal(tierOf("SharePoint", { inDialog: true, dialogTitle: "Add knowledge" }, { intent: "choose" }).tier, TIER.TRY);
  assert.equal(tierOf("Type your message", { role: "textbox", inTestPane: true }, { action: "type" }).tier, TIER.TRY);
  assert.equal(tierOf("Send", { inTestPane: true }, { action: "send" }).tier, TIER.TRY);
  assert.equal(tierOf("Send", {}, { action: "send" }).tier, TIER.NEVER, "Send outside the test pane sends to someone");
  assert.equal(tierOf("Search", { role: "searchbox" }, { action: "type" }).tier, TIER.TRY);
  assert.equal(tierOf("Describe your agent", { role: "textbox" }, { action: "type" }).tier, TIER.TRY, "a draft box on the start page changes nothing");
  assert.equal(tierOf("Name", { role: "textbox", inDialog: true, dialogTitle: "Add knowledge" }, { action: "type" }).tier, TIER.TRY, "a dialog field is fine until the dialog is confirmed");
  assert.equal(tierOf("Knowledge", { role: "link", inNav: true }, { action: "open-nav" }).tier, TIER.LOOK);
  assert.equal(tierOf("Settings", { role: "tab" }, { action: "select-tab" }).tier, TIER.LOOK);
  assert.equal(tierOf("Security", { role: "tab" }, { action: "select-tab" }).tier, TIER.LOOK, "viewing a settings tab changes nothing");
  assert.equal(tierOf("Run history", { role: "link", inNav: true }, { action: "open-nav" }).tier, TIER.LOOK);
  assert.equal(tierOf("Sign-in logs", { role: "link", inNav: true }, { action: "open-nav" }).tier, TIER.LOOK, "reading sign-in logs is not signing in");
  assert.equal(tierOf("Share", { role: "tab" }, { action: "select-tab" }).tier, TIER.NEVER, "a tab that is itself sharing is not opened");
});

test("a leave-the-page prompt can be left, but only from a prompt about unsaved changes", () => {
  assert.equal(tierOf("Leave", { inDialog: true, dialogTitle: "Unsaved changes" }).tier, TIER.TRY);
  assert.equal(tierOf("Discard changes", { inDialog: true, dialogTitle: "Are you sure you want to leave?" }).tier, TIER.TRY);
  assert.equal(tierOf("Discard", { inDialog: true, dialogTitle: "Delete agent" }).tier, TIER.NEVER);
  assert.equal(tierOf("Discard").tier, TIER.NEVER, "discarding outside a leave prompt is not a safe thing to do");
});

test("fields that hold secrets, files, and links that sign out are never touched", () => {
  assert.equal(classifyControl({ name: "Password", role: "textbox", inputType: "password" }, { action: "type" }).tier, TIER.NEVER);
  assert.equal(classifyControl({ name: "Client secret", role: "textbox" }, { action: "type" }).tier, TIER.NEVER);
  assert.equal(classifyControl({ name: "Choose", role: "button", inputType: "file" }).tier, TIER.NEVER);
  assert.equal(classifyControl({ name: "Home", role: "link", href: "https://login.microsoftonline.com/common/oauth2/logout" }).tier, TIER.NEVER);
  assert.equal(classifyControl({ name: "Home", role: "link", href: "/account/signout" }).tier, TIER.NEVER);
});

test("typed text must be a harmless sample", () => {
  assert.equal(checkTypedText("What is our leave policy?").ok, true);
  for (const [text, reason] of [["write to ada@contoso.com", "email"], ["see https://contoso.sharepoint.com/sites/x?e=1", "url"], ["agent 0f6c2d9a-3a54-4a64-8c61-5b1d7a2e9c11", "guid"], ["call 5551234567890", "number"], ["my password is hunter2", "secret"], ["eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", "secret"], ["", "empty"], ["x".repeat(300), "too-long"]]) {
    const checked = checkTypedText(text);
    assert.equal(checked.ok, false, text.slice(0, 30));
    assert.equal(checked.reason, reason);
  }
});

test("hosts are the product's own sites and its sign-in", () => {
  assert.equal(isAllowedHost("copilotstudio.microsoft.com", "copilot-studio"), true);
  assert.equal(isAllowedHost("login.microsoftonline.com", "copilot-studio"), true);
  assert.equal(isAllowedHost("contoso.sharepoint.com", "sharepoint-ai"), true);
  assert.equal(isAllowedHost("evil.example.com", "copilot-studio"), false);
  assert.equal(isAllowedHost("copilotstudio.microsoft.com.evil.example.com", "copilot-studio"), false, "a look-alike prefix is not the product");
  assert.equal(isAllowedHost("contoso.sharepoint.com", "copilot-studio"), false, "each product has its own hosts");
  assert.equal(isAllowedUrl("https://copilotstudio.microsoft.com/environments/x/home", "copilot-studio"), true);
  assert.equal(isAllowedUrl("http://copilotstudio.microsoft.com/", "copilot-studio"), false, "https only");
  assert.equal(isAllowedUrl("about:blank", "copilot-studio"), true);
  assert.equal(isAllowedUrl("javascript:alert(1)", "copilot-studio"), false);
});

test("what a job may do comes from its consent and this computer's own setting", () => {
  assert.equal(resolveAutonomy(null).maxTier, TIER.LOOK, "no consent fields: only looking");
  assert.equal(resolveAutonomy({ level: "practice", practiceEnvironmentUrl: "https://copilotstudio.microsoft.com/environments/x" }, { allowPracticeWrites: true }).maxTier, TIER.LOOK, "a level without the person's yes is nothing");
  assert.equal(resolveAutonomy({ consented: true, level: "read-only" }).maxTier, TIER.TRY);
  const asked = { consented: true, level: "practice", practiceEnvironmentUrl: "https://copilotstudio.microsoft.com/environments/x" };
  const refused = resolveAutonomy(asked, { allowPracticeWrites: false });
  assert.equal(refused.maxTier, TIER.TRY, "the computer refuses tier 2 without its own flag, even when the job asks");
  assert.match(refused.refusedPractice, /--allow-practice-writes/);
  assert.equal(resolveAutonomy(asked, { allowPracticeWrites: true }).maxTier, TIER.PRACTICE);
  assert.equal(resolveAutonomy({ ...asked, practiceEnvironmentUrl: "" }, { allowPracticeWrites: true }).maxTier, TIER.TRY, "no practice environment, no practice agent");
});

test("the gate allows what is within the job's tier, and only changes the practice agent", () => {
  const readOnly = resolveAutonomy({ consented: true, level: "read-only" });
  const practice = resolveAutonomy({ consented: true, level: "practice", practiceEnvironmentUrl: "https://copilotstudio.microsoft.com/environments/x" }, { allowPracticeWrites: true });
  const open = { action: "open", intent: "open" };
  assert.equal(authorizeStep({ step: open, desc: control("Add knowledge"), autonomy: readOnly }).allowed, true);
  const commit = { action: "confirm", intent: "confirm" };
  assert.deepEqual([authorizeStep({ step: commit, desc: control("Publish", { inDialog: true }), autonomy: readOnly }).allowed, authorizeStep({ step: commit, desc: control("Publish", { inDialog: true }), autonomy: readOnly }).denied], [false, "needs-practice"]);
  assert.equal(authorizeStep({ step: commit, desc: control("Publish", { inDialog: true }), autonomy: practice, practice: { onPracticeAgent: false } }).allowed, false, "not in the practice agent");
  assert.equal(authorizeStep({ step: commit, desc: control("Publish", { inDialog: true }), autonomy: practice, practice: { onPracticeAgent: false } }).denied, "not-practice-agent");
  assert.equal(authorizeStep({ step: commit, desc: control("Publish", { inDialog: true }), autonomy: practice, practice: { onPracticeAgent: true } }).allowed, true);
  assert.equal(authorizeStep({ step: commit, desc: control("Delete agent"), autonomy: practice, practice: { onPracticeAgent: true } }).allowed, false, "tier 3 is never allowed, even in the practice agent");
  const none = resolveAutonomy(null);
  assert.equal(authorizeStep({ step: open, desc: control("Add knowledge"), autonomy: none }).denied, "consent", "without consent a dialog is not opened");
  assert.equal(authorizeStep({ step: { action: "open-nav" }, desc: control("Knowledge", { role: "link", inNav: true }), autonomy: none }).allowed, true, "looking is always allowed");
});
