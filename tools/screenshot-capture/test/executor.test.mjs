// The executor's decisions that need no browser: how a name is matched, whether a control sits where the step says,
// and whether what the page shows now is the effect the step expected. The browser behavior (strategy fallback, frames,
// shadow DOM, streaming answers) is proven in autonomous-real-browser.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";

import { effectSatisfied, exactNameRegex, fitsArea, nameScore, STRATEGIES, targetNames, wordsRegex } from "../executor.mjs";

test("a step answers to its own name and its alternates, matched whole and without caring about case", () => {
  assert.deepEqual(targetNames({ name: "Test", alt: ["Test your agent", "Open test pane"] }), ["Test", "Test your agent", "Open test pane"]);
  assert.deepEqual(targetNames({}), []);
  const exact = exactNameRegex(["Test", "Test your agent"]);
  assert.ok(exact.test("test"));
  assert.ok(exact.test("  Test your agent "));
  assert.ok(!exact.test("Testing"), "a longer name is not the same control");
  assert.ok(!exact.test("Test results"), "a name that merely starts with it is not either");
  assert.ok(exactNameRegex(["Add (new) item?"]).test("add (new) item?"), "punctuation in a name is not a pattern");

  const words = wordsRegex(["Add knowledge"]);
  assert.ok(words.test("Add  knowledge source"), "the words in order, with other text around them");
  assert.ok(words.test("Add-knowledge"));
  assert.ok(!words.test("Knowledge add"), "the order matters");
  assert.equal(wordsRegex([]), null);
});

test("a renamed button still scores, an unrelated one does not, and the ranked strategies run from exact to fuzzy", () => {
  assert.equal(nameScore(["Add knowledge"], "Add knowledge"), 1);
  assert.ok(nameScore(["Add knowledge"], "Add knowledge source") > 0.7, "a longer name that contains the words");
  assert.ok(nameScore(["Add knowledge"], "Add a knowledge source") > 0.6);
  assert.ok(nameScore(["Add knowledge"], "Delete agent") < 0.2);
  assert.equal(nameScore(["Add knowledge"], ""), 0);
  assert.equal(nameScore(["Publish", "Add knowledge"], "Add knowledge"), 1, "the best of the names counts");
  assert.deepEqual([...STRATEGIES], ["role-exact", "role-name", "attribute", "text-ancestor", "fuzzy"], "cheap and precise first, fuzzy last");
});

test("a control must sit where the step says, and a dialog or the test pane is never left", () => {
  assert.equal(fitsArea({ inNav: true }, "nav"), true);
  assert.equal(fitsArea({ inNav: false }, "nav"), false);
  assert.equal(fitsArea({ inDialog: true }, "dialog"), true);
  assert.equal(fitsArea({ inDialog: false }, "dialog"), false);
  assert.equal(fitsArea({ inTestPane: true }, "chat"), true);
  assert.equal(fitsArea({ inHeader: true }, "header"), true);
  assert.equal(fitsArea({ inDialog: true, inNav: false, inHeader: false }, "main"), false, "the main area is not a dialog");
  assert.equal(fitsArea({ inNav: false, inDialog: false, inHeader: false }, "main"), true);
  assert.equal(fitsArea({ role: "tab" }, "tablist"), true);
  assert.equal(fitsArea({}, "any"), true);
  assert.equal(fitsArea({}, undefined), true);
});

const state = (extra = {}) => ({ url: "https://copilotstudio.microsoft.com/a", changes: 5, text: 100, busy: 0, dialogs: [], ...extra });

test("a click counts only when the page shows the effect the step expected", () => {
  // With no expectation, any visible change is enough, and no change is a failure that tries the next control.
  assert.equal(effectSatisfied(null, state(), state()).ok, false);
  assert.equal(effectSatisfied(null, state(), state({ url: "https://copilotstudio.microsoft.com/b" })).ok, true);
  assert.equal(effectSatisfied(null, state(), state({ changes: 9 })).ok, true);
  assert.equal(effectSatisfied({}, state(), state({ changes: null })).ok, false, "no counter and no change is no effect");
  assert.equal(effectSatisfied(null, state(), state(), { selectedChanged: true }).ok, true);

  const dialog = { kind: "dialog", title: "Add knowledge" };
  assert.equal(effectSatisfied({ dialog: true }, state(), state({ dialogs: [dialog] })).ok, true);
  assert.equal(effectSatisfied({ dialog: true }, state(), state({ changes: 50 })).ok, false, "a busy page is not a dialog");
  assert.equal(effectSatisfied({ dialog: "Add knowledge" }, state(), state({ dialogs: [dialog] })).ok, true, "a dialog with the expected title");
  assert.equal(effectSatisfied({ dialog: "Publish" }, state(), state({ dialogs: [dialog] })).ok, false, "the wrong dialog is not the effect");
  assert.equal(effectSatisfied({ dialog: true }, state({ dialogs: [dialog] }), state({ dialogs: [dialog] })).ok, true, "a dialog that is open counts");
  assert.equal(effectSatisfied({ dialog: true }, state(), state({ dialogs: [{ kind: "panel", title: "" }] })).ok, false, "a side panel is not a dialog");

  assert.equal(effectSatisfied({ panel: true }, state(), state({ dialogs: [{ kind: "panel", title: "Tools" }], changes: 8 })).ok, true);
  assert.equal(effectSatisfied({ panel: true }, state(), state()).ok, false);

  assert.equal(effectSatisfied({ urlPath: "/knowledge" }, state(), state({ url: "https://copilotstudio.microsoft.com/environments/x/bots/y/knowledge" })).ok, true);
  assert.equal(effectSatisfied({ urlPath: "/knowledge" }, state(), state({ url: "https://copilotstudio.microsoft.com/environments/x/bots/y/tools" })).ok, false);
  assert.equal(effectSatisfied({ selected: true }, state(), state()).ok, false, "a tab that did not become selected");
  assert.equal(effectSatisfied({ selected: true }, state(), state(), { selectedChanged: true }).ok, true);
});
