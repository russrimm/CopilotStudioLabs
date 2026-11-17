#!/usr/bin/env node
// Reproduces the "first screenshot works, then it keeps asking me to sign in" report
// with a real browser and a pretend tenant (nothing leaves this computer).
//
//   node test/fixtures/signin-repro.mjs                              test this checkout
//   node test/fixtures/signin-repro.mjs --tool-dir=<other checkout>  compare another copy (for before and after)
//   node test/fixtures/signin-repro.mjs --channel=msedge             use the installed Microsoft Edge instead of Chromium
//
// prompts = how many times the pretend sign-in page was shown; signOuts = how many
// times the companion signed the account out; captured = uploaded pictures.

import path from "node:path";
import { fileURLToPath } from "node:url";

import { runScenario, scenarioCatalog } from "./signin-scenarios.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const toolDir = path.resolve(arg("tool-dir") || path.join(here, "..", ".."));
const channel = arg("channel");

async function main() {
  console.log(`Tool folder: ${toolDir}${channel ? `   Browser channel: ${channel}` : "   Browser: bundled Chromium"}\n`);
  const rows = [];
  for (const [name, scenario] of Object.entries(scenarioCatalog())) {
    const out = await runScenario({ toolDir, tenantOptions: scenario.tenant, jobs: scenario.jobs, channel, signInWaitSec: 9 });
    const statuses = out.results.flatMap((r) => r.calls.statuses.filter((s) => !s.endsWith(":running")));
    rows.push({
      scenario: name,
      prompts: out.tenant.stats.interactivePages,
      signOuts: out.tenant.stats.signOuts,
      captured: out.results.reduce((n, r) => n + r.calls.uploads.length, 0),
      "not captured": statuses.map((s) => s.replace(".png", "")).join(" "),
      seconds: Math.round(out.elapsedMs / 100) / 10,
    });
  }
  console.table(rows);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
