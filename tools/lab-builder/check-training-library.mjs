#!/usr/bin/env node
/**
 * Check the curated teaching content behind the pre-lab training decks.
 *
 *   node tools/lab-builder/check-training-library.mjs            report problems, exit 1 when there are any
 *   node tools/lab-builder/check-training-library.mjs --partial  do not require a brief for every concept and product
 *   node tools/lab-builder/check-training-library.mjs --concept knowledge,tools   print the problems for those briefs only
 *
 * It loads portal/lib/lab-builder/training/*.json, then checks structure, lengths, reading level, acronyms,
 * Learn links, unknown glossary terms, and anything that reads like a lab step, an administrator setting, a
 * tenant value, or a GUID. The same check runs in portal/test/training-decks.test.js.
 */

const lib = (name) => import(new URL(`../../portal/lib/lab-builder/${name}`, import.meta.url));

const { checkTrainingLibrary, loadTrainingLibrary } = await lib("training-library.js");
const { getConcepts } = await lib("concepts.js");
const { getBuiltInProducts } = await lib("products.js");

const args = process.argv.slice(2);
const partial = args.includes("--partial");
const onlyIndex = args.indexOf("--concept");
const only = onlyIndex > -1 ? String(args[onlyIndex + 1] || "").split(",").map((s) => s.trim()).filter(Boolean) : null;

const library = loadTrainingLibrary({ fresh: true });
let problems = checkTrainingLibrary(library, {
  conceptIds: getConcepts().map((c) => c.id),
  productIds: getBuiltInProducts().map((p) => p.id),
  requireAll: !partial,
});
if (only) problems = problems.filter((p) => only.some((id) => p.includes(`"${id}"`)));

console.log(`Files: ${library.files.join(", ")}`);
console.log(`Terms: ${Object.keys(library.terms).length}, concept briefs: ${Object.keys(library.concepts).length}, product briefs: ${Object.keys(library.products).length}`);
if (problems.length) {
  console.log(`\n${problems.length} problem${problems.length === 1 ? "" : "s"}:`);
  for (const problem of problems) console.log(`  - ${problem}`);
  process.exit(1);
}
console.log("No problems.");
