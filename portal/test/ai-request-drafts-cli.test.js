/**
 * AI writing: the build request's `ai` object, the draft schema (version 4), saved labs and drafts from before AI, and the
 * command line. All offline; no model, no SDK, no account.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { normalizeAiChoice } from "../lib/ai/choice.js";
import { normalizeScope } from "../lib/ai/config.js";
import { planLab } from "../lib/lab-builder/planner.js";
import { DRAFT_SCHEMA_VERSION, migrateDraftRecord, normalizeDraftContent } from "../lib/lab-builder/drafts.js";
import { selectionsFromManifest } from "../lib/lab-builder/generated-labs.js";

const BASE = { products: ["copilot-studio"], features: ["create-agent"], harness: "standard", includeCore: false };
const REPO = resolve(fileURLToPath(new URL("../..", import.meta.url)));

test("the request's ai object is checked for shape: unknown models are refused with a plain message", () => {
  assert.equal(normalizeAiChoice(undefined), undefined);
  assert.equal(normalizeAiChoice(null), undefined);
  assert.equal(normalizeAiChoice({ enabled: false, model: "x" }), undefined);
  assert.deepEqual(normalizeAiChoice({ enabled: true, model: "gpt-5", scope: ["training", "lab"] }), { enabled: true, provider: "github-copilot", model: "gpt-5", scope: ["lab", "training"] });
  assert.deepEqual(normalizeAiChoice({ enabled: true, provider: "byok", model: "gpt-4o" }).scope, ["lab", "training", "labday"], "all three by default");
  assert.throws(() => normalizeAiChoice("yes"), /ai must be an object/);
  assert.throws(() => normalizeAiChoice({ enabled: "yes" }), /true or false/);
  assert.throws(() => normalizeAiChoice({ enabled: true }), /Pick a model from the list/);
  assert.throws(() => normalizeAiChoice({ enabled: true, model: "../../etc/passwd" }), /Pick a model from the list/);
  assert.throws(() => normalizeAiChoice({ enabled: true, model: "x".repeat(200) }), /Pick a model/);
  assert.throws(() => normalizeAiChoice({ enabled: true, model: "m", scope: ["everything"] }), /Unknown AI scope/);
  assert.throws(() => normalizeAiChoice({ enabled: true, model: "m", scope: [] }), /at least one part/);
  assert.throws(() => normalizeAiChoice({ enabled: true, model: "m", provider: "other" }), /ai.provider/);
  assert.deepEqual(normalizeScope(["labday", "lab", "nope"]), ["lab", "labday"]);
});

test("the planner carries the choice beside the plan, not inside the lab's own request", () => {
  const plain = planLab(BASE);
  assert.equal(plain.aiChoice, undefined, "an old request has no AI choice");
  const withAi = planLab({ ...BASE, ai: { enabled: true, model: "gpt-5", scope: ["lab"] } });
  assert.deepEqual(withAi.aiChoice, { enabled: true, provider: "github-copilot", model: "gpt-5", scope: ["lab"] });
  assert.equal(withAi.request.ai, undefined);
  assert.deepEqual(withAi.request, plain.request, "the plan's request, and so its identity, is unchanged");
  assert.equal(withAi.slug, plain.slug);
  assert.throws(() => planLab({ ...BASE, ai: { enabled: true, model: "nope nope" } }), /Pick a model/);
  assert.equal(planLab({ ...BASE, ai: { enabled: false } }).aiChoice, undefined);
});

test("drafts are schema version 4: an older draft opens with AI off and its other choices untouched", () => {
  assert.equal(DRAFT_SCHEMA_VERSION, 4);
  const v3 = { schemaVersion: 3, id: "draft-" + "a".repeat(24), name: "Old", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", content: { selections: { products: ["copilot-studio"], features: ["create-agent"], harnessMode: "single", harnesses: ["standard", "microsoft-copilot"], useLlm: true }, wizard: { step: 2 }, labels: {} } };
  const migrated = migrateDraftRecord(v3);
  assert.equal(migrated.schemaVersion, 4);
  assert.deepEqual(migrated.content.selections.ai, { enabled: false, model: null, scope: ["lab", "training", "labday"] });
  assert.deepEqual(migrated.content.selections.features, ["create-agent"]);
  assert.equal(migrateDraftRecord({ ...v3, schemaVersion: 1 }).schemaVersion, 4, "a version 1 draft climbs all the way");
  assert.throws(() => migrateDraftRecord({ ...v3, schemaVersion: 5 }), /newer version/);
});

test("a draft keeps the AI choice and refuses a malformed one, never saving anything but the choice", () => {
  const sel = { products: ["copilot-studio"], features: ["create-agent"], ai: { enabled: true, model: "gpt-5", scope: ["training", "lab"], token: "gho_nope", prompt: "secret" } };
  const clean = normalizeDraftContent({ selections: sel, wizard: { step: 4 } });
  assert.deepEqual(clean.selections.ai, { enabled: true, model: "gpt-5", scope: ["lab", "training"] });
  assert.equal(JSON.stringify(clean).includes("gho_nope"), false);
  assert.equal(JSON.stringify(clean).includes("secret"), false);
  assert.deepEqual(normalizeDraftContent({ selections: { products: ["copilot-studio"] } }).selections.ai, { enabled: false, model: null, scope: ["lab", "training", "labday"] });
  assert.throws(() => normalizeDraftContent({ selections: { ...sel, ai: { enabled: true, model: "bad model id" } } }), /AI model in this draft/);
  assert.throws(() => normalizeDraftContent({ selections: { ...sel, ai: { enabled: true, model: "m", scope: ["x"] } } }), /parts of the lab AI writes/);
  assert.throws(() => normalizeDraftContent({ selections: { ...sel, ai: "on" } }), /AI writing choice/);
});

test("a saved lab built before AI re-opens exactly as before; one built with AI re-opens with its choice", () => {
  const old = { request: { features: ["create-agent"], level: 100, products: ["copilot-studio"] }, options: { customTitle: null, agentName: null, useLearnMcp: true, useLlm: true } };
  assert.equal("ai" in selectionsFromManifest(old), false);
  const withAi = { ...old, options: { ...old.options, ai: { enabled: true, provider: "github-copilot", model: "gpt-5", scope: ["lab"], extra: "dropped" } } };
  assert.deepEqual(selectionsFromManifest(withAi).ai, { enabled: true, model: "gpt-5", scope: ["lab"] });
  assert.equal("ai" in selectionsFromManifest({ ...old, options: { ...old.options, ai: { enabled: false, model: "gpt-5" } } }), false);
});

test("the build CLI documents the AI flags, refuses a conflicting mode, and never starts the SDK for --help", () => {
  const help = spawnSync(process.execPath, ["tools/lab-builder/build.mjs", "--help"], { cwd: REPO, encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--ai-model <id>/);
  assert.match(help.stdout, /--ai-scope <a,b>/);
  assert.match(help.stdout, /--ai-list-models/);
  assert.match(help.stdout, /Nothing is sent without this flag/);
  const conflict = spawnSync(process.execPath, ["tools/lab-builder/build.mjs", "--features", "create-agent", "--ai-model", "gpt-5", "--dry-run", "--no-learn"], { cwd: REPO, encoding: "utf8", env: { ...process.env, AI_GENERATION: "per-user" } });
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /the command line uses local mode, but AI_GENERATION is "per-user"/);
  const decks = spawnSync(process.execPath, ["tools/lab-builder/export-training-decks.mjs", "--help"], { cwd: REPO, encoding: "utf8" });
  assert.match(decks.stdout, /--ai-model <id>/);
  assert.match(decks.stdout, /AI-NOTE\.txt/);
});
