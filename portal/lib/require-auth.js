/**
 * Entra ID (Azure AD) bearer-token authentication middleware.
 *
 * Validates a JWT in the `Authorization: Bearer <token>` header against the
 * tenant's JWKS endpoint. Rejects requests with 401 when no token is present
 * and 403 when the token is present but invalid, expired, or the caller is
 * not on the optional user/group allowlist.
 *
 * Configuration (env vars):
 *   AZURE_TENANT_ID          — required. Tenant to validate tokens for.
 *   PORTAL_API_AUDIENCE      — required. Expected `aud` claim.
 *                              Typically `api://<app-id>` or the app's client id.
 *                              Falls back to AZURE_CLIENT_ID if unset.
 *   PORTAL_ALLOWED_USERS     — optional. Comma-separated UPNs allowed to call.
 *   PORTAL_ALLOWED_GROUPS    — optional. Comma-separated group object IDs allowed.
 *   PORTAL_AUTH_DISABLED     — optional. Set to "true" to bypass auth entirely.
 *                              Only intended for local development; logs a loud
 *                              warning at startup.
 */

import { createRemoteJWKSet, jwtVerify } from "jose";

const AUTH_DISABLED = String(process.env.PORTAL_AUTH_DISABLED || "").toLowerCase() === "true";
const TENANT_ID = process.env.AZURE_TENANT_ID || process.env.PP_TENANT_ID;
const AUDIENCE = process.env.PORTAL_API_AUDIENCE || process.env.AZURE_CLIENT_ID || process.env.PP_CLIENT_ID;

const ALLOWED_USERS = new Set(
  (process.env.PORTAL_ALLOWED_USERS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);
const ALLOWED_GROUPS = new Set(
  (process.env.PORTAL_ALLOWED_GROUPS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

let jwks = null;
function getJwks() {
  if (jwks) return jwks;
  if (!TENANT_ID) {
    throw new Error("AZURE_TENANT_ID is required to validate portal API tokens.");
  }
  jwks = createRemoteJWKSet(
    new URL(`https://login.microsoftonline.com/${encodeURIComponent(TENANT_ID)}/discovery/v2.0/keys`),
  );
  return jwks;
}

function expectedIssuers() {
  return [
    `https://login.microsoftonline.com/${TENANT_ID}/v2.0`,
    `https://sts.windows.net/${TENANT_ID}/`,
  ];
}

/**
 * Route paths (prefixes) that MUST remain unauthenticated because they
 * carry their own capability token (e.g. approval callback links delivered
 * out-of-band by email).
 */
const AUTH_EXEMPT_PREFIXES = [
  "/api/pp/approval-callback",
];

function isExempt(path) {
  return AUTH_EXEMPT_PREFIXES.some((p) => path === p || path.startsWith(p + "?") || path.startsWith(p + "/"));
}

export function authConfigSummary() {
  return {
    enabled: !AUTH_DISABLED,
    tenantConfigured: !!TENANT_ID,
    audienceConfigured: !!AUDIENCE,
    userAllowlistSize: ALLOWED_USERS.size,
    groupAllowlistSize: ALLOWED_GROUPS.size,
  };
}

export function requireAuth() {
  if (AUTH_DISABLED) {
    console.warn(
      "⚠️  PORTAL_AUTH_DISABLED=true — API auth middleware is OFF. " +
      "This must NEVER be used outside local development.",
    );
    return (_req, _res, next) => next();
  }

  if (!TENANT_ID || !AUDIENCE) {
    // Fail closed: refuse every /api/* request if we can't validate tokens.
    console.error(
      "❌ Portal auth misconfigured: AZURE_TENANT_ID and PORTAL_API_AUDIENCE " +
      "(or AZURE_CLIENT_ID) are required. All /api/* requests will be rejected.",
    );
    return (req, res, next) => {
      if (isExempt(req.path)) return next();
      res.status(500).json({ error: "Portal authentication is not configured on the server." });
    };
  }

  const issuers = expectedIssuers();
  const jwkSet = getJwks();

  return async (req, res, next) => {
    if (isExempt(req.path)) return next();

    const header = req.headers.authorization || "";
    const [scheme, token] = header.split(" ");
    if (!token || !/^Bearer$/i.test(scheme)) {
      res.set("WWW-Authenticate", `Bearer realm="portal", error="invalid_request"`);
      return res.status(401).json({ error: "Missing bearer token" });
    }

    try {
      const { payload } = await jwtVerify(token, jwkSet, {
        audience: AUDIENCE,
        issuer: issuers,
      });

      // Optional allowlists
      if (ALLOWED_USERS.size > 0) {
        const upn = String(payload.preferred_username || payload.upn || payload.email || "").toLowerCase();
        if (!upn || !ALLOWED_USERS.has(upn)) {
          return res.status(403).json({ error: "User is not authorized to use this portal." });
        }
      }
      if (ALLOWED_GROUPS.size > 0) {
        const groups = Array.isArray(payload.groups) ? payload.groups : [];
        if (!groups.some((g) => ALLOWED_GROUPS.has(String(g)))) {
          return res.status(403).json({ error: "User is not in an authorized group." });
        }
      }

      req.user = {
        oid: payload.oid,
        tid: payload.tid,
        upn: payload.preferred_username || payload.upn || payload.email || null,
        name: payload.name || null,
      };
      next();
    } catch (err) {
      res.set("WWW-Authenticate", `Bearer realm="portal", error="invalid_token"`);
      return res.status(401).json({ error: `Invalid bearer token: ${err.message}` });
    }
  };
}
