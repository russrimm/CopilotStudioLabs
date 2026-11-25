/**
 * AI writing: the file a lab keeps next to its manifest, `ai-writing.json`.
 *
 * It holds only what the model wrote for the training decks (the lab's own AI text lives in index.md like any other text),
 * keyed by deck, slide and field, each with a hash of the standard text it replaces. A deck is built from this file when it
 * is first rendered and every time it is rebuilt later, so exporting a lab never calls a model. If the standard text
 * changed since (the hash no longer matches), that rewording is dropped and the standard text is used. The file holds no
 * prompt, token, name or model answer beyond the accepted text.
 */

import fs from "node:fs";
import path from "node:path";

export const AI_WRITING_FILE = "ai-writing.json";

/** The saved AI text for a lab, or null when the lab has none or the file does not belong to the manifest's record. */
export function loadAiWriting(outputDir, manifest) {
  const record = manifest?.aiWriting;
  if (!outputDir || !record?.fingerprint) return null;
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(outputDir, AI_WRITING_FILE), "utf8"));
    if (saved?.version !== 1 || saved.fingerprint !== record.fingerprint || !saved.decks || typeof saved.decks !== "object") return null;
    return saved;
  } catch {
    return null;
  }
}

export function writeAiWriting(outputDir, saved) {
  const target = path.join(outputDir, AI_WRITING_FILE);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(saved, null, 1)}\n`, "utf8");
  fs.renameSync(tmp, target);
}
