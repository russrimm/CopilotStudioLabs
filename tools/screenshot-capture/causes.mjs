// Why a screenshot did not happen, in plain language, with one fix per cause. The companion reports a short
// code with each shot; the portal groups the shots by code so a person reads "No agent address set: 12
// screenshots" and does one thing, not fifty repeated lines.

export const CAUSES = Object.freeze({
  "no-agent": { code: "no-agent", title: "No agent address set", fix: "Add your agent's address or name in Capture settings, then retake.", fixAction: "settings", tone: "warn" },
  "no-site": { code: "no-site", title: "No SharePoint site address set", fix: "Add your SharePoint site address in Capture settings, then retake.", fixAction: "settings", tone: "warn" },
  "no-address": { code: "no-address", title: "A tenant address is missing", fix: "Add the address in Capture settings, then retake.", fixAction: "settings", tone: "warn" },
  "agent-not-found": { code: "agent-not-found", title: "The agent was not found", fix: "Check the agent name or address in Capture settings. The name must match exactly.", fixAction: "settings", tone: "warn" },
  "sign-in": { code: "sign-in", title: "Sign-in needed", fix: "Sign in in the companion's browser window, then retake.", fixAction: "retry", tone: "warn" },
  "wrong-screen": { code: "wrong-screen", title: "The wrong screen was open", fix: "Retake with “Retake guided”, or check the agent address in Capture settings.", fixAction: "guided", tone: "warn" },
  "control-not-found": { code: "control-not-found", title: "A control could not be found", fix: "Use “Retake guided” and open the screen yourself.", fixAction: "guided", tone: "warn" },
  "blank-page": { code: "blank-page", title: "The page did not finish loading", fix: "Retake it. If it keeps happening, check that the page opens in the companion's browser.", fixAction: "retry", tone: "warn" },
  "navigation-failed": { code: "navigation-failed", title: "The page could not be opened", fix: "Check your connection and retake.", fixAction: "retry", tone: "warn" },
  "browser-closed": { code: "browser-closed", title: "Paused: the browser window was closed", fix: "Select Resume to continue where it stopped.", fixAction: "resume", tone: "info" },
  "needs-you": { code: "needs-you", title: "This screen needs you", fix: "Use “Retake guided” to set up the screen and capture it yourself.", fixAction: "guided", tone: "info" },
  "automation-failed": { code: "automation-failed", title: "The computer could not set this screen up", fix: "Use “Show me once” so it can learn the steps, or set the screen up yourself with “Retake guided”.", fixAction: "record", tone: "warn" },
  "needs-practice-agent": { code: "needs-practice-agent", title: "Needs a practice agent", fix: "Allow a practice agent in the consent card, then retake. The picture shows the screen as far as the computer could go without one.", fixAction: "consent", tone: "info" },
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
