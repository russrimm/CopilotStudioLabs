#!/usr/bin/env node
/**
 * `npm run test:concurrency` (from portal/): run the concurrency harness and print a table.
 *
 *   npm run test:concurrency                      12 people, 2 rounds, seed 1, about two minutes
 *   npm run test:concurrency -- --users 4 --rounds 1
 *   npm run test:concurrency -- --portal-dir D:\path\to\other\checkout\portal --label main --out out
 *   npm run test:concurrency -- --shared-ip       every request from one address (an ingress that hides callers)
 *   npm run test:concurrency -- --relaxed         raise per-person rate limits to measure capacity, not throttling
 *   npm run test:concurrency -- --json            print the report as JSON
 *
 * Exit code 0 means no unexpected answers and every integrity check passed. See docs/lab-builder.md, "Many people at once".
 */

import { formatReport, runHarness } from "./harness.mjs";

function parse(argv) {
  const opts = { users: 12, rounds: 2, seed: 1 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[(i += 1)];
    if (arg === "--users") opts.users = Number(next());
    else if (arg === "--rounds") opts.rounds = Number(next());
    else if (arg === "--max-seconds") opts.maxSeconds = Number(next());
    else if (arg === "--seed") opts.seed = Number(next());
    else if (arg === "--portal-dir") opts.portalDir = next();
    else if (arg === "--label") opts.label = next();
    else if (arg === "--out") opts.outDir = next();
    else if (arg === "--shared-ip") opts.sharedIp = true;
    else if (arg === "--relaxed") opts.relaxedLimits = true;
    else if (arg === "--no-capture") opts.capture = false;
    else if (arg === "--no-client-id") opts.clientIds = false;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error(`Unknown option ${arg}`);
  }
  return opts;
}

const opts = parse(process.argv.slice(2));
if (opts.help) {
  console.log("Usage: npm run test:concurrency -- [--users N (max 12)] [--rounds N] [--seed N] [--portal-dir DIR] [--label NAME] [--out DIR] [--shared-ip] [--relaxed] [--no-capture] [--no-client-id] [--json]");
  process.exit(0);
}
const report = await runHarness(opts);
console.log(opts.json ? JSON.stringify(report, null, 2) : formatReport(report));
process.exit(report.ok ? 0 : 1);
