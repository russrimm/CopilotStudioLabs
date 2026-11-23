/**
 * Every ZIP the portal writes is held to one path budget so it extracts on Windows (see lib/export-names.js): entry paths at
 * most 100 characters, the ZIP's file name at most 50, a downloaded file name at most 120. These tests cover the naming
 * helper, the guard, every ZIP producer on labs of different shapes (a single product, 25+ modules with recaps, a
 * Learn-only topic, a Foundry lab, a 160 character title), the README and manifest index, the download names, an older
 * lab, and a real extraction from a 110 character folder on Windows. The portal server runs on a random port with throwaway
 * storage; nothing touches a real data folder.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough, Writable } from "node:stream";
import vm from "node:vm";

import { exportGeneratedLab, exportLabs } from "../lib/exporter.js";
import { discoverLabs } from "../lib/labs.js";
import {
  ASSUMED_EXTRACT_PREFIX,
  DOC_KINDS,
  EXTRACT_ON_WINDOWS_TIP,
  ExportBudgetError,
  WINDOWS_MAX_PATH,
  asciiFold,
  auditEntryPaths,
  createZipPathGuard,
  cutAtWordBoundary,
  fitFileName,
  moduleFolderName,
  planLabFolder,
  planModuleNames,
  resolveExportBudget,
  shortLabName,
  shortenDownloadFileName,
  trainingDeckFileName,
  worstCaseExtractedPath,
  zipDownloadName,
} from "../lib/export-names.js";
import { TRAINING_ZIP_FOLDER } from "../lib/lab-builder/training-plan.js";
import { readZipStrict } from "../../tools/lab-builder/lib/ooxml-strict.mjs";
import { LONG_TITLE, buildExportSampleLabs } from "./fixtures/export-labs.js";

const here = dirname(fileURLToPath(import.meta.url));
const PORTAL_ROOT = resolve(here, "..");
const REPO_ROOT = resolve(PORTAL_ROOT, "..");
const BUDGET = resolveExportBudget({});
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

/** Export a lab in this process and return `{buffer, summary, entries, manifest}`. */
async function exportZip(root, labId, options = {}, replacements = {}) {
  const chunks = [];
  const sink = new Writable({ write(chunk, _enc, done) { chunks.push(chunk); done(); } });
  const summary = await exportGeneratedLab(root, labId, replacements, sink, options);
  const buffer = Buffer.concat(chunks);
  const zip = readZipStrict(buffer, { opc: false });
  assert.deepEqual(zip.problems, [], "the ZIP is a clean archive");
  return { buffer, summary, entries: zip.entries, names: [...zip.entries.keys()], manifest: JSON.parse(zip.entries.get("export-manifest.json").toString("utf8")) };
}

const baseOf = (path) => path.split("/").pop();
/** The name a download offers: the UTF-8 `filename*` when there is one, else `filename`. */
function dispositionName(res) {
  const header = res.headers.get("content-disposition") || "";
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star) return decodeURIComponent(star[1]);
  return (/filename="?([^";]+)"?/i.exec(header) || [])[1] || "";
}

/** The rules every entry path must meet: budget, Windows-safe, unique when case is ignored, no reserved names. */
function assertPathsClean(names, label) {
  assert.deepEqual(auditEntryPaths(names, { budget: BUDGET }), [], `${label}: every path is within the budget and safe on Windows`);
  const longest = Math.max(...names.map((n) => n.length));
  assert.ok(longest <= BUDGET.entryMax, `${label}: longest entry ${longest}`);
}

// ── The naming helper ───────────────────────────────────────────────────────

test("a short lab name keeps the first meaningful words, stays plain ASCII, and is never reserved or dotted", () => {
  assert.equal(shortLabName("Retail: Build a Store Support Assistant with Microsoft Copilot Studio"), "Retail Store Support Assistant");
  assert.equal(shortLabName("Contoso Child Agent Lab"), "Contoso Child Agent Lab");
  assert.equal(shortLabName("Energy & Resources: Build a Field Operations Assistant with Microsoft Copilot Studio"), "Energy Resources Field");
  const accented = shortLabName(LONG_TITLE);
  assert.equal(accented, "Cafe Reunion Fabrikam Plant", "accents fold, the ampersand and quotes are dropped, case is kept");
  assert.equal(asciiFold("Café Réunion Straße Łódź"), "Cafe Reunion Strasse Lodz");
  for (const title of ["CON", "nul", "COM1", "lpt9", "AUX"]) assert.match(shortLabName(title), /Lab$/, `${title} is a Windows device name`);
  for (const title of ["Plant tour...", "   spaced out   ", "Trailing dot.", "..."]) {
    const name = shortLabName(title);
    assert.ok(name && !/[. ]$/.test(name) && !/^[. ]/.test(name), JSON.stringify(name));
  }
  assert.equal(shortLabName(""), "Lab");
  assert.ok(shortLabName("A".repeat(80)).length <= 30, "one very long word is cut");
  assert.equal(shortLabName(LONG_TITLE), shortLabName(LONG_TITLE), "deterministic");
  assert.ok(shortLabName("Alpha Beta Gamma Delta Epsilon Zeta").split(" ").length <= 4);
  // A second lab with the same short name gets a number, and only then.
  const used = new Set();
  assert.equal(planLabFolder("Contoso Child Agent Lab", { used }), "Contoso Child Agent Lab");
  assert.equal(planLabFolder("Contoso Child Agent Lab: second edition", { used }), "Contoso Child Agent Lab 2");
  assert.equal(planLabFolder("Contoso Child agent lab", { used }), "Contoso Child agent lab 3", "Windows ignores case");
});

test("a cut lands on a word boundary, never leaves a dangling word, and keeps what fits", () => {
  assert.equal(cutAtWordBoundary("Build a declarative agent with Agents Toolkit and TypeSpec", 32), "Build a declarative agent");
  assert.equal(cutAtWordBoundary("Create an agent", 32), "Create an agent");
  assert.equal(cutAtWordBoundary("Agent instructions & persona", 20), "Agent instructions");
  assert.equal(cutAtWordBoundary("Generative orchestration", 14, { midWord: false }), "Generative", "no word is split when asked not to");
  assert.equal(cutAtWordBoundary("Unbroken".repeat(6), 10), "UnbrokenUn", "one long word is cut inside the word");
  for (const max of [10, 17, 24, 32]) {
    const cut = cutAtWordBoundary("Tour SharePoint Advanced Management and check prerequisites with the admin", max);
    assert.ok(cut.length <= max && !/\b(with|and|the|a|of)$/i.test(cut) && !/[\s.,;:&-]$/.test(cut), `${max}: ${cut}`);
  }
});

test("module folders and files keep the teaching order, label recaps, stay unique, and use a short fixed vocabulary", () => {
  const modules = [
    { order: 1, title: "Create an agent", isRecap: true },
    { order: 2, title: "Create an agent" },
    { order: 3, title: "Build a declarative agent with Agents Toolkit and TypeSpec", isRecap: true },
    { order: 10, title: "Agent instructions & persona" },
    { order: 11, title: "Tour SharePoint Advanced Management and check prerequisites" },
    { order: 12, title: "Create an agent" },
  ];
  const labFolder = "Retail Store Support Assistant";
  const plan = planModuleNames(modules, { labFolder, budget: BUDGET });
  const folders = modules.map((m) => plan.get(m.order).folder);
  assert.deepEqual(folders, ["01 Recap - Create an agent", "02 Create an agent", "03 Recap - Build a declarative agent", "10 Agent instructions & persona", "11 Tour SharePoint Advanced", "12 Create an agent"]);
  assert.deepEqual([...folders].sort((a, b) => a.localeCompare(b, "en", { numeric: true })), folders, "folders list in teaching order");
  assert.equal(new Set(folders.map((f) => f.toLowerCase())).size, folders.length, "the same short title still gives distinct folders");
  assert.equal(moduleFolderName({ order: 5, title: "Custom connectors & OAuth" }), "05 Custom connectors & OAuth");

  // Files: "NN <title> - <Kind>.<ext>" when the title fits the target, "NN - <Kind>.<ext>" when it cannot.
  assert.deepEqual(DOC_KINDS, { docx: "Handout", pptx: "Slides", pdf: "PDF", html: "Web page", md: "Notes" });
  const two = plan.get(2);
  assert.equal(two.docName("docx"), "02 Create an agent - Handout.docx");
  assert.equal(two.docName("pptx"), "02 Create an agent - Slides.pptx");
  assert.equal(two.docName("pdf"), "02 Create an agent - PDF.pdf");
  assert.equal(two.docName("html"), "02 Create an agent - Web page.html");
  assert.equal(plan.get(3).docName("docx"), "03 - Handout.docx", "a long folder name carries the title, so the file leaves it out");
  const same = planModuleNames(modules, { labFolder, budget: BUDGET });
  assert.deepEqual([...same.values()].map((p) => p.docName("docx")), [...plan.values()].map((p) => p.docName("docx")), "deterministic");
  for (const m of modules) {
    const p = plan.get(m.order);
    for (const fmt of Object.keys(DOC_KINDS)) {
      const name = p.docName(fmt);
      assert.ok(`${labFolder}/${p.folder}/${name}`.length <= BUDGET.entryTarget, `${name} fits the target`);
    }
    assert.ok(`${labFolder}/${p.folder}/sample-files/`.length + p.sampleNameMax <= BUDGET.entryMax, "sample files fit the hard limit");
  }

  // The training decks use the same short title as the module folder.
  assert.equal(trainingDeckFileName({ kind: "complete" }), "Training - complete.pptx");
  assert.equal(trainingDeckFileName({ kind: "foundations", productShort: "Copilot Studio" }), "Training 00 Foundations Copilot Studio.pptx");
  assert.equal(trainingDeckFileName({ kind: "topic", order: 3, title: modules[2].title, stepLabel: "Recap 3" }), "Training 03 Recap - Build a declarative agent.pptx");
  assert.equal(trainingDeckFileName({ kind: "topic", order: 2, title: "Create an agent", stepLabel: "Step 1" }), "Training 02 Create an agent.pptx");
});

test("file names are fitted at word boundaries with their extension, and download names are capped at 120", () => {
  assert.equal(fitFileName("starter-inputs-and-prompts.md", 40), "starter-inputs-and-prompts.md", "a name that fits is left alone");
  assert.equal(fitFileName("starter-inputs-and-prompts.md", 25), "starter-inputs-prompts.md");
  assert.equal(fitFileName("starter-inputs-and-prompts.md", 17), "starter-inputs.md");
  for (const max of [12, 20, 30]) {
    const fitted = fitFileName("channel-and-auth-config.sample.json", max);
    assert.ok(fitted.length <= max && fitted.endsWith(".json"), fitted);
  }
  const long = `${"Contoso Training Workshop ".repeat(8)}Facilitator Guide.docx`;
  const capped = shortenDownloadFileName(long);
  assert.ok(capped.length <= 120 && capped.endsWith(".docx") && !/ \.docx$/.test(capped), capped);
  assert.equal(shortenDownloadFileName("Retail - Facilitator Guide.docx"), "Retail - Facilitator Guide.docx", "a short name is unchanged");
  assert.equal(shortenDownloadFileName("a".repeat(200) + ".pdf").length, 120);
  assert.equal(shortenDownloadFileName("Plan: A/B <test>?.md"), "Plan A B test.md", "characters Windows refuses are replaced");
  assert.ok(!/[. ]\./.test(shortenDownloadFileName("Ends with dot. .html")));

  // The ZIP file name is at most 50 characters with ".zip", whatever the title and the formats.
  for (const title of [LONG_TITLE, "Retail: Build a Store Support Assistant with Microsoft Copilot Studio", "x", ""]) {
    for (const variant of ["", "docx", "pdf+html"]) {
      const name = zipDownloadName(title, { variant });
      assert.ok(name.length <= 50 && name.endsWith(".zip") && name.includes(" - Lab package"), name);
    }
  }
  assert.equal(zipDownloadName("Retail: Build a Store Support Assistant with Microsoft Copilot Studio"), "Retail Store Support Assistant - Lab package.zip");
  assert.equal(zipDownloadName("Contoso Child Agent Lab", { variant: "docx" }), "Contoso Child Agent Lab - Lab package (docx).zip");
});

test("the budget has documented defaults, honors overrides within a safe range, and leaves room under 260", () => {
  assert.deepEqual(
    { entryMax: BUDGET.entryMax, entryTarget: BUDGET.entryTarget, zipNameMax: BUDGET.zipNameMax, downloadNameMax: BUDGET.downloadNameMax, labFolderChars: BUDGET.labFolderChars, moduleTitleChars: BUDGET.moduleTitleChars, strict: BUDGET.strict },
    { entryMax: 100, entryTarget: 90, zipNameMax: 50, downloadNameMax: 120, labFolderChars: 30, moduleTitleChars: 32, strict: false },
  );
  assert.ok(worstCaseExtractedPath(BUDGET) < WINDOWS_MAX_PATH, `110 + 46 + 100 + separators = ${worstCaseExtractedPath(BUDGET)}`);
  assert.equal(worstCaseExtractedPath(BUDGET, { prefix: ASSUMED_EXTRACT_PREFIX }), 258);
  const tuned = resolveExportBudget({ PORTAL_EXPORT_MAX_ENTRY_PATH: "120", PORTAL_EXPORT_TARGET_ENTRY_PATH: "110", PORTAL_EXPORT_MAX_ZIP_NAME: "40", PORTAL_EXPORT_MAX_DOWNLOAD_NAME: "100", PORTAL_EXPORT_LAB_FOLDER_CHARS: "24", PORTAL_EXPORT_MODULE_TITLE_CHARS: "28", PORTAL_EXPORT_STRICT_BUDGET: "on" });
  assert.deepEqual([tuned.entryMax, tuned.entryTarget, tuned.zipNameMax, tuned.downloadNameMax, tuned.labFolderChars, tuned.moduleTitleChars, tuned.strict], [120, 110, 40, 100, 24, 28, true]);
  const clamped = resolveExportBudget({ PORTAL_EXPORT_MAX_ENTRY_PATH: "5", PORTAL_EXPORT_MAX_ZIP_NAME: "9999", PORTAL_EXPORT_TARGET_ENTRY_PATH: "abc" });
  assert.equal(clamped.entryMax, 60, "too small a limit could not hold a folder and a file name");
  assert.equal(clamped.zipNameMax, 120);
  assert.equal(clamped.entryTarget, 60, "the target never passes the limit");
  assert.equal(resolveExportBudget({ NODE_TEST_CONTEXT: "child-v8" }).strict, true, "tests are strict by default");
  assert.equal(resolveExportBudget({ NODE_TEST_CONTEXT: "child-v8", PORTAL_EXPORT_STRICT_BUDGET: "off" }).strict, false);
  // A tighter budget still plans names that fit it.
  const tight = resolveExportBudget({ PORTAL_EXPORT_MAX_ENTRY_PATH: "80", PORTAL_EXPORT_TARGET_ENTRY_PATH: "70", PORTAL_EXPORT_LAB_FOLDER_CHARS: "20" });
  const folder = planLabFolder(LONG_TITLE, { budget: tight });
  const plan = planModuleNames([{ order: 1, title: "Agent instructions & persona" }], { labFolder: folder, budget: tight }).get(1);
  assert.ok(folder.length <= 20 && `${folder}/${plan.folder}/${plan.docName("html")}`.length <= 80);
});

test("the guard throws in strict mode and, otherwise, shortens with a 4 character hash and records a warning", () => {
  const strict = createZipPathGuard({ strict: true });
  assert.equal(strict.claim("Lab/01 Intro/01 Intro - Handout.docx"), "Lab/01 Intro/01 Intro - Handout.docx");
  assert.throws(() => strict.claim(`Lab/${"x".repeat(100)}.docx`), (err) => err instanceof ExportBudgetError && err.code === "EXPORT_PATH_BUDGET" && /over the budget of 100/.test(err.message));
  assert.throws(() => strict.claim("Lab/01 intro/01 INTRO - handout.docx"), /same path/, "case-insensitive duplicates");
  assert.doesNotThrow(() => strict.claim("Lab/01 Intro/a.txt"));
  assert.throws(() => strict.claim("lab/01 INTRO/A.txt"), /same path/, "case-insensitive duplicates are a naming bug");
  assert.throws(() => strict.claim("Lab/CON.txt"), /not safe on Windows/);
  assert.throws(() => strict.claim("Lab/ends with dot./file.txt"), /not safe on Windows/);
  assert.throws(() => strict.claim("Lab/a:b.txt"), /not safe on Windows/);
  assert.throws(() => strict.claim("../escape.txt"), /Unsafe/);

  const guard = createZipPathGuard({ strict: false });
  const long = `Retail Store Support Assistant/01 Create an agent/${"very long picture name ".repeat(5)}.png`;
  const shortened = guard.claim(long);
  assert.ok(shortened.length <= 100 && shortened.endsWith(".png") && /~[0-9a-f]{4}\.png$/.test(shortened), shortened);
  assert.ok(shortened.startsWith("Retail Store Support Assistant/01 Create an agent/"), "the folders are kept when the file name can absorb it");
  const second = guard.claim(long);
  assert.notEqual(second.toLowerCase(), shortened.toLowerCase(), "a second claim of the same path gets its own name");
  assert.ok(second.length <= 100);
  assert.equal(guard.warnings[0].code, "path-shortened");
  assert.equal(guard.warnings[0].original, long);

  // Deep folders are shortened the same way for every entry, so a folder is never split in two.
  const deep = createZipPathGuard({ strict: false });
  const folder = "L".repeat(60);
  const a = deep.claim(`${folder}/${"S".repeat(60)}/one.txt`);
  const b = deep.claim(`${folder}/${"S".repeat(60)}/two.txt`);
  assert.equal(dirname(a), dirname(b));
  assert.ok(a.length <= 100 && b.length <= 100);
  assert.deepEqual(auditEntryPaths([a, b], { budget: BUDGET }), []);

  // Unsafe names are made safe and unique outside strict mode.
  const loose = createZipPathGuard({ strict: false });
  assert.equal(loose.claim("Lab/CON.txt"), "Lab/_CON.txt");
  assert.equal(loose.claim("Lab/Dup.txt"), "Lab/Dup.txt");
  assert.notEqual(loose.claim("lab/dup.TXT").toLowerCase(), "lab/dup.txt");
  assert.deepEqual(loose.warnings.map((w) => w.code), ["unsafe-name", "name-collision"]);
  assert.deepEqual(auditEntryPaths(["a/b.txt", "A/B.txt", "x/COM3.txt", "x/y.", "x/z?.txt", `x/${"q".repeat(120)}`], { budget: BUDGET }).length, 5);
});

// ── Every ZIP producer, on labs of different shapes ─────────────────────────

before(async () => {
  ctx.localAppData = tmp("export-budget-localappdata-");
  ctx.storageRoot = join(tmp("export-budget-"), "storage");
  ctx.generatedRoot = join(ctx.storageRoot, "generated-labs");
  mkdirSync(ctx.generatedRoot, { recursive: true });
  ctx.built = await buildExportSampleLabs(undefined, { root: ctx.generatedRoot });
  ctx.labs = ctx.built.labs;
});

after(() => {
  for (const clean of cleanups.reverse()) clean();
});

const FORMAT_SETS = ["all", "docx", "pptx", "pdf", "html", "pdf,html"];

test("every lab ZIP stays within the budget on every sample lab and format, with the same file counts as the index says", async () => {
  assert.ok(ctx.labs.multi.modules >= 25, `the multi-product lab has ${ctx.labs.multi.modules} modules`);
  assert.equal(ctx.labs.longTitle.title.length, 160);
  for (const [name, lab] of Object.entries(ctx.labs)) {
    for (const formats of ["single", "longTitle"].includes(name) ? FORMAT_SETS : ["all"]) {
      const label = `${name} formats=${formats}`;
      const { summary, names, manifest } = await exportZip(ctx.generatedRoot, lab.labId, { formats });
      assertPathsClean(names, label);
      const topLevel = [...new Set(names.map((n) => n.split("/")[0]))];
      assert.ok(Math.max(...topLevel.map((t) => t.length)) <= 90, `${label}: the longest top-level name is ${Math.max(...topLevel.map((t) => t.length))}`);
      assert.ok(summary.zipFileName.length <= 50 && summary.zipFileName.endsWith(".zip"), `${label}: ZIP name ${summary.zipFileName}`);
      assert.equal(manifest.pathBudget.entryMax, 100);
      assert.deepEqual(manifest.pathBudget.warnings, [], `${label}: the naming never needed the fallback`);
      assert.equal(manifest.pathBudget.entryCount, names.length - 1, "the manifest counts every entry but itself");
      assert.equal(summary.entryCount, names.length);
      assert.equal(summary.longestEntry, Math.max(...names.filter((n) => n !== "export-manifest.json").map((n) => n.length)));
      assert.ok(manifest.labFolder.length <= 30 && manifest.zipFileName === summary.zipFileName);
      // Nothing is written from the on-disk names of the cached topic and training files.
      assert.ok(!names.some((n) => /(^|\/)topics\//.test(n) || /Training deck - |- Step \d\d - |- Recap \d\d - /.test(n)), `${label}: no long on-disk names`);
    }
  }
});

test("the branded ZIP with replacements and a logo, and the static multi-lab ZIP, are inside the budget too", async () => {
  const logo = join(tmp("export-budget-logo-"), "logo.png");
  writeFileSync(logo, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==", "base64"));
  for (const name of ["single", "longTitle"]) {
    const { names, manifest, summary } = await exportZip(ctx.generatedRoot, ctx.labs[name].labId, { formats: "all", branding: { companyName: "Fabrikam Training", tagline: "Learn by doing", primaryColor: "#0F6CBD" }, logoSourcePath: logo }, { Contoso: "Fabrikam Traders" });
    assertPathsClean(names, `branded ${name}`);
    assert.ok(names.includes("_branding/logo.png"));
    assert.equal(manifest.customized, true);
    assert.ok(summary.zipFileName.length <= 50);
  }

  const ids = discoverLabs().slice(0, 3).map((lab) => lab.id);
  assert.ok(ids.length >= 2, "the repository ships static labs");
  const chunks = [];
  const out = new PassThrough();
  out.on("data", (c) => chunks.push(c));
  const result = await exportLabs(ids, {}, out);
  const zip = readZipStrict(Buffer.concat(chunks), { opc: false });
  // The static labs' ZIP carries folder entries, which the OPC check for Office files does not allow; nothing else may be wrong.
  assert.deepEqual(zip.problems.filter((p) => !/directory entries are not allowed/.test(p)), []);
  const names = [...zip.entries.keys()].filter((n) => !n.endsWith("/"));
  assertPathsClean(names, "multi-lab ZIP");
  const manifest = JSON.parse(zip.entries.get("export-manifest.json").toString("utf8"));
  assert.deepEqual(manifest.labs, ids);
  assert.deepEqual(manifest.pathBudget.warnings, []);
  assert.ok(result.longestEntry <= 100 && result.entryCount >= names.length);
  assert.ok(names.filter((n) => n !== "export-manifest.json").every((n) => manifest.index.some((row) => row.path === n)), "the manifest index covers every file");
});

test("the README and the manifest index map every short path to its full title, kind, format, order, and minutes", async () => {
  for (const name of ["single", "multi"]) {
    const lab = ctx.labs[name];
    const { entries, names, manifest } = await exportZip(ctx.generatedRoot, lab.labId, { formats: "all" });
    const readme = entries.get("README.md").toString("utf8");
    assert.ok(readme.includes(EXTRACT_ON_WINDOWS_TIP), "the README says what to do if Windows still complains");
    assert.match(EXTRACT_ON_WINDOWS_TIP, /C:\\Labs.*7-Zip.*long paths/);
    assert.match(readme, /^## Contents$/m);

    // The index: every entry but the manifest itself, in short paths.
    const index = new Map(manifest.index.map((row) => [row.path, row]));
    assert.equal(index.size, names.length - 1);
    for (const path of names.filter((n) => n !== "export-manifest.json")) {
      const row = index.get(path);
      assert.ok(row, `the index covers ${path}`);
      assert.ok(row.title && row.kind && "format" in row && "moduleOrder" in row && "minutes" in row, `${path}: ${JSON.stringify(row)}`);
    }

    // Every module: its full title, step label, and minutes in the README table and the index.
    for (const mod of manifest.modules) {
      assert.ok(readme.includes(mod.title), `the README gives the full title: ${mod.title}`);
      assert.ok(readme.includes(`\`${mod.folder.split("/").pop()}/\``), "and the folder it is in");
      for (const document of mod.documents) {
        const row = index.get(document);
        assert.equal(row.moduleOrder, mod.order);
        assert.ok(row.title.includes(mod.title) && row.title.includes(mod.stepLabel), row.title);
        assert.ok(Object.values(DOC_KINDS).includes(row.kind) && ["docx", "pptx", "pdf", "html"].includes(row.format));
        assert.equal(row.minutes, mod.minutes);
        assert.ok(readme.includes(`\`${baseOf(document)}\``), `the README lists ${baseOf(document)}`);
      }
      for (const sample of mod.sampleFiles) {
        assert.equal(index.get(sample).kind, "Sample file");
        assert.ok(readme.includes(`\`${baseOf(sample)}\``), `the README lists ${baseOf(sample)}`);
      }
    }
    // Every other document appears in the README by its short path; pictures are counted.
    for (const row of manifest.index.filter((r) => r.kind !== "Picture" && r.kind !== "Sample file" && !manifest.modules.some((m) => m.documents.includes(r.path)))) {
      if (row.path === "README.md") continue;
      assert.ok(readme.includes(`\`${row.path}\``) || readme.includes(row.path), `the README lists ${row.path}`);
    }
    assert.ok(manifest.modules.every((m) => m.fileBaseName.includes(" - ")), "the lab's own long name for each module is still recorded");
    // The README does not become a wall of text: the picture list is a count.
    assert.ok(!names.filter((n) => /\/assets\//.test(n)).some((n) => readme.includes(`\`${n}\``)));
    // Old fields stay, new ones are added.
    for (const key of ["exportedAt", "source", "labs", "title", "formats", "overviewFolder", "trainingDecksFolder", "trainingDecks", "trainingMinutes", "administratorFolder", "administratorFiles", "facilitatorGuideFolder", "facilitatorGuideFiles", "customerPrerequisitesChecklist", "modules", "customized", "branding"]) assert.ok(key in manifest, key);
    for (const key of ["labFolder", "zipFileName", "pathBudget", "index"]) assert.ok(key in manifest, key);
    assert.ok(manifest.trainingDecks.every((d) => d.file.startsWith(`${TRAINING_ZIP_FOLDER}/`) && names.includes(d.file)));
  }
});

test("a path that cannot fit is shortened with a hash and a warning outside tests, and is an internal error inside them", async () => {
  const copy = join(ctx.generatedRoot, "over-budget-copy");
  cpSync(ctx.labs.single.outputDir, copy, { recursive: true });
  const longAsset = `${"a-picture-name-that-is-far-too-long-".repeat(3)}x.png`;
  assert.ok(longAsset.length > 100);
  writeFileSync(join(copy, "assets", longAsset), readFileSync(join(copy, "assets", readdirSync(join(copy, "assets"))[0])));

  const previous = process.env.PORTAL_EXPORT_STRICT_BUDGET;
  try {
    process.env.PORTAL_EXPORT_STRICT_BUDGET = "on";
    await assert.rejects(exportZip(ctx.generatedRoot, "over-budget-copy", { formats: "docx" }), (err) => err instanceof ExportBudgetError && /over the budget/.test(err.message));
    process.env.PORTAL_EXPORT_STRICT_BUDGET = "off";
    const { names, manifest, summary } = await exportZip(ctx.generatedRoot, "over-budget-copy", { formats: "docx" });
    assert.ok(Math.max(...names.map((n) => n.length)) <= 100, "the export still succeeds and stays within the budget");
    assert.ok(manifest.pathBudget.warnings.length >= 1 && summary.warnings.length === manifest.pathBudget.warnings.length);
    const warning = manifest.pathBudget.warnings.find((w) => w.code === "path-shortened");
    assert.ok(warning && warning.original.endsWith(longAsset) && /~[0-9a-f]{4}\.png$/.test(warning.shortened) && warning.length <= 100, JSON.stringify(warning));
    assert.ok(names.includes(warning.shortened));
    assert.equal(auditEntryPaths(names, { budget: BUDGET }).length, 0);
  } finally {
    if (previous === undefined) delete process.env.PORTAL_EXPORT_STRICT_BUDGET;
    else process.env.PORTAL_EXPORT_STRICT_BUDGET = previous;
    rmSync(copy, { recursive: true, force: true });
  }
});

test("a lab saved before topic and training files existed, or with long old file names, exports with the same short names", async () => {
  const current = await exportZip(ctx.generatedRoot, ctx.labs.single.labId, { formats: "all" });

  const older = join(ctx.generatedRoot, "older-lab-copy");
  cpSync(ctx.labs.single.outputDir, older, { recursive: true });
  rmSync(join(older, "topics"), { recursive: true, force: true });
  rmSync(join(older, "training"), { recursive: true, force: true });
  const manifestPath = join(older, "manifest.json");
  const saved = JSON.parse(readFileSync(manifestPath, "utf8"));
  delete saved.topicDocuments;
  delete saved.topicDocumentsVersion;
  writeFileSync(manifestPath, JSON.stringify(saved, null, 2));
  const withoutCaches = await exportZip(ctx.generatedRoot, "older-lab-copy", { formats: "all" });
  const strip = (names) => names.map((n) => n.replace(/^[^/]+\//, "")).filter((n) => !n.endsWith("/")).sort();
  assert.deepEqual(strip(withoutCaches.names), strip(current.names), "the same files, the same short names");
  assertPathsClean(withoutCaches.names, "lab without cached files");

  // Old long file names on disk (a topic document and a training deck from before) are never used as ZIP names.
  mkdirSync(join(older, "topics"), { recursive: true });
  mkdirSync(join(older, "training"), { recursive: true });
  const longOld = `${"Energy and Resources Field Operations Assistant ".repeat(2)}- Step 01 - ${"Create an agent ".repeat(3)}.docx`;
  writeFileSync(join(older, "topics", longOld), "old");
  writeFileSync(join(older, "training", `Training deck - Module 01 - ${"Create an agent ".repeat(5)}.pptx`), "old");
  const withOld = await exportZip(ctx.generatedRoot, "older-lab-copy", { formats: "all" });
  assert.deepEqual(strip(withOld.names), strip(current.names));
  assert.ok(!withOld.names.some((n) => n.includes("Step 01 -") || n.includes("Training deck - ")));
  rmSync(older, { recursive: true, force: true });
});

// ── Every route, with the real server ───────────────────────────────────────

test("every export route and format serves names within the limits: ZIPs at most 50, single files at most 120", async () => {
  const base = await startServer(ctx.storageRoot, ctx.localAppData);
  const labUrl = (name, path = "", prefix = "/api/lab-builder/generated") => `${base}${prefix}/${encodeURIComponent(ctx.labs[name].labId)}${path}`;
  const seen = [];
  const get = async (name, path, init) => {
    const res = await fetch(labUrl(name, path), init);
    const buffer = Buffer.from(await res.arrayBuffer());
    assert.equal(res.status, 200, `${name} ${path}: ${buffer.toString("utf8").slice(0, 200)}`);
    const fileName = dispositionName(res);
    assert.ok(fileName, `${name} ${path} has a file name`);
    seen.push({ name, path, fileName });
    return { res, buffer, fileName };
  };

  for (const name of ["single", "multi", "learnOnly", "foundry", "longTitle"]) {
    const orders = JSON.parse(readFileSync(join(ctx.labs[name].outputDir, "manifest.json"), "utf8")).modules.map((m, i) => Number(m.order) || i + 1);
    const zipFormats = name === "multi" ? ["all"] : ["all", "docx", "pptx", "pdf", "html"];
    for (const formats of zipFormats) {
      const { buffer, fileName } = await get(name, `/export?format=zip&formats=${formats}`);
      assert.ok(fileName.length <= 50 && fileName.endsWith(".zip") && fileName.includes(" - Lab package"), `${name} ${formats}: ${fileName}`);
      const zip = readZipStrict(buffer, { opc: false });
      assertPathsClean([...zip.entries.keys()], `${name} formats=${formats} over HTTP`);
    }
    const posted = await get(name, "/export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ format: "zip", formats: "docx", replacements: { Contoso: "Fabrikam Traders" } }) });
    assert.ok(posted.fileName.length <= 50 && posted.fileName.includes("(docx)"));

    // The training decks ZIP and the foundations decks, a deck by number, and the complete deck.
    const training = await get(name, "/export?format=training");
    assert.ok(training.fileName.length <= 50 && training.fileName.endsWith(" - Training decks.zip"), training.fileName);
    const trainingZip = readZipStrict(training.buffer, { opc: false });
    assertPathsClean([...trainingZip.entries.keys()], `${name} training ZIP`);
    assert.ok([...trainingZip.entries.keys()].every((n) => n.startsWith(`${TRAINING_ZIP_FOLDER}/`)));
    const foundations = await get(name, "/export?format=training-foundations");
    assert.ok(foundations.fileName.length <= 120);
    if (/\.zip$/.test(foundations.fileName)) {
      assert.ok(foundations.fileName.length <= 50, foundations.fileName);
      assert.ok([...readZipStrict(foundations.buffer, { opc: false }).entries.keys()].every((n) => /\/Training 00 Foundations /.test(n)));
    }
    await get(name, "/export?format=training-complete");
    await get(name, `/training/${orders[0]}`);
    await get(name, "/training/complete/pptx");

    // Single downloads.
    for (const format of ["docx", "pptx", "pdf", "html", "md", "facilitator-docx", "facilitator-pdf", "facilitator-md", "facilitator-html", "prerequisites-docx", "prerequisites-pdf", "prerequisites-html", "prerequisites-md", "admin-guide-docx", "admin-guide-pdf", "admin-guide-html", "admin-guide-md"]) {
      if (name === "multi" && !["docx", "facilitator-docx", "prerequisites-docx", "admin-guide-docx"].includes(format)) continue;
      const { fileName } = await get(name, `/export?format=${format}`);
      assert.ok(fileName.length <= 120, `${name} ${format}: ${fileName.length} ${fileName}`);
      assert.match(fileName, /\.(docx|pptx|pdf|html|md)$/);
    }
    for (const order of [orders[0], orders[orders.length - 1]]) {
      for (const format of ["docx", "pptx"]) {
        const { fileName } = await get(name, `/topics/${order}/${format}`);
        assert.ok(fileName.length <= 120 && fileName.endsWith(`.${format}`), fileName);
      }
    }
  }

  // The long title still gives readable, descriptive single-file names, and the ZIP name carries the short lab name.
  const named = seen.filter((s) => s.name === "longTitle");
  assert.ok(named.some((s) => /^Cafe Reunion Fabrikam Plant - Lab package\.zip$/.test(s.fileName)));
  assert.ok(named.some((s) => s.path.includes("facilitator-docx") && /Facilitator Guide\.docx$/.test(s.fileName)));
  assert.ok(named.some((s) => s.path.includes("admin-guide-docx") && /Administrator setup guide\.docx$/.test(s.fileName)));
  assert.ok(named.some((s) => s.path.includes("prerequisites-docx") && /Prerequisites checklist\.docx$/.test(s.fileName)));
  assert.ok(seen.length > 100 && seen.every((s) => s.fileName.length <= 120));
});

// ── Extracting for real ─────────────────────────────────────────────────────

const POWERSHELL = process.platform === "win32" ? join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : null;
const CAN_EXTRACT = Boolean(POWERSHELL && existsSync(POWERSHELL));

const EXTRACT_SCRIPT = `
param([string]$ZipPath, [string]$Work, [int]$PrefixLength)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$entries = @()
$reader = [IO.Compression.ZipFile]::OpenRead($ZipPath)
try { foreach ($e in $reader.Entries) { if ($e.FullName -and -not $e.FullName.EndsWith('/')) { $entries += [pscustomobject]@{ Name = $e.FullName; Length = $e.Length } } } } finally { $reader.Dispose() }
$result = @()
foreach ($method in 'ExtractToDirectory', 'Expand-Archive') {
  $path = Join-Path $Work $method.Substring(0, 3)
  while ($path.Length -lt $PrefixLength) { $n = [Math]::Min(60, $PrefixLength - $path.Length - 1); if ($n -lt 1) { break }; $path = Join-Path $path ('p' * $n) }
  New-Item -ItemType Directory -Path $path -Force | Out-Null
  $dest = Join-Path $path ([IO.Path]::GetFileNameWithoutExtension($ZipPath))
  $status = 'ok'; $missing = 0; $wrong = 0; $detail = ''
  try {
    if ($method -eq 'ExtractToDirectory') { [IO.Compression.ZipFile]::ExtractToDirectory($ZipPath, $dest) } else { Expand-Archive -LiteralPath $ZipPath -DestinationPath $dest -Force }
    foreach ($e in $entries) {
      $file = Join-Path $dest ($e.Name -replace '/', '\\')
      if (-not (Test-Path -LiteralPath $file)) { $missing++ } elseif ((Get-Item -LiteralPath $file).Length -ne $e.Length) { $wrong++ }
    }
  } catch { $status = 'failed'; $detail = $_.Exception.GetType().Name + ': ' + $_.Exception.Message }
  $longest = 0; foreach ($e in $entries) { if ($e.Name.Length -gt $longest) { $longest = $e.Name.Length } }
  $result += [pscustomobject]@{ method = $method; status = $status; detail = $detail; entries = $entries.Count; missing = $missing; wrong = $wrong; destLength = $dest.Length; worstFullPath = $dest.Length + 1 + $longest }
}
$result | ConvertTo-Json -Compress
`;

test("a lab ZIP extracts under a 110 character folder with Expand-Archive and ZipFile.ExtractToDirectory, every file the right size", { skip: CAN_EXTRACT ? false : "needs Windows PowerShell (powershell.exe) to extract the ZIP" }, async () => {
  const work = tmp("export-budget-extract-");
  const script = join(work, "extract.ps1");
  writeFileSync(script, EXTRACT_SCRIPT);
  for (const name of ["single", "longTitle"]) {
    const { buffer, summary, names } = await exportZip(ctx.generatedRoot, ctx.labs[name].labId, { formats: "all" });
    const zipPath = join(work, summary.zipFileName);
    writeFileSync(zipPath, buffer);
    const env = { ...process.env, LOCALAPPDATA: ctx.localAppData };
    // A PowerShell 7 parent leaves its module path in the environment; Windows PowerShell 5.1 would then load a newer
    // Expand-Archive written for a newer .NET. The built-in module is the one a person has.
    for (const key of Object.keys(env)) if (/^psmodulepath$/i.test(key)) delete env[key];
    const run = spawnSync(POWERSHELL, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-ZipPath", zipPath, "-Work", join(work, `out-${name}`), "-PrefixLength", String(ASSUMED_EXTRACT_PREFIX)], { encoding: "utf8", timeout: 240000, env });
    assert.equal(run.status, 0, `${name}: ${run.stderr || run.stdout}`);
    const rows = [].concat(JSON.parse(run.stdout.trim()));
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.status, "ok", `${name} ${row.method}: ${row.detail}`);
      assert.equal(row.entries, names.filter((n) => !n.endsWith("/")).length);
      assert.equal(row.missing, 0, `${name} ${row.method}: files missing`);
      assert.equal(row.wrong, 0, `${name} ${row.method}: wrong sizes`);
      assert.ok(row.destLength >= ASSUMED_EXTRACT_PREFIX, "the extraction folder is 110 characters deep or more");
      assert.ok(row.worstFullPath < WINDOWS_MAX_PATH, `${name} ${row.method}: the longest extracted path is ${row.worstFullPath}`);
    }
  }
});

test("the command line tools name their files within 120 characters", () => {
  const dir = ctx.labs.longTitle.outputDir;
  const out = tmp("export-budget-cli-");
  for (const script of ["export-admin-guide.mjs", "export-prerequisites.mjs"]) {
    const run = spawnSync(process.execPath, [join(REPO_ROOT, "tools", "lab-builder", script), "--lab", dir, "--format", "md", "--out", out], { encoding: "utf8", env: { ...process.env, LOCALAPPDATA: ctx.localAppData, LAB_BUILDER_LINK_CHECK: "off" } });
    assert.equal(run.status, 0, run.stderr);
  }
  const files = readdirSync(out);
  assert.equal(files.length, 2);
  for (const file of files) assert.ok(file.length <= 120 && file.endsWith(".md"), `${file.length} ${file}`);
});

test("the page saves a ZIP under the short name the server chose, not a name built from the long title", async () => {
  const source = readFileSync(new URL("../public/generated-labs.js", import.meta.url), "utf8");
  const saved = [];
  const serverName = "Retail Store Support Assistant - Lab package.zip";
  const respond = (header) => async () => ({ ok: true, blob: async () => ({}), headers: { get: (name) => (String(name).toLowerCase() === "content-disposition" ? header : null) } });
  const context = {
    CSS: { escape: (s) => String(s) },
    escapeHtml: (s) => String(s ?? ""),
    labBuilder: { industries: [], levels: [], harnesses: [], products: [] },
    lbFormatMinutes: (m) => `${m} min`,
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => {
        const link = { click() { saved.push(link.download); }, remove() {} };
        return link;
      },
      body: { appendChild() {} },
    },
    window: { addEventListener() {} },
    fetch: respond(`attachment; filename="${serverName}"; filename*=UTF-8''${encodeURIComponent(serverName)}`),
    toast: () => {},
    Blob: class {},
    URL: { createObjectURL: () => "blob:test", revokeObjectURL() {} },
  };
  vm.createContext(context);
  vm.runInContext(readFileSync(new URL("../public/screenshot-center-core.js", import.meta.url), "utf8"), context);
  vm.runInContext(`${source}\nglobalThis.__ui = { lbExportGeneratedZip, lbDownloadNameFrom };`, context);

  await context.__ui.lbExportGeneratedZip("any-lab", null);
  assert.deepEqual(saved, [serverName]);
  assert.equal(context.__ui.lbDownloadNameFrom({ headers: { get: () => "attachment; filename*=UTF-8''Caf%C3%A9%20-%20Lab%20package.zip" } }, "x.zip"), "Café - Lab package.zip");
  assert.equal(context.__ui.lbDownloadNameFrom({ headers: { get: () => "attachment; filename=plain.zip" } }, "x.zip"), "plain.zip");

  // With no usable header the fallback is still short, with the ZIP kind in the name.
  context.fetch = respond(null);
  await context.__ui.lbExportGeneratedZip("any-lab", null);
  assert.ok(saved[1].length <= 50 && /Lab package\.zip$/.test(saved[1]), saved[1]);
});
