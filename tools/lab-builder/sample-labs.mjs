// Generates one lab per harness, or per non-Copilot Studio product, through the offline pipeline and validates it.
// Usage: node tools/lab-builder/sample-labs.mjs <outputRoot> <harness|product:id> [feature ids...]
// With no feature ids, every catalog feature tagged for the harness (or belonging to the product) is included.
import { generateLab } from "../../portal/lib/lab-builder/generator.js";
import { getFeatures } from "../../portal/lib/lab-builder/catalog.js";

const [outputRoot, target, ...ids] = process.argv.slice(2);
const product = target?.startsWith("product:") ? target.slice("product:".length) : null;
const harness = product ? undefined : target;
const features = ids.length
  ? ids
  : getFeatures()
      .filter((f) => (product ? f.product === product : f.harness?.includes(harness)))
      .map((f) => f.id);
const request = product
  ? { features, products: [product], title: `Sample ${product} lab` }
  : { features, harness, title: `Sample ${harness} lab` };
const result = await generateLab(request, { outputRoot, useLearnMcp: process.env.SAMPLE_LEARN === "1", useLlm: false });
console.log(JSON.stringify({ status: result.status, outputDir: result.outputDir, modules: features.length, blockers: result.blockers.map((b) => b.code), validation: result.validation }, null, 1));
process.exit(result.status === "complete" ? 0 : 1);
