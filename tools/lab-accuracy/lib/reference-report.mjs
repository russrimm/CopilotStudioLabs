// The "Reference links" section of the monthly issue (issue #39).
//
// Microsoft Learn links keep their own section, with drift, because they are the
// first-party source. This section puts the first-/third-party counts side by
// side so a broken vendor link is as visible as a broken Learn link, and lists
// every third-party link that needs a look.

import { isReferenceReport, referenceLinksNeedAction } from "./report-status.mjs";

function details(lines, summary, entries, { open = false, footer } = {}) {
  if (!entries.length) return;
  lines.push("");
  lines.push(`<details${open ? " open" : ""}><summary>${summary}</summary>`);
  lines.push("");
  lines.push(...entries);
  if (footer) {
    lines.push("");
    lines.push(footer);
  }
  lines.push("");
  lines.push("</details>");
}

/**
 * @returns {{lines:string[], needsAction:boolean}}
 */
export function referenceLinksSection(accuracy) {
  const lines = ["### 🔗 Reference links"];
  if (!isReferenceReport(accuracy)) {
    lines.push("- ⚠️ The accuracy report has no valid first-/third-party reference-link data.");
    return { lines, needsAction: true };
  }

  const { firstParty, thirdParty } = accuracy.summary.references;
  lines.push(
    `- Microsoft Learn (first-party): **${firstParty.checked}** checked · broken **${firstParty.broken}** · ` +
      `unreachable **${firstParty.unreachable}**${firstParty.broken || firstParty.unreachable ? " _(listed above)_" : ""}`,
  );
  lines.push(
    `- Third-party: **${thirdParty.checked}** checked · broken **${thirdParty.broken}** · ` +
      `unreachable **${thirdParty.unreachable}** · unverifiable **${thirdParty.unverifiable}** · ` +
      `skipped by policy **${thirdParty.skipped}**`,
  );

  const each = (key, render) =>
    accuracy.labs.flatMap((lab) => lab.thirdPartyLinks[key].map((link) => render(lab, link)));

  details(
    lines,
    "Broken third-party links — fix or replace in the lab",
    each("broken", (lab, link) => `- \`${lab.name}\` → ${link.url} (HTTP ${link.status})`),
    {
      open: true,
      footer:
        "The vendor's site reports these pages gone. Update the lab to the page's new location, or cite a " +
        "different source. Do not add the host to `tools/lab-accuracy/link-policy.json` to silence a broken link.",
    },
  );
  details(
    lines,
    "Third-party links that could not be reached",
    each("unreachable", (lab, link) => `- \`${lab.name}\` → ${link.url} (${link.error || "network error"})`),
  );
  details(
    lines,
    "Third-party links a site refused to check (HTTP 401/403/429)",
    each("unverifiable", (lab, link) => `- \`${lab.name}\` → ${link.url} (HTTP ${link.status})`),
    { footer: "These sites turn away automated requests. Open them in a browser if the lab is being revised." },
  );

  const skipped = new Map();
  for (const lab of accuracy.labs) {
    for (const link of lab.thirdPartyLinks.skipped) {
      const entry = skipped.get(link.host) || { reason: link.reason, labs: new Set() };
      entry.labs.add(lab.name);
      skipped.set(link.host, entry);
    }
  }
  details(
    lines,
    "Hosts skipped by `link-policy.json`",
    [...skipped].sort(([a], [b]) => a.localeCompare(b)).map(
      ([host, entry]) => `- \`${host}\` (${[...entry.labs].map((name) => `\`${name}\``).join(", ")}): ${entry.reason}`,
    ),
  );

  return { lines, needsAction: referenceLinksNeedAction(accuracy) };
}
