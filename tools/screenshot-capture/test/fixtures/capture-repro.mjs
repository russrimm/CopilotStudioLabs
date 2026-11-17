// Reproduces the capture failures from the real report against a pretend Copilot Studio, and prints what
// happened to each screenshot. Run it on any checkout to compare before and after:
//
//   node test/fixtures/capture-repro.mjs                              this checkout
//   node test/fixtures/capture-repro.mjs --repo-dir=<other checkout>  for example a checkout of the base commit
//   node test/fixtures/capture-repro.mjs --verbose                    also list every shot
//   node test/fixtures/capture-repro.mjs --only=blank,closed          only scenarios whose name contains a word
//   node test/fixtures/capture-repro.mjs --edge --headed --only=guided  the guided flow in a visible Edge window
//
// Needs Playwright and a browser (Playwright's Chromium or Microsoft Edge) and the checkout's portal folder
// installed (npm ci in portal/).

import path from "node:path";
import { fileURLToPath } from "node:url";

import { FAKE_AGENT_URL, FAKE_SITE_URL } from "./fake-product-site.mjs";
import { judge, runCaptureScenario, tally } from "./capture-scenarios.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => (a.startsWith("--") ? a.slice(2).split("=") : [a, true])).map(([k, v]) => [k, v ?? true]));
const repoDir = path.resolve(String(args["repo-dir"] || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..")));
const only = args.only ? String(args.only).split(",") : null;
const verbose = Boolean(args.verbose);
const channel = args.edge ? "msedge" : undefined;
const headed = Boolean(args.headed);
const skipAfterOnly = Boolean(args.before);

const sanitize = (text) => String(text ?? "").replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "{id}");
const AGENT = { copilotStudioAgentUrl: FAKE_AGENT_URL };

/** Plays the person at a guided screen: sets the screen up in the page, then uses the toolbar. */
export async function scriptedPerson({ page, shot }) {
  const name = shot.filename;
  if (/test-pane|activity-map|citation/.test(name)) {
    await page.getByRole("button", { name: "Test", exact: true }).click();
    await page.getByLabel("Type your message").fill("What is our policy?");
    await page.getByRole("button", { name: "Send", exact: true }).click();
  } else if (/knowledge-sharepoint-add/.test(name)) {
    await page.getByRole("button", { name: "Add knowledge", exact: true }).click();
  }
  // Publishing changes the tenant, so this person skips that screen.
  const button = /publish/.test(name) ? "Skip" : "Capture this screen";
  await page.getByRole("button", { name: button, exact: true }).click();
}

export const SCENARIOS = [
  {
    name: "as reported: no addresses set, the generic start page",
    run: () => runCaptureScenario({ repoDir, channel, site: { overviewBlankMs: 0 } }),
  },
  {
    name: "old workaround: the start address variable points at the agent",
    run: () => runCaptureScenario({ repoDir, channel, job: { env: { CAPTURE_COPILOT_STUDIO_START_URL: FAKE_AGENT_URL } } }),
  },
  {
    name: "slow app: the agent overview stays a white page with a spinner",
    run: () => runCaptureScenario({ repoDir, channel, site: { overviewBlankMs: 5000 }, job: { env: { CAPTURE_COPILOT_STUDIO_START_URL: FAKE_AGENT_URL }, targets: AGENT } }),
  },
  {
    name: "browser window closed after two screenshots",
    run: () =>
      runCaptureScenario({
        repoDir,
        channel,
        job: { targets: AGENT },
        onUpload: async ({ uploads, contexts }) => {
          if (uploads === 2) await Promise.all(contexts.map((c) => c.close().catch(() => {})));
        },
      }),
  },
  {
    name: "first navigation interrupted (net::ERR_ABORTED)",
    run: () => runCaptureScenario({ repoDir, channel, site: { abortFirstNavigation: true }, job: { targets: AGENT } }),
  },
  {
    name: "lab built with a SharePoint site address, nothing else set",
    run: () =>
      runCaptureScenario({
        repoDir,
        channel,
        lab: { products: ["sharepoint-ai"], features: ["spai-copilot-in-sharepoint-overview"], sharepointSiteUrl: FAKE_SITE_URL, sharepointSiteName: "Training" },
      }),
  },
  {
    name: "agent address set in Capture settings (nobody at the computer)",
    afterOnly: true,
    run: () => runCaptureScenario({ repoDir, channel, job: { targets: AGENT } }),
  },
  {
    name: "agent address set, the product ignores typed addresses (navigation only)",
    afterOnly: true,
    run: () => runCaptureScenario({ repoDir, channel, site: { directSections: false }, job: { targets: AGENT } }),
  },
  {
    name: "agent name set instead of an address, slow page that fills in late",
    afterOnly: true,
    run: () => runCaptureScenario({ repoDir, channel, site: { lateTextMs: 1500, overviewBlankMs: 2500 }, job: { targets: { copilotStudioAgentName: "Energy Assistant" } } }),
  },
  {
    name: "guided: a person sets up each screen",
    afterOnly: true,
    run: () => runCaptureScenario({ repoDir, channel, job: { targets: AGENT, options: { mode: "guided" } }, runOptions: { attended: true, headless: !headed, onGuidedWaiting: scriptedPerson } }),
  },
];

export async function main() {
  for (const scenario of SCENARIOS) {
    if (only && !only.some((word) => scenario.name.includes(word))) continue;
    if (scenario.afterOnly && skipAfterOnly) continue;
    const started = Date.now();
    let out;
    try {
      out = await scenario.run();
    } catch (err) {
      console.log(`\n## ${scenario.name}\n   The scenario could not run: ${err.message}`);
      continue;
    }
    const t = tally(out.rows);
    console.log(`\n## ${scenario.name}  (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    console.log(`   shots ${t.total}: accepted ${t.accepted} (on the right screen ${t.acceptedOnRightScreen}, on a wrong screen ${t.acceptedOnWrongScreen}), needs review ${t.needsReview}, failed ${t.failed}, skipped ${t.skipped}, paused ${t.paused}, needs you ${t.needsYou}`);
    console.log(`   landed on the right screen ${t.landedRight}, on a wrong screen ${t.landedWrong}; writes to the pretend tenant: ${out.site.stats.writes.length}`);
    const writes = out.site.stats.writes;
    if (writes.length) console.log(`   !! writes: ${writes.join(", ")}`);
    if (verbose) {
      for (const row of out.rows) {
        const { section, right } = judge(row);
        console.log(`   - ${row.filename.padEnd(40)} ${row.status.padEnd(13)} ${(section || "-").padEnd(10)} ${right === null ? " " : right ? "right" : "WRONG"}  ${sanitize(row.reason || "").slice(0, 110)}`);
      }
    }
  }
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
