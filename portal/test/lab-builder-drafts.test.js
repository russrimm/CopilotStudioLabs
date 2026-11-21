/**
 * Saved drafts: the store (portal/lib/lab-builder/drafts.js) and its routes (drafts-api.js).
 *
 * Everything runs against a throwaway folder and, for the routes, a throwaway Express app with a fake identity.
 * Only made-up names appear here (contoso, fabrikam, "oid-alice").
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";

import { MAX_DRAFTS, MAX_DRAFT_BYTES, DRAFT_SCHEMA_VERSION, ownerKeyFor, createDraftStore, draftsDirFor as routeDraftsDir, DraftError, normalizeDraftContent, isDraftId } from "../lib/lab-builder/drafts.js";
import { registerDraftRoutes } from "../lib/lab-builder/drafts-api.js";
import { selectionsFromManifest } from "../lib/lab-builder/generated-labs.js";
import { createRateLimiter, positiveIntFromEnv } from "../lib/rate-limit.js";

const cleanups = [];
after(() => {
  for (const clean of cleanups.reverse()) clean();
});

// The store tests hand the store a folder directly, so a draft's file sits at <folder>/<owner>/<id>.json.
const draftsDirFor = (dir) => dir;

function tmp() {
  const dir = mkdtempSync(path.join(tmpdir(), "lb-drafts-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function rich(overrides = {}) {
  return {
    selections: {
      products: ["copilot-studio", "sharepoint-ai"],
      industry: "retail",
      roles: ["sales", "it"],
      level: 200,
      harness: "standard",
      differencesFor: ["microsoft-copilot"],
      features: ["alpha", "beta"],
      excluded: ["gamma"],
      excludedSubtopics: ["learn-sub-one", "learn-sub-two"],
      moduleOrder: ["beta", "alpha"],
      targetMinutes: 240,
      customTitle: "Contoso support lab",
      agentName: "Contoso Assistant",
      sharepointSiteName: "Contoso Team",
      sharepointSiteUrl: "https://contoso.sharepoint.com/sites/team",
      useLearnMcp: false,
      useLlm: false,
      includeKnowledgeCheck: true,
      brandProfileId: "profile-contoso",
      brandOverrides: { companyName: "Contoso", tagline: "Learn by doing" },
      ...overrides.selections,
    },
    wizard: { step: 3, furthest: 4, chosenSteps: ["product", "tailor", "topics"], picked: ["alpha"], removed: [{ id: "gamma", wasPicked: true }], ...overrides.wizard },
    labels: { alpha: "Alpha trigger", gamma: "Gamma topic", "copilot-studio": "Copilot Studio", ...overrides.labels },
  };
}

function clock(start = Date.parse("2026-11-18T10:00:00Z")) {
  let t = start;
  const now = () => t;
  now.tick = (ms = 1000) => {
    t += ms;
  };
  return now;
}

const alice = { oid: "oid-alice-0001", tid: "tenant-contoso", upn: "alice@contoso.example" };
const bob = { oid: "oid-bob-0002", tid: "tenant-contoso", upn: "bob@contoso.example" };

// ── The store ───────────────────────────────────────────────────────────────

test("a draft can be created, listed, read, renamed, changed, duplicated, and deleted", () => {
  const now = clock();
  const store = createDraftStore({ dir: tmp(), now });
  const created = store.create("local", { name: "  Retail   pilot ", content: rich() });
  assert.match(created.id, /^draft-[0-9a-f]{24}$/);
  assert.equal(created.name, "Retail pilot", "the name is one clean line");

  now.tick();
  const listed = store.list("local");
  assert.equal(listed.limit, MAX_DRAFTS);
  assert.deepEqual(listed.drafts.map((d) => d.id), [created.id]);
  assert.deepEqual(listed.drafts[0].products, ["copilot-studio", "sharepoint-ai"]);
  assert.equal(listed.drafts[0].level, 200);
  assert.equal(listed.drafts[0].step, 3);
  assert.equal(listed.drafts[0].topicCount, 2);

  const read = store.get("local", created.id);
  assert.deepEqual(read.content, normalizeDraftContent(rich()), "everything comes back as it was saved");

  now.tick();
  const renamed = store.update("local", created.id, { name: "Retail pilot v2" });
  assert.equal(renamed.name, "Retail pilot v2");
  assert.deepEqual(renamed.content, read.content, "a rename leaves the choices alone");
  assert.ok(renamed.updatedAt > created.updatedAt, "updatedAt moves forward");

  now.tick();
  const changed = store.update("local", created.id, { content: rich({ selections: { level: 300 } }) });
  assert.equal(changed.content.selections.level, 300);
  assert.equal(changed.name, "Retail pilot v2");

  now.tick();
  const copy = store.duplicate("local", created.id);
  assert.equal(copy.name, "Copy of Retail pilot v2");
  assert.notEqual(copy.id, created.id);
  assert.deepEqual(copy.content, changed.content);
  assert.equal(store.list("local").drafts.length, 2);

  store.remove("local", created.id);
  assert.deepEqual(store.list("local").drafts.map((d) => d.id), [copy.id]);
  assert.throws(() => store.get("local", created.id), (err) => err instanceof DraftError && err.status === 404 && /not found/i.test(err.message));
  assert.throws(() => store.remove("local", created.id), (err) => err.status === 404);
});

test("a draft may be incomplete, but it must name at least one product", () => {
  const store = createDraftStore({ dir: tmp() });
  const early = store.create("local", { name: "Just started", content: { selections: { products: ["copilot-studio"] }, wizard: { step: 2 } } });
  assert.deepEqual(early.content.selections.features, []);
  assert.equal(early.content.wizard.picked, null);
  assert.throws(() => store.create("local", { name: "x", content: { selections: { products: [] } } }), /Choose at least one product/);
  assert.throws(() => store.create("local", { name: "x", content: {} }), /nothing to save/i);
  assert.throws(() => store.create("local", { name: "x" }), /nothing to save/i);
});

test("a draft file uses the same selections as a built lab's saved selections", () => {
  const manifest = {
    request: { features: ["alpha", "beta"], products: ["copilot-studio"], industry: "retail", roles: ["sales"], level: 200, harness: "standard", excluded: ["gamma"], moduleOrder: ["beta", "alpha"], excludedSubtopics: ["learn-sub-one"], targetMinutes: 90 },
    options: { customTitle: "Contoso lab", agentName: "Contoso Assistant", useLearnMcp: true, useLlm: false, includeKnowledgeCheck: true },
  };
  const saved = selectionsFromManifest(manifest);
  const accepted = normalizeDraftContent({ selections: saved, wizard: { step: 4 } }).selections;
  for (const key of Object.keys(saved)) assert.deepEqual(accepted[key], saved[key], `${key} means the same thing in a draft and in a built lab`);
});

test("names and text are cleaned, and what is not valid is refused with a plain message", () => {
  const store = createDraftStore({ dir: tmp() });
  assert.throws(() => store.create("local", { name: "x".repeat(81), content: rich() }), /80 characters or fewer/);
  assert.throws(() => store.create("local", { name: "   ", content: rich() }), /Give the draft a name/);
  const auto = store.create("local", { content: rich() });
  assert.match(auto.name, /^Draft 2026-|^Draft \d{4}-\d{2}-\d{2}$/, "a draft with no name gets one from the date");
  const bad = (selections, pattern) => assert.throws(() => normalizeDraftContent({ selections: { products: ["copilot-studio"], ...selections } }), pattern);
  bad({ level: 250 }, /Level 100, 200, or 300/);
  bad({ targetMinutes: 1.5 }, /whole number of minutes/);
  bad({ features: "alpha" }, /not a list/);
  bad({ features: ["fine", "../escape"] }, /not valid/);
  bad({ features: Array.from({ length: 1001 }, (_, i) => `topic-${i}`) }, /more topics than can be saved/);
  assert.throws(() => normalizeDraftContent({ selections: { products: ["copilot-studio"] }, wizard: { step: 5 } }), /not a wizard step/);
  assert.throws(() => normalizeDraftContent({ selections: { products: ["copilot-studio"] }, wizard: { chosenSteps: ["vertical"] } }), /answered steps/);
  const clean = normalizeDraftContent({ selections: { products: ["copilot-studio"], customTitle: "A\u0000 title\nwith   breaks", unknownField: "ignored", brandOverrides: { companyName: " Contoso ", sneaky: "x" } } });
  assert.equal(clean.selections.customTitle, "A title with breaks");
  assert.equal(clean.selections.unknownField, undefined);
  assert.deepEqual(clean.selections.brandOverrides, { companyName: "Contoso" });
});

test("a draft over the size limit is refused and says how to fix it", () => {
  const store = createDraftStore({ dir: tmp() });
  const huge = Array.from({ length: 5000 }, (_, i) => `learn-${"a".repeat(80)}-${i}`);
  assert.throws(
    () => store.create("local", { name: "Huge", content: { selections: { products: ["copilot-studio"], excludedSubtopics: huge } } }),
    (err) => err.status === 413 && new RegExp(`${MAX_DRAFT_BYTES / 1024} KB`).test(err.message) && /Leave out some topics/.test(err.message),
  );
  const ok = Array.from({ length: 5000 }, (_, i) => `learn-sub-${i}`);
  assert.equal(store.create("local", { name: "Large but fine", content: { selections: { products: ["copilot-studio"], excludedSubtopics: ok } } }).content.selections.excludedSubtopics.length, 5000);
});

test("at most 50 drafts per person, with a plain message", () => {
  const store = createDraftStore({ dir: tmp() });
  const content = { selections: { products: ["copilot-studio"] } };
  for (let i = 0; i < MAX_DRAFTS; i += 1) store.create("local", { name: `Draft ${i}`, content });
  assert.throws(() => store.create("local", { name: "One more", content }), (err) => err.status === 409 && /already have 50 saved drafts/.test(err.message));
  const first = store.list("local").drafts[0];
  assert.throws(() => store.duplicate("local", first.id), /already have 50 saved drafts/);
  store.saveUnsaved("local", { content });
  assert.equal(store.list("local").drafts.length, MAX_DRAFTS, "the autosave slot is not a draft and is not counted");
  store.remove("local", first.id);
  assert.ok(store.create("local", { name: "Fits again", content }));
});

test("each person has a private space named by a one-way hash, and nobody else can reach it", () => {
  const dir = tmp();
  const store = createDraftStore({ dir });
  const a = ownerKeyFor(alice, { authEnabled: true });
  const b = ownerKeyFor(bob, { authEnabled: true });
  assert.match(a, /^u-[0-9a-f]{32}$/);
  assert.notEqual(a, b);
  assert.equal(a, ownerKeyFor({ ...alice, upn: "someone.else@fabrikam.example" }, { authEnabled: true }), "the stable id decides, not the address");
  assert.equal(ownerKeyFor(null, { authEnabled: false }), "local");
  assert.equal(ownerKeyFor({}, { authEnabled: true }), null, "sign-in on but no identity: no space at all");
  assert.equal(ownerKeyFor({ upn: "carol@contoso.example" }, { authEnabled: true }).startsWith("u-"), true);

  const content = rich();
  const mine = store.create(a, { name: "Alice only", content });
  store.saveUnsaved(a, { content });
  assert.deepEqual(store.list(b).drafts, []);
  assert.equal(store.getUnsaved(b), null);
  assert.throws(() => store.get(b, mine.id), /not found/i);
  assert.throws(() => store.update(b, mine.id, { name: "Hijacked" }), /not found/i);
  assert.throws(() => store.remove(b, mine.id), /already deleted/i);
  assert.throws(() => store.list(null), /Sign in/);
  assert.throws(() => store.list("../escape"), /Sign in/);
  assert.equal(store.get(a, mine.id).name, "Alice only");

  const onDisk = readdirSync(dir, { recursive: true }).join("\n");
  assert.doesNotMatch(onDisk, /alice|bob|oid-|contoso/i, "no name, address, or id appears in a path");
  const files = readdirSync(dir, { recursive: true }).filter((name) => name.endsWith(".json"));
  for (const file of files) assert.doesNotMatch(readFileSync(path.join(dir, file), "utf8"), /alice@|oid-alice/i, "the identity is never written into a file");
});

test("a draft id cannot be used to reach another path", () => {
  const dir = tmp();
  const store = createDraftStore({ dir });
  writeFileSync(path.join(dir, "secret.json"), "{}");
  for (const id of ["../secret", "..\\secret", "draft-../x", "draft-zzzzzzzzzzzzzzzzzzzzzzzz", "draft-0123456789abcdef0123456", "DRAFT-0123456789ABCDEF01234567", "unsaved", "", null, undefined, 7]) {
    assert.equal(isDraftId(id), false, String(id));
    assert.throws(() => store.get("local", id), (err) => err.status === 400, String(id));
    assert.throws(() => store.remove("local", id), (err) => err.status === 400, String(id));
  }
  assert.equal(fs.existsSync(path.join(dir, "secret.json")), true);
});

test("writes are atomic: a failed write leaves the saved draft exactly as it was and no temp file behind", () => {
  const dir = tmp();
  const store = createDraftStore({ dir });
  const draft = store.create("local", { name: "Steady", content: rich() });
  const file = path.join(draftsDirFor(dir), "local", `${draft.id}.json`);
  const before = readFileSync(file, "utf8");

  const realRename = fs.renameSync;
  fs.renameSync = () => {
    const err = new Error("disk trouble");
    err.code = "EIO";
    throw err;
  };
  try {
    assert.throws(() => store.update("local", draft.id, { name: "Never lands" }), /disk trouble/);
  } finally {
    fs.renameSync = realRename;
  }
  assert.equal(readFileSync(file, "utf8"), before);
  assert.deepEqual(readdirSync(path.dirname(file)).filter((n) => n.includes(".blob-tmp-")), [], "the temp copy is cleaned up");

  assert.throws(() => store.update("local", draft.id, { content: { selections: { products: [] } } }), /Choose at least one product/);
  assert.equal(readFileSync(file, "utf8"), before, "a refused save never touches the file");

  // A temp file left by a crash is not a draft.
  writeFileSync(`${file}.blob-tmp-1234-abcdef`, "{ half a file");
  assert.deepEqual(store.list("local").drafts.map((d) => d.id), [draft.id]);
  assert.equal(store.update("local", draft.id, { name: "Fine again" }).name, "Fine again");
});

test("a damaged file is reported plainly, never hides the other drafts, and can still be deleted", () => {
  const dir = tmp();
  const store = createDraftStore({ dir });
  const good = store.create("local", { name: "Good one", content: rich() });
  const ownerFolder = path.join(draftsDirFor(dir), "local");
  const badId = "draft-aaaaaaaaaaaaaaaaaaaaaaaa";
  const emptyId = "draft-bbbbbbbbbbbbbbbbbbbbbbbb";
  const shapeId = "draft-cccccccccccccccccccccccc";
  writeFileSync(path.join(ownerFolder, `${badId}.json`), "{ not json at all");
  writeFileSync(path.join(ownerFolder, `${emptyId}.json`), "");
  writeFileSync(path.join(ownerFolder, `${shapeId}.json`), JSON.stringify({ schemaVersion: 1, id: shapeId, name: "No content", createdAt: "x", updatedAt: "y", content: { selections: { products: "nope" } } }));

  const { drafts } = store.list("local");
  assert.equal(drafts.length, 4);
  assert.equal(drafts.find((d) => d.id === good.id).name, "Good one");
  for (const id of [badId, emptyId, shapeId]) {
    const entry = drafts.find((d) => d.id === id);
    assert.equal(entry.unavailable, true, id);
    assert.equal(entry.message, "This draft file could not be read.");
    assert.throws(() => store.get("local", id), (err) => err.status === 422 && /could not be read/.test(err.message));
    assert.throws(() => store.update("local", id, { name: "Overwrite" }), /could not be read/);
  }
  assert.equal(readFileSync(path.join(ownerFolder, `${badId}.json`), "utf8"), "{ not json at all", "the damaged file is left as it was");
  store.remove("local", badId);
  assert.equal(store.list("local").drafts.length, 3);
});

test("a draft saved by a newer version is refused with a plain message and its file stays intact", () => {
  const dir = tmp();
  const store = createDraftStore({ dir });
  const draft = store.create("local", { name: "From the future", content: rich() });
  const file = path.join(draftsDirFor(dir), "local", `${draft.id}.json`);
  const future = { ...JSON.parse(readFileSync(file, "utf8")), schemaVersion: 99, extra: { shape: "unknown" } };
  writeFileSync(file, JSON.stringify(future));
  const before = readFileSync(file, "utf8");

  const entry = store.list("local").drafts[0];
  assert.equal(entry.unavailable, true);
  assert.equal(entry.reason, "newer-version");
  assert.match(entry.message, /newer version of the portal.*cannot be opened here.*has not been changed/);
  assert.throws(() => store.get("local", draft.id), (err) => err.status === 409 && err.code === "newer-version");
  assert.throws(() => store.update("local", draft.id, { name: "x" }), /newer version/);
  assert.equal(readFileSync(file, "utf8"), before);
});

test("an older file is migrated step by step when it is read, and a missing step is refused", () => {
  const dir = tmp();
  const writer = createDraftStore({ dir });
  const draft = writer.create("local", { name: "Old shape", content: rich() });
  const file = path.join(draftsDirFor(dir), "local", `${draft.id}.json`);
  const record = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...record, schemaVersion: 1, name: "old" }));

  const migrating = createDraftStore({ dir, schema: { currentVersion: 3, migrations: { 1: (r) => ({ ...r, name: `${r.name}+one` }), 2: (r) => ({ ...r, name: `${r.name}+two` }) } } });
  assert.equal(migrating.get("local", draft.id).name, "old+one+two");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).schemaVersion, 1, "reading never rewrites the file");

  const stuck = createDraftStore({ dir, schema: { currentVersion: 3, migrations: { 2: (r) => r } } });
  assert.throws(() => stuck.get("local", draft.id), (err) => err.status === 409 && /older version that can no longer be opened.*has not been changed/.test(err.message));
});

/** Rewrite a saved draft's file the way portal version 1 wrote it: eight wizard steps and the old answered-step names. */
function asVersionOne(dir, id, wizard, { unsaved = false } = {}) {
  const file = path.join(draftsDirFor(dir), "local", `${unsaved ? "unsaved" : id}.json`);
  const record = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...record, schemaVersion: 1, content: { ...record.content, wizard: { picked: ["alpha"], removed: [], ...wizard } } }));
  return file;
}

test("a version 1 draft is moved onto the four version 2 steps when it is read, with every choice intact", () => {
  const dir = tmp();
  const store = createDraftStore({ dir });
  const everything = ["product", "vertical", "departments", "level", "harness", "topics"];
  const expectations = [
    // [old step, old furthest, old answered steps, new step, new furthest, new answered steps]
    [1, 1, ["product"], 1, 1, ["product"]],
    [2, 2, ["product"], 2, 2, ["product"]],
    [3, 4, ["product", "vertical"], 2, 2, ["product", "tailor"]],
    [4, 4, ["product", "vertical", "departments"], 2, 2, ["product", "tailor"]],
    [5, 5, ["product", "vertical", "departments", "level", "harness"], 2, 2, ["product", "tailor"]],
    [6, 7, everything, 3, 4, ["product", "tailor", "topics"]],
    [7, 7, everything, 4, 4, ["product", "tailor", "topics"]],
    [8, 8, everything, 4, 4, ["product", "tailor", "topics"]],
    // The Harness step could be hidden: such a draft went from Level (4) straight to Topics (6).
    [6, 6, ["product", "vertical", "departments", "level", "topics"], 3, 3, ["product", "tailor", "topics"]],
  ];
  for (const [step, furthest, chosenSteps, newStep, newFurthest, newChosen] of expectations) {
    const draft = store.create("local", { name: `Old step ${step}`, content: rich() });
    const original = store.get("local", draft.id).content.selections;
    const file = asVersionOne(dir, draft.id, { step, furthest, chosenSteps });
    const before = readFileSync(file, "utf8");

    const read = store.get("local", draft.id);
    assert.equal(read.schemaVersion, DRAFT_SCHEMA_VERSION);
    assert.deepEqual([read.content.wizard.step, read.content.wizard.furthest, read.content.wizard.chosenSteps], [newStep, newFurthest, newChosen], `old step ${step}`);
    assert.deepEqual(read.content.wizard.picked, ["alpha"], "the person's own picks are untouched");
    assert.deepEqual(read.content.selections, original, "every selection is untouched");
    assert.equal(store.list("local").drafts.find((d) => d.id === draft.id).step, newStep, "the Saved drafts list reads the new step");
    assert.equal(readFileSync(file, "utf8"), before, "reading never rewrites the file");
  }
});

test("a version 1 draft keeps every selection, and saving it again writes version 2", () => {
  const dir = tmp();
  const store = createDraftStore({ dir });
  const draft = store.create("local", { name: "Old and rich", content: rich() });
  const original = store.get("local", draft.id).content.selections;
  asVersionOne(dir, draft.id, { step: 6, furthest: 7, chosenSteps: ["product", "vertical", "departments", "level", "harness", "topics"] });
  const migrated = store.get("local", draft.id);
  assert.deepEqual(migrated.content.selections, original);
  assert.deepEqual(migrated.content.labels, rich().labels);
  const renamed = store.update("local", draft.id, { name: "Renamed" });
  assert.equal(renamed.schemaVersion, DRAFT_SCHEMA_VERSION);
  assert.equal(JSON.parse(readFileSync(path.join(draftsDirFor(dir), "local", `${draft.id}.json`), "utf8")).schemaVersion, DRAFT_SCHEMA_VERSION);
});

test("the autosave slot of version 1 resumes on the right new step", () => {
  const dir = tmp();
  const store = createDraftStore({ dir });
  store.saveUnsaved("local", { content: rich() });
  asVersionOne(dir, null, { step: 8, furthest: 8, chosenSteps: ["product", "vertical", "departments", "level", "harness", "topics"] }, { unsaved: true });
  const slot = store.getUnsaved("local");
  assert.deepEqual([slot.content.wizard.step, slot.content.wizard.furthest], [4, 4]);
  assert.deepEqual(slot.content.wizard.chosenSteps, ["product", "tailor", "topics"]);
});

test("a version 1 draft with a step that never existed is still reported as unreadable, and a version 3 file stays refused", () => {
  const dir = tmp();
  const store = createDraftStore({ dir });
  const draft = store.create("local", { name: "Broken old draft", content: rich() });
  const file = asVersionOne(dir, draft.id, { step: 9, furthest: 9, chosenSteps: ["product"] });
  const entry = store.list("local").drafts.find((d) => d.id === draft.id);
  assert.equal(entry.unavailable, true);
  assert.equal(entry.reason, "unreadable");
  const before = readFileSync(file, "utf8");

  const future = { ...JSON.parse(before), schemaVersion: DRAFT_SCHEMA_VERSION + 1 };
  writeFileSync(file, JSON.stringify(future));
  assert.throws(() => store.get("local", draft.id), (err) => err.status === 409 && err.code === "newer-version");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).schemaVersion, DRAFT_SCHEMA_VERSION + 1, "the newer file is left as it was");
});

test("the last save wins, and the response says when it happened", () => {
  const now = clock();
  const store = createDraftStore({ dir: tmp(), now });
  const draft = store.create("local", { name: "Shared tab", content: rich() });
  now.tick(5000);
  const fromTabOne = store.update("local", draft.id, { content: rich({ selections: { customTitle: "From tab one" } }) });
  now.tick(5000);
  const fromTabTwo = store.update("local", draft.id, { content: rich({ selections: { customTitle: "From tab two" } }) });
  assert.ok(fromTabTwo.updatedAt > fromTabOne.updatedAt);
  const final = store.get("local", draft.id);
  assert.equal(final.content.selections.customTitle, "From tab two");
  assert.equal(final.updatedAt, fromTabTwo.updatedAt);
});

test("the autosave slot is its own file: it never overwrites or counts as a named draft", () => {
  const now = clock();
  const store = createDraftStore({ dir: tmp(), now });
  const named = store.create("local", { name: "Named on purpose", content: rich() });
  const before = JSON.stringify(store.get("local", named.id));
  assert.equal(store.getUnsaved("local"), null);
  now.tick();
  const slot = store.saveUnsaved("local", { content: rich({ selections: { level: 100 } }), basedOn: named.id });
  assert.equal(slot.basedOn, named.id);
  assert.equal(store.getUnsaved("local").content.selections.level, 100);
  assert.equal(JSON.stringify(store.get("local", named.id)), before, "the named draft is byte for byte the same");
  assert.deepEqual(store.list("local").drafts.map((d) => d.id), [named.id]);
  assert.throws(() => store.saveUnsaved("local", { content: rich(), basedOn: "../x" }), /not a draft id/);
  store.clearUnsaved("local");
  store.clearUnsaved("local");
  assert.equal(store.getUnsaved("local"), null);
});

// ── The routes ──────────────────────────────────────────────────────────────

async function startApi({ authEnabled = false, identity = true } = {}) {
  const dir = tmp();
  const app = express();
  app.use("/api/lab-builder/drafts", express.json({ limit: "320kb" }));
  app.use((req, _res, next) => {
    const who = req.headers["x-test-user"];
    if (identity && who === "alice") req.user = alice;
    if (identity && who === "bob") req.user = bob;
    next();
  });
  const store = registerDraftRoutes(app, { dataDir: dir, authEnabled, createRateLimiter, positiveIntFromEnv });
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.type === "entity.too.large" ? "Request body is too large." : "Invalid request body." }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  cleanups.push(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/lab-builder/drafts`;
  const call = async (suffix, { method = "GET", body, user } = {}) => {
    const res = await fetch(`${base}${suffix}`, { method, headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(user ? { "x-test-user": user } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { call, store, dir };
}

test("the routes list, create, read, update, duplicate, mark built, and delete drafts", async () => {
  const { call } = await startApi();
  assert.deepEqual((await call("")).body, { drafts: [], limit: 50, unsaved: null });

  const created = await call("", { method: "POST", body: { name: "Via the API", content: rich() } });
  assert.equal(created.status, 201);
  const id = created.body.draft.id;
  assert.equal(created.body.draft.content.selections.customTitle, "Contoso support lab");

  assert.equal((await call(`/${id}`)).body.draft.name, "Via the API");
  const renamed = await call(`/${id}`, { method: "PUT", body: { name: "Renamed" } });
  assert.equal(renamed.body.draft.name, "Renamed");
  const nothing = await call(`/${id}`, { method: "PUT", body: {} });
  assert.equal(nothing.status, 400);
  assert.equal(nothing.body.error, "There is nothing to change.");

  const copy = await call(`/${id}/duplicate`, { method: "POST" });
  assert.equal(copy.status, 201);
  assert.equal(copy.body.draft.name, "Copy of Renamed");

  const built = await call(`/${id}/built`, { method: "POST", body: { labId: "contoso-lab-1" } });
  assert.equal(built.body.draft.builtLabId, "contoso-lab-1");
  assert.ok(built.body.draft.builtAt);
  assert.equal((await call(`/${id}/built`, { method: "POST", body: { labId: "../bad" } })).status, 400);
  const afterBuilt = (await call("")).body.drafts.find((d) => d.id === id);
  assert.equal(afterBuilt.builtLabId, "contoso-lab-1");
  assert.equal(afterBuilt.name, "Renamed", "a built draft stays listed");

  assert.deepEqual((await call(`/${id}`, { method: "DELETE" })).body, { removed: true, id });
  assert.equal((await call(`/${id}`)).status, 404);
  assert.equal((await call(`/${id}`, { method: "DELETE" })).status, 404);
  assert.equal((await call("")).body.drafts.length, 1);
});

test("the routes answer with plain messages for bad ids, bad bodies, and a full list", async () => {
  const { call, store } = await startApi();
  for (const bad of ["..%2F..%2Fsecret", "draft-nothex", "draft-0123456789abcdef0123456"]) {
    const res = await call(`/${bad}`);
    assert.equal(res.status, 400, bad);
    assert.equal(res.body.error, "That is not a draft id.");
  }
  const empty = await call("", { method: "POST", body: { name: "No content" } });
  assert.equal(empty.status, 400);
  assert.match(empty.body.error, /nothing to save/i);
  const noProduct = await call("", { method: "POST", body: { name: "x", content: { selections: { products: [] } } } });
  assert.match(noProduct.body.error, /Choose at least one product/);

  for (let i = 0; i < MAX_DRAFTS; i += 1) store.create("local", { name: `Fill ${i}`, content: { selections: { products: ["copilot-studio"] } } });
  const full = await call("", { method: "POST", body: { name: "Overflow", content: rich() } });
  assert.equal(full.status, 409);
  assert.equal(full.body.error, "You already have 50 saved drafts. Delete one you no longer need, then save again.");
});

test("the autosave routes keep one slot and never touch a named draft", async () => {
  const { call } = await startApi();
  const named = (await call("", { method: "POST", body: { name: "Kept", content: rich() } })).body.draft;
  assert.deepEqual((await call("/unsaved")).body, { unsaved: null });
  const put = await call("/unsaved", { method: "PUT", body: { content: rich({ selections: { level: 100 } }), basedOn: named.id } });
  assert.equal(put.status, 200);
  assert.equal(put.body.unsaved.basedOn, named.id);
  const listed = (await call("")).body;
  assert.equal(listed.drafts.length, 1);
  assert.equal(listed.unsaved.basedOn, named.id);
  assert.deepEqual(listed.unsaved.products, ["copilot-studio", "sharepoint-ai"]);
  assert.equal((await call(`/${named.id}`)).body.draft.content.selections.level, 200);
  assert.equal((await call("/unsaved", { method: "PUT", body: { content: { selections: { products: [] } } } })).status, 400);
  assert.deepEqual((await call("/unsaved", { method: "DELETE" })).body, { discarded: true });
  assert.deepEqual((await call("/unsaved")).body, { unsaved: null });
});

test("one person's drafts are never listed, read, changed, or deleted for another", async () => {
  const { call } = await startApi({ authEnabled: true });
  const mine = (await call("", { method: "POST", user: "alice", body: { name: "Alice's draft", content: rich() } })).body.draft;
  await call("/unsaved", { method: "PUT", user: "alice", body: { content: rich() } });

  assert.equal((await call("")).status, 401, "sign-in on and nobody signed in");
  assert.equal((await call("")).body.error, "Sign in to use saved drafts.");
  const bobList = (await call("", { user: "bob" })).body;
  assert.deepEqual(bobList, { drafts: [], limit: 50, unsaved: null });
  assert.equal((await call(`/${mine.id}`, { user: "bob" })).status, 404);
  assert.equal((await call(`/${mine.id}`, { method: "PUT", user: "bob", body: { name: "Hijacked" } })).status, 404);
  assert.equal((await call(`/${mine.id}/duplicate`, { method: "POST", user: "bob" })).status, 404);
  assert.equal((await call(`/${mine.id}`, { method: "DELETE", user: "bob" })).status, 404);
  assert.equal((await call("/unsaved", { user: "bob" })).body.unsaved, null);
  const aliceList = (await call("", { user: "alice" })).body;
  assert.deepEqual(aliceList.drafts.map((d) => d.name), ["Alice's draft"]);
  assert.ok(aliceList.unsaved);
});

test("with sign-in off there is one local space", async () => {
  const { call, store } = await startApi({ authEnabled: false, identity: false });
  await call("", { method: "POST", body: { name: "Local", content: rich() } });
  assert.deepEqual(store.list("local").drafts.map((d) => d.name), ["Local"]);
});

test("two tabs saving at once leave one complete draft, never a mix", async () => {
  const { call, dir } = await startApi();
  const id = (await call("", { method: "POST", body: { name: "Race", content: rich() } })).body.draft.id;
  const variants = Array.from({ length: 12 }, (_, i) => rich({ selections: { customTitle: `Tab ${i}`, features: Array.from({ length: 40 }, (_, j) => `topic-${i}-${j}`) } }));
  const results = await Promise.all(variants.map((content) => call(`/${id}`, { method: "PUT", body: { content } })));
  assert.ok(results.every((r) => r.status === 200));
  const file = path.join(routeDraftsDir(dir), "local", `${id}.json`);
  const stored = JSON.parse(readFileSync(file, "utf8"));
  const title = stored.content.selections.customTitle;
  const n = Number(title.replace("Tab ", ""));
  assert.deepEqual(stored.content.selections.features, variants[n].selections.features, "the title and the topics come from the same save");
  assert.deepEqual(readdirSync(path.dirname(file)).filter((name) => name.includes(".blob-tmp-")), []);
});

test("a body over the limit is turned away before anything is saved", async () => {
  const { call } = await startApi();
  const big = rich({ selections: { excludedSubtopics: Array.from({ length: 5000 }, (_, i) => `learn-${"a".repeat(80)}-${i}`) } });
  const res = await call("", { method: "POST", body: { name: "Too big", content: big } });
  assert.equal(res.status, 413);
  assert.equal(res.body.error, "Request body is too large.");
  assert.deepEqual((await call("")).body.drafts, []);
});
