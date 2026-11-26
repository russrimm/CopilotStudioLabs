/**
 * AI writing routes.
 *
 *   GET  /api/ai/status            what the wizard shows (off, unavailable, sign in, ready)
 *   GET  /api/ai/models            the models this visitor may pick
 *   GET  /api/ai/progress/:ticket  "12 of 40 passages" for a build the visitor started (the build ticket is the key)
 *   POST /api/ai/auth/start        per-user mode: the GitHub address to send the visitor to
 *   GET  /api/ai/auth/callback     per-user mode: where GitHub sends the visitor back (carries its own state, no bearer token)
 *   POST /api/ai/auth/signout      per-user mode: forget the visitor's token
 *
 * No route returns a token, a key, a prompt or a model answer.
 */

import { AiError } from "./errors.js";
import { clearedSessionCookie, readCookie, sessionCookie, sessionCookieName } from "./github-auth.js";

const CALLBACK_PAGE = (message) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>AI writing sign-in</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5"><h1 style="font-size:1.25rem">${message}</h1><p>You can close this window and go back to the portal.</p><p><a href="/">Back to the portal</a></p><script>try{if(window.opener){window.opener.postMessage({type:"ai-auth"},location.origin);window.close()}}catch(e){}</script></body></html>`;

function sendError(res, err) {
  if (err instanceof AiError) return res.status(err.status).json({ error: err.message, code: err.code });
  return res.status(500).json({ error: "AI writing hit a problem. Try again, or build without AI." });
}

export function registerAiRoutes(app, { service, github, config, rateCheck = () => ({ allowed: true }), visitorOf }) {
  const limited = (req, res) => {
    const result = rateCheck(req);
    if (result.allowed) return false;
    res.setHeader("Retry-After", String(result.retryAfterSec));
    res.status(429).json({ error: `Too many AI requests. Try again in ${result.retryAfterSec}s.` });
    return true;
  };
  const secure = (req) => req.secure || String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";

  app.get("/api/ai/status", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (limited(req, res)) return undefined;
    try {
      return res.json(await service.status(req));
    } catch (err) {
      return sendError(res, err);
    }
  });

  app.get("/api/ai/models", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (limited(req, res)) return undefined;
    try {
      return res.json(await service.models(req));
    } catch (err) {
      return sendError(res, err);
    }
  });

  app.get("/api/ai/progress/:ticket", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const found = service.getProgress(visitorOf(req), String(req.params.ticket || ""));
    return res.json(found || { done: 0, total: 0, stage: "none", finished: false, prompts: 0 });
  });

  app.post("/api/ai/auth/start", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (limited(req, res)) return undefined;
    if (config.mode !== "per-user" || !github?.configured() || config.problems.length) {
      return res.status(404).json({ error: "Signing in with GitHub is not turned on here.", code: "not-configured" });
    }
    const started = github.start({ sid: readCookie(req, sessionCookieName()) || undefined });
    res.setHeader("Set-Cookie", sessionCookie(started.sid, { secure: secure(req), maxAgeSec: Math.floor(config.sessionTtlMs / 1000) }));
    return res.json({ url: started.url });
  });

  app.get("/api/ai/auth/callback", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (config.mode !== "per-user" || !github?.configured()) return res.status(404).type("text/plain").send("Not found");
    const code = typeof req.query.code === "string" && req.query.code.length <= 200 ? req.query.code : "";
    const state = typeof req.query.state === "string" && req.query.state.length <= 200 ? req.query.state : "";
    const done = await github.finish({ code, state, sid: readCookie(req, sessionCookieName()) });
    if (!done.ok) return res.status(400).type("html").send(CALLBACK_PAGE(done.message));
    return res.type("html").send(CALLBACK_PAGE("You are signed in with GitHub."));
  });

  app.post("/api/ai/auth/signout", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    github?.signOut(readCookie(req, sessionCookieName()));
    res.setHeader("Set-Cookie", clearedSessionCookie({ secure: secure(req) }));
    return res.json({ signedOut: true });
  });
}
