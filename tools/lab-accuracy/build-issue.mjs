// Merge the three monthly reports (accuracy, screenshots, smoke) into a single
// Markdown body for the tracking GitHub issue. Writes out/issue.md and prints
// `needs_action=true|false` to GITHUB_OUTPUT (or stdout) so the workflow can
// decide whether to open/update an issue.

import fs from "node:fs";
import path from "node:path";
import { getReportsDir, readReport } from "./lib/labs.mjs";
import {
  isAccuracyReport,
  isScreenshotReport,
  isSmokeReport,
  reportsNeedAction,
} from "./lib/report-status.mjs";

const accuracy = readReport("accuracy.json");
const screenshots = readReport("screenshots.json");
const smoke = readReport("smoke.json");

const lines = [];
let needsAction = reportsNeedAction({ accuracy, screenshots, smoke });

lines.push("## 🔁 Monthly Lab Accuracy & Screenshot Audit");
lines.push("");
lines.push(`_Generated ${new Date().toISOString()} by the \`monthly-lab-accuracy\` workflow._`);
lines.push("");
lines.push(
  "This issue is automatically opened/updated each month. It checks lab content " +
    "against Microsoft Learn (via the Learn MCP server), validates reference links, " +
    "audits screenshot integrity/staleness, and smoke-tests documented start URLs.",
);
lines.push("");

// ---- Reference links + Learn drift ----
lines.push("### 📚 Microsoft Learn accuracy");
if (!isAccuracyReport(accuracy)) {
  lines.push("- ⚠️ No valid accuracy report was produced.");
} else {
  const broken = accuracy.labs.filter((l) => l.brokenLinks.length > 0);
  const unreachable = accuracy.labs.filter((l) => l.unreachableLinks?.length > 0);
  const drift = accuracy.labs.filter((l) => l.mcp?.note);
  lines.push(`- Labs scanned: **${accuracy.summary.labs}**`);
  lines.push(`- Broken reference links: **${accuracy.summary.brokenLinks}**`);
  lines.push(`- Temporarily unreachable links: **${accuracy.summary.unreachableLinks || 0}**`);
  lines.push(`- Learn drift warnings: **${accuracy.summary.mcpDriftWarnings}**` +
    (accuracy.summary.mcpUnavailable ? " _(MCP server was unavailable this run)_" : ""));
  if (accuracy.summary.mcpUnavailable) needsAction = true;
  if (broken.length) {
    needsAction = true;
    lines.push("");
    lines.push("<details><summary>Broken reference links</summary>");
    lines.push("");
    for (const lab of broken) {
      for (const link of lab.brokenLinks) {
        lines.push(`- \`${lab.name}\` → ${link.url} (HTTP ${link.status})`);
      }
    }
    lines.push("");
    lines.push("</details>");
  }
  if (unreachable.length) {
    lines.push("");
    lines.push("<details><summary>Reference links that could not be checked</summary>");
    lines.push("");
    for (const lab of unreachable) {
      for (const link of lab.unreachableLinks) {
        lines.push(`- \`${lab.name}\` → ${link.url} (${link.error || "network error"})`);
      }
    }
    lines.push("");
    lines.push("</details>");
  }
  if (drift.length) {
    needsAction = true;
    lines.push("");
    lines.push("<details><summary>Learn drift (cited docs not in current top results)</summary>");
    lines.push("");
    for (const lab of drift) {
      lines.push(`- \`${lab.name}\`: ${lab.mcp.note}`);
    }
    lines.push("");
    lines.push("</details>");
  }
}
lines.push("");

// ---- Screenshots ----
lines.push("### 🖼️ Screenshot audit");
if (!isScreenshotReport(screenshots)) {
  lines.push("- ⚠️ No valid screenshot report was produced.");
} else {
  lines.push(`- Labs needing re-capture: **${screenshots.summary.labsNeedingRecapture}**`);
  lines.push(`- Missing images: **${screenshots.summary.missingImages}** · Stale (> ${screenshots.staleThresholdDays}d): **${screenshots.summary.staleImages}**`);
  lines.push(`- verify-shots critical: **${screenshots.verifyShots.critical}** · warnings: **${screenshots.verifyShots.warning}**`);
  const todo = screenshots.labs.filter((l) => l.needsRecapture);
  if (todo.length) {
    needsAction = true;
    lines.push("");
    lines.push("> Screenshot capture of authenticated Copilot Studio UI is interactive (sign-in + manual UI staging per shot), so re-capture is human-in-the-loop. Run the command listed for each lab below.");
    lines.push("");
    for (const lab of todo) {
      lines.push(`#### \`${lab.name}\` — ${lab.title ?? ""}`);
      const bits = [];
      if (lab.missingImages.length) bits.push(`${lab.missingImages.length} missing`);
      if (lab.staleImages.length) bits.push(`${lab.staleImages.length} stale`);
      if (lab.criticalFindings.length) bits.push(`${lab.criticalFindings.length} integrity issue(s)`);
      lines.push(`- ${bits.join(" · ") || "needs review"}`);
      if (lab.recaptureCommand) {
        lines.push("");
        lines.push("```bash");
        lines.push(lab.recaptureCommand);
        lines.push("```");
      }
    }
  }
}
lines.push("");

// ---- Smoke test ----
lines.push("### 🌐 Start-URL smoke test");
if (!isSmokeReport(smoke)) {
  lines.push("- ⚠️ No valid smoke report was produced.");
} else {
  lines.push(`- URLs tested: **${smoke.summary.urls}** · reachable: **${smoke.summary.reachable}** · unreachable: **${smoke.summary.unreachable}**`);
  const dead = smoke.urls.filter((u) => !u.reachable);
  if (dead.length) {
    needsAction = true;
    lines.push("");
    for (const u of dead) {
      lines.push(`- ❌ ${u.url} (used by: ${u.usedBy.join(", ")}) — ${u.status ?? u.error}`);
    }
  }
}
lines.push("");
lines.push("---");
lines.push(needsAction
  ? "**Action required:** one or more checks need a maintainer. See sections above."
  : "**All checks passed.** No maintainer action required this month. ✅");
lines.push("");

const body = lines.join("\n");
const outDir = getReportsDir();
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "issue.md"), body);

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `needs_action=${needsAction}\n`);
}
console.log(`needs_action=${needsAction}`);
console.log(`Issue body written to ${path.join(outDir, "issue.md")}`);
