/**
 * Plain text, no emoji: what plainText() does with each kind of symbol, and what it never touches.
 * The fixtures are synthetic text only.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { containsEmoji, emojiMatches, escapedEmojiMatches, plainText, plainTextDeep } from "../lib/lab-builder/plain-text.js";

const E = {
  stopwatch: "\u23F1\uFE0F",
  graduation: "\u{1F393}",
  bulb: "\u{1F4A1}",
  target: "\u{1F3AF}",
  tube: "\u{1F9EA}",
  rocket: "\u{1F680}",
  check: "\u2705",
  cross: "\u274C",
  warning: "\u26A0\uFE0F",
  link: "\u{1F517}",
  heavyCheck: "\u2714\uFE0F",
  plainCheck: "\u2713",
  plainCross: "\u2717",
};

test("a header row loses its icon and keeps its label", () => {
  assert.equal(plainText(`| ${E.stopwatch} **TIME** | Hands-on: about 1 hour |`), "| **TIME** | Hands-on: about 1 hour |");
  assert.equal(plainText(`| ${E.graduation} **TRAINING** | Training: about 2 hours |`), "| **TRAINING** | Training: about 2 hours |");
  assert.equal(plainText(`| ${E.link} **VERIFIED** | 4 link(s) |`), "| **VERIFIED** | 4 link(s) |");
});

test("a callout icon at the start of a line becomes the label callouts already use", () => {
  assert.equal(plainText(`${E.bulb} Use a short name.`), "Tip: Use a short name.");
  assert.equal(plainText(`${E.target} Learn how grounding works.`), "Goal: Learn how grounding works.");
  assert.equal(plainText(`${E.tube} Ask the agent a question.`), "Try it: Ask the agent a question.");
  assert.equal(plainText(`${E.warning} Do not share the key.`), "Warning: Do not share the key.");
  assert.equal(plainText(`> ${E.bulb} Keep it short.`), "> Tip: Keep it short.");
  assert.equal(plainText(`**${E.bulb} Use a short name.**`), "**Tip: Use a short name.**");
});

test("a line that already carries its label keeps just the label", () => {
  assert.equal(plainText(`${E.bulb} Tip: use X`), "Tip: use X");
  assert.equal(plainText(`**${E.bulb} Tip:** use X`), "**Tip:** use X");
  assert.equal(plainText(`${E.warning} Warning: careful`), "Warning: careful");
  assert.equal(plainText(`${E.target} Goal: win`), "Goal: win");
  assert.equal(plainText(`**${E.tube} Try it:** run it`), "**Try it:** run it");
});

test("in a heading the icon is dropped, never replaced by a label", () => {
  assert.equal(plainText(`## ${E.tube} Use Case #3 \u2014 Add filters (10 min)`), "## Use Case #3 \u2014 Add filters (10 min)");
  assert.equal(plainText(`### ${E.bulb} Tips`), "### Tips");
});

test("a status mark that stands alone becomes a word; the sense decides which", () => {
  assert.equal(plainText(`| ${E.check} | ${E.cross} | ${E.warning} |`), "| Yes | No | Partial |");
  assert.equal(plainText(`| Feature | A | B |\n|---|---|---|\n| One | ${E.plainCheck} | ${E.plainCross} |`), "| Feature | A | B |\n|---|---|---|\n| One | Yes | No |");
  assert.equal(plainText(`Enabled: ${E.check}`), "Enabled: Yes");
  assert.equal(plainText(`- ${E.heavyCheck}`), "- Yes");
});

test("a status mark in front of words is dropped when the words already say it, and a cross never flips a sentence", () => {
  assert.equal(plainText(`- ${E.check} Done`), "- Done");
  assert.equal(plainText(`${E.check} Supported`), "Supported");
  assert.equal(plainText(`${E.cross} Not supported`), "Not supported");
  assert.equal(plainText(`${E.cross} Supported by default`), "No: Supported by default");
  assert.equal(plainText(`Done ${E.check} and ${E.heavyCheck} finished`), "Done and finished");
});

test("decoration is removed and the spaces it leaves collapse", () => {
  assert.equal(plainText(`Launch ${E.rocket}`), "Launch");
  assert.equal(plainText(`Hello ${E.rocket} world`), "Hello world");
  assert.equal(plainText(`foo ${E.rocket}, bar`), "foo, bar");
  assert.equal(plainText(`  - ${E.rocket} Indented item`), "  - Indented item");
  assert.equal(plainText(`${E.rocket}${E.rocket} two in a row`), "two in a row");
  assert.equal(plainText("\u{1F469}\u200D\u{1F4BB} a joined sequence"), "a joined sequence");
  assert.equal(plainText("\u{1F1FA}\u{1F1F8} a flag"), "a flag");
  assert.equal(plainText("1\uFE0F\u20E3 First"), "1 First");
});

test("arrows that carry direction stay arrows", () => {
  assert.equal(plainText("Select A \u27A1\uFE0F B"), "Select A \u2192 B");
  assert.equal(plainText("Back \u2192 Next \u2026 \u00D7 \u2022 \u2013 \u2014"), "Back \u2192 Next \u2026 \u00D7 \u2022 \u2013 \u2014");
});

test("code fences, inline code, link targets and URLs are never touched", () => {
  const fenced = `Before ${E.rocket}\n\`\`\`\n${E.rocket} inside the fence ${E.check}\n\`\`\`\nAfter ${E.rocket}`;
  assert.equal(plainText(fenced), `Before\n\`\`\`\n${E.rocket} inside the fence ${E.check}\n\`\`\`\nAfter`);
  assert.equal(plainText(`Run \`${E.rocket} code\` now ${E.rocket}`), `Run \`${E.rocket} code\` now`);
  const url = `https://example.com/a${E.rocket}b`;
  assert.equal(plainText(`See ${url} ${E.rocket}`), `See ${url}`);
  assert.equal(plainText(`[link ${E.rocket}](https://example.com/${E.rocket})`), `[link](https://example.com/${E.rocket})`);
});

test("legal marks and checkbox glyphs stay; a colored variant does not", () => {
  const kept = "Microsoft\u00AE Copilot\u2122 \u00A9 2026 \u2610 item \u2611 done \u2612 no";
  assert.equal(plainText(kept), kept);
  assert.equal(containsEmoji(kept), false);
  assert.equal(containsEmoji("\u2611\uFE0F"), true);
});

test("HTML text is cleaned, with <pre>, <code> and attribute values handled", () => {
  assert.equal(plainText(`<h3>${E.bulb} Use Case Builder</h3>`, { html: true }), "<h3>Use Case Builder</h3>");
  assert.equal(plainText(`<button class="btn">\u26A1 Generate</button>`, { html: true }), `<button class="btn">Generate</button>`);
  assert.equal(plainText(`<span aria-label="\u{1F4DA} Books">\u{1F4DA} Books</span>`, { html: true }), `<span aria-label="Books">Books</span>`);
  assert.equal(plainText(`<td>${E.check}</td><td>${E.cross}</td>`, { html: true }), "<td>Yes</td><td>No</td>");
  assert.equal(plainText(`<pre>${E.rocket} keep</pre> <code>${E.rocket} keep</code> ${E.rocket} go`, { html: true }), `<pre>${E.rocket} keep</pre> <code>${E.rocket} keep</code> go`);
});

test("plainText is idempotent and leaves text with no symbol exactly as it was", () => {
  const samples = [
    `| ${E.stopwatch} **TIME** | x |`,
    `${E.bulb} Use X`,
    `${E.cross} Supported by default`,
    `| ${E.check} | ${E.warning} |`,
    "No symbols here.  Two spaces stay.\n| a | b |",
    `## ${E.tube} Heading`,
  ];
  for (const sample of samples) {
    const once = plainText(sample);
    assert.equal(plainText(once), once, sample);
    assert.equal(containsEmoji(once), false, sample);
  }
  const untouched = "Plain text  with   spaces\n\n| a | b |\n|---|---|\n";
  assert.equal(plainText(untouched), untouched);
});

test("plainTextDeep cleans every string in a value and leaves keys, numbers and other values alone", () => {
  const value = { title: `${E.rocket} Lab`, rows: [`${E.check}`, { note: `${E.bulb} Use it` }], count: 3, flag: true, nothing: null };
  assert.deepEqual(plainTextDeep(value), { title: "Lab", rows: ["Yes", { note: "Tip: Use it" }], count: 3, flag: true, nothing: null });
});

test("emoji written as an escape or an entity are found too", () => {
  assert.equal(escapedEmojiMatches("const x = '\\u2705';").length, 1);
  assert.equal(escapedEmojiMatches("const x = '\\u{1F680}';").length, 1);
  assert.equal(escapedEmojiMatches("&#9654; and &#x1F4A1;").length, 2);
  assert.equal(escapedEmojiMatches("data:image/svg+xml,%3Ctext%3E%E2%9A%A1%3C/text%3E").length, 1);
  assert.equal(escapedEmojiMatches("a plain \\u2013 dash and &amp; and %20 space").length, 0);
  assert.deepEqual(emojiMatches(`a ${E.rocket} b`).map((m) => m.symbol), [E.rocket]);
});
