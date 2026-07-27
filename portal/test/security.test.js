/**
 * Regression tests for the portal security hardening.
 *
 * Run with:  npm --prefix portal test
 * (uses Node's built-in --test runner; no new dependency).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { escapeHtml } from "../lib/branding.js";
import { assertDisplayName } from "../lib/approvals.js";

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
