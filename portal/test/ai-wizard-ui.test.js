/**
 * AI writing control in the lab builder wizard, in a fake DOM: hidden when AI cannot work here, a calm line when the server
 * turned it off, a sign-in prompt, and the model picker. Plus the draft round trip, the request field, the progress text, and
 * what the page source must keep true (no emoji, plain words, 44px targets, its own CSS block, no side stripe).
 */

import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createFakeDom } from "./fixtures/fake-dom.js";
import { installInnerHtml, parseHtml } from "./fixtures/fake-html.js";

const portalRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (name) => readFileSync(join(portalRoot, "public", name), "utf8");
const SCRIPT = read("ai-writing.js");
const HTML = read("index.html");
const CARD = HTML.slice(HTML.indexOf('<section id="lb-ai-card"'), HTML.indexOf("</section>", HTML.indexOf('<section id="lb-ai-card"')) + "</section>".length);

const MODELS = [
  { id: "fake-fast", name: "Fake Fast", cost: "Uses 0.33 of a premium request for each prompt", warning: null },
  { id: "fake-smart", name: "Fake Smart", cost: "Uses 1 premium request for each prompt", warning: "Preview model" },
];
const READY = { mode: "local-user", state: "ready", possible: true, available: true, message: "Signed in as octo.", signedIn: true, signedInAs: "octo", needsSignIn: false, sends: "AI sees only the lab's topic text and the scenario fields you typed.", scopes: [] };
const OFF = { mode: "off", state: "off", possible: false, available: false, message: "AI writing is turned off on this server." };
const UNAVAILABLE = { mode: "local-user", state: "unavailable", possible: false, available: false, reason: "not-local", message: "AI writing in local mode only works from the PC that runs the portal." };
const SIGN_IN = { mode: "per-user", state: "sign-in", possible: true, available: false, needsSignIn: true, signInUrl: "/api/ai/auth/start", message: "Sign in with GitHub to use AI writing.", sends: "AI sees only the lab's topic text." };

function page({ status, models = MODELS, modelsOk = true, authStart } = {}) {
  const dom = createFakeDom();
  installInnerHtml(dom);
  const { document, FakeEvent } = dom;
  for (const node of parseHtml(`<div id="lb-status"></div>${CARD}`, document)) document.body.appendChild(node);
  const fetches = [];
  const opened = [];
  let current = status;
  const context = vm.createContext({
    console,
    document,
    escapeHtml: (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]),
    setInterval,
    clearInterval,
    open: (url, name) => opened.push({ url, name }),
    fetch: async (url, init = {}) => {
      fetches.push({ url: String(url), method: init.method || "GET" });
      const reply = (ok, body) => ({ ok, status: ok ? 200 : 502, json: async () => body });
      if (url === "/api/ai/status") return reply(true, current);
      if (url === "/api/ai/models") return modelsOk ? reply(true, { models }) : reply(false, { error: "The model list could not be read." });
      if (url === "/api/ai/auth/start") return reply(true, authStart || { url: "https://github.com/login/oauth/authorize?x=1" });
      if (String(url).startsWith("/api/ai/progress/")) return reply(true, { done: 12, total: 40, stage: "training", finished: false });
      throw new Error(`Unexpected fetch ${url}`);
    },
  });
  vm.runInContext(`${SCRIPT}\nglobalThis.__ai = { labBuilderAi, lbAiRefresh, lbAiRequestField, lbAiDraftChoice, lbAiApplySaved, lbAiReset, lbAiCheckBeforeBuild, lbAiSummaryText, lbAiFactText, lbAiOnBuildStart, lbAiOnBuildEnd, lbAiProgressText, lbAiSetEnabled, lbAiSetModel, lbAiSetScope, lbAiSignIn };`, context);
  // Values made inside the vm have another Object prototype, so they are copied before they are compared.
  const copy = (fn) => (...args) => {
    const out = fn(...args);
    return out && typeof out === "object" ? JSON.parse(JSON.stringify(out)) : out;
  };
  const ai = { ...context.__ai, lbAiRequestField: copy(context.__ai.lbAiRequestField), lbAiDraftChoice: copy(context.__ai.lbAiDraftChoice) };
  const byId = (id) => document.getElementById(id);
  const change = (id, props = {}) => {
    const el = byId(id);
    Object.assign(el, props);
    el.dispatchEvent(new FakeEvent("change"));
  };
  return { ai, byId, change, fetches, opened, setStatus: (s) => (current = s), document, FakeEvent, tick: () => new Promise((r) => setTimeout(r, 5)) };
}

const visible = (el) => Boolean(el) && !el.hidden;

test("when AI cannot work for this visitor the card is not shown at all", async () => {
  const p = page({ status: UNAVAILABLE });
  await p.ai.lbAiRefresh();
  assert.equal(p.byId("lb-ai-card").hidden, true);
  assert.deepEqual(p.ai.lbAiRequestField(), {});
  assert.equal(p.fetches.some((f) => f.url === "/api/ai/models"), false, "no model list is asked for");
});

test("when the server turned AI off one calm line says so, and no control is offered", async () => {
  const p = page({ status: OFF });
  await p.ai.lbAiRefresh();
  assert.equal(p.byId("lb-ai-card").hidden, false);
  assert.equal(visible(p.byId("lb-ai-off-note")), true);
  assert.equal(p.byId("lb-ai-off-note").textContent, "AI writing is turned off on this server.");
  assert.equal(p.byId("lb-ai-body").hidden, true);
  assert.deepEqual(p.ai.lbAiRequestField(), {});
});

test("when a status request fails the card stays hidden and the page keeps working", async () => {
  const p = page({ status: null });
  p.setStatus(null);
  await p.ai.lbAiRefresh();
  assert.equal(p.byId("lb-ai-card").hidden, true);
});

test("available: off by default; turning it on shows the models, their cost in plain words, what is sent, and the parts AI writes", async () => {
  const p = page({ status: READY });
  await p.ai.lbAiRefresh();
  assert.equal(p.byId("lb-ai-card").hidden, false);
  assert.equal(p.byId("lb-ai-enabled").checked, false, "off by default");
  assert.equal(p.byId("lb-ai-options").hidden, true);
  assert.equal(p.fetches.some((f) => f.url === "/api/ai/models"), false, "models load only when AI is turned on");
  assert.deepEqual(p.ai.lbAiRequestField(), {});

  p.change("lb-ai-enabled", { checked: true });
  await p.tick();
  assert.equal(p.byId("lb-ai-options").hidden, false);
  assert.equal(p.byId("lb-ai-enabled").getAttribute("aria-expanded"), "true");
  assert.match(p.byId("lb-ai-status").textContent, /Signed in as octo/);
  assert.match(p.byId("lb-ai-sends").textContent, /scenario fields you typed/);
  const options = p.byId("lb-ai-model").querySelectorAll("option");
  assert.deepEqual([...options].map((o) => o.textContent), ["Choose a model", "Fake Fast", "Fake Smart"]);
  assert.deepEqual(p.ai.lbAiRequestField(), {}, "no model chosen yet");
  assert.match(p.ai.lbAiCheckBeforeBuild(), /Pick an AI model/);

  p.change("lb-ai-model", { value: "fake-smart" });
  assert.match(p.byId("lb-ai-model-cost").textContent, /Uses 1 premium request for each prompt/);
  assert.match(p.byId("lb-ai-model-cost").textContent, /Preview model/);
  assert.deepEqual(p.ai.lbAiRequestField(), { ai: { enabled: true, provider: "github-copilot", model: "fake-smart", scope: ["lab", "training", "labday"] } });
  assert.equal(p.ai.lbAiCheckBeforeBuild(), "");
  assert.match(p.byId("lb-ai-summary").textContent, /AI writing is on: Fake Smart will reword the lab text, the training decks and the lab-day decks\./);
  assert.equal(p.ai.lbAiFactText(), "Written with AI (Fake Smart)");
});

test("a person chooses what AI writes; with nothing chosen the build is not started", async () => {
  const p = page({ status: READY });
  await p.ai.lbAiRefresh();
  p.change("lb-ai-enabled", { checked: true });
  await p.tick();
  p.change("lb-ai-model", { value: "fake-fast" });
  p.change("lb-ai-scope-labday", { checked: false });
  p.change("lb-ai-scope-lab", { checked: false });
  assert.deepEqual(p.ai.lbAiRequestField().ai.scope, ["training"]);
  assert.match(p.byId("lb-ai-summary").textContent, /will reword the training decks\./);
  p.change("lb-ai-scope-training", { checked: false });
  assert.deepEqual(p.ai.lbAiRequestField(), {});
  assert.match(p.ai.lbAiCheckBeforeBuild(), /Choose what AI writes/);
});

test("signing in: the button shows, the model picker waits, and GitHub opens in a window of its own", async () => {
  const p = page({ status: SIGN_IN });
  await p.ai.lbAiRefresh();
  p.change("lb-ai-enabled", { checked: true });
  assert.equal(visible(p.byId("lb-ai-signin")), true);
  assert.equal(p.byId("lb-ai-model-group").hidden, true);
  assert.equal(p.byId("lb-ai-scope").hidden, true);
  assert.equal(p.byId("lb-ai-status").textContent, "Sign in with GitHub to use AI writing.");
  assert.match(p.ai.lbAiCheckBeforeBuild(), /Sign in with GitHub to write with AI, or turn Write with AI off/);
  assert.deepEqual(p.ai.lbAiRequestField(), {});
  await p.ai.lbAiSignIn();
  assert.deepEqual(p.opened, [{ url: "https://github.com/login/oauth/authorize?x=1", name: "ai-sign-in" }]);
  assert.ok(p.fetches.some((f) => f.url === "/api/ai/auth/start" && f.method === "POST"));
  clearInterval(p.ai.labBuilderAi.signInTimer);
});

test("a failed model list is explained, not silent", async () => {
  const p = page({ status: READY, modelsOk: false });
  await p.ai.lbAiRefresh();
  p.change("lb-ai-enabled", { checked: true });
  await p.tick();
  assert.match(p.byId("lb-ai-error").textContent, /model list could not be read/);
  assert.deepEqual(p.ai.lbAiRequestField(), {});
});

test("the AI choice round-trips through a draft or a built lab, and a model that is no longer offered is dropped with a message", async () => {
  const p = page({ status: READY });
  await p.ai.lbAiRefresh();
  p.change("lb-ai-enabled", { checked: true });
  await p.tick();
  p.change("lb-ai-model", { value: "fake-smart" });
  p.change("lb-ai-scope-lab", { checked: false });
  const saved = p.ai.lbAiDraftChoice();
  assert.deepEqual(saved, { enabled: true, model: "fake-smart", scope: ["training", "labday"] });
  assert.equal(JSON.stringify(saved).includes("token"), false);

  const q = page({ status: READY });
  await q.ai.lbAiRefresh();
  q.ai.lbAiApplySaved(saved);
  assert.equal(q.byId("lb-ai-enabled").checked, true);
  await q.ai.lbAiRefresh();
  await q.tick();
  assert.equal(q.byId("lb-ai-model").value, "fake-smart");
  assert.deepEqual(q.ai.lbAiDraftChoice(), saved);
  assert.deepEqual(q.ai.lbAiRequestField().ai.scope, ["training", "labday"]);

  const stale = page({ status: READY, models: [MODELS[0], { id: "fake-other", name: "Fake Other", cost: "Cost not reported by GitHub" }] });
  await stale.ai.lbAiRefresh();
  stale.ai.lbAiApplySaved(saved);
  await stale.ai.lbAiRefresh();
  await stale.tick();
  assert.match(stale.byId("lb-ai-error").textContent, /not available to you now/);
  assert.equal(stale.ai.lbAiDraftChoice().model, null);

  q.ai.lbAiReset();
  assert.deepEqual(q.ai.lbAiDraftChoice(), { enabled: false, model: null, scope: ["lab", "training", "labday"] });
  assert.equal(q.byId("lb-ai-enabled").checked, false);
});

test("a draft or lab saved before AI opens with AI off", () => {
  const p = page({ status: READY });
  p.ai.lbAiApplySaved(undefined);
  assert.deepEqual(p.ai.lbAiDraftChoice(), { enabled: false, model: null, scope: ["lab", "training", "labday"] });
  p.ai.lbAiApplySaved({ enabled: true, model: 7, scope: ["lab", "bogus"] });
  assert.deepEqual(p.ai.lbAiDraftChoice(), { enabled: true, model: null, scope: ["lab"] });
});

test("while the lab builds the page shows blocks done of total, and stops asking when the build ends", async () => {
  const p = page({ status: READY });
  await p.ai.lbAiRefresh();
  p.change("lb-ai-enabled", { checked: true });
  await p.tick();
  p.change("lb-ai-model", { value: "fake-fast" });
  assert.equal(p.ai.lbAiProgressText(), "");
  p.ai.lbAiOnBuildStart("b0123456789abcdef01234567");
  await new Promise((r) => setTimeout(r, 1700));
  assert.equal(p.ai.lbAiProgressText(), "Writing the training decks with AI: 12 of 40 passages.");
  assert.equal(p.byId("lb-status").textContent, "Writing the training decks with AI: 12 of 40 passages.");
  p.ai.lbAiOnBuildEnd();
  assert.equal(p.ai.lbAiProgressText(), "");
  const asked = p.fetches.length;
  await new Promise((r) => setTimeout(r, 1700));
  assert.equal(p.fetches.length, asked, "no more checks after the build");
  // With AI off nothing is polled.
  const off = page({ status: READY });
  await off.ai.lbAiRefresh();
  off.ai.lbAiOnBuildStart("b0123456789abcdef01234567");
  assert.equal(off.ai.labBuilderAi.progressTimer, null);
});

// ── what the page source must keep true ──────────────────────────────────────
const WIZARD = read("lab-builder-wizard.js");
const APP = read("app.js");
const DRAFTS = read("lab-builder-drafts.js");

test("the wizard, drafts and build call the AI script only when it is there, so every other page is unchanged", () => {
  assert.match(WIZARD, /typeof lbAiRequestField === "function" \? lbAiRequestField\(\) : \{\}/);
  assert.match(WIZARD, /typeof lbAiApplySaved === "function"\) lbAiApplySaved\(saved\.ai\)/);
  assert.match(WIZARD, /typeof lbAiReset === "function"\) lbAiReset\(\)/);
  assert.match(WIZARD, /typeof lbAiRefresh === "function"\) void lbAiRefresh\(\)/);
  assert.match(WIZARD, /typeof lbAiFactText === "function"/);
  assert.match(DRAFTS, /typeof lbAiDraftChoice === "function" \? \{ ai: lbAiDraftChoice\(\) \} : \{\}/);
  assert.match(APP, /typeof lbAiCheckBeforeBuild === "function"/);
  assert.match(APP, /typeof lbAiOnBuildStart === "function"\) lbAiOnBuildStart\(ticket\)/);
  assert.match(APP, /typeof lbAiOnBuildEnd === "function"\) lbAiOnBuildEnd\(\)/);
  assert.ok(HTML.indexOf('src="ai-writing.js"') > HTML.indexOf('src="lab-builder-drafts.js"'), "loaded after the wizard and drafts scripts");
});

test("the control is plain: US English, no emoji, labelled, keyboard reachable, 44px targets, its own CSS block before print", () => {
  const text = `${CARD}\n${SCRIPT}`;
  assert.doesNotMatch(text, /\p{Extended_Pictographic}/u);
  assert.doesNotMatch(text, /\b(colour|behaviour|centre|licence|organis|catalogue|favourite|customis)\w*/i);
  assert.match(CARD, /<label class="lb-ai-label" for="lb-ai-enabled">/);
  assert.match(CARD, /Write with AI \(optional\)/);
  assert.match(CARD, /<label for="lb-ai-model">AI model<\/label>/);
  assert.match(CARD, /<fieldset class="lb-ai-scope"[^>]*>\s*<legend/);
  assert.match(CARD, /id="lb-ai-status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(CARD, /id="lb-ai-error"[^>]*role="alert"/);
  assert.match(CARD, /<button type="button" class="btn lb-ai-signin"/);
  const start = HTML.indexOf("/* ── AI writing (optional, Review and build)");
  const end = HTML.indexOf(".lb-sharepoint-site-card {", start);
  const css = HTML.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.ok(start < HTML.indexOf("@media print"), "screen CSS sits before the print block");
  assert.match(css, /\.lb-ai-card select \{[^}]*min-height: 44px/);
  assert.match(css, /\.lb-ai-card \.lb-ai-label \{[^}]*min-height: 44px/);
  assert.match(css, /\.lb-ai-scope-item \{[^}]*min-height: 44px/);
  assert.match(css, /\.lb-ai-signin \{[^}]*min-height: 44px/);
  assert.doesNotMatch(css, /border-(left|right)\s*:\s*([2-9]|\d{2,})px/, "no side stripe");
  assert.doesNotMatch(css, /border-(left|right)-width\s*:\s*([2-9]|\d{2,})px/);
  assert.match(css, /var\(--border-strong\)/, "uses the theme variables, so light and dark both work");
});
