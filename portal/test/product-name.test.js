/**
 * The product is named "Agentic Microsoft Training and Lab Generator". These tests keep the earlier name from
 * creeping back into the code, the docs, or anything a person sees, and check that lab data saved under the
 * earlier name is shown under the current one without rewriting any file.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { PRODUCT_NAME, currentProductName, isDefaultCompanyName } from "../lib/product-name.js";
import { DEFAULT_BRANDING, renderLabEmail } from "../lib/branding.js";
import { DEFAULT_BRAND, hasBrandCustomization, normalizeBrand } from "../lib/lab-builder/brand-theme.js";
import { learnerSafeManifest } from "../lib/lab-builder/learner-guide.js";
import { GENERATOR_NAME } from "../lib/lab-builder/products.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const EARLIER_NAME = ["Microsoft", "AI", "Training", "Generator"].join(" ");

// "AI Training Generator" spelled with spaces, hyphens, underscores, non-breaking spaces, markup, or a line break between the words.
const SEPARATOR = String.raw`(?:[\s_-]|&nbsp;|&#160;|\\u00a0|\\n|<[^>]*>)+`;
const EARLIER_NAME_RE = new RegExp(`AI${SEPARATOR}Training${SEPARATOR}Generator`, "i");

// The only places allowed to name the earlier product: each needs a reason.
const ALLOWED = [
  { file: "portal/test/product-name.test.js", reason: "this guard test names the earlier name to check for it and to test the repair on read" },
  { file: "portal/lib/product-name.js", reason: "maps the earlier name to the current one when older saved labs and brand profiles are read" },
  { file: "README.md", line: /^\*Formerly the Microsoft AI Training Generator\.\*$/, reason: "the one line that tells people who know the earlier name where to find the product" },
];

const TEXT_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".json", ".md", ".html", ".css", ".yml", ".yaml", ".bicep", ".ps1", ".py", ".txt", ".svg", ".bat", ".cmd", ".sh", ".csv", ".cs", ".csproj", ".template", ".example"]);
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", ".azure", "generated-labs", "vendor"]);
const SKIPPED_FILES = new Set(["package-lock.json"]);

function extensionOf(file) {
  const dot = file.lastIndexOf(".");
  return dot > file.lastIndexOf("/") ? file.slice(dot).toLowerCase() : "";
}

function walk(directory, found = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(join(directory, entry.name), found);
    } else if (entry.isFile()) {
      found.push(relative(REPO_ROOT, join(directory, entry.name)).split(sep).join("/"));
    }
  }
  return found;
}

/** The repository's tracked files; a plain directory walk when git is not available. */
function repositoryFiles() {
  let files;
  try {
    files = execFileSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] })
      .split("\0")
      .filter(Boolean);
  } catch {
    files = walk(REPO_ROOT);
  }
  return files.filter((file) => {
    if (SKIPPED_FILES.has(file.split("/").pop())) return false;
    if (file.split("/").some((part) => SKIPPED_DIRECTORIES.has(part))) return false;
    return TEXT_EXTENSIONS.has(extensionOf(file));
  });
}

function read(file) {
  return readFileSync(join(REPO_ROOT, file), "utf8");
}

test("the product name is exactly Agentic Microsoft Training and Lab Generator everywhere it is defined", () => {
  assert.equal(PRODUCT_NAME, "Agentic Microsoft Training and Lab Generator");
  assert.equal(DEFAULT_BRANDING.companyName, PRODUCT_NAME);
  assert.equal(DEFAULT_BRAND.companyName, PRODUCT_NAME);
  assert.equal(GENERATOR_NAME, PRODUCT_NAME);
});

test("the earlier product name appears in no tracked source or document outside the short allowlist", () => {
  const offenders = [];
  for (const file of repositoryFiles()) {
    const text = read(file);
    if (!EARLIER_NAME_RE.test(text)) continue;
    const allowed = ALLOWED.find((entry) => entry.file === file);
    if (allowed && !allowed.line) continue;
    const lines = text.split(/\r?\n/);
    // A name split across lines or markup is checked on the whole file; a single-line allowance covers only its own line.
    const stray = allowed
      ? lines.filter((line) => EARLIER_NAME_RE.test(line) && !allowed.line.test(line))
      : lines.filter((line) => EARLIER_NAME_RE.test(line));
    if (stray.length || !lines.some((line) => EARLIER_NAME_RE.test(line))) {
      offenders.push(`${file}: ${(stray[0] || "name split across lines or markup").trim().slice(0, 120)}`);
    }
  }
  assert.deepEqual(offenders, [], `The earlier product name is back. Use "${PRODUCT_NAME}":\n${offenders.join("\n")}`);
});

test("the new name is not doubled, mis-articled, or shortened", () => {
  const problems = [];
  for (const file of repositoryFiles()) {
    if (file === "portal/test/product-name.test.js") continue;
    const text = read(file);
    if (!text.includes("Lab Generator")) continue;
    if (/Lab Generator Generator/.test(text)) problems.push(`${file}: "Generator Generator"`);
    if (/\b[Aa] Agentic Microsoft Training/.test(text)) problems.push(`${file}: "a Agentic" (use "an")`);
    if (/Agentic Training and Lab Generator/.test(text)) problems.push(`${file}: shortened label`);
  }
  assert.deepEqual(problems, []);
});

test("a person sees the new name in the page title, the header, the README title, and the banners", () => {
  const html = read("portal/public/index.html");
  assert.match(html, /<title>[^<]*Agentic Microsoft Training and Lab Generator[^<]*<\/title>/);
  assert.match(html, /id="portal-title"[^>]*>Agentic Microsoft Training and Lab Generator</);
  assert.match(read("README.md"), /^# ⚡ Agentic Microsoft Training and Lab Generator$/m);
  assert.match(read("portal/README.md"), /^# ⚡ Agentic Microsoft Training and Lab Generator — Provisioning Portal$/m);
  assert.match(read("tools/screenshot-capture/companion.mjs"), /^\/\/ Local Capture Companion for the Agentic Microsoft Training and Lab Generator portal\.$/m);
  assert.match(read("tools/screenshot-capture/capture.js"), /Agentic Microsoft Training and Lab Generator screenshot capture/);
  assert.match(read("tools/lab-builder/build.mjs"), /Agentic Microsoft Training and Lab Generator — Custom Lab Builder CLI/);
  assert.match(read("setup.js"), /Agentic Microsoft Training and Lab Generator — Template Setup/);
  assert.match(read("tools/feature-tour/lib/render.mjs"), /Agentic Microsoft Training and Lab Generator feature tour/);
});

test("the portal email and the exported bundle name the product by its current name", () => {
  const email = renderLabEmail({ labCount: 1, labListHtml: "<li>Lab</li>" });
  assert.equal(email.subject, `Your ${PRODUCT_NAME} Package`);
  assert.match(email.html, new RegExp(`Sent from the ${PRODUCT_NAME} Provisioning Portal`));
  assert.ok(!EARLIER_NAME_RE.test(email.html));
});

test("brand data saved under the earlier name reads as the current name and stays an unbranded default", () => {
  assert.equal(currentProductName(EARLIER_NAME), PRODUCT_NAME);
  assert.equal(currentProductName(`  ${EARLIER_NAME} `), PRODUCT_NAME, "a saved value with stray spaces is still the earlier default");
  assert.equal(currentProductName("Contoso Training"), "Contoso Training", "a customer's own name is never touched");
  assert.equal(currentProductName(`${EARLIER_NAME} for Contoso`), `${EARLIER_NAME} for Contoso`, "only the exact earlier name is replaced");
  assert.equal(currentProductName(undefined), undefined);

  assert.ok(isDefaultCompanyName(EARLIER_NAME));
  assert.ok(isDefaultCompanyName(PRODUCT_NAME));
  assert.ok(!isDefaultCompanyName("Contoso Training"));

  const saved = normalizeBrand({ companyName: EARLIER_NAME, tagline: "Provisioning Portal", primaryColor: "#4f8ff7" });
  assert.equal(saved.companyName, PRODUCT_NAME);
  assert.equal(hasBrandCustomization({ companyName: EARLIER_NAME }), false, "an earlier default profile is not a customized brand");
  assert.equal(normalizeBrand({ companyName: "Contoso Training" }).companyName, "Contoso Training");
});

test("a lab saved under the earlier name is handed to a learner under the current name, and the saved manifest is not rewritten", () => {
  const manifest = Object.freeze({
    slug: "contoso-lab",
    generator: EARLIER_NAME,
    customization: Object.freeze({ profileSnapshot: Object.freeze({ id: "default", name: "Default", companyName: EARLIER_NAME }) }),
  });
  const safe = learnerSafeManifest(manifest);
  assert.equal(safe.generator, PRODUCT_NAME);
  assert.equal(safe.customization.profileSnapshot.companyName, PRODUCT_NAME);
  assert.equal(manifest.generator, EARLIER_NAME, "the input is left as it was");
  assert.equal(manifest.customization.profileSnapshot.companyName, EARLIER_NAME);

  const custom = learnerSafeManifest({ generator: "Contoso Lab Factory", customization: { profileSnapshot: { companyName: "Fabrikam Training" } } });
  assert.equal(custom.generator, "Contoso Lab Factory");
  assert.equal(custom.customization.profileSnapshot.companyName, "Fabrikam Training");
  assert.deepEqual(learnerSafeManifest({ slug: "plain" }), { slug: "plain" });
  assert.equal(learnerSafeManifest(null), null);
});
