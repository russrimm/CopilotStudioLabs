#!/usr/bin/env node
/**
 * Standalone lab builder CLI.
 *
 * Builds a custom, Microsoft Learn-grounded Copilot Studio lab without needing
 * the portal or any authentication.
 *
 *   node tools/lab-builder/build.mjs --list
 *   node tools/lab-builder/build.mjs --industry retail --roles customer-service \
 *        --features knowledge-sharepoint,connector-tools,adaptive-cards
 *   node tools/lab-builder/build.mjs --interactive
 */

import path from "node:path";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const LIB = path.join(REPO_ROOT, "portal", "lib");

const { getFeaturesByCategory, getFeature, getFeatures } = await import(
  pathToFileURL(path.join(LIB, "lab-builder", "catalog.js")).href
);
const { generateLab, OUTPUT_ROOT } = await import(
  pathToFileURL(path.join(LIB, "lab-builder", "generator.js")).href
);
const { normalizeDecisions } = await import(
  pathToFileURL(path.join(LIB, "lab-builder", "blockers.js")).href
);
const { getIndustries, getRoles } = await import(pathToFileURL(path.join(LIB, "scenarios.js")).href);

/** Exit codes, so CI can tell "needs a human" from "produced something broken". */
const EXIT = { OK: 0, VALIDATION_FAILED: 1, DECISION_REQUIRED: 2, CANCELLED: 3 };

function parseArgs(argv) {
  const args = {};
  const set = (key, value) => {
    // Repeatable flags (--decide) accumulate instead of overwriting.
    if (key in args) args[key] = [].concat(args[key], value);
    else args[key] = value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const eq = token.indexOf("=");
    if (eq > -1) {
      set(token.slice(2, eq), token.slice(eq + 1));
    } else {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        set(token.slice(2), next);
        i += 1;
      } else {
        set(token.slice(2), true);
      }
    }
  }
  return args;
}

/** Wrap prose to a readable width so long consequences stay legible. */
function wrap(text, indent = 0, width = 78) {
  const pad = " ".repeat(indent);
  const lines = [];
  let line = "";
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    if (line && (line + " " + word).length > width - indent) {
      lines.push(pad + line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(pad + line);
  return lines.join("\n");
}

function list(csv) {
  return String(csv || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function printCatalog() {
  console.log("\nIndustries");
  for (const industry of getIndustries()) console.log(`  ${industry.id.padEnd(20)} ${industry.name}`);

  console.log("\nRoles");
  for (const role of getRoles()) console.log(`  ${role.id.padEnd(20)} ${role.name}`);

  console.log("\nCopilot Studio features");
  for (const category of getFeaturesByCategory()) {
    console.log(`\n  ${category.icon || ""} ${category.name}`);
    for (const feature of category.features) {
      const flags = [`L${feature.level}`, `${feature.minutes}m`, feature.core ? "core" : ""].filter(Boolean).join(" ");
      console.log(`    ${feature.id.padEnd(26)} ${String(flags).padEnd(14)} ${feature.name}`);
    }
  }
  console.log("");
}

function help() {
  console.log(`
Copilot Studio custom lab builder

Usage:
  node tools/lab-builder/build.mjs [flags]

Flags:
  --list                    Show every industry, role, and feature id, then exit.
  --interactive             Answer prompts instead of passing flags.
  --industry <id>           Industry id (see --list).
  --roles <a,b>             Comma-separated role ids.
  --features <a,b>          Comma-separated feature ids (required unless interactive).
  --time <minutes>          Time budget; modules that do not fit become "next steps".
  --title "<text>"          Override the generated lab title.
  --agent-name "<text>"     Override the scenario agent name.
  --out <dir>               Output directory (default: generated-labs/).
  --no-learn                Skip Microsoft Learn grounding (offline mode).
  --no-llm                  Skip LLM enrichment even if credentials are present.
  --no-core                 Do not auto-add the level 100 foundation modules.
  --decide <code>=<option>  Pre-answer a build blocker. Repeatable.
  --non-interactive         Never prompt; report blockers and exit 2 instead.
  --dry-run                 Print the plan and exit without writing files.
  --help                    Show this message.

Exit codes:
  0  the lab was built and passed validation
  1  bad input, or the generated lab failed validation
  2  the build stopped for a decision and none was supplied (see --decide)
  3  a decision cancelled the build

When the builder hits something that would quietly degrade the lab — Microsoft
Learn unreachable, a module with no documentation results, model passages that
failed — it stops before writing anything and asks. On a terminal it prompts;
piped or with --non-interactive it prints the exact --decide flag for each
option and exits 2, so CI can never produce a degraded lab by accident.

The lab builder grounds every module against the public Microsoft Learn MCP
server (no sign-in required). If AZURE_OPENAI_* or GITHUB_TOKEN are set, it
also drafts scenario-specific narrative; otherwise it composes deterministically.
`);
}

/** Print every unresolved blocker with the flag that answers it, for CI. */
function reportBlockers(blockers) {
  console.error(`\n${"=".repeat(78)}`);
  console.error(`BUILD STOPPED — ${blockers.length} decision(s) needed. Nothing was written.`);
  console.error("=".repeat(78));

  for (const blocker of blockers) {
    console.error(`\n[${blocker.code}] ${blocker.title}\n`);
    console.error(wrap(blocker.consequence, 2));
    console.error("\n  Resolve it by re-running with one of:\n");
    for (const option of blocker.options) {
      console.error(`    ${option.cliFlag}${option.recommended ? "   (recommended)" : ""}`);
      console.error(`${wrap(option.label + " — " + option.tradeoff, 8)}\n`);
    }
  }
}

/** Ask a human about each blocker. Nothing has been written at this point. */
async function promptForBlockers(blockers) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  // If input closes mid-prompt (Ctrl+D, or a pipe that ran dry) rl.question
  // would never settle and the process would hang, so treat it as a cancel.
  const closed = new AbortController();
  rl.once("close", () => closed.abort());

  const chosen = {};
  try {
    for (const blocker of blockers) {
      console.log(`\n${"=".repeat(78)}`);
      console.log(`BUILD PAUSED — ${blocker.title}  [${blocker.code}]`);
      console.log("=".repeat(78));
      console.log(`\n${wrap(blocker.consequence)}\n`);
      console.log("Your options:\n");

      blocker.options.forEach((option, index) => {
        console.log(`  ${index + 1}. ${option.label}${option.recommended ? "   (recommended)" : ""}`);
        console.log(`${wrap(option.tradeoff, 5)}\n`);
      });

      const recommended = blocker.options.findIndex((option) => option.recommended) + 1;
      const fallback = recommended > 0 ? recommended : 1;
      for (;;) {
        let answer;
        try {
          answer = (await rl.question(`Choose 1-${blocker.options.length} [${fallback}]: `, {
            signal: closed.signal,
          })).trim();
        } catch {
          console.log("\n  Input closed before a decision was made. Cancelling the build.");
          chosen[blocker.code] = "cancel";
          return chosen;
        }

        const option = blocker.options[(answer === "" ? fallback : Number(answer)) - 1];
        if (option) {
          chosen[blocker.code] = option.id;
          console.log(`  → ${option.label}\n`);
          break;
        }
        console.log("  Enter one of the numbers listed above.");
      }
    }
  } finally {
    rl.close();
  }
  return chosen;
}

async function interactive() {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const industries = getIndustries();
    console.log("\nIndustries:");
    industries.forEach((i, n) => console.log(`  ${n + 1}. ${i.name} (${i.id})`));
    const industryAnswer = (await rl.question("\nIndustry number or id (Enter to skip): ")).trim();
    const industry =
      industries[Number(industryAnswer) - 1]?.id || industries.find((i) => i.id === industryAnswer)?.id || null;

    const roles = getRoles();
    console.log("\nRoles:");
    roles.forEach((r, n) => console.log(`  ${n + 1}. ${r.name} (${r.id})`));
    const roleAnswer = (await rl.question("\nRole ids or numbers, comma-separated (Enter to skip): ")).trim();
    const chosenRoles = list(roleAnswer)
      .map((token) => roles[Number(token) - 1]?.id || roles.find((r) => r.id === token)?.id)
      .filter(Boolean);

    console.log("\nFeatures:");
    for (const category of getFeaturesByCategory()) {
      console.log(`\n  ${category.name}`);
      for (const f of category.features) console.log(`    ${f.id.padEnd(26)} ${f.name} (${f.minutes}m, L${f.level})`);
    }
    const featureAnswer = (await rl.question("\nFeature ids, comma-separated: ")).trim();
    const features = list(featureAnswer).filter((id) => getFeature(id));
    if (!features.length) throw new Error("No valid feature ids were entered.");

    const timeAnswer = (await rl.question("Time budget in minutes (Enter for no limit): ")).trim();

    return { industry, roles: chosenRoles, features, timeBudget: timeAnswer ? Number(timeAnswer) : undefined };
  } finally {
    rl.close();
  }
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  help();
  process.exit(0);
}
if (args.list) {
  printCatalog();
  process.exit(0);
}

let request;
if (args.interactive) {
  request = await interactive();
} else {
  const features = list(args.features);
  if (!features.length) {
    console.error("Error: --features is required. Run with --list to see available feature ids.\n");
    help();
    process.exit(1);
  }
  const unknown = features.filter((id) => !getFeature(id));
  if (unknown.length) {
    console.error(`Error: unknown feature id(s): ${unknown.join(", ")}`);
    console.error(`Valid ids: ${getFeatures().map((f) => f.id).join(", ")}`);
    process.exit(1);
  }
  request = {
    industry: typeof args.industry === "string" ? args.industry : undefined,
    roles: list(args.roles),
    features,
    timeBudget: args.time ? Number(args.time) : undefined,
    title: typeof args.title === "string" ? args.title : undefined,
    agentName: typeof args["agent-name"] === "string" ? args["agent-name"] : undefined,
    includeCore: args["no-core"] ? false : undefined,
  };
}

let decisions;
try {
  const entries = {};
  for (const entry of [].concat(args.decide || [])) {
    if (typeof entry !== "string") {
      throw new Error("--decide expects <code>=<option>.");
    }
    const eq = entry.indexOf("=");
    if (eq < 1) throw new Error(`--decide expects <code>=<option>, got "${entry}".`);
    entries[entry.slice(0, eq).trim()] = entry.slice(eq + 1).trim();
  }
  decisions = normalizeDecisions(entries);
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(EXIT.VALIDATION_FAILED);
}

const canPrompt = Boolean(stdin.isTTY && stdout.isTTY) && !args["non-interactive"];
let prompted = false;
let result;

for (;;) {
  result = await generateLab(request, {
    outputRoot: typeof args.out === "string" ? path.resolve(args.out) : OUTPUT_ROOT,
    write: !args["dry-run"],
    useLearnMcp: !args["no-learn"],
    useLlm: !args["no-llm"],
    decisions,
    decisionSource: prompted ? "cli-interactive" : "cli-flag",
    onProgress: (event) => process.stdout.write(`  [${event.stage}] ${event.message}\n`),
  });

  if (result.status !== "blocked") break;

  if (!canPrompt) {
    reportBlockers(result.blockers);
    process.exit(EXIT.DECISION_REQUIRED);
  }

  Object.assign(decisions, await promptForBlockers(result.blockers));
  prompted = true;
}

if (result.status === "cancelled") {
  console.log("\nBuild cancelled. Nothing was written.\n");
  process.exit(EXIT.CANCELLED);
}

console.log("");
console.log(`Title       ${result.plan.title}`);
console.log(`Difficulty  ${result.plan.difficulty}`);
console.log(`Duration    ${result.plan.duration}`);
console.log(`Modules     ${result.plan.features.map((f) => `${f.order}. ${f.name}`).join("\n            ")}`);
console.log(
  `Grounding   ${result.manifest.grounding.groundedModules}/${result.manifest.grounding.totalModules} modules grounded on Microsoft Learn (${
    result.manifest.grounding.connected ? "MCP connected" : "MCP unavailable"
  })`,
);
console.log(
  `Steps       ${result.manifest.grounding.docDerivedModules}/${result.manifest.grounding.totalModules} modules had their steps read from a live documentation page`,
);
console.log(`Narrative   ${result.manifest.llm.label || result.manifest.llm.reason}`);
console.log(
  `Screenshots ${result.manifest.screenshots.reused} reused from existing labs, ${result.manifest.screenshots.toCapture} listed in shots.json for capture`,
);

for (const decision of result.decisionLog) {
  console.log(`Decision    ${decision.code} → ${decision.chosen.label}`);
}
for (const warning of result.plan.warnings) console.log(`Note        ${warning}`);

if (args["dry-run"]) {
  console.log("\nDry run — nothing was written.\n");
  process.exit(EXIT.OK);
}

const { validation } = result;
console.log(`\nWritten to  ${result.outputDir}`);
console.log(`Validation  ${validation.passed} passed, ${validation.failed} failed, ${validation.warnings} warning(s)`);
for (const test of validation.tests.filter((t) => t.status !== "pass")) {
  console.log(`  ${test.status.toUpperCase()} ${test.name}: ${test.message}`);
}

console.log(`\nOpen ${path.join(result.outputDir, "index.md")} to start the lab.`);
if (result.manifest.screenshots.toCapture) {
  console.log(
    `Capture the remaining screenshots with:\n  node tools/screenshot-capture/capture.js --manifest="${path.join(
      result.outputDir,
      "shots.json",
    )}"\n`,
  );
}

process.exit(validation.failed ? EXIT.VALIDATION_FAILED : EXIT.OK);
