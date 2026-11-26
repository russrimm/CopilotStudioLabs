/**
 * AI writing: how passages are grouped into model calls (portal/lib/ai/batching.js), what a model is asked to reword, and the
 * time one call gets. All pure functions; nothing here calls a model.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { callTimeoutMs, isRewordable, packRequests, piecesOf, sectionsOf, sizeOf, splitInHalf } from "../lib/ai/batching.js";
import { estimatePrompts, ESTIMATE_PARAMS } from "../lib/ai/estimate.js";
import { MIN_CALL_TIMEOUT_MS } from "../lib/ai/config.js";

test("a label, a number or two words are not worth a model's time; a sentence is", () => {
  for (const text of ["**Settings**", "`agent-instructions`", "4:3", "100", "Overview", "Add knowledge", "SAY: Welcome.", "**Create** **Save**", "https://learn.microsoft.com/x", "\"Home\""]) {
    assert.equal(isRewordable(text), false, text);
  }
  for (const text of ["Agents help associates answer product questions quickly.", "Open **Settings** and select **Knowledge**.", "SAY: Welcome, everyone. Today we look at agents."]) {
    assert.equal(isRewordable(text), true, text);
  }
});

test("a list is cut into passages with their own ids, and the ones with nothing to reword are marked", () => {
  const block = { id: "u.steps", kind: "step", type: "list", sources: ["Sign in to the portal and wait for the page.", "**Save**", "Select **Create** and name the agent."], names: [], ui: [] };
  const pieces = piecesOf(block);
  assert.deepEqual(pieces.map((p) => p.id), ["u.steps~1", "u.steps~2", "u.steps~3"]);
  assert.deepEqual(pieces.map((p) => p.ask), [true, false, true]);
  assert.deepEqual(pieces.map((p) => p.position), ["1 of 3", "2 of 3", "3 of 3"]);
  assert.ok(pieces.every((p) => p.group === "u.steps"));
  assert.deepEqual(pieces[2].keep.filter((k) => k.includes("Create")), ["**Create**"], "a bold term travels with its passage only");
  assert.deepEqual(sizeOf(pieces), { chars: pieces[0].source.length + pieces[2].source.length, items: 2 });
  const text = piecesOf({ id: "u.why", kind: "why", type: "text", source: "Agents help the team answer questions faster.", names: [] });
  assert.equal(text.length, 1);
  assert.equal(text[0].id, "u.why");
  assert.equal("group" in text[0], false);
});

function entries(spec) {
  return spec.map(([unit, chars], i) => ({ unit, block: { id: `b${i}` }, pieces: [], chars, items: 1 }));
}

test("requests are packed by size: characters, blocks, and units; a block is never split", () => {
  const a = { id: "a" };
  const b = { id: "b" };
  const c = { id: "c" };
  const d = { id: "d" };
  const e = { id: "e" };
  const bySize = packRequests(entries([[a, 1500], [a, 1500], [a, 1500], [a, 1500]]), { maxChars: 3500, maxBlocks: 16 });
  assert.deepEqual(bySize.map((r) => r.entries.length), [2, 2], "1500 + 1500 fits, a third does not");
  const byCount = packRequests(entries(Array.from({ length: 7 }, () => [a, 10])), { maxChars: 3500, maxBlocks: 3 });
  assert.deepEqual(byCount.map((r) => r.entries.length), [3, 3, 1]);
  const oversized = packRequests(entries([[a, 100], [b, 9000], [c, 100]]), { maxChars: 3500, maxBlocks: 16 });
  assert.deepEqual(oversized.map((r) => r.entries.length), [1, 1, 1], "a block larger than the limit goes alone, whole");
  const byUnit = packRequests(entries([[a, 10], [b, 10], [c, 10], [d, 10], [e, 10]]), { maxChars: 3500, maxBlocks: 16, maxUnits: 3 });
  assert.deepEqual(byUnit.map((r) => r.entries.length), [3, 2], "no request carries more than three scenarios");
  assert.deepEqual(packRequests([], { maxChars: 10, maxBlocks: 2 }), []);
  assert.ok(bySize.every((r) => r.depth === 0 && r.attempts === 0));
});

test("every request sends short ids and group labels, and maps them back to the pieces", () => {
  const unitA = { id: "ua" };
  const unitB = { id: "ub" };
  const list = { id: "long.deck.name.s3.notes", kind: "note", type: "list", sources: ["Welcome everyone to this short session.", "Today we look at what an agent is."], names: [] };
  const text = { id: "lab.module-name.why", kind: "why", type: "text", source: "Agents help the team answer questions faster.", names: [] };
  const list2 = { id: "other.s1.body", kind: "slide", type: "list", sources: ["A short plain sentence about agents."], names: [] };
  const mk = (unit, block) => ({ unit, block, pieces: piecesOf(block), chars: 100, items: 2 });
  const { sections, ids } = sectionsOf([mk(unitA, list), mk(unitA, text), mk(unitB, list2)]);
  assert.equal(sections.length, 2, "one section for each scenario");
  assert.deepEqual(sections[0].pieces.map((p) => p.id), ["p1", "p2", "p3"]);
  assert.deepEqual(sections[0].pieces.map((p) => p.group), ["g1", "g1", undefined]);
  assert.deepEqual(sections[1].pieces.map((p) => [p.id, p.group]), [["p4", "g2"]]);
  assert.equal(ids.get("p1"), "long.deck.name.s3.notes~1");
  assert.equal(ids.get("p3"), "lab.module-name.why");
  assert.ok(sections.flatMap((s) => s.pieces).every((p) => p.id.length <= 3), "the model never has to write a long id back");
});

test("a call's time limit grows with the text it must write, between a floor and the configured limit", () => {
  const small = callTimeoutMs({ chars: 400, items: 3 }, 120000);
  const usual = callTimeoutMs({ chars: 3300, items: 35 }, 120000);
  const huge = callTimeoutMs({ chars: 20000, items: 300 }, 120000);
  assert.equal(small, MIN_CALL_TIMEOUT_MS, "a tiny call still gets the floor: the service's own delay varies");
  assert.ok(usual > small && usual < 120000, `a usual call gets more than the floor (${usual})`);
  assert.equal(huge, 120000, "never more than AI_TIMEOUT_MS");
  assert.equal(callTimeoutMs({ chars: 10, items: 1 }, 20000), 20000, "a configured limit below the floor wins");
  assert.ok(MIN_CALL_TIMEOUT_MS >= 60000, "the SDK's own default is 60 seconds, and a three-passage call has taken 25");
});

test("a request splits in half by blocks, and a single block does not split", () => {
  assert.equal(splitInHalf([1]), null);
  assert.deepEqual(splitInHalf([1, 2]), [[1], [2]]);
  assert.deepEqual(splitInHalf([1, 2, 3, 4, 5]), [[1, 2, 3], [4, 5]]);
});

test("the prompt estimate: measured labs of 2, 6 and 9 modules, and each part on its own", () => {
  // The planned requests counted for real labs with tools/lab-builder/ai-measure.mjs --plan-only: [modules, lab, training].
  for (const [modules, lab, training] of [[2, 2, 10], [6, 4, 24], [9, 6, 35]]) {
    const all = estimatePrompts({ modules, scope: ["lab", "training", "labday"] });
    assert.ok(all.prompts >= lab + training, `${modules} modules: ${all.prompts} covers the ${lab + training} requests planned`);
    assert.ok(all.prompts <= Math.ceil((lab + training) * 1.35), `${modules} modules: ${all.prompts} is close to what is planned`);
    assert.equal(all.byPart.labday, 0, "the lab-day decks are covered by the lab text");
  }
  assert.equal(estimatePrompts({ modules: 2, scope: [] }).prompts, 0);
  assert.equal(estimatePrompts({ modules: 0, scope: ["lab"] }).prompts > 0, true, "a lab has at least one module");
  const training = estimatePrompts({ modules: 4, scope: ["training"] });
  const lab = estimatePrompts({ modules: 4, scope: ["lab"] });
  const both = estimatePrompts({ modules: 4, scope: ["lab", "training"] });
  assert.ok(training.prompts > lab.prompts, "the decks cost more prompts than the lab text");
  assert.ok(both.prompts >= Math.max(training.prompts, lab.prompts));
  const onlyLabday = estimatePrompts({ modules: 4, scope: ["labday"] });
  assert.ok(onlyLabday.byPart.labday > 0 && onlyLabday.prompts < lab.prompts, "the lab-day concept points alone are a small part");
  assert.equal(Object.isFrozen(ESTIMATE_PARAMS), true);
});
