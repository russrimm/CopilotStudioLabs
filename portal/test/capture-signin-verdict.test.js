// What the portal keeps about a sign-in that did not stick: bounded sentences and known ids, never an address or an account.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cleanSignIn, createJobStore } from "../lib/capture/jobs.js";

const good = {
  product: "copilot-studio",
  code: "ping-pong",
  aadsts: "AADSTS50196",
  summary: "The browser went back and forth between the product and the Microsoft sign-in page 4 times.",
  nextStep: "Use a local folder.",
  checks: [{ id: "synced-profile", level: "likely", title: "The sign-in files are in a synced folder", fix: "Use a local folder." }],
};

test("a sign-in verdict keeps sentences and known ids and drops addresses, accounts, and unknown shapes", () => {
  assert.deepEqual(cleanSignIn(good), good);
  assert.equal(cleanSignIn(null), null);
  assert.equal(cleanSignIn([]), null);
  assert.equal(cleanSignIn({ summary: "", nextStep: "" }), null, "nothing to say, nothing kept");

  const messy = cleanSignIn({
    product: "../x",
    code: "Not A Code!",
    aadsts: "AADSTS1",
    summary: `Sign-in failed for ada@contoso.com at https://login.microsoftonline.com/common/oauth2/authorize?code=SECRET ${"x".repeat(900)}`,
    nextStep: "Go to https://example.com/?token=SECRET and sign in.",
    checks: [{ id: "made-up", level: "very", title: "ok", fix: "ada@contoso.com" }, { id: "mfa", title: "" }, ...Array.from({ length: 20 }, (_, i) => ({ id: "mfa", title: `t${i}`, fix: "f" }))],
  });
  assert.equal(messy.product, "");
  assert.equal(messy.code, "sign-in");
  assert.equal(messy.aadsts, null);
  assert.ok(messy.summary.length <= 400);
  const text = JSON.stringify(messy);
  for (const secret of ["ada@", "contoso.com", "https://", "SECRET", "example.com"]) assert.ok(!text.includes(secret), `${secret} is dropped`);
  assert.equal(messy.checks.length, 8, "at most eight checks");
  assert.deepEqual(messy.checks[0], { id: "other", level: "possible", title: "ok", fix: "" });
});

test("completing a job stores the verdict only when something failed, and only in its clean form", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "signin-verdict-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let clock = 1_700_000_000_000;
  const store = createJobStore({ dir, now: () => clock, productLabel: () => "Microsoft Copilot Studio" });
  const device = { id: "dev_aaaaaaaaaaaa", name: "PC" };
  const spec = { target: { type: "lab", labId: "lab-a" }, scope: { mode: "all", filenames: [], featureIds: [] }, options: {}, plan: { shots: [{ filename: "a.png", product: "copilot-studio", steps: [] }, { filename: "b.png", product: "copilot-studio", steps: [] }] } };

  const failing = store.create(spec);
  store.claimNext(device);
  for (const name of ["a.png", "b.png"]) store.reportProgress(failing.id, device.id, { shot: { filename: name, status: "auth-required", error: "Sign in." } });
  const done = store.complete(failing.id, device.id, { message: "0 captured", signIn: { ...good, summary: `${good.summary} ada@contoso.com https://x.test/?q=1` } }).job;
  assert.equal(done.status, "failed");
  assert.equal(done.result.signIn.code, "ping-pong");
  assert.equal(done.result.signIn.aadsts, "AADSTS50196");
  assert.ok(!/ada@|https:/.test(JSON.stringify(done.result.signIn)));
  assert.deepEqual(store.get(failing.id).result.signIn.checks.map((c) => c.id), ["synced-profile"], "it is persisted");

  clock += 1000;
  const fine = store.create(spec);
  store.claimNext(device);
  for (const name of ["a.png", "b.png"]) store.recordShotResult(fine.id, device.id, name, { status: "captured" });
  const ok = store.complete(fine.id, device.id, { signIn: good }).job;
  assert.equal(ok.result.signIn, undefined, "a job that captured everything has no sign-in story");
});
