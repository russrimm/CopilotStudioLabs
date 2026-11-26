/**
 * AI writing: the record a lab keeps about how it was written.
 *
 * `manifest.aiWriting` holds the model id and provider, the date, the prompt version, which parts AI wrote, and how many
 * passages ("blocks") AI reworded and how many kept the standard text. It never holds a prompt, a token, a person's name
 * or a model answer. A short note built from it appears in the lab document and in the facilitator guide.
 */

import { createHash } from "node:crypto";

import { AI_PROMPT_VERSION, AI_SCOPE_LABELS, AI_WRITING_VERSION } from "./config.js";
import { GUARD_VERSION } from "./guard.js";

export const AI_NOTE_HEADING = "## How This Lab Was Written";

export function providerLabel(config) {
  if (config.mode === "byok") {
    const names = { azure: "Azure OpenAI", anthropic: "Anthropic", openai: "an OpenAI-compatible provider" };
    return `the server's own model provider (${names[config.byok.type] || "custom"})`;
  }
  return "GitHub Copilot";
}

function safeText(value, max = 80) {
  return String(value ?? "").replace(/[\u0000-\u001f<>`*_[\]|]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** A new, empty record for one build. */
export function newRecord({ mode, providerName, model, modelName, scope, now = new Date() }) {
  return {
    version: AI_WRITING_VERSION,
    mode,
    provider: safeText(providerName, 80),
    model: safeText(model, 120),
    modelName: safeText(modelName || model, 80),
    date: now.toISOString().slice(0, 10),
    promptVersion: AI_PROMPT_VERSION,
    guardVersion: GUARD_VERSION,
    scope: [...scope],
    parts: {},
    requests: 0,
    stoppedEarly: null,
    notes: [],
    fingerprint: "",
  };
}

/** Add the counts for one part of the lab ("lab", "training" or "labday"). `cached` blocks were reworded earlier and reused, so they count as AI-written. `skipped` blocks had nothing to reword (a label, a number) and are not counted in `total`. `why` counts the kept blocks by plain reason. */
export function addPart(record, part, counts) {
  const current = record.parts[part] || { total: 0, ai: 0, kept: 0 };
  const next = {
    total: current.total + counts.total,
    ai: current.ai + counts.ai + (counts.cached || 0),
    kept: current.kept + counts.kept,
  };
  const skipped = (current.skipped || 0) + (counts.skipped || 0);
  if (skipped) next.skipped = skipped;
  const why = { ...(current.why || {}) };
  for (const [group, count] of Object.entries(counts.keptWhy || {})) if (count > 0 && WHY_WORDS[group]) why[group] = (why[group] || 0) + count;
  if (Object.keys(why).length) next.why = why;
  record.parts[part] = next;
  return record;
}

/** Add what a run did beyond counting: how many requests it made, whether it stopped early, and what a person should know. */
export function addRun(record, summary) {
  record.requests += summary.requests || 0;
  if (summary.stopped && !record.stoppedEarly) record.stoppedEarly = summary.stopKind || "stopped";
  for (const note of summary.notes || []) if (!record.notes.includes(note)) record.notes.push(note);
  return record;
}

/**
 * Count a run's results by part. Concept points belong to the lab-day decks when that part is chosen (the decks use the
 * same reworded points); everything else in the lab document belongs to the lab text.
 */
export function countLabResults(results, scope) {
  const blank = () => ({ total: 0, ai: 0, cached: 0, kept: 0, skipped: 0, keptWhy: {} });
  const parts = { lab: blank(), labday: blank() };
  for (const [id, result] of results) {
    const part = id.endsWith(".concepts") && scope.includes("labday") ? "labday" : scope.includes("lab") ? "lab" : "labday";
    const row = parts[part];
    if (result.status === "skipped") {
      row.skipped += 1;
      continue;
    }
    row.total += 1;
    if (result.status === "ai") row.ai += 1;
    else if (result.status === "cached") row.cached += 1;
    else {
      row.kept += 1;
      row.keptWhy[result.group || "model"] = (row.keptWhy[result.group || "model"] || 0) + 1;
    }
  }
  return parts;
}

/** Why a passage keeps the standard text, in the words a person reads. Counts only; never a passage. */
export const WHY_WORDS = Object.freeze({
  timeout: "the model took too long",
  busy: "the model service was busy",
  model: "the model could not write them",
  answer: "the model's answer was missing or unusable",
  guard: "the check against the original found a change, so the original was kept",
  limit: "a limit for this lab or day was reached",
  quota: "the Copilot allowance ran out",
  stopped: "AI writing was stopped",
});

/** "3 because the model took too long, 1 because the model service was busy", or "" when nothing was kept. */
export function whyText(why) {
  return Object.entries(why || {})
    .filter(([group, count]) => count > 0 && WHY_WORDS[group])
    .sort((a, b) => b[1] - a[1])
    .map(([group, count]) => `${count} because ${WHY_WORDS[group]}`)
    .join(", ");
}

export function totals(record) {
  return Object.values(record.parts).reduce((sum, p) => ({ total: sum.total + p.total, ai: sum.ai + p.ai, kept: sum.kept + p.kept }), { total: 0, ai: 0, kept: 0 });
}

/** True when AI reworded at least one passage: only then does a lab carry the note and the fingerprint. */
export function usedAi(record) {
  return Boolean(record) && totals(record).ai > 0;
}

/**
 * One plain sentence for the build result when some passages kept the standard text, or "" when none did. Counts and reasons
 * only. The same wording the "How This Lab Was Written" note uses.
 */
export function fallbackSummary(record) {
  const t = totals(record);
  if (!record || !t.kept) return "";
  const why = {};
  for (const part of Object.values(record.parts)) for (const [group, count] of Object.entries(part.why || {})) why[group] = (why[group] || 0) + count;
  const reasons = whyText(why);
  return `AI reworded ${t.ai} of ${t.ai + t.kept} passages. ${t.kept} kept the standard text${reasons ? `: ${reasons}` : ""}.`;
}

/** The record as stored in the manifest, with a fingerprint over what AI wrote (passed in by the caller). */
export function sealRecord(record, written) {
  record.fingerprint = createHash("sha1").update(JSON.stringify([AI_WRITING_VERSION, AI_PROMPT_VERSION, record.model, written])).digest("hex").slice(0, 16);
  return record;
}

const PART_NAMES = { lab: "Lab text", training: "Training decks", labday: "Lab-day decks" };

function partLines(record) {
  return ["lab", "training", "labday"]
    .filter((part) => record.scope.includes(part))
    .map((part) => {
      const counts = record.parts[part] || { total: 0, ai: 0, kept: 0 };
      const reasons = whyText(counts.why);
      const kept = `${counts.kept} kept as written${counts.kept && reasons ? ` (${reasons})` : ""}`;
      const skipped = counts.skipped ? `; ${counts.skipped} short ${counts.skipped === 1 ? "passage" : "passages"} had nothing to reword` : "";
      const what = counts.total ? `${counts.ai} of ${counts.total} passages reworded by AI, ${kept}${skipped}` : "nothing to reword";
      return { part, name: PART_NAMES[part], what };
    });
}

/** The section of the lab document (and so of the HTML, Word and PDF). Plain Markdown, US English, no emoji. */
export function aiNoteMarkdown(record) {
  const lines = [
    AI_NOTE_HEADING,
    "",
    "Parts of this lab were reworded by an AI model so the wording fits your audience and scenario. The model supplies words, not facts. The steps, interface names, numbers, product names, connector names, licensing statements and links come from Microsoft Learn and this repository's catalog, and the model was told to keep them exactly. Every reworded passage was checked against the original, and a passage that changed a step, an order, a number, a name or a link was replaced by the original text.",
    "",
    `- **Model:** ${record.modelName} (${record.model}), from ${record.provider}.`,
    `- **Written on:** ${record.date}.`,
    `- **Prompt version:** ${record.promptVersion}.`,
    `- **Prompts used:** ${record.requests}${record.requests ? "" : " (the reworded passages were reused from an earlier build)"}.`,
    ...partLines(record).map((p) => `- **${p.name}:** ${p.what}.`),
    "",
    "The standard text is always kept as the fallback. Build this lab again with AI turned off to get the standard text for every passage.",
  ];
  if (record.stoppedEarly) {
    lines.push("", "AI writing stopped before every passage was done, so the remaining passages use the standard text.");
  }
  return lines.join("\n");
}

/** The same facts for the facilitator guide, as plain lines. */
export function aiNoteLines(record) {
  return [
    `Model: ${record.modelName} (${record.model}), from ${record.provider}.`,
    `Written on: ${record.date}. Prompt version: ${record.promptVersion}. Prompts used: ${record.requests}.`,
    ...partLines(record).map((p) => `${p.name}: ${p.what}.`),
    "The model reworded the text only. Steps, interface names, numbers, product names, connector names, licensing statements and links come from Microsoft Learn and the catalog, and every reworded passage was checked against the original.",
  ];
}

/** Add or refresh the note in a lab's Markdown. The note goes last, so older text is replaced, never duplicated. */
export function withAiNote(markdown, record) {
  const stripped = stripAiNote(markdown);
  return `${stripped.trimEnd()}\n\n${aiNoteMarkdown(record)}\n`;
}

export function stripAiNote(markdown) {
  const index = String(markdown).indexOf(`\n${AI_NOTE_HEADING}\n`);
  return index === -1 ? String(markdown) : String(markdown).slice(0, index).trimEnd() + "\n";
}
