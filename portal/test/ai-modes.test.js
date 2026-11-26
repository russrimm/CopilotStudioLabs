/**
 * AI writing: who may use it, in each mode, over real HTTP routes with a fake backend and a fake GitHub.
 * Nothing here starts the SDK or contacts GitHub or any model.
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";

import { createAi } from "../lib/ai/index.js";
import { isLoopbackAddress, isLoopbackBind, isLoopbackHostHeader, isLoopbackRequest } from "../lib/ai/access.js";
import { registerAiRoutes } from "../lib/ai/routes.js";
import { readAiConfig } from "../lib/ai/config.js";
import { createRateLimiter } from "../lib/rate-limit.js";
import { visitorKey } from "../lib/concurrency/visitor.js";
import { createFakeBackend } from "./fixtures/fake-ai.js";

const cleanups = [];
after(async () => {
  for (const fn of cleanups.reverse()) await fn();
});

const USER_TOKEN = "gho_FAKE_USER_TOKEN_1";
const OWNER_TOKEN = "ghp_OWNER_TOKEN_MUST_NEVER_BE_USED";
const BYOK_KEY = "sk-byok-secret-key-123";

function fakeGithub() {
  const seen = [];
  const impl = async (url, init = {}) => {
    seen.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null, auth: init.headers?.authorization });
    if (String(url) === "https://github.com/login/oauth/access_token") {
      const body = JSON.parse(init.body);
      if (body.code === "good-code") return json({ access_token: USER_TOKEN, expires_in: 28800, refresh_token: "ghr_FAKE_REFRESH" });
      return json({ error: "bad_verification_code" });
    }
    if (String(url) === "https://api.github.com/user") return json({ login: "octo-fake" });
    return json({}, 404);
  };
  return { impl, seen };
}
const json = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });

async function startApp({ env = {}, authEnabled = false, bindHost = "127.0.0.1", backend = createFakeBackend(), rate = null, importSdk = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ai-modes-"));
  const github = fakeGithub();
  const ai = createAi({ env, bindHost, authEnabled, backend, dataDir: dir, fetchImpl: github.impl, ...(importSdk ? { importSdk } : {}) });
  const app = express();
  registerAiRoutes(app, { service: ai.service, github: ai.github, config: ai.config, visitorOf: visitorKey, ...(rate ? { rateCheck: rate } : {}) });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  cleanups.push(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  const get = async (path, headers = {}) => {
    const res = await fetch(`${base}${path}`, { headers, redirect: "manual" });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { status: res.status, body, text, headers: res.headers };
  };
  const post = async (path, headers = {}) => {
    const res = await fetch(`${base}${path}`, { method: "POST", headers });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, text, headers: res.headers };
  };
  return { ai, base, get, post, backend, github, dir };
}

const noSecrets = (...parts) => {
  const all = parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join("\n");
  for (const secret of [USER_TOKEN, OWNER_TOKEN, BYOK_KEY, "ghr_FAKE_REFRESH", "client-secret-value"]) assert.equal(all.includes(secret), false, `a response must never carry ${secret}`);
};

// ── off ──────────────────────────────────────────────────────────────────────
test("the default is off: status says so, models and builds are refused, and nothing is started", async () => {
  const app = await startApp({ env: {} });
  const status = await app.get("/api/ai/status");
  assert.equal(status.status, 200);
  assert.equal(status.body.state, "off");
  assert.equal(status.body.possible, false);
  assert.match(status.body.message, /turned off on this server/);
  const models = await app.get("/api/ai/models");
  assert.equal(models.status, 403);
  assert.equal(models.body.code, "off");
  await assert.rejects(app.ai.service.authorize({ socket: { remoteAddress: "127.0.0.1" }, headers: { host: "localhost" }, get: () => undefined }, { model: "fake-fast" }), (err) => err.code === "off");
  assert.equal(app.backend.calls.length, 0, "the SDK was never asked anything");
});

test("an unknown AI_GENERATION value fails closed", async () => {
  const config = readAiConfig({ AI_GENERATION: "yes-please" });
  assert.equal(config.mode, "off");
  assert.match(config.problems.join(" "), /not one of/);
  const app = await startApp({ env: { AI_GENERATION: "yes-please" } });
  assert.equal((await app.get("/api/ai/status")).body.state, "off");
});

// ── local-user ───────────────────────────────────────────────────────────────
test("local mode works from this PC and shows the models its sign-in offers, without disabled ones", async () => {
  const app = await startApp({ env: { AI_GENERATION: "local-user" } });
  const status = await app.get("/api/ai/status", { host: "localhost" });
  assert.equal(status.body.state, "ready");
  assert.equal(status.body.available, true);
  assert.equal(status.body.signedInAs, "fake-user");
  const models = await app.get("/api/ai/models", { host: "127.0.0.1" });
  assert.equal(models.status, 200);
  assert.deepEqual(models.body.models.map((m) => m.id), ["fake-fast", "fake-smart"]);
  assert.match(models.body.models[0].cost, /premium request/);
});

test("local mode refuses everything that does not really come from this PC", async () => {
  const app = await startApp({ env: { AI_GENERATION: "local-user" } });
  const attempts = [
    { "x-forwarded-for": "203.0.113.9" },
    { forwarded: "for=203.0.113.9" },
    { origin: "https://evil.example" },
    { origin: "null" },
    { "sec-fetch-site": "cross-site" },
    { "x-real-ip": "203.0.113.9" },
  ];
  for (const headers of attempts) {
    const status = await app.get("/api/ai/status", headers);
    assert.equal(status.body.state, "unavailable", JSON.stringify(headers));
    assert.equal(status.body.reason, "not-local");
    assert.equal((await app.get("/api/ai/models", headers)).status, 403, JSON.stringify(headers));
  }
  assert.equal(app.backend.calls.filter((c) => c.type === "models").length, 0);
});

test("local mode on a portal that listens beyond this PC is never local", async () => {
  const app = await startApp({ env: { AI_GENERATION: "local-user" }, bindHost: "0.0.0.0" });
  assert.equal((await app.get("/api/ai/status", { host: "localhost" })).body.reason, "not-local");
});

test("the loopback checks, address by address", () => {
  for (const ok of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "127.5.5.5"]) assert.equal(isLoopbackAddress(ok), true, ok);
  for (const bad of ["10.0.0.5", "192.168.1.2", "203.0.113.1", "::ffff:10.0.0.1", "", undefined]) assert.equal(isLoopbackAddress(bad), false, String(bad));
  for (const ok of ["localhost", "localhost:3005", "127.0.0.1:3005", "[::1]:3005", "app.localhost"]) assert.equal(isLoopbackHostHeader(ok), true, ok);
  for (const bad of ["example.com", "localhost.evil.example", "127.0.0.1.evil.example", ""]) assert.equal(isLoopbackHostHeader(bad), false, bad);
  assert.equal(isLoopbackBind("127.0.0.1"), true);
  assert.equal(isLoopbackBind("0.0.0.0"), false);
  const req = (over = {}) => ({ socket: { remoteAddress: "127.0.0.1" }, headers: { host: "localhost", ...over }, get(name) { return this.headers[name.toLowerCase()]; } });
  assert.equal(isLoopbackRequest(req()), true);
  assert.equal(isLoopbackRequest({ ...req(), socket: { remoteAddress: "10.1.1.1" } }), false);
  assert.equal(isLoopbackRequest(req({ "x-forwarded-for": "1.2.3.4" })), false);
});

test("when the SDK is not installed the status says so plainly and the server keeps working", async () => {
  const app = await startApp({ env: { AI_GENERATION: "local-user" }, backend: createFakeBackend({ available: false }) });
  const status = await app.get("/api/ai/status", { host: "localhost" });
  assert.equal(status.body.state, "unavailable");
  assert.equal(status.body.possible, false);
  assert.equal(status.body.message, "AI is not available on this server.");
  assert.equal((await app.get("/api/ai/models", { host: "localhost" })).status, 503);
});

test("local mode with no Copilot sign-in on this PC asks for one", async () => {
  const app = await startApp({ env: { AI_GENERATION: "local-user" }, backend: createFakeBackend({ signedIn: false }) });
  const status = await app.get("/api/ai/status", { host: "localhost" });
  assert.equal(status.body.state, "sign-in");
  assert.equal(status.body.possible, true);
  assert.match(status.body.message, /Sign in to GitHub Copilot on this PC/);
  assert.equal(status.body.signInUrl, undefined, "local sign-in happens on the PC, not on this page");
});

// ── per-user ─────────────────────────────────────────────────────────────────
const PER_USER = { AI_GENERATION: "per-user", AI_GITHUB_CLIENT_ID: "Iv1.testclient", AI_GITHUB_CLIENT_SECRET: "client-secret-value", AI_PUBLIC_URL: "https://portal.example.com", GH_TOKEN: OWNER_TOKEN, GITHUB_TOKEN: OWNER_TOKEN, COPILOT_GITHUB_TOKEN: OWNER_TOKEN };

test("per-user mode needs each visitor to sign in; nobody uses the owner's token", async () => {
  const app = await startApp({ env: PER_USER, authEnabled: false, bindHost: "0.0.0.0" });
  const status = await app.get("/api/ai/status", { "x-forwarded-for": "203.0.113.9" });
  assert.equal(status.body.state, "sign-in");
  assert.equal(status.body.needsSignIn, true);
  assert.equal(status.body.signInUrl, "/api/ai/auth/start");
  assert.equal((await app.get("/api/ai/models", { "x-forwarded-for": "203.0.113.9" })).status, 401);
  await assert.rejects(app.ai.service.authorize({ socket: { remoteAddress: "203.0.113.9" }, headers: {}, get: () => undefined }, { model: "fake-fast" }), (err) => err.status === 401);
  assert.equal(app.backend.calls.length, 0);
  noSecrets(status.text);
});

test("per-user sign-in: state and PKCE out, a cookie that holds no token, the token kept server-side, used only for that visitor", async () => {
  const app = await startApp({ env: PER_USER, bindHost: "0.0.0.0" });
  const start = await app.post("/api/ai/auth/start");
  assert.equal(start.status, 200);
  const url = new URL(start.body.url);
  assert.equal(url.origin + url.pathname, "https://github.com/login/oauth/authorize");
  assert.equal(url.searchParams.get("client_id"), "Iv1.testclient");
  assert.equal(url.searchParams.get("redirect_uri"), "https://portal.example.com/api/ai/auth/callback");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  const state = url.searchParams.get("state");
  assert.ok(state && state.length >= 20);
  const cookie = start.headers.get("set-cookie");
  assert.match(cookie, /^ai_sid=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  const sid = /ai_sid=([^;]+)/.exec(cookie)[1];

  // A callback from another browser (no cookie), or with a state this server never issued, does nothing.
  assert.equal((await app.get(`/api/ai/auth/callback?code=good-code&state=${state}`)).status, 400);
  assert.equal((await app.get(`/api/ai/auth/callback?code=good-code&state=forged`, { cookie: `ai_sid=${sid}` })).status, 400);
  // The state is spent by a failed attempt, so start again.
  const again = await app.post("/api/ai/auth/start", { cookie: `ai_sid=${sid}` });
  const state2 = new URL(again.body.url).searchParams.get("state");
  const done = await app.get(`/api/ai/auth/callback?code=good-code&state=${state2}`, { cookie: `ai_sid=${sid}` });
  assert.equal(done.status, 200);
  assert.match(done.text, /signed in with GitHub/);
  noSecrets(done.text, done.headers.get("set-cookie") || "", cookie);
  const exchange = app.github.seen.find((s) => s.url.endsWith("/login/oauth/access_token"));
  assert.ok(exchange.body.code_verifier, "PKCE verifier sent");

  const mine = { cookie: `ai_sid=${sid}`, "x-forwarded-for": "203.0.113.9" };
  const status = await app.get("/api/ai/status", mine);
  assert.equal(status.body.state, "ready");
  assert.equal(status.body.signedInAs, "octo-fake");
  const models = await app.get("/api/ai/models", mine);
  assert.equal(models.status, 200);
  noSecrets(status.text, models.text);
  assert.equal(app.backend.calls.find((c) => c.type === "models").hasToken, true, "the visitor's own token reached the SDK call");

  // Someone else on the same portal is not signed in.
  const other = await app.get("/api/ai/status", { "x-forwarded-for": "203.0.113.77" });
  assert.equal(other.body.state, "sign-in");

  const signedOut = await app.post("/api/ai/auth/signout", { cookie: `ai_sid=${sid}` });
  assert.equal(signedOut.status, 200);
  assert.equal((await app.get("/api/ai/status", mine)).body.state, "sign-in");
});

test("per-user mode without a GitHub App configured stays off the page and the start route says so", async () => {
  const app = await startApp({ env: { AI_GENERATION: "per-user" } });
  const status = await app.get("/api/ai/status");
  assert.equal(status.body.state, "unavailable");
  assert.equal(status.body.reason, "not-configured");
  assert.equal((await app.post("/api/ai/auth/start")).status, 404);
});

test("a build in per-user mode passes the visitor's token to the model call and the owner's token never appears", async () => {
  const app = await startApp({ env: PER_USER, bindHost: "0.0.0.0" });
  const start = await app.post("/api/ai/auth/start");
  const sid = /ai_sid=([^;]+)/.exec(start.headers.get("set-cookie"))[1];
  const state = new URL(start.body.url).searchParams.get("state");
  await app.get(`/api/ai/auth/callback?code=good-code&state=${state}`, { cookie: `ai_sid=${sid}` });
  const req = { socket: { remoteAddress: "203.0.113.9" }, headers: { cookie: `ai_sid=${sid}` }, get(name) { return this.headers[name.toLowerCase()]; } };
  const writer = await app.ai.service.authorize(req, { enabled: true, model: "fake-fast", scope: ["lab"] });
  await writer.run({ units: [{ id: "u", context: {}, blocks: [{ id: "b", kind: "why", type: "text", source: "Agents help associates answer questions quickly.", names: [] }] }] });
  writer.release();
  const call = app.backend.calls.find((c) => c.type === "complete");
  assert.equal(call.hasToken, true);
  assert.equal(JSON.stringify(call).includes(OWNER_TOKEN), false);
  assert.equal(JSON.stringify(call).includes(USER_TOKEN), false, "the token is handed over as an argument, never inside the prompt or the system message");
  assert.equal(JSON.stringify(writer).includes(USER_TOKEN), false, "the writer object does not expose it");
});

// ── bring your own key ───────────────────────────────────────────────────────
const BYOK = { AI_GENERATION: "byok", AI_BYOK_BASE_URL: "https://contoso.openai.azure.com", AI_BYOK_API_KEY: BYOK_KEY, AI_BYOK_TYPE: "azure", AI_BYOK_MODELS: "gpt-4o=GPT-4o (Contoso),gpt-4o-mini" };

test("byok needs real portal sign-in, so an open portal can never spend the server's key", async () => {
  const open = await startApp({ env: BYOK, authEnabled: false, bindHost: "0.0.0.0" });
  const status = await open.get("/api/ai/status", { "x-forwarded-for": "203.0.113.9" });
  assert.equal(status.body.state, "unavailable");
  assert.equal(status.body.reason, "needs-portal-sign-in");
  assert.equal((await open.get("/api/ai/models", { "x-forwarded-for": "203.0.113.9" })).status, 403);
  noSecrets(status.text);

  const signedIn = await startApp({ env: BYOK, authEnabled: true, bindHost: "0.0.0.0", backend: createFakeBackend({ mode: "byok" }) });
  const ok = await signedIn.get("/api/ai/status", { "x-forwarded-for": "203.0.113.9" });
  assert.equal(ok.body.state, "ready");
});

test("byok offers only the administrator's models, and never shows the key or the endpoint", async () => {
  // A stand-in for the SDK package, so this test does not depend on the optional package being installed.
  const app = await startApp({ env: BYOK, authEnabled: true, backend: null, importSdk: async () => ({ CopilotClient: class {} }) });
  // The default backend for byok builds its list from configuration, without the SDK.
  const models = await app.get("/api/ai/models");
  assert.equal(models.status, 200);
  assert.deepEqual(models.body.models.map((m) => m.id), ["gpt-4o", "gpt-4o-mini"]);
  assert.equal(models.body.models[0].name, "GPT-4o (Contoso)");
  assert.match(models.body.models[0].cost, /model provider/);
  noSecrets(models.text);
  assert.equal(models.text.includes("contoso.openai.azure.com"), false);
});

test("byok refuses a model outside the list with a plain message", async () => {
  const app = await startApp({ env: BYOK, authEnabled: true, backend: createFakeBackend({ mode: "byok", models: [{ id: "gpt-4o", name: "GPT-4o" }] }) });
  const req = { socket: { remoteAddress: "203.0.113.9" }, headers: {}, get: () => undefined };
  await assert.rejects(app.ai.service.authorize(req, { model: "gpt-9-ultra" }), (err) => err.code === "unknown-model" && /not available to you here/.test(err.message));
});

// ── authorize, shared by every mode ──────────────────────────────────────────
test("an unknown or disabled model is refused with a plain message, and an empty scope too", async () => {
  const app = await startApp({ env: { AI_GENERATION: "local-user" } });
  const req = { socket: { remoteAddress: "127.0.0.1" }, headers: { host: "localhost" }, get(name) { return this.headers[name.toLowerCase()]; } };
  await assert.rejects(app.ai.service.authorize(req, { model: "does-not-exist" }), (err) => err.code === "unknown-model" && err.status === 400 && /not available to you here/.test(err.message));
  await assert.rejects(app.ai.service.authorize(req, { model: "fake-off" }), (err) => err.code === "unknown-model");
  await assert.rejects(app.ai.service.authorize(req, { model: "bad id with spaces" }), (err) => err.code === "unknown-model" && /Pick a model/.test(err.message));
  await assert.rejects(app.ai.service.authorize(req, { model: "fake-fast", scope: ["nothing"] }), (err) => err.code === "no-scope");
  const writer = await app.ai.service.authorize(req, { model: "fake-fast", scope: ["lab", "training"] });
  assert.equal(writer.model, "fake-fast");
  assert.deepEqual(writer.scope, ["lab", "training"]);
  writer.release();
});

test("the model list is cached for a short time, then read again", async () => {
  let now = 0;
  const backend = createFakeBackend();
  const dir = mkdtempSync(join(tmpdir(), "ai-cache-models-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const ai = createAi({ env: { AI_GENERATION: "local-user", AI_MODEL_CACHE_MS: "5000" }, backend, dataDir: dir, now: () => now });
  const req = { socket: { remoteAddress: "127.0.0.1" }, headers: { host: "localhost" }, get(name) { return this.headers[name.toLowerCase()]; } };
  await ai.service.models(req);
  await ai.service.models(req);
  assert.equal(backend.calls.filter((c) => c.type === "models").length, 1);
  now = 6000;
  await ai.service.models(req);
  assert.equal(backend.calls.filter((c) => c.type === "models").length, 2);
});

test("the AI routes share the portal's per-visitor rate limit", async () => {
  const limiter = createRateLimiter({ windowMs: 60000, max: 2 });
  const app = await startApp({ env: { AI_GENERATION: "local-user" }, rate: (req) => limiter(visitorKey(req)) });
  assert.equal((await app.get("/api/ai/status")).status, 200);
  assert.equal((await app.get("/api/ai/status")).status, 200);
  const third = await app.get("/api/ai/status");
  assert.equal(third.status, 429);
  assert.ok(third.headers.get("retry-after"));
});

test("progress is private to the visitor who started the build", async () => {
  const app = await startApp({ env: { AI_GENERATION: "local-user" } });
  const mine = visitorKey({ socket: { remoteAddress: "127.0.0.1" }, headers: {}, get: () => undefined, ip: "127.0.0.1" });
  app.ai.service.setProgress(mine, "b1234567890abcdef12345678", { done: 3, total: 9, stage: "lab" });
  const own = await app.get("/api/ai/progress/b1234567890abcdef12345678");
  assert.deepEqual(own.body, { done: 3, total: 9, stage: "lab", finished: false });
  app.ai.service.setProgress("someone-else", "bffffffffffffffffffffffff", { done: 1, total: 2, stage: "lab" });
  assert.equal((await app.get("/api/ai/progress/bffffffffffffffffffffffff")).body.total, 0);
});
