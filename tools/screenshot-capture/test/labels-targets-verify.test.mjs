// Hermetic tests for the shared text and address rules: label cleaning and fuzzy matching, the capture settings
// model, Copilot Studio addresses, landing checks in plain language, and the redesigned image verification.

import { test } from "node:test";
import assert from "node:assert/strict";

import { cleanExpectedLabel, cleanExpectedLabels, labelIsVisible, visibleWordSet, wordsMatch } from "../labels.mjs";
import { causeForVerification } from "../causes.mjs";
import { scoreLabels, verifyImage } from "../image-verify.mjs";
import {
  COPILOT_STUDIO_SCREENS,
  REQUIREMENTS,
  assessLanding,
  copilotStudioScreenUrl,
  describePage,
  effectiveModeFor,
  maskedPath,
  missingRequirements,
  parseCopilotStudioAddress,
  requirementMet,
  targetEnvFromValues,
  targetTextFromValues,
  targetValuesFromJob,
  validateTargetValue,
  validateTargets,
} from "../targets.mjs";
import { makePng } from "./fixtures/png.mjs";

const ENV = "6b988893-6c74-4e65-9d9a-f7f044be1d08";
const BOT = "0f6c2d9a-3a54-4a64-8c61-5b1d7a2e9c11";
const base = `https://copilotstudio.microsoft.com/environments/${ENV}`;

// ── Labels ───────────────────────────────────────────────────────────────────

test("expected labels are cleaned at their source: typos fixed, junk dropped, duplicates merged", () => {
  assert.equal(cleanExpectedLabel("Start building form scratch"), "Start building from scratch", "the typo from the Learn text is corrected");
  assert.equal(cleanExpectedLabel("**Generative AI**"), "Generative AI");
  assert.equal(cleanExpectedLabel("healthcare_feedback"), "healthcare_feedback", "an underscore inside a name is kept");
  for (const junk of ["", "the", "Save", "Yes", "…", "<agent name>", "{x}", "12", "a", "This is a whole sentence that goes on and on and on about nothing at all"]) {
    assert.equal(cleanExpectedLabel(junk), null, `"${junk}" is not a usable label`);
  }
  assert.deepEqual(cleanExpectedLabels(["Overview", "overview", "OVERVIEW!", "Instructions", "Submit", "the"]), ["Overview", "Instructions"]);
});

test("a label counts as visible through case, punctuation, plurals, and a one-letter typo", () => {
  const words = visibleWordSet(["Start building from scratch", "Knowledge sources", "Settings > Generative AI"]);
  assert.equal(labelIsVisible("start building form scratch", words), true, "a swapped pair of letters");
  assert.equal(labelIsVisible("Knowledge source", words), true, "a plural");
  assert.equal(labelIsVisible("generative ai", words), true);
  assert.equal(labelIsVisible("Publish", words), false);
  assert.equal(wordsMatch("form", "from"), true);
  assert.equal(wordsMatch("scratch", "scratsh"), true);
  assert.equal(wordsMatch("tab", "tabs"), false, "words under four letters are never fuzzy");
  assert.equal(wordsMatch("knowledge", "knowledges"), true);
  assert.equal(wordsMatch("settings", "security"), false);
});

test("scoreLabels uses the fuzzy match and ignores unusable expected labels", () => {
  const score = scoreLabels(["Overview", "Instructions", "start building form scratch", "Save", "the"], ["Overview", "Instructions", "Start building from scratch"]);
  assert.deepEqual([score.expected, score.matched, score.score], [3, 3, 1]);
  assert.equal(scoreLabels(["Save"], ["anything"]), null, "nothing usable to check");
});

// ── Capture settings ─────────────────────────────────────────────────────────

test("capture settings: https only, no credentials, the right product, and an agent address must point at an agent", () => {
  assert.deepEqual(validateTargetValue("sharepointSiteUrl", "https://contoso.sharepoint.com/sites/training#top"), { ok: true, value: "https://contoso.sharepoint.com/sites/training" });
  assert.equal(validateTargetValue("sharepointSiteUrl", "").value, "", "empty clears a setting");
  for (const bad of ["http://contoso.sharepoint.com/sites/x", "javascript:alert(1)", "ftp://x.example.com/a", "https://user:pass@contoso.sharepoint.com/", "contoso", "not a url"]) {
    assert.equal(validateTargetValue("sharepointSiteUrl", bad).ok, false, bad);
  }
  assert.equal(validateTargetValue("copilotStudioUrl", "https://evil.example.com/environments/x/home").ok, false, "must be Copilot Studio");
  assert.equal(validateTargetValue("copilotStudioAgentUrl", `${base}/home`).ok, false, "an environment address is not an agent");
  assert.match(validateTargetValue("copilotStudioAgentUrl", `${base}/home`).error, /does not point at an agent/);
  assert.equal(validateTargetValue("copilotStudioAgentUrl", `${base}/bots/${BOT}/overview?x=1`).value, `${base}/bots/${BOT}/overview?x=1`);
  assert.equal(validateTargetValue("copilotStudioAgentName", "  My   agent ").value, "My agent");
  assert.equal(validateTargetValue("copilotStudioAgentName", "<b>x</b>").ok, false);
  assert.equal(validateTargetValue("copilotStudioAgentName", "x".repeat(81)).ok, false);
  assert.equal(validateTargetValue("nope", "x").ok, false);
  const many = validateTargets({ sharepointSiteUrl: "http://x.example.com", foundryProjectUrl: "https://ai.azure.com/p", unknown: "x" });
  assert.equal(many.ok, false);
  assert.deepEqual(Object.keys(many.errors), ["sharepointSiteUrl"]);
  assert.deepEqual(many.values, { foundryProjectUrl: "https://ai.azure.com/p" });
});

test("addresses travel as CAPTURE_* variables and names as job settings, and come back together", () => {
  const values = { copilotStudioAgentUrl: `${base}/bots/${BOT}/overview`, copilotStudioAgentName: "My agent", sharepointSiteUrl: "https://contoso.sharepoint.com/sites/t" };
  assert.deepEqual(targetEnvFromValues(values), { CAPTURE_COPILOT_STUDIO_AGENT_URL: values.copilotStudioAgentUrl, CAPTURE_SHAREPOINT_SITE_URL: values.sharepointSiteUrl });
  assert.deepEqual(targetTextFromValues(values), { copilotStudioAgentName: "My agent" });
  assert.deepEqual(targetValuesFromJob(targetEnvFromValues(values), targetTextFromValues(values)), values);
});

test("a requirement is met by any of its settings, and by the old start address when it points at an agent", () => {
  assert.equal(requirementMet("copilot-studio-agent", {}), false);
  assert.equal(requirementMet("copilot-studio-agent", { copilotStudioAgentName: "A" }), true);
  assert.equal(requirementMet("copilot-studio-agent", { copilotStudioAgentUrl: `${base}/bots/${BOT}/overview` }), true);
  assert.equal(requirementMet("copilot-studio-agent", { copilotStudioUrl: `${base}/bots/${BOT}/overview` }), true, "the old start-address variable still works");
  assert.equal(requirementMet("copilot-studio-agent", { copilotStudioUrl: `${base}/home` }), false);
  assert.deepEqual(missingRequirements(["sharepoint-site", "copilot-studio-agent", "sharepoint-site"], { copilotStudioAgentName: "A" }), ["sharepoint-site"]);
  assert.ok(Object.values(REQUIREMENTS).every((r) => r.fields.length && r.cause && r.prompt));
});

// ── Addresses and screens ────────────────────────────────────────────────────

test("Copilot Studio addresses are taken apart, and the agents list is not mistaken for an agent", () => {
  const agent = parseCopilotStudioAddress(`${base}/bots/${BOT}/settings?x=1#y`);
  assert.deepEqual([agent.envId, agent.botId, agent.section, agent.agentBase, agent.envBase], [ENV, BOT, "settings", `${base}/bots/${BOT}`, base]);
  const list = parseCopilotStudioAddress(`${base}/agents`);
  assert.deepEqual([list.botId, list.area], [null, "agents"]);
  assert.equal(parseCopilotStudioAddress(`${base}/agents/${BOT}/overview`).botId, BOT, "an agents/<id> address is an agent");
  assert.equal(parseCopilotStudioAddress("https://example.com/environments/x/bots/y").ok, false);
  assert.equal(parseCopilotStudioAddress("http://copilotstudio.microsoft.com/environments/x").ok, false);
  assert.equal(copilotStudioScreenUrl("settings", { agentBase: `${base}/bots/${BOT}` }), `${base}/bots/${BOT}/settings`);
  assert.equal(copilotStudioScreenUrl("settings", { envBase: base }), null, "an agent screen needs an agent");
  assert.equal(copilotStudioScreenUrl("home", { envBase: base }), `${base}/home`);
});

test("the landing check says plainly what was captured and what was expected", () => {
  const expectInstructions = { family: "copilot-studio", scope: "agent", paths: ["overview"], label: "the agent's Overview page", strict: true };
  assert.equal(assessLanding(`${base}/bots/${BOT}/overview`, expectInstructions).state, "match");
  const home = assessLanding(`${base}/home`, expectInstructions);
  assert.deepEqual([home.state, home.page, home.expected], ["mismatch", "the Copilot Studio home page", "the agent's Overview page"]);
  assert.equal(assessLanding(`${base}/agents`, expectInstructions).page, "the list of agents");
  assert.equal(assessLanding(`${base}/apps/new`, expectInstructions).page, "a page for creating an app");
  assert.equal(assessLanding(`${base}/bots/${BOT}/actions`, expectInstructions).page, "the agent's Tools page");
  assert.equal(assessLanding(`${base}/bots/${BOT}/actions`, { ...expectInstructions, paths: ["actions", "tools"] }).state, "match", "both address spellings of Tools count");
  const evaluation = { ...expectInstructions, paths: COPILOT_STUDIO_SCREENS.evaluations.paths, label: "the agent's Evaluation page" };
  assert.equal(assessLanding(`${base}/agents/${BOT}/evaluate`, evaluation).state, "match", "the newer layout's Evaluate tab is the Evaluation screen");
  assert.equal(describePage(`${base}/agents/${BOT}/evaluate`), "the agent's Evaluation page");
  assert.equal(assessLanding("https://login.microsoftonline.com/common/oauth2/authorize", expectInstructions).page, "a Microsoft sign-in page");
  assert.equal(assessLanding(`${base}/home`, { family: "copilot-studio", scope: "environment", paths: ["home"], label: "x" }).state, "match");
  assert.equal(assessLanding(`${base}/bots/${BOT}/home`, { family: "copilot-studio", scope: "environment", paths: ["home"], label: "x" }).state, "mismatch");
  assert.equal(assessLanding(`${base}/apps/new`, { ...expectInstructions, strict: false }).state, "match", "a person who sets a screen up may be anywhere in the product");
  assert.equal(assessLanding("https://other.example.com/", { ...expectInstructions, strict: false }).state, "mismatch");
  assert.equal(assessLanding("https://admin.microsoft.com/x", { family: "url", host: "admin.microsoft.com", label: "y" }).state, "match");
  assert.equal(assessLanding("https://contoso.sharepoint.com/x", { family: "url", host: "admin.microsoft.com", label: "y" }).state, "mismatch");
  assert.equal(assessLanding("https://x.example.com/", null).state, "unknown");
  assert.equal(maskedPath(`${base}/bots/${BOT}/settings?token=1`), "copilotstudio.microsoft.com/environments/{id}/bots/{id}/settings");
  assert.doesNotMatch(describePage(`${base}/something/else`), /6b988893/, "ids never reach a sentence");
});

test("how a shot runs in each job mode", () => {
  const auto = { capture: { version: 1, mode: "auto" } };
  const guided = { capture: { version: 1, mode: "guided" } };
  assert.deepEqual(["auto", "guided", "smart"].map((m) => effectiveModeFor(auto, m)), ["auto", "guided", "auto"]);
  assert.deepEqual(["auto", "guided", "smart"].map((m) => effectiveModeFor(guided, m)), ["needs-you", "guided", "guided"]);
  assert.equal(effectiveModeFor({ capture: { version: 1, mode: "manual" } }, "smart"), "manual");
  assert.equal(effectiveModeFor({ manual: true }, "auto"), "manual");
  assert.equal(effectiveModeFor({}, "smart"), "legacy", "a plan from an older portal runs as before");
});

// ── Verification ─────────────────────────────────────────────────────────────

const png = () => makePng({ mode: "ui", width: 640, height: 400 });
const evidence = (finalUrl, visibleText = ["Overview"]) => ({ finalUrl, title: "App", visibleText, redaction: { applied: true, masked: 0 }, capturedAt: "2026-01-01T00:00:00Z", executedSteps: 2 });
const expectOverview = { family: "copilot-studio", scope: "agent", paths: ["overview"], label: "the agent's Overview page", strict: true };

test("verification: the address is the main signal, and labels are only a hint when it matches", () => {
  const right = verifyImage(png(), { filename: "a.png", evidence: evidence(`${base}/bots/${BOT}/overview`, ["Something else entirely"]), expectedLabels: ["Overview", "Instructions", "Publish"], expect: expectOverview, requireEvidence: true });
  assert.equal(right.level, "pass", "no labels visible, but the address is right: accepted");
  assert.equal(right.landing.state, "match");
  assert.equal(right.labels.soft, true);

  const wrong = verifyImage(png(), { filename: "a.png", evidence: evidence(`${base}/home`, ["Overview", "Instructions", "Publish"]), expectedLabels: ["Overview", "Instructions", "Publish"], expect: expectOverview, requireEvidence: true });
  assert.equal(wrong.level, "warn", "every label is visible, but it is the wrong page: never accepted");
  assert.equal(wrong.reasons[0].code, "wrong-screen");
  assert.match(wrong.reasons[0].message, /^This is the Copilot Studio home page, not the agent's Overview page\./);
  assert.ok(!wrong.reasons.some((r) => r.code === "labels-missing"), "one clear sentence, not two");

  const unknown = verifyImage(png(), { filename: "a.png", evidence: evidence("https://x.example.com/a", ["Nothing"]), expectedLabels: ["Overview", "Instructions", "Publish"], requireEvidence: true });
  assert.equal(unknown.reasons[0].code, "labels-missing", "with no expectation the labels still decide");
  assert.match(unknown.reasons[0].message, /missing: Overview, Instructions, Publish/);
});

test("verification still rejects sign-in pages and blank pictures, whatever the address expects", () => {
  const signIn = verifyImage(png(), { filename: "a.png", evidence: evidence("https://login.microsoftonline.com/common/oauth2/authorize"), expect: expectOverview, requireEvidence: true });
  assert.equal(signIn.level, "fail");
  assert.ok(signIn.reasons.some((r) => r.code === "sign-in-page"));
  assert.ok(!signIn.reasons.some((r) => r.code === "wrong-screen"), "sign-in is the more useful message");
  const blank = verifyImage(makePng({ mode: "blank", width: 640, height: 400 }), { filename: "a.png", evidence: evidence(`${base}/bots/${BOT}/overview`), expect: expectOverview, requireEvidence: true });
  assert.equal(blank.level, "fail");
  assert.equal(blank.reasons[0].code, "blank");
  const mostly = verifyImage(makePng({ mode: "mostly" }), { filename: "a.png", evidence: evidence(`${base}/bots/${BOT}/overview`), expect: expectOverview, requireEvidence: true });
  assert.ok(mostly.reasons.some((r) => r.code === "near-uniform"));
  assert.equal(verifyImage(Buffer.from("not an image".repeat(900)), { filename: "a.png" }).reasons[0].code, "bad-signature");
});

test("verification of a guided capture only needs to be in the product, and evidence carries a bounded route", () => {
  const guided = verifyImage(png(), { filename: "a.png", evidence: { ...evidence(`${base}/apps/new`), mode: "guided", routeSteps: [{ action: "open", label: "x".repeat(300), ok: true, urlAfter: "host/path?token=SECRET" }] }, expect: { ...expectOverview, strict: false }, requireEvidence: true });
  assert.equal(guided.level, "pass");
  assert.equal(guided.evidence.mode, "guided");
  assert.equal(guided.evidence.routeSteps[0].label.length, 80, "a long label is cut");
  assert.ok(!JSON.stringify(guided.evidence.routeSteps).includes("SECRET"), "query strings never reach the record");
});

// ── A capture must prove its screen ──────────────────────────────────────────

const proof = (over = {}) => ({ filename: "a.png", requireEvidence: true, requireProof: true, requireRedaction: true, ...over });
const current = (finalUrl, visibleText, extra = {}) => ({ version: 2, ...evidence(finalUrl, visibleText), redaction: { applied: true, masked: 2, controls: 1, lists: 0, listsMasked: 0 }, signals: { signInVisible: false, accountControl: true }, ...extra });

test("proof: a missing landmark is Needs review even when the address matches, and one that shows is accepted", () => {
  const wanted = ["Overview", "Instructions", "Publish"];
  const lacking = verifyImage(png(), proof({ evidence: current(`${base}/bots/${BOT}/overview`, ["Something else entirely"]), expectedLabels: wanted, expect: expectOverview }));
  assert.equal(lacking.level, "warn", "the address names the agent's page but none of its landmarks is visible");
  assert.equal(lacking.reasons[0].code, "labels-missing");
  assert.equal(lacking.labels.soft, false, "labels are no longer only a hint");
  const present = verifyImage(png(), proof({ evidence: current(`${base}/bots/${BOT}/overview`, ["Overview", "Instructions"]), expectedLabels: wanted, expect: expectOverview }));
  assert.equal(present.level, "pass");
  assert.deepEqual(present.reasons, []);
  // The same picture without the proof requirement keeps the old reading, so a hand-checked upload is unchanged.
  assert.equal(verifyImage(png(), { ...proof({ requireProof: false }), evidence: current(`${base}/bots/${BOT}/overview`, ["Something else entirely"]), expectedLabels: wanted, expect: expectOverview }).level, "pass");
  // A person who set the screen up themselves vouches for it.
  assert.equal(verifyImage(png(), proof({ evidence: current(`${base}/bots/${BOT}/overview`, ["Something else entirely"], { mode: "guided" }), expectedLabels: wanted, expect: { ...expectOverview, strict: false } })).level, "pass");
});

test("proof: with no label to match, only an address that names one screen of its own is enough", () => {
  const knowledge = { family: "copilot-studio", scope: "agent", paths: ["knowledge"], label: "the agent's Knowledge page", strict: true };
  const home = { family: "copilot-studio", scope: "environment", paths: ["home"], label: "the Copilot Studio home page", strict: true };
  const byAddress = (url, expect, labels = []) => verifyImage(png(), proof({ evidence: current(url, ["Anything"]), expectedLabels: labels, expect }));
  assert.equal(byAddress(`${base}/bots/${BOT}/knowledge`, knowledge).level, "pass", "a page of its own");
  assert.equal(byAddress(`${base}/home`, home).level, "pass");
  const overview = byAddress(`${base}/bots/${BOT}/overview`, expectOverview);
  assert.equal(overview.level, "warn", "the agent's default page proves nothing: the newer layout keeps its address");
  assert.equal(overview.reasons[0].code, "screen-unproven");
  const product = verifyImage(png(), proof({ evidence: current("https://ai.azure.com/anything", ["Anything"]), expect: { family: "url", host: "ai.azure.com", label: "a page of Microsoft Foundry", strict: true } }));
  assert.equal(product.reasons[0].code, "screen-unproven", "somewhere on the product's host proves no screen");
  assert.match(product.reasons[0].message, /Nothing on the page proves/);
  const none = verifyImage(png(), proof({ evidence: current("https://ai.azure.com/anything", ["Anything"]) }));
  assert.equal(none.reasons[0].code, "screen-unproven", "no landmarks at all and no distinctive route");
});

test("proof: no evidence, or an older companion's evidence, is saved for review with the plain update sentence", () => {
  const update = "Update your Local Capture Companion. Older versions cannot prove the screen, so their pictures are saved for review.";
  const none = verifyImage(png(), proof({ evidence: null }));
  assert.deepEqual([none.level, none.reasons[0].code, none.reasons[0].message], ["warn", "no-evidence", update]);
  const older = verifyImage(png(), proof({ evidence: { ...evidence(`${base}/bots/${BOT}/knowledge`, ["Anything"]), redaction: { applied: true, masked: 2 } }, expect: { family: "copilot-studio", scope: "agent", paths: ["knowledge"], strict: true } }));
  assert.equal(older.level, "warn");
  assert.equal(older.reasons.find((r) => r.code === "old-companion").message, update);
  assert.equal(older.evidence.version, 1);
  assert.equal(verifyImage(png(), { filename: "a.png", evidence: null }).level, "pass", "a picture pasted by hand needs none of this");
});

test("proof: the product's public page (a Sign in button and no account) is refused, and a Sign in button on a signed-in page is not", () => {
  const publicPage = verifyImage(png(), proof({ evidence: current("https://ai.azure.com/home", ["Sign in", "Explore models"], { signals: { signInVisible: true, accountControl: false }, redaction: { applied: true, masked: 0, controls: 0 } }), productLabel: "Microsoft Foundry" }));
  assert.equal(publicPage.level, "fail");
  assert.equal(publicPage.reasons[0].code, "signed-out-page");
  assert.match(publicPage.reasons[0].message, /^You are not signed in to Microsoft Foundry\./);
  // An older companion has no signals, but its labels and its masking count say the same thing.
  const older = verifyImage(png(), proof({ evidence: { ...evidence("https://ai.azure.com/home", ["Sign in", "Explore models"]), redaction: { applied: true, masked: 0 } } }));
  assert.equal(older.reasons[0].code, "signed-out-page");
  // A Sign in button inside a signed-in page (a connection card) has an account beside it.
  const signedIn = verifyImage(png(), proof({ evidence: current("https://make.powerapps.com/home", ["Sign in", "Connections"], { signals: { signInVisible: true, accountControl: true } }) }));
  assert.ok(!signedIn.reasons.some((r) => r.code === "signed-out-page"));
  assert.equal(causeForVerification(publicPage.reasons), "sign-in", "the job pauses with the sign-in cause");
});

test("proof: a list of the person's own items that was not hidden is Needs review", () => {
  const listed = verifyImage(png(), proof({ evidence: current(`${base}/bots/${BOT}/knowledge`, ["Anything"], { redaction: { applied: true, masked: 4, controls: 1, lists: 2, listsMasked: 1 } }), expect: { family: "copilot-studio", scope: "agent", paths: ["knowledge"], strict: true } }));
  assert.equal(listed.level, "warn");
  assert.ok(listed.reasons.some((r) => r.code === "list-not-masked"));
  const hidden = verifyImage(png(), proof({ evidence: current(`${base}/bots/${BOT}/knowledge`, ["Anything"], { redaction: { applied: true, masked: 6, controls: 1, lists: 2, listsMasked: 2 } }), expect: { family: "copilot-studio", scope: "agent", paths: ["knowledge"], strict: true } }));
  assert.equal(hidden.level, "pass");
  const requested = verifyImage(png(), proof({ evidence: current(`${base}/bots/${BOT}/knowledge`, ["Anything"], { redaction: null }), expect: { family: "copilot-studio", scope: "agent", paths: ["knowledge"], strict: true } }));
  assert.ok(requested.reasons.some((r) => r.code === "not-redacted"), "masking was requested and not reported");
});
