/**
 * Use Case Builder API.
 *
 *   GET  /api/use-cases/options   the facets, labels, valid ids, and limits
 *   POST /api/use-cases/generate  ranked Copilot Studio and Agent Builder use cases
 *
 * Both routes sit behind the portal's normal sign-in because they are
 * registered after `app.use("/api", requireAuth())`. Requests are validated
 * strictly (allowlisted ids, array caps, a 64 KB body), rate limited per user,
 * and answered with data only: nothing from the request is echoed back except
 * the validated ids, and error messages quote only a short, safe slice of a bad
 * value. The optional AI wording pass has its own tighter limit.
 */

import { detectProvider } from "../lab-builder/llm.js";
import { createRateLimiter, positiveIntFromEnv } from "../rate-limit.js";
import { visitorKey } from "../concurrency/visitor.js";
import { getUseCaseData } from "./data.js";
import { generateUseCases, limits, UseCaseRequestError } from "./generate.js";
import { applyPolish, polishUseCases } from "./polish.js";
import { LEVEL_LABELS } from "../lab-builder/levels.js";

export const USE_CASE_JSON_BODY_LIMIT = "64kb";
export const USE_CASE_JSON_PATHS = Object.freeze(["/api/use-cases"]);
const MAX_BODY_BYTES = 64 * 1024;

function userKey(req) {
  // A signed-in person keeps the key they always had; anyone else is told apart by browser id, then by address.
  const person = req.user?.oid || req.user?.upn;
  return person ? String(person).toLowerCase() : visitorKey(req);
}

/** True (after answering 429) when this user is over the limit. */
function rateLimited(check, req, res, message) {
  const rate = check(userKey(req));
  if (rate.allowed) return false;
  res.setHeader("Retry-After", String(rate.retryAfterSec));
  res.status(429).json({ error: `${message} Try again in ${rate.retryAfterSec}s.` });
  return true;
}

/** What the UI needs to draw its inputs. Plain data: no markup. */
export function buildOptions({ polishAvailable = false } = {}) {
  const data = getUseCaseData();
  return {
    version: 1,
    industries: data.industries.map(({ id, name, description }) => ({ id, name, description })),
    departments: data.departments.map(({ id, name, description }) => ({ id, name, description })),
    goals: data.goals.map(({ id, label, description }) => ({ id, label, description })),
    dataSources: data.dataSources.map(({ id, label, description }) => ({ id, label, description })),
    platforms: data.platforms.map(({ id, label, description }) => ({ id, label, description })),
    levels: [{ value: null, label: "Any", description: "Use cases of every complexity." }].concat(
      Object.entries(LEVEL_LABELS).map(([value, label]) => ({ value: Number(value), label: `${label} (${value})`, description: `Level ${value}` })),
    ),
    efforts: data.efforts.map(({ id, label }) => ({ id, label })),
    defaults: { platform: "both", level: null },
    limits: limits(),
    polish: { available: polishAvailable },
  };
}

/**
 * @param {import("express").Express} app
 * @param {object} [deps]
 * @param {Function} [deps.createLlm]          language model factory (tests inject a fake)
 * @param {object}   [deps.env]                environment for provider detection
 * @param {Function} [deps.rateCheck]          per-user check for generate; defaults to 120 requests a minute
 * @param {Function} [deps.polishRateCheck]    per-user check for the AI wording pass; defaults to 10 every 10 minutes
 */
export function registerUseCaseRoutes(app, deps = {}) {
  const env = deps.env || process.env;
  const rateCheck =
    deps.rateCheck ||
    createRateLimiter({
      windowMs: positiveIntFromEnv(env.USE_CASE_RATE_WINDOW_MS, 60_000),
      max: positiveIntFromEnv(env.USE_CASE_RATE_MAX, 120),
    });
  const polishRateCheck =
    deps.polishRateCheck ||
    createRateLimiter({
      windowMs: positiveIntFromEnv(env.USE_CASE_POLISH_RATE_WINDOW_MS, 600_000),
      max: positiveIntFromEnv(env.USE_CASE_POLISH_RATE_MAX, 10),
    });

  app.get("/api/use-cases/options", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(buildOptions({ polishAvailable: deps.createLlm ? deps.createLlm(env).available : detectProvider(env).kind !== "none" }));
  });

  app.post("/api/use-cases/generate", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (rateLimited(rateCheck, req, res, "Too many use case requests.")) return;
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return res.status(413).json({ error: "Request body is too large." });
    }
    try {
      let response = generateUseCases(req.body);
      if (response.query.polish) {
        if (rateLimited(polishRateCheck, req, res, "Too many AI wording requests.")) return;
        const result = await polishUseCases(response.useCases, { createLlm: deps.createLlm, env });
        response = applyPolish(response, result);
      }
      return res.json(response);
    } catch (err) {
      if (err instanceof UseCaseRequestError) return res.status(err.status).json({ error: err.message });
      console.error("use-cases: generation failed:", err?.message || err);
      return res.status(500).json({ error: "Could not generate use cases." });
    }
  });
}
