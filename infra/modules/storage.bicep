@description('Globally unique lowercase alphanumeric Azure Storage account name (3-24 chars)')
@minLength(3)
@maxLength(24)
param name string

@description('Azure region')
param location string

@description('Resource tags')
param tags object = {}

@description('Network Security Perimeter resource name securing the Storage account')
param nspName string

@description('User-Assigned Managed Identity principal ID granted Storage Blob Data Contributor')
param principalId string

@description('Azure Blob container name for persistent portal state')
param containerName string = 'portalstate'

var storageBlobDataContributorRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
)

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: name
  location: location
  tags: tags
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    supportsHttpsTrafficOnly: true
    allowSharedKeyAccess: false
    publicNetworkAccess: 'SecuredByPerimeter'
  }
}

resource blobServices 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storageAccount
  name: 'default'
}

resource portalStateContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobServices
  name: containerName
  properties: {
    publicAccess: 'None'
  }
}

resource networkSecurityPerimeter 'Microsoft.Network/networkSecurityPerimeters@2024-10-01' = {
  name: nspName
  location: location
  properties: {}
}

resource defaultProfile 'Microsoft.Network/networkSecurityPerimeters/profiles@2024-10-01' = {
  parent: networkSecurityPerimeter
  name: 'defaultProfile'
  properties: {}
}

resource allowSameSubscription 'Microsoft.Network/networkSecurityPerimeters/profiles/accessRules@2024-10-01' = {
  parent: defaultProfile
  name: 'allow-same-subscription'
  properties: {
    direction: 'Inbound'
    subscriptions: [
      {
        id: subscription().id
      }
    ]
  }
}

resource storageAssociation 'Microsoft.Network/networkSecurityPerimeters/resourceAssociations@2024-10-01' = {
  parent: networkSecurityPerimeter
  name: 'storage-assoc'
  properties: {
    accessMode: 'Learning'
    privateLinkResource: {
      id: storageAccount.id
    }
    profile: {
      id: defaultProfile.id
    }
  }
}

resource storageBlobRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storageAccount.id, principalId, 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
  scope: storageAccount
  properties: {
    roleDefinitionId: storageBlobDataContributorRoleDefinitionId
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}

output storageAccountName string = storageAccount.name
output storageAccountId string = storageAccount.id
output blobEndpoint string = storageAccount.properties.primaryEndpoints.blob
output blobContainerName string = portalStateContainer.name
