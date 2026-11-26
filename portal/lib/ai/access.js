/**
 * AI writing: who may use it, and from where.
 *
 * The rule behind every mode is the same: a request for AI never runs on the owner's account or quota unless the owner
 * is the one at the keyboard.
 *   - off         nobody.
 *   - local-user  the portal runs on the owner's own PC, bound to loopback, and uses that PC's Copilot sign-in. Only a
 *                 request that really comes from that PC (no proxy, a loopback address, a loopback Host) is accepted.
 *   - per-user    each visitor signs in with their own GitHub account; their token is the only one ever used.
 *   - byok        the server holds a provider key, so it needs real portal sign-in (or a loopback-only portal), never an
 *                 open page.
 */

import { AiError } from "./errors.js";

const LOOPBACK_V4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** True for 127.x.x.x, ::1 and the IPv4-mapped forms. */
export function isLoopbackAddress(address) {
  const value = String(address ?? "").trim().toLowerCase().replace(/^::ffff:/, "");
  return value === "::1" || value === "localhost" || LOOPBACK_V4.test(value);
}

function hostnameOf(hostHeader) {
  const value = String(hostHeader ?? "").trim().toLowerCase();
  if (!value) return "";
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (bracket) return bracket[1];
  return value.replace(/:\d+$/, "");
}

/** True when a Host (or Origin) header names this machine. */
export function isLoopbackHostHeader(hostHeader) {
  const name = hostnameOf(hostHeader);
  return name === "localhost" || name.endsWith(".localhost") || isLoopbackAddress(name);
}

/** True when the server listens only on this machine. */
export function isLoopbackBind(host) {
  return isLoopbackAddress(String(host ?? "").trim() || "127.0.0.1");
}

function header(req, name) {
  const raw = typeof req?.get === "function" ? req.get(name) : req?.headers?.[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * True only when the request comes from the machine the portal runs on. It looks at the socket, not at X-Forwarded-For,
 * and refuses anything that passed through a proxy or came from another site in the browser (a web page cannot make the
 * owner's browser spend the owner's Copilot allowance).
 */
export function isLoopbackRequest(req, { bindHost = "127.0.0.1" } = {}) {
  if (!isLoopbackBind(bindHost)) return false;
  if (!isLoopbackAddress(req?.socket?.remoteAddress)) return false;
  for (const name of ["x-forwarded-for", "forwarded", "x-forwarded-host", "x-real-ip"]) {
    if (header(req, name)) return false;
  }
  if (!isLoopbackHostHeader(header(req, "host"))) return false;
  const origin = header(req, "origin");
  if (origin && origin !== "null" && !isLoopbackHostHeader(origin.replace(/^[a-z]+:\/\//i, "").split("/")[0])) return false;
  if (origin === "null") return false;
  const site = String(header(req, "sec-fetch-site") || "").toLowerCase();
  if (site === "cross-site") return false;
  return true;
}

/**
 * Decide whether this request may use AI writing in the configured mode.
 *
 * @returns {{ok: true, mode: string} | {ok: false, code: string, message: string, needsSignIn?: boolean}}
 */
export function decideAccess({ config, req, authEnabled = false, bindHost = "127.0.0.1", session = null }) {
  if (config.mode === "off") return { ok: false, code: "off", message: "AI writing is turned off on this server." };
  if (config.problems.length) return { ok: false, code: "not-configured", message: "AI writing is not set up on this server." };

  if (config.mode === "local-user") {
    if (!isLoopbackRequest(req, { bindHost })) {
      return { ok: false, code: "not-local", message: "AI writing in local mode only works from the PC that runs the portal." };
    }
    return { ok: true, mode: config.mode };
  }

  if (config.mode === "per-user") {
    if (!session?.token) {
      return { ok: false, code: "sign-in-required", message: "Sign in with GitHub to use AI writing.", needsSignIn: true };
    }
    return { ok: true, mode: config.mode };
  }

  if (config.mode === "byok") {
    if (!authEnabled && !isLoopbackRequest(req, { bindHost })) {
      return { ok: false, code: "needs-portal-sign-in", message: "AI writing with this server's own key needs portal sign-in, and sign-in is off here." };
    }
    return { ok: true, mode: config.mode };
  }

  return { ok: false, code: "off", message: "AI writing is turned off on this server." };
}

/** Throw an AiError (with the HTTP status a route should use) unless the access decision is ok. */
export function requireAccess(decision) {
  if (decision.ok) return decision;
  throw new AiError(decision.code, decision.message, decision.needsSignIn ? 401 : 403);
}
