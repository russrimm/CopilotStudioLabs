/**
 * Harness labels in the Screenshot Center: every picture says whether it is a Standard (Classic) harness picture or a Microsoft Copilot
 * harness picture, so a trainer can make sure the two are never mixed. The real browser scripts run inside node:vm against the small
 * fake DOM (the same way as screenshot-center-ui.test.js), with a fake fetch, so nothing touches a network or a browser.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

import { createFakeDom } from "./fixtures/fake-dom.js";

const publicFile = (name) => readFileSync(new URL(`../public/${name}`, import.meta.url), "utf8");
const CENTER_SOURCES = ["screenshot-center-core.js", "screenshot-center-command.js", "screenshot-center-jobs.js", "screenshot-center-keep.js", "screenshot-center-wrong.js", "screenshot-center-pictures.js", "screenshot-center.js", "lab-checklist.js"].map(publicFile);
const GENERATED_LABS_SOURCE = publicFile("generated-labs.js");
const INDEX_HTML = publicFile("index.html");

const LAB = "lab-test-1";
const NOW = Date.parse("2026-06-01T12:00:00.000Z");
const json = (value) => JSON.parse(JSON.stringify(value));

const STANDARD = "Standard (Classic) harness";
const COPILOT = "Microsoft Copilot harness";
const CUSTOMER = "Customer Conversation harness (preview)";
const EITHER = "Works in either harness";
const NOT_RECORDED = "Harness not recorded";
const STATEMENTS = {
  standard: "This lab: Standard (Classic) harness. Every picture is taken in the Classic harness.",
  "microsoft-copilot": "This lab: Microsoft Copilot harness. Every picture is taken in the Microsoft Copilot harness.",
  "customer-conversation": "This lab: Customer Conversation harness (preview). Every picture is taken in the Customer Conversation harness.",
};
const LABELS = { standard: STANDARD, "microsoft-copilot": COPILOT, "customer-conversation": CUSTOMER, either: EITHER };

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

/** A slot of a Copilot Studio lab with the fields the portal adds for the harness. `state` is the harnessState. */
function slot(filename, harness, state, extra = {}) {
  const has = ["ok", "not-recorded", "wrong-harness"].includes(state);
  const picture = extra.pictureHarness === undefined ? (state === "ok" ? harness : null) : extra.pictureHarness;
  const messages = {
    "not-recorded": `This picture has no harness recorded, so it is not used for a ${{ standard: "Standard (Classic)", "microsoft-copilot": "Microsoft Copilot", "customer-conversation": "Customer Conversation" }[harness]} slot until you say which harness it shows.`,
    "wrong-harness": `This picture is from the ${LABELS[picture]}, but this slot needs the ${LABELS[harness]}.`,
  };
  return shot({
    filename,
    harness,
    harnessLabel: LABELS[harness],
    harnessGap: null,
    harnessGapNote: null,
    pictureHarness: picture,
    pictureHarnessLabel: has ? (picture ? LABELS[picture] : NOT_RECORDED) : null,
    harnessState: state,
    harnessMessage: messages[state] || null,
    ...(has && state !== "wrong-harness" ? { captured: true, capturedAt: "2026-06-01T11:00:00.000Z", captureSource: "manual-upload", imageSource: "lab", imageCapturedAt: "2026-05-20T12:00:00.000Z", confirmed: null, share: { state: "not-shared", libraryConfirmed: false } } : {}),
    ...extra,
  });
}

/** What `GET .../screenshots` returns for a lab built for one harness (`harness` null: a lab with no Copilot Studio part). */
function labState(shots, { harness = "standard", source = "chosen", summary = {} } = {}) {
  const files = (name) => shots.filter((s) => s.harnessState === name).map((s) => s.filename);
  const seen = [...new Set(shots.map((s) => s.pictureHarness).filter(Boolean))];
  const mixed = Boolean(harness) && seen.some((id) => id !== harness);
  const base = {
    labId: LAB,
    title: "Test lab",
    checkState: "up-to-date",
    lastRevalidatedAt: "2026-05-30T10:00:00.000Z",
    cliCommand: `node tools/screenshot-capture/capture.js --generated-lab=${LAB} --headed`,
    summary: { total: shots.length, captured: shots.filter((s) => s.captured).length, missing: shots.filter((s) => !s.captured).length, stale: 0, needsReview: shots.filter((s) => s.needsReview).length, checkState: "up-to-date" },
    modules: [{ featureId: "mod-a", moduleOrder: 1, stepLabel: "Step 1", moduleTitle: "Create an agent", checkState: "up-to-date", status: "up-to-date", primaryUrl: "", diff: null }],
    shots,
  };
  if (!harness) return { ...base, harness: null, harnessLabel: null, harnessInfo: null, harnessSummary: { labHarness: null, statement: "", notRecorded: 0, wrong: 0, gaps: 0, notRecordedFiles: [], wrongFiles: [], gapFiles: [], harnessesSeen: [], mixed: false, mixedMessage: "" } };
  const label = LABELS[harness];
  return {
    ...base,
    harness,
    harnessLabel: label,
    harnessInfo: { id: harness, label, source, statement: STATEMENTS[harness] },
    harnessSummary: {
      labHarness: harness,
      statement: STATEMENTS[harness],
      notRecorded: files("not-recorded").length,
      wrong: files("wrong-harness").length,
      gaps: shots.filter((s) => s.harnessGap).length,
      notRecordedFiles: files("not-recorded"),
      wrongFiles: files("wrong-harness"),
      gapFiles: shots.filter((s) => s.harnessGap).map((s) => s.filename),
      harnessesSeen: seen,
      mixed,
      mixedMessage: mixed ? `This lab is built for the ${label}, but it has pictures from ${seen.length > 1 ? `both the ${seen.map((id) => LABELS[id]).join(" and the ")}` : `the ${seen.map((id) => LABELS[id]).join(" and the ")}`}. A lab must only show pictures from its own harness. Retake the ones from the other harness.` : "",
      ...summary,
    },
  };
}

function device(overrides = {}) {
  return { id: "dev_0123456789ab", name: "Ada PC", platform: "win32", connected: true, busy: false, lastSeenAt: new Date(NOW - 5000).toISOString(), signedInProducts: [], ...overrides };
}

function statusPayload(extra = {}) {
  return {
    companion: { connected: true, lastSeenAt: new Date(NOW).toISOString(), connectedCount: 1, deviceCount: 1, busy: false, signedInProducts: [], devices: [device()], downloadUrl: "/api/capture/companion.zip", onlineWindowSec: 90 },
    serverBrowser: { available: false },
    tenantUrls: { set: false, names: [] },
    sharedLibrary: { location: "persistent", persistent: true, total: 4, captured: 2, missing: 2, needsReview: 0 },
    jobs: { queued: 0, active: 0 },
    pairing: { codeTtlSec: 600 },
    limits: { maxUploadBytes: 8 * 1024 * 1024, acceptedTypes: ["image/png", "image/jpeg", "image/webp"] },
    ...extra,
  };
}

// ── Harness ─────────────────────────────────────────────────────────────────

function makeHarness({ generated = false } = {}) {
  const { document, FakeEvent } = createFakeDom();
  const body = document.body;
  const add = (parent, tag, id) => {
    const el = document.createElement(tag);
    if (id) el.id = id;
    parent.appendChild(el);
    return el;
  };
  const host = add(body, "div", "lb-result-screenshots");
  add(body, "div", "lb-result-checklist");
  add(body, "div", "lb-result-preview");
  add(body, "div", "lb-generated-list");
  add(body, "input", "bp-copilotStudioUrl");

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
      this.handlers = {};
      FakeEventSource.instances.push(this);
    }

    addEventListener(type, fn) {
      (this.handlers[type] ||= []).push(fn);
    }

    close() {}

    emit(type, payload) {
      for (const fn of this.handlers[type] || []) fn({ data: JSON.stringify(payload) });
    }
  }

  const h = { document, host, FakeEvent, FakeEventSource, calls: [], routes: [], status: statusPayload(), spies: { preview: [] } };
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
      else if (method === "GET" && /\/customization$/.test(url)) reply = { status: 200, body: { customized: false } };
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
    File,
    Blob,
    navigator: { clipboard: { writeText: async () => {}, read: async () => [] } },
    localStorage: { getItem: () => null, setItem() {} },
    console,
    CSS: { escape: (s) => String(s) },
    labBuilder: { products: [{ id: "copilot-studio", shortName: "Copilot Studio" }, { id: "sharepoint-ai", shortName: "SharePoint AI" }], industries: [], levels: [], harnesses: [], editing: null },
    escapeHtml: (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]),
    toast() {},
    lbGen: { opened: LAB, labs: [], loaded: true },
    lbLoadResultPreview: async (labId) => {
      h.spies.preview.push(labId);
    },
    lbLoadGenerated: async () => {},
    setActiveTab() {},
  };
  vm.createContext(context);
  if (generated) vm.runInContext(GENERATED_LABS_SOURCE, context);
  for (const source of CENTER_SOURCES) vm.runInContext(source, context);
  if (generated) vm.runInContext(`lbGen.opened = "${LAB}"`, context);

  h.run = (code) => vm.runInContext(code, context);
  h.flush = async (rounds = 8) => {
    for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  h.setStatus = async (payload) => {
    h.status = payload;
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

async function ready(state, options = {}) {
  const h = makeHarness(options);
  await h.setStatus(statusPayload());
  await h.render(state);
  return h;
}

const words = (el) => el.textContent.replace(/\s+/g, " ").trim();
const buttonsOf = (root) => root.querySelectorAll("button").map((b) => b.textContent);
const tagButtons = (root) => root.querySelectorAll('[data-sc-action="harness-tag"]');

// ── The card ────────────────────────────────────────────────────────────────

test("every card says which harness its picture is for, in words, in its own element; a product with no harnesses shows nothing new", async () => {
  const standard = await ready(labState([slot("std-pending.png", "standard", "pending"), slot("std-ok.png", "standard", "ok", { figure: "1.2", id: 2 })]));
  const pending = standard.card("std-pending.png");
  const label = pending.querySelector(".sc-harness-label");
  assert.equal(label.textContent, STANDARD, "the label is the server's words");
  assert.ok(label.classList.contains("sc-harness-label-standard"));
  assert.ok(!label.classList.contains("sc-chip"), "its own element: it never uses the one-line pill rules that cut text off");
  assert.equal(pending.querySelector(".sc-harness").dataset.scHarnessState, "pending");
  assert.ok(!pending.querySelector(".sc-harness-picture"), "no picture yet, so no picture line");
  assert.ok(!pending.querySelector(".sc-harness-tag"), "nothing to tag");
  // It is near the top: the first thing in the card's body, before the status.
  assert.ok(pending.querySelector(".sc-card-body").children[0].classList.contains("sc-harness"));
  const ok = standard.card("std-ok.png");
  assert.equal(ok.querySelector(".sc-harness-picture").textContent, `Picture: ${STANDARD}`);
  assert.equal(ok.querySelector(".sc-harness-label").textContent, STANDARD);

  const copilot = await ready(
    labState(
      [
        slot("mc-ok.png", "microsoft-copilot", "ok"),
        slot("either.png", "either", "none", { harnessLabel: EITHER, id: 2, figure: "1.2" }),
        shot({ filename: "site.png", product: "sharepoint-ai", captured: true, capturedAt: "2026-06-01T11:00:00.000Z", id: 3, figure: "1.3", caption: "Site page" }),
      ],
      { harness: "microsoft-copilot" },
    ),
  );
  assert.equal(copilot.card("mc-ok.png").querySelector(".sc-harness-label").textContent, COPILOT);
  assert.ok(copilot.card("mc-ok.png").querySelector(".sc-harness-label").classList.contains("sc-harness-label-microsoft-copilot"));
  assert.equal(copilot.card("mc-ok.png").querySelector(".sc-harness-picture").textContent, `Picture: ${COPILOT}`);
  assert.equal(copilot.card("either.png").querySelector(".sc-harness-label").textContent, EITHER, "a slot that looks the same in every harness says so");
  assert.ok(!copilot.card("either.png").querySelector(".sc-harness-picture"));
  assert.ok(!copilot.card("site.png").querySelector(".sc-harness"), "SharePoint has no harnesses: the card shows no harness label");
  assert.ok(!/harness/i.test(words(copilot.card("site.png"))), "and no harness words at all");
});

test("a picture with no harness recorded says so and offers one-click buttons that tag it, then re-render and announce", async () => {
  const state = labState([slot("agent-home.png", "standard", "not-recorded"), slot("create-agent.png", "standard", "not-recorded", { id: 2, figure: "1.2", caption: "Create an agent" })]);
  const h = await ready(state);
  const card = h.card("agent-home.png");
  assert.equal(card.querySelector(".sc-harness-picture").textContent, `Picture: ${NOT_RECORDED}`);
  assert.match(card.querySelector(".sc-harness-note").textContent, /^This picture has no harness recorded, so it is not used for a Standard \(Classic\) slot until you say which harness it shows\.$/);
  const buttons = tagButtons(card.querySelector(".sc-harness"));
  assert.deepEqual(buttons.map((b) => b.textContent), ["This is Standard (Classic)", "This is Microsoft Copilot"], "Customer Conversation is not offered in a Standard lab");
  assert.equal(buttons[0].getAttribute("aria-label"), "This is Standard (Classic): Figure 1.1: Agents page");
  assert.equal(card.querySelector(".sc-harness-tag").getAttribute("role"), "group");
  assert.ok(buttons.every((b) => b.tagName === "BUTTON" && b.getAttribute("type") === "button"));

  const tagged = labState([slot("agent-home.png", "standard", "ok"), slot("create-agent.png", "standard", "not-recorded", { id: 2, figure: "1.2", caption: "Create an agent" })]);
  h.route("POST", /\/screenshots\/agent-home\.png\/harness$/, { status: 200, body: { outcome: "tagged", filename: "agent-home.png", harness: "standard", harnessLabel: STANDARD, state: tagged } });
  await h.click(buttons[0]);
  const call = h.callsTo("POST", /\/harness$/)[0];
  assert.equal(call.url, `/api/lab-builder/generated/${LAB}/screenshots/agent-home.png/harness`);
  assert.deepEqual(call.body, { harness: "standard" });
  assert.equal(h.card("agent-home.png").querySelector(".sc-harness-picture").textContent, `Picture: ${STANDARD}`, "the card is drawn again from the new state");
  assert.ok(!h.card("agent-home.png").querySelector(".sc-harness-tag"), "the buttons are gone once it is recorded");
  assert.equal(h.live(), "Recorded as the Standard (Classic) harness.", "announced through the live region");
  assert.ok(tagButtons(h.card("create-agent.png")).length === 2, "the other picture still waits");
  assert.equal(h.document.activeElement.dataset.scFocus, "thumb:agent-home.png", "focus stays on the picture that was tagged");
  assert.ok(h.spies.preview.includes(LAB), "the lab preview is refreshed");
});

test("saying it is the other harness moves the picture, shows the returned message, and the slot is pending again", async () => {
  const h = await ready(labState([slot("agent-home.png", "standard", "not-recorded")]));
  const message = "This picture is from the Microsoft Copilot harness, but this screenshot needs the Standard (Classic) harness, so it is not used. It was moved to the kept pictures list, and the screenshot is waiting for a picture from the Standard (Classic) harness.";
  const after = labState([slot("agent-home.png", "standard", "pending")]);
  h.route("POST", /\/screenshots\/agent-home\.png\/harness$/, { status: 200, body: { outcome: "moved", filename: "agent-home.png", harness: "microsoft-copilot", message, state: after } });
  await h.click(tagButtons(h.card("agent-home.png"))[1]);
  assert.deepEqual(h.callsTo("POST", /\/harness$/)[0].body, { harness: "microsoft-copilot" });
  const card = h.card("agent-home.png");
  assert.equal(card.dataset.status, "pending");
  assert.equal(card.querySelector(".sc-feedback-head").textContent, message, "the server's plain message is shown as it comes");
  assert.equal(h.live(), message);
  assert.ok(!h.center().querySelector("[data-sc-harness-unrecorded]"), "the group is gone");
});

test("a tag that is refused shows the plain reason and changes nothing", async () => {
  const h = await ready(labState([slot("agent-home.png", "standard", "not-recorded")]));
  h.route("POST", /\/harness$/, { status: 409, body: { error: "Accept or discard the picture that is waiting for review first." } });
  await h.click(tagButtons(h.card("agent-home.png"))[0]);
  assert.equal(h.card("agent-home.png").querySelector(".sc-feedback-head").textContent, "Could not record which harness this picture shows.");
  assert.match(h.card("agent-home.png").querySelector(".sc-feedback-list").textContent, /Accept or discard the picture that is waiting for review first\./);
  assert.equal(h.live(), "Could not record which harness this picture shows.");
  assert.equal(tagButtons(h.card("agent-home.png")).length, 2, "the buttons are still there for another try");
});

test("Customer Conversation is offered only when the slot or the lab is built for it", async () => {
  const lab = await ready(labState([slot("agent-home.png", "customer-conversation", "not-recorded")], { harness: "customer-conversation" }));
  assert.deepEqual(tagButtons(lab.card("agent-home.png")).map((b) => b.textContent), ["This is Standard (Classic)", "This is Microsoft Copilot", "This is Customer Conversation"]);
  assert.equal(lab.card("agent-home.png").querySelector(".sc-harness-label").textContent, CUSTOMER);
  assert.ok(lab.card("agent-home.png").querySelector(".sc-harness-label").classList.contains("sc-harness-label-customer-conversation"));
  const other = await ready(labState([slot("agent-home.png", "microsoft-copilot", "not-recorded")], { harness: "microsoft-copilot" }));
  assert.deepEqual(tagButtons(other.card("agent-home.png")).map((b) => b.textContent), ["This is Standard (Classic)", "This is Microsoft Copilot"]);
});

test("a picture from the other harness is not used: the card says so with the server's message, and offers no tag buttons", async () => {
  const h = await ready(labState([slot("agent-home.png", "standard", "wrong-harness", { pictureHarness: "microsoft-copilot" })]));
  const card = h.card("agent-home.png");
  assert.equal(card.dataset.status, "pending", "the slot is pending");
  assert.equal(card.querySelector(".sc-harness-label").textContent, STANDARD);
  assert.equal(card.querySelector(".sc-harness-picture").textContent, `Picture: ${COPILOT}`);
  assert.equal(card.querySelector(".sc-harness-note").textContent, `This picture is from the ${COPILOT}, but this slot needs the ${STANDARD}.`);
  assert.equal(card.querySelector(".sc-harness").dataset.scHarnessState, "wrong-harness");
  assert.ok(!card.querySelector(".sc-harness-tag"), "nothing to tag: the picture shows the other harness");
});

test("a screenshot whose module is not written for the lab's harness shows the plain note, and promises no capture", async () => {
  const note = "This module is written for the Microsoft Copilot harness, but this lab is built for the Standard (Classic) harness, so its picture cannot be taken in the lab's harness. Change the lab's modules or its harness.";
  const capture = { mode: "auto", why: "The computer can open this screen by its address.", path: ["Copilot Studio", "your agent", "Settings"], needs: [], missing: [], ready: true, screen: { id: "settings", label: "the agent's Settings page" } };
  const plain = await ready(labState([slot("gap.png", "standard", "pending", { capture })]));
  assert.ok(plain.card("gap.png").querySelector(".sc-mode-chip"), "without a gap the card promises an automatic capture");
  assert.ok(plain.card("gap.png").querySelector(".sc-plan"));
  const h = await ready(labState([slot("gap.png", "standard", "pending", { capture, harnessGap: { feature: ["microsoft-copilot"], lab: "standard" }, harnessGapNote: note })]));
  const card = h.card("gap.png");
  assert.equal(card.querySelector(".sc-harness-label").textContent, STANDARD);
  assert.equal(card.querySelector(".sc-harness-note").textContent, note);
  assert.equal(card.querySelector(".sc-harness-note").dataset.scHarnessNote, "gap");
  assert.ok(!card.querySelector(".sc-mode-chip") && !card.querySelector(".sc-plan") && !card.querySelector(".sc-why"), "no Automatic chip and no plan for a screenshot that is never captured");
  assert.equal(card.querySelector(".sc-note").textContent, "", "the generic 'needs you' sentence is not repeated");
});

// ── The lab ─────────────────────────────────────────────────────────────────

test("the lab says which harness it is built for at the top, and warns when pictures from two harnesses are mixed", async () => {
  const clean = await ready(labState([slot("a.png", "standard", "ok"), slot("b.png", "standard", "pending", { id: 2, figure: "1.2" })]));
  const banner = clean.center().querySelector("[data-sc-harness-banner]");
  assert.equal(banner.dataset.scHarnessBanner, "standard");
  assert.equal(banner.querySelector("[data-sc-harness-statement]").textContent, STATEMENTS.standard);
  assert.match(banner.querySelector(".sc-harness-source").textContent, /chosen when the lab was built/);
  assert.ok(!banner.querySelector("[data-sc-harness-mixed]") && !banner.querySelector("[data-sc-harness-wrong]") && !banner.querySelector("[data-sc-harness-gaps]"), "nothing is wrong");
  const children = clean.center().children;
  assert.ok(children.indexOf(banner) < children.indexOf(clean.center().querySelector(".sc-steps")), "it sits above the readiness strip, with the header");

  const mixed = await ready(labState([slot("a.png", "standard", "ok"), slot("b.png", "standard", "wrong-harness", { id: 2, figure: "1.2", caption: "Create an agent", pictureHarness: "microsoft-copilot" })]));
  const warning = mixed.center().querySelector("[data-sc-harness-mixed]");
  assert.equal(warning.getAttribute("role"), "status");
  assert.match(warning.textContent, /^Mixed harnesses\. This lab is built for the Standard \(Classic\) harness, but it has pictures from both the Standard \(Classic\) harness and the Microsoft Copilot harness\. A lab must only show pictures from its own harness\. Retake the ones from the other harness\.$/);
  assert.equal(mixed.center().querySelector("[data-sc-harness-wrong]").textContent, "1 picture was taken in a different harness than the lab's. It is not used until you retake it in the Standard (Classic) harness.");
  assert.deepEqual(mixed.center().querySelectorAll(".sc-harness-files li").map((li) => li.textContent), ["Figure 1.2: Create an agent \u00b7 Picture: Microsoft Copilot harness"], "and which picture it is");
  assert.ok(mixed.center().querySelector(".sc-harness-banner").classList.contains("sc-harness-banner-warn"));

  const two = await ready(labState([slot("a.png", "standard", "wrong-harness", { pictureHarness: "microsoft-copilot" }), slot("b.png", "standard", "wrong-harness", { id: 2, figure: "1.2", pictureHarness: "microsoft-copilot" })]));
  assert.equal(two.center().querySelector("[data-sc-harness-wrong]").textContent, "2 pictures were taken in a different harness than the lab's. They are not used until you retake them in the Standard (Classic) harness.");
});

test("a lab with gaps says how many screenshots belong to modules that are not written for its harness", async () => {
  const gap = { feature: ["microsoft-copilot"], lab: "standard" };
  const h = await ready(labState([slot("a.png", "standard", "pending", { harnessGap: gap, harnessGapNote: "This module is written for the Microsoft Copilot harness." }), slot("b.png", "standard", "pending", { id: 2, figure: "1.2", harnessGap: gap, harnessGapNote: "This module is written for the Microsoft Copilot harness." }), slot("c.png", "standard", "ok", { id: 3, figure: "1.3" })]));
  assert.equal(h.center().querySelector("[data-sc-harness-gaps]").textContent, "2 screenshots belong to modules that are not written for this lab's harness (Standard (Classic) harness). Each one says so on its card, and none is captured in another harness.");
  assert.equal(h.center().querySelector("[data-sc-harness-gaps]").dataset.scHarnessGaps, "2");
});

test("a lab with no Copilot Studio part shows no harness banner, no group, and no labels", async () => {
  const h = await ready(labState([shot({ filename: "site.png", product: "sharepoint-ai", captured: true, capturedAt: "2026-06-01T11:00:00.000Z" })], { harness: null }));
  assert.ok(!h.center().querySelector("[data-sc-harness-banner]"));
  assert.ok(!h.center().querySelector("[data-sc-harness-unrecorded]"));
  assert.ok(!h.center().querySelector(".sc-harness-label"));
  assert.ok(!/harness/i.test(words(h.center())), "no harness words anywhere in the Screenshot Center of a lab with no harnesses");
});

test("an older companion's notice is shown with the lab's harness, in the server's words", async () => {
  const h = makeHarness();
  await h.setStatus(statusPayload({ autonomy: { harnessSupported: false, harnessNotice: "Your Local Capture Companion is older than 1.8.0, so it cannot prove which harness a picture was taken in. Update it." } }));
  await h.render(labState([slot("a.png", "standard", "pending")]));
  assert.match(h.center().querySelector("[data-sc-harness-companion]").textContent, /older than 1\.8\.0/);
});

test("the group 'Pictures with no harness recorded' sits above the gallery, lists each picture with its buttons, and says they are not reused until tagged", async () => {
  const state = labState([slot("agent-home.png", "standard", "not-recorded"), slot("create-agent.png", "standard", "not-recorded", { id: 2, figure: "1.2", caption: "Create an agent" }), slot("ok.png", "standard", "ok", { id: 3, figure: "1.3", caption: "Done" })]);
  const h = await ready(state);
  const group = h.center().querySelector('[data-sc-harness-unrecorded="lab"]');
  assert.equal(group.querySelector("h5").textContent, "Pictures with no harness recorded");
  assert.equal(group.querySelector("h5").getAttribute("tabindex"), "-1");
  assert.equal(group.getAttribute("aria-labelledby"), "sc-harness-unrecorded-heading");
  assert.match(group.querySelector(".sc-harness-help").textContent, /^2 pictures in this lab were saved before the harness was recorded, so the file does not say which harness each one shows\. This lab keeps showing them, but they are not reused for another lab until you tag each one\./);
  assert.match(group.querySelector(".sc-harness-help").textContent, /moved to the kept pictures list and its screenshot goes back to pending\.$/);
  assert.ok(h.center().children.indexOf(group) < h.center().children.indexOf(h.center().querySelector(".sc-gallery")), "above the module gallery");
  const items = group.querySelectorAll("[data-sc-harness-item]");
  assert.deepEqual(items.map((li) => li.dataset.scHarnessItem), ["agent-home.png", "create-agent.png"]);
  assert.equal(items[0].querySelector("img").getAttribute("src"), `/api/lab-builder/generated/${LAB}/assets/agent-home.png?v=2026-06-01T11%3A00%3A00.000Z`, "a thumbnail through the lab's own picture address");
  assert.equal(items[0].querySelector('[data-sc-action="preview"]').getAttribute("aria-label"), "Enlarge Figure 1.1: Agents page");
  assert.deepEqual(items[0].querySelectorAll(".sc-harness-pair .sc-harness-label").map((el) => el.textContent), [NOT_RECORDED, `Needs: ${STANDARD}`]);
  assert.deepEqual(tagButtons(items[0]).map((b) => b.textContent), ["This is Standard (Classic)", "This is Microsoft Copilot"]);
  assert.ok(items[0].querySelector(".sc-harness-label-not-recorded"));

  // The same buttons as on the card: they call the same API with the same body.
  h.route("POST", /\/screenshots\/create-agent\.png\/harness$/, { status: 200, body: { outcome: "tagged", harness: "microsoft-copilot", harnessLabel: COPILOT, state: labState([slot("agent-home.png", "standard", "not-recorded"), slot("create-agent.png", "standard", "wrong-harness", { id: 2, figure: "1.2", caption: "Create an agent", pictureHarness: "microsoft-copilot" }), slot("ok.png", "standard", "ok", { id: 3, figure: "1.3", caption: "Done" })]) } });
  await h.click(tagButtons(items[1])[1]);
  assert.deepEqual(h.callsTo("POST", /create-agent\.png\/harness$/)[0].body, { harness: "microsoft-copilot" });
  assert.deepEqual(h.center().querySelectorAll("[data-sc-harness-item]").map((li) => li.dataset.scHarnessItem), ["agent-home.png"], "the tagged picture leaves the group");
  assert.equal(h.document.activeElement.dataset.scFocus, "harness-group:agent-home.png:standard", "focus goes to the remaining picture");

  // The last picture to be tagged: the group goes away and focus lands on the picture's thumbnail in the gallery.
  h.route("POST", /\/screenshots\/agent-home\.png\/harness$/, { status: 200, body: { outcome: "tagged", harness: "standard", harnessLabel: STANDARD, state: labState([slot("agent-home.png", "standard", "ok"), slot("create-agent.png", "standard", "wrong-harness", { id: 2, figure: "1.2", pictureHarness: "microsoft-copilot" })]) } });
  await h.click(tagButtons(h.center().querySelector('[data-sc-harness-unrecorded="lab"]'))[0]);
  assert.ok(!h.center().querySelector("[data-sc-harness-unrecorded]"));
  assert.equal(h.document.activeElement.dataset.scFocus, "thumb:agent-home.png");
  assert.equal(h.live(), "Recorded as the Standard (Classic) harness.", "moving focus does not announce 'Selected' over what the tag said");
});

test("a lab with every picture recorded has no 'no harness recorded' group", async () => {
  const h = await ready(labState([slot("a.png", "standard", "ok"), slot("b.png", "standard", "pending", { id: 2, figure: "1.2" })]));
  assert.ok(!h.center().querySelector("[data-sc-harness-unrecorded]"));
});

// ── The preview dialog, the review, the causes, and the progress ────────────

test("the enlarged picture names the harness in its caption and in the same block as the card, with the same tag buttons", async () => {
  const h = await ready(labState([slot("agent-home.png", "standard", "not-recorded", { caption: "Agents page" })]));
  await h.click(h.action("preview", h.card("agent-home.png")));
  const dialog = h.host.querySelector("dialog.sc-lightbox");
  assert.equal(dialog.querySelector(".sc-lb-caption").textContent, `Agents page \u00b7 ${STANDARD}`);
  const block = dialog.querySelector(".sc-lb-info .sc-harness");
  assert.equal(block.querySelector(".sc-harness-label").textContent, STANDARD);
  assert.equal(block.querySelector(".sc-harness-picture").textContent, `Picture: ${NOT_RECORDED}`);
  assert.deepEqual(tagButtons(block).map((b) => b.getAttribute("aria-label")), ["This is Standard (Classic): Figure 1.1: Agents page", "This is Microsoft Copilot: Figure 1.1: Agents page"]);
  assert.equal(tagButtons(block)[0].dataset.scFocus, "lb:agent-home.png:harness:standard");
});

test("the review compares the picture with what the lab asks for, and says which harness accepting it records", async () => {
  const review = slot("agent-home.png", "standard", "pending", { needsReview: true, verification: { level: "warn", state: "needs-review", reasons: [{ code: "harness-unproven", level: "warn", message: "The companion did not prove which harness this picture was taken in, so it is saved for review. Update your Local Capture Companion to 1.8.1 or newer." }] } });
  const h = await ready(labState([review]));
  await h.click(h.action("preview", h.card("agent-home.png")));
  const compare = h.host.querySelector("[data-sc-review]");
  const columns = compare.querySelectorAll(".sc-review-col");
  assert.equal(columns[1].querySelector(".sc-harness-label").textContent, STANDARD, "'What the lab asks for' names the harness");
  assert.equal(columns[0].querySelector(".sc-harness-picture").textContent, `Picture: ${NOT_RECORDED} yet. Accepting it records it as the ${STANDARD}, so check that it shows that harness first.`);
  assert.match(h.host.querySelector(".sc-lb-info .sc-lb-list").textContent, /did not prove which harness this picture was taken in/);

  const proven = slot("agent-home.png", "standard", "pending", { needsReview: true, verification: { level: "pass", state: "needs-review", reasons: [], evidence: { harness: { id: "standard" } } } });
  const p = await ready(labState([proven]));
  await p.click(p.action("preview", p.card("agent-home.png")));
  assert.equal(p.host.querySelector("[data-sc-review] .sc-review-col .sc-harness-picture").textContent, `Picture: ${STANDARD}. The companion read it from the page.`);
});

test("the two harness reasons read well wherever reasons are listed", () => {
  const h = makeHarness();
  const text = (reason) => h.run("scReasonText")(reason);
  assert.equal(text({ code: "harness-unproven", level: "warn", message: "The companion did not prove which harness this picture was taken in, so it is saved for review. Update your Local Capture Companion to 1.8.1 or newer." }), "The companion did not prove which harness this picture was taken in, so it is saved for review. Update your Local Capture Companion to 1.8.1 or newer.");
  assert.equal(text({ code: "harness-unproven", level: "warn" }), "The companion did not prove which harness this picture was taken in, so it is saved for review. Update your Local Capture Companion to 1.8.1 or newer.", "even when the message is missing");
  assert.equal(text({ code: "wrong-harness", level: "fail", message: "This picture was taken in the Microsoft Copilot harness, but this screenshot needs the Standard (Classic) harness, so it was not saved." }), "This picture was taken in the Microsoft Copilot harness, but this screenshot needs the Standard (Classic) harness, so it was not saved.");
  assert.match(text({ code: "wrong-harness", level: "fail" }), /^This picture was taken in a different harness than this screenshot needs, so it was not saved\./);
  assert.match(text({ code: "harness-gap", level: "fail" }), /not written for the harness this lab is built for/);
  const summary = json(h.run("scVerificationSummary")({ level: "fail", reasons: [{ code: "wrong-harness", level: "fail", message: "This picture was taken in the Microsoft Copilot harness, but this screenshot needs the Standard (Classic) harness, so it was not saved." }, { code: "harness-unproven", level: "warn" }] }));
  assert.equal(summary.headline, "This image cannot be used.");
  assert.deepEqual(summary.items.map((i) => i.level), ["fail", "warn"]);
});

test("a refused upload says why in the harness's own words", async () => {
  const note = "This module is written for the Microsoft Copilot harness, but this lab is built for the Standard (Classic) harness, so its picture cannot be taken in the lab's harness. Change the lab's modules or its harness.";
  const h = await ready(labState([slot("gap.png", "standard", "pending")]));
  h.route("PUT", /\/screenshots\/gap\.png$/, { status: 409, body: { outcome: "rejected", code: "harness-gap", message: note, verification: { ok: false, level: "fail", reasons: [{ code: "harness-gap", level: "fail", message: note }] } } });
  await h.run("scUploadImage")(LAB, "gap.png", new File([new Uint8Array(12000)], "pasted.png", { type: "image/png" }));
  await h.flush();
  assert.equal(h.card("gap.png").querySelector(".sc-feedback-head").textContent, "This image was not accepted.");
  assert.equal(h.card("gap.png").querySelector(".sc-feedback-list").textContent, note);
});

test("'Needs you' reasons and the progress card name the harness of each picture, from the lab or from the job row", async () => {
  const state = labState([slot("a.png", "standard", "pending", { caption: "Agents page" }), slot("b.png", "standard", "pending", { id: 2, figure: "1.2", caption: "Create an agent" })]);
  const h = await ready(state);
  const row = (filename, status, extra = {}) => ({ filename, status, attempts: 1, harness: "standard", harnessLabel: STANDARD, ...extra });
  const job = { id: "job_0123456789abcdef", status: "running", createdAt: new Date(NOW).toISOString(), startedAt: new Date(NOW).toISOString(), claim: { deviceName: "Ada PC", lastActivityAt: new Date(NOW).toISOString() }, target: { type: "lab", labId: LAB }, options: { mode: "autonomous" }, shots: [row("a.png", "running"), row("b.png", "pending")], progress: { total: 2, done: 0, captured: 0, needsReview: 0, failed: 0, manual: 0, skipped: 0, running: 1, pending: 1, percent: 0 }, events: [] };
  h.route("POST", /\/api\/capture\/jobs$/, { status: 201, body: { job } });
  await h.click(h.action("primary-capture-missing"));
  h.FakeEventSource.instances[0].emit("snapshot", { job });
  assert.equal(h.text(".sc-progress-now"), `Now capturing: Figure 1.1: Agents page \u00b7 ${STANDARD}`);

  const done = { ...job, status: "done", shots: [row("a.png", "needs-you", { cause: "needs-you", message: "This module is written for the Microsoft Copilot harness." }), row("b.png", "needs-you", { cause: "needs-you" })], progress: { total: 2, done: 2, captured: 0, needsReview: 0, failed: 0, manual: 0, skipped: 0, running: 0, pending: 0, needsYou: 2, percent: 100 }, causes: [{ code: "needs-you", title: "These screens need you", fix: "Set them up yourself.", fixAction: "guided", tone: "warn", count: 2, filenames: ["a.png", "b.png"] }] };
  h.route("GET", new RegExp(`/api/capture/jobs/${job.id}$`), { status: 200, body: { job: done } });
  h.FakeEventSource.instances[0].emit("end", { status: "done" });
  await h.flush();
  await h.click(h.center().querySelector('[data-sc-action="cause-toggle"]'));
  assert.deepEqual(h.center().querySelectorAll(".sc-cause-files li").map((li) => li.textContent), [`Figure 1.1: Agents page \u00b7 ${STANDARD}`, `Figure 1.2: Create an agent \u00b7 ${STANDARD}`]);
});

test("a library capture shows the harness of the picture it is taking, by its library name", async () => {
  const h = makeHarness();
  await h.setStatus(statusPayload());
  const job = { id: "job_0123456789abcdef", status: "running", createdAt: new Date(NOW).toISOString(), startedAt: new Date(NOW).toISOString(), claim: { lastActivityAt: new Date(NOW).toISOString() }, target: { type: "library", products: ["copilot-studio"] }, options: { mode: "autonomous" }, shots: [{ filename: "agent-overview.copilot.png", status: "running", attempts: 1, harness: "microsoft-copilot", harnessLabel: COPILOT }], progress: { total: 1, done: 0, captured: 0, needsReview: 0, failed: 0, manual: 0, skipped: 0, running: 1, pending: 0, percent: 0 }, events: [] };
  const view = h.run("scDescribeJob")(job);
  assert.equal(view.currentFilename, "agent-overview.copilot.png");
  h.run("scLab")("library").job = job;
  assert.equal(h.run("scCurrentShotName")("library", view), `agent-overview.copilot.png \u00b7 ${COPILOT}`);
});

// ── The shared library ──────────────────────────────────────────────────────

const libraryShot = (filename, extra = {}) => ({ filename, slotFilename: filename.replace(/\.(classic|copilot|customer)\./, "."), product: "copilot-studio", feature: "f-overview", featureName: "Agent overview", harness: null, harnessLabel: null, captured: false, capturedAt: null, confirmed: null, needsReview: false, ...extra });
const LIBRARY = {
  summary: { total: 5, captured: 2, missing: 3, needsReview: 0, confirmed: 0, harnessNotRecorded: 2 },
  shots: [
    libraryShot("agent-overview.classic.png", { harness: "standard", harnessLabel: STANDARD, captured: true, capturedAt: "2026-05-01T10:00:00.000Z" }),
    libraryShot("agent-overview.copilot.png", { harness: "microsoft-copilot", harnessLabel: COPILOT }),
    libraryShot("agent-topics.classic.png", { harness: "standard", harnessLabel: STANDARD, feature: "f-topics", featureName: "Topics" }),
    libraryShot("site-page.png", { product: "sharepoint-ai", feature: "f-site", featureName: "Site page", captured: true, capturedAt: "2026-05-02T10:00:00.000Z" }),
    libraryShot("agent-test.copilot.png", { harness: "microsoft-copilot", harnessLabel: COPILOT, feature: "f-test", featureName: "Test panel", captured: true, capturedAt: "2026-05-03T10:00:00.000Z" }),
  ],
  unrecorded: [
    { filename: "agent-publish.png", feature: "f-publish", featureName: "Publish the agent", product: "copilot-studio", harnesses: ["standard", "microsoft-copilot"], bytes: 20480, capturedAt: "2026-04-01T10:00:00.000Z" },
    { filename: "agent-tools.png", feature: "f-tools", featureName: "Add a tool", product: "copilot-studio", harnesses: ["microsoft-copilot"], bytes: 20480, capturedAt: "2026-04-02T10:00:00.000Z" },
  ],
};

test("the shared library shows each row's harness by its library name, the count per harness, and the pictures with no harness recorded", async () => {
  const h = await ready(labState([slot("a.png", "standard", "pending")]));
  h.route("GET", /\/api\/capture\/library$/, { status: 200, body: LIBRARY });
  await h.click(h.action("library-load"));
  const library = h.host.querySelector("[data-sc-library-host]");

  // The coverage rows keep their words; each product with harnesses adds the split.
  const rows = library.querySelectorAll(".sc-library-row");
  assert.deepEqual(rows.map((r) => r.querySelector(".sc-library-name").textContent), ["Copilot Studio", "SharePoint AI"]);
  assert.deepEqual(rows[0].querySelectorAll(".sc-library-harnesses li").map((li) => words(li)), [`${STANDARD} 1 of 2 captured`, `${COPILOT} 1 of 2 captured`]);
  assert.ok(!rows[1].querySelector(".sc-library-harnesses"), "SharePoint has no harnesses");

  // Every picture of a product with harnesses, keyed by the name it is saved under.
  const details = library.querySelector("[data-sc-library-pictures]");
  assert.equal(details.querySelector("summary").textContent, "Show the 4 pictures by name and harness");
  const pictures = details.querySelectorAll("[data-sc-library-picture]");
  assert.deepEqual(pictures.map((li) => li.dataset.scLibraryPicture), ["agent-overview.classic.png", "agent-overview.copilot.png", "agent-topics.classic.png", "agent-test.copilot.png"]);
  assert.deepEqual(pictures.map((li) => li.querySelector(".sc-harness-label").textContent), [STANDARD, COPILOT, STANDARD, COPILOT]);
  assert.equal(pictures[0].querySelector("code").textContent, "agent-overview.classic.png");
  assert.match(pictures[0].textContent, /Agent overview: captured May 1, 2026/);
  assert.match(pictures[1].textContent, /Agent overview: not captured yet/, "the same slot has a row for each harness");
  assert.ok(!library.querySelector('[data-sc-library-picture="site-page.png"]'), "a picture of a product with no harnesses shows no harness row");
  details.open = true;
  details.dispatchEvent(h.event("toggle", { bubbles: false }));
  h.run("scRenderLibraryHost")();
  assert.equal(h.host.querySelector("[data-sc-library-pictures]").open, true, "the list stays open when the library is drawn again");

  // The group for pictures saved before harnesses were recorded.
  const group = h.host.querySelector('[data-sc-harness-unrecorded="library"]');
  assert.equal(group.querySelector("h6").textContent, "Pictures with no harness recorded");
  assert.match(group.querySelector(".sc-harness-help").textContent, /^2 pictures in the library were saved before harnesses were recorded\. They are not reused for any lab until you say which harness each one shows\./);
  const items = group.querySelectorAll("[data-sc-harness-item]");
  assert.deepEqual(items.map((li) => li.dataset.scHarnessItem), ["agent-publish.png", "agent-tools.png"]);
  assert.equal(items[0].querySelector("img").getAttribute("src"), "/api/capture/library/screenshots/agent-publish.png/image");
  assert.deepEqual(items[0].querySelectorAll(".sc-harness-pair .sc-harness-label").map((el) => el.textContent), [NOT_RECORDED, `Needs: ${STANDARD}`, `Needs: ${COPILOT}`]);
  assert.deepEqual(items[1].querySelectorAll(".sc-harness-pair .sc-harness-label").map((el) => el.textContent), [NOT_RECORDED, `Needs: ${COPILOT}`]);
  const buttons = items[0].querySelectorAll('[data-sc-action="harness-tag-library"]');
  assert.deepEqual(buttons.map((b) => b.textContent), ["This is Standard (Classic)", "This is Microsoft Copilot"]);
  assert.equal(buttons[0].getAttribute("aria-label"), "This is Standard (Classic): Publish the agent");
});

test("tagging a library picture calls the library API, reloads the library, announces, and moves focus", async () => {
  const h = await ready(labState([slot("a.png", "standard", "pending")]));
  h.route("GET", /\/api\/capture\/library$/, { status: 200, body: LIBRARY });
  await h.click(h.action("library-load"));
  const reloaded = { ...LIBRARY, summary: { ...LIBRARY.summary, harnessNotRecorded: 1 }, unrecorded: [LIBRARY.unrecorded[1]] };
  h.route("GET", /\/api\/capture\/library$/, { status: 200, body: reloaded });
  h.route("POST", /\/api\/capture\/library\/screenshots\/agent-publish\.png\/harness$/, { status: 200, body: { outcome: "tagged", filename: "agent-publish.png", libraryFilename: "agent-publish.classic.png", harness: "standard", harnessLabel: STANDARD, state: reloaded } });
  const group = () => h.host.querySelector('[data-sc-harness-unrecorded="library"]');
  await h.click(group().querySelector('[data-sc-harness-item="agent-publish.png"] [data-sc-action="harness-tag-library"]'));
  assert.deepEqual(h.callsTo("POST", /\/harness$/)[0].body, { harness: "standard" });
  assert.equal(h.callsTo("POST", /\/harness$/)[0].url, "/api/capture/library/screenshots/agent-publish.png/harness");
  assert.deepEqual(group().querySelectorAll("[data-sc-harness-item]").map((li) => li.dataset.scHarnessItem), ["agent-tools.png"], "the library is drawn again without it");
  const message = h.host.querySelector("[data-sc-harness-tag-message]");
  assert.equal(message.textContent, `Recorded as the ${STANDARD}. Every lab built for that harness can use it now.`);
  assert.equal(message.getAttribute("role"), "status");
  assert.equal(h.live(), message.textContent);
  assert.equal(h.document.activeElement.dataset.scFocus, "library-harness:agent-tools.png:standard");

  // The other harness than the slot is written for: the server moves it to the kept pictures list and says so.
  const text = "This picture is from the Standard (Classic) harness, but this screenshot needs the Microsoft Copilot harness, so it is not used. It was moved to the kept pictures list.";
  h.route("GET", /\/api\/capture\/library$/, { status: 200, body: { ...reloaded, unrecorded: [] } });
  h.route("POST", /agent-tools\.png\/harness$/, { status: 200, body: { outcome: "moved", filename: "agent-tools.png", harness: "standard", message: text } });
  await h.click(group().querySelector('[data-sc-action="harness-tag-library"]'));
  assert.ok(!h.host.querySelector('[data-sc-harness-unrecorded="library"]'), "the group is gone when nothing is left");
  assert.equal(h.host.querySelector("[data-sc-harness-tag-message]").textContent, text, "the message is shown as it comes");
  assert.equal(h.document.activeElement.dataset.scFocus, "library-heading", "focus goes to the library heading");

  // A refusal is shown too.
  h.route("GET", /\/api\/capture\/library$/, { status: 200, body: LIBRARY });
  await h.run("scLoadLibrary")(true);
  h.run("scRenderLibraryHost")();
  h.route("POST", /agent-publish\.png\/harness$/, { status: 404, body: { error: "There is no picture saved under that name without a harness." } });
  await h.click(h.host.querySelector('[data-sc-harness-item="agent-publish.png"] [data-sc-action="harness-tag-library"]'));
  assert.equal(h.host.querySelector("[data-sc-harness-tag-message]").textContent, "There is no picture saved under that name without a harness.");
  assert.equal(h.host.querySelectorAll("[data-sc-harness-item]").length, 2, "nothing changed");
});

test("the library lists no harness rows and no group for products without harnesses", async () => {
  const h = await ready(labState([slot("a.png", "standard", "pending")]));
  h.route("GET", /\/api\/capture\/library$/, { status: 200, body: { summary: { total: 1, captured: 1, missing: 0, needsReview: 0 }, shots: [libraryShot("site-page.png", { product: "sharepoint-ai", captured: true })], unrecorded: [] } });
  await h.click(h.action("library-load"));
  const library = h.host.querySelector("[data-sc-library-host]");
  assert.ok(!library.querySelector(".sc-library-harnesses") && !library.querySelector("[data-sc-library-pictures]") && !library.querySelector("[data-sc-harness-unrecorded]"));
  assert.ok(!library.querySelector(".sc-harness-label"));
});

// ── Pictures that look wrong, and kept pictures ─────────────────────────────

const flagged = (filename, extra = {}) => ({
  scope: "lab",
  labId: LAB,
  labTitle: "Test lab",
  filename,
  label: "Agents page",
  level: "definite",
  reason: `This picture was taken in the ${COPILOT}, but this screenshot needs the ${STANDARD}.`,
  short: "taken in the other harness",
  flags: [{ code: "HARNESS_MISMATCH", level: "definite", message: `This picture was taken in the ${COPILOT}, but this screenshot needs the ${STANDARD}.` }],
  reach: "unknown",
  writable: true,
  sha256: "a".repeat(64),
  width: 1280,
  height: 800,
  harness: "standard",
  harnessLabel: STANDARD,
  pictureHarness: "microsoft-copilot",
  pictureHarnessLabel: COPILOT,
  ...extra,
});
const suspectReply = (pictures) => ({
  status: 200,
  body: { scannedAt: "2026-06-01T12:00:00.000Z", counts: { total: pictures.length, definite: pictures.filter((p) => p.level === "definite").length, probable: 0 }, notice: `${pictures.length} pictures look like the wrong screen. Review them.`, retentionDays: 90, pictures },
});

test("Pictures that look wrong show the harness the slot needs, the harness the picture was taken in, and the two new findings", async () => {
  const pictures = [
    flagged("agent-home.png"),
    flagged("create-agent.png", { label: "Create an agent", flags: [{ code: "HARNESS_MIXED", level: "definite", message: `This is the same picture that is used for Topics in the ${COPILOT}. A picture can show only one harness, and this screenshot needs the ${STANDARD}.` }], reason: `This is the same picture that is used for Topics in the ${COPILOT}.`, pictureHarness: "standard", pictureHarnessLabel: STANDARD }),
    flagged("site.png", { label: "Site page", scope: "library", labId: null, harness: null, harnessLabel: null, pictureHarness: null, pictureHarnessLabel: null, flags: [], reason: "This shows the product's start page.", level: "probable" }),
    flagged("old.png", { label: "Old picture", pictureHarness: null, pictureHarnessLabel: NOT_RECORDED, flags: [], reason: "This looks the same as another screenshot." }),
  ];
  const h = makeHarness();
  h.route("GET", /\/api\/capture\/suspect-pictures/, suspectReply(pictures));
  await h.setStatus(statusPayload());
  await h.render(labState([slot("agent-home.png", "standard", "ok")]));
  await h.flush();
  await h.click(h.action("wrong-review"));
  const rows = h.host.querySelectorAll("[data-sc-wrong-picture]");
  assert.equal(rows.length, 4);
  assert.equal(rows[0].querySelector(".sc-harness-label").textContent, STANDARD, "what the slot needs");
  assert.equal(rows[0].querySelector(".sc-harness-picture").textContent, `Picture: ${COPILOT}`, "what the picture was taken in");
  assert.equal(rows[0].querySelector("[data-sc-harness-flag]").dataset.scHarnessFlag, "HARNESS_MISMATCH");
  assert.equal(rows[0].querySelector("[data-sc-harness-flag]").textContent, "Taken in the other harness");
  assert.equal(rows[1].querySelector("[data-sc-harness-flag]").textContent, "The same picture is used for two harnesses");
  assert.equal(rows[1].querySelector(".sc-harness-picture").textContent, `Picture: ${STANDARD}`);
  assert.ok(!rows[2].querySelector(".sc-harness"), "a picture of a product with no harnesses shows no harness label");
  assert.equal(rows[3].querySelector(".sc-harness-picture").textContent, `Picture: ${NOT_RECORDED}`);
  assert.ok(!rows[3].querySelector("[data-sc-harness-flag]"));

  // The viewer's caption and info say the same, and it says them out loud.
  await h.click(rows[0].querySelector("[data-sc-pic-open]"));
  const dialog = h.host.querySelector("dialog.sc-lightbox");
  assert.equal(dialog.querySelector("[data-sc-pic-caption]").textContent, `Needs: ${STANDARD}. Picture: ${COPILOT}.`);
  assert.equal(dialog.querySelector(".sc-pic-harness .sc-harness-label").textContent, STANDARD);
  assert.equal(dialog.querySelector(".sc-pic-harness .sc-harness-picture").textContent, `Picture: ${COPILOT}`);
  assert.equal(dialog.querySelector("[data-sc-harness-flag]").textContent, "Taken in the other harness");
  assert.match(dialog.querySelector("[data-sc-pic-live]").textContent, /Picture 1 of 4: Agents page\. Needs: Standard \(Classic\) harness\. Picture: Microsoft Copilot harness\./);
  dialog.dispatchEvent(h.event("keydown", { key: "ArrowRight" }));
  assert.equal(dialog.querySelector("[data-sc-pic-caption]").textContent, `Needs: ${STANDARD}. Picture: ${STANDARD}.`, "the next picture says its own harness");
  dialog.dispatchEvent(h.event("keydown", { key: "ArrowRight" }));
  assert.ok(!dialog.querySelector("[data-sc-pic-caption]") && !dialog.querySelector(".sc-pic-harness"), "no harness lines for a picture with no harness");
});

const KEPT_ENTRY = (pictures, extra = {}) => ({ id: "contoso-labs-20260301000000-ab12", labId: "contoso-labs", labTitle: "Contoso Labs", reason: "deleted", keptAt: "2026-03-01T12:00:00.000Z", daysLeft: 62, pictures, ...extra });
const keptPicture = (filename, extra = {}) => ({ filename, base: filename, why: "lab-only", message: "", earlierVersion: false, restore: [], harness: null, ...extra });

test("Kept pictures say which harness the picture was taken in, or 'Harness not recorded', and why a wrong-harness picture was moved", async () => {
  const message = `This picture is from the ${COPILOT}, but this slot needs the ${STANDARD}.`;
  const entries = [
    KEPT_ENTRY([keptPicture("a.png", { harness: "standard" }), keptPicture("b.png", { harness: "microsoft-copilot" }), keptPicture("c.png"), keptPicture("site.png", { harnessApplies: false })]),
    KEPT_ENTRY([keptPicture("d.png", { harness: "microsoft-copilot", why: "wrong-harness", message })], { id: "shared-library-20260302000000-cd34", labId: "library", labTitle: "Shared library", reason: "wrong-harness" }),
  ];
  const h = makeHarness();
  await h.setStatus(statusPayload());
  await h.render(labState([slot("a.png", "standard", "pending")]));
  h.route("GET", /\/api\/capture\/kept$/, { status: 200, body: { retentionDays: 90, entries } });
  await h.click(h.action("keep-load"));
  const rows = h.host.querySelectorAll(".sc-keep-row");
  assert.deepEqual(rows.map((r) => r.querySelector(".sc-harness-picture")?.textContent ?? null), [`Picture: ${STANDARD}`, `Picture: ${COPILOT}`, `Picture: ${NOT_RECORDED}`, null, `Picture: ${COPILOT}`]);
  assert.ok(rows.every((r) => !r.querySelector(".sc-harness-label")), "a kept picture has no slot, so it only says what it was taken in");
  assert.equal(rows[4].querySelector(".sc-library-meta").textContent, message, "the reason for a wrong-harness picture is the server's sentence");
  assert.equal(h.host.querySelectorAll(".sc-keep-entry-head")[1].textContent, "From \u201cShared library\u201d (moved because they showed the wrong harness Mar 1, 2026). 62 days left.");

  // The same, in the viewer's caption.
  await h.click(rows[2].querySelector("[data-sc-pic-open]"));
  const dialog = h.host.querySelector("dialog.sc-lightbox");
  assert.equal(dialog.querySelector("[data-sc-pic-caption]").textContent, `Picture: ${NOT_RECORDED}.`);
  assert.equal(dialog.querySelector(".sc-pic-harness .sc-harness-picture").textContent, `Picture: ${NOT_RECORDED}`);
});

test("a kept picture moved for the wrong harness explains itself even when the server sent no message", () => {
  const h = makeHarness();
  assert.equal(h.run("scKeepWhy")({ why: "wrong-harness", message: "" }), "Moved because it was taken in a different harness than its screenshot needs.");
  assert.equal(h.run("scKeepWhy")({ why: "lab-only", message: "" }), "Specific to that lab.", "the other reasons are as they were");
});

// ── The screenshots-left list ───────────────────────────────────────────────

test("the 'Screenshots left' list states the lab's harness and names the harness of each picture, as words", () => {
  const h = makeHarness({ generated: true });
  const entry = (filename, extra = {}) => ({ filename, figure: "1.1", caption: "Agents page", shows: "The agents page", why: "", steps: ["Open Copilot Studio"], ...extra });
  const list = {
    labId: LAB,
    counts: { missing: 3, computer: 1, you: 2 },
    labHarness: { id: "standard", label: STANDARD, statement: STATEMENTS.standard },
    you: [entry("a.png", { harness: "standard", harnessLabel: STANDARD }), entry("gap.png", { figure: "1.2", harness: "standard", harnessLabel: STANDARD, why: "This module is written for the Microsoft Copilot harness, but this lab is built for the Standard (Classic) harness." })],
    computer: [entry("c.png", { figure: "1.3", harness: "standard", harnessLabel: STANDARD })],
  };
  const html = h.run("lbRenderChecklistHtml")(list);
  assert.ok(html.includes(`<p class="lb-checklist-harness-statement"><strong>${STATEMENTS.standard}</strong></p>`), "the lab's statement");
  assert.equal(html.split(`<span class="sc-harness-label sc-harness-label-standard">${STANDARD}</span>`).length - 1, 3, "every picture names its harness");
  assert.ok(html.includes(`<p><strong>Harness:</strong> ${STANDARD}</p>`), "and says it again inside the steps");
  assert.ok(html.includes("<strong>Why it needs you:</strong> This module is written for the Microsoft Copilot harness"));
  const plain = h.run("lbRenderChecklistHtml")({ ...list, labHarness: null, you: [entry("site.png")], computer: [], counts: { missing: 1, computer: 0, you: 1 } });
  assert.ok(!plain.includes("harness"), "a list with no harness says nothing about one");
  assert.ok(h.run("lbRenderChecklistHtml")({ ...list, counts: { missing: 0, computer: 0, you: 0 } }).includes(STATEMENTS.standard), "the statement is there when nothing is left, too");
  const escaped = h.run("lbRenderChecklistHtml")({ ...list, you: [entry("a.png", { harness: "standard\"><img src=x>", harnessLabel: "<b>Standard</b>" })] });
  assert.ok(!escaped.includes("<b>Standard</b>") && !escaped.includes("<img"), "nothing from the network is parsed as markup");
});

// ── A lab built for both harnesses, one after another ───────────────────────

const BOTH_ORDER = ["standard", "microsoft-copilot"];
const BOTH_LABEL = "Both harnesses: Standard (Classic) harness, then Microsoft Copilot harness";
const BOTH_STATEMENT = "This lab: both harnesses, one after another (Standard (Classic) harness first, then Microsoft Copilot harness). Each picture is taken in the harness of the part it sits in, and the two are never crossed. A shared topic is taken in the Standard (Classic) harness.";

/** A slot of a combined lab: `part` is "shared", "shared-late", or the harness of the section it sits in. */
function partSlot(filename, harness, state, part, extra = {}) {
  const shared = part === "shared" || part === "shared-late";
  return slot(filename, harness, state, { harnessPart: part, harnessScope: shared ? "shared" : "harness", ...(shared ? { harnessNote: "Works in either harness" } : {}), ...extra });
}

/** What `GET .../screenshots` returns for a lab that covers both harnesses: no single harness, the statement, and the pictures of each part. */
function combinedState(shots, { order = BOTH_ORDER, source = "chosen", summary = {}, info = {} } = {}) {
  const base = labState(shots, { harness: null });
  const files = (name) => shots.filter((s) => s.harnessState === name).map((s) => s.filename);
  const parts = order.map((id) => {
    const own = shots.filter((s) => s.harness === id);
    const count = (name) => own.filter((s) => s.harnessState === name).length;
    return { harness: id, label: LABELS[id], shots: own.length, taken: count("ok"), wrong: count("wrong-harness"), notRecorded: count("not-recorded") };
  });
  return {
    ...base,
    harness: null,
    harnessLabel: BOTH_LABEL,
    harnessInfo: { id: null, mode: "both", order, label: BOTH_LABEL, source, statement: BOTH_STATEMENT, ...info },
    harnessSummary: { labHarness: null, combined: true, order, parts, statement: BOTH_STATEMENT, mixed: false, mixedMessage: "", wrong: files("wrong-harness").length, notRecorded: files("not-recorded").length, gaps: 0, notRecordedFiles: files("not-recorded"), wrongFiles: files("wrong-harness"), gapFiles: [], harnessesSeen: [...new Set(shots.map((s) => s.pictureHarness).filter(Boolean))], ...summary },
  };
}

const combinedShots = () => [
  partSlot("shared.png", "standard", "pending", "shared", { figure: "1.1", caption: "Choose a harness" }),
  partSlot("std-ok-1.png", "standard", "ok", "standard", { id: 2, figure: "2.1", caption: "Create an agent" }),
  partSlot("std-ok-2.png", "standard", "ok", "standard", { id: 3, figure: "2.2", caption: "Add knowledge" }),
  partSlot("std-pending.png", "standard", "pending", "standard", { id: 4, figure: "2.3", caption: "Test the agent" }),
  partSlot("mc-ok.png", "microsoft-copilot", "ok", "microsoft-copilot", { id: 5, figure: "3.1", caption: "Build the agent" }),
  partSlot("mc-wrong.png", "microsoft-copilot", "wrong-harness", "microsoft-copilot", { id: 6, figure: "3.2", caption: "Add a skill", pictureHarness: "standard" }),
];

test("a lab built for both harnesses states them at the top, counts the pictures of each part, and never says the lab is mixed", async () => {
  const h = await ready(combinedState(combinedShots()));
  const banner = h.center().querySelector("[data-sc-harness-banner]");
  assert.equal(banner.dataset.scHarnessBanner, "both", "a lab with no single harness (harness is null) still has a banner");
  assert.equal(banner.getAttribute("aria-label"), "The harnesses this lab is built for");
  assert.equal(banner.querySelector("[data-sc-harness-statement]").textContent, BOTH_STATEMENT);
  assert.equal(banner.querySelector(".sc-harness-source").textContent, "Both harnesses were chosen when the lab was built.");
  assert.ok(!banner.querySelector("[data-sc-harness-mixed]"), "no 'pictures from both harnesses' warning");
  assert.doesNotMatch(words(banner), /Mixed harnesses|built for the (Standard|Microsoft)|lab's harness/);

  // One line per part, in the order the lab takes them, with the harness's own label and how many pictures are in it.
  const lines = banner.querySelectorAll("[data-sc-harness-part]");
  assert.deepEqual(lines.map((li) => li.dataset.scHarnessPart), ["standard", "microsoft-copilot"]);
  assert.deepEqual(lines.map((li) => li.textContent), [`${STANDARD} part: 2 of 4 pictures taken in it`, `${COPILOT} part: 1 of 2 pictures taken in it, 1 taken in a different harness`]);
  assert.deepEqual(lines.map((li) => li.querySelector(".sc-harness-label").className.split(" ").pop()), ["sc-harness-label-standard", "sc-harness-label-microsoft-copilot"], "the label's border style tells them apart as well");
  assert.ok(lines[1].classList.contains("sc-harness-part-warn"));
  assert.ok(!lines[0].classList.contains("sc-harness-part-warn"));

  // The wrong picture is named, with what it needs and what it was taken in.
  assert.equal(banner.querySelector("[data-sc-harness-wrong]").textContent, "1 picture was taken in a different harness than the part it sits in needs. It is not used until you retake it in that part's harness.");
  assert.deepEqual(banner.querySelectorAll(".sc-harness-files li").map((li) => li.textContent), [`Figure 3.2: Add a skill \u00b7 Needs: ${COPILOT} \u00b7 Picture: ${STANDARD}`]);
  assert.ok(banner.classList.contains("sc-harness-banner-warn"));

  // Even if a server (wrongly) sent the single-harness warning, a combined lab never shows it.
  const guarded = await ready(combinedState(combinedShots(), { summary: { mixed: true, mixedMessage: "This lab is built for the Standard (Classic) harness, but it has pictures from both harnesses." }, info: {} }));
  assert.ok(!guarded.center().querySelector("[data-sc-harness-mixed]"));
  const noSummaryFlag = combinedState(combinedShots());
  delete noSummaryFlag.harnessSummary.combined;
  noSummaryFlag.harnessSummary.mixed = true;
  const byMode = await ready(noSummaryFlag);
  assert.ok(!byMode.center().querySelector("[data-sc-harness-mixed]"), "the lab's mode decides, not one flag");
  assert.equal(byMode.center().querySelector("[data-sc-harness-banner]").dataset.scHarnessBanner, "both");

  // The part counts come from the pictures when the server sent none.
  const bare = combinedState(combinedShots());
  delete bare.harnessSummary.parts;
  const derived = json(makeHarness().run("scHarnessLabModel")(bare));
  assert.deepEqual(derived.parts.map((p) => [p.id, p.shots, p.taken, p.wrong, p.notRecorded]), [["standard", 4, 2, 0, 0], ["microsoft-copilot", 2, 1, 1, 0]]);
  assert.deepEqual([derived.combined, derived.id, derived.mixed], [true, null, false]);

  // A lab that took the other order says so: the Microsoft Copilot part comes first.
  const reversed = await ready(combinedState([partSlot("a.png", "microsoft-copilot", "ok", "microsoft-copilot"), partSlot("b.png", "standard", "pending", "standard", { id: 2 })], { order: ["microsoft-copilot", "standard"] }));
  assert.deepEqual(reversed.center().querySelectorAll("[data-sc-harness-part]").map((li) => li.dataset.scHarnessPart), ["microsoft-copilot", "standard"]);
});

test("each card of a lab built for both harnesses names the harness of its part, and a picture from the other harness says so", async () => {
  const h = await ready(combinedState(combinedShots()));
  assert.equal(h.card("std-ok-1.png").querySelector(".sc-harness-label").textContent, STANDARD);
  assert.equal(h.card("mc-ok.png").querySelector(".sc-harness-label").textContent, COPILOT);
  assert.ok(h.card("mc-ok.png").querySelector(".sc-harness-label").classList.contains("sc-harness-label-microsoft-copilot"));
  assert.equal(h.card("mc-ok.png").querySelector(".sc-harness-picture").textContent, `Picture: ${COPILOT}`);
  assert.ok(!h.card("mc-ok.png").querySelector(".sc-harness-shared") && !h.card("std-ok-1.png").querySelector(".sc-harness-shared"), "only a shared topic carries the shared note");

  const wrong = h.card("mc-wrong.png");
  assert.equal(wrong.dataset.status, "pending", "a picture from the other harness is not used");
  assert.equal(wrong.querySelector(".sc-harness-label").textContent, COPILOT, "the card says what its part needs");
  assert.equal(wrong.querySelector(".sc-harness-picture").textContent, `Picture: ${STANDARD}`);
  assert.equal(wrong.querySelector(".sc-harness-note").textContent, `This picture is from the ${STANDARD}, but this slot needs the ${COPILOT}.`);
  assert.equal(wrong.querySelector(".sc-harness").dataset.scHarnessState, "wrong-harness");
  assert.ok(!wrong.querySelector(".sc-harness-tag"), "nothing to tag");
});

test("a shared topic says it works in either harness and in which harness its picture is taken", async () => {
  const h = await ready(combinedState(combinedShots()));
  const card = h.card("shared.png");
  assert.equal(card.querySelector(".sc-harness-label").textContent, STANDARD, "the chip is the harness the picture is taken in");
  const note = card.querySelector("[data-sc-harness-shared]");
  assert.equal(note.textContent, `Shared topic: works in either harness. This picture is taken in the ${STANDARD}.`);
  assert.equal(note.tagName, "P", "plain text, never color alone");
  assert.ok(card.querySelector(".sc-harness").children.indexOf(note) === 1, "right under the label");

  // The enlarged picture says the same, and so does a shared topic that comes after both parts.
  await h.click(h.action("preview", card));
  assert.equal(h.host.querySelector("dialog.sc-lightbox .sc-lb-info [data-sc-harness-shared]").textContent, note.textContent);
  const late = await ready(combinedState([partSlot("late.png", "standard", "pending", "shared-late"), partSlot("mc.png", "microsoft-copilot", "ok", "microsoft-copilot", { id: 2 })]));
  assert.match(late.card("late.png").querySelector("[data-sc-harness-shared]").textContent, /^Shared topic: works in either harness\. This picture is taken in the Standard \(Classic\) harness\.$/);

  // When the lab takes the Microsoft Copilot harness first, the shared topic is taken there.
  const reversed = await ready(combinedState([partSlot("shared.png", "microsoft-copilot", "pending", "shared")], { order: ["microsoft-copilot", "standard"] }));
  assert.equal(reversed.card("shared.png").querySelector(".sc-harness-label").textContent, COPILOT);
  assert.equal(reversed.card("shared.png").querySelector("[data-sc-harness-shared]").textContent, `Shared topic: works in either harness. This picture is taken in the ${COPILOT}.`);
});

test("in a lab built for both harnesses, pictures with no harness recorded are tagged against the harness of their own part", async () => {
  const state = combinedState([partSlot("std.png", "standard", "not-recorded", "standard", { caption: "Create an agent" }), partSlot("mc.png", "microsoft-copilot", "not-recorded", "microsoft-copilot", { id: 2, figure: "2.1", caption: "Build the agent" }), partSlot("shared.png", "standard", "not-recorded", "shared", { id: 3, figure: "3.1", caption: "Choose a harness" })]);
  const h = await ready(state);
  const group = h.center().querySelector('[data-sc-harness-unrecorded="lab"]');
  assert.match(group.querySelector(".sc-harness-help").textContent, /If it is not the harness its screenshot needs, it is moved to the kept pictures list/);
  assert.doesNotMatch(group.querySelector(".sc-harness-help").textContent, /If it is not the (Standard|Microsoft)/);
  const items = group.querySelectorAll("[data-sc-harness-item]");
  assert.deepEqual(items.map((li) => li.querySelectorAll(".sc-harness-pair .sc-harness-label").map((el) => el.textContent)), [[NOT_RECORDED, `Needs: ${STANDARD}`], [NOT_RECORDED, `Needs: ${COPILOT}`], [NOT_RECORDED, `Needs: ${STANDARD}`]]);
  assert.ok(items[1].querySelector(".sc-harness-label-microsoft-copilot"), "each picture is tagged as needing its own part's harness");
  assert.ok(!items[0].querySelector(".sc-harness-shared") && items[2].querySelector(".sc-harness-shared").textContent.startsWith("Shared topic: works in either harness."));
  assert.deepEqual(tagButtons(items[1]).map((b) => b.textContent), ["This is Standard (Classic)", "This is Microsoft Copilot"], "no Customer Conversation in a lab of the two harnesses");

  const after = combinedState([partSlot("std.png", "standard", "not-recorded", "standard", { caption: "Create an agent" }), partSlot("mc.png", "microsoft-copilot", "ok", "microsoft-copilot", { id: 2, figure: "2.1", caption: "Build the agent" }), partSlot("shared.png", "standard", "not-recorded", "shared", { id: 3, figure: "3.1", caption: "Choose a harness" })]);
  h.route("POST", /\/screenshots\/mc\.png\/harness$/, { status: 200, body: { outcome: "tagged", harness: "microsoft-copilot", harnessLabel: COPILOT, state: after } });
  await h.click(tagButtons(items[1])[1]);
  assert.deepEqual(h.callsTo("POST", /\/harness$/)[0].body, { harness: "microsoft-copilot" });
  assert.equal(h.live(), `Recorded as the ${COPILOT}.`);
  assert.equal(h.center().querySelector("[data-sc-harness-banner]").dataset.scHarnessBanner, "both", "the banner stays");
});

test("a picture that looks wrong in a lab built for both harnesses names the slot's harness and the picture's", async () => {
  const pictures = [flagged("mc-wrong.png", { label: "Add a skill", harness: "microsoft-copilot", harnessLabel: COPILOT, pictureHarness: "standard", pictureHarnessLabel: STANDARD, reason: `This picture was taken in the ${STANDARD}, but this screenshot needs the ${COPILOT}.`, flags: [{ code: "HARNESS_MISMATCH", level: "definite", message: `This picture was taken in the ${STANDARD}, but this screenshot needs the ${COPILOT}.` }] })];
  const h = makeHarness();
  h.route("GET", /\/api\/capture\/suspect-pictures/, suspectReply(pictures));
  await h.setStatus(statusPayload());
  await h.render(combinedState(combinedShots()));
  await h.flush();
  await h.click(h.action("wrong-review"));
  const row = h.host.querySelector("[data-sc-wrong-picture]");
  assert.equal(row.querySelector(".sc-harness-label").textContent, COPILOT);
  assert.equal(row.querySelector(".sc-harness-picture").textContent, `Picture: ${STANDARD}`);
  assert.equal(row.querySelector("[data-sc-harness-flag]").textContent, "Taken in the other harness");
});

test("the 'Screenshots left' list of a lab built for both harnesses groups its pictures under one heading per harness", () => {
  const h = makeHarness({ generated: true });
  const entry = (filename, harness, extra = {}) => ({ filename, figure: "1.1", caption: `Picture ${filename}`, shows: "A screen", why: "", steps: ["Open Copilot Studio"], harness, harnessLabel: harness ? LABELS[harness] : null, ...extra });
  const list = {
    labId: LAB,
    counts: { missing: 6, computer: 3, you: 3 },
    labHarness: { id: null, mode: "both", order: BOTH_ORDER, label: BOTH_LABEL, source: "chosen", statement: BOTH_STATEMENT },
    you: [entry("shared.png", "standard", { harnessScope: "shared" }), entry("std.png", "standard"), entry("mc.png", "microsoft-copilot")],
    computer: [entry("std-2.png", "standard"), entry("mc-2.png", "microsoft-copilot"), entry("site.png", null)],
  };
  const html = h.run("lbRenderChecklistHtml")(list);
  assert.ok(html.includes(`<p class="lb-checklist-harness-statement"><strong>${BOTH_STATEMENT}</strong></p>`), "the combined statement");
  const headings = [...html.matchAll(/<h5 class="lb-checklist-harness-group">([^<]*)<\/h5>/g)].map((m) => m[1]);
  assert.deepEqual(headings, [`${STANDARD} pictures`, `${COPILOT} pictures`, `${STANDARD} pictures`, `${COPILOT} pictures`], "one heading per harness in each of the two lists");
  const you = html.slice(html.indexOf("Only you can do these"), html.indexOf("Your computer will capture these"));
  const where = (name) => you.indexOf(`<code>${name}</code>`) >= 0 ? you.indexOf(`<code>${name}</code>`) : you.indexOf(`File: <code>${name}</code>`);
  assert.ok(you.indexOf("Standard (Classic) harness pictures") < where("std.png") && where("std.png") < you.indexOf("Microsoft Copilot harness pictures") && you.indexOf("Microsoft Copilot harness pictures") < where("mc.png"), "each picture sits under its own harness's heading");
  assert.ok(you.includes(`<p>Shared topic: works in either harness. This picture is taken in the ${STANDARD}.</p>`), "a shared topic says so");
  const computer = html.slice(html.indexOf("Your computer will capture these"));
  assert.ok(computer.indexOf("site.png") > computer.indexOf("Microsoft Copilot harness pictures"), "a picture with no harness comes last, under no heading");
  assert.equal([...computer.matchAll(/<h5 /g)].length, 2);

  // A lab with one harness has no headings.
  const single = h.run("lbRenderChecklistHtml")({ ...list, labHarness: { id: "standard", label: STANDARD, statement: STATEMENTS.standard } });
  assert.ok(!single.includes("lb-checklist-harness-group"));
  assert.equal([...single.matchAll(/<ul class="lb-checklist-list">/g)].length, 2, "one list for each of the two groups, as before");
});

// ── The library name carries the harness ────────────────────────────────────

test("the shared library keeps a harness slot's picture under a name that carries the harness, and a retake asks about that name", async () => {
  const h = makeHarness();
  const name = h.run("scLibraryName");
  assert.equal(name("agent-overview.png", "standard"), "agent-overview.classic.png");
  assert.equal(name("agent-overview.png", "microsoft-copilot"), "agent-overview.copilot.png");
  assert.equal(name("agent-overview.png", "customer-conversation"), "agent-overview.customer.png");
  assert.equal(name("agent-overview.classic.png", "standard"), "agent-overview.classic.png", "a name that has the tag is not tagged twice");
  assert.equal(name("agent-overview.classic.png", "microsoft-copilot"), "agent-overview.copilot.png", "and a tag of another harness is replaced");
  assert.equal(name("a.b.c.webp", "standard"), "a.b.c.classic.webp");
  assert.equal(name("agent-overview.png", null), "agent-overview.png", "a product with no harnesses keeps its plain name");
  assert.equal(name("agent-overview.png", "either"), "agent-overview.png");

  const state = labState([slot("agent-home.png", "standard", "ok", { imageSource: "library", share: { state: "shared", libraryConfirmed: false } }), shot({ filename: "site.png", product: "sharepoint-ai", captured: true, capturedAt: "2026-06-01T11:00:00.000Z", id: 2, imageSource: "library", share: { state: "shared", libraryConfirmed: false } })]);
  await h.setStatus(statusPayload());
  await h.render(state);
  h.route("GET", /\/usage\?labId=/, { status: 200, body: { hasPicture: true, otherLabs: 2, confirmed: false } });
  await h.click(h.card("agent-home.png").querySelector('[data-sc-action="shot-retake"]'));
  assert.equal(h.callsTo("GET", /\/usage\?labId=/)[0].url, `/api/capture/library/screenshots/agent-home.classic.png/usage?labId=${LAB}`);
  assert.match(h.host.querySelector("[data-sc-ask=retake] .sc-ask-text").textContent, /2 other labs use it/);
  await h.click(h.host.querySelector('[data-sc-ask=retake] [data-sc-action="ask-cancel"]'));
  await h.click(h.card("site.png").querySelector('[data-sc-action="shot-retake"]'));
  assert.equal(h.callsTo("GET", /\/usage\?labId=/)[1].url, `/api/capture/library/screenshots/site.png/usage?labId=${LAB}`, "a product with no harnesses is asked about by its plain name");
});

// ── The CSS ─────────────────────────────────────────────────────────────────

const STYLE = INDEX_HTML.match(/<style>([\s\S]*?)<\/style>/)[1];
const HEADER = "Harness identification labels (screenshot center and lab preview)";
const BLOCK = (() => {
  const start = STYLE.indexOf(`/* \u2500\u2500 ${HEADER}`);
  const end = STYLE.indexOf("/* \u2500\u2500 end of the harness identification labels");
  return start < 0 || end < start ? "" : STYLE.slice(start, end);
})();
const ruleOf = (selector) => new RegExp(`(?:^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`).exec(BLOCK)?.[1] || "";

test("all the harness CSS is one clearly named block next to the other Screenshot Center rules, with its own wrapping label rules", () => {
  assert.ok(BLOCK.length > 500, "the block exists under its header");
  assert.equal(STYLE.split(HEADER).length, 2, "there is exactly one such block");
  const screenCss = STYLE.split("@media print")[0];
  assert.ok(screenCss.includes(HEADER), "it is screen CSS, before the print block");
  assert.ok(STYLE.indexOf(HEADER) > STYLE.indexOf(".sc-cause-files[hidden]") && STYLE.indexOf(HEADER) < STYLE.indexOf(".sc-lightbox {"), "next to the other .sc-* rules");
  assert.equal(STYLE.split("@media print").length, 2, "there is still exactly one print block");
  assert.doesNotMatch(BLOCK, /@media print/, "and the block adds no print rule of its own");
  assert.doesNotMatch(BLOCK, /#[0-9a-f]{3,8}\b(?!-)|(?<![\w-])(?:white|black)(?![\w-])/i, "no hard-coded colors: theme tokens only");
  assert.doesNotMatch(BLOCK, /text-overflow\s*:\s*ellipsis/, "nothing is cut off with an ellipsis");

  const label = ruleOf(".sc-harness-label");
  assert.match(label, /max-width:\s*100%/);
  assert.match(label, /white-space:\s*normal/);
  assert.match(label, /overflow-wrap:\s*anywhere/);
  assert.match(label, /display:\s*inline-block/);
  assert.match(label, /border:\s*2px solid/, "a visible border");
  assert.doesNotMatch(label, /white-space:\s*nowrap|overflow:\s*hidden/);
  // The words carry the meaning; the border style only helps a quick scan.
  assert.match(ruleOf(".sc-harness-label-standard"), /border-style:\s*solid/);
  assert.match(ruleOf(".sc-harness-label-microsoft-copilot"), /border-style:\s*dashed/);
  assert.match(ruleOf(".sc-harness-label-customer-conversation"), /border-style:\s*dotted/);
  // The rules for a lab built for both harnesses are in the same block.
  for (const selector of [".sc-harness-shared", ".sc-harness-parts", ".sc-harness-part", ".lb-checklist-harness-group"]) assert.ok(ruleOf(selector), `${selector} is in the harness block`);
  // The lab preview's "Screenshot to add" card wraps its harness line too.
  const line = ruleOf(".lab-shot-card .lab-shot-card-harness");
  assert.match(line, /white-space:\s*normal/);
  assert.match(line, /overflow-wrap:\s*anywhere/);
});

test("the harness label tones meet WCAG AA in the dark and light themes", () => {
  const tokens = (block) => Object.fromEntries([...block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)].map((m) => [m[1], m[2].trim()]));
  const themes = [
    ["dark", tokens(STYLE.match(/:root\s*\{([^}]*)\}/)[1])],
    ["light", tokens(STYLE.match(/:root\[data-theme="light"\],\s*body\[data-theme="light"\]\s*\{([^}]*)\}/)[1])],
  ];
  const luminance = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => {
    const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const token = (rule, property) => new RegExp(`(?:^|[\\s;])${property}:\\s*var\\((--[a-z0-9-]+)\\)`).exec(rule)?.[1] || null;
  const base = ruleOf(".sc-harness-label");
  for (const [selector, fallback] of [[".sc-harness-label", null], [".sc-harness-label-standard", base], [".sc-harness-label-not-recorded", base], [".sc-harness-note", base], [".sc-harness-flag", base], [".sc-harness-mixed, .sc-harness-wrong", base]]) {
    const rule = ruleOf(selector);
    const fg = token(rule, "color") || token(fallback || "", "color");
    const bg = token(rule, "background") || token(fallback || "", "background");
    assert.ok(fg && bg, `${selector} uses theme tokens for its text and background`);
    for (const [name, t] of themes) assert.ok(contrast(t[fg], t[bg]) >= 4.5, `${name}: ${selector} text is ${contrast(t[fg], t[bg]).toFixed(2)}:1`);
  }
});
