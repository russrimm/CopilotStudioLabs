@description('Globally unique lowercase alphanumeric Azure Storage account name (3-24 chars)')
@minLength(3)
@maxLength(24)
param name string

@description('Azure region')
param location string

@description('Resource tags')
param tags object = {}

@description('Azure Files share name for persistent portal state')
param fileShareName string = 'portalstate'

@description('Quota in GiB for the persistent portal state Azure Files share')
@minValue(1)
@maxValue(5120)
param shareQuota int = 5

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
    // Azure Container Apps Managed Environment SMB Azure Files storage links require Shared Key authentication.
    allowSharedKeyAccess: true
  }
}

resource fileServices 'Microsoft.Storage/storageAccounts/fileServices@2023-05-01' = {
  parent: storageAccount
  name: 'default'
}

resource portalStateShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = {
  parent: fileServices
  name: fileShareName
  properties: {
    shareQuota: shareQuota
    enabledProtocols: 'SMB'
  }
}

output storageAccountName string = storageAccount.name
output storageAccountId string = storageAccount.id
output fileShareName string = portalStateShare.name
