// Generates one lab per harness through the offline pipeline and validates it.
// Usage: node tools/lab-builder/sample-labs.mjs <outputRoot> <harness> [feature ids...]
// With no feature ids, every catalog feature tagged for the harness is included.
import { generateLab } from "../../portal/lib/lab-builder/generator.js";
import { getFeatures } from "../../portal/lib/lab-builder/catalog.js";

const [outputRoot, harness, ...ids] = process.argv.slice(2);
const features = ids.length ? ids : getFeatures().filter((f) => f.harness.includes(harness)).map((f) => f.id);
const result = await generateLab(
  { features, harness, title: `Sample ${harness} lab` },
  { outputRoot, useLearnMcp: false, useLlm: false },
);
console.log(JSON.stringify({ status: result.status, outputDir: result.outputDir, modules: features.length, blockers: result.blockers.map((b) => b.code), validation: result.validation }, null, 1));
process.exit(result.status === "complete" ? 0 : 1);
