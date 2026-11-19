// Why a screenshot did not happen, in plain language, with one fix per cause. The companion reports a short
// code with each shot; the portal groups the shots by code so a person reads "No agent address set: 12
// screenshots" and does one thing, not fifty repeated lines.

export const CAUSES = Object.freeze({
  "no-agent": { code: "no-agent", title: "No agent address set", fix: "Add your agent's address or name in Capture settings, then retake.", fixAction: "settings", tone: "warn" },
  "no-site": { code: "no-site", title: "No SharePoint site address set", fix: "Add your SharePoint site address in Capture settings, then retake.", fixAction: "settings", tone: "warn" },
  "no-address": { code: "no-address", title: "A tenant address is missing", fix: "Add the address in Capture settings, then retake.", fixAction: "settings", tone: "warn" },
  "agent-not-found": { code: "agent-not-found", title: "The agent was not found", fix: "Check the agent name or address in Capture settings. The name must match exactly.", fixAction: "settings", tone: "warn" },
  "sign-in": { code: "sign-in", title: "Sign-in needed", fix: "Sign in in the companion's browser window, then retake.", fixAction: "retry", tone: "warn" },
  "needs-account": { code: "needs-account", title: "Signed in to the wrong account", fix: "Choose which account to use: sign in with the account that owns your agent or site (for example your demo tenant), then retake.", fixAction: "account", tone: "warn" },
  "wrong-screen": { code: "wrong-screen", title: "The wrong screen was open", fix: "Retake with “Retake guided”, or check the agent address in Capture settings.", fixAction: "guided", tone: "warn" },
  "control-not-found": { code: "control-not-found", title: "A control could not be found", fix: "Use “Retake guided” and open the screen yourself.", fixAction: "guided", tone: "warn" },
  "blank-page": { code: "blank-page", title: "The page did not finish loading", fix: "Retake it. If it keeps happening, check that the page opens in the companion's browser.", fixAction: "retry", tone: "warn" },
  "navigation-failed": { code: "navigation-failed", title: "The page could not be opened", fix: "Check your connection and retake.", fixAction: "retry", tone: "warn" },
  "browser-closed": { code: "browser-closed", title: "Paused: the browser window was closed", fix: "Select Resume to continue where it stopped.", fixAction: "resume", tone: "info" },
  "browser-busy": { code: "browser-busy", title: "Waiting for the browser", fix: "Close the browser window from an earlier capture that is still open on your computer, then select Resume.", fixAction: "resume", tone: "info" },
  "needs-you": { code: "needs-you", title: "This screen needs you", fix: "Use “Retake guided” to set up the screen and capture it yourself.", fixAction: "guided", tone: "info" },
  "automation-failed": { code: "automation-failed", title: "The computer could not set this screen up", fix: "Use “Show me once” so it can learn the steps, or set the screen up yourself with “Retake guided”.", fixAction: "record", tone: "warn" },
  "needs-practice-agent": { code: "needs-practice-agent", title: "Needs a practice agent", fix: "Allow a practice agent in the consent card, then retake. The picture shows the screen as far as the computer could go without one.", fixAction: "consent", tone: "info" },
  "needs-connection": { code: "needs-connection", title: "Needs a connection you must allow", fix: "Add the tool yourself with “Retake guided”, or upload the picture. The computer never creates connections or signs in to other services.", fixAction: "guided", tone: "info" },
  "needs-files": { code: "needs-files", title: "Needs sample files", fix: "Put the sample files in place (for example in a SharePoint library), then use “Retake guided”. The computer never uploads files.", fixAction: "guided", tone: "info" },
  "needs-credits": { code: "needs-credits", title: "Uses Copilot Credits", fix: "Run the evaluation yourself with “Retake guided”, or upload the picture. The computer does not spend Copilot Credits for you.", fixAction: "guided", tone: "info" },
  "needs-channel": { code: "needs-channel", title: "Needs a channel", fix: "Set up the channel yourself with “Retake guided”. The computer only publishes to the agent's own default channel.", fixAction: "guided", tone: "info" },
  "needs-admin": { code: "needs-admin", title: "Needs admin access", fix: "Capture it yourself with an account that has admin access. The computer never opens or changes tenant, admin, security, or billing settings.", fixAction: "guided", tone: "info" },
  "needs-other-product": { code: "needs-other-product", title: "In another product", fix: "Capture it in that product with “Retake guided”.", fixAction: "guided", tone: "info" },
  "run-stopped": { code: "run-stopped", title: "The run stopped on an unexpected prompt", fix: "Look at the companion's window: a license, permission, sign-in, quota, or error message appeared. Deal with it, then use Resume or start the capture again.", fixAction: "retry", tone: "warn" },
  "agent-create-failed": { code: "agent-create-failed", title: "The practice agent could not be built", fix: "The account may not be allowed to create agents in this environment, or a step changed. Pick an environment where you can create agents, use “Show me once” to teach the Create step, or choose “Use an existing agent”.", fixAction: "consent", tone: "warn" },
  "no-environment": { code: "no-environment", title: "No environment was found", fix: "Open Copilot Studio in the companion's window once so it lands on an environment, or give the environment's address in the consent card.", fixAction: "consent", tone: "warn" },
  "scratch-off": { code: "scratch-off", title: "This computer has not agreed to build a practice agent", fix: "Agree when the companion asks (or run it with --allow-practice-writes), then retake.", fixAction: "retry", tone: "warn" },
  "blocked-by-safety": { code: "blocked-by-safety", title: "The computer would not do this step", fix: "The step is something the computer never does on its own (for example deleting or sharing). Set the screen up yourself with “Retake guided”.", fixAction: "guided", tone: "info" },
  "unexpected-effect": { code: "unexpected-effect", title: "A click did something unexpected", fix: "The capture stopped so nothing else was clicked. Set the screen up yourself with “Retake guided”.", fixAction: "guided", tone: "warn" },
  "skipped-by-you": { code: "skipped-by-you", title: "You skipped this screen", fix: "Retake it when you are ready.", fixAction: "retry", tone: "info" },
  stopped: { code: "stopped", title: "You stopped the capture", fix: "Select Resume to continue.", fixAction: "resume", tone: "info" },
  manual: { code: "manual", title: "Outside the browser", fix: "Capture it with an OS screenshot tool and upload it.", fixAction: "upload", tone: "info" },
  rejected: { code: "rejected", title: "The image failed a check", fix: "Retake it. If it fails again, upload the screenshot yourself.", fixAction: "retry", tone: "warn" },
  unknown: { code: "unknown", title: "The capture did not finish", fix: "Retake it. If it keeps happening, run the companion with --debug and check the trace.", fixAction: "retry", tone: "warn" },
});

export function describeCause(code) {
  return CAUSES[code] || CAUSES.unknown;
}

/** Which cause a reason from the image checks belongs to. */
export function causeForVerification(reasons) {
  const codes = new Set((reasons || []).map((r) => r.code));
  if (codes.has("sign-in-page")) return "sign-in";
  if (codes.has("blank") || codes.has("near-uniform")) return "blank-page";
  if (codes.has("wrong-screen")) return "wrong-screen";
  if (codes.has("needs-practice-agent")) return "needs-practice-agent";
  return null;
}
