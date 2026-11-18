// The before and after of autonomous capture, measured on the pretend tenant. For each scenario it builds a lab,
// runs the real portal and the real companion against the fake product site with a real browser, and prints how
// many screenshots ended on the right screen, how many were handed to a person, and what was touched.
//
//   node test/fixtures/autonomous-matrix.mjs                              this checkout (after)
//   node test/fixtures/autonomous-matrix.mjs --repo-dir=<other checkout>  a checkout of the base commit (before)
//   node test/fixtures/autonomous-matrix.mjs --edge                       use the installed Microsoft Edge
//   node test/fixtures/autonomous-matrix.mjs --json=<file>                also write the numbers as JSON
//   node test/fixtures/autonomous-matrix.mjs --only=iframe,cookie         only scenarios whose name contains a word
//
// The "before" checkout has no autonomous mode: it runs the default (smart) mode with nobody at the computer,
// which is how the report this change answers was produced, so every screen that needs setup ends "needs you".

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FAKE_AGENT_URL, FAKE_PRACTICE_ENV_URL, FAKE_SITE_URL } from "./fake-product-site.mjs";
import { runCaptureScenario, tally } from "./capture-scenarios.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => (a.startsWith("--") ? a.slice(2).split("=") : [a, true])).map(([k, v]) => [k, v ?? true]));
const here = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(String(args["repo-dir"] || path.join(here, "..", "..", "..", "..")));
const channel = args.edge ? "msedge" : undefined;
const only = args.only ? String(args.only).split(",") : null;
const before = Boolean(args.before) || Boolean(args["repo-dir"]);
const AGENT = { copilotStudioAgentUrl: FAKE_AGENT_URL };

const CONSENT_READ_ONLY = { consented: true, level: "read-only" };
const CONSENT_PRACTICE = { consented: true, level: "practice", practiceEnvironmentUrl: FAKE_PRACTICE_ENV_URL };
const withConsent = (consent) => async (ctx) => {
  await ctx.call("PUT", "/api/capture/consent", consent);
};

/** The scenarios. `before` ones also run on a checkout that has no autonomous mode (they use the default mode). */
export const SCENARIOS = [
  {
    name: "default mode, nobody at the computer (the report this change answers)",
    both: true,
    run: () => runCaptureScenario({ repoDir, channel, job: { targets: AGENT }, ...(before ? {} : { job: { targets: AGENT, options: { mode: "smart" } } }) }),
  },
  {
    name: "automatic, read-only consent",
    run: () => runCaptureScenario({ repoDir, channel, job: { targets: AGENT, options: { mode: "autonomous" } }, prepare: withConsent(CONSENT_READ_ONLY) }),
  },
  {
    name: "automatic with a practice agent (first job creates it)",
    practice: true,
    run: () => runCaptureScenario({ repoDir, channel, job: { targets: AGENT, options: { mode: "autonomous" } }, runOptions: { allowPracticeWrites: true }, prepare: withConsent(CONSENT_PRACTICE) }),
  },
  {
    name: "automatic, practice consent but this computer does not allow it",
    run: () => runCaptureScenario({ repoDir, channel, job: { targets: AGENT, options: { mode: "autonomous" } }, runOptions: { allowPracticeWrites: false }, prepare: withConsent(CONSENT_PRACTICE) }),
  },
  {
    name: "automatic, labels are aria-labels and icons (label variants)",
    run: () => runCaptureScenario({ repoDir, channel, site: { labelVariants: true }, job: { targets: AGENT, options: { mode: "autonomous" } }, prepare: withConsent(CONSENT_READ_ONLY) }),
  },
  {
    name: "automatic, cookie banner and an unsaved-changes prompt",
    run: () => runCaptureScenario({ repoDir, channel, site: { cookieBanner: true, leavePrompt: true }, job: { targets: AGENT, options: { mode: "autonomous" } }, prepare: withConsent(CONSENT_READ_ONLY) }),
  },
  {
    name: "automatic, test pane in an iframe and a dialog in a shadow root",
    run: () => runCaptureScenario({ repoDir, channel, site: { testPaneInIframe: true, shadowDialog: true }, job: { targets: AGENT, options: { mode: "autonomous" } }, prepare: withConsent(CONSENT_READ_ONLY) }),
  },
  {
    name: "automatic, slow answers, a flaky Add knowledge, and a slow page",
    run: () => runCaptureScenario({ repoDir, channel, site: { chatDelayMs: 2500, chatStreamMs: 1800, flakyKnowledge: true, overviewBlankMs: 2500 }, job: { targets: AGENT, options: { mode: "autonomous" } }, prepare: withConsent(CONSENT_READ_ONLY) }),
  },
  {
    name: "automatic, the tenant ignores typed section addresses (navigation only)",
    run: () => runCaptureScenario({ repoDir, channel, site: { directSections: false }, job: { targets: AGENT, options: { mode: "autonomous" } }, prepare: withConsent(CONSENT_READ_ONLY) }),
  },
  {
    name: "automatic, Agent Builder inside Microsoft 365 Copilot (no direct address)",
    agentBuilder: true,
    run: () =>
      runCaptureScenario({
        repoDir,
        channel,
        lab: { products: ["m365-copilot-agent-builder"], features: ["dca-agent-builder-first-agent", "dca-write-agent-instructions", "dca-agent-builder-knowledge"] },
        job: { options: { mode: "autonomous" } },
        prepare: withConsent(CONSENT_READ_ONLY),
      }),
  },
  {
    name: "automatic, SharePoint site",
    run: () =>
      runCaptureScenario({
        repoDir,
        channel,
        lab: { products: ["sharepoint-ai"], features: ["spai-copilot-in-sharepoint-overview"], sharepointSiteUrl: FAKE_SITE_URL, sharepointSiteName: "Training" },
        job: { options: { mode: "autonomous" } },
        prepare: withConsent(CONSENT_READ_ONLY),
      }),
  },
];

const sanitize = (text) => String(text ?? "").replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "{id}");

/** What one scenario's run came to, as plain numbers. */
export function summarize(out) {
  const t = tally(out.rows);
  const guided = out.rows.filter((r) => r.raw?.mode === "guided" && ["needs-you"].includes(r.status)).length;
  return {
    total: t.total,
    capturedOnRightScreen: t.acceptedOnRightScreen,
    savedForReview: t.needsReview,
    needsYou: t.needsYou,
    failed: t.failed,
    skipped: t.skipped,
    landedWrong: t.landedWrong,
    guidedPrompts: out.lines.filter((l) => /Waiting for you in the browser window/.test(l)).length,
    writes: out.site.stats.writes.length,
    dangers: out.site.stats.dangers.length,
    adminVisits: out.site.stats.adminVisits,
    blockedHosts: out.site.stats.blocked.length,
    practiceAgents: out.site.practiceAgents().length,
    guidedNeedsYou: guided,
    seconds: Math.round(out.elapsedMs / 100) / 10,
  };
}

export async function main() {
  const results = [];
  for (const scenario of SCENARIOS) {
    if (only && !only.some((word) => scenario.name.includes(word))) continue;
    if (before && !scenario.both) continue;
    let out;
    try {
      out = await scenario.run();
    } catch (err) {
      console.log(`\n## ${scenario.name}\n   The scenario could not run: ${err.message}`);
      results.push({ name: scenario.name, error: err.message });
      continue;
    }
    const s = summarize(out);
    results.push({ name: scenario.name, ...s });
    console.log(`\n## ${scenario.name}  (${s.seconds}s)`);
    console.log(`   shots ${s.total}: captured on the right screen ${s.capturedOnRightScreen}, saved for review ${s.savedForReview}, needs you ${s.needsYou}, failed ${s.failed}, skipped ${s.skipped}`);
    console.log(`   guided prompts ${s.guidedPrompts}; writes ${s.writes}; things it must never touch ${s.dangers}; admin page visits ${s.adminVisits}; practice agents created ${s.practiceAgents}`);
    if (args.verbose) for (const row of out.rows) console.log(`   - ${row.filename.padEnd(44)} ${row.status.padEnd(12)} ${row.cause || ""} ${sanitize(row.reason || "").slice(0, 90)}`);
  }
  if (args.json) fs.writeFileSync(String(args.json), `${JSON.stringify(results, null, 2)}\n`);
  return results;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
