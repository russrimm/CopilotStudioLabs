/**
 * Who a draft belongs to when nobody is signed in: each browser's own id (the X-Client-Id header) keeps people's drafts,
 * autosave slot, and write limits apart, and the drafts saved before browsers had ids go to the first browser that asks.
 * The browser id separates people and prevents collisions; these tests also pin down what it does not do (it is not a
 * password: anyone who sends the same id sees the same drafts).
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";

import { createDraftStore, draftsDirFor, LOCAL_OWNER, ownerKeyFor } from "../lib/lab-builder/drafts.js";
import { registerDraftRoutes } from "../lib/lab-builder/drafts-api.js";
import { clientOwnerKey } from "../lib/concurrency/visitor.js";
import { createRateLimiter, positiveIntFromEnv } from "../lib/rate-limit.js";

const cleanups = [];
after(() => {
  for (const clean of cleanups.reverse()) clean();
});

const ANN = "AnnAnnAnnAnnAnnAnnAnn01";
const BEN = "BenBenBenBenBenBenBenBen2";
const CY = "CyCyCyCyCyCyCyCyCyCyCy03";

function content(title) {
  return {
    selections: { products: ["copilot-studio"], industry: "retail", level: 200, harness: "standard", features: ["create-agent"], customTitle: title, useLearnMcp: false, useLlm: false },
    wizard: { step: 3, furthest: 3, chosenSteps: ["product", "tailor", "topics"] },
    labels: {},
  };
}

async function startApi({ authEnabled = false, rateMax, multiplier } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "lb-identity-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const saved = { max: process.env.LAB_BUILDER_DRAFTS_RATE_MAX, multiplier: process.env.LAB_BUILDER_RATE_ADDRESS_MULTIPLIER };
  if (rateMax) process.env.LAB_BUILDER_DRAFTS_RATE_MAX = String(rateMax);
  if (multiplier) process.env.LAB_BUILDER_RATE_ADDRESS_MULTIPLIER = String(multiplier);
  const app = express();
  // Like the portal behind the Container Apps ingress: one trusted hop, so X-Forwarded-For names the visitor.
  app.set("trust proxy", 1);
  app.use("/api/lab-builder/drafts", express.json({ limit: "320kb" }));
  app.use((req, _res, next) => {
    if (req.headers["x-test-user"] === "alice") req.user = { oid: "oid-alice-0001", tid: "tenant-contoso", upn: "alice@contoso.example" };
    next();
  });
  const store = registerDraftRoutes(app, { dataDir: dir, authEnabled, createRateLimiter, positiveIntFromEnv });
  for (const [key, value] of Object.entries({ LAB_BUILDER_DRAFTS_RATE_MAX: saved.max, LAB_BUILDER_RATE_ADDRESS_MULTIPLIER: saved.multiplier })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  cleanups.push(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/lab-builder/drafts`;
  /** One browser: its own id, and (optionally) the address the ingress reports for it. */
  const browser = (clientId, address) => async (suffix = "", { method = "GET", body, headers = {} } = {}) => {
    const res = await fetch(`${base}${suffix}`, {
      method,
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(clientId ? { "X-Client-Id": clientId } : {}), ...(address ? { "X-Forwarded-For": address } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { browser, dir, store: createDraftStore({ dir: draftsDirFor(dir) }) };
}

test("two browsers keep their own drafts and their own autosave slot, and cannot read or change each other's", async () => {
  const { browser } = await startApi();
  const ann = browser(ANN);
  const ben = browser(BEN);

  const made = await ann("", { method: "POST", body: { name: "Ann's retail pilot", content: content("Ann lab") } });
  assert.equal(made.status, 201);
  await ann("/unsaved", { method: "PUT", body: { content: content("Ann autosave") } });
  await ben("/unsaved", { method: "PUT", body: { content: content("Ben autosave") } });

  // The "You have unsaved work from ..." banner reads this slot: each person sees only their own.
  assert.equal((await ann("/unsaved")).body.unsaved.content.selections.customTitle, "Ann autosave");
  assert.equal((await ben("/unsaved")).body.unsaved.content.selections.customTitle, "Ben autosave");
  assert.deepEqual((await ben("")).body.drafts, [], "Ben has no drafts of Ann's");
  assert.equal((await ben("")).body.unsaved.products[0], "copilot-studio");
  assert.equal((await ann("")).body.drafts.length, 1);

  const id = made.body.draft.id;
  assert.equal((await ben(`/${id}`)).status, 404, "Ben cannot open Ann's draft");
  assert.equal((await ben(`/${id}`, { method: "PUT", body: { name: "Hijacked" } })).status, 404);
  assert.equal((await ben(`/${id}`, { method: "DELETE" })).status, 404);
  assert.equal((await ann(`/${id}`)).body.draft.name, "Ann's retail pilot", "Ann's draft is untouched");

  await ann("/unsaved", { method: "DELETE" });
  assert.equal((await ann("/unsaved")).body.unsaved, null);
  assert.equal((await ben("/unsaved")).body.unsaved.content.selections.customTitle, "Ben autosave", "discarding Ann's autosave leaves Ben's");

  // Two tabs of one browser share one space, as they always did.
  const annSecondTab = browser(ANN);
  assert.equal((await annSecondTab("")).body.drafts.length, 1);
});

test("what is saved on disk is named by a hash of the browser id, never the id", async () => {
  const { browser, dir } = await startApi();
  await browser(ANN)("", { method: "POST", body: { name: "One", content: content("x") } });
  const folders = readdirSync(draftsDirFor(dir));
  assert.deepEqual(folders, [clientOwnerKey(ANN)]);
  assert.ok(!folders.some((name) => name.includes(ANN)), "the id is not in a folder name");
  assert.equal(ownerKeyFor(null, { authEnabled: false, clientId: ANN }), clientOwnerKey(ANN));
});

test("a bad id or no id uses the shared local space, and a path-like id never becomes a folder", async () => {
  const { browser, dir } = await startApi();
  for (const id of ["short", "../../outside-folder-aaaaaaaa", "has spaces has spaces 123", ""]) {
    const res = await browser(id)("", { method: "POST", body: { name: `Bad id ${id.length}`, content: content("y") } });
    assert.equal(res.status, 201);
  }
  assert.deepEqual(readdirSync(draftsDirFor(dir)), [LOCAL_OWNER], "all of them landed in `local`");
  assert.equal(existsSync(path.join(dir, "outside-folder-aaaaaaaa")), false);
});

test("with sign-in on, the signed-in person is the owner and a browser id changes nothing; with no identity it is refused", async () => {
  const { browser } = await startApi({ authEnabled: true });
  const signedIn = (clientId) => browser(clientId, undefined);
  const a = await signedIn(ANN)("", { method: "POST", body: { name: "Alice one", content: content("a") }, headers: { "x-test-user": "alice" } });
  assert.equal(a.status, 201);
  const sameAliceOtherBrowser = await signedIn(BEN)("", { headers: { "x-test-user": "alice" } });
  assert.deepEqual(sameAliceOtherBrowser.body.drafts.map((d) => d.name), ["Alice one"], "her drafts follow her, not her browser");
  assert.equal((await signedIn(ANN)("")).status, 401, "a browser id is not a sign-in");
  assert.equal(ownerKeyFor({ oid: "oid-alice-0001", tid: "t" }, { authEnabled: true, clientId: ANN }).startsWith("u-"), true);
});

test("the drafts saved before browsers had ids go to the first browser that asks, once, and every other browser starts empty", async () => {
  const { browser, store, dir } = await startApi();
  // What an older portal left behind: two named drafts and an autosave in the shared local space.
  const one = store.create(LOCAL_OWNER, { name: "Older draft one", content: content("older 1") });
  store.create(LOCAL_OWNER, { name: "Older draft two", content: content("older 2") });
  store.saveUnsaved(LOCAL_OWNER, { content: content("older autosave") });

  const ben = browser(BEN);
  const ann = browser(ANN);
  const first = await ann("");
  assert.deepEqual(first.body.drafts.map((d) => d.name).sort(), ["Older draft one", "Older draft two"]);
  assert.equal(first.body.adoptedDrafts, 3, "the page is told, once, that earlier drafts arrived");
  assert.equal(first.body.unsaved.products[0], "copilot-studio", "the old autosave came too");
  assert.equal((await ann("")).body.adoptedDrafts, undefined, "and not again");

  assert.deepEqual((await ben("")).body.drafts, [], "a second browser finds nothing");
  assert.equal((await ben(`/${one.id}`)).status, 404);
  assert.deepEqual((await browser("")("")).body.drafts, [], "the shared local space is empty now");
  const claim = JSON.parse(readFileSync(path.join(draftsDirFor(dir), LOCAL_OWNER, ".claimed.json"), "utf8"));
  assert.equal(claim.owner, clientOwnerKey(ANN));
  assert.equal(claim.state, "done");

  // A caller with no id that writes to `local` later does not leak to the browser that adopted.
  await browser("")("", { method: "POST", body: { name: "Headerless", content: content("z") } });
  assert.deepEqual((await ann("")).body.drafts.map((d) => d.name).sort(), ["Older draft one", "Older draft two"]);
});

test("two browsers asking at the same instant cannot both adopt: the drafts exist once", async () => {
  const { browser, store, dir } = await startApi();
  for (let i = 0; i < 4; i += 1) store.create(LOCAL_OWNER, { name: `Older ${i}`, content: content(`older ${i}`) });
  const results = await Promise.all([browser(ANN)(""), browser(BEN)(""), browser(CY)("")]);
  const counts = results.map((r) => r.body.drafts.length).sort();
  assert.deepEqual(counts, [0, 0, 4], "exactly one browser got all four");
  const owners = readdirSync(draftsDirFor(dir)).filter((n) => n.startsWith("c-"));
  const withFiles = owners.filter((o) => readdirSync(path.join(draftsDirFor(dir), o)).some((f) => f.startsWith("draft-")));
  assert.equal(withFiles.length, 1);
});

test("a move that stopped half way is finished by the same browser and never given to another", async () => {
  const { browser, store, dir } = await startApi();
  const a = store.create(LOCAL_OWNER, { name: "Half moved A", content: content("a") });
  const b = store.create(LOCAL_OWNER, { name: "Half moved B", content: content("b") });
  // As if a crash happened after the claim was written and one file moved.
  const legacy = path.join(draftsDirFor(dir), LOCAL_OWNER);
  const mine = path.join(draftsDirFor(dir), clientOwnerKey(ANN));
  const fs = await import("node:fs");
  fs.mkdirSync(mine, { recursive: true });
  fs.renameSync(path.join(legacy, `${a.id}.json`), path.join(mine, `${a.id}.json`));
  fs.writeFileSync(path.join(legacy, ".claimed.json"), JSON.stringify({ owner: clientOwnerKey(ANN), state: "moving", at: new Date().toISOString() }));

  assert.deepEqual((await browser(BEN)("")).body.drafts, [], "another browser cannot take what was claimed");
  const finished = await browser(ANN)("");
  assert.deepEqual(finished.body.drafts.map((d) => d.id).sort(), [a.id, b.id].sort(), "the claiming browser gets the rest");
});

test("each browser has its own write limit even from one address, and one address that rotates ids is still capped", async () => {
  const { browser } = await startApi({ rateMax: 3, multiplier: 2 });
  const office = "203.0.113.50";
  const ann = browser(ANN, office);
  const ben = browser(BEN, office);
  const cy = browser(CY, office);
  const write = (who, n) => who("/unsaved", { method: "PUT", body: { content: content(`write ${n}`) } });

  for (let n = 0; n < 3; n += 1) assert.equal((await write(ann, n)).status, 200);
  const limited = await write(ann, 3);
  assert.equal(limited.status, 429, "Ann used up her own limit");
  assert.match(limited.body.error, /Too many draft changes/);
  for (let n = 0; n < 3; n += 1) assert.equal((await write(ben, n)).status, 200, "Ben, at the same address, is not throttled by Ann");
  // The address allows 3 x 2 = 6 writes in all, and 6 were used.
  assert.equal((await write(cy, 0)).status, 429, "a flood from one address is capped even with a fresh id");
  assert.equal((await browser(CY, "203.0.113.99")("/unsaved", { method: "PUT", body: { content: content("elsewhere") } })).status, 200, "another address is unaffected");
  assert.equal((await ann("")).status, 200, "reads are never limited");
});
