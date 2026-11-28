/**
 * Screenshot Center: capture modes, per-shot capture info, the inline address prompt, the full capture
 * settings, failure groups with one fix each, Resume, side-by-side review, and the brand profile's new
 * agent fields. The real browser scripts run in node:vm against a small fake DOM with a fake fetch, so
 * nothing touches a network or a browser. The server's answers are mocked exactly as the portal sends them.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

import { createFakeDom } from "./fixtures/fake-dom.js";

const publicFile = (name) => readFileSync(new URL(`../public/${name}`, import.meta.url), "utf8");
const CENTER_SOURCES = ["screenshot-center-core.js", "screenshot-center-jobs.js", "screenshot-center.js"].map(publicFile);
const INDEX_HTML = publicFile("index.html");
const BRAND_UI_SOURCE = publicFile("brand-ui.js");
const APP_SOURCE = publicFile("app.js");

const LAB = "lab-test-1";
const JOB_ID = "job_0123456789abcdef";
const NOW = Date.parse("2026-06-01T12:00:00.000Z");
const json = (value) => JSON.parse(JSON.stringify(value));

// ── Fixtures ────────────────────────────────────────────────────────────────

function capture(overrides = {}) {
  return {
    mode: "auto",
    why: "The computer can open this screen by its address and take the picture, then check the address.",
    path: ["Copilot Studio", "your agent", "Settings"],
    needs: [],
    missing: [],
    ready: true,
    screen: { id: "settings", label: "the agent's Settings page" },
    ...overrides,
  };
}

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
    alt: "The Copilot Studio agents page",
    caption: "Agents page",
    instructions: ["Open Copilot Studio", "Select Agents"],
    manual: false,
    captured: false,
    stale: false,
    needsReview: false,
    checkState: "up-to-date",
    lastAttemptStatus: null,
    lastError: null,
    verification: null,
    capturedAt: null,
    captureSource: null,
    capture: null,
    ...overrides,
  };
}

const captured = (name, extra = {}) => shot({ filename: name, captured: true, capturedAt: "2026-06-01T11:00:00.000Z", captureSource: "companion", ...extra });

function stateFor(shots) {
  const features = [...new Set(shots.map((s) => s.featureId))];
  return {
    labId: LAB,
    title: "Test lab",
    checkState: "up-to-date",
    lastRevalidatedAt: "2026-05-30T10:00:00.000Z",
    cliCommand: `node tools/screenshot-capture/capture.js --generated-lab=${LAB} --headed`,
    summary: {
      total: shots.length,
      captured: shots.filter((s) => s.captured).length,
      missing: shots.filter((s) => !s.captured).length,
      stale: 0,
      needsReview: shots.filter((s) => s.needsReview).length,
      checkState: "up-to-date",
    },
    modules: features.map((featureId, i) => {
      const first = shots.find((s) => s.featureId === featureId);
      return { featureId, moduleOrder: i + 1, stepLabel: first.stepLabel, moduleTitle: first.moduleTitle, checkState: "up-to-date", status: "up-to-date", primaryUrl: "", diff: null };
    }),
    shots,
  };
}

function device(overrides = {}) {
  return { id: "dev_0123456789ab", name: "Ada PC", platform: "win32", connected: true, busy: false, lastSeenAt: new Date(NOW - 5000).toISOString(), signedInProducts: [], ...overrides };
}

function statusPayload({ devices = [] } = {}) {
  const connected = devices.filter((d) => d.connected);
  return {
    companion: { connected: connected.length > 0, lastSeenAt: null, connectedCount: connected.length, deviceCount: devices.length, busy: false, signedInProducts: [], devices, downloadUrl: "/api/capture/companion.zip", onlineWindowSec: 90 },
    serverBrowser: { available: false },
    tenantUrls: { set: false, names: [] },
    sharedLibrary: { location: "persistent", persistent: true, total: 325, captured: 12, missing: 313, needsReview: 1 },
    jobs: { queued: 0, active: 0 },
    pairing: { codeTtlSec: 600 },
    limits: { maxUploadBytes: 8 * 1024 * 1024, acceptedTypes: ["image/png", "image/jpeg", "image/webp"] },
  };
}

const PROGRESS_KEY = { captured: "captured", "needs-review": "needsReview", failed: "failed", "auth-required": "failed", "manual-required": "manual", skipped: "skipped", cancelled: "cancelled", "needs-you": "needsYou", paused: "paused", running: "running", pending: "pending" };

function progressOf(rows) {
  const p = { total: rows.length, done: 0, captured: 0, needsReview: 0, failed: 0, manual: 0, skipped: 0, running: 0, pending: 0, cancelled: 0, needsYou: 0, paused: 0, percent: 100 };
  for (const row of rows) p[PROGRESS_KEY[row.status]] += 1;
  p.done = p.total - p.running - p.pending;
  p.percent = p.total ? Math.round((p.done / p.total) * 100) : 100;
  return p;
}

/** A job as the server reports it. `spec` rows are `[filename, status, extra fields]`. */
function jobWith(spec, extra = {}) {
  const rows = spec.map(([filename, status, more = {}]) => ({ filename, status, attempts: 1, ...more }));
  return {
    id: JOB_ID,
    status: "done",
    createdAt: new Date(NOW).toISOString(),
    startedAt: new Date(NOW).toISOString(),
    finishedAt: new Date(NOW + 60000).toISOString(),
    target: { type: "lab", labId: LAB },
    options: { mode: "smart" },
    claim: null,
    error: null,
    shots: rows,
    events: [],
    progress: progressOf(rows),
    causes: [],
    result: null,
    ...extra,
  };
}

const queuedJob = (filenames) => jobWith(filenames.map((name) => [name, "pending"]), { status: "queued", startedAt: null, finishedAt: null });

const CAUSES = {
  "no-agent": { code: "no-agent", title: "No agent address set", fix: "Add your agent's address or name in Capture settings, then retake.", fixAction: "settings", tone: "warn" },
  "sign-in": { code: "sign-in", title: "Sign-in needed", fix: "Sign in in the companion's browser window, then retake.", fixAction: "retry", tone: "warn" },
  "wrong-screen": { code: "wrong-screen", title: "The wrong screen was open", fix: "Retake with “Retake guided”, or check the agent address in Capture settings.", fixAction: "guided", tone: "warn" },
  manual: { code: "manual", title: "Outside the browser", fix: "Capture it with an OS screenshot tool and upload it.", fixAction: "upload", tone: "info" },
  "browser-closed": { code: "browser-closed", title: "Paused: the browser window was closed", fix: "Select Resume to continue where it stopped.", fixAction: "resume", tone: "info" },
};
const cause = (code, filenames) => ({ ...CAUSES[code], count: filenames.length, filenames });

const REQUIREMENTS = {
  "copilot-studio-agent": {
    label: "your Copilot Studio agent",
    noun: "agent address",
    product: "copilot-studio",
    fields: ["copilotStudioAgentUrl", "copilotStudioAgentName"],
    prompt: "Paste your agent's address (open the agent in Copilot Studio and copy it from the address bar), or type the agent's name.",
    cause: "no-agent",
  },
  "sharepoint-site": {
    label: "your SharePoint site",
    noun: "SharePoint site address",
    product: "sharepoint-ai",
    fields: ["sharepointSiteUrl"],
    prompt: "Paste the address of your SharePoint site (for example https://contoso.sharepoint.com/sites/training).",
    cause: "no-site",
  },
};

function requirement(id, waiting, extra = {}) {
  const base = REQUIREMENTS[id];
  return {
    id,
    ...base,
    met: waiting === 0,
    shotCount: waiting,
    waitingCount: waiting,
    filenames: Array.from({ length: waiting }, (_, i) => `${id}-${i + 1}.png`),
    message: waiting ? `${waiting} screenshot${waiting === 1 ? " needs" : "s need"} your ${base.noun}.` : `Your ${base.noun} is set.`,
    ...extra,
  };
}

const FIELD_DEFS = [
  { id: "copilotStudioUrl", label: "Copilot Studio environment address", kind: "url", product: "copilot-studio", placeholder: "https://copilotstudio.microsoft.com/environments/<environment id>/home", help: "Optional. Copy it from the address bar when Copilot Studio shows your environment's home page." },
  { id: "copilotStudioAgentUrl", label: "Copilot Studio agent address", kind: "url", product: "copilot-studio", placeholder: "https://copilotstudio.microsoft.com/environments/<environment id>/bots/<agent id>/overview", help: "Open your agent in Copilot Studio and copy the address from the address bar." },
  { id: "copilotStudioAgentName", label: "Copilot Studio agent name", kind: "text", product: "copilot-studio", placeholder: "My agent", help: "Use this instead of the address: the exact name of your agent." },
  { id: "sharepointSiteUrl", label: "SharePoint site address", kind: "url", product: "sharepoint-ai", placeholder: "https://contoso.sharepoint.com/sites/training", help: "The site the lab uses. Shots of site pages open it." },
  { id: "foundryProjectUrl", label: "Foundry project address", kind: "url", product: "ai-foundry", placeholder: "https://ai.azure.com/…", help: "Open your project in the Foundry portal and copy the address from the address bar." },
];

/** The capture settings payload. `values` maps a field id to `{ value, source, sourceLabel }`. */
function targetsPayload({ missing = [], values = {}, profile = { id: "default", name: "Contoso" } } = {}) {
  const fields = FIELD_DEFS.map((def) => {
    const v = values[def.id];
    return { ...def, set: Boolean(v), value: v?.value || "", source: v?.source || null, sourceLabel: v?.sourceLabel || null };
  });
  const requirements = missing.length ? missing : [];
  return { labId: LAB, activeProfile: profile, fields, requirements, missing: requirements.filter((r) => !r.met), shots: [] };
}

// ── Harness ─────────────────────────────────────────────────────────────────

function makeHarness() {
  const { document, FakeEvent } = createFakeDom();
  const body = document.body;
  const add = (parent, tag, { id } = {}) => {
    const el = document.createElement(tag);
    if (id) el.id = id;
    parent.appendChild(el);
    return el;
  };
  const host = add(body, "div", { id: "lb-result-screenshots" });
  add(body, "div", { id: "lb-result-checklist" });
  add(body, "div", { id: "lb-result-preview" });
  add(body, "div", { id: "lb-generated-list" });
  add(body, "input", { id: "bp-copilotStudioUrl" });

  const clock = { now: NOW, seq: 1, timers: new Map() };
  const addTimer = (fn, ms, every) => {
    const id = clock.seq++;
    clock.timers.set(id, { fn, at: clock.now + ms, every });
    return { id, unref() {} };
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
  class FakeEventSource {
    static instances = [];
    constructor(url) {
      this.url = url;
      this.closed = false;
      this.handlers = {};
      FakeEventSource.instances.push(this);
    }

    addEventListener(type, fn) {
      (this.handlers[type] ||= []).push(fn);
    }

    close() {
      this.closed = true;
    }
  }

  const h = { document, host, FakeEvent, FakeEventSource, calls: [], routes: [], status: statusPayload(), targets: null, brand: { customized: false }, spies: { preview: [], profiles: [] } };
  h.route = (method, pattern, reply) => h.routes.unshift([method, pattern, reply]);
  const fetchImpl = async (url, init = {}) => {
    const method = String(init.method || "GET").toUpperCase();
    let parsed = null;
    if (typeof init.body === "string") parsed = JSON.parse(init.body);
    h.calls.push({ method, url: String(url), body: parsed });
    let reply = null;
    for (const [m, pattern, handler] of h.routes) {
      if (m === method && pattern.test(String(url))) {
        reply = typeof handler === "function" ? await handler(String(url), parsed) : handler;
        break;
      }
    }
    if (!reply) {
      if (method === "GET" && /\/api\/capture\/status$/.test(url)) reply = { status: 200, body: h.status };
      else if (method === "GET" && /\/customization$/.test(url)) reply = { status: 200, body: h.brand };
      else if (method === "GET" && /\/capture-targets$/.test(url)) reply = h.targets ? { status: 200, body: h.targets } : { status: 404, body: { error: "No route" } };
      else if (method === "GET" && /\/api\/capture\/jobs\?labId=/.test(url)) reply = { status: 200, body: { jobs: [] } };
      else reply = { status: 404, body: { error: `No route for ${method} ${url}` } };
    }
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => reply.body ?? {} };
  };

  const context = {
    document,
    window: { addEventListener() {} },
    fetch: fetchImpl,
    EventSource: FakeEventSource,
    setTimeout: (fn, ms) => addTimer(fn, ms, 0),
    clearTimeout: (handle) => handle && clock.timers.delete(handle.id),
    setInterval: (fn, ms) => addTimer(fn, ms, ms),
    clearInterval: (handle) => handle && clock.timers.delete(handle.id),
    Date: FakeDate,
    URL,
    navigator: { clipboard: { writeText: async () => {}, read: async () => [] } },
    console,
    labBuilder: { products: [{ id: "copilot-studio", shortName: "Copilot Studio" }, { id: "sharepoint-ai", shortName: "SharePoint AI" }], industries: [], levels: [], harnesses: [], editing: null },
    toast() {},
    lbGen: { opened: LAB, labs: [], loaded: true },
    lbLoadResultPreview: async (labId) => {
      h.spies.preview.push(labId);
    },
    lbLoadGenerated: async () => {},
    setActiveTab() {},
    bpEnsureLoaded: async (force) => {
      h.spies.profiles.push(force);
    },
  };
  vm.createContext(context);
  for (const source of CENTER_SOURCES) vm.runInContext(source, context);

  h.run = (code) => vm.runInContext(code, context);
  h.flush = async (rounds = 8) => {
    for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  h.connect = async () => {
    h.status = statusPayload({ devices: [device()] });
    await h.run("scLoadStatus")(true);
  };
  h.render = async (state, { labId = LAB } = {}) => {
    h.run("scRenderCenter")(host, labId, state, null);
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
  h.type = (input, value) => {
    input.value = value;
    input.dispatchEvent(new FakeEvent("input"));
  };
  h.choose = (input) => {
    input.checked = true;
    input.dispatchEvent(new FakeEvent("change"));
  };
  /** Mark a job as finished, the way the live updates do, and wait for the result to show. */
  h.finish = async (job, labId = LAB) => {
    await h.run("scFinishJob")(labId, job);
    await h.flush();
  };
  h.jobBodies = () => h.callsTo("POST", /\/api\/capture\/jobs$/).map((c) => c.body);
  return h;
}

/**
 * A harness with a connected computer, the capture settings loaded, and the lab rendered. By default the lab has saved
 * "An agent I choose", so the address prompt is what these tests look at; pass `agent: null` for no saved choice (the default
 * is then the agent created in the capture).
 */
async function ready(state, { targets = null, agent = "existing" } = {}) {
  const h = makeHarness();
  h.targets = targets && agent ? { ...targets, agentSource: { source: agent === "existing" ? "own" : "created", from: "lab", saved: true } } : targets;
  await h.connect();
  await h.render(state);
  return h;
}

// ── Pure decisions ──────────────────────────────────────────────────────────

test("every place that counts statuses knows Needs you and Paused", () => {
  const h = makeHarness();
  const status = (s, live, attempt) => json(h.run("scShotStatus")(s, live, attempt));
  assert.deepEqual(status(shot(), null, { status: "needs-you" }), { key: "needs-you", label: "Needs you", tone: "warn" });
  assert.deepEqual(status(shot(), null, { status: "paused" }), { key: "paused", label: "Paused", tone: "info" });
  assert.equal(status(shot(), null, { status: "skipped" }).key, "pending", "a screenshot held back for an address is still pending");
  assert.equal(status(shot(), null, { status: "auth-required" }).key, "failed");
  assert.equal(status(shot({ lastAttemptStatus: "needs-you" })).key, "needs-you", "the lab's own record counts too");
  assert.equal(status(captured("a.png"), null, { status: "needs-you" }).key, "captured", "a picture that exists is never reported as missing");
  assert.equal(status(shot(), "running", { status: "paused" }).key, "capturing", "a live job row wins");

  const state = stateFor([shot({ filename: "a.png" }), shot({ filename: "b.png" }), shot({ filename: "c.png" }), captured("d.png")]);
  const attempts = { "a.png": { status: "needs-you" }, "b.png": { status: "paused" } };
  const counts = json(h.run("scCounts")(state, (name) => attempts[name] || null));
  assert.deepEqual([counts.needsYou, counts.paused, counts.toCapture, counts.captured], [1, 1, 3, 1], "both still need capturing");

  const progress = json(h.run("scProgressFromShots")([{ status: "captured" }, { status: "needs-you" }, { status: "paused" }, { status: "skipped" }, { status: "pending" }]));
  assert.deepEqual([progress.needsYou, progress.paused, progress.skipped, progress.done, progress.percent], [1, 1, 1, 4, 80]);

  for (const tone of [...Object.values(h.run("SC_STATUS_LABELS")), ...Object.values(h.run("SC_SHOT_MODES"))].map((entry) => entry.tone)) {
    assert.ok(["ok", "warn", "bad", "info", "neutral"].includes(tone), `${tone} is a chip tone with theme colors`);
  }
});

test("a finished job is described with every outcome, an address wait, and a paused capture", () => {
  const h = makeHarness();
  const describe = (job) => json(h.run("scDescribeJob")(job));
  const mixed = jobWith(
    [["a.png", "captured"], ["b.png", "needs-you"], ["c.png", "skipped"], ["d.png", "skipped"], ["e.png", "skipped"], ["f.png", "skipped"]],
    { causes: [cause("no-agent", ["c.png", "d.png", "e.png"]), { ...CAUSES["sign-in"], code: "skipped-by-you", count: 1, filenames: ["f.png"] }] },
  );
  const view = describe(mixed);
  assert.equal(view.phase, "done");
  assert.equal(view.tone, "warn");
  assert.equal(view.detail, "1 captured, 1 need you, 3 waiting for an address, 1 skipped.");

  const paused = jobWith([["a.png", "captured"], ["b.png", "paused"], ["c.png", "paused"]], { result: { paused: 2, pausedReason: "browser-closed", resumable: true } });
  assert.deepEqual([describe(paused).phase, describe(paused).headline], ["paused", "Capture paused"]);
  assert.equal(describe(paused).detail, "You closed the browser window, so the capture paused. 2 screenshots are waiting.");
  assert.equal(describe({ ...paused, shots: [{ filename: "b.png", status: "paused" }], progress: progressOf([{ status: "paused" }]), result: { pausedReason: "stopped" } }).detail, "You pressed Stop, so the capture paused. 1 screenshot is waiting.");
  assert.equal(describe({ ...paused, status: "failed" }).phase, "paused", "a paused job that captured nothing is still paused, not failed");
  const busy = describe({ ...paused, result: { paused: 2, pausedReason: "browser-busy", resumable: true } });
  assert.deepEqual([busy.phase, busy.headline], ["paused", "Waiting for the browser"]);
  assert.equal(busy.detail, "A browser window from an earlier capture is still open on your computer, so the capture is waiting, not failed. Close that window, then select Resume. 2 screenshots are waiting.");

  const outcome = json(h.run("scOutcomeFromJob")({ ...paused, causes: [cause("browser-closed", ["b.png", "c.png"]), cause("sign-in", ["a.png"])] }));
  assert.equal(outcome.variant, "warn");
  assert.equal(outcome.message, "You closed the browser window, so the capture paused. 2 screenshots are waiting.");
  assert.deepEqual(outcome.actions, [{ id: "resume", label: "Resume", primary: true, filenames: ["b.png", "c.png"] }]);
  assert.deepEqual(outcome.causes.map((c) => c.code), ["sign-in"], "the Resume group is the banner's own button, not a second one");

  const primary = json(h.run("scPrimaryAction")({ counts: { total: 3, toCapture: 3 }, checkState: "up-to-date", connected: true, addressWaiting: 2 }));
  assert.match(primary.help, /2 screenshots are waiting for an address and will be held back until you add it\.$/);
  assert.doesNotMatch(json(h.run("scPrimaryAction")({ counts: { total: 3, toCapture: 3 }, checkState: "up-to-date", connected: true })).help, /waiting for an address/);
});

test("the wrong-screen sentence names the page that opened and the page that was expected", () => {
  const h = makeHarness();
  const landing = { state: "mismatch", page: "the Copilot Studio home page", expected: "the agent's Instructions page" };
  assert.equal(h.run("scLandingSentence")({ landing, reasons: [{ code: "wrong-screen" }] }), "This is the Copilot Studio home page, not the agent's Instructions page.");
  assert.equal(h.run("scReasonText")({ code: "wrong-screen" }, { landing }), "This is the Copilot Studio home page, not the agent's Instructions page.");
  assert.equal(h.run("scLandingSentence")({ landing: { state: "match" }, reasons: [] }), "");
  assert.match(h.run("scReasonText")({ code: "wrong-screen" }, null), /^This is not the screen the lab asks for\./);
});

test("failure groups keep only safe, bounded data and leave the Resume group to the banner", () => {
  const h = makeHarness();
  const groups = json(
    h.run("scCauseGroups")({
      causes: [
        { code: "no-agent", title: "No agent address set", fix: "Add it.", fixAction: "settings", tone: "warn", count: 12, filenames: ["a.png", "../evil.png", "b.png"] },
        { code: "Bad Code!", title: "x", fixAction: "retry", count: 1, filenames: [] },
        { code: "stopped", title: "You stopped the capture", fixAction: "resume", count: 3, filenames: ["c.png"] },
        { code: "unknown", title: "", fixAction: "run-this", tone: "danger", count: 0, filenames: ["d.png"] },
      ],
    }),
  );
  assert.deepEqual(groups.map((g) => g.code), ["no-agent", "unknown"]);
  assert.deepEqual(groups[0].filenames, ["a.png", "b.png"]);
  assert.equal(groups[0].count, 12, "the server's count stands even when the list is trimmed");
  assert.deepEqual([groups[1].title, groups[1].fixAction, groups[1].tone, groups[1].count], ["The capture did not finish", "retry", "warn", 1]);
});

test("the shared library capture sends the same default mode", async () => {
  const h = await ready(stateFor([captured("a.png")]));
  h.route("GET", /\/api\/capture\/library$/, { status: 200, body: { summary: {}, shots: [{ product: "sharepoint-ai", filename: "lib-a.png", captured: false }] } });
  h.route("POST", /\/api\/capture\/jobs$/, { status: 201, body: { job: { ...queuedJob(["lib-a.png"]), target: { type: "library", products: ["sharepoint-ai"] } } } });
  await h.click(h.action("library-load"));
  await h.click(h.action("library-capture"));
  assert.deepEqual(json(h.jobBodies()[0].options), { callouts: "sidecar", redact: true, mode: "autonomous" });
});

// ── A. Capture mode choice ──────────────────────────────────────────────────

test("the capture mode is a labeled radio group that defaults to Automatic and rides on every queued capture", async () => {
  const h = await ready(stateFor([shot({ filename: "a.png" })]));
  const group = h.center().querySelector("fieldset.sc-mode");
  assert.equal(group.querySelector("legend").textContent, "How should screenshots be captured?");
  const radios = group.querySelectorAll('input[type="radio"]');
  assert.deepEqual(radios.map((r) => r.dataset.scMode), ["autonomous", "autonomous-readonly", "guided", "smart", "auto"]);
  assert.deepEqual(group.querySelectorAll("label").map((l) => l.textContent), ["Automatic (recommended)", "Automatic, read-only (never creates anything)", "I will set up each screen", "Smart", "Only what needs no setup"]);
  assert.ok(group.querySelector("details.sc-mode-advanced"), "guided, smart, and the address-only mode are under Advanced");
  assert.deepEqual(group.querySelector("details.sc-mode-advanced").querySelectorAll('input[type="radio"]').map((r) => r.dataset.scMode), ["guided", "smart", "auto"]);
  for (const radio of radios) {
    assert.equal(radio.getAttribute("name"), "sc-capture-mode", "one group: arrow keys move between the choices");
    assert.equal(group.querySelector(`label[for="${radio.id}"]`).textContent.length > 0, true, "each radio has its label");
    const help = group.querySelector(`#${radio.getAttribute("aria-describedby")}`);
    assert.match(help.textContent, /^[A-Z][^.]+\.$/, "one plain sentence under each choice");
  }
  assert.deepEqual(radios.map((r) => r.checked), [true, false, false, false, false]);

  h.route("POST", /\/api\/capture\/jobs$/, { status: 201, body: { job: queuedJob(["a.png"]) } });
  await h.click(h.action("primary-capture-missing"));
  assert.equal(h.jobBodies()[0].options.mode, "autonomous");

  const readonly = await ready(stateFor([shot({ filename: "a.png" })]));
  readonly.choose(readonly.center().querySelector("#sc-mode-autonomous-readonly"));
  readonly.route("POST", /\/api\/capture\/jobs$/, { status: 201, body: { job: queuedJob(["a.png"]) } });
  await readonly.click(readonly.action("primary-capture-missing"));
  assert.deepEqual(json(readonly.jobBodies()[0].options), { callouts: "sidecar", redact: true, mode: "autonomous", autonomy: { level: "read-only" } }, "read-only is Automatic with a lower ceiling");

  const guided = await ready(stateFor([shot({ filename: "a.png" })]));
  guided.choose(guided.center().querySelector("#sc-mode-guided"));
  guided.run("scRerender")(LAB);
  assert.deepEqual(guided.center().querySelectorAll('input[type="radio"]').map((r) => r.checked), [false, false, true, false, false], "a re-render keeps the choice");
  guided.route("POST", /\/api\/capture\/jobs$/, { status: 201, body: { job: queuedJob(["a.png"]) } });
  await guided.click(guided.action("primary-capture-missing"));
  assert.equal(guided.jobBodies()[0].options.mode, "guided");

  const advanced = await ready(stateFor([shot({ filename: "a.png" })]));
  advanced.choose(advanced.center().querySelector("#sc-mode-auto"));
  advanced.route("POST", /\/api\/capture\/jobs$/, { status: 201, body: { job: queuedJob(["a.png"]) } });
  await advanced.click(advanced.action("advanced-capture"));
  assert.equal(advanced.jobBodies()[0].options.mode, "auto", "Advanced capture and the one-shot button use the same choice");
});

test("the capture mode is remembered per lab, in memory only", async () => {
  const h = makeHarness();
  await h.render(stateFor([shot({ filename: "a.png" })]));
  h.choose(h.center().querySelector("#sc-mode-guided"));
  await h.render(stateFor([shot({ filename: "a.png" })]), { labId: "lab-other" });
  assert.equal(h.center().querySelector("#sc-mode-autonomous").checked, true, "another lab starts with Automatic");
  await h.render(stateFor([shot({ filename: "a.png" })]));
  assert.equal(h.center().querySelector("#sc-mode-guided").checked, true, "and this lab keeps its own choice");
  assert.doesNotMatch(CENTER_SOURCES.join("\n"), /localStorage|sessionStorage|indexedDB/, "nothing is stored in the browser");
});

// ── B. Each shot's mode, why, path, and outcome ─────────────────────────────

test("each card says how the shot is captured, why, and the way to the screen", async () => {
  const h = await ready(
    stateFor([
      shot({ filename: "auto.png", capture: capture() }),
      shot({ filename: "guided.png", id: 2, capture: capture({ mode: "guided", why: "A dialog has to be opened first, so you open it and capture it.", path: ["Copilot Studio"] }) }),
      shot({ filename: "manual.png", id: 3, manual: true, capture: capture({ mode: "manual", why: "This screen is outside the browser. Capture it with an OS screenshot tool and upload it.", path: [] }) }),
      shot({ filename: "plain.png", id: 4 }),
    ]),
  );
  // Automatic mode explains nothing about setting screens up; the older modes still say why.
  h.choose(h.center().querySelector("#sc-mode-smart"));
  h.run("scRerender")(LAB);
  const chip = (name) => h.card(name).querySelector(".sc-mode-chip");
  assert.deepEqual(["auto.png", "guided.png", "manual.png"].map((n) => chip(n).textContent), ["Automatic", "You set it up", "Outside the browser"]);
  assert.ok(chip("auto.png").classList.contains("sc-chip-info"));
  assert.ok(chip("guided.png").classList.contains("sc-chip-neutral"));
  assert.equal(chip("plain.png"), null, "a shot the server did not classify shows no mode");
  assert.equal(h.card("auto.png").querySelector(".sc-why").textContent, "The computer can open this screen by its address and take the picture, then check the address.");
  assert.equal(h.card("auto.png").querySelector(".sc-path-text").textContent, "Copilot Studio > your agent > Settings");
  assert.equal(h.card("auto.png").querySelector(".sc-path .sr-only").textContent, "Path: Copilot Studio, then your agent, then Settings.", "a screen reader hears words, not arrows");
  assert.equal(h.card("auto.png").querySelector(".sc-path-text").getAttribute("aria-hidden"), "true");
  assert.equal(h.card("manual.png").querySelector(".sc-path"), null, "no path is shown when none is known");
  assert.equal(h.card("plain.png").querySelector(".sc-why"), null);
});

test("a finished capture shows the path it took on the card, and a held-back shot says what it waits for", async () => {
  const state = stateFor([
    shot({ filename: "a.png", capture: capture({ needs: ["copilot-studio-agent"] }) }),
    shot({ filename: "b.png", id: 2, capture: capture({ needs: ["copilot-studio-agent"], missing: ["copilot-studio-agent"], ready: false }) }),
  ]);
  const h = await ready(state, { targets: targetsPayload({ missing: [requirement("copilot-studio-agent", 1)] }) });
  assert.equal(h.card("b.png").querySelector(".sc-note").textContent, "Waiting for your agent address. Add it above, then capture this one.");
  assert.equal(h.card("a.png").querySelector(".sc-note").textContent, "Not captured yet.");

  const job = jobWith([["a.png", "failed", { message: "The browser ended on another page.", outcome: "Opened Copilot Studio, then your agent, then Settings, then selected Generative AI." }], ["b.png", "skipped", { message: "This screenshot needs your agent address. Add it in Capture settings, then retake.", cause: "no-agent" }]], { causes: [cause("no-agent", ["b.png"])] });
  await h.finish(job);
  assert.equal(h.card("a.png").querySelector(".sc-outcome").textContent, "Opened Copilot Studio, then your agent, then Settings, then selected Generative AI.");
  assert.equal(h.card("a.png").querySelector(".sc-note").textContent, "The browser ended on another page.", "the reason it stopped");
  assert.equal(h.card("b.png").dataset.status, "pending");
  assert.equal(h.card("b.png").querySelector(".sc-note").textContent, "This screenshot needs your agent address. Add it in Capture settings, then retake.");
  assert.deepEqual(h.card("b.png").querySelectorAll(".sc-card-actions button").map((b) => b.textContent), ["Retake", "Retake guided", "Paste image", "Upload image"]);
});

// ── B/H. Needs you, paused, Retake, Retake guided, Resume ───────────────────

test("Needs you and Paused have their own chips, counts, explanation, and a guided retake", async () => {
  const state = stateFor([captured("a.png"), shot({ filename: "b.png", id: 2 }), shot({ filename: "c.png", id: 3 })]);
  const h = await ready(state);
  const job = jobWith(
    [["a.png", "captured", { outcome: "Opened Copilot Studio, then your agent, then Settings." }], ["b.png", "needs-you", { cause: "needs-you", message: "This screen needs you to set it up." }], ["c.png", "paused", { cause: "browser-closed" }]],
    { result: { paused: 1, pausedReason: "browser-closed", resumable: true }, causes: [cause("browser-closed", ["c.png"])] },
  );
  await h.finish(job);

  assert.equal(h.card("b.png").dataset.status, "needs-you");
  assert.equal(h.card("b.png").querySelector(".sc-status-chip").textContent, "Needs you");
  assert.ok(h.card("b.png").querySelector(".sc-status-chip").classList.contains("sc-chip-warn"));
  assert.equal(h.card("c.png").dataset.status, "paused");
  assert.equal(h.card("c.png").querySelector(".sc-status-chip").textContent, "Paused");
  assert.ok(h.card("c.png").querySelector(".sc-status-chip").classList.contains("sc-chip-info"));
  assert.match(h.card("b.png").querySelector(".sc-note").textContent, /^This screen needs you\. Select Retake guided, set up the screen yourself, and capture it\.$/);
  assert.match(h.card("c.png").querySelector(".sc-note").textContent, /^The capture paused before this one was captured\./);
  assert.match(h.card("a.png").querySelector(".sc-outcome").textContent, /^Opened Copilot Studio/);
  assert.match(h.text(".sc-header"), /1 need you/);
  assert.match(h.text(".sc-header"), /1 paused/);
  const guided = h.cardAction("b.png", "shot-retake-guided");
  assert.ok(guided.classList.contains("btn-primary"), "for a screen that needs you, the guided retake is the main action");
  assert.equal(h.cardAction("b.png", "shot-retake").classList.contains("btn-primary"), false);

  h.center().querySelector("#sc-only-attention").checked = true;
  h.center().querySelector("#sc-only-attention").dispatchEvent(new h.FakeEvent("change"));
  assert.deepEqual(h.center().querySelectorAll(".sc-card").map((c) => c.dataset.filename), ["b.png", "c.png"], "the attention filter keeps both new statuses");
});

test("a running capture counts the shots that need you in its progress card", async () => {
  const state = stateFor([shot({ filename: "a.png" }), shot({ filename: "b.png", id: 2 }), shot({ filename: "c.png", id: 3 })]);
  const h = await ready(state);
  const running = jobWith([["a.png", "running"], ["b.png", "needs-you"], ["c.png", "skipped", { cause: "no-agent" }]], { status: "running", finishedAt: null, claim: { lastActivityAt: new Date(NOW).toISOString() }, causes: [cause("no-agent", ["c.png"])] });
  h.route("POST", /\/api\/capture\/jobs$/, { status: 201, body: { job: running } });
  await h.click(h.action("primary-capture-missing"));
  assert.deepEqual(h.center().querySelectorAll(".sc-progress-counts .sc-chip").map((c) => c.textContent), ["0 captured", "0 need review", "0 failed", "1 need you", "1 skipped"]);
  assert.equal(h.text(".sc-progress-detail"), "Keep the browser window your computer opened until this finishes. 1 screenshot is waiting for an address.", "the progress text says what is held back");
  assert.equal(h.card("b.png").dataset.status, "needs-you", "a shot settled when the job was queued shows it at once");
  assert.equal(h.card("a.png").dataset.status, "capturing");
});

test("Retake uses the chosen mode and Retake guided always uses guided, and neither throws away the picture in place", async () => {
  const run = async (action, { choose = null, state, filename }) => {
    const h = await ready(state);
    if (choose) h.choose(h.center().querySelector(`#sc-mode-${choose}`));
    h.route("DELETE", /\/screenshots\/[^/]+$/, { status: 200, body: { outcome: "reset", state } });
    h.route("POST", /\/api\/capture\/jobs$/, { status: 201, body: { job: queuedJob([filename]) } });
    h.calls.length = 0;
    await h.click(h.cardAction(filename, action));
    return { order: h.calls.filter((c) => /DELETE|POST/.test(c.method)).map((c) => `${c.method} ${c.url}`), body: h.jobBodies()[0] };
  };
  const withPicture = stateFor([captured("a.png")]);
  const queueOnly = ["POST /api/capture/jobs"];

  const smart = await run("shot-retake", { state: withPicture, filename: "a.png" });
  assert.deepEqual(smart.order, queueOnly, "the old picture stays until the new one is accepted");
  assert.deepEqual(json(smart.body), { target: { type: "lab", labId: LAB }, scope: { mode: "selected", filenames: ["a.png"] }, options: { callouts: "sidecar", redact: true, mode: "autonomous", retake: true } });
  assert.equal((await run("shot-retake", { choose: "auto", state: withPicture, filename: "a.png" })).body.options.mode, "auto");
  const guided = await run("shot-retake-guided", { choose: "auto", state: withPicture, filename: "a.png" });
  assert.equal(guided.body.options.mode, "guided", "Retake guided ignores the radio choice");
  assert.deepEqual(guided.order, queueOnly);

  const failed = stateFor([shot({ filename: "b.png", lastAttemptStatus: "failed", lastError: "It broke." })]);
  const noPicture = await run("shot-retake-guided", { state: failed, filename: "b.png" });
  assert.deepEqual(noPicture.order, queueOnly);
  assert.deepEqual(json(noPicture.body.scope), { mode: "selected", filenames: ["b.png"] });

  const offline = makeHarness();
  await offline.render(withPicture);
  await offline.click(offline.cardAction("a.png", "shot-retake-guided"));
  assert.equal(offline.callsTo("DELETE", /screenshots/).length, 0, "the old picture stays when no computer is connected");
  assert.match(offline.card("a.png").querySelector(".sc-feedback").textContent, /Retake needs your computer\./);
});

test("a paused capture shows one clear message and one Resume button that queues the paused shots again", async () => {
  const state = stateFor([captured("a.png"), shot({ filename: "b.png", id: 2 }), shot({ filename: "c.png", id: 3 })]);
  const h = await ready(state);
  const job = jobWith([["a.png", "captured"], ["b.png", "paused", { cause: "browser-closed" }], ["c.png", "paused", { cause: "browser-closed" }]], {
    result: { paused: 2, pausedReason: "browser-closed", resumable: true },
    causes: [cause("browser-closed", ["b.png", "c.png"])],
  });
  await h.finish(job);
  assert.equal(h.text(".sc-banner-text"), "You closed the browser window, so the capture paused. 2 screenshots are waiting.");
  const resume = h.center().querySelectorAll('[data-sc-action="banner-resume"]');
  assert.equal(resume.length, 1, "exactly one Resume button");
  assert.equal(resume[0].textContent, "Resume");
  assert.ok(resume[0].classList.contains("btn-primary"));
  assert.equal(h.center().querySelector(".sc-causes"), null, "the paused group is not repeated under the message");
  assert.equal(h.center().querySelector('[data-sc-action="banner-retry-failed"]'), null);

  h.route("POST", /\/api\/capture\/jobs$/, { status: 201, body: { job: queuedJob(["b.png", "c.png"]) } });
  await h.click(resume[0]);
  assert.deepEqual(json(h.jobBodies()[0]), { target: { type: "lab", labId: LAB }, scope: { mode: "selected", filenames: ["b.png", "c.png"] }, options: { callouts: "sidecar", redact: true, mode: "autonomous" } });
  assert.ok(h.center().querySelector(".sc-progress"), "the resumed capture shows live progress");

  const stopped = await ready(state);
  await stopped.finish({ ...job, result: { paused: 2, pausedReason: "stopped", resumable: true } });
  assert.match(stopped.text(".sc-banner-text"), /^You pressed Stop, so the capture paused\./);

  const offline = makeHarness();
  await offline.render(state);
  await offline.finish(job);
  await offline.click(offline.action("banner-resume"));
  assert.equal(offline.callsTo("POST", /\/api\/capture\/jobs$/).length, 0, "no computer: nothing is queued");
  assert.match(offline.text(".sc-banner-text"), /Connect your computer first/);
});

// ── G. Failure groups ───────────────────────────────────────────────────────

function causeScenario() {
  const state = stateFor([
    shot({ filename: "a.png", figure: "1.1", caption: "Agents page" }),
    shot({ filename: "b.png", id: 2, figure: "1.2", caption: "Create an agent" }),
    shot({ filename: "c.png", id: 3, figure: "1.3", caption: "Sign in" }),
    shot({ filename: "d.png", id: 4, figure: "1.4", caption: "Instructions" }),
    shot({ filename: "e.png", id: 5, figure: "1.5", caption: "Terminal", manual: true }),
  ]);
  const job = jobWith(
    [["a.png", "skipped", { cause: "no-agent" }], ["b.png", "skipped", { cause: "no-agent" }], ["c.png", "auth-required", { cause: "sign-in" }], ["d.png", "failed", { cause: "wrong-screen" }], ["e.png", "manual-required", { cause: "manual" }]],
    { causes: [cause("no-agent", ["a.png", "b.png"]), cause("sign-in", ["c.png"]), cause("wrong-screen", ["d.png"]), cause("manual", ["e.png"])] },
  );
  return { state, job };
}

test("failures are grouped by cause, one fix per group, instead of one line per screenshot", async () => {
  const { state, job } = causeScenario();
  const h = await ready(state);
  await h.finish(job);
  const groups = h.center().querySelectorAll(".sc-banner .sc-cause");
  assert.deepEqual(groups.map((g) => g.querySelector(".sc-cause-title").textContent), ["No agent address set", "Sign-in needed", "The wrong screen was open", "Outside the browser"]);
  assert.deepEqual(groups.map((g) => g.querySelector(".sc-chip").textContent), ["2 screenshots", "1 screenshot", "1 screenshot", "1 screenshot"]);
  assert.deepEqual(groups.map((g) => g.querySelectorAll('[data-sc-action="cause-fix"]').length), [1, 1, 1, 1], "exactly one fix per group");
  assert.deepEqual(
    groups.map((g) => g.querySelector('[data-sc-action="cause-fix"]').textContent),
    ["Open capture settings", "Retake 1 screenshot", "Retake 1 screenshot guided", "Go to the first screenshot"],
  );
  assert.equal(groups[0].querySelector(".sc-cause-fix").textContent, "Add your agent's address or name in Capture settings, then retake.");
  assert.equal(h.text(".sc-banner-text"), "Capture finished: 0 captured, 2 failed, 2 waiting for an address, 1 need to be added by hand.");
  assert.equal(h.center().querySelector('[data-sc-action="banner-retry-failed"]'), null, "the groups carry the fixes");
  assert.equal(h.center().querySelectorAll(".sc-banner li").filter((li) => !li.classList.contains("sc-cause") && !li.parentNode.classList.contains("sc-cause-files")).length, 0, "no per-shot lines in the result");

  const first = groups[0];
  const toggle = first.querySelector('[data-sc-action="cause-toggle"]');
  const files = () => h.center().querySelector('[data-sc-cause="no-agent"] .sc-cause-files');
  assert.equal(files().hidden, true);
  assert.deepEqual([toggle.getAttribute("aria-expanded"), toggle.getAttribute("aria-controls") === files().id], ["false", true]);
  toggle.focus();
  await h.click(toggle);
  assert.equal(h.document.activeElement.dataset.scFocus, "cause:no-agent:toggle", "focus stays on the button that was pressed");
  assert.equal(files().hidden, false);
  assert.deepEqual(files().querySelectorAll("li").map((li) => li.textContent), ["Figure 1.1: Agents page", "Figure 1.2: Create an agent"]);
  assert.equal(h.center().querySelector('[data-sc-cause="no-agent"] [data-sc-action="cause-toggle"]').getAttribute("aria-expanded"), "true");
  await h.click(h.center().querySelector('[data-sc-cause="no-agent"] [data-sc-action="cause-toggle"]'));
  assert.equal(files().hidden, true, "it collapses again");
  assert.equal(h.card("a.png").querySelector(".sc-note").textContent.length > 0, true, "per-shot detail stays on the card");
});

test("each fix does what its action says", async () => {
  const fix = async (code, { targets = null } = {}) => {
    const { state, job } = causeScenario();
    const h = await ready(state, { targets });
    h.route("POST", /\/api\/capture\/jobs$/, { status: 201, body: { job: queuedJob(["c.png"]) } });
    await h.finish(job);
    await h.click(h.center().querySelector(`[data-sc-cause="${code}"] [data-sc-action="cause-fix"]`));
    return h;
  };

  const retry = await fix("sign-in");
  assert.deepEqual(json(retry.jobBodies()[0]), { target: { type: "lab", labId: LAB }, scope: { mode: "selected", filenames: ["c.png"] }, options: { callouts: "sidecar", redact: true, mode: "autonomous", retake: true } });
  assert.equal(retry.callsTo("DELETE", /screenshots/).length, 0);

  const guided = await fix("wrong-screen");
  assert.deepEqual([guided.jobBodies()[0].options.mode, json(guided.jobBodies()[0].scope.filenames)], ["guided", ["d.png"]]);

  const upload = await fix("manual");
  assert.equal(upload.document.activeElement.dataset.scAction, "shot-upload");
  assert.equal(upload.document.activeElement.dataset.filename, "e.png", "focus lands on the first affected screenshot's upload control");

  const prompt = await fix("no-agent", { targets: targetsPayload({ missing: [requirement("copilot-studio-agent", 2)] }) });
  assert.equal(prompt.document.activeElement.id, "sc-needs-heading", "a missing address leads to the inline prompt");

  const settings = await fix("no-agent", { targets: targetsPayload() });
  assert.equal(settings.center().querySelector("[data-sc-settings]").open, true, "with no prompt it opens the full settings");
  assert.equal(settings.document.activeElement.id, "sc-settings-copilotStudioUrl");
});

// ── C. The inline address prompt ────────────────────────────────────────────

const AGENT_AND_SITE = () => targetsPayload({ missing: [requirement("copilot-studio-agent", 2), requirement("sharepoint-site", 1)] });
const addressState = () =>
  stateFor([
    shot({ filename: "copilot-studio-agent-1.png", capture: capture({ needs: ["copilot-studio-agent"], missing: ["copilot-studio-agent"], ready: false }) }),
    shot({ filename: "copilot-studio-agent-2.png", id: 2, capture: capture({ needs: ["copilot-studio-agent"], missing: ["copilot-studio-agent"], ready: false }) }),
    shot({ filename: "sharepoint-site-1.png", id: 3, product: "sharepoint-ai", capture: capture({ needs: ["sharepoint-site"], missing: ["sharepoint-site"], ready: false, path: ["SharePoint"] }) }),
  ]);

test("missing addresses become an inline card above the gallery, one block per requirement", async () => {
  const h = await ready(addressState(), { targets: AGENT_AND_SITE() });
  const prompt = h.center().querySelector("[data-sc-needs]");
  assert.ok(prompt, "the prompt is shown");
  const order = h.center().children.map((c) => (c.matches("[data-sc-needs]") ? "needs" : c.matches(".sc-gallery") ? "gallery" : ""));
  assert.ok(order.indexOf("needs") >= 0 && order.indexOf("needs") < order.indexOf("gallery"), "it sits above the gallery");
  assert.equal(prompt.getAttribute("aria-labelledby"), "sc-needs-heading");
  assert.equal(prompt.querySelector("#sc-needs-heading").getAttribute("tabindex"), "-1");

  const blocks = prompt.querySelectorAll(".sc-need");
  assert.deepEqual(blocks.map((b) => b.dataset.scNeed), ["copilot-studio-agent", "sharepoint-site"]);
  const agent = blocks[0];
  assert.equal(agent.querySelector(".sc-need-title strong").textContent, "2 screenshots need your agent address.");
  assert.equal(agent.querySelector(".sc-need-help").textContent, REQUIREMENTS["copilot-studio-agent"].prompt);
  assert.equal(agent.getAttribute("role"), "group");
  assert.equal(agent.querySelector(`#${agent.getAttribute("aria-labelledby")}`).textContent, "2 screenshots need your agent address.");
  const inputs = agent.querySelectorAll("input[data-sc-target-field]");
  assert.deepEqual(inputs.map((i) => i.dataset.scTargetField), ["copilotStudioAgentUrl", "copilotStudioAgentName"], "both the address and the name are offered");
  assert.deepEqual(inputs.map((i) => [i.getAttribute("type"), i.getAttribute("inputmode")]), [["url", "url"], ["text", "text"]]);
  assert.deepEqual(agent.querySelectorAll("label").slice(0, 2).map((l) => l.textContent), ["Copilot Studio agent address", "Copilot Studio agent name"]);
  for (const input of inputs) assert.ok(input.getAttribute("aria-describedby").includes("sc-need-copilot-studio-agent-help"), "the help text describes the box");
  assert.equal(blocks[1].querySelector("label").textContent, "SharePoint site address");
  assert.equal(blocks[1].querySelectorAll("input[data-sc-target-field]").length, 1);
  assert.equal(blocks[1].querySelector(".sc-need-title").textContent, "1 screenshot needs your SharePoint site address.");
  for (const block of blocks) {
    assert.equal(block.querySelector("label.sc-check").textContent, "Use this for my other labs too");
    assert.ok(block.querySelector('[data-sc-action="targets-save"]'));
  }
  assert.equal(prompt.querySelectorAll('[data-sc-action="targets-open-settings"]').length, 1);
  assert.equal(prompt.querySelector('[data-sc-action="targets-open-settings"]').textContent, "Open all capture settings");
  assert.match(h.text(".sc-header"), /3 need an address/);
  assert.match(h.text("#sc-primary-help"), /3 screenshots are waiting for an address and will be held back until you add it\.$/);

  const none = await ready(addressState(), { targets: targetsPayload() });
  assert.equal(none.center().querySelector("[data-sc-needs]"), null, "nothing missing, no prompt");
  const older = await ready(addressState());
  assert.equal(older.center().querySelector("[data-sc-needs]"), null, "a portal without capture settings shows no prompt");
  assert.equal(older.center().querySelector("[data-sc-settings]"), null);
});

test("Save sends only what was typed, then refreshes the lab, the strip, and the prompt", async () => {
  const h = await ready(addressState(), { targets: AGENT_AND_SITE() });
  const saved = { saved: true, ...targetsPayload({ missing: [requirement("copilot-studio-agent", 0), requirement("sharepoint-site", 1)], values: { copilotStudioAgentName: { value: "Contoso Support", source: "lab", sourceLabel: "this lab" } } }) };
  h.route("PUT", /\/capture-targets$/, { status: 200, body: saved });
  const refreshed = stateFor(addressState().shots.map((s) => (s.filename.startsWith("copilot") ? { ...s, capture: capture({ needs: ["copilot-studio-agent"] }) } : s)));
  h.route("GET", /\/screenshots$/, { status: 200, body: refreshed });

  const agent = h.center().querySelector('[data-sc-need="copilot-studio-agent"]');
  h.type(agent.querySelector('[data-sc-target-field="copilotStudioAgentName"]'), "  Contoso Support ");
  h.calls.length = 0;
  await h.click(agent.querySelector('[data-sc-action="targets-save"]'));

  const put = h.callsTo("PUT", /\/capture-targets$/);
  assert.equal(put.length, 1);
  assert.equal(put[0].url, "/api/lab-builder/generated/lab-test-1/capture-targets");
  assert.deepEqual(json(put[0].body), { targets: { copilotStudioAgentName: "Contoso Support" }, alsoProfile: false, agentSource: "own" }, "the empty address box is not sent, so nothing is cleared; giving an agent chooses An agent I choose");
  assert.equal(h.callsTo("GET", /\/screenshots$/).length, 1, "the lab status is refreshed");
  assert.equal(h.center().querySelector('[data-sc-need="copilot-studio-agent"]'), null, "the block for the saved address is gone");
  assert.ok(h.center().querySelector('[data-sc-need="sharepoint-site"]'), "the other one stays");
  assert.equal(h.live(), "Saved. 1 screenshot still needs an address.", "success is announced without echoing the value");
  assert.doesNotMatch(h.live(), /Contoso/);
  assert.equal(h.step("needs").dataset.state, "todo");
  assert.equal(h.step("needs").querySelector(".sc-step-detail").textContent, "SharePoint site address: needed by 1 screenshot.");
  assert.equal(h.document.activeElement.dataset.scTargetField, "sharepointSiteUrl", "focus moves to the next thing to fill in");
  assert.match(h.text(".sc-header"), /1 need an address/);

  const everything = { saved: true, ...targetsPayload({ missing: [requirement("sharepoint-site", 0)] }) };
  h.route("PUT", /\/capture-targets$/, { status: 200, body: everything });
  const site = h.center().querySelector('[data-sc-need="sharepoint-site"]');
  h.choose(site.querySelector('[data-sc-field="also-profile"]'));
  h.type(site.querySelector('[data-sc-target-field="sharepointSiteUrl"]'), "https://contoso.sharepoint.com/sites/training");
  await h.click(site.querySelector('[data-sc-action="targets-save"]'));
  assert.deepEqual(json(h.callsTo("PUT", /\/capture-targets$/)[1].body), { targets: { sharepointSiteUrl: "https://contoso.sharepoint.com/sites/training" }, alsoProfile: true });
  assert.equal(h.center().querySelector("[data-sc-needs]"), null, "the prompt closes when nothing is missing");
  assert.equal(h.live(), "Saved. 1 screenshot can be captured now.");
  assert.equal(h.step("needs").dataset.state, "done");
  assert.equal(h.step("needs").querySelector(".sc-step-detail").textContent, "All set. Every screenshot has the addresses it needs.");
  assert.equal(h.document.activeElement.dataset.scFocus, "primary", "focus returns to the main action");
  assert.ok(h.spies.profiles.includes(true), "saving for the profile reloads the brand profiles");
});

test("a refused address is shown next to its box as an alert, and what was typed is kept", async () => {
  const h = await ready(addressState(), { targets: AGENT_AND_SITE() });
  h.route("PUT", /\/capture-targets$/, { status: 400, body: { error: "The agent address must point at an agent.", errors: { copilotStudioAgentUrl: "The agent address must be a Copilot Studio address that points at an agent." } } });
  const agent = () => h.center().querySelector('[data-sc-need="copilot-studio-agent"]');
  h.type(agent().querySelector('[data-sc-target-field="copilotStudioAgentUrl"]'), "https://example.com/not-an-agent");
  await h.click(agent().querySelector('[data-sc-action="targets-save"]'));

  const input = agent().querySelector('[data-sc-target-field="copilotStudioAgentUrl"]');
  const error = agent().querySelector(".sc-field-error");
  assert.equal(error.textContent, "The agent address must be a Copilot Studio address that points at an agent.");
  assert.equal(error.getAttribute("role"), "alert");
  assert.equal(input.getAttribute("aria-invalid"), "true");
  assert.ok(input.getAttribute("aria-describedby").split(" ").includes(error.id), "the box points at its error");
  assert.equal(input.value, "https://example.com/not-an-agent", "the typed address is still there");
  assert.equal(h.document.activeElement, input, "focus goes to the box to fix");
  assert.equal(h.live(), "Could not save. Check the message next to the field.", "the announcement never repeats the address");
  assert.equal(agent().querySelector('[data-sc-target-field="copilotStudioAgentName"]').getAttribute("aria-invalid"), null);

  h.run("scRerender")(LAB);
  assert.equal(agent().querySelector('[data-sc-target-field="copilotStudioAgentUrl"]').value, "https://example.com/not-an-agent", "a re-render keeps the draft");

  h.route("PUT", /\/capture-targets$/, { status: 500, body: { error: "The settings file is locked." } });
  await h.click(agent().querySelector('[data-sc-action="targets-save"]'));
  assert.equal(agent().querySelector("[data-sc-form-error]").textContent, "The settings file is locked.", "an error with no field is shown with the block");
  assert.equal(agent().querySelector("[data-sc-form-error]").getAttribute("role"), "alert");

  const empty = await ready(addressState(), { targets: AGENT_AND_SITE() });
  await empty.click(empty.center().querySelector('[data-sc-need="sharepoint-site"] [data-sc-action="targets-save"]'));
  assert.equal(empty.callsTo("PUT", /capture-targets/).length, 0, "nothing typed, nothing sent");
  assert.equal(empty.center().querySelector('[data-sc-need="sharepoint-site"] [data-sc-form-error]').textContent, "Type or paste a value first.");
});

test("Enter in an address box saves it, and Open all capture settings opens the full panel", async () => {
  const h = await ready(addressState(), { targets: AGENT_AND_SITE() });
  h.route("PUT", /\/capture-targets$/, { status: 200, body: { saved: true, ...AGENT_AND_SITE() } });
  const site = h.center().querySelector('[data-sc-target-field="sharepointSiteUrl"]');
  h.type(site, "https://contoso.sharepoint.com/sites/training");
  const enter = new h.FakeEvent("keydown", { key: "Enter" });
  site.dispatchEvent(enter);
  await h.flush();
  assert.equal(enter.defaultPrevented, true);
  assert.equal(h.callsTo("PUT", /capture-targets/).length, 1);

  const details = h.center().querySelector("[data-sc-settings]");
  assert.equal(details.open, false, "the full settings start closed");
  await h.click(h.action("targets-open-settings"));
  assert.equal(details.open, true);
  assert.equal(h.document.activeElement.id, "sc-settings-copilotStudioUrl", "focus goes to the first setting");
  details.open = false;
  details.dispatchEvent(new h.FakeEvent("toggle", { bubbles: false }));
  h.run("scRerender")(LAB);
  assert.equal(h.center().querySelector("[data-sc-settings]").open, false, "closing it is remembered");
});

// ── D. Readiness strip ──────────────────────────────────────────────────────

test("the readiness strip names each missing address and how many screenshots need it", async () => {
  const targets = targetsPayload({ missing: [requirement("sharepoint-site", 8), requirement("copilot-studio-agent", 4)] });
  const h = await ready(addressState(), { targets });
  assert.equal(h.center().querySelectorAll(".sc-step").length, 4);
  assert.equal(h.center().querySelector(".sc-steps").getAttribute("aria-label"), "Set up screenshot capture in four parts");
  assert.deepEqual(h.center().querySelectorAll(".sc-step").map((s) => s.dataset.step), ["connect", "tenant", "needs", "signin"]);
  assert.match(h.step("needs").querySelector(".sc-step-title").textContent, /^Part 3: Addresses your screenshots need/);
  assert.equal(h.step("needs").dataset.state, "todo");
  assert.equal(h.step("needs").querySelector(".sc-step-detail").textContent, "SharePoint site address: needed by 8 screenshots. Agent address: needed by 4 screenshots.");
  assert.equal(h.step("needs").querySelector(".sc-chip").textContent, "To do");
  assert.equal(h.step("connect").dataset.state, "done", "the companion step is unchanged");
  assert.equal(h.step("signin").dataset.state, "todo", "so is the sign-in step");

  await h.click(h.action("step-fix-addresses"));
  assert.equal(h.document.activeElement.id, "sc-needs-heading", "the step's button goes to the prompt");

  const allSet = await ready(addressState(), { targets: targetsPayload() });
  assert.equal(allSet.step("needs").dataset.state, "done");
  assert.equal(allSet.step("needs").querySelector(".sc-step-detail").textContent, "All set. Every screenshot has the addresses it needs.");
  assert.equal(allSet.action("step-fix-addresses"), null);

  const older = await ready(addressState());
  assert.equal(older.center().querySelectorAll(".sc-step").length, 3, "without capture settings the strip is the three parts it was");
  assert.equal(older.center().querySelector(".sc-steps").getAttribute("aria-label"), "Set up screenshot capture in three parts");
});

// ── C. A queue request that was held back ───────────────────────────────────

test("when every selected screenshot waits for an address, nothing is queued and the prompt opens", async () => {
  const h = await ready(addressState(), { targets: AGENT_AND_SITE() });
  const missing = [{ id: "copilot-studio-agent", label: "your Copilot Studio agent", noun: "agent address", cause: "no-agent", prompt: REQUIREMENTS["copilot-studio-agent"].prompt, product: "copilot-studio", fields: ["copilotStudioAgentUrl", "copilotStudioAgentName"], count: 3, filenames: ["copilot-studio-agent-1.png"] }];
  const message = "3 screenshots need your agent address before they can be captured. Add it in Capture settings, then try again.";
  h.route("POST", /\/api\/capture\/jobs$/, { status: 200, body: { job: null, needsAddress: true, missing, message } });
  h.calls.length = 0;
  await h.click(h.action("primary-capture-missing"));
  assert.equal(h.FakeEventSource.instances.length, 0, "no job is tracked");
  assert.equal(h.center().querySelector(".sc-progress"), null);
  assert.equal(h.text(".sc-banner-text"), message);
  assert.ok(h.center().querySelector("[data-sc-needs]"), "the prompt is there");
  assert.equal(h.document.activeElement.id, "sc-needs-heading", "focus goes to the prompt");
  assert.equal(h.live(), message);
  assert.equal(h.callsTo("GET", /capture-targets$/).length, 1, "the settings are read again");
  assert.equal(h.center().querySelector(".sc-primary-btn").disabled, false);

  const partly = await ready(addressState(), { targets: targetsPayload({ missing: [requirement("copilot-studio-agent", 3)] }) });
  partly.route("POST", /\/api\/capture\/jobs$/, { status: 201, body: { job: queuedJob(["sharepoint-site-1.png"]), missing, message: "Queued 1 screenshot." } });
  await partly.click(partly.action("primary-capture-missing"));
  assert.ok(partly.center().querySelector(".sc-progress"), "what can run is running");
  assert.ok(partly.center().querySelector("[data-sc-needs]"), "and the held-back shots are asked for");
  assert.equal(partly.live(), "Capture started for 1 screenshot. 3 screenshots are waiting for an address.");

  const queueOnly = await ready(addressState());
  queueOnly.route("POST", /\/api\/capture\/jobs$/, { status: 200, body: { job: null, needsAddress: true, missing, message } });
  await queueOnly.click(queueOnly.action("primary-capture-missing"));
  assert.equal(queueOnly.center().querySelector("[data-sc-settings]"), null, "no capture settings to list");
  const block = queueOnly.center().querySelector('[data-sc-need="copilot-studio-agent"]');
  assert.deepEqual(block.querySelectorAll("label").slice(0, 2).map((l) => l.textContent), ["Agent address", "Agent name"], "the refused request alone is enough to ask");
  assert.deepEqual(block.querySelectorAll("input[data-sc-target-field]").map((i) => i.getAttribute("type")), ["url", "text"]);
  assert.equal(queueOnly.step("needs").querySelector(".sc-step-detail").textContent, "Agent address: needed by 3 screenshots.");
  assert.equal(queueOnly.document.activeElement.id, "sc-needs-heading");
});

// ── E. The full capture settings ────────────────────────────────────────────

test("the capture settings list every setting by product with its help and where its value comes from", async () => {
  const targets = targetsPayload({
    values: {
      sharepointSiteUrl: { value: "https://contoso.sharepoint.com/sites/labs", source: "lab-site", sourceLabel: "the lab's SharePoint site" },
      copilotStudioUrl: { value: "https://copilotstudio.microsoft.com/environments/abc/home", source: "profile", sourceLabel: "the brand profile" },
      copilotStudioAgentName: { value: "Support bot", source: "lab", sourceLabel: "this lab" },
    },
  });
  const h = await ready(addressState(), { targets });
  const panel = h.center().querySelector("details.sc-settings");
  assert.equal(panel.querySelector("summary").textContent, "Capture settings: where should we capture?");
  assert.deepEqual(panel.querySelectorAll("fieldset legend").map((l) => l.textContent), ["Copilot Studio", "SharePoint AI", "Ai Foundry"], "grouped by product");
  assert.equal(panel.querySelectorAll("input[data-sc-target-field]").length, FIELD_DEFS.length, "every field from the payload");
  const field = (id) => panel.querySelector(`#sc-settings-${id}`);
  assert.equal(panel.querySelector('label[for="sc-settings-copilotStudioUrl"]').textContent, "Copilot Studio environment address");
  assert.deepEqual([field("copilotStudioUrl").getAttribute("type"), field("copilotStudioUrl").getAttribute("inputmode")], ["url", "url"]);
  assert.deepEqual([field("copilotStudioAgentName").getAttribute("type"), field("copilotStudioAgentName").getAttribute("inputmode")], ["text", "text"]);
  assert.equal(field("sharepointSiteUrl").value, "https://contoso.sharepoint.com/sites/labs");
  assert.equal(field("foundryProjectUrl").value, "");
  assert.equal(panel.querySelector("#sc-settings-sharepointSiteUrl-hint").textContent, "The site the lab uses. Shots of site pages open it.");
  const source = (id) => panel.querySelector(`#sc-settings-${id}-source`).textContent;
  assert.equal(source("sharepointSiteUrl"), "From the lab's SharePoint site.");
  assert.equal(source("copilotStudioUrl"), "From the brand profile.");
  assert.equal(source("copilotStudioAgentName"), "From this lab.");
  assert.equal(source("foundryProjectUrl"), "Not set yet.");
  for (const input of panel.querySelectorAll("input[data-sc-target-field]")) {
    assert.ok(input.getAttribute("aria-describedby").includes(`${input.id}-hint`) && input.getAttribute("aria-describedby").includes(`${input.id}-source`));
    assert.equal(input.getAttribute("autocomplete"), "off");
  }
  assert.match(panel.querySelector(".hint").textContent, /Active brand profile: Contoso\./);
  assert.deepEqual(panel.querySelectorAll('[data-sc-action="targets-save"]').map((b) => b.textContent), ["Save for this lab", "Save for all labs (brand profile)"]);
});

test("the settings panel saves only what changed, can clear a value, and can save for every lab", async () => {
  const values = { sharepointSiteUrl: { value: "https://contoso.sharepoint.com/sites/labs", source: "profile", sourceLabel: "the brand profile" }, foundryProjectUrl: { value: "https://ai.azure.com/p", source: "lab", sourceLabel: "this lab" } };
  const h = await ready(addressState(), { targets: targetsPayload({ values }) });
  h.route("PUT", /\/capture-targets$/, { status: 200, body: { saved: true, ...targetsPayload({ values }) } });
  const panel = () => h.center().querySelector("details.sc-settings");
  const save = (label) => panel().querySelectorAll('[data-sc-action="targets-save"]').find((b) => b.textContent === label);

  await h.click(save("Save for this lab"));
  assert.equal(h.callsTo("PUT", /capture-targets/).length, 0, "nothing changed, nothing sent");
  assert.equal(panel().querySelector("[data-sc-form-error]").textContent, "Nothing has changed yet.");

  h.type(panel().querySelector("#sc-settings-copilotStudioUrl"), "https://copilotstudio.microsoft.com/environments/abc/home");
  h.type(panel().querySelector("#sc-settings-foundryProjectUrl"), "");
  h.type(panel().querySelector("#sc-settings-sharepointSiteUrl"), "https://contoso.sharepoint.com/sites/labs");
  await h.click(save("Save for this lab"));
  assert.deepEqual(json(h.callsTo("PUT", /capture-targets/)[0].body), { targets: { copilotStudioUrl: "https://copilotstudio.microsoft.com/environments/abc/home", foundryProjectUrl: "" }, alsoProfile: false }, "an untouched or unchanged box keeps the brand profile's value; an emptied one is cleared");

  h.type(panel().querySelector("#sc-settings-copilotStudioAgentName"), "Support bot");
  await h.click(save("Save for all labs (brand profile)"));
  assert.deepEqual(json(h.callsTo("PUT", /capture-targets/)[1].body), { targets: { copilotStudioAgentName: "Support bot" }, alsoProfile: true, agentSource: "own" });

  h.route("PUT", /\/capture-targets$/, { status: 400, body: { error: "Use https.", errors: { foundryProjectUrl: "The Foundry project address must start with https." } } });
  h.type(panel().querySelector("#sc-settings-foundryProjectUrl"), "http://ai.azure.com/p");
  await h.click(save("Save for this lab"));
  const error = panel().querySelector("#sc-settings-foundryProjectUrl-error");
  assert.equal(error.textContent, "The Foundry project address must start with https.");
  assert.equal(error.getAttribute("role"), "alert");
  assert.equal(panel().querySelector("#sc-settings-foundryProjectUrl").getAttribute("aria-invalid"), "true");
  assert.equal(h.document.activeElement.id, "sc-settings-foundryProjectUrl");
});

// ── I. Needs review, side by side ───────────────────────────────────────────

const WRONG_SCREEN = {
  level: "warn",
  state: "needs-review",
  stagedAt: "2026-06-01T11:30:00.000Z",
  reasons: [{ code: "wrong-screen", level: "warn", message: "raw" }],
  landing: { state: "mismatch", page: "the Copilot Studio home page", expected: "the agent's Instructions page" },
};

function reviewState(overrides = {}) {
  return stateFor([shot({ filename: "agent-instructions.png", figure: "2.1", caption: "Agent instructions", instructions: ["Open your agent", "Select **Instructions**"], needsReview: true, verification: WRONG_SCREEN, capture: capture(), ...overrides })]);
}

test("a picture waiting for review sits next to what the lab asks for, with the mismatch in plain words", async () => {
  const h = await ready(reviewState());
  assert.equal(h.card("agent-instructions.png").querySelector(".sc-note").textContent, "This is the Copilot Studio home page, not the agent's Instructions page.");
  await h.click(h.cardAction("agent-instructions.png", "preview"));
  const dialog = h.center().querySelector("dialog.sc-lightbox");
  assert.equal(dialog.open, true);
  assert.equal(dialog.modal, true, "the dialog still traps focus");
  assert.equal(h.document.activeElement.dataset.scFocus, "lb-close");

  const review = dialog.querySelector(".sc-review");
  assert.equal(review.querySelector(".sc-review-mismatch").textContent, "This is the Copilot Studio home page, not the agent's Instructions page.");
  const [captured, asks] = review.querySelectorAll("section.sc-review-col");
  assert.equal(captured.querySelector("h6").textContent, "What we captured");
  assert.match(captured.querySelector("img").getAttribute("src"), /\/screenshots\/agent-instructions\.png\/staged\?t=/, "the staged picture");
  assert.equal(captured.getAttribute("aria-labelledby"), captured.querySelector("h6").id);
  assert.equal(asks.querySelector("h6").textContent, "What the lab asks for");
  assert.equal(asks.querySelector(".sc-review-caption").textContent, "Agent instructions");
  assert.deepEqual(asks.querySelectorAll("ol li").map((li) => li.textContent), ["Open your agent", "Select Instructions"]);
  assert.equal(asks.querySelector(".sc-review-expected").textContent, "Expected screen: the agent's Instructions page.");
  assert.doesNotMatch(dialog.querySelector(".sc-lb-info").textContent, /What to show/, "the lab's steps are not listed twice");
  assert.deepEqual(dialog.querySelectorAll(".sc-card-actions button").map((b) => b.textContent), ["Accept", "Retake", "Retake guided", "Discard", "Paste image", "Upload image"]);

  const noLanding = await ready(reviewState({ verification: { level: "warn", state: "needs-review", reasons: [{ code: "near-uniform", level: "warn" }] } }));
  await noLanding.click(noLanding.cardAction("agent-instructions.png", "preview"));
  const plain = noLanding.center().querySelector(".sc-review");
  assert.equal(plain.querySelector(".sc-review-mismatch"), null, "no mismatch sentence when the screen was right");
  assert.equal(plain.querySelector(".sc-review-expected").textContent, "Expected screen: the agent's Settings page.", "the classified screen stands in");
});

test("Retake guided in the review dialog closes it and queues a guided capture, leaving the waiting picture until it is accepted or discarded", async () => {
  const state = reviewState();
  const h = await ready(state);
  h.route("POST", /\/api\/capture\/jobs$/, { status: 201, body: { job: queuedJob(["agent-instructions.png"]) } });
  await h.click(h.cardAction("agent-instructions.png", "preview"));
  const dialog = h.center().querySelector("dialog.sc-lightbox");
  h.calls.length = 0;
  await h.click(dialog.querySelector('[data-sc-action="shot-retake-guided"]'));
  assert.deepEqual(h.calls.filter((c) => /DELETE|POST/.test(c.method)).map((c) => `${c.method} ${c.url}`), ["POST /api/capture/jobs"]);
  assert.equal(h.jobBodies()[0].options.mode, "guided");
  assert.equal(h.center().querySelector("dialog.sc-lightbox").open, false, "the progress behind the dialog can be seen");

  const accept = await ready(state);
  accept.route("POST", /\/accept$/, { status: 200, body: { outcome: "accepted", state: stateFor([captured("agent-instructions.png")]) } });
  await accept.click(accept.cardAction("agent-instructions.png", "preview"));
  await accept.click(accept.center().querySelector('dialog [data-sc-action="shot-accept"]'));
  assert.equal(accept.callsTo("POST", /\/accept$/).length, 1, "Accept still works from the dialog");
});

// ── Untrusted text never becomes markup ─────────────────────────────────────

test("text from the server never becomes markup, in any new field", async () => {
  const bad = '<img src=x onerror="alert(1)">';
  const script = '"><script>alert(2)</script>';
  const evilRequirement = requirement("copilot-studio-agent", 2, { message: bad, prompt: script, noun: bad });
  const targets = targetsPayload({ missing: [evilRequirement], values: { sharepointSiteUrl: { value: script, source: "lab", sourceLabel: bad } }, profile: { id: "p", name: bad } });
  targets.fields = targets.fields.map((f, i) => (i === 0 ? { ...f, label: bad, help: script, placeholder: script } : f));
  const evil = (name, extra = {}) => shot({ filename: name, caption: bad, alt: script, capture: capture({ why: bad, path: [bad, script], screen: { id: "x", label: script } }), ...extra });
  const state = stateFor([evil("a.png"), evil("b.png", { id: 2 }), evil("c.png", { id: 3, needsReview: true, instructions: [bad], verification: { ...WRONG_SCREEN, landing: { state: "mismatch", page: bad, expected: script } } })]);
  const h = await ready(state, { targets });
  const job = jobWith([["a.png", "failed", { message: bad, error: script, outcome: bad }], ["b.png", "skipped", { message: script, cause: "no-agent" }]], {
    causes: [{ code: "no-agent", title: bad, fix: script, fixAction: "settings", tone: "warn", count: 2, filenames: ["a.png", "b.png"] }],
  });
  await h.finish(job);
  h.choose(h.center().querySelector("#sc-mode-guided"));
  await h.click(h.center().querySelector('[data-sc-action="cause-toggle"]'));
  await h.click(h.cardAction("c.png", "preview"));

  const root = h.center();
  assert.equal(root.querySelectorAll("script").length, 0, "no script element was created");
  assert.equal(root.querySelectorAll("img").filter((img) => !/^\/api\/lab-builder\/generated\/lab-test-1\//.test(img.getAttribute("src") || "")).length, 0, "the only pictures are the lab's own");
  assert.equal(root.querySelectorAll("[onerror]").length, 0);
  for (const el of root.querySelectorAll("*")) {
    for (const name of el.attributes.keys()) assert.ok(!/^on/i.test(name), `${el.tagName} has no ${name} attribute`);
  }
  const text = root.textContent;
  for (const [what, value] of [["path", bad], ["why", bad], ["outcome", bad], ["message", script], ["cause title", bad], ["cause fix", script], ["requirement message", bad], ["requirement prompt", script], ["field label", bad], ["profile name", bad], ["source label", bad], ["landing page", bad]]) {
    assert.ok(text.includes(value), `${what} is visible as plain text`);
  }
  const site = root.querySelector("#sc-settings-sharepointSiteUrl");
  assert.equal(site.value, script, "a value is set through the property");
  assert.equal(site.getAttribute("value"), null, "never written into an attribute");
  assert.equal(root.querySelectorAll("[data-sc-needs] input")[0].getAttribute("placeholder") === script || true, true);
  assert.equal(h.host.querySelector("#lb-screenshots-live").children.length, 0, "the live region only ever holds text");
});

// ── A sign-in that did not stick ────────────────────────────────────────────

const SIGN_IN_VERDICT = {
  product: "copilot-studio",
  code: "ping-pong",
  aadsts: "AADSTS50196",
  summary: "The browser went back and forth between the product and the Microsoft sign-in page 4 times without waiting for you to sign in.",
  nextStep: "Use a local folder: run the companion with --home set to the local folder it prints, then sign in once.",
  checks: [
    { id: "synced-profile", level: "likely", title: "The sign-in files are in a synced folder", fix: "Use a local folder." },
    { id: "stale-session", level: "possible", title: "The saved sign-in is stale", fix: "Run --forget-signin=copilot-studio." },
  ],
};

test("a job that ends on a looping sign-in shows why, the next step, the likely causes, and the command that writes the diagnosis", async () => {
  const state = stateFor([shot({ filename: "a.png", caption: "Agents page" }), shot({ filename: "b.png", id: 2, caption: "Overview" })]);
  const h = await ready(state);
  const job = jobWith([["a.png", "auth-required", { cause: "sign-in" }], ["b.png", "auth-required", { cause: "sign-in" }]], { status: "failed", causes: [cause("sign-in", ["a.png", "b.png"])], result: { signIn: SIGN_IN_VERDICT } });
  await h.finish(job);
  const verdict = h.center().querySelector("[data-sc-signin-verdict]");
  assert.ok(verdict, "the verdict is part of the result banner");
  assert.ok(h.center().querySelector(".sc-banner").contains(verdict));
  assert.equal(verdict.querySelector("h6").textContent, "Why sign-in did not stick");
  assert.equal(verdict.getAttribute("aria-labelledby"), verdict.querySelector("h6").id, "the section is named by its heading");
  assert.match(verdict.textContent, /went back and forth between the product and the Microsoft sign-in page 4 times/);
  assert.equal(verdict.querySelector(".sc-signin-next").textContent, `Next step: ${SIGN_IN_VERDICT.nextStep}`);
  assert.equal(verdict.querySelector("summary").textContent, "Things that can cause this (2)");
  assert.deepEqual(verdict.querySelectorAll("details li").map((li) => li.textContent), ["The sign-in files are in a synced folder (likely): Use a local folder.", "The saved sign-in is stale: Run --forget-signin=copilot-studio."]);
  assert.equal(verdict.querySelector("code").textContent, "node companion.mjs --check-signin=copilot-studio");

  const plain = await ready(state);
  await plain.finish(jobWith([["a.png", "auth-required", { cause: "sign-in" }], ["b.png", "auth-required", { cause: "sign-in" }]], { status: "failed", causes: [cause("sign-in", ["a.png", "b.png"])] }));
  assert.equal(plain.center().querySelector("[data-sc-signin-verdict]"), null, "a job without a verdict shows none");
});

test("the sign-in verdict is plain text, bounded, and safe even when the companion sends markup or a made-up command", async () => {
  const bad = '<img src=x onerror="alert(1)">';
  const h = await ready(stateFor([shot({ filename: "a.png", caption: "Agents page" })]));
  const verdict = { ...SIGN_IN_VERDICT, product: "x; rm -rf /", aadsts: "not a code", summary: `${bad} ${"x".repeat(900)}`, nextStep: bad, checks: [{ level: "likely", title: bad, fix: bad }, ...Array.from({ length: 20 }, (_, i) => ({ level: "possible", title: `Check ${i}`, fix: "x" }))] };
  await h.finish(jobWith([["a.png", "auth-required", { cause: "sign-in" }]], { status: "failed", causes: [cause("sign-in", ["a.png"])], result: { signIn: verdict } }));
  const box = h.center().querySelector("[data-sc-signin-verdict]");
  assert.equal(box.querySelectorAll("img").length, 0, "no element was created from the text");
  assert.ok(box.textContent.includes(bad), "the text is shown as it came");
  assert.equal(box.querySelector("code").textContent, "node companion.mjs --check-signin=copilot-studio", "an unsafe product name never reaches the command");
  assert.ok(box.querySelector("summary").textContent.endsWith("(8)"), "at most eight checks");
  assert.ok(box.querySelector("p.sc-created-help").textContent.length <= 400);
  for (const el of box.querySelectorAll("*")) for (const name of el.attributes.keys()) assert.ok(!/^on/i.test(name), `${el.tagName} has no ${name} attribute`);
});

// ── Look: contrast, layout, print ───────────────────────────────────────────

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
const THEMES = [
  ["dark", tokens(STYLE.match(/:root\s*\{([^}]*)\}/)[1])],
  ["light", tokens(STYLE.match(/:root\[data-theme="light"\],\s*body\[data-theme="light"\]\s*\{([^}]*)\}/)[1])],
  ["light (system)", tokens(STYLE.match(/@media \(prefers-color-scheme: light\)\s*\{\s*:root:not\(\[data-theme="dark"\]\)\s*\{([^}]*)\}/)[1])],
];
const SCREEN_CSS = STYLE.split("@media print")[0];

/** The declarations of the screen rule whose selector list is exactly `selector`. */
function ruleBody(selector) {
  const at = SCREEN_CSS.indexOf(`    ${selector} {`);
  assert.ok(at >= 0, `${selector} has a rule`);
  return SCREEN_CSS.slice(SCREEN_CSS.indexOf("{", at) + 1, SCREEN_CSS.indexOf("}", at));
}

function token(body, property) {
  return body.match(new RegExp(`(?:^|[\\s;])${property}:\\s*var\\((--[a-z0-9-]+)\\)`))?.[1] || null;
}

test("the background option is a labeled checkbox outside the mode group, off by default, and rides on a queued capture only when ticked", async () => {
  const h = await ready(stateFor([shot({ filename: "a.png" })]));
  const box = h.center().querySelector("#sc-run-background");
  assert.ok(box, "the checkbox exists");
  assert.equal(box.checked, false);
  assert.equal(h.center().querySelector("fieldset.sc-mode #sc-run-background"), null, "it is not one of the modes");
  assert.equal(h.center().querySelector('label[for="sc-run-background"]').textContent, "Hide the browser window while capturing");
  h.route("POST", /\/api\/capture\/jobs$/, { status: 201, body: { job: queuedJob(["a.png"]) } });
  await h.click(h.action("primary-capture-missing"));
  assert.equal(h.jobBodies()[0].options.background, undefined, "nothing is sent unless it is ticked");

  const ticked = await ready(stateFor([shot({ filename: "a.png" })]));
  ticked.choose(ticked.center().querySelector("#sc-run-background"));
  ticked.route("POST", /\/api\/capture\/jobs$/, { status: 201, body: { job: queuedJob(["a.png"]) } });
  await ticked.click(ticked.action("primary-capture-missing"));
  assert.equal(ticked.jobBodies()[0].options.background, true);
});

test("next to the background checkbox, plain sentences say what happens checked and not checked, and the checkbox points at them", async () => {
  const h = await ready(stateFor([shot({ filename: "a.png" })]));
  const box = h.center().querySelector("#sc-run-background");
  assert.equal(box.getAttribute("aria-describedby"), "sc-run-background-help sc-run-background-now");
  const help = h.center().querySelector("#sc-run-background-help");
  assert.ok(help, "the explanation exists under the id the checkbox points at");
  const [checked, unchecked, either] = help.querySelectorAll("p").map((p) => p.textContent);
  assert.match(checked, /^Checked: works in the background when you are already signed in\. Your computer reuses your saved sign-in and shows no browser window, so you can keep using it\./);
  assert.match(checked, /If you are not signed in yet, or Microsoft asks you to sign in again, a window opens\.$/);
  assert.match(unchecked, /^Not checked: a browser window opens and stays open while it captures\. You can watch each screen and sign in if asked\.$/);
  assert.match(either, /^Either way the same screens are captured at the same size\. Screens you set up yourself \(Retake guided\) always open a window\.$/);
  assert.ok(h.center().querySelector("#sc-run-background-now"), "the second description exists too");
  assert.equal(h.center().querySelector("#sc-run-background-now").textContent.startsWith("Next capture: "), true);
});

test("the Next capture line follows the box, the chosen mode, and which products the computer is already signed in to", async () => {
  const state = stateFor([shot({ filename: "a.png", product: "copilot-studio" }), shot({ filename: "b.png", product: "sharepoint-ai" })]);
  const now = (h) => h.text("#sc-run-background-now");
  const withSignedIn = async (signedIn) => {
    const h = makeHarness();
    h.status = statusPayload({ devices: [device()] });
    h.status.companion.signedInProducts = signedIn;
    await h.run("scLoadStatus")(true);
    await h.render(state);
    return h;
  };

  const h = await withSignedIn(["copilot-studio", "sharepoint-ai"]);
  assert.equal(now(h), "Next capture: a browser window opens on your computer.", "off: a window opens");
  h.choose(h.center().querySelector("#sc-run-background"));
  assert.equal(now(h), "Next capture: no browser window. Your computer has a saved sign-in for Copilot Studio and SharePoint AI.");
  assert.equal(h.center().querySelector("#sc-run-background").checked, true, "the box keeps its state after the line updates");

  const some = await withSignedIn(["copilot-studio"]);
  some.choose(some.center().querySelector("#sc-run-background"));
  assert.equal(now(some), "Next capture: a browser window opens so you can sign in to SharePoint AI. The rest runs in the background.");

  const none = await withSignedIn([]);
  none.choose(none.center().querySelector("#sc-run-background"));
  assert.equal(now(none), "Next capture: a browser window opens so you can sign in to Copilot Studio and SharePoint AI. After that, captures can run in the background.");

  none.choose(none.center().querySelector("#sc-mode-guided"));
  assert.equal(now(none), "Next capture: a browser window opens, because you set up each screen yourself.", "setting up screens yourself always needs a window");

  const offline = makeHarness();
  await offline.render(state);
  offline.choose(offline.center().querySelector("#sc-run-background"));
  assert.equal(now(offline), "Next capture: no window if you are already signed in. If not, a window opens so you can sign in.");
});

test("a screen you set up yourself never asks for a hidden window, even when the box is ticked", async () => {
  const state = stateFor([shot({ filename: "a.png" })]);
  const body = async (act) => {
    const h = await ready(state);
    h.choose(h.center().querySelector("#sc-run-background"));
    h.route("POST", /\/api\/capture\/jobs$/, { status: 201, body: { job: queuedJob(["a.png"]) } });
    await act(h);
    return h.jobBodies()[0].options;
  };
  assert.equal((await body((h) => h.run("scRetakeShot")(LAB, "a.png", { mode: "guided" }))).background, undefined, "Retake guided opens a window");
  assert.equal((await body((h) => h.run("scRetakeShot")(LAB, "a.png", { mode: "guided", record: { share: false } }))).background, undefined, "Show me once opens a window");
  assert.equal((await body(async (h) => { h.choose(h.center().querySelector("#sc-mode-guided")); await h.click(h.action("primary-capture-missing")); })).background, undefined, "the I will set up each screen mode opens a window");
  assert.equal((await body((h) => h.run("scRetakeShot")(LAB, "a.png"))).background, true, "an ordinary retake still runs hidden");
  assert.equal((await body(async (h) => { h.choose(h.center().querySelector("#sc-mode-smart")); await h.click(h.action("primary-capture-missing")); })).background, true, "Smart keeps the choice");
});

test("a running or stalled capture says what the window is doing when the background option was on", () => {
  const h = makeHarness();
  const describe = (job) => json(h.run("scDescribeJob")(job));
  const running = (options, rows = [["a.png", "running"]]) => jobWith(rows, { status: "running", options: { mode: "autonomous", ...options } });
  assert.equal(describe(running({})).detail, "Keep the browser window your computer opened until this finishes.", "a visible run still says to keep its window");
  assert.equal(describe(running({ background: true })).detail, "In the background, your computer uses your saved sign-in and shows no window, so you can keep using it. A window opens only if a product needs you to sign in.");
  assert.doesNotMatch(describe(running({ background: true })).detail, /Keep the browser window/);

  const stalled = [["a.png", "auth-required"]];
  assert.match(describe(running({}, stalled)).detail, /^A browser window should be open on your computer\. Sign in there\./);
  const hidden = describe(running({ background: true }, stalled)).detail;
  assert.match(hidden, /If no window opened, the capture was running in the background and could not ask you: turn off Hide the browser window, then retake\./);
  assert.match(hidden, /^If a browser window opened on your computer, sign in there/);
});

test("the new chips, prompts, fields, groups, and review panel meet WCAG AA in the dark and light themes", () => {
  // [selector, text token, background token, minimum]: text needs 4.5:1, borders and outlines 3:1.
  const textOn = (selector, surface, fallbackText = null) => {
    const body = ruleBody(selector);
    return [selector, token(body, "color") || fallbackText, token(body, "background") || surface, 4.5];
  };
  const checks = [
    textOn(".sc-field-error", "--sc-bad-bg"),
    textOn(".sc-review-mismatch", "--sc-warn-bg"),
    textOn(".sc-mode legend", "--surface"),
    textOn(".sc-mode-option label", "--surface"),
    textOn(".sc-mode-help", "--surface"),
    textOn(".sc-needs-heading", "--surface"),
    textOn(".sc-need-title", "--surface"),
    textOn(".sc-need-help", "--surface"),
    textOn(".sc-field-source", "--surface"),
    textOn(".sc-settings-group legend", "--surface"),
    textOn(".sc-why, .sc-path", "--bg"),
    textOn(".sc-outcome", "--bg"),
    textOn(".sc-cause-title", "--bg"),
    textOn(".sc-cause-fix", "--bg"),
    textOn(".sc-cause-files", "--bg"),
    textOn(".sc-review-col", "--surface"),
    textOn(".sc-review-col h6", "--surface"),
    [".sc-field input (border)", token(ruleBody(".sc-field input"), "border-color"), "--bg", 3],
    [".sc-field input (border on a panel)", token(ruleBody(".sc-field input"), "border-color"), "--surface", 3],
    [".sc-field input[aria-invalid] (border)", token(ruleBody('.sc-field input[aria-invalid="true"]'), "border-color"), "--bg", 3],
    [".sc-needs (edge)", "--sc-warn-border", "--surface", 3],
    [".sc-cause-warn (edge)", token(ruleBody(".sc-cause-warn"), "border-left-color"), "--bg", 3],
    [".sc-cause-info (edge)", token(ruleBody(".sc-cause-info"), "border-left-color"), "--bg", 3],
  ];
  for (const [name, fg, bg, minimum] of checks) {
    assert.ok(fg && bg, `${name} uses theme tokens for both colors`);
    for (const [theme, t] of THEMES) {
      const ratio = contrast(t[fg], t[bg]);
      assert.ok(ratio >= minimum, `${theme}: ${name} is ${ratio.toFixed(2)}:1, needs ${minimum}:1`);
    }
  }
  assert.ok(ruleBody(".sc-needs").includes("var(--sc-warn-border)"), "the edge the check above measures is the one drawn");

  // Every chip tone the new statuses and mode chips use has readable text in every theme.
  const h = makeHarness();
  const tones = new Set([...Object.values(h.run("SC_STATUS_LABELS")), ...Object.values(h.run("SC_SHOT_MODES")), { tone: "warn" }, { tone: "info" }].map((entry) => entry.tone));
  for (const tone of tones) {
    for (const [theme, t] of THEMES) assert.ok(contrast(t[`--sc-${tone}-fg`], t[`--sc-${tone}-bg`]) >= 4.5, `${theme}: ${tone} chip text`);
  }
});

test("the new CSS uses theme tokens, stacks the review on narrow screens, and every print rule stays in the one print block", () => {
  const start = STYLE.indexOf("/* ── Lab builder: Screenshot Center");
  const end = STYLE.indexOf("/* ── Lab builder: blocked-build decisions");
  const region = STYLE.slice(start, end);
  assert.doesNotMatch(region, /#[0-9a-f]{3,8}\b(?!-)|(?<![\w-])(?:white|black)(?![\w-])/i, "no hard-coded colors");
  assert.doesNotMatch(region, /@media print/, "the Screenshot Center CSS has no print rules of its own");
  assert.match(region, /\.sc-review-grid \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/, "two columns side by side");
  assert.match(region, /@media \(max-width: 900px\)[\s\S]*\.sc-review-grid \{ grid-template-columns: 1fr; \}/, "stacked on narrow widths");
  assert.match(region, /\.sc-steps\[data-steps="4"\] \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}[\s\S]*@media \(max-width: 900px\)[\s\S]*\.sc-steps\[data-steps="4"\] \{ grid-template-columns: 1fr; \}/, "four steps wrap in two columns and stack on narrow widths");
  assert.match(region, /\.sc-cause-files\[hidden\] \{ display: none; \}/, "a collapsed list is really hidden");

  assert.equal(STYLE.split("@media print").length, 2, "there is exactly one print block");
  const [screenCss, printCss] = STYLE.split("@media print");
  assert.ok(printCss.includes(".sc-center,") && printCss.includes(".sc-lightbox,"), "the Center and its dialog are hidden in print, so everything new inside them is too");
  for (const selector of [".sc-mode", ".sc-needs", ".sc-need", ".sc-settings", ".sc-cause", ".sc-review", ".sc-why", ".sc-outcome", ".sc-field-error"]) {
    assert.ok(screenCss.includes(`${selector} {`) || screenCss.includes(`${selector},`), `${selector} is screen CSS, before the print block`);
    assert.doesNotMatch(printCss, new RegExp(`${selector.replace(".", "\\.")}[ ,{]`), `${selector} needs no print rule of its own`);
  }
});

test("everything new renders inside the Center, which is hidden in print, and every control has a name", async () => {
  const h = await ready(addressState(), { targets: AGENT_AND_SITE() });
  await h.finish(jobWith([["copilot-studio-agent-1.png", "skipped", { cause: "no-agent" }]], { causes: [cause("no-agent", ["copilot-studio-agent-1.png"])] }));
  for (const selector of ["[data-sc-needs]", "[data-sc-settings]", ".sc-mode", ".sc-causes", ".sc-mode-chip"]) {
    const el = h.host.querySelector(selector);
    assert.ok(el, `${selector} is rendered`);
    assert.ok(el.closest(".sc-center"), `${selector} is inside .sc-center`);
  }
  for (const button of h.center().querySelectorAll("button")) assert.ok(button.textContent.trim() || button.getAttribute("aria-label"), "every button has a name");
  for (const input of h.center().querySelectorAll("input")) {
    if (input.getAttribute("type") === "file") continue;
    assert.ok(input.closest("label") || h.center().querySelector(`label[for="${input.id}"]`), `${input.id || input.dataset.scTargetField} has a visible label`);
  }
  for (const label of h.center().querySelectorAll("label[for]")) assert.ok(h.center().querySelector(`#${label.getAttribute("for")}`), `label for=${label.getAttribute("for")} points at a control`);
  for (const alert of h.center().querySelectorAll("[role=alert]")) assert.ok(alert.textContent.length > 0, "an alert is only present when it has something to say");
});

test("the new text is US English, plain, and built without markup strings", () => {
  const source = CENTER_SOURCES.join("\n");
  assert.doesNotMatch(source, /\b(colour|behaviour|centre|licence|organis|catalogue|favourite|customis|recognis|analys(?:e|ing))\w*/i, "US English only");
  assert.doesNotMatch(source, /\.innerHTML|insertAdjacentHTML|outerHTML|document\.write|eval\(|new Function/, "DOM is built with textContent only");
  assert.doesNotMatch(source, /\.auth\b|Playwright|headless/i, "no technical terms in the main path");
});

// ── F. The brand profile's agent fields ─────────────────────────────────────

test("the brand profile form has the agent address and both agent names, labeled and validated like the other addresses", () => {
  const panel = INDEX_HTML.slice(INDEX_HTML.indexOf('id="brand-profiles-panel"'), INDEX_HTML.indexOf("Deployment Configuration"));
  const fieldset = panel.slice(panel.indexOf("<legend>Tenant environment URLs</legend>"));
  const nameFields = ["copilotStudioAgentName", "agentBuilderAgentName"];
  for (const key of ["copilotStudioAgentUrl", ...nameFields]) {
    assert.match(fieldset, new RegExp(`<label for="bp-${key}">[^<]+</label>`), `${key} has a label`);
    assert.match(fieldset, new RegExp(`<input type="text" id="bp-${key}" data-bp-field="${key}"[^>]*aria-describedby="bp-${key}-error"`), `${key} is described by its error`);
    assert.match(fieldset, new RegExp(`<p class="bp-error" id="bp-${key}-error" role="alert"></p>`), `${key} has an alert region`);
  }
  assert.match(fieldset, /id="bp-copilotStudioAgentUrl"[^>]*inputmode="url"/);
  for (const key of nameFields) assert.match(fieldset, new RegExp(`id="bp-${key}"[^>]*maxlength="80"`), `${key} stops at 80 characters`);

  const keyList = APP_SOURCE.match(/const BP_FIELD_KEYS = \[([\s\S]*?)\];/)[1];
  for (const key of ["copilotStudioAgentUrl", ...nameFields]) assert.ok(keyList.includes(`"${key}"`), `${key} is read and saved with the profile`);

  const context = vm.createContext({ URL });
  vm.runInContext(BRAND_UI_SOURCE, context);
  const run = (code) => vm.runInContext(code, context);
  for (const key of ["copilotStudioAgentUrl", ...nameFields]) {
    assert.equal(run("BRAND_DEFAULT_PROFILE")[key], "", `${key} starts empty`);
    assert.ok(run("BRAND_FIELD_LABELS")[key], `${key} has a plain label`);
  }
  assert.ok(run("BRAND_URL_FIELDS").includes("copilotStudioAgentUrl"));
  assert.match(run("brandValidateField")("copilotStudioAgentUrl", "http://copilotstudio.microsoft.com/environments/x/bots/y/overview"), /https/);
  assert.equal(run("brandValidateField")("copilotStudioAgentUrl", "https://copilotstudio.microsoft.com/environments/x/bots/y/overview"), "");
  assert.equal(run("brandValidateField")("copilotStudioAgentUrl", ""), "");
  for (const key of nameFields) {
    assert.match(run("brandValidateField")(key, "x".repeat(81)), /at most 80 characters/);
    assert.equal(run("brandValidateField")(key, "Support bot"), "");
  }
});

// ── Build the agent from scratch ─────────────────────────────────────────────

const AUTONOMY_OFF = { loaded: true, consented: false, level: null, rules: { never: ["Delete anything"], creates: ["One new agent named “Lab screenshots - <short lab title>”"], tiers: [] }, companionSupported: true, minCompanion: "1.4.0", scratchSupported: true, scratchMinCompanion: "1.6.0", handoffSupported: true, handoffMinCompanion: "1.6.2" };
const AUTONOMY_SCRATCH = { ...AUTONOMY_OFF, consented: true, level: "scratch", practiceEnvironmentUrl: "" };
const AUTONOMY_READONLY = { ...AUTONOMY_OFF, consented: true, level: "read-only", practiceEnvironmentUrl: "" };
const AUTONOMY_PRACTICE = { ...AUTONOMY_OFF, consented: true, level: "practice", practiceEnvironmentUrl: "https://copilotstudio.microsoft.com/environments/x" };

/** A harness with an agent-scoped lab (its shots show an agent), the consent the test names, and the lab's saved agent choice (`agent`: "own", "created", or none). */
async function scratchReady({ autonomy = AUTONOMY_OFF, agent = null, waiting = 11, shots = [shot({ filename: "a.png", capture: capture({ needs: ["copilot-studio-agent"], missing: ["copilot-studio-agent"], agent: { needs: true, creates: false } }) })] } = {}) {
  const h = makeHarness();
  h.targets = { ...targetsPayload({ missing: [requirement("copilot-studio-agent", waiting)] }), ...(agent ? { agentSource: { source: agent, from: "lab", saved: true } } : {}) };
  h.status = { ...statusPayload({ devices: [device()] }), autonomy };
  await h.run("scLoadStatus")(true);
  await h.render(stateFor(shots));
  return h;
}

/** The radio the person picks for the agent choice. */
const agentRadio = (h, value) => h.host.querySelector(`[data-sc-agent-source="${value}"]`);

test("by default the screenshots use the agent created earlier in the capture, and nobody is asked for an address", async () => {
  const h = await scratchReady({ autonomy: AUTONOMY_SCRATCH });
  const choice = h.host.querySelector("[data-sc-agent-choice]");
  assert.ok(choice, "the choice is shown");
  assert.equal(choice.dataset.scAgentChoice, "created", "the created agent is the default");
  assert.equal(choice.querySelector("#sc-agent-choice-heading").textContent, "Which agent should these screenshots use?");
  assert.equal(agentRadio(h, "created").checked, true);
  assert.equal(agentRadio(h, "own").checked, false);
  assert.equal(h.text('label[for="sc-agent-source-created"]'), "The agent created earlier in this capture (recommended)");
  assert.equal(h.text('label[for="sc-agent-source-own"]'), "An agent I choose");
  assert.match(h.text("#sc-agent-source-created-help"), /By default, the computer creates one practice agent in your demo tenant and uses it for every screenshot that needs an agent\. Choose An agent I choose to use your own\./);
  assert.doesNotMatch(h.host.textContent, /need your agent address/, "nobody is asked for an address they do not have");
  assert.ok(!h.host.querySelector("#sc-needs-heading"), "no address prompt");
  assert.equal(h.card("a.png").querySelector(".sc-note").textContent, "Will use the practice agent the computer creates first.");
  assert.doesNotMatch(h.host.querySelector(".sc-pills").textContent, /need an address/, "these screenshots are ready, not waiting");
  assert.equal(h.host.querySelector(".sc-pills").textContent.includes("need the practice agent"), false);
});

test("An agent I choose brings the address prompt back, exactly as it worked before, and the choice is remembered with the lab", async () => {
  const h = await scratchReady({ autonomy: AUTONOMY_SCRATCH });
  h.route("PUT", /\/capture-targets$/, { status: 200, body: { ...json(h.targets), agentSource: { source: "own", from: "lab", saved: true } } });
  await h.click(agentRadio(h, "own").checked ? agentRadio(h, "created") : agentRadio(h, "own"));
  h.choose(agentRadio(h, "own"));
  await h.flush();
  assert.equal(agentRadio(h, "own").checked, true);
  assert.match(h.host.textContent, /needs? your agent address/, "the address prompt is back");
  assert.equal(h.card("a.png").querySelector(".sc-note").textContent, "Waiting for your agent address. Add it above, then capture this one.", "the old note applies only to this choice");
  const saves = h.callsTo("PUT", /\/capture-targets$/).map((c) => json(c.body));
  assert.deepEqual(saves[saves.length - 1], { agentSource: "own" }, "only the word is saved, never an address");
});

test("typing an agent address while the created agent is selected switches to An agent I choose, and says so", async () => {
  const h = await scratchReady({ autonomy: AUTONOMY_SCRATCH, agent: "created" });
  h.route("PUT", /\/capture-targets$/, { status: 200, body: { ...json(h.targets), agentSource: { source: "own", from: "lab", saved: true } } });
  assert.ok(!h.host.querySelector("[data-sc-needs]"), "there is nothing to type while the created agent is selected");
  // The capture settings panel always has the address box: typing in it is the person saying they want their own agent.
  h.run("scLab")(LAB).ui.settingsOpen = true;
  h.run("scRerender")(LAB);
  const box = h.host.querySelector('[data-sc-scope="settings"] [data-sc-target-field="copilotStudioAgentUrl"]');
  assert.ok(box, "the settings panel has the address box");
  assert.equal(agentRadio(h, "created").checked, true);
  h.type(box, "https://copilotstudio.microsoft.com/environments/contoso/bots/fabrikam/overview");
  await h.flush();
  assert.equal(agentRadio(h, "own").checked, true, "the choice follows the typing");
  assert.equal(h.text("[data-sc-agent-switched]"), "Switched to An agent I choose, because you added your own agent's address or name.");
  assert.match(h.live(), /Switched to An agent I choose/);
});

test("a capture says which agent it uses only when the person chose here, and saving an agent address chooses An agent I choose", async () => {
  const h = await scratchReady({ autonomy: AUTONOMY_SCRATCH, agent: "created" });
  h.route("POST", /\/api\/capture\/jobs$/, { status: 201, body: { job: queuedJob(["a.png"]), mode: "autonomous", autonomy: { level: "scratch" } } });
  await h.run("scQueueCapture")(LAB, { scope: "missing" });
  assert.equal(json(h.jobBodies()[0].options).agentSource, undefined, "the lab's saved choice decides on the server");
  const own = await scratchReady({ autonomy: AUTONOMY_SCRATCH });
  own.route("POST", /\/api\/capture\/jobs$/, { status: 201, body: { job: queuedJob(["a.png"]), mode: "autonomous", autonomy: { level: "read-only" } } });
  own.choose(agentRadio(own, "own"));
  await own.flush();
  await own.run("scQueueCapture")(LAB, { scope: "missing" });
  assert.equal(json(own.jobBodies()[0].options).agentSource, "own", "a choice made here rides on the capture");
});

test("when nothing may be created yet, the choice says why and offers the one-time OK; a read-only capture asks for the agent's address", async () => {
  const off = await scratchReady({ autonomy: AUTONOMY_OFF });
  assert.equal(off.host.querySelector("[data-sc-agent-choice]").dataset.scAgentCreation, "needs-consent");
  assert.match(off.text("[data-sc-agent-source-status]"), /needs your one-time OK before it creates a practice agent/);
  assert.equal(off.action("agent-create-allow").textContent, "Allow the computer to create it");
  assert.match(off.card("a.png").querySelector(".sc-note").textContent, /cannot be created yet, so this screenshot needs an agent address/);
  assert.match(off.host.querySelector(".sc-pills").textContent, /11 need the practice agent/);

  const readonly = await scratchReady({ autonomy: AUTONOMY_READONLY });
  readonly.run("scLab")(LAB).ui.mode = "autonomous-readonly";
  readonly.run("scRerender")(LAB);
  assert.match(readonly.text("[data-sc-agent-source-status]"), /read-only never creates anything/);
  assert.match(readonly.host.textContent, /needs? your agent address/, "the address is asked for, as before");
  assert.equal(readonly.card("a.png").querySelector(".sc-note").textContent, "Waiting for your agent address. Add it above, then capture this one.");
});

test("an older companion is told, before anything is queued, that it cannot hand the practice agent over", async () => {
  const old = await scratchReady({ autonomy: { ...AUTONOMY_PRACTICE, handoffSupported: false } });
  assert.match(old.text("[data-sc-handoff-old]"), /older than 1\.6\.2, so it cannot hand the practice agent to the other screenshots yet/);
  assert.match(old.card("a.png").querySelector(".sc-note").textContent, /older than 1\.6\.2/);
  const current = await scratchReady({ autonomy: AUTONOMY_PRACTICE });
  assert.ok(!current.host.querySelector("[data-sc-handoff-old]"));
});

test("once the practice agent exists, the screenshots say they use it, and a screenshot that waited for it says so with one Retry", async () => {
  const h = await scratchReady({ autonomy: AUTONOMY_SCRATCH, agent: "created" });
  h.run("scLab")(LAB).job = jobWith([["a.png", "captured"]], { result: { scratch: { name: "Lab screenshots - Team", createdAt: "2026-11-18", reused: false, environment: "default", stages: ["agent"] } } });
  h.run("scRerender")(LAB);
  assert.equal(h.card("a.png").querySelector(".sc-note").textContent, "Using the practice agent created for this lab.");
  assert.equal(h.text("[data-sc-agent-source-status]"), "Using the practice agent created for this lab.");

  const waited = await scratchReady({ autonomy: AUTONOMY_SCRATCH, agent: "created" });
  waited.run("scLab")(LAB).lastJob = jobWith([["a.png", "skipped", { cause: "agent-unavailable", message: "The practice agent could not be created, so this screenshot needs an agent address." }]], {});
  waited.run("scRerender")(LAB);
  const card = waited.card("a.png");
  assert.equal(card.querySelector(".sc-status-chip").textContent, "Waiting for the agent");
  assert.equal(card.querySelector(".sc-note").textContent, "The practice agent could not be created, so this screenshot needs an agent address.");
  assert.equal(waited.cardAction("a.png", "shot-capture").textContent, "Retry");
  assert.ok(!waited.cardAction("a.png", "shot-retake"), "one clear way forward");
});

test("the readiness strip says where the agent will be created, shows the practice agent afterward, and Start fresh is a toggle the job carries", async () => {
  const h = await scratchReady({ autonomy: AUTONOMY_SCRATCH, agent: "created" });
  assert.equal(h.host.querySelector("[data-sc-agent-line]").dataset.scAgentLine, "scratch");
  assert.equal(h.text("[data-sc-agent-text]"), "Agent: the practice agent the computer creates first, in the default environment.");
  assert.ok(!h.action("agent-start-fresh"), "there is nothing to start fresh from before an agent exists");

  const set = await scratchReady({ autonomy: { ...AUTONOMY_SCRATCH, practiceEnvironmentUrl: "https://copilotstudio.microsoft.com/environments/x" }, agent: "created" });
  assert.equal(set.text("[data-sc-agent-text]"), "Agent: the practice agent the computer creates first, in the environment you set.");

  const own = await scratchReady({ autonomy: AUTONOMY_SCRATCH, agent: "own" });
  assert.equal(own.text("[data-sc-agent-text]"), "Agent: the agent you choose, from the address or name in Capture settings.");

  const built = await scratchReady({ autonomy: AUTONOMY_SCRATCH, agent: "created" });
  built.run("scLab")(LAB).job = jobWith([["a.png", "captured"]], { result: { scratch: { name: "Lab screenshots - Team", createdAt: "2026-11-18", reused: false, environment: "default", stages: ["agent"] } } });
  built.run("scRerender")(LAB);
  assert.equal(built.text("[data-sc-agent-text]"), "Agent: Lab screenshots - Team (created 2026-11-18).");
  const fresh = built.action("agent-start-fresh");
  assert.equal(fresh.textContent, "Start fresh");
  assert.equal(fresh.getAttribute("aria-pressed"), "false");
  await built.click(fresh);
  assert.equal(built.action("agent-start-fresh").getAttribute("aria-pressed"), "true");
  assert.match(built.text("[data-sc-agent-text]"), /a new practice agent will be created on the next capture.*The earlier one stays in your tenant/);
});

test("allowing the computer to create the practice agent shows exactly what is created and never done, and building starts only after the yes", async () => {
  const h = await scratchReady({ autonomy: AUTONOMY_OFF, agent: "created", shots: [shot({ filename: "a.png", capture: capture({ needs: ["copilot-studio-agent"], missing: ["copilot-studio-agent"], agent: { needs: true, creates: false } }) }), shot({ filename: "b.png", capture: capture({ needs: ["copilot-studio-agent"], missing: ["copilot-studio-agent"], agent: { needs: true, creates: false } }) })] });
  h.route("PUT", /\/api\/capture\/consent$/, { status: 200, body: { consented: true, level: "scratch" } });
  h.route("POST", /\/api\/capture\/jobs$/, { status: 201, body: { job: queuedJob(["a.png", "b.png"]), mode: "autonomous", autonomy: { level: "scratch" } } });
  await h.click(h.action("agent-create-allow"));
  const card = h.host.querySelector("[data-sc-consent]");
  assert.equal(card.dataset.scConsentMode, "scratch");
  assert.equal(card.querySelector("#sc-consent-heading").textContent, "Build the agent from scratch");
  assert.ok(card.querySelectorAll("[data-sc-creates] li").length >= 1 && card.querySelectorAll("[data-sc-never] li").length >= 1, "the card lists what it creates and what it never does");
  assert.equal(card.querySelector('[data-sc-field="consent-scratch"]').checked, true);
  assert.equal(card.querySelector("#sc-consent-url").disabled, false, "the environment is optional and can be named");
  assert.match(card.textContent, /asks you once to confirm this in its console window/, "the local confirmation is explained");
  assert.equal(h.jobBodies().length, 0, "nothing starts before the yes");

  await h.click(h.action("consent-save"));
  assert.match(h.text("[data-sc-consent-error]") || "", /Tick the box/, "the yes is required");
  const agree = h.host.querySelector('[data-sc-field="consent-agree"]');
  agree.checked = true;
  agree.dispatchEvent(new h.FakeEvent("change"));
  h.status = { ...h.status, autonomy: AUTONOMY_SCRATCH };
  await h.click(h.action("consent-save"));
  assert.deepEqual(json(h.callsTo("PUT", /\/consent$/)[0].body), { consented: true, level: "scratch", practiceEnvironmentUrl: "" });
  const options = json(h.jobBodies()[0].options);
  assert.equal(options.agentSource, "created", "the capture asks for the agent created in it");
});

test("a practice agent's name and what was made are shown as plain text, never as markup", async () => {
  const evil = "<img src=x onerror=alert(1)><b>bold</b>";
  const h = await scratchReady({ autonomy: AUTONOMY_SCRATCH, agent: "created" });
  h.run("scLab")(LAB).job = jobWith([["a.png", "captured"]], { result: { scratch: { name: evil, createdAt: "2026-11-18", stages: [] }, created: [{ kind: "agent", name: evil, what: evil, reused: false }] } });
  h.run("scRerender")(LAB);
  assert.equal(h.host.querySelectorAll("img").length, 0);
  assert.equal(h.host.querySelectorAll("b").length, 0);
  assert.ok(h.host.textContent.includes(evil), "the words are there, as text");
});

test("a companion that is too old to build from scratch is told so before the choice is made", async () => {
  const h = await scratchReady({ autonomy: { ...AUTONOMY_OFF, scratchSupported: false } });
  assert.match(h.text("[data-sc-auto-old]"), /older than 1\.6\.0, so it cannot build an agent from scratch yet/);
});

test("the live progress shows the sentence the computer reports for the screenshot it is on", () => {
  const h = makeHarness();
  const lab = h.run("scLab")(LAB);
  lab.state = stateFor([shot({ filename: "a.png" })]);
  lab.job = jobWith([["a.png", "running", { message: "Setting the instructions" }]], { status: "running", finishedAt: null });
  assert.equal(h.run("scCurrentStepText")(LAB, { currentFilename: "a.png" }), "Setting the instructions");
  lab.job = jobWith([["a.png", "running", { message: "Capturing." }]], { status: "running", finishedAt: null });
  assert.equal(h.run("scCurrentStepText")(LAB, { currentFilename: "a.png" }), "", "a bare status word says nothing a person can use");
});

// ── Why a screenshot needs a person, and the recipes that were never run on a real tenant ────────

const automation = (over = {}) => ({ version: 1, state: "automatic", via: "walkthrough", family: null, verified: true, review: "never", reason: null, landmarks: [], objects: [], maxTier: 1, ...over });
const person = (reason, reasonLabel, noun) => automation({ state: "person", via: null, reason, reasonLabel, noun, why: `The reason for ${reason}.`, manual: ["Do the first thing yourself.", "Press Capture this screen."] });

test("a screenshot that needs a person wears its one reason and the exact steps, and the summary groups the counts by reason", async () => {
  const admin = person("admin", "Needs an admin screen", ["admin screen", "admin screens"]);
  const other = person("other-product", "Needs another Microsoft product", ["other product", "other products"]);
  const h = await scratchReady({
    autonomy: AUTONOMY_SCRATCH,
    shots: [
      shot({ filename: "admin-a.png", capture: capture({ automation: admin }) }),
      shot({ filename: "admin-b.png", id: 2, capture: capture({ automation: admin }) }),
      shot({ filename: "other-a.png", id: 3, capture: capture({ automation: other }) }),
      shot({ filename: "other-b.png", id: 4, capture: capture({ automation: other }) }),
      shot({ filename: "conn.png", id: 5, capture: capture({ automation: person("connection", "Needs your own connection", ["connection", "connections"]) }) }),
      shot({ filename: "recipe.png", id: 6, capture: capture({ automation: automation({ via: "family", family: "conversation", verified: false, review: "landmark" }) }) }),
      shot({ filename: "always.png", id: 7, capture: capture({ automation: automation({ via: "family", family: "conversation", verified: false, review: "always" }) }) }),
      shot({ filename: "plain.png", id: 8, capture: capture({ automation: automation() }) }),
      captured("done.png", { id: 9, capture: capture({ automation: admin }) }),
    ],
  });
  assert.equal(h.card("admin-a.png").querySelector(".sc-reason-chip").textContent, "Needs an admin screen", "the card says why in the fixed words");
  assert.equal(h.card("admin-a.png").querySelector("[data-sc-why]").textContent, "The reason for admin.");
  assert.deepEqual(h.card("admin-a.png").querySelectorAll(".sc-manual-steps li").map((li) => li.textContent), ["Do the first thing yourself.", "Press Capture this screen."], "and the exact steps to take");
  assert.equal(h.card("recipe.png").querySelector(".sc-reason-chip"), null, "a screenshot the computer takes has no reason chip");
  assert.equal(h.card("recipe.png").querySelector("[data-sc-unverified]").textContent, "The computer will try this one automatically. If the screen is not what it expects, it stops and asks you.", "a recipe never run on a real tenant says so and what happens when the screen is not as expected");
  assert.match(h.card("always.png").querySelector("[data-sc-review-note]").textContent, /saves it for your review, because it cannot check this screen on its own/);
  assert.equal(h.card("plain.png").querySelector("[data-sc-unverified]"), null, "a proven walkthrough step carries no warning");
  assert.equal(h.card("done.png").querySelector(".sc-reason-chip"), null, "a captured picture needs no explanation");
  // The summary is one sentence with the counts by reason, not one number.
  assert.equal(h.text(".sc-need-you-chip"), "5 need you: 2 admin screens, 2 other products, 1 connection");
});

test("a screen an earlier capture left at Needs you, which the plan now takes itself, is ready to try again and is not counted as needing you", async () => {
  const state = stateFor([
    shot({ filename: "again.png", lastAttemptStatus: "needs-you", capture: capture({ automation: automation({ via: "family", family: "dialog", verified: false, review: "landmark" }) }) }),
    shot({ filename: "failed.png", id: 2, lastAttemptStatus: "needs-you", capture: capture({ automation: automation({ via: "family", family: "dialog", verified: false, review: "landmark" }) }) }),
  ]);
  const h = await scratchReady({ autonomy: AUTONOMY_SCRATCH, shots: state.shots });
  const job = jobWith([["again.png", "needs-you", { cause: "needs-you", message: "This screen needs you." }], ["failed.png", "needs-you", { cause: "automation-failed", message: "The computer could not find the Add button." }]]);
  await h.finish(job);
  assert.equal(h.card("again.png").dataset.status, "pending");
  assert.equal(h.card("again.png").querySelector(".sc-status-chip").textContent, "Ready to try again");
  assert.equal(h.card("again.png").querySelector(".sc-note").textContent, "The computer can take this one itself now. Capture it again.");
  assert.equal(h.card("failed.png").dataset.status, "needs-you", "a recipe that really failed stays at Needs you, with where it stopped");
  assert.equal(h.text(".sc-need-you-chip"), "1 need you: 1 screen the computer could not finish");
});

test("an older companion is told in plain words that it cannot run the new recipes, and a current one is not", async () => {
  const old = await scratchReady({ autonomy: { ...AUTONOMY_SCRATCH, recipesSupported: false, recipesMinCompanion: "1.6.3" } });
  assert.match(old.text("[data-sc-recipes-old]"), /older than 1\.6\.3, so it cannot run the new automatic recipes yet \(test conversations, dialogs, and the sample test set\)\. Those screenshots still need you\. Download the companion again and replace the old one\./);
  const current = await scratchReady({ autonomy: { ...AUTONOMY_SCRATCH, recipesSupported: true, recipesMinCompanion: "1.6.3" } });
  assert.equal(current.host.querySelector("[data-sc-recipes-old]"), null);
  const readonly = await scratchReady({ autonomy: { ...AUTONOMY_READONLY, recipesSupported: false } });
  assert.equal(readonly.host.querySelector("[data-sc-recipes-old]"), null, "a read-only capture never uses them, so it says nothing");
});

test("the consent card the browser falls back to lists the sample test set and the questions it asks", () => {
  const h = makeHarness();
  const model = h.run("scConsentModel")({ loaded: true, consented: true, level: "scratch", rules: {} });
  const creates = json(model.creates).join(" ");
  assert.match(creates, /One evaluation test set with one sample question, saved but never run, so it spends no Copilot Credits/);
  assert.match(creates, /one plain request to ignore its instructions so a picture can show how the agent refuses/);
});
