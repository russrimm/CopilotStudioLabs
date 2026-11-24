/**
 * Screenshot Center UI, "Finish your lab" checklist, and capture-on-build tests.
 * The real browser scripts run inside node:vm against a small fake DOM, with a fake
 * fetch, a fake EventSource, and fake timers, so nothing touches a network or a browser.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import vm from "node:vm";

import { createFakeDom } from "./fixtures/fake-dom.js";

const publicFile = (name) => readFileSync(new URL(`../public/${name}`, import.meta.url), "utf8");
const CENTER_SOURCES = ["screenshot-center-core.js", "screenshot-center-command.js", "screenshot-center-jobs.js", "screenshot-center-keep.js", "screenshot-center-wrong.js", "screenshot-center-pictures.js", "screenshot-center.js", "lab-checklist.js"].map(publicFile);
const GENERATED_LABS_SOURCE = publicFile("generated-labs.js");
const INDEX_HTML = publicFile("index.html");
const APP_SOURCE = publicFile("app.js");

const LAB = "lab-test-1";
const NOW = Date.parse("2026-06-01T12:00:00.000Z");
const json = (value) => JSON.parse(JSON.stringify(value));

// ── Fixtures ────────────────────────────────────────────────────────────────

function shot(overrides = {}) {
  return {
    id: 1,
    shotId: "shot-1",
    moduleOrder: 1,
    stepLabel: "Step 1",
    featureId: "mod-a",
    moduleTitle: "Create an agent",
    product: "copilot-studio",
    figure: "1.1",
    kind: "ui-location",
    filename: "agent-home.png",
    alt: "The Copilot Studio agents page with the Create button highlighted",
    caption: "Agents page",
    instructions: ["Open Copilot Studio", "Select Agents"],
    manual: false,
    captured: false,
    stale: false,
    needsReview: false,
    checkState: "not-checked",
    lastAttemptStatus: null,
    lastError: null,
    verification: null,
    capturedAt: null,
    captureSource: null,
    ...overrides,
  };
}

function stateFor(shots, { lastRevalidatedAt = null, checkState } = {}) {
  const captured = shots.filter((s) => s.captured).length;
  const stale = shots.filter((s) => s.stale).length;
  const needsReview = shots.filter((s) => s.needsReview).length;
  const cs = checkState || (stale ? "docs-updated" : lastRevalidatedAt ? "up-to-date" : "not-checked");
  const features = [...new Set(shots.map((s) => s.featureId))];
  const modules = features.map((featureId, i) => {
    const first = shots.find((s) => s.featureId === featureId);
    return {
      featureId,
      moduleOrder: i + 1,
      stepLabel: first.stepLabel,
      moduleTitle: first.moduleTitle,
      checkState: cs,
      status: cs === "docs-updated" ? "docs-updated" : "up-to-date",
      primaryUrl: "https://learn.microsoft.com/en-us/microsoft-copilot-studio/fundamentals-get-started",
      diff: null,
    };
  });
  return {
    labId: LAB,
    title: "Test lab",
    checkState: cs,
    lastRevalidatedAt,
    cliCommand: `node tools/screenshot-capture/capture.js --generated-lab=${LAB} --headed`,
    summary: {
      total: shots.length,
      captured,
      missing: shots.length - captured,
      stale,
      needsReview,
      upToDate: captured - stale,
      docsUpdatedModules: stale ? 1 : 0,
      learnSyncStatus: stale ? "docs-updated" : shots.length - captured ? "missing-screenshot" : "up-to-date",
      checkState: cs,
      lastRevalidatedAt,
    },
    modules,
    shots,
  };
}

const captured = (name, extra = {}) =>
  shot({ filename: name, captured: true, capturedAt: "2026-06-01T11:00:00.000Z", captureSource: "companion", ...extra });

function mixedState() {
  return stateFor([
    captured("agent-home.png", { figure: "1.1", caption: "Agents page" }),
    shot({ filename: "create-agent.png", figure: "1.2", caption: "Create an agent", id: 2 }),
    captured("agent-topics.png", { figure: "2.1", caption: "Topics list", featureId: "mod-b", moduleTitle: "Add topics", stepLabel: "Step 2", stale: true, id: 3 }),
    shot({
      filename: "agent-test.png",
      figure: "2.2",
      caption: "Test panel",
      featureId: "mod-b",
      moduleTitle: "Add topics",
      stepLabel: "Step 2",
      id: 4,
      needsReview: true,
      verification: {
        level: "warn",
        state: "needs-review",
        reasons: [{ code: "labels-missing", level: "warn", message: "raw server text" }, { code: "near-uniform", level: "warn", message: "raw" }],
        labels: { expected: 3, matched: 1 },
      },
    }),
    shot({ filename: "agent-publish.png", figure: "2.3", caption: "Publish", featureId: "mod-b", moduleTitle: "Add topics", stepLabel: "Step 2", id: 5, lastAttemptStatus: "auth-required" }),
    shot({ filename: "agent-sharepoint.png", figure: "2.4", caption: "SharePoint site", featureId: "mod-b", moduleTitle: "Add topics", stepLabel: "Step 2", id: 6, manual: true }),
  ]);
}

function device(overrides = {}) {
  return { id: "dev_0123456789ab", name: "Ada PC", platform: "win32", connected: true, busy: false, lastSeenAt: new Date(NOW - 5000).toISOString(), signedInProducts: [], ...overrides };
}

function statusPayload({ devices = [], signedIn = [], tenantSet = false, persistent = true } = {}) {
  const connected = devices.filter((d) => d.connected);
  return {
    companion: {
      connected: connected.length > 0,
      lastSeenAt: connected.length ? new Date(NOW).toISOString() : null,
      connectedCount: connected.length,
      deviceCount: devices.length,
      busy: false,
      signedInProducts: signedIn,
      devices,
      downloadUrl: "/api/capture/companion.zip",
      onlineWindowSec: 90,
    },
    serverBrowser: { available: false },
    tenantUrls: { set: tenantSet, names: tenantSet ? ["CAPTURE_SHAREPOINT_SITE_URL"] : [] },
    sharedLibrary: { location: persistent ? "persistent" : "baked", persistent, total: 325, captured: 12, missing: 313, needsReview: 1 },
    jobs: { queued: 0, active: 0 },
    pairing: { codeTtlSec: 600 },
    limits: { maxUploadBytes: 8 * 1024 * 1024, acceptedTypes: ["image/png", "image/jpeg", "image/webp"] },
  };
}

function jobFor(shots, overrides = {}) {
  const rows = shots.map((s) => ({ filename: s.filename, status: "pending", attempts: 0 }));
  return {
    id: "job_0123456789abcdef",
    status: "queued",
    createdAt: new Date(NOW).toISOString(),
    startedAt: null,
    cancelRequested: false,
    target: { type: "lab", labId: LAB },
    claim: null,
    error: null,
    shots: rows,
    events: [],
    progress: { total: rows.length, done: 0, captured: 0, needsReview: 0, failed: 0, manual: 0, skipped: 0, running: 0, pending: rows.length, percent: 0 },
    ...overrides,
  };
}

function pngFile(name = "pasted.png", type = "image/png", size = 12000) {
  return new File([new Uint8Array(size)], name, { type });
}

// ── Harness ─────────────────────────────────────────────────────────────────

function makeHarness({ eventSource = true, generated = false, buildStep = true } = {}) {
  const { document, FakeEvent } = createFakeDom();
  const body = document.body;
  const add = (parent, tag, { id, attrs = {}, text } = {}) => {
    const el = document.createElement(tag);
    if (id) el.id = id;
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    if (text) el.textContent = text;
    parent.appendChild(el);
    return el;
  };
  const meta = add(body, "div", { id: "lb-result-meta" });
  const actions = add(meta, "div", { attrs: { class: "lb-result-actions" } });
  const downloadBtn = add(actions, "button", { text: "Download" });
  add(body, "div", { id: "lb-result-checklist" });
  const host = add(body, "div", { id: "lb-result-screenshots" });
  const preview = add(body, "div", { id: "lb-result-preview" });
  add(body, "div", { id: "lb-generated-list" });
  add(body, "input", { id: "bp-copilotStudioUrl" });
  let buildEls = null;
  if (buildStep) {
    const pane = add(body, "div", { id: "lb-pane-4" });
    const label = add(pane, "label", { id: "lb-capture-on-build-label", attrs: { hidden: "" } });
    const box = add(label, "input", { id: "lb-capture-on-build", attrs: { type: "checkbox", disabled: "" } });
    const status = add(pane, "p", { id: "lb-capture-on-build-status" });
    const setup = add(pane, "button", { id: "lb-capture-on-build-setup", attrs: { hidden: "" } });
    const pairing = add(pane, "div", { id: "lb-capture-on-build-pairing", attrs: { "data-sc-pairing-host": "build" } });
    buildEls = { pane, label, box, status, setup, pairing };
  }

  const clock = { now: NOW, seq: 1, timers: new Map() };
  const addTimer = (fn, ms, every) => {
    const id = clock.seq++;
    clock.timers.set(id, { fn, at: clock.now + ms, every });
    return { id, unref() {} };
  };
  const advance = (ms) => {
    const target = clock.now + ms;
    for (;;) {
      let next = null;
      for (const [id, t] of clock.timers) if (t.at <= target && (!next || t.at < next.t.at)) next = { id, t };
      if (!next) break;
      clock.now = next.t.at;
      if (next.t.every) next.t.at += next.t.every;
      else clock.timers.delete(next.id);
      next.t.fn();
    }
    clock.now = target;
  };
  class FakeDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(clock.now);
      else super(...args);
    }

    static now() {
      return clock.now;
    }
  }
  class FakeURL extends URL {
    static created = [];
    static revoked = [];
    static createObjectURL(file) {
      FakeURL.created.push(file);
      return `blob:fake/${FakeURL.created.length}`;
    }

    static revokeObjectURL(url) {
      FakeURL.revoked.push(url);
    }
  }
  class FakeEventSource {
    static instances = [];
    constructor(url) {
      this.url = url;
      this.closed = false;
      this.handlers = {};
      this.onerror = null;
      FakeEventSource.instances.push(this);
    }

    addEventListener(type, fn) {
      (this.handlers[type] ||= []).push(fn);
    }

    close() {
      this.closed = true;
    }

    emit(type, payload) {
      for (const fn of this.handlers[type] || []) fn({ data: JSON.stringify(payload) });
    }
  }

  const h = {
    document,
    host,
    preview,
    downloadBtn,
    buildStep: buildEls,
    FakeEvent,
    FakeEventSource,
    FakeURL,
    advance,
    clock,
    calls: [],
    routes: [],
    status: statusPayload(),
    brand: { customized: false },
    activeJobs: [],
    copied: [],
    clipboardItems: [],
    spies: { preview: [], list: 0, tabs: [] },
  };
  h.route = (method, pattern, reply) => h.routes.unshift([method, pattern, reply]);
  const fetchImpl = async (url, init = {}) => {
    const method = String(init.method || "GET").toUpperCase();
    let parsed = null;
    if (typeof init.body === "string") {
      try {
        parsed = JSON.parse(init.body);
      } catch {
        parsed = init.body;
      }
    }
    h.calls.push({ method, url: String(url), body: parsed, init });
    let reply = null;
    for (const [m, pattern, handler] of h.routes) {
      if (m === method && pattern.test(String(url))) {
        reply = typeof handler === "function" ? await handler(String(url), init) : handler;
        break;
      }
    }
    if (!reply) {
      if (method === "GET" && /\/api\/capture\/status$/.test(url)) reply = { status: 200, body: h.status };
      else if (method === "GET" && /\/customization$/.test(url)) reply = { status: 200, body: h.brand };
      else if (method === "GET" && /\/api\/capture\/jobs\?labId=/.test(url)) reply = { status: 200, body: { jobs: h.activeJobs } };
      else reply = { status: 404, body: { error: `No route for ${method} ${url}` } };
    }
    if (reply.throws) throw new Error(reply.throws);
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => reply.body ?? {} };
  };

  const storage = new Map();
  const windowListeners = {};
  const context = {
    document,
    window: { addEventListener: (type, fn) => (windowListeners[type] ||= []).push(fn) },
    fetch: fetchImpl,
    EventSource: eventSource ? FakeEventSource : undefined,
    setTimeout: (fn, ms) => addTimer(fn, ms, 0),
    clearTimeout: (handle) => handle && clock.timers.delete(handle.id),
    setInterval: (fn, ms) => addTimer(fn, ms, ms),
    clearInterval: (handle) => handle && clock.timers.delete(handle.id),
    Date: FakeDate,
    URL: FakeURL,
    File,
    Blob,
    navigator: {
      clipboard: {
        writeText: async (text) => {
          h.copied.push(text);
        },
        read: async () => h.clipboardItems,
      },
    },
    localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)) },
    console,
    CSS: { escape: (s) => String(s) },
    labBuilder: {
      products: [
        { id: "copilot-studio", shortName: "Copilot Studio" },
        { id: "sharepoint-ai", shortName: "SharePoint AI" },
      ],
      industries: [],
      levels: [],
      harnesses: [],
      editing: null,
    },
    escapeHtml: (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]),
    toast() {},
    lbFormatMinutes: (m) => `${m} min`,
    lbLoadSelections: async () => {},
    lbLoadResultPreview: async (labId) => {
      h.spies.preview.push(labId);
    },
    lbLoadGenerated: async () => {
      h.spies.list += 1;
    },
    setActiveTab: (tab) => h.spies.tabs.push(tab),
  };
  if (!generated) context.lbGen = { opened: LAB, labs: [], loaded: true };
  vm.createContext(context);
  if (generated) vm.runInContext(GENERATED_LABS_SOURCE, context);
  for (const source of CENTER_SOURCES) vm.runInContext(source, context);
  if (generated) vm.runInContext(`lbGen.opened = "${LAB}"`, context);

  h.run = (code) => vm.runInContext(code, context);
  h.setStatus = async (payload) => {
    h.status = payload;
    await h.run("scLoadStatus")(true);
  };
  h.windowListeners = windowListeners;
  h.flush = async (rounds = 6) => {
    for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  h.render = async (state, { outcome = null, labId = LAB } = {}) => {
    h.run("scRenderCenter")(host, labId, state, outcome);
    await h.flush();
    return h;
  };
  h.center = () => host.querySelector("[data-sc-root]");
  h.text = (selector) => host.querySelector(selector)?.textContent ?? null;
  h.action = (name, root = host) => root.querySelector(`[data-sc-action="${name}"]`);
  h.card = (filename) => host.querySelectorAll(".sc-card").find((c) => c.dataset.filename === filename) || null;
  h.cardAction = (filename, name) => h.card(filename)?.querySelector(`[data-sc-action="${name}"]`) || null;
  h.step = (id) => host.querySelector(`.sc-step[data-step="${id}"]`);
  h.live = () => host.querySelector("#lb-screenshots-live")?.textContent.replace(/\u00a0/g, "").trim() ?? "";
  h.callsTo = (method, pattern) => h.calls.filter((c) => c.method === method && pattern.test(c.url));
  h.click = async (el) => {
    assert.ok(el, "element to click must exist");
    el.click();
    await h.flush();
  };
  h.event = (type, init) => new FakeEvent(type, init);
  return h;
}

// ── Pure decisions ──────────────────────────────────────────────────────────

test("check state is honest: nothing checked is never reported as up to date", () => {
  const h = makeHarness();
  const check = (state) => h.run("scCheckStateOf")(state);
  assert.equal(check({}), "not-checked");
  assert.equal(check({ summary: { learnSyncStatus: "up-to-date", total: 2, captured: 2 } }), "not-checked");
  assert.equal(check({ lastRevalidatedAt: "2026-05-01T00:00:00.000Z", summary: {} }), "up-to-date");
  assert.equal(check({ summary: { stale: 2 } }), "docs-updated");
  assert.equal(check({ checkState: "not-checked", lastRevalidatedAt: "2026-05-01T00:00:00.000Z" }), "not-checked");
  assert.equal(check({ checkState: "up-to-date" }), "up-to-date");
  assert.equal(h.run("scCheckLabel")("not-checked"), "Not checked yet");
  assert.equal(h.run("scCheckLabel")("up-to-date"), "Up to date");
  assert.equal(h.run("scCheckLabel")("docs-updated", 2), "2 modules changed");
  assert.equal(h.run("scCheckTone")("not-checked"), "neutral");
});

test("the primary action adapts to the state, one action at a time", () => {
  const h = makeHarness();
  const primary = (counts, extra = {}) => json(h.run("scPrimaryAction")({ counts: { total: 6, toCapture: 0, outdated: 0, needsReview: 0, manual: 0, ...counts }, checkState: "up-to-date", connected: true, ...extra }));
  assert.deepEqual([primary({ toCapture: 3 }, { connected: false }).action, primary({ toCapture: 3 }, { connected: false }).label], ["connect", "Connect your computer"]);
  assert.equal(primary({ outdated: 2 }, { connected: false }).action, "connect");
  assert.deepEqual([primary({ toCapture: 3 }).action, primary({ toCapture: 3 }).label], ["capture-missing", "Capture 3 missing screenshots"]);
  assert.equal(primary({ toCapture: 1 }).label, "Capture 1 missing screenshot");
  assert.deepEqual([primary({ outdated: 2 }).action, primary({ outdated: 2 }).label], ["capture-stale", "Retake 2 outdated screenshots"]);
  assert.equal(primary({ needsReview: 1 }).label, "Review 1 screenshot");
  assert.equal(primary({ manual: 2 }).action, "manual");
  assert.deepEqual([primary({}, { checkState: "not-checked" }).action, primary({}, { checkState: "not-checked" }).label], ["check", "Check against Microsoft Learn"]);
  assert.equal(primary({}, { checkState: "not-checked", connected: false }).action, "check");
  assert.equal(primary({}, { checkState: "docs-updated" }).action, "update");
  const done = primary({});
  assert.deepEqual([done.action, done.label, done.disabled], ["done", "All screenshots up to date", true]);
  assert.equal(primary({ toCapture: 3 }, { job: { status: "running" } }).action, "busy");
  assert.equal(primary({ toCapture: 3 }, { connected: false, statusLoading: true }).action, "wait");
});

// ── One screenshot count, one wording ───────────────────────────────────────

const twentyEightSlots = () =>
  stateFor(Array.from({ length: 28 }, (_, i) => (i === 0 ? captured("slot-1.png", { id: 1, figure: "1.1", imageSource: "library" }) : shot({ filename: `slot-${i + 1}.png`, id: i + 1, figure: `1.${i + 1}` }))));

/** The result panel shown right after a build, rendered by the real lbShowResult from app.js. Returns the pills' HTML. */
function renderBuildResult(manifest) {
  const nodes = { "lb-result-panel": { style: {}, scrollIntoView() {} }, "lb-result-meta": { innerHTML: "" }, "lb-result-body": { innerHTML: "" } };
  const context = {
    document: { getElementById: (id) => nodes[id] || null },
    labBuilder: {},
    escapeHtml: (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]),
    lbLoadResultPreview() {},
    console,
  };
  vm.createContext(context);
  vm.runInContext(CENTER_SOURCES[0], context);
  vm.runInContext(APP_SOURCE.slice(APP_SOURCE.indexOf("function lbQualityPanel"), APP_SOURCE.indexOf("async function lbLoadResultPreview")), context);
  context.lbShowResult({
    labId: LAB,
    title: "Contoso lab",
    difficulty: "Intermediate",
    duration: "about 2 hours",
    markdown: "# Contoso lab",
    warnings: [],
    validation: { passed: 12, failed: 0 },
    manifest: { level: 200, grounding: { groundedModules: 4, totalModules: 5 }, prerequisites: [], screenshots: { total: 0, reused: 0, captured: 0, pending: 0 }, ...manifest },
  });
  return nodes["lb-result-meta"].innerHTML;
}

test("the screenshot count is one function: 'N of M captured', and a reused picture counts as captured", () => {
  const h = makeHarness();
  const progress = (source) => json(h.run("scCaptureProgress")(source));
  assert.deepEqual(progress({ total: 28, captured: 0, missing: 28 }), { total: 28, captured: 0, pending: 28, reused: 0, complete: false, text: "0 of 28 captured", detail: "0 of 28 captured" }, "none captured");
  assert.equal(progress({ total: 28, captured: 5, missing: 23 }).text, "5 of 28 captured", "some captured");
  // The saved-lab list keeps reused pictures out of `captured`, but they are still pictures in their slots.
  assert.equal(progress({ total: 28, captured: 0, pending: 27, stale: 0 }).text, "1 of 28 captured", "a reused picture counts");
  const manifest = progress({ reused: 1, captured: 0, pending: 27, toCapture: 27, total: 28 });
  assert.deepEqual([manifest.text, manifest.detail, manifest.reused], ["1 of 28 captured", "1 of 28 captured (1 reused)", 1], "reused is only a secondary phrase");
  assert.equal(progress({ reused: 2, toCapture: 26, total: 28 }).text, "2 of 28 captured", "an older manifest that only has toCapture");
  const one = progress({ total: 1, captured: 1, pending: 0 });
  assert.deepEqual([one.text, one.complete], ["1 of 1 captured", true], "one of one");
  assert.equal(progress({ total: 1, captured: 0, missing: 1 }).text, "0 of 1 captured");
  for (const none of [{}, { total: 0 }, null, undefined]) {
    const empty = progress(none);
    assert.deepEqual([empty.total, empty.captured, empty.pending, empty.complete, empty.text], [0, 0, 0, false, "No screenshots"], "zero slots");
  }
  // The Screenshot Center's own counts carry `toCapture`, which is not the same as "no picture": `captured` decides there.
  assert.equal(progress({ total: 3, captured: 2, toCapture: 1, manual: 0, outdated: 1 }).text, "2 of 3 captured");
  assert.equal(progress({ total: 2, captured: 5 }).text, "2 of 2 captured", "never more pictures than slots");
  assert.equal(progress({ total: 2, pending: 9 }).text, "0 of 2 captured");
  assert.equal(progress({ total: 2, captured: 1, reused: 5 }).reused, 1, "reused pictures are part of captured");
});

test("the lab card, its Learn badge, the Screenshot Center, Finish your lab, and the build result all say '1 of 28 captured' for the same lab", async () => {
  const state = twentyEightSlots();
  const COUNT = "1 of 28 captured";
  // What the server lists for this lab: `captured` leaves out the one reused picture, and `pending` is every slot with no picture.
  const lab = {
    labId: LAB,
    title: "Test lab",
    generatedAt: "2026-05-01T10:00:00.000Z",
    totalMinutes: 60,
    moduleCount: 2,
    selections: null,
    screenshots: { total: 28, captured: 0, pending: 27, stale: 0, learnSyncStatus: "missing-screenshot", checkState: "up-to-date" },
    learnDrift: { status: "missing-screenshot", lastCheckedAt: "2026-05-02T10:00:00.000Z", driftedModuleCount: 0, driftedModules: [], missingScreenshotCount: 27, moduleCount: 2 },
  };
  const h = makeHarness({ generated: true });
  h.run(`lbGen.labs = [${JSON.stringify(lab)}]`);

  assert.match(h.run("lbGenItemHtml")(lab), /<li>Screenshots: 1 of 28 captured<\/li>/, "the lab card");
  assert.match(h.run("lbRenderLabCardDriftHtml")(lab, "Test lab"), /Microsoft Learn up to date · 1 of 28 captured/, "the Learn badge on the card");
  const listed = json(h.run("lbChecklistItems")(h.run("lbChecklistInputFromListLab")(lab))).find((i) => i.id === "screenshots");
  assert.ok(listed.detail.startsWith(`${COUNT}. 27 pending.`), `Finish your lab from the list data: ${listed.detail}`);

  await h.setStatus(statusPayload({ devices: [device()] }));
  await h.render(state);
  await h.flush();
  assert.equal(h.center().querySelector(".sc-pills .sc-chip").textContent, COUNT, "the Screenshot Center header");
  assert.doesNotMatch(h.text(".sc-header"), /screenshots captured|reused/);
  const opened = h.document.getElementById("lb-result-checklist").querySelector('[data-item="screenshots"] .lb-check-detail').textContent;
  assert.ok(opened.startsWith(`${COUNT}. 27 pending.`), `Finish your lab above an opened lab: ${opened}`);

  // Opening the lab syncs the card from the live state; the count it shows must not change.
  h.run("lbSyncSingleLabDriftFromState")(LAB, state);
  assert.match(h.run("lbGenItemHtml")(h.run("lbGen.labs[0]")), /<li>Screenshots: 1 of 28 captured<\/li>/, "the card after the Screenshot Center synced it");

  const result = renderBuildResult({ screenshots: { reused: 1, captured: 0, pending: 27, toCapture: 27, total: 28 } });
  assert.match(result, /<span class="scenario-pill">Screenshots: 1 of 28 captured \(1 reused\)<\/span>/, "the build result");
  assert.doesNotMatch(result, /screenshots? reused|screenshots pending/);
});

test("counts in the build result and on the lab card use the right singular and plural, and the portal says refresher and checked against Microsoft Learn", () => {
  const one = renderBuildResult({ prerequisites: [{}], grounding: { groundedModules: 1, totalModules: 1 }, screenshots: { reused: 1, captured: 0, pending: 0, total: 1 } });
  assert.match(one, />1 refresher</);
  assert.match(one, />1 of 1 module checked against Microsoft Learn</);
  assert.match(one, />Screenshots: 1 of 1 captured \(1 reused\)</, "never '1 screenshots reused'");
  const many = renderBuildResult({ prerequisites: [{}, {}], grounding: { groundedModules: 3, totalModules: 5 }, screenshots: { reused: 0, captured: 2, pending: 3, total: 5 } });
  assert.match(many, />2 refreshers</);
  assert.match(many, />3 of 5 modules checked against Microsoft Learn</);
  assert.match(many, />Screenshots: 2 of 5 captured</);
  assert.doesNotMatch(`${one}${many}`, /recap|grounded|screenshots? (reused|pending)/i);
  assert.match(renderBuildResult({}), />No screenshots to capture</, "a lab with no screenshots says so");

  const h = makeHarness({ generated: true });
  const card = (extra) => h.run("lbGenItemHtml")({ labId: LAB, title: "T", generatedAt: "2026-05-01T10:00:00.000Z", totalMinutes: 60, ...extra });
  assert.match(card({ moduleCount: 3, prerequisiteCount: 1 }), /<li>2 topics<\/li><li>1 refresher<\/li>/);
  assert.match(card({ moduleCount: 5, prerequisiteCount: 2 }), /<li>3 topics<\/li><li>2 refreshers<\/li>/);
  assert.doesNotMatch(card({ moduleCount: 5, prerequisiteCount: 2 }), /recap/i);

  const detail = (shots) => json(h.run("lbChecklistItems")({ shots, check: { state: "up-to-date" } })).find((i) => i.id === "screenshots").detail;
  assert.equal(detail({ total: 1, captured: 1, toCapture: 0 }), "1 of 1 captured. Nothing is left to capture.", "no 'All 1 screenshots are in place'");
  assert.equal(detail({ total: 4, captured: 4, toCapture: 0 }), "4 of 4 captured. Nothing is left to capture.");
});

test("the portal shows a lab's module labels as Part and Refresher, and the lab's own labels stay Step and Recap", async () => {
  const h = makeHarness();
  const label = (value) => h.run("scModuleLabel")(value);
  assert.deepEqual(["Step 3", "step 12", "Recap 1", "Recap 02", "Step 2 - Add topics"].map(label), ["Part 3", "Part 12", "Refresher 1", "Refresher 02", "Part 2 - Add topics"]);
  assert.deepEqual(["Stepwise", "Recap", "Overview", "", null, undefined].map(label), ["Stepwise", "Recap", "Overview", "", "", ""], "only a numbered Step or Recap is mapped");
  assert.deepEqual(json(h.run("scGroupShots")(mixedState())).map((g) => g.stepLabel), ["Step 1", "Step 2"], "the data keeps the lab's own labels");

  await h.setStatus(statusPayload({ devices: [device()] }));
  await h.render(mixedState());
  assert.doesNotMatch(h.center().textContent, /\b(?:Step|Recap) \d/, "the Screenshot Center never shows a lab's Step N or Recap N");
  assert.match(h.center().textContent, /Part 2 \u00b7 Add topics/);
});

test("verification feedback is plain language, never raw codes", () => {
  const h = makeHarness();
  const summary = json(
    h.run("scVerificationSummary")({
      level: "warn",
      reasons: [
        { code: "labels-missing", level: "warn", message: "raw" },
        { code: "sign-in-page", level: "fail", message: "raw" },
        { code: "blank", level: "fail", message: "raw" },
        { code: "something-new", level: "warn", message: "A brand new check said this." },
      ],
      labels: { expected: 4, matched: 1 },
      redaction: { applied: true, masked: 2 },
    }),
  );
  assert.equal(summary.level, "fail");
  assert.equal(summary.headline, "This image cannot be used.");
  const texts = summary.items.map((i) => i.text);
  assert.ok(texts.includes("This looks like the Microsoft sign-in page, not the product."));
  assert.ok(texts.includes("Only 1 of 4 expected labels are visible. Check that this is the screen the lab describes."));
  assert.ok(texts.includes("A brand new check said this."));
  assert.ok(summary.items[0].level === "fail", "failures come first");
  assert.ok(!texts.includes("Account details were hidden before the picture was taken."), "no good news next to a failure");
  const clean = json(h.run("scVerificationSummary")({ level: "warn", reasons: [{ code: "near-uniform", level: "warn" }], redaction: { applied: true, masked: 2 } }));
  assert.ok(clean.items.some((i) => i.level === "pass" && /Account details were hidden/.test(i.text)), "a redaction pass is reported as good news");
  for (const code of ["bad-filename", "bad-signature", "extension-mismatch", "empty", "too-large", "too-small", "corrupt", "truncated", "trailing-data", "embedded-markup", "dimensions-small", "dimensions-large", "near-uniform", "not-analyzed", "not-a-web-page", "not-redacted", "no-page-address", "no-evidence"]) {
    const text = h.run("scReasonText")({ code, level: "warn", message: "RAW" });
    assert.notEqual(text, "RAW", `${code} must be mapped to a plain sentence`);
    if (code.includes("-")) assert.ok(!text.includes(code), `${code} must not leak into the sentence`);
  }
  assert.equal(json(h.run("scVerificationSummary")(null)).level, "none");
  assert.equal(json(h.run("scVerificationSummary")({ level: "pass", reasons: [] })).headline, "This image passed every check.");
});

test("client-side file checks mirror the server limits", () => {
  const h = makeHarness();
  const check = (file, limits) => json(h.run("scValidateImageFile")(file, limits));
  assert.equal(check(pngFile()).ok, true);
  assert.equal(check(pngFile("a.webp", "image/webp")).ok, true);
  assert.match(check(pngFile("a.svg", "image/svg+xml")).message, /PNG, JPEG, or WebP/);
  assert.match(check(pngFile("a.png", "image/png", 0)).message, /empty/);
  assert.match(check(pngFile("a.png", "image/png", 3000), { maxUploadBytes: 2048, acceptedTypes: ["image/png"] }).message, /limit is 0 MB|limit is/);
  assert.equal(check(pngFile("a.png", "image/png", 3000), { maxUploadBytes: 4096, acceptedTypes: ["image/png"] }).ok, true);
  assert.match(h.run("scUploadErrorText")(413, {}), /larger than 8 MB/);
  assert.match(h.run("scUploadErrorText")(415, {}), /not supported/);
  assert.match(h.run("scUploadErrorText")(404, {}), /no longer exists/);
});

test("links and image addresses are validated before they reach the DOM", () => {
  const h = makeHarness();
  const run = h.run;
  assert.equal(run("scSafeHttpsUrl")("https://learn.microsoft.com/en-us/x"), "https://learn.microsoft.com/en-us/x");
  for (const bad of ["javascript:alert(1)", "http://learn.microsoft.com/x", "https://user:pw@learn.microsoft.com/x", "data:text/html,hi", "https://a.com/<script>", "", null, "//evil.example"]) {
    assert.equal(run("scSafeHttpsUrl")(bad), "", `must reject ${bad}`);
  }
  assert.equal(run("scSafeLearnUrl")("https://example.com/x"), "");
  assert.equal(run("scAssetUrl")("lab-a", "x.png", "v1"), "/api/lab-builder/generated/lab-a/assets/x.png?v=v1");
  assert.equal(run("scAssetUrl")("lab-a", "../x.png"), "");
  assert.equal(run("scAssetUrl")("lab/../a", "x.png"), "");
  assert.equal(run("scSafePortalPath")("https://evil.example/zip", "/api/capture/companion.zip"), "/api/capture/companion.zip");
  assert.equal(run("scSafePortalPath")("/api/capture/companion.zip", "/x"), "/api/capture/companion.zip");
});

test("a job is described in words a person can act on", () => {
  const h = makeHarness();
  const describe = (job, ctx) => json(h.run("scDescribeJob")(job, { nowMs: NOW, ...ctx }));
  const base = jobFor([shot({ filename: "a.png" }), shot({ filename: "b.png" })]);
  assert.equal(describe(base, { companionConnected: true }).phase, "queued");
  const offline = describe(base, { companionConnected: false });
  assert.equal(offline.phase, "queued-offline");
  assert.match(offline.headline, /Waiting for your computer/);
  const running = {
    ...base,
    status: "running",
    claim: { lastActivityAt: new Date(NOW - 1000).toISOString() },
    shots: [{ filename: "a.png", status: "captured" }, { filename: "b.png", status: "running" }],
    progress: { total: 2, done: 1, captured: 1, needsReview: 0, failed: 0, manual: 0, running: 1, pending: 0, percent: 50 },
  };
  const view = describe(running, { companionConnected: true });
  assert.equal(view.phase, "running");
  assert.equal(view.currentFilename, "b.png");
  assert.equal(view.percent, 50);
  const stale = { ...running, claim: { lastActivityAt: new Date(NOW - 5 * 60 * 1000).toISOString() } };
  assert.equal(describe(stale, {}).phase, "offline");
  assert.match(describe(stale, {}).headline, /stopped responding/);
  const auth = { ...running, shots: [{ filename: "a.png", status: "auth-required" }, { filename: "b.png", status: "pending" }] };
  assert.equal(describe(auth, {}).phase, "auth-required");
  assert.equal(describe({ ...running, cancelRequested: true }, {}).phase, "cancelling");
  const done = describe({ ...running, status: "done", shots: [{ filename: "a.png", status: "captured" }, { filename: "b.png", status: "needs-review" }], progress: { total: 2, done: 2, captured: 1, needsReview: 1, failed: 0, manual: 0, running: 0, pending: 0, percent: 100 } }, {});
  assert.equal(done.phase, "done");
  assert.match(done.detail, /1 captured, 1 need review/);
  const merged = json(
    h.run("scMergeJobUpdate")(running, { job: { id: running.id, status: "running", progress: { total: 2, done: 2, captured: 2, needsReview: 0, failed: 0, running: 0, pending: 0, percent: 100 } }, event: { type: "shot-captured", message: "b.png: Captured and verified." } }),
  );
  assert.equal(merged.shots.find((s) => s.filename === "b.png").status, "captured");
  assert.equal(merged.progress.percent, 100);
  assert.equal(merged.events.length, 1);
});

test("a build that queued a capture, or could not, is explained", () => {
  const h = makeHarness();
  const outcome = (data) => json(h.run("scBuildCaptureOutcome")(data));
  const queued = outcome({ captureQueued: true, captureJobId: "job_0123456789abcdef", screenshotCapture: { status: "queued" } });
  assert.equal(queued.jobId, "job_0123456789abcdef");
  assert.match(queued.message, /being captured on your computer/);
  const none = outcome({ captureQueued: false, captureReason: "no-companion", screenshotCapture: {} });
  assert.match(none.message, /not connected/);
  assert.equal(none.variant, "warn");
  assert.equal(outcome({ captureQueued: false, captureReason: null }), null);
  assert.equal(outcome({ captureQueued: true, captureJobId: "../../etc" }), null);
});

// ── The panel: honest state, plain language, one primary action ─────────────

test("a lab nobody has checked shows 'Not checked yet', never a green 'up to date'", async () => {
  const h = makeHarness();
  await h.render(stateFor([captured("a.png"), captured("b.png")]));
  const header = h.text(".sc-header");
  assert.match(header, /Microsoft Learn: Not checked yet/);
  const learnChip = h.center().querySelector(".sc-header .sc-chip-learn");
  assert.ok(learnChip.classList.contains("sc-chip-neutral"), "not checked is neutral, not success");
  for (const ok of h.center().querySelectorAll(".sc-chip-ok")) assert.doesNotMatch(ok.textContent, /Learn/, "no green Microsoft Learn chip");
  assert.doesNotMatch(h.center().textContent, /MS Learn Up to Date|Learn Up to Date/i);
  const moduleChip = h.center().querySelector(".sc-module .sc-chip-learn");
  assert.match(moduleChip.textContent, /Not checked yet/);
  assert.ok(moduleChip.classList.contains("sc-chip-neutral"));
  assert.equal(h.center().querySelector(".sc-primary-btn").textContent, "Check against Microsoft Learn");

  const checked = makeHarness();
  await checked.render(stateFor([captured("a.png")], { lastRevalidatedAt: "2026-05-30T10:00:00.000Z" }));
  assert.match(checked.text(".sc-header"), /Microsoft Learn: Up to date/);
  assert.ok(checked.center().querySelector(".sc-header .sc-chip-learn").classList.contains("sc-chip-ok"));
  const primary = checked.center().querySelector(".sc-primary-btn");
  assert.equal(primary.textContent, "All screenshots up to date");
  assert.equal(primary.disabled, true);

  const drifted = makeHarness();
  await drifted.render(mixedState());
  assert.match(drifted.text(".sc-header"), /Microsoft Learn: 1 module changed/);
  assert.match(drifted.text(".sc-header"), /1 outdated/);
  assert.match(drifted.text(".sc-header"), /1 need review/);
});

test("the main path uses plain words; technical terms live only under Advanced", async () => {
  const h = makeHarness();
  await h.render(mixedState());
  const main = h.center().children.filter((c) => !c.classList.contains("sc-advanced"));
  const mainText = main.map((c) => c.textContent).join(" ");
  assert.doesNotMatch(mainText, /Playwright|headed|\.auth|Learn Sync|headless|CLI/i);
  assert.equal(h.center().querySelectorAll(".sc-primary-btn").length, 1, "one primary action at a time");
  const advanced = h.center().querySelector(".sc-advanced");
  assert.equal(advanced.open, false, "Advanced starts closed");
  assert.match(advanced.querySelector(".sc-cli code").textContent, /capture\.js --generated-lab=lab-test-1/);
  assert.ok(advanced.querySelector('[data-sc-action="copy-cli"]'), "the command has a Copy button");
  const labels = advanced.querySelectorAll("label").map((l) => l.textContent);
  for (const expected of ["Which screenshots", "Numbered markers", "Tenant addresses to use"]) assert.ok(labels.includes(expected), expected);
  assert.ok(advanced.querySelector('[data-sc-action="recheck"]') && advanced.querySelector('[data-sc-action="recheck-update"]'));
  assert.ok(advanced.querySelector("#sc-adv-redact"), "redaction toggle");
  assert.ok(advanced.querySelector("[data-sc-library-host]"), "shared library target");
});

test("the primary button follows the setup: connect, capture, retake, review, check", async () => {
  const h = makeHarness();
  await h.render(stateFor([captured("a.png"), shot({ filename: "b.png" }), shot({ filename: "c.png" })]));
  assert.equal(h.center().querySelector(".sc-primary-btn").textContent, "Connect your computer");
  assert.equal(h.center().querySelector(".sc-primary-btn").dataset.scAction, "primary-connect");

  h.status = statusPayload({ devices: [device()] });
  await h.run("scLoadStatus")(true);
  h.run("scNotifyStatusChanged")();
  assert.equal(h.center().querySelector(".sc-primary-btn").textContent, "Capture all screenshots automatically");
  assert.equal(h.center().querySelector(".sc-primary-btn").dataset.scAction, "primary-capture-missing");

  await h.render(stateFor([captured("a.png", { stale: true }), captured("b.png", { stale: true })]));
  assert.equal(h.center().querySelector(".sc-primary-btn").textContent, "Retake 2 outdated screenshots automatically");

  await h.render(stateFor([captured("a.png"), shot({ filename: "b.png", needsReview: true, verification: { level: "warn", reasons: [{ code: "near-uniform", level: "warn" }] } })]));
  assert.equal(h.center().querySelector(".sc-primary-btn").textContent, "Review 1 screenshot");
});

test("the readiness strip shows each part's live state", async () => {
  const h = makeHarness();
  const pending = stateFor([shot({ filename: "a.png" }), shot({ filename: "b.png", product: "sharepoint-ai", featureId: "mod-b" })]);
  await h.render(pending);
  assert.equal(h.center().querySelectorAll(".sc-step").length, 3);
  assert.equal(h.step("connect").dataset.state, "todo");
  assert.match(h.step("connect").textContent, /Part 1: Connect this computer/);
  assert.doesNotMatch(h.center().querySelector(".sc-steps").textContent, /\bStep \d/, "Step means a wizard step only");
  assert.match(h.step("connect").textContent, /Not connected yet/);
  assert.equal(h.step("connect").querySelector('[data-sc-action="step-connect"]'), null, "the big button already says it, so the step does not repeat it");
  assert.equal(h.center().querySelector(".sc-primary-btn").dataset.scAction, "primary-connect");
  assert.equal(h.step("tenant").dataset.state, "optional");
  assert.match(h.step("tenant").textContent, /Part 2: Add your tenant addresses/);
  assert.equal(h.step("signin").dataset.state, "locked");
  assert.match(h.step("signin").textContent, /Connect your computer first/);

  await h.setStatus(statusPayload({ devices: [device()], signedIn: ["copilot-studio"] }));
  await h.render(pending);
  assert.equal(h.step("connect").dataset.state, "done");
  assert.match(h.step("connect").textContent, /Connected: Ada PC/);
  assert.equal(h.step("signin").dataset.state, "todo");
  assert.match(h.step("signin").textContent, /Signed in to Copilot Studio/);
  assert.match(h.step("signin").textContent, /Still to sign in: SharePoint AI/);
  assert.match(h.step("signin").textContent, /browser window opens on your computer/);
  assert.match(h.step("signin").textContent, /Sign in there and capture continues by itself/);

  await h.setStatus(statusPayload({ devices: [device()], signedIn: ["copilot-studio", "sharepoint-ai"] }));
  await h.render(pending);
  assert.equal(h.step("signin").dataset.state, "done");
  assert.match(h.step("signin").textContent, /Signed in to Copilot Studio and SharePoint AI/);

  await h.setStatus(statusPayload({ devices: [device()], tenantSet: true }));
  await h.render(pending);
  assert.equal(h.step("tenant").dataset.state, "done");
  assert.match(h.step("tenant").textContent, /portal administrator/);

  h.brand = { customized: true, profileName: "Contoso", effective: { copilotStudioUrl: "https://copilotstudio.microsoft.com/environments/x", sharepointSiteUrl: "https://contoso.sharepoint.com/sites/labs", powerPlatformEnvUrl: "javascript:alert(1)" } };
  await h.setStatus(statusPayload({ devices: [device()] }));
  h.advance(30000);
  await h.render(pending);
  await h.flush();
  assert.equal(h.step("tenant").dataset.state, "done");
  assert.match(h.step("tenant").textContent, /2 of 6 addresses are set: Copilot Studio and SharePoint site/);

  const broken = makeHarness();
  broken.route("GET", /\/api\/capture\/status$/, { status: 500, body: { error: "boom" } });
  await broken.render(pending);
  assert.equal(broken.step("connect").dataset.state, "error");
  assert.ok(broken.action("step-retry-status"), "a failed check offers Try again");

  const checkOnly = makeHarness();
  await checkOnly.render(stateFor([captured("a.png")]));
  assert.equal(checkOnly.center().querySelector(".sc-primary-btn").dataset.scAction, "primary-check");
  assert.ok(checkOnly.step("connect").querySelector('[data-sc-action="step-connect"]'), "with nothing to capture the step offers to connect");
});

test("adding tenant addresses jumps to the brand profile addresses", async () => {
  const h = makeHarness();
  await h.render(stateFor([shot({ filename: "a.png" })]));
  await h.click(h.action("step-add-addresses"));
  assert.deepEqual(h.spies.tabs, ["config"]);
  assert.equal(h.document.activeElement.id, "bp-copilotStudioUrl");
});

test("a lab's own addresses can be swapped for a brand profile in Advanced", async () => {
  const h = makeHarness();
  h.run("var brandProfiles = { loaded: true, activeProfileId: 'p1', profiles: [{ id: 'p1', name: 'Contoso', copilotStudioUrl: 'https://copilotstudio.microsoft.com/environments/c' }, { id: 'p2', name: 'Fabrikam' }] };");
  h.status = statusPayload({ devices: [device()] });
  await h.render(stateFor([shot({ filename: "a.png" })]));
  assert.equal(h.step("tenant").dataset.state, "optional");
  assert.match(h.step("tenant").textContent, /Your Contoso profile has 1 address\. Use them for this lab\./);
  const options = h.center().querySelector("#sc-adv-tenant").querySelectorAll("option").map((o) => o.textContent);
  assert.ok(options.includes("Brand profile: Fabrikam") && options.includes("Do not use saved addresses"));
  await h.click(h.action("step-use-profile"));
  assert.equal(h.step("tenant").dataset.state, "done");
  await h.click(h.action("primary-capture-missing"));
  assert.equal(h.callsTo("POST", /\/api\/capture\/jobs$/)[0].body.brandProfileId, "p1");
});

// ── Pairing a computer ──────────────────────────────────────────────────────

const PAIR_REPLY = {
  status: 201,
  body: {
    code: "ABCD-EFGH",
    expiresAt: new Date(NOW + 10 * 60 * 1000).toISOString(),
    expiresInSec: 600,
    portalUrl: "https://portal.example",
    command: "start-companion --portal=https://portal.example --code=ABCD-EFGH",
  },
};

test("pairing shows the code, a copy button, the command, a download link, and a live countdown", async () => {
  const h = makeHarness();
  h.route("POST", /\/api\/capture\/pair$/, PAIR_REPLY);
  await h.render(stateFor([shot({ filename: "a.png" })]));
  await h.click(h.action("primary-connect"));
  const card = h.center().querySelector(".sc-pairing");
  assert.ok(card, "the pairing card opens in the panel");
  assert.equal(card.querySelector(".sc-code").textContent, "ABCD-EFGH");
  assert.match(card.querySelector(".sc-code").getAttribute("aria-label"), /Pairing code A B C D/);
  assert.equal(card.querySelector(".sc-command").textContent, "start-companion --portal=https://portal.example --code=ABCD-EFGH");
  const link = card.querySelector("a[download]");
  assert.equal(link.getAttribute("href"), "/api/capture/companion.zip");
  assert.match(link.textContent, /Download the companion/);
  assert.equal(h.document.activeElement.id, "sc-pair-heading", "focus moves to the card");
  assert.equal(card.querySelector("[data-sc-pair-timer]").textContent, "Code expires in 10:00");
  assert.match(card.textContent, /Waiting for your computer/);

  await h.click(h.action("pair-copy-code"));
  await h.click(h.action("pair-copy-command"));
  assert.deepEqual(h.copied, ["ABCD-EFGH", "start-companion --portal=https://portal.example --code=ABCD-EFGH"]);
  assert.equal(h.live(), "Command copied to your clipboard.");

  h.advance(1000);
  assert.equal(h.center().querySelector("[data-sc-pair-timer]").textContent, "Code expires in 9:59");
  h.advance(59000);
  assert.equal(h.center().querySelector("[data-sc-pair-timer]").textContent, "Code expires in 9:00");
});

test("pairing notices the new computer on its own and says so", async () => {
  const h = makeHarness();
  h.route("POST", /\/api\/capture\/pair$/, PAIR_REPLY);
  await h.render(stateFor([shot({ filename: "a.png" })]));
  await h.click(h.action("primary-connect"));
  assert.equal(h.step("connect").dataset.state, "todo");

  h.advance(3000);
  await h.flush();
  assert.ok(h.center().querySelector(".sc-pairing .sc-code"), "still waiting while nothing new connected");

  h.status = statusPayload({ devices: [device({ id: "dev_aaaaaaaaaaaa", name: "Grace Laptop" })] });
  const statusCalls = h.callsTo("GET", /\/api\/capture\/status$/).length;
  h.advance(3000);
  await h.flush();
  assert.ok(h.callsTo("GET", /\/api\/capture\/status$/).length > statusCalls, "it polls the status while the card is open");
  assert.equal(h.center().querySelector(".sc-pair-success").textContent, "Connected: Grace Laptop. You are ready to capture screenshots.");
  assert.match(h.live(), /Connected: Grace Laptop/);
  assert.equal(h.step("connect").dataset.state, "done");
  assert.equal(h.center().querySelector(".sc-primary-btn").textContent, "Capture all screenshots automatically");
  assert.equal(h.clock.timers.size, 0, "no timers are left running once connected");

  await h.click(h.action("pair-close"));
  assert.equal(h.center().querySelector(".sc-pairing"), null);
});

test("an expired pairing code says so and offers a new one", async () => {
  const h = makeHarness();
  h.route("POST", /\/api\/capture\/pair$/, PAIR_REPLY);
  await h.render(stateFor([shot({ filename: "a.png" })]));
  await h.click(h.action("primary-connect"));
  h.advance(10 * 60 * 1000 + 1000);
  await h.flush();
  const card = h.center().querySelector(".sc-pairing");
  assert.match(card.querySelector(".sc-pair-error").textContent, /This code expired/);
  assert.match(h.live(), /expired/);
  await h.click(h.action("pair-new"));
  assert.equal(h.callsTo("POST", /\/api\/capture\/pair$/).length, 2);
});

test("a failed pairing request is explained, and a computer can be disconnected after a confirmation", async () => {
  const h = makeHarness();
  h.route("POST", /\/api\/capture\/pair$/, { status: 429, body: { error: "Too many pairing codes requested. Try again in 60s." } });
  await h.render(stateFor([shot({ filename: "a.png" })]));
  await h.click(h.action("primary-connect"));
  assert.match(h.center().querySelector(".sc-pair-error").textContent, /We could not get a pairing code\. Too many pairing codes requested/);
  assert.ok(h.action("pair-new"));

  const d = makeHarness();
  await d.setStatus(statusPayload({ devices: [device()] }));
  d.route("DELETE", /\/api\/capture\/devices\/dev_0123456789ab$/, { status: 200, body: { revoked: true } });
  await d.render(stateFor([shot({ filename: "a.png" })]));
  const button = d.action("disconnect-device");
  assert.equal(button.getAttribute("aria-label"), "Disconnect Ada PC");
  await d.click(button);
  assert.equal(button.textContent, "Confirm disconnect");
  assert.equal(d.callsTo("DELETE", /devices/).length, 0, "the first click only asks for confirmation");
  await d.click(button);
  assert.equal(d.callsTo("DELETE", /devices\/dev_0123456789ab$/).length, 1);
  assert.match(d.live(), /Computer disconnected/);
});

// ── Copy confirmations ──────────────────────────────────────────────────────

const OK_CODE = "Code copied to your clipboard";
const OK_COMMAND = "Command copied to your clipboard";

async function pairedHarness(options) {
  const h = makeHarness(options);
  h.route("POST", /\/api\/capture\/pair$/, PAIR_REPLY);
  await h.render(stateFor([shot({ filename: "a.png" })]));
  await h.click(h.action("primary-connect"));
  return h;
}

/** The confirmation element that sits right after a Copy button. */
const ackAfter = (button) => button.parentNode.children[button.parentNode.children.indexOf(button) + 1];
const visibleAcks = (h) => h.host.querySelectorAll("[data-sc-copy-ack]").filter((el) => el.textContent !== "");

test("Copy code shows a checkmark and 'Code copied to your clipboard' next to the button, and announces it", async () => {
  const h = await pairedHarness();
  const button = h.action("pair-copy-code");
  assert.equal(button.tagName, "BUTTON", "a real button, so Enter and Space work");
  assert.equal(button.type, "button");
  assert.equal(ackAfter(button).getAttribute("data-sc-copy-ack"), "pair-copy-code", "the placeholder sits right next to the button");
  assert.equal(ackAfter(button).textContent, "", "nothing is shown before a copy");

  button.focus();
  await h.click(button);
  assert.deepEqual(h.copied, ["ABCD-EFGH"]);
  const ack = ackAfter(h.action("pair-copy-code"));
  assert.equal(ack.textContent, OK_CODE);
  assert.ok(ack.classList.contains("sc-copy-ack-ok") && !ack.classList.contains("sc-copy-ack-fail"));
  const icon = ack.querySelector("svg.sc-copy-ack-icon");
  assert.ok(icon, "a checkmark icon");
  assert.equal(icon.getAttribute("aria-hidden"), "true", "the icon is decorative");
  assert.equal(icon.querySelector("path").getAttribute("stroke"), "currentColor", "the icon takes the theme's success color");
  assert.equal(ack.querySelector(".sc-copy-ack-text").textContent, OK_CODE, "the words are real text");
  assert.equal(ack.getAttribute("role"), null, "the live region announces it, so the visible text does not announce a second time");
  assert.equal(h.live(), `${OK_CODE}.`);
  assert.equal(h.action("pair-copy-code").textContent, "Copy code", "the button label never changes");
  assert.equal(h.document.activeElement.dataset.scAction, "pair-copy-code", "focus stays on the clicked button");
  assert.equal(visibleAcks(h).length, 1);

  await h.click(h.action("pair-copy-code"));
  assert.equal(h.live(), `${OK_CODE}.`, "a repeat click announces again");
  assert.equal(h.document.activeElement.dataset.scAction, "pair-copy-code");
});

test("the command buttons confirm with 'Command copied to your clipboard', and only the latest copy is confirmed", async () => {
  const h = await pairedHarness();
  await h.click(h.action("pair-copy-code"));
  assert.equal(visibleAcks(h)[0].textContent, OK_CODE);

  await h.click(h.action("pair-copy-command"));
  assert.deepEqual(h.copied, ["ABCD-EFGH", "start-companion --portal=https://portal.example --code=ABCD-EFGH"]);
  const shown = visibleAcks(h);
  assert.equal(shown.length, 1, "the earlier confirmation is replaced, not stacked");
  assert.equal(shown[0], ackAfter(h.action("pair-copy-command")));
  assert.equal(shown[0].textContent, OK_COMMAND);
  assert.equal(h.live(), `${OK_COMMAND}.`);
  assert.equal(ackAfter(h.action("pair-copy-code")).textContent, "");

  const details = h.center().querySelector("[data-sc-advanced]");
  const cli = details.querySelector('[data-sc-action="copy-cli"]');
  await h.click(cli);
  assert.deepEqual(h.copied.at(-1), `node tools/screenshot-capture/capture.js --generated-lab=${LAB} --headed`);
  assert.equal(visibleAcks(h).length, 1);
  assert.equal(ackAfter(h.action("copy-cli", details)).textContent, OK_COMMAND);
  assert.equal(ackAfter(h.action("pair-copy-command")).textContent, "", "the pairing command is no longer confirmed");
  assert.equal(h.action("copy-cli", details).textContent, "Copy command");
});

test("the confirmation clears after about three seconds, and a repeat click restarts the clock", async () => {
  const h = await pairedHarness();
  await h.click(h.action("pair-copy-code"));
  h.advance(2900);
  assert.equal(ackAfter(h.action("pair-copy-code")).textContent, OK_CODE, "still visible just before three seconds");
  h.advance(100);
  assert.equal(ackAfter(h.action("pair-copy-code")).textContent, "", "gone after three seconds");
  assert.equal(h.live(), `${OK_CODE}.`, "clearing does not announce anything new");

  await h.click(h.action("pair-copy-code"));
  h.advance(2000);
  await h.click(h.action("pair-copy-code"));
  h.advance(2000);
  assert.equal(ackAfter(h.action("pair-copy-code")).textContent, OK_CODE, "the second click restarted the three seconds");
  h.advance(1000);
  assert.equal(ackAfter(h.action("pair-copy-code")).textContent, "");

  await h.click(h.action("pair-copy-code"));
  h.advance(1000);
  await h.click(h.action("pair-copy-command"));
  h.advance(2000);
  assert.equal(visibleAcks(h).length, 1, "the replaced confirmation's timer does not clear the new one early");
  assert.equal(visibleAcks(h)[0].textContent, OK_COMMAND);
  h.advance(1000);
  assert.equal(visibleAcks(h).length, 0);
});

test("the confirmation survives re-renders while the window is open and is gone after it", async () => {
  const h = await pairedHarness();
  await h.click(h.action("pair-copy-code"));
  h.advance(1000);

  h.run("scRerender")(LAB);
  const rebuilt = ackAfter(h.action("pair-copy-code"));
  assert.equal(rebuilt.textContent, OK_CODE, "a panel re-render re-applies it to the same button");
  assert.equal(rebuilt.style.animationDelay, "-1000ms", "and continues the fade instead of restarting it");
  assert.equal(visibleAcks(h).length, 1);
  h.run("scRefreshPairingUi")();
  assert.equal(ackAfter(h.action("pair-copy-code")).textContent, OK_CODE, "so does the pairing card refreshing on its own");
  h.advance(1000);
  await h.run("scLoadStatus")(true);
  h.run("scNotifyStatusChanged")();
  assert.equal(ackAfter(h.action("pair-copy-code")).textContent, OK_CODE, "and a status change");

  h.advance(1000);
  assert.equal(visibleAcks(h).length, 0, "cleared on time");
  h.run("scRerender")(LAB);
  assert.equal(visibleAcks(h).length, 0, "a later re-render does not bring it back");
  assert.deepEqual(
    [...h.clock.timers.values()].filter((t) => !t.every),
    [],
    "no copy timer is left behind (only the pairing countdown interval keeps running)",
  );
  await h.click(h.action("pair-copy-code"));
  h.advance(3500);
  h.run("scRerender")(LAB);
  assert.equal(visibleAcks(h).length, 0, "a render that runs after the window never shows a stale confirmation");
});

test("when copying is blocked, a visible non-green message says what to do next and is announced", async () => {
  const h = await pairedHarness();
  h.run("navigator").clipboard.writeText = async () => {
    throw new Error("NotAllowedError");
  };
  h.action("pair-copy-code").focus();
  await h.click(h.action("pair-copy-code"));
  const ack = ackAfter(h.action("pair-copy-code"));
  assert.equal(ack.textContent, "Couldn't copy. Select the code and press Ctrl+C.");
  assert.ok(ack.classList.contains("sc-copy-ack-fail") && !ack.classList.contains("sc-copy-ack-ok"), "never styled as success");
  assert.ok(ack.querySelector("svg[aria-hidden]"), "the warning icon is decorative");
  assert.equal(h.live(), "Couldn't copy. Select the code and press Ctrl+C.");
  assert.equal(h.document.activeElement.dataset.scAction, "pair-copy-code");
  assert.equal(h.action("pair-copy-code").textContent, "Copy code");
  assert.equal(ack.style.animationDelay, "", "no fade on the message that asks for action");
  h.advance(3100);
  assert.equal(ackAfter(h.action("pair-copy-code")).textContent, "Couldn't copy. Select the code and press Ctrl+C.", "it stays long enough to read and act on");
  h.advance(5000);
  assert.equal(visibleAcks(h).length, 0);

  await h.click(h.action("pair-copy-command"));
  assert.equal(ackAfter(h.action("pair-copy-command")).textContent, "Couldn't copy. Select the command and press Ctrl+C.");
  assert.equal(h.live(), "Couldn't copy. Select the command and press Ctrl+C.");

  const noClipboard = await pairedHarness();
  noClipboard.run("navigator").clipboard = undefined;
  await noClipboard.click(noClipboard.action("pair-copy-code"));
  assert.equal(ackAfter(noClipboard.action("pair-copy-code")).textContent, "Couldn't copy. Select the code and press Ctrl+C.", "a missing clipboard API fails the same way");

  const recovered = await pairedHarness();
  recovered.run("navigator").clipboard.writeText = async () => {
    throw new Error("blocked");
  };
  await recovered.click(recovered.action("pair-copy-code"));
  recovered.run("navigator").clipboard.writeText = async (text) => recovered.copied.push(text);
  await recovered.click(recovered.action("pair-copy-code"));
  assert.equal(visibleAcks(recovered).length, 1);
  assert.equal(ackAfter(recovered.action("pair-copy-code")).textContent, OK_CODE, "a later success replaces the failure message");
});

test("closing the card or getting a new code drops the confirmation and its timer", async () => {
  const h = await pairedHarness();
  await h.click(h.action("pair-copy-code"));
  await h.click(h.action("pair-close"));
  assert.equal(visibleAcks(h).length, 0);
  assert.equal(h.clock.timers.size, 0, "no timers are left once the card is closed");

  const again = await pairedHarness();
  await again.click(again.action("pair-copy-code"));
  await again.click(again.action("pair-new"));
  assert.equal(visibleAcks(again).length, 0, "a new code starts without the old confirmation");
  assert.equal(again.action("pair-copy-code") !== null, true);
});

test("the Review and build pairing card confirms copies too, through the page live region", async () => {
  const h = makeHarness();
  const live = h.document.createElement("div");
  live.id = "app-live";
  h.document.body.appendChild(live);
  h.route("POST", /\/api\/capture\/pair$/, PAIR_REPLY);
  h.buildStep.setup.click();
  await h.flush();
  const button = h.buildStep.pairing.querySelector('[data-sc-action="pair-copy-code"]');
  assert.ok(button, "Review and build shows the same pairing card");
  button.focus();
  await h.run("scHandleAction")("", "pair-copy-code", button, "", null);
  assert.equal(ackAfter(h.buildStep.pairing.querySelector('[data-sc-action="pair-copy-code"]')).textContent, OK_CODE);
  assert.equal(live.textContent.replace(/\u00a0/g, ""), `${OK_CODE}.`);
  h.advance(3000);
  assert.equal(visibleAcks({ host: h.buildStep.pairing }).length, 0);
});

test("every copy in the browser scripts goes through the confirmed path, and builds DOM without markup strings", () => {
  const sources = readdirSync(new URL("../public/", import.meta.url))
    .filter((name) => name.endsWith(".js"))
    .map((name) => [name, publicFile(name)]);
  const writers = sources.filter(([, source]) => /clipboard\??\.writeText|execCommand\(\s*["']copy/.test(source)).map(([name]) => name);
  assert.deepEqual(writers, ["screenshot-center.js", "use-case-builder.js"], "the only clipboard writes are scCopyText and ucCopyText, which both confirm visibly");
  const builder = publicFile("use-case-builder.js");
  assert.equal(builder.match(/clipboard\??\.writeText/g).length, 1, "the Use Case Builder writes to the clipboard in one place, ucCopyText");
  assert.ok(builder.includes("ucShowCopyAck(ackEl, ok"), "ucCopyText always shows the visible confirmation");
  const center = publicFile("screenshot-center.js");
  assert.equal(center.match(/scCopyText\(/g).length, 2, "scCopyText is defined once and called once, from scCopyWithAck");
  assert.doesNotMatch(center, /scAnnounce\([^)]*copied/i, "no copy button announces on its own, without the visible confirmation");
  const ackCode = center.slice(center.indexOf("const SC_SVG_NS"), center.indexOf("async function scCopyWithAck"));
  assert.ok(ackCode.length > 500);
  assert.doesNotMatch(ackCode, /innerHTML|insertAdjacentHTML|outerHTML/);
  assert.equal(INDEX_HTML.includes("lbCopyCaptureCommand") || publicFile("generated-labs.js").includes("copy-capture-cmd"), false, "the older Copy capture command button is gone");
});

// ── Live capture progress ───────────────────────────────────────────────────

function threeShots() {
  return stateFor([
    shot({ filename: "a.png", figure: "1.1", caption: "Agents page" }),
    shot({ filename: "b.png", figure: "1.2", caption: "Create an agent", id: 2 }),
    shot({ filename: "c.png", figure: "1.3", caption: "Name the agent", id: 3 }),
  ]);
}

const runningJob = (state, rows, progress, extra = {}) =>
  jobFor(state.shots, {
    status: "running",
    startedAt: new Date(NOW).toISOString(),
    claim: { deviceName: "Ada PC", lastActivityAt: new Date(NOW).toISOString() },
    shots: rows.map(([filename, status]) => ({ filename, status })),
    progress: { total: rows.length, manual: 0, skipped: 0, ...progress },
    ...extra,
  });

async function startCapture(h, state, job) {
  await h.setStatus(statusPayload({ devices: [device()] }));
  h.route("POST", /\/api\/capture\/jobs$/, { status: 201, body: { job, envSource: null } });
  await h.render(state);
  await h.click(h.action("primary-capture-missing"));
}

test("starting a capture shows a live progress card fed by server-sent events", async () => {
  const state = threeShots();
  const h = makeHarness();
  const queued = jobFor(state.shots);
  await startCapture(h, state, queued);

  assert.deepEqual(json(h.callsTo("POST", /\/api\/capture\/jobs$/)[0].body), { target: { type: "lab", labId: LAB }, scope: { mode: "missing" }, options: { callouts: "sidecar", redact: true, mode: "autonomous" } });
  assert.equal(h.FakeEventSource.instances.length, 1);
  const es = h.FakeEventSource.instances[0];
  assert.equal(es.url, `/api/capture/jobs/${queued.id}/events`);
  const bar = () => h.center().querySelector('.sc-progress [role="progressbar"]');
  assert.equal(bar().getAttribute("aria-valuenow"), "0");
  assert.equal(h.center().querySelector(".sc-primary-btn").textContent, "Capturing screenshots");
  assert.equal(h.center().querySelector(".sc-primary-btn").disabled, true);
  assert.equal(h.document.activeElement.id, `sc-progress-heading-${LAB}`, "focus goes to the progress card");
  assert.ok(h.action("job-cancel"), "a running capture can be canceled");
  assert.equal(h.cardAction("a.png", "shot-capture").disabled, true, "per-shot capture waits for the running job");

  es.emit("snapshot", { job: { ...queued, status: "claimed", claim: { lastActivityAt: new Date(NOW).toISOString() } } });
  assert.equal(h.text(".sc-progress-heading"), "Your computer is getting ready");

  const snapshot = runningJob(state, [["a.png", "captured"], ["b.png", "running"], ["c.png", "pending"]], { done: 1, captured: 1, needsReview: 0, failed: 0, running: 1, pending: 1, percent: 33 });
  es.emit("snapshot", { job: snapshot });
  assert.equal(h.text(".sc-progress-heading"), "Capturing screenshots", "the heading follows the job even when the card is only patched");
  assert.equal(bar().getAttribute("aria-valuenow"), "33");
  assert.match(bar().getAttribute("aria-valuetext"), /33 percent, 1 of 3 screenshots done/);
  assert.match(h.text(".sc-progress-line"), /33% · 1 of 3 done · Elapsed 0:00/);
  assert.equal(h.text(".sc-progress-now"), "Now capturing: Figure 1.2: Create an agent");
  assert.deepEqual(h.center().querySelectorAll(".sc-progress-counts .sc-chip").map((c) => c.textContent), ["1 captured", "0 need review", "0 failed"]);
  assert.equal(h.card("b.png").dataset.status, "capturing");
  assert.match(h.live(), /Capturing screenshots/);

  es.emit("update", {
    job: { id: queued.id, status: "running", progress: { total: 3, done: 2, captured: 1, needsReview: 1, failed: 0, manual: 0, running: 0, pending: 1, percent: 67 } },
    event: { type: "shot-needs-review", message: "b.png: Saved for review." },
  });
  assert.equal(bar().getAttribute("aria-valuenow"), "67");
  assert.deepEqual(h.center().querySelectorAll(".sc-progress-counts .sc-chip").map((c) => c.textContent), ["1 captured", "1 need review", "0 failed"]);
  assert.equal(h.live(), "2 of 3 screenshots done.");

  h.advance(65000);
  assert.match(h.text(".sc-progress-line"), /Elapsed 1:05/, "the elapsed time ticks");

  const done = runningJob(state, [["a.png", "captured"], ["b.png", "needs-review"], ["c.png", "captured"]], { done: 3, captured: 2, needsReview: 1, failed: 0, running: 0, pending: 0, percent: 100 }, { status: "done" });
  h.route("GET", new RegExp(`/api/capture/jobs/${queued.id}$`), { status: 200, body: { job: done } });
  es.emit("end", { status: "done" });
  await h.flush();
  assert.equal(es.closed, true, "the stream is closed");
  assert.equal(h.center().querySelector(".sc-progress"), null, "the progress card is replaced by the result");
  assert.match(h.text(".sc-banner"), /Capture finished: 2 captured, 1 need review\./);
  assert.deepEqual(h.spies.preview, [LAB], "the lab preview refreshes so new images appear");
  assert.ok(h.spies.list >= 1, "the saved-lab list refreshes");
  assert.ok(h.action("banner-review"), "the result offers to review what needs review");
  assert.equal(h.clock.timers.size, 0, "no timers are left running");

  es.emit("update", { job: { id: queued.id, status: "done", progress: done.progress }, event: { type: "done", message: "Finished." } });
  await h.flush();
  assert.equal(h.center().querySelector(".sc-progress"), null, "a late event about a finished job never brings its card back");
  assert.equal(h.center().querySelector(".sc-primary-btn").disabled, false, "and the primary button is not stuck on 'Capturing'");
});

test("a screenshot that failed in the last capture says why, in plain words", async () => {
  const state = threeShots();
  const h = makeHarness();
  const queued = jobFor(state.shots);
  await startCapture(h, state, queued);
  const es = h.FakeEventSource.instances[0];
  const rejected = { level: "fail", reasons: [{ code: "sign-in-page", level: "fail", message: "raw" }] };
  const failedJob = {
    ...runningJob(state, [["a.png", "captured"], ["b.png", "failed"], ["c.png", "auth-required"]], { done: 3, captured: 1, needsReview: 0, failed: 2, running: 0, pending: 0, percent: 100 }, { status: "done" }),
  };
  failedJob.shots[1].verification = rejected;
  failedJob.shots[2].message = "Sign in needed";
  h.route("GET", new RegExp(`/api/capture/jobs/${queued.id}$`), { status: 200, body: { job: failedJob } });
  es.emit("end", { status: "done" });
  await h.flush();
  assert.equal(h.card("b.png").dataset.status, "failed");
  assert.equal(h.card("b.png").querySelector(".sc-status-chip").textContent, "Failed");
  assert.match(h.card("b.png").querySelector(".sc-note").textContent, /^The last picture was not used\. This looks like the Microsoft sign-in page, not the product\.$/);
  assert.match(h.card("c.png").querySelector(".sc-note").textContent, /Sign-in was needed\. Sign in on your computer, then try again\./);
  assert.match(h.text(".sc-banner"), /1 captured, 2 failed\./);
  await h.click(h.action("banner-retry-failed"));
  assert.deepEqual(json(h.callsTo("POST", /\/api\/capture\/jobs$/)[1].body.scope), { mode: "selected", filenames: ["b.png", "c.png"] });
});

test("instruction lines are shown as plain text, not Markdown", async () => {
  const h = makeHarness();
  await h.render(stateFor([shot({ filename: "a.png", instructions: ["Select the **Build** tab.", "Turn on `Memory` and *save*."] })]));
  await h.click(h.cardAction("a.png", "preview"));
  assert.deepEqual(h.center().querySelectorAll(".sc-lb-info ol li").map((li) => li.textContent), ["Select the Build tab.", "Turn on Memory and save."]);
});

test("progress falls back to polling when server-sent events are not available", async () => {
  const state = threeShots();
  const h = makeHarness({ eventSource: false });
  const queued = jobFor(state.shots);
  const running = runningJob(state, [["a.png", "captured"], ["b.png", "running"], ["c.png", "pending"]], { done: 1, captured: 1, needsReview: 0, failed: 0, running: 1, pending: 1, percent: 33 });
  h.route("GET", new RegExp(`/api/capture/jobs/${queued.id}$`), { status: 200, body: { job: running } });
  await startCapture(h, state, queued);
  await h.flush();
  assert.equal(h.FakeEventSource.instances.length, 0);
  assert.equal(h.callsTo("GET", new RegExp(`/api/capture/jobs/${queued.id}$`)).length, 1, "it polls straight away");
  assert.equal(h.center().querySelector('.sc-progress [role="progressbar"]').getAttribute("aria-valuenow"), "33");

  const done = runningJob(state, [["a.png", "captured"], ["b.png", "captured"], ["c.png", "captured"]], { done: 3, captured: 3, needsReview: 0, failed: 0, running: 0, pending: 0, percent: 100 }, { status: "done" });
  h.route("GET", new RegExp(`/api/capture/jobs/${queued.id}$`), { status: 200, body: { job: done } });
  h.advance(2000);
  await h.flush();
  assert.equal(h.callsTo("GET", new RegExp(`/api/capture/jobs/${queued.id}$`)).length, 2, "and again every two seconds");
  assert.match(h.text(".sc-banner"), /Capture finished: 3 captured\./);
  assert.equal(h.clock.timers.size, 0);
});

test("a dropped event stream switches to polling without losing progress", async () => {
  const state = threeShots();
  const h = makeHarness();
  const queued = jobFor(state.shots);
  await startCapture(h, state, queued);
  const es = h.FakeEventSource.instances[0];
  const running = runningJob(state, [["a.png", "captured"], ["b.png", "running"], ["c.png", "pending"]], { done: 1, captured: 1, needsReview: 0, failed: 0, running: 1, pending: 1, percent: 33 });
  h.route("GET", new RegExp(`/api/capture/jobs/${queued.id}$`), { status: 200, body: { job: running } });
  es.onerror();
  await h.flush();
  assert.equal(es.closed, true);
  assert.equal(h.center().querySelector('.sc-progress [role="progressbar"]').getAttribute("aria-valuenow"), "33");
  h.advance(2000);
  await h.flush();
  assert.equal(h.callsTo("GET", new RegExp(`/api/capture/jobs/${queued.id}$`)).length, 2);
});

test("a running capture can be canceled and says what happens next", async () => {
  const state = threeShots();
  const h = makeHarness();
  const queued = jobFor(state.shots);
  await startCapture(h, state, queued);
  const running = runningJob(state, [["a.png", "captured"], ["b.png", "running"], ["c.png", "pending"]], { done: 1, captured: 1, needsReview: 0, failed: 0, running: 1, pending: 1, percent: 33 });
  h.FakeEventSource.instances[0].emit("snapshot", { job: running });
  h.route("POST", new RegExp(`/api/capture/jobs/${queued.id}/cancel$`), { status: 200, body: { job: { ...running, cancelRequested: true } } });
  await h.click(h.action("job-cancel"));
  assert.equal(h.callsTo("POST", /\/cancel$/).length, 1);
  assert.equal(h.text(".sc-progress-heading"), "Canceling");
  assert.match(h.text(".sc-progress-detail"), /stops after the screenshot it is working on/);
  assert.equal(h.action("job-cancel"), null, "cancel is only offered once");
  assert.match(h.live(), /Canceling\. Your computer stops after the screenshot it is working on/);

  const cancelled = { ...running, status: "cancelled", cancelRequested: true, shots: [{ filename: "a.png", status: "captured" }, { filename: "b.png", status: "cancelled" }, { filename: "c.png", status: "cancelled" }], progress: { total: 3, done: 3, captured: 1, needsReview: 0, failed: 0, manual: 0, running: 0, pending: 0, percent: 100 } };
  h.route("GET", new RegExp(`/api/capture/jobs/${queued.id}$`), { status: 200, body: { job: cancelled } });
  h.FakeEventSource.instances[0].emit("end", { status: "cancelled" });
  await h.flush();
  assert.match(h.text(".sc-banner"), /Capture canceled\. 1 of 3 were captured before you stopped it\./);
});

test("an offline computer, a sign-in prompt, and an unconnected queue each give a clear next step", async () => {
  const state = threeShots();
  const h = makeHarness();
  const queued = jobFor(state.shots);
  await startCapture(h, state, queued);
  const es = h.FakeEventSource.instances[0];
  const rows = [["a.png", "captured"], ["b.png", "running"], ["c.png", "pending"]];
  const progress = { done: 1, captured: 1, needsReview: 0, failed: 0, running: 1, pending: 1, percent: 33 };

  es.emit("snapshot", { job: runningJob(state, rows, progress, { claim: { lastActivityAt: new Date(NOW - 5 * 60 * 1000).toISOString() } }) });
  assert.equal(h.text(".sc-progress-heading"), "Your computer stopped responding");
  assert.match(h.text(".sc-progress-detail"), /still running and that the computer is awake/);
  assert.match(h.live(), /Your computer stopped responding/);

  es.emit("snapshot", { job: runningJob(state, [["a.png", "auth-required"], ["b.png", "pending"], ["c.png", "pending"]], { ...progress, failed: 1, running: 0, pending: 2 }) });
  assert.equal(h.text(".sc-progress-heading"), "Sign-in needed on your computer");
  assert.match(h.text(".sc-progress-detail"), /A browser window should be open on your computer\. Sign in there\./);

  const queuedAlone = makeHarness();
  await queuedAlone.render(state);
  queuedAlone.run("scTrackJob")(LAB, queued, { announce: false });
  await queuedAlone.flush();
  assert.equal(queuedAlone.text(".sc-progress-heading"), "Waiting for your computer");
  assert.match(queuedAlone.text(".sc-progress-detail"), /No computer is connected right now/);
  assert.ok(queuedAlone.action("step-connect", queuedAlone.center().querySelector(".sc-progress")), "the card offers to connect");
});

test("a capture already running for this lab is picked up when the panel opens", async () => {
  const state = threeShots();
  const h = makeHarness();
  const running = runningJob(state, [["a.png", "captured"], ["b.png", "running"], ["c.png", "pending"]], { done: 1, captured: 1, needsReview: 0, failed: 0, running: 1, pending: 1, percent: 33 });
  h.activeJobs = [{ id: running.id, status: "running" }];
  h.route("GET", new RegExp(`/api/capture/jobs/${running.id}$`), { status: 200, body: { job: running } });
  await h.setStatus(statusPayload({ devices: [device()] }));
  await h.render(state);
  assert.equal(h.center().querySelector('.sc-progress [role="progressbar"]').getAttribute("aria-valuenow"), "33");
  assert.equal(h.FakeEventSource.instances.length, 1);
  assert.equal(h.center().querySelector(".sc-primary-btn").disabled, true);
});

test("a capture another person started is shown with a plain sentence, announced, and offers no way to stop it", async () => {
  const state = threeShots();
  const rows = [["a.png", "captured"], ["b.png", "running"], ["c.png", "pending"]];
  const progress = { done: 1, captured: 1, needsReview: 0, failed: 0, running: 1, pending: 1, percent: 33 };
  const open = async (mine) => {
    const h = makeHarness();
    const running = runningJob(state, rows, progress, { mine });
    h.activeJobs = [{ id: running.id, status: "running", mine }];
    h.route("GET", new RegExp(`/api/capture/jobs/${running.id}$`), { status: 200, body: { job: running } });
    await h.setStatus(statusPayload({ devices: [device()] }));
    await h.render(state);
    return h;
  };

  const theirs = await open(false);
  const card = theirs.center().querySelector(".sc-progress");
  assert.equal(card.querySelector(".sc-progress-detail").textContent, "Another person is capturing this lab right now.");
  assert.equal(card.querySelector(".sc-progress-heading").textContent, "Capturing screenshots", "no sentence about 'your computer' on someone else's capture");
  assert.equal(card.querySelector('[role="progressbar"]').getAttribute("aria-valuenow"), "33", "the lab's progress is still shared");
  assert.equal(theirs.live(), "Another person is capturing this lab right now.", "the live region says it when it appears");
  assert.ok(!theirs.action("job-cancel"), "only the person who started it can stop it");
  assert.ok(!theirs.action("job-pause"));
  assert.equal(theirs.center().querySelector(".sc-primary-btn").disabled, true, "and a second capture of the lab is not offered meanwhile");

  for (const mine of [true, null]) {
    const own = await open(mine);
    assert.notEqual(own.text(".sc-progress-detail"), "Another person is capturing this lab right now.");
    assert.ok(own.action("job-cancel"), "your own capture, or one the portal cannot tell apart, can be stopped");
    assert.ok(!/Another person/.test(own.live()));
  }
});

test("a refused capture request shows the portal's plain sentence in the banner, announces it, and shows the capture that is already there", async () => {
  const state = threeShots();
  const h = makeHarness();
  const theirs = runningJob(state, [["a.png", "running"], ["b.png", "pending"], ["c.png", "pending"]], { done: 0, captured: 0, needsReview: 0, failed: 0, running: 1, pending: 2, percent: 0 }, { mine: false });
  const sentence = "Another person is capturing this lab right now. Try again when they finish.";
  h.route("POST", /\/api\/capture\/jobs$/, { status: 409, body: { error: sentence, code: "lab-busy", existingJobId: theirs.id, busyBy: "someone-else" } });
  h.route("GET", new RegExp(`/api/capture/jobs/${theirs.id}$`), { status: 200, body: { job: theirs } });
  await h.setStatus(statusPayload({ devices: [device()] }));
  await h.render(state);
  await h.click(h.action("primary-capture-missing"));
  assert.equal(h.text(".sc-banner-text"), sentence, "the portal's own words, with no 'Could not start' in front");
  assert.ok(h.center().querySelector(".sc-banner-warn"), "a busy lab is not an error");
  assert.equal(h.live(), sentence);
  assert.equal(h.text(".sc-progress-detail"), "Another person is capturing this lab right now.", "the capture that is there is shown beside it");
  assert.ok(!h.action("job-cancel"));

  // Any other refusal keeps its short lead-in, and no capture is shown.
  const failed = makeHarness();
  failed.route("POST", /\/api\/capture\/jobs$/, { status: 500, body: { error: "The queue is unavailable." } });
  await failed.setStatus(statusPayload({ devices: [device()] }));
  await failed.render(state);
  await failed.click(failed.action("primary-capture-missing"));
  assert.equal(failed.text(".sc-banner-text"), "Could not start the capture. The queue is unavailable.");
  assert.ok(failed.center().querySelector(".sc-banner-error"));
  assert.ok(!failed.center().querySelector(".sc-progress"));
  assert.equal(failed.live(), "Could not start the capture. The queue is unavailable.");
});

test("a capture queued during the build takes the learner straight to its progress", async () => {
  const state = threeShots();
  const h = makeHarness();
  const queued = jobFor(state.shots);
  h.route("GET", new RegExp(`/api/capture/jobs/${queued.id}$`), { status: 200, body: { job: queued } });
  await h.setStatus(statusPayload({ devices: [device()] }));
  await h.render(state, { outcome: json(h.run("scBuildCaptureOutcome")({ captureQueued: true, captureJobId: queued.id, screenshotCapture: {} })) });
  await h.flush();
  assert.match(h.text(".sc-banner"), /being captured on your computer now/);
  await h.run("scAttachBuildJob")(LAB, queued.id);
  assert.ok(h.center().querySelector(".sc-progress"));
  assert.equal(h.document.activeElement.id, `sc-progress-heading-${LAB}`);
  assert.equal(h.callsTo("GET", new RegExp(`/api/capture/jobs/${queued.id}$`)).length, 1, "the job is fetched once, not once per caller");
});

// ── Gallery: thumbnails, status, and per-shot actions ───────────────────────

const buttonTexts = (card) => card.querySelectorAll(".sc-card-actions button").map((b) => b.textContent);

test("the gallery groups thumbnails by part with a clear status chip and actions on each screenshot", async () => {
  const h = makeHarness();
  await h.setStatus(statusPayload({ devices: [device()] }));
  await h.render(mixedState());
  const modules = h.center().querySelectorAll(".sc-module");
  // The lab's own labels stay "Step 1" and "Step 2" in the lab; the portal shows them as parts.
  assert.deepEqual(modules.map((m) => m.querySelector(".sc-module-title").textContent), ["Part 1 \u00b7 Create an agent", "Part 2 \u00b7 Add topics"]);
  assert.equal(h.center().querySelector("#sc-gallery-heading").textContent, "Screenshots by part");
  assert.deepEqual(modules.map((m) => m.querySelector(".sc-pills .sc-chip").textContent), ["1 of 2 captured", "1 of 4 captured"]);
  assert.match(modules[1].querySelector(".sc-chip-learn").textContent, /Microsoft Learn: 1 module changed/);
  const learnLink = modules[0].querySelector('a[target="_blank"]');
  assert.equal(learnLink.getAttribute("rel"), "noopener noreferrer");
  assert.match(learnLink.getAttribute("href"), /^https:\/\/learn\.microsoft\.com\//);

  const chips = Object.fromEntries(h.center().querySelectorAll(".sc-card").map((c) => [c.dataset.filename, [c.dataset.status, c.querySelector(".sc-status-chip").textContent]]));
  assert.deepEqual(chips, {
    "agent-home.png": ["captured", "Captured"],
    "create-agent.png": ["pending", "Pending"],
    "agent-topics.png": ["outdated", "Outdated"],
    "agent-test.png": ["needs-review", "Needs review"],
    "agent-publish.png": ["failed", "Failed"],
    "agent-sharepoint.png": ["manual", "Manual"],
  });
  assert.match(h.card("agent-home.png").textContent, /Figure 1\.1.*Agents page/);

  assert.deepEqual(buttonTexts(h.card("agent-home.png")), ["Retake", "Retake guided", "Mark as accurate", "Paste image", "Upload image"]);
  assert.deepEqual(buttonTexts(h.card("create-agent.png")), ["Capture this one", "Paste image", "Upload image"]);
  assert.deepEqual(buttonTexts(h.card("agent-topics.png")), ["Retake", "Retake guided", "Mark as accurate", "Paste image", "Upload image"]);
  assert.deepEqual(buttonTexts(h.card("agent-test.png")), ["Accept", "Retake", "Retake guided", "Discard", "Paste image", "Upload image"]);
  assert.deepEqual(buttonTexts(h.card("agent-publish.png")), ["Retake", "Retake guided", "Paste image", "Upload image"]);
  assert.deepEqual(buttonTexts(h.card("agent-sharepoint.png")), ["Paste image", "Upload image"], "a manual shot is never auto-captured");
  assert.equal(h.cardAction("agent-home.png", "shot-retake").getAttribute("aria-label"), "Retake: Figure 1.1: Agents page");

  const captured = h.card("agent-home.png").querySelector("img");
  assert.equal(captured.getAttribute("loading"), "lazy");
  assert.equal(captured.getAttribute("alt"), "", "the thumbnail button carries the name");
  assert.match(captured.getAttribute("src"), /^\/api\/lab-builder\/generated\/lab-test-1\/assets\/agent-home\.png\?v=/);
  const pending = h.card("create-agent.png");
  assert.equal(pending.querySelector("img"), null);
  assert.equal(pending.querySelector(".sc-thumb-empty").textContent, "Pending");
  assert.match(h.card("agent-test.png").querySelector("img").getAttribute("src"), /\/screenshots\/agent-test\.png\/staged\?t=/, "a screenshot waiting for review shows the staged image");
  assert.match(h.cardAction("agent-home.png", "preview").getAttribute("aria-label"), /^Enlarge Figure 1\.1: Agents page\. Status: Captured\.$/);

  assert.match(h.card("agent-test.png").querySelector(".sc-note").textContent, /Only 1 of 3 expected labels are visible\. Check that this is the screen the lab describes\./);
  assert.match(h.card("agent-publish.png").querySelector(".sc-note").textContent, /Sign-in was needed\. Sign in on your computer, then try again\./);
  assert.match(h.card("agent-sharepoint.png").querySelector(".sc-note").textContent, /needs a person/);
  assert.match(h.card("agent-topics.png").querySelector(".sc-note").textContent, /Microsoft Learn changed this topic/);

  const only = h.center().querySelector("#sc-only-attention");
  only.checked = true;
  only.dispatchEvent(h.event("change"));
  assert.equal(h.card("agent-home.png"), null, "the filter hides screenshots that are fine");
  assert.ok(h.card("create-agent.png"));
});

test("an image can be uploaded from the file picker, with a local preview while it is checked", async () => {
  const h = makeHarness();
  await h.setStatus(statusPayload({ devices: [device()] }));
  const before = stateFor([shot({ filename: "create-agent.png" }), captured("agent-home.png", { figure: "1.2", id: 2 })]);
  const after = stateFor([captured("create-agent.png"), captured("agent-home.png", { figure: "1.2", id: 2 })]);
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  h.route("PUT", /\/screenshots\/create-agent\.png$/, async () => {
    await gate;
    return { status: 200, body: { outcome: "accepted", filename: "create-agent.png", verification: { level: "pass", reasons: [], redaction: { applied: true, masked: 1 } }, state: after } };
  });
  await h.render(before);
  const file = pngFile("mine.png");
  await h.click(h.cardAction("create-agent.png", "shot-upload"));
  const input = h.center().querySelector(".sc-file");
  assert.equal(input.clicked, 1, "the hidden file input opens");
  assert.equal(input.getAttribute("accept"), "image/png,image/jpeg,image/webp");
  input.files = [file];
  input.dispatchEvent(h.event("change"));
  await h.flush();

  assert.equal(h.card("create-agent.png").querySelector("img").getAttribute("src"), "blob:fake/1", "the local image shows while it uploads");
  assert.match(h.card("create-agent.png").textContent, /Uploading/);
  assert.equal(h.cardAction("create-agent.png", "shot-upload").disabled, true);
  release();
  await h.flush();

  const put = h.callsTo("PUT", /screenshots\/create-agent\.png$/);
  assert.equal(put.length, 1);
  assert.equal(put[0].url, "/api/lab-builder/generated/lab-test-1/screenshots/create-agent.png");
  assert.equal(put[0].init.headers["Content-Type"], "image/png");
  assert.equal(put[0].init.body, file);
  assert.equal(h.card("create-agent.png").dataset.status, "captured");
  assert.match(h.card("create-agent.png").querySelector(".sc-feedback").textContent, /Added to your lab\./);
  assert.match(h.text(".sc-header"), /2 of 2 captured/);
  assert.deepEqual(h.spies.preview, [LAB], "the lab preview reloads so the new image appears");
  assert.deepEqual(json(h.FakeURL.revoked), ["blob:fake/1"], "the object URL is revoked");
});

test("an image that needs review shows plain-language reasons and can be accepted or discarded", async () => {
  const h = makeHarness();
  const before = stateFor([shot({ filename: "create-agent.png" })]);
  const verification = { level: "warn", state: "needs-review", reasons: [{ code: "near-uniform", level: "warn" }, { code: "labels-missing", level: "warn" }], labels: { expected: 4, matched: 1 } };
  const staged = stateFor([shot({ filename: "create-agent.png", needsReview: true, verification })]);
  h.route("PUT", /\/screenshots\/create-agent\.png$/, { status: 202, body: { outcome: "needs-review", verification } });
  h.route("GET", /\/screenshots$/, { status: 200, body: staged });
  await h.render(before);
  await h.click(h.cardAction("create-agent.png", "shot-upload"));
  const input = h.center().querySelector(".sc-file");
  input.files = [pngFile()];
  input.dispatchEvent(h.event("change"));
  await h.flush();
  const card = h.card("create-agent.png");
  assert.equal(card.dataset.status, "needs-review");
  const feedback = card.querySelector(".sc-feedback").textContent;
  assert.match(feedback, /Saved for review\. Check it, then accept or retake it\./);
  assert.match(feedback, /Almost the whole image is one color/);
  assert.match(feedback, /Only 1 of 4 expected labels are visible/);
  assert.match(h.live(), /Image saved for review/);
  assert.equal(h.callsTo("GET", /\/screenshots$/).length, 1, "the panel reloads the staged state");

  const accepted = stateFor([captured("create-agent.png")]);
  h.route("POST", /\/screenshots\/create-agent\.png\/accept$/, { status: 200, body: { outcome: "accepted", state: accepted } });
  await h.click(h.cardAction("create-agent.png", "shot-accept"));
  assert.equal(h.card("create-agent.png").dataset.status, "captured");
  assert.match(h.live(), /accepted and added to your lab/);

  const again = makeHarness();
  again.route("DELETE", /\/screenshots\/create-agent\.png$/, { status: 200, body: { outcome: "reset", discardedStaged: true, state: before } });
  await again.render(staged);
  await again.click(again.cardAction("create-agent.png", "shot-discard"));
  assert.equal(again.callsTo("DELETE", /create-agent\.png$/).length, 0, "Discard asks first");
  const ask = again.card("create-agent.png").querySelector(".sc-ask");
  assert.equal(ask.querySelector(".sc-ask-title").textContent, "Discard this picture?");
  assert.equal(ask.querySelector(".sc-ask-text").textContent, "This picture exists only here, waiting for your review. If you discard it, it is gone and you would need to capture or upload it again.");
  await again.click(ask.querySelector('[data-sc-action="ask-cancel"]'));
  assert.equal(again.callsTo("DELETE", /create-agent\.png$/).length, 0, "Cancel changes nothing");
  await again.click(again.cardAction("create-agent.png", "shot-discard"));
  await again.click(again.host.querySelector('[data-sc-action="ask-yes"]'));
  assert.equal(again.callsTo("DELETE", /create-agent\.png$/).length, 1);
  assert.equal(again.card("create-agent.png").dataset.status, "pending");
  assert.match(again.live(), /Picture discarded/);

  // With a picture already in the slot, the question says it stays.
  const inPlace = makeHarness();
  await inPlace.render(stateFor([shot({ filename: "create-agent.png", captured: true, needsReview: true, verification })]));
  await inPlace.click(inPlace.cardAction("create-agent.png", "shot-discard"));
  assert.equal(inPlace.host.querySelector(".sc-ask-title").textContent, "Discard the picture waiting for review?");
  assert.match(inPlace.host.querySelector(".sc-ask-text").textContent, /^The picture now in this slot stays\./);
});

test("rejected and refused uploads explain themselves and change nothing", async () => {
  const cases = [
    [422, { outcome: "rejected", verification: { level: "fail", reasons: [{ code: "sign-in-page", level: "fail" }, { code: "blank", level: "fail" }] } }, [/This image was not accepted\./, /This looks like the Microsoft sign-in page, not the product\./, /blank or a single color/]],
    [413, { error: "too big" }, [/larger than 8 MB/]],
    [415, { error: "bad type" }, [/not supported\. Use a PNG, JPEG, or WebP image\./]],
    [404, { error: "gone" }, [/no longer exists/]],
    [429, { error: "Too many screenshot uploads. Try again in 30s." }, [/Too many screenshot uploads/]],
  ];
  for (const [status, body, patterns] of cases) {
    const h = makeHarness();
    h.route("PUT", /\/screenshots\/create-agent\.png$/, { status, body });
    await h.render(stateFor([shot({ filename: "create-agent.png" })]));
    await h.click(h.cardAction("create-agent.png", "shot-upload"));
    const input = h.center().querySelector(".sc-file");
    input.files = [pngFile()];
    input.dispatchEvent(h.event("change"));
    await h.flush();
    const card = h.card("create-agent.png");
    assert.equal(card.dataset.status, "pending", `${status} leaves the slot alone`);
    for (const pattern of patterns) assert.match(card.querySelector(".sc-feedback").textContent, pattern, `${status}`);
    assert.ok(card.querySelector(".sc-feedback-bad"), `${status} is styled as a problem`);
    assert.equal(h.callsTo("GET", /\/screenshots$/).length, 0);
  }
  const offline = makeHarness();
  offline.route("PUT", /\/screenshots\/create-agent\.png$/, { throws: "network down" });
  await offline.render(stateFor([shot({ filename: "create-agent.png" })]));
  await offline.click(offline.cardAction("create-agent.png", "shot-upload"));
  const input = offline.center().querySelector(".sc-file");
  input.files = [pngFile()];
  input.dispatchEvent(offline.event("change"));
  await offline.flush();
  assert.match(offline.card("create-agent.png").querySelector(".sc-feedback").textContent, /Check your connection and try again/);
});

test("files that cannot be images are stopped before they are sent", async () => {
  const h = makeHarness();
  await h.render(stateFor([shot({ filename: "create-agent.png" })]));
  for (const [file, pattern] of [
    [pngFile("a.svg", "image/svg+xml"), /Use a PNG, JPEG, or WebP image\./],
    [pngFile("a.png", "image/png", 0), /That file is empty\./],
    [new File([new Uint8Array(9 * 1024 * 1024)], "huge.png", { type: "image/png" }), /The limit is 8 MB\./],
  ]) {
    await h.click(h.cardAction("create-agent.png", "shot-upload"));
    const input = h.center().querySelector(".sc-file");
    input.files = [file];
    input.dispatchEvent(h.event("change"));
    await h.flush();
    assert.match(h.card("create-agent.png").querySelector(".sc-feedback").textContent, pattern);
  }
  assert.equal(h.callsTo("PUT", /screenshots/).length, 0, "nothing was uploaded");
  assert.equal(h.FakeURL.created.length, 0, "no object URL was created for a rejected file");
});

test("Ctrl+V pastes an image into the selected screenshot, and only then", async () => {
  const h = makeHarness();
  const after = stateFor([captured("create-agent.png"), captured("agent-home.png", { id: 2, figure: "1.2" })]);
  h.route("PUT", /\/screenshots\/create-agent\.png$/, { status: 200, body: { outcome: "accepted", verification: { level: "pass", reasons: [] }, state: after } });
  await h.render(stateFor([shot({ filename: "create-agent.png", caption: "Create an agent" }), captured("agent-home.png", { id: 2, figure: "1.2" })]));
  const file = pngFile();
  const paste = (target, clipboardData) => {
    const event = h.event("paste", { clipboardData });
    target.dispatchEvent(event);
    return event;
  };

  paste(h.center().querySelector(".sc-card button"), { files: [file], items: [] });
  await h.flush();
  assert.equal(h.callsTo("PUT", /screenshots/).length, 0, "no screenshot selected, so nothing is pasted");
  assert.match(h.live(), /Select a screenshot first, then press Ctrl\+V/);

  h.cardAction("create-agent.png", "shot-paste").focus();
  assert.equal(h.card("create-agent.png").getAttribute("aria-current"), "true");
  assert.match(h.text(".sc-selected-hint"), /^Selected: Figure 1\.1: Create an agent\. Press Ctrl\+V to paste an image from your clipboard\.$/);
  assert.match(h.live(), /Selected: Figure 1\.1/);

  const typed = h.document.createElement("input");
  typed.setAttribute("type", "text");
  h.center().appendChild(typed);
  assert.equal(paste(typed, { files: [file], items: [] }).defaultPrevented, false, "pasting into a text box is left alone");
  assert.equal(paste(h.center().querySelector(".sc-card button"), { files: [], items: [] }).defaultPrevented, false, "pasting plain text is left alone");

  const event = paste(h.cardAction("create-agent.png", "shot-paste"), { files: [file], items: [] });
  await h.flush();
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.callsTo("PUT", /screenshots\/create-agent\.png$/).length, 1);
  assert.equal(h.card("create-agent.png").dataset.status, "captured");
});

test("Paste image reads the clipboard, and explains when the browser will not allow it", async () => {
  const h = makeHarness();
  const after = stateFor([captured("create-agent.png")]);
  h.route("PUT", /\/screenshots\/create-agent\.png$/, { status: 200, body: { outcome: "accepted", verification: { level: "pass", reasons: [] }, state: after } });
  await h.render(stateFor([shot({ filename: "create-agent.png" })]));

  h.clipboardItems = [{ types: ["text/plain"], getType: async () => new Blob(["hi"]) }];
  await h.click(h.cardAction("create-agent.png", "shot-paste"));
  assert.match(h.card("create-agent.png").querySelector(".sc-feedback").textContent, /No image on the clipboard\./);

  h.run("navigator").clipboard.read = async () => {
    throw new Error("denied");
  };
  await h.click(h.cardAction("create-agent.png", "shot-paste"));
  assert.match(h.card("create-agent.png").querySelector(".sc-feedback").textContent, /Click this screenshot, then press Ctrl\+V\./);

  h.run("navigator").clipboard.read = async () => [{ types: ["image/png"], getType: async () => new Blob([new Uint8Array(12000)], { type: "image/png" }) }];
  await h.click(h.cardAction("create-agent.png", "shot-paste"));
  assert.equal(h.callsTo("PUT", /create-agent\.png$/).length, 1);
  assert.equal(h.card("create-agent.png").dataset.status, "captured");
});

test("an image can be dropped onto a screenshot", async () => {
  const h = makeHarness();
  const after = stateFor([captured("create-agent.png")]);
  h.route("PUT", /\/screenshots\/create-agent\.png$/, { status: 200, body: { outcome: "accepted", verification: { level: "pass", reasons: [] }, state: after } });
  await h.render(stateFor([shot({ filename: "create-agent.png" })]));
  const card = h.card("create-agent.png");
  const thumb = card.querySelector(".sc-thumb");
  const over = h.event("dragover", { dataTransfer: { types: ["Files"], files: [] } });
  thumb.dispatchEvent(over);
  assert.equal(over.defaultPrevented, true, "dropping is allowed");
  assert.ok(card.classList.contains("sc-drop-active"));
  assert.equal(card.querySelector(".sc-drop-hint").textContent, "Drop to replace");
  thumb.dispatchEvent(h.event("dragleave"));
  assert.ok(!card.classList.contains("sc-drop-active"));

  const textDrag = h.event("dragover", { dataTransfer: { types: ["text/plain"], files: [] } });
  thumb.dispatchEvent(textDrag);
  assert.equal(textDrag.defaultPrevented, false, "only files are accepted");

  const file = pngFile("dropped.png");
  const drop = h.event("drop", { dataTransfer: { types: ["Files"], files: [file] } });
  thumb.dispatchEvent(drop);
  await h.flush();
  assert.equal(drop.defaultPrevented, true);
  assert.equal(h.callsTo("PUT", /create-agent\.png$/)[0].init.body, file);
  assert.equal(h.card("create-agent.png").dataset.status, "captured");
});

test("Retake keeps the old image in place while it queues a new capture, says so, and keeps the old image when the retake does not work", async () => {
  const state = stateFor([captured("agent-home.png"), shot({ filename: "create-agent.png", id: 2 })]);
  const h = makeHarness();
  await h.setStatus(statusPayload({ devices: [device()] }));
  const job = { ...jobFor([{ filename: "agent-home.png" }]), options: { retake: true } };
  h.route("DELETE", /\/screenshots\/agent-home\.png$/, { status: 200, body: { outcome: "reset", removedImage: true, state } });
  h.route("POST", /\/api\/capture\/jobs$/, { status: 201, body: { job } });
  await h.render(state);
  h.calls.length = 0;
  await h.click(h.cardAction("agent-home.png", "shot-retake"));
  const order = h.calls.map((c) => `${c.method} ${c.url}`);
  assert.deepEqual(order.filter((c) => /DELETE|POST/.test(c)), ["POST /api/capture/jobs"], "the old image is never removed first");
  assert.deepEqual(json(h.callsTo("POST", /\/api\/capture\/jobs$/)[0].body.scope), { mode: "selected", filenames: ["agent-home.png"] });
  assert.ok(h.center().querySelector(".sc-progress"), "the retake shows live progress");
  assert.equal(h.card("agent-home.png").querySelector("img").getAttribute("src").startsWith("/api/lab-builder/generated/lab-test-1/assets/agent-home.png"), true, "the old picture is still shown");
  assert.equal(h.card("agent-home.png").querySelector("[data-sc-retake-note]").textContent, "Retake in progress. Your current picture stays until the new one passes its check.");

  // A retake that ends without a new picture leaves the old one and says so.
  const failedJob = { ...job, status: "done", shots: [{ filename: "agent-home.png", status: "failed", attempts: 1, error: "The page did not open." }], progress: { total: 1, done: 1, captured: 0, needsReview: 0, failed: 1, manual: 0, skipped: 0, running: 0, pending: 0, percent: 100 } };
  h.route("GET", new RegExp(`/api/capture/jobs/${job.id}$`), { status: 200, body: { job: failedJob } });
  h.FakeEventSource.instances[0].emit("end", { status: "done" });
  await h.flush();
  const note = h.card("agent-home.png").querySelector("[data-sc-retake-note]");
  assert.equal(note.textContent, "The retake did not work, so your current picture was kept. The page did not open.");
  assert.equal(h.card("agent-home.png").dataset.status, "captured", "the slot is never left empty");

  const offline = makeHarness();
  await offline.render(state);
  await offline.click(offline.cardAction("agent-home.png", "shot-retake"));
  assert.equal(offline.callsTo("DELETE", /screenshots/).length, 0, "the old image stays when no computer is connected");
  assert.match(offline.card("agent-home.png").querySelector(".sc-feedback").textContent, /Retake needs your computer\./);
  assert.match(offline.card("agent-home.png").querySelector(".sc-feedback").textContent, /Your current image was not changed\./);
});

test("Capture this one starts pairing when no computer is connected", async () => {
  const h = makeHarness();
  h.route("POST", /\/api\/capture\/pair$/, PAIR_REPLY);
  await h.render(stateFor([shot({ filename: "create-agent.png" })]));
  await h.click(h.cardAction("create-agent.png", "shot-capture"));
  assert.match(h.card("create-agent.png").querySelector(".sc-feedback").textContent, /Connect your computer first\./);
  assert.ok(h.center().querySelector(".sc-pairing .sc-code"), "the pairing card opens");
  assert.equal(h.callsTo("POST", /\/api\/capture\/jobs$/).length, 0);
});

// ── Preview dialog ──────────────────────────────────────────────────────────

test("the preview dialog shows the image, alt text, instructions, and check results, and works from the keyboard", async () => {
  const h = makeHarness();
  await h.setStatus(statusPayload({ devices: [device()] }));
  await h.render(mixedState());
  const dialog = h.center().querySelector("dialog.sc-lightbox");
  assert.equal(dialog.open, false);
  const opener = h.cardAction("agent-home.png", "preview");
  opener.focus();
  await h.click(opener);
  assert.equal(dialog.open, true);
  assert.equal(dialog.modal, true, "it is a real modal dialog");
  assert.equal(dialog.getAttribute("aria-labelledby"), "sc-lb-title");
  assert.equal(dialog.querySelector("#sc-lb-title").textContent, "Figure 1.1: Agents page");
  assert.equal(dialog.querySelector(".sc-lb-img").getAttribute("alt"), "The Copilot Studio agents page with the Create button highlighted");
  assert.deepEqual(dialog.querySelectorAll(".sc-lb-info ol li").map((li) => li.textContent), ["Open Copilot Studio", "Select Agents"]);
  assert.match(dialog.querySelector(".sc-lb-info").textContent, /What to show/);
  assert.match(dialog.querySelector(".sc-lb-info").textContent, /Screenshot 1 of 6/);
  assert.equal(h.document.activeElement.dataset.scFocus, "lb-close", "focus lands inside the dialog");

  const key = (name) => dialog.dispatchEvent(h.event("keydown", { key: name }));
  key("ArrowRight");
  assert.equal(dialog.querySelector("#sc-lb-title").textContent, "Figure 1.2: Create an agent");
  assert.match(dialog.querySelector(".sc-lb-empty").textContent, /Pending\. This screenshot has not been captured yet\./);
  key("ArrowLeft");
  assert.equal(dialog.querySelector("#sc-lb-title").textContent, "Figure 1.1: Agents page");
  key("ArrowLeft");
  assert.equal(dialog.querySelector("#sc-lb-title").textContent, "Figure 2.4: SharePoint site", "navigation wraps around");
  key("Home");
  assert.equal(dialog.querySelector("#sc-lb-title").textContent, "Figure 1.1: Agents page");
  key("End");
  key("ArrowRight");
  assert.equal(dialog.querySelector("#sc-lb-title").textContent, "Figure 1.1: Agents page");

  for (let i = 0; i < 3; i += 1) key("ArrowRight");
  assert.equal(dialog.querySelector("#sc-lb-title").textContent, "Figure 2.2: Test panel");
  const info = dialog.querySelector(".sc-lb-info").textContent;
  assert.match(info, /Check results/);
  assert.match(info, /Please check this image before you use it\./);
  assert.match(info, /Only 1 of 3 expected labels are visible/);
  assert.ok(dialog.querySelector('[data-sc-action="shot-accept"]'), "the dialog offers the same actions");
  assert.equal(h.card("agent-test.png").getAttribute("aria-current"), "true", "the card behind it follows along");

  key("End");
  key("Escape");
  assert.equal(dialog.open, false, "Escape closes it");
  assert.equal(h.document.activeElement.dataset.scFocus, "thumb:agent-sharepoint.png", "focus returns to the screenshot last viewed");

  await h.click(h.cardAction("agent-home.png", "preview"));
  await h.click(dialog.querySelector('[data-sc-action="lightbox-next"]'));
  assert.equal(dialog.querySelector("#sc-lb-title").textContent, "Figure 1.2: Create an agent");
  await h.click(dialog.querySelector('[data-sc-action="lightbox-close"]'));
  assert.equal(dialog.open, false);
});

// ── Untrusted text never becomes markup ─────────────────────────────────────

test("file names, captions, messages, and addresses from the network are shown as text only", async () => {
  const h = makeHarness();
  const payload = '<img src=x onerror="alert(1)">';
  const evil = shot({
    filename: "evil.png",
    caption: payload,
    alt: '"><script>alert(2)</script>',
    instructions: ["<b>bold</b><script>alert(3)</script>"],
    needsReview: true,
    verification: { level: "warn", reasons: [{ code: "made-up-code", level: "warn", message: "<script>alert(4)</script>" }] },
  });
  const unsafeNames = [shot({ filename: "bad<name>.png", id: 2 }), shot({ filename: "../x.png", id: 3 }), shot({ filename: 'q".png', id: 4 })];
  const state = stateFor([evil, ...unsafeNames, captured("fine.png", { id: 5, figure: "1.2" })]);
  state.modules[0].primaryUrl = "javascript:alert(5)";
  await h.setStatus({ ...statusPayload({ devices: [device({ name: payload })] }), limits: { maxUploadBytes: 8388608, acceptedTypes: ["image/png"] } });
  await h.render(state);

  assert.equal(h.card("bad<name>.png"), null);
  assert.equal(h.center().querySelectorAll(".sc-card").length, 2, "slots with unsafe file names are skipped");
  assert.equal(h.center().querySelectorAll("script").length, 0);
  for (const img of h.center().querySelectorAll("img")) assert.match(img.getAttribute("src"), /^\/api\/lab-builder\/generated\/lab-test-1\//);
  assert.ok(h.center().textContent.includes(payload), "the payload is visible as plain text");
  assert.equal(h.center().querySelectorAll("a").filter((a) => /javascript:/i.test(a.getAttribute("href") || "")).length, 0);
  assert.equal(h.center().querySelector("a[target]"), null, "an unsafe Learn address gets no link");
  assert.match(h.step("connect").textContent, /Connected: <img src=x onerror="alert\(1\)">/);

  await h.click(h.cardAction("evil.png", "preview"));
  const dialog = h.center().querySelector("dialog.sc-lightbox");
  assert.equal(dialog.querySelectorAll("script").length, 0);
  assert.equal(dialog.querySelector(".sc-lb-img").getAttribute("alt"), evil.alt);
  assert.ok(dialog.textContent.includes("<b>bold</b><script>alert(3)</script>"));
  assert.ok(dialog.textContent.includes("<script>alert(4)</script>"), "an unknown reason's message is text");

  for (const file of ["screenshot-center-core.js", "screenshot-center-command.js", "screenshot-center-jobs.js", "screenshot-center.js", "lab-checklist.js"]) {
    assert.doesNotMatch(publicFile(file), /\.innerHTML|insertAdjacentHTML|outerHTML|document\.write|eval\(|new Function/, `${file} must build DOM with textContent only`);
  }
});

// ── Capture when the lab is built ───────────────────────────────────────────

test("capture-on-build is shown and enabled only while a computer is connected, and setup is one click away", async () => {
  const h = makeHarness();
  h.route("POST", /\/api\/capture\/pair$/, PAIR_REPLY);
  const { box, label, status, setup, pairing, pane } = h.buildStep;
  assert.equal(label.hidden, true, "the checkbox starts hidden");
  await h.run("scSyncCaptureOnBuild")();
  assert.equal(box.disabled, true);
  assert.equal(box.checked, false);
  assert.equal(label.hidden, true, "with no computer connected the checkbox is hidden, not a dead control");
  assert.equal(status.textContent, "Want screenshots taken as the lab is built? Connect your computer (about two minutes). Or capture them after the build.");
  assert.equal(setup.hidden, false, "the setup link shows");

  setup.click();
  await h.flush();
  assert.ok(pairing.querySelector(".sc-pairing .sc-code"), "pairing happens right in Review and build");
  h.status = statusPayload({ devices: [device({ id: "dev_bbbbbbbbbbbb" })] });
  h.advance(3000);
  await h.flush();
  assert.equal(box.disabled, false, "connecting turns the option on");
  assert.equal(label.hidden, false, "and shows it");
  assert.equal(box.checked, true, "and checks it, since that is why the learner connected");
  assert.match(status.textContent, /^Connected: Ada PC\. Screenshots are captured on your computer right after your lab is built\.$/);
  assert.equal(setup.hidden, true);

  await h.setStatus(statusPayload({ devices: [device({ connected: false })] }));
  await h.run("scSyncCaptureOnBuild")({ fetch: false });
  assert.equal(box.disabled, true, "disconnecting turns it off again");
  assert.equal(box.checked, false);
  assert.equal(label.hidden, true, "and hides it again");

  const before = h.callsTo("GET", /\/api\/capture\/status$/).length;
  h.windowListeners.focus.forEach((fn) => fn());
  await h.flush();
  assert.equal(h.callsTo("GET", /\/api\/capture\/status$/).length, before + 1, "returning to the tab re-reads the status while Review and build is open");
  pane.style.display = "none";
  h.windowListeners.focus.forEach((fn) => fn());
  await h.flush();
  assert.equal(h.callsTo("GET", /\/api\/capture\/status$/).length, before + 1, "and not while another step is open");

  const broken = makeHarness();
  broken.route("GET", /\/api\/capture\/status$/, { status: 500, body: { error: "down" } });
  await broken.run("scSyncCaptureOnBuild")();
  assert.equal(broken.buildStep.box.disabled, true);
  assert.equal(broken.buildStep.label.hidden, true);
  assert.match(broken.buildStep.status.textContent, /We could not check whether a computer is connected\. You can still build your lab/);
});

test("the build flow never waits on capture and hands a queued job to the live progress card", () => {
  assert.match(APP_SOURCE, /const captureScreenshots = Boolean\(captureBox\?\.checked && !captureBox\?\.disabled\);/);
  assert.match(APP_SOURCE, /data\.captureQueued && data\.captureJobId && typeof scAttachBuildJob === "function"[\s\S]{0,80}scAttachBuildJob\(data\.labId, data\.captureJobId\)/);
  assert.match(APP_SOURCE, /scBuildCaptureOutcome\(data\)/);
  const showResult = APP_SOURCE.slice(APP_SOURCE.indexOf("function lbShowResult"), APP_SOURCE.indexOf("async function lbLoadResultPreview"));
  assert.match(showResult, /<div id="lb-result-checklist"><\/div>[\s\S]*<div id="lb-result-screenshots"><\/div>/, "the checklist sits above the screenshots in the result");
  assert.match(showResult, /lbRenderLabChecklist\(data\.labId\)/);
  assert.doesNotMatch(APP_SOURCE, /cliCommandHeaded|screenshotCapture\.cliCommand|Playwright/, "no command-line string is shown after a build");
  const wizard = publicFile("lab-builder-wizard.js");
  assert.match(wizard, /step === LB_STEP\.review\)\s*\{[\s\S]{0,260}scSyncCaptureOnBuild\(\)/, "Review and build reads the capture status when it opens");
  const reviewPane = INDEX_HTML.slice(INDEX_HTML.indexOf('id="lb-pane-4"'), INDEX_HTML.indexOf('<div class="lb-step-footer"', INDEX_HTML.indexOf('id="lb-pane-4"')));
  assert.match(reviewPane, /<label[^>]*id="lb-capture-on-build-label"[^>]*hidden>\s*<input type="checkbox" id="lb-capture-on-build" autocomplete="off" disabled aria-describedby="lb-capture-on-build-status">/, "the checkbox is hidden until a computer is connected");
  assert.match(reviewPane, /Capture screenshots when the lab is built/);
  assert.match(reviewPane, /<p id="lb-capture-on-build-status"[^>]*role="status" aria-live="polite"/);
  assert.match(reviewPane, /id="lb-capture-on-build-setup"[^>]*hidden>Set up screenshot capture<\/button>/);
  assert.match(reviewPane, /id="lb-capture-on-build-pairing" data-sc-pairing-host="build"/);
  assert.match(reviewPane, /never slows down or blocks the build/);
  assert.doesNotMatch(reviewPane, /Playwright|headed|\.auth|Learn Sync/i);
});

// ── Finish your lab ─────────────────────────────────────────────────────────

const freshInput = () => ({ reviewed: false, shared: false, branding: { customized: false }, shots: { total: 3, captured: 0, toCapture: 3, manual: 0, outdated: 0, needsReview: 0 }, check: { state: "not-checked", changed: 0 } });

test("the checklist has five steps, each todo, done, or needing attention", () => {
  const h = makeHarness();
  const items = (input) => json(h.run("lbChecklistItems")(input));
  const fresh = items(freshInput());
  assert.deepEqual(fresh.map((i) => i.id), ["review", "branding", "screenshots", "check", "share"]);
  assert.deepEqual(fresh.map((i) => i.status), ["todo", "todo", "todo", "todo", "todo"]);
  assert.equal(fresh[3].detail, "Not checked yet. Compare this lab with the current Microsoft Learn pages.");
  assert.equal(fresh[2].detail, "0 of 3 captured. 3 pending. Capture them on your computer or add them by hand.");

  const done = items({ reviewed: true, shared: true, branding: { customized: true, profileName: "Contoso" }, shots: { total: 3, captured: 3, toCapture: 0, manual: 0, outdated: 0, needsReview: 0 }, check: { state: "up-to-date" } });
  assert.deepEqual(done.map((i) => i.status), ["done", "done", "done", "done", "done"]);
  assert.equal(done[2].detail, "3 of 3 captured. Nothing is left to capture.");
  assert.equal(done[1].detail, "Using the Contoso brand profile.");
  assert.equal(h.run("lbChecklistDoneCount")(done), 5);

  const attention = items({ ...freshInput(), branding: { customized: true, profileName: "Contoso", profileChanged: true }, shots: { total: 3, captured: 2, toCapture: 0, manual: 0, outdated: 2, needsReview: 1 }, check: { state: "docs-updated", changed: 2 } });
  assert.deepEqual(attention.map((i) => i.status), ["todo", "attention", "attention", "attention", "todo"]);
  assert.match(attention[1].detail, /The Contoso profile changed after this lab was built/);
  assert.equal(attention[2].detail, "2 of 3 captured. 2 outdated, 1 need review. Capture them on your computer or add them by hand.");
  assert.equal(attention[3].detail, "2 modules changed on Microsoft Learn since this lab was built.");

  assert.equal(items({ ...freshInput(), shots: { total: 0 } })[2].status, "done", "a lab with no screenshots has nothing to capture");
  assert.equal(items({ ...freshInput(), shots: { unknown: true } })[2].status, "todo", "unknown screenshots are never shown as done");
  assert.equal(items({ ...freshInput(), check: { state: "ungrounded" } })[3].status, "done");
});

test("an opened lab shows the checklist with a progress summary and buttons that move focus to the right section", async () => {
  const h = makeHarness();
  const customize = h.document.createElement("details");
  customize.id = "lb-result-customize";
  customize.appendChild(h.document.createElement("summary"));
  h.document.body.appendChild(customize);
  h.brand = { customized: true, profileName: "Contoso", profileChanged: false, effective: {} };
  await h.setStatus(statusPayload({ devices: [device()] }));
  await h.render(stateFor([shot({ filename: "a.png" }), captured("b.png", { id: 2, figure: "1.2" })]));
  await h.flush();

  const checklist = h.document.getElementById("lb-result-checklist").querySelector("section.lb-checklist");
  assert.equal(checklist.getAttribute("aria-labelledby"), "lb-checklist-heading");
  const heading = checklist.querySelector("#lb-checklist-heading");
  assert.equal(heading.textContent, "Finish your lab");
  assert.equal(heading.getAttribute("tabindex"), "-1");
  assert.equal(checklist.querySelector(".lb-checklist-summary").textContent, "1 of 5 done");
  const bar = checklist.querySelector('[role="progressbar"]');
  assert.deepEqual([bar.getAttribute("aria-valuenow"), bar.getAttribute("aria-valuemax"), bar.getAttribute("aria-valuetext"), bar.getAttribute("aria-labelledby")], ["1", "5", "1 of 5 steps done", "lb-checklist-heading"]);
  const items = checklist.querySelectorAll(".lb-check-item");
  assert.deepEqual(items.map((i) => [i.dataset.item, i.dataset.status]), [["review", "todo"], ["branding", "done"], ["screenshots", "todo"], ["check", "todo"], ["share", "todo"]]);
  assert.match(checklist.textContent, /Brand: Contoso/, "the brand profile chip shows");
  assert.match(items[2].textContent, /1 of 2 captured\. 1 pending\./);
  assert.match(items[3].textContent, /Not checked yet/);
  for (const item of items) {
    const button = item.querySelector("button");
    assert.ok(button, "every step has a real button");
    assert.match(button.getAttribute("aria-label"), new RegExp(`: ${item.querySelector("strong").textContent}$`));
  }

  const go = async (id) => h.click(checklist.querySelector(`[data-cl-action="${id}"]`));
  await go("screenshots");
  assert.equal(h.document.activeElement.id, "lb-screenshots-heading");
  await go("check");
  assert.equal(h.center().querySelector("[data-sc-advanced]").open, true, "Re-check lives in Advanced, so it opens");
  assert.equal(h.document.activeElement.dataset.scAction, "recheck");
  await go("branding");
  assert.equal(customize.open, true);
  assert.equal(h.document.activeElement.tagName, "SUMMARY");
  await go("share");
  assert.equal(h.document.activeElement, h.downloadBtn);
  await go("review");
  assert.equal(h.document.activeElement, h.preview);
  const after = h.document.getElementById("lb-result-checklist");
  assert.equal(after.querySelector('[data-item="review"]').dataset.status, "done", "reading the lab ticks it off");
  assert.equal(after.querySelector(".lb-checklist-summary").textContent, "2 of 5 done");
  assert.equal(h.run("localStorage").getItem("lb-lab-flag:lab-test-1:reviewed"), "1");

  await h.render(stateFor([captured("a.png")]));
  await h.click(h.document.getElementById("lb-result-checklist").querySelector('[data-cl-action="check"]'));
  assert.equal(h.document.activeElement.dataset.scAction, "primary-check", "when checking is the next step, its button gets focus");
});

test("the checklist reacts to what the Screenshot Center learns", async () => {
  const h = makeHarness();
  h.brand = { customized: true, profileName: "Contoso", profileChangedSinceSnapshot: true, effective: {} };
  await h.render(stateFor([captured("a.png", { stale: true }), shot({ filename: "b.png", id: 2, needsReview: true, verification: { level: "warn", reasons: [] } })]));
  await h.flush();
  const root = () => h.document.getElementById("lb-result-checklist");
  assert.equal(root().querySelector('[data-item="branding"]').dataset.status, "attention");
  assert.equal(root().querySelector('[data-item="screenshots"]').dataset.status, "attention");
  assert.match(root().querySelector('[data-item="check"]').textContent, /1 module changed on Microsoft Learn/);
  assert.equal(root().querySelector('[data-item="check"] button').textContent, "Update the lab");

  await h.render(stateFor([captured("a.png"), captured("b.png", { id: 2 })], { lastRevalidatedAt: "2026-05-30T10:00:00.000Z" }));
  assert.equal(root().querySelector('[data-item="screenshots"]').dataset.status, "done");
  assert.equal(root().querySelector('[data-item="check"]').dataset.status, "done");
});

test("saved-lab cards carry a small 'N of 5' readiness chip that stays honest", () => {
  const h = makeHarness({ generated: true });
  const lab = {
    labId: LAB,
    title: "Test lab",
    generatedAt: "2026-05-01T10:00:00.000Z",
    totalMinutes: 60,
    moduleCount: 2,
    selections: { brandProfileId: "p1" },
    screenshots: { total: 2, captured: 2, pending: 0, stale: 0, learnSyncStatus: "up-to-date" },
    learnDrift: { status: "up-to-date", lastCheckedAt: "2026-05-02T10:00:00.000Z", driftedModuleCount: 0, driftedModules: [], missingScreenshotCount: 0, moduleCount: 2 },
  };
  const chip = (l) => /<li class="lb-gen-ready-chip"[^>]*aria-label="([^"]+)">([^<]+)<\/li>/.exec(h.run("lbGenItemHtml")(l));
  assert.deepEqual(chip(lab).slice(1), ["Lab checklist: 3 of 5 steps done", "3 of 5 ready"]);
  const unchecked = { ...lab, learnDrift: { ...lab.learnDrift, status: "not-checked", lastCheckedAt: null } };
  assert.equal(chip(unchecked)[2], "2 of 5 ready", "a lab nobody has checked does not count as checked");
  const pending = { ...lab, screenshots: { total: 2, captured: 0, pending: 2, stale: 0 }, selections: null };
  assert.equal(chip(pending)[2], "1 of 5 ready");
  const unknown = { ...lab, screenshots: null, selections: null, learnDrift: { ...lab.learnDrift, status: "not-checked" } };
  assert.equal(chip(unknown)[2], "0 of 5 ready", "a lab with no screenshot record is not shown as done");

  const list = h.document.getElementById("lb-generated-list");
  const item = h.document.createElement("li");
  item.setAttribute("data-lab-id", LAB);
  const chipEl = h.document.createElement("li");
  chipEl.className = "lb-gen-ready-chip";
  item.appendChild(chipEl);
  list.appendChild(item);
  h.run(`lbGen.labs = [${JSON.stringify(lab)}]`);
  h.run("lbChecklistMarkShared")(LAB);
  assert.equal(chipEl.textContent, "4 of 5 ready", "downloading a lab updates its chip in place");
  assert.equal(chipEl.getAttribute("aria-label"), "Lab checklist: 4 of 5 steps done");
  const source = GENERATED_LABS_SOURCE;
  for (const action of ["export-zip", "export-html", "download", "print"]) {
    assert.match(source, new RegExp(`case "${action}": [^\\n]*lbChecklistShared\\(labId\\)`), `${action} counts as sharing`);
  }
});

// ── Honest check state on saved labs ────────────────────────────────────────

test("saved-lab badges and counts never show an unchecked lab as up to date", () => {
  const h = makeHarness({ generated: true });
  const norm = (lab) => json(h.run("lbNormalizeLabLearnDrift")(lab)).status;
  const shots = (extra) => ({ screenshots: { total: 2, captured: 2, pending: 0, stale: 0, learnSyncStatus: "up-to-date", ...extra } });
  assert.equal(norm(shots({})), "not-checked", "the old default of 'up to date' is gone");
  assert.equal(norm(shots({ checkState: "up-to-date" })), "up-to-date");
  assert.equal(norm(shots({ lastRevalidatedAt: "2026-05-01T00:00:00.000Z" })), "up-to-date");
  assert.equal(norm(shots({ checkState: "up-to-date", pending: 1 })), "missing-screenshot");
  assert.equal(norm(shots({ stale: 1 })), "docs-updated");
  assert.equal(norm({}), "not-checked");

  const card = (drift) => h.run("lbRenderLabCardDriftHtml")({ labId: LAB, learnDrift: drift }, "Test lab");
  const base = { lastCheckedAt: null, driftedModuleCount: 0, driftedModules: [], missingScreenshotCount: 0, moduleCount: 1 };
  const unchecked = card({ ...base, status: "not-checked" });
  assert.match(unchecked, /Not checked against Microsoft Learn yet/);
  assert.doesNotMatch(unchecked, /up to date|lb-gen-drift-badge-ok/i);
  assert.match(card({ ...base, status: "up-to-date", lastCheckedAt: "2026-05-02T10:00:00.000Z" }), /Microsoft Learn up to date/);

  h.run(`lbGen.labs = [{ labId: "${LAB}", title: "T", moduleCount: 1, screenshots: { total: 1, captured: 1, pending: 0, stale: 0, learnSyncStatus: "up-to-date" } }]`);
  h.run("lbSyncSingleLabDriftFromState")(LAB, { checkState: "not-checked", lastRevalidatedAt: null, summary: { total: 1, captured: 1, missing: 0, stale: 0, learnSyncStatus: "up-to-date", checkState: "not-checked" }, modules: [] });
  const synced = json(h.run("lbGen.labs[0].learnDrift"));
  assert.equal(synced.status, "not-checked");
  assert.equal(synced.lastCheckedAt, null);
  assert.equal(h.run("lbComputeFleetDriftCounts")(h.run("lbGen.labs")).notChecked, 1);
  h.run("lbSyncSingleLabDriftFromState")(LAB, { checkState: "up-to-date", lastRevalidatedAt: "2026-05-30T10:00:00.000Z", summary: { total: 1, captured: 1, missing: 0, stale: 0, learnSyncStatus: "up-to-date", checkState: "up-to-date" }, modules: [] });
  assert.equal(h.run("lbGen.labs[0].learnDrift.status"), "up-to-date");
});

// ── Shared library ──────────────────────────────────────────────────────────

test("the shared library shows coverage and queues a capture for one product", async () => {
  const h = makeHarness();
  const libraryShots = [
    { product: "sharepoint-ai", feature: "f1", filename: "a.png", captured: false, needsReview: false },
    { product: "sharepoint-ai", feature: "f2", filename: "b.png", captured: false, needsReview: false },
    { product: "sharepoint-ai", feature: "f3", filename: "c.png", captured: true, needsReview: false },
    { product: "copilot-studio", feature: "f4", filename: "d.png", captured: true, needsReview: true },
  ];
  h.route("GET", /\/api\/capture\/library$/, { status: 200, body: { summary: { total: 4, captured: 2, missing: 2, needsReview: 1 }, shots: libraryShots } });
  await h.setStatus(statusPayload({ devices: [device()] }));
  await h.render(stateFor([captured("a.png")], { lastRevalidatedAt: "2026-05-30T10:00:00.000Z" }));
  const library = () => h.center().querySelector("[data-sc-library-host]");
  assert.match(library().textContent, /Shared screenshot library/);
  assert.match(library().textContent, /12 of 325 captured, 313 missing, 1 need review\./);
  assert.match(library().textContent, /Saved: these pictures are kept when the portal restarts\./);

  await h.setStatus(statusPayload({ devices: [device()], persistent: false }));
  h.run("scRerender")(LAB);
  assert.match(library().textContent, /Not saved: these pictures can be lost when the portal restarts/);

  await h.click(h.action("library-load"));
  const rows = library().querySelectorAll(".sc-library-row").map((r) => r.textContent);
  assert.deepEqual(rows, ["Copilot Studio1 of 1 captured, 1 need review", "SharePoint AI1 of 3 captured" + "Capture 2 missing"]);
  const capture = library().querySelector('[data-sc-action="library-capture"]');
  assert.equal(capture.getAttribute("aria-label"), "Capture 2 missing screenshots for SharePoint AI in the shared library");
  const job = jobFor([{ filename: "a.png" }, { filename: "b.png" }], { target: { type: "library", products: ["sharepoint-ai"] } });
  h.route("POST", /\/api\/capture\/jobs$/, { status: 201, body: { job } });
  await h.click(capture);
  assert.deepEqual(json(h.callsTo("POST", /\/api\/capture\/jobs$/)[0].body.target), { type: "library", products: ["sharepoint-ai"] });
  assert.deepEqual(json(h.callsTo("POST", /\/api\/capture\/jobs$/)[0].body.scope), { mode: "missing" });
  assert.ok(library().querySelector('[data-sc-progress-host="library"] .sc-progress'), "its progress shows inside the library section");
  assert.equal(h.FakeEventSource.instances.length, 1);
  assert.equal(h.center().querySelector(".sc-primary-btn").disabled, true, "the lab's own primary action is unaffected");

  const done = { ...job, status: "done", shots: [{ filename: "a.png", status: "captured" }, { filename: "b.png", status: "captured" }], progress: { total: 2, done: 2, captured: 2, needsReview: 0, failed: 0, manual: 0, running: 0, pending: 0, percent: 100 } };
  h.route("GET", new RegExp(`/api/capture/jobs/${job.id}$`), { status: 200, body: { job: done } });
  h.FakeEventSource.instances[0].emit("end", { status: "done" });
  await h.flush();
  assert.match(library().textContent, /Capture finished: 2 captured\./);
  assert.equal(h.callsTo("GET", /\/api\/capture\/library$/).length, 2, "the coverage reloads when the capture ends");
});

test("advanced capture options are sent with the job, and 'selected' needs a tick", async () => {
  const h = makeHarness();
  await h.setStatus(statusPayload({ devices: [device()] }));
  const job = jobFor([{ filename: "a.png" }]);
  h.route("POST", /\/api\/capture\/jobs$/, { status: 201, body: { job } });
  await h.render(stateFor([shot({ filename: "a.png" }), captured("b.png", { id: 2, figure: "1.2" })]));
  const advanced = h.center().querySelector("[data-sc-advanced]");
  const setField = (id, value) => {
    const el = h.center().querySelector(`#${id}`);
    el.value = value;
    el.dispatchEvent(h.event("change"));
  };
  setField("sc-adv-scope", "selected");
  assert.ok(h.center().classList.contains("sc-selecting") || h.center().querySelector(".sc-center, [data-sc-root]").classList.contains("sc-selecting"));
  await h.click(h.action("advanced-capture"));
  assert.match(h.text(".sc-banner"), /Tick at least one screenshot below/);
  assert.equal(h.callsTo("POST", /\/api\/capture\/jobs$/).length, 0);

  const pick = h.card("a.png").querySelector('input[type="checkbox"]');
  pick.checked = true;
  pick.dispatchEvent(h.event("change"));
  setField("sc-adv-callouts", "burn");
  const redact = h.center().querySelector("#sc-adv-redact");
  redact.checked = false;
  redact.dispatchEvent(h.event("change"));
  setField("sc-adv-tenant", "none");
  await h.click(h.action("advanced-capture"));
  assert.deepEqual(json(h.callsTo("POST", /\/api\/capture\/jobs$/)[0].body), {
    target: { type: "lab", labId: LAB },
    scope: { mode: "selected", filenames: ["a.png"] },
    options: { callouts: "burn", redact: false, mode: "autonomous" },
    useLabCustomization: false,
  });
  advanced.dispatchEvent(h.event("toggle", { bubbles: false }));
});

test("re-checking against Microsoft Learn reports honestly and offers the update", async () => {
  const h = makeHarness();
  const checked = stateFor([captured("a.png")], { lastRevalidatedAt: "2026-06-01T12:00:00.000Z" });
  h.route("POST", /\/screenshots\/revalidate$/, { status: 200, body: { counts: { upToDate: 2, docsUpdated: 0 }, state: checked, checkState: "up-to-date" } });
  await h.render(stateFor([captured("a.png")]));
  assert.equal(h.center().querySelector(".sc-primary-btn").textContent, "Check against Microsoft Learn");
  await h.click(h.center().querySelector(".sc-primary-btn"));
  const call = h.callsTo("POST", /revalidate$/)[0];
  assert.deepEqual(json(call.body), { autoUpdate: false, updateSteps: false, autoCapture: false, onlyStale: true }, "the server never runs a browser for this");
  assert.match(h.text(".sc-banner"), /Checked just now\. All 2 modules match live Microsoft Learn documentation\./);
  assert.match(h.text(".sc-header"), /Microsoft Learn: Up to date/);
  assert.equal(h.center().querySelector(".sc-primary-btn").textContent, "All screenshots up to date");

  const changed = makeHarness();
  const drifted = stateFor([captured("a.png", { stale: true })]);
  changed.route("POST", /\/screenshots\/revalidate$/, { status: 200, body: { counts: { upToDate: 0, docsUpdated: 1 }, state: drifted } });
  await changed.render(stateFor([captured("a.png")]));
  await changed.click(changed.action("recheck"));
  assert.match(changed.text(".sc-banner"), /1 module changed on Microsoft Learn since this lab was built\. Update the steps, then retake the outdated screenshots\./);
  changed.route("POST", /\/screenshots\/revalidate$/, { status: 200, body: { counts: { upToDate: 1, docsUpdated: 0 }, updatedModuleIds: ["mod-a"], state: drifted } });
  await changed.click(changed.action("banner-recheck-update"));
  assert.deepEqual(json(changed.callsTo("POST", /revalidate$/)[1].body), { autoUpdate: true, updateSteps: true, autoCapture: false, onlyStale: true });
  assert.match(changed.text(".sc-banner"), /Updated 1 topic from Microsoft Learn\. Retake any outdated screenshots/);

  const failed = makeHarness();
  failed.route("POST", /\/screenshots\/revalidate$/, { status: 502, body: { error: "Learn is unreachable" } });
  await failed.render(stateFor([captured("a.png")]));
  await failed.click(failed.action("primary-check"));
  assert.match(failed.text(".sc-banner"), /The Microsoft Learn check did not finish\. Learn is unreachable/);
  assert.ok(failed.center().querySelector(".sc-banner-error"));
});

// ── Look, contrast, and print ───────────────────────────────────────────────

function hexToRgb(hex) {
  const raw = String(hex).trim().replace(/^#/, "");
  return [0, 2, 4].map((i) => parseInt(raw.slice(i, i + 2), 16));
}

function luminance(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const l1 = luminance(hexToRgb(a));
  const l2 = luminance(hexToRgb(b));
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function tokens(block) {
  const out = {};
  for (const match of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) out[match[1]] = match[2].trim();
  return out;
}

const STYLE = INDEX_HTML.match(/<style>([\s\S]*?)<\/style>/)[1];
const DARK = tokens(STYLE.match(/:root\s*\{([^}]*)\}/)[1]);
const LIGHT = tokens(STYLE.match(/:root\[data-theme="light"\],\s*body\[data-theme="light"\]\s*\{([^}]*)\}/)[1]);
const LIGHT_AUTO = tokens(STYLE.match(/@media \(prefers-color-scheme: light\)\s*\{\s*:root:not\(\[data-theme="dark"\]\)\s*\{([^}]*)\}/)[1]);

test("the new status colors meet WCAG AA in the dark and light themes", () => {
  for (const [name, t] of [["dark", DARK], ["light", LIGHT], ["light (system)", LIGHT_AUTO]]) {
    for (const tone of ["ok", "warn", "bad", "info", "neutral"]) {
      const ratio = contrast(t[`--sc-${tone}-fg`], t[`--sc-${tone}-bg`]);
      assert.ok(ratio >= 4.5, `${name}: ${tone} chip text is ${ratio.toFixed(2)}:1, needs 4.5:1`);
    }
    for (const surface of ["--bg", "--surface", "--preview-muted-bg", "--preview-bg"]) {
      assert.ok(contrast(t["--text"], t[surface]) >= 4.5, `${name}: --text on ${surface}`);
      assert.ok(contrast(t["--text-muted"], t[surface]) >= 4.5, `${name}: --text-muted on ${surface}`);
    }
    assert.ok(contrast(t["--link-color"], t["--surface"]) >= 4.5, `${name}: link text on the Advanced panel`);
    assert.ok(contrast(t["--accent"], t["--sc-track"]) >= 3, `${name}: the progress fill must stand out from its track`);
    assert.ok(contrast(t["--border-strong"], t["--preview-bg"]) >= 3, `${name}: the empty thumbnail outline`);
    assert.ok(contrast(t["--accent"], t["--bg"]) >= 3, `${name}: the selected card outline`);
    assert.ok(contrast(t["--accent-contrast"], t["--accent"]) >= 4.5, `${name}: the primary button label`);
  }
  for (const key of Object.keys(LIGHT).filter((k) => k.startsWith("--sc-"))) {
    assert.equal(LIGHT_AUTO[key], LIGHT[key], `${key} must match in the system-light block`);
  }
  assert.ok(Object.keys(DARK).filter((k) => k.startsWith("--sc-")).length >= 17, "dark tokens exist");
});

test("new styles use theme tokens, respect reduced motion, and print rules sit in the one print block", () => {
  const start = STYLE.indexOf("/* ── Lab builder: Screenshot Center");
  const end = STYLE.indexOf("/* ── Lab builder: blocked-build decisions");
  assert.ok(start > 0 && end > start);
  const region = STYLE.slice(start, end);
  assert.doesNotMatch(region, /#[0-9a-f]{3,8}\b(?!-)|(?<![\w-])(?:white|black)(?![\w-])/i, "no hard-coded colors in the new CSS");
  assert.match(region, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.sc-bar-fill \{ transition: none; \}/);
  assert.match(region, /@media \(max-width: 900px\)[\s\S]*\.sc-steps \{ grid-template-columns: 1fr; \}/);
  assert.match(region, /@media \(max-width: 560px\)[\s\S]*\.sc-grid \{ grid-template-columns: 1fr; \}/);
  assert.match(region, /\.sc-grid \{[^}]*repeat\(auto-fill, minmax\(240px, 1fr\)\)/);
  assert.match(STYLE, /:where\(a, button, input, select, textarea, summary, \[tabindex\]\):focus-visible/, "one visible focus ring for every control");
  assert.match(region, /\.sc-primary-btn \{[^}]*min-height: 44px/);

  assert.equal(STYLE.split("@media print").length, 2, "there is exactly one print block");
  const printCss = STYLE.split("@media print")[1];
  for (const selector of [".sc-center", ".sc-lightbox", ".lb-checklist", ".lb-capture-on-build-opt", "#lb-result-checklist"]) {
    assert.ok(printCss.includes(selector), `${selector} is hidden in the print block`);
  }
  const screenCss = STYLE.split("@media print")[0];
  assert.ok(screenCss.includes(".sc-card {") && screenCss.includes(".lb-checklist {"), "the new rules are screen CSS, before the print block");
});

test("the copy confirmation uses theme-aware tokens that meet WCAG AA in both themes, fades only when motion is allowed, and hides in print", () => {
  for (const [name, t] of [["dark", DARK], ["light", LIGHT], ["light (system)", LIGHT_AUTO]]) {
    for (const [tone, what] of [["ok", "success"], ["warn", "failure"]]) {
      const text = contrast(t[`--sc-${tone}-fg`], t[`--sc-${tone}-bg`]);
      assert.ok(text >= 4.5, `${name}: ${what} message text is ${text.toFixed(2)}:1, needs 4.5:1`);
      assert.ok(text >= 3, `${name}: the ${what} icon needs 3:1`);
    }
    for (const surface of ["--surface", "--preview-muted-bg"]) {
      assert.ok(contrast(t["--sc-ok-border"], t[surface]) >= 1.5, `${name}: the success pill edge is distinguishable on ${surface}`);
    }
  }
  const rule = (selector) => STYLE.match(new RegExp(`${selector.replace(/[.]/g, "\\.")} \\{([^}]*)\\}`))?.[1] || "";
  const ok = rule(".sc-copy-ack-ok");
  assert.match(ok, /background: var\(--sc-ok-bg\)/);
  assert.match(ok, /color: var\(--sc-ok-fg\)/);
  assert.match(ok, /border-color: var\(--sc-ok-border\)/);
  const fail = rule(".sc-copy-ack-fail");
  assert.match(fail, /var\(--sc-warn-bg\)/);
  assert.doesNotMatch(fail, /--sc-ok|--success/, "the failure message is never green");
  assert.match(ok, /animation: sc-copy-ack-fade 3s /, "the fade matches the three-second window");
  assert.match(STYLE, /@media \(prefers-reduced-motion: reduce\)\s*\{[^@]*\.sc-copy-ack-ok \{ animation: none; \}/, "reduced motion shows and hides without animating");
  assert.match(rule(".sc-copy-ack:empty"), /display: none/, "nothing takes space before a copy");
  assert.match(STYLE, /\.sc-code, \.sc-command \{[^}]*user-select: all/, "one click selects the whole code or command");

  assert.equal(STYLE.split("@media print").length, 2, "there is exactly one print block");
  assert.ok(STYLE.split("@media print")[1].includes(".sc-copy-ack,"), "the confirmation is hidden in the main print block");
  assert.ok(!STYLE.split("@media print")[0].includes("@media print"), "and no earlier print rule was added");
});

test("the Screenshot Center scripts load in order and its live regions are announced politely", async () => {
  const at = (name) => INDEX_HTML.indexOf(`<script src="${name}" defer></script>`);
  const order = ["generated-labs.js", "screenshot-center-core.js", "screenshot-center-command.js", "screenshot-center-jobs.js", "screenshot-center.js", "lab-checklist.js", "lab-customize.js"].map(at);
  assert.ok(order.every((i) => i > 0), "every script tag exists and is deferred");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "generated-labs, then the center, then the checklist, then lab-customize");

  const h = makeHarness();
  await h.render(stateFor([shot({ filename: "a.png" })]));
  const live = h.host.querySelector("#lb-screenshots-live");
  assert.deepEqual([live.getAttribute("role"), live.getAttribute("aria-live"), live.getAttribute("aria-atomic")], ["status", "polite", "true"]);
  assert.ok(live.classList.contains("sr-only"));
  const sameNode = live;
  h.run("scRerender")(LAB);
  assert.equal(h.host.querySelector("#lb-screenshots-live"), sameNode, "the live region survives a re-render, so announcements are not lost");
  assert.equal(h.center().getAttribute("aria-labelledby"), "lb-screenshots-heading");
  assert.equal(h.center().querySelector("#lb-screenshots-heading").getAttribute("tabindex"), "-1");
  for (const button of h.center().querySelectorAll("button")) {
    assert.ok(button.textContent.trim() || button.getAttribute("aria-label"), "every button has a name");
  }
  for (const label of h.center().querySelectorAll("label[for]")) {
    assert.ok(h.center().querySelector(`#${label.getAttribute("for")}`), `label for=${label.getAttribute("for")} points at a control`);
  }

  const centerSource = ["screenshot-center-core.js", "screenshot-center-command.js", "screenshot-center-jobs.js", "screenshot-center.js", "lab-checklist.js"].map(publicFile).join("\n");
  const withoutCli = centerSource.replace(/^.*--generated-lab=.*$/m, "");
  assert.doesNotMatch(withoutCli, /Playwright|Learn Sync|\.auth|headed|headless/i, "technical terms only appear in the command-line fallback");
  assert.doesNotMatch(centerSource, /\b(colour|behaviour|centre|licence|organis|catalogue|favourite)\w*/i, "US English only");
});

// ── Which account the screenshots come from ─────────────────────────────────

const ACCOUNT_GOOD = { mode: "separate", source: "manual", verified: true, verifiedFor: "agent", osWorkAccountDetected: true, browser: "chromium", inOsTenant: false, inPrivate: false };
const ACCOUNT_SSO = { mode: "separate", source: "windows-sso", verified: false, verifiedFor: null, osWorkAccountDetected: true, browser: "edge", inOsTenant: true, inPrivate: false };
const FAKE_TENANT = "0a1b2c3d-1111-4222-8333-444455556666";
const FAKE_UPN = "ada.fake@example.invalid";

function accountStatus(account, { setup = null, supported = true, devices = [device()] } = {}) {
  const status = statusPayload({ devices, signedIn: ["copilot-studio"] });
  if (account !== undefined) status.companion.account = account;
  status.companion.accountSupported = supported;
  status.companion.accountMinCompanion = "1.5.0";
  if (setup) status.companion.accountSetup = setup;
  return status;
}

test("the account line says exactly which account the computer uses, in plain words and never an id", () => {
  const h = makeHarness();
  const model = (companion) => json(h.run("scAccountModel")(companion));
  assert.equal(model(null), null);
  assert.equal(model({ connected: false, account: ACCOUNT_GOOD }), null, "nothing to say before a computer is connected");

  const old = model({ connected: true, account: null, accountMinCompanion: "1.5.0" });
  assert.equal(old.state, "not-reported");
  assert.equal(old.text, "Account not reported (update the companion)");
  assert.match(old.help, /older than 1\.5\.0.*--browser=chromium/);
  assert.equal(old.fix, null, "an older companion cannot choose an account, so there is no button");

  const good = model({ connected: true, account: ACCOUNT_GOOD, accountSupported: true });
  assert.deepEqual([good.state, good.tone, good.fix], ["verified", "ok", null]);
  assert.equal(good.text, "Account: separate sign-in (browser: Chromium), verified for your agent.");

  const sso = model({ connected: true, account: ACCOUNT_SSO, accountSupported: true });
  assert.deepEqual([sso.state, sso.tone], ["windows-account", "warn"]);
  assert.equal(sso.text, "Account: your Windows work account (Edge single sign-on). Screenshots will come from that account.");
  assert.deepEqual(sso.fix, { id: "account-setup", label: "Choose which account to use" });

  const unverified = model({ connected: true, account: { ...ACCOUNT_GOOD, verified: false, verifiedFor: null }, accountSupported: true });
  assert.deepEqual([unverified.state, unverified.tone], ["unverified", "neutral"]);
  assert.match(unverified.text, /^Account: separate sign-in \(browser: Chromium\)\. Account not verified\.$/);
  assert.match(unverified.help, /Automatic capture waits until the account is chosen/);
  assert.equal(unverified.fix.label, "Choose which account to use");

  const confirmed = model({ connected: true, account: { ...ACCOUNT_GOOD, verifiedFor: null }, accountSupported: true });
  assert.equal(confirmed.text, "Account: separate sign-in (browser: Chromium), confirmed by you.");

  const same = model({ connected: true, account: { ...ACCOUNT_GOOD, inOsTenant: true }, accountSupported: true });
  assert.deepEqual([same.state, same.tone], ["same-as-windows", "warn"]);
  assert.match(same.text, /It is the same account Windows uses for work\.$/);
  assert.ok(same.fix);

  const inPrivate = model({ connected: true, account: { ...ACCOUNT_GOOD, browser: "edge", inPrivate: true }, accountSupported: true });
  assert.match(inPrivate.text, /\(browser: Edge, InPrivate\)/);
  const windows = model({ connected: true, account: { ...ACCOUNT_GOOD, mode: "windows", browser: "edge" }, accountSupported: true });
  assert.match(windows.text, /with your Windows work account allowed \(browser: Edge\), verified for your agent\./);

  // Junk from the network is trimmed to known words, and a sentence from the computer never carries an address, an account, or an id.
  const junk = model({ connected: true, account: { mode: "x", source: FAKE_UPN, browser: "<img src=x onerror=alert(1)>", verifiedFor: FAKE_TENANT, verified: true }, accountSupported: true });
  assert.doesNotMatch(junk.text, /img|onerror|ada\.fake|0a1b2c3d/);
  const setup = model({ connected: true, account: ACCOUNT_GOOD, accountSetup: { state: "failed", message: `Went to https://copilotstudio.microsoft.com/environments/Default-${FAKE_TENANT}/home as ${FAKE_UPN}` } }).setup;
  assert.equal(setup.text, "Went to as");
  assert.deepEqual(json(h.run("scAccountSetupLine")({ state: "bogus" })), null);
  assert.match(json(h.run("scAccountSetupLine")({ state: "waiting-for-you" })).text, /Sign in in the browser window on your computer, with the account you want\. You choose the account yourself\./);
  assert.equal(json(h.run("scAccountSetupLine")({ state: "requested" })).busy, true);
  assert.equal(json(h.run("scAccountSetupLine")({ state: "done" })).busy, false);
});

test("the account line shows under the setup steps with a warning and one button when it is not what the person wants", async () => {
  const h = makeHarness();
  await h.setStatus(accountStatus(ACCOUNT_SSO));
  await h.render(stateFor([shot({ filename: "a.png" })]));
  const line = h.host.querySelector("[data-sc-account]");
  assert.ok(line, "the account line is on the page");
  assert.equal(line.dataset.scAccount, "windows-account");
  assert.ok(line.classList.contains("sc-account-warn"));
  assert.equal(line.getAttribute("role"), "group");
  assert.equal(line.getAttribute("aria-label"), "Which account the screenshots come from");
  assert.equal(h.text("[data-sc-account-text]"), "Account: your Windows work account (Edge single sign-on). Screenshots will come from that account.");
  assert.ok(line.querySelectorAll(".sc-chip").some((c) => c.textContent === "Check this"), "the warning is also in words, not only in color");
  const button = h.action("account-setup", line);
  assert.equal(button.tagName, "BUTTON", "a real button, reachable by keyboard");
  assert.equal(button.textContent, "Choose which account to use");
  assert.ok(button.classList.contains("btn-primary"), "the one-click fix is the highlighted action");
  const status = line.querySelector("[data-sc-account-setup]");
  assert.deepEqual([status.getAttribute("role"), status.getAttribute("aria-live")], ["status", "polite"], "progress is announced politely");
  assert.equal(status.hasAttribute("hidden"), true, "nothing to say yet");

  // Placed after the setup steps and before the automatic-capture line.
  const html = h.center().children.map((c) => c.className);
  assert.ok(html.findIndex((c) => /sc-steps/.test(c)) < html.findIndex((c) => /sc-account/.test(c)));

  // A good account has no button and no warning.
  await h.setStatus(accountStatus(ACCOUNT_GOOD));
  await h.render(stateFor([shot({ filename: "a.png" })]));
  const ok = h.host.querySelector("[data-sc-account]");
  assert.equal(ok.dataset.scAccount, "verified");
  assert.ok(ok.classList.contains("sc-account-ok"));
  assert.equal(h.action("account-setup", ok), null);
  assert.equal(h.text("[data-sc-account-text]"), "Account: separate sign-in (browser: Chromium), verified for your agent.");

  // Before any computer is connected there is nothing to say.
  await h.setStatus(statusPayload({ devices: [] }));
  await h.render(stateFor([shot({ filename: "a.png" })]));
  assert.equal(h.host.querySelector("[data-sc-account]"), null);
});

test("a companion from before account checks is told to update, with no button that could not work", async () => {
  const h = makeHarness();
  await h.setStatus(accountStatus(undefined, { supported: false, devices: [device({ companionVersion: "1.4.0" })] }));
  await h.render(stateFor([shot({ filename: "a.png" })]));
  const line = h.host.querySelector("[data-sc-account]");
  assert.equal(line.dataset.scAccount, "not-reported");
  assert.equal(h.text("[data-sc-account-text]"), "Account not reported (update the companion)");
  assert.match(h.text("[data-sc-account-help]"), /Download it again and replace the old one/);
  assert.equal(h.action("account-setup", line), null);
});

test("choosing the account asks the computer, announces what to do, follows the setup on the computer, and never types or clicks for the person", async () => {
  const h = makeHarness();
  await h.setStatus(accountStatus(ACCOUNT_SSO));
  h.route("POST", /\/api\/capture\/account-setup$/, { status: 202, body: { requested: true, id: "cmd_0123456789ab", product: "copilot-studio", deviceName: "Ada PC", message: "Look for a new browser window on Ada PC. Sign in there with the account you want your screenshots to come from. You choose the account yourself; the computer never clicks for you." } });
  await h.render(stateFor([shot({ filename: "a.png" })]));
  await h.click(h.action("account-setup"));
  const posts = h.callsTo("POST", /account-setup$/);
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body, { product: "copilot-studio", labId: LAB });
  assert.match(h.live(), /Look for a new browser window on Ada PC/, "the instruction is announced");

  // The computer reports that it is waiting for the person; the page notices without a reload.
  h.status = accountStatus(ACCOUNT_SSO, { setup: { id: "cmd_0123456789ab", product: "copilot-studio", state: "waiting-for-you", message: "Sign in to Microsoft Copilot Studio in the browser window on your computer, with the account you want." } });
  h.advance(3100);
  await h.flush();
  const status = h.host.querySelector("[data-sc-account-setup]");
  assert.equal(status.dataset.scAccountSetup, "waiting-for-you");
  assert.match(status.textContent, /Sign in to Microsoft Copilot Studio in the browser window on your computer/);
  assert.equal(status.hasAttribute("hidden"), false);
  const waiting = h.action("account-setup");
  assert.equal(waiting.textContent, "Waiting for your computer");
  assert.equal(waiting.hasAttribute("disabled"), true, "no second request while the first is open");

  // The person chose their account; the page shows it and stops polling.
  h.status = accountStatus(ACCOUNT_GOOD, { setup: { id: "cmd_0123456789ab", product: "copilot-studio", state: "done", message: "The account is chosen and saved." } });
  h.advance(3100);
  await h.flush();
  assert.equal(h.text("[data-sc-account-text]"), "Account: separate sign-in (browser: Chromium), verified for your agent.");
  assert.equal(h.host.querySelector("[data-sc-account-setup]").textContent, "The account is chosen and saved.");
  assert.match(h.live(), /The account is chosen and saved\./);
  const before = h.callsTo("GET", /\/api\/capture\/status$/).length;
  h.advance(10_000);
  await h.flush();
  assert.equal(h.callsTo("GET", /\/api\/capture\/status$/).length, before, "polling stopped once the setup ended");
});

test("when the portal cannot ask the computer, the person is told why and can try again", async () => {
  const h = makeHarness();
  await h.setStatus(accountStatus(ACCOUNT_SSO));
  h.route("POST", /\/api\/capture\/account-setup$/, { status: 409, body: { error: "Your computer is capturing right now. Choose the account when the capture has finished.", code: "busy" } });
  await h.render(stateFor([shot({ filename: "a.png" })]));
  await h.click(h.action("account-setup"));
  const status = h.host.querySelector("[data-sc-account-setup]");
  assert.equal(status.textContent, "Your computer is capturing right now. Choose the account when the capture has finished.");
  assert.ok(status.classList.contains("sc-account-setup-warn"));
  assert.equal(h.action("account-setup").hasAttribute("disabled"), false, "the person can try again");
  assert.match(h.live(), /capturing right now/);

  h.route("POST", /\/api\/capture\/account-setup$/, { throws: "offline" });
  await h.click(h.action("account-setup"));
  assert.match(h.host.querySelector("[data-sc-account-setup]").textContent, /Check your connection and try again/);
});

test("nothing the computer says about the account can add markup or show an id, and a made-up setup state is ignored", async () => {
  const h = makeHarness();
  const evil = "<img src=x onerror=alert(1)><b>bold</b>";
  await h.setStatus(accountStatus({ ...ACCOUNT_SSO, browser: evil, source: evil, verifiedFor: evil }, { setup: { id: "cmd_0123456789ab", product: "copilot-studio", state: "failed", message: `${evil} https://x.example/${FAKE_TENANT} ${FAKE_UPN}` } }));
  await h.render(stateFor([shot({ filename: "a.png" })]));
  const line = h.host.querySelector("[data-sc-account]");
  assert.equal(line.querySelectorAll("img").length, 0);
  assert.equal(line.querySelectorAll("b").length, 0);
  assert.doesNotMatch(line.textContent, /ada\.fake|0a1b2c3d|https?:/, "no tenant id, address, or account name on the page");
  assert.match(line.querySelector("[data-sc-account-setup]").textContent, /^<img src=x onerror=alert\(1\)><b>bold<\/b>$/, "markup arrives as plain text, never as elements");
  await h.setStatus(accountStatus(ACCOUNT_GOOD, { setup: { state: "hacked", message: "x" } }));
  await h.render(stateFor([shot({ filename: "a.png" })]));
  assert.equal(h.host.querySelector("[data-sc-account-setup]").hasAttribute("hidden"), true);
});

test("the consent card says which account the computer will use and that automatic capture waits for it", async () => {
  const h = makeHarness();
  await h.setStatus({ ...accountStatus(ACCOUNT_GOOD), autonomy: { loaded: true, consented: false, level: null, rules: { never: [], tiers: [] }, companionSupported: true, minCompanion: "1.4.0" } });
  await h.render(stateFor([shot({ filename: "a.png" })]));
  await h.click(h.action("consent-open"));
  const card = h.host.querySelector("[data-sc-consent]");
  assert.ok(card);
  const account = card.querySelector("[data-sc-consent-account]");
  assert.equal(account.textContent, "The computer will use this account: separate sign-in (browser: Chromium), verified for your agent.");
  assert.equal(account.dataset.scConsentAccount, "verified");
  assert.match(card.textContent, /Automatic capture also waits until the account is verified against your own agent or site address, or you have chosen it once/);

  await h.setStatus({ ...accountStatus(ACCOUNT_SSO), autonomy: { loaded: true, consented: false, level: null, rules: { never: [], tiers: [] }, companionSupported: true, minCompanion: "1.4.0" } });
  h.run("scRerender")(LAB);
  assert.match(h.host.querySelector("[data-sc-consent-account]").textContent, /^The computer will use this account: your Windows work account \(Edge single sign-on\)\. Screenshots will come from that account\.$/);
  const none = makeHarness();
  await none.setStatus({ ...statusPayload({ devices: [] }), autonomy: { loaded: true, consented: false, level: null, rules: { never: [], tiers: [] }, companionSupported: true, minCompanion: "1.4.0" } });
  await none.render(stateFor([shot({ filename: "a.png" })]));
  await none.click(none.action("consent-open"));
  assert.match(none.host.querySelector("[data-sc-consent-account]").textContent, /Connect your computer to see which account that is/);
});

test("a capture that stopped on the account gets one plain sentence and the same one-click fix", async () => {
  const h = makeHarness();
  await h.setStatus(accountStatus(ACCOUNT_SSO));
  h.route("POST", /\/api\/capture\/account-setup$/, { status: 202, body: { requested: true, message: "Look for a new browser window." } });
  const rows = [
    { filename: "a.png", status: "needs-account", attempts: 1, cause: "needs-account" },
    { filename: "b.png", status: "needs-account", attempts: 1, cause: "needs-account" },
  ];
  const sentence = "Edge signed in automatically with your Windows work account, not the account that owns this agent. Restart with --browser=chromium, or run --setup-account.";
  const job = jobFor([shot({ filename: "a.png" }), shot({ filename: "b.png" })], {
    status: "failed",
    error: sentence,
    shots: rows,
    progress: { total: 2, done: 2, captured: 0, needsReview: 0, failed: 2, manual: 0, skipped: 0, running: 0, pending: 0, percent: 100 },
    causes: [{ code: "needs-account", title: "Signed in to the wrong account", fix: "Choose which account to use: sign in with the account that owns your agent or site (for example your demo tenant), then retake.", fixAction: "account", tone: "warn", count: 2, filenames: ["a.png", "b.png"] }],
    result: { needsAccount: { code: "windows-account", product: "copilot-studio", message: sentence }, account: ACCOUNT_SSO },
  });
  const outcome = json(h.run("scOutcomeFromJob")(job));
  assert.equal(outcome.needsAccount.code, "windows-account");
  assert.equal(outcome.causes[0].fixAction, "account");
  assert.match(outcome.message, /Capture did not finish\. Edge signed in automatically with your Windows work account/);
  assert.equal(json(h.run("scDescribeJob")(job)).phase, "failed");
  const running = jobFor([shot({ filename: "a.png" })], { status: "running", claim: { lastActivityAt: new Date(NOW).toISOString() }, shots: [{ filename: "a.png", status: "needs-account", attempts: 1 }] });
  assert.equal(json(h.run("scDescribeJob")(running)).phase, "needs-account");
  assert.equal(json(h.run("scDescribeJob")(running)).headline, "Wrong account on your computer");

  await h.render(stateFor([shot({ filename: "a.png" }), shot({ filename: "b.png", id: 2 })]), { outcome });
  const banner = h.host.querySelector("[data-sc-banner]");
  const fix = banner.querySelector('[data-sc-cause="needs-account"] [data-sc-action="cause-fix"]');
  assert.equal(fix.textContent, "Choose which account to use");
  await h.click(fix);
  assert.equal(h.callsTo("POST", /account-setup$/).length, 1, "the cause's fix asks the computer to open the sign-in window");
  assert.equal(json(h.run("scShotStatus")({ captured: false }, null, { status: "needs-account" })).key, "failed", "the shot shows as failed");
  assert.equal(json(h.run("scProgressFromShots")(rows)).failed, 2);
});

test("the account styles use theme tokens, keep AA contrast in every theme, and add no print rules", () => {
  for (const [name, t] of [["dark", DARK], ["light", LIGHT], ["light (system)", LIGHT_AUTO]]) {
    assert.ok(contrast(t["--text"], t["--surface"]) >= 4.5, `${name}: the account line text on its surface`);
    for (const tone of ["info", "warn"]) assert.ok(contrast(t[`--sc-${tone}-fg`], t[`--sc-${tone}-bg`]) >= 4.5, `${name}: the setup status (${tone})`);
    for (const tone of ["ok", "warn", "neutral"]) assert.ok(contrast(t[`--sc-${tone}-border`], t["--surface"]) >= 1.5, `${name}: the ${tone} edge is visible on the surface`);
  }
  const screenCss = STYLE.split("@media print")[0];
  const rule = (selector) => screenCss.match(new RegExp(`${selector.replace(/[.\[\]]/g, "\\$&")} \\{([^}]*)\\}`))?.[1] || "";
  assert.match(rule(".sc-account"), /background: var\(--surface\)/);
  assert.match(rule(".sc-account-ok"), /border-left-color: var\(--sc-ok-border\)/);
  assert.match(rule(".sc-account-warn"), /border-left-color: var\(--sc-warn-border\)/);
  assert.match(rule(".sc-account-text"), /color: var\(--text\)/);
  assert.match(rule(".sc-account-setup"), /background: var\(--sc-info-bg\)[^}]*color: var\(--sc-info-fg\)/);
  assert.match(rule(".sc-account-setup-warn"), /var\(--sc-warn-bg\)[^}]*var\(--sc-warn-fg\)/);
  for (const selector of [".sc-account", ".sc-account-head", ".sc-account-setup", ".sc-banner-account"]) assert.ok(screenCss.includes(`${selector} {`), `${selector} is screen CSS`);
  assert.equal(STYLE.split("@media print").length, 2, "there is still exactly one print block");
  const printCss = STYLE.split("@media print")[1];
  assert.doesNotMatch(printCss.split("\n    @media")[0], /\.sc-account/, "no account-specific print rule: the whole Center is already hidden in print");
  assert.ok(printCss.includes(".sc-center,"), "the Center, and so the account line, is hidden in print");
});

// ── Capture once, reuse everywhere ──────────────────────────────────────────

const reusedShot = (name, extra = {}) =>
  captured(name, { imageSource: "library", imageCapturedAt: "2026-05-12T12:00:00.000Z", confirmed: null, share: { state: "shared", libraryConfirmed: false }, ...extra });
const ownShot = (name, extra = {}) =>
  captured(name, { imageSource: "lab", imageCapturedAt: "2026-05-20T12:00:00.000Z", confirmed: null, share: { state: "not-shared", libraryConfirmed: false }, ...extra });
const confirmedAt = "2026-06-01T12:00:00.000Z";

test("each picture says where it lives: the shared library for every lab, or this lab only, with the date it was captured", async () => {
  const h = makeHarness();
  const SHARED = "Shared library (every lab can use it)";
  const LAB_ONLY = "This lab only (will be kept for 90 days if you delete or replace this lab)";
  await h.render(stateFor([reusedShot("a.png"), ownShot("b.png", { id: 2 }), shot({ filename: "c.png", id: 3 })]));
  assert.equal(h.card("a.png").querySelector(".sc-source").textContent, `${SHARED} \u00b7 captured May 12, 2026`);
  assert.equal(h.card("b.png").querySelector(".sc-source").textContent, `${LAB_ONLY} \u00b7 captured May 20, 2026`);
  assert.equal(h.card("c.png").querySelector(".sc-source"), null, "a screenshot with no picture has no source");
  assert.deepEqual(["a.png", "b.png", "c.png"].map((n) => h.card(n).querySelector(".sc-status-chip").textContent), ["Captured", "Captured", "Pending"], "a reused picture is Captured, never Pending");
  assert.equal(h.card("a.png").querySelector(".sc-note").textContent, "", "the source line carries the date, so the note does not repeat a wrong one");
  assert.match(h.card("b.png").querySelector(".sc-note").textContent, /^Captured on your computer\.$/);
  assert.equal(h.host.querySelector(".sc-confirm-summary").textContent.startsWith("0 of 2 captured screenshots confirmed accurate."), true);
  assert.match(h.host.querySelector(".sc-confirm-summary").textContent, /Confirming is optional and never blocks your lab or its downloads\./);

  // A lab-only picture that could be shared says what sharing does; one the library already holds is shared, and says so.
  assert.match(h.card("b.png").querySelector(".sc-share-note").textContent, /^Other labs cannot use this picture yet\. Use this one for every lab lets every lab that has no picture of its own show it\./);
  assert.equal(h.card("a.png").querySelector(".sc-share-note"), null);
  const held = makeHarness();
  await held.render(stateFor([ownShot("d.png", { share: { state: "shared", libraryConfirmed: false } }), ownShot("e.png", { id: 2, share: { state: "lab-only" } })]));
  assert.equal(held.card("d.png").querySelector(".sc-source").textContent, `${SHARED} \u00b7 captured May 20, 2026`, "the lab's own copy of a shared picture is shared too");
  assert.equal(held.card("e.png").querySelector(".sc-source").textContent, `${LAB_ONLY} \u00b7 captured May 20, 2026`);
  assert.equal(held.card("e.png").querySelector(".sc-share-note"), null, "a picture that cannot be shared has no offer to explain");
});

test("Mark as accurate, the Confirmed badge with its date, and Clear confirmation", async () => {
  const h = makeHarness();
  const before = stateFor([ownShot("a.png"), ownShot("b.png", { id: 2 })]);
  const after = stateFor([ownShot("a.png", { confirmed: { at: confirmedAt } }), ownShot("b.png", { id: 2 })]);
  await h.render(before);
  assert.equal(h.card("a.png").querySelector(".sc-confirmed-chip"), null);
  assert.equal(h.cardAction("a.png", "shot-confirm").getAttribute("aria-label"), "Mark as accurate: Figure 1.1: Agents page");
  h.route("POST", /\/screenshots\/a\.png\/confirm$/, { status: 200, body: { outcome: "confirmed", filename: "a.png", scope: "lab", confirmed: { at: confirmedAt }, state: after } });
  await h.click(h.cardAction("a.png", "shot-confirm"));
  assert.equal(h.callsTo("POST", /\/screenshots\/a\.png\/confirm$/).length, 1);
  assert.equal(h.card("a.png").querySelector(".sc-confirmed-chip").textContent, "Confirmed Jun 1, 2026");
  assert.equal(h.cardAction("a.png", "shot-confirm"), null);
  assert.equal(h.cardAction("a.png", "shot-unconfirm").textContent, "Clear confirmation");
  assert.equal(h.card("b.png").querySelector(".sc-confirmed-chip"), null, "only the confirmed picture carries the badge");
  assert.match(h.live(), /Marked as accurate\./);

  h.route("DELETE", /\/screenshots\/a\.png\/confirm$/, { status: 200, body: { outcome: "unconfirmed", filename: "a.png", scope: "lab", state: before } });
  await h.click(h.cardAction("a.png", "shot-unconfirm"));
  assert.equal(h.card("a.png").querySelector(".sc-confirmed-chip"), null);
  assert.ok(h.cardAction("a.png", "shot-confirm"));
});

test("the preview dialog has the same buttons and shows the source and the Confirmed badge", async () => {
  const h = makeHarness();
  await h.render(stateFor([ownShot("a.png", { confirmed: { at: confirmedAt } }), reusedShot("b.png", { id: 2 })]));
  await h.click(h.cardAction("a.png", "preview"));
  const dialog = h.center().querySelector("dialog.sc-lightbox");
  assert.equal(dialog.querySelector(".sc-lb-source").textContent, "This lab only (will be kept for 90 days if you delete or replace this lab) \u00b7 captured May 20, 2026");
  assert.equal(dialog.querySelector(".sc-confirmed-chip").textContent, "Confirmed Jun 1, 2026");
  assert.ok(dialog.querySelector('[data-sc-action="shot-unconfirm"]'), "Clear confirmation is in the dialog too");
  await h.click(dialog.querySelector('[data-sc-action="lightbox-next"]'));
  assert.equal(dialog.querySelector(".sc-lb-source").textContent, "Shared library (every lab can use it) \u00b7 captured May 12, 2026");
  assert.ok(dialog.querySelector('[data-sc-action="shot-confirm"]'), "Mark as accurate is in the dialog too");
});

test("Show only screenshots not confirmed yet filters the gallery and counts only pictures that exist", async () => {
  const h = makeHarness();
  await h.render(stateFor([ownShot("a.png", { confirmed: { at: confirmedAt } }), ownShot("b.png", { id: 2 }), reusedShot("c.png", { id: 3 }), shot({ filename: "d.png", id: 4 })]));
  assert.equal(h.host.querySelector("[data-sc-unconfirmed-label]").textContent, "Show only screenshots not confirmed yet (2)", "a pending screenshot is not counted");
  const box = h.center().querySelector("#sc-only-unconfirmed");
  box.checked = true;
  box.dispatchEvent(h.event("change"));
  assert.deepEqual(h.host.querySelectorAll(".sc-card").map((c) => c.dataset.filename), ["b.png", "c.png"]);
  box.checked = false;
  box.dispatchEvent(h.event("change"));
  assert.equal(h.host.querySelectorAll(".sc-card").length, 4);

  const allConfirmed = makeHarness();
  await allConfirmed.render(stateFor([ownShot("a.png", { confirmed: { at: confirmedAt } })]));
  const only = allConfirmed.center().querySelector("#sc-only-unconfirmed");
  only.checked = true;
  only.dispatchEvent(allConfirmed.event("change"));
  assert.equal(allConfirmed.host.querySelector(".scenario-empty").textContent, "Every captured screenshot is confirmed. Clear the filter to see them all.");
});

test("a confirmation never changes the checklist numbers, the primary button, or what is queued by default", async () => {
  const plain = [ownShot("a.png"), reusedShot("b.png", { id: 2 }), shot({ filename: "c.png", id: 3 })];
  const marked = [ownShot("a.png", { confirmed: { at: confirmedAt } }), reusedShot("b.png", { id: 2, confirmed: { at: confirmedAt } }), shot({ filename: "c.png", id: 3 })];
  const view = async (shots) => {
    const h = makeHarness();
    await h.setStatus(statusPayload({ devices: [device()] }));
    await h.render(stateFor(shots));
    return { checklist: json(h.run("lbChecklistInput")(LAB)), counts: json(h.run("scCounts")(stateFor(shots))), primary: h.text(".sc-primary-btn") };
  };
  assert.deepEqual(await view(marked), await view(plain));
  assert.equal((await view(plain)).counts.toCapture, 1, "only the screenshot with no picture is queued");
  assert.equal((await view(plain)).counts.captured, 2, "a reused picture counts as captured");
});

test("Retake of a shared picture asks first when other labs use it, in plain words, and Cancel changes nothing", async () => {
  const state = stateFor([reusedShot("a.png")]);
  const h = makeHarness();
  await h.setStatus(statusPayload({ devices: [device()] }));
  await h.render(state);
  h.route("GET", /\/api\/capture\/library\/screenshots\/a\.png\/usage\?labId=lab-test-1$/, { status: 200, body: { filename: "a.png", hasPicture: true, otherLabs: 2, confirmed: false } });
  h.route("DELETE", /\/screenshots\/a\.png$/, { status: 200, body: { outcome: "reset", state } });
  h.route("POST", /\/api\/capture\/jobs$/, { status: 201, body: { job: jobFor([state.shots[0]]) } });
  h.calls.length = 0;

  await h.click(h.cardAction("a.png", "shot-retake"));
  const ask = h.card("a.png").querySelector(".sc-ask");
  assert.equal(ask.querySelector(".sc-ask-title").textContent, "Other labs use this picture.");
  assert.equal(ask.querySelector(".sc-ask-text").textContent, "This picture is shared. 2 other labs use it. A new capture replaces it for all of them. The old picture is kept as a backup.");
  assert.equal(h.callsTo("DELETE", /screenshots/).length + h.callsTo("POST", /jobs/).length, 0, "nothing happens before the answer");
  assert.equal(h.document.activeElement.textContent, "Cancel", "Cancel has the focus, so Enter does not replace anything by accident");

  await h.click(ask.querySelector('[data-sc-action="ask-cancel"]'));
  assert.equal(h.host.querySelector(".sc-ask"), null);
  assert.equal(h.callsTo("DELETE", /screenshots/).length + h.callsTo("POST", /jobs/).length, 0);

  await h.click(h.cardAction("a.png", "shot-retake"));
  await h.click(h.host.querySelector('[data-sc-action="ask-yes"]'));
  assert.equal(h.callsTo("DELETE", /screenshots\/a\.png$/).length, 0, "the picture is never removed first");
  const body = h.callsTo("POST", /\/api\/capture\/jobs$/)[0].body;
  assert.equal(body.options.retake, true, "the capture may replace the shared picture");
  assert.deepEqual(body.scope, { mode: "selected", filenames: ["a.png"] });

  // A picture nobody else uses is retaken without a question; one marked accurate says it stays in this lab.
  const alone = makeHarness();
  await alone.setStatus(statusPayload({ devices: [device()] }));
  await alone.render(state);
  alone.route("GET", /\/usage\?labId=/, { status: 200, body: { filename: "a.png", hasPicture: true, otherLabs: 0, confirmed: false } });
  alone.route("DELETE", /\/screenshots\/a\.png$/, { status: 200, body: { outcome: "reset", state } });
  alone.route("POST", /\/api\/capture\/jobs$/, { status: 201, body: { job: jobFor([state.shots[0]]) } });
  await alone.click(alone.cardAction("a.png", "shot-retake"));
  assert.equal(alone.host.querySelector(".sc-ask"), null);
  assert.equal(alone.callsTo("POST", /\/api\/capture\/jobs$/).length, 1);

  const keeper = makeHarness();
  await keeper.setStatus(statusPayload({ devices: [device()] }));
  await keeper.render(state);
  keeper.route("GET", /\/usage\?labId=/, { status: 200, body: { filename: "a.png", hasPicture: true, otherLabs: 3, confirmed: true } });
  await keeper.click(keeper.cardAction("a.png", "shot-retake"));
  assert.equal(keeper.host.querySelector(".sc-ask-text").textContent, "This shared picture is marked accurate, so other labs keep it. A new capture of it stays in this lab only.");
  assert.equal(keeper.host.querySelector('[data-sc-action="ask-yes"]').textContent, "Retake for this lab");
});

test("Use this one for every lab asks for a clear confirmation, and says when it replaces a picture marked accurate", async () => {
  const state = stateFor([ownShot("a.png", { share: { state: "differs", libraryConfirmed: true } }), ownShot("b.png", { id: 2, share: { state: "shared", libraryConfirmed: false } })]);
  const h = makeHarness();
  await h.render(state);
  assert.equal(h.cardAction("b.png", "shot-share"), null, "a picture the library already has needs no sharing");
  h.route("POST", /\/screenshots\/a\.png\/share$/, { status: 200, body: { outcome: "replaced", filename: "a.png", state } });
  await h.click(h.cardAction("a.png", "shot-share"));
  assert.equal(h.callsTo("POST", /\/share$/).length, 0, "a question comes first");
  const ask = h.card("a.png").querySelector(".sc-ask");
  assert.equal(ask.querySelector(".sc-ask-title").textContent, "This replaces a picture marked accurate.");
  assert.match(ask.querySelector(".sc-ask-text").textContent, /Replacing it clears that mark\..*kept as a backup\. Check that it shows no account names, email addresses, or customer data\.$/);
  await h.click(ask.querySelector('[data-sc-action="ask-yes"]'));
  assert.deepEqual(h.callsTo("POST", /\/share$/)[0].body, { confirm: true, replaceConfirmed: true });
  assert.match(h.card("a.png").querySelector(".sc-feedback").textContent, /Every lab can now use this picture\./);
});

test("Share all of this lab's eligible pictures asks first, then reports what was shared and why the rest was skipped", async () => {
  const state = stateFor([ownShot("a.png"), ownShot("b.png", { id: 2 })]);
  state.summary.capturedInLab = 2;
  const h = makeHarness();
  await h.render(state);
  const button = h.action("share-lab");
  assert.equal(button.textContent, "Share all of this lab's eligible pictures");
  h.route("POST", /\/screenshots\/share$/, {
    status: 200,
    body: { labId: LAB, dryRun: false, promoted: ["a.png"], alreadyShared: [], skipped: [{ filename: "b.png", code: "masking-unproven", message: "We could not confirm that account details are hidden, so this picture stays in this lab." }], counts: { promoted: 1, alreadyShared: 0, skipped: 1, noPicture: 0 }, state },
  });
  await h.click(button);
  assert.equal(h.callsTo("POST", /\/screenshots\/share$/).length, 0, "a question comes first");
  const ask = h.host.querySelector('[data-sc-ask="share-lab"]');
  assert.match(ask.querySelector(".sc-ask-text").textContent, /Nothing in the library is replaced\.$/);
  await h.click(ask.querySelector('[data-sc-action="ask-yes"]'));
  assert.deepEqual(h.callsTo("POST", /\/screenshots\/share$/)[0].body, {});
  const result = h.host.querySelector("[data-sc-share-lab-result]");
  assert.equal(result.querySelector(".sc-feedback-head").textContent, "1 screenshot shared. 0 already in the library. 1 skipped.");
  assert.equal(result.querySelector("li").textContent, "b.png: We could not confirm that account details are hidden, so this picture stays in this lab.");

  const empty = makeHarness();
  await empty.render(stateFor([shot({ filename: "a.png" })]));
  assert.equal(empty.action("share-lab").disabled, true, "nothing to share while the lab has no pictures of its own");
});

test("the shared library says where its pictures are saved, announces found pictures once, and lists kept pictures with Restore and Delete forever", async () => {
  const folder = "C:\\Users\\contoso\\AppData\\Local\\CopilotStudioLabsPortal\\screenshots";
  const library = { location: "persistent", kind: "user-folder", persistent: true, summary: `Shared screenshots are saved on this computer in ${folder}`, folder, total: 325, captured: 12, missing: 313, needsReview: 0, confirmed: 0, kept: { entries: 1, pictures: 2, retentionDays: 90 }, notice: { id: "found-library", count: 12, text: `Found your shared screenshots in ${folder}: 12 pictures are ready to reuse in every lab.` } };
  const h = makeHarness();
  await h.setStatus({ ...statusPayload({ devices: [device()] }), sharedLibrary: library });
  await h.render(stateFor([ownShot("a.png")]));
  assert.equal(h.host.querySelector("[data-sc-library-where]").textContent, `Shared screenshots are saved on this computer in ${folder}`);
  assert.equal(h.host.querySelector(".sc-keep-notice p").textContent, `Found your shared screenshots in ${folder}: 12 pictures are ready to reuse in every lab.`);
  h.route("POST", /\/api\/capture\/library\/notice\/dismiss$/, { status: 200, body: { dismissed: true } });
  await h.click(h.action("keep-notice-dismiss"));
  assert.equal(h.callsTo("POST", /notice\/dismiss$/).length, 1);
  assert.equal(h.host.querySelector(".sc-keep-notice"), null, "the notice is shown once");

  assert.equal(h.host.querySelector("[data-sc-kept-count]").textContent, "2 pictures kept.");
  const entry = {
    id: "contoso-labs-20260301000000-ab12",
    labId: "contoso-labs",
    labTitle: "Contoso Labs",
    reason: "deleted",
    keptAt: "2026-03-01T12:00:00.000Z",
    daysLeft: 62,
    pictures: [
      { filename: "mc-memory-toggle.png", base: "mc-memory-toggle.png", why: "masking-unproven", message: "We could not confirm that account details are hidden.", earlierVersion: false, restore: [{ type: "library" }] },
      { filename: "notes.png", base: "notes.png", why: "lab-only", message: "", earlierVersion: false, restore: [] },
    ],
  };
  h.route("GET", /\/api\/capture\/kept$/, { status: 200, body: { retentionDays: 90, entries: [entry] } });
  await h.click(h.action("keep-load"));
  assert.equal(h.host.querySelector(".sc-keep-entry-head").textContent, "From \u201cContoso Labs\u201d (deleted Mar 1, 2026). 62 days left.");
  const rows = h.host.querySelectorAll(".sc-keep-row");
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /We could not confirm that account details are hidden\./);
  assert.match(rows[0].textContent, /Restore to the shared library/);
  assert.match(rows[1].textContent, /Specific to that lab\./);
  assert.match(rows[1].textContent, /Nowhere to put it back right now, so download it instead\./);
  assert.equal(h.host.querySelectorAll('[data-sc-action="keep-restore"]').length, 1, "a picture with nowhere to go has no Restore");
  assert.equal(rows[1].querySelector("a").getAttribute("href"), `/api/capture/kept/${entry.id}/notes.png?download=1`);

  // Restoring to the shared library asks first (every lab will show it); nothing is sent until the answer.
  h.route("POST", /\/api\/capture\/kept\/[^/]+\/mc-memory-toggle\.png\/restore$/, { status: 200, body: { outcome: "restored", to: "library" } });
  await h.click(h.action("keep-restore"));
  assert.equal(h.callsTo("POST", /\/restore$/).length, 0);
  assert.equal(h.host.querySelector(".sc-keep .sc-ask-title").textContent, "Use this picture for every lab?");
  await h.click(h.action("keep-ask-cancel"));
  assert.equal(h.callsTo("POST", /\/restore$/).length, 0);
  await h.click(h.action("keep-restore"));
  h.route("GET", /\/api\/capture\/kept$/, { status: 200, body: { retentionDays: 90, entries: [{ ...entry, pictures: [entry.pictures[1]] }] } });
  await h.click(h.action("keep-ask-yes"));
  assert.deepEqual(h.callsTo("POST", /\/restore$/)[0].body, { to: "library", confirm: true });
  assert.match(h.host.querySelector(".sc-keep .sc-banner").textContent, /^Restored to the shared library\. Every lab can use it\.$/);

  // Delete forever asks first, in words that say it cannot be undone.
  h.route("DELETE", /\/api\/capture\/kept\/[^/]+\/notes\.png\?confirm=true$/, { status: 200, body: { outcome: "removed" } });
  await h.click(h.action("keep-delete"));
  assert.equal(h.host.querySelector(".sc-keep .sc-ask-text").textContent, "It is removed from the kept pictures and cannot be restored.");
  assert.equal(h.callsTo("DELETE", /kept/).length, 0);
  h.route("GET", /\/api\/capture\/kept$/, { status: 200, body: { retentionDays: 90, entries: [] } });
  await h.click(h.action("keep-ask-yes"));
  assert.equal(h.callsTo("DELETE", /kept/).length, 1);
  assert.equal(h.host.querySelector("[data-sc-kept-none]").textContent, "No pictures are being kept right now.");
});

test("Pictures that look wrong: a calm notice at the top, a panel in Advanced with the plain reason for each, Keep this one, Move to kept pictures, and one question before moving them all", async () => {
  const flagged = (filename, extra = {}) => ({ scope: "library", labId: null, labTitle: null, filename, label: "The AI models page", level: "definite", reason: "This shows the product's start page, but its lab describes a screen inside the product (The AI models page). The computer never opened that screen.", short: "shows a start page, not the screen it should show", flags: [], reach: "landing", writable: true, sha256: "a".repeat(64), ...extra });
  const pictures = [flagged("ppai-ai-models-page.png"), flagged("ppai-ai-hub-menu.png", { label: "The AI hub in the left pane" }), flagged("agent-home.png", { scope: "lab", labId: LAB, level: "probable", label: "Agents page", reason: "This looks the same as “Settings”. They may show the same screen; check that each one shows what its lab describes." })];
  const reply = (list) => ({ status: 200, body: { scannedAt: "2026-06-01T12:00:00.000Z", counts: { total: list.length, definite: list.filter((p) => p.level === "definite").length, probable: list.filter((p) => p.level === "probable").length }, notice: list.length ? `${list.length} ${list.length === 1 ? "picture looks" : "pictures look"} like the wrong screen. Review ${list.length === 1 ? "it" : "them"}.` : "", retentionDays: 90, pictures: list } });
  const h = makeHarness();
  h.route("GET", /\/api\/capture\/suspect-pictures/, reply(pictures));
  await h.setStatus({ ...statusPayload({ devices: [device()] }) });
  await h.render(stateFor([ownShot("agent-home.png")]));
  await h.flush();

  // The notice is one calm line, with one way to review.
  const notice = h.host.querySelector("[data-sc-wrong-notice]");
  assert.equal(notice.querySelector("p").textContent, "3 pictures look like the wrong screen. Review them.");
  assert.equal(notice.getAttribute("role"), "status");
  assert.equal(h.callsTo("GET", /suspect-pictures\?labId=lab-test-1$/).length >= 1, true, "the lab's own pictures are asked about too");
  await h.click(h.action("wrong-review"));
  assert.equal(h.host.querySelector("[data-sc-advanced]").open, true, "Review opens Advanced");

  // The panel lists every flagged picture with its plain reason, where it is, and two buttons a keyboard can reach.
  const panel = h.host.querySelector("[data-sc-wrong-host]");
  assert.equal(panel.querySelector("h6").textContent, "Pictures that look wrong");
  const rows = panel.querySelectorAll("[data-sc-wrong-picture]");
  assert.equal(rows.length, 3);
  assert.match(rows[0].textContent, /Shared library: ppai-ai-models-page\.png\. Clearly the wrong screen\./);
  assert.match(rows[0].textContent, /This shows the product's start page/);
  assert.match(rows[2].textContent, /This lab: agent-home\.png\. Worth a look\./);
  const keep = rows[0].querySelector('[data-sc-action="wrong-keep"]');
  const move = rows[0].querySelector('[data-sc-action="wrong-move"]');
  assert.deepEqual([keep.textContent, move.textContent], ["Keep this one", "Move to kept pictures"]);
  assert.equal(keep.tagName, "BUTTON");
  assert.equal(keep.getAttribute("aria-label"), "Keep this one: ppai-ai-models-page.png");
  assert.equal(move.getAttribute("aria-label"), "Move ppai-ai-models-page.png to kept pictures");
  assert.equal(panel.querySelectorAll("[role=dialog]").length, 0, "no new modal");

  // Keep this one marks exactly that picture.
  h.route("POST", /\/api\/capture\/library\/screenshots\/ppai-ai-models-page\.png\/confirm$/, { status: 200, body: { outcome: "confirmed", scope: "library", filename: "ppai-ai-models-page.png" } });
  h.route("GET", /\/api\/capture\/suspect-pictures/, reply(pictures.slice(1)));
  await h.click(keep);
  assert.equal(h.callsTo("POST", /ppai-ai-models-page\.png\/confirm$/).length, 1);
  assert.equal(h.host.querySelectorAll("[data-sc-wrong-picture]").length, 2);
  assert.equal(h.host.querySelector("[data-sc-wrong-message]").textContent, "Kept. This picture is not flagged again.");
  assert.equal(h.host.querySelector("[data-sc-wrong-notice] p").textContent, "2 pictures look like the wrong screen. Review them.");

  // Moving one lab picture goes straight to the kept pictures list, which can restore it.
  h.route("POST", /\/api\/capture\/suspect-pictures\/quarantine$/, { status: 200, body: { dryRun: false, moved: [{ filename: "agent-home.png", scope: "lab", labId: LAB }], failed: [] } });
  h.route("GET", /\/api\/capture\/suspect-pictures/, reply(pictures.slice(1, 2)));
  await h.click(h.host.querySelector('[data-sc-wrong-picture="lab:lab-test-1:agent-home.png"] [data-sc-action="wrong-move"]'));
  assert.deepEqual(h.callsTo("POST", /suspect-pictures\/quarantine$/)[0].body, { dryRun: false, confirm: true, items: [{ scope: "lab", labId: LAB, filename: "agent-home.png" }] });
  assert.equal(h.host.querySelector("[data-sc-wrong-message]").textContent, "1 picture moved to the kept pictures list. Its screenshot is pending again.");

  // Moving every clearly wrong picture asks first, in words that say they can be restored.
  const many = [flagged("a.png"), flagged("b.png")];
  h.route("GET", /\/api\/capture\/suspect-pictures/, reply(many));
  await h.run("scWrongLoad")(LAB, true);
  h.run("scRenderWrongHosts")();
  await h.flush();
  const all = h.host.querySelector('[data-sc-action="wrong-move-all"]');
  assert.equal(all.textContent, "Move the 2 clearly wrong pictures to kept pictures");
  const callsBefore = h.callsTo("POST", /suspect-pictures\/quarantine$/).length;
  await h.click(all);
  assert.equal(h.callsTo("POST", /suspect-pictures\/quarantine$/).length, callsBefore, "a question comes first");
  const ask = h.host.querySelector('[data-sc-ask="wrong"]');
  assert.match(ask.querySelector(".sc-ask-text").textContent, /2 pictures will move to the kept pictures list for 90 days\..*You can restore any of them\./);
  h.route("POST", /\/api\/capture\/suspect-pictures\/quarantine$/, { status: 200, body: { dryRun: false, moved: [{ filename: "a.png" }, { filename: "b.png" }], failed: [] } });
  h.route("GET", /\/api\/capture\/suspect-pictures/, reply([]));
  await h.click(ask.querySelector('[data-sc-action="wrong-ask-yes"]'));
  assert.deepEqual(h.callsTo("POST", /suspect-pictures\/quarantine$/).at(-1).body, { dryRun: false, confirm: true, labId: LAB });
  assert.equal(h.host.querySelector("[data-sc-wrong-none]").textContent, "No pictures look wrong.");
  assert.ok(!h.host.querySelector("[data-sc-wrong-notice]"), "no notice when nothing looks wrong");
});

// ── Pictures a person has to look at: thumbnails big enough to judge, and the full-size viewer ──

const flaggedPicture = (filename, extra = {}) => ({
  scope: "library",
  labId: null,
  labTitle: null,
  filename,
  label: "The AI models page",
  level: "definite",
  reason: `This shows the product's start page, but its lab describes a screen inside the product (${extra.label || "The AI models page"}). The computer never opened that screen.`,
  short: "shows a start page, not the screen it should show",
  flags: [],
  reach: "landing",
  writable: true,
  sha256: "a".repeat(64),
  width: null,
  height: null,
  ...extra,
});
const threeFlagged = () => [
  flaggedPicture("ppai-ai-hub-menu.png", { label: "The AI hub in the left pane", width: 1280, height: 800 }),
  flaggedPicture("ppai-ai-models-page.png", { label: "The AI models page" }),
  flaggedPicture("agent-home.png", { scope: "lab", labId: LAB, level: "probable", label: "Agents page", sha256: "b".repeat(64), reason: "This looks the same as \u201cSettings\u201d. They may show the same screen; check that each one shows what its lab describes." }),
];
const suspectReply = (list) => ({
  status: 200,
  body: {
    scannedAt: "2026-06-01T12:00:00.000Z",
    counts: { total: list.length, definite: list.filter((p) => p.level === "definite").length, probable: list.filter((p) => p.level === "probable").length },
    notice: list.length ? `${list.length} ${list.length === 1 ? "picture looks" : "pictures look"} like the wrong screen. Review ${list.length === 1 ? "it" : "them"}.` : "",
    retentionDays: 90,
    pictures: list,
  },
});
async function wrongPanelHarness(list) {
  const h = makeHarness();
  h.route("GET", /\/api\/capture\/suspect-pictures/, suspectReply(list));
  await h.setStatus({ ...statusPayload({ devices: [device()] }) });
  await h.render(stateFor([ownShot("agent-home.png")]));
  await h.flush();
  await h.click(h.action("wrong-review"));
  return h;
}
const viewerOf = (h) => h.host.querySelector("dialog.sc-lightbox");
const viewerButton = (h, key) => viewerOf(h).querySelector(`[data-sc-focus="${key}"]`);
const viewerSays = (h) => (h.host.querySelector("[data-sc-pic-live]")?.textContent || "").replace(/\u00a0/g, "").trim();
const viewerPosition = (h) => viewerOf(h).querySelector("[data-sc-pic-position]")?.textContent ?? null;
const viewerTitle = (h) => viewerOf(h).querySelector("#sc-lb-title").textContent;
const press = (h, key, target = viewerOf(h)) => target.dispatchEvent(h.event("keydown", { key }));
const cssRule = (selector) => new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(INDEX_HTML)?.[1] || "";

test("Pictures that look wrong: every picture is a button big enough to judge, and pressing it shows the picture full size with its title, reason, and the same two buttons", async () => {
  const h = await wrongPanelHarness(threeFlagged());
  const panel = h.host.querySelector("[data-sc-wrong-host]");
  const thumbs = panel.querySelectorAll("[data-sc-pic-open]");
  assert.deepEqual(thumbs.map((t) => t.tagName), ["BUTTON", "BUTTON", "BUTTON"], "a real button, so Enter and Space work");
  assert.deepEqual(
    thumbs.map((t) => t.getAttribute("aria-label")),
    ["Show the picture for The AI hub in the left pane full size", "Show the picture for The AI models page full size", "Show the picture for Agents page full size"],
  );
  assert.ok(thumbs.every((t) => t.getAttribute("type") === "button" && t.classList.contains("sc-pic-thumb")));
  const img = thumbs[0].querySelector("img");
  assert.deepEqual([img.getAttribute("loading"), img.getAttribute("decoding"), img.getAttribute("alt"), img.getAttribute("width"), img.getAttribute("height")], ["lazy", "async", "", "1280", "800"]);
  assert.equal(img.getAttribute("src"), "/api/capture/library/screenshots/ppai-ai-hub-menu.png/image");
  assert.equal(thumbs[0].style.aspectRatio, "1280 / 800", "the space is reserved, so nothing jumps when it loads");
  assert.match(thumbs[0].style.maxWidth, /1280px/, "never larger than the picture itself");
  assert.equal(thumbs[2].querySelector("img").getAttribute("src"), `/api/lab-builder/generated/${LAB}/assets/agent-home.png?v=${"b".repeat(12)}`);
  assert.equal(thumbs[0].querySelector(".sc-pic-hint").textContent, "Click to enlarge");
  assert.equal(thumbs[1].querySelector(".sc-pic-state").textContent, "Loading the picture");
  assert.deepEqual(panel.querySelectorAll(".sc-wrong-chip").map((c) => c.textContent), ["Clearly the wrong screen.", "Clearly the wrong screen.", "Worth a look."]);
  assert.ok(panel.querySelectorAll(".sc-wrong-chip")[2].classList.contains("sc-wrong-chip-probable"));

  // The size and the look come from the stylesheet: a useful size, no colored side stripe.
  assert.match(cssRule(".sc-pic-thumb"), /var\(--sc-pic-w, 360px\)/);
  assert.match(cssRule(".sc-pic-thumb"), /aspect-ratio: 16 \/ 10/);
  assert.match(cssRule(".sc-pic-thumb"), /cursor: pointer/);
  for (const selector of [".sc-pic-row", ".sc-wrong-definite", ".sc-wrong-probable"]) assert.doesNotMatch(cssRule(selector), /border-left/, `${selector} has no side stripe`);
  assert.match(cssRule(".sc-pic-row"), /border: 1px solid/);

  // Opening: the same dialog the gallery uses, modal, with the picture's own details and the same buttons as the list.
  await h.click(thumbs[0]);
  const dialog = viewerOf(h);
  assert.equal(dialog.open, true);
  assert.equal(dialog.modal, true, "a modal dialog keeps focus inside while it is open");
  assert.ok(dialog.classList.contains("sc-lightbox-picture"));
  assert.equal(viewerTitle(h), "The AI hub in the left pane");
  const big = dialog.querySelector("[data-sc-lb-figure] img");
  assert.equal(big.getAttribute("src"), img.getAttribute("src"), "the same file at its full size: no smaller copy is served");
  assert.equal(big.getAttribute("alt"), "The picture for The AI hub in the left pane");
  assert.equal(viewerPosition(h), "Picture 1 of 3");
  assert.equal(dialog.querySelector(".sc-wrong-chip").textContent, "Clearly the wrong screen.");
  assert.equal(dialog.querySelector(".sc-pic-where").textContent, "Shared library: ppai-ai-hub-menu.png.");
  assert.match(dialog.querySelector(".sc-wrong-reason").textContent, /^This shows the product's start page, but its lab describes a screen inside the product \(The AI hub in the left pane\)\./);
  const actions = dialog.querySelectorAll("[data-sc-pic-actions] button");
  assert.deepEqual(actions.map((b) => b.textContent), ["Keep this one", "Move to kept pictures"]);
  assert.deepEqual(actions.map((b) => b.dataset.scAction), ["wrong-keep", "wrong-move"]);
  assert.deepEqual(actions.map((b) => [b.dataset.scope, b.dataset.labId, b.dataset.filename]), actions.map(() => ["library", "", "ppai-ai-hub-menu.png"]));
  const newTab = dialog.querySelector("[data-sc-pic-new-tab]");
  assert.deepEqual([newTab.textContent, newTab.getAttribute("href"), newTab.getAttribute("target"), newTab.getAttribute("rel")], ["Open in a new tab", img.getAttribute("src"), "_blank", "noopener noreferrer"]);
  assert.deepEqual([viewerButton(h, "lb-fit").textContent, viewerButton(h, "lb-fit").getAttribute("aria-pressed"), viewerButton(h, "lb-actual").textContent, viewerButton(h, "lb-actual").getAttribute("aria-pressed")], ["Fit to screen", "true", "Actual size", "false"]);
  assert.equal(dialog.querySelector('[data-sc-action="lightbox-close"]').getAttribute("aria-label"), "Close the preview");
  assert.equal(h.document.activeElement.dataset.scFocus, "lb-close");
  assert.deepEqual(
    [dialog.querySelector('[data-sc-action="lightbox-prev"]').disabled, dialog.querySelector('[data-sc-action="lightbox-next"]').disabled],
    [true, false],
    "Previous is off at the first picture",
  );
  assert.equal(viewerSays(h), "Picture 1 of 3: The AI hub in the left pane");
  assert.deepEqual(json(h.run("scPicView.prefetch.map((i) => i.getAttribute('src'))")), ["/api/capture/library/screenshots/ppai-ai-models-page.png/image"], "only after the viewer opened, and only the neighbor");

  // Fit to screen and Actual size change how the picture sits, not which picture it is; arrow keys scroll it at Actual size.
  await h.click(viewerButton(h, "lb-actual"));
  assert.deepEqual([viewerButton(h, "lb-fit").getAttribute("aria-pressed"), viewerButton(h, "lb-actual").getAttribute("aria-pressed")], ["false", "true"]);
  assert.ok(dialog.querySelector("[data-sc-pic-stage]").classList.contains("sc-pic-actual"));
  const scroll = dialog.querySelector("[data-sc-pic-scroll]");
  assert.equal(scroll.getAttribute("tabindex"), "0", "a scrolling picture can be reached with the keyboard");
  press(h, "ArrowRight", scroll);
  assert.equal(viewerPosition(h), "Picture 1 of 3", "arrow keys scroll the picture while it has focus");
  await h.click(viewerButton(h, "lb-fit"));
  assert.ok(dialog.querySelector("[data-sc-pic-stage]").classList.contains("sc-pic-fit"));
  assert.equal(dialog.querySelector("[data-sc-pic-scroll]").getAttribute("tabindex"), null);

  // Previous, Next, and the arrow keys, in list order, with the position announced; no wrapping at the ends.
  press(h, "ArrowRight");
  assert.deepEqual([viewerTitle(h), viewerPosition(h), viewerSays(h)], ["The AI models page", "Picture 2 of 3", "Picture 2 of 3: The AI models page"]);
  assert.equal(dialog.querySelector("[data-sc-lb-figure] img").getAttribute("src"), "/api/capture/library/screenshots/ppai-ai-models-page.png/image");
  assert.deepEqual(json(h.run("scPicView.prefetch.map((i) => i.getAttribute('src'))")).length, 2, "both neighbors");
  await h.click(dialog.querySelector('[data-sc-action="lightbox-next"]'));
  assert.deepEqual([viewerTitle(h), viewerPosition(h)], ["Agents page", "Picture 3 of 3"]);
  assert.equal(dialog.querySelector(".sc-wrong-chip").textContent, "Worth a look.");
  assert.equal(dialog.querySelector(".sc-pic-where").textContent, "This lab: agent-home.png.");
  assert.equal(dialog.querySelector('[data-sc-action="lightbox-next"]').disabled, true, "Next is off at the last picture");
  press(h, "ArrowRight");
  assert.equal(viewerPosition(h), "Picture 3 of 3", "it does not wrap around");
  press(h, "Home");
  assert.equal(viewerPosition(h), "Picture 1 of 3");
  press(h, "End");
  assert.equal(viewerPosition(h), "Picture 3 of 3");
  press(h, "ArrowLeft");
  assert.equal(viewerPosition(h), "Picture 2 of 3");
  assert.equal(h.run("scPicView.fit"), true);

  // Escape closes it and focus goes back to the thumbnail of the picture that was showing.
  press(h, "Escape");
  assert.equal(viewerOf(h).open, false);
  assert.ok(h.document.activeElement === thumbs[1], "focus is back on the thumbnail of the picture that was showing");
  await h.click(thumbs[2]);
  assert.equal(viewerTitle(h), "Agents page");
  await h.click(viewerOf(h).querySelector('[data-sc-action="lightbox-close"]'));
  assert.equal(viewerOf(h).open, false);
  assert.ok(h.document.activeElement === thumbs[2], "the Close button returns to the thumbnail too");

  // The screenshot gallery still opens in the same dialog, as before.
  await h.click(h.host.querySelector('.sc-card [data-sc-action="preview"]'));
  assert.equal(viewerOf(h).open, true);
  assert.ok(!viewerOf(h).classList.contains("sc-lightbox-picture"));
  assert.equal(viewerOf(h).querySelector('[data-sc-action="lightbox-prev"]').getAttribute("aria-label"), "Previous screenshot");
  assert.equal(viewerOf(h).querySelector('[data-sc-action="lightbox-prev"]').disabled, false);
  press(h, "Escape");
});

test("Keep and Move inside the viewer call the same API as the list buttons, say what happened, move on to the next picture, and close when none are left", async () => {
  const list = threeFlagged();
  const h = await wrongPanelHarness(list);
  const hub = 'library::ppai-ai-hub-menu.png';
  await h.click(h.host.querySelector(`[data-sc-wrong-picture="${hub}"] [data-sc-pic-open]`));
  viewerButton(h, "lb-keep").focus();

  // A failed Keep leaves the picture in front of the person, with the reason.
  h.route("POST", /\/api\/capture\/library\/screenshots\/ppai-ai-hub-menu\.png\/confirm$/, { status: 500, body: { error: "Nothing was saved." } });
  await h.click(viewerButton(h, "lb-keep"));
  assert.deepEqual([viewerTitle(h), viewerPosition(h)], ["The AI hub in the left pane", "Picture 1 of 3"]);
  assert.equal(viewerOf(h).querySelector("[data-sc-pic-notice]").textContent, "Could not keep it. Nothing was saved.");

  // Keep this one: the same request as the list's button, then the next picture, and the focus stays on the button.
  h.route("POST", /\/api\/capture\/library\/screenshots\/ppai-ai-hub-menu\.png\/confirm$/, { status: 200, body: { outcome: "confirmed" } });
  h.route("GET", /\/api\/capture\/suspect-pictures/, suspectReply(list.slice(1)));
  await h.click(viewerButton(h, "lb-keep"));
  assert.deepEqual(h.callsTo("POST", /ppai-ai-hub-menu\.png\/confirm$/).map((c) => c.body), [{}, {}]);
  assert.equal(viewerOf(h).open, true);
  assert.deepEqual([viewerTitle(h), viewerPosition(h)], ["The AI models page", "Picture 1 of 2"]);
  assert.equal(viewerOf(h).querySelector("[data-sc-pic-notice]").textContent, "Kept. This picture is not flagged again.");
  h.advance(100);
  assert.equal(viewerSays(h), "Kept. This picture is not flagged again. Picture 1 of 2: The AI models page", "said again once the redrawn dialog is in place");
  assert.equal(h.host.querySelectorAll("[data-sc-wrong-picture]").length, 2, "the list behind it is up to date");
  assert.equal(h.document.activeElement.dataset.scFocus, "lb-keep");
  assert.ok(viewerOf(h).contains(h.document.activeElement));

  // Move to kept pictures: the same request as the list's button.
  h.route("POST", /\/api\/capture\/suspect-pictures\/quarantine$/, { status: 200, body: { dryRun: false, moved: [{ filename: "ppai-ai-models-page.png", scope: "library" }], failed: [] } });
  h.route("GET", /\/api\/capture\/suspect-pictures/, suspectReply(list.slice(2)));
  await h.click(viewerButton(h, "lb-move"));
  assert.deepEqual(h.callsTo("POST", /suspect-pictures\/quarantine$/)[0].body, { dryRun: false, confirm: true, items: [{ scope: "library", filename: "ppai-ai-models-page.png" }] });
  assert.deepEqual([viewerTitle(h), viewerPosition(h)], ["Agents page", "Picture 1 of 1"]);
  assert.equal(viewerOf(h).querySelector("[data-sc-pic-notice]").textContent, "1 picture moved to the kept pictures list. Its screenshot is pending again.");
  assert.deepEqual([viewerOf(h).querySelector('[data-sc-action="lightbox-prev"]').disabled, viewerOf(h).querySelector('[data-sc-action="lightbox-next"]').disabled], [true, true]);

  // The last one: keeping it closes the viewer and focus goes to the panel's heading, since its thumbnail is gone.
  h.route("POST", new RegExp(`/api/lab-builder/generated/${LAB}/screenshots/agent-home\\.png/confirm$`), { status: 200, body: { outcome: "confirmed" } });
  h.route("GET", /\/api\/capture\/suspect-pictures/, suspectReply([]));
  await h.click(viewerButton(h, "lb-keep"));
  assert.equal(viewerOf(h).open, false);
  assert.equal(h.run("scPicView.open"), false);
  assert.ok(h.document.activeElement === h.host.querySelector("[data-sc-wrong-heading]"), "focus goes to the panel's heading");
  assert.equal(h.host.querySelector("[data-sc-wrong-none]").textContent, "No pictures look wrong.");
});

test("Kept pictures: each one is a thumbnail button, and the same viewer offers Restore, Download, and a Delete forever that still asks first", async () => {
  const entry = {
    id: "contoso-labs-20260301000000-ab12",
    labId: "contoso-labs",
    labTitle: "Contoso Labs",
    reason: "deleted",
    keptAt: "2026-03-01T12:00:00.000Z",
    daysLeft: 62,
    pictures: [
      { filename: "mc-memory-toggle.png", base: "mc-memory-toggle.png", why: "lab-only", message: "", earlierVersion: false, restore: [{ type: "library" }] },
      { filename: "notes.png", base: "notes.png", why: "lab-only", message: "", earlierVersion: false, restore: [] },
    ],
  };
  const keptReply = (pictures) => ({ status: 200, body: { retentionDays: 90, entries: pictures.length ? [{ ...entry, pictures }] : [] } });
  const h = makeHarness();
  await h.setStatus({ ...statusPayload({ devices: [device()] }) });
  await h.render(stateFor([ownShot("a.png")]));
  h.route("GET", /\/api\/capture\/kept$/, keptReply(entry.pictures));
  await h.click(h.action("keep-load"));
  const kept = h.host.querySelector("[data-sc-kept-host]");
  const thumbs = kept.querySelectorAll("[data-sc-pic-open]");
  assert.deepEqual(thumbs.map((t) => t.getAttribute("aria-label")), ["Show the picture for mc-memory-toggle.png full size", "Show the picture for notes.png full size"]);
  assert.equal(thumbs[0].querySelector("img").getAttribute("src"), `/api/capture/kept/${entry.id}/mc-memory-toggle.png`);
  assert.equal(kept.querySelectorAll(".sc-keep-row").length, 2);

  await h.click(thumbs[0]);
  const dialog = viewerOf(h);
  assert.equal(dialog.open, true);
  assert.deepEqual([viewerTitle(h), viewerPosition(h)], ["mc-memory-toggle.png", "Picture 1 of 2"]);
  assert.equal(dialog.querySelector(".sc-pic-where").textContent, "From \u201cContoso Labs\u201d (deleted Mar 1, 2026). 62 days left.");
  assert.equal(dialog.querySelector(".sc-wrong-reason").textContent, "Specific to that lab.");
  assert.ok(!dialog.querySelector(".sc-wrong-chip"), "a kept picture has no verdict");
  assert.deepEqual(dialog.querySelectorAll("[data-sc-pic-actions] button").map((b) => b.textContent), ["Restore to the shared library", "Delete forever"]);
  assert.equal(dialog.querySelector("[data-sc-pic-actions] a").getAttribute("href"), `/api/capture/kept/${entry.id}/mc-memory-toggle.png?download=1`);
  assert.equal(dialog.querySelector("[data-sc-pic-new-tab]").getAttribute("href"), `/api/capture/kept/${entry.id}/mc-memory-toggle.png`);
  press(h, "ArrowRight");
  assert.deepEqual([viewerTitle(h), viewerPosition(h)], ["notes.png", "Picture 2 of 2"]);
  assert.match(dialog.querySelector("[data-sc-pic-actions]").textContent, /Nowhere to put it back right now, so download it instead\./);
  press(h, "ArrowLeft");

  // Restoring to the shared library asks first, inside the viewer, and Cancel changes nothing.
  viewerButton(h, "lb-restore").focus();
  await h.click(viewerButton(h, "lb-restore"));
  assert.equal(h.callsTo("POST", /\/restore$/).length, 0);
  assert.equal(dialog.querySelector('[data-sc-ask="keep-restore"] .sc-ask-title').textContent, "Use this picture for every lab?");
  assert.match(viewerSays(h), /^Use this picture for every lab\? Every lab that has no picture of its own will show it\./);
  await h.click(dialog.querySelector('[data-sc-action="keep-ask-cancel"]'));
  assert.ok(!dialog.querySelector("[data-sc-ask]"));
  assert.equal(h.document.activeElement.dataset.scFocus, "lb-restore", "Cancel returns to the button that asked");

  // Delete forever asks first in words that say it cannot be undone; Yes deletes, and the viewer moves on.
  viewerButton(h, "lb-delete").focus();
  await h.click(viewerButton(h, "lb-delete"));
  assert.equal(h.callsTo("DELETE", /kept/).length, 0, "nothing is deleted before the answer");
  assert.equal(dialog.querySelector('[data-sc-ask="keep-delete"] .sc-ask-text').textContent, "It is removed from the kept pictures and cannot be restored.");
  h.route("DELETE", /\/api\/capture\/kept\/[^/]+\/mc-memory-toggle\.png\?confirm=true$/, { status: 200, body: { outcome: "removed" } });
  h.route("GET", /\/api\/capture\/kept$/, keptReply([entry.pictures[1]]));
  await h.click(dialog.querySelector('[data-sc-action="keep-ask-yes"]'));
  assert.equal(h.callsTo("DELETE", /kept/).length, 1);
  assert.equal(viewerOf(h).open, true);
  assert.deepEqual([viewerTitle(h), viewerPosition(h)], ["notes.png", "Picture 1 of 1"]);
  assert.equal(viewerOf(h).querySelector("[data-sc-pic-notice]").textContent, "Deleted forever.");

  // The last kept picture: deleting it closes the viewer and focus goes to the Kept pictures heading.
  await h.click(viewerButton(h, "lb-delete"));
  h.route("DELETE", /\/api\/capture\/kept\/[^/]+\/notes\.png\?confirm=true$/, { status: 200, body: { outcome: "removed" } });
  h.route("GET", /\/api\/capture\/kept$/, keptReply([]));
  await h.click(viewerOf(h).querySelector('[data-sc-action="keep-ask-yes"]'));
  assert.equal(viewerOf(h).open, false);
  assert.ok(h.document.activeElement === h.host.querySelector("[data-sc-kept-heading]"), "focus goes to the Kept pictures heading");
  assert.equal(h.host.querySelector("[data-sc-kept-none]").textContent, "No pictures are being kept right now.");
});

test("a picture that cannot be loaded says so in plain words, in the list and in the viewer, and the viewer offers another try", async () => {
  const h = await wrongPanelHarness(threeFlagged());
  const thumbs = h.host.querySelectorAll("[data-sc-wrong-host] [data-sc-pic-open]");

  // The list: loading, then loaded (the box takes the picture's own shape when the size was not known), or failed.
  const loaded = thumbs[1].querySelector("img");
  loaded.naturalWidth = 1000;
  loaded.naturalHeight = 500;
  loaded.dispatchEvent(h.event("load", { bubbles: false }));
  assert.ok(thumbs[1].classList.contains("sc-pic-loaded"));
  assert.equal(thumbs[1].querySelector(".sc-pic-state").textContent, "");
  assert.deepEqual([thumbs[1].style.aspectRatio, thumbs[1].style.maxWidth.includes("1000px")], ["1000 / 500", true]);
  thumbs[0].querySelector("img").dispatchEvent(h.event("error", { bubbles: false }));
  const state = thumbs[0].querySelector(".sc-pic-state");
  assert.ok(thumbs[0].classList.contains("sc-pic-failed"));
  assert.equal(state.textContent, "Could not load this picture.");
  assert.equal(state.getAttribute("aria-hidden"), null, "a screen reader hears it");
  assert.equal(thumbs[0].getAttribute("aria-describedby"), state.id);
  assert.equal(thumbs[0].getAttribute("aria-label"), "Show the picture for The AI hub in the left pane full size", "the button keeps its name");

  // The viewer: the same words, a way to try again, and the link to the file stays.
  await h.click(thumbs[0]);
  viewerOf(h).querySelector("[data-sc-lb-figure] img").dispatchEvent(h.event("error", { bubbles: false }));
  const note = viewerOf(h).querySelector("[data-sc-pic-note]");
  assert.ok(note.textContent.startsWith("Could not load this picture."));
  assert.equal(viewerSays(h), "Could not load this picture.");
  assert.ok(viewerOf(h).querySelector("[data-sc-pic-new-tab]"));
  await h.click(note.querySelector('[data-sc-action="pic-retry"]'));
  assert.equal(viewerOf(h).querySelector("[data-sc-pic-note]").textContent, "Loading the picture", "a fresh attempt");
  assert.ok(!viewerOf(h).querySelector("[data-sc-pic-stage]").classList.contains("sc-pic-failed"));
});

test("export is one link, and import sends the ZIP, with Replace as a choice, and reports what was imported, skipped, and rejected", async () => {
  const h = makeHarness();
  await h.setStatus({ ...statusPayload({ devices: [device()] }), sharedLibrary: { location: "persistent", kind: "storage-root", persistent: true, summary: "Shared screenshots are saved in Azure storage.", total: 325, captured: 12, missing: 313, needsReview: 0, confirmed: 0 } });
  await h.render(stateFor([ownShot("a.png")]));
  assert.equal(h.host.querySelector("[data-sc-library-where]").textContent, "Shared screenshots are saved in Azure storage.");
  const exportLink = h.host.querySelector("[data-sc-keep-export]");
  assert.equal(exportLink.getAttribute("href"), "/api/capture/library/export");
  assert.equal(exportLink.textContent, "Export shared screenshots");
  assert.match(h.host.querySelector("[data-sc-move-host] .hint").textContent, /no picture shows account names, email addresses, or customer data/);

  h.route("POST", /\/api\/capture\/library\/import(\?replace=true)?$/, {
    status: 200,
    body: { message: "2 pictures imported. 1 skipped because the library already has it. 1 rejected.", counts: { imported: 2 }, skipped: [{ filename: "a.png", message: "The library already has exactly this picture." }], rejected: [{ filename: "b.png", message: "This is a placeholder picture, so it is not shared." }], needsReview: [] },
  });
  const zip = pngFile("shared-screenshots.zip", "application/zip");
  const input = h.host.querySelector("[data-sc-keep-file]");
  input.files = [zip];
  input.dispatchEvent(h.event("change"));
  await h.flush();
  const call = h.callsTo("POST", /library\/import/)[0];
  assert.equal(call.url, "/api/capture/library/import", "existing pictures are not replaced unless chosen");
  assert.equal(call.init.body, zip);
  assert.equal(call.init.headers["Content-Type"], "application/zip");
  const result = h.host.querySelector("[data-sc-import-result]");
  assert.equal(result.querySelector(".sc-feedback-head").textContent, "2 pictures imported. 1 skipped because the library already has it. 1 rejected.");
  assert.deepEqual(result.querySelectorAll("li").map((li) => li.textContent), ["a.png: The library already has exactly this picture.", "b.png: This is a placeholder picture, so it is not shared."]);

  const replace = h.host.querySelector("[data-sc-keep-replace]");
  replace.checked = true;
  replace.dispatchEvent(h.event("change"));
  const again = h.host.querySelector("[data-sc-keep-file]");
  again.files = [zip];
  again.dispatchEvent(h.event("change"));
  await h.flush();
  assert.equal(h.callsTo("POST", /library\/import/)[1].url, "/api/capture/library/import?replace=true");
});

test("the retake note appears only for a picture that exists, while it runs, and when the retake did not work", async () => {
  const note = makeHarness().run("scRetakeNote");
  const withPicture = { captured: true };
  const running = { options: { retake: true } };
  assert.equal(note({ shot: { captured: false }, status: { key: "capturing" }, active: running }), "", "a slot with no picture has nothing to keep");
  assert.equal(note({ shot: withPicture, status: { key: "queued" }, active: running }), "Retake in progress. Your current picture stays until the new one passes its check.");
  assert.equal(note({ shot: withPicture, status: { key: "capturing" }, active: { options: {} } }), "", "an ordinary capture is not a retake");
  assert.equal(note({ shot: withPicture, status: { key: "captured" }, last: running, row: { status: "failed", error: "The page did not open." } }), "The retake did not work, so your current picture was kept. The page did not open.");
  assert.equal(note({ shot: withPicture, status: { key: "captured" }, last: running, row: { status: "captured" } }), "", "a retake that worked needs no note");
  assert.equal(note({ shot: withPicture, status: { key: "captured" }, last: { options: {} }, row: { status: "failed" } }), "");
});

test("deleting a lab says in plain words what happens to its pictures, and a replaced lab says where each one went", async () => {
  const h = makeHarness({ generated: true });
  const text = h.run("lbGenDeletePicturesText");
  assert.equal(
    text({ total: 14, alreadyShared: 12, toShare: 0, shared: 12, carried: 0, kept: 2, earlierVersions: 0, retentionDays: 90 }),
    "12 pictures are already shared and stay available to other labs. 2 pictures exist only in this lab and will be kept for 90 days so you can restore them.",
  );
  assert.equal(
    text({ total: 3, alreadyShared: 1, toShare: 1, kept: 1, earlierVersions: 2, retentionDays: 90 }),
    "1 picture is already shared and stays available to other labs. 1 more picture will be shared with every lab first. 1 picture exists only in this lab and will be kept for 90 days so you can restore it. 2 earlier versions of replaced pictures will be kept for 90 days too.",
  );
  assert.equal(text({ total: 0 }), "", "a lab with no real picture has nothing to say");
  assert.equal(text(null), "");

  const done = h.run("lbGenPicturesDoneText");
  assert.equal(done({ total: 5, carried: 1, shared: 2, kept: 2, retentionDays: 90 }), "Your pictures are safe: 1 picture moved to the new lab, 2 pictures shared with every lab, 2 pictures kept for 90 days. Restore kept pictures in the Screenshot Center, under Advanced.");
  assert.equal(done({ total: 2, carried: 0, shared: 2, kept: 0, retentionDays: 90 }), "Your pictures are safe: 2 pictures shared with every lab.");
  assert.equal(done({ total: 0 }), "");
});

test("the shared library summary counts confirmed pictures", async () => {
  const h = makeHarness();
  await h.setStatus({ ...statusPayload({ devices: [device()] }), sharedLibrary: { location: "persistent", persistent: true, total: 325, captured: 12, missing: 313, needsReview: 1, confirmed: 4 } });
  await h.render(stateFor([ownShot("a.png")]));
  assert.equal(h.host.querySelector("[data-sc-library-confirmed]").textContent, "4 confirmed accurate.");
  h.route("GET", /\/api\/capture\/library$/, { status: 200, body: { summary: { total: 2, captured: 2, missing: 0, needsReview: 0, confirmed: 1 }, shots: [{ product: "copilot-studio", filename: "x.png", captured: true, confirmed: { at: confirmedAt } }, { product: "copilot-studio", filename: "y.png", captured: true, confirmed: null }] } });
  await h.click(h.action("library-load"));
  assert.match(h.host.querySelector(".sc-library-meta").textContent, /^2 of 2 captured, 1 confirmed$/);
});
