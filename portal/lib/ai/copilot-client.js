/**
 * AI writing: the one place that talks to the GitHub Copilot SDK.
 *
 * Everything else in portal/lib/ai sees only this small backend interface, so tests pass a fake backend (or a fake SDK
 * module to this adapter) and nothing here runs unless AI writing is turned on:
 *
 *   backend.availability()                      is the SDK installed and can it start (no network)
 *   backend.listModels({ token })               the models this identity may use
 *   backend.complete({ model, system, prompt, schema, token, signal, timeoutMs })  one fresh, tool-less session
 *   backend.stop()
 *
 * The SDK is loaded with a dynamic import the first time it is needed, so the server starts, and every other feature
 * works, when the package or its runtime is missing. The package is @microsoft/copilot-sdk (see docs/ai-writing.md).
 *
 * Every generation runs in its own session with: no tools at all (availableTools is empty), every permission request
 * refused, a replacement system message, an empty throw-away working directory, no skills, no shared memory, no session
 * history kept, and a timeout. The runtime is started in "empty" mode, which is the SDK's setting for shared servers.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { AiError, classifyError } from "./errors.js";
import { byokModels, normalizeModels } from "./models.js";

export const SDK_PACKAGE = "@microsoft/copilot-sdk";

const BASE_ENV_KEYS = [
  "PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "windir", "COMSPEC", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "COPILOT_CLI_PATH",
];
const HOME_ENV_KEYS = ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOMEDRIVE", "HOMEPATH", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"];

/**
 * The environment the runtime process gets. It replaces the server's own environment, so no token variable
 * (COPILOT_GITHUB_TOKEN, GH_TOKEN, GITHUB_TOKEN), provider key or portal secret reaches it. Only the machine's own
 * profile folders are passed, and only in local mode, where the runtime must find the owner's stored sign-in.
 */
export function runtimeEnv(env, mode, privateHome = null) {
  const out = { COPILOT_TELEMETRY_DISABLED: "true" };
  for (const key of BASE_ENV_KEYS) if (env[key] !== undefined) out[key] = env[key];
  if (mode === "local-user") {
    for (const key of HOME_ENV_KEYS) if (env[key] !== undefined) out[key] = env[key];
  } else if (privateHome) {
    // Shared and key-based modes get a home of their own, so nothing the runtime writes lands in the server's real home.
    out.HOME = privateHome;
    out.USERPROFILE = privateHome;
  }
  return out;
}

/** The permission handler: nothing is ever approved. */
export function denyEverything(tally) {
  return () => {
    if (tally) tally.denied += 1;
    return { kind: "reject" };
  };
}

async function defaultImportSdk() {
  return import(SDK_PACKAGE);
}

function makeTempDir(root, prefix) {
  return fs.mkdtempSync(path.join(root, prefix));
}

function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* a temp folder that cannot be removed is cleaned up by the operating system */
  }
}

/** Wait for a cleanup step, but never longer than `ms`: a runtime that is slow to answer must not hold up a cancel. */
function bounded(promise, ms) {
  let timer;
  const limit = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
  return Promise.race([Promise.resolve(promise).catch(() => {}), limit]).finally(() => clearTimeout(timer));
}

/**
 * @param {object} options
 * @param {ReturnType<import("./config.js").readAiConfig>} options.config
 * @param {Record<string, string|undefined>} [options.env]
 * @param {() => Promise<object>} [options.importSdk] returns the SDK module; tests pass a fake
 * @param {string} [options.tmpRoot]
 * @param {(line: string) => void} [options.logger]
 */
export function createCopilotBackend({ config, env = process.env, importSdk = defaultImportSdk, tmpRoot = os.tmpdir(), logger } = {}) {
  let sdk = null;
  let sdkError = null;
  let clientPromise = null;
  let clientFailedAt = 0;
  let homeDir = null;
  let workDir = null;
  // `sessions` counts sessions opened, `disconnected` those closed again, `prompts` the messages sent.
  const tally = { denied: 0, sessions: 0, disconnected: 0, prompts: 0, toolsOffered: 0 };
  const openSessions = new Set();

  async function loadSdk() {
    if (sdk) return sdk;
    if (sdkError && Date.now() - sdkError.at < 30000) throw sdkError.error;
    try {
      const loaded = await importSdk();
      if (typeof loaded?.CopilotClient !== "function") throw new Error("The package did not export CopilotClient.");
      sdk = loaded;
      sdkError = null;
      return sdk;
    } catch (err) {
      const error = new AiError("sdk-missing", "AI is not available on this server.", 503);
      error.cause = err;
      sdkError = { at: Date.now(), error };
      throw error;
    }
  }

  async function ensureClient() {
    if (clientPromise) return clientPromise;
    if (clientFailedAt && Date.now() - clientFailedAt < 30000) throw new AiError("sdk-missing", "AI is not available on this server.", 503);
    clientPromise = (async () => {
      const loaded = await loadSdk();
      homeDir = config.copilotHome || makeTempDir(tmpRoot, "ai-copilot-home-");
      workDir = makeTempDir(tmpRoot, "ai-copilot-cwd-");
      const connection = loaded.RuntimeConnection.forSpawnedStdio({
        ...(env.COPILOT_CLI_PATH ? { path: env.COPILOT_CLI_PATH } : {}),
        env: runtimeEnv(env, config.mode, homeDir),
        workingDirectory: workDir,
        baseDirectory: homeDir,
        sessionIdleTimeoutSeconds: 300,
      });
      const client = new loaded.CopilotClient({
        mode: "empty",
        runtime: connection,
        // Per-user and key-based modes never fall back to the machine's stored sign-in or to a token in the environment.
        github: { useLoggedInUser: config.mode === "local-user" },
        observability: { logLevel: "none" },
      });
      await client.start();
      return client;
    })().catch((err) => {
      clientPromise = null;
      clientFailedAt = Date.now();
      throw err instanceof AiError ? err : Object.assign(new AiError("sdk-missing", "AI is not available on this server.", 503), { cause: err });
    });
    return clientPromise;
  }

  async function availability() {
    try {
      await loadSdk();
      return { ok: true };
    } catch (err) {
      return { ok: false, code: err.code || "sdk-missing", message: err.message };
    }
  }

  async function listModels({ token } = {}) {
    if (config.mode === "byok") return byokModels(config);
    const client = await ensureClient();
    let raw;
    if (config.mode === "per-user") {
      const answer = await client.rpc.models.list({ gitHubToken: token });
      raw = answer?.models;
    } else {
      raw = await client.listModels();
    }
    return normalizeModels(raw, { allowed: config.allowedModels });
  }

  async function authStatus() {
    if (config.mode !== "local-user") return null;
    const client = await ensureClient();
    if (typeof client.getAuthStatus !== "function") return null;
    const status = await client.getAuthStatus();
    return { signedIn: Boolean(status?.isAuthenticated), login: typeof status?.login === "string" ? status.login : null };
  }

  function sessionOptions({ model, system, token, reasoningEffort, cwd }) {
    const options = {
      sessionId: `portal-${randomUUID()}`,
      model,
      systemMessage: { mode: "replace", content: system },
      // No tool of any kind: nothing to read, write, run, fetch, or call.
      tools: { availableTools: [], definitions: [] },
      permissions: { onRequest: denyEverything(tally) },
      workingDirectory: cwd,
      skills: { enabled: false },
      state: { infiniteSessions: { enabled: false }, enableCrossSessionStore: false },
      github: { telemetryEnabled: false },
      ...(reasoningEffort ? { inference: { reasoningEffort } } : {}),
    };
    if (config.mode === "per-user") {
      options.github.token = token;
    } else if (config.mode === "byok") {
      options.github.capi = { enabled: false };
      options.model = `byok/${model}`;
      options.inference = {
        ...(options.inference || {}),
        defaultProvider: "byok",
        providers: [
          {
            name: "byok",
            type: config.byok.type,
            baseUrl: config.byok.baseUrl,
            apiKey: config.byok.apiKey,
            wireApi: config.byok.wireApi,
            ...(config.byok.azureApiVersion ? { azure: { apiVersion: config.byok.azureApiVersion } } : {}),
          },
        ],
        models: [{ id: model, provider: "byok" }],
      };
    }
    return options;
  }

  /**
   * One generation in a fresh session. Resolves `{ text, usage, prompts }`; throws an Error that classifyError() can sort.
   * `prompts` counts the messages sent (a runtime without structured output is asked a second time, which is a second prompt),
   * and a thrown error carries the same count, so a caller can add up what a run really used.
   *
   * The time limit is the SDK's second argument to sendAndWait: a `timeout` inside the message is ignored, and the SDK then
   * waits only its own default of 60 seconds.
   */
  async function complete({ model, system, prompt, schema, token, signal, timeoutMs = config.timeoutMs, reasoningEffort }) {
    if (config.mode === "per-user" && !token) throw new AiError("sign-in-required", "Sign in with GitHub to use AI writing.", 401);
    const client = await ensureClient();
    const cwd = makeTempDir(tmpRoot, "ai-run-");
    let session = null;
    const usage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, apiCalls: 0, apiMs: 0, firstTokenMs: 0 };
    let prompts = 0;
    try {
      session = await client.createSession(sessionOptions({ model, system, token, reasoningEffort, cwd }));
      tally.sessions += 1;
      openSessions.add(session);
      const unsubscribe = session.on?.((event) => {
        if (event?.type === "assistant.usage") {
          usage.inputTokens += Number(event.data?.inputTokens) || 0;
          usage.outputTokens += Number(event.data?.outputTokens) || 0;
          usage.reasoningTokens += Number(event.data?.reasoningTokens) || 0;
          usage.apiCalls += 1;
          usage.apiMs += Number(event.data?.duration) || 0;
          usage.firstTokenMs = Math.max(usage.firstTokenMs, Number(event.data?.outputTtftMs) || 0);
        }
      });
      const run = async (useSchema) => {
        const message = { prompt, ...(useSchema && schema ? { responseSchema: schema } : {}) };
        prompts += 1;
        tally.prompts += 1;
        const reply = await session.sendAndWait(message, timeoutMs);
        const text = reply?.data?.content;
        if (typeof text !== "string" || !text.trim()) throw new Error("The model returned no answer.");
        return text;
      };
      const work = run(true).catch((err) => {
        // A runtime without structured output still answers: the prompt itself asks for JSON.
        if (schema && /response ?schema|responseFormat|structured/i.test(String(err?.message))) return run(false);
        throw err;
      });
      let onAbort = null;
      const aborted = new Promise((_, reject) => {
        if (!signal) return;
        onAbort = () => reject(Object.assign(new Error("Cancelled"), { name: "AbortError" }));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
      let timer;
      const timed = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("The model timed out.")), timeoutMs + 5000);
        timer.unref?.();
      });
      try {
        const text = await Promise.race([work, aborted, timed]);
        return { text, usage, prompts };
      } catch (err) {
        await bounded(session.abort?.(), 2000);
        if (err && typeof err === "object") err.prompts = prompts;
        throw err;
      } finally {
        clearTimeout(timer);
        if (onAbort) signal.removeEventListener("abort", onAbort);
        unsubscribe?.();
        work.catch(() => {});
        aborted.catch(() => {});
      }
    } finally {
      await closeSession(client, session);
      removeDir(cwd);
    }
  }

  /** Disconnect a session and delete its stored history. Bounded, so a cancel returns quickly even if the runtime is slow. */
  async function closeSession(client, session) {
    if (!session) return;
    const id = session.sessionId;
    openSessions.delete(session);
    await bounded(session.disconnect?.(), 3000);
    tally.disconnected += 1;
    if (id) await bounded(client.deleteSession?.(id), 2000);
  }

  async function stop() {
    const pending = clientPromise;
    clientPromise = null;
    if (pending) {
      try {
        const client = await pending;
        // A session still open at shutdown (a cancelled lab, a call that never returned) is closed before the runtime is.
        await Promise.all([...openSessions].map((session) => closeSession(client, session)));
        const stopping = client.stop();
        const timeout = new Promise((resolve) => setTimeout(resolve, 5000).unref?.());
        await Promise.race([stopping, timeout]);
        await client.forceStop?.().catch(() => {});
      } catch {
        /* nothing was running */
      }
    }
    if (!config.copilotHome && homeDir) removeDir(homeDir);
    if (workDir) removeDir(workDir);
    homeDir = null;
    workDir = null;
  }

  return { mode: config.mode, availability, listModels, authStatus, complete, stop, tally, openSessions: () => openSessions.size, classifyError };
}
