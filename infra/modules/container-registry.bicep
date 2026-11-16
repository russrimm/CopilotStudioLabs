@description('Globally unique alphanumeric Azure Container Registry name (5-50 chars)')
@minLength(5)
@maxLength(50)
param name string

@description('Azure region')
param location string

@description('Resource tags')
param tags object = {}

resource containerRegistry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: name
  location: location
  tags: tags
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: false
    publicNetworkAccess: 'Enabled'
  }
}

output id string = containerRegistry.id
output name string = containerRegistry.name
output loginServer string = containerRegistry.properties.loginServer
