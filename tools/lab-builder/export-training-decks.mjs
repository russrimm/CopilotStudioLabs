#!/usr/bin/env node
/**
 * Export a generated lab's pre-lab training decks: PowerPoint decks for people who know little or nothing about
 * the topics, to deliver BEFORE the hands-on lab. Concepts only, no lab steps.
 *
 *   node tools/lab-builder/export-training-decks.mjs --lab my-lab-slug
 *   node tools/lab-builder/export-training-decks.mjs --lab my-lab-slug --out ./decks
 *   node tools/lab-builder/export-training-decks.mjs --lab path/to/lab-folder --topic complete
 *   node tools/lab-builder/export-training-decks.mjs --lab my-lab-slug --topic 3 --out topic-3.pptx
 *
 * It builds the same decks as the portal's "Training decks: deliver these first" group (GET
 * /api/lab-builder/generated/:labId/training/:deck). It reads the lab's manifest.json and index.md, so labs built
 * before training decks existed work too. Nothing is written to the lab and nothing is fetched; the lab's own brand
 * is applied when it has one.
 *
 * Flags:
 *   --lab <id|folder>   a generated lab's id (under --root) or the path of its folder (required)
 *   --root <dir>        the folder that holds generated labs (default: generated-labs/)
 *   --out <dir|file>    where to write (default: a "<Lab title> - Training decks" folder in the current folder;
 *                       with --topic, a .pptx file name or a folder)
 *   --topic <which>     one deck instead of all: a topic number, complete, foundations, or foundations-<product id>
 *   --help
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const lib = (name) => import(pathToFileURL(path.join(REPO_ROOT, "portal", "lib", name)).href);

const FLAGS = new Set(["lab", "root", "out", "topic", "ai-model", "help"]);
const SAFE_LAB_ID = /^[a-z0-9][a-z0-9-]{0,99}$/i;

function parse(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument "${token}".`);
    const eq = token.indexOf("=");
    const key = eq > -1 ? token.slice(2, eq) : token.slice(2);
    if (!FLAGS.has(key)) throw new Error(`Unknown flag --${key}. Run with --help.`);
    if (key === "help") {
      out.help = true;
      continue;
    }
    const value = eq > -1 ? token.slice(eq + 1) : argv[(i += 1)];
    if (value === undefined || (eq === -1 && value.startsWith("--") && value !== "--")) throw new Error(`--${key} needs a value.`);
    out[key] = value;
  }
  return out;
}

function usage() {
  return `Export a generated lab's pre-lab training decks (PowerPoint, no lab steps).

Usage:
  node tools/lab-builder/export-training-decks.mjs --lab <id|folder> [flags]

Flags:
  --lab <id|folder>   a generated lab's id (under --root) or the path of its folder (required)
  --root <dir>        the folder that holds generated labs (default: generated-labs/)
  --out <dir|file>    where to write (default: a "<Lab title> - Training decks" folder in the current folder;
                      with --topic, a .pptx file name or a folder)
  --topic <which>     one deck instead of all: a topic number, complete, foundations, or foundations-<product id>
  --ai-model <id>     reword the deck text with the GitHub Copilot SDK, using this PC's own Copilot sign-in. The lab is not
                      changed; an AI-NOTE.txt in the output folder says which model wrote what. (A lab built with AI
                      already carries its deck wording, and exports it without this flag.)
  --help              show this message`;
}

function findLabFolder(lab, root) {
  const asPath = path.resolve(lab);
  if (fs.existsSync(path.join(asPath, "index.md")) && fs.existsSync(path.join(asPath, "manifest.json"))) return asPath;
  if (!SAFE_LAB_ID.test(lab)) throw new Error(`"${lab}" is neither a lab folder nor a lab id.`);
  const dir = path.resolve(root, lab);
  if (!fs.existsSync(path.join(dir, "index.md")) || !fs.existsSync(path.join(dir, "manifest.json"))) {
    throw new Error(`No generated lab "${lab}" was found in ${root}.`);
  }
  return dir;
}

let flags;
try {
  flags = parse(process.argv.slice(2));
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
if (flags.help) {
  console.log(usage());
  process.exit(0);
}

try {
  if (!flags.lab) throw new Error("--lab is required. Run with --help.");
  const { buildTrainingPlan } = await lib("lab-builder/training-plan.js");
  const { loadTrainingLibrary } = await lib("lab-builder/training-library.js");
  const { planDecks, resolveDeckKey, summarizePlan, trainingExportFileName } = await lib("lab-builder/training-decks.js");
  const { renderTrainingDeck } = await lib("lab-builder/training-pptx.js");
  const { brandingFor } = await lib("lab-builder/training-routes.js");
  const { shortLabName } = await lib("export-names.js");

  const root = flags.root ? path.resolve(flags.root) : path.join(REPO_ROOT, "generated-labs");
  const labDir = findLabFolder(flags.lab, root);
  const manifest = JSON.parse(fs.readFileSync(path.join(labDir, "manifest.json"), "utf8"));
  const markdown = fs.readFileSync(path.join(labDir, "index.md"), "utf8");
  const library = loadTrainingLibrary();
  const plan = buildTrainingPlan({ markdown, manifest, labId: path.basename(labDir), outputDir: labDir, library });

  // Optional: reword the deck text now, for this export only (the lab itself is not changed).
  let aiNote = null;
  if (flags["ai-model"]) {
    const { createAi, localRequest } = await lib("ai/index.js");
    const { AiError } = await lib("ai/errors.js");
    const { runDeckWriting } = await lib("ai/deck-run.js");
    const { addPart, addRun, aiNoteLines } = await lib("ai/record.js");
    const ai = createAi({ env: { ...process.env, AI_GENERATION: "local-user" }, bindHost: "127.0.0.1", authEnabled: false });
    let writer = null;
    try {
      writer = await ai.service.authorize(localRequest(), { enabled: true, provider: "github-copilot", model: String(flags["ai-model"]), scope: ["training"] });
      const run = await runDeckWriting({ outputDir: labDir, markdown, manifest, labId: path.basename(labDir), writer, library, onProgress: (p) => console.error(`  [ai] ${p.done} of ${p.total} passages`) });
      plan.aiWriting = run.saved;
      const record = writer.newRecord();
      addPart(record, "training", run.summary);
      addRun(record, run.summary);
      aiNote = aiNoteLines(record).join("\n");
    } catch (err) {
      throw new Error(err instanceof AiError ? err.message : "AI writing could not be started.");
    } finally {
      writer?.release();
      await ai.service.stop();
    }
  }
  const all = planDecks(plan, library);
  const summary = summarizePlan(plan, all.map((d) => d.descriptor));
  const brand = brandingFor(manifest);

  let chosen = all;
  if (flags.topic !== undefined) {
    const resolved = resolveDeckKey(flags.topic, summary);
    if (resolved.error) throw new Error(resolved.error);
    chosen = all.filter((d) => d.descriptor.key === resolved.key);
  }

  // Short names, the same ones the portal's ZIP uses, so the folder extracts and opens anywhere on Windows.
  const safeTitle = shortLabName(plan.labTitle);
  const outArg = flags.out ? path.resolve(flags.out) : null;
  const singleFile = flags.topic !== undefined && outArg && /\.pptx$/i.test(outArg);
  const folder = singleFile ? path.dirname(outArg) : outArg || path.resolve(`${safeTitle} - Training decks`);
  fs.mkdirSync(folder, { recursive: true });

  let written = 0;
  for (const { descriptor, spec } of chosen) {
    const { buffer, overflow } = renderTrainingDeck(spec, { branding: brand.branding, library });
    const file = singleFile ? outArg : path.join(folder, trainingExportFileName(plan, descriptor));
    fs.writeFileSync(file, buffer);
    written += 1;
    const flag = descriptor.unreviewed ? "  (review before you present)" : "";
    console.error(`${path.relative(process.cwd(), file) || file}: ${descriptor.slideCount} slides, about ${descriptor.minutes} minutes${flag}${overflow.length ? `, ${overflow.length} text fit warning(s)` : ""}`);
  }
  console.error(`Wrote ${written} deck${written === 1 ? "" : "s"}. Training about ${plan.totalMinutes} minutes, then about ${plan.handsOnMinutes} minutes hands-on.`);
  if (aiNote) {
    fs.writeFileSync(path.join(folder, "AI-NOTE.txt"), `How these decks were written\n\n${aiNote}\n`, "utf8");
    console.error("AI reworded the deck text; AI-NOTE.txt in the output folder says how.");
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
