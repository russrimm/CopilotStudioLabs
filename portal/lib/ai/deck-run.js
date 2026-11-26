/**
 * AI writing for the training decks: the run that happens while a lab is built (or rebuilt with AI).
 *
 * It builds the lab's training plan the normal way, takes each deck's slide model, sends the writable text in units of one
 * deck, and saves the accepted rewordings in `ai-writing.json`. The decks themselves are then drawn by the normal code,
 * which reads that file (training-decks.js planDecks). Nothing here draws a slide.
 */

import { buildTrainingPlan } from "../lab-builder/training-plan.js";
import { planDecks } from "../lab-builder/training-decks.js";
import { loadTrainingLibrary } from "../lab-builder/training-library.js";
import { AI_PROMPT_VERSION, AI_WRITING_VERSION } from "./config.js";
import { extractDeckBlocks, savedEntry } from "./deck-blocks.js";
import { writeAiWriting } from "./saved.js";

function deckContext(plan, descriptor, manifest) {
  const scenario = plan.scenario || {};
  const roles = Array.isArray(manifest?.roles) ? manifest.roles.filter(Boolean).join(", ") : "";
  return {
    lab: plan.labTitle,
    deck: descriptor.title,
    audience: [scenario.audience || "", roles].filter(Boolean).join("; "),
    agentName: scenario.agentName || "",
    industry: scenario.industryId || "",
    level: manifest?.levelName || "",
    problem: scenario.problem || "",
    outcome: scenario.outcome || "",
  };
}

/**
 * @param {object} input
 * @param {string} input.outputDir
 * @param {string} input.markdown
 * @param {object} input.manifest
 * @param {string} input.labId
 * @param {{run: Function}} input.writer  the bound engine (service.js buildWriter)
 * @param {AbortSignal} [input.signal]
 * @param {Function} [input.onProgress]
 * @returns {Promise<{summary: object, written: object, decks: object}>}
 */
export async function runDeckWriting({ outputDir, markdown, manifest, labId, writer, signal, onProgress, library = loadTrainingLibrary() }) {
  const plan = buildTrainingPlan({ markdown, manifest: { ...manifest, aiWriting: undefined }, labId, outputDir, library });
  const decks = planDecks(plan, library);
  const units = [];
  const blockIndex = new Map();
  for (const { descriptor, spec } of decks) {
    const blocks = extractDeckBlocks(descriptor.key, spec);
    for (const block of blocks) blockIndex.set(block.id, { deck: descriptor.key, block });
    if (blocks.length) {
      const context = deckContext(plan, descriptor, manifest);
      // The level is context for the writer, not a fact it may quote, so it is not among the terms a passage may add.
      const { level, ...scenarioFields } = context;
      const allowed = Object.values(scenarioFields).join(" ");
      units.push({ id: `deck.${descriptor.key}`, context, blocks: blocks.map((b) => ({ ...b, allowed })) });
    }
  }

  const { results, summary } = await writer.run({ units, signal, onProgress });

  const saved = { version: 1, promptVersion: AI_PROMPT_VERSION, writingVersion: AI_WRITING_VERSION, fingerprint: "", decks: {} };
  const written = {};
  // In deck order, not in the order answers arrived: parallel calls finish in any order, and the fingerprint and the saved file
  // must be the same for the same wording.
  for (const [id, { deck, block }] of blockIndex) {
    const result = results.get(id);
    if (!result || (result.status !== "ai" && result.status !== "cached") || !result.items) continue;
    (saved.decks[deck] ||= {})[id] = savedEntry(block, result.items);
    written[id] = result.items;
  }
  return { summary, written, saved, outputDir, writeSaved: (fingerprint) => {
    saved.fingerprint = fingerprint;
    writeAiWriting(outputDir, saved);
  } };
}
