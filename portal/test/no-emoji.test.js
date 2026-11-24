/**
 * No emoji anywhere the portal shows or generates.
 *
 * (a) The screens, templates and data the portal ships hold no emoji outside a short allowlist, each entry with its reason.
 * (b) Labs generated offline (the sample labs the training tests use) and everything exported from them (Markdown, HTML,
 *     Word, PowerPoint, PDF, the administrator guide, the prerequisites checklist, the facilitator guide, the training
 *     decks, and the ZIP README) hold none, even when the lab's own title carries one.
 * (c) A lab saved before the rule keeps its symbols on disk; every reading shows plain text, and no file is rewritten.
 *
 * Offline and fast: no Microsoft Learn, no language model, no browser.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Writable } from "node:stream";

import { findEmoji } from "../../tools/lab-builder/find-emoji.mjs";
import { readZipStrict } from "../../tools/lab-builder/lib/ooxml-strict.mjs";
import { exportGeneratedLab, renderGeneratedLabDocx, renderGeneratedLabHtml, renderGeneratedLabMarkdown } from "../lib/exporter.js";
import { generateLab } from "../lib/lab-builder/generator.js";
import { containsEmoji, emojiMatches, escapedEmojiMatches, plainText } from "../lib/lab-builder/plain-text.js";
import { TOPIC_DOCUMENTS_PLAIN_TEXT_VERSION, ensureGeneratedLabTopicDocuments } from "../lib/lab-builder/topic-documents.js";
import { cleanText } from "../lib/lab-builder/topic-sanitize.js";
import { SAMPLE_LABS, buildSampleLabs } from "./fixtures/training-labs.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Emoji that are meant to stay in a file the portal ships. Each entry names the file, a piece of the line, and why.
 * A stale entry (one that no longer matches a line) fails the test, so the list cannot grow quietly.
 */
const ALLOWED = [
  {
    file: "portal/public/app.js",
    includes: "\\u2705 Checkpoint",
    reason: "reads the check mark that the hand-written labs put before a checkpoint, so their feedback buttons keep working",
  },
  {
    file: "portal/lib/lab-builder/learn-topics.sharepoint-ai.snapshot.json",
    includes: "Applies to: \u2713",
    reason: "a committed copy of Microsoft Learn text; readSnapshot() turns it into plain text before anything shows it",
  },
];

const hasEmoji = (text) => containsEmoji(text) || escapedEmojiMatches(text).length > 0;

// ── (a) The shipped screens, templates and data ────────────────────────────────────────────────────────────────────

test("no screen, template or data file the portal ships carries an emoji, apart from the allowlist", () => {
  const hits = findEmoji(REPO_ROOT).filter((hit) => hit.scope === "fix" && hit.userVisible);
  const allowedHit = (hit) => ALLOWED.some((entry) => entry.file === hit.file && hit.text.includes(entry.includes));
  const unexpected = hits.filter((hit) => !allowedHit(hit));
  assert.deepEqual(
    unexpected.map((hit) => `${hit.file}:${hit.line} ${hit.symbol} ${hit.text.slice(0, 80)}`),
    [],
    "an emoji in a file people see: use plain words (see docs/lab-builder.md, Plain text, no emoji)",
  );
  for (const entry of ALLOWED) {
    assert.ok(hits.some((hit) => hit.file === entry.file && hit.text.includes(entry.includes)), `the allowlist entry for ${entry.file} no longer matches a line: remove it`);
    assert.ok(entry.reason.length > 20, `${entry.file}: say why it stays`);
  }
});

test("the shipped screens still have the words that replaced the icons", () => {
  const html = readFileSync(join(REPO_ROOT, "portal", "public", "index.html"), "utf8");
  for (const label of ["Build a Lab", "Use Case Builder", "Saved drafts", "Previously generated labs", "Lab chapters", "Download ZIP"]) {
    assert.ok(html.includes(label), label);
  }
});

// ── (b) Generated labs and everything exported from them ──────────────────────────────────────────────────────────

const ctx = {};

before(async () => {
  ctx.temp = mkdtempSync(join(tmpdir(), "no-emoji-"));
  ctx.built = await buildSampleLabs(["level100", "agentBuilder"], { root: join(ctx.temp, "labs") });
  // A person who types an emoji in the title still gets a lab without one.
  const typed = await generateLab({ ...SAMPLE_LABS.level100, title: "\u{1F680} Contoso Plant Lab \u2705" }, { outputRoot: join(ctx.temp, "labs"), useLearnMcp: false, useLlm: false });
  ctx.typed = { labId: typed.labId, outputDir: typed.outputDir };
});

after(() => {
  ctx.built?.cleanup();
  rmSync(ctx.temp, { recursive: true, force: true });
});

async function exportAll(root, labId) {
  const chunks = [];
  const sink = new Writable({ write(chunk, _enc, done) { chunks.push(chunk); done(); } });
  await exportGeneratedLab(root, labId, {}, sink, { formats: "all" });
  const zip = readZipStrict(Buffer.concat(chunks), { opc: false });
  assert.deepEqual(zip.problems, [], "the export is a clean archive");
  return zip.entries;
}

/** Every text a reader could see in an export, by file: Markdown, HTML, CSV, JSON, Office XML, PDF strings. */
function textParts(entries) {
  const parts = [];
  for (const [name, data] of entries) {
    if (/\.(md|txt|csv|html?|json)$/i.test(name)) parts.push({ name, text: data.toString("utf8") });
    else if (/\.(docx|pptx)$/i.test(name)) {
      const inner = readZipStrict(data, { opc: false });
      for (const [part, bytes] of inner.entries) if (/\.xml$/i.test(part)) parts.push({ name: `${name}!${part}`, text: bytes.toString("utf8") });
    } else if (/\.pdf$/i.test(name)) {
      // The PDF writer keeps text as single-byte WinAnsi strings, so an emoji cannot survive in it; check the strings it wrote.
      const strings = [...data.toString("latin1").matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)].map((m) => m[1]);
      parts.push({ name, text: strings.join("\n") });
    }
  }
  return parts;
}

function assertNoEmoji(parts, label) {
  const found = [];
  for (const { name, text } of parts) {
    const matches = [...emojiMatches(text), ...escapedEmojiMatches(text)];
    if (matches.length) found.push(`${name}: ${matches.slice(0, 3).map((m) => m.symbol).join(" ")}`);
    // The PDF writer's old stand-ins for symbols must not appear either.
    if (/\.pdf$/i.test(name) && /\[PASS\]|\[FAIL\]|\[!\]/.test(text)) found.push(`${name}: a symbol stand-in`);
  }
  assert.deepEqual(found, [], `${label}: no emoji in any text part`);
}

test("a generated lab and every export built from it holds no emoji", async () => {
  for (const [name, lab] of Object.entries(ctx.built.labs)) {
    const md = readFileSync(join(lab.outputDir, "index.md"), "utf8");
    const html = readFileSync(join(lab.outputDir, "index.html"), "utf8");
    assert.equal(hasEmoji(md), false, `${name}: index.md`);
    assert.equal(hasEmoji(html), false, `${name}: index.html`);
    assert.match(md, /\| \*\*TIME\*\* \| Hands-on: about /, `${name}: the TIME row keeps its label`);
    assert.match(md, /\| \*\*TRAINING\*\* \| Training: about /, `${name}: the TRAINING row keeps its label`);

    const entries = await exportAll(ctx.built.root, lab.labId);
    const names = [...entries.keys()];
    for (const [what, pattern] of [
      ["the ZIP README", /(^|\/)README\.md$/],
      ["Markdown", /index\.md$/],
      ["the HTML lab", /\.html$/],
      ["a Word guide", /\.docx$/],
      ["a PowerPoint deck", /\.pptx$/],
      ["a PDF guide", /\.pdf$/],
      ["the facilitator guide", /Facilitator/i],
      ["the administrator guide", /Administrator/i],
      ["the prerequisites checklist", /Prerequisites|checklist/i],
      ["the training decks", /Training/i],
    ]) {
      assert.ok(names.some((n) => pattern.test(n)), `${name}: the export holds ${what}`);
    }
    assertNoEmoji(textParts(entries), name);
  }
});

test("a title with emoji typed by a person never reaches the lab, its manifest, or its exports", async () => {
  const md = readFileSync(join(ctx.typed.outputDir, "index.md"), "utf8");
  const manifest = JSON.parse(readFileSync(join(ctx.typed.outputDir, "manifest.json"), "utf8"));
  assert.equal(hasEmoji(md), false);
  assert.equal(hasEmoji(JSON.stringify(manifest)), false);
  assert.match(manifest.title, /Contoso Plant Lab/);
  assertNoEmoji(textParts(await exportAll(ctx.built.root, ctx.typed.labId)), "typed title");
});

test("text from Microsoft Learn is made plain at the trust boundary", () => {
  assert.equal(cleanText("| Feature | A |\n| Tools | \u2705 |"), "Feature A Tools Yes");
  assert.equal(cleanText("Applies to: \u2713 Unstructured document processing"), "Applies to: Unstructured document processing");
  assert.equal(cleanText("\u{1F680} Launch the agent"), "Launch the agent");
});

// ── (c) A lab saved before the rule ───────────────────────────────────────────────────────────────────────────────

/** The files the lab was saved with. The folders of cached documents (topics, training) are rebuilt as needed and are not compared. */
const SAVED_FILES = ["index.md", "index.html", join("screenshots", "shots.json")];

function savedBytes(dir) {
  return new Map(SAVED_FILES.filter((file) => existsSync(join(dir, file))).map((file) => [file, readFileSync(join(dir, file)).toString("base64")]));
}

test("an older saved lab with emoji reads as plain text everywhere, and no file on disk is rewritten", async () => {
  const lab = ctx.built.labs.level100;
  const oldRoot = join(ctx.temp, "old-labs");
  const oldDir = join(oldRoot, lab.labId);
  cpSync(lab.outputDir, oldDir, { recursive: true });

  // Put the symbols an older build wrote back into the saved files.
  const indexPath = join(oldDir, "index.md");
  let md = readFileSync(indexPath, "utf8");
  md = md
    .replace("| **TIME** |", "| \u23F1\uFE0F **TIME** |")
    .replace("| **TRAINING** |", "| \u{1F393} **TRAINING** |")
    .replace("| **PRODUCTS** |", "| \u{1F9E9} **PRODUCTS** |")
    .replace(/\n## Overview/, "\n\u{1F4A1} Use a short name for the agent.\n\n| Check | Result |\n|---|---|\n| Saved | \u2705 |\n| Published | \u274C |\n\n## \u{1F3AF} Overview");
  assert.ok(emojiMatches(md).length >= 6, "the saved lab really holds symbols");
  writeFileSync(indexPath, md, "utf8");
  const manifestPath = join(oldDir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.title = `\u{1F680} ${manifest.title}`;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const before = savedBytes(oldDir);
  const manifestBefore = JSON.parse(readFileSync(manifestPath, "utf8"));

  const markdown = renderGeneratedLabMarkdown(oldRoot, lab.labId);
  assert.equal(markdown.status ?? 200, 200);
  const markdownText = String(markdown.body ?? markdown.markdown ?? markdown.content ?? "");
  assert.ok(markdownText.length > 1000, "the lab reads");
  assert.equal(hasEmoji(markdownText), false, "Markdown reading");
  assert.match(markdownText, /\| \*\*TIME\*\* \|/);
  assert.match(markdownText, /Tip: Use a short name for the agent\./);
  assert.match(markdownText, /\| Saved \| Yes \|/);
  assert.match(markdownText, /\| Published \| No \|/);

  const htmlOut = renderGeneratedLabHtml(oldRoot, lab.labId);
  assert.equal(hasEmoji(String(htmlOut.body ?? htmlOut.html ?? htmlOut.content ?? "")), false, "HTML reading");

  const docx = renderGeneratedLabDocx(oldRoot, lab.labId);
  const docxBuffer = docx.body ?? docx.buffer ?? docx.content;
  assert.ok(Buffer.isBuffer(docxBuffer), "a Word file came back");
  const docxParts = [...readZipStrict(docxBuffer, { opc: false }).entries].filter(([n]) => /\.xml$/.test(n)).map(([name, bytes]) => ({ name, text: bytes.toString("utf8") }));
  assertNoEmoji(docxParts, "Word reading");

  assertNoEmoji(textParts(await exportAll(oldRoot, lab.labId)), "ZIP export");

  const after = savedBytes(oldDir);
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), "no saved file was added or removed");
  for (const [file, bytes] of before) assert.equal(after.get(file), bytes, `${file} was not rewritten`);
  assert.equal(hasEmoji(readFileSync(indexPath, "utf8")), true, "the saved file still holds its symbols");
  const manifestAfter = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(manifestAfter.title, manifestBefore.title, "the saved title is still as it was saved");
});

test("plainText has no effect on a clean lab, so reading it twice changes nothing", () => {
  const md = readFileSync(join(ctx.built.labs.level100.outputDir, "index.md"), "utf8");
  assert.equal(plainText(md), md);
});

test("topic documents saved before the rule are rebuilt once from plain text, and the saved lab text is left alone", () => {
  const lab = ctx.built.labs.level100;
  const dir = join(ctx.temp, "old-topic-docs", lab.labId);
  cpSync(lab.outputDir, dir, { recursive: true });
  const indexPath = join(dir, "index.md");
  writeFileSync(indexPath, readFileSync(indexPath, "utf8").replace("| **TIME** |", "| \u23F1\uFE0F **TIME** |"), "utf8");
  const savedIndex = readFileSync(indexPath, "utf8");
  const manifestPath = join(dir, "manifest.json");

  const first = ensureGeneratedLabTopicDocuments(dir);
  assert.ok(first.length > 0, "topic documents are listed");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.topicDocumentsPlainText, TOPIC_DOCUMENTS_PLAIN_TEXT_VERSION, "the one-time rebuild is recorded");
  assert.equal(readFileSync(indexPath, "utf8"), savedIndex, "index.md is not rewritten");

  const docx = join(dir, first[0].docxPath);
  const stamp = statSync(docx).mtimeMs;
  ensureGeneratedLabTopicDocuments(dir);
  assert.equal(statSync(docx).mtimeMs, stamp, "the second reading does not rebuild anything");
});