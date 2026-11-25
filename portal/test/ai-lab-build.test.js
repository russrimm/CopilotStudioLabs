/**
 * AI writing, end to end with a fake model: a lab is built with AI on and with AI off, and what the model may and may not
 * change is checked in the lab text, the decks, the manifest, every output format and the facilitator guide. No SDK, no
 * network, no account: the model is test/fixtures/fake-ai.js.
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateLab } from "../lib/lab-builder/generator.js";
import { createAi, localRequest } from "../lib/ai/index.js";
import { AI_WRITING_FILE } from "../lib/ai/saved.js";
import { SYSTEM_PROMPT } from "../lib/ai/prompts.js";
import { containsEmoji } from "../lib/lab-builder/plain-text.js";
import { renderMarkdownToDocxBuffer } from "../lib/lab-builder/docx-builder.js";
import { renderFacilitatorGuideMarkdown } from "../lib/lab-builder/facilitator-guide.js";
import { ensureGeneratedLabTrainingDecks, trainingDeckOutline } from "../lib/lab-builder/training-decks.js";
import { listGeneratedLabs, selectionsFromManifest } from "../lib/lab-builder/generated-labs.js";
import { checkDocxPackage, checkPptxPackage, readZipStrict } from "../../tools/lab-builder/lib/ooxml-strict.mjs";
import { createFakeBackend } from "./fixtures/fake-ai.js";

const cleanups = [];
after(() => {
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true });
});

const BASE = { products: ["copilot-studio"], features: ["create-agent", "knowledge-sharepoint"], harness: "standard", includeCore: false, industry: "retail" };
const SCOPE_ALL = ["lab", "training", "labday"];
const OFFLINE = { useLearnMcp: false, useLlm: false };

function tmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

async function build({ behavior = "reword", scope = SCOPE_ALL, root = tmp("ai-lab-"), backend = createFakeBackend({ behavior }), request = BASE, sharedCacheDir = root, token } = {}) {
  const ai = createAi({ env: { AI_GENERATION: "local-user" }, backend, dataDir: sharedCacheDir });
  const choice = { enabled: true, model: "fake-fast", scope };
  const writer = await ai.service.authorize(localRequest(), choice);
  const progress = [];
  const result = await generateLab({ ...request, ai: choice }, { outputRoot: root, ...OFFLINE, ai: writer, onAiProgress: (p) => progress.push(p) });
  writer.release();
  return { result, backend, root, progress, ai };
}

const plainLab = (() => {
  let cached;
  return () => (cached ||= generateLab(BASE, { outputRoot: tmp("ai-plain-"), ...OFFLINE }));
})();

const boldLabels = (markdown) => (markdown.match(/\*\*[^*\n]{1,80}\*\*/g) || []).join("|");
const numberedSteps = (markdown) => markdown.split("\n").filter((line) => /^\d+\. /.test(line));

test("a lab built with AI is reworded where the model was faithful, and says so everywhere", async () => {
  const plain = await plainLab();
  const { result, backend } = await build();
  assert.equal(result.status, "complete");
  assert.notEqual(result.markdown, plain.markdown);
  assert.match(result.markdown, /## How This Lab Was Written/);
  assert.match(result.markdown, /\*\*Model:\*\* Fake Fast \(fake-fast\), from GitHub Copilot\./);
  assert.match(result.markdown, /\*\*Written on:\*\* \d{4}-\d{2}-\d{2}\./);
  assert.match(result.markdown, /\*\*Prompt version:\*\* 1\./);
  assert.match(result.markdown, /\*\*Lab text:\*\* \d+ of \d+ passages reworded by AI, 0 kept as written\./);
  assert.match(result.markdown, /\*\*Training decks:\*\* \d+ of \d+ passages reworded by AI/);
  assert.match(result.markdown, /\*\*Lab-day decks:\*\* \d+ of \d+ passages reworded by AI/);
  assert.match(result.html, /How This Lab Was Written/);
  assert.equal(readFileSync(join(result.outputDir, "index.md"), "utf8"), result.markdown);
  assert.match(readFileSync(join(result.outputDir, "index.html"), "utf8"), /How This Lab Was Written/);

  const word = readZipStrict(renderMarkdownToDocxBuffer(result.markdown, { title: result.plan.title })).entries.get("word/document.xml").toString("utf8");
  assert.match(word, /How This Lab Was Written/);
  assert.match(word, /Fake Fast/);

  const guide = renderFacilitatorGuideMarkdown(result.outputDir);
  assert.match(guide, /### How This Lab Was Written/);
  assert.match(guide, /Model: Fake Fast \(fake-fast\), from GitHub Copilot\./);

  assert.ok(backend.calls.filter((c) => c.type === "complete").length > 3);
});

test("the steps are the same steps: same count, same order, same interface labels; the facts are untouched", async () => {
  const plain = await plainLab();
  const { result } = await build();
  const a = numberedSteps(plain.markdown);
  const b = numberedSteps(result.markdown);
  assert.equal(a.length, b.length);
  assert.ok(a.length > 6);
  a.forEach((line, i) => assert.equal(boldLabels(line), boldLabels(b[i]), `step ${i + 1} keeps its labels`));
  assert.ok(a.some((line, i) => line !== b[i]), "and at least one step was reworded");
  // Everything with a fact in it: the link lists, the connector names, the metadata table, the citations.
  const links = (md) => (md.match(/\]\(https?:[^)]+\)/g) || []).join("|");
  assert.equal(links(plain.markdown), links(result.markdown));
  assert.equal(plain.manifest.modules.map((m) => m.steps.count).join(), result.manifest.modules.map((m) => m.steps.count).join());
});

test("the manifest records how it was written, never a prompt, a token, a model answer or a name", async () => {
  const { result, root } = await build({ token: "gho_SHOULD_NEVER_APPEAR" });
  const record = result.manifest.aiWriting;
  assert.equal(record.model, "fake-fast");
  assert.equal(record.modelName, "Fake Fast");
  assert.equal(record.provider, "GitHub Copilot");
  assert.equal(record.promptVersion, "1");
  assert.deepEqual(record.scope, SCOPE_ALL);
  assert.match(record.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(record.parts.lab.total > 0 && record.parts.training.total > 0 && record.parts.labday.total > 0);
  assert.equal(record.parts.lab.ai + record.parts.lab.kept, record.parts.lab.total);
  assert.match(record.fingerprint, /^[0-9a-f]{16}$/);
  assert.deepEqual(result.manifest.options.ai, { enabled: true, provider: "github-copilot", model: "fake-fast", scope: SCOPE_ALL });
  assert.equal(result.manifest.request.ai, undefined, "the choice is not part of the lab's plan request");

  const onDisk = readFileSync(join(result.outputDir, "manifest.json"), "utf8");
  for (const forbidden of [SYSTEM_PROMPT.slice(0, 40), "quoted data", "gho_", "SHOULD_NEVER", "Reword these blocks", "responseSchema", "fake-user"]) {
    assert.equal(onDisk.includes(forbidden), false, `the manifest must not contain "${forbidden}"`);
  }
  const selections = selectionsFromManifest(JSON.parse(onDisk));
  assert.deepEqual(selections.ai, { enabled: true, model: "fake-fast", scope: SCOPE_ALL }, "Edit selections re-opens with the same choice");
  const listed = listGeneratedLabs(root).labs?.find?.((l) => l.labId === result.labId) ?? listGeneratedLabs(root).find?.((l) => l.labId === result.labId);
  assert.equal(listed.aiWriting.model, "Fake Fast", "the list of generated labs says which labs AI helped write");
});

test("a rebuild of an unchanged lab calls the model only for what it could not write before", async () => {
  const dir = tmp("ai-cache-shared-");
  const first = await build({ sharedCacheDir: dir, root: tmp("ai-lab-a-") });
  const calls = first.backend.calls.filter((c) => c.type === "complete").length;
  assert.ok(calls > 0);
  const second = await build({ sharedCacheDir: dir, root: tmp("ai-lab-b-") });
  const requested = (backend) => backend.calls.filter((c) => c.type === "complete").reduce((sum, c) => sum + JSON.parse(c.prompt.slice(c.prompt.indexOf("{"))).blocks.length, 0);
  const keptFirst = Object.values(first.result.manifest.aiWriting.parts).reduce((sum, p) => sum + p.kept, 0);
  assert.equal(requested(second.backend), keptFirst, "only the blocks that kept the standard text are asked again");
  assert.equal(keptFirst, 0, "the fake model was faithful, so nothing is asked again");
  assert.equal(second.backend.calls.filter((c) => c.type === "complete").length, 0, "no request on the rebuild");
  assert.equal(second.result.manifest.aiWriting.parts.lab.ai, first.result.manifest.aiWriting.parts.lab.ai, "the same words, counted the same");
  assert.equal(numberedSteps(second.result.markdown).join("\n"), numberedSteps(first.result.markdown).join("\n"));
});

test("when the model breaks a rule the lab keeps the standard text: byte for byte the lab built without AI, and no false claim", async () => {
  const plain = await plainLab();
  for (const behavior of ["invent-number", "invent-name", "invent-url", "inject", "invalid-json", "throw", "drop-step"]) {
    const { result } = await build({ behavior });
    const aiBlocksKept = result.manifest.aiWriting === undefined;
    if (behavior === "drop-step") {
      // A text block next to the broken step list may still have been accepted; the steps are what must be intact.
      assert.equal(numberedSteps(result.markdown).join("\n"), numberedSteps(plain.markdown).join("\n"), behavior);
      continue;
    }
    assert.equal(result.markdown, plain.markdown, `${behavior}: the lab text is the standard text`);
    assert.equal(aiBlocksKept, true, `${behavior}: no note, because AI wrote nothing`);
    assert.ok(result.plan.warnings.some((w) => /AI writing|standard text/.test(w)), `${behavior}: a warning says AI changed nothing`);
    assert.equal(existsSync(join(result.outputDir, AI_WRITING_FILE)), false, behavior);
  }
});

test("everything the model returns goes through the same final steps: no emoji, US English", async () => {
  const emoji = await build({ behavior: "emoji" });
  const british = await build({ behavior: "british" });
  for (const { result } of [emoji, british]) {
    assert.equal(containsEmoji(result.markdown), false);
    assert.equal(containsEmoji(readFileSync(join(result.outputDir, "manifest.json"), "utf8")), false);
    assert.equal(containsEmoji(readFileSync(join(result.outputDir, AI_WRITING_FILE), "utf8")), false);
    assert.doesNotMatch(result.markdown, /\b(colour|behaviour|organis(e|ed|ing)|customis|catalogue|centre)\b/i);
  }
});

test("a build with AI off, or with ai.enabled false, is the standard build: the same text, the same decks, no trace", async () => {
  const plain = await plainLab();
  const explicit = await generateLab({ ...BASE, ai: { enabled: false } }, { outputRoot: tmp("ai-off-"), ...OFFLINE });
  assert.equal(explicit.markdown, plain.markdown);
  assert.equal(explicit.manifest.aiWriting, undefined);
  assert.equal(explicit.manifest.options.ai, undefined);
  assert.equal(explicit.plan.aiChoice, undefined);
  assert.equal(existsSync(join(explicit.outputDir, AI_WRITING_FILE)), false);
  const a = ensureGeneratedLabTrainingDecks(plain.outputDir).summary;
  const b = ensureGeneratedLabTrainingDecks(explicit.outputDir).summary;
  assert.equal(a.fingerprint, b.fingerprint, "the training decks of an AI-off lab have the standard fingerprint");
  const manifestKeys = (m) => Object.keys(m).sort().join(",");
  assert.equal(manifestKeys(explicit.manifest), manifestKeys(plain.manifest));
  // A request that names AI but arrives without a writer (a script, a test) builds the standard lab and says so.
  const orphan = await generateLab({ ...BASE, ai: { enabled: true, model: "fake-fast" } }, { outputRoot: tmp("ai-orphan-"), ...OFFLINE });
  assert.equal(orphan.markdown, plain.markdown);
  assert.ok(orphan.plan.warnings.some((w) => /AI writing was requested, but it is not available/.test(w)));
});

test("the training decks carry the model's wording at the slide model, with their own fingerprint, and rebuild without a model", async () => {
  const plain = await plainLab();
  const { result } = await build();
  const plainSummary = ensureGeneratedLabTrainingDecks(plain.outputDir);
  const aiSummary = ensureGeneratedLabTrainingDecks(result.outputDir);
  assert.notEqual(plainSummary.summary.fingerprint, aiSummary.summary.fingerprint, "an AI deck never shares a cache entry with a plain one");
  assert.equal(aiSummary.summary.decks.length, plainSummary.summary.decks.length);
  assert.ok(aiSummary.plan.aiWriting, "the plan reads the saved wording");

  const outlineText = (plan, key) => JSON.stringify(trainingDeckOutline(plan, key).slides.map((s) => s.notes));
  const aiNotes = outlineText(aiSummary.plan, "1");
  const plainNotes = outlineText(plainSummary.plan, "1");
  assert.notEqual(aiNotes, plainNotes);
  assert.match(aiNotes, /beginning plus use everyday words|Next, you will/);

  // Run again: nothing is rebuilt and no model is needed. Without the saved file the decks are the standard decks.
  assert.equal(ensureGeneratedLabTrainingDecks(result.outputDir).summary.fingerprint, aiSummary.summary.fingerprint);
  rmSync(join(result.outputDir, AI_WRITING_FILE));
  const fallback = ensureGeneratedLabTrainingDecks(result.outputDir, { force: true });
  assert.equal(fallback.plan.aiWriting ?? null, null);
  assert.equal(outlineText(fallback.plan, "1"), plainNotes, "no file, no model: the standard deck text");
});

test("what AI writes is chosen: only the lab text, or only the decks", async () => {
  const plain = await plainLab();
  const labOnly = await build({ scope: ["lab"] });
  assert.notEqual(labOnly.result.markdown, plain.markdown);
  assert.equal(existsSync(join(labOnly.result.outputDir, AI_WRITING_FILE)), false, "no deck wording was written");
  assert.equal(labOnly.result.manifest.aiWriting.parts.training, undefined);
  assert.doesNotMatch(labOnly.result.markdown, /\*\*Training decks:\*\*/);

  const decksOnly = await build({ scope: ["training"] });
  assert.equal(numberedSteps(decksOnly.result.markdown).join("\n"), numberedSteps(plain.markdown).join("\n"), "the lab steps stay the standard text");
  assert.ok(existsSync(join(decksOnly.result.outputDir, AI_WRITING_FILE)));
  assert.equal(decksOnly.result.manifest.aiWriting.parts.lab, undefined);
});

test("progress is reported as blocks done of total, and a cancelled build keeps going no further", async () => {
  const { progress } = await build();
  const lab = progress.filter((p) => p.part === "lab");
  const training = progress.filter((p) => p.part === "training");
  assert.ok(lab.length > 0 && training.length > 0);
  assert.equal(lab.at(-1).done, lab.at(-1).total);
  assert.ok(training.at(-1).total > lab.at(-1).total);

  const controller = new AbortController();
  const slow = createFakeBackend({ delayMs: 5 });
  const ai = createAi({ env: { AI_GENERATION: "local-user" }, backend: slow, dataDir: tmp("ai-cancel-") });
  const writer = await ai.service.authorize(localRequest(), { model: "fake-fast", scope: SCOPE_ALL });
  const run = generateLab({ ...BASE, ai: { enabled: true, model: "fake-fast" } }, { outputRoot: tmp("ai-cancel-lab-"), ...OFFLINE, ai: writer, signal: controller.signal, onAiProgress: (p) => p.done >= 1 && controller.abort() });
  const result = await run.catch((err) => err);
  writer.release();
  assert.ok(result instanceof Error || result?.status === "complete", "a cancelled build either stops or finishes without more model calls");
  assert.ok(slow.calls.filter((c) => c.type === "complete").length < 12, "the model was not asked for the rest");
});

test("the Word, PowerPoint and package checks all pass on a lab built with AI", async () => {
  const { result } = await build();
  const docx = renderMarkdownToDocxBuffer(result.markdown, { title: result.plan.title });
  assert.deepEqual(checkDocxPackage(docx), []);
  const decks = ensureGeneratedLabTrainingDecks(result.outputDir).summary.decks;
  assert.ok(decks.length >= 3);
  for (const deck of decks) {
    const buffer = readFileSync(join(result.outputDir, "training", deck.fileName));
    assert.deepEqual(checkPptxPackage(buffer, { expectNotes: true }), [], deck.fileName);
  }
});
