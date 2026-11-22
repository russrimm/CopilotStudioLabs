/**
 * Pre-lab training decks, the delivery surfaces: the routes and their error codes, the export formats and the ZIP
 * layout, the command line, the lab panel group (a fake page, then once in headless Chromium), and the labs list.
 * The real portal server runs on a random port with throwaway storage; nothing touches a real data folder.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Writable } from "node:stream";
import vm from "node:vm";

import { exportGeneratedLab } from "../lib/exporter.js";
import { TRAINING_ZIP_FOLDER } from "../lib/lab-builder/training-plan.js";
import { checkPptxPackage, readZipStrict } from "../../tools/lab-builder/lib/ooxml-strict.mjs";
import { buildSampleLabs } from "./fixtures/training-labs.js";

const here = dirname(fileURLToPath(import.meta.url));
const PORTAL_ROOT = resolve(here, "..");
const REPO_ROOT = resolve(PORTAL_ROOT, "..");
const PLAYWRIGHT = resolve(REPO_ROOT, "tools", "screenshot-capture", "node_modules", "playwright", "index.mjs");
const PPTX_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const cleanups = [];
const ctx = {};

function tmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

async function startServer(storageRoot, localAppData) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let stderr = "";
  const child = spawn(process.execPath, ["server.js"], {
    cwd: PORTAL_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      PORTAL_AUTH_DISABLED: "true",
      AZURE_KEYVAULT_URL: "",
      PORTAL_STORAGE_ROOT: storageRoot,
      FEATURE_TOUR_SCREENSHOTS_DIR: "",
      LAB_BUILDER_LINK_CHECK: "off",
      LAB_BUILDER_LLM: "off",
      LOCALAPPDATA: localAppData,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  cleanups.push(() => child.kill());
  const deadline = Date.now() + 60000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}): ${stderr.slice(-800)}`);
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("server did not start in time");
    await new Promise((r) => setTimeout(r, 150));
  }
  return base;
}

async function zipEntries(root, labId, options, replacements = {}) {
  const chunks = [];
  const sink = new Writable({ write(chunk, _enc, done) { chunks.push(chunk); done(); } });
  await exportGeneratedLab(root, labId, replacements, sink, options);
  const zip = readZipStrict(Buffer.concat(chunks), { opc: false });
  assert.deepEqual(zip.problems, [], "the ZIP is a clean archive");
  return zip.entries;
}

const bytes = async (res) => Buffer.from(await res.arrayBuffer());

before(async () => {
  ctx.localAppData = tmp("training-routes-localappdata-");
  ctx.storageRoot = join(tmp("training-routes-"), "storage");
  ctx.generatedRoot = join(ctx.storageRoot, "generated-labs");
  mkdirSync(ctx.generatedRoot, { recursive: true });
  ctx.served = await buildSampleLabs(["level200", "multiProduct", "learnOnly"], { root: ctx.generatedRoot });
  ctx.standalone = await buildSampleLabs(["level100"]);
  cleanups.push(ctx.standalone.cleanup);
  ctx.base = await startServer(ctx.storageRoot, ctx.localAppData);
});

after(() => {
  for (const clean of cleanups.reverse()) clean();
});

const idOf = (name) => ctx.served.labs[name].labId;
const url = (name, path = "", prefix = "/api/lab-builder/generated") => `${ctx.base}${prefix}/${encodeURIComponent(idOf(name))}${path}`;

test("the list route gives titles, minutes, and flags for every deck, under both route prefixes, with no file paths", async () => {
  const res = await fetch(url("level200", "/training"));
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.labId, idOf("level200"));
  assert.equal(data.schemaVersion, 1);
  assert.deepEqual(data.decks.map((d) => d.key), ["complete", "foundations-copilot-studio", "1", "2", "3", "4"]);
  const [complete, foundations, ...topics] = data.decks;
  assert.equal(complete.minutes, data.totalMinutes);
  assert.equal(foundations.kind, "foundations");
  for (const d of topics) {
    assert.ok(d.title && d.minutes >= 20 && d.minutes <= 30 && d.slideCount >= 10, JSON.stringify(d));
    assert.equal(d.unreviewed, false);
    assert.equal(d.learnChanged, false);
  }
  assert.match(topics[0].stepLabel, /^Recap 1$/);
  assert.equal(topics[2].fileName, "Training deck - Module 03 - Generative orchestration.pptx");
  assert.doesNotMatch(JSON.stringify(data), /[A-Za-z]:\\|\\\\|training-labs-|storage/, "no server paths in the answer");
  const alias = await (await fetch(url("level200", "/training", "/api/generated-labs"))).json();
  assert.deepEqual(alias.decks, data.decks);

  const flagged = await (await fetch(url("learnOnly", "/training"))).json();
  const review = flagged.decks.filter((d) => d.unreviewed);
  assert.equal(review.length, 1, "only the Learn-only topic is flagged");
  assert.equal(review[0].thin, true);
  assert.ok(review[0].minutes < 20);

  assert.equal((await fetch(`${ctx.base}/api/lab-builder/generated/no-such-lab/training`)).status, 404);
  assert.equal((await fetch(`${ctx.base}/api/lab-builder/generated/bad%20id/training`)).status, 400);
});

test("a deck downloads as PowerPoint, the cached file is served unchanged, and bad requests get a plain JSON error", async () => {
  for (const prefix of ["/api/lab-builder/generated", "/api/generated-labs"]) {
    const res = await fetch(url("level200", "/training/3/pptx", prefix));
    assert.equal(res.status, 200, prefix);
    assert.equal(res.headers.get("content-type"), PPTX_TYPE);
    assert.match(res.headers.get("content-disposition") || "", /Training deck - Module 03 - Generative orchestration\.pptx/);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    const body = await bytes(res);
    assert.deepEqual(checkPptxPackage(body, { expectNotes: true }), []);
    const onDisk = readFileSync(join(ctx.served.labs.level200.outputDir, "training", "Training deck - Module 03 - Generative orchestration.pptx"));
    assert.ok(body.equals(onDisk), "the cached file is what is served");
    assert.ok((await bytes(await fetch(url("level200", "/training/3", prefix)))).equals(body), "the format is optional");
  }
  for (const key of ["complete", "foundations", "foundations-copilot-studio", "1"]) {
    const res = await fetch(url("level200", `/training/${key}`));
    assert.equal(res.status, 200, key);
    assert.deepEqual(checkPptxPackage(await bytes(res), { expectNotes: true }), [], key);
  }

  const outline = await fetch(url("level200", "/training/3/outline"));
  assert.equal(outline.status, 200);
  assert.match(outline.headers.get("content-type") || "", /json/);
  const data = await outline.json();
  assert.ok(data.slides.length >= 10 && data.slides.every((s) => s.title && s.minutes >= 1 && s.notes.some((n) => /^TIME: about/.test(n))));

  const errors = [
    ["/training/99", 404, /not found/i],
    ["/training/abc", 400, /topic number, complete, foundations/],
    ["/training/0", 400, /topic number/],
    ["/training/3/docx", 400, /pptx|outline/],
    ["/training/foundations-nope", 404, /not found/i],
  ];
  for (const [path, status, message] of errors) {
    const res = await fetch(url("level200", path));
    assert.equal(res.status, status, path);
    assert.match((await res.json()).error, message, path);
  }
  assert.equal((await fetch(`${ctx.base}/api/lab-builder/generated/no-such-lab/training/1/pptx`)).status, 404);
});

test("a lab with two products asks which foundations deck, and serves each by product", async () => {
  const list = await (await fetch(url("multiProduct", "/training"))).json();
  const foundations = list.decks.filter((d) => d.kind === "foundations").map((d) => d.key);
  assert.deepEqual(foundations, ["foundations-copilot-studio", "foundations-sharepoint-ai"]);
  const ask = await fetch(url("multiProduct", "/training/foundations"));
  assert.equal(ask.status, 400);
  assert.match((await ask.json()).error, /2 products.*foundations-copilot-studio, foundations-sharepoint-ai/);
  for (const key of foundations) assert.equal((await fetch(url("multiProduct", `/training/${key}`))).status, 200, key);
});

test("the export route serves training, training-complete, and training-foundations, and still rejects unknown formats", async () => {
  const zipRes = await fetch(url("level200", "/export?format=training"));
  assert.equal(zipRes.status, 200);
  assert.equal(zipRes.headers.get("content-type"), "application/zip");
  assert.match(zipRes.headers.get("content-disposition") || "", /Training decks\.zip/);
  const zip = readZipStrict(await bytes(zipRes), { opc: false });
  assert.deepEqual(zip.problems, []);
  const names = [...zip.entries.keys()];
  assert.ok(names.every((n) => n.startsWith(`${TRAINING_ZIP_FOLDER}/`)));
  assert.deepEqual(names.filter((n) => /\.pptx$/.test(n)).length, 6, "complete, foundations, and four topics");
  assert.ok(names.includes(`${TRAINING_ZIP_FOLDER}/README.md`));
  for (const [name, data] of zip.entries) if (/\.pptx$/.test(name)) assert.deepEqual(checkPptxPackage(data, { expectNotes: true }), [], name);

  const complete = await fetch(url("level200", "/export?format=training-complete"));
  assert.equal(complete.status, 200);
  assert.equal(complete.headers.get("content-type"), PPTX_TYPE);
  assert.match(complete.headers.get("content-disposition") || "", /Training deck - Complete\.pptx/);

  const single = await fetch(url("level200", "/export?format=training-foundations"));
  assert.equal(single.headers.get("content-type"), PPTX_TYPE, "one product: the deck itself");
  assert.match(single.headers.get("content-disposition") || "", /00 Foundations - Copilot Studio\.pptx/);

  const several = await fetch(url("multiProduct", "/export?format=training-foundations"));
  assert.equal(several.headers.get("content-type"), "application/zip", "several products: a ZIP of the foundations decks");
  const inner = [...readZipStrict(await bytes(several), { opc: false }).entries.keys()];
  assert.deepEqual(inner.map((n) => n.replace(`${TRAINING_ZIP_FOLDER}/`, "")).sort(), ["Training deck - 00 Foundations - Copilot Studio.pptx", "Training deck - 00 Foundations - SharePoint AI.pptx"]);

  const bad = await fetch(url("level200", "/export?format=training-everything"));
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /'training', 'training-complete', 'training-foundations'/);
  assert.equal((await fetch(`${ctx.base}/api/lab-builder/generated/no-such-lab/export?format=training`)).status, 404);
  assert.equal((await fetch(url("level200", "/export?format=pptx"))).status, 200, "the other formats are unchanged");
});

test("the lab ZIP puts the training decks in the folder that sorts first, ahead of the hands-on modules, with a README and the manifest entries", async () => {
  const { root, labs } = ctx.standalone;
  const labId = labs.level100.labId;
  const entries = await zipEntries(root, labId, { formats: "docx,pptx,html" });
  const names = [...entries.keys()];
  const training = names.filter((n) => n.startsWith(`${TRAINING_ZIP_FOLDER}/`));
  const decks = training.filter((n) => /\.pptx$/.test(n));
  assert.equal(decks.length, 1 + 1 + 4, "the complete deck, one foundations deck, and a deck per module");
  assert.ok(training.includes(`${TRAINING_ZIP_FOLDER}/README.md`));
  assert.equal([...names].sort((a, b) => a.localeCompare(b, "en", { numeric: true }))[0].split("/")[0], TRAINING_ZIP_FOLDER, "it sorts before everything else");
  const handsOn = names.filter((n) => n.startsWith(`${labId}/`) && /\.pptx$/.test(n));
  assert.ok(handsOn.length >= 4, "the hands-on module decks are still in their own folders");
  assert.ok(handsOn.every((n) => !n.includes("Training deck")));
  for (const n of decks) assert.deepEqual(checkPptxPackage(entries.get(n), { expectNotes: true }), [], n);

  const manifest = JSON.parse(entries.get("export-manifest.json").toString("utf8"));
  assert.equal(manifest.trainingDecksFolder, TRAINING_ZIP_FOLDER);
  assert.equal(manifest.trainingDecks.length, decks.length);
  assert.ok(manifest.trainingDecks.every((d) => d.file.startsWith(`${TRAINING_ZIP_FOLDER}/`) && d.minutes >= 8));
  assert.ok(manifest.trainingMinutes >= 60);
  const readme = entries.get("README.md").toString("utf8");
  assert.match(readme, new RegExp(`\`${TRAINING_ZIP_FOLDER.replace(/[()]/g, "\\$&")}/\` — the pre-lab training decks: deliver these first`));
  assert.ok(readme.indexOf(TRAINING_ZIP_FOLDER) < readme.indexOf("index.md"), "the README lists the training decks first");
  const folderReadme = entries.get(`${TRAINING_ZIP_FOLDER}/README.md`).toString("utf8");
  assert.match(folderReadme, /^# Training decks: deliver these first/);
  assert.match(folderReadme, /For people who are new to this\. No lab steps\./);

  const noPptx = [...(await zipEntries(root, labId, { formats: "docx" })).keys()];
  assert.ok(!noPptx.some((n) => n.startsWith(TRAINING_ZIP_FOLDER)), "training decks are PowerPoint files, so they follow the formats asked for");

  const replaced = await zipEntries(root, labId, { formats: "pptx" }, { Contoso: "Adatum" });
  const completeText = readZipStrict(replaced.get(`${TRAINING_ZIP_FOLDER}/Training deck - Complete.pptx`)).entries.get("ppt/slides/slide1.xml").toString("utf8");
  assert.match(completeText, /Adatum Plant Foundations Lab/, "replacements reach the decks");
  const cached = readZipStrict(readFileSync(join(labs.level100.outputDir, "training", "Training deck - Complete.pptx"))).entries.get("ppt/slides/slide1.xml").toString("utf8");
  assert.doesNotMatch(cached, /Adatum/, "and never change the saved decks");
});

test("the command line writes every deck, one deck by number, and says plainly what went wrong", () => {
  const { root, labs } = ctx.standalone;
  const cli = join(REPO_ROOT, "tools", "lab-builder", "export-training-decks.mjs");
  const env = { ...process.env, LOCALAPPDATA: ctx.localAppData, LAB_BUILDER_LINK_CHECK: "off" };
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env, cwd: tmp("training-cli-cwd-") });
  const labId = labs.level100.labId;
  const before = existsSync(join(labs.level100.outputDir, "training")) ? readdirSync(join(labs.level100.outputDir, "training")).length : 0;

  const out = tmp("training-cli-out-");
  const all = run("--lab", labId, "--root", root, "--out", out);
  assert.equal(all.status, 0, all.stderr);
  const files = readdirSync(out).sort();
  assert.equal(files.length, 6);
  assert.ok(files.includes("Training deck - Complete.pptx") && files.includes("Training deck - 00 Foundations - Copilot Studio.pptx"));
  for (const f of files) assert.deepEqual(checkPptxPackage(readFileSync(join(out, f)), { expectNotes: true }), [], f);
  assert.match(all.stderr, /Wrote 6 decks\. Training about \d+ minutes, then about \d+ minutes hands-on\./);

  const one = join(tmp("training-cli-one-"), "topic-2.pptx");
  const single = run("--lab", labs.level100.outputDir, "--topic", "2", "--out", one);
  assert.equal(single.status, 0, single.stderr);
  assert.deepEqual(checkPptxPackage(readFileSync(one), { expectNotes: true }), []);
  assert.ok(statSync(one).size > 5000);

  assert.equal(readdirSync(join(labs.level100.outputDir, "training")).length, before, "nothing is written to the lab");

  const missing = run("--lab", "no-such-lab", "--root", root);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /No generated lab "no-such-lab"/);
  const badTopic = run("--lab", labId, "--root", root, "--topic", "99", "--out", tmp("training-cli-bad-"));
  assert.equal(badTopic.status, 1);
  assert.match(badTopic.stderr, /Training topic 99 not found/);
  assert.equal(run().status, 1);
  assert.equal(run("--bogus").status, 1);
  const help = run("--help");
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--lab <id\|folder>[\s\S]*--root[\s\S]*--out[\s\S]*--topic/);
});

// ── The lab panel ───────────────────────────────────────────────────────────

function uiContext({ fetchImpl } = {}) {
  const ids = new Map();
  const toasts = [];
  const context = vm.createContext({
    window: {},
    document: { getElementById: (id) => ids.get(id) || null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: fetchImpl || (async () => ({ ok: true, status: 200, json: async () => ({}) })),
    escapeHtml: (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    toast: (message, kind) => toasts.push([message, kind]),
    URL, Blob, console, setTimeout, clearTimeout,
  });
  for (const file of ["generated-labs.js", "training-decks.js"]) vm.runInContext(readFileSync(join(PORTAL_ROOT, "public", file), "utf8"), context);
  vm.runInContext("globalThis.__ui = { lbGeneratedActionButtonsHtml, lbTrainingDecksGroupHtml, lbTrainingListHtml, lbTrainingLoadList, lbTrainingToggle };", context);
  return { ui: context.__ui, ids, toasts };
}

const visibleText = (html) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

test("the lab panel opens with 'Training decks: deliver these first' above the lab downloads, with the two main downloads", () => {
  const { ui } = uiContext();
  const html = ui.lbGeneratedActionButtonsHtml("my-lab-slug", "Fabrikam Copilot Readiness Lab", { scopePrefix: "lb-zip-fmt-item" });
  const text = visibleText(html);
  assert.match(text, /Training decks: deliver these first For people who are new to this\. No lab steps\. Download complete training deck Download foundations Show training decks by topic/);
  assert.ok(html.indexOf("lb-training-group") < html.indexOf("Download"), "the training group comes before the lab downloads");
  assert.ok(html.indexOf("Training decks: deliver these first") < html.indexOf("lb-prereq-group"), "and before the prerequisites group");
  assert.match(html, /href="\/api\/lab-builder\/generated\/my-lab-slug\/training\/complete\/pptx"[^>]*download="Training deck - Complete\.pptx"/);
  assert.match(html, /href="\/api\/lab-builder\/generated\/my-lab-slug\/export\?format=training-foundations"/);
  assert.match(html, /<section class="lb-training-group" aria-labelledby="[^"]+-heading"/);
  assert.match(html, /<button type="button"[^>]*aria-expanded="false" aria-controls="[^"]+-list"/, "the list button is a real button with its state");
  assert.doesNotMatch(html, /clipboard|<dialog|showModal/i, "no clipboard code and no new modals");
  assert.doesNotMatch(text, /my-lab-slug/, "no id in the visible words");
  assert.match(text, /Hands-on deck: lab day \(\.pptx\)/, "the lab-day deck says so");
  assert.doesNotMatch(text, /(?<!Hands-on deck: lab day )\bPowerPoint Deck \(\.pptx\)/, "the old label is gone");
  assert.ok(!ui.lbGeneratedActionButtonsHtml("my-lab-slug", "Lab", { trainingGroup: false }).includes("lb-training-group"), "the labs list rows leave the group to the open lab");
});

test("the topic list shows a time on every deck and an 'unreviewed' chip only where flagged, and loads when opened", async () => {
  const data = {
    totalMinutes: 99,
    handsOnMinutes: 65,
    decks: [
      { key: "complete", kind: "complete", title: "Complete training deck: Contoso Lab", minutes: 99, fileName: "Training deck - Complete.pptx" },
      { key: "foundations-copilot-studio", kind: "foundations", title: "Foundations: Copilot Studio", minutes: 12, fileName: "Training deck - 00 Foundations - Copilot Studio.pptx" },
      { key: "1", kind: "topic", order: 1, stepLabel: "Step 1", title: "Create an agent", minutes: 25, fileName: "Training deck - Module 01 - Create an agent.pptx" },
      { key: "2", kind: "topic", order: 2, stepLabel: "Step 2", title: "Add a child agent", minutes: 12, unreviewed: true, fileName: "Training deck - Module 02 - Add a child agent.pptx" },
      { key: "3", kind: "topic", order: 3, stepLabel: "Recap 1", title: "Instructions", minutes: 20, learnChanged: true, fileName: "Training deck - Module 03 - Recap - Instructions.pptx" },
    ],
  };
  const requested = [];
  const { ui, ids, toasts } = uiContext({ fetchImpl: async (u) => (requested.push(String(u)), { ok: true, status: 200, json: async () => data }) });
  const html = ui.lbTrainingListHtml("my-lab", data);
  const text = visibleText(html);
  assert.match(text, /About 1 hour 39 minutes of training, then about 1 hour 5 minutes hands-on\./);
  assert.equal((html.match(/<li class="lb-training-item">/g) || []).length, 4, "foundations and topics are listed; the complete deck has its own button");
  assert.equal((html.match(/about \d+ min</g) || []).length, 4, "a time on every row");
  assert.equal((html.match(/Unreviewed: check before you present/g) || []).length, 1, "the chip only where flagged");
  assert.equal((html.match(/Learn page changed/g) || []).length, 1);
  assert.match(html, /href="\/api\/lab-builder\/generated\/my-lab\/training\/2\/pptx" download="Training deck - Module 02 - Add a child agent\.pptx"/);
  assert.match(html, /aria-label="Download training deck for (?:Part|Step) 2: Add a child agent"/);
  assert.match(text, /(?:Part|Step) 1 Create an agent about 25 min/);
  assert.doesNotMatch(html, /clipboard/i);

  // Opening the list fetches it once, shows it, and closes again with the button.
  const host = { hidden: true, innerHTML: "" };
  ids.set("list-id", host);
  const attrs = { "data-lab-id": "my-lab", "aria-controls": "list-id", "aria-expanded": "false" };
  const button = { getAttribute: (n) => attrs[n], setAttribute: (n, v) => (attrs[n] = v), textContent: "Show training decks by topic" };
  await ui.lbTrainingToggle(button);
  assert.equal(host.hidden, false);
  assert.equal(attrs["aria-expanded"], "true");
  assert.equal(button.textContent, "Hide training decks by topic");
  assert.match(host.innerHTML, /Create an agent/);
  assert.deepEqual(requested, ["/api/lab-builder/generated/my-lab/training"]);
  await ui.lbTrainingToggle(button);
  assert.equal(host.hidden, true);
  assert.equal(button.textContent, "Show training decks by topic");
  assert.equal(toasts.length, 0);

  // A failure says so in the list instead of leaving it empty.
  const broken = uiContext({ fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({ error: "Could not prepare the training decks." }) }) });
  const failed = { innerHTML: "" };
  await broken.ui.lbTrainingLoadList("other-lab", failed);
  assert.match(failed.innerHTML, /role="alert">Could not load the training decks: Could not prepare the training decks\./);
});

test("the wizard's last step uses the same group, the page loads the script, and the group's styles sit in the screen CSS before the print block", () => {
  const app = readFileSync(join(PORTAL_ROOT, "public", "app.js"), "utf8");
  assert.match(app, /lbGeneratedActionButtonsHtml\(data\.labId, labTitle\)/, "the final wizard step uses the same download group");
  const page = readFileSync(join(PORTAL_ROOT, "public", "index.html"), "utf8");
  assert.match(page, /<script src="generated-labs\.js"[^>]*><\/script>\s*<script src="training-decks\.js" defer><\/script>/, "loaded right after generated-labs.js");
  const script = readFileSync(join(PORTAL_ROOT, "public", "training-decks.js"), "utf8");
  assert.doesNotMatch(script, /clipboard|navigator\.clipboard|execCommand/i);
  const firstPrint = page.indexOf("@media print");
  assert.ok(page.indexOf(".lb-training-group") > 0 && page.indexOf(".lb-training-group") < firstPrint, "the group's styles are screen CSS before the print block");
});

test("in a real browser the group opens with the keyboard, lists the decks with times and the unreviewed chip, and downloads a valid deck", async (t) => {
  if (!existsSync(PLAYWRIGHT)) return t.skip("Playwright is not installed (tools/screenshot-capture: npm install).");
  const { chromium } = await import(pathToFileURL(PLAYWRIGHT).href);
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    return t.skip(`No headless Chromium is available: ${err.message.split("\n")[0]}`);
  }
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const problems = [];
    page.on("pageerror", (err) => problems.push(err.message));
    page.on("console", (message) => message.type() === "error" && problems.push(message.text()));
    await page.goto(ctx.base);
    await page.evaluate(async (labId) => {
      await lbLoadGenerated();
      await lbOpenGenerated(labId);
    }, idOf("learnOnly"));
    const group = page.locator(".lb-training-group").first();
    await group.waitFor({ state: "visible" });
    assert.equal((await group.locator(".lb-training-heading").innerText()).trim(), "Training decks: deliver these first");
    assert.equal((await group.locator(".lb-training-note").innerText()).trim(), "For people who are new to this. No lab steps.");
    assert.equal((await group.locator("a", { hasText: "Download complete training deck" }).count()), 1);
    assert.equal((await group.locator("a", { hasText: "Download foundations" }).count()), 1);

    const toggle = group.locator("button[data-training-action='toggle']");
    await toggle.focus();
    await page.keyboard.press("Enter");
    const items = group.locator(".lb-training-item");
    await items.first().waitFor({ state: "visible" });
    assert.equal(await toggle.getAttribute("aria-expanded"), "true");
    assert.equal(await items.count(), 2, "the foundations deck and the one topic");
    assert.equal(await group.locator(".lb-training-chip", { hasText: "Unreviewed: check before you present" }).count(), 1);
    for (const time of await group.locator(".lb-training-time").allInnerTexts()) assert.match(time, /^about \d+ min$/);

    const href = await group.locator("a", { hasText: "Download complete training deck" }).getAttribute("href");
    const res = await page.request.get(new URL(href, ctx.base).href);
    assert.equal(res.status(), 200);
    assert.deepEqual(checkPptxPackage(Buffer.from(await res.body()), { expectNotes: true }), []);

    // The group is laid out inside the panel and nothing overflows sideways.
    const box = await group.boundingBox();
    assert.ok(box && box.width > 300 && box.x >= 0 && box.x + box.width <= 1280);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, "no sideways scroll");
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
  }
});
