// Step-level lab validation against Microsoft Learn (phase 1: documentation check).
//
// For every lab it splits the step-by-step instructions into steps, extracts the
// verifiable claims in each step (UI labels, menu paths, settings, requirements,
// limits, availability stage), and checks each claim against current Microsoft
// Learn content through the Learn MCP. Each claim is reported as verified,
// unverified (no supporting doc found), likely stale (a named rule found
// contradicting text), or unable to verify (Learn lookups failed). A failed
// lookup is never reported as a pass.
//
// Usage:
//   node check-steps.mjs [--lab=35] [--lab=06-energy-weather-agent]
//        [--fail-on=stale|unverified|none] [--allow-unavailable]
//        [--markdown] [--json] [--out=<dir>] [--cache-dir=<dir>] [--no-cache]
//        [--max-calls=<n>] [--min-interval-ms=<n>] [--quiet]
//
// Writes out/step-accuracy.json (and step-accuracy.md with --markdown).
//
// Exit codes:
//   0  no findings at the chosen --fail-on level, and every claim could be checked
//   1  likely-stale claims (or unverified ones with --fail-on=unverified)
//   2  Microsoft Learn could not be reached for some claims (unless --allow-unavailable)
//   3  usage or internal error
//
// The engine lives in portal/lib/step-validator and is shared with the portal's
// Validation tab. See docs/step-validation.md.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { discoverLabs, getReportsDir, loadLab, repoRoot, writeReport } from "./lib/labs.mjs";
import { createLearnClient } from "../../portal/lib/step-validator/learn-client.js";
import { toMarkdown } from "../../portal/lib/step-validator/report.js";
import { validateLabs } from "../../portal/lib/step-validator/runner.js";

export const EXIT = Object.freeze({ OK: 0, FINDINGS: 1, UNAVAILABLE: 2, ERROR: 3 });
const FAIL_ON = new Set(["stale", "unverified", "none"]);

export class UsageError extends Error {}

/** Parse CLI arguments. Throws UsageError for anything unrecognized. */
export function parseArgs(argv) {
  const opts = {
    labs: [],
    failOn: "stale",
    allowUnavailable: false,
    markdown: false,
    json: false,
    quiet: false,
    noCache: false,
    out: null,
    cacheDir: null,
    maxCalls: null,
    minIntervalMs: null,
  };
  for (const arg of argv) {
    const [flag, ...rest] = arg.split("=");
    const value = rest.join("=");
    switch (flag) {
      case "--lab":
        if (!value) throw new UsageError("--lab needs a value, for example --lab=35");
        opts.labs.push(value);
        break;
      case "--fail-on":
        if (!FAIL_ON.has(value)) throw new UsageError("--fail-on must be stale, unverified, or none");
        opts.failOn = value;
        break;
      case "--allow-unavailable":
        opts.allowUnavailable = true;
        break;
      case "--markdown":
        opts.markdown = true;
        break;
      case "--json":
        opts.json = true;
        break;
      case "--quiet":
        opts.quiet = true;
        break;
      case "--no-cache":
        opts.noCache = true;
        break;
      case "--out":
        if (!value) throw new UsageError("--out needs a directory");
        opts.out = value;
        break;
      case "--cache-dir":
        if (!value) throw new UsageError("--cache-dir needs a directory");
        opts.cacheDir = value;
        break;
      case "--max-calls":
      case "--min-interval-ms": {
        const n = Number.parseInt(value, 10);
        if (!Number.isInteger(n) || n < 0) throw new UsageError(`${flag} needs a non-negative integer`);
        if (flag === "--max-calls") opts.maxCalls = n;
        else opts.minIntervalMs = n;
        break;
      }
      default:
        throw new UsageError(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

/** Map a finished report to a process exit code. */
export function exitCodeFor(report, { failOn = "stale", allowUnavailable = false } = {}) {
  const claims = report.summary.claimStatus;
  if (failOn !== "none" && claims.stale > 0) return EXIT.FINDINGS;
  if (failOn === "unverified" && claims.unverified > 0) return EXIT.FINDINGS;
  if (!allowUnavailable && claims.unable > 0) return EXIT.UNAVAILABLE;
  return EXIT.OK;
}

/** Resolve --lab values (full folder name or numeric prefix) to lab folder names. */
export function resolveLabNames(requested, available) {
  if (!requested.length) return available;
  return requested.map((value) => {
    const match = available.find((name) => name === value || name.startsWith(`${value}-`) || name.startsWith(value.padStart(2, "0")));
    if (!match) throw new UsageError(`No lab matches "${value}". Available: ${available.slice(0, 5).join(", ")}…`);
    return match;
  });
}

function loadLabInputs(names) {
  return names.map((name) => {
    const lab = loadLab(name);
    return {
      labId: name,
      title: lab.title || name,
      products: lab.products,
      markdown: fs.readFileSync(path.join(repoRoot, lab.indexPath), "utf8"),
    };
  });
}

/**
 * Run the check. `learn` and `loadLabs` are injectable so tests never touch the network.
 * Resolves to the process exit code instead of exiting, so callers decide.
 */
export async function main({ argv = process.argv.slice(2), learn, loadLabs = loadLabInputs, log = console.log, errorLog = console.error } = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    errorLog(err.message);
    return EXIT.ERROR;
  }
  if (opts.out) process.env.LAB_ACCURACY_OUT_DIR = path.resolve(opts.out);

  let labs;
  try {
    labs = loadLabs(resolveLabNames(opts.labs, discoverLabs()));
  } catch (err) {
    errorLog(err.message);
    return EXIT.ERROR;
  }

  const client =
    learn ??
    createLearnClient({
      cacheDir: opts.noCache ? null : opts.cacheDir ? path.resolve(opts.cacheDir) : path.join(getReportsDir(), "learn-cache"),
      ...(opts.maxCalls != null ? { maxCalls: opts.maxCalls } : {}),
      ...(opts.minIntervalMs != null ? { minIntervalMs: opts.minIntervalMs } : {}),
    });

  const onProgress = (event) => {
    if (opts.quiet) return;
    if (event.type === "lab-start") log(`\n${event.labId} (${event.labIndex}/${event.labTotal}): ${event.stepTotal} section(s)`);
    if (event.type === "step-done") {
      const c = event.step.counts;
      log(`  [${event.stepIndex}/${event.stepTotal}] ${event.stepTitle}: ${event.status} (${c.verified} verified, ${c.unverified} unverified, ${c.stale} stale, ${c.unable} unable)`);
    }
  };

  let report;
  try {
    report = await validateLabs(labs, { learn: client, onProgress });
  } catch (err) {
    errorLog(`Step validation failed: ${err.message}`);
    return EXIT.ERROR;
  }

  const jsonPath = writeReport("step-accuracy.json", report);
  if (opts.markdown) {
    const mdPath = path.join(getReportsDir(), "step-accuracy.md");
    fs.writeFileSync(mdPath, toMarkdown(report));
    log(`Markdown report written to ${mdPath}`);
  }
  if (opts.json) log(JSON.stringify(report, null, 2));

  const s = report.summary;
  log(`\nStep report written to ${jsonPath}`);
  log(
    `Summary: ${s.labs} lab(s), ${s.steps} step(s), ${s.claims} claim(s): ${s.claimStatus.verified} verified, ` +
      `${s.claimStatus.unverified} unverified, ${s.claimStatus.stale} likely stale, ${s.claimStatus.unable} unable to verify`,
  );
  for (const lab of report.labs) {
    for (const step of lab.steps) {
      for (const claim of step.checks.docs.claims) {
        if (claim.status !== "stale") continue;
        log(`  ⚠ ${lab.labId} › ${step.title}: ${claim.term} — ${claim.explanation}${claim.evidence[0] ? ` (${claim.evidence[0].url})` : ""}`);
      }
    }
  }
  if (s.claimStatus.unable > 0) {
    log(`Microsoft Learn could not be reached for ${s.claimStatus.unable} claim(s). They are reported as "unable to verify", never as passing.`);
  }

  const code = exitCodeFor(report, opts);
  if (code === EXIT.UNAVAILABLE) errorLog("Exiting 2: Microsoft Learn was unavailable (use --allow-unavailable to tolerate this).");
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error);
      process.exit(EXIT.ERROR);
    },
  );
}
