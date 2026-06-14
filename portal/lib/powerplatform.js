/**
 * Power Platform administration — environment management, Secure Score,
 * and recommendations via api.powerplatform.com and BAP APIs.
 *
 * All calls use delegated (user) permissions via device code auth.
 */

import { acquireTokenDeviceCode, SCOPES } from "./auth.js";

const BAP_BASE = "https://api.bap.microsoft.com";
const PP_BASE = "https://api.powerplatform.com";

// ── Auth state for SSE progress ─────────────────────────────────────────────
let pendingDeviceCode = null;

export function getPendingDeviceCode() {
  const code = pendingDeviceCode;
  pendingDeviceCode = null;
  return code;
}

async function getToken(scopes) {
  return acquireTokenDeviceCode(scopes, (response) => {
    pendingDeviceCode = {
      userCode: response.userCode,
      verificationUri: response.verificationUri,
      message: response.message,
      expiresAt: new Date(Date.now() + (response.expiresInSeconds || 900) * 1000).toISOString(),
    };
    console.log(`\n🔐 ${response.message}\n`);
  });
}

async function ppFetch(url, scopes, options = {}) {
  const token = await getToken(scopes);
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${res.status}: ${body.substring(0, 300)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ── Environment Management ──────────────────────────────────────────────────

/**
 * List all Power Platform environments the user has access to.
 */
export async function listEnvironments() {
  const data = await ppFetch(
    `${BAP_BASE}/providers/Microsoft.BusinessAppPlatform/scopes/admin/environments?api-version=2021-04-01&$expand=properties.capacity,properties/billingPolicy`,
    SCOPES.BAP
  );
  return (data.value || []).map((env) => ({
    id: env.name,
    displayName: env.properties?.displayName || env.name,
    type: env.properties?.environmentType || "Unknown",
    state: env.properties?.states?.management?.id || "Unknown",
    region: env.location || "",
    createdTime: env.properties?.createdTime,
    url: env.properties?.linkedEnvironmentMetadata?.instanceUrl || null,
    domainName: env.properties?.linkedEnvironmentMetadata?.domainName || null,
    securityGroupId: env.properties?.linkedEnvironmentMetadata?.securityGroupId || null,
    version: env.properties?.linkedEnvironmentMetadata?.version || null,
    capacity: env.properties?.capacity || null,
  }));
}

/**
 * Get details of a single environment.
 */
export async function getEnvironment(envId) {
  return ppFetch(
    `${BAP_BASE}/providers/Microsoft.BusinessAppPlatform/scopes/admin/environments/${envId}?api-version=2021-04-01&$expand=properties.capacity`,
    SCOPES.BAP
  );
}

/**
 * Provision a new Power Platform environment.
 */
export async function createEnvironment({ displayName, location = "unitedstates", environmentType = "Sandbox", currency = "USD", language = "1033", securityGroupId = null }) {
  const body = {
    location,
    properties: {
      displayName,
      environmentSku: environmentType,
      linkedEnvironmentMetadata: {
        baseLanguage: parseInt(language, 10),
        currency: { code: currency },
        domainName: displayName.toLowerCase().replace(/[^a-z0-9]/g, ""),
        ...(securityGroupId && { securityGroupId }),
      },
    },
  };

  return ppFetch(
    `${BAP_BASE}/providers/Microsoft.BusinessAppPlatform/environments?api-version=2021-04-01`,
    SCOPES.BAP,
    { method: "POST", body: JSON.stringify(body) }
  );
}

/**
 * Delete a Power Platform environment.
 */
export async function deleteEnvironment(envId) {
  const token = await getToken(SCOPES.BAP);
  const res = await fetch(
    `${BAP_BASE}/providers/Microsoft.BusinessAppPlatform/scopes/admin/environments/${envId}?api-version=2021-04-01`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    }
  );
  if (!res.ok && res.status !== 202) {
    throw new Error(`Delete failed: ${res.status} ${await res.text()}`);
  }
  return { success: true, status: res.status };
}

// ── Secure Score & Recommendations ──────────────────────────────────────────

/**
 * Get the tenant's Power Platform Secure Score.
 */
export async function getSecureScore() {
  try {
    const data = await ppFetch(
      `${PP_BASE}/governance/securityAssessments/score?api-version=2022-03-01-preview`,
      SCOPES.POWER_PLATFORM
    );
    return data;
  } catch (err) {
    // Fallback: try the tenant settings endpoint for security data
    try {
      const settings = await ppFetch(
        `${BAP_BASE}/providers/Microsoft.BusinessAppPlatform/scopes/admin/tenantsettings?api-version=2021-04-01`,
        SCOPES.BAP
      );
      return {
        source: "tenant-settings",
        settings: extractSecuritySettings(settings),
      };
    } catch {
      throw err;
    }
  }
}

/**
 * Get security recommendations with remediation guidance.
 */
export async function getRecommendations() {
  try {
    const data = await ppFetch(
      `${PP_BASE}/governance/securityAssessments/recommendations?api-version=2022-03-01-preview`,
      SCOPES.POWER_PLATFORM
    );
    return data.value || data;
  } catch {
    // Build recommendations from tenant settings analysis
    const settings = await ppFetch(
      `${BAP_BASE}/providers/Microsoft.BusinessAppPlatform/scopes/admin/tenantsettings?api-version=2021-04-01`,
      SCOPES.BAP
    );
    return analyzeSettingsForRecommendations(settings);
  }
}

/**
 * Apply a remediation action for a recommendation.
 */
export async function applyRemediation(recommendationId, action) {
  // Most remediations are tenant setting changes
  const remediationMap = {
    "disable-trial-environments": { disableTrialEnvironmentCreationByNonAdminUsers: true },
    "disable-production-environments": { disableEnvironmentCreationByNonAdminUsers: true },
    "enable-tenant-isolation": { powerPlatform: { governance: { tenantIsolation: { enabled: true } } } },
    "disable-share-with-everyone": { disableShareWithEveryone: true },
    "enable-dlp-enforcement": { powerPlatform: { governance: { policy: { enableDLP: true } } } },
  };

  const patch = remediationMap[recommendationId];
  if (!patch) {
    throw new Error(`Unknown remediation: ${recommendationId}. Manual action may be required.`);
  }

  return ppFetch(
    `${BAP_BASE}/providers/Microsoft.BusinessAppPlatform/scopes/admin/tenantsettings?api-version=2021-04-01`,
    SCOPES.BAP,
    { method: "PATCH", body: JSON.stringify(patch) }
  );
}

/**
 * Get tenant-level settings for the Power Platform.
 */
export async function getTenantSettings() {
  return ppFetch(
    `${BAP_BASE}/providers/Microsoft.BusinessAppPlatform/scopes/admin/tenantsettings?api-version=2021-04-01`,
    SCOPES.BAP
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function extractSecuritySettings(settings) {
  return {
    trialEnvironmentsDisabled: settings?.disableTrialEnvironmentCreationByNonAdminUsers ?? false,
    productionEnvironmentsDisabled: settings?.disableEnvironmentCreationByNonAdminUsers ?? false,
    tenantIsolation: settings?.powerPlatform?.governance?.tenantIsolation?.enabled ?? false,
    shareWithEveryoneDisabled: settings?.disableShareWithEveryone ?? false,
    dlpEnabled: settings?.powerPlatform?.governance?.policy?.enableDLP ?? false,
  };
}

function analyzeSettingsForRecommendations(settings) {
  const recommendations = [];
  const sec = extractSecuritySettings(settings);

  if (!sec.trialEnvironmentsDisabled) {
    recommendations.push({
      id: "disable-trial-environments",
      title: "Restrict trial environment creation",
      severity: "Medium",
      description: "Non-admin users can create trial environments. This may lead to unmanaged environments with production data.",
      remediation: "Disable trial environment creation for non-admin users.",
      canAutoRemediate: true,
    });
  }

  if (!sec.productionEnvironmentsDisabled) {
    recommendations.push({
      id: "disable-production-environments",
      title: "Restrict production environment creation",
      severity: "High",
      description: "Non-admin users can create production environments. This can lead to data sprawl and governance challenges.",
      remediation: "Disable production environment creation for non-admin users.",
      canAutoRemediate: true,
    });
  }

  if (!sec.tenantIsolation) {
    recommendations.push({
      id: "enable-tenant-isolation",
      title: "Enable tenant isolation",
      severity: "High",
      description: "Tenant isolation is not enabled. Cross-tenant connections can access data without restriction.",
      remediation: "Enable tenant isolation to prevent unauthorized cross-tenant data access.",
      canAutoRemediate: true,
    });
  }

  if (!sec.shareWithEveryoneDisabled) {
    recommendations.push({
      id: "disable-share-with-everyone",
      title: "Disable 'Share with Everyone'",
      severity: "Medium",
      description: "Users can share apps and flows with the entire organization, potentially exposing sensitive workflows.",
      remediation: "Disable the 'Share with Everyone' capability.",
      canAutoRemediate: true,
    });
  }

  if (!sec.dlpEnabled) {
    recommendations.push({
      id: "enable-dlp-enforcement",
      title: "Enable DLP policy enforcement",
      severity: "High",
      description: "Data Loss Prevention policies are not enforced. Connectors can move data between business and non-business services freely.",
      remediation: "Enable DLP enforcement and create appropriate policies.",
      canAutoRemediate: true,
    });
  }

  if (recommendations.length === 0) {
    recommendations.push({
      id: "all-clear",
      title: "All security settings are properly configured",
      severity: "Info",
      description: "No critical security recommendations at this time.",
      canAutoRemediate: false,
    });
  }

  return recommendations;
}
