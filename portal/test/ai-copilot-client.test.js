/**
 * AI writing: the one file that talks to the GitHub Copilot SDK, tested with a fake SDK module (no process, no network, no
 * account), plus a check that the installed package still has the shape this file relies on.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createCopilotBackend, denyEverything, runtimeEnv } from "../lib/ai/copilot-client.js";
import { readAiConfig } from "../lib/ai/config.js";
import { classifyError } from "../lib/ai/errors.js";

const OWNER_ENV = {
  PATH: "/usr/bin",
  SystemRoot: "C:\\Windows",
  HOME: "/home/owner",
  USERPROFILE: "C:\\Users\\owner",
  GH_TOKEN: "ghp_owner_secret",
  GITHUB_TOKEN: "ghp_owner_secret2",
  COPILOT_GITHUB_TOKEN: "ghp_owner_secret3",
  AI_BYOK_API_KEY: "sk-secret",
  AI_GITHUB_CLIENT_SECRET: "client-secret",
  AZURE_CLIENT_ID: "tenant-thing",
  HTTPS_PROXY: "http://proxy.example:8080",
};

function fakeSdk({ models = [{ id: "m1", name: "Model One", billing: { multiplier: 1 }, policy: { state: "enabled" } }, { id: "m2", name: "Two", policy: { state: "disabled" } }] } = {}) {
  const record = { clients: [], connections: [], sessions: [], messages: [], verdicts: [], deleted: [], disconnected: 0, started: 0, stopped: 0, rpcList: [], cwdsAtCreate: [] };
  class CopilotClient {
    constructor(options) {
      record.clients.push(options);
      this.rpc = { models: { list: async (params) => (record.rpcList.push(params), { models }) } };
    }
    async start() {
      record.started += 1;
    }
    async listModels() {
      return models;
    }
    async getAuthStatus() {
      return { isAuthenticated: true, login: "me" };
    }
    async createSession(options) {
      record.sessions.push(options);
      record.cwdsAtCreate.push(existsSync(options.workingDirectory) ? readdirSync(options.workingDirectory) : null);
      const handlers = [];
      return {
        sessionId: options.sessionId,
        on(handler) {
          handlers.push(handler);
          return () => {};
        },
        async sendAndWait(message) {
          record.messages.push(message);
          record.verdicts.push(await options.permissions.onRequest({ kind: "shell", fullCommandText: "rm -rf /" }, {}));
          record.verdicts.push(await options.permissions.onRequest({ kind: "url", url: "https://evil.example" }, {}));
          for (const handler of handlers) handler({ type: "assistant.usage", data: { inputTokens: 120, outputTokens: 30 } });
          return { data: { content: JSON.stringify({ blocks: [{ id: "a", text: "ok", items: [] }] }) } };
        },
        async disconnect() {
          record.disconnected += 1;
        },
        async abort() {},
      };
    }
    async deleteSession(id) {
      record.deleted.push(id);
    }
    async stop() {
      record.stopped += 1;
      return [];
    }
    async forceStop() {}
  }
  const RuntimeConnection = {
    forSpawnedStdio(options) {
      record.connections.push(options);
      return { kind: "spawned-stdio", ...options };
    },
  };
  return { module: { CopilotClient, RuntimeConnection }, record };
}

function make(mode, sdk, extraEnv = {}) {
  const env = { ...OWNER_ENV, AI_GENERATION: mode, ...extraEnv };
  const config = readAiConfig(env);
  const root = mkdtempSync(join(tmpdir(), "ai-client-test-"));
  let imports = 0;
  const backend = createCopilotBackend({ config, env: OWNER_ENV, tmpRoot: root, importSdk: async () => (imports += 1, sdk.module) });
  return { backend, config, root, imports: () => imports, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const REQUEST = { model: "m1", system: "SYSTEM RULES", prompt: "PROMPT", schema: { type: "object" } };

test("the SDK is loaded lazily: creating the backend imports nothing, and a missing package only means 'not available'", async () => {
  const sdk = fakeSdk();
  const lazy = make("local-user", sdk);
  assert.equal(lazy.imports(), 0, "nothing is imported at start");
  assert.equal((await lazy.backend.availability()).ok, true);
  assert.equal(lazy.imports(), 1);
  lazy.cleanup();

  const config = readAiConfig({ AI_GENERATION: "local-user" });
  const missing = createCopilotBackend({ config, env: {}, importSdk: async () => { throw new Error("Cannot find package '@microsoft/copilot-sdk'"); } });
  const status = await missing.availability();
  assert.deepEqual({ ok: status.ok, code: status.code, message: status.message }, { ok: false, code: "sdk-missing", message: "AI is not available on this server." });
  await assert.rejects(missing.complete(REQUEST), (err) => err.code === "sdk-missing" && err.status === 503);
  await assert.rejects(missing.listModels({}), (err) => err.code === "sdk-missing");
  await missing.stop();
});

test("the runtime starts in empty mode with its own folders and an environment that carries no token or key", async () => {
  const sdk = fakeSdk();
  const { backend, cleanup, config } = make("per-user", sdk, { AI_GITHUB_CLIENT_ID: "x", AI_GITHUB_CLIENT_SECRET: "y", AI_PUBLIC_URL: "https://p.example" });
  await backend.complete({ ...REQUEST, token: "gho_user" });
  const [client] = sdk.record.clients;
  assert.equal(client.mode, "empty");
  assert.equal(client.github.useLoggedInUser, false, "per-user mode ignores the machine's sign-in and any token in the environment");
  assert.equal(client.runtime.kind, "spawned-stdio");
  const [connection] = sdk.record.connections;
  const env = connection.env;
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "COPILOT_GITHUB_TOKEN", "AI_BYOK_API_KEY", "AI_GITHUB_CLIENT_SECRET", "AZURE_CLIENT_ID"]) assert.equal(key in env, false, `${key} must not reach the runtime`);
  assert.equal(env.HOME, connection.baseDirectory, "a home of its own, never the server's");
  assert.notEqual(env.USERPROFILE, OWNER_ENV.USERPROFILE);
  assert.equal(env.COPILOT_TELEMETRY_DISABLED, "true");
  assert.equal(env.HTTPS_PROXY, "http://proxy.example:8080", "a corporate proxy still works");
  assert.ok(connection.baseDirectory.startsWith(tmpdir()) || connection.baseDirectory.includes("ai-client-test-"), "its own data folder, not ~/.copilot");
  assert.deepEqual(readdirSync(connection.workingDirectory), [], "the runtime's working folder is empty");
  assert.equal(config.mode, "per-user");
  await backend.stop();
  assert.equal(sdk.record.stopped, 1);
  assert.equal(existsSync(connection.baseDirectory), false, "its folders are removed on stop");
  cleanup();
});

test("local mode passes only the machine's profile folders so the stored sign-in can be found, still no token variable", () => {
  const env = runtimeEnv(OWNER_ENV, "local-user");
  assert.equal(env.HOME, "/home/owner");
  assert.equal(env.USERPROFILE, "C:\\Users\\owner");
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "COPILOT_GITHUB_TOKEN", "AI_BYOK_API_KEY"]) assert.equal(key in env, false);
  assert.equal("HOME" in runtimeEnv(OWNER_ENV, "per-user"), false, "without a private home, none is passed");
  assert.equal(runtimeEnv(OWNER_ENV, "per-user", "/tmp/own").HOME, "/tmp/own");
});

test("every generation: no tools, every permission refused, a replacement system message, an empty folder, then nothing left behind", async () => {
  const sdk = fakeSdk();
  const { backend, cleanup, root } = make("local-user", sdk);
  const out = await backend.complete(REQUEST);
  assert.deepEqual(JSON.parse(out.text).blocks[0].id, "a");
  assert.deepEqual(out.usage, { inputTokens: 120, outputTokens: 30 });
  const [session] = sdk.record.sessions;
  assert.deepEqual(session.tools.availableTools, [], "an empty allow-list means no tool at all");
  assert.deepEqual(session.tools.definitions, []);
  assert.equal(session.systemMessage.mode, "replace");
  assert.equal(session.systemMessage.content, "SYSTEM RULES");
  assert.equal(session.model, "m1");
  assert.equal(session.skills.enabled, false);
  assert.equal(session.state.infiniteSessions.enabled, false);
  assert.equal(session.state.enableCrossSessionStore, false);
  assert.equal(session.github.telemetryEnabled, false);
  assert.equal("token" in session.github, false, "local mode passes no token");
  assert.deepEqual(sdk.record.verdicts, [{ kind: "reject" }, { kind: "reject" }], "a shell command and a web request are both refused");
  assert.equal(backend.tally.denied, 2);
  assert.deepEqual(sdk.record.cwdsAtCreate[0], [], "the working folder was empty");
  assert.equal(sdk.record.messages[0].prompt, "PROMPT");
  assert.deepEqual(sdk.record.messages[0].responseSchema, { type: "object" });
  assert.equal(sdk.record.disconnected, 1);
  assert.deepEqual(sdk.record.deleted, [session.sessionId], "the session and its history are deleted");
  assert.equal(existsSync(session.workingDirectory), false);
  await backend.complete(REQUEST);
  assert.notEqual(sdk.record.sessions[0].sessionId, sdk.record.sessions[1].sessionId, "each generation is a fresh session");
  await backend.stop();
  assert.equal(readdirSync(root).length, 0, "no temp folder survives");
  cleanup();
});

test("the deny handler refuses everything, whatever is asked", () => {
  const tally = { denied: 0 };
  const deny = denyEverything(tally);
  for (const kind of ["shell", "write", "read", "mcp", "url", "custom-tool", "memory", "anything"]) assert.deepEqual(deny({ kind }), { kind: "reject" });
  assert.equal(tally.denied, 8);
});

test("per-user: the visitor's token goes on the session and the model list is asked for with it; no token, no call", async () => {
  const sdk = fakeSdk();
  const { backend, cleanup } = make("per-user", sdk, { AI_GITHUB_CLIENT_ID: "x", AI_GITHUB_CLIENT_SECRET: "y", AI_PUBLIC_URL: "https://p.example" });
  await assert.rejects(backend.complete(REQUEST), (err) => err.code === "sign-in-required");
  await backend.complete({ ...REQUEST, token: "gho_visitor" });
  assert.equal(sdk.record.sessions[0].github.token, "gho_visitor");
  const models = await backend.listModels({ token: "gho_visitor" });
  assert.deepEqual(sdk.record.rpcList, [{ gitHubToken: "gho_visitor" }]);
  assert.deepEqual(models.map((m) => m.id), ["m1"], "a model the account's policy disables is not offered");
  assert.equal(models[0].cost, "Uses 1 premium request for each prompt");
  await backend.stop();
  cleanup();
});

test("local mode lists models from the SDK and applies an administrator allowlist; auth status comes from the SDK", async () => {
  const sdk = fakeSdk({ models: [{ id: "m1", name: "One" }, { id: "m3", name: "Three" }] });
  const { backend, cleanup } = make("local-user", sdk, { AI_ALLOWED_MODELS: "m3" });
  assert.deepEqual((await backend.listModels()).map((m) => m.id), ["m3"]);
  assert.deepEqual(await backend.authStatus(), { signedIn: true, login: "me" });
  await backend.stop();
  cleanup();
});

test("byok: the key goes on the session as a named provider, copilot models are off, and the list comes from configuration", async () => {
  const sdk = fakeSdk();
  const { backend, cleanup } = make("byok", sdk, { AI_BYOK_BASE_URL: "https://contoso.openai.azure.com", AI_BYOK_API_KEY: "sk-byok", AI_BYOK_TYPE: "azure", AI_BYOK_MODELS: "gpt-4o=GPT-4o", AI_BYOK_AZURE_API_VERSION: "2024-10-21" });
  assert.deepEqual((await backend.listModels()).map((m) => m.id), ["gpt-4o"]);
  assert.equal(sdk.record.clients.length, 0, "no SDK call is needed to list a configured model");
  await backend.complete({ ...REQUEST, model: "gpt-4o" });
  const [session] = sdk.record.sessions;
  assert.equal(session.model, "byok/gpt-4o");
  assert.equal(session.github.capi.enabled, false);
  assert.equal(session.inference.defaultProvider, "byok");
  assert.deepEqual(session.inference.providers[0], { name: "byok", type: "azure", baseUrl: "https://contoso.openai.azure.com", apiKey: "sk-byok", wireApi: "completions", azure: { apiVersion: "2024-10-21" } });
  assert.equal(sdk.record.clients[0].github.useLoggedInUser, false);
  await backend.stop();
  cleanup();
});

test("a cancelled generation rejects as a cancel and still cleans up its session", async () => {
  const sdk = fakeSdk();
  const original = sdk.module.CopilotClient.prototype.createSession;
  sdk.module.CopilotClient.prototype.createSession = async function (options) {
    const session = await original.call(this, options);
    session.sendAndWait = () => new Promise(() => {});
    return session;
  };
  const { backend, cleanup } = make("local-user", sdk);
  const controller = new AbortController();
  const pending = backend.complete({ ...REQUEST, signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, (err) => classifyError(err).kind === "aborted");
  assert.equal(sdk.record.disconnected, 1);
  assert.equal(sdk.record.deleted.length, 1);
  await backend.stop();
  cleanup();
});

test("errors are sorted so only temporary trouble is retried and an allowance or sign-in problem stops the run", () => {
  assert.deepEqual(classifyError(new Error("429 Too Many Requests")), { kind: "transient", transient: true, stop: false });
  assert.equal(classifyError(new Error("The model timed out.")).transient, true);
  assert.deepEqual(classifyError(new Error("You have exceeded your premium request allowance")), { kind: "quota", transient: false, stop: true });
  assert.equal(classifyError(new Error("401 Unauthorized")).stop, true);
  assert.equal(classifyError(new Error("something odd")).kind, "failed");
});

// ── the installed package ────────────────────────────────────────────────────
const portalRoot = fileURLToPath(new URL("..", import.meta.url));

test("the dependency is pinned, optional, and the package still has the shape the adapter uses", async (t) => {
  const pkg = JSON.parse(readFileSync(join(portalRoot, "package.json"), "utf8"));
  assert.equal(pkg.optionalDependencies["@microsoft/copilot-sdk"], "2.0.1-preview.0", "pinned exactly: the SDK is a preview");
  assert.equal(pkg.dependencies["@microsoft/copilot-sdk"], undefined, "optional, so an install that cannot fetch it still succeeds");
  const lock = JSON.parse(readFileSync(join(portalRoot, "package-lock.json"), "utf8"));
  assert.equal(lock.packages["node_modules/@microsoft/copilot-sdk"].version, "2.0.1-preview.0");
  assert.match(lock.packages["node_modules/@microsoft/copilot-sdk"].integrity, /^sha512-/);
  for (const platform of ["linux-x64", "linux-arm64", "linuxmusl-x64", "linuxmusl-arm64"]) {
    assert.ok(lock.packages[`node_modules/@microsoft/copilot-sdk-${platform}`], `the ${platform} runtime is in the lockfile`);
  }

  let sdk;
  try {
    sdk = await import("@microsoft/copilot-sdk");
  } catch {
    return t.skip("The SDK package is not installed here.");
  }
  assert.equal(typeof sdk.CopilotClient, "function");
  assert.equal(typeof sdk.RuntimeConnection.forSpawnedStdio, "function");
  assert.equal(typeof sdk.approveAll, "function");
  // Constructing a client starts nothing: no process, no network.
  const client = new sdk.CopilotClient({ mode: "empty", runtime: sdk.RuntimeConnection.forSpawnedStdio({ env: {}, workingDirectory: tmpdir(), baseDirectory: tmpdir() }), github: { useLoggedInUser: false } });
  for (const method of ["start", "stop", "listModels", "createSession", "deleteSession", "getAuthStatus", "forceStop"]) assert.equal(typeof client[method], "function", method);
  // `client.rpc` exists only after start(), which the adapter always awaits first.
  assert.throws(() => client.rpc, /Call start\(\) first/);
});
