// Telling a sign-in page from the product, from an address alone. It lives in its own module so the navigation code
// (lifecycle.mjs) and the sign-in gate (auth.mjs) can both ask the same question without importing each other.
// Only the host and path are looked at: a query string can carry anything.

import { isSignInUrl } from "./image-verify.mjs";

// Where companies that sign in with their own identity provider (AD FS, SAML, WS-Federation) and the device-code
// pages send people.
const FEDERATED_PATH_RE = /^\/(?:adfs\/(?:ls|oauth2)|saml2?(?:\/|$)|wsfed(?:\/|$)|login\.srf$|ppsecure\/|devicelogin(?:\/|$)|common\/oauth2\/deviceauth)/i;

/**
 * What an address is, from its host and path only. The query string is ignored: a signed-in page can carry a
 * `redirect_uri=https://login.microsoftonline.com/...` parameter without being a sign-in page.
 *
 * kind: "sign-in" (Microsoft or a company identity provider: password, MFA, "Stay signed in?", account picker,
 * consent), "app" (anything else on the web), "blank" (nothing loaded yet), "error" (the browser's error page).
 */
export function classifyUrl(rawUrl) {
  const value = String(rawUrl ?? "").trim();
  if (!value || /^about:blank/i.test(value)) return { kind: "blank", host: "", path: "", reason: "nothing loaded yet" };
  if (/^chrome-error:/i.test(value)) return { kind: "error", host: "", path: "", reason: "the browser could not load the page" };
  let url;
  try {
    url = new URL(value);
  } catch {
    return { kind: "blank", host: "", path: "", reason: "not an address" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { kind: "blank", host: "", path: "", reason: `scheme ${url.protocol}` };
  const host = url.hostname.toLowerCase();
  const pathname = url.pathname || "/";
  const hostOnly = `${url.protocol}//${url.host}${pathname}`;
  if (isSignInUrl(hostOnly)) {
    const byPath = /\/oauth2\/(?:v2\.0\/)?authorize/i.test(pathname) && !isSignInUrl(`${url.protocol}//${url.host}/`);
    return { kind: "sign-in", host, path: pathname, reason: byPath ? `path=${pathname}` : `host=${host}` };
  }
  if (FEDERATED_PATH_RE.test(pathname)) return { kind: "sign-in", host, path: pathname, reason: `identity provider path=${pathname}` };
  return { kind: "app", host, path: pathname, reason: "not a sign-in host or path" };
}

/** One path segment with anything that names a person, a tenant, or an object replaced. */
export function cleanPathSegment(part) {
  const value = String(part ?? "");
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) || /^[0-9a-f]{20,}$/i.test(value) || /@/.test(value)) return "{id}";
  // A tenant's domain name in a sign-in path (for example /contoso.onmicrosoft.com/oauth2/authorize).
  if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|edu|gov|io|us|uk|de|fr|cn|jp|in|au|ca)$/i.test(value)) return "{id}";
  return value.slice(0, 60);
}

/** The host with a tenant's own name hidden (contoso.sharepoint.com becomes {tenant}.sharepoint.com). */
export function maskTenantHost(host) {
  return String(host ?? "")
    .toLowerCase()
    .replace(/^[^.]+?(-admin|-my)?(\.sharepoint(?:-df)?\.com)$/, "{tenant}$1$2")
    .replace(/^[^.]+(\.onmicrosoft\.com)$/, "{tenant}$1")
    .replace(/^[^.]+(\.crm\d*\.dynamics\.com)$/, "{org}$1")
    .replace(/^[^.]*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[^.]*(?=\.)/i, "{id}");
}

/** A path with ids and tenant names hidden, no query string. */
export function cleanPathForReport(rawPath) {
  return String(rawPath ?? "")
    .split("/")
    .map(cleanPathSegment)
    .join("/")
    .slice(0, 120);
}

/** An address with nothing private in it: host and path, no query string, and ids replaced. For logs and traces. */
export function redactedAddress(rawUrl) {
  const info = classifyUrl(rawUrl);
  if (!info.host) return info.kind === "blank" ? "(blank)" : `(${info.kind})`;
  return `${info.host}${cleanPathForReport(info.path)}`;
}

/** The page's address, or an empty string when the driver cannot say. */
export function currentAddress(page) {
  try {
    return typeof page?.url === "function" ? String(page.url() || "") : "";
  } catch {
    return "";
  }
}

/** True while the page is on a sign-in host or path: the moment the companion must only watch. */
export function isOnSignIn(page) {
  return classifyUrl(currentAddress(page)).kind === "sign-in";
}
