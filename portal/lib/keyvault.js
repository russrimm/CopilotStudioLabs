/**
 * Azure Key Vault integration for secret management.
 *
 * In production, secrets should be stored in Azure Key Vault and accessed
 * via Managed Identity — never in .env files on deployed infrastructure.
 *
 * This module provides:
 *   1. Key Vault client for reading secrets at runtime
 *   2. A helper to populate process.env from Key Vault on startup
 *   3. Utilities to provision Key Vault and store secrets
 *
 * Configuration:
 *   AZURE_KEYVAULT_URL — e.g., https://copilot-labs-kv.vault.azure.net
 *   Authentication — Managed Identity (preferred) or AZURE_CLIENT_ID + AZURE_CLIENT_SECRET
 */

import { execSync } from "child_process";

const VAULT_URL = process.env.AZURE_KEYVAULT_URL;

// Map of env var names to Key Vault secret names
const SECRET_MAP = {
  AZURE_CLIENT_SECRET: "azure-client-secret",
  SMTP_PASS: "smtp-password",
};

/**
 * Load secrets from Azure Key Vault into process.env.
 * Call this at startup before any other module reads env vars.
 *
 * Falls back silently if Key Vault is not configured (local dev uses .env).
 */
export async function loadSecretsFromKeyVault() {
  if (!VAULT_URL) {
    console.log("ℹ️  Key Vault not configured (AZURE_KEYVAULT_URL not set) — using .env for secrets");
    return { loaded: 0, source: "env" };
  }

  console.log(`🔐 Loading secrets from Key Vault: ${VAULT_URL}`);
  let loaded = 0;

  for (const [envVar, secretName] of Object.entries(SECRET_MAP)) {
    // Skip if already set (explicit env var takes precedence)
    if (process.env[envVar]) continue;

    try {
      const value = await getSecret(secretName);
      if (value) {
        process.env[envVar] = value;
        loaded++;
        console.log(`   ✅ ${envVar} loaded from Key Vault`);
      }
    } catch (err) {
      console.warn(`   ⚠️  Failed to load ${secretName}: ${err.message}`);
    }
  }

  return { loaded, source: "keyvault", vaultUrl: VAULT_URL };
}

/**
 * Read a single secret from Azure Key Vault via az CLI.
 * Uses Managed Identity when available, falls back to az CLI login.
 */
async function getSecret(secretName) {
  try {
    const result = execSync(
      `az keyvault secret show --vault-name "${extractVaultName()}" --name "${secretName}" --query value -o tsv`,
      { encoding: "utf-8", timeout: 15000, stdio: ["pipe", "pipe", "pipe"] }
    );
    return result.trim();
  } catch {
    return null;
  }
}

/**
 * Store a secret in Azure Key Vault.
 */
export async function setSecret(secretName, value) {
  if (!VAULT_URL) throw new Error("AZURE_KEYVAULT_URL not configured");

  try {
    execSync(
      `az keyvault secret set --vault-name "${extractVaultName()}" --name "${secretName}" --value "${value}" --output none`,
      { encoding: "utf-8", timeout: 15000, stdio: ["pipe", "pipe", "pipe"] }
    );
    return { success: true, secretName };
  } catch (err) {
    throw new Error(`Failed to store secret '${secretName}': ${err.message}`);
  }
}

/**
 * Provision a Key Vault for the lab portal.
 */
export async function provisionKeyVault({ baseName, resourceGroup, location }) {
  const vaultName = `${baseName}-kv`;

  try {
    // Create Key Vault
    execSync(
      `az keyvault create --name "${vaultName}" --resource-group "${resourceGroup}" --location "${location}" --enable-rbac-authorization true --output none`,
      { encoding: "utf-8", timeout: 60000, stdio: ["pipe", "pipe", "pipe"] }
    );

    const vaultUrl = `https://${vaultName}.vault.azure.net`;
    return { success: true, vaultName, vaultUrl };
  } catch (err) {
    throw new Error(`Failed to create Key Vault: ${err.message}`);
  }
}

/**
 * Store all configured secrets into Key Vault from current env vars.
 */
export async function syncSecretsToKeyVault() {
  if (!VAULT_URL) throw new Error("AZURE_KEYVAULT_URL not configured");

  const results = [];
  for (const [envVar, secretName] of Object.entries(SECRET_MAP)) {
    const value = process.env[envVar];
    if (!value) {
      results.push({ envVar, secretName, status: "skipped", reason: "not set" });
      continue;
    }

    try {
      await setSecret(secretName, value);
      results.push({ envVar, secretName, status: "stored" });
    } catch (err) {
      results.push({ envVar, secretName, status: "failed", error: err.message });
    }
  }

  return results;
}

/**
 * Get Key Vault configuration status.
 */
export function getKeyVaultStatus() {
  return {
    configured: !!VAULT_URL,
    vaultUrl: VAULT_URL || null,
    vaultName: VAULT_URL ? extractVaultName() : null,
    secretMap: Object.entries(SECRET_MAP).map(([envVar, secretName]) => ({
      envVar,
      secretName,
      hasEnvValue: !!process.env[envVar],
    })),
  };
}

function extractVaultName() {
  if (!VAULT_URL) return null;
  const match = VAULT_URL.match(/https:\/\/(.+?)\.vault\.azure\.net/);
  return match ? match[1] : VAULT_URL;
}
