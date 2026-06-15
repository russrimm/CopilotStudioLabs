// ── Main Bicep entry point for lab resource provisioning ──────────────────
// Deploys the Azure resources needed by Copilot Studio Labs.
// Usage: az deployment sub create --location eastus --template-file main.bicep --parameters ...

targetScope = 'subscription'

@description('Base name prefix for all resources')
param baseName string = 'copilot-labs'

@description('Azure region for all resources')
param location string = 'eastus'

@description('Which labs to provision resources for (comma-separated lab numbers)')
param enabledLabs string = '01,04'

@description('Tags applied to all resources')
param tags object = {
  project: 'CopilotStudioLabs'
  managedBy: 'labs-portal'
}

// ── Resource Group ────────────────────────────────────────────────────────
resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: 'rg-${baseName}'
  location: location
  tags: tags
}

// ── Lab 04: Container App for MCP Server ──────────────────────────────────
module mcpServer './modules/container-app.bicep' = if (contains(enabledLabs, '04')) {
  name: 'mcp-server-deploy'
  scope: rg
  params: {
    name: '${baseName}-mcp-weather'
    location: location
    tags: tags
  }
}

// ── Key Vault for secrets management ──────────────────────────────────────
module keyVault './modules/keyvault.bicep' = {
  name: 'keyvault-deploy'
  scope: rg
  params: {
    name: '${baseName}-kv'
    location: location
    tags: tags
    secretsOfficerPrincipalId: portal.outputs.appId
  }
}

// ── Shared: App Service for Portal ────────────────────────────────────────
module portal './modules/app-service.bicep' = {
  name: 'portal-deploy'
  scope: rg
  params: {
    name: '${baseName}-portal'
    location: location
    tags: tags
  }
}

// ── Outputs ───────────────────────────────────────────────────────────────
output resourceGroupName string = rg.name
output keyVaultUrl string = keyVault.outputs.vaultUri
output portalUrl string = portal.outputs.defaultHostName
output mcpServerUrl string = contains(enabledLabs, '04') ? mcpServer.outputs.fqdn : 'not-deployed'
