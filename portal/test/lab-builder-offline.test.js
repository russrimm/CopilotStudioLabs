/**
 * The lab builder CLI runs without the portal's npm dependencies installed.
 *
 * CI's "Validate offline lab builder" and "Validate a generated lab" steps run
 * `tools/lab-builder/build.mjs` before `npm ci`. A static import of an npm
 * package anywhere in the builder's import graph breaks both, and passes locally
 * whenever `portal/node_modules` happens to exist. These tests run the CLI in a
 * child process with a resolve hook that refuses every npm package, so they
 * fail the same way CI would.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const BUILD = join(repoRoot, "tools", "lab-builder", "build.mjs");
const HOOK = pathToFileURL(join(here, "fixtures", "no-npm-packages.mjs")).href;

function runWithoutPackages(args) {
  return spawnSync(process.execPath, ["--import", HOOK, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    // Offline and hermetic, like the CI step: no link checks, no model.
    env: { ...process.env, LAB_BUILDER_LINK_CHECK: "off", LAB_BUILDER_LLM: "off", LAB_BUILDER_VENDOR_DOCS: "" },
    timeout: 60000,
  });
}

test("the hook really blocks npm packages", () => {
  const probe = runWithoutPackages(["--input-type=module", "-e", 'await import("sanitize-html");']);
  assert.notEqual(probe.status, 0);
  assert.match(probe.stderr, /Blocked npm package "sanitize-html"/);
});

test("the offline dry run from CI needs no npm package", () => {
  const run = runWithoutPackages([BUILD, "--features", "create-agent", "--no-learn", "--no-llm", "--dry-run"]);
  assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
  assert.match(run.stdout, /Dry run — nothing was written/);
});

test("an offline build that writes a lab, including a vendor module, needs no npm package", (t) => {
  const out = mkdtempSync(join(tmpdir(), "lab-builder-offline-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));

  const run = runWithoutPackages([
    BUILD,
    "--features",
    "create-agent,mcp-servers",
    "--no-learn",
    "--no-llm",
    "--non-interactive",
    "--out",
    out,
  ]);
  assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
  assert.match(run.stdout, /Validation {2}\d+ passed, 0 failed/);
  assert.match(run.stdout, /Vendor docs 0\/2 cited vendor page\(s\) read/);
  assert.equal(readdirSync(out).length, 1);
});

test("reading a vendor page without sanitize-html raises the blocker instead of crashing", () => {
  const run = runWithoutPackages([join(here, "fixtures", "vendor-build-without-sanitizer.mjs")]);
  assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
  const result = JSON.parse(run.stdout.trim().split("\n").at(-1));
  assert.equal(result.status, "blocked");
  assert.equal(result.code, "vendor-docs-unavailable");
  assert.ok(result.kinds.length > 0 && result.kinds.every((kind) => kind === "dependency"), JSON.stringify(result.kinds));
  assert.match(result.consequence, /sanitize-html package could not be loaded/);
  assert.match(result.consequence, /run npm ci in portal\/ and then retry/);
});
