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
import { planLab, slugify } from "../lib/lab-builder/planner.js";
import { generateLab } from "../lib/lab-builder/generator.js";
import { connect, searchDocs } from "../lib/lab-builder/learn-mcp.js";
import { detectProvider } from "../lib/lab-builder/llm.js";
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

  await generateLab(
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
