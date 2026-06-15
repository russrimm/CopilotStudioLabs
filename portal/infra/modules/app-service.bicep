// ── App Service module for portal hosting ─────────────────────────────────

@description('App Service name')
param name string

@description('Azure region')
param location string

@description('Resource tags')
param tags object = {}

@description('App Service Plan SKU')
param skuName string = 'B1'

@description('Node.js version')
param nodeVersion string = '20-lts'

// ── App Service Plan ──────────────────────────────────────────────────────
resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: '${name}-plan'
  location: location
  tags: tags
  kind: 'linux'
  sku: {
    name: skuName
  }
  properties: {
    reserved: true
  }
}

// ── Web App ───────────────────────────────────────────────────────────────
resource app 'Microsoft.Web/sites@2023-12-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    serverFarmId: plan.id
    siteConfig: {
      linuxFxVersion: 'NODE|${nodeVersion}'
      appSettings: [
        { name: 'NODE_ENV', value: 'production' }
        { name: 'PORT', value: '3005' }
        { name: 'WEBSITE_NODE_DEFAULT_VERSION', value: '~20' }
      ]
      alwaysOn: skuName != 'F1'
    }
    httpsOnly: true
  }
}

output defaultHostName string = app.properties.defaultHostName
output appId string = app.id
output planId string = plan.id
