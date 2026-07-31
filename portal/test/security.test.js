/**
 * Regression tests for the portal security hardening.
 *
 * Run with:  npm --prefix portal test
 * (uses Node's built-in --test runner; no new dependency).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import { escapeHtml } from "../lib/branding.js";
import { assertDisplayName, buildApprovalNotificationHtml } from "../lib/approvals.js";
import { exportLabs } from "../lib/exporter.js";
import { getLabContent, getLabPath, isValidLabId } from "../lib/labs.js";
import { validateLab } from "../lib/validator.js";

test("escapeHtml escapes every char used in the approval-callback response", () => {
  assert.equal(
    escapeHtml('<script>alert("x")</script>'),
    "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
  );
  assert.equal(escapeHtml("Tom & Jerry"), "Tom &amp; Jerry");
  assert.equal(escapeHtml("it's"), "it&#39;s");
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");
});

test("escapeHtml handles the & before other entities so it doesn't double-escape", () => {
  // Order matters: & must be escaped first, otherwise &lt; would become &amp;lt;.
  assert.equal(escapeHtml("<&>"), "&lt;&amp;&gt;");
});

test("assertDisplayName accepts a normal environment name", () => {
  assert.equal(assertDisplayName("Contoso Sales Sandbox"), "Contoso Sales Sandbox");
  assert.equal(assertDisplayName("  Trimmed Name  "), "Trimmed Name");
  assert.equal(assertDisplayName("O'Brien's Env-01 (dev)"), "O'Brien's Env-01 (dev)");
});

test("assertDisplayName rejects empty / whitespace-only input", () => {
  assert.throws(() => assertDisplayName(""), /required/);
  assert.throws(() => assertDisplayName("   "), /required/);
  assert.throws(() => assertDisplayName(null), /required/);
  assert.throws(() => assertDisplayName(undefined), /required/);
});

test("assertDisplayName rejects HTML / script payloads", () => {
  assert.throws(
    () => assertDisplayName('<script>alert("xss")</script>'),
    /unsupported characters/,
  );
  assert.throws(() => assertDisplayName("Env <img src=x onerror=1>"), /unsupported characters/);
  assert.throws(() => assertDisplayName("Env & Co"), /unsupported characters/);
  assert.throws(() => assertDisplayName('Env "quoted"'), /unsupported characters/);
});

test("assertDisplayName rejects control chars and newlines", () => {
  assert.throws(() => assertDisplayName("Env\u0000name"), /unsupported characters/);
  assert.throws(() => assertDisplayName("Env\nname"), /unsupported characters/);
  assert.throws(() => assertDisplayName("Env\tname"), /unsupported characters/);
});

test("assertDisplayName rejects overly long input", () => {
  const longName = "a".repeat(129);
  assert.throws(() => assertDisplayName(longName), /at most 128 characters/);
});

test("lab path helpers reject traversal and malformed ids", () => {
  for (const labId of ["../portal", "..\\portal", "01-lab/../../portal", "", "."]) {
    assert.equal(isValidLabId(labId), false);
    assert.equal(getLabPath(labId), null);
    assert.equal(getLabContent(labId), null);
  }
  assert.equal(isValidLabId("01-intro-workshop"), true);
  assert.match(getLabPath("01-intro-workshop"), /labs[\\/]01-intro-workshop$/);
});

test("lab validation resolves forward-slash Markdown image paths", () => {
  const result = validateLab("02-conversational-design-fundamentals");
  const imageCheck = result.tests.find((entry) => entry.name === "no-broken-image-refs");
  assert.equal(imageCheck?.status, "pass");
});

test("approval email HTML escapes stored request fields", () => {
  const html = buildApprovalNotificationHtml({
    request: {
      displayName: "Contoso Sandbox",
      environmentType: '<img src=x onerror="alert(1)">',
      location: "<b>test</b>",
      requestedBy: "requester@example.com",
      requestedAt: "2026-07-30T00:00:00.000Z",
      decidedBy: "<script>bad()</script>",
      reason: "A & B",
      environmentId: 'id-"quoted"',
    },
    title: "Approved",
    intro: "Review complete.",
    portalUrl: "https://portal.example.com",
  });

  assert.doesNotMatch(html, /<img|<script|<b>test<\/b>/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /&lt;b&gt;test&lt;\/b&gt;/);
  assert.match(html, /A &amp; B/);
  assert.match(html, /id-&quot;quoted&quot;/);
});

test("lab export rejects traversal before opening an archive", () => {
  assert.throws(
    () => exportLabs(["../portal"], {}, new PassThrough()),
    /Invalid or unknown lab id/,
  );
});

test("lab export creates a ZIP for a known lab", async () => {
  const output = new PassThrough();
  const chunks = [];
  output.on("data", (chunk) => chunks.push(chunk));

  const result = await exportLabs(["01-intro-workshop"], {}, output);
  const zip = Buffer.concat(chunks);

  assert.equal(result.labCount, 1);
  assert.ok(result.bytes > 0);
  assert.equal(zip.subarray(0, 2).toString("ascii"), "PK");
});
