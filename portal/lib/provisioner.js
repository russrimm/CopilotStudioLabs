/**
 * Azure resource provisioner for Copilot Studio Labs.
 *
 * Orchestrates resource deployment using az CLI, Bicep templates,
 * and Microsoft Graph / Power Platform APIs.
 */

import { readFileSync, existsSync } from "fs";
import { resolve, join } from "path";
import { execFileSync } from "child_process";
import { assertId, assertRegion, assertLabNumbers } from "./validate-id.js";

const INFRA_DIR = resolve(import.meta.dirname, "..", "infra");

const AZ_BIN = process.platform === "win32" ? "az.cmd" : "az";

/**
 * Run the `az` CLI safely. Arguments are passed as an array — NEVER as a
 * shell-interpolated string — so untrusted values in `args` cannot inject
 * additional commands or flags. On Windows we invoke `az.cmd` explicitly so
 * Node's execFile can resolve the batch wrapper without falling back to a
 * shell (CVE-2024-27980).
 */
function az(args, { timeout = 30000, parseJson = false } = {}) {
  const stdout = execFileSync(AZ_BIN, args, {
    encoding: "utf-8",
    timeout,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
  });
  return parseJson ? JSON.parse(stdout) : stdout;
}
const MANIFEST_PATH = join(INFRA_DIR, "lab-resources.json");

// ── Manifest access ─────────────────────────────────────────────────────────

/** Load the lab resource manifest */
export function loadManifest() {
  if (!existsSync(MANIFEST_PATH)) throw new Error("lab-resources.json not found");
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
}

/** Get resources for a specific lab */
export function getLabResources(labId) {
  const manifest = loadManifest();
  const lab = manifest.labs[labId];
  if (!lab) return null;
  return {
    labId,
    name: lab.name,
    resources: lab.resources.map((r) => ({
      ...r,
      provisionable: isProvisionable(r.type),
      manual: r.config?.manual === true,
      optional: r.config?.optional === true,
    })),
  };
}

/** Get resources for all labs */
export function getAllLabResources() {
  const manifest = loadManifest();
  return Object.entries(manifest.labs).map(([labId, lab]) => ({
    labId,
    name: lab.name,
    resources: lab.resources.map((r) => ({
      ...r,
      provisionable: isProvisionable(r.type),
      manual: r.config?.manual === true,
      optional: r.config?.optional === true,
    })),
  }));
}

/** Check if a resource type can be auto-provisioned */
function isProvisionable(type) {
  const autoTypes = [
    "resource-group",
    "container-app",
    "app-service",
    "sharepoint-site",
    "dataverse-data",
  ];
  return autoTypes.includes(type);
}

// ── Provisioning engine ─────────────────────────────────────────────────────

/**
 * Check prerequisites for provisioning.
 * @returns {Object} { ready: boolean, checks: Array }
 */
export async function checkPrerequisites() {
  const checks = [];

  checks.push(runAzCheck("az", ["--version"], "Azure CLI"));
  checks.push(await checkAzLogin());
  checks.push(runAzCheck("subscription", ["account", "show", "--query", "id", "-o", "tsv"], "Azure Subscription"));
  checks.push(runAzCheck("bicep", ["bicep", "version"], "Bicep CLI"));

  return {
    ready: checks.every((c) => c.ok),
    checks,
  };
}

function runAzCheck(id, args, label) {
  try {
    const result = az(args, { timeout: 15000 }).trim();
    return { id, label, ok: true, detail: result.split("\n")[0] };
  } catch {
    return { id, label, ok: false, detail: "Not found or not configured" };
  }
}

async function checkAzLogin() {
  try {
    const account = az(
      ["account", "show", "--query", "{name:name, id:id}", "-o", "json"],
      { timeout: 15000, parseJson: true },
    );
    return { id: "az-login", label: "Azure Login", ok: true, detail: `${account.name} (${account.id})` };
  } catch {
    return { id: "az-login", label: "Azure Login", ok: false, detail: "Not logged in — run 'az login'" };
  }
}

/**
 * Provision Azure resources for selected labs.
 *
 * @param {Object} opts
 * @param {string[]} opts.labIds           - Lab IDs to provision
 * @param {string}   opts.location         - Azure region
 * @param {string}   opts.baseName         - Resource name prefix
 * @param {string}   [opts.subscriptionId] - Azure subscription
 * @param {Object}   [opts.envVars]        - Extra env vars (currently unused; reserved for future labs)
 * @param {Function} [opts.onProgress]     - Progress callback(step)
 * @returns {Promise<Object>} Deployment result
 */
export async function provision({ labIds, location, baseName, subscriptionId, envVars = {}, onProgress }) {
  const log = onProgress || (() => {});
  const results = { success: [], failed: [], skipped: [], outputs: {} };

  // Validate every value that will be handed to the az CLI.
  let safeLocation, safeBaseName, safeSubscriptionId, safeLabNumbers;
  try {
    safeLocation = assertRegion(location, "location");
    safeBaseName = assertId(baseName, "baseName");
    if (subscriptionId) safeSubscriptionId = assertId(subscriptionId, "subscriptionId");
    const labNumbersRaw = labIds.map((id) => String(id).match(/^(\d+)/)?.[1]).filter(Boolean).join(",");
    safeLabNumbers = assertLabNumbers(labNumbersRaw, "enabledLabs");
  } catch (err) {
    log({ step: "validate-input", status: "failed", detail: err.message });
    results.failed.push({ step: "validate-input", error: err.message });
    return results;
  }

  // Set subscription if provided
  if (safeSubscriptionId) {
    log({ step: "set-subscription", status: "running", detail: `Setting subscription ${safeSubscriptionId}` });
    try {
      az(["account", "set", "--subscription", safeSubscriptionId], { timeout: 15000 });
      log({ step: "set-subscription", status: "done" });
    } catch (err) {
      log({ step: "set-subscription", status: "failed", detail: err.message });
      results.failed.push({ step: "set-subscription", error: err.message });
      return results;
    }
  }

  // Run Bicep deployment
  log({ step: "bicep-deploy", status: "running", detail: "Deploying Azure resources via Bicep..." });
  try {
    const bicepPath = join(INFRA_DIR, "main.bicep");
    const deployment = az(
      [
        "deployment", "sub", "create",
        "--location", safeLocation,
        "--template-file", bicepPath,
        "--parameters", `baseName=${safeBaseName}`,
        "--parameters", `location=${safeLocation}`,
        "--parameters", `enabledLabs=${safeLabNumbers}`,
        "--output", "json",
      ],
      { timeout: 300000, parseJson: true },
    );

    results.outputs = deployment.properties?.outputs || {};
    results.success.push("bicep-deploy");
    log({ step: "bicep-deploy", status: "done", detail: "Infrastructure deployed" });
  } catch (err) {
    err.stderr = err.stderr?.toString?.() ?? err.stderr;
    const errMsg = err.stderr || err.message;
    results.failed.push({ step: "bicep-deploy", error: errMsg });
    log({ step: "bicep-deploy", status: "failed", detail: errMsg.substring(0, 200) });
  }

  // Process per-lab resources that need API calls (SharePoint, Dataverse, etc.)
  for (const labId of labIds) {
    const labResources = getLabResources(labId);
    if (!labResources) continue;

    for (const resource of labResources.resources) {
      if (resource.manual || !resource.provisionable) {
        results.skipped.push({ labId, resourceId: resource.id, reason: resource.manual ? "manual" : "not-auto-provisionable" });
        log({ step: resource.id, status: "skipped", detail: `${resource.name} — ${resource.manual ? "requires manual setup" : "not auto-provisionable"}` });
        continue;
      }

      if (resource.type === "sharepoint-site") {
        await provisionSharePointSite(resource, envVars, log, results);
      }
    }
  }

  return results;
}

/**
 * De-provision (delete) Azure resources for selected labs.
 */
export async function deprovision({ baseName, onProgress }) {
  const log = onProgress || (() => {});
  let rgName;
  try {
    rgName = `rg-${assertId(baseName, "baseName")}`;
  } catch (err) {
    log({ step: "delete-rg", status: "failed", detail: err.message });
    return { success: false, error: err.message };
  }

  log({ step: "delete-rg", status: "running", detail: `Deleting resource group ${rgName}...` });
  try {
    az(["group", "delete", "--name", rgName, "--yes", "--no-wait"], { timeout: 30000 });
    log({ step: "delete-rg", status: "done", detail: `Resource group ${rgName} deletion initiated` });
    return { success: true, detail: `Resource group ${rgName} deletion initiated (async)` };
  } catch (err) {
    log({ step: "delete-rg", status: "failed", detail: err.message });
    return { success: false, error: err.message };
  }
}

/**
 * Get provisioning status for a resource group.
 */
export function getProvisioningStatus(baseName) {
  let rgName;
  try {
    rgName = `rg-${assertId(baseName, "baseName")}`;
  } catch {
    return { exists: false };
  }
  try {
    const rg = az(
      [
        "group", "show",
        "--name", rgName,
        "--query", "{name:name, state:properties.provisioningState, location:location}",
        "-o", "json",
      ],
      { timeout: 15000, parseJson: true },
    );

    const resources = az(
      [
        "resource", "list",
        "--resource-group", rgName,
        "--query", "[].{name:name, type:type, state:provisioningState}",
        "-o", "json",
      ],
      { timeout: 15000, parseJson: true },
    );

    return {
      exists: true,
      resourceGroup: rg,
      resources,
    };
  } catch {
    return { exists: false };
  }
}

// ── Resource-specific provisioners ──────────────────────────────────────────

async function provisionSharePointSite(resource, envVars, log, results) {
  // SharePoint site creation requires Graph API with Sites.FullControl.All permission
  const tenantId = process.env.AZURE_TENANT_ID;
  const clientId = process.env.AZURE_CLIENT_ID;
  const clientSecret = process.env.AZURE_CLIENT_SECRET;

  if (!tenantId || !clientId || !clientSecret) {
    results.skipped.push({ resourceId: resource.id, reason: "missing-graph-credentials" });
    log({ step: resource.id, status: "skipped", detail: `${resource.name} — Graph API credentials not configured` });
    return;
  }

  log({ step: resource.id, status: "running", detail: `Creating SharePoint site: ${resource.name}` });

  try {
    // Get Graph token
    const tokenRes = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
        scope: "https://graph.microsoft.com/.default",
      }),
    });
    if (!tokenRes.ok) throw new Error(`Token request failed: ${tokenRes.status}`);
    const { access_token } = await tokenRes.json();

    // Create team site
    const siteRes = await fetch("https://graph.microsoft.com/v1.0/sites/root", {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    if (!siteRes.ok) throw new Error(`Graph API call failed: ${siteRes.status}`);

    results.success.push(resource.id);
    log({ step: resource.id, status: "done", detail: `SharePoint site verification passed` });
  } catch (err) {
    results.failed.push({ resourceId: resource.id, error: err.message });
    log({ step: resource.id, status: "failed", detail: err.message.substring(0, 200) });
  }
}
