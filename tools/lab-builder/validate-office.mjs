#!/usr/bin/env node
/**
 * Validate generated Office exports (.pptx / .docx) with three independent layers:
 *
 *   1. strict    Dependency-free OPC/OOXML invariant checks (always available).
 *   2. open-xml  The Open XML SDK validator (needs the .NET SDK; skipped when absent).
 *   3. office    The real desktop app opened read-only and hidden through COM
 *                (Windows with PowerPoint/Word only; skipped otherwise).
 *
 * Why three layers: lenient readers (python-pptx, the SDK validator) accept packages
 * that PowerPoint rejects as "corrupted and unreadable", for example a notes master that
 * shares the slide master's theme part. The strict layer encodes those invariants, and
 * the Office layer is the final oracle.
 *
 * Usage:
 *   node tools/lab-builder/validate-office.mjs                 # build the standard matrix and check it
 *   node tools/lab-builder/validate-office.mjs a.pptx b.docx   # check existing files
 *
 * Options:
 *   --no-labs          matrix without real generated labs (synthetic decks only)
 *   --only <regex>     keep only matrix cases whose id matches
 *   --keep <dir>       write the matrix files to <dir> and keep them
 *   --skip-dotnet      skip the Open XML SDK validator
 *   --skip-office      skip the PowerPoint/Word COM open test
 *   --timeout <sec>    per-file COM timeout (default 90)
 *   --json             print a machine-readable report
 *
 * Safety: an already-running PowerPoint/Word is never quit or killed; files are opened
 * read-only without a window and only those documents are closed (see office-open-test.ps1).
 * Exit code 0 means every layer that ran passed; skipped layers are reported but do not fail.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkOfficePackage } from "./lib/ooxml-strict.mjs";
import { buildOfficeMatrix, writeMatrixFiles } from "./lib/office-matrix.mjs";
import { parseJsonLines, prepareOpenXmlValidator, runOpenXmlValidator } from "./lib/openxml-validator.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const COM_SCRIPT = join(HERE, "office-open-test.ps1");

function parseArgs(argv) {
  const opts = { files: [], labs: true, only: null, keep: null, dotnet: true, office: true, timeout: 90, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--no-labs") opts.labs = false;
    else if (arg === "--only") opts.only = new RegExp(argv[(i += 1)], "i");
    else if (arg === "--keep") opts.keep = resolve(argv[(i += 1)]);
    else if (arg === "--skip-dotnet") opts.dotnet = false;
    else if (arg === "--skip-office") opts.office = false;
    else if (arg === "--timeout") opts.timeout = Number(argv[(i += 1)]) || 90;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg.startsWith("--")) throw new Error(`Unknown option ${arg}`);
    else opts.files.push(resolve(arg));
  }
  return opts;
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function hasRegisteredApp(exe) {
  if (process.platform !== "win32") return false;
  const key = `HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`;
  return spawnSync("reg", ["query", key], { encoding: "utf8" }).status === 0;
}

function runOfficeOpenTest(files, timeoutSeconds) {
  const results = new Map();
  for (const batch of chunk(files, 10)) {
    const run = spawnSync(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", COM_SCRIPT, ...batch, "-TimeoutSeconds", String(timeoutSeconds)],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    for (const row of parseJsonLines(run.stdout)) results.set(resolve(row.file), row);
  }
  return results;
}

const kindOf = (file) => extname(file).slice(1).toLowerCase();

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").match(/\/\*\*([\s\S]*?)\*\//)[1].replace(/^ \* ?/gm, ""));
    return 0;
  }

  let entries;
  let cleanup = () => {};
  if (opts.files.length) {
    entries = opts.files.map((file) => ({ id: basename(file), kind: kindOf(file), file, buffer: readFileSync(file) }));
  } else {
    const matrix = await buildOfficeMatrix({ labs: opts.labs, log: (msg) => !opts.json && console.error(`[matrix] ${msg}`) });
    const selected = opts.only ? matrix.cases.filter((c) => opts.only.test(c.id)) : matrix.cases;
    const dir = opts.keep || mkdtempSync(join(tmpdir(), "office-validate-"));
    entries = writeMatrixFiles(selected, dir);
    cleanup = () => {
      matrix.cleanup();
      if (!opts.keep) rmSync(dir, { recursive: true, force: true });
    };
    if (!opts.json) console.error(`[matrix] ${entries.length} files written to ${dir}`);
  }

  const layers = { strict: { ran: true }, "open-xml": { ran: false }, office: { ran: false } };
  const rows = entries.map((e) => ({
    file: e.file,
    kind: e.kind,
    strict: checkOfficePackage(e.buffer, e.kind, { expectNotes: e.expectNotes }),
    openXml: null,
    office: null,
  }));

  if (!opts.dotnet) layers["open-xml"].skipped = "--skip-dotnet";
  else {
    const prepared = prepareOpenXmlValidator();
    if (prepared.skip) layers["open-xml"].skipped = prepared.skip;
    else {
      layers["open-xml"].ran = true;
      const byFile = runOpenXmlValidator(prepared.dll, entries.map((e) => e.file));
      for (const row of rows) row.openXml = byFile.get(resolve(row.file)) || { opened: false, openError: "no validator output", errorCount: 1, errors: [] };
    }
  }

  if (!opts.office) layers.office.skipped = "--skip-office";
  else if (process.platform !== "win32") layers.office.skipped = "real Office COM automation needs Windows";
  else {
    const need = { pptx: hasRegisteredApp("POWERPNT.EXE"), docx: hasRegisteredApp("WINWORD.EXE") };
    const runnable = rows.filter((r) => need[r.kind]);
    const missing = Object.entries(need).filter(([, ok]) => !ok).map(([k]) => (k === "pptx" ? "PowerPoint" : "Word"));
    if (!runnable.length) layers.office.skipped = "PowerPoint/Word is not installed";
    else {
      layers.office.ran = true;
      if (missing.length) layers.office.note = `${missing.join(" and ")} not installed; those files were not opened`;
      const byFile = runOfficeOpenTest(runnable.map((r) => r.file), opts.timeout);
      for (const row of runnable) row.office = byFile.get(resolve(row.file)) || { ok: false, error: "no result from the COM script" };
    }
  }

  const failures = [];
  for (const row of rows) {
    const name = basename(row.file);
    if (row.strict.length) failures.push({ file: name, layer: "strict", detail: row.strict.slice(0, 5) });
    if (row.openXml && (!row.openXml.opened || row.openXml.errorCount > 0)) {
      failures.push({
        file: name,
        layer: "open-xml",
        detail: row.openXml.openError ? [row.openXml.openError] : row.openXml.errors.slice(0, 5).map((e) => `${e.part} ${e.path}: ${e.description}`),
      });
    }
    if (row.office && !row.office.ok) failures.push({ file: name, layer: "office", detail: [row.office.error] });
  }

  const summary = {
    files: rows.length,
    layers,
    passed: failures.length === 0,
    failures,
    notesSlidesOpenedInOffice: rows.filter((r) => r.office?.slidesWithNotes).reduce((n, r) => n + r.office.slidesWithNotes, 0),
  };

  if (opts.json) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(`\nOffice export validation: ${rows.length} file(s)`);
    for (const [name, layer] of Object.entries(layers)) {
      const failed = failures.filter((f) => f.layer === name).length;
      const state = layer.ran ? (failed ? `FAIL (${failed} file(s))` : "PASS") : `SKIPPED (${layer.skipped})`;
      console.log(`  ${name.padEnd(9)} ${state}${layer.note ? ` - ${layer.note}` : ""}`);
    }
    for (const f of failures) {
      console.log(`\n  [${f.layer}] ${f.file}`);
      for (const d of f.detail) console.log(`      ${d}`);
    }
    console.log(summary.passed ? "\nRESULT: PASS" : "\nRESULT: FAIL");
  }
  cleanup();
  return summary.passed ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(err.stack || err.message);
    process.exitCode = 2;
  },
);
