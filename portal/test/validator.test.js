import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RULE_IDS, validateAllLabs, validateLabDir } from "../lib/validator.js";

const MANIFEST = JSON.parse(
  readFileSync(new URL("../../scripts/lab-validation-rules.json", import.meta.url), "utf8"),
);

function fixtureDir(t, markdown) {
  const dir = mkdtempSync(join(tmpdir(), "validator-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (markdown !== undefined) writeFileSync(join(dir, "index.md"), markdown, "utf8");
  return dir;
}

function lab(body, { title = "# Fixture Lab", overview = "## Overview" } = {}) {
  return [
    title,
    "",
    "| Field | Details |",
    "|---|---|",
    "| ⭐ **DIFFICULTY** | Intermediate |",
    "| ⏱️ **TIME** | 45 minutes |",
    "| 🧩 **PRODUCTS** | Microsoft Copilot Studio |",
    "| 🏷️ **TAGS** | topics |",
    "| 🏭 **INDUSTRIES** | Retail |",
    "",
    overview,
    "",
    "This fixture exercises heading detection in the validator. It is padded so that it clears the minimum content length every lab in this repository must meet, which keeps unrelated rules out of the way of the one under test.",
    "",
    "## Objectives",
    "",
    "- Prove that a code sample is never mistaken for a heading.",
    "",
    "## Step 1: Configure",
    "",
    body,
    "",
  ].join("\n");
}

function check(t, markdown, name) {
  const result = validateLabDir(fixtureDir(t, markdown), { labId: "fixture", title: "fixture" });
  return result.tests.find((x) => x.name === name);
}

// ── Fenced code is not headings ─────────────────────────────────────────────

test("a # comment inside a fenced code block is not a second title", (t) => {
  // Lab 33's shape: PowerShell comments inside a ```powershell sample.
  const markdown = lab(["```powershell", "# No admin required (current user only):", "npm install", "```"].join("\n"));
  assert.equal(check(t, markdown, "single-title").status, "pass");
  assert.equal(check(t, markdown.replace(/\n/g, "\r\n"), "single-title").status, "pass", "CRLF checkouts too");
});

test("tilde fences and longer fences are both respected", (t) => {
  const body = [
    "~~~bash",
    "# a shell comment",
    "~~~",
    "",
    "````markdown",
    "```",
    "# still inside the four-backtick fence",
    "```",
    "````",
  ].join("\n");
  assert.equal(check(t, lab(body), "single-title").status, "pass");
});

test("a fence only closes on the character that opened it", (t) => {
  const body = ["```text", "~~~", "# inside, because ~~~ cannot close a backtick fence", "```"].join("\n");
  assert.equal(check(t, lab(body), "single-title").status, "pass");
});

test("an unclosed fence runs to the end of the file", (t) => {
  // CommonMark renders everything after an unclosed fence as code.
  const body = ["```text", "# rendered as code"].join("\n");
  assert.equal(check(t, lab(body), "single-title").status, "pass");
});

test("a line of inline triple backticks is prose, not a fence", (t) => {
  const body = ["Write ```js``` to open a JavaScript block.", "", "# A real second title"].join("\n");
  const result = check(t, lab(body), "single-title");
  assert.equal(result.status, "fail");
  assert.match(result.message, /found 2/);
});

test("a genuine second H1 still fails single-title", (t) => {
  const result = check(t, lab("Some text.\n\n# 🧪 Use Case #2\n\nMore text."), "single-title");
  assert.equal(result.status, "fail");
  assert.match(result.message, /found 2/);
});

test("heading rules do not accept a heading that only appears inside a code sample", (t) => {
  const fencedTitle = lab("Body.", { title: "```md\n# Fixture Lab\n```" });
  assert.equal(check(t, fencedTitle, "has-title").status, "fail");
  assert.equal(check(t, fencedTitle, "single-title").status, "fail");

  const fencedOverview = lab("Body.", { overview: "```md\n## Overview\n```" });
  assert.equal(check(t, fencedOverview, "has-overview").status, "fail");
});

test("heading-shaped lines in a code sample are not treated as empty sections", (t) => {
  // Read as headings, `## First` would be a section with no body.
  const body = ["Body.", "", "### Step 2: Show the outline", "", "```md", "## First", "## Second", "```"].join("\n");
  assert.equal(check(t, lab(body), "no-empty-sections").status, "pass");
});

// ── Parity with validate_labs.py ────────────────────────────────────────────

test("RULE_IDS is exactly the set of rules validateLabDir reports", (t) => {
  const names = (result) => result.tests.map((x) => x.name);
  const present = validateLabDir(fixtureDir(t, lab("Body.")), { labId: "fixture" });
  const missing = validateLabDir(fixtureDir(t), { labId: "fixture" });
  assert.deepEqual(names(present), [...RULE_IDS]);
  assert.deepEqual(names(missing), [...RULE_IDS], "the missing-index report must cover every rule too");
});

test("the validation-rules manifest is well formed", () => {
  const ids = MANIFEST.rules.map((rule) => rule.id);
  assert.equal(new Set(ids).size, ids.length, "rule ids are unique");
  for (const rule of MANIFEST.rules) {
    assert.ok(rule.validators.length, `${rule.id} names at least one validator`);
    assert.ok(rule.validators.every((v) => v === "js" || v === "python"), `${rule.id} names only js/python`);
    assert.ok(["lab", "repository"].includes(rule.scope), `${rule.id} has a lab or repository scope`);
    assert.ok(rule.checks, `${rule.id} says what it checks`);
    if (rule.validators.length === 1) {
      assert.ok(rule.asymmetry, `${rule.id} lives in one validator, so the manifest must say why`);
    }
  }
});

test("the JS validator implements exactly the manifest's js rules", () => {
  const manifestIds = MANIFEST.rules.filter((rule) => rule.validators.includes("js")).map((rule) => rule.id);
  assert.deepEqual(
    [...manifestIds].sort(),
    [...RULE_IDS].sort(),
    "a rule was added to or removed from portal/lib/validator.js without updating scripts/lab-validation-rules.json",
  );
});

// ── labs/ is held to the same bar as a generated lab ────────────────────────

test("every hand-written lab passes every JS rule", () => {
  // generateLab() throws away any lab that fails one of these, so the labs it is
  // modelled on have to pass them too.
  const failures = validateAllLabs().labs.flatMap((result) =>
    result.tests
      .filter((x) => x.status === "fail")
      .map((x) => `${result.labId}: ${x.name} — ${x.message}`),
  );
  assert.deepEqual(failures, []);
});
