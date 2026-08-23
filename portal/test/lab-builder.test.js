import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getCategories,
  getFeatures,
  getFeature,
  getFeaturesByCategory,
  expandPrereqs,
  orderFeatures,
  validateCatalog,
} from "../lib/lab-builder/catalog.js";
import { planLab, slugify, dropModules } from "../lib/lab-builder/planner.js";
import { generateLab } from "../lib/lab-builder/generator.js";
import { connect, searchDocs } from "../lib/lab-builder/learn-mcp.js";
import { detectProvider } from "../lib/lab-builder/llm.js";
import { curatedDocsAge, normalizeDecisions } from "../lib/lab-builder/blockers.js";
import { scrubForbidden } from "../lib/lab-builder/composer.js";

// ── Catalog ─────────────────────────────────────────────────────────────────

test("catalog has no integrity problems", () => {
  assert.deepEqual(validateCatalog(), []);
});

test("catalog exposes categories and features", () => {
  assert.ok(getCategories().length >= 5);
  assert.ok(getFeatures().length >= 20);
  assert.equal(getFeature("create-agent").id, "create-agent");
  assert.equal(getFeature("does-not-exist"), null);
});

test("every feature belongs to a rendered category group", () => {
  const grouped = getFeaturesByCategory().flatMap((c) => c.features.map((f) => f.id));
  for (const feature of getFeatures()) {
    assert.ok(grouped.includes(feature.id), `${feature.id} is not in any category group`);
  }
});

test("expandPrereqs pulls in transitive prerequisites", () => {
  const ids = expandPrereqs(["agent-to-agent"]);
  assert.ok(ids.includes("connected-agents"));
  assert.ok(ids.includes("generative-orchestration"));
  assert.ok(ids.includes("create-agent"));
});

test("expandPrereqs drops unknown ids", () => {
  assert.deepEqual(expandPrereqs(["not-a-feature"]), []);
});

test("orderFeatures places every prerequisite before its dependent", () => {
  const ids = orderFeatures(expandPrereqs(["agent-to-agent", "analytics", "channel-teams"]));
  for (const [index, id] of ids.entries()) {
    for (const prereq of getFeature(id).prereqs || []) {
      if (!ids.includes(prereq)) continue;
      assert.ok(ids.indexOf(prereq) < index, `${prereq} must come before ${id}`);
    }
  }
});

// ── Planner ─────────────────────────────────────────────────────────────────

test("planLab rejects an empty feature selection", () => {
  assert.throws(() => planLab({ features: [] }), /at least one/i);
});

test("planLab produces an ordered, numbered module list", () => {
  const plan = planLab({ industry: "retail", roles: ["customer-service"], features: ["connector-tools"] });
  assert.ok(plan.features.length >= 2);
  assert.deepEqual(
    plan.features.map((f) => f.order),
    plan.features.map((_, i) => i + 1),
  );
  assert.equal(plan.industry.id, "retail");
  assert.equal(plan.roles[0].id, "customer-service");
  assert.match(plan.title, /Retail/);
});

test("planLab respects a time budget and reports deferred modules", () => {
  const plan = planLab({ industry: "retail", features: ["agent-to-agent", "voice-agents"], timeBudget: 60 });
  assert.ok(plan.totalMinutes <= 60, `expected <= 60 minutes, got ${plan.totalMinutes}`);
  assert.ok(plan.deferred.length > 0);
});

test("planLab warns about unknown industries and roles", () => {
  const plan = planLab({ industry: "nope", roles: ["nope"], features: ["topics"] });
  assert.ok(plan.warnings.some((w) => /Unknown industry/i.test(w)));
  assert.ok(plan.warnings.some((w) => /Unknown role/i.test(w)));
});

test("planLab rejects malformed and unknown selections", () => {
  assert.throws(() => planLab({ features: "topics" }), /features must be an array/i);
  assert.throws(() => planLab({ features: ["topics"], roles: "operations" }), /roles must be an array/i);
  assert.throws(() => planLab({ features: ["not-a-feature"] }), /unknown feature/i);
  assert.throws(() => planLab({ features: ["topics"], timeBudget: "NaN" }), /timeBudget/i);
  assert.throws(() => planLab({ features: ["topics"], timeBudget: 29 }), /30 to 1440/i);
  assert.throws(() => planLab({ features: ["topics"], title: "Bad\n# title" }), /control characters/i);
});

test("slugify produces filesystem-safe names", () => {
  assert.equal(slugify("Retail: Store & Support!"), "retail-store-support");
});

// ── LLM detection ───────────────────────────────────────────────────────────

test("detectProvider prefers Azure OpenAI, then GitHub Models, then none", () => {
  assert.equal(
    detectProvider({
      AZURE_OPENAI_ENDPOINT: "https://x.openai.azure.com",
      AZURE_OPENAI_API_KEY: "k",
      AZURE_OPENAI_DEPLOYMENT: "gpt-4o",
      GITHUB_TOKEN: "t",
    }).kind,
    "azure-openai",
  );
  assert.equal(detectProvider({ GITHUB_TOKEN: "t" }).kind, "github-models");
  assert.equal(detectProvider({}).kind, "none");
  assert.equal(detectProvider({ GITHUB_TOKEN: "t", LAB_BUILDER_LLM: "off" }).kind, "none");
});

// ── Composer ────────────────────────────────────────────────────────────────

test("scrubForbidden removes markers the lab validator rejects", () => {
  const cleaned = scrubForbidden("TODO check this, FIXME later, TBD, XXX");
  assert.doesNotMatch(cleaned, /\b(?:TODO|FIXME|TBD|XXX)\b/i);
});

// ── Generator (offline: no network, no LLM) ─────────────────────────────────

test("generateLab writes a lab that passes every validator rule", async (t) => {
  const outputRoot = mkdtempSync(join(tmpdir(), "lab-builder-test-"));
  t.after(() => rmSync(outputRoot, { recursive: true, force: true }));

  const result = await generateLab(
    {
      industry: "energy-resources",
      roles: ["operations"],
      features: ["knowledge-sharepoint", "connector-tools", "analytics"],
      timeBudget: 300,
    },
    { outputRoot, useLearnMcp: false, useLlm: false },
  );

  assert.ok(existsSync(join(result.outputDir, "index.md")));
  assert.ok(existsSync(join(result.outputDir, "manifest.json")));
  assert.equal(result.validation.failed, 0, JSON.stringify(result.validation.tests.filter((x) => x.status === "fail")));
  assert.ok(result.validation.passed >= 15);

  const markdown = readFileSync(join(result.outputDir, "index.md"), "utf8");
  assert.match(markdown, /^# /m);
  assert.match(markdown, /\*\*DIFFICULTY\*\*/);
  assert.match(markdown, /\*\*INDUSTRIES\*\*/);
  assert.match(markdown, /^## Overview$/m);
  assert.match(markdown, /^## Learning Objectives$/m);
  assert.match(markdown, /^### Step 1 - /m);
  assert.doesNotMatch(markdown, /\b(?:TODO|FIXME|TBD|XXX)\b/i);
});

test("generateLab dry run writes nothing", async () => {
  const result = await generateLab(
    { industry: "education", features: ["topics"] },
    { write: false, useLearnMcp: false, useLlm: false },
  );
  assert.equal(result.outputDir, null);
  assert.ok(result.markdown.length > 500);
});

test("generateLab records offline grounding as a warning, not a failure", async () => {
  const result = await generateLab(
    { industry: "nonprofit", features: ["topics"] },
    { write: false, useLearnMcp: false, useLlm: false },
  );
  assert.equal(result.manifest.grounding.groundedModules, 0);
  assert.ok(result.plan.warnings.some((w) => /Learn/i.test(w)));
  assert.equal(Number.isNaN(Date.parse(result.manifest.generatedAt)), false);
});

test("generateLab reserves unique output directories for concurrent builds", async (t) => {
  const outputRoot = mkdtempSync(join(tmpdir(), "lab-builder-concurrent-"));
  t.after(() => rmSync(outputRoot, { recursive: true, force: true }));

  const options = { outputRoot, useLearnMcp: false, useLlm: false };
  const [first, second] = await Promise.all([
    generateLab({ features: ["topics"] }, options),
    generateLab({ features: ["topics"] }, options),
  ]);

  assert.notEqual(first.outputDir, second.outputDir);
  assert.ok(existsSync(join(first.outputDir, "index.md")));
  assert.ok(existsSync(join(second.outputDir, "index.md")));
});

test("generateLab removes invalid partial output", async (t) => {
  const outputRoot = mkdtempSync(join(tmpdir(), "lab-builder-invalid-"));
  t.after(() => rmSync(outputRoot, { recursive: true, force: true }));
  const llm = {
    available: true,
    failures: [],
    provider: { kind: "test", label: "Test provider" },
    async complete() {
      return "# injected second title";
    },
  };

  await assert.rejects(
    generateLab(
      { features: ["topics"] },
      { outputRoot, useLearnMcp: false, useLlm: true, llm },
    ),
    /failed \d+ validation check/i,
  );
  assert.deepEqual(readdirSync(outputRoot), []);
});

test("generateLab bounds concurrent Microsoft Learn work", async () => {
  let active = 0;
  let peak = 0;
  const session = {
    ok: true,
    endpoint: "https://learn.example.test",
    async call() {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      return { content: [{ type: "text", text: "Malformed but harmless upstream content" }] };
    },
  };

  const result = await generateLab(
    { features: ["topics", "analytics", "adaptive-cards", "authentication"] },
    {
      write: false,
      useLearnMcp: true,
      useLlm: false,
      maxConcurrency: 3,
      connect: async () => session,
    },
  );
  assert.equal(peak, 3);
  // The malformed upstream content grounds nothing, so this now stops for a
  // decision rather than quietly composing an unverified lab.
  assert.equal(result.status, "blocked");
  assert.equal(result.blockers[0].code, "modules-ungrounded");
});

test("generateLab honors cancellation before upstream work completes", async () => {
  const controller = new AbortController();
  const generation = generateLab(
    { features: ["topics"] },
    {
      write: false,
      useLearnMcp: true,
      useLlm: false,
      signal: controller.signal,
      connect: ({ signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("cancelled", "AbortError")),
          { once: true },
        );
      }),
    },
  );
  controller.abort();
  await assert.rejects(generation, { name: "AbortError" });
});

test("Learn MCP retries a transient failure and tolerates malformed tool data", async (t) => {
  let requests = 0;
  const server = createServer(async (req, res) => {
    requests += 1;
    const body = JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString("utf8"));
    if (requests === 1) {
      res.writeHead(503).end("try again");
      return;
    }
    res.setHeader("content-type", "application/json");
    if (body.method === "initialize") {
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18" } }));
      return;
    }
    res.end("not-json");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());

  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const session = await connect({ endpoint, timeoutMs: 2000 });
  assert.equal(session.ok, true);
  assert.equal(requests, 2);
  assert.deepEqual(await searchDocs(session, "malformed response test"), []);
});

test("Learn MCP rejects a malformed initialize response", async (t) => {
  const server = createServer((_req, res) => res.end("not-json"));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());

  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const session = await connect({ endpoint, timeoutMs: 2000 });
  assert.equal(session.ok, false);
  assert.match(session.error, /malformed initialize/i);
});

test("Learn MCP query timeout degrades to an empty result", async (t) => {
  const server = createServer(async (req, res) => {
    const body = JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString("utf8"));
    if (body.method === "initialize") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18" } }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });

  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const session = await connect({ endpoint, timeoutMs: 40 });
  assert.equal(session.ok, true);
  assert.deepEqual(await searchDocs(session, "timeout fallback test"), []);
});

// ── Blockers: stop and ask instead of degrading silently ────────────────────

let sessionCounter = 0;

/** A session whose searches always return usable documentation. */
function groundedSession() {
  sessionCounter += 1;
  return {
    ok: true,
    endpoint: `https://learn.grounded-${sessionCounter}.test`,
    async call() {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify([
              {
                title: "Configure the feature",
                url: "https://learn.microsoft.com/microsoft-copilot-studio/example",
                content: "A sufficiently long documentation excerpt to survive the minimum-length filter applied by searchDocs.",
              },
            ]),
          },
        ],
      };
    },
  };
}

/** A session that connects but never finds anything. */
function emptySession() {
  sessionCounter += 1;
  return {
    ok: true,
    endpoint: `https://learn.empty-${sessionCounter}.test`,
    async call() {
      return { content: [{ type: "text", text: "[]" }] };
    },
  };
}

const failedConnect = async () => ({
  ok: false,
  error: "connection refused",
  endpoint: "https://learn.unreachable.test",
  call: async () => null,
});

test("an unreachable Learn MCP blocks the build instead of quietly using curated links", async (t) => {
  const outputRoot = mkdtempSync(join(tmpdir(), "lab-builder-blocked-"));
  t.after(() => rmSync(outputRoot, { recursive: true, force: true }));

  const result = await generateLab(
    { features: ["topics"] },
    { outputRoot, useLearnMcp: true, useLlm: false, connect: failedConnect },
  );

  assert.equal(result.status, "blocked");
  assert.equal(result.blockers.length, 1);
  assert.equal(result.blockers[0].code, "learn-mcp-unavailable");
  assert.match(result.blockers[0].consequence, /connection refused/);
  assert.equal(result.outputDir, null);
  // A blocker halts before anything reaches disk.
  assert.deepEqual(readdirSync(outputRoot), []);
});

test("every blocker offers ranked options with exactly one recommendation", async () => {
  const result = await generateLab(
    { features: ["topics"] },
    { write: false, useLearnMcp: true, useLlm: false, connect: failedConnect },
  );

  for (const blocker of result.blockers) {
    assert.ok(blocker.code && blocker.title && blocker.consequence);
    assert.ok(blocker.options.length >= 2 && blocker.options.length <= 4);
    assert.equal(blocker.options.filter((option) => option.recommended).length, 1);
    for (const option of blocker.options) {
      assert.ok(option.tradeoff, `${blocker.code}/${option.id} must state its tradeoff`);
      assert.equal(option.cliFlag, `--decide ${blocker.code}=${option.id}`);
    }
  }
});

test("a decision resolves the blocker and is recorded in the manifest", async () => {
  const result = await generateLab(
    { features: ["topics"] },
    {
      write: false,
      useLearnMcp: true,
      useLlm: false,
      connect: failedConnect,
      decisions: { "learn-mcp-unavailable": "proceed-curated" },
      decisionSource: "portal",
    },
  );

  assert.equal(result.status, "complete");
  assert.equal(result.manifest.decisions.length, 1);
  const [decision] = result.manifest.decisions;
  assert.equal(decision.code, "learn-mcp-unavailable");
  assert.equal(decision.chosen.id, "proceed-curated");
  assert.equal(decision.decidedVia, "portal");
  assert.equal(Number.isNaN(Date.parse(decision.decidedAt)), false);
});

test("the manifest records no user identity", async () => {
  const result = await generateLab(
    { features: ["topics"] },
    {
      write: false,
      useLearnMcp: true,
      useLlm: false,
      connect: failedConnect,
      decisions: { "learn-mcp-unavailable": "proceed-curated" },
      decisionSource: "portal",
    },
  );

  // The manifest ships with the lab and can be exported and emailed, so it must
  // never carry a UPN or any other caller identity.
  const serialized = JSON.stringify(result.manifest);
  assert.doesNotMatch(serialized, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  assert.doesNotMatch(serialized, /decidedBy/);
});

test("choosing cancel writes nothing", async (t) => {
  const outputRoot = mkdtempSync(join(tmpdir(), "lab-builder-cancelled-"));
  t.after(() => rmSync(outputRoot, { recursive: true, force: true }));

  const result = await generateLab(
    { features: ["topics"] },
    {
      outputRoot,
      useLearnMcp: true,
      useLlm: false,
      connect: failedConnect,
      decisions: { "learn-mcp-unavailable": "cancel" },
    },
  );

  assert.equal(result.status, "cancelled");
  assert.equal(result.outputDir, null);
  assert.deepEqual(readdirSync(outputRoot), []);
});

test("retry is not a resolution — the gate is evaluated again", async () => {
  const result = await generateLab(
    { features: ["topics"] },
    {
      write: false,
      useLearnMcp: true,
      useLlm: false,
      connect: failedConnect,
      decisions: { "learn-mcp-unavailable": "retry" },
    },
  );

  assert.equal(result.status, "blocked");
  assert.equal(result.blockers[0].code, "learn-mcp-unavailable");
});

test("a connected server that finds nothing blocks on the ungrounded modules", async () => {
  const session = emptySession();
  const result = await generateLab(
    { features: ["topics"] },
    { write: false, useLearnMcp: true, useLlm: false, connect: async () => session },
  );

  assert.equal(result.status, "blocked");
  assert.equal(result.blockers[0].code, "modules-ungrounded");
  assert.ok(result.blockers[0].detail.modules.length > 0);
});

test("ungrounded modules do not prompt twice when the handshake already failed", async () => {
  const result = await generateLab(
    { features: ["topics"] },
    { write: false, useLearnMcp: true, useLlm: false, connect: failedConnect },
  );

  // Both conditions are true, but they share one root cause.
  assert.equal(result.blockers.length, 1);
  assert.equal(result.blockers[0].code, "learn-mcp-unavailable");
});

test("dropping ungrounded modules shortens the lab and keeps it valid", async () => {
  const ungroundedId = "analytics";
  const bad = new Set(getFeature(ungroundedId).learnQueries || []);
  sessionCounter += 1;
  const session = {
    ok: true,
    endpoint: `https://learn.partial-${sessionCounter}.test`,
    async call(_name, args) {
      if (bad.has(args.query)) return { content: [{ type: "text", text: "[]" }] };
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify([
              {
                title: "Configure the feature",
                url: "https://learn.microsoft.com/microsoft-copilot-studio/example",
                content: "A sufficiently long documentation excerpt to survive the minimum-length filter applied by searchDocs.",
              },
            ]),
          },
        ],
      };
    },
  };

  const kept = await generateLab(
    { features: ["analytics"] },
    {
      write: false,
      useLearnMcp: true,
      useLlm: false,
      connect: async () => session,
      decisions: { "modules-ungrounded": "proceed-curated" },
    },
  );
  const dropped = await generateLab(
    { features: ["analytics"] },
    {
      write: false,
      useLearnMcp: true,
      useLlm: false,
      connect: async () => session,
      decisions: { "modules-ungrounded": "drop-modules" },
    },
  );

  assert.equal(kept.status, "complete");
  assert.equal(dropped.status, "complete");
  assert.ok(kept.plan.features.some((f) => f.id === ungroundedId));
  assert.ok(!dropped.plan.features.some((f) => f.id === ungroundedId));
  assert.ok(dropped.plan.features.length < kept.plan.features.length);
  assert.deepEqual(
    dropped.plan.features.map((f) => f.order),
    dropped.plan.features.map((_, i) => i + 1),
  );
});

test("dropModules removes dependents, renumbers, and recomputes the plan", () => {
  const plan = planLab({ features: ["agent-to-agent"] });
  const originalCount = plan.features.length;
  assert.ok(plan.features.some((f) => f.id === "connected-agents"));

  dropModules(plan, ["generative-orchestration"], "ungrounded");

  for (const id of ["generative-orchestration", "connected-agents", "agent-to-agent"]) {
    assert.ok(!plan.features.some((f) => f.id === id), `${id} should have been dropped`);
    assert.ok(plan.deferred.some((d) => d.id === id), `${id} should be listed as deferred`);
  }

  assert.ok(plan.features.length < originalCount);
  assert.deepEqual(plan.features.map((f) => f.order), plan.features.map((_, i) => i + 1));
  assert.equal(plan.totalMinutes, plan.features.reduce((sum, f) => sum + f.minutes, 0));

  const keptIds = new Set(plan.features.map((f) => f.id));
  for (const feature of plan.features) {
    for (const prereq of feature.prereqs || []) {
      assert.ok(
        !plan.deferred.some((d) => d.id === prereq) || !keptIds.has(feature.id),
        `${feature.id} was kept but its prerequisite ${prereq} was dropped`,
      );
    }
  }
});

test("dropModules refuses to empty the lab", () => {
  const plan = planLab({ features: ["topics"] });
  assert.throws(() => dropModules(plan, plan.features.map((f) => f.id)), /empty lab/i);
});

test("a partially failed language model blocks rather than mixing two voices", async () => {
  const failures = [];
  const llm = {
    available: true,
    failures,
    provider: { kind: "test", label: "Test provider" },
    async complete(_system, user) {
      if (/^Module: /m.test(user)) {
        failures.push(new Error("429 rate limited"));
        return "";
      }
      return "An overview paragraph written for this scenario.";
    },
  };

  const session = groundedSession();
  const result = await generateLab(
    { features: ["topics"] },
    { write: false, useLearnMcp: true, useLlm: true, llm, connect: async () => session },
  );

  assert.equal(result.status, "blocked");
  assert.equal(result.blockers[0].code, "llm-partial-failure");
  assert.equal(result.blockers[0].detail.failed, failures.length);
});

test("choosing deterministic narrative resolves the language model blocker", async () => {
  const failures = [];
  const llm = {
    available: true,
    failures,
    provider: { kind: "test", label: "Test provider" },
    async complete(_system, user) {
      if (/^Module: /m.test(user)) {
        failures.push(new Error("429 rate limited"));
        return "";
      }
      return "An overview paragraph written for this scenario.";
    },
  };

  const session = groundedSession();
  const result = await generateLab(
    { features: ["topics"] },
    {
      write: false,
      useLearnMcp: true,
      useLlm: true,
      llm,
      connect: async () => session,
      decisions: { "llm-partial-failure": "proceed-deterministic" },
    },
  );

  assert.equal(result.status, "complete");
  assert.equal(result.manifest.decisions[0].chosen.id, "proceed-deterministic");
  assert.doesNotMatch(result.markdown, /An overview paragraph written for this scenario/);
});

test("no configured language model stays a warning, never a blocker", async () => {
  const session = groundedSession();
  const result = await generateLab(
    { features: ["topics"] },
    { write: false, useLearnMcp: true, useLlm: false, connect: async () => session },
  );

  assert.equal(result.status, "complete");
  assert.deepEqual(result.manifest.decisions, []);
});

test("an explicitly requested module dropped by the time budget blocks", async () => {
  const result = await generateLab(
    { industry: "retail", features: ["agent-to-agent", "voice-agents"], timeBudget: 60 },
    { write: false, useLearnMcp: false, useLlm: false },
  );

  assert.equal(result.status, "blocked");
  assert.equal(result.blockers[0].code, "modules-deferred");
  assert.ok(result.blockers[0].detail.modules.length > 0);
});

test("setting the budget aside builds every requested module", async () => {
  const budgeted = await generateLab(
    { industry: "retail", features: ["agent-to-agent", "voice-agents"], timeBudget: 60 },
    { write: false, useLearnMcp: false, useLlm: false, decisions: { "modules-deferred": "accept-deferred" } },
  );
  const unbudgeted = await generateLab(
    { industry: "retail", features: ["agent-to-agent", "voice-agents"], timeBudget: 60 },
    { write: false, useLearnMcp: false, useLlm: false, decisions: { "modules-deferred": "ignore-budget" } },
  );

  assert.equal(budgeted.status, "complete");
  assert.equal(unbudgeted.status, "complete");
  assert.ok(unbudgeted.plan.features.length > budgeted.plan.features.length);
  for (const id of ["agent-to-agent", "voice-agents"]) {
    assert.ok(unbudgeted.plan.features.some((f) => f.id === id), `${id} should be a chapter`);
  }
});

test("an auto-added module dropped by the budget stays a warning", async () => {
  // At 60 minutes the requested module fits; only auto-added core modules are
  // deferred, and the learner never asked for those.
  const result = await generateLab(
    { features: ["topics"], timeBudget: 60 },
    { write: false, useLearnMcp: false, useLlm: false },
  );

  assert.ok(result.plan.deferred.length > 0);
  assert.ok(result.plan.deferred.every((module) => module.requested === false));
  assert.equal(result.status, "complete");
  assert.deepEqual(result.manifest.decisions, []);
});

test("decisions from an untrusted caller are validated", () => {
  assert.throws(() => normalizeDecisions({ "not-a-blocker": "retry" }), /Unknown blocker code/i);
  assert.throws(() => normalizeDecisions({ "learn-mcp-unavailable": "nope" }), /Unknown option/i);
  assert.throws(() => normalizeDecisions({ "learn-mcp-unavailable": 7 }), /option id string/i);
  assert.throws(() => normalizeDecisions([]), /must be an object/i);
  assert.deepEqual(normalizeDecisions(undefined), {});
  assert.deepEqual(normalizeDecisions({ "learn-mcp-unavailable": "cancel" }), {
    "learn-mcp-unavailable": "cancel",
  });
});

test("curated documentation age makes no claim the catalog cannot support", () => {
  assert.match(curatedDocsAge([]).phrase, /not verified against live documentation/);
  const withDates = curatedDocsAge([{ lastVerified: "2026-08-01" }], Date.parse("2026-08-11T00:00:00Z"));
  assert.equal(withDates.reviewed, "2026-08-01");
  assert.equal(withDates.ageDays, 10);
  assert.match(withDates.phrase, /last verified 2026-08-01 \(10 days ago\)/);
});

