// The portal's half of automatic capture: what the person consented to, what a job carries, and what the plan asks the
// computer to do. The rule under test throughout: the computer is only ever sent what the person allowed, a request can
// ask for less and never for more, and the practice environment address never reaches the browser.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCapturePlatform, versionAtLeast, AUTONOMOUS_MIN_COMPANION } from "../lib/capture/index.js";
import { autonomyFor, createConsentStore, describeConsent, validateConsent } from "../lib/capture/consent.js";
import { classifyShot } from "../lib/capture/classify.js";
import { buildSetupPlan, sampleInputsFor } from "../lib/capture/setup-plan.js";
import { createSharedRecipeStore } from "../lib/capture/shared-recipes.js";

const tmp = (prefix) => mkdtempSync(join(tmpdir(), prefix));
const ENV_ID = "Default-00000000-0000-0000-0000-000000000001";
const PRACTICE_URL = `https://copilotstudio.microsoft.com/environments/${ENV_ID}/home`;
const AGENT_URL = `https://copilotstudio.microsoft.com/environments/${ENV_ID}/bots/00000000-0000-0000-0000-0000000000a1/overview`;

function platform(t, extra = {}) {
  const root = tmp("capture-auto-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return createCapturePlatform({ generatedRoot: join(root, "generated"), env: { PORTAL_STORAGE_ROOT: root }, dataDir: root, detectServerBrowser: async () => ({ available: false }), ...extra });
}

const LIBRARY = (extra = {}) => ({ target: { type: "library", products: ["copilot-studio"] }, scope: { mode: "all" }, targets: { copilotStudioAgentUrl: AGENT_URL }, ...extra });

// ── Consent ──────────────────────────────────────────────────────────────────

test("consent needs an explicit yes, a known level, and a Copilot Studio https address for the practice level", () => {
  assert.equal(validateConsent({}).ok, false);
  assert.equal(validateConsent({ consented: "yes" }).ok, false, "only true counts");
  assert.equal(validateConsent({ consented: true, level: "admin" }).field, "level");
  const readOnly = validateConsent({ consented: true });
  assert.deepEqual(readOnly.consent, { version: 1, consented: true, level: "read-only", practiceEnvironmentUrl: "" });
  const missing = validateConsent({ consented: true, level: "practice" });
  assert.equal(missing.ok, false);
  assert.equal(missing.field, "practiceEnvironmentUrl");
  assert.equal(validateConsent({ consented: true, level: "practice", practiceEnvironmentUrl: "http://copilotstudio.microsoft.com/environments/x/home" }).ok, false, "https only");
  assert.equal(validateConsent({ consented: true, level: "practice", practiceEnvironmentUrl: "https://example.com/environments/x/home" }).ok, false, "a Copilot Studio address only");
  const practice = validateConsent({ consented: true, level: "practice", practiceEnvironmentUrl: PRACTICE_URL });
  assert.equal(practice.ok, true);
  assert.equal(practice.consent.practiceEnvironmentUrl, `https://copilotstudio.microsoft.com/environments/${ENV_ID}`, "only the environment is kept, not the page");
  assert.equal(validateConsent({ consented: true, level: "read-only", practiceEnvironmentUrl: PRACTICE_URL }).consent.practiceEnvironmentUrl, "", "a read-only consent keeps no environment");
});

test("a request can ask for less than the consent allows, never for more", (t) => {
  const store = createConsentStore({ dir: tmp("consent-") });
  assert.equal(store.get("default"), null);
  assert.equal(autonomyFor(null, { level: "practice" }), null, "no consent, no autonomy, whatever is asked");
  const readOnly = store.put("default", validateConsent({ consented: true }).consent);
  assert.equal(autonomyFor(readOnly, { level: "practice" }).level, "read-only", "asking for more changes nothing");
  assert.equal(autonomyFor(readOnly, { level: "practice" }).practiceEnvironmentUrl, "");
  const practice = store.put("default", validateConsent({ consented: true, level: "practice", practiceEnvironmentUrl: PRACTICE_URL }).consent);
  assert.equal(autonomyFor(practice).level, "practice");
  assert.equal(autonomyFor(practice, { level: "read-only" }).level, "read-only", "a request can lower it");
  assert.equal(autonomyFor(practice, { level: "read-only" }).practiceEnvironmentUrl, "");
  assert.equal(store.revoke("default"), true);
  assert.equal(store.get("default"), null);
  assert.equal(store.revoke("default"), false);
  store.put("../etc/passwd", practice);
  assert.ok(store.get("default"), "an unsafe key is filed under the default profile, never a path");

  const shown = describeConsent(practice);
  assert.ok(shown.rules.tiers.length === 4 && shown.rules.never.length >= 8, "the card shows the four tiers and what is never done");
  assert.ok(!JSON.stringify(shown.rules).includes("practiceEnvironmentUrl"));
});

// ── What a job carries ───────────────────────────────────────────────────────

test("an automatic job needs consent, and without a stated mode the older smart mode is kept", (t) => {
  const p = platform(t);
  const refused = p.queueJob(LIBRARY({ options: { mode: "autonomous" } }));
  assert.equal(refused.status, 200);
  assert.equal(refused.body.needsConsent, true, "nothing is queued without consent");
  assert.equal(refused.body.job, null);
  assert.equal(p.jobs.list().length, 0);

  const smart = p.queueJob(LIBRARY());
  assert.equal(smart.status, 201);
  assert.equal(smart.body.mode, "smart", "an older client that names no mode still gets the older behavior");
  assert.equal(smart.body.job.options.autonomy, null);

  assert.equal(p.saveConsent({ consented: true }).status, 200);
  const automatic = p.queueJob(LIBRARY({ targets: { copilotStudioAgentUrl: AGENT_URL, copilotStudioName: undefined } }));
  assert.equal(automatic.status, 201);
  assert.equal(automatic.body.mode, "autonomous", "after consent the default is automatic");
  assert.equal(automatic.body.autonomy.level, "read-only");
});

test("a request cannot raise the level, the practice address never reaches the browser, and practice steps are sent only with consent", (t) => {
  const p = platform(t);
  p.saveConsent({ consented: true });
  const readOnly = p.queueJob(LIBRARY({ options: { mode: "autonomous", autonomy: { level: "practice", practiceEnvironmentUrl: PRACTICE_URL } } }));
  assert.equal(readOnly.body.job.options.autonomy.level, "read-only");
  const readOnlyPlan = p.jobs.getPlan(readOnly.body.job.id);
  assert.equal(readOnlyPlan.autonomy.practiceEnvironmentUrl, "", "no practice environment without consent");
  assert.ok(readOnlyPlan.shots.every((s) => !(s.capture?.setup?.steps || []).some((step) => step.tier >= 2 || step.practiceOnly)), "no Tier 2 step is in a read-only plan");
  p.jobs.cancel(readOnly.body.job.id);

  assert.equal(p.saveConsent({ consented: true, level: "practice", practiceEnvironmentUrl: PRACTICE_URL }).status, 200);
  const practice = p.queueJob(LIBRARY({ options: { mode: "autonomous" } }));
  assert.equal(practice.body.job.options.autonomy.level, "practice");
  const text = JSON.stringify(practice.body);
  assert.ok(!text.includes(ENV_ID), "the practice environment is not in what the browser reads");
  assert.ok(!JSON.stringify(p.jobs.get(practice.body.job.id)).includes(ENV_ID));
  assert.equal(p.jobs.getPlan(practice.body.job.id).autonomy.practiceEnvironmentUrl, `https://copilotstudio.microsoft.com/environments/${ENV_ID}`, "only the plan the companion fetches has it");
  const practicePlan = p.jobs.getPlan(practice.body.job.id);
  assert.ok(practicePlan.shots.some((s) => (s.capture?.setup?.steps || []).some((step) => step.practiceOnly || step.tier >= 2)), "the practice plan carries the steps that need the practice agent");
  p.jobs.cancel(practice.body.job.id);

  p.revokeConsent();
  assert.equal(p.queueJob(LIBRARY({ options: { mode: "autonomous" } })).body.needsConsent, true, "revoking takes effect at once");
});

test("a companion older than the first automatic version is given the smart mode with a plain message", (t) => {
  assert.equal(versionAtLeast("1.4.0", AUTONOMOUS_MIN_COMPANION), true);
  assert.equal(versionAtLeast("1.3.9", AUTONOMOUS_MIN_COMPANION), false);
  assert.equal(versionAtLeast("2.0.0", AUTONOMOUS_MIN_COMPANION), true);
  assert.equal(versionAtLeast(null, AUTONOMOUS_MIN_COMPANION), false, "an unknown version is not trusted");
  assert.equal(versionAtLeast("garbage", AUTONOMOUS_MIN_COMPANION), false);

  const p = platform(t);
  p.saveConsent({ consented: true });
  const code = p.pairing.createCode({ createdBy: "test" });
  const paired = p.pairing.exchangeCode(code.code, { deviceName: "OLD-PC", companionVersion: "1.1.0" });
  p.pairing.heartbeat(paired.device.id, { companionVersion: "1.1.0" });
  const old = p.queueJob(LIBRARY({ options: { mode: "autonomous" } }));
  assert.equal(old.status, 201);
  assert.equal(old.body.mode, "smart");
  assert.equal(old.body.downgraded.needs, AUTONOMOUS_MIN_COMPANION);
  assert.match(old.body.downgraded.message, /older than 1\.4\.0.*Download the companion again/);
  assert.equal(old.body.job.options.autonomy, null, "an old companion is never sent an autonomy it would not understand");
  p.jobs.cancel(old.body.job.id);

  p.pairing.heartbeat(paired.device.id, { companionVersion: "1.4.0" });
  assert.equal(p.queueJob(LIBRARY({ options: { mode: "autonomous" } })).body.mode, "autonomous");
});

// ── The plan ─────────────────────────────────────────────────────────────────

const shotOf = (extra) => ({ product: "copilot-studio", section: "test", kind: "test-result", caption: "The test pane answers a question", alt: "The test pane", instructions: ["Ask the agent **“What is our return policy?”** and wait for the answer."], callouts: [], ...extra });
const capture = (shot) => classifyShot(shot, { values: { copilotStudioAgentUrl: AGENT_URL } });

test("a test conversation gets a built-in recipe whose question comes from the lab, and a dialog is opened and left alone", () => {
  const shot = shotOf({});
  const setup = buildSetupPlan(shot, { capture: capture(shot), allowPractice: false });
  assert.match(setup.source, /^builtin:cs\.test-pane\.ask/);
  assert.deepEqual(setup.steps.map((s) => s.action), ["open", "type", "send", "wait-answer"]);
  assert.equal(setup.inputs.question, "What is our return policy?", "the lab's own question is used");
  assert.ok(setup.steps.every((s) => s.tier <= 1), "the whole conversation is Tier 1");

  const dialogShot = shotOf({ section: "knowledge", kind: "dialog", caption: "The Add knowledge dialog", alt: "The Add knowledge dialog", instructions: ["Select **Add knowledge** to open the dialog."] });
  const dialog = buildSetupPlan(dialogShot, { capture: capture(dialogShot), allowPractice: false });
  assert.ok(dialog.steps.some((s) => s.action === "open" && /Add knowledge/i.test(s.target.name) && s.expect?.dialog), "the opener comes from the shot's own words");
  assert.ok(!dialog.steps.some((s) => ["confirm", "create"].includes(s.action)), "nothing is confirmed");
});

test("steps that need a practice agent are left out without consent and kept with it", () => {
  const shot = shotOf({ section: "knowledge", kind: "result", caption: "The answer shows a citation", alt: "An answer with a citation", instructions: ["Ask a question that the knowledge source answers, and look at the **citation**."] });
  const without = buildSetupPlan(shot, { capture: capture(shot), allowPractice: false });
  assert.ok(without.limited || without.needsPractice, "the plan says it stopped short");
  assert.ok(!without.steps.some((s) => s.tier >= 2 || s.practiceOnly), "no Tier 2 step without consent");
  const withConsent = buildSetupPlan(shot, { capture: capture(shot), allowPractice: true });
  assert.ok(withConsent.steps.some((s) => s.practiceOnly || s.tier >= 2), "with consent the practice steps are in the plan");
  assert.ok(withConsent.steps.every((s) => !/^(delete|remove|sign out)/i.test(s.target?.name || "")), "and nothing destructive is ever planned");
});

test("a shared recipe replaces the built-in one for its slot", (t) => {
  const store = createSharedRecipeStore({ dir: tmp("shared-"), products: ["copilot-studio"] });
  const shot = shotOf({});
  const cap = capture(shot);
  const key = { product: "copilot-studio", screen: cap.screen?.id || "overview", slot: "test-pane" };
  const saved = store.put({ key, title: "Taught once", steps: [{ id: "s1", action: "open", intent: "open", target: { role: "button", name: "Chat panel", within: "header" }, expect: { panel: true } }, { id: "s2", action: "type", intent: "type", target: { role: "textbox", name: "Type your message", within: "chat" }, text: { sample: "question" } }, { id: "s3", action: "send", intent: "send", target: { role: "button", name: "Send", within: "chat" } }, { id: "s4", action: "wait-answer" }] });
  assert.equal(saved.ok, true, saved.errors?.join(" "));
  void t;
  const setup = buildSetupPlan(shot, { capture: cap, allowPractice: false, sharedRecipes: { get: () => store.get(key) } });
  assert.match(setup.source, /^shared:/);
  assert.equal(setup.steps[0].target.name, "Chat panel");

  const bad = store.put({ key, title: "Bad", steps: [{ id: "s1", action: "open", target: { role: "button", name: "Open https://contoso.sharepoint.com/sites/x?id=1" } }] });
  assert.equal(bad.ok, false, "a recipe with an address in it is refused");
  assert.equal(store.put({ key: { ...key, slot: "a" }, title: "Mail", steps: [{ id: "s1", action: "open", target: { role: "button", name: "Mail ada@contoso.com" } }] }).ok, false, "and so is one with an email address");
  assert.equal(store.put({ key: { ...key, slot: "b" }, title: "Id", steps: [{ id: "s1", action: "open", target: { role: "button", name: "Env 6b988893-6c74-4e65-9d9a-f7f044be1d08" } }] }).ok, false, "and one with a tenant or environment id");
  assert.equal(store.list().length, 1, "nothing refused was stored");
  assert.ok(!JSON.stringify(store.list()).includes("Chat panel"), "the list shows counts, not step names");
});

test("sample inputs are short, plain, and free of personal data, and the lab's question is used only when it is clean", () => {
  const plain = sampleInputsFor(shotOf({ instructions: ["Ask **“What is our return policy?”**"] }), { labTitle: "Contoso HR Bot" });
  assert.equal(plain.question, "What is our return policy?");
  assert.ok(plain.description && plain.instruction);
  for (const text of Object.values(plain)) assert.ok(text.length <= 200 && !/@|https?:/.test(text));

  const dirty = sampleInputsFor(shotOf({ instructions: ["Ask “Send the report to ada@contoso.com please?”"] }));
  assert.ok(!JSON.stringify(dirty).includes("ada@"), "a question with an email address is never typed");
  assert.equal(dirty.question, "What can you help me with?", "a plain question is used instead");

  const long = sampleInputsFor(shotOf({ instructions: [`Ask “${"x".repeat(300)}?”`] }));
  assert.ok((long.question || "").length <= 200);
  const knowledge = sampleInputsFor(shotOf({ caption: "An answer with a citation from the knowledge source", instructions: [] }));
  assert.match(knowledge.question, /documents/i, "a knowledge shot asks something the knowledge source would answer");
});

test("the plan file holds no secrets: the consent file is not part of any job and the practice address is confined to the plan", (t) => {
  const p = platform(t);
  p.saveConsent({ consented: true, level: "practice", practiceEnvironmentUrl: PRACTICE_URL });
  const queued = p.queueJob(LIBRARY({ options: { mode: "autonomous" } }));
  const job = JSON.stringify(p.jobs.get(queued.body.job.id));
  assert.ok(!/practiceEnvironmentUrl|copilotstudio\.microsoft\.com\/environments/.test(job), "the job JSON the browser can read has no practice environment");
  assert.match(readFileSync(p.consent.file, "utf8"), /practiceEnvironmentUrl/, "the consent is stored on the server, in the capture data folder");
});
