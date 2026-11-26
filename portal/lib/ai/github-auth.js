/**
 * AI writing, per-user mode: sign in with the visitor's own GitHub account.
 *
 * A GitHub App (client id and secret from the environment) is used with the web application flow, which GitHub documents
 * for a server that has a browser in front of it: the visitor is sent to GitHub, approves, and GitHub sends them back to
 * /api/ai/auth/callback with a one-time code that the server swaps for a user token. The flow uses `state` and PKCE.
 *
 * The user token stays on the server, in memory, under a random session id that is the only thing in the visitor's cookie.
 * It is never put in a cookie, a log, a manifest or a response, and it is used for one thing: the per-session token the SDK
 * is given when that visitor asks for AI writing. A token is never used for any other visitor. Nothing here touches the
 * owner's own account or quota.
 */

import { createHash, randomBytes } from "node:crypto";

const COOKIE_NAME = "ai_sid";
const PENDING_TTL_MS = 10 * 60 * 1000;

function base64Url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Read one cookie from a request without a parser. */
export function readCookie(req, name) {
  const header = String(req?.headers?.cookie || "");
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return "";
}

export function sessionCookieName() {
  return COOKIE_NAME;
}

/** The Set-Cookie value for a session id: HttpOnly, SameSite=Lax, and Secure when the request is HTTPS. */
export function sessionCookie(sid, { secure, maxAgeSec }) {
  return `${COOKIE_NAME}=${encodeURIComponent(sid)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? "; Secure" : ""}`;
}

export function clearedSessionCookie({ secure }) {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

/**
 * @param {object} options
 * @param {ReturnType<import("./config.js").readAiConfig>} options.config
 * @param {typeof fetch} [options.fetchImpl] tests pass a fake GitHub here
 * @param {{web?: string, api?: string}} [options.hosts]
 */
export function createGithubAuth({ config, fetchImpl = globalThis.fetch, hosts = {}, now = Date.now } = {}) {
  const web = hosts.web || "https://github.com";
  const api = hosts.api || "https://api.github.com";
  /** @type {Map<string, {token: string, refreshToken: string|null, expiresAt: number|null, login: string|null, createdAt: number}>} */
  const sessions = new Map();
  /** @type {Map<string, {verifier: string, sid: string, createdAt: number}>} */
  const pending = new Map();

  const redirectUri = () => `${config.github.publicUrl}/api/ai/auth/callback`;

  function sweep() {
    const t = now();
    for (const [state, row] of pending) if (t - row.createdAt > PENDING_TTL_MS) pending.delete(state);
    for (const [sid, row] of sessions) if (t - row.createdAt > config.sessionTtlMs) sessions.delete(sid);
  }

  async function postForm(url, body) {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", "user-agent": "agentic-lab-portal" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`GitHub answered ${response.status}.`);
    return response.json();
  }

  async function fetchLogin(token) {
    try {
      const response = await fetchImpl(`${api}/user`, { headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "agentic-lab-portal" } });
      if (!response.ok) return null;
      const data = await response.json();
      return typeof data?.login === "string" ? data.login.slice(0, 40) : null;
    } catch {
      return null;
    }
  }

  return {
    /** True when a GitHub App is configured. */
    configured() {
      return Boolean(config.github.clientId && config.github.clientSecret && config.github.publicUrl);
    },

    /** Begin sign-in: returns the GitHub address to send the visitor to, and the session id for their cookie. */
    start({ sid } = {}) {
      sweep();
      const sessionId = sid || base64Url(randomBytes(24));
      const state = base64Url(randomBytes(24));
      const verifier = base64Url(randomBytes(32));
      pending.set(state, { verifier, sid: sessionId, createdAt: now() });
      const params = new URLSearchParams({
        client_id: config.github.clientId,
        redirect_uri: redirectUri(),
        state,
        code_challenge: base64Url(createHash("sha256").update(verifier).digest()),
        code_challenge_method: "S256",
      });
      return { url: `${web}/login/oauth/authorize?${params}`, sid: sessionId };
    },

    /**
     * Finish sign-in from the callback. The state must be one this server issued, and the browser's cookie must match the
     * session id the sign-in began with.
     * @returns {Promise<{ok: true, sid: string} | {ok: false, message: string}>}
     */
    async finish({ code, state, sid }) {
      sweep();
      const row = pending.get(String(state || ""));
      pending.delete(String(state || ""));
      if (!row || !sid || row.sid !== sid || !code) return { ok: false, message: "The sign-in did not start here, or it took too long. Start again." };
      let data;
      try {
        data = await postForm(`${web}/login/oauth/access_token`, {
          client_id: config.github.clientId,
          client_secret: config.github.clientSecret,
          code: String(code),
          redirect_uri: redirectUri(),
          code_verifier: row.verifier,
        });
      } catch {
        return { ok: false, message: "GitHub could not complete the sign-in. Try again." };
      }
      if (!data?.access_token || data.error) return { ok: false, message: "GitHub did not approve the sign-in." };
      const expiresIn = Number(data.expires_in);
      sessions.set(row.sid, {
        token: data.access_token,
        refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : null,
        expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? now() + expiresIn * 1000 : null,
        login: await fetchLogin(data.access_token),
        createdAt: now(),
      });
      return { ok: true, sid: row.sid };
    },

    /** The session for a visitor, with its token, or null. Refreshes an expiring token when GitHub gave a refresh token. */
    async session(sid) {
      sweep();
      const row = sid ? sessions.get(sid) : null;
      if (!row) return null;
      if (row.expiresAt && row.expiresAt - now() < 5 * 60 * 1000) {
        if (!row.refreshToken) {
          sessions.delete(sid);
          return null;
        }
        try {
          const data = await postForm(`${web}/login/oauth/access_token`, {
            client_id: config.github.clientId,
            client_secret: config.github.clientSecret,
            grant_type: "refresh_token",
            refresh_token: row.refreshToken,
          });
          if (!data?.access_token || data.error) throw new Error("refresh refused");
          row.token = data.access_token;
          row.refreshToken = typeof data.refresh_token === "string" ? data.refresh_token : row.refreshToken;
          const expiresIn = Number(data.expires_in);
          row.expiresAt = Number.isFinite(expiresIn) && expiresIn > 0 ? now() + expiresIn * 1000 : null;
        } catch {
          sessions.delete(sid);
          return null;
        }
      }
      return { token: row.token, login: row.login };
    },

    signOut(sid) {
      if (sid) sessions.delete(sid);
    },

    /** Counts only, for tests. */
    size() {
      return { sessions: sessions.size, pending: pending.size };
    },
  };
}
