targetScope = 'subscription'

@minLength(1)
@maxLength(64)
@description('Name of the azd environment used to group and tag deployed resources')
param environmentName string

@minLength(1)
@description('Primary Azure region for all resources')
param location string

@description('Optional override for the resource group name')
param resourceGroupName string = ''

@description('Disable bearer-token API gate for open demo/testing deployments')
param portalAuthDisabled bool = true

@allowed([
  'off'
  'per-user'
  'byok'
])
@description('AI writing mode (AI_GENERATION). Off by default. See docs/ai-writing.md before turning it on.')
param aiGeneration string = 'off'

@description('Comma-separated model ids to offer (AI_ALLOWED_MODELS); empty offers every model the SDK reports')
param aiAllowedModels string = ''

@description('Address people use to reach the portal (AI_PUBLIC_URL), for per-user GitHub sign-in')
param aiPublicUrl string = ''

@description('GitHub App client id (AI_GITHUB_CLIENT_ID) for per-user sign-in')
param aiGithubClientId string = ''

@secure()
@description('GitHub App client secret (AI_GITHUB_CLIENT_SECRET); stored as a Container Apps secret')
param aiGithubClientSecret string = ''

@allowed([
  'openai'
  'azure'
  'anthropic'
])
@description('Model provider type for byok (AI_BYOK_TYPE)')
param aiByokType string = 'openai'

@description('https address of the model provider for byok (AI_BYOK_BASE_URL)')
param aiByokBaseUrl string = ''

@description('Models offered for byok (AI_BYOK_MODELS), as id or id=Display name, comma-separated')
param aiByokModels string = ''

@secure()
@description('Model provider key for byok (AI_BYOK_API_KEY); stored as a Container Apps secret')
param aiByokApiKey string = ''

@description('Container image for initial provisioning before azd deploy pushes the built image')
param portalImageName string = ''

var abbrs = {
  resourceGroup: 'rg-'
  logAnalyticsWorkspace: 'log-'
  applicationInsights: 'appi-'
  containerRegistry: 'crcslabs'
  storageAccount: 'stcslabs'
  managedIdentity: 'id-'
  containerAppsEnvironment: 'cae-'
  containerApp: 'ca-portal-'
}

var resourceToken = toLower(uniqueString(subscription().id, environmentName, location))
var tags = {
  'azd-env-name': environmentName
  project: 'copilot-studio-labs-portal'
}

resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: !empty(resourceGroupName) ? resourceGroupName : '${abbrs.resourceGroup}${environmentName}'
  location: location
  tags: tags
}

module monitoring './modules/monitoring.bicep' = {
  name: 'monitoring'
  scope: rg
  params: {
    location: location
    tags: tags
    logAnalyticsName: '${abbrs.logAnalyticsWorkspace}${resourceToken}'
    applicationInsightsName: '${abbrs.applicationInsights}${resourceToken}'
  }
}

module containerRegistry './modules/container-registry.bicep' = {
  name: 'containerRegistry'
  scope: rg
  params: {
    name: replace('${abbrs.containerRegistry}${resourceToken}', '-', '')
    location: location
    tags: tags
  }
}

module portalIdentity './modules/identity.bicep' = {
  name: 'portalIdentity'
  scope: rg
  params: {
    name: '${abbrs.managedIdentity}${resourceToken}'
    location: location
    tags: tags
  }
}

module storage './modules/storage.bicep' = {
  name: 'storage'
  scope: rg
  params: {
    name: take('${abbrs.storageAccount}${replace(resourceToken, '-', '')}', 24)
    location: location
    tags: tags
    nspName: 'nsp-${resourceToken}'
    principalId: portalIdentity.outputs.principalId
  }
}

module acrPullUser './modules/acr-pull-role.bicep' = {
  name: 'acrPullUser'
  scope: rg
  params: {
    acrName: containerRegistry.outputs.name
    principalId: portalIdentity.outputs.principalId
    roleSeed: 'acrpull-user'
  }
}

// Phase 1: Provision Container Apps Environment and Portal Container App with ACR + Blob UserAssigned identity
module portal './modules/container-app.bicep' = {
  name: 'portal'
  scope: rg
  dependsOn: [
    acrPullUser
  ]
  params: {
    appName: '${abbrs.containerApp}${resourceToken}'
    environmentName: '${abbrs.containerAppsEnvironment}${resourceToken}'
    userIdentityId: portalIdentity.outputs.id
    userIdentityClientId: portalIdentity.outputs.clientId
    location: location
    tags: tags
    serviceName: 'portal'
    containerImageName: !empty(portalImageName)
      ? portalImageName
      : 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest'
    logAnalyticsWorkspaceName: monitoring.outputs.logAnalyticsWorkspaceName
    containerRegistryLoginServer: containerRegistry.outputs.loginServer
    applicationInsightsConnectionString: monitoring.outputs.applicationInsightsConnectionString
    portalAuthDisabled: portalAuthDisabled
    aiGeneration: aiGeneration
    aiAllowedModels: aiAllowedModels
    aiPublicUrl: aiPublicUrl
    aiGithubClientId: aiGithubClientId
    aiGithubClientSecret: aiGithubClientSecret
    aiByokType: aiByokType
    aiByokBaseUrl: aiByokBaseUrl
    aiByokModels: aiByokModels
    aiByokApiKey: aiByokApiKey
    azureSubscriptionId: subscription().subscriptionId
    azureTenantId: tenant().tenantId
    blobEndpoint: storage.outputs.blobEndpoint
    blobContainerName: storage.outputs.blobContainerName
  }
}

// Phase 2: Grant AcrPull and Storage Blob Data Contributor to SystemAssigned Managed Identity as well (no circular dependency)
module acrPullRole './modules/acr-pull-role.bicep' = {
  name: 'acrPullRole'
  scope: rg
  params: {
    acrName: containerRegistry.outputs.name
    principalId: portal.outputs.systemAssignedMIPrincipalId
    roleSeed: 'acrpull-system'
  }
}

module storageBlobRole './modules/storage-blob-role.bicep' = {
  name: 'storageBlobRole'
  scope: rg
  params: {
    storageAccountName: storage.outputs.storageAccountName
    principalId: portal.outputs.systemAssignedMIPrincipalId
    roleSeed: 'storage-blob-system'
  }
}

output AZURE_LOCATION string = location
output AZURE_TENANT_ID string = tenant().tenantId
output AZURE_RESOURCE_GROUP string = rg.name
output AZURE_CONTAINER_REGISTRY_NAME string = containerRegistry.outputs.name
output AZURE_CONTAINER_REGISTRY_ENDPOINT string = containerRegistry.outputs.loginServer
output AZURE_STORAGE_ACCOUNT_NAME string = storage.outputs.storageAccountName
output AZURE_CONTAINER_APPS_ENVIRONMENT_NAME string = portal.outputs.environmentName
output SERVICE_PORTAL_NAME string = portal.outputs.name
output SERVICE_PORTAL_URI string = portal.outputs.uri
