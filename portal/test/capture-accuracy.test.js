/**
 * Capture accuracy: where to capture (settings that reach the job), how each shot is captured (auto, guided,
 * manual), what a stopped capture says (grouped causes, paused), and how uploads are judged (the plan's expected
 * screen, never the companion's word). Hermetic: a real portal server over HTTP and labs built offline; no
 * browser and no tenant.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createProfile, getActiveProfileId, updateLabCaptureTargets, updateProfile } from "../lib/branding-profiles.js";
import { classifyShot, expectedLabelsForShot, summarizeMissing } from "../lib/capture/classify.js";
import { COMPANION_FILES } from "../lib/capture/companion-zip.js";
import { causeOf, normalizeJobRequest, summarizeCauses } from "../lib/capture/jobs.js";
import { sanitizeCaptureDescriptor } from "../lib/capture/plan.js";
import { resolveCaptureTargets } from "../lib/capture/targets.js";
import { createPortalClient } from "../../tools/screenshot-capture/companion.mjs";
import { buildFixtureLab, call, startPortal } from "../../tools/screenshot-capture/test/fixtures/capture-scenarios.mjs";
import { makePng } from "../../tools/screenshot-capture/test/fixtures/png.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "..", "..");
const ENV = "6b988893-6c74-4e65-9d9a-f7f044be1d08";
const BOT = "0f6c2d9a-3a54-4a64-8c61-5b1d7a2e9c11";
const AGENT_URL = `https://copilotstudio.microsoft.com/environments/${ENV}/bots/${BOT}/overview`;
const SITE_URL = "https://contoso.sharepoint.com/sites/training";
const cleanups = [];
const ctx = {};

function tmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

before(async () => {
  ctx.root = tmp("capture-accuracy-");
  ctx.cs = await buildFixtureLab({ repoDir: REPO_ROOT, storageRoot: ctx.root });
  ctx.sp = await buildFixtureLab({ repoDir: REPO_ROOT, storageRoot: ctx.root, products: ["sharepoint-ai"], features: ["spai-copilot-in-sharepoint-overview"], sharepointSiteUrl: SITE_URL, sharepointSiteName: "Training" });
  ctx.spNoUrl = await buildFixtureLab({ repoDir: REPO_ROOT, storageRoot: ctx.root, products: ["sharepoint-ai"], features: ["spai-copilot-in-sharepoint-overview"], sharepointSiteName: "Dominion Training" });
  ctx.server = await startPortal({ repoDir: REPO_ROOT, storageRoot: ctx.root });
  ctx.base = ctx.server.base;
  const code = (await call(ctx.base, "POST", "/api/capture/pair")).body.code;
  const paired = await createPortalClient({ portal: ctx.base }).pair({ code, deviceName: "TEST-PC" });
  ctx.client = createPortalClient({ portal: ctx.base, token: paired.token });
  await ctx.client.heartbeat({ signedInProducts: ["copilot-studio"] });
});

after(() => {
  ctx.server?.stop();
  for (const fn of cleanups.reverse()) {
    try {
      fn();
    } catch {
      /* best effort */
    }
  }
});

const queue = (body) => call(ctx.base, "POST", "/api/capture/jobs", body);
const labQueue = (labId, extra = {}) => queue({ target: { type: "lab", labId }, scope: { mode: "all" }, ...extra });
const putLab = (labId, targets, extra = {}) => call(ctx.base, "PUT", `/api/generated-labs/${labId}/capture-targets`, { targets, ...extra });
const putProfile = (targets) => call(ctx.base, "PUT", "/api/capture/targets", { targets });
const getTargets = (labId) => call(ctx.base, "GET", labId ? `/api/generated-labs/${labId}/capture-targets` : "/api/capture/targets");
const field = (payload, id) => payload.fields.find((f) => f.id === id);

/** Finish and clear whatever the companion holds, so the next test starts with an empty queue. */
async function drain() {
  for (;;) {
    const claimed = await ctx.client.next();
    if (!claimed) return;
    await ctx.client.complete(claimed.job.id, { message: "test cleanup" });
  }
}

// ── Where to capture ─────────────────────────────────────────────────────────

test("the lab's own SharePoint site address feeds the capture settings and the job, and the browser sees only names", async () => {
  const targets = (await getTargets(ctx.sp.labId)).body;
  assert.equal(field(targets, "sharepointSiteUrl").set, true);
  assert.equal(field(targets, "sharepointSiteUrl").source, "lab-site");
  assert.equal(field(targets, "sharepointSiteUrl").sourceLabel, "the lab's SharePoint site");

  const queued = await labQueue(ctx.sp.labId, { options: { mode: "smart" } });
  assert.equal(queued.status, 201, queued.text);
  assert.equal(queued.body.envSource, "lab");
  assert.deepEqual(queued.body.job.envNames, ["CAPTURE_SHAREPOINT_SITE_URL"]);
  assert.ok(!JSON.stringify(queued.body).includes("contoso.sharepoint.com"), "the job in the browser holds names, never the address");
  assert.ok(!JSON.stringify((await call(ctx.base, "GET", `/api/capture/jobs/${queued.body.job.id}`)).body).includes("contoso.sharepoint.com"));
  assert.ok(!(await call(ctx.base, "GET", "/api/capture/status")).text.includes("contoso.sharepoint.com"));

  const claimed = await ctx.client.next();
  assert.equal(claimed.job.id, queued.body.job.id);
  assert.equal(claimed.env.CAPTURE_SHAREPOINT_SITE_URL, SITE_URL, "the companion gets the address");
  await ctx.client.complete(claimed.job.id, { message: "done" });
});

test("a lab built with a site name but no address asks for the address instead of skipping silently", async () => {
  const targets = (await getTargets(ctx.spNoUrl.labId)).body;
  assert.equal(field(targets, "sharepointSiteUrl").set, false);
  const siteShots = targets.shots.filter((s) => s.needs.includes("sharepoint-site"));
  assert.ok(siteShots.length >= 1, "some shots need the site");
  const waiting = targets.missing.find((r) => r.id === "sharepoint-site");
  if (siteShots.some((s) => s.mode === "auto")) {
    assert.match(waiting.message, /screenshots? needs? your SharePoint site address/);
    assert.match(waiting.prompt, /Paste the address of your SharePoint site/);
  }
  // Saving the address on the lab makes the shots ready, and the job carries it.
  const saved = await putLab(ctx.spNoUrl.labId, { sharepointSiteUrl: SITE_URL });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.body.saved, true);
  assert.equal(field(saved.body, "sharepointSiteUrl").source, "lab");
  assert.equal(saved.body.missing.length, 0);
  const queued = await labQueue(ctx.spNoUrl.labId);
  assert.equal(queued.status, 201, queued.text);
  assert.deepEqual(queued.body.job.envNames, ["CAPTURE_SHAREPOINT_SITE_URL"]);
  await drain();
});

test("settings come from the request, then the lab, then the lab's site, then the brand profile, then the portal", async () => {
  const manifest = JSON.parse(readFileSync(join(ctx.sp.labDir, "manifest.json"), "utf8"));
  const profile = { copilotStudioAgentUrl: AGENT_URL, sharepointSiteUrl: "https://profile.sharepoint.com/sites/p", foundryProjectUrl: "https://ai.azure.com/p" };
  const env = { CAPTURE_FOUNDRY_PROJECT_URL: "https://server.example.com/", CAPTURE_M365_ADMIN_URL: "https://admin.cloud.microsoft" };
  const resolved = resolveCaptureTargets({ manifest, profile: { ...profile }, env, request: { targets: { copilotStudioAgentName: "Requested agent" }, env: { CAPTURE_POWER_PLATFORM_START_URL: "https://make.powerapps.com/environments/x/home" } } });
  assert.equal(resolved.values.sharepointSiteUrl, SITE_URL, "the lab's site beats the profile");
  assert.equal(resolved.sources.sharepointSiteUrl, "lab-site");
  assert.equal(resolved.values.copilotStudioAgentUrl, AGENT_URL);
  assert.equal(resolved.sources.copilotStudioAgentUrl, "profile");
  assert.equal(resolved.values.foundryProjectUrl, "https://ai.azure.com/p", "the profile beats the portal's own environment");
  assert.equal(resolved.values.m365AdminUrl, "https://admin.cloud.microsoft/");
  assert.equal(resolved.sources.m365AdminUrl, "server");
  assert.equal(resolved.sources.copilotStudioAgentName, "request");
  assert.equal(resolved.sources.powerPlatformEnvUrl, "request");

  const labDir = mkdtempSync(join(tmpdir(), "lab-override-"));
  cleanups.push(() => rmSync(labDir, { recursive: true, force: true }));
  mkdirSync(labDir, { recursive: true });
  const withOverride = { ...manifest, customization: { version: 1, overrides: {}, captureTargets: { sharepointSiteUrl: "https://lab.sharepoint.com/sites/o" } } };
  assert.equal(resolveCaptureTargets({ manifest: withOverride, profile, env }).values.sharepointSiteUrl, "https://lab.sharepoint.com/sites/o", "the lab's own setting beats its site");
  const wrong = resolveCaptureTargets({ manifest, profile, env, request: { targets: { sharepointSiteUrl: "http://insecure.example.com" } } });
  assert.equal(wrong.values.sharepointSiteUrl, SITE_URL, "an invalid request value is ignored, not used");
});

test("capture settings are validated, saved on the lab or the profile, and names reach the job without their values showing", async () => {
  const bad = await putLab(ctx.cs.labId, { sharepointSiteUrl: "http://insecure.example.com", copilotStudioAgentUrl: "https://copilotstudio.microsoft.com/environments/x/home" });
  assert.equal(bad.status, 400);
  assert.deepEqual(Object.keys(bad.body.errors).sort(), ["copilotStudioAgentUrl", "sharepointSiteUrl"]);
  assert.match(bad.body.errors.sharepointSiteUrl, /https/);
  assert.equal((await putLab("no-such-lab", { sharepointSiteUrl: SITE_URL })).status, 404);
  assert.equal((await call(ctx.base, "GET", "/api/capture/targets?labId=../x")).status, 400);
  assert.equal((await putProfile({ copilotStudioAgentName: "<script>" })).status, 400);

  const savedProfile = await putProfile({ copilotStudioAgentName: "Energy Assistant", copilotStudioAgentUrl: AGENT_URL });
  assert.equal(savedProfile.status, 200, savedProfile.text);
  assert.equal(field(savedProfile.body, "copilotStudioAgentName").source, "profile");
  assert.equal(field((await getTargets(ctx.cs.labId)).body, "copilotStudioAgentUrl").source, "profile", "every lab sees the profile's settings");

  const queued = await labQueue(ctx.cs.labId);
  assert.equal(queued.status, 201, queued.text);
  assert.deepEqual(queued.body.job.envNames, ["CAPTURE_COPILOT_STUDIO_AGENT_URL"]);
  assert.deepEqual(queued.body.job.targetNames, ["copilotStudioAgentName"]);
  assert.ok(!JSON.stringify(queued.body).includes("Energy Assistant"), "a name is never shown back in the job");
  const claimed = await ctx.client.next();
  assert.deepEqual(claimed.targets, { copilotStudioAgentName: "Energy Assistant" });
  assert.equal(claimed.env.CAPTURE_COPILOT_STUDIO_AGENT_URL, AGENT_URL);
  await ctx.client.complete(claimed.job.id, { message: "done" });

  // A lab's own setting wins on that lab only, and clearing it falls back to the profile.
  assert.equal((await putLab(ctx.cs.labId, { copilotStudioAgentName: "Lab agent" })).status, 200);
  assert.equal(field((await getTargets(ctx.cs.labId)).body, "copilotStudioAgentName").value, "Lab agent");
  assert.equal(field((await getTargets()).body, "copilotStudioAgentName").value, "Energy Assistant");
  assert.equal(field((await putLab(ctx.cs.labId, { copilotStudioAgentName: "" })).body, "copilotStudioAgentName").source, "profile");
  const alsoProfile = await putLab(ctx.sp.labId, { m365AdminUrl: "https://admin.cloud.microsoft" }, { alsoProfile: true });
  assert.equal(alsoProfile.status, 200);
  assert.equal(field((await getTargets()).body, "m365AdminUrl").source, "profile");

  // Existing customization updates never lose the lab's capture settings.
  const dir = ctx.sp.labDir;
  updateLabCaptureTargets(dir, { foundryProjectUrl: "https://ai.azure.com/keep" });
  assert.equal(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).customization.captureTargets.foundryProjectUrl, "https://ai.azure.com/keep");
  await putProfile({ copilotStudioAgentName: "", copilotStudioAgentUrl: "", m365AdminUrl: "" });
});

test("brand profiles carry the three new capture fields, validated like the others", async () => {
  const env = { PORTAL_STORAGE_ROOT: tmp("brand-fields-") };
  const profile = createProfile({ name: "Contoso", copilotStudioAgentUrl: AGENT_URL, copilotStudioAgentName: "Energy Assistant", agentBuilderAgentName: "Helper" }, env);
  assert.deepEqual([profile.copilotStudioAgentUrl, profile.copilotStudioAgentName, profile.agentBuilderAgentName], [AGENT_URL, "Energy Assistant", "Helper"]);
  assert.throws(() => updateProfile(profile.id, { copilotStudioAgentUrl: "http://insecure.example.com" }, env), /https/i);
  assert.equal(getActiveProfileId(env) !== undefined, true);
});

// ── How each shot is captured ────────────────────────────────────────────────

const shot = (extra) => ({ product: "copilot-studio", filename: "x.png", callouts: [], instructions: [], ...extra });

test("classification is honest: addressable screens are automatic, anything that needs state is guided, outside the browser is manual", () => {
  const rows = [
    [{ kind: "ui-location", section: "agents", caption: "The Copilot Studio Home page" }, "auto", "home"],
    [{ kind: "before", section: "home", caption: "The Home page before the agent is created" }, "auto", "home"],
    [{ kind: "after", section: "overview", alt: "The agent's Instructions editor containing the finished instruction text" }, "auto", "overview"],
    [{ kind: "settings", section: "settings", alt: "The Generative AI section of Settings" }, "auto", "settings"],
    [{ kind: "ui-location", section: "analytics" }, "auto", "analytics"],
    [{ kind: "after", section: "overview", alt: "The publish confirmation message showing the agent published successfully" }, "guided", "overview"],
    [{ kind: "test-result", section: "test", alt: "The Test pane showing a grounded answer" }, "guided", "overview"],
    [{ kind: "dialog", section: "knowledge", alt: "The Add knowledge dialog" }, "guided", "knowledge"],
    [{ kind: "settings", section: "tools", alt: "Mapping inputs for the connector tool" }, "guided", "tools"],
    [{ kind: "after", section: "tools", alt: "A discovered MCP tool" }, "guided", "tools"],
    [{ kind: "ui-location", section: "agents", alt: "Somewhere in an agent" }, "guided", "overview"],
    [{ kind: "error-state", section: "settings" }, "guided", "settings"],
    [{ kind: "ui-location", section: "powershell", manual: true }, "manual", undefined],
  ];
  for (const [src, mode, screen] of rows) {
    const capture = classifyShot(shot(src), { values: {} });
    assert.equal(capture.mode, mode, `${src.kind}/${src.section}: ${capture.why}`);
    assert.equal(capture.screen?.id, screen);
    assert.ok(capture.why.length > 20, "every shot says why in plain language");
  }
  const agentShot = classifyShot(shot({ kind: "after", section: "overview" }), { values: {} });
  assert.deepEqual([agentShot.needs, agentShot.missing, agentShot.ready], [["copilot-studio-agent"], ["copilot-studio-agent"], false]);
  assert.deepEqual(agentShot.path, ["Copilot Studio", "your agent", "Overview"]);
  assert.equal(classifyShot(shot({ kind: "after", section: "overview" }), { values: { copilotStudioAgentName: "A" } }).ready, true);
  const guidedAgent = classifyShot(shot({ kind: "dialog", section: "knowledge" }), { values: {} });
  assert.deepEqual([guidedAgent.needs, guidedAgent.missing], [[], []], "a guided shot never waits for an address: the person opens the rest");
  const home = classifyShot(shot({ kind: "before", section: "home" }), { values: {} });
  assert.deepEqual(home.needs, [], "the home page needs no agent");
  const sp = classifyShot({ product: "sharepoint-ai", section: "sharepoint-site", kind: "ui-location", callouts: [], instructions: [] }, { values: {} });
  assert.deepEqual([sp.mode, sp.needs, sp.missing], ["auto", ["sharepoint-site"], ["sharepoint-site"]]);
  const spReady = classifyShot({ product: "sharepoint-ai", section: "sharepoint-site", kind: "ui-location", callouts: [], instructions: [] }, { values: { sharepointSiteUrl: SITE_URL } });
  assert.equal(spReady.ready, true);
  const builder = classifyShot({ product: "m365-copilot-agent-builder", section: "build", kind: "ui-location", callouts: [], instructions: [] }, { values: {} });
  assert.equal(builder.mode, "guided", "Agent Builder has no direct address");
  assert.match(builder.why, /no direct address/);
});

test("a screen that needs a person is not run in automatic mode, and the portal records why", async () => {
  const queued = await labQueue(ctx.cs.labId, { targets: { copilotStudioAgentUrl: AGENT_URL }, options: { mode: "auto" } });
  assert.equal(queued.status, 201, queued.text);
  const rows = queued.body.job.shots;
  const byName = Object.fromEntries(rows.map((r) => [r.filename, r]));
  assert.equal(byName["test-pane-in-scope.png"].status, "needs-you");
  assert.equal(byName["test-pane-in-scope.png"].cause, "needs-you");
  assert.equal(byName["agent-overview.png"].status, "pending");
  assert.equal(byName["agent-overview.png"].mode, "auto");
  assert.match(byName["agent-overview.png"].modeWhy, /open this screen by its address/);
  assert.deepEqual(byName["agent-overview.png"].path, ["Copilot Studio", "your agent", "Overview"]);
  assert.ok(queued.body.job.progress.needsYou >= 3);
  assert.equal(queued.body.job.options.mode, "auto");
  await drain();

  const smart = await labQueue(ctx.cs.labId, { targets: { copilotStudioAgentUrl: AGENT_URL } });
  assert.equal(smart.body.job.options.mode, "smart", "smart is the default");
  assert.ok(smart.body.job.shots.filter((r) => r.mode === "guided").every((r) => r.status === "pending"), "smart leaves guided shots for the companion to ask about");
  await drain();
  assert.equal((await labQueue(ctx.cs.labId, { options: { mode: "everything" } })).status, 400);
  assert.deepEqual(normalizeJobRequest({ target: { type: "library" }, options: { mode: "GUIDED" } }).options.mode, "guided");
});

test("shots that wait for an address are held back and named; when nothing can run, nothing is queued", async () => {
  await putProfile({ copilotStudioAgentName: "", copilotStudioAgentUrl: "" });
  const held = await labQueue(ctx.cs.labId, { options: { mode: "smart" } });
  assert.equal(held.status, 201, held.text);
  const waiting = held.body.job.shots.filter((r) => r.status === "skipped");
  assert.ok(waiting.length >= 3 && waiting.every((r) => r.cause === "no-agent" && /needs your agent address\. Add it in Capture settings/.test(r.message)));
  assert.equal(held.body.job.causes[0].code, "no-agent", "one group with one fix, not one line per shot");
  assert.equal(held.body.job.causes[0].count, waiting.length);
  assert.equal(held.body.job.causes[0].fixAction, "settings");
  assert.equal(held.body.missing[0].id, "copilot-studio-agent");
  await drain();

  const none = await queue({ target: { type: "lab", labId: ctx.cs.labId }, scope: { mode: "selected", filenames: ["agent-overview.png", "agent-instructions.png"] } });
  assert.equal(none.status, 200, none.text);
  assert.equal(none.body.job, null);
  assert.equal(none.body.needsAddress, true);
  assert.equal(none.body.missing[0].count, 2);
  assert.match(none.body.message, /2 screenshots need your agent address/);
  assert.equal(none.body.missing[0].noun, "agent address");

  // A guided job asks for nothing up front: the person opens the agent.
  const guided = await queue({ target: { type: "lab", labId: ctx.cs.labId }, scope: { mode: "selected", filenames: ["agent-overview.png"] }, options: { mode: "guided" } });
  assert.equal(guided.status, 201, guided.text);
  assert.equal(guided.body.job.shots[0].status, "pending");
  await drain();
});

test("the capture status of a lab says how each shot is captured and why", async () => {
  const status = (await call(ctx.base, "GET", `/api/generated-labs/${ctx.cs.labId}/screenshots`)).body;
  const shotRow = status.shots.find((s) => s.filename === "agent-instructions.png");
  assert.equal(shotRow.capture.mode, "auto");
  assert.equal(shotRow.capture.ready, false);
  assert.deepEqual(shotRow.capture.missing, ["copilot-studio-agent"]);
  assert.match(shotRow.capture.why, /open this screen by its address/);
  assert.equal(status.shots.find((s) => s.filename === "publish-confirmation.png").capture.mode, "guided");
  assert.ok(status.shots.every((s) => ["auto", "guided", "manual"].includes(s.capture.mode)));
});

test("the plan the companion gets carries the capture descriptor and no page-by-page clicks", async () => {
  await putProfile({ copilotStudioAgentUrl: AGENT_URL });
  const queued = await labQueue(ctx.cs.labId);
  assert.equal(queued.status, 201, queued.text);
  const claimed = await ctx.client.next();
  const overview = claimed.shots.find((s) => s.filename === "agent-overview.png");
  assert.equal(overview.capture.mode, "auto");
  assert.deepEqual(overview.capture.expect, { family: "copilot-studio", scope: "agent", paths: ["overview"], label: "the agent's Overview page", strict: true });
  assert.equal(overview.startUrl, `https://copilotstudio.microsoft.com/environments/${ENV}/bots/${BOT}/overview`, "even an older companion lands on the screen");
  assert.ok(overview.steps.every((s) => !["stepThrough", "click", "clickBestEffort"].includes(s.action)), "the module-wide clicks that landed on the wrong page are gone");
  const settings = claimed.shots.find((s) => s.filename === "generative-orchestration-setting.png");
  assert.deepEqual(settings.capture.reveal.map((r) => [r.label, r.required]), [["Generative AI", true]]);
  assert.ok(settings.expectedLabels.every((l) => !/new experience|submit|feedback/i.test(l)), "labels from other screens' steps are not expected here");
  assert.ok(claimed.shots.every((s) => s.capture && s.capture.version === 1));
  await ctx.client.complete(claimed.job.id, { message: "test cleanup" });
});

test("expected labels come from the shot itself, cleaned, and the descriptor is bounded", () => {
  const labels = expectedLabelsForShot({ callouts: [{ text: "Settings" }, { text: "Start building form scratch" }, { text: "Save" }], instructions: ["Select **Generative AI**.", "Select **the**."] });
  assert.deepEqual(labels, ["Settings", "Start building from scratch", "Generative AI"]);
  const clean = sanitizeCaptureDescriptor({ version: 1, mode: "bogus", why: "x".repeat(900), needs: ["copilot-studio-agent", "made-up"], route: { kind: "url", url: "http://insecure.example.com", urlEnv: "NOT_CAPTURE" }, path: Array(20).fill("p"), guide: ["<b>x</b>"] });
  assert.equal(clean.mode, "guided", "an unknown mode falls back to the safe one");
  assert.equal(clean.why.length, 300);
  assert.deepEqual(clean.needs, ["copilot-studio-agent"]);
  assert.equal(clean.route.url, undefined);
  assert.equal(clean.route.urlEnv, undefined);
  assert.equal(clean.path.length, 6);
  assert.deepEqual(summarizeMissing([{ filename: "a.png", capture: { missing: ["sharepoint-site"] } }, { filename: "b.png", capture: { missing: ["sharepoint-site"] } }]).map((g) => [g.id, g.count, g.noun]), [["sharepoint-site", 2, "SharePoint site address"]]);
});

// ── Uploads are judged against the plan ──────────────────────────────────────

test("an upload is checked against the screen the plan expects, not against what the companion claims", async () => {
  await putProfile({ copilotStudioAgentUrl: AGENT_URL });
  const queued = await labQueue(ctx.cs.labId, { scope: { mode: "selected", filenames: ["agent-overview.png", "agent-instructions.png"] } });
  assert.equal(queued.status, 201, queued.text);
  const claimed = await ctx.client.next();
  const upload = (filename, url, extra = {}) =>
    ctx.client.upload(claimed.job.id, filename, { bytes: makePng({ mode: "ui", seed: 3 }), mime: "image/png", evidence: { finalUrl: url, title: "Copilot Studio", visibleText: ["Overview", "Instructions"], redaction: { applied: true, masked: 0 }, capturedAt: new Date().toISOString(), executedSteps: 2, mode: "auto", routeSteps: [{ action: "open", label: "Copilot Studio", ok: true, found: true }], ...extra } });
  const home = await upload("agent-overview.png", `https://copilotstudio.microsoft.com/environments/${ENV}/home`, { expect: { family: "url", host: "copilotstudio.microsoft.com" } });
  assert.equal(home.status, 202, "the wrong page is never accepted, even with every label visible and a made-up expectation");
  assert.equal(home.body.outcome, "needs-review");
  assert.equal(home.body.verification.reasons[0].code, "wrong-screen");
  assert.match(home.body.verification.reasons[0].message, /^This is the Copilot Studio home page, not the agent's Overview page\./);
  assert.deepEqual(home.body.verification.landing, { state: "mismatch", page: "the Copilot Studio home page", expected: "the agent's Overview page" });
  const right = await upload("agent-instructions.png", `https://copilotstudio.microsoft.com/environments/${ENV}/bots/${BOT}/overview?x=1`);
  assert.equal(right.status, 200, "the right page is accepted");
  assert.equal(right.body.verification.landing.state, "match");
  assert.equal(right.body.verification.finalUrl.includes("?"), false);

  const job = (await call(ctx.base, "GET", `/api/capture/jobs/${claimed.job.id}`)).body.job;
  const review = job.shots.find((s) => s.filename === "agent-overview.png");
  assert.equal(review.status, "needs-review");
  assert.equal(review.cause, "wrong-screen");
  const accepted = job.shots.find((s) => s.filename === "agent-instructions.png");
  assert.equal(accepted.status, "captured");
  assert.equal(accepted.outcome, "Opened Copilot Studio, then your agent, then Overview.");
  assert.equal(accepted.steps[0].action, "open");
  assert.equal(job.causes.find((c) => c.code === "wrong-screen").count, 1);

  // The person can still accept a needs-review shot, and the staged image is readable.
  const staged = await fetch(`${ctx.base}/api/generated-labs/${ctx.cs.labId}/screenshots/agent-overview.png/staged`);
  assert.equal(staged.status, 200);
  const acceptedByPerson = await call(ctx.base, "POST", `/api/generated-labs/${ctx.cs.labId}/screenshots/agent-overview.png/accept`);
  assert.equal(acceptedByPerson.status, 200, acceptedByPerson.text);
  await ctx.client.complete(claimed.job.id, { message: "done" });
});

// ── Stopping, pausing, resuming ──────────────────────────────────────────────

test("a paused capture says so once, keeps its shots resumable, and is not counted as failed", async () => {
  await putProfile({ copilotStudioAgentUrl: AGENT_URL });
  const queued = await labQueue(ctx.cs.labId, { options: { mode: "smart" } });
  const claimed = await ctx.client.next();
  assert.equal(claimed.job.id, queued.body.job.id);
  await ctx.client.progress(claimed.job.id, { shot: { filename: claimed.shots[0].filename, status: "running", message: "Capturing.", mode: "auto", path: ["Copilot Studio", "Home"] } });
  const paused = await ctx.client.complete(claimed.job.id, { message: "You closed the browser window.", paused: { reason: "browser-closed", message: "You closed the browser window, so the capture is paused. Select Resume to continue where it stopped." } });
  const job = paused.job;
  assert.equal(job.status, "failed", "nothing was captured, and the job says why");
  assert.equal(job.result.resumable, true);
  assert.equal(job.result.pausedReason, "browser-closed");
  assert.ok(job.progress.paused >= 1 && job.progress.failed === 0);
  const pausedRows = job.shots.filter((s) => s.status === "paused");
  assert.ok(pausedRows.every((s) => s.cause === "browser-closed" && /select Resume/i.test(s.message)));
  assert.equal(job.causes.find((c) => c.code === "browser-closed").count, pausedRows.length);
  assert.equal(job.causes.find((c) => c.code === "browser-closed").fixAction, "resume");
  assert.match(job.error, /Resume/);
  // Resuming is a new capture of exactly those shots.
  const resumed = await queue({ target: { type: "lab", labId: ctx.cs.labId }, scope: { mode: "selected", filenames: pausedRows.map((s) => s.filename) } });
  assert.equal(resumed.status, 201, resumed.text);
  await drain();
});

test("failure causes are grouped, with one fix per group and a cause even when the companion sent none", () => {
  const rows = [
    ...Array.from({ length: 12 }, (_, i) => ({ filename: `a${i}.png`, status: "skipped", cause: "no-agent" })),
    ...Array.from({ length: 3 }, (_, i) => ({ filename: `s${i}.png`, status: "auth-required" })),
    { filename: "w.png", status: "needs-review", verification: { reasons: [{ code: "wrong-screen" }] } },
    { filename: "b.png", status: "failed", verification: { reasons: [{ code: "blank" }] } },
    { filename: "u.png", status: "failed" },
    { filename: "p.png", status: "paused" },
    { filename: "n.png", status: "needs-you" },
    { filename: "ok.png", status: "captured" },
    { filename: "q.png", status: "pending" },
  ];
  const groups = summarizeCauses(rows);
  assert.deepEqual(groups.map((g) => [g.code, g.count]), [["no-agent", 12], ["sign-in", 3], ["wrong-screen", 1], ["blank-page", 1], ["unknown", 1], ["browser-closed", 1], ["needs-you", 1]]);
  assert.equal(groups[0].title, "No agent address set");
  assert.match(groups[0].fix, /Capture settings/);
  assert.equal(groups[0].filenames.length, 12);
  assert.ok(groups.every((g) => g.fix && g.fixAction && g.tone));
  assert.equal(causeOf({ status: "captured" }), null);
});

// ── The companion download and older portals ─────────────────────────────────

test("the companion download holds every module the companion imports", () => {
  const listed = new Set(COMPANION_FILES);
  for (const file of COMPANION_FILES.filter((f) => f.endsWith(".mjs"))) {
    const text = readFileSync(join(REPO_ROOT, file), "utf8");
    for (const match of text.matchAll(/(?:from|import\()\s*"(\.{1,2}\/[^"]+)"/g)) {
      const target = join(dirname(file), match[1]).replace(/\\/g, "/");
      assert.ok(listed.has(target), `${file} imports ${match[1]}, which must be in the companion download (${target})`);
    }
  }
  for (const needed of ["capture-run", "guided", "labels", "lifecycle", "locator", "readiness", "targets", "causes"]) {
    assert.ok(listed.has(`tools/screenshot-capture/${needed}.mjs`), needed);
    assert.ok(existsSync(join(REPO_ROOT, "tools", "screenshot-capture", `${needed}.mjs`)));
  }
});

test("every existing capture route still answers as before", async () => {
  assert.equal((await call(ctx.base, "GET", "/api/capture/status")).status, 200);
  assert.equal((await call(ctx.base, "GET", "/api/capture/jobs")).body.jobs.length >= 1, true);
  assert.equal((await call(ctx.base, "GET", "/api/capture/library?products=copilot-studio")).status, 200);
  assert.equal((await call(ctx.base, "GET", "/api/capture/devices")).status, 200);
  assert.equal((await call(ctx.base, "POST", "/api/capture/jobs", {})).status, 400);
  assert.equal((await call(ctx.base, "GET", `/api/lab-builder/generated/${ctx.cs.labId}/capture-targets`)).status, 200, "the lab-builder alias works too");
  const old = await queue({ target: { type: "lab", labId: ctx.cs.labId }, scope: "missing", env: { CAPTURE_COPILOT_STUDIO_START_URL: AGENT_URL } });
  assert.equal(old.status, 201, "an older request that carries only env still queues");
  await drain();
});
