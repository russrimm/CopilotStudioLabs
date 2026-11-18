/**
 * Readiness hub tests: the Setup checklist in Configuration and the first-run banner in Build.
 * The real browser scripts run inside node:vm against the small fake DOM (no jsdom), with a fake
 * fetch and fake timers, so nothing touches a network or a browser.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

import { createFakeDom } from "./fixtures/fake-dom.js";

const publicFile = (name) => readFileSync(new URL(`../public/${name}`, import.meta.url), "utf8");
const SOURCES = ["brand-ui.js", "screenshot-center-core.js", "screenshot-center-command.js", "screenshot-center-jobs.js", "screenshot-center.js", "readiness-hub.js"].map(publicFile);
const HUB_SOURCE = publicFile("readiness-hub.js");
const INDEX_HTML = publicFile("index.html");
const json = (value) => JSON.parse(JSON.stringify(value));

// ── Fixtures ────────────────────────────────────────────────────────────────

const profile = (overrides = {}) => ({
  id: "default",
  name: "Default",
  companyName: "Microsoft AI Training Generator",
  tagline: "Provisioning Portal",
  primaryColor: "#4f8ff7",
  logo: null,
  moreInfoLabel: "",
  moreInfoUrl: "",
  supportName: "",
  supportEmail: "",
  copilotStudioUrl: "",
  powerPlatformEnvUrl: "",
  sharepointSiteUrl: "",
  sharepointAdminUrl: "",
  m365AdminUrl: "",
  foundryProjectUrl: "",
  ...overrides,
});

const BRANDED = {
  id: "contoso",
  name: "Contoso",
  companyName: "Contoso Energy",
  primaryColor: "#0f6cbd",
  logo: "/uploads/contoso.png",
};
const LINKS = { moreInfoUrl: "https://learn.contoso.com/ai", moreInfoLabel: "Contoso AI hub", supportName: "AI enablement team", supportEmail: "ai-help@contoso.com" };
const ADDRESSES = {
  copilotStudioUrl: "https://copilotstudio.microsoft.com/environments/abc",
  powerPlatformEnvUrl: "https://make.powerapps.com/environments/abc",
  sharepointSiteUrl: "https://contoso.sharepoint.com/sites/Labs",
  sharepointAdminUrl: "https://contoso-admin.sharepoint.com",
  m365AdminUrl: "https://admin.microsoft.com",
  foundryProjectUrl: "https://ai.azure.com/project",
};

const device = (overrides = {}) => ({ id: "dev_0123456789ab", name: "Ada PC", platform: "win32", connected: true, busy: false, lastSeenAt: "2026-06-01T11:59:55.000Z", signedInProducts: [], ...overrides });

function statusPayload({ devices = [], signedIn = [], tenantSet = false, persistent = true, review = 0, captured = 12, total = 325 } = {}) {
  const connected = devices.filter((d) => d.connected);
  return {
    companion: { connected: connected.length > 0, connectedCount: connected.length, deviceCount: devices.length, signedInProducts: signedIn, devices, downloadUrl: "/api/capture/companion.zip", onlineWindowSec: 90 },
    tenantUrls: { set: tenantSet, names: tenantSet ? ["CAPTURE_SHAREPOINT_SITE_URL"] : [] },
    sharedLibrary: { location: persistent ? "persistent" : "baked", persistent, storage: { persistent, backend: persistent ? "azure-blob" : "local-disk", writable: true, blobSyncEnabled: persistent }, total, captured, missing: total - captured, needsReview: review },
    pairing: { codeTtlSec: 600 },
    limits: { maxUploadBytes: 8 * 1024 * 1024, acceptedTypes: ["image/png", "image/jpeg", "image/webp"] },
  };
}

const STORAGE_OK = { persistent: true, backend: "azure-blob", writable: true, blobSync: { enabled: true, healthy: true } };
const STORAGE_LOCAL = { persistent: false, backend: "local-disk", writable: true, blobSync: { enabled: false, healthy: true } };
const drift = (counts = {}, lastBulkScanAt = null) => ({ counts: { total: 0, upToDate: 0, docsUpdated: 0, missingScreenshots: 0, notChecked: 0, ungrounded: 0, ...counts }, lastBulkScanAt });

/** A complete input for rhBuildRows, with sensible "everything is fine" defaults. */
function input(overrides = {}) {
  return {
    profiles: { loaded: true, error: "", activeProfileId: "contoso", profiles: [profile(), profile({ ...BRANDED, ...LINKS, ...ADDRESSES })] },
    status: statusPayload({ devices: [device()], signedIn: ["copilot-studio"] }),
    statusError: "",
    storage: STORAGE_OK,
    storageError: "",
    drift: drift({ total: 3, upToDate: 3 }, "2026-05-20T10:00:00.000Z"),
    driftError: "",
    local: false,
    busy: "",
    ...overrides,
  };
}

// ── Harness ─────────────────────────────────────────────────────────────────

function makeHarness({ profiles = [profile()], activeProfileId = "default", status = statusPayload(), health = { status: "ok", storage: STORAGE_LOCAL }, driftData = drift(), labs = [], hostname = "localhost", hubTab = false } = {}) {
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

  const buildPanel = add(body, "div", { id: "panel-labbuilder" });
  const banner = add(buildPanel, "section", { id: "rh-banner", attrs: { hidden: "" } });
  add(banner, "p", { id: "rh-banner-text" });
  const bannerOpen = add(banner, "button", { id: "rh-banner-open", text: "Open the setup checklist" });
  const bannerDismiss = add(banner, "button", { id: "rh-banner-dismiss", text: "Dismiss" });
  add(buildPanel, "h3", { id: "lb-build-heading", attrs: { tabindex: "-1" } });
  add(buildPanel, "h3", { id: "lb-heading-1", attrs: { tabindex: "-1" } });
  const generate = add(buildPanel, "button", { id: "lb-generate-btn", text: "Generate Lab" });
  const details = add(buildPanel, "details", { id: "lb-generated-details" });
  const filter = add(buildPanel, "select", { id: "lb-gen-drift-filter" });
  add(buildPanel, "h3", { id: "lb-generated-heading", attrs: { tabindex: "-1" } });

  const configPanel = add(body, "div", { id: "panel-config", attrs: { class: hubTab ? "tab-panel active" : "tab-panel" } });
  const card = add(configPanel, "section", { id: "readiness-hub" });
  add(card, "h3", { id: "rh-heading", attrs: { tabindex: "-1" } });
  const refresh = add(card, "button", { id: "rh-refresh", text: "Check again" });
  const rhBody = add(card, "div", { id: "rh-body" });
  const status_ = add(rhBody, "p", { id: "rh-status", attrs: { role: "status", "aria-live": "polite" } });
  add(status_, "strong", { id: "rh-count" });
  add(status_, "span", { id: "rh-message" });
  const progress = add(rhBody, "div", { id: "rh-progress", attrs: { role: "progressbar" } });
  const fill = add(progress, "div", { id: "rh-progress-fill" });
  const list = add(rhBody, "ol", { id: "rh-list" });
  for (const id of ["bp-name", "bp-companyName", "branding-logo-file", "bp-primaryColor-hex", "bp-moreInfoUrl", "bp-supportName", "bp-copilotStudioUrl", "bp-powerPlatformEnvUrl", "bp-sharepointSiteUrl", "bp-sharepointAdminUrl", "bp-m365AdminUrl", "bp-foundryProjectUrl", "bp-editor-heading"]) {
    add(configPanel, "input", { id });
  }
  const live = add(body, "div", { id: "app-live", attrs: { class: "sr-only", role: "status", "aria-live": "polite" } });
  add(body, "div", { id: "lb-result-screenshots" });

  const timers = new Map();
  let seq = 1;
  const storage = new Map();
  const h = {
    document,
    banner,
    bannerOpen,
    bannerDismiss,
    generate,
    filter,
    details,
    list,
    refresh,
    fill,
    progress,
    live,
    card,
    configPanel,
    FakeEvent,
    calls: [],
    tabs: [],
    spies: { newProfile: 0, selected: [], scans: 0, loadGenerated: 0, openShots: [], toasts: [] },
    profiles,
    activeProfileId,
    status,
    statusFails: false,
    health,
    healthFails: false,
    driftData,
    driftFails: false,
    labs,
    copied: [],
    storage,
  };
  const reply = (status, bodyJson) => ({ ok: status >= 200 && status < 300, status, json: async () => bodyJson });
  const fetchImpl = async (url, init = {}) => {
    const method = String(init.method || "GET").toUpperCase();
    h.calls.push({ method, url: String(url) });
    if (method === "GET" && url === "/healthz") return h.healthFails ? reply(503, {}) : reply(200, h.health);
    if (method === "GET" && url === "/api/capture/status") return h.statusFails ? reply(500, { error: "Status is down." }) : reply(200, h.status);
    if (method === "GET" && url === "/api/lab-builder/learn-drift") return h.driftFails ? reply(500, { error: "Drift is down." }) : reply(200, h.driftData);
    if (method === "GET" && url === "/api/branding/profiles") return reply(200, { activeProfileId: h.activeProfileId, profiles: h.profiles, fonts: [] });
    if (method === "POST" && url === "/api/capture/pair") return reply(201, { code: "ABCD-1234", expiresAt: new Date(Date.now() + 600000).toISOString(), portalUrl: "http://localhost:3012", command: "start-companion --portal=http://localhost:3012 --code=ABCD-1234" });
    return reply(404, { error: `No route for ${method} ${url}` });
  };

  const brandProfiles = { loaded: false, loading: null, activeProfileId: null, profiles: [], fonts: [], selectedId: null, isNew: false };
  const context = {
    document,
    window: { addEventListener: (type, fn) => ((h.windowListeners ||= {})[type] ||= []).push(fn) },
    location: { hostname },
    fetch: fetchImpl,
    Event: FakeEvent,
    URL,
    setTimeout: (fn, ms) => {
      const id = seq++;
      timers.set(id, { fn, ms });
      return { id, unref() {} };
    },
    clearTimeout: (handle) => handle && timers.delete(handle.id),
    setInterval: (fn, ms) => {
      const id = seq++;
      timers.set(id, { fn, ms, every: true });
      return { id, unref() {} };
    },
    clearInterval: (handle) => handle && timers.delete(handle.id),
    navigator: { clipboard: { writeText: async (text) => h.copied.push(text) } },
    localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)) },
    console,
    CSS: { escape: (s) => String(s) },
    toast: (message, kind) => h.spies.toasts.push([message, kind]),
    labBuilder: { products: [{ id: "copilot-studio", shortName: "Copilot Studio" }, { id: "sharepoint-ai", shortName: "SharePoint AI" }] },
    brandProfiles,
    bpEnsureLoaded: async (force) => {
      h.calls.push({ method: "BP", url: force ? "force" : "load" });
      if (brandProfiles.loaded && !force) return brandProfiles;
      const res = await fetchImpl("/api/branding/profiles");
      const data = await res.json();
      brandProfiles.activeProfileId = data.activeProfileId;
      brandProfiles.profiles = data.profiles;
      brandProfiles.selectedId = brandProfiles.selectedId || data.activeProfileId;
      brandProfiles.loaded = true;
      return brandProfiles;
    },
    bpNewProfile: () => {
      h.spies.newProfile += 1;
      brandProfiles.isNew = true;
      document.getElementById("bp-name").focus();
    },
    bpSelectProfile: (id) => {
      h.spies.selected.push(id);
      brandProfiles.isNew = false;
      brandProfiles.selectedId = id;
    },
    setActiveTab: (tab) => {
      h.tabs.push(tab);
      configPanel.classList.toggle("active", tab === "config");
    },
    lbGen: { labs, loaded: true },
    lbLoadGenerated: async () => {
      h.spies.loadGenerated += 1;
    },
    lbScanFleetLearnDrift: async () => {
      h.spies.scans += 1;
      h.driftData = drift({ total: 3, upToDate: 3 }, "2026-06-01T11:00:00.000Z");
    },
    lbOpenGeneratedScreenshots: async (labId) => {
      h.spies.openShots.push(labId);
      add(document.getElementById("lb-result-screenshots"), "h4", { id: "lb-screenshots-heading", attrs: { tabindex: "-1" } });
    },
  };
  vm.createContext(context);
  for (const source of SOURCES) vm.runInContext(source, context);
  h.run = (code) => vm.runInContext(code, context);
  h.brandProfiles = brandProfiles;
  h.flush = async (rounds = 8) => {
    for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  h.start = async () => {
    h.run("rhInit")();
    await h.flush();
    return h;
  };
  h.rows = () => json(h.run("rhBuildRows")(h.run("rhInput")()));
  h.row = (id) => h.list.querySelector(`#rh-row-${id}`);
  h.rowState = (id) => h.row(id)?.dataset.state;
  h.detail = (id) => h.row(id)?.querySelector(".rh-row-detail")?.textContent ?? null;
  h.button = (id, action) => h.row(id)?.querySelector(`[data-rh-action="${action}"]`) ?? null;
  h.click = async (el) => {
    assert.ok(el, "element to click must exist");
    el.click();
    await h.flush();
  };
  h.focused = () => document.activeElement?.id || document.activeElement?.dataset?.rhAction || "";
  return h;
}

const rowOf = (rows, id) => json(rows).find((row) => row.id === id);
const build = (overrides) => {
  const h = makeHarness();
  return (extra) => json(h.run("rhBuildRows")(input({ ...overrides, ...extra })));
};

// ── The eight rows, each in each state ──────────────────────────────────────

test("there are exactly eight rows and only brand, links, and the screenshot computer are recommended", () => {
  const rows = build()();
  assert.deepEqual(rows.map((r) => r.id), ["brand", "links", "tenant", "computer", "signin", "library", "storage", "learn"]);
  assert.deepEqual(rows.filter((r) => r.kind === "recommended").map((r) => r.id), ["brand", "links", "computer"]);
  assert.deepEqual(rows.filter((r) => r.essential).map((r) => r.id), ["brand", "links", "computer"]);
  for (const row of rows.filter((r) => r.kind === "optional")) assert.equal(row.essential, false, `${row.id} is optional`);
});

test("Brand profile: loading, error, standard look, branding on another profile, partial, and done", () => {
  const rows = build();
  const brand = (profiles) => rowOf(rows({ profiles }), "brand");
  const store = (activeProfileId, list, extra = {}) => ({ loaded: true, error: "", activeProfileId, profiles: list, ...extra });

  assert.equal(brand({ loaded: false, error: "", profiles: [] }).state, "loading");
  const failed = brand({ loaded: false, error: "boom", profiles: [] });
  assert.equal(failed.state, "error");
  assert.deepEqual(failed.actions.map((a) => a.id), ["refresh"]);

  const standard = brand(store("default", [profile()]));
  assert.equal(standard.state, "todo");
  assert.match(standard.detail, /standard look/);
  assert.deepEqual(standard.actions.map((a) => [a.id, a.label]), [["brand-create", "Create a brand profile"]]);

  const elsewhere = brand(store("default", [profile(), profile(BRANDED)]));
  assert.equal(elsewhere.state, "todo");
  assert.match(elsewhere.detail, /Contoso profile has your branding, but it is not the active profile/);
  assert.equal(elsewhere.actions[0].id, "brand-edit");

  const partial = brand(store("contoso", [profile({ ...BRANDED, logo: null })]));
  assert.equal(partial.state, "partial");
  assert.match(partial.detail, /Still to add to the Contoso profile: logo\./);
  assert.equal(partial.actions[0].data.field, "logo");
  assert.equal(brand(store("contoso", [profile({ ...BRANDED, companyName: "Microsoft AI Training Generator" })])).actions[0].data.field, "companyName");
  assert.equal(brand(store("contoso", [profile({ ...BRANDED, primaryColor: "#4f8ff7" })])).actions[0].data.field, "primaryColor");

  const done = brand(store("contoso", [profile(BRANDED)]));
  assert.equal(done.state, "done");
  assert.match(done.detail, /Contoso profile is active/);
  assert.deepEqual(done.actions.map((a) => a.id), ["brand-edit"]);
});

test("Learner links: none, only one half, and both", () => {
  const rows = build();
  const links = (fields) => rowOf(rows({ profiles: { loaded: true, error: "", activeProfileId: "p", profiles: [profile({ id: "p", ...fields })] } }), "links");
  assert.equal(links({}).state, "todo");
  assert.equal(links({ moreInfoUrl: "https://learn.contoso.com/ai" }).state, "partial");
  assert.match(links({ moreInfoUrl: "https://learn.contoso.com/ai" }).detail, /support contact/);
  assert.equal(links({ supportEmail: "help@contoso.com" }).state, "partial");
  assert.match(links({ supportName: "AI team" }).detail, /more information link/);
  const done = links({ moreInfoUrl: "https://learn.contoso.com/ai", moreInfoLabel: "Contoso AI hub", supportName: "AI team" });
  assert.equal(done.state, "done");
  assert.match(done.detail, /"Contoso AI hub" link and can reach AI team/);
  assert.equal(links({ moreInfoUrl: "https://learn.contoso.com/ai", supportEmail: "help@contoso.com" }).state, "done");
});

test("Tenant addresses: none, some, all six, and defaults set by the administrator", () => {
  const rows = build();
  const tenant = (fields, status) => rowOf(rows({ profiles: { loaded: true, error: "", activeProfileId: "p", profiles: [profile({ id: "p", ...fields })] }, ...(status ? { status } : {}) }), "tenant");
  const none = tenant({});
  assert.equal(none.state, "todo");
  assert.equal(none.kind, "optional");
  assert.match(none.detail, /Only needed for screenshots of your own tenant/);
  assert.equal(none.actions[0].data.field, "copilotStudioUrl");
  const some = tenant({ copilotStudioUrl: ADDRESSES.copilotStudioUrl, powerPlatformEnvUrl: ADDRESSES.powerPlatformEnvUrl, sharepointSiteUrl: ADDRESSES.sharepointSiteUrl });
  assert.equal(some.state, "partial");
  assert.match(some.detail, /3 of 6 addresses are set: Copilot Studio, Power Platform and SharePoint site/);
  assert.equal(some.actions[0].data.field, "sharepointAdminUrl", "the button opens the first missing address");
  const all = tenant(ADDRESSES);
  assert.equal(all.state, "done");
  assert.match(all.detail, /All 6 addresses are set/);
  const server = tenant({}, statusPayload({ tenantSet: true }));
  assert.equal(server.state, "done");
  assert.match(server.detail, /administrator already set default tenant addresses/);
  assert.equal(tenant({ copilotStudioUrl: "javascript:alert(1)" }).state, "todo", "an unsafe address does not count as set");
});

test("Screenshot computer: loading, error, none, paired but offline, and connected", () => {
  const rows = build();
  const computer = (extra) => rowOf(rows(extra), "computer");
  assert.equal(computer({ status: null, statusError: "" }).state, "loading");
  const failed = computer({ status: null, statusError: "Status is down." });
  assert.equal(failed.state, "error");
  assert.deepEqual(failed.actions.map((a) => a.id), ["refresh"]);
  const none = computer({ status: statusPayload() });
  assert.equal(none.state, "todo");
  assert.equal(none.pairing, true);
  assert.deepEqual(none.actions.map((a) => [a.id, a.label]), [["computer-connect", "Connect your computer"]]);
  const offline = computer({ status: statusPayload({ devices: [device({ connected: false })] }) });
  assert.equal(offline.state, "attention");
  assert.match(offline.detail, /Ada PC is paired but not running right now/);
  const connected = computer({ status: statusPayload({ devices: [device(), device({ id: "dev_0123456789ac", name: "Grace PC" })] }) });
  assert.equal(connected.state, "done");
  assert.match(connected.detail, /Connected: Ada PC and Grace PC/);
  assert.equal(connected.actions[0].label, "Connect another computer");
  const twice = computer({ status: statusPayload({ devices: [device(), device({ id: "dev_0123456789ac" })] }) });
  assert.match(twice.detail, /^Connected: Ada PC \(2 connections\)\. /, "two sessions of one computer are not listed as two computers");
  const sameOffline = computer({ status: statusPayload({ devices: [device({ connected: false }), device({ id: "dev_0123456789ac", connected: false })] }) });
  assert.match(sameOffline.detail, /^Ada PC is paired but not running right now/);
});

test("Signed in to products: waits for a computer, then shows who is signed in", () => {
  const rows = build();
  const signin = (extra) => rowOf(rows(extra), "signin");
  const locked = signin({ status: statusPayload() });
  assert.equal(locked.state, "locked");
  assert.deepEqual(locked.actions, []);
  const todo = signin({ status: statusPayload({ devices: [device()], signedIn: [] }) });
  assert.equal(todo.state, "todo");
  assert.match(todo.detail, /Sign in there once and it is remembered/);
  assert.equal(todo.actions[0].id, "screenshots-open");
  const done = signin({ status: statusPayload({ devices: [device()], signedIn: ["copilot-studio", "sharepoint-ai"] }) });
  assert.equal(done.state, "done");
  assert.match(done.detail, /Signed in to Copilot Studio and SharePoint AI/);
  assert.equal(signin({ status: null, statusError: "x" }).state, "error");
  assert.equal(signin({ status: null, statusError: "" }).state, "loading");
});

test("Screenshot library: needs review, not saved permanently, empty, and healthy", () => {
  const rows = build();
  const library = (status, extra = {}) => rowOf(rows({ status, ...extra }), "library");
  const review = library(statusPayload({ review: 2 }));
  assert.equal(review.state, "attention");
  assert.match(review.detail, /2 screenshots are waiting for your review/);
  const hosted = library(statusPayload({ persistent: false }));
  assert.equal(hosted.state, "attention");
  assert.match(hosted.detail, /stored only on this server and can be lost when the portal restarts/);
  const local = library(statusPayload({ persistent: false }), { local: true });
  assert.equal(local.state, "done", "on your own computer the library is on disk, which is fine");
  assert.match(local.detail, /stored on this computer/);
  const empty = library(statusPayload({ captured: 0 }));
  assert.equal(empty.state, "todo");
  assert.match(empty.detail, /Screenshot pending/);
  const done = library(statusPayload({ captured: 12, total: 325 }));
  assert.equal(done.state, "done");
  assert.match(done.detail, /12 of 325 shared screenshots are captured and 313 are missing\. They are saved permanently\./);
  assert.equal(library(null, { statusError: "x" }).state, "error");
});

test("Storage says whether your labs are saved permanently", () => {
  const rows = build();
  const storage = (value, extra = {}) => rowOf(rows({ storage: value, ...extra }), "storage");
  const done = storage(STORAGE_OK);
  assert.equal(done.state, "done");
  assert.match(done.detail, /^Your labs are saved permanently \(Azure Blob Storage\)/);
  assert.deepEqual(done.actions, []);
  assert.equal(done.help, "");

  const unwritable = storage({ ...STORAGE_OK, writable: false });
  assert.equal(unwritable.state, "attention");
  assert.match(unwritable.detail, /the portal cannot write to it/);
  const blob = storage({ ...STORAGE_OK, blobSync: { enabled: true, healthy: false } });
  assert.equal(blob.state, "attention");
  assert.match(blob.detail, /saving to Azure Blob Storage is failing/);

  const local = storage(STORAGE_LOCAL, { local: true });
  assert.equal(local.state, "todo");
  assert.equal(local.detail, "Labs are stored only on this computer. They stay here until you delete them.");
  assert.match(local.help, /Back those folders up/);
  const hosted = storage(STORAGE_LOCAL);
  assert.equal(hosted.state, "attention");
  assert.match(hosted.detail, /^Labs are stored only on this server\. They can be lost when the portal restarts/);
  assert.match(hosted.help, /Ask your portal administrator/);
  assert.deepEqual(hosted.actions.map((a) => a.id), ["storage-help"]);

  assert.equal(storage(null, { storageError: "x" }).state, "error");
  assert.equal(storage(null, { storageError: "" }).state, "loading");
});

test("Microsoft Learn freshness: no labs, never scanned, some unchecked, changed, and current", () => {
  const rows = build();
  const learn = (value, extra = {}) => rowOf(rows({ drift: value, ...extra }), "learn");
  const none = learn(drift());
  assert.equal(none.state, "locked");
  assert.deepEqual(none.actions.map((a) => a.id), ["build-open"]);
  const never = learn(drift({ total: 4, notChecked: 4 }));
  assert.equal(never.state, "todo");
  assert.match(never.detail, /None of your 4 labs have been checked against Microsoft Learn yet/);
  assert.equal(learn(drift({ total: 1, notChecked: 1 })).detail, "Your lab has not been checked against Microsoft Learn yet.");
  assert.deepEqual(never.actions.map((a) => [a.id, a.label]), [["learn-scan", "Check all labs now"]]);
  const some = learn(drift({ total: 4, upToDate: 3, notChecked: 1 }));
  assert.equal(some.state, "todo");
  assert.match(some.detail, /1 of your 4 labs has not been checked/);
  const changed = learn(drift({ total: 4, upToDate: 2, docsUpdated: 2 }));
  assert.equal(changed.state, "attention");
  assert.match(changed.detail, /2 labs need updates because Microsoft Learn changed/);
  assert.deepEqual(changed.actions.map((a) => a.id), ["learn-scan", "learn-show"]);
  assert.equal(learn(drift({ total: 1, docsUpdated: 1 })).detail, "1 lab needs updates because Microsoft Learn changed.");
  const done = learn(drift({ total: 3, upToDate: 3 }, "2026-05-20T10:00:00.000Z"));
  assert.equal(done.state, "done");
  assert.match(done.detail, /^All 3 labs match Microsoft Learn\. Last checked /);
  assert.equal(learn(drift({ total: 3, upToDate: 1, ungrounded: 1, missingScreenshots: 1 })).state, "done", "labs with no Learn sources or pending screenshots are not stale");
  const busy = learn(drift({ total: 4, notChecked: 4 }), { busy: "learn" });
  assert.equal(busy.actions[0].busy, true);
  assert.equal(busy.actions[0].label, "Checking your labs");
  assert.equal(learn(null, { driftError: "x" }).state, "error");
});

test("only the first open row keeps a primary button", () => {
  const rows = build()({
    profiles: { loaded: true, error: "", activeProfileId: "default", profiles: [profile()] },
    status: statusPayload(),
    drift: drift({ total: 2, notChecked: 2 }),
  });
  const primaries = rows.filter((row) => row.actions.some((a) => a.primary)).map((row) => row.id);
  assert.deepEqual(primaries, ["brand"]);
});

// ── The overall count, progress, and live region ────────────────────────────

test("the summary counts ready rows and always says labs can be built at any time", () => {
  const h = makeHarness();
  const summarize = (inputOverrides) => json(h.run("rhSummarize")(h.run("rhBuildRows")(input(inputOverrides))));
  const all = summarize({});
  assert.equal(all.text, "8 of 8 ready");
  assert.equal(all.message, "Everything is ready.");
  assert.equal(all.tone, "ok");

  const fresh = summarize({
    profiles: { loaded: true, error: "", activeProfileId: "default", profiles: [profile()] },
    status: statusPayload({ captured: 0 }),
    storage: STORAGE_LOCAL,
    local: true,
    drift: drift(),
  });
  assert.equal(fresh.text, "0 of 8 ready");
  assert.equal(fresh.recommendedLeft, 3);
  assert.match(fresh.message, /^3 recommended steps left\. You can build labs at any time\./);

  const optionalOnly = summarize({ drift: drift({ total: 2, notChecked: 2 }), storage: STORAGE_LOCAL, local: true });
  assert.equal(optionalOnly.recommendedLeft, 0);
  assert.match(optionalOnly.message, /^The recommended setup is done\. The rest is optional and can wait\./);

  const attention = summarize({ drift: drift({ total: 2, docsUpdated: 1 }) });
  assert.match(attention.message, /1 item needs attention\.$/);

  const loading = summarize({ status: null, statusError: "" });
  assert.equal(loading.message, "Checking your setup.");
  assert.equal(loading.tone, "info");
});

test("the checklist renders its count in a polite live region and moves the progress bar", async () => {
  const h = makeHarness({ health: { status: "ok", storage: STORAGE_LOCAL }, status: statusPayload({ devices: [device()], signedIn: ["copilot-studio"] }) });
  await h.start();
  await h.run("rhRefresh")({ scope: "all", force: true });
  await h.flush();
  assert.match(INDEX_HTML, /<p class="rh-summary" id="rh-status" role="status" aria-live="polite" aria-atomic="true">/);
  assert.equal(h.document.getElementById("rh-count").textContent, h.run("rhSummarize")(h.run("rhBuildRows")(h.run("rhInput")())).text);
  const ready = h.list.querySelectorAll('.rh-row[data-state="done"]').length;
  assert.equal(h.progress.getAttribute("aria-valuenow"), String(ready));
  assert.equal(h.progress.getAttribute("aria-valuemax"), "8");
  assert.equal(h.progress.getAttribute("aria-valuetext"), `${ready} of 8 ready`);
  assert.equal(h.fill.style.width, `${Math.round((ready / 8) * 100)}%`);
  assert.equal(h.list.children.length, 8);
  for (const li of h.list.children) assert.ok(li.querySelector(".sc-chip"), "every row shows its status in words, not only color");
});

test("re-rendering with the same data leaves the live region and the rows untouched", async () => {
  const h = await makeHarness({ status: statusPayload({ devices: [device()] }) }).start();
  await h.run("rhRefresh")({ scope: "all", force: true });
  await h.flush();
  const rowsBefore = [...h.list.children];
  const message = h.document.getElementById("rh-message");
  const textNode = message.childNodes[0];
  h.run("rhRender")();
  assert.deepEqual([...h.list.children], rowsBefore, "unchanged rows keep the same DOM nodes");
  assert.equal(message.childNodes[0], textNode, "the announced text is not rewritten when it has not changed");
});

test("an explicit Check again announces the result through the page-level live region", async () => {
  const h = await makeHarness().start();
  await h.click(h.refresh);
  assert.match(h.live.textContent, /^\d of 8 ready\. /);
  const calls = h.calls.filter((c) => c.method === "GET").map((c) => c.url);
  assert.ok(calls.includes("/healthz") && calls.includes("/api/lab-builder/learn-drift") && calls.includes("/api/capture/status"));
});

// ── The first-run banner ────────────────────────────────────────────────────

test("the banner shows what is left, never blocks the wizard, and goes away when dismissed", async () => {
  const h = await makeHarness().start();
  assert.equal(h.banner.hidden, false);
  const text = h.document.getElementById("rh-banner-text").textContent;
  assert.match(text, /^0 of 3 done\. Still to do: brand profile, learner links and screenshot computer\./);
  assert.match(text, /You can build a lab right now and finish setting up later\./);
  assert.equal(h.generate.disabled, false);
  assert.equal(h.generate.hasAttribute("aria-disabled"), false);

  await h.click(h.bannerDismiss);
  assert.equal(h.banner.hidden, true);
  assert.equal(h.storage.get("rh-banner-dismissed"), "1", "dismissal is remembered in localStorage");
  assert.equal(h.focused(), "lb-build-heading", "focus moves to the Build heading, not nowhere");
  assert.match(h.live.textContent, /Setup banner dismissed\. You can find the Setup checklist in Configuration at any time\./);

  await h.run("rhRefresh")({ scope: "banner", force: true });
  assert.equal(h.banner.hidden, true, "it stays dismissed after more data arrives");
});

test("a dismissal from an earlier visit keeps the banner hidden on the next page load", async () => {
  const h = makeHarness();
  h.storage.set("rh-banner-dismissed", "1");
  await h.start();
  assert.equal(h.banner.hidden, true);
});

test("the banner disappears for good once the three recommended steps are done", async () => {
  const h = makeHarness({
    profiles: [profile({ ...BRANDED, ...LINKS })],
    activeProfileId: "contoso",
    status: statusPayload({ devices: [device()] }),
  });
  h.profiles[0].id = "contoso";
  await h.start();
  assert.equal(h.banner.hidden, true);
  assert.equal(h.storage.get("rh-banner-done"), "1");

  h.status = statusPayload({ devices: [device({ connected: false })] });
  await h.run("scLoadStatus")(true);
  h.run("rhOnStatusChanged")();
  assert.equal(h.rowState("computer"), "attention");
  assert.equal(h.banner.hidden, true, "a computer going offline later does not bring the first-run banner back");
});

test("the banner opens the checklist and focuses its heading", async () => {
  const h = await makeHarness().start();
  await h.click(h.bannerOpen);
  assert.deepEqual(h.tabs.slice(-1), ["config"]);
  assert.equal(h.focused(), "rh-heading");
});

test("a banner that cannot tell yet (data still loading or failed) is not shown for rows that are unknown", () => {
  const h = makeHarness();
  const model = (overrides, flags) => json(h.run("rhBannerModel")(h.run("rhBuildRows")(input(overrides)), flags));
  const loadingEverything = model({ profiles: { loaded: false, error: "", profiles: [] }, status: null, statusError: "" });
  assert.equal(loadingEverything.show, false);
  const failedEverything = model({ profiles: { loaded: false, error: "x", profiles: [] }, status: null, statusError: "y" });
  assert.equal(failedEverything.show, false);
  const open = model({ profiles: { loaded: true, error: "", activeProfileId: "default", profiles: [profile()] } });
  assert.equal(open.show, true);
  assert.equal(open.done, 1, "the connected computer already counts");
  assert.deepEqual(open.open, ["Brand profile", "Learner links"]);
  assert.equal(model({}, { dismissed: true }).show, false);
  assert.equal(model({}).show, false, "all three recommended steps are done");
  assert.equal(model({}).complete, true);
  assert.equal(model({ drift: drift(), storage: STORAGE_LOCAL }).show, false, "optional rows never keep the banner open");
});

// ── Fix-it buttons ──────────────────────────────────────────────────────────

test("Create a brand profile opens a new profile in the Brand profiles editor", async () => {
  const h = await makeHarness().start();
  await h.click(h.button("brand", "brand-create"));
  assert.deepEqual(h.tabs, ["config"]);
  assert.equal(h.spies.newProfile, 1);
  assert.equal(h.focused(), "bp-name");
  await h.click(h.button("brand", "brand-create"));
  assert.equal(h.spies.newProfile, 1, "an unsaved new profile is never thrown away by a second click");
});

test("editing buttons select the active profile and focus the field that needs attention", async () => {
  const h = makeHarness({ profiles: [profile({ id: "default" }), profile({ ...BRANDED, ...{ logo: null }, copilotStudioUrl: ADDRESSES.copilotStudioUrl })], activeProfileId: "contoso" });
  await h.start();
  h.brandProfiles.selectedId = "default";
  await h.click(h.button("brand", "brand-edit"));
  assert.deepEqual(h.spies.selected, ["contoso"], "the editor switches to the active profile");
  assert.equal(h.focused(), "branding-logo-file", "it lands on the missing logo");
  await h.click(h.button("links", "links-edit"));
  assert.equal(h.focused(), "bp-moreInfoUrl");
  await h.click(h.button("tenant", "tenant-edit"));
  assert.equal(h.focused(), "bp-powerPlatformEnvUrl", "it lands on the first missing tenant address");
});

test("Connect your computer reuses the Screenshot Center pairing card inside the row and returns focus when closed", async () => {
  const h = await makeHarness().start();
  await h.click(h.button("computer", "computer-connect"));
  const post = h.calls.filter((c) => c.method === "POST" && c.url === "/api/capture/pair");
  assert.equal(post.length, 1);
  const card = h.row("computer").querySelector(".sc-pairing");
  assert.ok(card, "the pairing card is drawn inside the Screenshot computer row");
  assert.equal(card.querySelector(".sc-code").textContent, "ABCD-1234");
  assert.equal(h.focused(), "sc-pair-heading");
  assert.ok(card.querySelector('a[href="/api/capture/companion.zip"]'));

  await h.click(card.querySelector('[data-sc-action="pair-copy-code"]'));
  assert.deepEqual(h.copied, ["ABCD-1234"]);

  await h.click(h.row("computer").querySelector('[data-sc-action="pair-close"]'));
  assert.equal(h.row("computer").querySelector(".sc-pairing"), null);
  assert.equal(h.focused(), "computer-connect", "focus returns to the row's button");
});

test("when the computer connects, the row, the count, and the banner update by themselves", async () => {
  const h = await makeHarness().start();
  assert.equal(h.rowState("computer"), "todo");
  await h.click(h.button("computer", "computer-connect"));
  h.status = statusPayload({ devices: [device()] });
  await h.run("scLoadStatus")(true);
  h.run("scPairingSucceeded")(device());
  await h.flush();
  assert.equal(h.rowState("computer"), "done");
  assert.match(h.detail("computer"), /Connected: Ada PC/);
  assert.match(h.document.getElementById("rh-banner-text").textContent, /^1 of 3 done/);
  assert.match(h.row("computer").querySelector(".sc-pair-success").textContent, /Connected: Ada PC\. You are ready to capture screenshots\./, "the pairing card says it worked");
  assert.match(h.live.textContent, /Connected: Ada PC/, "the connection is announced even though the Screenshot Center is not open");
});

test("Open Screenshot Center opens the newest lab, or explains that a lab comes first", async () => {
  const labs = [
    { labId: "lab-old", generatedAt: "2026-05-01T00:00:00.000Z" },
    { labId: "lab-new", generatedAt: "2026-05-20T00:00:00.000Z" },
  ];
  const h = makeHarness({ status: statusPayload({ devices: [device()], signedIn: [] }), labs });
  await h.start();
  await h.click(h.button("signin", "screenshots-open"));
  assert.deepEqual(h.spies.openShots, ["lab-new"]);
  assert.equal(h.tabs.at(-1), "labbuilder");
  assert.equal(h.focused(), "lb-screenshots-heading");

  const empty = makeHarness({ status: statusPayload({ devices: [device()], signedIn: [] }) });
  await empty.start();
  await empty.click(empty.button("signin", "screenshots-open"));
  assert.deepEqual(empty.spies.openShots, []);
  assert.match(empty.live.textContent, /Build a lab first/);
  assert.equal(empty.focused(), "lb-build-heading");
});

test("Show how to fix this toggles the storage steps and keeps focus on the button", async () => {
  const h = await makeHarness({ hostname: "portal.contoso.com" }).start();
  await h.run("rhRefresh")({ scope: "all", force: true });
  await h.flush();
  const button = () => h.button("storage", "storage-help");
  assert.equal(button().getAttribute("aria-expanded"), "false");
  assert.equal(button().getAttribute("aria-controls"), "rh-storage-help");
  const help = () => h.document.getElementById("rh-storage-help");
  assert.equal(help().hidden, true);
  await h.click(button());
  assert.equal(help().hidden, false);
  assert.equal(button().getAttribute("aria-expanded"), "true");
  assert.equal(button().textContent, "Hide the steps");
  assert.equal(h.focused(), "storage-help");
  await h.click(button());
  assert.equal(help().hidden, true);
});

test("Check all labs now runs the existing bulk scan, shows it is busy, and refreshes the row", async () => {
  const h = makeHarness({ driftData: drift({ total: 3, notChecked: 3 }), labs: [{ labId: "lab-a" }] });
  await h.start();
  await h.run("rhRefresh")({ scope: "all", force: true });
  await h.flush();
  assert.equal(h.rowState("learn"), "todo");
  const scan = h.run("lbScanFleetLearnDrift");
  assert.equal(typeof scan, "function");
  await h.click(h.button("learn", "learn-scan"));
  assert.equal(h.spies.scans, 1, "the Build tab's own bulk scan is reused");
  assert.equal(h.rowState("learn"), "done");
  assert.match(h.detail("learn"), /^All 3 labs match Microsoft Learn\./);
  assert.match(h.live.textContent, /Microsoft Learn check finished\. All 3 labs match/);
  assert.equal(h.focused(), "learn-scan");
});

test("Show them filters the saved labs to the ones that need updates", async () => {
  const h = makeHarness({ driftData: drift({ total: 3, docsUpdated: 2, upToDate: 1 }) });
  await h.start();
  await h.run("rhRefresh")({ scope: "all", force: true });
  await h.flush();
  let changed = 0;
  h.filter.addEventListener("change", () => (changed += 1));
  await h.click(h.button("learn", "learn-show"));
  assert.equal(h.tabs.at(-1), "labbuilder");
  assert.equal(h.filter.value, "docs-updated");
  assert.equal(changed, 1);
  assert.equal(h.details.open, true);
  assert.equal(h.focused(), "lb-gen-drift-filter");
});

test("Build a lab and Check again lead somewhere useful", async () => {
  const h = await makeHarness().start();
  await h.run("rhRefresh")({ scope: "all", force: true });
  await h.flush();
  await h.click(h.button("learn", "build-open"));
  assert.equal(h.tabs.at(-1), "labbuilder");
  assert.equal(h.focused(), "lb-heading-1");

  const failing = makeHarness();
  failing.statusFails = true;
  await failing.start();
  assert.equal(failing.rowState("computer"), "error");
  assert.match(failing.detail("computer"), /We could not check whether a screenshot computer is connected\. Try again in a moment\./);
  failing.statusFails = false;
  await failing.click(failing.button("computer", "refresh"));
  assert.equal(failing.rowState("computer"), "todo", "Check again recovers once the problem is gone");
});

test("opening a tab refreshes only what that tab shows", async () => {
  const h = await makeHarness().start();
  h.calls.length = 0;
  h.run("rhOnTabShown")("config");
  await h.flush();
  assert.ok(h.calls.some((c) => c.url === "/healthz") && h.calls.some((c) => c.url === "/api/lab-builder/learn-drift"));
  h.calls.length = 0;
  h.run("rhOnTabShown")("labbuilder");
  await h.flush();
  assert.ok(!h.calls.some((c) => c.url === "/healthz" || c.url === "/api/lab-builder/learn-drift"), "the Build banner needs only the profiles and the capture status");
  h.run("rhOnTabShown")("validate");
});

// ── Safety ──────────────────────────────────────────────────────────────────

test("profile names, computer names, and messages from the network are shown as text only", async () => {
  const evil = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  const h = makeHarness({
    profiles: [profile({ id: "evil", name: evil, companyName: evil, logo: evil, primaryColor: "#0f6cbd", moreInfoUrl: "javascript:alert(1)", moreInfoLabel: evil, supportName: evil })],
    activeProfileId: "evil",
    status: statusPayload({ devices: [device({ name: evil })], signedIn: [evil] }),
    health: { status: "ok", storage: STORAGE_LOCAL },
  });
  await h.start();
  await h.run("rhRefresh")({ scope: "all", force: true });
  await h.flush();
  const all = h.list.querySelectorAll("*");
  assert.ok(all.length > 20);
  assert.equal(all.filter((el) => ["IMG", "SCRIPT", "IFRAME"].includes(el.tagName)).length, 0, "nothing from the data becomes markup");
  for (const el of all) for (const name of el.attributes.keys()) assert.ok(!/^on/i.test(name), `no ${name} attribute`);
  assert.match(h.detail("brand"), /profile is active with your company name, logo, and primary color/);
  assert.ok(h.list.textContent.includes(evil), "the hostile text is displayed literally");
  assert.equal(h.document.getElementById("rh-banner-text").textContent.includes("<img"), false);
  assert.doesNotMatch(HUB_SOURCE, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/, "the hub never parses text as HTML");
  assert.doesNotMatch(HUB_SOURCE, /\bon(click|change|input)=/, "no inline handlers");
});

test("the hub uses no technical jargon and US English only", () => {
  const strings = [...HUB_SOURCE.matchAll(/`([^`]*)`|"([^"\n]*)"/g)].map((m) => m[1] ?? m[2]).join("\n");
  assert.doesNotMatch(strings, /Playwright|Learn Sync|\.auth\b|headed|headless|Chromium/i);
  assert.doesNotMatch(HUB_SOURCE, /\b(colour|behaviour|centre|licence|organis|catalogue|favourite|cancelled)\w*/i);
});

// ── Markup, look, and print ─────────────────────────────────────────────────

test("the banner and the checklist sit at the top of their tabs and load after the Screenshot Center", () => {
  const build = INDEX_HTML.slice(INDEX_HTML.indexOf('id="panel-labbuilder"'));
  const afterOpen = build.slice(build.indexOf(">") + 1).trimStart();
  assert.ok(afterOpen.startsWith('<section class="rh-banner" id="rh-banner" aria-labelledby="rh-banner-title" hidden>'), "the first-run banner is the first thing in Build");
  const config = INDEX_HTML.slice(INDEX_HTML.indexOf('id="panel-config"'));
  const configAfter = config.slice(config.indexOf(">") + 1).trimStart();
  assert.ok(configAfter.startsWith('<section class="panel rh-card" id="readiness-hub" aria-labelledby="rh-heading">'), "the Setup checklist is the first card in Configuration");
  assert.match(INDEX_HTML, /<h3 id="rh-heading" tabindex="-1">/);
  assert.match(INDEX_HTML, /<ol class="rh-list" id="rh-list" aria-label="Setup tasks">/);
  assert.match(INDEX_HTML, /id="rh-progress" role="progressbar" aria-label="Setup progress"/);
  assert.match(INDEX_HTML, /<h3 id="lb-build-heading" tabindex="-1">/, "the Build heading can take focus after the banner is dismissed");
  assert.match(INDEX_HTML, /<div id="app-live" class="sr-only" role="status" aria-live="polite" aria-atomic="true"><\/div>/);
  const at = (name) => INDEX_HTML.indexOf(`<script src="${name}" defer></script>`);
  const order = ["generated-labs.js", "screenshot-center-core.js", "screenshot-center-command.js", "screenshot-center-jobs.js", "screenshot-center.js", "lab-checklist.js", "lab-customize.js", "readiness-hub.js"].map(at);
  assert.ok(order.every((i) => i > 0));
  assert.deepEqual([...order].sort((a, b) => a - b), order, "the hub loads last, so every helper it reuses exists");
  assert.equal(INDEX_HTML.match(/id="rh-banner-open"[^>]*>/)[0].includes("btn-primary"), false, "the banner leaves the wizard's Next button as the one primary action");
});

test("app.js and the Screenshot Center tell the hub when something changes", () => {
  assert.match(publicFile("app.js"), /if \(typeof rhOnTabShown === "function"\) rhOnTabShown\(tabName\);/);
  assert.match(publicFile("app.js"), /if \(typeof rhOnBrandChanged === "function"\) rhOnBrandChanged\(\);/);
  assert.match(publicFile("screenshot-center-jobs.js"), /if \(typeof rhOnStatusChanged === "function"\) rhOnStatusChanged\(\);/);
  assert.match(publicFile("screenshot-center-jobs.js"), /getElementById\("lb-screenshots-live"\) \|\| document\.getElementById\("app-live"\)/);
});

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

test("every checklist color pair meets WCAG AA in the dark and light themes", () => {
  const region = STYLE.slice(STYLE.indexOf("/* ── Setup checklist (readiness hub)"), STYLE.indexOf("@media print"));
  assert.ok(region.includes(".rh-row {") && region.includes(".rh-banner {"));
  for (const [name, t] of [["dark", DARK], ["light", LIGHT], ["light (system)", LIGHT_AUTO]]) {
    for (const tone of ["ok", "warn", "bad", "info", "neutral"]) {
      assert.ok(contrast(t[`--sc-${tone}-fg`], t[`--sc-${tone}-bg`]) >= 4.5, `${name}: ${tone} text on its chip, icon, and help panel`);
    }
    for (const surface of ["--bg", "--surface"]) {
      assert.ok(contrast(t["--text"], t[surface]) >= 4.5, `${name}: row and banner titles on ${surface}`);
      assert.ok(contrast(t["--text-muted"], t[surface]) >= 4.5, `${name}: explanations on ${surface}`);
    }
    assert.ok(contrast(t["--accent"], t["--surface"]) >= 3, `${name}: the banner's accent edge`);
    assert.ok(contrast(t["--accent"], t["--sc-track"]) >= 3, `${name}: the progress fill against its track`);
    assert.ok(contrast(t["--accent-contrast"], t["--accent"]) >= 4.5, `${name}: the primary button label`);
    for (const tone of ["ok", "warn", "bad"]) assert.ok(contrast(t[`--sc-${tone}-border`], t["--bg"]) >= 3, `${name}: ${tone} row outline against the row background`);
  }
});

test("checklist styles use theme tokens, wrap on small screens, respect reduced motion, and hide in print", () => {
  const start = STYLE.indexOf("/* ── Setup checklist (readiness hub)");
  const end = STYLE.indexOf("@media print");
  assert.ok(start > 0 && end > start, "the checklist styles sit in screen CSS, before the print block");
  const region = STYLE.slice(start, end);
  assert.doesNotMatch(region, /#[0-9a-f]{3,8}\b(?!-)|(?<![\w-])(?:white|black)(?![\w-])/i, "no hard-coded colors");
  assert.match(region, /@media \(max-width: 560px\)[\s\S]*\.rh-actions, \.rh-banner-actions \{ width: 100%; \}/);
  assert.match(region, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.rh-progress-fill \{ transition: none; \}/);
  assert.match(region, /\.rh-row \{[^}]*flex-wrap: wrap/);
  assert.match(region, /\.rh-row-detail \{[^}]*overflow-wrap: anywhere/);
  assert.match(region, /\.rh-banner\[hidden\] \{ display: none; \}/);
  assert.equal(STYLE.split("@media print").length, 2, "there is exactly one print block");
  const printCss = STYLE.split("@media print")[1];
  assert.match(printCss, /\.rh-card,\s*\.rh-banner,/, "the checklist and the banner are hidden when printing");
});

test("the hub is a plain script: no module syntax and globals start with rh", () => {
  assert.doesNotMatch(HUB_SOURCE, /^\s*(import|export)\s/m);
  const names = [...HUB_SOURCE.matchAll(/^(?:async )?function (\w+)|^const (\w+) =/gm)].map((m) => m[1] || m[2]);
  for (const name of names) assert.match(name, /^(rh|RH_)/i, `${name} should be namespaced`);
});
