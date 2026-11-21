/**
 * Save and resume in a real browser (headless Chromium, a throwaway profile, a throwaway port, a throwaway storage folder):
 * configure a partial lab through several steps, Save and finish later, reload the page, Resume from Saved drafts, check
 * every choice and the step are the same, and carry on to build a lab. A second test checks the autosave banner after a
 * reload. The server tests at the top need no browser: they check what the real server does with drafts on disk.
 *
 * Deterministic: no language model and no Microsoft Learn (the topic list comes from the committed snapshot).
 * Set DRAFTS_DEMO_DIR to a folder to also save screenshots of each moment (for review; nothing is written there otherwise).
 * The browser tests skip themselves when Playwright or a Chromium build is not installed (tools/screenshot-capture: npm install).
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PORTAL_ROOT = resolve(here, "..");
const PLAYWRIGHT = resolve(PORTAL_ROOT, "..", "tools", "screenshot-capture", "node_modules", "playwright", "index.mjs");
const DEMO_DIR = process.env.DRAFTS_DEMO_DIR ? resolve(process.env.DRAFTS_DEMO_DIR) : "";
const cleanups = [];
const ctx = {};

function tmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A free port in 3062 to 3069 (the range this feature's servers use), or any free port when those are taken. */
function freePort() {
  const probe = (port) =>
    new Promise((resolvePort) => {
      const server = createServer();
      server.once("error", () => resolvePort(0));
      server.listen(port, "127.0.0.1", () => {
        const { port: bound } = server.address();
        server.close(() => resolvePort(bound));
      });
    });
  return (async () => {
    for (let port = 3062; port <= 3069; port += 1) {
      const got = await probe(port);
      if (got) return got;
    }
    return probe(0);
  })();
}

const api = async (path, init = {}) => {
  const res = await fetch(`${ctx.base}${path}`, { ...init, headers: { ...(init.body ? { "Content-Type": "application/json" } : {}), ...(init.headers || {}) } });
  return { status: res.status, body: await res.json().catch(() => null) };
};

before(async (t) => {
  ctx.storageRoot = join(tmp("lb-drafts-browser-"), "storage");
  ctx.generated = join(ctx.storageRoot, "generated-labs");
  ctx.data = join(ctx.storageRoot, "data");
  ctx.shots = join(ctx.storageRoot, "screenshots");
  ctx.port = await freePort();
  ctx.base = `http://127.0.0.1:${ctx.port}`;
  let stderr = "";
  const child = spawn(process.execPath, ["server.js"], {
    cwd: PORTAL_ROOT,
    env: {
      ...process.env,
      PORT: String(ctx.port),
      HOST: "127.0.0.1",
      PORTAL_AUTH_DISABLED: "true",
      AZURE_KEYVAULT_URL: "",
      AZURE_STORAGE_BLOB_ENDPOINT: "",
      PORTAL_STORAGE_ROOT: ctx.storageRoot,
      LAB_BUILDER_OUTPUT_DIR: ctx.generated,
      PORTAL_DATA_DIR: ctx.data,
      FEATURE_TOUR_SCREENSHOTS_DIR: ctx.shots,
      LAB_BUILDER_LINK_CHECK: "off",
      LAB_BUILDER_LLM: "off",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  cleanups.push(() => child.kill());
  const deadline = Date.now() + 40000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}): ${stderr.slice(-800)}`);
    try {
      if ((await fetch(`${ctx.base}/healthz`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server did not start: ${stderr.slice(-800)}`);
    await new Promise((r) => setTimeout(r, 150));
  }

  if (!existsSync(PLAYWRIGHT)) {
    ctx.skipReason = "Playwright is not installed (tools/screenshot-capture: npm install).";
    return;
  }
  try {
    const { chromium } = await import(pathToFileURL(PLAYWRIGHT).href);
    ctx.browser = await chromium.launch({ headless: true });
    cleanups.push(() => ctx.browser?.close());
  } catch (err) {
    ctx.skipReason = `No headless Chromium is available: ${err.message.split("\n")[0]}`;
  }
});

after(() => {
  for (const clean of cleanups.reverse()) {
    try {
      clean();
    } catch {
      /* best effort */
    }
  }
});

const draftFiles = () => {
  const folder = join(ctx.data, "lab-builder", "drafts", "local");
  return existsSync(folder) ? readdirSync(folder) : [];
};

// ── The real server ─────────────────────────────────────────────────────────

test("the real server keeps drafts under the data folder, takes a large draft, and refuses an oversized body in plain words", async () => {
  const sub = (i) => `learn-sub-${String(i).padStart(5, "0")}-${"x".repeat(60)}`;
  const content = (count) => ({ selections: { products: ["copilot-studio"], excludedSubtopics: Array.from({ length: count }, (_, i) => sub(i)) }, wizard: { step: 3 } });

  // About 130 KB: over the 64 KB every other lab builder route allows, under the 256 KB a draft may hold.
  const large = await api("/api/lab-builder/drafts", { method: "POST", body: JSON.stringify({ name: "Large draft", content: content(1800) }) });
  assert.equal(large.status, 201, JSON.stringify(large.body).slice(0, 200));
  assert.equal(large.body.draft.content.selections.excludedSubtopics.length, 1800);
  const id = large.body.draft.id;
  assert.deepEqual(draftFiles(), [`${id}.json`], "the draft is one file under <data folder>/lab-builder/drafts");

  const tooMany = await api("/api/lab-builder/drafts", { method: "POST", body: JSON.stringify({ name: "Too large to keep", content: content(4000) }) });
  assert.equal(tooMany.status, 413);
  assert.match(tooMany.body.error, /too large to save.*Leave out some topics/);

  const oversized = await api("/api/lab-builder/drafts", { method: "POST", body: JSON.stringify({ name: "Way too big", content: content(6000) }) });
  assert.equal(oversized.status, 413);
  assert.equal(oversized.body.error, "Request body is too large.");

  const other = await api("/api/lab-builder/recommend", { method: "POST", body: JSON.stringify({ products: ["copilot-studio"], level: 200, harness: "standard", pad: "y".repeat(70 * 1024) }) });
  assert.equal(other.status, 413, "the other lab builder routes keep their 64 KB limit");

  assert.equal((await api("/api/lab-builder/drafts/..%2F..%2Fserver")).status, 400);
  assert.equal((await api(`/api/lab-builder/drafts/${id}`, { method: "DELETE" })).status, 200);
  assert.deepEqual(draftFiles(), []);
});

// ── The wizard in a browser ─────────────────────────────────────────────────

async function recommendPicks() {
  const res = await api("/api/lab-builder/recommend", { method: "POST", body: JSON.stringify({ products: ["copilot-studio"], level: 200, harness: "standard" }) });
  const rows = res.body.concepts.flatMap((c) => c.topics);
  const catalog = rows.filter((t) => t.source !== "learn").slice(0, 3).map((t) => t.id);
  const withSub = rows.find((t) => t.source === "learn" && (t.learn?.subtopics || []).length >= 1);
  return { catalog, parent: withSub.id, parentName: withSub.name, sub: withSub.learn.subtopics[0].id };
}

async function shot(page, name) {
  if (!DEMO_DIR) return;
  mkdirSync(DEMO_DIR, { recursive: true });
  await page.screenshot({ path: join(DEMO_DIR, `${name}.png`) });
}

const next = (page, step) => page.click(`#lb-pane-${step} .lb-nav-next`);
const back = (page, step) => page.click(`#lb-pane-${step} .lb-nav-back`);
const stepIs = async (page, step) => {
  try {
    await page.waitForFunction((n) => labBuilder.step === n && document.activeElement?.id === `lb-heading-${n}`, step, { timeout: 15000 });
  } catch (err) {
    const where = await page.evaluate(() => ({ step: labBuilder.step, focus: document.activeElement?.id, error: ["lb-product-error", "lb-topic-error", "lb-review-error", "lb-sharepoint-site-error"].map((id) => document.getElementById(id)?.textContent || "").filter(Boolean) }));
    await shot(page, `failure-waiting-for-step-${step}`);
    throw new Error(`Expected Step ${step}: ${JSON.stringify(where)} (${err.message.split("\n")[0]})`);
  }
};

test("configure a partial lab, save and finish later, reload, resume, find every choice unchanged, and build", async (t) => {
  if (!ctx.browser) return t.skip(ctx.skipReason);
  const features = (await api("/api/lab-builder/features")).body;
  const industry = features.industries[0].id;
  const roles = features.roles.slice(0, 2).map((r) => r.id);
  const picks = await recommendPicks();
  const page = await ctx.browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  t.after(() => page.close());

  await page.goto(`${ctx.base}/#labbuilder`);
  await page.waitForSelector('input[name="lb-product"]');
  await shot(page, "01-wizard-before-saving");

  // Steps 1 and 2: the product, then everything on Tailor it in one step.
  await page.check('input[name="lb-product"][value="copilot-studio"]');
  await next(page, 1);
  await stepIs(page, 2);
  await page.selectOption("#lb-industry-select", industry);
  for (const role of roles) await page.check(`input[name="lb-role"][value="${role}"]`);
  await page.check('input[name="lb-level"][value="200"]');
  await page.check('input[name="lb-harness"][value="standard"]');
  await next(page, 2);
  await stepIs(page, 3);

  // Step 3: Topics arrives with the suggestion already selected, so there is nothing to click to get it.
  await page.waitForSelector("#lb-topic-groups details.lb-concept");
  assert.match(await page.textContent("#lb-topic-summary"), /^Suggested lab: \d+ topics?/);
  assert.equal(await page.evaluate(() => labBuilder.pickedAuto), true, "the picks are the suggestion until the person changes one");
  const suggested = await page.evaluate(() => [...labBuilder.picked].sort());
  assert.ok(suggested.length > 0, "the suggestion is not empty");

  // The search, Show filter, and bulk actions are behind Change.
  assert.equal(await page.isHidden("#lb-topic-tools"), true, "the tools start closed");
  await page.click("#lb-topic-change");
  assert.equal(await page.isVisible("#lb-topic-tools"), true);
  assert.equal(await page.getAttribute("#lb-topic-change", "aria-expanded"), "true");
  for (const name of ["Back to suggested", "Select all", "Clear"]) assert.equal(await page.isVisible(`#lb-topic-tools button:text-is("${name}")`), true, name);
  assert.equal(await page.locator('#lb-pane-3 button:has-text("Select recommended")').count(), 0, "Select recommended is gone");
  assert.equal(await page.locator('#lb-pane-3 button:has-text("Reset to my answers")').count(), 0, "so is Reset to my answers");

  // Pick a topic by hand that the suggestion left out: the groups are collapsed, so open them first.
  await page.evaluate(() => document.querySelectorAll("#lb-topic-groups details.lb-concept").forEach((d) => (d.open = true)));
  const extra = await page.evaluate(() => lbTopicRows().find((t) => !t.selected && !t.required && !t.thirdPartyConnector && !(t.learn?.subtopics || []).length)?.id);
  assert.ok(extra, "the suggestion leaves at least one topic out");
  await page.check(`input[data-topic="${extra}"]`);
  await page.waitForSelector(`input[data-topic="${extra}"]:checked`);
  await page.waitForFunction(() => /^Your lab: \d+ topics?/.test(document.getElementById("lb-topic-summary").textContent));
  assert.equal(await page.evaluate(() => labBuilder.pickedAuto), false, "after a change the line says Your lab");

  // Back to suggested puts the suggestion back, whatever was changed since.
  await page.click('#lb-topic-tools button:text-is("Back to suggested")');
  await page.waitForFunction(() => labBuilder.pickedAuto === true && /^Suggested lab: /.test(document.getElementById("lb-topic-summary").textContent));
  assert.deepEqual(await page.evaluate(() => [...labBuilder.picked].sort()), suggested);
  assert.equal(await page.isChecked(`input[data-topic="${extra}"]`), false, "the topic added by hand is out again");

  // The lab is built on the suggestion plus the topics this test needs, and one sub-topic is left out.
  await page.evaluate(() => document.querySelectorAll("#lb-topic-groups details.lb-concept").forEach((d) => (d.open = true)));
  for (const id of picks.catalog) {
    await page.check(`input[data-topic="${id}"]`);
    await page.waitForSelector(`input[data-topic="${id}"]:checked`);
  }
  await page.fill("#lb-topic-search", picks.parentName);
  await page.waitForSelector(`input[data-topic="${picks.parent}"]`, { state: "visible" });
  await page.check(`input[data-topic="${picks.parent}"]`);
  await page.click(`button[data-row-toggle="${picks.parent}"][aria-expanded="false"]`);
  await page.waitForSelector(`input[data-subtopic="${picks.sub}"]:checked`);
  await page.uncheck(`input[data-subtopic="${picks.sub}"]`);
  await page.waitForSelector(`input[data-topic="${picks.parent}"][data-subtopic-state="some"]`);
  await page.fill("#lb-topic-search", "");

  // Step 4: take a module out, move one, and set the lab's name, agent, and time.
  await next(page, 3);
  await stepIs(page, 4);
  await page.waitForSelector("#lb-preview table");
  assert.equal(await page.locator("#lb-preview button[data-outline-move]").count(), 0, "the move buttons wait for Edit order");
  await page.click('#lb-preview button[data-outline-action="toggle-edit"]');
  await page.uncheck(`#lb-preview input[data-outline-module="${picks.catalog[1]}"]`);
  await page.waitForSelector(".lb-removed-section");
  await page.click(`#lb-preview button[data-outline-move="down"][data-outline-module="${picks.catalog[0]}"]`);
  await page.waitForSelector(".lb-outline-order-bar");
  await page.evaluate(() => document.querySelectorAll("#lb-pane-4 details").forEach((d) => (d.open = true)));
  await page.fill("#lb-title", "Contoso e2e lab");
  await page.fill("#lb-agent-name", "Contoso Assistant");
  await page.fill("#lb-time", "150");
  await page.evaluate(() => {
    lbSetFormValue("lb-sharepoint-site-name", "Contoso Team");
    lbSetFormValue("lb-sharepoint-site-url", "https://contoso.sharepoint.com/sites/team");
  });

  // Save and finish later.
  await page.click("#lb-save-draft");
  await page.waitForSelector("#lb-draft-name-dialog[open]");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "lb-draft-name", "the name field has focus");
  await shot(page, "02-save-dialog");
  await page.fill("#lb-draft-name", "Contoso e2e draft");
  await page.click("#lb-draft-name-save");
  await page.waitForFunction(() => /^Saved\. You can pick this up later under Saved drafts\./.test(document.getElementById("lb-draft-status").textContent));
  await shot(page, "03-after-saving");
  const before = await page.evaluate(() => JSON.parse(JSON.stringify(lbDraftContent())));
  assert.equal(before.wizard.step, 4);
  assert.deepEqual(before.wizard.removed.map((r) => r.id), [picks.catalog[1]]);
  assert.deepEqual(before.selections.excludedSubtopics, [picks.sub]);
  assert.equal(before.selections.sharepointSiteName, "Contoso Team");
  assert.equal(before.selections.sharepointSiteUrl, "https://contoso.sharepoint.com/sites/team");
  assert.equal(before.selections.targetMinutes, 150);
  assert.equal(draftFiles().length, 1);

  // A refresh: the page starts empty, the draft is waiting under Saved drafts, and there is no unsaved-work banner.
  await page.reload();
  await page.waitForSelector('input[name="lb-product"]');
  await page.waitForFunction(() => document.getElementById("lb-drafts-badge").textContent === "1");
  assert.equal(await page.evaluate(() => labBuilder.selectedProducts.size), 0, "the wizard starts empty");
  assert.equal(await page.isHidden("#lb-unsaved-banner"), true, "saving on purpose left nothing unsaved");
  assert.equal(await page.evaluate(() => document.getElementById("lb-drafts-details").open), false, "Saved drafts starts collapsed");
  await page.click("#lb-drafts-details > summary");
  await page.waitForSelector("#lb-drafts-list .lb-gen-item");
  await shot(page, "04-saved-drafts-panel");
  assert.match(await page.textContent("#lb-drafts-list .lb-gen-item"), /Contoso e2e draft.*Copilot Studio · Level 200 \(Intermediate\) · Step 4 of 4: Review and build · \d+ topics?/s);

  // Resume.
  await page.click('#lb-drafts-list button[aria-label="Resume Contoso e2e draft"]');
  await stepIs(page, 4);
  await page.waitForSelector("#lb-preview table");
  await shot(page, "05-after-resume");
  const after = await page.evaluate(() => JSON.parse(JSON.stringify(lbDraftContent())));
  assert.deepEqual(after.selections, before.selections, "every choice is the same");
  assert.deepEqual(after.wizard, before.wizard, "and so are the step, the picks, and the removed modules");
  assert.match(await page.textContent("#lb-draft-announce"), /^Resumed "Contoso e2e draft"\. You are on Step 4 of 4: Review and build\.$/);
  assert.match(await page.textContent("#lb-draft-notice"), /Resumed "Contoso e2e draft"\. You are on Step 4 of 4: Review and build\./);
  assert.equal(await page.inputValue("#lb-title"), "Contoso e2e lab");
  assert.equal(await page.inputValue("#lb-agent-name"), "Contoso Assistant");
  assert.equal(await page.inputValue("#lb-time"), "150");
  assert.match(await page.textContent(".lb-removed-section"), /Removed from curriculum \(1\)/);
  assert.equal(await page.isVisible(".lb-outline-order-bar"), true, "the custom module order is still active");

  // Back and forth still works, and Topics shows the same ticks.
  await back(page, 4);
  await stepIs(page, 3);
  assert.equal(await page.isChecked(`input[data-topic="${picks.catalog[0]}"]`), true);
  assert.equal(await page.isChecked(`input[data-topic="${picks.catalog[1]}"]`), false, "the module removed in Review is still out");
  assert.equal(await page.isChecked(`input[data-subtopic="${picks.sub}"]`), false, "the left-out sub-topic is still left out");
  assert.equal(await page.getAttribute(`input[data-topic="${picks.parent}"]`, "data-subtopic-state"), "some");
  await next(page, 3);
  await stepIs(page, 4);

  // Carry on to the end and build: Review and build has one primary button.
  await page.evaluate(() => document.querySelectorAll("#lb-pane-4 details").forEach((d) => (d.open = true)));
  await page.uncheck("#lb-use-learn");
  await page.uncheck("#lb-use-llm");
  assert.equal(await page.textContent("#lb-generate-btn"), "Build my lab");
  await page.click("#lb-generate-btn");
  await page.waitForFunction(() => document.getElementById("lb-result-panel").style.display !== "none", null, { timeout: 120000 });
  const labs = (await api("/api/lab-builder/generated")).body.labs;
  assert.equal(labs.length, 1);
  assert.equal(labs[0].title, "Contoso e2e lab");
  assert.deepEqual(labs[0].selections.excludedSubtopics, [picks.sub], "the built lab saved the same choices the draft held");
  assert.equal(labs[0].selections.targetMinutes, 150);

  // The draft is marked Built and kept, with a link to the lab.
  await page.waitForFunction(() => /Built/.test(document.getElementById("lb-drafts-list").textContent));
  await page.waitForSelector('#lb-drafts-list button[data-draft-action="open-lab"]');
  const listed = (await api("/api/lab-builder/drafts")).body;
  assert.equal(listed.drafts.length, 1);
  assert.equal(listed.drafts[0].builtLabId, labs[0].labId);
  assert.equal(listed.unsaved, null, "a built lab leaves no unsaved copy");
  await shot(page, "06-built-draft");
  assert.deepEqual(errors, [], "no script errors on the page");
});

test("a refresh in the middle of a lab brings up one calm banner, and Resume puts the work back", async (t) => {
  if (!ctx.browser) return t.skip(ctx.skipReason);
  // The banner pauses autosave until it is answered, so start from a clean slot.
  await api("/api/lab-builder/drafts/unsaved", { method: "DELETE" });
  const features = (await api("/api/lab-builder/features")).body;
  const industry = features.industries[1]?.id || features.industries[0].id;
  const namedBefore = (await api("/api/lab-builder/drafts")).body.drafts.length;
  const page = await ctx.browser.newPage({ viewport: { width: 1280, height: 900 } });
  t.after(() => page.close());
  await page.goto(`${ctx.base}/#labbuilder`);
  await page.waitForSelector('input[name="lb-product"]');
  await page.waitForFunction(() => lbDraft.loaded);
  await page.check('input[name="lb-product"][value="sharepoint-ai"]');
  await next(page, 1);
  await page.selectOption("#lb-industry-select", industry);

  // Autosave waits for a quiet moment, then writes the one unsaved copy.
  await page.waitForResponse((res) => res.url().endsWith("/api/lab-builder/drafts/unsaved") && res.request().method() === "PUT", { timeout: 20000 });
  assert.equal((await api("/api/lab-builder/drafts")).body.drafts.length, namedBefore, "it is not a named draft");

  await page.reload();
  await page.waitForSelector('input[name="lb-product"]');
  await page.waitForSelector("#lb-unsaved-banner:not([hidden])");
  await shot(page, "07-unsaved-banner");
  assert.match(await page.textContent("#lb-unsaved-banner-text"), /^You have unsaved work from .+\. Resume or discard\.$/);
  assert.equal(await page.evaluate(() => labBuilder.selectedProducts.size), 0, "nothing is restored until the person chooses");
  await page.click("#lb-unsaved-resume");
  await page.waitForFunction(() => labBuilder.step === 2 && document.activeElement?.id === "lb-heading-2");
  assert.equal(await page.evaluate(() => labBuilder.selectedProducts.has("sharepoint-ai")), true);
  assert.equal(await page.isHidden("#lb-unsaved-banner"), true);
  assert.equal(await page.evaluate(() => labBuilder.industry), industry);

  // Discarding is one click as well.
  await page.reload();
  await page.waitForSelector("#lb-unsaved-banner:not([hidden])");
  await page.click("#lb-unsaved-discard");
  await page.waitForSelector("#lb-unsaved-banner", { state: "hidden" });
  assert.equal((await api("/api/lab-builder/drafts/unsaved")).body.unsaved, null);
});
