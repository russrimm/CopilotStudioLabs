// Child process for the multi-process lab tests. Usage:
//   node generate-child.mjs build  <outputRoot> <emptyLabsDir> '<request json>'   -> prints {"labId": "..."}
//   node generate-child.mjs topics <outputRoot> <labId>                           -> rebuilds the lab's topic documents
// Everything it does is the portal's own code, run as a second process against the same folders.
import fs from "node:fs";
import path from "node:path";
import { generateLab } from "../../lib/lab-builder/generator.js";
import { ensureGeneratedLabTopicDocuments } from "../../lib/lab-builder/topic-documents.js";

const [mode, outputRoot, third, fourth] = process.argv.slice(2);

if (mode === "build") {
  const result = await generateLab(JSON.parse(fourth), { outputRoot, labsDir: third, useLearnMcp: false, useLlm: false });
  process.stdout.write(`${JSON.stringify({ labId: result.labId })}\n`);
} else if (mode === "topics") {
  const labDir = path.join(outputRoot, third);
  const docs = ensureGeneratedLabTopicDocuments(labDir, { labId: third });
  const missing = docs.filter((d) => !fs.existsSync(path.join(labDir, d.docxPath)) || !fs.existsSync(path.join(labDir, d.pptxPath)));
  process.stdout.write(`${JSON.stringify({ count: docs.length, missing: missing.length })}\n`);
} else {
  process.exit(2);
}
