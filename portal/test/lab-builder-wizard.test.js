import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { getHarnesses } from "../lib/lab-builder/catalog.js";
import { recommend } from "../lib/lab-builder/recommend.js";
import { getKnownCoverageGaps, notApplicableReason } from "../lib/lab-builder/concepts.js";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const wizard = readFileSync(new URL("../public/lab-builder-wizard.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

const builderPanel = html.match(/id="panel-labbuilder"[\s\S]*?<!-- Preview tab -->/)?.[0] || "";

test("the wizard asks one question per step, in the required order", () => {
  const headings = [...builderPanel.matchAll(/id="lb-heading-(\d)"[^>]*>([^<]+)</g)].map((m) => [Number(m[1]), m[2]]);
  assert.deepEqual(headings.map(([n]) => n), [1, 2, 3, 4, 5, 6, 7, 8]);
  const order = ["products", "industry", "departments", "level", "harness", "topics", "Review", "Generate"];
  headings.forEach(([n, text], i) => {
    assert.match(text, new RegExp(`Step ${n} of 8`));
    assert.match(text, new RegExp(order[i], "i"));
  });
});

test("the step list is real buttons with the current step announced", () => {
  const list = builderPanel.match(/<ol class="lb-steps"[\s\S]*?<\/ol>/)?.[0];
  assert.ok(list, "the stepper is an ordered list");
  assert.equal([...list.matchAll(/<button\b/g)].length, 8);
  assert.match(list, /aria-current="step"/);
  assert.match(builderPanel, /<nav aria-label="Lab builder steps">/);
  assert.match(wizard, /setAttribute\("aria-current", "step"\)/);
  assert.match(wizard, /document\.getElementById\(`lb-heading-\$\{step\}`\)\?\.focus\(\)/);
});

test("each pane heading can take focus so a step change is announced", () => {
  for (let n = 1; n <= 8; n += 1) {
    assert.match(builderPanel, new RegExp(`id="lb-heading-${n}" tabindex="-1"`));
  }
});

test("a running total and the time-as-guidance message are always shown", () => {
  assert.match(builderPanel, /id="lb-summary"[^>]*aria-live="polite"/);
  assert.match(wizard, /estimate, not a limit/);
  assert.doesNotMatch(builderPanel, /Time budget/i);
  assert.doesNotMatch(wizard + app, /timeBudget/);
});

test("topics are checkboxes with Select recommended, Select all, Clear, Reset, and group actions", () => {
  for (const label of ["Select recommended", "Select all", "Clear", "Reset to my answers"]) assert.match(builderPanel, new RegExp(`>${label}<`));
  assert.match(wizard, /type="checkbox" data-topic=/);
  assert.match(wizard, /data-group-action="select"/);
  assert.match(wizard, /<fieldset class="lb-concept">/);
  assert.match(wizard, /Why: /);
});

test("the wizard builds exactly what the topic list shows and never adds hidden modules", () => {
  assert.match(wizard, /includeCore: false/);
  assert.match(wizard, /features: labBuilder\.rec \? labBuilder\.rec\.selectedIds : \[\]/);
  assert.match(wizard, /excluded: \[\.\.\.labBuilder\.excluded\]/);
  assert.doesNotMatch(builderPanel, /lb-include-core/);
});

test("the review outline is a table with a caption, headers, and a total", () => {
  assert.match(wizard, /<caption>Lab outline with estimated time per module<\/caption>/);
  assert.match(wizard, /<th scope="col">Estimated time<\/th>/);
  assert.match(wizard, /<tfoot>/);
});

test("the wizard script loads after app.js, and app.js no longer carries the old feature picker", () => {
  assert.ok(html.indexOf('src="lab-builder-wizard.js"') > html.indexOf('src="app.js"'));
  assert.doesNotMatch(app, /lbRenderFeatures|selectedFeatures/);
  assert.match(wizard, /\/api\/lab-builder\/recommend/);
});

test("a concept with no topic yet is reported as not available yet, not as not applicable", () => {
  // Cells listed in knownGaps are the only ones that can still be "not available yet".
  for (const cell of getKnownCoverageGaps()) {
    const [conceptId, target] = cell.split(":");
    const answers = getHarnesses().some((h) => h.id === target) ? { harness: target } : { products: [target] };
    const row = recommend(answers).concepts.find((c) => c.id === conceptId);
    assert.equal(row.notYetAvailable, true, cell);
  }
  const concept = { id: "x", features: ["f"], notApplicable: {} };
  const features = new Map([["f", { harness: ["standard"] }]]);
  assert.match(notApplicableReason(concept, "microsoft-copilot", features), /available on this harness yet/i);
  assert.equal(notApplicableReason(concept, "standard", features), null);
  const hooksOnStandard = recommend({ harness: "standard" }).concepts.find((c) => c.id === "hooks");
  assert.equal(hooksOnStandard.notYetAvailable, false);
  assert.match(hooksOnStandard.notApplicable, /topics/);
});
