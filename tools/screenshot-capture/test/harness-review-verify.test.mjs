// Hermetic tests for how a companion picture's harness is judged when it carries no proof: the shape of the final address can only
// CONTRADICT the harness the slot needs (the picture is not saved), the companion's proof always wins, and a picture that came with no
// evidence at all is saved for review with the plain "harness not reported" warning.

import { test } from "node:test";
import assert from "node:assert/strict";

import { harnessUnprovenMessage, verifyImage } from "../image-verify.mjs";
import { harnessReview, wrongHarnessPictureMessage } from "../harness.mjs";
import { makePng } from "./fixtures/png.mjs";

const ENV = "6b988893-6c74-4e65-9d9a-f7f044be1d08";
const AGENT = "0f6c2d9a-3a54-4a64-8c61-5b1d7a2e9c11";
const HOST = "https://copilotstudio.microsoft.com";
const COPILOT_PAGE = `${HOST}/environments/${ENV}/agents/${AGENT}/preview`;
const STANDARD_PAGE = `${HOST}/environments/${ENV}/bots/${AGENT}/overview`;

const WRONG_FOR_STANDARD = "This picture was taken in the Microsoft Copilot harness (Build, Preview, Evaluate, Monitor); this lab needs the Standard (Classic) harness.";

const png = () => makePng({ mode: "ui", seed: 7 });
const evidence = (finalUrl, extra = {}) => ({ version: 2, finalUrl, title: "Copilot Studio", visibleText: ["Overview", "Settings"], redaction: { applied: true, masked: 2, controls: 1, lists: 0, listsMasked: 0 }, signals: { signInVisible: false, accountControl: true }, ...extra });
const companion = (over = {}) => ({ filename: "a.png", requireEvidence: true, requireProof: true, requireRedaction: true, ...over });
const proofOf = (id) => ({ version: 1, id, proof: "landmarks", landmarks: id === "standard" ? ["Overview", "Knowledge", "Topics"] : ["Build", "Preview", "Evaluate", "Monitor"], switched: id === "standard", wanted: id });
const codes = (result) => result.reasons.map((r) => r.code);

test("a Microsoft Copilot agent page address contradicts a Standard slot: the picture fails with the plain sentence and is not saved", () => {
  const result = verifyImage(png(), companion({ evidence: evidence(COPILOT_PAGE), expectHarness: "standard" }));
  assert.equal(result.level, "fail");
  assert.equal(result.ok, false);
  const reason = result.reasons.find((r) => r.code === "wrong-harness");
  assert.equal(reason.level, "fail");
  assert.equal(reason.message, WRONG_FOR_STANDARD);
  assert.equal(reason.message, wrongHarnessPictureMessage("microsoft-copilot", "standard"));
  assert.ok(!codes(result).includes("harness-unproven"), "it is judged wrong, not merely unproven");
  // Either Copilot Studio host, and the page without a tab, name the same shape.
  const preview = verifyImage(png(), companion({ evidence: evidence("https://copilotstudio.preview.microsoft.com/environments/" + ENV + "/agents/" + AGENT), expectHarness: "standard" }));
  assert.equal(preview.reasons.find((r) => r.code === "wrong-harness").message, WRONG_FOR_STANDARD);
  // The other way round: a Standard agent page for a Microsoft Copilot slot.
  const reverse = verifyImage(png(), companion({ evidence: evidence(STANDARD_PAGE), expectHarness: "microsoft-copilot" }));
  assert.equal(reverse.level, "fail");
  assert.equal(reverse.reasons.find((r) => r.code === "wrong-harness").message, wrongHarnessPictureMessage("standard", "microsoft-copilot"));
});

test("with no proof and an address that fits the slot, the picture is saved for review as harness-unproven and the message says the address fits", () => {
  const standard = verifyImage(png(), companion({ evidence: evidence(STANDARD_PAGE), expectHarness: "standard" }));
  assert.equal(standard.level, "warn");
  const reason = standard.reasons.find((r) => r.code === "harness-unproven");
  assert.equal(reason.level, "warn");
  assert.match(reason.message, /did not prove which harness/);
  assert.match(reason.message, /1\.8\.1/);
  assert.match(reason.message, /address fits the Standard \(Classic\) harness, but an address alone does not prove it/);
  const copilot = verifyImage(png(), companion({ evidence: evidence(COPILOT_PAGE), expectHarness: "microsoft-copilot" }));
  assert.ok(codes(copilot).includes("harness-unproven") && !codes(copilot).includes("wrong-harness"));
  // A Customer Conversation agent has the same address shape as a Microsoft Copilot one, so it is never judged wrong by it.
  const customer = verifyImage(png(), companion({ evidence: evidence(COPILOT_PAGE), expectHarness: "customer-conversation" }));
  assert.ok(codes(customer).includes("harness-unproven") && !codes(customer).includes("wrong-harness"));
  // An address with no agent in it (Home, the Agents list) says nothing: the existing wording stands, with no word about the address.
  const home = verifyImage(png(), companion({ evidence: evidence(`${HOST}/environments/${ENV}/home`), expectHarness: "standard" }));
  const homeReason = home.reasons.find((r) => r.code === "harness-unproven");
  assert.ok(homeReason && !/address fits/.test(homeReason.message));
});

test("the companion's proof wins over the address, in both directions", () => {
  // Proof says Standard, the address looks like the Microsoft Copilot shape: the proof is what the companion read from the page.
  const proven = verifyImage(png(), companion({ evidence: evidence(COPILOT_PAGE, { harness: proofOf("standard") }), expectHarness: "standard" }));
  assert.ok(proven.ok, "the proof says the slot's harness, so nothing about the harness fails it");
  assert.ok(!codes(proven).some((code) => /harness/.test(code)));
  // Proof says the other harness while the address fits the slot: still wrong, with the existing proof sentence.
  const wrong = verifyImage(png(), companion({ evidence: evidence(STANDARD_PAGE, { harness: proofOf("microsoft-copilot") }), expectHarness: "standard" }));
  assert.equal(wrong.level, "fail");
  assert.equal(wrong.reasons.find((r) => r.code === "wrong-harness").message, "This picture was taken in the Microsoft Copilot harness, but this screenshot needs the Standard (Classic) harness, so it was not saved.");
});

test("a picture that came with no evidence at all also carries the harness-unproven warning", () => {
  const none = verifyImage(png(), companion({ evidence: null, expectHarness: "standard" }));
  assert.equal(none.level, "warn");
  assert.deepEqual(codes(none), ["no-evidence", "harness-unproven"]);
  const reason = none.reasons.find((r) => r.code === "harness-unproven");
  assert.equal(reason.level, "warn");
  assert.equal(reason.message, "The companion did not report which harness this picture shows, so it is saved for review. Check that it shows the Standard (Classic) harness before you accept it.");
  assert.equal(reason.message, harnessUnprovenMessage({ wanted: "standard", noEvidence: true }));
  // Nothing changes for a slot with no harness, for a picture that is not a companion's, or for one that does not need evidence.
  assert.deepEqual(codes(verifyImage(png(), companion({ evidence: null }))), ["no-evidence"]);
  assert.deepEqual(codes(verifyImage(png(), { filename: "a.png", evidence: null, expectHarness: "standard" })), []);
  assert.deepEqual(codes(verifyImage(png(), { filename: "a.png", evidence: null, requireEvidence: true, expectHarness: "standard" })), ["no-evidence"]);
});

test("a manual upload is never judged by the address, and a slot that needs no harness is not either", () => {
  assert.ok(!codes(verifyImage(png(), { filename: "a.png", evidence: evidence(COPILOT_PAGE), expectHarness: "standard" })).includes("wrong-harness"));
  assert.ok(!codes(verifyImage(png(), companion({ evidence: evidence(COPILOT_PAGE) }))).includes("wrong-harness"));
  assert.ok(!codes(verifyImage(png(), companion({ evidence: evidence(COPILOT_PAGE), expectHarness: "either" }))).includes("wrong-harness"));
});

test("harnessReview and the unproven sentence agree with what verifyImage says", () => {
  const review = harnessReview({ slotHarness: "standard", proof: null, finalUrl: COPILOT_PAGE });
  assert.deepEqual([review.code, review.found, review.source, review.message], ["wrong-harness", "microsoft-copilot", "address", WRONG_FOR_STANDARD]);
  assert.equal(harnessUnprovenMessage({ wanted: "standard", addressAgrees: true }).includes("address fits the Standard (Classic) harness"), true);
  assert.doesNotMatch(harnessUnprovenMessage({ wanted: "standard" }), /address fits/);
  for (const text of [WRONG_FOR_STANDARD, harnessUnprovenMessage({ wanted: "standard", noEvidence: true }), harnessUnprovenMessage({ wanted: "standard", addressAgrees: true })]) {
    assert.doesNotMatch(text, /[^\x20-\x7e]/, "plain text, no emoji");
  }
});
