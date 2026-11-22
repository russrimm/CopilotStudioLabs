/**
 * Pictures that show the wrong screen: the fingerprint, the judgment, the audit report, the duplicate guard at upload, accept, promotion,
 * and reuse, and moving the pictures that look wrong to the kept pictures list (and back).
 *
 * Every picture here is synthetic (gray blocks drawn by this file); no real screenshot, name, or tenant is used. The slot names are the
 * shared library's own slot names, which are public.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { generateLab } from "../lib/lab-builder/generator.js";
import { getLabScreenshotsStatus, readLabConfirmations, readLabVerification, writeLabVerificationRecord } from "../lib/lab-builder/lab-screenshots.js";
import { createCapturePlatform } from "../lib/capture/index.js";
import { sha256Hex } from "../lib/capture/library-share.js";
import { buildAuditReport, renderContactSheet, renderMarkdown } from "../lib/capture/picture-audit-report.js";
import { FLAGS, assessPictures, canExpect, isLandingUrl, noticeText, reachOf } from "../lib/capture/picture-integrity.js";
import { createPictureScanner } from "../lib/capture/picture-inventory.js";
import { NEAR_DISTANCE, distance, fingerprintPicture, looksSame } from "../../tools/screenshot-capture/fingerprint.mjs";
import { makeJpeg, makeWebp } from "../../tools/screenshot-capture/test/fixtures/png.mjs";
import { CHROME, blocks, formPage, homePage, homePageLater, hubPage } from "./fixtures/block-pictures.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "..", "..");
const cleanups = [];
const tmp = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
after(() => {
  for (const fn of cleanups.reverse()) {
    try {
      fn();
    } catch {
      /* best effort */
    }
  }
});

// ── Synthetic pictures ──────────────────────────────────────────────────────
// Gray blocks drawn by test/fixtures/block-pictures.js: a start page, the same page a moment later, and two other screens.

const open = (label = "Open the page") => ({ action: "open", label, ok: true, found: true, urlBefore: "make.powerapps.com/start", urlAfter: "make.powerapps.com/home" });
const shot = { action: "screenshot", label: "", ok: true, found: true, urlBefore: "make.powerapps.com/home", urlAfter: "make.powerapps.com/home" };
const clicked = (action, label) => ({ action, label, ok: true, found: true, urlBefore: "", urlAfter: "" });
const HOME_URL = "https://make.powerapps.com/environments/00000000-0000-0000-0000-000000000000/home";

function checkFor(bytes, { finalUrl = HOME_URL, steps = [open(), shot], mode = "autonomous", masked = 2, version = 2, reasons = [], applied = true, signals = null } = {}) {
  return { ok: true, level: reasons.length ? "warn" : "pass", reasons, sha256: sha256Hex(bytes), state: "accepted", finalUrl, redaction: { applied, masked }, evidenceVersion: version, ...(signals ? { signals } : {}), capture: { mode, steps } };
}

const deepSlot = (label) => ({ product: "power-platform-ai-hub", depth: "deep", label });
const landingSlot = (label) => ({ product: "power-platform-ai-hub", depth: "landing", label });
const pictureOf = (bytes, slotName, slot, record, extra = {}) => ({ id: `library:${slotName}`, scope: "library", labId: null, filename: slotName, sha256: sha256Hex(bytes), fingerprint: fingerprintPicture(bytes), record, confirmed: false, slot, ...extra });
const byId = (results) => Object.fromEntries(results.map((r) => [r.id, r]));
const codes = (result) => result.flags.map((f) => `${f.code}:${f.level}`);

// ── The fingerprint ─────────────────────────────────────────────────────────

test("the fingerprint tells the same page from a different one, and says nothing about pictures it cannot decode", () => {
  const a = fingerprintPicture(homePage());
  assert.ok(a && /^[0-9a-f]{64}$/.test(a.d) && /^[0-9a-f]{64}$/.test(a.a), "a hash of 256 bits for the layout and one for the light and dark areas");
  assert.equal(distance(a, fingerprintPicture(homePage())), 0, "the same picture");
  const later = fingerprintPicture(homePageLater());
  assert.ok(distance(a, later) <= NEAR_DISTANCE && looksSame(a, later), `the same page a moment later is near-identical (${distance(a, later)} of 256)`);
  for (const other of [hubPage(), formPage()]) assert.ok(distance(a, fingerprintPicture(other)) > NEAR_DISTANCE, "another screen of the same product is not");
  assert.ok(distance(fingerprintPicture(hubPage()), fingerprintPicture(formPage())) > NEAR_DISTANCE);
  assert.equal(distance(a, fingerprintPicture(blocks([...CHROME], { width: 640, height: 200 }))), null, "a wide window and a narrow one are never the same screen");
  // A nearly flat page (a blank or loading screen) has too little structure to compare by look: only identical bytes count for it.
  const flat = fingerprintPicture(blocks([{ x: 100, y: 60, w: 12, h: 8, gray: 120 }]));
  const flatOther = fingerprintPicture(blocks([{ x: 200, y: 90, w: 12, h: 8, gray: 120 }]));
  assert.equal(distance(flat, flatOther), null, "two flat pictures are not called the same screen");
  assert.equal(looksSame(flat, flatOther), false);
  assert.equal(distance(flat, a), null);
  assert.equal(fingerprintPicture(makeJpeg()), null, "a JPEG cannot be decoded here");
  assert.equal(fingerprintPicture(makeWebp()), null);
  assert.equal(fingerprintPicture(Buffer.from("not a picture")), null);
  assert.equal(distance(a, null), null);
});

// ── The judgment ────────────────────────────────────────────────────────────

test("the same start page under several deeper slots is wrong for all of them; the one slot that truly expects it is kept", () => {
  const home = homePage();
  const record = checkFor(home);
  const results = byId(
    assessPictures([
      pictureOf(home, "ppai-start.png", landingSlot("The start page"), record),
      pictureOf(home, "ppai-ai-models-page.png", deepSlot("The AI models page"), record),
      pictureOf(home, "ppai-ai-hub-menu.png", deepSlot("The AI hub in the left pane"), record),
      pictureOf(homePageLater(), "ppai-docproc-fields.png", deepSlot("Defining the information to extract"), checkFor(homePageLater())),
      pictureOf(hubPage(), "ppai-prompt-builder-editor.png", deepSlot("The prompt builder editor"), checkFor(hubPage(), { steps: [open(), clicked("open", "AI hub"), shot] })),
    ]),
  );
  assert.equal(results["library:ppai-start.png"].level, null, "a start page for the slot that expects a start page is fine");
  for (const name of ["ppai-ai-models-page.png", "ppai-ai-hub-menu.png", "ppai-docproc-fields.png"]) {
    const result = results[`library:${name}`];
    assert.equal(result.level, "definite", name);
    assert.ok(result.flags.some((f) => f.code === FLAGS.LANDING_PAGE && f.level === "definite"), `${name}: the computer never left the start page`);
    assert.match(result.flags[0].message, /start page|looks the same|same picture/);
  }
  assert.ok(codes(results["library:ppai-ai-models-page.png"]).includes("DUPLICATE_ACROSS_SLOTS:definite"), "identical bytes");
  assert.ok(codes(results["library:ppai-docproc-fields.png"]).includes("NEAR_DUPLICATE:definite"), "a near-identical picture");
  assert.equal(results["library:ppai-prompt-builder-editor.png"].level, null, "a different picture reached by opening something is not touched");
  assert.equal(results["library:ppai-ai-models-page.png"].cluster, results["library:ppai-start.png"].cluster);
});

test("two slots that may truly share a screen are only worth a look, and a picture a person kept is never flagged", () => {
  const hub = hubPage();
  const steps = [open(), clicked("open", "More options"), clicked("choose", "Settings"), shot];
  const record = checkFor(hub, { steps });
  const siblings = byId(assessPictures([pictureOf(hub, "a.png", deepSlot("One setting"), record), pictureOf(hub, "b.png", deepSlot("Another setting"), record)]));
  assert.deepEqual([siblings["library:a.png"].level, siblings["library:b.png"].level], ["probable", "probable"], "reached the same way, so both may be right");
  assert.ok(!siblings["library:a.png"].flags.some((f) => f.level === "definite"));

  const unknown = byId(assessPictures([pictureOf(hub, "c.png", deepSlot("C"), null), pictureOf(hub, "d.png", deepSlot("D"), null)]));
  assert.deepEqual([unknown["library:c.png"].level, unknown["library:d.png"].level], ["probable", "probable"], "with no saved check nothing proves either is wrong");

  const home = homePage();
  const kept = byId(assessPictures([pictureOf(home, "e.png", deepSlot("E"), checkFor(home), { confirmed: true }), pictureOf(home, "f.png", deepSlot("F"), checkFor(home))]));
  assert.equal(kept["library:e.png"].level, null, "a picture marked Keep this one is not flagged");
  assert.equal(kept["library:f.png"].level, "definite", "its twin still is");
});

test("what a picture reached, and what a slot can truthfully show", () => {
  assert.equal(reachOf(null).reach, "unknown");
  assert.equal(reachOf(checkFor(homePage())).reach, "landing");
  assert.equal(reachOf(checkFor(homePage(), { finalUrl: "https://make.powerapps.com/environments/x/apps/new" })).reach, "page", "one page opened by its address");
  assert.equal(reachOf(checkFor(homePage(), { steps: [open(), clicked("select-tab", "Build"), shot], finalUrl: "https://copilotstudio.microsoft.com/environments/x/agents/00000000-0000-0000-0000-000000000001" })).reach, "tab");
  assert.equal(reachOf(checkFor(homePage(), { steps: [open(), clicked("select-tab", "Monitor"), shot], finalUrl: "https://copilotstudio.microsoft.com/environments/x/bots/00000000-0000-0000-0000-000000000001/analytics" })).reach, "page", "a tab whose address names its page");
  assert.equal(reachOf(checkFor(homePage(), { steps: [open(), clicked("open", "Add knowledge"), shot] })).reach, "deep");
  assert.equal(reachOf(checkFor(homePage(), { mode: "guided", steps: [] })).reach, "deep", "a person set it up");
  // Choosing a tab does not prove the screen by itself, and neither does a label matching: the product's own navigation shows "AI hub" or "Settings" on a start page too.
  const tabbed = (label, verify) => checkFor(homePage(), { steps: [open(), clicked("select-tab", label), ...(verify ? [clicked("verify", `Checked that ${label} is showing`)] : []), shot], finalUrl: "https://copilotstudio.microsoft.com/environments/x/agents/00000000-0000-0000-0000-000000000001" });
  assert.equal(reachOf(tabbed("Evaluate", true)).reach, "tab");
  const labelled = (matched) => assessPictures([pictureOf(homePage(), "x.png", deepSlot("An evaluation test set"), { ...tabbed("Evaluate", true), labels: { expected: 2, matched, score: matched / 2 } })])[0];
  assert.ok(codes(labelled(1)).includes("LANDING_PAGE:definite") && codes(labelled(2)).includes("LANDING_PAGE:definite"), "labels on the page do not rescue a picture that reached only the agent's main tab");
  assert.deepEqual([canExpect("deep", "landing"), canExpect("deep", "tab"), canExpect("deep", "deep"), canExpect("agent-page", "tab"), canExpect("landing", "landing"), canExpect("page", "tab"), canExpect("deep", "unknown")], [false, false, true, true, true, false, true]);
  assert.equal(isLandingUrl("https://copilotstudio.microsoft.com/environments/x/home"), true);
  assert.equal(isLandingUrl("https://copilotstudio.microsoft.com/environments/x/agents/00000000-0000-0000-0000-000000000001"), false);
  assert.equal(isLandingUrl("https://make.powerapps.com/environments/x/home"), true);
  assert.equal(isLandingUrl("https://make.powerapps.com/environments/x/apps/new"), false);
});

test("a sign-in cue, no account menu, masking that was not applied, and a start page an older companion could not mask are each said plainly", () => {
  const page = (record) => assessPictures([pictureOf(formPage(), "x.png", deepSlot("X"), record)])[0];
  const deep = [open(), clicked("open", "Something"), shot];
  assert.equal(page(checkFor(formPage(), { steps: deep, masked: 2 })).level, null, "a clean capture by the current companion is not flagged");
  const noAccount = page(checkFor(formPage(), { steps: deep, masked: 0, version: 1 }));
  assert.deepEqual(codes(noAccount), [`${FLAGS.SIGNED_OUT_OR_MARKETING}:probable`]);
  assert.match(noAccount.flags[0].message, /No account menu was found/);
  assert.equal(page(checkFor(formPage(), { steps: deep, masked: 0, version: 2 })).level, null, "the current companion stops on a signed-out page itself");
  assert.deepEqual(codes(page(checkFor(formPage(), { steps: deep, reasons: [{ code: "sign-in-page", level: "fail", message: "x" }], version: 2 }))), [`${FLAGS.SIGNED_OUT_OR_MARKETING}:definite`]);
  assert.deepEqual(codes(page(checkFor(formPage(), { steps: deep, signals: { signInVisible: true, accountControl: false } }))), [`${FLAGS.SIGNED_OUT_OR_MARKETING}:definite`]);
  assert.deepEqual(codes(page(checkFor(formPage(), { steps: deep, applied: false }))), [`${FLAGS.POSSIBLE_IDENTITY}:definite`], "masking was not applied");
  const start = assessPictures([pictureOf(homePage(), "s.png", landingSlot("S"), checkFor(homePage(), { version: 1 }))])[0];
  assert.deepEqual(codes(start), [`${FLAGS.POSSIBLE_IDENTITY}:probable`], "a start page from an older companion may show a greeting");
  assert.match(start.flags[0].message, /could not hide those/);
  assert.equal(assessPictures([pictureOf(homePage(), "s.png", landingSlot("S"), checkFor(homePage(), { version: 2 }))])[0].level, null);
  const wrong = assessPictures([pictureOf(formPage(), "w.png", deepSlot("W"), checkFor(formPage(), { steps: deep, finalUrl: "https://example.org/home" }))], { productHosts: { "power-platform-ai-hub": ["make.powerapps.com"] } })[0];
  assert.deepEqual(codes(wrong), [`${FLAGS.WRONG_PRODUCT}:probable`]);
  assert.equal(noticeText(3), "3 pictures look like the wrong screen. Review them.");
  assert.equal(noticeText(1), "1 picture looks like the wrong screen. Review it.");
  assert.equal(noticeText(0), "");
});

// ── A synthetic library, a lab, and the audit ───────────────────────────────

/** A library and one lab holding pictures of known slots, with saved checks the way the companion's uploads leave them. */
function syntheticData() {
  const root = tmp("picture-audit-");
  const lib = join(root, "library");
  const labs = join(root, "labs");
  const data = join(root, "data");
  mkdirSync(lib, { recursive: true });
  mkdirSync(join(data, "capture"), { recursive: true });
  const lab = join(labs, "demo-lab");
  mkdirSync(join(lab, "assets"), { recursive: true });
  mkdirSync(join(lab, "screenshots"), { recursive: true });
  writeFileSync(join(lab, "manifest.json"), JSON.stringify({ id: "demo-lab", title: "Demo lab" }));
  const home = homePage();
  const hub = hubPage();
  const records = {};
  const put = (name, bytes, record) => {
    writeFileSync(join(lib, name), bytes);
    records[name] = record;
  };
  // Three AI hub slots hold the start page; one holds a screen the computer opened; the Copilot Studio home slot holds a start page.
  put("ppai-ai-models-page.png", home, checkFor(home, { steps: [open(), shot] }));
  put("ppai-ai-hub-menu.png", home, checkFor(home, { steps: [open(), shot] }));
  put("ppai-docproc-fields.png", homePageLater(), checkFor(homePageLater(), { steps: [open(), shot] }));
  put("ppai-prompt-builder-editor.png", hub, checkFor(hub, { steps: [open(), clicked("open", "AI hub"), shot] }));
  writeFileSync(join(data, "capture", "library-verification.json"), JSON.stringify({ schema: 1, shots: records }));
  // The lab holds a copy of one of them, with no check of its own (a copy made when the lab was built).
  writeFileSync(join(lab, "assets", "ppai-ai-models-page.png"), home);
  writeFileSync(join(lab, "screenshots", "shots.json"), JSON.stringify({ schema: 1, product: "power-platform-ai-hub", shots: [{ filename: "ppai-ai-models-page.png", product: "power-platform-ai-hub", section: "ai-hub", kind: "ui-location", caption: "The AI models page", instructions: ["Open **AI hub** > **AI models**."] }] }));
  return { root, lib, labs, data };
}

test("the audit finds the pictures that show the wrong screen on a synthetic library, and its report names every one", () => {
  const { lib, labs, data } = syntheticData();
  const scanner = createPictureScanner({ generatedRoot: labs, captureDir: join(data, "capture"), capturedDirs: () => ({ primary: lib, search: [lib] }) });
  const scan = scanner.scan();
  assert.equal(scan.counts.pictures, 5, "four in the library, one in the lab");
  const flagged = Object.fromEntries(scan.items.filter((i) => i.level).map((i) => [`${i.scope}:${i.filename}`, i]));
  assert.deepEqual(Object.keys(flagged).sort(), ["lab:ppai-ai-models-page.png", "library:ppai-ai-hub-menu.png", "library:ppai-ai-models-page.png", "library:ppai-docproc-fields.png"]);
  assert.ok(Object.values(flagged).every((i) => i.level === "definite"));
  assert.equal(scan.items.find((i) => i.filename === "ppai-prompt-builder-editor.png").level, null);
  assert.equal(flagged["lab:ppai-ai-models-page.png"].flags[0].code, FLAGS.LANDING_PAGE, "a copy in a lab takes the saved check of the same picture");

  const report = buildAuditReport(scan, { root: labs, library: lib, captureDir: join(data, "capture"), mode: "library and labs" });
  assert.equal(report.json.distinct, 3);
  assert.equal(report.json.counts.byFlag[FLAGS.LANDING_PAGE], 4);
  assert.equal(report.json.counts.byFlag[FLAGS.DUPLICATE_ACROSS_SLOTS] >= 2, true);
  assert.equal(report.json.counts.byFlag[FLAGS.NEAR_DUPLICATE] >= 1, true);
  assert.equal(report.json.pictures.every((p) => p.fingerprint === null || /^[0-9a-f]{64}$/.test(p.fingerprint.d)), true);
  const markdown = renderMarkdown(report);
  for (const name of ["ppai-ai-models-page.png", "ppai-ai-hub-menu.png", "ppai-docproc-fields.png"]) assert.ok(markdown.includes(name), name);
  assert.match(markdown, /What this cannot detect/);
  assert.match(markdown, /no OCR/);
  assert.match(markdown, /\| LANDING_PAGE \| 4 \|/);
  const sheet = renderContactSheet(report);
  assert.equal((sheet.match(/<img /g) || []).length, 5, "a thumbnail for every picture");
  assert.match(sheet, /file:\/\//, "the pictures are shown from where they are, not copied");
  assert.doesNotMatch(sheet, /<script/i);
});

test("the audit command writes its report outside the repository, refuses to write inside it, and changes nothing", () => {
  const { lib, labs, data } = syntheticData();
  const out = tmp("picture-audit-out-");
  const before = readdirSync(lib).sort();
  const run = (extra) => spawnSync(process.execPath, [join(REPO_ROOT, "tools", "lab-builder", "audit-screenshots.mjs"), `--library-dir=${lib}`, `--root=${labs}`, `--data=${data}`, ...extra], { encoding: "utf8", env: { ...process.env, PORTAL_STORAGE_ROOT: "" } });
  const ok = run([`--out=${out}`]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /5 pictures checked \(3 distinct\)\. 4 flagged: 4 definite, 0 probable\./);
  for (const name of ["audit.md", "audit.json", "contact-sheet.html"]) assert.ok(existsSync(join(out, name)), name);
  assert.equal(JSON.parse(readFileSync(join(out, "audit.json"), "utf8")).counts.definite, 4);
  assert.deepEqual(readdirSync(lib).sort(), before, "read only");
  const inside = run([`--out=${join(REPO_ROOT, "tools", "audit-output-should-not-exist")}`]);
  assert.equal(inside.status, 2);
  assert.match(inside.stderr, /inside this repository/);
  assert.equal(existsSync(join(REPO_ROOT, "tools", "audit-output-should-not-exist")), false);
});

// ── Moving them to the kept pictures list, and back ─────────────────────────

const labState = {};
async function aiHubLab(storageRoot) {
  const emptyLabs = tmp("picture-empty-labs-");
  const build = await generateLab({ products: ["power-platform-ai-hub"], features: ["ppai-explore-ai-hub-models"], includeCore: false }, { outputRoot: join(storageRoot, "generated-labs"), labsDir: emptyLabs, useLearnMcp: false, useLlm: false });
  const shots = JSON.parse(readFileSync(join(build.outputDir, "screenshots", "shots.json"), "utf8")).shots;
  return { labId: build.labId, labDir: build.outputDir, files: shots.map((s) => s.filename) };
}

function platformAt(storageRoot, extra = {}) {
  return createCapturePlatform({ generatedRoot: join(storageRoot, "generated-labs"), dataDir: join(storageRoot, "data"), env: { PORTAL_STORAGE_ROOT: storageRoot, CAPTURE_STARTUP_SCAN: "off", ...extra }, detectServerBrowser: async () => ({ available: false }) });
}

/** Evidence for a picture of this slot: the address and labels it should show, as the current companion reports them. */
function evidence(store, target, filename, { steps, finalUrl = HOME_URL } = {}) {
  const slot = target.slot(filename);
  return { version: 2, finalUrl, title: "Power Apps", visibleText: [...(slot.expectedLabels || []), "Settings"], redaction: { applied: true, masked: 2, controls: 1 }, signals: { signInVisible: false, accountControl: true }, capturedAt: new Date().toISOString(), executedSteps: 3, mode: "autonomous", routeSteps: steps || [open(), shot] };
}
const upload = (store, target, filename, bytes, options = {}) => store.submit(target, filename, bytes, { evidence: evidence(store, target, filename, options), source: "companion", requireEvidence: true, requireRedaction: true, requireProof: true, defer: true, companionVersion: "1.7.0" });

before(async () => {
  labState.storage = join(tmp("picture-store-"), "storage");
  labState.lab = await aiHubLab(labState.storage);
  labState.platform = platformAt(labState.storage);
  labState.store = labState.platform.screenshots;
  labState.libDir = join(labState.storage, "screenshots");
});

test("a start page for a deeper slot is never accepted by itself at upload, accept, or promotion, and the same picture for another slot waits for a person", async () => {
  const store = labState.store;
  const [a, b] = labState.lab.files;
  const library = store.library();
  const home = homePage();

  // The companion took the start page for a slot that describes a deeper screen: it is saved for review, with the plain reason.
  const landing = upload(store, library, "ppai-ai-models-page.png", home);
  assert.equal(landing.status, 202, JSON.stringify(landing.body));
  assert.ok(landing.body.verification.reasons.some((r) => r.code === "landing-page"), "a start page for a deeper slot");
  assert.match(landing.body.verification.reasons.find((r) => r.code === "landing-page").message, /start page/);
  assert.equal(existsSyncLibrary("ppai-ai-models-page.png"), false, "nothing was written to the library");

  // The screen the computer opened is accepted.
  const hub = hubPage();
  const good = upload(store, library, "ppai-ai-models-page.png", hub, { steps: [open(), clicked("open", "AI hub"), shot] });
  assert.equal(good.status, 200, JSON.stringify(good.body));
  assert.equal(good.body.verification.evidenceVersion, 2);
  assert.equal(good.body.verification.companionVersion, "1.7.0");
  assert.match(good.body.verification.fingerprint.d, /^[0-9a-f]{64}$/, "what it looks like is kept with its check");

  // The same picture for a different slot, reached with nothing but the start page: it cannot be right for both.
  const twin = upload(store, library, "ppai-docproc-fields.png", hub);
  assert.equal(twin.status, 202);
  const reasons = twin.body.verification.reasons.map((r) => r.code);
  assert.ok(reasons.includes("duplicate-picture") && reasons.includes("landing-page"), reasons.join(","));
  assert.match(twin.body.verification.reasons.find((r) => r.code === "duplicate-picture").message, /^This looks the same as “The AI models page”/);

  // A person who looked and accepted it says it is right: it is marked Keep this one, so it is not flagged again.
  const accepted = store.accept(library, "ppai-docproc-fields.png", { defer: true });
  assert.equal(accepted.status, 200);
  const state = store.libraryState().shots.find((s) => s.filename === "ppai-docproc-fields.png");
  assert.ok(state.confirmed, "accepting a flagged picture marks it Keep this one");
  assert.equal(store.suspectPictures().body.pictures.some((p) => p.filename === "ppai-docproc-fields.png"), false);

  // The lab's own pictures follow the same rules, and a picture that looks wrong is not shared with every lab.
  const target = store.lab(labState.lab.labId);
  const labPicture = upload(store, target, a, formPage(), { steps: [open(), shot] });
  assert.equal(labPicture.status, 202, "the start page is not the screen this slot describes, in a lab as well");
  const handIn = store.submit(target, b, homePage(), { evidence: null, source: "manual-upload" });
  assert.equal(handIn.status, 200, "a picture a person puts in by hand has no steps to judge, so it is the person's call");
  const shared = store.shareLabPicture(target, b, { confirm: true });
  assert.equal(shared.status, 200, JSON.stringify(shared.body));
});

function existsSyncLibrary(name) {
  return existsSync(join(labState.libDir, name));
}

test("an upload with no evidence, an older companion's evidence, a signed-out page, and a missing landmark are each saved for review or refused, never accepted by themselves", () => {
  const store = labState.store;
  const library = store.library();
  const slot = library.slot("ppai-ai-hub-menu.png");
  const withEvidence = (value, bytes = formPage()) => store.submit(library, "ppai-ai-hub-menu.png", bytes, { evidence: value, source: "companion", requireEvidence: true, requireRedaction: true, requireProof: true, defer: true });
  const good = evidence(store, library, "ppai-ai-hub-menu.png", { steps: [open(), clicked("open", "AI hub"), shot] });

  const none = withEvidence(null);
  assert.equal(none.status, 202);
  assert.equal(none.body.verification.reasons[0].message, "Update your Local Capture Companion. Older versions cannot prove the screen, so their pictures are saved for review.");

  const older = withEvidence({ ...good, version: undefined, signals: undefined, redaction: { applied: true, masked: 2 } }, hubPage());
  assert.equal(older.status, 202);
  assert.ok(older.body.verification.reasons.some((r) => r.code === "old-companion"));

  const signedOut = withEvidence({ ...good, visibleText: ["Sign in", "Pricing"], signals: { signInVisible: true, accountControl: false }, redaction: { applied: true, masked: 0, controls: 0 } }, homePage());
  assert.equal(signedOut.status, 422, "a page that offers Sign in and shows no account is refused");
  assert.equal(signedOut.body.verification.reasons[0].code, "signed-out-page");
  assert.match(signedOut.body.message, /You are not signed in to/);

  const oldSignedOut = withEvidence({ finalUrl: HOME_URL, title: "Microsoft Foundry", visibleText: ["Sign in", "Explore models"], redaction: { applied: true, masked: 0 }, mode: "autonomous" }, homePage());
  assert.equal(oldSignedOut.status, 422, "an older companion's evidence proves it too: a Sign in button and nothing masked");

  const missing = withEvidence({ ...good, visibleText: ["Pricing"] }, hubPage());
  assert.equal(missing.status, 202, "a missing landmark is Needs review even when the address matches");
  assert.ok(missing.body.verification.reasons.some((r) => r.code === "labels-missing" || r.code === "screen-unproven"));

  const unmasked = withEvidence({ ...good, redaction: { applied: true, masked: 2, controls: 1, lists: 2, listsMasked: 0 } }, hubPage());
  assert.equal(unmasked.status, 202);
  assert.ok(unmasked.body.verification.reasons.some((r) => r.code === "list-not-masked"), "a list page whose list was not hidden");
  assert.ok(slot.expectedLabels.length >= 0);

  // Nothing above wrote a picture; a correct, unique picture with proper evidence is still accepted and kept.
  const fine = withEvidence(good, hubPage());
  assert.equal(fine.status, 200, JSON.stringify(fine.body));
  assert.equal(fine.body.verification.level, "pass");
  assert.deepEqual(fine.body.verification.reasons, []);
});

test("a library picture that looks wrong is not copied into a new lab, and a clean one still is", async () => {
  const storage = join(tmp("picture-reuse-"), "storage");
  const platform = platformAt(storage);
  const store = platform.screenshots;
  const library = store.library();
  const previous = process.env.FEATURE_TOUR_SCREENSHOTS_DIR;
  process.env.FEATURE_TOUR_SCREENSHOTS_DIR = join(storage, "screenshots");
  try {
    // A good picture and a start page for the other slot of the same lab, both with a saved check.
    const hub = hubPage();
    const good = upload(store, library, "ppai-ai-models-page.png", hub, { steps: [open(), clicked("open", "AI hub"), shot] });
    assert.equal(good.status, 200, JSON.stringify(good.body));
    const dir = join(storage, "screenshots");
    const home = homePage();
    writeFileSync(join(dir, "ppai-ai-hub-menu.png"), home);
    const records = JSON.parse(readFileSync(join(storage, "data", "capture", "library-verification.json"), "utf8"));
    records.shots["ppai-ai-hub-menu.png"] = checkFor(home);
    writeFileSync(join(storage, "data", "capture", "library-verification.json"), JSON.stringify(records));
    store.forgetSuspects();

    assert.equal(store.reuseVerdict(join(dir, "ppai-ai-models-page.png")).ok, true);
    const refused = store.reuseVerdict(join(dir, "ppai-ai-hub-menu.png"));
    assert.equal(refused.ok, false);
    assert.match(refused.message, /start page/);

    const lab = await aiHubLab(storage);
    const status = getLabScreenshotsStatus(join(storage, "generated-labs"), lab.labId, { capturedDir: [dir] }).body;
    const copied = (name) => existsSync(join(lab.labDir, "assets", name)) && readFileSync(join(lab.labDir, "assets", name)).length > 5000;
    assert.equal(copied("ppai-ai-models-page.png"), true, "the clean picture is reused");
    assert.equal(copied("ppai-ai-hub-menu.png"), false, "the start page is not copied: the slot stays pending");
    assert.equal(status.shots.find((s) => s.filename === "ppai-ai-hub-menu.png").captured, false);
  } finally {
    if (previous === undefined) delete process.env.FEATURE_TOUR_SCREENSHOTS_DIR;
    else process.env.FEATURE_TOUR_SCREENSHOTS_DIR = previous;
  }
});

test("moving the pictures that look wrong: a dry run changes nothing, apply keeps each one first, the slots go back to pending, and restore puts them back", async () => {
  const storage = join(tmp("picture-quarantine-"), "storage");
  const platform = platformAt(storage);
  const store = platform.screenshots;
  const lab = await aiHubLab(storage);
  const dir = join(storage, "screenshots");
  mkdirSync(dir, { recursive: true });
  const home = homePage();
  const hub = hubPage();
  const recordsFile = join(storage, "data", "capture", "library-verification.json");
  mkdirSync(dirname(recordsFile), { recursive: true });
  const shots = {};
  const place = (name, bytes, record) => {
    writeFileSync(join(dir, name), bytes);
    shots[name] = record;
  };
  place("ppai-ai-models-page.png", home, checkFor(home));
  place("ppai-ai-hub-menu.png", home, checkFor(home));
  place("ppai-prompt-builder-editor.png", hub, checkFor(hub, { steps: [open(), clicked("open", "AI hub"), shot] }));
  writeFileSync(recordsFile, JSON.stringify({ schema: 1, shots }));
  // The lab holds a copy of a bad picture (made when it was built) and a picture of its own that is fine.
  const labAssets = join(lab.labDir, "assets");
  writeFileSync(join(labAssets, "ppai-ai-models-page.png"), home);
  const own = lab.files.find((f) => !["ppai-ai-models-page.png", "ppai-ai-hub-menu.png"].includes(f));
  if (own) writeFileSync(join(labAssets, own), formPage());
  writeLabVerificationRecord(lab.labDir, "ppai-ai-models-page.png", checkFor(home));
  store.forgetSuspects();

  const dry = store.quarantineWrongPictures({ dryRun: true });
  assert.equal(dry.status, 200);
  assert.equal(dry.body.dryRun, true);
  assert.deepEqual([dry.body.counts.library, dry.body.counts.lab, dry.body.counts.slotsPending], [2, 1, 2]);
  assert.match(dry.body.report, /3 pictures would move to the kept pictures list/);
  assert.match(dry.body.report, /Nothing was changed\./);
  assert.equal(readdirSync(dir).length, 3, "a dry run moves nothing");
  assert.equal(platform.screenshots.keptSummary().pictures, 0);

  const applied = store.quarantineWrongPictures({ dryRun: false });
  assert.equal(applied.body.moved.length, 3);
  assert.equal(applied.body.failed.length, 0);
  assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".png")), ["ppai-prompt-builder-editor.png"], "only the good picture is left in the library");
  assert.equal(readdirSync(dir).some((n) => n.endsWith(".previous")), false, "no copy of a bad picture is left beside it");
  const savedRecords = JSON.parse(readFileSync(recordsFile, "utf8")).shots;
  assert.deepEqual(Object.keys(savedRecords), ["ppai-prompt-builder-editor.png"], "their checks left with them");
  assert.equal(readLabVerification(lab.labDir)["ppai-ai-models-page.png"], undefined);
  await store.flushLibrary();
  const labStatus = getLabScreenshotsStatus(join(storage, "generated-labs"), lab.labId, { capturedDir: [dir] }).body;
  const pending = labStatus.shots.find((s) => s.filename === "ppai-ai-models-page.png");
  assert.equal(pending.captured, false, "the lab shows the slot as pending again");
  assert.ok(readFileSync(join(labAssets, "ppai-ai-models-page.png")).length < 5000, "the lab's copy is the placeholder again");
  if (own) assert.ok(readFileSync(join(labAssets, own)).length > 5000, "a good picture in the lab is untouched");
  assert.equal(store.quarantineWrongPictures({ dryRun: false }).body.moved.length, 0, "running it again changes nothing more");

  // They are in the kept pictures list, with their checks, and can be restored.
  const kept = store.keptOverview();
  const entries = kept.entries.filter((e) => e.reason === "looks-wrong");
  assert.deepEqual(entries.map((e) => e.labId).sort(), [lab.labId, "shared-library"].sort());
  const libraryEntry = entries.find((e) => e.labId === "shared-library");
  assert.deepEqual(libraryEntry.pictures.map((p) => p.filename).sort(), ["ppai-ai-hub-menu.png", "ppai-ai-models-page.png"]);
  assert.ok(libraryEntry.pictures.every((p) => p.hasCheck && p.why === "looks-wrong" && p.restore.some((o) => o.type === "library")));
  const restoredLab = store.restoreKept(entries.find((e) => e.labId === lab.labId).id, "ppai-ai-models-page.png", { to: "lab", labId: lab.labId });
  assert.equal(restoredLab.status, 200, JSON.stringify(restoredLab.body));
  assert.ok(readFileSync(join(labAssets, "ppai-ai-models-page.png")).length > 5000, "the picture is back where it was");
  assert.ok(Object.keys(readLabConfirmations(lab.labDir)).includes("ppai-ai-models-page.png"), "a person who restores it has looked: it is marked Keep this one");
  const restoredLibrary = store.restoreKept(libraryEntry.id, "ppai-ai-hub-menu.png", { to: "library", confirm: true });
  assert.equal(restoredLibrary.status, 200, JSON.stringify(restoredLibrary.body));
  assert.ok(existsSync(join(dir, "ppai-ai-hub-menu.png")));
  assert.equal(store.suspectPictures({ labId: lab.labId }).body.pictures.some((p) => ["ppai-ai-hub-menu.png"].includes(p.filename)), false, "a restored picture is not flagged again");
});

test("choosing pictures moves exactly those; the ones that only need a look stay unless asked; the command line does the same with --dry-run first", async () => {
  const storage = join(tmp("picture-cli-"), "storage");
  const platform = platformAt(storage);
  const store = platform.screenshots;
  const dir = join(storage, "screenshots");
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(storage, "generated-labs"), { recursive: true });
  const hub = hubPage();
  const recordsFile = join(storage, "data", "capture", "library-verification.json");
  mkdirSync(dirname(recordsFile), { recursive: true });
  const steps = [open(), clicked("open", "More options"), clicked("choose", "Settings"), shot];
  writeFileSync(join(dir, "ppai-ai-models-page.png"), hub);
  writeFileSync(join(dir, "ppai-ai-hub-menu.png"), hub);
  writeFileSync(recordsFile, JSON.stringify({ schema: 1, shots: { "ppai-ai-models-page.png": checkFor(hub, { steps }), "ppai-ai-hub-menu.png": checkFor(hub, { steps }) } }));
  store.forgetSuspects();
  const flagged = store.suspectPictures().body;
  assert.deepEqual([flagged.counts.definite, flagged.counts.probable], [0, 2], "two slots that may share a screen are worth a look, not wrong");
  assert.equal(store.quarantineWrongPictures({ dryRun: false }).body.moved.length, 0, "probable ones are never moved by default");
  const chosen = store.quarantineWrongPictures({ dryRun: false, items: [{ scope: "library", filename: "ppai-ai-hub-menu.png" }] });
  assert.deepEqual(chosen.body.moved.map((m) => m.filename), ["ppai-ai-hub-menu.png"]);
  assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith(".png")), ["ppai-ai-models-page.png"]);
  const missing = store.quarantineWrongPictures({ dryRun: false, items: [{ scope: "library", filename: "ppai-prompt-builder-editor.png" }] });
  assert.equal(missing.body.moved.length, 0);
  assert.match(missing.body.notMoved[0].why, /not flagged/);

  // The command line: a dry run is the default, --apply moves, and a report outside the repository is written on request.
  const cli = (...args) => spawnSync(process.execPath, [join(REPO_ROOT, "tools", "lab-builder", "quarantine-screenshots.mjs"), `--library-dir=${dir}`, `--root=${join(storage, "generated-labs")}`, `--data=${join(storage, "data")}`, ...args], { encoding: "utf8", env: { ...process.env, PORTAL_STORAGE_ROOT: "" } });
  const bad = tmp("picture-cli-bad-");
  const home = homePage();
  writeFileSync(join(dir, "ppai-docproc-fields.png"), home);
  const records = JSON.parse(readFileSync(recordsFile, "utf8"));
  records.shots["ppai-docproc-fields.png"] = checkFor(home);
  writeFileSync(recordsFile, JSON.stringify(records));
  const reportFile = join(bad, "report.md");
  const dryRun = cli("--dry-run", `--report=${reportFile}`);
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /1 picture would move to the kept pictures list/);
  assert.match(dryRun.stdout, /Run again with --apply/);
  assert.ok(existsSync(join(dir, "ppai-docproc-fields.png")));
  assert.match(readFileSync(reportFile, "utf8"), /Dry run \(nothing was changed\)/);
  assert.equal(cli("--apply", "--dry-run").status, 2, "the two choices exclude each other");
  assert.equal(cli("--dry-run", `--report=${join(REPO_ROOT, "tools", "report-should-not-exist.md")}`).status, 2, "never a report inside the repository");
  const apply = cli("--apply");
  assert.equal(apply.status, 0, apply.stderr);
  assert.match(apply.stdout, /Moved 1 picture to the kept pictures list/);
  assert.equal(existsSync(join(dir, "ppai-docproc-fields.png")), false);
});
