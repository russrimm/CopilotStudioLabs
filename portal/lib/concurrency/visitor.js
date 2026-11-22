/**
 * Who is calling, as far as the portal can tell.
 *
 * With sign-in on, the caller is the signed-in person (`req.user`). With sign-in off (the demo default) there is no
 * identity, so the browser sends a random id it made once (the `X-Client-Id` header, kept in localStorage) and the portal
 * keeps that person's drafts and rate limits apart from everyone else's.
 *
 * The client id separates people's work and stops them colliding. It is NOT a security boundary: anyone can send any id,
 * so it never replaces sign-in. The id is validated by shape and hashed before it is used as a folder name or a key, so
 * it can never escape a folder or appear in a log.
 */

import { createHash } from "node:crypto";

export const CLIENT_ID_HEADER = "x-client-id";
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{22,64}$/;

/** The caller's client id when the header is present and well formed, otherwise null. A progress stream (EventSource) cannot send headers, so a GET may carry it as `?cid=`. */
export function readClientId(req) {
  const raw = typeof req?.get === "function" ? req.get(CLIENT_ID_HEADER) : req?.headers?.[CLIENT_ID_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value === "string" && CLIENT_ID_RE.test(value)) return value;
  if (req?.method === "GET" && typeof req.query?.cid === "string" && CLIENT_ID_RE.test(req.query.cid)) return req.query.cid;
  return null;
}

/** A one-way, folder-safe name for a client id: "c-" and 32 hex characters. */
export function clientOwnerKey(clientId) {
  return `c-${createHash("sha256").update(`client:${clientId}`).digest("hex").slice(0, 32)}`;
}

/** The address with any port, IPv6 brackets, and IPv4-mapped prefix removed, so "1.2.3.4:5555" and "1.2.3.4" match. */
export function normalizeAddress(raw) {
  let value = String(raw ?? "").trim().toLowerCase();
  if (!value) return "";
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (bracket) value = bracket[1];
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(value)) value = value.slice(0, value.lastIndexOf(":"));
  return value.replace(/^::ffff:/, "");
}

/** The caller's network address as Express resolved it, normalized. */
export function callerAddress(req) {
  return normalizeAddress(req?.ip || req?.socket?.remoteAddress || "") || "unknown";
}

/** The identity of a signed-in person, as a stable lowercase string, or "". */
export function signedInIdentity(user) {
  if (!user || (!user.oid && !user.upn)) return "";
  return `${String(user.tid || "").toLowerCase()}:${String(user.oid || user.upn).toLowerCase()}`;
}

/**
 * The key one visitor's limits and queue slots are counted under: the signed-in person, else their client id, else their
 * address. A client id is hashed, never used as it is.
 */
export function visitorKey(req) {
  const person = signedInIdentity(req?.user);
  if (person) return `u:${person}`;
  const clientId = readClientId(req);
  if (clientId) return clientOwnerKey(clientId);
  return `ip:${callerAddress(req)}`;
}

/**
 * Wrap a `createRateLimiter` check so that each visitor has their own bucket even when many visitors share one address
 * (an office, a proxy hop that hides the real address), while one address that rotates client ids still cannot exceed
 * `ipMultiplier` times a single visitor's limit.
 *
 * @param {(key: string) => {allowed: boolean, retryAfterSec?: number}} visitorCheck limiter for the visitor bucket
 * @param {(key: string) => {allowed: boolean, retryAfterSec?: number}} [addressCheck] limiter for the address backstop
 */
export function createVisitorCheck(visitorCheck, addressCheck = null) {
  return function check(req) {
    const key = visitorKey(req);
    const own = visitorCheck(key);
    if (!own.allowed) return own;
    if (addressCheck && !key.startsWith("ip:")) {
      const shared = addressCheck(`ip:${callerAddress(req)}`);
      if (!shared.allowed) return shared;
    }
    return { allowed: true };
  };
}
