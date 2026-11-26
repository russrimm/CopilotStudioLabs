/**
 * AI writing: one place that wires the pieces together for the server and the command line.
 *
 *   const ai = createAi({ env, bindHost, authEnabled, dataDir });
 *   ai.service.status(req) / .models(req) / .authorize(req, choice)
 *   ai.github (per-user mode only)
 *   await ai.service.stop()   on shutdown
 *
 * Nothing here starts the SDK. The runtime starts the first time a person asks for models or a lab.
 */

import os from "node:os";
import path from "node:path";

import { readAiConfig } from "./config.js";
import { createAiCache } from "./cache.js";
import { createCopilotBackend } from "./copilot-client.js";
import { createGithubAuth } from "./github-auth.js";
import { createUsageLimiter } from "./limits.js";
import { createAiService } from "./service.js";

/**
 * @param {object} [options]
 * @param {Record<string, string|undefined>} [options.env]
 * @param {string} [options.bindHost]  the address the server listens on (HOST)
 * @param {boolean} [options.authEnabled]  real portal sign-in is on
 * @param {string} [options.dataDir]  the portal's data folder, for the cache file
 * @param {object} [options.backend]  tests pass a fake
 * @param {Function} [options.importSdk]  tests pass a fake SDK module loader
 * @param {typeof fetch} [options.fetchImpl]  tests pass a fake GitHub
 * @param {(line: string) => void} [options.logger]
 */
export function createAi({ env = process.env, bindHost = "127.0.0.1", authEnabled = false, dataDir = null, backend = null, importSdk, fetchImpl, logger, now } = {}) {
  const config = readAiConfig(env);
  for (const problem of config.problems) logger?.(`[ai] ${problem}`);
  const limiter = createUsageLimiter({ config, ...(now ? { now } : {}) });
  const cacheDir = dataDir || String(env.AI_CACHE_DIR || "").trim() || null;
  const cache = createAiCache({ file: cacheDir ? path.join(cacheDir, "ai-cache.json") : null, rejectTtlMs: config.rejectCacheMs, ...(now ? { now } : {}) });
  const theBackend = backend || createCopilotBackend({ config, env, logger, tmpRoot: os.tmpdir(), ...(importSdk ? { importSdk } : {}) });
  const github = config.mode === "per-user" ? createGithubAuth({ config, ...(fetchImpl ? { fetchImpl } : {}), ...(now ? { now } : {}) }) : null;
  const service = createAiService({ config, backend: theBackend, github, limiter, cache, authEnabled, bindHost, logger, ...(now ? { now } : {}) });
  return { config, service, github, limiter, cache, backend: theBackend };
}

/**
 * A stand-in request for the command line, which always runs on the person's own PC: it carries the loopback facts the
 * local-user mode checks, and nothing else.
 */
export function localRequest() {
  const headers = { host: "localhost" };
  return { socket: { remoteAddress: "127.0.0.1" }, headers, method: "POST", ip: "127.0.0.1", get: (name) => headers[String(name).toLowerCase()] };
}
