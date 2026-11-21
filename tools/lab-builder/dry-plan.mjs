// Prints the dry plan of a generated lab: which screenshots a capture will take by itself, in which order and with which recipe, which objects
// the computer adds to the practice agent for them, and which stay with a person and why. It changes nothing and needs no browser or portal.
//
// Usage: node tools/lab-builder/dry-plan.mjs <generated-labs-folder> <lab id> [--all] [--json]
//   --all   plan every screenshot (the default plans only the ones with no picture yet)
//   --json  print the plan as JSON
import { buildLabJobPlan } from "../../portal/lib/capture/plan.js";
import { buildDryPlan, formatDryPlan } from "../../portal/lib/capture/dry-plan.js";
import { capturedScreenshotsDirs } from "../../portal/lib/lab-builder/captured.js";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const [generatedRoot, labId] = args.filter((a) => !a.startsWith("--"));
if (!generatedRoot || !labId) {
  console.error("Usage: node tools/lab-builder/dry-plan.mjs <generated-labs-folder> <lab id> [--all] [--json]");
  process.exit(2);
}
const plan = buildLabJobPlan({ generatedRoot, labId, scope: { mode: flags.has("--all") ? "all" : "missing" }, capturedDir: capturedScreenshotsDirs(), scratch: true, agentSource: "created", allowPractice: false });
if (plan.status !== 200) {
  console.error(plan.error || "The lab could not be planned.");
  process.exit(1);
}
const dry = buildDryPlan(plan);
console.log(flags.has("--json") ? JSON.stringify(dry, null, 2) : formatDryPlan(dry));
