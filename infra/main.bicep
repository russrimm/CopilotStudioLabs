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
