import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

/** Run the real lbGenerate with a stub page so focus can be observed. */
function loadGenerate(respond) {
  const start = app.indexOf("async function lbGenerate()");
  const end = app.indexOf("function lbCancelGenerate()");
  assert.ok(start > 0 && end > start, "lbGenerate is where the test expects it");
  const doc = { activeElement: null };
  const make = (id) => ({
    id,
    hidden: true,
    disabled: false,
    textContent: "",
    focus() {
      if (!this.disabled) doc.activeElement = this;
    },
  });
  const elements = new Map(["lb-generate-btn", "lb-status", "lb-cancel-btn", "lb-result-heading"].map((id) => [id, make(id)]));
  doc.body = { id: "body" };
  doc.activeElement = doc.body;
  doc.getElementById = (id) => elements.get(id) || null;
  const toasts = [];
  const context = {
    document: doc,
    labBuilder: { busy: false, controller: null },
    lbGen: {},
    AbortController,
    toast: (message, kind) => toasts.push({ message, kind }),
    fetch: async () => respond(),
    lbRequest: () => ({}),
    lbReplaceTarget: () => undefined,
    lbShowResult() {},
    lbGenCloseOpened() {},
    lbStopEditing() {},
    lbLoadGenerated() {},
    lbRenderDecisions: async () => null,
  };
  vm.createContext(context);
  vm.runInContext(`${app.slice(start, end)}; globalThis.lbGenerate = lbGenerate;`, context);
  return { context, doc, elements, toasts };
}

test("after a build the keyboard focus moves to the new lab's heading instead of falling back to the page", async () => {
  const { context, doc, elements } = loadGenerate(() => ({ ok: true, json: async () => ({ status: "complete", labId: "x", title: "T", manifest: {}, warnings: [] }) }));
  doc.activeElement = elements.get("lb-generate-btn");
  await context.lbGenerate();
  assert.equal(doc.activeElement, elements.get("lb-result-heading"));
  assert.equal(elements.get("lb-generate-btn").disabled, false);
});

test("a failed or cancelled build puts focus back on the build button, and nothing is shown as built", async () => {
  for (const respond of [
    () => ({ ok: false, json: async () => ({ error: "boom" }) }),
    () => ({ ok: true, json: async () => ({ status: "cancelled" }) }),
  ]) {
    const { context, doc, elements, toasts } = loadGenerate(respond);
    doc.activeElement = elements.get("lb-generate-btn");
    // The button is disabled for the build, so the browser drops focus to the page.
    elements.get("lb-generate-btn").disabled = true;
    doc.activeElement = doc.body;
    const run = context.lbGenerate();
    await run;
    assert.equal(doc.activeElement, elements.get("lb-generate-btn"));
    assert.ok(toasts.every((t) => !/^Built/.test(t.message)));
  }
});

test("the include toggle on each lab chapter is at least 24 by 24 CSS pixels (WCAG 2.2 target size)", () => {
  const rule = html.match(/\.lab-toggle \{([^}]*)\}/)[1];
  const px = (name) => Number(rule.match(new RegExp(`${name}:\\s*(\\d+)px`))[1]);
  assert.ok(px("width") >= 24 && px("height") >= 24, rule);
  const knob = html.match(/\.lab-toggle::after \{([^}]*)\}/)[1];
  const knobSize = Number(knob.match(/width:\s*(\d+)px/)[1]);
  const shift = Number(html.match(/\.lab-toggle\.on::after \{ transform: translateX\((\d+)px\)/)[1]);
  assert.equal(2 + knobSize + shift + 2, px("width"), "the knob travels exactly to the other end of the track");
});
