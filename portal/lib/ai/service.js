/**
 * AI writing: the service that routes, the build and the CLI talk to.
 *
 *   status(req)            what to show: off, unavailable, sign in, or ready (and why)
 *   models(req)            the models this visitor may pick, live from the SDK
 *   authorize(req, choice) check the mode, the visitor, the model and the limits, and hand back a writer for one lab
 *   stop()                 close the SDK runtime when the server shuts down
 *
 * The SDK is started lazily by the backend, the first time a person asks for models or a lab, never at server start.
 */

import { decideAccess, requireAccess } from "./access.js";
import { AI_SCOPE_LABELS, isModelId, normalizeScope } from "./config.js";
import { createModelCache, pickReasoningEffort } from "./models.js";
import { AiError } from "./errors.js";
import { createEngine } from "./engine.js";
import { createCallGate } from "./limits.js";
import { readCookie, sessionCookieName } from "./github-auth.js";
import { newRecord, providerLabel } from "./record.js";
import { ESTIMATE_PARAMS } from "./estimate.js";
import { visitorKey } from "../concurrency/visitor.js";

const SENDS =
  "AI sees only the lab's topic text from Microsoft Learn and the catalog, and the scenario fields you typed. It never sees tenant data or screenshots. Steps, interface names and facts stay as written; AI only rewords them, and every reworded passage is checked against the original.";

function plainScopes() {
  return Object.entries(AI_SCOPE_LABELS).map(([id, label]) => ({ id, label }));
}

export function createAiService({ config, backend, github = null, limiter, cache, authEnabled = false, bindHost = "127.0.0.1", logger, now = Date.now, ticketTtlMs = 15 * 60 * 1000 }) {
  const modelCache = createModelCache({ ttlMs: config.modelCacheMs, now });
  const engine = createEngine({ backend, config, cache, limiter, gate: createCallGate({ max: config.maxCallsInFlight }), logger });
  const progress = new Map();
  let authCache = { at: 0, value: null };

  async function sessionFor(req) {
    if (config.mode !== "per-user" || !github) return null;
    return github.session(readCookie(req, sessionCookieName()));
  }

  function baseStatus() {
    return {
      mode: config.mode,
      enabled: config.mode !== "off",
      state: "off",
      possible: false,
      available: false,
      reason: "off",
      message: "AI writing is turned off on this server.",
      signedIn: false,
      signedInAs: null,
      needsSignIn: false,
      provider: null,
      scopes: plainScopes(),
      sends: SENDS,
      estimate: ESTIMATE_PARAMS,
    };
  }

  async function localSignIn() {
    if (now() - authCache.at < 30000) return authCache.value;
    let value = null;
    try {
      value = await backend.authStatus();
    } catch {
      value = null;
    }
    authCache = { at: now(), value };
    return value;
  }

  async function status(req) {
    const out = baseStatus();
    if (config.mode === "off") {
      if (config.problems.length) out.message = "AI writing is turned off on this server.";
      return out;
    }
    out.provider = providerLabel(config);
    const session = await sessionFor(req);
    const decision = decideAccess({ config, req, authEnabled, bindHost, session });
    if (!decision.ok) {
      out.reason = decision.code;
      out.message = decision.message;
      if (decision.needsSignIn) {
        out.state = "sign-in";
        out.possible = true;
        out.needsSignIn = true;
        out.signInUrl = "/api/ai/auth/start";
      } else {
        out.state = "unavailable";
      }
      return out;
    }
    const sdk = await backend.availability();
    if (!sdk.ok) {
      out.state = "unavailable";
      out.reason = sdk.code || "sdk-missing";
      out.message = "AI is not available on this server.";
      return out;
    }
    if (config.mode === "local-user") {
      const auth = await localSignIn();
      if (auth && !auth.signedIn) {
        out.state = "sign-in";
        out.possible = true;
        out.needsSignIn = true;
        out.reason = "copilot-sign-in-needed";
        out.message = "Sign in to GitHub Copilot on this PC (run copilot login, or gh auth login), then reload this page.";
        return out;
      }
      out.signedIn = Boolean(auth?.signedIn);
      out.signedInAs = auth?.login || null;
    }
    if (config.mode === "per-user") {
      out.signedIn = true;
      out.signedInAs = session?.login || null;
    }
    out.state = "ready";
    out.possible = true;
    out.available = true;
    out.reason = "ready";
    out.message = out.signedInAs ? `Signed in as ${out.signedInAs}.` : config.mode === "byok" ? "Using this server's own model provider." : "Ready.";
    return out;
  }

  async function modelsFor(req, session) {
    const key = modelCache.keyFor(config.mode === "per-user" ? session?.token : config.mode);
    const hit = modelCache.get(key);
    if (hit) return hit;
    const list = await backend.listModels({ token: session?.token });
    modelCache.set(key, list);
    return list;
  }

  async function models(req) {
    const session = await sessionFor(req);
    requireAccess(decideAccess({ config, req, authEnabled, bindHost, session }));
    const avail = await backend.availability();
    if (!avail.ok) throw new AiError("sdk-missing", "AI is not available on this server.", 503);
    try {
      return { models: await modelsFor(req, session), provider: providerLabel(config) };
    } catch (err) {
      if (err instanceof AiError) throw err;
      throw new AiError("models-failed", "The model list could not be read. Check that you are signed in to GitHub Copilot, then try again.", 502);
    }
  }

  /**
   * Check everything and return the writer for one lab. Throws an AiError with a plain message and a status for a route.
   * @param {object} req  the HTTP request (or a stand-in with the same headers and socket for the CLI)
   * @param {{enabled?: boolean, model?: string, scope?: string[]}} choice
   */
  async function authorize(req, choice) {
    const session = await sessionFor(req);
    requireAccess(decideAccess({ config, req, authEnabled, bindHost, session }));
    const avail = await backend.availability();
    if (!avail.ok) throw new AiError("sdk-missing", "AI is not available on this server.", 503);
    if (!isModelId(choice?.model)) throw new AiError("unknown-model", "Pick a model from the list to write with AI.", 400);
    const scope = normalizeScope(choice.scope);
    if (!scope.length) throw new AiError("no-scope", "Choose at least one part of the lab for AI to write.", 400);
    let list;
    try {
      list = await modelsFor(req, session);
    } catch {
      throw new AiError("models-failed", "The model list could not be read. Try again, or build without AI.", 502);
    }
    const found = list.find((m) => m.id === choice.model);
    if (!found) throw new AiError("unknown-model", `The model "${choice.model}" is not available to you here. Pick one from the list.`, 400);

    const visitor = visitorKey(req);
    const lease = limiter.reserveLab(visitor);
    const providerName = providerLabel(config);
    const effort = pickReasoningEffort(found, config.reasoningEffort);
    return {
      mode: config.mode,
      model: found.id,
      modelName: found.name,
      provider: providerName,
      scope,
      newRecord: () => newRecord({ mode: config.mode, providerName, model: found.id, modelName: found.name, scope, now: new Date(now()) }),
      run: ({ units, signal, onProgress, reasoningEffort = effort, diagnostics }) =>
        engine.run({ units, model: found.id, provider: providerName, token: session?.token, visitor, signal, onProgress, reasoningEffort, diagnostics }),
      release: () => lease.release(),
      visitor,
    };
  }

  function sweepProgress() {
    const t = now();
    for (const [ticket, row] of progress) if (t - row.at > ticketTtlMs) progress.delete(ticket);
  }

  return {
    status,
    models,
    authorize,
    /** Remember how far a visitor's build is, under their build ticket, so the wizard can show "12 of 40 passages". */
    setProgress(visitor, ticket, value) {
      if (!ticket) return;
      sweepProgress();
      progress.set(ticket, { visitor, at: now(), ...value });
    },
    getProgress(visitor, ticket) {
      const row = progress.get(ticket);
      if (!row || row.visitor !== visitor) return null;
      const { done = 0, total = 0, stage = "ai", finished = false, prompts = 0 } = row;
      return { done, total, stage, finished, prompts };
    },
    clearProgress(ticket) {
      progress.delete(ticket);
    },
    async stop() {
      await backend.stop?.();
    },
    visitorKey,
  };
}
