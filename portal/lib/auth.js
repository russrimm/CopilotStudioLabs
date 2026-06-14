/**
 * Delegated (user) authentication via MSAL device code flow.
 *
 * Uses interactive device code flow so the portal can act on behalf of the
 * signed-in user with their delegated permissions — no admin consent or
 * client secret required for Power Platform API access.
 *
 * Tokens are cached in-memory per session and auto-refreshed.
 */

import * as msal from "@azure/msal-node";

// Token cache — keyed by scope set
const tokenCache = new Map();

let msalApp = null;

function getApp() {
  if (msalApp) return msalApp;

  const clientId = process.env.AZURE_CLIENT_ID || process.env.PP_CLIENT_ID;
  const tenantId = process.env.AZURE_TENANT_ID || process.env.PP_TENANT_ID;

  if (!clientId || !tenantId) {
    throw new Error("AZURE_CLIENT_ID and AZURE_TENANT_ID are required for delegated auth.");
  }

  msalApp = new msal.PublicClientApplication({
    auth: {
      clientId,
      authority: `https://login.microsoftonline.com/${tenantId}`,
    },
    cache: {
      cachePlugin: undefined, // in-memory only
    },
  });

  return msalApp;
}

/**
 * Acquire a token using device code flow (user-delegated).
 *
 * @param {string[]} scopes - OAuth2 scopes to request
 * @param {Function} [onDeviceCode] - Callback receiving the device code message
 * @returns {Promise<string>} Access token
 */
export async function acquireTokenDeviceCode(scopes, onDeviceCode) {
  const app = getApp();
  const cacheKey = scopes.sort().join("|");

  // Try silent first (cached token)
  const accounts = await app.getTokenCache().getAllAccounts();
  if (accounts.length > 0) {
    try {
      const silentResult = await app.acquireTokenSilent({
        account: accounts[0],
        scopes,
      });
      if (silentResult?.accessToken) {
        tokenCache.set(cacheKey, silentResult);
        return silentResult.accessToken;
      }
    } catch {
      // Silent failed — fall through to device code
    }
  }

  // Device code flow
  const result = await app.acquireTokenByDeviceCode({
    scopes,
    deviceCodeCallback: (response) => {
      if (onDeviceCode) {
        onDeviceCode(response);
      } else {
        console.log(`\n🔐 ${response.message}\n`);
      }
    },
  });

  if (!result?.accessToken) {
    throw new Error("Device code authentication failed — no token received.");
  }

  tokenCache.set(cacheKey, result);
  return result.accessToken;
}

/**
 * Get the currently signed-in user info from cached tokens.
 */
export async function getCurrentUser() {
  try {
    const app = getApp();
    const accounts = await app.getTokenCache().getAllAccounts();
    if (accounts.length === 0) return null;
    const account = accounts[0];
    return {
      username: account.username,
      name: account.name,
      tenantId: account.tenantId,
      homeAccountId: account.homeAccountId,
    };
  } catch {
    return null;
  }
}

/**
 * Check if we have a cached token for the given scopes.
 */
export function hasToken(scopes) {
  const cacheKey = scopes.sort().join("|");
  return tokenCache.has(cacheKey);
}

/**
 * Clear all cached tokens (sign out).
 */
export async function clearTokens() {
  const app = getApp();
  const accounts = await app.getTokenCache().getAllAccounts();
  for (const account of accounts) {
    await app.getTokenCache().removeAccount(account);
  }
  tokenCache.clear();
}

// Commonly-used scope sets
export const SCOPES = {
  POWER_PLATFORM: ["https://api.powerplatform.com/.default"],
  BAP: ["https://service.powerapps.com/.default"],
  GRAPH: ["https://graph.microsoft.com/.default"],
  DYNAMICS: ["https://globaldisco.crm.dynamics.com/.default"],
};
