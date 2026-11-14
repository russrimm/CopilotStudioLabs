import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getProducts } from "../lib/lab-builder/products.js";
import { getDepartments } from "../lib/scenarios.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const CLI_PATH = path.join(REPO_ROOT, "tools", "lab-builder", "build.mjs");

function runCli(args, extraEnv = {}) {
  return execFileSync(process.execPath, [CLI_PATH, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      LAB_BUILDER_LINK_CHECK: "off",
      ...extraEnv,
    },
  });
}

test("CLI --help shows Microsoft AI Training Generator branding, new flags, and US English", () => {
  const out = runCli(["--help"]);
  assert.match(out, /Microsoft AI Training Generator — Custom Lab Builder CLI/);
  for (const flag of ["--products", "--departments", "--harnesses", "--levels", "--core", "--features"]) {
    assert.ok(out.includes(flag), `Expected --help output to mention ${flag}`);
  }
  assert.match(out, /a decision canceled the build/);
  assert.doesNotMatch(out, /cancelled|Cancelling|honour/i);
});

test("CLI --list prints all 6 Microsoft AI products, departments, and grouped capabilities in US English", () => {
  const out = runCli(["--list"]);
  assert.match(out, /Microsoft AI Training Generator — Custom Lab Builder CLI/);
  assert.match(out, /\nProducts\n/);
  assert.match(out, /\nDepartments\n/);
  assert.match(out, /\nCapabilities by Product\n/);
  assert.doesNotMatch(out, /Copilot Studio features/);
  assert.doesNotMatch(out, /cancelled|Cancelling|honour/i);

  const products = getProducts();
  assert.equal(products.length, 6);
  for (const product of products) {
    assert.ok(out.includes(product.id), `Expected --list output to include product id ${product.id}`);
    assert.ok(out.includes(product.name), `Expected --list output to include product name ${product.name}`);
  }

  const departments = getDepartments();
  assert.ok(departments.length > 0);
  for (const dept of departments) {
    assert.ok(out.includes(dept.id), `Expected --list output to include department id ${dept.id}`);
  }
});

test("CLI offline build supports --products, --departments, --roles, and non-Copilot-Studio capabilities", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lab-builder-cli-test-"));
  try {
    const out = runCli([
      "--no-learn",
      "--no-llm",
      "--products",
      "ai-foundry",
      "--industry",
      "manufacturing",
      "--departments",
      "it-operations",
      "--roles",
      "developer",
      "--features",
      "fdy-orient-foundry",
      "--out",
      tmpDir,
    ]);

    assert.match(out, /Validation\s+\d+ passed, 0 failed/);
    const entries = fs.readdirSync(tmpDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    assert.equal(entries.length, 1);

    const labDir = path.join(tmpDir, entries[0].name);
    const indexMd = fs.readFileSync(path.join(labDir, "index.md"), "utf8");
    const manifest = JSON.parse(fs.readFileSync(path.join(labDir, "manifest.json"), "utf8"));

    assert.match(indexMd, /Microsoft Foundry/);
    assert.deepEqual(manifest.request.products, ["ai-foundry"]);
    assert.ok(manifest.request.features.includes("fdy-orient-foundry"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
