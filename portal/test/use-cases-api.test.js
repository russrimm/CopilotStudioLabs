/**
 * Use Case Builder API: GET /api/use-cases/options and POST /api/use-cases/generate,
 * checked through the real server (body limit, sign-in, rate limit, JSON errors)
 * and through a small Express app (the optional AI wording pass), plus proof that
 * the older /api/scenarios endpoints did not change.
 *
 * Hermetic: a local server on a free port, no network, no language model.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";

import { registerUseCaseRoutes, USE_CASE_JSON_BODY_LIMIT, USE_CASE_JSON_PATHS } from "../lib/use-cases/index.js";

const PORTAL_ROOT = new URL("..", import.meta.url);
const cleanups = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

async function startPortal({ auth = false, env = {} } = {}) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const storageRoot = mkdtempSync(join(tmpdir(), "use-cases-api-"));
  cleanups.push(() => rmSync(storageRoot, { recursive: true, force: true }));
  let stderr = "";
  const child = spawn(process.execPath, ["server.js"], {
    cwd: PORTAL_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      PORTAL_AUTH_DISABLED: auth ? "" : "true",
      ...(auth ? { AZURE_TENANT_ID: "00000000-0000-0000-0000-000000000000", PORTAL_API_AUDIENCE: "api://use-cases-test" } : {}),
      AZURE_KEYVAULT_URL: "",
      PORTAL_STORAGE_ROOT: storageRoot,
      LAB_BUILDER_LINK_CHECK: "off",
      LAB_BUILDER_LLM: "off",
      ...env,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  cleanups.push(() => child.kill());
  const deadline = Date.now() + 20000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}): ${stderr.slice(-600)}`);
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("server did not start in time");
    await new Promise((r) => setTimeout(r, 120));
  }
  return base;
}

async function call(base, method, path, { json, raw, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (json !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(json);
  } else if (raw !== undefined) {
    init.headers["Content-Type"] = headers["Content-Type"] || "application/json";
    init.body = raw;
  }
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: res.status, body, text, headers: res.headers };
}

const generate = (base, json) => call(base, "POST", "/api/use-cases/generate", { json });

test("options describe every input, its valid ids, and the limits", async () => {
  const base = await startPortal();
  const res = await call(base, "GET", "/api/use-cases/options");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const options = res.body;
  assert.deepEqual(options.industries.map((i) => i.id), ["manufacturing", "retail", "financial-services", "healthcare", "energy-resources", "education", "nonprofit"]);
  assert.equal(options.departments.length, 12);
  assert.deepEqual(options.goals.map((g) => g.id), ["reduce-handling-time", "speed-approvals", "customer-experience", "compliance-risk", "grow-revenue", "knowledge-access", "reduce-cost"]);
  assert.deepEqual(options.dataSources.map((s) => s.id), ["sharepoint", "dataverse", "teams", "email", "lob", "web", "none"]);
  assert.deepEqual(options.platforms.map((p) => p.id), ["both", "copilot-studio", "agent-builder"]);
  assert.deepEqual(options.levels.map((l) => l.value), [null, 100, 200, 300]);
  assert.deepEqual(options.defaults, { platform: "both", level: null });
  assert.deepEqual(options.limits, { maxDepartments: 12, maxGoals: 7, maxDataSources: 7, maxResults: 40, maxBodyBytes: 65536 });
  assert.deepEqual(options.polish, { available: false });
  for (const group of [options.industries, options.departments, options.goals, options.dataSources, options.platforms]) {
    for (const entry of group) assert.ok(entry.description && (entry.name || entry.label), JSON.stringify(entry));
  }
  assert.doesNotMatch(res.text, /<script|\$\{/);
});

test("generate returns the ranked use cases, and polish stays off unless asked and configured", async () => {
  const base = await startPortal();
  const res = await generate(base, { industry: "healthcare", departments: ["customer-service"], goals: ["reduce-handling-time"], dataSources: ["sharepoint"], platform: "both", level: null });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.ok(res.body.useCases.length >= 6);
  assert.equal(res.body.polish.applied, false);
  assert.equal(res.body.polish.requested, false);
  assert.equal(res.body.labels.industry, "Healthcare");
  assert.deepEqual(res.body.labels.departments, ["Customer Service"]);

  const polish = await generate(base, { industry: "healthcare", departments: ["customer-service"], polish: true });
  assert.equal(polish.status, 200);
  assert.equal(polish.body.polish.requested, true);
  assert.equal(polish.body.polish.applied, false);
  assert.match(polish.body.polish.note, /No language model is configured/);
  const plain = await generate(base, { industry: "healthcare", departments: ["customer-service"] });
  assert.deepEqual(polish.body.useCases, plain.body.useCases, "no model means the same list");
});

test("bad requests get a 400 with a clear message and nothing reflected as markup", async () => {
  const base = await startPortal();
  for (const [json, pattern] of [
    [{}, /industry is required/],
    [{ industry: "mining" }, /Unknown industry "mining"/],
    [{ industry: "<img src=x onerror=alert(1)>" }, /Unknown industry "\(invalid value\)"/],
    [{ industry: "retail", departments: ["finance", "sorcery"] }, /Unknown department "sorcery"/],
    [{ industry: "retail", goals: ["win"] }, /Unknown goal/],
    [{ industry: "retail", dataSources: ["fax"] }, /Unknown data source/],
    [{ industry: "retail", platform: "excel" }, /Unknown platform/],
    [{ industry: "retail", level: 150 }, /level must be/],
    [{ industry: "retail", departments: Array(13).fill("hr") }, /at most 12 values/],
    [{ industry: "retail", polish: "true" }, /polish must be true or false/],
    [{ industry: "retail", surprise: 1 }, /Unknown field "surprise"/],
  ]) {
    const res = await generate(base, json);
    assert.equal(res.status, 400, JSON.stringify(json));
    assert.match(res.body.error, pattern);
    assert.doesNotMatch(res.text, /<img|<script/);
  }
  assert.equal((await call(base, "POST", "/api/use-cases/generate", { raw: "{not json" })).status, 400);
  assert.equal((await call(base, "POST", "/api/use-cases/generate", { raw: "industry=retail", headers: { "Content-Type": "text/plain" } })).body.error, "industry is required.");
  assert.equal((await call(base, "POST", "/api/use-cases/generate", { raw: "[1,2]" })).status, 400);
});

test("the body limit is 64 KB: a request over it is refused before it is read, one under it is judged on its content", async () => {
  assert.equal(USE_CASE_JSON_BODY_LIMIT, "64kb");
  assert.deepEqual([...USE_CASE_JSON_PATHS], ["/api/use-cases"]);
  const base = await startPortal();
  const over = await call(base, "POST", "/api/use-cases/generate", { raw: JSON.stringify({ industry: "retail", pad: "x".repeat(70 * 1024) }) });
  assert.equal(over.status, 413);
  assert.equal(over.body.error, "Request body is too large.");
  const under = await call(base, "POST", "/api/use-cases/generate", { raw: JSON.stringify({ industry: "retail", pad: "x".repeat(60 * 1024) }) });
  assert.equal(under.status, 400);
  assert.match(under.body.error, /Unknown field "pad"/);
});

test("generate is rate limited per user and answers 429 with Retry-After, while options stay open", async () => {
  const base = await startPortal({ env: { USE_CASE_RATE_MAX: "3", USE_CASE_RATE_WINDOW_MS: "60000" } });
  for (let i = 0; i < 3; i += 1) assert.equal((await generate(base, { industry: "retail" })).status, 200);
  const limited = await generate(base, { industry: "retail" });
  assert.equal(limited.status, 429);
  assert.match(limited.body.error, /Too many use case requests\. Try again in \d+s\./);
  assert.ok(Number(limited.headers.get("retry-after")) >= 1);
  assert.equal((await call(base, "GET", "/api/use-cases/options")).status, 200);
});

test("both routes sit behind portal sign-in", async () => {
  const base = await startPortal({ auth: true });
  assert.equal((await call(base, "GET", "/api/use-cases/options")).status, 401);
  assert.equal((await generate(base, { industry: "retail" })).status, 401);
  assert.equal((await call(base, "GET", "/api/use-cases/options", { headers: { Authorization: "Bearer not-a-token" } })).status, 401);
});

test("the older scenario endpoints are unchanged", async () => {
  const base = await startPortal();
  const all = await call(base, "GET", "/api/scenarios");
  assert.equal(all.status, 200);
  assert.deepEqual(Object.keys(all.body).sort(), ["industries", "roles"]);
  assert.equal(all.body.industries.length, 7);
  assert.equal(all.body.roles.length, 12);
  assert.deepEqual(Object.keys(all.body.industries[0]).sort(), ["categories", "description", "icon", "id", "kpis", "name", "suggestedLabs"]);

  const one = await call(base, "GET", "/api/scenarios/industry/retail");
  assert.equal(one.status, 200);
  assert.equal(one.body.id, "retail");
  assert.equal((await call(base, "GET", "/api/scenarios/role/sales")).body.id, "sales");
  const wrongType = await call(base, "GET", "/api/scenarios/team/retail");
  assert.equal(wrongType.status, 400);
  assert.equal(wrongType.body.error, "Scenario type must be 'industry' or 'role'");
  assert.equal((await call(base, "GET", "/api/scenarios/industry/mining")).body.error, "Scenario not found");

  const configured = await call(base, "POST", "/api/scenarios/configure", { json: { industry: "retail", roles: ["sales", "finance"] } });
  assert.equal(configured.status, 200);
  assert.deepEqual(Object.keys(configured.body).sort(), ["branding", "labs", "organization", "scenario"]);
  assert.equal(configured.body.scenario.industry, "retail");
  assert.deepEqual(configured.body.scenario.roles, ["sales", "finance"]);
  assert.ok(Array.isArray(configured.body.labs.include) && configured.body.labs.include.length > 0);
  assert.equal((await call(base, "POST", "/api/scenarios/configure", { json: {} })).body.error, "industry is required");
  assert.equal((await call(base, "POST", "/api/scenarios/configure", { json: { industry: "mining" } })).status, 404);
});

// ── The AI wording pass through the routes ──────────────────────────────────

async function listen(app) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  cleanups.push(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

function appWith(deps) {
  const app = express();
  app.use((req, _res, next) => {
    req.user = { oid: "user-1" };
    next();
  });
  app.use(USE_CASE_JSON_PATHS, express.json({ limit: USE_CASE_JSON_BODY_LIMIT }));
  registerUseCaseRoutes(app, deps);
  return app;
}

test("with a model configured, polish rewrites only titles and descriptions and says so", async () => {
  const calls = [];
  const createLlm = () => ({
    available: true,
    provider: { label: "Fake model", kind: "fake" },
    async complete(_system, user) {
      calls.push(user);
      const { items } = JSON.parse(user);
      return JSON.stringify({ items: items.map((item) => ({ id: item.id, title: `Polished ${item.title}`.slice(0, 120), description: `${item.description} This version reads more smoothly for the team.`.slice(0, 650) })) });
    },
  });
  const base = await listen(appWith({ createLlm, env: {} }));
  assert.deepEqual((await call(base, "GET", "/api/use-cases/options")).body.polish, { available: true });
  const plain = await call(base, "POST", "/api/use-cases/generate", { json: { industry: "education", departments: ["hr"] } });
  assert.equal(calls.length, 0, "a plain request never reaches the model");
  const polished = await call(base, "POST", "/api/use-cases/generate", { json: { industry: "education", departments: ["hr"], polish: true } });
  assert.equal(polished.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(polished.body.polish.applied, true);
  assert.equal(polished.body.polish.provider, "Fake model");
  assert.equal(polished.body.useCases.length, plain.body.useCases.length);
  polished.body.useCases.forEach((u, index) => {
    const before = plain.body.useCases[index];
    assert.match(u.title, /^Polished /);
    assert.equal(u.polished, true);
    const { title, description, polished: flag, ...rest } = u;
    const { title: t0, description: d0, ...rest0 } = before;
    assert.deepEqual(rest, rest0);
    assert.ok(flag && title && description && t0 && d0);
  });
});

test("the polish limit and the generate limit are separate, and both answer 429", async () => {
  const stop = { allowed: false, retryAfterSec: 42 };
  const go = { allowed: true };
  const createLlm = () => ({ available: false, provider: { kind: "none" }, async complete() { return ""; } });

  const polishLimited = await listen(appWith({ createLlm, env: {}, rateCheck: () => go, polishRateCheck: () => stop }));
  assert.equal((await call(polishLimited, "POST", "/api/use-cases/generate", { json: { industry: "retail" } })).status, 200);
  const blocked = await call(polishLimited, "POST", "/api/use-cases/generate", { json: { industry: "retail", polish: true } });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get("retry-after"), "42");
  assert.match(blocked.body.error, /Too many AI wording requests\. Try again in 42s\./);

  const keys = [];
  const generateLimited = await listen(appWith({ createLlm, env: {}, rateCheck: (key) => (keys.push(key), stop), polishRateCheck: () => go }));
  const res = await call(generateLimited, "POST", "/api/use-cases/generate", { json: { industry: "retail" } });
  assert.equal(res.status, 429);
  assert.deepEqual(keys, ["user-1"], "the limit is per signed-in user");
});
