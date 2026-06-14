// ── Key Vault module for secret management ────────────────────────────────

@description('Key Vault name')
param name string

@description('Azure region')
param location string

@description('Resource tags')
param tags object = {}

@description('Principal ID to grant Key Vault Secrets Officer role (e.g., App Service managed identity)')
param secretsOfficerPrincipalId string = ''

@description('Enable RBAC authorization (recommended over access policies)')
param enableRbac bool = true

// ── Key Vault ─────────────────────────────────────────────────────────────
resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: subscription().tenantId
    enableRbacAuthorization: enableRbac
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    enablePurgeProtection: false
  }
}

// ── RBAC: Key Vault Secrets Officer for the app ───────────────────────────
// Role ID: b86a8fe4-44ce-4948-aee5-eccb2c155cd7
resource secretsOfficerRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (secretsOfficerPrincipalId != '') {
  name: guid(vault.id, secretsOfficerPrincipalId, 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7')
  scope: vault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7')
    principalId: secretsOfficerPrincipalId
    principalType: 'ServicePrincipal'
  }
}

output vaultUri string = vault.properties.vaultUri
output vaultName string = vault.name
output vaultId string = vault.id
