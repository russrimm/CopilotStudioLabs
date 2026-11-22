/**
 * A lab's folder under concurrent use: two builds of the same request, two writers of the same topic documents, readers
 * while a lab is deleted or replaced, a lab that is still being built, and the list that stays fast with many labs.
 * Everything runs against throwaway folders; the multi-process tests start the portal's own code in child processes.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { generateLab } from "../lib/lab-builder/generator.js";
import {
  deleteGeneratedLab,
  generatedLabExists,
  listGeneratedLabs,
  readGeneratedLab,
  replaceGeneratedLab,
  updateGeneratedLabMeta,
} from "../lib/lab-builder/generated-labs.js";
import { BUILDING_MARKER, TRASH_PREFIX, markBuilding, sweepLabLibrary } from "../lib/lab-builder/lab-state.js";
import { resolveSafeGeneratedLabDir } from "../lib/exporter.js";
import { createExportService } from "../lib/exports/export-service.js";
import { checkDocxPackage } from "../../tools/lab-builder/lib/ooxml-strict.mjs";
import { zipArchiveProblems } from "./concurrency/integrity.mjs";

process.env.LAB_BUILDER_VENDOR_DOCS = "off";
process.env.LAB_BUILDER_LINK_CHECK = "off";

const here = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(here, "concurrency", "generate-child.mjs");
const REQUEST = { products: ["copilot-studio"], features: ["mc-memory"], harness: "microsoft-copilot", includeCore: false };
const OTHER = { products: ["copilot-studio"], features: ["create-agent", "agent-instructions"], harness: "standard", includeCore: false };
const ctx = {};

before(() => {
  ctx.root = mkdtempSync(path.join(tmpdir(), "lb-lab-folders-"));
  ctx.labs = path.join(ctx.root, "generated-labs");
  ctx.empty = path.join(ctx.root, "empty-labs");
  mkdirSync(ctx.labs, { recursive: true });
  mkdirSync(ctx.empty, { recursive: true });
});
after(() => rmSync(ctx.root, { recursive: true, force: true }));

const build = (request = REQUEST, outputRoot = ctx.labs, opts = {}) => generateLab(request, { outputRoot, labsDir: ctx.empty, useLearnMcp: false, useLlm: false, ...opts });

function child(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [CHILD, ...args], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, LAB_BUILDER_VENDOR_DOCS: "off", LAB_BUILDER_LINK_CHECK: "off" } });
    let out = "";
    let err = "";
    proc.stdout.on("data", (c) => (out += c));
    proc.stderr.on("data", (c) => (err += c));
    proc.on("exit", (code) => (code === 0 ? resolve(JSON.parse(out.trim().split("\n").pop())) : reject(new Error(`child exited ${code}: ${err.slice(-500)}`))));
  });
}

const visible = (root) => readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith("."));
const isWholeLab = (dir) => existsSync(path.join(dir, "manifest.json")) && existsSync(path.join(dir, "index.md")) && !existsSync(path.join(dir, BUILDING_MARKER));

async function waitUntil(check, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

test("the same request built in two processes at once leaves two valid, distinct labs", async () => {
  const root = path.join(ctx.root, "two-processes");
  mkdirSync(root, { recursive: true });
  const [a, b] = await Promise.all([child(["build", root, ctx.empty, JSON.stringify(REQUEST)]), child(["build", root, ctx.empty, JSON.stringify(REQUEST)])]);
  assert.notEqual(a.labId, b.labId, "two builds never share a folder");
  const dirs = visible(root).map((e) => e.name).sort();
  assert.deepEqual(dirs, [a.labId, b.labId].sort());
  for (const dir of dirs) assert.ok(isWholeLab(path.join(root, dir)), `${dir} is a whole lab`);
  const listed = listGeneratedLabs(root).labs.map((l) => l.labId).sort();
  assert.deepEqual(listed, dirs, "both are listed, nothing half built");
});

test("two processes writing the same topic documents at once leave whole files and no temp leftovers", async () => {
  const root = path.join(ctx.root, "synthesis");
  mkdirSync(root, { recursive: true });
  const built = await build(REQUEST, root);
  const labDir = built.outputDir;
  // An older lab has no topic documents yet: they are made on first use, here by two processes together.
  rmSync(path.join(labDir, "topics"), { recursive: true, force: true });
  const manifest = JSON.parse(readFileSync(path.join(labDir, "manifest.json"), "utf8"));
  delete manifest.topicDocuments;
  delete manifest.topicDocumentsVersion;
  writeFileSync(path.join(labDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  const [x, y] = await Promise.all([child(["topics", root, built.labId]), child(["topics", root, built.labId])]);
  assert.equal(x.missing, 0);
  assert.equal(y.missing, 0);
  assert.equal(x.count, y.count);
  assert.ok(x.count > 0);
  const files = readdirSync(path.join(labDir, "topics"));
  assert.ok(files.every((f) => /\.(docx|pptx)$/.test(f)), `only finished documents remain: ${files.join(", ")}`);
  for (const f of files.filter((n) => n.endsWith(".docx"))) assert.deepEqual(checkDocxPackage(readFileSync(path.join(labDir, "topics", f))), [], f);
  assert.deepEqual(JSON.parse(readFileSync(path.join(labDir, "manifest.json"), "utf8")).topicDocuments.length, x.count, "the manifest was never torn");
});

test("a lab that is still being built is invisible to every reader until it is whole", async () => {
  const root = path.join(ctx.root, "building");
  mkdirSync(root, { recursive: true });
  const seen = [];
  const result = await build(REQUEST, root, {
    onProgress: ({ stage }) => {
      if (stage !== "topics") return;
      const dirs = visible(root);
      seen.push({ dirs: dirs.length, markers: dirs.filter((d) => existsSync(path.join(root, d.name, BUILDING_MARKER))).length, listed: listGeneratedLabs(root).labs.length, exists: dirs.length ? generatedLabExists(root, dirs[0].name) : null, export: dirs.length ? resolveSafeGeneratedLabDir(root, dirs[0].name).status : null, read: dirs.length ? readGeneratedLab(root, dirs[0].name).status : null });
    },
  });
  assert.equal(seen.length, 1, "the build reached its topic documents");
  assert.deepEqual(seen[0], { dirs: 1, markers: 1, listed: 0, exists: false, export: 404, read: 404 }, "while building: the folder exists but nobody can find the lab");
  assert.equal(existsSync(path.join(result.outputDir, BUILDING_MARKER)), false, "the marker is gone once the lab is whole");
  assert.equal(generatedLabExists(root, result.labId), true);
  assert.equal(listGeneratedLabs(root).labs.length, 1);
});

test("at start, trash and builds that died are removed, and a build in progress is left alone", () => {
  const root = path.join(ctx.root, "sweep");
  mkdirSync(path.join(root, `${TRASH_PREFIX}old-lab-1234`), { recursive: true });
  writeFileSync(path.join(root, `${TRASH_PREFIX}old-lab-1234`, "left.txt"), "x");
  for (const name of ["died-build", "live-build", "good-lab"]) mkdirSync(path.join(root, name), { recursive: true });
  markBuilding(path.join(root, "died-build"));
  markBuilding(path.join(root, "live-build"));
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  utimesSync(path.join(root, "died-build", BUILDING_MARKER), old, old);
  const removed = sweepLabLibrary(root);
  assert.deepEqual(removed, { trash: 1, unfinished: 1 });
  assert.deepEqual(readdirSync(root).sort(), ["good-lab", "live-build"]);
});

test("deleting a lab takes it out in one step, so a reader sees the whole lab or 'not found', and the folder is cleaned up behind it", async () => {
  const root = path.join(ctx.root, "delete");
  mkdirSync(root, { recursive: true });
  const built = await build(REQUEST, root);
  assert.equal(readGeneratedLab(root, built.labId).status, 200);
  const removed = deleteGeneratedLab(root, built.labId);
  assert.equal(removed.status, 200);
  assert.equal(existsSync(built.outputDir), false, "the lab is gone from the library the moment delete returns");
  assert.equal(readGeneratedLab(root, built.labId).status, 404);
  assert.equal(resolveSafeGeneratedLabDir(root, built.labId).status, 404);
  assert.equal(deleteGeneratedLab(root, built.labId).status, 404, "a second delete is a clean 'not found'");
  assert.ok(await waitUntil(() => readdirSync(root).length === 0), `the trash folder is removed in the background: ${readdirSync(root).join(", ")}`);
});

test("replacing a lab keeps the new one whole and removes the old one atomically", async () => {
  const root = path.join(ctx.root, "replace");
  mkdirSync(root, { recursive: true });
  const original = await build(REQUEST, root);
  const replacement = await build(OTHER, root);
  const outcome = replaceGeneratedLab(root, original.labId, replacement.labId);
  assert.equal(outcome.replaced, true);
  assert.equal(generatedLabExists(root, original.labId), false);
  assert.equal(generatedLabExists(root, replacement.labId), true);
  assert.deepEqual(listGeneratedLabs(root).labs.map((l) => l.labId), [replacement.labId]);
  await waitUntil(() => readdirSync(root).length === 1);
});

test("the lab list reflects a rename and a delete at once, and its cache never outgrows the labs on disk", async () => {
  const root = path.join(ctx.root, "list-cache");
  mkdirSync(root, { recursive: true });
  const a = await build(REQUEST, root);
  const b = await build(OTHER, root);
  const first = listGeneratedLabs(root).labs;
  assert.equal(first.length, 2);
  assert.deepEqual(listGeneratedLabs(root).labs.map((l) => l.title).sort(), first.map((l) => l.title).sort(), "a second look gives the same list");
  const renamed = updateGeneratedLabMeta(root, a.labId, { title: "A new title for the first lab" });
  assert.equal(renamed.status, 200);
  assert.equal(listGeneratedLabs(root).labs.find((l) => l.labId === a.labId).title, "A new title for the first lab", "a changed manifest is read again");
  assert.equal(deleteGeneratedLab(root, b.labId).status, 200);
  assert.deepEqual(listGeneratedLabs(root).labs.map((l) => l.labId), [a.labId]);
  const entry = listGeneratedLabs(root).labs[0];
  entry.title = "changed by a caller";
  assert.notEqual(listGeneratedLabs(root).labs[0].title, "changed by a caller", "callers get their own copy of each entry");
});

test("exports built in a worker thread are the same files, and a lab that is gone is a clean 404", async (t) => {
  const root = path.join(ctx.root, "exports");
  mkdirSync(root, { recursive: true });
  const built = await build(REQUEST, root);
  const stage = path.join(ctx.root, "export-stage");
  const previous = process.env.PORTAL_EXPORT_WORKERS;
  process.env.PORTAL_EXPORT_WORKERS = "1";
  const pooled = createExportService({ generatedRoot: root, tempDir: stage });
  process.env.PORTAL_EXPORT_WORKERS = "0";
  const inline = createExportService({ generatedRoot: root, tempDir: stage });
  if (previous === undefined) delete process.env.PORTAL_EXPORT_WORKERS;
  else process.env.PORTAL_EXPORT_WORKERS = previous;
  t.after(() => pooled.close());

  const args = (name) => [root, built.labId, {}, ...(name === "md" ? [] : [{ resolveAsset: true }])];
  const md = await Promise.all([pooled.render("renderGeneratedLabMarkdown", args("md")), inline.render("renderGeneratedLabMarkdown", args("md"))]);
  assert.equal(md[0].status, 200);
  assert.equal(md[0].markdown, md[1].markdown, "markdown is identical");
  const html = await Promise.all([pooled.render("renderGeneratedLabHtml", args("html")), inline.render("renderGeneratedLabHtml", args("html"))]);
  assert.equal(html[0].html, html[1].html, "html is identical");
  const docx = await Promise.all([pooled.render("renderGeneratedLabDocx", args("docx")), inline.render("renderGeneratedLabDocx", args("docx")), inline.render("renderGeneratedLabDocx", args("docx"))]);
  assert.ok(Buffer.isBuffer(docx[0].buffer), "a Buffer comes back from the worker, not a plain array");
  assert.deepEqual(checkDocxPackage(docx[0].buffer), []);
  if (docx[1].buffer.equals(docx[2].buffer)) assert.ok(docx[0].buffer.equals(docx[1].buffer), "the Word export is byte for byte what the main thread makes");

  const zip = await pooled.buildZip(built.labId, {}, { formats: ["docx"] });
  t.after(() => zip.remove());
  assert.deepEqual(zipArchiveProblems(readFileSync(zip.file)), []);
  zip.remove();
  assert.equal(existsSync(zip.file), false);
  assert.deepEqual(readdirSync(stage), [], "no staged file is left");

  deleteGeneratedLab(root, built.labId);
  const gone = await pooled.render("renderGeneratedLabDocx", args("docx"));
  assert.equal(gone.status, 404);
  await assert.rejects(pooled.buildZip(built.labId, {}, {}), (err) => err.status === 404);
});
