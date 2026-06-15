#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const envPath = join(repoRoot, ".env.local");
const docsPath = "docs/app-registration-setup.md";

const AADSTS_HINTS = {
  AADSTS7000215: "Invalid client secret. Verify AZURE_CLIENT_SECRET matches the SECRET VALUE (not Secret ID) from Azure portal.",
  AADSTS700016: "Application not found in tenant. Verify AZURE_CLIENT_ID and AZURE_TENANT_ID.",
  AADSTS90002: "Tenant not found. Verify AZURE_TENANT_ID is correct.",
  AADSTS50034: "User account doesn't exist in tenant.",
  AADSTS65001: "Admin consent required. Grant admin consent in Azure portal → API permissions.",
};

function printHeader(title) {
  console.log(`\n=== ${title} ===`);
}

function mask(value) {
  if (!value) return "<empty>";
  return "********";
}

function truncateToken(token) {
  if (!token) return "<none>";
  return `${token.slice(0, 12)}...`;
}

function sanitize(value) {
  if (!value) return "";
  let output = String(value);

  const secret = process.env.AZURE_CLIENT_SECRET;
  if (secret) {
    output = output.split(secret).join("[REDACTED_SECRET]");
  }

  output = output.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED_TOKEN]");
  output = output.replace(/(access_token|client_secret|refresh_token|id_token)[\"'=:\s]+[A-Za-z0-9._~+/=-]+/gi, "$1=[REDACTED]");
  return output;
}

function parseArgs(argv) {
  const args = { envUrl: null, verbose: false, help: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--verbose") {
      args.verbose = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--env-url") {
      if (!argv[i + 1] || argv[i + 1].startsWith("--")) {
        throw new Error("--env-url requires a value, for example https://yourorg.crm.dynamics.com");
      }
      args.envUrl = argv[i + 1];
      i += 1;
    } else if (arg.startsWith("--env-url=")) {
      args.envUrl = arg.slice("--env-url=".length);
      if (!args.envUrl) {
        throw new Error("--env-url requires a value, for example https://yourorg.crm.dynamics.com");
      }
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (args.envUrl) {
    args.envUrl = args.envUrl.trim().replace(/\/+$/, "");
  }

  return args;
}

function printUsage() {
  console.log("Usage: node scripts/verify-app-reg.js [--env-url https://yourorg.crm.dynamics.com] [--verbose]");
}

function parseDotenv(text) {
  const parsed = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;

    let value = match[2] ?? "";
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      const hashIndex = value.indexOf(" #");
      if (hashIndex >= 0) value = value.slice(0, hashIndex).trimEnd();
    }

    parsed[match[1]] = value;
  }
  return parsed;
}

async function tryLoadDotenvModule() {
  try {
    return await import("dotenv");
  } catch {
    const portalDotenv = join(repoRoot, "portal", "node_modules", "dotenv", "lib", "main.js");
    if (existsSync(portalDotenv)) {
      try {
        return await import(pathToFileURL(portalDotenv).href);
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function loadEnv(verbose) {
  printHeader("Loading .env.local");

  if (!existsSync(envPath)) {
    console.error(`❌ Missing .env.local at repo root: ${envPath}`);
    return false;
  }

  const dotenv = await tryLoadDotenvModule();
  if (dotenv?.config) {
    const result = dotenv.config({ path: envPath, override: false });
    if (result.error) {
      if (verbose) console.error(result.error);
      console.error(`❌ Failed to load .env.local: ${sanitize(result.error.message)}`);
      return false;
    }
    console.log("✅ Loaded .env.local with dotenv");
    return true;
  }

  const parsed = parseDotenv(readFileSync(envPath, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  console.log("✅ Loaded .env.local with built-in parser (dotenv package was not available from repo root)");
  return true;
}

function validateEnv() {
  printHeader("Validating environment variables");

  const guidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const checks = [
    { name: "AZURE_TENANT_ID", validate: (value) => guidPattern.test(value), message: "must be a GUID" },
    { name: "AZURE_CLIENT_ID", validate: (value) => guidPattern.test(value), message: "must be a GUID" },
    { name: "AZURE_CLIENT_SECRET", validate: (value) => value.length > 0, message: "must be non-empty" },
  ];

  let valid = true;
  for (const check of checks) {
    const value = process.env[check.name]?.trim() ?? "";
    if (!value) {
      console.error(`❌ ${check.name} is missing or empty`);
      valid = false;
    } else if (!check.validate(value)) {
      console.error(`❌ ${check.name} is malformed (${check.message})`);
      valid = false;
    } else if (check.name === "AZURE_CLIENT_SECRET") {
      console.log(`✅ ${check.name} present: ${mask(value)}`);
    } else {
      console.log(`✅ ${check.name}: ${value}`);
    }
  }

  return valid;
}

function validateEnvUrl(envUrl) {
  if (!envUrl) return true;

  try {
    const url = new URL(envUrl);
    if (url.protocol !== "https:") {
      console.error("❌ --env-url must use https://");
      return false;
    }
    if (!url.hostname.endsWith(".dynamics.com") && !url.hostname.endsWith(".crm.dynamics.com")) {
      console.log("⚠️ --env-url does not look like a standard Dataverse dynamics.com URL; continuing anyway.");
    }
    return true;
  } catch {
    console.error("❌ --env-url is not a valid URL");
    return false;
  }
}

function aadstsHintFromText(text) {
  const match = String(text).match(/AADSTS\d+/i);
  if (!match) return null;
  const code = match[0].toUpperCase();
  return { code, hint: AADSTS_HINTS[code] ?? "See the Microsoft Entra error details and verify tenant, app, secret, consent, and requested scope." };
}

function excerpt(text, max = 900) {
  const clean = sanitize(text).replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max)}...`;
}

async function acquireToken(scope, verbose) {
  printHeader("Acquiring token");
  console.log(`Scope: ${scope}`);

  const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(process.env.AZURE_TENANT_ID.trim())}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: process.env.AZURE_CLIENT_ID.trim(),
    client_secret: process.env.AZURE_CLIENT_SECRET,
    grant_type: "client_credentials",
    scope,
  });

  let response;
  let responseText;
  try {
    response = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    responseText = await response.text();
  } catch (error) {
    if (verbose) console.error(error);
    throw new Error(`Network error during token request: ${sanitize(error.message)}`);
  }

  let payload = null;
  try {
    payload = responseText ? JSON.parse(responseText) : null;
  } catch {
    // Keep raw text for diagnostics below.
  }

  if (!response.ok) {
    const details = payload?.error_description || payload?.error || responseText || `HTTP ${response.status}`;
    const hint = aadstsHintFromText(details);
    const error = new Error(`Token acquisition failed (${response.status}): ${excerpt(details)}`);
    error.hint = hint;
    error.details = verbose ? responseText : null;
    throw error;
  }

  if (!payload?.access_token) {
    throw new Error("Token acquisition response did not include access_token.");
  }

  console.log(`✅ Token acquired (${payload.token_type || "Bearer"}, ${truncateToken(payload.access_token)})`);
  if (payload.expires_in) console.log(`Expires in: ${payload.expires_in} seconds`);
  return payload.access_token;
}

async function callWhoAmI(envUrl, token, verbose) {
  printHeader("Calling Dataverse WhoAmI");

  const whoamiUrl = `${envUrl}/api/data/v9.2/WhoAmI`;
  console.log(`GET ${whoamiUrl}`);

  let response;
  let responseText;
  try {
    response = await fetch(whoamiUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "OData-MaxVersion": "4.0",
        "OData-Version": "4.0",
      },
    });
    responseText = await response.text();
  } catch (error) {
    if (verbose) console.error(error);
    throw new Error(`Network error calling Dataverse: ${sanitize(error.message)}`);
  }

  let payload = null;
  try {
    payload = responseText ? JSON.parse(responseText) : null;
  } catch {
    // Non-JSON error bodies are handled below.
  }

  if (response.ok) {
    console.log("✅ Dataverse WhoAmI succeeded — application user is provisioned and authorized.");
    console.log(`UserId: ${payload?.UserId ?? "<not returned>"}`);
    console.log(`BusinessUnitId: ${payload?.BusinessUnitId ?? "<not returned>"}`);
    console.log(`OrganizationId: ${payload?.OrganizationId ?? "<not returned>"}`);
    return;
  }

  if (response.status === 401) {
    throw new Error(`Token rejected by Dataverse — likely missing PPAC application user. See ${docsPath} Section 4.`);
  }

  if (response.status === 403) {
    throw new Error("Token accepted but no permissions — application user exists but lacks security role. Assign System Customizer in PPAC.");
  }

  const bodyText = payload?.error?.message || payload?.message || responseText || "<empty body>";
  const hint = aadstsHintFromText(bodyText);
  const error = new Error(`Dataverse WhoAmI failed (${response.status}): ${excerpt(bodyText)}`);
  error.hint = hint;
  error.details = verbose ? responseText : null;
  throw error;
}

function reportError(error, verbose) {
  console.error(`❌ ${sanitize(error.message)}`);
  if (error.hint) {
    console.error(`   ${error.hint.code}: ${error.hint.hint}`);
  }
  if (verbose && error.details) {
    console.error("\nVerbose details:");
    console.error(sanitize(error.details));
  }
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`❌ ${error.message}`);
    printUsage();
    return 1;
  }

  if (args.help) {
    printUsage();
    return 0;
  }

  console.log("CopilotStudioLabs App Registration Verification");

  if (!(await loadEnv(args.verbose))) return 1;
  if (!validateEnv()) return 1;
  if (!validateEnvUrl(args.envUrl)) return 1;

  const scope = args.envUrl ? `${args.envUrl}/.default` : "https://service.flow.microsoft.com/.default";

  try {
    const token = await acquireToken(scope, args.verbose);

    if (!args.envUrl) {
      printHeader("Dataverse validation skipped");
      console.log("⚠️ No --env-url provided. Token acquisition for Power Platform succeeded, but Dataverse WhoAmI was not checked.");
      console.log("   Re-run with: node scripts/verify-app-reg.js --env-url https://yourorg.crm.dynamics.com");
      return 0;
    }

    await callWhoAmI(args.envUrl, token, args.verbose);
    printHeader("Result");
    console.log("✅ Full validation succeeded.");
    return 0;
  } catch (error) {
    reportError(error, args.verbose);
    if (!args.verbose) {
      console.error("   Re-run with --verbose for sanitized response details.");
    }
    return 1;
  }
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    console.error(`❌ Unexpected failure: ${sanitize(error.message)}`);
    console.error("   Re-run with --verbose for more detail.");
    process.exitCode = 1;
  });
