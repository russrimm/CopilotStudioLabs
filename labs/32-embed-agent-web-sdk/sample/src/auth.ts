// src/auth.ts
import {
  PublicClientApplication,
  type AccountInfo,
  InteractionRequiredAuthError,
} from "@azure/msal-browser";
import { authConfig } from "./config";

const msalConfig = {
  auth: {
    clientId: authConfig.clientId,
    authority: `https://login.microsoftonline.com/${authConfig.tenantId}`,
    redirectUri: authConfig.redirectUri,
  },
  cache: {
    cacheLocation: "sessionStorage" as const,
  },
};

export const msalInstance = new PublicClientApplication(msalConfig);

let initialized = false;

export async function initAuth() {
  if (initialized) return;
  await msalInstance.initialize();
  await msalInstance.handleRedirectPromise();
  initialized = true;
}

export function getAccount(): AccountInfo | null {
  const accounts = msalInstance.getAllAccounts();
  return accounts[0] ?? null;
}

export async function signIn(): Promise<AccountInfo> {
  const result = await msalInstance.loginPopup({
    scopes: authConfig.scopes,
  });
  return result.account;
}

export async function signOut() {
  const account = getAccount();
  if (account) {
    await msalInstance.logoutPopup({ account });
  }
}

export async function getAccessToken(): Promise<string> {
  const account = getAccount();
  if (!account) throw new Error("Not signed in");

  try {
    const result = await msalInstance.acquireTokenSilent({
      scopes: authConfig.scopes,
      account,
    });
    return result.accessToken;
  } catch (err) {
    if (err instanceof InteractionRequiredAuthError) {
      const result = await msalInstance.acquireTokenPopup({
        scopes: authConfig.scopes,
        account,
      });
      return result.accessToken;
    }
    throw err;
  }
}
