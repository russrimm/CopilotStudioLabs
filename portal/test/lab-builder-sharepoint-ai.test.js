import { test } from "node:test";
import assert from "node:assert/strict";

import { getFeatures } from "../lib/lab-builder/catalog.js";
import { getSlotMeta } from "../lib/lab-builder/slots.js";
import { getConcepts } from "../lib/lab-builder/concepts.js";
import { productOf } from "../lib/lab-builder/products.js";

const spai = () => getFeatures().filter((f) => productOf(f) === "sharepoint-ai");

test("SharePoint AI spans all three levels with enough topics for a curriculum", () => {
  const features = spai();
  assert.ok(features.length >= 12 && features.length <= 20, `expected 12 to 20 topics, found ${features.length}`);
  for (const level of [100, 200, 300]) {
    assert.ok(features.filter((f) => f.level === level).length >= 3, `level ${level} needs at least three topics`);
  }
  assert.ok(features.every((f) => f.id.startsWith("spai-")));
});

test("every SharePoint AI topic has a walkthrough, checks, Learn sources, and screenshot slots tied to a step", () => {
  const meta = getSlotMeta();
  for (const f of spai()) {
    assert.ok(f.steps.length >= 6, `${f.id}: needs a real walkthrough`);
    assert.ok(f.validation.length >= 2, `${f.id}: needs checks`);
    assert.ok(f.docUrls.every((u) => u.startsWith("https://learn.microsoft.com/")), `${f.id}: Learn URLs only`);
    assert.ok(f.screenshots?.length, `${f.id}: needs a screenshot slot`);
    for (const slot of f.screenshots) {
      assert.match(slot.filename, /^spai-.+\.png$/);
      assert.ok(meta[slot.filename], `${slot.filename}: needs alt text and a caption`);
      const named = slot.instructions.join(" ").match(/After step (\d+)/);
      assert.ok(named, `${slot.filename}: instructions say which step they follow`);
      assert.ok(Number(named[1]) <= f.steps.length, `${slot.filename}: step ${named[1]} exists`);
    }
    assert.ok(!f.harness, `${f.id}: no harness tag`);
  }
});

test("each SharePoint AI topic states its roles or licensing and marks anything unconfirmed", () => {
  for (const f of spai()) {
    const text = f.concepts.join(" ");
    assert.match(text, /\b(Roles?|license|licensing|permission)/i, `${f.id}: name who does it or what it needs`);
  }
  assert.ok(spai().some((f) => JSON.stringify(f).includes("Not confirmed in Microsoft Learn")));
  assert.ok(!spai().some((f) => /GitHub Copilot harness|Microsoft Copilot harness/.test(JSON.stringify(f))), "harness wording is for Copilot Studio only");
});

test("SharePoint AI topics cover content AI, governance, monitoring, billing, and sharing concepts", () => {
  const owned = new Map();
  for (const c of getConcepts()) for (const id of c.features) owned.set(id, c.id);
  const concepts = new Set(spai().map((f) => owned.get(f.id)));
  for (const id of ["create-agent", "knowledge", "content-ai", "security", "governance", "monitor", "billing", "publish"]) {
    assert.ok(concepts.has(id), `no SharePoint AI topic teaches ${id}`);
  }
});
